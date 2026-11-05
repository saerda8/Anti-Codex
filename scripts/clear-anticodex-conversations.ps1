[CmdletBinding()]
param(
    [string]$StateRoot = $(Join-Path $env:APPDATA "anticodex"),
    [string]$RuntimeRoot = $(Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime"),
    [string]$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$BackupRoot = "",
    [int]$StopTimeoutSec = 8,
    [int]$RestartTimeoutSec = 120,
    [switch]$SkipProcessStop,
    [switch]$SkipRestart,
    [switch]$IncludeLogs,
    [switch]$AllowNonDefaultStateRoot,
    [switch]$WhatIfOnly
)

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

function Normalize-Path {
    param([string]$Path)
    if (-not $Path) { return "" }
    return [IO.Path]::GetFullPath($Path)
}

function Test-IsUnderPath {
    param([string]$Path, [string]$Parent)
    $fullPath = Normalize-Path $Path
    $fullParent = (Normalize-Path $Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    return $fullPath.Equals($fullParent, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Test-AntiCodexNativeCodexPath {
    param([string]$Path)
    try {
        $fullPath = Normalize-Path $Path
        return $fullPath.IndexOf("\WindowsApps\", [StringComparison]::OrdinalIgnoreCase) -ge 0
    } catch {
        return $true
    }
}

function Test-AntiCodexCommandLineHasExactPath {
    param([string]$CommandLine, [string]$Path)
    if (-not $CommandLine -or -not $Path) { return $false }
    try {
        $fullPath = Normalize-Path $Path
        $pattern = '(^|[\s"])' + [regex]::Escape($fullPath) + '($|[\s"])'
        return [regex]::IsMatch(
            $CommandLine,
            $pattern,
            [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    } catch {
        return $false
    }
}

function Get-AntiCodexHostedScriptPath {
    param([string]$ExecutablePath, [string]$CommandLine)
    if (-not $ExecutablePath -or -not $CommandLine) { return "" }
    try {
        $arguments = @([AntiCodex.Native.WindowsCommandLine]::Parse($CommandLine))
        if ($arguments.Count -lt 2) { return "" }
        $hostName = [IO.Path]::GetFileName((Normalize-Path $ExecutablePath)).ToLowerInvariant()

        if ($hostName -eq "node.exe") {
            $optionsWithValue = @(
                "-r",
                "--require",
                "--import",
                "--loader",
                "--experimental-loader",
                "--conditions",
                "--inspect-port",
                "--debug-port",
                "--title",
                "--icu-data-dir",
                "--openssl-config",
                "--snapshot-blob",
                "--build-snapshot-config",
                "--experimental-sea-config",
                "--diagnostic-dir",
                "--redirect-warnings",
                "--heapsnapshot-near-heap-limit",
                "--stack-trace-limit",
                "--max-http-header-size",
                "--watch-path",
                "--env-file",
                "--env-file-if-exists"
            )
            $optionsWithoutValue = @(
                "--no-warnings",
                "--trace-warnings",
                "--trace-deprecation",
                "--enable-source-maps",
                "--preserve-symlinks",
                "--preserve-symlinks-main",
                "--experimental-modules",
                "--experimental-vm-modules",
                "--use-bundled-ca",
                "--use-openssl-ca",
                "--zero-fill-buffers"
            )
            for ($index = 1; $index -lt $arguments.Count;) {
                $argument = [string]$arguments[$index]
                $lower = $argument.ToLowerInvariant()
                if ($lower -eq "--") {
                    $index++
                    if ($index -ge $arguments.Count) { return "" }
                    return Normalize-Path ([string]$arguments[$index])
                }
                if ($lower -in @("-e", "--eval", "-p", "--print", "-c", "--check", "-i", "--interactive", "--test") -or
                    $lower.StartsWith("--eval=", [StringComparison]::Ordinal) -or
                    $lower.StartsWith("--print=", [StringComparison]::Ordinal) -or
                    $lower.StartsWith("--check=", [StringComparison]::Ordinal) -or
                    $lower.StartsWith("--test=", [StringComparison]::Ordinal)) {
                    return ""
                }
                if ($optionsWithValue -contains $lower) {
                    if (($index + 1) -ge $arguments.Count) { return "" }
                    $index += 2
                    continue
                }
                $inlineValueOption = $false
                foreach ($option in $optionsWithValue) {
                    if ($lower.StartsWith($option + "=", [StringComparison]::Ordinal)) {
                        $inlineValueOption = $true
                        break
                    }
                }
                if ($inlineValueOption -or
                    $optionsWithoutValue -contains $lower -or
                    $lower -match '^--inspect(?:-brk|-wait)?(?:=.*)?$') {
                    $index++
                    continue
                }
                if ($lower.StartsWith("-", [StringComparison]::Ordinal)) {
                    return ""
                }
                return Normalize-Path $argument
            }
            return ""
        }

        if ($hostName -in @("powershell.exe", "pwsh.exe")) {
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
            $optionsWithoutValue = @(
                "-noprofile",
                "-nologo",
                "-noninteractive",
                "-mta",
                "-sta",
                "-noexit"
            )
            for ($index = 1; $index -lt $arguments.Count;) {
                $argument = [string]$arguments[$index]
                $lower = $argument.ToLowerInvariant()
                if ($lower -in @("-file", "-f")) {
                    if (($index + 1) -ge $arguments.Count) { return "" }
                    return Normalize-Path ([string]$arguments[$index + 1])
                }
                if ($lower -in @("-command", "-c", "-encodedcommand", "-e", "-ec") -or $lower -eq "--%") {
                    return ""
                }
                if ($optionsWithoutValue -contains $lower) {
                    $index++
                    continue
                }
                if ($optionsWithValue -contains $lower) {
                    if (($index + 1) -ge $arguments.Count) { return "" }
                    $index += 2
                    continue
                }
                return ""
            }
        }
    } catch {
        return ""
    }
    return ""
}

function Get-AntiCodexProcessOwnership {
    param(
        [string]$ExecutablePath,
        [string]$CommandLine,
        [string[]]$AllowedExecutableRoots,
        [string[]]$AllowedScriptPaths
    )
    if (-not $ExecutablePath) { return $null }
    try {
        $executable = Normalize-Path $ExecutablePath
    } catch {
        return $null
    }
    if (Test-AntiCodexNativeCodexPath -Path $executable) { return $null }
    $scriptHostNames = @(
        "node.exe",
        "powershell.exe",
        "pwsh.exe",
        "cmd.exe",
        "wscript.exe",
        "cscript.exe",
        "python.exe",
        "pythonw.exe",
        "bash.exe",
        "sh.exe",
        "deno.exe",
        "bun.exe"
    )
    $hostName = [IO.Path]::GetFileName($executable).ToLowerInvariant()
    if ($scriptHostNames -contains $hostName) {
        $hostedScriptPath = Get-AntiCodexHostedScriptPath `
            -ExecutablePath $executable `
            -CommandLine $CommandLine
        if (-not $hostedScriptPath) { return $null }
        foreach ($script in @($AllowedScriptPaths)) {
            if (-not $script) { continue }
            $scriptPath = Normalize-Path $script
            if ($hostedScriptPath.Equals($scriptPath, [StringComparison]::OrdinalIgnoreCase)) {
                return [pscustomobject]@{
                    Kind = "script"
                    ExpectedScriptPath = $scriptPath
                }
            }
        }
        return $null
    }
    foreach ($root in @($AllowedExecutableRoots)) {
        if ($root -and (Test-IsUnderPath -Path $executable -Parent $root)) {
            return [pscustomobject]@{
                Kind = "executable"
                ExpectedScriptPath = ""
            }
        }
    }
    return $null
}

function Assert-UnderPath {
    param([string]$Path, [string]$Parent, [string]$Label)
    if (-not (Test-IsUnderPath -Path $Path -Parent $Parent)) {
        throw "refusing to touch $Label outside ${Parent}: $Path"
    }
}

function Read-JsonObject {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if (-not $text.Trim()) { return $null }
    return $text | ConvertFrom-Json -ErrorAction Stop
}

function Add-JsonProperty {
    param($Object, [string]$Name, $Value)
    if ($Object.PSObject.Properties.Name -contains $Name) {
        $Object.$Name = $Value
    } else {
        Add-Member -InputObject $Object -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Remove-JsonProperty {
    param($Object, [string]$Name)
    if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name) {
        $Object.PSObject.Properties.Remove($Name)
    }
}

function Get-JsonValue {
    param($Object, [string]$Name, $Fallback)
    if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name -and $null -ne $Object.$Name) {
        return $Object.$Name
    }
    return $Fallback
}

function ConvertTo-Array {
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Array]) { return @($Value) }
    return @($Value)
}

function Write-JsonFile {
    param($Object, [string]$Path)
    $json = $Object | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Move-IfExists {
    param([string]$Path, [string]$DestinationRoot, [string]$StateRootFull, [System.Collections.Generic.List[object]]$Moved)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $full = Normalize-Path $Path
    Assert-UnderPath -Path $full -Parent $StateRootFull -Label "conversation state"
    $name = Split-Path -Leaf $full
    if (-not $name) { $name = "root" }
    $destination = Join-Path $DestinationRoot $name
    $index = 1
    while (Test-Path -LiteralPath $destination) {
        $destination = Join-Path $DestinationRoot ("{0}.{1}" -f $name, $index)
        $index++
    }
    if (-not $WhatIfOnly) {
        Write-Verbose "moving $full -> $destination"
        if ((Get-Item -LiteralPath $full -Force).PSIsContainer) {
            [System.IO.Directory]::Move($full, $destination)
        } else {
            [System.IO.File]::Move($full, $destination)
        }
        Write-Verbose "moved $full"
    }
    $Moved.Add([pscustomobject]@{ from = $full; to = $destination }) | Out-Null
}

function Wait-Until {
    param([scriptblock]$Predicate, [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSeconds))
    do {
        if (& $Predicate) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Get-AntiCodexProcessSnapshot {
    param(
        [int]$ProcessId,
        [string[]]$AllowedExecutableRoots,
        [string[]]$AllowedScriptPaths
    )
    if ($ProcessId -le 0 -or $ProcessId -eq $PID) { return $null }
    $processHandle = $null
    try {
        $processHandle = [AntiCodex.Native.VerifiedProcessHandle]::Open($ProcessId)
        if ($processHandle.HasExited) { return $null }
        $row = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $row -or -not $row.ExecutablePath) { return $null }
        $executablePath = Normalize-Path ([string]$processHandle.ExecutablePath)
        $rowExecutablePath = Normalize-Path ([string]$row.ExecutablePath)
        if (-not $rowExecutablePath.Equals($executablePath, [StringComparison]::OrdinalIgnoreCase)) {
            return $null
        }
        $ownership = Get-AntiCodexProcessOwnership `
            -ExecutablePath $executablePath `
            -CommandLine ([string]$row.CommandLine) `
            -AllowedExecutableRoots $AllowedExecutableRoots `
            -AllowedScriptPaths $AllowedScriptPaths
        if (-not $ownership) { return $null }
        return [pscustomobject]@{
            ProcessId = [int]$processHandle.ProcessId
            CreationFileTimeUtcTicks = [long]$processHandle.CreationFileTimeUtcTicks
            Name = [string]$row.Name
            ExecutablePath = $executablePath
            CommandLine = [string]$row.CommandLine
            OwnershipKind = [string]$ownership.Kind
            ExpectedScriptPath = [string]$ownership.ExpectedScriptPath
        }
    } catch [ComponentModel.Win32Exception] {
        if ($_.Exception.NativeErrorCode -in @(87, 1168)) { return $null }
        throw "Could not bind strict Anti-Codex candidate PID $ProcessId to one verifiable native handle. $($_.Exception.Message)"
    } finally {
        if ($processHandle) { $processHandle.Dispose() }
    }
}

function Get-AntiCodexProcesses {
    param([string]$RuntimeRootFull, [string]$StateRootFull)
    $installRootFull = Normalize-Path (Join-Path $env:LOCALAPPDATA "Anti-Codex")
    $expectedRuntimeRoot = Normalize-Path (Join-Path $installRootFull "runtime")
    $runtime = Normalize-Path $RuntimeRootFull
    $state = Normalize-Path $StateRootFull
    if (-not $runtime.Equals($expectedRuntimeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing to inspect an Anti-Codex runtime outside the exact installed runtime root: $runtime"
    }
    if (-not $state -or -not [IO.Path]::IsPathRooted($state)) {
        throw "refusing to inspect processes for a non-absolute Anti-Codex state root: $state"
    }
    $allowedExecutableRoots = @(
        (Normalize-Path (Join-Path $installRootFull "codex-patched-app")),
        (Normalize-Path (Join-Path $installRootFull "components")),
        $runtime
    )
    $allowedScriptPaths = @(
        (Normalize-Path (Join-Path $runtime "scripts\start-anticodex.ps1")),
        (Normalize-Path (Join-Path $runtime "scripts\start-anticodex-fixed-route.mjs")),
        (Normalize-Path (Join-Path $runtime "scripts\deepcodex-cdp-inject.mjs")),
        (Normalize-Path (Join-Path $runtime "scripts\anticodex-manager-bridge.mjs"))
    )
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
        $processId = [int]$_.ProcessId
        if ($processId -le 0 -or $processId -eq $PID) { return }
        $preliminaryOwnership = Get-AntiCodexProcessOwnership `
            -ExecutablePath ([string]$_.ExecutablePath) `
            -CommandLine ([string]$_.CommandLine) `
            -AllowedExecutableRoots $allowedExecutableRoots `
            -AllowedScriptPaths $allowedScriptPaths
        if (-not $preliminaryOwnership) { return }
        $snapshot = Get-AntiCodexProcessSnapshot `
            -ProcessId $processId `
            -AllowedExecutableRoots $allowedExecutableRoots `
            -AllowedScriptPaths $allowedScriptPaths
        if ($snapshot) { $snapshot }
    })
}

function Stop-AntiCodexVerifiedProcess {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string[]]$AllowedExecutableRoots,
        [Parameter(Mandatory = $true)][string[]]$AllowedScriptPaths,
        [int]$TimeoutMilliseconds = 3000
    )
    $processId = [int]$Snapshot.ProcessId
    $expectedCreationFileTimeUtcTicks = [long]$Snapshot.CreationFileTimeUtcTicks
    $expectedExecutablePath = Normalize-Path ([string]$Snapshot.ExecutablePath)
    $ownershipKind = [string]$Snapshot.OwnershipKind
    $expectedScriptPath = [string]$Snapshot.ExpectedScriptPath
    if ($processId -le 0 -or $processId -eq $PID -or
        $expectedCreationFileTimeUtcTicks -le 0 -or
        -not $expectedExecutablePath -or
        (Test-AntiCodexNativeCodexPath -Path $expectedExecutablePath) -or
        $ownershipKind -notin @("executable", "script")) {
        throw "Refusing to stop an unverified Anti-Codex process PID $processId."
    }
    if ($ownershipKind -eq "script" -and -not $expectedScriptPath) {
        throw "Refusing to stop script-hosted PID $processId without an exact script path."
    }
    $processHandle = $null
    try {
        try {
            $processHandle = [AntiCodex.Native.VerifiedProcessHandle]::Open($processId)
        } catch [ComponentModel.Win32Exception] {
            if ($_.Exception.NativeErrorCode -in @(87, 1168)) { return $true }
            throw
        }
        $liveExecutablePath = Normalize-Path ([string]$processHandle.ExecutablePath)
        if ([long]$processHandle.CreationFileTimeUtcTicks -ne $expectedCreationFileTimeUtcTicks -or
            -not $liveExecutablePath.Equals($expectedExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
            (Test-AntiCodexNativeCodexPath -Path $liveExecutablePath)) {
            throw "Refusing to stop PID $processId because its handle-bound identity changed."
        }
        if ($processHandle.HasExited) { return $true }
        $liveRow = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $liveRow) {
            if ($processHandle.HasExited) { return $true }
            throw "Refusing to stop PID $processId because its live process row could not be proven."
        }
        $liveOwnership = Get-AntiCodexProcessOwnership `
            -ExecutablePath $liveExecutablePath `
            -CommandLine ([string]$liveRow.CommandLine) `
            -AllowedExecutableRoots $AllowedExecutableRoots `
            -AllowedScriptPaths $AllowedScriptPaths
        if (-not $liveOwnership -or [string]$liveOwnership.Kind -cne $ownershipKind) {
            throw "Refusing to stop PID $processId because its Anti-Codex ownership changed."
        }
        if ($ownershipKind -eq "script" -and (
            -not ([string]$liveOwnership.ExpectedScriptPath).Equals(
                (Normalize-Path $expectedScriptPath),
                [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-AntiCodexCommandLineHasExactPath `
                -CommandLine ([string]$liveRow.CommandLine) `
                -Path $expectedScriptPath))) {
            throw "Refusing to stop PID $processId because its exact script identity changed."
        }
        $timeoutMilliseconds = [Math]::Max(1, $TimeoutMilliseconds)
        $processHandle.TerminateAndWait($timeoutMilliseconds)
        return $true
    } finally {
        if ($processHandle) { $processHandle.Dispose() }
    }
}

function Stop-AntiCodexProcessSnapshots {
    param(
        $Processes,
        [string[]]$AllowedExecutableRoots,
        [string[]]$AllowedScriptPaths,
        [int]$TimeoutMilliseconds
    )
    foreach ($process in @($Processes)) {
        Stop-AntiCodexVerifiedProcess `
            -Snapshot $process `
            -AllowedExecutableRoots $AllowedExecutableRoots `
            -AllowedScriptPaths $AllowedScriptPaths `
            -TimeoutMilliseconds $TimeoutMilliseconds | Out-Null
    }
}

function Get-AntiCodexMainProcesses {
    $localAppDataAntiCodex = Normalize-Path (Join-Path $env:LOCALAPPDATA "Anti-Codex")
    $expectedMainExecutable = Normalize-Path (Join-Path $localAppDataAntiCodex "codex-patched-app\Anti-Codex.exe")
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        $commandLine = [string]$_.CommandLine
        return $_.Name -ieq "Anti-Codex.exe" -and
            $exe.Equals($expectedMainExecutable, [StringComparison]::OrdinalIgnoreCase) -and
            -not (Test-AntiCodexNativeCodexPath -Path $exe) -and
            ($commandLine -notmatch "\s--type=")
    })
}

function Get-OriginalCodexMainProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        $commandLine = [string]$_.CommandLine
        return ($_.Name -ieq "Codex.exe" -or $_.Name -ieq "ChatGPT.exe") -and
            ($exe.IndexOf("AppData\Local\Anti-Codex", [StringComparison]::OrdinalIgnoreCase) -lt 0) -and
            ($commandLine -notmatch "\s--type=")
    })
}

$stateRootFull = Normalize-Path $StateRoot
$runtimeRootFull = Normalize-Path $RuntimeRoot
$processInstallRootFull = Normalize-Path (Join-Path $env:LOCALAPPDATA "Anti-Codex")
$expectedRuntimeRoot = Normalize-Path (Join-Path $processInstallRootFull "runtime")
if (-not $runtimeRootFull.Equals($expectedRuntimeRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing non-default Anti-Codex runtime root: $runtimeRootFull"
}
$processAllowedExecutableRoots = @(
    (Normalize-Path (Join-Path $processInstallRootFull "codex-patched-app")),
    (Normalize-Path (Join-Path $processInstallRootFull "components")),
    $runtimeRootFull
)
$processAllowedScriptPaths = @(
    (Normalize-Path (Join-Path $runtimeRootFull "scripts\start-anticodex.ps1")),
    (Normalize-Path (Join-Path $runtimeRootFull "scripts\start-anticodex-fixed-route.mjs")),
    (Normalize-Path (Join-Path $runtimeRootFull "scripts\deepcodex-cdp-inject.mjs")),
    (Normalize-Path (Join-Path $runtimeRootFull "scripts\anticodex-manager-bridge.mjs"))
)
$codexHomeFull = Normalize-Path (Join-Path $stateRootFull "codex-home-deepseek-app")
$defaultStateRoot = Normalize-Path (Join-Path $env:APPDATA "anticodex")
if (-not $AllowNonDefaultStateRoot -and -not $stateRootFull.Equals($defaultStateRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing non-default Anti-Codex state root without -AllowNonDefaultStateRoot: $stateRootFull"
}
Assert-UnderPath -Path $codexHomeFull -Parent $stateRootFull -Label "Anti-Codex CODEX_HOME"
if (-not (Test-Path -LiteralPath $stateRootFull -PathType Container)) {
    throw "Anti-Codex state root missing: $stateRootFull"
}
if (-not $BackupRoot) {
    $BackupRoot = Join-Path $stateRootFull "conversation-backups"
}
$backupRootFull = Normalize-Path $BackupRoot
Assert-UnderPath -Path $backupRootFull -Parent $stateRootFull -Label "conversation backup root"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $backupRootFull "cleanup-$stamp"
if (-not $WhatIfOnly) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

$moved = New-Object System.Collections.Generic.List[object]
$warnings = New-Object System.Collections.Generic.List[string]
$stoppedProcesses = @()
$stopTargets = @()
$wouldStopProcesses = @()
$originalCodexBefore = @()
$antiCodexWasRunning = $false

if (-not $SkipProcessStop) {
    $antiCodexWasRunning = @(Get-AntiCodexMainProcesses).Count -gt 0
    $originalCodexBefore = @(Get-OriginalCodexMainProcesses | ForEach-Object { [int]$_.ProcessId })
    $stopTargets = @(Get-AntiCodexProcesses -RuntimeRootFull $runtimeRootFull -StateRootFull $stateRootFull)
    $wouldStopProcesses = @($stopTargets | ForEach-Object {
        [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; executablePath = [string]$_.ExecutablePath }
    })
    $stopPids = @($stopTargets | ForEach-Object { [int]$_.ProcessId })
    $intersection = @($originalCodexBefore | Where-Object { $stopPids -contains $_ })
    if ($intersection.Count -gt 0) {
        throw "refusing to stop original Codex process ids: $($intersection -join ', ')"
    }
    if (-not $WhatIfOnly) {
        Stop-AntiCodexProcessSnapshots `
            -Processes $stopTargets `
            -AllowedExecutableRoots $processAllowedExecutableRoots `
            -AllowedScriptPaths $processAllowedScriptPaths `
            -TimeoutMilliseconds ([Math]::Max(1, $StopTimeoutSec) * 1000)
        $stopped = Wait-Until -TimeoutSeconds $StopTimeoutSec -Predicate {
            @(Get-AntiCodexProcesses -RuntimeRootFull $runtimeRootFull -StateRootFull $stateRootFull).Count -eq 0
        }
        $stoppedProcesses = @($wouldStopProcesses)
        if (-not $stopped) {
            $warnings.Add("some Anti-Codex processes were still visible after stop timeout") | Out-Null
        }
    }
}

$globalStatePath = Join-Path $stateRootFull ".codex-global-state.json"
$globalStateBakPath = "$globalStatePath.bak"
$codexGlobalStatePath = Join-Path $codexHomeFull ".codex-global-state.json"
$codexGlobalStateBakPath = "$codexGlobalStatePath.bak"
$globalState = Read-JsonObject $globalStatePath
$globalStateBak = Read-JsonObject $globalStateBakPath
$codexGlobalState = Read-JsonObject $codexGlobalStatePath
$codexGlobalStateBak = Read-JsonObject $codexGlobalStateBakPath
$workspaceRootFull = if ($WorkspaceRoot) { Normalize-Path $WorkspaceRoot } else { "" }

$savedWorkspaceRoots = @(ConvertTo-Array -Value (Get-JsonValue $globalState "electron-saved-workspace-roots" (Get-JsonValue $globalStateBak "electron-saved-workspace-roots" (Get-JsonValue $codexGlobalState "electron-saved-workspace-roots" (Get-JsonValue $codexGlobalStateBak "electron-saved-workspace-roots" @())))))
$activeWorkspaceRoots = @(ConvertTo-Array -Value (Get-JsonValue $globalState "active-workspace-roots" (Get-JsonValue $globalStateBak "active-workspace-roots" (Get-JsonValue $codexGlobalState "active-workspace-roots" (Get-JsonValue $codexGlobalStateBak "active-workspace-roots" @())))))
$workspaceRootLabels = Get-JsonValue $globalState "electron-workspace-root-labels" (Get-JsonValue $globalStateBak "electron-workspace-root-labels" (Get-JsonValue $codexGlobalState "electron-workspace-root-labels" (Get-JsonValue $codexGlobalStateBak "electron-workspace-root-labels" ([pscustomobject]@{}))))
$projectOrder = @(ConvertTo-Array -Value (Get-JsonValue $globalState "project-order" (Get-JsonValue $globalStateBak "project-order" (Get-JsonValue $codexGlobalState "project-order" (Get-JsonValue $codexGlobalStateBak "project-order" @())))))
if ($workspaceRootFull -and (Test-Path -LiteralPath $workspaceRootFull -PathType Container)) {
    $savedWorkspaceRoots = @($savedWorkspaceRoots + $workspaceRootFull | Where-Object { $_ } | Select-Object -Unique)
    $activeWorkspaceRoots = @($activeWorkspaceRoots + $workspaceRootFull | Where-Object { $_ } | Select-Object -Unique)
    $projectOrder = @($projectOrder + $workspaceRootFull | Where-Object { $_ } | Select-Object -Unique)
    $workspaceLabel = "Anti-Codex"
    if ($workspaceRootLabels.PSObject.Properties.Name -contains $workspaceRootFull) {
        if ([string]$workspaceRootLabels.$workspaceRootFull -ieq "deepcodex") {
            $workspaceRootLabels.$workspaceRootFull = $workspaceLabel
        }
    } else {
        Add-JsonProperty -Object $workspaceRootLabels -Name $workspaceRootFull -Value $workspaceLabel
    }
}

Move-IfExists -Path $globalStatePath -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path $globalStateBakPath -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path $codexGlobalStatePath -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path $codexGlobalStateBakPath -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "response-history.json") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "sessions") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "sessions") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "state_5.sqlite") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "state_5.sqlite-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "state_5.sqlite-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "state_5.sqlite") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "state_5.sqlite-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "state_5.sqlite-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "sqlite\codex-dev.db") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "sqlite\codex-dev.db-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "sqlite\codex-dev.db-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "sqlite\codex-dev.db") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "sqlite\codex-dev.db-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "sqlite\codex-dev.db-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "translator-lifecycle.json") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "translator-lifecycle.jsonl") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved

if ($IncludeLogs) {
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs_2.sqlite") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs_2.sqlite-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs_2.sqlite-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs\logs_2.sqlite") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs\logs_2.sqlite-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs\logs_2.sqlite-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    $warnings.Add("logs were cleared; re-run protect-anticodex-log-db.mjs after Anti-Codex recreates the log database") | Out-Null
}

$electronDefault = Join-Path $stateRootFull "electron-user-data-adaptive\Default"
$codexHomeElectronDefault = Join-Path $codexHomeFull "electron-user-data-adaptive\Default"
foreach ($name in @("Local Storage", "Session Storage", "Sessions", "History", "History-journal")) {
    Move-IfExists -Path (Join-Path $electronDefault $name) -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $codexHomeElectronDefault $name) -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
}

if (-not $WhatIfOnly) {
    New-Item -ItemType Directory -Path (Join-Path $stateRootFull "sessions") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stateRootFull "sqlite") -Force | Out-Null
    New-Item -ItemType Directory -Path $codexHomeFull -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $codexHomeFull "sessions") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $codexHomeFull "sqlite") -Force | Out-Null
    New-Item -ItemType Directory -Path $electronDefault -Force | Out-Null
    New-Item -ItemType Directory -Path $codexHomeElectronDefault -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $stateRootFull "response-history.json"), '{"entries":[]}', [System.Text.UTF8Encoding]::new($false))

    $newGlobalState = if ($codexGlobalState) { $codexGlobalState } elseif ($globalState) { $globalState } else { [pscustomobject]@{} }
    foreach ($propertyName in @($newGlobalState.PSObject.Properties.Name | Where-Object { $_ -like "thread-client-id-v1:*" })) {
        Remove-JsonProperty -Object $newGlobalState -Name $propertyName
    }
    Add-JsonProperty -Object $newGlobalState -Name "electron-saved-workspace-roots" -Value @($savedWorkspaceRoots)
    Add-JsonProperty -Object $newGlobalState -Name "active-workspace-roots" -Value @($activeWorkspaceRoots)
    Add-JsonProperty -Object $newGlobalState -Name "electron-workspace-root-labels" -Value $workspaceRootLabels
    Add-JsonProperty -Object $newGlobalState -Name "project-order" -Value @($projectOrder)
    Add-JsonProperty -Object $newGlobalState -Name "thread-client-id-v1" -Value $null
    Add-JsonProperty -Object $newGlobalState -Name "unread-thread-ids-by-host-v1" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "heartbeat-thread-permissions-by-id" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "projectless-thread-ids" -Value @()
    Add-JsonProperty -Object $newGlobalState -Name "thread-workspace-root-hints" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "thread-projectless-output-directories" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "prompt-history" -Value ([pscustomobject]@{ global = @() })
    Add-JsonProperty -Object $newGlobalState -Name "composer-drafts" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "composer-prompt-drafts-v1" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "composer-auto-context-enabled" -Value $false
    Add-JsonProperty -Object $newGlobalState -Name "onboarding-completed" -Value $true
    Add-JsonProperty -Object $newGlobalState -Name "electron:onboarding-override" -Value "app"
    Add-JsonProperty -Object $newGlobalState -Name "electron:onboarding-projectless-completed" -Value $true
    Add-JsonProperty -Object $newGlobalState -Name "electron:onboarding-welcome-pending" -Value $false
    Add-JsonProperty -Object $newGlobalState -Name "permissions-mode" -Value "full-access"
    $atomState = Get-JsonValue $newGlobalState "electron-persisted-atom-state" ([pscustomobject]@{})
    foreach ($propertyName in @($atomState.PSObject.Properties.Name | Where-Object { $_ -like "thread-client-id-v1:*" })) {
        Remove-JsonProperty -Object $atomState -Name $propertyName
    }
    Add-JsonProperty -Object $atomState -Name "composer-permission-mode-visibility" -Value ([pscustomobject]@{
        "guardian-approvals" = $true
        "full-access" = $true
    })
    Add-JsonProperty -Object $atomState -Name "skip-full-access-confirm" -Value $true
    Add-JsonProperty -Object $atomState -Name "agent-mode-by-host-id" -Value ([pscustomobject]@{ local = "full-access" })
    Add-JsonProperty -Object $atomState -Name "heartbeat-thread-permissions-by-id" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $atomState -Name "composer-prompt-drafts-v1" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $atomState -Name "unread-thread-ids-by-host-v1" -Value ([pscustomobject]@{ local = @() })
    Add-JsonProperty -Object $atomState -Name "projectless-thread-ids" -Value @()
    Add-JsonProperty -Object $atomState -Name "thread-workspace-root-hints" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $atomState -Name "thread-projectless-output-directories" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $atomState -Name "composer-auto-context-enabled" -Value $false
    Add-JsonProperty -Object $atomState -Name "electron:onboarding-override" -Value "app"
    Add-JsonProperty -Object $atomState -Name "electron:onboarding-projectless-completed" -Value $true
    Add-JsonProperty -Object $atomState -Name "electron:onboarding-welcome-pending" -Value $false
    Add-JsonProperty -Object $newGlobalState -Name "electron-persisted-atom-state" -Value $atomState
    Write-JsonFile -Object $newGlobalState -Path $globalStatePath
    Copy-Item -LiteralPath $globalStatePath -Destination $globalStateBakPath -Force
    Write-JsonFile -Object $newGlobalState -Path $codexGlobalStatePath
    Copy-Item -LiteralPath $codexGlobalStatePath -Destination $codexGlobalStateBakPath -Force
}

$restartRequested = $antiCodexWasRunning -and -not $WhatIfOnly -and -not $SkipRestart
$restartSucceeded = $false
$restartError = ""
$restartedProcessIds = @()
$restartLauncherProcessId = 0
if ($antiCodexWasRunning -and -not $WhatIfOnly -and -not $SkipRestart) {
    $installedLauncher = Join-Path $runtimeRootFull "scripts\start-anticodex.ps1"
    try {
        if (-not (Test-Path -LiteralPath $installedLauncher -PathType Leaf)) {
            throw "installed Anti-Codex launcher missing: $installedLauncher"
        }
        $powershellExe = Join-Path $PSHOME "powershell.exe"
        $launcherArgs = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", ('"{0}"' -f $installedLauncher),
            "-SkipUpdateCheck",
            "-InlineSupervisor"
        )
        $launcherProcess = Start-Process -FilePath $powershellExe -ArgumentList $launcherArgs -WindowStyle Hidden -PassThru
        $restartLauncherProcessId = [int]$launcherProcess.Id
        $restartSucceeded = Wait-Until -TimeoutSeconds $RestartTimeoutSec -Predicate {
            @(Get-AntiCodexMainProcesses).Count -gt 0
        }
        if (-not $restartSucceeded) {
            $launcherProcess.Refresh()
            $launcherStatus = if ($launcherProcess.HasExited) { "launcher exit code $($launcherProcess.ExitCode)" } else { "launcher still running" }
            throw "Anti-Codex main process did not return within $RestartTimeoutSec seconds ($launcherStatus)"
        }
        $restartedProcessIds = @(Get-AntiCodexMainProcesses | ForEach-Object { [int]$_.ProcessId })
    } catch {
        $restartError = $_.Exception.Message
        $warnings.Add("Anti-Codex restart failed: $restartError") | Out-Null
    }
}

$originalCodexAfter = @()
if (-not $SkipProcessStop) {
    $originalCodexAfter = @(Get-OriginalCodexMainProcesses | ForEach-Object { [int]$_.ProcessId })
}
$result = [pscustomobject]@{
    ok = -not ($restartRequested -and -not $restartSucceeded)
    whatIfOnly = [bool]$WhatIfOnly
    stateRoot = $stateRootFull
    backupDir = $backupDir
    wouldStopProcessCount = @($wouldStopProcesses).Count
    wouldStopProcesses = @($wouldStopProcesses)
    stoppedProcessCount = @($stoppedProcesses).Count
    stoppedProcesses = @($stoppedProcesses)
    moved = @($moved.ToArray())
    preservedWorkspaceRoots = @($activeWorkspaceRoots)
    preservedProjectOrder = @($projectOrder)
    responseHistoryReset = -not $WhatIfOnly
    originalCodexBefore = @($originalCodexBefore)
    originalCodexAfter = @($originalCodexAfter)
    antiCodexWasRunning = [bool]$antiCodexWasRunning
    restartRequested = [bool]$restartRequested
    restartSucceeded = [bool]$restartSucceeded
    restartedProcessIds = @($restartedProcessIds)
    restartLauncherProcessId = $restartLauncherProcessId
    restartError = $restartError
    warnings = @($warnings.ToArray())
}
$result | ConvertTo-Json -Depth 12 -Compress
if (-not $result.ok) { exit 1 }
