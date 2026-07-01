#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WindowsUser = ".\AntiCodexModel",
    [string]$StateRoot = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$startedAt = [DateTime]::UtcNow
$scriptRoot = Split-Path -Parent $PSCommandPath
$reportIo = Join-Path $scriptRoot "anticodex-report-io.ps1"
$dualLanesScript = Join-Path $scriptRoot "test-anticodex-antigravity-cli-dual-account-lanes.ps1"
$readinessScript = Join-Path $scriptRoot "test-anticodex-antigravity-cli-windows-user-readiness.ps1"
$prepareScript = Join-Path $scriptRoot "test-anticodex-windows-user-account-prepare.ps1"

foreach ($required in @($reportIo, $dualLanesScript, $readinessScript, $prepareScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing required account-isolation dependency: $required"
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

function Save-AccountIsolationStatusReport {
    param($Report)
    $reportRootFull = [IO.Path]::GetFullPath($ReportRoot)
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $latestPath = Join-Path $reportRootFull "latest-antigravity-account-isolation-status.json"
    $historyPath = Join-Path $reportRootFull "$stamp-antigravity-account-isolation-status.json"
    $json = $Report | ConvertTo-Json -Depth 20
    Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json
    return [ordered]@{
        latest = $latestPath
        history = $historyPath
    }
}

function Get-OptionalProperty {
    param(
        $Object,
        [string]$Name,
        $Default = $null
    )
    if ($null -eq $Object) { return $Default }
    if ($Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
    return $Default
}

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

$dualArgs = @("-ReportRoot", $ReportRoot)
if ($StateRoot) { $dualArgs += @("-StateRoot", $StateRoot) }
$dualResult = Invoke-JsonScript -ScriptPath $dualLanesScript -Arguments $dualArgs
$readinessResult = Invoke-JsonScript -ScriptPath $readinessScript -Arguments @("-WindowsUser", $WindowsUser, "-ReportRoot", $ReportRoot)
$prepareResult = Invoke-JsonScript -ScriptPath $prepareScript -Arguments @("-WindowsUser", $WindowsUser, "-ReportRoot", $ReportRoot)

if (-not $dualResult.ok) { $failures.Add("dual_account_lanes_report_failed") | Out-Null }
if (-not $readinessResult.ok) { $failures.Add("windows_user_readiness_report_failed") | Out-Null }
if (-not $prepareResult.ok) { $failures.Add("windows_user_account_prepare_report_failed") | Out-Null }

$dual = $dualResult.parsed
$readiness = $readinessResult.parsed
$prepare = $prepareResult.parsed

$safeToAskLogin = ($prepare -and $prepare.safeToAskUserForSecondAccountLogin -eq $true)
$canProceedToInteractiveLogin = ($prepare -and $prepare.canProceedToInteractiveLogin -eq $true)
$blockedBeforeInteractiveLogin = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "blockedBeforeInteractiveLogin")) { [bool]$prepare.blockedBeforeInteractiveLogin } else { -not $safeToAskLogin }
$readyForInteractiveLogin = ($prepare -and $prepare.readyForInteractiveLogin -eq $true)
$operatorBlockingStage = if ($prepare -and [string]$prepare.operatorBlockingStage) { [string]$prepare.operatorBlockingStage } elseif ($readyForInteractiveLogin) { "ready" } else { "unknown_blocked_before_login" }
$operatorNextStep = if ($prepare -and [string]$prepare.operatorNextStep) { [string]$prepare.operatorNextStep } elseif ($readyForInteractiveLogin) { "run_windows_user_interactive_login_with_user_present" } else { "verify_windows_user_manually_then_rerun_prepare" }
$readinessBlockingReason = if ($prepare -and [string]$prepare.readinessBlockingReason) { [string]$prepare.readinessBlockingReason } elseif ($readiness -and [string]$readiness.readinessBlockingReason) { [string]$readiness.readinessBlockingReason } else { "" }

if ($readinessBlockingReason) { $warnings.Add($readinessBlockingReason) | Out-Null }

$antiCodexLanePrepared = ($dual -and $dual.ok -eq $true -and $dual.antiCodexLane.role -eq "anticodex-model-text")
$mcpLanePrepared = ($dual -and $dual.ok -eq $true -and $dual.mcpLane.role -eq "external-mcp-antigravity-account" -and $dual.mcpLane.managedByAntiCodex -eq $false)
$fileIsolationPrepared = ($dual -and $dual.ok -eq $true -and $dual.laneComparison.profileRootsDifferent -eq $true -and $dual.laneComparison.profileRootsNested -eq $false -and $dual.laneComparison.appDataDifferent -eq $true -and $dual.laneComparison.localAppDataDifferent -eq $true -and $dual.laneComparison.geminiDirDifferent -eq $true)
$targetUserExists = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetUserExists")) { $prepare.targetUserExists } elseif ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserExists")) { $readiness.targetUserExists } else { $null }
$targetUserIsCurrentUser = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetUserIsCurrentUser")) { [bool]$prepare.targetUserIsCurrentUser } elseif ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserIsCurrentUser")) { [bool]$readiness.targetUserIsCurrentUser } else { $false }
$targetUserSidMatchesCurrentUser = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetUserSidMatchesCurrentUser")) { [bool]$prepare.targetUserSidMatchesCurrentUser } elseif ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserSidMatchesCurrentUser")) { [bool]$readiness.targetUserSidMatchesCurrentUser } else { $false }
$targetUserIdentityBoundaryOk = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetUserIdentityBoundaryOk")) { [bool]$prepare.targetUserIdentityBoundaryOk } elseif ($readiness -and ($readiness.PSObject.Properties.Name -contains "targetUserIdentityBoundaryOk")) { [bool]$readiness.targetUserIdentityBoundaryOk } else { $false }

$completionState = if ($targetUserIsCurrentUser) {
    "blocked_target_is_current_windows_user"
} elseif (-not $readyForInteractiveLogin) {
    "blocked_before_interactive_login"
} elseif (-not $safeToAskLogin -or -not $canProceedToInteractiveLogin) {
    "blocked_before_interactive_login"
} else {
    "ready_for_interactive_login"
}

$finalProofPlan = [ordered]@{
    requiresSeparateWindowsUserCredentialBoundary = $true
    requiresInteractiveLogin = $true
    requiresApprovedRealTraffic = $true
    requiresDistinctAccountIdentityComparison = $true
    accountIdsMustDiffer = $true
    requiresExplicitSeparateAccountProofApproval = $true
    acceptsProfileAndAppDataOnlyProof = $false
    releaseAcceptableAccountProof = $false
}
$postLoginProofPlan = [ordered]@{
    proofScript = "test-anticodex-antigravity-cli-real-smoke.ps1"
    commandTemplate = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-anticodex-antigravity-cli-real-smoke.ps1 -AllowRealTraffic -WindowsUser <target-windows-user> -ProfileRoot <isolated-antigravity-cli-profile> -StrictWindowsAppDataIsolation -AccountIsolationBoundary separate-windows-user -AllowSeparateAccountProof -AntiCodexAccountId <anticodex-account-id-or-fingerprint> -McpAccountId <mcp-account-id-or-fingerprint> -SeparateAccountProofApprovalId <explicit-user-approval-id>"
    accountIsolationBoundary = "separate-windows-user"
    targetWindowsUser = $WindowsUser
    requiresInteractiveLoginComplete = $true
    requiresProofRunAsTargetWindowsUser = $true
    requiresApprovedRealTraffic = $true
    requiresSeparateAccountProofApproval = $true
    requiresDistinctAccountIdentityComparison = $true
    requiredAccountIdentityInputs = @("AntiCodexAccountId", "McpAccountId")
    accountIdsMustDiffer = $true
    mcpAccountLaneManagedByAntiCodex = $false
    mcpAccountLaneOwner = "external-antigravity-account-not-managed-here"
    canRunAfterInteractiveLogin = ($safeToAskLogin -and $canProceedToInteractiveLogin)
    blockedReason = if ($safeToAskLogin -and $canProceedToInteractiveLogin) { "" } else { $readinessBlockingReason }
}

$elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
$report = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "antigravity-account-isolation-status"
    noTraffic = $true
    usedRealTraffic = $false
    requestedRealTraffic = $false
    behaviorCovered = ($failures.Count -eq 0)
    coverageKind = "account-isolation-status-no-traffic"
    windowsUser = $WindowsUser
    completionState = $completionState
    accountLaneRole = "dual-antigravity-account-isolation-status"
    antiCodexLaneRole = "anticodex-model-text"
    mcpLaneRole = "external-mcp-antigravity-account"
    mcpAccountLaneManagedByAntiCodex = $false
    mcpAccountLaneOwner = "external-antigravity-account-not-managed-here"
    antiCodexModelTextLanePrepared = [bool]$antiCodexLanePrepared
    mcpExternalLanePrepared = [bool]$mcpLanePrepared
    fileIsolationPrepared = [bool]$fileIsolationPrepared
    credentialBoundary = "separate-windows-user"
    expectedCredentialStoreIsolation = $true
    targetUserExists = $targetUserExists
    targetUserIsCurrentUser = $targetUserIsCurrentUser
    currentWindowsUserSid = if ($prepare) { [string]$prepare.currentWindowsUserSid } elseif ($readiness) { [string]$readiness.currentWindowsUserSid } else { "" }
    targetWindowsUserSid = if ($prepare) { [string]$prepare.targetWindowsUserSid } elseif ($readiness) { [string]$readiness.targetWindowsUserSid } else { "" }
    targetUserSidMatchesCurrentUser = $targetUserSidMatchesCurrentUser
    targetUserIdentityBoundaryOk = $targetUserIdentityBoundaryOk
    readyForInteractiveLogin = $readyForInteractiveLogin
    readinessBlockingReason = $readinessBlockingReason
    safeToAskUserForSecondAccountLogin = $safeToAskLogin
    canProceedToInteractiveLogin = $canProceedToInteractiveLogin
    blockedBeforeInteractiveLogin = $blockedBeforeInteractiveLogin
    setupActionRequired = if ($prepare -and ($prepare.PSObject.Properties.Name -contains "setupActionRequired")) { [bool]$prepare.setupActionRequired } else { $blockedBeforeInteractiveLogin }
    operatorBlockingStage = $operatorBlockingStage
    operatorNextStep = $operatorNextStep
    nextProofRequiresInteractiveLogin = $readyForInteractiveLogin
    nextProofRequiresRealTraffic = $true
    finalProofPlan = $finalProofPlan
    postLoginProofPlan = $postLoginProofPlan
    loginVerified = $false
    separateAccountVerified = $false
    releaseAcceptableAccountProof = $false
    accountIsolationCaveat = "This is a no-traffic status report. It can say when the second-account login is safe to start, but it cannot prove login or distinct Antigravity account identity without explicit approved real traffic."
    evidence = [ordered]@{
        dualAccountLanes = if ($dual) { [ordered]@{ ok = [bool]$dual.ok; report = (Get-OptionalProperty -Object $dual -Name "report"); accountIsolationBoundary = [string]$dual.accountIsolationBoundary; accountIsolationCaveat = [string]$dual.accountIsolationCaveat } } else { $null }
        windowsUserReadiness = if ($readiness) { [ordered]@{ ok = [bool]$readiness.ok; report = (Get-OptionalProperty -Object $readiness -Name "report"); readyForInteractiveLogin = [bool]$readiness.readyForInteractiveLogin; readinessBlockingReason = [string]$readiness.readinessBlockingReason } } else { $null }
        windowsUserAccountPrepare = if ($prepare) { [ordered]@{ ok = [bool]$prepare.ok; report = (Get-OptionalProperty -Object $prepare -Name "report"); recommendedOperatorAction = [string]$prepare.recommendedOperatorAction; operatorBlockingStage = [string]$prepare.operatorBlockingStage; operatorNextStep = [string]$prepare.operatorNextStep } } else { $null }
    }
    failures = @($failures)
    warnings = @($warnings)
    elapsedMs = $elapsedMs
}
$report["report"] = Save-AccountIsolationStatusReport -Report $report
$report | ConvertTo-Json -Depth 20 -Compress
if ($failures.Count -gt 0) { exit 1 }
