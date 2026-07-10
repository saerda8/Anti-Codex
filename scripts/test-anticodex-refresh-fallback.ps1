#Requires -Version 5.1
param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent $RuntimeRoot))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRoot -ne $expectedRoot) {
    throw "Anti-Codex refresh fallback verification may only test $expectedRoot"
}

$refresh = Join-Path $RuntimeRoot "scripts\refresh-anticodex-models.ps1"
$catalog = Join-Path $env:APPDATA "anticodex\antigravity-model-catalog.json"
foreach ($path in @($refresh, $catalog)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Anti-Codex refresh fallback verification is missing required path: $path"
    }
}

function Get-OriginalCodexMainPids {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        try {
            $path = [IO.Path]::GetFullPath([string]$_.ExecutablePath)
            $leaf = Split-Path -Leaf $path
            return ($leaf -ieq "Codex.exe" -or $leaf -ieq "ChatGPT.exe") -and
                -not $path.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase) -and
                ([string]$_.CommandLine) -notmatch "\s--type="
        } catch {
            return $false
        }
    } | ForEach-Object { [int]$_.ProcessId } | Sort-Object)
}

$originalCodexBefore = @(Get-OriginalCodexMainPids)
$catalogTimestampBefore = (Get-Item -LiteralPath $catalog).LastWriteTimeUtc
$previousForceFallback = $env:ANTICODEX_TEST_FORCE_REFRESH_FALLBACK
try {
    $env:ANTICODEX_TEST_FORCE_REFRESH_FALLBACK = "1"
    & $refresh
} finally {
    $env:ANTICODEX_TEST_FORCE_REFRESH_FALLBACK = $previousForceFallback
}

$catalogTimestampAfter = (Get-Item -LiteralPath $catalog).LastWriteTimeUtc
if ($catalogTimestampAfter -le $catalogTimestampBefore) {
    throw "Fallback restart did not refresh the Antigravity model catalog."
}
$localAddress = if ($env:ANTICODEX_LOCAL_ADDRESS) {
    $env:ANTICODEX_LOCAL_ADDRESS
} else {
    [string](Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' -and
            -not $_.SkipAsSource
        } |
        Sort-Object InterfaceMetric |
        Select-Object -First 1 -ExpandProperty IPAddress)
}
if (-not $localAddress) { $localAddress = "127.0.0.1" }
$health = Invoke-RestMethod -Uri "http://${localAddress}:8484/health" -Proxy $null -TimeoutSec 15
if (-not $health.ok -or -not $health.accountReady -or [int]$health.modelCount -lt 1) {
    throw "Fallback restart did not restore a ready Anti-Codex gateway."
}
$originalCodexAfter = @(Get-OriginalCodexMainPids)
if (($originalCodexBefore -join ",") -ne ($originalCodexAfter -join ",")) {
    throw "Fallback restart changed the original Codex main process set."
}

[pscustomobject]@{
    ok = $true
    catalogRefreshed = $true
    accountReady = [bool]$health.accountReady
    modelCount = [int]$health.modelCount
    originalCodexMainPids = $originalCodexAfter
} | ConvertTo-Json -Compress
