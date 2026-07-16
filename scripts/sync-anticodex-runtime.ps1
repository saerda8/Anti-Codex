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
$fixedRouteHealthUrl = "http://127.0.0.1:18487/anticodex/fixed-route/health"
if ($targetRuntimeFull -ne $expectedRuntime) {
    throw "Refusing to sync Anti-Codex runtime outside $expectedRuntime"
}

$requiredSourceFiles = @(
    "scripts\start-anticodex.ps1",
    "scripts\start-anticodex-fixed-route.mjs",
    "scripts\anticodex-manager-service.mjs",
    "scripts\install-codexplusplus-component.ps1",
    "scripts\lib\anticodex-fixed-route.mjs",
    "scripts\lib\anticodex-owner-process.mjs",
    "scripts\anticodex-update-status.psm1",
    "scripts\brand-profile-dropdown.mjs",
    "scripts\sync-anticodex.ps1",
    "scripts\sync-anticodex-launcher.ps1",
    "scripts\rollback-anticodex.ps1",
    "scripts\rollback-anticodex-launcher.ps1",
    "scripts\manage-anticodex.ps1",
    "scripts\check-anticodex-update.ps1",
    "scripts\deepcodex-cdp-inject.mjs",
    "scripts\anticodex-manager-bridge.mjs",
    "scripts\anticodex-manager-inject.js",
    "scripts\anticodex-manager-open-inject.js",
    "scripts\anticodex-report-io.ps1",
    "scripts\anticodex-powershell-json-invoke.ps1",
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
    "scripts\test-anticodex-native-compaction-resume.mjs",
    "scripts\test-anticodex-gate8-final-long-task.mjs",
    "scripts\test-anticodex-gate8-final-long-task.ps1",
    "scripts\test-anticodex-gate8-quota-probe.ps1",
    "scripts\test-anticodex-custom-tool-loop.ps1",
    "scripts\test-anticodex-diagnostics.ps1",
    "scripts\test-anticodex-installed-overall.ps1",
    "scripts\test-anticodex-ambient-suggestions.ps1",
    "scripts\test-anticodex-local-connectors.mjs",
    "scripts\test-anticodex-manager-action.ps1",
    "scripts\test-anticodex-manager-button.mjs",
    "scripts\test-anticodex-manager-real-buttons.ps1",
    "scripts\test-anticodex-mcp-skills.ps1",
    "scripts\test-anticodex-worker-process-hygiene.mjs",
    "scripts\test-anticodex-codex-appserver-freshness.mjs",
    "scripts\test-anticodex-mcp-tool-loop.ps1",
    "scripts\test-anticodex-missing-history.mjs",
    "scripts\test-anticodex-model-routing.ps1",
    "scripts\test-anticodex-model-switch-history.ps1",
    "scripts\test-anticodex-model-thinking.ps1",
    "scripts\test-anticodex-native-multi-tool-loop.ps1",
    "scripts\test-anticodex-native-tool-loop.ps1",
    "scripts\test-anticodex-plugin-capabilities.ps1",
    "scripts\test-anticodex-post-verification.ps1",
    "scripts\test-anticodex-release-gates.mjs",
    "scripts\test-anticodex-legacy-zero-hit.mjs",
    "scripts\test-codexplusplus-third-party-route.ps1",
    "scripts\test-codexplusplus-antigravity-route-switch.mjs",
    "scripts\test-antigravity-chat-adapter-contract.mjs",
    "scripts\test-antigravity-chat-adapter-edge-contract.mjs",
    "scripts\test-anticodex-gate5-visible-integration.mjs",
    "scripts\test-anticodex-real-work.ps1",
    "scripts\test-anticodex-real-mini-tool.ps1",
    "scripts\test-anticodex-real-report-site.ps1",
    "scripts\test-anticodex-real-small-project.ps1",
    "scripts\test-anticodex-source-preflight.ps1",
    "scripts\test-anticodex-stability-soak.ps1",
    "scripts\test-anticodex-sync-readiness.ps1",
    "scripts\test-anticodex-tool-bridge-mode.ps1",
    "scripts\test-anticodex-tool-loop.ps1",
    "scripts\test-anticodex-ui-state.mjs",
    "scripts\test-anticodex-ui-state.ps1",
    "scripts\test-anticodex-ui-idle-stability.ps1",
    "scripts\read-anticodex-native-request-snapshot.mjs",
    "scripts\test-anticodex-desktop-task-suite.mjs",
    "scripts\test-anticodex-conversation-hygiene.mjs",
    "scripts\lib\ui-chat-marker-evidence.mjs",
    "scripts\lib\native-codex-rollout-history.mjs",
    "scripts\lib\anticodex-gate8-evidence.mjs",
    "scripts\lib\anticodex-native-request-activity.mjs",
    "scripts\test-anticodex-ui-chat-smoke.mjs",
    "scripts\test-anticodex-human-edge-matrix.mjs",
    "scripts\test-anticodex-human-long-journey.mjs",
    "scripts\test-anticodex-human-long-journey.ps1",
    "scripts\test-anticodex-web-tools.ps1",
    "translator\antigravity-agentapi.mjs",
    "translator\antigravity-model-catalog.mjs",
    "translator\antigravity-native-mcp-bridge.mjs",
    "translator\provider\antigravity-cascade-client.mjs",
    "translator\provider\antigravity-chat-adapter.mjs",
    "translator\provider\antigravity-chat-server.mjs",
    "translator\provider\codexplusplus-upstream-probe.mjs",
    "translator\provider\start-antigravity-chat-provider.mjs",
    "translator\local-projection\index.mjs",
    "translator\sync-antigravity-model-catalog.mjs",
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
        "docs\audits\2026-07-14-codexplusplus-runtime-isolation.json",
        "docs\audits\2026-07-14-codexplusplus-third-party-route.json",
        "docs\audits\2026-07-14-antigravity-chat-adapter-contract.json",
        "docs\audits\2026-07-14-gate4-isolated-route-switch.json",
        "docs\audits\2026-07-15-gate5-visible-integration.json",
        "docs\audits\2026-07-15-gate5-visible-integration.json.sha256",
        "docs\audits\2026-07-15-gate6-edge-matrix.json",
        "docs\audits\2026-07-15-gate6-edge-matrix.json.sha256",
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

$legacyRuntimeFiles = @(
    # Older syncs flattened these translator files into the runtime root.
    "antigravity-failure-circuit.mjs",
    "antigravity-request-queue.mjs",
    "antigravity-upstream.mjs",
    "translator\adaptive-server.mjs",
    "translator\server.mjs",
    "translator\antigravity-upstream.mjs",
    "translator\upstream-provider.mjs",
    "translator\compat-rules.mjs",
    "translator\codex-native-harness-turn.mjs",
    "translator\codex-native-protocol.mjs",
    "translator\codex-native-sse.mjs",
    "translator\codex-native-compact.mjs",
    "translator\response-history.mjs",
    "translator\tools\registry.mjs",
    "translator\tools\cache_stability_diff.mjs",
    "translator\antigravity-native-harness-upstream.mjs",
    "translator\antigravity-request-registry.mjs",
    "translator\antigravity-request-queue.mjs",
    "translator\antigravity-session-lock.mjs",
    "translator\antigravity-failure-circuit.mjs",
    "translator\antigravity-readiness.mjs",
    "translator\antigravity-account-tracker.mjs",
    "translator\antigravity-model-route-audit.mjs",
    "translator\probe.mjs",
    "scripts\install-deepcodex.ps1",
    "scripts\start-deepcodex.ps1",
    "scripts\start-adaptive-translator.sh",
    "scripts\deepcodex-translator-watch.sh",
    "scripts\start-deepcodex.sh",
    "scripts\install-deepcodex-app.sh",
    "scripts\deepcodex-setup-ui.mjs",
    "scripts\DeepCodexSetup",
    "scripts\DeepCodexSetup.swift",
    "scripts\enable-deepcodex-plugin-unlock.ps1",
    "scripts\apply-deepcodex-brand.ps1",
    "scripts\deepcodex-plugin-unlock-inject.js",
    "scripts\build-macos-dmg.sh",
    "scripts\test-anticodex-cli-transport-boundary.mjs",
    "scripts\test-anticodex-third-party-provider.mjs",
    "scripts\test-anticodex-real-third-party-provider.mjs",
    "scripts\test-anticodex-provider-antigravity-return.ps1",
    "scripts\prepare-anticodex-antigravity-cli-profile.ps1",
    "scripts\start-anticodex-antigravity-cli-login.ps1",
    "scripts\start-anticodex-antigravity-cli-login-windows-user.ps1",
    "scripts\open-anticodex-windows-user-settings.ps1",
    "scripts\start-anticodex-second-antigravity-account-login.ps1",
    "scripts\test-anticodex-second-account-readiness-summary.ps1",
    "scripts\test-anticodex-second-account-login-entrypoint.ps1",
    "scripts\test-anticodex-second-account-post-login-proof.ps1",
    "scripts\test-anticodex-antigravity-cli-dual-account-lanes.ps1",
    "scripts\test-anticodex-antigravity-cli-isolation.ps1",
    "scripts\test-anticodex-antigravity-cli-windows-user-readiness.ps1",
    "scripts\test-anticodex-antigravity-account-isolation-status.ps1",
    "scripts\test-anticodex-antigravity-cli-real-smoke.ps1",
    "scripts\test-anticodex-windows-user-account-prepare.ps1",
    "scripts\test-anticodex-windows-user-setup-guidance.ps1",
    "scripts\test-anticodex-xiaoqiang-current-channel-live-proof.mjs",
    "scripts\test-anticodex-xiaoqiang-mcp.mjs",
    "scripts\test-anticodex-xiaoqiang-usage-ledger.mjs",
    "scripts\probe-anticodex-worker-mcp-servers.mjs",
    "scripts\test-anticodex-worker-mcp-source-hygiene.mjs",
    "scripts\test-anticodex-worker-mcp-status-probe.mjs",
    "scripts\record-anticodex-current-channel-worker-transport.mjs",
    "scripts\test-anticodex-current-channel-worker-recovery.mjs",
    "scripts\test-anticodex-current-channel-worker-recovery.ps1",
    "scripts\build-anticodex-goal-unblock-package.mjs",
    "scripts\build-anticodex-fresh-channel-worker-proof-kit.mjs",
    "scripts\test-anticodex-worker-mcp-task-smoke.mjs",
    "scripts\test-anticodex-goal-readiness.mjs",
    "scripts\test-anticodex-goal-real-run-readiness.mjs",
    "scripts\test-anticodex-real-approval-plan.mjs",
    "scripts\test-anticodex-required-real-traffic-sequence.ps1",
    "scripts\test-anticodex-approved-real-run-sequence.mjs",
    "scripts\test-anticodex-goal-current-usability.test.mjs",
    "scripts\test-anticodex-goal-unblock-package.test.mjs",
    "scripts\test-anticodex-fresh-channel-worker-proof-kit.test.mjs",
    "scripts\test-anticodex-agentic-capability-matrix.mjs",
    "scripts\test-anticodex-real-task-coverage-roadmap.mjs",
    "scripts\test-anticodex-long-task-landing-matrix.mjs",
    "scripts\test-anticodex-native-codex-parity-tasks.mjs"
)

function Get-AntiCodexFixedRouteSupervisorProcesses {
    $needle = [regex]::Escape((Join-Path $targetRuntimeFull "scripts\start-anticodex-fixed-route.mjs"))
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        [string]$_.CommandLine -match $needle
    })
}

function Stop-AntiCodexFixedRouteSupervisor {
    $stopped = 0
    foreach ($process in @(Get-AntiCodexFixedRouteSupervisorProcesses)) {
        $commandLine = [string]$process.CommandLine
        if ($commandLine -notlike "*$targetRuntimeFull*") {
            throw "Refusing to stop a fixed-route supervisor outside $targetRuntimeFull"
        }
        $savedErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            & taskkill.exe /PID ([int]$process.ProcessId) /T /F 2>$null | Out-Null
            $taskkillExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $savedErrorActionPreference
        }
        $stillRunning = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($taskkillExitCode -ne 0 -and $stillRunning) {
            throw "Anti-Codex fixed-route supervisor PID $($process.ProcessId) could not be stopped."
        }
        if ($taskkillExitCode -eq 0 -or -not $stillRunning) {
            $stopped += 1
        }
    }
    return $stopped
}

function Remove-AntiCodexLegacyRuntimeFiles {
    foreach ($relative in $legacyRuntimeFiles) {
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
            if ($health -and $health.ok -eq $true -and [string]$health.schema -eq "anticodex-manager-service-v1" -and [string]$health.role -eq "launcher-management-only") { return $health }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

function Wait-AntiCodexFixedRouteHealth {
    param([int]$Seconds)
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $Seconds))
    do {
        try {
            $fixedRoute = Invoke-RestMethod -Uri $fixedRouteHealthUrl -Proxy $null -TimeoutSec 3
            if ($fixedRoute -and $fixedRoute.ok -eq $true -and [string]$fixedRoute.state -eq "ready") { return $fixedRoute }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

function Invoke-AntiCodexFixedRouteLauncher {
    param([int]$Seconds)

    $launcher = Join-Path $targetRuntimeFull "scripts\start-anticodex.ps1"
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "Anti-Codex fixed-route launcher is missing: $launcher"
    }
    $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $powershell `
            -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$launcher`"", "-SkipUpdateCheck") `
            -WindowStyle Hidden `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        [void]$proc.Handle
        $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(10, $Seconds))
        $health = $null
        $fixedRoute = $null
        do {
            $health = Wait-AntiCodexHealth -Seconds 1
            $fixedRoute = Wait-AntiCodexFixedRouteHealth -Seconds 1
            if ($health -and $fixedRoute) { break }
            try { $proc.Refresh() } catch {}
            if ($proc.HasExited) { break }
        } while ([DateTime]::UtcNow -lt $deadline)

        $ready = ($null -ne $health -and $null -ne $fixedRoute)
        if ($ready -and -not $proc.HasExited) {
            try { [void]$proc.WaitForExit(5000) } catch {}
            try { $proc.Refresh() } catch {}
        }
        if (-not $ready -and -not $proc.HasExited) {
            & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null
            try { $proc.Refresh() } catch {}
        }
        $exitCode = if ($proc.HasExited) { [int]$proc.ExitCode } else { $null }
        $stderr = ""
        try { $stderr = [IO.File]::ReadAllText($stderrPath, [Text.Encoding]::UTF8).Trim() } catch {}
        return [pscustomobject]@{
            ok = $ready -and ($null -eq $exitCode -or $exitCode -eq 0)
            exitCode = $exitCode
            stderr = $stderr
        }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

$syntaxCheckedJavaScriptFiles = @(
    "scripts\start-anticodex-fixed-route.mjs",
    "scripts\anticodex-manager-service.mjs",
    "scripts\lib\anticodex-fixed-route.mjs",
    "scripts\lib\anticodex-owner-process.mjs",
    "scripts\lib\anticodex-gate8-evidence.mjs",
    "scripts\lib\anticodex-native-request-activity.mjs",
    "scripts\read-anticodex-native-request-snapshot.mjs",
    "scripts\lib\native-codex-rollout-history.mjs",
    "scripts\test-anticodex-native-compaction-resume.mjs",
    "scripts\test-anticodex-gate8-final-long-task.mjs",
    "scripts\deepcodex-cdp-inject.mjs",
    "scripts\anticodex-manager-bridge.mjs",
    "scripts\anticodex-manager-inject.js",
    "scripts\anticodex-manager-open-inject.js",
    "translator\antigravity-agentapi.mjs",
    "translator\antigravity-model-catalog.mjs",
    "translator\antigravity-native-mcp-bridge.mjs",
    "translator\provider\antigravity-cascade-client.mjs",
    "translator\provider\antigravity-chat-adapter.mjs",
    "translator\provider\antigravity-chat-server.mjs",
    "translator\provider\codexplusplus-upstream-probe.mjs",
    "translator\provider\start-antigravity-chat-provider.mjs"
)
foreach ($relative in $syntaxCheckedJavaScriptFiles) {
    Test-AntiCodexJavaScriptSyntax `
        -Path (Join-Path $sourceRootFull $relative) `
        -Label "source $relative"
}

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

foreach ($relative in $syntaxCheckedJavaScriptFiles) {
    Test-AntiCodexJavaScriptSyntax `
        -Path (Join-Path $targetRuntimeFull $relative) `
        -Label "runtime $relative"
}

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $targetRuntimeFull "scripts\resolve-anticodex-base-url.ps1")
}

$stoppedFixedRouteSupervisorCount = 0
$launchExitCode = $null
if (-not $NoRestart) {
    New-Item -ItemType Directory -Path $antiCodexStateRoot -Force | Out-Null
    $stoppedFixedRouteSupervisorCount = Stop-AntiCodexFixedRouteSupervisor
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while ((Get-AntiCodexFixedRouteSupervisorProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $stopDeadline) {
        Start-Sleep -Milliseconds 250
    }
    if ((Get-AntiCodexFixedRouteSupervisorProcesses).Count -gt 0) {
        throw "Anti-Codex fixed-route supervisor did not stop cleanly."
    }
    $launch = Invoke-AntiCodexFixedRouteLauncher -Seconds ([Math]::Max(30, $TimeoutSec))
    $launchExitCode = $launch.exitCode
    if (-not $launch.ok) {
        throw "Anti-Codex fixed-route restart failed. exit=$($launch.exitCode) $($launch.stderr)"
    }
}

$health = Wait-AntiCodexHealth -Seconds $TimeoutSec
$fixedRoute = Wait-AntiCodexFixedRouteHealth -Seconds $TimeoutSec

$result = [pscustomobject]@{
    ok = ($null -ne $health -and $null -ne $fixedRoute)
    sourceRoot = $sourceRootFull
    targetRuntime = $targetRuntimeFull
    baseUrl = $BaseUrl
    restarted = -not [bool]$NoRestart
    stoppedFixedRouteSupervisorCount = $stoppedFixedRouteSupervisorCount
    launchExitCode = $launchExitCode
    elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    health = [pscustomobject]@{
        ok = if ($health) { $health.ok } else { $false }
        schema = if ($health) { $health.schema } else { $null }
        role = if ($health) { $health.role } else { $null }
    }
    fixedRoute = [pscustomobject]@{
        ok = if ($fixedRoute) { $fixedRoute.ok } else { $false }
        state = if ($fixedRoute) { $fixedRoute.state } else { $null }
        provider = if ($fixedRoute) { $fixedRoute.provider } else { $null }
        model = if ($fixedRoute) { $fixedRoute.model } else { $null }
    }
}

$result | ConvertTo-Json -Depth 8 -Compress
if (-not $result.ok) { exit 1 }
