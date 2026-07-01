#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$AllowRealTraffic,
    [string]$StateRoot = "",
    [string]$ReportRoot = "",
    [string]$ProfileRoot = "",
    [string]$WindowsUser = ".\AntiCodexModel",
    [switch]$StrictWindowsAppDataIsolation,
    [switch]$AllowSeparateAccountProof,
    [string]$AntiCodexAccountId = "",
    [string]$McpAccountId = "",
    [string]$SeparateAccountProofApprovalId = "",
    [ValidateSet("profile-and-appdata-only", "separate-windows-user", "official-independent-credential-store")]
    [string]$AccountIsolationBoundary = "profile-and-appdata-only",
    [string]$Model = "gemini-pro-agent",
    [string]$Prompt = "",
    [int]$TimeoutSec = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]
$attemptedRealTraffic = $false
$profileRootFull = ""
$profileSource = "none"
$strictIsolation = $false

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Resolve-StateRoot {
    if ($StateRoot) { return [IO.Path]::GetFullPath($StateRoot) }
    if ($env:DEEPCODEX_STATE_ROOT) { return [IO.Path]::GetFullPath($env:DEEPCODEX_STATE_ROOT) }
    return [IO.Path]::GetFullPath((Join-Path $env:APPDATA "anticodex"))
}

function Resolve-ReportRoot {
    if ($ReportRoot) { return [IO.Path]::GetFullPath($ReportRoot) }
    if ($env:ANTICODEX_REPORT_ROOT) { return [IO.Path]::GetFullPath($env:ANTICODEX_REPORT_ROOT) }
    return [IO.Path]::GetFullPath((Join-Path $env:APPDATA "anticodex\reports"))
}

function Write-Report {
    param([hashtable]$Report)
    $reportRootFull = Resolve-ReportRoot
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
    $json = $Report | ConvertTo-Json -Depth 20
    Write-AntiCodexJsonReport `
        -LatestPath (Join-Path $reportRootFull "latest-antigravity-cli-real-smoke.json") `
        -HistoryPath (Join-Path $reportRootFull ("{0}-antigravity-cli-real-smoke.json" -f ([DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")))) `
        -Json $json
    $Report | ConvertTo-Json -Depth 20 -Compress
}

function ConvertTo-JsStringLiteral {
    param([string]$Value)
    $escaped = $Value.Replace("\", "\\").Replace("'", "\'").Replace("`r", "\r").Replace("`n", "\n")
    return "'$escaped'"
}

function Read-SavedAntigravityCliProfile {
    $profileScript = Join-Path $PSScriptRoot "anticodex-upstream-profile.ps1"
    $output = & $profileScript -Action GetRuntime -StateRoot (Resolve-StateRoot)
    if (-not $?) {
        throw "failed to read saved upstream profile"
    }
    $profile = (($output -join [Environment]::NewLine) | ConvertFrom-Json)
    if ($profile.antigravityCli) { return $profile.antigravityCli }
    return $null
}

function Get-PreparationReportEvidence {
    param([string]$ExpectedProfileRoot)

    $latestPath = Join-Path (Resolve-ReportRoot) "latest-antigravity-cli-profile-prepare.json"
    $evidence = [ordered]@{
        present = $false
        file = $latestPath
        profileMatched = $false
        strictWindowsAppDataIsolation = $false
        noTraffic = $false
        usedRealTraffic = $null
        loginVerified = $null
        error = ""
    }
    if (-not (Test-Path -LiteralPath $latestPath)) { return $evidence }

    try {
        $prepare = Get-Content -LiteralPath $latestPath -Raw | ConvertFrom-Json
        $evidence.present = $true
        $evidence.strictWindowsAppDataIsolation = ($prepare.strictWindowsAppDataIsolation -eq $true)
        $evidence.noTraffic = ($prepare.noTraffic -eq $true)
        $evidence.usedRealTraffic = ($prepare.usedRealTraffic -eq $true)
        $evidence.loginVerified = ($prepare.loginVerified -eq $true)
        if ($ExpectedProfileRoot -and [string]$prepare.profileRoot) {
            $preparedRoot = [IO.Path]::GetFullPath([string]$prepare.profileRoot)
            $evidence.profileMatched = ($preparedRoot -eq [IO.Path]::GetFullPath($ExpectedProfileRoot))
        }
    } catch {
        $evidence.error = $_.Exception.Message
    }
    return $evidence
}

function Get-KnownDefaultAntigravityProfileRoots {
    $roots = New-Object System.Collections.Generic.List[string]
    if ($env:USERPROFILE) {
        $roots.Add([IO.Path]::GetFullPath($env:USERPROFILE)) | Out-Null
        $roots.Add([IO.Path]::GetFullPath((Join-Path $env:USERPROFILE ".antigravity"))) | Out-Null
    }
    if ($env:APPDATA) {
        $roots.Add([IO.Path]::GetFullPath((Join-Path $env:APPDATA "Antigravity"))) | Out-Null
        $roots.Add([IO.Path]::GetFullPath((Join-Path $env:APPDATA "Antigravity CLI"))) | Out-Null
        $roots.Add([IO.Path]::GetFullPath((Join-Path $env:APPDATA "Google\Antigravity"))) | Out-Null
    }
    if ($env:LOCALAPPDATA) {
        $roots.Add([IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Antigravity"))) | Out-Null
        $roots.Add([IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Antigravity CLI"))) | Out-Null
        $roots.Add([IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Google\Antigravity"))) | Out-Null
    }
    return $roots.ToArray()
}

function Test-IsDefaultAntigravityProfilePath {
    param(
        [Parameter(Mandatory = $true)][string]$ProfileRoot,
        [Parameter(Mandatory = $true)][string]$DefaultRoot
    )
    $profileFull = [IO.Path]::GetFullPath($ProfileRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $defaultFull = [IO.Path]::GetFullPath($DefaultRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if ($profileFull -ieq $defaultFull) { return $true }
    if ($env:USERPROFILE -and $defaultFull -ieq ([IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))) { return $false }
    return $profileFull.StartsWith($defaultFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Get-WindowsUserLeafName {
    param([string]$Value)
    $text = ([string]$Value).Trim()
    if (-not $text) { return "" }
    if ($text.StartsWith(".\")) { $text = $text.Substring(2) }
    if ($text.Contains("\")) { return ($text -split "\\")[-1] }
    return $text
}

function New-AccountIdentityComparison {
    param(
        [Parameter(Mandatory = $true)][string]$AntiCodexId,
        [Parameter(Mandatory = $true)][string]$McpId,
        [Parameter(Mandatory = $true)][string]$CapturedAt,
        [Parameter(Mandatory = $true)][string]$ApprovalId
    )
    return [ordered]@{
        antiCodexAccountId = $AntiCodexId
        mcpAccountId = $McpId
        antiCodexSource = "anticodex-cli-real-smoke"
        mcpSource = "external-mcp-antigravity-account"
        comparisonMethod = "explicit-user-approved-account-identity-parameter"
        capturedAt = $CapturedAt
        approvalId = $ApprovalId
        approvalSource = "explicit-user-approval"
    }
}

$stateRootFull = Resolve-StateRoot
$reportRootFull = Resolve-ReportRoot
$currentWindowsUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$targetWindowsUser = ([string]$WindowsUser).Trim()
$currentWindowsUserLeaf = Get-WindowsUserLeafName -Value $currentWindowsUser
$targetWindowsUserLeaf = Get-WindowsUserLeafName -Value $targetWindowsUser
$runningAsTargetWindowsUser = ($targetWindowsUserLeaf -and $currentWindowsUserLeaf -and $currentWindowsUserLeaf.Equals($targetWindowsUserLeaf, [StringComparison]::OrdinalIgnoreCase))
$marker = "ANTICODEX_CLI_REAL_SMOKE_{0}" -f ([Guid]::NewGuid().ToString("N"))
$effectivePrompt = if ([string]::IsNullOrWhiteSpace($Prompt)) {
    "Reply with exactly this marker and no other content: $marker"
} else {
    $Prompt
}
$antiCodexAccountIdTrimmed = ([string]$AntiCodexAccountId).Trim()
$mcpAccountIdTrimmed = ([string]$McpAccountId).Trim()
$separateAccountProofApprovalIdTrimmed = ([string]$SeparateAccountProofApprovalId).Trim()
$accountIdentityComparison = $null
$separateAccountVerified = $false
$separateAccountVerificationReason = "marker match proves Antigravity CLI model access for this profile path; it does not prove a different Windows credential-store account"

try {
    if (-not $AllowRealTraffic) {
        $report = [ordered]@{
            ok = $true
            reportName = "antigravity-cli-real-smoke"
            skipped = $true
            requestedRealTraffic = $false
            skipReason = "real Antigravity CLI traffic is opt-in; rerun only after the Anti-Codex lane uses a separate Windows user or official independent Antigravity credential store"
            reason = "real Antigravity CLI traffic is opt-in; rerun only after the Anti-Codex lane uses a separate Windows user or official independent Antigravity credential store"
            coveredBy = "test-anticodex-antigravity-cli-real-smoke.ps1 -AllowRealTraffic -ProfileRoot <isolated-profile> -AccountIsolationBoundary <separate-windows-user|official-independent-credential-store>"
            usedRealTraffic = $false
            windowsUser = $targetWindowsUser
            currentWindowsUser = $currentWindowsUser
            runningAsTargetWindowsUser = $runningAsTargetWindowsUser
            loginVerified = $false
            separateAccountVerified = $false
            accountIsolationBoundary = $AccountIsolationBoundary
            accountIsolationCaveat = "Skipped real traffic; no account identity or Windows credential-store isolation was verified."
            behaviorCovered = $false
            coverageKind = "skipped"
            stateRoot = $stateRootFull
            reportRoot = $reportRootFull
            preparationReport = (Get-PreparationReportEvidence -ExpectedProfileRoot "")
            accountLaneRole = "anticodex-model-text"
            mcpAccountLaneManagedByAntiCodex = $false
            mcpAccountLaneOwner = "external-antigravity-account-not-managed-here"
            failures = @()
        }
        Write-Report -Report $report
        exit 0
    }

    $savedCli = Read-SavedAntigravityCliProfile
    $profileRootFull = if ($ProfileRoot) {
        $profileSource = "argument"
        [IO.Path]::GetFullPath($ProfileRoot)
    } elseif ($savedCli -and [string]$savedCli.profileRoot) {
        $profileSource = "saved-profile"
        [IO.Path]::GetFullPath([string]$savedCli.profileRoot)
    } else {
        ""
    }

    if (-not $profileRootFull) {
        Add-Failure "isolated Antigravity CLI profileRoot is required before real CLI smoke; refusing to use the default account"
    }
    $knownDefaultRoots = Get-KnownDefaultAntigravityProfileRoots
    foreach ($defaultRoot in $knownDefaultRoots) {
        if ($profileRootFull -and (Test-IsDefaultAntigravityProfilePath -ProfileRoot $profileRootFull -DefaultRoot $defaultRoot)) {
            Add-Failure "profileRoot matches or nests under a known default Antigravity profile location; refusing to test against the default account"
            break
        }
    }

    $strictIsolation = $StrictWindowsAppDataIsolation.IsPresent
    if (-not $strictIsolation -and $savedCli -and $savedCli.strictWindowsAppDataIsolation -eq $true) {
        $strictIsolation = $true
    }
    $preparationEvidence = Get-PreparationReportEvidence -ExpectedProfileRoot $profileRootFull
    if (-not $strictIsolation) {
        Add-Failure "strict Windows AppData isolation is required before real CLI smoke"
    }

    if ($AllowSeparateAccountProof.IsPresent) {
        if (-not $antiCodexAccountIdTrimmed) { Add-Failure "Anti-Codex account identity is required before separate-account proof can be recorded" }
        if (-not $mcpAccountIdTrimmed) { Add-Failure "MCP Antigravity account identity is required before separate-account proof can be recorded" }
        if (-not $separateAccountProofApprovalIdTrimmed) { Add-Failure "explicit separate-account proof approval id is required before separate-account proof can be recorded" }
        if ($AccountIsolationBoundary -eq "profile-and-appdata-only") { Add-Failure "same Windows user profile/AppData isolation is not credential isolation; use a separate Windows user or official independent credential store before separate-account proof" }
        if ($AccountIsolationBoundary -eq "separate-windows-user" -and -not $targetWindowsUserLeaf) { Add-Failure "target Windows user is required before separate-Windows-user proof can be recorded" }
        if ($AccountIsolationBoundary -eq "separate-windows-user" -and $targetWindowsUserLeaf -and -not $runningAsTargetWindowsUser) { Add-Failure "separate-Windows-user proof must run under the target Windows user before account proof can be recorded" }
        if ($antiCodexAccountIdTrimmed -and $mcpAccountIdTrimmed -and $antiCodexAccountIdTrimmed -eq $mcpAccountIdTrimmed) {
            Add-Failure "Anti-Codex and MCP Antigravity account identities match; separate-account proof rejected"
        }
    } elseif ($antiCodexAccountIdTrimmed -or $mcpAccountIdTrimmed) {
        Add-Failure "account identity inputs require -AllowSeparateAccountProof; refusing to record ambiguous identity evidence"
    }

    if ($failures.Count -eq 0) {
        New-Item -ItemType Directory -Path $profileRootFull -Force | Out-Null
        $node = (Get-Command "node" -ErrorAction Stop).Source
        $modulePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\translator\antigravity-agentapi.mjs"))
        $moduleLiteral = ConvertTo-JsStringLiteral $modulePath
        $promptLiteral = ConvertTo-JsStringLiteral $effectivePrompt
        $modelLiteral = ConvertTo-JsStringLiteral $Model
        $cwdLiteral = ConvertTo-JsStringLiteral ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..")))
        $profileLiteral = ConvertTo-JsStringLiteral $profileRootFull
        $strictLiteral = if ($strictIsolation) { "'1'" } else { "'0'" }
        $timeoutMs = [Math]::Max(1000, $TimeoutSec * 1000)
        $script = @"
import { pathToFileURL } from 'node:url';
const { runAntigravityTextTurn, antigravityCliIsolationEnv } = await import(pathToFileURL($moduleLiteral).href);
const env = {
  ANTICODEX_ANTIGRAVITY_CLI_PROFILE_ROOT: $profileLiteral,
  ANTICODEX_ANTIGRAVITY_CLI_ISOLATE_WINDOWS_APPDATA: $strictLiteral,
};
const result = await runAntigravityTextTurn($promptLiteral, {
  model: $modelLiteral,
  timeoutMs: $timeoutMs,
  cwd: $cwdLiteral,
  env,
});
console.log(JSON.stringify({ result, derivedEnv: antigravityCliIsolationEnv(env) }));
"@
        $attemptedRealTraffic = $true
        $output = & $node "--input-type=module" "-e" $script
        if ($LASTEXITCODE -ne 0) { Add-Failure "Antigravity CLI real smoke exited with $LASTEXITCODE" }
        $payload = if ($output) { (($output -join [Environment]::NewLine) | ConvertFrom-Json) } else { $null }
        $text = if ($payload -and $payload.result) { [string]$payload.result.text } else { "" }
        if ($Prompt -eq "" -and $text -notmatch [regex]::Escape($marker)) {
            Add-Failure "Antigravity CLI real smoke response did not contain the marker"
        }
    }

    $elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
    if ($AllowSeparateAccountProof.IsPresent -and $failures.Count -eq 0) {
        $accountIdentityComparison = New-AccountIdentityComparison -AntiCodexId $antiCodexAccountIdTrimmed -McpId $mcpAccountIdTrimmed -CapturedAt ([DateTime]::UtcNow.ToString("o")) -ApprovalId $separateAccountProofApprovalIdTrimmed
        $separateAccountVerified = $true
        $separateAccountVerificationReason = "explicitly approved real CLI smoke under $AccountIsolationBoundary plus external MCP account identity comparison showed distinct account identities"
    }

    $report = [ordered]@{
        ok = ($failures.Count -eq 0)
        reportName = "antigravity-cli-real-smoke"
        skipped = $false
        requestedRealTraffic = $true
        usedRealTraffic = $attemptedRealTraffic
        loginVerified = ($failures.Count -eq 0)
        behaviorCovered = ($failures.Count -eq 0)
        coverageKind = if ($attemptedRealTraffic) { "real-traffic" } elseif (-not $profileRootFull) { "blocked-no-profile" } else { "blocked-not-isolated" }
        elapsedMs = $elapsedMs
        model = $Model
        profileRoot = $profileRootFull
        profileSource = $profileSource
        windowsUser = $targetWindowsUser
        currentWindowsUser = $currentWindowsUser
        runningAsTargetWindowsUser = $runningAsTargetWindowsUser
        strictWindowsAppDataIsolation = $strictIsolation
        preparationReport = $preparationEvidence
        loginVerifiedMethod = if ($failures.Count -eq 0) { "marker-match" } else { "" }
        separateAccountVerified = $separateAccountVerified
        separateAccountVerificationReason = $separateAccountVerificationReason
        accountIsolationBoundary = $AccountIsolationBoundary
        accountIsolationCaveat = "Same-Windows-user profile/AppData isolation is not credential isolation. Separate-account proof requires a separate Windows user or official independent Antigravity credential store plus account identity comparison."
        marker = if ($Prompt -eq "") { $marker } else { "" }
        accountLaneRole = "anticodex-model-text"
        mcpAccountLaneManagedByAntiCodex = $false
        mcpAccountLaneOwner = "external-antigravity-account-not-managed-here"
        failures = $failures.ToArray()
    }
    if ($accountIdentityComparison) {
        $report.accountIdentityComparison = $accountIdentityComparison
    }
    Write-Report -Report $report
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Add-Failure $_.Exception.Message
    $report = [ordered]@{
        ok = $false
        reportName = "antigravity-cli-real-smoke"
        skipped = (-not $AllowRealTraffic)
        requestedRealTraffic = [bool]$AllowRealTraffic
        usedRealTraffic = $attemptedRealTraffic
        windowsUser = $targetWindowsUser
        currentWindowsUser = $currentWindowsUser
        runningAsTargetWindowsUser = $runningAsTargetWindowsUser
        loginVerified = $false
        separateAccountVerified = $false
        accountIsolationBoundary = $AccountIsolationBoundary
        accountIsolationCaveat = "Failure path did not prove account identity or Windows credential-store isolation."
        behaviorCovered = $false
        coverageKind = if ($attemptedRealTraffic) { "real-traffic" } elseif (-not $AllowRealTraffic) { "skipped" } elseif (-not $profileRootFull) { "blocked-no-profile" } else { "blocked-not-isolated" }
        accountLaneRole = "anticodex-model-text"
        mcpAccountLaneManagedByAntiCodex = $false
        mcpAccountLaneOwner = "external-antigravity-account-not-managed-here"
        elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
        failures = $failures.ToArray()
    }
    Write-Report -Report $report
    exit 1
}
