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

foreach ($required in @($prepareScript, $reportIo)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing Windows-user setup guidance dependency: $required"
    }
}
. $reportIo

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
    $raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $prepareScript -WindowsUser $WindowsUser -ReportRoot $ReportRoot 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (($raw | Out-String).Trim())
    }
    $prepare = (($raw | Out-String).Trim() | ConvertFrom-Json)
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
    requiresUserPresence = $true
    nextProofRequiresInteractiveLogin = $readyForInteractiveLogin
    nextProofRequiresRealTraffic = $true
    separateAccountVerified = $false
    loginVerified = $false
    releaseAcceptableAccountProof = $false
    accountIsolationCaveat = "This report gives setup guidance only. It does not create Windows users, start login, capture passwords, or prove distinct Antigravity account identity."
    failures = @($failures)
    warnings = @($warnings)
    elapsedMs = $elapsedMs
}
$report["report"] = Save-SetupGuidanceReport -Report $report
$report | ConvertTo-Json -Depth 16 -Compress
if ($failures.Count -gt 0) { exit 1 }
