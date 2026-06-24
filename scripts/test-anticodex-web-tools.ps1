[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}
$failures = New-Object System.Collections.Generic.List[string]
$startedAt = [DateTime]::UtcNow
$model = if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "gemini-3.5-flash-low" }

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Get-ResponseText {
    param($Response)
    $parts = foreach ($item in @($Response.output)) {
        if ($item.type -ne "message") { continue }
        foreach ($content in @($item.content)) {
            if ($content.type -eq "output_text" -and $content.text) { [string]$content.text }
        }
    }
    return ($parts -join "`n").Trim()
}

try {
    $body = @{
        model = $model
        stream = $false
        store = $false
        input = @(
            @{
                type = "message"
                role = "user"
                content = @(
                    @{
                        type = "input_text"
                        text = "Call web_fetch exactly once for https://example.com. Output only the required XML-like tool request and no prose before the tool result. After the tool result arrives, answer with one short sentence quoting a distinctive phrase from the fetched page."
                    }
                )
            }
        )
    } | ConvertTo-Json -Depth 10 -Compress

    $response = Invoke-RestMethod `
        -Uri "$BaseUrl/v1/responses" `
        -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($body)) `
        -TimeoutSec $TimeoutSec `
        -Proxy $null

    $text = Get-ResponseText $response
    if (-not $text) {
        Add-Failure "Web tool response did not contain assistant text."
    }
    if ($text -notmatch "(?i)Example Domain|documentation examples|Avoid use in operations") {
        Add-Failure "Web tool response did not contain evidence from example.com."
    }
    if ($text -match "<tool_calls>|<invoke|web_fetch.+\{") {
        Add-Failure "Web tool response leaked internal tool protocol markup."
    }

    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        reportName = "web-tools"
        requestedRealTraffic = $true
        usedRealTraffic = $true
        behaviorCovered = ($failures.Count -eq 0)
        coverageKind = "real-traffic"
        failures = $failures.ToArray()
        model = $model
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
        finalText = $text
        report = [pscustomobject]@{
            latest = (Join-Path $ReportRoot "latest-web-tools.json")
            history = (Join-Path $ReportRoot "$stamp-web-tools.json")
        }
    }
    $json = $result | ConvertTo-Json -Depth 10 -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $result.report.latest -HistoryPath $result.report.history -Json $json -Encoding $utf8NoBom
    $json
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Write-Error ("Anti-Codex web tools verification failed: " + $_.Exception.Message)
    exit 1
}


