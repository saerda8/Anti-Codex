#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipUpdateCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$FIXED_ROUTE_HEALTH_PORT = 18487
$FIXED_ROUTE_HEALTH_URL = "http://127.0.0.1:$FIXED_ROUTE_HEALTH_PORT/anticodex/fixed-route/health"
$FIXED_ROUTE_HEALTH_TIMEOUT_MS = if ($env:ANTICODEX_FIXED_ROUTE_HEALTH_TIMEOUT_MS) {
    [Math]::Max(1000, [int]$env:ANTICODEX_FIXED_ROUTE_HEALTH_TIMEOUT_MS)
} else {
    5000
}

function Resolve-AntiCodexPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd("\")
}

function Invoke-InstalledAntiCodexLauncherIfAvailable {
    $installedLauncher = Join-Path (Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime\scripts") "start-anticodex.ps1"
    if (-not (Test-Path -LiteralPath $installedLauncher -PathType Leaf)) { return }

    $currentLauncher = Resolve-AntiCodexPath $PSCommandPath
    $installedLauncher = Resolve-AntiCodexPath $installedLauncher
    if ($currentLauncher.Equals($installedLauncher, [StringComparison]::OrdinalIgnoreCase)) { return }

    $forwardArgs = @{}
    if ($SkipUpdateCheck) { $forwardArgs.SkipUpdateCheck = $true }
    & $installedLauncher @forwardArgs
    $exitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
    exit $exitCode
}

function Resolve-AntiCodexInstallRoot {
    $scriptParent = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    return [IO.Path]::GetFullPath((Split-Path -Parent $scriptParent))
}

function Get-RunningAntiCodexMain {
    param([Parameter(Mandatory = $true)][string]$MainExecutable)
    $mainPath = [IO.Path]::GetFullPath($MainExecutable)
    return Get-CimInstance Win32_Process -Filter "Name='Anti-Codex.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and
        ([IO.Path]::GetFullPath([string]$_.ExecutablePath)).Equals($mainPath, [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$_.CommandLine) -notmatch "(^|\s)--type="
    } | Select-Object -First 1
}

function Get-RunningFixedRouteSupervisor {
    param([Parameter(Mandatory = $true)][string]$SupervisorScript)
    $scriptName = [regex]::Escape((Split-Path -Leaf $SupervisorScript))
    return Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        [string]$_.CommandLine -match $scriptName
    } | Select-Object -First 1
}

function Activate-AntiCodexWindow {
    param($Process)
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.AppActivate([int]$Process.ProcessId)
    } catch {}
}

function Get-AntiCodexJson {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [int]$TimeoutMs = 5000
    )
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.WebRequest]::Create($Url)
        $request.Proxy = $null
        $request.Timeout = $TimeoutMs
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) { return $null }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } catch {
        return $null
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Get-AntiCodexFixedRouteHealth {
    return Get-AntiCodexJson -Url $FIXED_ROUTE_HEALTH_URL -TimeoutMs $FIXED_ROUTE_HEALTH_TIMEOUT_MS
}

function Test-AntiCodexFixedRouteMatches {
    param(
        $Health,
        [Parameter(Mandatory = $true)][string]$Provider,
        [Parameter(Mandatory = $true)][string]$Model
    )
    if (-not $Health -or -not $Health.ok -or [string]$Health.state -ne "ready") { return $false }
    return ([string]$Health.provider -eq $Provider) -and ([string]$Health.model -eq $Model)
}

function Ensure-AntigravityDesktop {
    $desktopHelper = Join-Path $PSScriptRoot "antigravity-desktop.ps1"
    if (-not (Test-Path -LiteralPath $desktopHelper -PathType Leaf)) {
        throw "Anti-Codex could not find its Antigravity Desktop helper."
    }
    . $desktopHelper

    $antigravityProcess = Get-AntigravityMainProcess
    if ($antigravityProcess) {
        $env:ANTIGRAVITY_DESKTOP_PATH = [string]$antigravityProcess.ExecutablePath
        return
    }
    $antigravityPath = Resolve-AntigravityDesktopPath
    if (-not $antigravityPath) {
        throw "Antigravity Desktop is not running and no installed executable was found."
    }
    $env:ANTIGRAVITY_DESKTOP_PATH = $antigravityPath
    Start-Process -FilePath $antigravityPath | Out-Null
    $startup = Wait-AntigravityDesktopStable -ExecutablePath $antigravityPath -TimeoutSeconds 30 -StableSeconds 8
    if (-not $startup.Stable) {
        throw "Antigravity Desktop did not remain running long enough for Anti-Codex."
    }
}

function Read-AntiCodexRuntimeProfile {
    param([Parameter(Mandatory = $true)][string]$StateRoot)
    $profileScript = Join-Path $PSScriptRoot "anticodex-upstream-profile.ps1"
    if (-not (Test-Path -LiteralPath $profileScript -PathType Leaf)) { return $null }
    try {
        return (& $profileScript -Action GetRuntime -StateRoot $StateRoot | ConvertFrom-Json)
    } catch {
        throw "Anti-Codex upstream profile could not be read; refusing a silent provider fallback. $($_.Exception.Message)"
    }
}

function Set-AntiCodexProviderEnvironment {
    param($RuntimeProfile)
    $provider = "antigravity"
    $model = if ($env:ANTICODEX_MODEL) { [string]$env:ANTICODEX_MODEL } else { "gemini-3-flash-agent" }

    if ($RuntimeProfile -and [string]$RuntimeProfile.mode -eq "third-party") {
        $protocol = [string]$RuntimeProfile.protocol
        $supportedProtocols = @("openai-compatible", "chat", "chat-completions", "responses")
        if ($supportedProtocols -notcontains $protocol) {
            throw "The saved third-party protocol '$protocol' is not supported by CodexPlusPlus. Use Chat Completions or Responses."
        }
        if (-not $RuntimeProfile.baseUrl -or -not $RuntimeProfile.apiKey -or -not $RuntimeProfile.model) {
            throw "The saved third-party profile is incomplete."
        }
        $provider = "third-party"
        $model = [string]$RuntimeProfile.model
        $env:UPSTREAM_PROTOCOL = $protocol
        $env:UPSTREAM_URL = [string]$RuntimeProfile.baseUrl
        $env:UPSTREAM_MODEL = $model
        $env:UPSTREAM_API_KEY = [string]$RuntimeProfile.apiKey
    } else {
        Remove-Item Env:UPSTREAM_PROTOCOL -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_URL -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_MODEL -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_API_KEY -ErrorAction SilentlyContinue
    }

    $env:ANTICODEX_PROVIDER = $provider
    $env:ANTICODEX_MODEL = $model
    return [pscustomobject]@{ provider = $provider; model = $model }
}

function Wait-AntiCodexFixedRouteReady {
    param(
        [Parameter(Mandatory = $true)]$SupervisorProcess,
        [Parameter(Mandatory = $true)][string]$MainExecutable,
        [Parameter(Mandatory = $true)][string]$Provider,
        [Parameter(Mandatory = $true)][string]$Model,
        [int]$TimeoutSeconds = 120
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $health = Get-AntiCodexFixedRouteHealth
        if (Test-AntiCodexFixedRouteMatches -Health $health -Provider $Provider -Model $Model) {
            $main = Get-RunningAntiCodexMain -MainExecutable $MainExecutable
            if ($main) { return [pscustomobject]@{ health = $health; main = $main } }
        }
        if ($SupervisorProcess -is [Diagnostics.Process]) {
            try { $SupervisorProcess.Refresh() } catch {}
            if ($SupervisorProcess.HasExited) { return $null }
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

Invoke-InstalledAntiCodexLauncherIfAvailable

$installRoot = Resolve-AntiCodexInstallRoot
$stateRoot = Join-Path $env:APPDATA "anticodex"
$mainExecutable = [IO.Path]::GetFullPath((Join-Path $installRoot "codex-patched-app\Anti-Codex.exe"))
$supervisorScript = Join-Path $PSScriptRoot "start-anticodex-fixed-route.mjs"
$componentManifest = Join-Path $installRoot "components\codexplusplus\component-manifest.json"

$env:DEEPCODEX_STATE_ROOT = $stateRoot
$env:CODEX_HOME_DIR = Join-Path $stateRoot "codex-home-deepseek-app"
$env:CODEX_HOME = $env:CODEX_HOME_DIR
$env:GLOBAL_CODEX_HOME = Join-Path $env:USERPROFILE ".codex"
$env:DEEPCODEX_SHARED_CODEX_HOME = $env:GLOBAL_CODEX_HOME
$env:DEEPCODEX_CDP_PORT = "18318"
$env:DEEPCODEX_DISABLE_GPU = "1"
$env:ANTICODEX_DISABLE_GPU = "1"
$env:DEEPCODEX_DISPLAY_NAME = "Anti-Codex"
$env:DEEPCODEX_SKIP_PLUGIN_SYNC = "1"
$env:ANTICODEX_MANAGER_API = "http://127.0.0.1:8484"
$env:DEEPCODEX_PROJECTS_ROOT = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "anticodex"
if ($env:DEEPCODEX_WORKSPACE) { $env:ANTICODEX_WORKSPACE = $env:DEEPCODEX_WORKSPACE }

$runtimeProfile = Read-AntiCodexRuntimeProfile -StateRoot $stateRoot
$selection = Set-AntiCodexProviderEnvironment -RuntimeProfile $runtimeProfile

$runningMain = Get-RunningAntiCodexMain -MainExecutable $mainExecutable
if ($runningMain) {
    $fixedHealth = Get-AntiCodexFixedRouteHealth
    if (Test-AntiCodexFixedRouteMatches -Health $fixedHealth -Provider $selection.provider -Model $selection.model) {
        Activate-AntiCodexWindow $runningMain
        exit 0
    }
    Write-Error "Anti-Codex is already open without the requested fixed route. Refusing to launch a second Anti-Codex window; close the current window before switching routes."
    exit 1
}

$updateChecker = Join-Path $PSScriptRoot "check-anticodex-update.ps1"
if ((-not $SkipUpdateCheck) -and (Test-Path -LiteralPath $updateChecker -PathType Leaf)) {
    try {
        $updateStatus = & $updateChecker -InstallRoot $installRoot -StateRoot $stateRoot -Prompt | ConvertFrom-Json
        if ($updateStatus.sync.launched -eq $true) { exit 0 }
    } catch {
        Write-Warning "Anti-Codex update check failed: $($_.Exception.Message)"
    }
}

if (-not (Test-Path -LiteralPath $supervisorScript -PathType Leaf)) {
    Write-Error "Fixed-route supervisor is missing: $supervisorScript"
    exit 1
}
if (-not (Test-Path -LiteralPath $componentManifest -PathType Leaf)) {
    Write-Error "CodexPlusPlus component is not installed: $componentManifest"
    exit 1
}
if (-not (Test-Path -LiteralPath $mainExecutable -PathType Leaf)) {
    Write-Error "Copied Anti-Codex client is missing: $mainExecutable"
    exit 1
}

$existingSupervisor = Get-RunningFixedRouteSupervisor -SupervisorScript $supervisorScript
if ($existingSupervisor) {
    $existingReady = Wait-AntiCodexFixedRouteReady `
        -SupervisorProcess $existingSupervisor `
        -MainExecutable $mainExecutable `
        -Provider $selection.provider `
        -Model $selection.model `
        -TimeoutSeconds 30
    if ($existingReady) {
        Activate-AntiCodexWindow $existingReady.main
        exit 0
    }
    Write-Error "A fixed-route supervisor is already running but did not become ready. Refusing to launch a duplicate."
    exit 1
}

if ($selection.provider -eq "antigravity") {
    Ensure-AntigravityDesktop
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCommand) {
    Write-Error "Node.js is required to start the fixed Anti-Codex route."
    exit 1
}
$nodeExecutable = [string]$nodeCommand.Source

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$logDbGuardScript = Join-Path $PSScriptRoot "protect-anticodex-log-db.mjs"
try {
    if (-not (Test-Path -LiteralPath $logDbGuardScript -PathType Leaf)) {
        throw "log database guard script is missing"
    }
    $guardOutput = @(& $nodeExecutable $logDbGuardScript "--codex-home" $env:CODEX_HOME_DIR "--backup")
    if ($LASTEXITCODE -ne 0) {
        throw (($guardOutput | ForEach-Object { [string]$_ }) -join " ")
    }
    $guardStatus = (($guardOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $guardStatus.ok) {
        throw ([string]$guardStatus.error)
    }
} catch {
    Write-Error "Anti-Codex log database guard failed; refusing to continue startup. $($_.Exception.Message)"
    exit 1
}

$launcherOutLog = Join-Path $stateRoot "anticodex-fixed-route.out.log"
$launcherErrLog = Join-Path $stateRoot "anticodex-fixed-route.err.log"
Remove-Item -LiteralPath $launcherOutLog, $launcherErrLog -Force -ErrorAction SilentlyContinue
$supervisorArgs = @(
    "`"$supervisorScript`"",
    "--install-root", "`"$installRoot`"",
    "--state-root", "`"$stateRoot`"",
    "--provider", $selection.provider,
    "--model", $selection.model,
    "--manager-base-url", $env:ANTICODEX_MANAGER_API,
    "--disable-gpu"
)

$supervisorProcess = Start-Process -FilePath $nodeExecutable `
    -ArgumentList $supervisorArgs `
    -RedirectStandardOutput $launcherOutLog `
    -RedirectStandardError $launcherErrLog `
    -WindowStyle Hidden `
    -PassThru

$ready = Wait-AntiCodexFixedRouteReady `
    -SupervisorProcess $supervisorProcess `
    -MainExecutable $mainExecutable `
    -Provider $selection.provider `
    -Model $selection.model `
    -TimeoutSeconds 120

if (-not $ready) {
    if (-not $supervisorProcess.HasExited) {
        & taskkill.exe /PID $supervisorProcess.Id /T /F 2>$null | Out-Null
    }
    $errorTail = if (Test-Path -LiteralPath $launcherErrLog) {
        (Get-Content -LiteralPath $launcherErrLog -Tail 20 -ErrorAction SilentlyContinue) -join " "
    } else {
        ""
    }
    Write-Error "Anti-Codex fixed route did not become ready. $errorTail"
    exit 1
}

Activate-AntiCodexWindow $ready.main
Write-Host "Anti-Codex fixed route is ready."
Write-Host "  Provider: $($selection.provider)"
Write-Host "  Model:    $($selection.model)"
Write-Host "  Monitor:  $($supervisorProcess.Id)"
exit 0
