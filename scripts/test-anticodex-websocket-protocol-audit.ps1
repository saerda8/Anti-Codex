[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex")
)

$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

$asarPath = Join-Path $InstallRoot "codex-patched-app\resources\app.asar"
$auditScript = Join-Path $PSScriptRoot "audit-codex-websocket-protocol.mjs"
$audit = $null

try {
    if (-not (Test-Path -LiteralPath $asarPath -PathType Leaf)) {
        throw "installed app.asar is missing: $asarPath"
    }
    if (-not (Test-Path -LiteralPath $auditScript -PathType Leaf)) {
        throw "audit script is missing: $auditScript"
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $raw = & $node $auditScript $asarPath
    if ($LASTEXITCODE -ne 0) {
        throw "audit script failed with exit code $LASTEXITCODE"
    }
    $audit = ($raw -join "`n") | ConvertFrom-Json
    $summary = $audit.summary
    if (-not $summary.hasResponsesWebsocketFlags) {
        Add-Failure "Codex host no longer exposes responses_websockets feature gates"
    }
    if (-not $summary.hasAppServerWebsocketUrl) {
        Add-Failure "Codex host app-server websocket marker is missing"
    }
    if (-not $summary.hasCodexResponsesHttpEndpointLiteral) {
        Add-Failure "Codex host /codex/responses HTTP stream marker is missing"
    }
    if ($summary.hasServerAdvertisedResponsesWebsocketFields -ne $false) {
        Add-Failure "Codex host now has server-advertised Responses websocket fields; update Anti-Codex websocket implementation plan"
    }
    if ($summary.hasV1ResponsesEndpointLiteral -ne $false) {
        Add-Failure "Codex host now has /v1/responses literal inside app.asar; update websocket audit expectations"
    }
    if ($summary.nativeModelResponsesWebsocketEvidence -ne $false) {
        Add-Failure "Codex host appears to contain native model Responses websocket evidence; do not keep fallback-only assumptions"
    }
    if (@($summary.filesWithDictationWebsocket).Count -lt 1) {
        Add-Failure "Dictation websocket marker missing; audit may be scanning the wrong host package"
    }
} catch {
    Add-Failure "websocket protocol audit failed: $($_.Exception.Message)"
}

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    installRoot = $InstallRoot
    asarPath = $asarPath
    summary = if ($audit) { $audit.summary } else { $null }
}

$result | ConvertTo-Json -Depth 8 -Compress
if ($failures.Count -gt 0) { exit 1 }
