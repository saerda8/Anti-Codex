[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$DurationSec = 20,
    [int]$IntervalSec = 5,
    [int]$TimeoutSec = 8,
    [switch]$SkipManagerActionProbe
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$failures = New-Object System.Collections.Generic.List[string]
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

function Invoke-UiState {
    param([string]$ScriptPath, [string]$RuntimeRootFull, [int]$RequestTimeoutSec = $TimeoutSec)

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
    try {
        $process = Start-Process -FilePath $powerShellBin -ArgumentList $arguments -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        $waitMs = [Math]::Max(1000, ([Math]::Max(1, $RequestTimeoutSec) * 1000) + 1000)
        if (-not $process.WaitForExit($waitMs)) {
            try { $process.Kill() } catch {}
            return [pscustomobject]@{
                ok = $false
                exitCode = $null
                failures = @("UI state verifier timed out after $RequestTimeoutSec seconds")
                tail = @()
            }
        }
        $exitCode = $process.ExitCode
        $output = @()
        if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { $output += @(Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue) }
        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { $output += @(Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue) }
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
    $translatorScript = Normalize-Path (Join-Path $RuntimeRootFull "translator\adaptive-server.mjs")
    $translatorExe = Normalize-Path (Join-Path $InstallRoot "bin\deepcodex-translator.exe")
    $main = New-Object System.Collections.Generic.List[int]
    $translator = New-Object System.Collections.Generic.List[int]
    $managerWatcher = New-Object System.Collections.Generic.List[int]
    $legacyManagerWatcher = New-Object System.Collections.Generic.List[int]

    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $exe = Normalize-Path ([string]$process.ExecutablePath)
        $commandLine = [string]$process.CommandLine
        if ($exe -ieq $activeMainExe -and $commandLine -notmatch "\s--type=") {
            $main.Add([int]$process.ProcessId) | Out-Null
        }
        if ($exe -ieq $translatorExe -or $commandLine -like "*$translatorScript*") {
            $translator.Add([int]$process.ProcessId) | Out-Null
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
        translatorPids = @($translator.ToArray())
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
$uiStateScript = Join-Path $runtimeRootFull "scripts\test-anticodex-ui-state.ps1"
if (-not (Test-Path -LiteralPath $uiStateScript -PathType Leaf)) {
    $uiStateScript = Join-Path $PSScriptRoot "test-anticodex-ui-state.ps1"
}
if (-not (Test-Path -LiteralPath $uiStateScript -PathType Leaf)) {
    Add-Failure "UI state verifier missing"
}

$deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $DurationSec))
$firstMainPids = $null
$firstTranslatorPids = $null
$firstManagerWatcherPids = $null
$firstLegacyManagerWatcherPids = $null
$sampleIndex = 0

while ([DateTime]::UtcNow -lt $deadline -or $sampleIndex -eq 0) {
    $sampleIndex += 1
    $timestamp = [DateTime]::UtcNow.ToString("o")
    $health = $null
    $ui = $null
    $processes = Get-AntiCodexProcesses $installRoot $runtimeRootFull

    try {
        $healthTimeoutSec = [Math]::Max(1, [Math]::Min($TimeoutSec, [int][Math]::Ceiling((Get-RemainingIdleBudgetMs $deadline) / 1000)))
        $health = Invoke-LocalJson "/health" -RequestTimeoutSec $healthTimeoutSec
        if ($health.ok -ne $true) { Add-Failure "sample ${sampleIndex}: health ok=false" }
        if ($health.upstream -ne "antigravity-desktop") { Add-Failure "sample ${sampleIndex}: upstream is $($health.upstream)" }
        if ($health.accountReady -ne $true -and [int]$health.modelCount -lt 1) { Add-Failure "sample ${sampleIndex}: model catalog is not ready" }
    } catch {
        Add-Failure "sample ${sampleIndex}: health failed: $($_.Exception.Message)"
    }

    if (Test-Path -LiteralPath $uiStateScript -PathType Leaf) {
        $remainingMs = Get-RemainingIdleBudgetMs $deadline
        if ($remainingMs -lt 1000 -and $sampleIndex -gt 1) {
            Add-Failure "sample ${sampleIndex}: UI state skipped because idle verifier budget was exhausted"
        } else {
            $uiTimeoutSec = [Math]::Max(1, [Math]::Min($TimeoutSec, [int][Math]::Ceiling([Math]::Max(1000, $remainingMs) / 1000)))
            $ui = Invoke-UiState $uiStateScript $runtimeRootFull -RequestTimeoutSec $uiTimeoutSec
        }
        if ($ui.ok -ne $true) {
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
    if (@($processes.translatorPids).Count -lt 1) {
        Add-Failure "sample ${sampleIndex}: translator process missing"
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
        $firstTranslatorPids = @($processes.translatorPids)
        $firstManagerWatcherPids = @($processes.managerWatcherPids)
        $firstLegacyManagerWatcherPids = @($processes.legacyManagerWatcherPids)
    } else {
        if ((@($processes.mainPids) -join ",") -ne ($firstMainPids -join ",")) {
            Add-Failure "sample ${sampleIndex}: Anti-Codex main process changed during idle"
        }
        if ((@($processes.translatorPids) -join ",") -ne ($firstTranslatorPids -join ",")) {
            Add-Failure "sample ${sampleIndex}: translator process changed during idle"
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
        accountReady = if ($health) { $health.accountReady } else { $false }
        modelCount = if ($health) { $health.modelCount } else { 0 }
        mainPids = @($processes.mainPids)
        translatorPids = @($processes.translatorPids)
        managerWatcherPids = @($processes.managerWatcherPids)
        legacyManagerWatcherPids = @($processes.legacyManagerWatcherPids)
        uiOk = if ($ui) { $ui.ok } else { $false }
        hasReconnectText = if ($ui -and $ui.page) { $ui.page.hasReconnectText } else { $null }
        hasLoginText = if ($ui -and $ui.page) { $ui.page.hasLoginText } else { $null }
        matchedModelText = if ($ui) { $ui.matchedModelText } else { "" }
    }) | Out-Null

    if ([DateTime]::UtcNow -lt $deadline) {
        $sleepMs = [Math]::Min(([Math]::Max(1, $IntervalSec) * 1000), (Get-RemainingIdleBudgetMs $deadline))
        if ($sleepMs -gt 0) {
            Start-Sleep -Milliseconds $sleepMs
        }
    }
}

$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    baseUrl = $BaseUrl
    runtimeRoot = $runtimeRootFull
    installRoot = $installRoot
    durationSec = $DurationSec
    intervalSec = $IntervalSec
    sampleCount = $samples.Count
    samples = $samples.ToArray()
}

$reportPaths = New-ReportPaths "ui-idle-stability"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
Save-JsonReport $reportPaths $result
$result | ConvertTo-Json -Depth 12 -Compress
if ($failures.Count -gt 0) { exit 1 }


