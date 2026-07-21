#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipUpdateCheck,
    [switch]$InlineSupervisor,
    [string]$StateRootPath = "",
    [string]$NodeExecutablePath = "",
    [string]$UserProfilePath = ""
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
    if (-not $env:LOCALAPPDATA) { return }
    $installedLauncher = Join-Path (Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime\scripts") "start-anticodex.ps1"
    if (-not (Test-Path -LiteralPath $installedLauncher -PathType Leaf)) { return }

    $currentLauncher = Resolve-AntiCodexPath $PSCommandPath
    $installedLauncher = Resolve-AntiCodexPath $installedLauncher
    if ($currentLauncher.Equals($installedLauncher, [StringComparison]::OrdinalIgnoreCase)) { return }

    $forwardArgs = @{}
    if ($SkipUpdateCheck) { $forwardArgs.SkipUpdateCheck = $true }
    if ($InlineSupervisor) { $forwardArgs.InlineSupervisor = $true }
    if ($StateRootPath) { $forwardArgs.StateRootPath = $StateRootPath }
    if ($NodeExecutablePath) { $forwardArgs.NodeExecutablePath = $NodeExecutablePath }
    if ($UserProfilePath) { $forwardArgs.UserProfilePath = $UserProfilePath }
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
    return Get-Process -Name "Anti-Codex" -ErrorAction SilentlyContinue | Where-Object {
        $path = try { [IO.Path]::GetFullPath([string]$_.Path) } catch { "" }
        $path -and
        $path.Equals($mainPath, [StringComparison]::OrdinalIgnoreCase)
    } | Sort-Object @{ Expression = { if ($_.MainWindowHandle -ne 0) { 0 } else { 1 } } }, StartTime |
        Select-Object -First 1 @{ Name = "ProcessId"; Expression = { [int]$_.Id } }, MainWindowHandle
}

function Get-RunningFixedRouteSupervisor {
    param(
        [Parameter(Mandatory = $true)][string]$SupervisorScript,
        [Parameter(Mandatory = $true)][string]$StateRoot
    )
    $statusPath = Join-Path $StateRoot "fixed-route-status.json"
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { return $null }
    try {
        $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $processId = [int]$status.pid
        if ($processId -le 0) { return $null }
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process -or [string]$process.ProcessName -ine "node") { return $null }
        $health = Get-AntiCodexFixedRouteHealth
        if (-not $health -or [int]$health.pid -ne $processId) { return $null }
        return $process
    } catch {
        return $null
    }
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

function Stop-AntiCodexHeadlessFixedRoute {
    param(
        [Parameter(Mandatory = $true)]$SupervisorProcess,
        [Parameter(Mandatory = $true)][string]$StateRoot,
        $Health
    )
    $processId = [int]$SupervisorProcess.Id
    if (-not $Health) { $Health = Get-AntiCodexFixedRouteHealth }
    if (-not $Health -or [int]$Health.pid -ne $processId -or $Health.headless -ne $true) {
        return $false
    }

    $authPath = Join-Path $StateRoot "codex-home-deepseek-app\auth.json"
    if (-not (Test-Path -LiteralPath $authPath -PathType Leaf)) { return $false }
    try {
        $controlToken = [string](Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json).OPENAI_API_KEY
    } catch {
        return $false
    }
    if ([string]::IsNullOrWhiteSpace($controlToken)) { return $false }

    $response = $null
    try {
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$FIXED_ROUTE_HEALTH_PORT/anticodex/fixed-route/shutdown")
        $request.Method = "POST"
        $request.Proxy = $null
        $request.Timeout = 3000
        $request.ReadWriteTimeout = 3000
        $request.ContentLength = 0
        $request.Headers[[Net.HttpRequestHeader]::Authorization] = "Bearer $controlToken"
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) { return $false }
    } catch {
        return $false
    } finally {
        if ($response) { $response.Dispose() }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Ensure-AntigravityDesktop {
    param([Parameter(Mandatory = $true)][string]$StateRoot)
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
    Start-AntigravityDesktop -ExecutablePath $antigravityPath -StateRoot $StateRoot | Out-Null
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
    $savedAntigravityModel = if ($RuntimeProfile -and $RuntimeProfile.PSObject.Properties["antigravityModel"]) {
        [string]$RuntimeProfile.antigravityModel
    } else {
        ""
    }
    $model = if ($env:ANTICODEX_MODEL) {
        [string]$env:ANTICODEX_MODEL
    } elseif (-not [string]::IsNullOrWhiteSpace($savedAntigravityModel)) {
        $savedAntigravityModel
    } else {
        "gemini-3-flash-agent"
    }

    $runtimeMode = if ($RuntimeProfile) { [string]$RuntimeProfile.mode } else { "antigravity" }
    $thirdPartyConfigured = $RuntimeProfile `
        -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeProfile.protocol) `
        -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeProfile.baseUrl) `
        -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeProfile.model) `
        -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeProfile.apiKey)

    if ($thirdPartyConfigured) {
        $protocol = [string]$RuntimeProfile.protocol
        $supportedProtocols = @("openai-compatible", "chat", "chat-completions", "responses")
        if ($supportedProtocols -notcontains $protocol) {
            throw "The saved third-party protocol '$protocol' is not supported by CodexPlusPlus. Use Chat Completions or Responses."
        }
        $env:UPSTREAM_PROTOCOL = $protocol
        $env:UPSTREAM_URL = [string]$RuntimeProfile.baseUrl
        $env:UPSTREAM_MODEL = [string]$RuntimeProfile.model
        $env:UPSTREAM_API_KEY = [string]$RuntimeProfile.apiKey
        $env:UPSTREAM_CONTEXT_WINDOW = [string]$RuntimeProfile.contextWindow
    } else {
        Remove-Item Env:UPSTREAM_PROTOCOL -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_URL -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_MODEL -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_API_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:UPSTREAM_CONTEXT_WINDOW -ErrorAction SilentlyContinue
        if ($runtimeMode -eq "third-party") {
            throw "The saved third-party profile is incomplete."
        }
    }

    if ($runtimeMode -eq "third-party") {
        $provider = "third-party"
        $model = [string]$RuntimeProfile.model
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

function Test-AntiCodexManagedLaunchBoundary {
    if (-not ("AntiCodexLaunchBoundary" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AntiCodexLaunchBoundary
{
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    public static bool IsCurrentProcessInJob()
    {
        bool result;
        if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out result))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return result;
    }
}
"@
    }

    $currentProcessId = [int]$PID
    $visited = New-Object "System.Collections.Generic.HashSet[int]"
    $lookupFailed = $false
    $inspectedAncestorCount = 0
    for ($depth = 0; $depth -lt 16; $depth++) {
        if (-not $visited.Add($currentProcessId)) { break }
        try {
            $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $currentProcessId" -ErrorAction Stop
        } catch {
            $lookupFailed = $true
            break
        }
        if (-not $currentProcess) {
            $lookupFailed = $true
            break
        }

        $parentProcessId = [int]$currentProcess.ParentProcessId
        if ($parentProcessId -le 0) { break }
        try {
            $parentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $parentProcessId" -ErrorAction Stop
        } catch {
            $lookupFailed = $true
            break
        }
        if (-not $parentProcess) {
            $lookupFailed = $true
            break
        }

        $inspectedAncestorCount++
        $processName = [string]$parentProcess.Name
        $identity = @(
            [string]$parentProcess.ExecutablePath,
            [string]$parentProcess.CommandLine
        ) -join "`n"
        if ($processName -ieq "codex.exe") { return $true }
        if ($processName -ieq "ChatGPT.exe" -and $identity -match "OpenAI\.Codex_") { return $true }
        $currentProcessId = $parentProcessId
    }

    # If ancestry cannot be inspected, retain the conservative job-object guard.
    if ($lookupFailed -and $inspectedAncestorCount -eq 0) {
        return [AntiCodexLaunchBoundary]::IsCurrentProcessInJob()
    }
    return $false
}

Invoke-InstalledAntiCodexLauncherIfAvailable

$installRoot = Resolve-AntiCodexInstallRoot
$stateRoot = if ($StateRootPath) {
    [IO.Path]::GetFullPath($StateRootPath)
} else {
    Join-Path $env:APPDATA "anticodex"
}
$mainExecutable = [IO.Path]::GetFullPath((Join-Path $installRoot "codex-patched-app\Anti-Codex.exe"))
$supervisorScript = Join-Path $PSScriptRoot "start-anticodex-fixed-route.mjs"
$componentManifest = Join-Path $installRoot "components\codexplusplus\component-manifest.json"
$launcherStatePath = Join-Path $stateRoot "launcher-state.json"
$launcherStartedAt = [DateTime]::UtcNow.ToString("o")

function Write-AntiCodexLauncherState {
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [string]$Status = "running",
        [string]$Message = ""
    )
    try {
        New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
        $payload = [ordered]@{
            schema = "anticodex-launcher-state-v1"
            pid = $PID
            startedAt = $launcherStartedAt
            updatedAt = [DateTime]::UtcNow.ToString("o")
            stage = $Stage
            status = $Status
            message = $Message
            provider = [string]$env:ANTICODEX_PROVIDER
            model = [string]$env:ANTICODEX_MODEL
        }
        $json = $payload | ConvertTo-Json -Depth 4
        [IO.File]::WriteAllText($launcherStatePath, "$json`n", [Text.UTF8Encoding]::new($false))
    } catch {}
}

trap {
    $launchError = $_.Exception.Message
    Write-AntiCodexLauncherState -Stage "failed" -Status "error" -Message $launchError
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show(
            "Anti-Codex failed to start.`r`n`r`n$launchError`r`n`r`nDetails: $launcherStatePath",
            "Anti-Codex",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    } catch {}
    exit 1
}

Write-AntiCodexLauncherState -Stage "initializing"

if (Test-AntiCodexManagedLaunchBoundary) {
    throw "Anti-Codex was not started from a safe desktop process. Use the Anti-Codex desktop shortcut so it cannot share Codex process ownership."
}

$env:DEEPCODEX_STATE_ROOT = $stateRoot
$env:CODEX_HOME_DIR = Join-Path $stateRoot "codex-home-deepseek-app"
$env:CODEX_HOME = $env:CODEX_HOME_DIR
$resolvedUserProfile = if ($UserProfilePath) {
    [IO.Path]::GetFullPath($UserProfilePath)
} elseif ($env:USERPROFILE) {
    [IO.Path]::GetFullPath($env:USERPROFILE)
} else {
    [Environment]::GetFolderPath("UserProfile")
}
$env:GLOBAL_CODEX_HOME = Join-Path $resolvedUserProfile ".codex"
$env:DEEPCODEX_SHARED_CODEX_HOME = $env:GLOBAL_CODEX_HOME
$env:DEEPCODEX_CDP_PORT = "18318"
$env:DEEPCODEX_DISABLE_GPU = "1"
$env:ANTICODEX_DISABLE_GPU = "1"
$env:DEEPCODEX_DISPLAY_NAME = "Anti-Codex"
$env:DEEPCODEX_SKIP_PLUGIN_SYNC = "1"
$env:ANTICODEX_MANAGER_API = "http://127.0.0.1:8484"
$env:DEEPCODEX_PROJECTS_ROOT = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "anticodex"
if ($env:DEEPCODEX_WORKSPACE) { $env:ANTICODEX_WORKSPACE = $env:DEEPCODEX_WORKSPACE }

Write-AntiCodexLauncherState -Stage "loading-provider"
$runtimeProfile = Read-AntiCodexRuntimeProfile -StateRoot $stateRoot
$selection = Set-AntiCodexProviderEnvironment -RuntimeProfile $runtimeProfile
Write-AntiCodexLauncherState -Stage "checking-running-client" -Message "$($selection.provider):$($selection.model)"

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
    Write-AntiCodexLauncherState -Stage "checking-update"
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

$existingSupervisor = Get-RunningFixedRouteSupervisor -SupervisorScript $supervisorScript -StateRoot $stateRoot
if ($existingSupervisor) {
    $existingHealth = Get-AntiCodexFixedRouteHealth
    if ($existingHealth -and $existingHealth.headless -eq $true) {
        Write-AntiCodexLauncherState -Stage "stopping-headless-route"
        if (-not (Stop-AntiCodexHeadlessFixedRoute -SupervisorProcess $existingSupervisor -StateRoot $stateRoot -Health $existingHealth)) {
            Write-Error "An Anti-Codex headless test route is still running and could not be stopped cleanly. Refusing to launch a duplicate."
            exit 1
        }
        $existingSupervisor = $null
    }
}
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
    Write-AntiCodexLauncherState -Stage "starting-antigravity"
    Ensure-AntigravityDesktop -StateRoot $stateRoot
}
$nodeExecutable = if ($NodeExecutablePath) {
    [IO.Path]::GetFullPath($NodeExecutablePath)
} else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $nodeCommand) {
        Write-Error "Node.js is required to start the fixed Anti-Codex route."
        exit 1
    }
    [string]$nodeCommand.Source
}
if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
    Write-Error "Node.js executable is missing: $nodeExecutable"
    exit 1
}

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
Write-AntiCodexLauncherState -Stage "protecting-state"
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

if ($InlineSupervisor) {
    $inlineSupervisorArgs = @(
        $supervisorScript,
        "--install-root", $installRoot,
        "--state-root", $stateRoot,
        "--provider", $selection.provider,
        "--model", $selection.model,
        "--manager-base-url", $env:ANTICODEX_MANAGER_API,
        "--disable-gpu"
    )
    Write-AntiCodexLauncherState -Stage "supervising-fixed-route"
    $savedErrorActionPreference = $ErrorActionPreference
    $inlineExitCode = -1
    try {
        # Windows PowerShell promotes native stderr to a terminating error when
        # ErrorActionPreference is Stop, even while the Node process is healthy.
        $ErrorActionPreference = "Continue"
        & $nodeExecutable @inlineSupervisorArgs 1>> $launcherOutLog 2>> $launcherErrLog
        $inlineExitCode = [int]$LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    if ($inlineExitCode -ne 0) {
        throw "Anti-Codex fixed-route supervisor exited with code $inlineExitCode."
    }
    Write-AntiCodexLauncherState -Stage "closed" -Status "stopped"
    exit 0
}

Write-AntiCodexLauncherState -Stage "starting-fixed-route"
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
Write-AntiCodexLauncherState -Stage "ready" -Status "ready" -Message "$($selection.provider):$($selection.model)"
Write-Host "Anti-Codex fixed route is ready."
Write-Host "  Provider: $($selection.provider)"
Write-Host "  Model:    $($selection.model)"
Write-Host "  Monitor:  $($supervisorProcess.Id)"
exit 0
