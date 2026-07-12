param(
    [int]$MinimumPinkPixels = 8,
    [string]$CapturePath = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AntiCodexTrayProbe
{
    public delegate bool EnumChildProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

    [DllImport("oleacc.dll")]
    public static extern int AccessibleObjectFromWindow(
        IntPtr hwnd,
        int objectId,
        ref Guid interfaceId,
        [In, Out, MarshalAs(UnmanagedType.Interface)] ref object accessible);

    public static IntPtr[] FindNotificationToolbars()
    {
        var taskbar = FindWindow("Shell_TrayWnd", null);
        if (taskbar == IntPtr.Zero) return Array.Empty<IntPtr>();

        var toolbars = new List<IntPtr>();
        EnumChildWindows(taskbar, (hwnd, _) =>
        {
            var className = new StringBuilder(128);
            GetClassName(hwnd, className, className.Capacity);
            if (className.ToString() == "ToolbarWindow32") toolbars.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return toolbars.ToArray();
    }
}
'@

$accessibleId = [Guid]"618736E0-3C3D-11CF-810C-00AA00389B71"
$trayItem = $null

foreach ($toolbar in [AntiCodexTrayProbe]::FindNotificationToolbars()) {
    $accessible = $null
    $result = [AntiCodexTrayProbe]::AccessibleObjectFromWindow(
        $toolbar,
        -4,
        [ref]$accessibleId,
        [ref]$accessible
    )
    if ($result -ne 0 -or $null -eq $accessible) { continue }

    for ($index = 1; $index -le $accessible.accChildCount; $index++) {
        $name = try { [string]$accessible.accName($index) } catch { "" }
        if ($name -ne "Anti-Codex") { continue }

        $x = 0
        $y = 0
        $width = 0
        $height = 0
        $accessible.accLocation([ref]$x, [ref]$y, [ref]$width, [ref]$height, $index)
        $trayItem = [pscustomobject]@{
            name = $name
            x = [int]$x
            y = [int]$y
            width = [int]$width
            height = [int]$height
        }
        break
    }
    if ($trayItem) { break }
}

if (-not $trayItem) {
    throw "The live Anti-Codex notification-area item was not found."
}
if ($trayItem.width -lt 16 -or $trayItem.height -lt 16) {
    throw "The live Anti-Codex notification-area item has an invalid rectangle."
}

$bitmap = New-Object System.Drawing.Bitmap $trayItem.width, $trayItem.height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($trayItem.x, $trayItem.y, 0, 0, $bitmap.Size)
    if ($CapturePath) {
        $captureFull = [IO.Path]::GetFullPath($CapturePath)
        $captureDirectory = Split-Path -Parent $captureFull
        if ($captureDirectory -and -not (Test-Path -LiteralPath $captureDirectory)) {
            New-Item -ItemType Directory -Path $captureDirectory -Force | Out-Null
        }
        $bitmap.Save($captureFull, [System.Drawing.Imaging.ImageFormat]::Png)
    }

    $pinkPixels = 0
    for ($pixelY = 0; $pixelY -lt $bitmap.Height; $pixelY++) {
        for ($pixelX = 0; $pixelX -lt $bitmap.Width; $pixelX++) {
            $color = $bitmap.GetPixel($pixelX, $pixelY)
            if ($color.R -ge 180 -and
                $color.B -ge 100 -and
                $color.G -le 185 -and
                ($color.R - $color.G) -ge 35) {
                $pinkPixels++
            }
        }
    }

    $probe = [ordered]@{
        ok = ($pinkPixels -ge $MinimumPinkPixels)
        name = $trayItem.name
        rectangle = [ordered]@{
            x = $trayItem.x
            y = $trayItem.y
            width = $trayItem.width
            height = $trayItem.height
        }
        pinkPixels = $pinkPixels
        minimumPinkPixels = $MinimumPinkPixels
        capturePath = if ($CapturePath) { [IO.Path]::GetFullPath($CapturePath) } else { $null }
    }

    $probe | ConvertTo-Json -Depth 4
    if (-not $probe.ok) {
        throw "The live Anti-Codex notification-area icon is not the pink Anti-Codex artwork."
    }
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
