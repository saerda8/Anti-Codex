#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$StateRoot = "",
    [string]$ProfileRoot = "",
    [string]$Command = "login",
    [switch]$NoSaveProfile,
    [switch]$AllowFileIsolationOnly,
    [switch]$DryRun,
    [int]$TimeoutSec = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$prepareScript = Join-Path $PSScriptRoot "prepare-anticodex-antigravity-cli-profile.ps1"
if (-not (Test-Path -LiteralPath $prepareScript -PathType Leaf)) {
    throw "missing Anti-Codex Antigravity CLI profile prepare script: $prepareScript"
}

$prepareArgs = @{
    TimeoutSec = $TimeoutSec
}
if ($StateRoot) { $prepareArgs.StateRoot = $StateRoot }
if ($ProfileRoot) { $prepareArgs.ProfileRoot = $ProfileRoot }
if ($NoSaveProfile) { $prepareArgs.NoSaveProfile = $true }

$prepareOutput = & $prepareScript @prepareArgs
if (-not $?) { throw "failed to prepare isolated Antigravity CLI profile" }
$prepareJson = ($prepareOutput | Select-Object -Last 1)
$prepare = $prepareJson | ConvertFrom-Json -ErrorAction Stop

if ($prepare.ok -ne $true) {
    $failures = @($prepare.failures) -join "; "
    throw "isolated Antigravity CLI profile prepare failed: $failures"
}

$profileRootFull = [IO.Path]::GetFullPath([string]$prepare.profileRoot)
$helperPath = [IO.Path]::GetFullPath([string]$prepare.helperScript)
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw "missing isolated Antigravity CLI helper: $helperPath"
}

$terminalArgs = @(
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $helperPath
)
if ($Command) { $terminalArgs += $Command }

$result = [ordered]@{
    ok = $AllowFileIsolationOnly.IsPresent
    reportName = "antigravity-cli-isolated-login-terminal"
    noTraffic = $true
    usedRealTraffic = $false
    capturesLoginOutput = $false
    blockedByDefault = (-not $AllowFileIsolationOnly.IsPresent)
    blockReason = if ($AllowFileIsolationOnly.IsPresent) { "" } else { "same Windows user can reuse Antigravity credentials from the Windows/browser credential store; file/AppData isolation is not account isolation" }
    workingDirectory = $profileRootFull
    helperScript = $helperPath
    command = $Command
    terminalFile = "powershell.exe"
    terminalArgs = $terminalArgs
    accountLaneRole = "anticodex-model-text"
    profileRoot = $profileRootFull
    strictWindowsAppDataIsolation = $true
    windowsCredentialStoreIsolation = $false
    accountIsolationBoundary = "file-and-appdata-only"
    accountIsolationCaveat = "Do not use this as a second-account login path under the same Windows user. The user observed Antigravity remained already signed in, so true account separation needs a separate Windows user or official independent credential store."
    prepareReport = $prepare
}

if ($DryRun) {
    $result.started = $false
    $result | ConvertTo-Json -Depth 24 -Compress
    if ($AllowFileIsolationOnly.IsPresent) { exit 0 }
    exit 1
}

if (-not $AllowFileIsolationOnly.IsPresent) {
    $result.started = $false
    $result | ConvertTo-Json -Depth 24 -Compress
    exit 1
}

Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $terminalArgs `
    -WorkingDirectory $profileRootFull `
    -WindowStyle Normal | Out-Null

$result.started = $true
$result | ConvertTo-Json -Depth 24 -Compress
