#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WindowsUser = ".\AntiCodexModel",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [switch]$Compact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
. (Join-Path $scriptRoot "anticodex-report-io.ps1")
. (Join-Path $scriptRoot "anticodex-powershell-json-invoke.ps1")

$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Invoke-JsonProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $output = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String).Trim()
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
        ok = ($exitCode -eq 0 -and $null -ne $parsed -and $parseError -eq "")
        exitCode = $exitCode
        parsed = $parsed
        parseError = $parseError
        stdoutTail = if ($text.Length -gt 800) { $text.Substring($text.Length - 800) } else { $text }
    }
}

function Invoke-PowerShellJson {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName,
        [string[]]$Arguments = @()
    )

    $scriptPath = Join-Path $scriptRoot $ScriptName
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return [ordered]@{
            ok = $false
            exitCode = 127
            parsed = $null
            parseError = "missing script: $ScriptName"
            stdoutTail = ""
        }
    }
    return Invoke-AntiCodexPowerShellJsonScript -ScriptPath $scriptPath -Arguments $Arguments
}

function Invoke-NodeJson {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName,
        [string[]]$Arguments = @()
    )

    $scriptPath = Join-Path $scriptRoot $ScriptName
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return [ordered]@{
            ok = $false
            exitCode = 127
            parsed = $null
            parseError = "missing script: $ScriptName"
            stdoutTail = ""
        }
    }
    return Invoke-JsonProcess -FilePath "node" -Arguments (@($scriptPath) + $Arguments)
}

function New-StepEvidence {
    param(
        [string]$Id,
        $Result
    )

    return [ordered]@{
        id = $Id
        ok = [bool]$Result.ok
        exitCode = [int]$Result.exitCode
        reportName = if ($Result.parsed) { [string]$Result.parsed.reportName } else { "" }
        parseError = [string]$Result.parseError
        report = if ($Result.parsed -and ($Result.parsed.PSObject.Properties.Name -contains "report")) { $Result.parsed.report } else { $null }
    }
}

function Test-ReportCollected {
    param(
        $Result,
        [string]$ReportName
    )

    return ($null -ne $Result `
        -and $null -ne $Result.parsed `
        -and [string]$Result.parseError -eq "" `
        -and [string]$Result.parsed.reportName -eq $ReportName `
        -and $Result.parsed.requestedRealTraffic -eq $false `
        -and $Result.parsed.usedRealTraffic -eq $false `
        -and $Result.parsed.behaviorCovered -eq $true)
}

$prepareResult = Invoke-PowerShellJson -ScriptName "test-anticodex-windows-user-account-prepare.ps1" -Arguments @("-WindowsUser", $WindowsUser, "-ReportRoot", $ReportRoot)
$setupGuidanceResult = Invoke-PowerShellJson -ScriptName "test-anticodex-windows-user-setup-guidance.ps1" -Arguments @("-WindowsUser", $WindowsUser, "-ReportRoot", $ReportRoot)
$statusResult = Invoke-PowerShellJson -ScriptName "test-anticodex-antigravity-account-isolation-status.ps1" -Arguments @("-WindowsUser", $WindowsUser, "-ReportRoot", $ReportRoot)
$entrypointResult = Invoke-PowerShellJson -ScriptName "test-anticodex-second-account-login-entrypoint.ps1" -Arguments @("-ReportRoot", $ReportRoot)
$sequenceResult = Invoke-NodeJson -ScriptName "test-anticodex-approved-real-run-sequence.mjs" -Arguments @("--report-root", $ReportRoot)
$goalResult = Invoke-NodeJson -ScriptName "test-anticodex-goal-readiness.mjs" -Arguments @("--report-root", $ReportRoot)
$releaseResult = Invoke-NodeJson -ScriptName "test-anticodex-release-gates.mjs" -Arguments @("--compact-status", "--report-root", $ReportRoot)

if (Test-ReportCollected -Result $goalResult -ReportName "goal-readiness") {
    $goalResult.ok = $true
}

$prepare = $prepareResult.parsed
$setupGuidance = $setupGuidanceResult.parsed
$status = $statusResult.parsed
$entrypoint = $entrypointResult.parsed
$sequence = $sequenceResult.parsed
$goal = $goalResult.parsed
$release = $releaseResult.parsed
$releaseGateCompactStatusCommand = "node scripts\test-anticodex-release-gates.mjs --compact-status"
$operatorChecklistStages = if ($setupGuidance -and ($setupGuidance.PSObject.Properties.Name -contains "operatorChecklist") -and $setupGuidance.operatorChecklist) {
    @($setupGuidance.operatorChecklist | ForEach-Object { [string]$_.stage } | Where-Object { $_ })
} else {
    @()
}
$operatorChecklistStartsLoginCount = if ($setupGuidance -and ($setupGuidance.PSObject.Properties.Name -contains "operatorChecklist") -and $setupGuidance.operatorChecklist) {
    @($setupGuidance.operatorChecklist | Where-Object { $_.startsLogin -eq $true }).Count
} else {
    0
}
$operatorChecklistUsesRealTrafficCount = if ($setupGuidance -and ($setupGuidance.PSObject.Properties.Name -contains "operatorChecklist") -and $setupGuidance.operatorChecklist) {
    @($setupGuidance.operatorChecklist | Where-Object { $_.usesRealTraffic -eq $true }).Count
} else {
    0
}
$postManualSetupValidationCommands = if ($setupGuidance -and ($setupGuidance.PSObject.Properties.Name -contains "postManualSetupValidationCommands")) {
    @($setupGuidance.postManualSetupValidationCommands | ForEach-Object { [string]$_ } | Where-Object { $_ })
} else {
    @()
}
$postManualSetupRequiredReadyFields = if ($setupGuidance -and ($setupGuidance.PSObject.Properties.Name -contains "postManualSetupRequiredReadyFields")) {
    @($setupGuidance.postManualSetupRequiredReadyFields | ForEach-Object { [string]$_ } | Where-Object { $_ })
} else {
    @()
}

foreach ($step in @(
    @{ id = "windowsUserAccountPrepare"; result = $prepareResult },
    @{ id = "windowsUserSetupGuidance"; result = $setupGuidanceResult },
    @{ id = "accountIsolationStatus"; result = $statusResult },
    @{ id = "secondAccountLoginEntrypoint"; result = $entrypointResult },
    @{ id = "approvedRealRunSequence"; result = $sequenceResult },
    @{ id = "goalReadiness"; result = $goalResult },
    @{ id = "releaseGates"; result = $releaseResult }
)) {
    if (-not $step.result.ok) { Add-Failure ("{0}_failed" -f $step.id) }
}

$targetUserExists = ($status -and $status.targetUserExists -eq $true) -or ($prepare -and $prepare.targetUserExists -eq $true)
$currentWindowsUserSid = if ($status -and ($status.PSObject.Properties.Name -contains "currentWindowsUserSid")) { [string]$status.currentWindowsUserSid } elseif ($prepare -and ($prepare.PSObject.Properties.Name -contains "currentWindowsUserSid")) { [string]$prepare.currentWindowsUserSid } else { "" }
$targetWindowsUserSid = if ($status -and ($status.PSObject.Properties.Name -contains "targetWindowsUserSid")) { [string]$status.targetWindowsUserSid } elseif ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetWindowsUserSid")) { [string]$prepare.targetWindowsUserSid } else { "" }
$targetUserSidMatchesCurrentUser = if ($status -and ($status.PSObject.Properties.Name -contains "targetUserSidMatchesCurrentUser")) { [bool]$status.targetUserSidMatchesCurrentUser } elseif ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetUserSidMatchesCurrentUser")) { [bool]$prepare.targetUserSidMatchesCurrentUser } else { $false }
$targetUserIdentityBoundaryOk = if ($status -and ($status.PSObject.Properties.Name -contains "targetUserIdentityBoundaryOk")) { [bool]$status.targetUserIdentityBoundaryOk } elseif ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetUserIdentityBoundaryOk")) { [bool]$prepare.targetUserIdentityBoundaryOk } else { $false }
$targetUserIsCurrentUser = if ($status -and ($status.PSObject.Properties.Name -contains "targetUserIsCurrentUser")) { [bool]$status.targetUserIsCurrentUser } elseif ($prepare -and ($prepare.PSObject.Properties.Name -contains "targetUserIsCurrentUser")) { [bool]$prepare.targetUserIsCurrentUser } else { $false }
$readyForOperatorLogin = ($status -and $status.safeToAskUserForSecondAccountLogin -eq $true -and $status.canProceedToInteractiveLogin -eq $true -and $entrypoint -and $entrypoint.safeToStartLogin -eq $true)
$releaseAcceptableAccountProof = ($status -and $status.releaseAcceptableAccountProof -eq $true)
$goalComplete = ($goal -and $goal.goalComplete -eq $true)
$releaseReady = ($release -and $release.releaseReady -eq $true)
$readyToRequestSecondAccountLoginApproval = ($sequence -and $sequence.readyToRequestSecondAccountLoginApproval -eq $true)
$readyToRequestPostLoginProofApproval = ($sequence -and $sequence.readyToRequestPostLoginProofApproval -eq $true)
$readyToRequestUserApproval = ($sequence -and $sequence.readyToRequestUserApproval -eq $true)
$approvedSequenceOperatorNextAction = if ($sequence -and ($sequence.PSObject.Properties.Name -contains "operatorNextAction")) { [string]$sequence.operatorNextAction } else { "" }
$approvedSequenceAccountReadinessBlockingReason = if ($sequence -and ($sequence.PSObject.Properties.Name -contains "accountReadinessBlockingReason")) { [string]$sequence.accountReadinessBlockingReason } else { "" }

$nextOperatorAction = if (-not $targetUserExists) {
    "create_or_verify_target_windows_user_then_rerun_summary"
} elseif (-not $readyForOperatorLogin) {
    "rerun_account_prepare_and_status_until_login_safe"
} elseif (-not $releaseAcceptableAccountProof) {
    "run_approved_second_account_login_then_post_login_account_proof"
} elseif (-not $goalComplete) {
    "rerun_goal_readiness_after_account_proof"
} else {
    "goal_complete"
}
$operatorActionCard = [ordered]@{
    status = if ($releaseAcceptableAccountProof) {
        "second_account_proof_complete"
    } elseif ($readyForOperatorLogin) {
        "ready_for_user_login"
    } else {
        "not_ready_for_login"
    }
    windowsUser = $WindowsUser
    canAskUserToLoginNow = [bool]$readyForOperatorLogin
    targetUserExists = [bool]$targetUserExists
    missingRequirement = if (-not $targetUserExists) {
        "separate_windows_user_missing"
    } elseif (-not $readyForOperatorLogin) {
        "account_isolation_status_not_ready"
    } elseif (-not $releaseAcceptableAccountProof) {
        "interactive_second_account_login_and_post_login_proof_missing"
    } else {
        ""
    }
    nextOperatorAction = $nextOperatorAction
    userVisibleNextStep = if (-not $targetUserExists) {
        "Create or verify the separate Windows user, then rerun this summary."
    } elseif (-not $readyForOperatorLogin) {
        "Rerun the no-traffic account prepare and isolation checks until login is marked safe."
    } elseif (-not $releaseAcceptableAccountProof) {
        "With the user present, run the approved second-account login and then the post-login account proof."
    } else {
        "Rerun goal readiness."
    }
    noTrafficStatusCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-anticodex-second-account-readiness-summary.ps1 -WindowsUser $WindowsUser -Compact"
    approvedLoginCommandTemplate = if ($entrypoint) { [string]$entrypoint.approvedLoginCommandTemplate } else { "" }
    postLoginProofCommandTemplate = if ($entrypoint) { [string]$entrypoint.postLoginProofCommandTemplate } else { "" }
}

$reportRootFull = [IO.Path]::GetFullPath($ReportRoot)
New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null

$payload = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "second-account-readiness-summary"
    noTraffic = $true
    requestedRealTraffic = $false
    usedRealTraffic = $false
    changedSystem = $false
    createdUser = $false
    startedLogin = $false
    capturesPassword = $false
    storesPassword = $false
    behaviorCovered = $true
    coverageKind = "second-account-readiness-summary-no-traffic"
    windowsUser = $WindowsUser
    targetUserExists = [bool]$targetUserExists
    currentWindowsUserSid = $currentWindowsUserSid
    targetWindowsUserSid = $targetWindowsUserSid
    targetUserSidMatchesCurrentUser = [bool]$targetUserSidMatchesCurrentUser
    targetUserIdentityBoundaryOk = [bool]$targetUserIdentityBoundaryOk
    targetUserIsCurrentUser = [bool]$targetUserIsCurrentUser
    readyForOperatorLogin = [bool]$readyForOperatorLogin
    safeToAskUserForSecondAccountLogin = ($status -and $status.safeToAskUserForSecondAccountLogin -eq $true)
    canProceedToInteractiveLogin = ($status -and $status.canProceedToInteractiveLogin -eq $true)
    releaseAcceptableAccountProof = [bool]$releaseAcceptableAccountProof
    goalComplete = [bool]$goalComplete
    releaseReady = [bool]$releaseReady
    readyToRequestUserApproval = [bool]$readyToRequestUserApproval
    readyToRequestSecondAccountLoginApproval = [bool]$readyToRequestSecondAccountLoginApproval
    readyToRequestPostLoginProofApproval = [bool]$readyToRequestPostLoginProofApproval
    approvedSequenceOperatorNextAction = $approvedSequenceOperatorNextAction
    approvedSequenceNextAction = $approvedSequenceOperatorNextAction
    approvedSequenceAccountReadinessBlockingReason = $approvedSequenceAccountReadinessBlockingReason
    completionState = if ($status) { [string]$status.completionState } else { "status_unavailable" }
    readinessBlockingReason = if ($status) { [string]$status.readinessBlockingReason } else { "" }
    operatorBlockingStage = if ($status) { [string]$status.operatorBlockingStage } else { "status_unavailable" }
    operatorNextStep = if ($status) { [string]$status.operatorNextStep } else { "run_account_isolation_status" }
    nextOperatorAction = $nextOperatorAction
    operatorActionCard = $operatorActionCard
    manualSetupCommandHint = if ($setupGuidance -and ($setupGuidance.PSObject.Properties.Name -contains "manualSetupCommandHint")) { [string]$setupGuidance.manualSetupCommandHint } else { "" }
    postManualSetupValidationCommands = @($postManualSetupValidationCommands)
    postManualSetupRequiredReadyFields = @($postManualSetupRequiredReadyFields)
    readinessCheckSequence = if ($setupGuidance -and ($setupGuidance.PSObject.Properties.Name -contains "readinessCheckSequence")) { @($setupGuidance.readinessCheckSequence) } else { @() }
    operatorChecklistStages = @($operatorChecklistStages)
    operatorChecklistStartsLoginCount = [int]$operatorChecklistStartsLoginCount
    operatorChecklistUsesRealTrafficCount = [int]$operatorChecklistUsesRealTrafficCount
    approvedLoginCommandTemplate = if ($entrypoint) { [string]$entrypoint.approvedLoginCommandTemplate } else { "" }
    nextNoTrafficStatusCommand = if ($entrypoint) { [string]$entrypoint.nextNoTrafficStatusCommand } else { "" }
    postLoginProofCommandTemplate = if ($entrypoint) { [string]$entrypoint.postLoginProofCommandTemplate } else { "" }
    postLoginProofCommandTemplateHasWindowsUser = if ($entrypoint) { [string]$entrypoint.postLoginProofCommandTemplate -match "-WindowsUser" } else { $false }
    releaseGateCompactStatusCommand = $releaseGateCompactStatusCommand
    steps = @(
        (New-StepEvidence -Id "windowsUserAccountPrepare" -Result $prepareResult),
        (New-StepEvidence -Id "windowsUserSetupGuidance" -Result $setupGuidanceResult),
        (New-StepEvidence -Id "accountIsolationStatus" -Result $statusResult),
        (New-StepEvidence -Id "secondAccountLoginEntrypoint" -Result $entrypointResult),
        (New-StepEvidence -Id "approvedRealRunSequence" -Result $sequenceResult),
        (New-StepEvidence -Id "goalReadiness" -Result $goalResult),
        (New-StepEvidence -Id "releaseGates" -Result $releaseResult)
    )
    accountIsolationCaveat = "This summary is no-traffic and status-only. It does not create users, start login, capture credentials, use real traffic, or prove distinct Antigravity account identity."
    failures = @($failures)
    elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
}

$json = $payload | ConvertTo-Json -Depth 24
Write-AntiCodexJsonReport `
    -LatestPath (Join-Path $reportRootFull "latest-second-account-readiness-summary.json") `
    -HistoryPath (Join-Path $reportRootFull ("{0}-second-account-readiness-summary.json" -f ([DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")))) `
    -Json $json

if ($Compact) {
    [ordered]@{
        ok = $payload["ok"]
        reportName = $payload["reportName"]
        noTraffic = $payload["noTraffic"]
        usedRealTraffic = $payload["usedRealTraffic"]
        changedSystem = $payload["changedSystem"]
        createdUser = $payload["createdUser"]
        startedLogin = $payload["startedLogin"]
        capturesPassword = $payload["capturesPassword"]
        storesPassword = $payload["storesPassword"]
        windowsUser = $payload["windowsUser"]
        targetUserExists = $payload["targetUserExists"]
        targetWindowsUserSid = $payload["targetWindowsUserSid"]
        targetUserSidMatchesCurrentUser = $payload["targetUserSidMatchesCurrentUser"]
        targetUserIdentityBoundaryOk = $payload["targetUserIdentityBoundaryOk"]
        readyForOperatorLogin = $payload["readyForOperatorLogin"]
        safeToAskUserForSecondAccountLogin = $payload["safeToAskUserForSecondAccountLogin"]
        canProceedToInteractiveLogin = $payload["canProceedToInteractiveLogin"]
        releaseAcceptableAccountProof = $payload["releaseAcceptableAccountProof"]
        goalComplete = $payload["goalComplete"]
        releaseReady = $payload["releaseReady"]
        completionState = $payload["completionState"]
        readinessBlockingReason = $payload["readinessBlockingReason"]
        operatorBlockingStage = $payload["operatorBlockingStage"]
        nextOperatorAction = $payload["nextOperatorAction"]
        operatorActionCard = $payload["operatorActionCard"]
        failures = $payload["failures"]
        report = @{
            latest = Join-Path $reportRootFull "latest-second-account-readiness-summary.json"
        }
    } | ConvertTo-Json -Depth 10 -Compress
} else {
    $payload | ConvertTo-Json -Depth 24 -Compress
}
if ($failures.Count -gt 0) { exit 1 }
