#Requires -Version 5.1
param([switch]$TranslatorOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
$expectedAntiCodexRuntime = Join-Path (Join-Path $env:LOCALAPPDATA "Anti-Codex") "runtime"
$IS_ANTICODEX_INSTALL_ROOT = $false
try {
    $IS_ANTICODEX_INSTALL_ROOT = [IO.Path]::GetFullPath($ROOT).TrimEnd('\') -ieq [IO.Path]::GetFullPath($expectedAntiCodexRuntime).TrimEnd('\')
} catch {
    $IS_ANTICODEX_INSTALL_ROOT = $false
}
$DEEPCODEX_STATE_ROOT = if ($env:DEEPCODEX_STATE_ROOT) {
    $env:DEEPCODEX_STATE_ROOT
} elseif ($IS_ANTICODEX_INSTALL_ROOT) {
    Join-Path $env:APPDATA "anticodex"
} else {
    Join-Path $env:APPDATA "deepcodex"
}
$CODEX_HOME_DIR = if ($env:CODEX_HOME_DIR) { $env:CODEX_HOME_DIR } else { Join-Path $DEEPCODEX_STATE_ROOT "codex-home-deepseek-app" }
$ELECTRON_USER_DATA = if ($env:ELECTRON_USER_DATA) { $env:ELECTRON_USER_DATA } else { Join-Path $CODEX_HOME_DIR "electron-user-data-adaptive" }
$DEEPCODEX_PROJECTS_ROOT = if ($env:DEEPCODEX_PROJECTS_ROOT) { $env:DEEPCODEX_PROJECTS_ROOT } else { Join-Path ([Environment]::GetFolderPath("MyDocuments")) "deepcodex" }
$DEEPCODEX_WORKSPACE = if ($env:DEEPCODEX_WORKSPACE) { $env:DEEPCODEX_WORKSPACE } else { "" }
$TRANSLATOR_PORT = if ($env:TRANSLATOR_PORT) { [int]$env:TRANSLATOR_PORT } else { 8282 }
$TRANSLATOR_URL = if ($env:TRANSLATOR_URL) { $env:TRANSLATOR_URL } else { "http://127.0.0.1:$TRANSLATOR_PORT" }
$TRANSLATOR_LOG = if ($env:TRANSLATOR_LOG) { $env:TRANSLATOR_LOG } else { Join-Path $DEEPCODEX_STATE_ROOT "adaptive-translator.log" }
$TRANSLATOR_ERR_LOG = if ($env:TRANSLATOR_ERR_LOG) { $env:TRANSLATOR_ERR_LOG } else { Join-Path $DEEPCODEX_STATE_ROOT "adaptive-translator.err.log" }
$TRANSLATOR_START_LOG = Join-Path $DEEPCODEX_STATE_ROOT "adaptive-translator-start.log"
$TRANSLATOR_HEALTH_TIMEOUT_MS = if ($env:TRANSLATOR_HEALTH_TIMEOUT_MS) { [int]$env:TRANSLATOR_HEALTH_TIMEOUT_MS } else { 12000 }
$TRANSLATOR_HEALTH_FAILURE_THRESHOLD = if ($env:TRANSLATOR_HEALTH_FAILURE_THRESHOLD) { [int]$env:TRANSLATOR_HEALTH_FAILURE_THRESHOLD } else { 3 }
$TRANSLATOR_HEALTH_RETRY_DELAY_MS = if ($env:TRANSLATOR_HEALTH_RETRY_DELAY_MS) { [int]$env:TRANSLATOR_HEALTH_RETRY_DELAY_MS } else { 1000 }
$ANTICODEX_TRANSLATOR_BUSY_PATH = if ($env:ANTICODEX_TRANSLATOR_BUSY_PATH) { $env:ANTICODEX_TRANSLATOR_BUSY_PATH } else { Join-Path $DEEPCODEX_STATE_ROOT "translator-busy.json" }
$ANTICODEX_TRANSLATOR_BUSY_MAX_AGE_SECONDS = if ($env:ANTICODEX_TRANSLATOR_BUSY_MAX_AGE_SECONDS) { [int]$env:ANTICODEX_TRANSLATOR_BUSY_MAX_AGE_SECONDS } else { 900 }
$ANTICODEX_TRANSLATOR_BUSY_HEALTH_GRACE_SECONDS = if ($env:ANTICODEX_TRANSLATOR_BUSY_HEALTH_GRACE_SECONDS) { [int]$env:ANTICODEX_TRANSLATOR_BUSY_HEALTH_GRACE_SECONDS } else { 900 }
$ANTICODEX_TRANSLATOR_RESTART_LOCK_PATH = if ($env:ANTICODEX_TRANSLATOR_RESTART_LOCK_PATH) { $env:ANTICODEX_TRANSLATOR_RESTART_LOCK_PATH } else { Join-Path $DEEPCODEX_STATE_ROOT "translator-restart.lock" }
$ANTICODEX_TRANSLATOR_RESTART_LOCK_MAX_AGE_SECONDS = if ($env:ANTICODEX_TRANSLATOR_RESTART_LOCK_MAX_AGE_SECONDS) { [int]$env:ANTICODEX_TRANSLATOR_RESTART_LOCK_MAX_AGE_SECONDS } else { 180 }
$DEEP_CODEX_ENV_FILE = if ($env:DEEP_CODEX_ENV_FILE) { $env:DEEP_CODEX_ENV_FILE } else { Join-Path $DEEPCODEX_STATE_ROOT ".deepcodex.env" }
$SETUP_OUT_LOG = Join-Path $DEEPCODEX_STATE_ROOT ".deepcodex-setup-last.out.log"
$SETUP_ERR_LOG = Join-Path $DEEPCODEX_STATE_ROOT ".deepcodex-setup-last.err.log"
$SETUP_UI_SCRIPT = Join-Path $ROOT "scripts\deepcodex-setup-ui.mjs"
$PROVIDER_PROFILE_PATH = if ($env:DEEPCODEX_PROVIDER_PROFILE) { $env:DEEPCODEX_PROVIDER_PROFILE } else { Join-Path $CODEX_HOME_DIR "provider-profile.json" }
$GLOBAL_CODEX_HOME = if ($env:GLOBAL_CODEX_HOME) { $env:GLOBAL_CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$SHARED_CONFIG_SYNC = Join-Path $ROOT "scripts\sync-shared-codex-config.mjs"
$DEEPCODEX_REGISTRATION_SYNC = Join-Path $ROOT "scripts\sync-deepcodex-plugin-registrations.mjs"
$PLUGIN_HOST_SYNC = Join-Path $ROOT "scripts\sync-shared-codex-plugin-host.mjs"
$DEEPCODEX_PLUGINS_SYNC = Join-Path $ROOT "scripts\sync-deepcodex-plugins.mjs"
$DEEPCODEX_APP_TOOLS_SYNC = Join-Path $ROOT "scripts\sync-deepcodex-app-tools.mjs"
$DEEPCODEX_SIDECARS_SYNC = Join-Path $ROOT "scripts\sync-shared-codex-sidecars.mjs"
$PROTECT_ANTICODEX_LOG_DB = Join-Path $ROOT "scripts\protect-anticodex-log-db.mjs"
$ANTIGRAVITY_MODEL_CATALOG_SYNC = Join-Path $ROOT "translator\sync-antigravity-model-catalog.mjs"
$DEEPCODEX_CDP_INJECT = Join-Path $ROOT "scripts\deepcodex-cdp-inject.mjs"
$DEEPCODEX_PLUGIN_UNLOCK_INJECT = Join-Path $ROOT "scripts\deepcodex-plugin-unlock-inject.js"
$ANTICODEX_MANAGER_INJECT = Join-Path $ROOT "scripts\anticodex-manager-inject.js"
$ANTICODEX_MANAGER_BRIDGE = Join-Path $ROOT "scripts\anticodex-manager-bridge.mjs"
$DEEPCODEX_CDP_LOG = Join-Path $DEEPCODEX_STATE_ROOT "deepcodex-cdp-inject.log"
$DEEPCODEX_CDP_ERR_LOG = Join-Path $DEEPCODEX_STATE_ROOT "deepcodex-cdp-inject.err.log"
$ANTICODEX_MANAGER_CDP_LOG = Join-Path $DEEPCODEX_STATE_ROOT "anticodex-manager-cdp-inject.log"
$ANTICODEX_MANAGER_CDP_ERR_LOG = Join-Path $DEEPCODEX_STATE_ROOT "anticodex-manager-cdp-inject.err.log"
$ANTICODEX_MANAGER_BRIDGE_LOG = Join-Path $DEEPCODEX_STATE_ROOT "anticodex-manager-bridge.log"
$ANTICODEX_MANAGER_BRIDGE_ERR_LOG = Join-Path $DEEPCODEX_STATE_ROOT "anticodex-manager-bridge.err.log"
$DEEPCODEX_CDP_PORT = if ($env:DEEPCODEX_CDP_PORT) { [int]$env:DEEPCODEX_CDP_PORT } else { 58317 }
$DEEPCODEX_PLUGIN_UNLOCK = if ($env:DEEPCODEX_PLUGIN_UNLOCK) { $env:DEEPCODEX_PLUGIN_UNLOCK } else { "0" }
$ANTICODEX_UNSAFE_PLUGIN_UNLOCK = if ($env:ANTICODEX_UNSAFE_PLUGIN_UNLOCK) { $env:ANTICODEX_UNSAFE_PLUGIN_UNLOCK -eq "1" } else { $false }
$DEEPCODEX_PLUGIN_UNLOCK_ENABLED = ($DEEPCODEX_PLUGIN_UNLOCK -ne "0") -and $ANTICODEX_UNSAFE_PLUGIN_UNLOCK
$CONFIG_TEMPLATE_PATH = if ($env:DEEPCODEX_CONFIG_TEMPLATE) { $env:DEEPCODEX_CONFIG_TEMPLATE } else { Join-Path $ROOT "codex-home-deepseek-app\config.adaptive-oneapi.toml" }
$MODEL_CATALOG_TEMPLATE_PATH = if ($env:DEEPCODEX_MODEL_CATALOG_TEMPLATE) { $env:DEEPCODEX_MODEL_CATALOG_TEMPLATE } else { Join-Path $ROOT "codex-home-deepseek-app\deepseek-model-catalog.json" }
$DEEPCODEX_DISPLAY_NAME = if ($env:DEEPCODEX_DISPLAY_NAME) { $env:DEEPCODEX_DISPLAY_NAME } else { -join ([char[]](23044, 32769, 24072, 35828, 30340, 23545)) }
$DEEPCODEX_ACCOUNT_EMAIL = if ($env:DEEPCODEX_ACCOUNT_EMAIL) { $env:DEEPCODEX_ACCOUNT_EMAIL } else { "deepcodex@local" }
$LOCAL_CODEX_API_KEY = if ($env:LOCAL_CODEX_API_KEY) { $env:LOCAL_CODEX_API_KEY } else { "sk-codex-deepseek-local" }
$ANTICODEX_UPSTREAM_PROFILE_SCRIPT = Join-Path $PSScriptRoot "anticodex-upstream-profile.ps1"
if ($IS_ANTICODEX_INSTALL_ROOT -and (Test-Path -LiteralPath $ANTICODEX_UPSTREAM_PROFILE_SCRIPT -PathType Leaf)) {
    try {
        $runtimeProfile = & $ANTICODEX_UPSTREAM_PROFILE_SCRIPT -Action GetRuntime -StateRoot $DEEPCODEX_STATE_ROOT | ConvertFrom-Json
        if ($runtimeProfile.mode -eq "third-party" -and $runtimeProfile.baseUrl -and $runtimeProfile.apiKey -and $runtimeProfile.model) {
            $env:TRANSLATOR_UPSTREAM_MODE = "chat"
            $env:UPSTREAM_PROTOCOL = [string]$runtimeProfile.protocol
            $env:UPSTREAM_URL = [string]$runtimeProfile.baseUrl
            $env:UPSTREAM_MODEL = [string]$runtimeProfile.model
            $env:UPSTREAM_API_KEY = [string]$runtimeProfile.apiKey
            $env:ANTICODEX_ACTIVE_UPSTREAM = "third-party"
            $env:ANTICODEX_NATIVE_TOOL_BRIDGE = "0"
        } else {
            $env:TRANSLATOR_UPSTREAM_MODE = "antigravity"
            Remove-Item Env:UPSTREAM_API_KEY -ErrorAction SilentlyContinue
            $env:ANTICODEX_ACTIVE_UPSTREAM = "antigravity"
            $env:ANTICODEX_NATIVE_TOOL_BRIDGE = "1"
        }
    } catch {
        throw "Anti-Codex upstream profile could not be read; refusing silent Antigravity fallback. $($_.Exception.Message)"
    }
}
$IS_ANTIGRAVITY_MODE = $env:TRANSLATOR_UPSTREAM_MODE -eq "antigravity" -or $IS_ANTICODEX_INSTALL_ROOT
if ($IS_ANTIGRAVITY_MODE -and -not $env:TRANSLATOR_UPSTREAM_MODE) {
    $env:TRANSLATOR_UPSTREAM_MODE = "antigravity"
}
if ($IS_ANTIGRAVITY_MODE -and -not $env:ANTICODEX_NATIVE_TOOL_BRIDGE) {
    $env:ANTICODEX_NATIVE_TOOL_BRIDGE = "1"
}
$USES_ANTIGRAVITY_UPSTREAM = $env:TRANSLATOR_UPSTREAM_MODE -eq "antigravity"

function Update-AntiCodexUpstreamEnvironment {
    if (-not $IS_ANTICODEX_INSTALL_ROOT -or -not (Test-Path -LiteralPath $ANTICODEX_UPSTREAM_PROFILE_SCRIPT -PathType Leaf)) {
        return
    }
    try {
        $runtimeProfile = & $ANTICODEX_UPSTREAM_PROFILE_SCRIPT -Action GetRuntime -StateRoot $DEEPCODEX_STATE_ROOT | ConvertFrom-Json
        if ($runtimeProfile.mode -eq "third-party" -and $runtimeProfile.baseUrl -and $runtimeProfile.apiKey -and $runtimeProfile.model) {
            $env:TRANSLATOR_UPSTREAM_MODE = "chat"
            $env:UPSTREAM_PROTOCOL = [string]$runtimeProfile.protocol
            $env:UPSTREAM_URL = [string]$runtimeProfile.baseUrl
            $env:UPSTREAM_MODEL = [string]$runtimeProfile.model
            $env:UPSTREAM_API_KEY = [string]$runtimeProfile.apiKey
            $env:ANTICODEX_ACTIVE_UPSTREAM = "third-party"
            $env:ANTICODEX_NATIVE_TOOL_BRIDGE = "0"
            $script:USES_ANTIGRAVITY_UPSTREAM = $false
        } else {
            $env:TRANSLATOR_UPSTREAM_MODE = "antigravity"
            Remove-Item Env:UPSTREAM_API_KEY -ErrorAction SilentlyContinue
            Remove-Item Env:UPSTREAM_PROTOCOL -ErrorAction SilentlyContinue
            Remove-Item Env:UPSTREAM_MODEL -ErrorAction SilentlyContinue
            $env:ANTICODEX_ACTIVE_UPSTREAM = "antigravity"
            $env:ANTICODEX_NATIVE_TOOL_BRIDGE = "1"
            $script:USES_ANTIGRAVITY_UPSTREAM = $true
        }
    } catch {
        Write-LifecycleLog "Could not refresh upstream profile before translator start; refusing silent Antigravity fallback: $($_.Exception.Message)"
        throw
    }
}

$DEEPCODEX_SKIP_PLUGIN_SYNC = if ($env:DEEPCODEX_SKIP_PLUGIN_SYNC) { $env:DEEPCODEX_SKIP_PLUGIN_SYNC -ne "0" } else { $IS_ANTIGRAVITY_MODE }
$env:CODEX_HOME_DIR = $CODEX_HOME_DIR
$env:CODEX_HOME = $CODEX_HOME_DIR
$env:GLOBAL_CODEX_HOME = $GLOBAL_CODEX_HOME
$env:DEEPCODEX_SHARED_CODEX_HOME = $GLOBAL_CODEX_HOME
$TRANSLATOR_PROC = $null
$PRESERVE_TRANSLATOR_ON_EXIT = $false
$DEEPCODEX_START_MUTEX = $null
$DEEPCODEX_START_MUTEX_HELD = $false
$ANTIGRAVITY_DESKTOP_HELPER = Join-Path $PSScriptRoot "antigravity-desktop.ps1"
$ANTICODEX_STARTUP_SNAPSHOT_MARKER = Join-Path $CODEX_HOME_DIR ".anticodex-startup-snapshots-ready.json"
$ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS = if ($env:ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS) { [double]$env:ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS } else { 24.0 }
$ANTICODEX_HOST_SYNC_MARKER = if ($env:ANTICODEX_HOST_SYNC_MARKER) {
    $env:ANTICODEX_HOST_SYNC_MARKER
} else {
    Join-Path $DEEPCODEX_STATE_ROOT "host-sync.lock"
}

function Write-LifecycleLog {
    param([string]$Message)
    try {
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $logPath = Join-Path $DEEPCODEX_STATE_ROOT "deepcodex-lifecycle.log"
        "$stamp $Message" | Add-Content -LiteralPath $logPath -Encoding utf8
    } catch {}
}

function New-LaunchStageTimer {
    return [Diagnostics.Stopwatch]::StartNew()
}

function Write-LaunchStage {
    param([string]$Name, $Timer)
    try {
        if ($Timer) { $Timer.Stop() }
        $elapsed = if ($Timer) { [int]$Timer.ElapsedMilliseconds } else { 0 }
        Write-LifecycleLog "launch stage: $Name took ${elapsed}ms."
    } catch {}
}

function Set-AntiCodexRustLogDefaults {
    if (-not $IS_ANTIGRAVITY_MODE) { return }
    $safeDefault = "info"
    if ($env:RUST_LOG -and ($env:RUST_LOG -notmatch "(?i)(^|,|\s)trace($|,|\s|=)")) {
        $safeDefault = $env:RUST_LOG
    }
    if ($safeDefault -notmatch "codex_app_server_transport::transport::remote_control::websocket") {
        $safeDefault = "$safeDefault,codex_app_server_transport::transport::remote_control::websocket=warn"
    }
    $env:RUST_LOG = $safeDefault
}

function Protect-AntiCodexLogDb {
    if (-not $IS_ANTIGRAVITY_MODE) { return $true }
    Set-AntiCodexRustLogDefaults
    if (-not (Test-Path -LiteralPath $PROTECT_ANTICODEX_LOG_DB -PathType Leaf)) {
        Write-LifecycleLog "Anti-Codex log database guard is missing: $PROTECT_ANTICODEX_LOG_DB"
        return $false
    }
    try {
        $output = & $NODE_BIN $PROTECT_ANTICODEX_LOG_DB --codex-home $CODEX_HOME_DIR 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-LifecycleLog "Anti-Codex log database guard failed with exit code $LASTEXITCODE. $output"
            return $false
        }
        Write-LifecycleLog "Anti-Codex log database guard applied."
        return $true
    } catch {
        Write-LifecycleLog "Anti-Codex log database guard failed: $($_.Exception.Message)"
        return $false
    }
}

if (Test-Path -LiteralPath $ANTIGRAVITY_DESKTOP_HELPER) {
    . $ANTIGRAVITY_DESKTOP_HELPER
} elseif ($USES_ANTIGRAVITY_UPSTREAM) {
    throw "Antigravity Desktop helper is missing: $ANTIGRAVITY_DESKTOP_HELPER"
}

if (-not $TranslatorOnly) {
    try {
        $mutexName = "Local\DeepCodexStart_" + ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ROOT)) -replace "[^A-Za-z0-9]", "")
        $DEEPCODEX_START_MUTEX = New-Object System.Threading.Mutex($true, $mutexName, [ref]$DEEPCODEX_START_MUTEX_HELD)
        if (-not $DEEPCODEX_START_MUTEX_HELD) {
            Write-Host "Anti-Codex is already starting or running."
            exit 0
        }
    } catch {}
}

function Show-Alert {
    param([string]$Message)
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [System.Windows.Forms.MessageBox]::Show($Message, "Anti-Codex", "OK", "Warning") | Out-Null
    } catch {
        Write-Warning $Message
    }
}

function Wait-AntiCodexChildProcess {
    param(
        [Diagnostics.Process]$Process,
        [int]$TimeoutMs,
        [int]$PollMs = 200
    )
    if (-not $Process) { return $true }
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(1, $TimeoutMs))
    while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds ([Math]::Max(50, $PollMs))
        try { $Process.Refresh() } catch {}
    }
    return [bool]$Process.HasExited
}

function Find-AntiCodexLocalAddress {
    if ($env:ANTICODEX_LOCAL_ADDRESS) { return $env:ANTICODEX_LOCAL_ADDRESS }
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' -and
            -not $_.SkipAsSource
        })
    $preferred = $addresses | Sort-Object @{
        Expression = {
            if ($_.IPAddress -like "192.168.*") { 0 }
            elseif ($_.IPAddress -like "10.*") { 1 }
            else { 2 }
        }
    }, InterfaceMetric | Select-Object -First 1
    if ($preferred) { return $preferred.IPAddress }
    return "127.0.0.1"
}

function Set-AntiCodexTranslatorEndpointDefaults {
    if (-not $IS_ANTIGRAVITY_MODE) { return }
    if (-not $env:TRANSLATOR_PORT) {
        $script:TRANSLATOR_PORT = 8484
        $env:TRANSLATOR_PORT = "8484"
    }
    if (-not $env:TRANSLATOR_HOST) {
        $env:TRANSLATOR_HOST = Find-AntiCodexLocalAddress
    }
    if (-not $env:TRANSLATOR_URL) {
        $script:TRANSLATOR_URL = "http://$($env:TRANSLATOR_HOST):$($env:TRANSLATOR_PORT)"
        $env:TRANSLATOR_URL = $script:TRANSLATOR_URL
    } else {
        $script:TRANSLATOR_URL = $env:TRANSLATOR_URL
    }
    if (-not $env:TRANSLATOR_LISTEN_HOST) {
        $env:TRANSLATOR_LISTEN_HOST = "127.0.0.1"
    }
}

Set-AntiCodexTranslatorEndpointDefaults

function Find-NodeBin {
    if ($env:NODE_BIN -and (Test-Path -LiteralPath $env:NODE_BIN)) { return $env:NODE_BIN }
    $found = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $codexBinRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    if (Test-Path -LiteralPath $codexBinRoot) {
        $candidate = Get-ChildItem -LiteralPath $codexBinRoot -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    $nvmRoot = Join-Path $env:APPDATA "nvm"
    if (Test-Path -LiteralPath $nvmRoot) {
        $candidate = Get-ChildItem -LiteralPath $nvmRoot -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    return $null
}

function Ensure-TranslatorNodeBin {
    param([string]$SourceNodeBin)
    $binDir = Join-Path (Split-Path -Parent $ROOT) "bin"
    $target = Join-Path $binDir "deepcodex-translator.exe"
    try {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        $shouldCopy = -not (Test-Path -LiteralPath $target)
        if (-not $shouldCopy) {
            $sourceItem = Get-Item -LiteralPath $SourceNodeBin -ErrorAction Stop
            $targetItem = Get-Item -LiteralPath $target -ErrorAction Stop
            $shouldCopy = ($sourceItem.Length -ne $targetItem.Length)
        }
        if ($shouldCopy) {
            Copy-Item -LiteralPath $SourceNodeBin -Destination $target -Force
        }
        if (Test-Path -LiteralPath $target) { return $target }
    } catch {
        Write-Warning "Could not prepare deepcodex-translator.exe; falling back to node.exe."
    }
    return $SourceNodeBin
}

function Ensure-NodeCommandShims {
    param([string]$NodeBin)

    $nodeDir = Split-Path -Parent $NodeBin
    $installRoot = Split-Path -Parent $ROOT
    $shimDir = Join-Path $installRoot "shims"
    New-Item -ItemType Directory -Path $shimDir -Force | Out-Null

    foreach ($command in @("npm", "npx", "pnpm", "yarn")) {
        $shimPath = Join-Path $shimDir "$command.cmd"
        $targetPath = Join-Path $nodeDir "$command.cmd"
        $body = @"
@echo off
setlocal
if exist "$targetPath" (
  call "$targetPath" %*
) else (
  echo $command.cmd was not found next to node.exe: $nodeDir 1>&2
  exit /b 9009
)
exit /b %ERRORLEVEL%
"@
        Set-Content -LiteralPath $shimPath -Value $body -Encoding ASCII
    }

    $pathParts = @($shimDir)
    if ($env:Path) {
        $pathParts += ($env:Path -split ";" | Where-Object { $_ -and ($_ -ne $shimDir) })
    }
    $env:Path = ($pathParts -join ";")
    if (-not $env:PATHEXT -or (($env:PATHEXT -split ";") -notcontains ".CMD")) {
        $env:PATHEXT = ".COM;.EXE;.BAT;.CMD"
    }
    return $shimDir
}

function Find-CodexBin {
    function Test-IsWindowsAppsPath {
        param([string]$Path)
        if (-not $Path) { return $false }
        return ($Path -like "*\WindowsApps\*")
    }
    $installRoot = Split-Path -Parent $ROOT
    $patchedAntiCodex = Join-Path $installRoot "codex-patched-app\Anti-Codex.exe"
    $patchedCodex = Join-Path $installRoot "codex-patched-app\Codex.exe"
    $patchOkMarker = Join-Path $installRoot "codex-patched-app.ok"
    if ((Test-Path -LiteralPath $patchedAntiCodex) -and (Test-Path -LiteralPath $patchOkMarker)) { return $patchedAntiCodex }
    if ($IS_ANTICODEX_INSTALL_ROOT) {
        throw "Anti-Codex installed host is missing or not verified. Refusing to fall back to the original Codex executable."
    }
    if ($env:CODEX_BIN -and (Test-Path -LiteralPath $env:CODEX_BIN) -and -not (Test-IsWindowsAppsPath $env:CODEX_BIN)) { return $env:CODEX_BIN }
    if ((Test-Path -LiteralPath $patchedCodex) -and (Test-Path -LiteralPath $patchOkMarker)) { return $patchedCodex }
    $binTxt = Join-Path (Split-Path -Parent $ROOT) "codex-bin.txt"
    if (Test-Path -LiteralPath $binTxt) {
        $saved = (Get-Content -LiteralPath $binTxt -Raw).Trim()
        if ($saved -and (Test-Path -LiteralPath $saved) -and -not (Test-IsWindowsAppsPath $saved)) { return $saved }
    }
    foreach ($name in @("OpenAI.Codex", "OpenAI.Codex_8wekyb3d8bbwe")) {
        try {
            $pkg = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($pkg) {
                foreach ($rel in @("app\Codex.exe", "Codex.exe")) {
                    $candidate = Join-Path $pkg.InstallLocation $rel
                    if ((Test-Path -LiteralPath $candidate) -and -not (Test-IsWindowsAppsPath $candidate)) { return $candidate }
                }
            }
        } catch {}
    }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\app\Codex.exe"),
        (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\codex.exe"),
        (Join-Path $env:PROGRAMFILES "OpenAI\Codex\app\Codex.exe")
    )) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $found = Get-Command "Codex.exe" -ErrorAction SilentlyContinue
    if ($found -and -not (Test-IsWindowsAppsPath $found.Source)) { return $found.Source }
    $found = Get-Command "codex.exe" -ErrorAction SilentlyContinue
    if ($found -and -not (Test-IsWindowsAppsPath $found.Source)) { return $found.Source }
    return $null
}

function Read-DeepSeekKey {
    if ($env:DEEPSEEK_API_KEY) { return $env:DEEPSEEK_API_KEY.Trim() }
    if ($env:UPSTREAM_API_KEY) { return $env:UPSTREAM_API_KEY.Trim() }
    if (Test-Path -LiteralPath $DEEP_CODEX_ENV_FILE) {
        $line = Get-Content -LiteralPath $DEEP_CODEX_ENV_FILE -ErrorAction SilentlyContinue |
            Where-Object { $_ -match "^DEEPSEEK_API_KEY=(.+)$" } |
            Select-Object -First 1
        if ($line -match "^DEEPSEEK_API_KEY=(.+)$") { return $Matches[1].Trim() }
    }
    return ""
}

function Save-DeepSeekKey {
    param([string]$Key)
    New-Item -ItemType Directory -Path (Split-Path -Parent $DEEP_CODEX_ENV_FILE) -Force | Out-Null
    $lines = @()
    if (Test-Path -LiteralPath $DEEP_CODEX_ENV_FILE) {
        $lines = Get-Content -LiteralPath $DEEP_CODEX_ENV_FILE -ErrorAction SilentlyContinue
    }
    $written = $false
    $next = foreach ($line in $lines) {
        if ($line -match "^DEEPSEEK_API_KEY=") {
            if (-not $written) {
                "DEEPSEEK_API_KEY=$Key"
                $written = $true
            }
        } else {
            $line
        }
    }
    if (-not $written) { $next += "DEEPSEEK_API_KEY=$Key" }
    $next | Set-Content -LiteralPath $DEEP_CODEX_ENV_FILE -Encoding utf8
}

function Clear-DeepSeekKey {
    if (-not (Test-Path -LiteralPath $DEEP_CODEX_ENV_FILE)) { return }
    $next = Get-Content -LiteralPath $DEEP_CODEX_ENV_FILE -ErrorAction SilentlyContinue |
        Where-Object { ($_ -replace "^\uFEFF", "") -notmatch "^DEEPSEEK_API_KEY=" }
    $next | Set-Content -LiteralPath $DEEP_CODEX_ENV_FILE -Encoding utf8
}

function Test-PseudoLoginAuth {
    $authPath = Join-Path $CODEX_HOME_DIR "auth.json"
    if (-not (Test-Path -LiteralPath $authPath)) { return $false }
    try {
        $auth = Get-Content -LiteralPath $authPath -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($IS_ANTIGRAVITY_MODE) {
            return [bool]$auth.OPENAI_API_KEY
        }
        return ($auth.auth_mode -eq "chatgpt" -and
            $auth.tokens.access_token -and
            $auth.tokens.id_token -and
            $auth.tokens.refresh_token -eq "rt_deepcodex_local" -and
            $auth.tokens.account_id -eq "deepcodex-local-account")
    } catch {
        return $false
    }
}

function Get-TranslatorHealthSnapshot {
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.WebRequest]::Create("$TRANSLATOR_URL/health")
        $request.Proxy = $null
        $request.Timeout = $TRANSLATOR_HEALTH_TIMEOUT_MS
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

function Test-TranslatorHealth {
    $snapshot = Get-TranslatorHealthSnapshot
    return [bool]($snapshot -and $snapshot.ok)
}

function Test-TranslatorHealthWithGrace {
    $attempts = [Math]::Max(1, $TRANSLATOR_HEALTH_FAILURE_THRESHOLD)
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
        if (Test-TranslatorHealth) { return $true }
        if ($attempt -lt $attempts) {
            Start-Sleep -Milliseconds ([Math]::Max(0, $TRANSLATOR_HEALTH_RETRY_DELAY_MS))
        }
    }
    return $false
}

function Test-TranslatorBusyMarker {
    if (-not (Test-Path -LiteralPath $ANTICODEX_TRANSLATOR_BUSY_PATH -PathType Leaf)) { return $false }
    try {
        $item = Get-Item -LiteralPath $ANTICODEX_TRANSLATOR_BUSY_PATH -ErrorAction Stop
        if (([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalSeconds -gt $ANTICODEX_TRANSLATOR_BUSY_MAX_AGE_SECONDS) {
            return $false
        }
        try {
            $marker = Get-Content -LiteralPath $ANTICODEX_TRANSLATOR_BUSY_PATH -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        } catch {
            return $true
        }
        if ([int]$marker.active -lt 1) { return $false }
        $pidValue = [int]$marker.pid
        if ($pidValue -gt 0 -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
            return $true
        }
        if ($pidValue -le 0) { return $true }
    } catch {}
    return $false
}

function Get-TranslatorBusyMarkerAgeSeconds {
    if (-not (Test-Path -LiteralPath $ANTICODEX_TRANSLATOR_BUSY_PATH -PathType Leaf)) { return $null }
    try {
        $item = Get-Item -LiteralPath $ANTICODEX_TRANSLATOR_BUSY_PATH -ErrorAction Stop
        return [int]([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalSeconds
    } catch {
        return $null
    }
}

function Test-TranslatorBusyRestartGraceActive {
    $ageSeconds = Get-TranslatorBusyMarkerAgeSeconds
    if ($null -eq $ageSeconds) { return $false }
    return $ageSeconds -le [Math]::Max(1, $ANTICODEX_TRANSLATOR_BUSY_HEALTH_GRACE_SECONDS)
}

function Test-TranslatorRestartLockActive {
    if (-not (Test-Path -LiteralPath $ANTICODEX_TRANSLATOR_RESTART_LOCK_PATH -PathType Leaf)) { return $false }
    try {
        $item = Get-Item -LiteralPath $ANTICODEX_TRANSLATOR_RESTART_LOCK_PATH -ErrorAction Stop
        return (([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalSeconds -le [Math]::Max(1, $ANTICODEX_TRANSLATOR_RESTART_LOCK_MAX_AGE_SECONDS))
    } catch {
        return $false
    }
}

function Get-TranslatorDiagnosticsSnapshot {
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.WebRequest]::Create("$TRANSLATOR_URL/anticodex/diagnostics")
        $request.Proxy = $null
        $request.Timeout = $TRANSLATOR_HEALTH_TIMEOUT_MS
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

function Test-TranslatorDiagnosticsBusy {
    $diagnostics = Get-TranslatorDiagnosticsSnapshot
    if (-not $diagnostics -or -not $diagnostics.ok) { return $false }
    $activeRequests = 0
    $queueRunning = $false
    $queueQueued = 0
    $lockActive = $false
    $lockQueued = 0
    try { $activeRequests = [int]$diagnostics.activeAntigravityRequests.active } catch {}
    try { $queueRunning = [bool]$diagnostics.antigravityQueue.running } catch {}
    try { $queueQueued = [int]$diagnostics.antigravityQueue.queued } catch {}
    try { $lockActive = [bool]$diagnostics.antigravitySessionLock.active } catch {}
    try { $lockQueued = [int]$diagnostics.antigravitySessionLock.queued } catch {}
    return ($activeRequests -gt 0 -or $queueRunning -or $queueQueued -gt 0 -or ($lockActive -and $lockQueued -gt 0))
}

function Write-TranslatorStartLog {
    param([string]$Message)
    try {
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        "$stamp $Message" | Add-Content -LiteralPath $TRANSLATOR_START_LOG -Encoding utf8
    } catch {}
}

function Clear-TranslatorRuntimeLogs {
    foreach ($path in @($TRANSLATOR_LOG, $TRANSLATOR_ERR_LOG)) {
        try {
            "" | Set-Content -LiteralPath $path -Encoding utf8
        } catch {
            Write-TranslatorStartLog "translator log is temporarily locked; continuing without truncating $path"
        }
    }
}

function Open-SetupWindow {
    param([string]$Url)
    $setupProfile = Join-Path $DEEPCODEX_STATE_ROOT "setup-browser-profile"
    New-Item -ItemType Directory -Path $setupProfile -Force | Out-Null
    $browser = $null
    foreach ($candidate in @(
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe")
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { $browser = $candidate; break }
    }
    if (-not $browser) { Start-Process $Url; return }
    $proc = Start-Process -FilePath $browser -ArgumentList @("--user-data-dir=$setupProfile", "--no-first-run", "--app=$Url", "--window-size=600,380", "--window-position=180,120", "--new-window") -PassThru
    Start-Sleep -Seconds 2
    Move-SetupWindow
}

function Move-SetupWindow {
    try {
        Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DeepCodexWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@ -ErrorAction SilentlyContinue
        $edgePids = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("msedge.exe", "chrome.exe") -and $_.CommandLine -like "*setup-browser-profile*" } | Select-Object -ExpandProperty ProcessId)
        [DeepCodexWin]::EnumWindows({
            param($h, $l)
            $windowPid = 0
            [DeepCodexWin]::GetWindowThreadProcessId($h, [ref]$windowPid) | Out-Null
            if ($edgePids -contains [int]$windowPid -and [DeepCodexWin]::IsWindowVisible($h)) {
                $sb = New-Object System.Text.StringBuilder 256
                [DeepCodexWin]::GetWindowText($h, $sb, 256) | Out-Null
                if ($sb.ToString() -like "*Anti-Codex Setup*") {
                    [DeepCodexWin]::SetWindowPos($h, [IntPtr]::Zero, 180, 120, 600, 380, 0x0040) | Out-Null
                }
            }
            return $true
        }, [IntPtr]::Zero) | Out-Null
    } catch {}
}

function Initialize-WindowProbe {
    try {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeepCodexWindowProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
}
"@ -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Get-MainWindowHandleForProcess {
    param([int]$ProcessId)
    if (-not (Initialize-WindowProbe)) { return [IntPtr]::Zero }
    $script:deepCodexMainWindowHandle = [IntPtr]::Zero
    [DeepCodexWindowProbe]::EnumWindows({
        param($h, $l)
        $windowPid = 0
        [DeepCodexWindowProbe]::GetWindowThreadProcessId($h, [ref]$windowPid) | Out-Null
        $root = [DeepCodexWindowProbe]::GetAncestor($h, 2)
        if ([int]$windowPid -eq $ProcessId -and $root -eq $h -and [DeepCodexWindowProbe]::IsWindowVisible($h)) {
            $script:deepCodexMainWindowHandle = $h
            return $false
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null
    $handle = $script:deepCodexMainWindowHandle
    Remove-Variable -Name deepCodexMainWindowHandle -Scope Script -ErrorAction SilentlyContinue
    return $handle
}

function Test-WindowHandleExists {
    param([IntPtr]$Handle)
    if ($Handle -eq [IntPtr]::Zero) { return $true }
    if (-not (Initialize-WindowProbe)) { return $true }
    return ([DeepCodexWindowProbe]::IsWindow($Handle) -and [DeepCodexWindowProbe]::IsWindowVisible($Handle))
}

function Stop-SetupWindow {
    try {
        Get-CimInstance Win32_Process |
            Where-Object { $_.Name -in @("msedge.exe", "chrome.exe") -and $_.CommandLine -like "*setup-browser-profile*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {}
}

function Get-DeepCodexTranslatorProcesses {
    $installRoot = Split-Path -Parent $ROOT
    try {
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                Test-IsDeepCodexTranslatorProcess $_ $installRoot
            }
    } catch {
        @()
    }
}

function Test-IsDeepCodexTranslatorProcess {
    param($Process, [string]$InstallRoot)
    if (-not $Process) { return $false }
    if ($Process.Name -ne "node.exe" -and $Process.Name -ne "deepcodex-translator.exe") { return $false }
    $commandLine = if ($Process.CommandLine) { [string]$Process.CommandLine } else { "" }
    $exePath = if ($Process.ExecutablePath) { [string]$Process.ExecutablePath } else { "" }
    if ($commandLine -like "*adaptive-server.mjs*" -and ($commandLine -like "*$ROOT*" -or $commandLine -like "*$InstallRoot*")) { return $true }
    if ($Process.Name -eq "deepcodex-translator.exe" -and $exePath -like "$InstallRoot*") { return $true }
    return $false
}

function Stop-StaleDeepCodexTranslator {
    foreach ($proc in @(Get-DeepCodexTranslatorProcesses)) {
        try {
            Write-TranslatorStartLog "stopping stale translator pid=$($proc.ProcessId)"
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        } catch {}
    }
}

function Get-LoopbackPortOwnerProcesses {
    param([int]$Port)
    $pids = @()
    try {
        $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        try {
            $lines = @(netstat -ano -p tcp | Select-String -Pattern (":$Port\s"))
            foreach ($line in $lines) {
                $parts = ($line.ToString().Trim() -split "\\s+")
                if ($parts.Count -ge 5 -and $parts[3] -eq "LISTENING") { $pids += [int]$parts[4] }
            }
            $pids = @($pids | Select-Object -Unique)
        } catch {
            $pids = @()
        }
    }
    foreach ($ownerPid in $pids) {
        try {
            Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction Stop
        } catch {}
    }
}

function Stop-DeepCodexTranslatorOnPort {
    param([int]$Port)
    $installRoot = Split-Path -Parent $ROOT
    foreach ($proc in @(Get-LoopbackPortOwnerProcesses $Port)) {
        if (Test-IsDeepCodexTranslatorProcess $proc $installRoot) {
            try {
                Write-TranslatorStartLog "stopping stale translator on port $Port pid=$($proc.ProcessId)"
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            } catch {}
        } else {
            Write-TranslatorStartLog "port $Port is occupied by pid=$($proc.ProcessId) name=$($proc.Name); leaving it alone"
        }
    }
}

function Get-DeepCodexOwnedProcesses {
    $installRoot = Split-Path -Parent $ROOT
    try {
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                $_.ProcessId -ne $PID -and
                $_.CommandLine -and
                (
                    $_.ExecutablePath -like "$installRoot*" -or
                    (
                        ($_.Name -eq "powershell.exe" -or $_.Name -eq "pwsh.exe") -and
                        $_.CommandLine -like "*-ExecutionPolicy Bypass*" -and
                        $_.CommandLine -like "*-WindowStyle Hidden*" -and
                        $_.CommandLine -like "*-File*" -and
                        $_.CommandLine -like "*start-deepcodex.ps1*" -and
                        $_.CommandLine -like "*$installRoot*"
                    ) -or
                    (
                        ($_.Name -eq "node.exe" -or $_.Name -eq "deepcodex-translator.exe") -and
                        $_.CommandLine -like "*adaptive-server.mjs*" -and
                        ($_.CommandLine -like "*$ROOT*" -or $_.CommandLine -like "*$installRoot*")
                    )
                )
            }
    } catch {
        @()
    }
}

function Stop-DeepCodexOwnedProcesses {
    param([int[]]$KeepProcessIds = @())
    foreach ($proc in @(Get-DeepCodexOwnedProcesses)) {
        if ($KeepProcessIds -contains [int]$proc.ProcessId) { continue }
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        } catch {}
    }
}

function Start-TranslatorProcess {
    param([string]$RuntimeBin)
    Update-AntiCodexUpstreamEnvironment
    Write-TranslatorStartLog "starting translator with $RuntimeBin"
    try {
        $proc = Start-Process -FilePath $RuntimeBin `
            -ArgumentList @((Join-Path $ROOT "translator\adaptive-server.mjs")) `
            -WorkingDirectory $ROOT `
            -RedirectStandardOutput $TRANSLATOR_LOG `
            -RedirectStandardError $TRANSLATOR_ERR_LOG `
            -PassThru -WindowStyle Hidden
        Write-TranslatorStartLog "started pid=$($proc.Id)"
        return $proc
    } catch {
        Write-TranslatorStartLog "start failed with ${RuntimeBin}: $($_.Exception.Message)"
        return $null
    }
}

function Ensure-TranslatorRunning {
    param(
        [string]$PrimaryRuntimeBin,
        [string]$FallbackRuntimeBin
    )
    if (Test-TranslatorHealthWithGrace) { return $true }
    if (Test-TranslatorRestartLockActive) {
        Write-TranslatorStartLog "translator restart lock is active; watchdog restart skipped"
        return $true
    }
    if ((Test-TranslatorBusyMarker) -or (Test-TranslatorDiagnosticsBusy)) {
        if (Test-TranslatorBusyRestartGraceActive) {
            Write-TranslatorStartLog "translator health unavailable while Antigravity request is busy; restart skipped within busy grace"
            return $true
        }
        Write-TranslatorStartLog "translator health unavailable while busy grace expired; forcing restart"
    }

    Write-TranslatorStartLog "translator health lost; restarting"
    Stop-StaleDeepCodexTranslator
    Stop-DeepCodexTranslatorOnPort $TRANSLATOR_PORT
    Start-Sleep -Milliseconds 200

    $script:TRANSLATOR_PROC = Start-TranslatorProcess $PrimaryRuntimeBin
    Start-Sleep -Milliseconds 700
    if ((-not (Test-TranslatorHealth)) -and ($PrimaryRuntimeBin -ne $FallbackRuntimeBin)) {
        if ($script:TRANSLATOR_PROC -and -not $script:TRANSLATOR_PROC.HasExited) {
            Write-TranslatorStartLog "dedicated translator still starting after watchdog restart"
        } else {
            Write-TranslatorStartLog "dedicated translator failed during watchdog restart; falling back to $FallbackRuntimeBin"
            Stop-StaleDeepCodexTranslator
            Stop-DeepCodexTranslatorOnPort $TRANSLATOR_PORT
            $script:TRANSLATOR_PROC = Start-TranslatorProcess $FallbackRuntimeBin
        }
    }

    $fallbackTried = $false
    for ($i = 0; $i -lt 15; $i++) {
        if (Test-TranslatorHealth) { return $true }
        if ((-not $fallbackTried) -and ($PrimaryRuntimeBin -ne $FallbackRuntimeBin) -and $script:TRANSLATOR_PROC -and $script:TRANSLATOR_PROC.HasExited) {
            $fallbackTried = $true
            Write-TranslatorStartLog "watchdog fallback to $FallbackRuntimeBin"
            Stop-StaleDeepCodexTranslator
            Stop-DeepCodexTranslatorOnPort $TRANSLATOR_PORT
            $script:TRANSLATOR_PROC = Start-TranslatorProcess $FallbackRuntimeBin
        }
        Start-Sleep -Seconds 1
    }

    Write-TranslatorStartLog "watchdog restart failed; translator is still unhealthy"
    return $false
}

function Get-AntiCodexManagerBridgeProcesses {
    if (-not $IS_ANTIGRAVITY_MODE) { return @() }
    if (-not (Test-Path -LiteralPath $ANTICODEX_MANAGER_BRIDGE -PathType Leaf)) { return @() }
    $bridgeName = [regex]::Escape((Split-Path -Leaf $ANTICODEX_MANAGER_BRIDGE))
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        [string]$_.CommandLine -match $bridgeName -and
        [string]$_.CommandLine -match "--port\s+$DEEPCODEX_CDP_PORT(\s|$)" -and
        [string]$_.CommandLine -like "*$ROOT*"
    })
}

function Test-AntiCodexManagerBridgeRunning {
    return @(Get-AntiCodexManagerBridgeProcesses).Count -gt 0
}

function Start-AntiCodexManagerBridge {
    if (-not $IS_ANTIGRAVITY_MODE) { return $true }
    if (-not (Test-Path -LiteralPath $ANTICODEX_MANAGER_BRIDGE -PathType Leaf)) {
        Write-LifecycleLog "Manager bridge script is missing; in-window Manager actions will be limited."
        return $false
    }
    if (Test-AntiCodexManagerBridgeRunning) { return $true }

    Remove-Item -LiteralPath $ANTICODEX_MANAGER_BRIDGE_LOG, $ANTICODEX_MANAGER_BRIDGE_ERR_LOG -Force -ErrorAction SilentlyContinue
    try {
        $proc = Start-Process -FilePath $NODE_BIN `
            -ArgumentList @($ANTICODEX_MANAGER_BRIDGE, "--port", "$DEEPCODEX_CDP_PORT", "--base-url", $TRANSLATOR_URL) `
            -RedirectStandardOutput $ANTICODEX_MANAGER_BRIDGE_LOG `
            -RedirectStandardError $ANTICODEX_MANAGER_BRIDGE_ERR_LOG `
            -PassThru -WindowStyle Hidden
        Start-Sleep -Milliseconds 800
        if ($proc.HasExited) {
            $detail = if (Test-Path -LiteralPath $ANTICODEX_MANAGER_BRIDGE_ERR_LOG) { (Get-Content -LiteralPath $ANTICODEX_MANAGER_BRIDGE_ERR_LOG -Tail 12) -join " " } else { "" }
            Write-LifecycleLog "Manager bridge exited during startup (ExitCode: $($proc.ExitCode)). $detail"
            return $false
        }
        Write-LifecycleLog "Manager bridge started (PID: $($proc.Id))."
        return $true
    } catch {
        Write-LifecycleLog "Manager bridge start failed: $($_.Exception.Message)"
        return $false
    }
}

function Ensure-AntiCodexManagerBridgeRunning {
    if (-not $IS_ANTIGRAVITY_MODE) { return $true }
    if (Test-AntiCodexManagerBridgeRunning) { return $true }
    Write-LifecycleLog "Manager bridge is not running; restarting."
    return Start-AntiCodexManagerBridge
}

function Get-AntiCodexManagerInjectionWatchers {
    if (-not $IS_ANTIGRAVITY_MODE) { return @() }
    $injectName = [regex]::Escape((Split-Path -Leaf $DEEPCODEX_CDP_INJECT))
    $managerName = [regex]::Escape((Split-Path -Leaf $ANTICODEX_MANAGER_INJECT))
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $commandLine = [string]$_.CommandLine
        $commandLine -match $injectName -and
        $commandLine -match $managerName -and
        $commandLine -match "\s$DEEPCODEX_CDP_PORT(\s|$)" -and
        $commandLine -match "(^|\s)--watch(\s|$)" -and
        $commandLine -like "*$ROOT*"
    })
}

function Reuse-AntiCodexManagerInjectionWatcher {
    $watchers = @(Get-AntiCodexManagerInjectionWatchers | Sort-Object CreationDate, ProcessId)
    if ($watchers.Count -eq 0) { return $false }
    $keeper = $watchers[0]
    foreach ($duplicate in @($watchers | Select-Object -Skip 1)) {
        Write-LifecycleLog "stopping duplicate manager injection watcher pid=$($duplicate.ProcessId)."
        Stop-Process -Id $duplicate.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $script:managerInjected = $true
    Write-LifecycleLog "Reusing manager injection watcher (PID: $($keeper.ProcessId))."
    [void](Start-AntiCodexManagerBridge)
    return $true
}

function Test-LoopbackPortAvailable {
    param([int]$Port)
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

function Get-CdpTargets {
    param([int]$Port)
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.WebRequest]::Create("http://127.0.0.1:$Port/json")
        $request.Proxy = $null
        $request.Timeout = 2000
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $content = $reader.ReadToEnd()
        return ($content | ConvertFrom-Json)
    } catch {
        return $null
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Test-CdpPageReady {
    param([int]$Port)
    $targets = Get-CdpTargets -Port $Port
    if ($null -eq $targets) { return $false }
    foreach ($target in $targets) {
        if ($target.type -eq "page" -and $target.webSocketDebuggerUrl) {
            $title = if ($target.title) { $target.title } else { "" }
            $url = if ($target.url) { $target.url } else { "" }
            if ($title.ToLower().Contains("codex") -or $url.ToLower().Contains("codex")) {
                return $true
            }
        }
    }
    return $false
}

function Invoke-CdpInjectionsIfNeeded {
    $needManagerInject = $IS_ANTIGRAVITY_MODE -and (Test-Path -LiteralPath $DEEPCODEX_CDP_INJECT) -and (Test-Path -LiteralPath $ANTICODEX_MANAGER_INJECT)
    $needPluginUnlockInject = $DEEPCODEX_PLUGIN_UNLOCK_ENABLED -and (Test-Path -LiteralPath $DEEPCODEX_CDP_INJECT) -and (Test-Path -LiteralPath $DEEPCODEX_PLUGIN_UNLOCK_INJECT)
    $maxAttempts = 5

    if ($needManagerInject -and $script:managerInjected -and @(Get-AntiCodexManagerInjectionWatchers).Count -eq 0) {
        $script:managerInjected = $false
        $script:managerInjectAttempts = 0
        Write-LifecycleLog "Manager injection watcher disappeared; restarting."
    }

    if (($needManagerInject -and -not $script:managerInjected -and $script:managerInjectAttempts -lt $maxAttempts) -or
        ($needPluginUnlockInject -and -not $script:pluginUnlockInjected -and $script:pluginUnlockInjectAttempts -lt $maxAttempts)) {

        if (Test-CdpPageReady -Port $DEEPCODEX_CDP_PORT) {
            if ($needPluginUnlockInject -and -not $script:pluginUnlockInjected -and $script:pluginUnlockInjectAttempts -lt $maxAttempts) {
                $script:pluginUnlockInjectAttempts++
                Write-LifecycleLog "Attempting plugin UI unlock injection (Attempt $script:pluginUnlockInjectAttempts of $maxAttempts)..."
                Remove-Item -LiteralPath $DEEPCODEX_CDP_LOG, $DEEPCODEX_CDP_ERR_LOG -Force -ErrorAction SilentlyContinue
                try {
                    $proc = Start-Process -FilePath $NODE_BIN `
                        -ArgumentList @($DEEPCODEX_CDP_INJECT, "$DEEPCODEX_CDP_PORT", $DEEPCODEX_PLUGIN_UNLOCK_INJECT) `
                        -RedirectStandardOutput $DEEPCODEX_CDP_LOG `
                        -RedirectStandardError $DEEPCODEX_CDP_ERR_LOG `
                        -PassThru -WindowStyle Hidden
                    [void]$proc.Handle
                    if (Wait-AntiCodexChildProcess -Process $proc -TimeoutMs 8000) {
                        if ($proc.ExitCode -eq 0) {
                            $script:pluginUnlockInjected = $true
                            Write-LifecycleLog "Plugin UI unlock injection succeeded."
                        } else {
                            Write-LifecycleLog "Plugin UI unlock injection failed with exit code $($proc.ExitCode)."
                        }
                    } else {
                        Write-LifecycleLog "Plugin UI unlock injection timed out."
                        try { $proc.Kill() } catch {}
                    }
                } catch {
                    Write-LifecycleLog "Plugin UI unlock injection error: $($_.Exception.Message)"
                }
            }

            if ($needManagerInject -and -not $script:managerInjected -and $script:managerInjectAttempts -lt $maxAttempts) {
                if (Reuse-AntiCodexManagerInjectionWatcher) { return }
                $script:managerInjectAttempts++
                Write-LifecycleLog "Attempting manager injection (Attempt $script:managerInjectAttempts of $maxAttempts)..."
                Remove-Item -LiteralPath $ANTICODEX_MANAGER_CDP_LOG, $ANTICODEX_MANAGER_CDP_ERR_LOG -Force -ErrorAction SilentlyContinue
                $previousManagerWatch = $env:DEEPCODEX_CDP_MANAGER_WATCH
                try {
                    $env:DEEPCODEX_CDP_MANAGER_WATCH = "1"
                    $proc = Start-Process -FilePath $NODE_BIN `
                        -ArgumentList @($DEEPCODEX_CDP_INJECT, "$DEEPCODEX_CDP_PORT", $ANTICODEX_MANAGER_INJECT, "--watch") `
                        -RedirectStandardOutput $ANTICODEX_MANAGER_CDP_LOG `
                        -RedirectStandardError $ANTICODEX_MANAGER_CDP_ERR_LOG `
                        -PassThru -WindowStyle Hidden
                    [void]$proc.Handle
                    $exited = Wait-AntiCodexChildProcess -Process $proc -TimeoutMs 3000
                    try { $proc.Refresh() } catch {}
                    $managerInjectionOutput = if (Test-Path -LiteralPath $ANTICODEX_MANAGER_CDP_LOG) {
                        Get-Content -LiteralPath $ANTICODEX_MANAGER_CDP_LOG -Raw -ErrorAction SilentlyContinue
                    } else {
                        ""
                    }
                    if ($exited) {
                        $managerInjectionOk = ($proc.ExitCode -eq 0) -or ($managerInjectionOutput -match '"ok"\s*:\s*true')
                        if ($managerInjectionOk) {
                            $script:managerInjected = $true
                            Write-LifecycleLog "Manager injection succeeded."
                            [void](Start-AntiCodexManagerBridge)
                        } else {
                            $exitCodeText = if ($null -ne $proc.ExitCode) { [string]$proc.ExitCode } else { "unknown" }
                            Write-LifecycleLog "Manager injection failed with exit code $exitCodeText."
                        }
                    } else {
                        $managerInjectionOk = $managerInjectionOutput -match '"ok"\s*:\s*true'
                        if ($managerInjectionOk) {
                            $script:managerInjected = $true
                            Write-LifecycleLog "Manager injection watcher is running (PID: $($proc.Id))."
                            [void](Start-AntiCodexManagerBridge)
                        } elseif (-not $proc.HasExited) {
                            $script:managerInjected = $true
                            Write-LifecycleLog "Manager injection watcher is alive and will keep watching (PID: $($proc.Id))."
                            [void](Start-AntiCodexManagerBridge)
                        } else {
                            Write-LifecycleLog "Manager injection timed out after 3000ms."
                        }
                    }
                } catch {
                    Write-LifecycleLog "Manager injection error: $($_.Exception.Message)"
                } finally {
                    if ($null -eq $previousManagerWatch) {
                        Remove-Item Env:DEEPCODEX_CDP_MANAGER_WATCH -ErrorAction SilentlyContinue
                    } else {
                        $env:DEEPCODEX_CDP_MANAGER_WATCH = $previousManagerWatch
                    }
                }
            }
        }
    }
}

function Select-LoopbackPort {
    param([int]$Preferred)
    if (Test-LoopbackPortAvailable $Preferred) { return $Preferred }
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
    try {
        $listener.Start()
        return $listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }
}

function ConvertTo-ProcessArgument {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-NodeStdin {
    param([string[]]$Arguments, [string]$Script)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:NODE_BIN
    $psi.Arguments = (@("-") + $Arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Write($Script)
    $p.StandardInput.Close()
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "node failed: $stderr" }
    return $stdout
}

function Write-PseudoLoginAuth {
    New-Item -ItemType Directory -Path $CODEX_HOME_DIR -Force | Out-Null
    $authPath = Join-Path $CODEX_HOME_DIR "auth.json"
    Invoke-NodeStdin -Arguments @($authPath, $DEEPCODEX_DISPLAY_NAME, $DEEPCODEX_ACCOUNT_EMAIL, $IS_ANTIGRAVITY_MODE, $LOCAL_CODEX_API_KEY) -Script @'
const fs = require("fs");
const [authPath, displayName, accountEmail, isAntigravityMode, localApiKey] = process.argv.slice(2);
if (isAntigravityMode === "True") {
  fs.writeFileSync(authPath, JSON.stringify({
    OPENAI_API_KEY: localApiKey || "sk-codex-deepseek-local"
  }, null, 2) + "\n");
  process.exit(0);
}
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeJwt = (payload) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.deepcodex`;
const now = Math.floor(Date.now() / 1000);
const accountId = "deepcodex-local-account";
const userId = "deepcodex-local-user";
const profile = { email: accountEmail, email_verified: true, name: displayName };
fs.writeFileSync(authPath, JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: fakeJwt({ iss: "https://auth.openai.com", aud: ["app_deepcodex_local"], sub: userId, iat: now, exp: now + 365 * 24 * 60 * 60, email: accountEmail, email_verified: true, name: displayName, "https://api.openai.com/auth": { user_id: userId, chatgpt_user_id: userId, chatgpt_account_id: accountId, chatgpt_account_user_id: `${userId}__${accountId}`, chatgpt_plan_type: "prolite", localhost: true, groups: [], organizations: [] } }),
    access_token: fakeJwt({ iss: "https://auth.openai.com", aud: ["https://api.openai.com/v1"], sub: userId, iat: now, nbf: now, exp: now + 365 * 24 * 60 * 60, scp: ["openid", "profile", "email", "offline_access"], "https://api.openai.com/profile": profile, "https://api.openai.com/auth": { user_id: userId, chatgpt_user_id: userId, chatgpt_account_id: accountId, chatgpt_account_user_id: `${userId}__${accountId}`, chatgpt_plan_type: "prolite", localhost: true } }),
    refresh_token: "rt_deepcodex_local",
    account_id: accountId
  },
  last_refresh: new Date().toISOString()
}, null, 2) + "\n");
'@ | Out-Null
}

function Seed-RuntimeDefaults {
    New-Item -ItemType Directory -Path $CODEX_HOME_DIR -Force | Out-Null
    if ((Test-Path -LiteralPath $CONFIG_TEMPLATE_PATH) -and (-not (Test-Path -LiteralPath (Join-Path $CODEX_HOME_DIR "config.adaptive-oneapi.toml")))) {
        Copy-Item -LiteralPath $CONFIG_TEMPLATE_PATH -Destination (Join-Path $CODEX_HOME_DIR "config.adaptive-oneapi.toml")
    }
    if (Test-Path -LiteralPath $MODEL_CATALOG_TEMPLATE_PATH) {
        if ($IS_ANTIGRAVITY_MODE) {
            Copy-Item -LiteralPath $MODEL_CATALOG_TEMPLATE_PATH -Destination (Join-Path $CODEX_HOME_DIR "deepseek-model-catalog.json") -Force
        } elseif (-not (Test-Path -LiteralPath (Join-Path $CODEX_HOME_DIR "deepseek-model-catalog.json"))) {
            Copy-Item -LiteralPath $MODEL_CATALOG_TEMPLATE_PATH -Destination (Join-Path $CODEX_HOME_DIR "deepseek-model-catalog.json")
        }
    }
}

function Sync-AntigravityModelCatalog {
    param([string]$NodeBin)
    if (-not $USES_ANTIGRAVITY_UPSTREAM) { return $false }
    if (-not (Test-Path -LiteralPath $ANTIGRAVITY_MODEL_CATALOG_SYNC)) {
        Write-Warning "Antigravity model catalog sync script is missing; using the bundled fallback catalog."
        return $false
    }
    $generatedCatalog = Join-Path $DEEPCODEX_STATE_ROOT "antigravity-model-catalog.json"
    try {
        & $NodeBin $ANTIGRAVITY_MODEL_CATALOG_SYNC $MODEL_CATALOG_TEMPLATE_PATH $generatedCatalog | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Antigravity model discovery exited with code $LASTEXITCODE."
        }
        if (-not (Test-Path -LiteralPath $generatedCatalog)) {
            throw "Antigravity model discovery did not write a model catalog."
        }
        $script:MODEL_CATALOG_TEMPLATE_PATH = $generatedCatalog
        $env:ANTIGRAVITY_MODEL_CATALOG_PATH = $generatedCatalog
        return $true
    } catch {
        Write-Warning "Could not refresh Antigravity models; using the last available catalog. $($_.Exception.Message)"
        if (Test-Path -LiteralPath $generatedCatalog) {
            $script:MODEL_CATALOG_TEMPLATE_PATH = $generatedCatalog
            $env:ANTIGRAVITY_MODEL_CATALOG_PATH = $generatedCatalog
        }
        return $false
    }
}

function Use-CachedAntigravityModelCatalog {
    if (-not $USES_ANTIGRAVITY_UPSTREAM) { return $false }
    if ($env:ANTICODEX_FORCE_STARTUP_MODEL_REFRESH -eq "1") { return $false }

    $generatedCatalog = Join-Path $DEEPCODEX_STATE_ROOT "antigravity-model-catalog.json"
    if (-not (Test-Path -LiteralPath $generatedCatalog -PathType Leaf)) { return $false }

    try {
        $catalog = Get-Content -LiteralPath $generatedCatalog -Raw | ConvertFrom-Json
        if (-not $catalog.models -or @($catalog.models).Count -lt 1) { return $false }
        $script:MODEL_CATALOG_TEMPLATE_PATH = $generatedCatalog
        $env:ANTIGRAVITY_MODEL_CATALOG_PATH = $generatedCatalog
        return $true
    } catch {
        return $false
    }
}

function Refresh-AntigravityCatalogAfterRecovery {
    param([string]$NodeBin)
    if (-not (Sync-AntigravityModelCatalog $NodeBin)) { return $false }

    $generatedCatalog = Join-Path $DEEPCODEX_STATE_ROOT "antigravity-model-catalog.json"
    if (-not (Test-Path -LiteralPath $generatedCatalog)) { return $false }

    New-Item -ItemType Directory -Path $CODEX_HOME_DIR -Force | Out-Null
    Copy-Item -LiteralPath $generatedCatalog -Destination (Join-Path $CODEX_HOME_DIR "deepseek-model-catalog.json") -Force
    return $true
}

function Seed-OnboardingState {
    New-Item -ItemType Directory -Path $CODEX_HOME_DIR -Force | Out-Null
    Invoke-NodeStdin -Arguments @((Join-Path $CODEX_HOME_DIR ".codex-global-state.json")) -Script @'
const fs = require("fs");
const [statePath] = process.argv.slice(2);
let state = {};
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch {
  try {
    fs.copyFileSync(statePath, `${statePath}.invalid-${Date.now()}.bak`);
  } catch {}
}
if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
const atoms = state["electron-persisted-atom-state"] && typeof state["electron-persisted-atom-state"] === "object"
  ? state["electron-persisted-atom-state"]
  : {};
const now = Math.floor(Date.now() / 1000);
for (const target of [state, atoms]) {
  target["electron:onboarding-override"] = "app";
  target["electron:onboarding-projectless-completed"] = true;
  target["electron:onboarding-welcome-pending"] = false;
  target["last_completed_onboarding"] = target["last_completed_onboarding"] || now;
}
delete atoms["prompt-history"];
state["electron-persisted-atom-state"] = atoms;
const next = JSON.stringify(state, null, 2);
fs.writeFileSync(statePath, `${next}\n`, "utf8");
fs.writeFileSync(`${statePath}.bak`, `${next}\n`, "utf8");
'@ | Out-Null
}

function Trust-Workspace {
    param([string]$Workspace)
    Invoke-NodeStdin -Arguments @((Join-Path $CODEX_HOME_DIR "config.toml"), $Workspace) -Script @'
const fs = require("fs");
const [configPath, workspace] = process.argv.slice(2);
let text = "";
try { text = fs.readFileSync(configPath, "utf8"); } catch {}
const escaped = workspace.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const header = `[projects."${escaped}"]`;
if (!text.includes(header)) {
  fs.writeFileSync(configPath, `${text.trimEnd()}\n\n${header}\ntrust_level = "trusted"\n`);
}
'@ | Out-Null
}

function Ensure-DeepCodexCoreConfig {
    Invoke-NodeStdin -Arguments @((Join-Path $CODEX_HOME_DIR "config.toml"), (Join-Path $CODEX_HOME_DIR "deepseek-model-catalog.json"), $TRANSLATOR_URL, $IS_ANTIGRAVITY_MODE) -Script @'
const fs = require("fs");
const [configPath, catalogPath, translatorUrl, isAntigravityMode] = process.argv.slice(2);
let text = "";
try { text = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""); } catch {}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

let defaultModel = isAntigravityMode === "True" ? "gemini-3-flash-agent" : "gpt-5.5";
if (isAntigravityMode === "True") {
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8").replace(/^\uFEFF/, ""));
    const slugs = (catalog.models || []).map((model) => model.slug).filter(Boolean);
    if (slugs.length && !slugs.includes(defaultModel)) defaultModel = slugs[0];
    const modelMatch = text.match(/^model\s*=\s*"([^"]*)"\s*$/m);
    if (modelMatch && !slugs.includes(modelMatch[1])) {
      text = text.replace(/^model\s*=.*\r?\n?/m, "");
    }
  } catch {}
}
const defaults = new Map([
  ["model", tomlString(defaultModel)],
  ["model_reasoning_effort", tomlString("high")],
  ["approval_policy", tomlString("on-request")],
  ["sandbox_mode", tomlString("workspace-write")],
  ["cli_auth_credentials_store", tomlString("file")],
]);
const forced = new Map([
  ["model_catalog_json", tomlString(catalogPath)],
  ["chatgpt_base_url", tomlString(`${translatorUrl}/backend-api/`)],
  ["openai_base_url", tomlString(translatorUrl)],
]);

for (const key of forced.keys()) {
  text = text.replace(new RegExp(`^${key}\\s*=.*\\r?\\n?`, "m"), "");
}

const existingTopLevel = (key) => new RegExp(`^${key}\\s*=`, "m").test(text);
const lines = text.split(/\r?\n/);
let insertAt = lines.findIndex((line) => /^\[[^\]]+\]\s*$/.test(line));
if (insertAt < 0) insertAt = lines.length;
while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
const prefix = [
  ...[...defaults.entries()].filter(([key]) => !existingTopLevel(key)),
  ...forced.entries(),
].map(([key, value]) => `${key} = ${value}`);
lines.splice(insertAt, 0, ...prefix, "");
text = lines.join("\n").replace(/\n+$/g, "");
const windowsBlockMatch = text.match(/(^\[windows\]\s*$)([\s\S]*?)(?=^\[[^\]]+\]\s*$|\s*$)/m);
if (windowsBlockMatch) {
  const [block, header, body] = windowsBlockMatch;
  if (!/^sandbox\s*=/m.test(body)) {
    text = text.replace(block, `${header}\nsandbox = "unelevated"${body}`);
  }
} else {
  text = `${text}\n\n[windows]\nsandbox = "unelevated"`;
}

function setFeatureFlag(source, key, value) {
  const configLines = source.split(/\r?\n/);
  let start = configLines.findIndex((line) => line.trim() === "[features]");
  if (start < 0) {
    configLines.push("", "[features]", `${key} = ${value}`);
    return configLines.join("\n");
  }
  let end = start + 1;
  while (end < configLines.length && !/^\[[^\]]+\]\s*$/.test(configLines[end])) end += 1;
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  const existing = configLines.findIndex((line, index) => index > start && index < end && keyRe.test(line));
  if (existing >= 0) configLines[existing] = `${key} = ${value}`;
  else configLines.splice(end, 0, `${key} = ${value}`);
  return configLines.join("\n");
}

text = setFeatureFlag(text, "responses_websockets", "false");
text = setFeatureFlag(text, "responses_websockets_v2", "false");
text = setFeatureFlag(text, "plugins", "false");
text = setFeatureFlag(text, "plugin_sharing", "false");
text = setFeatureFlag(text, "remote_plugin", "false");
fs.writeFileSync(configPath, `${text.replace(/\n+$/g, "")}\n`, "utf8");
'@ | Out-Null
}

function Strip-PluginMarketplaceConfig {
    param([string]$ConfigPath)
    Invoke-NodeStdin -Arguments @($ConfigPath) -Script @'
const fs = require("fs");
const [configPath] = process.argv.slice(2);
let text = "";
try { text = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""); } catch {}
const lines = text.split(/\r?\n/);
const kept = [];
let dropping = false;
for (const line of lines) {
  const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
  if (header) {
    const name = header[1];
    dropping = /^(plugins|marketplaces)\./.test(name);
  }
  if (!dropping) kept.push(line);
}
fs.writeFileSync(configPath, `${kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/g, "")}\n`, "utf8");
'@ | Out-Null
}

function Ensure-GlobalPermissionDefaults {
    Invoke-NodeStdin -Arguments @((Join-Path $GLOBAL_CODEX_HOME "config.toml")) -Script @'
const fs = require("fs");
const [configPath] = process.argv.slice(2);
let text = "";
try { text = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""); } catch {}

const defaults = new Map([
  ["approval_policy", '"on-request"'],
  ["sandbox_mode", '"workspace-write"'],
]);

const missing = [...defaults.entries()].filter(([key]) => !new RegExp(`^${key}\\s*=`, "m").test(text));
if (!missing.length) process.exit(0);

const lines = text.split(/\r?\n/);
let insertAt = lines.findIndex((line) => /^\[[^\]]+\]\s*$/.test(line));
if (insertAt < 0) insertAt = lines.length;
while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
lines.splice(insertAt, 0, ...missing.map(([key, value]) => `${key} = ${value}`), "");
fs.mkdirSync(require("node:path").dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${lines.join("\n").replace(/\n+$/g, "")}\n`, "utf8");
'@ | Out-Null
}

function Ensure-DeepCodexUiStateDefaults {
    Invoke-NodeStdin -Arguments @((Join-Path $CODEX_HOME_DIR ".codex-global-state.json")) -Script @'
const fs = require("fs");
const [statePath] = process.argv.slice(2);
let state = {};
try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
state["electron-persisted-atom-state"] ||= {};
const atom = state["electron-persisted-atom-state"];
atom["composer-permission-mode-visibility"] ||= {
  "guardian-approvals": true,
  "full-access": true,
};
if (atom["skip-full-access-confirm"] === undefined) {
  atom["skip-full-access-confirm"] = true;
}
atom["agent-mode-by-host-id"] ||= {};
if (!atom["agent-mode-by-host-id"].local || atom["agent-mode-by-host-id"].local === "read-only") {
  atom["agent-mode-by-host-id"].local = "auto";
}
atom["heartbeat-thread-permissions-by-id"] ||= {};
const permissions = atom["heartbeat-thread-permissions-by-id"];
const projectlessThreadIds = Array.isArray(state["projectless-thread-ids"])
  ? state["projectless-thread-ids"]
  : [];
const rootHints = state["thread-workspace-root-hints"] && typeof state["thread-workspace-root-hints"] === "object"
  ? state["thread-workspace-root-hints"]
  : {};
const permissionThreadIds = new Set([...projectlessThreadIds, ...Object.keys(rootHints)]);
for (const threadId of permissionThreadIds) {
  if (permissions[threadId]) continue;
  const hintedRoot = typeof rootHints[threadId] === "string" ? rootHints[threadId] : null;
  const writableRoots = hintedRoot ? [hintedRoot] : [];
  permissions[threadId] = {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots,
      excludeSlashTmp: false,
      excludeTmpdirEnvVar: false,
      networkAccess: false,
    },
  };
}
fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
'@ | Out-Null
}

function Sync-GlobalRules {
    $source = Join-Path $GLOBAL_CODEX_HOME "rules"
    $target = Join-Path $CODEX_HOME_DIR "rules"
    if (Test-Path -LiteralPath $source) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Copy-Item -Path (Join-Path $source "*") -Destination $target -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Get-AntiCodexStartupSourceFingerprint {
    if (-not (Test-Path -LiteralPath $PLUGIN_HOST_SYNC -PathType Leaf)) { return $null }
    try {
        $json = & $NODE_BIN $PLUGIN_HOST_SYNC $CODEX_HOME_DIR $GLOBAL_CODEX_HOME --startup-snapshots --print-startup-source-fingerprint 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $json) { return $null }
        $snapshot = ($json -join "`n") | ConvertFrom-Json
        if (-not $snapshot.ok) { return $null }
        return [string]$snapshot.sourceFingerprint
    } catch {
        return $null
    }
}

function Test-AntiCodexStartupSnapshotsReady {
    if (-not $IS_ANTIGRAVITY_MODE) { return $false }
    if ($env:ANTICODEX_FORCE_STARTUP_SNAPSHOTS -eq "1") { return $false }
    if (-not (Test-Path -LiteralPath $ANTICODEX_STARTUP_SNAPSHOT_MARKER -PathType Leaf)) { return $false }

    try {
        $marker = Get-Content -LiteralPath $ANTICODEX_STARTUP_SNAPSHOT_MARKER -Raw | ConvertFrom-Json
        if ([string]$marker.schema -ne "anticodex-startup-snapshots-ready-v1") { return $false }
        if ([IO.Path]::GetFullPath([string]$marker.codexHome) -ne [IO.Path]::GetFullPath($CODEX_HOME_DIR)) { return $false }
        if ([IO.Path]::GetFullPath([string]$marker.sharedCodexHome) -ne [IO.Path]::GetFullPath($GLOBAL_CODEX_HOME)) { return $false }
        $updatedAt = [datetime]::Parse([string]$marker.updatedAt, $null, [Globalization.DateTimeStyles]::RoundtripKind)
        if (((Get-Date).ToUniversalTime() - $updatedAt.ToUniversalTime()).TotalHours -gt $ANTICODEX_STARTUP_SNAPSHOT_MAX_AGE_HOURS) { return $false }
        $currentSourceFingerprint = Get-AntiCodexStartupSourceFingerprint
        if (-not $currentSourceFingerprint) { return $false }
        if ([string]$marker.sourceFingerprint -ne $currentSourceFingerprint) { return $false }
    } catch {
        return $false
    }

    foreach ($relPath in @(
        "skills",
        "AGENTS.md",
        "DEFAULT_SKILL_ALLOWLIST.md",
        "RTK.md",
        "MCP_WORKER_USAGE_GUIDE.md",
        "cache\codex_app_directory",
        "cache\codex_apps_tools"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $CODEX_HOME_DIR $relPath))) { return $false }
    }
    return $true
}

function Sync-AntiCodexStartupSnapshots {
    if (-not $IS_ANTIGRAVITY_MODE) { return }
    if (Test-AntiCodexStartupSnapshotsReady) {
        Write-LifecycleLog "Startup local feature snapshots are already ready; skipped lightweight refresh."
        return
    }
    if (Test-Path -LiteralPath $PLUGIN_HOST_SYNC) {
        & $NODE_BIN $PLUGIN_HOST_SYNC $CODEX_HOME_DIR $GLOBAL_CODEX_HOME --startup-snapshots | Out-Null
    }
}

function Set-DeepCodexRouteIsolation {
    foreach ($name in @(
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "OPENAI_API_HOST",
        "OPENAI_API_URL",
        "OPENAI_ORG_ID",
        "OPENAI_ORGANIZATION",
        "OPENAI_PROJECT_ID",
        "CHATGPT_BASE_URL",
        "CODEX_OPENAI_BASE_URL"
    )) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }

    foreach ($name in @("NO_PROXY", "no_proxy")) {
        $current = [Environment]::GetEnvironmentVariable($name, "Process")
        $extra = "127.0.0.1,localhost,::1,$($env:TRANSLATOR_HOST)"
        if ($current) {
            [Environment]::SetEnvironmentVariable($name, "$current,$extra", "Process")
        } else {
            [Environment]::SetEnvironmentVariable($name, $extra, "Process")
        }
    }
}

$launchStageTimer = New-LaunchStageTimer
$NODE_BIN = Find-NodeBin
if (-not $NODE_BIN) {
    Show-Alert "Node.js was not found. Install Node.js or set NODE_BIN before launching Anti-Codex."
    exit 1
}
$TRANSLATOR_NODE_BIN = Ensure-TranslatorNodeBin $NODE_BIN
$NODE_SHIM_DIR = Ensure-NodeCommandShims $NODE_BIN
Write-LaunchStage "resolve-node-runtime" $launchStageTimer

if ($TranslatorOnly) {
    New-Item -ItemType Directory -Path $DEEPCODEX_STATE_ROOT, $DEEPCODEX_PROJECTS_ROOT -Force | Out-Null
    Set-DeepCodexRouteIsolation

    if ((Test-TranslatorRestartLockActive) -and $env:ANTICODEX_TRANSLATOR_RESTART_LOCK_OWNER -ne "1") {
        Write-TranslatorStartLog "translator-only start found restart lock; waiting for existing restart owner"
        for ($i = 0; $i -lt 30; $i++) {
            if (Test-TranslatorHealth) {
                Write-Host "Anti-Codex translator is ready at $TRANSLATOR_URL."
                exit 0
            }
            if (-not (Test-TranslatorRestartLockActive)) { break }
            Start-Sleep -Seconds 1
        }
    }

    if ($USES_ANTIGRAVITY_UPSTREAM) {
        Remove-Item Env:UPSTREAM_API_KEY -ErrorAction SilentlyContinue
        $env:OPENAI_API_KEY = $LOCAL_CODEX_API_KEY
        $env:CODEX_API_KEY = $LOCAL_CODEX_API_KEY
        if (-not (Use-CachedAntigravityModelCatalog)) {
            $null = Sync-AntigravityModelCatalog $NODE_BIN
        }
        Seed-RuntimeDefaults
        try { Sync-AntiCodexStartupSnapshots } catch {}
    }
    $env:UPSTREAM_URL = if ($env:UPSTREAM_URL) { $env:UPSTREAM_URL } else { "https://api.deepseek.com/v1" }
    $env:TRANSLATOR_PROFILE_PATH = $PROVIDER_PROFILE_PATH
    $env:TRANSLATOR_HOST = if ($env:TRANSLATOR_HOST) { $env:TRANSLATOR_HOST } else { "127.0.0.1" }
    $env:CODEX_ELECTRON_USER_DATA_PATH = $ELECTRON_USER_DATA
    $env:DEEP_CODEX_ENV_FILE = $DEEP_CODEX_ENV_FILE

    Stop-StaleDeepCodexTranslator
    Stop-DeepCodexTranslatorOnPort 8282
    Start-Sleep -Milliseconds 200
    $TRANSLATOR_PORT = if ($env:TRANSLATOR_PORT) { [int]$env:TRANSLATOR_PORT } else { Select-LoopbackPort 8282 }
    if ($env:TRANSLATOR_PORT) { Stop-DeepCodexTranslatorOnPort $TRANSLATOR_PORT }
    $TRANSLATOR_URL = if ($env:TRANSLATOR_URL) { $env:TRANSLATOR_URL } else { "http://127.0.0.1:$TRANSLATOR_PORT" }
    $env:TRANSLATOR_PORT = "$TRANSLATOR_PORT"

    if (-not (Test-TranslatorHealth)) {
        Clear-TranslatorRuntimeLogs
        $TRANSLATOR_PROC = Start-TranslatorProcess $TRANSLATOR_NODE_BIN
        Start-Sleep -Milliseconds 700
        if (-not (Test-TranslatorHealth) -and ($TRANSLATOR_NODE_BIN -ne $NODE_BIN)) {
            if ($TRANSLATOR_PROC -and -not $TRANSLATOR_PROC.HasExited) {
                Write-TranslatorStartLog "dedicated translator still starting; waiting for health"
            } else {
                Write-TranslatorStartLog "dedicated translator exited before health; falling back to $NODE_BIN"
                Stop-StaleDeepCodexTranslator
                Stop-DeepCodexTranslatorOnPort $TRANSLATOR_PORT
                $TRANSLATOR_PROC = Start-TranslatorProcess $NODE_BIN
            }
        }
    }

    $ready = $false
    $fallbackTried = $false
    for ($i = 0; $i -lt 45; $i++) {
        if (Test-TranslatorHealth) { $ready = $true; break }
        if ((-not $fallbackTried) -and ($TRANSLATOR_NODE_BIN -ne $NODE_BIN) -and $TRANSLATOR_PROC -and $TRANSLATOR_PROC.HasExited) {
            $fallbackTried = $true
            Write-TranslatorStartLog "dedicated translator exited while waiting; falling back to $NODE_BIN"
            Stop-StaleDeepCodexTranslator
            Stop-DeepCodexTranslatorOnPort $TRANSLATOR_PORT
            $TRANSLATOR_PROC = Start-TranslatorProcess $NODE_BIN
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        $detail = if (Test-Path -LiteralPath $TRANSLATOR_ERR_LOG) { (Get-Content -LiteralPath $TRANSLATOR_ERR_LOG -Tail 25) -join "`n" } else { "" }
        if ($TRANSLATOR_PROC -and -not $TRANSLATOR_PROC.HasExited) { try { $TRANSLATOR_PROC.Kill() } catch {} }
        Show-Alert "Translator failed to start.`n`n$detail`n`nLogs: $TRANSLATOR_ERR_LOG"
        exit 1
    }

    Write-Host "Anti-Codex translator is ready at $TRANSLATOR_URL."
    exit 0
}

$CODEX_BIN = Find-CodexBin
if (-not $CODEX_BIN) {
    Show-Alert "Codex Desktop was not found. Install Codex first, or set CODEX_BIN to Codex.exe."
    exit 1
}

$launchStageTimer = New-LaunchStageTimer
New-Item -ItemType Directory -Path $DEEPCODEX_STATE_ROOT -Force | Out-Null
New-Item -ItemType Directory -Path $DEEPCODEX_PROJECTS_ROOT -Force | Out-Null
if ($USES_ANTIGRAVITY_UPSTREAM -and -not (Use-CachedAntigravityModelCatalog)) {
    $null = Sync-AntigravityModelCatalog $NODE_BIN
}
Seed-RuntimeDefaults
Seed-OnboardingState
Write-LaunchStage "prepare-state-and-models" $launchStageTimer

if (-not $DEEPCODEX_SKIP_PLUGIN_SYNC) {
    $launchStageTimer = New-LaunchStageTimer
    try {
        $pluginHostLog = Join-Path $DEEPCODEX_STATE_ROOT "deepcodex-plugin-host-sync.log"
        & $NODE_BIN $PLUGIN_HOST_SYNC $CODEX_HOME_DIR $GLOBAL_CODEX_HOME *> $pluginHostLog
    } catch {
        try {
            $_ | Out-String | Set-Content -LiteralPath (Join-Path $DEEPCODEX_STATE_ROOT "deepcodex-plugin-host-sync.err.log") -Encoding UTF8
        } catch {}
    }
    Write-LaunchStage "sync-plugin-host" $launchStageTimer
} elseif ($IS_ANTIGRAVITY_MODE -and (Test-Path -LiteralPath $PLUGIN_HOST_SYNC)) {
    $launchStageTimer = New-LaunchStageTimer
    try { Sync-AntiCodexStartupSnapshots } catch {}
    Write-LaunchStage "sync-local-feature-snapshots" $launchStageTimer
}

$UPSTREAM_API_KEY = if ($USES_ANTIGRAVITY_UPSTREAM) { "" } elseif ($env:UPSTREAM_API_KEY) { $env:UPSTREAM_API_KEY } else { Read-DeepSeekKey }

if (-not $USES_ANTIGRAVITY_UPSTREAM -and -not $UPSTREAM_API_KEY) {
    if (-not (Test-Path -LiteralPath $SETUP_UI_SCRIPT)) {
        Show-Alert "Anti-Codex setup page is missing: $SETUP_UI_SCRIPT"
        exit 1
    }

    $env:NODE_BIN = $NODE_BIN
    $env:DEEPCODEX_PROVIDER_PROFILE = $PROVIDER_PROFILE_PATH
    $env:DEEPCODEX_SETUP_SERVER_ONLY = "1"
    Remove-Item -LiteralPath $SETUP_OUT_LOG, $SETUP_ERR_LOG -Force -ErrorAction SilentlyContinue
    $setupProc = Start-Process -FilePath $NODE_BIN `
        -ArgumentList @($SETUP_UI_SCRIPT) `
        -RedirectStandardOutput $SETUP_OUT_LOG `
        -RedirectStandardError $SETUP_ERR_LOG `
        -PassThru -WindowStyle Hidden

    $setupUrl = ""
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-Path -LiteralPath $SETUP_ERR_LOG) {
            $err = Get-Content -LiteralPath $SETUP_ERR_LOG -Raw -ErrorAction SilentlyContinue
            if ($err -match "DEEPCODEX_SETUP_URL=(http://[^\s]+)") {
                $setupUrl = $Matches[1]
                break
            }
        }
    }
    if ($setupUrl) { Open-SetupWindow $setupUrl } else { Open-SetupWindow "http://127.0.0.1:9999/" }
    $setupProc | Wait-Process -Timeout 300 -ErrorAction SilentlyContinue
    if (-not $setupProc.HasExited) {
        try { $setupProc.Kill() } catch {}
        exit 0
    }
    if ($setupProc.ExitCode -eq 0 -and (Test-Path -LiteralPath $SETUP_OUT_LOG)) {
        $UPSTREAM_API_KEY = (Get-Content -LiteralPath $SETUP_OUT_LOG -Raw).Trim()
        if ($UPSTREAM_API_KEY) { Save-DeepSeekKey $UPSTREAM_API_KEY }
    }
    if ($UPSTREAM_API_KEY) { Stop-SetupWindow }
    if (-not $UPSTREAM_API_KEY) {
        exit 0
    }
}

Write-PseudoLoginAuth
Set-DeepCodexRouteIsolation

if ($IS_ANTIGRAVITY_MODE) {
    $env:OPENAI_API_KEY = $LOCAL_CODEX_API_KEY
    $env:CODEX_API_KEY = $LOCAL_CODEX_API_KEY
}
if ($USES_ANTIGRAVITY_UPSTREAM) {
    Remove-Item Env:UPSTREAM_API_KEY -ErrorAction SilentlyContinue
} else {
    $env:UPSTREAM_API_KEY = $UPSTREAM_API_KEY
}
$env:UPSTREAM_URL = if ($env:UPSTREAM_URL) { $env:UPSTREAM_URL } else { "https://api.deepseek.com/v1" }
$env:TRANSLATOR_PROFILE_PATH = $PROVIDER_PROFILE_PATH
$env:TRANSLATOR_HOST = if ($env:TRANSLATOR_HOST) { $env:TRANSLATOR_HOST } else { "127.0.0.1" }
Stop-StaleDeepCodexTranslator
Stop-DeepCodexTranslatorOnPort 8282
Start-Sleep -Milliseconds 200
$TRANSLATOR_PORT = if ($env:TRANSLATOR_PORT) { [int]$env:TRANSLATOR_PORT } else { Select-LoopbackPort 8282 }
if ($env:TRANSLATOR_PORT) { Stop-DeepCodexTranslatorOnPort $TRANSLATOR_PORT }
$TRANSLATOR_URL = if ($env:TRANSLATOR_URL) { $env:TRANSLATOR_URL } else { "http://127.0.0.1:$TRANSLATOR_PORT" }
$env:TRANSLATOR_PORT = "$TRANSLATOR_PORT"
$env:TRANSLATOR_URL = $TRANSLATOR_URL
$env:CODEX_ELECTRON_USER_DATA_PATH = $ELECTRON_USER_DATA
$env:DEEP_CODEX_ENV_FILE = $DEEP_CODEX_ENV_FILE
$DEEPCODEX_CDP_PORT = Select-LoopbackPort $DEEPCODEX_CDP_PORT

$launchStageTimer = New-LaunchStageTimer
if (-not (Test-TranslatorHealth)) {
    Clear-TranslatorRuntimeLogs
    $TRANSLATOR_PROC = Start-TranslatorProcess $TRANSLATOR_NODE_BIN
    Start-Sleep -Milliseconds 700
    if (-not (Test-TranslatorHealth) -and ($TRANSLATOR_NODE_BIN -ne $NODE_BIN)) {
        if ($TRANSLATOR_PROC -and -not $TRANSLATOR_PROC.HasExited) {
            Write-TranslatorStartLog "dedicated translator still starting; waiting for health"
        } else {
            Write-TranslatorStartLog "dedicated translator exited before health; falling back to $NODE_BIN"
            Stop-StaleDeepCodexTranslator
            Stop-DeepCodexTranslatorOnPort $TRANSLATOR_PORT
            $TRANSLATOR_PROC = Start-TranslatorProcess $NODE_BIN
        }
    }
}

$ready = $false
$fallbackTried = $false
for ($i = 0; $i -lt 45; $i++) {
    if (Test-TranslatorHealth) { $ready = $true; break }
    if ((-not $fallbackTried) -and ($TRANSLATOR_NODE_BIN -ne $NODE_BIN) -and $TRANSLATOR_PROC -and $TRANSLATOR_PROC.HasExited) {
        $fallbackTried = $true
        Write-TranslatorStartLog "dedicated translator exited while waiting; falling back to $NODE_BIN"
        Stop-StaleDeepCodexTranslator
        Stop-DeepCodexTranslatorOnPort $TRANSLATOR_PORT
        $TRANSLATOR_PROC = Start-TranslatorProcess $NODE_BIN
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    $detail = if (Test-Path -LiteralPath $TRANSLATOR_ERR_LOG) { (Get-Content -LiteralPath $TRANSLATOR_ERR_LOG -Tail 25) -join "`n" } else { "" }
    if ($TRANSLATOR_PROC -and -not $TRANSLATOR_PROC.HasExited) { try { $TRANSLATOR_PROC.Kill() } catch {} }
    Show-Alert "Translator failed to start.`n`n$detail`n`nLogs: $TRANSLATOR_ERR_LOG"
    exit 1
}
Write-LaunchStage "translator-ready" $launchStageTimer

if ($TranslatorOnly) {
    Write-Host "Anti-Codex translator is ready at $TRANSLATOR_URL."
    $PRESERVE_TRANSLATOR_ON_EXIT = $true
    exit 0
}

New-Item -ItemType Directory -Path $CODEX_HOME_DIR, $ELECTRON_USER_DATA -Force | Out-Null
$configToml = Join-Path $CODEX_HOME_DIR "config.toml"
$backupToml = Join-Path $CODEX_HOME_DIR "config.toml.before-adaptive-oneapi"
$previousToml = Join-Path $CODEX_HOME_DIR "config.toml.before-deepcodex-start"
if ((Test-Path -LiteralPath $configToml) -and (-not (Test-Path -LiteralPath $backupToml))) {
    Copy-Item -LiteralPath $configToml -Destination $backupToml
}
if (Test-Path -LiteralPath $configToml) {
    Copy-Item -LiteralPath $configToml -Destination $previousToml -Force
}
Copy-Item -LiteralPath (Join-Path $CODEX_HOME_DIR "config.adaptive-oneapi.toml") -Destination $configToml -Force
Invoke-NodeStdin -Arguments @($configToml, (Join-Path $CODEX_HOME_DIR "deepseek-model-catalog.json"), $TRANSLATOR_URL) -Script @'
const fs = require("fs");
const [configPath, catalogPath, translatorUrl] = process.argv.slice(2);
let text = fs.readFileSync(configPath, "utf8");
text = text.replace(/__DEEPCODEX_MODEL_CATALOG__/g, catalogPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
if (translatorUrl) {
  const escaped = translatorUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  text = text.replace(/^openai_base_url\s*=\s*".*"$/m, `openai_base_url = "${escaped}"`);
  text = text.replace(/^chatgpt_base_url\s*=\s*".*"$/m, `chatgpt_base_url = "${escaped}/backend-api/"`);
}
fs.writeFileSync(configPath, text);
'@ | Out-Null

$globalConfig = Join-Path $GLOBAL_CODEX_HOME "config.toml"
if (Test-Path -LiteralPath $globalConfig) {
    try {
        & $NODE_BIN $SHARED_CONFIG_SYNC $globalConfig $configToml | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-LifecycleLog "Shared Codex config sync failed with exit code $LASTEXITCODE." }
    } catch {
        Write-LifecycleLog "Shared Codex config sync failed: $($_.Exception.Message)"
    }
}
if ($DEEPCODEX_SKIP_PLUGIN_SYNC) {
    Strip-PluginMarketplaceConfig $configToml
} elseif ((Test-Path -LiteralPath $previousToml) -and (Test-Path -LiteralPath $DEEPCODEX_REGISTRATION_SYNC)) {
    $registrationArgs = @($configToml, $previousToml)
    if (-not $IS_ANTIGRAVITY_MODE) { $registrationArgs += $globalConfig }
    try {
        & $NODE_BIN $DEEPCODEX_REGISTRATION_SYNC @registrationArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-LifecycleLog "Plugin registration sync failed with exit code $LASTEXITCODE." }
    } catch {
        Write-LifecycleLog "Plugin registration sync failed: $($_.Exception.Message)"
    }
}
if (-not $DEEPCODEX_SKIP_PLUGIN_SYNC) {
    foreach ($sync in @(
        @{ Path = $DEEPCODEX_PLUGINS_SYNC; Args = @($CODEX_HOME_DIR, $configToml, $GLOBAL_CODEX_HOME) },
        @{ Path = $DEEPCODEX_APP_TOOLS_SYNC; Args = @($CODEX_HOME_DIR, $GLOBAL_CODEX_HOME) },
        @{ Path = $DEEPCODEX_SIDECARS_SYNC; Args = @($GLOBAL_CODEX_HOME, $CODEX_HOME_DIR, $globalConfig, $configToml) }
    )) {
        if (Test-Path -LiteralPath $sync.Path) {
            try {
                & $NODE_BIN $sync.Path @($sync.Args) | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Write-LifecycleLog "Optional local feature sync failed for $($sync.Path) with exit code $LASTEXITCODE."
                }
            } catch {
                Write-LifecycleLog "Optional local feature sync failed for $($sync.Path): $($_.Exception.Message)"
            }
        }
    }
}
Invoke-NodeStdin -Arguments @($configToml) -Script @'
const fs = require("fs");
const [configPath] = process.argv.slice(2);
let text = fs.readFileSync(configPath, "utf8");
const blockRe = /(\[mcp_servers\.deepseek-code-worker\][\s\S]*?enabled\s*=\s*)(true|false)/;
if (blockRe.test(text)) {
  text = text.replace(blockRe, "$1false");
  fs.writeFileSync(configPath, text);
}
'@ | Out-Null
Ensure-DeepCodexCoreConfig
if (-not $IS_ANTIGRAVITY_MODE) { Ensure-GlobalPermissionDefaults }
Ensure-DeepCodexUiStateDefaults
Sync-GlobalRules

$env:CODEX_HOME = $CODEX_HOME_DIR
if (-not (Protect-AntiCodexLogDb)) {
    throw "Anti-Codex log database guard failed; refusing to continue startup."
}
$env:CODEX_APP_SERVER_FORCE_CLI = "1"
Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
$env:LANG = "zh_CN.UTF-8"
$env:LC_ALL = "zh_CN.UTF-8"
$codexArgs = @(
    "--user-data-dir=$ELECTRON_USER_DATA",
    "--remote-debugging-port=$DEEPCODEX_CDP_PORT",
    "--remote-allow-origins=http://127.0.0.1:$DEEPCODEX_CDP_PORT",
    "--no-sandbox",
    "--lang=zh-CN"
)
if ($env:DEEPCODEX_DISABLE_GPU -eq "1") {
    $codexArgs += @("--disable-gpu", "--disable-gpu-compositing", "--disable-gpu-sandbox", "--in-process-gpu")
}
if ($DEEPCODEX_WORKSPACE) {
    New-Item -ItemType Directory -Path $DEEPCODEX_WORKSPACE -Force | Out-Null
    Trust-Workspace $DEEPCODEX_WORKSPACE
    $codexArgs += $DEEPCODEX_WORKSPACE
}

function Ensure-AntigravityDesktopRunning {
    if (-not $USES_ANTIGRAVITY_UPSTREAM) { return $true }
    $running = Get-AntigravityMainProcess
    if ($running) {
        $env:ANTIGRAVITY_DESKTOP_PATH = [string]$running.ExecutablePath
        $script:antigravityRestartNotBefore = [DateTime]::MinValue
        return $true
    }

    $now = [DateTime]::UtcNow
    if ($now -lt $script:antigravityRestartNotBefore) {
        if (($now - $script:lastAntigravityDeferredLog).TotalSeconds -ge 30) {
            Write-LifecycleLog "Antigravity Desktop restart deferred until $($script:antigravityRestartNotBefore.ToString("o"))."
            $script:lastAntigravityDeferredLog = $now
        }
        return $false
    }

    $desktopPath = Resolve-AntigravityDesktopPath
    $script:antigravityRestartNotBefore = $now.AddSeconds($ANTIGRAVITY_RESTART_COOLDOWN_SECONDS)
    if (-not $desktopPath) {
        Write-LifecycleLog "Antigravity Desktop process disappeared; restart failed because the executable was not found."
        return $false
    }
    $env:ANTIGRAVITY_DESKTOP_PATH = $desktopPath

    Write-LifecycleLog "Antigravity Desktop process disappeared; restarting."
    try {
        Start-Process -FilePath $desktopPath | Out-Null
    } catch {
        Write-LifecycleLog "Antigravity Desktop restart failed: $($_.Exception.Message)"
        return $false
    }

    $startup = Wait-AntigravityDesktopStable -ExecutablePath $desktopPath -TimeoutSeconds 30 -StableSeconds $ANTIGRAVITY_START_STABLE_SECONDS
    if ($startup.Stable) {
        $script:antigravityRestartNotBefore = [DateTime]::MinValue
        Write-LifecycleLog "Antigravity Desktop restart succeeded (PID: $($startup.Process.ProcessId))."
        return $true
    }
    if ($startup.Observed) {
        Write-LifecycleLog "Antigravity Desktop restart candidate exited before becoming stable."
    } else {
        Write-LifecycleLog "Antigravity Desktop restart failed: process was not detected before timeout."
    }
    return $false
}

$MAX_RESTARTS = 3
$RESTART_BACKOFF_SECONDS = 2
$RESTART_RESET_SECONDS = 300
$ANTIGRAVITY_RESTART_COOLDOWN_SECONDS = 60
$ANTIGRAVITY_START_STABLE_SECONDS = 8
$script:antigravityRestartNotBefore = [DateTime]::MinValue
$script:lastAntigravityDeferredLog = [DateTime]::MinValue
$restartCount = 0
$normalClose = $false
$launcherPid = $PID
if ($env:DEEPCODEX_LAUNCHER_PID -match "^\d+$") {
    $launcherPid = [int]$env:DEEPCODEX_LAUNCHER_PID
}
$codexWorkingDirectory = Split-Path -Parent $CODEX_BIN

try {
    while ($true) {
        $script:managerInjected = $false
        $script:pluginUnlockInjected = $false
        $script:managerInjectAttempts = 0
        $script:pluginUnlockInjectAttempts = 0

        Write-Host "Launching Anti-Codex."
        Write-Host "  Codex:     $CODEX_BIN"
        Write-Host "  Translator:$TRANSLATOR_URL"
        Write-Host "  CODEX_HOME:$CODEX_HOME_DIR"
        Write-Host "  Shims:     $NODE_SHIM_DIR"
        Write-Host "  CDP:       http://127.0.0.1:$DEEPCODEX_CDP_PORT"
        $launchStageTimer = New-LaunchStageTimer
        if ($codexArgs.Count -gt 0) {
            $codexProc = Start-Process -FilePath $CODEX_BIN -ArgumentList $codexArgs -WorkingDirectory $codexWorkingDirectory -PassThru
        } else {
            $codexProc = Start-Process -FilePath $CODEX_BIN -WorkingDirectory $codexWorkingDirectory -PassThru
        }
        Write-LaunchStage "start-desktop-process" $launchStageTimer
        $launchStartedAt = [DateTime]::UtcNow

        if ($restartCount -eq 0) {
            Write-LifecycleLog "Main process started (PID: $($codexProc.Id))."
        } else {
            Write-LifecycleLog "Auto-restart process launched (PID: $($codexProc.Id))."
        }

        if (-not ($DEEPCODEX_PLUGIN_UNLOCK_ENABLED -and (Test-Path -LiteralPath $DEEPCODEX_CDP_INJECT) -and (Test-Path -LiteralPath $DEEPCODEX_PLUGIN_UNLOCK_INJECT))) {
            Write-Host "  Plugin UI unlock injection: disabled"
        }
        $launchStageTimer = New-LaunchStageTimer
        Invoke-CdpInjectionsIfNeeded
        Write-LaunchStage "initial-cdp-injection" $launchStageTimer

        $mainWindowHandle = [IntPtr]::Zero
        $windowProbeUntil = [DateTime]::UtcNow.AddSeconds(30)
        $launchStageTimer = New-LaunchStageTimer
        while ($mainWindowHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $windowProbeUntil -and -not $codexProc.HasExited) {
            Start-Sleep -Milliseconds 500
            $mainWindowHandle = Get-MainWindowHandleForProcess -ProcessId $codexProc.Id
            Invoke-CdpInjectionsIfNeeded
        }
        Write-LaunchStage "wait-main-window" $launchStageTimer

        if ($mainWindowHandle -ne [IntPtr]::Zero) {
            Write-Host "  Main window: $mainWindowHandle"
            Write-Host ""
            if ($IS_ANTIGRAVITY_MODE) {
                Write-Host "================================================"
                Write-Host "  Anti-Codex launched successfully!"
                Write-Host "================================================"
            } else {
                Write-Host "================================================"
                Write-Host "  Anti-Codex launched successfully!"
                Write-Host "================================================"
            }
            Write-Host "  Background watcher PID: $PID"
            Write-Host "  This process keeps the translator alive."
            Write-Host ""
            Write-LifecycleLog "Main window detected; launch successful."
            if ($restartCount -gt 0) {
                Write-LifecycleLog "Auto-restart succeeded (PID: $($codexProc.Id))."
            }
            $clearedKeyAfterLogout = $false
            $translatorWatchNext = [DateTime]::UtcNow.AddSeconds(5)
            $translatorRecoveryCooldownUntil = [DateTime]::MinValue
            $managerBridgeWatchNext = [DateTime]::UtcNow.AddSeconds(5)
            $managerBridgeRecoveryCooldownUntil = [DateTime]::MinValue
            $antigravityWatchNext = [DateTime]::UtcNow.AddSeconds(5)
            $antigravityCatalogWatchNext = [DateTime]::UtcNow.AddSeconds(15)
            $antigravityCatalogRefreshCooldownUntil = [DateTime]::MinValue
            $accountReadinessObserved = $false
            $previousAccountReady = $null
            $injectCheckNext = [DateTime]::UtcNow
            while (-not $codexProc.HasExited) {
                Start-Sleep -Seconds 1
                if ([DateTime]::UtcNow -ge $injectCheckNext) {
                    $injectCheckNext = [DateTime]::UtcNow.AddSeconds(3)
                    Invoke-CdpInjectionsIfNeeded
                }
                if (Test-Path -LiteralPath $ANTICODEX_HOST_SYNC_MARKER) {
                    Write-LifecycleLog "Host sync requested; launcher will not auto-restart."
                    if (-not $codexProc.HasExited) {
                        try { Stop-Process -Id $codexProc.Id -Force -ErrorAction SilentlyContinue } catch {}
                    }
                    $normalClose = $true
                    break
                }
                if ($restartCount -gt 0 -and ([DateTime]::UtcNow - $launchStartedAt).TotalSeconds -ge $RESTART_RESET_SECONDS) {
                    $restartCount = 0
                    Write-LifecycleLog "Restart counter reset after stable runtime."
                }
                if ($launcherPid -ne $PID -and -not (Get-Process -Id $launcherPid -ErrorAction SilentlyContinue)) {
                    try { Stop-Process -Id $codexProc.Id -Force -ErrorAction SilentlyContinue } catch {}
                    $normalClose = $true
                    break
                }
                if ($mainWindowHandle -ne [IntPtr]::Zero -and -not (Test-WindowHandleExists -Handle $mainWindowHandle)) {
                    try { [void](Wait-AntiCodexChildProcess -Process $codexProc -TimeoutMs 2000) } catch {}
                    if ($codexProc.HasExited -and $codexProc.ExitCode -ne 0) {
                        Write-LifecycleLog "Window disappeared before a non-zero process exit (ExitCode: $($codexProc.ExitCode))."
                    } else {
                        Write-Host "Anti-Codex main window closed; stopping background processes."
                        Write-LifecycleLog "Normal window close detected."
                        if (-not $codexProc.HasExited) {
                            try { Stop-Process -Id $codexProc.Id -Force -ErrorAction SilentlyContinue } catch {}
                        }
                        $normalClose = $true
                    }
                    break
                }
                if (-not $IS_ANTIGRAVITY_MODE -and -not $clearedKeyAfterLogout -and -not (Test-PseudoLoginAuth)) {
                    Clear-DeepSeekKey
                    $clearedKeyAfterLogout = $true
                    Write-Host "Anti-Codex logout detected; DeepSeek API key cleared."
                }
                if ([DateTime]::UtcNow -ge $translatorWatchNext) {
                    $translatorWatchNext = [DateTime]::UtcNow.AddSeconds(5)
                    Update-AntiCodexUpstreamEnvironment
                    if ([DateTime]::UtcNow -ge $translatorRecoveryCooldownUntil) {
                        if (-not (Ensure-TranslatorRunning -PrimaryRuntimeBin $TRANSLATOR_NODE_BIN -FallbackRuntimeBin $NODE_BIN)) {
                            $translatorRecoveryCooldownUntil = [DateTime]::UtcNow.AddSeconds(30)
                            Write-Host "Translator is unhealthy and could not be restarted by watchdog; retrying after cooldown."
                            Write-LifecycleLog "Translator watchdog restart failed; retrying after 30-second cooldown."
                        } else {
                            $translatorRecoveryCooldownUntil = [DateTime]::MinValue
                        }
                    }
                }
                if ($IS_ANTIGRAVITY_MODE -and [DateTime]::UtcNow -ge $managerBridgeWatchNext) {
                    $managerBridgeWatchNext = [DateTime]::UtcNow.AddSeconds(5)
                    if ([DateTime]::UtcNow -ge $managerBridgeRecoveryCooldownUntil) {
                        if (-not (Ensure-AntiCodexManagerBridgeRunning)) {
                            $managerBridgeRecoveryCooldownUntil = [DateTime]::UtcNow.AddSeconds(30)
                            Write-LifecycleLog "Manager bridge watchdog restart failed; retrying after 30-second cooldown."
                        } else {
                            $managerBridgeRecoveryCooldownUntil = [DateTime]::MinValue
                        }
                    }
                }
                if ([DateTime]::UtcNow -ge $antigravityWatchNext) {
                    $antigravityWatchNext = [DateTime]::UtcNow.AddSeconds(5)
                    if (-not (Ensure-AntigravityDesktopRunning)) {
                        Write-Host "Antigravity Desktop is not running and could not be restarted by watchdog."
                    }
                }
                if ($USES_ANTIGRAVITY_UPSTREAM -and [DateTime]::UtcNow -ge $antigravityCatalogWatchNext) {
                    $antigravityCatalogWatchNext = [DateTime]::UtcNow.AddSeconds(15)
                    $healthSnapshot = Get-TranslatorHealthSnapshot
                    $hasAccountReady = $healthSnapshot -and $null -ne $healthSnapshot.PSObject.Properties["accountReady"]
                    if ($hasAccountReady) {
                        $currentAccountReady = [bool]$healthSnapshot.accountReady
                        if (-not $accountReadinessObserved) {
                            $accountReadinessObserved = $true
                            $previousAccountReady = $currentAccountReady
                        } elseif ($currentAccountReady -eq $true -and $previousAccountReady -ne $true) {
                            if ([DateTime]::UtcNow -ge $antigravityCatalogRefreshCooldownUntil) {
                                if (Refresh-AntigravityCatalogAfterRecovery $NODE_BIN) {
                                    Write-LifecycleLog "Antigravity account recovered; refreshed the isolated model catalog."
                                    $previousAccountReady = $true
                                } else {
                                    Write-LifecycleLog "Antigravity account recovered, but model catalog refresh failed; retrying after cooldown."
                                    $antigravityCatalogRefreshCooldownUntil = [DateTime]::UtcNow.AddSeconds(60)
                                    $previousAccountReady = $false
                                }
                            }
                        } else {
                            $previousAccountReady = $currentAccountReady
                        }
                    }
                }
            }
        } else {
            Write-Host "Anti-Codex main window did not appear."
        }

        if ($normalClose) {
            break
        }

        $exitCode = if ($codexProc.HasExited) { $codexProc.ExitCode } else { "unknown" }
        Write-LifecycleLog "Main process exited unexpectedly (ExitCode: $exitCode)."

        if ($restartCount -lt $MAX_RESTARTS) {
            $restartCount++
            Write-LifecycleLog "Attempting auto-restart (Attempt $restartCount of $MAX_RESTARTS) after $RESTART_BACKOFF_SECONDS seconds backoff."
            Start-Sleep -Seconds $RESTART_BACKOFF_SECONDS
        } else {
            Write-LifecycleLog "Auto-restart failed: max retry limit ($MAX_RESTARTS) reached."
            if ($mainWindowHandle -eq [IntPtr]::Zero) {
                if ($TRANSLATOR_PROC -and -not $TRANSLATOR_PROC.HasExited) { try { $TRANSLATOR_PROC.Kill() } catch {} }
                Stop-DeepCodexOwnedProcesses -KeepProcessIds @($PID)
                Show-Alert "Anti-Codex started but no window appeared. Please launch Anti-Codex from the desktop shortcut or Start Menu, not from a remote SSH session."
            }
            exit 1
        }
    }
} finally {
    if (-not $PRESERVE_TRANSLATOR_ON_EXIT) {
        if ($TRANSLATOR_PROC -and -not $TRANSLATOR_PROC.HasExited) {
            try { $TRANSLATOR_PROC.Kill() } catch {}
        }
        Stop-StaleDeepCodexTranslator
        Stop-DeepCodexOwnedProcesses -KeepProcessIds @($PID, $launcherPid)
    }
    if ($DEEPCODEX_START_MUTEX_HELD -and $DEEPCODEX_START_MUTEX) {
        try { $DEEPCODEX_START_MUTEX.ReleaseMutex() } catch {}
    }
    if ($DEEPCODEX_START_MUTEX) {
        try { $DEEPCODEX_START_MUTEX.Dispose() } catch {}
    }
}
