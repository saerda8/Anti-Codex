param(
    [string]$BaseUrl = "",
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutMinutes = 10,
    [int]$PollSeconds = 15,
    [switch]$OpenAntigravityOnVerification
)

$ErrorActionPreference = "Stop"

$startedAt = [DateTime]::UtcNow
$scriptRoot = Split-Path -Parent $PSCommandPath
$runtimeRootFull = [IO.Path]::GetFullPath($RuntimeRoot)
$scriptsRoot = Join-Path $runtimeRootFull "scripts"
$failures = New-Object System.Collections.Generic.List[string]
$attempts = New-Object System.Collections.Generic.List[object]
$openedAntigravity = $false
$reportPaths = $null
$lockStream = $null
$lockRoot = Join-Path $env:APPDATA "anticodex\locks"
$lockPath = Join-Path $lockRoot "post-verification.lock"

try {
    New-Item -ItemType Directory -Path $lockRoot -Force | Out-Null
    $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $lockStream.SetLength(0)
    $lockBytes = [Text.Encoding]::UTF8.GetBytes("pid=$PID started=$($startedAt.ToString('o'))")
    $lockStream.Write($lockBytes, 0, $lockBytes.Length)
    $lockStream.Flush()
} catch {
    [pscustomobject]@{
        ok = $true
        state = "already_running"
        usedRealTraffic = $true
        failures = @()
        message = "post-verification full check is already running"
    } | ConvertTo-Json -Compress
    exit 0
}

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $scriptRoot "resolve-anticodex-base-url.ps1")
}

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Invoke-AntiCodexHealth {
    return Invoke-RestMethod -Uri "$BaseUrl/health" -Proxy $null -TimeoutSec 8
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

function Test-AntiCodexPostVerificationReady {
    param($Health, [string]$Mode)
    if ($Mode -eq "third-party") {
        return [bool](
            $Health -and
            $Health.ok -eq $true -and
            (Has-Property $Health "upstreamProfile") -and
            $Health.upstreamProfile -and
            $Health.upstreamProfile.protocol -and
            $Health.upstreamProfile.model
        )
    }
    return $false
}

function Invoke-JsonScript {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [switch]$AllowFailureJson
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        Add-Failure "$Name script missing: $ScriptPath"
        return [pscustomobject]@{ ok = $false; failures = @("$Name script missing"); diagnosis = "script_missing" }
    }

    $powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $output = @(& $powerShellBin -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $lines = @($output | ForEach-Object { [string]$_ })
    $jsonLine = @($lines | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)

    if (-not $jsonLine) {
        Add-Failure "$Name did not emit a JSON result"
        return [pscustomobject]@{
            ok = $false
            exitCode = $exitCode
            failures = @("$Name did not emit a JSON result")
            tail = @($lines | Select-Object -Last 20)
        }
    }

    try {
        $parsed = $jsonLine | ConvertFrom-Json
        if ($exitCode -ne 0 -and -not $AllowFailureJson) {
            Add-Failure "$Name failed with exit code $exitCode"
        }
        return $parsed
    } catch {
        Add-Failure "$Name emitted invalid JSON: $($_.Exception.Message)"
        return [pscustomobject]@{
            ok = $false
            exitCode = $exitCode
            failures = @("$Name emitted invalid JSON")
            tail = @($lines | Select-Object -Last 20)
        }
    }
}

function Open-AntigravityDesktopIfNeeded {
    if ($openedAntigravity -or -not $OpenAntigravityOnVerification) { return }
    $helper = Join-Path $scriptsRoot "antigravity-desktop.ps1"
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { return }
    try {
        . $helper
        $path = Resolve-AntigravityDesktopPath
        if ($path) {
            $running = Get-AntigravityMainProcess -ExecutablePath $path
            if (-not $running) { Start-Process -FilePath $path | Out-Null }
            $script:openedAntigravity = $true
        }
    } catch {}
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
    Remove-OldReports -HistoryPath $Paths.history
}

function Remove-OldReports {
    param([string]$HistoryPath, [int]$Keep = 30)
    if (-not $HistoryPath) { return }
    $leaf = Split-Path -Leaf $HistoryPath
    $match = [regex]::Match($leaf, "^\d{8}-\d{6}-(.+)\.json$")
    if (-not $match.Success) { return }
    $name = $match.Groups[1].Value
    $root = Split-Path -Parent $HistoryPath
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
    Get-ChildItem -LiteralPath $root -Filter "*-$name.json" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -Skip $Keep |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

function Save-Progress {
    param(
        [string]$State,
        [bool]$Ready = $false,
        [object]$LatestReadiness = $null,
        [object]$Overall = $null,
        [string[]]$CurrentFailures = @()
    )

    if (-not $script:reportPaths) { return }
    $now = [DateTime]::UtcNow
    $payload = [pscustomobject]@{
        ok = $State -eq "completed"
        reportName = "post-verification"
        state = $State
        failures = @($CurrentFailures)
        elapsedMs = [int]($now - $startedAt).TotalMilliseconds
        baseUrl = $BaseUrl
        runtimeRoot = $runtimeRootFull
        usedRealTraffic = $true
        timeoutMinutes = $TimeoutMinutes
        pollSeconds = $PollSeconds
        openedAntigravity = $openedAntigravity
        wait = [pscustomobject]@{
            ready = $Ready
            attempts = $attempts.Count
            latestDiagnosis = if ($LatestReadiness -and $LatestReadiness.diagnosis) { [string]$LatestReadiness.diagnosis } else { "unknown" }
            latestSuggestedAction = if ($LatestReadiness -and $LatestReadiness.suggestedAction) { [string]$LatestReadiness.suggestedAction } else { "" }
            latest = $LatestReadiness
            recent = @($attempts | Select-Object -Last 8)
        }
        overall = $Overall
        report = $reportPaths
    }
    Save-JsonReport $reportPaths $payload
}

$reportPaths = New-ReportPaths "post-verification"
Save-Progress -State "waiting_for_provider"

$readinessScript = Join-Path $scriptsRoot "test-anticodex-account-proxy-readiness.ps1"
$overallScript = Join-Path $scriptsRoot "test-anticodex-installed-overall.ps1"
$deadline = $startedAt.AddMinutes($TimeoutMinutes)
$latestReadiness = $null
$health = $null
$upstreamMode = "unknown"
try {
    $health = Invoke-AntiCodexHealth
    $upstreamMode = Resolve-AntiCodexMode $health
} catch {
    $latestReadiness = [pscustomobject]@{
        ok = $false
        diagnosis = "health_unreachable"
        suggestedAction = "Check Anti-Codex local gateway before post-verification"
        mode = "unknown"
        error = $_.Exception.Message
    }
}

if ($upstreamMode -eq "third-party") {
    $providerReady = Test-AntiCodexPostVerificationReady $health $upstreamMode
    $latestReadiness = [pscustomobject]@{
        ok = $providerReady
        diagnosis = if ($providerReady) { "provider_ready" } else { "provider_unready" }
        suggestedAction = if ($providerReady) { "" } else { "Check third-party API configuration before post-verification" }
        mode = $upstreamMode
        reason = "third-party mode skips Antigravity account/proxy wait"
        models = [pscustomobject]@{
            selected = if ($health.upstreamProfile -and $health.upstreamProfile.model) { [string]$health.upstreamProfile.model } else { "" }
        }
        upstreamProfile = if ($health) { $health.upstreamProfile } else { $null }
    }
    $attempts.Add([pscustomobject]@{
        at = [DateTime]::UtcNow.ToString("o")
        ok = $latestReadiness.ok
        diagnosis = [string]$latestReadiness.diagnosis
        suggestedAction = [string]$latestReadiness.suggestedAction
        mode = $upstreamMode
        model = if ($latestReadiness.models -and $latestReadiness.models.selected) { [string]$latestReadiness.models.selected } else { "" }
    }) | Out-Null
    Save-Progress -State $(if ($providerReady) { "provider_ready" } else { "waiting_for_provider" }) `
        -Ready $providerReady `
        -LatestReadiness $latestReadiness
} else {
    Save-Progress -State "waiting_for_account" -LatestReadiness $latestReadiness
    do {
        $latestReadiness = Invoke-JsonScript "Account/proxy readiness" $readinessScript @(
            "-BaseUrl", $BaseUrl,
            "-AllowUnready"
        ) -AllowFailureJson
        $attempts.Add([pscustomobject]@{
            at = [DateTime]::UtcNow.ToString("o")
            ok = $latestReadiness.ok
            diagnosis = if ($latestReadiness.diagnosis) { [string]$latestReadiness.diagnosis } else { "unknown" }
            suggestedAction = if ($latestReadiness.suggestedAction) { [string]$latestReadiness.suggestedAction } else { "" }
            mode = $upstreamMode
            model = if ($latestReadiness.models -and $latestReadiness.models.selected) { [string]$latestReadiness.models.selected } else { "" }
        }) | Out-Null
        Save-Progress -State $(if ($latestReadiness.diagnosis -eq "ready") { "account_ready" } else { "waiting_for_account" }) `
            -Ready ($latestReadiness.diagnosis -eq "ready") `
            -LatestReadiness $latestReadiness

        if ($latestReadiness.diagnosis -eq "ready" -and $latestReadiness.ok -eq $true) {
            break
        }
        if ($upstreamMode -eq "antigravity" -and $latestReadiness.diagnosis -eq "account_verification_required") {
            Open-AntigravityDesktopIfNeeded
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            break
        }
        Start-Sleep -Seconds ([Math]::Max(1, $PollSeconds))
    } while ($true)
}

$ready = $latestReadiness -and $latestReadiness.ok -eq $true -and ($latestReadiness.diagnosis -eq "ready" -or $latestReadiness.diagnosis -eq "provider_ready")
$overall = $null
if ($ready) {
    Save-Progress -State "running_full_verification" -Ready $true -LatestReadiness $latestReadiness
    $overall = Invoke-JsonScript "Installed overall real-traffic verification" $overallScript @(
        "-BaseUrl", $BaseUrl,
        "-RuntimeRoot", $runtimeRootFull,
        "-ReportRoot", $ReportRoot,
        "-EnsureRunning",
        "-AllowRealTraffic"
    ) -AllowFailureJson
    if ($overall.ok -ne $true) {
        Add-Failure "installed overall real-traffic verification failed"
    } else {
        $overall | Add-Member -NotePropertyName usedRealTraffic -NotePropertyValue $true -Force
        $overall | Add-Member -NotePropertyName releaseReady -NotePropertyValue $true -Force
    }
} else {
    $diagnosis = if ($latestReadiness -and $latestReadiness.diagnosis) { [string]$latestReadiness.diagnosis } else { "unknown" }
    if ($upstreamMode -eq "third-party") {
        Add-Failure "third-party provider readiness did not become ready before verification: $diagnosis"
    } else {
        Add-Failure "account/proxy readiness did not become ready before timeout: $diagnosis"
    }
}

$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    reportName = "post-verification"
    state = if ($failures.Count -eq 0) { "completed" } elseif ($ready) { "verification_failed" } else { "waiting_timeout" }
    failures = $failures.ToArray()
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    baseUrl = $BaseUrl
    runtimeRoot = $runtimeRootFull
    mode = $upstreamMode
    usedRealTraffic = $true
    timeoutMinutes = $TimeoutMinutes
    pollSeconds = $PollSeconds
    openedAntigravity = $openedAntigravity
    wait = [pscustomobject]@{
        ready = $ready
        attempts = $attempts.Count
        latestDiagnosis = if ($latestReadiness -and $latestReadiness.diagnosis) { [string]$latestReadiness.diagnosis } else { "unknown" }
        latestSuggestedAction = if ($latestReadiness -and $latestReadiness.suggestedAction) { [string]$latestReadiness.suggestedAction } else { "" }
        latest = $latestReadiness
        recent = @($attempts | Select-Object -Last 8)
    }
    overall = $overall
    releaseGateSummary = [pscustomobject]@{
        ready = ($failures.Count -eq 0 -and $ready -and $overall -and $overall.ok -eq $true)
        usedRealTraffic = $true
        overallOk = if ($overall) { $overall.ok } else { $false }
    }
}

$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
Save-JsonReport $reportPaths $result

if ($lockStream) {
    try { $lockStream.Close() } catch {}
}

$result | ConvertTo-Json -Depth 12 -Compress
if ($failures.Count -gt 0) { exit 1 }
