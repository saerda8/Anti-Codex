[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [int]$TimeoutSec = 60,
    [switch]$VerifyBundle,
    [string]$VerifyReportsSummary = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]
$allowedReportFiles = @(
    "latest-legacy-zero-hit.json",
    "latest-source-preflight.json",
    "latest-sync-readiness.json",
    "latest-installed-overall.json",
    "latest-installed-overall-fast.json",
    "latest-release-gates.json",
    "latest-manager-real-buttons.json",
    "latest-gate5-visible-integration.json",
    "latest-gate6-edge-matrix.json",
    "latest-gate8-final-long-task.json",
    "latest-conversation-hygiene.json",
    "latest-model-availability.json",
    "latest-shortcut-repair.json",
    "latest-log-db-guard.json"
)
$removedArchitecturePattern = "(?i)second.?account|xiaoqiang|windows.?user.?login|antigravity.?cli|goal.?readiness|adaptive.?translator"
$sensitivePattern = "(?i)(?<![A-Za-z])prompt(?![A-Za-z])|(?<![A-Za-z])messages(?![A-Za-z])|input_items|tool output|return exactly this|authorization"

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing JSON file: $Path" }
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Test-ReportsSummary {
    param([string]$Path)
    $items = @(Read-JsonFile $Path)
    if ($items.Count -eq 1 -and $items[0] -is [array]) { $items = @($items[0]) }
    foreach ($item in $items) {
        $file = [string]$item.file
        if (-not $file) { Add-Failure "diagnostic report summary entry has no file"; continue }
        if ($allowedReportFiles -notcontains $file) { Add-Failure "diagnostic report summary contains an obsolete or unknown report: $file" }
        if (-not (Has-Property $item "ok")) { Add-Failure "diagnostic report summary has no ok field: $file" }
        if (-not (Has-Property $item "integrity")) { Add-Failure "diagnostic report summary has no integrity field: $file" }
        elseif ($item.integrity.valid -eq $false) { Add-Failure "diagnostic report summary has an invalid hash: $file" }
    }
    $serialized = $items | ConvertTo-Json -Depth 12 -Compress
    if ($serialized -match $removedArchitecturePattern) { Add-Failure "diagnostic report summary contains a removed architecture field" }
    if ($serialized -match $sensitivePattern) { Add-Failure "diagnostic report summary contains transcript-like data" }
    return [pscustomobject]@{ checked = $true; count = $items.Count; files = @($items | ForEach-Object { [string]$_.file }) }
}

function Invoke-Diagnostics {
    param([string]$Url)
    try {
        return Invoke-RestMethod -Uri "$Url/anticodex/diagnostics" -Proxy $null -TimeoutSec $TimeoutSec
    } catch {
        Add-Failure "diagnostics endpoint failed: $($_.Exception.Message)"
        return $null
    }
}

function Test-LiveDiagnostics {
    param($Diagnostics)
    if (-not $Diagnostics) { return $null }
    if ([string]$Diagnostics.object -ne "anticodex.diagnostics") { Add-Failure "diagnostics object identity is incorrect" }
    if ($Diagnostics.ok -ne $true) { Add-Failure "diagnostics response is not structurally healthy" }
    foreach ($section in @("process", "mode", "health", "fixedRoute", "paths", "models", "toolBridge", "nativeToolCapability", "longTasks", "sourcePreflight", "tools")) {
        if (-not (Has-Property $Diagnostics $section)) { Add-Failure "diagnostics missing current section: $section" }
    }
    $provider = if (Has-Property $Diagnostics "mode") { [string]$Diagnostics.mode.upstreamMode } else { "" }
    if (@("offline", "antigravity", "third-party") -notcontains $provider) { Add-Failure "diagnostics provider mode is invalid: $provider" }
    if ((Has-Property $Diagnostics "toolBridge") -and [string]$Diagnostics.toolBridge.owner -ne "codex") {
        Add-Failure "diagnostics does not assign tool ownership to Codex"
    }
    if ((Has-Property $Diagnostics "nativeToolCapability") -and $Diagnostics.nativeToolCapability.adapterExecutesTools -ne $false) {
        Add-Failure "diagnostics claims the provider adapter executes tools"
    }
    if ((Has-Property $Diagnostics "tools") -and $Diagnostics.tools.adapterExecutesTools -ne $false) {
        Add-Failure "diagnostics tool summary claims the provider adapter executes tools"
    }
    $serialized = $Diagnostics | ConvertTo-Json -Depth 20 -Compress
    if ($serialized -match $removedArchitecturePattern) { Add-Failure "live diagnostics contains a removed architecture field" }
    if ($serialized -match $sensitivePattern) { Add-Failure "live diagnostics exposes transcript-like data" }
    return [pscustomobject]@{
        provider = $provider
        model = if (Has-Property $Diagnostics "health") { [string]$Diagnostics.health.model } else { "" }
        routeReady = if (Has-Property $Diagnostics "health") { $Diagnostics.health.ok -eq $true } else { $false }
        toolOwner = if (Has-Property $Diagnostics "toolBridge") { [string]$Diagnostics.toolBridge.owner } else { "" }
    }
}

function Test-DiagnosticBundle {
    param([string]$Url)
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-diagnostics-test-" + [guid]::NewGuid().ToString("N"))
    $expanded = Join-Path $tempRoot "expanded"
    try {
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        $collector = Join-Path $PSScriptRoot "collect-anticodex-diagnostics.ps1"
        $expectedInstallRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
        $callerInstallRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
        if ($callerInstallRoot -ne $expectedInstallRoot) {
            $installedCollector = Join-Path $expectedInstallRoot "runtime\scripts\collect-anticodex-diagnostics.ps1"
            if (Test-Path -LiteralPath $installedCollector -PathType Leaf) {
                $collector = $installedCollector
            }
        }
        $raw = & $collector -BaseUrl $Url -OutputRoot (Join-Path $tempRoot "bundles") -KeepBundles 1 -NoPopup 2>&1
        if ($LASTEXITCODE -ne 0) { throw (($raw | Out-String).Trim()) }
        $bundle = (($raw | Out-String).Trim() | ConvertFrom-Json)
        if ($bundle.ok -ne $true) { Add-Failure "diagnostic bundle reports damaged evidence" }
        if ($bundle.noTraffic -ne $true -or $bundle.usedRealTraffic -ne $false) { Add-Failure "diagnostic bundle is not explicitly no-traffic" }
        if (-not (Test-Path -LiteralPath ([string]$bundle.zipPath) -PathType Leaf)) { throw "diagnostic ZIP is missing" }
        Expand-Archive -LiteralPath ([string]$bundle.zipPath) -DestinationPath $expanded -Force
        $bundleDirectory = @(Get-ChildItem -LiteralPath $expanded -Directory | Select-Object -First 1)
        $contentRoot = if ($bundleDirectory.Count -gt 0) { $bundleDirectory[0].FullName } else { $expanded }
        foreach ($name in @("health.json", "diagnostics.json", "diagnostics-summary.json", "models.json", "update-status.json", "processes.json", "reports-summary.json", "privacy-policy.json")) {
            if (-not (Test-Path -LiteralPath (Join-Path $contentRoot $name) -PathType Leaf)) { Add-Failure "diagnostic bundle is missing $name" }
        }
        $summaryPath = Join-Path $contentRoot "reports-summary.json"
        $summaryCheck = if (Test-Path -LiteralPath $summaryPath -PathType Leaf) { Test-ReportsSummary $summaryPath } else { $null }
        $allJson = @(Get-ChildItem -LiteralPath $contentRoot -Filter "*.json" -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
        if ($allJson -match $removedArchitecturePattern) { Add-Failure "diagnostic bundle contains a removed architecture field" }
        return [pscustomobject]@{ checked = $true; zipCreated = $true; reportCount = $bundle.reportCount; reportsSummary = $summaryCheck }
    } catch {
        Add-Failure "diagnostic bundle verification failed: $($_.Exception.Message)"
        return [pscustomobject]@{ checked = $true; zipCreated = $false }
    } finally {
        if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

$reportsSummaryCheck = $null
$diagnosticsEvidence = $null
$bundleCheck = $null

if ($VerifyReportsSummary) {
    try { $reportsSummaryCheck = Test-ReportsSummary $VerifyReportsSummary }
    catch { Add-Failure "reports summary verification failed: $($_.Exception.Message)" }
} else {
    if (-not $BaseUrl) { $BaseUrl = [string](& (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")) }
    $diagnosticsEvidence = Test-LiveDiagnostics (Invoke-Diagnostics $BaseUrl)
    if ($VerifyBundle) { $bundleCheck = Test-DiagnosticBundle $BaseUrl }
}

$result = [pscustomobject]@{
    schema = "anticodex-diagnostics-verifier-v2"
    reportName = "diagnostics"
    noTraffic = $true
    requestedRealTraffic = $false
    usedRealTraffic = $false
    behaviorCovered = $true
    coverageKind = "three-layer-diagnostics-no-traffic"
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    diagnostics = $diagnosticsEvidence
    reportsSummary = $reportsSummaryCheck
    bundle = $bundleCheck
}

if (-not $VerifyReportsSummary) {
    $reportStamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $result | Add-Member -NotePropertyName report -NotePropertyValue ([pscustomobject]@{
        latest = Join-Path $ReportRoot "latest-diagnostics.json"
        history = Join-Path $ReportRoot "$reportStamp-diagnostics.json"
    })
}

$json = $result | ConvertTo-Json -Depth 12 -Compress
if (-not $VerifyReportsSummary) {
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $result.report.latest -HistoryPath $result.report.history -Json $json -Encoding ([System.Text.UTF8Encoding]::new($false))
}
$json
if ($failures.Count -gt 0) { exit 1 }
