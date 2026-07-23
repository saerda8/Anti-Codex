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

function Get-ExactAntiCodexProcesses {
    $matchedProcesses = New-Object System.Collections.Generic.List[object]
    foreach ($candidate in @(Get-Process -Name "Anti-Codex" -ErrorAction SilentlyContinue)) {
        try { $candidatePath = [IO.Path]::GetFullPath([string]$candidate.Path) } catch { continue }
        if (-not $candidatePath) { continue }
        if ($candidatePath -ieq $expectedExecutable) { $matchedProcesses.Add($candidate) | Out-Null }
    }
    return $matchedProcesses.ToArray()
}

function Focus-ExactAntiCodexWindow {
    param([object[]]$Processes)

    if (-not ("AntiCodexShortcutWindow" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AntiCodexShortcutWindow {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
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

    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        foreach ($candidate in $Processes) {
            $process = Get-Process -Id ([int]$candidate.Id) -ErrorAction SilentlyContinue
            if ($null -eq $process) { continue }
            $window = [IntPtr]$process.MainWindowHandle
            if ($window -eq [IntPtr]::Zero) { continue }
            [void][AntiCodexShortcutWindow]::ShowWindowAsync($window, 9)
            [void][AntiCodexShortcutWindow]::SetForegroundWindow($window)

            $foregroundStableSince = $null
            $confirmationDeadline = [DateTime]::UtcNow.AddMilliseconds(325)
            do {
                $current = Get-Process -Id ([int]$candidate.Id) -ErrorAction SilentlyContinue
                $restored = $null -ne $current -and
                    [AntiCodexShortcutWindow]::IsWindowVisible($window) -and
                    -not [AntiCodexShortcutWindow]::IsIconic($window)
                if ($restored -and (Get-ForegroundProcessId) -eq [int]$candidate.Id) {
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
        }
        Start-Sleep -Milliseconds 75
    }
    return $false
}

$matchingProcesses = @(Get-ExactAntiCodexProcesses)
if ($matchingProcesses.Count -gt 0) {
    if (Focus-ExactAntiCodexWindow -Processes $matchingProcesses) {
        exit 0
    }
}

if (-not (Test-Path -LiteralPath $expectedExecutable -PathType Leaf)) {
    throw "Anti-Codex executable is missing: $expectedExecutable"
}

$service = New-Object -ComObject "Schedule.Service"
$rootFolder = $null
$task = $null
try {
    $service.Connect()
    $rootFolder = $service.GetFolder("\")
    $task = $rootFolder.GetTask("\Anti-Codex Launcher")
    [void]$task.Run($null)
} finally {
    foreach ($comObject in @($task, $rootFolder, $service)) {
        if ($null -ne $comObject -and [Runtime.InteropServices.Marshal]::IsComObject($comObject)) {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($comObject)
        }
    }
}
