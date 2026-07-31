#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$NoRestart,
    [switch]$FromUpdateTask
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
    if ($FromUpdateTask) { $delegateArgs += "-FromUpdateTask" }
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
$updateTaskScript = Join-Path $sourceRoot "scripts\start-anticodex-update-task.mjs"
foreach ($requiredScript in @($installer, $componentInstaller, $sourcePreflight, $validator, $rollbackScript, $baseUrlResolver, $refreshLocalFeatures, $postSyncVerifier, $updateChecker, $updateStatusModule, $updateTaskScript)) {
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
$launchTaskName = "Anti-Codex Launcher"
$launchTaskScript = Join-Path $sourceRoot "scripts\start-anticodex-task.mjs"
$updateTaskName = "Anti-Codex Updater"
$syncLauncherScript = Join-Path $sourceRoot "scripts\sync-anticodex-launcher.ps1"
$node = [IO.Path]::GetFullPath([string](Get-Command node.exe -ErrorAction Stop).Source)
$conhost = Join-Path ([Environment]::SystemDirectory) "conhost.exe"
$expectedUpdateTaskArguments = "--headless `"$node`" `"$updateTaskScript`" --hide-console"
$script:antiCodexScheduleService = $null
$script:antiCodexScheduleRoot = $null

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

function Assert-AntiCodexUpdateTaskContext {
    $task = Get-AntiCodexRegisteredTask -TaskName $updateTaskName
    $definition = $task.Definition
    $actionCount = [int]$definition.Actions.Count
    $action = if ($actionCount -eq 1) { $definition.Actions.Item(1) } else { $null }
    $currentUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $currentShortUserName = ($currentUserName -split "\\")[-1]
    $taskUserName = [string]$definition.Principal.UserId
    if ($actionCount -ne 1 -or
        [int]$task.State -ne 4 -or
        -not $task.Enabled -or
        -not $action -or
        [string]$action.Path -ine $conhost -or
        [string]$action.Arguments -cne $expectedUpdateTaskArguments -or
        [string]$action.WorkingDirectory -ine $installRoot -or
        ($taskUserName -ine $currentUserName -and $taskUserName -ine $currentShortUserName) -or
        [int]$definition.Principal.LogonType -ne 3 -or
        [int]$definition.Principal.RunLevel -ne 0 -or
        [int]$definition.Triggers.Count -ne 0 -or
        [int]$definition.Settings.MultipleInstances -ne 2 -or
        -not [bool]$definition.Settings.AllowDemandStart -or
        -not [bool]$definition.Settings.AllowHardTerminate -or
        [bool]$definition.Settings.RunOnlyIfIdle -or
        [bool]$definition.Settings.RunOnlyIfNetworkAvailable -or
        [bool]$definition.Settings.DisallowStartIfOnBatteries -or
        [bool]$definition.Settings.StopIfGoingOnBatteries -or
        [int]$definition.Settings.RestartCount -ne 0 -or
        [string]$definition.Settings.ExecutionTimeLimit -ne "PT0S") {
        throw "Anti-Codex sync refused an unverified updater-task context."
    }
}

if (-not $NoRestart) {
    if (-not $FromUpdateTask) {
        throw "Restarting Anti-Codex sync may only run through the isolated Anti-Codex Updater task."
    }
    Assert-AntiCodexUpdateTaskContext
}

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
        $fullPath = [IO.Path]::GetFullPath($Path)
        return $fullPath.IndexOf("\WindowsApps\OpenAI.Codex_", [StringComparison]::OrdinalIgnoreCase) -ge 0
    } catch {
        return $true
    }
}

function Get-AntiCodexProcessIdentity {
    param([Parameter(Mandatory = $true)]$ProcessRow)
    $processHandle = $null
    try {
        $processId = [int]$ProcessRow.ProcessId
        if ($processId -le 0 -or $processId -eq $PID) { return $null }
        $processHandle = [AntiCodex.Native.VerifiedProcessHandle]::Open($processId)
        $executablePath = [IO.Path]::GetFullPath([string]$processHandle.ExecutablePath)
        return [pscustomobject]@{
            ProcessId = $processId
            CreationFileTimeUtcTicks = [long]$processHandle.CreationFileTimeUtcTicks
            ExecutablePath = $executablePath
            CommandLine = [string]$ProcessRow.CommandLine
        }
    } catch {
        return $null
    } finally {
        if ($processHandle) { $processHandle.Dispose() }
    }
}

function Stop-AntiCodexVerifiedProcess {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$AllowedRoot
    )

    $processId = [int]$Snapshot.ProcessId
    $expectedCreationFileTimeUtcTicks = [long]$Snapshot.CreationFileTimeUtcTicks
    $expectedExecutablePath = [IO.Path]::GetFullPath([string]$Snapshot.ExecutablePath)
    if ($processId -le 0 -or $processId -eq $PID -or
        $expectedCreationFileTimeUtcTicks -le 0 -or
        -not (Test-AntiCodexPathInsideRoot -Path $expectedExecutablePath -Root $AllowedRoot) -or
        (Test-AntiCodexNativeCodexPath -Path $expectedExecutablePath)) {
        throw "Refusing to stop an unverified or non-isolated process PID $processId."
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
            -not (Test-AntiCodexPathInsideRoot -Path $liveExecutablePath -Root $AllowedRoot) -or
            (Test-AntiCodexNativeCodexPath -Path $liveExecutablePath)) {
            throw "Refusing to stop PID $processId because its handle-bound creation time or executable path changed."
        }
        if ($processHandle.HasExited) { return $true }
        $processHandle.TerminateAndWait(3000)
        return $true
    } catch {
        throw "Verified Anti-Codex process PID $processId could not be stopped through its bound handle; no broader target was attempted. $($_.Exception.Message)"
    } finally {
        if ($processHandle) { $processHandle.Dispose() }
    }
}

function Get-AntiCodexHostProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
        $identity = Get-AntiCodexProcessIdentity -ProcessRow $_
        if ($identity -and
            (Test-AntiCodexPathInsideRoot -Path ([string]$identity.ExecutablePath) -Root $activeHost) -and
            -not (Test-AntiCodexNativeCodexPath -Path ([string]$identity.ExecutablePath))) {
            $identity
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
            Stop-AntiCodexVerifiedProcess -Snapshot $process -AllowedRoot $activeHost | Out-Null
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return @(Get-AntiCodexHostProcesses).Count -eq 0
}

function Get-AntiCodexComponentProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
        $identity = Get-AntiCodexProcessIdentity -ProcessRow $_
        if ($identity -and
            (Test-AntiCodexPathInsideRoot -Path ([string]$identity.ExecutablePath) -Root $activeComponent) -and
            -not (Test-AntiCodexNativeCodexPath -Path ([string]$identity.ExecutablePath))) {
            $identity
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
            Stop-AntiCodexVerifiedProcess -Snapshot $process -AllowedRoot $activeComponent | Out-Null
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
    $actualHash = (Get-AntiCodexSha256 -Path $binaryPath).ToLowerInvariant()
    if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or $actualHash -ne $expectedHash) {
        throw "CodexPlusPlus component binary hash is invalid: $resolvedRoot"
    }
    return $manifest
}

function Test-AntiCodexComponentLaunchability {
    param([Parameter(Mandatory = $true)][string]$ComponentRoot)

    $binaryPath = Join-Path ([IO.Path]::GetFullPath($ComponentRoot)) "codex-plus-plus.exe"
    $resolvedCandidateRoot = [IO.Path]::GetFullPath($candidateRoot).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    $probeState = [IO.Path]::GetFullPath((Join-Path $resolvedCandidateRoot ("codexplusplus-launch-probe-" + [Guid]::NewGuid().ToString("N"))))
    if (-not $probeState.StartsWith("$resolvedCandidateRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing an unsafe CodexPlusPlus launch-probe state path."
    }
    New-Item -ItemType Directory -Path $probeState -Force | Out-Null
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $binaryPath
    $startInfo.Arguments = "--helper-only --helper-port 0"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables["CODEX_PLUS_STATE_DIR"] = $probeState
    $process = $null
    try {
        try {
            $process = [Diagnostics.Process]::Start($startInfo)
        } catch {
            $quarantineHint = if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
                " The candidate disappeared during process creation; security software may have quarantined it."
            } else {
                ""
            }
            throw "Windows refused to start the CodexPlusPlus candidate before activation: $($_.Exception.Message)$quarantineHint"
        }
        Start-Sleep -Milliseconds 300
    } finally {
        if ($process) {
            if (-not $process.HasExited) {
                try {
                    $process.Kill()
                } catch {
                    if (-not $process.HasExited) { throw }
                }
            }
            [void]$process.WaitForExit(5000)
            $process.Dispose()
        }
        $extendedProbeState = if ($probeState.StartsWith("\\?\")) { $probeState } else { "\\?\$probeState" }
        if ([IO.Directory]::Exists($extendedProbeState)) {
            [IO.Directory]::Delete($extendedProbeState, $true)
        }
    }
}

function Get-AntiCodexLaunchers {
    $escapedStartScript = [regex]::Escape($startAntiCodex)
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and
        ([string]$_.CommandLine) -match $escapedStartScript
    })
}

function Wait-AntiCodexLaunchersStopped {
    param([int]$TimeoutSeconds = 10)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (@(Get-AntiCodexLaunchers).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return @(Get-AntiCodexLaunchers).Count -eq 0
}

function Assert-AntiCodexNoRunningReleaseProcesses {
    if (@(Get-AntiCodexHostProcesses).Count -gt 0 -or
        @(Get-AntiCodexComponentProcesses).Count -gt 0 -or
        @(Get-AntiCodexLaunchers).Count -gt 0) {
        throw "NoRestart refuses to terminate a live Anti-Codex release. Close Anti-Codex and retry."
    }
    try {
        $task = Get-AntiCodexRegisteredTask -TaskName $launchTaskName
        if ([int]$task.State -eq 4) {
            throw "NoRestart refuses to stop the running Anti-Codex launch task."
        }
    } catch {
        if ($_.Exception.Message -like "NoRestart refuses*") { throw }
    }
}

function Invoke-AntiCodexFixedRouteShutdown {
    $authPath = Join-Path $stateRoot "codex-home-deepseek-app\auth.json"
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

function Wait-AntiCodexLaunchTaskStopped {
    param([int]$TimeoutSeconds = 30)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $task = Get-AntiCodexRegisteredTask -TaskName $launchTaskName
            if ([int]$task.State -ne 4) { return $true }
        } catch {
            return $false
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Assert-AntiCodexLaunchTaskContract {
    $task = Get-AntiCodexRegisteredTask -TaskName $launchTaskName
    $definition = $task.Definition
    $actionCount = [int]$definition.Actions.Count
    $action = if ($actionCount -eq 1) { $definition.Actions.Item(1) } else { $null }
    $expectedArguments = "--headless `"$node`" `"$launchTaskScript`" --hide-console"
    $currentUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $currentShortUserName = ($currentUserName -split "\\")[-1]
    $taskUserName = [string]$definition.Principal.UserId
    if ($actionCount -ne 1 -or
        -not $task.Enabled -or
        -not $action -or
        [string]$action.Path -ine $conhost -or
        [string]$action.Arguments -cne $expectedArguments -or
        [string]$action.WorkingDirectory -ine $installRoot -or
        ($taskUserName -ine $currentUserName -and $taskUserName -ine $currentShortUserName) -or
        [int]$definition.Principal.LogonType -ne 3 -or
        [int]$definition.Principal.RunLevel -ne 0 -or
        [int]$definition.Triggers.Count -ne 0 -or
        [int]$definition.Settings.MultipleInstances -ne 2 -or
        -not [bool]$definition.Settings.AllowDemandStart -or
        -not [bool]$definition.Settings.AllowHardTerminate -or
        [bool]$definition.Settings.RunOnlyIfIdle -or
        [bool]$definition.Settings.RunOnlyIfNetworkAvailable -or
        [bool]$definition.Settings.DisallowStartIfOnBatteries -or
        [bool]$definition.Settings.StopIfGoingOnBatteries -or
        [int]$definition.Settings.RestartCount -ne 0 -or
        [string]$definition.Settings.ExecutionTimeLimit -ne "PT0S") {
        throw "The isolated Anti-Codex launch task is missing or does not match the installed runtime."
    }
    return $task
}

function Stop-AntiCodexLaunchTaskForMaintenance {
    $null = Invoke-AntiCodexFixedRouteShutdown
    if (Wait-AntiCodexLaunchTaskStopped -TimeoutSeconds 20) { return }

    $task = Assert-AntiCodexLaunchTaskContract
    $task.Stop(0)
    if (-not (Wait-AntiCodexLaunchTaskStopped -TimeoutSeconds 10)) {
        throw "The isolated Anti-Codex launch task did not stop before maintenance."
    }
}

function Start-AntiCodexAfterSync {
    param([Parameter(Mandatory = $true)][string]$StartScript)

    $launchTaskName = "Anti-Codex Launcher"
    $taskLauncher = Join-Path (Split-Path -Parent $StartScript) "start-anticodex-task.mjs"
    if (-not (Test-Path -LiteralPath $taskLauncher -PathType Leaf)) {
        throw "The isolated Anti-Codex task launcher is missing: $taskLauncher"
    }
    $task = Assert-AntiCodexLaunchTaskContract
    if ([int]$task.State -eq 3) {
        Start-ScheduledTask -TaskName $launchTaskName
    } elseif ([int]$task.State -notin @(2, 4)) {
        throw "The isolated Anti-Codex launch task is not ready, queued, or running."
    }
}

function Get-OriginalCodexProcessSnapshot {
    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($process in @(Get-Process -Name "ChatGPT", "Codex" -ErrorAction SilentlyContinue)) {
        try {
            if ($process.MainWindowHandle -eq 0) { continue }
            $path = [IO.Path]::GetFullPath([string]$process.Path)
            if ($path -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$') { continue }
            $rows.Add([pscustomobject]@{
                processId = [int]$process.Id
                executablePath = $path
                startedAtUtc = $process.StartTime.ToUniversalTime().ToString("o")
            })
        } catch {}
    }
    return @($rows | Sort-Object executablePath, processId)
}

function Test-OriginalCodexProcessesUnchanged {
    param([AllowEmptyCollection()][object[]]$Expected = @())

    $current = @(Get-OriginalCodexProcessSnapshot)
    $expectedJson = ConvertTo-Json -InputObject @($Expected) -Depth 4 -Compress
    $currentJson = ConvertTo-Json -InputObject @($current) -Depth 4 -Compress
    return $expectedJson -eq $currentJson
}

function Wait-AntiCodexPostSyncReady {
    param(
        [int]$TimeoutSeconds = 60,
        [int]$StableSeconds = 20,
        [AllowEmptyCollection()][object[]]$OriginalCodexBefore = @()
    )

    $baseUrl = if ($env:TRANSLATOR_URL) { [string]$env:TRANSLATOR_URL } else { [string](& $baseUrlResolver) }
    $mainExecutable = [IO.Path]::GetFullPath((Join-Path $activeHost "Anti-Codex.exe"))
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $stableSince = $null
    do {
        $mainReady = @(Get-Process -Name "Anti-Codex" -ErrorAction SilentlyContinue | Where-Object {
            if ($_.MainWindowHandle -eq 0) { return $false }
            try { return ([IO.Path]::GetFullPath([string]$_.Path)) -eq $mainExecutable } catch { return $false }
        }).Count -eq 1
        $taskRunning = try {
            [int](Get-AntiCodexRegisteredTask -TaskName $launchTaskName).State -eq 4
        } catch {
            $false
        }
        $gatewayReady = $false
        try {
            $health = Invoke-RestMethod -Uri "$baseUrl/health" -Proxy $null -TimeoutSec $ANTICODEX_POST_SYNC_HEALTH_TIMEOUT_SEC
            $gatewayReady = $health.ok -eq $true
        } catch {}
        if (-not (Test-OriginalCodexProcessesUnchanged -Expected $OriginalCodexBefore)) {
            return $false
        }
        if ($mainReady -and $taskRunning -and $gatewayReady) {
            if ($null -eq $stableSince) { $stableSince = [DateTime]::UtcNow }
            if (([DateTime]::UtcNow - $stableSince).TotalSeconds -ge $StableSeconds) { return $true }
        } else {
            $stableSince = $null
        }
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
    $manifest.files | Add-Member -NotePropertyName hostIcon -NotePropertyValue (Get-AntiCodexSha256 -Path $rollbackResourceIcon) -Force
    $manifest.files | Add-Member -NotePropertyName trayIcon -NotePropertyValue (Get-AntiCodexSha256 -Path $rollbackTrayIcon) -Force
    $manifest.files | Add-Member -NotePropertyName appRootIcon -NotePropertyValue (Get-AntiCodexSha256 -Path $rollbackAppRootIcon) -Force
    $temporaryMarker = "$rollbackMarker.tmp"
    Remove-Item -LiteralPath $temporaryMarker -Force -ErrorAction SilentlyContinue
    $json = $manifest | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($temporaryMarker, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryMarker -Destination $rollbackMarker -Force
}

function Repair-RollbackHostUnpackedFileManifest {
    if (-not ([IO.Directory]::Exists("\\?\$rollbackHost")) -or
        -not ([IO.File]::Exists($rollbackMarker))) {
        return $false
    }

    $rollbackManifest = Get-Content -LiteralPath $rollbackMarker -Raw | ConvertFrom-Json
    $rollbackSchema = [string]$rollbackManifest.schema
    if ($rollbackSchema -notin @("anticodex-host-manifest-v1", "anticodex-host-manifest-v2")) {
        throw "Anti-Codex rollback host marker schema is invalid."
    }
    $rollbackManifestCompatible = $rollbackSchema -eq "anticodex-host-manifest-v2"
    $rollbackRootFull = [IO.Path]::GetFullPath($rollbackHost).TrimEnd("\")
    $rollbackUnpackedRoot = [IO.Path]::GetFullPath((Join-Path $rollbackRootFull "resources\app.asar.unpacked")).TrimEnd("\")
    $rollbackUnpackedAccessRoot = "\\?\$rollbackUnpackedRoot"
    if (-not [IO.Directory]::Exists($rollbackUnpackedAccessRoot)) {
        throw "Anti-Codex rollback unpacked resources are missing."
    }

    $actualRollbackFiles = @(Get-ChildItem -LiteralPath $rollbackUnpackedAccessRoot -File -Recurse -Force -ErrorAction Stop | Sort-Object FullName)
    if ($actualRollbackFiles.Count -eq 0) {
        throw "Anti-Codex rollback unpacked resources contain no files."
    }

    $rollbackUnpackedPrefix = "$rollbackUnpackedRoot\"
    $inventory = New-Object System.Collections.Generic.List[object]
    foreach ($rollbackFile in $actualRollbackFiles) {
        $rollbackAccessPath = [string]$rollbackFile.FullName
        $rollbackComparablePath = if ($rollbackAccessPath.StartsWith("\\?\", [StringComparison]::Ordinal)) {
            $rollbackAccessPath.Substring(4)
        } else {
            $rollbackAccessPath = "\\?\$rollbackAccessPath"
            [string]$rollbackFile.FullName
        }
        if (-not $rollbackComparablePath.StartsWith($rollbackUnpackedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Anti-Codex refused an unpacked rollback file outside the rollback tree."
        }
        $relativePath = $rollbackComparablePath.Substring($rollbackRootFull.Length).TrimStart("\")
        $inventory.Add([pscustomobject]@{
            path = $relativePath
            sha256 = Get-AntiCodexSha256 -Path $rollbackAccessPath
            size = [long]$rollbackFile.Length
        }) | Out-Null
    }

    $recordedFiles = @()
    $recordedFilesProperty = $rollbackManifest.PSObject.Properties["unpackedFiles"]
    if ($recordedFilesProperty) {
        $recordedFiles = @($recordedFilesProperty.Value)
    }
    if ($recordedFiles.Count -gt 0) {
        if ($recordedFiles.Count -ne $actualRollbackFiles.Count) {
            throw "Anti-Codex rollback unpacked file inventory is incomplete."
        }
        $recordedPaths = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
        foreach ($recordedFile in $recordedFiles) {
            $relativePath = [string]$recordedFile.path
            $recordedHash = [string]$recordedFile.sha256
            $recordedSizeProperty = $recordedFile.PSObject.Properties["size"]
            if (-not $relativePath -or -not $recordedHash -or -not $recordedSizeProperty -or [IO.Path]::IsPathRooted($relativePath)) {
                throw "Anti-Codex rollback marker contains an invalid unpacked file entry."
            }
            $recordedPath = [IO.Path]::GetFullPath((Join-Path $rollbackRootFull $relativePath))
            if (-not $recordedPath.StartsWith($rollbackUnpackedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
                -not $recordedPaths.Add($recordedPath)) {
                throw "Anti-Codex rollback marker contains an invalid unpacked file path."
            }
            $recordedAccessPath = "\\?\$recordedPath"
            if (-not [IO.File]::Exists($recordedAccessPath)) {
                throw "Anti-Codex rollback unpacked file is missing: $relativePath"
            }
            $actualHash = Get-AntiCodexSha256 -Path $recordedAccessPath
            $actualSize = [long](Get-Item -LiteralPath $recordedAccessPath).Length
            if ([string]$actualHash -ne $recordedHash -or $actualSize -ne [long]$recordedSizeProperty.Value) {
                throw "Anti-Codex rollback unpacked file does not match its marker: $relativePath"
            }
        }
        return $rollbackManifestCompatible
    }

    $rollbackManifest | Add-Member -NotePropertyName unpackedFiles -NotePropertyValue $inventory.ToArray() -Force
    $temporaryMarker = "$rollbackMarker.tmp"
    Remove-Item -LiteralPath $temporaryMarker -Force -ErrorAction SilentlyContinue
    $json = $rollbackManifest | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporaryMarker, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryMarker -Destination $rollbackMarker -Force
    return $rollbackManifestCompatible
}

$syncMutex = New-Object Threading.Mutex($false, "Local\AntiCodexHostSync")
if (-not $syncMutex.WaitOne(0)) {
    $syncMutex.Dispose()
    throw "Another Anti-Codex sync is already running."
}
$syncMutexAcquired = $true

$syncError = $null
$syncCompleted = $false
$activatedMarkerSha256 = ""
$supersededByAnotherSync = $false
$terminalStatusOwnedByRollback = $false
$restartAfterSync = $false
$rollbackAvailable = $false
$rollbackRestoreAvailable = $false
$activationRestored = $false
$originalCodexBeforeSync = @()
$updateStage = "candidate_build"
try {
    try {
        Set-AntiCodexUpdateOperation -State "running" -Stage "candidate_build" -Message "Building a candidate from the installed Codex version." -StateRoot $stateRoot
        Remove-FixedUpdateDirectory -Path $candidateRoot

        $sourceSelection = & $updateChecker -InstallRoot $installRoot -StateRoot $stateRoot -NoPersist | ConvertFrom-Json
        if (-not $sourceSelection.source.root) {
            throw "The newest installed Codex package root could not be resolved."
        }
        $selectedSourceRoot = [IO.Path]::GetFullPath([string]$sourceSelection.source.root)

        $global:LASTEXITCODE = 0
        & $installer -InstallTarget $candidateRoot -SourceRoot $selectedSourceRoot -HostOnly
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
        Test-AntiCodexComponentLaunchability -ComponentRoot $candidateComponent
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
        $originalCodexBeforeSync = @(Get-OriginalCodexProcessSnapshot)
        New-Item -ItemType Directory -Path (Split-Path -Parent $hostSyncMarker) -Force | Out-Null
        "Host sync marker $(Get-Date -Format o)" | Set-Content -LiteralPath $hostSyncMarker -Encoding ASCII
        Write-Host "Host sync marker created; stopping Anti-Codex before activation."
        $restartAfterSync = $true

        if ($NoRestart) {
            Assert-AntiCodexNoRunningReleaseProcesses
        } else {
            Stop-AntiCodexLaunchTaskForMaintenance
            if (-not (Wait-AntiCodexLaunchersStopped -TimeoutSeconds 10)) {
                throw "Anti-Codex launcher remained active after its verified task stopped. No process was force-terminated."
            }
            if (-not (Wait-AntiCodexHostRelease -TimeoutSeconds 20)) {
                throw "Anti-Codex host processes did not exit before the sync timeout. The active host was not changed."
            }
            if (-not (Wait-AntiCodexComponentRelease -TimeoutSeconds 20)) {
                throw "CodexPlusPlus processes did not exit before the sync timeout. The active release was not changed."
            }
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
            $rollbackRestoreAvailable = (
                $rollbackHostAvailable -and
                $rollbackComponentAvailable -and
                [IO.File]::Exists($rollbackMarker)
            )
            $rollbackAvailable = $false

            Move-FixedUpdateDirectory -Source $candidateHost -Destination $activeHost
            $activeHostChanged = $true
            $activationStarted = $true
            [IO.File]::Move($candidateMarker, $activeMarker)
            Move-FixedUpdateDirectory -Source $candidateComponent -Destination $activeComponent
            $activeComponentChanged = $true
            Test-AntiCodexComponent -ComponentRoot $activeComponent | Out-Null
            $rollbackManifestSchemaCompatible = [bool](Repair-RollbackHostUnpackedFileManifest)
            if ($rollbackRestoreAvailable -and $rollbackManifestSchemaCompatible) {
                Repair-RollbackHostIconManifest
                & $rollbackScript -ValidateOnly
                $rollbackAvailable = $true
            }
            Remove-FixedUpdateDirectory -Path $candidateRoot
            $activatedMarkerSha256 = Get-AntiCodexSha256 -Path $activeMarker
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
                    $recoveryState = if ($rollbackRestoreAvailable) { "the previous host and component were preserved" } else { "a complete previous release was not available" }
                    throw "Anti-Codex activation failed. Automatic recovery also failed; ${recoveryState}: $activationError; recovery error: $($_.Exception.Message)"
                }
                if ($rollbackRestoreAvailable) {
                    $activationRestored = $true
                    $rollbackAvailable = $false
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
$syncMutex.ReleaseMutex()
$syncMutexAcquired = $false

if ($syncError) {
    try {
        $recoveryRestartError = ""
        if (-not $NoRestart -and $restartAfterSync) {
            try {
                $activeExecutable = Join-Path $activeHost "Anti-Codex.exe"
                if ((Test-Path -LiteralPath $activeExecutable -PathType Leaf) -and
                    (Test-Path -LiteralPath $activeMarker -PathType Leaf) -and
                    (Test-Path -LiteralPath (Join-Path $activeComponent "codex-plus-plus.exe") -PathType Leaf)) {
                    Test-AntiCodexComponent -ComponentRoot $activeComponent | Out-Null
                    Start-AntiCodexAfterSync -StartScript $startAntiCodex
                }
            } catch {
                $recoveryRestartError = $_.Exception.Message
                $syncError.Exception.Data["AntiCodexRecoveryRestartError"] = $recoveryRestartError
            }
        }
        if ($activationRestored) {
            Set-AntiCodexUpdateOperation -State "rolled_back" -Stage "activation" -Message $syncError.Exception.Message -RollbackAvailable $false -StateRoot $stateRoot
        } else {
            Set-AntiCodexUpdateOperation -State "failed" -Stage $updateStage -Message $syncError.Exception.Message -FailureCode "sync_failed" -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
        }
    } finally {
        $syncMutex.Dispose()
    }
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
        $postSyncReady = Wait-AntiCodexPostSyncReady `
            -TimeoutSeconds $ANTICODEX_POST_SYNC_READY_TIMEOUT_SEC `
            -StableSeconds 20 `
            -OriginalCodexBefore $originalCodexBeforeSync
        $postSyncAcceptance = if ($postSyncReady) {
            Invoke-AntiCodexPostSyncAcceptance -TimeoutSeconds 35
        } else {
            [pscustomobject]@{ ok = $false; message = "The synced Anti-Codex host did not become ready." }
        }
    }
}

if ($syncCompleted) {
    try {
        $syncMutexAcquired = $syncMutex.WaitOne(300000)
    } catch [Threading.AbandonedMutexException] {
        $syncMutexAcquired = $true
    }
    if (-not $syncMutexAcquired) {
        $supersededByAnotherSync = $true
        throw "Another Anti-Codex sync remained active after post-sync acceptance."
    }
    $currentActiveMarkerSha256 = if ([IO.File]::Exists($activeMarker)) {
        Get-AntiCodexSha256 -Path $activeMarker
    } else {
        ""
    }
    if (-not $activatedMarkerSha256 -or $currentActiveMarkerSha256 -ine $activatedMarkerSha256) {
        $supersededByAnotherSync = $true
        throw "The active release changed after activation. This sync will not accept, clean up, or roll back another generation."
    }
}

if ($syncCompleted -and (-not $postSyncReady -or $postSyncAcceptance.ok -ne $true)) {
    if (-not $rollbackAvailable) {
        throw "$([string]$postSyncAcceptance.message) No compatible rollback release was available."
    }
    $rollbackFailure = $null
    $failureReason = [string]$postSyncAcceptance.message
    try {
        $syncMutex.ReleaseMutex()
        $syncMutexAcquired = $false
        $global:LASTEXITCODE = 0
        & $rollbackScript -ExpectedActiveMarkerSha256 $activatedMarkerSha256
        if ($LASTEXITCODE -ne 0) {
            throw "rollback exited with code $LASTEXITCODE"
        }
    } catch {
        $rollbackFailure = $_.Exception.Message
    }
    if ($rollbackFailure) {
        try {
            $syncMutexAcquired = $syncMutex.WaitOne(0)
        } catch [Threading.AbandonedMutexException] {
            $syncMutexAcquired = $true
        }
        if (-not $syncMutexAcquired) {
            $supersededByAnotherSync = $true
        } else {
            $currentActiveMarkerSha256 = if ([IO.File]::Exists($activeMarker)) {
                Get-AntiCodexSha256 -Path $activeMarker
            } else {
                ""
            }
            if ($currentActiveMarkerSha256 -ine $activatedMarkerSha256) {
                $supersededByAnotherSync = $true
            }
        }
        throw "$failureReason Automatic rollback also failed: $rollbackFailure"
    }
    $terminalStatusOwnedByRollback = $true
    throw "$failureReason Automatic rollback restored the previous host."
}

if ($syncCompleted) {
    if (-not $rollbackAvailable) {
        if ([IO.File]::Exists($rollbackMarker)) {
            Remove-Item -LiteralPath $rollbackMarker -Force -ErrorAction Stop
        }
        Remove-FixedUpdateDirectory -Path $rollbackHost
        Remove-FixedUpdateDirectory -Path $rollbackComponent
    }
    try {
        & $updateChecker -InstallRoot $installRoot -StateRoot $stateRoot | Out-Null
    } catch {
        Write-Warning "Anti-Codex sync succeeded, but the update fingerprint refresh needs a later Manager retry: $($_.Exception.Message)"
    }
    $rollbackCompletionMessage = if ($rollbackAvailable) {
        "The previous release is available for rollback."
    } else {
        "No compatible previous release is available for rollback."
    }
    $completionMessage = if ($NoRestart) {
        "Anti-Codex is synced with the installed Codex version and will use it on the next launch. $rollbackCompletionMessage"
    } else {
        "Anti-Codex is synced with the installed Codex version. $rollbackCompletionMessage"
    }
    Set-AntiCodexUpdateOperation -State "succeeded" -Stage "complete" -Message $completionMessage -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
    if ($NoRestart) {
        Write-Host $completionMessage
    } else {
        $shell = New-Object -ComObject WScript.Shell
        $popupMessage = "Anti-Codex passed compatibility checks and is now synced with the installed Codex version. $rollbackCompletionMessage"
        $shell.Popup(
            $popupMessage,
            8,
            "Anti-Codex Sync Complete",
            64
        ) | Out-Null
    }
}
} catch {
    if (-not $supersededByAnotherSync -and -not $terminalStatusOwnedByRollback) {
        $terminalStatus = Get-AntiCodexUpdateStatus -StateRoot $stateRoot
        if ($terminalStatus.operation.state -ne "rolled_back") {
            Set-AntiCodexUpdateOperation -State "failed" -Stage $updateStage -Message $_.Exception.Message -FailureCode "sync_failed" -RollbackAvailable $rollbackAvailable -StateRoot $stateRoot
        }
    }
    throw
} finally {
    if ($syncMutexAcquired) {
        $syncMutex.ReleaseMutex()
    }
    $syncMutex.Dispose()
}
