[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime"),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [switch]$Fast,
    [switch]$SkipAccountProxyProbe,
    [switch]$SkipIconPaletteProbe,
    [int]$FastMaxElapsedMs = 30000
)

$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]
$startedAt = [DateTime]::UtcNow
$acceptanceRunId = [guid]::NewGuid().ToString("N")

if ($Fast) { $SkipIconPaletteProbe = $true }

Add-Type -AssemblyName System.Drawing

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

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Normalize-Path {
    param([string]$Path)
    return [IO.Path]::GetFullPath($Path)
}

function Has-Text {
    param([string]$Path, [string]$Pattern)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    return ((Get-Content -LiteralPath $Path -Raw) -match $Pattern)
}

function Test-UnpackedNativeModuleInventory {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$HostRoot,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $valid = $true
    $recordedFiles = @()
    $recordedFilesProperty = $Manifest.PSObject.Properties["unpackedFiles"]
    if ($recordedFilesProperty) {
        $recordedFiles = @($recordedFilesProperty.Value)
    }
    if ($recordedFiles.Count -eq 0) {
        Add-Failure "$Label host marker is missing unpacked file inventory"
        return $false
    }

    $hostRootFull = [IO.Path]::GetFullPath($HostRoot).TrimEnd("\")
    $unpackedRoot = [IO.Path]::GetFullPath((Join-Path $hostRootFull "resources\app.asar.unpacked")).TrimEnd("\")
    $unpackedRootPrefix = "$unpackedRoot\"
    $recordedPaths = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
    foreach ($recordedFile in $recordedFiles) {
        $relativePath = [string]$recordedFile.path
        $recordedHash = [string]$recordedFile.sha256
        $recordedSizeProperty = $recordedFile.PSObject.Properties["size"]
        if (-not $relativePath -or -not $recordedHash -or -not $recordedSizeProperty -or [IO.Path]::IsPathRooted($relativePath)) {
            Add-Failure "$Label host marker contains an invalid unpacked file entry"
            $valid = $false
            continue
        }
        $unpackedFilePath = [IO.Path]::GetFullPath((Join-Path $hostRootFull $relativePath))
        $unpackedFileAccessPath = "\\?\$unpackedFilePath"
        if (-not $unpackedFilePath.StartsWith($unpackedRootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.File]::Exists($unpackedFileAccessPath)) {
            Add-Failure "$Label host unpacked file is missing or outside app.asar.unpacked: $relativePath"
            $valid = $false
            continue
        }
        if ([string](Get-AntiCodexSha256 -Path $unpackedFileAccessPath) -ne $recordedHash) {
            Add-Failure "$Label host unpacked file hash mismatch: $relativePath"
            $valid = $false
        }
        if ([long](Get-Item -LiteralPath $unpackedFileAccessPath).Length -ne [long]$recordedSizeProperty.Value) {
            Add-Failure "$Label host unpacked file size mismatch: $relativePath"
            $valid = $false
        }
        if (-not $recordedPaths.Add($unpackedFilePath)) {
            Add-Failure "$Label host marker repeats an unpacked file path: $relativePath"
            $valid = $false
        }
    }

    $unpackedAccessRoot = "\\?\$unpackedRoot"
    if (-not [IO.Directory]::Exists($unpackedAccessRoot)) {
        Add-Failure "$Label host unpacked resource directory is missing"
        return $false
    }
    $actualFiles = @(Get-ChildItem -LiteralPath $unpackedAccessRoot -File -Recurse -Force -ErrorAction Stop)
    if ($actualFiles.Count -ne $recordedFiles.Count) {
        Add-Failure "$Label host unpacked file inventory is incomplete"
        $valid = $false
    }
    return $valid
}

function Test-AntiCodexIconPalette {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ($SkipIconPaletteProbe) {
        return [pscustomobject]@{ ok = $true; skipped = $true; reason = "skipped by fast sync readiness" }
    }

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{ ok = $false; error = "missing" }
    }

    try {
        $bytes = [IO.File]::ReadAllBytes($Path)
        if ($bytes.Length -lt 22 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0 -or [BitConverter]::ToUInt16($bytes, 2) -ne 1) {
            return [pscustomobject]@{ ok = $false; error = "invalid ico header" }
        }
        $count = [BitConverter]::ToUInt16($bytes, 4)
        $best = $null
        $frameSizes = New-Object "System.Collections.Generic.List[int]"
        for ($i = 0; $i -lt $count; $i += 1) {
            $entry = 6 + ($i * 16)
            $width = [int]$bytes[$entry]
            if ($width -eq 0) { $width = 256 }
            $frameSizes.Add($width) | Out-Null
            $size = [int][BitConverter]::ToUInt32($bytes, $entry + 8)
            $offset = [int][BitConverter]::ToUInt32($bytes, $entry + 12)
            if ($null -eq $best -or $width -gt $best.Width) {
                $best = [pscustomobject]@{ Width = $width; Size = $size; Offset = $offset }
            }
        }
        if ($null -eq $best -or $best.Offset -lt 0 -or ($best.Offset + $best.Size) -gt $bytes.Length) {
            return [pscustomobject]@{ ok = $false; error = "invalid frame table" }
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
            $solid = 0
            for ($y = 0; $y -lt $bitmap.Height; $y += 8) {
                for ($x = 0; $x -lt $bitmap.Width; $x += 8) {
                    $pixel = $bitmap.GetPixel($x, $y)
                    if ($pixel.A -lt 10) {
                        $transparent += 1
                        continue
                    }
                    $solid += 1
                    if ($pixel.R -gt 205 -and $pixel.B -gt 135 -and $pixel.G -lt 165) { $pinkBlob += 1 }
                    if ($pixel.R -gt 230 -and $pixel.G -gt 230 -and $pixel.B -gt 230) { $whiteCommand += 1 }
                    if ($pixel.R -ge 30 -and $pixel.R -le 95 -and $pixel.G -ge 105 -and $pixel.G -le 170 -and $pixel.B -ge 120 -and $pixel.B -le 180) { $tealBackground += 1 }
                    if ($pixel.B -gt 185 -and $pixel.R -lt 190 -and $pixel.G -lt 185) { $originalBluePurple += 1 }
                }
            }
            return [pscustomobject]@{
                ok = ($pinkBlob -ge 120 -and $whiteCommand -ge 10 -and $transparent -ge 100 -and $tealBackground -le 3 -and $originalBluePurple -le 10)
                width = $bitmap.Width
                height = $bitmap.Height
                frameSizes = @($frameSizes | Sort-Object -Unique)
                pinkBlobSamples = $pinkBlob
                whiteCommandSamples = $whiteCommand
                tealBackgroundSamples = $tealBackground
                originalBluePurpleSamples = $originalBluePurple
                transparentSamples = $transparent
                solidSamples = $solid
            }
        } finally {
            $bitmap.Dispose()
            $image.Dispose()
            $stream.Dispose()
        }
    } catch {
        return [pscustomobject]@{ ok = $false; error = $_.Exception.Message }
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
}

$runtimeRootFull = Normalize-Path $RuntimeRoot
$installRoot = Normalize-Path (Split-Path -Parent $runtimeRootFull)
$expectedRoot = Normalize-Path (Join-Path $env:LOCALAPPDATA "Anti-Codex")
if ($installRoot -ne $expectedRoot) {
    Add-Failure "sync readiness may only inspect $expectedRoot"
}

$scriptsRoot = Join-Path $runtimeRootFull "scripts"
$syncScript = Join-Path $scriptsRoot "sync-anticodex.ps1"
$syncLauncherScript = Join-Path $scriptsRoot "sync-anticodex-launcher.ps1"
$rollbackScript = Join-Path $scriptsRoot "rollback-anticodex.ps1"
$rollbackLauncherScript = Join-Path $scriptsRoot "rollback-anticodex-launcher.ps1"
$managerScript = Join-Path $scriptsRoot "manage-anticodex.ps1"
$managerInjectScript = Join-Path $scriptsRoot "anticodex-manager-inject.js"
$managerOpenInjectScript = Join-Path $scriptsRoot "anticodex-manager-open-inject.js"
$managerBridgeScript = Join-Path $scriptsRoot "anticodex-manager-bridge.mjs"
$cdpInjectScript = Join-Path $scriptsRoot "deepcodex-cdp-inject.mjs"
$updateCheckScript = Join-Path $scriptsRoot "check-anticodex-update.ps1"
$updateStatusPath = Join-Path (Join-Path $env:APPDATA "anticodex") "update-status.json"
$installScript = Join-Path $scriptsRoot "install-anticodex.ps1"
$validatorScript = Join-Path $scriptsRoot "test-anticodex-host-candidate.ps1"
$syncFailureSafetyScript = Join-Path $scriptsRoot "test-anticodex-sync-failure-safety.ps1"
$modelThinkingVerifier = Join-Path $scriptsRoot "test-anticodex-model-thinking.ps1"
$postSyncVerifier = Join-Path $scriptsRoot "test-anticodex-installed-overall.ps1"
$startScript = Join-Path $scriptsRoot "start-anticodex.ps1"
$fixedRouteSupervisorScript = Join-Path $scriptsRoot "start-anticodex-fixed-route.mjs"
$powershell = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
$interactivePowerShell = $powershell
$interactivePowerShellCandidate = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\pwsh.exe" } else { "" }
if ($interactivePowerShellCandidate -and (Test-Path -LiteralPath $interactivePowerShellCandidate -PathType Leaf)) {
    $interactivePowerShell = [IO.Path]::GetFullPath($interactivePowerShellCandidate)
}
$schtasks = Join-Path ([Environment]::SystemDirectory) "schtasks.exe"
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
$node = if ($nodeCommand) { [IO.Path]::GetFullPath([string]$nodeCommand.Source) } else { "" }
$launchTaskName = "Anti-Codex Launcher"
$updateTaskName = "Anti-Codex Updater"
$launchTaskScript = Join-Path $scriptsRoot "start-anticodex-task.mjs"
$shortcutBrokerScript = Join-Path $scriptsRoot "start-anticodex-shortcut-broker.ps1"
$updateTaskScript = Join-Path $scriptsRoot "start-anticodex-update-task.mjs"
$conhost = Join-Path ([Environment]::SystemDirectory) "conhost.exe"
$launchTaskActionArguments = "--headless `"$node`" `"$launchTaskScript`" --hide-console"
$launchTaskShortcutArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$shortcutBrokerScript`" -InstallRoot `"$installRoot`""
$updateTaskActionArguments = "--headless `"$node`" `"$updateTaskScript`" --hide-console"
$programsPath = [Environment]::GetFolderPath("Programs")
if (-not $programsPath) {
    $programsPath = if ($env:APPDATA) { Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs" } else { Join-Path $env:USERPROFILE "AppData\Roaming\Microsoft\Windows\Start Menu\Programs" }
}
$startMenuDir = Join-Path $programsPath "Anti-Codex"
$startMenuRootMainShortcut = Join-Path $programsPath "Anti-Codex.lnk"
$startMenuMainShortcut = Join-Path $startMenuDir "Anti-Codex.lnk"
$startMenuSyncShortcut = Join-Path $startMenuDir "Sync Anti-Codex with Codex.lnk"
$startMenuRollbackShortcut = Join-Path $startMenuDir "Rollback Anti-Codex.lnk"
$startMenuManagerShortcut = Join-Path $startMenuDir "Manage Anti-Codex.lnk"
$desktopPath = [Environment]::GetFolderPath("Desktop")
if (-not $desktopPath) {
    $desktopPath = Join-Path $env:USERPROFILE "Desktop"
}
$desktopDir = $desktopPath
$desktopMainShortcut = Join-Path $desktopDir "Anti-Codex.lnk"
$activeHost = Join-Path $installRoot "codex-patched-app"
$activeMarker = Join-Path $installRoot "codex-patched-app.ok"
$activeExe = Join-Path $activeHost "Anti-Codex.exe"
$activeAsar = Join-Path $activeHost "resources\app.asar"
$activeCodexCli = Join-Path $activeHost "resources\codex.exe"
$activeHostIcon = Join-Path $activeHost "resources\icon.ico"
$activeTrayIcon = Join-Path $activeHost "resources\codex-tray.ico"
$activeAppRootIcon = Join-Path $activeHost "icon.ico"
$desktopShortcutIcon = Join-Path $runtimeRootFull "assets\anticodex-desktop.ico"
$rollbackHost = Join-Path $installRoot "rollback-host"
$rollbackMarker = Join-Path $installRoot "rollback-host.ok"
$rollbackExe = Join-Path $rollbackHost "Anti-Codex.exe"
$rollbackAsar = Join-Path $rollbackHost "resources\app.asar"
$rollbackCodexCli = Join-Path $rollbackHost "resources\codex.exe"
$rollbackHostIcon = Join-Path $rollbackHost "resources\icon.ico"
$rollbackTrayIcon = Join-Path $rollbackHost "resources\codex-tray.ico"
$rollbackAppRootIcon = Join-Path $rollbackHost "icon.ico"
$rollbackSwapHost = Join-Path $installRoot "rollback-swap-host"
$rollbackSwapMarker = Join-Path $installRoot "rollback-swap-host.ok"
$candidateRoot = Join-Path $installRoot "update-candidate"
$candidateHost = Join-Path $candidateRoot "codex-patched-app"
$candidateMarker = Join-Path $candidateRoot "codex-patched-app.ok"
$hostSyncMarker = if ($env:ANTICODEX_HOST_SYNC_MARKER) {
    $env:ANTICODEX_HOST_SYNC_MARKER
} else {
    Join-Path (Join-Path $env:APPDATA "anticodex") "host-sync.lock"
}

foreach ($path in @($syncScript, $syncLauncherScript, $updateTaskScript, $rollbackScript, $rollbackLauncherScript, $managerScript, $managerInjectScript, $managerOpenInjectScript, $managerBridgeScript, $cdpInjectScript, $updateCheckScript, $installScript, $validatorScript, $syncFailureSafetyScript, $modelThinkingVerifier, $postSyncVerifier, $startScript, $fixedRouteSupervisorScript, $launchTaskScript, $shortcutBrokerScript, $node, $conhost, $powershell, $schtasks, $activeMarker, $activeExe, $activeAsar, $activeCodexCli, $activeHostIcon, $activeTrayIcon, $activeAppRootIcon, $desktopShortcutIcon)) {
    if (-not (Test-Path -LiteralPath $path)) {
        Add-Failure "sync readiness missing required path: $path"
    }
}

if (Test-Path -LiteralPath $hostSyncMarker) {
    Add-Failure "host sync maintenance marker is still present: $hostSyncMarker"
}
if (Test-Path -LiteralPath $candidateRoot) {
    Add-Failure "stale update-candidate directory is present: $candidateRoot"
}
if ((Test-Path -LiteralPath $candidateHost) -or (Test-Path -LiteralPath $candidateMarker)) {
    Add-Failure "stale candidate host or marker is present"
}
if ((Test-Path -LiteralPath $rollbackHost) -xor (Test-Path -LiteralPath $rollbackMarker)) {
    Add-Failure "rollback host and rollback marker are inconsistent"
}
if ((Test-Path -LiteralPath $rollbackSwapHost) -or (Test-Path -LiteralPath $rollbackSwapMarker)) {
    Add-Failure "stale rollback swap is present"
}

if (-not (Has-Text $syncScript "AntiCodexHostSync")) { Add-Failure "sync script missing AntiCodexHostSync mutex" }
if (-not (Has-Text $syncScript "ANTICODEX_HOST_SYNC_MARKER")) { Add-Failure "sync script missing host sync marker handling" }
if (-not (Has-Text $syncScript "test-anticodex-host-candidate\.ps1")) { Add-Failure "sync script missing candidate validator call" }
if (-not (Has-Text $syncScript "\-HostOnly")) { Add-Failure "sync script missing host-only candidate build" }
if (-not (Has-Text $syncScript "rollback-host")) { Add-Failure "sync script missing rollback host handling" }
if (-not (Has-Text $syncScript "Wait-AntiCodexHostRelease")) { Add-Failure "sync script missing host release wait" }
if (-not (Has-Text $syncScript "Wait-AntiCodexPostSyncReady")) { Add-Failure "sync script missing post-sync health gate" }
if (-not (Has-Text $syncScript "rollback-anticodex\.ps1")) { Add-Failure "sync script missing automatic rollback entry" }
if (-not (Has-Text $syncScript "Automatic rollback")) { Add-Failure "sync script missing automatic rollback handling" }
if (-not (Has-Text $syncScript "Invoke-AntiCodexPostSyncAcceptance")) { Add-Failure "sync script missing post-sync acceptance gate" }
if (-not (Has-Text $syncScript "test-anticodex-installed-overall\.ps1")) { Add-Failure "sync script missing post-sync no-traffic verifier" }
if ((Has-Text $syncScript '&\s*\$postSyncVerifier') -and -not (Has-Text $syncScript "SkipAccountProxyProbe")) {
    Add-Failure "sync script post-sync acceptance may consume account traffic"
}
if (-not (Has-Text $syncLauncherScript "sync-anticodex\.ps1")) { Add-Failure "sync launcher missing sync script call" }
if (-not (Has-Text $syncLauncherScript "Anti-Codex was not changed")) { Add-Failure "sync launcher missing failure safety message" }
if (-not (Has-Text $rollbackScript "AntiCodexHostSync")) { Add-Failure "rollback script missing AntiCodexHostSync mutex" }
if (-not (Has-Text $rollbackScript "ANTICODEX_HOST_SYNC_MARKER")) { Add-Failure "rollback script missing host sync marker handling" }
if (-not (Has-Text $rollbackScript "rollback-swap-host")) { Add-Failure "rollback script missing bounded swap path" }
if (-not (Has-Text $rollbackScript "Test-AntiCodexHost")) { Add-Failure "rollback script missing host validation" }
if (-not (Has-Text $rollbackScript "Automatic recovery")) { Add-Failure "rollback script missing automatic recovery handling" }
if (-not (Has-Text $rollbackScript "Wait-AntiCodexPostRollbackReady")) { Add-Failure "rollback script missing post-rollback health gate" }
if (-not (Has-Text $rollbackScript "\-RecoveryAttempt")) { Add-Failure "rollback script missing automatic post-rollback recovery attempt" }
if (-not (Has-Text $rollbackLauncherScript "Anti-Codex was not changed")) { Add-Failure "rollback launcher missing failure safety message" }
if (-not (Has-Text $updateCheckScript "updateNeeded")) { Add-Failure "update checker missing version drift result" }
if (-not (Has-Text $startScript "check-anticodex-update\.ps1")) { Add-Failure "start script missing visible update check" }
if (-not (Has-Text $startScript "start-anticodex-fixed-route\.mjs")) { Add-Failure "formal launcher does not select the fixed three-layer supervisor" }
if (-not (Has-Text $fixedRouteSupervisorScript "codexplusplus-component-manifest-v1")) { Add-Failure "fixed-route supervisor missing CodexPlusPlus component contract" }
if (-not (Has-Text $fixedRouteSupervisorScript "startAntigravityChatProvider")) { Add-Failure "fixed-route supervisor missing thin Antigravity Chat provider" }
if (-not (Has-Text $fixedRouteSupervisorScript "anticodex-manager-inject\.js")) { Add-Failure "fixed-route supervisor missing in-app manager injection" }
if (-not (Has-Text $fixedRouteSupervisorScript "anticodex-manager-bridge\.mjs")) { Add-Failure "fixed-route supervisor missing in-app manager bridge" }
if (-not (Has-Text $fixedRouteSupervisorScript "windowsHide:\s*true")) { Add-Failure "fixed-route supervisor does not hide background child windows" }
if (-not (Has-Text $managerInjectScript "__ANTICODEX_OPEN_MANAGER__")) { Add-Failure "manager injection missing in-app open function" }
if (-not (Has-Text $managerInjectScript "__ANTICODEX_MANAGER_API__")) { Add-Failure "manager injection missing configured gateway URL support" }
if (-not (Has-Text $managerInjectScript "apiCandidates")) { Add-Failure "manager injection missing gateway URL fallback candidates" }
if (Has-Text $managerInjectScript 'createElement\("button"\)[\s\S]{0,500}anticodex-manager-button') { Add-Failure "manager injection still creates the removed floating Manager button" }
if (-not (Has-Text $managerInjectScript "anticodex-panel")) { Add-Failure "manager injection missing embedded manager panel" }
if (-not (Has-Text $managerInjectScript "native-panel-v113")) { Add-Failure "manager injection did not bump native panel version" }
if (-not (Has-Text $managerInjectScript 'accountSwitch')) { Add-Failure "manager injection is missing the Antigravity account switch action" }
if (-not (Has-Text $managerInjectScript "__ANTICODEX_RUN_MANAGER_ACTION__")) { Add-Failure "manager injection missing CDP action bridge support" }
if (-not (Has-Text $managerInjectScript "/anticodex/manager/action-script")) { Add-Failure "manager injection missing script-based action endpoint" }
if (-not (Has-Text $managerInjectScript "actionApiCandidates")) { Add-Failure "manager injection missing bounded action gateway candidates" }
if (Has-Text $managerInjectScript 'createElement\("iframe"\)|<iframe') { Add-Failure "manager injection still uses an iframe" }
if (-not (Has-Text $managerInjectScript "/anticodex/manager/bootstrap")) { Add-Failure "manager injection missing local manager bootstrap endpoint" }
if (-not (Has-Text $managerOpenInjectScript "__ANTICODEX_OPEN_MANAGER__")) { Add-Failure "manager open injection missing in-app open function" }
if (-not (Has-Text $managerScript "ANTICODEX_MANAGER_API")) { Add-Failure "manager script does not pass the active gateway URL to the embedded panel" }
if (-not (Has-Text $cdpInjectScript "ANTICODEX_MANAGER_API_CANDIDATES")) { Add-Failure "CDP injector does not pass gateway URL candidates to the embedded panel" }
if (-not (Has-Text $cdpInjectScript "ANTICODEX_MANAGER_SNAPSHOT")) { Add-Failure "CDP injector does not preload the embedded manager status snapshot" }
if (-not (Has-Text $managerBridgeScript "__ANTICODEX_MANAGER_ACTION_QUEUE__")) { Add-Failure "manager bridge missing CDP action queue" }
if (-not (Has-Text $managerBridgeScript "__ANTICODEX_ACK_MANAGER_ACTION__")) { Add-Failure "manager bridge missing explicit action acknowledgement" }
if (-not (Has-Text $managerBridgeScript "leaseCount")) { Add-Failure "manager bridge missing action queue leasing" }
if (Has-Text $managerBridgeScript "splice\(0\)") { Add-Failure "manager bridge still destructively drains actions before acknowledgement" }
if (-not (Has-Text $managerBridgeScript "__ANTICODEX_RUN_MANAGER_ACTION__")) { Add-Failure "manager bridge missing page action function" }
if (-not (Has-Text $managerOpenInjectScript '__ANTICODEX_MANAGER_VERSION__\s*===\s*"native-panel-v113"')) { Add-Failure "manager open injection does not verify the inject version before calling the open function" }
if (Has-Text $managerOpenInjectScript "/anticodex/manager/inject\.js") { Add-Failure "manager open injection still depends on the old web script loader" }
if (Has-Text $managerOpenInjectScript 'createElement\("script"\)') { Add-Failure "manager open injection still creates a separate script tag" }
if (-not (Has-Text $validatorScript "resources\\codex\.exe")) { Add-Failure "candidate validator missing bundled Codex CLI check" }
if (-not (Has-Text $validatorScript "resources\\icon\.ico")) { Add-Failure "candidate validator missing host icon check" }
if (-not (Has-Text $validatorScript "--version")) { Add-Failure "candidate validator missing CLI version probe" }
if (-not (Has-Text $validatorScript "preserve the copied source Codex host bytes")) { Add-Failure "candidate validator missing source host byte-preservation check" }
if (-not (Has-Text $validatorScript "anticodex-host-manifest-v2")) { Add-Failure "candidate validator missing fixed-shell signed host manifest check" }
if (-not (Has-Text $validatorScript "Get-AntiCodexSha256")) { Add-Failure "candidate validator missing local host content hash checks" }
$utilityHashCommand = "Get-" + "FileHash"
if (Has-Text $validatorScript $utilityHashCommand) { Add-Failure "candidate validator still depends on Utility module hashing" }
if (-not (Has-Text $installScript "Anti-Codex is already installed")) { Add-Failure "installer can overwrite an existing active installation without the safe sync flow" }
if (-not (Has-Text $installScript "copied host bytes changed during activation")) { Add-Failure "installer does not hard-fail when copied source host bytes change" }
if (-not (Has-Text $installScript "Install-AntiCodexHostIcon")) { Add-Failure "installer does not install the Anti-Codex host icon" }
if (-not (Has-Text $installScript "assets\\anticodex\.ico")) { Add-Failure "installer does not prefer the Anti-Codex pink icon asset" }
if (Has-Text $installScript "patch-exe-icon\.ps1|PATCH_EXE_ICON_SCRIPT") { Add-Failure "installer still rewrites executable icon resources instead of using isolated external icons" }
if (-not (Has-Text $installScript 'Copy-Item\s+-LiteralPath\s+\$icon\s+-Destination\s+\$resourceIcon\s+-Force')) { Add-Failure "installer does not install the Anti-Codex window icon" }
if (-not (Has-Text $installScript 'Copy-Item\s+-LiteralPath\s+\$icon\s+-Destination\s+\$trayIcon\s+-Force')) { Add-Failure "installer does not install the Anti-Codex tray icon" }
if (-not (Has-Text $installScript 'Copy-Item\s+-LiteralPath\s+\$icon\s+-Destination\s+\$appRootIcon\s+-Force')) { Add-Failure "installer does not install the Anti-Codex app-root icon" }
if (Has-Text $installScript "rcedit|Update-ExeVersionInfo") { Add-Failure "installer still rewrites the official Codex executable resources" }
if (-not (Has-Text $installScript '\$brandScript\s+\(Join-Path\s+\$copiedCodex\s+"resources\\app\.asar"\)\s+--profile')) { Add-Failure "installer still passes the official host executable to the ASAR brand patcher" }
if (-not (Has-Text $installScript "Copy failed after 3 attempts and fallback copy failed")) { Add-Failure "installer does not retry and safely fall back after transient Codex host copy failures" }
if (-not (Has-Text $installScript "Find-PhantomDirectories")) { Add-Failure "installer does not detect unreadable phantom directories in packaged Codex hosts" }
if (-not (Has-Text $installScript '\$copyArguments\s*\+=\s*"/XD"')) { Add-Failure "installer does not exclude unreadable phantom directories from packaged Codex host copies" }
if (-not (Has-Text $installScript "while excluding.*unreadable packaged directories")) { Add-Failure "installer can hide packaged-directory copy failures behind an incompatible fallback copy" }
if (-not (Has-Text $installScript '"/COPY:DT".*"/DCOPY:DT"')) { Add-Failure "installer copies protected WindowsApps attributes or omits timestamps required for reliable retries" }
if (-not (Has-Text $installScript 'Start-Sleep\s+-Seconds\s+\(15\s+\*\s+\$attempt\)')) { Add-Failure "installer retries protected WindowsApps copies before security scanning can release files" }
if (-not (Has-Text $installScript 'Get-ChildItem\s+-LiteralPath\s+\$Source\s+-Filter\s+"\*\.dll"')) { Add-Failure "installer does not defer protected top-level WindowsApps library copies" }
if (-not (Has-Text $installScript 'Start-Sleep\s+-Seconds\s+\(3\s+\*\s+\$fileAttempt\)')) { Add-Failure "installer does not retry protected top-level WindowsApps library copies" }
if (-not (Has-Text $installScript '\.anticodex-pending')) { Add-Failure "installer does not use neutral temporary names for protected WindowsApps library copies" }
if (-not (Has-Text $installScript "codex-host-staging")) { Add-Failure "installer does not build the copied Codex host in an isolated staging directory" }
if (-not (Has-Text $installScript 'Move-Item\s+-LiteralPath\s+\$copiedCodexStaging\s+-Destination\s+\$copiedCodex')) { Add-Failure "installer does not atomically promote the staged copied Codex host" }
if (-not (Has-Text $installScript 'foreach\s*\(\$requiredHostFile\s+in\s+@\(\$stagedDesktopHost,\s*"resources\\app\.asar",\s*"resources\\codex\.exe"\)\)')) { Add-Failure "installer does not verify all critical copied Codex host files" }
if (-not (Has-Text $syncFailureSafetyScript "failureCauseVerified")) { Add-Failure "sync failure-safety drill does not prove it reached the requested failure point" }

$version = ""
$productName = ""
$fileDescription = ""
$originalFilename = ""
$activeManifestValid = $false
$rollbackManifestValid = $false
$activeHostBinaryPreserved = $false
$rollbackHostBinaryPreserved = $false
$rollbackProductName = ""
$rollbackFileDescription = ""
$rollbackOriginalFilename = ""
$rollbackCodexVersion = ""
$rollbackSourcePackageName = ""
$rollbackSourcePackageVersion = ""
$rollbackSourceHostHash = ""
$rollbackSourceCliHash = ""
$activeSourcePackageName = ""
$activeSourcePackageVersion = ""
$activeSourceHostHash = ""
$activeSourceCliHash = ""
$activeHostIconPalette = $null
$activeTrayIconPalette = $null
$activeAppRootIconPalette = $null
$rollbackHostIconPalette = $null
$rollbackTrayIconPalette = $null
$rollbackAppRootIconPalette = $null
$updateStatus = $null
$startMenuMainShortcutExists = Test-Path -LiteralPath $startMenuMainShortcut
$startMenuMainShortcutTarget = ""
$startMenuMainShortcutArguments = ""
$startMenuSyncShortcutExists = Test-Path -LiteralPath $startMenuSyncShortcut
$startMenuSyncShortcutTarget = ""
$startMenuSyncShortcutArguments = ""
$startMenuRollbackShortcutExists = Test-Path -LiteralPath $startMenuRollbackShortcut
$startMenuRollbackShortcutTarget = ""
$startMenuRollbackShortcutArguments = ""
$startMenuManagerShortcutExists = Test-Path -LiteralPath $startMenuManagerShortcut
$startMenuManagerShortcutTarget = ""
$startMenuManagerShortcutArguments = ""
$startMenuMainShortcutIconLocation = ""
$startMenuSyncShortcutIconLocation = ""
$startMenuRollbackShortcutIconLocation = ""
$startMenuManagerShortcutIconLocation = ""
$desktopMainShortcutExists = Test-Path -LiteralPath $desktopMainShortcut
$desktopMainShortcutTarget = ""
$desktopMainShortcutArguments = ""
$desktopMainShortcutIconLocation = ""
$startMenuRootMainShortcutExists = Test-Path -LiteralPath $startMenuRootMainShortcut
$desktopShortcutIconPalette = $null
$desktopAntiCodexShortcuts = @(Get-ChildItem -LiteralPath $desktopDir -Filter "*Anti-Cod*.lnk" -Force -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Name })
$forbiddenDesktopHelperShortcuts = @($desktopAntiCodexShortcuts | Where-Object { $_ -match "^(Check|Switch|Drill) Anti-Cod" })
$expectedShortcutIconLocation = "$activeHostIcon,0"
$expectedDesktopShortcutIconLocation = if (Test-Path -LiteralPath $desktopShortcutIcon) { "$desktopShortcutIcon,0" } else { $expectedShortcutIconLocation }
$desktopIconRequiredFrameSizes = @(16, 24, 32, 48, 64, 128, 256)
$expectedManagerBridgeBaseUrl = "http://127.0.0.1:8484"
$allowedManagerBridgeBaseUrls = [System.Collections.Generic.List[string]]::new()
$allowedManagerBridgeBaseUrls.Add($expectedManagerBridgeBaseUrl) | Out-Null
$allowedManagerBridgeBaseUrls.Add("http://localhost:8484") | Out-Null
try {
    $localIpv4Addresses = @([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | Where-Object {
        $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
    } | ForEach-Object { $_.IPAddressToString })
    foreach ($ip in $localIpv4Addresses) {
        if ($ip -and -not $allowedManagerBridgeBaseUrls.Contains("http://$ip`:8484")) {
            $allowedManagerBridgeBaseUrls.Add("http://$ip`:8484") | Out-Null
        }
    }
} catch {}
function Get-ManagerBridgeBaseUrlFromCommandLine {
    param([string]$CommandLine)
    $match = [regex]::Match($CommandLine, '--base-url\s+(\S+)')
    if (-not $match.Success) { return "" }
    return $match.Groups[1].Value.TrimEnd("/")
}
$managerBridgeProcesses = @()
$managerBridgeProcessSummary = @()
$staleManagerBridgeProcesses = @()
try {
    $managerBridgeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        [string]$_.CommandLine -match [regex]::Escape("anticodex-manager-bridge.mjs")
    })
    $managerBridgeProcessSummary = @($managerBridgeProcesses | ForEach-Object {
        $commandLine = [string]$_.CommandLine
        $bridgeBaseUrl = Get-ManagerBridgeBaseUrlFromCommandLine $commandLine
        $hasAllowedBaseUrl = $allowedManagerBridgeBaseUrls.Contains($bridgeBaseUrl)
        [pscustomobject]@{
            pid = [int]$_.ProcessId
            baseUrl = $bridgeBaseUrl
            hasExpectedBaseUrl = $hasAllowedBaseUrl
            hasAllowedBaseUrl = $hasAllowedBaseUrl
            commandLine = $commandLine
        }
    })
    $staleManagerBridgeProcesses = @($managerBridgeProcessSummary | Where-Object { $_.hasAllowedBaseUrl -ne $true })
    if ($staleManagerBridgeProcesses.Count -gt 0) {
        Add-Failure "manager bridge has stale base-url process(es): $((@($staleManagerBridgeProcesses | ForEach-Object { $_.pid }) -join ', '))"
    }
} catch {
    Add-Failure "manager bridge process inspection failed: $($_.Exception.Message)"
}
function Test-ShortcutIconLocation {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$ExpectedIconLocation
    )
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($ShortcutPath)
        $iconLocation = [string]$shortcut.IconLocation
        if ($iconLocation -ine $ExpectedIconLocation) {
            Add-Failure "$Label shortcut icon does not point at the verified Anti-Codex icon: $iconLocation"
        }
        return $iconLocation
    } catch {
        Add-Failure "$Label shortcut icon inspection failed: $($_.Exception.Message)"
        return ""
    }
}

function Get-AntiCodexShortcutLauncherTarget {
    param([string]$Arguments)

    $match = [regex]::Match($Arguments, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|([^\s]+))')
    if (-not $match.Success) { return "" }

    $target = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    try { return [IO.Path]::GetFullPath($target) } catch { return $target }
}

$script:antiCodexScheduleService = $null
$script:antiCodexScheduleRoot = $null

function Get-AntiCodexScheduleRoot {
    if ($null -eq $script:antiCodexScheduleService -or $null -eq $script:antiCodexScheduleRoot) {
        $service = New-Object -ComObject "Schedule.Service"
        $service.Connect()
        $script:antiCodexScheduleService = $service
        $script:antiCodexScheduleRoot = $service.GetFolder("\")
    }
    return $script:antiCodexScheduleRoot
}

function Get-AntiCodexRegisteredTask {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    return (Get-AntiCodexScheduleRoot).GetTask("\$TaskName")
}

function Get-AntiCodexTaskStateName {
    param([int]$State)
    switch ($State) {
        1 { return "Disabled" }
        2 { return "Queued" }
        3 { return "Ready" }
        4 { return "Running" }
        default { return "Unknown" }
    }
}

function Get-AntiCodexLaunchTaskEvidence {
    try {
        $task = Get-AntiCodexRegisteredTask -TaskName $launchTaskName
        $definition = $task.Definition
        $actionCount = [int]$definition.Actions.Count
        $action = if ($actionCount -eq 1) { $definition.Actions.Item(1) } else { $null }
        $actualExecute = if ($action) { [string]$action.Path } else { "" }
        $actualArguments = if ($action) { [string]$action.Arguments } else { "" }
        $actualWorkingDirectory = if ($action) { [string]$action.WorkingDirectory } else { "" }
        $argumentMatch = [regex]::Match($actualArguments, '^--headless "([^"]+)" "([^"]+)" --hide-console$')
        $actualNode = if ($argumentMatch.Success) { $argumentMatch.Groups[1].Value } else { "" }
        $actualScript = if ($argumentMatch.Success) { $argumentMatch.Groups[2].Value } else { "" }
        try { $actualNode = [IO.Path]::GetFullPath($actualNode) } catch {}
        try { $actualScript = [IO.Path]::GetFullPath($actualScript) } catch {}
        $actionMatches = (
            $actualExecute -ieq $conhost -and
            $actualArguments -ceq $launchTaskActionArguments -and
            $actualWorkingDirectory -ieq $installRoot -and
            $actualNode -ieq $node -and
            $actualScript -ieq $launchTaskScript
        )
        $currentUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $currentShortUserName = ($currentUserName -split "\\")[-1]
        $taskUserName = [string]$definition.Principal.UserId
        $principalMatches = (
            ($taskUserName -ieq $currentUserName -or $taskUserName -ieq $currentShortUserName) -and
            [int]$definition.Principal.LogonType -eq 3 -and
            [int]$definition.Principal.RunLevel -eq 0
        )
        $settingsMatch = (
            [bool]$task.Enabled -and
            [int]$definition.Triggers.Count -eq 0 -and
            [int]$definition.Settings.MultipleInstances -eq 2 -and
            [bool]$definition.Settings.AllowDemandStart -and
            [bool]$definition.Settings.AllowHardTerminate -and
            -not [bool]$definition.Settings.RunOnlyIfIdle -and
            -not [bool]$definition.Settings.RunOnlyIfNetworkAvailable -and
            [bool]$definition.Settings.DisallowStartIfOnBatteries -eq $false -and
            [bool]$definition.Settings.StopIfGoingOnBatteries -eq $false -and
            [int]$definition.Settings.Priority -eq 4 -and
            [int]$definition.Settings.RestartCount -eq 0 -and
            [string]$definition.Settings.ExecutionTimeLimit -eq "PT0S"
        )
        $stateCode = [int]$task.State
        return [pscustomobject]@{
            ok = ($actionMatches -and $principalMatches -and $settingsMatch)
            exists = $true
            taskName = $launchTaskName
            actualExecute = $actualExecute
            actualArguments = $actualArguments
            actualWorkingDirectory = $actualWorkingDirectory
            expectedExecute = $conhost
            expectedArguments = $launchTaskActionArguments
            expectedNode = $node
            actualNode = $actualNode
            expectedScript = $launchTaskScript
            actualScript = $actualScript
            taskScript = $launchTaskScript
            actionMatches = $actionMatches
            principalMatches = $principalMatches
            settingsMatch = $settingsMatch
            state = (Get-AntiCodexTaskStateName -State $stateCode)
            stateCode = $stateCode
            error = ""
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            exists = $false
            taskName = $launchTaskName
            expectedScript = $launchTaskScript
            actualScript = ""
            error = $_.Exception.Message
        }
    }
}

$launchTaskEvidence = Get-AntiCodexLaunchTaskEvidence
if (-not $launchTaskEvidence.ok) {
    Add-Failure "Anti-Codex launch task is missing or stale: $($launchTaskEvidence.error)"
}

function Get-AntiCodexUpdateTaskEvidence {
    try {
        $task = Get-AntiCodexRegisteredTask -TaskName $updateTaskName
        $definition = $task.Definition
        $actionCount = [int]$definition.Actions.Count
        $action = if ($actionCount -eq 1) { $definition.Actions.Item(1) } else { $null }
        $actualExecute = if ($action) { [string]$action.Path } else { "" }
        $actualArguments = if ($action) { [string]$action.Arguments } else { "" }
        $actualWorkingDirectory = if ($action) { [string]$action.WorkingDirectory } else { "" }
        $argumentMatch = [regex]::Match($actualArguments, '^--headless "([^"]+)" "([^"]+)" --hide-console$')
        $actualNode = if ($argumentMatch.Success) { $argumentMatch.Groups[1].Value } else { "" }
        $actualScript = if ($argumentMatch.Success) { $argumentMatch.Groups[2].Value } else { "" }
        try { $actualNode = [IO.Path]::GetFullPath($actualNode) } catch {}
        try { $actualScript = [IO.Path]::GetFullPath($actualScript) } catch {}
        $currentUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $currentShortUserName = ($currentUserName -split "\\")[-1]
        $taskUserName = [string]$definition.Principal.UserId
        $actionMatches = (
            $actionCount -eq 1 -and
            $actualExecute -ieq $conhost -and
            $actualArguments -ceq $updateTaskActionArguments -and
            $actualWorkingDirectory -ieq $installRoot -and
            $actualNode -ieq $node -and
            $actualScript -ieq $updateTaskScript
        )
        $principalMatches = (
            ($taskUserName -ieq $currentUserName -or $taskUserName -ieq $currentShortUserName) -and
            [int]$definition.Principal.LogonType -eq 3 -and
            [int]$definition.Principal.RunLevel -eq 0
        )
        $settingsMatch = (
            [bool]$task.Enabled -and
            [int]$definition.Triggers.Count -eq 0 -and
            [int]$definition.Settings.MultipleInstances -eq 2 -and
            [bool]$definition.Settings.AllowDemandStart -and
            [bool]$definition.Settings.AllowHardTerminate -and
            -not [bool]$definition.Settings.RunOnlyIfIdle -and
            -not [bool]$definition.Settings.RunOnlyIfNetworkAvailable -and
            [bool]$definition.Settings.DisallowStartIfOnBatteries -eq $false -and
            [bool]$definition.Settings.StopIfGoingOnBatteries -eq $false -and
            [int]$definition.Settings.RestartCount -eq 0 -and
            [string]$definition.Settings.ExecutionTimeLimit -eq "PT0S"
        )
        $stateCode = [int]$task.State
        return [pscustomobject]@{
            ok = ($actionMatches -and $principalMatches -and $settingsMatch)
            exists = $true
            taskName = $updateTaskName
            expectedExecute = $conhost
            actualExecute = $actualExecute
            expectedArguments = $updateTaskActionArguments
            actualArguments = $actualArguments
            expectedWorkingDirectory = $installRoot
            actualWorkingDirectory = $actualWorkingDirectory
            expectedNode = $node
            actualNode = $actualNode
            expectedScript = $updateTaskScript
            actualScript = $actualScript
            taskScript = $updateTaskScript
            actionMatches = $actionMatches
            principalMatches = $principalMatches
            settingsMatch = $settingsMatch
            state = (Get-AntiCodexTaskStateName -State $stateCode)
            stateCode = $stateCode
            error = ""
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            exists = $false
            taskName = $updateTaskName
            expectedScript = $updateTaskScript
            error = $_.Exception.Message
        }
    }
}

$updateTaskEvidence = Get-AntiCodexUpdateTaskEvidence
if (-not $updateTaskEvidence.ok) {
    Add-Failure "Anti-Codex update task is missing or stale: $($updateTaskEvidence.error)"
}

function New-AntiCodexShortcutSpec {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedScript,
        [Parameter(Mandatory = $true)][string]$ExpectedIconLocation,
        [switch]$InlineSupervisor,
        [switch]$UseLaunchTask
    )
    $displayName = Split-Path -Leaf $Path
    $expectedArguments = if ($UseLaunchTask) {
        $launchTaskShortcutArguments
    } else {
        $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ExpectedScript`""
        if ($InlineSupervisor) { $arguments += " -InlineSupervisor" }
        $arguments
    }
    return [pscustomobject]@{
        label = $Label
        path = $Path
        displayName = $displayName
        expectedDisplayName = $displayName
        expectedTarget = if ($UseLaunchTask) { $interactivePowerShell } else { $powershell }
        expectedScript = $ExpectedScript
        expectedLauncherTarget = $ExpectedScript
        expectedArguments = $expectedArguments
        expectedIconLocation = $ExpectedIconLocation
        launchMode = if ($UseLaunchTask) { "shortcut-broker" } else { "powershell-direct" }
        useNativeLauncher = $false
    }
}

function Test-AntiCodexShortcutSpec {
    param([Parameter(Mandatory = $true)]$Spec)

    $displayName = Split-Path -Leaf ([string]$Spec.path)
    $exists = Test-Path -LiteralPath $Spec.path -PathType Leaf
    $target = ""
    $arguments = ""
    $description = ""
    $iconLocation = ""
    $actualLauncherTarget = ""
    $scriptMatches = $false
    $launcherTargetMatches = $false
    $iconMatches = $false
    $displayNameMatches = ($displayName -ceq [string]$Spec.expectedDisplayName)
    $forbiddenCodexBranding = ($displayName -notmatch "Anti-Codex") -or ($displayName -match "^(Codex|Codex Desktop)\.lnk$")
    $targetMatches = $false
    $argumentsMatches = $false

    if (-not $exists) {
        Add-Failure "$($Spec.label) shortcut is missing: $($Spec.path)"
    } else {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($Spec.path)
            $target = [string]$shortcut.TargetPath
            $arguments = [string]$shortcut.Arguments
            $description = [string]$shortcut.Description
            $iconLocation = [string]$shortcut.IconLocation
            $actualLauncherTarget = Get-AntiCodexShortcutLauncherTarget $arguments
            $targetMatches = ($target -ieq [string]$Spec.expectedTarget)
            $launcherTargetMatches = ($actualLauncherTarget -and ($actualLauncherTarget -ieq [string]$Spec.expectedLauncherTarget))
            $scriptMatches = $launcherTargetMatches
            $argumentsMatches = ($arguments -ceq [string]$Spec.expectedArguments)
            $iconMatches = ($iconLocation -ieq [string]$Spec.expectedIconLocation)
            $forbiddenCodexBranding = $forbiddenCodexBranding -or (($description -match "^Codex(\s|$)") -and ($description -notmatch "Anti-Codex"))

            if (-not $targetMatches) {
                Add-Failure "$($Spec.label) shortcut target is not the expected launcher: $target"
            }
            if (-not $scriptMatches) {
                Add-Failure "$($Spec.label) shortcut does not launch the expected Anti-Codex script: $arguments"
            }
            if (-not $argumentsMatches) {
                Add-Failure "$($Spec.label) shortcut arguments do not match the protected lifecycle: $arguments"
            }
            if (-not $iconMatches) {
                Add-Failure "$($Spec.label) shortcut icon does not point at the expected Anti-Codex icon: $iconLocation"
            }
        } catch {
            Add-Failure "$($Spec.label) shortcut inspection failed: $($_.Exception.Message)"
        }
    }

    if (-not $displayNameMatches) {
        Add-Failure "$($Spec.label) shortcut file name is not Anti-Codex branded: $displayName"
    }
    if ($forbiddenCodexBranding) {
        Add-Failure "$($Spec.label) shortcut still carries Codex-only branding: $displayName"
    }

    return [pscustomobject]@{
        ok = ($exists -and $targetMatches -and $scriptMatches -and $argumentsMatches -and $iconMatches -and $displayNameMatches -and -not $forbiddenCodexBranding)
        label = [string]$Spec.label
        path = [string]$Spec.path
        exists = $exists
        displayName = $displayName
        expectedDisplayName = [string]$Spec.expectedDisplayName
        displayNameMatches = $displayNameMatches
        forbiddenCodexBranding = $forbiddenCodexBranding
        actualTarget = $target
        actualArguments = $arguments
        actualDescription = $description
        actualIconLocation = $iconLocation
        launchMode = [string]$Spec.launchMode
        expectedTarget = [string]$Spec.expectedTarget
        expectedScript = [string]$Spec.expectedScript
        expectedLauncherTarget = [string]$Spec.expectedLauncherTarget
        expectedArguments = [string]$Spec.expectedArguments
        actualLauncherTarget = $actualLauncherTarget
        expectedIconLocation = [string]$Spec.expectedIconLocation
        targetMatches = $targetMatches
        launcherTargetMatches = $launcherTargetMatches
        scriptMatches = $scriptMatches
        argumentsMatches = $argumentsMatches
        iconMatches = $iconMatches
    }
}

$shortcutSpecs = @(
    New-AntiCodexShortcutSpec -Label "Desktop Anti-Codex" -Path $desktopMainShortcut -ExpectedScript $shortcutBrokerScript -ExpectedIconLocation $expectedDesktopShortcutIconLocation -UseLaunchTask
    New-AntiCodexShortcutSpec -Label "Start Menu Anti-Codex" -Path $startMenuMainShortcut -ExpectedScript $shortcutBrokerScript -ExpectedIconLocation $expectedShortcutIconLocation -UseLaunchTask
    New-AntiCodexShortcutSpec -Label "Start Menu sync" -Path $startMenuSyncShortcut -ExpectedScript $syncLauncherScript -ExpectedIconLocation $expectedShortcutIconLocation
    New-AntiCodexShortcutSpec -Label "Start Menu rollback" -Path $startMenuRollbackShortcut -ExpectedScript $rollbackLauncherScript -ExpectedIconLocation $expectedShortcutIconLocation
    New-AntiCodexShortcutSpec -Label "Start Menu manager" -Path $startMenuManagerShortcut -ExpectedScript $managerScript -ExpectedIconLocation $expectedShortcutIconLocation
)
$shortcutVerification = @($shortcutSpecs | ForEach-Object { Test-AntiCodexShortcutSpec $_ })
if (-not $startMenuMainShortcutExists) {
    Add-Failure "Start Menu Anti-Codex shortcut is missing: $startMenuMainShortcut"
} else {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $mainShortcut = $shell.CreateShortcut($startMenuMainShortcut)
        $startMenuMainShortcutTarget = [string]$mainShortcut.TargetPath
        $startMenuMainShortcutArguments = [string]$mainShortcut.Arguments
        $startMenuMainShortcutIconLocation = [string]$mainShortcut.IconLocation
        if ($startMenuMainShortcutTarget -ine $interactivePowerShell) {
            Add-Failure "Start Menu Anti-Codex shortcut target is not the Windows launch broker: $startMenuMainShortcutTarget"
        }
        $startMenuLauncherTarget = Get-AntiCodexShortcutLauncherTarget $startMenuMainShortcutArguments
        if ($startMenuLauncherTarget -ine $shortcutBrokerScript) {
            Add-Failure "Start Menu Anti-Codex shortcut does not launch the protected shortcut broker: $startMenuMainShortcutArguments"
        }
        if ($startMenuMainShortcutArguments -cne $launchTaskShortcutArguments) {
            Add-Failure "Start Menu Anti-Codex shortcut does not call the isolated launch task: $startMenuMainShortcutArguments"
        }
        if ($startMenuMainShortcutIconLocation -ine $expectedShortcutIconLocation) {
            Add-Failure "Start Menu Anti-Codex shortcut icon does not point at the verified Anti-Codex icon: $startMenuMainShortcutIconLocation"
        }
    } catch {
        Add-Failure "Start Menu Anti-Codex shortcut inspection failed: $($_.Exception.Message)"
    }
}
if (-not $desktopMainShortcutExists) {
    Add-Failure "Desktop Anti-Codex shortcut is missing: $desktopMainShortcut"
} else {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $desktopShortcut = $shell.CreateShortcut($desktopMainShortcut)
        $desktopMainShortcutTarget = [string]$desktopShortcut.TargetPath
        $desktopMainShortcutArguments = [string]$desktopShortcut.Arguments
        $desktopMainShortcutIconLocation = [string]$desktopShortcut.IconLocation
        if ($desktopMainShortcutTarget -ine $interactivePowerShell) {
            Add-Failure "Desktop Anti-Codex shortcut target is not the Windows launch broker: $desktopMainShortcutTarget"
        }
        $desktopLauncherTarget = Get-AntiCodexShortcutLauncherTarget $desktopMainShortcutArguments
        if ($desktopLauncherTarget -ine $shortcutBrokerScript) {
            Add-Failure "Desktop Anti-Codex shortcut does not launch the protected shortcut broker: $desktopMainShortcutArguments"
        }
        if ($desktopMainShortcutArguments -cne $launchTaskShortcutArguments) {
            Add-Failure "Desktop Anti-Codex shortcut does not call the isolated launch task: $desktopMainShortcutArguments"
        }
        if ($desktopMainShortcutIconLocation -ine $expectedDesktopShortcutIconLocation) {
            Add-Failure "Desktop Anti-Codex shortcut icon does not point at the verified Anti-Codex icon: $desktopMainShortcutIconLocation"
        }
    } catch {
        Add-Failure "Desktop Anti-Codex shortcut inspection failed: $($_.Exception.Message)"
    }
}
if ($startMenuRootMainShortcutExists) {
    Add-Failure "Root Start Menu Anti-Codex shortcut bypasses the supported launcher: $startMenuRootMainShortcut"
}
if (Test-Path -LiteralPath $desktopShortcutIcon) {
    $desktopShortcutIconPalette = Test-AntiCodexIconPalette -Path $desktopShortcutIcon
    if ($desktopShortcutIconPalette.ok -ne $true) {
        Add-Failure "desktop shortcut icon asset is not the pink Codex cloud with white command marks"
    }
    if ($desktopShortcutIconPalette.skipped -ne $true) {
        $desktopFrameSizes = @($desktopShortcutIconPalette.frameSizes | ForEach-Object { [int]$_ })
        foreach ($requiredFrameSize in $desktopIconRequiredFrameSizes) {
            if ($desktopFrameSizes -notcontains $requiredFrameSize) {
                Add-Failure "desktop shortcut icon missing required frame size: $requiredFrameSize"
            }
        }
    }
}
if ($forbiddenDesktopHelperShortcuts.Count -gt 0) {
    Add-Failure "desktop helper shortcuts should not be present: $($forbiddenDesktopHelperShortcuts -join ', ')"
}
if (-not $startMenuSyncShortcutExists) {
    Add-Failure "Start Menu sync shortcut is missing: $startMenuSyncShortcut"
} else {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $syncShortcut = $shell.CreateShortcut($startMenuSyncShortcut)
        $startMenuSyncShortcutTarget = [string]$syncShortcut.TargetPath
        $startMenuSyncShortcutArguments = [string]$syncShortcut.Arguments
        $startMenuSyncShortcutIconLocation = [string]$syncShortcut.IconLocation
        if ($startMenuSyncShortcutTarget -notmatch "powershell\.exe$") {
            Add-Failure "Start Menu sync shortcut target is not powershell.exe: $startMenuSyncShortcutTarget"
        }
        if ($startMenuSyncShortcutArguments -notmatch "sync-anticodex-launcher\.ps1") {
            Add-Failure "Start Menu sync shortcut does not launch the sync launcher"
        }
        if ($startMenuSyncShortcutIconLocation -ine $expectedShortcutIconLocation) {
            Add-Failure "Start Menu sync shortcut icon does not point at the verified Anti-Codex icon: $startMenuSyncShortcutIconLocation"
        }
    } catch {
        Add-Failure "Start Menu sync shortcut inspection failed: $($_.Exception.Message)"
    }
}
if (-not $startMenuRollbackShortcutExists) {
    Add-Failure "Start Menu rollback shortcut is missing: $startMenuRollbackShortcut"
} else {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $rollbackLnk = $shell.CreateShortcut($startMenuRollbackShortcut)
        $startMenuRollbackShortcutTarget = [string]$rollbackLnk.TargetPath
        $startMenuRollbackShortcutArguments = [string]$rollbackLnk.Arguments
        $startMenuRollbackShortcutIconLocation = [string]$rollbackLnk.IconLocation
        if ($startMenuRollbackShortcutTarget -notmatch "powershell\.exe$") {
            Add-Failure "Start Menu rollback shortcut target is not powershell.exe: $startMenuRollbackShortcutTarget"
        }
        if ($startMenuRollbackShortcutArguments -notmatch "rollback-anticodex-launcher\.ps1") {
            Add-Failure "Start Menu rollback shortcut does not launch the rollback launcher"
        }
        if ($startMenuRollbackShortcutIconLocation -ine $expectedShortcutIconLocation) {
            Add-Failure "Start Menu rollback shortcut icon does not point at the verified Anti-Codex icon: $startMenuRollbackShortcutIconLocation"
        }
    } catch {
        Add-Failure "Start Menu rollback shortcut inspection failed: $($_.Exception.Message)"
    }
}
if (-not $startMenuManagerShortcutExists) {
    Add-Failure "Start Menu manager shortcut is missing: $startMenuManagerShortcut"
} else {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $managerLnk = $shell.CreateShortcut($startMenuManagerShortcut)
        $startMenuManagerShortcutTarget = [string]$managerLnk.TargetPath
        $startMenuManagerShortcutArguments = [string]$managerLnk.Arguments
        $startMenuManagerShortcutIconLocation = [string]$managerLnk.IconLocation
        if ($startMenuManagerShortcutTarget -notmatch "powershell\.exe$") { Add-Failure "Start Menu manager shortcut target is not powershell.exe" }
        if ($startMenuManagerShortcutArguments -notmatch "manage-anticodex\.ps1") { Add-Failure "Start Menu manager shortcut does not launch the manager" }
        if ($startMenuManagerShortcutIconLocation -ine $expectedShortcutIconLocation) {
            Add-Failure "Start Menu manager shortcut icon does not point at the verified Anti-Codex icon: $startMenuManagerShortcutIconLocation"
        }
    } catch {
        Add-Failure "Start Menu manager shortcut inspection failed: $($_.Exception.Message)"
    }
}
try {
    if (Test-Path -LiteralPath $activeMarker) {
        $activeManifest = Get-Content -LiteralPath $activeMarker -Raw | ConvertFrom-Json
        if ([string]$activeManifest.schema -ne "anticodex-host-manifest-v2") {
            Add-Failure "active host marker schema is invalid"
        } else {
            if ($activeManifest.source) {
                $activeSourcePackageName = [string]$activeManifest.source.packageName
                $activeSourcePackageVersion = [string]$activeManifest.source.packageVersion
                $activeSourceHostHash = [string]$activeManifest.source.codexHost
                $activeSourceCliHash = [string]$activeManifest.source.codexCli
            }
            $activeHashes = [ordered]@{
                antiCodexExe = Get-AntiCodexSha256 -Path $activeExe
                appAsar = Get-AntiCodexSha256 -Path $activeAsar
                codexCli = Get-AntiCodexSha256 -Path $activeCodexCli
                hostIcon = Get-AntiCodexSha256 -Path $activeHostIcon
                trayIcon = Get-AntiCodexSha256 -Path $activeTrayIcon
                appRootIcon = Get-AntiCodexSha256 -Path $activeAppRootIcon
            }
            $activeManifestValid = $true
            foreach ($name in $activeHashes.Keys) {
                if ([string]$activeManifest.files.$name -ne [string]$activeHashes[$name]) {
                    $activeManifestValid = $false
                    Add-Failure "active host marker hash mismatch: $name"
                }
            }
            $activeHostBinaryPreserved = [bool](
                $activeManifest.source -and
                [string]$activeHashes.antiCodexExe -eq [string]$activeManifest.source.codexHost
            )
            if (-not $activeHostBinaryPreserved) {
                $activeManifestValid = $false
                Add-Failure "active Anti-Codex.exe does not preserve the copied source Codex host bytes"
            }
            if (-not (Test-UnpackedNativeModuleInventory -Manifest $activeManifest -HostRoot $activeHost -Label "active")) {
                $activeManifestValid = $false
            }
            $activeHostIconPalette = Test-AntiCodexIconPalette -Path $activeHostIcon
            $activeTrayIconPalette = Test-AntiCodexIconPalette -Path $activeTrayIcon
            $activeAppRootIconPalette = Test-AntiCodexIconPalette -Path $activeAppRootIcon
            if ($activeHostIconPalette.ok -ne $true) {
                Add-Failure "active host icon is not the pink Codex cloud with white command marks"
            }
            if ($activeTrayIconPalette.ok -ne $true) {
                Add-Failure "active tray icon is not the pink Codex cloud with white command marks"
            }
            if ($activeAppRootIconPalette.ok -ne $true) {
                Add-Failure "active app-root icon is not the pink Codex cloud with white command marks"
            }
        }
    }
    if (Test-Path -LiteralPath $activeExe) {
        $versionInfo = (Get-Item -LiteralPath $activeExe).VersionInfo
        $productName = [string]$versionInfo.ProductName
        $fileDescription = [string]$versionInfo.FileDescription
        $originalFilename = [string]$versionInfo.OriginalFilename
    }
    if (Test-Path -LiteralPath $activeCodexCli) {
        $versionOutput = @(& $activeCodexCli --version 2>&1)
        if ($LASTEXITCODE -ne 0) {
            Add-Failure "active bundled Codex CLI version probe failed"
        }
        $version = ($versionOutput -join " ").Trim()
        if (-not $version) {
            Add-Failure "active bundled Codex CLI version probe returned empty output"
        }
    }
} catch {
    Add-Failure "active host inspection failed: $($_.Exception.Message)"
}
try {
    if ((Test-Path -LiteralPath $rollbackHost) -and (Test-Path -LiteralPath $rollbackMarker)) {
        foreach ($path in @($rollbackExe, $rollbackAsar, $rollbackCodexCli, $rollbackHostIcon, $rollbackTrayIcon, $rollbackAppRootIcon)) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                Add-Failure "rollback host is incomplete: $path"
            }
        }
        $rollbackManifest = Get-Content -LiteralPath $rollbackMarker -Raw | ConvertFrom-Json
        if ([string]$rollbackManifest.schema -ne "anticodex-host-manifest-v2") {
            Add-Failure "rollback host marker schema is invalid"
        } else {
            if ($rollbackManifest.source) {
                $rollbackSourcePackageName = [string]$rollbackManifest.source.packageName
                $rollbackSourcePackageVersion = [string]$rollbackManifest.source.packageVersion
                $rollbackSourceHostHash = [string]$rollbackManifest.source.codexHost
                $rollbackSourceCliHash = [string]$rollbackManifest.source.codexCli
            }
            $rollbackHashes = [ordered]@{
                antiCodexExe = Get-AntiCodexSha256 -Path $rollbackExe
                appAsar = Get-AntiCodexSha256 -Path $rollbackAsar
                codexCli = Get-AntiCodexSha256 -Path $rollbackCodexCli
                hostIcon = Get-AntiCodexSha256 -Path $rollbackHostIcon
                trayIcon = Get-AntiCodexSha256 -Path $rollbackTrayIcon
                appRootIcon = Get-AntiCodexSha256 -Path $rollbackAppRootIcon
            }
            $rollbackManifestValid = $true
            foreach ($name in $rollbackHashes.Keys) {
                if ([string]$rollbackManifest.files.$name -ne [string]$rollbackHashes[$name]) {
                    $rollbackManifestValid = $false
                    Add-Failure "rollback host marker hash mismatch: $name"
                }
            }
            $rollbackHostBinaryPreserved = [bool](
                $rollbackManifest.source -and
                [string]$rollbackHashes.antiCodexExe -eq [string]$rollbackManifest.source.codexHost
            )
            if (-not $rollbackHostBinaryPreserved) {
                $rollbackManifestValid = $false
                Add-Failure "rollback Anti-Codex.exe does not preserve the copied source Codex host bytes"
            }
            if (-not (Test-UnpackedNativeModuleInventory -Manifest $rollbackManifest -HostRoot $rollbackHost -Label "rollback")) {
                $rollbackManifestValid = $false
            }
            $rollbackHostIconPalette = Test-AntiCodexIconPalette -Path $rollbackHostIcon
            $rollbackTrayIconPalette = Test-AntiCodexIconPalette -Path $rollbackTrayIcon
            $rollbackAppRootIconPalette = Test-AntiCodexIconPalette -Path $rollbackAppRootIcon
            if ($rollbackHostIconPalette.ok -ne $true) {
                Add-Failure "rollback host icon is not the pink Codex cloud with white command marks"
            }
            if ($rollbackTrayIconPalette.ok -ne $true) {
                Add-Failure "rollback tray icon is not the pink Codex cloud with white command marks"
            }
            if ($rollbackAppRootIconPalette.ok -ne $true) {
                Add-Failure "rollback app-root icon is not the pink Codex cloud with white command marks"
            }
        }
        if (Test-Path -LiteralPath $rollbackExe) {
            $rollbackVersionInfo = (Get-Item -LiteralPath $rollbackExe).VersionInfo
            $rollbackProductName = [string]$rollbackVersionInfo.ProductName
            $rollbackFileDescription = [string]$rollbackVersionInfo.FileDescription
            $rollbackOriginalFilename = [string]$rollbackVersionInfo.OriginalFilename
        }
        if (Test-Path -LiteralPath $rollbackCodexCli) {
            $rollbackVersionOutput = @(& $rollbackCodexCli --version 2>&1)
            if ($LASTEXITCODE -ne 0) {
                Add-Failure "rollback bundled Codex CLI version probe failed"
            }
            $rollbackCodexVersion = ($rollbackVersionOutput -join " ").Trim()
            if (-not $rollbackCodexVersion) {
                Add-Failure "rollback bundled Codex CLI version probe returned empty output"
            }
        }
    }
} catch {
    Add-Failure "rollback host inspection failed: $($_.Exception.Message)"
}
try {
    if ($Fast -and (Test-Path -LiteralPath $updateStatusPath -PathType Leaf)) {
        $updateStatus = Get-Content -LiteralPath $updateStatusPath -Raw | ConvertFrom-Json
        $updateStatusSource = "fast_cached_update_status"
    } else {
        $updateCheckArgs = if ($Fast) { @{ InstallRoot = $installRoot } } else { @{ InstallRoot = $installRoot; NoPersist = $true } }
        $updateStatus = & $updateCheckScript @updateCheckArgs | ConvertFrom-Json
        $updateStatusSource = if ($Fast) { "fast_live_update_check" } else { "full_live_update_check" }
    }
    if ($updateStatus.ok -ne $true) { Add-Failure "Codex update status is not comparable: $($updateStatus.reason)" }
    if ($updateStatus.updateNeeded -eq $true) { Add-Failure "installed Codex changed; Anti-Codex sync is required" }
    if ($updateStatus.sync.available -ne $true) { Add-Failure "Codex update status cannot find the safe sync launcher" }
} catch {
    Add-Failure "Codex update status check failed: $($_.Exception.Message)"
}

$sourceHostHashMatchesActive = ($updateStatus.source.hostHash -and $updateStatus.active.hostHash -and $updateStatus.source.hostHash -eq $updateStatus.active.hostHash)
$sourceCliHashMatchesActive = ($updateStatus.source.cliHash -and $updateStatus.active.cliHash -and $updateStatus.source.cliHash -eq $updateStatus.active.cliHash)
$activeSourcePackageNameFromMarker = $activeSourcePackageName
$activeSourcePackageVersionFromMarker = $activeSourcePackageVersion
$activeSourcePackageVersionEffectiveReason = "marker"
if (
    $sourceHostHashMatchesActive -and
    $sourceCliHashMatchesActive -and
    [string]$updateStatus.source.packageVersion -and
    [string]$activeSourcePackageVersion -ne [string]$updateStatus.source.packageVersion
) {
    $activeSourcePackageName = [string]$updateStatus.source.packageName
    $activeSourcePackageVersion = [string]$updateStatus.source.packageVersion
    $activeSourcePackageVersionEffectiveReason = "source-version-adopted-after-host-cli-hash-match"
}

$endedAt = [DateTime]::UtcNow
$elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
$checkedAt = $endedAt.ToString("o")
if ($Fast -and $FastMaxElapsedMs -gt 0 -and $elapsedMs -gt $FastMaxElapsedMs) {
    Add-Failure "fast sync readiness exceeded ${FastMaxElapsedMs}ms: ${elapsedMs}ms"
}

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    generatedAt = $checkedAt
    checkedAt = $checkedAt
    reportName = "sync-readiness"
    failures = $failures.ToArray()
    elapsedMs = $elapsedMs
    fast = [bool]$Fast
    noTraffic = $true
    usedRealTraffic = $false
    behaviorCovered = $true
    coverageKind = if ($Fast) { "installed-fast-no-traffic" } else { "installed-no-traffic" }
    processIdentity = [pscustomobject]@{
        verifierPid = $PID
        verifierProcess = [Diagnostics.Process]::GetCurrentProcess().ProcessName
    }
    sessionIdentity = [pscustomobject]@{
        runId = $acceptanceRunId
        kind = "offline-sync-readiness"
        runtimeRoot = $runtimeRootFull
        installRoot = $installRoot
        cdpSessionRequired = $false
    }
    skipAccountProxyProbe = [bool]$SkipAccountProxyProbe
    skipIconPaletteProbe = [bool]$SkipIconPaletteProbe
    installRoot = $installRoot
    runtimeRoot = $runtimeRootFull
    clientSyncContract = [pscustomobject]@{
        mode = "codex-client-copy-plus-anticodex-patches"
        maintenancePath = "guarded-host-sync-then-reapply-anticodex-patches"
        nativeClientBehaviorCarriedByHostSync = $true
        forbidsFeatureByFeatureReimplementation = $true
        sourcePackageName = [string]$updateStatus.source.packageName
        sourcePackageVersion = [string]$updateStatus.source.packageVersion
        activeSourcePackageName = $activeSourcePackageName
        activeSourcePackageVersion = $activeSourcePackageVersion
        activeSourcePackageNameFromMarker = $activeSourcePackageNameFromMarker
        activeSourcePackageVersionFromMarker = $activeSourcePackageVersionFromMarker
        activeSourcePackageVersionEffectiveReason = $activeSourcePackageVersionEffectiveReason
        sourceHostHashMatches = $sourceHostHashMatchesActive
        sourceCliHashMatches = $sourceCliHashMatchesActive
        antiCodexPatchScope = @("branding", "icons", "shortcuts", "isolation", "launcher", "model-adapter")
    }
    activeHost = [pscustomobject]@{
        exists = (Test-Path -LiteralPath $activeHost)
        markerExists = (Test-Path -LiteralPath $activeMarker)
        manifestValid = $activeManifestValid
        hostBinaryPreserved = $activeHostBinaryPreserved
        exeExists = (Test-Path -LiteralPath $activeExe)
        productName = $productName
        fileDescription = $fileDescription
        originalFilename = $originalFilename
        hostIconExists = (Test-Path -LiteralPath $activeHostIcon)
        trayIconExists = (Test-Path -LiteralPath $activeTrayIcon)
        appRootIconExists = (Test-Path -LiteralPath $activeAppRootIcon)
        hostIconPalette = $activeHostIconPalette
        trayIconPalette = $activeTrayIconPalette
        appRootIconPalette = $activeAppRootIconPalette
        codexVersion = $version
        sourcePackageName = $activeSourcePackageName
        sourcePackageVersion = $activeSourcePackageVersion
        sourceHostHash = $activeSourceHostHash
        sourceCliHash = $activeSourceCliHash
    }
    sync = [pscustomobject]@{
        scriptExists = (Test-Path -LiteralPath $syncScript)
        launcherExists = (Test-Path -LiteralPath $syncLauncherScript)
        updateTaskBrokerExists = (Test-Path -LiteralPath $updateTaskScript)
        rollbackScriptExists = (Test-Path -LiteralPath $rollbackScript)
        rollbackLauncherExists = (Test-Path -LiteralPath $rollbackLauncherScript)
        updateCheckExists = (Test-Path -LiteralPath $updateCheckScript)
        updateStatusSource = $updateStatusSource
        updateStatus = $updateStatus
        validatorExists = (Test-Path -LiteralPath $validatorScript)
        failureSafetyVerifierExists = (Test-Path -LiteralPath $syncFailureSafetyScript)
        installerExists = (Test-Path -LiteralPath $installScript)
        startScriptExists = (Test-Path -LiteralPath $startScript)
        launchTask = $launchTaskEvidence
        updateTask = $updateTaskEvidence
        startMenuMainShortcutExists = $startMenuMainShortcutExists
        startMenuMainShortcutTarget = $startMenuMainShortcutTarget
        startMenuMainShortcutArguments = $startMenuMainShortcutArguments
        startMenuMainShortcutIconLocation = $startMenuMainShortcutIconLocation
        startMenuSyncShortcutExists = $startMenuSyncShortcutExists
        startMenuSyncShortcutTarget = $startMenuSyncShortcutTarget
        startMenuSyncShortcutArguments = $startMenuSyncShortcutArguments
        startMenuSyncShortcutIconLocation = $startMenuSyncShortcutIconLocation
        startMenuRollbackShortcutExists = $startMenuRollbackShortcutExists
        startMenuRollbackShortcutTarget = $startMenuRollbackShortcutTarget
        startMenuRollbackShortcutArguments = $startMenuRollbackShortcutArguments
        startMenuRollbackShortcutIconLocation = $startMenuRollbackShortcutIconLocation
        startMenuManagerShortcutExists = $startMenuManagerShortcutExists
        startMenuManagerShortcutTarget = $startMenuManagerShortcutTarget
        startMenuManagerShortcutArguments = $startMenuManagerShortcutArguments
        startMenuManagerShortcutIconLocation = $startMenuManagerShortcutIconLocation
        desktopMainShortcutExists = $desktopMainShortcutExists
        desktopMainShortcutTarget = $desktopMainShortcutTarget
        desktopMainShortcutArguments = $desktopMainShortcutArguments
        desktopMainShortcutIconLocation = $desktopMainShortcutIconLocation
        desktopShortcutIcon = $desktopShortcutIcon
        desktopShortcutIconPalette = $desktopShortcutIconPalette
        desktopIconRequiredFrameSizes = $desktopIconRequiredFrameSizes
        expectedShortcutIconLocation = $expectedShortcutIconLocation
        expectedDesktopShortcutIconLocation = $expectedDesktopShortcutIconLocation
        shortcutVerification = $shortcutVerification
        desktopAntiCodexShortcuts = $desktopAntiCodexShortcuts
        forbiddenDesktopHelperShortcuts = $forbiddenDesktopHelperShortcuts
        managerBridge = [pscustomobject]@{
            expectedBaseUrl = $expectedManagerBridgeBaseUrl
            allowedBaseUrls = @($allowedManagerBridgeBaseUrls)
            processCount = $managerBridgeProcesses.Count
            staleProcessCount = $staleManagerBridgeProcesses.Count
            processes = $managerBridgeProcessSummary
        }
        hostSyncMarkerExists = (Test-Path -LiteralPath $hostSyncMarker)
        staleCandidateExists = (Test-Path -LiteralPath $candidateRoot)
        rollbackHostExists = (Test-Path -LiteralPath $rollbackHost)
        rollbackMarkerExists = (Test-Path -LiteralPath $rollbackMarker)
        rollbackHost = [pscustomobject]@{
            exists = (Test-Path -LiteralPath $rollbackHost)
            markerExists = (Test-Path -LiteralPath $rollbackMarker)
            manifestValid = $rollbackManifestValid
            hostBinaryPreserved = $rollbackHostBinaryPreserved
            exeExists = (Test-Path -LiteralPath $rollbackExe)
            productName = $rollbackProductName
            fileDescription = $rollbackFileDescription
            originalFilename = $rollbackOriginalFilename
            hostIconExists = (Test-Path -LiteralPath $rollbackHostIcon)
            trayIconExists = (Test-Path -LiteralPath $rollbackTrayIcon)
            appRootIconExists = (Test-Path -LiteralPath $rollbackAppRootIcon)
            hostIconPalette = $rollbackHostIconPalette
            trayIconPalette = $rollbackTrayIconPalette
            appRootIconPalette = $rollbackAppRootIconPalette
            codexVersion = $rollbackCodexVersion
            sourcePackageName = $rollbackSourcePackageName
            sourcePackageVersion = $rollbackSourcePackageVersion
            sourceHostHash = $rollbackSourceHostHash
            sourceCliHash = $rollbackSourceCliHash
        }
        rollbackSwapHostExists = (Test-Path -LiteralPath $rollbackSwapHost)
        rollbackSwapMarkerExists = (Test-Path -LiteralPath $rollbackSwapMarker)
    }
}

$reportPaths = New-ReportPaths "sync-readiness"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
Save-JsonReport $reportPaths $result
$result | ConvertTo-Json -Depth 12 -Compress
if ($failures.Count -gt 0) { exit 1 }



