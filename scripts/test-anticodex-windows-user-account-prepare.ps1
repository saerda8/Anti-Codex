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
$readinessScript = Join-Path $scriptRoot "test-anticodex-antigravity-cli-windows-user-readiness.ps1"
$reportIo = Join-Path $scriptRoot "anticodex-report-io.ps1"

if (-not (Test-Path -LiteralPath $readinessScript -PathType Leaf)) {
    throw "missing Windows-user readiness report script: $readinessScript"
}
if (-not (Test-Path -LiteralPath $reportIo -PathType Leaf)) {
    throw "missing report writer: $reportIo"
}
. $reportIo

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
    $raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $readinessScript -WindowsUser $WindowsUser -ReportRoot $ReportRoot 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (($raw | Out-String).Trim())
    }
    $readiness = (($raw | Out-String).Trim() | ConvertFrom-Json)
} catch {
    $readinessError = $_.Exception.Message
    $failures += "windows_user_readiness_report_failed"
}

$currentProcessElevated = Test-IsCurrentProcessElevated
$localUserCommandAvailable = [bool](Get-Command "Get-LocalUser" -ErrorAction SilentlyContinue)
$newLocalUserCommandAvailable = [bool](Get-Command "New-LocalUser" -ErrorAction SilentlyContinue)
$targetUserExists = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserExists")) { $readiness.targetUserExists } else { $null }
$targetUserIsCurrentUser = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserIsCurrentUser")) { [bool]$readiness.targetUserIsCurrentUser } else { $false }
$readyForInteractiveLogin = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "readyForInteractiveLogin")) { [bool]$readiness.readyForInteractiveLogin } else { $false }
$readinessBlockingReason = if ($readiness -and ($readiness.PSObject.Properties.Name -contains "readinessBlockingReason")) { [string]$readiness.readinessBlockingReason } else { "readiness_report_unavailable" }
$canCreateTargetWindowsUser = ($targetUserExists -eq $false -and -not $targetUserIsCurrentUser -and $currentProcessElevated -and $newLocalUserCommandAvailable)
$recommendedOperatorAction = Get-RecommendedOperatorAction `
    -ReadyForInteractiveLogin $readyForInteractiveLogin `
    -TargetUserExists $targetUserExists `
    -TargetUserIsCurrentUser $targetUserIsCurrentUser `
    -CurrentProcessElevated $currentProcessElevated `
    -ReadinessBlockingReason $readinessBlockingReason

if ($targetUserExists -eq $false) { $warnings += "target_windows_user_missing" }
if (-not $currentProcessElevated -and $targetUserExists -eq $false) { $warnings += "not_elevated_for_user_creation" }
if ($targetUserIsCurrentUser) { $failures += "target_windows_user_is_current_user" }
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
    targetUserIsCurrentUser = $targetUserIsCurrentUser
    readyForInteractiveLogin = $readyForInteractiveLogin
    readinessBlockingReason = $readinessBlockingReason
    readinessReport = if ($readiness) { [string]$readiness.report.latest } else { "" }
    readinessError = $readinessError
    recommendedOperatorAction = $recommendedOperatorAction
    nextProofRequiresInteractiveLogin = $readyForInteractiveLogin
    nextProofRequiresRealTraffic = $true
    separateAccountVerified = $false
    loginVerified = $false
    failures = @($failures)
    warnings = @($warnings)
    elapsedMs = $elapsedMs
}
$report["report"] = Save-PrepareReport -Report $report
$report | ConvertTo-Json -Depth 12 -Compress
