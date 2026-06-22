#Requires -Version 5.1
param(
    [string]$SourcePng = "",
    [string]$OutputPng = (Join-Path (Split-Path -Parent $PSScriptRoot) "assets\anticodex-icon.png"),
    [string]$OutputIco = (Join-Path (Split-Path -Parent $PSScriptRoot) "assets\anticodex.ico"),
    [string]$OutputDesktopPng = (Join-Path (Split-Path -Parent $PSScriptRoot) "assets\anticodex-desktop-icon.png"),
    [string]$OutputDesktopIco = (Join-Path (Split-Path -Parent $PSScriptRoot) "assets\anticodex-desktop.ico"),
    [int]$SourceArtworkPadding = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @("System.Drawing") -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class AntiCodexIconCleaner
{
    private static bool IsExternalBackground(byte r, byte g, byte b, byte a)
    {
        if (a == 0) return true;
        byte max = Math.Max(r, Math.Max(g, b));
        byte min = Math.Min(r, Math.Min(g, b));
        return r >= 218 && g >= 218 && b >= 218 && (max - min) <= 18;
    }

    public static Bitmap Create(Bitmap source, int targetSize, int padding)
    {
        using (var working = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(working))
        {
            g.CompositingMode = CompositingMode.SourceCopy;
            g.DrawImage(source, 0, 0, source.Width, source.Height);

            int width = working.Width;
            int height = working.Height;
            var rect = new Rectangle(0, 0, width, height);
            var data = working.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            int length = Math.Abs(data.Stride) * height;
            var bytes = new byte[length];
            Marshal.Copy(data.Scan0, bytes, 0, length);

            var visited = new bool[width * height];
            var queue = new Queue<int>(width + height);
            Action<int, int> add = null;
            add = (x, y) =>
            {
                if (x < 0 || y < 0 || x >= width || y >= height) return;
                int key = y * width + x;
                if (visited[key]) return;
                int i = (y * data.Stride) + (x * 4);
                if (!IsExternalBackground(bytes[i + 2], bytes[i + 1], bytes[i], bytes[i + 3])) return;
                visited[key] = true;
                queue.Enqueue(key);
            };

            for (int x = 0; x < width; x++)
            {
                add(x, 0);
                add(x, height - 1);
            }
            for (int y = 0; y < height; y++)
            {
                add(0, y);
                add(width - 1, y);
            }

            while (queue.Count > 0)
            {
                int key = queue.Dequeue();
                int x = key % width;
                int y = key / width;
                add(x + 1, y);
                add(x - 1, y);
                add(x, y + 1);
                add(x, y - 1);
            }

            int minX = width, minY = height, maxX = -1, maxY = -1;
            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    int key = y * width + x;
                    int i = (y * data.Stride) + (x * 4);
                    if (visited[key])
                    {
                        bytes[i] = 0;
                        bytes[i + 1] = 0;
                        bytes[i + 2] = 0;
                        bytes[i + 3] = 0;
                    }
                    else
                    {
                        bytes[i + 3] = 255;
                        if (x < minX) minX = x;
                        if (y < minY) minY = y;
                        if (x > maxX) maxX = x;
                        if (y > maxY) maxY = y;
                    }
                }
            }

            Marshal.Copy(bytes, 0, data.Scan0, length);
            working.UnlockBits(data);

            var square = new Bitmap(targetSize, targetSize, PixelFormat.Format32bppArgb);
            using (var sg = Graphics.FromImage(square))
            {
                sg.CompositingMode = CompositingMode.SourceCopy;
                sg.CompositingQuality = CompositingQuality.HighQuality;
                sg.InterpolationMode = InterpolationMode.HighQualityBicubic;
                sg.SmoothingMode = SmoothingMode.HighQuality;
                sg.PixelOffsetMode = PixelOffsetMode.HighQuality;
                sg.Clear(Color.FromArgb(0, 0, 0, 0));

                if (maxX >= minX && maxY >= minY)
                {
                    int cropWidth = maxX - minX + 1;
                    int cropHeight = maxY - minY + 1;
                    double scale = Math.Min((targetSize - (padding * 2)) / (double)cropWidth, (targetSize - (padding * 2)) / (double)cropHeight);
                    int drawWidth = (int)Math.Round(cropWidth * scale);
                    int drawHeight = (int)Math.Round(cropHeight * scale);
                    int drawX = (int)Math.Round((targetSize - drawWidth) / 2.0);
                    int drawY = (int)Math.Round((targetSize - drawHeight) / 2.0);
                    sg.DrawImage(working, new Rectangle(drawX, drawY, drawWidth, drawHeight), new Rectangle(minX, minY, cropWidth, cropHeight), GraphicsUnit.Pixel);
                }
            }

            return square;
        }
    }
}
"@

$explicitSourcePng = -not [string]::IsNullOrWhiteSpace($SourcePng)
$HostIconSizes = @(16, 24, 32, 48, 64, 128, 256)
$DesktopIconSizes = @(16, 24, 32, 48, 64, 128, 256)

function Get-ColorDistance {
    param(
        [System.Drawing.Color]$A,
        [System.Drawing.Color]$B
    )

    $dr = [double]($A.R - $B.R)
    $dg = [double]($A.G - $B.G)
    $db = [double]($A.B - $B.B)
    return [Math]::Sqrt(($dr * $dr) + ($dg * $dg) + ($db * $db))
}

function Get-BackgroundColor {
    param([System.Drawing.Bitmap]$Source)

    $corners = @(
        $Source.GetPixel(0, 0),
        $Source.GetPixel($Source.Width - 1, 0),
        $Source.GetPixel(0, $Source.Height - 1),
        $Source.GetPixel($Source.Width - 1, $Source.Height - 1)
    )
    $r = [int](($corners | ForEach-Object { $_.R } | Measure-Object -Average).Average)
    $g = [int](($corners | ForEach-Object { $_.G } | Measure-Object -Average).Average)
    $b = [int](($corners | ForEach-Object { $_.B } | Measure-Object -Average).Average)
    return [System.Drawing.Color]::FromArgb(255, $r, $g, $b)
}

function New-CleanSourceBitmap {
    param([System.Drawing.Bitmap]$Source)

    $background = Get-BackgroundColor $Source
    $clean = New-Object System.Drawing.Bitmap $Source.Width, $Source.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $minX = $Source.Width
    $minY = $Source.Height
    $maxX = -1
    $maxY = -1

    for ($y = 0; $y -lt $Source.Height; $y += 1) {
        for ($x = 0; $x -lt $Source.Width; $x += 1) {
            $pixel = $Source.GetPixel($x, $y)
            if ($pixel.A -eq 0) {
                $clean.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
                continue
            }

            $distance = Get-ColorDistance $pixel $background
            $alpha = [int]$pixel.A
            if ($distance -le 34) {
                $alpha = 0
            } elseif ($distance -le 82) {
                $alpha = [Math]::Min($alpha, [int](255 * (($distance - 34) / 48.0)))
            }

            if ($alpha -lt 8) {
                $clean.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
                continue
            }

            $clean.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $pixel.R, $pixel.G, $pixel.B))
            if ($x -lt $minX) { $minX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }

    if ($maxX -lt $minX -or $maxY -lt $minY) {
        return $clean
    }

    $targetSize = 1024
    $padding = 78
    $cropWidth = $maxX - $minX + 1
    $cropHeight = $maxY - $minY + 1
    $scale = [Math]::Min(($targetSize - ($padding * 2)) / [double]$cropWidth, ($targetSize - ($padding * 2)) / [double]$cropHeight)
    $drawWidth = [int][Math]::Round($cropWidth * $scale)
    $drawHeight = [int][Math]::Round($cropHeight * $scale)
    $drawX = [int][Math]::Round(($targetSize - $drawWidth) / 2)
    $drawY = [int][Math]::Round(($targetSize - $drawHeight) / 2)

    $square = New-Object System.Drawing.Bitmap $targetSize, $targetSize, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($square)
    try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
        $srcRect = New-Object System.Drawing.Rectangle $minX, $minY, $cropWidth, $cropHeight
        $dstRect = New-Object System.Drawing.Rectangle $drawX, $drawY, $drawWidth, $drawHeight
        $graphics.DrawImage($clean, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    } finally {
        $graphics.Dispose()
        $clean.Dispose()
    }

    return $square
}

function Test-ExternalBackgroundPixel {
    param([System.Drawing.Color]$Pixel)

    $max = [Math]::Max($Pixel.R, [Math]::Max($Pixel.G, $Pixel.B))
    $min = [Math]::Min($Pixel.R, [Math]::Min($Pixel.G, $Pixel.B))
    $saturation = $max - $min
    return ($Pixel.A -eq 0 -or ($Pixel.R -ge 218 -and $Pixel.G -ge 218 -and $Pixel.B -ge 218 -and $saturation -le 18))
}

function New-SourceArtworkBitmap {
    param([System.Drawing.Bitmap]$Source)

    return [AntiCodexIconCleaner]::Create($Source, 1024, $SourceArtworkPadding)
}

function New-RecoloredBitmap {
    param([System.Drawing.Bitmap]$Source)

    return New-SourceShapedCodexCloudBitmap $Source
}

function New-SourceShapedCodexCloudBitmap {
    param([System.Drawing.Bitmap]$Source)

    $iconPixels = New-Object "System.Collections.Generic.List[object]"
    for ($y = 0; $y -lt $Source.Height; $y += 1) {
        for ($x = 0; $x -lt $Source.Width; $x += 1) {
            $pixel = $Source.GetPixel($x, $y)
            $isIcon = ($pixel.B -gt 165 -or ($pixel.R -gt 190 -and $pixel.G -gt 190 -and $pixel.B -gt 190))
            if ($isIcon) {
                $iconPixels.Add((New-Object System.Drawing.PointF $x, $y)) | Out-Null
            }
        }
    }

    if ($iconPixels.Count -eq 0) {
        throw "Codex cloud source icon does not contain a detectable icon body."
    }

    $minX = $Source.Width
    $minY = $Source.Height
    $maxX = -1
    $maxY = -1
    foreach ($point in $iconPixels) {
        if ($point.X -lt $minX) { $minX = $point.X }
        if ($point.Y -lt $minY) { $minY = $point.Y }
        if ($point.X -gt $maxX) { $maxX = $point.X }
        if ($point.Y -gt $maxY) { $maxY = $point.Y }
    }

    $sourceWidth = $maxX - $minX
    $sourceHeight = $maxY - $minY
    $centerX = ($minX + $maxX) / 2.0
    $centerY = ($minY + $maxY) / 2.0
    $targetSize = 1024
    $padding = 92
    $scale = [Math]::Min(($targetSize - ($padding * 2)) / [double]$sourceWidth, ($targetSize - ($padding * 2)) / [double]$sourceHeight)
    $offsetX = ($targetSize - ($sourceWidth * $scale)) / 2.0 - ($minX * $scale)
    $offsetY = ($targetSize - ($sourceHeight * $scale)) / 2.0 - ($minY * $scale)

    $rows = New-Object "System.Collections.Generic.List[object]"
    for ($y = [int]$minY; $y -le [int]$maxY; $y += 1) {
        $left = $null
        $right = $null
        for ($x = [int]$minX; $x -le [int]$maxX; $x += 1) {
            $pixel = $Source.GetPixel($x, $y)
            $isIcon = ($pixel.B -gt 165 -or ($pixel.R -gt 190 -and $pixel.G -gt 190 -and $pixel.B -gt 190))
            if ($isIcon) {
                if ($null -eq $left) { $left = $x }
                $right = $x
            }
        }
        if ($null -ne $left -and $null -ne $right) {
            $rows.Add([pscustomobject]@{ y = $y; left = [double]$left; right = [double]$right }) | Out-Null
        }
    }

    $outline = New-Object "System.Collections.Generic.List[System.Drawing.PointF]"
    for ($i = 0; $i -lt $rows.Count; $i += 2) {
        $row = $rows[$i]
        $outline.Add((New-Object System.Drawing.PointF (($row.left * $scale) + $offsetX), (($row.y * $scale) + $offsetY))) | Out-Null
    }
    for ($i = $rows.Count - 1; $i -ge 0; $i -= 2) {
        $row = $rows[$i]
        $outline.Add((New-Object System.Drawing.PointF (($row.right * $scale) + $offsetX), (($row.y * $scale) + $offsetY))) | Out-Null
    }

    $bitmap = New-Object System.Drawing.Bitmap $targetSize, $targetSize, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))

        $cloud = New-Object System.Drawing.Drawing2D.GraphicsPath
        $cloud.AddClosedCurve($outline.ToArray(), 0.12)

        $shadow = $cloud.Clone()
        $shadowMatrix = New-Object System.Drawing.Drawing2D.Matrix
        $shadowMatrix.Translate(0, 30)
        $shadow.Transform($shadowMatrix)
        $shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(52, 116, 0, 94))
        $graphics.FillPath($shadowBrush, $shadow)
        $shadowBrush.Dispose()
        $shadow.Dispose()
        $shadowMatrix.Dispose()

        $fill = New-Object System.Drawing.Drawing2D.PathGradientBrush $cloud
        $fill.CenterPoint = New-Object System.Drawing.PointF (($centerX * $scale) + $offsetX - 74), (($centerY * $scale) + $offsetY - 150)
        $fill.CenterColor = [System.Drawing.Color]::FromArgb(255, 255, 116, 224)
        $fill.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(255, 223, 37, 176))
        $graphics.FillPath($fill, $cloud)
        $fill.Dispose()

        $shadeRect = New-Object System.Drawing.RectangleF 0, 0, $targetSize, $targetSize
        $shade = New-Object System.Drawing.Drawing2D.LinearGradientBrush $shadeRect, ([System.Drawing.Color]::FromArgb(55, 255, 226, 248)), ([System.Drawing.Color]::FromArgb(72, 174, 0, 150)), ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
        $graphics.FillPath($shade, $cloud)
        $shade.Dispose()

        $edgePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(95, 255, 199, 238)), 10
        $edgePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawPath($edgePen, $cloud)
        $edgePen.Dispose()

        $highlightPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(110, 255, 230, 250)), 14
        $highlightPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $highlightPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $graphics.DrawBezier(
            $highlightPen,
            (($minX + 22) * $scale) + $offsetX, (($minY + 10) * $scale) + $offsetY,
            (($minX + 34) * $scale) + $offsetX, (($minY + 3) * $scale) + $offsetY,
            (($minX + 52) * $scale) + $offsetX, (($minY + 6) * $scale) + $offsetY,
            (($minX + 66) * $scale) + $offsetX, (($minY + 18) * $scale) + $offsetY
        )
        $highlightPen.Dispose()

        $markShadowPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(38, 115, 0, 108)), ([float](7.5 * $scale))
        $markShadowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $markShadowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $markShadowPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawLine($markShadowPen, (33 * $scale) + $offsetX + 10, (42 * $scale) + $offsetY + 12, (43 * $scale) + $offsetX + 10, (56 * $scale) + $offsetY + 12)
        $graphics.DrawLine($markShadowPen, (43 * $scale) + $offsetX + 10, (56 * $scale) + $offsetY + 12, (33 * $scale) + $offsetX + 10, (72 * $scale) + $offsetY + 12)
        $graphics.DrawLine($markShadowPen, (59 * $scale) + $offsetX + 10, (65 * $scale) + $offsetY + 12, (76 * $scale) + $offsetX + 10, (65 * $scale) + $offsetY + 12)
        $markShadowPen.Dispose()

        $markPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 255, 255)), ([float](7.2 * $scale))
        $markPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $markPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $markPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawLine($markPen, (32 * $scale) + $offsetX, (40 * $scale) + $offsetY, (42 * $scale) + $offsetX, (56 * $scale) + $offsetY)
        $graphics.DrawLine($markPen, (42 * $scale) + $offsetX, (56 * $scale) + $offsetY, (32 * $scale) + $offsetX, (72 * $scale) + $offsetY)
        $graphics.DrawLine($markPen, (58 * $scale) + $offsetX, (65 * $scale) + $offsetY, (76 * $scale) + $offsetX, (65 * $scale) + $offsetY)
        $markPen.Dispose()

        $cloud.Dispose()
    } finally {
        $graphics.Dispose()
    }
    return $bitmap
}

function New-PolishedCodexCloudBitmap {
    $size = 1024
    $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))

        $points = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF 158, 380),
            (New-Object System.Drawing.PointF 244, 315),
            (New-Object System.Drawing.PointF 270, 206),
            (New-Object System.Drawing.PointF 402, 144),
            (New-Object System.Drawing.PointF 548, 150),
            (New-Object System.Drawing.PointF 615, 224),
            (New-Object System.Drawing.PointF 715, 204),
            (New-Object System.Drawing.PointF 834, 260),
            (New-Object System.Drawing.PointF 872, 388),
            (New-Object System.Drawing.PointF 934, 474),
            (New-Object System.Drawing.PointF 910, 618),
            (New-Object System.Drawing.PointF 807, 682),
            (New-Object System.Drawing.PointF 768, 800),
            (New-Object System.Drawing.PointF 634, 872),
            (New-Object System.Drawing.PointF 494, 846),
            (New-Object System.Drawing.PointF 392, 884),
            (New-Object System.Drawing.PointF 262, 824),
            (New-Object System.Drawing.PointF 211, 710),
            (New-Object System.Drawing.PointF 114, 654),
            (New-Object System.Drawing.PointF 102, 505)
        )
        $cloud = New-Object System.Drawing.Drawing2D.GraphicsPath
        $cloud.AddClosedCurve($points, 0.62)

        $shadowMatrix = New-Object System.Drawing.Drawing2D.Matrix
        $shadowMatrix.Translate(0, 34)
        $shadowPath = $cloud.Clone()
        $shadowPath.Transform($shadowMatrix)
        $shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(54, 118, 18, 92))
        $graphics.FillPath($shadowBrush, $shadowPath)
        $shadowBrush.Dispose()
        $shadowPath.Dispose()
        $shadowMatrix.Dispose()

        $outerGlowPath = $cloud.Clone()
        $outerGlowPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(70, 255, 180, 230)), 22
        $outerGlowPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawPath($outerGlowPen, $outerGlowPath)
        $outerGlowPen.Dispose()
        $outerGlowPath.Dispose()

        $fill = New-Object System.Drawing.Drawing2D.PathGradientBrush $cloud
        $fill.CenterPoint = New-Object System.Drawing.PointF 410, 305
        $fill.CenterColor = [System.Drawing.Color]::FromArgb(255, 255, 112, 221)
        $fill.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(255, 226, 42, 176))
        $graphics.FillPath($fill, $cloud)
        $fill.Dispose()

        $topLightRect = New-Object System.Drawing.RectangleF 96, 104, 860, 780
        $topLight = New-Object System.Drawing.Drawing2D.LinearGradientBrush $topLightRect, ([System.Drawing.Color]::FromArgb(82, 255, 218, 245)), ([System.Drawing.Color]::FromArgb(0, 255, 218, 245)), ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
        $graphics.FillPath($topLight, $cloud)
        $topLight.Dispose()

        $bottomShadeRect = New-Object System.Drawing.RectangleF 96, 104, 860, 780
        $bottomShade = New-Object System.Drawing.Drawing2D.LinearGradientBrush $bottomShadeRect, ([System.Drawing.Color]::FromArgb(0, 162, 14, 148)), ([System.Drawing.Color]::FromArgb(82, 162, 14, 148)), ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
        $graphics.FillPath($bottomShade, $cloud)
        $bottomShade.Dispose()

        $edgePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(100, 255, 202, 237)), 10
        $edgePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawPath($edgePen, $cloud)
        $edgePen.Dispose()

        $innerPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(45, 150, 0, 130)), 8
        $innerPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawPath($innerPen, $cloud)
        $innerPen.Dispose()

        $highlightPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        $highlightPath.AddBezier(270, 226, 350, 174, 500, 176, 586, 244)
        $highlightPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(135, 255, 230, 250)), 11
        $highlightPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $highlightPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $graphics.DrawPath($highlightPen, $highlightPath)
        $highlightPen.Dispose()
        $highlightPath.Dispose()

        $markShadowPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(42, 100, 0, 100)), 62
        $markShadowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $markShadowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $markShadowPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawLine($markShadowPen, 326, 404, 436, 540)
        $graphics.DrawLine($markShadowPen, 436, 540, 326, 676)
        $graphics.DrawLine($markShadowPen, 542, 626, 746, 626)
        $markShadowPen.Dispose()

        $markPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 255, 255)), 58
        $markPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $markPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $markPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawLine($markPen, 316, 384, 426, 520)
        $graphics.DrawLine($markPen, 426, 520, 316, 656)
        $graphics.DrawLine($markPen, 532, 606, 736, 606)
        $markPen.Dispose()

        $cloud.Dispose()
    } finally {
        $graphics.Dispose()
    }
    return $bitmap
}

function Resize-BitmapPngBytes {
    param([System.Drawing.Bitmap]$Bitmap, [int]$Size)

    $resized = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($resized)
    try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($Bitmap, 0, 0, $Size, $Size)
    } finally {
        $graphics.Dispose()
    }

    $stream = New-Object IO.MemoryStream
    try {
        $resized.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return $stream.ToArray()
    } finally {
        $stream.Dispose()
        $resized.Dispose()
    }
}

function Write-Ico {
    param([System.Drawing.Bitmap]$Bitmap, [string]$Path, [int[]]$Sizes)

    $sizes = @($Sizes)
    $images = New-Object "System.Collections.Generic.List[byte[]]"
    foreach ($size in $sizes) {
        $images.Add((Resize-BitmapPngBytes $Bitmap $size)) | Out-Null
    }
    $directorySize = 6 + ($sizes.Count * 16)
    $offset = $directorySize
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write)
    $writer = New-Object IO.BinaryWriter $stream
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]$sizes.Count)
        for ($i = 0; $i -lt $sizes.Count; $i += 1) {
            $size = $sizes[$i]
            $bytes = $images[$i]
            $dimension = if ($size -eq 256) { 0 } else { $size }
            $writer.Write([byte]$dimension)
            $writer.Write([byte]$dimension)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([UInt16]1)
            $writer.Write([UInt16]32)
            $writer.Write([UInt32]$bytes.Length)
            $writer.Write([UInt32]$offset)
            $offset += $bytes.Length
        }
        foreach ($bytes in $images) {
            $writer.Write($bytes)
        }
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

if ([string]::IsNullOrWhiteSpace($SourcePng)) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $candidates = @(
        (Join-Path $repoRoot "assets\codex-icon-source.png"),
        (Join-Path $env:LOCALAPPDATA "Anti-Codex\codex-patched-app\resources\default_app\icon.png"),
        (Join-Path $env:LOCALAPPDATA "Anti-Codex\rollback-host\resources\default_app\icon.png")
    )
    $SourcePng = ($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
}

if ([string]::IsNullOrWhiteSpace($SourcePng) -or -not (Test-Path -LiteralPath $SourcePng -PathType Leaf)) {
    throw "Codex source icon PNG not found. Pass -SourcePng or run after Anti-Codex/Codex host is installed."
}

New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPng) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputIco) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputDesktopPng) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputDesktopIco) -Force | Out-Null

$source = New-Object System.Drawing.Bitmap $SourcePng
try {
    $pink = if ($explicitSourcePng) { New-SourceArtworkBitmap $source } else { New-RecoloredBitmap $source }
    try {
        $pink.Save($OutputPng, [System.Drawing.Imaging.ImageFormat]::Png)
        $pink.Save($OutputDesktopPng, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Ico $pink $OutputIco $HostIconSizes
        Write-Ico $pink $OutputDesktopIco $DesktopIconSizes
    } finally {
        $pink.Dispose()
    }
} finally {
    $source.Dispose()
}

Write-Host "Generated Anti-Codex icon:"
Write-Host "  PNG: $OutputPng"
Write-Host "  ICO: $OutputIco"
Write-Host "  Desktop PNG: $OutputDesktopPng"
Write-Host "  Desktop ICO: $OutputDesktopIco"
