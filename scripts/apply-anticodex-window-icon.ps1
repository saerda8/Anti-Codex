# Keep the external Anti-Codex icon alive for the Electron window and its taskbar button.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$TargetProcessId,
    [Parameter(Mandatory = $true)][string]$IconPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $IconPath -PathType Leaf)) {
    throw "Anti-Codex window icon is missing: $IconPath"
}

if (-not ("AntiCodex.Native.WindowIconKeeper" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AntiCodex.Native
{
    public static class WindowIconKeeper
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

        public static bool Apply(IntPtr window, string iconPath)
        {
            if (window == IntPtr.Zero || String.IsNullOrWhiteSpace(iconPath)) return false;
            IntPtr big = LoadImage(IntPtr.Zero, iconPath, ImageIcon, 32, 32, LoadFromFile | DefaultSize);
            IntPtr small = LoadImage(IntPtr.Zero, iconPath, ImageIcon, 16, 16, LoadFromFile | DefaultSize);
            if (big != IntPtr.Zero) SendMessage(window, WindowMessageSetIcon, new IntPtr(IconBig), big);
            if (small != IntPtr.Zero) SendMessage(window, WindowMessageSetIcon, new IntPtr(IconSmall), small);
            return big != IntPtr.Zero || small != IntPtr.Zero;
        }
    }
}
'@
}

$process = Get-Process -Id $TargetProcessId -ErrorAction Stop
$lastWindow = [IntPtr]::Zero
$applied = $false
while (-not $process.HasExited) {
    $process.Refresh()
    $window = [IntPtr]$process.MainWindowHandle
    if ($window -ne [IntPtr]::Zero -and $window -ne $lastWindow) {
        $applied = [AntiCodex.Native.WindowIconKeeper]::Apply($window, $IconPath)
        if ($applied) {
            $lastWindow = $window
            [pscustomobject]@{
                ok = $true
                pid = $TargetProcessId
                hwnd = [int64]$window
            } | ConvertTo-Json -Compress | ForEach-Object { [Console]::Out.WriteLine($_) }
            [Console]::Out.Flush()
        }
    }
    Start-Sleep -Milliseconds 250
}

if (-not $applied) {
    throw "Anti-Codex main window never exposed a usable taskbar icon handle."
}
