#Requires -Version 5.1
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

$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRoot -ne $expectedRoot) {
    throw "Anti-Codex model refresh may only run from $expectedRoot"
}

$activeHost = Join-Path $installRoot "codex-patched-app"
$startAntiCodex = Join-Path $installRoot "runtime\scripts\start-anticodex.ps1"
$stateRoot = Join-Path $env:APPDATA "anticodex"
$hostSyncMarker = Join-Path $stateRoot "host-sync.lock"
$refreshLog = Join-Path $stateRoot "model-refresh.log"
if (-not (Test-Path -LiteralPath $startAntiCodex)) {
    throw "Anti-Codex launcher is missing: $startAntiCodex"
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
    try {
        $processId = [int]$ProcessRow.ProcessId
        $executablePath = [IO.Path]::GetFullPath([string]$ProcessRow.ExecutablePath)
        $creationFileTimeUtcTicks = ([DateTimeOffset]$ProcessRow.CreationDate).UtcDateTime.ToFileTimeUtc()
        if ($processId -le 0 -or $creationFileTimeUtcTicks -le 0) { return $null }
        return [pscustomobject]@{
            ProcessId = $processId
            CreationFileTimeUtcTicks = [long]$creationFileTimeUtcTicks
            ExecutablePath = $executablePath
            CommandLine = [string]$ProcessRow.CommandLine
        }
    } catch {
        return $null
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

function Write-RefreshLog {
    param([string]$Message)
    try {
        New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
        "$(Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff") $Message" | Add-Content -LiteralPath $refreshLog -Encoding utf8
    } catch {}
}

function Read-JsonResponseBody {
    param([Parameter(Mandatory = $true)] $Response)
    try {
        $reader = New-Object IO.StreamReader($Response.GetResponseStream(), [Text.Encoding]::UTF8)
        try {
            $text = $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return $text | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
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
        try { return [int]$response.StatusCode -eq 202 } finally { $response.Dispose() }
    } catch {
        return $false
    }
}

function Find-AntiCodexLocalAddress {
    if ($env:ANTICODEX_LOCAL_ADDRESS) { return $env:ANTICODEX_LOCAL_ADDRESS }
    try {
        $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object {
                $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' -and
                -not $_.SkipAsSource
            })
        $preferred = $addresses | Sort-Object @{
            Expression = {
                if ($_.IPAddress -like "192.168.*") { 0 }
                elseif ($_.IPAddress -like "10.*") { 1 }
                else { 2 }
            }
        }, InterfaceMetric | Select-Object -First 1
        if ($preferred) { return [string]$preferred.IPAddress }
    } catch {}
    return "127.0.0.1"
}

function Invoke-AntiCodexHotModelRefresh {
    if ($env:ANTICODEX_TEST_FORCE_REFRESH_FALLBACK -eq "1") {
        Write-RefreshLog "Hot model refresh intentionally bypassed for fallback recovery verification."
        return $false
    }
    $urls = @()
    if ($env:TRANSLATOR_URL) { $urls += $env:TRANSLATOR_URL }
    $urls += "http://$(Find-AntiCodexLocalAddress):8484"
    $urls += "http://127.0.0.1:8484"
    foreach ($url in @($urls | Select-Object -Unique)) {
        $bootstrapResponse = $null
        $response = $null
        try {
            $bootstrapRequest = [System.Net.WebRequest]::Create("$url/anticodex/manager/bootstrap")
            $bootstrapRequest.Method = "GET"
            $bootstrapRequest.Proxy = $null
            $bootstrapRequest.Timeout = 5000
            $bootstrapRequest.Headers["Origin"] = $url
            $bootstrapRequest.Referer = "$url/anticodex/manager"
            $bootstrapResponse = $bootstrapRequest.GetResponse()
            $bootstrapPayload = Read-JsonResponseBody -Response $bootstrapResponse
            $managerToken = [string]$bootstrapPayload.token
            if ([string]::IsNullOrWhiteSpace($managerToken)) {
                throw "Manager action token is missing."
            }

            $request = [System.Net.WebRequest]::Create("$url/anticodex/manager/action")
            $request.Method = "POST"
            $request.Proxy = $null
            $request.Timeout = 20000
            $request.Headers["Origin"] = $url
            $request.Headers["x-anticodex-manager-token"] = $managerToken
            $request.Referer = "$url/anticodex/manager"
            $body = @{ action = "refreshModels" } | ConvertTo-Json -Compress
            $bytes = [Text.Encoding]::UTF8.GetBytes($body)
            $request.ContentType = "application/json; charset=utf-8"
            $request.ContentLength = $bytes.Length
            $stream = $request.GetRequestStream()
            try {
                $stream.Write($bytes, 0, $bytes.Length)
            } finally {
                $stream.Dispose()
            }
            $response = $request.GetResponse()
            if ([int]$response.StatusCode -eq 200) {
                $payload = Read-JsonResponseBody -Response $response
                if (-not $payload -or $payload.ok -ne $true -or $payload.result.ok -eq $false) {
                    throw "Manager model refresh did not return a successful result."
                }
                Write-RefreshLog "Hot model refresh succeeded via $url with $($payload.result.modelCount) visible models."
                return $true
            }
        } catch {
            Write-RefreshLog "Hot model refresh failed via ${url}: $($_.Exception.Message)"
        } finally {
            if ($bootstrapResponse) { $bootstrapResponse.Dispose() }
            if ($response) { $response.Dispose() }
        }
    }
    return $false
}

Write-RefreshLog "Refresh requested."
if (Invoke-AntiCodexHotModelRefresh) {
    return
}
Write-RefreshLog "Hot model refresh unavailable; falling back to restart refresh."

$mutex = New-Object Threading.Mutex($false, "Local\AntiCodexHostSync")
if (-not $mutex.WaitOne(0)) {
    $mutex.Dispose()
    throw "Anti-Codex is currently updating. Wait for the update to finish, then refresh models again."
}

try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $hostSyncMarker) -Force | Out-Null
    "Model refresh $(Get-Date -Format o)" | Set-Content -LiteralPath $hostSyncMarker -Encoding ASCII
    Write-RefreshLog "Maintenance marker created."

    $gracefulShutdownAccepted = Invoke-AntiCodexFixedRouteShutdown
    Write-RefreshLog "Fixed-route graceful shutdown accepted: $gracefulShutdownAccepted"
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        if (@(Get-AntiCodexHostProcesses).Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    Write-RefreshLog "Cooperative shutdown wait finished."

    $remainingHosts = @(Get-AntiCodexHostProcesses)
    Write-RefreshLog "Stopping $($remainingHosts.Count) remaining host processes."
    foreach ($process in $remainingHosts) {
        Stop-AntiCodexVerifiedProcess -Snapshot $process -AllowedRoot $activeHost | Out-Null
    }
    Write-RefreshLog "Remaining host processes stopped."
    if (-not (Wait-AntiCodexLaunchersStopped -TimeoutSeconds 10)) {
        throw "Anti-Codex launcher remained active after the fixed route was shut down. No process was force-terminated."
    }
    Write-RefreshLog "Anti-Codex launchers exited without force termination."
} finally {
    Remove-Item -LiteralPath $hostSyncMarker -Force -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex()
    $mutex.Dispose()
    Write-RefreshLog "Maintenance marker removed."
}

Write-RefreshLog "Starting Anti-Codex in a detached launcher process."
$powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
$previousForceStartupModelRefresh = $env:ANTICODEX_FORCE_STARTUP_MODEL_REFRESH
try {
    # A fallback restart must discover the selected account instead of reusing its predecessor's catalog.
    $env:ANTICODEX_FORCE_STARTUP_MODEL_REFRESH = "1"
    Start-Process `
        -FilePath $powerShellBin `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$startAntiCodex`"", "-InlineSupervisor") `
        -WindowStyle Hidden | Out-Null
} finally {
    $env:ANTICODEX_FORCE_STARTUP_MODEL_REFRESH = $previousForceStartupModelRefresh
}

$healthUrls = @(
    "http://$(Find-AntiCodexLocalAddress):8484/health",
    "http://127.0.0.1:8484/health"
) | Select-Object -Unique
$deadline = [DateTime]::UtcNow.AddSeconds(90)
$healthy = $false
do {
    foreach ($healthUrl in $healthUrls) {
        $healthResponse = $null
        try {
            $healthRequest = [System.Net.WebRequest]::Create($healthUrl)
            $healthRequest.Method = "GET"
            $healthRequest.Proxy = $null
            $healthRequest.Timeout = 5000
            $healthResponse = $healthRequest.GetResponse()
            if ([int]$healthResponse.StatusCode -eq 200) {
                $healthy = $true
                break
            }
        } catch {
        } finally {
            if ($healthResponse) { $healthResponse.Dispose() }
        }
    }
    if (-not $healthy) { Start-Sleep -Seconds 2 }
} while (-not $healthy -and [DateTime]::UtcNow -lt $deadline)

if (-not $healthy) {
    throw "Anti-Codex did not recover within 90 seconds after the model refresh restart."
}
Write-RefreshLog "Detached Anti-Codex launcher recovered and the gateway is healthy."
