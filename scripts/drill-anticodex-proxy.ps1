#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [string]$BaseUrl = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$RecoveryTimeoutSec = 120,
    [int]$PollIntervalSec = 5,
    [switch]$NoPrompt,
    [switch]$SkipOutage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$failures = New-Object System.Collections.Generic.List[string]
$phases = New-Object System.Collections.Generic.List[object]
$startedAt = [DateTime]::UtcNow

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Resolve-FullPath {
    param([string]$Path)
    try { return [IO.Path]::GetFullPath($Path) } catch { return [string]$Path }
}

function Invoke-JsonScript {
    param(
        [string]$Name,
        [switch]$AllowUnready
    )

    $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $accountProxyScript, "-BaseUrl", $BaseUrl)
    if ($AllowUnready) { $args += "-AllowUnready" }

    $powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $output = @(& $powerShellBin @args 2>&1)
    $exitCode = $LASTEXITCODE
    $lines = @($output | ForEach-Object { [string]$_ })
    $jsonLine = @($lines | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)

    if (-not $jsonLine) {
        return [pscustomobject]@{
            name = $Name
            ok = $false
            exitCode = $exitCode
            diagnosis = "no_json"
            failures = @("account/proxy verifier did not emit JSON")
            tail = @($lines | Select-Object -Last 20)
        }
    }

    try {
        $parsed = $jsonLine | ConvertFrom-Json
        $parsed | Add-Member -NotePropertyName name -NotePropertyValue $Name -Force
        $parsed | Add-Member -NotePropertyName exitCode -NotePropertyValue $exitCode -Force
        return $parsed
    } catch {
        return [pscustomobject]@{
            name = $Name
            ok = $false
            exitCode = $exitCode
            diagnosis = "invalid_json"
            failures = @("account/proxy verifier emitted invalid JSON: $($_.Exception.Message)")
            tail = @($lines | Select-Object -Last 20)
        }
    }
}

function Add-Phase {
    param($Phase)
    $phases.Add($Phase) | Out-Null
}

function Wait-Recovery {
    $deadline = [DateTime]::UtcNow.AddSeconds($RecoveryTimeoutSec)
    $attempt = 0
    $last = $null
    do {
        $attempt += 1
        $last = Invoke-JsonScript "recovery-$attempt"
        Add-Phase $last
        if ($last.ok -eq $true -and $last.diagnosis -eq "ready") { return $last }
        Start-Sleep -Seconds ([Math]::Max(1, $PollIntervalSec))
    } while ([DateTime]::UtcNow -lt $deadline)
    return $last
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

$runtimeRootFull = Resolve-FullPath $RuntimeRoot
$accountProxyScript = Join-Path $runtimeRootFull "scripts\test-anticodex-account-proxy-readiness.ps1"
if (-not (Test-Path -LiteralPath $accountProxyScript -PathType Leaf)) {
    throw "Anti-Codex account/proxy verifier is missing: $accountProxyScript"
}

Write-Host "[Anti-Codex] Baseline account/proxy check..."
$baseline = Invoke-JsonScript "baseline"
Add-Phase $baseline
if ($baseline.ok -ne $true -or $baseline.diagnosis -ne "ready") {
    Add-Failure "baseline is not ready: $($baseline.diagnosis)"
}

if (-not $SkipOutage) {
    if (-not $NoPrompt) {
        Write-Host ""
        Write-Host "Now disable or break the proxy used by Antigravity Desktop."
        Write-Host "Do not close Anti-Codex. This drill checks that Anti-Codex reports account/proxy readiness without restarting itself."
        Read-Host "Press Enter after the proxy is disabled"
    }

    Write-Host "[Anti-Codex] Capturing outage diagnosis..."
    $outage = Invoke-JsonScript "outage" -AllowUnready
    Add-Phase $outage
    if ($outage.diagnosis -eq "ready" -and -not $NoPrompt) {
        Add-Failure "outage phase still reported ready; proxy interruption may not have reached Antigravity"
    }

    if (-not $NoPrompt) {
        Write-Host ""
        Write-Host "Restore the proxy used by Antigravity Desktop."
        Read-Host "Press Enter after the proxy is restored"
    }

    Write-Host "[Anti-Codex] Waiting for recovery..."
    $recovered = Wait-Recovery
    if (-not $recovered -or $recovered.ok -ne $true -or $recovered.diagnosis -ne "ready") {
        Add-Failure "recovery did not return to ready within $RecoveryTimeoutSec seconds"
    }
}

$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    baseUrl = $BaseUrl
    skippedOutage = [bool]$SkipOutage
    noPrompt = [bool]$NoPrompt
    phases = $phases.ToArray()
}

$reportPaths = New-ReportPaths "proxy-drill"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
Save-JsonReport $reportPaths $result

$result | ConvertTo-Json -Depth 12 -Compress
if ($failures.Count -gt 0) { exit 1 }


