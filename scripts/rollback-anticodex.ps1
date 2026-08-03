#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$RecoveryAttempt,
    [switch]$ValidateOnly,
    [string]$ExpectedActiveMarkerSha256 = ""
)

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

if (-not ("AntiCodex.Native.WindowsCommandLine" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace AntiCodex.Native
{
    public static class WindowsCommandLine
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LocalFree(IntPtr value);

        public static string[] Parse(string commandLine)
        {
            if (String.IsNullOrWhiteSpace(commandLine)) return new string[0];
            int argumentCount;
            IntPtr argumentVector = CommandLineToArgvW(commandLine, out argumentCount);
            if (argumentVector == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not parse the Windows process command line.");
            try
            {
                string[] arguments = new string[argumentCount];
                for (int index = 0; index < argumentCount; index++)
                {
                    IntPtr argument = Marshal.ReadIntPtr(argumentVector, index * IntPtr.Size);
                    arguments[index] = Marshal.PtrToStringUni(argument) ?? String.Empty;
                }
                return arguments;
            }
            finally
            {
                LocalFree(argumentVector);
            }
        }
    }
}
'@
}

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
$activeComponent = Join-Path $installRoot "components\codexplusplus"
$rollbackComponent = Join-Path $installRoot "rollback-codexplusplus"
$swapComponent = Join-Path $installRoot "rollback-swap-codexplusplus"
$startAntiCodex = Join-Path $sourceRoot "scripts\start-anticodex.ps1"
$launchTaskName = "Anti-Codex Launcher"
$launchTaskScript = Join-Path $sourceRoot "scripts\start-anticodex-task.mjs"
$node = [IO.Path]::GetFullPath([string](Get-Command node.exe -ErrorAction Stop).Source)
$conhost = Join-Path ([Environment]::SystemDirectory) "conhost.exe"
$baseUrlResolver = Join-Path $sourceRoot "scripts\resolve-anticodex-base-url.ps1"
foreach ($requiredLaunchComponent in @($launchTaskScript, $node, $conhost)) {
    if (-not (Test-Path -LiteralPath $requiredLaunchComponent -PathType Leaf)) {
        throw "Anti-Codex launch component is missing: $requiredLaunchComponent"
    }
}
$hostSyncMarker = if ($env:ANTICODEX_HOST_SYNC_MARKER) { $env:ANTICODEX_HOST_SYNC_MARKER } else { Join-Path (Join-Path $env:APPDATA "anticodex") "host-sync.lock" }
$env:ANTICODEX_HOST_SYNC_MARKER = $hostSyncMarker
$stateRoot = if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }

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

function Assert-FixedComponentPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $allowed = @($activeComponent, $rollbackComponent, $swapComponent) | ForEach-Object { [IO.Path]::GetFullPath($_) }
    if ($fullPath -notin $allowed) { throw "Refusing to modify an unexpected CodexPlusPlus component path: $fullPath" }
    return $fullPath
}

function Move-FixedComponentDirectory {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    $fullSource = Assert-FixedComponentPath $Source
    $fullDestination = Assert-FixedComponentPath $Destination
    if (-not [IO.Directory]::Exists("\\?\$fullSource")) { throw "CodexPlusPlus component source is missing: $fullSource" }
    if ([IO.Directory]::Exists("\\?\$fullDestination")) { throw "CodexPlusPlus component destination already exists: $fullDestination" }
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
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateSet("fixed-shell-v1")][string]$PatchProfile,
        [Parameter(Mandatory = $true)][ValidateSet(0, 1)][int]$ExpectedConfigWriteBridgeCount,
        [Parameter(Mandatory = $true)][ValidateSet(0, 1)][int]$ExpectedPrimaryWindowDeferredRestoreRepaintCount,
        [Parameter(Mandatory = $true)][ValidateSet(0, 1)][int]$ExpectedPrimaryWindowFocusRestoreRepaintCount,
        [Parameter(Mandatory = $true)][ValidateSet(0, 1)][int]$ExpectedLegacyPrimaryWindowRestoreRepaintCount,
        [ValidateSet(0, 2, 3)][int]$ExpectedHostPatchRevision = 0
    )

    $text = [System.Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($Path))
    $requiredMarkers = @(
        '.app.name=`Anti-Codex`',
        "AntiCodex",
        'icon:`icon.ico`',
        "__ANTICODEX_OPEN_MANAGER__",
        "\u7ba1\u7406"
    )
    foreach ($marker in $requiredMarkers) {
        if (-not $text.Contains($marker)) {
            throw "Anti-Codex host app.asar is missing actual patch marker: $marker"
        }
    }
    if ($ExpectedHostPatchRevision -in @(2, 3)) {
        $settingsDefinitionPattern = '/\*anticodex-local-settings-only\*/account:\{href:`about:blank`,icon:[\w$]+,message:(?<messages>[\w$]+)\.account\},securitySettings:\{href:`about:blank`,icon:[\w$]+,message:\k<messages>\.securitySettings\}'
        if ([regex]::Matches($text, $settingsDefinitionPattern).Count -ne 1 -or
            [regex]::Matches($text, '/\*anticodex-hide-external-account\*/null').Count -ne 1 -or
            [regex]::Matches($text, 'securitySettingsEnabled:0\s*\}').Count -ne 1 -or
            [regex]::Matches($text, '\{\.\.\.[\w$]+,securitySettingsEnabled:[A-Za-z_$][\w$]*\s*\}').Count -ne 0 -or
            [regex]::Matches($text, '\.securitySettings\.message').Count -lt 1 -or
            [regex]::Matches($text, '/\*anticodex-local-settings-only\*/\s*\}').Count -ne 0) {
            throw "Anti-Codex host app.asar Settings compatibility patch is invalid."
        }
    }
    $retiredFeaturePatchPatterns = @(
        '\?\.length<1\|\|[\w$]+\([\w$]+,[\w$]+\)',
        'var [\w$]+=async\(\)=>\(\{marketplaces:\[\]\}\);',
        'async listPlugins\([\w$]+\)\{return\{marketplaces:\[\],marketplaceLoadErrors:\[\]\}\}',
        '"list-plugins":[\w$]+\(([\w$]+)=>\1\.listPlugins\(\{\}\)\)',
        'case`error`:if\([\w$]+\.willRetry\)\{break\}else if\('
    )
    foreach ($pattern in $retiredFeaturePatchPatterns) {
        if ($text -match $pattern) {
            throw "Anti-Codex fixed shell host contains a retired feature patch: $pattern"
        }
    }
    $configWriteBridgePattern = '"batch-write-config-value":(?:async )?([\w$]+)=>this\.getRequestAppServerClient\(\1\.hostId\)\.sendAppServerRequest\([`"]config/batchWrite[`"],\1\)'
    if ([regex]::Matches($text, $configWriteBridgePattern).Count -ne $ExpectedConfigWriteBridgeCount) {
        throw "Anti-Codex host app.asar native config write bridge count is invalid."
    }
    $codexTraySelectorCount = [regex]::Matches($text, 'codex-tray\.ico').Count
    $alternateTraySelectorCount = [regex]::Matches($text, 'icon-agent\.ico|chatgpt-tray-(?:dark|light)\.ico').Count
    if ($codexTraySelectorCount -lt 4 -or $alternateTraySelectorCount -ne 0) {
        throw "Anti-Codex host app.asar still selects a ChatGPT-branded Windows tray icon."
    }
    $primaryDeferredRestoreRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{let ([\w$]+)=\(\)=>this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\),([\w$]+)=\(\)=>\{try\{\1\.webContents\.invalidate\(\)\}catch\{\}\};this\.primaryWindows\.add\(\1\),\1\.isFocused\(\)\?\(this\.lastActivePrimaryWindow=\1,\2\(\)\):this\.lastActivePrimaryWindow\?\?=\1,this\.emitPrimaryWindowChangeIfNeeded\(\),\1\.on\(`focus`,\(\)=>\{this\.lastActivePrimaryWindow=\1,\2\(\),this\.emitPrimaryWindowChangeIfNeeded\(\)\}\),\1\.on\(`blur`,\2\),\1\.on\(`restore`,\(\)=>setImmediate\(\3\)\)\}'
    $primaryFocusRestoreRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{let ([\w$]+)=\(\)=>this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\),([\w$]+)=\(\)=>\{try\{\1\.webContents\.invalidate\(\)\}catch\{\}\};this\.primaryWindows\.add\(\1\),\1\.isFocused\(\)\?\(this\.lastActivePrimaryWindow=\1,\2\(\)\):this\.lastActivePrimaryWindow\?\?=\1,this\.emitPrimaryWindowChangeIfNeeded\(\),\1\.on\(`focus`,\(\)=>\{this\.lastActivePrimaryWindow=\1,\2\(\),this\.emitPrimaryWindowChangeIfNeeded\(\),\3\(\)\}\),\1\.on\(`blur`,\2\),\1\.on\(`restore`,\(\)=>setImmediate\(\3\)\)\}'
    $legacyPrimaryRestoreRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{let ([\w$]+)=\(\)=>this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\);this\.primaryWindows\.add\(\1\),\1\.isFocused\(\)\?\(this\.lastActivePrimaryWindow=\1,\2\(\)\):this\.lastActivePrimaryWindow\?\?=\1,this\.emitPrimaryWindowChangeIfNeeded\(\),\1\.on\(`focus`,\(\)=>\{this\.lastActivePrimaryWindow=\1,\2\(\),this\.emitPrimaryWindowChangeIfNeeded\(\)\}\),\1\.on\(`blur`,\2\),\1\.on\(`restore`,\(\)=>\1\.webContents\.invalidate\?\.\(\)\)\}'
    $anyPrimaryWindowRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{.{0,700}?\1\.webContents\.invalidate(?:\?\.)?\(\)'
    if ([regex]::Matches($text, $primaryDeferredRestoreRepaintPattern).Count -ne $ExpectedPrimaryWindowDeferredRestoreRepaintCount) {
        throw "Anti-Codex host app.asar primary-window deferred restore repaint count is invalid."
    }
    if ([regex]::Matches($text, $primaryFocusRestoreRepaintPattern).Count -ne $ExpectedPrimaryWindowFocusRestoreRepaintCount) {
        throw "Anti-Codex host app.asar primary-window focus/restore repaint count is invalid."
    }
    if ([regex]::Matches($text, $anyPrimaryWindowRepaintPattern).Count -ne ($ExpectedPrimaryWindowDeferredRestoreRepaintCount + $ExpectedPrimaryWindowFocusRestoreRepaintCount + $ExpectedLegacyPrimaryWindowRestoreRepaintCount)) {
        throw "Anti-Codex host app.asar contains an unexpected primary-window repaint shape."
    }
    if ([regex]::Matches($text, $legacyPrimaryRestoreRepaintPattern).Count -ne $ExpectedLegacyPrimaryWindowRestoreRepaintCount) {
        throw "Anti-Codex host app.asar legacy primary-window restore repaint count is invalid."
    }
}

function Test-AntiCodexCriticalPatchSet {
    param(
        [Parameter(Mandatory = $true)][object[]]$Recorded,
        [Parameter(Mandatory = $true)][string[]]$Expected
    )

    return (
        $Recorded.Count -eq $Expected.Count -and
        @($Expected | Where-Object { $_ -notin $Recorded }).Count -eq 0
    )
}

function Test-AntiCodexHost {
    param([Parameter(Mandatory = $true)][string]$HostRoot, [Parameter(Mandatory = $true)][string]$MarkerPath)
    $hostRootFull = Assert-FixedHostPath $HostRoot
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
        "browser-window-icon",
        "primary-window-restore-repaint",
        "windows-tray-icon",
        "local-model-availability"
    )
    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) { throw "Anti-Codex host marker is missing: $MarkerPath" }
    $manifest = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
    $manifestSchema = [string]$manifest.schema
    if ($manifestSchema -ne "anticodex-host-manifest-v2") {
        throw "Anti-Codex host marker schema is invalid: $MarkerPath"
    }
    if (($manifest.PSObject.Properties.Name -notcontains "patchProfile") -or [string]$manifest.patchProfile -ne "fixed-shell-v1") {
        throw "Anti-Codex host marker patch profile is invalid: $MarkerPath"
    }
    $patchProfile = "fixed-shell-v1"
    $currentHostPatchRevision = 3
    $hostPatchRevisionProperty = $manifest.PSObject.Properties["hostPatchRevision"]
    $legacyHostPatchRevision = $null -eq $hostPatchRevisionProperty
    $hostPatchRevisionText = if ($legacyHostPatchRevision) { "0" } else { [string]$hostPatchRevisionProperty.Value }
    if (-not $legacyHostPatchRevision -and $hostPatchRevisionText -notin @("2", [string]$currentHostPatchRevision)) {
        throw "Anti-Codex host marker patch revision is invalid: $MarkerPath"
    }
    $hostPatchRevision = [int]$hostPatchRevisionText
    $expectedCriticalPatches = @($fixedShellCriticalPatches)
    $previousCriticalPatches = @(
        "package-json",
        "webview-html-title",
        "app-name",
        "app-user-model-id",
        "session-title",
        "startup-mcp-config-reload",
        "config-write",
        "auth-requirement",
        "app-route-gate",
        "profile-dropdown-settings",
        "browser-window-icon",
        "primary-window-restore-repaint",
        "windows-tray-icon",
        "local-model-availability"
    )
    $legacyWithoutConfigWriteCriticalPatches = @(
        "package-json",
        "webview-html-title",
        "app-name",
        "app-user-model-id",
        "session-title",
        "startup-mcp-config-reload",
        "auth-requirement",
        "app-route-gate",
        "profile-dropdown-settings",
        "browser-window-icon",
        "primary-window-restore-repaint",
        "windows-tray-icon",
        "local-model-availability"
    )

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
    $currentManifestCompatible = -not $legacyHostPatchRevision -and (Test-AntiCodexCriticalPatchSet `
        -Recorded $recordedCriticalPatches `
        -Expected $expectedCriticalPatches) -and $hostPatchRevision -eq $currentHostPatchRevision
    $revision2ManifestCompatible = -not $legacyHostPatchRevision -and (Test-AntiCodexCriticalPatchSet `
        -Recorded $recordedCriticalPatches `
        -Expected $expectedCriticalPatches) -and $hostPatchRevision -eq 2
    $previousManifestCompatible = $legacyHostPatchRevision -and (Test-AntiCodexCriticalPatchSet `
        -Recorded $recordedCriticalPatches `
        -Expected $previousCriticalPatches)
    $legacyWithoutConfigWriteManifestCompatible = $legacyHostPatchRevision -and (Test-AntiCodexCriticalPatchSet `
        -Recorded $recordedCriticalPatches `
        -Expected $legacyWithoutConfigWriteCriticalPatches)
    if (-not $currentManifestCompatible -and
        -not $revision2ManifestCompatible -and
        -not $previousManifestCompatible -and
        -not $legacyWithoutConfigWriteManifestCompatible) {
        throw "Anti-Codex host marker is missing critical compatibility patches."
    }
    $recordedFiles = @()
    $recordedFilesProperty = $manifest.PSObject.Properties["unpackedFiles"]
    if ($recordedFilesProperty) {
        $recordedFiles = @($recordedFilesProperty.Value)
    }
    if ($recordedFiles.Count -eq 0) {
        throw "Anti-Codex host marker is missing unpacked file inventory."
    }
    $hostUnpackedRoot = [IO.Path]::GetFullPath((Join-Path $hostRootFull "resources\app.asar.unpacked")).TrimEnd("\")
    $hostUnpackedPrefix = "$hostUnpackedRoot\"
    $recordedPaths = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
    foreach ($recordedFile in $recordedFiles) {
        $relativePath = [string]$recordedFile.path
        $recordedHash = [string]$recordedFile.sha256
        $recordedSizeProperty = $recordedFile.PSObject.Properties["size"]
        if (-not $relativePath -or -not $recordedHash -or -not $recordedSizeProperty -or [IO.Path]::IsPathRooted($relativePath)) {
            throw "Anti-Codex host marker contains an invalid unpacked file entry."
        }
        $unpackedFilePath = [IO.Path]::GetFullPath((Join-Path $hostRootFull $relativePath))
        $unpackedFileAccessPath = "\\?\$unpackedFilePath"
        if (-not $unpackedFilePath.StartsWith($hostUnpackedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.File]::Exists($unpackedFileAccessPath)) {
            throw "Anti-Codex host unpacked file is missing or outside app.asar.unpacked: $relativePath"
        }
        if ([string](Get-AntiCodexSha256 -Path $unpackedFileAccessPath) -ne $recordedHash) {
            throw "Anti-Codex host unpacked file hash mismatch: $relativePath"
        }
        if ([long](Get-Item -LiteralPath $unpackedFileAccessPath).Length -ne [long]$recordedSizeProperty.Value) {
            throw "Anti-Codex host unpacked file size mismatch: $relativePath"
        }
        if (-not $recordedPaths.Add($unpackedFilePath)) {
            throw "Anti-Codex host marker repeats an unpacked file path: $relativePath"
        }
    }
    $actualFiles = @(Get-ChildItem -LiteralPath "\\?\$hostUnpackedRoot" -File -Recurse -Force -ErrorAction Stop)
    if ($actualFiles.Count -ne $recordedFiles.Count) {
        throw "Anti-Codex host unpacked file inventory is incomplete."
    }
    if ($currentManifestCompatible) {
        Test-AntiCodexAsarPatches `
            -Path $required.appAsar `
            -PatchProfile $patchProfile `
            -ExpectedConfigWriteBridgeCount 1 `
            -ExpectedPrimaryWindowDeferredRestoreRepaintCount 1 `
            -ExpectedPrimaryWindowFocusRestoreRepaintCount 0 `
            -ExpectedLegacyPrimaryWindowRestoreRepaintCount 0 `
            -ExpectedHostPatchRevision $hostPatchRevision
    } elseif ($revision2ManifestCompatible) {
        Test-AntiCodexAsarPatches `
            -Path $required.appAsar `
            -PatchProfile $patchProfile `
            -ExpectedConfigWriteBridgeCount 1 `
            -ExpectedPrimaryWindowDeferredRestoreRepaintCount 0 `
            -ExpectedPrimaryWindowFocusRestoreRepaintCount 1 `
            -ExpectedLegacyPrimaryWindowRestoreRepaintCount 0 `
            -ExpectedHostPatchRevision $hostPatchRevision
    } elseif ($previousManifestCompatible) {
        try {
            Test-AntiCodexAsarPatches `
                -Path $required.appAsar `
                -PatchProfile $patchProfile `
                -ExpectedConfigWriteBridgeCount 1 `
                -ExpectedPrimaryWindowDeferredRestoreRepaintCount 0 `
                -ExpectedPrimaryWindowFocusRestoreRepaintCount 1 `
                -ExpectedLegacyPrimaryWindowRestoreRepaintCount 0 `
                -ExpectedHostPatchRevision $hostPatchRevision
        } catch {
            Test-AntiCodexAsarPatches `
                -Path $required.appAsar `
                -PatchProfile $patchProfile `
                -ExpectedConfigWriteBridgeCount 1 `
                -ExpectedPrimaryWindowDeferredRestoreRepaintCount 0 `
                -ExpectedPrimaryWindowFocusRestoreRepaintCount 0 `
                -ExpectedLegacyPrimaryWindowRestoreRepaintCount 1 `
                -ExpectedHostPatchRevision $hostPatchRevision
        }
    } else {
        Test-AntiCodexAsarPatches `
            -Path $required.appAsar `
            -PatchProfile $patchProfile `
            -ExpectedConfigWriteBridgeCount 0 `
            -ExpectedPrimaryWindowDeferredRestoreRepaintCount 0 `
            -ExpectedPrimaryWindowFocusRestoreRepaintCount 1 `
            -ExpectedLegacyPrimaryWindowRestoreRepaintCount 0 `
            -ExpectedHostPatchRevision $hostPatchRevision
    }
    foreach ($name in @("antiCodexExe", "appAsar", "codexCli", "hostIcon", "trayIcon", "appRootIcon")) {
        $actual = Get-AntiCodexSha256 -Path $required[$name]
        if ([string]$manifest.files.$name -ne [string]$actual) { throw "Anti-Codex host marker hash mismatch: $name" }
    }
    if (-not $manifest.source -or -not $manifest.source.codexHost -or -not $manifest.source.codexCli) {
        throw "Anti-Codex host marker is missing source Codex fingerprints."
    }
    if ([string]$manifest.source.codexHost -ne [string](Get-AntiCodexSha256 -Path $required.codexHost)) {
        throw "Anti-Codex host source fingerprint mismatch: codexHost"
    }
    if ([string]$manifest.source.codexCli -ne [string](Get-AntiCodexSha256 -Path $required.codexCli)) {
        throw "Anti-Codex host source fingerprint mismatch: codexCli"
    }
    if ([string](Get-AntiCodexSha256 -Path $required.antiCodexExe) -ne [string](Get-AntiCodexSha256 -Path $required.codexHost)) {
        throw "Anti-Codex host must preserve the copied source Codex host bytes."
    }
    foreach ($iconPath in @($required.hostIcon, $required.trayIcon, $required.appRootIcon)) {
        if ((Test-AntiCodexIconPalette -Path $iconPath) -ne $true) {
            throw "Anti-Codex host icon is not the Anti-Codex tray/icon artwork: $iconPath"
        }
    }
}

function Test-AntiCodexComponent {
    param([Parameter(Mandatory = $true)][string]$ComponentRoot)

    $resolvedRoot = Assert-FixedComponentPath $ComponentRoot
    $manifestPath = Join-Path $resolvedRoot "component-manifest.json"
    $metadataPath = Join-Path $resolvedRoot "upstream.json"
    $binaryPath = Join-Path $resolvedRoot "codex-plus-plus.exe"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $metadataPath -PathType Leaf) -or -not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
        throw "CodexPlusPlus component is incomplete: $resolvedRoot"
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

function Remove-InvalidRollbackSwap {
    foreach ($path in @($swapHost, $swapComponent)) {
        $fullPath = [IO.Path]::GetFullPath($path)
        $allowed = @([IO.Path]::GetFullPath($swapHost), [IO.Path]::GetFullPath($swapComponent))
        if ($fullPath -notin $allowed) { throw "Refusing to remove an unexpected rollback swap path: $fullPath" }
        if ([IO.Directory]::Exists("\\?\$fullPath")) { [IO.Directory]::Delete("\\?\$fullPath", $true) }
    }
    if ([IO.File]::Exists($swapMarker)) { [IO.File]::Delete($swapMarker) }
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
        foreach ($process in $remaining) { Stop-AntiCodexVerifiedProcess -Snapshot $process -AllowedRoot $activeHost | Out-Null }
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
        foreach ($process in $remaining) { Stop-AntiCodexVerifiedProcess -Snapshot $process -AllowedRoot $activeComponent | Out-Null }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return @(Get-AntiCodexComponentProcesses).Count -eq 0
}

function Test-AntiCodexPowerShellFileInvocation {
    param(
        [Parameter(Mandatory = $true)][string]$CommandLine,
        [Parameter(Mandatory = $true)][string]$LiveExecutablePath,
        [Parameter(Mandatory = $true)][string]$ExpectedScriptPath
    )
    try {
        $arguments = @([AntiCodex.Native.WindowsCommandLine]::Parse($CommandLine))
        if ($arguments.Count -lt 3) { return $false }
        $liveExecutable = [IO.Path]::GetFullPath($LiveExecutablePath)
        $commandExecutable = [IO.Path]::GetFullPath([string]$arguments[0])
        $hostName = [IO.Path]::GetFileName($liveExecutable).ToLowerInvariant()
        if ($hostName -notin @("powershell.exe", "pwsh.exe") -or
            (Test-AntiCodexNativeCodexPath -Path $liveExecutable) -or
            -not $commandExecutable.Equals($liveExecutable, [StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
        $optionsWithValue = @(
            "-executionpolicy",
            "-windowstyle",
            "-inputformat",
            "-outputformat",
            "-workingdirectory",
            "-version",
            "-configurationname",
            "-settingsfile",
            "-custompipename"
        )
        $optionsWithoutValue = @("-noprofile", "-nologo", "-noninteractive", "-mta", "-sta", "-noexit")
        for ($index = 1; $index -lt $arguments.Count;) {
            $token = ([string]$arguments[$index]).ToLowerInvariant()
            if ($token -in @("-file", "-f")) {
                if (($index + 1) -ge $arguments.Count) { return $false }
                $actualScript = [IO.Path]::GetFullPath([string]$arguments[$index + 1])
                $expectedScript = [IO.Path]::GetFullPath($ExpectedScriptPath)
                return $actualScript.Equals($expectedScript, [StringComparison]::OrdinalIgnoreCase)
            }
            if ($token -in @("-command", "-c", "-encodedcommand", "-e", "-ec") -or $token -eq "--%") {
                return $false
            }
            if ($optionsWithoutValue -contains $token) {
                $index += 1
                continue
            }
            if ($optionsWithValue -contains $token) {
                if (($index + 1) -ge $arguments.Count) { return $false }
                $index += 2
                continue
            }
            return $false
        }
    } catch {
        return $false
    }
    return $false
}

function Get-AntiCodexLaunchers {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and
        $_.ExecutablePath -and
        (Test-AntiCodexPowerShellFileInvocation `
            -CommandLine ([string]$_.CommandLine) `
            -LiveExecutablePath ([string]$_.ExecutablePath) `
            -ExpectedScriptPath $startAntiCodex)
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
        try { return [int]$response.StatusCode -eq 202 } finally { $response.Dispose() }
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

function Get-AntiCodexLaunchTaskEvidence {
    $task = Get-AntiCodexRegisteredTask -TaskName $launchTaskName
    $definition = $task.Definition
    $actionCount = [int]$definition.Actions.Count
    $action = if ($actionCount -eq 1) { $definition.Actions.Item(1) } else { $null }
    $expectedArguments = "--headless `"$node`" `"$launchTaskScript`" --hide-console"
    $currentUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $currentShortUserName = ($currentUserName -split "\\")[-1]
    $taskUserName = [string]$definition.Principal.UserId
    $ok = (
        $actionCount -eq 1 -and
        $task.Enabled -and
        $action -and
        [string]$action.Path -ieq $conhost -and
        [string]$action.Arguments -ceq $expectedArguments -and
        [string]$action.WorkingDirectory -ieq $installRoot -and
        ($taskUserName -ieq $currentUserName -or $taskUserName -ieq $currentShortUserName) -and
        [int]$definition.Principal.LogonType -eq 3 -and
        [int]$definition.Principal.RunLevel -eq 0 -and
        [int]$definition.Triggers.Count -eq 0 -and
        [int]$definition.Settings.MultipleInstances -eq 2 -and
        [bool]$definition.Settings.AllowDemandStart -and
        [bool]$definition.Settings.AllowHardTerminate -and
        -not [bool]$definition.Settings.RunOnlyIfIdle -and
        -not [bool]$definition.Settings.RunOnlyIfNetworkAvailable -and
        -not [bool]$definition.Settings.DisallowStartIfOnBatteries -and
        -not [bool]$definition.Settings.StopIfGoingOnBatteries -and
        [int]$definition.Settings.RestartCount -eq 0 -and
        [string]$definition.Settings.ExecutionTimeLimit -eq "PT0S"
    )
    return [pscustomobject]@{ ok = $ok; state = [int]$task.State; task = $task }
}

function Stop-AntiCodexLaunchTaskForMaintenance {
    $evidence = Get-AntiCodexLaunchTaskEvidence
    if (-not $evidence.ok) { throw "The isolated Anti-Codex launch task is missing or stale." }

    $null = Invoke-AntiCodexFixedRouteShutdown
    if (Wait-AntiCodexLaunchTaskStopped -TimeoutSeconds 20) { return }
    $evidence = Get-AntiCodexLaunchTaskEvidence
    if (-not $evidence.ok) { throw "The isolated Anti-Codex launch task is missing or stale." }
    $evidence.task.Stop(0)
    if (-not (Wait-AntiCodexLaunchTaskStopped -TimeoutSeconds 10)) {
        throw "The isolated Anti-Codex launch task did not stop before rollback."
    }
}

function Start-AntiCodexThroughTask {
    $evidence = Get-AntiCodexLaunchTaskEvidence
    if (-not $evidence.ok) { throw "The isolated Anti-Codex launch task is missing or stale." }
    if (-not (Wait-AntiCodexLaunchTaskStopped -TimeoutSeconds 30)) {
        throw "The isolated Anti-Codex launch task did not stop before rollback restart."
    }
    $evidence = Get-AntiCodexLaunchTaskEvidence
    if (-not $evidence.ok) { throw "The isolated Anti-Codex launch task is missing or stale." }
    Start-ScheduledTask -TaskName $launchTaskName
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

function Repair-LegacyRollbackHostBinaryManifest {
    if (-not [IO.Directory]::Exists("\\?\$rollbackHost") -or -not [IO.File]::Exists($rollbackMarker)) {
        return
    }

    $manifest = Get-Content -LiteralPath $rollbackMarker -Raw | ConvertFrom-Json
    if ([string]$manifest.schema -ne "anticodex-host-manifest-v2") {
        return
    }
    if (-not $manifest.files -or -not $manifest.source -or -not $manifest.source.codexHost) {
        throw "Anti-Codex rollback host marker cannot preserve the source host bytes."
    }

    $desktopHostName = [string]$manifest.source.desktopHostName
    if ($desktopHostName -notin @("ChatGPT.exe", "Codex.exe") -or
        -not (Test-Path -LiteralPath (Join-Path $rollbackHost $desktopHostName) -PathType Leaf)) {
        $desktopHostName = @("ChatGPT.exe", "Codex.exe") | Where-Object {
            Test-Path -LiteralPath (Join-Path $rollbackHost $_) -PathType Leaf
        } | Select-Object -First 1
    }
    if (-not $desktopHostName) {
        throw "Anti-Codex rollback source desktop host is missing."
    }

    $sourceHost = Join-Path $rollbackHost $desktopHostName
    $antiCodexHost = Join-Path $rollbackHost "Anti-Codex.exe"
    if (-not (Test-Path -LiteralPath $antiCodexHost -PathType Leaf)) {
        throw "Anti-Codex rollback host executable is missing."
    }
    $sourceHash = Get-AntiCodexSha256 -Path $sourceHost
    $originalBinaryHash = Get-AntiCodexSha256 -Path $antiCodexHost
    $recordedBinaryHash = [string]$manifest.files.antiCodexExe
    if ([string]$sourceHash -ne [string]$manifest.source.codexHost) {
        throw "Anti-Codex rollback source desktop host differs from its marker."
    }
    if (-not $recordedBinaryHash -or [string]$originalBinaryHash -ne $recordedBinaryHash) {
        throw "Anti-Codex rollback host executable differs from its marker."
    }
    if ([string]$originalBinaryHash -eq [string]$sourceHash) {
        return
    }

    $manifest.files | Add-Member -NotePropertyName antiCodexExe -NotePropertyValue $sourceHash -Force
    $originalMarkerHash = Get-AntiCodexSha256 -Path $rollbackMarker
    $binaryTemporary = "$antiCodexHost.rollback-migration.tmp"
    $binaryBackup = "$antiCodexHost.rollback-migration.bak"
    $binaryDiscard = "$antiCodexHost.rollback-migration.discard"
    $markerTemporary = "$rollbackMarker.rollback-migration.tmp"
    $markerBackup = "$rollbackMarker.rollback-migration.bak"
    $markerDiscard = "$rollbackMarker.rollback-migration.discard"
    $migrationPaths = @($binaryTemporary, $binaryBackup, $binaryDiscard, $markerTemporary, $markerBackup, $markerDiscard)
    foreach ($path in $migrationPaths) {
        if ([IO.Directory]::Exists($path)) {
            throw "Anti-Codex rollback host migration path is unexpectedly a directory: $path"
        }
        if ([IO.File]::Exists($path)) {
            [IO.File]::Delete($path)
        }
    }

    $preserveRecoveryBackups = $false
    try {
        Copy-Item -LiteralPath $sourceHost -Destination $binaryTemporary
        if ([string](Get-AntiCodexSha256 -Path $binaryTemporary) -ne [string]$sourceHash) {
            throw "Anti-Codex rollback host migration staging failed."
        }
        $json = $manifest | ConvertTo-Json -Depth 8
        [IO.File]::WriteAllText($markerTemporary, $json, [Text.UTF8Encoding]::new($false))

        [IO.File]::Replace($binaryTemporary, $antiCodexHost, $binaryBackup, $true)
        [IO.File]::Replace($markerTemporary, $rollbackMarker, $markerBackup, $true)

        $migratedManifest = Get-Content -LiteralPath $rollbackMarker -Raw | ConvertFrom-Json
        if ([string](Get-AntiCodexSha256 -Path $antiCodexHost) -ne [string]$sourceHash -or
            [string]$migratedManifest.files.antiCodexExe -ne [string]$sourceHash) {
            throw "Anti-Codex rollback host migration verification failed."
        }
    } catch {
        $migrationError = $_.Exception.Message
        $recoveryErrors = New-Object System.Collections.Generic.List[string]
        if ([IO.File]::Exists($markerBackup)) {
            try {
                [IO.File]::Replace($markerBackup, $rollbackMarker, $markerDiscard, $true)
            } catch {
                $recoveryErrors.Add("marker: $($_.Exception.Message)") | Out-Null
            }
        }
        if ([IO.File]::Exists($binaryBackup)) {
            try {
                [IO.File]::Replace($binaryBackup, $antiCodexHost, $binaryDiscard, $true)
            } catch {
                $recoveryErrors.Add("binary: $($_.Exception.Message)") | Out-Null
            }
        }
        try {
            if ([string](Get-AntiCodexSha256 -Path $antiCodexHost) -ne [string]$originalBinaryHash) {
                $recoveryErrors.Add("binary hash did not return to its original value") | Out-Null
            }
            if ([string](Get-AntiCodexSha256 -Path $rollbackMarker) -ne [string]$originalMarkerHash) {
                $recoveryErrors.Add("marker hash did not return to its original value") | Out-Null
            }
        } catch {
            $recoveryErrors.Add("verification: $($_.Exception.Message)") | Out-Null
        }
        if ($recoveryErrors.Count -gt 0) {
            $preserveRecoveryBackups = $true
            throw "Anti-Codex rollback host migration failed and recovery failed: $migrationError; $($recoveryErrors -join '; ')"
        }
        throw "Anti-Codex rollback host migration failed; original binary and marker were restored: $migrationError"
    } finally {
        $cleanupPaths = if ($preserveRecoveryBackups) {
            @($binaryTemporary, $binaryDiscard, $markerTemporary, $markerDiscard)
        } else {
            $migrationPaths
        }
        foreach ($path in $cleanupPaths) {
            if ([IO.File]::Exists($path)) {
                [IO.File]::Delete($path)
            }
        }
    }
}

function Commit-AntiCodexRollbackCheckpoint {
    $rollbackHostCommitted = $false
    $rollbackMarkerCommitted = $false
    $rollbackComponentCommitted = $false
    try {
        Move-FixedHostDirectory -Source $swapHost -Destination $rollbackHost
        $rollbackHostCommitted = $true
        Move-FixedMarker -Source $swapMarker -Destination $rollbackMarker
        $rollbackMarkerCommitted = $true
        Move-FixedComponentDirectory -Source $swapComponent -Destination $rollbackComponent
        $rollbackComponentCommitted = $true
        Test-AntiCodexHost -HostRoot $rollbackHost -MarkerPath $rollbackMarker
        Test-AntiCodexComponent -ComponentRoot $rollbackComponent
    } catch {
        $commitError = $_.Exception.Message
        try {
            if ($rollbackComponentCommitted) {
                Move-FixedComponentDirectory -Source $rollbackComponent -Destination $swapComponent
                $rollbackComponentCommitted = $false
            }
            if ($rollbackMarkerCommitted) {
                Move-FixedMarker -Source $rollbackMarker -Destination $swapMarker
                $rollbackMarkerCommitted = $false
            }
            if ($rollbackHostCommitted) {
                Move-FixedHostDirectory -Source $rollbackHost -Destination $swapHost
                $rollbackHostCommitted = $false
            }
        } catch {
            throw "Rollback checkpoint commit failed. Reverse recovery also failed: $commitError; recovery error: $($_.Exception.Message)"
        }
        throw "Rollback checkpoint commit failed; reverse recovery restored the pre-commit swap state: $commitError"
    }
}

function Restore-OriginalActiveRelease {
    if ([IO.Directory]::Exists("\\?\$activeHost") -and -not [IO.Directory]::Exists("\\?\$rollbackHost")) { Move-FixedHostDirectory -Source $activeHost -Destination $rollbackHost }
    if ([IO.File]::Exists($activeMarker) -and -not [IO.File]::Exists($rollbackMarker)) { Move-FixedMarker -Source $activeMarker -Destination $rollbackMarker }
    if ([IO.Directory]::Exists("\\?\$swapHost") -and -not [IO.Directory]::Exists("\\?\$activeHost")) { Move-FixedHostDirectory -Source $swapHost -Destination $activeHost }
    if ([IO.File]::Exists($swapMarker) -and -not [IO.File]::Exists($activeMarker)) { Move-FixedMarker -Source $swapMarker -Destination $activeMarker }
    if ([IO.Directory]::Exists("\\?\$activeComponent") -and -not [IO.Directory]::Exists("\\?\$rollbackComponent")) { Move-FixedComponentDirectory -Source $activeComponent -Destination $rollbackComponent }
    if ([IO.Directory]::Exists("\\?\$swapComponent") -and -not [IO.Directory]::Exists("\\?\$activeComponent")) { Move-FixedComponentDirectory -Source $swapComponent -Destination $activeComponent }
}

if ($ValidateOnly) {
    if ($RecoveryAttempt) {
        throw "ValidateOnly and RecoveryAttempt cannot be combined."
    }
}

$syncMutex = New-Object Threading.Mutex($false, "Local\AntiCodexHostSync")
if (-not $syncMutex.WaitOne(0)) { $syncMutex.Dispose(); throw "Another Anti-Codex sync or rollback is already running." }
$syncMutexAcquired = $true

if ($ValidateOnly) {
    try {
        Repair-LegacyRollbackHostBinaryManifest
        Test-AntiCodexHost -HostRoot $rollbackHost -MarkerPath $rollbackMarker
        Test-AntiCodexComponent -ComponentRoot $rollbackComponent
    } finally {
        $syncMutex.ReleaseMutex()
        $syncMutex.Dispose()
    }
    return
}

$rollbackError = $null
$restartAfterRollback = $false
$activatedMarkerSha256 = ""
$supersededByAnotherSync = $false
$activeComponentValid = $true
$rollbackStage = "rollback_validation"
try {
    try {
        if ($ExpectedActiveMarkerSha256) {
            if ($ExpectedActiveMarkerSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
                throw "Expected active marker SHA-256 is invalid."
            }
            $currentActiveMarkerSha256 = if ([IO.File]::Exists($activeMarker)) {
                Get-AntiCodexSha256 -Path $activeMarker
            } else {
                ""
            }
            if ($currentActiveMarkerSha256 -ine $ExpectedActiveMarkerSha256) {
                $supersededByAnotherSync = $true
                throw "The active Anti-Codex release changed after rollback was requested. Rollback was refused."
            }
        }
        Set-AntiCodexUpdateOperation -State "running" -Stage "rollback_validation" -Message "Validating both active and rollback releases." -RollbackAvailable $true -StateRoot $stateRoot
        if ([IO.Directory]::Exists("\\?\$swapHost") -or [IO.File]::Exists($swapMarker) -or [IO.Directory]::Exists("\\?\$swapComponent")) { throw "A stale rollback swap is present. Anti-Codex was not changed." }
        Repair-LegacyRollbackHostBinaryManifest
        Test-AntiCodexHost -HostRoot $activeHost -MarkerPath $activeMarker
        Test-AntiCodexHost -HostRoot $rollbackHost -MarkerPath $rollbackMarker
        Test-AntiCodexComponent -ComponentRoot $rollbackComponent
        try {
            Test-AntiCodexComponent -ComponentRoot $activeComponent
        } catch {
            if (-not [IO.Directory]::Exists("\\?\$activeComponent")) { throw }
            $activeComponentValid = $false
        }

        $rollbackStage = "rollback_stopping_host"
        Set-AntiCodexUpdateOperation -State "running" -Stage "rollback_stopping_host" -Message "Stopping Anti-Codex before rollback." -RollbackAvailable $true -StateRoot $stateRoot
        New-Item -ItemType Directory -Path (Split-Path -Parent $hostSyncMarker) -Force | Out-Null
        "Host rollback marker $(Get-Date -Format o)" | Set-Content -LiteralPath $hostSyncMarker -Encoding ASCII
        $restartAfterRollback = $true
        Stop-AntiCodexLaunchTaskForMaintenance
        if (-not (Wait-AntiCodexLaunchersStopped -TimeoutSeconds 10)) {
            throw "Anti-Codex launcher remained active after its verified task stopped. No process was force-terminated."
        }
        if (-not (Wait-AntiCodexHostRelease -TimeoutSeconds 20)) { throw "Anti-Codex host processes did not exit before the rollback timeout. Anti-Codex was not changed." }
        if (-not (Wait-AntiCodexComponentRelease -TimeoutSeconds 20)) { throw "CodexPlusPlus processes did not exit before the rollback timeout. Anti-Codex was not changed." }

        $rollbackStage = "rollback_activation"
        Set-AntiCodexUpdateOperation -State "running" -Stage "rollback_activation" -Message "Activating the previous Anti-Codex host." -RollbackAvailable $true -StateRoot $stateRoot
        try {
            Move-FixedHostDirectory -Source $activeHost -Destination $swapHost
            Move-FixedMarker -Source $activeMarker -Destination $swapMarker
            Move-FixedComponentDirectory -Source $activeComponent -Destination $swapComponent
            Move-FixedHostDirectory -Source $rollbackHost -Destination $activeHost
            Move-FixedMarker -Source $rollbackMarker -Destination $activeMarker
            Move-FixedComponentDirectory -Source $rollbackComponent -Destination $activeComponent
            Test-AntiCodexHost -HostRoot $activeHost -MarkerPath $activeMarker
            Test-AntiCodexComponent -ComponentRoot $activeComponent
            if ($activeComponentValid) {
                Commit-AntiCodexRollbackCheckpoint
            } else {
                Remove-InvalidRollbackSwap
            }
            $activatedMarkerSha256 = Get-AntiCodexSha256 -Path $activeMarker
            $rollbackStage = "rollback_restart"
            Set-AntiCodexUpdateOperation -State "running" -Stage "rollback_restart" -Message "Restarting Anti-Codex after rollback." -RollbackAvailable $true -StateRoot $stateRoot
        } catch {
            $swapError = $_.Exception.Message
            try {
                Restore-OriginalActiveRelease
                Test-AntiCodexHost -HostRoot $activeHost -MarkerPath $activeMarker
                Test-AntiCodexComponent -ComponentRoot $activeComponent
            } catch {
                throw "Rollback failed. Automatic recovery also failed: $swapError; recovery error: $($_.Exception.Message)"
            }
            throw "Rollback failed. Automatic recovery restored the original active version: $swapError"
        }
    } catch { $rollbackError = $_ }
} finally {
    Remove-Item -LiteralPath $hostSyncMarker -Force -ErrorAction SilentlyContinue
    $syncMutex.ReleaseMutex()
    $syncMutexAcquired = $false
}

if ($rollbackError) {
    if (-not $supersededByAnotherSync) {
        Set-AntiCodexUpdateOperation -State "failed" -Stage $rollbackStage -Message $rollbackError.Exception.Message -FailureCode "rollback_failed" -RollbackAvailable $true -StateRoot $stateRoot
    }
    $syncMutex.Dispose()
    throw $rollbackError
}

try {
    if ($restartAfterRollback -and (Test-Path -LiteralPath $startAntiCodex)) {
        Start-AntiCodexThroughTask
    }
    $postRollbackReady = -not $restartAfterRollback -or (Wait-AntiCodexPostRollbackReady -TimeoutSeconds 90)

    try {
        $syncMutexAcquired = $syncMutex.WaitOne(300000)
    } catch [Threading.AbandonedMutexException] {
        $syncMutexAcquired = $true
    }
    if (-not $syncMutexAcquired) {
        $supersededByAnotherSync = $true
        throw "Another Anti-Codex sync remained active after rollback readiness."
    }
    $currentActiveMarkerSha256 = if ([IO.File]::Exists($activeMarker)) {
        Get-AntiCodexSha256 -Path $activeMarker
    } else {
        ""
    }
    if (-not $activatedMarkerSha256 -or $currentActiveMarkerSha256 -ine $activatedMarkerSha256) {
        $supersededByAnotherSync = $true
        throw "The active release changed after rollback activation. This rollback will not accept or recover another generation."
    }

    $rollbackStage = "rollback_acceptance"
    Set-AntiCodexUpdateOperation -State "running" -Stage "rollback_acceptance" -Message "Checking Anti-Codex after rollback." -RollbackAvailable $activeComponentValid -StateRoot $stateRoot
    if (-not $postRollbackReady) {
        if (-not $activeComponentValid) {
            Set-AntiCodexUpdateOperation -State "failed" -Stage "rollback_acceptance" -Message "The recovered Anti-Codex release did not become ready; the invalid newer release was discarded." -FailureCode "rollback_recovery_not_ready" -RollbackAvailable $false -StateRoot $stateRoot
            throw "The recovered Anti-Codex release did not become ready; the invalid newer release was discarded."
        }
        if ($RecoveryAttempt) {
            Set-AntiCodexUpdateOperation -State "failed" -Stage "rollback_acceptance" -Message "Anti-Codex did not become ready after rollback recovery." -FailureCode "rollback_recovery_not_ready" -RollbackAvailable $true -StateRoot $stateRoot
            throw "Anti-Codex did not become ready after rollback recovery."
        }
        $syncMutex.ReleaseMutex()
        $syncMutexAcquired = $false
        try {
            & $PSCommandPath -RecoveryAttempt -ExpectedActiveMarkerSha256 $activatedMarkerSha256
        } catch {
            throw "The rolled-back Anti-Codex host did not become ready, and automatic recovery failed: $($_.Exception.Message)"
        }
        throw "The rolled-back Anti-Codex host did not become ready. Automatic recovery restored the original active version."
    }

    if ($RecoveryAttempt) {
        Set-AntiCodexUpdateOperation -State "failed" -Stage "rollback_acceptance" -Message "The requested rollback was not ready; automatic recovery restored the original active version." -FailureCode "rollback_not_ready" -RollbackAvailable $true -StateRoot $stateRoot
    } else {
        Set-AntiCodexUpdateOperation -State "rolled_back" -Stage "complete" -Message "Anti-Codex restored the previous host and CodexPlusPlus component successfully." -RollbackAvailable $activeComponentValid -StateRoot $stateRoot
    }
} finally {
    if ($syncMutexAcquired) {
        $syncMutex.ReleaseMutex()
    }
    $syncMutex.Dispose()
}
