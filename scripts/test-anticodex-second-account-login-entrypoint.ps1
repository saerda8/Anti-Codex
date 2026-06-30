#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WindowsUser = ".\AntiCodexModel",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$startedAt = [DateTime]::UtcNow
$scriptRoot = Split-Path -Parent $PSCommandPath
$entrypointScript = Join-Path $scriptRoot "start-anticodex-second-antigravity-account-login.ps1"
$reportIo = Join-Path $scriptRoot "anticodex-report-io.ps1"

foreach ($required in @($entrypointScript, $reportIo)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing second-account entrypoint report dependency: $required"
    }
}
. $reportIo

function Invoke-JsonScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )
    $raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($raw | Out-String).Trim()
    $parsed = $null
    $parseError = ""
    if ($text) {
        try {
            $parsed = $text | ConvertFrom-Json
        } catch {
            $parseError = $_.Exception.Message
        }
    }
    return [ordered]@{
        exitCode = $exitCode
        ok = ($exitCode -eq 0 -and $null -ne $parsed -and $parseError -eq "")
        parsed = $parsed
        parseError = $parseError
        stdoutTail = if ($text.Length -gt 600) { $text.Substring($text.Length - 600) } else { $text }
    }
}

function Save-SecondAccountEntrypointReport {
    param($Report)
    $reportRootFull = [IO.Path]::GetFullPath($ReportRoot)
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $latestPath = Join-Path $reportRootFull "latest-second-antigravity-account-login-entrypoint.json"
    $historyPath = Join-Path $reportRootFull "$stamp-second-antigravity-account-login-entrypoint.json"
    $json = $Report | ConvertTo-Json -Depth 20
    Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json
    return [ordered]@{
        latest = $latestPath
        history = $historyPath
    }
}

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

$statusOnlyResult = Invoke-JsonScript -ScriptPath $entrypointScript -Arguments @(
    "-WindowsUser", $WindowsUser,
    "-ReportRoot", $ReportRoot
)
$statusOnly = $statusOnlyResult.parsed
if (-not $statusOnlyResult.ok) { $failures.Add("status_only_entrypoint_failed") | Out-Null }

$missingApprovalResult = Invoke-JsonScript -ScriptPath $entrypointScript -Arguments @(
    "-WindowsUser", $WindowsUser,
    "-ReportRoot", $ReportRoot,
    "-StartLogin"
)
$missingApproval = $missingApprovalResult.parsed
if ($missingApprovalResult.exitCode -ne 2 -or -not $missingApproval -or $missingApproval.error -ne "explicit_start_login_approval_missing") {
    $failures.Add("missing_approval_did_not_block_login") | Out-Null
}

$approvedButBlockedResult = Invoke-JsonScript -ScriptPath $entrypointScript -Arguments @(
    "-WindowsUser", $WindowsUser,
    "-ReportRoot", $ReportRoot,
    "-StartLogin",
    "-StartLoginApproval", "start-separate-windows-user-login"
)
$approvedButBlocked = $approvedButBlockedResult.parsed
if ($approvedButBlockedResult.exitCode -ne 2 -or -not $approvedButBlocked -or $approvedButBlocked.error -ne "second_account_login_not_ready") {
    $failures.Add("approved_start_did_not_respect_status_gate") | Out-Null
}

$currentWindowsUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$sameWindowsUserReportRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-same-user-entrypoint-" + [guid]::NewGuid().ToString("N"))
$sameWindowsUserTargetResult = Invoke-JsonScript -ScriptPath $entrypointScript -Arguments @(
    "-WindowsUser", $currentWindowsUser,
    "-ReportRoot", $sameWindowsUserReportRoot,
    "-StartLogin",
    "-StartLoginApproval", "start-separate-windows-user-login"
)
$sameWindowsUserTarget = $sameWindowsUserTargetResult.parsed
if ($sameWindowsUserTargetResult.exitCode -ne 2 -or -not $sameWindowsUserTarget -or $sameWindowsUserTarget.error -ne "second_account_login_not_ready" -or $sameWindowsUserTarget.readinessBlockingReason -ne "target_windows_user_is_current_user") {
    $failures.Add("same_windows_user_target_did_not_block_login") | Out-Null
}

foreach ($entry in @($statusOnly, $missingApproval, $approvedButBlocked, $sameWindowsUserTarget)) {
    if (-not $entry) { continue }
    if ($entry.usedRealTraffic -ne $false) { $failures.Add("entrypoint_used_real_traffic") | Out-Null }
    if ($entry.requestedRealTraffic -ne $false) { $failures.Add("entrypoint_requested_real_traffic") | Out-Null }
    if ($entry.changedSystem -ne $false) { $failures.Add("entrypoint_changed_system") | Out-Null }
    if ($entry.createdUser -ne $false) { $failures.Add("entrypoint_created_user") | Out-Null }
    if ($entry.capturesLoginOutput -ne $false) { $failures.Add("entrypoint_captures_login_output") | Out-Null }
    if ($entry.capturesPassword -ne $false) { $failures.Add("entrypoint_captures_password") | Out-Null }
    if ($entry.storesPassword -ne $false) { $failures.Add("entrypoint_stores_password") | Out-Null }
    if ($entry.startedLogin -eq $true) { $failures.Add("entrypoint_started_login_before_ready") | Out-Null }
    if ($entry.separateAccountVerified -ne $false) { $failures.Add("entrypoint_claimed_separate_account") | Out-Null }
    if ($entry.loginVerified -ne $false) { $failures.Add("entrypoint_claimed_login") | Out-Null }
    if ($entry.releaseAcceptableAccountProof -ne $false) { $failures.Add("entrypoint_claimed_release_proof") | Out-Null }
}

if ($statusOnly -and [string]$statusOnly.readinessBlockingReason) {
    $warnings.Add([string]$statusOnly.readinessBlockingReason) | Out-Null
}

$elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
$report = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "second-antigravity-account-login-entrypoint"
    noTraffic = $true
    usedRealTraffic = $false
    requestedRealTraffic = $false
    behaviorCovered = ($failures.Count -eq 0)
    coverageKind = "second-account-login-entrypoint-no-traffic"
    windowsUser = $WindowsUser
    statusOnlyOk = ($statusOnlyResult.ok -and $statusOnly.ok -eq $true)
    statusOnlySafetyFieldsOk = ($statusOnly -and $statusOnly.requestedRealTraffic -eq $false -and $statusOnly.changedSystem -eq $false -and $statusOnly.createdUser -eq $false -and $statusOnly.capturesPassword -eq $false -and $statusOnly.storesPassword -eq $false)
    statusOnlyExitCode = $statusOnlyResult.exitCode
    missingApprovalBlocked = ($missingApprovalResult.exitCode -eq 2 -and $missingApproval.error -eq "explicit_start_login_approval_missing")
    approvedStartBlockedByStatusGate = ($approvedButBlockedResult.exitCode -eq 2 -and $approvedButBlocked.error -eq "second_account_login_not_ready")
    sameWindowsUserTargetBlocked = ($sameWindowsUserTargetResult.exitCode -eq 2 -and $sameWindowsUserTarget.error -eq "second_account_login_not_ready" -and $sameWindowsUserTarget.readinessBlockingReason -eq "target_windows_user_is_current_user")
    sameWindowsUserTargetBlockingReason = if ($sameWindowsUserTarget) { [string]$sameWindowsUserTarget.readinessBlockingReason } else { "" }
    sameWindowsUserTargetStartedLogin = if ($sameWindowsUserTarget) { [bool]$sameWindowsUserTarget.startedLogin } else { $false }
    sameWindowsUserTargetSafetyFieldsOk = ($sameWindowsUserTarget -and $sameWindowsUserTarget.usedRealTraffic -eq $false -and $sameWindowsUserTarget.requestedRealTraffic -eq $false -and $sameWindowsUserTarget.changedSystem -eq $false -and $sameWindowsUserTarget.createdUser -eq $false -and $sameWindowsUserTarget.capturesLoginOutput -eq $false -and $sameWindowsUserTarget.capturesPassword -eq $false -and $sameWindowsUserTarget.storesPassword -eq $false -and $sameWindowsUserTarget.startedLogin -ne $true)
    requestedStartLogin = $false
    startedLogin = $false
    changedSystem = $false
    createdUser = $false
    capturesLoginOutput = $false
    capturesPassword = $false
    storesPassword = $false
    safeToStartLogin = if ($statusOnly) { [bool]$statusOnly.safeToStartLogin } else { $false }
    requiredStartLoginApproval = "start-separate-windows-user-login"
    completionState = if ($statusOnly) { [string]$statusOnly.completionState } else { "status_unavailable" }
    readinessBlockingReason = if ($statusOnly) { [string]$statusOnly.readinessBlockingReason } else { "" }
    operatorBlockingStage = if ($statusOnly) { [string]$statusOnly.operatorBlockingStage } else { "status_unavailable" }
    operatorNextStep = if ($statusOnly) { [string]$statusOnly.operatorNextStep } else { "run_account_isolation_status" }
    separateAccountVerified = $false
    loginVerified = $false
    releaseAcceptableAccountProof = $false
    accountIsolationCaveat = "This verifies the second-account operator entrypoint only. It does not start login, prove login, or prove distinct Antigravity account identity."
    failures = @($failures)
    warnings = @($warnings)
    elapsedMs = $elapsedMs
}
$report["report"] = Save-SecondAccountEntrypointReport -Report $report
$report | ConvertTo-Json -Depth 20 -Compress
if ($failures.Count -gt 0) { exit 1 }
