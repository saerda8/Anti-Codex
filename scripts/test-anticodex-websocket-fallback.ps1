[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [int]$TimeoutSec = 8
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Get-StatusLine {
    param([string]$Response)
    if (-not $Response) { return $null }
    return ($Response -split "`r?`n", 2)[0]
}

function Invoke-WebSocketUpgradeProbe {
    param([string]$Url)

    $uri = [Uri]$Url
    $client = New-Object System.Net.Sockets.TcpClient
    $client.ReceiveTimeout = [Math]::Max(1, $TimeoutSec) * 1000
    $client.SendTimeout = [Math]::Max(1, $TimeoutSec) * 1000
    try {
        $client.Connect($uri.Host, $uri.Port)
        $stream = $client.GetStream()
        $path = if ($uri.PathAndQuery) { $uri.PathAndQuery } else { "/" }
        $request = @(
            "GET $path HTTP/1.1",
            "Host: $($uri.Host):$($uri.Port)",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Protocol: codex.responses.v1",
            "",
            ""
        ) -join "`r`n"
        $bytes = [Text.Encoding]::ASCII.GetBytes($request)
        $stream.Write($bytes, 0, $bytes.Length)

        $buffer = New-Object byte[] 8192
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { return "" }
        return [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
    } finally {
        try { $client.Close() } catch {}
    }
}

function Invoke-LocalJson {
    param([string]$Path)
    return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $TimeoutSec
}

$probePaths = @("/v1/responses", "/codex/responses")
$probeResults = New-Object System.Collections.Generic.List[object]
$response = ""
$diagnostics = $null

try {
    foreach ($probePath in $probePaths) {
        $probeUrl = "$($BaseUrl.TrimEnd('/'))$probePath"
        $response = Invoke-WebSocketUpgradeProbe $probeUrl
        $statusLine = Get-StatusLine $response
        $containsUnsupportedWebsocket = ($response -match "unsupported_websocket")

        $probeResults.Add([pscustomobject]@{
            path = $probePath
            url = $probeUrl
            statusLine = $statusLine
            containsUnsupportedWebsocket = $containsUnsupportedWebsocket
        }) | Out-Null

        if (-not $response) {
            Add-Failure "websocket upgrade for $probePath returned an empty response"
        } elseif ($response -notmatch "^HTTP/1\.1 501\b") {
            Add-Failure "websocket upgrade for $probePath returned unexpected status: $statusLine"
        }
        if ($response -match "^HTTP/1\.1 101\b") {
            Add-Failure "websocket upgrade for $probePath unexpectedly succeeded"
        }
        if (-not $containsUnsupportedWebsocket) {
            Add-Failure "websocket fallback body for $probePath does not contain unsupported_websocket"
        }
    }

    try {
        $diagnostics = Invoke-LocalJson "/anticodex/diagnostics"
        $ws = $diagnostics.responsesWebSocket
        if (-not $ws) {
            Add-Failure "diagnostics missing responsesWebSocket audit"
        } else {
            if ($ws.supported -ne $false) { Add-Failure "diagnostics should report responses websocket unsupported" }
            if ($ws.fallbackStatus -ne 501) { Add-Failure "diagnostics fallbackStatus is $($ws.fallbackStatus), expected 501" }
            if ($ws.fallbackType -ne "unsupported_websocket") { Add-Failure "diagnostics fallbackType is $($ws.fallbackType)" }
            if (-not $ws.lastUpgrade) {
                Add-Failure "diagnostics missing last websocket upgrade attempt"
            } else {
                if ($ws.lastUpgrade.path -ne "/codex/responses") { Add-Failure "diagnostics lastUpgrade path is $($ws.lastUpgrade.path)" }
                if ($ws.lastUpgrade.status -ne 501) { Add-Failure "diagnostics lastUpgrade status is $($ws.lastUpgrade.status)" }
                if ($ws.lastUpgrade.responseType -ne "unsupported_websocket") { Add-Failure "diagnostics lastUpgrade responseType is $($ws.lastUpgrade.responseType)" }
                if ($ws.lastUpgrade.kind -ne "upgrade") { Add-Failure "diagnostics lastUpgrade kind is $($ws.lastUpgrade.kind)" }
                if ($ws.lastUpgrade.secWebSocketProtocol -ne "codex.responses.v1") {
                    Add-Failure "diagnostics lastUpgrade secWebSocketProtocol is $($ws.lastUpgrade.secWebSocketProtocol)"
                }
            }
        }
    } catch {
        Add-Failure "websocket diagnostics audit failed: $($_.Exception.Message)"
    }
} catch {
    Add-Failure "websocket upgrade probe failed: $($_.Exception.Message)"
}

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    probeUrls = @($probeResults | ForEach-Object { $_.url })
    probeResults = $probeResults.ToArray()
    statusLine = Get-StatusLine $response
    containsUnsupportedWebsocket = ($response -match "unsupported_websocket")
    diagnostics = if ($diagnostics) { $diagnostics.responsesWebSocket } else { $null }
}

$result | ConvertTo-Json -Depth 6 -Compress
if ($failures.Count -gt 0) { exit 1 }
