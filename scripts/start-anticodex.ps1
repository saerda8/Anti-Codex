#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipUpdateCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Find-AntiCodexLocalAddress {
    if ($env:ANTICODEX_LOCAL_ADDRESS) { return $env:ANTICODEX_LOCAL_ADDRESS }
    return "127.0.0.1"
}

function Get-AntiCodexTranslatorHealth {
    param([string]$Url)
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.WebRequest]::Create("$Url/health")
        $request.Proxy = $null
        $request.Timeout = 2000
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { return $null }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } catch {
        return $null
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Test-AntiCodexTranslatorHealth {
    param([string]$Url)
    $health = Get-AntiCodexTranslatorHealth $Url
    return [bool]($health -and $health.ok)
}

function Test-AntiCodexTranslatorMatchesConfiguredUpstream {
    param([string]$Url, [bool]$UsesAntigravity)
    $health = Get-AntiCodexTranslatorHealth $Url
    if (-not $health -or -not $health.ok) { return $false }
    $profile = $health.upstreamProfile
    if ($UsesAntigravity) {
        return [string]$profile.mode -eq "antigravity"
    }
    if ([string]$profile.mode -ne "third-party") { return $false }
    if ([string]$profile.protocol -ne [string]$env:UPSTREAM_PROTOCOL) { return $false }
    if ([string]$profile.model -ne [string]$env:UPSTREAM_MODEL) { return $false }
    return ([string]$profile.baseUrl).TrimEnd("/") -eq ([string]$env:UPSTREAM_URL).TrimEnd("/")
}

function Activate-AntiCodexWindow {
    param($Process)
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.AppActivate([int]$Process.ProcessId)
    } catch {}
}

function Resolve-AntiCodexInstallRoot {
    $scriptParent = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    return [IO.Path]::GetFullPath((Split-Path -Parent $scriptParent))
}

function Get-RunningAntiCodexMain {
    param([Parameter(Mandatory = $true)][string]$MainExecutable)
    $mainPath = [IO.Path]::GetFullPath($MainExecutable)
    return Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and
        ([IO.Path]::GetFullPath([string]$_.ExecutablePath)) -eq $mainPath -and
        ([string]$_.CommandLine) -notmatch "\s--type="
    } | Select-Object -First 1
}

$installRoot = Resolve-AntiCodexInstallRoot
$mainExecutable = [IO.Path]::GetFullPath((Join-Path $installRoot "codex-patched-app\Anti-Codex.exe"))

# Set independent state directory for Anti-Codex
$env:DEEPCODEX_STATE_ROOT = Join-Path $env:APPDATA "anticodex"
$env:CODEX_HOME_DIR = Join-Path $env:DEEPCODEX_STATE_ROOT "codex-home-deepseek-app"
$env:CODEX_HOME = $env:CODEX_HOME_DIR
$env:GLOBAL_CODEX_HOME = Join-Path $env:USERPROFILE ".codex"
$env:DEEPCODEX_SHARED_CODEX_HOME = $env:GLOBAL_CODEX_HOME
$env:TRANSLATOR_PORT = "8484"
$env:TRANSLATOR_LISTEN_HOST = "127.0.0.1"
$env:DEEPCODEX_CDP_PORT = "58318"
$env:DEEPCODEX_DISABLE_GPU = "1"
$env:DEEPCODEX_DISPLAY_NAME = "Anti-Codex"
$env:DEEPCODEX_SKIP_PLUGIN_SYNC = "1"
$upstreamProfileScript = Join-Path $PSScriptRoot "anticodex-upstream-profile.ps1"
$antiCodexUsesAntigravity = $true
if (Test-Path -LiteralPath $upstreamProfileScript -PathType Leaf) {
    try {
        $runtimeProfile = & $upstreamProfileScript -Action GetRuntime -StateRoot $env:DEEPCODEX_STATE_ROOT | ConvertFrom-Json
        if ($runtimeProfile.mode -eq "third-party" -and $runtimeProfile.baseUrl -and $runtimeProfile.apiKey -and $runtimeProfile.model) {
            $antiCodexUsesAntigravity = $false
            $env:TRANSLATOR_UPSTREAM_MODE = "chat"
            $env:UPSTREAM_PROTOCOL = [string]$runtimeProfile.protocol
            $env:UPSTREAM_URL = [string]$runtimeProfile.baseUrl
            $env:UPSTREAM_MODEL = [string]$runtimeProfile.model
            $env:UPSTREAM_API_KEY = [string]$runtimeProfile.apiKey
            $env:ANTICODEX_ACTIVE_UPSTREAM = "third-party"
            $env:ANTICODEX_NATIVE_TOOL_BRIDGE = "0"
        }
    } catch {
        Write-Error "Anti-Codex upstream profile could not be read; refusing to fall back to Antigravity. Repair the third-party API configuration or explicitly restore Antigravity. $($_.Exception.Message)"
        exit 1
    }
}
if ($antiCodexUsesAntigravity) {
    $env:TRANSLATOR_UPSTREAM_MODE = "antigravity"
    Remove-Item Env:UPSTREAM_API_KEY -ErrorAction SilentlyContinue
    $env:ANTICODEX_ACTIVE_UPSTREAM = "antigravity"
    $env:ANTICODEX_NATIVE_TOOL_BRIDGE = "1"
}
$translatorLoopbackUrl = "http://127.0.0.1:$($env:TRANSLATOR_PORT)"

$runningMain = Get-RunningAntiCodexMain -MainExecutable $mainExecutable
if ($runningMain -and (Test-AntiCodexTranslatorMatchesConfiguredUpstream $translatorLoopbackUrl $antiCodexUsesAntigravity)) {
    Activate-AntiCodexWindow $runningMain
    exit 0
}

$updateChecker = Join-Path $PSScriptRoot "check-anticodex-update.ps1"
if ((-not $SkipUpdateCheck) -and (Test-Path -LiteralPath $updateChecker -PathType Leaf)) {
    try {
        $updateStatus = & $updateChecker -InstallRoot $installRoot -StateRoot $env:DEEPCODEX_STATE_ROOT -Prompt | ConvertFrom-Json
        if ($updateStatus.sync.launched -eq $true) {
            exit 0
        }
    } catch {
        Write-Warning "Anti-Codex update check failed: $($_.Exception.Message)"
    }
}

# Set independent projects directory for Anti-Codex
$env:DEEPCODEX_PROJECTS_ROOT = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "anticodex"

# Set the local URL after the fast already-running path.
$env:TRANSLATOR_HOST = "127.0.0.1"
$env:TRANSLATOR_URL = "http://$($env:TRANSLATOR_HOST):$($env:TRANSLATOR_PORT)"

if ($env:DEEPCODEX_WORKSPACE) {
    $env:ANTICODEX_WORKSPACE = $env:DEEPCODEX_WORKSPACE
}

if ($antiCodexUsesAntigravity) {
    $antigravityDesktopHelper = Join-Path $PSScriptRoot "antigravity-desktop.ps1"
    if (-not (Test-Path -LiteralPath $antigravityDesktopHelper)) {
        Write-Error "Anti-Codex could not find its Antigravity Desktop helper."
        exit 1
    }
    . $antigravityDesktopHelper

    Write-Host "Checking if Antigravity Desktop is running..."
    $antigravityProcess = Get-AntigravityMainProcess
    if ($antigravityProcess) {
        $env:ANTIGRAVITY_DESKTOP_PATH = [string]$antigravityProcess.ExecutablePath
        Write-Host "Antigravity Desktop is already running."
    } else {
        Write-Host "Antigravity Desktop is not running."
        $antigravityPath = Resolve-AntigravityDesktopPath
        if (-not $antigravityPath) {
            Write-Error "Antigravity Desktop is not running, and no installed desktop executable was found. Please start Antigravity Desktop manually."
            exit 1
        }
        $env:ANTIGRAVITY_DESKTOP_PATH = $antigravityPath
        Write-Host "Starting Antigravity Desktop from $antigravityPath..."
        try {
            Start-Process -FilePath $antigravityPath | Out-Null
        } catch {
            Write-Error "Antigravity Desktop could not be started: $($_.Exception.Message)"
            exit 1
        }
        Write-Host "Waiting for Antigravity Desktop to become stable..."
        $startup = Wait-AntigravityDesktopStable -ExecutablePath $antigravityPath -TimeoutSeconds 30 -StableSeconds 8
        if (-not $startup.Stable) {
            Write-Error "Antigravity Desktop did not remain running long enough to start Anti-Codex."
            exit 1
        }
    }
} else {
    Write-Host "Anti-Codex is using a third-party API profile; Antigravity Desktop is not required for this launch."
}

if ($runningMain) {
    $startDeepCodex = Join-Path $PSScriptRoot "start-deepcodex.ps1"
    if (-not (Test-Path -LiteralPath $startDeepCodex)) {
        Write-Error "Could not find start-deepcodex.ps1 at $startDeepCodex"
        exit 1
    }
    if (-not (Test-AntiCodexTranslatorMatchesConfiguredUpstream $translatorLoopbackUrl $antiCodexUsesAntigravity)) {
        Write-Host "Anti-Codex is already open; restarting its local translator only..."
        & $startDeepCodex -TranslatorOnly
        for ($i = 0; $i -lt 20; $i++) {
            if (Test-AntiCodexTranslatorHealth $translatorLoopbackUrl) { break }
            Start-Sleep -Milliseconds 500
        }
    }
    if (Test-AntiCodexTranslatorMatchesConfiguredUpstream $translatorLoopbackUrl $antiCodexUsesAntigravity) {
        Activate-AntiCodexWindow $runningMain
        exit 0
    }
    Write-Error "Anti-Codex is open, but its local translator could not be restored. Please close Anti-Codex and launch it again."
    exit 1
}

# Invoke the underlying DeepCodex launcher
$startDeepCodex = Join-Path $PSScriptRoot "start-deepcodex.ps1"
if (-not (Test-Path -LiteralPath $startDeepCodex)) {
    Write-Error "Could not find start-deepcodex.ps1 at $startDeepCodex"
    exit 1
}

Write-Host "Starting Anti-Codex monitor in the background..."
$launcherOutLog = Join-Path $env:DEEPCODEX_STATE_ROOT "anticodex-launcher.out.log"
$launcherErrLog = Join-Path $env:DEEPCODEX_STATE_ROOT "anticodex-launcher.err.log"
New-Item -ItemType Directory -Path $env:DEEPCODEX_STATE_ROOT -Force | Out-Null
Remove-Item -LiteralPath $launcherOutLog, $launcherErrLog -Force -ErrorAction SilentlyContinue
$startArgs = @(
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", "`"$startDeepCodex`""
)
$watchProc = Start-Process -FilePath powershell.exe `
    -ArgumentList $startArgs `
    -RedirectStandardOutput $launcherOutLog `
    -RedirectStandardError $launcherErrLog `
    -WindowStyle Hidden -PassThru
Write-Host ""
Write-Host "=================================================="
Write-Host "  Anti-Codex launched successfully!"
Write-Host "  Background watcher PID: $($watchProc.Id)"
Write-Host "=================================================="
Write-Host ""
Write-Host "You may close this window. Anti-Codex will continue"
Write-Host "running in the background. It will keep the"
Write-Host "translator alive and restore Antigravity Desktop if"
Write-Host "needed."
Write-Host ""
exit 0
