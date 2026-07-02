#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$OutputRoot = $(Join-Path $env:APPDATA "anticodex\diagnostic-bundles"),
    [int]$LogTailLines = 200,
    [int]$KeepBundles = 10,
    [switch]$NoPopup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $scriptRoot)))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRoot -ne $expectedRoot) { throw "Anti-Codex diagnostics may only run from $expectedRoot" }
if (-not $BaseUrl) { $BaseUrl = [string](& (Join-Path $scriptRoot "resolve-anticodex-base-url.ps1")) }

$stateRoot = Join-Path $env:APPDATA "anticodex"
$reportsRoot = Join-Path $stateRoot "reports"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$bundleRoot = Join-Path $OutputRoot $stamp
$sensitivePattern = "(?<![A-Za-z])prompt(?![A-Za-z])|(?<![A-Za-z])messages(?![A-Za-z])|input_items|tool output|Return exactly this"

function Remove-OldDiagnosticBundles {
    param([string]$Root, [int]$Keep = 10)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    $keepCount = [Math]::Max(1, $Keep)
    $entries = @()
    $entries += Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "^\d{8}-\d{6}$" } |
        ForEach-Object {
            [pscustomobject]@{
                stamp = $_.Name
                path = $_.FullName
                kind = "directory"
                time = $_.LastWriteTimeUtc
            }
        }
    $entries += Get-ChildItem -LiteralPath $Root -Filter "*.zip" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -match "^\d{8}-\d{6}$" } |
        ForEach-Object {
            [pscustomobject]@{
                stamp = $_.BaseName
                path = $_.FullName
                kind = "zip"
                time = $_.LastWriteTimeUtc
            }
        }
    $keepStamps = @($entries |
        Group-Object stamp |
        Sort-Object { ($_.Group | Sort-Object time -Descending | Select-Object -First 1).time } -Descending |
        Select-Object -First $keepCount |
        ForEach-Object { $_.Name })
    $keepSet = @{}
    foreach ($item in $keepStamps) { $keepSet[$item] = $true }
    foreach ($entry in $entries) {
        if (-not $keepSet.ContainsKey($entry.stamp)) {
            Remove-Item -LiteralPath $entry.path -Recurse:($entry.kind -eq "directory") -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-JsonFile {
    param([string]$Path, $Value, [int]$Depth = 12, [switch]$AllowSafeSummaryFields)
    $json = $Value | ConvertTo-Json -Depth $Depth
    if ((-not $AllowSafeSummaryFields) -and $json -match $sensitivePattern) {
        $json = (@{
            redacted = $true
            reason = "Sensitive transcript-like fields were not included in the diagnostic bundle."
        } | ConvertTo-Json)
    }
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-ReportIntegrity {
    param([string]$Path)
    $sidecar = "$Path.sha256"
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
        return [pscustomobject]@{
            signed = $false
            valid = $null
            hash = ""
            expected = ""
            sidecar = $sidecar
            error = "missing_hash_sidecar"
        }
    }
    try {
        $rawExpected = (Get-Content -LiteralPath $sidecar -Raw -Encoding ASCII).Trim()
        if ($rawExpected -notmatch "^(?:sha256:)?([a-fA-F0-9]{64})$") {
            return [pscustomobject]@{
                signed = $true
                valid = $false
                hash = ""
                expected = $rawExpected
                sidecar = $sidecar
                error = "invalid_hash_sidecar"
            }
        }
        $expected = $Matches[1].ToLowerInvariant()
        $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        return [pscustomobject]@{
            signed = $true
            valid = ($hash -eq $expected)
            hash = $hash
            expected = $expected
            sidecar = $sidecar
            error = if ($hash -eq $expected) { "" } else { "hash_mismatch" }
        }
    } catch {
        return [pscustomobject]@{
            signed = $true
            valid = $false
            hash = ""
            expected = ""
            sidecar = $sidecar
            error = $_.Exception.Message
        }
    }
}

function Try-InvokeJson {
    param([string]$Path)
    try {
        return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec 8
    } catch {
        return [pscustomobject]@{
            ok = $false
            error = $_.Exception.Message
        }
    }
}

function Get-DiagnosticsSnapshotSummary {
    param($Diagnostics)
    $longTasks = if ($Diagnostics -and ($Diagnostics.PSObject.Properties.Name -contains "longTasks")) { $Diagnostics.longTasks } else { $null }
    $items = if ($longTasks -and ($longTasks.PSObject.Properties.Name -contains "items")) { @($longTasks.items) } else { @() }
    $syncHost = @($items | Where-Object { [string]$_.id -eq "syncHost" } | Select-Object -First 1)
    $postVerification = @($items | Where-Object { [string]$_.id -eq "postVerificationFull" } | Select-Object -First 1)
    $otherRunningItems = @($items | Where-Object {
        [string]$_.id -ne "syncHost" -and
        [string]$_.id -ne "postVerificationFull" -and
        ([string]$_.state -eq "running" -or [string]$_.rawState -eq "running" -or [string]$_.stage -eq "manager_foreground")
    } | Select-Object -First 5 | ForEach-Object {
        [pscustomobject]@{
            id = [string]$_.id
            label = [string]$_.label
            state = [string]$_.state
            stage = [string]$_.stage
            elapsedMs = $_.elapsedMs
            latestLogLine = [string]$_.latestLogLine
        }
    })
    return [pscustomobject]@{
        ok = if ($longTasks -and ($longTasks.PSObject.Properties.Name -contains "ok")) { [bool]$longTasks.ok } else { $false }
        longTasks = [pscustomobject]@{
            runningCount = if ($longTasks -and ($longTasks.PSObject.Properties.Name -contains "runningCount")) { $longTasks.runningCount } else { 0 }
            attentionCount = if ($longTasks -and ($longTasks.PSObject.Properties.Name -contains "attentionCount")) { $longTasks.attentionCount } else { 0 }
            itemCount = $items.Count
            syncHostState = if ($syncHost.Count -gt 0) { [string]$syncHost[0].state } else { "" }
            postVerificationState = if ($postVerification.Count -gt 0) { [string]$postVerification[0].state } else { "" }
            latestLogLine = [string](@($items | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.latestLogLine) } | Select-Object -First 1).latestLogLine)
            otherRunningItems = @($otherRunningItems)
        }
    }
}

function Resolve-NodeForJsonSummary {
    $bundledNode = Join-Path $installRoot "codex-patched-app\resources\cua_node\bin\node.exe"
    if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { return $bundledNode }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { return $nodeCommand.Source }
    throw "node.exe is required to summarize diagnostic reports"
}

function Invoke-NodeJsonSummary {
    param([string]$Path)
    $nodePath = Resolve-NodeForJsonSummary
    $summaryScript = Join-Path $scriptRoot "summarize-anticodex-report.mjs"
    if (-not (Test-Path -LiteralPath $summaryScript -PathType Leaf)) { throw "Missing summarize-anticodex-report.mjs" }
    $output = & $nodePath $summaryScript $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($output | Out-String).Trim()) }
    return (($output | Out-String).Trim() | ConvertFrom-Json)
}

function Read-JsonSummary {
    param([string]$Path)
    $integrity = Get-ReportIntegrity $Path
    try {
        $json = Invoke-NodeJsonSummary -Path $Path
        return [pscustomobject]@{
            file = Split-Path -Leaf $Path
            ok = $json.ok
            effectiveOk = $json.effectiveOk
            reportName = $json.reportName
            skipFullRegression = $json.skipFullRegression
            failureCount = $json.failureCount
            elapsedMs = $json.elapsedMs
            actions = @($json.actions | ForEach-Object { [string]$_ })
            managerButtonOk = $json.managerButtonOk
            managerButtonResults = @($json.managerButtonResults)
            javascriptSyntaxOk = $json.javascriptSyntaxOk
            powershellSyntaxOk = $json.powershellSyntaxOk
            uiStateSelfTestOk = $json.uiStateSelfTestOk
            upstreamProfileStorageOk = $json.upstreamProfileStorageOk
            antigravityCliIsolationProfileOk = $json.antigravityCliIsolationProfileOk
            antigravityCliIsolationProfileContract = $json.antigravityCliIsolationProfileContract
            antigravityCliDualAccountLanesOk = $json.antigravityCliDualAccountLanesOk
            antigravityCliDualAccountLanesContract = $json.antigravityCliDualAccountLanesContract
            antigravityCliProfilePrepareOk = $json.antigravityCliProfilePrepareOk
            antigravityCliProfilePrepareRejectsDefaultChildOk = $json.antigravityCliProfilePrepareRejectsDefaultChildOk
            antigravityCliProfilePrepareContract = $json.antigravityCliProfilePrepareContract
            antigravityCliWindowsUserLoginDryRunOk = $json.antigravityCliWindowsUserLoginDryRunOk
            antigravityCliWindowsUserLoginDryRunContract = $json.antigravityCliWindowsUserLoginDryRunContract
            localConnectorVerifierOk = $json.localConnectorVerifierOk
            publicDocumentationOk = $json.publicDocumentationOk
            publicDocumentationClientCopySyncContractOk = $json.publicDocumentationClientCopySyncContractOk
            translatorRegressionOk = $json.translatorRegressionOk
            diffWhitespaceOk = $json.diffWhitespaceOk
            baseUrl = $json.baseUrl
            modelCount = $json.modelCount
            models = @($json.models | ForEach-Object { [string]$_ })
            modelThinkingEvidence = $json.modelThinkingEvidence
            ambientSuggestionsEvidence = $json.ambientSuggestionsEvidence
            uiChatSmokeEvidence = $json.uiChatSmokeEvidence
            uiWebSearchSmokeEvidence = $json.uiWebSearchSmokeEvidence
            uiLocalProjectEvidence = $json.uiLocalProjectEvidence
            uiCodingProjectEvidence = $json.uiCodingProjectEvidence
            uiMultiTurnProjectEvidence = $json.uiMultiTurnProjectEvidence
            uiRepoFileEditEvidence = $json.uiRepoFileEditEvidence
            uiRepoMultiFileEditEvidence = $json.uiRepoMultiFileEditEvidence
            uiComplexProjectEvidence = $json.uiComplexProjectEvidence
            uiReportSiteEvidence = $json.uiReportSiteEvidence
            antigravityCliProfilePrepareEvidence = $json.antigravityCliProfilePrepareEvidence
            antigravityCliDualAccountLanesEvidence = $json.antigravityCliDualAccountLanesEvidence
            antigravityCliWindowsUserReadinessEvidence = $json.antigravityCliWindowsUserReadinessEvidence
            windowsUserAccountPrepareEvidence = $json.windowsUserAccountPrepareEvidence
            windowsUserSetupGuidanceEvidence = $json.windowsUserSetupGuidanceEvidence
            secondAccountLoginEntrypointEvidence = $json.secondAccountLoginEntrypointEvidence
            secondAccountReadinessSummaryEvidence = $json.secondAccountReadinessSummaryEvidence
            secondAccountPostLoginProofEvidence = $json.secondAccountPostLoginProofEvidence
            antigravityCliRealSmokeEvidence = $json.antigravityCliRealSmokeEvidence
            skipRequests = $json.skipRequests
            modelRoutingEvidence = $json.modelRoutingEvidence
            toolBridgeEvidence = $json.toolBridgeEvidence
            uiIdleEvidence = $json.uiIdleEvidence
            syncReadinessEvidence = $json.syncReadinessEvidence
            installedOverallEvidence = $json.installedOverallEvidence
            desktopTaskSuiteEvidence = $json.desktopTaskSuiteEvidence
            goalReadinessEvidence = $json.goalReadinessEvidence
            cliTransportBoundaryEvidence = $json.cliTransportBoundaryEvidence
            longTaskLandingMatrixEvidence = $json.longTaskLandingMatrixEvidence
            agenticCapabilityMatrixEvidence = $json.agenticCapabilityMatrixEvidence
            realTaskCoverageRoadmapEvidence = $json.realTaskCoverageRoadmapEvidence
            nativeCodexParityTaskMatrixEvidence = $json.nativeCodexParityTaskMatrixEvidence
            realApprovalPlanEvidence = $json.realApprovalPlanEvidence
            requiredRealTrafficSequenceEvidence = $json.requiredRealTrafficSequenceEvidence
            goalRealRunReadinessEvidence = $json.goalRealRunReadinessEvidence
            approvedRealRunSequenceEvidence = $json.approvedRealRunSequenceEvidence
            workerMcpServerProbeEvidence = $json.workerMcpServerProbeEvidence
            workerMcpSourceHygieneEvidence = $json.workerMcpSourceHygieneEvidence
            workerMcpTaskSmokeEvidence = $json.workerMcpTaskSmokeEvidence
            workerMcpProjectSmokeEvidence = $json.workerMcpProjectSmokeEvidence
            currentChannelWorkerTransportEvidence = $json.currentChannelWorkerTransportEvidence
            coldRelaunchEvidence = $json.coldRelaunchEvidence
            stabilitySoakEvidence = $json.stabilitySoakEvidence
            state = $json.state
            skipped = $json.skipped
            reason = $json.reason
            coveredBy = $json.coveredBy
            noTraffic = $json.noTraffic
            behaviorCovered = $json.behaviorCovered
            coverageKind = $json.coverageKind
            usedRealTraffic = $json.usedRealTraffic
            requestedRealTraffic = $json.requestedRealTraffic
            latestDiagnosis = $json.latestDiagnosis
            latestDiagnosisDetail = $json.latestDiagnosisDetail
            accountProxyEvidence = $json.accountProxyEvidence
            attempts = $json.attempts
            repairedCount = $json.repairedCount
            repairedAt = $json.repairedAt
            releaseReady = $json.releaseReady
            shortReady = $json.shortReady
            releaseBlockedOnlyByRequiredRealTraffic = $json.releaseBlockedOnlyByRequiredRealTraffic
            requiredRealTrafficBlockedGates = @($json.requiredRealTrafficBlockedGates | ForEach-Object { [string]$_ })
            strictOptionalRealTraffic = $json.strictOptionalRealTraffic
            optionalRealTrafficReady = $json.optionalRealTrafficReady
            optionalRealTrafficFailures = @($json.optionalRealTrafficFailures | ForEach-Object { [string]$_ })
            missingRequired = @($json.missingRequired | ForEach-Object { [string]$_ })
            missingShort = @($json.missingShort | ForEach-Object { [string]$_ })
            missingOptional = @($json.missingOptional | ForEach-Object { [string]$_ })
            damagedReports = @($json.damagedReports | ForEach-Object { [string]$_ })
            releaseGateFailures = @($json.releaseGateFailures)
            releaseGateFailureReasons = @($json.releaseGateFailureReasons)
            nextActions = @($json.nextActions)
            nextActionsAvailableCount = $json.nextActionsAvailableCount
            nextActionsHiddenCount = $json.nextActionsHiddenCount
            nextActionsTruncated = $json.nextActionsTruncated
            approvalPlan = $json.approvalPlan
            releaseGateGroups = @($json.releaseGateGroups)
            releaseGateSelectedReports = @($json.releaseGateSelectedReports)
            installedRuntimeEvidence = $json.installedRuntimeEvidence
            upstreamFullUrlAccepted = $json.upstreamFullUrlAccepted
            unauthorizedManagerBlocked = $json.unauthorizedManagerBlocked
            savedWithoutHistoryLoss = $json.savedWithoutHistoryLoss
            restoredAntigravityWithoutHistoryLoss = $json.restoredAntigravityWithoutHistoryLoss
            restartedProviderWithoutHistoryLoss = $json.restartedProviderWithoutHistoryLoss
            switchedProviderWithoutHistoryLoss = $json.switchedProviderWithoutHistoryLoss
            crossProtocolWithoutHistoryLoss = $json.crossProtocolWithoutHistoryLoss
            reverseCrossProtocolWithoutHistoryLoss = $json.reverseCrossProtocolWithoutHistoryLoss
            secretsRedacted = $json.secretsRedacted
            localConnectorEvidence = $json.localConnectorEvidence
            sourceSnapshotEvidence = $json.sourceSnapshotEvidence
            logDbGuardEvidence = $json.logDbGuardEvidence
            missingHistoryEvidence = $json.missingHistoryEvidence
            refreshFeatureEvidence = $json.refreshFeatureEvidence
            mcpSkillEvidence = $json.mcpSkillEvidence
            pluginCapabilityEvidence = $json.pluginCapabilityEvidence
            optionalRealProviderEvidence = $json.optionalRealProviderEvidence
            antigravityReturnEvidence = $json.antigravityReturnEvidence
            providerContinuity = $json.providerContinuity
            integrity = $integrity
            error = if ($integrity.signed -and $integrity.valid -eq $false) { "report hash validation failed: $($integrity.error)" } else { "" }
        }
    } catch {
        return [pscustomobject]@{
            file = Split-Path -Leaf $Path
            ok = $false
            error = $_.Exception.Message
            integrity = $integrity
        }
    }
}

function Copy-LogTail {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return }
    $tail = Get-Content -LiteralPath $Source -Tail $LogTailLines -ErrorAction SilentlyContinue
    $text = ($tail -join "`r`n")
    if ($text -match $sensitivePattern) {
        $text = "[redacted: transcript-like content detected]"
    }
    Set-Content -LiteralPath $Destination -Value $text -Encoding UTF8
}

function Update-NoTrafficModelRoutingReport {
    $scriptPath = Join-Path $scriptRoot "test-anticodex-model-routing.ps1"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return [pscustomobject]@{
            ok = $false
            error = "Missing test-anticodex-model-routing.ps1"
        }
    }
    try {
        $result = & $scriptPath -BaseUrl $BaseUrl -SkipRefresh -SkipRequests | ConvertFrom-Json
        $resultFailures = if ($result.PSObject.Properties.Name -contains "failures") { @($result.failures) } else { @() }
        $resultModels = if ($result.PSObject.Properties.Name -contains "models") { @($result.models | ForEach-Object { [string]$_ }) } else { @() }
        return [pscustomobject]@{
            ok = [bool]$result.ok
            failures = @($resultFailures)
            modelCount = if ($result.PSObject.Properties.Name -contains "modelCount") { $result.modelCount } else { $null }
            models = @($resultModels)
            skipRequests = if ($result.PSObject.Properties.Name -contains "skipRequests") { [bool]$result.skipRequests } else { $null }
            report = if ($result.PSObject.Properties.Name -contains "report") { $result.report } else { $null }
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            error = $_.Exception.Message
        }
    }
}

function Update-WorkerMcpServerProbeReport {
    $scriptPath = Join-Path $scriptRoot "probe-anticodex-worker-mcp-servers.mjs"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return [pscustomobject]@{
            ok = $false
            error = "Missing probe-anticodex-worker-mcp-servers.mjs"
        }
    }
    try {
        $nodePath = Resolve-NodeForJsonSummary
        $result = & $nodePath $scriptPath --report-root $reportsRoot 2>&1 | ConvertFrom-Json
        return $result
    } catch {
        return [pscustomobject]@{
            ok = $false
            error = $_.Exception.Message
        }
    }
}

New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleRoot "logs") -Force | Out-Null

Write-JsonFile (Join-Path $bundleRoot "health.json") (Try-InvokeJson "/health")
$diagnosticsSnapshot = Try-InvokeJson "/anticodex/diagnostics"
Write-JsonFile (Join-Path $bundleRoot "diagnostics.json") $diagnosticsSnapshot
$diagnosticsSummary = Get-DiagnosticsSnapshotSummary $diagnosticsSnapshot
Write-JsonFile (Join-Path $bundleRoot "diagnostics-summary.json") $diagnosticsSummary
if ($diagnosticsSnapshot -and ($diagnosticsSnapshot.PSObject.Properties.Name -contains "logDbGuard")) {
    Write-JsonFile (Join-Path $bundleRoot "log-db-guard.json") $diagnosticsSnapshot.logDbGuard
}
Write-JsonFile (Join-Path $bundleRoot "account.json") (Try-InvokeJson "/anticodex/account")
Write-JsonFile (Join-Path $bundleRoot "models.json") (Try-InvokeJson "/models")
Write-JsonFile (Join-Path $bundleRoot "model-routing-refresh.json") (Update-NoTrafficModelRoutingReport)
Write-JsonFile (Join-Path $bundleRoot "worker-mcp-server-probe.json") (Update-WorkerMcpServerProbeReport) -AllowSafeSummaryFields

$updateStatus = try {
    & (Join-Path $scriptRoot "check-anticodex-update.ps1") -InstallRoot $installRoot -NoPersist | ConvertFrom-Json
} catch {
    [pscustomobject]@{ ok = $false; error = $_.Exception.Message }
}
Write-JsonFile (Join-Path $bundleRoot "update-status.json") $updateStatus

$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @("Anti-Codex.exe", "codex.exe", "deepcodex-translator.exe", "Antigravity.exe", "Antigravity IDE.exe")
} | ForEach-Object {
    [pscustomobject]@{
        name = [string]$_.Name
        processId = [int]$_.ProcessId
        executablePath = [string]$_.ExecutablePath
    }
})
Write-JsonFile (Join-Path $bundleRoot "processes.json") $processes

$latestReports = @(
    "latest-installed-overall.json",
    "latest-installed-overall-fast.json",
    "latest-sync-readiness.json",
    "latest-diagnostics.json",
    "latest-tool-bridge-mode.json",
    "latest-account-proxy-readiness.json",
    "latest-post-verification.json",
    "latest-codex-responses.json",
    "latest-desktop-task-suite.json",
    "latest-cli-transport-boundary.json",
    "latest-long-task-landing-matrix.json",
    "latest-native-codex-parity-task-matrix.json",
    "latest-goal-readiness.json",
    "latest-agentic-capability-matrix.json",
    "latest-real-task-coverage-roadmap.json",
    "latest-real-approval-plan.json",
    "latest-required-real-traffic-sequence.json",
    "latest-goal-real-run-readiness.json",
    "latest-approved-real-run-sequence.json",
    "latest-worker-mcp-server-probe.json",
    "latest-worker-mcp-source-hygiene.json",
    "latest-worker-mcp-task-smoke.json",
    "latest-worker-mcp-project-smoke.json",
    "latest-current-channel-worker-transport.json",
    "latest-ui-chat-smoke.json",
    "latest-ui-web-search-smoke.json",
    "latest-ui-local-project-smoke.json",
    "latest-ui-coding-project-smoke.json",
    "latest-ui-multi-turn-project-smoke.json",
    "latest-ui-repo-file-edit-smoke.json",
    "latest-ui-repo-multi-file-edit-smoke.json",
    "latest-ui-complex-project-smoke.json",
    "latest-ui-report-site-smoke.json",
    "latest-real-work.json",
    "latest-real-mini-tool.json",
    "latest-real-small-project.json",
    "latest-native-tool-loop.json",
    "latest-tool-loop.json",
    "latest-native-multi-tool-loop.json",
    "latest-mcp-tool-loop.json",
    "latest-custom-tool-loop.json",
    "latest-compaction-resume.json",
    "latest-cancellation.json",
    "latest-web-tools.json",
    "latest-source-preflight.json",
    "latest-mcp-skills.json",
    "latest-plugin-capabilities.json",
    "latest-local-connectors.json",
    "latest-release-gates.json",
    "latest-cold-relaunch.json",
    "latest-third-party-provider.json",
    "latest-missing-history.json",
    "latest-real-third-party-provider.json",
    "latest-provider-antigravity-return.json",
    "latest-antigravity-cli-profile-prepare.json",
    "latest-antigravity-cli-windows-user-readiness.json",
    "latest-windows-user-account-prepare.json",
    "latest-windows-user-setup-guidance.json",
    "latest-antigravity-account-isolation-status.json",
    "latest-second-antigravity-account-login-entrypoint.json",
    "latest-second-account-readiness-summary.json",
    "latest-second-account-post-login-proof.json",
    "latest-antigravity-cli-real-smoke.json",
    "latest-manager-real-buttons.json",
    "latest-refresh-features.json",
    "latest-stability-soak.json",
    "latest-shortcut-repair.json",
    "latest-model-routing.json",
    "latest-model-thinking.json",
    "latest-ambient-suggestions.json",
    "latest-log-db-guard.json",
    "latest-ui-idle-stability.json"
)
$reportSummaries = foreach ($name in $latestReports) {
    $path = Join-Path $reportsRoot $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { Read-JsonSummary $path }
}
$damagedReports = @($reportSummaries | Where-Object {
    ($_.PSObject.Properties.Name -contains "error") -and -not [string]::IsNullOrWhiteSpace([string]$_.error)
} | ForEach-Object {
    [pscustomobject]@{
        file = [string]$_.file
        error = [string]$_.error
    }
})
Write-JsonFile (Join-Path $bundleRoot "reports-summary.json") @($reportSummaries) -AllowSafeSummaryFields

$logs = @(
    "adaptive-translator.err.log",
    "adaptive-translator.log",
    "adaptive-translator-start.log",
    "anticodex-launcher.err.log",
    "anticodex-launcher.out.log",
    "deepcodex-lifecycle.log",
    "translator-lifecycle.json",
    "translator-lifecycle.jsonl",
    "model-refresh.log"
)
foreach ($name in $logs) {
    Copy-LogTail -Source (Join-Path $stateRoot $name) -Destination (Join-Path (Join-Path $bundleRoot "logs") $name)
}

$excluded = @("logs_2.sqlite", "logs_2.sqlite-shm", "logs_2.sqlite-wal")
Write-JsonFile (Join-Path $bundleRoot "privacy-policy.json") ([pscustomobject]@{
    collectedAt = [DateTime]::UtcNow.ToString("o")
    baseUrl = $BaseUrl
    excluded = $excluded
    notes = @(
        "Conversation databases, auth files, environment files, and transcript-like fields are not included.",
        "Report files are summarized instead of copied raw."
    )
})

$zipPath = "$bundleRoot.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -LiteralPath $bundleRoot -DestinationPath $zipPath -Force
if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
    throw "Diagnostic bundle zip was not created: $zipPath"
}
Remove-OldDiagnosticBundles -Root $OutputRoot -Keep $KeepBundles

$result = [pscustomobject]@{
    ok = ($damagedReports.Count -eq 0)
    bundleRoot = $bundleRoot
    zipPath = $zipPath
    retainedBundles = [Math]::Max(1, $KeepBundles)
    damagedReports = $damagedReports
    diagnosticsSummary = $diagnosticsSummary
}
if (-not $NoPopup) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup("Anti-Codex diagnostic bundle created:`n$zipPath", 12, "Anti-Codex Diagnostics", 64) | Out-Null
    } catch {}
}
$result | ConvertTo-Json -Compress
