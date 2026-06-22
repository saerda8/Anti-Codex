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
$sensitivePattern = "prompt|messages|input_items|tool output|Return exactly this"

function Remove-OldDiagnosticBundles {
    param([string]$Root, [int]$Keep = 10)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    $keepCount = [Math]::Max(1, $Keep)
    $entries = @()
    $entries += Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "^\d{8}-\d{6}$" } |
        ForEach-Object {
            [pscustomobject]@{
                stamp = $_.Name
                path = $_.FullName
                kind = "directory"
                time = $_.LastWriteTimeUtc
            }
        }
    $entries += Get-ChildItem -LiteralPath $Root -Filter "*.zip" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -match "^\d{8}-\d{6}$" } |
        ForEach-Object {
            [pscustomobject]@{
                stamp = $_.BaseName
                path = $_.FullName
                kind = "zip"
                time = $_.LastWriteTimeUtc
            }
        }
    $keepStamps = @($entries |
        Group-Object stamp |
        Sort-Object { ($_.Group | Sort-Object time -Descending | Select-Object -First 1).time } -Descending |
        Select-Object -First $keepCount |
        ForEach-Object { $_.Name })
    $keepSet = @{}
    foreach ($item in $keepStamps) { $keepSet[$item] = $true }
    foreach ($entry in $entries) {
        if (-not $keepSet.ContainsKey($entry.stamp)) {
            Remove-Item -LiteralPath $entry.path -Recurse:($entry.kind -eq "directory") -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-JsonFile {
    param([string]$Path, $Value, [int]$Depth = 12)
    $json = $Value | ConvertTo-Json -Depth $Depth
    if ($json -match $sensitivePattern) {
        $json = (@{
            redacted = $true
            reason = "Sensitive transcript-like fields were not included in the diagnostic bundle."
        } | ConvertTo-Json)
    }
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-ReportIntegrity {
    param([string]$Path)
    $sidecar = "$Path.sha256"
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
        return [pscustomobject]@{
            signed = $false
            valid = $null
            hash = ""
            expected = ""
            sidecar = $sidecar
            error = "missing_hash_sidecar"
        }
    }
    try {
        $rawExpected = (Get-Content -LiteralPath $sidecar -Raw -Encoding ASCII).Trim()
        if ($rawExpected -notmatch "^(?:sha256:)?([a-fA-F0-9]{64})$") {
            return [pscustomobject]@{
                signed = $true
                valid = $false
                hash = ""
                expected = $rawExpected
                sidecar = $sidecar
                error = "invalid_hash_sidecar"
            }
        }
        $expected = $Matches[1].ToLowerInvariant()
        $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        return [pscustomobject]@{
            signed = $true
            valid = ($hash -eq $expected)
            hash = $hash
            expected = $expected
            sidecar = $sidecar
            error = if ($hash -eq $expected) { "" } else { "hash_mismatch" }
        }
    } catch {
        return [pscustomobject]@{
            signed = $true
            valid = $false
            hash = ""
            expected = ""
            sidecar = $sidecar
            error = $_.Exception.Message
        }
    }
}

function Try-InvokeJson {
    param([string]$Path)
    try {
        return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec 8
    } catch {
        return [pscustomobject]@{
            ok = $false
            error = $_.Exception.Message
        }
    }
}

function Read-JsonSummary {
    param([string]$Path)
    $integrity = Get-ReportIntegrity $Path
    try {
        $raw = Get-Content -LiteralPath $Path -Raw
        $json = $raw | ConvertFrom-Json
        $checks = $null
        if (($json.PSObject.Properties.Name -contains "checks") -and $json.checks) {
            $checks = $json.checks
        }
        $javascriptSyntaxOk = $null
        $powershellSyntaxOk = $null
        $uiStateSelfTestOk = $null
        $translatorRegressionOk = $null
        $diffWhitespaceOk = $null
        if ($checks) {
            if (($checks.PSObject.Properties.Name -contains "javascriptSyntax") -and $checks.javascriptSyntax -and ($checks.javascriptSyntax.PSObject.Properties.Name -contains "ok")) { $javascriptSyntaxOk = [bool]$checks.javascriptSyntax.ok }
            if (($checks.PSObject.Properties.Name -contains "powershellSyntax") -and $checks.powershellSyntax -and ($checks.powershellSyntax.PSObject.Properties.Name -contains "ok")) { $powershellSyntaxOk = [bool]$checks.powershellSyntax.ok }
            if (($checks.PSObject.Properties.Name -contains "uiStateSelfTest") -and $checks.uiStateSelfTest -and ($checks.uiStateSelfTest.PSObject.Properties.Name -contains "ok")) { $uiStateSelfTestOk = [bool]$checks.uiStateSelfTest.ok }
            if (($checks.PSObject.Properties.Name -contains "translatorRegression") -and $checks.translatorRegression -and ($checks.translatorRegression.PSObject.Properties.Name -contains "ok")) { $translatorRegressionOk = [bool]$checks.translatorRegression.ok }
            if (($checks.PSObject.Properties.Name -contains "diffWhitespace") -and $checks.diffWhitespace -and ($checks.diffWhitespace.PSObject.Properties.Name -contains "ok")) { $diffWhitespaceOk = [bool]$checks.diffWhitespace.ok }
        }
        return [pscustomobject]@{
            file = Split-Path -Leaf $Path
            ok = if ($json.PSObject.Properties.Name -contains "ok") { $json.ok } else { $null }
            reportName = if ($json.PSObject.Properties.Name -contains "reportName") { [string]$json.reportName } else { $null }
            skipFullRegression = if ($json.PSObject.Properties.Name -contains "skipFullRegression") { [bool]$json.skipFullRegression } else { $null }
            failureCount = if ($json.PSObject.Properties.Name -contains "failures") { @($json.failures).Count } else { 0 }
            elapsedMs = if ($json.PSObject.Properties.Name -contains "elapsedMs") { $json.elapsedMs } else { $null }
            javascriptSyntaxOk = $javascriptSyntaxOk
            powershellSyntaxOk = $powershellSyntaxOk
            uiStateSelfTestOk = $uiStateSelfTestOk
            translatorRegressionOk = $translatorRegressionOk
            diffWhitespaceOk = $diffWhitespaceOk
            baseUrl = if ($json.PSObject.Properties.Name -contains "baseUrl") { $json.baseUrl } else { $null }
            modelCount = if ($json.PSObject.Properties.Name -contains "modelCount") { $json.modelCount } else { $null }
            models = if ($json.PSObject.Properties.Name -contains "models") { @($json.models | ForEach-Object { [string]$_ }) } else { @() }
            skipRequests = if ($json.PSObject.Properties.Name -contains "skipRequests") { [bool]$json.skipRequests } else { $null }
            state = if ($json.PSObject.Properties.Name -contains "state") { [string]$json.state } else { $null }
            usedRealTraffic = if ($json.PSObject.Properties.Name -contains "usedRealTraffic") { [bool]$json.usedRealTraffic } else { $null }
            latestDiagnosis = if (($json.PSObject.Properties.Name -contains "wait") -and $json.wait -and ($json.wait.PSObject.Properties.Name -contains "latestDiagnosis")) { [string]$json.wait.latestDiagnosis } else { $null }
            latestDiagnosisDetail = if (($json.PSObject.Properties.Name -contains "wait") -and $json.wait -and ($json.wait.PSObject.Properties.Name -contains "latest") -and $json.wait.latest -and ($json.wait.latest.PSObject.Properties.Name -contains "diagnosisDetail")) { [string]$json.wait.latest.diagnosisDetail } else { $null }
            attempts = if (($json.PSObject.Properties.Name -contains "wait") -and $json.wait -and ($json.wait.PSObject.Properties.Name -contains "attempts")) { [int]$json.wait.attempts } else { $null }
            repairedCount = if ($json.PSObject.Properties.Name -contains "repairedCount") { [int]$json.repairedCount } else { $null }
            repairedAt = if ($json.PSObject.Properties.Name -contains "repairedAt") { [string]$json.repairedAt } else { $null }
            integrity = $integrity
            error = if ($integrity.signed -and $integrity.valid -eq $false) { "report hash validation failed: $($integrity.error)" } else { "" }
        }
    } catch {
        return [pscustomobject]@{
            file = Split-Path -Leaf $Path
            ok = $false
            error = $_.Exception.Message
            integrity = $integrity
        }
    }
}

function Copy-LogTail {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return }
    $tail = Get-Content -LiteralPath $Source -Tail $LogTailLines -ErrorAction SilentlyContinue
    $text = ($tail -join "`r`n")
    if ($text -match $sensitivePattern) {
        $text = "[redacted: transcript-like content detected]"
    }
    Set-Content -LiteralPath $Destination -Value $text -Encoding UTF8
}

function Update-NoTrafficModelRoutingReport {
    $scriptPath = Join-Path $scriptRoot "test-anticodex-model-routing.ps1"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return [pscustomobject]@{
            ok = $false
            error = "Missing test-anticodex-model-routing.ps1"
        }
    }
    try {
        $result = & $scriptPath -BaseUrl $BaseUrl -SkipRefresh -SkipRequests | ConvertFrom-Json
        return [pscustomobject]@{
            ok = [bool]$result.ok
            failures = if ($result.PSObject.Properties.Name -contains "failures") { @($result.failures) } else { @() }
            modelCount = if ($result.PSObject.Properties.Name -contains "modelCount") { $result.modelCount } else { $null }
            models = if ($result.PSObject.Properties.Name -contains "models") { @($result.models | ForEach-Object { [string]$_ }) } else { @() }
            skipRequests = if ($result.PSObject.Properties.Name -contains "skipRequests") { [bool]$result.skipRequests } else { $null }
            report = if ($result.PSObject.Properties.Name -contains "report") { $result.report } else { $null }
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            error = $_.Exception.Message
        }
    }
}

New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleRoot "logs") -Force | Out-Null

Write-JsonFile (Join-Path $bundleRoot "health.json") (Try-InvokeJson "/health")
Write-JsonFile (Join-Path $bundleRoot "diagnostics.json") (Try-InvokeJson "/anticodex/diagnostics")
Write-JsonFile (Join-Path $bundleRoot "account.json") (Try-InvokeJson "/anticodex/account")
Write-JsonFile (Join-Path $bundleRoot "models.json") (Try-InvokeJson "/models")
Write-JsonFile (Join-Path $bundleRoot "model-routing-refresh.json") (Update-NoTrafficModelRoutingReport)

$updateStatus = try {
    & (Join-Path $scriptRoot "check-anticodex-update.ps1") -InstallRoot $installRoot -NoPersist | ConvertFrom-Json
} catch {
    [pscustomobject]@{ ok = $false; error = $_.Exception.Message }
}
Write-JsonFile (Join-Path $bundleRoot "update-status.json") $updateStatus

$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @("Anti-Codex.exe", "codex.exe", "deepcodex-translator.exe", "Antigravity.exe", "Antigravity IDE.exe")
} | ForEach-Object {
    [pscustomobject]@{
        name = [string]$_.Name
        processId = [int]$_.ProcessId
        executablePath = [string]$_.ExecutablePath
    }
})
Write-JsonFile (Join-Path $bundleRoot "processes.json") $processes

$latestReports = @(
    "latest-installed-overall.json",
    "latest-installed-overall-fast.json",
    "latest-sync-readiness.json",
    "latest-diagnostics.json",
    "latest-tool-bridge-mode.json",
    "latest-account-proxy-readiness.json",
    "latest-post-verification.json",
    "latest-source-preflight.json",
    "latest-mcp-skills.json",
    "latest-plugin-capabilities.json",
    "latest-manager-real-buttons.json",
    "latest-refresh-features.json",
    "latest-stability-soak.json",
    "latest-shortcut-repair.json",
    "latest-model-routing.json",
    "latest-ui-idle-stability.json"
)
$reportSummaries = foreach ($name in $latestReports) {
    $path = Join-Path $reportsRoot $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { Read-JsonSummary $path }
}
$damagedReports = @($reportSummaries | Where-Object {
    ($_.PSObject.Properties.Name -contains "error") -and -not [string]::IsNullOrWhiteSpace([string]$_.error)
} | ForEach-Object {
    [pscustomobject]@{
        file = [string]$_.file
        error = [string]$_.error
    }
})
Write-JsonFile (Join-Path $bundleRoot "reports-summary.json") @($reportSummaries)

$logs = @(
    "adaptive-translator.err.log",
    "adaptive-translator.log",
    "adaptive-translator-start.log",
    "anticodex-launcher.err.log",
    "anticodex-launcher.out.log",
    "deepcodex-lifecycle.log",
    "translator-lifecycle.json",
    "translator-lifecycle.jsonl",
    "model-refresh.log"
)
foreach ($name in $logs) {
    Copy-LogTail -Source (Join-Path $stateRoot $name) -Destination (Join-Path (Join-Path $bundleRoot "logs") $name)
}

$excluded = @("logs_2.sqlite", "logs_2.sqlite-shm", "logs_2.sqlite-wal")
Write-JsonFile (Join-Path $bundleRoot "privacy-policy.json") ([pscustomobject]@{
    collectedAt = [DateTime]::UtcNow.ToString("o")
    baseUrl = $BaseUrl
    excluded = $excluded
    notes = @(
        "Conversation databases, auth files, environment files, and transcript-like fields are not included.",
        "Report files are summarized instead of copied raw."
    )
})

$zipPath = "$bundleRoot.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -LiteralPath $bundleRoot -DestinationPath $zipPath -Force
if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
    throw "Diagnostic bundle zip was not created: $zipPath"
}
Remove-OldDiagnosticBundles -Root $OutputRoot -Keep $KeepBundles

$result = [pscustomobject]@{
    ok = ($damagedReports.Count -eq 0)
    bundleRoot = $bundleRoot
    zipPath = $zipPath
    retainedBundles = [Math]::Max(1, $KeepBundles)
    damagedReports = $damagedReports
}
if (-not $NoPopup) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup("Anti-Codex diagnostic bundle created:`n$zipPath", 12, "Anti-Codex Diagnostics", 64) | Out-Null
    } catch {}
}
$result | ConvertTo-Json -Compress
