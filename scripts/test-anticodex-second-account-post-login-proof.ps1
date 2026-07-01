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

foreach ($required in @($reportIo, $statusScript, $realSmokeScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing second-account post-login proof dependency: $required"
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
        stdoutTail = if ($text.Length -gt 800) { $text.Substring($text.Length - 800) } else { $text }
    }
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

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$statusResult = Invoke-JsonScript -ScriptPath $statusScript -Arguments @("-WindowsUser", $WindowsUser, "-ReportRoot", $ReportRoot)
$status = $statusResult.parsed
if (-not $statusResult.ok) { $failures.Add("account_isolation_status_unavailable") | Out-Null }

$resolvedProfileRoot = if ($ProfileRoot) { [IO.Path]::GetFullPath($ProfileRoot) } else { Get-LatestDualLaneProfileRoot }
$antiCodexAccountIdTrimmed = ([string]$AntiCodexAccountId).Trim()
$mcpAccountIdTrimmed = ([string]$McpAccountId).Trim()
$approvalIdTrimmed = ([string]$SeparateAccountProofApprovalId).Trim()
$accountIdsDiffer = ($antiCodexAccountIdTrimmed -and $mcpAccountIdTrimmed -and $antiCodexAccountIdTrimmed -ne $mcpAccountIdTrimmed)

if (-not $resolvedProfileRoot) { $failures.Add("isolated_profile_root_missing") | Out-Null }
if ($AllowRealTraffic -and -not $AllowSeparateAccountProof) { $failures.Add("allow_separate_account_proof_required") | Out-Null }
if ($AllowRealTraffic -and -not $ConfirmInteractiveLoginComplete) { $failures.Add("interactive_login_confirmation_required") | Out-Null }
if ($AllowRealTraffic -and -not $antiCodexAccountIdTrimmed) { $failures.Add("anticodex_account_id_required") | Out-Null }
if ($AllowRealTraffic -and -not $mcpAccountIdTrimmed) { $failures.Add("mcp_account_id_required") | Out-Null }
if ($AllowRealTraffic -and -not $approvalIdTrimmed) { $failures.Add("separate_account_proof_approval_id_required") | Out-Null }
if ($AllowRealTraffic -and $antiCodexAccountIdTrimmed -and $mcpAccountIdTrimmed -and -not $accountIdsDiffer) { $failures.Add("account_ids_match") | Out-Null }
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
        "-AntiCodexAccountId", $antiCodexAccountIdTrimmed,
        "-McpAccountId", $mcpAccountIdTrimmed,
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
    proofCommandPreview = New-ProofCommandPreview -ResolvedProfileRoot $resolvedProfileRoot -HasAntiCodexId ([bool]$antiCodexAccountIdTrimmed) -HasMcpId ([bool]$mcpAccountIdTrimmed) -HasApproval ([bool]$approvalIdTrimmed)
    proofInputs = [ordered]@{
        antiCodexAccountIdPresent = [bool]$antiCodexAccountIdTrimmed
        mcpAccountIdPresent = [bool]$mcpAccountIdTrimmed
        separateAccountProofApprovalIdPresent = [bool]$approvalIdTrimmed
        accountIdsDiffer = [bool]$accountIdsDiffer
    }
    statusCompletionState = if ($status) { [string]$status.completionState } else { "status_unavailable" }
    canRunAfterInteractiveLogin = if ($status -and $status.postLoginProofPlan) { [bool]$status.postLoginProofPlan.canRunAfterInteractiveLogin } else { $false }
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
