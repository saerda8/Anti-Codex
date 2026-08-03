[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Anti-Codex"),
    [string]$StateRoot = (Join-Path $env:APPDATA "anticodex\maintenance"),
    [switch]$Start
)

$ErrorActionPreference = "Stop"

function Normalize-AntiCodexPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

$installRootFull = Normalize-AntiCodexPath -Path $InstallRoot
$stateRootFull = Normalize-AntiCodexPath -Path $StateRoot
$expectedInstallRoot = Normalize-AntiCodexPath -Path (Join-Path $env:LOCALAPPDATA "Anti-Codex")
$expectedStateRoot = Normalize-AntiCodexPath -Path (Join-Path $env:APPDATA "anticodex\maintenance")
if (-not $installRootFull.Equals($expectedInstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Anti-Codex MCP leak guard may only target $expectedInstallRoot"
}
if (-not $stateRootFull.Equals($expectedStateRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Anti-Codex MCP leak guard state may only use $expectedStateRoot"
}

$appPath = Join-Path $installRootFull "codex-patched-app\Anti-Codex.exe"
$corePath = Join-Path $installRootFull "codex-patched-app\resources\codex.exe"
$sourcePath = Join-Path $PSScriptRoot "anticodex_mcp_leak_guard.py"
foreach ($requiredPath in @($appPath, $corePath, $sourcePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Anti-Codex MCP leak guard prerequisite is missing: $requiredPath"
    }
}

$pythonw = Get-Command pythonw.exe -ErrorAction Stop | Select-Object -First 1
$pythonwPath = Normalize-AntiCodexPath -Path $pythonw.Source
if ([IO.Path]::GetFileName($pythonwPath) -ine "pythonw.exe") {
    throw "Anti-Codex MCP leak guard requires pythonw.exe"
}

$runtimeRoot = Join-Path $stateRootFull "runtime"
$targetPath = Join-Path $stateRootFull "anticodex_mcp_leak_guard.py"
[IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
$targetHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sourceHash -ne $targetHash) {
    throw "Anti-Codex MCP leak guard copy verification failed"
}

$startupRoot = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
[IO.Directory]::CreateDirectory($startupRoot) | Out-Null
$shortcutPath = Join-Path $startupRoot "Anti-Codex MCP Leak Guard.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pythonwPath
$shortcut.Arguments = "-B `"$targetPath`" --enforce"
$shortcut.WorkingDirectory = $stateRootFull
$shortcut.WindowStyle = 7
$shortcut.IconLocation = "$(Join-Path $installRootFull 'codex-patched-app\resources\icon.ico'),0"
$shortcut.Description = "Protect only Anti-Codex from confirmed excess MCP child processes"
$shortcut.Save()

$started = $false
$guardPid = $null
$escapedTarget = [Regex]::Escape($targetPath)
$running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq "pythonw.exe" -and
    [string]$_.CommandLine -match $escapedTarget -and
    [string]$_.CommandLine -match "(?:^|\s)--enforce(?:\s|$)"
})
if ($Start -and $running.Count -eq 0) {
    $process = Start-Process -FilePath $pythonwPath -ArgumentList @("-B", "`"$targetPath`"", "--enforce") -WorkingDirectory $stateRootFull -WindowStyle Hidden -PassThru
    $guardPid = [int]$process.Id
    $started = $true
} elseif ($running.Count -gt 0) {
    $guardPid = [int]$running[0].ProcessId
}

[pscustomobject]@{
    schema = "anticodex-mcp-leak-guard-install-v1"
    ok = $true
    installRoot = $installRootFull
    stateRoot = $stateRootFull
    guardPath = $targetPath
    guardSha256 = $targetHash
    runtimeRoot = $runtimeRoot
    shortcutPath = $shortcutPath
    mutexName = "Local\AntiCodex.McpLeakGuard"
    started = $started
    processId = $guardPid
} | ConvertTo-Json -Depth 4 -Compress
