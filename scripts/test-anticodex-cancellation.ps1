[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$Model = $(if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "" }),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 90,
    [int]$AttachTimeoutSec = 25,
    [int]$SettleTimeoutSec = 25,
    [int]$StableZeroMs = 3000
)

$ErrorActionPreference = "Stop"

if ([System.Net.ServicePointManager]::DefaultConnectionLimit -lt 16) {
    [System.Net.ServicePointManager]::DefaultConnectionLimit = 16
}

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$PausePrompt = "Pause and wait for the next instruction. Do not finish yet."
$startedAt = [DateTime]::UtcNow

function Invoke-AntiCodexHealth {
    return Invoke-RestMethod -Uri "$BaseUrl/health" -Proxy $null -TimeoutSec 8
}

function Invoke-AntiCodexDiagnostics {
    return Invoke-RestMethod -Uri "$BaseUrl/anticodex/diagnostics?fast=1" -Proxy $null -TimeoutSec 8
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

function Invoke-AntiCodexCancelResponse {
    param([string]$Uri)

    $cancelRequest = [System.Net.WebRequest]::Create($Uri)
    $cancelRequest.Method = "POST"
    $cancelRequest.Proxy = $null
    $cancelRequest.Timeout = 15000
    $cancelRequest.ReadWriteTimeout = 15000
    $cancelRequest.ContentType = "application/json; charset=utf-8"
    if ($cancelRequest -is [System.Net.HttpWebRequest]) {
        $cancelRequest.KeepAlive = $false
    }

    $cancelBytes = [Text.Encoding]::UTF8.GetBytes("{}")
    $cancelRequest.ContentLength = $cancelBytes.Length
    $cancelStream = $cancelRequest.GetRequestStream()
    try {
        $cancelStream.Write($cancelBytes, 0, $cancelBytes.Length)
    } finally {
        $cancelStream.Dispose()
    }

    $cancelResponse = $null
    $cancelReader = $null
    try {
        $cancelResponse = $cancelRequest.GetResponse()
        $cancelReader = [IO.StreamReader]::new($cancelResponse.GetResponseStream(), [Text.Encoding]::UTF8)
        $cancelText = $cancelReader.ReadToEnd()
        if (-not $cancelText) { return $null }
        return $cancelText | ConvertFrom-Json
    } finally {
        if ($cancelReader) { $cancelReader.Dispose() }
        if ($cancelResponse) { $cancelResponse.Dispose() }
    }
}

function Wait-AntiCodexCascadeAttached {
    param([string]$ResponseId, [int]$WaitSec = 25)
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $WaitSec))
    $last = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $diagnostics = Invoke-AntiCodexDiagnostics
            $entries = @($diagnostics.activeAntigravityRequests.entries)
            $entry = @($entries | Where-Object { [string]$_.responseId -eq $ResponseId }) | Select-Object -First 1
            $last = [pscustomobject]@{
                active = [int]$diagnostics.activeAntigravityRequests.active
                cascadeAttached = [int]$diagnostics.activeAntigravityRequests.cascadeAttached
                cascadePending = [int]$diagnostics.activeAntigravityRequests.cascadePending
                responseFound = [bool]$entry
                responseCascadeAttached = [bool]($entry -and $entry.cascadeAttached)
                cascadeId = if ($entry) { [string]$entry.cascadeId } else { "" }
            }
            if ($last.responseCascadeAttached) {
                return [pscustomobject]@{ attached = $true; observation = $last }
            }
        } catch {
            $last = [pscustomobject]@{ error = $_.Exception.Message }
        }
        Start-Sleep -Milliseconds 100
    }
    return [pscustomobject]@{ attached = $false; observation = $last }
}

function Wait-AntiCodexCancellationSettled {
    param([string]$ResponseId, [int]$WaitSec = 25, [int]$RequiredStableMs = 3000)
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $WaitSec))
    $stableSince = $null
    $last = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $diagnostics = Invoke-AntiCodexDiagnostics
            $activeEntries = @($diagnostics.activeAntigravityRequests.entries)
            $responseStillActive = @($activeEntries | Where-Object { [string]$_.responseId -eq $ResponseId }).Count -gt 0
            $nativeSessionIds = @($diagnostics.toolBridge.nativeSessions.responseSessionIds | ForEach-Object { [string]$_ })
            $responseSessionRetained = $nativeSessionIds -contains $ResponseId
            $lockResponseIds = @($diagnostics.antigravitySessionLock.activeResponseIds | ForEach-Object { [string]$_ })
            $responseLocked = $lockResponseIds -contains $ResponseId
            $activeCount = [int]$diagnostics.activeAntigravityRequests.active
            $queueRunning = [bool]$diagnostics.antigravityQueue.running
            $queueCount = [int]$diagnostics.antigravityQueue.queued
            $busyCount = [int]$diagnostics.antigravityBusy.active
            $globalZero = $activeCount -eq 0 -and -not $queueRunning -and $queueCount -eq 0 -and $busyCount -eq 0
            $responseClear = -not $responseStillActive -and -not $responseSessionRetained -and -not $responseLocked
            $last = [pscustomobject]@{
                responseClear = $responseClear
                globalZero = $globalZero
                active = $activeCount
                cascadeAttached = [int]$diagnostics.activeAntigravityRequests.cascadeAttached
                queueRunning = $queueRunning
                queued = $queueCount
                busy = $busyCount
                responseSessionRetained = $responseSessionRetained
                responseLocked = $responseLocked
            }
            if ($responseClear -and $globalZero) {
                if (-not $stableSince) { $stableSince = [DateTime]::UtcNow }
                $stableZeroMs = [int]([DateTime]::UtcNow - $stableSince).TotalMilliseconds
                if ($stableZeroMs -ge $RequiredStableMs) {
                    return [pscustomobject]@{ settled = $true; stableZeroMs = $stableZeroMs; observation = $last }
                }
            } else {
                $stableSince = $null
            }
        } catch {
            $stableSince = $null
            $last = [pscustomobject]@{ error = $_.Exception.Message }
        }
        Start-Sleep -Milliseconds 200
    }
    $observedStableMs = if ($stableSince) { [int]([DateTime]::UtcNow - $stableSince).TotalMilliseconds } else { 0 }
    return [pscustomobject]@{ settled = $false; stableZeroMs = $observedStableMs; observation = $last }
}

function Invoke-AntiCodexDelayedRetry {
    param([string]$ResponseId, [string]$RequestedModel)
    $retryBody = @{
        model = $RequestedModel
        stream = $false
        previous_response_id = $ResponseId
        input = New-MessageInput "This delayed retry must not restart the cancelled task."
    } | ConvertTo-Json -Depth 30 -Compress
    $retryRequest = [System.Net.WebRequest]::Create("$BaseUrl/v1/responses")
    $retryRequest.Method = "POST"
    $retryRequest.Proxy = $null
    $retryRequest.Timeout = 15000
    $retryRequest.ReadWriteTimeout = 15000
    $retryRequest.ContentType = "application/json; charset=utf-8"
    if ($retryRequest -is [System.Net.HttpWebRequest]) { $retryRequest.KeepAlive = $false }
    $retryBytes = [Text.Encoding]::UTF8.GetBytes($retryBody)
    $retryRequest.ContentLength = $retryBytes.Length
    $retryStream = $retryRequest.GetRequestStream()
    try { $retryStream.Write($retryBytes, 0, $retryBytes.Length) } finally { $retryStream.Dispose() }

    $retryResponse = $null
    $retryReader = $null
    try {
        try {
            $retryResponse = $retryRequest.GetResponse()
        } catch [System.Net.WebException] {
            $retryResponse = $_.Exception.Response
            if (-not $retryResponse) { throw }
        }
        $retryReader = [IO.StreamReader]::new($retryResponse.GetResponseStream(), [Text.Encoding]::UTF8)
        $retryText = $retryReader.ReadToEnd()
        $retryJson = if ($retryText) { $retryText | ConvertFrom-Json } else { $null }
        return [pscustomobject]@{
            status = [int]$retryResponse.StatusCode
            type = if ($retryJson -and $retryJson.error) { [string]$retryJson.error.type } else { "" }
            payload = $retryJson
        }
    } finally {
        if ($retryReader) { $retryReader.Dispose() }
        if ($retryResponse) { $retryResponse.Dispose() }
    }
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
if ($request -is [System.Net.HttpWebRequest]) {
    $request.KeepAlive = $false
}

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
$cascadeObservation = $null
$settleObservation = $null
$delayedRetry = $null
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
                    $cascadeObservation = Wait-AntiCodexCascadeAttached -ResponseId $responseId -WaitSec $AttachTimeoutSec
                    if (-not $cascadeObservation.attached) {
                        $failures.Add("The real Antigravity Cascade was not observed before cancellation")
                    }
                    $cancelSent = $true
                    try {
                        $cancelResult = Invoke-AntiCodexCancelResponse -Uri "$BaseUrl/v1/responses/$responseId/cancel"
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

if ($responseId) {
    $settleObservation = Wait-AntiCodexCancellationSettled -ResponseId $responseId -WaitSec $SettleTimeoutSec -RequiredStableMs $StableZeroMs
    if (-not $settleObservation.settled) {
        $failures.Add("Cancellation did not remain fully settled for $StableZeroMs ms")
    }
    try {
        $delayedRetry = Invoke-AntiCodexDelayedRetry -ResponseId $responseId -RequestedModel $Model
        if ($delayedRetry.status -ne 409 -or $delayedRetry.type -ne "anticodex_session_reset") {
            $failures.Add("A delayed retry restarted or bypassed the cancelled response instead of returning anticodex_session_reset")
        }
    } catch {
        $failures.Add("Delayed retry probe failed: $($_.Exception.Message)")
    }
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
    cascadeStarted = [bool]($cascadeObservation -and $cascadeObservation.attached)
    cascadeId = if ($cascadeObservation -and $cascadeObservation.observation) { [string]$cascadeObservation.observation.cascadeId } else { "" }
    cancellationSettled = [bool]($settleObservation -and $settleObservation.settled)
    stableZeroMs = if ($settleObservation) { [int]$settleObservation.stableZeroMs } else { 0 }
    settleObservation = if ($settleObservation) { $settleObservation.observation } else { $null }
    delayedRetryBlocked = [bool]($delayedRetry -and $delayedRetry.status -eq 409 -and $delayedRetry.type -eq "anticodex_session_reset")
    delayedRetryStatus = if ($delayedRetry) { [int]$delayedRetry.status } else { $null }
    delayedRetryType = if ($delayedRetry) { [string]$delayedRetry.type } else { "" }
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


