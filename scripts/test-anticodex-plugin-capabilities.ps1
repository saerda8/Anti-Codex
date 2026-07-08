[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$StateRoot = $(if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }),
    [string]$ReportRoot = $(Join-Path $StateRoot "reports"),
    [string]$CodexHome = $(if ($env:CODEX_HOME_DIR) { $env:CODEX_HOME_DIR } else { Join-Path $StateRoot "codex-home-deepseek-app" }),
    [string]$SharedCodexHome = $(if ($env:DEEPCODEX_SHARED_CODEX_HOME) { $env:DEEPCODEX_SHARED_CODEX_HOME } elseif ($env:GLOBAL_CODEX_HOME) { $env:GLOBAL_CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }),
    [string]$AgentsSkillsPath = $(if ($env:ANTICODEX_AGENTS_SKILLS_PATH) { $env:ANTICODEX_AGENTS_SKILLS_PATH } else { Join-Path $env:USERPROFILE ".agents\skills" }),
    [int]$TimeoutSec = 8
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "anticodex-source-snapshot.ps1")

$script:verifierStartedAt = [DateTime]::UtcNow
$script:shortBudgetMode = ($TimeoutSec -lt 5)

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

function Get-RemainingVerifierBudgetMs {
    $elapsedMs = ([DateTime]::UtcNow - $script:verifierStartedAt).TotalMilliseconds
    return [Math]::Max(0, ($TimeoutSec * 1000) - [int]$elapsedMs)
}

function Write-PluginCapabilityReport {
    param($Payload)
    $reportPaths = New-ReportPaths "plugin-capabilities"
    $Payload | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
    Save-JsonReport $reportPaths $Payload -Depth 10
    $Payload | ConvertTo-Json -Depth 8 -Compress
}

function Invoke-LocalJsonWithRetry {
    param(
        [string]$Path,
        [ValidateSet("GET", "POST")]
        [string]$Method = "GET",
        [object]$Body = $null,
        [int]$MaxAttempts = 2
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $remainingBudgetMs = Get-RemainingVerifierBudgetMs
            if ($remainingBudgetMs -lt 250) {
                throw "verifier budget exhausted before $Path request attempt $attempt"
            }
            $requestTimeoutSec = [Math]::Max(1, [Math]::Min(3, [Math]::Min($TimeoutSec, [int][Math]::Ceiling($remainingBudgetMs / 1000))))
            $args = @{
                Uri = "$BaseUrl$Path"
                Method = $Method
                Proxy = $null
                TimeoutSec = $requestTimeoutSec
            }
            if ($null -ne $Body) {
                $args.ContentType = "application/json"
                $args.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
            }
            return Invoke-RestMethod @args
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -ge $MaxAttempts) {
                throw "$Path request failed on attempt $attempt of $MaxAttempts`: $lastError"
            }
            $sleepMs = [Math]::Min([Math]::Min(1000, 250 * $attempt), [Math]::Max(0, (Get-RemainingVerifierBudgetMs)))
            if ($sleepMs -gt 0) {
                Start-Sleep -Milliseconds $sleepMs
            }
        }
    }

    throw "$Path request failed after $MaxAttempts attempts: $lastError"
}

function Invoke-LocalJson {
    param(
        [string]$Path,
        [string]$Method = "GET",
        [object]$Body = $null
    )

    return Invoke-LocalJsonWithRetry -Path $Path -Method $Method -Body $Body -MaxAttempts 2
}

function Count-Items {
    param($Value)
    if ($null -eq $Value) { return 0 }
    return @($Value).Count
}

function Get-ArrayItems {
    param($Value, [string]$PropertyName = "")
    if ($null -eq $Value) { return @() }
    if ($PropertyName -and (Has-Property $Value $PropertyName)) { return @($Value.$PropertyName) }
    if ((Has-Property $Value "value") -and ($Value.value -is [array])) { return @($Value.value) }
    return @($Value)
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Get-PreviousPluginCapabilityReport {
    $latestPath = Join-Path $ReportRoot "latest-plugin-capabilities.json"
    if (-not (Test-Path -LiteralPath $latestPath -PathType Leaf)) { return $null }
    try {
        return Get-Content -LiteralPath $latestPath -Raw -ErrorAction Stop | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-ReusedSourceSnapshot {
    param(
        $PreviousReport,
        [string]$RefreshSkippedReason = "source snapshot refresh skipped in short-budget plugin capability mode"
    )
    $snapshot = if ($PreviousReport -and (Has-Property $PreviousReport "sourceSnapshot")) { $PreviousReport.sourceSnapshot } else { $null }
    if ($snapshot) {
        if (Has-Property $snapshot "reusedFromPreviousReport") { $snapshot.reusedFromPreviousReport = $true } else { $snapshot | Add-Member -NotePropertyName reusedFromPreviousReport -NotePropertyValue $true }
        if (Has-Property $snapshot "refreshSkippedReason") { $snapshot.refreshSkippedReason = $RefreshSkippedReason } else { $snapshot | Add-Member -NotePropertyName refreshSkippedReason -NotePropertyValue $RefreshSkippedReason }
        return $snapshot
    }
    return [pscustomobject]@{
        reusedFromPreviousReport = $false
        refreshSkippedReason = "$RefreshSkippedReason; no previous snapshot available"
    }
}

function Get-PluginId {
    param($PluginRecord)
    if (Has-Property $PluginRecord "id") { return [string]$PluginRecord.id }
    if ((Has-Property $PluginRecord "plugin") -and (Has-Property $PluginRecord.plugin "id")) { return [string]$PluginRecord.plugin.id }
    if ((Has-Property $PluginRecord "summary") -and (Has-Property $PluginRecord.summary "name")) { return [string]$PluginRecord.summary.name }
    return ""
}

function Get-AppToolKey {
    param($Tool)
    if ($null -eq $Tool) { return "" }
    $connectorId = if (Has-Property $Tool "connector_id") { [string]$Tool.connector_id } else { "" }
    $serverName = if (Has-Property $Tool "server_name") { [string]$Tool.server_name } else { "" }
    $namespace = if (Has-Property $Tool "tool_namespace") { [string]$Tool.tool_namespace } else { "" }
    $toolName = if (Has-Property $Tool "tool_name") { [string]$Tool.tool_name } else { "" }
    return "$connectorId|$serverName|$namespace|$toolName"
}

function Get-AppToolKeys {
    param($Tools)
    return @($Tools | ForEach-Object { Get-AppToolKey $_ } | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Sort-Object -Unique)
}

$health = $null
$healthMode = "unknown"
$healthProtocol = $null
$healthModel = $null
$installedPlugins = @()
$pluginList = @()
$connectors = @()
$whamTools = @()
$whamToolsGet = @()
$connectorCachePath = Join-Path $CodexHome "cache\codex_app_directory"
$appToolsCachePath = Join-Path $CodexHome "cache\codex_apps_tools"
$sharedConnectorCachePath = Join-Path $SharedCodexHome "cache\codex_app_directory"
$sharedAppToolsCachePath = Join-Path $SharedCodexHome "cache\codex_apps_tools"
$connectorCacheSmoke = [pscustomobject]@{
    checked = $false
    cacheExists = $false
    fileCount = 0
    sampleReadable = $false
    sampleConnectorCount = 0
}
$appToolsCacheSmoke = [pscustomobject]@{
    checked = $false
    cacheExists = $false
    fileCount = 0
    sampleReadable = $false
    sampleToolCount = 0
}

if ($script:shortBudgetMode) {
    Add-Failure "short budget plugin capability verification skipped live connector/app-tool endpoints"
    $previousReport = Get-PreviousPluginCapabilityReport
    $sourceSnapshot = Get-ReusedSourceSnapshot -PreviousReport $previousReport
    $result = [pscustomobject]@{
        ok = $false
        reportName = "plugin-capabilities"
        shortBudgetMode = $true
        failures = $failures.ToArray()
        baseUrl = $BaseUrl
        sourceSnapshot = $sourceSnapshot
        health = [pscustomobject]@{
            ok = $false
            upstream = $null
            accountReady = $false
            accountState = $null
            modelCount = 0
            mode = "unknown"
            protocol = $null
            model = $null
        }
        capabilities = [pscustomobject]@{
            snapshotSource = "anticodex-local-copy"
            nativeCodexWriteback = $false
            capabilityState = "degraded_short_budget"
            degraded = $true
            installedPluginCount = 0
            pluginListCount = 0
            pluginsWithSkills = 0
            pluginsWithApps = 0
            pluginsWithMcpServers = 0
            connectorCount = 0
            connectorParity = [pscustomobject]@{ checked = $false; missingShared = @(); extraLocal = @(); changedShared = @() }
            enabledConnectorCount = 0
            accessibleConnectorCount = 0
            appToolCount = 0
            appToolGetCount = 0
            appToolGetPostParity = [pscustomobject]@{ checked = $false; contentMatches = $false; missingFromGet = @(); extraFromGet = @() }
            appToolParity = [pscustomobject]@{ checked = $false; missingShared = @(); extraLocal = @(); changedShared = @() }
            unattributedAppToolCount = 0
            unauthorizedAppToolCount = 0
            appToolsNote = "short budget: live connector/app-tool endpoints were not checked"
            smoke = [pscustomobject]@{
                checked = $false
                endpointProjectionReadable = $false
                connectorCache = $connectorCacheSmoke
                appToolsCache = $appToolsCacheSmoke
                callableState = "skipped_short_budget"
            }
            samplePluginIds = @()
            sampleConnectorNames = @()
        }
    }
    Write-PluginCapabilityReport $result
    exit 1
}

function Test-ProjectionCache {
    param(
        [string]$Path,
        [string]$ArrayProperty
    )
    $exists = Test-Path -LiteralPath $Path -PathType Container
    $files = if ($exists) { @(Get-ChildItem -LiteralPath $Path -File -Filter "*.json" -ErrorAction SilentlyContinue) } else { @() }
    $dataFiles = @($files | Where-Object {
        $_.Name -ne ".anticodex-source-manifest.json" -and $_.Length -gt 0
    })
    $sampleReadable = $false
    $sampleCount = 0
    if ($dataFiles.Count -gt 0) {
        try {
            $raw = Get-Content -LiteralPath $dataFiles[0].FullName -Raw -ErrorAction Stop
            $sampleReadable = $raw -match ('"' + [regex]::Escape($ArrayProperty) + '"\s*:')
            if ($sampleReadable) {
                $sampleCount = ([regex]::Matches($raw, '"id"\s*:')).Count
            }
        } catch {
            $sampleReadable = $false
        }
    }
    return [pscustomobject]@{
        checked = $true
        cacheExists = $exists
        fileCount = $files.Count
        dataFileCount = $dataFiles.Count
        sampleReadable = $sampleReadable
        sampleCount = $sampleCount
    }
}

function Get-ProjectionKeys {
    param(
        [string]$Path,
        [string]$ArrayProperty,
        [ValidateSet("connector", "tool")]
        [string]$Kind
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return @() }
$node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $nodeScript = @'
const fs = require("fs");
const path = require("path");
const [dir, arrayProperty, kind] = process.argv.slice(2);
const keys = new Set();
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith(".json") || name === ".anticodex-source-manifest.json") continue;
  const full = path.join(dir, name);
  let payload;
  try { payload = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
  const items = Array.isArray(payload?.[arrayProperty]) ? payload[arrayProperty] : [];
  for (const item of items) {
    if (kind === "connector") {
      if (item?.id) keys.add(String(item.id));
    } else {
      const connectorId = item?.connector_id ? String(item.connector_id) : "";
      const toolName = item?.tool_name ? String(item.tool_name) : "";
      if (connectorId && toolName) {
        keys.add(`${connectorId}|${item?.server_name || ""}|${item?.tool_namespace || ""}|${toolName}`);
      }
    }
  }
}
process.stdout.write(Array.from(keys).sort().join("\n"));
'@
        $tempNodeScript = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-projection-keys-{0}.js" -f ([Guid]::NewGuid().ToString("N")))
        try {
            [System.IO.File]::WriteAllText($tempNodeScript, $nodeScript, [System.Text.UTF8Encoding]::new($false))
            return @(& $node.Source $tempNodeScript $Path $ArrayProperty $Kind | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        } catch {
        } finally {
            if (Test-Path -LiteralPath $tempNodeScript -PathType Leaf) {
                Remove-Item -LiteralPath $tempNodeScript -Force -ErrorAction SilentlyContinue
            }
        }
    }
    $keys = New-Object System.Collections.Generic.List[string]
    $files = @(Get-ChildItem -LiteralPath $Path -File -Filter "*.json" -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ne ".anticodex-source-manifest.json" -and $_.Length -gt 0
    })
    foreach ($file in $files) {
        try {
            $raw = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop
            if ($raw -notmatch ('"' + [regex]::Escape($ArrayProperty) + '"\s*:')) { continue }
            if ($Kind -eq "connector") {
                foreach ($match in [regex]::Matches($raw, '"id"\s*:\s*"([^"]+)"')) {
                    $value = [string]$match.Groups[1].Value
                    if (-not [string]::IsNullOrWhiteSpace($value)) { $keys.Add($value) | Out-Null }
                }
            } else {
                foreach ($match in [regex]::Matches($raw, '\{[^{}]*"tool_name"\s*:\s*"([^"]+)"[^{}]*\}')) {
                    $objectText = [string]$match.Value
                    $toolName = [regex]::Match($objectText, '"tool_name"\s*:\s*"([^"]+)"').Groups[1].Value
                    $connectorId = [regex]::Match($objectText, '"connector_id"\s*:\s*"([^"]+)"').Groups[1].Value
                    $serverName = [regex]::Match($objectText, '"server_name"\s*:\s*"([^"]*)"').Groups[1].Value
                    $namespace = [regex]::Match($objectText, '"tool_namespace"\s*:\s*"([^"]*)"').Groups[1].Value
                    if (-not [string]::IsNullOrWhiteSpace($connectorId) -and -not [string]::IsNullOrWhiteSpace($toolName)) {
                        $keys.Add("$connectorId|$serverName|$namespace|$toolName") | Out-Null
                    }
                }
            }
        } catch {}
    }
    return @($keys.ToArray() | Sort-Object -Unique)
}

function Get-ProjectionMap {
    param(
        [string]$Path,
        [string]$ArrayProperty,
        [ValidateSet("connector", "tool")]
        [string]$Kind
    )
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $map }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $nodeScript = @'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const [dir, arrayProperty, kind] = process.argv.slice(2);
const records = new Map();
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}
function hashItem(item) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(item))).digest("hex");
}
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith(".json") || name === ".anticodex-source-manifest.json") continue;
  const full = path.join(dir, name);
  let payload;
  try { payload = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
  const items = Array.isArray(payload?.[arrayProperty]) ? payload[arrayProperty] : [];
  for (const item of items) {
    let key = "";
    if (kind === "connector") {
      key = item?.id ? String(item.id) : "";
    } else {
      const connectorId = item?.connector_id ? String(item.connector_id) : "";
      const toolName = item?.tool_name ? String(item.tool_name) : "";
      if (connectorId && toolName) key = `${connectorId}|${item?.server_name || ""}|${item?.tool_namespace || ""}|${toolName}`;
    }
    if (key) records.set(key, hashItem(item));
  }
}
for (const [key, hash] of Array.from(records.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
  process.stdout.write(`${key}\t${hash}\n`);
}
'@
        $tempNodeScript = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-projection-map-{0}.js" -f ([Guid]::NewGuid().ToString("N")))
        try {
            [System.IO.File]::WriteAllText($tempNodeScript, $nodeScript, [System.Text.UTF8Encoding]::new($false))
            foreach ($line in @(& $node.Source $tempNodeScript $Path $ArrayProperty $Kind)) {
                $parts = ([string]$line).Split("`t", 2)
                if ($parts.Count -eq 2 -and -not [string]::IsNullOrWhiteSpace($parts[0])) {
                    $map[$parts[0]] = $parts[1]
                }
            }
            return $map
        } catch {
        } finally {
            if (Test-Path -LiteralPath $tempNodeScript -PathType Leaf) {
                Remove-Item -LiteralPath $tempNodeScript -Force -ErrorAction SilentlyContinue
            }
        }
    }
    foreach ($key in @(Get-ProjectionKeys -Path $Path -ArrayProperty $ArrayProperty -Kind $Kind)) {
        $map[$key] = ""
    }
    return $map
}

function New-ProjectionParity {
    param(
        [string]$SharedPath,
        [string]$LocalPath,
        [string]$ArrayProperty,
        [ValidateSet("connector", "tool")]
        [string]$Kind
    )
    $sharedMap = Get-ProjectionMap -Path $SharedPath -ArrayProperty $ArrayProperty -Kind $Kind
    $localMap = Get-ProjectionMap -Path $LocalPath -ArrayProperty $ArrayProperty -Kind $Kind
    $sharedKeys = @($sharedMap.Keys | Sort-Object -Unique)
    $localKeys = @($localMap.Keys | Sort-Object -Unique)
    $missingShared = @($sharedKeys | Where-Object { $localKeys -notcontains $_ })
    $extraLocal = @($localKeys | Where-Object { $sharedKeys -notcontains $_ })
    $changedShared = @($sharedKeys | Where-Object {
        $localKeys -contains $_ -and
        -not [string]::IsNullOrWhiteSpace([string]$sharedMap[$_]) -and
        -not [string]::IsNullOrWhiteSpace([string]$localMap[$_]) -and
        $sharedMap[$_] -ne $localMap[$_]
    })
    return [pscustomobject]@{
        sharedCount = $sharedKeys.Count
        localCount = $localKeys.Count
        missingShared = $missingShared
        extraLocal = $extraLocal
        changedShared = $changedShared
        checked = $true
    }
}

try {
    $health = Invoke-LocalJson "/health"
    if (-not $health.ok) { Add-Failure "health ok=false" }

    $hasUpstreamProfile = (Has-Property $health "upstreamProfile") -and $null -ne $health.upstreamProfile
    if ($hasUpstreamProfile) {
        $healthMode = if (Has-Property $health.upstreamProfile "mode") { [string]$health.upstreamProfile.mode } else { "unknown" }
        $healthProtocol = if (Has-Property $health.upstreamProfile "protocol") { [string]$health.upstreamProfile.protocol } else { $null }
        $healthModel = if (Has-Property $health.upstreamProfile "model") { [string]$health.upstreamProfile.model } else { $null }
    } elseif (Has-Property $health "mode") {
        $healthMode = [string]$health.mode
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

try {
    $installedPlugins = @(Get-ArrayItems (Invoke-LocalJson "/backend-api/ps/plugins/installed"))
    if ($installedPlugins.Count -lt 1) { Add-Failure "no installed plugins projected" }
} catch {
    Add-Failure "installed plugins endpoint failed: $($_.Exception.Message)"
}

try {
    $pluginsPayload = Invoke-LocalJson "/backend-api/plugins/list"
    $pluginList = @(Get-ArrayItems $pluginsPayload "plugins")
    if ($pluginList.Count -lt 1) { Add-Failure "plugin list is empty" }
} catch {
    Add-Failure "plugin list endpoint failed: $($_.Exception.Message)"
}

try {
    $connectorPayload = Invoke-LocalJson "/backend-api/aip/connectors"
    $connectors = @(Get-ArrayItems $connectorPayload "connectors")
    if ($connectors.Count -lt 1) { Add-Failure "connector directory is empty" }
} catch {
    Add-Failure "connectors endpoint failed: $($_.Exception.Message)"
}

try {
    $whamPayload = Invoke-LocalJson "/backend-api/wham/apps" "POST" @{}
    $whamTools = @(Get-ArrayItems $whamPayload "tools")
} catch {
    Add-Failure "app tools endpoint failed: $($_.Exception.Message)"
}

try {
    $whamPayloadGet = Invoke-LocalJson "/backend-api/wham/apps" "GET"
    $whamToolsGet = @(Get-ArrayItems $whamPayloadGet "tools")
} catch {
    Add-Failure "app tools GET endpoint failed: $($_.Exception.Message)"
}

if ((Get-RemainingVerifierBudgetMs) -lt 2000) {
    Add-Failure "plugin capability verification budget exhausted before local parity scan"
    $previousReport = Get-PreviousPluginCapabilityReport
    $sourceSnapshot = Get-ReusedSourceSnapshot -PreviousReport $previousReport -RefreshSkippedReason "source snapshot refresh skipped because plugin capability verifier budget was exhausted"
    $result = [pscustomobject]@{
        ok = $false
        reportName = "plugin-capabilities"
        shortBudgetMode = $shortBudgetMode
        failures = $failures.ToArray()
        baseUrl = $BaseUrl
        sourceSnapshot = $sourceSnapshot
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
        capabilities = [pscustomobject]@{
            snapshotSource = "anticodex-local-copy"
            nativeCodexWriteback = $false
            capabilityState = "degraded_timeout_budget"
            degraded = $true
            installedPluginCount = @($installedPlugins).Count
            pluginListCount = @($pluginList).Count
            connectorCount = @($connectors).Count
            appToolCount = @($whamTools).Count
            appToolGetCount = @($whamToolsGet).Count
            smoke = [pscustomobject]@{
                checked = $false
                callableState = "skipped_timeout_budget"
            }
        }
    }
    Write-PluginCapabilityReport $result
    exit 1
}

$pluginsWithSkills = @($pluginList | Where-Object {
    (Has-Property $_ "summary") -and (Has-Property $_.summary "skills")
})
$pluginsWithApps = @($installedPlugins | Where-Object {
    (Has-Property $_ "apps") -and (Count-Items $_.apps) -gt 0
})
$pluginsWithMcpServers = @($pluginList | Where-Object {
    (Has-Property $_ "summary") -and (Has-Property $_.summary "mcpServers")
})
$enabledConnectors = @($connectors | Where-Object { -not (Has-Property $_ "isEnabled") -or $_.isEnabled -ne $false })
$accessibleConnectors = @($connectors | Where-Object { (Has-Property $_ "isAccessible") -and $_.isAccessible -eq $true })
$accessibleConnectorIds = @($accessibleConnectors | Where-Object {
    (Has-Property $_ "id") -and -not [string]::IsNullOrWhiteSpace([string]$_.id)
} | ForEach-Object { [string]$_.id })
$unattributedAppTools = @($whamTools | Where-Object { -not (Has-Property $_ "connector_id") -or [string]::IsNullOrWhiteSpace([string]$_.connector_id) })
$unauthorizedAppTools = @($whamTools | Where-Object {
    (Has-Property $_ "connector_id") -and -not [string]::IsNullOrWhiteSpace([string]$_.connector_id) -and ($accessibleConnectorIds -notcontains [string]$_.connector_id)
})
$whamPostToolKeys = @(Get-AppToolKeys $whamTools)
$whamGetToolKeys = @(Get-AppToolKeys $whamToolsGet)
$missingFromWhamGet = @($whamPostToolKeys | Where-Object { $whamGetToolKeys -notcontains $_ })
$extraFromWhamGet = @($whamGetToolKeys | Where-Object { $whamPostToolKeys -notcontains $_ })
$connectorCacheProbe = Test-ProjectionCache $connectorCachePath "connectors"
$appToolsCacheProbe = Test-ProjectionCache $appToolsCachePath "tools"
$connectorParity = New-ProjectionParity -SharedPath $sharedConnectorCachePath -LocalPath $connectorCachePath -ArrayProperty "connectors" -Kind "connector"
$appToolParity = New-ProjectionParity -SharedPath $sharedAppToolsCachePath -LocalPath $appToolsCachePath -ArrayProperty "tools" -Kind "tool"
$connectorCacheSmoke = [pscustomobject]@{
    checked = $connectorCacheProbe.checked
    cacheExists = $connectorCacheProbe.cacheExists
    fileCount = $connectorCacheProbe.fileCount
    sampleReadable = $connectorCacheProbe.sampleReadable
    sampleConnectorCount = $connectorCacheProbe.sampleCount
}
$appToolsCacheSmoke = [pscustomobject]@{
    checked = $appToolsCacheProbe.checked
    cacheExists = $appToolsCacheProbe.cacheExists
    fileCount = $appToolsCacheProbe.fileCount
    sampleReadable = $appToolsCacheProbe.sampleReadable
    sampleToolCount = $appToolsCacheProbe.sampleCount
}

if ($connectors.Count -gt 0 -and -not $connectorCacheSmoke.sampleReadable) {
    Add-Failure "connector endpoint has entries but local connector cache sample is not readable"
}
if ($whamTools.Count -gt 0 -and -not $appToolsCacheSmoke.sampleReadable) {
    Add-Failure "app tools endpoint has tools but local app-tools cache sample is not readable"
}
foreach ($connectorId in @($connectorParity.missingShared)) {
    Add-Failure "shared connector '$connectorId' exists but Anti-Codex local connector cache is missing it"
}
foreach ($connectorId in @($connectorParity.extraLocal)) {
    Add-Failure "Anti-Codex local connector cache has extra connector '$connectorId' that is absent from shared Codex"
}
foreach ($connectorId in @($connectorParity.changedShared)) {
    Add-Failure "shared connector '$connectorId' content differs from Anti-Codex local connector cache"
}
foreach ($toolKey in @($appToolParity.missingShared)) {
    Add-Failure "shared app tool '$toolKey' exists but Anti-Codex local app-tools cache is missing it"
}
foreach ($toolKey in @($appToolParity.extraLocal)) {
    Add-Failure "Anti-Codex local app-tools cache has extra app tool '$toolKey' that is absent from shared Codex"
}
foreach ($toolKey in @($appToolParity.changedShared)) {
    Add-Failure "shared app tool '$toolKey' content differs from Anti-Codex local app-tools cache"
}

# appToolCount=0 is expected when no connectors are marked isAccessible:
# the /backend-api/wham/apps endpoint filters tools to accessible connector IDs only,
# because exposing tools for unlinked/unauthorized connectors would create fake capability.
# See docs/audits/app-tools-gap.md for the full root-cause analysis.
if ($accessibleConnectors.Count -gt 0 -and $whamTools.Count -eq 0) {
    Add-Failure "accessible connectors exist ($($accessibleConnectors.Count)) but no app tools exposed; possible tool-cache mismatch"
}
if ($accessibleConnectors.Count -eq 0 -and $whamTools.Count -gt 0) {
    Add-Failure "app tools exposed without any accessible connector; refusing fake callable capability"
}
if ($unattributedAppTools.Count -gt 0) {
    Add-Failure "app tools exposed without connector_id attribution; refusing fake callable capability"
}
if ($unauthorizedAppTools.Count -gt 0) {
    Add-Failure "app tools exposed for connector_id outside accessible connectors; refusing fake callable capability"
}
if ($missingFromWhamGet.Count -gt 0 -or $extraFromWhamGet.Count -gt 0) {
    Add-Failure "GET /backend-api/wham/apps does not match POST tool projection"
}

$capabilityState = if ($failures.Count -gt 0) {
    "degraded_verification_failed"
} elseif ($installedPlugins.Count -eq 0 -or $pluginList.Count -eq 0 -or $connectors.Count -eq 0) {
    "degraded_missing_local_snapshot"
} elseif ($accessibleConnectors.Count -eq 0) {
    "metadata_only_no_accessible_connectors"
} elseif ($whamTools.Count -eq 0) {
    "degraded_no_tools_for_accessible_connectors"
} else {
    "callable_tools_available"
}
$capabilityDegraded = -not @(
    "callable_tools_available",
    "metadata_only_no_accessible_connectors"
).Contains($capabilityState)
$sourceSnapshot = Get-AntiCodexSourceSnapshot -SharedCodexHome $SharedCodexHome -AgentsSkillsPath $AgentsSkillsPath

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    reportName = "plugin-capabilities"
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    sourceSnapshot = $sourceSnapshot
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
    capabilities = [pscustomobject]@{
        snapshotSource = "anticodex-local-copy"
        nativeCodexWriteback = $false
        capabilityState = $capabilityState
        degraded = $capabilityDegraded
        installedPluginCount = $installedPlugins.Count
        pluginListCount = $pluginList.Count
        pluginsWithSkills = $pluginsWithSkills.Count
        pluginsWithApps = $pluginsWithApps.Count
        pluginsWithMcpServers = $pluginsWithMcpServers.Count
        connectorCount = $connectors.Count
        connectorParity = $connectorParity
        enabledConnectorCount = $enabledConnectors.Count
        accessibleConnectorCount = $accessibleConnectors.Count
        appToolCount = $whamTools.Count
        appToolGetCount = $whamToolsGet.Count
        appToolGetPostParity = [pscustomobject]@{
            checked = $true
            contentMatches = (@($missingFromWhamGet).Count -eq 0 -and @($extraFromWhamGet).Count -eq 0)
            missingFromGet = $missingFromWhamGet
            extraFromGet = $extraFromWhamGet
        }
        appToolParity = $appToolParity
        unattributedAppToolCount = $unattributedAppTools.Count
        unauthorizedAppToolCount = $unauthorizedAppTools.Count
        appToolsNote = if ($accessibleConnectors.Count -eq 0) { "expected 0: no accessible connectors linked" } else { "" }
        smoke = [pscustomobject]@{
            checked = $true
            endpointProjectionReadable = ($installedPlugins.Count -gt 0 -and $pluginList.Count -gt 0 -and $connectors.Count -gt 0)
            connectorCache = $connectorCacheSmoke
            appToolsCache = $appToolsCacheSmoke
            callableState = if ($accessibleConnectors.Count -gt 0 -and $whamTools.Count -gt 0) { "callable_tools_available" } elseif ($accessibleConnectors.Count -eq 0) { "skipped_no_accessible_connectors" } else { "no_tools_for_accessible_connectors" }
        }
        samplePluginIds = @($installedPlugins | Select-Object -First 10 | ForEach-Object { Get-PluginId $_ })
        sampleConnectorNames = @($connectors | Select-Object -First 10 | ForEach-Object { [string]$_.name })
    }
}

Write-PluginCapabilityReport $result
if ($failures.Count -gt 0) { exit 1 }
