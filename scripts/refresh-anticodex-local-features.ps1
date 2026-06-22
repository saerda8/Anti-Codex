#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$StateRoot = $(if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }),
    [string]$CodexHome = $(if ($env:CODEX_HOME_DIR) { $env:CODEX_HOME_DIR } else { Join-Path $StateRoot "codex-home-deepseek-app" }),
    [string]$SharedCodexHome = $(if ($env:GLOBAL_CODEX_HOME) { $env:GLOBAL_CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }),
    [string]$ReportRoot = $(Join-Path $StateRoot "reports"),
    [string]$NodeBin = $(if ($env:NODE_BIN) { $env:NODE_BIN } else { "" })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
$root = Split-Path -Parent $scriptRoot
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
    [System.IO.File]::WriteAllText($Paths.latest, $json, $utf8NoBom)
    [System.IO.File]::WriteAllText($Paths.history, $json, $utf8NoBom)
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

function Get-LinkTargetValue {
    param($Item)
    if (-not $Item) { return @() }
    $isLink = [bool]($Item.LinkType -or (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0))
    if (-not $isLink) { return @() }
    return @($Item.Target | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
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
if (-not $resolvedNode) {
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
        $pluginSummary = Invoke-NodeJson $pluginHostSync @($CodexHome, $SharedCodexHome, "--local-snapshots")
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
    $mcpNames = @([regex]::Matches($configText, "\[mcp_servers\.([^\]]+)\]") |
        ForEach-Object { $_.Groups[1].Value } |
        Where-Object { $_ -notmatch "\.env$" })
}
if ($mcpNames.Count -lt 1) { Add-Failure "no MCP servers found in Anti-Codex config" }
if ($mcpNames -notcontains "node_repl") { Add-Failure "node_repl MCP server missing in Anti-Codex config" }

$skills = Get-DirectoryInfo (Join-Path $CodexHome "skills")
$connectors = Get-DirectoryInfo (Join-Path $CodexHome "cache\codex_app_directory")
$appTools = Get-DirectoryInfo (Join-Path $CodexHome "cache\codex_apps_tools")
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

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    reportName = "refresh-features"
    failures = $failures.ToArray()
    root = $root
    paths = [pscustomobject]@{
        codexHome = $CodexHome
        sharedCodexHome = $SharedCodexHome
        configToml = $configPath
    }
    node = $resolvedNode
    configSync = $configSyncSummary
    snapshots = if ($pluginSummary) { $pluginSummary.summary } else { @() }
    sidecars = if ($sidecarSummary) { $sidecarSummary } else { "" }
    mcp = [pscustomobject]@{
        count = $mcpNames.Count
        names = $mcpNames
        hasNodeRepl = ($mcpNames -contains "node_repl")
    }
    skills = $skills
    guidance = $guidance
    connectors = $connectors
    appTools = $appTools
}

$reportPaths = New-ReportPaths "refresh-features"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
Save-JsonReport $reportPaths $result -Depth 10
$result | ConvertTo-Json -Depth 8 -Compress
if ($failures.Count -gt 0) { exit 1 }
