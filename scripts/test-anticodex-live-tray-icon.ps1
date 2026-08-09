param(
    [ValidateRange(8, 2147483647)][int]$MinimumPinkPixels = 8,
    [string]$CapturePath = "",
    [string]$ReportPath = ""
)

$ErrorActionPreference = "Stop"

$reportFull = ""
if ($ReportPath) {
    $reportFull = [IO.Path]::GetFullPath($ReportPath)
    Remove-Item -LiteralPath $reportFull, "$reportFull.sha256" -Force -ErrorAction SilentlyContinue
    $reportIoScript = Join-Path $PSScriptRoot "anticodex-report-io.ps1"
    if (-not (Test-Path -LiteralPath $reportIoScript -PathType Leaf)) {
        throw "Anti-Codex report writer is missing: $reportIoScript"
    }
    . $reportIoScript
}

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
$trayItems = New-Object System.Collections.Generic.List[object]

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
        $role = try { [int]$accessible.accRole($index) } catch { -1 }
        $state = try { [long]$accessible.accState($index) } catch { -1 }
        $isEnabled = $state -ge 0 -and (($state -band 0x1) -eq 0)
        $isInvisible = $state -lt 0 -or (($state -band 0x8000) -ne 0)
        $isOffscreen = $state -lt 0 -or (($state -band 0x10000) -ne 0)
        $visible = $width -ge 16 -and $height -ge 16 -and -not $isInvisible -and -not $isOffscreen

        $centerX = [int]($x + [Math]::Floor($width / 2))
        $centerY = [int]($y + [Math]::Floor($height / 2))
        $hit = try { $accessible.accHitTest($centerX, $centerY) } catch { $null }
        $hitChildId = 0
        $hitName = ""
        if ($hit -is [int] -or $hit -is [long] -or $hit -is [short]) {
            $hitChildId = [int]$hit
            $hitName = try { [string]$accessible.accName($hitChildId) } catch { "" }
        } elseif ($null -ne $hit) {
            $hitName = try { [string]$hit.accName(0) } catch { "" }
        }
        $hitTestMatched = $hitName -eq "Anti-Codex" -and ($hitChildId -eq 0 -or $hitChildId -eq $index)
        $clickable = $visible -and $isEnabled -and $role -eq 43 -and $hitTestMatched

        $trayItems.Add([pscustomobject]@{
            name = $name
            provider = "MSAA"
            role = $role
            state = $state
            childId = [int]$index
            toolbarWindowHandle = [long]$toolbar.ToInt64()
            isEnabled = $isEnabled
            isInvisible = $isInvisible
            isOffscreen = $isOffscreen
            visible = $visible
            clickable = $clickable
            hitTestMatched = $hitTestMatched
            x = [int]$x
            y = [int]$y
            width = [int]$width
            height = [int]$height
        }) | Out-Null
    }
}

if ($trayItems.Count -eq 0) {
    throw "The live Anti-Codex notification-area item was not found."
}
if ($trayItems.Count -ne 1) {
    throw "The live Anti-Codex notification-area identity is ambiguous ($($trayItems.Count) matches)."
}
$trayItem = $trayItems[0]
if (-not $trayItem.visible -or -not $trayItem.clickable) {
    throw "The live Anti-Codex notification-area item is not visible and clickable."
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

    $pinkArtwork = $pinkPixels -ge $MinimumPinkPixels
    $probe = [ordered]@{
        schema = "anticodex-live-tray-icon-v1"
        ok = $pinkArtwork
        checkedAt = (Get-Date).ToUniversalTime().ToString("o")
        requestedRealTraffic = $false
        usedRealTraffic = $false
        notificationAreaItem = [ordered]@{
            present = $true
            visible = [bool]$trayItem.visible
            clickable = [bool]$trayItem.clickable
            name = $trayItem.name
            provider = $trayItem.provider
            role = [int]$trayItem.role
            state = [long]$trayItem.state
            childId = [int]$trayItem.childId
            toolbarWindowHandle = [long]$trayItem.toolbarWindowHandle
            candidateCount = [int]$trayItems.Count
            isEnabled = [bool]$trayItem.isEnabled
            isInvisible = [bool]$trayItem.isInvisible
            isOffscreen = [bool]$trayItem.isOffscreen
            hitTestMatched = [bool]$trayItem.hitTestMatched
            rectangle = [ordered]@{
                x = $trayItem.x
                y = $trayItem.y
                width = $trayItem.width
                height = $trayItem.height
            }
        }
        identity = [ordered]@{
            exactAccessibleName = ($trayItem.name -ceq "Anti-Codex")
            pinkArtwork = $pinkArtwork
            pinkPixels = $pinkPixels
            minimumPinkPixels = $MinimumPinkPixels
        }
        capturePath = if ($CapturePath) { [IO.Path]::GetFullPath($CapturePath) } else { $null }
    }

    $json = $probe | ConvertTo-Json -Depth 6
    if ($reportFull) {
        Write-AntiCodexTextAtomic -Path $reportFull -Text $json -ValidateJson
    }
    $json
    if (-not $probe.ok) {
        throw "The live Anti-Codex notification-area icon is not the pink Anti-Codex artwork."
    }
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
