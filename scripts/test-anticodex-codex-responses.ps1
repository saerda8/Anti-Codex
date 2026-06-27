[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [int]$TimeoutSec = 90,
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports")
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}
$failures = New-Object System.Collections.Generic.List[string]
$startedAt = [DateTime]::UtcNow
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Save-Report {
    param($Payload)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $json = $Payload | ConvertTo-Json -Depth 16 -Compress
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath (Join-Path $ReportRoot "latest-codex-responses.json") -HistoryPath (Join-Path $ReportRoot "$stamp-codex-responses.json") -Json $json -Encoding $utf8NoBom
}

function Invoke-LocalJson {
    param([string]$Path)
    return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $TimeoutSec
}

function Invoke-LocalPostText {
    param([string]$Path, [string]$Body)
    $request = [System.Net.WebRequest]::Create("$BaseUrl$Path")
    $request.Method = "POST"
    $request.Proxy = $null
    $request.Timeout = $TimeoutSec * 1000
    $request.ContentType = "application/json; charset=utf-8"
    $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
    $request.ContentLength = $bytes.Length
    $requestStream = $request.GetRequestStream()
    try {
        $requestStream.Write($bytes, 0, $bytes.Length)
    } finally {
        $requestStream.Dispose()
    }
    $response = $request.GetResponse()
    try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
        try {
            return $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
    } finally {
        $response.Dispose()
    }
}

function Read-SseEvents {
    param([string]$Text)
    $events = New-Object System.Collections.Generic.List[object]
    $blocks = $Text -split "(`r?`n){2,}"
    foreach ($block in $blocks) {
        if (-not $block.Trim()) { continue }
        $name = ""
        $dataLines = New-Object System.Collections.Generic.List[string]
        foreach ($line in ($block -split "`r?`n")) {
            if ($line.StartsWith("event:")) {
                $name = $line.Substring(6).Trim()
            } elseif ($line.StartsWith("data:")) {
                $dataLines.Add($line.Substring(5).TrimStart()) | Out-Null
            }
        }
        if ($dataLines.Count -gt 0) {
            $json = ($dataLines -join "`n")
            try {
                $data = $json | ConvertFrom-Json
            } catch {
                $data = $json
            }
            $events.Add([pscustomobject]@{ event = $name; data = $data }) | Out-Null
        }
    }
    return $events.ToArray()
}

$health = $null
$models = $null
$model = ""
$marker = "CODEX_RESPONSES_$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
$responseText = ""
$events = @()
$completed = $null
$route = $null
$finalText = ""

try {
    $health = Invoke-LocalJson "/health"
    if ($health.ok -ne $true) { Add-Failure "health ok=false" }
    if ($health.accountReady -ne $true) { Add-Failure "Antigravity account is not ready" }
} catch {
    Add-Failure "health request failed: $($_.Exception.Message)"
}

try {
    $models = Invoke-LocalJson "/models"
    $model = [string](@($models.data)[0].id)
    if (-not $model) { Add-Failure "No model available from /models" }
} catch {
    Add-Failure "models request failed: $($_.Exception.Message)"
}

if ($model) {
    $body = [ordered]@{
        model = $model
        input = @(
            [ordered]@{
                type = "message"
                role = "user"
                content = @(
                    [ordered]@{
                        type = "input_text"
                        text = "请用中文简短确认已收到请求，并且必须包含这个标记：$marker"
                    }
                )
            }
        )
        tools = @()
        tool_choice = "none"
        parallel_tool_calls = $false
        stream = $true
        store = $false
    }
    try {
        $json = $body | ConvertTo-Json -Depth 16 -Compress
        $responseText = Invoke-LocalPostText "/codex/responses" $json
        $events = @(Read-SseEvents $responseText)
        $completed = @($events | Where-Object { $_.event -eq "response.completed" }) | Select-Object -Last 1
        if (-not $completed) {
            Add-Failure "/codex/responses SSE did not emit response.completed"
        } else {
            $output = @($completed.data.response.output)
            $textParts = @($output | ForEach-Object { @($_.content) } | ForEach-Object { $_.text }) | Where-Object { $_ }
            $finalText = ($textParts -join "`n")
            if ($finalText -notmatch [regex]::Escape($marker)) {
                Add-Failure "/codex/responses final text did not contain marker"
            }
            if ($finalText -notmatch "[\u4e00-\u9fff]") {
                Add-Failure "/codex/responses did not answer a Chinese request in Chinese"
            }
            if ($finalText -match "DeepCodex") {
                Add-Failure "/codex/responses leaked the legacy DeepCodex brand"
            }
        }
        if (-not (@($events | Where-Object { $_.event -eq "response.created" }).Count -gt 0)) {
            Add-Failure "/codex/responses SSE did not emit response.created"
        }
        if ($responseText -match "<tool_calls>|</tool_calls>|custom_tool_call_output|function_call_output") {
            Add-Failure "/codex/responses leaked tool protocol markup"
        }
    } catch {
        Add-Failure "/codex/responses request failed: $($_.Exception.Message)"
    }

    try {
        $routes = Invoke-LocalJson "/anticodex/model-routes"
        $route = $routes.latest
        if (-not $route) {
            Add-Failure "model route audit missing latest route after /codex/responses"
        } elseif ([string]$route.requestedModel -ne $model -or [string]$route.resolvedModel -ne $model) {
            Add-Failure "/codex/responses model route mismatch: requested=$($route.requestedModel) resolved=$($route.resolvedModel) expected=$model"
        }
    } catch {
        Add-Failure "model route audit failed: $($_.Exception.Message)"
    }
}

$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    reportName = "codex-responses"
    requestedRealTraffic = $true
    usedRealTraffic = $true
    behaviorCovered = ($failures.Count -eq 0)
    coverageKind = "real-traffic"
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    model = $model
    marker = $marker
    eventCount = @($events).Count
    eventNames = @($events | ForEach-Object { $_.event })
    completed = ($null -ne $completed)
    final_text = $finalText
    route = $route
    report = [pscustomobject]@{
        latest = (Join-Path $ReportRoot "latest-codex-responses.json")
        history = (Join-Path $ReportRoot "$stamp-codex-responses.json")
    }
}

Save-Report $result
Write-Output ($result | ConvertTo-Json -Depth 12 -Compress)
if ($failures.Count -gt 0) { exit 1 }


