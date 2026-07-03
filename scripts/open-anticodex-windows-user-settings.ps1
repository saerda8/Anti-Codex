#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$OpenSettings,
    [string]$OpenSettingsApproval = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [switch]$Compact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$startedAt = [DateTime]::UtcNow
$scriptRoot = Split-Path -Parent $PSCommandPath
$reportIo = Join-Path $scriptRoot "anticodex-report-io.ps1"
if (-not (Test-Path -LiteralPath $reportIo -PathType Leaf)) {
    throw "missing report writer: $reportIo"
}
. $reportIo

$approvalToken = "open-windows-user-settings-for-anticodex-second-account"
$settingsUri = "ms-settings:otherusers"
$requestedOpenSettings = [bool]$OpenSettings
$approvalOk = ($OpenSettingsApproval -eq $approvalToken)
$openedSettings = $false
$errorCode = ""
$failures = New-Object System.Collections.Generic.List[string]

if ($requestedOpenSettings -and -not $approvalOk) {
    $errorCode = "explicit_open_settings_approval_missing"
    $failures.Add($errorCode) | Out-Null
}

if ($requestedOpenSettings -and $approvalOk) {
    try {
        Start-Process -FilePath $settingsUri | Out-Null
        $openedSettings = $true
    } catch {
        $errorCode = "open_windows_user_settings_failed"
        $failures.Add($errorCode) | Out-Null
    }
}

$elapsedMs = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
$report = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "windows-user-settings-entrypoint"
    noTraffic = $true
    requestedRealTraffic = $false
    usedRealTraffic = $false
    behaviorCovered = $true
    coverageKind = "windows-user-settings-entrypoint-no-traffic"
    requestedOpenSettings = $requestedOpenSettings
    openedSettings = $openedSettings
    changedSystem = $false
    createdUser = $false
    startedLogin = $false
    capturesPassword = $false
    storesPassword = $false
    runsSystemUserCommand = $false
    requiredOpenSettingsApproval = $approvalToken
    openSettingsApprovalProvided = $approvalOk
    settingsUri = $settingsUri
    targetLocalWindowsUser = "AntiCodexModel"
    nextNoTrafficStatusCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test-anticodex-second-account-readiness-summary.ps1 -WindowsUser .\AntiCodexModel -Compact"
    accountIsolationCaveat = "This optional entrypoint only opens Windows Settings > Accounts > Other users after explicit approval. It does not create users, start Antigravity login, capture passwords, or use model traffic."
    error = $errorCode
    failures = @($failures)
    elapsedMs = $elapsedMs
}

$reportRootFull = [IO.Path]::GetFullPath($ReportRoot)
New-Item -ItemType Directory -Path $reportRootFull -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$latestPath = Join-Path $reportRootFull "latest-windows-user-settings-entrypoint.json"
$historyPath = Join-Path $reportRootFull "$stamp-windows-user-settings-entrypoint.json"
$json = $report | ConvertTo-Json -Depth 10
Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json
$report["report"] = [ordered]@{
    latest = $latestPath
    history = $historyPath
}

if ($Compact) {
    [ordered]@{
        ok = $report["ok"]
        reportName = $report["reportName"]
        noTraffic = $report["noTraffic"]
        usedRealTraffic = $report["usedRealTraffic"]
        requestedOpenSettings = $report["requestedOpenSettings"]
        openedSettings = $report["openedSettings"]
        changedSystem = $report["changedSystem"]
        createdUser = $report["createdUser"]
        startedLogin = $report["startedLogin"]
        capturesPassword = $report["capturesPassword"]
        storesPassword = $report["storesPassword"]
        requiredOpenSettingsApproval = $report["requiredOpenSettingsApproval"]
        error = $report["error"]
        failures = $report["failures"]
        report = $report["report"]
    } | ConvertTo-Json -Depth 8 -Compress
} else {
    $report | ConvertTo-Json -Depth 10 -Compress
}

if ($failures.Count -gt 0) { exit 2 }
