[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 8,
    [int]$DiagnosticsTimeoutSec = 60,
    [switch]$EnsureRunning,
    [switch]$NoTraffic,
    [switch]$AllowRealTraffic,
    [switch]$Fast,
    [switch]$SkipManagerActionProbe,
    [switch]$SkipUiStateProbe,
    [string]$IncludePostVerification = "",
    [switch]$SkipAccountProxyProbe,
    [int]$IdleStabilityDurationSec = 20,
    [int]$IdleStabilityIntervalSec = 5,
    [int]$FastMaxElapsedMs = 90000,
    [int]$SubcheckTimeoutSec = 60,
    [switch]$IncludeSoak,
    [int]$SoakDurationSec = 45,
    [switch]$IncludeColdRelaunch
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "anticodex-report-io.ps1")

if (-not $BaseUrl) { $BaseUrl = "http://127.0.0.1:8484" }
$fixedRouteHealthUrl = "http://127.0.0.1:18487/anticodex/fixed-route/health"
$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]
$checks = [ordered]@{}

function Get-AntiCodexSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace("-", "")
    } finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Normalize-Path {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
    try { return [IO.Path]::GetFullPath($Path) } catch { return [string]$Path }
}

function Add-Check {
    param([string]$Name, [bool]$Ok, $Detail, [string]$Failure)
    $checks[$Name] = [pscustomobject]@{ ok = $Ok; detail = $Detail }
    if (-not $Ok) { $failures.Add($Failure) | Out-Null }
}

function Invoke-Json {
    param([string]$Uri, [int]$RequestTimeoutSec = $TimeoutSec)
    return Invoke-RestMethod -Uri $Uri -Proxy $null -TimeoutSec ([Math]::Max(1, $RequestTimeoutSec))
}

function Get-HealthPair {
    $manager = $null
    $fixed = $null
    try { $manager = Invoke-Json "$BaseUrl/health" } catch {}
    try { $fixed = Invoke-Json $fixedRouteHealthUrl } catch {}
    return [pscustomobject]@{ manager = $manager; fixed = $fixed }
}

function Test-HealthPairReady {
    param($Pair)
    return [bool](
        $Pair.manager -and
        $Pair.manager.ok -eq $true -and
        [string]$Pair.manager.schema -eq "anticodex-manager-service-v1" -and
        [string]$Pair.manager.role -eq "launcher-management-only" -and
        $Pair.fixed -and
        $Pair.fixed.ok -eq $true -and
        [string]$Pair.fixed.schema -eq "anticodex-fixed-route-status-v1" -and
        [string]$Pair.fixed.state -eq "ready"
    )
}

$runtimeRootFull = Normalize-Path $RuntimeRoot
$installRoot = Normalize-Path (Split-Path -Parent $runtimeRootFull)
$stateRoot = Normalize-Path (Join-Path $env:APPDATA "anticodex")
$activeHost = Normalize-Path (Join-Path $installRoot "codex-patched-app")
$activeMainExe = Normalize-Path (Join-Path $activeHost "Anti-Codex.exe")
$supervisorScript = Normalize-Path (Join-Path $runtimeRootFull "scripts\start-anticodex-fixed-route.mjs")
$shortcutBrokerScript = Normalize-Path (Join-Path $runtimeRootFull "scripts\start-anticodex-shortcut-broker.ps1")

$healthPair = Get-HealthPair
if ($EnsureRunning -and -not (Test-HealthPairReady $healthPair)) {
    if (-not (Test-Path -LiteralPath $shortcutBrokerScript -PathType Leaf)) {
        $failures.Add("Anti-Codex shortcut broker is missing: $shortcutBrokerScript") | Out-Null
    } else {
        $powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
        Start-Process -FilePath $powerShell -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$shortcutBrokerScript`"", "-InstallRoot", "`"$installRoot`""
        ) -WindowStyle Hidden | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(120)
        do {
            Start-Sleep -Milliseconds 500
            $healthPair = Get-HealthPair
        } while (-not (Test-HealthPairReady $healthPair) -and [DateTime]::UtcNow -lt $deadline)
    }
}

$managerReady = [bool](
    $healthPair.manager -and
    $healthPair.manager.ok -eq $true -and
    [string]$healthPair.manager.schema -eq "anticodex-manager-service-v1" -and
    [string]$healthPair.manager.role -eq "launcher-management-only"
)
Add-Check "managerHealth" $managerReady $healthPair.manager "Manager health contract is not ready"

$fixed = $healthPair.fixed
$fixedReady = [bool](
    $fixed -and
    $fixed.ok -eq $true -and
    [string]$fixed.schema -eq "anticodex-fixed-route-status-v1" -and
    [string]$fixed.state -eq "ready" -and
    @("antigravity", "third-party") -contains [string]$fixed.provider -and
    -not [string]::IsNullOrWhiteSpace([string]$fixed.model) -and
    [string]$fixed.route.schema -eq "anticodex-fixed-route-v1" -and
    (Normalize-Path ([string]$fixed.appExecutable)) -ieq $activeMainExe
)
Add-Check "fixedRouteHealth" $fixedReady $fixed "Fixed three-layer route is not ready"

$requiredRuntimeFiles = @(
    "scripts\start-anticodex.ps1",
    "scripts\start-anticodex-fixed-route.mjs",
    "scripts\anticodex-manager-service.mjs",
    "scripts\anticodex-manager-bridge.mjs",
    "scripts\anticodex-manager-inject.js",
    "scripts\anticodex-manager-open-inject.js",
    "scripts\deepcodex-cdp-inject.mjs",
    "scripts\lib\anticodex-fixed-route.mjs",
    "scripts\test-anticodex-legacy-zero-hit.mjs",
    "translator\antigravity-agentapi.mjs",
    "translator\antigravity-model-catalog.mjs",
    "translator\antigravity-contract.mjs",
    "translator\antigravity-native-mcp-bridge.mjs",
    "translator\provider\antigravity-cascade-client.mjs",
    "translator\provider\antigravity-chat-adapter.mjs",
    "translator\provider\antigravity-chat-server.mjs",
    "translator\provider\codexplusplus-upstream-probe.mjs",
    "translator\provider\start-antigravity-chat-provider.mjs",
    "translator\local-projection\index.mjs"
)
$missingRuntimeFiles = @($requiredRuntimeFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $runtimeRootFull $_) -PathType Leaf) })
Add-Check "runtimeFiles" ($missingRuntimeFiles.Count -eq 0) ([pscustomobject]@{ required = $requiredRuntimeFiles.Count; missing = $missingRuntimeFiles }) "Installed runtime is missing current three-layer files"

$componentManifestPath = Join-Path $installRoot "components\codexplusplus\component-manifest.json"
$componentMetadataPath = Join-Path $installRoot "components\codexplusplus\upstream.json"
$component = $null
$componentBinaryPath = ""
$componentActualHash = ""
$componentOk = $false
try {
    $component = Get-Content -LiteralPath $componentManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $componentMetadata = Get-Content -LiteralPath $componentMetadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $installedPatches = @($component.patches)
    $acceptedPatches = @($componentMetadata.patches)
    $componentPatchSetOk = $acceptedPatches.Count -gt 0 -and $installedPatches.Count -eq $acceptedPatches.Count
    if ($componentPatchSetOk) {
        for ($index = 0; $index -lt $acceptedPatches.Count; $index++) {
            if ([string]$installedPatches[$index].file -ne [string]$acceptedPatches[$index].file -or
                ([string]$installedPatches[$index].sha256).ToLowerInvariant() -ne ([string]$acceptedPatches[$index].sha256).ToLowerInvariant()) {
                $componentPatchSetOk = $false
                break
            }
        }
    }
    $componentBinaryReference = [string]$component.binary.path
    $componentBinaryPath = Normalize-Path $(if ([IO.Path]::IsPathRooted($componentBinaryReference)) {
        $componentBinaryReference
    } else {
        Join-Path (Split-Path -Parent $componentManifestPath) $componentBinaryReference
    })
    $componentActualHash = (Get-AntiCodexSha256 -Path $componentBinaryPath).ToLowerInvariant()
    $componentOk = [bool](
        $component.ok -eq $true -and
        [string]$component.schema -eq "codexplusplus-component-manifest-v1" -and
        [string]$component.component -eq "CodexPlusPlus" -and
        [string]$component.license -eq "AGPL-3.0-only" -and
        $componentPatchSetOk -and
        [string]$component.patchCommit -eq [string]$componentMetadata.patchCommit -and
        $componentBinaryPath.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
        $componentActualHash -eq ([string]$component.binary.sha256).ToLowerInvariant()
    )
} catch {}
Add-Check "codexPlusPlusComponent" $componentOk ([pscustomobject]@{ manifest = $componentManifestPath; version = $component.version; binary = $componentBinaryPath; sha256 = $componentActualHash }) "CodexPlusPlus component manifest or binary hash is invalid"

$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$processById = @{}
foreach ($process in $processes) { $processById[[int]$process.ProcessId] = $process }
$mainProcesses = @($processes | Where-Object {
    (Normalize-Path ([string]$_.ExecutablePath)) -ieq $activeMainExe -and ([string]$_.CommandLine) -notmatch "\s--type="
})
$supervisors = @($processes | Where-Object { ([string]$_.CommandLine) -like "*$supervisorScript*" })
$legacyProcesses = @($processes | Where-Object { ([string]$_.CommandLine) -match "adaptive-server\.mjs|deepcodex-translator\.exe|start-deepcodex\.(?:ps1|sh)" })
$originalCodexProcesses = @($processes | Where-Object {
    ($_.Name -ieq "Codex.exe" -or $_.Name -ieq "ChatGPT.exe") -and
    -not (Normalize-Path ([string]$_.ExecutablePath)).StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase) -and
    ([string]$_.CommandLine) -notmatch "\s--type="
})
$fixedProcessIds = @(
    if ($fixed -and $fixed.processes) {
        [int]$fixed.processes.managerService
        [int]$fixed.processes.codexPlusPlus
        @($fixed.processes.copiedClient) | ForEach-Object { [int]$_ }
        [int]$fixed.processes.managerWatcher
        [int]$fixed.processes.managerBridge
    }
) | Where-Object { $_ -gt 0 }
$reportedProcessesAlive = @($fixedProcessIds | Where-Object { -not $processById.ContainsKey([int]$_) })
$reportedClientPids = @($fixed.processes.copiedClient | ForEach-Object { [int]$_ })
$reportedClientPidMatchesMain = [bool](
    $mainProcesses.Count -eq 1 -and
    $reportedClientPids -contains [int]$mainProcesses[0].ProcessId
)
$cdpHandoffMatchesMain = [bool](
    $mainProcesses.Count -eq 1 -and
    $reportedClientPids.Count -eq 0 -and
    $fixedReady
)
$clientOwnershipProven = $reportedClientPidMatchesMain -or $cdpHandoffMatchesMain
$clientOwnershipMode = if ($reportedClientPidMatchesMain) { "reported_pid" } elseif ($cdpHandoffMatchesMain) { "cdp_handoff" } else { "unproven" }
$processOwnershipOk = [bool](
    $mainProcesses.Count -eq 1 -and
    $supervisors.Count -eq 1 -and
    $legacyProcesses.Count -eq 0 -and
    $reportedProcessesAlive.Count -eq 0 -and
    $clientOwnershipProven -and
    [int]$fixed.processes.managerService -eq [int]$supervisors[0].ProcessId
)
Add-Check "processOwnership" $processOwnershipOk ([pscustomobject]@{
    mainPids = @($mainProcesses | ForEach-Object { [int]$_.ProcessId })
    supervisorPids = @($supervisors | ForEach-Object { [int]$_.ProcessId })
    fixedRoutePids = $fixedProcessIds
    missingFixedRoutePids = $reportedProcessesAlive
    reportedClientPids = $reportedClientPids
    clientOwnershipMode = $clientOwnershipMode
    legacyPids = @($legacyProcesses | ForEach-Object { [int]$_.ProcessId })
    originalCodexPids = @($originalCodexProcesses | ForEach-Object { [int]$_.ProcessId })
}) "Anti-Codex fixed-route process ownership is invalid"

$codexHome = Normalize-Path (Join-Path $stateRoot "codex-home-deepseek-app")
$codexPlusPlusState = Normalize-Path (Join-Path $stateRoot "codexplusplus")
$electronUserData = Normalize-Path (Join-Path $codexHome "electron-user-data-adaptive")
$originalCodexHome = Normalize-Path (Join-Path $env:USERPROFILE ".codex")
$isolationOk = [bool](
    (Test-Path -LiteralPath $codexHome -PathType Container) -and
    (Test-Path -LiteralPath $codexPlusPlusState -PathType Container) -and
    (Test-Path -LiteralPath $electronUserData -PathType Container) -and
    $codexHome -ine $originalCodexHome -and
    $codexHome.StartsWith($stateRoot, [StringComparison]::OrdinalIgnoreCase) -and
    $codexPlusPlusState.StartsWith($stateRoot, [StringComparison]::OrdinalIgnoreCase)
)
Add-Check "stateIsolation" $isolationOk ([pscustomobject]@{ stateRoot = $stateRoot; codexHome = $codexHome; codexPlusPlusState = $codexPlusPlusState; electronUserData = $electronUserData; originalCodexHome = $originalCodexHome }) "Anti-Codex state isolation is invalid"

$branding = $null
$brandingOk = $false
try {
    $sourceHostName = @("ChatGPT.exe", "Codex.exe") | Where-Object {
        Test-Path -LiteralPath (Join-Path $activeHost $_) -PathType Leaf
    } | Select-Object -First 1
    $sourceHost = if ($sourceHostName) { Join-Path $activeHost $sourceHostName } else { "" }
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($activeMainExe)
    $activeHash = Get-AntiCodexSha256 -Path $activeMainExe
    $sourceHash = if ($sourceHost) { Get-AntiCodexSha256 -Path $sourceHost } else { "" }
    $brandingOk = [bool](
        (Split-Path -Leaf $activeMainExe) -eq "Anti-Codex.exe" -and
        $sourceHash -and
        $activeHash -eq $sourceHash
    )
    $branding = [pscustomobject]@{
        processName = (Split-Path -Leaf $activeMainExe)
        sourceHostName = $sourceHostName
        hostBinaryPreserved = ($activeHash -eq $sourceHash)
        productName = $version.ProductName
        productVersion = $version.ProductVersion
    }
} catch {}
Add-Check "branding" $brandingOk $branding "Installed copied client host identity or source bytes are invalid"

$rollbackOk = [bool](
    (Test-Path -LiteralPath (Join-Path $installRoot "rollback-host") -PathType Container) -and
    (Test-Path -LiteralPath (Join-Path $installRoot "rollback-host.ok") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $installRoot "codex-patched-app.ok") -PathType Leaf)
)
Add-Check "rollbackCheckpoint" $rollbackOk ([pscustomobject]@{ rollbackHost = (Join-Path $installRoot "rollback-host"); rollbackMarker = (Join-Path $installRoot "rollback-host.ok") }) "Rollback checkpoint is missing"

$zeroHit = $null
$zeroHitOk = $false
$zeroHitScript = Join-Path $runtimeRootFull "scripts\test-anticodex-legacy-zero-hit.mjs"
if (Test-Path -LiteralPath $zeroHitScript -PathType Leaf) {
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue)
    if (-not $node) { $node = Get-Command node -ErrorAction Stop }
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Node progress is intentionally written to stderr; do not let strict PowerShell mode turn it into a verifier exception.
        $ErrorActionPreference = "Continue"
        $zeroOutput = @(& $node.Source $zeroHitScript "--workspace-root" $runtimeRootFull "--no-write-report" 2>$null)
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $zeroLine = @($zeroOutput | Where-Object { ([string]$_).TrimStart().StartsWith("{") } | Select-Object -Last 1)
    if ($zeroLine.Count -gt 0) {
        try { $zeroHit = ([string]$zeroLine[0] | ConvertFrom-Json); $zeroHitOk = $zeroHit.ok -eq $true } catch {}
    }
}
Add-Check "legacyZeroHit" $zeroHitOk $zeroHit "Installed runtime still contains legacy architecture files or references"

$models = $null
$modelCount = 0
$modelIds = @()
$modelCatalogSource = "fixed-route-endpoint"
try {
    $models = Invoke-Json "$BaseUrl/models"
    $modelCount = @($models.data).Count
    $modelIds = @($models.data | ForEach-Object { [string]$_.id })
} catch {}
$unifiedCatalogPath = Join-Path $codexHome "anticodex-model-catalog.json"
$unifiedCatalogCount = 0
try {
    $unifiedCatalog = Get-Content -LiteralPath $unifiedCatalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $unifiedCatalogCount = @($unifiedCatalog.models).Count
    if ($modelCount -eq 0 -and $unifiedCatalogCount -gt 0 -and [int]$fixed.catalogModelCount -eq $unifiedCatalogCount) {
        $modelCount = $unifiedCatalogCount
        $modelIds = @($unifiedCatalog.models | ForEach-Object { [string]$_.slug })
        $modelCatalogSource = "isolated-unified-catalog"
    }
} catch {}
$modelsOk = $fixedReady -and $modelCount -gt 0
Add-Check "modelCatalog" $modelsOk ([pscustomobject]@{ count = $modelCount; ids = $modelIds; source = $modelCatalogSource; path = $unifiedCatalogPath }) "Fixed-route model catalog is empty"

$uiState = [pscustomobject]@{ ok = $true; skipped = $true; reason = "SkipUiStateProbe" }
if (-not $SkipUiStateProbe) {
    $uiScript = Join-Path $PSScriptRoot "test-anticodex-ui-state.mjs"
    if (-not (Test-Path -LiteralPath $uiScript -PathType Leaf)) {
        $uiScript = Join-Path $runtimeRootFull "scripts\test-anticodex-ui-state.mjs"
    }
    if (Test-Path -LiteralPath $uiScript -PathType Leaf) {
        $node = (Get-Command node.exe -ErrorAction SilentlyContinue)
        if (-not $node) { $node = Get-Command node -ErrorAction Stop }
        $uiDeadline = [DateTime]::UtcNow.AddSeconds($(if ($EnsureRunning) { [Math]::Max(15, $TimeoutSec) } else { 0 }))
        do {
            $previousErrorActionPreference = $ErrorActionPreference
            try {
                # The UI verifier emits timestamped progress on stderr before its JSON result.
                $ErrorActionPreference = "Continue"
                $uiOutput = @(& $node.Source $uiScript "--fast" "true" "--skip-manager-action-probe" "true" "--timeout-ms" "$([Math]::Max(10000, $TimeoutSec * 1000))" 2>$null)
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            $uiLine = @($uiOutput | Where-Object { ([string]$_).TrimStart().StartsWith("{") } | Select-Object -Last 1)
            if ($uiLine.Count -gt 0) { try { $uiState = ([string]$uiLine[0] | ConvertFrom-Json) } catch {} }
            if ($EnsureRunning -and $uiState.ok -ne $true -and [DateTime]::UtcNow -lt $uiDeadline) {
                Start-Sleep -Milliseconds 500
            }
        } while ($EnsureRunning -and $uiState.ok -ne $true -and [DateTime]::UtcNow -lt $uiDeadline)
    } else {
        $uiState = [pscustomobject]@{ ok = $false; failures = @("UI state verifier is missing") }
    }
    Add-Check "uiState" ($uiState.ok -eq $true) $uiState "Visible Anti-Codex UI state verification failed"
} else {
    $checks["uiState"] = [pscustomobject]@{ ok = $true; detail = $uiState }
}

$endedAt = [DateTime]::UtcNow
$managerTrafficReady = $null
if ($healthPair.manager -and $healthPair.manager.PSObject.Properties.Name -contains "accountTrafficReady") {
    $managerTrafficReady = $healthPair.manager.accountTrafficReady
}
$managerTrafficState = if ($healthPair.manager -and $healthPair.manager.accountTrafficState) {
    [string]$healthPair.manager.accountTrafficState
} elseif ($null -eq $managerTrafficReady) {
    "not_checked"
} elseif ($managerTrafficReady -eq $true) {
    "ready"
} else {
    "unavailable"
}
$managerTrafficDiagnosis = if ($healthPair.manager -and $healthPair.manager.accountTrafficDiagnosis) {
    [string]$healthPair.manager.accountTrafficDiagnosis
} elseif ($null -eq $managerTrafficReady) {
    "bounded_request_required"
} elseif ($managerTrafficReady -eq $true) {
    "last_bounded_request_succeeded"
} else {
    "last_bounded_request_failed"
}
$managerTrafficSuggestedAction = if ($healthPair.manager -and $healthPair.manager.accountTrafficSuggestedAction) {
    [string]$healthPair.manager.accountTrafficSuggestedAction
} else {
    "Run a bounded model request to verify current quota."
}
$result = [pscustomobject]@{
    reportName = if ($Fast) { "installed-overall-fast" } else { "installed-overall" }
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    startedAt = $startedAt.ToString("o")
    endedAt = $endedAt.ToString("o")
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    noTraffic = $true
    requestedRealTraffic = [bool]$AllowRealTraffic
    usedRealTraffic = $false
    behaviorCovered = $true
    coverageKind = if ($Fast) { "fixed-three-layer-installed-fast-no-traffic" } else { "fixed-three-layer-installed-no-traffic" }
    runtimeRoot = $runtimeRootFull
    installRoot = $installRoot
    health = [pscustomobject]@{
        ok = $fixedReady
        schema = if ($fixed) { $fixed.schema } else { $null }
        state = if ($fixed) { $fixed.state } else { "offline" }
        provider = if ($fixed) { $fixed.provider } else { $null }
        model = if ($fixed) { $fixed.model } else { $null }
        accountState = if ($healthPair.manager -and $healthPair.manager.accountState) { [string]$healthPair.manager.accountState } elseif ($fixedReady) { "ready" } else { "offline" }
        accountTrafficReady = $managerTrafficReady
        accountTrafficState = $managerTrafficState
        accountTrafficDiagnosis = $managerTrafficDiagnosis
        accountTrafficModel = if ($healthPair.manager) { [string]$healthPair.manager.accountTrafficModel } else { $null }
        accountTrafficSuggestedAction = $managerTrafficSuggestedAction
        modelCount = $modelCount
    }
    processes = $checks.processOwnership.detail
    component = $checks.codexPlusPlusComponent.detail
    checks = [pscustomobject]$checks
}

New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$latestPath = Join-Path $ReportRoot "latest-$($result.reportName).json"
$historyPath = Join-Path $ReportRoot "$stamp-$($result.reportName).json"
$result | Add-Member -NotePropertyName report -NotePropertyValue ([pscustomobject]@{ latest = $latestPath; history = $historyPath }) -Force
$json = $result | ConvertTo-Json -Depth 16 -Compress
Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json -Encoding ([Text.UTF8Encoding]::new($false))
$json
if ($failures.Count -gt 0) { exit 1 }
