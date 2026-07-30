#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = $(if ($env:DEEPCODEX_INSTALL_ROOT) { $env:DEEPCODEX_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Anti-Codex" }),
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
$startedAtUtc = [DateTime]::UtcNow

$scriptRoot = Split-Path -Parent $PSCommandPath
$root = Split-Path -Parent $scriptRoot
. (Join-Path $PSScriptRoot "anticodex-source-snapshot.ps1")
$sharedConfigSync = Join-Path $scriptRoot "sync-shared-codex-config.mjs"
$pluginHostSync = Join-Path $scriptRoot "sync-shared-codex-plugin-host.mjs"
$sidecarsSync = Join-Path $scriptRoot "sync-shared-codex-sidecars.mjs"
$failures = New-Object System.Collections.Generic.List[string]
$recoveryActions = New-Object System.Collections.Generic.List[object]
$recoveryActionIds = @{}
$directoryFingerprintCache = @{}
$sanitizedSkillDirectoryFingerprintCache = @{}
$script:refreshFeatureFileHashCachePath = Join-Path $StateRoot "cache\refresh-feature-file-hashes.json"
$script:refreshFeatureFileHashCache = @{}
$script:refreshFeatureFileHashNewCache = [ordered]@{}
$script:refreshFeatureFileHashCacheHitCount = 0
$script:refreshFeatureFileHashCacheMissCount = 0

if (Test-Path -LiteralPath $script:refreshFeatureFileHashCachePath -PathType Leaf) {
    try {
        $loadedHashCache = Get-Content -LiteralPath $script:refreshFeatureFileHashCachePath -Raw | ConvertFrom-Json -ErrorAction Stop
        if ($loadedHashCache.entries) {
            foreach ($property in $loadedHashCache.entries.PSObject.Properties) {
                $script:refreshFeatureFileHashCache[$property.Name] = $property.Value
            }
        }
    } catch {
        $script:refreshFeatureFileHashCache = @{}
    }
}

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Add-RecoveryAction {
    param(
        [string]$Id,
        [string]$Reason,
        [string]$Guidance,
        [string[]]$Commands
    )
    if ($recoveryActionIds.ContainsKey($Id)) { return }
    $recoveryActionIds[$Id] = $true
    $recoveryActions.Add([pscustomobject]@{
        id = $Id
        reason = $Reason
        guidance = $Guidance
        commands = @($Commands)
        requiresRealTraffic = $false
    }) | Out-Null
}

function Test-SkillsSnapshotLockFailure {
    param([string]$Message, [string]$RelPath = "")
    if ($RelPath -and $RelPath -ne "skills") { return $false }
    $text = [string]$Message
    $hasLockError = $text -match "(?i)\b(EPERM|EACCES)\b" -or
        $text -match "(?i)access is denied" -or
        $text -match "(?i)used by another process"
    $looksLikeSkillsSwap = $RelPath -eq "skills" -or
        $text -match "(?i)skills" -or
        $text -match "(?i)Failed to move existing target aside before swap" -or
        $text -match "(?i)Failed to swap temporary directory into place"
    return ($hasLockError -and $looksLikeSkillsSwap)
}

function Add-SkillsSnapshotLockRecoveryAction {
    Add-RecoveryAction `
        -Id "refreshFeatures.skillsDirectoryLocked" `
        -Reason "local skills snapshot refresh was blocked by a Windows directory lock" `
        -Guidance "Do not treat the partial refresh as release-ready. If guidance, connector, or app-tool drift was repaired, rerun refresh-anticodex-local-features.ps1 -VerifyOnly, then refresh the startup snapshot marker." `
        -Commands @(
            "powershell.exe -File scripts/refresh-anticodex-local-features.ps1 -VerifyOnly",
            "node scripts/sync-shared-codex-plugin-host.mjs <codexHome> <sharedCodexHome> --startup-snapshots"
        )
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
        ForEach-Object { Normalize-McpServerName $_.Groups[1].Value } |
        Where-Object { $_ -notmatch "\.env$" -and $_ -notmatch "\.tools\." } |
        Sort-Object -Unique)
}

function Normalize-McpServerName {
    param([string]$Name)
    if (-not $Name) { return "" }
    $trimmed = $Name.Trim()
    if ($trimmed.StartsWith('"') -and $trimmed.EndsWith('"') -and $trimmed.Length -ge 2) {
        try {
            return [System.Text.RegularExpressions.Regex]::Unescape($trimmed.Substring(1, $trimmed.Length - 2))
        } catch {
            return $trimmed.Substring(1, $trimmed.Length - 2)
        }
    }
    return $trimmed
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
    if ($directoryFingerprintCache.ContainsKey($rootPath)) { return $directoryFingerprintCache[$rootPath] }
    $entries = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction Stop |
        Where-Object { $_.Name -ne ".anticodex-source-manifest.json" -and $_.FullName -notmatch '(?i)[\\/]\.git(?:[\\/]|$)' } |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($rootPath.Length).TrimStart("\", "/")
            $hash = Get-FileSha256Hex $_.FullName
            "$relative`t$hash"
        })
    $joined = [string]::Join("`n", $entries)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
        $directoryFingerprintCache[$rootPath] = $fingerprint
        return $fingerprint
    } finally {
        $sha.Dispose()
    }
}

function Get-SanitizedSkillFileHash {
    param([System.IO.FileInfo]$File)
    if ($File.Name -ine "SKILL.md") { return Get-FileSha256Hex $File.FullName }

    $bytes = [IO.File]::ReadAllBytes($File.FullName)
    $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { 3 } else { 0 }
    $text = [Text.Encoding]::UTF8.GetString($bytes, $offset, $bytes.Length - $offset)
    $lines = @($text -split "`r?`n")
    if ($lines.Count -eq 0 -or $lines[0].Trim() -ne "---") { return "" }
    $closingIndex = -1
    for ($index = 1; $index -lt $lines.Count; $index++) {
        if ($lines[$index].Trim() -eq "---") {
            $closingIndex = $index
            break
        }
    }
    if ($closingIndex -lt 0) { return "" }
    $frontmatter = @($lines[1..($closingIndex - 1)])
    $hasDescription = @($frontmatter | Where-Object { $_ -match '^description\s*:\s*\S' }).Count -gt 0
    if (-not $hasDescription) { return "" }

    $normalizedBytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($normalizedBytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-SanitizedSkillDirectoryContentFingerprint {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return "" }
    $rootPath = (Resolve-Path -LiteralPath $Path).Path.TrimEnd("\", "/")
    if ($sanitizedSkillDirectoryFingerprintCache.ContainsKey($rootPath)) { return $sanitizedSkillDirectoryFingerprintCache[$rootPath] }
    $entries = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction Stop |
        Where-Object { $_.Name -ne ".anticodex-source-manifest.json" -and $_.FullName -notmatch '(?i)[\\/]\.git(?:[\\/]|$)' } |
        Sort-Object FullName |
        ForEach-Object {
            $hash = Get-SanitizedSkillFileHash $_
            if ($hash) {
                $relative = $_.FullName.Substring($rootPath.Length).TrimStart("\", "/")
                "$relative`t$hash"
            }
        })
    $joined = [string]::Join("`n", $entries)
    $bytes = [Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
        $sanitizedSkillDirectoryFingerprintCache[$rootPath] = $fingerprint
        return $fingerprint
    } finally {
        $sha.Dispose()
    }
}

function Get-DirectoryContentHashMap {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $map }
    $rootPath = (Resolve-Path -LiteralPath $Path).Path.TrimEnd("\", "/")
    Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction Stop |
        Where-Object { $_.Name -ne ".anticodex-source-manifest.json" -and $_.FullName -notmatch '(?i)[\\/]\.git(?:[\\/]|$)' } |
        ForEach-Object {
            $relative = $_.FullName.Substring($rootPath.Length).TrimStart("\", "/").Replace("\", "/")
            $map[$relative] = Get-FileSha256Hex $_.FullName
        }
    return $map
}

function New-DirectoryContentDiff {
    param([string]$SharedPath, [string]$LocalPath)
    $sharedMap = Get-DirectoryContentHashMap $SharedPath
    $localMap = Get-DirectoryContentHashMap $LocalPath
    $missingShared = @($sharedMap.Keys | Where-Object { -not $localMap.ContainsKey($_) } | Sort-Object)
    $extraLocal = @($localMap.Keys | Where-Object { -not $sharedMap.ContainsKey($_) } | Sort-Object)
    $changedShared = @($sharedMap.Keys | Where-Object { $localMap.ContainsKey($_) -and $localMap[$_] -ne $sharedMap[$_] } | Sort-Object)
    return [pscustomobject]@{
        missingSharedCount = @($missingShared).Count
        missingSharedSample = @($missingShared | Select-Object -First 5)
        extraLocalCount = @($extraLocal).Count
        extraLocalSample = @($extraLocal | Select-Object -First 5)
        changedSharedCount = @($changedShared).Count
        changedSharedSample = @($changedShared | Select-Object -First 5)
    }
}

function Get-DirectoryInfo {
    param([string]$Path)
    $exists = Test-Path -LiteralPath $Path -PathType Container
    $item = if ($exists) { Get-Item -LiteralPath $Path -Force } else { $null }
    $count = 0
    if ($exists) {
        $items = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | Select-Object -First 500)
        $count = @($items).Count
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

function Get-FileSha256Hex {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    $item = Get-Item -LiteralPath $Path -Force
    $cacheKey = $item.FullName
    $metaSignature = "$($item.Length):$($item.LastWriteTimeUtc.Ticks)"
    $cached = $script:refreshFeatureFileHashCache[$cacheKey]
    if ($cached -and [string]$cached.meta -eq $metaSignature -and [string]$cached.hash) {
        $script:refreshFeatureFileHashCacheHitCount += 1
        $script:refreshFeatureFileHashNewCache[$cacheKey] = $cached
        return [string]$cached.hash
    }
    $script:refreshFeatureFileHashCacheMissCount += 1
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        $script:refreshFeatureFileHashNewCache[$cacheKey] = [pscustomobject]@{
            meta = $metaSignature
            hash = $hash
        }
        return $hash
    } finally {
        if ($stream) { $stream.Dispose() }
        $sha.Dispose()
    }
}

function Save-RefreshFeatureFileHashCache {
    try {
        $cacheDir = Split-Path -Parent $script:refreshFeatureFileHashCachePath
        if ($cacheDir) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
        $payload = [pscustomobject]@{
            version = 1
            generatedAt = ([DateTime]::UtcNow.ToString("o"))
            entries = $script:refreshFeatureFileHashNewCache
        }
        $json = $payload | ConvertTo-Json -Depth 5 -Compress
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText($script:refreshFeatureFileHashCachePath, $json, $utf8NoBom)
    } catch {
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
            $configSyncSummary = Invoke-NodeText $sharedConfigSync @($sourceConfig, $targetConfig, "--install-root", $InstallRoot, "--codex-home", $CodexHome)
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
        if ($pluginSummary -and $pluginSummary.summary) {
            foreach ($snapshotItem in @($pluginSummary.summary)) {
                if ($snapshotItem.mode -eq "copy-failed" -and
                    (Test-SkillsSnapshotLockFailure -RelPath ([string]$snapshotItem.relPath) -Message ([string]$snapshotItem.error))) {
                    Add-SkillsSnapshotLockRecoveryAction
                }
            }
        }
    } catch {
        $localSnapshotRefreshFailure = "local snapshot refresh failed: $($_.Exception.Message)"
        Add-Failure $localSnapshotRefreshFailure
        if (Test-SkillsSnapshotLockFailure -Message $localSnapshotRefreshFailure) {
            Add-SkillsSnapshotLockRecoveryAction
        }
    }
    try {
        $sidecarSummary = Invoke-NodeText $sidecarsSync @($SharedCodexHome, $CodexHome)
    } catch {
        Add-Failure "sidecar refresh failed: $($_.Exception.Message)"
    }
    try {
        $sourceConfig = Join-Path $SharedCodexHome "config.toml"
        $targetConfig = Join-Path $CodexHome "config.toml"
        if (Test-Path -LiteralPath $sourceConfig -PathType Leaf) {
            $finalConfigSyncSummary = Invoke-NodeText $sharedConfigSync @($sourceConfig, $targetConfig, "--install-root", $InstallRoot, "--codex-home", $CodexHome)
            if ($finalConfigSyncSummary) {
                if ($configSyncSummary) {
                    $configSyncSummary = "$configSyncSummary; final-resync: $finalConfigSyncSummary"
                } else {
                    $configSyncSummary = "final-resync: $finalConfigSyncSummary"
                }
            }
        }
    } catch {
        Add-Failure "final shared config refresh failed: $($_.Exception.Message)"
    }
}

$configPath = Join-Path $CodexHome "config.toml"
if (-not $VerifyOnly) {
    try {
        Restore-AntiCodexFeatureFlags $configPath
    } catch {
        Add-Failure "Anti-Codex feature flag restore failed: $($_.Exception.Message)"
    }
}
$configText = ""
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $configText = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
} else {
    Add-Failure "config.toml missing after refresh"
}

$mcpNames = @()
if ($configText) {
    $mcpNames = @(Get-McpServerNamesFromToml $configText)
}
if (@($mcpNames).Count -lt 1) { Add-Failure "no MCP servers found in Anti-Codex config" }
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
$changedExpectedSkillNames = @()
$changedExpectedSkillDetails = @()
foreach ($skillName in $missingExpectedSkillNames) {
    Add-Failure "shared or agent skill '$skillName' exists but Anti-Codex local skills copy is missing it"
}
foreach ($skillName in $expectedSkillNames) {
    $sharedSkillPath = Join-Path $sharedSkillsPath $skillName
    $agentSkillPath = Join-Path $AgentsSkillsPath $skillName
    $localSkillPath = Join-Path (Join-Path $CodexHome "skills") $skillName
    $sharedExists = Test-Path -LiteralPath $sharedSkillPath -PathType Container
    $agentExists = Test-Path -LiteralPath $agentSkillPath -PathType Container
    $localExists = Test-Path -LiteralPath $localSkillPath -PathType Container
    $sharedFingerprint = if ($sharedExists) { Get-SanitizedSkillDirectoryContentFingerprint $sharedSkillPath } else { "" }
    $agentFingerprint = if ($agentExists) { Get-SanitizedSkillDirectoryContentFingerprint $agentSkillPath } else { "" }
    $localFingerprint = if ($localExists) { Get-SanitizedSkillDirectoryContentFingerprint $localSkillPath } else { "" }
    $sourceFingerprints = @($sharedFingerprint, $agentFingerprint) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
    $contentMatches = $localExists -and -not [string]::IsNullOrWhiteSpace($localFingerprint) -and ($sourceFingerprints -contains $localFingerprint)
    if ($localExists -and @($sourceFingerprints).Count -gt 0 -and -not $contentMatches) {
        $changedExpectedSkillNames += $skillName
        $changedExpectedSkillDetails += [pscustomobject]@{
            name = $skillName
            sharedFingerprint = $sharedFingerprint
            agentsFingerprint = $agentFingerprint
            localFingerprint = $localFingerprint
        }
        Add-Failure "shared or agent skill '$skillName' content differs from Anti-Codex local skills copy"
    }
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
    missingSharedCount = $null
    missingSharedSample = @()
    extraLocalCount = $null
    extraLocalSample = @()
    changedSharedCount = $null
    changedSharedSample = @()
}
$appToolParity = [pscustomobject]@{
    sharedExists = Test-Path -LiteralPath $sharedAppToolsCachePath -PathType Container
    localExists = Test-Path -LiteralPath (Join-Path $CodexHome "cache\codex_apps_tools") -PathType Container
    sharedFingerprint = ""
    localFingerprint = ""
    contentMatches = $null
    missingSharedCount = $null
    missingSharedSample = @()
    extraLocalCount = $null
    extraLocalSample = @()
    changedSharedCount = $null
    changedSharedSample = @()
}
if ($connectorParity.sharedExists) {
    $connectorParity.sharedFingerprint = Get-DirectoryContentFingerprint $sharedConnectorDirectoryPath
    if ($connectorParity.localExists) {
        $localConnectorDirectoryPath = Join-Path $CodexHome "cache\codex_app_directory"
        $connectorParity.localFingerprint = Get-DirectoryContentFingerprint $localConnectorDirectoryPath
        $connectorParity.contentMatches = ($connectorParity.sharedFingerprint -eq $connectorParity.localFingerprint)
        if ($connectorParity.contentMatches -ne $true) {
            $connectorDiff = New-DirectoryContentDiff -SharedPath $sharedConnectorDirectoryPath -LocalPath $localConnectorDirectoryPath
            foreach ($property in $connectorDiff.PSObject.Properties) {
                $connectorParity.PSObject.Properties[$property.Name].Value = $property.Value
            }
            Add-Failure "connector directory local snapshot differs from shared source after refresh"
        }
    } else {
        $connectorParity.contentMatches = $false
        Add-Failure "connector directory shared source exists but local snapshot is missing after refresh"
    }
}
if ($appToolParity.sharedExists) {
    $appToolParity.sharedFingerprint = Get-DirectoryContentFingerprint $sharedAppToolsCachePath
    if ($appToolParity.localExists) {
        $localAppToolsCachePath = Join-Path $CodexHome "cache\codex_apps_tools"
        $appToolParity.localFingerprint = Get-DirectoryContentFingerprint $localAppToolsCachePath
        $appToolParity.contentMatches = ($appToolParity.sharedFingerprint -eq $appToolParity.localFingerprint)
        if ($appToolParity.contentMatches -ne $true) {
            $appToolDiff = New-DirectoryContentDiff -SharedPath $sharedAppToolsCachePath -LocalPath $localAppToolsCachePath
            foreach ($property in $appToolDiff.PSObject.Properties) {
                $appToolParity.PSObject.Properties[$property.Name].Value = $property.Value
            }
            Add-Failure "app-tools cache local snapshot differs from shared source after refresh"
        }
    } else {
        $appToolParity.contentMatches = $false
        Add-Failure "app-tools cache shared source exists but local snapshot is missing after refresh"
    }
}
$guidance = [ordered]@{}
foreach ($name in @("AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md")) {
    $info = Get-FileInfo (Join-Path $CodexHome $name)
    $sharedPath = Join-Path $SharedCodexHome $name
    $localPath = Join-Path $CodexHome $name
    $sharedExists = Test-Path -LiteralPath $sharedPath -PathType Leaf
    $sharedHash = Get-FileSha256Hex $sharedPath
    $localHash = Get-FileSha256Hex $localPath
    $contentMatches = ($sharedExists -and $info.exists -and $sharedHash -eq $localHash)
    $info | Add-Member -NotePropertyName localExists -NotePropertyValue $info.exists
    $info | Add-Member -NotePropertyName sharedExists -NotePropertyValue $sharedExists
    $info | Add-Member -NotePropertyName sharedHash -NotePropertyValue $sharedHash
    $info | Add-Member -NotePropertyName localHash -NotePropertyValue $localHash
    $info | Add-Member -NotePropertyName contentMatches -NotePropertyValue $contentMatches
    $guidance[$name] = $info
    if ((Test-Path -LiteralPath $sharedPath -PathType Leaf) -and -not $info.exists) {
        Add-Failure "shared guidance '$name' exists but Anti-Codex local copy is missing"
    } elseif ($info.linkType) {
        Add-Failure "Anti-Codex guidance '$name' is a link, expected local copy"
    } elseif ($sharedExists -and $info.exists -and -not $contentMatches) {
        Add-Failure "shared guidance '$name' content differs from Anti-Codex local copy"
    }
}
if (-not $skills.exists -or $skills.count -lt 1) { Add-Failure "skills local copy is empty or missing" }
if ($skills.linkType) { Add-Failure "skills path is a link, expected local copy" }
$sourceSnapshot = Get-AntiCodexSourceSnapshot -SharedCodexHome $SharedCodexHome -AgentsSkillsPath $AgentsSkillsPath
Save-RefreshFeatureFileHashCache

$result = [pscustomobject]@{
    ok = (@($failures).Count -eq 0)
    reportName = "refresh-features"
    verifyOnly = [bool]$VerifyOnly
    startedAt = $startedAtUtc.ToString("o")
    elapsedMs = [int](([DateTime]::UtcNow - $startedAtUtc).TotalMilliseconds)
    failures = $failures.ToArray()
    recoveryActions = $recoveryActions.ToArray()
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
    hashCache = [pscustomobject]@{
        path = $script:refreshFeatureFileHashCachePath
        hitCount = $script:refreshFeatureFileHashCacheHitCount
        missCount = $script:refreshFeatureFileHashCacheMissCount
        entryCount = @($script:refreshFeatureFileHashNewCache.Keys).Count
    }
    mcp = [pscustomobject]@{
        count = @($mcpNames).Count
        names = $mcpNames
        hasNodeRepl = ($mcpNames -contains "node_repl")
    }
    skills = [pscustomobject]@{
        exists = $skills.exists
        count = $skills.count
        linkType = $skills.linkType
        target = $skills.target
        sharedCount = @($sharedSkillNames).Count
        agentsCount = @($agentsSkillNames).Count
        expectedCount = @($expectedSkillNames).Count
        missingExpected = $missingExpectedSkillNames
        changedExpected = $changedExpectedSkillNames
        changedExpectedDetails = @($changedExpectedSkillDetails)
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
if (@($failures).Count -gt 0) { exit 1 }
