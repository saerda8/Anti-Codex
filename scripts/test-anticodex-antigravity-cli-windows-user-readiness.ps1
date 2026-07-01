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
$loginScript = Join-Path $scriptRoot "start-anticodex-antigravity-cli-login-windows-user.ps1"
$reportIo = Join-Path $scriptRoot "anticodex-report-io.ps1"
$jsonInvoke = Join-Path $scriptRoot "anticodex-powershell-json-invoke.ps1"

if (-not (Test-Path -LiteralPath $loginScript -PathType Leaf)) {
    throw "missing Windows-user login launcher: $loginScript"
}
if (-not (Test-Path -LiteralPath $reportIo -PathType Leaf)) {
    throw "missing report writer: $reportIo"
}
if (-not (Test-Path -LiteralPath $jsonInvoke -PathType Leaf)) {
    throw "missing PowerShell JSON invoker: $jsonInvoke"
}
. $reportIo
. $jsonInvoke

function Get-RecommendedOperatorAction {
    param(
        [bool]$Ready,
        [string]$Reason,
        $TargetUserExists,
        $TargetUserIsCurrentUser
    )
    if ($Ready) { return "run_interactive_login_with_explicit_user_approval" }
    if ($TargetUserIsCurrentUser -eq $true -or $Reason -eq "target_windows_user_is_current_user") {
        return "choose_different_windows_user"
    }
    if ($TargetUserExists -eq $false -or $Reason -eq "target_windows_user_missing") {
        return "create_target_windows_user"
    }
    return "verify_windows_user_manually"
}

function Save-WindowsUserReadinessReport {
    param($Report)
    $reportRootFull = [IO.Path]::GetFullPath($ReportRoot)
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $latestPath = Join-Path $reportRootFull "latest-antigravity-cli-windows-user-readiness.json"
    $historyPath = Join-Path $reportRootFull "$stamp-antigravity-cli-windows-user-readiness.json"
    $json = $Report | ConvertTo-Json -Depth 12
    Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json
    return [ordered]@{
        latest = $latestPath
        history = $historyPath
    }
}

$failures = @()
$warnings = @()
$dryRun = $null
$dryRunError = ""

try {
    $dryRunResult = Invoke-AntiCodexPowerShellJsonScript -ScriptPath $loginScript -Arguments @("-WindowsUser", $WindowsUser, "-DryRun")
    if (-not $dryRunResult.ok) {
        throw $dryRunResult.stdoutTail
    }
    $dryRun = $dryRunResult.parsed
} catch {
    $dryRunError = $_.Exception.Message
    $failures += "windows_user_login_dry_run_failed"
}

if ($dryRun) {
    if ($dryRun.noTraffic -ne $true) { $failures += "dry_run_not_marked_no_traffic" }
    if ($dryRun.usedRealTraffic -ne $false) { $failures += "dry_run_used_real_traffic" }
    if ($dryRun.started -ne $false) { $failures += "dry_run_started_login_process" }
    if ($dryRun.capturesLoginOutput -ne $false) { $failures += "dry_run_captures_login_output" }
    if ($dryRun.credentialBoundary -ne "separate-windows-user") { $failures += "credential_boundary_mismatch" }
    if ($dryRun.expectedCredentialStoreIsolation -ne $true) { $failures += "missing_expected_credential_store_isolation" }
    if ($dryRun.readinessChecked -ne $true) { $failures += "readiness_not_checked" }
    if ($dryRun.targetUserIsCurrentUser -eq $true) { $failures += "target_windows_user_is_current_user" }
    if ($dryRun.targetUserSidMatchesCurrentUser -eq $true) { $failures += "target_windows_user_sid_matches_current_user" }
    if ($dryRun.readyForInteractiveLogin -eq $true -and $dryRun.targetUserIdentityBoundaryOk -ne $true) { $failures += "target_windows_user_identity_boundary_unverified" }
    if ($dryRun.targetUserExists -eq $false) { $warnings += "target_windows_user_missing" }
    if ($dryRun.readyForInteractiveLogin -ne $true -and -not [string]$dryRun.readinessBlockingReason) {
        $failures += "missing_readiness_blocking_reason"
    }
}

$ready = if ($dryRun -and ($dryRun.PSObject.Properties.Name -contains "readyForInteractiveLogin")) { [bool]$dryRun.readyForInteractiveLogin } else { $false }
$reason = if ($dryRun -and ($dryRun.PSObject.Properties.Name -contains "readinessBlockingReason")) { [string]$dryRun.readinessBlockingReason } else { "dry_run_unavailable" }
$targetExists = if ($dryRun -and ($dryRun.PSObject.Properties.Name -contains "targetUserExists")) { $dryRun.targetUserExists } else { $null }
$targetIsCurrent = if ($dryRun -and ($dryRun.PSObject.Properties.Name -contains "targetUserIsCurrentUser")) { [bool]$dryRun.targetUserIsCurrentUser } else { $false }
$operatorAction = Get-RecommendedOperatorAction -Ready $ready -Reason $reason -TargetUserExists $targetExists -TargetUserIsCurrentUser $targetIsCurrent

$elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
$report = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "antigravity-cli-windows-user-readiness"
    noTraffic = $true
    usedRealTraffic = $false
    requestedRealTraffic = $false
    behaviorCovered = $true
    coverageKind = "windows-user-login-readiness-no-traffic"
    windowsUser = $WindowsUser
    dryRunReportName = if ($dryRun) { [string]$dryRun.reportName } else { "" }
    started = if ($dryRun) { [bool]$dryRun.started } else { $false }
    capturesLoginOutput = if ($dryRun) { [bool]$dryRun.capturesLoginOutput } else { $false }
    credentialBoundary = if ($dryRun) { [string]$dryRun.credentialBoundary } else { "" }
    expectedCredentialStoreIsolation = if ($dryRun) { [bool]$dryRun.expectedCredentialStoreIsolation } else { $false }
    readinessChecked = if ($dryRun) { [bool]$dryRun.readinessChecked } else { $false }
    normalizedTargetWindowsUser = if ($dryRun) { [string]$dryRun.normalizedTargetWindowsUser } else { "" }
    currentWindowsUser = if ($dryRun) { [string]$dryRun.currentWindowsUser } else { "" }
    currentWindowsUserSid = if ($dryRun) { [string]$dryRun.currentWindowsUserSid } else { "" }
    targetWindowsUserSid = if ($dryRun) { [string]$dryRun.targetWindowsUserSid } else { "" }
    targetUserSidMatchesCurrentUser = if ($dryRun) { [bool]$dryRun.targetUserSidMatchesCurrentUser } else { $false }
    targetUserIdentityBoundaryOk = if ($dryRun) { [bool]$dryRun.targetUserIdentityBoundaryOk } else { $false }
    localUserLookupAvailable = if ($dryRun) { [bool]$dryRun.localUserLookupAvailable } else { $false }
    targetUserExists = $targetExists
    targetUserIsCurrentUser = $targetIsCurrent
    readyForInteractiveLogin = $ready
    readinessBlockingReason = $reason
    readinessLookupError = if ($dryRun) { [string]$dryRun.readinessLookupError } else { $dryRunError }
    recommendedOperatorAction = $operatorAction
    requiresUserAction = -not $ready
    requiresRealTrafficForNextProof = $true
    separateAccountVerified = $false
    loginVerified = $false
    accountIsolationCaveat = if ($dryRun) { [string]$dryRun.accountIsolationCaveat } else { "Readiness check could not invoke the dry-run launcher. Do not attempt login until this report is fixed." }
    failures = @($failures)
    warnings = @($warnings)
    elapsedMs = $elapsedMs
}

$report["report"] = Save-WindowsUserReadinessReport -Report $report
$report | ConvertTo-Json -Depth 12 -Compress
