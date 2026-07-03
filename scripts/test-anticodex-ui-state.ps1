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
function Test-CdpPort {
    param([int]$Port)
    if ($Port -le 0) { return $false }
    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -Proxy $null -TimeoutSec 2
        return ($null -ne $version -and ($version.PSObject.Properties.Name -contains "webSocketDebuggerUrl"))
    } catch {
        return $false
    }
}

function Get-AntiCodexProcessCdpPorts {
    $ports = New-Object System.Collections.Generic.List[int]
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name = 'Anti-Codex.exe'" -ErrorAction Stop
        foreach ($proc in $procs) {
            $cmd = [string]$proc.CommandLine
            $match = [regex]::Match($cmd, "--remote-debugging-port=(\d+)")
            if ($match.Success) {
                $ports.Add([int]$match.Groups[1].Value) | Out-Null
            }
        }
    } catch {}
    return @($ports | Select-Object -Unique)
}

if ($CdpPort -le 0) {
    $candidatePorts = @()
    if ($env:DEEPCODEX_CDP_PORT) { $candidatePorts += [int]$env:DEEPCODEX_CDP_PORT }
    $candidatePorts += @(Get-AntiCodexProcessCdpPorts)
    $candidatePorts += @(58318, 58317)
    foreach ($candidatePort in @($candidatePorts | Select-Object -Unique)) {
        if (Test-CdpPort -Port $candidatePort) {
            $CdpPort = $candidatePort
            break
        }
    }
    if ($CdpPort -le 0) { throw "No usable Anti-Codex CDP port found" }
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
$stdoutPath = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-ui-state-{0}.out" -f ([guid]::NewGuid().ToString("N")))
$stderrPath = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-ui-state-{0}.err" -f ([guid]::NewGuid().ToString("N")))
$process = $null
$fallbackWarnings = @()
try {
    try {
        $process = Start-Process -FilePath $node -ArgumentList $nodeArgs -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        $waitMs = [Math]::Max(1000, ($TimeoutSec * 1000) + 5000)
        if (-not $process.WaitForExit($waitMs)) {
            try { $process.Kill() } catch {}
            try { $process.WaitForExit(5000) | Out-Null } catch {}
            $stdoutTail = if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { @(Get-Content -LiteralPath $stdoutPath -Encoding UTF8 -Tail 20) } else { @() }
            $stderrTail = if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { @(Get-Content -LiteralPath $stderrPath -Encoding UTF8 -Tail 20) } else { @() }
            [pscustomobject]@{
                ok = $false
                failures = @("UI verifier timed out after $TimeoutSec seconds")
                exitCode = -1
                stdoutTail = $stdoutTail
                stderrTail = $stderrTail
            } | ConvertTo-Json -Depth 8 -Compress
            exit 1
        }
        $process.Refresh()
        $exitCode = if ($null -ne $process.ExitCode) { [int]$process.ExitCode } else { 1 }
        $output = @()
        if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { $output += @(Get-Content -LiteralPath $stdoutPath -Encoding UTF8) }
        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { $output += @(Get-Content -LiteralPath $stderrPath -Encoding UTF8) }
    } catch {
        $startError = $_.Exception.Message
        try {
            $directOutput = @(& $node @nodeArgs 2>&1 | ForEach-Object { [string]$_ })
            $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
            $fallbackWarnings += "UI verifier failed to start; falling back to direct node execution: $startError"
            $output = @($directOutput)
        } catch {
            [pscustomobject]@{
                ok = $false
                failures = @("UI verifier Start-Process failed and direct node fallback failed: $startError / $($_.Exception.Message)")
                exitCode = -1
                tail = @()
            } | ConvertTo-Json -Depth 8 -Compress
            exit 1
        }
    }
} finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
}
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
$parsed | Add-Member -NotePropertyName fallbackWarnings -NotePropertyValue @($fallbackWarnings) -Force
$parsed | ConvertTo-Json -Depth 10 -Compress
if ($parsed.ok -eq $true) { exit 0 }
exit 1


