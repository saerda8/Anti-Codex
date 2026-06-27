[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [int]$TimeoutSec = 18,
    [int]$StopTimeoutSec = 5,
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

function Resolve-AntiCodexMode {
    param($Health)
    if ((Has-Property $Health "upstreamProfile") -and $Health.upstreamProfile -and (Has-Property $Health.upstreamProfile "mode")) {
        return [string]$Health.upstreamProfile.mode
    }
    if (Has-Property $Health "mode") { return [string]$Health.mode }
    if ($Health.upstream -eq "antigravity-desktop") { return "antigravity" }
    return "unknown"
}

function Test-AntiCodexRelaunchHealthReady {
    param($Health)
    if (-not $Health -or $Health.ok -ne $true) { return $false }
    $mode = Resolve-AntiCodexMode $Health
    if ($mode -eq "third-party") {
        return [bool](
            (Has-Property $Health "upstreamProfile") -and
            $Health.upstreamProfile -and
            $Health.upstreamProfile.protocol -and
            $Health.upstreamProfile.model
        )
    }
    return [bool]($Health.upstream -eq "antigravity-desktop" -and [int]$Health.modelCount -gt 0)
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
$startAntiCodex = Join-Path $runtimeRootFull "scripts\start-anticodex.ps1"
$translatorScript = Normalize-Path (Join-Path $runtimeRootFull "translator\adaptive-server.mjs")
$translatorExe = Normalize-Path (Join-Path $installRoot "bin\deepcodex-translator.exe")
$lastSnapshot = [pscustomobject]@{
    main = @()
    translator = @()
    launcher = @()
}
$originalCodexBefore = @()
$originalCodexAfter = @()
$originalCodexStopTargetIntersection = @()

function Get-AntiCodexProcessSnapshot {
    $main = New-Object System.Collections.Generic.List[object]
    $translator = New-Object System.Collections.Generic.List[object]
    $launcher = New-Object System.Collections.Generic.List[object]
    $installRootEscaped = [regex]::Escape($installRoot)
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $commandLine = [string]$process.CommandLine
        $exe = Normalize-Path ([string]$process.ExecutablePath)
        if (($exe -ieq $activeMainExe) -and $commandLine -notmatch "\s--type=") {
            $main.Add($process) | Out-Null
        }
        if (($exe -ieq $translatorExe) -or ($commandLine -like "*$translatorScript*")) {
            $translator.Add($process) | Out-Null
        }
        if ($process.ProcessId -ne $PID -and $commandLine -match $installRootEscaped -and $commandLine -match "start-(anti|deep)codex\.ps1") {
            $launcher.Add($process) | Out-Null
        }
    }
    return [pscustomobject]@{
        main = @($main.ToArray())
        translator = @($translator.ToArray())
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

function Get-AntiCodexTranslatorProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $commandLine = [string]$_.CommandLine
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        ($exe -ieq $translatorExe) -or ($commandLine -like "*$translatorScript*")
    })
}

function Get-AntiCodexLauncherProcesses {
    $installRootEscaped = [regex]::Escape($installRoot)
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and
        ([string]$_.CommandLine) -match $installRootEscaped -and
        ([string]$_.CommandLine) -match "start-(anti|deep)codex\.ps1"
    })
}

function Get-OriginalCodexMainProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        $commandLine = [string]$_.CommandLine
        ($_.Name -ieq "Codex.exe") -and
        (-not $exe.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)) -and
        ($commandLine -notmatch "\s--type=")
    })
}

function Stop-ProcessList {
    param($Processes)
    foreach ($process in @($Processes)) {
        try { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
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

if (-not (Test-Path -LiteralPath $startAntiCodex -PathType Leaf)) {
    Add-Failure "Anti-Codex launcher missing: $startAntiCodex"
} else {
    Save-Progress "snapshot-original-codex"
    $originalCodexBefore = @(Get-OriginalCodexMainProcesses | ForEach-Object { [int]$_.ProcessId })

    $stageStarted = [DateTime]::UtcNow
    Save-Progress "stop-existing-processes"
    $launcherStopTargets = @(Get-AntiCodexLauncherProcesses)
    $hostStopTargets = @(Get-AntiCodexHostProcesses)
    $translatorStopTargets = @(Get-AntiCodexTranslatorProcesses)
    $stopTargetPids = @($launcherStopTargets + $hostStopTargets + $translatorStopTargets | ForEach-Object { [int]$_.ProcessId })
    $originalCodexStopTargetIntersection = @($originalCodexBefore | Where-Object { $stopTargetPids -contains $_ })
    if ($originalCodexStopTargetIntersection.Count -gt 0) {
        Add-Failure "original Codex process was selected as an Anti-Codex stop target"
    }
    Stop-ProcessList $launcherStopTargets
    Stop-ProcessList $hostStopTargets
    Stop-ProcessList $translatorStopTargets

    $stopped = Wait-Until -TimeoutSeconds $StopTimeoutSec -Predicate {
        @(Get-AntiCodexLauncherProcesses).Count -eq 0 -and
        @(Get-AntiCodexHostProcesses).Count -eq 0 -and
        @(Get-AntiCodexTranslatorProcesses).Count -eq 0
    }
    $stages.Add((New-Stage "stop-existing-processes" $stageStarted $stopped "launcher, host, and translator stopped")) | Out-Null
    Save-Progress "stopped-existing-processes"
    if (-not $stopped) {
        Add-Failure "Anti-Codex old processes did not stop within $StopTimeoutSec seconds"
    }

    $stageStarted = [DateTime]::UtcNow
    $launched = $true
    Save-Progress "launch-anticodex"
    $launcherOutPath = [IO.Path]::GetTempFileName()
    $launcherErrPath = [IO.Path]::GetTempFileName()
    try {
        $powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
        Start-Process -FilePath $powerShellBin `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$startAntiCodex`"") `
            -RedirectStandardOutput $launcherOutPath `
            -RedirectStandardError $launcherErrPath `
            -WindowStyle Hidden | Out-Null
    } catch {
        $launched = $false
        Add-Failure "failed to launch Anti-Codex: $($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $launcherOutPath, $launcherErrPath -Force -ErrorAction SilentlyContinue
    }
    $stages.Add((New-Stage "launch-anticodex" $stageStarted $launched "start-anticodex.ps1 dispatched")) | Out-Null
    Save-Progress "launched-anticodex"

    $health = $null
    $mainProcesses = @()
    $stageStarted = [DateTime]::UtcNow
    Save-Progress "wait-health-ready"
    $ready = Wait-Until -TimeoutSeconds $HealthPollTimeoutSec -Predicate {
        $script:lastSnapshot = Get-AntiCodexProcessSnapshot
        $script:mainProcesses = @($script:lastSnapshot.main)
        try {
            $script:health = Invoke-LocalJson "/health"
            $healthReady = Test-AntiCodexRelaunchHealthReady $script:health
            return $healthReady -and $script:mainProcesses.Count -ge 1
        } catch {
            return $false
        }
    }
    $stages.Add((New-Stage "wait-health-ready" $stageStarted $ready "main process and local health ready")) | Out-Null
    Save-Progress "health-ready"

    if (-not $ready) {
        try {
            $health = Invoke-LocalJson "/health"
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

    $originalCodexAfter = @(Get-OriginalCodexMainProcesses | ForEach-Object { [int]$_.ProcessId })
}
Save-Progress "final-snapshot"

$endedAt = [DateTime]::UtcNow
$healthSnapshot = $health
if (-not $healthSnapshot) {
    try { $healthSnapshot = Invoke-LocalJson "/health" } catch {}
}
$healthMode = if ($healthSnapshot) { Resolve-AntiCodexMode $healthSnapshot } else { "unknown" }
$healthProfile = if ($healthSnapshot -and (Has-Property $healthSnapshot "upstreamProfile")) { $healthSnapshot.upstreamProfile } else { $null }
$finalSnapshot = Get-AntiCodexProcessSnapshot
$mainSnapshot = @($finalSnapshot.main)
$translatorSnapshot = @($finalSnapshot.translator)
$reportPaths = New-ReportPaths "cold-relaunch"

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
        upstream = if ($healthSnapshot) { $healthSnapshot.upstream } else { $null }
        mode = $healthMode
        protocol = if ($healthProfile -and (Has-Property $healthProfile "protocol")) { $healthProfile.protocol } else { $null }
        model = if ($healthProfile -and (Has-Property $healthProfile "model")) { $healthProfile.model } else { $null }
        providerReady = [bool](Test-AntiCodexRelaunchHealthReady $healthSnapshot)
        accountReady = if ($healthSnapshot) { $healthSnapshot.accountReady } else { $false }
        accountState = if ($healthSnapshot) { $healthSnapshot.accountState } else { $null }
        modelCount = if ($healthSnapshot) { $healthSnapshot.modelCount } else { 0 }
    }
    processes = [pscustomobject]@{
        mainCount = $mainSnapshot.Count
        mainPids = @($mainSnapshot | ForEach-Object { [int]$_.ProcessId })
        translatorCount = $translatorSnapshot.Count
        translatorPids = @($translatorSnapshot | ForEach-Object { [int]$_.ProcessId })
        launcherCount = @($finalSnapshot.launcher).Count
    }
    originalCodex = [pscustomobject]@{
        unchanged = ($originalCodexStopTargetIntersection.Count -eq 0)
        beforePids = @($originalCodexBefore)
        afterPids = @($originalCodexAfter)
        stopTargetIntersectionPids = @($originalCodexStopTargetIntersection)
        pidSetUnchanged = (($originalCodexBefore -join ",") -eq ($originalCodexAfter -join ","))
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


