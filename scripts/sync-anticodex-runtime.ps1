[CmdletBinding()]
param(
    [string]$SourceRoot = "",
    [string]$TargetRuntime = $(Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime"),
    [string]$BaseUrl = "",
    [switch]$NoRestart,
    [int]$TimeoutSec = 45
)

if ($PSVersionTable.PSEdition -eq "Core") {
    $windowsPowerShell = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
        throw "Windows PowerShell is required to synchronize the Anti-Codex runtime: $windowsPowerShell"
    }
    $delegateArgs = @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-TargetRuntime", $TargetRuntime,
        "-TimeoutSec", "$TimeoutSec"
    )
    if ($SourceRoot) { $delegateArgs += @("-SourceRoot", $SourceRoot) }
    if ($BaseUrl) { $delegateArgs += @("-BaseUrl", $BaseUrl) }
    if ($NoRestart) { $delegateArgs += "-NoRestart" }
    $delegateOutput = & $windowsPowerShell @delegateArgs
    $delegateExitCode = $LASTEXITCODE
    if ($delegateExitCode -ne 0) {
        throw "Windows PowerShell Anti-Codex runtime sync exited with code $delegateExitCode."
    }
    $delegateOutput
    return
}

$ErrorActionPreference = "Stop"

if (-not ("AntiCodex.Native.VerifiedProcessHandle" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace AntiCodex.Native
{
    public sealed class VerifiedProcessHandle : IDisposable
    {
        private const uint ProcessTerminate = 0x0001;
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint Synchronize = 0x00100000;
        private const uint WaitObject0 = 0x00000000;
        private const uint WaitTimeout = 0x00000102;
        private IntPtr handle;

        [StructLayout(LayoutKind.Sequential)]
        private struct FileTime
        {
            public uint Low;
            public uint High;
            public long ToInt64()
            {
                return ((long)High << 32) | Low;
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr value);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetProcessId(IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(
            IntPtr process,
            out FileTime creation,
            out FileTime exit,
            out FileTime kernel,
            out FileTime user);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(
            IntPtr process,
            uint flags,
            StringBuilder executablePath,
            ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr value, uint milliseconds);

        private VerifiedProcessHandle(IntPtr value, int processId, long creationFileTimeUtcTicks, string executablePath)
        {
            handle = value;
            ProcessId = processId;
            CreationFileTimeUtcTicks = creationFileTimeUtcTicks;
            ExecutablePath = executablePath;
        }

        public int ProcessId { get; private set; }
        public long CreationFileTimeUtcTicks { get; private set; }
        public string ExecutablePath { get; private set; }
        public bool HasExited
        {
            get
            {
                uint result = WaitForSingleObject(handle, 0);
                if (result == WaitObject0) return true;
                if (result == WaitTimeout) return false;
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not inspect the bound process handle.");
            }
        }

        public static VerifiedProcessHandle Open(int processId)
        {
            IntPtr value = OpenProcess(ProcessTerminate | ProcessQueryLimitedInformation | Synchronize, false, processId);
            if (value == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open the exact process.");
            try
            {
                uint boundProcessId = GetProcessId(value);
                if (boundProcessId != (uint)processId)
                    throw new InvalidOperationException("The opened process handle did not retain the requested PID identity.");
                FileTime creation;
                FileTime exit;
                FileTime kernel;
                FileTime user;
                if (!GetProcessTimes(value, out creation, out exit, out kernel, out user))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not query process creation time through the bound handle.");
                StringBuilder executablePath = new StringBuilder(32768);
                int size = executablePath.Capacity;
                if (!QueryFullProcessImageName(value, 0, executablePath, ref size))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not query the executable through the bound handle.");
                VerifiedProcessHandle result = new VerifiedProcessHandle(
                    value,
                    processId,
                    creation.ToInt64(),
                    executablePath.ToString());
                value = IntPtr.Zero;
                return result;
            }
            finally
            {
                if (value != IntPtr.Zero) CloseHandle(value);
            }
        }

        public void TerminateAndWait(int timeoutMilliseconds)
        {
            if (HasExited) return;
            if (!TerminateProcess(handle, 1))
            {
                if (HasExited) return;
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not terminate the bound process handle.");
            }
            uint waitResult = WaitForSingleObject(handle, checked((uint)timeoutMilliseconds));
            if (waitResult == WaitObject0) return;
            if (waitResult == WaitTimeout)
                throw new TimeoutException("The bound process did not exit before the timeout.");
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not wait on the bound process handle.");
        }

        public void Dispose()
        {
            if (handle == IntPtr.Zero) return;
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }
}
'@
}

$startedAt = [DateTime]::UtcNow
$scriptRoot = Split-Path -Parent $PSCommandPath
if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $scriptRoot }
$sourceRootFull = [IO.Path]::GetFullPath($SourceRoot)
$targetRuntimeFull = [IO.Path]::GetFullPath($TargetRuntime)
$expectedRuntime = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime"))
$antiCodexStateRoot = Join-Path $env:APPDATA "anticodex"
$fixedRouteHealthUrl = "http://127.0.0.1:18487/anticodex/fixed-route/health"
if ($targetRuntimeFull -ne $expectedRuntime) {
    throw "Refusing to sync Anti-Codex runtime outside $expectedRuntime"
}
$installRootFull = [IO.Path]::GetFullPath((Split-Path -Parent $targetRuntimeFull))
$runtimeVersionsRoot = Join-Path $installRootFull "runtime-versions"
$runtimeSyncStatePath = Join-Path $installRootFull "runtime-sync-state.json"
$transactionId = "{0}-{1}" -f ([DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")), ([guid]::NewGuid().ToString("N"))
$stagedRuntimeFull = [IO.Path]::GetFullPath((Join-Path $runtimeVersionsRoot "staged-$transactionId"))
$rollbackRuntimeFull = [IO.Path]::GetFullPath((Join-Path $runtimeVersionsRoot "rollback-$transactionId"))

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

function Get-AntiCodexSourceGitRevision {
    $gitCommand = Get-Command "git" -ErrorAction SilentlyContinue
    if (-not $gitCommand) {
        return [pscustomobject]@{ head = ""; clean = $false; provenance = "unverified" }
    }
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        $global:LASTEXITCODE = 0
        $rootOutput = @(& $gitCommand.Source -C $sourceRootFull rev-parse --show-toplevel 2>$null)
        $rootExitCode = $LASTEXITCODE
        $gitRoot = @($rootOutput | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -First 1)
        $gitRoot = if ($gitRoot.Count -gt 0) { [string]$gitRoot[0] } else { "" }
        try { $gitRoot = [IO.Path]::GetFullPath($gitRoot).TrimEnd("\") } catch { $gitRoot = "" }
        if ($rootExitCode -ne 0 -or
            -not $gitRoot.Equals($sourceRootFull.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
            return [pscustomobject]@{ head = ""; clean = $false; provenance = "unverified" }
        }
        $global:LASTEXITCODE = 0
        $headOutput = @(& $gitCommand.Source -C $sourceRootFull rev-parse HEAD 2>$null)
        $headExitCode = $LASTEXITCODE
        $head = @($headOutput | Where-Object { [string]$_ -match "^[a-fA-F0-9]{40}$" } | Select-Object -First 1)
        $head = if ($head.Count -gt 0) { [string]$head[0] } else { "" }
        if ($headExitCode -ne 0 -or $head -notmatch "^[a-fA-F0-9]{40}$") {
            return [pscustomobject]@{ head = ""; clean = $false; provenance = "unverified" }
        }
        $global:LASTEXITCODE = 0
        $statusOutput = @(& $gitCommand.Source -C $sourceRootFull status --porcelain=v1 --untracked-files=normal 2>$null)
        $statusExitCode = $LASTEXITCODE
        $clean = $statusExitCode -eq 0 -and @($statusOutput | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -eq 0
        return [pscustomobject]@{
            head = $head.ToLowerInvariant()
            clean = $clean
            provenance = if ($clean) { "git" } else { "unverified" }
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Test-AntiCodexRuntimeSyncFixture {
    if ([string]::IsNullOrWhiteSpace([string]$env:ANTICODEX_RUNTIME_SYNC_TEST_ROOT)) {
        return $false
    }
    try {
        return ([IO.Path]::GetFullPath([string]$env:ANTICODEX_RUNTIME_SYNC_TEST_ROOT)).Equals(
            $installRootFull,
            [StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

function Test-AntiCodexRuntimeSyncNoProcessFixture {
    return [string]$env:ANTICODEX_RUNTIME_SYNC_TEST_NO_PROCESSES -ceq "1" -and
        (Test-AntiCodexRuntimeSyncFixture)
}

$requiredSourceFiles = @(
    "scripts\antigravity-desktop.ps1",
    "scripts\apply-anticodex-upstream.ps1",
    "scripts\repair-anticodex-shortcuts.ps1",
    "scripts\start-anticodex-shortcut-broker.ps1",
    "scripts\start-anticodex.ps1",
    "scripts\hide-anticodex-console.ps1",
    "scripts\start-anticodex-task.mjs",
    "scripts\start-anticodex-update-task.mjs",
    "scripts\start-anticodex-fixed-route.mjs",
    "scripts\anticodex-manager-service.mjs",
    "scripts\open-antigravity-account-switch.ps1",
    "scripts\build-anticodex-gate5-evidence.mjs",
    "scripts\build-anticodex-gate8-autonomous-video-evidence.mjs",
    "scripts\install-codexplusplus-component.ps1",
    "scripts\install-anticodex-shared-mcp.ps1",
    "scripts\anticodex_shared_mcp_proxy.py",
    "third_party\codexplusplus\upstream.json",
    "third_party\codexplusplus\patches\0001-isolation-scope-Anti-Codex-companion-runtime.patch",
    "third_party\codexplusplus\patches\0002-cancel-loopback-streams-without-resets.patch",
    "third_party\codexplusplus\patches\0003-native-codex-helper-requests-text-only.patch",
    "third_party\codexplusplus\patches\0004-route-anticodex-model-slots.patch",
    "third_party\codexplusplus\patches\0005-preserve-image-tool-outputs-for-chat-relays.patch",
    "third_party\codexplusplus\patches\0006-guide-models-to-structured-patch-tools.patch",
    "third_party\codexplusplus\patches\0007-ignore-late-reasoning-after-visible-text.patch",
    "third_party\codexplusplus\patches\0008-chore-audit-Codex-tool-conversion.patch",
    "third_party\codexplusplus\patches\0009-fix-allow-long-multimodal-helper-requests.patch",
    "third_party\codexplusplus\patches\0010-fix-estimate-missing-chat-usage-for-native-compaction.patch",
    "third_party\codexplusplus\patches\0011-apply-anticodex-prompt-policy-at-common-request-entry.patch",
    "third_party\codexplusplus\patches\0013-fix-format-dreamskin-installer-test.patch",
    "third_party\codexplusplus\patches\0014-fix-format-dreamskin-runtime-test.patch",
    "third_party\codexplusplus\patches\0015-enforce-Anti-Codex-command-tool-safety.patch",
    "third_party\codexplusplus\patches\0016-block-forced-Docker-interruption.patch",
    "scripts\lib\anticodex-fixed-route.mjs",
    "scripts\lib\anticodex-owner-process.mjs",
    "scripts\lib\anticodex-release-binding.mjs",
    "scripts\anticodex-update-status.psm1",
    "scripts\brand-profile-dropdown.mjs",
    "scripts\sync-anticodex.ps1",
    "scripts\sync-anticodex-launcher.ps1",
    "scripts\rollback-anticodex.ps1",
    "scripts\rollback-anticodex-launcher.ps1",
    "scripts\manage-anticodex.ps1",
    "scripts\check-anticodex-update.ps1",
    "scripts\deepcodex-cdp-inject.mjs",
    "scripts\anticodex-manager-bridge.mjs",
    "scripts\anticodex-manager-inject.js",
    "scripts\anticodex-manager-open-inject.js",
    "scripts\anticodex-report-io.ps1",
    "scripts\anticodex-powershell-json-invoke.ps1",
    "scripts\collect-anticodex-diagnostics.ps1",
    "scripts\protect-anticodex-log-db.mjs",
    "scripts\refresh-anticodex-local-features.ps1",
    "scripts\resolve-anticodex-base-url.ps1",
    "scripts\summarize-anticodex-report.mjs",
    "scripts\test-anticodex-account-proxy-readiness.ps1",
    "scripts\test-anticodex-cold-relaunch.ps1",
    "scripts\test-anticodex-cancellation.ps1",
    "scripts\test-anticodex-codex-responses.ps1",
    "scripts\test-anticodex-compaction-resume.ps1",
    "scripts\test-anticodex-native-compaction-resume.mjs",
    "scripts\test-anticodex-gate8-final-long-task.mjs",
    "scripts\test-anticodex-gate8-autonomous-video.mjs",
    "scripts\test-anticodex-gate8-final-long-task.ps1",
    "scripts\test-anticodex-gate8-quota-probe.ps1",
    "scripts\test-anticodex-custom-tool-loop.ps1",
    "scripts\test-anticodex-diagnostics.ps1",
    "scripts\test-anticodex-installed-overall.ps1",
    "scripts\test-anticodex-ambient-suggestions.ps1",
    "scripts\test-anticodex-local-connectors.mjs",
    "scripts\test-anticodex-manager-action.ps1",
    "scripts\test-anticodex-manager-button.mjs",
    "scripts\test-anticodex-manager-real-buttons.ps1",
    "scripts\test-anticodex-mcp-skills.ps1",
    "scripts\test-anticodex-worker-process-hygiene.mjs",
    "scripts\test-anticodex-codex-appserver-freshness.mjs",
    "scripts\test-anticodex-mcp-tool-loop.ps1",
    "scripts\test-anticodex-missing-history.mjs",
    "scripts\test-anticodex-model-routing.ps1",
    "scripts\test-anticodex-model-switch-history.ps1",
    "scripts\test-anticodex-model-thinking.ps1",
    "scripts\test-anticodex-native-multi-tool-loop.ps1",
    "scripts\test-anticodex-native-tool-loop.ps1",
    "scripts\test-anticodex-plugin-capabilities.ps1",
    "scripts\test-anticodex-post-verification.ps1",
    "scripts\test-anticodex-release-gates.mjs",
    "scripts\test-anticodex-legacy-zero-hit.mjs",
    "scripts\test-codexplusplus-third-party-route.ps1",
    "scripts\test-codexplusplus-antigravity-route-switch.mjs",
    "scripts\test-antigravity-chat-adapter-contract.mjs",
    "scripts\test-antigravity-chat-adapter-edge-contract.mjs",
    "scripts\test-anticodex-gate5-visible-integration.mjs",
    "scripts\test-anticodex-real-work.ps1",
    "scripts\test-anticodex-real-mini-tool.ps1",
    "scripts\test-anticodex-real-report-site.ps1",
    "scripts\test-anticodex-real-small-project.ps1",
    "scripts\test-anticodex-source-preflight.ps1",
    "scripts\test-anticodex-stability-soak.ps1",
    "scripts\test-anticodex-shortcut-restore.ps1",
    "scripts\test-anticodex-sync-readiness.ps1",
    "scripts\test-anticodex-tool-bridge-mode.ps1",
    "scripts\test-anticodex-tool-loop.ps1",
    "scripts\test-anticodex-ui-state.mjs",
    "scripts\test-anticodex-ui-state.ps1",
    "scripts\test-anticodex-ui-idle-stability.ps1",
    "scripts\read-anticodex-native-request-snapshot.mjs",
    "scripts\test-anticodex-desktop-task-suite.mjs",
    "scripts\test-anticodex-conversation-hygiene.mjs",
    "scripts\lib\ui-chat-marker-evidence.mjs",
    "scripts\lib\native-codex-rollout-history.mjs",
    "scripts\lib\anticodex-gate4-runtime.mjs",
    "scripts\lib\anticodex-gate8-evidence.mjs",
    "scripts\lib\anticodex-native-request-activity.mjs",
    "scripts\test-anticodex-ui-chat-smoke.mjs",
    "scripts\test-anticodex-human-edge-matrix.mjs",
    "scripts\test-anticodex-human-long-journey.mjs",
    "scripts\test-anticodex-human-long-journey.ps1",
    "scripts\test-anticodex-web-tools.ps1",
    "translator\antigravity-agentapi.mjs",
    "translator\antigravity-model-catalog.mjs",
    "translator\antigravity-contract.mjs",
    "translator\antigravity-native-mcp-bridge.mjs",
    "translator\provider\antigravity-cascade-client.mjs",
    "translator\provider\anticodex-prompt-policy.mjs",
    "translator\provider\antigravity-chat-adapter.mjs",
    "translator\provider\antigravity-chat-server.mjs",
    "translator\provider\codexplusplus-upstream-probe.mjs",
    "translator\provider\start-antigravity-chat-provider.mjs",
    "translator\local-projection\index.mjs",
    "translator\sync-antigravity-model-catalog.mjs",
    "codex-home-deepseek-app\config.adaptive-oneapi.toml"
)
foreach ($relative in $requiredSourceFiles) {
    $path = Join-Path $sourceRootFull $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Anti-Codex source runtime component missing: $relative"
    }
}
$sourceRevisionBefore = Get-AntiCodexSourceGitRevision
if ([string]$sourceRevisionBefore.provenance -cne "git" -or
    -not [bool]$sourceRevisionBefore.clean -or
    [string]$sourceRevisionBefore.head -notmatch "^[a-fA-F0-9]{40}$") {
    throw "Anti-Codex runtime sync requires a clean Git revision rooted exactly at the source directory."
}

function Copy-AntiCodexRuntimeTree {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    if (Get-Command robocopy.exe -ErrorAction SilentlyContinue) {
        $args = @($Source, $Destination, "/E", "/XJ", "/COPY:DT", "/DCOPY:DT", "/R:1", "/W:1", "/NFL", "/NDL", "/NP", "/NJH", "/NJS")
        $null = & robocopy.exe @args
        $code = $LASTEXITCODE
        if ($code -lt 8) { return }
        throw "robocopy failed with exit code $code while copying $Source"
    }
    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force -ErrorAction Stop
}

function Copy-AntiCodexPublicDocs {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $publicDocFiles = @(
        "README.md",
        "README_EN.md",
        "docs\ADAPTIVE_ONE_API_STACK.md",
        "docs\WINDOWS.md",
        "docs\chat-to-responses-compat.md",
        "docs\DEEPSEEK_RUNTIME_FAILURE_NOTES.md",
        "docs\audits\2026-07-14-codexplusplus-runtime-isolation.json",
        "docs\audits\2026-07-14-codexplusplus-third-party-route.json",
        "docs\audits\2026-07-14-antigravity-chat-adapter-contract.json",
        "docs\audits\2026-07-14-gate4-isolated-route-switch.json",
        "docs\audits\2026-07-15-gate5-visible-integration.json",
        "docs\audits\2026-07-15-gate5-visible-integration.json.sha256",
        "docs\audits\2026-07-15-gate6-edge-matrix.json",
        "docs\audits\2026-07-15-gate6-edge-matrix.json.sha256",
        "docs\marketing\legacy\deepcodex-video-script.md",
        "docs\marketing\launch-post.md",
        "docs\marketing\video-script.md",
        "docs\marketing\wechat-article.md"
    )
    foreach ($relative in $publicDocFiles) {
        $source = Join-Path $SourceRoot $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Anti-Codex public documentation source missing: $relative"
        }
        $destination = Join-Path $DestinationRoot $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}

$legacyRuntimeFiles = @(
    "scripts\AntiCodexLauncher.cs",
    "scripts\start-anticodex-scheduled-node.ps1",
    "scripts\start-anticodex-hidden-node.vbs",
    "scripts\start-anticodex-task.cmd",
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
    "scripts\test-anticodex-cli-transport-boundary.mjs",
    "scripts\test-anticodex-third-party-provider.mjs",
    "scripts\test-anticodex-real-third-party-provider.mjs",
    "scripts\test-anticodex-provider-antigravity-return.ps1",
    "scripts\prepare-anticodex-antigravity-cli-profile.ps1",
    "scripts\start-anticodex-antigravity-cli-login.ps1",
    "scripts\start-anticodex-antigravity-cli-login-windows-user.ps1",
    "scripts\open-anticodex-windows-user-settings.ps1",
    "scripts\start-anticodex-second-antigravity-account-login.ps1",
    "scripts\test-anticodex-second-account-readiness-summary.ps1",
    "scripts\test-anticodex-second-account-login-entrypoint.ps1",
    "scripts\test-anticodex-second-account-post-login-proof.ps1",
    "scripts\test-anticodex-antigravity-cli-dual-account-lanes.ps1",
    "scripts\test-anticodex-antigravity-cli-isolation.ps1",
    "scripts\test-anticodex-antigravity-cli-windows-user-readiness.ps1",
    "scripts\test-anticodex-antigravity-account-isolation-status.ps1",
    "scripts\test-anticodex-antigravity-cli-real-smoke.ps1",
    "scripts\test-anticodex-windows-user-account-prepare.ps1",
    "scripts\test-anticodex-windows-user-setup-guidance.ps1",
    "scripts\test-anticodex-xiaoqiang-current-channel-live-proof.mjs",
    "scripts\test-anticodex-xiaoqiang-mcp.mjs",
    "scripts\test-anticodex-xiaoqiang-usage-ledger.mjs",
    "scripts\probe-anticodex-worker-mcp-servers.mjs",
    "scripts\test-anticodex-worker-mcp-source-hygiene.mjs",
    "scripts\test-anticodex-worker-mcp-status-probe.mjs",
    "scripts\record-anticodex-current-channel-worker-transport.mjs",
    "scripts\test-anticodex-current-channel-worker-recovery.mjs",
    "scripts\test-anticodex-current-channel-worker-recovery.ps1",
    "scripts\build-anticodex-goal-unblock-package.mjs",
    "scripts\build-anticodex-fresh-channel-worker-proof-kit.mjs",
    "scripts\test-anticodex-worker-mcp-task-smoke.mjs",
    "scripts\test-anticodex-goal-readiness.mjs",
    "scripts\test-anticodex-goal-real-run-readiness.mjs",
    "scripts\test-anticodex-real-approval-plan.mjs",
    "scripts\test-anticodex-required-real-traffic-sequence.ps1",
    "scripts\test-anticodex-approved-real-run-sequence.mjs",
    "scripts\test-anticodex-goal-current-usability.test.mjs",
    "scripts\test-anticodex-goal-unblock-package.test.mjs",
    "scripts\test-anticodex-fresh-channel-worker-proof-kit.test.mjs",
    "scripts\test-anticodex-agentic-capability-matrix.mjs",
    "scripts\test-anticodex-real-task-coverage-roadmap.mjs",
    "scripts\test-anticodex-long-task-landing-matrix.mjs",
    "scripts\test-anticodex-native-codex-parity-tasks.mjs"
)

function Test-AntiCodexPathInsideRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    try {
        $fullPath = [IO.Path]::GetFullPath($Path)
        $rootPrefix = [IO.Path]::GetFullPath($Root).TrimEnd("\") + "\"
        return $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Test-AntiCodexNativeCodexPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        return ([IO.Path]::GetFullPath($Path)).IndexOf("\WindowsApps\OpenAI.Codex_", [StringComparison]::OrdinalIgnoreCase) -ge 0
    } catch {
        return $true
    }
}

function Test-AntiCodexCommandLineHasExactPath {
    param(
        [Parameter(Mandatory = $true)][string]$CommandLine,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $fullPath = [IO.Path]::GetFullPath($Path)
    $pattern = '(^|[\s"])' + [regex]::Escape($fullPath) + '($|[\s"])'
    return [regex]::IsMatch($CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Test-AntiCodexCommandLineReferencesPathRoot {
    param(
        [Parameter(Mandatory = $true)][string]$CommandLine,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd("\")
    $pattern = '(^|[\s"''=])' + [regex]::Escape($fullPath) + '(?=$|[\\/\s"''])'
    return [regex]::IsMatch($CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Get-AntiCodexRuntimeVersionProcessSnapshot {
    if (Test-AntiCodexRuntimeSyncNoProcessFixture) {
        return [pscustomobject]@{ QuerySucceeded = $true; Processes = @() }
    }
    try {
        $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
            $processId = [int]$_.ProcessId
            if ($processId -le 0 -or $processId -eq $PID) { return }
            $executablePath = ""
            try {
                if ($_.ExecutablePath) { $executablePath = [IO.Path]::GetFullPath([string]$_.ExecutablePath) }
            } catch {}
            if ($executablePath -and (Test-AntiCodexNativeCodexPath -Path $executablePath)) { return }
            [pscustomobject]@{
                ExecutablePath = $executablePath
                CommandLine = [string]$_.CommandLine
            }
        })
        return [pscustomobject]@{ QuerySucceeded = $true; Processes = $processes }
    } catch {
        return [pscustomobject]@{ QuerySucceeded = $false; Processes = @() }
    }
}

function Test-AntiCodexRuntimeVersionInUse {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    if (-not $Snapshot.QuerySucceeded) { return $true }
    $directoryFull = [IO.Path]::GetFullPath($Directory).TrimEnd("\")
    foreach ($process in @($Snapshot.Processes)) {
        $executablePath = [string]$process.ExecutablePath
        if ($executablePath -and (Test-AntiCodexPathInsideRoot -Path $executablePath -Root $directoryFull)) {
            return $true
        }
        $commandLine = [string]$process.CommandLine
        if ($commandLine -and
            (Test-AntiCodexCommandLineReferencesPathRoot -CommandLine $commandLine -Path $directoryFull)) {
            return $true
        }
    }
    return $false
}

function Write-AntiCodexJsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporaryPath = Join-Path $directory (".{0}.{1}.tmp" -f ([IO.Path]::GetFileName($Path)), ([guid]::NewGuid().ToString("N")))
    $backupPath = Join-Path $directory (".{0}.{1}.bak" -f ([IO.Path]::GetFileName($Path)), ([guid]::NewGuid().ToString("N")))
    try {
        $json = $Value | ConvertTo-Json -Depth 12
        [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($Path)) {
            [IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
        } else {
            [IO.File]::Move($temporaryPath, $Path)
        }
    } finally {
        Remove-Item -LiteralPath $temporaryPath, $backupPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-AntiCodexRuntimeProcessSnapshot {
    if (Test-AntiCodexRuntimeSyncNoProcessFixture) { return @() }
    $hostRoot = Join-Path $installRootFull "codex-patched-app"
    $componentRoot = Join-Path $installRootFull "components\codexplusplus"
    $processRows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    return @($processRows | ForEach-Object {
        $processId = [int]$_.ProcessId
        if ($processId -le 0 -or $processId -eq $PID) { return }

        $executablePath = ""
        try {
            if ($_.ExecutablePath) { $executablePath = [IO.Path]::GetFullPath([string]$_.ExecutablePath) }
        } catch {}
        if ($executablePath -and (Test-AntiCodexNativeCodexPath -Path $executablePath)) { return }

        $commandLine = [string]$_.CommandLine
        $underInstallRoot = $executablePath -and (Test-AntiCodexPathInsideRoot -Path $executablePath -Root $installRootFull)
        $usesActiveRuntime = $commandLine.IndexOf($targetRuntimeFull, [StringComparison]::OrdinalIgnoreCase) -ge 0
        if (-not $underInstallRoot -and -not $usesActiveRuntime) { return }

        [pscustomobject]@{
            ProcessId = $processId
            CreationDate = [string]$_.CreationDate
            Name = [string]$_.Name
            ExecutablePath = $executablePath
            CommandLine = $commandLine
            IsHostOrComponent = [bool](
                ($executablePath -and (Test-AntiCodexPathInsideRoot -Path $executablePath -Root $hostRoot)) -or
                ($executablePath -and (Test-AntiCodexPathInsideRoot -Path $executablePath -Root $componentRoot))
            )
        }
    })
}

function Set-AntiCodexRuntimeSyncState {
    param(
        [Parameter(Mandatory = $true)][string]$State,
        [Parameter(Mandatory = $true)][string]$Message,
        [AllowEmptyCollection()][object[]]$RunningProcesses = @(),
        [string]$ErrorMessage = "",
        [bool]$RestoredRuntimeReady = $false
    )

    $processes = @($RunningProcesses | ForEach-Object {
        [ordered]@{
            processId = [int]$_.ProcessId
            creationDate = [string]$_.CreationDate
            name = [string]$_.Name
            executablePath = [string]$_.ExecutablePath
            isHostOrComponent = [bool]$_.IsHostOrComponent
        }
    })
    $record = [ordered]@{
        schema = "anticodex-runtime-sync-state-v1"
        state = $State
        transactionId = $transactionId
        sourceRoot = $sourceRootFull
        activeRuntime = $targetRuntimeFull
        stagedRuntime = $stagedRuntimeFull
        rollbackRuntime = $rollbackRuntimeFull
        verifiedFileCount = $requiredSourceFiles.Count
        updatedAt = [DateTime]::UtcNow.ToString("o")
        message = $Message
        error = $ErrorMessage
        restoredRuntimeReady = $RestoredRuntimeReady
        runningProcesses = $processes
    }
    Write-AntiCodexJsonAtomic -Path $runtimeSyncStatePath -Value $record
}

function Write-AntiCodexDeferredRuntimeSyncResult {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [AllowEmptyCollection()][object[]]$RunningProcesses = @()
    )
    Set-AntiCodexRuntimeSyncState `
        -State "deferred" `
        -Message $Message `
        -RunningProcesses $RunningProcesses
    $runtimeCleanup = Invoke-AntiCodexRuntimeVersionCleanup -KeepStaged $stagedRuntimeFull
    [pscustomobject]@{
        ok = $true
        synced = $false
        mode = "staged_deferred_running"
        deferred = $true
        activated = $false
        transactionId = $transactionId
        verifiedFileCount = $requiredSourceFiles.Count
        sourceRoot = $sourceRootFull
        targetRuntime = $targetRuntimeFull
        stagedRuntime = $stagedRuntimeFull
        rollbackRuntime = $null
        cleanup = $runtimeCleanup
        restarted = $false
        runningProcessCount = $RunningProcesses.Count
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    } | ConvertTo-Json -Depth 8 -Compress
}

function Assert-AntiCodexRuntimeVersionsRoot {
    param([switch]$Create)

    if (-not (Test-Path -LiteralPath $runtimeVersionsRoot)) {
        if (-not $Create) { return $false }
        New-Item -ItemType Directory -Path $runtimeVersionsRoot -Force | Out-Null
    }
    $rootItem = Get-Item -LiteralPath $runtimeVersionsRoot -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer) {
        throw "Anti-Codex runtime-versions root is not a directory: $runtimeVersionsRoot"
    }
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing an Anti-Codex runtime-versions root that is a reparse point or junction: $runtimeVersionsRoot"
    }
    return $true
}

function Get-AntiCodexRuntimeInventory {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $directoryFull = [IO.Path]::GetFullPath($Directory).TrimEnd("\")
    $directoryItem = Get-Item -LiteralPath $directoryFull -Force -ErrorAction Stop
    if (-not $directoryItem.PSIsContainer -or
        (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Refusing to inventory an Anti-Codex runtime directory that is not a real directory: $directoryFull"
    }

    $directoryPrefix = $directoryFull + "\"
    $entries = [ordered]@{}
    foreach ($item in @(Get-ChildItem -LiteralPath $directoryFull -Recurse -Force -ErrorAction Stop | Sort-Object FullName)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing an Anti-Codex runtime version containing a reparse point: $($item.FullName)"
        }
        $itemFull = [IO.Path]::GetFullPath($item.FullName)
        if (-not $itemFull.StartsWith($directoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Anti-Codex runtime inventory escaped its version directory: $itemFull"
        }
        $relative = $itemFull.Substring($directoryPrefix.Length)
        if ($relative.Equals(".anticodex-runtime-manifest.json", [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        if ($item.PSIsContainer) {
            $entries[$relative] = [ordered]@{ type = "directory" }
        } elseif ($item -is [IO.FileInfo]) {
            $entries[$relative] = [ordered]@{
                type = "file"
                length = [long]$item.Length
                sha256 = (Get-AntiCodexSha256 -Path $itemFull).ToLowerInvariant()
            }
        } else {
            throw "Anti-Codex runtime inventory found an unsupported filesystem entry: $itemFull"
        }
    }
    return $entries
}

function Get-AntiCodexRuntimeGenerationFingerprint {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $manifestPath = Join-Path $Directory ".anticodex-runtime-manifest.json"
    $manifestSha256 = if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        Get-AntiCodexSha256 -Path $manifestPath
    } else {
        "legacy-no-manifest"
    }
    $inventoryJson = Get-AntiCodexRuntimeInventory -Directory $Directory | ConvertTo-Json -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes("$manifestSha256`n$inventoryJson")
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace("-", "")
    } finally {
        $hasher.Dispose()
    }
}

function Test-AntiCodexRuntimeSyncStateOwned {
    param([Parameter(Mandatory = $true)][string]$ExpectedTransactionId)

    try {
        if (-not (Test-Path -LiteralPath $runtimeSyncStatePath -PathType Leaf)) { return $false }
        $state = Get-Content -LiteralPath $runtimeSyncStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        return [string]$state.transactionId -ceq $ExpectedTransactionId
    } catch {
        return $false
    }
}

function Test-AntiCodexActiveRuntimeOwned {
    param([Parameter(Mandatory = $true)][string]$ExpectedTransactionId)

    try {
        if (-not (Test-AntiCodexRuntimeSyncStateOwned -ExpectedTransactionId $ExpectedTransactionId)) {
            return $false
        }
        $manifestPath = Join-Path $targetRuntimeFull ".anticodex-runtime-manifest.json"
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $false }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        return [string]$manifest.transactionId -ceq $ExpectedTransactionId
    } catch {
        return $false
    }
}

function Write-AntiCodexStagedRuntimeManifest {
    $inventory = Get-AntiCodexRuntimeInventory -Directory $stagedRuntimeFull
    $sourceRevisionAfter = Get-AntiCodexSourceGitRevision
    if ([string]$sourceRevisionAfter.provenance -cne "git" -or
        -not [bool]$sourceRevisionAfter.clean -or
        -not ([string]$sourceRevisionAfter.head).Equals([string]$sourceRevisionBefore.head, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Anti-Codex source revision changed or became dirty while the runtime was staged."
    }
    $fileHashes = [ordered]@{}
    foreach ($relative in $requiredSourceFiles) {
        $fileHashes[$relative] = (Get-AntiCodexSha256 -Path (Join-Path $stagedRuntimeFull $relative)).ToLowerInvariant()
    }
    $manifest = [ordered]@{
        schema = "anticodex-runtime-manifest-v2"
        state = "validated"
        transactionId = $transactionId
        sourceRoot = $sourceRootFull
        activeRuntime = $targetRuntimeFull
        stagedRuntime = $stagedRuntimeFull
        sourceGitHead = [string]$sourceRevisionBefore.head
        sourceGitClean = [bool]$sourceRevisionBefore.clean
        sourceRevisionProvenance = [string]$sourceRevisionBefore.provenance
        verifiedFileCount = $requiredSourceFiles.Count
        entryCount = $inventory.Count
        createdAt = [DateTime]::UtcNow.ToString("o")
        files = $fileHashes
        entries = $inventory
    }
    Write-AntiCodexJsonAtomic -Path (Join-Path $stagedRuntimeFull ".anticodex-runtime-manifest.json") -Value $manifest
}

function Get-AntiCodexTrustedRuntimeVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][ValidateSet("staged", "rollback")][string]$Kind,
        [switch]$AllowHistoricalContract
    )

    try {
        if (-not (Assert-AntiCodexRuntimeVersionsRoot)) { return $null }
        $directoryFull = [IO.Path]::GetFullPath($Directory).TrimEnd("\")
        $versionRootFull = [IO.Path]::GetFullPath($runtimeVersionsRoot).TrimEnd("\")
        $parentFull = [IO.Path]::GetFullPath((Split-Path -Parent $directoryFull)).TrimEnd("\")
        if (-not $parentFull.Equals($versionRootFull, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        $directoryItem = Get-Item -LiteralPath $directoryFull -Force -ErrorAction Stop
        $generationNamePattern = "^$Kind-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{32}$"
        if (-not $directoryItem.PSIsContainer -or
            (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
            [string]$directoryItem.Name -cnotmatch $generationNamePattern) {
            return $null
        }
        $manifestPath = Join-Path $directoryFull ".anticodex-runtime-manifest.json"
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$manifest.schema -cne "anticodex-runtime-manifest-v2" -or
            [string]$manifest.state -cne "validated" -or
            [string]::IsNullOrWhiteSpace([string]$manifest.transactionId)) {
            return $null
        }
        [int]$verifiedFileCount = $manifest.verifiedFileCount
        if ($verifiedFileCount -lt 1 -or
            (-not $AllowHistoricalContract -and $verifiedFileCount -ne $requiredSourceFiles.Count)) {
            return $null
        }
        $manifestActiveRuntime = [IO.Path]::GetFullPath([string]$manifest.activeRuntime).TrimEnd("\")
        if (-not $manifestActiveRuntime.Equals($targetRuntimeFull.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
            return $null
        }
        if ($Kind -eq "staged" -and
            -not $directoryItem.Name.Equals("staged-$([string]$manifest.transactionId)", [StringComparison]::Ordinal)) {
            return $null
        }

        $createdAt = [DateTimeOffset]::MinValue
        if (-not [DateTimeOffset]::TryParse([string]$manifest.createdAt, [ref]$createdAt)) { return $null }
        $manifestFiles = @($manifest.files.PSObject.Properties)
        if ($manifestFiles.Count -ne $verifiedFileCount) { return $null }
        $actualEntries = Get-AntiCodexRuntimeInventory -Directory $directoryFull
        $manifestEntries = @($manifest.entries.PSObject.Properties)
        if ([int]$manifest.entryCount -ne $actualEntries.Count -or
            $manifestEntries.Count -ne $actualEntries.Count) {
            return $null
        }
        $declaredEntries = @{}
        foreach ($property in $manifestEntries) {
            $relative = [string]$property.Name
            if ([string]::IsNullOrWhiteSpace($relative) -or
                $relative.Equals(".anticodex-runtime-manifest.json", [StringComparison]::OrdinalIgnoreCase) -or
                $declaredEntries.ContainsKey($relative)) {
                return $null
            }
            $entryPath = [IO.Path]::GetFullPath((Join-Path $directoryFull $relative))
            if (-not (Test-AntiCodexPathInsideRoot -Path $entryPath -Root $directoryFull)) { return $null }
            $declaredEntries[$relative] = $property.Value
        }
        foreach ($relative in $actualEntries.Keys) {
            if (-not $declaredEntries.ContainsKey($relative)) { return $null }
            $actual = $actualEntries[$relative]
            $declared = $declaredEntries[$relative]
            if ([string]$declared.type -cne [string]$actual.type) { return $null }
            if ([string]$actual.type -ceq "file" -and (
                [long]$declared.length -ne [long]$actual.length -or
                [string]$declared.sha256 -notmatch "^[a-fA-F0-9]{64}$" -or
                -not ([string]$declared.sha256).Equals([string]$actual.sha256, [StringComparison]::OrdinalIgnoreCase)
            )) {
                return $null
            }
        }
        $required = @{}
        foreach ($relative in $requiredSourceFiles) { $required[$relative] = $true }
        foreach ($property in $manifestFiles) {
            $relative = [string]$property.Name
            $expectedHash = [string]$property.Value
            if ((-not $AllowHistoricalContract -and -not $required.ContainsKey($relative)) -or
                $expectedHash -notmatch "^[a-fA-F0-9]{64}$" -or
                ($AllowHistoricalContract -and (
                    -not $declaredEntries.ContainsKey($relative) -or
                    [string]$declaredEntries[$relative].type -cne "file"
                ))) {
                return $null
            }
            $filePath = [IO.Path]::GetFullPath((Join-Path $directoryFull $relative))
            if (-not (Test-AntiCodexPathInsideRoot -Path $filePath -Root $directoryFull) -or
                -not (Test-Path -LiteralPath $filePath -PathType Leaf) -or
                -not (Get-AntiCodexSha256 -Path $filePath).Equals(
                    $expectedHash,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                return $null
            }
        }
        return [pscustomobject]@{
            Directory = $directoryFull
            Kind = $Kind
            CreatedAt = $createdAt
        }
    } catch {
        return $null
    }
}

function Invoke-AntiCodexRuntimeVersionCleanup {
    param(
        [string]$KeepStaged = "",
        [string]$KeepRollback = ""
    )

    $removed = @()
    $skipped = @()
    $kept = @()
    if (-not (Test-Path -LiteralPath $runtimeVersionsRoot)) {
        return [pscustomobject]@{ removed = $removed; skipped = $skipped; kept = $kept }
    }
    Assert-AntiCodexRuntimeVersionsRoot | Out-Null

    $trustedStages = @()
    $trustedRollbacks = @()
    $classificationProcessSnapshot = Get-AntiCodexRuntimeVersionProcessSnapshot
    foreach ($directory in @(Get-ChildItem -LiteralPath $runtimeVersionsRoot -Directory -Force -ErrorAction SilentlyContinue)) {
        $kind = if ($directory.Name.StartsWith("staged-", [StringComparison]::Ordinal)) {
            "staged"
        } elseif ($directory.Name.StartsWith("rollback-", [StringComparison]::Ordinal)) {
            "rollback"
        } else {
            continue
        }
        if (Test-AntiCodexRuntimeVersionInUse `
            -Directory $directory.FullName `
            -Snapshot $classificationProcessSnapshot) {
            $skipped += [IO.Path]::GetFullPath($directory.FullName).TrimEnd("\")
            continue
        }
        $trusted = Get-AntiCodexTrustedRuntimeVersion `
            -Directory $directory.FullName `
            -Kind $kind `
            -AllowHistoricalContract
        if (-not $trusted) {
            $skipped += [IO.Path]::GetFullPath($directory.FullName).TrimEnd("\")
        } elseif ($kind -eq "staged") {
            $trustedStages += $trusted
        } else {
            $trustedRollbacks += $trusted
        }
    }

    $keepStagedFull = if ($KeepStaged) { [IO.Path]::GetFullPath($KeepStaged).TrimEnd("\") } else { "" }
    $keepRollbackFull = if ($KeepRollback) { [IO.Path]::GetFullPath($KeepRollback).TrimEnd("\") } else { "" }
    $rollbackToKeep = $trustedRollbacks | Where-Object {
        $keepRollbackFull -and $_.Directory.Equals($keepRollbackFull, [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if (-not $rollbackToKeep) {
        $rollbackToKeep = $trustedRollbacks | Sort-Object CreatedAt -Descending | Select-Object -First 1
    }

    foreach ($candidate in @($trustedStages + $trustedRollbacks)) {
        $shouldKeep = ($candidate.Kind -eq "staged" -and $keepStagedFull -and
                $candidate.Directory.Equals($keepStagedFull, [StringComparison]::OrdinalIgnoreCase)) -or
            ($candidate.Kind -eq "rollback" -and $rollbackToKeep -and
                $candidate.Directory.Equals($rollbackToKeep.Directory, [StringComparison]::OrdinalIgnoreCase))
        if ($shouldKeep) {
            $kept += $candidate.Directory
            continue
        }
        if (-not (Get-AntiCodexTrustedRuntimeVersion `
            -Directory $candidate.Directory `
            -Kind $candidate.Kind `
            -AllowHistoricalContract)) {
            $skipped += $candidate.Directory
            continue
        }
        if (Test-AntiCodexRuntimeVersionInUse `
            -Directory $candidate.Directory `
            -Snapshot (Get-AntiCodexRuntimeVersionProcessSnapshot)) {
            $skipped += $candidate.Directory
            continue
        }
        try {
            Remove-Item -LiteralPath $candidate.Directory -Recurse -Force -ErrorAction Stop
            $removed += $candidate.Directory
        } catch {
            $skipped += $candidate.Directory
        }
    }

    return [pscustomobject]@{
        removed = @($removed | Select-Object -Unique)
        skipped = @($skipped | Select-Object -Unique)
        kept = @($kept | Select-Object -Unique)
    }
}

function Move-AntiCodexRuntimeDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (-not [IO.Directory]::Exists($Source)) {
        throw "Anti-Codex runtime transaction source is missing: $Source"
    }
    if ([IO.Directory]::Exists($Destination) -or [IO.File]::Exists($Destination)) {
        throw "Anti-Codex runtime transaction destination already exists: $Destination"
    }
    [IO.Directory]::Move($Source, $Destination)
}

function Invoke-AntiCodexRuntimeSyncTestFault {
    param([Parameter(Mandatory = $true)][string]$Point)
    if ([string]$env:ANTICODEX_RUNTIME_SYNC_TEST_FAULT -ceq $Point) {
        throw "Injected failure after active move for isolated runtime-sync testing."
    }
}

function Get-AntiCodexScriptProcessSnapshot {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedScriptPath,
        [Parameter(Mandatory = $true)][string]$AllowedScriptRoot
    )
    $scriptPath = [IO.Path]::GetFullPath($ExpectedScriptPath)
    if (-not (Test-AntiCodexPathInsideRoot -Path $scriptPath -Root $AllowedScriptRoot)) { return $null }
    $processHandle = $null
    try {
        $processHandle = [AntiCodex.Native.VerifiedProcessHandle]::Open($ProcessId)
        if ($processHandle.HasExited) { return $null }
        $row = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $row -or -not $row.ExecutablePath) { return $null }
        $executablePath = [IO.Path]::GetFullPath([string]$processHandle.ExecutablePath)
        $rowExecutablePath = [IO.Path]::GetFullPath([string]$row.ExecutablePath)
        $commandLine = [string]$row.CommandLine
        if (-not $rowExecutablePath.Equals($executablePath, [StringComparison]::OrdinalIgnoreCase) -or
            (Test-AntiCodexNativeCodexPath -Path $executablePath) -or
            -not (Test-AntiCodexCommandLineHasExactPath -CommandLine $commandLine -Path $scriptPath)) {
            return $null
        }
        return [pscustomobject]@{
            ProcessId = [int]$processHandle.ProcessId
            CreationFileTimeUtcTicks = [long]$processHandle.CreationFileTimeUtcTicks
            ExecutablePath = $executablePath
            CommandLine = $commandLine
        }
    } catch [ComponentModel.Win32Exception] {
        if ($_.Exception.NativeErrorCode -in @(87, 1168)) { return $null }
        return $null
    } finally {
        if ($processHandle) { $processHandle.Dispose() }
    }
}

function Stop-AntiCodexVerifiedScriptProcess {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$ExpectedScriptPath,
        [Parameter(Mandatory = $true)][string]$AllowedScriptRoot
    )
    $processId = [int]$Snapshot.ProcessId
    $scriptPath = [IO.Path]::GetFullPath($ExpectedScriptPath)
    $expectedExecutablePath = [IO.Path]::GetFullPath([string]$Snapshot.ExecutablePath)
    $expectedCreationFileTimeUtcTicks = [long]$Snapshot.CreationFileTimeUtcTicks
    if ($processId -le 0 -or $processId -eq $PID -or
        $expectedCreationFileTimeUtcTicks -le 0 -or
        -not (Test-AntiCodexPathInsideRoot -Path $scriptPath -Root $AllowedScriptRoot) -or
        (Test-AntiCodexNativeCodexPath -Path $expectedExecutablePath)) {
        throw "Refusing to stop an unverified fixed-route process PID $processId."
    }
    $processHandle = $null
    try {
        try {
            $processHandle = [AntiCodex.Native.VerifiedProcessHandle]::Open($processId)
        } catch [ComponentModel.Win32Exception] {
            if ($_.Exception.NativeErrorCode -in @(87, 1168)) { return $true }
            throw
        }
        $liveExecutablePath = [IO.Path]::GetFullPath([string]$processHandle.ExecutablePath)
        if ([long]$processHandle.CreationFileTimeUtcTicks -ne $expectedCreationFileTimeUtcTicks -or
            -not $liveExecutablePath.Equals($expectedExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
            (Test-AntiCodexNativeCodexPath -Path $liveExecutablePath)) {
            throw "Refusing to stop PID $processId because its handle-bound creation time or executable path changed."
        }
        if ($processHandle.HasExited) { return $true }
        $liveRow = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $liveRow -or
            -not (Test-AntiCodexCommandLineHasExactPath -CommandLine ([string]$liveRow.CommandLine) -Path $scriptPath)) {
            throw "Refusing to stop PID $processId because its script identity could not be proven while its handle was held."
        }
        $processHandle.TerminateAndWait(3000)
        return $true
    } catch {
        throw "Verified fixed-route PID $processId could not be stopped through its bound handle; no descendants were targeted. $($_.Exception.Message)"
    } finally {
        if ($processHandle) { $processHandle.Dispose() }
    }
}

function Get-AntiCodexFixedRouteSupervisorProcesses {
    if (Test-AntiCodexRuntimeSyncNoProcessFixture) { return @() }
    $supervisorScript = Join-Path $targetRuntimeFull "scripts\start-anticodex-fixed-route.mjs"
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        $snapshot = Get-AntiCodexScriptProcessSnapshot `
            -ProcessId ([int]$_.ProcessId) `
            -ExpectedScriptPath $supervisorScript `
            -AllowedScriptRoot $targetRuntimeFull
        if ($snapshot) { $snapshot }
    })
}

function Invoke-AntiCodexFixedRouteShutdown {
    $authPath = Join-Path $antiCodexStateRoot "codex-home-deepseek-app\auth.json"
    $controlToken = "anticodex-local-proxy-key"
    try {
        if (Test-Path -LiteralPath $authPath -PathType Leaf) {
            $auth = Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not [string]::IsNullOrWhiteSpace([string]$auth.OPENAI_API_KEY)) {
                $controlToken = [string]$auth.OPENAI_API_KEY
            }
        }
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:18487/anticodex/fixed-route/shutdown")
        $request.Method = "POST"
        $request.Proxy = $null
        $request.Timeout = 3000
        $request.ReadWriteTimeout = 3000
        $request.ContentLength = 0
        $request.Headers[[Net.HttpRequestHeader]::Authorization] = "Bearer $controlToken"
        $response = $request.GetResponse()
        try {
            return [int]$response.StatusCode -eq 202
        } finally {
            $response.Dispose()
        }
    } catch {
        return $false
    }
}

function Stop-AntiCodexFixedRouteSupervisor {
    $statusPath = Join-Path $antiCodexStateRoot "fixed-route-status.json"
    $knownSupervisorPid = 0
    try {
        if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
            $knownSupervisorPid = [int](Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json).pid
        }
    } catch {}
    $supervisorScript = Join-Path $targetRuntimeFull "scripts\start-anticodex-fixed-route.mjs"
    $knownSnapshot = if ($knownSupervisorPid -gt 0) {
        Get-AntiCodexScriptProcessSnapshot `
            -ProcessId $knownSupervisorPid `
            -ExpectedScriptPath $supervisorScript `
            -AllowedScriptRoot $targetRuntimeFull
    } else { $null }
    if ($knownSnapshot) {
        if (Invoke-AntiCodexFixedRouteShutdown) {
            $gracefulDeadline = [DateTime]::UtcNow.AddSeconds(10)
            while ((Get-CimInstance Win32_Process -Filter "ProcessId = $knownSupervisorPid" -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $gracefulDeadline) {
                Start-Sleep -Milliseconds 100
            }
            if (-not (Get-CimInstance Win32_Process -Filter "ProcessId = $knownSupervisorPid" -ErrorAction SilentlyContinue)) {
                return 1
            }
        }
    }

    $stopped = 0
    foreach ($process in @(Get-AntiCodexFixedRouteSupervisorProcesses)) {
        Stop-AntiCodexVerifiedScriptProcess `
            -Snapshot $process `
            -ExpectedScriptPath $supervisorScript `
            -AllowedScriptRoot $targetRuntimeFull | Out-Null
        $stopped += 1
    }
    return $stopped
}

function Remove-AntiCodexLegacyRuntimeFiles {
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
    $runtimeRootFull = [IO.Path]::GetFullPath($RuntimeRoot)
    foreach ($relative in $legacyRuntimeFiles) {
        $path = [IO.Path]::GetFullPath((Join-Path $runtimeRootFull $relative))
        if (-not (Test-AntiCodexPathInsideRoot -Path $path -Root $runtimeRootFull)) {
            throw "Refusing to remove Anti-Codex legacy runtime file outside $runtimeRootFull"
        }
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
        }
    }
}

function Test-AntiCodexJavaScriptSyntax {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Anti-Codex JavaScript syntax target missing: $Label"
    }
    if ([string]$env:ANTICODEX_RUNTIME_SYNC_TEST_SKIP_SYNTAX -ceq "1" -and
        (Test-AntiCodexRuntimeSyncFixture)) {
        return
    }
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $node `
            -ArgumentList @("--check", $Path) `
            -WindowStyle Hidden `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        [void]$proc.Handle
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not $proc.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 200
            try { $proc.Refresh() } catch {}
        }
        if (-not $proc.HasExited) {
            throw "Anti-Codex JavaScript syntax check timed out without terminating the verifier process: $Label"
        }
        if ([int]$proc.ExitCode -ne 0) {
            $stderr = ""
            try { $stderr = [IO.File]::ReadAllText($stderrPath, [Text.Encoding]::UTF8).Trim() } catch {}
            if (-not $stderr) { $stderr = "exit code $([int]$proc.ExitCode)" }
            throw "Anti-Codex JavaScript syntax check failed: $Label :: $stderr"
        }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-LocalJson {
    param([string]$Path, [int]$RequestTimeoutSec = 4)
    return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $RequestTimeoutSec
}

function Wait-AntiCodexHealth {
    param([int]$Seconds)
    if ([string]$env:ANTICODEX_RUNTIME_SYNC_TEST_HEALTH_MODE -ceq "ready" -and
        [string]$env:ANTICODEX_RUNTIME_SYNC_TEST_ROOT -and
        ([IO.Path]::GetFullPath([string]$env:ANTICODEX_RUNTIME_SYNC_TEST_ROOT)).Equals(
            $installRootFull,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        return [pscustomobject]@{
            ok = $true
            schema = "anticodex-manager-service-v1"
            role = "launcher-management-only"
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $Seconds))
    do {
        try {
            $health = Invoke-LocalJson "/health" 3
            if ($health -and $health.ok -eq $true -and [string]$health.schema -eq "anticodex-manager-service-v1" -and [string]$health.role -eq "launcher-management-only") { return $health }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

function Wait-AntiCodexFixedRouteHealth {
    param([int]$Seconds)
    if ([string]$env:ANTICODEX_RUNTIME_SYNC_TEST_HEALTH_MODE -ceq "ready" -and
        [string]$env:ANTICODEX_RUNTIME_SYNC_TEST_ROOT -and
        ([IO.Path]::GetFullPath([string]$env:ANTICODEX_RUNTIME_SYNC_TEST_ROOT)).Equals(
            $installRootFull,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        return [pscustomobject]@{
            ok = $true
            state = "ready"
            provider = "isolated-test"
            model = "isolated-test"
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $Seconds))
    do {
        try {
            $fixedRoute = Invoke-RestMethod -Uri $fixedRouteHealthUrl -Proxy $null -TimeoutSec 3
            if ($fixedRoute -and $fixedRoute.ok -eq $true -and [string]$fixedRoute.state -eq "ready") { return $fixedRoute }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

function Invoke-AntiCodexFixedRouteLauncher {
    param([int]$Seconds)

    $testRoot = [string]$env:ANTICODEX_RUNTIME_SYNC_TEST_ROOT
    $testLaunchLog = [string]$env:ANTICODEX_RUNTIME_SYNC_TEST_LAUNCH_LOG
    if ($testRoot -and
        $testLaunchLog -and
        ([IO.Path]::GetFullPath($testRoot)).Equals($installRootFull, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-AntiCodexPathInsideRoot -Path ([IO.Path]::GetFullPath($testLaunchLog)) -Root $testRoot)) {
        $attemptNumber = if (Test-Path -LiteralPath $testLaunchLog -PathType Leaf) {
            @(Get-Content -LiteralPath $testLaunchLog -Encoding UTF8).Count + 1
        } else {
            1
        }
        $attempt = [ordered]@{
            attempt = $attemptNumber
            oldActivePresent = Test-Path -LiteralPath (Join-Path $targetRuntimeFull "old-active-sentinel.txt") -PathType Leaf
            restoredShortcutRepairPresent = Test-Path -LiteralPath (Join-Path $installRootFull "restored-repair-invoked.txt") -PathType Leaf
        }
        Add-Content -LiteralPath $testLaunchLog -Value ($attempt | ConvertTo-Json -Compress) -Encoding UTF8
        if ([string]$env:ANTICODEX_RUNTIME_SYNC_TEST_LAUNCH_MODE -ceq "fail-new-succeed-restored" -and
            $attemptNumber -eq 1) {
            return [pscustomobject]@{
                ok = $false
                exitCode = 97
                stderr = "isolated injected restart failure"
            }
        }
        return [pscustomobject]@{
            ok = $true
            exitCode = 0
            stderr = ""
        }
    }

    try {
        $service = New-Object -ComObject "Schedule.Service"
        $service.Connect()
        $task = $service.GetFolder("\").GetTask("\Anti-Codex Launcher")
        if ([int]$task.State -eq 3) {
            Start-ScheduledTask -TaskName "Anti-Codex Launcher"
        } elseif ([int]$task.State -notin @(2, 4)) {
            throw "The isolated Anti-Codex launch task is not ready, queued, or running."
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            exitCode = 1
            stderr = $_.Exception.Message
        }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(10, $Seconds))
    $health = $null
    $fixedRoute = $null
    do {
        $health = Wait-AntiCodexHealth -Seconds 1
        $fixedRoute = Wait-AntiCodexFixedRouteHealth -Seconds 1
        $task = $service.GetFolder("\").GetTask("\Anti-Codex Launcher")
        if ($health -and $fixedRoute) { break }
    } while ([DateTime]::UtcNow -lt $deadline)

    $ready = ($null -ne $health -and $null -ne $fixedRoute)
    if (-not $ready -and [int]$task.State -in @(2, 4)) {
        $null = Invoke-AntiCodexFixedRouteShutdown
        $task.Stop(0)
        $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            $task = $service.GetFolder("\").GetTask("\Anti-Codex Launcher")
        } while ([int]$task.State -ne 3 -and [DateTime]::UtcNow -lt $stopDeadline)
    }
    return [pscustomobject]@{
        ok = $ready
        exitCode = if ($ready) { $null } else { 1 }
        stderr = ""
    }
}

$syntaxCheckedJavaScriptFiles = @(
    "scripts\start-anticodex-task.mjs",
    "scripts\start-anticodex-update-task.mjs",
    "scripts\start-anticodex-fixed-route.mjs",
    "scripts\anticodex-manager-service.mjs",
    "scripts\build-anticodex-gate5-evidence.mjs",
    "scripts\build-anticodex-gate8-autonomous-video-evidence.mjs",
    "scripts\lib\anticodex-fixed-route.mjs",
    "scripts\lib\anticodex-owner-process.mjs",
    "scripts\lib\anticodex-release-binding.mjs",
    "scripts\lib\anticodex-gate4-runtime.mjs",
    "scripts\lib\anticodex-gate8-evidence.mjs",
    "scripts\lib\anticodex-native-request-activity.mjs",
    "scripts\read-anticodex-native-request-snapshot.mjs",
    "scripts\lib\native-codex-rollout-history.mjs",
    "scripts\test-anticodex-native-compaction-resume.mjs",
    "scripts\test-anticodex-gate8-final-long-task.mjs",
    "scripts\test-anticodex-gate8-autonomous-video.mjs",
    "scripts\test-codexplusplus-antigravity-route-switch.mjs",
    "scripts\deepcodex-cdp-inject.mjs",
    "scripts\anticodex-manager-bridge.mjs",
    "scripts\anticodex-manager-inject.js",
    "scripts\anticodex-manager-open-inject.js",
    "translator\antigravity-agentapi.mjs",
    "translator\antigravity-model-catalog.mjs",
    "translator\antigravity-contract.mjs",
    "translator\antigravity-native-mcp-bridge.mjs",
    "translator\provider\antigravity-cascade-client.mjs",
    "translator\provider\anticodex-prompt-policy.mjs",
    "translator\provider\antigravity-chat-adapter.mjs",
    "translator\provider\antigravity-chat-server.mjs",
    "translator\provider\codexplusplus-upstream-probe.mjs",
    "translator\provider\start-antigravity-chat-provider.mjs"
)
$syncMutex = [Threading.Mutex]::new($false, "Global\AntiCodexHostSync")
$compatibilitySyncMutex = [Threading.Mutex]::new($false, "Local\AntiCodexHostSync")
$syncMutexAcquired = $false
$compatibilitySyncMutexAcquired = $false
try {
    try {
        $syncMutexAcquired = $syncMutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
        $syncMutexAcquired = $true
    }
    if (-not $syncMutexAcquired) {
        throw "Another Anti-Codex sync is already running."
    }
    try {
        $compatibilitySyncMutexAcquired = $compatibilitySyncMutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
        $compatibilitySyncMutexAcquired = $true
    }
    if (-not $compatibilitySyncMutexAcquired) {
        throw "Another Anti-Codex sync is already running."
    }

    if (-not (Test-AntiCodexPathInsideRoot -Path $stagedRuntimeFull -Root $runtimeVersionsRoot) -or
        -not (Test-AntiCodexPathInsideRoot -Path $rollbackRuntimeFull -Root $runtimeVersionsRoot)) {
        throw "Anti-Codex runtime transaction paths escaped the version root."
    }
    Assert-AntiCodexRuntimeVersionsRoot -Create | Out-Null

    $runtimeHashMismatches = @()
    try {
        Set-AntiCodexRuntimeSyncState -State "staging" -Message "Building a complete versioned runtime without changing the active directory."
        if ([IO.Directory]::Exists($stagedRuntimeFull) -or [IO.File]::Exists($stagedRuntimeFull)) {
            throw "Anti-Codex staged runtime already exists: $stagedRuntimeFull"
        }

        foreach ($relative in $syntaxCheckedJavaScriptFiles) {
            Test-AntiCodexJavaScriptSyntax `
                -Path (Join-Path $sourceRootFull $relative) `
                -Label "source $relative"
        }

        foreach ($dir in @("scripts", "translator", "assets", "codex-home-deepseek-app", "third_party")) {
            Copy-AntiCodexRuntimeTree (Join-Path $sourceRootFull $dir) (Join-Path $stagedRuntimeFull $dir)
        }
        Copy-AntiCodexPublicDocs -SourceRoot $sourceRootFull -DestinationRoot $stagedRuntimeFull
        Remove-AntiCodexLegacyRuntimeFiles -RuntimeRoot $stagedRuntimeFull

        foreach ($relative in $requiredSourceFiles) {
            $targetPath = Join-Path $stagedRuntimeFull $relative
            if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
                throw "Anti-Codex staged runtime component missing after sync: $relative"
            }
        }
        $runtimeHashMismatches = @($requiredSourceFiles | Where-Object {
            $sourcePath = Join-Path $sourceRootFull $_
            $targetPath = Join-Path $stagedRuntimeFull $_
            (Get-AntiCodexSha256 -Path $sourcePath) -ne
                (Get-AntiCodexSha256 -Path $targetPath)
        })
        if ($runtimeHashMismatches.Count -gt 0) {
            throw "Anti-Codex staged runtime hash verification failed: $($runtimeHashMismatches -join ', ')"
        }

        foreach ($relative in $syntaxCheckedJavaScriptFiles) {
            Test-AntiCodexJavaScriptSyntax `
                -Path (Join-Path $stagedRuntimeFull $relative) `
                -Label "runtime $relative"
        }
        Write-AntiCodexStagedRuntimeManifest
        Set-AntiCodexRuntimeSyncState -State "staged" -Message "The versioned runtime is complete and verified; active is unchanged."
    } catch {
        $stagingError = $_
        if ([IO.Directory]::Exists($stagedRuntimeFull) -and
            (Test-AntiCodexPathInsideRoot -Path $stagedRuntimeFull -Root $runtimeVersionsRoot)) {
            Remove-Item -LiteralPath $stagedRuntimeFull -Recurse -Force -ErrorAction SilentlyContinue
        }
        try {
            Set-AntiCodexRuntimeSyncState -State "failed" -Message "Runtime staging failed; active was not changed." -ErrorMessage $stagingError.Exception.Message
        } catch {}
        throw $stagingError
    }

    $runningProcesses = @(Get-AntiCodexRuntimeProcessSnapshot)
    $mustDefer = $NoRestart -and $runningProcesses.Count -gt 0
    if (-not $NoRestart -and @($runningProcesses | Where-Object { $_.IsHostOrComponent }).Count -gt 0) {
        $mustDefer = $true
    }
    if ($mustDefer) {
        Write-AntiCodexDeferredRuntimeSyncResult `
            -Message "The runtime is staged, but activation is deferred until all Anti-Codex release processes exit." `
            -RunningProcesses $runningProcesses
        return
    }

    $stoppedFixedRouteSupervisorCount = 0
    $launchExitCode = $null
    if (-not $NoRestart) {
        New-Item -ItemType Directory -Path $antiCodexStateRoot -Force | Out-Null
        $stoppedFixedRouteSupervisorCount = Stop-AntiCodexFixedRouteSupervisor
        $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            $runningProcesses = @(Get-AntiCodexRuntimeProcessSnapshot)
            if ($runningProcesses.Count -eq 0) { break }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $stopDeadline)
    }

    $runningProcesses = @(Get-AntiCodexRuntimeProcessSnapshot)
    if ($runningProcesses.Count -gt 0) {
        Write-AntiCodexDeferredRuntimeSyncResult `
            -Message "The runtime is staged, but activation is deferred because release processes did not exit." `
            -RunningProcesses $runningProcesses
        return
    }

    $activeMoved = $false
    $stageActivated = $false
    $supersededByAnotherSync = $false
    $health = $null
    $fixedRoute = $null
    try {
        Set-AntiCodexRuntimeSyncState -State "activating" -Message "Activating the complete staged runtime as one directory transaction."
        $activationProcesses = @(Get-AntiCodexRuntimeProcessSnapshot)
        if ($activationProcesses.Count -gt 0) {
            Write-AntiCodexDeferredRuntimeSyncResult `
                -Message "The runtime is staged, but activation is deferred because a release process started before publish." `
                -RunningProcesses $activationProcesses
            return
        }
        if ([IO.Directory]::Exists($targetRuntimeFull)) {
            Move-AntiCodexRuntimeDirectory -Source $targetRuntimeFull -Destination $rollbackRuntimeFull
            $activeMoved = $true
            Invoke-AntiCodexRuntimeSyncTestFault -Point "after-active-move"
        }
        Move-AntiCodexRuntimeDirectory -Source $stagedRuntimeFull -Destination $targetRuntimeFull
        $stageActivated = $true

        $runtimeHashMismatches = @($requiredSourceFiles | Where-Object {
            $sourcePath = Join-Path $sourceRootFull $_
            $targetPath = Join-Path $targetRuntimeFull $_
            -not (Test-Path -LiteralPath $targetPath -PathType Leaf) -or
                (Get-AntiCodexSha256 -Path $sourcePath) -ne
                    (Get-AntiCodexSha256 -Path $targetPath)
        })
        if ($runtimeHashMismatches.Count -gt 0) {
            throw "Anti-Codex activated runtime hash verification failed: $($runtimeHashMismatches -join ', ')"
        }

        $sharedMcpInstaller = Join-Path $targetRuntimeFull "scripts\install-anticodex-shared-mcp.ps1"
        $sharedMcpSource = Join-Path $targetRuntimeFull "scripts\anticodex_shared_mcp_proxy.py"
        $sharedMcpInstallJson = (@(& $sharedMcpInstaller -InstallRoot $installRootFull -SourceScript $sharedMcpSource) -join [Environment]::NewLine)
        $sharedMcpInstallResult = $sharedMcpInstallJson | ConvertFrom-Json
        if (-not $sharedMcpInstallResult.ok) {
            throw "Anti-Codex shared MCP component could not be installed after runtime sync."
        }

        $shortcutRepairScript = Join-Path $targetRuntimeFull "scripts\repair-anticodex-shortcuts.ps1"
        $shortcutRepairJson = (@(& $shortcutRepairScript -InstallRoot $installRootFull) -join [Environment]::NewLine)
        $shortcutRepairResult = $shortcutRepairJson | ConvertFrom-Json
        if (-not $shortcutRepairResult.ok) {
            throw "Anti-Codex shortcuts could not be refreshed after runtime sync."
        }

        if (-not $BaseUrl) {
            $BaseUrl = & (Join-Path $targetRuntimeFull "scripts\resolve-anticodex-base-url.ps1")
        }

        if (-not $NoRestart) {
            $compatibilitySyncMutex.ReleaseMutex()
            $compatibilitySyncMutexAcquired = $false
            $syncMutex.ReleaseMutex()
            $syncMutexAcquired = $false
            $launch = Invoke-AntiCodexFixedRouteLauncher -Seconds ([Math]::Max(60, $TimeoutSec))
            $launchExitCode = $launch.exitCode
            if (-not $launch.ok) {
                throw "Anti-Codex fixed-route restart failed. exit=$($launch.exitCode) $($launch.stderr)"
            }
            $health = Wait-AntiCodexHealth -Seconds $TimeoutSec
            $fixedRoute = Wait-AntiCodexFixedRouteHealth -Seconds $TimeoutSec
            if (-not $health -or -not $fixedRoute) {
                throw "Anti-Codex fixed-route restart did not pass post-activation health checks."
            }
            try {
                $syncMutexAcquired = $syncMutex.WaitOne(300000)
            } catch [Threading.AbandonedMutexException] {
                $syncMutexAcquired = $true
            }
            if (-not $syncMutexAcquired) {
                $supersededByAnotherSync = $true
                throw "Another Anti-Codex runtime sync remained active after restart."
            }
            try {
                $compatibilitySyncMutexAcquired = $compatibilitySyncMutex.WaitOne(300000)
            } catch [Threading.AbandonedMutexException] {
                $compatibilitySyncMutexAcquired = $true
            }
            if (-not $compatibilitySyncMutexAcquired) {
                $supersededByAnotherSync = $true
                throw "Another Anti-Codex host sync remained active after restart."
            }
        }
        if (-not (Test-AntiCodexActiveRuntimeOwned -ExpectedTransactionId $transactionId)) {
            $supersededByAnotherSync = $true
            throw "The active Anti-Codex runtime or sync state changed after activation. This sync will not accept or clean up another transaction."
        }
        Set-AntiCodexRuntimeSyncState -State "active" -Message "The complete staged runtime is active and the previous directory is preserved for rollback."
        $runtimeCleanup = Invoke-AntiCodexRuntimeVersionCleanup -KeepRollback $rollbackRuntimeFull
    } catch {
        $activationError = $_
        if ($supersededByAnotherSync) {
            throw $activationError
        }
        $restoreError = ""
        $restoredRuntimeReady = $false
        $restoredRuntimeFingerprint = ""
        try {
            if (-not $syncMutexAcquired) {
                try {
                    $syncMutexAcquired = $syncMutex.WaitOne(300000)
                } catch [Threading.AbandonedMutexException] {
                    $syncMutexAcquired = $true
                }
                if (-not $syncMutexAcquired) {
                    $supersededByAnotherSync = $true
                    throw "Another Anti-Codex sync started before runtime recovery."
                }
            }
            if (-not $compatibilitySyncMutexAcquired) {
                try {
                    $compatibilitySyncMutexAcquired = $compatibilitySyncMutex.WaitOne(300000)
                } catch [Threading.AbandonedMutexException] {
                    $compatibilitySyncMutexAcquired = $true
                }
                if (-not $compatibilitySyncMutexAcquired) {
                    $supersededByAnotherSync = $true
                    throw "Another Anti-Codex sync started before runtime recovery."
                }
            }
            if (($stageActivated -and
                    -not (Test-AntiCodexActiveRuntimeOwned -ExpectedTransactionId $transactionId)) -or
                (-not $stageActivated -and
                    -not (Test-AntiCodexRuntimeSyncStateOwned -ExpectedTransactionId $transactionId))) {
                $supersededByAnotherSync = $true
                throw "The active Anti-Codex runtime or sync state changed before automatic restoration."
            }
            if ($stageActivated -and -not $NoRestart) {
                $null = Stop-AntiCodexFixedRouteSupervisor
            }
            $remainingProcesses = @(Get-AntiCodexRuntimeProcessSnapshot)
            if ($remainingProcesses.Count -gt 0) {
                throw "Runtime rollback refused while Anti-Codex release processes still use the activated directory."
            }
            if ($stageActivated -and [IO.Directory]::Exists($targetRuntimeFull)) {
                Move-AntiCodexRuntimeDirectory -Source $targetRuntimeFull -Destination $stagedRuntimeFull
                $stageActivated = $false
            }
            if ($activeMoved -and [IO.Directory]::Exists($rollbackRuntimeFull)) {
                Move-AntiCodexRuntimeDirectory -Source $rollbackRuntimeFull -Destination $targetRuntimeFull
                $activeMoved = $false
            }
            if ([IO.Directory]::Exists($targetRuntimeFull)) {
                $restoredShortcutRepairScript = Join-Path $targetRuntimeFull "scripts\repair-anticodex-shortcuts.ps1"
                if (-not (Test-Path -LiteralPath $restoredShortcutRepairScript -PathType Leaf)) {
                    throw "The previous Anti-Codex runtime was restored but its shortcut repair script is missing."
                }
                $restoredShortcutRepairJson = (@(& $restoredShortcutRepairScript -InstallRoot $installRootFull) -join [Environment]::NewLine)
                $restoredShortcutRepairResult = $restoredShortcutRepairJson | ConvertFrom-Json
                if (-not $restoredShortcutRepairResult.ok) {
                    throw "The previous Anti-Codex runtime was restored but its shortcuts could not be refreshed."
                }
            }
            $restoredRuntimeFingerprint = Get-AntiCodexRuntimeGenerationFingerprint -Directory $targetRuntimeFull
            if (-not $NoRestart -and [IO.Directory]::Exists($targetRuntimeFull)) {
                $restoredBaseUrlScript = Join-Path $targetRuntimeFull "scripts\resolve-anticodex-base-url.ps1"
                if (Test-Path -LiteralPath $restoredBaseUrlScript -PathType Leaf) {
                    $BaseUrl = & $restoredBaseUrlScript
                }
                $compatibilitySyncMutex.ReleaseMutex()
                $compatibilitySyncMutexAcquired = $false
                $syncMutex.ReleaseMutex()
                $syncMutexAcquired = $false
                $restoredLaunch = Invoke-AntiCodexFixedRouteLauncher -Seconds ([Math]::Max(60, $TimeoutSec))
                if (-not $restoredLaunch.ok) {
                    throw "The previous Anti-Codex runtime was restored but could not be relaunched. exit=$($restoredLaunch.exitCode) $($restoredLaunch.stderr)"
                }
                $restoredHealth = Wait-AntiCodexHealth -Seconds $TimeoutSec
                $restoredFixedRoute = Wait-AntiCodexFixedRouteHealth -Seconds $TimeoutSec
                if (-not $restoredHealth -or -not $restoredFixedRoute) {
                    throw "The previous Anti-Codex runtime was restored but did not pass recovery health checks."
                }
                try {
                    $syncMutexAcquired = $syncMutex.WaitOne(300000)
                } catch [Threading.AbandonedMutexException] {
                    $syncMutexAcquired = $true
                }
                if (-not $syncMutexAcquired) {
                    $supersededByAnotherSync = $true
                    throw "Another Anti-Codex sync started during automatic restoration."
                }
                try {
                    $compatibilitySyncMutexAcquired = $compatibilitySyncMutex.WaitOne(300000)
                } catch [Threading.AbandonedMutexException] {
                    $compatibilitySyncMutexAcquired = $true
                }
                if (-not $compatibilitySyncMutexAcquired) {
                    $supersededByAnotherSync = $true
                    throw "Another Anti-Codex sync started during automatic restoration."
                }
                if (-not (Test-AntiCodexRuntimeSyncStateOwned -ExpectedTransactionId $transactionId) -or
                    (Get-AntiCodexRuntimeGenerationFingerprint -Directory $targetRuntimeFull) -ine $restoredRuntimeFingerprint) {
                    $supersededByAnotherSync = $true
                    throw "The active runtime changed during automatic restoration. Recovery status was not written."
                }
                $restoredRuntimeReady = $true
            }
        } catch {
            $restoreError = $_.Exception.Message
        }

        if ($supersededByAnotherSync) {
            throw $activationError
        }
        if ($restoreError -and (-not $syncMutexAcquired -or -not $compatibilitySyncMutexAcquired)) {
            try {
                if (-not $syncMutexAcquired) {
                    try {
                        $syncMutexAcquired = $syncMutex.WaitOne(300000)
                    } catch [Threading.AbandonedMutexException] {
                        $syncMutexAcquired = $true
                    }
                }
                if (-not $compatibilitySyncMutexAcquired) {
                    try {
                        $compatibilitySyncMutexAcquired = $compatibilitySyncMutex.WaitOne(300000)
                    } catch [Threading.AbandonedMutexException] {
                        $compatibilitySyncMutexAcquired = $true
                    }
                }
                if (-not $syncMutexAcquired -or -not $compatibilitySyncMutexAcquired) {
                    $supersededByAnotherSync = $true
                } elseif (-not (Test-AntiCodexRuntimeSyncStateOwned -ExpectedTransactionId $transactionId) -or
                    ($restoredRuntimeFingerprint -and
                        (Get-AntiCodexRuntimeGenerationFingerprint -Directory $targetRuntimeFull) -ine $restoredRuntimeFingerprint)) {
                    $supersededByAnotherSync = $true
                }
            } catch {
                $supersededByAnotherSync = $true
            }
        }
        if ($supersededByAnotherSync) {
            throw $activationError
        }
        if ($restoreError) {
            try {
                Set-AntiCodexRuntimeSyncState -State "activation_failed" -Message "Activation failed and automatic restoration could not finish." -ErrorMessage "$($activationError.Exception.Message); restore error: $restoreError"
            } catch {}
            throw "Anti-Codex runtime activation failed and automatic restoration could not finish: $($activationError.Exception.Message); restore error: $restoreError"
        }

        $restoredState = if ([IO.Directory]::Exists($targetRuntimeFull)) { "rolled_back" } else { "failed" }
        try {
            Set-AntiCodexRuntimeSyncState `
                -State $restoredState `
                -Message "Activation failed; the previous active runtime was restored." `
                -ErrorMessage $activationError.Exception.Message `
                -RestoredRuntimeReady $restoredRuntimeReady
        } catch {}
        throw $activationError
    }

    $result = [pscustomobject]@{
        ok = if ($NoRestart) { $runtimeHashMismatches.Count -eq 0 } else { $null -ne $health -and $null -ne $fixedRoute }
        synced = $true
        mode = if ($NoRestart) { "synced_without_restart" } else { "synced_and_restarted" }
        deferred = $false
        activated = $true
        transactionId = $transactionId
        verifiedFileCount = $requiredSourceFiles.Count
        sourceRoot = $sourceRootFull
        targetRuntime = $targetRuntimeFull
        stagedRuntime = $null
        rollbackRuntime = if ([IO.Directory]::Exists($rollbackRuntimeFull)) { $rollbackRuntimeFull } else { $null }
        cleanup = $runtimeCleanup
        baseUrl = $BaseUrl
        restarted = -not [bool]$NoRestart
        stoppedFixedRouteSupervisorCount = $stoppedFixedRouteSupervisorCount
        launchExitCode = $launchExitCode
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
        health = [pscustomobject]@{
            ok = if ($health) { $health.ok } else { $false }
            schema = if ($health) { $health.schema } else { $null }
            role = if ($health) { $health.role } else { $null }
        }
        fixedRoute = [pscustomobject]@{
            ok = if ($fixedRoute) { $fixedRoute.ok } else { $false }
            state = if ($fixedRoute) { $fixedRoute.state } else { $null }
            provider = if ($fixedRoute) { $fixedRoute.provider } else { $null }
            model = if ($fixedRoute) { $fixedRoute.model } else { $null }
        }
    }

    $result | ConvertTo-Json -Depth 8 -Compress
    if (-not $result.ok) { exit 1 }
} finally {
    if ($compatibilitySyncMutexAcquired) {
        $compatibilitySyncMutex.ReleaseMutex()
    }
    if ($syncMutexAcquired) {
        $syncMutex.ReleaseMutex()
    }
    $compatibilitySyncMutex.Dispose()
    $syncMutex.Dispose()
}
