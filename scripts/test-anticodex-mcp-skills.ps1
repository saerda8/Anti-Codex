[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$InstallRoot = $(if ($env:DEEPCODEX_INSTALL_ROOT) { $env:DEEPCODEX_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Anti-Codex" }),
    [string]$StateRoot = $(if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }),
    [string]$ReportRoot = $(Join-Path $StateRoot "reports"),
    [string]$CodexHome = $(if ($env:CODEX_HOME_DIR) { $env:CODEX_HOME_DIR } else { Join-Path $StateRoot "codex-home-deepseek-app" }),
    [string]$SharedCodexHome = $(if ($env:DEEPCODEX_SHARED_CODEX_HOME) { $env:DEEPCODEX_SHARED_CODEX_HOME } elseif ($env:GLOBAL_CODEX_HOME) { $env:GLOBAL_CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }),
    [string]$AgentsSkillsPath = $(if ($env:ANTICODEX_AGENTS_SKILLS_PATH) { $env:ANTICODEX_AGENTS_SKILLS_PATH } else { Join-Path $env:USERPROFILE ".agents\skills" }),
    [int]$TimeoutSec = 8
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "anticodex-source-snapshot.ps1")

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

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

function Invoke-LocalJson {
    param([string]$Path)
    return Invoke-LocalJsonWithRetry -Path $Path -Method Get
}

function Invoke-LocalJsonPost {
    param([string]$Path)
    return Invoke-LocalJsonWithRetry -Path $Path -Method Post
}

function Invoke-LocalJsonWithRetry {
    param(
        [string]$Path,
        [ValidateSet("Get", "Post")]
        [string]$Method = "Get",
        [int]$MaxAttempts = 2
    )
    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $args = @{
                Uri = "$BaseUrl$Path"
                Proxy = $null
                TimeoutSec = $TimeoutSec
            }
            if ($Method -eq "Post") { $args.Method = "Post" }
            return Invoke-RestMethod @args
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -ge $MaxAttempts) {
                throw "$Path request failed on attempt $attempt of $MaxAttempts`: $lastError"
            }
            Start-Sleep -Milliseconds ([Math]::Min(1000, 250 * $attempt))
        }
    }
    throw "$Path request failed after $MaxAttempts attempts: $lastError"
}

function Invoke-AntiCodexHealth {
    return Invoke-LocalJson "/health"
}

function Get-ObjectCount {
    param($Value, [string]$PropertyName)
    if ($null -eq $Value) { return 0 }
    if ($PropertyName -and $Value.PSObject.Properties.Name -contains $PropertyName) {
        return @($Value.$PropertyName).Count
    }
    return @($Value).Count
}

function Test-FileSystemLink {
    param($Item)
    if (-not $Item) { return $false }
    return [bool]($Item.LinkType -or (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0))
}

function Get-LinkTargetValue {
    param($Item)
    if (-not (Test-FileSystemLink $Item)) { return @() }
    return @($Item.Target | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
}

function Select-LightFileSystemItem {
    param($Item)
    [pscustomobject]@{
        Name = [string]$Item.Name
        LinkType = if ($Item.LinkType) { [string]$Item.LinkType } else { $null }
        Target = Get-LinkTargetValue $Item
    }
}

$configPath = Join-Path $CodexHome "config.toml"
$sharedConfigPath = Join-Path $SharedCodexHome "config.toml"
$skillsPath = Join-Path $CodexHome "skills"
$sharedSkillsPath = Join-Path $SharedCodexHome "skills"
$guidanceNames = @("AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md")
$guidanceChecks = @()
$connectorDirectoryPath = Join-Path $CodexHome "cache\codex_app_directory"
$appToolsCachePath = Join-Path $CodexHome "cache\codex_apps_tools"
$appToolsRegistryPath = Join-Path $CodexHome "cache\deepcodex_app_connectors.json"
$health = $null
$healthMode = "unknown"
$healthProtocol = $null
$healthModel = $null
$configText = ""
$skillEntries = @()
$skillSampleEntries = @()
$skillsItem = $null
$connectorDirectoryItem = $null
$connectorDirectoryEntries = @()
$appToolsCacheItem = $null
$appToolsCacheEntries = @()
$appToolsRegistry = $null
$pluginsInstalled = $null
$pluginsList = $null
$connectors = $null
$apps = $null
$expectedInheritedSkillNames = @("headroom", "context-save", "context-restore", "keep-codex-fast")
$inheritedSkillChecks = @()
$sharedSkillNames = @()
$agentsSkillNames = @()
$expectedSharedSkillNames = @()
$missingSharedSkillNames = @()
$extraLocalSkillNames = @()
$duplicateSkillNames = @()
$conflictingDuplicateSkillNames = @()
$changedSharedSkillNames = @()
$changedSharedSkillDetails = @()
$sharedMcpNames = @()
$missingSharedMcpNames = @()
$extraLocalMcpNames = @()
$changedSharedMcpNames = @()
$changedSharedMcpDetails = @()
$mcpSmokeChecks = @()
$mcpListSmokeChecks = @()
$directoryFingerprintCache = @{}
$mcpRealSmoke = [pscustomobject]@{
    checked = $false
    passed = $false
    server = "node_repl"
    tool = "js"
    markerObserved = $false
    toolCount = 0
    elapsedMs = 0
    error = ""
}
$skillSmoke = [pscustomobject]@{
    checked = $false
    skillName = "headroom"
    skillFile = ""
    readable = $false
    length = 0
}

function Resolve-McpCommand {
    param([string]$Command)
    if (-not $Command) { return $false }
    if ([IO.Path]::IsPathRooted($Command)) {
        return (Test-Path -LiteralPath $Command -PathType Leaf)
    }
    return $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Get-McpServerNamesFromToml {
    param([string]$Text)
    if (-not $Text) { return @() }
    return @([regex]::Matches($Text, "(?m)^\s*\[mcp_servers\.([^\]]+)\]") |
        ForEach-Object { $_.Groups[1].Value } |
        Where-Object { $_ -notmatch "\.env$" -and $_ -notmatch "\.tools\." } |
        Sort-Object -Unique)
}

function Get-McpSectionText {
    param([string]$Text, [string]$Name)
    if (-not $Text -or -not $Name) { return "" }
    $namePattern = [regex]::Escape($Name)
    $match = [regex]::Match($Text, "(?ms)^\s*\[mcp_servers\.$namePattern\]\s*(.*?)(?=^\s*\[|\z)")
    if ($match.Success) { return $match.Groups[1].Value }
    return ""
}

function Get-McpNestedSectionText {
    param([string]$Text, [string]$Name, [string]$Child)
    if (-not $Text -or -not $Name -or -not $Child) { return "" }
    $namePattern = [regex]::Escape($Name)
    $childPattern = [regex]::Escape($Child)
    $match = [regex]::Match($Text, "(?ms)^\s*\[mcp_servers\.$namePattern\.$childPattern\]\s*(.*?)(?=^\s*\[|\z)")
    if ($match.Success) { return $match.Groups[1].Value }
    return ""
}

function Get-TomlFieldRaw {
    param([string]$Section, [string]$Field)
    if (-not $Section -or -not $Field) { return "" }
    $fieldPattern = [regex]::Escape($Field)
    $match = [regex]::Match($Section, "(?m)^\s*$fieldPattern\s*=\s*(.+?)\s*$")
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return ""
}

function Get-TomlQuotedFieldValue {
    param([string]$Section, [string]$Field)
    $raw = Get-TomlFieldRaw $Section $Field
    $match = [regex]::Match($raw, "^\s*['""]([^'""]+)['""]\s*$")
    if ($match.Success) { return $match.Groups[1].Value }
    return $raw
}

function Normalize-McpCommandCompareValue {
    param([string]$Command)
    if (-not $Command) { return "" }
    if ([IO.Path]::IsPathRooted($Command)) {
        return (Split-Path -Leaf $Command).ToLowerInvariant()
    }
    return $Command.Trim().ToLowerInvariant()
}

function Normalize-TomlBodyForCompare {
    param([string]$Text)
    if (-not $Text) { return "" }
    return [string]::Join("`n", @($Text -split "`r?`n" |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith("#") } |
        Sort-Object))
}

function Normalize-McpEnvForCompare {
    param([string]$ServerName, [string]$Text)
    if (-not $Text) { return "" }
    $lines = @($Text -split "`r?`n" |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith("#") })
    if ($ServerName -eq "node_repl") {
        return [string]::Join("`n", @($lines |
            ForEach-Object {
                $match = [regex]::Match($_, "^\s*([^=\s]+)\s*=")
                if ($match.Success) { $match.Groups[1].Value } else { $_ }
            } |
            Sort-Object -Unique))
    }
    return [string]::Join("`n", @($lines | Sort-Object))
}

function Get-DirectoryContentFingerprint {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return "" }
    $root = (Resolve-Path -LiteralPath $Path).Path.TrimEnd("\", "/")
    if ($directoryFingerprintCache.ContainsKey($root)) { return $directoryFingerprintCache[$root] }
    $entries = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction Stop |
        Where-Object { $_.FullName -notmatch '(?i)[\\/]\.git(?:[\\/]|$)' } |
        Sort-Object FullName |
        ForEach-Object {
        $relative = $_.FullName.Substring($root.Length).TrimStart("\", "/")
        $hash = Get-FileSha256Hex $_.FullName
        "$relative`t$hash"
    })
    $joined = [string]::Join("`n", $entries)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
        $directoryFingerprintCache[$root] = $fingerprint
        return $fingerprint
    } finally {
        $sha.Dispose()
    }
}

function Get-FileSha256Hex {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

function Resolve-NodeRuntime {
    $bundled = Join-Path $InstallRoot "codex-patched-app\resources\cua_node\bin\node.exe"
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    $node = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($node) { return $node.Source }
    throw "node.exe not found"
}

function Invoke-RealNodeReplMcpSmoke {
    $scriptPath = Join-Path $PSScriptRoot "anticodex-real-mcp-smoke.mjs"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "real MCP smoke script missing: $scriptPath"
    }
    $node = Resolve-NodeRuntime
    $marker = "ANTICODEX_MCP_SKILLS_" + ([guid]::NewGuid().ToString("N").Substring(0, 12))
    $reportRoot = Join-Path $StateRoot "reports"
    $nodeArgs = @(
        $scriptPath,
        "--install-root", $InstallRoot,
        "--state-root", $StateRoot,
        "--server", "node_repl",
        "--timeout-ms", ([Math]::Max(3000, $TimeoutSec * 1000)),
        "--report-root", $reportRoot,
        "--marker", $marker
    )
    $output = & $node @nodeArgs 2>&1
    $exitCode = $LASTEXITCODE
    $text = @($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($exitCode -ne 0) {
        throw "real MCP smoke failed: $text"
    }
    $parsed = $text | ConvertFrom-Json
    if (-not $parsed.ok -or -not $parsed.markerObserved) {
        throw "real MCP smoke did not observe marker"
    }
    return $parsed
}

function Invoke-RealMcpListSmoke {
    param([string]$ServerName)
    $scriptPath = Join-Path $PSScriptRoot "anticodex-real-mcp-smoke.mjs"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "real MCP smoke script missing: $scriptPath"
    }
    $node = Resolve-NodeRuntime
    $reportRoot = Join-Path $StateRoot "reports"
    $nodeArgs = @(
        $scriptPath,
        "--install-root", $InstallRoot,
        "--state-root", $StateRoot,
        "--server", $ServerName,
        "--list-only",
        "--timeout-ms", ([Math]::Max(3000, $TimeoutSec * 1000)),
        "--report-root", $reportRoot
    )
    $output = & $node @nodeArgs 2>&1
    $exitCode = $LASTEXITCODE
    $text = @($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($exitCode -ne 0) {
        throw "real MCP tools/list failed: $text"
    }
    $parsed = $text | ConvertFrom-Json
    if (-not $parsed.ok) {
        throw "real MCP tools/list returned ok=false"
    }
    return $parsed
}

try {
    $health = Invoke-AntiCodexHealth
    if (-not $health.ok) { Add-Failure "health ok=false" }
    $hasUpstreamProfile = $health.PSObject.Properties.Name -contains "upstreamProfile" -and $null -ne $health.upstreamProfile
    if ($hasUpstreamProfile) {
        $healthMode = if ($health.upstreamProfile.PSObject.Properties.Name -contains "mode") { [string]$health.upstreamProfile.mode } else { "unknown" }
        $healthProtocol = if ($health.upstreamProfile.PSObject.Properties.Name -contains "protocol") { [string]$health.upstreamProfile.protocol } else { $null }
        $healthModel = if ($health.upstreamProfile.PSObject.Properties.Name -contains "model") { [string]$health.upstreamProfile.model } else { $null }
    } elseif ($health.upstream -eq "antigravity-desktop") {
        $healthMode = "antigravity"
    }
    if ($healthMode -eq "third-party") {
        if (-not $healthProtocol) { Add-Failure "third-party upstream missing protocol" }
        if (-not $healthModel) { Add-Failure "third-party upstream missing model" }
    } elseif ($healthMode -eq "antigravity") {
        if ($health.upstream -ne "antigravity-desktop") { Add-Failure "Antigravity mode but upstream is not antigravity-desktop: $($health.upstream)" }
        if ([int]$health.modelCount -lt 1) { Add-Failure "Antigravity model catalog is not ready: $($health.accountMessage)" }
    } else {
        Add-Failure "unknown upstream mode (upstream=$($health.upstream), upstreamProfile.mode=$healthMode)"
    }
} catch {
    Add-Failure "health request failed: $($_.Exception.Message)"
}

if (-not (Test-Path -LiteralPath $CodexHome -PathType Container)) {
    Add-Failure "installed Codex home missing: $CodexHome"
}

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Add-Failure "installed config.toml missing: $configPath"
} else {
    try {
        $configText = Get-Content -LiteralPath $configPath -Raw
        if ($configText -notmatch "\[mcp_servers\]") { Add-Failure "config.toml missing [mcp_servers]" }
        if ($configText -notmatch "\[mcp_servers\.node_repl\]") { Add-Failure "config.toml missing node_repl MCP server" }
        if ($configText -match "chatgpt\.com/(auth|login)") { Add-Failure "config.toml contains ChatGPT login route" }
    } catch {
        Add-Failure "config.toml read failed: $($_.Exception.Message)"
    }
}

if (-not (Test-Path -LiteralPath $skillsPath -PathType Container)) {
    Add-Failure "skills directory missing: $skillsPath"
} else {
    try {
        $skillsItem = Get-Item -LiteralPath $skillsPath -Force
        if ($skillsItem.LinkType) {
            Add-Failure "skills directory should be an Anti-Codex local copy, found link type: $($skillsItem.LinkType)"
        }
        $skillEntries = @(Get-ChildItem -LiteralPath $skillsPath -Directory -ErrorAction Stop)
        $skillSampleEntries = @($skillEntries | Select-Object -First 50 | ForEach-Object { Select-LightFileSystemItem $_ })
        if ($skillEntries.Count -lt 1) { Add-Failure "skills directory is empty" }
    } catch {
        Add-Failure "skills directory read failed: $($_.Exception.Message)"
    }
}

if (Test-Path -LiteralPath $sharedSkillsPath -PathType Container) {
    $sharedSkillNames = @(Get-ChildItem -LiteralPath $sharedSkillsPath -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object -Unique)
}
if (Test-Path -LiteralPath $AgentsSkillsPath -PathType Container) {
    $agentsSkillNames = @(Get-ChildItem -LiteralPath $AgentsSkillsPath -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object -Unique)
}
if ((Test-Path -LiteralPath $sharedSkillsPath -PathType Container) -or (Test-Path -LiteralPath $AgentsSkillsPath -PathType Container)) {
    $expectedSharedSkillNames = @($sharedSkillNames + $agentsSkillNames) | Sort-Object -Unique
    $duplicateSkillNames = @($sharedSkillNames | Where-Object { $agentsSkillNames -contains $_ } | Sort-Object -Unique)
    foreach ($skillName in $duplicateSkillNames) {
        $sharedSkillPath = Join-Path $sharedSkillsPath $skillName
        $agentSkillPath = Join-Path $AgentsSkillsPath $skillName
        $sharedFingerprint = Get-DirectoryContentFingerprint $sharedSkillPath
        $agentFingerprint = Get-DirectoryContentFingerprint $agentSkillPath
        if ($sharedFingerprint -and $agentFingerprint -and $sharedFingerprint -ne $agentFingerprint) {
            $conflictingDuplicateSkillNames += $skillName
            Add-Failure "duplicate skill '$skillName' differs between shared Codex skills and agents skills"
        }
    }
    $localSkillNames = @($skillEntries | ForEach-Object { $_.Name } | Sort-Object -Unique)
    $missingSharedSkillNames = @($expectedSharedSkillNames | Where-Object { $localSkillNames -notcontains $_ })
    $extraLocalSkillNames = @($localSkillNames | Where-Object { $expectedSharedSkillNames -notcontains $_ })
    foreach ($skillName in $missingSharedSkillNames) {
        Add-Failure "shared or agent skill '$skillName' exists but Anti-Codex local skills copy is missing it"
    }
    foreach ($skillName in $expectedSharedSkillNames) {
        $sharedSkill = Join-Path $sharedSkillsPath $skillName
        $agentSkill = Join-Path $AgentsSkillsPath $skillName
        $localSkill = Join-Path $skillsPath $skillName
        $sharedExists = Test-Path -LiteralPath $sharedSkill -PathType Container
        $agentExists = Test-Path -LiteralPath $agentSkill -PathType Container
        $localExists = Test-Path -LiteralPath $localSkill -PathType Container
        $sharedFingerprint = if ($sharedExists) { Get-DirectoryContentFingerprint $sharedSkill } else { "" }
        $agentFingerprint = if ($agentExists) { Get-DirectoryContentFingerprint $agentSkill } else { "" }
        $localFingerprint = if ($localExists) { Get-DirectoryContentFingerprint $localSkill } else { "" }
        $sourceFingerprints = @($sharedFingerprint, $agentFingerprint) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
        $contentMatches = $localExists -and -not [string]::IsNullOrWhiteSpace($localFingerprint) -and ($sourceFingerprints -contains $localFingerprint)
        $inheritedSkillChecks += [pscustomobject]@{
            name = $skillName
            sharedExists = $sharedExists
            agentsExists = $agentExists
            localExists = $localExists
            sharedFingerprint = $sharedFingerprint
            agentsFingerprint = $agentFingerprint
            localFingerprint = $localFingerprint
            contentMatches = $contentMatches
        }
        if ($localExists -and $sourceFingerprints.Count -gt 0 -and -not $contentMatches) {
            $changedSharedSkillNames += $skillName
            $changedSharedSkillDetails += [pscustomobject]@{
                name = $skillName
                sharedFingerprint = $sharedFingerprint
                agentsFingerprint = $agentFingerprint
                localFingerprint = $localFingerprint
            }
            Add-Failure "shared or agent skill '$skillName' content differs from Anti-Codex local skills copy"
        }
    }
}

foreach ($guidanceName in $guidanceNames) {
    $sharedGuidance = Join-Path $SharedCodexHome $guidanceName
    $localGuidance = Join-Path $CodexHome $guidanceName
    $sharedExists = Test-Path -LiteralPath $sharedGuidance -PathType Leaf
    $localExists = Test-Path -LiteralPath $localGuidance -PathType Leaf
    $localItem = if ($localExists) { Get-Item -LiteralPath $localGuidance -Force } else { $null }
    $sharedHash = if ($sharedExists) { (Get-FileHash -LiteralPath $sharedGuidance -Algorithm SHA256).Hash.ToLowerInvariant() } else { "" }
    $localHash = if ($localExists) { (Get-FileHash -LiteralPath $localGuidance -Algorithm SHA256).Hash.ToLowerInvariant() } else { "" }
    $contentMatches = ($sharedExists -and $localExists -and $sharedHash -eq $localHash)
    $guidanceChecks += [pscustomobject]@{
        name = $guidanceName
        sharedExists = $sharedExists
        localExists = $localExists
        linkType = if ($localItem) { $localItem.LinkType } else { $null }
        sharedHash = $sharedHash
        localHash = $localHash
        contentMatches = $contentMatches
    }
    if ($sharedExists -and -not $localExists) {
        Add-Failure "shared guidance '$guidanceName' exists but Anti-Codex local copy is missing it"
    } elseif ($localItem -and $localItem.LinkType) {
        Add-Failure "Anti-Codex guidance '$guidanceName' should be a local copy, found link type: $($localItem.LinkType)"
    } elseif ($sharedExists -and $localExists -and -not $contentMatches) {
        Add-Failure "Anti-Codex guidance '$guidanceName' content differs from shared copy"
    }
}

try {
    $pluginsInstalled = Invoke-LocalJson "/backend-api/ps/plugins/installed"
} catch {
    Add-Failure "installed plugins endpoint failed: $($_.Exception.Message)"
}

try {
    $pluginsList = Invoke-LocalJson "/backend-api/plugins/list"
} catch {
    Add-Failure "plugin list endpoint failed: $($_.Exception.Message)"
}

try {
    $connectors = Invoke-LocalJson "/backend-api/aip/connectors"
} catch {
    Add-Failure "connectors endpoint failed: $($_.Exception.Message)"
}

try {
    $apps = Invoke-LocalJsonPost "/backend-api/wham/apps"
} catch {
    Add-Failure "app tools endpoint failed: $($_.Exception.Message)"
}

$connectorCount = Get-ObjectCount $connectors "connectors"
if (-not (Test-Path -LiteralPath $connectorDirectoryPath -PathType Container)) {
    if ($connectorCount -gt 0) {
        Add-Failure "connector endpoint has entries but Anti-Codex local connector cache is missing: $connectorDirectoryPath"
    }
} else {
    try {
        $connectorDirectoryItem = Get-Item -LiteralPath $connectorDirectoryPath -Force
        if ($connectorDirectoryItem.LinkType -or (($connectorDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            Add-Failure "connector directory should be an Anti-Codex local copy, found link type: $($connectorDirectoryItem.LinkType)"
        }
        $connectorDirectoryEntries = @(Get-ChildItem -LiteralPath $connectorDirectoryPath -File -ErrorAction Stop | Select-Object -First 50 | ForEach-Object { Select-LightFileSystemItem $_ })
    } catch {
        Add-Failure "connector directory read failed: $($_.Exception.Message)"
    }
}

$appToolCount = Get-ObjectCount $apps "tools"
if (-not (Test-Path -LiteralPath $appToolsCachePath -PathType Container)) {
    if ($appToolCount -gt 0) {
        Add-Failure "app tools endpoint has tools but Anti-Codex local app-tools cache is missing: $appToolsCachePath"
    }
} else {
    try {
        $appToolsCacheItem = Get-Item -LiteralPath $appToolsCachePath -Force
        if ($appToolsCacheItem.LinkType -or (($appToolsCacheItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            Add-Failure "app tools cache should be an Anti-Codex local copy, found link type: $($appToolsCacheItem.LinkType)"
        }
        $appToolsCacheEntries = @(Get-ChildItem -LiteralPath $appToolsCachePath -File -ErrorAction Stop | Select-Object -First 50 | ForEach-Object { Select-LightFileSystemItem $_ })
        if (-not (Test-Path -LiteralPath $appToolsRegistryPath -PathType Leaf)) {
            Add-Failure "app tools sync registry is missing: $appToolsRegistryPath"
        } else {
            $appToolsRegistry = Get-Content -LiteralPath $appToolsRegistryPath -Raw | ConvertFrom-Json
            if ($appToolsRegistry.content_matches -ne $true) {
                Add-Failure "app tools sync registry content does not match shared cache"
            }
            if (-not $appToolsRegistry.shared_tools_fingerprint -or -not $appToolsRegistry.local_tools_fingerprint) {
                Add-Failure "app tools sync registry is missing shared/local fingerprints"
            } elseif ($appToolsRegistry.shared_tools_fingerprint -ne $appToolsRegistry.local_tools_fingerprint) {
                Add-Failure "app tools sync registry fingerprint mismatch"
            }
        }
    } catch {
        Add-Failure "app tools cache read failed: $($_.Exception.Message)"
    }
}

$mcpNames = @()
if ($configText) {
    $mcpNames = @(Get-McpServerNamesFromToml $configText)
    $sharedConfigText = ""
    if (Test-Path -LiteralPath $sharedConfigPath -PathType Leaf) {
        try {
            $sharedConfigText = Get-Content -LiteralPath $sharedConfigPath -Raw
            $sharedMcpNames = @(Get-McpServerNamesFromToml $sharedConfigText)
            $missingSharedMcpNames = @($sharedMcpNames | Where-Object { $mcpNames -notcontains $_ })
            $extraLocalMcpNames = @($mcpNames | Where-Object { $sharedMcpNames -notcontains $_ })
            foreach ($mcpName in $missingSharedMcpNames) {
                Add-Failure "shared MCP server '$mcpName' exists but Anti-Codex local config is missing it"
            }
            foreach ($mcpName in @($sharedMcpNames | Where-Object { $mcpNames -contains $_ })) {
                $sharedSection = Get-McpSectionText $sharedConfigText $mcpName
                $localSection = Get-McpSectionText $configText $mcpName
                $changedFields = @()
                $sharedCommand = Normalize-McpCommandCompareValue (Get-TomlQuotedFieldValue $sharedSection "command")
                $localCommand = Normalize-McpCommandCompareValue (Get-TomlQuotedFieldValue $localSection "command")
                if ($sharedCommand -ne $localCommand) { $changedFields += "command" }
                $sharedArgs = Get-TomlFieldRaw $sharedSection "args"
                $localArgs = Get-TomlFieldRaw $localSection "args"
                if ($sharedArgs -ne $localArgs) { $changedFields += "args" }
                $sharedEnv = Normalize-McpEnvForCompare $mcpName (Get-McpNestedSectionText $sharedConfigText $mcpName "env")
                $localEnv = Normalize-McpEnvForCompare $mcpName (Get-McpNestedSectionText $configText $mcpName "env")
                if ($sharedEnv -ne $localEnv) { $changedFields += "env" }
                if ($changedFields.Count -gt 0) {
                    $changedSharedMcpNames += $mcpName
                    $changedSharedMcpDetails += [pscustomobject]@{
                        name = $mcpName
                        fields = @($changedFields)
                    }
                    Add-Failure "shared MCP server '$mcpName' config differs in Anti-Codex local config: $([string]::Join(', ', $changedFields))"
                }
            }
        } catch {
            Add-Failure "shared config.toml read failed: $($_.Exception.Message)"
        }
    }
    foreach ($mcpName in $mcpNames) {
        $sectionMatch = [regex]::Match($configText, "(?ms)^\[mcp_servers\.$([regex]::Escape($mcpName))\]\s*(.*?)(?=^\[|\z)")
        $section = if ($sectionMatch.Success) { $sectionMatch.Groups[1].Value } else { "" }
        $commandMatch = [regex]::Match($section, "(?m)^\s*command\s*=\s*['""]([^'""]+)['""]")
        $argsMatch = [regex]::Match($section, "(?m)^\s*args\s*=\s*\[(.*?)\]")
        $commandValue = if ($commandMatch.Success) { $commandMatch.Groups[1].Value } else { "" }
        $firstArg = ""
        if ($argsMatch.Success) {
            $argMatch = [regex]::Match($argsMatch.Groups[1].Value, "['""]([^'""]+)['""]")
            if ($argMatch.Success) { $firstArg = $argMatch.Groups[1].Value }
        }
        $commandResolvable = Resolve-McpCommand $commandValue
        $firstArgExists = if ($firstArg -and [IO.Path]::IsPathRooted($firstArg)) { Test-Path -LiteralPath $firstArg -PathType Leaf } elseif ($firstArg) { $true } else { $null }
        if (-not $commandResolvable) { Add-Failure "MCP '$mcpName' command is not resolvable: $commandValue" }
        if ($firstArgExists -eq $false) { Add-Failure "MCP '$mcpName' first arg file is missing: $firstArg" }
        $mcpSmokeChecks += [pscustomobject]@{
            name = $mcpName
            command = $commandValue
            commandResolvable = $commandResolvable
            firstArg = $firstArg
            firstArgExists = $firstArgExists
        }
    }
}

$expectedMcpToolNames = @{
    "antigravity-code-worker" = @(
        "antigravity_get_conversation",
        "antigravity_get_job",
        "antigravity_health",
        "antigravity_send_message",
        "antigravity_start_implementation",
        "antigravity_tail_job"
    )
    "deepseek-code-worker" = @(
        "deepseek_cancel_job",
        "deepseek_get_job",
        "deepseek_implement_in_workspace",
        "deepseek_start_implementation",
        "deepseek_tail_job",
        "deepseek_wait_for_job"
    )
}

if ($mcpNames -contains "node_repl") {
    try {
        $realSmoke = Invoke-RealNodeReplMcpSmoke
        $mcpRealSmoke = [pscustomobject]@{
            checked = $true
            passed = [bool]$realSmoke.ok
            server = [string]$realSmoke.serverName
            tool = [string]$realSmoke.toolName
            markerObserved = [bool]$realSmoke.markerObserved
            toolCount = [int]$realSmoke.toolCount
            elapsedMs = [int]$realSmoke.elapsedMs
            error = ""
        }
    } catch {
        $mcpRealSmoke = [pscustomobject]@{
            checked = $true
            passed = $false
            server = "node_repl"
            tool = "js"
            markerObserved = $false
            toolCount = 0
            elapsedMs = 0
            error = [string]$_.Exception.Message
        }
        Add-Failure "MCP node_repl real stdio tool call failed: $($_.Exception.Message)"
    }
}

foreach ($mcpName in @($mcpNames | Where-Object { $_ -ne "node_repl" })) {
    try {
        $listSmoke = Invoke-RealMcpListSmoke $mcpName
        $toolCount = [int]$listSmoke.toolCount
        $toolNames = @($listSmoke.toolNames)
        $missingExpectedTools = @()
        if ($expectedMcpToolNames.ContainsKey($mcpName)) {
            $missingExpectedTools = @($expectedMcpToolNames[$mcpName] | Where-Object { $toolNames -notcontains $_ })
        }
        $passed = ($listSmoke.ok -eq $true -and $toolCount -gt 0 -and $missingExpectedTools.Count -eq 0)
        $mcpListSmokeChecks += [pscustomobject]@{
            checked = $true
            passed = $passed
            server = [string]$listSmoke.serverName
            toolCount = $toolCount
            toolNames = $toolNames
            expectedToolNames = if ($expectedMcpToolNames.ContainsKey($mcpName)) { @($expectedMcpToolNames[$mcpName]) } else { @() }
            missingExpectedTools = $missingExpectedTools
            elapsedMs = [int]$listSmoke.elapsedMs
            error = ""
        }
        if ($missingExpectedTools.Count -gt 0) {
            Add-Failure "MCP '$mcpName' real stdio tools/list missing expected tools: $($missingExpectedTools -join ', ')"
        } elseif (-not $passed) {
            Add-Failure "MCP '$mcpName' real stdio tools/list returned no tools"
        }
    } catch {
        $mcpListSmokeChecks += [pscustomobject]@{
            checked = $true
            passed = $false
            server = $mcpName
            toolCount = 0
            toolNames = @()
            elapsedMs = 0
            error = [string]$_.Exception.Message
        }
        Add-Failure "MCP '$mcpName' real stdio tools/list failed: $($_.Exception.Message)"
    }
}

$headroomSkillFile = Join-Path (Join-Path $skillsPath "headroom") "SKILL.md"
if (Test-Path -LiteralPath $headroomSkillFile -PathType Leaf) {
    try {
        $skillText = Get-Content -LiteralPath $headroomSkillFile -Raw -ErrorAction Stop
        $skillSmoke = [pscustomobject]@{
            checked = $true
            skillName = "headroom"
            skillFile = $headroomSkillFile
            readable = ($skillText.Length -gt 0)
            length = $skillText.Length
        }
        if ($skillText.Length -lt 10) { Add-Failure "headroom SKILL.md is unexpectedly small" }
    } catch {
        Add-Failure "headroom SKILL.md read failed: $($_.Exception.Message)"
    }
}

$capabilityState = if ($failures.Count -gt 0) {
    "degraded_verification_failed"
} elseif ($skillEntries.Count -lt 1) {
    "degraded_missing_local_skills_snapshot"
} elseif ($mcpNames.Count -lt 1) {
    "degraded_missing_mcp_config"
} elseif ($mcpRealSmoke.checked -and -not $mcpRealSmoke.passed) {
    "degraded_mcp_stdio_unavailable"
} elseif (@($mcpListSmokeChecks | Where-Object { -not $_.passed }).Count -gt 0) {
    "degraded_mcp_stdio_list_unavailable"
} else {
    "ready"
}
$capabilityDegraded = ($capabilityState -ne "ready")
$sourceSnapshot = Get-AntiCodexSourceSnapshot -SharedCodexHome $SharedCodexHome -AgentsSkillsPath $AgentsSkillsPath

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    reportName = "mcp-skills"
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    snapshotSource = "anticodex-local-copy"
    sourceSnapshot = $sourceSnapshot
    nativeCodexWriteback = $false
    capabilityState = $capabilityState
    degraded = $capabilityDegraded
    paths = [pscustomobject]@{
        stateRoot = $StateRoot
        codexHome = $CodexHome
        sharedCodexHome = $SharedCodexHome
        agentsSkillsPath = $AgentsSkillsPath
        configToml = $configPath
        sharedConfigToml = $sharedConfigPath
        skills = $skillsPath
        sharedSkills = $sharedSkillsPath
        guidance = $guidanceNames
        connectorDirectory = $connectorDirectoryPath
        appToolsCache = $appToolsCachePath
    }
    health = [pscustomobject]@{
        ok = if ($health) { $health.ok } else { $false }
        upstream = if ($health) { $health.upstream } else { $null }
        accountReady = if ($health) { $health.accountReady } else { $false }
        accountState = if ($health) { $health.accountState } else { $null }
        modelCount = if ($health) { $health.modelCount } else { 0 }
        mode = $healthMode
        protocol = $healthProtocol
        model = $healthModel
    }
    mcp = [pscustomobject]@{
        count = $mcpNames.Count
        names = $mcpNames
        sharedCount = $sharedMcpNames.Count
        sharedNames = $sharedMcpNames
        missingShared = $missingSharedMcpNames
        extraLocal = $extraLocalMcpNames
        changedShared = $changedSharedMcpNames
        changedSharedDetails = @($changedSharedMcpDetails)
        hasNodeRepl = ($mcpNames -contains "node_repl")
        smoke = [pscustomobject]@{
            checked = ($mcpSmokeChecks.Count -gt 0)
            passed = ((@($mcpSmokeChecks | Where-Object { -not $_.commandResolvable -or $_.firstArgExists -eq $false }).Count -eq 0) -and ($mcpRealSmoke.checked -eq $false -or $mcpRealSmoke.passed -eq $true) -and (@($mcpListSmokeChecks | Where-Object { -not $_.passed }).Count -eq 0))
            commandCount = $mcpSmokeChecks.Count
            checks = @($mcpSmokeChecks)
            realCall = $mcpRealSmoke
            realList = @($mcpListSmokeChecks)
        }
    }
    skills = [pscustomobject]@{
        count = $skillEntries.Count
        linkType = if ($skillsItem) { $skillsItem.LinkType } else { $null }
        target = Get-LinkTargetValue $skillsItem
        inherited = @($inheritedSkillChecks)
        sharedCount = $sharedSkillNames.Count
        agentsCount = $agentsSkillNames.Count
        expectedSharedCount = $expectedSharedSkillNames.Count
        missingShared = $missingSharedSkillNames
        extraLocal = $extraLocalSkillNames
        changedShared = $changedSharedSkillNames
        changedSharedDetails = @($changedSharedSkillDetails)
        duplicateNames = $duplicateSkillNames
        conflictingDuplicateNames = $conflictingDuplicateSkillNames
        smoke = $skillSmoke
        sample = @($skillSampleEntries | Select-Object -First 10)
    }
    guidance = @($guidanceChecks)
    plugins = [pscustomobject]@{
        installedCount = Get-ObjectCount $pluginsInstalled ""
        listCount = Get-ObjectCount $pluginsList "plugins"
    }
    connectors = [pscustomobject]@{
        count = $connectorCount
        cacheExists = (Test-Path -LiteralPath $connectorDirectoryPath -PathType Container)
        cacheLinkType = if ($connectorDirectoryItem) { $connectorDirectoryItem.LinkType } else { $null }
        cacheTarget = Get-LinkTargetValue $connectorDirectoryItem
        cacheFileCount = $connectorDirectoryEntries.Count
        cacheSample = @($connectorDirectoryEntries | Select-Object -First 10)
    }
    appTools = [pscustomobject]@{
        count = $appToolCount
        cacheExists = (Test-Path -LiteralPath $appToolsCachePath -PathType Container)
        cacheLinkType = if ($appToolsCacheItem) { $appToolsCacheItem.LinkType } else { $null }
        cacheTarget = Get-LinkTargetValue $appToolsCacheItem
        cacheFileCount = $appToolsCacheEntries.Count
        cacheSample = @($appToolsCacheEntries | Select-Object -First 10)
        registry = [pscustomobject]@{
            path = $appToolsRegistryPath
            exists = (Test-Path -LiteralPath $appToolsRegistryPath -PathType Leaf)
            contentMatches = if ($appToolsRegistry) { $appToolsRegistry.content_matches -eq $true } else { $false }
            sharedFileCount = if ($appToolsRegistry) { [int]$appToolsRegistry.shared_tools_file_count } else { 0 }
            localFileCount = if ($appToolsRegistry) { [int]$appToolsRegistry.local_tools_file_count } else { 0 }
            sharedFingerprint = if ($appToolsRegistry) { [string]$appToolsRegistry.shared_tools_fingerprint } else { "" }
            localFingerprint = if ($appToolsRegistry) { [string]$appToolsRegistry.local_tools_fingerprint } else { "" }
        }
    }
}

$reportPaths = New-ReportPaths "mcp-skills"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
Save-JsonReport $reportPaths $result -Depth 10
$result | ConvertTo-Json -Depth 8 -Compress
if ($failures.Count -gt 0) { exit 1 }
