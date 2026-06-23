[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [int]$TimeoutSec = 20,
    [switch]$VerifyBundle
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function As-FlatArray {
    param($Value)
    $items = @($Value)
    if ($items.Count -eq 1 -and $items[0] -is [array]) {
        return @($items[0])
    }
    return $items
}

function Invoke-LocalJson {
    param([string]$Path, [int]$MaxAttempts = 2)
    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $TimeoutSec
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

function Invoke-JsonScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName,
        [string[]]$Arguments = @(),
        [string]$ScriptRoot = $PSScriptRoot
    )
    $scriptPath = Join-Path $ScriptRoot $ScriptName
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "Missing script: $ScriptName"
    }
    $powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $output = @(& $powerShellBin -NoProfile -ExecutionPolicy Bypass -File $scriptPath @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $lines = @($output | ForEach-Object { [string]$_ })
    $jsonLine = @($lines | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)
    if ($exitCode -ne 0) {
        throw "$ScriptName failed with exit code $exitCode. $($lines -join "`n")"
    }
    if (-not $jsonLine) {
        throw "$ScriptName did not emit a JSON result."
    }
    return ($jsonLine | ConvertFrom-Json)
}

function Resolve-InstalledScriptRoot {
    $installedRoot = Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime\scripts"
    if (Test-Path -LiteralPath (Join-Path $installedRoot "collect-anticodex-diagnostics.ps1") -PathType Leaf) {
        return $installedRoot
    }
    return $PSScriptRoot
}

function Test-DiagnosticBundle {
    $antigravityReportsRequired = $diagnosticMode -ne "third-party"
    $collectorRoot = Resolve-InstalledScriptRoot
    $bundle = Invoke-JsonScript "collect-anticodex-diagnostics.ps1" @("-BaseUrl", $BaseUrl, "-NoPopup") $collectorRoot
    if ($bundle.ok -ne $true) { Add-Failure "diagnostic bundle collector returned ok=false" }
    if (-not (Test-Path -LiteralPath $bundle.zipPath -PathType Leaf)) { Add-Failure "diagnostic zip missing: $($bundle.zipPath)" }
    if (-not (Test-Path -LiteralPath $bundle.bundleRoot -PathType Container)) { Add-Failure "diagnostic bundle root missing: $($bundle.bundleRoot)" }

    $refreshPath = Join-Path $bundle.bundleRoot "model-routing-refresh.json"
    $summaryPath = Join-Path $bundle.bundleRoot "reports-summary.json"
    $lifecycleStatusPath = Join-Path (Join-Path $bundle.bundleRoot "logs") "translator-lifecycle.json"
    $lifecycleLogPath = Join-Path (Join-Path $bundle.bundleRoot "logs") "translator-lifecycle.jsonl"
    if ($antigravityReportsRequired -and -not (Test-Path -LiteralPath $refreshPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing model-routing-refresh.json"
    }
    if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing reports-summary.json"
    }
    if (-not (Test-Path -LiteralPath $lifecycleStatusPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing translator-lifecycle.json"
    }
    if (-not (Test-Path -LiteralPath $lifecycleLogPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing translator-lifecycle.jsonl"
    }

    $refresh = $null
    if (Test-Path -LiteralPath $refreshPath -PathType Leaf) {
        $refresh = Get-Content -LiteralPath $refreshPath -Raw | ConvertFrom-Json
        if ($antigravityReportsRequired) {
            if ($refresh.ok -ne $true) { Add-Failure "diagnostic model-routing refresh ok=false" }
            if ([int]$refresh.modelCount -lt 1) { Add-Failure "diagnostic model-routing refresh has no models" }
            if ($refresh.skipRequests -ne $true) { Add-Failure "diagnostic model-routing refresh did not use skipRequests" }
        }
    }

    $modelSummary = $null
    $modelThinkingSummary = $null
    $toolBridgeSummary = $null
    $uiIdleSummary = $null
    $syncReadinessSummary = $null
    $installedFastSummary = $null
    $installedFullSummary = $null
    $postVerificationSummary = $null
    $sourcePreflightSummary = $null
    $managerRealButtonsSummary = $null
    $thirdPartyProviderSummary = $null
    $localConnectorsSummary = $null
    $pluginCapabilitiesSummary = $null
    $releaseGatesSummary = $null
    $coldRelaunchSummary = $null
    if (Test-Path -LiteralPath $summaryPath -PathType Leaf) {
        $summary = As-FlatArray (Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json)
        $modelSummary = @($summary | Where-Object { $_.file -eq "latest-model-routing.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $modelSummary) {
            Add-Failure "diagnostic reports summary missing latest-model-routing.json"
        } elseif ($antigravityReportsRequired -and $modelSummary) {
            if ([int]$modelSummary.modelCount -lt 1) { Add-Failure "diagnostic model-routing summary has no models" }
            if ($modelSummary.skipRequests -ne $true) { Add-Failure "diagnostic model-routing summary did not preserve skipRequests" }
            $modelEvidence = $modelSummary.modelRoutingEvidence
            if (-not $modelEvidence) {
                Add-Failure "diagnostic model-routing summary missing modelRoutingEvidence"
            } else {
                if (-not [string]$modelEvidence.mode) { Add-Failure "diagnostic model-routing summary missing mode" }
                if ([int]$modelEvidence.resultCount -lt [int]$modelSummary.modelCount) { Add-Failure "diagnostic model-routing summary missing per-model results" }
                if ([int]$modelEvidence.skippedRequestCount -ne [int]$modelEvidence.resultCount) { Add-Failure "diagnostic model-routing summary did not preserve skipped per-model results" }
                if ([int]$modelEvidence.failedResultCount -ne 0) { Add-Failure "diagnostic model-routing summary reports failed results" }
                if ([int]$modelEvidence.resultErrorCount -ne 0) { Add-Failure "diagnostic model-routing summary reports result errors" }
            }
        }
        $modelThinkingSummary = @($summary | Where-Object { $_.file -eq "latest-model-thinking.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $modelThinkingSummary) {
            Add-Failure "diagnostic reports summary missing latest-model-thinking.json"
        } elseif ($antigravityReportsRequired -and $modelThinkingSummary) {
            $thinkingEvidence = $modelThinkingSummary.modelThinkingEvidence
            if (-not $thinkingEvidence) {
                Add-Failure "diagnostic model-thinking summary missing modelThinkingEvidence"
            } else {
                if ([int]$thinkingEvidence.expectedModelCount -lt 1) { Add-Failure "diagnostic model-thinking summary missing expected model count" }
                if ([int]$thinkingEvidence.actualModelCount -ne [int]$thinkingEvidence.expectedModelCount) { Add-Failure "diagnostic model-thinking summary model counts differ" }
                if ([int]$thinkingEvidence.modelCount -ne [int]$thinkingEvidence.actualModelCount) { Add-Failure "diagnostic model-thinking summary missing model entries" }
                if ([int]$thinkingEvidence.supportsThinkingCount -ne [int]$thinkingEvidence.modelCount) { Add-Failure "diagnostic model-thinking summary has non-thinking models" }
                if ([int]$thinkingEvidence.missingBudgetCount -ne 0) { Add-Failure "diagnostic model-thinking summary has missing budgets" }
                if ([int]$thinkingEvidence.missingReasoningLevelCount -ne 0) { Add-Failure "diagnostic model-thinking summary has missing reasoning levels" }
                if (@($thinkingEvidence.reasoningLevels).Count -lt 1) { Add-Failure "diagnostic model-thinking summary missing reasoning levels" }
            }
        }
        $toolBridgeSummary = @($summary | Where-Object { $_.file -eq "latest-tool-bridge-mode.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $toolBridgeSummary) {
            Add-Failure "diagnostic reports summary missing latest-tool-bridge-mode.json"
        } elseif ($antigravityReportsRequired -and $toolBridgeSummary) {
            $bridgeEvidence = $toolBridgeSummary.toolBridgeEvidence
            if (-not $bridgeEvidence) {
                Add-Failure "diagnostic tool-bridge summary missing toolBridgeEvidence"
            } else {
                if ($bridgeEvidence.mode -ne "native-mcp-same-cascade") { Add-Failure "diagnostic tool-bridge summary missing native MCP same-Cascade mode" }
                if ($bridgeEvidence.transport -ne "desktop-cascade") { Add-Failure "diagnostic tool-bridge summary missing desktop-cascade transport" }
                if ($bridgeEvidence.localAdapter -ne "native-mcp-same-cascade-with-prompt-fallback") { Add-Failure "diagnostic tool-bridge summary missing prompt fallback adapter" }
                if ($bridgeEvidence.nativeAntigravityToolEvents -ne $true) { Add-Failure "diagnostic tool-bridge summary missing native tool events" }
                if ($bridgeEvidence.nativeMcpDiscoveryVerified -ne $true) { Add-Failure "diagnostic tool-bridge summary missing MCP discovery proof" }
                if ($bridgeEvidence.nativeBridgeDefaultEnabled -ne $true) { Add-Failure "diagnostic tool-bridge summary missing default native bridge proof" }
                if ($bridgeEvidence.acceptsExternalToolDefinitions -ne $true) { Add-Failure "diagnostic tool-bridge summary missing external tool definition proof" }
                if ($bridgeEvidence.compatibilityBridge -ne "native_mcp_same_cascade") { Add-Failure "diagnostic tool-bridge summary missing compatibility bridge proof" }
                if ($bridgeEvidence.nativeMcpApprovalProtocolVerified -ne $true) { Add-Failure "diagnostic tool-bridge summary missing approval protocol proof" }
                if ($bridgeEvidence.nativeMcpPermissionMode -ne "automatic-before-codex-execution") { Add-Failure "diagnostic tool-bridge summary missing automatic permission mode" }
                if ($bridgeEvidence.sameCascadeResumeProbeVerified -ne $true) { Add-Failure "diagnostic tool-bridge summary missing same-Cascade resume proof" }
                if ($bridgeEvidence.antigravityOwnedToolsDisabled -ne $true) { Add-Failure "diagnostic tool-bridge summary missing owned tools disabled proof" }
                if ($bridgeEvidence.permissionPromptsDisabled -ne $true) { Add-Failure "diagnostic tool-bridge summary missing permission prompts disabled proof" }
                if ([int]$bridgeEvidence.disabledToolCount -lt 1) { Add-Failure "diagnostic tool-bridge summary missing disabled tool count" }
                if ($bridgeEvidence.codexToolBridge -ne "native-mcp-same-cascade-with-prompt-fallback") { Add-Failure "diagnostic tool-bridge summary missing Codex tool bridge proof" }
            }
        }
        $uiIdleSummary = @($summary | Where-Object { $_.file -eq "latest-ui-idle-stability.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $uiIdleSummary) {
            Add-Failure "diagnostic reports summary missing latest-ui-idle-stability.json"
        } elseif ($antigravityReportsRequired -and $uiIdleSummary) {
            $uiEvidence = $uiIdleSummary.uiIdleEvidence
            if (-not $uiEvidence) {
                Add-Failure "diagnostic ui-idle summary missing uiIdleEvidence"
            } else {
                if ([int]$uiEvidence.durationSec -lt 10) { Add-Failure "diagnostic ui-idle summary duration too short" }
                if ([int]$uiEvidence.sampleCount -lt 1) { Add-Failure "diagnostic ui-idle summary missing samples" }
                if ([int]$uiEvidence.sampleEntryCount -lt [int]$uiEvidence.sampleCount) { Add-Failure "diagnostic ui-idle summary sample entries missing" }
                if ([int]$uiEvidence.healthySampleCount -ne [int]$uiEvidence.sampleEntryCount) { Add-Failure "diagnostic ui-idle summary has unhealthy samples" }
                if ([int]$uiEvidence.reconnectTextCount -ne 0) { Add-Failure "diagnostic ui-idle summary has reconnect text" }
                if ([int]$uiEvidence.loginTextCount -ne 0) { Add-Failure "diagnostic ui-idle summary has login text" }
                if ([int]$uiEvidence.missingModelTextCount -ne 0) { Add-Failure "diagnostic ui-idle summary missing model text" }
            }
        }
        $syncReadinessSummary = @($summary | Where-Object { $_.file -eq "latest-sync-readiness.json" } | Select-Object -First 1)[0]
        if (-not $syncReadinessSummary) {
            Add-Failure "diagnostic reports summary missing latest-sync-readiness.json"
        } else {
            $syncEvidence = $syncReadinessSummary.syncReadinessEvidence
            if (-not $syncEvidence) {
                Add-Failure "diagnostic sync-readiness summary missing syncReadinessEvidence"
            } else {
                if ($syncEvidence.noTrafficReady -ne $true) { Add-Failure "diagnostic sync-readiness summary missing no-traffic attestation" }
                if ($syncEvidence.fullMode -ne $true) { Add-Failure "diagnostic sync-readiness summary not full mode" }
                if ($syncEvidence.activeHostReady -ne $true) { Add-Failure "diagnostic sync-readiness summary active host not ready" }
                if ($syncEvidence.brandReady -ne $true) { Add-Failure "diagnostic sync-readiness summary brand not preserved" }
                if ($syncEvidence.iconReady -ne $true) { Add-Failure "diagnostic sync-readiness summary icons not ready" }
                if ($syncEvidence.syncScriptsReady -ne $true) { Add-Failure "diagnostic sync-readiness summary scripts not ready" }
                if ($syncEvidence.updateReady -ne $true) { Add-Failure "diagnostic sync-readiness summary update status not synced" }
                if ($syncEvidence.guardrailsReady -ne $true) { Add-Failure "diagnostic sync-readiness summary guardrails not ready" }
                if ([int]$syncEvidence.shortcutCount -lt 5) { Add-Failure "diagnostic sync-readiness summary shortcut count too low" }
                if ([int]$syncEvidence.shortcutReadyCount -ne [int]$syncEvidence.shortcutCount) { Add-Failure "diagnostic sync-readiness summary shortcuts not ready" }
                if ([int]$syncEvidence.desktopShortcutCount -ne 1) { Add-Failure "diagnostic sync-readiness summary desktop shortcut count wrong" }
                if ([int]$syncEvidence.forbiddenDesktopHelperCount -ne 0) { Add-Failure "diagnostic sync-readiness summary has forbidden desktop helpers" }
                if ($syncEvidence.managerBridgeReady -ne $true) { Add-Failure "diagnostic sync-readiness summary manager bridge not ready" }
                if ($syncEvidence.cleanSyncState -ne $true) { Add-Failure "diagnostic sync-readiness summary sync state not clean" }
            }
        }
        $installedFastSummary = @($summary | Where-Object { $_.file -eq "latest-installed-overall-fast.json" } | Select-Object -First 1)[0]
        $installedFullSummary = @($summary | Where-Object { $_.file -eq "latest-installed-overall.json" } | Select-Object -First 1)[0]
        foreach ($entry in @(
            [pscustomobject]@{ Label = "fast"; Summary = $installedFastSummary; ExpectedReportName = "installed-overall-fast"; ExpectedCoverage = "installed-fast-no-traffic"; ExpectedFast = $true },
            [pscustomobject]@{ Label = "full"; Summary = $installedFullSummary; ExpectedReportName = "installed-overall"; ExpectedCoverage = "installed-no-traffic"; ExpectedFast = $false }
        )) {
            if (-not $entry.Summary) {
                Add-Failure "diagnostic reports summary missing latest-installed-overall $($entry.Label)"
                continue
            }
            $overallEvidence = $entry.Summary.installedOverallEvidence
            if (-not $overallEvidence) {
                Add-Failure "diagnostic installed-overall $($entry.Label) summary missing installedOverallEvidence"
            } else {
                if ($overallEvidence.reportName -ne $entry.ExpectedReportName) { Add-Failure "diagnostic installed-overall $($entry.Label) summary reportName mismatch" }
                if ($overallEvidence.fast -ne $entry.ExpectedFast) { Add-Failure "diagnostic installed-overall $($entry.Label) summary fast flag mismatch" }
                if ($overallEvidence.noTraffic -ne $true) { Add-Failure "diagnostic installed-overall $($entry.Label) summary missing noTraffic" }
                if ($overallEvidence.usedRealTraffic -ne $false) { Add-Failure "diagnostic installed-overall $($entry.Label) summary used real traffic" }
                if ($overallEvidence.behaviorCovered -ne $true) { Add-Failure "diagnostic installed-overall $($entry.Label) summary behavior not covered" }
                if ($overallEvidence.coverageKind -ne $entry.ExpectedCoverage) { Add-Failure "diagnostic installed-overall $($entry.Label) summary coverageKind mismatch" }
                if ([int]$overallEvidence.checkCount -lt 1) { Add-Failure "diagnostic installed-overall $($entry.Label) summary missing checks" }
                if ([int]$overallEvidence.failedCheckCount -ne 0) { Add-Failure "diagnostic installed-overall $($entry.Label) summary failed checks" }
                if ([int]$overallEvidence.missingSkipMetadataCount -ne 0) { Add-Failure "diagnostic installed-overall $($entry.Label) summary missing skip metadata" }
                if (@($overallEvidence.realTrafficSkippedChecks).Count -lt 2) { Add-Failure "diagnostic installed-overall $($entry.Label) summary missing real traffic skipped checks" }
            }
        }
        $postVerificationSummary = @($summary | Where-Object { $_.file -eq "latest-post-verification.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $postVerificationSummary) {
            Add-Failure "diagnostic reports summary missing latest-post-verification.json"
        } elseif ($antigravityReportsRequired -and $postVerificationSummary) {
            if ($postVerificationSummary.usedRealTraffic -ne $true) { Add-Failure "post-verification summary did not preserve usedRealTraffic" }
            if (-not [string]$postVerificationSummary.state) { Add-Failure "post-verification summary is missing state" }
            if (-not [string]$postVerificationSummary.latestDiagnosis) { Add-Failure "post-verification summary is missing latestDiagnosis" }
            if (-not (Has-Property $postVerificationSummary "latestDiagnosisDetail")) { Add-Failure "post-verification summary is missing latestDiagnosisDetail" }
        }
        $sourcePreflightSummary = @($summary | Where-Object { $_.file -eq "latest-source-preflight.json" } | Select-Object -First 1)[0]
        if (-not $sourcePreflightSummary) {
            Add-Failure "diagnostic reports summary missing latest-source-preflight.json"
        } else {
            if ($sourcePreflightSummary.ok -ne $true) { Add-Failure "source-preflight summary ok=false" }
            if ($sourcePreflightSummary.reportName -ne "source-preflight") { Add-Failure "source-preflight summary missing reportName" }
            if ($sourcePreflightSummary.javascriptSyntaxOk -ne $true) { Add-Failure "source-preflight summary missing JavaScript syntax success" }
            if ($sourcePreflightSummary.powershellSyntaxOk -ne $true) { Add-Failure "source-preflight summary missing PowerShell syntax success" }
            if ($sourcePreflightSummary.uiStateSelfTestOk -ne $true) { Add-Failure "source-preflight summary missing UI state self-test success" }
            if ($sourcePreflightSummary.upstreamProfileStorageOk -ne $true) { Add-Failure "source-preflight summary missing upstream profile storage success" }
            if ($sourcePreflightSummary.localConnectorVerifierOk -ne $true) { Add-Failure "source-preflight summary missing local connector verifier success" }
            if ($sourcePreflightSummary.publicDocumentationOk -ne $true) { Add-Failure "source-preflight summary missing public documentation success" }
            if ($sourcePreflightSummary.translatorRegressionOk -ne $true) { Add-Failure "source-preflight summary missing translator regression success" }
            if ($sourcePreflightSummary.diffWhitespaceOk -ne $true) { Add-Failure "source-preflight summary missing diff whitespace success" }
            if ($null -eq $sourcePreflightSummary.skipFullRegression) { Add-Failure "source-preflight summary missing skipFullRegression" }
        }
        $thirdPartyProviderSummary = @($summary | Where-Object { $_.file -eq "latest-third-party-provider.json" } | Select-Object -First 1)[0]
        if ($thirdPartyProviderSummary) {
            if ($thirdPartyProviderSummary.ok -ne $true) { Add-Failure "third-party provider summary ok=false" }
            if ($thirdPartyProviderSummary.upstreamFullUrlAccepted -ne $true) { Add-Failure "third-party provider summary missing full URL acceptance" }
            if ($thirdPartyProviderSummary.unauthorizedManagerBlocked -ne $true) { Add-Failure "third-party provider summary missing unauthorized Manager block" }
            if ($thirdPartyProviderSummary.savedWithoutHistoryLoss -ne $true) { Add-Failure "third-party provider summary missing save continuity" }
            if ($thirdPartyProviderSummary.restartedProviderWithoutHistoryLoss -ne $true) { Add-Failure "third-party provider summary missing restart continuity" }
            if ($thirdPartyProviderSummary.switchedProviderWithoutHistoryLoss -ne $true) { Add-Failure "third-party provider summary missing provider-switch continuity" }
            if ($thirdPartyProviderSummary.crossProtocolWithoutHistoryLoss -ne $true) { Add-Failure "third-party provider summary missing OpenAI-to-Anthropic continuity" }
            if ($thirdPartyProviderSummary.reverseCrossProtocolWithoutHistoryLoss -ne $true) { Add-Failure "third-party provider summary missing Anthropic-to-OpenAI continuity" }
            if ($thirdPartyProviderSummary.secretsRedacted -ne $true) { Add-Failure "third-party provider summary missing secret redaction evidence" }
            $continuity = $thirdPartyProviderSummary.providerContinuity
            if (-not $continuity) {
                Add-Failure "third-party provider summary missing providerContinuity"
            } else {
                if ([int]$continuity.turns -lt 9) { Add-Failure "third-party provider summary has fewer than 9 continuity turns" }
                if ([int]$continuity.toolHistoryTurns -lt 2) { Add-Failure "third-party provider summary has fewer than 2 tool-history turns" }
                if ($continuity.providerModelUsedForEveryTurn -ne $true) { Add-Failure "third-party provider summary missing provider model evidence" }
                if ($continuity.providerSwitchPreservesOpenAiToolPair -ne $true) { Add-Failure "third-party provider summary missing OpenAI tool pair after provider switch" }
                if ($continuity.protocolSwitchPreservesAnthropicToolPair -ne $true) { Add-Failure "third-party provider summary missing Anthropic tool pair after protocol switch" }
                if ($continuity.reverseProtocolSwitchPreservesOpenAiToolPair -ne $true) { Add-Failure "third-party provider summary missing OpenAI tool pair after reverse protocol switch" }
                if ($continuity.structuralEvidenceClean -ne $true) { Add-Failure "third-party provider summary missing clean structured tool-pair evidence" }
                if ($continuity.orderedHistoryClean -ne $true) { Add-Failure "third-party provider summary missing ordered role history evidence" }
                if ([int]$continuity.sixthOrderedHistoryCount -lt 7) { Add-Failure "third-party provider summary missing turn-6 ordered role history evidence" }
                if ([int]$continuity.seventhOrderedHistoryCount -lt 7) { Add-Failure "third-party provider summary missing turn-7 ordered role history evidence" }
                if ([int]$continuity.eighthOrderedHistoryCount -lt 7) { Add-Failure "third-party provider summary missing turn-8 ordered role history evidence" }
                if ([int]$continuity.ninthOrderedHistoryCount -lt 7) { Add-Failure "third-party provider summary missing turn-9 ordered role history evidence" }
                if ($continuity.sixthAfterRestartPreservesHistory -ne $true) { Add-Failure "third-party provider summary missing turn-6 restart history evidence" }
                if ($continuity.sixthAfterRestartPreservesAllHistoryMarkers -ne $true -or [int]$continuity.sixthAfterRestartAllHistoryMarkerCount -lt 15) { Add-Failure "third-party provider summary missing turn-6 full-history marker coverage" }
                if ($continuity.seventhAfterProviderSwitchPreservesAllHistoryMarkers -ne $true -or [int]$continuity.seventhAfterProviderSwitchAllHistoryMarkerCount -lt 16) { Add-Failure "third-party provider summary missing turn-7 full-history marker coverage" }
                if ($continuity.eighthAfterProtocolSwitchPreservesAllHistoryMarkers -ne $true -or [int]$continuity.eighthAfterProtocolSwitchAllHistoryMarkerCount -lt 18) { Add-Failure "third-party provider summary missing turn-8 full-history marker coverage" }
                if ($continuity.ninthAfterReverseProtocolSwitchPreservesAllHistoryMarkers -ne $true -or [int]$continuity.ninthAfterReverseProtocolSwitchAllHistoryMarkerCount -lt 20) { Add-Failure "third-party provider summary missing turn-9 full-history marker coverage" }
                if ($continuity.ninthAfterReverseProtocolSwitchPreservesHistory -ne $true) { Add-Failure "third-party provider summary missing final reverse-switch history evidence" }
            }
        }
        $localConnectorsSummary = @($summary | Where-Object { $_.file -eq "latest-local-connectors.json" } | Select-Object -First 1)[0]
        if ($localConnectorsSummary) {
            if ($localConnectorsSummary.ok -ne $true) { Add-Failure "local connector summary ok=false" }
            if ($localConnectorsSummary.reportName -ne "local-connectors") { Add-Failure "local connector summary missing reportName" }
            if ($localConnectorsSummary.usedRealTraffic -ne $false) { Add-Failure "local connector summary used real traffic" }
            if ($localConnectorsSummary.behaviorCovered -ne $true) { Add-Failure "local connector summary behavior not covered" }
            if ($localConnectorsSummary.coverageKind -ne "local-fake-provider") { Add-Failure "local connector summary coverageKind mismatch" }
            $localEvidence = $localConnectorsSummary.localConnectorEvidence
            if (-not $localEvidence) {
                Add-Failure "local connector summary missing localConnectorEvidence"
            } else {
                if ($localEvidence.linkedConnectorAccessible -ne $true) { Add-Failure "local connector summary missing linked connector access proof" }
                if ($localEvidence.chatgptInstallUrlsScrubbed -ne $true) { Add-Failure "local connector summary missing ChatGPT URL scrub evidence" }
                if ($localEvidence.linkEndpointsUnsupported -ne $true) { Add-Failure "local connector summary missing metadata-only link endpoint evidence" }
                if ([int]$localEvidence.upstreamRequestsDuringLocalEndpoints -ne 0) { Add-Failure "local connector summary recorded upstream requests during local endpoints" }
                if ($localEvidence.allowlistedConnectorAccessible -ne $false) { Add-Failure "local connector summary treats allowlist as access" }
                if ($localEvidence.allowlistedConnectorLocallyAllowlisted -ne $true) { Add-Failure "local connector summary missing local allowlist evidence" }
                if ($localEvidence.hiddenConnectorAccessible -ne $false) { Add-Failure "local connector summary exposes hidden connector" }
                if ([int]$localEvidence.exposedToolsPost -ne [int]$localEvidence.exposedToolsGet) { Add-Failure "local connector summary GET/POST tool counts differ" }
                if (@($localEvidence.exposedToolNames).Count -ne [int]$localEvidence.exposedToolsPost) { Add-Failure "local connector summary exposed tool names mismatch" }
            }
        }
        $pluginCapabilitiesSummary = @($summary | Where-Object { $_.file -eq "latest-plugin-capabilities.json" } | Select-Object -First 1)[0]
        if ($pluginCapabilitiesSummary) {
            if ($pluginCapabilitiesSummary.ok -ne $true) { Add-Failure "plugin capability summary ok=false" }
            $pluginEvidence = $pluginCapabilitiesSummary.pluginCapabilityEvidence
            if (-not $pluginEvidence) {
                Add-Failure "plugin capability summary missing pluginCapabilityEvidence"
            } else {
                if ($pluginEvidence.nativeCodexWriteback -ne $false) { Add-Failure "plugin capability summary allows native Codex writeback" }
                if ([int]$pluginEvidence.accessibleConnectorCount -ne 0) { Add-Failure "plugin capability summary reports accessible connectors" }
                if ([int]$pluginEvidence.unauthorizedAppToolCount -ne 0) { Add-Failure "plugin capability summary reports unauthorized app tools" }
                if ($pluginEvidence.connectorParityClean -ne $true) { Add-Failure "plugin capability summary missing connector parity evidence" }
                if ($pluginEvidence.appToolParityClean -ne $true) { Add-Failure "plugin capability summary missing app-tool parity evidence" }
                if ($pluginEvidence.appToolGetPostParityClean -ne $true) { Add-Failure "plugin capability summary missing GET/POST parity evidence" }
                if (-not (Has-Property $pluginEvidence "connectorParityMissingShared")) { Add-Failure "plugin capability summary missing connector parity drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolGetPostMissingFromGet")) { Add-Failure "plugin capability summary missing GET/POST drift samples" }
            }
        }
        $mcpSkillsSummary = @($summary | Where-Object { $_.file -eq "latest-mcp-skills.json" } | Select-Object -First 1)[0]
        if ($mcpSkillsSummary) {
            if ($mcpSkillsSummary.ok -ne $true) { Add-Failure "MCP/Skill summary ok=false" }
            $mcpSkillEvidence = $mcpSkillsSummary.mcpSkillEvidence
            if (-not $mcpSkillEvidence) {
                Add-Failure "MCP/Skill summary missing mcpSkillEvidence"
            } else {
                if ([int]$mcpSkillEvidence.mcpCount -lt 1) { Add-Failure "MCP/Skill summary has no MCP entries" }
                if ([int]$mcpSkillEvidence.mcpSharedCount -lt 1) { Add-Failure "MCP/Skill summary has no shared MCP entries" }
                if (@($mcpSkillEvidence.mcpMissingShared).Count -ne 0) { Add-Failure "MCP/Skill summary has missing shared MCP entries" }
                if (@($mcpSkillEvidence.mcpChangedShared).Count -ne 0) { Add-Failure "MCP/Skill summary has changed shared MCP entries" }
                if ($mcpSkillEvidence.hasNodeRepl -ne $true) { Add-Failure "MCP/Skill summary missing node_repl evidence" }
                if ($mcpSkillEvidence.mcpSmokePassed -ne $true) { Add-Failure "MCP/Skill summary missing MCP smoke evidence" }
                if ($mcpSkillEvidence.mcpRealCallPassed -ne $true) { Add-Failure "MCP/Skill summary missing MCP real-call evidence" }
                if ([int]$mcpSkillEvidence.skillCount -lt 1) { Add-Failure "MCP/Skill summary has no skills" }
                if ([int]$mcpSkillEvidence.expectedSharedSkillCount -lt 1) { Add-Failure "MCP/Skill summary missing expected shared skill count" }
                if ([int]$mcpSkillEvidence.agentsSkillCount -lt 1) { Add-Failure "MCP/Skill summary missing .agents skill count" }
                if (@($mcpSkillEvidence.missingSharedSkills).Count -ne 0) { Add-Failure "MCP/Skill summary has missing shared skills" }
                if (@($mcpSkillEvidence.conflictingDuplicateSkillNames).Count -ne 0) { Add-Failure "MCP/Skill summary has conflicting duplicate skills" }
                if ($mcpSkillEvidence.skillSmokeReadable -ne $true) { Add-Failure "MCP/Skill summary missing skill smoke evidence" }
            }
        }
        $refreshFeaturesSummary = @($summary | Where-Object { $_.file -eq "latest-refresh-features.json" } | Select-Object -First 1)[0]
        if ($refreshFeaturesSummary) {
            $refreshEvidence = $refreshFeaturesSummary.refreshFeatureEvidence
            if (-not $refreshEvidence) {
                Add-Failure "refresh-features summary missing refreshFeatureEvidence"
            } elseif ($refreshFeaturesSummary.ok -eq $true) {
                if ($refreshEvidence.connectorSharedExists -eq $true -and $refreshEvidence.connectorContentMatches -ne $true) { Add-Failure "refresh-features summary connector parity not clean" }
                if ($refreshEvidence.appToolSharedExists -eq $true -and $refreshEvidence.appToolContentMatches -ne $true) { Add-Failure "refresh-features summary app-tool parity not clean" }
            }
        }
        $optionalRealProviderSummary = @($summary | Where-Object { $_.file -eq "latest-real-third-party-provider.json" } | Select-Object -First 1)[0]
        if ($optionalRealProviderSummary -and $optionalRealProviderSummary.skipped -ne $true) {
            if ($optionalRealProviderSummary.reportName -ne "real-third-party-provider") { Add-Failure "optional real-provider summary reportName mismatch" }
            $optionalEvidence = $optionalRealProviderSummary.optionalRealProviderEvidence
            if (-not $optionalEvidence) {
                Add-Failure "optional real-provider summary missing continuity evidence"
            } else {
                if ($optionalEvidence.firstMarkerObserved -ne $true) { Add-Failure "optional real-provider summary missing first marker evidence" }
                if ($optionalEvidence.secondMarkerObserved -ne $true) { Add-Failure "optional real-provider summary missing second marker evidence" }
                if ($optionalEvidence.historyContinuationObserved -ne $true) { Add-Failure "optional real-provider summary missing history continuation evidence" }
                if ([string]$optionalEvidence.routeTransport -ne "upstream-provider") { Add-Failure "optional real-provider summary missing upstream-provider route evidence" }
                if (-not [string]$optionalEvidence.routeProviderProtocol) { Add-Failure "optional real-provider summary missing provider protocol route evidence" }
                if (-not [string]$optionalEvidence.routeResolvedModel) { Add-Failure "optional real-provider summary missing resolved model route evidence" }
                if ([string]$optionalEvidence.routeStatus -ne "success") { Add-Failure "optional real-provider summary missing successful route evidence" }
                if ($optionalEvidence.secretsRedacted -ne $true) { Add-Failure "optional real-provider summary missing redaction evidence" }
                if ([int]$optionalEvidence.turns -lt 2) { Add-Failure "optional real-provider summary has fewer than 2 turns" }
            }
        }
        $antigravityReturnSummary = @($summary | Where-Object { $_.file -eq "latest-provider-antigravity-return.json" } | Select-Object -First 1)[0]
        if ($antigravityReturnSummary -and $antigravityReturnSummary.skipped -ne $true) {
            if ($antigravityReturnSummary.reportName -ne "provider-antigravity-return") { Add-Failure "Antigravity return summary reportName mismatch" }
            $returnEvidence = $antigravityReturnSummary.antigravityReturnEvidence
            if (-not $returnEvidence) {
                Add-Failure "Antigravity return summary missing continuity evidence"
            } else {
                if ($returnEvidence.realAntigravityTurnUsed -ne $true) { Add-Failure "Antigravity return summary missing real-turn evidence" }
                if ($returnEvidence.returnedToAntigravityWithHistory -ne $true) { Add-Failure "Antigravity return summary missing history return evidence" }
                if ($returnEvidence.previousResponseIdMatched -ne $true) { Add-Failure "Antigravity return summary missing previous_response_id evidence" }
                if ([int]$returnEvidence.markerCount -lt 6) { Add-Failure "Antigravity return summary missing marker-count evidence" }
                if ([int]$returnEvidence.missingMarkerCount -ne 0) { Add-Failure "Antigravity return summary reports missing markers" }
                if (-not [string]$returnEvidence.routeTransport -or [string]$returnEvidence.routeTransport -eq "upstream-provider") { Add-Failure "Antigravity return summary missing native route evidence" }
                if (-not [string]$returnEvidence.resolvedModel) { Add-Failure "Antigravity return summary missing resolved model evidence" }
            }
        }
        $releaseGatesSummary = @($summary | Where-Object { $_.file -eq "latest-release-gates.json" } | Select-Object -First 1)[0]
        if ($releaseGatesSummary) {
            if ($releaseGatesSummary.ok -ne $true) { Add-Failure "release-gates summary ok=false" }
            if ($releaseGatesSummary.shortReady -ne $true) { Add-Failure "release-gates summary shortReady is not true" }
            if (-not (Has-Property $releaseGatesSummary "releaseReady")) { Add-Failure "release-gates summary missing releaseReady" }
            elseif ($releaseGatesSummary.releaseReady -ne $true) { Add-Failure "release-gates summary releaseReady is not true" }
            if ((Has-Property $releaseGatesSummary "effectiveOk") -and $releaseGatesSummary.effectiveOk -ne $true) { Add-Failure "release-gates summary effectiveOk is not true" }
            if (-not (Has-Property $releaseGatesSummary "missingRequired")) { Add-Failure "release-gates summary missing missingRequired" }
            if (-not (Has-Property $releaseGatesSummary "missingShort")) { Add-Failure "release-gates summary missing missingShort" }
            if (-not (Has-Property $releaseGatesSummary "damagedReports")) { Add-Failure "release-gates summary missing damagedReports" }
            if (-not (Has-Property $releaseGatesSummary "releaseGateFailures")) { Add-Failure "release-gates summary missing semantic failure details" }
        }
        $coldRelaunchSummary = @($summary | Where-Object { $_.file -eq "latest-cold-relaunch.json" } | Select-Object -First 1)[0]
        if ($coldRelaunchSummary) {
            $coldEvidence = $coldRelaunchSummary.coldRelaunchEvidence
            if (-not $coldEvidence) {
                Add-Failure "cold relaunch summary missing coldRelaunchEvidence"
            } elseif ($coldRelaunchSummary.ok -eq $true) {
                if ($coldEvidence.healthOk -ne $true) { Add-Failure "cold relaunch summary missing healthy state" }
                if ($coldEvidence.providerReady -ne $true) { Add-Failure "cold relaunch summary missing provider readiness" }
                if ([int]$coldEvidence.mainCount -ne 1) { Add-Failure "cold relaunch summary missing exact main process count" }
                if ([int]$coldEvidence.translatorCount -lt 1) { Add-Failure "cold relaunch summary missing translator process" }
                if ($coldEvidence.originalCodexUnchanged -ne $true) { Add-Failure "cold relaunch summary missing original Codex isolation proof" }
                if ([int]$coldEvidence.failedStageCount -ne 0) { Add-Failure "cold relaunch summary reports failed stages" }
            }
        }
        $stabilitySoakSummary = @($summary | Where-Object { $_.file -eq "latest-stability-soak.json" } | Select-Object -First 1)[0]
        if ($stabilitySoakSummary) {
            $soakEvidence = $stabilitySoakSummary.stabilitySoakEvidence
            if (-not $soakEvidence) {
                Add-Failure "stability soak summary missing stabilitySoakEvidence"
            } elseif ($stabilitySoakSummary.ok -eq $true) {
                if ($soakEvidence.providerReady -ne $true -or $soakEvidence.startReady -ne $true -or $soakEvidence.endReady -ne $true) { Add-Failure "stability soak summary missing readiness proof" }
                if ($soakEvidence.pidStable -ne $true) { Add-Failure "stability soak summary missing stable PID proof" }
                if ([int]$soakEvidence.healthChecks -lt 1) { Add-Failure "stability soak summary missing health checks" }
                if ([int]$soakEvidence.turnCount -lt 1) { Add-Failure "stability soak summary missing turns" }
                if ([int]$soakEvidence.failedTurnCount -ne 0) { Add-Failure "stability soak summary reports failed turns" }
            }
        }
        $managerRealButtonsSummary = @($summary | Where-Object { $_.file -eq "latest-manager-real-buttons.json" } | Select-Object -First 1)[0]
        if (-not $managerRealButtonsSummary) {
            Add-Failure "diagnostic reports summary missing latest-manager-real-buttons.json"
        } else {
            if ($managerRealButtonsSummary.ok -ne $true) { Add-Failure "manager-real-buttons summary ok=false" }
            if ($managerRealButtonsSummary.reportName -ne "manager-real-buttons") { Add-Failure "manager-real-buttons summary missing reportName" }
            if ([int]$managerRealButtonsSummary.failureCount -ne 0) { Add-Failure "manager-real-buttons summary has failures" }
            if ($managerRealButtonsSummary.managerButtonOk -ne $true) { Add-Failure "manager-real-buttons summary missing managerButton ok=true" }
            $actions = @($managerRealButtonsSummary.actions | ForEach-Object { [string]$_ })
            foreach ($requiredAction in @("mcpSkills", "pluginCapabilities")) {
                if ($actions -notcontains $requiredAction) { Add-Failure "manager-real-buttons summary missing action: $requiredAction" }
                $actionResult = @($managerRealButtonsSummary.managerButtonResults | Where-Object { $_.action -eq $requiredAction } | Select-Object -First 1)[0]
                if (-not $actionResult) {
                    Add-Failure "manager-real-buttons summary missing result: $requiredAction"
                } else {
                    if ($actionResult.ok -ne $true) { Add-Failure "manager-real-buttons action not ok: $requiredAction" }
                    if ($null -eq $actionResult.lastUiOnly) { Add-Failure "manager-real-buttons action missing lastUiOnly evidence: $requiredAction" }
                    if ($actionResult.lastUiOnly -eq $true) { Add-Failure "manager-real-buttons action used ui-only smoke: $requiredAction" }
                }
            }
        }
    }

    foreach ($path in @($refreshPath, $summaryPath)) {
        if ((Test-Path -LiteralPath $path -PathType Leaf) -and ((Get-Content -LiteralPath $path -Raw) -match "(?i)tool output|messages|input_items|Return exactly this")) {
            Add-Failure "diagnostic bundle model summary exposes transcript-like fields: $(Split-Path -Leaf $path)"
        }
    }
    foreach ($path in @($lifecycleStatusPath, $lifecycleLogPath)) {
        if ((Test-Path -LiteralPath $path -PathType Leaf) -and ((Get-Content -LiteralPath $path -Raw) -match "(?i)tool output|messages|input_items|Return exactly this")) {
            Add-Failure "diagnostic lifecycle log exposes transcript-like fields: $(Split-Path -Leaf $path)"
        }
    }

    return [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        zipPath = $bundle.zipPath
        antigravityReports = [pscustomobject]@{
            required = $antigravityReportsRequired
            note = if ($antigravityReportsRequired) { "Antigravity reports are required" } else { "third-party diagnostic bundle treats Antigravity reports as optional" }
        }
        retainedBundles = if ($bundle.PSObject.Properties.Name -contains "retainedBundles") { $bundle.retainedBundles } else { $null }
        lifecycleLogs = [pscustomobject]@{
            statusPresent = Test-Path -LiteralPath $lifecycleStatusPath -PathType Leaf
            logPresent = Test-Path -LiteralPath $lifecycleLogPath -PathType Leaf
        }
        modelRoutingRefresh = if ($refresh) {
            [pscustomobject]@{
                ok = $refresh.ok
                modelCount = $refresh.modelCount
                skipRequests = $refresh.skipRequests
            }
        } else { $null }
        modelRoutingSummary = if ($modelSummary) {
            [pscustomobject]@{
                modelCount = $modelSummary.modelCount
                skipRequests = $modelSummary.skipRequests
                models = @($modelSummary.models)
                evidence = $modelSummary.modelRoutingEvidence
            }
        } else { $null }
        modelThinkingSummary = if ($modelThinkingSummary) {
            [pscustomobject]@{
                ok = $modelThinkingSummary.ok
                evidence = $modelThinkingSummary.modelThinkingEvidence
            }
        } else { $null }
        toolBridgeSummary = if ($toolBridgeSummary) {
            [pscustomobject]@{
                ok = $toolBridgeSummary.ok
                evidence = $toolBridgeSummary.toolBridgeEvidence
            }
        } else { $null }
        uiIdleSummary = if ($uiIdleSummary) {
            [pscustomobject]@{
                ok = $uiIdleSummary.ok
                evidence = $uiIdleSummary.uiIdleEvidence
            }
        } else { $null }
        syncReadinessSummary = if ($syncReadinessSummary) {
            [pscustomobject]@{
                ok = $syncReadinessSummary.ok
                evidence = $syncReadinessSummary.syncReadinessEvidence
            }
        } else { $null }
        installedOverall = [pscustomobject]@{
            fast = if ($installedFastSummary) { $installedFastSummary.installedOverallEvidence } else { $null }
            full = if ($installedFullSummary) { $installedFullSummary.installedOverallEvidence } else { $null }
        }
        postVerification = if ($postVerificationSummary) {
            [pscustomobject]@{
                ok = $postVerificationSummary.ok
                state = $postVerificationSummary.state
                usedRealTraffic = $postVerificationSummary.usedRealTraffic
                latestDiagnosis = $postVerificationSummary.latestDiagnosis
                latestDiagnosisDetail = $postVerificationSummary.latestDiagnosisDetail
                attempts = $postVerificationSummary.attempts
            }
        } else { $null }
        managerRealButtons = if ($managerRealButtonsSummary) {
            [pscustomobject]@{
                ok = $managerRealButtonsSummary.ok
                reportName = $managerRealButtonsSummary.reportName
                actions = @($managerRealButtonsSummary.actions)
                managerButtonOk = $managerRealButtonsSummary.managerButtonOk
            }
        } else { $null }
        releaseGates = if ($releaseGatesSummary) {
            [pscustomobject]@{
                ok = $releaseGatesSummary.ok
                shortReady = $releaseGatesSummary.shortReady
                releaseReady = $releaseGatesSummary.releaseReady
                missingRequired = @($releaseGatesSummary.missingRequired)
                missingShort = @($releaseGatesSummary.missingShort)
                damagedReports = @($releaseGatesSummary.damagedReports)
                releaseGateFailures = @($releaseGatesSummary.releaseGateFailures)
            }
        } else { $null }
        coldRelaunch = if ($coldRelaunchSummary) {
            [pscustomobject]@{
                ok = $coldRelaunchSummary.ok
                evidence = $coldRelaunchSummary.coldRelaunchEvidence
            }
        } else { $null }
        mcpSkills = if ($mcpSkillsSummary) {
            [pscustomobject]@{
                ok = $mcpSkillsSummary.ok
                evidence = $mcpSkillsSummary.mcpSkillEvidence
            }
        } else { $null }
        refreshFeatures = if ($refreshFeaturesSummary) {
            [pscustomobject]@{
                ok = $refreshFeaturesSummary.ok
                evidence = $refreshFeaturesSummary.refreshFeatureEvidence
            }
        } else { $null }
        optionalRealProvider = if ($optionalRealProviderSummary) {
            [pscustomobject]@{
                ok = $optionalRealProviderSummary.ok
                skipped = $optionalRealProviderSummary.skipped
                evidence = $optionalRealProviderSummary.optionalRealProviderEvidence
            }
        } else { $null }
        antigravityReturn = if ($antigravityReturnSummary) {
            [pscustomobject]@{
                ok = $antigravityReturnSummary.ok
                skipped = $antigravityReturnSummary.skipped
                evidence = $antigravityReturnSummary.antigravityReturnEvidence
            }
        } else { $null }
        thirdPartyProvider = if ($thirdPartyProviderSummary) {
            [pscustomobject]@{
                ok = $thirdPartyProviderSummary.ok
                savedWithoutHistoryLoss = $thirdPartyProviderSummary.savedWithoutHistoryLoss
                restartedProviderWithoutHistoryLoss = $thirdPartyProviderSummary.restartedProviderWithoutHistoryLoss
                switchedProviderWithoutHistoryLoss = $thirdPartyProviderSummary.switchedProviderWithoutHistoryLoss
                crossProtocolWithoutHistoryLoss = $thirdPartyProviderSummary.crossProtocolWithoutHistoryLoss
                reverseCrossProtocolWithoutHistoryLoss = $thirdPartyProviderSummary.reverseCrossProtocolWithoutHistoryLoss
                secretsRedacted = $thirdPartyProviderSummary.secretsRedacted
                continuity = $thirdPartyProviderSummary.providerContinuity
            }
        } else { $null }
    }
}

$diagnostics = $null
$diagnosticMode = "unknown"
$diagnosticProtocol = $null
$diagnosticModel = $null
try {
    $diagnostics = Invoke-LocalJson "/anticodex/diagnostics"
} catch {
    Add-Failure "diagnostics request failed: $($_.Exception.Message)"
}

if ($diagnostics) {
    if ($diagnostics.ok -ne $true) { Add-Failure "diagnostics ok=false" }
    if ($diagnostics.object -ne "anticodex.diagnostics") { Add-Failure "diagnostics object mismatch" }
    $hasHealthProfile = (Has-Property $diagnostics.health "upstreamProfile") -and $null -ne $diagnostics.health.upstreamProfile
    if ($hasHealthProfile) {
        $diagnosticMode = if (Has-Property $diagnostics.health.upstreamProfile "mode") { [string]$diagnostics.health.upstreamProfile.mode } else { "unknown" }
        $diagnosticProtocol = if (Has-Property $diagnostics.health.upstreamProfile "protocol") { [string]$diagnostics.health.upstreamProfile.protocol } else { $null }
        $diagnosticModel = if (Has-Property $diagnostics.health.upstreamProfile "model") { [string]$diagnostics.health.upstreamProfile.model } else { $null }
    } elseif ((Has-Property $diagnostics.mode "antigravity") -and $diagnostics.mode.antigravity -eq $true) {
        $diagnosticMode = "antigravity"
    } elseif ($diagnostics.mode.upstream -eq "antigravity-desktop") {
        $diagnosticMode = "antigravity"
    }

    if ($diagnosticMode -eq "third-party") {
        if (-not $diagnosticProtocol) { Add-Failure "third-party diagnostics missing protocol" }
        if (-not $diagnosticModel) { Add-Failure "third-party diagnostics missing model" }
    } elseif ($diagnosticMode -eq "antigravity") {
        if ($diagnostics.mode.upstream -ne "antigravity-desktop") { Add-Failure "diagnostics upstream is not antigravity-desktop" }
        if ($diagnostics.health.accountReady -ne $true) { Add-Failure "diagnostics account is not ready" }
    } else {
        Add-Failure "diagnostics upstream mode is unknown"
    }
    if ([int]$diagnostics.models.count -lt 1) { Add-Failure "diagnostics has no models" }
    if (-not $diagnostics.models.ids -or @($diagnostics.models.ids).Count -lt 1) { Add-Failure "diagnostics model ids are empty" }
    if (-not (Has-Property $diagnostics "accountTracking")) {
        Add-Failure "diagnostics missing privacy-safe account tracking state"
    } elseif (-not (Has-Property $diagnostics.accountTracking "changePending") -or -not (Has-Property $diagnostics.accountTracking "requiredObservations")) {
        Add-Failure "diagnostics account tracking state is incomplete"
    } elseif (Has-Property $diagnostics.accountTracking "fingerprint") {
        Add-Failure "diagnostics account tracking state exposes an account fingerprint"
    }
    if (-not $diagnostics.paths.codexHome) { Add-Failure "diagnostics missing Anti-Codex codexHome" }
    if (-not $diagnostics.paths.sharedCodexHome) { Add-Failure "diagnostics missing sharedCodexHome" }
    if ($diagnostics.paths.codexHome -eq $diagnostics.paths.sharedCodexHome) { Add-Failure "Anti-Codex codexHome should be isolated from sharedCodexHome" }
    if (-not (Has-Property $diagnostics.paths "modelRouteAudit")) { Add-Failure "diagnostics missing modelRouteAudit path" }
    if ($diagnosticMode -eq "third-party") {
        if ($diagnostics.toolBridge.mode -ne "provider-native-or-compat") { Add-Failure "third-party diagnostics tool bridge mode is not provider-native-or-compat" }
        if ($diagnostics.toolBridge.transport -ne "upstream-provider") { Add-Failure "third-party diagnostics tool bridge transport is not upstream-provider" }
        if ($diagnostics.toolBridge.nativeAntigravityToolEvents -ne $false) { Add-Failure "third-party diagnostics unexpectedly reports native Antigravity tool events" }
        if ($diagnostics.toolBridge.acceptsExternalToolDefinitions -ne $true) { Add-Failure "third-party diagnostics should accept external tool definitions" }
    } else {
        if ($diagnostics.toolBridge.mode -ne "native-mcp-same-cascade") { Add-Failure "diagnostics tool bridge mode is not native-mcp-same-cascade" }
        if ($diagnostics.toolBridge.transport -ne "desktop-cascade") { Add-Failure "diagnostics tool bridge transport is not desktop-cascade" }
        if ($diagnostics.toolBridge.nativeBridgeDefaultEnabled -ne $true) { Add-Failure "diagnostics should enable the native bridge by default" }
        if ($diagnostics.toolBridge.nativeAntigravityToolEvents -ne $true) { Add-Failure "diagnostics should confirm native Antigravity tool events" }
        if ($diagnostics.toolBridge.acceptsExternalToolDefinitions -ne $true) { Add-Failure "diagnostics should confirm native external tool definitions" }
        if ($diagnostics.toolBridge.verifier -ne "test-anticodex-native-tool-loop.ps1") { Add-Failure "diagnostics missing native tool loop verifier name" }
        if ($diagnostics.toolBridge.nativeVerifier -ne "test-anticodex-native-tool-loop.ps1") { Add-Failure "diagnostics missing native tool loop verifier name" }
    }
    if (-not (Has-Property $diagnostics "localFeatures")) {
        Add-Failure "diagnostics missing local Skill/MCP feature summary"
    } else {
        $localFeatures = $diagnostics.localFeatures
        if (-not (Has-Property $localFeatures "skills")) {
            Add-Failure "diagnostics localFeatures missing skills section"
        } else {
            if (-not (Has-Property $localFeatures.skills "count")) { Add-Failure "diagnostics localFeatures.skills missing count" }
            if ([int]$localFeatures.skills.count -lt 1) { Add-Failure "diagnostics localFeatures.skills count is empty" }
            if (-not (Has-Property $localFeatures.skills "requiredPresent")) { Add-Failure "diagnostics localFeatures.skills missing inherited skill list" }
            if (-not (Has-Property $localFeatures.skills "sample")) { Add-Failure "diagnostics localFeatures.skills missing sample" }
            $requiredSkills = @("headroom", "context-save", "context-restore", "keep-codex-fast")
            foreach ($requiredSkill in $requiredSkills) {
                if ($localFeatures.skills.requiredPresent -notcontains $requiredSkill) {
                    Add-Failure "diagnostics localFeatures.skills missing required skill: $requiredSkill"
                }
            }
        }
        if (-not (Has-Property $localFeatures "mcp")) {
            Add-Failure "diagnostics localFeatures missing MCP section"
        } else {
            if (-not (Has-Property $localFeatures.mcp "count")) { Add-Failure "diagnostics localFeatures.mcp missing count" }
            if ([int]$localFeatures.mcp.count -lt 1) { Add-Failure "diagnostics localFeatures.mcp count is empty" }
            if (-not (Has-Property $localFeatures.mcp "names")) { Add-Failure "diagnostics localFeatures.mcp missing names" }
            if (-not (Has-Property $localFeatures.mcp "configPath")) { Add-Failure "diagnostics localFeatures.mcp missing configPath" }
            if ($localFeatures.mcp.names -notcontains "node_repl") { Add-Failure "diagnostics localFeatures.mcp missing node_repl MCP server" }
        }
        if (-not (Has-Property $localFeatures "snapshots")) {
            Add-Failure "diagnostics localFeatures missing snapshot counts"
        } else {
            if (-not (Has-Property $localFeatures.snapshots "connectorDirectoryFiles")) { Add-Failure "diagnostics localFeatures missing connector snapshot count" }
            if (-not (Has-Property $localFeatures.snapshots "appToolsCacheFiles")) { Add-Failure "diagnostics localFeatures missing app-tools snapshot count" }
        }
        if (-not (Has-Property $localFeatures "snapshotStatus")) {
            Add-Failure "diagnostics localFeatures missing snapshot freshness status"
        } else {
            if (-not (Has-Property $localFeatures.snapshotStatus "state")) { Add-Failure "diagnostics snapshotStatus missing state" }
            if (-not (Has-Property $localFeatures.snapshotStatus "stale")) { Add-Failure "diagnostics snapshotStatus missing stale flag" }
            if (-not (Has-Property $localFeatures.snapshotStatus "sourceFingerprintComparable")) { Add-Failure "diagnostics snapshotStatus missing sourceFingerprintComparable" }
            if (-not (Has-Property $localFeatures.snapshotStatus "sourceFingerprintMatches")) { Add-Failure "diagnostics snapshotStatus missing sourceFingerprintMatches" }
            if (-not (Has-Property $localFeatures.snapshotStatus "staleReason")) { Add-Failure "diagnostics snapshotStatus missing staleReason" }
        }
        if (-not (Has-Property $localFeatures "capabilityTiers") -or -not (Has-Property $localFeatures.capabilityTiers "connectors")) {
            Add-Failure "diagnostics localFeatures missing connector capability tier"
        } else {
            $connectorTier = $localFeatures.capabilityTiers.connectors
            if (-not (Has-Property $connectorTier "authorizedCount")) { Add-Failure "diagnostics connector tier missing authorizedCount" }
            if (-not (Has-Property $connectorTier "remoteAuthorizedCount")) { Add-Failure "diagnostics connector tier missing remoteAuthorizedCount" }
            if (-not (Has-Property $connectorTier "localAllowlistedCount")) { Add-Failure "diagnostics connector tier missing localAllowlistedCount" }
            if (-not (Has-Property $connectorTier "callableToolCount")) { Add-Failure "diagnostics connector tier missing callableToolCount" }
            if (-not (Has-Property $connectorTier "mode")) {
                Add-Failure "diagnostics connector tier missing mode"
            } elseif (@("metadata-only", "real-authorized") -notcontains [string]$connectorTier.mode) {
                Add-Failure "diagnostics connector tier mode is not explicit"
            }
        }
    }
    if (-not (Has-Property $diagnostics "antigravityRetries")) {
        Add-Failure "diagnostics missing Antigravity retry audit"
    } elseif (-not (Has-Property $diagnostics.antigravityRetries "count")) {
        Add-Failure "diagnostics Antigravity retry audit missing count"
    }
    if (-not (Has-Property $diagnostics "antigravityQueue")) {
        Add-Failure "diagnostics missing Antigravity request queue"
    } elseif (-not (Has-Property $diagnostics.antigravityQueue "queued") -or -not (Has-Property $diagnostics.antigravityQueue "maxQueued")) {
        Add-Failure "diagnostics Antigravity request queue is missing queue limits"
    } elseif ([int]$diagnostics.antigravityQueue.queued -gt [int]$diagnostics.antigravityQueue.maxQueued) {
        Add-Failure "diagnostics Antigravity request queue exceeds its configured limit"
    }
    if (-not (Has-Property $diagnostics "antigravitySessionLock")) {
        Add-Failure "diagnostics missing Antigravity session lock"
    } elseif (-not (Has-Property $diagnostics.antigravitySessionLock "queued") -or -not (Has-Property $diagnostics.antigravitySessionLock "maxQueued")) {
        Add-Failure "diagnostics Antigravity session lock is missing queue limits"
    } elseif ([int]$diagnostics.antigravitySessionLock.queued -gt [int]$diagnostics.antigravitySessionLock.maxQueued) {
        Add-Failure "diagnostics Antigravity session lock exceeds its configured limit"
    }
    if (-not (Has-Property $diagnostics "activeAntigravityRequests")) {
        Add-Failure "diagnostics missing active Antigravity request count"
    } elseif (-not (Has-Property $diagnostics.activeAntigravityRequests "active")) {
        Add-Failure "diagnostics active Antigravity request count is incomplete"
    }
    if (-not (Has-Property $diagnostics "updateStatus")) {
        Add-Failure "diagnostics missing Codex update status"
    } elseif (-not (Has-Property $diagnostics.updateStatus "updateNeeded")) {
        Add-Failure "diagnostics Codex update status missing updateNeeded"
    } elseif ($diagnostics.updateStatus.ok -ne $true) {
        Add-Failure "diagnostics Codex update status is not ready"
    } elseif ($diagnostics.updateStatus.updateNeeded -eq $true) {
        Add-Failure "diagnostics reports that Anti-Codex needs a Codex host sync"
    }
    if (-not (Has-Property $diagnostics "postVerification")) {
        Add-Failure "diagnostics missing post-verification status"
    } else {
        $postVerification = $diagnostics.postVerification
        if (-not (Has-Property $postVerification "state")) { Add-Failure "diagnostics post-verification missing state" }
        if (-not (Has-Property $postVerification "usedRealTraffic")) { Add-Failure "diagnostics post-verification missing usedRealTraffic" }
        if (-not (Has-Property $postVerification "latestDiagnosis")) { Add-Failure "diagnostics post-verification missing latestDiagnosis" }
        if (-not (Has-Property $postVerification "latestDiagnosisDetail")) { Add-Failure "diagnostics post-verification missing latestDiagnosisDetail" }
        if (-not (Has-Property $postVerification "attempts")) { Add-Failure "diagnostics post-verification missing attempts" }
        if (-not (Has-Property $postVerification "failureCount")) { Add-Failure "diagnostics post-verification missing failureCount" }
    }
    if (-not (Has-Property $diagnostics "shortcutRepair")) {
        Add-Failure "diagnostics missing shortcut repair status"
    } else {
        $shortcutRepair = $diagnostics.shortcutRepair
        if (-not (Has-Property $shortcutRepair "present")) { Add-Failure "diagnostics shortcut repair missing present" }
        if (-not (Has-Property $shortcutRepair "ok")) { Add-Failure "diagnostics shortcut repair missing ok" }
        if (-not (Has-Property $shortcutRepair "repairedCount")) { Add-Failure "diagnostics shortcut repair missing repairedCount" }
        if (-not (Has-Property $shortcutRepair "reportName")) { Add-Failure "diagnostics shortcut repair missing reportName" }
    }
    if (-not (Has-Property $diagnostics "sourcePreflight")) {
        Add-Failure "diagnostics missing source preflight status"
    } else {
        $sourcePreflight = $diagnostics.sourcePreflight
        if (-not (Has-Property $sourcePreflight "present")) { Add-Failure "diagnostics source preflight missing present" }
        if (-not (Has-Property $sourcePreflight "ok")) { Add-Failure "diagnostics source preflight missing ok" }
        if (-not (Has-Property $sourcePreflight "reportName")) { Add-Failure "diagnostics source preflight missing reportName" }
        if (-not (Has-Property $sourcePreflight "javascriptSyntaxOk")) { Add-Failure "diagnostics source preflight missing JavaScript syntax result" }
        if (-not (Has-Property $sourcePreflight "powershellSyntaxOk")) { Add-Failure "diagnostics source preflight missing PowerShell syntax result" }
        if (-not (Has-Property $sourcePreflight "uiStateSelfTestOk")) { Add-Failure "diagnostics source preflight missing UI state self-test result" }
        if (-not (Has-Property $sourcePreflight "upstreamProfileStorageOk")) { Add-Failure "diagnostics source preflight missing upstream profile storage result" }
        if (-not (Has-Property $sourcePreflight "localConnectorVerifierOk")) { Add-Failure "diagnostics source preflight missing local connector verifier result" }
        if (-not (Has-Property $sourcePreflight "publicDocumentationOk")) { Add-Failure "diagnostics source preflight missing public documentation result" }
        if (-not (Has-Property $sourcePreflight "translatorRegressionOk")) { Add-Failure "diagnostics source preflight missing translator regression result" }
        if (-not (Has-Property $sourcePreflight "diffWhitespaceOk")) { Add-Failure "diagnostics source preflight missing diff whitespace result" }
        if (-not (Has-Property $sourcePreflight "skipFullRegression")) { Add-Failure "diagnostics source preflight missing skipFullRegression" }
    }
    if (-not (Has-Property $diagnostics "lifecycle")) {
        Add-Failure "diagnostics missing translator lifecycle status"
    } else {
        $lifecycle = $diagnostics.lifecycle
        if (-not (Has-Property $lifecycle "type")) { Add-Failure "diagnostics lifecycle missing type" }
        if (-not (Has-Property $lifecycle "at")) { Add-Failure "diagnostics lifecycle missing timestamp" }
        if (-not (Has-Property $lifecycle "pid")) { Add-Failure "diagnostics lifecycle missing pid" }
        if (-not (Has-Property $lifecycle "port")) { Add-Failure "diagnostics lifecycle missing port" }
        if (-not (Has-Property $lifecycle "message")) { Add-Failure "diagnostics lifecycle missing message" }
    }

    if (-not (Has-Property $diagnostics "tools")) {
        Add-Failure "diagnostics missing tools section"
    } else {
        $tools = $diagnostics.tools
        if (-not (Has-Property $tools "bridge")) {
            Add-Failure "diagnostics.tools missing bridge field"
        } else {
            $bridge = [string]$tools.bridge
            $expectedBridge = if ($diagnosticMode -eq "third-party") { "provider_native_or_compat" } else { "native_mcp_same_cascade" }
            if ($bridge -ne $expectedBridge) {
                Add-Failure "diagnostics.tools.bridge is '$bridge', expected '$expectedBridge'"
            }
        }
        if (-not (Has-Property $tools "description")) {
            Add-Failure "diagnostics.tools missing description field"
        } elseif ($diagnosticMode -eq "antigravity" -and ([string]$tools.description) -notmatch "automatically approved") {
            Add-Failure "diagnostics.tools.description missing automatic native permission handling"
        }
        if (-not (Has-Property $tools "antigravityMode")) {
            Add-Failure "diagnostics.tools missing antigravityMode field"
        } elseif ($diagnosticMode -eq "antigravity" -and $tools.antigravityMode -ne $true) {
            Add-Failure "diagnostics.tools.antigravityMode is not true in Antigravity mode"
        } elseif ($diagnosticMode -eq "third-party" -and $tools.antigravityMode -ne $false) {
            Add-Failure "diagnostics.tools.antigravityMode is not false in third-party mode"
        }
        if ($diagnosticMode -eq "antigravity" -and $tools.nativeAntigravityToolEvents -ne $true) {
            Add-Failure "diagnostics.tools should confirm native Antigravity tool events"
        } elseif ($diagnosticMode -eq "third-party" -and $tools.nativeAntigravityToolEvents -ne $false) {
            Add-Failure "diagnostics.tools unexpectedly reports native Antigravity tool events in third-party mode"
        }
        if ($tools.acceptsExternalToolDefinitions -ne $true) {
            Add-Failure "diagnostics.tools should confirm external tool definitions"
        }
    }

    $serialized = $diagnostics | ConvertTo-Json -Depth 20 -Compress
    if ($serialized -match "(?i)tool output|messages|input_items|Return exactly this") {
        Add-Failure "diagnostics appears to expose prompt/tool transcript fields"
    }
}

$bundleCheck = $null
if ($VerifyBundle) {
    try {
        $bundleCheck = Test-DiagnosticBundle
    } catch {
        Add-Failure "diagnostic bundle verification failed: $($_.Exception.Message)"
    }
}

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    diagnostics = if ($diagnostics) {
        [pscustomobject]@{
            object = $diagnostics.object
            upstream = $diagnostics.mode.upstream
            mode = $diagnosticMode
            protocol = $diagnosticProtocol
            model = $diagnosticModel
            accountReady = $diagnostics.health.accountReady
            accountState = $diagnostics.health.accountState
            circuitState = $diagnostics.health.antigravityCircuitState
            modelCount = $diagnostics.models.count
            postVerification = $diagnostics.postVerification
            shortcutRepair = $diagnostics.shortcutRepair
            sourcePreflight = $diagnostics.sourcePreflight
            accountTracking = $diagnostics.accountTracking
            latestRoute = $diagnostics.modelRoutes.latest
            toolBridge = $diagnostics.toolBridge
            localFeatures = $diagnostics.localFeatures
            antigravityRetries = $diagnostics.antigravityRetries
            antigravityQueue = $diagnostics.antigravityQueue
            antigravitySessionLock = $diagnostics.antigravitySessionLock
            activeAntigravityRequests = $diagnostics.activeAntigravityRequests
            updateStatus = $diagnostics.updateStatus
            lifecycle = $diagnostics.lifecycle
            stateRoot = $diagnostics.paths.stateRoot
            codexHome = $diagnostics.paths.codexHome
            sharedCodexHome = $diagnostics.paths.sharedCodexHome
        }
    } else { $null }
    bundle = $bundleCheck
}

$result | ConvertTo-Json -Depth 10 -Compress
if ($failures.Count -gt 0) { exit 1 }
