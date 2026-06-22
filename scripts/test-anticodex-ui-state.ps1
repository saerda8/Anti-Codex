[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$RuntimeRoot = $(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Anti-Codex\runtime"),
    [int]$CdpPort = 0,
    [int]$TimeoutSec = 8,
    [int]$ManagerProbeTimeoutSec = 0,
    [switch]$Fast,
    [switch]$SkipManagerActionProbe
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

function Resolve-Node {
    param([string]$InstallRoot)
    $bundled = Join-Path $InstallRoot "codex-patched-app\resources\cua_node\bin\node.exe"
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) { return $node.Source }
    throw "node.exe not found"
}

$runtimeRootFull = [IO.Path]::GetFullPath($RuntimeRoot)
$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent $runtimeRootFull))
$scriptPath = Join-Path $runtimeRootFull "scripts\test-anticodex-ui-state.mjs"
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    $scriptPath = Join-Path (Split-Path -Parent $PSCommandPath) "test-anticodex-ui-state.mjs"
}
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "UI state verifier missing: $scriptPath"
}

$catalogPath = Join-Path $env:APPDATA "anticodex\antigravity-model-catalog.json"
if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) {
    $catalogPath = Join-Path $runtimeRootFull "codex-home-deepseek-app\deepseek-model-catalog.json"
}

$node = Resolve-Node $installRoot
$effectiveManagerProbeTimeoutSec = if ($ManagerProbeTimeoutSec -gt 0) { $ManagerProbeTimeoutSec } else { $TimeoutSec }
if ($CdpPort -le 0) {
    foreach ($candidatePort in 58318, 58317) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$candidatePort/json" -Proxy $null -TimeoutSec 2 | Out-Null
            $CdpPort = $candidatePort
            break
        } catch {}
    }
    if ($CdpPort -le 0) { $CdpPort = 58318 }
}
$nodeArgs = @(
    $scriptPath,
    "--port", "$CdpPort",
    "--base-url", "$BaseUrl",
    "--catalog", "$catalogPath",
    "--timeout-ms", "$($TimeoutSec * 1000)",
    "--manager-probe-timeout-ms", "$($effectiveManagerProbeTimeoutSec * 1000)"
)
if ($SkipManagerActionProbe) {
    $nodeArgs += @("--skip-manager-action-probe", "1")
}
if ($Fast) {
    $nodeArgs += @("--fast", "1")
}
$output = @(& $node @nodeArgs 2>&1)
$exitCode = $LASTEXITCODE
$lines = @($output | ForEach-Object { [string]$_ })
$jsonText = ($lines -join "").Trim()
$jsonLine = [string](@($lines | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1))

$payloadText = if ($jsonText) { $jsonText } else { $jsonLine }
if (-not $payloadText) {
    [pscustomobject]@{
        ok = $false
        failures = @("UI verifier did not emit JSON")
        exitCode = $exitCode
        tail = @($lines | Select-Object -Last 20)
    } | ConvertTo-Json -Depth 8 -Compress
    exit 1
}

$start = $payloadText.IndexOf("{")
$end = $payloadText.LastIndexOf("}")
if ($start -ge 0 -and $end -gt $start) {
    $payloadText = $payloadText.Substring($start, $end - $start + 1)
}

$parsed = $payloadText | ConvertFrom-Json -ErrorAction Stop
$parsed | ConvertTo-Json -Depth 10 -Compress
if ($exitCode -ne 0 -or $parsed.ok -ne $true) { exit 1 }


