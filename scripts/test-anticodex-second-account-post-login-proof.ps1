#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WindowsUser = ".\AntiCodexModel",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [string]$ProfileRoot = "",
    [switch]$AllowRealTraffic,
    [switch]$AllowSeparateAccountProof,
    [switch]$ConfirmInteractiveLoginComplete,
    [string]$AntiCodexAccountId = "",
    [string]$McpAccountId = "",
    [string]$McpAccountIdentityReport = "",
    [string]$SeparateAccountProofApprovalId = "",
    [string]$Model = "gemini-pro-agent",
    [int]$TimeoutSec = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$startedAt = [DateTime]::UtcNow
$scriptRoot = Split-Path -Parent $PSCommandPath
$reportIo = Join-Path $scriptRoot "anticodex-report-io.ps1"
$statusScript = Join-Path $scriptRoot "test-anticodex-antigravity-account-isolation-status.ps1"
$realSmokeScript = Join-Path $scriptRoot "test-anticodex-antigravity-cli-real-smoke.ps1"
$jsonInvoke = Join-Path $scriptRoot "anticodex-powershell-json-invoke.ps1"

foreach ($required in @($reportIo, $statusScript, $realSmokeScript, $jsonInvoke)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing second-account post-login proof dependency: $required"
    }
}
. $reportIo
. $jsonInvoke

function Invoke-JsonScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )

    return Invoke-AntiCodexPowerShellJsonScript -ScriptPath $ScriptPath -Arguments $Arguments
}

function Save-PostLoginProofReport {
    param($Report)
    $reportRootFull = [IO.Path]::GetFullPath($ReportRoot)
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $latestPath = Join-Path $reportRootFull "latest-second-account-post-login-proof.json"
    $historyPath = Join-Path $reportRootFull "$stamp-second-account-post-login-proof.json"
    $json = $Report | ConvertTo-Json -Depth 24
    Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json
    return [ordered]@{
        latest = $latestPath
        history = $historyPath
    }
}

function Get-LatestDualLaneProfileRoot {
    $latestPath = Join-Path ([IO.Path]::GetFullPath($ReportRoot)) "latest-antigravity-cli-dual-account-lanes.json"
    if (-not (Test-Path -LiteralPath $latestPath -PathType Leaf)) { return "" }
    try {
        $report = Get-Content -LiteralPath $latestPath -Raw | ConvertFrom-Json
        if ($report -and $report.antiCodexLane -and [string]$report.antiCodexLane.profileRoot) {
            return [IO.Path]::GetFullPath([string]$report.antiCodexLane.profileRoot)
        }
    } catch {
        return ""
    }
    return ""
}

function Get-LatestAntiCodexAccountFingerprint {
    $latestPath = Join-Path ([IO.Path]::GetFullPath($ReportRoot)) "latest-account-proxy-readiness.json"
    $result = [ordered]@{
        present = $false
        ok = $false
        identityAvailable = $false
        fingerprint = ""
        planName = ""
        tierName = ""
        sourceReport = $latestPath
        error = ""
    }
    if (-not (Test-Path -LiteralPath $latestPath -PathType Leaf)) { return $result }
    try {
        $report = Get-Content -LiteralPath $latestPath -Raw | ConvertFrom-Json
        $result.present = $true
        $result.ok = ($report.ok -eq $true)
        $result.identityAvailable = ($report.account.identityAvailable -eq $true)
        $result.fingerprint = [string]$report.account.fingerprint
        $result.planName = [string]$report.account.planName
        $result.tierName = [string]$report.account.tierName
    } catch {
        $result.error = $_.Exception.Message
    }
    return $result
}

function Get-ObjectStringProperty {
    param(
        $Object,
        [string]$Name
    )
    if (-not $Object -or -not $Object.PSObject.Properties[$Name]) { return "" }
    return [string]$Object.PSObject.Properties[$Name].Value
}

function Get-ExternalMcpAccountIdentity {
    param([string]$Path)

    $result = [ordered]@{
        present = [bool]$Path
        path = $Path
        ok = $false
        accepted = $false
        reportName = ""
        accountLaneRole = ""
        mcpAccountLaneManagedByAntiCodex = $null
        identityAvailable = $false
        fingerprint = ""
        source = ""
        approvalId = ""
        error = ""
        failureReason = ""
    }
    if (-not $Path) { return $result }

    $fullPath = [IO.Path]::GetFullPath($Path)
    $result.path = $fullPath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        $result.failureReason = "external_mcp_identity_report_missing"
        return $result
    }

    try {
        $report = Get-Content -LiteralPath $fullPath -Raw | ConvertFrom-Json
        $account = if ($report.PSObject.Properties["account"] -and $report.account -is [object]) { $report.account } else { $null }
        $fingerprint = Get-ObjectStringProperty -Object $report -Name "accountFingerprint"
        if (-not $fingerprint) { $fingerprint = Get-ObjectStringProperty -Object $report -Name "fingerprint" }
        if (-not $fingerprint -and $account) { $fingerprint = Get-ObjectStringProperty -Object $account -Name "fingerprint" }

        $result.ok = ($report.ok -eq $true)
        $result.reportName = Get-ObjectStringProperty -Object $report -Name "reportName"
        $result.accountLaneRole = Get-ObjectStringProperty -Object $report -Name "accountLaneRole"
        $result.mcpAccountLaneManagedByAntiCodex = $report.mcpAccountLaneManagedByAntiCodex
        $result.identityAvailable = ($report.identityAvailable -eq $true -or ($account -and $account.identityAvailable -eq $true))
        $result.fingerprint = $fingerprint
        $result.source = if ([string](Get-ObjectStringProperty -Object $report -Name "source")) { Get-ObjectStringProperty -Object $report -Name "source" } else { "external-mcp-antigravity-account-identity-report" }
        $result.approvalId = Get-ObjectStringProperty -Object $report -Name "approvalId"
        $result.accepted = [bool](
            $result.ok -eq $true `
            -and $result.accountLaneRole -eq "external-mcp-antigravity-account" `
            -and $result.mcpAccountLaneManagedByAntiCodex -eq $false `
            -and $result.identityAvailable -eq $true `
            -and [string]$result.fingerprint
        )
        if (-not $result.accepted) { $result.failureReason = "external_mcp_identity_report_invalid" }
    } catch {
        $result.error = $_.Exception.Message
        $result.failureReason = "external_mcp_identity_report_parse_failed"
    }
    return $result
}

function New-ProofCommandPreview {
    param(
        [string]$ResolvedProfileRoot,
        [bool]$HasAntiCodexId,
        [bool]$HasMcpId,
        [bool]$HasApproval
    )
    $antiCodexId = if ($HasAntiCodexId) { "<provided-anticodex-account-id>" } else { "<anticodex-account-id-or-fingerprint>" }
    $mcpId = if ($HasMcpId) { "<provided-mcp-account-id>" } else { "<mcp-account-id-or-fingerprint>" }
    $approvalId = if ($HasApproval) { "<provided-explicit-user-approval-id>" } else { "<explicit-user-approval-id>" }
    return "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-anticodex-antigravity-cli-real-smoke.ps1 -AllowRealTraffic -WindowsUser $WindowsUser -ProfileRoot $ResolvedProfileRoot -StrictWindowsAppDataIsolation -AccountIsolationBoundary separate-windows-user -AllowSeparateAccountProof -AntiCodexAccountId $antiCodexId -McpAccountId $mcpId -SeparateAccountProofApprovalId $approvalId"
}

function New-AccountIdentityInputChecklist {
    param(
        [string]$ProvidedAntiCodexAccountId,
        [string]$ProvidedMcpAccountId,
        [string]$ProvidedApprovalId,
        $LatestAntiCodexFingerprint,
        $ExternalMcpIdentity
    )

    $suggestedAntiCodexId = ""
    $suggestedAntiCodexSource = ""
    if ($LatestAntiCodexFingerprint -and $LatestAntiCodexFingerprint.ok -eq $true -and $LatestAntiCodexFingerprint.identityAvailable -eq $true -and [string]$LatestAntiCodexFingerprint.fingerprint) {
        $suggestedAntiCodexId = [string]$LatestAntiCodexFingerprint.fingerprint
        $suggestedAntiCodexSource = "latest-account-proxy-readiness.account.fingerprint"
    }

    $externalMcpId = if ($ExternalMcpIdentity -and $ExternalMcpIdentity.accepted -eq $true) { [string]$ExternalMcpIdentity.fingerprint } else { "" }
    $mcpEffective = if ($ProvidedMcpAccountId) { $ProvidedMcpAccountId } else { $externalMcpId }
    $antiCodexEffective = if ($ProvidedAntiCodexAccountId) { $ProvidedAntiCodexAccountId } else { $suggestedAntiCodexId }
    $accountIdsDiffer = ($antiCodexEffective -and $mcpEffective -and $antiCodexEffective -ne $mcpEffective)
    return [ordered]@{
        antiCodexAccountId = [ordered]@{
            provided = [bool]$ProvidedAntiCodexAccountId
            suggestedAvailable = [bool]$suggestedAntiCodexId
            suggestedValue = $suggestedAntiCodexId
            suggestedSource = $suggestedAntiCodexSource
            sourceReport = if ($LatestAntiCodexFingerprint) { [string]$LatestAntiCodexFingerprint.sourceReport } else { "" }
            planName = if ($LatestAntiCodexFingerprint) { [string]$LatestAntiCodexFingerprint.planName } else { "" }
            tierName = if ($LatestAntiCodexFingerprint) { [string]$LatestAntiCodexFingerprint.tierName } else { "" }
        }
        mcpAccountId = [ordered]@{
            provided = [bool]$ProvidedMcpAccountId
            suggestedAvailable = [bool]$externalMcpId
            suggestedValue = $externalMcpId
            suggestedSource = if ($externalMcpId) { "externalMcpAccountIdentityReport.fingerprint" } else { "" }
            sourceReport = if ($ExternalMcpIdentity) { [string]$ExternalMcpIdentity.path } else { "" }
            managedByAntiCodex = $false
            requiredSource = "external-mcp-antigravity-account"
            note = "Anti-Codex must not invent or fetch this value from its own lane."
        }
        approvalId = [ordered]@{
            provided = [bool]$ProvidedApprovalId
            required = $true
            suggestedFormat = "second-antigravity-account-proof-YYYYMMDD"
        }
        effectiveAntiCodexAccountIdPresent = [bool]$antiCodexEffective
        effectiveMcpAccountIdPresent = [bool]$mcpEffective
        mcpAccountIdPresent = [bool]$mcpEffective
        approvalIdPresent = [bool]$ProvidedApprovalId
        accountIdsDiffer = [bool]$accountIdsDiffer
        allInputsReadyForProof = [bool]($antiCodexEffective -and $mcpEffective -and $ProvidedApprovalId -and $accountIdsDiffer)
    }
}

function New-PostLoginProofOperatorActionCard {
    param(
        [bool]$TargetUserExists,
        [bool]$SafeToAskUserForSecondAccountLogin,
        [bool]$CanRunAfterInteractiveLogin,
        [bool]$ConfirmLogin,
        [bool]$RealTrafficAllowed,
        [bool]$SeparateAccountProofAllowed,
        [bool]$AntiCodexIdPresent,
        [bool]$McpIdPresent,
        [bool]$AccountIdsDiffer,
        [bool]$ApprovalIdPresent,
        [bool]$WillRunProofNow,
        [bool]$ProofAccepted,
        [string]$ReadinessBlocker,
        [string]$ProofCommand
    )

    $missing = New-Object System.Collections.Generic.List[string]
    if (-not $TargetUserExists) { $missing.Add("separate_windows_user_missing") | Out-Null }
    if ($TargetUserExists -and (-not $SafeToAskUserForSecondAccountLogin -or -not $CanRunAfterInteractiveLogin)) { $missing.Add("account_isolation_status_not_ready") | Out-Null }
    if (-not $ConfirmLogin) { $missing.Add("interactive_login_not_confirmed") | Out-Null }
    if (-not $RealTrafficAllowed) { $missing.Add("approved_real_traffic_not_requested") | Out-Null }
    if (-not $SeparateAccountProofAllowed) { $missing.Add("separate_account_proof_switch_missing") | Out-Null }
    if (-not $AntiCodexIdPresent -or -not $McpIdPresent) { $missing.Add("account_identity_inputs_missing") | Out-Null }
    if ($AntiCodexIdPresent -and $McpIdPresent -and -not $AccountIdsDiffer) { $missing.Add("account_ids_match") | Out-Null }
    if (-not $ApprovalIdPresent) { $missing.Add("separate_account_proof_approval_missing") | Out-Null }

    $status = if ($ProofAccepted) {
        "proof_accepted"
    } elseif (-not $TargetUserExists -or -not $SafeToAskUserForSecondAccountLogin -or -not $CanRunAfterInteractiveLogin) {
        "blocked_before_login"
    } elseif (-not $ConfirmLogin) {
        "needs_interactive_login_confirmation"
    } elseif ($missing.Count -gt 0) {
        "needs_account_identity_inputs"
    } elseif ($WillRunProofNow) {
        "post_login_proof_running"
    } else {
        "ready_for_post_login_proof"
    }

    $nextAction = if ($ProofAccepted) {
        "rerun_goal_readiness_after_account_proof"
    } elseif (-not $TargetUserExists) {
        "create_or_verify_target_windows_user_then_rerun_post_login_proof"
    } elseif (-not $SafeToAskUserForSecondAccountLogin -or -not $CanRunAfterInteractiveLogin) {
        "rerun_account_prepare_and_status_until_login_safe"
    } elseif (-not $ConfirmLogin) {
        "confirm_interactive_second_account_login_then_rerun_post_login_proof"
    } elseif ($missing.Count -gt 0) {
        "provide_distinct_account_ids_and_explicit_proof_approval"
    } else {
        "run_post_login_proof_command"
    }

    $userStep = if ($ProofAccepted) {
        "Rerun goal readiness."
    } elseif (-not $TargetUserExists) {
        "Create or verify the separate Windows user, then rerun this proof summary."
    } elseif (-not $SafeToAskUserForSecondAccountLogin -or -not $CanRunAfterInteractiveLogin) {
        "Rerun the no-traffic account prepare and isolation checks until login is marked safe."
    } elseif (-not $ConfirmLogin) {
        "After the separate Windows-user Antigravity login is complete, rerun this proof command with the confirmation flag."
    } elseif ($missing.Count -gt 0) {
        "Provide the distinct Anti-Codex and MCP account identifiers plus the explicit proof approval id."
    } else {
        "Run the post-login proof command."
    }

    return [ordered]@{
        status = $status
        windowsUser = $WindowsUser
        canRunPostLoginProofNow = [bool]($WillRunProofNow -and -not $ProofAccepted)
        targetUserExists = [bool]$TargetUserExists
        canAskUserToLoginNow = [bool]($TargetUserExists -and $SafeToAskUserForSecondAccountLogin)
        confirmInteractiveLoginComplete = [bool]$ConfirmLogin
        missingRequirement = if ($missing.Count -gt 0) { [string]$missing[0] } else { "" }
        missingRequirements = @($missing)
        readinessBlockingReason = $ReadinessBlocker
        nextOperatorAction = $nextAction
        userVisibleNextStep = $userStep
        noTrafficStatusCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-anticodex-second-account-post-login-proof.ps1 -WindowsUser $WindowsUser"
        proofCommandPreview = $ProofCommand
    }
}

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$statusResult = Invoke-JsonScript -ScriptPath $statusScript -Arguments @("-WindowsUser", $WindowsUser, "-ReportRoot", $ReportRoot)
$status = $statusResult.parsed
if (-not $statusResult.ok) { $failures.Add("account_isolation_status_unavailable") | Out-Null }

$resolvedProfileRoot = if ($ProfileRoot) { [IO.Path]::GetFullPath($ProfileRoot) } else { Get-LatestDualLaneProfileRoot }
$antiCodexAccountIdTrimmed = ([string]$AntiCodexAccountId).Trim()
$mcpAccountIdTrimmed = ([string]$McpAccountId).Trim()
$approvalIdTrimmed = ([string]$SeparateAccountProofApprovalId).Trim()
$latestAntiCodexFingerprint = Get-LatestAntiCodexAccountFingerprint
$externalMcpIdentity = Get-ExternalMcpAccountIdentity -Path ([string]$McpAccountIdentityReport).Trim()
if ($externalMcpIdentity.present -eq $true -and $externalMcpIdentity.accepted -ne $true) {
    $failures.Add([string]$externalMcpIdentity.failureReason) | Out-Null
}
$identityChecklist = New-AccountIdentityInputChecklist -ProvidedAntiCodexAccountId $antiCodexAccountIdTrimmed -ProvidedMcpAccountId $mcpAccountIdTrimmed -ProvidedApprovalId $approvalIdTrimmed -LatestAntiCodexFingerprint $latestAntiCodexFingerprint -ExternalMcpIdentity $externalMcpIdentity
$effectiveAntiCodexAccountId = if ($antiCodexAccountIdTrimmed) { $antiCodexAccountIdTrimmed } else { [string]$identityChecklist.antiCodexAccountId.suggestedValue }
$effectiveMcpAccountId = if ($mcpAccountIdTrimmed) { $mcpAccountIdTrimmed } else { [string]$identityChecklist.mcpAccountId.suggestedValue }
$accountIdsDiffer = ($effectiveAntiCodexAccountId -and $effectiveMcpAccountId -and $effectiveAntiCodexAccountId -ne $effectiveMcpAccountId)

if (-not $resolvedProfileRoot) { $failures.Add("isolated_profile_root_missing") | Out-Null }
if ($AllowRealTraffic -and -not $AllowSeparateAccountProof) { $failures.Add("allow_separate_account_proof_required") | Out-Null }
if ($AllowRealTraffic -and -not $ConfirmInteractiveLoginComplete) { $failures.Add("interactive_login_confirmation_required") | Out-Null }
if ($AllowRealTraffic -and -not $effectiveAntiCodexAccountId) { $failures.Add("anticodex_account_id_required") | Out-Null }
if ($AllowRealTraffic -and -not $effectiveMcpAccountId) { $failures.Add("mcp_account_id_required") | Out-Null }
if ($AllowRealTraffic -and -not $approvalIdTrimmed) { $failures.Add("separate_account_proof_approval_id_required") | Out-Null }
if ($AllowRealTraffic -and $effectiveAntiCodexAccountId -and $effectiveMcpAccountId -and -not $accountIdsDiffer) { $failures.Add("account_ids_match") | Out-Null }
if ($status -and $status.postLoginProofPlan -and $status.postLoginProofPlan.canRunAfterInteractiveLogin -ne $true) {
    $warnings.Add("post_login_proof_plan_not_ready: $([string]$status.postLoginProofPlan.blockedReason)") | Out-Null
}

$realSmoke = $null
$realSmokeResult = $null
$willRunRealSmoke = ($AllowRealTraffic -and $AllowSeparateAccountProof -and $ConfirmInteractiveLoginComplete -and $failures.Count -eq 0)
if ($willRunRealSmoke) {
    $realSmokeArgs = @(
        "-AllowRealTraffic",
        "-WindowsUser", $WindowsUser,
        "-ReportRoot", $ReportRoot,
        "-ProfileRoot", $resolvedProfileRoot,
        "-StrictWindowsAppDataIsolation",
        "-AccountIsolationBoundary", "separate-windows-user",
        "-AllowSeparateAccountProof",
        "-AntiCodexAccountId", $effectiveAntiCodexAccountId,
        "-McpAccountId", $effectiveMcpAccountId,
        "-SeparateAccountProofApprovalId", $approvalIdTrimmed,
        "-Model", $Model,
        "-TimeoutSec", ([string]$TimeoutSec)
    )
    $realSmokeResult = Invoke-JsonScript -ScriptPath $realSmokeScript -Arguments $realSmokeArgs
    $realSmoke = $realSmokeResult.parsed
    if (-not $realSmokeResult.ok -or -not $realSmoke -or $realSmoke.ok -ne $true) {
        $failures.Add("real_smoke_proof_failed") | Out-Null
    }
}

$loginVerified = ($realSmoke -and $realSmoke.loginVerified -eq $true)
$separateAccountVerified = ($realSmoke -and $realSmoke.separateAccountVerified -eq $true)
$releaseAcceptableAccountProof = ($loginVerified -and $separateAccountVerified -and $realSmoke.accountIsolationBoundary -eq "separate-windows-user" -and $realSmoke.usedRealTraffic -eq $true)
$targetUserExists = if ($status) { [bool]$status.targetUserExists } else { $false }
$safeToAskUserForSecondAccountLogin = if ($status) { [bool]$status.safeToAskUserForSecondAccountLogin } else { $false }
$readinessBlockingReason = if ($status) { [string]$status.readinessBlockingReason } else { "status_unavailable" }
$canRunAfterInteractiveLogin = if ($status -and $status.postLoginProofPlan) { [bool]$status.postLoginProofPlan.canRunAfterInteractiveLogin } else { $false }
$proofCommandPreview = New-ProofCommandPreview -ResolvedProfileRoot $resolvedProfileRoot -HasAntiCodexId ([bool]$antiCodexAccountIdTrimmed) -HasMcpId ([bool]$effectiveMcpAccountId) -HasApproval ([bool]$approvalIdTrimmed)
$proofCommandPreviewWithSuggestedAntiCodexId = if ((-not $antiCodexAccountIdTrimmed) -and $effectiveAntiCodexAccountId) {
    New-ProofCommandPreview -ResolvedProfileRoot $resolvedProfileRoot -HasAntiCodexId $true -HasMcpId ([bool]$effectiveMcpAccountId) -HasApproval ([bool]$approvalIdTrimmed)
} else {
    $proofCommandPreview
}
$operatorActionCard = New-PostLoginProofOperatorActionCard `
    -TargetUserExists $targetUserExists `
    -SafeToAskUserForSecondAccountLogin $safeToAskUserForSecondAccountLogin `
    -CanRunAfterInteractiveLogin $canRunAfterInteractiveLogin `
    -ConfirmLogin ([bool]$ConfirmInteractiveLoginComplete) `
    -RealTrafficAllowed ([bool]$AllowRealTraffic) `
    -SeparateAccountProofAllowed ([bool]$AllowSeparateAccountProof) `
    -AntiCodexIdPresent ([bool]$effectiveAntiCodexAccountId) `
    -McpIdPresent ([bool]$effectiveMcpAccountId) `
    -AccountIdsDiffer ([bool]$accountIdsDiffer) `
    -ApprovalIdPresent ([bool]$approvalIdTrimmed) `
    -WillRunProofNow ([bool]$willRunRealSmoke) `
    -ProofAccepted ([bool]$releaseAcceptableAccountProof) `
    -ReadinessBlocker $readinessBlockingReason `
    -ProofCommand $proofCommandPreview
$payload = [ordered]@{
    ok = if ($AllowRealTraffic) { ($failures.Count -eq 0 -and $releaseAcceptableAccountProof) } else { ($failures.Count -eq 0) }
    reportName = "second-account-post-login-proof"
    noTraffic = (-not $AllowRealTraffic)
    requestedRealTraffic = [bool]$AllowRealTraffic
    usedRealTraffic = ($realSmoke -and $realSmoke.usedRealTraffic -eq $true)
    changedSystem = $false
    createdUser = $false
    capturesPassword = $false
    storesPassword = $false
    behaviorCovered = if ($AllowRealTraffic) { [bool]$releaseAcceptableAccountProof } else { $true }
    coverageKind = if ($AllowRealTraffic) { "second-account-post-login-proof-real-traffic" } else { "second-account-post-login-proof-dry-run" }
    windowsUser = $WindowsUser
    profileRoot = $resolvedProfileRoot
    allowSeparateAccountProof = [bool]$AllowSeparateAccountProof
    confirmInteractiveLoginComplete = [bool]$ConfirmInteractiveLoginComplete
    proofCommandPreview = $proofCommandPreview
    proofCommandPreviewWithSuggestedAntiCodexId = $proofCommandPreviewWithSuggestedAntiCodexId
    accountIdentityInputChecklist = $identityChecklist
    externalMcpAccountIdentityReport = $externalMcpIdentity
    operatorActionCard = $operatorActionCard
    proofInputs = [ordered]@{
        antiCodexAccountIdPresent = [bool]$antiCodexAccountIdTrimmed
        antiCodexAccountIdSuggested = [bool]$identityChecklist.antiCodexAccountId.suggestedAvailable
        effectiveAntiCodexAccountIdPresent = [bool]$effectiveAntiCodexAccountId
        mcpAccountIdPresent = [bool]$mcpAccountIdTrimmed
        mcpAccountIdFromExternalReport = [bool](((-not $mcpAccountIdTrimmed) -and $externalMcpIdentity.accepted -eq $true))
        effectiveMcpAccountIdPresent = [bool]$effectiveMcpAccountId
        separateAccountProofApprovalIdPresent = [bool]$approvalIdTrimmed
        accountIdsDiffer = [bool]$accountIdsDiffer
    }
    statusCompletionState = if ($status) { [string]$status.completionState } else { "status_unavailable" }
    targetUserExists = $targetUserExists
    safeToAskUserForSecondAccountLogin = $safeToAskUserForSecondAccountLogin
    readinessBlockingReason = $readinessBlockingReason
    operatorBlockingStage = if ($status) { [string]$status.operatorBlockingStage } else { "status_unavailable" }
    operatorNextStep = if ($status) { [string]$status.operatorNextStep } else { "rerun_account_isolation_status" }
    canRunAfterInteractiveLogin = $canRunAfterInteractiveLogin
    postLoginProofPlan = if ($status) { $status.postLoginProofPlan } else { $null }
    willRunRealSmoke = [bool]$willRunRealSmoke
    realSmokeExitCode = if ($realSmokeResult) { [int]$realSmokeResult.exitCode } else { $null }
    realSmokeReport = if ($realSmoke) { $realSmoke.report } else { $null }
    loginVerified = [bool]$loginVerified
    separateAccountVerified = [bool]$separateAccountVerified
    releaseAcceptableAccountProof = [bool]$releaseAcceptableAccountProof
    accountIdentityComparisonPresent = ($realSmoke -and $realSmoke.accountIdentityComparison -ne $null)
    accountIsolationBoundary = "separate-windows-user"
    accountIsolationCaveat = if ($AllowRealTraffic) { "Real proof is accepted only when the real-smoke report proves marker login and distinct account identity under the target Windows user." } else { "Dry-run only. This does not start login, use real traffic, capture passwords, or prove distinct Antigravity account identity." }
    failures = @($failures)
    warnings = @($warnings)
    elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
}
$payload["report"] = Save-PostLoginProofReport -Report $payload
$payload | ConvertTo-Json -Depth 24 -Compress
if (-not $payload.ok) { exit 1 }
