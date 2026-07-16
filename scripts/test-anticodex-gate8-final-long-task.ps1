param(
    [string]$Model = "",
    [int]$TimeoutMs = 300000,
    [int]$LongContextChars = 100000,
    [string]$ReportRoot = "",
    [string]$NodePath = "",
    [string]$LockName = "Local\AntiCodex.RealTrafficBridge",
    [switch]$ResumeExisting,
    [switch]$AllowRealTraffic
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "anticodex-real-traffic-lock.psm1") -Force

$scriptPath = Join-Path $PSScriptRoot "test-anticodex-gate8-final-long-task.mjs"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Gate 8 final long-task runner is missing: $scriptPath"
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
}

$childArgs = @($scriptPath)
if ($AllowRealTraffic) { $childArgs += "--allow-real-traffic" }
if ($ResumeExisting) { $childArgs += "--resume-existing" }
if (-not [string]::IsNullOrWhiteSpace($Model)) { $childArgs += @("--model", $Model) }
$childArgs += @("--timeout-ms", [string]$TimeoutMs)
$childArgs += @("--long-context-chars", [string]$LongContextChars)
if (-not [string]::IsNullOrWhiteSpace($ReportRoot)) { $childArgs += @("--report-root", $ReportRoot) }

if (-not $AllowRealTraffic) {
    & $NodePath @childArgs
    exit $LASTEXITCODE
}

$lock = Enter-AntiCodexRealTrafficLock -Name $LockName -WaitSeconds 0
if (-not $lock.acquired) {
    [ordered]@{
        schema = "anticodex-gate8-final-lock-v1"
        reportName = "gate8-final-long-task"
        ok = $false
        skipped = $true
        busy = $true
        requestedRealTraffic = $true
        usedRealTraffic = $false
        longTaskStarted = $false
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
