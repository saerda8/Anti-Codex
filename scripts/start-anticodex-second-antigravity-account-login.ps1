#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WindowsUser = ".\AntiCodexModel",
    [switch]$StartLogin,
    [string]$StartLoginApproval = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [switch]$Compact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
$statusScript = Join-Path $scriptRoot "test-anticodex-antigravity-account-isolation-status.ps1"
$loginScript = Join-Path $scriptRoot "start-anticodex-antigravity-cli-login-windows-user.ps1"
$jsonInvoke = Join-Path $scriptRoot "anticodex-powershell-json-invoke.ps1"

foreach ($required in @($statusScript, $loginScript, $jsonInvoke)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing second-account login dependency: $required"
    }
}
. $jsonInvoke

function ConvertTo-CompactEntrypointJson {
    param($Value)
    [ordered]@{
        ok = $Value["ok"]
        reportName = $Value["reportName"]
        noTraffic = $Value["noTraffic"]
        usedRealTraffic = $Value["usedRealTraffic"]
        windowsUser = $Value["windowsUser"]
        requestedStartLogin = $Value["requestedStartLogin"]
        startedLogin = $Value["startedLogin"]
        changedSystem = $Value["changedSystem"]
        createdUser = $Value["createdUser"]
        capturesPassword = $Value["capturesPassword"]
        storesPassword = $Value["storesPassword"]
        safeToStartLogin = $Value["safeToStartLogin"]
        completionState = $Value["completionState"]
        readinessBlockingReason = $Value["readinessBlockingReason"]
        operatorBlockingStage = $Value["operatorBlockingStage"]
        operatorNextStep = $Value["operatorNextStep"]
        approvedLoginCommandTemplate = $Value["approvedLoginCommandTemplate"]
        postLoginProofCommandTemplate = $Value["postLoginProofCommandTemplate"]
        error = if ($Value.Contains("error")) { $Value["error"] } else { "" }
    } | ConvertTo-Json -Depth 8 -Compress
}

function Invoke-JsonScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )
    return Invoke-AntiCodexPowerShellJsonScript -ScriptPath $ScriptPath -Arguments $Arguments -TailLength 600
}

$statusResult = Invoke-JsonScript -ScriptPath $statusScript -Arguments @(
    "-WindowsUser", $WindowsUser,
    "-ReportRoot", $ReportRoot
)
$status = $statusResult.parsed
$safeToStartLogin = ($statusResult.ok -and $status.safeToAskUserForSecondAccountLogin -eq $true -and $status.canProceedToInteractiveLogin -eq $true)
$approvalToken = "start-separate-windows-user-login"
$approvedLoginCommandTemplate = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\start-anticodex-second-antigravity-account-login.ps1 -WindowsUser $WindowsUser -StartLogin -StartLoginApproval $approvalToken"
$postLoginProofPlan = if ($status -and ($status.PSObject.Properties.Name -contains "postLoginProofPlan")) { $status.postLoginProofPlan } else { $null }
$postLoginProofCommandTemplate = if ($postLoginProofPlan -and ($postLoginProofPlan.PSObject.Properties.Name -contains "commandTemplate")) { [string]$postLoginProofPlan.commandTemplate } else { "" }
$canRunPostLoginProof = if ($postLoginProofPlan -and ($postLoginProofPlan.PSObject.Properties.Name -contains "canRunAfterInteractiveLogin")) { [bool]$postLoginProofPlan.canRunAfterInteractiveLogin } else { $false }

$result = [ordered]@{
    ok = $statusResult.ok
    reportName = "second-antigravity-account-login-entrypoint"
    noTraffic = $true
    usedRealTraffic = $false
    requestedRealTraffic = $false
    behaviorCovered = $true
    coverageKind = "second-account-login-entrypoint-direct"
    capturesLoginOutput = $false
    windowsUser = $WindowsUser
    requestedStartLogin = [bool]$StartLogin
    startedLogin = $false
    changedSystem = $false
    createdUser = $false
    capturesPassword = $false
    storesPassword = $false
    safeToStartLogin = $safeToStartLogin
    requiredStartLoginApproval = $approvalToken
    approvedLoginCommandTemplate = $approvedLoginCommandTemplate
    nextNoTrafficStatusCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-anticodex-antigravity-account-isolation-status.ps1 -WindowsUser $WindowsUser -Compact"
    postLoginProofCommandTemplate = $postLoginProofCommandTemplate
    postLoginProofCommandTemplateHasWindowsUser = $postLoginProofCommandTemplate.Contains("-WindowsUser")
    canRunPostLoginProof = $canRunPostLoginProof
    postLoginProofPlan = $postLoginProofPlan
    completionState = if ($status) { [string]$status.completionState } else { "status_unavailable" }
    readinessBlockingReason = if ($status) { [string]$status.readinessBlockingReason } else { "" }
    operatorBlockingStage = if ($status) { [string]$status.operatorBlockingStage } else { "status_unavailable" }
    operatorNextStep = if ($status) { [string]$status.operatorNextStep } else { "run_account_isolation_status" }
    runasWorkingDirectory = ""
    bootstrapKeepsShellOpen = $false
    separateAccountVerified = $false
    loginVerified = $false
    releaseAcceptableAccountProof = $false
    statusReport = if ($status) { $status.report } else { $null }
    accountIsolationCaveat = "This operator entrypoint only starts a Windows runas login after explicit approval and readiness proof. It does not create users, capture credentials, use real traffic, or prove distinct Antigravity account identity."
}

if (-not $statusResult.ok) {
    $result.ok = $false
    $result.error = "account_isolation_status_unavailable"
    $result.statusExitCode = $statusResult.exitCode
    $result.statusParseError = $statusResult.parseError
    if ($Compact) {
        ConvertTo-CompactEntrypointJson -Value $result
    } else {
        $result | ConvertTo-Json -Depth 20 -Compress
    }
    exit 1
}

if (-not $StartLogin) {
    if ($Compact) {
        ConvertTo-CompactEntrypointJson -Value $result
    } else {
        $result | ConvertTo-Json -Depth 20 -Compress
    }
    exit 0
}

if ($StartLoginApproval -ne $approvalToken) {
    $result.ok = $false
    $result.error = "explicit_start_login_approval_missing"
    if ($Compact) {
        ConvertTo-CompactEntrypointJson -Value $result
    } else {
        $result | ConvertTo-Json -Depth 20 -Compress
    }
    exit 2
}

if (-not $safeToStartLogin) {
    $result.ok = $false
    $result.error = "second_account_login_not_ready"
    if ($Compact) {
        ConvertTo-CompactEntrypointJson -Value $result
    } else {
        $result | ConvertTo-Json -Depth 20 -Compress
    }
    exit 2
}

$loginResult = Invoke-JsonScript -ScriptPath $loginScript -Arguments @(
    "-WindowsUser", $WindowsUser
)
$login = $loginResult.parsed
$result.ok = $loginResult.ok -and $login.ok -eq $true
$result.startedLogin = ($login -and $login.started -eq $true)
$result.runasWorkingDirectory = if ($login) { [string]$login.runasWorkingDirectory } else { "" }
$result.bootstrapKeepsShellOpen = if ($login -and ($login.PSObject.Properties.Name -contains "bootstrapKeepsShellOpen")) { [bool]$login.bootstrapKeepsShellOpen } else { $true }
$result.loginExitCode = $loginResult.exitCode
if (-not $result.ok) {
    $result.error = if ($login -and $login.error) { [string]$login.error } else { "second_account_login_start_failed" }
}
if ($Compact) {
    ConvertTo-CompactEntrypointJson -Value $result
} else {
    $result | ConvertTo-Json -Depth 20 -Compress
}
if (-not $result.ok) { exit 2 }
