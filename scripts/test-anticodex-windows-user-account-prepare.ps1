#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WindowsUser = ".\AntiCodexModel",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [switch]$Compact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$startedAt = [DateTime]::UtcNow
$scriptRoot = Split-Path -Parent $PSCommandPath
$readinessScript = Join-Path $scriptRoot "test-anticodex-antigravity-cli-windows-user-readiness.ps1"
$reportIo = Join-Path $scriptRoot "anticodex-report-io.ps1"
$jsonInvoke = Join-Path $scriptRoot "anticodex-powershell-json-invoke.ps1"

if (-not (Test-Path -LiteralPath $readinessScript -PathType Leaf)) {
    throw "missing Windows-user readiness report script: $readinessScript"
}
if (-not (Test-Path -LiteralPath $reportIo -PathType Leaf)) {
    throw "missing report writer: $reportIo"
}
if (-not (Test-Path -LiteralPath $jsonInvoke -PathType Leaf)) {
    throw "missing PowerShell JSON invoker: $jsonInvoke"
}
. $reportIo
. $jsonInvoke

function Test-IsCurrentProcessElevated {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-RecommendedOperatorAction {
    param(
        [bool]$ReadyForInteractiveLogin,
        $TargetUserExists,
        [bool]$TargetUserIsCurrentUser,
        [bool]$CurrentProcessElevated,
        [string]$ReadinessBlockingReason
    )
    if ($ReadyForInteractiveLogin) { return "run_interactive_login_with_explicit_user_approval" }
    if ($TargetUserIsCurrentUser -or $ReadinessBlockingReason -eq "target_windows_user_is_current_user") {
        return "choose_different_windows_user"
    }
    if ($TargetUserExists -eq $false -and $CurrentProcessElevated) {
        return "create_target_windows_user_with_explicit_user_approval"
    }
    if ($TargetUserExists -eq $false) {
        return "open_elevated_windows_user_settings"
    }
    return "verify_windows_user_manually"
}

function Get-OperatorNextStep {
    param([string]$RecommendedOperatorAction)
    switch ($RecommendedOperatorAction) {
        "run_interactive_login_with_explicit_user_approval" { return "run_windows_user_interactive_login_with_user_present" }
        "choose_different_windows_user" { return "choose_separate_windows_user_then_rerun_prepare" }
        "create_target_windows_user_with_explicit_user_approval" { return "create_target_windows_user_then_rerun_prepare" }
        "open_elevated_windows_user_settings" { return "open_elevated_windows_user_settings_then_rerun_prepare" }
        "enable_target_windows_user_then_rerun_prepare" { return "enable_target_windows_user_then_rerun_prepare" }
        default { return "verify_windows_user_manually_then_rerun_prepare" }
    }
}

function Save-PrepareReport {
    param($Report)
    $reportRootFull = [IO.Path]::GetFullPath($ReportRoot)
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $latestPath = Join-Path $reportRootFull "latest-windows-user-account-prepare.json"
    $historyPath = Join-Path $reportRootFull "$stamp-windows-user-account-prepare.json"
    $json = $Report | ConvertTo-Json -Depth 12
    Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json
    return [ordered]@{
        latest = $latestPath
        history = $historyPath
    }
}

$failures = @()
$warnings = @()
$readiness = $null
$readinessError = ""

try {
    $readinessResult = Invoke-AntiCodexPowerShellJsonScript -ScriptPath $readinessScript -Arguments @("-WindowsUser", $WindowsUser, "-ReportRoot", $ReportRoot)
    if (-not $readinessResult.ok) {
        throw $readinessResult.stdoutTail
    }
    $readiness = $readinessResult.parsed
} catch {
    $readinessError = $_.Exception.Message
    $failures += "windows_user_readiness_report_failed"
}

$currentProcessElevated = Test-IsCurrentProcessElevated
$localUserCommandAvailable = [bool](Get-Command "Get-LocalUser" -ErrorAction SilentlyContinue)
$newLocalUserCommandAvailable = [bool](Get-Command "New-LocalUser" -ErrorAction SilentlyContinue)
$targetUserExists = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserExists")) { $readiness.targetUserExists } else { $null }
$targetUserEnabled = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserEnabled")) { $readiness.targetUserEnabled } else { $null }
$targetUserIsCurrentUser = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserIsCurrentUser")) { [bool]$readiness.targetUserIsCurrentUser } else { $false }
$targetUserSidMatchesCurrentUser = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserSidMatchesCurrentUser")) { [bool]$readiness.targetUserSidMatchesCurrentUser } else { $false }
$targetUserIdentityBoundaryOk = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserIdentityBoundaryOk")) { [bool]$readiness.targetUserIdentityBoundaryOk } else { $false }
$readyForInteractiveLogin = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "readyForInteractiveLogin")) { [bool]$readiness.readyForInteractiveLogin } else { $false }
$readinessBlockingReason = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "readinessBlockingReason")) { [string]$readiness.readinessBlockingReason } else { "readiness_report_unavailable" }
$canCreateTargetWindowsUser = ($targetUserExists -eq $false -and -not $targetUserIsCurrentUser -and $currentProcessElevated -and $newLocalUserCommandAvailable)
$recommendedOperatorAction = Get-RecommendedOperatorAction `
    -ReadyForInteractiveLogin $readyForInteractiveLogin `
    -TargetUserExists $targetUserExists `
    -TargetUserIsCurrentUser $targetUserIsCurrentUser `
    -CurrentProcessElevated $currentProcessElevated `
    -ReadinessBlockingReason $readinessBlockingReason
$safeToAskUserForSecondAccountLogin = ($readyForInteractiveLogin -eq $true)
$blockedBeforeInteractiveLogin = -not $safeToAskUserForSecondAccountLogin
$operatorBlockingStage = if ($safeToAskUserForSecondAccountLogin) {
    "ready"
} elseif ($targetUserIsCurrentUser) {
    "target_user_is_current_user"
} elseif ($targetUserExists -eq $false) {
    "target_user_missing_blocked_before_login"
} else {
    "unknown_blocked_before_login"
}
$operatorNextStep = Get-OperatorNextStep -RecommendedOperatorAction $recommendedOperatorAction
$setupActionRequired = $blockedBeforeInteractiveLogin
$canProceedToInteractiveLogin = $safeToAskUserForSecondAccountLogin

if ($targetUserExists -eq $false) { $warnings += "target_windows_user_missing" }
if ($targetUserEnabled -eq $false) { $warnings += "target_windows_user_disabled" }
if (-not $currentProcessElevated -and $targetUserExists -eq $false) { $warnings += "not_elevated_for_user_creation" }
if ($targetUserIsCurrentUser) { $failures += "target_windows_user_is_current_user" }
if ($targetUserSidMatchesCurrentUser) { $failures += "target_windows_user_sid_matches_current_user" }
if ($readyForInteractiveLogin -and -not $targetUserIdentityBoundaryOk) { $failures += "target_windows_user_identity_boundary_unverified" }
if (-not $localUserCommandAvailable) { $warnings += "local_user_lookup_unavailable" }
if (-not $newLocalUserCommandAvailable) { $warnings += "new_local_user_command_unavailable" }

$elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
$report = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "windows-user-account-prepare"
    noTraffic = $true
    usedRealTraffic = $false
    requestedRealTraffic = $false
    behaviorCovered = $true
    coverageKind = "windows-user-account-prepare-no-traffic"
    windowsUser = $WindowsUser
    currentProcessElevated = $currentProcessElevated
    localUserCommandAvailable = $localUserCommandAvailable
    newLocalUserCommandAvailable = $newLocalUserCommandAvailable
    changedSystem = $false
    createdUser = $false
    startedLogin = $false
    capturesPassword = $false
    storesPassword = $false
    canCreateTargetWindowsUser = $canCreateTargetWindowsUser
    targetUserExists = $targetUserExists
    targetUserEnabled = $targetUserEnabled
    targetUserIsCurrentUser = $targetUserIsCurrentUser
    currentWindowsUserSid = if ($readiness) { [string]$readiness.currentWindowsUserSid } else { "" }
    targetWindowsUserSid = if ($readiness) { [string]$readiness.targetWindowsUserSid } else { "" }
    targetUserSidMatchesCurrentUser = $targetUserSidMatchesCurrentUser
    targetUserIdentityBoundaryOk = $targetUserIdentityBoundaryOk
    readyForInteractiveLogin = $readyForInteractiveLogin
    readinessBlockingReason = $readinessBlockingReason
    readinessReport = if ($readiness) { [string]$readiness.report.latest } else { "" }
    readinessError = $readinessError
    recommendedOperatorAction = $recommendedOperatorAction
    safeToAskUserForSecondAccountLogin = $safeToAskUserForSecondAccountLogin
    blockedBeforeInteractiveLogin = $blockedBeforeInteractiveLogin
    operatorBlockingStage = $operatorBlockingStage
    operatorNextStep = $operatorNextStep
    setupActionRequired = $setupActionRequired
    canProceedToInteractiveLogin = $canProceedToInteractiveLogin
    requiresUserPresence = $true
    nextProofRequiresInteractiveLogin = $readyForInteractiveLogin
    nextProofRequiresRealTraffic = $true
    separateAccountVerified = $false
    loginVerified = $false
    failures = @($failures)
    warnings = @($warnings)
    elapsedMs = $elapsedMs
}
$report["report"] = Save-PrepareReport -Report $report
if ($Compact) {
    [ordered]@{
        ok = $report["ok"]
        reportName = $report["reportName"]
        noTraffic = $report["noTraffic"]
        usedRealTraffic = $report["usedRealTraffic"]
        changedSystem = $report["changedSystem"]
        createdUser = $report["createdUser"]
        startedLogin = $report["startedLogin"]
        capturesPassword = $report["capturesPassword"]
        storesPassword = $report["storesPassword"]
        windowsUser = $report["windowsUser"]
        currentProcessElevated = $report["currentProcessElevated"]
        targetUserExists = $report["targetUserExists"]
        targetUserEnabled = $report["targetUserEnabled"]
        targetWindowsUserSid = $report["targetWindowsUserSid"]
        targetUserSidMatchesCurrentUser = $report["targetUserSidMatchesCurrentUser"]
        targetUserIdentityBoundaryOk = $report["targetUserIdentityBoundaryOk"]
        readyForInteractiveLogin = $report["readyForInteractiveLogin"]
        safeToAskUserForSecondAccountLogin = $report["safeToAskUserForSecondAccountLogin"]
        canProceedToInteractiveLogin = $report["canProceedToInteractiveLogin"]
        readinessBlockingReason = $report["readinessBlockingReason"]
        operatorBlockingStage = $report["operatorBlockingStage"]
        operatorNextStep = $report["operatorNextStep"]
        recommendedOperatorAction = $report["recommendedOperatorAction"]
        failures = $report["failures"]
        warnings = $report["warnings"]
        report = $report["report"]
    } | ConvertTo-Json -Depth 8 -Compress
} else {
    $report | ConvertTo-Json -Depth 12 -Compress
}
