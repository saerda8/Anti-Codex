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
$antiCodexStateRoot = Join-Path $env:APPDATA "anticodex"
$translatorRestartLockPath = Join-Path $antiCodexStateRoot "translator-restart.lock"
$translatorRestartLockCreated = $false
if ($targetRuntimeFull -ne $expectedRuntime) {
    throw "Refusing to sync Anti-Codex runtime outside $expectedRuntime"
}

$requiredSourceFiles = @(
    "scripts\start-anticodex.ps1",
    "scripts\start-deepcodex.ps1",
    "scripts\anticodex-update-status.psm1",
    "scripts\sync-anticodex.ps1",
    "scripts\sync-anticodex-launcher.ps1",
    "scripts\rollback-anticodex.ps1",
    "scripts\rollback-anticodex-launcher.ps1",
    "scripts\manage-anticodex.ps1",
    "scripts\check-anticodex-update.ps1",
    "scripts\anticodex-manager-bridge.mjs",
    "scripts\anticodex-manager-inject.js",
    "scripts\anticodex-manager-open-inject.js",
    "scripts\anticodex-report-io.ps1",
    "scripts\collect-anticodex-diagnostics.ps1",
    "scripts\protect-anticodex-log-db.mjs",
    "scripts\refresh-anticodex-local-features.ps1",
    "scripts\resolve-anticodex-base-url.ps1",
    "scripts\summarize-anticodex-report.mjs",
    "scripts\test-anticodex-account-proxy-readiness.ps1",
    "scripts\test-anticodex-cold-relaunch.ps1",
    "scripts\test-anticodex-cancellation.ps1",
    "scripts\test-anticodex-codex-responses.ps1",
    "scripts\test-anticodex-compaction-resume.ps1",
    "scripts\test-anticodex-custom-tool-loop.ps1",
    "scripts\test-anticodex-diagnostics.ps1",
    "scripts\test-anticodex-installed-overall.ps1",
    "scripts\test-anticodex-ambient-suggestions.ps1",
    "scripts\prepare-anticodex-antigravity-cli-profile.ps1",
    "scripts\start-anticodex-antigravity-cli-login.ps1",
    "scripts\start-anticodex-antigravity-cli-login-windows-user.ps1",
    "scripts\start-anticodex-second-antigravity-account-login.ps1",
    "scripts\test-anticodex-second-account-login-entrypoint.ps1",
    "scripts\test-anticodex-antigravity-cli-dual-account-lanes.ps1",
    "scripts\test-anticodex-antigravity-cli-windows-user-readiness.ps1",
    "scripts\test-anticodex-antigravity-account-isolation-status.ps1",
    "scripts\test-anticodex-antigravity-cli-real-smoke.ps1",
    "scripts\test-anticodex-windows-user-account-prepare.ps1",
    "scripts\test-anticodex-windows-user-setup-guidance.ps1",
    "scripts\test-anticodex-local-connectors.mjs",
    "scripts\test-anticodex-manager-action.ps1",
    "scripts\test-anticodex-manager-button.mjs",
    "scripts\test-anticodex-manager-real-buttons.ps1",
    "scripts\test-anticodex-mcp-skills.ps1",
    "scripts\test-anticodex-mcp-tool-loop.ps1",
    "scripts\test-anticodex-missing-history.mjs",
    "scripts\test-anticodex-model-routing.ps1",
    "scripts\test-anticodex-model-switch-history.ps1",
    "scripts\test-anticodex-model-thinking.ps1",
    "scripts\test-anticodex-native-multi-tool-loop.ps1",
    "scripts\test-anticodex-native-tool-loop.ps1",
    "scripts\test-anticodex-plugin-capabilities.ps1",
    "scripts\test-anticodex-post-verification.ps1",
    "scripts\test-anticodex-provider-antigravity-return.ps1",
    "scripts\test-anticodex-release-gates.mjs",
    "scripts\test-anticodex-real-third-party-provider.mjs",
    "scripts\test-anticodex-real-work.ps1",
    "scripts\test-anticodex-real-mini-tool.ps1",
    "scripts\test-anticodex-real-report-site.ps1",
    "scripts\test-anticodex-real-small-project.ps1",
    "scripts\test-anticodex-source-preflight.ps1",
    "scripts\test-anticodex-stability-soak.ps1",
    "scripts\test-anticodex-sync-readiness.ps1",
    "scripts\test-anticodex-third-party-provider.mjs",
    "scripts\test-anticodex-tool-bridge-mode.ps1",
    "scripts\test-anticodex-tool-loop.ps1",
    "scripts\test-anticodex-ui-state.mjs",
    "scripts\test-anticodex-ui-state.ps1",
    "scripts\test-anticodex-ui-idle-stability.ps1",
    "scripts\test-anticodex-desktop-task-suite.mjs",
    "scripts\test-anticodex-goal-readiness.mjs",
    "scripts\test-anticodex-agentic-capability-matrix.mjs",
    "scripts\test-anticodex-ui-chat-smoke.mjs",
    "scripts\test-anticodex-web-tools.ps1",
    "translator\adaptive-server.mjs",
    "translator\antigravity-agentapi.mjs",
    "translator\antigravity-model-catalog.mjs",
    "translator\antigravity-native-mcp-bridge.mjs",
    "translator\antigravity-session-lock.mjs",
    "translator\antigravity-upstream.mjs",
    "translator\compat-rules.mjs",
    "translator\local-projection\index.mjs",
    "translator\response-history.mjs",
    "translator\sync-antigravity-model-catalog.mjs",
    "translator\upstream-provider.mjs",
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

function Copy-AntiCodexPublicDocs {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $publicDocFiles = @(
        "README.md",
        "README_EN.md",
        "docs\ADAPTIVE_ONE_API_STACK.md",
        "docs\WINDOWS.md",
        "docs\chat-to-responses-compat.md",
        "docs\DEEPSEEK_RUNTIME_FAILURE_NOTES.md",
        "docs\marketing\legacy\deepcodex-video-script.md",
        "docs\marketing\launch-post.md",
        "docs\marketing\video-script.md",
        "docs\marketing\wechat-article.md"
    )
    foreach ($relative in $publicDocFiles) {
        $source = Join-Path $SourceRoot $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Anti-Codex public documentation source missing: $relative"
        }
        $destination = Join-Path $DestinationRoot $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
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

function Stop-ExtraAntiCodexTranslators {
    param([int]$KeepPid)
    if ($KeepPid -le 0) { return 0 }
    $stopped = 0
    foreach ($process in @(Get-AntiCodexTranslatorProcesses)) {
        if ([int]$process.ProcessId -eq $KeepPid) { continue }
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
Copy-AntiCodexPublicDocs -SourceRoot $sourceRootFull -DestinationRoot $targetRuntimeFull
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
$stoppedExtraTranslatorCount = 0
$launchExitCode = $null
if (-not $NoRestart) {
    New-Item -ItemType Directory -Path $antiCodexStateRoot -Force | Out-Null
    [IO.File]::WriteAllText($translatorRestartLockPath, "sync-anticodex-runtime restart in progress $([DateTime]::UtcNow.ToString("o"))", [Text.Encoding]::UTF8)
    $translatorRestartLockCreated = $true
    $env:ANTICODEX_TRANSLATOR_RESTART_LOCK_OWNER = "1"
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
        $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(5, $TimeoutSec))
        $restartHealthy = $false
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Wait-AntiCodexHealth -Seconds 1) {
                $restartHealthy = $true
                break
            }
            if ($proc.HasExited) { break }
            Start-Sleep -Milliseconds 200
            try { $proc.Refresh() } catch {}
        }
        if (-not $restartHealthy -and -not $proc.HasExited) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
            throw "Anti-Codex translator-only restart timed out."
        }
        $launchExitCode = if ($restartHealthy) { 0 } else { [int]$proc.ExitCode }
        if (-not $restartHealthy -and $launchExitCode -ne 0) {
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
    if ($diagnostics -and $diagnostics.process -and $diagnostics.process.pid) {
        $stoppedExtraTranslatorCount = Stop-ExtraAntiCodexTranslators -KeepPid ([int]$diagnostics.process.pid)
    }
}
if ($translatorRestartLockCreated) {
    Remove-Item -LiteralPath $translatorRestartLockPath -Force -ErrorAction SilentlyContinue
}

$result = [pscustomobject]@{
    ok = ($null -ne $health -and $sessionLockPresent)
    sourceRoot = $sourceRootFull
    targetRuntime = $targetRuntimeFull
    baseUrl = $BaseUrl
    restarted = -not [bool]$NoRestart
    stoppedTranslatorCount = $stoppedTranslatorCount
    stoppedExtraTranslatorCount = $stoppedExtraTranslatorCount
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
