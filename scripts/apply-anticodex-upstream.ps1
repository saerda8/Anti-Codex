#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$startScript = Join-Path $PSScriptRoot "start-deepcodex.ps1"
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "Missing Anti-Codex translator launcher."
}

$stateRoot = if ($env:DEEPCODEX_STATE_ROOT) {
    $env:DEEPCODEX_STATE_ROOT
} else {
    Join-Path $env:APPDATA "anticodex"
}
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$stdoutPath = Join-Path $stateRoot "apply-upstream.out.log"
$stderrPath = Join-Path $stateRoot "apply-upstream.err.log"
Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

$powerShell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $startScript,
    "-TranslatorOnly"
)
$options = @{
    FilePath = $powerShell
    ArgumentList = $arguments
    RedirectStandardOutput = $stdoutPath
    RedirectStandardError = $stderrPath
    WindowStyle = "Hidden"
    PassThru = $true
}
$process = Start-Process @options

[pscustomobject]@{
    ok = $true
    pid = $process.Id
    message = "Anti-Codex translator restart started."
} | ConvertTo-Json -Compress
