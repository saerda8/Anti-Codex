#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$NoRestart
)

if ($PSVersionTable.PSEdition -eq "Core") {
    $windowsPowerShell = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
        throw "Windows PowerShell is required to sync the installed Codex desktop package: $windowsPowerShell"
    }
    $delegateArgs = @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath
    )
    if ($NoRestart) { $delegateArgs += "-NoRestart" }
    $delegateOutput = & $windowsPowerShell @delegateArgs
    $delegateExitCode = $LASTEXITCODE
    if ($delegateExitCode -ne 0) {
        throw "Windows PowerShell Anti-Codex sync exited with code $delegateExitCode."
    }
    $delegateOutput
    return
}

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC = if ($env:ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC) {
    [Math]::Max(1, [int]$env:ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC)
} elseif ($env:ANTICODEX_POSTSYNC_HEALTH_TIMEOUT_SEC) {
    [Math]::Max(1, [int]$env:ANTICODEX_POSTSYNC_HEALTH_TIMEOUT_SEC)
} else {
    8
}

$ANTICODEX_POST_SYNC_READY_TIMEOUT_SEC = if ($env:ANTICODEX_POST_SYNC_READY_TIMEOUT_SEC) {
    [Math]::Max(30, [int]$env:ANTICODEX_POST_SYNC_READY_TIMEOUT_SEC)
} else {
    180
}

$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRoot -ne $expectedRoot) {
    throw "Anti-Codex sync may only run from $expectedRoot"
}

$sourceRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $sourceRoot "scripts\install-anticodex.ps1"
$componentInstaller = Join-Path $sourceRoot "scripts\install-codexplusplus-component.ps1"
$sourcePreflight = Join-Path $sourceRoot "scripts\test-anticodex-source-preflight.ps1"
$validator = Join-Path $sourceRoot "scripts\test-anticodex-host-candidate.ps1"
$rollbackScript = Join-Path $sourceRoot "scripts\rollback-anticodex.ps1"
$baseUrlResolver = Join-Path $sourceRoot "scripts\resolve-anticodex-base-url.ps1"
$refreshLocalFeatures = Join-Path $sourceRoot "scripts\refresh-anticodex-local-features.ps1"
$refreshFeaturesDuringSync = [string]$env:ANTICODEX_REFRESH_LOCAL_FEATURES_DURING_SYNC -eq "1"
$postSyncVerifier = Join-Path $sourceRoot "scripts\test-anticodex-installed-overall.ps1"
$updateChecker = Join-Path $sourceRoot "scripts\check-anticodex-update.ps1"
$updateStatusModule = Join-Path $sourceRoot "scripts\anticodex-update-status.psm1"
foreach ($requiredScript in @($installer, $componentInstaller, $sourcePreflight, $validator, $rollbackScript, $baseUrlResolver, $refreshLocalFeatures, $postSyncVerifier, $updateChecker, $updateStatusModule)) {
    if (-not (Test-Path -LiteralPath $requiredScript)) {
        throw "Anti-Codex update component is missing: $requiredScript"
    }
}
Import-Module (Join-Path $PSScriptRoot "anticodex-update-status.psm1") -Force

$candidateRoot = Join-Path $installRoot "update-candidate"
$candidateHost = Join-Path $candidateRoot "codex-patched-app"
$candidateMarker = Join-Path $candidateRoot "codex-patched-app.ok"
$candidateComponent = Join-Path $candidateRoot "components\codexplusplus"
$activeHost = Join-Path $installRoot "codex-patched-app"
$activeMarker = Join-Path $installRoot "codex-patched-app.ok"
$activeComponent = Join-Path $installRoot "components\codexplusplus"
$rollbackHost = Join-Path $installRoot "rollback-host"
$rollbackMarker = Join-Path $installRoot "rollback-host.ok"
$rollbackComponent = Join-Path $installRoot "rollback-codexplusplus"
$startAntiCodex = Join-Path $sourceRoot "scripts\start-anticodex.ps1"
$hostSyncMarker = if ($env:ANTICODEX_HOST_SYNC_MARKER) {
    $env:ANTICODEX_HOST_SYNC_MARKER
} else {
    Join-Path (Join-Path $env:APPDATA "anticodex") "host-sync.lock"
}
$env:ANTICODEX_HOST_SYNC_MARKER = $hostSyncMarker
$stateRoot = if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }
$iconSource = Join-Path $sourceRoot "assets\anticodex.ico"

$global:LASTEXITCODE = 0
& $sourcePreflight -SkipFullRegression | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Anti-Codex source preflight failed. Sync was stopped before building an update candidate."
}

function Remove-FixedUpdateDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $allowed = @(
        [IO.Path]::GetFullPath($candidateRoot),
        [IO.Path]::GetFullPath($rollbackHost),
        [IO.Path]::GetFullPath($activeHost),
        [IO.Path]::GetFullPath($rollbackComponent),
        [IO.Path]::GetFullPath($activeComponent)
    )
    if ($fullPath -notin $allowed) {
        throw "Refusing to remove an unexpected Anti-Codex update directory: $fullPath"
    }
    $extendedPath = if ($fullPath.StartsWith("\\?\")) { $fullPath } else { "\\?\$fullPath" }
    if (-not [IO.Directory]::Exists($extendedPath)) {
        return
    }
    [IO.Directory]::Delete($extendedPath, $true)
}

function Move-FixedUpdateDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $fullSource = [IO.Path]::GetFullPath($Source)
    $fullDestination = [IO.Path]::GetFullPath($Destination)
    $allowed = @(
        [IO.Path]::GetFullPath($candidateHost),
        [IO.Path]::GetFullPath($rollbackHost),
        [IO.Path]::GetFullPath($activeHost),
        [IO.Path]::GetFullPath($candidateComponent),
        [IO.Path]::GetFullPath($rollbackComponent),
        [IO.Path]::GetFullPath($activeComponent)
    )
    if ($fullSource -notin $allowed -or $fullDestination -notin $allowed) {
        throw "Refusing to move an unexpected Anti-Codex update directory."
    }
    $extendedSource = "\\?\$fullSource"
    $extendedDestination = "\\?\$fullDestination"
    if (-not [IO.Directory]::Exists($extendedSource)) {
        throw "Anti-Codex update source is missing: $fullSource"
    }
    if ([IO.Directory]::Exists($extendedDestination)) {
        throw "Anti-Codex update destination already exists: $fullDestination"
    }
    [IO.Directory]::Move($extendedSource, $extendedDestination)
}

function Get-AntiCodexHostProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        try {
            return ([IO.Path]::GetFullPath([string]$_.ExecutablePath)).StartsWith(
                $activeHost,
                [StringComparison]::OrdinalIgnoreCase
            )
        } catch {
            return $false
        }
    })
}

function Wait-AntiCodexHostRelease {
    param([int]$TimeoutSeconds = 20)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $remaining = @(Get-AntiCodexHostProcesses)
        if ($remaining.Count -eq 0) { return $true }
        foreach ($process in $remaining) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return @(Get-AntiCodexHostProcesses).Count -eq 0
}

function Get-AntiCodexComponentProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        try {
            return ([IO.Path]::GetFullPath([string]$_.ExecutablePath)).StartsWith(
                $activeComponent,
                [StringComparison]::OrdinalIgnoreCase
            )
        } catch {
            return $false
        }
    })
}

function Wait-AntiCodexComponentRelease {
    param([int]$TimeoutSeconds = 20)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $remaining = @(Get-AntiCodexComponentProcesses)
        if ($remaining.Count -eq 0) { return $true }
        foreach ($process in $remaining) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return @(Get-AntiCodexComponentProcesses).Count -eq 0
}

function Test-AntiCodexComponent {
    param([Parameter(Mandatory = $true)][string]$ComponentRoot)

    $resolvedRoot = [IO.Path]::GetFullPath($ComponentRoot)
    $allowed = @($candidateComponent, $activeComponent, $rollbackComponent) | ForEach-Object { [IO.Path]::GetFullPath($_) }
    if ($resolvedRoot -notin $allowed) { throw "Refusing to validate an unexpected CodexPlusPlus component root." }
    $manifestPath = Join-Path $resolvedRoot "component-manifest.json"
    $metadataPath = Join-Path $resolvedRoot "upstream.json"
    $binaryPath = Join-Path $resolvedRoot "codex-plus-plus.exe"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $metadataPath -PathType Leaf) -or -not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
        throw "CodexPlusPlus component candidate is incomplete: $resolvedRoot"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$manifest.schema -ne "codexplusplus-component-manifest-v1" -or [string]$manifest.component -ne "CodexPlusPlus" -or [string]$manifest.license -ne "AGPL-3.0-only") {
        throw "CodexPlusPlus component identity or schema is invalid: $resolvedRoot"
    }
    $installedPatches = @($manifest.patches)
    $acceptedPatches = @($metadata.patches)
    if ($acceptedPatches.Count -eq 0 -or $installedPatches.Count -ne $acceptedPatches.Count) {
        throw "CodexPlusPlus component patch set does not match its upstream metadata: $resolvedRoot"
    }
    for ($index = 0; $index -lt $acceptedPatches.Count; $index++) {
        if ([string]$installedPatches[$index].file -ne [string]$acceptedPatches[$index].file -or
            ([string]$installedPatches[$index].sha256).ToLowerInvariant() -ne ([string]$acceptedPatches[$index].sha256).ToLowerInvariant()) {
            throw "CodexPlusPlus component patch set does not match its upstream metadata: $resolvedRoot"
        }
    }
    if ([string]$manifest.patchCommit -ne [string]$metadata.patchCommit) {
        throw "CodexPlusPlus component patch commit does not match its upstream metadata: $resolvedRoot"
    }
    $expectedHash = ([string]$manifest.binary.sha256).ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or $actualHash -ne $expectedHash) {
        throw "CodexPlusPlus component binary hash is invalid: $resolvedRoot"
    }
    return $manifest
}

function Stop-AntiCodexLaunchers {
    $escapedStartScript = [regex]::Escape($startAntiCodex)
    $launchers = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and
        ([string]$_.CommandLine) -match $escapedStartScript
    })
    foreach ($launcher in $launchers) {
        Stop-Process -Id $launcher.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Start-AntiCodexAfterSync {
    param([Parameter(Mandatory = $true)][string]$StartScript)

    $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    try {
        Start-Process -FilePath $powershell `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $StartScript, "-InlineSupervisor") `
            -WindowStyle Hidden -ErrorAction Stop | Out-Null
        return
    } catch {
        Write-Warning "Background PowerShell restart was denied: $($_.Exception.Message)"
        Write-Warning "Retrying Anti-Codex restart through cmd.exe start fallback."
    }

    $cmdArgs = @(
        "/d", "/c", "start", '""', "/min",
        "powershell.exe",
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", "`"$StartScript`"", "-InlineSupervisor"
    )
    & cmd.exe @cmdArgs
    if ($LASTEXITCODE -ne 0) {
        throw "cmd fallback could not restart Anti-Codex (exit code $LASTEXITCODE)."
    }
}

function Wait-AntiCodexPostSyncReady {
    param([int]$TimeoutSeconds = 60)

    $baseUrl = if ($env:TRANSLATOR_URL) { [string]$env:TRANSLATOR_URL } else { [string](& $baseUrlResolver) }
    $mainExecutable = [IO.Path]::GetFullPath((Join-Path $activeHost "Anti-Codex.exe"))
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $mainReady = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            if (-not $_.ExecutablePath -or ([string]$_.CommandLine) -match "\s--type=") { return $false }
            try { return ([IO.Path]::GetFullPath([string]$_.ExecutablePath)) -eq $mainExecutable } catch { return $false }
        }).Count -gt 0
        $gatewayReady = $false
        try {
            $health = Invoke-RestMethod -Uri "$baseUrl/health" -Proxy $null -TimeoutSec $ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC
            $gatewayReady = $health.ok -eq $true
        } catch {}
        if ($mainReady -and $gatewayReady) { return $true }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Wait-AntiCodexChildProcess {
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

function Invoke-AntiCodexPostSyncAcceptance {
    param([int]$TimeoutSeconds = 35)

    $baseUrl = if ($env:TRANSLATOR_URL) { [string]$env:TRANSLATOR_URL } else { [string](& $baseUrlResolver) }
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(5, $TimeoutSeconds))
    $lastFailure = "post-sync acceptance has not started"
    do {
        try {
            $marker = Get-Content -LiteralPath $activeMarker -Raw | ConvertFrom-Json
            $health = Invoke-RestMethod -Uri "$baseUrl/health" -Proxy $null -TimeoutSec $ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC
            $models = Invoke-RestMethod -Uri "$baseUrl/models" -Proxy $null -TimeoutSec $ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC
            $sourceVersion = [string]$marker.source.packageVersion
            $modelCount = @($models.data).Count
            $provider = [string]$health.provider
            $expectedUpstream = if ($provider -eq "antigravity") {
                "antigravity-desktop"
            } elseif ($provider -eq "third-party") {
                "codexplusplus-third-party"
            } else {
                ""
            }
            $upstreamReady = $expectedUpstream -and [string]$health.upstream -eq $expectedUpstream
            $routeReady = $health.routeReady -eq $true
            if ($health.ok -eq $true -and $routeReady -and $modelCount -gt 0 -and $upstreamReady -and $sourceVersion) {
                return [pscustomobject]@{
                    ok = $true
                    message = "Post-sync acceptance passed: active host $sourceVersion, $modelCount model(s), provider $provider ready."
                }
            }
            $lastFailure = "healthOk=$($health.ok), routeReady=$routeReady, provider=$provider, upstream=$($health.upstream), expectedUpstream=$expectedUpstream, modelCount=$modelCount, sourceVersion=$sourceVersion"
        } catch {
            $lastFailure = $_.Exception.Message
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)

    return [pscustomobject]@{ ok = $false; message = "Post-sync acceptance timed out after $TimeoutSeconds seconds: $lastFailure" }
}

function Repair-RollbackHostIconManifest {
    if (-not ([IO.Directory]::Exists("\\?\$rollbackHost")) -or -not ([IO.File]::Exists($rollbackMarker))) {
        return
    }
    if (-not (Test-Path -LiteralPath $iconSource -PathType Leaf)) {
        throw "Anti-Codex icon asset is missing: $iconSource"
    }

    $rollbackResourceIcon = Join-Path $rollbackHost "resources\icon.ico"
    $rollbackTrayIcon = Join-Path $rollbackHost "resources\codex-tray.ico"
    $rollbackAppRootIcon = Join-Path $rollbackHost "icon.ico"
    $rollbackResourceDir = Split-Path -Parent $rollbackResourceIcon
    if (-not (Test-Path -LiteralPath $rollbackResourceDir -PathType Container)) {
        throw "Anti-Codex rollback host resources directory is missing: $rollbackResourceDir"
    }
    Copy-Item -LiteralPath $iconSource -Destination $rollbackResourceIcon -Force
    Copy-Item -LiteralPath $iconSource -Destination $rollbackTrayIcon -Force
    Copy-Item -LiteralPath $iconSource -Destination $rollbackAppRootIcon -Force

    $manifest = Get-Content -LiteralPath $rollbackMarker -Raw | ConvertFrom-Json
    if ([string]$manifest.schema -notin @("anticodex-host-manifest-v1", "anticodex-host-manifest-v2")) {
        throw "Anti-Codex rollback host marker schema is invalid."
    }
    if (-not $manifest.files) {
        throw "Anti-Codex rollback host marker is missing file hashes."
    }
    $manifest.files | Add-Member -NotePropertyName hostIcon -NotePropertyValue (Get-FileHash -LiteralPath $rollbackResourceIcon -Algorithm SHA256).Hash -Force
    $manifest.files | Add-Member -NotePropertyName trayIcon -NotePropertyValue (Get-FileHash -LiteralPath $rollbackTrayIcon -Algorithm SHA256).Hash -Force
    $manifest.files | Add-Member -NotePropertyName appRootIcon -NotePropertyValue (Get-FileHash -LiteralPath $rollbackAppRootIcon -Algorithm SHA256).Hash -Force
    $temporaryMarker = "$rollbackMarker.tmp"
    Remove-Item -LiteralPath $temporaryMarker -Force -ErrorAction SilentlyContinue
    $json = $manifest | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($temporaryMarker, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryMarker -Destination $rollbackMarker -Force
}

$syncMutex = New-Object Threading.Mutex($false, "Local\AntiCodexHostSync")
if (-not $syncMutex.WaitOne(0)) {
    $syncMutex.Dispose()
    throw "Another Anti-Codex sync is already running."
}

$syncError = $null
$syncCompleted = $false
$restartAfterSync = $false
$rollbackAvailable = $false
$activationRestored = $false
$updateStage = "candidate_build"
try {
    try {
        Set-AntiCodexUpdateOperation -State "running" -Stage "candidate_build" -Message "Building a candidate from the installed Codex version." -StateRoot $stateRoot
        Remove-FixedUpdateDirectory -Path $candidateRoot

        $global:LASTEXITCODE = 0
        & $installer -InstallTarget $candidateRoot -HostOnly
        if ($LASTEXITCODE -ne 0) {
            throw "Anti-Codex candidate build failed. The active host was not changed."
        }

        $updateStage = "component_candidate"
        Set-AntiCodexUpdateOperation -State "running" -Stage "component_candidate" -Message "Staging the verified CodexPlusPlus component before activation." -StateRoot $stateRoot
        $global:LASTEXITCODE = 0
        & $componentInstaller -InstallRoot $candidateRoot | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "CodexPlusPlus candidate staging failed. The active release was not changed."
        }
        Test-AntiCodexComponent -ComponentRoot $candidateComponent | Out-Null

        $updateStage = "candidate_validation"
        Set-AntiCodexUpdateOperation -State "running" -Stage "candidate_validation" -Message "Validating the copied Codex host and CodexPlusPlus candidate before activation." -StateRoot $stateRoot
        $global:LASTEXITCODE = 0
        & $validator -CandidateRoot $candidateRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Candidate validation failed. The active host was not changed."
        }

        $updateStage = "stopping_host"
        Set-AntiCodexUpdateOperation -State "running" -Stage "stopping_host" -Message "Stopping Anti-Codex before activating both release components." -StateRoot $stateRoot
        New-Item -ItemType Directory -Path (Split-Path -Parent $hostSyncMarker) -Force | Out-Null
        "Host sync marker $(Get-Date -Format o)" | Set-Content -LiteralPath $hostSyncMarker -Encoding ASCII
        Write-Host "Host sync marker created; stopping Anti-Codex before activation."
        $restartAfterSync = $true

        Stop-AntiCodexLaunchers
        if (-not (Wait-AntiCodexHostRelease -TimeoutSeconds 20)) {
            throw "Anti-Codex host processes did not exit before the sync timeout. The active host was not changed."
        }
        if (-not (Wait-AntiCodexComponentRelease -TimeoutSeconds 20)) {
            throw "CodexPlusPlus processes did not exit before the sync timeout. The active release was not changed."
        }

        $activationStarted = $false
        $activeHostChanged = $false
        $activeComponentChanged = $false
        $rollbackHostAvailable = $false
        $rollbackComponentAvailable = $false
        $updateStage = "activation"
        Set-AntiCodexUpdateOperation -State "running" -Stage "activation" -Message "Activating the validated copied Codex host and CodexPlusPlus component." -StateRoot $stateRoot
        try {
            Remove-FixedUpdateDirectory -Path $rollbackHost
            Remove-FixedUpdateDirectory -Path $rollbackComponent
            Remove-Item -LiteralPath $rollbackMarker -Force -ErrorAction SilentlyContinue

            $activeHostExists = [IO.Directory]::Exists("\\?\$activeHost")
            $activeComponentExists = [IO.Directory]::Exists("\\?\$activeComponent")
            if ($activeHostExists -ne $activeComponentExists) {
                throw "Active Anti-Codex host/component state is incomplete; activation was refused."
            }

            if ($activeHostExists) {
                Move-FixedUpdateDirectory -Source $activeHost -Destination $rollbackHost
                $rollbackHostAvailable = $true
                $activationStarted = $true
            }
            if ([IO.File]::Exists($activeMarker)) {
                [IO.File]::Move($activeMarker, $rollbackMarker)
            }
            if ($activeComponentExists) {
                Move-FixedUpdateDirectory -Source $activeComponent -Destination $rollbackComponent
                $rollbackComponentAvailable = $true
                $activationStarted = $true
            }
            $rollbackAvailable = $rollbackHostAvailable -and $rollbackComponentAvailable

            Move-FixedUpdateDirectory -Source $candidateHost -Destination $activeHost
            $activeHostChanged = $true
            $activationStarted = $true
            [IO.File]::Move($candidateMarker, $activeMarker)
            Move-FixedUpdateDirectory -Source $candidateComponent -Destination $activeComponent
            $activeComponentChanged = $true
            Test-AntiCodexComponent -ComponentRoot $activeComponent | Out-Null
            Repair-RollbackHostIconManifest
            Remove-FixedUpdateDirectory -Path $candidateRoot
            $syncCompleted = $true
        } catch {
            $activationError = $_.Exception.Message
            if ($activationStarted) {
                try {
                    if ($activeHostChanged) {
                        Remove-FixedUpdateDirectory -Path $activeHost
                    }
                    if ($activeComponentChanged) {
                        Remove-FixedUpdateDirectory -Path $activeComponent
                    }
                    Remove-Item -LiteralPath $activeMarker -Force -ErrorAction SilentlyContinue
                    if ($rollbackHostAvailable) {
                        Move-FixedUpdateDirectory -Source $rollbackHost -Destination $activeHost
                        if ([IO.File]::Exists($rollbackMarker)) {
                            [IO.File]::Move($rollbackMarker, $activeMarker)
                        }
                    }
                    if ($rollbackComponentAvailable) {
                        Move-FixedUpdateDirectory -Source $rollbackComponent -Destination $activeComponent
                    }
                } catch {
                    $recoveryState = if ($rollbackAvailable) { "the previous host and component were preserved" } else { "a complete previous release was not available" }
                    throw "Anti-Codex activation failed. Automatic recovery also failed; ${recoveryState}: $activationError; recovery error: $($_.Exception.Message)"
                }
                if ($rollbackAvailable) {
                    $activationRestored = $true
                    throw "Anti-Codex activation failed and the previous host/component release was restored: $activationError"
                }
                throw "Anti-Codex activation failed and the incomplete first-install release was removed: $activationError"
            }
            throw "Anti-Codex activation failed before the active release was changed: $activationError"
        }
    } catch {
        $syncError = $_
    }
} finally {
    Remove-Item -LiteralPath $hostSyncMarker -Force -ErrorAction SilentlyContinue
}

if ($syncError) {
    if ($activationRestored) {
        Set-AntiCodexUpdateOperation -State "rolled_back" -Stage "activation" -Message $syncError.Exception.Message -RollbackAvailable $true -StateRoot $stateRoot
    } else {
        Set-AntiCodexUpdateOperation -State "failed" -Stage $updateStage -Message $syncError.Exception.Message -FailureCode "sync_failed" -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
    }
    $syncMutex.ReleaseMutex()
    $syncMutex.Dispose()
    throw $syncError
}

try {
if ($syncCompleted -and $refreshFeaturesDuringSync) {
    $updateStage = "feature_refresh"
    Set-AntiCodexUpdateOperation -State "running" -Stage "feature_refresh" -Message "Refreshing Anti-Codex local features." -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
    try {
        $global:LASTEXITCODE = 0
        & $refreshLocalFeatures | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Anti-Codex host sync succeeded, but the local feature snapshot refresh needs a later Manager retry."
        }
    } catch {
        Write-Warning "Anti-Codex host sync succeeded, but the local feature snapshot refresh needs a later Manager retry: $($_.Exception.Message)"
    }
} elseif ($syncCompleted) {
    Write-Warning "Anti-Codex core release sync succeeded; local feature snapshots were left unchanged. Use the Manager refresh action when those snapshots need maintenance."
}

if (-not $NoRestart) {
    if ($restartAfterSync -and (Test-Path -LiteralPath $startAntiCodex)) {
        $updateStage = "restart"
        Set-AntiCodexUpdateOperation -State "running" -Stage "restart" -Message "Restarting Anti-Codex with the synced host." -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
        Start-AntiCodexAfterSync -StartScript $startAntiCodex
    }
}

if ($syncCompleted) {
    $updateStage = "acceptance"
    if ($NoRestart) {
        Set-AntiCodexUpdateOperation -State "running" -Stage "acceptance" -Message "Validating the synced host without starting Anti-Codex." -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
        $offlineStatus = & $updateChecker -InstallRoot $installRoot -StateRoot $stateRoot -NoPersist | ConvertFrom-Json
        $postSyncReady = $offlineStatus.ok -eq $true -and $offlineStatus.updateNeeded -eq $false
        $postSyncAcceptance = [pscustomobject]@{
            ok = $postSyncReady
            mode = "synced_without_restart"
            message = if ($postSyncReady) { "Synced host passed offline fingerprint and guardrail checks." } else { "Synced host failed offline fingerprint or guardrail checks." }
        }
    } else {
        Set-AntiCodexUpdateOperation -State "running" -Stage "acceptance" -Message "Running post-sync readiness and compatibility checks." -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
        $postSyncReady = Wait-AntiCodexPostSyncReady -TimeoutSeconds $ANTICODEX_POST_SYNC_READY_TIMEOUT_SEC
        $postSyncAcceptance = if ($postSyncReady) {
            Invoke-AntiCodexPostSyncAcceptance -TimeoutSeconds 35
        } else {
            [pscustomobject]@{ ok = $false; message = "The synced Anti-Codex host did not become ready." }
        }
    }
}

if ($syncCompleted -and (-not $postSyncReady -or $postSyncAcceptance.ok -ne $true)) {
    $rollbackFailure = $null
    $failureReason = [string]$postSyncAcceptance.message
    try {
        $global:LASTEXITCODE = 0
        & $rollbackScript
        if ($LASTEXITCODE -ne 0) {
            throw "rollback exited with code $LASTEXITCODE"
        }
    } catch {
        $rollbackFailure = $_.Exception.Message
    }
    if ($rollbackFailure) {
        throw "$failureReason Automatic rollback also failed: $rollbackFailure"
    }
    Set-AntiCodexUpdateOperation -State "rolled_back" -Stage "acceptance" -Message "$failureReason Automatic rollback restored the previous host." -RollbackAvailable $true -StateRoot $stateRoot
    throw "$failureReason Automatic rollback restored the previous host."
}

if ($syncCompleted) {
    try {
        & $updateChecker -InstallRoot $installRoot -StateRoot $stateRoot | Out-Null
    } catch {
        Write-Warning "Anti-Codex sync succeeded, but the update fingerprint refresh needs a later Manager retry: $($_.Exception.Message)"
    }
    $completionMessage = if ($NoRestart) {
        "Anti-Codex is synced with the installed Codex version and will use it on the next launch."
    } else {
        "Anti-Codex is synced with the installed Codex version."
    }
    Set-AntiCodexUpdateOperation -State "succeeded" -Stage "complete" -Message $completionMessage -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
    if ($NoRestart) {
        Write-Host $completionMessage
    } else {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup(
            "Anti-Codex passed compatibility checks and is now synced with the installed Codex version. The previous host is available for rollback.",
            8,
            "Anti-Codex Sync Complete",
            64
        ) | Out-Null
    }
}
} catch {
    $terminalStatus = Get-AntiCodexUpdateStatus -StateRoot $stateRoot
    if ($terminalStatus.operation.state -ne "rolled_back") {
        Set-AntiCodexUpdateOperation -State "failed" -Stage $updateStage -Message $_.Exception.Message -FailureCode "sync_failed" -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
    }
    throw
} finally {
    $syncMutex.ReleaseMutex()
    $syncMutex.Dispose()
}
