[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$Model = $(if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "" }),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$PausePrompt = "Pause and wait for the next instruction. Do not finish yet."
$startedAt = [DateTime]::UtcNow

function Invoke-AntiCodexHealth {
    return Invoke-RestMethod -Uri "$BaseUrl/health" -Proxy $null -TimeoutSec 8
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Resolve-AntiCodexMode {
    param($Health)
    if ((Has-Property $Health "upstreamProfile") -and $Health.upstreamProfile -and (Has-Property $Health.upstreamProfile "mode")) {
        return [string]$Health.upstreamProfile.mode
    }
    if (Has-Property $Health "mode") { return [string]$Health.mode }
    if ($Health.upstream -eq "antigravity-desktop") { return "antigravity" }
    return "unknown"
}

function Resolve-AntiCodexTestModel {
    param($Health, [string]$RequestedModel)
    if ($RequestedModel) { return $RequestedModel }
    if ((Has-Property $Health "upstreamProfile") -and $Health.upstreamProfile -and (Has-Property $Health.upstreamProfile "model") -and $Health.upstreamProfile.model) {
        return [string]$Health.upstreamProfile.model
    }
    if ((Has-Property $Health "model") -and $Health.model) { return [string]$Health.model }
    return "gemini-3.5-flash-low"
}

function Test-AntiCodexReadyForCancellation {
    param($Health, [string]$Mode)
    if ($Mode -eq "third-party") {
        $profile = if ((Has-Property $Health "upstreamProfile") -and $Health.upstreamProfile) { $Health.upstreamProfile } else { $null }
        return [bool]($Health.ok -eq $true -and $profile -and $profile.protocol -and $profile.model)
    }
    return [bool]$Health.accountReady
}

function New-MessageInput {
    param([string]$Text)
    return ,[object[]]@(
        @{
            type = "message"
            role = "user"
            content = @(
                @{
                    type = "input_text"
                    text = $Text
                }
            )
        }
    )
}

function New-ReportPaths {
    param([string]$Name)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    return [pscustomobject]@{
        latest = (Join-Path $ReportRoot "latest-$Name.json")
        history = (Join-Path $ReportRoot "$stamp-$Name.json")
    }
}

function Save-JsonReport {
    param($Paths, $Payload, [int]$Depth = 12)
    $json = $Payload | ConvertTo-Json -Depth $Depth -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $Paths.latest -HistoryPath $Paths.history -Json $json -Encoding $utf8NoBom
}

$failures = New-Object System.Collections.Generic.List[string]

$preHealth = Invoke-AntiCodexHealth
$upstreamMode = Resolve-AntiCodexMode $preHealth
$providerReady = Test-AntiCodexReadyForCancellation $preHealth $upstreamMode
$Model = Resolve-AntiCodexTestModel $preHealth $Model
if (-not $providerReady) {
    $failures.Add("Pre-cancellation health check failed: providerReady false for mode $upstreamMode")
}

$request = [System.Net.WebRequest]::Create("$BaseUrl/v1/responses")
$request.Method = "POST"
$request.Proxy = $null
$request.Timeout = $TimeoutSec * 1000
$request.ReadWriteTimeout = $TimeoutSec * 1000
$request.ContentType = "application/json; charset=utf-8"

$body = @{
    model = $Model
    stream = $true
    input = New-MessageInput $PausePrompt
}
$json = $body | ConvertTo-Json -Depth 30 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$request.ContentLength = $bytes.Length

$requestStream = $request.GetRequestStream()
try {
    $requestStream.Write($bytes, 0, $bytes.Length)
} finally {
    $requestStream.Dispose()
}

$response = $null
$reader = $null
$responseId = $null
$cancelResult = $null
$events = New-Object System.Collections.Generic.List[object]

try {
    $response = $request.GetResponse()
    $reader = [IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8)
    $eventName = ""
    $dataLines = New-Object System.Collections.Generic.List[string]
    $cancelSent = $false

    function Add-SseEvent {
        if ($dataLines.Count -le 0) { return }
        $data = ($dataLines.ToArray() -join "`n")
        $parsed = $null
        try { $parsed = $data | ConvertFrom-Json } catch {}
        $events.Add([pscustomobject]@{ event = $eventName; data = $parsed }) | Out-Null
        $dataLines.Clear()
    }

    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line -eq "") {
            Add-SseEvent
            $lastIdx = $events.Count - 1
            if ($lastIdx -ge 0 -and -not $cancelSent) {
                $evt = $events[$lastIdx]
                if ($evt.event -eq "response.created" -and $evt.data -and $evt.data.response -and $evt.data.response.id) {
                    $responseId = [string]$evt.data.response.id
                    $cancelSent = $true
                    try {
                        $cancelResult = Invoke-RestMethod -Uri "$BaseUrl/v1/responses/$responseId/cancel" -Method Post -Body "{}" -ContentType "application/json" -Proxy $null -TimeoutSec 10
                    } catch {
                        $cancelResult = [pscustomobject]@{ error = $_.Exception.Message }
                        $failures.Add("Cancel API request failed: $($_.Exception.Message)")
                    }
                }
            }
            $eventName = ""
            continue
        }
        if ($line.StartsWith("event: ")) {
            $eventName = $line.Substring(7)
        } elseif ($line.StartsWith("data: ")) {
            $dataLines.Add($line.Substring(6)) | Out-Null
        }
    }
    Add-SseEvent
} finally {
    if ($reader) { $reader.Dispose() }
    if ($response) { $response.Dispose() }
}

if (-not $responseId) {
    $failures.Add("Did not receive a response ID from response.created event")
}

if ($cancelResult -and -not $cancelResult.error) {
    if ($cancelResult.status -ne "cancelled") {
        $failures.Add("Cancel API returned status '$($cancelResult.status)' instead of 'cancelled'")
    }
    if ([string]$cancelResult.id -ne $responseId) {
        $failures.Add("Cancel API response ID did not match response.created")
    }
} elseif (-not $cancelResult) {
    $failures.Add("No cancel response was received")
}

$eventNames = @($events | ForEach-Object { $_.event })
$hasCancelled = $eventNames -contains "response.cancelled"
$hasCompleted = $eventNames -contains "response.completed"
$hasFailed = $eventNames -contains "response.failed"
$cancelledEvent = @($events | Where-Object { $_.event -eq "response.cancelled" }) | Select-Object -Last 1

if (-not $hasCancelled) {
    $failures.Add("SSE stream did not contain response.cancelled event")
}
if ($hasCompleted) {
    $failures.Add("SSE stream contained response.completed event when it should have been cancelled")
}
if ($hasFailed) {
    $failures.Add("SSE stream contained response.failed event when it should have been cancelled")
}
if ($cancelledEvent -and [string]$cancelledEvent.data.response.id -ne $responseId) {
    $failures.Add("response.cancelled ID did not match response.created")
}
if ($cancelledEvent -and [string]$cancelledEvent.data.response.status -ne "cancelled") {
    $failures.Add("response.cancelled event did not contain cancelled status")
}

$postHealth = Invoke-AntiCodexHealth
$postProviderReady = Test-AntiCodexReadyForCancellation $postHealth $upstreamMode
if (-not $postProviderReady) {
    $failures.Add("Post-cancellation health check failed: providerReady false for mode $upstreamMode")
}

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    reportName = "cancellation"
    requestedRealTraffic = $true
    usedRealTraffic = $true
    behaviorCovered = ($failures.Count -eq 0)
    coverageKind = "real-traffic"
    model = $Model
    mode = $upstreamMode
    responseId = $responseId
    cancelStatus = if ($cancelResult -and -not $cancelResult.error) { $cancelResult.status } else { $null }
    cancelError = if ($cancelResult -and $cancelResult.error) { $cancelResult.error } else { $null }
    hasCancelled = $hasCancelled
    hasCompleted = $hasCompleted
    hasFailed = $hasFailed
    eventNames = $eventNames
    providerReady = [bool]$providerReady
    preHealthReady = [bool]$providerReady
    postHealthReady = [bool]$postProviderReady
    accountReady = [bool]$preHealth.accountReady
    eventCount = $events.Count
    elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    failures = $failures.ToArray()
}

$reportPaths = New-ReportPaths "cancellation"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
Save-JsonReport $reportPaths $result
$result | ConvertTo-Json -Depth 10 -Compress
if (-not $result.ok) { exit 1 }


