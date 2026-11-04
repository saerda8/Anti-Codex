#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipUpdateCheck,
    [switch]$InlineSupervisor,
    [switch]$SkipSyncBarrier,
    [string]$StateRootPath = "",
    [string]$NodeExecutablePath = "",
    [string]$UserProfilePath = ""
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

if (-not ("AntiCodex.Native.WindowIcon" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AntiCodex.Native
{
    public static class WindowIcon
    {
        private const uint ImageIcon = 1;
        private const uint LoadFromFile = 0x00000010;
        private const uint DefaultSize = 0x00000040;
        private const uint WindowMessageSetIcon = 0x0080;
        private const int IconSmall = 0;
        private const int IconBig = 1;

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadImage(
            IntPtr instance,
            string name,
            uint type,
            int width,
            int height,
            uint flags);

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(
            IntPtr window,
            uint message,
            IntPtr wParam,
            IntPtr lParam);

        public static bool Set(IntPtr window, string iconPath)
        {
            if (window == IntPtr.Zero || string.IsNullOrWhiteSpace(iconPath)) return false;
            IntPtr big = LoadImage(IntPtr.Zero, iconPath, ImageIcon, 32, 32, LoadFromFile | DefaultSize);
            IntPtr small = LoadImage(IntPtr.Zero, iconPath, ImageIcon, 16, 16, LoadFromFile | DefaultSize);
            if (big == IntPtr.Zero && small == IntPtr.Zero) return false;
            if (big != IntPtr.Zero) SendMessage(window, WindowMessageSetIcon, new IntPtr(IconBig), big);
            if (small != IntPtr.Zero) SendMessage(window, WindowMessageSetIcon, new IntPtr(IconSmall), small);
            return true;
        }
    }
}
'@
}

$FIXED_ROUTE_HEALTH_PORT = 18487
$FIXED_ROUTE_HEALTH_URL = "http://127.0.0.1:$FIXED_ROUTE_HEALTH_PORT/anticodex/fixed-route/health"
$FIXED_ROUTE_HEALTH_TIMEOUT_MS = if ($env:ANTICODEX_FIXED_ROUTE_HEALTH_TIMEOUT_MS) {
    [Math]::Max(1000, [int]$env:ANTICODEX_FIXED_ROUTE_HEALTH_TIMEOUT_MS)
} else {
    5000
}

function Resolve-AntiCodexPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd("\")
}

function Enter-AntiCodexHostSyncBarrier {
    param([int]$TimeoutSeconds = 180)

    $globalMutex = [Threading.Mutex]::new($false, "Global\AntiCodexHostSync")
    $localMutex = [Threading.Mutex]::new($false, "Local\AntiCodexHostSync")
    $globalAcquired = $false
    $localAcquired = $false
    try {
        try {
            $globalAcquired = $globalMutex.WaitOne([TimeSpan]::FromSeconds([Math]::Max(1, $TimeoutSeconds)))
        } catch [Threading.AbandonedMutexException] {
            $globalAcquired = $true
        }
        if (-not $globalAcquired) {
            throw "Timed out waiting for the Anti-Codex runtime publication barrier."
        }
        try {
            $localAcquired = $localMutex.WaitOne([TimeSpan]::FromSeconds([Math]::Max(1, $TimeoutSeconds)))
        } catch [Threading.AbandonedMutexException] {
            $localAcquired = $true
        }
        if (-not $localAcquired) {
            throw "Timed out waiting for the Anti-Codex compatibility publication barrier."
        }
        return [pscustomobject]@{
            GlobalMutex = $globalMutex
            LocalMutex = $localMutex
            GlobalAcquired = $globalAcquired
            LocalAcquired = $localAcquired
        }
    } catch {
        if ($localAcquired) { $localMutex.ReleaseMutex() }
        if ($globalAcquired) { $globalMutex.ReleaseMutex() }
        $localMutex.Dispose()
        $globalMutex.Dispose()
        throw
    }
}

function Exit-AntiCodexHostSyncBarrier {
    param($Barrier)
    if (-not $Barrier) { return }
    if ($Barrier.LocalAcquired) { $Barrier.LocalMutex.ReleaseMutex(); $Barrier.LocalAcquired = $false }
    if ($Barrier.GlobalAcquired) { $Barrier.GlobalMutex.ReleaseMutex(); $Barrier.GlobalAcquired = $false }
    $Barrier.LocalMutex.Dispose()
    $Barrier.GlobalMutex.Dispose()
}

function ConvertTo-AntiCodexProcessArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $quoted = [Text.StringBuilder]::new()
    [void]$quoted.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') {
            [void]$quoted.Append(('\' * (2 * $slashes + 1)))
        } elseif ($slashes -gt 0) {
            [void]$quoted.Append(('\' * $slashes))
        }
        [void]$quoted.Append($character)
        $slashes = 0
    }
    if ($slashes -gt 0) { [void]$quoted.Append(('\' * (2 * $slashes))) }
    [void]$quoted.Append('"')
    return $quoted.ToString()
}

function Invoke-AntiCodexInlineSupervisor {
    param(
        [string]$NodeExecutable,
        [string[]]$Arguments,
        [string]$StdoutLog,
        [string]$StderrLog,
        [string]$StateRoot,
        [ref]$Barrier
    )
    $process = $null
    $stdout = $null
    $stderr = $null
    $started = $false
    try {
        $stdout = [IO.File]::Open($StdoutLog, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $stderr = [IO.File]::Open($StderrLog, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $NodeExecutable
        $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-AntiCodexProcessArgument -Value $_ }) -join ' ')
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'Failed to start the Anti-Codex supervisor.' }
        $started = $true
        $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $stderrCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
        Exit-AntiCodexHostSyncBarrier $Barrier.Value
        $Barrier.Value = $null
        while (-not $process.WaitForExit(200)) {
            if ($stdoutCopy.IsFaulted -or $stdoutCopy.IsCanceled) { [void]$stdoutCopy.GetAwaiter().GetResult() }
            if ($stderrCopy.IsFaulted -or $stderrCopy.IsCanceled) { [void]$stderrCopy.GetAwaiter().GetResult() }
        }
        [void]$stdoutCopy.GetAwaiter().GetResult()
        [void]$stderrCopy.GetAwaiter().GetResult()
        return [int]$process.ExitCode
    } catch {
        if ($started -and $process -and -not $process.HasExited) {
            try { $null = Invoke-AntiCodexFixedRouteShutdown -StateRoot $StateRoot } catch {}
            try {
                if (-not $process.WaitForExit(5000)) {
                    $process.Kill()
                    $null = $process.WaitForExit(5000)
                }
            } catch {}
        }
        throw
    } finally {
        if ($stdout) { $stdout.Dispose() }
        if ($stderr) { $stderr.Dispose() }
        if ($process) { $process.Dispose() }
    }
}

function Invoke-InstalledAntiCodexLauncherIfAvailable {
    if (-not $env:LOCALAPPDATA) { return }
    $installedLauncher = Join-Path (Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime\scripts") "start-anticodex.ps1"
    if (-not (Test-Path -LiteralPath $installedLauncher -PathType Leaf)) { return }

    $currentLauncher = Resolve-AntiCodexPath $PSCommandPath
    $installedLauncher = Resolve-AntiCodexPath $installedLauncher
    if ($currentLauncher.Equals($installedLauncher, [StringComparison]::OrdinalIgnoreCase)) { return }

    $forwardArgs = @{}
    if ($SkipUpdateCheck) { $forwardArgs.SkipUpdateCheck = $true }
    if ($InlineSupervisor) { $forwardArgs.InlineSupervisor = $true }
    if ($SkipSyncBarrier) { $forwardArgs.SkipSyncBarrier = $true }
    if ($StateRootPath) { $forwardArgs.StateRootPath = $StateRootPath }
    if ($NodeExecutablePath) { $forwardArgs.NodeExecutablePath = $NodeExecutablePath }
    if ($UserProfilePath) { $forwardArgs.UserProfilePath = $UserProfilePath }
    & $installedLauncher @forwardArgs
    $exitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
    exit $exitCode
}

function Resolve-AntiCodexInstallRoot {
    $scriptParent = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    return [IO.Path]::GetFullPath((Split-Path -Parent $scriptParent))
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

function Get-RunningAntiCodexMain {
    param([Parameter(Mandatory = $true)][string]$MainExecutable)
    $mainPath = [IO.Path]::GetFullPath($MainExecutable)
    return Get-Process -Name "Anti-Codex" -ErrorAction SilentlyContinue | Where-Object {
        $path = try { [IO.Path]::GetFullPath([string]$_.Path) } catch { "" }
        $path -and
        $path.Equals($mainPath, [StringComparison]::OrdinalIgnoreCase)
    } | Sort-Object @{ Expression = { if ($_.MainWindowHandle -ne 0) { 0 } else { 1 } } }, StartTime |
        Select-Object -First 1 @{ Name = "ProcessId"; Expression = { [int]$_.Id } }, MainWindowHandle
}

function Get-RunningFixedRouteSupervisor {
    param(
        [Parameter(Mandatory = $true)][string]$SupervisorScript,
        [Parameter(Mandatory = $true)][string]$StateRoot
    )
    $statusPath = Join-Path $StateRoot "fixed-route-status.json"
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { return $null }
    try {
        $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $processId = [int]$status.pid
        if ($processId -le 0) { return $null }
        $snapshot = Get-AntiCodexScriptProcessSnapshot `
            -ProcessId $processId `
            -ExpectedScriptPath $SupervisorScript `
            -AllowedScriptRoot $PSScriptRoot
        if (-not $snapshot) { return $null }
        $health = Get-AntiCodexFixedRouteHealth
        if (-not $health -or [int]$health.pid -ne $processId) { return $null }
        return $snapshot
    } catch {
        return $null
    }
}

function Activate-AntiCodexWindow {
    param($Process)
    try {
        if ($Process -and [int64]$Process.MainWindowHandle -ne 0 -and $script:AntiCodexWindowIcon) {
            [AntiCodex.Native.WindowIcon]::Set([IntPtr]$Process.MainWindowHandle, $script:AntiCodexWindowIcon) | Out-Null
        }
    } catch {}
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.AppActivate([int]$Process.ProcessId)
    } catch {}
}

function Get-AntiCodexJson {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [int]$TimeoutMs = 5000
    )
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.WebRequest]::Create($Url)
        $request.Proxy = $null
        $request.Timeout = $TimeoutMs
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) { return $null }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } catch {
        return $null
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Get-AntiCodexFixedRouteHealth {
    return Get-AntiCodexJson -Url $FIXED_ROUTE_HEALTH_URL -TimeoutMs $FIXED_ROUTE_HEALTH_TIMEOUT_MS
}

function Test-AntiCodexFixedRouteMatches {
    param(
        $Health,
        [Parameter(Mandatory = $true)][string]$Provider,
        [Parameter(Mandatory = $true)][string]$Model
    )
    if (-not $Health -or -not $Health.ok -or [string]$Health.state -ne "ready") { return $false }
    return ([string]$Health.provider -eq $Provider) -and ([string]$Health.model -eq $Model)
}

function Stop-AntiCodexHeadlessFixedRoute {
    param(
        [Parameter(Mandatory = $true)]$SupervisorProcess,
        [Parameter(Mandatory = $true)][string]$StateRoot,
        $Health
    )
    $processId = [int]$SupervisorProcess.ProcessId
    if (-not $Health) { $Health = Get-AntiCodexFixedRouteHealth }
    if (-not $Health -or [int]$Health.pid -ne $processId -or $Health.headless -ne $true) {
        return $false
    }

    $authPath = Join-Path $StateRoot "codex-home-deepseek-app\auth.json"
    if (-not (Test-Path -LiteralPath $authPath -PathType Leaf)) { return $false }
    try {
        $controlToken = [string](Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json).OPENAI_API_KEY
    } catch {
        return $false
    }
    if ([string]::IsNullOrWhiteSpace($controlToken)) { return $false }

    $response = $null
    try {
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$FIXED_ROUTE_HEALTH_PORT/anticodex/fixed-route/shutdown")
        $request.Method = "POST"
        $request.Proxy = $null
        $request.Timeout = 3000
        $request.ReadWriteTimeout = 3000
        $request.ContentLength = 0
        $request.Headers[[Net.HttpRequestHeader]::Authorization] = "Bearer $controlToken"
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) { return $false }
    } catch {
        return $false
    } finally {
        if ($response) { $response.Dispose() }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Invoke-AntiCodexFixedRouteShutdown {
    param([Parameter(Mandatory = $true)][string]$StateRoot)
    $authPath = Join-Path $StateRoot "codex-home-deepseek-app\auth.json"
    if (-not (Test-Path -LiteralPath $authPath -PathType Leaf)) { return $false }
    try {
        $controlToken = [string](Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json).OPENAI_API_KEY
        if ([string]::IsNullOrWhiteSpace($controlToken)) { return $false }
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$FIXED_ROUTE_HEALTH_PORT/anticodex/fixed-route/shutdown")
        $request.Method = "POST"
        $request.Proxy = $null
        $request.Timeout = 3000
        $request.ReadWriteTimeout = 3000
        $request.ContentLength = 0
        $request.Headers[[Net.HttpRequestHeader]::Authorization] = "Bearer $controlToken"
        $response = $request.GetResponse()
        try { return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300 } finally { $response.Dispose() }
    } catch {
        return $false
    }
}

function Ensure-AntigravityDesktop {
    param(
        [Parameter(Mandatory = $true)][string]$StateRoot,
        [switch]$Optional
    )
    $desktopHelper = Join-Path $PSScriptRoot "antigravity-desktop.ps1"
    if (-not (Test-Path -LiteralPath $desktopHelper -PathType Leaf)) {
        throw "Anti-Codex could not find its Antigravity Desktop helper."
    }
    . $desktopHelper

    $antigravityProcess = Get-AntigravityMainProcess
    if ($antigravityProcess) {
        $env:ANTIGRAVITY_DESKTOP_PATH = [string]$antigravityProcess.ExecutablePath
        return
    }
    $antigravityPath = Resolve-AntigravityDesktopPath
    if (-not $antigravityPath) {
        if ($Optional) { return }
        throw "Antigravity Desktop is not running and no installed executable was found."
    }
    $env:ANTIGRAVITY_DESKTOP_PATH = $antigravityPath
    try {
        Start-AntigravityDesktop -ExecutablePath $antigravityPath -StateRoot $StateRoot | Out-Null
    } catch {
        if ($Optional) { return }
        throw
    }
    if ($Optional) { return }
    $startup = Wait-AntigravityDesktopStable -ExecutablePath $antigravityPath -TimeoutSeconds 30 -StableSeconds 8
    if (-not $startup.Stable) {
        throw "Antigravity Desktop did not remain running long enough for Anti-Codex."
    }
}

function Read-AntiCodexRuntimeProfile {
    param([Parameter(Mandatory = $true)][string]$StateRoot)
    $profileScript = Join-Path $PSScriptRoot "anticodex-upstream-profile.ps1"
    if (-not (Test-Path -LiteralPath $profileScript -PathType Leaf)) { return $null }
    try {
        return (& $profileScript -Action GetRuntime -StateRoot $StateRoot | ConvertFrom-Json)
    } catch {
        throw "Anti-Codex upstream profile could not be read; refusing a silent provider fallback. $($_.Exception.Message)"
    }
}

function Read-AntiCodexNativeSelection {
    param([Parameter(Mandatory = $true)][string]$CodexHome)
    $configPath = Join-Path $CodexHome "config.toml"
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $null }

    $model = ""
    foreach ($line in Get-Content -LiteralPath $configPath) {
        if ($line -match '^\s*\[') { break }
        if ($line -match '^\s*model\s*=\s*(["''])(?<model>.*?)\1\s*(?:#.*)?$') {
            $model = [string]$Matches.model
            break
        }
    }
    return [pscustomobject]@{ model = $model.Trim() }
}

function Set-AntiCodexProviderEnvironment {
    param($RuntimeProfile, $NativeSelection)
    $provider = "antigravity"
    $savedAntigravityModel = if ($RuntimeProfile -and $RuntimeProfile.PSObject.Properties["antigravityModel"]) {
        [string]$RuntimeProfile.antigravityModel
    } else {
        ""
    }
    $antigravityModel = if (-not [string]::IsNullOrWhiteSpace($savedAntigravityModel)) {
        $savedAntigravityModel
    } else {
        "gemini-3-flash-agent"
    }
    $model = $antigravityModel

    if ($null -ne $NativeSelection) {
        $selectedNativeModel = [string]$NativeSelection.model
        $thirdPartySlot = "anticodex/third-party"
        $thirdPartyPrefix = "$thirdPartySlot/"
        if ($selectedNativeModel -eq $thirdPartySlot -or $selectedNativeModel.StartsWith($thirdPartyPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $provider = "third-party"
            $model = if ($selectedNativeModel.StartsWith($thirdPartyPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                $selectedNativeModel.Substring($thirdPartyPrefix.Length)
            } else {
                [string]$RuntimeProfile.model
            }
        } elseif ($selectedNativeModel -eq "anticodex/antigravity") {
            $provider = "antigravity"
        } elseif (-not [string]::IsNullOrWhiteSpace($selectedNativeModel)) {
            $provider = "antigravity"
            $model = $selectedNativeModel
        }
    }

    $thirdPartyConfigured = $RuntimeProfile `
        -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeProfile.protocol) `
        -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeProfile.baseUrl) `
        -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeProfile.model) `
        -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeProfile.apiKey)

    if ($thirdPartyConfigured) {
        $protocol = [string]$RuntimeProfile.protocol
        $supportedProtocols = @("openai-compatible", "chat", "chat-completions", "responses")
        if ($supportedProtocols -notcontains $protocol) {
            throw "The saved third-party protocol '$protocol' is not supported by CodexPlusPlus. Use Chat Completions or Responses."
        }
        $env:UPSTREAM_PROTOCOL = $protocol
        $env:UPSTREAM_URL = [string]$RuntimeProfile.baseUrl
        $env:UPSTREAM_MODEL = if ($provider -eq "third-party") {
            $model
        } else {
            [string]$RuntimeProfile.model
        }
        $env:UPSTREAM_API_KEY = [string]$RuntimeProfile.apiKey
        $env:UPSTREAM_CONTEXT_WINDOW = [string]$RuntimeProfile.contextWindow
        $providerModels = @([string]$RuntimeProfile.model)
        if ($RuntimeProfile.capabilities -and $RuntimeProfile.capabilities.PSObject.Properties["providerModels"]) {
            foreach ($candidate in @($RuntimeProfile.capabilities.providerModels)) {
                $candidateModel = [string]$candidate
                if (-not [string]::IsNullOrWhiteSpace($candidateModel) -and $providerModels -notcontains $candidateModel) {
                    $providerModels += $candidateModel
                }
            }
        }
        $env:ANTICODEX_THIRD_PARTY_MODELS = ConvertTo-Json -InputObject ([object[]]$providerModels) -Compress
    } else {
        Remove-Item Env:UPSTREAM_PROTOCOL -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_URL -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_MODEL -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_API_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_CONTEXT_WINDOW -ErrorAction SilentlyContinue
        Remove-Item Env:ANTICODEX_THIRD_PARTY_MODELS -ErrorAction SilentlyContinue
        if ($provider -eq "third-party") {
            throw "The saved third-party profile is incomplete."
        }
    }

    $env:ANTICODEX_PROVIDER = $provider
    $env:ANTICODEX_MODEL = $model
    $env:ANTICODEX_ANTIGRAVITY_MODEL = $antigravityModel
    return [pscustomobject]@{ provider = $provider; model = $model }
}

function Wait-AntiCodexFixedRouteReady {
    param(
        [Parameter(Mandatory = $true)]$SupervisorProcess,
        [Parameter(Mandatory = $true)][string]$MainExecutable,
        [Parameter(Mandatory = $true)][string]$Provider,
        [Parameter(Mandatory = $true)][string]$Model,
        [int]$TimeoutSeconds = 120
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $health = Get-AntiCodexFixedRouteHealth
        if (Test-AntiCodexFixedRouteMatches -Health $health -Provider $Provider -Model $Model) {
            $main = Get-RunningAntiCodexMain -MainExecutable $MainExecutable
            if ($main) { return [pscustomobject]@{ health = $health; main = $main } }
        }
        if ($SupervisorProcess -is [Diagnostics.Process]) {
            try { $SupervisorProcess.Refresh() } catch {}
            if ($SupervisorProcess.HasExited) { return $null }
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

function Test-AntiCodexManagedLaunchBoundary {
    if (-not ("AntiCodexLaunchBoundary" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AntiCodexLaunchBoundary
{
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    public static bool IsCurrentProcessInJob()
    {
        bool result;
        if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out result))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return result;
    }
}
"@
    }

    $currentProcessId = [int]$PID
    $visited = New-Object "System.Collections.Generic.HashSet[int]"
    $lookupFailed = $false
    $inspectedAncestorCount = 0
    for ($depth = 0; $depth -lt 16; $depth++) {
        if (-not $visited.Add($currentProcessId)) { break }
        try {
            $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $currentProcessId" -ErrorAction Stop
        } catch {
            $lookupFailed = $true
            break
        }
        if (-not $currentProcess) {
            $lookupFailed = $true
            break
        }

        $parentProcessId = [int]$currentProcess.ParentProcessId
        if ($parentProcessId -le 0) { break }
        try {
            $parentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $parentProcessId" -ErrorAction Stop
        } catch {
            $lookupFailed = $true
            break
        }
        if (-not $parentProcess) {
            $lookupFailed = $true
            break
        }

        $inspectedAncestorCount++
        $processName = [string]$parentProcess.Name
        $identity = @(
            [string]$parentProcess.ExecutablePath,
            [string]$parentProcess.CommandLine
        ) -join "`n"
        if ($processName -ieq "codex.exe") { return $true }
        if ($processName -ieq "ChatGPT.exe" -and $identity -match "OpenAI\.Codex_") { return $true }
        $currentProcessId = $parentProcessId
    }

    # If ancestry cannot be inspected, retain the conservative job-object guard.
    if ($lookupFailed -and $inspectedAncestorCount -eq 0) {
        return [AntiCodexLaunchBoundary]::IsCurrentProcessInJob()
    }
    return $false
}

$hostSyncBarrier = $null
try {
Invoke-InstalledAntiCodexLauncherIfAvailable
if (-not $SkipSyncBarrier) {
    $hostSyncBarrier = Enter-AntiCodexHostSyncBarrier
}

$installRoot = Resolve-AntiCodexInstallRoot
$stateRoot = if ($StateRootPath) {
    [IO.Path]::GetFullPath($StateRootPath)
} else {
    Join-Path $env:APPDATA "anticodex"
}
$mainExecutable = [IO.Path]::GetFullPath((Join-Path $installRoot "codex-patched-app\Anti-Codex.exe"))
$script:AntiCodexWindowIcon = Join-Path $installRoot "codex-patched-app\resources\icon.ico"
$supervisorScript = Join-Path $PSScriptRoot "start-anticodex-fixed-route.mjs"
$componentManifest = Join-Path $installRoot "components\codexplusplus\component-manifest.json"
$launcherStatePath = Join-Path $stateRoot "launcher-state.json"
$launcherStartedAt = [DateTime]::UtcNow.ToString("o")

function Write-AntiCodexLauncherState {
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [string]$Status = "running",
        [string]$Message = ""
    )
    try {
        New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
        $payload = [ordered]@{
            schema = "anticodex-launcher-state-v1"
            pid = $PID
            startedAt = $launcherStartedAt
            updatedAt = [DateTime]::UtcNow.ToString("o")
            stage = $Stage
            status = $Status
            message = $Message
            provider = [string]$env:ANTICODEX_PROVIDER
            model = [string]$env:ANTICODEX_MODEL
        }
        $json = $payload | ConvertTo-Json -Depth 4
        [IO.File]::WriteAllText($launcherStatePath, "$json`n", [Text.UTF8Encoding]::new($false))
    } catch {}
}

trap {
    $launchError = $_.Exception.Message
    Write-AntiCodexLauncherState -Stage "failed" -Status "error" -Message $launchError
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show(
            "Anti-Codex failed to start.`r`n`r`n$launchError`r`n`r`nDetails: $launcherStatePath",
            "Anti-Codex",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    } catch {}
    exit 1
}

Write-AntiCodexLauncherState -Stage "initializing"

if (Test-AntiCodexManagedLaunchBoundary) {
    throw "Anti-Codex was not started from a safe desktop process. Use the Anti-Codex desktop shortcut so it cannot share Codex process ownership."
}

$env:DEEPCODEX_STATE_ROOT = $stateRoot
$env:CODEX_HOME_DIR = Join-Path $stateRoot "codex-home-deepseek-app"
$env:CODEX_HOME = $env:CODEX_HOME_DIR
$resolvedUserProfile = if ($UserProfilePath) {
    [IO.Path]::GetFullPath($UserProfilePath)
} elseif ($env:USERPROFILE) {
    [IO.Path]::GetFullPath($env:USERPROFILE)
} else {
    [Environment]::GetFolderPath("UserProfile")
}
$env:GLOBAL_CODEX_HOME = Join-Path $resolvedUserProfile ".codex"
$env:DEEPCODEX_SHARED_CODEX_HOME = $env:GLOBAL_CODEX_HOME
$env:DEEPCODEX_CDP_PORT = "18318"
$disableGpuRaw = if (Test-Path Env:ANTICODEX_DISABLE_GPU) {
    [string]$env:ANTICODEX_DISABLE_GPU
} else {
    [string]$env:DEEPCODEX_DISABLE_GPU
}
$disableGpu = @("1", "true", "yes", "on") -contains $disableGpuRaw.Trim().ToLowerInvariant()
if ($disableGpu) {
    $env:DEEPCODEX_DISABLE_GPU = "1"
    $env:ANTICODEX_DISABLE_GPU = "1"
} else {
    Remove-Item Env:DEEPCODEX_DISABLE_GPU -ErrorAction SilentlyContinue
    Remove-Item Env:ANTICODEX_DISABLE_GPU -ErrorAction SilentlyContinue
}
$env:DEEPCODEX_DISPLAY_NAME = "Anti-Codex"
$env:DEEPCODEX_SKIP_PLUGIN_SYNC = "1"
$env:ANTICODEX_MANAGER_API = "http://127.0.0.1:8484"
$env:DEEPCODEX_PROJECTS_ROOT = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "anticodex"
if ($env:DEEPCODEX_WORKSPACE) { $env:ANTICODEX_WORKSPACE = $env:DEEPCODEX_WORKSPACE }

Write-AntiCodexLauncherState -Stage "loading-provider"
$runtimeProfile = Read-AntiCodexRuntimeProfile -StateRoot $stateRoot
$nativeSelection = Read-AntiCodexNativeSelection -CodexHome $env:CODEX_HOME_DIR
$selection = Set-AntiCodexProviderEnvironment -RuntimeProfile $runtimeProfile -NativeSelection $nativeSelection
Ensure-AntigravityDesktop -StateRoot $stateRoot -Optional:($selection.provider -ne "antigravity")
Write-AntiCodexLauncherState -Stage "checking-running-client" -Message "$($selection.provider):$($selection.model)"

$runningMain = Get-RunningAntiCodexMain -MainExecutable $mainExecutable
if ($runningMain) {
    $fixedHealth = Get-AntiCodexFixedRouteHealth
    if (Test-AntiCodexFixedRouteMatches -Health $fixedHealth -Provider $selection.provider -Model $selection.model) {
        Activate-AntiCodexWindow $runningMain
        exit 0
    }
    Write-Error "Anti-Codex is already open without the requested fixed route. Refusing to launch a second Anti-Codex window; close the current window before switching routes."
    exit 1
}

$updateChecker = Join-Path $PSScriptRoot "check-anticodex-update.ps1"
if ((-not $SkipUpdateCheck) -and (Test-Path -LiteralPath $updateChecker -PathType Leaf)) {
    Write-AntiCodexLauncherState -Stage "checking-update"
    try {
        $updateStatus = & $updateChecker -InstallRoot $installRoot -StateRoot $stateRoot -Prompt | ConvertFrom-Json
        if ($updateStatus.sync.launched -eq $true) { exit 0 }
    } catch {
        Write-Warning "Anti-Codex update check failed: $($_.Exception.Message)"
    }
}

if (-not (Test-Path -LiteralPath $supervisorScript -PathType Leaf)) {
    Write-Error "Fixed-route supervisor is missing: $supervisorScript"
    exit 1
}
if (-not (Test-Path -LiteralPath $componentManifest -PathType Leaf)) {
    Write-Error "CodexPlusPlus component is not installed: $componentManifest"
    exit 1
}
if (-not (Test-Path -LiteralPath $mainExecutable -PathType Leaf)) {
    Write-Error "Copied Anti-Codex client is missing: $mainExecutable"
    exit 1
}

$existingSupervisor = Get-RunningFixedRouteSupervisor -SupervisorScript $supervisorScript -StateRoot $stateRoot
if ($existingSupervisor) {
    $existingHealth = Get-AntiCodexFixedRouteHealth
    if ($existingHealth -and $existingHealth.headless -eq $true) {
        Write-AntiCodexLauncherState -Stage "stopping-headless-route"
        if (-not (Stop-AntiCodexHeadlessFixedRoute -SupervisorProcess $existingSupervisor -StateRoot $stateRoot -Health $existingHealth)) {
            Write-Error "An Anti-Codex headless test route is still running and could not be stopped cleanly. Refusing to launch a duplicate."
            exit 1
        }
        $existingSupervisor = $null
    }
}
if ($existingSupervisor) {
    $existingReady = Wait-AntiCodexFixedRouteReady `
        -SupervisorProcess $existingSupervisor `
        -MainExecutable $mainExecutable `
        -Provider $selection.provider `
        -Model $selection.model `
        -TimeoutSeconds 30
    if ($existingReady) {
        Activate-AntiCodexWindow $existingReady.main
        exit 0
    }
    Write-Error "A fixed-route supervisor is already running but did not become ready. Refusing to launch a duplicate."
    exit 1
}

$nodeExecutable = if ($NodeExecutablePath) {
    [IO.Path]::GetFullPath($NodeExecutablePath)
} else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $nodeCommand) {
        Write-Error "Node.js is required to start the fixed Anti-Codex route."
        exit 1
    }
    [string]$nodeCommand.Source
}
if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
    Write-Error "Node.js executable is missing: $nodeExecutable"
    exit 1
}

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
Write-AntiCodexLauncherState -Stage "protecting-state"
$logDbGuardScript = Join-Path $PSScriptRoot "protect-anticodex-log-db.mjs"
try {
    if (-not (Test-Path -LiteralPath $logDbGuardScript -PathType Leaf)) {
        throw "log database guard script is missing"
    }
    $guardOutput = @(& $nodeExecutable $logDbGuardScript "--codex-home" $env:CODEX_HOME_DIR "--backup")
    if ($LASTEXITCODE -ne 0) {
        throw (($guardOutput | ForEach-Object { [string]$_ }) -join " ")
    }
    $guardStatus = (($guardOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $guardStatus.ok) {
        throw ([string]$guardStatus.error)
    }
} catch {
    Write-Error "Anti-Codex log database guard failed; refusing to continue startup. $($_.Exception.Message)"
    exit 1
}

$launcherOutLog = Join-Path $stateRoot "anticodex-fixed-route.out.log"
$launcherErrLog = Join-Path $stateRoot "anticodex-fixed-route.err.log"
if (-not $InlineSupervisor) {
    Remove-Item -LiteralPath $launcherOutLog, $launcherErrLog -Force -ErrorAction SilentlyContinue
}
$supervisorArgs = @(
    "`"$supervisorScript`"",
    "--install-root", "`"$installRoot`"",
    "--state-root", "`"$stateRoot`"",
    "--provider", $selection.provider,
    "--model", $selection.model,
    "--manager-base-url", $env:ANTICODEX_MANAGER_API
)
if ($disableGpu) { $supervisorArgs += "--disable-gpu" }

if ($InlineSupervisor) {
    $inlineSupervisorArgs = @(
        $supervisorScript,
        "--install-root", $installRoot,
        "--state-root", $stateRoot,
        "--provider", $selection.provider,
        "--model", $selection.model,
        "--manager-base-url", $env:ANTICODEX_MANAGER_API
    )
    if ($disableGpu) { $inlineSupervisorArgs += "--disable-gpu" }
    Write-AntiCodexLauncherState -Stage "supervising-fixed-route"
    $inlineExitCode = Invoke-AntiCodexInlineSupervisor `
        -NodeExecutable $nodeExecutable -Arguments $inlineSupervisorArgs `
        -StdoutLog $launcherOutLog -StderrLog $launcherErrLog -StateRoot $stateRoot `
        -Barrier ([ref]$hostSyncBarrier)
    if ($inlineExitCode -ne 0) {
        Write-AntiCodexLauncherState -Stage "failed" -Status "error" -Message "Anti-Codex fixed-route supervisor exited with code $inlineExitCode."
        exit $inlineExitCode
    }
    Write-AntiCodexLauncherState -Stage "closed" -Status "stopped"
    exit 0
}

Write-AntiCodexLauncherState -Stage "starting-fixed-route"
$supervisorProcess = Start-Process -FilePath $nodeExecutable `
    -ArgumentList $supervisorArgs `
    -RedirectStandardOutput $launcherOutLog `
    -RedirectStandardError $launcherErrLog `
    -WindowStyle Hidden `
    -PassThru
try {
    Exit-AntiCodexHostSyncBarrier $hostSyncBarrier
    $hostSyncBarrier = $null
} catch {
    if (-not $supervisorProcess.HasExited) {
        try { $null = Invoke-AntiCodexFixedRouteShutdown -StateRoot $stateRoot } catch {}
        try {
            if (-not $supervisorProcess.WaitForExit(5000)) {
                $supervisorProcess.Kill()
                $null = $supervisorProcess.WaitForExit(5000)
            }
        } catch {}
    }
    throw
}
$supervisorSnapshot = Get-AntiCodexScriptProcessSnapshot `
    -ProcessId $supervisorProcess.Id `
    -ExpectedScriptPath $supervisorScript `
    -AllowedScriptRoot $PSScriptRoot

$ready = Wait-AntiCodexFixedRouteReady `
    -SupervisorProcess $supervisorProcess `
    -MainExecutable $mainExecutable `
    -Provider $selection.provider `
    -Model $selection.model `
    -TimeoutSeconds 120

if (-not $ready) {
    $cleanupError = ""
    $null = Invoke-AntiCodexFixedRouteShutdown -StateRoot $stateRoot
    $gracefulDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ((Get-CimInstance Win32_Process -Filter "ProcessId = $($supervisorProcess.Id)" -ErrorAction SilentlyContinue) -and
        [DateTime]::UtcNow -lt $gracefulDeadline) {
        Start-Sleep -Milliseconds 100
    }
    if (Get-CimInstance Win32_Process -Filter "ProcessId = $($supervisorProcess.Id)" -ErrorAction SilentlyContinue) {
        if (-not $supervisorSnapshot) {
            $cleanupError = "Refused to terminate an unverified supervisor PID $($supervisorProcess.Id)."
        } else {
            try {
                Stop-AntiCodexVerifiedScriptProcess `
                    -Snapshot $supervisorSnapshot `
                    -ExpectedScriptPath $supervisorScript `
                    -AllowedScriptRoot $PSScriptRoot | Out-Null
            } catch {
                $cleanupError = $_.Exception.Message
            }
        }
    }
    $errorTail = if (Test-Path -LiteralPath $launcherErrLog) {
        (Get-Content -LiteralPath $launcherErrLog -Tail 20 -ErrorAction SilentlyContinue) -join " "
    } else {
        ""
    }
    Write-Error "Anti-Codex fixed route did not become ready. $errorTail $cleanupError"
    exit 1
}

Activate-AntiCodexWindow $ready.main
Write-AntiCodexLauncherState -Stage "ready" -Status "ready" -Message "$($selection.provider):$($selection.model)"
Write-Host "Anti-Codex fixed route is ready."
Write-Host "  Provider: $($selection.provider)"
Write-Host "  Model:    $($selection.model)"
Write-Host "  Monitor:  $($supervisorProcess.Id)"
exit 0
} finally {
    Exit-AntiCodexHostSyncBarrier -Barrier $hostSyncBarrier
}
