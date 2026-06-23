#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$StateRoot = $(if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }),
    [string]$CodexHome = $(if ($env:CODEX_HOME_DIR) { $env:CODEX_HOME_DIR } else { Join-Path $StateRoot "codex-home-deepseek-app" }),
    [string]$SharedCodexHome = $(if ($env:GLOBAL_CODEX_HOME) { $env:GLOBAL_CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }),
    [string]$AgentsSkillsPath = $(if ($env:ANTICODEX_AGENTS_SKILLS_PATH) { $env:ANTICODEX_AGENTS_SKILLS_PATH } else { Join-Path $env:USERPROFILE ".agents\skills" }),
    [string]$ReportRoot = $(Join-Path $StateRoot "reports"),
    [string]$NodeBin = $(if ($env:NODE_BIN) { $env:NODE_BIN } else { "" }),
    [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
$root = Split-Path -Parent $scriptRoot
. (Join-Path $PSScriptRoot "anticodex-source-snapshot.ps1")
$sharedConfigSync = Join-Path $scriptRoot "sync-shared-codex-config.mjs"
$pluginHostSync = Join-Path $scriptRoot "sync-shared-codex-plugin-host.mjs"
$sidecarsSync = Join-Path $scriptRoot "sync-shared-codex-sidecars.mjs"
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function New-ReportPaths {
    param([string]$Name)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    return [pscustomobject]@{
        latest = (Join-Path $ReportRoot "latest-$Name.json")
        history = (Join-Path $ReportRoot "$stamp-$Name.json")
    }
}

function Save-JsonReport {
    param($Paths, $Payload, [int]$Depth = 12)
    $json = $Payload | ConvertTo-Json -Depth $Depth -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $Paths.latest -HistoryPath $Paths.history -Json $json -Encoding $utf8NoBom
}

function Resolve-NodeBin {
    if ($NodeBin -and (Test-Path -LiteralPath $NodeBin -PathType Leaf)) { return $NodeBin }
    $found = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $codexBinRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    if (Test-Path -LiteralPath $codexBinRoot -PathType Container) {
        $candidate = Get-ChildItem -LiteralPath $codexBinRoot -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    return ""
}

function Invoke-NodeJson {
    param([string]$ScriptPath, [string[]]$Arguments)
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { throw "Missing script: $ScriptPath" }
    $output = & $resolvedNode $ScriptPath @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($output | Out-String).Trim()) }
    $text = ($output | Out-String).Trim()
    if (-not $text) { return $null }
    return $text | ConvertFrom-Json
}

function Invoke-NodeText {
    param([string]$ScriptPath, [string[]]$Arguments)
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { throw "Missing script: $ScriptPath" }
    $output = & $resolvedNode $ScriptPath @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($output | Out-String).Trim()) }
    return ($output | Out-String).Trim()
}

function Get-McpServerNamesFromToml {
    param([string]$Text)
    if (-not $Text) { return @() }
    return @([regex]::Matches($Text, "(?m)^\s*\[mcp_servers\.([^\]]+)\]") |
        ForEach-Object { $_.Groups[1].Value } |
        Where-Object { $_ -notmatch "\.env$" -and $_ -notmatch "\.tools\." } |
        Sort-Object -Unique)
}

function Get-LinkTargetValue {
    param($Item)
    if (-not $Item) { return @() }
    $isLink = [bool]($Item.LinkType -or (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0))
    if (-not $isLink) { return @() }
    return @($Item.Target | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
}

function Get-DirectoryContentFingerprint {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return "" }
    $rootPath = (Resolve-Path -LiteralPath $Path).Path.TrimEnd("\", "/")
    $entries = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction Stop |
        Where-Object { $_.Name -ne ".anticodex-source-manifest.json" } |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($rootPath.Length).TrimStart("\", "/")
            $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            "$relative`t$hash"
        })
    $joined = [string]::Join("`n", $entries)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-DirectoryInfo {
    param([string]$Path)
    $exists = Test-Path -LiteralPath $Path -PathType Container
    $item = if ($exists) { Get-Item -LiteralPath $Path -Force } else { $null }
    $count = 0
    if ($exists) {
        $count = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | Select-Object -First 500).Count
    }
    return [pscustomobject]@{
        exists = $exists
        count = $count
        linkType = if ($item) { $item.LinkType } else { $null }
        target = Get-LinkTargetValue $item
    }
}

function Get-FileInfo {
    param([string]$Path)
    $exists = Test-Path -LiteralPath $Path -PathType Leaf
    $item = if ($exists) { Get-Item -LiteralPath $Path -Force } else { $null }
    return [pscustomobject]@{
        exists = $exists
        linkType = if ($item) { $item.LinkType } else { $null }
        length = if ($item) { [long]$item.Length } else { 0 }
    }
}

function Set-FeatureFlag {
    param([string]$Text, [string]$Key, [string]$Value)
    $lines = New-Object System.Collections.Generic.List[string]
    @($Text -split "`r?`n") | ForEach-Object { $lines.Add([string]$_) }
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq "[features]") {
            $start = $i
            break
        }
    }
    if ($start -lt 0) {
        if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim()) { $lines.Add("") }
        $lines.Add("[features]")
        $lines.Add("$Key = $Value")
        return ($lines -join "`n")
    }
    $end = $start + 1
    while ($end -lt $lines.Count -and $lines[$end] -notmatch "^\s*\[[^\]]+\]\s*$") { $end++ }
    $keyPattern = "^\s*$([regex]::Escape($Key))\s*="
    for ($i = $start + 1; $i -lt $end; $i++) {
        if ($lines[$i] -match $keyPattern) {
            $lines[$i] = "$Key = $Value"
            return ($lines -join "`n")
        }
    }
    $lines.Insert($end, "$Key = $Value")
    return ($lines -join "`n")
}

function Restore-AntiCodexFeatureFlags {
    param([string]$ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return }
    $text = Get-Content -LiteralPath $ConfigPath -Raw
    foreach ($flag in @(
        "responses_websockets",
        "responses_websockets_v2",
        "plugins",
        "plugin_sharing",
        "remote_plugin"
    )) {
        $text = Set-FeatureFlag $text $flag "false"
    }
    [IO.File]::WriteAllText($ConfigPath, ($text.TrimEnd() + "`n"), (New-Object Text.UTF8Encoding($false)))
}

New-Item -ItemType Directory -Path $CodexHome -Force | Out-Null
$resolvedNode = Resolve-NodeBin
$configSyncSummary = ""
$pluginSummary = $null
$sidecarSummary = ""
if ($VerifyOnly) {
    $configSyncSummary = "verify-only: skipped config copy"
    $pluginSummary = [pscustomobject]@{ ok = $true; summary = @([pscustomobject]@{ relPath = "verify-only"; mode = "skipped-copy" }) }
    $sidecarSummary = "verify-only: skipped sidecar copy"
} elseif (-not $resolvedNode) {
    Add-Failure "Node.js was not found."
} else {
    try {
        $sourceConfig = Join-Path $SharedCodexHome "config.toml"
        $targetConfig = Join-Path $CodexHome "config.toml"
        if (Test-Path -LiteralPath $sourceConfig -PathType Leaf) {
            $configSyncSummary = Invoke-NodeText $sharedConfigSync @($sourceConfig, $targetConfig)
        }
    } catch {
        Add-Failure "shared config refresh failed: $($_.Exception.Message)"
    }
    try {
        $previousExtraSkillsRoots = $env:ANTICODEX_EXTRA_SKILLS_ROOTS
        $env:ANTICODEX_EXTRA_SKILLS_ROOTS = $AgentsSkillsPath
        try {
            $pluginSummary = Invoke-NodeJson $pluginHostSync @($CodexHome, $SharedCodexHome, "--local-snapshots")
        } finally {
            if ($null -eq $previousExtraSkillsRoots) {
                Remove-Item Env:\ANTICODEX_EXTRA_SKILLS_ROOTS -ErrorAction SilentlyContinue
            } else {
                $env:ANTICODEX_EXTRA_SKILLS_ROOTS = $previousExtraSkillsRoots
            }
        }
        if ($pluginSummary -and $pluginSummary.ok -ne $true) { Add-Failure "local snapshot refresh reported failure" }
    } catch {
        Add-Failure "local snapshot refresh failed: $($_.Exception.Message)"
    }
    try {
        $sidecarSummary = Invoke-NodeText $sidecarsSync @($SharedCodexHome, $CodexHome)
    } catch {
        Add-Failure "sidecar refresh failed: $($_.Exception.Message)"
    }
}

$configPath = Join-Path $CodexHome "config.toml"
try {
    Restore-AntiCodexFeatureFlags $configPath
} catch {
    Add-Failure "Anti-Codex feature flag restore failed: $($_.Exception.Message)"
}
$configText = ""
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $configText = Get-Content -LiteralPath $configPath -Raw
} else {
    Add-Failure "config.toml missing after refresh"
}

$mcpNames = @()
if ($configText) {
    $mcpNames = @(Get-McpServerNamesFromToml $configText)
}
if ($mcpNames.Count -lt 1) { Add-Failure "no MCP servers found in Anti-Codex config" }
if ($mcpNames -notcontains "node_repl") { Add-Failure "node_repl MCP server missing in Anti-Codex config" }

$skills = Get-DirectoryInfo (Join-Path $CodexHome "skills")
$sharedSkillsPath = Join-Path $SharedCodexHome "skills"
$sharedSkillNames = @()
$agentsSkillNames = @()
if (Test-Path -LiteralPath $sharedSkillsPath -PathType Container) {
    $sharedSkillNames = @(Get-ChildItem -LiteralPath $sharedSkillsPath -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object -Unique)
}
if (Test-Path -LiteralPath $AgentsSkillsPath -PathType Container) {
    $agentsSkillNames = @(Get-ChildItem -LiteralPath $AgentsSkillsPath -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object -Unique)
}
$expectedSkillNames = @($sharedSkillNames + $agentsSkillNames) | Sort-Object -Unique
$localSkillNames = @()
if (Test-Path -LiteralPath (Join-Path $CodexHome "skills") -PathType Container) {
    $localSkillNames = @(Get-ChildItem -LiteralPath (Join-Path $CodexHome "skills") -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object -Unique)
}
$missingExpectedSkillNames = @($expectedSkillNames | Where-Object { $localSkillNames -notcontains $_ })
foreach ($skillName in $missingExpectedSkillNames) {
    Add-Failure "shared or agent skill '$skillName' exists but Anti-Codex local skills copy is missing it"
}
$connectors = Get-DirectoryInfo (Join-Path $CodexHome "cache\codex_app_directory")
$appTools = Get-DirectoryInfo (Join-Path $CodexHome "cache\codex_apps_tools")
$sharedConnectorDirectoryPath = Join-Path $SharedCodexHome "cache\codex_app_directory"
$sharedAppToolsCachePath = Join-Path $SharedCodexHome "cache\codex_apps_tools"
$connectorParity = [pscustomobject]@{
    sharedExists = Test-Path -LiteralPath $sharedConnectorDirectoryPath -PathType Container
    localExists = Test-Path -LiteralPath (Join-Path $CodexHome "cache\codex_app_directory") -PathType Container
    sharedFingerprint = ""
    localFingerprint = ""
    contentMatches = $null
}
$appToolParity = [pscustomobject]@{
    sharedExists = Test-Path -LiteralPath $sharedAppToolsCachePath -PathType Container
    localExists = Test-Path -LiteralPath (Join-Path $CodexHome "cache\codex_apps_tools") -PathType Container
    sharedFingerprint = ""
    localFingerprint = ""
    contentMatches = $null
}
if ($connectorParity.sharedExists) {
    $connectorParity.sharedFingerprint = Get-DirectoryContentFingerprint $sharedConnectorDirectoryPath
    if ($connectorParity.localExists) {
        $connectorParity.localFingerprint = Get-DirectoryContentFingerprint (Join-Path $CodexHome "cache\codex_app_directory")
        $connectorParity.contentMatches = ($connectorParity.sharedFingerprint -eq $connectorParity.localFingerprint)
        if ($connectorParity.contentMatches -ne $true) { Add-Failure "connector directory local snapshot differs from shared source after refresh" }
    } else {
        $connectorParity.contentMatches = $false
        Add-Failure "connector directory shared source exists but local snapshot is missing after refresh"
    }
}
if ($appToolParity.sharedExists) {
    $appToolParity.sharedFingerprint = Get-DirectoryContentFingerprint $sharedAppToolsCachePath
    if ($appToolParity.localExists) {
        $appToolParity.localFingerprint = Get-DirectoryContentFingerprint (Join-Path $CodexHome "cache\codex_apps_tools")
        $appToolParity.contentMatches = ($appToolParity.sharedFingerprint -eq $appToolParity.localFingerprint)
        if ($appToolParity.contentMatches -ne $true) { Add-Failure "app-tools cache local snapshot differs from shared source after refresh" }
    } else {
        $appToolParity.contentMatches = $false
        Add-Failure "app-tools cache shared source exists but local snapshot is missing after refresh"
    }
}
$guidance = [ordered]@{}
foreach ($name in @("AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md")) {
    $info = Get-FileInfo (Join-Path $CodexHome $name)
    $guidance[$name] = $info
    $sharedPath = Join-Path $SharedCodexHome $name
    if ((Test-Path -LiteralPath $sharedPath -PathType Leaf) -and -not $info.exists) {
        Add-Failure "shared guidance '$name' exists but Anti-Codex local copy is missing"
    } elseif ($info.linkType) {
        Add-Failure "Anti-Codex guidance '$name' is a link, expected local copy"
    }
}
if (-not $skills.exists -or $skills.count -lt 1) { Add-Failure "skills local copy is empty or missing" }
if ($skills.linkType) { Add-Failure "skills path is a link, expected local copy" }
$sourceSnapshot = Get-AntiCodexSourceSnapshot -SharedCodexHome $SharedCodexHome -AgentsSkillsPath $AgentsSkillsPath

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    reportName = "refresh-features"
    verifyOnly = [bool]$VerifyOnly
    failures = $failures.ToArray()
    root = $root
    paths = [pscustomobject]@{
        codexHome = $CodexHome
        sharedCodexHome = $SharedCodexHome
        agentsSkillsPath = $AgentsSkillsPath
        configToml = $configPath
    }
    node = $resolvedNode
    configSync = $configSyncSummary
    snapshots = if ($pluginSummary) { $pluginSummary.summary } else { @() }
    sidecars = if ($sidecarSummary) { $sidecarSummary } else { "" }
    sourceSnapshot = $sourceSnapshot
    mcp = [pscustomobject]@{
        count = $mcpNames.Count
        names = $mcpNames
        hasNodeRepl = ($mcpNames -contains "node_repl")
    }
    skills = [pscustomobject]@{
        exists = $skills.exists
        count = $skills.count
        linkType = $skills.linkType
        target = $skills.target
        sharedCount = $sharedSkillNames.Count
        agentsCount = $agentsSkillNames.Count
        expectedCount = $expectedSkillNames.Count
        missingExpected = $missingExpectedSkillNames
    }
    guidance = $guidance
    connectors = $connectors
    appTools = $appTools
    connectorParity = $connectorParity
    appToolParity = $appToolParity
}

$reportPaths = New-ReportPaths "refresh-features"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
Save-JsonReport $reportPaths $result -Depth 10
$result | ConvertTo-Json -Depth 8 -Compress
if ($failures.Count -gt 0) { exit 1 }
