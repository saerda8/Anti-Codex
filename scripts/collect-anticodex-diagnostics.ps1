#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$OutputRoot = $(Join-Path $env:APPDATA "anticodex\diagnostic-bundles"),
    [int]$LogTailLines = 200,
    [int]$KeepBundles = 10,
    [switch]$NoPopup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $scriptRoot)))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRoot -ne $expectedRoot) { throw "Anti-Codex diagnostics may only run from $expectedRoot" }
if (-not $BaseUrl) { $BaseUrl = [string](& (Join-Path $scriptRoot "resolve-anticodex-base-url.ps1")) }

$stateRoot = Join-Path $env:APPDATA "anticodex"
$reportsRoot = Join-Path $stateRoot "reports"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$bundleRoot = Join-Path $OutputRoot $stamp
$sensitivePattern = "(?i)(?<![A-Za-z])prompt(?![A-Za-z])|(?<![A-Za-z])messages(?![A-Za-z])|input_items|tool output|return exactly this|api[_-]?key|authorization"
$forbiddenArchitecturePattern = "(?i)second.?account|xiaoqiang|windows.?user.?login|antigravity.?cli|goal.?readiness|adaptive.?translator"

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Write-JsonFile {
    param([string]$Path, $Value, [int]$Depth = 12, [switch]$AllowSafeLabels)
    $json = $Value | ConvertTo-Json -Depth $Depth
    if ((-not $AllowSafeLabels) -and $json -match $sensitivePattern) {
        $json = [pscustomobject]@{
            redacted = $true
            reason = "Sensitive transcript or credential fields were excluded."
        } | ConvertTo-Json
    }
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Try-InvokeJson {
    param([string]$Path)
    try {
        Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec 8
    } catch {
        [pscustomobject]@{ ok = $false; error = $_.Exception.Message }
    }
}

function Get-ReportIntegrity {
    param([string]$Path)
    $sidecar = "$Path.sha256"
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
        return [pscustomobject]@{ signed = $false; valid = $null; error = "" }
    }
    try {
        $expectedText = (Get-Content -LiteralPath $sidecar -Raw -Encoding ASCII).Trim()
        if ($expectedText -notmatch "^(?:sha256:)?([a-fA-F0-9]{64})$") {
            return [pscustomobject]@{ signed = $true; valid = $false; error = "invalid_hash_sidecar" }
        }
        $expected = $Matches[1].ToLowerInvariant()
        $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        return [pscustomobject]@{
            signed = $true
            valid = ($actual -eq $expected)
            hash = $actual
            expected = $expected
            error = if ($actual -eq $expected) { "" } else { "hash_mismatch" }
        }
    } catch {
        return [pscustomobject]@{ signed = $true; valid = $false; error = $_.Exception.Message }
    }
}

function Resolve-Node {
    $bundled = Join-Path $installRoot "codex-patched-app\resources\cua_node\bin\node.exe"
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "node.exe is required to summarize diagnostics"
}

function Read-ReportSummary {
    param([string]$Path)
    $integrity = Get-ReportIntegrity $Path
    try {
        $node = Resolve-Node
        $summaryScript = Join-Path $scriptRoot "summarize-anticodex-report.mjs"
        $output = & $node $summaryScript $Path 2>&1
        if ($LASTEXITCODE -ne 0) { throw (($output | Out-String).Trim()) }
        $summary = (($output | Out-String).Trim() | ConvertFrom-Json)
        $summary | Add-Member -NotePropertyName integrity -NotePropertyValue $integrity -Force
        $summary | Add-Member -NotePropertyName error -NotePropertyValue $(if ($integrity.valid -eq $false) { $integrity.error } else { "" }) -Force
        return $summary
    } catch {
        return [pscustomobject]@{
            file = Split-Path -Leaf $Path
            ok = $false
            effectiveOk = $false
            integrity = $integrity
            error = $_.Exception.Message
        }
    }
}

function Get-DiagnosticsSummary {
    param($Diagnostics)
    $longTasks = if (Has-Property $Diagnostics "longTasks") { $Diagnostics.longTasks } else { $null }
    $items = @()
    if (Has-Property $longTasks "items") { $items = @($longTasks.items) }
    $mode = if (Has-Property $Diagnostics "mode") { $Diagnostics.mode } else { $null }
    $health = if (Has-Property $Diagnostics "health") { $Diagnostics.health } else { $null }
    return [pscustomobject]@{
        ok = if (Has-Property $Diagnostics "ok") { [bool]$Diagnostics.ok } else { $false }
        provider = if (Has-Property $mode "upstreamMode") { [string]$mode.upstreamMode } else { "offline" }
        model = if (Has-Property $health "model") { [string]$health.model } else { "" }
        routeReady = if (Has-Property $health "ok") { $health.ok -eq $true } else { $false }
        longTasks = [pscustomobject]@{
            runningCount = @($items).Count
            attentionCount = 0
            itemCount = @($items).Count
            otherRunningItems = @($items | Select-Object -First 5 | ForEach-Object {
                [pscustomobject]@{ id = [string]$_.id; state = [string]$_.state; stage = [string]$_.stage }
            })
        }
    }
}

function Copy-LogTail {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return }
    $text = ((Get-Content -LiteralPath $Source -Tail $LogTailLines -ErrorAction SilentlyContinue) -join "`r`n")
    if ($text -match $sensitivePattern) { $text = "[redacted: transcript or credential content detected]" }
    [System.IO.File]::WriteAllText($Destination, $text, [System.Text.UTF8Encoding]::new($false))
}

function Remove-OldBundles {
    param([string]$Root, [int]$Keep)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    $keepCount = [Math]::Max(1, $Keep)
    $entries = @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "^\d{8}-\d{6}$" } |
        Sort-Object LastWriteTimeUtc -Descending)
    foreach ($entry in @($entries | Select-Object -Skip $keepCount)) {
        Remove-Item -LiteralPath $entry.FullName -Recurse -Force -ErrorAction SilentlyContinue
        $zip = "$($entry.FullName).zip"
        if (Test-Path -LiteralPath $zip -PathType Leaf) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue }
    }
}

New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleRoot "logs") -Force | Out-Null

$health = Try-InvokeJson "/health"
$diagnostics = Try-InvokeJson "/anticodex/diagnostics"
$models = Try-InvokeJson "/models"
$diagnosticsSummary = Get-DiagnosticsSummary $diagnostics
Write-JsonFile (Join-Path $bundleRoot "health.json") $health
Write-JsonFile (Join-Path $bundleRoot "diagnostics.json") $diagnostics
Write-JsonFile (Join-Path $bundleRoot "diagnostics-summary.json") $diagnosticsSummary
Write-JsonFile (Join-Path $bundleRoot "models.json") $models

$updateStatus = try {
    & (Join-Path $scriptRoot "check-anticodex-update.ps1") -InstallRoot $installRoot -NoPersist | ConvertFrom-Json
} catch {
    [pscustomobject]@{ ok = $false; error = $_.Exception.Message }
}
Write-JsonFile (Join-Path $bundleRoot "update-status.json") $updateStatus

$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @("Anti-Codex.exe", "codex.exe")
} | ForEach-Object {
    [pscustomobject]@{ name = [string]$_.Name; processId = [int]$_.ProcessId; executablePath = [string]$_.ExecutablePath }
})
Write-JsonFile (Join-Path $bundleRoot "processes.json") $processes

$latestReports = @(
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
$reportSummaries = foreach ($name in $latestReports) {
    $path = Join-Path $reportsRoot $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { Read-ReportSummary $path }
}
$damagedReports = @($reportSummaries | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.error) } | ForEach-Object {
    [pscustomobject]@{ file = [string]$_.file; error = [string]$_.error }
})
$serializedSummaries = $reportSummaries | ConvertTo-Json -Depth 12
if ($serializedSummaries -match $forbiddenArchitecturePattern) {
    throw "Current diagnostics summary contains a removed architecture field"
}
Write-JsonFile (Join-Path $bundleRoot "reports-summary.json") @($reportSummaries)

$rootLogs = @("anticodex-fixed-route.out.log", "anticodex-fixed-route.err.log")
foreach ($name in $rootLogs) {
    Copy-LogTail -Source (Join-Path $stateRoot $name) -Destination (Join-Path (Join-Path $bundleRoot "logs") $name)
}
$nestedLogs = @("codexplusplus-launcher.log", "codexplusplus-launcher.err.log", "manager-inject.err.log", "manager-bridge.err.log")
foreach ($name in $nestedLogs) {
    Copy-LogTail -Source (Join-Path (Join-Path $stateRoot "logs") $name) -Destination (Join-Path (Join-Path $bundleRoot "logs") $name)
}

Write-JsonFile (Join-Path $bundleRoot "privacy-policy.json") ([pscustomobject]@{
    schema = "anticodex-diagnostics-privacy-v2"
    collectedAt = [DateTime]::UtcNow.ToString("o")
    excluded = @("conversation databases", "auth files", "environment files", "API keys", "prompts", "messages", "tool outputs")
    architecture = "isolated Codex copy -> CodexPlusPlus -> optional thin Antigravity Chat adapter"
}) -AllowSafeLabels

$zipPath = "$bundleRoot.zip"
if (Test-Path -LiteralPath $zipPath -PathType Leaf) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -LiteralPath $bundleRoot -DestinationPath $zipPath -Force
if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { throw "Diagnostic bundle zip was not created: $zipPath" }
Remove-OldBundles -Root $OutputRoot -Keep $KeepBundles

$result = [pscustomobject]@{
    ok = ($damagedReports.Count -eq 0)
    schema = "anticodex-diagnostics-bundle-v2"
    noTraffic = $true
    usedRealTraffic = $false
    bundleRoot = $bundleRoot
    zipPath = $zipPath
    retainedBundles = [Math]::Max(1, $KeepBundles)
    reportCount = @($reportSummaries).Count
    damagedReports = $damagedReports
    diagnosticsSummary = $diagnosticsSummary
}
if (-not $NoPopup) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup("Anti-Codex diagnostic bundle created:`n$zipPath", 12, "Anti-Codex Diagnostics", 64) | Out-Null
    } catch {}
}
$result | ConvertTo-Json -Depth 8 -Compress
