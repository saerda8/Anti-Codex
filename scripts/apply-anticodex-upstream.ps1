#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$DetachedWorker,
    [string]$StateRootPath = ""
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

$fixedSupervisorScript = Join-Path $PSScriptRoot "start-anticodex-fixed-route.mjs"
$stateRoot = if ($StateRootPath) {
    [IO.Path]::GetFullPath($StateRootPath)
} elseif ($env:DEEPCODEX_STATE_ROOT) {
    [IO.Path]::GetFullPath($env:DEEPCODEX_STATE_ROOT)
} else {
    [IO.Path]::GetFullPath((Join-Path $env:APPDATA "anticodex"))
}
$env:DEEPCODEX_STATE_ROOT = $stateRoot
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$applyStatusPath = Join-Path $stateRoot "apply-upstream-status.json"
$routeRestartRequestPath = Join-Path $stateRoot "route-restart-request.json"

function Write-ApplyStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$State,
        [int]$WorkerPid = 0,
        [int]$LauncherPid = 0,
        [string]$Message = ""
    )

    $payload = [ordered]@{
        schema = "anticodex-apply-upstream-status-v1"
        state = $State
        updatedAt = [DateTime]::UtcNow.ToString("o")
        workerPid = $WorkerPid
        launcherPid = $LauncherPid
        message = $Message
    }
    $temporaryPath = "$applyStatusPath.$PID.tmp"
    [IO.File]::WriteAllText(
        $temporaryPath,
        ($payload | ConvertTo-Json -Compress),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $applyStatusPath -Force
}

trap {
    if ($DetachedWorker -and (Test-Path -LiteralPath $routeRestartRequestPath -PathType Leaf)) {
        Remove-Item -LiteralPath $routeRestartRequestPath -Force -ErrorAction SilentlyContinue
    }
    Write-ApplyStatus -State "error" -WorkerPid $PID -Message $_.Exception.Message
    exit 1
}

foreach ($required in @($fixedSupervisorScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Missing Anti-Codex fixed-route component: $required"
    }
}

$powerShell = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
if (-not $DetachedWorker) {
    Write-ApplyStatus -State "delegating" -WorkerPid $PID
    $commandLine = "`"$powerShell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -DetachedWorker -StateRootPath `"$stateRoot`""
    $delegated = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
        CurrentDirectory = $PSScriptRoot
    }
    if ([int]$delegated.ReturnValue -ne 0 -or [int]$delegated.ProcessId -le 0) {
        throw "Could not delegate the Anti-Codex route switch outside the current process job (WMI $($delegated.ReturnValue))."
    }
    [pscustomobject]@{
        ok = $true
        delegated = $true
        workerPid = [int]$delegated.ProcessId
        message = "Anti-Codex route switch delegated."
    } | ConvertTo-Json -Compress
    exit 0
}

Start-Sleep -Milliseconds 750
Write-ApplyStatus -State "stopping" -WorkerPid $PID

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

function Get-AntiCodexTrustedNodeExecutablePaths {
    $paths = @()
    foreach ($name in @("node.exe", "node")) {
        foreach ($command in @(Get-Command $name -All -CommandType Application -ErrorAction SilentlyContinue)) {
            try {
                $candidate = [IO.Path]::GetFullPath([string]$command.Source)
                if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and
                    [IO.Path]::GetFileName($candidate).Equals("node.exe", [StringComparison]::OrdinalIgnoreCase) -and
                    -not (Test-AntiCodexNativeCodexPath -Path $candidate)) {
                    $paths += $candidate
                }
            } catch {}
        }
    }
    return @($paths | Sort-Object -Unique)
}

function Test-AntiCodexFixedRouteInvocation {
    param(
        [Parameter(Mandatory = $true)][string]$CommandLine,
        [Parameter(Mandatory = $true)][string]$LiveExecutablePath,
        [Parameter(Mandatory = $true)][string]$ExpectedScriptPath,
        [Parameter(Mandatory = $true)][string]$ExpectedStateRoot,
        [Parameter(Mandatory = $true)][string[]]$TrustedNodeExecutablePaths
    )
    try {
        $arguments = @([AntiCodex.Native.WindowsCommandLine]::Parse($CommandLine))
        if ($arguments.Count -lt 4) { return $false }
        $liveExecutable = [IO.Path]::GetFullPath($LiveExecutablePath)
        $commandExecutable = [IO.Path]::GetFullPath([string]$arguments[0])
        if (-not [IO.Path]::GetFileName($liveExecutable).Equals("node.exe", [StringComparison]::OrdinalIgnoreCase) -or
            (Test-AntiCodexNativeCodexPath -Path $liveExecutable) -or
            -not $commandExecutable.Equals($liveExecutable, [StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
        $trusted = @($TrustedNodeExecutablePaths | ForEach-Object {
            try { [IO.Path]::GetFullPath([string]$_) } catch {}
        })
        if (@($trusted | Where-Object {
            $_.Equals($liveExecutable, [StringComparison]::OrdinalIgnoreCase)
        }).Count -eq 0) {
            return $false
        }
        $actualScript = [IO.Path]::GetFullPath([string]$arguments[1])
        $expectedScript = [IO.Path]::GetFullPath($ExpectedScriptPath)
        if (-not $actualScript.Equals($expectedScript, [StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }

        $valueOptions = @(
            "--install-root",
            "--state-root",
            "--provider",
            "--model",
            "--context-window",
            "--proxy-port",
            "--adapter-port",
            "--cdp-port",
            "--health-port",
            "--helper-port",
            "--launcher-guard-port",
            "--manager-guard-port",
            "--manager-base-url"
        )
        $flagOptions = @("--plan-json", "--disable-gpu", "--headless")
        $stateRootValues = @()
        for ($index = 2; $index -lt $arguments.Count;) {
            $token = [string]$arguments[$index]
            if ($flagOptions -ccontains $token) {
                $index += 1
                continue
            }
            if (-not ($valueOptions -ccontains $token) -or
                ($index + 1) -ge $arguments.Count -or
                ([string]$arguments[$index + 1]).StartsWith("--", [StringComparison]::Ordinal)) {
                return $false
            }
            if ($token -ceq "--state-root") {
                $stateRootValues += [string]$arguments[$index + 1]
            }
            $index += 2
        }
        if ($stateRootValues.Count -ne 1) { return $false }
        $actualStateRoot = [IO.Path]::GetFullPath([string]$stateRootValues[0])
        $expectedStateRootFull = [IO.Path]::GetFullPath($ExpectedStateRoot)
        return $actualStateRoot.Equals($expectedStateRootFull, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Get-AntiCodexScriptProcessSnapshot {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedScriptPath,
        [Parameter(Mandatory = $true)][string]$AllowedScriptRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedStateRoot
    )
    $scriptPath = [IO.Path]::GetFullPath($ExpectedScriptPath)
    if (-not (Test-AntiCodexPathInsideRoot -Path $scriptPath -Root $AllowedScriptRoot)) { return $null }
    $trustedNodeExecutablePaths = @(Get-AntiCodexTrustedNodeExecutablePaths)
    if ($trustedNodeExecutablePaths.Count -eq 0) { return $null }
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
            -not (Test-AntiCodexFixedRouteInvocation `
                -CommandLine $commandLine `
                -LiveExecutablePath $executablePath `
                -ExpectedScriptPath $scriptPath `
                -ExpectedStateRoot $ExpectedStateRoot `
                -TrustedNodeExecutablePaths $trustedNodeExecutablePaths) -or
            $processHandle.HasExited) {
            return $null
        }
        return [pscustomobject]@{
            ProcessId = [int]$processHandle.ProcessId
            CreationFileTimeUtcTicks = [long]$processHandle.CreationFileTimeUtcTicks
            ExecutablePath = $executablePath
            CommandLine = $commandLine
        }
    } catch [ComponentModel.Win32Exception] {
        return $null
    } finally {
        if ($processHandle) { $processHandle.Dispose() }
    }
}

function Stop-AntiCodexVerifiedScriptProcess {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$ExpectedScriptPath,
        [Parameter(Mandatory = $true)][string]$AllowedScriptRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedStateRoot
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
        if (-not $liveRow -or -not $liveRow.ExecutablePath -or
            -not ([IO.Path]::GetFullPath([string]$liveRow.ExecutablePath)).Equals($liveExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-AntiCodexFixedRouteInvocation `
                -CommandLine ([string]$liveRow.CommandLine) `
                -LiveExecutablePath $liveExecutablePath `
                -ExpectedScriptPath $scriptPath `
                -ExpectedStateRoot $ExpectedStateRoot `
                -TrustedNodeExecutablePaths @(Get-AntiCodexTrustedNodeExecutablePaths))) {
            throw "Refusing to stop PID $processId because its script identity could not be proven while its handle was held."
        }
        if ($processHandle.HasExited) { return $true }
        $processHandle.TerminateAndWait(3000)
        return $true
    } catch {
        throw "Verified fixed-route PID $processId could not be stopped through its bound handle; no descendants were targeted. $($_.Exception.Message)"
    } finally {
        if ($processHandle) { $processHandle.Dispose() }
    }
}

function Get-RunningFixedRouteSupervisor {
    $statusPath = Join-Path $stateRoot "fixed-route-status.json"
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { return @() }
    try {
        $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$status.schema -ne "anticodex-fixed-route-status-v1") { return @() }
        $processId = [int]$status.pid
        if ($processId -le 0) { return @() }
        $snapshot = Get-AntiCodexScriptProcessSnapshot `
            -ProcessId $processId `
            -ExpectedScriptPath $fixedSupervisorScript `
            -AllowedScriptRoot $PSScriptRoot `
            -ExpectedStateRoot $stateRoot
        if (-not $snapshot) { return @() }
        return @($snapshot)
    } catch {
        return @()
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

function Write-RouteRestartRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$SupervisorPid
    )

    $requestId = [Guid]::NewGuid().ToString("N")
    $payload = [ordered]@{
        schema = "anticodex-route-restart-request-v1"
        requestId = $requestId
        requestedAt = [DateTime]::UtcNow.ToString("o")
        expectedSupervisorPid = $SupervisorPid
    }
    $temporaryPath = "$routeRestartRequestPath.$PID.tmp"
    [IO.File]::WriteAllText(
        $temporaryPath,
        ($payload | ConvertTo-Json -Compress),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $routeRestartRequestPath -Force
    return $requestId
}

$initialSupervisors = @(Get-RunningFixedRouteSupervisor)
$initialSupervisorPid = if ($initialSupervisors.Count -gt 0) {
    [int]$initialSupervisors[0].ProcessId
} else {
    0
}
if ($initialSupervisorPid -le 0) {
    throw "No active Anti-Codex fixed-route supervisor is available for a controlled route switch."
}
$stoppedSupervisorPids = @($initialSupervisors | ForEach-Object { [int]$_.ProcessId })
$routeRestartRequestId = Write-RouteRestartRequest -SupervisorPid $initialSupervisorPid

if ($initialSupervisors.Count -gt 0 -and (Invoke-AntiCodexFixedRouteShutdown)) {
    $gracefulDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (@(Get-RunningFixedRouteSupervisor).Count -gt 0 -and [DateTime]::UtcNow -lt $gracefulDeadline) {
        Start-Sleep -Milliseconds 100
    }
}

foreach ($supervisor in @(Get-RunningFixedRouteSupervisor)) {
    $supervisorPid = [int]$supervisor.ProcessId
    Stop-AntiCodexVerifiedScriptProcess `
        -Snapshot $supervisor `
        -ExpectedScriptPath $fixedSupervisorScript `
        -AllowedScriptRoot $PSScriptRoot `
        -ExpectedStateRoot $stateRoot | Out-Null
    if ($stoppedSupervisorPids -notcontains $supervisorPid) {
        $stoppedSupervisorPids += $supervisorPid
    }
}

if ($stoppedSupervisorPids.Count -gt 0) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if (@(Get-RunningFixedRouteSupervisor).Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (@(Get-RunningFixedRouteSupervisor).Count -gt 0) {
        throw "Fixed-route supervisor did not stop cleanly."
    }
}

$restartDeadline = [DateTime]::UtcNow.AddSeconds(60)
$launcherPid = 0
do {
    $newSupervisors = @(Get-RunningFixedRouteSupervisor | Where-Object {
        $supervisor = $_
        $stoppedSupervisorPids -notcontains [int]$supervisor.ProcessId
    })
    if ($newSupervisors.Count -gt 0) {
        $launcherPid = [int]$newSupervisors[0].ProcessId
        break
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $restartDeadline)

if ($launcherPid -le 0) {
    throw "The Anti-Codex launch task did not honor route restart request $routeRestartRequestId within 60 seconds."
}

Write-ApplyStatus -State "restart_started" -WorkerPid $PID -LauncherPid $launcherPid

[pscustomobject]@{
    ok = $true
    pid = $launcherPid
    stoppedSupervisorPids = $stoppedSupervisorPids
    message = "Anti-Codex fixed-route restart started."
} | ConvertTo-Json -Compress
