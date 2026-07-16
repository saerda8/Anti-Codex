[CmdletBinding()]
param(
    [string]$Model = "",
    [string]$Journey = "",
    [int]$TimeoutMs = 300000,
    [string]$ReportRoot = "",
    [string]$NodePath = "",
    [string]$LockName = "Local\AntiCodex.RealTrafficBridge",
    [switch]$KeepArtifacts,
    [switch]$AllowRealTraffic
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "anticodex-real-traffic-lock.psm1") -Force

$scriptPath = Join-Path $PSScriptRoot "test-anticodex-human-long-journey.mjs"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Anti-Codex human long-journey runner is missing: $scriptPath"
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
}

$childArgs = @($scriptPath)
if ($AllowRealTraffic) { $childArgs += "--allow-real-traffic" }
if (-not [string]::IsNullOrWhiteSpace($Model)) { $childArgs += @("--model", $Model) }
if (-not [string]::IsNullOrWhiteSpace($Journey)) { $childArgs += @("--journey", $Journey) }
$childArgs += @("--timeout-ms", [string]$TimeoutMs)
if (-not [string]::IsNullOrWhiteSpace($ReportRoot)) { $childArgs += @("--report-root", $ReportRoot) }
if ($KeepArtifacts) { $childArgs += "--keep-artifacts" }

if (-not $AllowRealTraffic) {
    & $NodePath @childArgs
    exit $LASTEXITCODE
}

$lock = Enter-AntiCodexRealTrafficLock -Name $LockName -WaitSeconds 0
if (-not $lock.acquired) {
    [ordered]@{
        schema = "anticodex-human-long-lock-v1"
        reportName = "ui-human-long-journey"
        ok = $false
        skipped = $true
        busy = $true
        requestedRealTraffic = $true
        usedRealTraffic = $false
        longTaskStarted = $false
        journey = $Journey
        reason = "another Anti-Codex real-traffic verifier is running"
        generatedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Depth 6 -Compress
    exit 75
}

$previousLockState = $env:ANTICODEX_REAL_TRAFFIC_LOCK_HELD
$exitCode = 1
try {
    $env:ANTICODEX_REAL_TRAFFIC_LOCK_HELD = "1"
    & $NodePath @childArgs
    $exitCode = $LASTEXITCODE
} finally {
    if ($null -eq $previousLockState) {
        Remove-Item Env:ANTICODEX_REAL_TRAFFIC_LOCK_HELD -ErrorAction SilentlyContinue
    } else {
        $env:ANTICODEX_REAL_TRAFFIC_LOCK_HELD = $previousLockState
    }
    Exit-AntiCodexRealTrafficLock -Lock $lock
}

exit $exitCode
