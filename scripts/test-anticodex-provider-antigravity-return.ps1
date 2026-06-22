[CmdletBinding()]
param(
    [string]$RuntimeRoot = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [string]$AntigravityModel = $(if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "gemini-3.5-flash-low" }),
    [int]$TimeoutSec = 120,
    [switch]$AllowRealTraffic
)

$ErrorActionPreference = "Stop"
if (-not $RuntimeRoot) {
    $RuntimeRoot = Split-Path -Parent $PSScriptRoot
}
. (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
Import-Module (Join-Path $PSScriptRoot "anticodex-real-traffic-lock.psm1") -Force

$startedAt = [DateTime]::UtcNow
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$latestPath = Join-Path $ReportRoot "latest-provider-antigravity-return.json"
$historyPath = Join-Path $ReportRoot "$stamp-provider-antigravity-return.json"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Write-SkipReport {
    param([string]$Reason, [bool]$Busy = $false, [bool]$RequestedRealTraffic = $false, [bool]$Ok = $true)
    $failures = if ($Ok) { [string[]]@() } else { [string[]]@($Reason) }
    $payload = [ordered]@{
        ok = $Ok
        skipped = $true
        busy = $Busy
        requestedRealTraffic = $RequestedRealTraffic
        reason = $Reason
        failures = @($failures)
        behaviorCovered = $false
        coverageKind = "skipped"
        usedRealTraffic = $false
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    }
    $json = $payload | ConvertTo-Json -Depth 8 -Compress
    Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json -Encoding $utf8NoBom
    Write-Output $json
}

if (-not $AllowRealTraffic) {
    Write-SkipReport "provider-to-Antigravity turn 10 verification is opt-in; rerun with -AllowRealTraffic"
    exit 0
}

$lock = Enter-AntiCodexRealTrafficLock -WaitSeconds 0
if (-not $lock.acquired) {
    Write-SkipReport "another Anti-Codex real Antigravity verification is already running" $true $true $false
    exit 1
}

try {
    $node = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command "node" -ErrorAction Stop }
    $scriptPath = Join-Path $PSScriptRoot "test-anticodex-third-party-provider.mjs"
    $nodeArgs = @(
        $scriptPath,
        "--source-root", $RuntimeRoot,
        "--runtime-root", $RuntimeRoot,
        "--report-root", $ReportRoot,
        "--timeout-ms", ([Math]::Max(10000, $TimeoutSec * 1000)),
        "--allow-real-antigravity-turn",
        "--antigravity-model", $AntigravityModel,
        "--report-name", "provider-antigravity-return"
    )
    & $node.Source @nodeArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Exit-AntiCodexRealTrafficLock $lock
}
