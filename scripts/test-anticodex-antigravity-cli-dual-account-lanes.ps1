#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$StateRoot = "",
    [string]$ReportRoot = "",
    [string]$AntiCodexProfileRoot = "",
    [string]$McpProfileRoot = "",
    [int]$TimeoutSec = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]

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

function Normalize-Path {
    param([string]$Path)
    if (-not $Path) { return "" }
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Test-IsPathNestedOrSame {
    param(
        [Parameter(Mandatory = $true)][string]$Child,
        [Parameter(Mandatory = $true)][string]$Parent
    )
    $childFull = Normalize-Path $Child
    $parentFull = Normalize-Path $Parent
    if (-not $childFull -or -not $parentFull) { return $false }
    if ($childFull -ieq $parentFull) { return $true }
    return $childFull.StartsWith($parentFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
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
    $profileFull = Normalize-Path $ProfileRoot
    $defaultFull = Normalize-Path $DefaultRoot
    if ($profileFull -ieq $defaultFull) { return $true }
    if ($env:USERPROFILE -and $defaultFull -ieq (Normalize-Path $env:USERPROFILE)) { return $false }
    return $profileFull.StartsWith($defaultFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function New-LaneEvidence {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$ProfileRoot,
        [Parameter(Mandatory = $true)][bool]$ManagedByAntiCodex
    )
    $geminiDir = Join-Path $ProfileRoot ".gemini"
    $conversationsDir = Join-Path $geminiDir "antigravity-cli\conversations"
    $appDataDir = Join-Path $ProfileRoot "AppData\Roaming"
    $localAppDataDir = Join-Path $ProfileRoot "AppData\Local"
    foreach ($dir in @($ProfileRoot, $geminiDir, $conversationsDir, $appDataDir, $localAppDataDir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return [ordered]@{
        role = $Role
        managedByAntiCodex = $ManagedByAntiCodex
        profileRoot = $ProfileRoot
        strictWindowsAppDataIsolation = $true
        loginVerified = $false
        separateAccountVerified = $false
        directories = [ordered]@{
            geminiDir = $geminiDir
            conversationsDir = $conversationsDir
            appData = $appDataDir
            localAppData = $localAppDataDir
        }
        isolationEnv = [ordered]@{
            ANTIGRAVITY_PROFILE = $ProfileRoot
            HOME = $ProfileRoot
            USERPROFILE = $ProfileRoot
            GEMINI_DIR = $geminiDir
            ANTIGRAVITY_CLI_CONVERSATIONS_DIR = $conversationsDir
            APPDATA = $appDataDir
            LOCALAPPDATA = $localAppDataDir
        }
    }
}

function Write-Report {
    param([hashtable]$Report)
    $reportRootFull = Resolve-ReportRoot
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
    $json = $Report | ConvertTo-Json -Depth 24
    Write-AntiCodexJsonReport `
        -LatestPath (Join-Path $reportRootFull "latest-antigravity-cli-dual-account-lanes.json") `
        -HistoryPath (Join-Path $reportRootFull ("{0}-antigravity-cli-dual-account-lanes.json" -f ([DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")))) `
        -Json $json
    $Report | ConvertTo-Json -Depth 24 -Compress
}

$stateRootFull = Resolve-StateRoot
$reportRootFull = Resolve-ReportRoot
$antiCodexRootFull = if ($AntiCodexProfileRoot) {
    [IO.Path]::GetFullPath($AntiCodexProfileRoot)
} else {
    [IO.Path]::GetFullPath((Join-Path $stateRootFull "antigravity-cli-account-b"))
}
$mcpRootFull = if ($McpProfileRoot) {
    [IO.Path]::GetFullPath($McpProfileRoot)
} else {
    [IO.Path]::GetFullPath((Join-Path $stateRootFull "antigravity-cli-mcp-account"))
}
$usesDefaultAntigravityProfile = $false

try {
    foreach ($root in @($antiCodexRootFull, $mcpRootFull)) {
        if (-not $root) { Add-Failure "profileRoot is required for both Antigravity CLI account lanes" }
        foreach ($defaultRoot in (Get-KnownDefaultAntigravityProfileRoots)) {
            if ($root -and (Test-IsDefaultAntigravityProfilePath -ProfileRoot $root -DefaultRoot $defaultRoot)) {
                $usesDefaultAntigravityProfile = $true
                Add-Failure "profileRoot matches or nests under a known default Antigravity profile location"
                break
            }
        }
    }
    if ((Normalize-Path $antiCodexRootFull) -ieq (Normalize-Path $mcpRootFull)) {
        Add-Failure "Anti-Codex and MCP Antigravity CLI profile roots must be different"
    }
    if (Test-IsPathNestedOrSame -Child $antiCodexRootFull -Parent $mcpRootFull) {
        Add-Failure "Anti-Codex Antigravity CLI profile root must not nest under the MCP profile root"
    }
    if (Test-IsPathNestedOrSame -Child $mcpRootFull -Parent $antiCodexRootFull) {
        Add-Failure "MCP Antigravity CLI profile root must not nest under the Anti-Codex profile root"
    }

    $antiCodexLane = $null
    $mcpLane = $null
    if ($failures.Count -eq 0) {
        $antiCodexLane = New-LaneEvidence -Role "anticodex-model-text" -ProfileRoot $antiCodexRootFull -ManagedByAntiCodex $true
        $mcpLane = New-LaneEvidence -Role "external-mcp-antigravity-account" -ProfileRoot $mcpRootFull -ManagedByAntiCodex $false
        if ((Normalize-Path $antiCodexLane.directories.appData) -ieq (Normalize-Path $mcpLane.directories.appData)) { Add-Failure "Antigravity CLI account lanes share APPDATA" }
        if ((Normalize-Path $antiCodexLane.directories.localAppData) -ieq (Normalize-Path $mcpLane.directories.localAppData)) { Add-Failure "Antigravity CLI account lanes share LOCALAPPDATA" }
        if ((Normalize-Path $antiCodexLane.directories.geminiDir) -ieq (Normalize-Path $mcpLane.directories.geminiDir)) { Add-Failure "Antigravity CLI account lanes share GEMINI_DIR" }
    }

    $elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
    if ($elapsedMs -gt ($TimeoutSec * 1000)) { Add-Failure "dual-account lane verifier exceeded TimeoutSec budget" }
    $comparison = [ordered]@{
        profileRootsDifferent = ((Normalize-Path $antiCodexRootFull) -ine (Normalize-Path $mcpRootFull))
        profileRootsNested = ((Test-IsPathNestedOrSame -Child $antiCodexRootFull -Parent $mcpRootFull) -or (Test-IsPathNestedOrSame -Child $mcpRootFull -Parent $antiCodexRootFull))
        appDataDifferent = ($antiCodexLane -and $mcpLane -and ((Normalize-Path $antiCodexLane.directories.appData) -ine (Normalize-Path $mcpLane.directories.appData)))
        localAppDataDifferent = ($antiCodexLane -and $mcpLane -and ((Normalize-Path $antiCodexLane.directories.localAppData) -ine (Normalize-Path $mcpLane.directories.localAppData)))
        geminiDirDifferent = ($antiCodexLane -and $mcpLane -and ((Normalize-Path $antiCodexLane.directories.geminiDir) -ine (Normalize-Path $mcpLane.directories.geminiDir)))
        neitherUsesDefaultAntigravityProfile = (-not $usesDefaultAntigravityProfile)
    }
    $report = [ordered]@{
        ok = ($failures.Count -eq 0)
        reportName = "antigravity-cli-dual-account-lanes"
        noTraffic = $true
        usedRealTraffic = $false
        loginVerified = $false
        separateAccountVerified = $false
        behaviorCovered = ($failures.Count -eq 0)
        coverageKind = if ($failures.Count -eq 0) { "dual-account-lanes-prepared-no-traffic" } else { "dual-account-lanes-failed" }
        elapsedMs = $elapsedMs
        stateRoot = $stateRootFull
        reportRoot = $reportRootFull
        accountLaneRole = "dual-antigravity-cli-account-lanes"
        accountIsolationBoundary = "separate-profile-home-gemini-and-appdata"
        accountIsolationCaveat = "This verifies two isolated CLI file/AppData lanes only. It does not prove login, account identity, or Windows credential-store separation."
        antiCodexLane = $antiCodexLane
        mcpLane = $mcpLane
        laneComparison = $comparison
        nextSteps = @(
            "Sign in the Anti-Codex model-text Antigravity CLI lane only through its isolated helper/profile.",
            "Sign in the MCP Antigravity account through the external MCP lane, outside Anti-Codex ownership.",
            "Run explicitly approved real traffic and account identity comparison before setting separateAccountVerified:true."
        )
        failures = $failures.ToArray()
    }
    Write-Report -Report $report
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Add-Failure $_.Exception.Message
    $report = [ordered]@{
        ok = $false
        reportName = "antigravity-cli-dual-account-lanes"
        noTraffic = $true
        usedRealTraffic = $false
        loginVerified = $false
        separateAccountVerified = $false
        behaviorCovered = $false
        coverageKind = "dual-account-lanes-failed"
        accountLaneRole = "dual-antigravity-cli-account-lanes"
        accountIsolationBoundary = "separate-profile-home-gemini-and-appdata"
        accountIsolationCaveat = "Failure path did not prove account identity or Windows credential-store separation."
        failures = $failures.ToArray()
    }
    Write-Report -Report $report
    exit 1
}
