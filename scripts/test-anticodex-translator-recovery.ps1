[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [int]$TimeoutSec = 8
)

$ErrorActionPreference = "Stop"
$totalStopwatch = [Diagnostics.Stopwatch]::StartNew()
$totalBudgetMs = 25000
$phaseTimings = [ordered]@{}

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Get-ArrayItems {
    param($Value, [string]$PropertyName = "")
    if ($null -eq $Value) { return @() }
    if ($PropertyName -and (Has-Property $Value $PropertyName)) { return @($Value.$PropertyName) }
    if ((Has-Property $Value "value") -and ($Value.value -is [array])) { return @($Value.value) }
    return @($Value)
}

function Invoke-LocalJson {
    param(
        [string]$Path,
        [string]$Method = "GET",
        [object]$Body = $null
    )

    $remainingMs = $totalBudgetMs - [int]$totalStopwatch.ElapsedMilliseconds
    if ($remainingMs -lt 1000) {
        throw "recovery verification total deadline exceeded before $Path"
    }
    $requestTimeoutSec = [Math]::Max(1, [Math]::Min($TimeoutSec, [int][Math]::Floor($remainingMs / 1000)))

    $args = @{
        Uri = "$BaseUrl$Path"
        Method = $Method
        Proxy = $null
        TimeoutSec = $requestTimeoutSec
    }
    if ($null -ne $Body) {
        $args.ContentType = "application/json"
        $args.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
    }
    return Invoke-RestMethod @args
}

function Get-FileSnapshot {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{
            exists = $false
            length = 0
            lastWriteTimeUtcTicks = 0
        }
    }
    $item = Get-Item -LiteralPath $Path
    return [pscustomobject]@{
        exists = $true
        length = [int64]$item.Length
        lastWriteTimeUtcTicks = [int64]$item.LastWriteTimeUtc.Ticks
    }
}

function Get-ShortFileText {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    $text = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue) -replace "\s+", " "
    if ($text.Length -gt 300) { return $text.Substring($text.Length - 300) }
    return $text
}

$runtimeRootFull = [IO.Path]::GetFullPath($RuntimeRoot)
$startScript = Join-Path $runtimeRootFull "scripts\start-deepcodex.ps1"
$stateRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) "anticodex"
$codexHome = Join-Path $stateRoot "codex-home-deepseek-app"
$globalCodexHome = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) ".codex"
$globalConfig = Join-Path $globalCodexHome "config.toml"
$globalConfigBefore = Get-FileSnapshot $globalConfig
$baseUri = [Uri]$BaseUrl

if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    Add-Failure "runtime start-deepcodex.ps1 missing: $startScript"
} else {
    $env:DEEPCODEX_STATE_ROOT = $stateRoot
    $env:CODEX_HOME_DIR = $codexHome
    $env:CODEX_HOME = $codexHome
    $env:GLOBAL_CODEX_HOME = $globalCodexHome
    $env:DEEPCODEX_SHARED_CODEX_HOME = $globalCodexHome
    $env:DEEPCODEX_PROJECTS_ROOT = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)) "anticodex"
    $env:TRANSLATOR_PORT = [string]$baseUri.Port
    $env:TRANSLATOR_HOST = $baseUri.Host
    $env:TRANSLATOR_URL = $BaseUrl
    $env:DEEPCODEX_DISPLAY_NAME = "Anti-Codex"
    $env:TRANSLATOR_UPSTREAM_MODE = "antigravity"
    $env:ANTICODEX_ANTIGRAVITY_TRANSPORT = "desktop-cascade"
    $env:ANTICODEX_NATIVE_TOOL_BRIDGE = "0"
    $env:ANTICODEX_ANTIGRAVITY_CLI_PROFILE_ROOT = Join-Path $stateRoot "antigravity-cli-profile"
    $env:DEEPCODEX_SKIP_PLUGIN_SYNC = "1"

    try {
        $powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
        $launcherLogRoot = Join-Path ([IO.Path]::GetTempPath()) "anticodex-recovery"
        New-Item -ItemType Directory -Path $launcherLogRoot -Force | Out-Null
        $launcherLogPrefix = "translator-only-$([Guid]::NewGuid().ToString('N'))"
        $launcherStdout = Join-Path $launcherLogRoot "$launcherLogPrefix.out.log"
        $launcherStderr = Join-Path $launcherLogRoot "$launcherLogPrefix.err.log"
        $launcherStopwatch = [Diagnostics.Stopwatch]::StartNew()
        $launcherProc = Start-Process -FilePath $powerShellBin `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$startScript`"", "-TranslatorOnly") `
            -RedirectStandardOutput $launcherStdout -RedirectStandardError $launcherStderr `
            -PassThru -WindowStyle Hidden
        [void]$launcherProc.Handle
        $launcherTimeoutMs = [Math]::Min(12000, [Math]::Max(8000, $TimeoutSec * 1000 + 4000))
        while (-not $launcherProc.HasExited -and $launcherStopwatch.ElapsedMilliseconds -lt $launcherTimeoutMs) {
            Start-Sleep -Milliseconds 200
            $launcherProc.Refresh()
        }
        if (-not $launcherProc.HasExited) {
            try { $launcherProc.Kill() } catch {}
            Add-Failure "translator-only launcher timed out after $launcherTimeoutMs ms; stdout=$(Get-ShortFileText $launcherStdout); stderr=$(Get-ShortFileText $launcherStderr)"
        } elseif ($launcherProc.ExitCode -ne 0) {
            Add-Failure "translator-only launcher exited with code $($launcherProc.ExitCode); stdout=$(Get-ShortFileText $launcherStdout); stderr=$(Get-ShortFileText $launcherStderr)"
        }
        $launcherStopwatch.Stop()
        $phaseTimings.launcherElapsedMs = [int]$launcherStopwatch.ElapsedMilliseconds
    } catch {
        if ($launcherStopwatch) {
            $launcherStopwatch.Stop()
            $phaseTimings.launcherElapsedMs = [int]$launcherStopwatch.ElapsedMilliseconds
        }
        Add-Failure "translator-only launcher failed: $($_.Exception.Message)"
    }
}

$globalConfigAfter = Get-FileSnapshot $globalConfig
if ($globalConfigBefore.exists -ne $globalConfigAfter.exists -or
    $globalConfigBefore.length -ne $globalConfigAfter.length -or
    $globalConfigBefore.lastWriteTimeUtcTicks -ne $globalConfigAfter.lastWriteTimeUtcTicks) {
    Add-Failure "translator-only recovery changed original Codex config.toml"
}

$health = $null
try {
    $phaseStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $health = Invoke-LocalJson "/health"
    $phaseStopwatch.Stop()
    $phaseTimings.healthElapsedMs = [int]$phaseStopwatch.ElapsedMilliseconds
    if (-not $health.ok) { Add-Failure "health ok=false" }
    if ($health.upstream -ne "antigravity-desktop") { Add-Failure "health upstream is not antigravity-desktop: $($health.upstream)" }
    if ($health.modelCount -le 0) { Add-Failure "health modelCount is <= 0: $($health.modelCount)" }
} catch {
    if ($phaseStopwatch) {
        $phaseStopwatch.Stop()
        $phaseTimings.healthElapsedMs = [int]$phaseStopwatch.ElapsedMilliseconds
    }
    Add-Failure "health request failed: $($_.Exception.Message)"
}

$installedPlugins = @()
try {
    $phaseStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $installedPlugins = Get-ArrayItems (Invoke-LocalJson "/backend-api/ps/plugins/installed")
    $phaseStopwatch.Stop()
    $phaseTimings.pluginsElapsedMs = [int]$phaseStopwatch.ElapsedMilliseconds
    if ($installedPlugins.Count -lt 1) { Add-Failure "installed plugins endpoint returned empty result" }
} catch {
    if ($phaseStopwatch) {
        $phaseStopwatch.Stop()
        $phaseTimings.pluginsElapsedMs = [int]$phaseStopwatch.ElapsedMilliseconds
    }
    Add-Failure "installed plugins endpoint failed: $($_.Exception.Message)"
}

$whamAppToolCount = 0
try {
    $phaseStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $whamPayload = Invoke-LocalJson "/backend-api/wham/apps" "POST" @{}
    $phaseStopwatch.Stop()
    $phaseTimings.whamAppsElapsedMs = [int]$phaseStopwatch.ElapsedMilliseconds
    $whamAppToolCount = (Get-ArrayItems $whamPayload "tools").Count
} catch {
    if ($phaseStopwatch) {
        $phaseStopwatch.Stop()
        $phaseTimings.whamAppsElapsedMs = [int]$phaseStopwatch.ElapsedMilliseconds
    }
    Add-Failure "wham/apps endpoint failed: $($_.Exception.Message)"
}

$totalStopwatch.Stop()
$phaseTimings.totalElapsedMs = [int]$totalStopwatch.ElapsedMilliseconds

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    runtimeRoot = $runtimeRootFull
    totalElapsedMs = [int]$totalStopwatch.ElapsedMilliseconds
    phaseTimings = [pscustomobject]$phaseTimings
    health = [pscustomobject]@{
        ok = if ($health) { $health.ok } else { $false }
        upstream = if ($health) { $health.upstream } else { $null }
        accountReady = if ($health) { $health.accountReady } else { $false }
        accountState = if ($health) { $health.accountState } else { $null }
        modelCount = if ($health) { $health.modelCount } else { 0 }
    }
    checks = [pscustomobject]@{
        installedPluginCount = $installedPlugins.Count
        appToolCount = $whamAppToolCount
        originalCodexConfigUnchanged = ($globalConfigBefore.exists -eq $globalConfigAfter.exists -and
            $globalConfigBefore.length -eq $globalConfigAfter.length -and
            $globalConfigBefore.lastWriteTimeUtcTicks -eq $globalConfigAfter.lastWriteTimeUtcTicks)
        originalCodexConfigBefore = $globalConfigBefore
        originalCodexConfigAfter = $globalConfigAfter
    }
}

$result | ConvertTo-Json -Depth 8 -Compress
if ($failures.Count -gt 0) { exit 1 }


