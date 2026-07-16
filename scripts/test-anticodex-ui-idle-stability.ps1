[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [string]$CodexHome = "",
    [int]$DurationSec = 20,
    [int]$IntervalSec = 5,
    [int]$TimeoutSec = 8,
    [switch]$SkipManagerActionProbe
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}
$fixedRouteHealthUrl = "http://127.0.0.1:18487/anticodex/fixed-route/health"

$failures = New-Object System.Collections.Generic.List[string]
$transientUiFailures = New-Object System.Collections.Generic.List[string]
$samples = New-Object System.Collections.Generic.List[object]
$startedAt = [DateTime]::UtcNow

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Get-RemainingIdleBudgetMs {
    param([DateTime]$Deadline)
    return [Math]::Max(0, [int]($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
}

function Normalize-Path {
    param([string]$Path)
    if (-not $Path) { return "" }
    try { return [IO.Path]::GetFullPath($Path) } catch { return [string]$Path }
}

function Invoke-LocalJson {
    param([string]$Path, [int]$RequestTimeoutSec = $TimeoutSec)
    return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec ([Math]::Max(1, $RequestTimeoutSec))
}

function Invoke-FixedRouteHealth {
    param([int]$RequestTimeoutSec = $TimeoutSec)
    return Invoke-RestMethod -Uri $fixedRouteHealthUrl -Proxy $null -TimeoutSec ([Math]::Max(1, $RequestTimeoutSec))
}

function Get-NativeRequestSnapshot {
    param([string]$ScriptPath, [string]$CodexHomePath)
    $node = (Get-Command "node.exe" -ErrorAction Stop).Source
    $output = @(& $node --no-warnings $ScriptPath --codex-home $CodexHomePath 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "native request snapshot failed: $($output -join ' ')"
    }
    $payload = ($output | Select-Object -Last 1) | ConvertFrom-Json -ErrorAction Stop
    if ($payload.ok -ne $true -or $payload.databasePresent -ne $true) {
        throw "native request snapshot did not prove the logs database"
    }
    return $payload
}

function Invoke-UiState {
    param([string]$ScriptPath, [string]$RuntimeRootFull, [int]$RequestTimeoutSec = $TimeoutSec)

    function Invoke-UiStateInRunspace {
        param([string]$Path, [string]$RuntimeRootForUi, [int]$UiTimeoutSec)
        $ps = [powershell]::Create()
        try {
            [void]$ps.AddScript(@'
param([string]$Path, [string]$BaseUrl, [string]$RuntimeRoot, [int]$TimeoutSec, [bool]$SkipManagerActionProbe)
$args = @{
    BaseUrl = $BaseUrl
    RuntimeRoot = $RuntimeRoot
    TimeoutSec = $TimeoutSec
}
if ($SkipManagerActionProbe) {
    $args.SkipManagerActionProbe = $true
}
& $Path @args
'@)
            [void]$ps.AddArgument($Path)
            [void]$ps.AddArgument($BaseUrl)
            [void]$ps.AddArgument($RuntimeRootForUi)
            [void]$ps.AddArgument([Math]::Max(1, $UiTimeoutSec))
            [void]$ps.AddArgument([bool]$SkipManagerActionProbe)
            $output = @($ps.Invoke())
            $errors = @($ps.Streams.Error | ForEach-Object { [string]$_ })
            return [pscustomobject]@{
                exitCode = if ($ps.HadErrors) { 1 } else { 0 }
                output = @($output | ForEach-Object {
                    if ($_ -is [string]) { $_ } else { ($_ | Out-String).TrimEnd() }
                })
                errors = $errors
            }
        } finally {
            $ps.Dispose()
        }
    }

    $powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $arguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath,
        "-BaseUrl", $BaseUrl,
        "-RuntimeRoot", $RuntimeRootFull,
        "-TimeoutSec", "$([Math]::Max(1, $RequestTimeoutSec))"
    )
    if ($SkipManagerActionProbe) {
        $arguments += "-SkipManagerActionProbe"
    }
    $stdoutPath = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-ui-idle-ui-state-{0}.out" -f ([Guid]::NewGuid().ToString("N")))
    $stderrPath = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-ui-idle-ui-state-{0}.err" -f ([Guid]::NewGuid().ToString("N")))
    $fallbackWarnings = @()
    try {
        try {
            $process = Start-Process -FilePath $powerShellBin -ArgumentList $arguments -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
            $waitMs = [Math]::Max(1000, ([Math]::Max(1, $RequestTimeoutSec) * 1000) + 5000)
            if (-not $process.WaitForExit($waitMs)) {
                try { $process.Kill() } catch {}
                return [pscustomobject]@{
                    ok = $false
                    exitCode = $null
                    failures = @("UI state verifier timed out after $RequestTimeoutSec seconds")
                    tail = @()
                }
            }
            $process.Refresh()
            $exitCode = $process.ExitCode
            $output = @()
            if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { $output += @(Get-Content -LiteralPath $stdoutPath -Encoding UTF8 -ErrorAction SilentlyContinue) }
            if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { $output += @(Get-Content -LiteralPath $stderrPath -Encoding UTF8 -ErrorAction SilentlyContinue) }
        } catch {
            $startError = $_.Exception.Message
            try {
                $fallback = Invoke-UiStateInRunspace -Path $ScriptPath -RuntimeRootForUi $RuntimeRootFull -UiTimeoutSec $RequestTimeoutSec
                $exitCode = [int]$fallback.exitCode
                $fallbackWarnings += "$ScriptPath failed to start; falling back to same-process UI state verification: $startError"
                $output = @($fallback.output)
                $output += @($fallback.errors)
            } catch {
                return [pscustomobject]@{
                    ok = $false
                    exitCode = -1
                    failures = @("UI state verifier Start-Process failed and same-process fallback failed: $startError / $($_.Exception.Message)")
                    tail = @()
                }
            }
        }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
    $lines = @($output | ForEach-Object { [string]$_ })
    $payloadText = ($lines -join "").Trim()
    if (-not $payloadText) {
        return [pscustomobject]@{
            ok = $false
            exitCode = $exitCode
            failures = @("UI state verifier emitted no JSON")
            tail = @($lines | Select-Object -Last 10)
        }
    }
    try {
        $start = $payloadText.IndexOf("{")
        $end = $payloadText.LastIndexOf("}")
        if ($start -ge 0 -and $end -gt $start) {
            $payloadText = $payloadText.Substring($start, $end - $start + 1)
        }
        $parsed = $payloadText | ConvertFrom-Json -ErrorAction Stop
        $parsed | Add-Member -NotePropertyName exitCode -NotePropertyValue $exitCode -Force
        $parsed | Add-Member -NotePropertyName fallbackWarnings -NotePropertyValue @($fallbackWarnings) -Force
        return $parsed
    } catch {
        return [pscustomobject]@{
            ok = $false
            exitCode = $exitCode
            failures = @("UI state verifier emitted invalid JSON: $($_.Exception.Message)")
            tail = @($lines | Select-Object -Last 10)
        }
    }
}

function Get-AntiCodexProcesses {
    param([string]$InstallRoot, [string]$RuntimeRootFull)

    $activeMainExe = Normalize-Path (Join-Path $InstallRoot "codex-patched-app\Anti-Codex.exe")
    $supervisorScript = Normalize-Path (Join-Path $RuntimeRootFull "scripts\start-anticodex-fixed-route.mjs")
    $main = New-Object System.Collections.Generic.List[int]
    $supervisor = New-Object System.Collections.Generic.List[int]
    $managerWatcher = New-Object System.Collections.Generic.List[int]
    $legacyManagerWatcher = New-Object System.Collections.Generic.List[int]

    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $exe = Normalize-Path ([string]$process.ExecutablePath)
        $commandLine = [string]$process.CommandLine
        if ($exe -ieq $activeMainExe -and $commandLine -notmatch "\s--type=") {
            $main.Add([int]$process.ProcessId) | Out-Null
        }
        if ($commandLine -like "*$supervisorScript*") {
            $supervisor.Add([int]$process.ProcessId) | Out-Null
        }
        $isManagerInjection = (
            $commandLine -match "deepcodex-cdp-inject\.mjs" -and
            $commandLine -match "anticodex-manager-inject\.js" -and
            $commandLine -like "*$RuntimeRootFull*"
        )
        if ($isManagerInjection -and $commandLine -match "(^|\s)--watch(\s|$)") {
            $managerWatcher.Add([int]$process.ProcessId) | Out-Null
        } elseif ($isManagerInjection) {
            $legacyManagerWatcher.Add([int]$process.ProcessId) | Out-Null
        }
    }

    return [pscustomobject]@{
        mainPids = @($main.ToArray())
        supervisorPids = @($supervisor.ToArray())
        managerWatcherPids = @($managerWatcher.ToArray())
        legacyManagerWatcherPids = @($legacyManagerWatcher.ToArray())
    }
}

function New-ReportPaths {
    param([string]$Name)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    return [pscustomobject]@{
        latest = (Join-Path $ReportRoot "latest-$Name.json")
        history = (Join-Path $ReportRoot "$stamp-$Name.json")
    }
}

function Save-JsonReport {
    param($Paths, $Payload, [int]$Depth = 12)
    $json = $Payload | ConvertTo-Json -Depth $Depth -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $Paths.latest -HistoryPath $Paths.history -Json $json -Encoding $utf8NoBom
}

$runtimeRootFull = Normalize-Path $RuntimeRoot
$installRoot = Normalize-Path (Split-Path -Parent $runtimeRootFull)
$stateRoot = Normalize-Path (Split-Path -Parent $ReportRoot)
$codexHomeFull = Normalize-Path $(if ($CodexHome) { $CodexHome } else { Join-Path $stateRoot "codex-home-deepseek-app" })
$nativeRequestSnapshotScript = Join-Path $runtimeRootFull "scripts\read-anticodex-native-request-snapshot.mjs"
if (-not (Test-Path -LiteralPath $nativeRequestSnapshotScript -PathType Leaf)) {
    $nativeRequestSnapshotScript = Join-Path $PSScriptRoot "read-anticodex-native-request-snapshot.mjs"
}
$nativeRequestStart = $null
$nativeRequestEnd = $null
$nativeRequestDelta = $null
try {
    if (-not (Test-Path -LiteralPath $nativeRequestSnapshotScript -PathType Leaf)) {
        throw "native request snapshot helper missing"
    }
    $nativeRequestStart = Get-NativeRequestSnapshot $nativeRequestSnapshotScript $codexHomeFull
} catch {
    Add-Failure "native request baseline failed: $($_.Exception.Message)"
}
$uiStateScript = Join-Path $runtimeRootFull "scripts\test-anticodex-ui-state.ps1"
if (-not (Test-Path -LiteralPath $uiStateScript -PathType Leaf)) {
    $uiStateScript = Join-Path $PSScriptRoot "test-anticodex-ui-state.ps1"
}
if (-not (Test-Path -LiteralPath $uiStateScript -PathType Leaf)) {
    Add-Failure "UI state verifier missing"
}

$deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $DurationSec))
$firstMainPids = $null
$firstSupervisorPids = $null
$firstManagerWatcherPids = $null
$firstLegacyManagerWatcherPids = $null
$sampleIndex = 0
$uiSuccessCount = 0

while ([DateTime]::UtcNow -lt $deadline -or $sampleIndex -eq 0) {
    $sampleIndex += 1
    $timestamp = [DateTime]::UtcNow.ToString("o")
    $health = $null
    $ui = $null
    $processes = Get-AntiCodexProcesses $installRoot $runtimeRootFull

    try {
        $healthTimeoutSec = [Math]::Max(1, $TimeoutSec)
        $managerHealth = Invoke-LocalJson "/health" -RequestTimeoutSec $healthTimeoutSec
        $health = Invoke-FixedRouteHealth -RequestTimeoutSec $healthTimeoutSec
        if ($managerHealth.ok -ne $true -or [string]$managerHealth.schema -ne "anticodex-manager-service-v1") { Add-Failure "sample ${sampleIndex}: Manager health contract failed" }
        if ($health.ok -ne $true -or [string]$health.state -ne "ready") { Add-Failure "sample ${sampleIndex}: fixed route is not ready" }
        if (@("antigravity", "third-party") -notcontains [string]$health.provider) { Add-Failure "sample ${sampleIndex}: invalid fixed-route provider $($health.provider)" }
        if (-not [string]$health.model) { Add-Failure "sample ${sampleIndex}: fixed-route model is empty" }
    } catch {
        Add-Failure "sample ${sampleIndex}: health failed: $($_.Exception.Message)"
    }

    if (Test-Path -LiteralPath $uiStateScript -PathType Leaf) {
        $remainingMs = Get-RemainingIdleBudgetMs $deadline
        if ($remainingMs -lt 1000 -and $sampleIndex -gt 1 -and $uiSuccessCount -lt 1) {
            Add-Failure "sample ${sampleIndex}: UI state skipped because idle verifier budget was exhausted"
        } else {
            $uiTimeoutSec = [Math]::Max(1, $TimeoutSec)
            $ui = Invoke-UiState $uiStateScript $runtimeRootFull -RequestTimeoutSec $uiTimeoutSec
        }
        if ($ui.ok -eq $true) {
            $uiSuccessCount += 1
        } elseif ($sampleIndex -eq 1) {
            $transientUiFailures.Add("sample ${sampleIndex}: UI state was not ready during warmup") | Out-Null
        } else {
            Add-Failure "sample ${sampleIndex}: UI state failed"
        }
        if ($ui.page -and $ui.page.hasReconnectText -eq $true) {
            Add-Failure "sample ${sampleIndex}: UI showed reconnect text"
        }
        if ($ui.page -and $ui.page.hasLoginText -eq $true) {
            Add-Failure "sample ${sampleIndex}: UI showed ChatGPT login text"
        }
    }

    if (@($processes.mainPids).Count -ne 1) {
        Add-Failure "sample ${sampleIndex}: expected one Anti-Codex main process, found $(@($processes.mainPids).Count)"
    }
    if (@($processes.supervisorPids).Count -ne 1) {
        Add-Failure "sample ${sampleIndex}: expected one fixed-route supervisor, found $(@($processes.supervisorPids).Count)"
    }
    if (@($processes.managerWatcherPids).Count -ne 1) {
        Add-Failure "sample ${sampleIndex}: expected one manager injection watcher, found $(@($processes.managerWatcherPids).Count)"
    }
    if (@($processes.managerWatcherPids).Count -gt 1) {
        Add-Failure "sample ${sampleIndex}: expected at most one manager injection watcher, found $(@($processes.managerWatcherPids).Count)"
    }
    if (@($processes.legacyManagerWatcherPids).Count -gt 0) {
        Add-Failure "sample ${sampleIndex}: legacy manager injection watcher still running"
    }

    if ($sampleIndex -eq 1) {
        $firstMainPids = @($processes.mainPids)
        $firstSupervisorPids = @($processes.supervisorPids)
        $firstManagerWatcherPids = @($processes.managerWatcherPids)
        $firstLegacyManagerWatcherPids = @($processes.legacyManagerWatcherPids)
    } else {
        if ((@($processes.mainPids) -join ",") -ne ($firstMainPids -join ",")) {
            Add-Failure "sample ${sampleIndex}: Anti-Codex main process changed during idle"
        }
        if ((@($processes.supervisorPids) -join ",") -ne ($firstSupervisorPids -join ",")) {
            Add-Failure "sample ${sampleIndex}: fixed-route supervisor changed during idle"
        }
        if ((@($processes.managerWatcherPids) -join ",") -ne ($firstManagerWatcherPids -join ",")) {
            Add-Failure "sample ${sampleIndex}: manager injection watcher count changed during idle"
        }
        if ((@($processes.legacyManagerWatcherPids) -join ",") -ne ($firstLegacyManagerWatcherPids -join ",")) {
            Add-Failure "sample ${sampleIndex}: legacy manager injection watcher count changed during idle"
        }
    }

    $samples.Add([pscustomobject]@{
        index = $sampleIndex
        at = $timestamp
        healthOk = if ($health) { $health.ok } else { $false }
        provider = if ($health) { $health.provider } else { "" }
        model = if ($health) { $health.model } else { "" }
        mainPids = @($processes.mainPids)
        supervisorPids = @($processes.supervisorPids)
        managerWatcherPids = @($processes.managerWatcherPids)
        legacyManagerWatcherPids = @($processes.legacyManagerWatcherPids)
        uiOk = if ($ui) { $ui.ok } else { $false }
        hasReconnectText = if ($ui -and $ui.page) { $ui.page.hasReconnectText } else { $null }
        hasLoginText = if ($ui -and $ui.page) { $ui.page.hasLoginText } else { $null }
        matchedModelText = if ($ui) { $ui.matchedModelText } else { "" }
        uiFailures = if ($ui -and $ui.failures) { @($ui.failures) } else { @() }
        uiExitCode = if ($ui -and ($ui.PSObject.Properties.Name -contains "exitCode")) { $ui.exitCode } else { $null }
    }) | Out-Null

    if ([DateTime]::UtcNow -lt $deadline) {
        $sleepMs = [Math]::Min(([Math]::Max(1, $IntervalSec) * 1000), (Get-RemainingIdleBudgetMs $deadline))
        if ($sleepMs -gt 0) {
            Start-Sleep -Milliseconds $sleepMs
        }
    }
}

if ((Test-Path -LiteralPath $uiStateScript -PathType Leaf) -and $uiSuccessCount -lt 1) {
    Add-Failure "UI state never reached ready during idle window"
}

try {
    $nativeRequestEnd = Get-NativeRequestSnapshot $nativeRequestSnapshotScript $codexHomeFull
    if ($nativeRequestStart) {
        $nativeRequestDelta = [long]$nativeRequestEnd.requestCount - [long]$nativeRequestStart.requestCount
        if ($nativeRequestDelta -ne 0) {
            Add-Failure "native request count changed during idle: delta=$nativeRequestDelta"
        }
    }
} catch {
    Add-Failure "native request final snapshot failed: $($_.Exception.Message)"
}

$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    transientUiFailures = $transientUiFailures.ToArray()
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    baseUrl = $BaseUrl
    runtimeRoot = $runtimeRootFull
    installRoot = $installRoot
    codexHome = $codexHomeFull
    durationSec = $DurationSec
    intervalSec = $IntervalSec
    sampleCount = $samples.Count
    uiSuccessCount = $uiSuccessCount
    nativeRequests = [pscustomobject]@{
        start = $nativeRequestStart
        end = $nativeRequestEnd
        nativeRequestDelta = $nativeRequestDelta
        stable = ($null -ne $nativeRequestDelta -and $nativeRequestDelta -eq 0)
    }
    samples = $samples.ToArray()
}

$reportPaths = New-ReportPaths "ui-idle-stability"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
Save-JsonReport $reportPaths $result
$result | ConvertTo-Json -Depth 12 -Compress
if ($failures.Count -gt 0) { exit 1 }


