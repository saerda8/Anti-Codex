#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$StateRoot = "",
    [string]$ReportRoot = "",
    [string]$ProfileRoot = "",
    [int]$TimeoutSec = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Resolve-DefaultStateRoot {
    if ($StateRoot) { return [IO.Path]::GetFullPath($StateRoot) }
    return [IO.Path]::GetFullPath((Join-Path $env:TEMP ("anticodex-cli-isolation-" + [Guid]::NewGuid().ToString("N"))))
}

function Resolve-DefaultReportRoot {
    if ($ReportRoot) { return [IO.Path]::GetFullPath($ReportRoot) }
    if ($env:ANTICODEX_REPORT_ROOT) { return [IO.Path]::GetFullPath($env:ANTICODEX_REPORT_ROOT) }
    return [IO.Path]::GetFullPath((Join-Path $env:APPDATA "anticodex\reports"))
}

function Invoke-ProfileJson {
    param([hashtable]$Parameters)
    $scriptPath = Join-Path $PSScriptRoot "anticodex-upstream-profile.ps1"
    $output = & $scriptPath @Parameters
    return (($output -join [Environment]::NewLine) | ConvertFrom-Json)
}

function Invoke-NodeJson {
    param([string]$Script)
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $output = & $node "--input-type=module" "-e" $Script
    if ($LASTEXITCODE -ne 0) { throw "node verifier exited with $LASTEXITCODE" }
    return (($output -join [Environment]::NewLine) | ConvertFrom-Json)
}

function ConvertTo-JsStringLiteral {
    param([string]$Value)
    $escaped = $Value.Replace("\", "\\").Replace("'", "\'").Replace("`r", "\r").Replace("`n", "\n")
    return "'$escaped'"
}

$stateRootFull = Resolve-DefaultStateRoot
$reportRootFull = Resolve-DefaultReportRoot
$profileRootFull = if ($ProfileRoot) {
    [IO.Path]::GetFullPath($ProfileRoot)
} else {
    [IO.Path]::GetFullPath((Join-Path $stateRootFull "antigravity-cli-account-b"))
}
$createdTempState = -not $StateRoot

try {
    New-Item -ItemType Directory -Path $stateRootFull -Force | Out-Null
    New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null

    $saved = Invoke-ProfileJson -Parameters @{
        Action = "SaveAntigravity"
        StateRoot = $stateRootFull
        AntigravityCliProfileRoot = $profileRootFull
        AntigravityCliStrictWindowsAppDataIsolation = "true"
    }
    $runtime = Invoke-ProfileJson -Parameters @{ Action = "GetRuntime"; StateRoot = $stateRootFull }

    if ($saved.mode -ne "antigravity") { Add-Failure "SaveAntigravity did not keep Antigravity mode" }
    if ([string]$saved.antigravityCli.profileRoot -ne $profileRootFull) { Add-Failure "saved Antigravity CLI profileRoot mismatch" }
    if ($saved.antigravityCli.strictWindowsAppDataIsolation -ne $true) { Add-Failure "saved strict Windows AppData isolation is not true" }
    if ([string]$runtime.antigravityCli.profileRoot -ne $profileRootFull) { Add-Failure "runtime Antigravity CLI profileRoot mismatch" }
    if ($runtime.antigravityCli.strictWindowsAppDataIsolation -ne $true) { Add-Failure "runtime strict Windows AppData isolation is not true" }

    $modulePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\translator\antigravity-agentapi.mjs"))
    $rootLiteral = ConvertTo-JsStringLiteral $profileRootFull
    $moduleLiteral = ConvertTo-JsStringLiteral $modulePath
    $nodeScript = @"
import { pathToFileURL } from 'node:url';
const profileRoot = $rootLiteral;
const modulePath = $moduleLiteral;
const { antigravityCliIsolationEnv } = await import(pathToFileURL(modulePath).href);
const env = antigravityCliIsolationEnv({
  ANTICODEX_ANTIGRAVITY_CLI_PROFILE_ROOT: profileRoot,
  ANTICODEX_ANTIGRAVITY_CLI_ISOLATE_WINDOWS_APPDATA: '1',
});
console.log(JSON.stringify(env));
"@
    $derived = Invoke-NodeJson -Script $nodeScript
    $expectedGemini = Join-Path $profileRootFull ".gemini"
    $expectedConversations = Join-Path $expectedGemini "antigravity-cli\conversations"
    $expectedAppData = Join-Path $profileRootFull "AppData\Roaming"
    $expectedLocalAppData = Join-Path $profileRootFull "AppData\Local"

    if ([string]$derived.HOME -ne $profileRootFull) { Add-Failure "derived HOME mismatch" }
    if ([string]$derived.USERPROFILE -ne $profileRootFull) { Add-Failure "derived USERPROFILE mismatch" }
    if ([string]$derived.GEMINI_DIR -ne $expectedGemini) { Add-Failure "derived GEMINI_DIR mismatch" }
    if ([string]$derived.ANTIGRAVITY_CLI_CONVERSATIONS_DIR -ne $expectedConversations) { Add-Failure "derived conversations dir mismatch" }
    if ([string]$derived.APPDATA -ne $expectedAppData) { Add-Failure "derived APPDATA mismatch" }
    if ([string]$derived.LOCALAPPDATA -ne $expectedLocalAppData) { Add-Failure "derived LOCALAPPDATA mismatch" }

    $profileJson = Get-Content -LiteralPath (Join-Path $stateRootFull "upstream-profile.json") -Raw -Encoding UTF8
    if ($profileJson -match "(?i)api[_-]?key|token|secret|credential") {
        Add-Failure "Antigravity CLI isolation profile contains credential-looking fields"
    }

    $elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
    if ($elapsedMs -gt ($TimeoutSec * 1000)) { Add-Failure "verifier exceeded TimeoutSec budget" }

    $result = [ordered]@{
        ok = ($failures.Count -eq 0)
        reportName = "antigravity-cli-isolation"
        elapsedMs = $elapsedMs
        usedRealTraffic = $false
        loginVerified = $false
        loginVerificationReason = "profile-and-environment verifier only; does not launch Antigravity CLI or claim account authorization"
        stateRoot = $stateRootFull
        profileRoot = $profileRootFull
        strictWindowsAppDataIsolation = $true
        expected = [ordered]@{
            geminiDir = $expectedGemini
            conversationsDir = $expectedConversations
            appData = $expectedAppData
            localAppData = $expectedLocalAppData
        }
        derived = $derived
        saved = [ordered]@{
            mode = [string]$saved.mode
            profileRoot = [string]$saved.antigravityCli.profileRoot
            strictWindowsAppDataIsolation = [bool]$saved.antigravityCli.strictWindowsAppDataIsolation
        }
        failures = $failures.ToArray()
    }

    $json = $result | ConvertTo-Json -Depth 20
    $latestPath = Join-Path $reportRootFull "latest-antigravity-cli-isolation.json"
    $historyPath = Join-Path $reportRootFull ("{0}-antigravity-cli-isolation.json" -f ([DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")))
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($latestPath, $json, $utf8NoBom)
    [System.IO.File]::WriteAllText($historyPath, $json, $utf8NoBom)
    $result | ConvertTo-Json -Depth 20 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Add-Failure $_.Exception.Message
    $result = [ordered]@{
        ok = $false
        reportName = "antigravity-cli-isolation"
        elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
        usedRealTraffic = $false
        loginVerified = $false
        failures = $failures.ToArray()
    }
    $result | ConvertTo-Json -Depth 20 -Compress
    exit 1
} finally {
    if ($createdTempState -and $stateRootFull -like (Join-Path $env:TEMP "anticodex-cli-isolation-*")) {
        Remove-Item -LiteralPath $stateRootFull -Recurse -Force -ErrorAction SilentlyContinue
    }
}
