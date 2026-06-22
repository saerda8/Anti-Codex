[CmdletBinding()]
param(
    [string]$SourceRoot = "",
    [string]$TargetRuntime = $(Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime"),
    [string]$BaseUrl = "",
    [switch]$NoRestart,
    [int]$TimeoutSec = 45
)

$ErrorActionPreference = "Stop"

$startedAt = [DateTime]::UtcNow
$scriptRoot = Split-Path -Parent $PSCommandPath
if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $scriptRoot }
$sourceRootFull = [IO.Path]::GetFullPath($SourceRoot)
$targetRuntimeFull = [IO.Path]::GetFullPath($TargetRuntime)
$expectedRuntime = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime"))
if ($targetRuntimeFull -ne $expectedRuntime) {
    throw "Refusing to sync Anti-Codex runtime outside $expectedRuntime"
}

$requiredSourceFiles = @(
    "scripts\start-deepcodex.ps1",
    "scripts\resolve-anticodex-base-url.ps1",
    "scripts\test-anticodex-installed-overall.ps1",
    "scripts\test-anticodex-real-work.ps1",
    "scripts\test-anticodex-real-mini-tool.ps1",
    "scripts\test-anticodex-model-switch-history.ps1",
    "translator\adaptive-server.mjs",
    "translator\antigravity-session-lock.mjs",
    "codex-home-deepseek-app\config.adaptive-oneapi.toml"
)
foreach ($relative in $requiredSourceFiles) {
    $path = Join-Path $sourceRootFull $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Anti-Codex source runtime component missing: $relative"
    }
}

function Copy-AntiCodexRuntimeTree {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    if (Get-Command robocopy.exe -ErrorAction SilentlyContinue) {
        $args = @($Source, $Destination, "/E", "/XJ", "/COPY:DT", "/DCOPY:DT", "/R:1", "/W:1", "/NFL", "/NDL", "/NP", "/NJH", "/NJS")
        $null = & robocopy.exe @args
        $code = $LASTEXITCODE
        if ($code -lt 8) { return }
        throw "robocopy failed with exit code $code while copying $Source"
    }
    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force -ErrorAction Stop
}

function Get-AntiCodexTranslatorProcesses {
    $needle = [regex]::Escape((Join-Path $targetRuntimeFull "translator\adaptive-server.mjs"))
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        [string]$_.CommandLine -match $needle
    })
}

function Stop-AntiCodexTranslator {
    $stopped = 0
    foreach ($process in @(Get-AntiCodexTranslatorProcesses)) {
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            $stopped += 1
        } catch {}
    }
    return $stopped
}

function Remove-AntiCodexLegacyRuntimeFiles {
    $legacyFiles = @(
        "adaptive-server.mjs",
        "server.mjs"
    )
    foreach ($relative in $legacyFiles) {
        $path = [IO.Path]::GetFullPath((Join-Path $targetRuntimeFull $relative))
        if (-not $path.StartsWith($targetRuntimeFull, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove Anti-Codex legacy runtime file outside $targetRuntimeFull"
        }
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
        }
    }
}

function Test-AntiCodexJavaScriptSyntax {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Anti-Codex JavaScript syntax target missing: $Label"
    }
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $node `
            -ArgumentList @("--check", $Path) `
            -WindowStyle Hidden `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        [void]$proc.Handle
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not $proc.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 200
            try { $proc.Refresh() } catch {}
        }
        if (-not $proc.HasExited) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
            throw "Anti-Codex JavaScript syntax check timed out: $Label"
        }
        if ([int]$proc.ExitCode -ne 0) {
            $stderr = ""
            try { $stderr = [IO.File]::ReadAllText($stderrPath, [Text.Encoding]::UTF8).Trim() } catch {}
            if (-not $stderr) { $stderr = "exit code $([int]$proc.ExitCode)" }
            throw "Anti-Codex JavaScript syntax check failed: $Label :: $stderr"
        }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-LocalJson {
    param([string]$Path, [int]$RequestTimeoutSec = 4)
    return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $RequestTimeoutSec
}

function Wait-AntiCodexHealth {
    param([int]$Seconds)
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $Seconds))
    do {
        try {
            $health = Invoke-LocalJson "/health" 3
            if ($health -and $health.ok -eq $true) { return $health }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

function Wait-AntiCodexSessionLock {
    param([int]$Seconds)
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $Seconds))
    $lastDiagnostics = $null
    $diagnosticsTimeoutSec = [Math]::Min(20, [Math]::Max(8, [int][Math]::Ceiling($Seconds / 3)))
    do {
        try {
            $diagnostics = Invoke-LocalJson "/anticodex/diagnostics" $diagnosticsTimeoutSec
            $lastDiagnostics = $diagnostics
            if ($diagnostics -and $null -ne $diagnostics.antigravitySessionLock) {
                return [pscustomobject]@{ present = $true; diagnostics = $diagnostics }
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return [pscustomobject]@{ present = $false; diagnostics = $lastDiagnostics }
}

Test-AntiCodexJavaScriptSyntax `
    -Path (Join-Path $sourceRootFull "translator\adaptive-server.mjs") `
    -Label "source translator\adaptive-server.mjs"

foreach ($dir in @("scripts", "translator", "assets", "codex-home-deepseek-app")) {
    Copy-AntiCodexRuntimeTree (Join-Path $sourceRootFull $dir) (Join-Path $targetRuntimeFull $dir)
}
Remove-AntiCodexLegacyRuntimeFiles

foreach ($relative in $requiredSourceFiles) {
    $targetPath = Join-Path $targetRuntimeFull $relative
    if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
        throw "Anti-Codex target runtime component missing after sync: $relative"
    }
}

Test-AntiCodexJavaScriptSyntax `
    -Path (Join-Path $targetRuntimeFull "translator\adaptive-server.mjs") `
    -Label "runtime translator\adaptive-server.mjs"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $targetRuntimeFull "scripts\resolve-anticodex-base-url.ps1")
}

$stoppedTranslatorCount = 0
$launchExitCode = $null
if (-not $NoRestart) {
    $stoppedTranslatorCount = Stop-AntiCodexTranslator
    Start-Sleep -Milliseconds 500
    $healthAfterSupervisor = Wait-AntiCodexHealth -Seconds ([Math]::Min(15, [Math]::Max(5, $TimeoutSec)))
    if (-not $healthAfterSupervisor) {
        $startScript = Join-Path $targetRuntimeFull "scripts\start-deepcodex.ps1"
        $powerShell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
        $proc = Start-Process -FilePath $powerShell `
            -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $startScript, "-TranslatorOnly") `
            -WindowStyle Hidden `
            -PassThru
        [void]$proc.Handle
        $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Min(30, [Math]::Max(5, $TimeoutSec)))
        while (-not $proc.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 200
            try { $proc.Refresh() } catch {}
        }
        if (-not $proc.HasExited) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
            throw "Anti-Codex translator-only restart timed out."
        }
        $launchExitCode = [int]$proc.ExitCode
        if ($launchExitCode -ne 0) {
            throw "Anti-Codex translator-only restart failed with exit code $launchExitCode."
        }
    } else {
        $launchExitCode = 0
    }
}

$health = Wait-AntiCodexHealth -Seconds $TimeoutSec
$diagnostics = $null
$sessionLockPresent = $false
if ($health) {
    $sessionLockProbe = Wait-AntiCodexSessionLock -Seconds ([Math]::Max(5, $TimeoutSec))
    $diagnostics = $sessionLockProbe.diagnostics
    $sessionLockPresent = $sessionLockProbe.present -eq $true
}

$result = [pscustomobject]@{
    ok = ($null -ne $health -and $sessionLockPresent)
    sourceRoot = $sourceRootFull
    targetRuntime = $targetRuntimeFull
    baseUrl = $BaseUrl
    restarted = -not [bool]$NoRestart
    stoppedTranslatorCount = $stoppedTranslatorCount
    launchExitCode = $launchExitCode
    elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    health = [pscustomobject]@{
        ok = if ($health) { $health.ok } else { $false }
        upstream = if ($health) { $health.upstream } else { $null }
        modelCount = if ($health) { $health.modelCount } else { 0 }
        accountReady = if ($health) { $health.accountReady } else { $false }
    }
    diagnostics = [pscustomobject]@{
        antigravitySessionLockPresent = $sessionLockPresent
        antigravitySessionLock = if ($diagnostics) { $diagnostics.antigravitySessionLock } else { $null }
    }
}

$result | ConvertTo-Json -Depth 8 -Compress
if (-not $result.ok) { exit 1 }
