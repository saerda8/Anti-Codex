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
$prepareScript = Join-Path $scriptRoot "test-anticodex-windows-user-account-prepare.ps1"
$reportIo = Join-Path $scriptRoot "anticodex-report-io.ps1"
$jsonInvoke = Join-Path $scriptRoot "anticodex-powershell-json-invoke.ps1"

foreach ($required in @($prepareScript, $reportIo, $jsonInvoke)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing Windows-user setup guidance dependency: $required"
    }
}
. $reportIo
. $jsonInvoke

function Save-SetupGuidanceReport {
    param($Report)
    $reportRootFull = [IO.Path]::GetFullPath($ReportRoot)
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $latestPath = Join-Path $reportRootFull "latest-windows-user-setup-guidance.json"
    $historyPath = Join-Path $reportRootFull "$stamp-windows-user-setup-guidance.json"
    $json = $Report | ConvertTo-Json -Depth 16
    Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json
    return [ordered]@{
        latest = $latestPath
        history = $historyPath
    }
}

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$prepare = $null
$prepareError = ""

try {
    $prepareResult = Invoke-AntiCodexPowerShellJsonScript -ScriptPath $prepareScript -Arguments @("-WindowsUser", $WindowsUser, "-ReportRoot", $ReportRoot)
    if (-not $prepareResult.ok) {
        throw $prepareResult.stdoutTail
    }
    $prepare = $prepareResult.parsed
} catch {
    $prepareError = $_.Exception.Message
    $failures.Add("windows_user_account_prepare_failed") | Out-Null
}

$targetUserExists = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetUserExists")) { $prepare.targetUserExists } else { $null }
$readyForInteractiveLogin = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "readyForInteractiveLogin")) { [bool]$prepare.readyForInteractiveLogin } else { $false }
$operatorNextStep = if ($prepare -and [string]$prepare.operatorNextStep) { [string]$prepare.operatorNextStep } else { "run_windows_user_account_prepare" }
$recommendedOperatorAction = if ($prepare -and [string]$prepare.recommendedOperatorAction) { [string]$prepare.recommendedOperatorAction } else { "run_windows_user_account_prepare" }
$operatorBlockingStage = if ($prepare -and [string]$prepare.operatorBlockingStage) { [string]$prepare.operatorBlockingStage } else { "prepare_unavailable" }
$safeToAskUserForSecondAccountLogin = ($prepare -and $prepare.safeToAskUserForSecondAccountLogin -eq $true)
$blockedBeforeInteractiveLogin = -not $safeToAskUserForSecondAccountLogin
$requiresManualWindowsUserSetup = ($readyForInteractiveLogin -ne $true)
$manualSetupCommandHint = if ($targetUserExists -eq $false) {
    "create a separate local Windows user named AntiCodexModel, then rerun this guidance"
} elseif ($readyForInteractiveLogin) {
    "run the second-account login entrypoint with the user present and explicit approval"
} else {
    "verify the separate Windows user manually, then rerun this guidance"
}
$postManualSetupValidationCommands = @(
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-anticodex-windows-user-account-prepare.ps1 -WindowsUser .\AntiCodexModel -Compact",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-anticodex-antigravity-account-isolation-status.ps1 -WindowsUser .\AntiCodexModel -Compact",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\start-anticodex-second-antigravity-account-login.ps1 -WindowsUser .\AntiCodexModel -Compact"
)
$postManualSetupRequiredReadyFields = @(
    "targetUserExists:true",
    "targetWindowsUserSid:present",
    "targetUserSidMatchesCurrentUser:false",
    "targetUserIdentityBoundaryOk:true",
    "readyForInteractiveLogin:true",
    "safeToAskUserForSecondAccountLogin:true",
    "canProceedToInteractiveLogin:true",
    "startedLogin:false",
    "usedRealTraffic:false"
)

if ($targetUserExists -eq $false) { $warnings.Add("target_windows_user_missing") | Out-Null }
if ($prepare -and $prepare.changedSystem -ne $false) { $failures.Add("prepare_report_changed_system") | Out-Null }
if ($prepare -and $prepare.createdUser -ne $false) { $failures.Add("prepare_report_created_user") | Out-Null }
if ($prepare -and $prepare.startedLogin -ne $false) { $failures.Add("prepare_report_started_login") | Out-Null }
if ($prepare -and $prepare.capturesPassword -ne $false) { $failures.Add("prepare_report_captures_password") | Out-Null }
if ($prepare -and $prepare.storesPassword -ne $false) { $failures.Add("prepare_report_stores_password") | Out-Null }
if ($prepare -and $prepare.usedRealTraffic -ne $false) { $failures.Add("prepare_report_used_real_traffic") | Out-Null }

$elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
$report = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "windows-user-setup-guidance"
    noTraffic = $true
    usedRealTraffic = $false
    requestedRealTraffic = $false
    behaviorCovered = ($failures.Count -eq 0)
    coverageKind = "windows-user-setup-guidance-no-traffic"
    windowsUser = $WindowsUser
    guidanceSource = "windows-user-account-prepare"
    prepareReport = if ($prepare -and $prepare.report) { [string]$prepare.report.latest } else { "" }
    prepareError = $prepareError
    changedSystem = $false
    createdUser = $false
    startedLogin = $false
    capturesPassword = $false
    storesPassword = $false
    opensSettings = $false
    runsSystemUserCommand = $false
    targetUserExists = $targetUserExists
    currentWindowsUserSid = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "currentWindowsUserSid")) { [string]$prepare.currentWindowsUserSid } else { "" }
    targetWindowsUserSid = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetWindowsUserSid")) { [string]$prepare.targetWindowsUserSid } else { "" }
    targetUserSidMatchesCurrentUser = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetUserSidMatchesCurrentUser")) { [bool]$prepare.targetUserSidMatchesCurrentUser } else { $false }
    targetUserIdentityBoundaryOk = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetUserIdentityBoundaryOk")) { [bool]$prepare.targetUserIdentityBoundaryOk } else { $false }
    currentProcessElevated = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "currentProcessElevated")) { [bool]$prepare.currentProcessElevated } else { $false }
    canCreateTargetWindowsUser = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "canCreateTargetWindowsUser")) { [bool]$prepare.canCreateTargetWindowsUser } else { $false }
    readyForInteractiveLogin = $readyForInteractiveLogin
    safeToAskUserForSecondAccountLogin = $safeToAskUserForSecondAccountLogin
    blockedBeforeInteractiveLogin = $blockedBeforeInteractiveLogin
    requiresManualWindowsUserSetup = $requiresManualWindowsUserSetup
    recommendedOperatorAction = $recommendedOperatorAction
    operatorBlockingStage = $operatorBlockingStage
    operatorNextStep = $operatorNextStep
    manualSetupCommandHint = $manualSetupCommandHint
    postManualSetupValidationCommands = @($postManualSetupValidationCommands)
    postManualSetupRequiredReadyFields = @($postManualSetupRequiredReadyFields)
    readinessCheckSequence = @(
        "create_target_windows_user",
        "windows_user_account_prepare",
        "account_isolation_status",
        "second_account_login_entrypoint_with_explicit_approval"
    )
    operatorChecklist = @(
        [ordered]@{ stage = "create_target_windows_user"; startsLogin = $false; usesRealTraffic = $false; description = "create or verify the separate local Windows user named AntiCodexModel" }
        [ordered]@{ stage = "windows_user_account_prepare"; startsLogin = $false; usesRealTraffic = $false; description = "rerun the Windows-user account-prepare report until it is safe to ask for login" }
        [ordered]@{ stage = "account_isolation_status"; startsLogin = $false; usesRealTraffic = $false; description = "rerun the account-isolation status report and confirm the target SID boundary" }
        [ordered]@{ stage = "second_account_login_entrypoint_with_explicit_approval"; startsLogin = $true; usesRealTraffic = $false; description = "only then use the second-account login entrypoint with the exact approval token and the user present" }
    )
    requiresUserPresence = $true
    nextProofRequiresInteractiveLogin = $readyForInteractiveLogin
    nextProofRequiresRealTraffic = $true
    separateAccountVerified = $false
    loginVerified = $false
    releaseAcceptableAccountProof = $false
    operatorSetupPlan = [ordered]@{
        targetLocalWindowsUser = "AntiCodexModel"
        setupMode = "manual-only"
        preferredSurface = "windows-settings-other-users"
        antiCodexCreatesUser = $false
        antiCodexOpensSettings = $false
        antiCodexStartsLogin = $false
        antiCodexCapturesPassword = $false
        antiCodexStoresPassword = $false
        antiCodexUsesRealTraffic = $false
        rawUserManagementCommandProvided = $false
        afterManualSetupChecks = @(
            "windows_user_account_prepare",
            "account_isolation_status"
        )
        postManualSetupValidationCommands = @($postManualSetupValidationCommands)
        postManualSetupRequiredReadyFields = @($postManualSetupRequiredReadyFields)
        finalLoginEntrypoint = "start-anticodex-second-antigravity-account-login.ps1"
        finalLoginApproval = "start-separate-windows-user-login"
    }
    accountIsolationCaveat = "This report gives setup guidance only. It does not create Windows users, start login, capture passwords, or prove distinct Antigravity account identity."
    failures = @($failures)
    warnings = @($warnings)
    elapsedMs = $elapsedMs
}
$report["report"] = Save-SetupGuidanceReport -Report $report
$report | ConvertTo-Json -Depth 16 -Compress
if ($failures.Count -gt 0) { exit 1 }
