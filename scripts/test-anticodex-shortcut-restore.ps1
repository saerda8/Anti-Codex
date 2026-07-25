#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ExpectedMainPid,
    [Parameter(Mandatory = $true)]
    [int]$ExpectedOriginalCodexPid,
    [ValidateSet("DesktopShortcut", "TaskbarButton")]
    [string]$ActivationMode = "DesktopShortcut",
    [ValidateNotNullOrEmpty()]
    [string]$TaskbarButtonAutomationName = "Anti-Codex",
    [ValidateRange(1000, 5000)]
    [int]$SampleDurationMs = 3000,
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not ("AntiCodexShortcutRestoreProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public sealed class AntiCodexProcessSnapshot {
    public int[] ProcessIds;
    public int[] RootProcessIds;
    public long[] VisibleTopLevelWindowHandles;
    public int[] VisibleWindowProcessIds;
    public AntiCodexWindowSnapshot[] AllVisibleTopLevelWindows;
    public long[] RawVisibleTopLevelWindowHandles;
}
public sealed class AntiCodexWindowSnapshot {
    public long Handle;
    public int ProcessId;
    public string ClassName;
    public string Title;
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
    public bool Cloaked;
    public bool AuxiliaryWindow;
    public bool Presentable;
    public bool ProductWindow;
}
public static class AntiCodexShortcutRestoreProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct RGBQUAD {
        public byte rgbBlue;
        public byte rgbGreen;
        public byte rgbRed;
        public byte rgbReserved;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO {
        public BITMAPINFOHEADER bmiHeader;
        public RGBQUAD bmiColors;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32 {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT {
        public uint type;
        public INPUTUNION data;
    }
    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
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
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder value, int maxCount);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int width, int height);
    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hDC, IntPtr value);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hDC);
    [DllImport("gdi32.dll")]
    private static extern int SetStretchBltMode(IntPtr hDC, int mode);
    [DllImport("gdi32.dll")]
    private static extern bool StretchBlt(
        IntPtr destination,
        int destinationX,
        int destinationY,
        int destinationWidth,
        int destinationHeight,
        IntPtr source,
        int sourceX,
        int sourceY,
        int sourceWidth,
        int sourceHeight,
        uint rasterOperation);
    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(
        IntPtr hDC,
        IntPtr bitmap,
        uint startScan,
        uint scanLines,
        [Out] byte[] bits,
        ref BITMAPINFO bitmapInfo,
        uint usage);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("oleacc.dll")]
    public static extern int AccessibleObjectFromWindow(
        IntPtr hWnd,
        uint objectId,
        ref Guid interfaceId,
        [In, Out, MarshalAs(UnmanagedType.Interface)] ref object accessibleObject);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hWnd, uint attribute, out int value, int size);

    private static string WindowClass(IntPtr hWnd) {
        var value = new StringBuilder(256);
        return GetClassName(hWnd, value, value.Capacity) > 0 ? value.ToString() : "";
    }

    private static string WindowTitle(IntPtr hWnd) {
        var value = new StringBuilder(Math.Max(1, GetWindowTextLength(hWnd) + 1));
        return GetWindowText(hWnd, value, value.Capacity) > 0 ? value.ToString() : "";
    }

    private static string ProcessPath(uint processId) {
        var process = OpenProcess(0x1000, false, processId);
        if (process == IntPtr.Zero) return "";
        try {
            var path = new StringBuilder(32768);
            uint size = (uint)path.Capacity;
            return QueryFullProcessImageNameW(process, 0, path, ref size) ? path.ToString() : "";
        } finally {
            CloseHandle(process);
        }
    }

    public static AntiCodexProcessSnapshot GetExactProcessSnapshot(string expectedExecutable) {
        var processIds = new List<int>();
        var parents = new Dictionary<int, int>();
        var snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
        if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("Could not enumerate Anti-Codex processes");
        try {
            var entry = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
            if (Process32FirstW(snapshot, ref entry)) {
                do {
                    var path = ProcessPath(entry.th32ProcessID);
                    if (path.Length > 0 && string.Equals(Path.GetFullPath(path), expectedExecutable, StringComparison.OrdinalIgnoreCase)) {
                        var processId = checked((int)entry.th32ProcessID);
                        processIds.Add(processId);
                        parents[processId] = checked((int)entry.th32ParentProcessID);
                    }
                    entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                } while (Process32NextW(snapshot, ref entry));
            }
        } finally {
            CloseHandle(snapshot);
        }
        processIds.Sort();
        var processSet = new HashSet<int>(processIds);
        var roots = new List<int>();
        foreach (var processId in processIds) {
            int parentId;
            if (!parents.TryGetValue(processId, out parentId) || !processSet.Contains(parentId)) roots.Add(processId);
        }
        var visibleHandles = new List<long>();
        var rawVisibleHandles = new List<long>();
        var visibleProcessIds = new HashSet<int>();
        var allVisibleWindows = new List<AntiCodexWindowSnapshot>();
        var virtualLeft = GetSystemMetrics(76);
        var virtualTop = GetSystemMetrics(77);
        var virtualRight = virtualLeft + GetSystemMetrics(78);
        var virtualBottom = virtualTop + GetSystemMetrics(79);
        EnumWindows(delegate (IntPtr hWnd, IntPtr _) {
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (IsWindowVisible(hWnd) && processSet.Contains((int)processId)) {
                rawVisibleHandles.Add(hWnd.ToInt64());
                RECT rect;
                var hasRectangle = GetWindowRect(hWnd, out rect);
                int cloakedValue;
                var cloaked = DwmGetWindowAttribute(hWnd, 14, out cloakedValue, sizeof(int)) == 0 && cloakedValue != 0;
                var className = WindowClass(hWnd);
                var title = WindowTitle(hWnd);
                var width = hasRectangle ? rect.Right - rect.Left : 0;
                var height = hasRectangle ? rect.Bottom - rect.Top : 0;
                var auxiliaryWindow = className == "SoPY_Status"
                    && title.Length == 0
                    && width > 0 && width <= 256
                    && height > 0 && height <= 64;
                var presentable = hasRectangle
                    && rect.Right - rect.Left > 1
                    && rect.Bottom - rect.Top > 1
                    && rect.Left < virtualRight
                    && rect.Right > virtualLeft
                    && rect.Top < virtualBottom
                    && rect.Bottom > virtualTop
                    && !cloaked
                    && !auxiliaryWindow;
                var productWindow = className.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal);
                allVisibleWindows.Add(new AntiCodexWindowSnapshot {
                    Handle = hWnd.ToInt64(),
                    ProcessId = (int)processId,
                    ClassName = className,
                    Title = title,
                    Left = hasRectangle ? rect.Left : 0,
                    Top = hasRectangle ? rect.Top : 0,
                    Right = hasRectangle ? rect.Right : 0,
                    Bottom = hasRectangle ? rect.Bottom : 0,
                    Cloaked = cloaked,
                    AuxiliaryWindow = auxiliaryWindow,
                    Presentable = presentable,
                    ProductWindow = productWindow
                });
                if (presentable) {
                    visibleHandles.Add(hWnd.ToInt64());
                    visibleProcessIds.Add((int)processId);
                }
            }
            return true;
        }, IntPtr.Zero);
        visibleHandles.Sort();
        rawVisibleHandles.Sort();
        allVisibleWindows.Sort(delegate (AntiCodexWindowSnapshot left, AntiCodexWindowSnapshot right) {
            return left.Handle.CompareTo(right.Handle);
        });
        var visiblePids = new List<int>(visibleProcessIds);
        visiblePids.Sort();
        return new AntiCodexProcessSnapshot {
            ProcessIds = processIds.ToArray(),
            RootProcessIds = roots.ToArray(),
            VisibleTopLevelWindowHandles = visibleHandles.ToArray(),
            VisibleWindowProcessIds = visiblePids.ToArray(),
            AllVisibleTopLevelWindows = allVisibleWindows.ToArray(),
            RawVisibleTopLevelWindowHandles = rawVisibleHandles.ToArray()
        };
    }

    public static long[] GetTaskListWindowHandles() {
        var taskLists = new List<long>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr _) {
            var className = WindowClass(hWnd);
            if (className != "Shell_TrayWnd" && className != "Shell_SecondaryTrayWnd") return true;
            EnumChildWindows(hWnd, delegate (IntPtr child, IntPtr __) {
                if (WindowClass(child) == "MSTaskListWClass") taskLists.Add(child.ToInt64());
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
        taskLists.Sort();
        return taskLists.ToArray();
    }

    public static bool SendLeftClick() {
        var inputs = new[] {
            new INPUT { type = 0, data = new INPUTUNION { mouse = new MOUSEINPUT { dwFlags = 0x0002 } } },
            new INPUT { type = 0, data = new INPUTUNION { mouse = new MOUSEINPUT { dwFlags = 0x0004 } } }
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == inputs.Length;
    }

    public static double[] GetScreenGridMetric(int left, int top, int width, int height, int columns, int rows) {
        if (width <= 0 || height <= 0 || columns <= 0 || rows <= 0) return null;
        var screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return null;
        var memory = IntPtr.Zero;
        var bitmap = IntPtr.Zero;
        var previous = IntPtr.Zero;
        try {
            memory = CreateCompatibleDC(screen);
            if (memory == IntPtr.Zero) return null;
            bitmap = CreateCompatibleBitmap(screen, columns, rows);
            if (bitmap == IntPtr.Zero) return null;
            previous = SelectObject(memory, bitmap);
            SetStretchBltMode(memory, 3);
            if (!StretchBlt(memory, 0, 0, columns, rows, screen, left, top, width, height, 0x00CC0020)) return null;
            var bitmapInfo = new BITMAPINFO {
                bmiHeader = new BITMAPINFOHEADER {
                    biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER)),
                    biWidth = columns,
                    biHeight = -rows,
                    biPlanes = 1,
                    biBitCount = 32,
                    biCompression = 0,
                    biSizeImage = (uint)(columns * rows * 4)
                }
            };
            var pixels = new byte[columns * rows * 4];
            if (GetDIBits(memory, bitmap, 0, (uint)rows, pixels, ref bitmapInfo, 0) != rows) return null;
            double sum = 0;
            double sumSquares = 0;
            int dark = 0;
            int samples = 0;
            for (var offset = 0; offset < pixels.Length; offset += 4) {
                    var blue = pixels[offset];
                    var green = pixels[offset + 1];
                    var red = pixels[offset + 2];
                    var luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
                    sum += luminance;
                    sumSquares += luminance * luminance;
                    if (luminance < 245) dark++;
                    samples++;
            }
            if (samples == 0) return null;
            var mean = sum / samples;
            var standardDeviation = Math.Sqrt(Math.Max(0, (sumSquares / samples) - (mean * mean)));
            return new[] { mean, standardDeviation, (double)dark / samples, (double)samples };
        } finally {
            if (previous != IntPtr.Zero && memory != IntPtr.Zero) SelectObject(memory, previous);
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            if (memory != IntPtr.Zero) DeleteDC(memory);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }
}
"@
}

$expectedExecutable = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex\codex-patched-app\Anti-Codex.exe"))
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Anti-Codex.lnk"

function Get-ExactAntiCodexSnapshot {
    $snapshot = [AntiCodexShortcutRestoreProbe]::GetExactProcessSnapshot($expectedExecutable)
    return [pscustomobject]@{
        processIds = @($snapshot.ProcessIds)
        rootProcessIds = @($snapshot.RootProcessIds)
        visibleWindowProcessIds = @($snapshot.VisibleWindowProcessIds)
        visibleTopLevelWindowHandles = @($snapshot.VisibleTopLevelWindowHandles)
        rawVisibleTopLevelWindowHandles = @($snapshot.RawVisibleTopLevelWindowHandles)
        allVisibleTopLevelWindows = @($snapshot.AllVisibleTopLevelWindows)
    }
}

function Get-ForegroundProcessId {
    param([IntPtr]$ForegroundWindowHandle = [IntPtr]::Zero)
    $foregroundWindow = if ($PSBoundParameters.ContainsKey("ForegroundWindowHandle")) {
        $ForegroundWindowHandle
    } else {
        [AntiCodexShortcutRestoreProbe]::GetForegroundWindow()
    }
    if ($foregroundWindow -eq [IntPtr]::Zero) { return 0 }
    [uint32]$foregroundProcessId = 0
    [void][AntiCodexShortcutRestoreProbe]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundProcessId)
    return [int]$foregroundProcessId
}

function Get-ExactAntiCodexTaskbarButton {
    param([string]$ExpectedAutomationName)

    $windowCountSuffix = -join ([char[]]@(0x4E2A, 0x8FD0, 0x884C, 0x7A97, 0x53E3))
    $expectedAccessibleName = "$ExpectedAutomationName - 1 $windowCountSuffix"
    $taskListHandles = @([AntiCodexShortcutRestoreProbe]::GetTaskListWindowHandles())
    if ($taskListHandles.Count -eq 0) {
        throw "Windows taskbar task list was not found; no click was sent"
    }
    $matches = New-Object System.Collections.Generic.List[object]
    foreach ($taskListHandleValue in $taskListHandles) {
        $taskListHandle = [IntPtr][int64]$taskListHandleValue
        $taskListRectangle = New-Object AntiCodexShortcutRestoreProbe+RECT
        if (-not [AntiCodexShortcutRestoreProbe]::GetWindowRect($taskListHandle, [ref]$taskListRectangle)) { continue }
        $interfaceId = [Guid]"618736e0-3c3d-11cf-810c-00aa00389b71"
        $accessible = $null
        $result = [AntiCodexShortcutRestoreProbe]::AccessibleObjectFromWindow(
            $taskListHandle,
            [uint32]4294967292,
            [ref]$interfaceId,
            [ref]$accessible
        )
        if ($result -ne 0 -or $null -eq $accessible) { continue }
        try {
            $childCount = [int]$accessible.accChildCount
        } catch {
            continue
        }
        for ($childId = 1; $childId -le $childCount; $childId++) {
            try {
                $name = [string]$accessible.accName($childId)
                $role = [int]$accessible.accRole($childId)
                $state = [int64]$accessible.accState($childId)
                [int]$left = 0
                [int]$top = 0
                [int]$width = 0
                [int]$height = 0
                $accessible.accLocation([ref]$left, [ref]$top, [ref]$width, [ref]$height, $childId)
                if ($name -cne $expectedAccessibleName -or $role -ne 43) { continue }
                if (($state -band 0x00018001) -ne 0 -or $width -le 1 -or $height -le 1) { continue }
                $right = $left + $width
                $bottom = $top + $height
                if (
                    $left -lt $taskListRectangle.Left -or
                    $top -lt $taskListRectangle.Top -or
                    $right -gt $taskListRectangle.Right -or
                    $bottom -gt $taskListRectangle.Bottom
                ) { continue }
                $clickX = $left + [int][Math]::Floor($width / 2)
                $clickY = $top + [int][Math]::Floor($height / 2)
                $hit = $accessible.accHitTest($clickX, $clickY)
                if ($hit -isnot [int] -or [int]$hit -ne $childId) { continue }
                if ([string]$accessible.accName([int]$hit) -cne $expectedAccessibleName) { continue }
                if ([int]$accessible.accRole([int]$hit) -ne 43) { continue }
                $matches.Add([pscustomobject]@{
                    childId = $childId
                    taskListWindowHandle = [int64]$taskListHandle
                    accessibleName = $name
                    role = $role
                    state = $state
                    left = $left
                    top = $top
                    right = $right
                    bottom = $bottom
                    width = $width
                    height = $height
                    clickX = $clickX
                    clickY = $clickY
                }) | Out-Null
            } catch {
                continue
            }
        }
    }
    if ($matches.Count -ne 1) {
        throw "Expected exactly one enabled on-screen taskbar button named '$expectedAccessibleName', found $($matches.Count); no click was sent"
    }

    $match = $matches[0]
    return [pscustomobject]@{
        evidence = [pscustomobject]@{
            name = $ExpectedAutomationName
            accessibleName = [string]$match.accessibleName
            provider = "MSAA"
            role = [int]$match.role
            state = [int64]$match.state
            childId = [int]$match.childId
            taskListWindowHandle = [int64]$match.taskListWindowHandle
            taskbarClassName = "MSTaskListWClass"
            candidateCount = 1
            isEnabled = $true
            isOffscreen = $false
            hitTestMatched = $true
        }
        rectangle = [pscustomobject]@{
            left = [int]$match.left
            top = [int]$match.top
            right = [int]$match.right
            bottom = [int]$match.bottom
            width = [int]$match.width
            height = [int]$match.height
        }
        clickPoint = [pscustomobject]@{
            x = [int]$match.clickX
            y = [int]$match.clickY
        }
    }
}

function Invoke-TaskbarButtonActualMouseClick {
    param(
        [Parameter(Mandatory = $true)][object]$Target,
        [Parameter(Mandatory = $true)][string]$ExpectedAutomationName,
        [Parameter(Mandatory = $true)][IntPtr]$ExpectedWindowHandle,
        [Parameter(Mandatory = $true)][int]$ExpectedMainPid,
        [Parameter(Mandatory = $true)][Diagnostics.Stopwatch]$Stopwatch
    )

    $savedCursor = New-Object AntiCodexShortcutRestoreProbe+POINT
    if (-not [AntiCodexShortcutRestoreProbe]::GetCursorPos([ref]$savedCursor)) {
        throw "Could not save the current mouse position"
    }
    try {
        if (-not [AntiCodexShortcutRestoreProbe]::SetCursorPos(
            [int]$Target.clickPoint.x - 1,
            [int]$Target.clickPoint.y
        )) {
            throw "Could not nudge the mouse onto the exact Anti-Codex taskbar button"
        }
        if (-not [AntiCodexShortcutRestoreProbe]::SetCursorPos(
            [int]$Target.clickPoint.x,
            [int]$Target.clickPoint.y
        )) {
            throw "Could not move the mouse to the exact Anti-Codex taskbar button"
        }
        Start-Sleep -Milliseconds 40
        $confirmedTarget = Get-ExactAntiCodexTaskbarButton -ExpectedAutomationName $ExpectedAutomationName
        if (
            [int64]$confirmedTarget.evidence.taskListWindowHandle -ne [int64]$Target.evidence.taskListWindowHandle -or
            [int]$confirmedTarget.evidence.childId -ne [int]$Target.evidence.childId -or
            [int]$confirmedTarget.clickPoint.x -ne [int]$Target.clickPoint.x -or
            [int]$confirmedTarget.clickPoint.y -ne [int]$Target.clickPoint.y
        ) {
            throw "Anti-Codex taskbar button changed before activation; no click was sent"
        }
        $confirmedCursor = New-Object AntiCodexShortcutRestoreProbe+POINT
        if (-not [AntiCodexShortcutRestoreProbe]::GetCursorPos([ref]$confirmedCursor)) {
            throw "Could not confirm the Anti-Codex taskbar cursor position"
        }
        if (
            $confirmedCursor.X -ne [int]$Target.clickPoint.x -or
            $confirmedCursor.Y -ne [int]$Target.clickPoint.y
        ) {
            throw "Mouse moved away from the Anti-Codex taskbar button; no click was sent"
        }
        $clickSentAtMs = [int]$Stopwatch.ElapsedMilliseconds
        if (-not [AntiCodexShortcutRestoreProbe]::SendLeftClick()) {
            throw "Windows SendInput did not send the complete Anti-Codex taskbar click"
        }
        $confirmedTarget | Add-Member -NotePropertyName clickSentAtMs -NotePropertyValue $clickSentAtMs
        $confirmedTarget | Add-Member -NotePropertyName savedCursorX -NotePropertyValue ([int]$savedCursor.X)
        $confirmedTarget | Add-Member -NotePropertyName savedCursorY -NotePropertyValue ([int]$savedCursor.Y)
        return $confirmedTarget
    } catch {
        [void][AntiCodexShortcutRestoreProbe]::SetCursorPos($savedCursor.X, $savedCursor.Y)
        throw
    }
}

function Get-MainAppPages {
    param([int]$CdpPort)
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 3
    $targets = if ($response -is [Collections.IEnumerable] -and $response -isnot [string]) {
        @($response.GetEnumerator())
    } else {
        @($response)
    }
    return @($targets | Where-Object {
        [string]$_.type -eq "page" -and
        [string]$_.url -like "app://*" -and
        [string]$_.url -notmatch "initialRoute=%2Favatar-overlay"
    })
}

function Get-AppPageCount {
    param([int]$CdpPort)
    return @(Get-MainAppPages -CdpPort $CdpPort).Count
}

function Get-AppPageIdentity {
    param([int]$CdpPort)
    $pages = @(Get-MainAppPages -CdpPort $CdpPort)
    $target = if ($pages.Count -eq 1) { $pages[0] } else { $null }
    return [pscustomobject]@{
        count = $pages.Count
        targetId = if ($target) { [string]$target.id } else { "" }
        targetUrl = if ($target) { [string]$target.url } else { "" }
    }
}

function Get-FrameMetric {
    param([IntPtr]$WindowHandle)

    $rect = New-Object AntiCodexShortcutRestoreProbe+RECT
    if (-not [AntiCodexShortcutRestoreProbe]::GetWindowRect($WindowHandle, [ref]$rect)) { return $null }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { return $null }

    $metric = [AntiCodexShortcutRestoreProbe]::GetScreenGridMetric(
        $rect.Left,
        $rect.Top,
        $width,
        $height,
        32,
        20
    )
    if ($null -eq $metric -or $metric.Count -ne 4) { return $null }
    return [pscustomobject]@{
        mean = [Math]::Round([double]$metric[0], 2)
        standardDeviation = [Math]::Round([double]$metric[1], 2)
        darkRatio = [Math]::Round([double]$metric[2], 4)
        sampleCount = [int]$metric[3]
    }
}

if (-not (Test-Path -LiteralPath $expectedExecutable -PathType Leaf)) {
    throw "Installed Anti-Codex executable is missing: $expectedExecutable"
}
if ($ActivationMode -eq "DesktopShortcut" -and -not (Test-Path -LiteralPath $desktopShortcut -PathType Leaf)) {
    throw "Desktop Anti-Codex shortcut is missing: $desktopShortcut"
}

$mainProcess = Get-Process -Id $ExpectedMainPid -ErrorAction Stop
$actualMainPath = [IO.Path]::GetFullPath([string]$mainProcess.Path)
if ($actualMainPath -ine $expectedExecutable) {
    throw "Expected main PID $ExpectedMainPid is not the installed Anti-Codex executable"
}
$windowHandle = [IntPtr]$mainProcess.MainWindowHandle
if ($windowHandle -eq [IntPtr]::Zero) { throw "Expected main PID $ExpectedMainPid has no window" }

$health = Invoke-RestMethod -Uri "http://127.0.0.1:18487/anticodex/fixed-route/health" -TimeoutSec 3
$cdpPort = [int]$health.ports.cdp
if ($cdpPort -le 0) { throw "Fixed-route health did not expose the Anti-Codex CDP port" }

$before = Get-ExactAntiCodexSnapshot
$pagesBefore = Get-AppPageCount -CdpPort $cdpPort
$sessionBefore = Get-AppPageIdentity -CdpPort $cdpPort
if (@($before.rootProcessIds).Count -ne 1 -or [int]$before.rootProcessIds[0] -ne $ExpectedMainPid) {
    throw "Initial Anti-Codex root process is not exactly PID $ExpectedMainPid"
}
if (@($before.visibleWindowProcessIds).Count -ne 1 -or [int]$before.visibleWindowProcessIds[0] -ne $ExpectedMainPid) {
    throw "Initial Anti-Codex visible window is not exactly PID $ExpectedMainPid"
}
if (
    @($before.visibleTopLevelWindowHandles).Count -ne 1 -or
    [int64]$before.visibleTopLevelWindowHandles[0] -ne [int64]$windowHandle
) {
    throw "Initial Anti-Codex top-level window is not exactly HWND $([int64]$windowHandle)"
}
if ($pagesBefore -ne 1) { throw "Initial Anti-Codex app page count is $pagesBefore, expected 1" }

$frames = New-Object System.Collections.Generic.List[object]
$seenRootProcessIds = New-Object System.Collections.Generic.HashSet[int]
$seenVisibleTopLevelWindowHandles = New-Object System.Collections.Generic.HashSet[long]
$observedTopLevelWindows = @{}
$maxRootProcessCount = 0
$maxVisibleWindowCount = 0
$maxVisibleTopLevelWindowCount = 0
$maxRawVisibleTopLevelWindowCount = 0
$maxAppPageCount = $pagesBefore
$restoredAtMs = $null
$firstVisibleAtMs = $null
$minimizedObserved = $false
$probeError = $null
$activationModeReport = if ($ActivationMode -eq "TaskbarButton") { "taskbar-button" } else { "desktop-shortcut" }
$actualMouse = $false
$taskbarElementEvidence = $null
$taskbarRectangle = $null
$taskbarClickPoint = $null
$taskbarActivationObserved = $false
$taskbarActivationWaitMs = $null
$taskbarClickSentAtMs = $null
$taskbarCursorHeld = $false
$savedTaskbarCursorX = $null
$savedTaskbarCursorY = $null
$safeCursorX = $null
$safeCursorY = $null
$frameSampleTimes = New-Object System.Collections.Generic.List[int]
$windowStateTransitions = New-Object System.Collections.Generic.List[object]
$lastWindowStateKey = ""
$reminimizedAfterRestore = $false
$frameCaptureOriginMs = $null
$activationSentAtMs = $null
$sampleDeadlineMs = $null
$deadlineState = $null
$probeRecoveryApplied = $false
$stopwatch = $null

try {
    [void][AntiCodexShortcutRestoreProbe]::ShowWindowAsync($windowHandle, 6)
    $minimizeDeadline = [DateTime]::UtcNow.AddSeconds(2)
    while (-not [AntiCodexShortcutRestoreProbe]::IsIconic($windowHandle) -and [DateTime]::UtcNow -lt $minimizeDeadline) {
        Start-Sleep -Milliseconds 20
    }
    $minimizedObserved = [AntiCodexShortcutRestoreProbe]::IsIconic($windowHandle)
    if (-not $minimizedObserved) { throw "Anti-Codex did not enter the minimized state" }

    $taskbarTarget = $null
    if ($ActivationMode -eq "TaskbarButton") {
        $taskbarTarget = Get-ExactAntiCodexTaskbarButton -ExpectedAutomationName $TaskbarButtonAutomationName
        $taskbarElementEvidence = $taskbarTarget.evidence
        $taskbarRectangle = $taskbarTarget.rectangle
        $taskbarClickPoint = $taskbarTarget.clickPoint
    }
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    if ($ActivationMode -eq "TaskbarButton") {
        $taskbarTarget = Invoke-TaskbarButtonActualMouseClick `
            -Target $taskbarTarget `
            -ExpectedAutomationName $TaskbarButtonAutomationName `
            -ExpectedWindowHandle $windowHandle `
            -ExpectedMainPid $ExpectedMainPid `
            -Stopwatch $stopwatch
        $taskbarElementEvidence = $taskbarTarget.evidence
        $taskbarRectangle = $taskbarTarget.rectangle
        $taskbarClickPoint = $taskbarTarget.clickPoint
        $taskbarClickSentAtMs = [int]$taskbarTarget.clickSentAtMs
        $savedTaskbarCursorX = [int]$taskbarTarget.savedCursorX
        $savedTaskbarCursorY = [int]$taskbarTarget.savedCursorY
        $taskbarCursorHeld = $true
        $actualMouse = $true
        $activationSentAtMs = [int]$taskbarClickSentAtMs
    } else {
        $activationSentAtMs = [int]$stopwatch.ElapsedMilliseconds
        Start-Process -FilePath $desktopShortcut | Out-Null
    }
    $sampleDeadlineMs = [int]$activationSentAtMs + $SampleDurationMs
    [long]$nextTopologySampleMs = 0
    while ($stopwatch.ElapsedMilliseconds -lt $sampleDeadlineMs) {
        $isVisible = [AntiCodexShortcutRestoreProbe]::IsWindowVisible($windowHandle)
        $isMinimized = [AntiCodexShortcutRestoreProbe]::IsIconic($windowHandle)
        $foregroundWindowHandle = [AntiCodexShortcutRestoreProbe]::GetForegroundWindow()
        $foregroundProcessId = Get-ForegroundProcessId -ForegroundWindowHandle $foregroundWindowHandle
        $isExactForeground = [int64]$foregroundWindowHandle -eq [int64]$windowHandle
        $observationAtMs = [int]$stopwatch.ElapsedMilliseconds
        if (
            $ActivationMode -eq "TaskbarButton" -and
            -not $taskbarActivationObserved -and
            $isVisible -and
            -not $isMinimized -and
            $isExactForeground
        ) {
            $taskbarActivationObserved = $true
            $taskbarActivationWaitMs = $observationAtMs - [int]$taskbarClickSentAtMs
        }
        $windowStateKey = "$isVisible|$isMinimized|$([int64]$foregroundWindowHandle)|$foregroundProcessId"
        if ($windowStateKey -cne $lastWindowStateKey) {
            $windowStateTransitions.Add([pscustomobject]@{
                elapsedMs = [int]$stopwatch.ElapsedMilliseconds
                visible = [bool]$isVisible
                minimized = [bool]$isMinimized
                foregroundWindowHandle = [int64]$foregroundWindowHandle
                foregroundProcessId = [int]$foregroundProcessId
                exactForeground = [bool]$isExactForeground
            }) | Out-Null
            $lastWindowStateKey = $windowStateKey
        }
        if ($null -ne $restoredAtMs -and $isMinimized) {
            $reminimizedAfterRestore = $true
        }
        if ($isVisible -and -not $isMinimized -and $null -eq $firstVisibleAtMs) {
            $firstVisibleAtMs = $observationAtMs
        }
        if ($null -eq $frameCaptureOriginMs -and $isVisible -and -not $isMinimized -and $isExactForeground) {
            $frameCaptureOriginMs = $observationAtMs
            $restoredAtMs = $observationAtMs
        }

        if ($null -ne $frameCaptureOriginMs -and $isVisible -and -not $isMinimized -and $isExactForeground) {
            $frameStartedAtMs = [int]$stopwatch.ElapsedMilliseconds
            $metric = Get-FrameMetric -WindowHandle $windowHandle
            if ($null -ne $metric) {
                $frameSampleTimes.Add($frameStartedAtMs) | Out-Null
                $frames.Add([pscustomobject]@{
                    elapsedMs = $frameStartedAtMs
                    mean = $metric.mean
                    standardDeviation = $metric.standardDeviation
                    darkRatio = $metric.darkRatio
                    sampleCount = $metric.sampleCount
                }) | Out-Null
            }
        }

        if ($taskbarActivationObserved -and $frames.Count -gt 0 -and $null -eq $safeCursorX) {
            $safeCursorRect = New-Object AntiCodexShortcutRestoreProbe+RECT
            if ([AntiCodexShortcutRestoreProbe]::GetWindowRect($windowHandle, [ref]$safeCursorRect)) {
                $safeCursorX = $safeCursorRect.Left + [int](($safeCursorRect.Right - $safeCursorRect.Left) / 2)
                $safeCursorY = $safeCursorRect.Top + [int](($safeCursorRect.Bottom - $safeCursorRect.Top) / 2)
                [void][AntiCodexShortcutRestoreProbe]::SetCursorPos($safeCursorX, $safeCursorY)
            }
        }

        if ($stopwatch.ElapsedMilliseconds -ge $nextTopologySampleMs) {
            $snapshot = Get-ExactAntiCodexSnapshot
            $rootCount = @($snapshot.rootProcessIds).Count
            $visibleWindowCount = @($snapshot.visibleWindowProcessIds).Count
            $visibleTopLevelWindowCount = @($snapshot.visibleTopLevelWindowHandles).Count
            $rawVisibleTopLevelWindowCount = @($snapshot.rawVisibleTopLevelWindowHandles).Count
            $maxRootProcessCount = [Math]::Max($maxRootProcessCount, $rootCount)
            $maxVisibleWindowCount = [Math]::Max($maxVisibleWindowCount, $visibleWindowCount)
            $maxVisibleTopLevelWindowCount = [Math]::Max($maxVisibleTopLevelWindowCount, $visibleTopLevelWindowCount)
            $maxRawVisibleTopLevelWindowCount = [Math]::Max($maxRawVisibleTopLevelWindowCount, $rawVisibleTopLevelWindowCount)
            foreach ($rootProcessId in @($snapshot.rootProcessIds)) {
                [void]$seenRootProcessIds.Add([int]$rootProcessId)
            }
            foreach ($visibleTopLevelWindowHandle in @($snapshot.visibleTopLevelWindowHandles)) {
                [void]$seenVisibleTopLevelWindowHandles.Add([int64]$visibleTopLevelWindowHandle)
            }
            foreach ($observedWindow in @($snapshot.allVisibleTopLevelWindows)) {
                $observedTopLevelWindows[[string][int64]$observedWindow.Handle] = [pscustomobject]@{
                    handle = [int64]$observedWindow.Handle
                    processId = [int]$observedWindow.ProcessId
                    className = [string]$observedWindow.ClassName
                    title = [string]$observedWindow.Title
                    left = [int]$observedWindow.Left
                    top = [int]$observedWindow.Top
                    right = [int]$observedWindow.Right
                    bottom = [int]$observedWindow.Bottom
                    cloaked = [bool]$observedWindow.Cloaked
                    auxiliaryWindow = [bool]$observedWindow.AuxiliaryWindow
                    presentable = [bool]$observedWindow.Presentable
                    productWindow = [bool]$observedWindow.ProductWindow
                }
            }
            $nextTopologySampleMs = $stopwatch.ElapsedMilliseconds + 90
        }
        Start-Sleep -Milliseconds 5
    }
} catch {
    $probeError = $_.Exception.Message
} finally {
    $deadlineForegroundWindowHandle = [AntiCodexShortcutRestoreProbe]::GetForegroundWindow()
    $deadlineForegroundProcessId = Get-ForegroundProcessId -ForegroundWindowHandle $deadlineForegroundWindowHandle
    $deadlineVisible = [AntiCodexShortcutRestoreProbe]::IsWindowVisible($windowHandle)
    $deadlineMinimized = [AntiCodexShortcutRestoreProbe]::IsIconic($windowHandle)
    $deadlineState = [pscustomobject]@{
        elapsedMs = if ($null -ne $stopwatch) { [int]$stopwatch.ElapsedMilliseconds } else { $null }
        visible = [bool]$deadlineVisible
        minimized = [bool]$deadlineMinimized
        foregroundWindowHandle = [int64]$deadlineForegroundWindowHandle
        foregroundProcessId = [int]$deadlineForegroundProcessId
        exactForeground = [int64]$deadlineForegroundWindowHandle -eq [int64]$windowHandle
    }
    if ($taskbarCursorHeld) {
        [void][AntiCodexShortcutRestoreProbe]::SetCursorPos($savedTaskbarCursorX, $savedTaskbarCursorY)
        $taskbarCursorHeld = $false
    }
    if ($deadlineMinimized) {
        $probeRecoveryApplied = $true
        [void][AntiCodexShortcutRestoreProbe]::ShowWindowAsync($windowHandle, 9)
        [void][AntiCodexShortcutRestoreProbe]::SetForegroundWindow($windowHandle)
    }
}

$after = Get-ExactAntiCodexSnapshot
$pagesAfter = Get-AppPageCount -CdpPort $cdpPort
$maxAppPageCount = [Math]::Max($maxAppPageCount, $pagesAfter)
$sessionAfter = Get-AppPageIdentity -CdpPort $cdpPort
$foregroundAfter = Get-ForegroundProcessId
$originalCodexAlive = $null -ne (Get-Process -Id $ExpectedOriginalCodexPid -ErrorAction SilentlyContinue)
$mainProcessAfter = Get-Process -Id $ExpectedMainPid -ErrorAction SilentlyContinue
$windowHandleAfter = if ($null -ne $mainProcessAfter) { [IntPtr]$mainProcessAfter.MainWindowHandle } else { [IntPtr]::Zero }
$samePid = $null -ne $mainProcessAfter -and [int]$mainProcessAfter.Id -eq $ExpectedMainPid
$sameHwnd = $windowHandleAfter -ne [IntPtr]::Zero -and [int64]$windowHandleAfter -eq [int64]$windowHandle
$sameExecutable = $false
if ($null -ne $mainProcessAfter) {
    try {
        $sameExecutable = [IO.Path]::GetFullPath([string]$mainProcessAfter.Path) -ieq $expectedExecutable
    } catch {
        $sameExecutable = $false
    }
}
$sameCdpTarget = (
    [int]$sessionBefore.count -eq 1 -and
    [int]$sessionAfter.count -eq 1 -and
    [string]$sessionBefore.targetId -eq [string]$sessionAfter.targetId -and
    [string]$sessionBefore.targetUrl -eq [string]$sessionAfter.targetUrl
)
$firstFrame = if ($frames.Count -gt 0) { $frames[0] } else { $null }
[int]$maxSampleIntervalMs = 0
for ($index = 1; $index -lt $frameSampleTimes.Count; $index++) {
    $maxSampleIntervalMs = [Math]::Max(
        $maxSampleIntervalMs,
        [int]$frameSampleTimes[$index] - [int]$frameSampleTimes[$index - 1]
    )
}
$firstFrameDelayMs = if ($null -ne $firstFrame -and $null -ne $frameCaptureOriginMs) {
    [int]$firstFrame.elapsedMs - [int]$frameCaptureOriginMs
} else {
    $null
}
$earlyFrameCount = if ($null -ne $frameCaptureOriginMs) {
    @($frames | Where-Object { [int]$_.elapsedMs -le ([int]$frameCaptureOriginMs + 750) }).Count
} else {
    0
}
$maximumFirstFrameDelayMs = 100
$maximumFrameSampleIntervalMs = 125
$minimumEarlyFrameCount = 8
$blankFrames = @($frames | Where-Object { $_.standardDeviation -lt 5 -or $_.darkRatio -lt 0.005 })
$firstNonBlankFrame = $frames |
    Where-Object { $_.standardDeviation -ge 5 -and $_.darkRatio -ge 0.005 } |
    Select-Object -First 1
$lastBlankFrame = $blankFrames | Select-Object -Last 1
$firstNonBlankFrameDelayMs = if ($null -ne $firstNonBlankFrame -and $null -ne $frameCaptureOriginMs) {
    [int]$firstNonBlankFrame.elapsedMs - [int]$frameCaptureOriginMs
} else {
    $null
}
$lastBlankFrameDelayMs = if ($null -ne $lastBlankFrame -and $null -ne $frameCaptureOriginMs) {
    [int]$lastBlankFrame.elapsedMs - [int]$frameCaptureOriginMs
} else {
    $null
}
$restoreDurationMs = if ($null -ne $firstVisibleAtMs -and $null -ne $activationSentAtMs) {
    [int]$firstVisibleAtMs - [int]$activationSentAtMs
} else {
    $null
}
$earlyFrameTimeline = @()
if ($null -ne $frameCaptureOriginMs) {
    $earlyFrameTimeline = @(
        $frames |
            Where-Object { [int]$_.elapsedMs -le ([int]$frameCaptureOriginMs + 750) } |
            ForEach-Object {
                $frame = $_
                [pscustomobject]@{
                    elapsedMs = [int]$frame.elapsedMs
                    relativeToForegroundMs = [int]$frame.elapsedMs - [int]$frameCaptureOriginMs
                    mean = $frame.mean
                    standardDeviation = $frame.standardDeviation
                    darkRatio = $frame.darkRatio
                    isBlank = ($frame.standardDeviation -lt 5 -or $frame.darkRatio -lt 0.005)
                }
            }
    )
}
$failures = New-Object System.Collections.Generic.List[string]
if ($probeError) { $failures.Add($probeError) | Out-Null }
if (-not $minimizedObserved) { $failures.Add("minimized state was not observed") | Out-Null }
if ($null -eq $restoredAtMs) { $failures.Add("$activationModeReport did not restore and foreground the existing window") | Out-Null }
if ($null -eq $firstVisibleAtMs) { $failures.Add("$activationModeReport did not present the existing window") | Out-Null }
if ($null -eq $deadlineState -or -not $deadlineState.visible -or $deadlineState.minimized -or -not $deadlineState.exactForeground) { $failures.Add("Anti-Codex was not visible, restored, and exactly foreground at the sampling deadline") | Out-Null }
if ($probeRecoveryApplied) { $failures.Add("the restore probe applied recovery after the sampling deadline") | Out-Null }
if ($reminimizedAfterRestore) { $failures.Add("Anti-Codex became minimized again after taskbar restore") | Out-Null }
if (@($after.rootProcessIds).Count -ne 1 -or [int]$after.rootProcessIds[0] -ne $ExpectedMainPid) { $failures.Add("Anti-Codex root process changed") | Out-Null }
if (@($after.visibleWindowProcessIds).Count -ne 1 -or [int]$after.visibleWindowProcessIds[0] -ne $ExpectedMainPid) { $failures.Add("Anti-Codex no longer has exactly one visible main window") | Out-Null }
if (
    @($after.visibleTopLevelWindowHandles).Count -ne 1 -or
    [int64]$after.visibleTopLevelWindowHandles[0] -ne [int64]$windowHandle
) { $failures.Add("Anti-Codex no longer has exactly the original top-level window") | Out-Null }
if (-not $samePid) { $failures.Add("Anti-Codex main PID changed during restore") | Out-Null }
if (-not $sameHwnd) { $failures.Add("Anti-Codex main HWND changed during restore") | Out-Null }
if (-not $sameExecutable) { $failures.Add("Anti-Codex executable identity changed during restore") | Out-Null }
if ($maxRootProcessCount -ne 1) { $failures.Add("a second Anti-Codex root process was observed") | Out-Null }
if ($maxVisibleWindowCount -gt 1) { $failures.Add("a second visible Anti-Codex window was observed") | Out-Null }
if ($maxVisibleTopLevelWindowCount -gt 1) { $failures.Add("a second visible Anti-Codex top-level window was observed") | Out-Null }
if ($maxAppPageCount -ne 1 -or $pagesAfter -ne 1) { $failures.Add("Anti-Codex app page count changed") | Out-Null }
if (
    -not $sessionBefore.targetId -or
    -not $sessionAfter.targetId -or
    [string]$sessionBefore.targetId -ne [string]$sessionAfter.targetId
) { $failures.Add("Anti-Codex CDP page session changed") | Out-Null }
if (-not $sameCdpTarget) { $failures.Add("Anti-Codex CDP target identity changed during restore") | Out-Null }
if ($frames.Count -lt 2) { $failures.Add("fewer than two restored Anti-Codex frames were sampled") | Out-Null }
if ($null -eq $firstFrameDelayMs -or $firstFrameDelayMs -gt $maximumFirstFrameDelayMs) { $failures.Add("the first restored frame was not sampled within $maximumFirstFrameDelayMs ms") | Out-Null }
if ($maxSampleIntervalMs -le 0 -or $maxSampleIntervalMs -gt $maximumFrameSampleIntervalMs) { $failures.Add("restored frame sampling exceeded the $maximumFrameSampleIntervalMs ms cadence") | Out-Null }
if ($earlyFrameCount -lt $minimumEarlyFrameCount) { $failures.Add("fewer than $minimumEarlyFrameCount frames were sampled in the first 750 ms") | Out-Null }
if ($blankFrames.Count -gt 0) { $failures.Add("a blank or near-blank restored frame was observed") | Out-Null }
if ($ActivationMode -eq "TaskbarButton" -and -not $actualMouse) { $failures.Add("taskbar button was not activated with a real mouse click") | Out-Null }
if ($ActivationMode -eq "TaskbarButton" -and -not $taskbarActivationObserved) { $failures.Add("taskbar button click did not foreground the restored Anti-Codex window while the cursor was held") | Out-Null }
if (-not $originalCodexAlive) { $failures.Add("original Codex exited during shortcut restore") | Out-Null }

$checkedAt = [DateTime]::UtcNow.ToString("o")
$probeId = [guid]::NewGuid().ToString("N")
$codexPlusPlusPid = @($health.processes.codexPlusPlus)[0]
$reportLatest = Join-Path $ReportRoot "latest-shortcut-restore.json"
$reportHistory = Join-Path $ReportRoot "$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff'))-shortcut-restore-$probeId.json"
$result = [ordered]@{
    ok = $failures.Count -eq 0
    schema = "anticodex-shortcut-restore-acceptance-v1"
    generatedAt = $checkedAt
    checkedAt = $checkedAt
    probeId = $probeId
    requestedRealTraffic = $false
    usedRealTraffic = $false
    failures = $failures.ToArray()
    expectedMainPid = $ExpectedMainPid
    expectedOriginalCodexPid = $ExpectedOriginalCodexPid
    activationMode = $activationModeReport
    actualMouse = $actualMouse
    taskbarElement = $taskbarElementEvidence
    taskbarRectangle = $taskbarRectangle
    taskbarClickPoint = $taskbarClickPoint
    taskbarActivationObserved = $taskbarActivationObserved
    taskbarActivationWaitMs = $taskbarActivationWaitMs
    taskbarClickSentAtMs = $taskbarClickSentAtMs
    frameCaptureOrigin = "exact-foreground-window"
    frameCaptureOriginMs = $frameCaptureOriginMs
    activationSentAtMs = $activationSentAtMs
    sampleDeadlineMs = $sampleDeadlineMs
    deadlineState = $deadlineState
    probeRecoveryApplied = $probeRecoveryApplied
    visibleWindowCriterion = "presentable-exact-executable-v1"
    minimizedObserved = $minimizedObserved
    reminimizedAfterRestore = $reminimizedAfterRestore
    windowStateTransitions = $windowStateTransitions.ToArray()
    firstVisibleAtMs = $firstVisibleAtMs
    restoredAtMs = $restoredAtMs
    windowHandleBefore = [int64]$windowHandle
    windowHandleAfter = [int64]$windowHandleAfter
    samePid = $samePid
    sameHwnd = $sameHwnd
    sameExecutable = $sameExecutable
    sameCdpTarget = $sameCdpTarget
    before = $before
    after = $after
    seenRootProcessIds = @($seenRootProcessIds | Sort-Object)
    seenVisibleTopLevelWindowHandles = @($seenVisibleTopLevelWindowHandles | Sort-Object)
    observedTopLevelWindows = @($observedTopLevelWindows.Values | Sort-Object handle)
    maxRootProcessCount = $maxRootProcessCount
    maxVisibleWindowCount = $maxVisibleWindowCount
    maxVisibleTopLevelWindowCount = $maxVisibleTopLevelWindowCount
    maxRawVisibleTopLevelWindowCount = $maxRawVisibleTopLevelWindowCount
    appPagesBefore = $pagesBefore
    appPagesAfter = $pagesAfter
    maxAppPageCount = $maxAppPageCount
    foregroundAfter = $foregroundAfter
    frameCount = $frames.Count
    blankFrameCount = $blankFrames.Count
    firstFrame = $firstFrame
    firstFrameDelayMs = $firstFrameDelayMs
    firstNonBlankFrame = $firstNonBlankFrame
    firstNonBlankFrameDelayMs = $firstNonBlankFrameDelayMs
    lastBlankFrame = $lastBlankFrame
    lastBlankFrameDelayMs = $lastBlankFrameDelayMs
    restoreDurationMs = $restoreDurationMs
    earlyFrameTimeline = $earlyFrameTimeline
    maxSampleIntervalMs = $maxSampleIntervalMs
    earlyFrameCount = $earlyFrameCount
    frameSamplingThresholds = [pscustomobject]@{
        maximumFirstFrameDelayMs = $maximumFirstFrameDelayMs
        maximumFrameSampleIntervalMs = $maximumFrameSampleIntervalMs
        minimumEarlyFrameCount = $minimumEarlyFrameCount
        earlyWindowMs = 750
    }
    minimumFrameStandardDeviation = if ($frames.Count -gt 0) { [Math]::Round((($frames | Measure-Object standardDeviation -Minimum).Minimum), 2) } else { $null }
    minimumFrameDarkRatio = if ($frames.Count -gt 0) { [Math]::Round((($frames | Measure-Object darkRatio -Minimum).Minimum), 4) } else { $null }
    originalCodexAlive = $originalCodexAlive
    sampleDurationMs = $SampleDurationMs
    processIdentity = [pscustomobject]@{
        supervisorPid = [int]$health.pid
        codexPlusPlusPid = [int]$codexPlusPlusPid
        antiCodexMainPid = $ExpectedMainPid
        originalCodexPid = $ExpectedOriginalCodexPid
        originalCodexAlive = $originalCodexAlive
    }
    sessionIdentity = [pscustomobject]@{
        cdpPort = $cdpPort
        targetId = [string]$sessionAfter.targetId
        targetUrl = [string]$sessionAfter.targetUrl
    }
    report = [pscustomobject]@{
        latest = $reportLatest
        history = $reportHistory
    }
}

$json = $result | ConvertTo-Json -Depth 8
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
Write-AntiCodexJsonReport -LatestPath $reportLatest -HistoryPath $reportHistory -Json $json -Encoding $utf8NoBom
Write-Output $json
if (-not $result.ok) { exit 1 }
