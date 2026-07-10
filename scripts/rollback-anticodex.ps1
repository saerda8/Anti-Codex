#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$RecoveryAttempt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRoot -ne $expectedRoot) { throw "Anti-Codex rollback may only run from $expectedRoot" }

$sourceRoot = Split-Path -Parent $PSScriptRoot
$updateStatusModule = Join-Path $sourceRoot "scripts\anticodex-update-status.psm1"
if (-not (Test-Path -LiteralPath $updateStatusModule -PathType Leaf)) { throw "Anti-Codex update status module is missing: $updateStatusModule" }
Import-Module (Join-Path $PSScriptRoot "anticodex-update-status.psm1") -Force
$activeHost = Join-Path $installRoot "codex-patched-app"
$activeMarker = Join-Path $installRoot "codex-patched-app.ok"
$rollbackHost = Join-Path $installRoot "rollback-host"
$rollbackMarker = Join-Path $installRoot "rollback-host.ok"
$swapHost = Join-Path $installRoot "rollback-swap-host"
$swapMarker = Join-Path $installRoot "rollback-swap-host.ok"
$startAntiCodex = Join-Path $sourceRoot "scripts\start-anticodex.ps1"
$baseUrlResolver = Join-Path $sourceRoot "scripts\resolve-anticodex-base-url.ps1"
$hostSyncMarker = if ($env:ANTICODEX_HOST_SYNC_MARKER) { $env:ANTICODEX_HOST_SYNC_MARKER } else { Join-Path (Join-Path $env:APPDATA "anticodex") "host-sync.lock" }
$env:ANTICODEX_HOST_SYNC_MARKER = $hostSyncMarker
$stateRoot = if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }

function Assert-FixedHostPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $allowed = @($activeHost, $rollbackHost, $swapHost) | ForEach-Object { [IO.Path]::GetFullPath($_) }
    if ($fullPath -notin $allowed) { throw "Refusing to modify an unexpected Anti-Codex host path: $fullPath" }
    return $fullPath
}

function Move-FixedHostDirectory {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    $fullSource = Assert-FixedHostPath $Source
    $fullDestination = Assert-FixedHostPath $Destination
    if (-not [IO.Directory]::Exists("\\?\$fullSource")) { throw "Anti-Codex host source is missing: $fullSource" }
    if ([IO.Directory]::Exists("\\?\$fullDestination")) { throw "Anti-Codex host destination already exists: $fullDestination" }
    [IO.Directory]::Move("\\?\$fullSource", "\\?\$fullDestination")
}

function Move-FixedMarker {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    $allowed = @($activeMarker, $rollbackMarker, $swapMarker) | ForEach-Object { [IO.Path]::GetFullPath($_) }
    $fullSource = [IO.Path]::GetFullPath($Source)
    $fullDestination = [IO.Path]::GetFullPath($Destination)
    if ($fullSource -notin $allowed -or $fullDestination -notin $allowed) { throw "Refusing to move an unexpected Anti-Codex host marker." }
    if (-not [IO.File]::Exists($fullSource)) { throw "Anti-Codex host marker is missing: $fullSource" }
    if ([IO.File]::Exists($fullDestination)) { throw "Anti-Codex host marker destination already exists: $fullDestination" }
    [IO.File]::Move($fullSource, $fullDestination)
}

function Test-AntiCodexIconPalette {
    param([Parameter(Mandatory = $true)][string]$Path)

    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 22 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0 -or [BitConverter]::ToUInt16($bytes, 2) -ne 1) {
        throw "Anti-Codex icon is not a valid ICO: $Path"
    }
    $count = [BitConverter]::ToUInt16($bytes, 4)
    $best = $null
    for ($i = 0; $i -lt $count; $i += 1) {
        $entry = 6 + ($i * 16)
        $width = [int]$bytes[$entry]
        if ($width -eq 0) { $width = 256 }
        $size = [int][BitConverter]::ToUInt32($bytes, $entry + 8)
        $offset = [int][BitConverter]::ToUInt32($bytes, $entry + 12)
        if ($null -eq $best -or $width -gt $best.Width) {
            $best = [pscustomobject]@{ Width = $width; Size = $size; Offset = $offset }
        }
    }
    if ($null -eq $best -or $best.Offset -lt 0 -or ($best.Offset + $best.Size) -gt $bytes.Length) {
        throw "Anti-Codex icon has an invalid ICO frame table: $Path"
    }

    $frame = New-Object byte[] $best.Size
    [Array]::Copy($bytes, $best.Offset, $frame, 0, $best.Size)
    $stream = New-Object IO.MemoryStream(,$frame)
    $image = [System.Drawing.Image]::FromStream($stream)
    $bitmap = New-Object System.Drawing.Bitmap $image
    try {
        $pinkBlob = 0
        $whiteCommand = 0
        $tealBackground = 0
        $originalBluePurple = 0
        $transparent = 0
        for ($y = 0; $y -lt $bitmap.Height; $y += 8) {
            for ($x = 0; $x -lt $bitmap.Width; $x += 8) {
                $pixel = $bitmap.GetPixel($x, $y)
                if ($pixel.A -lt 10) {
                    $transparent += 1
                    continue
                }
                if ($pixel.R -gt 205 -and $pixel.B -gt 135 -and $pixel.G -lt 165) { $pinkBlob += 1 }
                if ($pixel.R -gt 230 -and $pixel.G -gt 230 -and $pixel.B -gt 230) { $whiteCommand += 1 }
                if ($pixel.R -ge 30 -and $pixel.R -le 95 -and $pixel.G -ge 105 -and $pixel.G -le 170 -and $pixel.B -ge 120 -and $pixel.B -le 180) { $tealBackground += 1 }
                if ($pixel.B -gt 185 -and $pixel.R -lt 190 -and $pixel.G -lt 185) { $originalBluePurple += 1 }
            }
        }
        return ($pinkBlob -ge 120 -and $whiteCommand -ge 10 -and $transparent -ge 100 -and $tealBackground -le 3 -and $originalBluePurple -le 10)
    } finally {
        $bitmap.Dispose()
        $image.Dispose()
        $stream.Dispose()
    }
}

function Test-AntiCodexAsarPatches {
    param([Parameter(Mandatory = $true)][string]$Path)

    $text = [System.Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($Path))
    $requiredMarkers = @(
        '.app.name=`Anti-Codex`',
        "AntiCodex",
        'authMethod:`apikey`',
        "requiresAuth:!1",
        'icon:`icon.ico`',
        "marketplaces:[]",
        "marketplaceLoadErrors:[]",
        "listPlugins({})"
    )
    foreach ($marker in $requiredMarkers) {
        if (-not $text.Contains($marker)) {
            throw "Anti-Codex host app.asar is missing actual patch marker: $marker"
        }
    }
}

function Test-AntiCodexHost {
    param([Parameter(Mandatory = $true)][string]$HostRoot, [Parameter(Mandatory = $true)][string]$MarkerPath)
    $hostRootFull = Assert-FixedHostPath $HostRoot
    $expectedCriticalPatches = @(
        "package-json",
        "webview-html-title",
        "app-name",
        "app-user-model-id",
        "session-title",
        "auth-requirement",
        "app-route-gate",
        "profile-dropdown-settings",
        "browser-window-icon",
        "local-model-availability",
        "local-plugin-catalog",
        "electron-local-plugin-catalog",
        "webview-local-plugin-catalog"
    )
    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) { throw "Anti-Codex host marker is missing: $MarkerPath" }
    $manifest = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne "anticodex-host-manifest-v1") { throw "Anti-Codex host marker schema is invalid: $MarkerPath" }

    $detectedDesktopHost = $null
    foreach ($hostName in @("ChatGPT.exe", "Codex.exe")) {
        if (Test-Path -LiteralPath (Join-Path $hostRootFull $hostName) -PathType Leaf) {
            $detectedDesktopHost = $hostName
            break
        }
    }
    if (-not $detectedDesktopHost) {
        throw "Anti-Codex host is missing a desktop host executable (ChatGPT.exe or Codex.exe)."
    }

    $required = [ordered]@{
        antiCodexExe = (Join-Path $hostRootFull "Anti-Codex.exe")
        codexHost = (Join-Path $hostRootFull $detectedDesktopHost)
        appAsar = (Join-Path $hostRootFull "resources\app.asar")
        codexCli = (Join-Path $hostRootFull "resources\codex.exe")
        hostIcon = (Join-Path $hostRootFull "resources\icon.ico")
        trayIcon = (Join-Path $hostRootFull "resources\codex-tray.ico")
        appRootIcon = (Join-Path $hostRootFull "icon.ico")
    }
    foreach ($path in $required.Values) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Anti-Codex host is incomplete: $path" }
    }
    $recordedCriticalPatches = @($manifest.criticalPatches)
    if (($recordedCriticalPatches.Count -ne $expectedCriticalPatches.Count) -or
        (@($expectedCriticalPatches | Where-Object { $_ -notin $recordedCriticalPatches }).Count -gt 0)) {
        throw "Anti-Codex host marker is missing critical compatibility patches."
    }
    Test-AntiCodexAsarPatches -Path $required.appAsar
    foreach ($name in @("antiCodexExe", "appAsar", "codexCli", "hostIcon", "trayIcon", "appRootIcon")) {
        $actual = (Get-FileHash -LiteralPath $required[$name] -Algorithm SHA256).Hash
        if ([string]$manifest.files.$name -ne [string]$actual) { throw "Anti-Codex host marker hash mismatch: $name" }
    }
    if (-not $manifest.source -or -not $manifest.source.codexHost -or -not $manifest.source.codexCli) {
        throw "Anti-Codex host marker is missing source Codex fingerprints."
    }
    if ([string]$manifest.source.codexHost -ne [string](Get-FileHash -LiteralPath $required.codexHost -Algorithm SHA256).Hash) {
        throw "Anti-Codex host source fingerprint mismatch: codexHost"
    }
    if ([string]$manifest.source.codexCli -ne [string](Get-FileHash -LiteralPath $required.codexCli -Algorithm SHA256).Hash) {
        throw "Anti-Codex host source fingerprint mismatch: codexCli"
    }
    foreach ($iconPath in @($required.hostIcon, $required.trayIcon, $required.appRootIcon)) {
        if ((Test-AntiCodexIconPalette -Path $iconPath) -ne $true) {
            throw "Anti-Codex host icon is not the Anti-Codex tray/icon artwork: $iconPath"
        }
    }
    $versionInfo = (Get-Item -LiteralPath $required.antiCodexExe).VersionInfo
    if ([string]$versionInfo.ProductName -ne "Anti-Codex") { throw "Anti-Codex host ProductName is invalid." }
    if ([string]$versionInfo.FileDescription -ne "Anti-Codex") { throw "Anti-Codex host FileDescription is invalid." }
    if ([string]$versionInfo.OriginalFilename -ne "Anti-Codex.exe") { throw "Anti-Codex host OriginalFilename is invalid." }
}

function Get-AntiCodexHostProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        try { return ([IO.Path]::GetFullPath([string]$_.ExecutablePath)).StartsWith($activeHost, [StringComparison]::OrdinalIgnoreCase) } catch { return $false }
    })
}

function Wait-AntiCodexHostRelease {
    param([int]$TimeoutSeconds = 20)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $remaining = @(Get-AntiCodexHostProcesses)
        if ($remaining.Count -eq 0) { return $true }
        foreach ($process in $remaining) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return @(Get-AntiCodexHostProcesses).Count -eq 0
}

function Stop-AntiCodexLaunchers {
    $escapedStartScript = [regex]::Escape($startAntiCodex)
    $launchers = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and ([string]$_.CommandLine) -match $escapedStartScript })
    foreach ($launcher in $launchers) { Stop-Process -Id $launcher.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-AntiCodexDetached {
    if (-not (Test-Path -LiteralPath $startAntiCodex -PathType Leaf)) {
        throw "Anti-Codex start script is missing after rollback: $startAntiCodex"
    }
    $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    Start-Process -FilePath $powershell -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startAntiCodex) -WindowStyle Hidden | Out-Null
}

function Wait-AntiCodexPostRollbackReady {
    param([int]$TimeoutSeconds = 90)

    $baseUrl = if ($env:TRANSLATOR_URL) {
        [string]$env:TRANSLATOR_URL
    } elseif (Test-Path -LiteralPath $baseUrlResolver -PathType Leaf) {
        [string](& $baseUrlResolver)
    } else {
        "http://127.0.0.1:8484"
    }
    $mainExecutable = [IO.Path]::GetFullPath((Join-Path $activeHost "Anti-Codex.exe"))
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $mainReady = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            if (-not $_.ExecutablePath -or ([string]$_.CommandLine) -match "\s--type=") { return $false }
            try { return ([IO.Path]::GetFullPath([string]$_.ExecutablePath)) -eq $mainExecutable } catch { return $false }
        }).Count -gt 0
        $gatewayReady = $false
        try {
            $health = Invoke-RestMethod -Uri "$baseUrl/health" -Proxy $null -TimeoutSec 3
            $gatewayReady = $health.ok -eq $true
        } catch {}
        if ($mainReady -and $gatewayReady) { return $true }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Restore-OriginalActiveHost {
    if ([IO.Directory]::Exists("\\?\$activeHost") -and -not [IO.Directory]::Exists("\\?\$rollbackHost")) { Move-FixedHostDirectory -Source $activeHost -Destination $rollbackHost }
    if ([IO.File]::Exists($activeMarker) -and -not [IO.File]::Exists($rollbackMarker)) { Move-FixedMarker -Source $activeMarker -Destination $rollbackMarker }
    if ([IO.Directory]::Exists("\\?\$swapHost") -and -not [IO.Directory]::Exists("\\?\$activeHost")) { Move-FixedHostDirectory -Source $swapHost -Destination $activeHost }
    if ([IO.File]::Exists($swapMarker) -and -not [IO.File]::Exists($activeMarker)) { Move-FixedMarker -Source $swapMarker -Destination $activeMarker }
}

$syncMutex = New-Object Threading.Mutex($false, "Local\AntiCodexHostSync")
if (-not $syncMutex.WaitOne(0)) { $syncMutex.Dispose(); throw "Another Anti-Codex sync or rollback is already running." }

$rollbackError = $null
$restartAfterRollback = $false
$rollbackStage = "rollback_validation"
try {
    try {
        Set-AntiCodexUpdateOperation -State "running" -Stage "rollback_validation" -Message "Validating the active and rollback hosts." -RollbackAvailable $true -StateRoot $stateRoot
        if ([IO.Directory]::Exists("\\?\$swapHost") -or [IO.File]::Exists($swapMarker)) { throw "A stale rollback swap is present. Anti-Codex was not changed." }
        Test-AntiCodexHost -HostRoot $activeHost -MarkerPath $activeMarker
        Test-AntiCodexHost -HostRoot $rollbackHost -MarkerPath $rollbackMarker

        $rollbackStage = "rollback_stopping_host"
        Set-AntiCodexUpdateOperation -State "running" -Stage "rollback_stopping_host" -Message "Stopping Anti-Codex before rollback." -RollbackAvailable $true -StateRoot $stateRoot
        New-Item -ItemType Directory -Path (Split-Path -Parent $hostSyncMarker) -Force | Out-Null
        "Host rollback marker $(Get-Date -Format o)" | Set-Content -LiteralPath $hostSyncMarker -Encoding ASCII
        $restartAfterRollback = $true
        Stop-AntiCodexLaunchers
        if (-not (Wait-AntiCodexHostRelease -TimeoutSeconds 20)) { throw "Anti-Codex host processes did not exit before the rollback timeout. Anti-Codex was not changed." }

        $rollbackStage = "rollback_activation"
        Set-AntiCodexUpdateOperation -State "running" -Stage "rollback_activation" -Message "Activating the previous Anti-Codex host." -RollbackAvailable $true -StateRoot $stateRoot
        try {
            Move-FixedHostDirectory -Source $activeHost -Destination $swapHost
            Move-FixedMarker -Source $activeMarker -Destination $swapMarker
            Move-FixedHostDirectory -Source $rollbackHost -Destination $activeHost
            Move-FixedMarker -Source $rollbackMarker -Destination $activeMarker
            Test-AntiCodexHost -HostRoot $activeHost -MarkerPath $activeMarker
            Move-FixedHostDirectory -Source $swapHost -Destination $rollbackHost
            Move-FixedMarker -Source $swapMarker -Destination $rollbackMarker
            Test-AntiCodexHost -HostRoot $rollbackHost -MarkerPath $rollbackMarker
        } catch {
            $swapError = $_.Exception.Message
            try {
                Restore-OriginalActiveHost
                Test-AntiCodexHost -HostRoot $activeHost -MarkerPath $activeMarker
            } catch {
                throw "Rollback failed. Automatic recovery also failed: $swapError; recovery error: $($_.Exception.Message)"
            }
            throw "Rollback failed. Automatic recovery restored the original active version: $swapError"
        }
    } catch { $rollbackError = $_ }
} finally {
    Remove-Item -LiteralPath $hostSyncMarker -Force -ErrorAction SilentlyContinue
    $syncMutex.ReleaseMutex()
    $syncMutex.Dispose()
}

if ($restartAfterRollback -and (Test-Path -LiteralPath $startAntiCodex)) {
    $rollbackStage = "rollback_restart"
    Set-AntiCodexUpdateOperation -State "running" -Stage "rollback_restart" -Message "Restarting Anti-Codex after rollback." -RollbackAvailable $true -StateRoot $stateRoot
    Start-AntiCodexDetached
}

if ($rollbackError) {
    Set-AntiCodexUpdateOperation -State "failed" -Stage $rollbackStage -Message $rollbackError.Exception.Message -FailureCode "rollback_failed" -RollbackAvailable $true -StateRoot $stateRoot
    throw $rollbackError
}

$rollbackStage = "rollback_acceptance"
Set-AntiCodexUpdateOperation -State "running" -Stage "rollback_acceptance" -Message "Checking Anti-Codex after rollback." -RollbackAvailable $true -StateRoot $stateRoot
if ($restartAfterRollback -and -not (Wait-AntiCodexPostRollbackReady -TimeoutSeconds 90)) {
    if ($RecoveryAttempt) {
        Set-AntiCodexUpdateOperation -State "failed" -Stage "rollback_acceptance" -Message "Anti-Codex did not become ready after rollback recovery." -FailureCode "rollback_recovery_not_ready" -RollbackAvailable $true -StateRoot $stateRoot
        throw "Anti-Codex did not become ready after rollback recovery."
    }
    try {
        & $PSCommandPath -RecoveryAttempt
    } catch {
        Set-AntiCodexUpdateOperation -State "failed" -Stage "rollback_acceptance" -Message $_.Exception.Message -FailureCode "rollback_recovery_failed" -RollbackAvailable $true -StateRoot $stateRoot
        throw "The rolled-back Anti-Codex host did not become ready, and automatic recovery failed: $($_.Exception.Message)"
    }
    Set-AntiCodexUpdateOperation -State "failed" -Stage "rollback_acceptance" -Message "The rolled-back host was not ready; automatic recovery restored the original active version." -FailureCode "rollback_not_ready" -RollbackAvailable $true -StateRoot $stateRoot
    throw "The rolled-back Anti-Codex host did not become ready. Automatic recovery restored the original active version."
}

Set-AntiCodexUpdateOperation -State "rolled_back" -Stage "complete" -Message "Anti-Codex restored the previous host successfully." -RollbackAvailable $true -StateRoot $stateRoot
