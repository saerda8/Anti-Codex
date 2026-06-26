[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [int]$TimeoutSec = 20,
    [switch]$VerifyBundle,
    [string]$VerifyReportsSummary = ""
)

$ErrorActionPreference = "Stop"
$script:verifierStartedAt = [DateTime]::UtcNow

if (-not $BaseUrl) {
    if (-not $VerifyReportsSummary) {
        $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
    }
}
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Get-RemainingVerifierBudgetMs {
    $elapsedMs = ([DateTime]::UtcNow - $script:verifierStartedAt).TotalMilliseconds
    return [Math]::Max(0, ($TimeoutSec * 1000) - [int]$elapsedMs)
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

function Get-NonNegativeIntProperty {
    param(
        $Value,
        [string]$Name,
        [string]$MissingMessage,
        [string]$InvalidMessage
    )
    if (-not (Has-Property $Value $Name)) {
        Add-Failure $MissingMessage
        return $null
    }
    $raw = $Value.PSObject.Properties[$Name].Value
    if ($null -eq $raw) {
        Add-Failure $InvalidMessage
        return $null
    }
    $text = [string]$raw
    $parsed = 0
    if (-not [int]::TryParse($text, [ref]$parsed) -or $parsed -lt 0) {
        Add-Failure $InvalidMessage
        return $null
    }
    return $parsed
}

function Find-TextHint {
    param(
        [string]$Text,
        [string[]]$Hints
    )
    foreach ($hint in $Hints) {
        if ($Text.Contains($hint)) {
            return $hint
        }
    }
    return ""
}

function Test-InstalledRuntimeEvidence {
    param($Evidence)

    if (-not $Evidence) {
        Add-Failure "release-gates summary missing installed runtime drift evidence"
        return
    }

    $sourceFileCount = Get-NonNegativeIntProperty $Evidence "sourceFileCount" "release-gates summary missing installed runtime source file count" "release-gates summary invalid installed runtime source file count"
    if ($null -ne $sourceFileCount -and $sourceFileCount -lt 1) { Add-Failure "release-gates summary missing installed runtime source file count" }
    $installedFileCount = Get-NonNegativeIntProperty $Evidence "installedRuntimeFileCount" "release-gates summary missing installed runtime target file count" "release-gates summary invalid installed runtime target file count"
    if ($null -ne $installedFileCount -and $installedFileCount -lt 1) { Add-Failure "release-gates summary missing installed runtime target file count" }
    if (-not [string]$Evidence.sourceFingerprint) { Add-Failure "release-gates summary missing installed runtime source fingerprint" }
    if (-not [string]$Evidence.installedRuntimeFingerprint) { Add-Failure "release-gates summary missing installed runtime target fingerprint" }
    if (-not (Has-Property $Evidence "satisfied")) { Add-Failure "release-gates summary missing installed runtime satisfied flag" }

    if ($Evidence.satisfied -eq $true) {
        if ([string]$Evidence.sourceFingerprint -ne [string]$Evidence.installedRuntimeFingerprint) {
            Add-Failure "release-gates summary reports installed runtime satisfied with mismatched fingerprints"
        }
        foreach ($driftField in @("missingSourceFiles", "missingInstalledRuntimeFiles", "mismatchedRuntimeFiles")) {
            if (-not (Has-Property $Evidence $driftField)) {
                Add-Failure "release-gates summary reports installed runtime satisfied without $driftField evidence"
            } elseif (@(As-FlatArray $Evidence.PSObject.Properties[$driftField].Value | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -ne 0) {
                Add-Failure "release-gates summary reports installed runtime satisfied with $driftField drift"
            }
        }
    }
}

function Test-ReleaseGateApprovalAndOfflineEvidence {
    param($ReleaseGatesSummary)

    $pluginCapabilityFailure = @($ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { $_.id -eq "pluginCapabilities" } | Select-Object -First 1)[0]
    if ($pluginCapabilityFailure) {
        $offlineSnapshotEvidence = $pluginCapabilityFailure.offlineSnapshotEvidence
        if (-not $offlineSnapshotEvidence) {
            Add-Failure "plugin capability failure missing offline snapshot evidence"
        } elseif ($offlineSnapshotEvidence.connectorContentMatches -ne $true -or $offlineSnapshotEvidence.appToolContentMatches -ne $true) {
            Add-Failure "plugin capability failure offline snapshot evidence is not clean"
        } else {
            if ($offlineSnapshotEvidence.refreshGateSatisfied -ne $true) {
                Add-Failure "plugin capability failure offline refresh gate is not satisfied"
            }
            if ([string]::IsNullOrWhiteSpace([string]$offlineSnapshotEvidence.refreshSelectedFile)) {
                Add-Failure "plugin capability failure offline refresh selected file missing"
            }
            if ([string]::IsNullOrWhiteSpace([string]$offlineSnapshotEvidence.sourceFingerprint)) {
                Add-Failure "plugin capability failure offline source fingerprint missing"
            }
            $offlineSourceFileCount = Get-NonNegativeIntProperty $offlineSnapshotEvidence "sourceFileCount" "plugin capability failure offline source file count missing" "plugin capability failure offline source file count invalid"
            if ($null -ne $offlineSourceFileCount -and $offlineSourceFileCount -lt 1) {
                Add-Failure "plugin capability failure offline source file count invalid"
            }
            if ([string]::IsNullOrWhiteSpace([string]$offlineSnapshotEvidence.sourceMtimeMax)) {
                Add-Failure "plugin capability failure offline source mtime missing"
            }
        }
        $pluginFailureSamples = @(As-FlatArray $pluginCapabilityFailure.reportFailureSamples | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        $pluginFailureCodes = @(As-FlatArray $pluginCapabilityFailure.reportFailureSampleCodes | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($pluginFailureSamples.Count -gt 0 -and $pluginFailureCodes.Count -lt 1) {
            Add-Failure "plugin capability failure missing sample codes"
        }
    }
    foreach ($gateFailure in @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons)) {
        $gateFailureId = [string]$gateFailure.id
        if ([string]::IsNullOrWhiteSpace($gateFailureId)) {
            $gateFailureId = "unknown"
        }
        $gateFailureSamples = @(As-FlatArray $gateFailure.reportFailureSamples | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        $gateFailureCodes = @(As-FlatArray $gateFailure.reportFailureSampleCodes | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($gateFailureSamples.Count -gt 0 -and $gateFailureCodes.Count -lt 1) {
            Add-Failure "release-gates failure $gateFailureId missing sample codes"
        }
        if (Has-Property $gateFailure "failureReasons") {
            $visibleFailureReasons = @(As-FlatArray $gateFailure.failureReasons | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
            $availableFailureReasons = Get-NonNegativeIntProperty $gateFailure "failureReasonsAvailableCount" "release-gates failure $gateFailureId missing failureReasons available count" "release-gates failure $gateFailureId invalid failureReasons available count"
            $hiddenFailureReasons = Get-NonNegativeIntProperty $gateFailure "failureReasonsHiddenCount" "release-gates failure $gateFailureId missing failureReasons hidden count" "release-gates failure $gateFailureId invalid failureReasons hidden count"
            if ($null -ne $availableFailureReasons -and $availableFailureReasons -lt $visibleFailureReasons.Count) {
                Add-Failure "release-gates failure $gateFailureId failureReasons available count is below visible reasons"
            }
            if ($null -ne $availableFailureReasons -and $null -ne $hiddenFailureReasons -and $hiddenFailureReasons -ne ($availableFailureReasons - $visibleFailureReasons.Count)) {
                Add-Failure "release-gates failure $gateFailureId failureReasons hidden count mismatch"
            }
        }
    }
    $semanticFailureEntryCount = 0
    foreach ($semanticFailure in @(As-FlatArray $ReleaseGatesSummary.releaseGateFailures)) {
        if (-not (Has-Property $semanticFailure "semanticFailures")) { continue }
        $semanticFailureId = [string]$semanticFailure.id
        if ([string]::IsNullOrWhiteSpace($semanticFailureId)) {
            $semanticFailureId = "unknown"
        }
        $visibleSemanticFailures = @(As-FlatArray $semanticFailure.semanticFailures | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($visibleSemanticFailures.Count -gt 0) {
            $semanticFailureEntryCount++
            $matchingSemanticReason = @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object {
                [string]$_.id -eq $semanticFailureId -and @(As-FlatArray $_.failureReasons | Where-Object { [string]$_ -eq "semantic_failures" }).Count -gt 0
            })
            if ($matchingSemanticReason.Count -lt 1) {
                Add-Failure "release-gates failure $semanticFailureId missing semantic failure reason marker"
            }
        }
        $availableSemanticFailures = Get-NonNegativeIntProperty $semanticFailure "semanticFailuresAvailableCount" "release-gates failure $semanticFailureId missing semanticFailures available count" "release-gates failure $semanticFailureId invalid semanticFailures available count"
        $hiddenSemanticFailures = Get-NonNegativeIntProperty $semanticFailure "semanticFailuresHiddenCount" "release-gates failure $semanticFailureId missing semanticFailures hidden count" "release-gates failure $semanticFailureId invalid semanticFailures hidden count"
        if ($null -ne $availableSemanticFailures -and $availableSemanticFailures -lt $visibleSemanticFailures.Count) {
            Add-Failure "release-gates failure $semanticFailureId semanticFailures available count is below visible failures"
        }
        if ($null -ne $availableSemanticFailures -and $null -ne $hiddenSemanticFailures -and $hiddenSemanticFailures -ne ($availableSemanticFailures - $visibleSemanticFailures.Count)) {
            Add-Failure "release-gates failure $semanticFailureId semanticFailures hidden count mismatch"
        }
    }
    foreach ($optionalFailureId in @(As-FlatArray $ReleaseGatesSummary.optionalRealTrafficFailures | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $optionalFailure = @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $optionalFailureId } | Select-Object -First 1)[0]
        if (-not $optionalFailure) {
            Add-Failure "release-gates optional real-traffic failure $optionalFailureId missing failure reason details"
        } elseif ([string]::IsNullOrWhiteSpace([string]$optionalFailure.guidance)) {
            Add-Failure "release-gates optional real-traffic failure $optionalFailureId missing guidance"
        }
    }
    $optionalRealTrafficFailureIds = @(As-FlatArray $ReleaseGatesSummary.optionalRealTrafficFailures | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($ReleaseGatesSummary.optionalRealTrafficReady -eq $true -and $optionalRealTrafficFailureIds.Count -gt 0) {
        Add-Failure "release-gates optional real-traffic ready has failures"
    }
    if ($ReleaseGatesSummary.strictOptionalRealTraffic -eq $true -and $ReleaseGatesSummary.optionalRealTrafficReady -ne $true -and $ReleaseGatesSummary.releaseReady -eq $true) {
        Add-Failure "release-gates releaseReady true while strict optional real-traffic is not ready"
    }
    if ($ReleaseGatesSummary.shortReady -eq $true -and @(As-FlatArray $ReleaseGatesSummary.missingShort | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
        Add-Failure "release-gates shortReady true with missing short gates"
    }
    if ($ReleaseGatesSummary.releaseReady -eq $true -and @(As-FlatArray $ReleaseGatesSummary.missingRequired | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
        Add-Failure "release-gates releaseReady true with missing required gates"
    }
    if ($ReleaseGatesSummary.effectiveOk -eq $true -and $ReleaseGatesSummary.releaseReady -ne $true) {
        Add-Failure "release-gates effectiveOk true while releaseReady is not true"
    }
    if ($ReleaseGatesSummary.effectiveOk -eq $true -and @(As-FlatArray $ReleaseGatesSummary.damagedReports | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
        Add-Failure "release-gates effectiveOk true with damaged reports"
    }
    foreach ($failureId in @(As-FlatArray $ReleaseGatesSummary.releaseGateFailures | ForEach-Object { if ($_.id) { [string]$_.id } else { [string]$_ } } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        if (@(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $failureId }).Count -lt 1) {
            Add-Failure "release-gates failure $failureId missing failure reason details"
        }
    }
    foreach ($damagedReportId in @(As-FlatArray $ReleaseGatesSummary.damagedReports | ForEach-Object { if ($_.id) { [string]$_.id } elseif ($_.file) { [string]$_.file } else { [string]$_ } } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        if (@(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $damagedReportId -or [string]$_.file -eq $damagedReportId -or [string]$_.selectedFile -eq $damagedReportId }).Count -lt 1) {
            Add-Failure "release-gates damaged report $damagedReportId missing failure reason details"
        }
    }
    if (-not (Has-Property $ReleaseGatesSummary "nextActions")) { Add-Failure "release-gates summary missing ordered next actions" }
    if (-not (Has-Property $ReleaseGatesSummary "approvalPlan")) { Add-Failure "release-gates summary missing approval plan" }
    $nextActions = @(As-FlatArray $ReleaseGatesSummary.nextActions)
    $nextActionsAvailableCount = Get-NonNegativeIntProperty $ReleaseGatesSummary "nextActionsAvailableCount" "release-gates summary missing nextActions available count" "release-gates summary invalid nextActions available count"
    $nextActionsHiddenCount = Get-NonNegativeIntProperty $ReleaseGatesSummary "nextActionsHiddenCount" "release-gates summary missing nextActions hidden count" "release-gates summary invalid nextActions hidden count"
    if ($null -ne $nextActionsAvailableCount -and $nextActionsAvailableCount -lt $nextActions.Count) {
        Add-Failure "release-gates summary nextActions available count is below visible actions"
    }
    if ($null -ne $nextActionsAvailableCount -and $null -ne $nextActionsHiddenCount -and $nextActionsHiddenCount -ne ($nextActionsAvailableCount - $nextActions.Count)) {
        Add-Failure "release-gates summary nextActions hidden count mismatch"
    }
    if (-not (Has-Property $ReleaseGatesSummary "nextActionsTruncated")) {
        Add-Failure "release-gates summary missing nextActions truncated flag"
    } elseif (($ReleaseGatesSummary.nextActionsTruncated -eq $true) -ne ($nextActionsHiddenCount -gt 0)) {
        Add-Failure "release-gates summary nextActions truncated flag mismatch"
    }
    $missingRequiredGates = @(As-FlatArray $ReleaseGatesSummary.missingRequired | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($missingGateId in $missingRequiredGates) {
        $matchingActions = @($nextActions | Where-Object { [string]$_.id -eq $missingGateId -or [string]$_.gateId -eq $missingGateId })
        if ($matchingActions.Count -lt 1) {
            Add-Failure "release-gates missing required gate $missingGateId has no next action"
        }
        $matchingFailureReasons = @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $missingGateId })
        if ($matchingFailureReasons.Count -lt 1) {
            Add-Failure "release-gates missing required gate $missingGateId missing failure reason details"
        } elseif (@($matchingFailureReasons | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.guidance) }).Count -lt 1) {
            Add-Failure "release-gates missing required gate $missingGateId missing guidance"
        } elseif (@($matchingFailureReasons | Where-Object { $_.requiredForRelease -eq $true }).Count -lt 1) {
            Add-Failure "release-gates missing required gate $missingGateId missing required-for-release marker"
        }
    }
    foreach ($missingShortId in @(As-FlatArray $ReleaseGatesSummary.missingShort | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $matchingFailureReasons = @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $missingShortId })
        if ($matchingFailureReasons.Count -lt 1) {
            Add-Failure "release-gates missing short gate $missingShortId missing failure reason details"
        } elseif (@($matchingFailureReasons | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.guidance) }).Count -lt 1) {
            Add-Failure "release-gates missing short gate $missingShortId missing guidance"
        } elseif (@($matchingFailureReasons | Where-Object { $_.requiredForShort -eq $true }).Count -lt 1) {
            Add-Failure "release-gates missing short gate $missingShortId missing required-for-short marker"
        }
        if (@($nextActions | Where-Object { [string]$_.id -eq $missingShortId -or [string]$_.gateId -eq $missingShortId }).Count -lt 1) {
            Add-Failure "release-gates missing short gate $missingShortId missing next action"
        }
    }
    $missingOptionalGates = @(As-FlatArray $ReleaseGatesSummary.missingOptional | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($missingOptionalId in $missingOptionalGates) {
        $matchingFailureReasons = @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $missingOptionalId })
        if ($matchingFailureReasons.Count -lt 1) {
            Add-Failure "release-gates missing optional gate $missingOptionalId missing failure reason details"
        } elseif (@($matchingFailureReasons | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.guidance) }).Count -lt 1) {
            Add-Failure "release-gates missing optional gate $missingOptionalId missing guidance"
        } elseif (@($matchingFailureReasons | Where-Object { (Has-Property $_ "requiredForRelease") -and $_.requiredForRelease -ne $true }).Count -lt 1) {
            Add-Failure "release-gates missing optional gate $missingOptionalId missing optional marker"
        }
    }
    if (-not (Has-Property $ReleaseGatesSummary "releaseGateGroups")) {
        Add-Failure "release-gates summary missing release gate group evidence"
    } else {
        foreach ($releaseGateGroup in @(As-FlatArray $ReleaseGatesSummary.releaseGateGroups | Where-Object { $null -ne $_ })) {
            $groupName = [string]$releaseGateGroup.group
            if ([string]::IsNullOrWhiteSpace($groupName)) {
                $groupName = "unknown"
            }
            $groupTotal = Get-NonNegativeIntProperty $releaseGateGroup "total" "release-gates group $groupName missing total count" "release-gates group $groupName invalid total count"
            $groupSatisfied = Get-NonNegativeIntProperty $releaseGateGroup "satisfied" "release-gates group $groupName missing satisfied count" "release-gates group $groupName invalid satisfied count"
            $groupRequired = Get-NonNegativeIntProperty $releaseGateGroup "required" "release-gates group $groupName missing required count" "release-gates group $groupName invalid required count"
            $groupRequiredSatisfied = Get-NonNegativeIntProperty $releaseGateGroup "requiredSatisfied" "release-gates group $groupName missing required satisfied count" "release-gates group $groupName invalid required satisfied count"
            $groupOptional = Get-NonNegativeIntProperty $releaseGateGroup "optional" "release-gates group $groupName missing optional count" "release-gates group $groupName invalid optional count"
            $groupOptionalSatisfied = Get-NonNegativeIntProperty $releaseGateGroup "optionalSatisfied" "release-gates group $groupName missing optional satisfied count" "release-gates group $groupName invalid optional satisfied count"
            if ($null -ne $groupTotal -and $null -ne $groupSatisfied -and $groupSatisfied -gt $groupTotal) { Add-Failure "release-gates group $groupName satisfied count exceeds total" }
            if ($null -ne $groupRequired -and $null -ne $groupRequiredSatisfied -and $groupRequiredSatisfied -gt $groupRequired) { Add-Failure "release-gates group $groupName required satisfied count exceeds required" }
            if ($null -ne $groupOptional -and $null -ne $groupOptionalSatisfied -and $groupOptionalSatisfied -gt $groupOptional) { Add-Failure "release-gates group $groupName optional satisfied count exceeds optional" }
            if ($null -ne $groupTotal -and $null -ne $groupRequired -and $null -ne $groupOptional -and $groupTotal -ne ($groupRequired + $groupOptional)) { Add-Failure "release-gates group $groupName total count mismatch" }
            foreach ($groupMissingRequiredId in @(As-FlatArray $releaseGateGroup.missingRequired | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
                if ($missingRequiredGates -notcontains $groupMissingRequiredId) {
                    Add-Failure "release-gates group $groupName missing required gate $groupMissingRequiredId absent from top-level missingRequired"
                }
                if (@(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $groupMissingRequiredId }).Count -lt 1) {
                    Add-Failure "release-gates group $groupName missing required gate $groupMissingRequiredId missing failure reason details"
                }
                if (@($nextActions | Where-Object { [string]$_.id -eq $groupMissingRequiredId -or [string]$_.gateId -eq $groupMissingRequiredId }).Count -lt 1) {
                    Add-Failure "release-gates group $groupName missing required gate $groupMissingRequiredId has no next action"
                }
            }
            foreach ($groupMissingOptionalId in @(As-FlatArray $releaseGateGroup.missingOptional | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
                if ($missingOptionalGates -notcontains $groupMissingOptionalId) {
                    Add-Failure "release-gates group $groupName missing optional gate $groupMissingOptionalId absent from top-level missingOptional"
                }
                if (@(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons | Where-Object { [string]$_.id -eq $groupMissingOptionalId }).Count -lt 1) {
                    Add-Failure "release-gates group $groupName missing optional gate $groupMissingOptionalId missing failure reason details"
                }
            }
        }
    }
    $gatewayActionCount = 0
    $realTrafficActionCount = 0
    $highImpactActionCount = 0
    $reportOnlyActionCount = 0
    $requiredForShortActionCount = 0
    $requiredForReleaseActionCount = 0
    $blockedActionCount = 0
    $approvalBlockedRiskActionCount = 0
    $semanticFailureCount = @(
        As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons |
            Where-Object { @(As-FlatArray $_.failureReasons | Where-Object { [string]$_ -eq "semantic_failures" }).Count -gt 0 }
    ).Count
    $gatewayCommandHints = @(
        "start-deepcodex.ps1",
        "test-anticodex-missing-history.mjs",
        "test-anticodex-plugin-capabilities.ps1",
        "test-anticodex-manager-real-buttons.ps1",
        "test-anticodex-codex-responses.ps1",
        "test-anticodex-tool-loop.ps1",
        "test-anticodex-native-tool-loop.ps1",
        "test-anticodex-native-multi-tool-loop.ps1",
        "test-anticodex-mcp-tool-loop.ps1",
        "test-anticodex-custom-tool-loop.ps1",
        "test-anticodex-compaction-resume.ps1",
        "test-anticodex-cancellation.ps1",
        "test-anticodex-web-tools.ps1",
        "test-anticodex-real-mini-tool.ps1",
        "test-anticodex-real-work.ps1",
        "test-anticodex-post-verification.ps1",
        "test-anticodex-account-proxy-readiness.ps1",
        "test-anticodex-stability-soak.ps1",
        "test-anticodex-cold-relaunch.ps1"
    )
    $realTrafficCommandHints = @(
        "-allowrealtraffic",
        "test-anticodex-codex-responses.ps1",
        "test-anticodex-tool-loop.ps1",
        "test-anticodex-native-tool-loop.ps1",
        "test-anticodex-native-multi-tool-loop.ps1",
        "test-anticodex-mcp-tool-loop.ps1",
        "test-anticodex-custom-tool-loop.ps1",
        "test-anticodex-compaction-resume.ps1",
        "test-anticodex-cancellation.ps1",
        "test-anticodex-web-tools.ps1",
        "test-anticodex-real-mini-tool.ps1",
        "test-anticodex-real-work.ps1",
        "test-anticodex-post-verification.ps1",
        "test-anticodex-account-proxy-readiness.ps1",
        "test-anticodex-stability-soak.ps1"
    )
    $highImpactCommandHints = @(
        "-allowrealtraffic",
        "-confirmrelaunch",
        "sync-anticodex-launcher.ps1",
        "sync-anticodex.ps1",
        "test-anticodex-real-mini-tool.ps1",
        "test-anticodex-real-work.ps1",
        "test-anticodex-post-verification.ps1",
        "test-anticodex-stability-soak.ps1",
        "test-anticodex-cold-relaunch.ps1"
    )
    foreach ($nextAction in $nextActions) {
        $actionId = [string]$nextAction.id
        if ([string]::IsNullOrWhiteSpace($actionId)) {
            Add-Failure "release-gates next action missing id"
            $actionId = "unknown"
        }
        $requiresGateway = $nextAction.requiresGatewayStart -eq $true
        $requiresRealTraffic = $nextAction.requiresRealTraffic -eq $true
        $highImpact = $nextAction.highImpact -eq $true
        $blocked = $nextAction.blockedUntilExplicitUserApproval -eq $true
        if ([string]::IsNullOrWhiteSpace([string]$nextAction.command)) {
            Add-Failure "release-gates next action $actionId missing command"
        }
        if ($requiresGateway) { $gatewayActionCount++ }
        if ($requiresRealTraffic) { $realTrafficActionCount++ }
        if ($highImpact) { $highImpactActionCount++ }
        if ($nextAction.reportOnly -eq $true) { $reportOnlyActionCount++ }
        if ($nextAction.requiredForShort -eq $true) { $requiredForShortActionCount++ }
        if ($nextAction.requiredForRelease -eq $true) { $requiredForReleaseActionCount++ }
        if ($blocked) { $blockedActionCount++ }
        $commandText = ([string]$nextAction.command).ToLowerInvariant()
        if (-not [string]::IsNullOrWhiteSpace($commandText)) {
            $gatewayHint = Find-TextHint $commandText $gatewayCommandHints
            $realTrafficHint = Find-TextHint $commandText $realTrafficCommandHints
            $highImpactHint = Find-TextHint $commandText $highImpactCommandHints
            if (-not [string]::IsNullOrWhiteSpace($gatewayHint) -and -not $requiresGateway) {
                Add-Failure "release-gates next action $actionId command requires gateway metadata"
            }
            if (-not [string]::IsNullOrWhiteSpace($realTrafficHint) -and -not $requiresRealTraffic) {
                Add-Failure "release-gates next action $actionId command requires real-traffic metadata"
            }
            if (-not [string]::IsNullOrWhiteSpace($highImpactHint) -and -not $highImpact) {
                Add-Failure "release-gates next action $actionId command requires high-impact metadata"
            }
            if ((-not [string]::IsNullOrWhiteSpace($gatewayHint) -or -not [string]::IsNullOrWhiteSpace($realTrafficHint) -or -not [string]::IsNullOrWhiteSpace($highImpactHint)) -and -not $blocked) {
                Add-Failure "release-gates next action $actionId command risk missing explicit approval block"
            }
        }
        if ($requiresGateway -or $requiresRealTraffic -or $highImpact) { $approvalBlockedRiskActionCount++ }
        if (($requiresGateway -or $requiresRealTraffic -or $highImpact) -and -not $blocked) {
            Add-Failure "release-gates next action $actionId missing explicit approval block"
        }
        $reportOnly = $nextAction.reportOnly -eq $true
        if (($requiresGateway -or $requiresRealTraffic -or $highImpact -or $blocked -or $reportOnly) -and [string]::IsNullOrWhiteSpace([string]$nextAction.guidance)) {
            Add-Failure "release-gates next action $actionId missing guidance"
        }
        if (($requiresGateway -or $requiresRealTraffic -or $highImpact -or $blocked -or $reportOnly) -and [string]::IsNullOrWhiteSpace([string]$nextAction.reason)) {
            Add-Failure "release-gates next action $actionId missing reason"
        }
    }
    foreach ($gateFailure in @(As-FlatArray $ReleaseGatesSummary.releaseGateFailureReasons)) {
        $gateFailureId = [string]$gateFailure.id
        if ([string]::IsNullOrWhiteSpace($gateFailureId)) { $gateFailureId = "unknown" }
        if (-not (Has-Property $gateFailure "orderedActions")) { continue }
        $orderedActions = @(As-FlatArray $gateFailure.orderedActions | Where-Object { $null -ne $_ })
        if ($orderedActions.Count -gt 0 -and [string]::IsNullOrWhiteSpace([string]$gateFailure.guidance)) {
            Add-Failure "release-gates failure $gateFailureId with ordered actions missing guidance"
        }
        foreach ($orderedAction in $orderedActions) {
            $actionId = [string]$orderedAction.id
            if ([string]::IsNullOrWhiteSpace($actionId)) {
                Add-Failure "release-gates ordered action $gateFailureId missing id"
                $actionId = "unknown"
            }
            $requiresGateway = $orderedAction.requiresGatewayStart -eq $true
            $requiresRealTraffic = $orderedAction.requiresRealTraffic -eq $true
            $highImpact = $orderedAction.highImpact -eq $true
            $blocked = $orderedAction.blockedUntilExplicitUserApproval -eq $true
            $reportOnly = $orderedAction.reportOnly -eq $true
            $commandText = ([string]$orderedAction.command).ToLowerInvariant()
            if ([string]::IsNullOrWhiteSpace($commandText)) {
                Add-Failure "release-gates ordered action $gateFailureId/$actionId missing command"
            } else {
                $gatewayHint = Find-TextHint $commandText $gatewayCommandHints
                $realTrafficHint = Find-TextHint $commandText $realTrafficCommandHints
                $highImpactHint = Find-TextHint $commandText $highImpactCommandHints
                if (-not [string]::IsNullOrWhiteSpace($gatewayHint) -and -not $requiresGateway) {
                    Add-Failure "release-gates ordered action $gateFailureId/$actionId command requires gateway metadata"
                }
                if (-not [string]::IsNullOrWhiteSpace($realTrafficHint) -and -not $requiresRealTraffic) {
                    Add-Failure "release-gates ordered action $gateFailureId/$actionId command requires real-traffic metadata"
                }
                if (-not [string]::IsNullOrWhiteSpace($highImpactHint) -and -not $highImpact) {
                    Add-Failure "release-gates ordered action $gateFailureId/$actionId command requires high-impact metadata"
                }
                if ((-not [string]::IsNullOrWhiteSpace($gatewayHint) -or -not [string]::IsNullOrWhiteSpace($realTrafficHint) -or -not [string]::IsNullOrWhiteSpace($highImpactHint)) -and -not $blocked) {
                    Add-Failure "release-gates ordered action $gateFailureId/$actionId command risk missing explicit approval block"
                }
            }
            if (($requiresGateway -or $requiresRealTraffic -or $highImpact) -and -not $blocked) {
                Add-Failure "release-gates ordered action $gateFailureId/$actionId missing explicit approval block"
            }
            if (($requiresGateway -or $requiresRealTraffic -or $highImpact -or $blocked -or $reportOnly) -and [string]::IsNullOrWhiteSpace([string]$orderedAction.guidance)) {
                Add-Failure "release-gates ordered action $gateFailureId/$actionId missing guidance"
            }
            if (($requiresGateway -or $requiresRealTraffic -or $highImpact -or $blocked -or $reportOnly) -and [string]::IsNullOrWhiteSpace([string]$orderedAction.reason)) {
                Add-Failure "release-gates ordered action $gateFailureId/$actionId missing reason"
            }
        }
    }
    if (($semanticFailureCount + $semanticFailureEntryCount) -gt 0 -and @($nextActions | Where-Object { $_.reportOnly -eq $true -and [string]$_.id -eq "releaseGateReportOnlyCheck" }).Count -lt 1) {
        Add-Failure "release-gates semantic failures missing report-only next action"
    }
    $approvalPlan = $ReleaseGatesSummary.approvalPlan
    if (-not $approvalPlan -or $approvalPlan -isnot [pscustomobject]) {
        Add-Failure "release-gates approval plan is not an object"
    } else {
        $approvalActionCount = Get-NonNegativeIntProperty $approvalPlan "actionCount" "release-gates approval plan missing action count" "release-gates approval plan invalid action count"
        if ($null -ne $approvalActionCount -and $null -ne $nextActionsAvailableCount -and $approvalActionCount -ne $nextActionsAvailableCount) {
            Add-Failure "release-gates approval plan action count mismatch"
        }
        $approvalBlockedCount = Get-NonNegativeIntProperty $approvalPlan "blockedCount" "release-gates approval plan missing blocked count" "release-gates approval plan invalid blocked count"
        if ($null -ne $approvalBlockedCount -and $approvalBlockedCount -lt $blockedActionCount) { Add-Failure "release-gates approval plan undercounts blocked actions" }
        if ($null -ne $approvalBlockedCount -and $null -ne $approvalActionCount -and $approvalBlockedCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts blocked actions" }
        $approvalGatewayCount = Get-NonNegativeIntProperty $approvalPlan "requiresGatewayStartCount" "release-gates approval plan missing gateway count" "release-gates approval plan invalid gateway count"
        if ($null -ne $approvalGatewayCount -and $approvalGatewayCount -lt $gatewayActionCount) { Add-Failure "release-gates approval plan undercounts gateway actions" }
        if ($null -ne $approvalGatewayCount -and $null -ne $approvalActionCount -and $approvalGatewayCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts gateway actions" }
        $approvalRealTrafficCount = Get-NonNegativeIntProperty $approvalPlan "requiresRealTrafficCount" "release-gates approval plan missing real-traffic count" "release-gates approval plan invalid real-traffic count"
        if ($null -ne $approvalRealTrafficCount -and $approvalRealTrafficCount -lt $realTrafficActionCount) { Add-Failure "release-gates approval plan undercounts real-traffic actions" }
        if ($null -ne $approvalRealTrafficCount -and $null -ne $approvalActionCount -and $approvalRealTrafficCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts real-traffic actions" }
        $approvalHighImpactCount = Get-NonNegativeIntProperty $approvalPlan "highImpactCount" "release-gates approval plan missing high-impact count" "release-gates approval plan invalid high-impact count"
        if ($null -ne $approvalHighImpactCount -and $approvalHighImpactCount -lt $highImpactActionCount) { Add-Failure "release-gates approval plan undercounts high-impact actions" }
        if ($null -ne $approvalHighImpactCount -and $null -ne $approvalActionCount -and $approvalHighImpactCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts high-impact actions" }
        $approvalReportOnlyCount = Get-NonNegativeIntProperty $approvalPlan "reportOnlyCount" "release-gates approval plan missing report-only count" "release-gates approval plan invalid report-only count"
        if ($null -ne $approvalReportOnlyCount -and $approvalReportOnlyCount -lt $reportOnlyActionCount) { Add-Failure "release-gates approval plan undercounts report-only actions" }
        if ($null -ne $approvalReportOnlyCount -and $null -ne $approvalActionCount -and $approvalReportOnlyCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan report-only action count mismatch" }
        $approvalRequiredForShortCount = Get-NonNegativeIntProperty $approvalPlan "requiredForShortCount" "release-gates approval plan missing required-for-short count" "release-gates approval plan invalid required-for-short count"
        if ($null -ne $approvalRequiredForShortCount -and $approvalRequiredForShortCount -lt $requiredForShortActionCount) { Add-Failure "release-gates approval plan undercounts required-for-short actions" }
        if ($null -ne $approvalRequiredForShortCount -and $null -ne $approvalActionCount -and $approvalRequiredForShortCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts required-for-short actions" }
        $approvalRequiredForReleaseCount = Get-NonNegativeIntProperty $approvalPlan "requiredForReleaseCount" "release-gates approval plan missing required-for-release count" "release-gates approval plan invalid required-for-release count"
        if ($null -ne $approvalRequiredForReleaseCount -and $approvalRequiredForReleaseCount -lt $requiredForReleaseActionCount) { Add-Failure "release-gates approval plan undercounts required-for-release actions" }
        if ($null -ne $approvalRequiredForReleaseCount -and $null -ne $approvalActionCount -and $approvalRequiredForReleaseCount -gt $approvalActionCount) { Add-Failure "release-gates approval plan overcounts required-for-release actions" }
        $approvalPhases = @()
        if (Has-Property $approvalPlan "phases") {
            $approvalPhases = @(As-FlatArray $approvalPlan.phases | Where-Object { $null -ne $_ })
        }
        if ($reportOnlyActionCount -gt 0 -and $approvalPhases.Count -gt 0) {
            $reportOnlyPhases = @($approvalPhases | Where-Object { [string]$_.phase -eq "report-only" })
            if ($reportOnlyPhases.Count -lt 1 -or @($reportOnlyPhases | Where-Object { $_.reportOnly -eq $true }).Count -lt 1) {
                Add-Failure "release-gates approval plan report-only phase mismatch"
            }
        }
        foreach ($approvalPhase in $approvalPhases) {
            $phaseName = [string]$approvalPhase.phase
            if ([string]::IsNullOrWhiteSpace($phaseName)) {
                Add-Failure "release-gates approval plan phase missing name"
                continue
            }
            $phaseActions = @($nextActions | Where-Object { [string]$_.phase -eq $phaseName })
            $phaseCount = Get-NonNegativeIntProperty $approvalPhase "count" "release-gates approval plan phase $phaseName missing count" "release-gates approval plan phase $phaseName invalid count"
            if ($null -ne $phaseCount -and $phaseCount -lt $phaseActions.Count) {
                Add-Failure "release-gates approval plan phase $phaseName count mismatch"
            }
            if ($null -ne $phaseCount -and $null -ne $approvalActionCount -and $phaseCount -gt $approvalActionCount) {
                Add-Failure "release-gates approval plan phase $phaseName count mismatch"
            }
            $expectedPhaseGateway = @($phaseActions | Where-Object { $_.requiresGatewayStart -eq $true }).Count -gt 0
            $expectedPhaseRealTraffic = @($phaseActions | Where-Object { $_.requiresRealTraffic -eq $true }).Count -gt 0
            $expectedPhaseHighImpact = @($phaseActions | Where-Object { $_.highImpact -eq $true }).Count -gt 0
            $expectedPhaseReportOnly = @($phaseActions | Where-Object { $_.reportOnly -eq $true }).Count -gt 0
            $expectedPhaseBlocked = @($phaseActions | Where-Object { $_.blockedUntilExplicitUserApproval -eq $true }).Count -gt 0
            if ($expectedPhaseGateway -and $approvalPhase.requiresGatewayStart -ne $true) { Add-Failure "release-gates approval plan phase $phaseName gateway mismatch" }
            if ($expectedPhaseRealTraffic -and $approvalPhase.requiresRealTraffic -ne $true) { Add-Failure "release-gates approval plan phase $phaseName real-traffic mismatch" }
            if ($expectedPhaseHighImpact -and $approvalPhase.highImpact -ne $true) { Add-Failure "release-gates approval plan phase $phaseName high-impact mismatch" }
            if ($expectedPhaseReportOnly -and $approvalPhase.reportOnly -ne $true) { Add-Failure "release-gates approval plan phase $phaseName report-only mismatch" }
            if ($expectedPhaseBlocked -and $approvalPhase.blockedUntilExplicitUserApproval -ne $true) { Add-Failure "release-gates approval plan phase $phaseName blocked mismatch" }
        }
        if (($blockedActionCount -gt 0 -or $approvalBlockedRiskActionCount -gt 0) -and [string]::IsNullOrWhiteSpace([string]$approvalPlan.firstBlockedAction)) {
            Add-Failure "release-gates approval plan missing first blocked action"
        }
    }
}

function Test-SyncReadinessEvidence {
    param(
        $SyncEvidence,
        [string]$Prefix,
        [bool]$RequireReady = $true
    )
    if (-not $SyncEvidence) {
        Add-Failure "$Prefix missing syncReadinessEvidence"
        return
    }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.sourcePackageVersion)) { Add-Failure "$Prefix missing source package version" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.activePackageVersion)) { Add-Failure "$Prefix missing active package version" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.updateStatusReason)) { Add-Failure "$Prefix missing update status reason" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.sourceHostHash)) { Add-Failure "$Prefix missing source host hash" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.activeHostHash)) { Add-Failure "$Prefix missing active host hash" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.sourceCliHash)) { Add-Failure "$Prefix missing source CLI hash" }
    if ([string]::IsNullOrWhiteSpace([string]$SyncEvidence.activeCliHash)) { Add-Failure "$Prefix missing active CLI hash" }
    if (-not (Has-Property $SyncEvidence "hostHashMatches")) { Add-Failure "$Prefix missing host hash match flag" }
    if (-not (Has-Property $SyncEvidence "cliHashMatches")) { Add-Failure "$Prefix missing CLI hash match flag" }
    if ($RequireReady) {
        if ($SyncEvidence.noTrafficReady -ne $true) { Add-Failure "$Prefix missing no-traffic attestation" }
        if ($SyncEvidence.fullMode -ne $true) { Add-Failure "$Prefix not full mode" }
        if ($SyncEvidence.activeHostReady -ne $true) { Add-Failure "$Prefix active host not ready" }
        if ($SyncEvidence.brandReady -ne $true) { Add-Failure "$Prefix brand not preserved" }
        if ($SyncEvidence.iconReady -ne $true) { Add-Failure "$Prefix icons not ready" }
        if ($SyncEvidence.syncScriptsReady -ne $true) { Add-Failure "$Prefix scripts not ready" }
        if ($SyncEvidence.updateReady -ne $true) { Add-Failure "$Prefix update status not synced" }
        if ($SyncEvidence.guardrailsReady -ne $true) { Add-Failure "$Prefix guardrails not ready" }
        if ([int]$SyncEvidence.shortcutCount -lt 5) { Add-Failure "$Prefix shortcut count too low" }
        if ([int]$SyncEvidence.shortcutReadyCount -ne [int]$SyncEvidence.shortcutCount) { Add-Failure "$Prefix shortcuts not ready" }
        if ([int]$SyncEvidence.desktopShortcutCount -ne 1) { Add-Failure "$Prefix desktop shortcut count wrong" }
        if ([int]$SyncEvidence.forbiddenDesktopHelperCount -ne 0) { Add-Failure "$Prefix has forbidden desktop helpers" }
        if ($SyncEvidence.managerBridgeReady -ne $true) { Add-Failure "$Prefix manager bridge not ready" }
        if ($SyncEvidence.cleanSyncState -ne $true) { Add-Failure "$Prefix sync state not clean" }
    }
}

function Test-ReportsSummary {
    param(
        [Parameter(Mandatory = $true)][string]$SummaryPath,
        [bool]$RequireReleaseReady = $true
    )
    if (-not (Test-Path -LiteralPath $SummaryPath -PathType Leaf)) {
        Add-Failure "reports summary file missing: $SummaryPath"
        return $null
    }

    $summary = As-FlatArray (Get-Content -LiteralPath $SummaryPath -Raw | ConvertFrom-Json)
    $releaseGatesSummary = @($summary | Where-Object { $_.file -eq "latest-release-gates.json" } | Select-Object -First 1)[0]
    $localConnectorsSummary = @($summary | Where-Object { $_.file -eq "latest-local-connectors.json" } | Select-Object -First 1)[0]
    $syncReadinessSummary = @($summary | Where-Object { $_.file -eq "latest-sync-readiness.json" } | Select-Object -First 1)[0]
    if (-not $releaseGatesSummary) {
        Add-Failure "reports summary missing latest-release-gates.json"
    } else {
        if (-not (Has-Property $releaseGatesSummary "ok")) { Add-Failure "release-gates summary missing ok" }
        elseif ($RequireReleaseReady -and $releaseGatesSummary.ok -ne $true) { Add-Failure "release-gates summary ok=false" }
        if (-not (Has-Property $releaseGatesSummary "shortReady")) { Add-Failure "release-gates summary missing shortReady" }
        elseif ($RequireReleaseReady -and $releaseGatesSummary.shortReady -ne $true) { Add-Failure "release-gates summary shortReady is not true" }
        if (-not (Has-Property $releaseGatesSummary "releaseReady")) { Add-Failure "release-gates summary missing releaseReady" }
        elseif ($RequireReleaseReady -and $releaseGatesSummary.releaseReady -ne $true) { Add-Failure "release-gates summary releaseReady is not true" }
        if (-not (Has-Property $releaseGatesSummary "effectiveOk")) { Add-Failure "release-gates summary missing effectiveOk" }
        elseif ($RequireReleaseReady -and $releaseGatesSummary.effectiveOk -ne $true) { Add-Failure "release-gates summary effectiveOk is not true" }
        if (-not (Has-Property $releaseGatesSummary "strictOptionalRealTraffic")) { Add-Failure "release-gates summary missing strict optional real-traffic flag" }
        if (-not (Has-Property $releaseGatesSummary "optionalRealTrafficReady")) { Add-Failure "release-gates summary missing optional real-traffic readiness" }
        if (-not (Has-Property $releaseGatesSummary "optionalRealTrafficFailures")) { Add-Failure "release-gates summary missing optional real-traffic failures" }
        if (-not (Has-Property $releaseGatesSummary "missingRequired")) { Add-Failure "release-gates summary missing missingRequired" }
        if (-not (Has-Property $releaseGatesSummary "missingShort")) { Add-Failure "release-gates summary missing missingShort" }
        if (-not (Has-Property $releaseGatesSummary "missingOptional")) { Add-Failure "release-gates summary missing missingOptional" }
        if (-not (Has-Property $releaseGatesSummary "damagedReports")) { Add-Failure "release-gates summary missing damagedReports" }
        if (-not (Has-Property $releaseGatesSummary "releaseGateFailures")) { Add-Failure "release-gates summary missing semantic failure details" }
        if (-not (Has-Property $releaseGatesSummary "releaseGateFailureReasons")) { Add-Failure "release-gates summary missing failure reason details" }
        Test-ReleaseGateApprovalAndOfflineEvidence $releaseGatesSummary
        if (-not (Has-Property $releaseGatesSummary "releaseGateSelectedReports")) { Add-Failure "release-gates summary missing selected history report details" }
        $selectedReports = @(As-FlatArray $releaseGatesSummary.releaseGateSelectedReports)
        foreach ($selectedGate in @(As-FlatArray $releaseGatesSummary.releaseGateFailureReasons | Where-Object { $_.selectedFromHistory -eq $true })) {
            $selectedGateId = [string]$selectedGate.id
            if ([string]::IsNullOrWhiteSpace($selectedGateId)) { continue }
            $matchingSelectedReports = @($selectedReports | Where-Object { [string]$_.id -eq $selectedGateId -and -not [string]::IsNullOrWhiteSpace([string]$_.selectedFile) })
            if ($matchingSelectedReports.Count -lt 1) {
                Add-Failure "release-gates selected history gate $selectedGateId missing selected report detail"
            } elseif (@($matchingSelectedReports | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.selectedMtime) }).Count -lt 1) {
                Add-Failure "release-gates selected history gate $selectedGateId missing selected report mtime"
            }
        }
        Test-InstalledRuntimeEvidence $releaseGatesSummary.installedRuntimeEvidence
    }
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
            if ([int]$localEvidence.upstreamRequestsBeforeLocalEndpoints -ne [int]$localEvidence.upstreamRequestsAfterLocalEndpoints) { Add-Failure "local connector summary before/after upstream request counts differ" }
            if ($localEvidence.allowlistedConnectorAccessible -ne $false) { Add-Failure "local connector summary treats allowlist as access" }
            if ($localEvidence.allowlistedConnectorLocallyAllowlisted -ne $true) { Add-Failure "local connector summary missing local allowlist evidence" }
            if ($localEvidence.hiddenConnectorAccessible -ne $false) { Add-Failure "local connector summary exposes hidden connector" }
            if ([int]$localEvidence.exposedToolsPost -ne [int]$localEvidence.exposedToolsGet) { Add-Failure "local connector summary GET/POST tool counts differ" }
            if (@($localEvidence.exposedToolNames).Count -ne [int]$localEvidence.exposedToolsPost) { Add-Failure "local connector summary exposed tool names mismatch" }
            if ($localEvidence.connectorParityClean -ne $true) { Add-Failure "local connector summary missing connector parity proof" }
            if ($localEvidence.connectorFingerprintMatches -ne $true) { Add-Failure "local connector summary missing connector fingerprint match proof" }
            if (-not (Has-Property $localEvidence "connectorParityMissingShared")) { Add-Failure "local connector summary missing connector missing-shared drift samples" }
            if (-not (Has-Property $localEvidence "connectorParityExtraLocal")) { Add-Failure "local connector summary missing connector extra-local drift samples" }
            if (-not (Has-Property $localEvidence "connectorParityChangedShared")) { Add-Failure "local connector summary missing connector changed-shared drift samples" }
            if ($localEvidence.appToolParityClean -ne $true) { Add-Failure "local connector summary missing app-tool parity proof" }
            if ($localEvidence.appToolFingerprintMatches -ne $true) { Add-Failure "local connector summary missing app-tool fingerprint match proof" }
            if (-not (Has-Property $localEvidence "appToolParityMissingShared")) { Add-Failure "local connector summary missing app-tool missing-shared drift samples" }
            if (-not (Has-Property $localEvidence "appToolParityExtraLocal")) { Add-Failure "local connector summary missing app-tool extra-local drift samples" }
            if (-not (Has-Property $localEvidence "appToolParityChangedShared")) { Add-Failure "local connector summary missing app-tool changed-shared drift samples" }
            if ($localEvidence.appToolGetPostParityClean -ne $true) { Add-Failure "local connector summary missing GET/POST app-tool parity proof" }
            if ($localEvidence.tempSharedHomeUsed -ne $false) { Add-Failure "local connector summary used shared home during temp isolation" }
            if ($localEvidence.tempCodexHomeUnderStateRoot -ne $true) { Add-Failure "local connector summary missing temp CODEX_HOME isolation proof" }
            if ($localEvidence.tempSharedCodexHomeUnderStateRoot -ne $true) { Add-Failure "local connector summary missing temp shared home isolation proof" }
            if ($localEvidence.tempCodexHomeDistinctFromShared -ne $true) { Add-Failure "local connector summary CODEX_HOME is not distinct from shared home" }
            $exposedToolNames = @(As-FlatArray $localEvidence.exposedToolNames)
            if ($exposedToolNames.Count -ne 1 -or $exposedToolNames[0] -ne "linked_tool") {
                Add-Failure "local connector summary exposed tool names is not exactly one 'linked_tool'"
            }
        }
    }
    if ($syncReadinessSummary) {
        Test-SyncReadinessEvidence $syncReadinessSummary.syncReadinessEvidence "sync-readiness summary" -RequireReady:$false
    }

    return [pscustomobject]@{
        summaryPath = $SummaryPath
        reportCount = @($summary).Count
        releaseGates = if ($releaseGatesSummary) {
            [pscustomobject]@{
                ok = $releaseGatesSummary.ok
                shortReady = $releaseGatesSummary.shortReady
                releaseReady = $releaseGatesSummary.releaseReady
                effectiveOk = $releaseGatesSummary.effectiveOk
                missingRequired = @($releaseGatesSummary.missingRequired)
                missingShort = @($releaseGatesSummary.missingShort)
                missingOptional = @($releaseGatesSummary.missingOptional)
                releaseGateGroups = @($releaseGatesSummary.releaseGateGroups)
                releaseGateFailureReasons = @($releaseGatesSummary.releaseGateFailureReasons)
                nextActions = @($releaseGatesSummary.nextActions)
                nextActionsAvailableCount = $releaseGatesSummary.nextActionsAvailableCount
                nextActionsHiddenCount = $releaseGatesSummary.nextActionsHiddenCount
                nextActionsTruncated = $releaseGatesSummary.nextActionsTruncated
                approvalPlan = $releaseGatesSummary.approvalPlan
                installedRuntimeEvidence = $releaseGatesSummary.installedRuntimeEvidence
            }
        } else { $null }
        localConnectors = if ($localConnectorsSummary) {
            [pscustomobject]@{
                ok = $localConnectorsSummary.ok
                reportName = $localConnectorsSummary.reportName
                evidence = $localConnectorsSummary.localConnectorEvidence
            }
        } else { $null }
        syncReadiness = if ($syncReadinessSummary) {
            [pscustomobject]@{
                ok = $syncReadinessSummary.ok
                evidence = $syncReadinessSummary.syncReadinessEvidence
            }
        } else { $null }
    }
}

function Invoke-LocalJson {
    param([string]$Path, [int]$MaxAttempts = 2)
    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $remainingBudgetMs = Get-RemainingVerifierBudgetMs
            if ($remainingBudgetMs -lt 250) {
                throw "verifier budget exhausted before $Path request attempt $attempt"
            }
            $requestTimeoutSec = [Math]::Max(1, [Math]::Min(3, [Math]::Min($TimeoutSec, [int][Math]::Ceiling($remainingBudgetMs / 1000))))
            return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $requestTimeoutSec
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
    $remainingBudgetMs = Get-RemainingVerifierBudgetMs
    if ($remainingBudgetMs -lt 1000) {
        throw "$ScriptName skipped because verifier budget was exhausted before child process start"
    }
    $stdoutPath = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-diagnostics-child-{0}.out" -f ([Guid]::NewGuid().ToString("N")))
    $stderrPath = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-diagnostics-child-{0}.err" -f ([Guid]::NewGuid().ToString("N")))
    try {
        $argumentList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath) + $Arguments
        $process = Start-Process -FilePath $powerShellBin -ArgumentList $argumentList -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        if (-not $process.WaitForExit([Math]::Max(1000, $remainingBudgetMs))) {
            try { $process.Kill() } catch {}
            throw "$ScriptName timed out after $([int]($remainingBudgetMs / 1000)) seconds while waiting for child process"
        }
        $exitCode = $process.ExitCode
        $output = @()
        if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { $output += @(Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue) }
        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { $output += @(Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue) }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
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
    if ($env:ANTICODEX_DIAGNOSTICS_SCRIPT_ROOT) {
        $overrideRoot = [string]$env:ANTICODEX_DIAGNOSTICS_SCRIPT_ROOT
        if (Test-Path -LiteralPath (Join-Path $overrideRoot "collect-anticodex-diagnostics.ps1") -PathType Leaf) {
            return $overrideRoot
        }
    }
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
    $logDbGuardPath = Join-Path $bundle.bundleRoot "log-db-guard.json"
    $summaryPath = Join-Path $bundle.bundleRoot "reports-summary.json"
    $diagnosticsSummaryPath = Join-Path $bundle.bundleRoot "diagnostics-summary.json"
    $lifecycleStatusPath = Join-Path (Join-Path $bundle.bundleRoot "logs") "translator-lifecycle.json"
    $lifecycleLogPath = Join-Path (Join-Path $bundle.bundleRoot "logs") "translator-lifecycle.jsonl"
    if ($antigravityReportsRequired -and -not (Test-Path -LiteralPath $refreshPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing model-routing-refresh.json"
    }
    if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing reports-summary.json"
    }
    if (-not (Test-Path -LiteralPath $diagnosticsSummaryPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing diagnostics-summary.json"
    } else {
        $diagnosticsSummary = Get-Content -LiteralPath $diagnosticsSummaryPath -Raw | ConvertFrom-Json
        if (-not (Has-Property $diagnosticsSummary "longTasks")) {
            Add-Failure "diagnostic summary missing longTasks"
        } else {
            $longTaskSummary = $diagnosticsSummary.longTasks
            if (-not (Has-Property $longTaskSummary "runningCount")) { Add-Failure "diagnostic summary missing longTasks runningCount" }
            if (-not (Has-Property $longTaskSummary "attentionCount")) { Add-Failure "diagnostic summary missing longTasks attentionCount" }
            if (-not (Has-Property $longTaskSummary "otherRunningItems")) { Add-Failure "diagnostic summary missing longTasks otherRunningItems" }
            $foregroundSummaryItems = @(As-FlatArray $longTaskSummary.otherRunningItems | Where-Object { $_.stage -eq "manager_foreground" })
            foreach ($foregroundItem in $foregroundSummaryItems) {
                if ([string]::IsNullOrWhiteSpace([string]$foregroundItem.id) -and [string]::IsNullOrWhiteSpace([string]$foregroundItem.label)) {
                    Add-Failure "diagnostic summary manager_foreground item missing id or label"
                }
            }
        }
    }
    if (-not (Test-Path -LiteralPath $logDbGuardPath -PathType Leaf)) {
        Add-Failure "diagnostic bundle missing log-db-guard.json"
    } else {
        $logDbGuard = Get-Content -LiteralPath $logDbGuardPath -Raw | ConvertFrom-Json
        if ($logDbGuard.reportName -ne "log-db-guard") { Add-Failure "diagnostic log database guard reportName mismatch" }
        if ($logDbGuard.noTraffic -ne $true) { Add-Failure "diagnostic log database guard missing noTraffic" }
        if ($logDbGuard.usedRealTraffic -ne $false) { Add-Failure "diagnostic log database guard used real traffic" }
        if ($logDbGuard.protected -ne $true) { Add-Failure "diagnostic log database guard is not protected in bundle" }
        if ($logDbGuard.triggerPresent -ne $true) { Add-Failure "diagnostic log database guard trigger missing in bundle" }
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
    $logDbGuardSummary = $null
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
                if (-not $bridgeEvidence.requestEnvelope) { Add-Failure "diagnostic tool-bridge summary missing request envelope" }
                if ($bridgeEvidence.externalToolDefinitionsField -ne "StartCascade.customAgentSpec.customizationConfig.customizationServerUrl") { Add-Failure "diagnostic tool-bridge summary missing external tool definitions field" }
                if ($bridgeEvidence.externalToolDefinitionsUsable -ne $true) { Add-Failure "diagnostic tool-bridge summary missing usable external tool definitions proof" }
                if ($bridgeEvidence.schemaLikeRequestAcceptance -ne "verified-native-mcp-initialize-and-tools-list") { Add-Failure "diagnostic tool-bridge summary missing schema-like request acceptance proof" }
                if ($bridgeEvidence.nativeMcpToolCallStatus -ne "verified-tools-call-after-automatic-permission") { Add-Failure "diagnostic tool-bridge summary missing native MCP tool call proof" }
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
                Test-SyncReadinessEvidence $syncEvidence "diagnostic sync-readiness summary" -RequireReady:$false
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
        $accountProxySummary = @($summary | Where-Object { $_.file -eq "latest-account-proxy-readiness.json" } | Select-Object -First 1)[0]
        if ($antigravityReportsRequired -and -not $accountProxySummary) {
            Add-Failure "diagnostic reports summary missing latest-account-proxy-readiness.json"
        } elseif ($antigravityReportsRequired -and $accountProxySummary) {
            $accountProxyEvidence = $accountProxySummary.accountProxyEvidence
            if (-not $accountProxyEvidence) {
                Add-Failure "account-proxy summary missing accountProxyEvidence"
            } else {
                if (-not [string]$accountProxyEvidence.diagnosisDetail) { Add-Failure "account-proxy summary missing diagnosisDetail" }
                if (-not [string]$accountProxyEvidence.suggestedAction) { Add-Failure "account-proxy summary missing suggestedAction" }
                if ($null -eq $accountProxyEvidence.localProxyBypassed) { Add-Failure "account-proxy summary missing localProxyBypassed" }
                if (-not $accountProxyEvidence.phaseSummary) { Add-Failure "account-proxy summary missing phaseSummary" }
                if ($null -eq $accountProxyEvidence.phaseSummary.modelCount) { Add-Failure "account-proxy summary missing phase model count" }
                if (-not $accountProxyEvidence.antigravityLogSignals) { Add-Failure "account-proxy summary missing antigravityLogSignals" }
                if ($null -eq $accountProxyEvidence.antigravityLogSignals.tailLinesScanned) { Add-Failure "account-proxy summary missing log scan count" }
                $accountProxyEvidenceText = $accountProxyEvidence | ConvertTo-Json -Depth 8 -Compress
                if ($accountProxyEvidenceText -match "fingerprint|sha256:") { Add-Failure "account-proxy summary exposes an account fingerprint" }
            }
        }
        $sourcePreflightSummary = @($summary | Where-Object { $_.file -eq "latest-source-preflight.json" } | Select-Object -First 1)[0]
        if (-not $sourcePreflightSummary) {
            Add-Failure "diagnostic reports summary missing latest-source-preflight.json"
        } else {
            if ($sourcePreflightSummary.ok -ne $true) { Add-Failure "source-preflight summary ok=false" }
            if ($sourcePreflightSummary.reportName -ne "source-preflight") { Add-Failure "source-preflight summary missing reportName" }
            if ($sourcePreflightSummary.noTraffic -ne $true) { Add-Failure "source-preflight summary missing noTraffic" }
            if ($sourcePreflightSummary.usedRealTraffic -ne $false) { Add-Failure "source-preflight summary used real traffic" }
            if ($sourcePreflightSummary.behaviorCovered -ne $true) { Add-Failure "source-preflight summary behavior not covered" }
            if ($sourcePreflightSummary.coverageKind -ne "source-no-traffic") { Add-Failure "source-preflight summary coverageKind mismatch" }
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
        if (-not $thirdPartyProviderSummary) {
            Add-Failure "diagnostic reports summary missing latest-third-party-provider.json"
        } else {
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
                if (-not $continuity.providerSwitch -or $continuity.providerSwitch.requestReachedSecondProvider -ne $true) { Add-Failure "third-party provider summary missing provider-switch route evidence" }
                if (-not $continuity.protocolSwitch -or $continuity.protocolSwitch.requestReachedAnthropicProvider -ne $true) { Add-Failure "third-party provider summary missing protocol-switch route evidence" }
                if (-not $continuity.reverseProtocolSwitch -or $continuity.reverseProtocolSwitch.requestReachedOpenAiCompatibleProvider -ne $true) { Add-Failure "third-party provider summary missing reverse-protocol route evidence" }
                $previousIds = $continuity.previousResponseContinuity
                if (-not $previousIds) {
                    Add-Failure "third-party provider summary missing previous_response_id continuity evidence"
                } else {
                    if ($previousIds.savePresent -ne $true) { Add-Failure "third-party provider summary missing save previous_response_id continuity" }
                    if ($previousIds.restartPresent -ne $true) { Add-Failure "third-party provider summary missing restart previous_response_id continuity" }
                    if ($previousIds.providerSwitchPresent -ne $true) { Add-Failure "third-party provider summary missing provider-switch previous_response_id continuity" }
                    if ($previousIds.protocolSwitchPresent -ne $true) { Add-Failure "third-party provider summary missing protocol-switch previous_response_id continuity" }
                    if ($previousIds.reverseProtocolSwitchPresent -ne $true) { Add-Failure "third-party provider summary missing reverse-protocol previous_response_id continuity" }
                    if ($previousIds.saveMatched -ne $true) { Add-Failure "third-party provider summary save previous_response_id mismatch" }
                    if ($previousIds.restartMatched -ne $true) { Add-Failure "third-party provider summary restart previous_response_id mismatch" }
                    if ($previousIds.providerSwitchMatched -ne $true) { Add-Failure "third-party provider summary provider-switch previous_response_id mismatch" }
                    if ($previousIds.protocolSwitchMatched -ne $true) { Add-Failure "third-party provider summary protocol-switch previous_response_id mismatch" }
                    if ($previousIds.reverseProtocolSwitchMatched -ne $true) { Add-Failure "third-party provider summary reverse-protocol previous_response_id mismatch" }
                    if ($previousIds.providerSwitchMatchesNested -ne $true) { Add-Failure "third-party provider summary provider-switch previous_response_id mismatch" }
                    if ($previousIds.protocolSwitchMatchesNested -ne $true) { Add-Failure "third-party provider summary protocol-switch previous_response_id mismatch" }
                    if ($previousIds.reverseProtocolSwitchMatchesNested -ne $true) { Add-Failure "third-party provider summary reverse-protocol previous_response_id mismatch" }
                }
                $previousChain = $continuity.previousResponseIdChain
                if (-not $previousChain) {
                    Add-Failure "third-party provider summary missing previous_response_id chain values"
                } else {
                    if (-not [string]$previousChain.save) { Add-Failure "third-party provider summary missing save previous_response_id value" }
                    if (-not [string]$previousChain.restart) { Add-Failure "third-party provider summary missing restart previous_response_id value" }
                    if (-not [string]$previousChain.providerSwitch) { Add-Failure "third-party provider summary missing provider-switch previous_response_id value" }
                    if (-not [string]$previousChain.protocolSwitch) { Add-Failure "third-party provider summary missing protocol-switch previous_response_id value" }
                    if (-not [string]$previousChain.reverseProtocolSwitch) { Add-Failure "third-party provider summary missing reverse-protocol previous_response_id value" }
                    if (-not [string]$previousChain.providerSwitchNested) { Add-Failure "third-party provider summary missing nested provider-switch previous_response_id value" }
                    if (-not [string]$previousChain.protocolSwitchNested) { Add-Failure "third-party provider summary missing nested protocol-switch previous_response_id value" }
                    if (-not [string]$previousChain.reverseProtocolSwitchNested) { Add-Failure "third-party provider summary missing nested reverse-protocol previous_response_id value" }
                }
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
                if ([int]$localEvidence.upstreamRequestsBeforeLocalEndpoints -ne [int]$localEvidence.upstreamRequestsAfterLocalEndpoints) { Add-Failure "local connector summary before/after upstream request counts differ" }
                if ($localEvidence.allowlistedConnectorAccessible -ne $false) { Add-Failure "local connector summary treats allowlist as access" }
                if ($localEvidence.allowlistedConnectorLocallyAllowlisted -ne $true) { Add-Failure "local connector summary missing local allowlist evidence" }
                if ($localEvidence.hiddenConnectorAccessible -ne $false) { Add-Failure "local connector summary exposes hidden connector" }
                if ([int]$localEvidence.exposedToolsPost -ne [int]$localEvidence.exposedToolsGet) { Add-Failure "local connector summary GET/POST tool counts differ" }
                if (@($localEvidence.exposedToolNames).Count -ne [int]$localEvidence.exposedToolsPost) { Add-Failure "local connector summary exposed tool names mismatch" }
                if ($localEvidence.connectorParityClean -ne $true) { Add-Failure "local connector summary missing connector parity proof" }
                if ($localEvidence.connectorFingerprintMatches -ne $true) { Add-Failure "local connector summary missing connector fingerprint match proof" }
                if (-not (Has-Property $localEvidence "connectorParityMissingShared")) { Add-Failure "local connector summary missing connector missing-shared drift samples" }
                if (-not (Has-Property $localEvidence "connectorParityExtraLocal")) { Add-Failure "local connector summary missing connector extra-local drift samples" }
                if (-not (Has-Property $localEvidence "connectorParityChangedShared")) { Add-Failure "local connector summary missing connector changed-shared drift samples" }
                if ($localEvidence.appToolParityClean -ne $true) { Add-Failure "local connector summary missing app-tool parity proof" }
                if ($localEvidence.appToolFingerprintMatches -ne $true) { Add-Failure "local connector summary missing app-tool fingerprint match proof" }
                if (-not (Has-Property $localEvidence "appToolParityMissingShared")) { Add-Failure "local connector summary missing app-tool missing-shared drift samples" }
                if (-not (Has-Property $localEvidence "appToolParityExtraLocal")) { Add-Failure "local connector summary missing app-tool extra-local drift samples" }
                if (-not (Has-Property $localEvidence "appToolParityChangedShared")) { Add-Failure "local connector summary missing app-tool changed-shared drift samples" }
                if ($localEvidence.appToolGetPostParityClean -ne $true) { Add-Failure "local connector summary missing GET/POST app-tool parity proof" }
                if ($localEvidence.tempSharedHomeUsed -ne $false) { Add-Failure "local connector summary used shared home during temp isolation" }
                if ($localEvidence.tempCodexHomeUnderStateRoot -ne $true) { Add-Failure "local connector summary missing temp CODEX_HOME isolation proof" }
                if ($localEvidence.tempSharedCodexHomeUnderStateRoot -ne $true) { Add-Failure "local connector summary missing temp shared home isolation proof" }
                if ($localEvidence.tempCodexHomeDistinctFromShared -ne $true) { Add-Failure "local connector summary CODEX_HOME is not distinct from shared home" }
                $exposedToolNames = @(As-FlatArray $localEvidence.exposedToolNames)
                if ($exposedToolNames.Count -ne 1 -or $exposedToolNames[0] -ne "linked_tool") {
                    Add-Failure "local connector summary exposed tool names is not exactly one 'linked_tool'"
                }
            }
        }
        $pluginCapabilitiesSummary = @($summary | Where-Object { $_.file -eq "latest-plugin-capabilities.json" } | Select-Object -First 1)[0]
        if ($pluginCapabilitiesSummary) {
            if ($pluginCapabilitiesSummary.ok -ne $true) { Add-Failure "plugin capability summary ok=false" }
            if ($pluginCapabilitiesSummary.shortBudgetMode -eq $true) { Add-Failure "plugin capability summary is short-budget and not release-grade" }
            if (-not $pluginCapabilitiesSummary.sourceSnapshotEvidence) { Add-Failure "plugin capability summary missing source snapshot evidence" }
            $pluginEvidence = $pluginCapabilitiesSummary.pluginCapabilityEvidence
            if (-not $pluginEvidence) {
                Add-Failure "plugin capability summary missing pluginCapabilityEvidence"
            } else {
                if ($pluginEvidence.nativeCodexWriteback -ne $false) { Add-Failure "plugin capability summary allows native Codex writeback" }
                if (-not [string]$pluginEvidence.capabilityState) { Add-Failure "plugin capability summary missing capability state" }
                if ($pluginEvidence.capabilityState -eq "degraded_short_budget") { Add-Failure "plugin capability summary is degraded by short budget" }
                if ($pluginEvidence.degraded -ne $true) { Add-Failure "plugin capability summary missing degraded metadata-only state" }
                if ([int]$pluginEvidence.connectorCount -lt [int]$pluginEvidence.enabledConnectorCount) { Add-Failure "plugin capability summary connector counts are inconsistent" }
                if ([int]$pluginEvidence.enabledConnectorCount -lt [int]$pluginEvidence.accessibleConnectorCount) { Add-Failure "plugin capability summary enabled/access connector counts are inconsistent" }
                if ([int]$pluginEvidence.accessibleConnectorCount -ne 0) { Add-Failure "plugin capability summary reports accessible connectors" }
                if ([int]$pluginEvidence.appToolCount -ne [int]$pluginEvidence.appToolGetCount) { Add-Failure "plugin capability summary GET/POST app tool counts differ" }
                if ([int]$pluginEvidence.unauthorizedAppToolCount -ne 0) { Add-Failure "plugin capability summary reports unauthorized app tools" }
                if ($pluginEvidence.smokeChecked -ne $true) { Add-Failure "plugin capability summary missing smoke checked proof" }
                if ($pluginEvidence.endpointProjectionReadable -ne $true) { Add-Failure "plugin capability summary missing endpoint projection proof" }
                if ($pluginEvidence.callableState -ne "skipped_no_accessible_connectors") { Add-Failure "plugin capability summary missing no-access callable state" }
                if (-not [string]$pluginEvidence.appToolsNote) { Add-Failure "plugin capability summary missing app tools no-access note" }
                if ($pluginEvidence.connectorParityChecked -ne $true) { Add-Failure "plugin capability summary missing connector parity checked proof" }
                if ($pluginEvidence.appToolParityChecked -ne $true) { Add-Failure "plugin capability summary missing app-tool parity checked proof" }
                if ($pluginEvidence.appToolGetPostParityChecked -ne $true) { Add-Failure "plugin capability summary missing GET/POST checked proof" }
                if ($pluginEvidence.appToolGetPostParityContentMatches -ne $true) { Add-Failure "plugin capability summary missing GET/POST content match proof" }
                if ($pluginEvidence.connectorCacheChecked -ne $true -or $pluginEvidence.connectorCacheExists -ne $true -or $pluginEvidence.connectorCacheSampleReadable -ne $true) { Add-Failure "plugin capability summary missing connector cache smoke proof" }
                if ($pluginEvidence.appToolsCacheChecked -ne $true -or $pluginEvidence.appToolsCacheExists -ne $true -or $pluginEvidence.appToolsCacheSampleReadable -ne $true) { Add-Failure "plugin capability summary missing app-tools cache smoke proof" }
                if ($pluginEvidence.connectorParityClean -ne $true) { Add-Failure "plugin capability summary missing connector parity evidence" }
                if ($pluginEvidence.appToolParityClean -ne $true) { Add-Failure "plugin capability summary missing app-tool parity evidence" }
                if ($pluginEvidence.appToolGetPostParityClean -ne $true) { Add-Failure "plugin capability summary missing GET/POST parity evidence" }
                if (-not (Has-Property $pluginEvidence "connectorParityMissingShared")) { Add-Failure "plugin capability summary missing connector parity drift samples" }
                if (-not (Has-Property $pluginEvidence "connectorParityExtraLocal")) { Add-Failure "plugin capability summary missing extra local connector drift samples" }
                if (-not (Has-Property $pluginEvidence "connectorParityChangedShared")) { Add-Failure "plugin capability summary missing changed connector drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolParityMissingShared")) { Add-Failure "plugin capability summary missing app-tool missing drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolParityExtraLocal")) { Add-Failure "plugin capability summary missing extra local app-tool drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolParityChangedShared")) { Add-Failure "plugin capability summary missing changed app-tool drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolGetPostMissingFromGet")) { Add-Failure "plugin capability summary missing GET/POST drift samples" }
                if (-not (Has-Property $pluginEvidence "appToolGetPostExtraFromGet")) { Add-Failure "plugin capability summary missing GET/POST extra drift samples" }
            }
        }
        $logDbGuardSummary = @($summary | Where-Object { $_.file -eq "latest-log-db-guard.json" } | Select-Object -First 1)[0]
        if (-not $logDbGuardSummary) {
            Add-Failure "diagnostic reports summary missing latest-log-db-guard.json"
        } else {
            if ($logDbGuardSummary.reportName -ne "log-db-guard") { Add-Failure "diagnostic log database guard summary reportName mismatch" }
            $logEvidence = $logDbGuardSummary.logDbGuardEvidence
            if (-not $logEvidence) {
                Add-Failure "diagnostic log database guard summary missing logDbGuardEvidence"
            } else {
                if ($logEvidence.noTraffic -ne $true) { Add-Failure "diagnostic log database guard summary missing noTraffic" }
                if ($logEvidence.usedRealTraffic -ne $false) { Add-Failure "diagnostic log database guard summary used real traffic" }
                if ($logEvidence.protected -ne $true) { Add-Failure "diagnostic log database guard summary is not protected" }
                if ($logEvidence.triggerPresent -ne $true) { Add-Failure "diagnostic log database guard summary trigger missing" }
                if (-not (Has-Property $logEvidence "walBytes")) { Add-Failure "diagnostic log database guard summary missing wal size" }
                else {
                    [double]$walBytes = 0
                    if (
                        -not [double]::TryParse([string]$logEvidence.walBytes, [ref]$walBytes) -or
                        [double]::IsNaN($walBytes) -or
                        [double]::IsInfinity($walBytes) -or
                        $walBytes -lt 0
                    ) {
                        Add-Failure "diagnostic log database guard summary invalid wal size"
                    }
                }
            }
        }
        $mcpSkillsSummary = @($summary | Where-Object { $_.file -eq "latest-mcp-skills.json" } | Select-Object -First 1)[0]
        if ($mcpSkillsSummary) {
            if ($mcpSkillsSummary.ok -ne $true) { Add-Failure "MCP/Skill summary ok=false" }
            if (-not $mcpSkillsSummary.sourceSnapshotEvidence) { Add-Failure "MCP/Skill summary missing source snapshot evidence" }
            if ($mcpSkillsSummary.shortBudgetMode -eq $true) {
                if ($mcpSkillsSummary.sourceSnapshotEvidence.reusedFromPreviousReport -ne $true) { Add-Failure "MCP/Skill short-budget summary missing reused source snapshot proof" }
                if (-not [string]$mcpSkillsSummary.sourceSnapshotEvidence.refreshSkippedReason) { Add-Failure "MCP/Skill short-budget summary missing refresh skipped reason" }
            }
            $mcpSkillEvidence = $mcpSkillsSummary.mcpSkillEvidence
            if (-not $mcpSkillEvidence) {
                Add-Failure "MCP/Skill summary missing mcpSkillEvidence"
            } else {
                if ([int]$mcpSkillEvidence.mcpCount -lt 1) { Add-Failure "MCP/Skill summary has no MCP entries" }
                if ([int]$mcpSkillEvidence.mcpSharedCount -lt 1) { Add-Failure "MCP/Skill summary has no shared MCP entries" }
                if (@($mcpSkillEvidence.mcpMissingShared).Count -ne 0) { Add-Failure "MCP/Skill summary has missing shared MCP entries" }
                if (@($mcpSkillEvidence.mcpExtraLocal).Count -ne 0) { Add-Failure "MCP/Skill summary has extra local MCP entries" }
                if (@($mcpSkillEvidence.mcpChangedShared).Count -ne 0) { Add-Failure "MCP/Skill summary has changed shared MCP entries" }
                if ($mcpSkillEvidence.hasNodeRepl -ne $true) { Add-Failure "MCP/Skill summary missing node_repl evidence" }
                if ($mcpSkillEvidence.mcpSmokePassed -ne $true) { Add-Failure "MCP/Skill summary missing MCP smoke evidence" }
                if ($mcpSkillEvidence.mcpRealCallPassed -ne $true) { Add-Failure "MCP/Skill summary missing MCP real-call evidence" }
                if ([int]$mcpSkillEvidence.mcpRealListCount -lt 2) { Add-Failure "MCP/Skill summary missing MCP real tools/list count evidence" }
                if ([int]$mcpSkillEvidence.mcpRealListPassed -lt 2) { Add-Failure "MCP/Skill summary missing MCP real tools/list passed evidence" }
                if ([int]$mcpSkillEvidence.mcpRealListToolCount -lt 2) { Add-Failure "MCP/Skill summary missing MCP real tools/list tool count evidence" }
                if ([int]$mcpSkillEvidence.skillCount -lt 1) { Add-Failure "MCP/Skill summary has no skills" }
                if ([int]$mcpSkillEvidence.expectedSharedSkillCount -lt 1) { Add-Failure "MCP/Skill summary missing expected shared skill count" }
                if ([int]$mcpSkillEvidence.agentsSkillCount -lt 1) { Add-Failure "MCP/Skill summary missing .agents skill count" }
                if (@($mcpSkillEvidence.missingSharedSkills).Count -ne 0) { Add-Failure "MCP/Skill summary has missing shared skills" }
                if (@($mcpSkillEvidence.extraLocalSkills).Count -ne 0) { Add-Failure "MCP/Skill summary has extra local skills" }
                if (@($mcpSkillEvidence.changedSharedSkills).Count -ne 0) { Add-Failure "MCP/Skill summary has changed shared skills" }
                if (@($mcpSkillEvidence.conflictingDuplicateSkillNames).Count -ne 0) { Add-Failure "MCP/Skill summary has conflicting duplicate skills" }
                if ($mcpSkillsSummary.shortBudgetMode -eq $true -and $mcpSkillEvidence.skillFingerprintSkipped -ne $true) { Add-Failure "MCP/Skill short-budget summary missing skill fingerprint skipped proof" }
                if ($mcpSkillEvidence.skillSmokeReadable -ne $true) { Add-Failure "MCP/Skill summary missing skill smoke evidence" }
                if ($mcpSkillEvidence.appToolRegistryExists -eq $true) {
                    if ($mcpSkillEvidence.appToolRegistryContentMatches -ne $true) { Add-Failure "MCP/Skill summary app-tool registry content mismatch" }
                    if ($mcpSkillEvidence.appToolRegistryFingerprintMatches -ne $true) { Add-Failure "MCP/Skill summary app-tool registry fingerprint mismatch" }
                    if (-not (Has-Property $mcpSkillEvidence "appToolRegistrySharedFileCount") -or $null -eq $mcpSkillEvidence.appToolRegistrySharedFileCount) { Add-Failure "MCP/Skill summary app-tool registry missing shared file count" }
                    if (-not (Has-Property $mcpSkillEvidence "appToolRegistryLocalFileCount") -or $null -eq $mcpSkillEvidence.appToolRegistryLocalFileCount) { Add-Failure "MCP/Skill summary app-tool registry missing local file count" }
                    if ([int]$mcpSkillEvidence.appToolRegistrySharedFileCount -ne [int]$mcpSkillEvidence.appToolRegistryLocalFileCount) { Add-Failure "MCP/Skill summary app-tool registry file counts differ" }
                }
            }
        }
        $refreshFeaturesSummary = @($summary | Where-Object { $_.file -eq "latest-refresh-features.json" } | Select-Object -First 1)[0]
        if ($refreshFeaturesSummary) {
            if (-not $refreshFeaturesSummary.sourceSnapshotEvidence) { Add-Failure "refresh-features summary missing source snapshot evidence" }
            $refreshEvidence = $refreshFeaturesSummary.refreshFeatureEvidence
            if (-not $refreshEvidence) {
                Add-Failure "refresh-features summary missing refreshFeatureEvidence"
            } elseif ($refreshFeaturesSummary.ok -eq $true) {
                if (-not ($refreshEvidence.PSObject.Properties.Name -contains "elapsedMs")) { Add-Failure "refresh-features summary missing elapsedMs evidence" }
                if ($refreshEvidence.connectorSharedExists -eq $true -and $refreshEvidence.connectorContentMatches -ne $true) { Add-Failure "refresh-features summary connector parity not clean" }
                if ($refreshEvidence.appToolSharedExists -eq $true -and $refreshEvidence.appToolContentMatches -ne $true) { Add-Failure "refresh-features summary app-tool parity not clean" }
                if (@($refreshEvidence.changedExpectedSkills).Count -ne 0) { Add-Failure "refresh-features summary skill content parity not clean" }
                if (@($refreshEvidence.guidanceChanged).Count -ne 0) { Add-Failure "refresh-features summary guidance parity not clean" }
            }
        }
        $optionalRealProviderSummary = @($summary | Where-Object { $_.file -eq "latest-real-third-party-provider.json" } | Select-Object -First 1)[0]
        if ($optionalRealProviderSummary -and $optionalRealProviderSummary.skipped -eq $true) {
            if ($optionalRealProviderSummary.requestedRealTraffic -ne $false) { Add-Failure "optional real-provider skipped summary requested real traffic" }
            if ($optionalRealProviderSummary.usedRealTraffic -ne $false) { Add-Failure "optional real-provider skipped summary used real traffic" }
            if ($optionalRealProviderSummary.behaviorCovered -ne $false) { Add-Failure "optional real-provider skipped summary claims behavior coverage" }
            if ([string]$optionalRealProviderSummary.coverageKind -ne "skipped") { Add-Failure "optional real-provider skipped summary coverage kind mismatch" }
            if (-not [string]$optionalRealProviderSummary.reason) { Add-Failure "optional real-provider skipped summary missing reason" }
            if (-not [string]$optionalRealProviderSummary.coveredBy) { Add-Failure "optional real-provider skipped summary missing coveredBy" }
        } elseif ($optionalRealProviderSummary) {
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
        if ($antigravityReturnSummary -and $antigravityReturnSummary.skipped -eq $true) {
            if ($antigravityReturnSummary.requestedRealTraffic -ne $false) { Add-Failure "Antigravity return skipped summary requested real traffic" }
            if ($antigravityReturnSummary.usedRealTraffic -ne $false) { Add-Failure "Antigravity return skipped summary used real traffic" }
            if ($antigravityReturnSummary.behaviorCovered -ne $false) { Add-Failure "Antigravity return skipped summary claims behavior coverage" }
            if ([string]$antigravityReturnSummary.coverageKind -ne "skipped") { Add-Failure "Antigravity return skipped summary coverage kind mismatch" }
            if (-not [string]$antigravityReturnSummary.reason) { Add-Failure "Antigravity return skipped summary missing reason" }
            if (-not [string]$antigravityReturnSummary.coveredBy) { Add-Failure "Antigravity return skipped summary missing coveredBy" }
        } elseif ($antigravityReturnSummary) {
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
            if (-not (Has-Property $releaseGatesSummary "effectiveOk")) { Add-Failure "release-gates summary missing effectiveOk" }
            elseif ($releaseGatesSummary.effectiveOk -ne $true) { Add-Failure "release-gates summary effectiveOk is not true" }
            if (-not (Has-Property $releaseGatesSummary "strictOptionalRealTraffic")) { Add-Failure "release-gates summary missing strict optional real-traffic flag" }
            if (-not (Has-Property $releaseGatesSummary "optionalRealTrafficReady")) { Add-Failure "release-gates summary missing optional real-traffic readiness" }
            if (-not (Has-Property $releaseGatesSummary "optionalRealTrafficFailures")) { Add-Failure "release-gates summary missing optional real-traffic failures" }
            if (-not (Has-Property $releaseGatesSummary "missingRequired")) { Add-Failure "release-gates summary missing missingRequired" }
            if (-not (Has-Property $releaseGatesSummary "missingShort")) { Add-Failure "release-gates summary missing missingShort" }
            if (-not (Has-Property $releaseGatesSummary "missingOptional")) { Add-Failure "release-gates summary missing missingOptional" }
            if (-not (Has-Property $releaseGatesSummary "damagedReports")) { Add-Failure "release-gates summary missing damagedReports" }
            if (-not (Has-Property $releaseGatesSummary "releaseGateFailures")) { Add-Failure "release-gates summary missing semantic failure details" }
            if (-not (Has-Property $releaseGatesSummary "releaseGateFailureReasons")) { Add-Failure "release-gates summary missing failure reason details" }
            Test-ReleaseGateApprovalAndOfflineEvidence $releaseGatesSummary
            if (-not (Has-Property $releaseGatesSummary "releaseGateSelectedReports")) { Add-Failure "release-gates summary missing selected history report details" }
            if (@($releaseGatesSummary.releaseGateSelectedReports | Where-Object { $_.id -eq "syncReadiness" -and $_.selectedFile }).Count -lt 1) {
                Add-Failure "release-gates summary missing sync-readiness selected history report"
            }
            Test-InstalledRuntimeEvidence $releaseGatesSummary.installedRuntimeEvidence
        }
        $missingHistorySummary = @($summary | Where-Object { $_.file -eq "latest-missing-history.json" } | Select-Object -First 1)[0]
        if (-not $missingHistorySummary) {
            Add-Failure "diagnostic reports summary missing latest-missing-history.json"
        } else {
            $missingEvidence = $missingHistorySummary.missingHistoryEvidence
            if (-not $missingEvidence) {
                Add-Failure "missing-history summary missing missingHistoryEvidence"
            } elseif ($missingHistorySummary.ok -eq $true) {
                if ([int]$missingEvidence.status -ne 410) { Add-Failure "missing-history summary status is not 410" }
                if ([string]$missingEvidence.errorType -ne "response_history_missing") { Add-Failure "missing-history summary error type mismatch" }
                if ($missingEvidence.retryable -ne $false) { Add-Failure "missing-history summary should be non-retryable" }
                if ($missingEvidence.previousResponseIdMatched -ne $true) { Add-Failure "missing-history summary missing previous_response_id match" }
                if ($missingEvidence.recoveryGuidancePresent -ne $true) { Add-Failure "missing-history summary missing recovery guidance" }
                if ($missingEvidence.noRouteChange -ne $true) { Add-Failure "missing-history summary reports route change" }
                if ($missingEvidence.usedRealTraffic -ne $false) { Add-Failure "missing-history summary used real traffic" }
                if ([string]$missingEvidence.coverageKind -ne "installed-no-traffic") { Add-Failure "missing-history summary coverage kind mismatch" }
            }
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
                    if ($actionResult.bridgeReady -ne $true) { Add-Failure "manager-real-buttons action missing bridge ready evidence: $requiredAction" }
                    if ($actionResult.overlayPresent -ne $true) { Add-Failure "manager-real-buttons action missing overlay evidence: $requiredAction" }
                    if ($actionResult.actionCenterHitsButton -ne $true) { Add-Failure "manager-real-buttons action center did not hit button: $requiredAction" }
                    if ($actionResult.closeHitAreaOk -ne $true) { Add-Failure "manager-real-buttons action close hit area failed: $requiredAction" }
                    if ($actionResult.managerOpenedNewPage -ne $false) { Add-Failure "manager-real-buttons action opened a new page: $requiredAction" }
                    if ($null -eq $actionResult.pageTargetCountBeforeManagerOpen -or $null -eq $actionResult.pageTargetCountAfterManagerOpen) { Add-Failure "manager-real-buttons action missing page target counts: $requiredAction" }
                    if ([int]$actionResult.pageTargetCountAfterManagerOpen -gt [int]$actionResult.pageTargetCountBeforeManagerOpen) { Add-Failure "manager-real-buttons action increased page target count: $requiredAction" }
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
                strictOptionalRealTraffic = $releaseGatesSummary.strictOptionalRealTraffic
                optionalRealTrafficReady = $releaseGatesSummary.optionalRealTrafficReady
                optionalRealTrafficFailures = @($releaseGatesSummary.optionalRealTrafficFailures)
                missingRequired = @($releaseGatesSummary.missingRequired)
                missingShort = @($releaseGatesSummary.missingShort)
                missingOptional = @($releaseGatesSummary.missingOptional)
                damagedReports = @($releaseGatesSummary.damagedReports)
                releaseGateFailures = @($releaseGatesSummary.releaseGateFailures)
                releaseGateGroups = @($releaseGatesSummary.releaseGateGroups)
                releaseGateFailureReasons = @($releaseGatesSummary.releaseGateFailureReasons)
                nextActions = @($releaseGatesSummary.nextActions)
                nextActionsAvailableCount = $releaseGatesSummary.nextActionsAvailableCount
                nextActionsHiddenCount = $releaseGatesSummary.nextActionsHiddenCount
                nextActionsTruncated = $releaseGatesSummary.nextActionsTruncated
                approvalPlan = $releaseGatesSummary.approvalPlan
                releaseGateSelectedReports = @($releaseGatesSummary.releaseGateSelectedReports)
                installedRuntimeEvidence = $releaseGatesSummary.installedRuntimeEvidence
            }
        } else { $null }
        missingHistory = if ($missingHistorySummary) {
            [pscustomobject]@{
                ok = $missingHistorySummary.ok
                evidence = $missingHistorySummary.missingHistoryEvidence
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
                sourceSnapshot = $mcpSkillsSummary.sourceSnapshotEvidence
            }
        } else { $null }
        pluginCapabilities = if ($pluginCapabilitiesSummary) {
            [pscustomobject]@{
                ok = $pluginCapabilitiesSummary.ok
                evidence = $pluginCapabilitiesSummary.pluginCapabilityEvidence
                sourceSnapshot = $pluginCapabilitiesSummary.sourceSnapshotEvidence
            }
        } else { $null }
        refreshFeatures = if ($refreshFeaturesSummary) {
            [pscustomobject]@{
                ok = $refreshFeaturesSummary.ok
                evidence = $refreshFeaturesSummary.refreshFeatureEvidence
                sourceSnapshot = $refreshFeaturesSummary.sourceSnapshotEvidence
            }
        } else { $null }
        optionalRealProvider = if ($optionalRealProviderSummary) {
            [pscustomobject]@{
                ok = $optionalRealProviderSummary.ok
                skipped = $optionalRealProviderSummary.skipped
                requestedRealTraffic = $optionalRealProviderSummary.requestedRealTraffic
                usedRealTraffic = $optionalRealProviderSummary.usedRealTraffic
                behaviorCovered = $optionalRealProviderSummary.behaviorCovered
                coverageKind = $optionalRealProviderSummary.coverageKind
                reason = $optionalRealProviderSummary.reason
                coveredBy = $optionalRealProviderSummary.coveredBy
                evidence = $optionalRealProviderSummary.optionalRealProviderEvidence
            }
        } else { $null }
        antigravityReturn = if ($antigravityReturnSummary) {
            [pscustomobject]@{
                ok = $antigravityReturnSummary.ok
                skipped = $antigravityReturnSummary.skipped
                requestedRealTraffic = $antigravityReturnSummary.requestedRealTraffic
                usedRealTraffic = $antigravityReturnSummary.usedRealTraffic
                behaviorCovered = $antigravityReturnSummary.behaviorCovered
                coverageKind = $antigravityReturnSummary.coverageKind
                reason = $antigravityReturnSummary.reason
                coveredBy = $antigravityReturnSummary.coveredBy
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
$reportsSummaryCheck = $null
if ($VerifyReportsSummary) {
    try {
        $reportsSummaryCheck = Test-ReportsSummary -SummaryPath $VerifyReportsSummary -RequireReleaseReady:$false
    } catch {
        Add-Failure "reports summary verification failed: $($_.Exception.Message)"
    }
} else {
    try {
        $diagnostics = Invoke-LocalJson "/anticodex/diagnostics"
    } catch {
        Add-Failure "diagnostics request failed: $($_.Exception.Message)"
    }
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
    if (-not (Has-Property $diagnostics "logDbGuard")) {
        Add-Failure "diagnostics missing log database guard status"
    } else {
        if ($diagnostics.logDbGuard.reportName -ne "log-db-guard") { Add-Failure "diagnostics log database guard reportName mismatch" }
        if ($diagnostics.logDbGuard.noTraffic -ne $true) { Add-Failure "diagnostics log database guard missing noTraffic" }
        if ($diagnostics.logDbGuard.usedRealTraffic -ne $false) { Add-Failure "diagnostics log database guard used real traffic" }
        if ($diagnostics.logDbGuard.protected -ne $true) { Add-Failure "diagnostics log database guard is not protected" }
        if ($diagnostics.logDbGuard.triggerPresent -ne $true) { Add-Failure "diagnostics log database guard trigger missing" }
    }
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
        if (-not (Has-Property $localFeatures "connectorVerifier")) {
            Add-Failure "diagnostics localFeatures missing connector verifier summary"
        } else {
            $connectorVerifier = $localFeatures.connectorVerifier
            if (-not (Has-Property $connectorVerifier "noFakeAuthorization")) { Add-Failure "diagnostics connector verifier missing no-fake authorization proof" }
            if (-not (Has-Property $connectorVerifier "getPostParityClean")) { Add-Failure "diagnostics connector verifier missing GET/POST parity proof" }
            if (-not (Has-Property $connectorVerifier "connectorParityClean")) { Add-Failure "diagnostics connector verifier missing connector parity proof" }
            if (-not (Has-Property $connectorVerifier "appToolParityClean")) { Add-Failure "diagnostics connector verifier missing app-tool parity proof" }
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
    if (-not (Has-Property $diagnostics "longTasks")) {
        Add-Failure "diagnostics missing long-task status"
    } else {
        $longTaskItems = @($diagnostics.longTasks.items)
        foreach ($expectedTask in @("syncHost", "postVerificationFull")) {
            $task = @($longTaskItems | Where-Object { $_.id -eq $expectedTask } | Select-Object -First 1)[0]
            if (-not $task) {
                Add-Failure "diagnostics long-task status missing $expectedTask"
            } else {
                if (-not (Has-Property $task "latestLogLine")) { Add-Failure "diagnostics long-task $expectedTask missing latestLogLine" }
                if (-not (Has-Property $task "logUpdatedAt")) { Add-Failure "diagnostics long-task $expectedTask missing logUpdatedAt" }
                if (-not (Has-Property $task "logAgeMs")) { Add-Failure "diagnostics long-task $expectedTask missing logAgeMs" }
            }
        }
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
if ($VerifyBundle -and -not $VerifyReportsSummary) {
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
    reportsSummary = $reportsSummaryCheck
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
            logDbGuard = $diagnostics.logDbGuard
            stateRoot = $diagnostics.paths.stateRoot
            codexHome = $diagnostics.paths.codexHome
            sharedCodexHome = $diagnostics.paths.sharedCodexHome
        }
    } else { $null }
    bundle = $bundleCheck
}

$result | ConvertTo-Json -Depth 10 -Compress
if ($failures.Count -gt 0) { exit 1 }
