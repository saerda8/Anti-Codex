[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [int]$TimeoutSec = 90,
    [int]$StopTimeoutSec = 60,
    [int]$HealthPollTimeoutSec = 0,
    [int]$PollIntervalMs = 500,
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [string]$ProgressPath = $(Join-Path $env:TEMP "anticodex-cold-relaunch-progress.json"),
    [switch]$ConfirmRelaunch
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "anticodex-report-io.ps1")

if (-not $ConfirmRelaunch) {
    $result = [pscustomobject]@{
        reportName = "cold-relaunch"
        ok = $false
        skipped = $true
        requiresConfirmation = $true
        reason = "cold relaunch verification requires -ConfirmRelaunch because it stops and restarts Anti-Codex"
        failures = @("missing -ConfirmRelaunch")
        usedRealTraffic = $false
        behaviorCovered = $false
    }
    $result | ConvertTo-Json -Depth 6 -Compress
    exit 2
}

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}
$fixedRouteHealthUrl = "http://127.0.0.1:18487/anticodex/fixed-route/health"

$failures = New-Object System.Collections.Generic.List[string]
$stages = New-Object System.Collections.Generic.List[object]
$startedAt = [DateTime]::UtcNow

if ($HealthPollTimeoutSec -le 0) {
    $HealthPollTimeoutSec = $TimeoutSec
}

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Normalize-Path {
    param([string]$Path)
    if (-not $Path) { return "" }
    try { return [IO.Path]::GetFullPath($Path) } catch { return [string]$Path }
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Invoke-LocalJson {
    param([string]$Path)
    return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec 2
}

function Invoke-FixedRouteHealth {
    return Invoke-RestMethod -Uri $fixedRouteHealthUrl -Proxy $null -TimeoutSec 2
}

function Test-AntiCodexRelaunchHealthReady {
    param($Health)
    return [bool](
        $Health -and
        $Health.ok -eq $true -and
        [string]$Health.schema -eq "anticodex-fixed-route-status-v1" -and
        [string]$Health.state -eq "ready" -and
        @("antigravity", "third-party") -contains [string]$Health.provider -and
        -not [string]::IsNullOrWhiteSpace([string]$Health.model)
    )
}

function New-Stage {
    param(
        [string]$Name,
        [DateTime]$StartedAt,
        [bool]$Ok = $true,
        [string]$Message = ""
    )
    return [pscustomobject]@{
        name = $Name
        ok = $Ok
        durationMs = [int]([DateTime]::UtcNow - $StartedAt).TotalMilliseconds
        message = $Message
    }
}

function Save-Progress {
    param([string]$CurrentStage = "")
    if (-not $ProgressPath) { return }
    try {
        $payload = [pscustomobject]@{
            at = [DateTime]::UtcNow.ToString("o")
            currentStage = $CurrentStage
            elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
            failures = $failures.ToArray()
            stages = $stages.ToArray()
        }
        $json = $payload | ConvertTo-Json -Depth 8 -Compress
        [System.IO.File]::WriteAllText($ProgressPath, $json, [System.Text.UTF8Encoding]::new($false))
    } catch {}
}

function New-ReportPaths {
    param([string]$Name)
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    return [pscustomobject]@{
        latest = Join-Path $ReportRoot "latest-$Name.json"
        history = Join-Path $ReportRoot "$stamp-$Name.json"
    }
}

$runtimeRootFull = Normalize-Path $RuntimeRoot
$installRoot = Normalize-Path (Split-Path -Parent $runtimeRootFull)
$activeHost = Normalize-Path (Join-Path $installRoot "codex-patched-app")
$activeMainExe = Normalize-Path (Join-Path $activeHost "Anti-Codex.exe")
$taskLauncherScript = Normalize-Path (Join-Path $runtimeRootFull "scripts\start-anticodex-task.mjs")
$supervisorScript = Normalize-Path (Join-Path $runtimeRootFull "scripts\start-anticodex-fixed-route.mjs")
$launchTaskName = "Anti-Codex Launcher"
$lastSnapshot = [pscustomobject]@{
    main = @()
    supervisor = @()
    launcher = @()
}
$originalCodexBefore = @()
$originalCodexAfter = @()
$originalCodexStopTargetIntersection = @()
$launcherTaskStarted = $false
$launcherTaskStateBefore = $null
$launcherTaskStateAfter = $null
$gracefulShutdownAccepted = $false
$health = $null
$managerHealth = $null
$mainProcesses = @()
$ready = $false
$stopped = $false

function Get-AntiCodexProcessSnapshot {
    $main = New-Object System.Collections.Generic.List[object]
    $supervisor = New-Object System.Collections.Generic.List[object]
    $launcher = New-Object System.Collections.Generic.List[object]
    $installRootEscaped = [regex]::Escape($installRoot)
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $commandLine = [string]$process.CommandLine
        $exe = Normalize-Path ([string]$process.ExecutablePath)
        if (($exe -ieq $activeMainExe) -and $commandLine -notmatch "\s--type=") {
            $main.Add($process) | Out-Null
        }
        if ($commandLine -like "*$supervisorScript*") {
            $supervisor.Add($process) | Out-Null
        }
        if ($process.ProcessId -ne $PID -and
            $commandLine -match $installRootEscaped -and
            $commandLine.IndexOf($taskLauncherScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $launcher.Add($process) | Out-Null
        }
    }
    return [pscustomobject]@{
        main = @($main.ToArray())
        supervisor = @($supervisor.ToArray())
        launcher = @($launcher.ToArray())
    }
}

function Get-AntiCodexHostProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        return $exe.StartsWith($activeHost, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Get-AntiCodexMainProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        return ($exe -ieq $activeMainExe) -and
            ([string]$_.CommandLine) -notmatch "\s--type="
    })
}

function Get-AntiCodexSupervisorProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $commandLine = [string]$_.CommandLine
        $commandLine -like "*$supervisorScript*"
    })
}

function Get-AntiCodexLauncherProcesses {
    $installRootEscaped = [regex]::Escape($installRoot)
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and
        ([string]$_.CommandLine) -match $installRootEscaped -and
        ([string]$_.CommandLine).IndexOf($taskLauncherScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

function Get-OriginalCodexMainProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        $commandLine = [string]$_.CommandLine
        ($_.Name -ieq "Codex.exe" -or $_.Name -ieq "ChatGPT.exe") -and
        (-not $exe.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)) -and
        ($commandLine -notmatch "\s--type=")
    })
}

function Get-AntiCodexLaunchTask {
    $task = Get-ScheduledTask -TaskName $launchTaskName -ErrorAction Stop
    $actions = @($task.Actions)
    if (-not $task.Settings.Enabled -or $actions.Count -ne 1) {
        throw "The isolated Anti-Codex Launcher task is missing or stale."
    }
    $action = $actions[0]
    if ([string]$action.Arguments -notmatch "--headless" -or
        ([string]$action.Arguments).IndexOf($taskLauncherScript, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "The isolated Anti-Codex Launcher task does not target the installed task launcher."
    }
    return $task
}

function Test-AntiCodexLaunchTaskReady {
    try {
        return [int](Get-AntiCodexLaunchTask).State -eq 3
    } catch {
        return $false
    }
}

function Invoke-AntiCodexFixedRouteShutdown {
    try {
        $health = Invoke-FixedRouteHealth
        if (-not $health -or
            $health.ok -ne $true -or
            [string]$health.state -ne "ready" -or
            (Normalize-Path ([string]$health.appExecutable)) -ine $activeMainExe) {
            return $false
        }
        $supervisor = @(Get-AntiCodexSupervisorProcesses | Where-Object { [int]$_.ProcessId -eq [int]$health.pid })
        if ($supervisor.Count -ne 1) { return $false }

        $authPath = Join-Path $env:APPDATA "anticodex\codex-home-deepseek-app\auth.json"
        if (-not (Test-Path -LiteralPath $authPath -PathType Leaf)) { return $false }
        $controlToken = [string](Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json).OPENAI_API_KEY
        if ([string]::IsNullOrWhiteSpace($controlToken)) { return $false }

        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:18487/anticodex/fixed-route/shutdown")
        $request.Method = "POST"
        $request.Proxy = $null
        $request.Timeout = 3000
        $request.ReadWriteTimeout = 3000
        $request.ContentLength = 0
        $request.Headers[[Net.HttpRequestHeader]::Authorization] = "Bearer $controlToken"
        $response = $request.GetResponse()
        try { return [int]$response.StatusCode -eq 202 } finally { $response.Dispose() }
    } catch {
        return $false
    }
}

function Wait-Until {
    param([scriptblock]$Predicate, [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (& $Predicate) { return $true }
        Start-Sleep -Milliseconds ([Math]::Max(100, $PollIntervalMs))
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

if (-not (Test-Path -LiteralPath $taskLauncherScript -PathType Leaf)) {
    Add-Failure "Anti-Codex task launcher missing: $taskLauncherScript"
} else {
    Save-Progress "snapshot-original-codex"
    $originalCodexBefore = @(Get-OriginalCodexMainProcesses | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)

    $launchTask = $null
    try {
        $launchTask = Get-AntiCodexLaunchTask
        $launcherTaskStateBefore = [int]$launchTask.State
    } catch {
        Add-Failure $_.Exception.Message
    }

    $stageStarted = [DateTime]::UtcNow
    Save-Progress "request-graceful-shutdown"
    $stopTargetPids = @(
        @(Get-AntiCodexLauncherProcesses) +
        @(Get-AntiCodexHostProcesses) +
        @(Get-AntiCodexSupervisorProcesses) |
            ForEach-Object { [int]$_.ProcessId } |
            Sort-Object -Unique
    )
    $originalCodexStopTargetIntersection = @($originalCodexBefore | Where-Object { $stopTargetPids -contains $_ })
    if ($originalCodexStopTargetIntersection.Count -gt 0) {
        Add-Failure "original Codex process was selected as an Anti-Codex stop target"
    }

    if ($launchTask -and $originalCodexStopTargetIntersection.Count -eq 0) {
        $gracefulShutdownAccepted = Invoke-AntiCodexFixedRouteShutdown
    }
    $stages.Add((New-Stage "request-graceful-shutdown" $stageStarted $gracefulShutdownAccepted "authenticated fixed-route shutdown requested")) | Out-Null
    if (-not $gracefulShutdownAccepted) {
        Add-Failure "Anti-Codex did not accept the authenticated graceful shutdown request"
    } else {
        $stopped = Wait-Until -TimeoutSeconds $StopTimeoutSec -Predicate {
            @(Get-AntiCodexLauncherProcesses).Count -eq 0 -and
            @(Get-AntiCodexHostProcesses).Count -eq 0 -and
            @(Get-AntiCodexSupervisorProcesses).Count -eq 0 -and
            (Test-AntiCodexLaunchTaskReady)
        }
        if (-not $stopped) {
            Add-Failure "Anti-Codex did not stop cleanly within $StopTimeoutSec seconds"
        }
    }
    $stages.Add((New-Stage "wait-clean-stop" $stageStarted $stopped "task launcher, copied client, and fixed-route supervisor stopped")) | Out-Null
    Save-Progress "stopped-existing-processes"

    $stageStarted = [DateTime]::UtcNow
    Save-Progress "launch-anticodex"
    if ($stopped) {
        try {
            $launchTask = Get-AntiCodexLaunchTask
            if ([int]$launchTask.State -ne 3) {
                throw "The isolated Anti-Codex Launcher task was not Ready before relaunch."
            }
            Start-ScheduledTask -TaskName $launchTaskName
            $launcherTaskStarted = $true
        } catch {
            Add-Failure "failed to launch Anti-Codex through its isolated task: $($_.Exception.Message)"
        }
    }
    $stages.Add((New-Stage "launch-anticodex" $stageStarted $launcherTaskStarted "isolated Anti-Codex Launcher task dispatched")) | Out-Null
    Save-Progress "launched-anticodex"

    $stageStarted = [DateTime]::UtcNow
    Save-Progress "wait-health-ready"
    if ($launcherTaskStarted) {
        $ready = Wait-Until -TimeoutSeconds $HealthPollTimeoutSec -Predicate {
            $script:lastSnapshot = Get-AntiCodexProcessSnapshot
            $script:mainProcesses = @($script:lastSnapshot.main)
            try {
                $script:managerHealth = Invoke-LocalJson "/health"
                $script:health = Invoke-FixedRouteHealth
                $healthReady = Test-AntiCodexRelaunchHealthReady $script:health
                $managerReady = $script:managerHealth.ok -eq $true -and [string]$script:managerHealth.schema -eq "anticodex-manager-service-v1"
                return $healthReady -and $managerReady -and $script:mainProcesses.Count -eq 1
            } catch {
                return $false
            }
        }
    }
    $stages.Add((New-Stage "wait-health-ready" $stageStarted $ready "main process and local health ready")) | Out-Null
    Save-Progress "health-ready"

    if (-not $ready) {
        try {
            $managerHealth = Invoke-LocalJson "/health"
            $health = Invoke-FixedRouteHealth
        } catch {}
        $mainProcesses = @(Get-AntiCodexMainProcesses)
        $ready = (Test-AntiCodexRelaunchHealthReady $health) -and $mainProcesses.Count -ge 1
        if (-not $ready) {
            Add-Failure "Anti-Codex did not relaunch to a healthy state within $HealthPollTimeoutSec seconds"
        }
    }

    $mainProcesses = @(Get-AntiCodexMainProcesses)
    if ($mainProcesses.Count -lt 1 -and $health -and $health.ok -eq $true) {
        $mainReady = Wait-Until -TimeoutSeconds 10 -Predicate {
            $script:mainProcesses = @(Get-AntiCodexMainProcesses)
            return $script:mainProcesses.Count -ge 1
        }
        if ($mainReady) {
            $mainProcesses = @($script:mainProcesses)
        }
    }
    $lastSnapshot = Get-AntiCodexProcessSnapshot
    if ($mainProcesses.Count -ne 1) {
        Add-Failure "expected exactly one Anti-Codex main process, found $($mainProcesses.Count)"
    }

    try { $launcherTaskStateAfter = [int](Get-AntiCodexLaunchTask).State } catch {}
    $originalCodexAfter = @(Get-OriginalCodexMainProcesses | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
    if (($originalCodexBefore -join ",") -ne ($originalCodexAfter -join ",")) {
        Add-Failure "original Codex main process identity changed during Anti-Codex cold relaunch"
    }
}
Save-Progress "final-snapshot"

$endedAt = [DateTime]::UtcNow
$healthSnapshot = $health
if (-not $healthSnapshot) {
    try { $healthSnapshot = Invoke-FixedRouteHealth } catch {}
}
$managerHealthSnapshot = $managerHealth
if (-not $managerHealthSnapshot) { try { $managerHealthSnapshot = Invoke-LocalJson "/health" } catch {} }
$finalSnapshot = Get-AntiCodexProcessSnapshot
$mainSnapshot = @($finalSnapshot.main)
$supervisorSnapshot = @($finalSnapshot.supervisor)
$reportPaths = New-ReportPaths "cold-relaunch"
$originalCodexPidSetUnchanged = (($originalCodexBefore -join ",") -eq ($originalCodexAfter -join ","))

$result = [pscustomobject]@{
    reportName = "cold-relaunch"
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    startedAt = $startedAt.ToString("o")
    endedAt = $endedAt.ToString("o")
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    runtimeRoot = $runtimeRootFull
    installRoot = $installRoot
    health = [pscustomobject]@{
        ok = if ($healthSnapshot) { $healthSnapshot.ok } else { $false }
        schema = if ($healthSnapshot) { $healthSnapshot.schema } else { $null }
        state = if ($healthSnapshot) { $healthSnapshot.state } else { $null }
        provider = if ($healthSnapshot) { $healthSnapshot.provider } else { $null }
        model = if ($healthSnapshot) { $healthSnapshot.model } else { $null }
        providerReady = [bool](Test-AntiCodexRelaunchHealthReady $healthSnapshot)
        managerReady = [bool]($managerHealthSnapshot -and $managerHealthSnapshot.ok -eq $true -and [string]$managerHealthSnapshot.schema -eq "anticodex-manager-service-v1")
    }
    processes = [pscustomobject]@{
        mainCount = $mainSnapshot.Count
        mainPids = @($mainSnapshot | ForEach-Object { [int]$_.ProcessId })
        supervisorCount = $supervisorSnapshot.Count
        supervisorPids = @($supervisorSnapshot | ForEach-Object { [int]$_.ProcessId })
        launcherCount = @($finalSnapshot.launcher).Count
    }
    launcher = [pscustomobject]@{
        started = $launcherTaskStarted
        mode = "scheduled-task"
        taskName = $launchTaskName
        taskScript = $taskLauncherScript
        taskStateBefore = $launcherTaskStateBefore
        taskStateAfter = $launcherTaskStateAfter
        gracefulShutdownAccepted = $gracefulShutdownAccepted
    }
    originalCodex = [pscustomobject]@{
        unchanged = ($originalCodexStopTargetIntersection.Count -eq 0 -and $originalCodexPidSetUnchanged)
        beforePids = @($originalCodexBefore)
        afterPids = @($originalCodexAfter)
        stopTargetIntersectionPids = @($originalCodexStopTargetIntersection)
        pidSetUnchanged = $originalCodexPidSetUnchanged
    }
    stopTimeoutSec = $StopTimeoutSec
    healthPollTimeoutSec = $HealthPollTimeoutSec
    stages = $stages.ToArray()
    report = [pscustomobject]@{
        latest = $reportPaths.latest
        history = $reportPaths.history
    }
}

$json = $result | ConvertTo-Json -Depth 8 -Compress
Write-AntiCodexJsonReport -LatestPath $reportPaths.latest -HistoryPath $reportPaths.history -Json $json -Encoding ([System.Text.UTF8Encoding]::new($false))
$json
if ($failures.Count -gt 0) { exit 1 }

