#Requires -Version 5.1
param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime"),
    [string]$FailurePatch = "auth-requirement"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent $RuntimeRoot))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRoot -ne $expectedRoot) {
    throw "Anti-Codex sync failure safety may only test $expectedRoot"
}

$installer = Join-Path $RuntimeRoot "scripts\install-anticodex.ps1"
$candidateRoot = Join-Path $installRoot "update-candidate"
$candidateMarker = Join-Path $candidateRoot "codex-patched-app.ok"
$activeMarker = Join-Path $installRoot "codex-patched-app.ok"
$activeAsar = Join-Path $installRoot "codex-patched-app\resources\app.asar"
foreach ($path in @($installer, $activeMarker, $activeAsar)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Anti-Codex sync failure safety is missing required path: $path"
    }
}

$candidateFull = [IO.Path]::GetFullPath($candidateRoot)
if ($candidateFull -ne [IO.Path]::GetFullPath((Join-Path $expectedRoot "update-candidate"))) {
    throw "Refusing to clean an unexpected candidate path."
}

$activeMarkerHashBefore = (Get-FileHash -LiteralPath $activeMarker -Algorithm SHA256).Hash
$activeAsarHashBefore = (Get-FileHash -LiteralPath $activeAsar -Algorithm SHA256).Hash
if (Test-Path -LiteralPath $candidateRoot) {
    [IO.Directory]::Delete("\\?\$candidateFull", $true)
}

$previousFailurePatch = $env:ANTICODEX_TEST_FAIL_CRITICAL_PATCH
$stdoutPath = [IO.Path]::GetTempFileName()
$stderrPath = [IO.Path]::GetTempFileName()
$failureOutput = ""
try {
    $env:ANTICODEX_TEST_FAIL_CRITICAL_PATCH = $FailurePatch
    $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    $process = Start-Process -FilePath $powershell `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installer, "-InstallTarget", $candidateRoot, "-HostOnly") `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    $failureOutput = ([string](Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue)) +
        ([string](Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue))
    if ($process.ExitCode -eq 0) {
        throw "Forced critical patch failure unexpectedly succeeded."
    }
    if ($failureOutput -notmatch "Forced critical patch failure for transaction safety test:\s*$([regex]::Escape($FailurePatch))") {
        $tail = (($failureOutput -split "`r?`n") | Select-Object -Last 8) -join " | "
        throw "Candidate failed before reaching the requested critical patch failure: $tail"
    }
} finally {
    $env:ANTICODEX_TEST_FAIL_CRITICAL_PATCH = $previousFailurePatch
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $candidateMarker) {
    throw "Failed candidate retained a valid host marker."
}
if ((Get-FileHash -LiteralPath $activeMarker -Algorithm SHA256).Hash -ne $activeMarkerHashBefore) {
    throw "Failed candidate build changed the active host marker."
}
if ((Get-FileHash -LiteralPath $activeAsar -Algorithm SHA256).Hash -ne $activeAsarHashBefore) {
    throw "Failed candidate build changed the active host."
}
if (Test-Path -LiteralPath $candidateRoot) {
    [IO.Directory]::Delete("\\?\$candidateFull", $true)
}

[pscustomobject]@{
    ok = $true
    forcedFailurePatch = $FailurePatch
    failureCauseVerified = $true
    candidateMarkerAbsent = -not (Test-Path -LiteralPath $candidateMarker)
    activeMarkerUnchanged = $true
    activeHostUnchanged = $true
} | ConvertTo-Json -Compress
