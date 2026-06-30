#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WindowsUser = ".\AntiCodexModel",
    [switch]$StartLogin,
    [string]$StartLoginApproval = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
$statusScript = Join-Path $scriptRoot "test-anticodex-antigravity-account-isolation-status.ps1"
$loginScript = Join-Path $scriptRoot "start-anticodex-antigravity-cli-login-windows-user.ps1"

foreach ($required in @($statusScript, $loginScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing second-account login dependency: $required"
    }
}

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

$statusResult = Invoke-JsonScript -ScriptPath $statusScript -Arguments @(
    "-WindowsUser", $WindowsUser,
    "-ReportRoot", $ReportRoot
)
$status = $statusResult.parsed
$safeToStartLogin = ($statusResult.ok -and $status.safeToAskUserForSecondAccountLogin -eq $true -and $status.canProceedToInteractiveLogin -eq $true)
$approvalToken = "start-separate-windows-user-login"

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
    $result | ConvertTo-Json -Depth 20 -Compress
    exit 1
}

if (-not $StartLogin) {
    $result | ConvertTo-Json -Depth 20 -Compress
    exit 0
}

if ($StartLoginApproval -ne $approvalToken) {
    $result.ok = $false
    $result.error = "explicit_start_login_approval_missing"
    $result | ConvertTo-Json -Depth 20 -Compress
    exit 2
}

if (-not $safeToStartLogin) {
    $result.ok = $false
    $result.error = "second_account_login_not_ready"
    $result | ConvertTo-Json -Depth 20 -Compress
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
$result | ConvertTo-Json -Depth 20 -Compress
if (-not $result.ok) { exit 2 }
