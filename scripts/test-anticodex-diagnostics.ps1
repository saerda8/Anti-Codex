[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [int]$TimeoutSec = 60,
    [switch]$VerifyBundle,
    [string]$VerifyReportsSummary = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports")
)

$ErrorActionPreference = "Stop"
$script:verifierStartedAt = [DateTime]::UtcNow
$RequiredWorkerMcpServers = @(
    "antigravity-code-worker",
    "deepseek-code-worker",
    "deveco-code-worker",
    "kilo-worker",
    "mimo-claude-coworker",
    "mimocode-worker",
    "opencode-worker"
)
$RequiredWorkerMcpTaskSmokePassedWorkers = 5
$RequiredWorkerMcpTaskSmokeWorkers = @(
    "deepseek-code-worker",
    "kilo-worker",
    "mimo-claude-coworker",
    "mimocode-worker",
    "opencode-worker"
)

if (-not $BaseUrl) {
    if (-not $VerifyReportsSummary) {
        $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
    }
}
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Get-RemainingVerifierBudgetMs {
    $elapsedMs = ([DateTime]::UtcNow - $script:verifierStartedAt).TotalMilliseconds
    return [Math]::Max(0, ($TimeoutSec * 1000) - [int]$elapsedMs)
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function As-FlatArray {
    param($Value)
    $items = @($Value)
    if ($items.Count -eq 1 -and $items[0] -is [array]) {
        return @($items[0])
    }
    return $items
}

function Assert-DistinctWorkerTransportFailures {
    param(
        [string]$Label,
        $Tools,
        [int]$MinimumCount = 3
    )
    $knownWorkerPrefixes = @(
        "antigravity",
        "deepseek",
        "deveco",
        "kilo",
        "mimo",
        "mimocode",
        "opencode"
    )
    $flatTools = @(As-FlatArray $Tools | ForEach-Object { [string]$_ } | Where-Object { $_ })
    $distinctTools = @($flatTools | Select-Object -Unique)
    if ($distinctTools.Count -lt $MinimumCount) {
        Add-Failure "$Label distinct failed worker tool count too low"
        return
    }

    $distinctWorkerPrefixes = @(
        $distinctTools |
            ForEach-Object {
                if ($_ -match "^([^_]+)_") { $Matches[1] }
            } |
            Where-Object { $knownWorkerPrefixes -contains $_ } |
            Select-Object -Unique
    )
    if ($distinctWorkerPrefixes.Count -lt $MinimumCount) {
        Add-Failure "$Label distinct failed worker namespace count too low"
    }
}

function Test-WindowsUserSetupGuidanceOperatorSetupPlan {
    param(
        $Evidence,
        [string]$Prefix
    )

    if (-not $Evidence) {
        Add-Failure "$Prefix missing windowsUserSetupGuidanceEvidence"
        return
    }
    if (-not (Has-Property $Evidence "operatorSetupPlan")) {
        Add-Failure "$Prefix missing operatorSetupPlan"
        return
    }
    $plan = $Evidence.operatorSetupPlan
    if (-not $plan) {
        Add-Failure "$Prefix operatorSetupPlan is empty"
        return
    }
    if ([string]$plan.targetLocalWindowsUser -ne "AntiCodexModel") { Add-Failure "$Prefix setup plan target mismatch" }
    if ([string]$plan.setupMode -ne "manual-only") { Add-Failure "$Prefix setup plan not manual-only" }
    if ([string]$plan.preferredSurface -ne "windows-settings-other-users") { Add-Failure "$Prefix setup plan surface mismatch" }
    if ($plan.antiCodexCreatesUser -ne $false) { Add-Failure "$Prefix setup plan creates users" }
    if ($plan.antiCodexOpensSettings -ne $false) { Add-Failure "$Prefix setup plan opens settings" }
    if ($plan.antiCodexStartsLogin -ne $false) { Add-Failure "$Prefix setup plan starts login" }
    if ($plan.antiCodexCapturesPassword -ne $false) { Add-Failure "$Prefix setup plan captures password" }
    if ($plan.antiCodexStoresPassword -ne $false) { Add-Failure "$Prefix setup plan stores password" }
    if ($plan.antiCodexUsesRealTraffic -ne $false) { Add-Failure "$Prefix setup plan uses real traffic" }
    if ($plan.rawUserManagementCommandProvided -ne $false) { Add-Failure "$Prefix setup plan provides raw user command" }
    $afterChecks = @($plan.afterManualSetupChecks | ForEach-Object { [string]$_ })
    $expectedAfterChecks = @("windows_user_account_prepare", "account_isolation_status")
    if ($afterChecks.Count -ne $expectedAfterChecks.Count) {
        Add-Failure "$Prefix setup plan after-checks mismatch"
    } else {
        for ($i = 0; $i -lt $expectedAfterChecks.Count; $i++) {
            if ($afterChecks[$i] -ne $expectedAfterChecks[$i]) {
                Add-Failure "$Prefix setup plan after-checks mismatch"
                break
            }
        }
    }
    $postManualCommands = @($plan.postManualSetupValidationCommands | ForEach-Object { [string]$_ } | Where-Object { $_ })
    if ($postManualCommands.Count -lt 3 -or -not (($postManualCommands -join "`n").Contains("test-anticodex-windows-user-account-prepare.ps1")) -or -not (($postManualCommands -join "`n").Contains("test-anticodex-antigravity-account-isolation-status.ps1")) -or -not (($postManualCommands -join "`n").Contains("start-anticodex-second-antigravity-account-login.ps1"))) {
        Add-Failure "$Prefix setup plan post-manual validation commands missing"
    }
    $postManualReadyFields = @($plan.postManualSetupRequiredReadyFields | ForEach-Object { [string]$_ } | Where-Object { $_ })
    foreach ($requiredField in @("targetUserExists:true", "targetWindowsUserSid:present", "targetUserIdentityBoundaryOk:true", "safeToAskUserForSecondAccountLogin:true", "canProceedToInteractiveLogin:true", "startedLogin:false", "usedRealTraffic:false")) {
        if ($postManualReadyFields -notcontains $requiredField) {
            Add-Failure "$Prefix setup plan post-manual ready field missing: $requiredField"
        }
    }
    if ([string]$plan.finalLoginEntrypoint -ne "start-anticodex-second-antigravity-account-login.ps1") { Add-Failure "$Prefix setup plan entrypoint mismatch" }
    if ([string]$plan.finalLoginApproval -ne "start-separate-windows-user-login") { Add-Failure "$Prefix setup plan approval mismatch" }
}

function Test-WindowsUserSettingsEntrypointEvidence {
    param(
        $Evidence,
        [string]$Prefix
    )

    if (-not $Evidence) {
        Add-Failure "$Prefix missing windowsUserSettingsEntrypointEvidence"
        return
    }
    if ($Evidence.reportName -ne "windows-user-settings-entrypoint") { Add-Failure "$Prefix reportName mismatch" }
    if ($Evidence.noTraffic -ne $true) { Add-Failure "$Prefix noTraffic mismatch" }
    if ($Evidence.usedRealTraffic -ne $false) { Add-Failure "$Prefix used real traffic" }
    if ($Evidence.coverageKind -ne "windows-user-settings-entrypoint-no-traffic") { Add-Failure "$Prefix coverage kind mismatch" }
    if ($Evidence.changedSystem -ne $false) { Add-Failure "$Prefix changed system" }
    if ($Evidence.createdUser -ne $false) { Add-Failure "$Prefix created user" }
    if ($Evidence.startedLogin -ne $false) { Add-Failure "$Prefix started login" }
    if ($Evidence.capturesPassword -ne $false) { Add-Failure "$Prefix captures password" }
    if ($Evidence.storesPassword -ne $false) { Add-Failure "$Prefix stores password" }
    if ($Evidence.runsSystemUserCommand -ne $false) { Add-Failure "$Prefix runs system user command" }
    if ($Evidence.requiredOpenSettingsApproval -ne "open-windows-user-settings-for-anticodex-second-account") { Add-Failure "$Prefix approval token mismatch" }
    if ($Evidence.settingsUri -ne "ms-settings:otherusers") { Add-Failure "$Prefix settings URI mismatch" }
    if ($Evidence.targetLocalWindowsUser -ne "AntiCodexModel") { Add-Failure "$Prefix target Windows user mismatch" }
    if (-not ([string]$Evidence.nextNoTrafficStatusCommand).Contains("test-anticodex-second-account-readiness-summary.ps1")) { Add-Failure "$Prefix next status command missing" }
    if (-not [string]$Evidence.accountIsolationCaveat) { Add-Failure "$Prefix caveat missing" }
}

function Test-SecondAccountLoginEntrypointSummaryEvidence {
    param($SecondAccountLoginEntrypointSummary)

    if (-not $SecondAccountLoginEntrypointSummary) {
        Add-Failure "diagnostic reports summary missing latest-second-antigravity-account-login-entrypoint.json"
        return
    }

    $evidence = $SecondAccountLoginEntrypointSummary.secondAccountLoginEntrypointEvidence
    if (-not $evidence) {
        Add-Failure "second-account entrypoint summary missing secondAccountLoginEntrypointEvidence"
        return
    }

    if ($evidence.reportName -ne "second-antigravity-account-login-entrypoint") { Add-Failure "second-account entrypoint summary reportName mismatch" }
    if ($evidence.noTraffic -ne $true) { Add-Failure "second-account entrypoint summary not marked no-traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "second-account entrypoint summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "second-account entrypoint summary behavior not covered" }
    if ($evidence.coverageKind -ne "second-account-login-entrypoint-no-traffic") { Add-Failure "second-account entrypoint summary coverage kind mismatch" }
    if ($evidence.statusOnlyOk -ne $true) { Add-Failure "second-account entrypoint summary status-only path failed" }
    if ($evidence.missingApprovalBlocked -ne $true) { Add-Failure "second-account entrypoint summary missing approval not blocked" }
    if ($evidence.approvedStartBlockedByStatusGate -ne $true) { Add-Failure "second-account entrypoint summary status gate not enforced" }
    if ($evidence.sameWindowsUserTargetBlocked -ne $true) { Add-Failure "second-account entrypoint summary same Windows user not blocked" }
    if ([string]$evidence.sameWindowsUserTargetBlockingReason -ne "target_windows_user_is_current_user") { Add-Failure "second-account entrypoint summary same Windows user reason mismatch" }
    if ($evidence.sameWindowsUserTargetStartedLogin -ne $false) { Add-Failure "second-account entrypoint summary same Windows user started login" }
    if ($evidence.sameWindowsUserTargetSafetyFieldsOk -ne $true) { Add-Failure "second-account entrypoint summary same Windows user safety fields missing" }
    if ($evidence.startedLogin -ne $false) { Add-Failure "second-account entrypoint summary started login early" }
    if ($evidence.changedSystem -ne $false) { Add-Failure "second-account entrypoint summary changed system" }
    if ($evidence.createdUser -ne $false) { Add-Failure "second-account entrypoint summary created user" }
    if ($evidence.capturesLoginOutput -ne $false) { Add-Failure "second-account entrypoint summary captures login output" }
    if ($evidence.capturesPassword -ne $false) { Add-Failure "second-account entrypoint summary captures password" }
    if ($evidence.storesPassword -ne $false) { Add-Failure "second-account entrypoint summary stores password" }
    if (-not ([string]$evidence.approvedLoginCommandTemplate).Contains("start-anticodex-second-antigravity-account-login.ps1") -or -not ([string]$evidence.approvedLoginCommandTemplate).Contains("-StartLoginApproval start-separate-windows-user-login")) {
        Add-Failure "second-account entrypoint summary approved login command missing"
    }
    if (-not ([string]$evidence.nextNoTrafficStatusCommand).Contains("test-anticodex-antigravity-account-isolation-status.ps1")) {
        Add-Failure "second-account entrypoint summary no-traffic status command missing"
    }
    if (-not ([string]$evidence.postLoginProofCommandTemplate).Contains("test-anticodex-antigravity-cli-real-smoke.ps1") -or -not ([string]$evidence.postLoginProofCommandTemplate).Contains("-AllowSeparateAccountProof") -or -not ([string]$evidence.postLoginProofCommandTemplate).Contains("-AccountIsolationBoundary separate-windows-user")) {
        Add-Failure "second-account entrypoint summary post-login proof command missing"
    }
    if (($evidence.canRunPostLoginProof -isnot [bool]) -and $null -eq $evidence.canRunPostLoginProof) {
        Add-Failure "second-account entrypoint summary post-login proof flag missing"
    }
    $postLoginProofPlan = $evidence.postLoginProofPlan
    if (-not $postLoginProofPlan) {
        Add-Failure "second-account entrypoint summary post-login proof plan missing"
    } else {
        if ([string]$postLoginProofPlan.proofScript -ne "test-anticodex-antigravity-cli-real-smoke.ps1") { Add-Failure "second-account entrypoint summary post-login proof script mismatch" }
        if ([string]$postLoginProofPlan.accountIsolationBoundary -ne "separate-windows-user") { Add-Failure "second-account entrypoint summary post-login proof boundary mismatch" }
        if ($postLoginProofPlan.requiresApprovedRealTraffic -ne $true) { Add-Failure "second-account entrypoint summary post-login proof real-traffic flag missing" }
        if ($postLoginProofPlan.requiresSeparateAccountProofApproval -ne $true) { Add-Failure "second-account entrypoint summary post-login proof approval flag missing" }
        if ($postLoginProofPlan.requiresDistinctAccountIdentityComparison -ne $true) { Add-Failure "second-account entrypoint summary post-login proof identity flag missing" }
        if ($postLoginProofPlan.accountIdsMustDiffer -ne $true) { Add-Failure "second-account entrypoint summary post-login proof account-diff flag missing" }
        if ($postLoginProofPlan.mcpAccountLaneManagedByAntiCodex -ne $false) { Add-Failure "second-account entrypoint summary post-login proof MCP owner flag mismatch" }
        if ([string]$postLoginProofPlan.mcpAccountLaneOwner -ne "external-antigravity-account-not-managed-here") { Add-Failure "second-account entrypoint summary post-login proof MCP owner mismatch" }
    }
    if ($evidence.separateAccountVerified -ne $false) { Add-Failure "second-account entrypoint summary claims separate account proof" }
    if ($evidence.loginVerified -ne $false) { Add-Failure "second-account entrypoint summary claims login proof" }
    if ($evidence.releaseAcceptableAccountProof -ne $false) { Add-Failure "second-account entrypoint summary claims release account proof" }
}

function Test-SecondAccountReadinessSummaryEvidence {
    param($SecondAccountReadinessSummary)

    if (-not $SecondAccountReadinessSummary) {
        Add-Failure "diagnostic reports summary missing latest-second-account-readiness-summary.json"
        return
    }

    $evidence = $SecondAccountReadinessSummary.secondAccountReadinessSummaryEvidence
    if (-not $evidence) {
        Add-Failure "second-account readiness summary missing secondAccountReadinessSummaryEvidence"
        return
    }

    if ($evidence.reportName -ne "second-account-readiness-summary") { Add-Failure "second-account readiness summary reportName mismatch" }
    if ($evidence.noTraffic -ne $true) { Add-Failure "second-account readiness summary not no-traffic" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "second-account readiness summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "second-account readiness summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "second-account readiness summary behavior not covered" }
    if ($evidence.coverageKind -ne "second-account-readiness-summary-no-traffic") { Add-Failure "second-account readiness summary coverage kind mismatch" }
    if ($evidence.changedSystem -ne $false) { Add-Failure "second-account readiness summary changed system" }
    if ($evidence.createdUser -ne $false) { Add-Failure "second-account readiness summary created user" }
    if ($evidence.startedLogin -ne $false) { Add-Failure "second-account readiness summary started login" }
    if ($evidence.capturesPassword -ne $false) { Add-Failure "second-account readiness summary captures password" }
    if ($evidence.storesPassword -ne $false) { Add-Failure "second-account readiness summary stores password" }
    if (-not [string]$evidence.currentWindowsUserSidPresent -and -not [string]$evidence.currentWindowsUserSid) { Add-Failure "second-account readiness summary current SID missing" }
    if ($evidence.targetUserSidMatchesCurrentUser -ne $false) { Add-Failure "second-account readiness summary target SID matches current user" }
    if ($evidence.targetUserIsCurrentUser -ne $false) { Add-Failure "second-account readiness summary target is current user" }
    if (($evidence.targetUserExists -eq $true -or $evidence.readyForOperatorLogin -eq $true -or $evidence.safeToAskUserForSecondAccountLogin -eq $true) -and $evidence.targetWindowsUserSidPresent -ne $true) {
        Add-Failure "second-account readiness summary target SID missing when user exists"
    }
    if (($evidence.readyForOperatorLogin -eq $true -or $evidence.safeToAskUserForSecondAccountLogin -eq $true) -and $evidence.targetUserIdentityBoundaryOk -ne $true) {
        Add-Failure "second-account readiness summary identity boundary unverified"
    }
    if ($evidence.readyForOperatorLogin -ne $false) { Add-Failure "second-account readiness summary ready too early" }
    if ($evidence.releaseAcceptableAccountProof -ne $false) { Add-Failure "second-account readiness summary claims account proof" }
    if ($evidence.goalComplete -ne $false) { Add-Failure "second-account readiness summary claims goal complete" }
    if (-not [string]$evidence.nextOperatorAction) { Add-Failure "second-account readiness summary missing next operator action" }
    $operatorActionCard = $evidence.operatorActionCard
    if (-not $operatorActionCard) { Add-Failure "second-account readiness summary operator action card missing" }
    else {
        if (-not [string]$operatorActionCard.status) { Add-Failure "second-account readiness summary operator action card status missing" }
        if (-not [string]$operatorActionCard.windowsUser) { Add-Failure "second-account readiness summary operator action card Windows user missing" }
        if ($operatorActionCard.canAskUserToLoginNow -ne $false) { Add-Failure "second-account readiness summary operator action card allows login too early" }
        if ($operatorActionCard.targetUserExists -ne $false) { Add-Failure "second-account readiness summary operator action card target user mismatch" }
        if ([string]$operatorActionCard.missingRequirement -ne "separate_windows_user_missing") { Add-Failure "second-account readiness summary operator action card missing requirement mismatch" }
        if (-not [string]$operatorActionCard.nextOperatorAction) { Add-Failure "second-account readiness summary operator action card next action missing" }
        if (-not [string]$operatorActionCard.userVisibleNextStep) { Add-Failure "second-account readiness summary operator action card user step missing" }
        if (-not ([string]$operatorActionCard.noTrafficStatusCommand).Contains("test-anticodex-second-account-readiness-summary.ps1")) { Add-Failure "second-account readiness summary operator action card status command missing" }
    }
    $summaryPostManualCommands = @($evidence.postManualSetupValidationCommands | ForEach-Object { [string]$_ } | Where-Object { $_ })
    if ($summaryPostManualCommands.Count -lt 3 -or -not (($summaryPostManualCommands -join "`n").Contains("test-anticodex-windows-user-account-prepare.ps1")) -or -not (($summaryPostManualCommands -join "`n").Contains("test-anticodex-antigravity-account-isolation-status.ps1")) -or -not (($summaryPostManualCommands -join "`n").Contains("start-anticodex-second-antigravity-account-login.ps1"))) {
        Add-Failure "second-account readiness summary post-manual validation commands missing"
    }
    $summaryPostManualReadyFields = @($evidence.postManualSetupRequiredReadyFields | ForEach-Object { [string]$_ } | Where-Object { $_ })
    foreach ($requiredField in @("targetUserExists:true", "targetWindowsUserSid:present", "targetUserIdentityBoundaryOk:true", "safeToAskUserForSecondAccountLogin:true", "canProceedToInteractiveLogin:true", "startedLogin:false", "usedRealTraffic:false")) {
        if ($summaryPostManualReadyFields -notcontains $requiredField) {
            Add-Failure "second-account readiness summary post-manual ready field missing: $requiredField"
        }
    }
    if (-not ([string]$evidence.approvedLoginCommandTemplate).Contains("start-anticodex-second-antigravity-account-login.ps1") -or -not ([string]$evidence.approvedLoginCommandTemplate).Contains("-StartLoginApproval start-separate-windows-user-login")) {
        Add-Failure "second-account readiness summary login command incomplete"
    }
    if (-not ([string]$evidence.nextNoTrafficStatusCommand).Contains("test-anticodex-antigravity-account-isolation-status.ps1")) {
        Add-Failure "second-account readiness summary status command incomplete"
    }
    if (-not ([string]$evidence.postLoginProofCommandTemplate).Contains("test-anticodex-antigravity-cli-real-smoke.ps1") -or -not ([string]$evidence.postLoginProofCommandTemplate).Contains("-AllowSeparateAccountProof") -or -not ([string]$evidence.postLoginProofCommandTemplate).Contains("SeparateAccountProofApprovalId")) {
        Add-Failure "second-account readiness summary proof command incomplete"
    }
    if ([int]$evidence.stepCount -lt 7) { Add-Failure "second-account readiness summary step count too low" }
    if ([int]$evidence.failedStepCount -ne 0) { Add-Failure "second-account readiness summary has failed steps" }
    if ([int]$evidence.failureCount -ne 0) { Add-Failure "second-account readiness summary has failures" }
    if (-not [string]$evidence.accountIsolationCaveat) { Add-Failure "second-account readiness summary caveat missing" }
}

function Test-SecondAccountPostLoginProofEvidence {
    param($SecondAccountPostLoginProofSummary)

    if (-not $SecondAccountPostLoginProofSummary) {
        Add-Failure "diagnostic reports summary missing latest-second-account-post-login-proof.json"
        return
    }

    $evidence = $SecondAccountPostLoginProofSummary.secondAccountPostLoginProofEvidence
    if (-not $evidence) {
        Add-Failure "second-account post-login proof missing secondAccountPostLoginProofEvidence"
        return
    }

    if ($evidence.reportName -ne "second-account-post-login-proof") { Add-Failure "second-account post-login proof reportName mismatch" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "second-account post-login proof behavior not covered" }
    if ($evidence.changedSystem -ne $false) { Add-Failure "second-account post-login proof changed system" }
    if ($evidence.createdUser -ne $false) { Add-Failure "second-account post-login proof created user" }
    if ($evidence.capturesPassword -ne $false) { Add-Failure "second-account post-login proof captures password" }
    if ($evidence.storesPassword -ne $false) { Add-Failure "second-account post-login proof stores password" }
    $isDryRun = (
        $evidence.noTraffic -eq $true -and
        $evidence.requestedRealTraffic -eq $false -and
        $evidence.usedRealTraffic -eq $false -and
        [string]$evidence.coverageKind -eq "second-account-post-login-proof-dry-run" -and
        $evidence.willRunRealSmoke -eq $false -and
        $evidence.loginVerified -eq $false -and
        $evidence.separateAccountVerified -eq $false -and
        $evidence.releaseAcceptableAccountProof -eq $false
    )
    $isRealProof = (
        $evidence.noTraffic -eq $false -and
        $evidence.requestedRealTraffic -eq $true -and
        $evidence.usedRealTraffic -eq $true -and
        [string]$evidence.coverageKind -eq "second-account-post-login-proof-real-traffic" -and
        $evidence.willRunRealSmoke -eq $true -and
        $evidence.loginVerified -eq $true -and
        $evidence.separateAccountVerified -eq $true -and
        $evidence.releaseAcceptableAccountProof -eq $true -and
        $evidence.accountIdentityComparisonPresent -eq $true
    )
    if (-not $isDryRun -and -not $isRealProof) { Add-Failure "second-account post-login proof is neither valid dry-run nor valid real proof" }
    if ($evidence.accountIdentityInputChecklistPresent -ne $true) { Add-Failure "second-account post-login proof identity input checklist missing" }
    if ($evidence.antiCodexAccountIdSuggestedAvailable -ne $true) { Add-Failure "second-account post-login proof Anti-Codex account suggestion missing" }
    if ($evidence.effectiveAntiCodexAccountIdPresent -ne $true) { Add-Failure "second-account post-login proof effective Anti-Codex account id missing" }
    if ($evidence.mcpAccountIdManagedByAntiCodex -ne $false) { Add-Failure "second-account post-login proof MCP account unexpectedly managed by Anti-Codex" }
    if ([string]$evidence.mcpAccountIdRequiredSource -ne "external-mcp-antigravity-account") { Add-Failure "second-account post-login proof MCP account source mismatch" }
    if ($evidence.externalMcpAccountIdentityReportPresent -eq $true -and $evidence.externalMcpAccountIdentityReportAccepted -ne $true) { Add-Failure "second-account post-login proof external MCP identity report rejected" }
    if ($evidence.approvalIdRequired -ne $true) { Add-Failure "second-account post-login proof approval id not required" }
    if ($isDryRun -and $evidence.allInputsReadyForProof -ne $false) { Add-Failure "second-account post-login proof dry-run inputs unexpectedly complete" }
    if ($isDryRun) {
        if ($evidence.targetUserExists -ne $false) { Add-Failure "second-account post-login proof target user unexpectedly exists in current dry-run" }
        if ($evidence.safeToAskUserForSecondAccountLogin -ne $false) { Add-Failure "second-account post-login proof allows login too early" }
        if ($evidence.canRunAfterInteractiveLogin -ne $false) { Add-Failure "second-account post-login proof can run too early" }
    }
    if ([string]$evidence.accountIsolationBoundary -ne "separate-windows-user") { Add-Failure "second-account post-login proof boundary mismatch" }
    $operatorActionCard = $evidence.operatorActionCard
    if (-not $operatorActionCard) { Add-Failure "second-account post-login proof operator action card missing" }
    else {
        $missingRequirements = @($operatorActionCard.missingRequirements | ForEach-Object { [string]$_ } | Where-Object { $_ })
        if (-not [string]$operatorActionCard.status) { Add-Failure "second-account post-login proof operator action card status missing" }
        if (-not [string]$operatorActionCard.windowsUser) { Add-Failure "second-account post-login proof operator action card Windows user missing" }
        if ($isDryRun -and $operatorActionCard.canRunPostLoginProofNow -ne $false) { Add-Failure "second-account post-login proof operator action card runs too early" }
        if ($isDryRun -and $operatorActionCard.targetUserExists -ne $false) { Add-Failure "second-account post-login proof operator action card target user mismatch" }
        if ($isDryRun -and $operatorActionCard.canAskUserToLoginNow -ne $false) { Add-Failure "second-account post-login proof operator action card allows login too early" }
        if ($isDryRun -and [string]$operatorActionCard.missingRequirement -ne "separate_windows_user_missing") { Add-Failure "second-account post-login proof operator action card missing requirement mismatch" }
        if ($isDryRun -and $missingRequirements -notcontains "separate_windows_user_missing") { Add-Failure "second-account post-login proof operator action card missing requirements mismatch" }
        if (-not [string]$operatorActionCard.nextOperatorAction) { Add-Failure "second-account post-login proof operator action card next action missing" }
        if (-not [string]$operatorActionCard.userVisibleNextStep) { Add-Failure "second-account post-login proof operator action card user step missing" }
        if (-not ([string]$operatorActionCard.noTrafficStatusCommand).Contains("test-anticodex-second-account-post-login-proof.ps1")) { Add-Failure "second-account post-login proof operator action card status command missing" }
        if (-not ([string]$operatorActionCard.proofCommandPreview).Contains("test-anticodex-antigravity-cli-real-smoke.ps1")) { Add-Failure "second-account post-login proof operator action card proof command missing" }
    }
    if (-not [string]$evidence.accountIsolationCaveat) { Add-Failure "second-account post-login proof caveat missing" }
}

function Test-ExternalMcpIdentityContractSummaryEvidence {
    param($ExternalMcpIdentityContractSummary)

    if (-not $ExternalMcpIdentityContractSummary) {
        Add-Failure "diagnostic reports summary missing latest-external-mcp-identity-contract.json"
        return
    }

    if ($ExternalMcpIdentityContractSummary.reportName -ne "external-mcp-identity-contract") { Add-Failure "external MCP identity contract reportName mismatch" }
    if ($ExternalMcpIdentityContractSummary.ok -ne $true) { Add-Failure "external MCP identity contract ok=false" }
    if ($ExternalMcpIdentityContractSummary.noTraffic -ne $true) { Add-Failure "external MCP identity contract noTraffic mismatch" }
    if ($ExternalMcpIdentityContractSummary.requestedRealTraffic -ne $false -or $ExternalMcpIdentityContractSummary.usedRealTraffic -ne $false) { Add-Failure "external MCP identity contract used real traffic" }
    if ($ExternalMcpIdentityContractSummary.changedSystem -ne $false -or $ExternalMcpIdentityContractSummary.createdUser -ne $false -or $ExternalMcpIdentityContractSummary.capturesPassword -ne $false -or $ExternalMcpIdentityContractSummary.storesPassword -ne $false) { Add-Failure "external MCP identity contract changed system or credentials" }
    if ($ExternalMcpIdentityContractSummary.behaviorCovered -ne $true) { Add-Failure "external MCP identity contract behavior not covered" }
    if ($ExternalMcpIdentityContractSummary.coverageKind -ne "external-mcp-identity-contract-no-traffic") { Add-Failure "external MCP identity contract coverage kind mismatch" }
    if ($ExternalMcpIdentityContractSummary.externalMcpIdentityAccepted -ne $true) { Add-Failure "external MCP identity contract identity not accepted" }
    if ($ExternalMcpIdentityContractSummary.mcpAccountIdFromExternalReport -ne $true) { Add-Failure "external MCP identity contract MCP id not sourced from report" }
    if ($ExternalMcpIdentityContractSummary.effectiveMcpAccountIdPresent -ne $true) { Add-Failure "external MCP identity contract effective MCP id missing" }
    if ($ExternalMcpIdentityContractSummary.mcpAccountLaneManagedByAntiCodex -ne $false) { Add-Failure "external MCP identity contract MCP account managed by Anti-Codex" }
    if ([string]$ExternalMcpIdentityContractSummary.mcpAccountRequiredSource -ne "external-mcp-antigravity-account") { Add-Failure "external MCP identity contract source mismatch" }
    if ($ExternalMcpIdentityContractSummary.operatorIdentityInputsClear -ne $true) { Add-Failure "external MCP identity contract operator identity inputs not clear" }
    if (@(As-FlatArray $ExternalMcpIdentityContractSummary.failures).Count -ne 0) { Add-Failure "external MCP identity contract has failures" }
}

function Get-NonNegativeIntProperty {
    param(
        $Value,
        [string]$Name,
        [string]$MissingMessage,
        [string]$InvalidMessage
    )
    if (-not (Has-Property $Value $Name)) {
        Add-Failure $MissingMessage
        return $null
    }
    $raw = $Value.PSObject.Properties[$Name].Value
    if ($null -eq $raw) {
        Add-Failure $InvalidMessage
        return $null
    }
    $text = [string]$raw
    $parsed = 0
    if (-not [int]::TryParse($text, [ref]$parsed) -or $parsed -lt 0) {
        Add-Failure $InvalidMessage
        return $null
    }
    return $parsed
}

function Find-TextHint {
    param(
        [string]$Text,
        [string[]]$Hints
    )
    foreach ($hint in $Hints) {
        if ($Text.Contains($hint)) {
            return $hint
        }
    }
    return ""
}

function Test-InstalledRuntimeEvidence {
    param($Evidence)

    if (-not $Evidence) {
        Add-Failure "release-gates summary missing installed runtime drift evidence"
        return
    }

    $sourceFileCount = Get-NonNegativeIntProperty $Evidence "sourceFileCount" "release-gates summary missing installed runtime source file count" "release-gates summary invalid installed runtime source file count"
    if ($null -ne $sourceFileCount -and $sourceFileCount -lt 1) { Add-Failure "release-gates summary missing installed runtime source file count" }
    $installedFileCount = Get-NonNegativeIntProperty $Evidence "installedRuntimeFileCount" "release-gates summary missing installed runtime target file count" "release-gates summary invalid installed runtime target file count"
    if ($null -ne $installedFileCount -and $installedFileCount -lt 1) { Add-Failure "release-gates summary missing installed runtime target file count" }
    if (-not [string]$Evidence.sourceFingerprint) { Add-Failure "release-gates summary missing installed runtime source fingerprint" }
    if (-not [string]$Evidence.installedRuntimeFingerprint) { Add-Failure "release-gates summary missing installed runtime target fingerprint" }
    if (-not (Has-Property $Evidence "satisfied")) { Add-Failure "release-gates summary missing installed runtime satisfied flag" }

    if ($Evidence.satisfied -eq $true) {
        if ([string]$Evidence.sourceFingerprint -ne [string]$Evidence.installedRuntimeFingerprint) {
            Add-Failure "release-gates summary reports installed runtime satisfied with mismatched fingerprints"
        }
        foreach ($driftField in @("missingSourceFiles", "missingInstalledRuntimeFiles", "mismatchedRuntimeFiles")) {
            if (-not (Has-Property $Evidence $driftField)) {
                Add-Failure "release-gates summary reports installed runtime satisfied without $driftField evidence"
            } elseif (@(As-FlatArray $Evidence.PSObject.Properties[$driftField].Value | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -ne 0) {
                Add-Failure "release-gates summary reports installed runtime satisfied with $driftField drift"
            }
        }
    }
}

function Test-ReleaseGateApprovalAndOfflineEvidence {
    param($ReleaseGatesSummary)

    $pluginCapabilityFailure = @($ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { $_.id -eq "pluginCapabilities" } | Select-Object -First 1)[0]
    if ($pluginCapabilityFailure) {
        $offlineSnapshotEvidence = $pluginCapabilityFailure.offlineSnapshotEvidence
        if (-not $offlineSnapshotEvidence) {
            Add-Failure "plugin capability failure missing offline snapshot evidence"
        } elseif ($offlineSnapshotEvidence.connectorContentMatches -ne $true -or $offlineSnapshotEvidence.appToolContentMatches -ne $true) {
            Add-Failure "plugin capability failure offline snapshot evidence is not clean"
        } else {
            if ($offlineSnapshotEvidence.refreshGateSatisfied -ne $true) {
                Add-Failure "plugin capability failure offline refresh gate is not satisfied"
            }
            if ([string]::IsNullOrWhiteSpace([string]$offlineSnapshotEvidence.refreshSelectedFile)) {
                Add-Failure "plugin capability failure offline refresh selected file missing"
            }
            if ([string]::IsNullOrWhiteSpace([string]$offlineSnapshotEvidence.sourceFingerprint)) {
                Add-Failure "plugin capability failure offline source fingerprint missing"
            }
            $offlineSourceFileCount = Get-NonNegativeIntProperty $offlineSnapshotEvidence "sourceFileCount" "plugin capability failure offline source file count missing" "plugin capability failure offline source file count invalid"
            if ($null -ne $offlineSourceFileCount -and $offlineSourceFileCount -lt 1) {
                Add-Failure "plugin capability failure offline source file count invalid"
            }
            if ([string]::IsNullOrWhiteSpace([string]$offlineSnapshotEvidence.sourceMtimeMax)) {
                Add-Failure "plugin capability failure offline source mtime missing"
            }
        }
        $pluginFailureSamples = @(As-FlatArray $pluginCapabilityFailure.reportFailureSamples | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        $pluginFailureCodes = @(As-FlatArray $pluginCapabilityFailure.reportFailureSampleCodes | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($pluginFailureSamples.Count -gt 0 -and $pluginFailureCodes.Count -lt 1) {
            Add-Failure "plugin capability failure missing sample codes"
        }
    }
    foreach ($gateFailure in @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons)) {
        $gateFailureId = [string]$gateFailure.id
        if ([string]::IsNullOrWhiteSpace($gateFailureId)) {
            $gateFailureId = "unknown"
        }
        $gateFailureSamples = @(As-FlatArray $gateFailure.reportFailureSamples | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        $gateFailureCodes = @(As-FlatArray $gateFailure.reportFailureSampleCodes | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($gateFailureSamples.Count -gt 0 -and $gateFailureCodes.Count -lt 1) {
            Add-Failure "release-gates failure $gateFailureId missing sample codes"
        }
        if (Has-Property $gateFailure "failureReasons") {
            $visibleFailureReasons = @(As-FlatArray $gateFailure.failureReasons | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
            $availableFailureReasons = Get-NonNegativeIntProperty $gateFailure "failureReasonsAvailableCount" "release-gates failure $gateFailureId missing failureReasons available count" "release-gates failure $gateFailureId invalid failureReasons available count"
            $hiddenFailureReasons = Get-NonNegativeIntProperty $gateFailure "failureReasonsHiddenCount" "release-gates failure $gateFailureId missing failureReasons hidden count" "release-gates failure $gateFailureId invalid failureReasons hidden count"
            if ($null -ne $availableFailureReasons -and $availableFailureReasons -lt $visibleFailureReasons.Count) {
                Add-Failure "release-gates failure $gateFailureId failureReasons available count is below visible reasons"
            }
            if ($null -ne $availableFailureReasons -and $null -ne $hiddenFailureReasons -and $hiddenFailureReasons -ne ($availableFailureReasons - $visibleFailureReasons.Count)) {
                Add-Failure "release-gates failure $gateFailureId failureReasons hidden count mismatch"
            }
        }
    }
    $semanticFailureEntryCount = 0
    foreach ($semanticFailure in @(As-FlatArray $ReleaseGatesSummary.releaseGateFailures)) {
        if (-not (Has-Property $semanticFailure "semanticFailures")) { continue }
        $semanticFailureId = [string]$semanticFailure.id
        if ([string]::IsNullOrWhiteSpace($semanticFailureId)) {
            $semanticFailureId = "unknown"
        }
        $visibleSemanticFailures = @(As-FlatArray $semanticFailure.semanticFailures | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($visibleSemanticFailures.Count -gt 0) {
            $semanticFailureEntryCount++
            $matchingSemanticReason = @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object {
                [string]$_.id -eq $semanticFailureId -and @(As-FlatArray $_.failureReasons | Where-Object { [string]$_ -eq "semantic_failures" }).Count -gt 0
            })
            if ($matchingSemanticReason.Count -lt 1) {
                Add-Failure "release-gates failure $semanticFailureId missing semantic failure reason marker"
            }
        }
        $availableSemanticFailures = Get-NonNegativeIntProperty $semanticFailure "semanticFailuresAvailableCount" "release-gates failure $semanticFailureId missing semanticFailures available count" "release-gates failure $semanticFailureId invalid semanticFailures available count"
        $hiddenSemanticFailures = Get-NonNegativeIntProperty $semanticFailure "semanticFailuresHiddenCount" "release-gates failure $semanticFailureId missing semanticFailures hidden count" "release-gates failure $semanticFailureId invalid semanticFailures hidden count"
        if ($null -ne $availableSemanticFailures -and $availableSemanticFailures -lt $visibleSemanticFailures.Count) {
            Add-Failure "release-gates failure $semanticFailureId semanticFailures available count is below visible failures"
        }
        if ($null -ne $availableSemanticFailures -and $null -ne $hiddenSemanticFailures -and $hiddenSemanticFailures -ne ($availableSemanticFailures - $visibleSemanticFailures.Count)) {
            Add-Failure "release-gates failure $semanticFailureId semanticFailures hidden count mismatch"
        }
    }
    foreach ($optionalFailureId in @(As-FlatArray $ReleaseGatesSummary.optionalRealTrafficFailures | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $optionalFailure = @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $optionalFailureId } | Select-Object -First 1)[0]
        if (-not $optionalFailure) {
            Add-Failure "release-gates optional real-traffic failure $optionalFailureId missing failure reason details"
        } elseif ([string]::IsNullOrWhiteSpace([string]$optionalFailure.guidance)) {
            Add-Failure "release-gates optional real-traffic failure $optionalFailureId missing guidance"
        }
    }
    $optionalRealTrafficFailureIds = @(As-FlatArray $ReleaseGatesSummary.optionalRealTrafficFailures | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($ReleaseGatesSummary.optionalRealTrafficReady -eq $true -and $optionalRealTrafficFailureIds.Count -gt 0) {
        Add-Failure "release-gates optional real-traffic ready has failures"
    }
    if ($ReleaseGatesSummary.strictOptionalRealTraffic -eq $true -and $ReleaseGatesSummary.optionalRealTrafficReady -ne $true -and $ReleaseGatesSummary.releaseReady -eq $true) {
        Add-Failure "release-gates releaseReady true while strict optional real-traffic is not ready"
    }
    if ($ReleaseGatesSummary.shortReady -eq $true -and @(As-FlatArray $ReleaseGatesSummary.missingShort | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
        Add-Failure "release-gates shortReady true with missing short gates"
    }
    if ($ReleaseGatesSummary.releaseReady -eq $true -and @(As-FlatArray $ReleaseGatesSummary.missingRequired | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
        Add-Failure "release-gates releaseReady true with missing required gates"
    }
    if ($ReleaseGatesSummary.effectiveOk -eq $true -and $ReleaseGatesSummary.releaseReady -ne $true) {
        Add-Failure "release-gates effectiveOk true while releaseReady is not true"
    }
    if ($ReleaseGatesSummary.effectiveOk -eq $true -and @(As-FlatArray $ReleaseGatesSummary.damagedReports | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
        Add-Failure "release-gates effectiveOk true with damaged reports"
    }
    if (-not (Has-Property $ReleaseGatesSummary "releaseBlockedOnlyByRequiredRealTraffic")) {
        Add-Failure "release-gates summary missing required real-traffic-only blocker flag"
    }
    if (-not (Has-Property $ReleaseGatesSummary "requiredRealTrafficBlockedGates")) {
        Add-Failure "release-gates summary missing required real-traffic blocker gate IDs"
    }
    foreach ($failureId in @(As-FlatArray $ReleaseGatesSummary.releaseGateFailures | ForEach-Object { if ($_.id) { [string]$_.id } else { [string]$_ } } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        if (@(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $failureId }).Count -lt 1) {
            Add-Failure "release-gates failure $failureId missing failure reason details"
        }
    }
    foreach ($damagedReportId in @(As-FlatArray $ReleaseGatesSummary.damagedReports | ForEach-Object { if ($_.id) { [string]$_.id } elseif ($_.file) { [string]$_.file } else { [string]$_ } } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        if (@(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $damagedReportId -or [string]$_.file -eq $damagedReportId -or [string]$_.selectedFile -eq $damagedReportId }).Count -lt 1) {
            Add-Failure "release-gates damaged report $damagedReportId missing failure reason details"
        }
    }
    if (-not (Has-Property $ReleaseGatesSummary "nextActions")) { Add-Failure "release-gates summary missing ordered next actions" }
    if (-not (Has-Property $ReleaseGatesSummary "approvalPlan")) { Add-Failure "release-gates summary missing approval plan" }
    $nextActions = @(As-FlatArray $ReleaseGatesSummary.nextActions)
    $nextActionsAvailableCount = Get-NonNegativeIntProperty $ReleaseGatesSummary "nextActionsAvailableCount" "release-gates summary missing nextActions available count" "release-gates summary invalid nextActions available count"
    $nextActionsHiddenCount = Get-NonNegativeIntProperty $ReleaseGatesSummary "nextActionsHiddenCount" "release-gates summary missing nextActions hidden count" "release-gates summary invalid nextActions hidden count"
    if ($null -ne $nextActionsAvailableCount -and $nextActionsAvailableCount -lt $nextActions.Count) {
        Add-Failure "release-gates summary nextActions available count is below visible actions"
    }
    if ($null -ne $nextActionsAvailableCount -and $null -ne $nextActionsHiddenCount -and $nextActionsHiddenCount -ne ($nextActionsAvailableCount - $nextActions.Count)) {
        Add-Failure "release-gates summary nextActions hidden count mismatch"
    }
    if (-not (Has-Property $ReleaseGatesSummary "nextActionsTruncated")) {
        Add-Failure "release-gates summary missing nextActions truncated flag"
    } elseif (($ReleaseGatesSummary.nextActionsTruncated -eq $true) -ne ($nextActionsHiddenCount -gt 0)) {
        Add-Failure "release-gates summary nextActions truncated flag mismatch"
    }
    $missingRequiredGates = @(As-FlatArray $ReleaseGatesSummary.missingRequired | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $requiredRealTrafficBlockedGates = @(As-FlatArray $ReleaseGatesSummary.requiredRealTrafficBlockedGates | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($ReleaseGatesSummary.releaseBlockedOnlyByRequiredRealTraffic -eq $true) {
        if ($ReleaseGatesSummary.shortReady -ne $true) { Add-Failure "release-gates real-traffic-only blocker flag set while shortReady is not true" }
        if (@(As-FlatArray $ReleaseGatesSummary.damagedReports | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) { Add-Failure "release-gates real-traffic-only blocker flag set with damaged reports" }
        if ($missingRequiredGates.Count -lt 1) { Add-Failure "release-gates real-traffic-only blocker flag set without missing required gates" }
        foreach ($missingGateId in $missingRequiredGates) {
            if ($requiredRealTrafficBlockedGates -notcontains $missingGateId) { Add-Failure "release-gates real-traffic-only blocker flag missing required gate $missingGateId" }
        }
        foreach ($blockedGateId in $requiredRealTrafficBlockedGates) {
            if ($missingRequiredGates -notcontains $blockedGateId) { Add-Failure "release-gates real-traffic-only blocker gate $blockedGateId is not a missing required gate" }
            $matchingActions = @($nextActions | Where-Object { [string]$_.id -eq $blockedGateId -or [string]$_.gateId -eq $blockedGateId })
            $actionable = @($matchingActions | Where-Object { $_.reportOnly -ne $true })
            if ($actionable.Count -lt 1) {
                Add-Failure "release-gates real-traffic-only blocker gate $blockedGateId has no actionable real-traffic action"
            } elseif (@($actionable | Where-Object { $_.requiresRealTraffic -ne $true -or $_.blockedUntilExplicitUserApproval -ne $true }).Count -gt 0) {
                Add-Failure "release-gates real-traffic-only blocker gate $blockedGateId has non-real-traffic or unblocked action"
            }
        }
    }
    foreach ($missingGateId in $missingRequiredGates) {
        $matchingActions = @($nextActions | Where-Object { [string]$_.id -eq $missingGateId -or [string]$_.gateId -eq $missingGateId })
        if ($matchingActions.Count -lt 1) {
            Add-Failure "release-gates missing required gate $missingGateId has no next action"
        }
        $matchingFailureReasons = @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $missingGateId })
        if ($matchingFailureReasons.Count -lt 1) {
            Add-Failure "release-gates missing required gate $missingGateId missing failure reason details"
        } elseif (@($matchingFailureReasons | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.guidance) }).Count -lt 1) {
            Add-Failure "release-gates missing required gate $missingGateId missing guidance"
        } elseif (@($matchingFailureReasons | Where-Object { $_.requiredForRelease -eq $true }).Count -lt 1) {
            Add-Failure "release-gates missing required gate $missingGateId missing required-for-release marker"
        }
    }
    foreach ($missingShortId in @(As-FlatArray $ReleaseGatesSummary.missingShort | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $matchingFailureReasons = @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $missingShortId })
        if ($matchingFailureReasons.Count -lt 1) {
            Add-Failure "release-gates missing short gate $missingShortId missing failure reason details"
        } elseif (@($matchingFailureReasons | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.guidance) }).Count -lt 1) {
            Add-Failure "release-gates missing short gate $missingShortId missing guidance"
        } elseif (@($matchingFailureReasons | Where-Object { $_.requiredForShort -eq $true }).Count -lt 1) {
            Add-Failure "release-gates missing short gate $missingShortId missing required-for-short marker"
        }
        if (@($nextActions | Where-Object { [string]$_.id -eq $missingShortId -or [string]$_.gateId -eq $missingShortId }).Count -lt 1) {
            Add-Failure "release-gates missing short gate $missingShortId missing next action"
        }
    }
    $missingOptionalGates = @(As-FlatArray $ReleaseGatesSummary.missingOptional | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($missingOptionalId in $missingOptionalGates) {
        $matchingFailureReasons = @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $missingOptionalId })
        if ($matchingFailureReasons.Count -lt 1) {
            Add-Failure "release-gates missing optional gate $missingOptionalId missing failure reason details"
        } elseif (@($matchingFailureReasons | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.guidance) }).Count -lt 1) {
            Add-Failure "release-gates missing optional gate $missingOptionalId missing guidance"
        } elseif (@($matchingFailureReasons | Where-Object { (Has-Property $_ "requiredForRelease") -and $_.requiredForRelease -ne $true }).Count -lt 1) {
            Add-Failure "release-gates missing optional gate $missingOptionalId missing optional marker"
        }
    }
    if (-not (Has-Property $ReleaseGatesSummary "releaseGateGroups")) {
        Add-Failure "release-gates summary missing release gate group evidence"
    } else {
        foreach ($releaseGateGroup in @(As-FlatArray $ReleaseGatesSummary.releaseGateGroups | Where-Object { $null -ne $_ })) {
            $groupName = [string]$releaseGateGroup.group
            if ([string]::IsNullOrWhiteSpace($groupName)) {
                $groupName = "unknown"
            }
            $groupTotal = Get-NonNegativeIntProperty $releaseGateGroup "total" "release-gates group $groupName missing total count" "release-gates group $groupName invalid total count"
            $groupSatisfied = Get-NonNegativeIntProperty $releaseGateGroup "satisfied" "release-gates group $groupName missing satisfied count" "release-gates group $groupName invalid satisfied count"
            $groupRequired = Get-NonNegativeIntProperty $releaseGateGroup "required" "release-gates group $groupName missing required count" "release-gates group $groupName invalid required count"
            $groupRequiredSatisfied = Get-NonNegativeIntProperty $releaseGateGroup "requiredSatisfied" "release-gates group $groupName missing required satisfied count" "release-gates group $groupName invalid required satisfied count"
            $groupOptional = Get-NonNegativeIntProperty $releaseGateGroup "optional" "release-gates group $groupName missing optional count" "release-gates group $groupName invalid optional count"
            $groupOptionalSatisfied = Get-NonNegativeIntProperty $releaseGateGroup "optionalSatisfied" "release-gates group $groupName missing optional satisfied count" "release-gates group $groupName invalid optional satisfied count"
            if ($null -ne $groupTotal -and $null -ne $groupSatisfied -and $groupSatisfied -gt $groupTotal) { Add-Failure "release-gates group $groupName satisfied count exceeds total" }
            if ($null -ne $groupRequired -and $null -ne $groupRequiredSatisfied -and $groupRequiredSatisfied -gt $groupRequired) { Add-Failure "release-gates group $groupName required satisfied count exceeds required" }
            if ($null -ne $groupOptional -and $null -ne $groupOptionalSatisfied -and $groupOptionalSatisfied -gt $groupOptional) { Add-Failure "release-gates group $groupName optional satisfied count exceeds optional" }
            if ($null -ne $groupTotal -and $null -ne $groupRequired -and $null -ne $groupOptional -and $groupTotal -ne ($groupRequired + $groupOptional)) { Add-Failure "release-gates group $groupName total count mismatch" }
            foreach ($groupMissingRequiredId in @(As-FlatArray $releaseGateGroup.missingRequired | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
                if ($missingRequiredGates -notcontains $groupMissingRequiredId) {
                    Add-Failure "release-gates group $groupName missing required gate $groupMissingRequiredId absent from top-level missingRequired"
                }
                if (@(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $groupMissingRequiredId }).Count -lt 1) {
                    Add-Failure "release-gates group $groupName missing required gate $groupMissingRequiredId missing failure reason details"
                }
                if (@($nextActions | Where-Object { [string]$_.id -eq $groupMissingRequiredId -or [string]$_.gateId -eq $groupMissingRequiredId }).Count -lt 1) {
                    Add-Failure "release-gates group $groupName missing required gate $groupMissingRequiredId has no next action"
                }
            }
            foreach ($groupMissingOptionalId in @(As-FlatArray $releaseGateGroup.missingOptional | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
                if ($missingOptionalGates -notcontains $groupMissingOptionalId) {
                    Add-Failure "release-gates group $groupName missing optional gate $groupMissingOptionalId absent from top-level missingOptional"
                }
                if (@(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $groupMissingOptionalId }).Count -lt 1) {
                    Add-Failure "release-gates group $groupName missing optional gate $groupMissingOptionalId missing failure reason details"
                }
            }
        }
    }
    $gatewayActionCount = 0
    $realTrafficActionCount = 0
    $highImpactActionCount = 0
    $reportOnlyActionCount = 0
    $requiredForShortActionCount = 0
    $requiredForReleaseActionCount = 0
    $blockedActionCount = 0
    $approvalBlockedRiskActionCount = 0
    $semanticFailureCount = @(
        As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons |
            Where-Object { @(As-FlatArray $_.failureReasons | Where-Object { [string]$_ -eq "semantic_failures" }).Count -gt 0 }
    ).Count
    $gatewayCommandHints = @(
        "start-deepcodex.ps1",
        "test-anticodex-missing-history.mjs",
        "test-anticodex-plugin-capabilities.ps1",
        "test-anticodex-manager-real-buttons.ps1",
        "test-anticodex-codex-responses.ps1",
        "test-anticodex-tool-loop.ps1",
        "test-anticodex-native-tool-loop.ps1",
        "test-anticodex-native-multi-tool-loop.ps1",
        "test-anticodex-mcp-tool-loop.ps1",
        "test-anticodex-custom-tool-loop.ps1",
        "test-anticodex-compaction-resume.ps1",
        "test-anticodex-cancellation.ps1",
        "test-anticodex-web-tools.ps1",
        "test-anticodex-real-mini-tool.ps1",
        "test-anticodex-real-work.ps1",
        "test-anticodex-real-small-project.ps1",
        "test-anticodex-post-verification.ps1",
        "test-anticodex-account-proxy-readiness.ps1",
        "test-anticodex-stability-soak.ps1",
        "test-anticodex-cold-relaunch.ps1"
    )
    $realTrafficCommandHints = @(
        "-allowrealtraffic",
        "test-anticodex-codex-responses.ps1",
        "test-anticodex-tool-loop.ps1",
        "test-anticodex-native-tool-loop.ps1",
        "test-anticodex-native-multi-tool-loop.ps1",
        "test-anticodex-mcp-tool-loop.ps1",
        "test-anticodex-custom-tool-loop.ps1",
        "test-anticodex-compaction-resume.ps1",
        "test-anticodex-cancellation.ps1",
        "test-anticodex-web-tools.ps1",
        "test-anticodex-real-mini-tool.ps1",
        "test-anticodex-real-work.ps1",
        "test-anticodex-real-small-project.ps1",
        "test-anticodex-post-verification.ps1",
        "test-anticodex-account-proxy-readiness.ps1",
        "test-anticodex-stability-soak.ps1"
    )
    $highImpactCommandHints = @(
        "-allowrealtraffic",
        "-confirmrelaunch",
        "sync-anticodex-launcher.ps1",
        "sync-anticodex.ps1",
        "test-anticodex-real-mini-tool.ps1",
        "test-anticodex-real-work.ps1",
        "test-anticodex-real-small-project.ps1",
        "test-anticodex-post-verification.ps1",
        "test-anticodex-stability-soak.ps1",
        "test-anticodex-cold-relaunch.ps1"
    )
    foreach ($nextAction in $nextActions) {
        $actionId = [string]$nextAction.id
        if ([string]::IsNullOrWhiteSpace($actionId)) {
            Add-Failure "release-gates next action missing id"
            $actionId = "unknown"
        }
        $requiresGateway = $nextAction.requiresGatewayStart -eq $true
        $requiresRealTraffic = $nextAction.requiresRealTraffic -eq $true
        $highImpact = $nextAction.highImpact -eq $true
        $blocked = $nextAction.blockedUntilExplicitUserApproval -eq $true
        if ([string]::IsNullOrWhiteSpace([string]$nextAction.command)) {
            Add-Failure "release-gates next action $actionId missing command"
        }
        if ($requiresGateway) { $gatewayActionCount++ }
        if ($requiresRealTraffic) { $realTrafficActionCount++ }
        if ($highImpact) { $highImpactActionCount++ }
        if ($nextAction.reportOnly -eq $true) { $reportOnlyActionCount++ }
        if ($nextAction.requiredForShort -eq $true) { $requiredForShortActionCount++ }
        if ($nextAction.requiredForRelease -eq $true) { $requiredForReleaseActionCount++ }
        if ($blocked) { $blockedActionCount++ }
        $commandText = ([string]$nextAction.command).ToLowerInvariant()
        if (-not [string]::IsNullOrWhiteSpace($commandText)) {
            $gatewayHint = Find-TextHint $commandText $gatewayCommandHints
            $realTrafficHint = Find-TextHint $commandText $realTrafficCommandHints
            $highImpactHint = Find-TextHint $commandText $highImpactCommandHints
            if (-not [string]::IsNullOrWhiteSpace($gatewayHint) -and -not $requiresGateway) {
                Add-Failure "release-gates next action $actionId command requires gateway metadata"
            }
            if (-not [string]::IsNullOrWhiteSpace($realTrafficHint) -and -not $requiresRealTraffic) {
                Add-Failure "release-gates next action $actionId command requires real-traffic metadata"
            }
            if (-not [string]::IsNullOrWhiteSpace($highImpactHint) -and -not $highImpact) {
                Add-Failure "release-gates next action $actionId command requires high-impact metadata"
            }
            if ((-not [string]::IsNullOrWhiteSpace($gatewayHint) -or -not [string]::IsNullOrWhiteSpace($realTrafficHint) -or -not [string]::IsNullOrWhiteSpace($highImpactHint)) -and -not $blocked) {
                Add-Failure "release-gates next action $actionId command risk missing explicit approval block"
            }
        }
        if ($requiresGateway -or $requiresRealTraffic -or $highImpact) { $approvalBlockedRiskActionCount++ }
        if (($requiresGateway -or $requiresRealTraffic -or $highImpact) -and -not $blocked) {
            Add-Failure "release-gates next action $actionId missing explicit approval block"
        }
        $reportOnly = $nextAction.reportOnly -eq $true
        if (($requiresGateway -or $requiresRealTraffic -or $highImpact -or $blocked -or $reportOnly) -and [string]::IsNullOrWhiteSpace([string]$nextAction.guidance)) {
            Add-Failure "release-gates next action $actionId missing guidance"
        }
        if (($requiresGateway -or $requiresRealTraffic -or $highImpact -or $blocked -or $reportOnly) -and [string]::IsNullOrWhiteSpace([string]$nextAction.reason)) {
            Add-Failure "release-gates next action $actionId missing reason"
        }
    }
    foreach ($gateFailure in @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons)) {
        $gateFailureId = [string]$gateFailure.id
        if ([string]::IsNullOrWhiteSpace($gateFailureId)) { $gateFailureId = "unknown" }
        if (-not (Has-Property $gateFailure "orderedActions")) { continue }
        $orderedActions = @(As-FlatArray $gateFailure.orderedActions | Where-Object { $null -ne $_ })
        if ($orderedActions.Count -gt 0 -and [string]::IsNullOrWhiteSpace([string]$gateFailure.guidance)) {
            Add-Failure "release-gates failure $gateFailureId with ordered actions missing guidance"
        }
        foreach ($orderedAction in $orderedActions) {
            $actionId = [string]$orderedAction.id
            if ([string]::IsNullOrWhiteSpace($actionId)) {
                Add-Failure "release-gates ordered action $gateFailureId missing id"
                $actionId = "unknown"
            }
            $requiresGateway = $orderedAction.requiresGatewayStart -eq $true
            $requiresRealTraffic = $orderedAction.requiresRealTraffic -eq $true
            $highImpact = $orderedAction.highImpact -eq $true
            $blocked = $orderedAction.blockedUntilExplicitUserApproval -eq $true
            $reportOnly = $orderedAction.reportOnly -eq $true
            $commandText = ([string]$orderedAction.command).ToLowerInvariant()
            if ([string]::IsNullOrWhiteSpace($commandText)) {
                Add-Failure "release-gates ordered action $gateFailureId/$actionId missing command"
            } else {
                $gatewayHint = Find-TextHint $commandText $gatewayCommandHints
                $realTrafficHint = Find-TextHint $commandText $realTrafficCommandHints
                $highImpactHint = Find-TextHint $commandText $highImpactCommandHints
                if (-not [string]::IsNullOrWhiteSpace($gatewayHint) -and -not $requiresGateway) {
                    Add-Failure "release-gates ordered action $gateFailureId/$actionId command requires gateway metadata"
                }
                if (-not [string]::IsNullOrWhiteSpace($realTrafficHint) -and -not $requiresRealTraffic) {
                    Add-Failure "release-gates ordered action $gateFailureId/$actionId command requires real-traffic metadata"
                }
                if (-not [string]::IsNullOrWhiteSpace($highImpactHint) -and -not $highImpact) {
                    Add-Failure "release-gates ordered action $gateFailureId/$actionId command requires high-impact metadata"
                }
                if ((-not [string]::IsNullOrWhiteSpace($gatewayHint) -or -not [string]::IsNullOrWhiteSpace($realTrafficHint) -or -not [string]::IsNullOrWhiteSpace($highImpactHint)) -and -not $blocked) {
                    Add-Failure "release-gates ordered action $gateFailureId/$actionId command risk missing explicit approval block"
                }
            }
            if (($requiresGateway -or $requiresRealTraffic -or $highImpact) -and -not $blocked) {
                Add-Failure "release-gates ordered action $gateFailureId/$actionId missing explicit approval block"
            }
            if (($requiresGateway -or $requiresRealTraffic -or $highImpact -or $blocked -or $reportOnly) -and [string]::IsNullOrWhiteSpace([string]$orderedAction.guidance)) {
                Add-Failure "release-gates ordered action $gateFailureId/$actionId missing guidance"
            }
            if (($requiresGateway -or $requiresRealTraffic -or $highImpact -or $blocked -or $reportOnly) -and [string]::IsNullOrWhiteSpace([string]$orderedAction.reason)) {
                Add-Failure "release-gates ordered action $gateFailureId/$actionId missing reason"
            }
        }
    }
    if (($semanticFailureCount + $semanticFailureEntryCount) -gt 0 -and @($nextActions | Where-Object { $_.reportOnly -eq $true -and [string]$_.id -eq "releaseGateReportOnlyCheck" }).Count -lt 1) {
        Add-Failure "release-gates semantic failures missing report-only next action"
    }
    $approvalPlan = $ReleaseGatesSummary.approvalPlan
    if (-not $approvalPlan -or $approvalPlan -isnot [pscustomobject]) {
        Add-Failure "release-gates approval plan is not an object"
    } else {
        $approvalActionCount = Get-NonNegativeIntProperty $approvalPlan "actionCount" "release-gates approval plan missing action count" "release-gates approval plan invalid action count"
        if ($null -ne $approvalActionCount -and $null -ne $nextActionsAvailableCount -and $approvalActionCount -ne $nextActionsAvailableCount) {
            Add-Failure "release-gates approval plan action count mismatch"
        }
        $approvalBlockedCount = Get-NonNegativeIntProperty $approvalPlan "blockedCount" "release-gates approval plan missing blocked count" "release-gates approval plan invalid blocked count"
        if ($null -ne $approvalBlockedCount -and $approvalBlockedCount -lt $blockedActionCount) { Add-Failure "release-gates approval plan undercounts blocked actions" }
        if ($null -ne $approvalBlockedCount -and $null -ne $approvalActionCount -and $approvalBlockedCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts blocked actions" }
        $approvalGatewayCount = Get-NonNegativeIntProperty $approvalPlan "requiresGatewayStartCount" "release-gates approval plan missing gateway count" "release-gates approval plan invalid gateway count"
        if ($null -ne $approvalGatewayCount -and $approvalGatewayCount -lt $gatewayActionCount) { Add-Failure "release-gates approval plan undercounts gateway actions" }
        if ($null -ne $approvalGatewayCount -and $null -ne $approvalActionCount -and $approvalGatewayCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts gateway actions" }
        $approvalRealTrafficCount = Get-NonNegativeIntProperty $approvalPlan "requiresRealTrafficCount" "release-gates approval plan missing real-traffic count" "release-gates approval plan invalid real-traffic count"
        if ($null -ne $approvalRealTrafficCount -and $approvalRealTrafficCount -lt $realTrafficActionCount) { Add-Failure "release-gates approval plan undercounts real-traffic actions" }
        if ($null -ne $approvalRealTrafficCount -and $null -ne $approvalActionCount -and $approvalRealTrafficCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts real-traffic actions" }
        $approvalHighImpactCount = Get-NonNegativeIntProperty $approvalPlan "highImpactCount" "release-gates approval plan missing high-impact count" "release-gates approval plan invalid high-impact count"
        if ($null -ne $approvalHighImpactCount -and $approvalHighImpactCount -lt $highImpactActionCount) { Add-Failure "release-gates approval plan undercounts high-impact actions" }
        if ($null -ne $approvalHighImpactCount -and $null -ne $approvalActionCount -and $approvalHighImpactCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts high-impact actions" }
        $approvalReportOnlyCount = Get-NonNegativeIntProperty $approvalPlan "reportOnlyCount" "release-gates approval plan missing report-only count" "release-gates approval plan invalid report-only count"
        if ($null -ne $approvalReportOnlyCount -and $approvalReportOnlyCount -lt $reportOnlyActionCount) { Add-Failure "release-gates approval plan undercounts report-only actions" }
        if ($null -ne $approvalReportOnlyCount -and $null -ne $approvalActionCount -and $approvalReportOnlyCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan report-only action count mismatch" }
        $approvalRequiredForShortCount = Get-NonNegativeIntProperty $approvalPlan "requiredForShortCount" "release-gates approval plan missing required-for-short count" "release-gates approval plan invalid required-for-short count"
        if ($null -ne $approvalRequiredForShortCount -and $approvalRequiredForShortCount -lt $requiredForShortActionCount) { Add-Failure "release-gates approval plan undercounts required-for-short actions" }
        if ($null -ne $approvalRequiredForShortCount -and $null -ne $approvalActionCount -and $approvalRequiredForShortCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts required-for-short actions" }
        $approvalRequiredForReleaseCount = Get-NonNegativeIntProperty $approvalPlan "requiredForReleaseCount" "release-gates approval plan missing required-for-release count" "release-gates approval plan invalid required-for-release count"
        if ($null -ne $approvalRequiredForReleaseCount -and $approvalRequiredForReleaseCount -lt $requiredForReleaseActionCount) { Add-Failure "release-gates approval plan undercounts required-for-release actions" }
        if ($null -ne $approvalRequiredForReleaseCount -and $null -ne $approvalActionCount -and $approvalRequiredForReleaseCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts required-for-release actions" }
        $approvalPhases = @()
        if (Has-Property $approvalPlan "phases") {
            $approvalPhases = @(As-FlatArray $approvalPlan.phases | Where-Object { $null -ne $_ })
        }
        if ($reportOnlyActionCount -gt 0 -and $approvalPhases.Count -gt 0) {
            $reportOnlyPhases = @($approvalPhases | Where-Object { [string]$_.phase -eq "report-only" })
            if ($reportOnlyPhases.Count -lt 1 -or @($reportOnlyPhases | Where-Object { $_.reportOnly -eq $true }).Count -lt 1) {
                Add-Failure "release-gates approval plan report-only phase mismatch"
            }
        }
        foreach ($approvalPhase in $approvalPhases) {
            $phaseName = [string]$approvalPhase.phase
            if ([string]::IsNullOrWhiteSpace($phaseName)) {
                Add-Failure "release-gates approval plan phase missing name"
                continue
            }
            $phaseActions = @($nextActions | Where-Object { [string]$_.phase -eq $phaseName })
            $phaseCount = Get-NonNegativeIntProperty $approvalPhase "count" "release-gates approval plan phase $phaseName missing count" "release-gates approval plan phase $phaseName invalid count"
            if ($null -ne $phaseCount -and $phaseCount -lt $phaseActions.Count) {
                Add-Failure "release-gates approval plan phase $phaseName count mismatch"
            }
            if ($null -ne $phaseCount -and $null -ne $approvalActionCount -and $phaseCount -gt $approvalActionCount) {
                Add-Failure "release-gates approval plan phase $phaseName count mismatch"
            }
            $expectedPhaseGateway = @($phaseActions | Where-Object { $_.requiresGatewayStart -eq $true }).Count -gt 0
            $expectedPhaseRealTraffic = @($phaseActions | Where-Object { $_.requiresRealTraffic -eq $true }).Count -gt 0
            $expectedPhaseHighImpact = @($phaseActions | Where-Object { $_.highImpact -eq $true }).Count -gt 0
            $expectedPhaseReportOnly = @($phaseActions | Where-Object { $_.reportOnly -eq $true }).Count -gt 0
            $expectedPhaseBlocked = @($phaseActions | Where-Object { $_.blockedUntilExplicitUserApproval -eq $true }).Count -gt 0
            if ($expectedPhaseGateway -and $approvalPhase.requiresGatewayStart -ne $true) { Add-Failure "release-gates approval plan phase $phaseName gateway mismatch" }
            if ($expectedPhaseRealTraffic -and $approvalPhase.requiresRealTraffic -ne $true) { Add-Failure "release-gates approval plan phase $phaseName real-traffic mismatch" }
            if ($expectedPhaseHighImpact -and $approvalPhase.highImpact -ne $true) { Add-Failure "release-gates approval plan phase $phaseName high-impact mismatch" }
            if ($expectedPhaseReportOnly -and $approvalPhase.reportOnly -ne $true) { Add-Failure "release-gates approval plan phase $phaseName report-only mismatch" }
            if ($expectedPhaseBlocked -and $approvalPhase.blockedUntilExplicitUserApproval -ne $true) { Add-Failure "release-gates approval plan phase $phaseName blocked mismatch" }
        }
        if (($blockedActionCount -gt 0 -or $approvalBlockedRiskActionCount -gt 0) -and [string]::IsNullOrWhiteSpace([string]$approvalPlan.firstBlockedAction)) {
            Add-Failure "release-gates approval plan missing first blocked action"
        }
        $firstBlockedAction = [string]$approvalPlan.firstBlockedAction
        if ($ReleaseGatesSummary.releaseBlockedOnlyByRequiredRealTraffic -eq $true -and -not [string]::IsNullOrWhiteSpace($firstBlockedAction)) {
            if ($firstBlockedAction -eq "startGatewayTranslatorOnly") {
                Add-Failure "release-gates real-traffic-only blocker approval plan points at gateway start"
            } elseif ($requiredRealTrafficBlockedGates -notcontains $firstBlockedAction) {
                Add-Failure "release-gates real-traffic-only blocker approval plan first action is not a required real-traffic gate"
            }
        }
    }
}

function Test-SyncReadinessEvidence {
    param(
        $SyncEvidence,
        [string]$Prefix,
        [bool]$RequireReady = $true
    )
    if (-not $SyncEvidence) {
        Add-Failure "$Prefix missing syncReadinessEvidence"
        return
    }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.sourcePackageVersion)) { Add-Failure "$Prefix missing source package version" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.activeSourcePackageVersion)) { Add-Failure "$Prefix missing active source package version" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.activePackageVersion)) { Add-Failure "$Prefix missing active package version" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.updateStatusReason)) { Add-Failure "$Prefix missing update status reason" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.sourceHostHash)) { Add-Failure "$Prefix missing source host hash" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.activeHostHash)) { Add-Failure "$Prefix missing active host hash" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.sourceCliHash)) { Add-Failure "$Prefix missing source CLI hash" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.activeCliHash)) { Add-Failure "$Prefix missing active CLI hash" }
    if (-not (Has-Property $SyncEvidence "hostHashMatches")) { Add-Failure "$Prefix missing host hash match flag" }
    if (-not (Has-Property $SyncEvidence "cliHashMatches")) { Add-Failure "$Prefix missing CLI hash match flag" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.clientSyncMode)) { Add-Failure "$Prefix missing client sync mode" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.clientSyncMaintenancePath)) { Add-Failure "$Prefix missing client sync maintenance path" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.sourcePackageName)) { Add-Failure "$Prefix missing source package name" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.activeSourcePackageName)) { Add-Failure "$Prefix missing active source package name" }
    if (-not (Has-Property $SyncEvidence "nativeClientBehaviorCarriedByHostSync")) { Add-Failure "$Prefix missing native client sync flag" }
    if (-not (Has-Property $SyncEvidence "forbidsFeatureByFeatureReimplementation")) { Add-Failure "$Prefix missing no feature-rebuild flag" }
    if (-not (Has-Property $SyncEvidence "clientSyncHostHashMatches")) { Add-Failure "$Prefix missing client sync host hash flag" }
    if (-not (Has-Property $SyncEvidence "clientSyncCliHashMatches")) { Add-Failure "$Prefix missing client sync CLI hash flag" }
    if (-not (Has-Property $SyncEvidence "clientSyncVersionMatches")) { Add-Failure "$Prefix missing client sync version match flag" }
    if (-not $SyncEvidence.antiCodexPatchScope -or @($SyncEvidence.antiCodexPatchScope).Count -lt 1) { Add-Failure "$Prefix missing Anti-Codex patch scope" }
    if ($RequireReady) {
        if ($SyncEvidence.clientSyncMode -ne "codex-client-copy-plus-anticodex-patches") { Add-Failure "$Prefix wrong client sync mode" }
        if ($SyncEvidence.clientSyncMaintenancePath -ne "guarded-host-sync-then-reapply-anticodex-patches") { Add-Failure "$Prefix wrong client sync maintenance path" }
        if ($SyncEvidence.nativeClientBehaviorCarriedByHostSync -ne $true) { Add-Failure "$Prefix does not prove native host sync carries client behavior" }
        if ($SyncEvidence.forbidsFeatureByFeatureReimplementation -ne $true) { Add-Failure "$Prefix does not reject feature-by-feature rebuild" }
        if ($SyncEvidence.clientSyncHostHashMatches -ne $true) { Add-Failure "$Prefix client sync host hash mismatch" }
        if ($SyncEvidence.clientSyncCliHashMatches -ne $true) { Add-Failure "$Prefix client sync CLI hash mismatch" }
        if ($SyncEvidence.clientSyncVersionMatches -ne $true) { Add-Failure "$Prefix client sync version mismatch" }
        $RequiredPatches = @("branding", "icons", "shortcuts", "isolation", "launcher", "model-adapter")
        $PatchScope = @($SyncEvidence.antiCodexPatchScope)
        foreach ($RequiredPatch in $RequiredPatches) {
            if ($PatchScope -notcontains $RequiredPatch) { Add-Failure "$Prefix missing required patch scope: $RequiredPatch" }
        }
        foreach ($Patch in $PatchScope) {
            if ($RequiredPatches -notcontains $Patch) { Add-Failure "$Prefix unexpected Anti-Codex patch scope: $Patch" }
        }
        if ($PatchScope.Count -ne $RequiredPatches.Count) { Add-Failure "$Prefix Anti-Codex patch scope is not exact" }
        if ($SyncEvidence.noTrafficReady -ne $true) { Add-Failure "$Prefix missing no-traffic attestation" }
        if ($SyncEvidence.fullMode -ne $true) { Add-Failure "$Prefix not full mode" }
        if ($SyncEvidence.activeHostReady -ne $true) { Add-Failure "$Prefix active host not ready" }
        if ($SyncEvidence.brandReady -ne $true) { Add-Failure "$Prefix brand not preserved" }
        if ($SyncEvidence.iconReady -ne $true) { Add-Failure "$Prefix icons not ready" }
        if ($SyncEvidence.syncScriptsReady -ne $true) { Add-Failure "$Prefix scripts not ready" }
        if ($SyncEvidence.updateReady -ne $true) { Add-Failure "$Prefix update status not synced" }
        if ($SyncEvidence.guardrailsReady -ne $true) { Add-Failure "$Prefix guardrails not ready" }
        if ([int]$SyncEvidence.shortcutCount -lt 5) { Add-Failure "$Prefix shortcut count too low" }
        if ([int]$SyncEvidence.shortcutReadyCount -ne [int]$SyncEvidence.shortcutCount) { Add-Failure "$Prefix shortcuts not ready" }
        if ([int]$SyncEvidence.desktopShortcutCount -ne 1) { Add-Failure "$Prefix desktop shortcut count wrong" }
        if ([int]$SyncEvidence.forbiddenDesktopHelperCount -ne 0) { Add-Failure "$Prefix has forbidden desktop helpers" }
        if ($SyncEvidence.managerBridgeReady -ne $true) { Add-Failure "$Prefix manager bridge not ready" }
        if ($SyncEvidence.cleanSyncState -ne $true) { Add-Failure "$Prefix sync state not clean" }
    }
}

$AllowedAntigravityModelDiscoverySources = @("antigravity-desktop-catalog", "antigravity-cli-catalog", "antigravity-entitlement-catalog")
$RequiredAgenticDesktopTaskSuiteTasks = @("coding-project", "multi-turn-project", "report-site", "complex-project", "autonomous-reasoning", "agentic-step-flow", "repo-multi-file-edit")

function Test-RefreshFeaturesSummarySupportEvidence {
    param($RefreshFeaturesSummary)
    if (-not $RefreshFeaturesSummary) { return }

    if (-not $RefreshFeaturesSummary.sourceSnapshotEvidence) { Add-Failure "refresh-features summary missing source snapshot evidence" }
    $refreshEvidence = $RefreshFeaturesSummary.refreshFeatureEvidence
    if (-not $refreshEvidence) {
        Add-Failure "refresh-features summary missing refreshFeatureEvidence"
        return
    }

    if (-not ($refreshEvidence.PSObject.Properties.Name -contains "recoveryActions")) { Add-Failure "refresh-features summary missing recoveryActions support evidence" }
    if (-not ($refreshEvidence.PSObject.Properties.Name -contains "recoveryActionIds")) { Add-Failure "refresh-features summary missing recoveryActionIds support evidence" }
    foreach ($recoveryAction in @($refreshEvidence.recoveryActions)) {
        if (-not [string]$recoveryAction.id) { Add-Failure "refresh-features recovery action missing id" }
        if (-not [string]$recoveryAction.guidance) { Add-Failure "refresh-features recovery action missing guidance" }
        if (@($recoveryAction.commands).Count -lt 1) { Add-Failure "refresh-features recovery action missing command guidance" }
        if ($recoveryAction.requiresRealTraffic -eq $true) { Add-Failure "refresh-features recovery action unexpectedly requires real traffic" }
    }

    if ($RefreshFeaturesSummary.ok -eq $true) {
        if (-not ($refreshEvidence.PSObject.Properties.Name -contains "elapsedMs")) { Add-Failure "refresh-features summary missing elapsedMs evidence" }
        if ($refreshEvidence.connectorSharedExists -eq $true -and $refreshEvidence.connectorContentMatches -ne $true) { Add-Failure "refresh-features summary connector parity not clean" }
        if ($refreshEvidence.appToolSharedExists -eq $true -and $refreshEvidence.appToolContentMatches -ne $true) { Add-Failure "refresh-features summary app-tool parity not clean" }
        if (@($refreshEvidence.changedExpectedSkills).Count -ne 0) { Add-Failure "refresh-features summary skill content parity not clean" }
        if (@($refreshEvidence.guidanceChanged).Count -ne 0) { Add-Failure "refresh-features summary guidance parity not clean" }
    }
}

function Test-DesktopTaskSuiteSummaryEvidence {
    param($DesktopTaskSuiteSummary)
    if (-not $DesktopTaskSuiteSummary) {
        Add-Failure "diagnostic reports summary missing latest-desktop-task-suite.json"
        return
    }

    $evidence = $DesktopTaskSuiteSummary.desktopTaskSuiteEvidence
    if (-not $evidence) {
        Add-Failure "desktop-task-suite summary missing desktopTaskSuiteEvidence"
        return
    }

    if ($evidence.reportName -ne "desktop-task-suite") { Add-Failure "desktop-task-suite summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "desktop-task-suite summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "desktop-task-suite summary used real traffic" }
    if ($evidence.dryRun -ne $true) { Add-Failure "desktop-task-suite summary is not dry-run" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "desktop-task-suite summary behavior not covered" }
    if ($evidence.coverageKind -ne "desktop-task-suite-dry-run") { Add-Failure "desktop-task-suite summary coverage kind mismatch" }
    if ($evidence.suiteProfile -ne "agentic") { Add-Failure "desktop-task-suite summary is not agentic profile" }
    if ($evidence.realTaskEvidenceComplete -ne $true) { Add-Failure "desktop-task-suite summary real task evidence is incomplete" }
    if ($evidence.realTaskEvidenceFresh -ne $true) { Add-Failure "desktop-task-suite summary real task evidence is not fresh" }
    if ([int]$evidence.realTaskEvidenceFailureCount -ne 0) { Add-Failure "desktop-task-suite summary has real task evidence failures" }
    if ([int]$evidence.realTaskEvidenceFreshnessFailureCount -ne 0) { Add-Failure "desktop-task-suite summary has freshness failures" }

    $plan = $evidence.realTaskEvidenceRefreshPlan
    if (-not $plan) {
        Add-Failure "desktop-task-suite summary missing refresh plan"
    } else {
        if ($plan.needed -ne $false) { Add-Failure "desktop-task-suite summary says refresh is needed" }
        if ($plan.requiresExplicitUserApproval -ne $false) { Add-Failure "desktop-task-suite summary unexpectedly requires approval" }
        if ($plan.commandPreviewPresent -ne $true) { Add-Failure "desktop-task-suite summary missing command preview" }
    }

    $selectedTasks = @(As-FlatArray $evidence.selectedTasks | ForEach-Object { [string]$_ })
    $taskEvidence = @(As-FlatArray $evidence.realTaskEvidenceTasks)
    foreach ($task in $RequiredAgenticDesktopTaskSuiteTasks) {
        if ($selectedTasks -notcontains $task) {
            Add-Failure "desktop-task-suite summary missing selected task $task"
        }
        $entry = @($taskEvidence | Where-Object { [string]$_.taskMode -eq $task } | Select-Object -First 1)[0]
        if (-not $entry) {
            Add-Failure "desktop-task-suite summary missing task evidence $task"
            continue
        }
        if ($entry.present -ne $true) { Add-Failure "desktop-task-suite summary task $task report missing" }
        if ($entry.parseable -ne $true) { Add-Failure "desktop-task-suite summary task $task report unparseable" }
        if ($entry.ok -ne $true) { Add-Failure "desktop-task-suite summary task $task not ok" }
        if ($entry.requestedRealTraffic -ne $true) { Add-Failure "desktop-task-suite summary task $task did not request real traffic" }
        if ($entry.usedRealTraffic -ne $true) { Add-Failure "desktop-task-suite summary task $task did not use real traffic" }
        if ($entry.fresh -ne $true) { Add-Failure "desktop-task-suite summary task $task is not fresh" }
        if ($entry.reportNameMatches -ne $true) { Add-Failure "desktop-task-suite summary task $task reportName mismatch" }
        if ($entry.taskModeMatches -ne $true) { Add-Failure "desktop-task-suite summary task $task taskMode mismatch" }
        if ([int]$entry.failureCount -ne 0) { Add-Failure "desktop-task-suite summary task $task has failures" }
    }
}

function Test-GoalReadinessSummaryEvidence {
    param($GoalReadinessSummary)
    if (-not $GoalReadinessSummary) {
        Add-Failure "diagnostic reports summary missing latest-goal-readiness.json"
        return
    }

    $evidence = $GoalReadinessSummary.goalReadinessEvidence
    if (-not $evidence) {
        Add-Failure "goal-readiness summary missing goalReadinessEvidence"
        return
    }

    if ($evidence.reportName -ne "goal-readiness") { Add-Failure "goal-readiness summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "goal-readiness summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "goal-readiness summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "goal-readiness summary behavior not covered" }
    if ($evidence.coverageKind -ne "goal-readiness-report-only") { Add-Failure "goal-readiness summary coverage kind mismatch" }
    if ($evidence.goalComplete -ne $true) { Add-Failure "goal-readiness summary current goal is not complete" }
    if ($evidence.codexClientCopyProven -ne $true) { Add-Failure "goal-readiness summary missing Codex client-copy proof" }
    if ($evidence.currentUsability) {
        if ($evidence.currentUsability.usableNow -ne $true) { Add-Failure "goal-readiness summary current usability not ready" }
        if ($evidence.currentUsability.requiresCurrentChannelWorkerMcp -ne $false) { Add-Failure "goal-readiness summary current usability still requires worker MCP" }
        if ($evidence.currentUsability.workerMcpTemporarilyDisabled -ne $true) { Add-Failure "goal-readiness summary current usability missing worker MCP deferred flag" }
    } else {
        Add-Failure "goal-readiness summary missing current usability evidence"
    }
    if ($evidence.workerMcpComplexProjectSmokeReportOk -ne $true) { Add-Failure "goal-readiness summary missing worker MCP complex-project smoke proof" }
    if ([string]$evidence.workerMcpComplexProjectSmokeScenario -ne "complex-project") { Add-Failure "goal-readiness summary worker MCP complex-project smoke scenario mismatch" }
    if ($evidence.workerMcpComplexProjectSmokeUsedRealTraffic -ne $true) { Add-Failure "goal-readiness summary worker MCP complex-project smoke real traffic missing" }
    if ($evidence.workerMcpComplexProjectSmokeAntigravityExcluded -ne $true) { Add-Failure "goal-readiness summary worker MCP complex-project smoke Antigravity exclusion missing" }
    if ([int]$evidence.workerMcpComplexProjectSmokePassedWorkerCount -lt 3) { Add-Failure "goal-readiness summary worker MCP complex-project smoke passed worker count too low" }
    $goalComplexWorkerNames = @(As-FlatArray $evidence.workerMcpComplexProjectSmokePassedWorkers | ForEach-Object { [string]$_ })
    foreach ($requiredXiaoqiangWorker in @("xiaoqiang1", "xiaoqiang2", "xiaoqiang3")) {
        if ($goalComplexWorkerNames -notcontains $requiredXiaoqiangWorker) { Add-Failure "goal-readiness summary worker MCP complex-project smoke missing Xiaoqiang worker $requiredXiaoqiangWorker" }
    }
    if (@(As-FlatArray $evidence.workerMcpComplexProjectSmokeFailedWorkers).Count -ne 0) { Add-Failure "goal-readiness summary worker MCP complex-project smoke failed workers" }
    if ($evidence.desktopAgenticTasksProven -ne $true) { Add-Failure "goal-readiness summary missing desktop agentic task proof" }
    if ($evidence.agenticCapabilityMatrixProven -ne $true) { Add-Failure "goal-readiness summary missing agentic capability matrix proof" }
    if ($evidence.realTaskCoverageRoadmapProven -ne $true) { Add-Failure "goal-readiness summary missing real-task coverage roadmap proof" }
    if ($evidence.longTaskLandingMatrixProven -ne $true) { Add-Failure "goal-readiness summary missing long-task landing matrix proof" }
    if ($evidence.realApprovalPlanProven -ne $true) { Add-Failure "goal-readiness summary missing real-approval plan proof" }
    if ($evidence.releaseShortPathProven -ne $true) { Add-Failure "goal-readiness summary missing short release proof" }
    if ($evidence.secondAccountLoginEntrypointProven -ne $true) { Add-Failure "goal-readiness summary missing second-account login entrypoint proof" }
    if ($evidence.secondAccountReadinessSummaryProven -ne $true) { Add-Failure "goal-readiness summary missing second-account readiness summary proof" }
    if ($evidence.secondAccountPostLoginProofProven -ne $true) { Add-Failure "goal-readiness summary missing second-account post-login proof report proof" }
    if ($evidence.accountIsolationPreparedOnly -ne $true) { Add-Failure "goal-readiness summary missing prepared-only account isolation proof" }
    if ([int]$evidence.objectiveRequirementTotal -ne 4) { Add-Failure "goal-readiness summary current objective requirement total mismatch" }
    if ([int]$evidence.objectiveRequirementCompleteCount -ne 4) { Add-Failure "goal-readiness summary current objective complete count mismatch" }
    if ([int]$evidence.objectiveRequirementIncompleteCount -ne 0) { Add-Failure "goal-readiness summary current objective incomplete count mismatch" }
    if ($evidence.objectiveRequirementCanClaimFullGoalNow -ne $true) { Add-Failure "goal-readiness summary current objective cannot be claimed" }
    if ([int]$evidence.fullObjectiveRequirementTotal -ne 6) { Add-Failure "goal-readiness summary full objective requirement total mismatch" }
    if ([int]$evidence.fullObjectiveRequirementCompleteCount -ne 4) { Add-Failure "goal-readiness summary full objective complete count mismatch" }
    if ([int]$evidence.fullObjectiveRequirementIncompleteCount -ne 2) { Add-Failure "goal-readiness summary full objective incomplete count mismatch" }
    if ($evidence.fullObjectiveRequirementCanClaimFullGoalNow -ne $false) { Add-Failure "goal-readiness summary full objective audit claims full goal" }
    $objectiveIncompleteIds = @(As-FlatArray $evidence.fullObjectiveRequirementIncompleteIds | ForEach-Object { [string]$_ })
    foreach ($expectedIncompleteObjective in @("separate_antigravity_accounts", "worker_mcp_multiuse")) {
        if ($objectiveIncompleteIds -notcontains $expectedIncompleteObjective) { Add-Failure "goal-readiness summary objective audit missing incomplete requirement: $expectedIncompleteObjective" }
    }
    if (@(As-FlatArray $evidence.objectiveRequirementAuditIds).Count -ne 4) { Add-Failure "goal-readiness summary current objective audit id count mismatch" }
    if (@(As-FlatArray $evidence.fullObjectiveRequirementAuditIds).Count -ne 6) { Add-Failure "goal-readiness summary full objective audit id count mismatch" }
    if ($evidence.shortReady -ne $true) { Add-Failure "goal-readiness summary short path not ready" }
    $goalOperatorActionCard = $evidence.goalOperatorActionCard
    if (-not $goalOperatorActionCard) { Add-Failure "goal-readiness summary operator action card missing" }
    else {
        if ([string]$goalOperatorActionCard.status -ne "goal_complete") { Add-Failure "goal-readiness summary operator action card status mismatch" }
        if ($goalOperatorActionCard.canClaimFullGoalNow -ne $true) { Add-Failure "goal-readiness summary operator action card does not claim current goal" }
        if ($goalOperatorActionCard.releaseReady -ne $true) { Add-Failure "goal-readiness summary operator action card release state mismatch" }
        if ($goalOperatorActionCard.requiresFreshCodexChannel -ne $false) { Add-Failure "goal-readiness summary operator action card still requires fresh channel for current goal" }
        if ($goalOperatorActionCard.requiresUserPresence -ne $false) { Add-Failure "goal-readiness summary operator action card still requires user presence for current goal" }
        if ($goalOperatorActionCard.canMakeUnattendedProgress -ne $true) { Add-Failure "goal-readiness summary operator action card unattended progress state mismatch" }
        $goalUnattendedActions = @(As-FlatArray $goalOperatorActionCard.unattendedSafeActions | ForEach-Object { [string]$_ })
        foreach ($requiredUnattendedAction in @("refresh_no_traffic_goal_readiness")) {
            if ($goalUnattendedActions -notcontains $requiredUnattendedAction) { Add-Failure "goal-readiness summary operator action card missing unattended action: $requiredUnattendedAction" }
        }
        $goalFreshChannelActions = @(As-FlatArray $goalOperatorActionCard.freshChannelRequiredActions | ForEach-Object { [string]$_ })
        if ($goalFreshChannelActions.Count -ne 0) { Add-Failure "goal-readiness summary operator action card has unexpected fresh-channel actions" }
        $goalUserPresenceActions = @(As-FlatArray $goalOperatorActionCard.userPresenceRequiredActions | ForEach-Object { [string]$_ })
        if ($goalUserPresenceActions.Count -ne 0) { Add-Failure "goal-readiness summary operator action card has unexpected user-presence actions" }
        if ([string]$goalOperatorActionCard.workerStatus -ne "fresh_probe_required") { Add-Failure "goal-readiness summary operator action card worker status mismatch" }
        if ($goalOperatorActionCard.workerCanDispatchCurrentChannel -ne $false) { Add-Failure "goal-readiness summary operator action card allows worker dispatch" }
        if ([string]$goalOperatorActionCard.secondAccountStatus -ne "manual_windows_user_setup_required") { Add-Failure "goal-readiness summary operator action card second-account status mismatch" }
        if ($goalOperatorActionCard.secondAccountCanAskUserToLoginNow -ne $false) { Add-Failure "goal-readiness summary operator action card allows second-account login too early" }
        $goalMissingRequirements = @(As-FlatArray $goalOperatorActionCard.missingRequirements | ForEach-Object { [string]$_ })
        if ($goalMissingRequirements.Count -ne 0) { Add-Failure "goal-readiness summary operator action card has unexpected missing requirements" }
        $goalNextActions = @(As-FlatArray $goalOperatorActionCard.nextOperatorActions | ForEach-Object { [string]$_ })
        if ($goalNextActions.Count -ne 0) { Add-Failure "goal-readiness summary operator action card has unexpected next actions" }
        if (-not ([string]$goalOperatorActionCard.noTrafficStatusCommand).Contains("test-anticodex-goal-readiness.mjs")) { Add-Failure "goal-readiness summary operator action card no-traffic command missing" }
        if (-not ([string]$goalOperatorActionCard.compactStatusCommand).Contains("--compact-status")) { Add-Failure "goal-readiness summary operator action card compact status command missing" }
        if (-not ([string]$goalOperatorActionCard.secondAccountStatusCommand).Contains("test-anticodex-second-account-readiness-summary.ps1")) { Add-Failure "goal-readiness summary operator action card second-account command missing" }
        if (-not ([string]$goalOperatorActionCard.secondAccountPostLoginProofCommand).Contains("test-anticodex-second-account-post-login-proof.ps1")) { Add-Failure "goal-readiness summary operator action card second-account post-login proof command missing" }
    }
    if ($evidence.currentChannelWorkerCanDispatch -ne $false) { Add-Failure "goal-readiness summary compact worker dispatch field is not blocked" }
    if ([string]$evidence.currentChannelWorkerTransportStatus -ne "fresh_probe_required") { Add-Failure "goal-readiness summary compact worker transport status mismatch" }
    if ($evidence.currentChannelWorkerRecoveryRequired -ne $true) { Add-Failure "goal-readiness summary compact worker recovery field missing" }
    if (-not [string]$evidence.secondAccountTargetWindowsUser) { Add-Failure "goal-readiness summary compact second-account target user missing" }
    if ($evidence.secondAccountTargetUserExists -ne $false) { Add-Failure "goal-readiness summary compact second-account target existence mismatch" }
    if ($evidence.secondAccountOperatorStatus -ne "manual_windows_user_setup_required") { Add-Failure "goal-readiness summary compact second-account operator status mismatch" }
    if (-not [string]$evidence.secondAccountNextOperatorAction) { Add-Failure "goal-readiness summary compact second-account next action missing" }
    $requiredBlockedGates = @(As-FlatArray $evidence.requiredRealTrafficBlockedGates)
    if ($evidence.releaseReady -eq $true) {
        if ($evidence.releaseBlockedOnlyByRequiredRealTraffic -ne $false) { Add-Failure "goal-readiness summary release-ready state still claims real-traffic-only blocker" }
        if ($requiredBlockedGates.Count -ne 0) { Add-Failure "goal-readiness summary release-ready state still has required real-traffic blocked gates" }
    } else {
        if ($evidence.releaseBlockedOnlyByRequiredRealTraffic -ne $true) { Add-Failure "goal-readiness summary missing real-traffic-only release blocker" }
        if ($requiredBlockedGates.Count -lt 1) { Add-Failure "goal-readiness summary missing required real-traffic blocked gates" }
    }
    if (@(As-FlatArray $evidence.workerMcpMissingServers).Count -ne 0) { Add-Failure "goal-readiness summary has missing worker MCP servers" }
    if ([int]$evidence.workerMcpPassedServerCount -lt $RequiredWorkerMcpServers.Count) { Add-Failure "goal-readiness summary worker MCP passed server count too low" }
    if (-not $evidence.workerMcpToolCountByServer) { Add-Failure "goal-readiness summary missing worker MCP tool counts" }
    else {
        foreach ($server in $RequiredWorkerMcpServers) {
            if ([int]$evidence.workerMcpToolCountByServer.$server -lt 1) { Add-Failure "goal-readiness summary missing worker MCP tool count for $server" }
        }
    }
    if (@(As-FlatArray $evidence.workerMcpIncompleteToolCountServers).Count -ne 0) { Add-Failure "goal-readiness summary has incomplete worker MCP tool counts" }
    if ($evidence.workerMcpStatusProbeReportOk -ne $true) { Add-Failure "goal-readiness summary missing worker MCP status probe ok evidence" }
    if ($evidence.workerMcpStatusProbeUsedRealTraffic -ne $false) { Add-Failure "goal-readiness summary worker MCP status probe used real traffic" }
    if ($evidence.workerMcpStatusProbeCoverageKind -ne "worker-mcp-direct-status-call-no-traffic") { Add-Failure "goal-readiness summary worker MCP status probe coverage kind mismatch" }
    if ([int]$evidence.workerMcpStatusProbeStatusCallOkCount -lt 6) { Add-Failure "goal-readiness summary worker MCP status probe ok count too low" }
    $goalStatusProbeWorkers = @(As-FlatArray $evidence.workerMcpStatusProbeStatusCallOkWorkers | ForEach-Object { [string]$_ })
    foreach ($requiredWorker in @("mimo-claude-coworker", "mimocode-worker", "kilo-worker", "opencode-worker", "deepseek-code-worker", "deveco-code-worker")) {
        if ($goalStatusProbeWorkers -notcontains $requiredWorker) { Add-Failure "goal-readiness summary missing worker MCP status probe worker $requiredWorker" }
    }
    if (@(As-FlatArray $evidence.workerMcpStatusProbeFailedWorkers).Count -ne 0) { Add-Failure "goal-readiness summary has failed worker MCP status probe workers" }
    if (@(As-FlatArray $evidence.workerMcpStatusProbeSkippedWorkers | Where-Object { [string]$_ -eq "antigravity-code-worker" }).Count -lt 1) { Add-Failure "goal-readiness summary missing Antigravity worker MCP status probe skip" }
    if ($evidence.workerMcpStatusProbeAntigravitySkippedForAccountIsolation -ne $true) { Add-Failure "goal-readiness summary missing status probe Antigravity account-isolation skip" }
    if ($evidence.workerMcpStatusProbeCurrentChannelCaveatPresent -ne $true) { Add-Failure "goal-readiness summary missing status probe current-channel caveat" }
    if ($evidence.workerMcpTaskSmokeReportOk -ne $true) { Add-Failure "goal-readiness summary missing worker MCP task smoke ok evidence" }
    if ($evidence.workerMcpTaskSmokeUsedRealTraffic -ne $true) { Add-Failure "goal-readiness summary missing worker MCP task smoke real-traffic evidence" }
    if ($evidence.workerMcpTaskSmokeAntigravityExcluded -ne $true) { Add-Failure "goal-readiness summary worker MCP task smoke did not exclude Antigravity" }
    if ([int]$evidence.workerMcpTaskSmokePassedWorkerCount -lt $RequiredWorkerMcpTaskSmokePassedWorkers) { Add-Failure "goal-readiness summary worker MCP task smoke passed worker count too low" }
    if (@(As-FlatArray $evidence.workerMcpTaskSmokePassedWorkers).Count -lt $RequiredWorkerMcpTaskSmokePassedWorkers) { Add-Failure "goal-readiness summary missing worker MCP task smoke passed workers" }
    $goalPassedWorkerNames = @(As-FlatArray $evidence.workerMcpTaskSmokePassedWorkers | ForEach-Object { [string]$_ })
    foreach ($requiredWorker in $RequiredWorkerMcpTaskSmokeWorkers) {
        if ($goalPassedWorkerNames -notcontains $requiredWorker) { Add-Failure "goal-readiness summary missing required worker MCP task smoke worker $requiredWorker" }
    }
    if (@(As-FlatArray $evidence.workerMcpTaskSmokeMissingRequiredWorkers).Count -ne 0) { Add-Failure "goal-readiness summary reports missing required worker MCP task smoke workers" }
    if (@(As-FlatArray $evidence.workerMcpTaskSmokeFailedWorkers).Count -ne 0) { Add-Failure "goal-readiness summary has failed worker MCP task smoke workers" }
    if ($evidence.workerMcpProjectSmokeReportOk -ne $true) { Add-Failure "goal-readiness summary missing worker MCP project smoke ok evidence" }
    if ($evidence.workerMcpProjectSmokeScenario -ne "project") { Add-Failure "goal-readiness summary worker MCP project smoke scenario mismatch" }
    if ($evidence.workerMcpProjectSmokeUsedRealTraffic -ne $true) { Add-Failure "goal-readiness summary missing worker MCP project smoke real-traffic evidence" }
    if ($evidence.workerMcpProjectSmokeAntigravityExcluded -ne $true) { Add-Failure "goal-readiness summary worker MCP project smoke did not exclude Antigravity" }
    if ([int]$evidence.workerMcpProjectSmokePassedWorkerCount -lt $RequiredWorkerMcpTaskSmokePassedWorkers) { Add-Failure "goal-readiness summary worker MCP project smoke passed worker count too low" }
    $goalProjectWorkerNames = @(As-FlatArray $evidence.workerMcpProjectSmokePassedWorkers | ForEach-Object { [string]$_ })
    foreach ($requiredWorker in $RequiredWorkerMcpTaskSmokeWorkers) {
        if ($goalProjectWorkerNames -notcontains $requiredWorker) { Add-Failure "goal-readiness summary missing required worker MCP project smoke worker $requiredWorker" }
    }
    if (@(As-FlatArray $evidence.workerMcpProjectSmokeMissingRequiredWorkers).Count -ne 0) { Add-Failure "goal-readiness summary reports missing required worker MCP project smoke workers" }
    if (@(As-FlatArray $evidence.workerMcpProjectSmokeFailedWorkers).Count -ne 0) { Add-Failure "goal-readiness summary has failed worker MCP project smoke workers" }
    if ($evidence.workerTransportRecoveryOk -ne $false) { Add-Failure "goal-readiness summary unexpectedly marks worker transport recovered" }
    if ($evidence.workerTransportRecoveryCanDispatch -ne $false) { Add-Failure "goal-readiness summary unexpectedly allows current-channel worker dispatch" }
    if ($evidence.workerTransportRecoveryRequiresCodexMcpReload -ne $true) { Add-Failure "goal-readiness summary missing worker transport reload requirement" }
    if ($evidence.workerTransportRecoveryRequiresFreshReadOnlyProbe -ne $true) { Add-Failure "goal-readiness summary missing fresh read-only worker probe requirement" }
    if ([string]$evidence.workerTransportRecoveryBlockingReason -ne "current_channel_worker_transport_probe_stale") { Add-Failure "goal-readiness summary worker transport recovery blocker mismatch" }
    if (-not ([string]$evidence.workerTransportRecoverySafeToDispatchRule).Contains("read-only worker status call succeeds")) { Add-Failure "goal-readiness summary worker transport dispatch rule missing" }
    if ([string]$evidence.workerTransportRecoveryCurrentChannelWorkerStatus -ne "failed") { Add-Failure "goal-readiness summary worker transport status mismatch" }
    if ([int]$evidence.workerTransportRecoveryCurrentChannelWorkerObservationCount -lt 3) { Add-Failure "goal-readiness summary worker transport observation count too low" }
    if ([int]$evidence.workerTransportRecoveryCurrentChannelWorkerTransportFailedCount -lt 3) { Add-Failure "goal-readiness summary worker transport failed count too low" }
    $recoveryFailedTools = @(As-FlatArray $evidence.workerTransportRecoveryCurrentChannelWorkerTransportFailedTools | ForEach-Object { [string]$_ })
    Assert-DistinctWorkerTransportFailures -Label "goal-readiness summary worker transport" -Tools $recoveryFailedTools
    if ([string]$evidence.workerTransportRecoveryCurrentChannelGenericMcpStatus -ne "ok") { Add-Failure "goal-readiness summary generic MCP status missing from worker recovery" }
    if ($evidence.workerTransportRecoveryCurrentChannelSplitObserved -ne $true) { Add-Failure "goal-readiness summary worker transport split not proven" }
    if ($evidence.workerTransportRecoveryDirectProbeOk -ne $true) { Add-Failure "goal-readiness summary worker transport direct probe missing" }
    if ([int]$evidence.workerTransportRecoveryDirectProbePassedServerCount -lt $RequiredWorkerMcpServers.Count) { Add-Failure "goal-readiness summary worker transport direct probe server count too low" }
    if (-not ([string]$evidence.workerTransportRecoveryOperatorRecoveryAction).Contains("reload")) { Add-Failure "goal-readiness summary worker transport recovery action missing" }
    if (-not ([string]$evidence.workerTransportRecoveryPostReloadVerification).Contains("read-only")) { Add-Failure "goal-readiness summary worker transport post-reload verification missing" }
    if (-not ([string]$evidence.workerTransportRecoveryDirectWorkerProbeCommand).Contains("probe-anticodex-worker-mcp-servers.mjs")) { Add-Failure "goal-readiness summary worker transport direct probe command missing" }
    if (-not ([string]$evidence.workerTransportRecoveryCurrentChannelReadOnlyProbeInstruction).Contains("read-only")) { Add-Failure "goal-readiness summary worker transport read-only instruction missing" }
    if (-not ([string]$evidence.workerTransportRecoveryCurrentChannelRecoveryRecordCommand).Contains("record-anticodex-current-channel-worker-transport.mjs")) { Add-Failure "goal-readiness summary worker transport record command missing" }
    $goalRecommendedProbes = @(As-FlatArray $evidence.workerTransportRecoveryRecommendedReadOnlyProbes)
    if ($goalRecommendedProbes.Count -lt 3) { Add-Failure "goal-readiness summary missing worker recovery recommended read-only probes" }
    $goalRecommendedTools = @($goalRecommendedProbes | ForEach-Object { [string]$_.statusTool } | Where-Object { $_ })
    if ($goalRecommendedTools -notcontains "kilo_wait_for_job") { Add-Failure "goal-readiness summary missing Kilo recommended read-only probe" }
    if ($goalRecommendedTools -notcontains "deepseek_wait_for_job") { Add-Failure "goal-readiness summary missing DeepSeek recommended read-only probe" }
    if ($goalRecommendedTools -notcontains "opencode_wait_for_job") { Add-Failure "goal-readiness summary missing OpenCode recommended read-only probe" }
    $goalExposedRecommendedProbes = @(As-FlatArray $evidence.workerTransportRecoveryExposedRecommendedReadOnlyProbes)
    if ($goalExposedRecommendedProbes.Count -lt 1) { Add-Failure "goal-readiness summary missing exposed recommended read-only probes" }
    $goalExposedRecommendedTools = @($goalExposedRecommendedProbes | ForEach-Object { [string]$_.statusTool } | Where-Object { $_ })
    if (-not $evidence.workerTransportRecoveryRecommendedFirstReadOnlyProbe -or -not [string]$evidence.workerTransportRecoveryRecommendedFirstReadOnlyProbe.statusTool) {
        Add-Failure "goal-readiness summary missing first worker recovery recommended read-only probe"
    } elseif ($goalExposedRecommendedTools.Count -gt 0 -and $goalExposedRecommendedTools -notcontains ([string]$evidence.workerTransportRecoveryRecommendedFirstReadOnlyProbe.statusTool)) {
        Add-Failure "goal-readiness summary first worker recovery probe is not from exposed candidates"
    }
    if (@(As-FlatArray $evidence.workerTransportRecoveryNextActions).Count -lt 3) { Add-Failure "goal-readiness summary worker transport next actions missing" }
    if (@(As-FlatArray $evidence.desktopMissingAgenticTasks).Count -ne 0) { Add-Failure "goal-readiness summary has missing desktop agentic tasks" }
    if (@(As-FlatArray $evidence.agenticMissingCapabilities).Count -ne 0) { Add-Failure "goal-readiness summary has missing agentic capabilities" }
    if (@(As-FlatArray $evidence.agenticStaleCapabilities).Count -ne 0) { Add-Failure "goal-readiness summary has stale agentic capabilities" }
    if ([int]$evidence.agenticOkCapabilityCount -lt 5) { Add-Failure "goal-readiness summary agentic capability count too low" }
    if (@(As-FlatArray $evidence.realTaskCoverageMissingProfiles).Count -ne 0) { Add-Failure "goal-readiness summary has missing real-task coverage profiles" }
    if (@(As-FlatArray $evidence.realTaskCoverageCompleteProfiles).Count -lt 2) { Add-Failure "goal-readiness summary has too few complete real-task coverage profiles" }
    if ([int]$evidence.realTaskCoverageArtifactProofTaskCount -lt 5) { Add-Failure "goal-readiness summary missing real-task artifact proof coverage" }
    if ($null -eq $evidence.realTaskCoverageMissingArtifactProofTaskCount) { Add-Failure "goal-readiness summary missing real-task artifact proof count" }
    if ([int]$evidence.realTaskCoverageMissingArtifactProofTaskCount -ne 0) { Add-Failure "goal-readiness summary has missing real-task artifact proofs" }
    if (@(As-FlatArray $evidence.realTaskCoverageMissingArtifactProofTasks).Count -ne 0) { Add-Failure "goal-readiness summary has missing real-task artifact proof tasks" }
    if ($evidence.realTaskCoverageArtifactProofComplete -ne $true) { Add-Failure "goal-readiness summary real-task artifact proof incomplete" }
    if ([int]$evidence.realTaskCoverageResultProofTaskCount -lt 9) { Add-Failure "goal-readiness summary missing real-task result proof coverage" }
    if ($null -eq $evidence.realTaskCoverageMissingResultProofTaskCount) { Add-Failure "goal-readiness summary missing real-task result proof count" }
    if ([int]$evidence.realTaskCoverageMissingResultProofTaskCount -ne 0) { Add-Failure "goal-readiness summary has missing real-task result proofs" }
    if (@(As-FlatArray $evidence.realTaskCoverageMissingResultProofTasks).Count -ne 0) { Add-Failure "goal-readiness summary has missing real-task result proof tasks" }
    if ($evidence.realTaskCoverageResultProofComplete -ne $true) { Add-Failure "goal-readiness summary real-task result proof incomplete" }
    $realTaskRefreshBlockers = @(As-FlatArray $evidence.realTaskCoverageNextProfilesNeedingRealTraffic)
    if ($evidence.realTaskCoverageApprovalRequiredForRefresh -eq $true -and $realTaskRefreshBlockers.Count -lt 1) { Add-Failure "goal-readiness summary missing real-task coverage refresh blockers" }
    $realTaskUniqueRefreshTasks = @(As-FlatArray $evidence.realTaskCoverageUniqueRefreshTasks)
    if ($evidence.realTaskCoverageApprovalRequiredForRefresh -eq $true -and $realTaskUniqueRefreshTasks.Count -lt 1) { Add-Failure "goal-readiness summary missing real-task coverage unique refresh tasks" }
    if ($evidence.realTaskCoverageApprovalRequiredForRefresh -eq $true -and $evidence.realTaskCoverageMinimalRefreshCommandPresent -ne $true) { Add-Failure "goal-readiness summary missing real-task coverage minimal refresh command" }
    if ($evidence.realTaskCoverageApprovalRequiredForRefresh -eq $true -and $evidence.realTaskCoverageMinimalRefreshCommandRequiresRealTraffic -ne $true) { Add-Failure "goal-readiness summary minimal refresh command is not marked real traffic" }
    if ($null -eq $evidence.realTaskCoverageApprovalRequiredForRefresh) { Add-Failure "goal-readiness summary missing real-task coverage approval requirement" }
    if ($evidence.releaseReady -eq $true) {
        if ([int]$evidence.realApprovalPlanRequiredReleaseActionCount -ne 0) { Add-Failure "goal-readiness summary release-ready state still has required real-approval release actions" }
    } elseif ([int]$evidence.realApprovalPlanRequiredReleaseActionCount -lt 1) {
        Add-Failure "goal-readiness summary missing required real-approval release actions"
    }
    if ($null -eq $evidence.realApprovalPlanOptionalReleaseActionCount) { Add-Failure "goal-readiness summary missing optional real-approval action count" }
    if (-not [string]$evidence.realApprovalPlanNextNoTrafficAction) { Add-Failure "goal-readiness summary missing real-approval next no-traffic action" }
    if ($evidence.accountReleaseAcceptableProof -ne $false) { Add-Failure "goal-readiness summary account proof unexpectedly acceptable" }
    if (-not [string]$evidence.accountCompletionState) { Add-Failure "goal-readiness summary missing account completion state" }
    if (-not [string]$evidence.accountBlockingReason) { Add-Failure "goal-readiness summary missing account blocking reason" }
    if ($evidence.secondAccountLoginEntrypointReportName -ne "second-antigravity-account-login-entrypoint") { Add-Failure "goal-readiness summary second-account entrypoint report name mismatch" }
    if ($evidence.secondAccountLoginEntrypointNoTraffic -ne $true) { Add-Failure "goal-readiness summary second-account entrypoint not no-traffic" }
    if ($evidence.secondAccountLoginEntrypointUsedRealTraffic -ne $false) { Add-Failure "goal-readiness summary second-account entrypoint used real traffic" }
    if ($evidence.secondAccountLoginEntrypointCoverageKind -ne "second-account-login-entrypoint-no-traffic") { Add-Failure "goal-readiness summary second-account entrypoint coverage kind mismatch" }
    if ($evidence.secondAccountLoginEntrypointStatusOnlyOk -ne $true) { Add-Failure "goal-readiness summary second-account entrypoint status-only check missing" }
    if ($evidence.secondAccountLoginEntrypointMissingApprovalBlocked -ne $true) { Add-Failure "goal-readiness summary second-account entrypoint missing-approval guard missing" }
    if ($evidence.secondAccountLoginEntrypointApprovedStartBlockedByStatusGate -ne $true) { Add-Failure "goal-readiness summary second-account entrypoint status gate guard missing" }
    if ($evidence.secondAccountLoginEntrypointSameWindowsUserTargetBlocked -ne $true) { Add-Failure "goal-readiness summary second-account entrypoint same-user guard missing" }
    if (-not ([string]$evidence.secondAccountLoginEntrypointApprovedLoginCommandTemplate).Contains("start-anticodex-second-antigravity-account-login.ps1") -or -not ([string]$evidence.secondAccountLoginEntrypointApprovedLoginCommandTemplate).Contains("-WindowsUser") -or -not ([string]$evidence.secondAccountLoginEntrypointApprovedLoginCommandTemplate).Contains("-StartLoginApproval start-separate-windows-user-login")) {
        Add-Failure "goal-readiness summary second-account entrypoint login command template incomplete"
    }
    if (-not ([string]$evidence.secondAccountLoginEntrypointNextNoTrafficStatusCommand).Contains("test-anticodex-antigravity-account-isolation-status.ps1") -or -not ([string]$evidence.secondAccountLoginEntrypointNextNoTrafficStatusCommand).Contains("-WindowsUser")) {
        Add-Failure "goal-readiness summary second-account entrypoint status command incomplete"
    }
    if (-not ([string]$evidence.secondAccountLoginEntrypointPostLoginProofCommandTemplate).Contains("test-anticodex-antigravity-cli-real-smoke.ps1") -or -not ([string]$evidence.secondAccountLoginEntrypointPostLoginProofCommandTemplate).Contains("-AllowSeparateAccountProof") -or -not ([string]$evidence.secondAccountLoginEntrypointPostLoginProofCommandTemplate).Contains("SeparateAccountProofApprovalId")) {
        Add-Failure "goal-readiness summary second-account entrypoint proof command incomplete"
    }
    if ($evidence.secondAccountLoginEntrypointApprovedLoginCommandPresent -ne $true) { Add-Failure "goal-readiness summary second-account entrypoint login command missing" }
    if ($evidence.secondAccountLoginEntrypointNextNoTrafficStatusCommandPresent -ne $true) { Add-Failure "goal-readiness summary second-account entrypoint status command missing" }
    if ($evidence.secondAccountLoginEntrypointPostLoginProofCommandPresent -ne $true) { Add-Failure "goal-readiness summary second-account entrypoint proof command missing" }
    if ($evidence.secondAccountLoginEntrypointPostLoginProofPlanPresent -ne $true) { Add-Failure "goal-readiness summary second-account entrypoint proof plan missing" }
    if ($evidence.secondAccountLoginEntrypointPostLoginProofPlanValid -ne $true) { Add-Failure "goal-readiness summary second-account entrypoint proof plan invalid" }
    if ($evidence.secondAccountReadinessSummaryReportName -ne "second-account-readiness-summary") { Add-Failure "goal-readiness summary second-account readiness summary report name mismatch" }
    if ($evidence.secondAccountReadinessSummaryNoTraffic -ne $true) { Add-Failure "goal-readiness summary second-account readiness summary not no-traffic" }
    if ($evidence.secondAccountReadinessSummaryUsedRealTraffic -ne $false) { Add-Failure "goal-readiness summary second-account readiness summary used real traffic" }
    if ($evidence.secondAccountReadinessSummaryCoverageKind -ne "second-account-readiness-summary-no-traffic") { Add-Failure "goal-readiness summary second-account readiness summary coverage kind mismatch" }
    if ($evidence.secondAccountReadinessSummaryReleaseAcceptableAccountProof -ne $false) { Add-Failure "goal-readiness summary second-account readiness summary claims account proof" }
    if ($evidence.secondAccountReadinessSummaryGoalComplete -ne $false) { Add-Failure "goal-readiness summary second-account readiness summary claims goal complete" }
    if (-not [string]$evidence.secondAccountReadinessSummaryNextOperatorAction) { Add-Failure "goal-readiness summary second-account readiness summary next action missing" }
    if (-not [string]$evidence.secondAccountReadinessSummaryAccountIsolationCaveat) { Add-Failure "goal-readiness summary second-account readiness summary caveat missing" }
    if (-not ([string]$evidence.secondAccountReadinessSummaryApprovedLoginCommandTemplate).Contains("start-anticodex-second-antigravity-account-login.ps1") -or -not ([string]$evidence.secondAccountReadinessSummaryApprovedLoginCommandTemplate).Contains("-StartLoginApproval start-separate-windows-user-login")) {
        Add-Failure "goal-readiness summary second-account readiness summary login command incomplete"
    }
    if (-not ([string]$evidence.secondAccountReadinessSummaryNextNoTrafficStatusCommand).Contains("test-anticodex-antigravity-account-isolation-status.ps1")) {
        Add-Failure "goal-readiness summary second-account readiness summary status command incomplete"
    }
    if (-not ([string]$evidence.secondAccountReadinessSummaryPostLoginProofCommandTemplate).Contains("test-anticodex-antigravity-cli-real-smoke.ps1") -or -not ([string]$evidence.secondAccountReadinessSummaryPostLoginProofCommandTemplate).Contains("-AllowSeparateAccountProof") -or -not ([string]$evidence.secondAccountReadinessSummaryPostLoginProofCommandTemplate).Contains("SeparateAccountProofApprovalId")) {
        Add-Failure "goal-readiness summary second-account readiness summary proof command incomplete"
    }
    if ($evidence.secondAccountReadinessSummaryApprovedLoginCommandPresent -ne $true) { Add-Failure "goal-readiness summary second-account readiness summary login command missing" }
    if ($evidence.secondAccountReadinessSummaryNextNoTrafficStatusCommandPresent -ne $true) { Add-Failure "goal-readiness summary second-account readiness summary status command missing" }
    if ($evidence.secondAccountReadinessSummaryPostLoginProofCommandPresent -ne $true) { Add-Failure "goal-readiness summary second-account readiness summary proof command missing" }
    if ([int]$evidence.secondAccountReadinessSummaryStepCount -lt 7) { Add-Failure "goal-readiness summary second-account readiness summary step count too low" }
    if ([int]$evidence.secondAccountReadinessSummaryFailedStepCount -ne 0) { Add-Failure "goal-readiness summary second-account readiness summary has failed steps" }
    if ([int]$evidence.secondAccountReadinessSummaryFailureCount -ne 0) { Add-Failure "goal-readiness summary second-account readiness summary has failures" }
    if ($evidence.secondAccountPostLoginProofReportName -ne "second-account-post-login-proof") { Add-Failure "goal-readiness summary second-account post-login proof report name mismatch" }
    if ($evidence.secondAccountPostLoginProofSemanticsValid -ne $true) { Add-Failure "goal-readiness summary second-account post-login proof semantics invalid" }
    if ($evidence.secondAccountPostLoginProofDryRunValid -ne $true -and $evidence.secondAccountPostLoginProofRealProofValid -ne $true) {
        Add-Failure "goal-readiness summary second-account post-login proof has no valid mode"
    }
    if ($evidence.secondAccountPostLoginProofAccountIdentityChecklistPresent -ne $true) { Add-Failure "goal-readiness summary second-account post-login proof identity input checklist missing" }
    if ($evidence.secondAccountPostLoginProofAntiCodexAccountIdSuggestedAvailable -ne $true) { Add-Failure "goal-readiness summary second-account post-login proof Anti-Codex account suggestion missing" }
    if ($evidence.secondAccountPostLoginProofEffectiveAntiCodexAccountIdPresent -ne $true) { Add-Failure "goal-readiness summary second-account post-login proof effective Anti-Codex account id missing" }
    if ($evidence.secondAccountPostLoginProofMcpAccountIdManagedByAntiCodex -ne $false) { Add-Failure "goal-readiness summary second-account post-login proof MCP account unexpectedly managed by Anti-Codex" }
    if ([string]$evidence.secondAccountPostLoginProofMcpAccountIdRequiredSource -ne "external-mcp-antigravity-account") { Add-Failure "goal-readiness summary second-account post-login proof MCP account source mismatch" }
    if ($evidence.secondAccountPostLoginProofExternalMcpAccountIdentityReportPresent -eq $true -and $evidence.secondAccountPostLoginProofExternalMcpAccountIdentityReportAccepted -ne $true) { Add-Failure "goal-readiness summary second-account post-login proof external MCP identity report rejected" }
    if ($evidence.secondAccountPostLoginProofApprovalIdRequired -ne $true) { Add-Failure "goal-readiness summary second-account post-login proof approval id not required" }
    if ($evidence.secondAccountPostLoginProofDryRunValid -eq $true -and $evidence.secondAccountPostLoginProofAllInputsReadyForProof -ne $false) { Add-Failure "goal-readiness summary second-account post-login proof dry-run inputs unexpectedly complete" }
    if (-not [string]$evidence.secondAccountPostLoginProofOperatorStatus) { Add-Failure "goal-readiness summary second-account post-login proof operator status missing" }
    if (-not [string]$evidence.secondAccountPostLoginProofOperatorNextAction) { Add-Failure "goal-readiness summary second-account post-login proof operator next action missing" }
    if (-not [string]$evidence.nextRequiredUserAction) { Add-Failure "goal-readiness summary missing next required user action" }
    if ([int]$evidence.blockerCount -ne 0) { Add-Failure "goal-readiness summary current blockers not empty" }
    if (@(As-FlatArray $evidence.blockers).Count -ne 0) { Add-Failure "goal-readiness summary current blocker list not empty" }
    $goalDeferredBlockers = @(As-FlatArray $evidence.deferredBlockers | ForEach-Object { [string]$_ })
    foreach ($requiredDeferredBlocker in @("current_channel_worker_transport_not_recovered", "second_antigravity_account_real_proof_missing")) {
        if ($goalDeferredBlockers -notcontains $requiredDeferredBlocker) { Add-Failure "goal-readiness summary missing deferred blocker: $requiredDeferredBlocker" }
    }
}

function Test-CliTransportBoundarySummaryEvidence {
    param($CliTransportBoundarySummary)
    if (-not $CliTransportBoundarySummary) {
        Add-Failure "diagnostic reports summary missing latest-cli-transport-boundary.json"
        return
    }

    $evidence = $CliTransportBoundarySummary.cliTransportBoundaryEvidence
    if (-not $evidence) {
        Add-Failure "cli-transport-boundary summary missing cliTransportBoundaryEvidence"
        return
    }

    if ($evidence.reportName -ne "cli-transport-boundary") { Add-Failure "cli-transport-boundary summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "cli-transport-boundary summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "cli-transport-boundary summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "cli-transport-boundary summary behavior not covered" }
    if ($evidence.coverageKind -ne "cli-transport-boundary-report-only") { Add-Failure "cli-transport-boundary summary coverage kind mismatch" }
    if ($evidence.cliTransportBoundaryComplete -ne $true) { Add-Failure "cli-transport-boundary summary incomplete" }
    if ($evidence.modelTextTransport -ne "desktop-cascade") { Add-Failure "cli-transport-boundary summary model transport is not desktop-cascade" }
    if ($evidence.modelDiscoverySource -ne "antigravity-desktop-catalog") { Add-Failure "cli-transport-boundary summary discovery source is not desktop catalog" }
    if ($evidence.antigravityCoworkerDefaultFalse -ne $true) { Add-Failure "cli-transport-boundary summary coworker default is not false" }
    if ($evidence.antigravityDesktopRequiredForCliTransport -ne $false) { Add-Failure "cli-transport-boundary summary says Desktop is required for CLI" }
    if ($evidence.antigravityDesktopProcessAbsenceRequired -ne $false) { Add-Failure "cli-transport-boundary summary incorrectly requires Desktop process absence" }
    if ($evidence.codexOwnedTools -ne $true) { Add-Failure "cli-transport-boundary summary missing Codex-owned tools boundary" }
    if ($evidence.antigravityModelTextOnly -ne $true) { Add-Failure "cli-transport-boundary summary missing model-text-only boundary" }
    if ([int]$evidence.staticCheckCount -lt 7) { Add-Failure "cli-transport-boundary summary static check count too low" }
    if ([int]$evidence.healthCheckCount -lt 5) { Add-Failure "cli-transport-boundary summary health check count too low" }
    if (@(As-FlatArray $evidence.failedCheckIds).Count -ne 0) { Add-Failure "cli-transport-boundary summary has failed checks" }
}

function Test-LongTaskLandingMatrixSummaryEvidence {
    param($LongTaskLandingMatrixSummary)
    if (-not $LongTaskLandingMatrixSummary) {
        Add-Failure "diagnostic reports summary missing latest-long-task-landing-matrix.json"
        return
    }

    $evidence = $LongTaskLandingMatrixSummary.longTaskLandingMatrixEvidence
    if (-not $evidence) {
        Add-Failure "long-task-landing-matrix summary missing longTaskLandingMatrixEvidence"
        return
    }

    $required = @("coding-project", "multi-turn-project", "report-site", "complex-project", "repo-multi-file-edit")
    $requiredEvidence = @(As-FlatArray $evidence.requiredLongTaskModes | ForEach-Object { [string]$_ })
    $taskResults = @(As-FlatArray $evidence.taskResults)
    foreach ($taskMode in $required) {
        if ($requiredEvidence -notcontains $taskMode) {
            Add-Failure "long-task-landing-matrix summary missing required task $taskMode"
        }
        $entry = @($taskResults | Where-Object { [string]$_.taskMode -eq $taskMode } | Select-Object -First 1)[0]
        if (-not $entry) {
            Add-Failure "long-task-landing-matrix summary missing task entry $taskMode"
            continue
        }
        if ($entry.ok -ne $true) { Add-Failure "long-task-landing-matrix summary task $taskMode not ok" }
        if ($entry.fresh -ne $true) { Add-Failure "long-task-landing-matrix summary task $taskMode not fresh" }
        if ($entry.requestedRealTraffic -ne $true) { Add-Failure "long-task-landing-matrix summary task $taskMode did not request real traffic" }
        if ($entry.usedRealTraffic -ne $true) { Add-Failure "long-task-landing-matrix summary task $taskMode did not use real traffic" }
        if ($entry.reportOk -ne $true) { Add-Failure "long-task-landing-matrix summary task $taskMode report not ok" }
        if ($entry.capabilityOk -ne $true) { Add-Failure "long-task-landing-matrix summary task $taskMode capability not ok" }
        if ($entry.artifactProofComplete -ne $true) { Add-Failure "long-task-landing-matrix summary task $taskMode artifact proof missing" }
        if ($entry.resultProofComplete -ne $true) { Add-Failure "long-task-landing-matrix summary task $taskMode result proof missing" }
        if ([int]$entry.requiredArtifactKeyCount -lt 1) { Add-Failure "long-task-landing-matrix summary task $taskMode missing artifact requirements" }
        if ([int]$entry.requiredFileCount -lt 1) { Add-Failure "long-task-landing-matrix summary task $taskMode missing file requirements" }
        if ([int]$entry.fileEvidenceCount -lt 1) { Add-Failure "long-task-landing-matrix summary task $taskMode missing file evidence" }
        if ([int]$entry.failureCount -ne 0) { Add-Failure "long-task-landing-matrix summary task $taskMode has failures" }
    }

    if ($evidence.reportName -ne "long-task-landing-matrix") { Add-Failure "long-task-landing-matrix summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "long-task-landing-matrix summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "long-task-landing-matrix summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "long-task-landing-matrix summary behavior not covered" }
    if ($evidence.coverageKind -ne "long-task-landing-matrix-report-only") { Add-Failure "long-task-landing-matrix summary coverage kind mismatch" }
    if ($evidence.longTaskLandingComplete -ne $true) { Add-Failure "long-task-landing-matrix summary is incomplete" }
    if ($evidence.codexClientCopy -ne $true) { Add-Failure "long-task-landing-matrix summary missing client-copy boundary" }
    if ($evidence.antigravityModelTextOnly -ne $true) { Add-Failure "long-task-landing-matrix summary missing model-text boundary" }
    if ($evidence.agenticCapabilityMatrixPresent -ne $true) { Add-Failure "long-task-landing-matrix summary missing agentic matrix" }
    if ($evidence.agenticCapabilityMatrixComplete -ne $true) { Add-Failure "long-task-landing-matrix summary agentic matrix incomplete" }
    if ($evidence.realTaskCoverageRoadmapPresent -ne $true) { Add-Failure "long-task-landing-matrix summary missing real-task roadmap" }
    if ([int]$evidence.longTaskCount -lt $required.Count) { Add-Failure "long-task-landing-matrix summary task count too low" }
    if ([int]$evidence.landedLongTaskCount -lt $required.Count) { Add-Failure "long-task-landing-matrix summary landed task count too low" }
    if (@(As-FlatArray $evidence.failedLongTaskModes).Count -ne 0) { Add-Failure "long-task-landing-matrix summary has failed tasks" }
    if ($evidence.broaderRealTrafficStillRequired -eq $true) {
        $pendingTasks = @(As-FlatArray $evidence.pendingRealTaskModes | ForEach-Object { [string]$_ })
        foreach ($taskMode in @("web-search", "free-chat")) {
            if ($pendingTasks -notcontains $taskMode) { Add-Failure "long-task-landing-matrix summary missing pending task $taskMode" }
        }
        $pendingScenarios = @(As-FlatArray $evidence.pendingRealTaskScenarios)
        if ($pendingScenarios.Count -lt $pendingTasks.Count) { Add-Failure "long-task-landing-matrix summary missing pending scenarios" }
        foreach ($taskMode in $pendingTasks) {
            $scenario = @($pendingScenarios | Where-Object { [string]$_.taskMode -eq [string]$taskMode } | Select-Object -First 1)[0]
            if (-not $scenario) {
                Add-Failure "long-task-landing-matrix summary missing pending scenario for $taskMode"
                continue
            }
            if (-not [string]$scenario.workType) { Add-Failure "long-task-landing-matrix summary pending scenario missing work type for $taskMode" }
            if ($scenario.realTrafficRequired -ne $true) { Add-Failure "long-task-landing-matrix summary pending scenario not marked real traffic for $taskMode" }
            if (@(As-FlatArray $scenario.acceptanceEvidence).Count -lt 1) { Add-Failure "long-task-landing-matrix summary pending scenario missing acceptance evidence for $taskMode" }
            if ($scenario.expectedResultPresent -ne $true) { Add-Failure "long-task-landing-matrix summary pending scenario missing expected result for $taskMode" }
        }
        if ($evidence.minimalRefreshCommandPresent -ne $true) { Add-Failure "long-task-landing-matrix summary missing minimal refresh command" }
    }
}

function Test-AgenticCapabilityMatrixSummaryEvidence {
    param($AgenticCapabilityMatrixSummary)
    if (-not $AgenticCapabilityMatrixSummary) {
        Add-Failure "diagnostic reports summary missing latest-agentic-capability-matrix.json"
        return
    }

    $evidence = $AgenticCapabilityMatrixSummary.agenticCapabilityMatrixEvidence
    if (-not $evidence) {
        Add-Failure "agentic-capability-matrix summary missing agenticCapabilityMatrixEvidence"
        return
    }

    $required = @(
        "coding_project_files_tests_cli",
        "multi_turn_continuation",
        "research_report_with_sources",
        "complex_research_code_site",
        "repo_multi_file_edit"
    )
    $requiredEvidence = @(As-FlatArray $evidence.requiredCapabilities | ForEach-Object { [string]$_ })
    $capabilities = @(As-FlatArray $evidence.capabilities)
    foreach ($capabilityId in $required) {
        if ($requiredEvidence -notcontains $capabilityId) {
            Add-Failure "agentic-capability-matrix summary missing required capability $capabilityId"
        }
        $entry = @($capabilities | Where-Object { [string]$_.id -eq $capabilityId } | Select-Object -First 1)[0]
        if (-not $entry) {
            Add-Failure "agentic-capability-matrix summary missing capability entry $capabilityId"
            continue
        }
        if ($entry.ok -ne $true) { Add-Failure "agentic-capability-matrix summary capability $capabilityId not ok" }
        if ($entry.fresh -ne $true) { Add-Failure "agentic-capability-matrix summary capability $capabilityId not fresh" }
        if ($entry.requestedRealTraffic -ne $true) { Add-Failure "agentic-capability-matrix summary capability $capabilityId did not request real traffic" }
        if ($entry.usedRealTraffic -ne $true) { Add-Failure "agentic-capability-matrix summary capability $capabilityId did not use real traffic" }
        if ([int]$entry.failureCount -ne 0) { Add-Failure "agentic-capability-matrix summary capability $capabilityId has failures" }
    }

    if ($evidence.reportName -ne "agentic-capability-matrix") { Add-Failure "agentic-capability-matrix summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "agentic-capability-matrix summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "agentic-capability-matrix summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "agentic-capability-matrix summary behavior not covered" }
    if ($evidence.coverageKind -ne "agentic-capability-matrix-report-only") { Add-Failure "agentic-capability-matrix summary coverage kind mismatch" }
    if ($evidence.complete -ne $true) { Add-Failure "agentic-capability-matrix summary is incomplete" }
    if ($evidence.fresh -ne $true) { Add-Failure "agentic-capability-matrix summary is not fresh" }
    if ($evidence.suiteProfile -ne "agentic") { Add-Failure "agentic-capability-matrix summary suite profile mismatch" }
    if ($evidence.desktopTaskSuiteFresh -ne $true) { Add-Failure "agentic-capability-matrix summary desktop suite not fresh" }
    if ($evidence.desktopTaskSuiteComplete -ne $true) { Add-Failure "agentic-capability-matrix summary desktop suite incomplete" }
    if ($evidence.desktopTaskSuiteEvidenceFresh -ne $true) { Add-Failure "agentic-capability-matrix summary desktop suite evidence not fresh" }
    if ([int]$evidence.capabilityCount -lt $required.Count) { Add-Failure "agentic-capability-matrix summary capability count too low" }
    if ([int]$evidence.okCapabilityCount -lt $required.Count) { Add-Failure "agentic-capability-matrix summary ok capability count too low" }
    if ([int]$evidence.failedCapabilityCount -ne 0) { Add-Failure "agentic-capability-matrix summary has failed capabilities" }
    if (@(As-FlatArray $evidence.missingCapabilities).Count -ne 0) { Add-Failure "agentic-capability-matrix summary has missing capabilities" }
    if (@(As-FlatArray $evidence.staleCapabilities).Count -ne 0) { Add-Failure "agentic-capability-matrix summary has stale capabilities" }
}

function Test-RealTaskCoverageRoadmapSummaryEvidence {
    param($RealTaskCoverageRoadmapSummary)
    if (-not $RealTaskCoverageRoadmapSummary) {
        Add-Failure "diagnostic reports summary missing latest-real-task-coverage-roadmap.json"
        return
    }

    $evidence = $RealTaskCoverageRoadmapSummary.realTaskCoverageRoadmapEvidence
    if (-not $evidence) {
        Add-Failure "real-task-coverage-roadmap summary missing realTaskCoverageRoadmapEvidence"
        return
    }

    $requiredProfiles = @("core", "agentic", "extended", "all")
    $profiles = @(As-FlatArray $evidence.profiles)
    $profileNames = @(As-FlatArray $evidence.requiredProfiles | ForEach-Object { [string]$_ })
    foreach ($profileName in $requiredProfiles) {
        if ($profileNames -notcontains $profileName) {
            Add-Failure "real-task-coverage-roadmap summary missing required profile $profileName"
        }
        $entry = @($profiles | Where-Object { [string]$_.profile -eq $profileName } | Select-Object -First 1)[0]
        if (-not $entry) {
            Add-Failure "real-task-coverage-roadmap summary missing profile entry $profileName"
            continue
        }
        if ([int]$entry.taskCount -lt 1) { Add-Failure "real-task-coverage-roadmap summary profile $profileName has no tasks" }
        if ([int]$entry.resultProofRequiredCount -lt 1) { Add-Failure "real-task-coverage-roadmap summary profile $profileName missing result proof requirements" }
        if ([int]$entry.resultProofCompleteCount -lt [int]$entry.resultProofRequiredCount) { Add-Failure "real-task-coverage-roadmap summary profile $profileName result proof count incomplete" }
        if ($entry.profileResultProofComplete -ne $true) { Add-Failure "real-task-coverage-roadmap summary profile $profileName result proof incomplete" }
        if (@(As-FlatArray $entry.missingResultProofTasks).Count -ne 0) { Add-Failure "real-task-coverage-roadmap summary profile $profileName has missing result proof tasks" }
        if ([int]$entry.artifactProofRequiredCount -gt 0 -and [int]$entry.artifactProofCompleteCount -lt [int]$entry.artifactProofRequiredCount) { Add-Failure "real-task-coverage-roadmap summary profile $profileName artifact proof count incomplete" }
        if ($entry.profileArtifactProofComplete -ne $true) { Add-Failure "real-task-coverage-roadmap summary profile $profileName artifact proof incomplete" }
        if (@(As-FlatArray $entry.missingArtifactProofTasks).Count -ne 0) { Add-Failure "real-task-coverage-roadmap summary profile $profileName has missing artifact proof tasks" }
        if ($entry.refreshCommandPresent -ne $true) { Add-Failure "real-task-coverage-roadmap summary profile $profileName missing refresh command" }
    }

    if ($evidence.reportName -ne "real-task-coverage-roadmap") { Add-Failure "real-task-coverage-roadmap summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "real-task-coverage-roadmap summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "real-task-coverage-roadmap summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "real-task-coverage-roadmap summary behavior not covered" }
    if ($evidence.coverageKind -ne "real-task-coverage-roadmap-report-only") { Add-Failure "real-task-coverage-roadmap summary coverage kind mismatch" }
    if ([int]$evidence.profileCount -lt $requiredProfiles.Count) { Add-Failure "real-task-coverage-roadmap summary profile count too low" }
    if (@(As-FlatArray $evidence.taskModes).Count -lt 9) { Add-Failure "real-task-coverage-roadmap summary task mode count too low" }
    $artifactProofs = @(As-FlatArray $evidence.taskArtifactProofs)
    if ($artifactProofs.Count -lt 5) { Add-Failure "real-task-coverage-roadmap summary missing artifact proof coverage" }
    if ($null -eq $evidence.missingArtifactProofTaskCount) { Add-Failure "real-task-coverage-roadmap summary missing artifact proof count" }
    if ($null -eq $evidence.missingArtifactProofTasks) { Add-Failure "real-task-coverage-roadmap summary missing artifact proof task list" }
    if ([int]$evidence.missingArtifactProofTaskCount -ne 0) { Add-Failure "real-task-coverage-roadmap summary has missing artifact proofs" }
    foreach ($proof in $artifactProofs) {
        if (-not [string]$proof.taskMode) { Add-Failure "real-task-coverage-roadmap summary artifact proof missing task mode" }
        if ([int]$proof.artifactProofCount -lt 1) { Add-Failure "real-task-coverage-roadmap summary artifact proof count too low" }
        if ($proof.artifactProofComplete -ne $true) { Add-Failure "real-task-coverage-roadmap summary artifact proof incomplete" }
        if (@(As-FlatArray $proof.missingArtifactProofKeys).Count -ne 0) { Add-Failure "real-task-coverage-roadmap summary artifact proof missing required keys" }
    }
    $resultProofs = @(As-FlatArray $evidence.taskResultProofs)
    if ($resultProofs.Count -lt 9) { Add-Failure "real-task-coverage-roadmap summary missing result proof coverage" }
    if ($null -eq $evidence.missingResultProofTaskCount) { Add-Failure "real-task-coverage-roadmap summary missing result proof count" }
    if ($null -eq $evidence.missingResultProofTasks) { Add-Failure "real-task-coverage-roadmap summary missing result proof task list" }
    if ([int]$evidence.missingResultProofTaskCount -ne 0) { Add-Failure "real-task-coverage-roadmap summary has missing result proofs" }
    foreach ($proof in $resultProofs) {
        if (-not [string]$proof.taskMode) { Add-Failure "real-task-coverage-roadmap summary result proof missing task mode" }
        if ([int]$proof.resultProofCount -lt 1) { Add-Failure "real-task-coverage-roadmap summary result proof count too low" }
        if ($proof.resultProofComplete -ne $true) { Add-Failure "real-task-coverage-roadmap summary result proof incomplete" }
        if (@(As-FlatArray $proof.missingResultProofKeys).Count -ne 0) { Add-Failure "real-task-coverage-roadmap summary result proof missing required keys" }
    }
    $uniqueRefreshTasks = @(As-FlatArray $evidence.uniqueRefreshTasks)
    if ($evidence.approvalRequiredForRefresh -eq $true -and $uniqueRefreshTasks.Count -lt 1) { Add-Failure "real-task-coverage-roadmap summary missing unique refresh tasks" }
    $pendingScenarios = @(As-FlatArray $evidence.pendingRealTaskScenarios)
    if ($evidence.approvalRequiredForRefresh -eq $true -and $pendingScenarios.Count -lt $uniqueRefreshTasks.Count) { Add-Failure "real-task-coverage-roadmap summary missing pending real task scenarios" }
    foreach ($taskMode in $uniqueRefreshTasks) {
        $scenario = @($pendingScenarios | Where-Object { [string]$_.taskMode -eq [string]$taskMode } | Select-Object -First 1)[0]
        if (-not $scenario) {
            Add-Failure "real-task-coverage-roadmap summary missing pending scenario for $taskMode"
            continue
        }
        if (-not [string]$scenario.workType) { Add-Failure "real-task-coverage-roadmap summary pending scenario missing work type for $taskMode" }
        if ($scenario.realTrafficRequired -ne $true) { Add-Failure "real-task-coverage-roadmap summary pending scenario not marked real traffic for $taskMode" }
        if (@(As-FlatArray $scenario.acceptanceEvidence).Count -lt 1) { Add-Failure "real-task-coverage-roadmap summary pending scenario missing acceptance evidence for $taskMode" }
        if ($scenario.expectedResultPresent -ne $true) { Add-Failure "real-task-coverage-roadmap summary pending scenario missing expected result for $taskMode" }
    }
    if ($evidence.approvalRequiredForRefresh -eq $true -and $evidence.minimalRefreshCommandPresent -ne $true) { Add-Failure "real-task-coverage-roadmap summary missing minimal refresh command" }
    if ($evidence.approvalRequiredForRefresh -eq $true -and $evidence.minimalRefreshCommandRequiresRealTraffic -ne $true) { Add-Failure "real-task-coverage-roadmap summary minimal refresh command is not marked real traffic" }
    if (-not [string]$evidence.realTrafficApprovalReason) { Add-Failure "real-task-coverage-roadmap summary missing approval reason" }
    if (-not [string]$evidence.recommendedNoTrafficNextStep) { Add-Failure "real-task-coverage-roadmap summary missing next step" }
}

function Test-RealApprovalPlanSummaryEvidence {
    param($RealApprovalPlanSummary)
    if (-not $RealApprovalPlanSummary) {
        Add-Failure "diagnostic reports summary missing latest-real-approval-plan.json"
        return
    }

    $evidence = $RealApprovalPlanSummary.realApprovalPlanEvidence
    if (-not $evidence) {
        Add-Failure "real-approval-plan summary missing realApprovalPlanEvidence"
        return
    }

    if ($evidence.reportName -ne "real-approval-plan") { Add-Failure "real-approval-plan summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "real-approval-plan summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "real-approval-plan summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "real-approval-plan summary behavior not covered" }
    if ($evidence.coverageKind -ne "real-approval-plan-report-only") { Add-Failure "real-approval-plan summary coverage kind mismatch" }
    $refreshTasks = @(As-FlatArray $evidence.realTaskRefreshTasks)
    $refreshScenarios = @(As-FlatArray $evidence.realTaskRefreshPendingScenarios)
    if ($evidence.realTaskRefreshNeeded -eq $true) {
        if ($refreshTasks.Count -lt 1) { Add-Failure "real-approval-plan summary missing real task refresh tasks" }
        if ($refreshScenarios.Count -lt $refreshTasks.Count) { Add-Failure "real-approval-plan summary missing real task refresh scenarios" }
        foreach ($taskMode in $refreshTasks) {
            $scenario = @($refreshScenarios | Where-Object { [string]$_.taskMode -eq [string]$taskMode } | Select-Object -First 1)[0]
            if (-not $scenario) {
                Add-Failure "real-approval-plan summary missing refresh scenario for $taskMode"
                continue
            }
            if (-not [string]$scenario.workType) { Add-Failure "real-approval-plan summary refresh scenario missing work type for $taskMode" }
            if ($scenario.realTrafficRequired -ne $true) { Add-Failure "real-approval-plan summary refresh scenario not marked real traffic for $taskMode" }
            if (@(As-FlatArray $scenario.acceptanceEvidence).Count -lt 1) { Add-Failure "real-approval-plan summary refresh scenario missing acceptance evidence for $taskMode" }
            if ($scenario.expectedResultPresent -ne $true) { Add-Failure "real-approval-plan summary refresh scenario missing expected result for $taskMode" }
        }
        if ($evidence.realTaskRefreshCommandPresent -ne $true) { Add-Failure "real-approval-plan summary missing real task refresh command" }
    } else {
        if ($refreshTasks.Count -ne 0) { Add-Failure "real-approval-plan summary has refresh tasks while refresh not needed" }
        if ($refreshScenarios.Count -ne 0) { Add-Failure "real-approval-plan summary has refresh scenarios while refresh not needed" }
        if ($evidence.realTaskRefreshCommandPresent -ne $false) { Add-Failure "real-approval-plan summary has refresh command while refresh not needed" }
    }
    if ($evidence.requiredReleaseComplete -eq $true) {
        if ($evidence.releaseBlockedOnlyByRequiredRealTraffic -ne $false) { Add-Failure "real-approval-plan summary complete release still claims real-traffic-only blocker" }
        if ([int]$evidence.requiredReleaseRealTrafficActionCount -ne 0) { Add-Failure "real-approval-plan summary complete release still has required release real-traffic actions" }
        $requiredGateIds = @(As-FlatArray $evidence.requiredReleaseGateIds | ForEach-Object { [string]$_ })
        $completedGateIds = @(As-FlatArray $evidence.completedRequiredGateIds | ForEach-Object { [string]$_ })
        foreach ($gateId in @("accountProxyReadiness", "postVerification")) {
            if ($requiredGateIds -notcontains $gateId) { Add-Failure "real-approval-plan summary missing required release gate $gateId" }
            if ($completedGateIds -notcontains $gateId) { Add-Failure "real-approval-plan summary missing completed release gate $gateId" }
        }
    } else {
        if ($evidence.releaseBlockedOnlyByRequiredRealTraffic -ne $true) { Add-Failure "real-approval-plan summary missing release real-traffic-only blocker" }
        if (@(As-FlatArray $evidence.releaseRealTrafficGateIds).Count -lt 1) { Add-Failure "real-approval-plan summary missing release real-traffic gates" }
        if ([int]$evidence.requiredReleaseRealTrafficActionCount -lt 1) { Add-Failure "real-approval-plan summary missing required release real-traffic actions" }
    }
    if ($null -eq $evidence.optionalReleaseRealTrafficActionCount) { Add-Failure "real-approval-plan summary missing optional release real-traffic action count" }
    if ($evidence.accountTargetUserMissing -ne $true) { Add-Failure "real-approval-plan summary missing target-user setup blocker" }
    if ($evidence.accountSetupBlocked -ne $true) { Add-Failure "real-approval-plan summary missing account setup blocker" }
    if ($evidence.preLoginChecklistComplete -ne $true) { Add-Failure "real-approval-plan summary missing complete pre-login checklist" }
    if ([int]$evidence.preLoginChecklistCount -lt 3) { Add-Failure "real-approval-plan summary pre-login checklist count too low" }
    $preLoginIds = @(As-FlatArray $evidence.preLoginChecklistIds)
    foreach ($requiredPreLoginId in @("windows-user-account-prepare", "account-isolation-status", "second-account-login-entrypoint-status")) {
        if ($preLoginIds -notcontains $requiredPreLoginId) { Add-Failure "real-approval-plan summary missing pre-login checklist id $requiredPreLoginId" }
    }
    if ([int]$evidence.orderedActionCount -lt 4) { Add-Failure "real-approval-plan summary ordered action count too low" }
    if ([int]$evidence.blockedUntilExplicitUserApprovalCount -lt 1) { Add-Failure "real-approval-plan summary missing explicit approval blockers" }
    if ([int]$evidence.requiresRealTrafficCount -lt 1) { Add-Failure "real-approval-plan summary missing real traffic actions" }
    if ([int]$evidence.operatorSetupBlockedCount -lt 1) { Add-Failure "real-approval-plan summary missing operator setup blockers" }
    if (-not [string]$evidence.nextNoTrafficAction) { Add-Failure "real-approval-plan summary missing next no-traffic action" }
}

function Test-NativeCodexParityTaskMatrixSummaryEvidence {
    param($NativeCodexParityTaskMatrixSummary)
    if (-not $NativeCodexParityTaskMatrixSummary) {
        Add-Failure "diagnostic reports summary missing latest-native-codex-parity-task-matrix.json"
        return
    }

    $evidence = $NativeCodexParityTaskMatrixSummary.nativeCodexParityTaskMatrixEvidence
    if (-not $evidence) {
        Add-Failure "native-codex-parity-task-matrix summary missing nativeCodexParityTaskMatrixEvidence"
        return
    }

    $groups = @(As-FlatArray $evidence.parityGroupIds | ForEach-Object { [string]$_ })
    foreach ($groupId in @("conversation", "research", "projectCreation", "codingAndRepoEditing", "multiTurnAgentic", "toolUse")) {
        if ($groups -notcontains $groupId) { Add-Failure "native-codex-parity-task-matrix summary missing group $groupId" }
    }
    $taskModes = @(As-FlatArray $evidence.taskModes | ForEach-Object { [string]$_ })
    foreach ($taskMode in @("exact-marker", "free-chat", "web-search", "local-project", "coding-project", "multi-turn-project", "report-site", "complex-project", "repo-file-edit", "repo-multi-file-edit")) {
        if ($taskModes -notcontains $taskMode) { Add-Failure "native-codex-parity-task-matrix summary missing task $taskMode" }
    }
    $toolTaskModes = @(As-FlatArray $evidence.toolTaskModes | ForEach-Object { [string]$_ })
    foreach ($taskMode in @("tool-loop", "mcp-tool-loop", "custom-tool-loop")) {
        if ($toolTaskModes -notcontains $taskMode) { Add-Failure "native-codex-parity-task-matrix summary missing tool task $taskMode" }
    }

    if ($evidence.reportName -ne "native-codex-parity-task-matrix") { Add-Failure "native-codex-parity-task-matrix summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "native-codex-parity-task-matrix summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "native-codex-parity-task-matrix summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "native-codex-parity-task-matrix summary behavior not covered" }
    if ($evidence.coverageKind -ne "native-codex-parity-task-matrix-report-only") { Add-Failure "native-codex-parity-task-matrix summary coverage kind mismatch" }
    if ($evidence.codexOwnedTools -ne $true) { Add-Failure "native-codex-parity-task-matrix summary missing Codex-owned tools boundary" }
    if ($evidence.antigravityModelTextOnly -ne $true) { Add-Failure "native-codex-parity-task-matrix summary missing model-text boundary" }
    if ($evidence.realTrafficStillRequired -eq $true) {
        $pendingTasks = @(As-FlatArray $evidence.pendingRefreshTaskModes | ForEach-Object { [string]$_ })
        foreach ($taskMode in @("web-search", "free-chat")) {
            if ($pendingTasks -notcontains $taskMode) { Add-Failure "native-codex-parity-task-matrix summary pending task modes missing" }
        }
        $scenarios = @(As-FlatArray $evidence.pendingRealTaskScenarios)
        if ($scenarios.Count -lt $pendingTasks.Count) { Add-Failure "native-codex-parity-task-matrix summary missing pending real task scenarios" }
        foreach ($taskMode in $pendingTasks) {
            $scenario = @($scenarios | Where-Object { [string]$_.taskMode -eq [string]$taskMode } | Select-Object -First 1)[0]
            if (-not $scenario) {
                Add-Failure "native-codex-parity-task-matrix summary missing pending scenario for $taskMode"
                continue
            }
            if (-not [string]$scenario.workType) { Add-Failure "native-codex-parity-task-matrix summary pending scenario missing work type for $taskMode" }
            if ($scenario.realTrafficRequired -ne $true) { Add-Failure "native-codex-parity-task-matrix summary pending scenario not marked real traffic for $taskMode" }
            if (@(As-FlatArray $scenario.acceptanceEvidence).Count -lt 1) { Add-Failure "native-codex-parity-task-matrix summary pending scenario missing acceptance evidence for $taskMode" }
            if ($scenario.expectedResultPresent -ne $true) { Add-Failure "native-codex-parity-task-matrix summary pending scenario missing expected result for $taskMode" }
        }
        $args = @(As-FlatArray $evidence.minimalRefreshCommandArgs | ForEach-Object { [string]$_ })
        if (-not ($args -contains "--allow-real-traffic")) { Add-Failure "native-codex-parity-task-matrix summary missing approved real traffic command args" }
        if ($evidence.minimalRefreshCommandPresent -ne $true) { Add-Failure "native-codex-parity-task-matrix summary missing minimal refresh command" }
    }
    if ([int]$evidence.failureCount -ne 0) { Add-Failure "native-codex-parity-task-matrix summary has failures" }
}

function Test-RequiredRealTrafficSequenceSummaryEvidence {
    param($RequiredRealTrafficSequenceSummary)
    if (-not $RequiredRealTrafficSequenceSummary) {
        Add-Failure "diagnostic reports summary missing latest-required-real-traffic-sequence.json"
        return
    }

    $evidence = $RequiredRealTrafficSequenceSummary.requiredRealTrafficSequenceEvidence
    if (-not $evidence) {
        Add-Failure "required-real-traffic-sequence summary missing requiredRealTrafficSequenceEvidence"
        return
    }

    $requiredActionIds = @(As-FlatArray $evidence.requiredActionIds)
    $optionalActionIds = @(As-FlatArray $evidence.optionalActionIds)
    $requiredGateIds = @(As-FlatArray $evidence.requiredGateIds)
    $completedRequiredGateIds = @(As-FlatArray $evidence.completedRequiredGateIds)
    $requiredReleaseComplete = ($evidence.requiredReleaseComplete -eq $true)
    $mixedOptional = @($requiredActionIds | Where-Object { $optionalActionIds -contains $_ })

    if ($evidence.reportName -ne "required-real-traffic-sequence") { Add-Failure "required-real-traffic-sequence summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "required-real-traffic-sequence summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "required-real-traffic-sequence summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "required-real-traffic-sequence summary behavior not covered" }
    if ($evidence.coverageKind -ne "required-real-traffic-sequence-report-only") { Add-Failure "required-real-traffic-sequence summary coverage kind mismatch" }
    if ($evidence.approvalPlanPresent -ne $true) { Add-Failure "required-real-traffic-sequence summary missing approval plan" }
    if ($evidence.approvalPlanReportName -ne "real-approval-plan") { Add-Failure "required-real-traffic-sequence summary approval plan name mismatch" }
    if ([int]$evidence.optionalActionCount -lt 1) { Add-Failure "required-real-traffic-sequence summary missing optional action count" }
    if ($evidence.noOptionalActionsInRequiredSequence -ne $true -or $mixedOptional.Count -gt 0) { Add-Failure "required-real-traffic-sequence summary mixed optional actions" }
    foreach ($gateId in @("accountProxyReadiness", "postVerification")) {
        if ($requiredGateIds -notcontains $gateId) { Add-Failure "required-real-traffic-sequence summary missing required gate $gateId" }
        if ($requiredReleaseComplete) {
            if ($completedRequiredGateIds -notcontains $gateId) { Add-Failure "required-real-traffic-sequence summary missing completed gate $gateId" }
        } elseif ($requiredActionIds -notcontains $gateId) {
            Add-Failure "required-real-traffic-sequence summary missing required action $gateId"
        }
    }
    if ($requiredReleaseComplete) {
        if ([int]$evidence.requiredActionCount -ne 0) { Add-Failure "required-real-traffic-sequence summary completed but still has required actions" }
        if ($evidence.blockedUntilExplicitUserApproval -ne $false) { Add-Failure "required-real-traffic-sequence summary completed but still approval blocked" }
    } else {
        if ([int]$evidence.requiredActionCount -lt 1) { Add-Failure "required-real-traffic-sequence summary missing required actions" }
        if ($evidence.blockedUntilExplicitUserApproval -ne $true) { Add-Failure "required-real-traffic-sequence summary not approval blocked" }
    }
    if ([int]$evidence.commandCount -lt $requiredActionIds.Count) { Add-Failure "required-real-traffic-sequence summary missing commands" }
    if ([int]$evidence.failureCount -ne 0) { Add-Failure "required-real-traffic-sequence summary has failures" }
}

function Test-GoalRealRunReadinessSummaryEvidence {
    param($GoalRealRunReadinessSummary)
    if (-not $GoalRealRunReadinessSummary) {
        Add-Failure "diagnostic reports summary missing latest-goal-real-run-readiness.json"
        return
    }

    $evidence = $GoalRealRunReadinessSummary.goalRealRunReadinessEvidence
    if (-not $evidence) {
        Add-Failure "goal-real-run-readiness summary missing goalRealRunReadinessEvidence"
        return
    }

    $refreshTasks = @(As-FlatArray $evidence.uniqueRefreshTasks)
    $refreshScenarios = @(As-FlatArray $evidence.pendingRealTaskScenarios)
    $requiredGateIds = @(As-FlatArray $evidence.requiredReleaseGateIds)
    $requiredActionIds = @(As-FlatArray $evidence.requiredActionIds)
    $completedRequiredGateIds = @(As-FlatArray $evidence.completedRequiredGateIds)
    $requiredReleaseComplete = ($evidence.requiredReleaseComplete -eq $true)
    $blockedGates = @(As-FlatArray $evidence.requiredRealTrafficBlockedGates)
    $blockingStages = @(As-FlatArray $evidence.blockingStages)

    if ($evidence.reportName -ne "goal-real-run-readiness") { Add-Failure "goal-real-run-readiness summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "goal-real-run-readiness summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "goal-real-run-readiness summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "goal-real-run-readiness summary behavior not covered" }
    if ($evidence.coverageKind -ne "goal-real-run-readiness-report-only") { Add-Failure "goal-real-run-readiness summary coverage kind mismatch" }
    if ($evidence.readyForUserApprovedRealRun -ne $false) { Add-Failure "goal-real-run-readiness summary incorrectly marked ready" }
    if ($evidence.safeToAskUserForSecondAccountLogin -ne $true -and -not [string]$evidence.accountReadinessBlockingReason) { Add-Failure "goal-real-run-readiness summary missing account blocking reason" }
    if ($evidence.separateAccountVerified -ne $false) { Add-Failure "goal-real-run-readiness summary claimed separate account proof" }
    if ($evidence.releaseAcceptableAccountProof -ne $false) { Add-Failure "goal-real-run-readiness summary claimed release account proof" }
    if ($evidence.realTaskRefreshNeeded -eq $true) {
        foreach ($taskMode in @("web-search", "free-chat")) {
            if ($refreshTasks -notcontains $taskMode) { Add-Failure "goal-real-run-readiness summary missing refresh task $taskMode" }
            $scenario = @($refreshScenarios | Where-Object { [string]$_.taskMode -eq $taskMode } | Select-Object -First 1)[0]
            if (-not $scenario) {
                Add-Failure "goal-real-run-readiness summary missing scenario $taskMode"
                continue
            }
            if (-not [string]$scenario.workType) { Add-Failure "goal-real-run-readiness scenario missing work type $taskMode" }
            if ($scenario.realTrafficRequired -ne $true) { Add-Failure "goal-real-run-readiness scenario not real traffic $taskMode" }
            if (@(As-FlatArray $scenario.acceptanceEvidence).Count -lt 1) { Add-Failure "goal-real-run-readiness scenario missing acceptance evidence $taskMode" }
            if ($scenario.expectedResultPresent -ne $true) { Add-Failure "goal-real-run-readiness scenario missing expected result $taskMode" }
        }
        if ($evidence.realTaskRefreshCommandPresent -ne $true) { Add-Failure "goal-real-run-readiness summary missing real task refresh command" }
    } else {
        if ($refreshTasks.Count -gt 0) { Add-Failure "goal-real-run-readiness summary unexpected refresh tasks" }
        if ($refreshScenarios.Count -gt 0) { Add-Failure "goal-real-run-readiness summary unexpected refresh scenarios" }
        if ($evidence.realTaskRefreshCommandPresent -ne $false) { Add-Failure "goal-real-run-readiness summary unexpected refresh command" }
    }
    if ($refreshScenarios.Count -lt $refreshTasks.Count) { Add-Failure "goal-real-run-readiness summary scenario count lower than refresh tasks" }
    if (@(As-FlatArray $evidence.missingTaskScenarios).Count -ne 0) { Add-Failure "goal-real-run-readiness summary has missing task scenarios" }
    foreach ($gateId in @("accountProxyReadiness", "postVerification")) {
        if ($requiredGateIds -notcontains $gateId) { Add-Failure "goal-real-run-readiness summary missing required gate $gateId" }
        if ($requiredReleaseComplete) {
            if ($completedRequiredGateIds -notcontains $gateId) { Add-Failure "goal-real-run-readiness summary missing completed gate $gateId" }
        } else {
            if ($requiredActionIds -notcontains $gateId) { Add-Failure "goal-real-run-readiness summary missing required action $gateId" }
            if ($blockedGates -notcontains $gateId) { Add-Failure "goal-real-run-readiness summary missing blocked gate $gateId" }
        }
    }
    if ([int]$evidence.requiredCommandCount -lt $requiredActionIds.Count) { Add-Failure "goal-real-run-readiness summary missing required commands" }
    if ($evidence.releaseShortReady -ne $true) { Add-Failure "goal-real-run-readiness summary short path not ready" }
    if ($evidence.releaseReady -ne $true -and $evidence.releaseBlockedOnlyByRequiredRealTraffic -ne $true) { Add-Failure "goal-real-run-readiness summary missing release ready or real-traffic-only blocker" }
    $expectedStages = if ($evidence.releaseReady -eq $true) { @("second_account_login_not_ready") } else { @("second_account_login_not_ready", "release_gates_require_explicit_real_traffic") }
    if ($evidence.realTaskRefreshNeeded -eq $true) { $expectedStages += "real_task_refresh_requires_explicit_approval" }
    foreach ($stage in $expectedStages) {
        if ($blockingStages -notcontains $stage) { Add-Failure "goal-real-run-readiness summary missing blocking stage $stage" }
    }
    if (-not [string]$evidence.operatorNextAction) { Add-Failure "goal-real-run-readiness summary missing operator next action" }
    if ([int]$evidence.failureCount -ne 0) { Add-Failure "goal-real-run-readiness summary has failures" }
}

function Test-ApprovedRealRunSequenceSummaryEvidence {
    param($ApprovedRealRunSequenceSummary)
    if (-not $ApprovedRealRunSequenceSummary) {
        Add-Failure "diagnostic reports summary missing latest-approved-real-run-sequence.json"
        return
    }

    $evidence = $ApprovedRealRunSequenceSummary.approvedRealRunSequenceEvidence
    if (-not $evidence) {
        Add-Failure "approved-real-run-sequence summary missing approvedRealRunSequenceEvidence"
        return
    }

    $taskModes = @(As-FlatArray $evidence.requiredRealTaskModes)
    $scenarios = @(As-FlatArray $evidence.pendingRealTaskScenarios)
    $requiredGateIds = @(As-FlatArray $evidence.requiredReleaseGateIds)
    $requiredActionIds = @(As-FlatArray $evidence.requiredActionIds)
    $completedRequiredGateIds = @(As-FlatArray $evidence.completedRequiredGateIds)
    $requiredReleaseComplete = ($evidence.requiredReleaseComplete -eq $true)
    $optionalActionIds = @(As-FlatArray $evidence.optionalActionIds)
    $blockedGates = @(As-FlatArray $evidence.requiredRealTrafficBlockedGates)
    $prechecks = @(As-FlatArray $evidence.noTrafficPrechecks)
    $sequence = @(As-FlatArray $evidence.approvedRealRunSequence)
    $realStages = @($sequence | Where-Object { $_.requiresRealTraffic -eq $true })
    $loginStages = @($sequence | Where-Object { $_.startsLogin -eq $true })
    $mixedOptional = @($requiredActionIds | Where-Object { $optionalActionIds -contains $_ })

    if ($evidence.reportName -ne "approved-real-run-sequence") { Add-Failure "approved-real-run-sequence summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "approved-real-run-sequence summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "approved-real-run-sequence summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "approved-real-run-sequence summary behavior not covered" }
    if ($evidence.coverageKind -ne "approved-real-run-sequence-report-only") { Add-Failure "approved-real-run-sequence summary coverage kind mismatch" }
    $readyForLoginApproval = ($evidence.readyToRequestSecondAccountLoginApproval -eq $true)
    $readyForProofApproval = ($evidence.readyToRequestPostLoginProofApproval -eq $true)
    $readyForAnyApproval = ($readyForLoginApproval -or $readyForProofApproval)
    if ($evidence.executionBlockedBeforeRealTraffic -ne ($evidence.releaseAcceptableAccountProof -ne $true)) { Add-Failure "approved-real-run-sequence summary block state inconsistent" }
    if ($evidence.readyToRequestUserApproval -ne $readyForAnyApproval) { Add-Failure "approved-real-run-sequence summary ready state inconsistent" }
    if ($readyForAnyApproval -and $evidence.releaseAcceptableAccountProof -eq $true) { Add-Failure "approved-real-run-sequence summary ready after proof complete" }
    if ([int]$evidence.sequenceStageCount -lt 8 -or $sequence.Count -lt 8) { Add-Failure "approved-real-run-sequence summary stage count too low" }
    $minimumRealStages = if ($taskModes.Count -gt 0 -or $scenarios.Count -gt 0) { 4 } else { 3 }
    if ([int]$evidence.realTrafficStageCount -lt $minimumRealStages -or $realStages.Count -lt $minimumRealStages) { Add-Failure "approved-real-run-sequence summary real stage count too low" }
    if ([int]$evidence.startsLoginStageCount -ne 1 -or $loginStages.Count -ne 1) { Add-Failure "approved-real-run-sequence summary login stage count mismatch" }
    if ([int]$evidence.explicitApprovalStageCount -lt $realStages.Count) { Add-Failure "approved-real-run-sequence summary approval stage count too low" }
    if ($taskModes.Count -gt 0 -or $scenarios.Count -gt 0) {
        foreach ($taskMode in @("web-search", "free-chat")) {
            if ($taskModes -notcontains $taskMode) { Add-Failure "approved-real-run-sequence summary missing task mode $taskMode" }
            $scenario = @($scenarios | Where-Object { [string]$_.taskMode -eq $taskMode } | Select-Object -First 1)[0]
            if (-not $scenario) {
                Add-Failure "approved-real-run-sequence summary missing scenario $taskMode"
                continue
            }
            if (-not [string]$scenario.workType) { Add-Failure "approved-real-run-sequence scenario missing work type $taskMode" }
            if ($scenario.realTrafficRequired -ne $true) { Add-Failure "approved-real-run-sequence scenario not real traffic $taskMode" }
            if (@(As-FlatArray $scenario.acceptanceEvidence).Count -lt 1) { Add-Failure "approved-real-run-sequence scenario missing acceptance evidence $taskMode" }
            if ($scenario.expectedResultPresent -ne $true) { Add-Failure "approved-real-run-sequence scenario missing expected result $taskMode" }
        }
    }
    foreach ($gateId in @("accountProxyReadiness", "postVerification")) {
        if ($requiredGateIds -notcontains $gateId) { Add-Failure "approved-real-run-sequence summary missing required gate $gateId" }
        if ($requiredReleaseComplete) {
            if ($completedRequiredGateIds -notcontains $gateId) { Add-Failure "approved-real-run-sequence summary missing completed gate $gateId" }
        } else {
            if ($requiredActionIds -notcontains $gateId) { Add-Failure "approved-real-run-sequence summary missing required action $gateId" }
            if ($blockedGates -notcontains $gateId) { Add-Failure "approved-real-run-sequence summary missing blocked gate $gateId" }
        }
    }
    if ($evidence.optionalActionsSeparated -ne $true -or $mixedOptional.Count -gt 0) { Add-Failure "approved-real-run-sequence summary mixed optional actions" }
    if ($evidence.releaseShortReady -ne $true) { Add-Failure "approved-real-run-sequence summary short path not ready" }
    if ($evidence.safeToAskUserForSecondAccountLogin -eq $true -and -not $readyForLoginApproval -and $evidence.releaseAcceptableAccountProof -ne $true) { Add-Failure "approved-real-run-sequence summary safe login not actionable" }
    if ($evidence.safeToAskUserForSecondAccountLogin -ne $true -and -not [string]$evidence.accountReadinessBlockingReason) { Add-Failure "approved-real-run-sequence summary missing account blocking reason" }
    if (-not [string]$evidence.operatorNextAction) { Add-Failure "approved-real-run-sequence summary missing operator next action" }
    if ($prechecks.Count -lt 4) { Add-Failure "approved-real-run-sequence summary precheck count too low" }
    if (@($prechecks | Where-Object { $_.requiresRealTraffic -eq $true -or $_.startsLogin -eq $true }).Count -gt 0) { Add-Failure "approved-real-run-sequence summary precheck starts traffic or login" }
    if (@($realStages | Where-Object { $_.requiresExplicitUserApproval -ne $true }).Count -gt 0) { Add-Failure "approved-real-run-sequence summary real stage without approval" }
    if (@($loginStages | Where-Object { $_.requiresExplicitUserApproval -ne $true -or $_.requiresRealTraffic -eq $true }).Count -gt 0) { Add-Failure "approved-real-run-sequence summary login stage contract mismatch" }
    if ([int]$evidence.failureCount -ne 0) { Add-Failure "approved-real-run-sequence summary has failures" }
}

function Test-WorkerMcpServerProbeSummaryEvidence {
    param($WorkerMcpServerProbeSummary)
    if (-not $WorkerMcpServerProbeSummary) {
        Add-Failure "diagnostic reports summary missing latest-worker-mcp-server-probe.json"
        return
    }

    $evidence = $WorkerMcpServerProbeSummary.workerMcpServerProbeEvidence
    if (-not $evidence) {
        Add-Failure "worker-mcp-server-probe summary missing workerMcpServerProbeEvidence"
        return
    }

    $required = @(
        "antigravity-code-worker",
        "deepseek-code-worker",
        "deveco-code-worker",
        "kilo-worker",
        "mimo-claude-coworker",
        "mimocode-worker",
        "opencode-worker"
    )
    $requiredWorkers = @(As-FlatArray $evidence.requiredWorkers | ForEach-Object { [string]$_ })
    $servers = @(As-FlatArray $evidence.servers)

    if ($evidence.reportName -ne "worker-mcp-server-probe") { Add-Failure "worker-mcp-server-probe summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "worker-mcp-server-probe summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "worker-mcp-server-probe summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "worker-mcp-server-probe summary behavior not covered" }
    if ($evidence.coverageKind -ne "worker-mcp-server-probe-list-tools-only") { Add-Failure "worker-mcp-server-probe summary coverage kind mismatch" }
    if ($evidence.configPathPresent -ne $true) { Add-Failure "worker-mcp-server-probe summary missing config path" }
    if ($evidence.codexSessionTransportStatus -ne "not-tested-by-direct-probe") { Add-Failure "worker-mcp-server-probe summary missing direct-probe transport caveat" }
    if (-not $evidence.operatorRecoveryAction) { Add-Failure "worker-mcp-server-probe summary missing operator recovery action" }
    if (-not $evidence.postReloadVerification) { Add-Failure "worker-mcp-server-probe summary missing post-reload verification" }
    if ([int]$evidence.passedServerCount -lt $required.Count) { Add-Failure "worker-mcp-server-probe summary passed server count too low" }
    if ([int]$evidence.serverCount -lt $required.Count -or $servers.Count -lt $required.Count) { Add-Failure "worker-mcp-server-probe summary server count too low" }
    if (@(As-FlatArray $evidence.missingServers).Count -ne 0) { Add-Failure "worker-mcp-server-probe summary has missing servers" }
    if (@(As-FlatArray $evidence.incompleteToolCountServers).Count -ne 0) { Add-Failure "worker-mcp-server-probe summary has incomplete tool counts" }
    if ($evidence.PSObject.Properties.Name -notcontains "missingStartToolServers") { Add-Failure "worker-mcp-server-probe summary missing start-tool diagnostic field" }
    if ($evidence.PSObject.Properties.Name -notcontains "missingWaitToolServers") { Add-Failure "worker-mcp-server-probe summary missing wait-tool diagnostic field" }
    if (@(As-FlatArray $evidence.missingStartToolServers).Count -ne 0) { Add-Failure "worker-mcp-server-probe summary has missing start tools" }
    foreach ($serverName in $required) {
        if ($requiredWorkers -notcontains $serverName) {
            Add-Failure "worker-mcp-server-probe summary missing required worker $serverName"
        }
        $entry = @($servers | Where-Object { [string]$_.name -eq $serverName } | Select-Object -First 1)[0]
        if (-not $entry) {
            Add-Failure "worker-mcp-server-probe summary missing server entry $serverName"
            continue
        }
        if ($entry.ok -ne $true) { Add-Failure "worker-mcp-server-probe summary server $serverName not ok" }
        if ([int]$entry.toolCount -lt 1) { Add-Failure "worker-mcp-server-probe summary server $serverName has no tools" }
        if (@(As-FlatArray $entry.toolNames).Count -lt 1) { Add-Failure "worker-mcp-server-probe summary server $serverName missing tool names" }
        if ($entry.hasStartTool -ne $true) { Add-Failure "worker-mcp-server-probe summary server $serverName missing start tool classification" }
        if ($entry.PSObject.Properties.Name -notcontains "hasWaitTool") { Add-Failure "worker-mcp-server-probe summary server $serverName missing wait tool classification" }
        if ($entry.PSObject.Properties.Name -notcontains "hasSyncTool") { Add-Failure "worker-mcp-server-probe summary server $serverName missing sync tool classification" }
        if ($entry.PSObject.Properties.Name -notcontains "hasCancelTool") { Add-Failure "worker-mcp-server-probe summary server $serverName missing cancel tool classification" }
        if (@(As-FlatArray $entry.startToolNames).Count -lt 1) { Add-Failure "worker-mcp-server-probe summary server $serverName missing start tool names" }
        if ($entry.errorPresent -eq $true) { Add-Failure "worker-mcp-server-probe summary server $serverName has error" }
    }
}

function Test-WorkerMcpTaskSmokeSummaryEvidence {
    param($WorkerMcpTaskSmokeSummary)
    if (-not $WorkerMcpTaskSmokeSummary) {
        Add-Failure "diagnostic reports summary missing latest-worker-mcp-task-smoke.json"
        return
    }

    $evidence = $WorkerMcpTaskSmokeSummary.workerMcpTaskSmokeEvidence
    if (-not $evidence) {
        Add-Failure "worker-mcp-task-smoke summary missing workerMcpTaskSmokeEvidence"
        return
    }

    $results = @(As-FlatArray $evidence.results)
    if ($evidence.reportName -ne "worker-mcp-task-smoke") { Add-Failure "worker-mcp-task-smoke summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $true) { Add-Failure "worker-mcp-task-smoke summary did not request real worker traffic" }
    if ($evidence.usedRealTraffic -ne $true) { Add-Failure "worker-mcp-task-smoke summary did not use real worker traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "worker-mcp-task-smoke summary behavior not covered" }
    if ($evidence.coverageKind -ne "worker-mcp-real-task-smoke") { Add-Failure "worker-mcp-task-smoke summary coverage kind mismatch" }
    if ($evidence.antigravityWorkerExcluded -ne $true) { Add-Failure "worker-mcp-task-smoke summary did not exclude Antigravity worker" }
    if ([int]$evidence.workerCount -lt $RequiredWorkerMcpTaskSmokePassedWorkers) { Add-Failure "worker-mcp-task-smoke summary worker count too low" }
    if ([int]$evidence.passedWorkerCount -lt $RequiredWorkerMcpTaskSmokePassedWorkers) { Add-Failure "worker-mcp-task-smoke summary passed worker count too low" }
    if (@(As-FlatArray $evidence.failedWorkers).Count -ne 0) { Add-Failure "worker-mcp-task-smoke summary has failed workers" }
    if ($results.Count -lt 1) { Add-Failure "worker-mcp-task-smoke summary missing results" }
    $passedWorkerNames = @($results | Where-Object { $_.ok -eq $true } | ForEach-Object { [string]$_.worker })
    foreach ($requiredWorker in $RequiredWorkerMcpTaskSmokeWorkers) {
        if ($passedWorkerNames -notcontains $requiredWorker) { Add-Failure "worker-mcp-task-smoke summary missing required worker $requiredWorker" }
    }
    foreach ($entry in $results) {
        if ($entry.worker -eq "antigravity-code-worker") { Add-Failure "worker-mcp-task-smoke unexpectedly used Antigravity worker" }
        if ($entry.ok -ne $true) { Add-Failure "worker-mcp-task-smoke result not ok for $($entry.worker)" }
        if (-not [string]$entry.jobId) { Add-Failure "worker-mcp-task-smoke result missing job id for $($entry.worker)" }
        if (-not [string]$entry.marker) { Add-Failure "worker-mcp-task-smoke result missing marker for $($entry.worker)" }
        if ($entry.workspacePresent -ne $true) { Add-Failure "worker-mcp-task-smoke result missing workspace for $($entry.worker)" }
        if ($entry.terminalStatus -ne "completed") { Add-Failure "worker-mcp-task-smoke terminal status not completed for $($entry.worker)" }
        if ($entry.workspaceVerificationOk -ne $true) { Add-Failure "worker-mcp-task-smoke workspace verification failed for $($entry.worker)" }
        if ($entry.resultPathExists -ne $true) { Add-Failure "worker-mcp-task-smoke result file missing for $($entry.worker)" }
    }
}

function Test-WorkerMcpProjectSmokeSummaryEvidence {
    param($WorkerMcpProjectSmokeSummary)
    if (-not $WorkerMcpProjectSmokeSummary) {
        Add-Failure "diagnostic reports summary missing latest-worker-mcp-project-smoke.json"
        return
    }

    $evidence = $WorkerMcpProjectSmokeSummary.workerMcpProjectSmokeEvidence
    if (-not $evidence) {
        Add-Failure "worker-mcp-project-smoke summary missing workerMcpProjectSmokeEvidence"
        return
    }

    $results = @(As-FlatArray $evidence.results)
    if ($evidence.reportName -ne "worker-mcp-project-smoke") { Add-Failure "worker-mcp-project-smoke summary reportName mismatch" }
    if ($evidence.scenario -ne "project") { Add-Failure "worker-mcp-project-smoke summary scenario mismatch" }
    if ($evidence.requestedRealTraffic -ne $true) { Add-Failure "worker-mcp-project-smoke summary did not request real worker traffic" }
    if ($evidence.usedRealTraffic -ne $true) { Add-Failure "worker-mcp-project-smoke summary did not use real worker traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "worker-mcp-project-smoke summary behavior not covered" }
    if ($evidence.coverageKind -ne "worker-mcp-real-task-smoke") { Add-Failure "worker-mcp-project-smoke summary coverage kind mismatch" }
    if ($evidence.antigravityWorkerExcluded -ne $true) { Add-Failure "worker-mcp-project-smoke summary did not exclude Antigravity worker" }
    if ([int]$evidence.workerCount -lt $RequiredWorkerMcpTaskSmokePassedWorkers) { Add-Failure "worker-mcp-project-smoke summary worker count too low" }
    if ([int]$evidence.passedWorkerCount -lt $RequiredWorkerMcpTaskSmokePassedWorkers) { Add-Failure "worker-mcp-project-smoke summary passed worker count too low" }
    if (@(As-FlatArray $evidence.failedWorkers).Count -ne 0) { Add-Failure "worker-mcp-project-smoke summary has failed workers" }
    if ($results.Count -lt 1) { Add-Failure "worker-mcp-project-smoke summary missing results" }
    $passedWorkerNames = @($results | Where-Object { $_.ok -eq $true } | ForEach-Object { [string]$_.worker })
    foreach ($requiredWorker in $RequiredWorkerMcpTaskSmokeWorkers) {
        if ($passedWorkerNames -notcontains $requiredWorker) { Add-Failure "worker-mcp-project-smoke summary missing required worker $requiredWorker" }
    }
    foreach ($entry in $results) {
        if ($entry.worker -eq "antigravity-code-worker") { Add-Failure "worker-mcp-project-smoke unexpectedly used Antigravity worker" }
        if ($entry.ok -ne $true) { Add-Failure "worker-mcp-project-smoke result not ok for $($entry.worker)" }
        if (-not [string]$entry.jobId) { Add-Failure "worker-mcp-project-smoke result missing job id for $($entry.worker)" }
        if (-not [string]$entry.marker) { Add-Failure "worker-mcp-project-smoke result missing marker for $($entry.worker)" }
        if ($entry.workspacePresent -ne $true) { Add-Failure "worker-mcp-project-smoke result missing workspace for $($entry.worker)" }
        if ($entry.terminalStatus -ne "completed" -and $entry.artifactVerifiedAfterNonterminalWorker -ne $true) { Add-Failure "worker-mcp-project-smoke terminal status not completed for $($entry.worker)" }
        if ($entry.workspaceVerificationOk -ne $true) { Add-Failure "worker-mcp-project-smoke workspace verification failed for $($entry.worker)" }
        if (@(As-FlatArray $entry.missingFiles).Count -ne 0) { Add-Failure "worker-mcp-project-smoke missing files for $($entry.worker)" }
        if (@(As-FlatArray $entry.extraFiles).Count -ne 0) { Add-Failure "worker-mcp-project-smoke extra files for $($entry.worker)" }
        if ($entry.doneTextMatches -ne $true) { Add-Failure "worker-mcp-project-smoke done marker mismatch for $($entry.worker)" }
        if ([int]$entry.testExitCode -ne 0) { Add-Failure "worker-mcp-project-smoke node:test failed for $($entry.worker)" }
        if ([int]$entry.cliExitCode -ne 0) { Add-Failure "worker-mcp-project-smoke CLI failed for $($entry.worker)" }
        if (-not $entry.cliJson) { Add-Failure "worker-mcp-project-smoke missing CLI JSON for $($entry.worker)" }
        else {
            if ([int]$entry.cliJson.red -ne 2) { Add-Failure "worker-mcp-project-smoke CLI red count mismatch for $($entry.worker)" }
            if ([int]$entry.cliJson.blue -ne 1) { Add-Failure "worker-mcp-project-smoke CLI blue count mismatch for $($entry.worker)" }
        }
    }
}

function Test-XiaoqiangWorkerMcpProjectSmokeSummaryEvidence {
    param($XiaoqiangWorkerMcpProjectSmokeSummary)
    if (-not $XiaoqiangWorkerMcpProjectSmokeSummary) {
        Add-Failure "diagnostic reports summary missing latest-xiaoqiang-worker-mcp-project-smoke.json"
        return
    }

    $evidence = $XiaoqiangWorkerMcpProjectSmokeSummary.xiaoqiangWorkerMcpProjectSmokeEvidence
    if (-not $evidence) {
        Add-Failure "xiaoqiang-worker-mcp-project-smoke summary missing xiaoqiangWorkerMcpProjectSmokeEvidence"
        return
    }

    $results = @(As-FlatArray $evidence.results)
    if ($evidence.reportName -ne "xiaoqiang-worker-mcp-project-smoke") { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary reportName mismatch" }
    if ($evidence.scenario -ne "xiaoqiang-project") { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary scenario mismatch" }
    if ($evidence.requestedRealTraffic -ne $true) { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary did not request real worker traffic" }
    if ($evidence.usedRealTraffic -ne $true) { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary did not use real worker traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary behavior not covered" }
    if ($evidence.coverageKind -ne "worker-mcp-real-task-smoke") { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary coverage kind mismatch" }
    if ($evidence.antigravityWorkerExcluded -ne $true) { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary did not exclude Antigravity worker" }
    if ([int]$evidence.workerCount -ne 3) { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary worker count mismatch" }
    if ([int]$evidence.passedWorkerCount -ne 3) { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary passed worker count mismatch" }
    if (@(As-FlatArray $evidence.failedWorkers).Count -ne 0) { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary has failed workers" }
    if ($results.Count -ne 3) { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary result count mismatch" }
    $passedWorkerNames = @($results | Where-Object { $_.ok -eq $true } | ForEach-Object { [string]$_.worker })
    foreach ($requiredWorker in @("xiaoqiang1", "xiaoqiang2", "xiaoqiang3")) {
        if ($passedWorkerNames -notcontains $requiredWorker) { Add-Failure "xiaoqiang-worker-mcp-project-smoke summary missing required worker $requiredWorker" }
    }
    foreach ($entry in $results) {
        if ($entry.worker -eq "antigravity-code-worker") { Add-Failure "xiaoqiang-worker-mcp-project-smoke unexpectedly used Antigravity worker" }
        if ($entry.ok -ne $true) { Add-Failure "xiaoqiang-worker-mcp-project-smoke result not ok for $($entry.worker)" }
        if (-not [string]$entry.jobId) { Add-Failure "xiaoqiang-worker-mcp-project-smoke result missing job id for $($entry.worker)" }
        if (-not [string]$entry.marker) { Add-Failure "xiaoqiang-worker-mcp-project-smoke result missing marker for $($entry.worker)" }
        if ($entry.workspacePresent -ne $true) { Add-Failure "xiaoqiang-worker-mcp-project-smoke result missing workspace for $($entry.worker)" }
        if ($entry.terminalStatus -ne "completed" -and $entry.artifactVerifiedAfterNonterminalWorker -ne $true) { Add-Failure "xiaoqiang-worker-mcp-project-smoke terminal status not completed for $($entry.worker)" }
        if ($entry.workspaceVerificationOk -ne $true) { Add-Failure "xiaoqiang-worker-mcp-project-smoke workspace verification failed for $($entry.worker)" }
        if (@(As-FlatArray $entry.missingFiles).Count -ne 0) { Add-Failure "xiaoqiang-worker-mcp-project-smoke missing files for $($entry.worker)" }
        if (@(As-FlatArray $entry.extraFiles).Count -ne 0) { Add-Failure "xiaoqiang-worker-mcp-project-smoke extra files for $($entry.worker)" }
        if ($entry.doneTextMatches -ne $true) { Add-Failure "xiaoqiang-worker-mcp-project-smoke done marker mismatch for $($entry.worker)" }
        if ([int]$entry.testExitCode -ne 0) { Add-Failure "xiaoqiang-worker-mcp-project-smoke node:test failed for $($entry.worker)" }
        if ([int]$entry.cliExitCode -ne 0) { Add-Failure "xiaoqiang-worker-mcp-project-smoke CLI failed for $($entry.worker)" }
        if (-not $entry.cliJson) { Add-Failure "xiaoqiang-worker-mcp-project-smoke missing CLI JSON for $($entry.worker)" }
        else {
            if ([int]$entry.cliJson.red -ne 2) { Add-Failure "xiaoqiang-worker-mcp-project-smoke CLI red count mismatch for $($entry.worker)" }
            if ([int]$entry.cliJson.blue -ne 1) { Add-Failure "xiaoqiang-worker-mcp-project-smoke CLI blue count mismatch for $($entry.worker)" }
        }
    }
}

function Test-XiaoqiangWorkerMcpComplexProjectSmokeSummaryEvidence {
    param($WorkerMcpComplexProjectSmokeSummary)
    if (-not $WorkerMcpComplexProjectSmokeSummary) {
        Add-Failure "diagnostic reports summary missing latest-worker-mcp-complex-project-smoke.json"
        return
    }

    $evidence = $WorkerMcpComplexProjectSmokeSummary.workerMcpComplexProjectSmokeEvidence
    if (-not $evidence) {
        Add-Failure "worker-mcp-complex-project-smoke summary missing workerMcpComplexProjectSmokeEvidence"
        return
    }

    $results = @(As-FlatArray $evidence.results)
    if ($evidence.reportName -ne "worker-mcp-complex-project-smoke") { Add-Failure "worker-mcp-complex-project-smoke summary reportName mismatch" }
    if ($evidence.scenario -ne "complex-project") { Add-Failure "worker-mcp-complex-project-smoke summary scenario mismatch" }
    if ($evidence.requestedRealTraffic -ne $true) { Add-Failure "worker-mcp-complex-project-smoke summary did not request real worker traffic" }
    if ($evidence.usedRealTraffic -ne $true) { Add-Failure "worker-mcp-complex-project-smoke summary did not use real worker traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "worker-mcp-complex-project-smoke summary behavior not covered" }
    if ($evidence.coverageKind -ne "worker-mcp-real-task-smoke") { Add-Failure "worker-mcp-complex-project-smoke summary coverage kind mismatch" }
    if ($evidence.antigravityWorkerExcluded -ne $true) { Add-Failure "worker-mcp-complex-project-smoke summary did not exclude Antigravity worker" }
    if ([int]$evidence.workerCount -ne 3) { Add-Failure "worker-mcp-complex-project-smoke summary worker count mismatch" }
    if ([int]$evidence.passedWorkerCount -ne 3) { Add-Failure "worker-mcp-complex-project-smoke summary passed worker count mismatch" }
    if (@(As-FlatArray $evidence.failedWorkers).Count -ne 0) { Add-Failure "worker-mcp-complex-project-smoke summary has failed workers" }
    if ($results.Count -ne 3) { Add-Failure "worker-mcp-complex-project-smoke summary result count mismatch" }
    $passedWorkerNames = @($results | Where-Object { $_.ok -eq $true } | ForEach-Object { [string]$_.worker })
    foreach ($requiredWorker in @("xiaoqiang1", "xiaoqiang2", "xiaoqiang3")) {
        if ($passedWorkerNames -notcontains $requiredWorker) { Add-Failure "worker-mcp-complex-project-smoke summary missing required worker $requiredWorker" }
    }
    foreach ($entry in $results) {
        if ($entry.worker -eq "antigravity-code-worker") { Add-Failure "worker-mcp-complex-project-smoke unexpectedly used Antigravity worker" }
        if ($entry.ok -ne $true) { Add-Failure "worker-mcp-complex-project-smoke result not ok for $($entry.worker)" }
        if (-not [string]$entry.jobId) { Add-Failure "worker-mcp-complex-project-smoke result missing job id for $($entry.worker)" }
        if ($entry.workspacePresent -ne $true) { Add-Failure "worker-mcp-complex-project-smoke result missing workspace for $($entry.worker)" }
        if ($entry.terminalStatus -ne "completed" -and $entry.artifactVerifiedAfterNonterminalWorker -ne $true) { Add-Failure "worker-mcp-complex-project-smoke terminal status not completed for $($entry.worker)" }
        if ($entry.workspaceVerificationOk -ne $true) { Add-Failure "worker-mcp-complex-project-smoke workspace verification failed for $($entry.worker)" }
        if (@(As-FlatArray $entry.missingFiles).Count -ne 0) { Add-Failure "worker-mcp-complex-project-smoke missing files for $($entry.worker)" }
        if (@(As-FlatArray $entry.extraFiles).Count -ne 0) { Add-Failure "worker-mcp-complex-project-smoke extra files for $($entry.worker)" }
        if ($entry.doneTextMatches -ne $true) { Add-Failure "worker-mcp-complex-project-smoke done marker mismatch for $($entry.worker)" }
        if ($entry.sourcesOk -ne $true) { Add-Failure "worker-mcp-complex-project-smoke sources invalid for $($entry.worker)" }
        if ([int]$entry.testExitCode -ne 0) { Add-Failure "worker-mcp-complex-project-smoke node:test failed for $($entry.worker)" }
        if ([int]$entry.cliExitCode -ne 0) { Add-Failure "worker-mcp-complex-project-smoke CLI failed for $($entry.worker)" }
        if (-not $entry.cliJson) { Add-Failure "worker-mcp-complex-project-smoke missing CLI JSON for $($entry.worker)" }
        elseif ([int]$entry.cliJson.sourceCount -ne 3) { Add-Failure "worker-mcp-complex-project-smoke CLI source count mismatch for $($entry.worker)" }
        if ($entry.reportOk -ne $true) { Add-Failure "worker-mcp-complex-project-smoke report invalid for $($entry.worker)" }
        if ($entry.htmlOk -ne $true) { Add-Failure "worker-mcp-complex-project-smoke HTML invalid for $($entry.worker)" }
    }
}

function Test-WorkerMcpStatusProbeSummaryEvidence {
    param($WorkerMcpStatusProbeSummary)
    if (-not $WorkerMcpStatusProbeSummary) {
        Add-Failure "diagnostic reports summary missing latest-worker-mcp-status-probe.json"
        return
    }

    $evidence = $WorkerMcpStatusProbeSummary.workerMcpStatusProbeEvidence
    if (-not $evidence) {
        Add-Failure "worker-mcp-status-probe summary missing workerMcpStatusProbeEvidence"
        return
    }

    $results = @(As-FlatArray $evidence.results)
    if ($evidence.reportName -ne "worker-mcp-status-probe") { Add-Failure "worker-mcp-status-probe summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "worker-mcp-status-probe summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "worker-mcp-status-probe summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "worker-mcp-status-probe summary behavior not covered" }
    if ($evidence.coverageKind -ne "worker-mcp-direct-status-call-no-traffic") { Add-Failure "worker-mcp-status-probe summary coverage kind mismatch" }
    if ($evidence.includeAntigravity -ne $false) { Add-Failure "worker-mcp-status-probe summary unexpectedly included Antigravity worker" }
    if ($evidence.antigravitySkippedForAccountIsolation -ne $true) { Add-Failure "worker-mcp-status-probe summary did not preserve Antigravity account-isolation skip" }
    if ([int]$evidence.probedWorkerCount -lt 6) { Add-Failure "worker-mcp-status-probe summary probed worker count too low" }
    if ([int]$evidence.statusCallOkCount -lt 6) { Add-Failure "worker-mcp-status-probe summary status-call ok count too low" }
    if ([int]$evidence.failedWorkerCount -ne 0) { Add-Failure "worker-mcp-status-probe summary has failed workers" }
    if (@(As-FlatArray $evidence.failedWorkers).Count -ne 0) { Add-Failure "worker-mcp-status-probe summary has failed worker names" }
    if (@(As-FlatArray $evidence.skippedWorkers | Where-Object { [string]$_ -eq "antigravity-code-worker" }).Count -lt 1) { Add-Failure "worker-mcp-status-probe summary missing Antigravity skip" }
    if (-not [string]$evidence.interpretation) { Add-Failure "worker-mcp-status-probe summary missing interpretation" }
    if (-not [string]$evidence.currentChannelCaveat) { Add-Failure "worker-mcp-status-probe summary missing current-channel caveat" }

    $okWorkers = @(As-FlatArray $evidence.statusCallOkWorkers | ForEach-Object { [string]$_ })
    foreach ($requiredWorker in @("mimo-claude-coworker", "mimocode-worker", "kilo-worker", "opencode-worker", "deepseek-code-worker", "deveco-code-worker")) {
        if ($okWorkers -notcontains $requiredWorker) { Add-Failure "worker-mcp-status-probe summary missing status-call worker $requiredWorker" }
    }
    foreach ($entry in $results) {
        if ($entry.worker -eq "antigravity-code-worker") {
            if ($entry.skipped -ne $true) { Add-Failure "worker-mcp-status-probe Antigravity result was not skipped" }
            continue
        }
        if ($entry.ok -ne $true) { Add-Failure "worker-mcp-status-probe result not ok for $($entry.worker)" }
        if ($entry.statusCallOk -ne $true) { Add-Failure "worker-mcp-status-probe status call not ok for $($entry.worker)" }
        if (-not [string]$entry.statusTool) { Add-Failure "worker-mcp-status-probe missing status tool for $($entry.worker)" }
        if ($entry.statusToolPresent -ne $true) { Add-Failure "worker-mcp-status-probe status tool absent for $($entry.worker)" }
        if (-not [string]$entry.jobId) { Add-Failure "worker-mcp-status-probe missing job id for $($entry.worker)" }
        if ([int]$entry.toolCount -lt 1) { Add-Failure "worker-mcp-status-probe missing tool count for $($entry.worker)" }
        if (-not [string]$entry.status) { Add-Failure "worker-mcp-status-probe missing terminal status for $($entry.worker)" }
    }
}

function Test-CurrentChannelWorkerTransportSummaryEvidence {
    param($CurrentChannelWorkerTransportSummary)
    if (-not $CurrentChannelWorkerTransportSummary) {
        Add-Failure "diagnostic reports summary missing latest-current-channel-worker-transport.json"
        return
    }

    $evidence = $CurrentChannelWorkerTransportSummary.currentChannelWorkerTransportEvidence
    if (-not $evidence) {
        Add-Failure "current-channel-worker-transport summary missing currentChannelWorkerTransportEvidence"
        return
    }

    if ($evidence.reportName -ne "current-channel-worker-transport") { Add-Failure "current-channel-worker-transport summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "current-channel-worker-transport summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "current-channel-worker-transport summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "current-channel-worker-transport summary behavior not covered" }
    if ($evidence.coverageKind -ne "current-channel-worker-transport-observation") { Add-Failure "current-channel-worker-transport summary coverage kind mismatch" }
    if ($evidence.currentChannelProbe -ne $true) { Add-Failure "current-channel-worker-transport summary missing current-channel probe" }
    if (-not [string]$evidence.workerTool) { Add-Failure "current-channel-worker-transport summary missing worker tool" }
    if (-not [string]$evidence.workerStatus) { Add-Failure "current-channel-worker-transport summary missing worker status" }
    $transportFailedTools = @(As-FlatArray $evidence.workerTransportFailedTools | ForEach-Object { [string]$_ })
    $transportOkTools = @(As-FlatArray $evidence.workerTransportOkTools | ForEach-Object { [string]$_ })
    $expectedWorkerPrefixes = @(As-FlatArray $evidence.expectedWorkerPrefixes | ForEach-Object { [string]$_ })
    $exposedWorkerPrefixes = @(As-FlatArray $evidence.exposedWorkerPrefixes | ForEach-Object { [string]$_ })
    $observedWorkerPrefixes = @(As-FlatArray $evidence.observedWorkerPrefixes | ForEach-Object { [string]$_ })
    $missingExpectedWorkerPrefixes = @(As-FlatArray $evidence.missingExpectedWorkerPrefixes | ForEach-Object { [string]$_ })
    if ($expectedWorkerPrefixes.Count -lt 7) { Add-Failure "current-channel-worker-transport summary missing expected worker prefix inventory" }
    if (-not [string]$evidence.genericMcpTool) { Add-Failure "current-channel-worker-transport summary missing generic MCP tool" }
    if ($evidence.genericMcpStatus -ne "ok") { Add-Failure "current-channel-worker-transport summary generic MCP control failed" }
    if ($evidence.genericMcpControlOk -ne $true) { Add-Failure "current-channel-worker-transport summary missing generic MCP control proof" }
    if ($evidence.directProbeOk -ne $true) { Add-Failure "current-channel-worker-transport summary missing direct worker probe proof" }
    if ([int]$evidence.directProbePassedServerCount -lt 7) { Add-Failure "current-channel-worker-transport summary direct probe server count too low" }
    if (@(As-FlatArray $evidence.directProbeMissingServers).Count -ne 0) { Add-Failure "current-channel-worker-transport summary direct probe has missing servers" }
    if ($evidence.directProbeCodexSessionTransportStatus -ne "not-tested-by-direct-probe") { Add-Failure "current-channel-worker-transport summary missing direct-probe transport caveat" }
    if (-not [string]$evidence.interpretation) { Add-Failure "current-channel-worker-transport summary missing interpretation" }
    if (-not [string]$evidence.operatorRecoveryAction) { Add-Failure "current-channel-worker-transport summary missing operator recovery action" }
    if (-not [string]$evidence.postReloadVerification) { Add-Failure "current-channel-worker-transport summary missing post-reload verification" }
    if ($evidence.readOnlyProbeRequiredBeforeDispatch -ne $true) { Add-Failure "current-channel-worker-transport summary missing read-only pre-dispatch probe requirement" }

    $workerTransportOk = $evidence.workerTransportOk -eq $true
    $workerTransportFailed = $evidence.workerTransportFailed -eq $true
    if (-not $workerTransportOk -and -not $workerTransportFailed) {
        Add-Failure "current-channel-worker-transport summary did not prove current worker transport state"
    }
    if ($workerTransportFailed) {
        if ([int]$evidence.workerObservationCount -lt 3) { Add-Failure "current-channel-worker-transport summary worker observation count too low" }
        if ([int]$evidence.workerTransportFailedCount -lt 3) { Add-Failure "current-channel-worker-transport summary worker failed count too low" }
        if ($observedWorkerPrefixes.Count -lt 3) { Add-Failure "current-channel-worker-transport summary missing observed worker prefix inventory" }
        if ($exposedWorkerPrefixes.Count -lt 1) { Add-Failure "current-channel-worker-transport summary missing failed-state exposed worker prefix inventory" }
        Assert-DistinctWorkerTransportFailures -Label "current-channel-worker-transport summary" -Tools $transportFailedTools
        if ($evidence.workerStatus -ne "transport_closed") { Add-Failure "current-channel-worker-transport summary worker failure status mismatch" }
        if ($evidence.splitObserved -ne $true) { Add-Failure "current-channel-worker-transport summary did not prove split" }
        if ($evidence.currentChannelWorkerDispatchBlocked -ne $true) { Add-Failure "current-channel-worker-transport summary did not block worker dispatch" }
        if ($evidence.currentChannelWorkerDispatchUsable -ne $false) { Add-Failure "current-channel-worker-transport summary unexpectedly marked worker dispatch usable" }
    } else {
        if ([int]$evidence.workerObservationCount -lt 1) { Add-Failure "current-channel-worker-transport summary healthy worker observation count too low" }
        if ([int]$evidence.workerTransportOkCount -lt 1) { Add-Failure "current-channel-worker-transport summary healthy worker ok count too low" }
        if ($transportOkTools.Count -lt 1) { Add-Failure "current-channel-worker-transport summary missing healthy worker ok tool" }
        if ($observedWorkerPrefixes.Count -lt 1) { Add-Failure "current-channel-worker-transport summary missing healthy observed worker prefix" }
        if ($exposedWorkerPrefixes.Count -lt 7) { Add-Failure "current-channel-worker-transport summary missing healthy exposed worker prefix inventory" }
        if ($missingExpectedWorkerPrefixes.Count -ne 0) { Add-Failure "current-channel-worker-transport summary healthy state has missing expected worker prefixes" }
        if ($evidence.currentChannelWorkerDispatchUsable -ne $true) { Add-Failure "current-channel-worker-transport summary did not mark healthy worker dispatch usable" }
    }
}

function Test-CurrentChannelWorkerRecoverySummaryEvidence {
    param($CurrentChannelWorkerRecoverySummary)
    if (-not $CurrentChannelWorkerRecoverySummary) {
        Add-Failure "diagnostic reports summary missing latest-current-channel-worker-recovery.json"
        return
    }

    $evidence = $CurrentChannelWorkerRecoverySummary.currentChannelWorkerRecoveryEvidence
    if (-not $evidence) {
        Add-Failure "current-channel-worker-recovery summary missing currentChannelWorkerRecoveryEvidence"
        return
    }

    if ($evidence.reportName -ne "current-channel-worker-recovery") { Add-Failure "current-channel-worker-recovery summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "current-channel-worker-recovery summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "current-channel-worker-recovery summary used real traffic" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "current-channel-worker-recovery summary behavior not covered" }
    if ($evidence.coverageKind -ne "current-channel-worker-recovery-report-only") { Add-Failure "current-channel-worker-recovery summary coverage kind mismatch" }
    if ($evidence.requiresCodexMcpReload -ne $true) { Add-Failure "current-channel-worker-recovery summary missing reload requirement" }
    if ($evidence.requiresFreshReadOnlyProbe -ne $true) { Add-Failure "current-channel-worker-recovery summary missing fresh read-only probe requirement" }
    if ($evidence.currentChannelWorkerDispatchUsable -ne $false) { Add-Failure "current-channel-worker-recovery summary unexpectedly marks dispatch usable" }
    if (-not $evidence.repeatedFailureAudit) { Add-Failure "current-channel-worker-recovery summary missing repeated failure audit" }
    else {
        if ([int]$evidence.repeatedFailureAudit.threshold -lt 3) { Add-Failure "current-channel-worker-recovery repeated failure threshold too low" }
        if ([int]$evidence.repeatedFailureAudit.failedObservationCount -lt 3) { Add-Failure "current-channel-worker-recovery repeated failure count too low" }
        if ([int]$evidence.repeatedFailureAudit.okObservationCount -ne 0) { Add-Failure "current-channel-worker-recovery repeated failure ok count mismatch" }
        if ($evidence.repeatedFailureAudit.repeatedCurrentChannelWorkerFailure -ne $true) { Add-Failure "current-channel-worker-recovery repeated failure flag missing" }
        if ($evidence.repeatedFailureAudit.sameChannelRetryRecommended -ne $false) { Add-Failure "current-channel-worker-recovery still recommends same-channel retry" }
        if ([string]$evidence.repeatedFailureAudit.recommendedAction -ne "stop_same_channel_worker_retries_and_use_fresh_channel_or_reload") { Add-Failure "current-channel-worker-recovery repeated failure action mismatch" }
    }
    if ($evidence.operatorActionCard) {
        if ($evidence.operatorActionCard.repeatedCurrentChannelWorkerFailure -ne $true) { Add-Failure "current-channel-worker-recovery operator card repeated failure flag missing" }
        if ($evidence.operatorActionCard.sameChannelRetryRecommended -ne $false) { Add-Failure "current-channel-worker-recovery operator card still recommends same-channel retry" }
        if ([string]$evidence.operatorActionCard.nextOperatorAction -ne "stop_same_channel_worker_retries_and_use_fresh_channel_or_reload") { Add-Failure "current-channel-worker-recovery operator card next action mismatch" }
    }
    if ($evidence.genericMcpControlOk -ne $true) { Add-Failure "current-channel-worker-recovery summary missing generic MCP proof" }
    if ($evidence.directProbeOk -ne $true) { Add-Failure "current-channel-worker-recovery summary missing direct server probe proof" }
    if ($evidence.directStatusProbeOk -ne $true) { Add-Failure "current-channel-worker-recovery summary missing direct status probe proof" }
    if ([int]$evidence.directStatusProbeStatusCallOkCount -lt 6) { Add-Failure "current-channel-worker-recovery summary direct status probe count too low" }
    if (@(As-FlatArray $evidence.directStatusProbeFailedWorkers).Count -ne 0) { Add-Failure "current-channel-worker-recovery summary has failed direct status probe workers" }
    if ($evidence.directStatusProbeAntigravitySkippedForAccountIsolation -ne $true) { Add-Failure "current-channel-worker-recovery summary missing Antigravity account-isolation skip" }
    if ($evidence.directStatusProbeCurrentChannelCaveatPresent -ne $true) { Add-Failure "current-channel-worker-recovery summary missing current-channel caveat" }
    if (@(As-FlatArray $evidence.postReloadAcceptanceCriteria | Where-Object { [string]$_ -match "direct worker status probe" }).Count -lt 1) {
        Add-Failure "current-channel-worker-recovery summary missing direct status probe acceptance criterion"
    }
    $recommendedProbes = @(As-FlatArray $evidence.recommendedReadOnlyProbes)
    if ($recommendedProbes.Count -lt 3) { Add-Failure "current-channel-worker-recovery summary missing recommended read-only probe candidates" }
    $recommendedTools = @($recommendedProbes | ForEach-Object { [string]$_.statusTool } | Where-Object { $_ })
    $recommendedJobIds = @($recommendedProbes | ForEach-Object { [string]$_.jobId } | Where-Object { $_ })
    if ($recommendedTools -notcontains "kilo_wait_for_job") { Add-Failure "current-channel-worker-recovery summary missing Kilo read-only probe candidate" }
    if ($recommendedTools -notcontains "deepseek_wait_for_job") { Add-Failure "current-channel-worker-recovery summary missing DeepSeek read-only probe candidate" }
    if ($recommendedTools -notcontains "opencode_wait_for_job") { Add-Failure "current-channel-worker-recovery summary missing OpenCode read-only probe candidate" }
    if ($recommendedJobIds.Count -lt $recommendedProbes.Count) { Add-Failure "current-channel-worker-recovery summary has recommended probes without job ids" }
    $exposedRecommendedProbes = @(As-FlatArray $evidence.exposedRecommendedReadOnlyProbes)
    if ($exposedRecommendedProbes.Count -lt 1) { Add-Failure "current-channel-worker-recovery summary missing exposed recommended read-only probes" }
    $exposedRecommendedTools = @($exposedRecommendedProbes | ForEach-Object { [string]$_.statusTool } | Where-Object { $_ })
    if (-not $evidence.operatorActionCard -or -not $evidence.operatorActionCard.recommendedFirstReadOnlyProbe -or -not [string]$evidence.operatorActionCard.recommendedFirstReadOnlyProbe.statusTool) {
        Add-Failure "current-channel-worker-recovery summary missing first recommended read-only probe"
    } elseif ($exposedRecommendedTools.Count -gt 0 -and $exposedRecommendedTools -notcontains ([string]$evidence.operatorActionCard.recommendedFirstReadOnlyProbe.statusTool)) {
        Add-Failure "current-channel-worker-recovery summary first recommended probe is not from exposed candidates"
    }
}

function Test-GoalUnblockPackageSummaryEvidence {
    param($GoalUnblockPackageSummary)
    if (-not $GoalUnblockPackageSummary) {
        Add-Failure "diagnostic reports summary missing latest-goal-unblock-package.json"
        return
    }

    $evidence = $GoalUnblockPackageSummary.goalUnblockPackageEvidence
    if (-not $evidence) {
        Add-Failure "goal-unblock-package summary missing goalUnblockPackageEvidence"
        return
    }

    if ($evidence.reportName -ne "goal-unblock-package") { Add-Failure "goal-unblock-package summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "goal-unblock-package summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "goal-unblock-package summary used real traffic" }
    if ($evidence.changedSystem -ne $false) { Add-Failure "goal-unblock-package summary changed system" }
    if ($evidence.createdUser -ne $false) { Add-Failure "goal-unblock-package summary created user" }
    if ($evidence.startedLogin -ne $false) { Add-Failure "goal-unblock-package summary started login" }
    if ($evidence.capturesPassword -ne $false) { Add-Failure "goal-unblock-package summary captures password" }
    if ($evidence.storesPassword -ne $false) { Add-Failure "goal-unblock-package summary stores password" }
    if ($evidence.behaviorCovered -ne $true) { Add-Failure "goal-unblock-package summary behavior not covered" }
    if ($evidence.coverageKind -ne "goal-unblock-package-report-only") { Add-Failure "goal-unblock-package summary coverage kind mismatch" }
    if ($evidence.goalComplete -ne $true) { Add-Failure "goal-unblock-package summary goal not complete" }
    if ($evidence.canClaimFullGoalNow -ne $true) { Add-Failure "goal-unblock-package summary does not claim current goal" }
    if ($evidence.fullObjectiveCanClaimFullGoalNow -ne $false) { Add-Failure "goal-unblock-package summary claims full objective" }
    if ($evidence.releaseReady -ne $true) { Add-Failure "goal-unblock-package summary release not ready" }
    $remainingIds = @(As-FlatArray $evidence.remainingObjectiveRequirementIds | ForEach-Object { [string]$_ })
    if ($remainingIds.Count -ne 0) { Add-Failure "goal-unblock-package summary current remaining requirements not empty" }
    $deferredIds = @(As-FlatArray $evidence.deferredObjectiveRequirementIds | ForEach-Object { [string]$_ })
    $incompleteDeferredIds = @(As-FlatArray $evidence.incompleteDeferredObjectiveRequirementIds | ForEach-Object { [string]$_ })
    foreach ($requiredId in @("separate_antigravity_accounts", "worker_mcp_multiuse")) {
        if ($deferredIds -notcontains $requiredId) { Add-Failure "goal-unblock-package summary missing deferred requirement: $requiredId" }
        if ($incompleteDeferredIds -notcontains $requiredId) { Add-Failure "goal-unblock-package summary missing incomplete deferred requirement: $requiredId" }
    }
    $blockers = @(As-FlatArray $evidence.blockers | ForEach-Object { [string]$_ })
    if ($blockers.Count -ne 0) { Add-Failure "goal-unblock-package summary current blockers not empty" }
    $deferredBlockers = @(As-FlatArray $evidence.deferredBlockers | ForEach-Object { [string]$_ })
    foreach ($requiredBlocker in @("current_channel_worker_transport_not_recovered", "second_antigravity_account_real_proof_missing")) {
        if ($deferredBlockers -notcontains $requiredBlocker) { Add-Failure "goal-unblock-package summary missing deferred blocker: $requiredBlocker" }
    }
    if ($evidence.freshChannelWorkerRequiresFreshCodexChannel -ne $true) { Add-Failure "goal-unblock-package summary missing fresh channel requirement" }
    if ($evidence.freshChannelWorkerRequiresFreshReadOnlyProbe -ne $true) { Add-Failure "goal-unblock-package summary missing fresh read-only probe requirement" }
    if ($evidence.freshChannelWorkerSameChannelRetryRecommended -ne $false) { Add-Failure "goal-unblock-package summary still recommends same-channel retry" }
    if (-not ([string]$evidence.freshChannelWorkerLatestTransportCheckedAt).StartsWith("20")) { Add-Failure "goal-unblock-package summary missing fresh worker transport timestamp" }
    if ([int]$evidence.freshChannelWorkerObservationCount -lt 3) { Add-Failure "goal-unblock-package summary worker observation count too low" }
    if ([int]$evidence.freshChannelWorkerTransportFailedCount -lt 3) { Add-Failure "goal-unblock-package summary worker failed count too low" }
    if ([int]$evidence.freshChannelWorkerTransportOkCount -ne 0) { Add-Failure "goal-unblock-package summary worker ok count unexpected" }
    if ($evidence.freshChannelWorkerGenericMcpControlOk -ne $true) { Add-Failure "goal-unblock-package summary missing generic MCP control proof" }
    if ($evidence.freshChannelWorkerDirectProbeOk -ne $true) { Add-Failure "goal-unblock-package summary missing direct worker probe proof" }
    if ([string]$evidence.freshChannelWorkerFirstProbeTool -ne "mimocode_wait_for_job") { Add-Failure "goal-unblock-package summary first probe mismatch" }
    if (-not ([string]$evidence.freshChannelWorkerRecordCommand).Contains("record-anticodex-current-channel-worker-transport.mjs")) { Add-Failure "goal-unblock-package summary worker record command missing" }
    if ($evidence.secondAccountRequiresUserPresence -ne $true) { Add-Failure "goal-unblock-package summary missing second-account user presence" }
    if ([string]$evidence.secondAccountWindowsUser -ne ".\AntiCodexModel") { Add-Failure "goal-unblock-package summary second-account Windows user mismatch" }
    if ($evidence.secondAccountTargetUserExists -ne $false) { Add-Failure "goal-unblock-package summary target user unexpectedly exists" }
    if ($evidence.secondAccountSafeToAskUserForSecondAccountLogin -ne $false) { Add-Failure "goal-unblock-package summary asks login too early" }
    if ([string]$evidence.secondAccountPostLoginProofStatus -ne "blocked_before_login") { Add-Failure "goal-unblock-package summary post-login status mismatch" }
    if ($evidence.secondAccountEffectiveAntiCodexAccountIdPresent -ne $true) { Add-Failure "goal-unblock-package summary missing Anti-Codex account id suggestion" }
    if ($evidence.secondAccountEffectiveMcpAccountIdPresent -ne $false) { Add-Failure "goal-unblock-package summary should not invent MCP account id" }
    if ($evidence.externalMcpIdentityContractReportPresent -ne $true) { Add-Failure "goal-unblock-package summary missing external MCP identity contract" }
    if ($evidence.externalMcpIdentityContractAccepted -ne $true) { Add-Failure "goal-unblock-package summary external MCP identity not accepted" }
    if ($evidence.externalMcpIdentityManagedByAntiCodex -ne $false) { Add-Failure "goal-unblock-package summary external MCP identity managed by Anti-Codex" }
    $actionIds = @(As-FlatArray $evidence.machineReadableNextActionIds | ForEach-Object { [string]$_ })
    foreach ($actionId in @("fresh_channel_worker_read_only_probe", "create_or_verify_second_windows_user", "external_mcp_account_identity_report", "approved_second_account_post_login_proof")) {
        if ($actionIds -notcontains $actionId) { Add-Failure "goal-unblock-package summary missing action: $actionId" }
    }
}

function Test-FreshChannelWorkerProofKitSummaryEvidence {
    param($FreshChannelWorkerProofKitSummary)
    if (-not $FreshChannelWorkerProofKitSummary) {
        Add-Failure "diagnostic reports summary missing latest-fresh-channel-worker-proof-kit.json"
        return
    }

    $evidence = $FreshChannelWorkerProofKitSummary.freshChannelWorkerProofKitEvidence
    if (-not $evidence) {
        Add-Failure "fresh-channel-worker-proof-kit summary missing freshChannelWorkerProofKitEvidence"
        return
    }

    if ($evidence.reportName -ne "fresh-channel-worker-proof-kit") { Add-Failure "fresh-channel-worker-proof-kit summary reportName mismatch" }
    if ($evidence.requestedRealTraffic -ne $false) { Add-Failure "fresh-channel-worker-proof-kit summary requested real traffic" }
    if ($evidence.usedRealTraffic -ne $false) { Add-Failure "fresh-channel-worker-proof-kit summary used real traffic" }
    if ($evidence.startsWorkerImplementation -ne $false) { Add-Failure "fresh-channel-worker-proof-kit summary starts worker implementation" }
    if ($evidence.allowImplementationDispatchBeforeReadOnlySuccess -ne $false) { Add-Failure "fresh-channel-worker-proof-kit summary allows dispatch too early" }
    if ($evidence.workerTransportOkCriterion -ne $true) { Add-Failure "fresh-channel-worker-proof-kit summary missing worker success criterion" }
    if ($evidence.genericMcpControlOkCriterion -ne $true) { Add-Failure "fresh-channel-worker-proof-kit summary missing generic MCP criterion" }
    if ($evidence.recordedByTransportReportCriterion -ne $true) { Add-Failure "fresh-channel-worker-proof-kit summary missing record criterion" }
    if ([int]$evidence.recommendedReadOnlyProbeCount -lt 3) { Add-Failure "fresh-channel-worker-proof-kit summary probe count too low" }
    if ([string]$evidence.recommendedFirstReadOnlyProbeTool -ne "mimocode_wait_for_job") { Add-Failure "fresh-channel-worker-proof-kit summary first probe mismatch" }
    if (-not ([string]$evidence.recordSuccessCommand).Contains("record-anticodex-current-channel-worker-transport.mjs")) { Add-Failure "fresh-channel-worker-proof-kit summary record command missing" }
    if (-not ([string]$evidence.postSuccessValidationCommand).Contains("test-anticodex-current-channel-worker-recovery")) { Add-Failure "fresh-channel-worker-proof-kit summary post-success command missing" }
    if (-not ([string]$evidence.goalValidationCommand).Contains("test-anticodex-goal-readiness")) { Add-Failure "fresh-channel-worker-proof-kit summary goal command missing" }
    if ([int]$evidence.forbiddenBeforeSuccessCount -lt 3) { Add-Failure "fresh-channel-worker-proof-kit summary forbidden-before-success list too short" }
}

function Test-ReportsSummary {
    param(
        [Parameter(Mandatory = $true)][string]$SummaryPath,
        [bool]$RequireReleaseReady = $true
    )
    if (-not (Test-Path -LiteralPath $SummaryPath -PathType Leaf)) {
        Add-Failure "reports summary file missing: $SummaryPath"
        return $null
    }

    $summary = As-FlatArray (Get-Content -LiteralPath $SummaryPath -Raw | ConvertFrom-Json)
    $releaseGatesSummary = @($summary | Where-Object { $_.file -eq "latest-release-gates.json" } | Select-Object -First 1)[0]
    $localConnectorsSummary = @($summary | Where-Object { $_.file -eq "latest-local-connectors.json" } | Select-Object -First 1)[0]
    $syncReadinessSummary = @($summary | Where-Object { $_.file -eq "latest-sync-readiness.json" } | Select-Object -First 1)[0]
    $refreshFeaturesSummary = @($summary | Where-Object { $_.file -eq "latest-refresh-features.json" } | Select-Object -First 1)[0]
    $desktopTaskSuiteSummary = @($summary | Where-Object { $_.file -eq "latest-desktop-task-suite.json" } | Select-Object -First 1)[0]
    $goalReadinessSummary = @($summary | Where-Object { $_.file -eq "latest-goal-readiness.json" } | Select-Object -First 1)[0]
    $goalUnblockPackageSummary = @($summary | Where-Object { $_.file -eq "latest-goal-unblock-package.json" } | Select-Object -First 1)[0]
    $freshChannelWorkerProofKitSummary = @($summary | Where-Object { $_.file -eq "latest-fresh-channel-worker-proof-kit.json" } | Select-Object -First 1)[0]
    $cliTransportBoundarySummary = @($summary | Where-Object { $_.file -eq "latest-cli-transport-boundary.json" } | Select-Object -First 1)[0]
    $longTaskLandingMatrixSummary = @($summary | Where-Object { $_.file -eq "latest-long-task-landing-matrix.json" } | Select-Object -First 1)[0]
    $agenticCapabilityMatrixSummary = @($summary | Where-Object { $_.file -eq "latest-agentic-capability-matrix.json" } | Select-Object -First 1)[0]
    $realTaskCoverageRoadmapSummary = @($summary | Where-Object { $_.file -eq "latest-real-task-coverage-roadmap.json" } | Select-Object -First 1)[0]
    $nativeCodexParityTaskMatrixSummary = @($summary | Where-Object { $_.file -eq "latest-native-codex-parity-task-matrix.json" } | Select-Object -First 1)[0]
    $realApprovalPlanSummary = @($summary | Where-Object { $_.file -eq "latest-real-approval-plan.json" } | Select-Object -First 1)[0]
    $requiredRealTrafficSequenceSummary = @($summary | Where-Object { $_.file -eq "latest-required-real-traffic-sequence.json" } | Select-Object -First 1)[0]
    $goalRealRunReadinessSummary = @($summary | Where-Object { $_.file -eq "latest-goal-real-run-readiness.json" } | Select-Object -First 1)[0]
    $approvedRealRunSequenceSummary = @($summary | Where-Object { $_.file -eq "latest-approved-real-run-sequence.json" } | Select-Object -First 1)[0]
    $workerMcpServerProbeSummary = @($summary | Where-Object { $_.file -eq "latest-worker-mcp-server-probe.json" } | Select-Object -First 1)[0]
    $workerMcpStatusProbeSummary = @($summary | Where-Object { $_.file -eq "latest-worker-mcp-status-probe.json" } | Select-Object -First 1)[0]
    $workerMcpTaskSmokeSummary = @($summary | Where-Object { $_.file -eq "latest-worker-mcp-task-smoke.json" } | Select-Object -First 1)[0]
    $workerMcpProjectSmokeSummary = @($summary | Where-Object { $_.file -eq "latest-worker-mcp-project-smoke.json" } | Select-Object -First 1)[0]
    $xiaoqiangWorkerMcpProjectSmokeSummary = @($summary | Where-Object { $_.file -eq "latest-xiaoqiang-worker-mcp-project-smoke.json" } | Select-Object -First 1)[0]
    $workerMcpComplexProjectSmokeSummary = @($summary | Where-Object { $_.file -eq "latest-worker-mcp-complex-project-smoke.json" } | Select-Object -First 1)[0]
    $currentChannelWorkerTransportSummary = @($summary | Where-Object { $_.file -eq "latest-current-channel-worker-transport.json" } | Select-Object -First 1)[0]
    $currentChannelWorkerRecoverySummary = @($summary | Where-Object { $_.file -eq "latest-current-channel-worker-recovery.json" } | Select-Object -First 1)[0]
    $secondAccountLoginEntrypointSummary = @($summary | Where-Object { $_.file -eq "latest-second-antigravity-account-login-entrypoint.json" } | Select-Object -First 1)[0]
    $secondAccountReadinessSummary = @($summary | Where-Object { $_.file -eq "latest-second-account-readiness-summary.json" } | Select-Object -First 1)[0]
    $secondAccountPostLoginProofSummary = @($summary | Where-Object { $_.file -eq "latest-second-account-post-login-proof.json" } | Select-Object -First 1)[0]
    $externalMcpIdentityContractSummary = @($summary | Where-Object { $_.file -eq "latest-external-mcp-identity-contract.json" } | Select-Object -First 1)[0]
    if (-not $releaseGatesSummary) {
        Add-Failure "reports summary missing latest-release-gates.json"
    } else {
        if (-not (Has-Property $releaseGatesSummary "ok")) { Add-Failure "release-gates summary missing ok" }
        elseif ($RequireReleaseReady -and $releaseGatesSummary.ok -ne $true) { Add-Failure "release-gates summary ok=false" }
        if (-not (Has-Property $releaseGatesSummary "shortReady")) { Add-Failure "release-gates summary missing shortReady" }
        elseif ($RequireReleaseReady -and $releaseGatesSummary.shortReady -ne $true) { Add-Failure "release-gates summary shortReady is not true" }
        if (-not (Has-Property $releaseGatesSummary "releaseReady")) { Add-Failure "release-gates summary missing releaseReady" }
        elseif ($RequireReleaseReady -and $releaseGatesSummary.releaseReady -ne $true) { Add-Failure "release-gates summary releaseReady is not true" }
        if (-not (Has-Property $releaseGatesSummary "effectiveOk")) { Add-Failure "release-gates summary missing effectiveOk" }
        elseif ($RequireReleaseReady -and $releaseGatesSummary.effectiveOk -ne $true) { Add-Failure "release-gates summary effectiveOk is not true" }
        if (-not (Has-Property $releaseGatesSummary "releaseBlockedOnlyByRequiredRealTraffic")) { Add-Failure "release-gates summary missing required real-traffic-only blocker flag" }
        if (-not (Has-Property $releaseGatesSummary "requiredRealTrafficBlockedGates")) { Add-Failure "release-gates summary missing required real-traffic blocker gate IDs" }
        if (-not (Has-Property $releaseGatesSummary "strictOptionalRealTraffic")) { Add-Failure "release-gates summary missing strict optional real-traffic flag" }
        if (-not (Has-Property $releaseGatesSummary "optionalRealTrafficReady")) { Add-Failure "release-gates summary missing optional real-traffic readiness" }
        if (-not (Has-Property $releaseGatesSummary "optionalRealTrafficFailures")) { Add-Failure "release-gates summary missing optional real-traffic failures" }
        if (-not (Has-Property $releaseGatesSummary "missingRequired")) { Add-Failure "release-gates summary missing missingRequired" }
        if (-not (Has-Property $releaseGatesSummary "missingShort")) { Add-Failure "release-gates summary missing missingShort" }
        if (-not (Has-Property $releaseGatesSummary "missingOptional")) { Add-Failure "release-gates summary missing missingOptional" }
        if (-not (Has-Property $releaseGatesSummary "damagedReports")) { Add-Failure "release-gates summary missing damagedReports" }
        if (-not (Has-Property $releaseGatesSummary "releaseGateFailures")) { Add-Failure "release-gates summary missing semantic failure details" }
        if (-not (Has-Property $releaseGatesSummary "releaseGateFailureReasons")) { Add-Failure "release-gates summary missing failure reason details" }
        Test-ReleaseGateApprovalAndOfflineEvidence $releaseGatesSummary
        if (-not (Has-Property $releaseGatesSummary "releaseGateSelectedReports")) { Add-Failure "release-gates summary missing selected history report details" }
        $selectedReports = @(As-FlatArray $releaseGatesSummary.releaseGateSelectedReports)
        foreach ($selectedGate in @(As-FlatArray $releaseGatesSummary.releaseGateFailureReasons | Where-Object { $_.selectedFromHistory -eq $true })) {
            $selectedGateId = [string]$selectedGate.id
            if ([string]::IsNullOrWhiteSpace($selectedGateId)) { continue }
            $matchingSelectedReports = @($selectedReports | Where-Object { [string]$_.id -eq $selectedGateId -and -not [string]::IsNullOrWhiteSpace([string]$_.selectedFile) })
            if ($matchingSelectedReports.Count -lt 1) {
                Add-Failure "release-gates selected history gate $selectedGateId missing selected report detail"
            } elseif (@($matchingSelectedReports | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.selectedMtime) }).Count -lt 1) {
                Add-Failure "release-gates selected history gate $selectedGateId missing selected report mtime"
            }
            if ($selectedGate.historySourceMismatch -eq $true -and @($matchingSelectedReports | Where-Object { $_.historySourceMismatch -eq $true }).Count -lt 1) {
                Add-Failure "release-gates selected history gate $selectedGateId missing history source mismatch detail"
            }
        }
        Test-InstalledRuntimeEvidence $releaseGatesSummary.installedRuntimeEvidence
    }
    if ($RequireReleaseReady -or $refreshFeaturesSummary) { Test-RefreshFeaturesSummarySupportEvidence $refreshFeaturesSummary }
    if ($RequireReleaseReady -or $desktopTaskSuiteSummary) { Test-DesktopTaskSuiteSummaryEvidence $desktopTaskSuiteSummary }
    if ($RequireReleaseReady -or $goalReadinessSummary) { Test-GoalReadinessSummaryEvidence $goalReadinessSummary }
    if ($RequireReleaseReady -or $goalUnblockPackageSummary) { Test-GoalUnblockPackageSummaryEvidence $goalUnblockPackageSummary }
    if ($RequireReleaseReady -or $freshChannelWorkerProofKitSummary) { Test-FreshChannelWorkerProofKitSummaryEvidence $freshChannelWorkerProofKitSummary }
    if ($RequireReleaseReady -or $cliTransportBoundarySummary) { Test-CliTransportBoundarySummaryEvidence $cliTransportBoundarySummary }
    if ($RequireReleaseReady -or $longTaskLandingMatrixSummary) { Test-LongTaskLandingMatrixSummaryEvidence $longTaskLandingMatrixSummary }
    if ($RequireReleaseReady -or $agenticCapabilityMatrixSummary) { Test-AgenticCapabilityMatrixSummaryEvidence $agenticCapabilityMatrixSummary }
    if ($RequireReleaseReady -or $realTaskCoverageRoadmapSummary) { Test-RealTaskCoverageRoadmapSummaryEvidence $realTaskCoverageRoadmapSummary }
    if ($RequireReleaseReady -or $nativeCodexParityTaskMatrixSummary) { Test-NativeCodexParityTaskMatrixSummaryEvidence $nativeCodexParityTaskMatrixSummary }
    if ($RequireReleaseReady -or $realApprovalPlanSummary) { Test-RealApprovalPlanSummaryEvidence $realApprovalPlanSummary }
    if ($RequireReleaseReady -or $requiredRealTrafficSequenceSummary) { Test-RequiredRealTrafficSequenceSummaryEvidence $requiredRealTrafficSequenceSummary }
    if ($RequireReleaseReady -or $goalRealRunReadinessSummary) { Test-GoalRealRunReadinessSummaryEvidence $goalRealRunReadinessSummary }
    if ($RequireReleaseReady -or $approvedRealRunSequenceSummary) { Test-ApprovedRealRunSequenceSummaryEvidence $approvedRealRunSequenceSummary }
    if ($RequireReleaseReady -or $workerMcpServerProbeSummary) { Test-WorkerMcpServerProbeSummaryEvidence $workerMcpServerProbeSummary }
    if ($RequireReleaseReady -or $workerMcpStatusProbeSummary) { Test-WorkerMcpStatusProbeSummaryEvidence $workerMcpStatusProbeSummary }
    if ($RequireReleaseReady -or $workerMcpTaskSmokeSummary) { Test-WorkerMcpTaskSmokeSummaryEvidence $workerMcpTaskSmokeSummary }
    if ($RequireReleaseReady -or $workerMcpProjectSmokeSummary) { Test-WorkerMcpProjectSmokeSummaryEvidence $workerMcpProjectSmokeSummary }
    if ($RequireReleaseReady -or $xiaoqiangWorkerMcpProjectSmokeSummary) { Test-XiaoqiangWorkerMcpProjectSmokeSummaryEvidence $xiaoqiangWorkerMcpProjectSmokeSummary }
    if ($RequireReleaseReady -or $workerMcpComplexProjectSmokeSummary) { Test-XiaoqiangWorkerMcpComplexProjectSmokeSummaryEvidence $workerMcpComplexProjectSmokeSummary }
    if ($RequireReleaseReady -or $currentChannelWorkerTransportSummary) { Test-CurrentChannelWorkerTransportSummaryEvidence $currentChannelWorkerTransportSummary }
    if ($RequireReleaseReady -or $currentChannelWorkerRecoverySummary) { Test-CurrentChannelWorkerRecoverySummaryEvidence $currentChannelWorkerRecoverySummary }
    if ($RequireReleaseReady -or $secondAccountLoginEntrypointSummary) { Test-SecondAccountLoginEntrypointSummaryEvidence $secondAccountLoginEntrypointSummary }
    if ($RequireReleaseReady -or $secondAccountReadinessSummary) { Test-SecondAccountReadinessSummaryEvidence $secondAccountReadinessSummary }
    if ($RequireReleaseReady -or $secondAccountPostLoginProofSummary) { Test-SecondAccountPostLoginProofEvidence $secondAccountPostLoginProofSummary }
    if ($RequireReleaseReady -or $externalMcpIdentityContractSummary) { Test-ExternalMcpIdentityContractSummaryEvidence $externalMcpIdentityContractSummary }
    if ($localConnectorsSummary) {
        if ($localConnectorsSummary.ok -ne $true) { Add-Failure "local connector summary ok=false" }
        if ($localConnectorsSummary.reportName -ne "local-connectors") { Add-Failure "local connector summary missing reportName" }
        if ($localConnectorsSummary.usedRealTraffic -ne $false) { Add-Failure "local connector summary used real traffic" }
        if ($localConnectorsSummary.behaviorCovered -ne $true) { Add-Failure "local connector summary behavior not covered" }
        if ($localConnectorsSummary.coverageKind -ne "local-fake-provider") { Add-Failure "local connector summary coverageKind mismatch" }
        $localEvidence = $localConnectorsSummary.localConnectorEvidence
        if (-not $localEvidence) {
            Add-Failure "local connector summary missing localConnectorEvidence"
        } else {
            if ($localEvidence.linkedConnectorAccessible -ne $true) { Add-Failure "local connector summary missing linked connector access proof" }
            if ($localEvidence.chatgptInstallUrlsScrubbed -ne $true) { Add-Failure "local connector summary missing ChatGPT URL scrub evidence" }
            if ($localEvidence.linkEndpointsUnsupported -ne $true) { Add-Failure "local connector summary missing metadata-only link endpoint evidence" }
            if ([int]$localEvidence.upstreamRequestsDuringLocalEndpoints -ne 0) { Add-Failure "local connector summary recorded upstream requests during local endpoints" }
            if ([int]$localEvidence.upstreamRequestsBeforeLocalEndpoints -ne [int]$localEvidence.upstreamRequestsAfterLocalEndpoints) { Add-Failure "local connector summary before/after upstream request counts differ" }
            if ($localEvidence.allowlistedConnectorAccessible -ne $false) { Add-Failure "local connector summary treats allowlist as access" }
            if ($localEvidence.allowlistedConnectorLocallyAllowlisted -ne $true) { Add-Failure "local connector summary missing local allowlist evidence" }
            if ($localEvidence.hiddenConnectorAccessible -ne $false) { Add-Failure "local connector summary exposes hidden connector" }
            if ([int]$localEvidence.exposedToolsPost -ne [int]$localEvidence.exposedToolsGet) { Add-Failure "local connector summary GET/POST tool counts differ" }
            if (@($localEvidence.exposedToolNames).Count -ne [int]$localEvidence.exposedToolsPost) { Add-Failure "local connector summary exposed tool names mismatch" }
            if ($localEvidence.connectorParityClean -ne $true) { Add-Failure "local connector summary missing connector parity proof" }
            if ($localEvidence.connectorFingerprintMatches -ne $true) { Add-Failure "local connector summary missing connector fingerprint match proof" }
            if (-not (Has-Property $localEvidence "connectorParityMissingShared")) { Add-Failure "local connector summary missing connector missing-shared drift samples" }
            if (-not (Has-Property $localEvidence "connectorParityExtraLocal")) { Add-Failure "local connector summary missing connector extra-local drift samples" }
            if (-not (Has-Property $localEvidence "connectorParityChangedShared")) { Add-Failure "local connector summary missing connector changed-shared drift samples" }
            if ($localEvidence.appToolParityClean -ne $true) { Add-Failure "local connector summary missing app-tool parity proof" }
            if ($localEvidence.appToolFingerprintMatches -ne $true) { Add-Failure "local connector summary missing app-tool fingerprint match proof" }
            if (-not (Has-Property $localEvidence "appToolParityMissingShared")) { Add-Failure "local connector summary missing app-tool missing-shared drift samples" }
            if (-not (Has-Property $localEvidence "appToolParityExtraLocal")) { Add-Failure "local connector summary missing app-tool extra-local drift samples" }
            if (-not (Has-Property $localEvidence "appToolParityChangedShared")) { Add-Failure "local connector summary missing app-tool changed-shared drift samples" }
            if ($localEvidence.appToolGetPostParityClean -ne $true) { Add-Failure "local connector summary missing GET/POST app-tool parity proof" }
            if ($localEvidence.tempSharedHomeUsed -ne $false) { Add-Failure "local connector summary used shared home during temp isolation" }
            if ($localEvidence.tempCodexHomeUnderStateRoot -ne $true) { Add-Failure "local connector summary missing temp CODEX_HOME isolation proof" }
            if ($localEvidence.tempSharedCodexHomeUnderStateRoot -ne $true) { Add-Failure "local connector summary missing temp shared home isolation proof" }
            if ($localEvidence.tempCodexHomeDistinctFromShared -ne $true) { Add-Failure "local connector summary CODEX_HOME is not distinct from shared home" }
            $exposedToolNames = @(As-FlatArray $localEvidence.exposedToolNames)
            if ($exposedToolNames.Count -ne 1 -or $exposedToolNames[0] -ne "linked_tool") {
                Add-Failure "local connector summary exposed tool names is not exactly one 'linked_tool'"
            }
        }
    }
    if ($syncReadinessSummary) {
        Test-SyncReadinessEvidence $syncReadinessSummary.syncReadinessEvidence "sync-readiness summary" -RequireReady:$false
    }

    return [pscustomobject]@{
        summaryPath = $SummaryPath
        reportCount = @($summary).Count
        releaseGates = if ($releaseGatesSummary) {
            [pscustomobject]@{
                ok = $releaseGatesSummary.ok
                shortReady = $releaseGatesSummary.shortReady
                releaseReady = $releaseGatesSummary.releaseReady
                effectiveOk = $releaseGatesSummary.effectiveOk
                missingRequired = @($releaseGatesSummary.missingRequired)
                missingShort = @($releaseGatesSummary.missingShort)
                missingOptional = @($releaseGatesSummary.missingOptional)
                releaseGateGroups = @($releaseGatesSummary.releaseGateGroups)
                releaseGateFailureReasons = @($releaseGatesSummary.releaseGateFailureReasons)
                nextActions = @($releaseGatesSummary.nextActions)
                nextActionsAvailableCount = $releaseGatesSummary.nextActionsAvailableCount
                nextActionsHiddenCount = $releaseGatesSummary.nextActionsHiddenCount
                nextActionsTruncated = $releaseGatesSummary.nextActionsTruncated
                approvalPlan = $releaseGatesSummary.approvalPlan
                installedRuntimeEvidence = $releaseGatesSummary.installedRuntimeEvidence
            }
        } else { $null }
        localConnectors = if ($localConnectorsSummary) {
            [pscustomobject]@{
                ok = $localConnectorsSummary.ok
                reportName = $localConnectorsSummary.reportName
                evidence = $localConnectorsSummary.localConnectorEvidence
            }
        } else { $null }
        syncReadiness = if ($syncReadinessSummary) {
            [pscustomobject]@{
                ok = $syncReadinessSummary.ok
                evidence = $syncReadinessSummary.syncReadinessEvidence
            }
        } else { $null }
        desktopTaskSuite = if ($desktopTaskSuiteSummary) {
            [pscustomobject]@{
                ok = $desktopTaskSuiteSummary.ok
                evidence = $desktopTaskSuiteSummary.desktopTaskSuiteEvidence
            }
        } else { $null }
        goalReadiness = if ($goalReadinessSummary) {
            [pscustomobject]@{
                ok = $goalReadinessSummary.ok
                evidence = $goalReadinessSummary.goalReadinessEvidence
            }
        } else { $null }
        agenticCapabilityMatrix = if ($agenticCapabilityMatrixSummary) {
            [pscustomobject]@{
                ok = $agenticCapabilityMatrixSummary.ok
                evidence = $agenticCapabilityMatrixSummary.agenticCapabilityMatrixEvidence
            }
        } else { $null }
        realTaskCoverageRoadmap = if ($realTaskCoverageRoadmapSummary) {
            [pscustomobject]@{
                ok = $realTaskCoverageRoadmapSummary.ok
                evidence = $realTaskCoverageRoadmapSummary.realTaskCoverageRoadmapEvidence
            }
        } else { $null }
        goalRealRunReadiness = if ($goalRealRunReadinessSummary) {
            [pscustomobject]@{
                ok = $goalRealRunReadinessSummary.ok
                evidence = $goalRealRunReadinessSummary.goalRealRunReadinessEvidence
            }
        } else { $null }
    }
}

function Invoke-LocalJson {
    param([string]$Path, [int]$MaxAttempts = 2)
    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $remainingBudgetMs = Get-RemainingVerifierBudgetMs
            if ($remainingBudgetMs -lt 250) {
                throw "verifier budget exhausted before $Path request attempt $attempt"
            }
            $requestTimeoutSec = [Math]::Max(1, [Math]::Min(30, [Math]::Min($TimeoutSec, [int][Math]::Ceiling($remainingBudgetMs / 1000))))
            return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $requestTimeoutSec
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -ge $MaxAttempts) {
                throw "$Path request failed on attempt $attempt of $MaxAttempts`: $lastError"
            }
            $sleepMs = [Math]::Min([Math]::Min(1000, 250 * $attempt), [Math]::Max(0, (Get-RemainingVerifierBudgetMs)))
            if ($sleepMs -gt 0) {
                Start-Sleep -Milliseconds $sleepMs
            }
        }
    }
    throw "$Path request failed after $MaxAttempts attempts: $lastError"
}

function Invoke-JsonScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName,
        [string[]]$Arguments = @(),
        [string]$ScriptRoot = $PSScriptRoot
    )
    $scriptPath = Join-Path $ScriptRoot $ScriptName
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "Missing script: $ScriptName"
    }
    $powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $remainingBudgetMs = Get-RemainingVerifierBudgetMs
    if ($remainingBudgetMs -lt 1000) {
        throw "$ScriptName skipped because verifier budget was exhausted before child process start"
    }
    $stdoutPath = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-diagnostics-child-{0}.out" -f ([Guid]::NewGuid().ToString("N")))
    $stderrPath = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-diagnostics-child-{0}.err" -f ([Guid]::NewGuid().ToString("N")))
    try {
        $argumentList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath) + $Arguments
        $process = Start-Process -FilePath $powerShellBin -ArgumentList $argumentList -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        if (-not $process.WaitForExit([Math]::Max(1000, $remainingBudgetMs))) {
            try { $process.Kill() } catch {}
            throw "$ScriptName timed out after $([int]($remainingBudgetMs / 1000)) seconds while waiting for child process"
        }
        try { $process.Refresh() } catch {}
        $exitCode = if ($null -ne $process.ExitCode) { [int]$process.ExitCode } else { $null }
        $output = @()
        if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { $output += @(Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue) }
        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { $output += @(Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue) }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
    $lines = @($output | ForEach-Object { [string]$_ })
    $jsonLine = @($lines | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)
    if (-not $jsonLine) {
        throw "$ScriptName did not emit a JSON result."
    }
    $payload = $jsonLine | ConvertFrom-Json
    if ($null -eq $exitCode -and $payload.ok -eq $true) {
        $exitCode = 0
    }
    if ($null -eq $exitCode) {
        throw "$ScriptName failed with unknown exit code. $($lines -join "`n")"
    }
    if ($exitCode -ne 0) {
        throw "$ScriptName failed with exit code $exitCode. $($lines -join "`n")"
    }
    return $payload
}

function Resolve-InstalledScriptRoot {
    if ($env:ANTICODEX_DIAGNOSTICS_SCRIPT_ROOT) {
        $overrideRoot = [string]$env:ANTICODEX_DIAGNOSTICS_SCRIPT_ROOT
        if (Test-Path -LiteralPath (Join-Path $overrideRoot "collect-anticodex-diagnostics.ps1") -PathType Leaf) {
            return $overrideRoot
        }
    }
    $installedRoot = Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime\scripts"
    if (Test-Path -LiteralPath (Join-Path $installedRoot "collect-anticodex-diagnostics.ps1") -PathType Leaf) {
        return $installedRoot
    }
    return $PSScriptRoot
}

function Test-DiagnosticBundle {
    $antigravityReportsRequired = $diagnosticMode -ne "third-party"
    $collectorRoot = Resolve-InstalledScriptRoot
    $bundle = Invoke-JsonScript "collect-anticodex-diagnostics.ps1" @("-BaseUrl", $BaseUrl, "-NoPopup") $collectorRoot
    if ($bundle.ok -ne $true) { Add-Failure "diagnostic bundle collector returned ok=false" }
    if (-not (Test-Path -LiteralPath $bundle.zipPath -PathType Leaf)) { Add-Failure "diagnostic zip missing: $($bundle.zipPath)" }
    if (-not (Test-Path -LiteralPath $bundle.bundleRoot -PathType Container)) { Add-Failure "diagnostic bundle root missing: $($bundle.bundleRoot)" }

    $refreshPath = Join-Path $bundle.bundleRoot "model-routing-refresh.json"
    $logDbGuardPath = Join-Path $bundle.bundleRoot "log-db-guard.json"
    $summaryPath = Join-Path $bundle.bundleRoot "reports-summary.json"
    $diagnosticsSummaryPath = Join-Path $bundle.bundleRoot "diagnostics-summary.json"
    $lifecycleStatusPath = Join-Path (Join-Path $bundle.bundleRoot "logs") "translator-lifecycle.json"
    $lifecycleLogPath = Join-Path (Join-Path $bundle.bundleRoot "logs") "translator-lifecycle.jsonl"
    if ($antigravityReportsRequired -and -not (Test-Path -LiteralPath $refreshPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing model-routing-refresh.json"
    }
    if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing reports-summary.json"
    }
    if (-not (Test-Path -LiteralPath $diagnosticsSummaryPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing diagnostics-summary.json"
    } else {
        $diagnosticsSummary = Get-Content -LiteralPath $diagnosticsSummaryPath -Raw | ConvertFrom-Json
        if (-not (Has-Property $diagnosticsSummary "longTasks")) {
            Add-Failure "diagnostic summary missing longTasks"
        } else {
            $longTaskSummary = $diagnosticsSummary.longTasks
            if (-not (Has-Property $longTaskSummary "runningCount")) { Add-Failure "diagnostic summary missing longTasks runningCount" }
            if (-not (Has-Property $longTaskSummary "attentionCount")) { Add-Failure "diagnostic summary missing longTasks attentionCount" }
            if (-not (Has-Property $longTaskSummary "otherRunningItems")) { Add-Failure "diagnostic summary missing longTasks otherRunningItems" }
            $foregroundSummaryItems = @(As-FlatArray $longTaskSummary.otherRunningItems | Where-Object { $_.stage -eq "manager_foreground" })
            foreach ($foregroundItem in $foregroundSummaryItems) {
                if ([string]::IsNullOrWhiteSpace([string]$foregroundItem.id) -and [string]::IsNullOrWhiteSpace([string]$foregroundItem.label)) {
                    Add-Failure "diagnostic summary manager_foreground item missing id or label"
                }
            }
        }
    }
    if (-not (Test-Path -LiteralPath $logDbGuardPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing log-db-guard.json"
    } else {
        $logDbGuard = Get-Content -LiteralPath $logDbGuardPath -Raw | ConvertFrom-Json
        if ($logDbGuard.reportName -ne "log-db-guard") { Add-Failure "diagnostic log database guard reportName mismatch" }
        if ($logDbGuard.noTraffic -ne $true) { Add-Failure "diagnostic log database guard missing noTraffic" }
        if ($logDbGuard.usedRealTraffic -ne $false) { Add-Failure "diagnostic log database guard used real traffic" }
        if ($logDbGuard.protected -ne $true) { Add-Failure "diagnostic log database guard is not protected in bundle" }
        if ($logDbGuard.triggerPresent -ne $true) { Add-Failure "diagnostic log database guard trigger missing in bundle" }
    }
    if (-not (Test-Path -LiteralPath $lifecycleStatusPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing translator-lifecycle.json"
    }
    if (-not (Test-Path -LiteralPath $lifecycleLogPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing translator-lifecycle.jsonl"
    }

    $refresh = $null
    if (Test-Path -LiteralPath $refreshPath -PathType Leaf) {
        $refresh = Get-Content -LiteralPath $refreshPath -Raw | ConvertFrom-Json
        if ($antigravityReportsRequired) {
            if ($refresh.ok -ne $true) { Add-Failure "diagnostic model-routing refresh ok=false" }
            if ([int]$refresh.modelCount -lt 1) { Add-Failure "diagnostic model-routing refresh has no models" }
            if ($refresh.skipRequests -ne $true) { Add-Failure "diagnostic model-routing refresh did not use skipRequests" }
        }
    }

    $modelSummary = $null
    $modelThinkingSummary = $null
    $toolBridgeSummary = $null
    $uiIdleSummary = $null
    $syncReadinessSummary = $null
    $installedFastSummary = $null
    $installedFullSummary = $null
    $postVerificationSummary = $null
    $sourcePreflightSummary = $null
    $managerRealButtonsSummary = $null
    $thirdPartyProviderSummary = $null
    $localConnectorsSummary = $null
    $pluginCapabilitiesSummary = $null
    $logDbGuardSummary = $null
    $releaseGatesSummary = $null
    $coldRelaunchSummary = $null
    $antigravityCliProfilePrepareSummary = $null
    if (Test-Path -LiteralPath $summaryPath -PathType Leaf) {
        $summary = As-FlatArray (Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json)
        $modelSummary = @($summary | Where-Object { $_.file -eq "latest-model-routing.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $modelSummary) {
            Add-Failure "diagnostic reports summary missing latest-model-routing.json"
        } elseif ($antigravityReportsRequired -and $modelSummary) {
            if ([int]$modelSummary.modelCount -lt 1) { Add-Failure "diagnostic model-routing summary has no models" }
            if ($modelSummary.skipRequests -ne $true) { Add-Failure "diagnostic model-routing summary did not preserve skipRequests" }
            $modelEvidence = $modelSummary.modelRoutingEvidence
            if (-not $modelEvidence) {
                Add-Failure "diagnostic model-routing summary missing modelRoutingEvidence"
            } else {
                if (-not [string]$modelEvidence.mode) { Add-Failure "diagnostic model-routing summary missing mode" }
                if ([int]$modelEvidence.resultCount -lt [int]$modelSummary.modelCount) { Add-Failure "diagnostic model-routing summary missing per-model results" }
                if ([int]$modelEvidence.skippedRequestCount -ne [int]$modelEvidence.resultCount) { Add-Failure "diagnostic model-routing summary did not preserve skipped per-model results" }
                if ([int]$modelEvidence.failedResultCount -ne 0) { Add-Failure "diagnostic model-routing summary reports failed results" }
                if ([int]$modelEvidence.resultErrorCount -ne 0) { Add-Failure "diagnostic model-routing summary reports result errors" }
            }
        }
        $modelThinkingSummary = @($summary | Where-Object { $_.file -eq "latest-model-thinking.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $modelThinkingSummary) {
            Add-Failure "diagnostic reports summary missing latest-model-thinking.json"
        } elseif ($antigravityReportsRequired -and $modelThinkingSummary) {
            $thinkingEvidence = $modelThinkingSummary.modelThinkingEvidence
            if (-not $thinkingEvidence) {
                Add-Failure "diagnostic model-thinking summary missing modelThinkingEvidence"
            } else {
                if ([int]$thinkingEvidence.expectedModelCount -lt 1) { Add-Failure "diagnostic model-thinking summary missing expected model count" }
                if ([int]$thinkingEvidence.actualModelCount -ne [int]$thinkingEvidence.expectedModelCount) { Add-Failure "diagnostic model-thinking summary model counts differ" }
                if ([int]$thinkingEvidence.modelCount -ne [int]$thinkingEvidence.actualModelCount) { Add-Failure "diagnostic model-thinking summary missing model entries" }
                if ([int]$thinkingEvidence.supportsThinkingCount -ne [int]$thinkingEvidence.modelCount) { Add-Failure "diagnostic model-thinking summary has non-thinking models" }
                if ([int]$thinkingEvidence.missingBudgetCount -ne 0) { Add-Failure "diagnostic model-thinking summary has missing budgets" }
                if ([int]$thinkingEvidence.missingReasoningLevelCount -ne 0) { Add-Failure "diagnostic model-thinking summary has missing reasoning levels" }
                if (@($thinkingEvidence.reasoningLevels).Count -lt 1) { Add-Failure "diagnostic model-thinking summary missing reasoning levels" }
            }
        }
        $toolBridgeSummary = @($summary | Where-Object { $_.file -eq "latest-tool-bridge-mode.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $toolBridgeSummary) {
            Add-Failure "diagnostic reports summary missing latest-tool-bridge-mode.json"
        } elseif ($antigravityReportsRequired -and $toolBridgeSummary) {
            $bridgeEvidence = $toolBridgeSummary.toolBridgeEvidence
            if (-not $bridgeEvidence) {
                Add-Failure "diagnostic tool-bridge summary missing toolBridgeEvidence"
            } else {
                $summaryNativeBridge = $bridgeEvidence.nativeBridgeDefaultEnabled -eq $true
                if ($summaryNativeBridge) {
                    if ($bridgeEvidence.mode -ne "native-mcp-same-cascade") { Add-Failure "diagnostic tool-bridge summary missing native MCP same-Cascade mode" }
                    if ($bridgeEvidence.localAdapter -ne "native-mcp-same-cascade-with-prompt-fallback") { Add-Failure "diagnostic tool-bridge summary missing prompt fallback adapter" }
                    if ($bridgeEvidence.nativeAntigravityToolEvents -ne $true) { Add-Failure "diagnostic tool-bridge summary missing native tool events" }
                    if ($bridgeEvidence.nativeMcpDiscoveryVerified -ne $true) { Add-Failure "diagnostic tool-bridge summary missing MCP discovery proof" }
                    if ($bridgeEvidence.acceptsExternalToolDefinitions -ne $true) { Add-Failure "diagnostic tool-bridge summary missing external tool definition proof" }
                    if ($bridgeEvidence.compatibilityBridge -ne "native_mcp_same_cascade") { Add-Failure "diagnostic tool-bridge summary missing compatibility bridge proof" }
                    if ($bridgeEvidence.externalToolDefinitionsField -ne "StartCascade.customAgentSpec.customizationConfig.customizationServerUrl") { Add-Failure "diagnostic tool-bridge summary missing external tool definitions field" }
                    if ($bridgeEvidence.externalToolDefinitionsUsable -ne $true) { Add-Failure "diagnostic tool-bridge summary missing usable external tool definitions proof" }
                    if ($bridgeEvidence.schemaLikeRequestAcceptance -ne "verified-native-mcp-initialize-and-tools-list") { Add-Failure "diagnostic tool-bridge summary missing schema-like request acceptance proof" }
                    if ($bridgeEvidence.nativeMcpToolCallStatus -ne "verified-tools-call-after-automatic-permission") { Add-Failure "diagnostic tool-bridge summary missing native MCP tool call proof" }
                    if ($bridgeEvidence.nativeMcpApprovalProtocolVerified -ne $true) { Add-Failure "diagnostic tool-bridge summary missing approval protocol proof" }
                    if ($bridgeEvidence.nativeMcpPermissionMode -ne "automatic-before-codex-execution") { Add-Failure "diagnostic tool-bridge summary missing automatic permission mode" }
                    if ($bridgeEvidence.sameCascadeResumeProbeVerified -ne $true) { Add-Failure "diagnostic tool-bridge summary missing same-Cascade resume proof" }
                    if ($bridgeEvidence.codexToolBridge -ne "native-mcp-same-cascade-with-prompt-fallback") { Add-Failure "diagnostic tool-bridge summary missing Codex tool bridge proof" }
                } else {
                    if ($bridgeEvidence.mode -ne "codex-owned-tools-model-only") { Add-Failure "diagnostic tool-bridge summary missing model-only Codex-owned mode" }
                    if ($bridgeEvidence.localAdapter -ne "codex-owned-tools-model-only") { Add-Failure "diagnostic tool-bridge summary missing model-only local adapter" }
                    if ($bridgeEvidence.nativeAntigravityToolEvents -ne $false) { Add-Failure "diagnostic tool-bridge summary unexpectedly reports native tool events" }
                    if ($bridgeEvidence.acceptsExternalToolDefinitions -ne $false) { Add-Failure "diagnostic tool-bridge summary unexpectedly exposes external tool definitions" }
                    if ($bridgeEvidence.compatibilityBridge -ne "codex_owned_model_only_tool_bridge") { Add-Failure "diagnostic tool-bridge summary missing model-only compatibility bridge proof" }
                    if ($bridgeEvidence.externalToolDefinitionsUsable -ne $false) { Add-Failure "diagnostic tool-bridge summary unexpectedly marks external tool definitions usable" }
                    if ($bridgeEvidence.schemaLikeRequestAcceptance -ne "disabled-by-default-model-only") { Add-Failure "diagnostic tool-bridge summary missing disabled model-only schema marker" }
                    if ($bridgeEvidence.nativeMcpPermissionMode -ne "disabled-with-native-bridge") { Add-Failure "diagnostic tool-bridge summary missing disabled native permission marker" }
                    if ($bridgeEvidence.codexToolBridge -ne "codex-owned-tools-model-only") { Add-Failure "diagnostic tool-bridge summary missing model-only Codex tool bridge proof" }
                }
                if ($bridgeEvidence.transport -notin @("cli", "native", "desktop-cascade")) { Add-Failure "diagnostic tool-bridge summary has unexpected model transport" }
                if (-not $bridgeEvidence.requestEnvelope) { Add-Failure "diagnostic tool-bridge summary missing request envelope" }
                if ($bridgeEvidence.antigravityOwnedToolsDisabled -ne $true) { Add-Failure "diagnostic tool-bridge summary missing owned tools disabled proof" }
                if ($bridgeEvidence.permissionPromptsDisabled -ne $true) { Add-Failure "diagnostic tool-bridge summary missing permission prompts disabled proof" }
                if ([int]$bridgeEvidence.disabledToolCount -lt 1) { Add-Failure "diagnostic tool-bridge summary missing disabled tool count" }
            }
        }
        $uiIdleSummary = @($summary | Where-Object { $_.file -eq "latest-ui-idle-stability.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $uiIdleSummary) {
            Add-Failure "diagnostic reports summary missing latest-ui-idle-stability.json"
        } elseif ($antigravityReportsRequired -and $uiIdleSummary) {
            $uiEvidence = $uiIdleSummary.uiIdleEvidence
            if (-not $uiEvidence) {
                Add-Failure "diagnostic ui-idle summary missing uiIdleEvidence"
            } else {
                if ([int]$uiEvidence.durationSec -lt 10) { Add-Failure "diagnostic ui-idle summary duration too short" }
                if ([int]$uiEvidence.sampleCount -lt 1) { Add-Failure "diagnostic ui-idle summary missing samples" }
                if ([int]$uiEvidence.sampleEntryCount -lt [int]$uiEvidence.sampleCount) { Add-Failure "diagnostic ui-idle summary sample entries missing" }
                if ([int]$uiEvidence.healthySampleCount -ne [int]$uiEvidence.sampleEntryCount) { Add-Failure "diagnostic ui-idle summary has unhealthy samples" }
                if ([int]$uiEvidence.reconnectTextCount -ne 0) { Add-Failure "diagnostic ui-idle summary has reconnect text" }
                if ([int]$uiEvidence.loginTextCount -ne 0) { Add-Failure "diagnostic ui-idle summary has login text" }
                if ([int]$uiEvidence.missingModelTextCount -ne 0) { Add-Failure "diagnostic ui-idle summary missing model text" }
            }
        }
        $desktopTaskSuiteSummary = @($summary | Where-Object { $_.file -eq "latest-desktop-task-suite.json" } | Select-Object -First 1)[0]
        Test-DesktopTaskSuiteSummaryEvidence $desktopTaskSuiteSummary
        $goalReadinessSummary = @($summary | Where-Object { $_.file -eq "latest-goal-readiness.json" } | Select-Object -First 1)[0]
        Test-GoalReadinessSummaryEvidence $goalReadinessSummary
        $goalUnblockPackageSummary = @($summary | Where-Object { $_.file -eq "latest-goal-unblock-package.json" } | Select-Object -First 1)[0]
        Test-GoalUnblockPackageSummaryEvidence $goalUnblockPackageSummary
        $freshChannelWorkerProofKitSummary = @($summary | Where-Object { $_.file -eq "latest-fresh-channel-worker-proof-kit.json" } | Select-Object -First 1)[0]
        Test-FreshChannelWorkerProofKitSummaryEvidence $freshChannelWorkerProofKitSummary
        $cliTransportBoundarySummary = @($summary | Where-Object { $_.file -eq "latest-cli-transport-boundary.json" } | Select-Object -First 1)[0]
        Test-CliTransportBoundarySummaryEvidence $cliTransportBoundarySummary
        $longTaskLandingMatrixSummary = @($summary | Where-Object { $_.file -eq "latest-long-task-landing-matrix.json" } | Select-Object -First 1)[0]
        Test-LongTaskLandingMatrixSummaryEvidence $longTaskLandingMatrixSummary
        $agenticCapabilityMatrixSummary = @($summary | Where-Object { $_.file -eq "latest-agentic-capability-matrix.json" } | Select-Object -First 1)[0]
        Test-AgenticCapabilityMatrixSummaryEvidence $agenticCapabilityMatrixSummary
        $realTaskCoverageRoadmapSummary = @($summary | Where-Object { $_.file -eq "latest-real-task-coverage-roadmap.json" } | Select-Object -First 1)[0]
        Test-RealTaskCoverageRoadmapSummaryEvidence $realTaskCoverageRoadmapSummary
        $nativeCodexParityTaskMatrixSummary = @($summary | Where-Object { $_.file -eq "latest-native-codex-parity-task-matrix.json" } | Select-Object -First 1)[0]
        Test-NativeCodexParityTaskMatrixSummaryEvidence $nativeCodexParityTaskMatrixSummary
        $syncReadinessSummary = @($summary | Where-Object { $_.file -eq "latest-sync-readiness.json" } | Select-Object -First 1)[0]
        if (-not $syncReadinessSummary) {
            Add-Failure "diagnostic reports summary missing latest-sync-readiness.json"
        } else {
            $syncEvidence = $syncReadinessSummary.syncReadinessEvidence
            if (-not $syncEvidence) {
                Add-Failure "diagnostic sync-readiness summary missing syncReadinessEvidence"
            } else {
                Test-SyncReadinessEvidence $syncEvidence "diagnostic sync-readiness summary" -RequireReady:$false
                if ($syncEvidence.noTrafficReady -ne $true) { Add-Failure "diagnostic sync-readiness summary missing no-traffic attestation" }
                if ($syncEvidence.fullMode -ne $true) { Add-Failure "diagnostic sync-readiness summary not full mode" }
                if ($syncEvidence.activeHostReady -ne $true) { Add-Failure "diagnostic sync-readiness summary active host not ready" }
                if ($syncEvidence.brandReady -ne $true) { Add-Failure "diagnostic sync-readiness summary brand not preserved" }
                if ($syncEvidence.iconReady -ne $true) { Add-Failure "diagnostic sync-readiness summary icons not ready" }
                if ($syncEvidence.syncScriptsReady -ne $true) { Add-Failure "diagnostic sync-readiness summary scripts not ready" }
                if ($syncEvidence.updateReady -ne $true) { Add-Failure "diagnostic sync-readiness summary update status not synced" }
                if ($syncEvidence.guardrailsReady -ne $true) { Add-Failure "diagnostic sync-readiness summary guardrails not ready" }
                if ([int]$syncEvidence.shortcutCount -lt 5) { Add-Failure "diagnostic sync-readiness summary shortcut count too low" }
                if ([int]$syncEvidence.shortcutReadyCount -ne [int]$syncEvidence.shortcutCount) { Add-Failure "diagnostic sync-readiness summary shortcuts not ready" }
                if ([int]$syncEvidence.desktopShortcutCount -ne 1) { Add-Failure "diagnostic sync-readiness summary desktop shortcut count wrong" }
                if ([int]$syncEvidence.forbiddenDesktopHelperCount -ne 0) { Add-Failure "diagnostic sync-readiness summary has forbidden desktop helpers" }
                if ($syncEvidence.managerBridgeReady -ne $true) { Add-Failure "diagnostic sync-readiness summary manager bridge not ready" }
                if ($syncEvidence.cleanSyncState -ne $true) { Add-Failure "diagnostic sync-readiness summary sync state not clean" }
            }
        }
        $installedFastSummary = @($summary | Where-Object { $_.file -eq "latest-installed-overall-fast.json" } | Select-Object -First 1)[0]
        $installedFullSummary = @($summary | Where-Object { $_.file -eq "latest-installed-overall.json" } | Select-Object -First 1)[0]
        foreach ($entry in @(
            [pscustomobject]@{ Label = "fast"; Summary = $installedFastSummary; ExpectedReportName = "installed-overall-fast"; ExpectedCoverage = "installed-fast-no-traffic"; ExpectedFast = $true },
            [pscustomobject]@{ Label = "full"; Summary = $installedFullSummary; ExpectedReportName = "installed-overall"; ExpectedCoverage = "installed-no-traffic"; ExpectedFast = $false }
        )) {
            if (-not $entry.Summary) {
                Add-Failure "diagnostic reports summary missing latest-installed-overall $($entry.Label)"
                continue
            }
            $overallEvidence = $entry.Summary.installedOverallEvidence
            if (-not $overallEvidence) {
                Add-Failure "diagnostic installed-overall $($entry.Label) summary missing installedOverallEvidence"
            } else {
                if ($overallEvidence.reportName -ne $entry.ExpectedReportName) { Add-Failure "diagnostic installed-overall $($entry.Label) summary reportName mismatch" }
                if ($overallEvidence.fast -ne $entry.ExpectedFast) { Add-Failure "diagnostic installed-overall $($entry.Label) summary fast flag mismatch" }
                if ($overallEvidence.noTraffic -ne $true) { Add-Failure "diagnostic installed-overall $($entry.Label) summary missing noTraffic" }
                if ($overallEvidence.usedRealTraffic -ne $false) { Add-Failure "diagnostic installed-overall $($entry.Label) summary used real traffic" }
                if ($overallEvidence.behaviorCovered -ne $true) { Add-Failure "diagnostic installed-overall $($entry.Label) summary behavior not covered" }
                if ($overallEvidence.coverageKind -ne $entry.ExpectedCoverage) { Add-Failure "diagnostic installed-overall $($entry.Label) summary coverageKind mismatch" }
                if ([int]$overallEvidence.checkCount -lt 1) { Add-Failure "diagnostic installed-overall $($entry.Label) summary missing checks" }
                if ([int]$overallEvidence.failedCheckCount -ne 0) { Add-Failure "diagnostic installed-overall $($entry.Label) summary failed checks" }
                if ([int]$overallEvidence.missingSkipMetadataCount -ne 0) { Add-Failure "diagnostic installed-overall $($entry.Label) summary missing skip metadata" }
                if ([int]$overallEvidence.managerVerifierBusyCheckCount -ne 0) { Add-Failure "diagnostic installed-overall $($entry.Label) summary has Manager/UI verifier busy lock evidence" }
                if (@($overallEvidence.realTrafficSkippedChecks).Count -lt 3) { Add-Failure "diagnostic installed-overall $($entry.Label) summary missing real traffic skipped checks" }
                if ([string]$overallEvidence.modelTextTransport -ne "desktop-cascade") { Add-Failure "diagnostic installed-overall $($entry.Label) summary model text transport is not desktop-cascade" }
                if (-not [string]$overallEvidence.modelDiscoverySource) { Add-Failure "diagnostic installed-overall $($entry.Label) summary missing model discovery source" }
                if ([string]$overallEvidence.modelDiscoverySource -and $AllowedAntigravityModelDiscoverySources -notcontains [string]$overallEvidence.modelDiscoverySource) { Add-Failure "diagnostic installed-overall $($entry.Label) summary model discovery source is not allowed" }
                if ($overallEvidence.antigravityCoworkerDefault -ne $false) { Add-Failure "diagnostic installed-overall $($entry.Label) summary antigravity coworker default is not false" }
            }
        }
        $postVerificationSummary = @($summary | Where-Object { $_.file -eq "latest-post-verification.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $postVerificationSummary) {
            Add-Failure "diagnostic reports summary missing latest-post-verification.json"
        } elseif ($antigravityReportsRequired -and $postVerificationSummary) {
            if ($postVerificationSummary.usedRealTraffic -ne $true) { Add-Failure "post-verification summary did not preserve usedRealTraffic" }
            if (-not [string]$postVerificationSummary.state) { Add-Failure "post-verification summary is missing state" }
            if (-not [string]$postVerificationSummary.latestDiagnosis) { Add-Failure "post-verification summary is missing latestDiagnosis" }
            if (-not (Has-Property $postVerificationSummary "latestDiagnosisDetail")) { Add-Failure "post-verification summary is missing latestDiagnosisDetail" }
        }
        $accountProxySummary = @($summary | Where-Object { $_.file -eq "latest-account-proxy-readiness.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $accountProxySummary) {
            Add-Failure "diagnostic reports summary missing latest-account-proxy-readiness.json"
        } elseif ($antigravityReportsRequired -and $accountProxySummary) {
            $accountProxyEvidence = $accountProxySummary.accountProxyEvidence
            if (-not $accountProxyEvidence) {
                Add-Failure "account-proxy summary missing accountProxyEvidence"
            } else {
                if (-not [string]$accountProxyEvidence.diagnosisDetail) { Add-Failure "account-proxy summary missing diagnosisDetail" }
                if (-not [string]$accountProxyEvidence.suggestedAction) { Add-Failure "account-proxy summary missing suggestedAction" }
                if ($null -eq $accountProxyEvidence.localProxyBypassed) { Add-Failure "account-proxy summary missing localProxyBypassed" }
                if (-not $accountProxyEvidence.phaseSummary) { Add-Failure "account-proxy summary missing phaseSummary" }
                if ($null -eq $accountProxyEvidence.phaseSummary.modelCount) { Add-Failure "account-proxy summary missing phase model count" }
                if (-not $accountProxyEvidence.antigravityLogSignals) { Add-Failure "account-proxy summary missing antigravityLogSignals" }
                if ($null -eq $accountProxyEvidence.antigravityLogSignals.tailLinesScanned) { Add-Failure "account-proxy summary missing log scan count" }
                $accountProxyEvidenceText = $accountProxyEvidence | ConvertTo-Json -Depth 8 -Compress
                if ($accountProxyEvidenceText -match "fingerprint|sha256:") { Add-Failure "account-proxy summary exposes an account fingerprint" }
            }
        }
        $sourcePreflightSummary = @($summary | Where-Object { $_.file -eq "latest-source-preflight.json" } | Select-Object -First 1)[0]
        if (-not $sourcePreflightSummary) {
            Add-Failure "diagnostic reports summary missing latest-source-preflight.json"
        } else {
            if ($sourcePreflightSummary.ok -ne $true) { Add-Failure "source-preflight summary ok=false" }
            if ($sourcePreflightSummary.reportName -ne "source-preflight") { Add-Failure "source-preflight summary missing reportName" }
            if ($sourcePreflightSummary.noTraffic -ne $true) { Add-Failure "source-preflight summary missing noTraffic" }
            if ($sourcePreflightSummary.usedRealTraffic -ne $false) { Add-Failure "source-preflight summary used real traffic" }
            if ($sourcePreflightSummary.behaviorCovered -ne $true) { Add-Failure "source-preflight summary behavior not covered" }
            if ($sourcePreflightSummary.coverageKind -ne "source-no-traffic") { Add-Failure "source-preflight summary coverageKind mismatch" }
            if ($sourcePreflightSummary.javascriptSyntaxOk -ne $true) { Add-Failure "source-preflight summary missing JavaScript syntax success" }
            if ($sourcePreflightSummary.powershellSyntaxOk -ne $true) { Add-Failure "source-preflight summary missing PowerShell syntax success" }
            if ($sourcePreflightSummary.uiStateSelfTestOk -ne $true) { Add-Failure "source-preflight summary missing UI state self-test success" }
            if ($sourcePreflightSummary.upstreamProfileStorageOk -ne $true) { Add-Failure "source-preflight summary missing upstream profile storage success" }
            if ($sourcePreflightSummary.antigravityCliIsolationProfileOk -ne $true) { Add-Failure "source-preflight summary missing Antigravity CLI isolation profile success" }
            $isolationContract = $sourcePreflightSummary.antigravityCliIsolationProfileContract
            if (-not $isolationContract) {
                Add-Failure "source-preflight summary missing Antigravity CLI isolation profile contract"
            } else {
                if ($isolationContract.usedRealTraffic -ne $false) { Add-Failure "source-preflight summary isolation profile used real traffic" }
                if ($isolationContract.loginVerified -ne $false) { Add-Failure "source-preflight summary isolation profile claims login verified" }
                if ($isolationContract.separateAccountVerified -ne $false) { Add-Failure "source-preflight summary isolation profile claims separate account verified" }
                if ($isolationContract.accountLaneRole -ne "anticodex-model-text") { Add-Failure "source-preflight summary isolation profile account lane role mismatch" }
                if ($isolationContract.mcpAccountLaneManagedByAntiCodex -ne $false) { Add-Failure "source-preflight summary isolation profile claims MCP account lane is managed by Anti-Codex" }
                if ($isolationContract.mcpAccountLaneOwner -ne "external-antigravity-account-not-managed-here") { Add-Failure "source-preflight summary isolation profile MCP account lane owner mismatch" }
                if (-not [string]$isolationContract.accountIsolationBoundary) { Add-Failure "source-preflight summary isolation profile missing isolation boundary" }
                if (-not [string]$isolationContract.accountIsolationCaveat) { Add-Failure "source-preflight summary isolation profile missing isolation caveat" }
            }
            if ($sourcePreflightSummary.antigravityCliDualAccountLanesOk -ne $true) { Add-Failure "source-preflight summary missing Antigravity CLI dual account lanes success" }
            $dualLanesContract = $sourcePreflightSummary.antigravityCliDualAccountLanesContract
            if (-not $dualLanesContract) {
                Add-Failure "source-preflight summary missing Antigravity CLI dual account lanes contract"
            } else {
                if ($dualLanesContract.usedRealTraffic -ne $false) { Add-Failure "source-preflight summary dual account lanes used real traffic" }
                if ($dualLanesContract.loginVerified -ne $false) { Add-Failure "source-preflight summary dual account lanes claims login verified" }
                if ($dualLanesContract.separateAccountVerified -ne $false) { Add-Failure "source-preflight summary dual account lanes claims separate account verified" }
                if ($dualLanesContract.accountLaneRole -ne "dual-antigravity-cli-account-lanes") { Add-Failure "source-preflight summary dual account lanes role mismatch" }
                if ($dualLanesContract.coverageKind -ne "dual-account-lanes-prepared-no-traffic") { Add-Failure "source-preflight summary dual account lanes coverage kind mismatch" }
                if ($dualLanesContract.antiCodexLaneRole -ne "anticodex-model-text") { Add-Failure "source-preflight summary dual account lanes Anti-Codex role mismatch" }
                if ($dualLanesContract.mcpLaneRole -ne "external-mcp-antigravity-account") { Add-Failure "source-preflight summary dual account lanes MCP role mismatch" }
                if ($dualLanesContract.mcpLaneManagedByAntiCodex -ne $false) { Add-Failure "source-preflight summary dual account lanes claims MCP lane is managed by Anti-Codex" }
                if ($dualLanesContract.profileRootsDifferent -ne $true) { Add-Failure "source-preflight summary dual account lanes profile roots are not distinct" }
                if ($dualLanesContract.profileRootsNested -ne $false) { Add-Failure "source-preflight summary dual account lanes profile roots are nested" }
                if ($dualLanesContract.appDataDifferent -ne $true) { Add-Failure "source-preflight summary dual account lanes APPDATA not distinct" }
                if ($dualLanesContract.localAppDataDifferent -ne $true) { Add-Failure "source-preflight summary dual account lanes LOCALAPPDATA not distinct" }
                if ($dualLanesContract.geminiDirDifferent -ne $true) { Add-Failure "source-preflight summary dual account lanes GEMINI_DIR not distinct" }
                if ($dualLanesContract.neitherUsesDefaultAntigravityProfile -ne $true) { Add-Failure "source-preflight summary dual account lanes use a default Antigravity profile" }
                if (-not [string]$dualLanesContract.accountIsolationBoundary) { Add-Failure "source-preflight summary dual account lanes missing isolation boundary" }
                if (-not [string]$dualLanesContract.accountIsolationCaveat) { Add-Failure "source-preflight summary dual account lanes missing isolation caveat" }
            }
            if ($sourcePreflightSummary.localConnectorVerifierOk -ne $true) { Add-Failure "source-preflight summary missing local connector verifier success" }
            if ($sourcePreflightSummary.managerMojibakeContractsOk -ne $true) { Add-Failure "source-preflight summary missing Manager mojibake contract success" }
            if ($sourcePreflightSummary.publicDocumentationOk -ne $true) { Add-Failure "source-preflight summary missing public documentation success" }
            if ($sourcePreflightSummary.publicDocumentationClientCopySyncContractOk -ne $true) { Add-Failure "source-preflight summary missing client-copy public documentation contract success" }
            if ($sourcePreflightSummary.translatorRegressionOk -ne $true) { Add-Failure "source-preflight summary missing translator regression success" }
            if ($sourcePreflightSummary.diffWhitespaceOk -ne $true) { Add-Failure "source-preflight summary missing diff whitespace success" }
            if ($sourcePreflightSummary.antigravityCliProfilePrepareOk -ne $true) { Add-Failure "source-preflight summary missing Antigravity CLI profile prepare success" }
            if ($sourcePreflightSummary.antigravityCliProfilePrepareRejectsDefaultChildOk -ne $true) { Add-Failure "source-preflight summary missing Antigravity CLI profile prepare default-child rejection success" }
            if ($sourcePreflightSummary.antigravityCliWindowsUserLoginDryRunOk -ne $true) { Add-Failure "source-preflight summary missing Antigravity CLI Windows-user login dry-run success" }
            $profilePrepareContract = $sourcePreflightSummary.antigravityCliProfilePrepareContract
            if (-not $profilePrepareContract) {
                Add-Failure "source-preflight summary missing Antigravity CLI profile prepare contract"
            } else {
                if ($profilePrepareContract.usedRealTraffic -ne $false) { Add-Failure "source-preflight summary profile prepare used real traffic" }
                if ($profilePrepareContract.loginVerified -ne $false) { Add-Failure "source-preflight summary profile prepare claims login verified" }
                if ($profilePrepareContract.separateAccountVerified -ne $false) { Add-Failure "source-preflight summary profile prepare claims separate account verified" }
                if ($profilePrepareContract.accountLaneRole -ne "anticodex-model-text") { Add-Failure "source-preflight summary profile prepare account lane role mismatch" }
                if ($profilePrepareContract.mcpAccountLaneManagedByAntiCodex -ne $false) { Add-Failure "source-preflight summary profile prepare claims MCP account lane is managed by Anti-Codex" }
                if ($profilePrepareContract.mcpAccountLaneOwner -ne "external-antigravity-account-not-managed-here") { Add-Failure "source-preflight summary profile prepare MCP account lane owner mismatch" }
                if ($profilePrepareContract.coverageKind -ne "profile-prepared-no-traffic") { Add-Failure "source-preflight summary profile prepare coverage kind mismatch" }
                if (-not [string]$profilePrepareContract.accountIsolationBoundary) { Add-Failure "source-preflight summary profile prepare missing isolation boundary" }
                if (-not [string]$profilePrepareContract.accountIsolationCaveat) { Add-Failure "source-preflight summary profile prepare missing isolation caveat" }
            }
            $windowsUserLoginContract = $sourcePreflightSummary.antigravityCliWindowsUserLoginDryRunContract
            if (-not $windowsUserLoginContract) {
                Add-Failure "source-preflight summary missing Antigravity CLI Windows-user login dry-run contract"
            } else {
                if ($windowsUserLoginContract.noTraffic -ne $true) { Add-Failure "source-preflight summary Windows-user login dry-run not marked no-traffic" }
                if ($windowsUserLoginContract.usedRealTraffic -ne $false) { Add-Failure "source-preflight summary Windows-user login dry-run used real traffic" }
                if ($windowsUserLoginContract.started -ne $false) { Add-Failure "source-preflight summary Windows-user login dry-run started a process" }
                if ($windowsUserLoginContract.capturesLoginOutput -ne $false) { Add-Failure "source-preflight summary Windows-user login dry-run captures login output" }
                if ($windowsUserLoginContract.readinessChecked -ne $true) { Add-Failure "source-preflight summary Windows-user login dry-run missing readiness check" }
                if (-not [string]$windowsUserLoginContract.normalizedTargetWindowsUser) { Add-Failure "source-preflight summary Windows-user login dry-run missing normalized target user" }
                if (-not [string]$windowsUserLoginContract.currentWindowsUser) { Add-Failure "source-preflight summary Windows-user login dry-run missing current user" }
                if ($windowsUserLoginContract.targetUserIsCurrentUser -eq $true) { Add-Failure "source-preflight summary Windows-user login dry-run targets current user" }
                if ($windowsUserLoginContract.readyForInteractiveLogin -ne $true -and -not [string]$windowsUserLoginContract.readinessBlockingReason) { Add-Failure "source-preflight summary Windows-user login dry-run missing readiness blocking reason" }
                if ($windowsUserLoginContract.credentialBoundary -ne "separate-windows-user") { Add-Failure "source-preflight summary Windows-user login dry-run credential boundary mismatch" }
                if ($windowsUserLoginContract.expectedCredentialStoreIsolation -ne $true) { Add-Failure "source-preflight summary Windows-user login dry-run missing expected credential-store isolation" }
                if (-not [string]$windowsUserLoginContract.runasWorkingDirectory) { Add-Failure "source-preflight summary Windows-user login dry-run missing runas working directory" }
                if ($windowsUserLoginContract.bootstrapKeepsShellOpen -ne $false) { Add-Failure "source-preflight summary Windows-user login dry-run keeps bootstrap shell open" }
                if (-not [string]$windowsUserLoginContract.accountIsolationCaveat) { Add-Failure "source-preflight summary Windows-user login dry-run missing caveat" }
            }
            if ($null -eq $sourcePreflightSummary.skipFullRegression) { Add-Failure "source-preflight summary missing skipFullRegression" }
        }
        $antigravityCliProfilePrepareSummary = @($summary | Where-Object { $_.file -eq "latest-antigravity-cli-profile-prepare.json" } | Select-Object -First 1)[0]
        if ($antigravityCliProfilePrepareSummary) {
            $profilePrepareEvidence = $antigravityCliProfilePrepareSummary.antigravityCliProfilePrepareEvidence
            if (-not $profilePrepareEvidence) {
                Add-Failure "diagnostic profile prepare summary missing antigravityCliProfilePrepareEvidence"
            } else {
                if ($profilePrepareEvidence.reportName -ne "antigravity-cli-profile-prepare") { Add-Failure "diagnostic profile prepare summary reportName mismatch" }
                if ($profilePrepareEvidence.separateAccountVerified -ne $false) { Add-Failure "diagnostic profile prepare summary separateAccountVerified must be false; profile prepare is not real dual-account proof" }
                if ($profilePrepareEvidence.accountLaneRole -ne "anticodex-model-text") { Add-Failure "diagnostic profile prepare summary accountLaneRole mismatch" }
                if ($profilePrepareEvidence.mcpAccountLaneManagedByAntiCodex -ne $false) { Add-Failure "diagnostic profile prepare summary claims MCP account lane is managed by Anti-Codex" }
                if ($profilePrepareEvidence.mcpAccountLaneOwner -ne "external-antigravity-account-not-managed-here") { Add-Failure "diagnostic profile prepare summary mcpAccountLaneOwner mismatch" }
                if (-not [string]$profilePrepareEvidence.accountIsolationBoundary) { Add-Failure "diagnostic profile prepare summary missing accountIsolationBoundary" }
                if (-not [string]$profilePrepareEvidence.accountIsolationCaveat) { Add-Failure "diagnostic profile prepare summary missing accountIsolationCaveat" }
            }
        }
        $antigravityCliDualAccountLanesSummary = @($summary | Where-Object { $_.file -eq "latest-antigravity-cli-dual-account-lanes.json" } | Select-Object -First 1)[0]
        if ($antigravityCliDualAccountLanesSummary) {
            $dualLanesEvidence = $antigravityCliDualAccountLanesSummary.antigravityCliDualAccountLanesEvidence
            if (-not $dualLanesEvidence) {
                Add-Failure "diagnostic dual account lanes summary missing antigravityCliDualAccountLanesEvidence"
            } else {
                if ($dualLanesEvidence.reportName -ne "antigravity-cli-dual-account-lanes") { Add-Failure "diagnostic dual account lanes summary reportName mismatch" }
                if ($dualLanesEvidence.usedRealTraffic -ne $false) { Add-Failure "diagnostic dual account lanes summary used real traffic" }
                if ($dualLanesEvidence.loginVerified -ne $false) { Add-Failure "diagnostic dual account lanes summary claims login verified" }
                if ($dualLanesEvidence.separateAccountVerified -ne $false) { Add-Failure "diagnostic dual account lanes summary claims separate account verified" }
                if ($dualLanesEvidence.accountLaneRole -ne "dual-antigravity-cli-account-lanes") { Add-Failure "diagnostic dual account lanes summary role mismatch" }
                if ($dualLanesEvidence.antiCodexLaneRole -ne "anticodex-model-text") { Add-Failure "diagnostic dual account lanes summary Anti-Codex role mismatch" }
                if ($dualLanesEvidence.mcpLaneRole -ne "external-mcp-antigravity-account") { Add-Failure "diagnostic dual account lanes summary MCP role mismatch" }
                if ($dualLanesEvidence.mcpLaneManagedByAntiCodex -ne $false) { Add-Failure "diagnostic dual account lanes summary claims MCP lane is managed by Anti-Codex" }
                if ($dualLanesEvidence.profileRootsDifferent -ne $true) { Add-Failure "diagnostic dual account lanes summary profile roots are not distinct" }
                if ($dualLanesEvidence.profileRootsNested -ne $false) { Add-Failure "diagnostic dual account lanes summary profile roots are nested" }
                if ($dualLanesEvidence.appDataDifferent -ne $true) { Add-Failure "diagnostic dual account lanes summary APPDATA not distinct" }
                if ($dualLanesEvidence.localAppDataDifferent -ne $true) { Add-Failure "diagnostic dual account lanes summary LOCALAPPDATA not distinct" }
                if ($dualLanesEvidence.geminiDirDifferent -ne $true) { Add-Failure "diagnostic dual account lanes summary GEMINI_DIR not distinct" }
                if ($dualLanesEvidence.neitherUsesDefaultAntigravityProfile -ne $true) { Add-Failure "diagnostic dual account lanes summary uses a default Antigravity profile" }
                if (-not [string]$dualLanesEvidence.accountIsolationBoundary) { Add-Failure "diagnostic dual account lanes summary missing accountIsolationBoundary" }
                if (-not [string]$dualLanesEvidence.accountIsolationCaveat) { Add-Failure "diagnostic dual account lanes summary missing accountIsolationCaveat" }
            }
        }
        $windowsUserSetupGuidanceSummary = @($summary | Where-Object { $_.file -eq "latest-windows-user-setup-guidance.json" } | Select-Object -First 1)[0]
        if (-not $windowsUserSetupGuidanceSummary) {
            Add-Failure "diagnostic reports summary missing latest-windows-user-setup-guidance.json"
        } else {
            Test-WindowsUserSetupGuidanceOperatorSetupPlan $windowsUserSetupGuidanceSummary.windowsUserSetupGuidanceEvidence "diagnostic windows-user setup-guidance summary"
        }
        $windowsUserSettingsEntrypointSummary = @($summary | Where-Object { $_.file -eq "latest-windows-user-settings-entrypoint.json" } | Select-Object -First 1)[0]
        if (-not $windowsUserSettingsEntrypointSummary) {
            Add-Failure "diagnostic reports summary missing latest-windows-user-settings-entrypoint.json"
        } else {
            Test-WindowsUserSettingsEntrypointEvidence $windowsUserSettingsEntrypointSummary.windowsUserSettingsEntrypointEvidence "diagnostic windows-user settings-entrypoint summary"
        }
        $antigravityCliRealSmokeSummary = @($summary | Where-Object { $_.file -eq "latest-antigravity-cli-real-smoke.json" } | Select-Object -First 1)[0]
        if ($antigravityCliRealSmokeSummary) {
            $realSmokeEvidence = $antigravityCliRealSmokeSummary.antigravityCliRealSmokeEvidence
            if (-not $realSmokeEvidence) {
                Add-Failure "diagnostic real-smoke summary missing antigravityCliRealSmokeEvidence"
            } else {
                if ($realSmokeEvidence.accountLaneRole -ne "anticodex-model-text") { Add-Failure "diagnostic real-smoke summary accountLaneRole mismatch" }
                if ($realSmokeEvidence.mcpAccountLaneManagedByAntiCodex -ne $false) { Add-Failure "diagnostic real-smoke summary claims MCP account lane is managed by Anti-Codex" }
                if ($realSmokeEvidence.mcpAccountLaneOwner -ne "external-antigravity-account-not-managed-here") { Add-Failure "diagnostic real-smoke summary mcpAccountLaneOwner mismatch" }
                $comparison = if (Has-Property $realSmokeEvidence "accountIdentityComparison") { $realSmokeEvidence.accountIdentityComparison } else { $null }
                if ($realSmokeEvidence.separateAccountVerified -eq $true) {
                    if (-not $comparison) {
                        Add-Failure "diagnostic real-smoke summary missing account identity comparison for separate account proof"
                    } else {
                        if ($comparison.antiCodexAccountIdPresent -ne $true) { Add-Failure "diagnostic real-smoke summary missing Anti-Codex account identity presence" }
                        if ($comparison.mcpAccountIdPresent -ne $true) { Add-Failure "diagnostic real-smoke summary missing MCP account identity presence" }
                        if ($comparison.accountIdsDiffer -ne $true) { Add-Failure "diagnostic real-smoke summary does not prove distinct account identities" }
                        if ($comparison.antiCodexSourcePresent -ne $true) { Add-Failure "diagnostic real-smoke summary missing Anti-Codex identity source presence" }
                        if ($comparison.mcpSourcePresent -ne $true) { Add-Failure "diagnostic real-smoke summary missing MCP identity source presence" }
                        if ($comparison.comparisonMethodPresent -ne $true) { Add-Failure "diagnostic real-smoke summary missing comparison method presence" }
                        if ($comparison.capturedAtPresent -ne $true) { Add-Failure "diagnostic real-smoke summary missing identity capture timestamp presence" }
                        if ($comparison.approvalIdPresent -ne $true) { Add-Failure "diagnostic real-smoke summary missing separate-account proof approval id presence" }
                        if ($comparison.approvalSourcePresent -ne $true) { Add-Failure "diagnostic real-smoke summary missing separate-account proof approval source presence" }
                    }
                } elseif ($comparison) {
                    Add-Failure "diagnostic real-smoke summary has account identity comparison without separate account proof"
                }
            }
        }
        $thirdPartyProviderSummary = @($summary | Where-Object { $_.file -eq "latest-third-party-provider.json" } | Select-Object -First 1)[0]
        if (-not $thirdPartyProviderSummary) {
            Add-Failure "diagnostic reports summary missing latest-third-party-provider.json"
        } else {
            if ($thirdPartyProviderSummary.ok -ne $true) { Add-Failure "third-party provider summary ok=false" }
            if ($thirdPartyProviderSummary.upstreamFullUrlAccepted -ne $true) { Add-Failure "third-party provider summary missing full URL acceptance" }
            if ($thirdPartyProviderSummary.unauthorizedManagerBlocked -ne $true) { Add-Failure "third-party provider summary missing unauthorized Manager block" }
            if ($thirdPartyProviderSummary.savedWithoutHistoryLoss -ne $true) { Add-Failure "third-party provider summary missing save continuity" }
            if ($thirdPartyProviderSummary.restartedProviderWithoutHistoryLoss -ne $true) { Add-Failure "third-party provider summary missing restart continuity" }
            if ($thirdPartyProviderSummary.switchedProviderWithoutHistoryLoss -ne $true) { Add-Failure "third-party provider summary missing provider-switch continuity" }
            if ($thirdPartyProviderSummary.crossProtocolWithoutHistoryLoss -ne $true) { Add-Failure "third-party provider summary missing OpenAI-to-Anthropic continuity" }
            if ($thirdPartyProviderSummary.reverseCrossProtocolWithoutHistoryLoss -ne $true) { Add-Failure "third-party provider summary missing Anthropic-to-OpenAI continuity" }
            if ($thirdPartyProviderSummary.secretsRedacted -ne $true) { Add-Failure "third-party provider summary missing secret redaction evidence" }
            $continuity = $thirdPartyProviderSummary.providerContinuity
            if (-not $continuity) {
                Add-Failure "third-party provider summary missing providerContinuity"
            } else {
                if ([int]$continuity.turns -lt 9) { Add-Failure "third-party provider summary has fewer than 9 continuity turns" }
                if ([int]$continuity.toolHistoryTurns -lt 2) { Add-Failure "third-party provider summary has fewer than 2 tool-history turns" }
                if ($continuity.providerModelUsedForEveryTurn -ne $true) { Add-Failure "third-party provider summary missing provider model evidence" }
                if ($continuity.providerSwitchPreservesOpenAiToolPair -ne $true) { Add-Failure "third-party provider summary missing OpenAI tool pair after provider switch" }
                if ($continuity.protocolSwitchPreservesAnthropicToolPair -ne $true) { Add-Failure "third-party provider summary missing Anthropic tool pair after protocol switch" }
                if ($continuity.reverseProtocolSwitchPreservesOpenAiToolPair -ne $true) { Add-Failure "third-party provider summary missing OpenAI tool pair after reverse protocol switch" }
                if ($continuity.structuralEvidenceClean -ne $true) { Add-Failure "third-party provider summary missing clean structured tool-pair evidence" }
                if ($continuity.orderedHistoryClean -ne $true) { Add-Failure "third-party provider summary missing ordered role history evidence" }
                if ([int]$continuity.sixthOrderedHistoryCount -lt 7) { Add-Failure "third-party provider summary missing turn-6 ordered role history evidence" }
                if ([int]$continuity.seventhOrderedHistoryCount -lt 7) { Add-Failure "third-party provider summary missing turn-7 ordered role history evidence" }
                if ([int]$continuity.eighthOrderedHistoryCount -lt 7) { Add-Failure "third-party provider summary missing turn-8 ordered role history evidence" }
                if ([int]$continuity.ninthOrderedHistoryCount -lt 7) { Add-Failure "third-party provider summary missing turn-9 ordered role history evidence" }
                if ($continuity.sixthAfterRestartPreservesHistory -ne $true) { Add-Failure "third-party provider summary missing turn-6 restart history evidence" }
                if ($continuity.sixthAfterRestartPreservesAllHistoryMarkers -ne $true -or [int]$continuity.sixthAfterRestartAllHistoryMarkerCount -lt 15) { Add-Failure "third-party provider summary missing turn-6 full-history marker coverage" }
                if ($continuity.seventhAfterProviderSwitchPreservesAllHistoryMarkers -ne $true -or [int]$continuity.seventhAfterProviderSwitchAllHistoryMarkerCount -lt 16) { Add-Failure "third-party provider summary missing turn-7 full-history marker coverage" }
                if ($continuity.eighthAfterProtocolSwitchPreservesAllHistoryMarkers -ne $true -or [int]$continuity.eighthAfterProtocolSwitchAllHistoryMarkerCount -lt 18) { Add-Failure "third-party provider summary missing turn-8 full-history marker coverage" }
                if ($continuity.ninthAfterReverseProtocolSwitchPreservesAllHistoryMarkers -ne $true -or [int]$continuity.ninthAfterReverseProtocolSwitchAllHistoryMarkerCount -lt 20) { Add-Failure "third-party provider summary missing turn-9 full-history marker coverage" }
                if ($continuity.ninthAfterReverseProtocolSwitchPreservesHistory -ne $true) { Add-Failure "third-party provider summary missing final reverse-switch history evidence" }
                if (-not $continuity.providerSwitch -or $continuity.providerSwitch.requestReachedSecondProvider -ne $true) { Add-Failure "third-party provider summary missing provider-switch route evidence" }
                if (-not $continuity.protocolSwitch -or $continuity.protocolSwitch.requestReachedAnthropicProvider -ne $true) { Add-Failure "third-party provider summary missing protocol-switch route evidence" }
                if (-not $continuity.reverseProtocolSwitch -or $continuity.reverseProtocolSwitch.requestReachedOpenAiCompatibleProvider -ne $true) { Add-Failure "third-party provider summary missing reverse-protocol route evidence" }
                $previousIds = $continuity.previousResponseContinuity
                if (-not $previousIds) {
                    Add-Failure "third-party provider summary missing previous_response_id continuity evidence"
                } else {
                    if ($previousIds.savePresent -ne $true) { Add-Failure "third-party provider summary missing save previous_response_id continuity" }
                    if ($previousIds.restartPresent -ne $true) { Add-Failure "third-party provider summary missing restart previous_response_id continuity" }
                    if ($previousIds.providerSwitchPresent -ne $true) { Add-Failure "third-party provider summary missing provider-switch previous_response_id continuity" }
                    if ($previousIds.protocolSwitchPresent -ne $true) { Add-Failure "third-party provider summary missing protocol-switch previous_response_id continuity" }
                    if ($previousIds.reverseProtocolSwitchPresent -ne $true) { Add-Failure "third-party provider summary missing reverse-protocol previous_response_id continuity" }
                    if ($previousIds.saveMatched -ne $true) { Add-Failure "third-party provider summary save previous_response_id mismatch" }
                    if ($previousIds.restartMatched -ne $true) { Add-Failure "third-party provider summary restart previous_response_id mismatch" }
                    if ($previousIds.providerSwitchMatched -ne $true) { Add-Failure "third-party provider summary provider-switch previous_response_id mismatch" }
                    if ($previousIds.protocolSwitchMatched -ne $true) { Add-Failure "third-party provider summary protocol-switch previous_response_id mismatch" }
                    if ($previousIds.reverseProtocolSwitchMatched -ne $true) { Add-Failure "third-party provider summary reverse-protocol previous_response_id mismatch" }
                    if ($previousIds.providerSwitchMatchesNested -ne $true) { Add-Failure "third-party provider summary provider-switch previous_response_id mismatch" }
                    if ($previousIds.protocolSwitchMatchesNested -ne $true) { Add-Failure "third-party provider summary protocol-switch previous_response_id mismatch" }
                    if ($previousIds.reverseProtocolSwitchMatchesNested -ne $true) { Add-Failure "third-party provider summary reverse-protocol previous_response_id mismatch" }
                }
                $previousChain = $continuity.previousResponseIdChain
                if (-not $previousChain) {
                    Add-Failure "third-party provider summary missing previous_response_id chain values"
                } else {
                    if (-not [string]$previousChain.save) { Add-Failure "third-party provider summary missing save previous_response_id value" }
                    if (-not [string]$previousChain.restart) { Add-Failure "third-party provider summary missing restart previous_response_id value" }
                    if (-not [string]$previousChain.providerSwitch) { Add-Failure "third-party provider summary missing provider-switch previous_response_id value" }
                    if (-not [string]$previousChain.protocolSwitch) { Add-Failure "third-party provider summary missing protocol-switch previous_response_id value" }
                    if (-not [string]$previousChain.reverseProtocolSwitch) { Add-Failure "third-party provider summary missing reverse-protocol previous_response_id value" }
                    if (-not [string]$previousChain.providerSwitchNested) { Add-Failure "third-party provider summary missing nested provider-switch previous_response_id value" }
                    if (-not [string]$previousChain.protocolSwitchNested) { Add-Failure "third-party provider summary missing nested protocol-switch previous_response_id value" }
                    if (-not [string]$previousChain.reverseProtocolSwitchNested) { Add-Failure "third-party provider summary missing nested reverse-protocol previous_response_id value" }
                }
            }
        }
        $localConnectorsSummary = @($summary | Where-Object { $_.file -eq "latest-local-connectors.json" } | Select-Object -First 1)[0]
        if ($localConnectorsSummary) {
            if ($localConnectorsSummary.ok -ne $true) { Add-Failure "local connector summary ok=false" }
            if ($localConnectorsSummary.reportName -ne "local-connectors") { Add-Failure "local connector summary missing reportName" }
            if ($localConnectorsSummary.usedRealTraffic -ne $false) { Add-Failure "local connector summary used real traffic" }
            if ($localConnectorsSummary.behaviorCovered -ne $true) { Add-Failure "local connector summary behavior not covered" }
            if ($localConnectorsSummary.coverageKind -ne "local-fake-provider") { Add-Failure "local connector summary coverageKind mismatch" }
            $localEvidence = $localConnectorsSummary.localConnectorEvidence
            if (-not $localEvidence) {
                Add-Failure "local connector summary missing localConnectorEvidence"
            } else {
                if ($localEvidence.linkedConnectorAccessible -ne $true) { Add-Failure "local connector summary missing linked connector access proof" }
                if ($localEvidence.chatgptInstallUrlsScrubbed -ne $true) { Add-Failure "local connector summary missing ChatGPT URL scrub evidence" }
                if ($localEvidence.linkEndpointsUnsupported -ne $true) { Add-Failure "local connector summary missing metadata-only link endpoint evidence" }
                if ([int]$localEvidence.upstreamRequestsDuringLocalEndpoints -ne 0) { Add-Failure "local connector summary recorded upstream requests during local endpoints" }
                if ([int]$localEvidence.upstreamRequestsBeforeLocalEndpoints -ne [int]$localEvidence.upstreamRequestsAfterLocalEndpoints) { Add-Failure "local connector summary before/after upstream request counts differ" }
                if ($localEvidence.allowlistedConnectorAccessible -ne $false) { Add-Failure "local connector summary treats allowlist as access" }
                if ($localEvidence.allowlistedConnectorLocallyAllowlisted -ne $true) { Add-Failure "local connector summary missing local allowlist evidence" }
                if ($localEvidence.hiddenConnectorAccessible -ne $false) { Add-Failure "local connector summary exposes hidden connector" }
                if ([int]$localEvidence.exposedToolsPost -ne [int]$localEvidence.exposedToolsGet) { Add-Failure "local connector summary GET/POST tool counts differ" }
                if (@($localEvidence.exposedToolNames).Count -ne [int]$localEvidence.exposedToolsPost) { Add-Failure "local connector summary exposed tool names mismatch" }
                if ($localEvidence.connectorParityClean -ne $true) { Add-Failure "local connector summary missing connector parity proof" }
                if ($localEvidence.connectorFingerprintMatches -ne $true) { Add-Failure "local connector summary missing connector fingerprint match proof" }
                if (-not (Has-Property $localEvidence "connectorParityMissingShared")) { Add-Failure "local connector summary missing connector missing-shared drift samples" }
                if (-not (Has-Property $localEvidence "connectorParityExtraLocal")) { Add-Failure "local connector summary missing connector extra-local drift samples" }
                if (-not (Has-Property $localEvidence "connectorParityChangedShared")) { Add-Failure "local connector summary missing connector changed-shared drift samples" }
                if ($localEvidence.appToolParityClean -ne $true) { Add-Failure "local connector summary missing app-tool parity proof" }
                if ($localEvidence.appToolFingerprintMatches -ne $true) { Add-Failure "local connector summary missing app-tool fingerprint match proof" }
                if (-not (Has-Property $localEvidence "appToolParityMissingShared")) { Add-Failure "local connector summary missing app-tool missing-shared drift samples" }
                if (-not (Has-Property $localEvidence "appToolParityExtraLocal")) { Add-Failure "local connector summary missing app-tool extra-local drift samples" }
                if (-not (Has-Property $localEvidence "appToolParityChangedShared")) { Add-Failure "local connector summary missing app-tool changed-shared drift samples" }
                if ($localEvidence.appToolGetPostParityClean -ne $true) { Add-Failure "local connector summary missing GET/POST app-tool parity proof" }
                if ($localEvidence.tempSharedHomeUsed -ne $false) { Add-Failure "local connector summary used shared home during temp isolation" }
                if ($localEvidence.tempCodexHomeUnderStateRoot -ne $true) { Add-Failure "local connector summary missing temp CODEX_HOME isolation proof" }
                if ($localEvidence.tempSharedCodexHomeUnderStateRoot -ne $true) { Add-Failure "local connector summary missing temp shared home isolation proof" }
                if ($localEvidence.tempCodexHomeDistinctFromShared -ne $true) { Add-Failure "local connector summary CODEX_HOME is not distinct from shared home" }
                $exposedToolNames = @(As-FlatArray $localEvidence.exposedToolNames)
                if ($exposedToolNames.Count -ne 1 -or $exposedToolNames[0] -ne "linked_tool") {
                    Add-Failure "local connector summary exposed tool names is not exactly one 'linked_tool'"
                }
            }
        }
        $pluginCapabilitiesSummary = @($summary | Where-Object { $_.file -eq "latest-plugin-capabilities.json" } | Select-Object -First 1)[0]
        if ($pluginCapabilitiesSummary) {
            if ($pluginCapabilitiesSummary.ok -ne $true) { Add-Failure "plugin capability summary ok=false" }
            if ($pluginCapabilitiesSummary.shortBudgetMode -eq $true) { Add-Failure "plugin capability summary is short-budget and not release-grade" }
            if (-not $pluginCapabilitiesSummary.sourceSnapshotEvidence) { Add-Failure "plugin capability summary missing source snapshot evidence" }
            $pluginEvidence = $pluginCapabilitiesSummary.pluginCapabilityEvidence
            if (-not $pluginEvidence) {
                Add-Failure "plugin capability summary missing pluginCapabilityEvidence"
            } else {
                if ($pluginEvidence.nativeCodexWriteback -ne $false) { Add-Failure "plugin capability summary allows native Codex writeback" }
                if (-not [string]$pluginEvidence.capabilityState) { Add-Failure "plugin capability summary missing capability state" }
                if ($pluginEvidence.capabilityState -eq "degraded_short_budget") { Add-Failure "plugin capability summary is degraded by short budget" }
                if ($pluginEvidence.degraded -ne $true) { Add-Failure "plugin capability summary missing degraded metadata-only state" }
                if ([int]$pluginEvidence.connectorCount -lt [int]$pluginEvidence.enabledConnectorCount) { Add-Failure "plugin capability summary connector counts are inconsistent" }
                if ([int]$pluginEvidence.enabledConnectorCount -lt [int]$pluginEvidence.accessibleConnectorCount) { Add-Failure "plugin capability summary enabled/access connector counts are inconsistent" }
                if ([int]$pluginEvidence.accessibleConnectorCount -ne 0) { Add-Failure "plugin capability summary reports accessible connectors" }
                if ([int]$pluginEvidence.appToolCount -ne [int]$pluginEvidence.appToolGetCount) { Add-Failure "plugin capability summary GET/POST app tool counts differ" }
                if ([int]$pluginEvidence.unauthorizedAppToolCount -ne 0) { Add-Failure "plugin capability summary reports unauthorized app tools" }
                if ($pluginEvidence.smokeChecked -ne $true) { Add-Failure "plugin capability summary missing smoke checked proof" }
                if ($pluginEvidence.endpointProjectionReadable -ne $true) { Add-Failure "plugin capability summary missing endpoint projection proof" }
                if ($pluginEvidence.callableState -ne "skipped_no_accessible_connectors") { Add-Failure "plugin capability summary missing no-access callable state" }
                if (-not [string]$pluginEvidence.appToolsNote) { Add-Failure "plugin capability summary missing app tools no-access note" }
                if ($pluginEvidence.connectorParityChecked -ne $true) { Add-Failure "plugin capability summary missing connector parity checked proof" }
                if ($pluginEvidence.appToolParityChecked -ne $true) { Add-Failure "plugin capability summary missing app-tool parity checked proof" }
                if ($pluginEvidence.appToolGetPostParityChecked -ne $true) { Add-Failure "plugin capability summary missing GET/POST checked proof" }
                if ($pluginEvidence.appToolGetPostParityContentMatches -ne $true) { Add-Failure "plugin capability summary missing GET/POST content match proof" }
                if ($pluginEvidence.connectorCacheChecked -ne $true -or $pluginEvidence.connectorCacheExists -ne $true -or $pluginEvidence.connectorCacheSampleReadable -ne $true) { Add-Failure "plugin capability summary missing connector cache smoke proof" }
                if ($pluginEvidence.appToolsCacheChecked -ne $true -or $pluginEvidence.appToolsCacheExists -ne $true -or $pluginEvidence.appToolsCacheSampleReadable -ne $true) { Add-Failure "plugin capability summary missing app-tools cache smoke proof" }
                if ($pluginEvidence.connectorParityClean -ne $true) { Add-Failure "plugin capability summary missing connector parity evidence" }
                if ($pluginEvidence.appToolParityClean -ne $true) { Add-Failure "plugin capability summary missing app-tool parity evidence" }
                if ($pluginEvidence.appToolGetPostParityClean -ne $true) { Add-Failure "plugin capability summary missing GET/POST parity evidence" }
                if (-not (Has-Property $pluginEvidence "connectorParityMissingShared")) { Add-Failure "plugin capability summary missing connector parity drift samples" }
                if (-not (Has-Property $pluginEvidence "connectorParityExtraLocal")) { Add-Failure "plugin capability summary missing extra local connector drift samples" }
                if (-not (Has-Property $pluginEvidence "connectorParityChangedShared")) { Add-Failure "plugin capability summary missing changed connector drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolParityMissingShared")) { Add-Failure "plugin capability summary missing app-tool missing drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolParityExtraLocal")) { Add-Failure "plugin capability summary missing extra local app-tool drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolParityChangedShared")) { Add-Failure "plugin capability summary missing changed app-tool drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolGetPostMissingFromGet")) { Add-Failure "plugin capability summary missing GET/POST drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolGetPostExtraFromGet")) { Add-Failure "plugin capability summary missing GET/POST extra drift samples" }
            }
        }
        $logDbGuardSummary = @($summary | Where-Object { $_.file -eq "latest-log-db-guard.json" } | Select-Object -First 1)[0]
        if (-not $logDbGuardSummary) {
            Add-Failure "diagnostic reports summary missing latest-log-db-guard.json"
        } else {
            if ($logDbGuardSummary.reportName -ne "log-db-guard") { Add-Failure "diagnostic log database guard summary reportName mismatch" }
            $logEvidence = $logDbGuardSummary.logDbGuardEvidence
            if (-not $logEvidence) {
                Add-Failure "diagnostic log database guard summary missing logDbGuardEvidence"
            } else {
                if ($logEvidence.noTraffic -ne $true) { Add-Failure "diagnostic log database guard summary missing noTraffic" }
                if ($logEvidence.usedRealTraffic -ne $false) { Add-Failure "diagnostic log database guard summary used real traffic" }
                if ($logEvidence.protected -ne $true) { Add-Failure "diagnostic log database guard summary is not protected" }
                if ($logEvidence.triggerPresent -ne $true) { Add-Failure "diagnostic log database guard summary trigger missing" }
                if (-not (Has-Property $logEvidence "walBytes")) { Add-Failure "diagnostic log database guard summary missing wal size" }
                else {
                    [double]$walBytes = 0
                    if (
                        -not [double]::TryParse([string]$logEvidence.walBytes, [ref]$walBytes) -or
                        [double]::IsNaN($walBytes) -or
                        [double]::IsInfinity($walBytes) -or
                        $walBytes -lt 0
                    ) {
                        Add-Failure "diagnostic log database guard summary invalid wal size"
                    }
                }
            }
        }
        $mcpSkillsSummary = @($summary | Where-Object { $_.file -eq "latest-mcp-skills.json" } | Select-Object -First 1)[0]
        if ($mcpSkillsSummary) {
            if ($mcpSkillsSummary.ok -ne $true) { Add-Failure "MCP/Skill summary ok=false" }
            if (-not $mcpSkillsSummary.sourceSnapshotEvidence) { Add-Failure "MCP/Skill summary missing source snapshot evidence" }
            if ($mcpSkillsSummary.shortBudgetMode -eq $true) {
                if ($mcpSkillsSummary.sourceSnapshotEvidence.reusedFromPreviousReport -ne $true) { Add-Failure "MCP/Skill short-budget summary missing reused source snapshot proof" }
                if (-not [string]$mcpSkillsSummary.sourceSnapshotEvidence.refreshSkippedReason) { Add-Failure "MCP/Skill short-budget summary missing refresh skipped reason" }
            }
            $mcpSkillEvidence = $mcpSkillsSummary.mcpSkillEvidence
            if (-not $mcpSkillEvidence) {
                Add-Failure "MCP/Skill summary missing mcpSkillEvidence"
            } else {
                if ([int]$mcpSkillEvidence.mcpCount -lt 1) { Add-Failure "MCP/Skill summary has no MCP entries" }
                if ([int]$mcpSkillEvidence.mcpSharedCount -lt 1) { Add-Failure "MCP/Skill summary has no shared MCP entries" }
                if (@($mcpSkillEvidence.mcpMissingShared).Count -ne 0) { Add-Failure "MCP/Skill summary has missing shared MCP entries" }
                if (@($mcpSkillEvidence.mcpExtraLocal).Count -ne 0) { Add-Failure "MCP/Skill summary has extra local MCP entries" }
                if (@($mcpSkillEvidence.mcpChangedShared).Count -ne 0) { Add-Failure "MCP/Skill summary has changed shared MCP entries" }
                if ($mcpSkillEvidence.hasNodeRepl -ne $true) { Add-Failure "MCP/Skill summary missing node_repl evidence" }
                if ($mcpSkillEvidence.mcpSmokePassed -ne $true) { Add-Failure "MCP/Skill summary missing MCP smoke evidence" }
                if ($mcpSkillEvidence.mcpRealCallPassed -ne $true) { Add-Failure "MCP/Skill summary missing MCP real-call evidence" }
                if ([int]$mcpSkillEvidence.mcpRealListCount -lt $RequiredWorkerMcpServers.Count) { Add-Failure "MCP/Skill summary missing MCP real tools/list count evidence" }
                if ([int]$mcpSkillEvidence.mcpRealListPassed -lt $RequiredWorkerMcpServers.Count) { Add-Failure "MCP/Skill summary missing MCP real tools/list passed evidence" }
                if ([int]$mcpSkillEvidence.mcpRealListToolCount -lt $RequiredWorkerMcpServers.Count) { Add-Failure "MCP/Skill summary missing MCP real tools/list tool count evidence" }
                $mcpRealListPassedServers = @(As-FlatArray $mcpSkillEvidence.mcpRealListPassedServers | ForEach-Object { [string]$_ })
                $missingWorkerMcpRealList = @($RequiredWorkerMcpServers | Where-Object { $mcpRealListPassedServers -notcontains $_ })
                if ($missingWorkerMcpRealList.Count -ne 0) { Add-Failure "MCP/Skill summary missing worker MCP real tools/list evidence: $($missingWorkerMcpRealList -join ', ')" }
                if ([int]$mcpSkillEvidence.skillCount -lt 1) { Add-Failure "MCP/Skill summary has no skills" }
                if ([int]$mcpSkillEvidence.expectedSharedSkillCount -lt 1) { Add-Failure "MCP/Skill summary missing expected shared skill count" }
                if ([int]$mcpSkillEvidence.agentsSkillCount -lt 1) { Add-Failure "MCP/Skill summary missing .agents skill count" }
                if (@($mcpSkillEvidence.missingSharedSkills).Count -ne 0) { Add-Failure "MCP/Skill summary has missing shared skills" }
                if (@($mcpSkillEvidence.extraLocalSkills).Count -ne 0) { Add-Failure "MCP/Skill summary has extra local skills" }
                if (@($mcpSkillEvidence.changedSharedSkills).Count -ne 0) { Add-Failure "MCP/Skill summary has changed shared skills" }
                if (@($mcpSkillEvidence.conflictingDuplicateSkillNames).Count -ne 0) { Add-Failure "MCP/Skill summary has conflicting duplicate skills" }
                if ($mcpSkillsSummary.shortBudgetMode -eq $true -and $mcpSkillEvidence.skillFingerprintSkipped -ne $true) { Add-Failure "MCP/Skill short-budget summary missing skill fingerprint skipped proof" }
                if ($mcpSkillEvidence.skillSmokeReadable -ne $true) { Add-Failure "MCP/Skill summary missing skill smoke evidence" }
                if ($mcpSkillEvidence.appToolRegistryExists -eq $true) {
                    if ($mcpSkillEvidence.appToolRegistryContentMatches -ne $true) { Add-Failure "MCP/Skill summary app-tool registry content mismatch" }
                    if ($mcpSkillEvidence.appToolRegistryFingerprintMatches -ne $true) { Add-Failure "MCP/Skill summary app-tool registry fingerprint mismatch" }
                    if (-not (Has-Property $mcpSkillEvidence "appToolRegistrySharedFileCount") -or $null -eq $mcpSkillEvidence.appToolRegistrySharedFileCount) { Add-Failure "MCP/Skill summary app-tool registry missing shared file count" }
                    if (-not (Has-Property $mcpSkillEvidence "appToolRegistryLocalFileCount") -or $null -eq $mcpSkillEvidence.appToolRegistryLocalFileCount) { Add-Failure "MCP/Skill summary app-tool registry missing local file count" }
                    if ([int]$mcpSkillEvidence.appToolRegistrySharedFileCount -ne [int]$mcpSkillEvidence.appToolRegistryLocalFileCount) { Add-Failure "MCP/Skill summary app-tool registry file counts differ" }
                }
            }
        }
        $refreshFeaturesSummary = @($summary | Where-Object { $_.file -eq "latest-refresh-features.json" } | Select-Object -First 1)[0]
        Test-RefreshFeaturesSummarySupportEvidence $refreshFeaturesSummary
        $optionalRealProviderSummary = @($summary | Where-Object { $_.file -eq "latest-real-third-party-provider.json" } | Select-Object -First 1)[0]
        if ($optionalRealProviderSummary -and $optionalRealProviderSummary.skipped -eq $true) {
            if ($optionalRealProviderSummary.requestedRealTraffic -ne $false) { Add-Failure "optional real-provider skipped summary requested real traffic" }
            if ($optionalRealProviderSummary.usedRealTraffic -ne $false) { Add-Failure "optional real-provider skipped summary used real traffic" }
            if ($optionalRealProviderSummary.behaviorCovered -ne $false) { Add-Failure "optional real-provider skipped summary claims behavior coverage" }
            if ([string]$optionalRealProviderSummary.coverageKind -ne "skipped") { Add-Failure "optional real-provider skipped summary coverage kind mismatch" }
            if (-not [string]$optionalRealProviderSummary.reason) { Add-Failure "optional real-provider skipped summary missing reason" }
            if (-not [string]$optionalRealProviderSummary.coveredBy) { Add-Failure "optional real-provider skipped summary missing coveredBy" }
        } elseif ($optionalRealProviderSummary) {
            if ($optionalRealProviderSummary.reportName -ne "real-third-party-provider") { Add-Failure "optional real-provider summary reportName mismatch" }
            $optionalEvidence = $optionalRealProviderSummary.optionalRealProviderEvidence
            if (-not $optionalEvidence) {
                Add-Failure "optional real-provider summary missing continuity evidence"
            } else {
                if ($optionalEvidence.firstMarkerObserved -ne $true) { Add-Failure "optional real-provider summary missing first marker evidence" }
                if ($optionalEvidence.secondMarkerObserved -ne $true) { Add-Failure "optional real-provider summary missing second marker evidence" }
                if ($optionalEvidence.historyContinuationObserved -ne $true) { Add-Failure "optional real-provider summary missing history continuation evidence" }
                if ([string]$optionalEvidence.routeTransport -ne "upstream-provider") { Add-Failure "optional real-provider summary missing upstream-provider route evidence" }
                if (-not [string]$optionalEvidence.routeProviderProtocol) { Add-Failure "optional real-provider summary missing provider protocol route evidence" }
                if (-not [string]$optionalEvidence.routeResolvedModel) { Add-Failure "optional real-provider summary missing resolved model route evidence" }
                if ([string]$optionalEvidence.routeStatus -ne "success") { Add-Failure "optional real-provider summary missing successful route evidence" }
                if ($optionalEvidence.secretsRedacted -ne $true) { Add-Failure "optional real-provider summary missing redaction evidence" }
                if ([int]$optionalEvidence.turns -lt 2) { Add-Failure "optional real-provider summary has fewer than 2 turns" }
            }
        }
        $antigravityReturnSummary = @($summary | Where-Object { $_.file -eq "latest-provider-antigravity-return.json" } | Select-Object -First 1)[0]
        if ($antigravityReturnSummary -and $antigravityReturnSummary.skipped -eq $true) {
            if ($antigravityReturnSummary.requestedRealTraffic -ne $false) { Add-Failure "Antigravity return skipped summary requested real traffic" }
            if ($antigravityReturnSummary.usedRealTraffic -ne $false) { Add-Failure "Antigravity return skipped summary used real traffic" }
            if ($antigravityReturnSummary.behaviorCovered -ne $false) { Add-Failure "Antigravity return skipped summary claims behavior coverage" }
            if ([string]$antigravityReturnSummary.coverageKind -ne "skipped") { Add-Failure "Antigravity return skipped summary coverage kind mismatch" }
            if (-not [string]$antigravityReturnSummary.reason) { Add-Failure "Antigravity return skipped summary missing reason" }
            if (-not [string]$antigravityReturnSummary.coveredBy) { Add-Failure "Antigravity return skipped summary missing coveredBy" }
        } elseif ($antigravityReturnSummary) {
            if ($antigravityReturnSummary.reportName -ne "provider-antigravity-return") { Add-Failure "Antigravity return summary reportName mismatch" }
            $returnEvidence = $antigravityReturnSummary.antigravityReturnEvidence
            if (-not $returnEvidence) {
                Add-Failure "Antigravity return summary missing continuity evidence"
            } else {
                if ($returnEvidence.realAntigravityTurnUsed -ne $true) { Add-Failure "Antigravity return summary missing real-turn evidence" }
                if ($returnEvidence.returnedToAntigravityWithHistory -ne $true) { Add-Failure "Antigravity return summary missing history return evidence" }
                if ($returnEvidence.previousResponseIdMatched -ne $true) { Add-Failure "Antigravity return summary missing previous_response_id evidence" }
                if ([int]$returnEvidence.markerCount -lt 6) { Add-Failure "Antigravity return summary missing marker-count evidence" }
                if ([int]$returnEvidence.missingMarkerCount -ne 0) { Add-Failure "Antigravity return summary reports missing markers" }
                if (-not [string]$returnEvidence.routeTransport -or [string]$returnEvidence.routeTransport -eq "upstream-provider") { Add-Failure "Antigravity return summary missing native route evidence" }
                if (-not [string]$returnEvidence.resolvedModel) { Add-Failure "Antigravity return summary missing resolved model evidence" }
            }
        }
        $releaseGatesSummary = @($summary | Where-Object { $_.file -eq "latest-release-gates.json" } | Select-Object -First 1)[0]
        if ($releaseGatesSummary) {
            $releaseBlockedOnlyByRequiredRealTraffic = (Has-Property $releaseGatesSummary "releaseBlockedOnlyByRequiredRealTraffic") -and $releaseGatesSummary.releaseBlockedOnlyByRequiredRealTraffic -eq $true
            if ($releaseGatesSummary.ok -ne $true) { Add-Failure "release-gates summary ok=false" }
            if ($releaseGatesSummary.shortReady -ne $true) { Add-Failure "release-gates summary shortReady is not true" }
            if (-not (Has-Property $releaseGatesSummary "releaseReady")) { Add-Failure "release-gates summary missing releaseReady" }
            elseif ($releaseGatesSummary.releaseReady -ne $true -and -not $releaseBlockedOnlyByRequiredRealTraffic) { Add-Failure "release-gates summary releaseReady is not true" }
            if (-not (Has-Property $releaseGatesSummary "effectiveOk")) { Add-Failure "release-gates summary missing effectiveOk" }
            elseif ($releaseGatesSummary.effectiveOk -ne $true -and -not $releaseBlockedOnlyByRequiredRealTraffic) { Add-Failure "release-gates summary effectiveOk is not true" }
            if (-not (Has-Property $releaseGatesSummary "releaseBlockedOnlyByRequiredRealTraffic")) { Add-Failure "release-gates summary missing required real-traffic-only blocker flag" }
            if (-not (Has-Property $releaseGatesSummary "requiredRealTrafficBlockedGates")) { Add-Failure "release-gates summary missing required real-traffic blocker gate IDs" }
            if (-not (Has-Property $releaseGatesSummary "strictOptionalRealTraffic")) { Add-Failure "release-gates summary missing strict optional real-traffic flag" }
            if (-not (Has-Property $releaseGatesSummary "optionalRealTrafficReady")) { Add-Failure "release-gates summary missing optional real-traffic readiness" }
            if (-not (Has-Property $releaseGatesSummary "optionalRealTrafficFailures")) { Add-Failure "release-gates summary missing optional real-traffic failures" }
            if (-not (Has-Property $releaseGatesSummary "missingRequired")) { Add-Failure "release-gates summary missing missingRequired" }
            if (-not (Has-Property $releaseGatesSummary "missingShort")) { Add-Failure "release-gates summary missing missingShort" }
            if (-not (Has-Property $releaseGatesSummary "missingOptional")) { Add-Failure "release-gates summary missing missingOptional" }
            if (-not (Has-Property $releaseGatesSummary "damagedReports")) { Add-Failure "release-gates summary missing damagedReports" }
            if (-not (Has-Property $releaseGatesSummary "releaseGateFailures")) { Add-Failure "release-gates summary missing semantic failure details" }
            if (-not (Has-Property $releaseGatesSummary "releaseGateFailureReasons")) { Add-Failure "release-gates summary missing failure reason details" }
            Test-ReleaseGateApprovalAndOfflineEvidence $releaseGatesSummary
            if (-not (Has-Property $releaseGatesSummary "releaseGateSelectedReports")) { Add-Failure "release-gates summary missing selected history report details" }
            $syncReadinessReason = @($releaseGatesSummary.releaseGateFailureReasons | Where-Object { $_.id -eq "syncReadiness" -and $_.selectedFromHistory -eq $true } | Select-Object -First 1)[0]
            if ($syncReadinessReason) {
                $syncReadinessSelectedReports = @($releaseGatesSummary.releaseGateSelectedReports | Where-Object { $_.id -eq "syncReadiness" -and $_.selectedFile })
                if ($syncReadinessSelectedReports.Count -lt 1) {
                    Add-Failure "release-gates summary missing sync-readiness selected history report"
                }
                if ($syncReadinessReason.historySourceMismatch -eq $true -and @($syncReadinessSelectedReports | Where-Object { $_.historySourceMismatch -eq $true }).Count -lt 1) {
                    Add-Failure "release-gates summary missing sync-readiness history source mismatch detail"
                }
            }
            Test-InstalledRuntimeEvidence $releaseGatesSummary.installedRuntimeEvidence
        }
        $missingHistorySummary = @($summary | Where-Object { $_.file -eq "latest-missing-history.json" } | Select-Object -First 1)[0]
        if (-not $missingHistorySummary) {
            Add-Failure "diagnostic reports summary missing latest-missing-history.json"
        } else {
            $missingEvidence = $missingHistorySummary.missingHistoryEvidence
            if (-not $missingEvidence) {
                Add-Failure "missing-history summary missing missingHistoryEvidence"
            } elseif ($missingHistorySummary.ok -eq $true) {
                if ([int]$missingEvidence.status -ne 410) { Add-Failure "missing-history summary status is not 410" }
                if ([string]$missingEvidence.errorType -ne "response_history_missing") { Add-Failure "missing-history summary error type mismatch" }
                if ($missingEvidence.retryable -ne $false) { Add-Failure "missing-history summary should be non-retryable" }
                if ($missingEvidence.previousResponseIdMatched -ne $true) { Add-Failure "missing-history summary missing previous_response_id match" }
                if ($missingEvidence.recoveryGuidancePresent -ne $true) { Add-Failure "missing-history summary missing recovery guidance" }
                if ($missingEvidence.noRouteChange -ne $true) { Add-Failure "missing-history summary reports route change" }
                if ($missingEvidence.usedRealTraffic -ne $false) { Add-Failure "missing-history summary used real traffic" }
                if ([string]$missingEvidence.coverageKind -ne "installed-no-traffic") { Add-Failure "missing-history summary coverage kind mismatch" }
            }
        }
        $coldRelaunchSummary = @($summary | Where-Object { $_.file -eq "latest-cold-relaunch.json" } | Select-Object -First 1)[0]
        if ($coldRelaunchSummary) {
            $coldEvidence = $coldRelaunchSummary.coldRelaunchEvidence
            if (-not $coldEvidence) {
                Add-Failure "cold relaunch summary missing coldRelaunchEvidence"
            } elseif ($coldRelaunchSummary.ok -eq $true) {
                if ($coldEvidence.healthOk -ne $true) { Add-Failure "cold relaunch summary missing healthy state" }
                if ($coldEvidence.providerReady -ne $true) { Add-Failure "cold relaunch summary missing provider readiness" }
                if ([int]$coldEvidence.mainCount -ne 1) { Add-Failure "cold relaunch summary missing exact main process count" }
                if ([int]$coldEvidence.translatorCount -lt 1) { Add-Failure "cold relaunch summary missing translator process" }
                if ($coldEvidence.originalCodexUnchanged -ne $true) { Add-Failure "cold relaunch summary missing original Codex isolation proof" }
                if ([int]$coldEvidence.failedStageCount -ne 0) { Add-Failure "cold relaunch summary reports failed stages" }
            }
        }
        $stabilitySoakSummary = @($summary | Where-Object { $_.file -eq "latest-stability-soak.json" } | Select-Object -First 1)[0]
        if ($stabilitySoakSummary) {
            $soakEvidence = $stabilitySoakSummary.stabilitySoakEvidence
            if (-not $soakEvidence) {
                Add-Failure "stability soak summary missing stabilitySoakEvidence"
            } elseif ($stabilitySoakSummary.ok -eq $true) {
                if ($soakEvidence.providerReady -ne $true -or $soakEvidence.startReady -ne $true -or $soakEvidence.endReady -ne $true) { Add-Failure "stability soak summary missing readiness proof" }
                if ($soakEvidence.pidStable -ne $true) { Add-Failure "stability soak summary missing stable PID proof" }
                if ([int]$soakEvidence.healthChecks -lt 1) { Add-Failure "stability soak summary missing health checks" }
                if ([int]$soakEvidence.turnCount -lt 1) { Add-Failure "stability soak summary missing turns" }
                if ([int]$soakEvidence.failedTurnCount -ne 0) { Add-Failure "stability soak summary reports failed turns" }
            }
        }
        $managerRealButtonsSummary = @($summary | Where-Object { $_.file -eq "latest-manager-real-buttons.json" } | Select-Object -First 1)[0]
        if (-not $managerRealButtonsSummary) {
            Add-Failure "diagnostic reports summary missing latest-manager-real-buttons.json"
        } else {
            if ($managerRealButtonsSummary.ok -ne $true) { Add-Failure "manager-real-buttons summary ok=false" }
            if ($managerRealButtonsSummary.reportName -ne "manager-real-buttons") { Add-Failure "manager-real-buttons summary missing reportName" }
            if ([int]$managerRealButtonsSummary.failureCount -ne 0) { Add-Failure "manager-real-buttons summary has failures" }
            if ($managerRealButtonsSummary.managerButtonOk -ne $true) { Add-Failure "manager-real-buttons summary missing managerButton ok=true" }
            $actions = @($managerRealButtonsSummary.actions | ForEach-Object { [string]$_ })
            foreach ($requiredAction in @("mcpSkills", "pluginCapabilities")) {
                if ($actions -notcontains $requiredAction) { Add-Failure "manager-real-buttons summary missing action: $requiredAction" }
                $actionResult = @($managerRealButtonsSummary.managerButtonResults | Where-Object { $_.action -eq $requiredAction } | Select-Object -First 1)[0]
                if (-not $actionResult) {
                    Add-Failure "manager-real-buttons summary missing result: $requiredAction"
                } else {
                    if ($actionResult.ok -ne $true) { Add-Failure "manager-real-buttons action not ok: $requiredAction" }
                    if ($null -eq $actionResult.lastUiOnly) { Add-Failure "manager-real-buttons action missing lastUiOnly evidence: $requiredAction" }
                    if ($actionResult.lastUiOnly -eq $true) { Add-Failure "manager-real-buttons action used ui-only smoke: $requiredAction" }
                    if ($actionResult.bridgeReady -ne $true) { Add-Failure "manager-real-buttons action missing bridge ready evidence: $requiredAction" }
                    if ($actionResult.overlayPresent -ne $true) { Add-Failure "manager-real-buttons action missing overlay evidence: $requiredAction" }
                    if ($actionResult.actionCenterHitsButton -ne $true) { Add-Failure "manager-real-buttons action center did not hit button: $requiredAction" }
                    if ($actionResult.closeHitAreaOk -ne $true) { Add-Failure "manager-real-buttons action close hit area failed: $requiredAction" }
                    if ($actionResult.managerOpenedNewPage -ne $false) { Add-Failure "manager-real-buttons action opened a new page: $requiredAction" }
                    if ($null -eq $actionResult.pageTargetCountBeforeManagerOpen -or $null -eq $actionResult.pageTargetCountAfterManagerOpen) { Add-Failure "manager-real-buttons action missing page target counts: $requiredAction" }
                    if ([int]$actionResult.pageTargetCountAfterManagerOpen -gt [int]$actionResult.pageTargetCountBeforeManagerOpen) { Add-Failure "manager-real-buttons action increased page target count: $requiredAction" }
                }
            }
        }
    }

    foreach ($path in @($refreshPath, $summaryPath)) {
        if ((Test-Path -LiteralPath $path -PathType Leaf) -and ((Get-Content -LiteralPath $path -Raw) -match "(?i)tool output|messages|input_items|Return exactly this")) {
            Add-Failure "diagnostic bundle model summary exposes transcript-like fields: $(Split-Path -Leaf $path)"
        }
    }
    foreach ($path in @($lifecycleStatusPath, $lifecycleLogPath)) {
        if ((Test-Path -LiteralPath $path -PathType Leaf) -and ((Get-Content -LiteralPath $path -Raw) -match "(?i)tool output|messages|input_items|Return exactly this")) {
            Add-Failure "diagnostic lifecycle log exposes transcript-like fields: $(Split-Path -Leaf $path)"
        }
    }

    return [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        zipPath = $bundle.zipPath
        antigravityReports = [pscustomobject]@{
            required = $antigravityReportsRequired
            note = if ($antigravityReportsRequired) { "Antigravity reports are required" } else { "third-party diagnostic bundle treats Antigravity reports as optional" }
        }
        retainedBundles = if ($bundle.PSObject.Properties.Name -contains "retainedBundles") { $bundle.retainedBundles } else { $null }
        lifecycleLogs = [pscustomobject]@{
            statusPresent = Test-Path -LiteralPath $lifecycleStatusPath -PathType Leaf
            logPresent = Test-Path -LiteralPath $lifecycleLogPath -PathType Leaf
        }
        modelRoutingRefresh = if ($refresh) {
            [pscustomobject]@{
                ok = $refresh.ok
                modelCount = $refresh.modelCount
                skipRequests = $refresh.skipRequests
            }
        } else { $null }
        modelRoutingSummary = if ($modelSummary) {
            [pscustomobject]@{
                modelCount = $modelSummary.modelCount
                skipRequests = $modelSummary.skipRequests
                models = @($modelSummary.models)
                evidence = $modelSummary.modelRoutingEvidence
            }
        } else { $null }
        modelThinkingSummary = if ($modelThinkingSummary) {
            [pscustomobject]@{
                ok = $modelThinkingSummary.ok
                evidence = $modelThinkingSummary.modelThinkingEvidence
            }
        } else { $null }
        toolBridgeSummary = if ($toolBridgeSummary) {
            [pscustomobject]@{
                ok = $toolBridgeSummary.ok
                evidence = $toolBridgeSummary.toolBridgeEvidence
            }
        } else { $null }
        uiIdleSummary = if ($uiIdleSummary) {
            [pscustomobject]@{
                ok = $uiIdleSummary.ok
                evidence = $uiIdleSummary.uiIdleEvidence
            }
        } else { $null }
        syncReadinessSummary = if ($syncReadinessSummary) {
            [pscustomobject]@{
                ok = $syncReadinessSummary.ok
                evidence = $syncReadinessSummary.syncReadinessEvidence
            }
        } else { $null }
        installedOverall = [pscustomobject]@{
            fast = if ($installedFastSummary) { $installedFastSummary.installedOverallEvidence } else { $null }
            full = if ($installedFullSummary) { $installedFullSummary.installedOverallEvidence } else { $null }
        }
        postVerification = if ($postVerificationSummary) {
            [pscustomobject]@{
                ok = $postVerificationSummary.ok
                state = $postVerificationSummary.state
                usedRealTraffic = $postVerificationSummary.usedRealTraffic
                latestDiagnosis = $postVerificationSummary.latestDiagnosis
                latestDiagnosisDetail = $postVerificationSummary.latestDiagnosisDetail
                attempts = $postVerificationSummary.attempts
            }
        } else { $null }
        managerRealButtons = if ($managerRealButtonsSummary) {
            [pscustomobject]@{
                ok = $managerRealButtonsSummary.ok
                reportName = $managerRealButtonsSummary.reportName
                actions = @($managerRealButtonsSummary.actions)
                managerButtonOk = $managerRealButtonsSummary.managerButtonOk
            }
        } else { $null }
        releaseGates = if ($releaseGatesSummary) {
            [pscustomobject]@{
                ok = $releaseGatesSummary.ok
                shortReady = $releaseGatesSummary.shortReady
                releaseReady = $releaseGatesSummary.releaseReady
                strictOptionalRealTraffic = $releaseGatesSummary.strictOptionalRealTraffic
                optionalRealTrafficReady = $releaseGatesSummary.optionalRealTrafficReady
                optionalRealTrafficFailures = @($releaseGatesSummary.optionalRealTrafficFailures)
                missingRequired = @($releaseGatesSummary.missingRequired)
                missingShort = @($releaseGatesSummary.missingShort)
                missingOptional = @($releaseGatesSummary.missingOptional)
                damagedReports = @($releaseGatesSummary.damagedReports)
                releaseGateFailures = @($releaseGatesSummary.releaseGateFailures)
                releaseGateGroups = @($releaseGatesSummary.releaseGateGroups)
                releaseGateFailureReasons = @($releaseGatesSummary.releaseGateFailureReasons)
                nextActions = @($releaseGatesSummary.nextActions)
                nextActionsAvailableCount = $releaseGatesSummary.nextActionsAvailableCount
                nextActionsHiddenCount = $releaseGatesSummary.nextActionsHiddenCount
                nextActionsTruncated = $releaseGatesSummary.nextActionsTruncated
                approvalPlan = $releaseGatesSummary.approvalPlan
                releaseGateSelectedReports = @($releaseGatesSummary.releaseGateSelectedReports)
                installedRuntimeEvidence = $releaseGatesSummary.installedRuntimeEvidence
            }
        } else { $null }
        missingHistory = if ($missingHistorySummary) {
            [pscustomobject]@{
                ok = $missingHistorySummary.ok
                evidence = $missingHistorySummary.missingHistoryEvidence
            }
        } else { $null }
        coldRelaunch = if ($coldRelaunchSummary) {
            [pscustomobject]@{
                ok = $coldRelaunchSummary.ok
                evidence = $coldRelaunchSummary.coldRelaunchEvidence
            }
        } else { $null }
        mcpSkills = if ($mcpSkillsSummary) {
            [pscustomobject]@{
                ok = $mcpSkillsSummary.ok
                evidence = $mcpSkillsSummary.mcpSkillEvidence
                sourceSnapshot = $mcpSkillsSummary.sourceSnapshotEvidence
            }
        } else { $null }
        pluginCapabilities = if ($pluginCapabilitiesSummary) {
            [pscustomobject]@{
                ok = $pluginCapabilitiesSummary.ok
                evidence = $pluginCapabilitiesSummary.pluginCapabilityEvidence
                sourceSnapshot = $pluginCapabilitiesSummary.sourceSnapshotEvidence
            }
        } else { $null }
        refreshFeatures = if ($refreshFeaturesSummary) {
            [pscustomobject]@{
                ok = $refreshFeaturesSummary.ok
                evidence = $refreshFeaturesSummary.refreshFeatureEvidence
                sourceSnapshot = $refreshFeaturesSummary.sourceSnapshotEvidence
            }
        } else { $null }
        optionalRealProvider = if ($optionalRealProviderSummary) {
            [pscustomobject]@{
                ok = $optionalRealProviderSummary.ok
                skipped = $optionalRealProviderSummary.skipped
                requestedRealTraffic = $optionalRealProviderSummary.requestedRealTraffic
                usedRealTraffic = $optionalRealProviderSummary.usedRealTraffic
                behaviorCovered = $optionalRealProviderSummary.behaviorCovered
                coverageKind = $optionalRealProviderSummary.coverageKind
                reason = $optionalRealProviderSummary.reason
                coveredBy = $optionalRealProviderSummary.coveredBy
                evidence = $optionalRealProviderSummary.optionalRealProviderEvidence
            }
        } else { $null }
        antigravityReturn = if ($antigravityReturnSummary) {
            [pscustomobject]@{
                ok = $antigravityReturnSummary.ok
                skipped = $antigravityReturnSummary.skipped
                requestedRealTraffic = $antigravityReturnSummary.requestedRealTraffic
                usedRealTraffic = $antigravityReturnSummary.usedRealTraffic
                behaviorCovered = $antigravityReturnSummary.behaviorCovered
                coverageKind = $antigravityReturnSummary.coverageKind
                reason = $antigravityReturnSummary.reason
                coveredBy = $antigravityReturnSummary.coveredBy
                evidence = $antigravityReturnSummary.antigravityReturnEvidence
            }
        } else { $null }
        thirdPartyProvider = if ($thirdPartyProviderSummary) {
            [pscustomobject]@{
                ok = $thirdPartyProviderSummary.ok
                savedWithoutHistoryLoss = $thirdPartyProviderSummary.savedWithoutHistoryLoss
                restartedProviderWithoutHistoryLoss = $thirdPartyProviderSummary.restartedProviderWithoutHistoryLoss
                switchedProviderWithoutHistoryLoss = $thirdPartyProviderSummary.switchedProviderWithoutHistoryLoss
                crossProtocolWithoutHistoryLoss = $thirdPartyProviderSummary.crossProtocolWithoutHistoryLoss
                reverseCrossProtocolWithoutHistoryLoss = $thirdPartyProviderSummary.reverseCrossProtocolWithoutHistoryLoss
                secretsRedacted = $thirdPartyProviderSummary.secretsRedacted
                continuity = $thirdPartyProviderSummary.providerContinuity
            }
        } else { $null }
    }
}

$diagnostics = $null
$diagnosticMode = "unknown"
$diagnosticProtocol = $null
$diagnosticModel = $null
$reportsSummaryCheck = $null
if ($VerifyReportsSummary) {
    try {
        $reportsSummaryCheck = Test-ReportsSummary -SummaryPath $VerifyReportsSummary -RequireReleaseReady:$false
    } catch {
        Add-Failure "reports summary verification failed: $($_.Exception.Message)"
    }
} else {
    try {
        $diagnostics = Invoke-LocalJson "/anticodex/diagnostics"
    } catch {
        Add-Failure "diagnostics request failed: $($_.Exception.Message)"
    }
}

if ($diagnostics) {
    if ($diagnostics.ok -ne $true) { Add-Failure "diagnostics ok=false" }
    if ($diagnostics.object -ne "anticodex.diagnostics") { Add-Failure "diagnostics object mismatch" }
    $hasHealthProfile = (Has-Property $diagnostics.health "upstreamProfile") -and $null -ne $diagnostics.health.upstreamProfile
    if ($hasHealthProfile) {
        $diagnosticMode = if (Has-Property $diagnostics.health.upstreamProfile "mode") { [string]$diagnostics.health.upstreamProfile.mode } else { "unknown" }
        $diagnosticProtocol = if (Has-Property $diagnostics.health.upstreamProfile "protocol") { [string]$diagnostics.health.upstreamProfile.protocol } else { $null }
        $diagnosticModel = if (Has-Property $diagnostics.health.upstreamProfile "model") { [string]$diagnostics.health.upstreamProfile.model } else { $null }
    } elseif ((Has-Property $diagnostics.mode "antigravity") -and $diagnostics.mode.antigravity -eq $true) {
        $diagnosticMode = "antigravity"
    } elseif ($diagnostics.mode.upstream -eq "antigravity-desktop") {
        $diagnosticMode = "antigravity"
    }

    if ($diagnosticMode -eq "third-party") {
        if (-not $diagnosticProtocol) { Add-Failure "third-party diagnostics missing protocol" }
        if (-not $diagnosticModel) { Add-Failure "third-party diagnostics missing model" }
    } elseif ($diagnosticMode -eq "antigravity") {
        if ($diagnostics.mode.upstream -ne "antigravity-desktop") { Add-Failure "diagnostics upstream is not antigravity-desktop" }
        $diagnosticModelTextTransport = if (Has-Property $diagnostics.health "modelTextTransport") { [string]$diagnostics.health.modelTextTransport } else { "" }
        $diagnosticModelDiscoverySource = if (Has-Property $diagnostics.health "modelDiscoverySource") { [string]$diagnostics.health.modelDiscoverySource } else { "" }
        $diagnosticAntigravityCoworkerDefault = if (Has-Property $diagnostics.health "antigravityCoworkerDefault") { [bool]$diagnostics.health.antigravityCoworkerDefault } else { $null }
        if ($diagnosticModelTextTransport -ne "desktop-cascade") { Add-Failure "diagnostics model text transport is not desktop-cascade" }
        if (-not $diagnosticModelDiscoverySource) { Add-Failure "diagnostics missing model discovery source" }
        if ($diagnosticModelDiscoverySource -and $AllowedAntigravityModelDiscoverySources -notcontains $diagnosticModelDiscoverySource) { Add-Failure "diagnostics model discovery source is not allowed" }
        if ($diagnosticAntigravityCoworkerDefault -ne $false) { Add-Failure "diagnostics antigravity coworker default is not false" }
        if ($diagnostics.health.accountReady -ne $true) { Add-Failure "diagnostics account is not ready" }
    } else {
        Add-Failure "diagnostics upstream mode is unknown"
    }
    if ([int]$diagnostics.models.count -lt 1) { Add-Failure "diagnostics has no models" }
    if (-not $diagnostics.models.ids -or @($diagnostics.models.ids).Count -lt 1) { Add-Failure "diagnostics model ids are empty" }
    if (-not (Has-Property $diagnostics "accountTracking")) {
        Add-Failure "diagnostics missing privacy-safe account tracking state"
    } elseif (-not (Has-Property $diagnostics.accountTracking "changePending") -or -not (Has-Property $diagnostics.accountTracking "requiredObservations")) {
        Add-Failure "diagnostics account tracking state is incomplete"
    } elseif (Has-Property $diagnostics.accountTracking "fingerprint") {
        Add-Failure "diagnostics account tracking state exposes an account fingerprint"
    }
    if ($diagnosticMode -eq "antigravity") {
        if (-not (Has-Property $diagnostics "antigravityCliIsolation")) {
            Add-Failure "diagnostics missing Antigravity CLI isolation state"
        } else {
            $cliIsolation = $diagnostics.antigravityCliIsolation
            foreach ($field in @("strictWindowsAppDataIsolation", "appDataIsolated", "localAppDataIsolated")) {
                if (-not (Has-Property $cliIsolation $field)) { Add-Failure "diagnostics Antigravity CLI isolation state missing $field" }
            }
            if ($cliIsolation.strictWindowsAppDataIsolation -eq $true) {
                if ($cliIsolation.appDataIsolated -ne $true) { Add-Failure "strict Antigravity CLI isolation missing APPDATA isolation" }
                if ($cliIsolation.localAppDataIsolated -ne $true) { Add-Failure "strict Antigravity CLI isolation missing LOCALAPPDATA isolation" }
                if (-not [string]$cliIsolation.appData) { Add-Failure "strict Antigravity CLI isolation missing APPDATA path" }
                if (-not [string]$cliIsolation.localAppData) { Add-Failure "strict Antigravity CLI isolation missing LOCALAPPDATA path" }
            }
            if ([string]$cliIsolation.profileRoot) {
                if (-not [string]$cliIsolation.geminiDir) { Add-Failure "Antigravity CLI isolation profileRoot missing Gemini dir" }
                if (-not [string]$cliIsolation.conversationsDir) { Add-Failure "Antigravity CLI isolation profileRoot missing conversations dir" }
            }
        }
    }
    if (-not $diagnostics.paths.codexHome) { Add-Failure "diagnostics missing Anti-Codex codexHome" }
    if (-not $diagnostics.paths.sharedCodexHome) { Add-Failure "diagnostics missing sharedCodexHome" }
    if ($diagnostics.paths.codexHome -eq $diagnostics.paths.sharedCodexHome) { Add-Failure "Anti-Codex codexHome should be isolated from sharedCodexHome" }
    if (-not (Has-Property $diagnostics.paths "modelRouteAudit")) { Add-Failure "diagnostics missing modelRouteAudit path" }
    if (-not (Has-Property $diagnostics "logDbGuard")) {
        Add-Failure "diagnostics missing log database guard status"
    } else {
        if ($diagnostics.logDbGuard.reportName -ne "log-db-guard") { Add-Failure "diagnostics log database guard reportName mismatch" }
        if ($diagnostics.logDbGuard.noTraffic -ne $true) { Add-Failure "diagnostics log database guard missing noTraffic" }
        if ($diagnostics.logDbGuard.usedRealTraffic -ne $false) { Add-Failure "diagnostics log database guard used real traffic" }
        if ($diagnostics.logDbGuard.protected -ne $true) { Add-Failure "diagnostics log database guard is not protected" }
        if ($diagnostics.logDbGuard.triggerPresent -ne $true) { Add-Failure "diagnostics log database guard trigger missing" }
    }
    if ($diagnosticMode -eq "third-party") {
        if ($diagnostics.toolBridge.mode -ne "provider-native-or-compat") { Add-Failure "third-party diagnostics tool bridge mode is not provider-native-or-compat" }
        if ($diagnostics.toolBridge.transport -ne "upstream-provider") { Add-Failure "third-party diagnostics tool bridge transport is not upstream-provider" }
        if ($diagnostics.toolBridge.nativeAntigravityToolEvents -ne $false) { Add-Failure "third-party diagnostics unexpectedly reports native Antigravity tool events" }
        if ($diagnostics.toolBridge.acceptsExternalToolDefinitions -ne $true) { Add-Failure "third-party diagnostics should accept external tool definitions" }
    } else {
        $nativeBridgeEnabled = $diagnostics.toolBridge.nativeBridgeDefaultEnabled -eq $true
        if ($nativeBridgeEnabled) {
            if ($diagnostics.toolBridge.mode -ne "native-mcp-same-cascade") { Add-Failure "diagnostics tool bridge mode is not native-mcp-same-cascade while native bridge is enabled" }
            if ($diagnostics.toolBridge.nativeAntigravityToolEvents -ne $true) { Add-Failure "diagnostics should confirm native Antigravity tool events while native bridge is enabled" }
            if ($diagnostics.toolBridge.acceptsExternalToolDefinitions -ne $true) { Add-Failure "diagnostics should confirm native external tool definitions while native bridge is enabled" }
            if ($diagnostics.toolBridge.verifier -ne "test-anticodex-native-tool-loop.ps1") { Add-Failure "diagnostics missing native tool loop verifier name" }
        } else {
            if ($diagnostics.toolBridge.mode -ne "codex-owned-tools-model-only") { Add-Failure "diagnostics tool bridge mode is not codex-owned-tools-model-only by default" }
            if ($diagnostics.toolBridge.nativeAntigravityToolEvents -ne $false) { Add-Failure "diagnostics should not report native Antigravity tool events by default" }
            if ($diagnostics.toolBridge.acceptsExternalToolDefinitions -ne $false) { Add-Failure "diagnostics should not expose native external tool definitions by default" }
            if ($diagnostics.toolBridge.verifier -ne "test-anticodex-tool-loop.ps1") { Add-Failure "diagnostics missing Codex-owned tool loop verifier name" }
        }
        if ($diagnostics.toolBridge.transport -notin @("cli", "native", "desktop-cascade")) { Add-Failure "diagnostics tool bridge transport is not a known model transport" }
        if ($diagnostics.toolBridge.nativeVerifier -ne "test-anticodex-native-tool-loop.ps1") { Add-Failure "diagnostics missing native tool loop verifier name" }
    }
    if (-not (Has-Property $diagnostics "localFeatures")) {
        Add-Failure "diagnostics missing local Skill/MCP feature summary"
    } else {
        $localFeatures = $diagnostics.localFeatures
        if (-not (Has-Property $localFeatures "skills")) {
            Add-Failure "diagnostics localFeatures missing skills section"
        } else {
            if (-not (Has-Property $localFeatures.skills "count")) { Add-Failure "diagnostics localFeatures.skills missing count" }
            if ([int]$localFeatures.skills.count -lt 1) { Add-Failure "diagnostics localFeatures.skills count is empty" }
            if (-not (Has-Property $localFeatures.skills "requiredPresent")) { Add-Failure "diagnostics localFeatures.skills missing inherited skill list" }
            if (-not (Has-Property $localFeatures.skills "sample")) { Add-Failure "diagnostics localFeatures.skills missing sample" }
            $requiredSkills = @("headroom", "context-save", "context-restore", "keep-codex-fast")
            foreach ($requiredSkill in $requiredSkills) {
                if ($localFeatures.skills.requiredPresent -notcontains $requiredSkill) {
                    Add-Failure "diagnostics localFeatures.skills missing required skill: $requiredSkill"
                }
            }
        }
        if (-not (Has-Property $localFeatures "mcp")) {
            Add-Failure "diagnostics localFeatures missing MCP section"
        } else {
            if (-not (Has-Property $localFeatures.mcp "count")) { Add-Failure "diagnostics localFeatures.mcp missing count" }
            if ([int]$localFeatures.mcp.count -lt 1) { Add-Failure "diagnostics localFeatures.mcp count is empty" }
            if (-not (Has-Property $localFeatures.mcp "names")) { Add-Failure "diagnostics localFeatures.mcp missing names" }
            if (-not (Has-Property $localFeatures.mcp "configPath")) { Add-Failure "diagnostics localFeatures.mcp missing configPath" }
            if ($localFeatures.mcp.names -notcontains "node_repl") { Add-Failure "diagnostics localFeatures.mcp missing node_repl MCP server" }
        }
        if (-not (Has-Property $localFeatures "snapshots")) {
            Add-Failure "diagnostics localFeatures missing snapshot counts"
        } else {
            if (-not (Has-Property $localFeatures.snapshots "connectorDirectoryFiles")) { Add-Failure "diagnostics localFeatures missing connector snapshot count" }
            if (-not (Has-Property $localFeatures.snapshots "appToolsCacheFiles")) { Add-Failure "diagnostics localFeatures missing app-tools snapshot count" }
        }
        if (-not (Has-Property $localFeatures "connectorVerifier")) {
            Add-Failure "diagnostics localFeatures missing connector verifier summary"
        } else {
            $connectorVerifier = $localFeatures.connectorVerifier
            if (-not (Has-Property $connectorVerifier "noFakeAuthorization")) { Add-Failure "diagnostics connector verifier missing no-fake authorization proof" }
            if (-not (Has-Property $connectorVerifier "getPostParityClean")) { Add-Failure "diagnostics connector verifier missing GET/POST parity proof" }
            if (-not (Has-Property $connectorVerifier "connectorParityClean")) { Add-Failure "diagnostics connector verifier missing connector parity proof" }
            if (-not (Has-Property $connectorVerifier "appToolParityClean")) { Add-Failure "diagnostics connector verifier missing app-tool parity proof" }
        }
        if (-not (Has-Property $localFeatures "snapshotStatus")) {
            Add-Failure "diagnostics localFeatures missing snapshot freshness status"
        } else {
            if (-not (Has-Property $localFeatures.snapshotStatus "state")) { Add-Failure "diagnostics snapshotStatus missing state" }
            if (-not (Has-Property $localFeatures.snapshotStatus "stale")) { Add-Failure "diagnostics snapshotStatus missing stale flag" }
            if (-not (Has-Property $localFeatures.snapshotStatus "sourceFingerprintComparable")) { Add-Failure "diagnostics snapshotStatus missing sourceFingerprintComparable" }
            if (-not (Has-Property $localFeatures.snapshotStatus "sourceFingerprintMatches")) { Add-Failure "diagnostics snapshotStatus missing sourceFingerprintMatches" }
            if (-not (Has-Property $localFeatures.snapshotStatus "staleReason")) { Add-Failure "diagnostics snapshotStatus missing staleReason" }
        }
        if (-not (Has-Property $localFeatures "capabilityTiers") -or -not (Has-Property $localFeatures.capabilityTiers "connectors")) {
            Add-Failure "diagnostics localFeatures missing connector capability tier"
        } else {
            $connectorTier = $localFeatures.capabilityTiers.connectors
            if (-not (Has-Property $connectorTier "authorizedCount")) { Add-Failure "diagnostics connector tier missing authorizedCount" }
            if (-not (Has-Property $connectorTier "remoteAuthorizedCount")) { Add-Failure "diagnostics connector tier missing remoteAuthorizedCount" }
            if (-not (Has-Property $connectorTier "localAllowlistedCount")) { Add-Failure "diagnostics connector tier missing localAllowlistedCount" }
            if (-not (Has-Property $connectorTier "callableToolCount")) { Add-Failure "diagnostics connector tier missing callableToolCount" }
            if (-not (Has-Property $connectorTier "mode")) {
                Add-Failure "diagnostics connector tier missing mode"
            } elseif (@("metadata-only", "real-authorized") -notcontains [string]$connectorTier.mode) {
                Add-Failure "diagnostics connector tier mode is not explicit"
            }
        }
    }
    if (-not (Has-Property $diagnostics "antigravityRetries")) {
        Add-Failure "diagnostics missing Antigravity retry audit"
    } elseif (-not (Has-Property $diagnostics.antigravityRetries "count")) {
        Add-Failure "diagnostics Antigravity retry audit missing count"
    }
    if (-not (Has-Property $diagnostics "antigravityQueue")) {
        Add-Failure "diagnostics missing Antigravity request queue"
    } elseif (-not (Has-Property $diagnostics.antigravityQueue "queued") -or -not (Has-Property $diagnostics.antigravityQueue "maxQueued")) {
        Add-Failure "diagnostics Antigravity request queue is missing queue limits"
    } elseif ([int]$diagnostics.antigravityQueue.queued -gt [int]$diagnostics.antigravityQueue.maxQueued) {
        Add-Failure "diagnostics Antigravity request queue exceeds its configured limit"
    }
    if (-not (Has-Property $diagnostics "antigravitySessionLock")) {
        Add-Failure "diagnostics missing Antigravity session lock"
    } elseif (-not (Has-Property $diagnostics.antigravitySessionLock "queued") -or -not (Has-Property $diagnostics.antigravitySessionLock "maxQueued")) {
        Add-Failure "diagnostics Antigravity session lock is missing queue limits"
    } elseif ([int]$diagnostics.antigravitySessionLock.queued -gt [int]$diagnostics.antigravitySessionLock.maxQueued) {
        Add-Failure "diagnostics Antigravity session lock exceeds its configured limit"
    }
    if (-not (Has-Property $diagnostics "activeAntigravityRequests")) {
        Add-Failure "diagnostics missing active Antigravity request count"
    } elseif (-not (Has-Property $diagnostics.activeAntigravityRequests "active")) {
        Add-Failure "diagnostics active Antigravity request count is incomplete"
    }
    if (-not (Has-Property $diagnostics "updateStatus")) {
        Add-Failure "diagnostics missing Codex update status"
    } elseif (-not (Has-Property $diagnostics.updateStatus "updateNeeded")) {
        Add-Failure "diagnostics Codex update status missing updateNeeded"
    } else {
        if (-not (Has-Property $diagnostics.updateStatus "reason")) { Add-Failure "diagnostics Codex update status reason missing" }
        if (-not (Has-Property $diagnostics.updateStatus "source")) { Add-Failure "diagnostics Codex update status source missing" }
        if (-not (Has-Property $diagnostics.updateStatus "active")) { Add-Failure "diagnostics Codex update status active host missing" }
    }
    if (-not (Has-Property $diagnostics "postVerification")) {
        Add-Failure "diagnostics missing post-verification status"
    } else {
        $postVerification = $diagnostics.postVerification
        if (-not (Has-Property $postVerification "state")) { Add-Failure "diagnostics post-verification missing state" }
        if (-not (Has-Property $postVerification "usedRealTraffic")) { Add-Failure "diagnostics post-verification missing usedRealTraffic" }
        if (-not (Has-Property $postVerification "latestDiagnosis")) { Add-Failure "diagnostics post-verification missing latestDiagnosis" }
        if (-not (Has-Property $postVerification "latestDiagnosisDetail")) { Add-Failure "diagnostics post-verification missing latestDiagnosisDetail" }
        if (-not (Has-Property $postVerification "attempts")) { Add-Failure "diagnostics post-verification missing attempts" }
        if (-not (Has-Property $postVerification "failureCount")) { Add-Failure "diagnostics post-verification missing failureCount" }
    }
    if (-not (Has-Property $diagnostics "longTasks")) {
        Add-Failure "diagnostics missing long-task status"
    } else {
        $longTaskItems = @($diagnostics.longTasks.items)
        foreach ($expectedTask in @("syncHost", "postVerificationFull")) {
            $task = @($longTaskItems | Where-Object { $_.id -eq $expectedTask } | Select-Object -First 1)[0]
            if (-not $task) {
                Add-Failure "diagnostics long-task status missing $expectedTask"
            } else {
                if (-not (Has-Property $task "latestLogLine")) { Add-Failure "diagnostics long-task $expectedTask missing latestLogLine" }
                if (-not (Has-Property $task "logUpdatedAt")) { Add-Failure "diagnostics long-task $expectedTask missing logUpdatedAt" }
                if (-not (Has-Property $task "logAgeMs")) { Add-Failure "diagnostics long-task $expectedTask missing logAgeMs" }
            }
        }
    }
    if (-not (Has-Property $diagnostics "shortcutRepair")) {
        Add-Failure "diagnostics missing shortcut repair status"
    } else {
        $shortcutRepair = $diagnostics.shortcutRepair
        if (-not (Has-Property $shortcutRepair "present")) { Add-Failure "diagnostics shortcut repair missing present" }
        if (-not (Has-Property $shortcutRepair "ok")) { Add-Failure "diagnostics shortcut repair missing ok" }
        if (-not (Has-Property $shortcutRepair "repairedCount")) { Add-Failure "diagnostics shortcut repair missing repairedCount" }
        if (-not (Has-Property $shortcutRepair "reportName")) { Add-Failure "diagnostics shortcut repair missing reportName" }
    }
    if (-not (Has-Property $diagnostics "sourcePreflight")) {
        Add-Failure "diagnostics missing source preflight status"
    } else {
        $sourcePreflight = $diagnostics.sourcePreflight
        if (-not (Has-Property $sourcePreflight "present")) { Add-Failure "diagnostics source preflight missing present" }
        if (-not (Has-Property $sourcePreflight "ok")) { Add-Failure "diagnostics source preflight missing ok" }
        if (-not (Has-Property $sourcePreflight "reportName")) { Add-Failure "diagnostics source preflight missing reportName" }
        if (-not (Has-Property $sourcePreflight "javascriptSyntaxOk")) { Add-Failure "diagnostics source preflight missing JavaScript syntax result" }
        if (-not (Has-Property $sourcePreflight "powershellSyntaxOk")) { Add-Failure "diagnostics source preflight missing PowerShell syntax result" }
        if (-not (Has-Property $sourcePreflight "uiStateSelfTestOk")) { Add-Failure "diagnostics source preflight missing UI state self-test result" }
        if (-not (Has-Property $sourcePreflight "upstreamProfileStorageOk")) { Add-Failure "diagnostics source preflight missing upstream profile storage result" }
        if (-not (Has-Property $sourcePreflight "antigravityCliIsolationProfileOk")) { Add-Failure "diagnostics source preflight missing Antigravity CLI isolation profile result" }
        if (-not (Has-Property $sourcePreflight "antigravityCliIsolationProfileContract")) {
            Add-Failure "diagnostics source preflight missing Antigravity CLI isolation profile contract"
        } elseif ($sourcePreflight.antigravityCliIsolationProfileContract) {
            $isolationContract = $sourcePreflight.antigravityCliIsolationProfileContract
            if ($isolationContract.usedRealTraffic -ne $false) { Add-Failure "diagnostics source preflight isolation profile used real traffic" }
            if ($isolationContract.loginVerified -ne $false) { Add-Failure "diagnostics source preflight isolation profile claims login verified" }
            if ($isolationContract.separateAccountVerified -ne $false) { Add-Failure "diagnostics source preflight isolation profile claims separate account verified" }
            if ($isolationContract.accountLaneRole -ne "anticodex-model-text") { Add-Failure "diagnostics source preflight isolation profile account lane role mismatch" }
            if ($isolationContract.mcpAccountLaneManagedByAntiCodex -ne $false) { Add-Failure "diagnostics source preflight isolation profile claims MCP account lane is managed by Anti-Codex" }
            if ($isolationContract.mcpAccountLaneOwner -ne "external-antigravity-account-not-managed-here") { Add-Failure "diagnostics source preflight isolation profile MCP account lane owner mismatch" }
            if (-not [string]$isolationContract.accountIsolationBoundary) { Add-Failure "diagnostics source preflight isolation profile missing isolation boundary" }
            if (-not [string]$isolationContract.accountIsolationCaveat) { Add-Failure "diagnostics source preflight isolation profile missing isolation caveat" }
        }
        if (-not (Has-Property $sourcePreflight "localConnectorVerifierOk")) { Add-Failure "diagnostics source preflight missing local connector verifier result" }
        if (-not (Has-Property $sourcePreflight "managerMojibakeContractsOk")) { Add-Failure "diagnostics source preflight missing Manager mojibake contract result" }
        if (-not (Has-Property $sourcePreflight "publicDocumentationOk")) { Add-Failure "diagnostics source preflight missing public documentation result" }
        if (-not (Has-Property $sourcePreflight "publicDocumentationClientCopySyncContractOk")) { Add-Failure "diagnostics source preflight missing client-copy public documentation contract result" }
        if (-not (Has-Property $sourcePreflight "translatorRegressionOk")) { Add-Failure "diagnostics source preflight missing translator regression result" }
        if (-not (Has-Property $sourcePreflight "diffWhitespaceOk")) { Add-Failure "diagnostics source preflight missing diff whitespace result" }
        if (-not (Has-Property $sourcePreflight "antigravityCliProfilePrepareOk")) { Add-Failure "diagnostics source preflight missing Antigravity CLI profile prepare result" }
        if (-not (Has-Property $sourcePreflight "antigravityCliProfilePrepareRejectsDefaultChildOk")) {
            Add-Failure "diagnostics source preflight missing Antigravity CLI profile prepare default-child rejection result"
        } elseif ($sourcePreflight.antigravityCliProfilePrepareRejectsDefaultChildOk -ne $true) {
            Add-Failure "diagnostics source preflight Antigravity CLI profile prepare default-child rejection is not green"
        }
        if (-not (Has-Property $sourcePreflight "antigravityCliWindowsUserLoginDryRunOk")) {
            Add-Failure "diagnostics source preflight missing Antigravity CLI Windows-user login dry-run result"
        } elseif ($sourcePreflight.antigravityCliWindowsUserLoginDryRunOk -ne $true) {
            Add-Failure "diagnostics source preflight Antigravity CLI Windows-user login dry-run is not green"
        }
        if (-not (Has-Property $sourcePreflight "antigravityCliProfilePrepareContract")) {
            Add-Failure "diagnostics source preflight missing Antigravity CLI profile prepare contract"
        } elseif ($sourcePreflight.antigravityCliProfilePrepareContract) {
            $profilePrepareContract = $sourcePreflight.antigravityCliProfilePrepareContract
            if ($profilePrepareContract.usedRealTraffic -ne $false) { Add-Failure "diagnostics source preflight profile prepare used real traffic" }
            if ($profilePrepareContract.loginVerified -ne $false) { Add-Failure "diagnostics source preflight profile prepare claims login verified" }
            if ($profilePrepareContract.separateAccountVerified -ne $false) { Add-Failure "diagnostics source preflight profile prepare claims separate account verified" }
            if ($profilePrepareContract.accountLaneRole -ne "anticodex-model-text") { Add-Failure "diagnostics source preflight profile prepare account lane role mismatch" }
            if ($profilePrepareContract.mcpAccountLaneManagedByAntiCodex -ne $false) { Add-Failure "diagnostics source preflight profile prepare claims MCP account lane is managed by Anti-Codex" }
            if ($profilePrepareContract.mcpAccountLaneOwner -ne "external-antigravity-account-not-managed-here") { Add-Failure "diagnostics source preflight profile prepare MCP account lane owner mismatch" }
            if ($profilePrepareContract.coverageKind -ne "profile-prepared-no-traffic") { Add-Failure "diagnostics source preflight profile prepare coverage kind mismatch" }
            if (-not [string]$profilePrepareContract.accountIsolationBoundary) { Add-Failure "diagnostics source preflight profile prepare missing isolation boundary" }
            if (-not [string]$profilePrepareContract.accountIsolationCaveat) { Add-Failure "diagnostics source preflight profile prepare missing isolation caveat" }
        }
        if (-not (Has-Property $sourcePreflight "antigravityCliWindowsUserLoginDryRunContract")) {
            Add-Failure "diagnostics source preflight missing Antigravity CLI Windows-user login dry-run contract"
        } elseif ($sourcePreflight.antigravityCliWindowsUserLoginDryRunContract) {
            $windowsUserLoginContract = $sourcePreflight.antigravityCliWindowsUserLoginDryRunContract
            if ($windowsUserLoginContract.noTraffic -ne $true) { Add-Failure "diagnostics source preflight Windows-user login dry-run not marked no-traffic" }
            if ($windowsUserLoginContract.usedRealTraffic -ne $false) { Add-Failure "diagnostics source preflight Windows-user login dry-run used real traffic" }
            if ($windowsUserLoginContract.started -ne $false) { Add-Failure "diagnostics source preflight Windows-user login dry-run started a process" }
            if ($windowsUserLoginContract.capturesLoginOutput -ne $false) { Add-Failure "diagnostics source preflight Windows-user login dry-run captures login output" }
            if ($windowsUserLoginContract.readinessChecked -ne $true) { Add-Failure "diagnostics source preflight Windows-user login dry-run missing readiness check" }
            if (-not [string]$windowsUserLoginContract.normalizedTargetWindowsUser) { Add-Failure "diagnostics source preflight Windows-user login dry-run missing normalized target user" }
            if (-not [string]$windowsUserLoginContract.currentWindowsUser) { Add-Failure "diagnostics source preflight Windows-user login dry-run missing current user" }
            if ($windowsUserLoginContract.targetUserIsCurrentUser -eq $true) { Add-Failure "diagnostics source preflight Windows-user login dry-run targets current user" }
            if ($windowsUserLoginContract.readyForInteractiveLogin -ne $true -and -not [string]$windowsUserLoginContract.readinessBlockingReason) { Add-Failure "diagnostics source preflight Windows-user login dry-run missing readiness blocking reason" }
            if ($windowsUserLoginContract.credentialBoundary -ne "separate-windows-user") { Add-Failure "diagnostics source preflight Windows-user login dry-run credential boundary mismatch" }
            if ($windowsUserLoginContract.expectedCredentialStoreIsolation -ne $true) { Add-Failure "diagnostics source preflight Windows-user login dry-run missing expected credential-store isolation" }
            if (-not [string]$windowsUserLoginContract.runasWorkingDirectory) { Add-Failure "diagnostics source preflight Windows-user login dry-run missing runas working directory" }
            if ($windowsUserLoginContract.bootstrapKeepsShellOpen -ne $false) { Add-Failure "diagnostics source preflight Windows-user login dry-run keeps bootstrap shell open" }
            if (-not [string]$windowsUserLoginContract.accountIsolationCaveat) { Add-Failure "diagnostics source preflight Windows-user login dry-run missing caveat" }
        }
        if (-not (Has-Property $sourcePreflight "skipFullRegression")) { Add-Failure "diagnostics source preflight missing skipFullRegression" }
    }
    Test-WindowsUserSetupGuidanceOperatorSetupPlan $diagnostics.windowsUserSetupGuidanceEvidence "diagnostics windows-user setup guidance"
    Test-WindowsUserSettingsEntrypointEvidence $diagnostics.windowsUserSettingsEntrypointEvidence "diagnostics windows-user settings entrypoint"

    if (-not (Has-Property $diagnostics "lifecycle")) {
        Add-Failure "diagnostics missing translator lifecycle status"
    } else {
        $lifecycle = $diagnostics.lifecycle
        if (-not (Has-Property $lifecycle "type")) { Add-Failure "diagnostics lifecycle missing type" }
        if (-not (Has-Property $lifecycle "at")) { Add-Failure "diagnostics lifecycle missing timestamp" }
        if (-not (Has-Property $lifecycle "pid")) { Add-Failure "diagnostics lifecycle missing pid" }
        if (-not (Has-Property $lifecycle "port")) { Add-Failure "diagnostics lifecycle missing port" }
        if (-not (Has-Property $lifecycle "message")) { Add-Failure "diagnostics lifecycle missing message" }
    }

    if (-not (Has-Property $diagnostics "tools")) {
        Add-Failure "diagnostics missing tools section"
    } else {
        $tools = $diagnostics.tools
        if (-not (Has-Property $tools "bridge")) {
            Add-Failure "diagnostics.tools missing bridge field"
        } else {
            $bridge = [string]$tools.bridge
            $expectedBridge = if ($diagnosticMode -eq "third-party") { "provider_native_or_compat" } elseif ($diagnostics.toolBridge.nativeBridgeDefaultEnabled -eq $true) { "native_mcp_same_cascade" } else { "codex_owned_model_only_tool_bridge" }
            if ($bridge -ne $expectedBridge) {
                Add-Failure "diagnostics.tools.bridge is '$bridge', expected '$expectedBridge'"
            }
        }
        if (-not (Has-Property $tools "description")) {
            Add-Failure "diagnostics.tools missing description field"
        } elseif ($diagnosticMode -eq "antigravity" -and $diagnostics.toolBridge.nativeBridgeDefaultEnabled -eq $true -and ([string]$tools.description) -notmatch "automatically approved") {
            Add-Failure "diagnostics.tools.description missing automatic native permission handling"
        } elseif ($diagnosticMode -eq "antigravity" -and $diagnostics.toolBridge.nativeBridgeDefaultEnabled -ne $true -and ([string]$tools.description) -notmatch "model text only") {
            Add-Failure "diagnostics.tools.description missing model-only tool boundary"
        }
        if (-not (Has-Property $tools "antigravityMode")) {
            Add-Failure "diagnostics.tools missing antigravityMode field"
        } elseif ($diagnosticMode -eq "antigravity" -and $tools.antigravityMode -ne $true) {
            Add-Failure "diagnostics.tools.antigravityMode is not true in Antigravity mode"
        } elseif ($diagnosticMode -eq "third-party" -and $tools.antigravityMode -ne $false) {
            Add-Failure "diagnostics.tools.antigravityMode is not false in third-party mode"
        }
        $nativeBridgeEnabled = $diagnostics.toolBridge.nativeBridgeDefaultEnabled -eq $true
        if ($diagnosticMode -eq "antigravity" -and $nativeBridgeEnabled -and $tools.nativeAntigravityToolEvents -ne $true) {
            Add-Failure "diagnostics.tools should confirm native Antigravity tool events while native bridge is enabled"
        } elseif ($diagnosticMode -eq "antigravity" -and -not $nativeBridgeEnabled -and $tools.nativeAntigravityToolEvents -ne $false) {
            Add-Failure "diagnostics.tools should not report native Antigravity tool events by default"
        } elseif ($diagnosticMode -eq "third-party" -and $tools.nativeAntigravityToolEvents -ne $false) {
            Add-Failure "diagnostics.tools unexpectedly reports native Antigravity tool events in third-party mode"
        }
        if ($diagnosticMode -eq "antigravity" -and $nativeBridgeEnabled -and $tools.acceptsExternalToolDefinitions -ne $true) {
            Add-Failure "diagnostics.tools should confirm external tool definitions"
        } elseif ($diagnosticMode -eq "antigravity" -and -not $nativeBridgeEnabled -and $tools.acceptsExternalToolDefinitions -ne $false) {
            Add-Failure "diagnostics.tools should not expose native external tool definitions by default"
        } elseif ($diagnosticMode -eq "third-party" -and $tools.acceptsExternalToolDefinitions -ne $true) {
            Add-Failure "diagnostics.tools should confirm external tool definitions"
        }
    }

    $serialized = $diagnostics | ConvertTo-Json -Depth 20 -Compress
    if ($serialized -match "(?i)tool output|messages|input_items|Return exactly this") {
        Add-Failure "diagnostics appears to expose prompt/tool transcript fields"
    }
}

$bundleCheck = $null
if ($VerifyBundle -and -not $VerifyReportsSummary) {
    try {
        $bundleCheck = Test-DiagnosticBundle
    } catch {
        Add-Failure "diagnostic bundle verification failed: $($_.Exception.Message)"
    }
}

$result = [pscustomobject]@{
    reportName = "diagnostics"
    noTraffic = $true
    usedRealTraffic = $false
    behaviorCovered = $true
    coverageKind = "diagnostics-no-traffic"
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    reportsSummary = $reportsSummaryCheck
    diagnostics = if ($diagnostics) {
        [pscustomobject]@{
            object = $diagnostics.object
            upstream = $diagnostics.mode.upstream
            mode = $diagnosticMode
            protocol = $diagnosticProtocol
            model = $diagnosticModel
            accountReady = $diagnostics.health.accountReady
            accountState = $diagnostics.health.accountState
            circuitState = $diagnostics.health.antigravityCircuitState
            modelCount = $diagnostics.models.count
            postVerification = $diagnostics.postVerification
            shortcutRepair = $diagnostics.shortcutRepair
            sourcePreflight = $diagnostics.sourcePreflight
            accountTracking = $diagnostics.accountTracking
            latestRoute = $diagnostics.modelRoutes.latest
            toolBridge = $diagnostics.toolBridge
            localFeatures = $diagnostics.localFeatures
            antigravityRetries = $diagnostics.antigravityRetries
            antigravityQueue = $diagnostics.antigravityQueue
            antigravitySessionLock = $diagnostics.antigravitySessionLock
            activeAntigravityRequests = $diagnostics.activeAntigravityRequests
            updateStatus = $diagnostics.updateStatus
            lifecycle = $diagnostics.lifecycle
            logDbGuard = $diagnostics.logDbGuard
            stateRoot = $diagnostics.paths.stateRoot
            codexHome = $diagnostics.paths.codexHome
            sharedCodexHome = $diagnostics.paths.sharedCodexHome
        }
    } else { $null }
    bundle = $bundleCheck
}

if (-not $VerifyReportsSummary) {
    $reportStamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $reportPaths = [pscustomobject]@{
        latest = (Join-Path $ReportRoot "latest-diagnostics.json")
        history = (Join-Path $ReportRoot "$reportStamp-diagnostics.json")
    }
    $result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
}

$json = $result | ConvertTo-Json -Depth 10 -Compress
if (-not $VerifyReportsSummary) {
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $result.report.latest -HistoryPath $result.report.history -Json $json -Encoding ([System.Text.UTF8Encoding]::new($false))
}
$json
if ($failures.Count -gt 0) { exit 1 }
