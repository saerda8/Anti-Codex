#Requires -Version 5.1
param(
    [string]$InstallTarget = (Join-Path $env:LOCALAPPDATA "Anti-Codex"),
    [string]$SourceRoot = "",
    [switch]$HostOnly
)

if ($PSVersionTable.PSEdition -eq "Core") {
    $windowsPowerShell = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
        throw "Windows PowerShell is required to install the Codex desktop package copy: $windowsPowerShell"
    }
    $delegateArgs = @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-InstallTarget", $InstallTarget
    )
    if ($SourceRoot) { $delegateArgs += @("-SourceRoot", $SourceRoot) }
    if ($HostOnly) { $delegateArgs += "-HostOnly" }
    $delegateOutput = & $windowsPowerShell @delegateArgs
    $delegateExitCode = $LASTEXITCODE
    if ($delegateExitCode -ne 0) {
        throw "Windows PowerShell Anti-Codex install exited with code $delegateExitCode."
    }
    $delegateOutput
    return
}

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
$SOURCE_PREFLIGHT_SCRIPT = Join-Path $ROOT "scripts\test-anticodex-source-preflight.ps1"
$fixedShellCriticalPatches = @(
    "package-json",
    "webview-html-title",
    "app-name",
    "app-user-model-id",
    "session-title",
    "startup-mcp-config-reload",
    "app-server-managed-session-flags",
    "config-write",
    "auth-requirement",
    "app-route-gate",
    "profile-dropdown-settings",
    "settings-external-links",
    "crash-recovery-page",
    "browser-window-icon",
    "windows-tray-icon",
    "local-model-availability"
)
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
$expectedCandidateRoot = [IO.Path]::GetFullPath((Join-Path $expectedRoot "update-candidate"))
$resolvedTarget = [IO.Path]::GetFullPath($InstallTarget)
if ($resolvedTarget -ne $expectedRoot -and (-not $HostOnly -or $resolvedTarget -ne $expectedCandidateRoot)) {
    throw "Anti-Codex may only install to $expectedRoot or build a host-only candidate at $expectedCandidateRoot"
}
$existingActiveMarker = Join-Path $expectedRoot "codex-patched-app.ok"
if (-not $HostOnly -and (Test-Path -LiteralPath $existingActiveMarker -PathType Leaf)) {
    throw "Anti-Codex is already installed. Use Sync Anti-Codex with Codex for host updates so the active installation and rollback checkpoint stay protected."
}

function Get-AntiCodexSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $hasher.ComputeHash($stream)
        return [BitConverter]::ToString($hash).Replace("-", "")
    } finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Invoke-AntiCodexSourcePreflight {
    if (-not (Test-Path -LiteralPath $SOURCE_PREFLIGHT_SCRIPT -PathType Leaf)) {
        throw "Anti-Codex source preflight is missing: $SOURCE_PREFLIGHT_SCRIPT"
    }
    $global:LASTEXITCODE = 0
    & $SOURCE_PREFLIGHT_SCRIPT -SkipFullRegression | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Anti-Codex source preflight failed. Installation was stopped before copying the host."
    }
}

function Resolve-CodexDesktopHost {
    param([Parameter(Mandatory = $true)][string]$AppRoot)

    $chatGpt = Join-Path $AppRoot "ChatGPT.exe"
    if (Test-Path -LiteralPath $chatGpt -PathType Leaf) { return "ChatGPT.exe" }
    $codexHost = Join-Path $AppRoot "Codex.exe"
    if (Test-Path -LiteralPath $codexHost -PathType Leaf) { return "Codex.exe" }
    return $null
}

function Find-CodexAppRoot {
    $packages = @(
        foreach ($name in @("OpenAI.Codex", "OpenAI.Codex_8wekyb3d8bbwe")) {
            Get-AppxPackage -Name $name -ErrorAction SilentlyContinue
        }
    ) | Sort-Object Version -Descending
    foreach ($pkg in $packages) {
        $appRoot = Join-Path $pkg.InstallLocation "app"
        $hostName = Resolve-CodexDesktopHost -AppRoot $appRoot
        if ($hostName) { return [IO.Path]::GetFullPath($appRoot) }
    }
    throw "Codex Desktop was not found. Install or update Codex first."
}

function Find-PhantomDirectories {
    param([Parameter(Mandatory = $true)][string]$Root)

    return @(Get-ChildItem -LiteralPath $Root -Directory -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
        $directoryPath = [IO.Path]::GetFullPath([string]$_.FullName)
        -not [IO.Directory]::Exists("\\?\$directoryPath")
    } | ForEach-Object {
        [string]$_.FullName
    })
}

function Copy-Tree {
    param([string]$Source, [string]$Destination, [switch]$Mirror)
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    if (Get-Command robocopy.exe -ErrorAction SilentlyContinue) {
        $copyMode = if ($Mirror) { "/MIR" } else { "/E" }
        $copyArguments = @($Source, $Destination, $copyMode, "/XJ", "/COPY:DT", "/DCOPY:DT", "/R:1", "/W:1", "/NFL", "/NDL", "/NP", "/NJH", "/NJS")
        $phantomDirectories = @(Find-PhantomDirectories -Root $Source)
        if ($phantomDirectories.Count -gt 0) {
            $copyArguments += "/XD"
            $copyArguments += $phantomDirectories
        }
        $deferredFiles = @(Get-ChildItem -LiteralPath $Source -Filter "*.dll" -File -Force -ErrorAction Stop | ForEach-Object {
            [string]$_.FullName
        })
        if ($deferredFiles.Count -gt 0) {
            $copyArguments += "/XF"
            $copyArguments += $deferredFiles
        }
        $copyOutput = @()
        for ($attempt = 1; $attempt -le 3; $attempt += 1) {
            $copyOutput = @(& robocopy.exe @copyArguments 2>&1)
            $copyExitCode = $LASTEXITCODE
            if ($copyExitCode -lt 8) {
                foreach ($deferredFile in $deferredFiles) {
                    $deferredDestination = Join-Path $Destination (Split-Path -Leaf $deferredFile)
                    $deferredPending = "$deferredDestination.anticodex-pending"
                    for ($fileAttempt = 1; $fileAttempt -le 5; $fileAttempt += 1) {
                        try {
                            Remove-Item -LiteralPath $deferredPending -Force -ErrorAction SilentlyContinue
                            Copy-Item -LiteralPath $deferredFile -Destination $deferredPending -Force -ErrorAction Stop
                            Move-Item -LiteralPath $deferredPending -Destination $deferredDestination -Force -ErrorAction Stop
                            break
                        } catch {
                            Remove-Item -LiteralPath $deferredPending -Force -ErrorAction SilentlyContinue
                            if ($fileAttempt -eq 5) { throw }
                            Start-Sleep -Seconds (3 * $fileAttempt)
                        }
                    }
                }
                return
            }
            if ($attempt -lt 3) { Start-Sleep -Seconds (15 * $attempt) }
        }
        if ($phantomDirectories.Count -eq 0) {
            try {
                Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force -ErrorAction Stop
                return
            } catch {
                throw "Copy failed after 3 attempts and fallback copy failed (robocopy exit $copyExitCode): $Source; $($_.Exception.Message)"
            }
        }
        $copyTail = (($copyOutput | Select-Object -Last 12) -join " | ").Trim()
        throw "Copy failed after 3 attempts while excluding $($phantomDirectories.Count) unreadable packaged directories (robocopy exit $copyExitCode): $Source; $copyTail"
    }
    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force -ErrorAction Stop
}

function Sync-UnpackedNativeModules {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $sourceRootFull = [IO.Path]::GetFullPath($SourceRoot).TrimEnd("\")
    $destinationRootFull = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd("\")
    $sourceUnpacked = Join-Path $sourceRootFull "resources\app.asar.unpacked"
    $sourceUnpackedExtended = "\\?\$sourceUnpacked"
    if (-not [IO.Directory]::Exists($sourceUnpackedExtended)) {
        throw "Official Codex unpacked resources are missing: $sourceUnpacked"
    }

    $sourceFiles = @(Get-ChildItem -LiteralPath $sourceUnpackedExtended -File -Recurse -Force -ErrorAction Stop | Sort-Object FullName)
    if ($sourceFiles.Count -eq 0) {
        throw "Official Codex unpacked resources contain no files."
    }

    $inventory = New-Object System.Collections.Generic.List[object]
    foreach ($sourceFile in $sourceFiles) {
        $sourceAccessPath = [string]$sourceFile.FullName
        $sourceComparablePath = if ($sourceAccessPath.StartsWith("\\?\", [StringComparison]::Ordinal)) {
            $sourceAccessPath.Substring(4)
        } else {
            $sourceAccessPath = "\\?\$sourceAccessPath"
            [string]$sourceFile.FullName
        }
        $relativePath = $sourceComparablePath.Substring($sourceRootFull.Length).TrimStart("\")
        $destinationPath = [IO.Path]::GetFullPath((Join-Path $destinationRootFull $relativePath))
        if (-not $destinationPath.StartsWith("$destinationRootFull\", [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to copy an unpacked file outside the staged host: $relativePath"
        }
        $destinationAccessPath = "\\?\$destinationPath"
        $sourceHash = Get-AntiCodexSha256 -Path $sourceAccessPath
        $destinationHash = if ([IO.File]::Exists($destinationAccessPath)) {
            Get-AntiCodexSha256 -Path $destinationAccessPath
        } else {
            $null
        }
        if ([string]$destinationHash -ne [string]$sourceHash) {
            [IO.Directory]::CreateDirectory("\\?\$(Split-Path -Parent $destinationPath)") | Out-Null
            [IO.File]::Copy($sourceAccessPath, $destinationAccessPath, $true)
            $destinationHash = Get-AntiCodexSha256 -Path $destinationAccessPath
        }
        if ([string]$destinationHash -ne [string]$sourceHash) {
            throw "Anti-Codex unpacked file copy failed verification: $relativePath"
        }
        $inventory.Add([pscustomobject]@{
            path = $relativePath
            sha256 = $sourceHash
            size = [long]$sourceFile.Length
        }) | Out-Null
    }
    return $inventory.ToArray()
}

function Find-CSharpCompiler {
    $candidates = @(
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $found = Get-Command csc.exe -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    return $null
}

function Resolve-AntiCodexIconPath {
    $icon = Join-Path $ROOT "assets\anticodex.ico"
    if (Test-Path -LiteralPath $icon -PathType Leaf) { return $icon }
    throw "Anti-Codex icon asset is missing: $icon"
}

function Install-AntiCodexHostIcon {
    param([Parameter(Mandatory = $true)][string]$HostRoot)

    $icon = Resolve-AntiCodexIconPath
    $resourceIcon = Join-Path $HostRoot "resources\icon.ico"
    $trayIcon = Join-Path $HostRoot "resources\codex-tray.ico"
    $appRootIcon = Join-Path $HostRoot "icon.ico"
    $resourceDir = Split-Path -Parent $resourceIcon
    if (-not (Test-Path -LiteralPath $resourceDir -PathType Container)) {
        throw "Anti-Codex host resources directory is missing: $resourceDir"
    }
    Copy-Item -LiteralPath $icon -Destination $resourceIcon -Force
    Copy-Item -LiteralPath $icon -Destination $trayIcon -Force
    Copy-Item -LiteralPath $icon -Destination $appRootIcon -Force

    # The executable keeps its original embedded icon resources. Rewriting them
    # makes current endpoint protection remove the copied host on first launch.
    # Window, shortcut, taskbar, and tray branding use the isolated icon files.
    try { & ie4uinit.exe -show | Out-Null } catch {}
}

function Write-HostManifest {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$HostRoot,
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DesktopHostName,
        [Parameter(Mandatory = $true)][int]$HostPatchRevision,
        [Parameter(Mandatory = $true)][object[]]$UnpackedFiles,
        [Parameter(Mandatory = $true)][object]$AsarIntegrity
    )

    $marker = Join-Path $TargetRoot "codex-patched-app.ok"
    $temporaryMarker = "$marker.tmp"
    $sourcePackage = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object {
        try {
            [IO.Path]::GetFullPath((Join-Path $_.InstallLocation "app")) -eq [IO.Path]::GetFullPath($SourceRoot)
        } catch {
            $false
        }
    } | Select-Object -First 1
    $manifest = [ordered]@{
        schema = "anticodex-host-manifest-v2"
        patchProfile = "fixed-shell-v1"
        hostPatchRevision = $HostPatchRevision
        generatedAtUtc = [DateTime]::UtcNow.ToString("o")
        source = [ordered]@{
            packageName = if ($sourcePackage) { [string]$sourcePackage.Name } else { $null }
            packageVersion = if ($sourcePackage) { [string]$sourcePackage.Version } else { $null }
            desktopHostName = $DesktopHostName
            codexHost = Get-AntiCodexSha256 -Path (Join-Path $SourceRoot $DesktopHostName)
            codexCli = Get-AntiCodexSha256 -Path (Join-Path $SourceRoot "resources\codex.exe")
        }
        criticalPatches = @($fixedShellCriticalPatches)
        asarIntegrity = [ordered]@{
            originalHeaderHash = [string]$AsarIntegrity.originalHash
            patchedHeaderHash = [string]$AsarIntegrity.patchedHash
            executablePatched = [bool]$AsarIntegrity.patched
            executablePatchOffset = $AsarIntegrity.offset
        }
        unpackedFiles = @($UnpackedFiles)
        files = [ordered]@{
            antiCodexExe = Get-AntiCodexSha256 -Path (Join-Path $HostRoot "Anti-Codex.exe")
            appAsar = Get-AntiCodexSha256 -Path (Join-Path $HostRoot "resources\app.asar")
            codexCli = Get-AntiCodexSha256 -Path (Join-Path $HostRoot "resources\codex.exe")
            sandboxHelper = Get-AntiCodexSha256 -Path (Join-Path $HostRoot "resources\codex-windows-sandbox-setup.exe")
            nodeRepl = Get-AntiCodexSha256 -Path (Join-Path $HostRoot "resources\cua_node\bin\node_repl.exe")
            nodeRuntime = Get-AntiCodexSha256 -Path (Join-Path $HostRoot "resources\cua_node\bin\node.exe")
            hostIcon = Get-AntiCodexSha256 -Path (Join-Path $HostRoot "resources\icon.ico")
            trayIcon = Get-AntiCodexSha256 -Path (Join-Path $HostRoot "resources\codex-tray.ico")
            appRootIcon = Get-AntiCodexSha256 -Path (Join-Path $HostRoot "icon.ico")
        }
    }
    Remove-Item -LiteralPath $temporaryMarker -Force -ErrorAction SilentlyContinue
    $json = $manifest | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($temporaryMarker, $json, [System.Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporaryMarker, $marker)
}

$runtime = Join-Path $resolvedTarget "runtime"
$copiedCodex = Join-Path $resolvedTarget "codex-patched-app"
$copiedCodexStaging = Join-Path $resolvedTarget "codex-host-staging"
$legacyRuntimeFiles = @(
    "scripts\start-anticodex-scheduled-node.ps1",
    "scripts\start-anticodex-hidden-node.vbs",
    "scripts\start-anticodex-task-hidden.vbs",
    "scripts\start-anticodex-task-hidden.ps1",
    # Older syncs flattened these translator files into the runtime root.
    "antigravity-failure-circuit.mjs",
    "antigravity-request-queue.mjs",
    "antigravity-upstream.mjs",
    "translator\adaptive-server.mjs",
    "translator\server.mjs",
    "translator\antigravity-upstream.mjs",
    "translator\upstream-provider.mjs",
    "translator\compat-rules.mjs",
    "translator\codex-native-harness-turn.mjs",
    "translator\codex-native-protocol.mjs",
    "translator\codex-native-sse.mjs",
    "translator\codex-native-compact.mjs",
    "translator\response-history.mjs",
    "translator\tools\registry.mjs",
    "translator\tools\cache_stability_diff.mjs",
    "translator\antigravity-native-harness-upstream.mjs",
    "translator\antigravity-request-registry.mjs",
    "translator\antigravity-request-queue.mjs",
    "translator\antigravity-session-lock.mjs",
    "translator\antigravity-failure-circuit.mjs",
    "translator\antigravity-readiness.mjs",
    "translator\antigravity-account-tracker.mjs",
    "translator\antigravity-model-route-audit.mjs",
    "translator\probe.mjs",
    "scripts\install-deepcodex.ps1",
    "scripts\start-deepcodex.ps1",
    "scripts\start-adaptive-translator.sh",
    "scripts\deepcodex-translator-watch.sh",
    "scripts\start-deepcodex.sh",
    "scripts\install-deepcodex-app.sh",
    "scripts\deepcodex-setup-ui.mjs",
    "scripts\DeepCodexSetup",
    "scripts\DeepCodexSetup.swift",
    "scripts\enable-deepcodex-plugin-unlock.ps1",
    "scripts\apply-deepcodex-brand.ps1",
    "scripts\deepcodex-plugin-unlock-inject.js",
    "scripts\build-macos-dmg.sh",
    "scripts\build-anticodex-fresh-channel-worker-proof-kit.mjs",
    "scripts\build-anticodex-goal-unblock-package.mjs",
    "scripts\open-anticodex-windows-user-settings.ps1",
    "scripts\prepare-anticodex-antigravity-cli-profile.ps1",
    "scripts\start-anticodex-antigravity-cli-login.ps1",
    "scripts\start-anticodex-antigravity-cli-login-windows-user.ps1",
    "scripts\start-anticodex-second-antigravity-account-login.ps1",
    "scripts\test-anticodex-agentic-capability-matrix.mjs",
    "scripts\test-anticodex-antigravity-account-isolation-status.ps1",
    "scripts\test-anticodex-antigravity-cli-dual-account-lanes.ps1",
    "scripts\test-anticodex-antigravity-cli-isolation.ps1",
    "scripts\test-anticodex-antigravity-cli-real-smoke.ps1",
    "scripts\test-anticodex-antigravity-cli-windows-user-readiness.ps1",
    "scripts\test-anticodex-approved-real-run-sequence.mjs",
    "scripts\test-anticodex-cli-transport-boundary.mjs",
    "scripts\test-anticodex-fresh-channel-worker-proof-kit.test.mjs",
    "scripts\test-anticodex-goal-current-usability.test.mjs",
    "scripts\test-anticodex-goal-readiness.mjs",
    "scripts\test-anticodex-goal-real-run-readiness.mjs",
    "scripts\test-anticodex-goal-unblock-package.test.mjs",
    "scripts\test-anticodex-long-task-landing-matrix.mjs",
    "scripts\test-anticodex-native-codex-parity-tasks.mjs",
    "scripts\test-anticodex-provider-antigravity-return.ps1",
    "scripts\test-anticodex-real-approval-plan.mjs",
    "scripts\test-anticodex-real-task-coverage-roadmap.mjs",
    "scripts\test-anticodex-real-third-party-provider.mjs",
    "scripts\test-anticodex-required-real-traffic-sequence.ps1",
    "scripts\test-anticodex-second-account-login-entrypoint.ps1",
    "scripts\test-anticodex-second-account-post-login-proof.ps1",
    "scripts\test-anticodex-second-account-readiness-summary.ps1",
    "scripts\test-anticodex-third-party-provider.mjs",
    "scripts\test-anticodex-windows-user-account-prepare.ps1",
    "scripts\test-anticodex-windows-user-setup-guidance.ps1",
    "scripts\test-anticodex-xiaoqiang-current-channel-live-proof.mjs",
    "scripts\test-anticodex-xiaoqiang-mcp.mjs",
    "scripts\test-anticodex-xiaoqiang-usage-ledger.mjs"
)
Invoke-AntiCodexSourcePreflight
$sourceCodex = if ($SourceRoot) {
    $explicitSource = [IO.Path]::GetFullPath($SourceRoot)
    if (-not (Resolve-CodexDesktopHost -AppRoot $explicitSource)) {
        throw "The selected Codex source root has no desktop host: $explicitSource"
    }
    $explicitSource
} else {
    Find-CodexAppRoot
}
$hostMarker = Join-Path $resolvedTarget "codex-patched-app.ok"

# A marker is valid only for a fully patched host whose hashes were recorded last.
Remove-Item -LiteralPath $hostMarker -Force -ErrorAction SilentlyContinue

if (-not $HostOnly) {
    foreach ($dir in @("scripts", "translator", "assets", "codex-home-deepseek-app")) {
        Copy-Tree (Join-Path $ROOT $dir) (Join-Path $runtime $dir)
    }
    foreach ($relative in $legacyRuntimeFiles) {
        $legacyPath = [IO.Path]::GetFullPath((Join-Path $runtime $relative))
        if (-not $legacyPath.StartsWith([IO.Path]::GetFullPath($runtime), [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove Anti-Codex legacy runtime file outside $runtime"
        }
        if (Test-Path -LiteralPath $legacyPath -PathType Leaf) {
            Remove-Item -LiteralPath $legacyPath -Force
        }
    }
    $codexPlusPlusInstaller = Join-Path $ROOT "scripts\install-codexplusplus-component.ps1"
    if (-not (Test-Path -LiteralPath $codexPlusPlusInstaller -PathType Leaf)) {
        throw "Anti-Codex CodexPlusPlus component installer is missing: $codexPlusPlusInstaller"
    }
    & $codexPlusPlusInstaller -InstallRoot $resolvedTarget | Out-Null
    $sharedMcpInstaller = Join-Path $ROOT "scripts\install-anticodex-shared-mcp.ps1"
    $sharedMcpSource = Join-Path $ROOT "scripts\anticodex_shared_mcp_proxy.py"
    if (-not (Test-Path -LiteralPath $sharedMcpInstaller -PathType Leaf) -or
        -not (Test-Path -LiteralPath $sharedMcpSource -PathType Leaf)) {
        throw "Anti-Codex shared MCP component source is incomplete."
    }
    & $sharedMcpInstaller -InstallRoot $resolvedTarget -SourceScript $sharedMcpSource | Out-Null
    foreach ($requiredRuntimePath in @(
        (Join-Path $runtime "scripts\antigravity-desktop.ps1"),
        (Join-Path $runtime "scripts\apply-anticodex-upstream.ps1"),
        (Join-Path $runtime "scripts\start-anticodex.ps1"),
        (Join-Path $runtime "scripts\hide-anticodex-console.ps1"),
        (Join-Path $runtime "scripts\start-anticodex-task.mjs"),
        (Join-Path $runtime "scripts\start-anticodex-shortcut-broker.ps1"),
        (Join-Path $runtime "scripts\start-anticodex-update-task.mjs"),
        (Join-Path $runtime "scripts\start-anticodex-fixed-route.mjs"),
        (Join-Path $runtime "scripts\anticodex-manager-service.mjs"),
        (Join-Path $runtime "scripts\anticodex-antigravity-accounts.mjs"),
        (Join-Path $runtime "scripts\anticodex-antigravity-accounts-driver.mjs"),
        (Join-Path $runtime "scripts\anticodex-antigravity-credentials.ps1"),
        (Join-Path $runtime "scripts\anticodex-antigravity-login.mjs"),
        (Join-Path $runtime "scripts\build-anticodex-gate5-evidence.mjs"),
        (Join-Path $runtime "scripts\build-anticodex-gate8-autonomous-video-evidence.mjs"),
        (Join-Path $runtime "scripts\install-codexplusplus-component.ps1"),
        (Join-Path $runtime "scripts\install-anticodex-shared-mcp.ps1"),
        (Join-Path $runtime "scripts\anticodex_shared_mcp_proxy.py"),
        (Join-Path $runtime "scripts\test-codexplusplus-antigravity-route-switch.mjs"),
        (Join-Path $runtime "scripts\test-anticodex-gate8-autonomous-video.mjs"),
        (Join-Path $runtime "scripts\test-anticodex-shortcut-restore.ps1"),
        (Join-Path $runtime "scripts\anticodex-report-io.ps1"),
        (Join-Path $runtime "scripts\lib\anticodex-fixed-route.mjs"),
        (Join-Path $runtime "scripts\lib\anticodex-gate4-runtime.mjs"),
        (Join-Path $runtime "scripts\lib\anticodex-gate8-evidence.mjs"),
        (Join-Path $runtime "scripts\lib\anticodex-release-binding.mjs"),
        (Join-Path $runtime "scripts\deepcodex-cdp-inject.mjs"),
        (Join-Path $runtime "scripts\anticodex-manager-bridge.mjs"),
        (Join-Path $runtime "scripts\anticodex-manager-inject.js"),
        (Join-Path $runtime "scripts\anticodex-manager-open-inject.js"),
        (Join-Path $runtime "scripts\anticodex-update-status.psm1"),
        (Join-Path $runtime "scripts\sync-anticodex.ps1"),
        (Join-Path $runtime "scripts\rollback-anticodex.ps1"),
        (Join-Path $runtime "scripts\manage-anticodex.ps1"),
        (Join-Path $runtime "translator\antigravity-model-catalog.mjs"),
        (Join-Path $runtime "translator\antigravity-contract.mjs"),
        (Join-Path $runtime "translator\antigravity-native-mcp-bridge.mjs"),
        (Join-Path $runtime "translator\provider\antigravity-cascade-client.mjs"),
        (Join-Path $runtime "translator\provider\antigravity-chat-adapter.mjs"),
        (Join-Path $runtime "translator\provider\antigravity-chat-server.mjs"),
        (Join-Path $runtime "translator\provider\codexplusplus-upstream-probe.mjs"),
        (Join-Path $runtime "translator\provider\start-antigravity-chat-provider.mjs"),
        (Join-Path $runtime "codex-home-deepseek-app\config.adaptive-oneapi.toml")
    )) {
        if (-not (Test-Path -LiteralPath $requiredRuntimePath -PathType Leaf)) {
            throw "Anti-Codex runtime is incomplete: $requiredRuntimePath"
        }
    }
}
if (Test-Path -LiteralPath $copiedCodexStaging) {
    [IO.Directory]::Delete("\\?\$([IO.Path]::GetFullPath($copiedCodexStaging))", $true)
}
Copy-Tree $sourceCodex $copiedCodexStaging -Mirror
$unpackedFiles = @(Sync-UnpackedNativeModules -SourceRoot $sourceCodex -DestinationRoot $copiedCodexStaging)

$stagedDesktopHost = Resolve-CodexDesktopHost -AppRoot $copiedCodexStaging
if (-not $stagedDesktopHost) {
    throw "The copied Codex host is missing a desktop host executable (ChatGPT.exe or Codex.exe)."
}
foreach ($requiredHostFile in @(
    $stagedDesktopHost,
    "resources\app.asar",
    "resources\codex.exe",
    "resources\codex-windows-sandbox-setup.exe",
    "resources\cua_node\bin\node_repl.exe",
    "resources\cua_node\bin\node.exe"
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $copiedCodexStaging $requiredHostFile) -PathType Leaf)) {
        throw "The copied Codex host is incomplete: $requiredHostFile"
    }
}
if (Test-Path -LiteralPath $copiedCodex) {
    [IO.Directory]::Delete("\\?\$([IO.Path]::GetFullPath($copiedCodex))", $true)
}
Move-Item -LiteralPath $copiedCodexStaging -Destination $copiedCodex
$sourceDesktopHostPath = Join-Path $copiedCodex $stagedDesktopHost
$antiCodexHost = Join-Path $copiedCodex "Anti-Codex.exe"
Copy-Item -LiteralPath $sourceDesktopHostPath -Destination $antiCodexHost -Force
Install-AntiCodexHostIcon -HostRoot $copiedCodex
$brandScript = Join-Path $ROOT "scripts\brand-patched-asar.mjs"
$brandProfileDropdown = Join-Path $ROOT "scripts\brand-profile-dropdown.mjs"
foreach ($requiredBrandScript in @($brandScript, $brandProfileDropdown)) {
    if (-not (Test-Path -LiteralPath $requiredBrandScript -PathType Leaf)) {
        throw "Anti-Codex branding component is missing: $requiredBrandScript"
    }
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$brandOutput = @(& $node $brandScript (Join-Path $copiedCodex "resources\app.asar") --profile fixed-shell-v1 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw "Critical Anti-Codex compatibility patches failed. No valid host marker was created."
}
$brandResult = try { (($brandOutput -join [Environment]::NewLine) | ConvertFrom-Json) } catch { throw "Anti-Codex compatibility patch receipt is invalid." }
if ([string]$brandResult.hostPatchRevision -ne "7") {
    throw "Anti-Codex compatibility patch revision is invalid."
}
$asarIntegrityHostScript = Join-Path $ROOT "scripts\electron-asar-integrity-host.mjs"
if (-not (Test-Path -LiteralPath $asarIntegrityHostScript -PathType Leaf)) {
    throw "Anti-Codex Electron ASAR integrity host patcher is missing."
}
$asarIntegrityOutput = @(& $node $asarIntegrityHostScript --patch $sourceDesktopHostPath $antiCodexHost ([string]$brandResult.oldHeaderHash) ([string]$brandResult.newHeaderHash) 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw "Anti-Codex isolated launcher ASAR integrity patch failed."
}
$asarIntegrityResult = try { (($asarIntegrityOutput -join [Environment]::NewLine) | ConvertFrom-Json) } catch { throw "Anti-Codex isolated launcher ASAR integrity receipt is invalid." }
if ($asarIntegrityResult.ok -ne $true -or
    [string]$asarIntegrityResult.originalHash -ne [string]$brandResult.oldHeaderHash -or
    [string]$asarIntegrityResult.patchedHash -ne [string]$brandResult.newHeaderHash) {
    throw "Anti-Codex isolated launcher ASAR integrity receipt does not match the patched archive."
}
if ((Get-AntiCodexSha256 -Path $sourceDesktopHostPath) -ne (Get-AntiCodexSha256 -Path (Join-Path $sourceCodex $stagedDesktopHost))) {
    throw "Anti-Codex copied source host bytes changed during activation."
}
Write-HostManifest -TargetRoot $resolvedTarget -HostRoot $copiedCodex -SourceRoot $sourceCodex -DesktopHostName $stagedDesktopHost -HostPatchRevision ([int]$brandResult.hostPatchRevision) -UnpackedFiles $unpackedFiles -AsarIntegrity $asarIntegrityResult

$snapshotSync = Join-Path $runtime "scripts\sync-shared-codex-plugin-host.mjs"
if (Test-Path -LiteralPath $snapshotSync -PathType Leaf) {
    try {
        $isolatedCodexHome = Join-Path (Join-Path $env:APPDATA "anticodex") "codex-home-deepseek-app"
        $sharedCodexHome = Join-Path $env:USERPROFILE ".codex"
        $snapshotOutput = & $node $snapshotSync $isolatedCodexHome $sharedCodexHome --local-snapshots 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "snapshot command failed: $(($snapshotOutput | Out-String).Trim())"
        }
        $snapshotResult = (($snapshotOutput | Out-String).Trim() | ConvertFrom-Json)
        if ($snapshotResult.ok -ne $true) {
            throw "snapshot reported a copy failure"
        }
    } catch {
        Write-Warning "Anti-Codex host is ready, but the optional full local feature snapshot needs a later Manager refresh: $($_.Exception.Message)"
    }
}

if (-not $HostOnly) {
    $shortcutRepair = Join-Path $runtime "scripts\repair-anticodex-shortcuts.ps1"
    if (-not (Test-Path -LiteralPath $shortcutRepair -PathType Leaf)) {
        throw "Anti-Codex shortcut repair is missing: $shortcutRepair"
    }
    $shortcutRepairJson = (@(& $shortcutRepair -InstallRoot $resolvedTarget) -join [Environment]::NewLine)
    $shortcutRepairResult = $shortcutRepairJson | ConvertFrom-Json
    if (-not $shortcutRepairResult.ok) {
        throw "Anti-Codex shortcuts could not be installed."
    }
}

Write-Host "Anti-Codex installed."
Write-Host "  Runtime:  $runtime"
