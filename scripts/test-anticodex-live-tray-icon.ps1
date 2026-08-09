param(
    [ValidateRange(8, 2147483647)][int]$MinimumPinkPixels = 8,
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ExpectedMainPid,
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
    private const uint TB_GETBUTTON = 0x0417;
    private const uint PROCESS_VM_OPERATION = 0x0008;
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint PROCESS_VM_WRITE = 0x0020;
    private const uint MEM_COMMIT = 0x1000;
    private const uint MEM_RESERVE = 0x2000;
    private const uint MEM_RELEASE = 0x8000;
    private const uint PAGE_READWRITE = 0x04;
    private const uint SMTO_ABORTIFHUNG = 0x0002;

    public delegate bool EnumChildProc(IntPtr hwnd, IntPtr lParam);

    public sealed class NotificationButtonIdentity
    {
        public long OwnerWindowHandle { get; set; }
        public uint OwnerProcessId { get; set; }
        public string OwnerWindowClass { get; set; }
        public uint NotifyIconId { get; set; }
        public bool AntiGuidRectAvailable { get; set; }
        public int RectLeft { get; set; }
        public int RectTop { get; set; }
        public int RectRight { get; set; }
        public int RectBottom { get; set; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NOTIFYICONIDENTIFIER
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public Guid guidItem;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam,
        uint flags, uint timeoutMs, out IntPtr result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr VirtualAllocEx(IntPtr process, IntPtr address, UIntPtr size, uint allocationType, uint protect);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualFreeEx(IntPtr process, IntPtr address, UIntPtr size, uint freeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr bytesRead);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("shell32.dll")]
    private static extern int Shell_NotifyIconGetRect(ref NOTIFYICONIDENTIFIER identifier, out RECT iconLocation);

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

    // ToolbarWindow32 stores a TBBUTTON whose dwData points at Explorer's TRAYDATA.
    public static NotificationButtonIdentity ReadNotificationButton(IntPtr toolbar, int buttonIndex, Guid antiGuid)
    {
        uint explorerPid;
        if (buttonIndex < 0 || GetWindowThreadProcessId(toolbar, out explorerPid) == 0 || explorerPid == 0)
            throw new InvalidOperationException("The notification toolbar owner could not be identified.");

        IntPtr process = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, false, explorerPid);
        if (process == IntPtr.Zero) throw new InvalidOperationException("The notification toolbar process could not be opened.");
        int buttonSize = IntPtr.Size == 8 ? 32 : 20;
        IntPtr remoteButton = IntPtr.Zero;
        try
        {
            remoteButton = VirtualAllocEx(process, IntPtr.Zero, (UIntPtr)buttonSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if (remoteButton == IntPtr.Zero) throw new InvalidOperationException("A notification toolbar read buffer could not be allocated.");
            IntPtr messageResult;
            if (SendMessageTimeout(toolbar, TB_GETBUTTON, (IntPtr)buttonIndex, remoteButton,
                SMTO_ABORTIFHUNG, 1000, out messageResult) == IntPtr.Zero || messageResult == IntPtr.Zero)
                throw new InvalidOperationException("TB_GETBUTTON failed for the notification toolbar item.");

            var buttonBytes = new byte[buttonSize];
            UIntPtr bytesRead;
            if (!ReadProcessMemory(process, remoteButton, buttonBytes, (UIntPtr)buttonBytes.Length, out bytesRead)
                || bytesRead.ToUInt64() != (ulong)buttonBytes.Length)
                throw new InvalidOperationException("The notification toolbar button could not be read.");

            long trayDataAddress = IntPtr.Size == 8 ? BitConverter.ToInt64(buttonBytes, 16) : BitConverter.ToInt32(buttonBytes, 12);
            if (trayDataAddress == 0) throw new InvalidOperationException("The notification toolbar item has no TRAYDATA identity.");
            var trayBytes = new byte[IntPtr.Size == 8 ? 32 : 24];
            if (!ReadProcessMemory(process, (IntPtr)trayDataAddress, trayBytes, (UIntPtr)trayBytes.Length, out bytesRead)
                || bytesRead.ToUInt64() != (ulong)trayBytes.Length)
                throw new InvalidOperationException("The notification toolbar TRAYDATA could not be read.");

            long ownerHwndValue = IntPtr.Size == 8 ? BitConverter.ToInt64(trayBytes, 0) : BitConverter.ToInt32(trayBytes, 0);
            uint notifyIconId = BitConverter.ToUInt32(trayBytes, IntPtr.Size);
            var ownerHwnd = (IntPtr)ownerHwndValue;
            uint ownerPid;
            GetWindowThreadProcessId(ownerHwnd, out ownerPid);
            var ownerClass = new StringBuilder(128);
            GetClassName(ownerHwnd, ownerClass, ownerClass.Capacity);

            var identifier = new NOTIFYICONIDENTIFIER
            {
                cbSize = (uint)Marshal.SizeOf(typeof(NOTIFYICONIDENTIFIER)),
                hWnd = ownerHwnd,
                uID = notifyIconId,
                guidItem = antiGuid,
            };
            RECT rect;
            bool antiGuidRectAvailable = Shell_NotifyIconGetRect(ref identifier, out rect) == 0;
            return new NotificationButtonIdentity
            {
                OwnerWindowHandle = ownerHwndValue,
                OwnerProcessId = ownerPid,
                OwnerWindowClass = ownerClass.ToString(),
                NotifyIconId = notifyIconId,
                AntiGuidRectAvailable = antiGuidRectAvailable,
                RectLeft = antiGuidRectAvailable ? rect.Left : 0,
                RectTop = antiGuidRectAvailable ? rect.Top : 0,
                RectRight = antiGuidRectAvailable ? rect.Right : 0,
                RectBottom = antiGuidRectAvailable ? rect.Bottom : 0,
            };
        }
        finally
        {
            if (remoteButton != IntPtr.Zero) VirtualFreeEx(process, remoteButton, UIntPtr.Zero, MEM_RELEASE);
            CloseHandle(process);
        }
    }
}
'@

$accessibleId = [Guid]"618736E0-3C3D-11CF-810C-00AA00389B71"
$antiTrayGuid = [Guid]"a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3"
$trayItems = New-Object System.Collections.Generic.List[object]
$verifiedTrayItems = New-Object System.Collections.Generic.List[object]

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

        $nativeIdentity = $null
        try {
            $nativeIdentity = [AntiCodexTrayProbe]::ReadNotificationButton($toolbar, $index - 1, $antiTrayGuid)
        } catch {}
        $shellRectMatched = $null -ne $nativeIdentity -and
            $nativeIdentity.AntiGuidRectAvailable -and
            $nativeIdentity.RectLeft -eq $x -and
            $nativeIdentity.RectTop -eq $y -and
            ($nativeIdentity.RectRight - $nativeIdentity.RectLeft) -eq $width -and
            ($nativeIdentity.RectBottom - $nativeIdentity.RectTop) -eq $height
        $ownerPidMatched = $null -ne $nativeIdentity -and [int]$nativeIdentity.OwnerProcessId -eq $ExpectedMainPid
        $ownerClassMatched = $null -ne $nativeIdentity -and $nativeIdentity.OwnerWindowClass -ceq "OwlElectron_NotifyIconHostWindow"
        $verifiedAntiIdentity = $ownerPidMatched -and $ownerClassMatched -and $shellRectMatched

        $trayItem = [pscustomobject]@{
            name = $name
            provider = "MSAA+Shell_NotifyIconGetRect"
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
            expectedMainPid = $ExpectedMainPid
            ownerWindowHandle = if ($nativeIdentity) { [long]$nativeIdentity.OwnerWindowHandle } else { 0 }
            ownerProcessId = if ($nativeIdentity) { [int]$nativeIdentity.OwnerProcessId } else { 0 }
            ownerWindowClass = if ($nativeIdentity) { [string]$nativeIdentity.OwnerWindowClass } else { "" }
            notifyIconId = if ($nativeIdentity) { [long]$nativeIdentity.NotifyIconId } else { 0 }
            notifyIconGuid = $antiTrayGuid.ToString()
            shellNotifyIconRectMatched = $shellRectMatched
            ownerPidMatched = $ownerPidMatched
            ownerWindowClassMatched = $ownerClassMatched
            x = [int]$x
            y = [int]$y
            width = [int]$width
            height = [int]$height
        }
        $trayItems.Add($trayItem) | Out-Null
        if ($verifiedAntiIdentity) { $verifiedTrayItems.Add($trayItem) | Out-Null }
    }
}

if ($trayItems.Count -eq 0) {
    throw "The live Anti-Codex notification-area item was not found."
}
if ($verifiedTrayItems.Count -ne 1) {
    throw "The live Anti-Codex notification-area identity is not uniquely bound to PID $ExpectedMainPid and the Anti-Codex tray GUID (raw=$($trayItems.Count), verified=$($verifiedTrayItems.Count))."
}
$trayItem = $verifiedTrayItems[0]
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
        schema = "anticodex-live-tray-icon-v2"
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
            rawNameCandidateCount = [int]$trayItems.Count
            verifiedAntiCandidateCount = [int]$verifiedTrayItems.Count
            expectedMainPid = [int]$ExpectedMainPid
            ownerWindowHandle = [long]$trayItem.ownerWindowHandle
            ownerProcessId = [int]$trayItem.ownerProcessId
            ownerWindowClass = [string]$trayItem.ownerWindowClass
            notifyIconId = [long]$trayItem.notifyIconId
            notifyIconGuid = [string]$trayItem.notifyIconGuid
            shellNotifyIconRectMatched = [bool]$trayItem.shellNotifyIconRectMatched
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
            expectedMainPidMatched = [bool]$trayItem.ownerPidMatched
            ownerWindowClassMatched = [bool]$trayItem.ownerWindowClassMatched
            antiGuidRectMatched = [bool]$trayItem.shellNotifyIconRectMatched
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
