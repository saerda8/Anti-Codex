#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$CdpPort = 0,
    [int]$ExpectedOriginalCodexPid = 0,
    [string[]]$Actions = @("updateCheck", "repairShortcuts", "pluginCapabilities", "mcpSkills"),
    [switch]$UiOnlyMatrix,
    [int]$TimeoutSec = 480,
    [int]$MaxAttempts = 2
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}
$BaseUrl = $BaseUrl.TrimEnd("/")
$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Resolve-Node {
    param([string]$InstallRoot)
    $bundled = Join-Path $InstallRoot "codex-patched-app\resources\cua_node\bin\node.exe"
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) { return $node.Source }
    throw "node.exe not found"
}

function Resolve-CdpPort {
    param([int]$RequestedPort)
    if ($RequestedPort -gt 0) { return $RequestedPort }
    $candidatePorts = New-Object System.Collections.Generic.List[int]
    try {
        $antiCodexProcesses = Get-CimInstance Win32_Process -Filter "Name = 'Anti-Codex.exe'" -ErrorAction Stop
        foreach ($process in @($antiCodexProcesses)) {
            $commandLine = [string]$process.CommandLine
            $match = [regex]::Match($commandLine, "--remote-debugging-port=(\d+)")
            if ($match.Success) {
                $candidatePorts.Add([int]$match.Groups[1].Value) | Out-Null
            }
        }
    } catch {}
    $candidatePorts.Add(18318) | Out-Null
    $candidatePorts.Add(58318) | Out-Null
    $candidatePorts.Add(58317) | Out-Null
    foreach ($candidatePort in @($candidatePorts | Select-Object -Unique)) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$candidatePort/json" -Proxy $null -TimeoutSec 2 | Out-Null
            return $candidatePort
        } catch {}
    }
    return 18318
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
    param($Paths, $Payload, [int]$Depth = 16)
    $json = $Payload | ConvertTo-Json -Depth $Depth -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $Paths.latest -HistoryPath $Paths.history -Json $json -Encoding $utf8NoBom
}

function Wait-ManagerButtonProcess {
    param(
        [Diagnostics.Process]$Process,
        [int]$TimeoutSeconds,
        [int]$PollMs = 200
    )
    if (-not $Process) { return $true }
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSeconds))
    while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds ([Math]::Max(50, $PollMs))
        try { $Process.Refresh() } catch {}
    }
    return [bool]$Process.HasExited
}

function Read-TempTextWithRetry {
    param([string]$Path, [int]$TimeoutMs = 3000)
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(100, $TimeoutMs))
    do {
        try {
            $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
            $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
            try {
                $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
                try {
                    return $reader.ReadToEnd()
                } finally {
                    $reader.Dispose()
                }
            } finally {
                $stream.Dispose()
            }
        } catch {
            Start-Sleep -Milliseconds 100
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    try {
        return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    } catch {
        return ""
    }
}

function Clear-ManagerButtonVerifierLock {
    param([int]$ProcessId)
    $lockPath = Join-Path ([IO.Path]::GetTempPath()) "anticodex-manager-button.lock"
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return }
    try {
        $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        if ([int]$lock.pid -eq $ProcessId) {
            Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

function Get-ManagerButtonActionResult {
    param($Payload, [string]$ActionName)
    $batchEntry = $Payload.results.$ActionName
    if ($batchEntry) { return $batchEntry }
    if ($Payload.result -and [string]$Payload.result.action -eq $ActionName) {
        return [pscustomobject]@{
            ok = $Payload.ok
            result = $Payload.result
        }
    }
    return $null
}

function Invoke-ManagerButtonAction {
    param([string]$ActionName, [switch]$RunUiOnlyMatrix)
    if ($RunUiOnlyMatrix) {
        $nodeArgs = @(
            $managerButtonScript,
            "--port", "$resolvedCdpPort",
            "--base-url", $BaseUrl,
            "--report-root", $ReportRoot,
            "--expected-original-codex-pid", "$ExpectedOriginalCodexPid",
            "--ui-only-matrix", "1",
            "--verification-mode", "ui-only",
            "--timeout-ms", "5000",
            "--compact", "1"
        )
    } else {
        $nodeArgs = @(
            $managerButtonScript,
            "--port", "$resolvedCdpPort",
            "--base-url", $BaseUrl,
            "--report-root", $ReportRoot,
            "--expected-original-codex-pid", "$ExpectedOriginalCodexPid",
            "--action", $ActionName,
            "--timeout-ms", "$([Math]::Max(1, $TimeoutSec) * 1000)",
            "--compact", "1"
        )
    }
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    $actionStartedAt = [DateTime]::UtcNow
    $actionExitCode = 0
    try {
        $process = Start-Process -FilePath $node `
            -ArgumentList $nodeArgs `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        [void]$process.Handle
        $processTimeoutSec = if ($RunUiOnlyMatrix) { [Math]::Max(360, $TimeoutSec + 20) } else { [Math]::Max(1, $TimeoutSec + 20) }
        $completed = Wait-ManagerButtonProcess -Process $process -TimeoutSeconds $processTimeoutSec
        if (-not $completed) {
            try { $process.Kill() } catch {}
            Wait-ManagerButtonProcess -Process $process -TimeoutSeconds 3 -PollMs 100 | Out-Null
            Clear-ManagerButtonVerifierLock -ProcessId ([int]$process.Id)
            $actionExitCode = -1
        } else {
            $actionExitCode = [int]$process.ExitCode
        }
        $stdoutText = Read-TempTextWithRetry $stdoutPath
        $stderrText = Read-TempTextWithRetry $stderrPath
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
    $output = @($stdoutText -split "\r?\n" | Where-Object { $_ -ne "" })
    if ($stderrText.Trim()) {
        $output += @($stderrText -split "\r?\n" | Where-Object { $_ -ne "" })
    }
    $lines = @($output | ForEach-Object { [string]$_ })
    $jsonLine = [string](@($lines | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1))
    $payload = $null
    $parseError = $null
    if ($jsonLine) {
        try {
            $payload = $jsonLine | ConvertFrom-Json -ErrorAction Stop
        } catch {
            $parseError = $_.Exception.Message
        }
    }
    return [pscustomobject]@{
        ok = ($actionExitCode -eq 0 -and $payload -and $payload.ok -eq $true)
        action = $ActionName
        exitCode = $actionExitCode
        durationMs = [int]([DateTime]::UtcNow - $actionStartedAt).TotalMilliseconds
        payload = $payload
        parseError = $parseError
        tail = @($lines | Select-Object -Last 20)
    }
}

function Test-TransientManagerButtonFailure {
    param($ActionRun)
    $haystack = @(
        [string]$ActionRun.parseError
        [string]$ActionRun.payload.result.text
        [string]$ActionRun.payload.result.lastSummary
        @($ActionRun.tail) -join "`n"
    ) -join "`n"
    return ($haystack -match "ECONNRESET|manager bridge timed out|still running|仍在运行|正在收尾")
}

function Get-ManagerHandlerContractEvidence {
    param([string]$ScriptsRoot, [string[]]$ActionNames)
    $definitions = [ordered]@{
        refreshStatus = @{ kind = "virtual"; sourceFile = "anticodex-manager-service.mjs"; anchors = @('    refreshStatus: {', 'virtual: true', 'if (actionName === "refreshStatus")') }
        refreshModels = @{ kind = "virtual"; sourceFile = "anticodex-manager-service.mjs"; anchors = @('    refreshModels: {', 'virtual: true', 'if (actionName === "refreshModels")') }
        accountSwitch = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "open-antigravity-account-switch.ps1"; anchors = @('    accountSwitch: {', 'script: "open-antigravity-account-switch.ps1"') }
        accountProxy = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "test-anticodex-account-proxy-readiness.ps1"; anchors = @('    accountProxy: {', 'script: "test-anticodex-account-proxy-readiness.ps1"') }
        syncReadiness = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "test-anticodex-sync-readiness.ps1"; anchors = @('    syncReadiness: {', 'script: "test-anticodex-sync-readiness.ps1"') }
        repairShortcuts = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "repair-anticodex-shortcuts.ps1"; anchors = @('    repairShortcuts: {', 'script: "repair-anticodex-shortcuts.ps1"') }
        updateCheck = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "check-anticodex-update.ps1"; anchors = @('    updateCheck: {', 'script: "check-anticodex-update.ps1"') }
        sourcePreflight = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "test-anticodex-source-preflight.ps1"; anchors = @('    sourcePreflight: {', 'script: "test-anticodex-source-preflight.ps1"') }
        upstreamConfig = @{ kind = "ui-function"; sourceFile = "anticodex-manager-inject.js"; anchors = @('["upstreamConfig",', 'if (action === "upstreamConfig") {', 'await showUpstreamConfig();') }
        mcpSkills = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "test-anticodex-mcp-skills.ps1"; anchors = @('    mcpSkills: {', 'script: "test-anticodex-mcp-skills.ps1"') }
        pluginCapabilities = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "test-anticodex-plugin-capabilities.ps1"; anchors = @('    pluginCapabilities: {', 'script: "test-anticodex-plugin-capabilities.ps1"') }
        diagnosticsBundle = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "collect-anticodex-diagnostics.ps1"; anchors = @('    diagnosticsBundle: {', 'script: "collect-anticodex-diagnostics.ps1"') }
        viewLatestReports = @{ kind = "virtual"; sourceFile = "anticodex-manager-service.mjs"; anchors = @('    viewLatestReports: {', 'virtual: true', 'if (actionName === "viewLatestReports")') }
        syncHost = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "sync-anticodex-launcher.ps1"; anchors = @('    syncHost: {', 'script: "sync-anticodex-launcher.ps1"') }
        refreshFeatures = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "refresh-anticodex-local-features.ps1"; anchors = @('    refreshFeatures: {', 'script: "refresh-anticodex-local-features.ps1"') }
        stabilitySoak = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "test-anticodex-stability-soak.ps1"; anchors = @('    stabilitySoak: {', 'script: "test-anticodex-stability-soak.ps1"') }
        coldRelaunch = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "test-anticodex-cold-relaunch.ps1"; anchors = @('    coldRelaunch: {', 'script: "test-anticodex-cold-relaunch.ps1"') }
        fastOverallNoTraffic = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "test-anticodex-installed-overall.ps1"; anchors = @('    fastOverallNoTraffic: {', 'script: "test-anticodex-installed-overall.ps1"') }
        overallNoTraffic = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "test-anticodex-installed-overall.ps1"; anchors = @('    overallNoTraffic: {', 'script: "test-anticodex-installed-overall.ps1"') }
        postVerificationFull = @{ kind = "script"; sourceFile = "anticodex-manager-service.mjs"; script = "test-anticodex-post-verification.ps1"; anchors = @('    postVerificationFull: {', 'script: "test-anticodex-post-verification.ps1"') }
    }
    $sourceCache = @{}
    $contracts = [ordered]@{}
    foreach ($actionName in $ActionNames) {
        $definition = $definitions[$actionName]
        if (-not $definition) {
            Add-Failure "Manager handler contract definition missing: $actionName"
            continue
        }
        $sourcePath = Join-Path $ScriptsRoot ([string]$definition.sourceFile)
        if (-not $sourceCache.ContainsKey($sourcePath)) {
            $sourceCache[$sourcePath] = if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
                Get-Content -LiteralPath $sourcePath -Raw
            } else { "" }
        }
        $sourceText = [string]$sourceCache[$sourcePath]
        $anchors = @($definition.anchors)
        $anchorsPresent = $true
        if ([string]$definition.sourceFile -eq "anticodex-manager-service.mjs") {
            $actionStart = $sourceText.IndexOf([string]$anchors[0], [StringComparison]::Ordinal)
            if ($actionStart -lt 0) {
                $anchorsPresent = $false
            } else {
                $afterActionStart = $actionStart + ([string]$anchors[0]).Length
                $remainingSource = $sourceText.Substring($afterActionStart)
                $nextActionMatch = [regex]::Match($remainingSource, '(?m)^    [A-Za-z][A-Za-z0-9]*:\s*\{')
                $actionBlockLength = if ($nextActionMatch.Success) { $nextActionMatch.Index } else { $remainingSource.Length }
                $actionBlock = $sourceText.Substring($actionStart, ([string]$anchors[0]).Length + $actionBlockLength)
                if (-not $actionBlock.Contains([string]$anchors[1])) { $anchorsPresent = $false }
                foreach ($anchor in @($anchors | Select-Object -Skip 2)) {
                    if (-not $sourceText.Contains([string]$anchor)) { $anchorsPresent = $false }
                }
            }
        } else {
            foreach ($anchor in $anchors) {
                if (-not $sourceText.Contains([string]$anchor)) { $anchorsPresent = $false }
            }
        }
        $handlerFilePresent = $true
        if ($definition.script) {
            $handlerFilePresent = Test-Path -LiteralPath (Join-Path $ScriptsRoot ([string]$definition.script)) -PathType Leaf
        }
        $verified = [bool]($sourceText -and $anchorsPresent -and $handlerFilePresent)
        if (-not $verified) { Add-Failure "Manager offline handler contract could not be verified: $actionName" }
        $contracts[$actionName] = [pscustomobject]@{
            verified = $verified
            kind = [string]$definition.kind
            source = "scripts/$($definition.sourceFile)"
            handler = if ($definition.script) { [string]$definition.script } else { [string]$definition.kind }
        }
    }
    return [pscustomobject]$contracts
}

$runtimeRootFull = [IO.Path]::GetFullPath($RuntimeRoot)
$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent $runtimeRootFull))
$managerButtonScript = Join-Path $PSScriptRoot "test-anticodex-manager-button.mjs"
if (-not (Test-Path -LiteralPath $managerButtonScript -PathType Leaf)) {
    $managerButtonScript = Join-Path $runtimeRootFull "scripts\test-anticodex-manager-button.mjs"
}
if (-not (Test-Path -LiteralPath $managerButtonScript -PathType Leaf)) {
    throw "Manager button verifier missing: $managerButtonScript"
}

$node = Resolve-Node $installRoot
$resolvedCdpPort = Resolve-CdpPort $CdpPort
$contractScriptsRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "anticodex-manager-service.mjs") -PathType Leaf) {
    $PSScriptRoot
} else {
    Join-Path $runtimeRootFull "scripts"
}
$dailyActions = @(
    "refreshStatus", "refreshModels", "accountSwitch", "accountProxy",
    "syncReadiness", "repairShortcuts", "updateCheck", "sourcePreflight", "upstreamConfig",
    "mcpSkills", "pluginCapabilities", "diagnosticsBundle", "viewLatestReports"
)
$highImpactActions = @(
    "syncHost", "refreshFeatures", "stabilitySoak",
    "coldRelaunch", "fastOverallNoTraffic", "overallNoTraffic", "postVerificationFull"
)
$expectedActions = @(
    "refreshStatus", "refreshModels", "accountSwitch", "accountProxy",
    "syncReadiness", "repairShortcuts", "updateCheck", "sourcePreflight",
    "mcpSkills", "pluginCapabilities", "diagnosticsBundle", "viewLatestReports",
    "syncHost", "upstreamConfig", "refreshFeatures", "stabilitySoak",
    "coldRelaunch", "fastOverallNoTraffic", "overallNoTraffic", "postVerificationFull"
)
$allowedActions = @("updateCheck", "repairShortcuts", "mcpSkills", "pluginCapabilities", "viewLatestReports", "diagnosticsBundle")

if ($UiOnlyMatrix) {
    $reportName = "manager-ui-only-button-matrix"
    $handlerContracts = Get-ManagerHandlerContractEvidence -ScriptsRoot $contractScriptsRoot -ActionNames $expectedActions
    $matrixRun = Invoke-ManagerButtonAction -ActionName "ui-only-matrix" -RunUiOnlyMatrix
    $payload = $matrixRun.payload

    if ($matrixRun.exitCode -eq -1) {
        Add-Failure "Manager UI-only button matrix timed out"
    } elseif ($matrixRun.exitCode -ne 0) {
        Add-Failure "Manager UI-only button matrix failed with exit code $($matrixRun.exitCode)"
    }
    if (-not $payload) {
        Add-Failure "Manager UI-only button matrix did not emit valid JSON"
    } else {
        if ($payload.ok -ne $true) { Add-Failure "Manager UI-only button matrix reported ok=false" }
        if ([string]$payload.mode -ne "ui-only-matrix") { Add-Failure "Manager UI-only button matrix mode evidence is missing" }
        if ($payload.usedRealTraffic -ne $false) { Add-Failure "Manager UI-only button matrix did not prove usedRealTraffic=false" }
        if ($payload.zeroSideEffects -ne $true) { Add-Failure "Manager UI-only button matrix did not prove zeroSideEffects=true" }
        $isolation = $payload.isolationEvidence
        if (-not $isolation) {
            Add-Failure "Manager UI-only bridge isolation evidence is missing"
        } else {
            if ($isolation.batchBeforeRestore.actionShimActive -ne $true) { Add-Failure "Manager UI-only action shim was not active for the full batch" }
            if ($isolation.batchBeforeRestore.requestShimActive -ne $true) { Add-Failure "Manager UI-only request shim was not active for the full batch" }
            if ($isolation.batchRestore.restored -ne $true) { Add-Failure "Manager UI-only bridges were not restored after the batch" }
            if ($isolation.queueUnchanged -ne $true) { Add-Failure "Manager real queue or promise baseline changed during UI-only verification" }
            if (@($isolation.missingStubbedActions).Count -ne 0) { Add-Failure "Manager UI-only action shim did not serve every tested action" }
            if (@($isolation.requestPaths) -notcontains "/anticodex/account") { Add-Failure "Manager UI-only request shim did not serve the account read" }
            if (@($isolation.requestPaths) -notcontains "/models") { Add-Failure "Manager UI-only request shim did not serve the model read" }
            if ([int]$isolation.traffic.requestDelta -ne 0) { Add-Failure "Manager UI-only verification changed the native model request count" }
            if ([int]$isolation.managerBridgeLog.actionReceivedDelta -ne 0) { Add-Failure "Manager UI-only verification reached the real action bridge" }
            if ([int]$isolation.managerBridgeLog.nonHealthRequestReceivedDelta -ne 0) { Add-Failure "Manager UI-only verification reached the real non-health request bridge" }
        }
        $actualActions = @($payload.actions | ForEach-Object { [string]$_ } | Sort-Object)
        $expectedActionSet = @($expectedActions | Sort-Object)
        if (($actualActions -join "|") -ne ($expectedActionSet -join "|")) {
            Add-Failure "Manager UI-only button matrix action coverage drifted from the 20 UI-interaction contract"
        }
        $actualGroupNames = @($payload.actionGroups.PSObject.Properties.Name | Sort-Object)
        $expectedGroupNames = @("status", "modelSources", "updates", "troubleshooting", "advanced" | Sort-Object)
        if (($actualGroupNames -join "|") -ne ($expectedGroupNames -join "|")) {
            Add-Failure "Manager UI-only action groups drifted from the five-group contract"
        }
        $groupedActions = @($payload.actionGroups.PSObject.Properties | ForEach-Object { @($_.Value) } | ForEach-Object { [string]$_ } | Sort-Object)
        if (($groupedActions -join "|") -ne ($expectedActionSet -join "|")) {
            Add-Failure "Manager UI-only action groups do not cover every button exactly once"
        }

        foreach ($actionName in $expectedActions) {
            $entryProperty = $payload.results.PSObject.Properties[$actionName]
            if (-not $entryProperty) {
                Add-Failure "Manager UI-only button result missing: $actionName"
                continue
            }
            $entry = $entryProperty.Value
            $isHighImpact = $highImpactActions -contains $actionName
            $expectedClickCount = if ($isHighImpact) { 2 } else { 1 }
            if ($entry.ok -ne $true) { Add-Failure "Manager UI-only button failed: $actionName" }
            if ($entry.lastUiOnly -ne $true) { Add-Failure "Manager UI-only bridge evidence missing: $actionName" }
            if ($entry.managerOpenedNewPage -ne $false) { Add-Failure "Manager button opened a new page: $actionName" }
            if ($entry.actionActualMouseOk -ne $true) { Add-Failure "Manager native mouse evidence failed: $actionName" }
            if ([int]$entry.actionActualMouseExpectedClickCount -ne $expectedClickCount) { Add-Failure "Manager expected click count is wrong: $actionName" }
            if ([int]$entry.actionActualMouseClickCount -ne $expectedClickCount) { Add-Failure "Manager actual click count is wrong: $actionName" }
            if ([int]$entry.actionActualMouseInputEventCount -ne ($expectedClickCount * 3)) { Add-Failure "Manager CDP mouse event count is wrong: $actionName" }
            if ($entry.actionActualMouseRequiredConfirmation -ne $isHighImpact) { Add-Failure "Manager confirmation classification is wrong: $actionName" }
            if ($isHighImpact -and $entry.actionActualMouseConfirmationArmed -ne $true) { Add-Failure "Manager high-impact confirmation was not armed: $actionName" }
            if ($entry.actionActualMouseConfirmationCleared -ne $true) { Add-Failure "Manager confirmation was not cleared: $actionName" }
            $points = @($entry.actionActualMousePoints)
            if ($points.Count -ne $expectedClickCount) { Add-Failure "Manager live click-point evidence count is wrong: $actionName" }
            foreach ($point in $points) {
                if ([string]$point.hitAction -ne $actionName) { Add-Failure "Manager live click point hit the wrong button: $actionName" }
                if ($null -eq $point.x -or $null -eq $point.y) { Add-Failure "Manager live click point coordinates are missing: $actionName" }
            }
        }
        $uiInteractionVerifiedActions = @($expectedActions | Where-Object {
            $entry = $payload.results.PSObject.Properties[$_].Value
            $entry -and $entry.ok -eq $true -and $entry.lastUiOnly -eq $true `
                -and $entry.managerOpenedNewPage -eq $false -and $entry.actionActualMouseOk -eq $true
        })
        $payload | Add-Member -NotePropertyName uiInteractionEvidence -NotePropertyValue ([pscustomobject]@{
            schema = "anticodex-manager-ui-interaction-v1"
            scope = "ui-interaction-only"
            verifiedActions = $uiInteractionVerifiedActions
            passedCount = $uiInteractionVerifiedActions.Count
        }) -Force
        $payload | Add-Member -NotePropertyName handlerContractEvidence -NotePropertyValue ([pscustomobject]@{
            schema = "anticodex-manager-handler-contract-v1"
            contracts = $handlerContracts
            offlineContractVerifiedActions = @($expectedActions | Where-Object {
                $handlerContracts.PSObject.Properties[$_].Value.verified -eq $true
            })
            safeRealActionAllowlist = $allowedActions
            liveExecutedActions = @()
            pendingAuthorizedActions = $highImpactActions
            allFunctionsVerified = $false
        }) -Force
    }

    $checkedAt = [DateTime]::UtcNow.ToString("o")
    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        generatedAt = $checkedAt
        checkedAt = $checkedAt
        reportName = $reportName
        failures = $failures.ToArray()
        baseUrl = $BaseUrl
        runtimeRoot = $runtimeRootFull
        cdpPort = $resolvedCdpPort
        actions = $expectedActions
        exitCode = [int]$matrixRun.exitCode
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
        processIdentity = $payload.processIdentity
        sessionIdentity = $payload.sessionIdentity
        managerButton = $matrixRun
        tail = @($matrixRun.tail)
    }
    $reportPaths = New-ReportPaths $reportName
    $result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
    Save-JsonReport $reportPaths $result
    $result | ConvertTo-Json -Depth 16 -Compress
    if ($failures.Count -gt 0) { exit 1 }
    exit 0
}

$actionList = @($Actions |
    ForEach-Object { [string]$_ } |
    ForEach-Object { $_ -split "," } |
    ForEach-Object { $_.Trim() } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$allowedActionSet = @{}
foreach ($allowedAction in $allowedActions) { $allowedActionSet[$allowedAction] = $true }
$invalidActions = @($actionList | Where-Object { -not $allowedActionSet.ContainsKey($_) })
foreach ($invalidAction in $invalidActions) {
    Add-Failure "unsupported Manager action requested: $invalidAction"
}
$actionList = @($actionList | Where-Object { $allowedActionSet.ContainsKey($_) })
$releaseRequiredActions = @("updateCheck", "repairShortcuts", "pluginCapabilities", "mcpSkills")
$canonicalReleaseReport = $true
foreach ($requiredAction in $releaseRequiredActions) {
    if ($actionList -notcontains $requiredAction) {
        $canonicalReleaseReport = $false
    }
}
$reportName = if ($canonicalReleaseReport) { "manager-real-buttons" } else { "manager-real-buttons-partial" }
if ($actionList.Count -lt 1) {
    Add-Failure "no Manager actions requested"
}

$managerResults = [ordered]@{}
$latestIdentityPayload = $null
$exitCode = 0
$tail = @()
if ($actionList.Count -gt 0) {
    foreach ($actionName in $actionList) {
        $actionRun = $null
        for ($attempt = 1; $attempt -le [Math]::Max(1, $MaxAttempts); $attempt++) {
            $actionRun = Invoke-ManagerButtonAction $actionName
            if ($actionRun.ok -eq $true) { break }
            if ($attempt -ge [Math]::Max(1, $MaxAttempts)) { break }
            if (-not (Test-TransientManagerButtonFailure $actionRun)) { break }
            Start-Sleep -Seconds 5
        }
        $managerResults[$actionName] = $actionRun
        $exitCode = if ($exitCode -ne 0) { $exitCode } else { [int]$actionRun.exitCode }
        $tail = @($actionRun.tail)
        if ($actionRun.exitCode -eq -1) {
            Add-Failure "manager button verifier timed out after $TimeoutSec seconds: $actionName"
        } elseif ($actionRun.exitCode -ne 0) {
            Add-Failure "manager button verifier failed with exit code $($actionRun.exitCode): $actionName"
        }
        if (-not $actionRun.payload) {
            if ($actionRun.parseError) {
                Add-Failure "manager button verifier emitted invalid JSON for ${actionName}: $($actionRun.parseError)"
            } else {
                Add-Failure "manager button verifier did not emit JSON for $actionName"
            }
            continue
        }
        $latestIdentityPayload = $actionRun.payload
        if ($actionRun.payload.ok -ne $true) {
            Add-Failure "manager button verifier reported ok=false: $actionName"
        }
        $entry = Get-ManagerButtonActionResult $actionRun.payload $actionName
        if (-not $entry) {
            Add-Failure "manager button result missing for $actionName"
            continue
        }
        if ($entry.ok -ne $true) {
            Add-Failure "manager button action failed: $actionName"
        }
        if ($entry.result.lastUiOnly -eq $true) {
            Add-Failure "manager button action used ui-only smoke instead of real bridge: $actionName"
        }
        if ([string]$entry.result.text -match "ui-only manager button smoke|ui-only-manager-button") {
            Add-Failure "manager button action left ui-only smoke text visible: $actionName"
        }
    }
}

$checkedAt = [DateTime]::UtcNow.ToString("o")
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    generatedAt = $checkedAt
    checkedAt = $checkedAt
    reportName = $reportName
    canonicalReleaseReport = $canonicalReleaseReport
    releaseRequiredActions = $releaseRequiredActions
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    runtimeRoot = $runtimeRootFull
    cdpPort = $resolvedCdpPort
    actions = $actionList
    exitCode = $exitCode
    elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    processIdentity = $latestIdentityPayload.processIdentity
    sessionIdentity = $latestIdentityPayload.sessionIdentity
    managerButton = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        results = $managerResults
    }
    tail = $tail
}

$reportPaths = New-ReportPaths $reportName
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
Save-JsonReport $reportPaths $result
$result | ConvertTo-Json -Depth 14 -Compress
if ($failures.Count -gt 0) { exit 1 }
