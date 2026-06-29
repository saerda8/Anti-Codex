#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$StateRoot = "",
    [string]$ReportRoot = "",
    [string]$ProfileRoot = "",
    [switch]$NoSaveProfile,
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

function Write-Report {
    param([hashtable]$Report)
    $reportRootFull = Resolve-ReportRoot
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
    $json = $Report | ConvertTo-Json -Depth 20
    Write-AntiCodexJsonReport `
        -LatestPath (Join-Path $reportRootFull "latest-antigravity-cli-profile-prepare.json") `
        -HistoryPath (Join-Path $reportRootFull ("{0}-antigravity-cli-profile-prepare.json" -f ([DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")))) `
        -Json $json
    $Report | ConvertTo-Json -Depth 20 -Compress
}

function Write-IsolatedCliHelper {
    param(
        [string]$Path,
        [string]$ProfileRootFull
    )
    $escapedProfile = $ProfileRootFull.Replace("'", "''")
    $helper = @"
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = `$true)]
    [string[]]`$CliArgs
)

`$ErrorActionPreference = "Stop"
`$profileRoot = '$escapedProfile'
`$env:ANTICODEX_ANTIGRAVITY_CLI_PROFILE_ROOT = `$profileRoot
`$env:ANTICODEX_ANTIGRAVITY_CLI_ISOLATE_WINDOWS_APPDATA = "1"
`$env:ANTIGRAVITY_PROFILE = `$profileRoot
`$env:HOME = `$profileRoot
`$env:USERPROFILE = `$profileRoot
`$env:GEMINI_DIR = Join-Path `$profileRoot ".gemini"
`$env:ANTIGRAVITY_CLI_CONVERSATIONS_DIR = Join-Path `$env:GEMINI_DIR "antigravity-cli\conversations"
`$env:APPDATA = Join-Path `$profileRoot "AppData\Roaming"
`$env:LOCALAPPDATA = Join-Path `$profileRoot "AppData\Local"
`$cli = if (`$env:ANTIGRAVITY_CLI_BIN) { `$env:ANTIGRAVITY_CLI_BIN } else { "antigravity.exe" }
if (-not `$CliArgs -or `$CliArgs.Count -eq 0) {
    [pscustomobject]@{
        ok = `$true
        profileRoot = `$profileRoot
        cli = `$cli
        note = "Pass Antigravity CLI arguments after this script to run them inside the isolated profile."
    } | ConvertTo-Json -Compress
    exit 0
}
& `$cli @CliArgs
exit `$LASTEXITCODE
"@
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $helper, $encoding)
}

$stateRootFull = Resolve-StateRoot
$reportRootFull = Resolve-ReportRoot
$profileRootFull = if ($ProfileRoot) {
    [IO.Path]::GetFullPath($ProfileRoot)
} else {
    [IO.Path]::GetFullPath((Join-Path $stateRootFull "antigravity-cli-account-b"))
}

try {
    if (-not $profileRootFull) {
        Add-Failure "ProfileRoot is required"
    }
    foreach ($defaultRoot in (Get-KnownDefaultAntigravityProfileRoots)) {
        if ($profileRootFull -and $profileRootFull -eq $defaultRoot) {
            Add-Failure "profileRoot matches a known default Antigravity profile location"
            break
        }
    }

    $geminiDir = Join-Path $profileRootFull ".gemini"
    $conversationsDir = Join-Path $geminiDir "antigravity-cli\conversations"
    $appDataDir = Join-Path $profileRootFull "AppData\Roaming"
    $localAppDataDir = Join-Path $profileRootFull "AppData\Local"
    $helperPath = Join-Path $profileRootFull "Invoke-AntigravityCli-Isolated.ps1"

    if ($failures.Count -eq 0) {
        foreach ($dir in @($profileRootFull, $geminiDir, $conversationsDir, $appDataDir, $localAppDataDir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        Write-IsolatedCliHelper -Path $helperPath -ProfileRootFull $profileRootFull

        if (-not $NoSaveProfile) {
            $profileScript = Join-Path $PSScriptRoot "anticodex-upstream-profile.ps1"
            $output = & $profileScript `
                -Action SaveAntigravity `
                -StateRoot $stateRootFull `
                -AntigravityCliProfileRoot $profileRootFull `
                -AntigravityCliStrictWindowsAppDataIsolation "true"
            if (-not $?) { Add-Failure "failed to save Anti-Codex upstream profile" }
            $saved = if ($output) { (($output -join [Environment]::NewLine) | ConvertFrom-Json) } else { $null }
            if ($saved -and [string]$saved.antigravityCli.profileRoot -ne $profileRootFull) {
                Add-Failure "saved profileRoot mismatch"
            }
            if ($saved -and $saved.antigravityCli.strictWindowsAppDataIsolation -ne $true) {
                Add-Failure "saved strict Windows AppData isolation mismatch"
            }
        }
    }

    $elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
    if ($elapsedMs -gt ($TimeoutSec * 1000)) { Add-Failure "prepare exceeded TimeoutSec budget" }
    $realSmokeCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-anticodex-antigravity-cli-real-smoke.ps1 -AllowRealTraffic -ProfileRoot `"$profileRootFull`" -StrictWindowsAppDataIsolation"
    $helperCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$helperPath`""
    $report = [ordered]@{
        ok = ($failures.Count -eq 0)
        reportName = "antigravity-cli-profile-prepare"
        noTraffic = $true
        usedRealTraffic = $false
        loginVerified = $false
        loginVerificationReason = "profile prepared only; run the helper command and real smoke after signing in the isolated CLI account"
        separateAccountVerified = $false
        accountLaneRole = "anticodex-model-text"
        mcpAccountLaneManagedByAntiCodex = $false
        mcpAccountLaneOwner = "external-antigravity-account-not-managed-here"
        accountIsolationBoundary = "profile-and-appdata-only"
        accountIsolationCaveat = "This prepares isolated CLI files and AppData paths only; if Antigravity CLI uses the shared Windows credential store, a real smoke can still use the currently signed-in Windows credential."
        behaviorCovered = ($failures.Count -eq 0)
        coverageKind = if ($failures.Count -eq 0) { "profile-prepared-no-traffic" } else { "profile-prepare-failed" }
        elapsedMs = $elapsedMs
        stateRoot = $stateRootFull
        profileRoot = $profileRootFull
        strictWindowsAppDataIsolation = $true
        savedToUpstreamProfile = (-not $NoSaveProfile -and $failures.Count -eq 0)
        helperScript = $helperPath
        helperCommand = $helperCommand
        realSmokeCommand = $realSmokeCommand
        nextSteps = @(
            "Run the helper command with Antigravity CLI login or first-run arguments for the second account.",
            "After login, run realSmokeCommand to verify model traffic from this isolated CLI file profile.",
            "Compare the visible Antigravity account identity separately before treating this as a second-account proof.",
            "Keep MCP-side Antigravity account setup outside this Anti-Codex profile-prepare report.",
            "Do not use Antigravity Desktop or coworker for this profile verification."
        )
        directories = [ordered]@{
            geminiDir = $geminiDir
            conversationsDir = $conversationsDir
            appData = $appDataDir
            localAppData = $localAppDataDir
        }
        isolationEnv = [ordered]@{
            ANTIGRAVITY_PROFILE = $profileRootFull
            HOME = $profileRootFull
            USERPROFILE = $profileRootFull
            GEMINI_DIR = $geminiDir
            ANTIGRAVITY_CLI_CONVERSATIONS_DIR = $conversationsDir
            APPDATA = $appDataDir
            LOCALAPPDATA = $localAppDataDir
        }
        failures = $failures.ToArray()
    }
    Write-Report -Report $report
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Add-Failure $_.Exception.Message
    $report = [ordered]@{
        ok = $false
        reportName = "antigravity-cli-profile-prepare"
        noTraffic = $true
        usedRealTraffic = $false
        loginVerified = $false
        accountLaneRole = "anticodex-model-text"
        mcpAccountLaneManagedByAntiCodex = $false
        mcpAccountLaneOwner = "external-antigravity-account-not-managed-here"
        behaviorCovered = $false
        coverageKind = "profile-prepare-failed"
        elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
        profileRoot = $profileRootFull
        failures = $failures.ToArray()
    }
    Write-Report -Report $report
    exit 1
}
