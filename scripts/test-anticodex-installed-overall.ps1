[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 8,
    [int]$DiagnosticsTimeoutSec = 20,
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
Import-Module (Join-Path $PSScriptRoot "anticodex-real-traffic-lock.psm1") -Force

if ($IncludePostVerification -ne "") {
    $NoTraffic = -not ($IncludePostVerification -match "^(1|true|yes)$")
}
if ($Fast -and (-not $AllowRealTraffic)) {
    $NoTraffic = $true
}
if ($AllowRealTraffic -and $SubcheckTimeoutSec -lt 120) {
    $SubcheckTimeoutSec = 120
}
$realTrafficTimeoutSec = if ($AllowRealTraffic) {
    [Math]::Max($TimeoutSec, 90)
} else {
    [Math]::Max($TimeoutSec, 25)
}

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$failures = New-Object System.Collections.Generic.List[string]
$checks = [ordered]@{}
$startedAt = [DateTime]::UtcNow

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Remove-Failure {
    param([string]$Message)
    while ($failures.Remove($Message)) {}
}

function Test-SyncReadinessHostSyncOnly {
    param($Report)
    if (-not $Report) { return $false }
    $sync = $Report.sync
    $updateStatus = if ($sync) { $sync.updateStatus } else { $null }
    $failureTexts = @($Report.failures | Where-Object { $_ })
    if ($failureTexts.Count -eq 0) { return $false }
    $unsupportedFailures = @($failureTexts | Where-Object {
        $_ -ne "Codex update status is not comparable: source_codex_changed" -and
        $_ -ne "installed Codex changed; Anti-Codex sync is required"
    })
    return (
        [string]$Report.reportName -eq "sync-readiness" -and
        $Report.noTraffic -eq $true -and
        $Report.behaviorCovered -eq $true -and
        [string]$Report.coverageKind -eq "installed-no-traffic" -and
        $unsupportedFailures.Count -eq 0 -and
        $updateStatus -and
        $updateStatus.updateNeeded -eq $true -and
        [string]$updateStatus.reason -eq "source_codex_changed" -and
        $updateStatus.sync -and
        $updateStatus.sync.available -eq $true -and
        $updateStatus.sync.launched -eq $false
    )
}

function New-SkippedCheck {
    param([string]$Reason, [string]$CoveredBy = "")
    return [pscustomobject]@{
        ok = $true
        skipped = $true
        reason = $Reason
        coveredBy = $CoveredBy
        behaviorCovered = $false
        coverageKind = "skipped"
        durationMs = 0
    }
}

function Normalize-Path {
    param([string]$Path)
    if (-not $Path) { return "" }
    try { return [IO.Path]::GetFullPath($Path) } catch { return [string]$Path }
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Invoke-LocalJson {
    param([string]$Path, [int]$RequestTimeoutSec = $TimeoutSec)
    return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $RequestTimeoutSec
}

$script:InstalledOverallDiagnosticsSnapshot = $null
function Get-InstalledOverallDiagnosticsSnapshot {
    if ($null -eq $script:InstalledOverallDiagnosticsSnapshot) {
        $script:InstalledOverallDiagnosticsSnapshot = Invoke-LocalJson "/anticodex/diagnostics" -RequestTimeoutSec $DiagnosticsTimeoutSec
    }
    return $script:InstalledOverallDiagnosticsSnapshot
}

function Get-InstalledOverallElapsedMs {
    return [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
}

function Get-FastBudgetRemainingMs {
    if ((-not $Fast) -or $FastMaxElapsedMs -le 0) { return [int]::MaxValue }
    return [Math]::Max(0, $FastMaxElapsedMs - (Get-InstalledOverallElapsedMs))
}

function Test-FastBudgetAvailable {
    param([string]$Name, [int]$MinimumRemainingMs = 5000)
    if ((-not $Fast) -or $FastMaxElapsedMs -le 0) { return $true }
    return (Get-FastBudgetRemainingMs) -ge $MinimumRemainingMs
}

function New-FastBudgetSkippedCheck {
    param([string]$Name, [string]$CoveredBy, [int]$MinimumRemainingMs = 5000)
    $remainingMs = Get-FastBudgetRemainingMs
    $check = New-SkippedCheck "fast budget skips $Name; remaining ${remainingMs}ms is below ${MinimumRemainingMs}ms" $CoveredBy
    $check | Add-Member -NotePropertyName fastBudgetSkipped -NotePropertyValue $true -Force
    $check | Add-Member -NotePropertyName remainingMs -NotePropertyValue $remainingMs -Force
    $check | Add-Member -NotePropertyName minimumRemainingMs -NotePropertyValue $MinimumRemainingMs -Force
    return $check
}

function Get-FreshMcpSkillsReportCheck {
    param([int]$MaxAgeHours = 48)
    $path = Join-Path $ReportRoot "latest-mcp-skills.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $item = Get-Item -LiteralPath $path
        $ageHours = ([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalHours
        if ($ageHours -gt $MaxAgeHours) { return $null }
        $integrity = Test-ReportIntegrity $path
        if (-not $integrity.signed -or $integrity.valid -ne $true) { return $null }
        $report = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -ErrorAction Stop
        $realListPassed = @($report.mcp.smoke.realList | Where-Object { $_.passed -eq $true }).Count
        $sourceFingerprint = if ($report.sourceSnapshot) { [string]$report.sourceSnapshot.fingerprint } else { "" }
        $acceptable = (
            $report.ok -eq $true -and
            [string]$report.reportName -eq "mcp-skills" -and
            $report.shortBudgetMode -ne $true -and
            [string]$report.capabilityState -eq "ready" -and
            $report.mcp.smoke.passed -eq $true -and
            $report.mcp.smoke.realCall.passed -eq $true -and
            $realListPassed -ge 2 -and
            $report.skills.fingerprintSkipped -ne $true -and
            $sourceFingerprint
        )
        if (-not $acceptable) { return $null }
        return [pscustomobject]@{
            ok = $true
            skipped = $false
            reusedLatestReport = $true
            behaviorCovered = $true
            coverageKind = "fresh-mcp-skills-report"
            coveredBy = "latest-mcp-skills.json"
            reportPath = $path
            reportUpdatedAt = $item.LastWriteTimeUtc.ToString("o")
            reportAgeHours = [Math]::Round($ageHours, 3)
            integrity = $integrity
            reportName = [string]$report.reportName
            capabilityState = [string]$report.capabilityState
            mcpPassed = [bool]$report.mcp.smoke.passed
            realCallPassed = [bool]$report.mcp.smoke.realCall.passed
            realListPassed = $realListPassed
            skillFingerprintSkipped = [bool]$report.skills.fingerprintSkipped
            sourceFingerprint = $sourceFingerprint
            durationMs = 0
        }
    } catch {
        return $null
    }
}

function Get-FreshPluginCapabilitiesReportCheck {
    param([int]$MaxAgeHours = 48)
    $path = Join-Path $ReportRoot "latest-plugin-capabilities.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $item = Get-Item -LiteralPath $path
        $ageHours = ([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalHours
        if ($ageHours -gt $MaxAgeHours) { return $null }
        $integrity = Test-ReportIntegrity $path
        if (-not $integrity.signed -or $integrity.valid -ne $true) { return $null }
        $report = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -ErrorAction Stop
        $capabilities = $report.capabilities
        $connectorParity = $capabilities.connectorParity
        $appToolParity = $capabilities.appToolParity
        $appToolGetPostParity = $capabilities.appToolGetPostParity
        $sourceFingerprint = if ($report.sourceSnapshot) { [string]$report.sourceSnapshot.fingerprint } else { "" }
        $missingConnectors = @($connectorParity.missingShared | Where-Object { $_ })
        $extraConnectors = @($connectorParity.extraLocal | Where-Object { $_ })
        $changedConnectors = @($connectorParity.changedShared | Where-Object { $_ })
        $missingAppTools = @($appToolParity.missingShared | Where-Object { $_ })
        $extraAppTools = @($appToolParity.extraLocal | Where-Object { $_ })
        $changedAppTools = @($appToolParity.changedShared | Where-Object { $_ })
        $missingAppToolsFromGet = @($appToolGetPostParity.missingFromGet | Where-Object { $_ })
        $extraAppToolsFromGet = @($appToolGetPostParity.extraFromGet | Where-Object { $_ })
        $acceptable = (
            $report.ok -eq $true -and
            [string]$report.reportName -eq "plugin-capabilities" -and
            $report.shortBudgetMode -ne $true -and
            $sourceFingerprint -and
            [string]$capabilities.capabilityState -ne "degraded_short_budget" -and
            $capabilities.smoke.checked -eq $true -and
            $connectorParity.checked -eq $true -and
            $missingConnectors.Count -eq 0 -and
            $extraConnectors.Count -eq 0 -and
            $changedConnectors.Count -eq 0 -and
            $appToolParity.checked -eq $true -and
            $missingAppTools.Count -eq 0 -and
            $extraAppTools.Count -eq 0 -and
            $changedAppTools.Count -eq 0 -and
            $appToolGetPostParity.checked -eq $true -and
            $appToolGetPostParity.contentMatches -eq $true -and
            $missingAppToolsFromGet.Count -eq 0 -and
            $extraAppToolsFromGet.Count -eq 0 -and
            [int]$capabilities.unauthorizedAppToolCount -eq 0 -and
            [int]$capabilities.unattributedAppToolCount -eq 0
        )
        if (-not $acceptable) { return $null }
        return [pscustomobject]@{
            ok = $true
            skipped = $false
            reusedLatestReport = $true
            behaviorCovered = $true
            coverageKind = "fresh-plugin-capabilities-report"
            coveredBy = "latest-plugin-capabilities.json"
            reportPath = $path
            reportUpdatedAt = $item.LastWriteTimeUtc.ToString("o")
            reportAgeHours = [Math]::Round($ageHours, 3)
            integrity = $integrity
            reportName = [string]$report.reportName
            capabilityState = [string]$capabilities.capabilityState
            connectorParityClean = $true
            appToolParityClean = $true
            appToolGetPostParityClean = $true
            unauthorizedAppToolCount = [int]$capabilities.unauthorizedAppToolCount
            unattributedAppToolCount = [int]$capabilities.unattributedAppToolCount
            sourceFingerprint = $sourceFingerprint
            durationMs = 0
        }
    } catch {
        return $null
    }
}

function Get-FreshThirdPartyProviderReportCheck {
    param([int]$MaxAgeHours = 48)
    $path = Join-Path $ReportRoot "latest-third-party-provider.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $item = Get-Item -LiteralPath $path
        $ageHours = ([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalHours
        if ($ageHours -gt $MaxAgeHours) { return $null }
        $integrity = Test-ReportIntegrity $path
        if (-not $integrity.signed -or $integrity.valid -ne $true) { return $null }
        $report = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -ErrorAction Stop
        $history = $report.multiTurnHistory
        $providerSwitch = $history.providerSwitch
        $protocolSwitch = $history.protocolSwitch
        $reverseProtocolSwitch = $history.reverseProtocolSwitch
        $previousResponseContinuity = $history.previousResponseContinuity
        $acceptable = (
            $report.ok -eq $true -and
            [string]$report.reportName -eq "third-party-provider" -and
            $report.usedRealTraffic -eq $false -and
            $report.behaviorCovered -eq $true -and
            [string]$report.coverageKind -eq "local-fake-provider" -and
            $report.secretsRedacted -eq $true -and
            [int]$history.turns -eq 9 -and
            $report.savedWithoutHistoryLoss -eq $true -and
            $report.restoredAntigravityWithoutHistoryLoss -eq $true -and
            $report.restartedProviderWithoutHistoryLoss -eq $true -and
            $report.switchedProviderWithoutHistoryLoss -eq $true -and
            $report.crossProtocolWithoutHistoryLoss -eq $true -and
            $report.reverseCrossProtocolWithoutHistoryLoss -eq $true -and
            $history.providerModelUsedForEveryTurn -eq $true -and
            $providerSwitch.requestReachedSecondProvider -eq $true -and
            $protocolSwitch.requestReachedAnthropicProvider -eq $true -and
            $reverseProtocolSwitch.requestReachedOpenAiCompatibleProvider -eq $true -and
            $previousResponseContinuity.saveMatched -eq $true -and
            $previousResponseContinuity.restartMatched -eq $true -and
            $previousResponseContinuity.providerSwitchMatched -eq $true -and
            $previousResponseContinuity.protocolSwitchMatched -eq $true -and
            $previousResponseContinuity.reverseProtocolSwitchMatched -eq $true
        )
        if (-not $acceptable) { return $null }
        return [pscustomobject]@{
            ok = $true
            skipped = $false
            reusedLatestReport = $true
            behaviorCovered = $true
            coverageKind = "fresh-third-party-provider-report"
            coveredBy = "latest-third-party-provider.json"
            reportPath = $path
            reportUpdatedAt = $item.LastWriteTimeUtc.ToString("o")
            reportAgeHours = [Math]::Round($ageHours, 3)
            integrity = $integrity
            reportName = [string]$report.reportName
            turns = [int]$history.turns
            providerSwitchReached = [bool]$providerSwitch.requestReachedSecondProvider
            protocolSwitchReached = [bool]$protocolSwitch.requestReachedAnthropicProvider
            reverseProtocolSwitchReached = [bool]$reverseProtocolSwitch.requestReachedOpenAiCompatibleProvider
            previousResponseContinuity = $previousResponseContinuity
            durationMs = 0
        }
    } catch {
        return $null
    }
}

function Test-LocalHealth {
    try {
        $probe = Invoke-LocalJson "/health"
        return $probe.ok -eq $true
    } catch {
        return $false
    }
}

function Wait-Until {
    param([scriptblock]$Predicate, [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (& $Predicate) { return $true }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Wait-AntiCodexSubcheckProcess {
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

function Read-AntiCodexTempTextWithRetry {
    param([string]$Path, [int]$TimeoutMs = 3000)
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(100, $TimeoutMs))
    $lastError = $null
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
            $lastError = $_.Exception
            Start-Sleep -Milliseconds 100
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    try {
        return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    } catch {
        if ($lastError) { return "" }
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

function Invoke-JsonScript {
    param(
        [string]$Name,
        [string]$ScriptPath,
        [string[]]$Arguments = @()
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        Add-Failure "$Name script missing: $ScriptPath"
        return $null
    }

    $powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $checkStarted = [DateTime]::UtcNow
    $durationMs = 0
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $argumentList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $Arguments
        $process = Start-Process -FilePath $powerShellBin `
            -ArgumentList $argumentList `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        [void]$process.Handle
        $completed = Wait-AntiCodexSubcheckProcess -Process $process -TimeoutSeconds $SubcheckTimeoutSec
        if (-not $completed) {
            try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
            Wait-AntiCodexSubcheckProcess -Process $process -TimeoutSeconds 3 -PollMs 100 | Out-Null
            Add-Failure "$Name timed out after $SubcheckTimeoutSec seconds"
            $exitCode = -1
        } else {
            $exitCode = [int]$process.ExitCode
        }
        $durationMs = [int]([DateTime]::UtcNow - $checkStarted).TotalMilliseconds
        $stdoutText = Read-AntiCodexTempTextWithRetry $stdoutPath
        $stderrText = Read-AntiCodexTempTextWithRetry $stderrPath
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
    $lines = @($stdoutText -split "\r?\n" | Where-Object { $_ -ne "" })
    if ($stderrText.Trim()) {
        $lines += @($stderrText -split "\r?\n" | Where-Object { $_ -ne "" })
    }
    $jsonText = ($lines -join "`n").Trim()
    $jsonJoined = ($lines -join "").Trim()
    $jsonLine = [string](@($lines | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1))

    if ($exitCode -ne 0) {
        Add-Failure "$Name failed with exit code $exitCode"
    }

    if (-not $jsonText -and -not $jsonJoined -and -not $jsonLine) {
        Add-Failure "$Name did not emit a JSON result"
        return [pscustomobject]@{
            ok = $false
            exitCode = $exitCode
            durationMs = $durationMs
            tail = @($lines | Select-Object -Last 20)
        }
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in @($jsonText, $jsonJoined, $jsonLine)) {
        if ($candidate -and -not $candidates.Contains($candidate)) {
            $candidates.Add($candidate) | Out-Null
        }
        if ($candidate) {
            $start = $candidate.IndexOf("{")
            $end = $candidate.LastIndexOf("}")
            if ($start -ge 0 -and $end -gt $start) {
                $trimmed = $candidate.Substring($start, $end - $start + 1)
                if ($trimmed -and -not $candidates.Contains($trimmed)) {
                    $candidates.Add($trimmed) | Out-Null
                }
            }
        }
    }

    try {
        $parsed = $null
        $lastError = $null
        foreach ($payloadText in $candidates) {
            try {
                $parsed = $payloadText | ConvertFrom-Json -ErrorAction Stop
                break
            } catch {
                $lastError = $_
            }
        }
        if (-not $parsed) {
            if ($lastError) { throw $lastError }
            throw "No JSON candidate parsed"
        }
        if ((Has-Property $parsed "ok") -and $parsed.ok -ne $true) {
            Add-Failure "$Name reported ok=false"
        }
        if (-not (Has-Property $parsed "durationMs")) {
            $parsed | Add-Member -NotePropertyName durationMs -NotePropertyValue $durationMs -Force
        }
        return $parsed
    } catch {
        Add-Failure "$Name emitted invalid JSON: $($_.Exception.Message)"
        return [pscustomobject]@{
            ok = $false
            exitCode = $exitCode
            durationMs = $durationMs
            tail = @($lines | Select-Object -Last 20)
        }
    }
}

function Invoke-NodeJsonScript {
    param(
        [string]$Name,
        [string]$ScriptPath,
        [string[]]$Arguments = @(),
        [int]$ProcessTimeoutSec = $SubcheckTimeoutSec
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        Add-Failure "$Name script missing: $ScriptPath"
        return $null
    }

    $node = Join-Path $installRoot "codex-patched-app\resources\cua_node\bin\node.exe"
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
        $nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
        if ($nodeCommand) { $node = $nodeCommand.Source }
    }
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
        Add-Failure "$Name cannot find node.exe"
        return $null
    }

    $checkStarted = [DateTime]::UtcNow
    $durationMs = 0
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $argumentList = @($ScriptPath) + $Arguments
        $process = Start-Process -FilePath $node `
            -ArgumentList $argumentList `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        [void]$process.Handle
        $completed = Wait-AntiCodexSubcheckProcess -Process $process -TimeoutSeconds $ProcessTimeoutSec
        if (-not $completed) {
            try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
            Wait-AntiCodexSubcheckProcess -Process $process -TimeoutSeconds 3 -PollMs 100 | Out-Null
            if ((Split-Path -Leaf $ScriptPath) -eq "test-anticodex-manager-button.mjs") {
                Clear-ManagerButtonVerifierLock -ProcessId ([int]$process.Id)
            }
            Add-Failure "$Name Node script timed out after $ProcessTimeoutSec seconds"
            $exitCode = -1
        } else {
            $exitCode = [int]$process.ExitCode
        }
        $durationMs = [int]([DateTime]::UtcNow - $checkStarted).TotalMilliseconds
        $stdoutText = Read-AntiCodexTempTextWithRetry $stdoutPath
        $stderrText = Read-AntiCodexTempTextWithRetry $stderrPath
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
    $lines = @($stdoutText -split "\r?\n" | Where-Object { $_ -ne "" })
    if ($stderrText.Trim()) {
        $lines += @($stderrText -split "\r?\n" | Where-Object { $_ -ne "" })
    }
    $jsonLine = @($lines | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)

    if ($exitCode -ne 0) {
        Add-Failure "$Name failed with exit code $exitCode"
    }

    if (-not $jsonLine) {
        Add-Failure "$Name did not emit a JSON result"
        return [pscustomobject]@{
            ok = $false
            exitCode = $exitCode
            durationMs = $durationMs
            tail = @($lines | Select-Object -Last 20)
        }
    }

    try {
        $parsed = $jsonLine | ConvertFrom-Json
        if ((Has-Property $parsed "ok") -and $parsed.ok -ne $true) {
            Add-Failure "$Name reported ok=false"
        }
        if (-not (Has-Property $parsed "durationMs")) {
            $parsed | Add-Member -NotePropertyName durationMs -NotePropertyValue $durationMs -Force
        }
        return $parsed
    } catch {
        Add-Failure "$Name emitted invalid JSON: $($_.Exception.Message)"
        return [pscustomobject]@{
            ok = $false
            exitCode = $exitCode
            durationMs = $durationMs
            tail = @($lines | Select-Object -Last 20)
        }
    }
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
    Remove-OldReports -HistoryPath $Paths.history
}

function Test-ReportIntegrity {
    param([string]$Path)
    $sidecar = "$Path.sha256"
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
        return [pscustomobject]@{ signed = $false; valid = $null; hash = ""; expected = ""; error = "missing_hash_sidecar" }
    }
    try {
        $rawExpected = (Get-Content -LiteralPath $sidecar -Raw -Encoding ASCII).Trim()
        if ($rawExpected -notmatch "^(?:sha256:)?([a-fA-F0-9]{64})$") {
            return [pscustomobject]@{ signed = $true; valid = $false; hash = ""; expected = $rawExpected; error = "invalid_hash_sidecar" }
        }
        $expected = $Matches[1].ToLowerInvariant()
        $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        return [pscustomobject]@{ signed = $true; valid = ($hash -eq $expected); hash = $hash; expected = $expected; error = if ($hash -eq $expected) { "" } else { "hash_mismatch" } }
    } catch {
        return [pscustomobject]@{ signed = $true; valid = $false; hash = ""; expected = ""; error = $_.Exception.Message }
    }
}

function Test-ReportEncoding {
    param(
        [string]$Root = $ReportRoot,
        [DateTime]$Since = $startedAt
    )
    $names = @(
        "latest-installed-overall-fast.json",
        "latest-installed-overall.json",
        "latest-model-routing.json",
        "latest-model-thinking.json",
        "latest-ambient-suggestions.json",
        "latest-log-db-guard.json",
        "latest-source-preflight.json",
        "latest-diagnostics.json",
        "latest-account-proxy-readiness.json",
        "latest-post-verification.json",
        "latest-tool-bridge-mode.json",
        "latest-ui-idle-stability.json",
        "latest-sync-readiness.json",
        "latest-codex-responses.json",
        "latest-ui-chat-smoke.json",
        "latest-ui-web-search-smoke.json",
        "latest-ui-local-project-smoke.json",
        "latest-ui-coding-project-smoke.json",
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
        "latest-cancellation.json",
        "latest-web-tools.json",
        "latest-mcp-skills.json",
        "latest-plugin-capabilities.json",
        "latest-local-connectors.json",
        "latest-release-gates.json",
        "latest-cold-relaunch.json",
        "latest-real-third-party-provider.json",
        "latest-provider-antigravity-return.json",
        "latest-third-party-provider.json",
        "latest-missing-history.json",
        "latest-manager-real-buttons.json",
        "latest-refresh-features.json",
        "latest-shortcut-repair.json",
        "latest-compaction-resume.json",
        "latest-stability-soak.json"
    )
    $items = New-Object System.Collections.Generic.List[object]
    $encodingFailures = New-Object System.Collections.Generic.List[string]
    $legacyIssues = New-Object System.Collections.Generic.List[string]
    foreach ($name in $names) {
        $path = Join-Path $Root $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            $items.Add([pscustomobject]@{ file = $name; exists = $false; fresh = $false; bom = $false; parseable = $false }) | Out-Null
            continue
        }
        try {
            $item = Get-Item -LiteralPath $path
            $isFresh = ($item.LastWriteTimeUtc -ge $Since.ToUniversalTime().AddSeconds(-2))
            $bytes = [System.IO.File]::ReadAllBytes($path)
            $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)
            $integrity = Test-ReportIntegrity $path
            $parseable = $false
            try {
                [void]([System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json)
                $parseable = $true
            } catch {}
            if (-not $parseable) { $encodingFailures.Add("$name is not parseable JSON") | Out-Null }
            if ($isFresh) {
                if ($hasBom) { $encodingFailures.Add("$name has UTF-8 BOM") | Out-Null }
                if (-not $integrity.signed) { $encodingFailures.Add("$name missing SHA256 sidecar") | Out-Null }
                if ($integrity.signed -and $integrity.valid -eq $false) { $encodingFailures.Add("$name SHA256 sidecar mismatch: $($integrity.error)") | Out-Null }
            } else {
                if ($hasBom) { $legacyIssues.Add("$name has UTF-8 BOM") | Out-Null }
                if (-not $integrity.signed) { $legacyIssues.Add("$name missing SHA256 sidecar") | Out-Null }
                if ($integrity.signed -and $integrity.valid -eq $false) { $encodingFailures.Add("$name SHA256 sidecar mismatch: $($integrity.error)") | Out-Null }
            }
            $items.Add([pscustomobject]@{ file = $name; exists = $true; fresh = $isFresh; bom = $hasBom; parseable = $parseable; integrity = $integrity }) | Out-Null
        } catch {
            $encodingFailures.Add("$name cannot be read: $($_.Exception.Message)") | Out-Null
            $items.Add([pscustomobject]@{ file = $name; exists = $true; fresh = $true; bom = $null; parseable = $false; integrity = $null }) | Out-Null
        }
    }
    return [pscustomobject]@{
        ok = ($encodingFailures.Count -eq 0)
        failures = $encodingFailures.ToArray()
        legacyIssues = $legacyIssues.ToArray()
        checked = $items.ToArray()
    }
}

function Test-InstalledGuardWording {
    param([string]$RuntimeRoot)
    $scriptPath = Join-Path $RuntimeRoot "translator\adaptive-server.mjs"
    $failures = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        $failures.Add("adaptive-server.mjs missing from installed runtime") | Out-Null
        return [pscustomobject]@{
            ok = $false
            failures = $failures.ToArray()
            scriptPath = $scriptPath
        }
    }
    $text = [IO.File]::ReadAllText($scriptPath, [Text.Encoding]::UTF8)
    $start = $text.IndexOf("function blockedToolClaimMessage")
    $end = $text.IndexOf("function fakeToolClaimRelayPrompt")
    $block = if ($start -ge 0 -and $end -gt $start) { $text.Substring($start, $end - $start) } else { "" }
    $oldContinue = [string]::Concat([char[]](0x8BF7, 0x7EE7, 0x7EED, 0x65F6))
    $friendlyFakeExecution = [string]::Concat([char[]](0x6CA1, 0x6709, 0x771F, 0x7684, 0x8BFB, 0x6587, 0x4EF6))
    $webNext = ([string]::Concat([char[]](0x4E0B, 0x4E00, 0x6B65, 0xFF1A, 0x5FC5, 0x987B, 0x771F, 0x5B9E, 0x8C03, 0x7528)) + " web_search/web_fetch")
    if (-not $block) { $failures.Add("guard wording block not found") | Out-Null }
    if ($block -notmatch "Anti-Codex") { $failures.Add("guard wording does not mention Anti-Codex") | Out-Null }
    if ($block -match "DeepCodex") { $failures.Add("guard wording leaks DeepCodex") | Out-Null }
    if ($block.Contains($oldContinue)) { $failures.Add("guard wording still contains old continue phrasing") | Out-Null }
    if (-not $block.Contains($friendlyFakeExecution)) { $failures.Add("guard wording missing user-readable fake-execution explanation") | Out-Null }
    if (-not $block.Contains($webNext)) { $failures.Add("web guard wording missing updated next-step phrasing") | Out-Null }
    return [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        failures = $failures.ToArray()
        scriptPath = $scriptPath
        hasAntiCodex = ($block -match "Anti-Codex")
        hasLegacyDeepCodex = ($block -match "DeepCodex")
        hasOldContinuePhrasing = $block.Contains($oldContinue)
        hasFriendlyFakeExecutionText = $block.Contains($friendlyFakeExecution)
    }
}

function Remove-OldReports {
    param([string]$HistoryPath, [int]$Keep = 30)
    if (-not $HistoryPath) { return }
    $leaf = Split-Path -Leaf $HistoryPath
    $match = [regex]::Match($leaf, "^\d{8}-\d{6}-(.+)\.json$")
    if (-not $match.Success) { return }
    $name = $match.Groups[1].Value
    $root = Split-Path -Parent $HistoryPath
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
    Get-ChildItem -LiteralPath $root -Filter "*-$name.json" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -Skip $Keep |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

function Remove-OldReportHistories {
    param([string]$Root = $ReportRoot, [int]$Keep = 30)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    $histories = foreach ($file in Get-ChildItem -LiteralPath $Root -Filter "*.json" -File -ErrorAction SilentlyContinue) {
        $match = [regex]::Match($file.Name, "^\d{8}-\d{6}-(.+)\.json$")
        if ($match.Success) {
            [pscustomobject]@{
                name = $match.Groups[1].Value
                file = $file
            }
        }
    }
    $histories |
        Group-Object name |
        ForEach-Object {
            $_.Group |
                Sort-Object { $_.file.LastWriteTimeUtc } -Descending |
                Select-Object -Skip $Keep |
                ForEach-Object { Remove-Item -LiteralPath $_.file.FullName -Force -ErrorAction SilentlyContinue }
        }
}

function Get-AsarDataOffset {
    param([UInt32]$HeaderStringSize)
    $prefixSize = 16
    return [int64]($prefixSize + $HeaderStringSize + ((4 - (($prefixSize + $HeaderStringSize) % 4)) % 4))
}

function Read-AsarHeader {
    param([string]$AsarPath)
    $stream = [IO.File]::OpenRead($AsarPath)
    try {
        $prefix = New-Object byte[] 16
        if ($stream.Read($prefix, 0, 16) -ne 16) {
            throw "ASAR header prefix is incomplete"
        }
        $headerStringSize = [BitConverter]::ToUInt32($prefix, 12)
        $headerBytes = New-Object byte[] $headerStringSize
        if ($stream.Read($headerBytes, 0, [int]$headerStringSize) -ne [int]$headerStringSize) {
            throw "ASAR header JSON is incomplete"
        }
        return [pscustomobject]@{
            header = ([Text.Encoding]::UTF8.GetString($headerBytes).TrimEnd(" ") | ConvertFrom-Json)
            dataOffset = Get-AsarDataOffset $headerStringSize
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-AsarEntry {
    param($Header, [string]$RelativePath)
    $node = $Header
    foreach ($part in $RelativePath.Split("/")) {
        if (-not (Has-Property $node "files")) {
            throw "ASAR path '$RelativePath' stopped before '$part'"
        }
        $property = $node.files.PSObject.Properties[$part]
        if (-not $property) {
            throw "ASAR entry missing: $RelativePath"
        }
        $node = $property.Value
    }
    return $node
}

function Get-AsarFilePaths {
    param($Node, [string]$Prefix = "")
    $paths = New-Object System.Collections.Generic.List[string]
    if (-not (Has-Property $Node "files")) { return $paths.ToArray() }
    foreach ($property in $Node.files.PSObject.Properties) {
        $relative = if ($Prefix) { "$Prefix/$($property.Name)" } else { $property.Name }
        if (Has-Property $property.Value "files") {
            foreach ($childPath in @(Get-AsarFilePaths $property.Value $relative)) {
                $paths.Add($childPath) | Out-Null
            }
        } else {
            $paths.Add($relative) | Out-Null
        }
    }
    return $paths.ToArray()
}

function Read-AsarEntryText {
    param([string]$AsarPath, $Header, [int64]$DataOffset, [string]$RelativePath)
    $entry = Get-AsarEntry $Header $RelativePath
    $size = [int64]$entry.size
    $offset = $DataOffset + [int64]$entry.offset
    $buffer = New-Object byte[] $size
    $stream = [IO.File]::OpenRead($AsarPath)
    try {
        $null = $stream.Seek($offset, [IO.SeekOrigin]::Begin)
        $read = $stream.Read($buffer, 0, [int]$size)
        if ($read -ne [int]$size) {
            throw "ASAR entry '$RelativePath' is incomplete"
        }
        return [Text.Encoding]::UTF8.GetString($buffer)
    } finally {
        $stream.Dispose()
    }
}

function Test-InstalledBranding {
    param([string]$InstallRoot)

    $asarPath = Normalize-Path (Join-Path $InstallRoot "codex-patched-app\resources\app.asar")
    $result = [ordered]@{
        ok = $false
        appAsar = $asarPath
        appNamePatched = $false
        appUserModelIdPatched = $false
        oldAppNameSetterRemoved = $false
        trayUsesAppName = $false
        windowTitlePatched = $false
        packageProductNamePatched = $false
        mainFileCount = 0
        error = $null
    }

    try {
        if (-not (Test-Path -LiteralPath $asarPath -PathType Leaf)) {
            throw "installed app.asar is missing"
        }

        $asar = Read-AsarHeader $asarPath
        $packageJson = Read-AsarEntryText $asarPath $asar.header $asar.dataOffset "package.json"
        $bootstrap = Read-AsarEntryText $asarPath $asar.header $asar.dataOffset ".vite/build/bootstrap.js"
        $mainFiles = @(Get-AsarFilePaths $asar.header | Where-Object { $_ -match "^\.vite/build/main-.*\.js$" })
        $mainText = ""
        foreach ($mainFile in $mainFiles) {
            $mainText += Read-AsarEntryText $asarPath $asar.header $asar.dataOffset $mainFile
        }

        $result.packageProductNamePatched = $packageJson -match '"productName"\s*:\s*"Anti-Codex"'
        $result.appNamePatched = $bootstrap.Contains('.app.name=`Anti-Codex`')
        $result.appUserModelIdPatched = $bootstrap.Contains('setAppUserModelId(`AntiCodex`)')
        $result.oldAppNameSetterRemoved = $bootstrap -notmatch "\.app\.setName\("
        $result.trayUsesAppName = $mainText -match "setToolTip\([^)]*\.app\.getName\(\)\)"
        $result.windowTitlePatched = $mainText.Contains('title:"Anti-Codex"') -or
            $mainText.Contains("title:'Anti-Codex'") -or
            $mainText.Contains('title:`Anti-Codex`')
        $result.mainFileCount = $mainFiles.Count
        $result.ok = $result.packageProductNamePatched -and
            $result.appNamePatched -and
            $result.appUserModelIdPatched -and
            $result.oldAppNameSetterRemoved -and
            $result.trayUsesAppName -and
            $result.windowTitlePatched -and
            ($mainFiles.Count -gt 0)
    } catch {
        $result.error = $_.Exception.Message
    }

    return [pscustomobject]$result
}

function Test-ExternalBranding {
    param($MainProcesses, [string]$ActiveMainExe)

    $result = [ordered]@{
        ok = $false
        executablePath = $ActiveMainExe
        fileDescription = $null
        productName = $null
        originalFilename = $null
        processNames = @()
        mainWindowTitles = @()
        processNamesPatched = $false
        windowTitlesPatched = $false
        exeVersionPatched = $false
        error = $null
    }

    try {
        if (-not (Test-Path -LiteralPath $ActiveMainExe -PathType Leaf)) {
            throw "Anti-Codex main executable is missing"
        }

        $exe = Get-Item -LiteralPath $ActiveMainExe
        $result.fileDescription = [string]$exe.VersionInfo.FileDescription
        $result.productName = [string]$exe.VersionInfo.ProductName
        $result.originalFilename = [string]$exe.VersionInfo.OriginalFilename
        $result.exeVersionPatched = (
            $result.fileDescription -eq "Anti-Codex" -and
            $result.productName -eq "Anti-Codex" -and
            $result.originalFilename -eq "Anti-Codex.exe"
        )

        $result.processNames = @($MainProcesses | ForEach-Object { [string]$_.Name })
        $result.processNamesPatched = ($result.processNames.Count -gt 0) -and
            (@($result.processNames | Where-Object { $_ -ne "Anti-Codex.exe" }).Count -eq 0)

        $titles = New-Object System.Collections.Generic.List[string]
        foreach ($proc in @($MainProcesses)) {
            $live = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
            if ($live -and $live.MainWindowTitle) {
                $titles.Add([string]$live.MainWindowTitle) | Out-Null
            }
        }
        $result.mainWindowTitles = $titles.ToArray()
        $result.windowTitlesPatched = (@($result.mainWindowTitles | Where-Object { $_ -ne "Anti-Codex" }).Count -eq 0)

        $result.ok = $result.exeVersionPatched -and $result.processNamesPatched -and $result.windowTitlesPatched
    } catch {
        $result.error = $_.Exception.Message
    }

    return [pscustomobject]$result
}

$runtimeRootFull = Normalize-Path $RuntimeRoot
$installRoot = Normalize-Path (Split-Path -Parent $runtimeRootFull)
$activeHost = Normalize-Path (Join-Path $installRoot "codex-patched-app")
$activeMainExe = Normalize-Path (Join-Path $activeHost "Anti-Codex.exe")
$translatorScript = Normalize-Path (Join-Path $runtimeRootFull "translator\adaptive-server.mjs")
$translatorExe = Normalize-Path (Join-Path $installRoot "bin\deepcodex-translator.exe")
$scriptsRoot = Join-Path $runtimeRootFull "scripts"

function Get-AntiCodexHostProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        return $exe.StartsWith($activeHost, [StringComparison]::OrdinalIgnoreCase) -and
            ([string]$_.CommandLine) -notmatch "\s--type="
    })
}

function Get-AntiCodexMainProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        return ($exe -ieq $activeMainExe) -and
            ([string]$_.CommandLine) -notmatch "\s--type="
    })
}

function Get-AntiCodexTranslatorProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $commandLine = [string]$_.CommandLine
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        ($exe -ieq $translatorExe) -or ($commandLine -like "*$translatorScript*")
    })
}

function Get-AntiCodexLauncherProcesses {
    $installRootEscaped = [regex]::Escape($installRoot)
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and
        ([string]$_.CommandLine) -match $installRootEscaped -and
        ([string]$_.CommandLine) -match "start-(anti|deep)codex\.ps1"
    })
}

function Get-OriginalCodexMainProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        ($_.Name -ieq "Codex.exe") -and
        (-not $exe.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)) -and
        ([string]$_.CommandLine) -notmatch "\s--type="
    })
}

function Start-AntiCodexIfNeeded {
    if ((@(Get-AntiCodexMainProcesses).Count -gt 0) -and (Test-LocalHealth)) { return $true }
    $launcher = Join-Path $scriptsRoot "start-anticodex.ps1"
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        Add-Failure "Anti-Codex launcher missing: $launcher"
        return $false
    }
    try {
        $powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
        Start-Process -FilePath $powerShellBin `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher, "-SkipUpdateCheck") `
            -WindowStyle Hidden | Out-Null
    } catch {
        Add-Failure "failed to launch Anti-Codex: $($_.Exception.Message)"
        return $false
    }
    return Wait-Until -TimeoutSeconds 60 -Predicate {
        (@(Get-AntiCodexMainProcesses).Count -gt 0) -and (Test-LocalHealth)
    }
}

if ($EnsureRunning) {
    if (-not (Start-AntiCodexIfNeeded)) {
        Add-Failure "Anti-Codex did not become healthy after launch request"
    }
}

$health = $null
$models = $null
$healthMode = "unknown"
$healthProtocol = $null
$healthModel = $null

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
        if ($health.accountReady -ne $true -and (-not $NoTraffic)) { Add-Failure "Antigravity account is not ready: $($health.accountMessage)" }
        if ($health.accountReady -ne $true -and $NoTraffic -and [int]$health.modelCount -lt 1) { Add-Failure "Antigravity model catalog is not ready: $($health.accountMessage)" }
        if ([int]$health.modelCount -lt 1) { Add-Failure "health modelCount is empty" }
    } else {
        Add-Failure "unknown upstream mode (upstream=$($health.upstream), upstreamProfile.mode=$healthMode)"
    }
} catch {
    Add-Failure "health request failed: $($_.Exception.Message)"
}

try {
    $models = Invoke-LocalJson "/models"
    if (-not $models.data -or @($models.data).Count -lt 1) {
        Add-Failure "/models returned no models"
    }
} catch {
    Add-Failure "models request failed: $($_.Exception.Message)"
}

$mainProcesses = @(Get-AntiCodexMainProcesses)
$hostProcesses = @(Get-AntiCodexHostProcesses)
$translatorProcesses = @(Get-AntiCodexTranslatorProcesses)
$launcherProcesses = @(Get-AntiCodexLauncherProcesses)
$originalCodexProcesses = @(Get-OriginalCodexMainProcesses)

if ((-not $EnsureRunning) -and $mainProcesses.Count -lt 1 -and $translatorProcesses.Count -lt 1) {
    Add-Failure "Anti-Codex is not running; rerun with -EnsureRunning or start Anti-Codex first"
}

if ($mainProcesses.Count -ne 1) {
    Add-Failure "expected exactly one Anti-Codex main process, found $($mainProcesses.Count)"
} else {
    $mainProcess = Get-Process -Id $mainProcesses[0].ProcessId -ErrorAction SilentlyContinue
    if ($mainProcess -and $mainProcess.MainWindowTitle -and $mainProcess.MainWindowTitle -ne "Anti-Codex") {
        Add-Failure "Anti-Codex main window title is '$($mainProcess.MainWindowTitle)'"
    }
}

if ($translatorProcesses.Count -lt 1) {
    Add-Failure "Anti-Codex translator process is not running"
}

$checks.branding = Test-InstalledBranding $installRoot
if (-not $checks.branding.ok) {
    Add-Failure "installed branding verification failed"
}

$checks.externalBranding = Test-ExternalBranding $mainProcesses $activeMainExe
if (-not $checks.externalBranding.ok) {
    Add-Failure "external Anti-Codex branding verification failed"
}

$scriptArgs = @("-BaseUrl", $BaseUrl, "-TimeoutSec", "$TimeoutSec")
$diagnosticScriptArgs = @("-BaseUrl", $BaseUrl, "-TimeoutSec", "$DiagnosticsTimeoutSec")
$uiProbeTimeoutSec = [Math]::Max(1, [Math]::Min($TimeoutSec, [Math]::Max(1, $SubcheckTimeoutSec - 10)))
$uiStateArgs = @("-BaseUrl", $BaseUrl, "-TimeoutSec", "$uiProbeTimeoutSec")
if ($Fast) { $uiStateArgs += @("-Fast") }
if ($Fast -or $SkipManagerActionProbe) { $uiStateArgs += @("-SkipManagerActionProbe") }
$checks.uiState = if ($SkipUiStateProbe) {
    New-SkippedCheck "SkipUiStateProbe avoids reopening the embedded Manager from inside a Manager action" "test-anticodex-ui-state.ps1"
} else {
    Invoke-JsonScript "UI state verification" (Join-Path $scriptsRoot "test-anticodex-ui-state.ps1") $uiStateArgs
}
$checks.uiStateMode = if ($healthMode -eq "third-party") {
    [pscustomobject]@{
        ok = $true
        skipped = $false
        reason = "third-party mode keeps UI/Manager verification enabled"
        coveredBy = "test-anticodex-ui-state.ps1"
        durationMs = 0
    }
} else {
    [pscustomobject]@{
        ok = $true
        skipped = $false
        reason = "Antigravity mode verifies native UI catalog and thinking budget"
        coveredBy = "test-anticodex-ui-state.ps1"
        durationMs = 0
    }
}
$uiCdpPort = if ($checks.uiState -and (Has-Property $checks.uiState "port")) { [string]$checks.uiState.port } else { "" }
if ($SkipUiStateProbe) {
    $checks.managerButtonMcpSkills = New-SkippedCheck "SkipUiStateProbe skips recursive Manager button smoke from inside the embedded Manager" "test-anticodex-manager-button.mjs"
    $checks.managerButtonPluginCapabilities = New-SkippedCheck "SkipUiStateProbe skips recursive Manager button smoke from inside the embedded Manager" "test-anticodex-manager-button.mjs"
    $checks.managerButtonSourcePreflight = New-SkippedCheck "SkipUiStateProbe skips recursive Manager button smoke from inside the embedded Manager" "test-anticodex-manager-button.mjs"
    $checks.managerButtonSafeActions = New-SkippedCheck "SkipUiStateProbe skips real Manager safe button clicks from inside the embedded Manager" "test-anticodex-manager-button.mjs"
    $checks.managerButtonReportActions = New-SkippedCheck "SkipUiStateProbe skips real Manager report button clicks from inside the embedded Manager" "test-anticodex-manager-button.mjs"
    $checks.managerButtonDiagnosticsBundle = New-SkippedCheck "SkipUiStateProbe skips real Manager diagnostics bundle click from inside the embedded Manager" "test-anticodex-manager-button.mjs"
} elseif ($uiCdpPort) {
    $managerButtonScript = Join-Path $scriptsRoot "test-anticodex-manager-button.mjs"
    if ($Fast) {
        $checks.managerButtonMcpSkills = New-SkippedCheck "fast mode skips the long-running MCP/Skill Manager click; standalone MCP/skills verification still runs" "test-anticodex-mcp-skills.ps1"
        $checks.managerButtonPluginCapabilities = New-SkippedCheck "fast mode covers plugin/application button state through UI verification; full verification clicks the button" "uiState"
        $checks.managerButtonSourcePreflight = New-SkippedCheck "fast mode covers source preflight through source gate; full verification clicks the Manager button" "sourcePreflight"
        $checks.managerButtonSafeActions = New-SkippedCheck "fast mode skips real Manager safe button batch; full verification clicks the buttons" "test-anticodex-manager-button.mjs"
        $checks.managerButtonReportActions = New-SkippedCheck "fast mode skips real Manager report button batch; full verification clicks the buttons" "test-anticodex-manager-button.mjs"
        $checks.managerButtonDiagnosticsBundle = New-SkippedCheck "fast mode skips the slow Manager diagnostics bundle click; full verification clicks the button" "test-anticodex-manager-button.mjs"
    } else {
        $checks.managerButtonMcpSkills = New-SkippedCheck "combined overall skips the long MCP/Skill Manager click; standalone Manager real-buttons verification covers real MCP/Skill and plugin/application clicks without destabilizing later UI samples" "test-anticodex-manager-real-buttons.ps1"
        $checks.managerButtonPluginCapabilities = New-SkippedCheck "combined overall skips the long plugin/application Manager click; standalone plugin capability verification covers connector and app-tool visibility without destabilizing later UI samples" "test-anticodex-plugin-capabilities.ps1"
        $checks.managerButtonSourcePreflight = Invoke-NodeJsonScript "Manager safe button smoke verification - Manager source preflight button verification" $managerButtonScript @("--port", $uiCdpPort, "--action", "sourcePreflight", "--verification-mode", "ui-only", "--timeout-ms", "12000", "--compact", "1")
        $checks.managerButtonSafeActions = New-SkippedCheck "combined overall skips background Manager safe-action batch; update/source/sync buttons are covered by dedicated checks and ui-only hit-area smoke" "test-anticodex-manager-button.mjs"
        $checks.managerButtonReportActions = New-SkippedCheck "combined overall skips report button real click; standalone Manager button verifier covers it without polluting later UI samples" "test-anticodex-manager-button.mjs"
        $checks.managerButtonDiagnosticsBundle = New-SkippedCheck "combined overall skips diagnostics bundle real click; standalone Manager button verifier covers bundle generation and ZIP evidence" "test-anticodex-manager-button.mjs"
    }
} else {
    Add-Failure "UI state verification did not report a CDP port for Manager button checks"
}
$checks.managerAction = if ($Fast -or $SkipManagerActionProbe) {
    if ($SkipManagerActionProbe) {
        New-SkippedCheck "SkipManagerActionProbe skips direct Manager action security probe" "test-anticodex-manager-action.ps1"
    } else {
        New-SkippedCheck "fast mode skips direct Manager action security probe; run without -Fast before release" "test-anticodex-manager-action.ps1"
    }
} else {
    New-SkippedCheck "combined overall skips direct Manager action security probe; standalone verifier remains the authority for token/source-header checks" "test-anticodex-manager-action.ps1"
}
$checks.uiIdleStability = if ($Fast -or $SkipManagerActionProbe) {
    if ($SkipManagerActionProbe) {
        New-SkippedCheck "SkipManagerActionProbe skips combined UI idle sampling; standalone uiIdleStability release gate remains authoritative" "test-anticodex-ui-idle-stability.ps1"
    } else {
        New-SkippedCheck "fast mode skips UI idle stability sampling" "test-anticodex-ui-idle-stability.ps1"
    }
} else {
    Invoke-JsonScript "UI idle stability verification" (Join-Path $scriptsRoot "test-anticodex-ui-idle-stability.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-RuntimeRoot", $runtimeRootFull,
        "-DurationSec", "$IdleStabilityDurationSec",
        "-IntervalSec", "$IdleStabilityIntervalSec",
        "-TimeoutSec", "$([Math]::Min([Math]::Max($TimeoutSec, 60), [Math]::Max(1, $SubcheckTimeoutSec - 10)))"
        $(if ($SkipManagerActionProbe) { "-SkipManagerActionProbe" })
    )
}
$checks.diagnostics = if ($Fast) {
    New-SkippedCheck "fast mode uses the Manager/UI diagnostics snapshot; full verification runs the standalone diagnostics probe" "uiState"
} else {
    Invoke-JsonScript "Diagnostics verification" (Join-Path $scriptsRoot "test-anticodex-diagnostics.ps1") $diagnosticScriptArgs
}
$checks.sourcePreflightPublicDocumentation = try {
    $diagForSourcePreflight = Get-InstalledOverallDiagnosticsSnapshot
    $sourcePreflight = $diagForSourcePreflight.sourcePreflight
    $ok = $diagForSourcePreflight.object -eq "anticodex.diagnostics" `
        -and (Has-Property $sourcePreflight "publicDocumentationOk") `
        -and $sourcePreflight.publicDocumentationOk -eq $true
    if (-not $ok) {
        Add-Failure "source preflight public documentation status is missing or not green in diagnostics"
    }
    [pscustomobject]@{
        ok = $ok
        skipped = $false
        reason = "diagnostics sourcePreflight.publicDocumentationOk must be green"
        publicDocumentationOk = if (Has-Property $sourcePreflight "publicDocumentationOk") { [bool]$sourcePreflight.publicDocumentationOk } else { $null }
        reportName = if (Has-Property $sourcePreflight "reportName") { [string]$sourcePreflight.reportName } else { "" }
    }
} catch {
    Add-Failure "source preflight public documentation status check failed: $($_.Exception.Message)"
    [pscustomobject]@{
        ok = $false
        error = $_.Exception.Message
    }
}
$checks.logDbGuardDiagnostics = try {
    $diagnostics = Get-InstalledOverallDiagnosticsSnapshot
    $guard = $diagnostics.logDbGuard
    $protected = (Has-Property $guard "protected") -and $guard.protected -eq $true
    $triggerPresent = (Has-Property $guard "triggerPresent") -and $guard.triggerPresent -eq $true
    $noTraffic = (Has-Property $guard "noTraffic") -and $guard.noTraffic -eq $true
    $usedRealTraffic = (Has-Property $guard "usedRealTraffic") -and $guard.usedRealTraffic -eq $false
    $walBytesOk = (Has-Property $guard "walBytes") -and [long]$guard.walBytes -ge 0
    if (-not $protected) { Add-Failure "installed overall log database guard is not protected" }
    if (-not $triggerPresent) { Add-Failure "installed overall log database guard trigger is missing" }
    if (-not $noTraffic -or -not $usedRealTraffic) { Add-Failure "installed overall log database guard no-traffic evidence is invalid" }
    if (-not $walBytesOk) { Add-Failure "installed overall log database guard WAL evidence is missing" }
    [pscustomobject]@{
        ok = ($protected -and $triggerPresent -and $noTraffic -and $usedRealTraffic -and $walBytesOk)
        skipped = $false
        reason = "diagnostics.logDbGuard must prove TRACE protection before overall readiness"
        protected = $protected
        triggerPresent = $triggerPresent
        noTraffic = $noTraffic
        usedRealTraffic = if (Has-Property $guard "usedRealTraffic") { [bool]$guard.usedRealTraffic } else { $null }
        walBytes = if (Has-Property $guard "walBytes") { [long]$guard.walBytes } else { $null }
    }
} catch {
    Add-Failure "installed overall log database guard diagnostics check failed: $($_.Exception.Message)"
    [pscustomobject]@{
        ok = $false
        error = $_.Exception.Message
    }
}
$checks.toolBridgeMode = if ($healthMode -eq "third-party") {
    $thirdPartyToolBridgeStarted = [DateTime]::UtcNow
    try {
        $thirdPartyDiagnostics = Get-InstalledOverallDiagnosticsSnapshot
        $thirdPartyBridge = $thirdPartyDiagnostics.toolBridge
        $thirdPartyToolBridgeOk = $thirdPartyDiagnostics.object -eq "anticodex.diagnostics" `
            -and $thirdPartyBridge.mode -eq "provider-native-or-compat" `
            -and $thirdPartyBridge.transport -eq "upstream-provider" `
            -and $thirdPartyBridge.nativeAntigravityToolEvents -eq $false `
            -and $thirdPartyBridge.acceptsExternalToolDefinitions -eq $true
        if (-not $thirdPartyToolBridgeOk) {
            Add-Failure "third-party tool bridge verification reported an invalid provider bridge"
        }
        [pscustomobject]@{
            ok = $thirdPartyToolBridgeOk
            skipped = $false
            reason = "third-party mode uses provider-native-or-compat bridge"
            toolBridge = $thirdPartyBridge
            durationMs = [int]([DateTime]::UtcNow - $thirdPartyToolBridgeStarted).TotalMilliseconds
        }
    } catch {
        Add-Failure "third-party tool bridge verification failed: $($_.Exception.Message)"
        [pscustomobject]@{
            ok = $false
            error = $_.Exception.Message
            durationMs = [int]([DateTime]::UtcNow - $thirdPartyToolBridgeStarted).TotalMilliseconds
        }
    }
} elseif ($Fast) {
    $fastToolBridgeStarted = [DateTime]::UtcNow
    try {
        $fastDiagnostics = Get-InstalledOverallDiagnosticsSnapshot
        $fastBridge = $fastDiagnostics.toolBridge
        $fastNative = $fastDiagnostics.nativeToolCapability
        $fastToolBridgeOk = $fastDiagnostics.object -eq "anticodex.diagnostics" `
            -and $fastBridge.mode -eq "native-mcp-same-cascade" `
            -and $fastBridge.nativeBridgeDefaultEnabled -eq $true `
            -and $fastNative.nativeMcpDiscoveryVerified -eq $true `
            -and $fastNative.nativeMcpPermissionMode -eq "automatic-before-codex-execution" `
            -and $fastNative.permissionPromptsDisabled -eq $true
        if (-not $fastToolBridgeOk) {
            Add-Failure "Fast tool bridge verification reported an incomplete native MCP bridge"
        }
        [pscustomobject]@{
            ok = $fastToolBridgeOk
            fast = $true
            toolBridge = $fastBridge
            nativeToolCapability = $fastNative
            durationMs = [int]([DateTime]::UtcNow - $fastToolBridgeStarted).TotalMilliseconds
        }
    } catch {
        Add-Failure "Fast tool bridge verification failed: $($_.Exception.Message)"
        [pscustomobject]@{
            ok = $false
            fast = $true
            error = $_.Exception.Message
            durationMs = [int]([DateTime]::UtcNow - $fastToolBridgeStarted).TotalMilliseconds
        }
    }
} else {
    Invoke-JsonScript "Tool bridge mode verification" (Join-Path $scriptsRoot "test-anticodex-tool-bridge-mode.ps1") $diagnosticScriptArgs
}
$checks.runtimeConfig = if ($Fast) {
    New-SkippedCheck "fast mode skips static runtime config verification; full verification covers it" "test-anticodex-runtime-config.ps1"
} else {
    Invoke-JsonScript "Runtime config verification" (Join-Path $scriptsRoot "test-anticodex-runtime-config.ps1")
}
$checks.websocketFallback = if ($Fast) {
    New-SkippedCheck "fast mode skips websocket fallback protocol verification; full verification covers it" "test-anticodex-websocket-fallback.ps1"
} else {
    Invoke-JsonScript "Websocket fallback verification" (Join-Path $scriptsRoot "test-anticodex-websocket-fallback.ps1") $scriptArgs
}
$checks.websocketProtocolAudit = if ($Fast) {
    New-SkippedCheck "fast mode skips websocket protocol audit" "test-anticodex-websocket-protocol-audit.ps1"
} else {
    Invoke-JsonScript "Websocket protocol audit" (Join-Path $scriptsRoot "test-anticodex-websocket-protocol-audit.ps1") @(
        "-InstallRoot", $installRoot
    )
}
$checks.missingHistory = if ($Fast -and -not (Test-FastBudgetAvailable "missing response history verification" 8000)) {
    New-FastBudgetSkippedCheck "missing response history verification" "latest-missing-history.json" 8000
} else {
    Invoke-NodeJsonScript "Missing response history verification" (Join-Path $scriptsRoot "test-anticodex-missing-history.mjs") @(
        "--base-url", $BaseUrl,
        "--report-root", $ReportRoot,
        "--timeout-ms", ([string][Math]::Max(3000, $TimeoutSec * 1000))
    ) ([Math]::Max(10, $TimeoutSec + 5))
}
$freshThirdPartyProviderCheck = if ($NoTraffic) { Get-FreshThirdPartyProviderReportCheck } else { $null }
$checks.thirdPartyProvider = if ($Fast) {
    New-SkippedCheck "fast mode skips local third-party provider end-to-end verification" "test-anticodex-third-party-provider.mjs"
} elseif ($freshThirdPartyProviderCheck) {
    $freshThirdPartyProviderCheck
} else {
    $thirdPartyProviderTimeoutMs = 90000
    $thirdPartyProviderProcessTimeoutSec = [int][Math]::Ceiling($thirdPartyProviderTimeoutMs / 1000) + 15
    Invoke-NodeJsonScript "Third-party provider local end-to-end verification" (Join-Path $scriptsRoot "test-anticodex-third-party-provider.mjs") @(
        "--source-root", $runtimeRootFull,
        "--runtime-root", $RuntimeRoot,
        "--report-root", $ReportRoot,
        "--timeout-ms", "$thirdPartyProviderTimeoutMs"
    ) $thirdPartyProviderProcessTimeoutSec
}
$checks.realThirdPartyProviderOptional = if ($AllowRealTraffic -and (-not $NoTraffic)) {
    New-SkippedCheck "real third-party provider verification requires explicit provider protocol, URL, model, and API key environment variable" "test-anticodex-real-third-party-provider.mjs"
} else {
    Invoke-NodeJsonScript "Optional real third-party provider skip report" (Join-Path $scriptsRoot "test-anticodex-real-third-party-provider.mjs") @(
        "--report-root", $ReportRoot
    )
}
$checks.providerAntigravityReturnOptional = if ($AllowRealTraffic -and (-not $NoTraffic)) {
    Invoke-JsonScript "Optional provider-to-Antigravity return verification" (Join-Path $scriptsRoot "test-anticodex-provider-antigravity-return.ps1") @(
        "-RuntimeRoot", $runtimeRootFull,
        "-ReportRoot", $ReportRoot,
        "-TimeoutSec", "$realTrafficTimeoutSec",
        "-AllowRealTraffic"
    )
} else {
    Invoke-JsonScript "Optional provider-to-Antigravity return skip report" (Join-Path $scriptsRoot "test-anticodex-provider-antigravity-return.ps1") @(
        "-RuntimeRoot", $runtimeRootFull,
        "-ReportRoot", $ReportRoot
    )
}
$checks.localConnectors = if ($Fast) {
    New-SkippedCheck "fast mode skips local connector/app-tool allowlist verification" "test-anticodex-local-connectors.mjs"
} else {
    Invoke-NodeJsonScript "Local connector/app-tool allowlist verification" (Join-Path $scriptsRoot "test-anticodex-local-connectors.mjs") @(
        "--source-root", $runtimeRootFull,
        "--runtime-root", $RuntimeRoot,
        "--report-root", $ReportRoot,
        "--timeout-ms", "60000"
    )
}
$freshMcpSkillsCheck = if ($Fast -or $NoTraffic) { Get-FreshMcpSkillsReportCheck } else { $null }
$checks.mcpSkills = if ($checks.managerButtonMcpSkills -and (Has-Property $checks.managerButtonMcpSkills "ok") -and $checks.managerButtonMcpSkills.ok -eq $true -and $checks.managerButtonMcpSkills.skipped -ne $true -and $checks.managerButtonMcpSkills.result.lastUiOnly -ne $true) {
    New-SkippedCheck "covered by Manager MCP/Skill button smoke" "managerButtonMcpSkills"
} elseif ($freshMcpSkillsCheck) {
    $freshMcpSkillsCheck
} elseif ($Fast -and -not (Test-FastBudgetAvailable "MCP/skills verification" 10000)) {
    New-FastBudgetSkippedCheck "MCP/skills verification" "latest-mcp-skills.json" 10000
} else {
    Invoke-JsonScript "MCP/skills verification" (Join-Path $scriptsRoot "test-anticodex-mcp-skills.ps1") $scriptArgs
}
$checks.independence = if ($Fast) {
    New-SkippedCheck "fast mode skips static installation independence verification; full verification covers it" "test-anticodex-independence.ps1"
} else {
    Invoke-JsonScript "Independence verification" (Join-Path $scriptsRoot "test-anticodex-independence.ps1")
}
$freshPluginCapabilitiesCheck = if ($Fast -or $NoTraffic) { Get-FreshPluginCapabilitiesReportCheck } else { $null }
$checks.pluginCapabilities = if ($checks.managerButtonPluginCapabilities -and (Has-Property $checks.managerButtonPluginCapabilities "ok") -and $checks.managerButtonPluginCapabilities.ok -eq $true -and $checks.managerButtonPluginCapabilities.skipped -ne $true -and $checks.managerButtonPluginCapabilities.result.lastUiOnly -ne $true) {
    New-SkippedCheck "covered by Manager plugin/application button smoke" "managerButtonPluginCapabilities"
} elseif ($freshPluginCapabilitiesCheck) {
    $freshPluginCapabilitiesCheck
} elseif ($Fast -and -not (Test-FastBudgetAvailable "plugin capability verification" 10000)) {
    New-FastBudgetSkippedCheck "plugin capability verification" "latest-plugin-capabilities.json" 10000
} else {
    Invoke-JsonScript "Plugin capability verification" (Join-Path $scriptsRoot "test-anticodex-plugin-capabilities.ps1") $scriptArgs
}
$checks.syncReadiness = if ($Fast) {
    New-SkippedCheck "fast mode skips full sync readiness; run without -Fast before release" "test-anticodex-sync-readiness.ps1"
} else {
    Invoke-JsonScript "Sync readiness verification" (Join-Path $scriptsRoot "test-anticodex-sync-readiness.ps1") @(
        "-RuntimeRoot", $runtimeRootFull
    )
}
if ((-not $Fast) -and (Test-SyncReadinessHostSyncOnly $checks.syncReadiness)) {
    Remove-Failure "Sync readiness verification failed with exit code 1"
    Remove-Failure "Sync readiness verification reported ok=false"
    $checks.syncReadiness | Add-Member -NotePropertyName hostSyncRequired -NotePropertyValue $true -Force
    $checks.syncReadiness | Add-Member -NotePropertyName overallBlocking -NotePropertyValue $false -Force
    $checks.syncReadiness | Add-Member -NotePropertyName releaseBlocking -NotePropertyValue $true -Force
    $checks.syncReadiness | Add-Member -NotePropertyName overallClassification -NotePropertyValue "host_sync_required_not_runtime_unusable" -Force
}
if ((-not $Fast) -and $checks.syncReadiness) {
    $shortcutVerification = $checks.syncReadiness.sync.shortcutVerification
    if (-not $shortcutVerification -or @($shortcutVerification).Count -lt 5) {
        Add-Failure "shortcut verification did not report exact evidence"
    }
    $shortcutLauncherMismatches = @($shortcutVerification | Where-Object { $_.launcherTargetMatches -ne $true })
    if ($shortcutLauncherMismatches.Count -gt 0) {
        Add-Failure "shortcut verification did not prove exact Anti-Codex launcher targets"
    }
}
$checks.modelRoutingNoTraffic = if ($Fast) {
    New-SkippedCheck "fast mode uses UI catalog and thinking-budget checks; full verification runs the no-traffic routing probe" "uiState+modelThinking"
} else {
    Invoke-JsonScript "No-traffic model routing verification" (Join-Path $scriptsRoot "test-anticodex-model-routing.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$DiagnosticsTimeoutSec",
        "-SkipRefresh",
        "-SkipRequests"
    )
}
$checks.modelThinking = if ($healthMode -eq "third-party") {
    New-SkippedCheck "third-party mode skips Antigravity thinking-budget verification" "upstreamProfile"
} elseif ($Fast) {
    New-SkippedCheck "fast mode uses UI model labels and native thinking budgets; full verification runs the standalone budget probe" "uiState"
} else {
    Invoke-JsonScript "Model thinking budget verification" (Join-Path $scriptsRoot "test-anticodex-model-thinking.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$TimeoutSec"
    )
}
$checks.ambientSuggestions = if ($Fast) {
    New-SkippedCheck "fast mode skips ambient background suggestions guard; full verification covers it" "test-anticodex-ambient-suggestions.ps1"
} else {
    Invoke-JsonScript "Ambient background suggestions guard" (Join-Path $scriptsRoot "test-anticodex-ambient-suggestions.ps1")
}
$checks.reportEncoding = Test-ReportEncoding $ReportRoot $startedAt
if (-not $checks.reportEncoding.ok) {
    Add-Failure ("report encoding verification failed: " + (($checks.reportEncoding.failures | Select-Object -First 3) -join "; "))
}

$checks.guardWording = Test-InstalledGuardWording $runtimeRootFull
if (-not $checks.guardWording.ok) {
    Add-Failure ("installed guard wording verification failed: " + (($checks.guardWording.failures | Select-Object -First 3) -join "; "))
}

if (-not $NoTraffic) {
    $realTrafficLock = Enter-AntiCodexRealTrafficLock -WaitSeconds 0
    if (-not $realTrafficLock.acquired) {
        $checks.realTraffic = New-AntiCodexRealTrafficBusyResult -Name "installed-overall-real-traffic" -ElapsedMs ([int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
    } else {
    try {
    $checks.codexResponses = Invoke-JsonScript "Codex internal Responses stream verification" (Join-Path $scriptsRoot "test-anticodex-codex-responses.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec"
    )
    $checks.uiChatSmoke = Invoke-NodeJsonScript "Desktop UI chat smoke verification" (Join-Path $scriptsRoot "test-anticodex-ui-chat-smoke.mjs") @(
        "--base-url", $BaseUrl,
        "--report-root", $ReportRoot,
        "--timeout-ms", "$($realTrafficTimeoutSec * 1000)"
    ) ([Math]::Max(20, $realTrafficTimeoutSec + 10))
    $checks.uiWebSearchSmoke = Invoke-NodeJsonScript "Desktop UI web-search smoke verification" (Join-Path $scriptsRoot "test-anticodex-ui-chat-smoke.mjs") @(
        "--base-url", $BaseUrl,
        "--report-root", $ReportRoot,
        "--task-mode", "web-search",
        "--timeout-ms", "$($realTrafficTimeoutSec * 1000)"
    ) ([Math]::Max(20, $realTrafficTimeoutSec + 10))
    $checks.uiLocalProjectSmoke = Invoke-NodeJsonScript "Desktop UI local project smoke verification" (Join-Path $scriptsRoot "test-anticodex-ui-chat-smoke.mjs") @(
        "--base-url", $BaseUrl,
        "--report-root", $ReportRoot,
        "--task-mode", "local-project",
        "--timeout-ms", "$([Math]::Max($realTrafficTimeoutSec, 120) * 1000)"
    ) ([Math]::Max(130, $realTrafficTimeoutSec + 10))
    $checks.uiCodingProjectSmoke = Invoke-NodeJsonScript "Desktop UI coding project smoke verification" (Join-Path $scriptsRoot "test-anticodex-ui-chat-smoke.mjs") @(
        "--base-url", $BaseUrl,
        "--report-root", $ReportRoot,
        "--task-mode", "coding-project",
        "--timeout-ms", "$([Math]::Max($realTrafficTimeoutSec, 120) * 1000)"
    ) ([Math]::Max(130, $realTrafficTimeoutSec + 10))
    $checks.uiReportSiteSmoke = Invoke-NodeJsonScript "Desktop UI report-site smoke verification" (Join-Path $scriptsRoot "test-anticodex-ui-chat-smoke.mjs") @(
        "--base-url", $BaseUrl,
        "--report-root", $ReportRoot,
        "--task-mode", "report-site",
        "--timeout-ms", "$([Math]::Max($realTrafficTimeoutSec, 150) * 1000)"
    ) ([Math]::Max(160, $realTrafficTimeoutSec + 10))
    $checks.modelSwitchHistory = Invoke-JsonScript "Model switch history verification" (Join-Path $scriptsRoot "test-anticodex-model-switch-history.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec"
    )
    $checks.toolLoop = Invoke-JsonScript "Tool loop verification" (Join-Path $scriptsRoot "test-anticodex-tool-loop.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec"
    )
    $nativeBridgeEnabled = $env:ANTICODEX_NATIVE_TOOL_BRIDGE -eq "1"
    if ($checks.toolBridgeMode -and $checks.toolBridgeMode.toolBridge -and $checks.toolBridgeMode.toolBridge.nativeBridgeDefaultEnabled -eq $true) {
        $nativeBridgeEnabled = $true
    }
    if ($healthMode -eq "antigravity" -and $nativeBridgeEnabled) {
        $checks.nativeToolLoop = Invoke-JsonScript "Native Antigravity tool loop verification" (Join-Path $scriptsRoot "test-anticodex-native-tool-loop.ps1") @(
            "-BaseUrl", $BaseUrl,
            "-TimeoutSec", "$realTrafficTimeoutSec"
        )
        $checks.nativeMultiToolLoop = Invoke-JsonScript "Native serialized multi-tool loop verification" (Join-Path $scriptsRoot "test-anticodex-native-multi-tool-loop.ps1") @(
            "-BaseUrl", $BaseUrl,
            "-TimeoutSec", "$realTrafficTimeoutSec"
        )
    }
    $checks.webTools = Invoke-JsonScript "Internal web tools verification" (Join-Path $scriptsRoot "test-anticodex-web-tools.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec"
    )
    $checks.mcpToolLoop = Invoke-JsonScript "MCP tool loop verification" (Join-Path $scriptsRoot "test-anticodex-mcp-tool-loop.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec"
    )
    $checks.customToolLoop = Invoke-JsonScript "Custom/freeform tool loop verification" (Join-Path $scriptsRoot "test-anticodex-custom-tool-loop.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec"
    )
    $checks.compactionResume = Invoke-JsonScript "Compaction and session resume verification" (Join-Path $scriptsRoot "test-anticodex-compaction-resume.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec"
    )
    $checks.cancellationMode = if ($healthMode -eq "third-party") {
        [pscustomobject]@{
            ok = $true
            skipped = $false
            reason = "third-party mode verifies provider streaming cancellation"
            coveredBy = "test-anticodex-cancellation.ps1"
            durationMs = 0
        }
    } else {
        [pscustomobject]@{
            ok = $true
            skipped = $false
            reason = "Antigravity mode verifies native streaming cancellation"
            coveredBy = "test-anticodex-cancellation.ps1"
            durationMs = 0
        }
    }
    $checks.cancellation = Invoke-JsonScript "Streaming cancellation verification" (Join-Path $scriptsRoot "test-anticodex-cancellation.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-Model", $(if ($healthModel) { $healthModel } else { "" }),
        "-TimeoutSec", "25"
    )
    } finally {
        Exit-AntiCodexRealTrafficLock $realTrafficLock
    }
    }
}
if ($healthMode -eq "third-party") {
    $checks.accountProxyReadiness = New-SkippedCheck "third-party mode skips Antigravity account/proxy verification" "upstreamProfile"
} elseif ((-not $NoTraffic) -and (-not $SkipAccountProxyProbe)) {
    $checks.accountProxyReadiness = Invoke-JsonScript "Account/proxy readiness verification" (Join-Path $scriptsRoot "test-anticodex-account-proxy-readiness.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec"
    )
}

$checks.realMiniTool = if ($healthMode -ne "antigravity") {
    New-SkippedCheck "third-party mode skips the Antigravity real mini-tool task" "upstreamProfile"
} elseif ($NoTraffic -or (-not $AllowRealTraffic)) {
    New-SkippedCheck "real mini-tool task requires explicit -AllowRealTraffic" "test-anticodex-real-mini-tool.ps1"
} else {
    Invoke-JsonScript "Real mini-tool task verification" (Join-Path $scriptsRoot "test-anticodex-real-mini-tool.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec",
        "-AllowRealTraffic"
    )
}

$checks.realWork = if ($healthMode -ne "antigravity") {
    New-SkippedCheck "third-party mode skips the Antigravity real-work task" "upstreamProfile"
} elseif ($NoTraffic -or (-not $AllowRealTraffic)) {
    New-SkippedCheck "real-work task requires explicit -AllowRealTraffic" "test-anticodex-real-work.ps1"
} else {
    Invoke-JsonScript "Real work task verification" (Join-Path $scriptsRoot "test-anticodex-real-work.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec",
        "-AllowRealTraffic"
    )
}

$checks.realSmallProject = if ($healthMode -ne "antigravity") {
    New-SkippedCheck "third-party mode skips the Antigravity real small-project task" "upstreamProfile"
} elseif ($NoTraffic -or (-not $AllowRealTraffic)) {
    New-SkippedCheck "real small-project task requires explicit -AllowRealTraffic" "test-anticodex-real-small-project.ps1"
} else {
    Invoke-JsonScript "Real small-project task verification" (Join-Path $scriptsRoot "test-anticodex-real-small-project.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-TimeoutSec", "$realTrafficTimeoutSec",
        "-AllowRealTraffic"
    )
}

if ($IncludeSoak) {
    $checks.stabilitySoakMode = if ($healthMode -eq "third-party") {
        [pscustomobject]@{
            ok = $true
            skipped = $false
            reason = "third-party mode verifies provider stability soak"
            coveredBy = "test-anticodex-stability-soak.ps1"
            durationMs = 0
        }
    } else {
        [pscustomobject]@{
            ok = $true
            skipped = $false
            reason = "Antigravity mode verifies native stability soak"
            coveredBy = "test-anticodex-stability-soak.ps1"
            durationMs = 0
        }
    }
    $checks.stabilitySoak = Invoke-JsonScript "Stability soak" (Join-Path $scriptsRoot "test-anticodex-stability-soak.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-Model", $(if ($healthModel) { $healthModel } else { "" }),
        "-ReportRoot", $ReportRoot,
        "-DurationSec", "$SoakDurationSec"
    )
}

if ($IncludeColdRelaunch) {
    $checks.coldRelaunchMode = if ($healthMode -eq "third-party") {
        [pscustomobject]@{
            ok = $true
            skipped = $false
            reason = "third-party mode verifies provider cold relaunch"
            coveredBy = "test-anticodex-cold-relaunch.ps1"
            durationMs = 0
        }
    } else {
        [pscustomobject]@{
            ok = $true
            skipped = $false
            reason = "Antigravity mode verifies native cold relaunch"
            coveredBy = "test-anticodex-cold-relaunch.ps1"
            durationMs = 0
        }
    }
    $checks.coldRelaunch = Invoke-JsonScript "Cold relaunch verification" (Join-Path $scriptsRoot "test-anticodex-cold-relaunch.ps1") @(
        "-BaseUrl", $BaseUrl,
        "-RuntimeRoot", $runtimeRootFull,
        "-TimeoutSec", "18",
        "-StopTimeoutSec", "5",
        "-HealthPollTimeoutSec", "18",
        "-ConfirmRelaunch"
    )
}

$endedAt = [DateTime]::UtcNow
$elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
if ($Fast -and $FastMaxElapsedMs -gt 0 -and $elapsedMs -gt $FastMaxElapsedMs) {
    Add-Failure "fast installed overall exceeded ${FastMaxElapsedMs}ms: ${elapsedMs}ms"
}

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    noTraffic = [bool]$NoTraffic
    fast = [bool]$Fast
    usedRealTraffic = if ($NoTraffic) { $false } else { [bool]$AllowRealTraffic }
    behaviorCovered = ($failures.Count -eq 0)
    coverageKind = if ($NoTraffic) {
        if ($Fast) { "installed-fast-no-traffic" } else { "installed-no-traffic" }
    } elseif ($AllowRealTraffic) {
        "installed-real-traffic"
    } else {
        "installed"
    }
    fastMaxElapsedMs = if ($Fast) { $FastMaxElapsedMs } else { $null }
    elapsedMs = $elapsedMs
    baseUrl = $BaseUrl
    runtimeRoot = $runtimeRootFull
    installRoot = $installRoot
    health = [pscustomobject]@{
        ok = if ($health) { $health.ok } else { $false }
        upstream = if ($health) { $health.upstream } else { $null }
        mode = $healthMode
        protocol = $healthProtocol
        model = $healthModel
        accountReady = if ($health) { $health.accountReady } else { $false }
        accountState = if ($health) { $health.accountState } else { $null }
        accountTrafficReady = if ($health) { $health.accountTrafficReady } else { $null }
        accountTrafficState = if ($health) { $health.accountTrafficState } else { $null }
        accountTrafficDiagnosis = if ($health) { $health.accountTrafficDiagnosis } else { $null }
        modelCount = if ($health) { $health.modelCount } else { 0 }
        circuitState = if ($health) { $health.antigravityCircuitState } else { $null }
    }
    models = [pscustomobject]@{
        count = if ($models -and $models.data) { @($models.data).Count } else { 0 }
        ids = if ($models -and $models.data) { @($models.data | ForEach-Object { [string]$_.id }) } else { @() }
    }
    processes = [pscustomobject]@{
        mainCount = $mainProcesses.Count
        mainPids = @($mainProcesses | ForEach-Object { [int]$_.ProcessId })
        mainNames = @($mainProcesses | ForEach-Object { [string]$_.Name })
        hostProcessCount = $hostProcesses.Count
        hostProcessNames = @($hostProcesses | ForEach-Object { [string]$_.Name })
        translatorCount = $translatorProcesses.Count
        translatorPids = @($translatorProcesses | ForEach-Object { [int]$_.ProcessId })
        launcherCount = $launcherProcesses.Count
        originalCodexMainPids = @($originalCodexProcesses | ForEach-Object { [int]$_.ProcessId })
    }
    checks = $checks
}

$reportName = if ($Fast) { "installed-overall-fast" } else { "installed-overall" }
$result | Add-Member -NotePropertyName reportName -NotePropertyValue $reportName -Force
$reportPaths = New-ReportPaths $reportName
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
Save-JsonReport $reportPaths $result
Remove-OldReportHistories

$result | ConvertTo-Json -Depth 10 -Compress
if ($failures.Count -gt 0) { exit 1 }
