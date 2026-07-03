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
$reportIo = Join-Path $scriptRoot "anticodex-report-io.ps1"
$jsonInvoke = Join-Path $scriptRoot "anticodex-powershell-json-invoke.ps1"
$postLoginProofScript = Join-Path $scriptRoot "test-anticodex-second-account-post-login-proof.ps1"

foreach ($required in @($reportIo, $jsonInvoke, $postLoginProofScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "missing external MCP identity contract dependency: $required"
    }
}
. $reportIo
. $jsonInvoke

function Save-ExternalMcpIdentityContractReport {
    param($Report)
    $reportRootFull = [IO.Path]::GetFullPath($ReportRoot)
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $latestPath = Join-Path $reportRootFull "latest-external-mcp-identity-contract.json"
    $historyPath = Join-Path $reportRootFull "$stamp-external-mcp-identity-contract.json"
    $json = $Report | ConvertTo-Json -Depth 24
    Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json
    return [ordered]@{
        latest = $latestPath
        history = $historyPath
    }
}

$tempRoot = Join-Path $env:TEMP ("anticodex-external-mcp-identity-contract-" + [Guid]::NewGuid().ToString("N"))
$profileRoot = Join-Path $tempRoot "profile"
$tempReportRoot = Join-Path $tempRoot "reports"
$externalIdentityPath = Join-Path $tempRoot "external-mcp-identity.json"
New-Item -ItemType Directory -Path $profileRoot, $tempReportRoot -Force | Out-Null

$externalIdentity = [ordered]@{
    reportName = "external-mcp-antigravity-account-identity"
    ok = $true
    accountLaneRole = "external-mcp-antigravity-account"
    mcpAccountLaneManagedByAntiCodex = $false
    identityAvailable = $true
    accountFingerprint = "sha256:external-mcp-account-contract"
    source = "external-mcp-antigravity-account-identity-report"
}
$externalIdentity | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $externalIdentityPath -Encoding UTF8

$proofResult = Invoke-AntiCodexPowerShellJsonScript -ScriptPath $postLoginProofScript -Arguments @(
    "-WindowsUser", $WindowsUser,
    "-ReportRoot", $tempReportRoot,
    "-ProfileRoot", $profileRoot,
    "-AntiCodexAccountId", "sha256:anticodex-account-contract",
    "-McpAccountIdentityReport", $externalIdentityPath
)

$proof = $proofResult.parsed
$failures = New-Object System.Collections.Generic.List[string]
if (-not $proofResult.ok) { $failures.Add("post_login_proof_contract_invocation_failed") | Out-Null }
if (-not $proof -or $proof.ok -ne $true) { $failures.Add("post_login_proof_contract_not_ok") | Out-Null }
if ($proof.usedRealTraffic -ne $false -or $proof.requestedRealTraffic -ne $false) { $failures.Add("contract_used_real_traffic") | Out-Null }
if ($proof.changedSystem -ne $false -or $proof.createdUser -ne $false -or $proof.capturesPassword -ne $false -or $proof.storesPassword -ne $false) { $failures.Add("contract_changed_system_or_credentials") | Out-Null }
if ($proof.externalMcpAccountIdentityReport.accepted -ne $true) { $failures.Add("external_mcp_identity_not_accepted") | Out-Null }
if ($proof.accountIdentityInputChecklist.mcpAccountId.suggestedAvailable -ne $true) { $failures.Add("mcp_identity_not_suggested") | Out-Null }
if ($proof.accountIdentityInputChecklist.mcpAccountId.managedByAntiCodex -ne $false) { $failures.Add("mcp_identity_managed_by_anticodex") | Out-Null }
if ([string]$proof.accountIdentityInputChecklist.mcpAccountId.requiredSource -ne "external-mcp-antigravity-account") { $failures.Add("mcp_identity_source_mismatch") | Out-Null }
if ($proof.proofInputs.mcpAccountIdFromExternalReport -ne $true -or $proof.proofInputs.effectiveMcpAccountIdPresent -ne $true) { $failures.Add("mcp_identity_not_effective") | Out-Null }
$missingRequirements = @($proof.operatorActionCard.missingRequirements | ForEach-Object { [string]$_ })
if ($missingRequirements -contains "account_identity_inputs_missing") { $failures.Add("operator_still_reports_identity_inputs_missing") | Out-Null }

$payload = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "external-mcp-identity-contract"
    noTraffic = $true
    requestedRealTraffic = $false
    usedRealTraffic = $false
    changedSystem = $false
    createdUser = $false
    capturesPassword = $false
    storesPassword = $false
    behaviorCovered = $true
    coverageKind = "external-mcp-identity-contract-no-traffic"
    externalMcpIdentityAccepted = ($proof.externalMcpAccountIdentityReport.accepted -eq $true)
    mcpAccountIdFromExternalReport = ($proof.proofInputs.mcpAccountIdFromExternalReport -eq $true)
    effectiveMcpAccountIdPresent = ($proof.proofInputs.effectiveMcpAccountIdPresent -eq $true)
    mcpAccountLaneManagedByAntiCodex = $proof.accountIdentityInputChecklist.mcpAccountId.managedByAntiCodex
    mcpAccountRequiredSource = [string]$proof.accountIdentityInputChecklist.mcpAccountId.requiredSource
    operatorIdentityInputsClear = ($missingRequirements -notcontains "account_identity_inputs_missing")
    failures = @($failures)
    elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
}
$payload.report = Save-ExternalMcpIdentityContractReport -Report $payload

$jsonOut = $payload | ConvertTo-Json -Depth 24
Write-Output $jsonOut
if (-not $payload.ok) { exit 1 }
