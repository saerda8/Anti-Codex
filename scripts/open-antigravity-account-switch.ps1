#Requires -Version 5.1

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "antigravity-desktop.ps1")

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace AntiCodex.Native {
    public static class WindowActivation {
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr windowHandle);

        [DllImport("user32.dll")]
        public static extern bool ShowWindowAsync(IntPtr windowHandle, int command);
    }
}
"@

$desktopPath = Resolve-AntigravityDesktopPath
if (-not $desktopPath) {
    throw "Antigravity Desktop is not installed or cannot be located. Install it or set ANTIGRAVITY_DESKTOP_PATH."
}

$existing = Get-AntigravityMainProcess -ExecutablePath $desktopPath
if ($existing) {
    $focused = $false
    $desktopProcess = Get-Process -Id ([int]$existing.ProcessId) -ErrorAction SilentlyContinue
    if ($desktopProcess -and $desktopProcess.MainWindowHandle -ne [IntPtr]::Zero) {
        [AntiCodex.Native.WindowActivation]::ShowWindowAsync($desktopProcess.MainWindowHandle, 9) | Out-Null
        $focused = [AntiCodex.Native.WindowActivation]::SetForegroundWindow($desktopProcess.MainWindowHandle)
    }
    [pscustomobject]@{
        ok = $true
        launched = $false
        reused = $true
        focused = [bool]$focused
        pid = [int]$existing.ProcessId
        nextAction = "refreshModels"
    } | ConvertTo-Json -Compress
    exit 0
}

$process = Start-Process -FilePath $desktopPath -WindowStyle Normal -PassThru
$stable = Wait-AntigravityDesktopStable `
    -ExecutablePath $desktopPath `
    -TimeoutSeconds 50 `
    -StableSeconds 3

if (-not $stable.Stable) {
    throw "Antigravity Desktop did not become stable within 50 seconds."
}

[pscustomobject]@{
    ok = $true
    launched = $true
    reused = $false
    focused = $true
    pid = [int]$stable.Process.ProcessId
    nextAction = "refreshModels"
} | ConvertTo-Json -Compress
