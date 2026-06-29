#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC = if ($env:ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC) {
    [Math]::Max(1, [int]$env:ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC)
} elseif ($env:ANTICODEX_POSTSYNC_HEALTH_TIMEOUT_SEC) {
    [Math]::Max(1, [int]$env:ANTICODEX_POSTSYNC_HEALTH_TIMEOUT_SEC)
} else {
    8
}

$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRoot -ne $expectedRoot) {
    throw "Anti-Codex sync may only run from $expectedRoot"
}

$sourceRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $sourceRoot "scripts\install-anticodex.ps1"
$sourcePreflight = Join-Path $sourceRoot "scripts\test-anticodex-source-preflight.ps1"
$validator = Join-Path $sourceRoot "scripts\test-anticodex-host-candidate.ps1"
$rollbackScript = Join-Path $sourceRoot "scripts\rollback-anticodex.ps1"
$baseUrlResolver = Join-Path $sourceRoot "scripts\resolve-anticodex-base-url.ps1"
$refreshLocalFeatures = Join-Path $sourceRoot "scripts\refresh-anticodex-local-features.ps1"
$postSyncVerifier = Join-Path $sourceRoot "scripts\test-anticodex-installed-overall.ps1"
$updateChecker = Join-Path $sourceRoot "scripts\check-anticodex-update.ps1"
$updateStatusModule = Join-Path $sourceRoot "scripts\anticodex-update-status.psm1"
foreach ($requiredScript in @($installer, $sourcePreflight, $validator, $rollbackScript, $baseUrlResolver, $refreshLocalFeatures, $postSyncVerifier, $updateChecker, $updateStatusModule)) {
    if (-not (Test-Path -LiteralPath $requiredScript)) {
        throw "Anti-Codex update component is missing: $requiredScript"
    }
}
Import-Module (Join-Path $PSScriptRoot "anticodex-update-status.psm1") -Force

$candidateRoot = Join-Path $installRoot "update-candidate"
$candidateHost = Join-Path $candidateRoot "codex-patched-app"
$candidateMarker = Join-Path $candidateRoot "codex-patched-app.ok"
$activeHost = Join-Path $installRoot "codex-patched-app"
$activeMarker = Join-Path $installRoot "codex-patched-app.ok"
$rollbackHost = Join-Path $installRoot "rollback-host"
$rollbackMarker = Join-Path $installRoot "rollback-host.ok"
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
        [IO.Path]::GetFullPath($activeHost)
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
        [IO.Path]::GetFullPath($activeHost)
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
            $sourceVersion = [string]$marker.source.packageVersion
            $modelCount = [int]$health.modelCount
            $upstreamReady = [string]$health.upstream -eq "antigravity-desktop"
            if ($health.ok -eq $true -and $modelCount -gt 0 -and $upstreamReady -and $sourceVersion) {
                return [pscustomobject]@{
                    ok = $true
                    message = "Post-sync acceptance passed: active host $sourceVersion, $modelCount model(s), Antigravity gateway ready."
                }
            }
            $lastFailure = "healthOk=$($health.ok), upstream=$($health.upstream), modelCount=$modelCount, sourceVersion=$sourceVersion"
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
    if ($manifest.schema -ne "anticodex-host-manifest-v1") {
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
        $updateStage = "candidate_validation"
        Set-AntiCodexUpdateOperation -State "running" -Stage "candidate_validation" -Message "Validating the candidate before activation." -StateRoot $stateRoot
        $global:LASTEXITCODE = 0
        & $validator -CandidateRoot $candidateRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Candidate validation failed. The active host was not changed."
        }

        $updateStage = "stopping_host"
        Set-AntiCodexUpdateOperation -State "running" -Stage "stopping_host" -Message "Stopping Anti-Codex before activation." -StateRoot $stateRoot
        New-Item -ItemType Directory -Path (Split-Path -Parent $hostSyncMarker) -Force | Out-Null
        "Host sync marker $(Get-Date -Format o)" | Set-Content -LiteralPath $hostSyncMarker -Encoding ASCII
        Write-Host "Host sync marker created; stopping Anti-Codex before activation."
        $restartAfterSync = $true

        Stop-AntiCodexLaunchers
        if (-not (Wait-AntiCodexHostRelease -TimeoutSeconds 20)) {
            throw "Anti-Codex host processes did not exit before the sync timeout. The active host was not changed."
        }

        $activationStarted = $false
        $activeHostChanged = $false
        $updateStage = "activation"
        Set-AntiCodexUpdateOperation -State "running" -Stage "activation" -Message "Activating the validated candidate." -StateRoot $stateRoot
        try {
            Remove-FixedUpdateDirectory -Path $rollbackHost
            Remove-Item -LiteralPath $rollbackMarker -Force -ErrorAction SilentlyContinue

            if ([IO.Directory]::Exists("\\?\$activeHost")) {
                Move-FixedUpdateDirectory -Source $activeHost -Destination $rollbackHost
                $rollbackAvailable = $true
                $activationStarted = $true
            }
            if ([IO.File]::Exists($activeMarker)) {
                [IO.File]::Move($activeMarker, $rollbackMarker)
            }

            Move-FixedUpdateDirectory -Source $candidateHost -Destination $activeHost
            $activeHostChanged = $true
            $activationStarted = $true
            [IO.File]::Move($candidateMarker, $activeMarker)
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
                    Remove-Item -LiteralPath $activeMarker -Force -ErrorAction SilentlyContinue
                    if ($rollbackAvailable) {
                        Move-FixedUpdateDirectory -Source $rollbackHost -Destination $activeHost
                        if ([IO.File]::Exists($rollbackMarker)) {
                            [IO.File]::Move($rollbackMarker, $activeMarker)
                        }
                    }
                } catch {
                    $recoveryState = if ($rollbackAvailable) { "the rollback host was preserved" } else { "there was no previous host to restore" }
                    throw "Anti-Codex activation failed. Automatic recovery also failed; ${recoveryState}: $activationError; recovery error: $($_.Exception.Message)"
                }
                if ($rollbackAvailable) {
                    $activationRestored = $true
                    throw "Anti-Codex activation failed and the previous host was restored: $activationError"
                }
                throw "Anti-Codex activation failed and the incomplete first-install host was removed: $activationError"
            }
            throw "Anti-Codex activation failed before the active host was changed: $activationError"
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
if ($syncCompleted) {
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
}

if ($restartAfterSync -and (Test-Path -LiteralPath $startAntiCodex)) {
    $updateStage = "restart"
    Set-AntiCodexUpdateOperation -State "running" -Stage "restart" -Message "Restarting Anti-Codex with the synced host." -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
    $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    Start-Process -FilePath $powershell `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startAntiCodex) `
        -WindowStyle Hidden | Out-Null
}

if ($syncCompleted) {
    $updateStage = "acceptance"
    Set-AntiCodexUpdateOperation -State "running" -Stage "acceptance" -Message "Running post-sync readiness and compatibility checks." -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
    $postSyncReady = Wait-AntiCodexPostSyncReady -TimeoutSeconds 60
    $postSyncAcceptance = if ($postSyncReady) {
        Invoke-AntiCodexPostSyncAcceptance -TimeoutSeconds 35
    } else {
        [pscustomobject]@{ ok = $false; message = "The synced Anti-Codex host did not become ready." }
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
    Set-AntiCodexUpdateOperation -State "succeeded" -Stage "complete" -Message "Anti-Codex is synced with the installed Codex version." -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
    $shell = New-Object -ComObject WScript.Shell
    $shell.Popup(
        "Anti-Codex passed compatibility checks and is now synced with the installed Codex version. The previous host is available for rollback.",
        8,
        "Anti-Codex Sync Complete",
        64
    ) | Out-Null
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
