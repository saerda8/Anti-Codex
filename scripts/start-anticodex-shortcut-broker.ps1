#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Anti-Codex")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installRootFull = [IO.Path]::GetFullPath($InstallRoot)
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRootFull -ine $expectedRoot) {
    throw "Anti-Codex shortcut broker may only launch $expectedRoot"
}

$expectedExecutable = [IO.Path]::GetFullPath((Join-Path $installRootFull "codex-patched-app\Anti-Codex.exe"))

function Show-AntiCodexShortcutFailure {
    param([Parameter(Mandatory = $true)][string]$Message)

    try {
        $logRoot = Join-Path $env:APPDATA "anticodex\logs"
        New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
        Add-Content -LiteralPath (Join-Path $logRoot "anticodex-shortcut.err.log") `
            -Value ("{0} {1}" -f [DateTime]::UtcNow.ToString("o"), $Message) `
            -Encoding UTF8
    } catch {}
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($Message, 12, "Anti-Codex", 16)
    } catch {}
}

function Get-ExactAntiCodexProcesses {
    $matchedProcesses = New-Object System.Collections.Generic.List[object]
    foreach ($candidate in @(Get-Process -Name "Anti-Codex" -ErrorAction SilentlyContinue)) {
        try { $candidatePath = [IO.Path]::GetFullPath([string]$candidate.Path) } catch { continue }
        if (-not $candidatePath) { continue }
        if ($candidatePath -ieq $expectedExecutable) { $matchedProcesses.Add($candidate) | Out-Null }
    }
    return $matchedProcesses.ToArray()
}

function Test-ExactAntiCodexProcessIdentity {
    param(
        [object]$Process,
        [int]$ExpectedId,
        [DateTime]$ExpectedStartTimeUtc
    )

    if ($null -eq $Process -or [int]$Process.Id -ne $ExpectedId) { return $false }
    try {
        $processPath = [IO.Path]::GetFullPath([string]$Process.Path)
        $processStartTimeUtc = ([DateTime]$Process.StartTime).ToUniversalTime()
    } catch {
        return $false
    }
    return $processPath -ieq $expectedExecutable -and
        $processStartTimeUtc.Ticks -eq $ExpectedStartTimeUtc.Ticks
}

function Focus-ExactAntiCodexWindow {
    param([object[]]$Processes)

    if (-not ("AntiCodexShortcutWindow" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AntiCodexShortcutWindow {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool RedrawWindow(IntPtr hWnd, IntPtr updateRect, IntPtr updateRegion, uint flags);
    [DllImport("dwmapi.dll")]
    public static extern int DwmFlush();
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public static long[] FindMainWindows(int processId) {
        var result = IntPtr.Zero;
        var candidateCount = 0;
        EnumWindows(delegate (IntPtr hWnd, IntPtr _) {
            uint candidateProcessId;
            GetWindowThreadProcessId(hWnd, out candidateProcessId);
            if (candidateProcessId != (uint)processId || GetWindow(hWnd, 4) != IntPtr.Zero) return true;
            if ((GetWindowLong(hWnd, -16) & 0x00C00000) != 0x00C00000) return true;
            var title = new StringBuilder(64);
            var className = new StringBuilder(64);
            GetWindowText(hWnd, title, title.Capacity);
            GetClassName(hWnd, className, className.Capacity);
            if (!String.Equals(title.ToString(), "Anti-Codex", StringComparison.Ordinal)
                || !String.Equals(className.ToString(), "Chrome_WidgetWin_1", StringComparison.Ordinal)) return true;
            candidateCount++;
            result = hWnd;
            return true;
        }, IntPtr.Zero);
        return new long[] { candidateCount, result.ToInt64() };
    }
}
"@
    }

    function Get-ForegroundProcessId {
        $foregroundWindow = [AntiCodexShortcutWindow]::GetForegroundWindow()
        if ($foregroundWindow -eq [IntPtr]::Zero) { return 0 }
        [uint32]$foregroundProcessId = 0
        [void][AntiCodexShortcutWindow]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundProcessId)
        return [int]$foregroundProcessId
    }

    $windowDiscoveryDeadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        $eligibleWindows = New-Object System.Collections.Generic.List[object]
        $eligibleWindowCount = 0
        foreach ($candidate in $Processes) {
            try { $candidateStartTimeUtc = ([DateTime]$candidate.StartTime).ToUniversalTime() } catch { continue }
            $process = Get-Process -Id ([int]$candidate.Id) -ErrorAction SilentlyContinue
            if (-not (Test-ExactAntiCodexProcessIdentity -Process $process -ExpectedId ([int]$candidate.Id) -ExpectedStartTimeUtc $candidateStartTimeUtc)) { continue }
            $windowMatch = [AntiCodexShortcutWindow]::FindMainWindows([int]$candidate.Id)
            $candidateCount = [int]$windowMatch[0]
            $eligibleWindowCount += $candidateCount
            if ($candidateCount -ne 1) { continue }
            $window = [IntPtr][int64]$windowMatch[1]
            $eligibleWindows.Add([pscustomobject]@{
                processId = [int]$candidate.Id
                startTimeUtc = $candidateStartTimeUtc
                window = [IntPtr]$window
            }) | Out-Null
        }
        if ($eligibleWindowCount -ne 1 -or $eligibleWindows.Count -ne 1) {
            Start-Sleep -Milliseconds 75
            continue
        }

        $eligible = $eligibleWindows[0]
        $processId = [int]$eligible.processId
        $window = [IntPtr]$eligible.window
        if ([AntiCodexShortcutWindow]::IsIconic($window)) {
            [void][AntiCodexShortcutWindow]::ShowWindowAsync($window, 4)
            $paintDeadline = [DateTime]::UtcNow.AddMilliseconds(250)
            while ([AntiCodexShortcutWindow]::IsIconic($window) -and [DateTime]::UtcNow -lt $paintDeadline) {
                Start-Sleep -Milliseconds 10
            }
            [void][AntiCodexShortcutWindow]::RedrawWindow($window, [IntPtr]::Zero, [IntPtr]::Zero, 0x0181)
            [void][AntiCodexShortcutWindow]::DwmFlush()
        } else {
            [void][AntiCodexShortcutWindow]::ShowWindowAsync($window, 9)
        }
        [void][AntiCodexShortcutWindow]::SetForegroundWindow($window)

        $foregroundStableSince = $null
        $confirmationDeadline = [DateTime]::UtcNow.AddMilliseconds(325)
        do {
            $current = Get-Process -Id $processId -ErrorAction SilentlyContinue
            $restored = (Test-ExactAntiCodexProcessIdentity -Process $current -ExpectedId $processId -ExpectedStartTimeUtc ([DateTime]$eligible.startTimeUtc)) -and
                [AntiCodexShortcutWindow]::IsWindowVisible($window) -and
                -not [AntiCodexShortcutWindow]::IsIconic($window)
            if ($restored -and (Get-ForegroundProcessId) -eq $processId) {
                if ($null -eq $foregroundStableSince) {
                    $foregroundStableSince = [DateTime]::UtcNow
                } elseif (([DateTime]::UtcNow - $foregroundStableSince).TotalMilliseconds -ge 150) {
                    return $true
                }
            } else {
                $foregroundStableSince = $null
            }
            Start-Sleep -Milliseconds 25
        } while ([DateTime]::UtcNow -lt $confirmationDeadline)
        Start-Sleep -Milliseconds 75
    } while ([DateTime]::UtcNow -lt $windowDiscoveryDeadline)
    return $false
}

function Invoke-AntiCodexSecondInstanceRestore {
    param([object[]]$Processes)

    $userDataPath = Join-Path $env:APPDATA "anticodex\codex-home-deepseek-app\electron-user-data-adaptive"
    $previousUserDataPath = [Environment]::GetEnvironmentVariable("CODEX_ELECTRON_USER_DATA_PATH", "Process")
    $handoff = $null
    try {
        try {
            $env:CODEX_ELECTRON_USER_DATA_PATH = $userDataPath
            $handoff = Start-Process -FilePath $expectedExecutable -PassThru
            [void]$handoff.Handle
        } finally {
            if ($null -eq $previousUserDataPath) {
                Remove-Item Env:CODEX_ELECTRON_USER_DATA_PATH -ErrorAction SilentlyContinue
            } else {
                $env:CODEX_ELECTRON_USER_DATA_PATH = $previousUserDataPath
            }
        }
        $focused = Focus-ExactAntiCodexWindow -Processes $Processes
        $exitDeadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            try { $handoff.Refresh() } catch {}
            if ($handoff.HasExited) { break }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $exitDeadline)
        return $focused -and $handoff.HasExited
    } catch {
        return $false
    } finally {
        try {
            if ($handoff -and -not $handoff.HasExited) {
                $handoff.Kill()
                [void]$handoff.WaitForExit(3000)
            }
        } catch {}
        if ($handoff) { $handoff.Dispose() }
    }
}

$matchingProcesses = @(Get-ExactAntiCodexProcesses)
if ($matchingProcesses.Count -gt 0) {
    if (Focus-ExactAntiCodexWindow -Processes $matchingProcesses) {
        exit 0
    }
    if (Invoke-AntiCodexSecondInstanceRestore -Processes $matchingProcesses) {
        exit 0
    }
    Show-AntiCodexShortcutFailure -Message "Anti-Codex is running, but its main window is not ready. Wait a moment and try the shortcut again."
    exit 1
}

if (-not (Test-Path -LiteralPath $expectedExecutable -PathType Leaf)) {
    Show-AntiCodexShortcutFailure -Message "Anti-Codex executable is missing. Run 【修复快捷方式】 in 管理 and try again."
    exit 1
}

try {
    Start-ScheduledTask -TaskName "Anti-Codex Launcher"
} catch {
    Show-AntiCodexShortcutFailure -Message ("Anti-Codex could not start. Run 【修复快捷方式】 in 管理 and try again.`n`n" + $_.Exception.Message)
    exit 1
}
