[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$TargetProcessId
)

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AntiCodexConsoleWindow
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);
}
'@

[AntiCodexConsoleWindow]::FreeConsole() | Out-Null
if (-not [AntiCodexConsoleWindow]::AttachConsole([uint32]$TargetProcessId)) {
    exit 1
}

$window = [AntiCodexConsoleWindow]::GetConsoleWindow()
if ($window -ne [IntPtr]::Zero) {
    [AntiCodexConsoleWindow]::ShowWindow($window, 0) | Out-Null
}
[AntiCodexConsoleWindow]::FreeConsole() | Out-Null
