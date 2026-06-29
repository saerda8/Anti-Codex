#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WindowsUser,
    [string]$Command = "login",
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runnerPath = Join-Path $PSScriptRoot "start-anticodex-antigravity-cli-login.ps1"
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "missing same-user file-isolation runner: $runnerPath"
}

$commandParts = @(
    "powershell.exe",
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    ('"{0}"' -f $runnerPath),
    "-AllowFileIsolationOnly"
)
if ($Command) {
    $commandParts += "-Command"
    $commandParts += ('"{0}"' -f ($Command.Replace('"', '\"')))
}
$runasCommand = $commandParts -join " "

$result = [ordered]@{
    ok = $true
    reportName = "antigravity-cli-windows-user-login-terminal"
    noTraffic = $true
    usedRealTraffic = $false
    capturesLoginOutput = $false
    windowsUser = $WindowsUser
    credentialBoundary = "separate-windows-user"
    expectedCredentialStoreIsolation = $true
    accountIsolationCaveat = "This opens an interactive runas prompt. The password is handled by Windows runas, not by Codex. Login proof still requires explicit user-approved real traffic and account identity comparison."
    command = $Command
    runasFile = "runas.exe"
    runasArgs = @("/user:$WindowsUser", $runasCommand)
}

if ($DryRun) {
    $result.started = $false
    $result | ConvertTo-Json -Depth 12 -Compress
    exit 0
}

Start-Process -FilePath "runas.exe" -ArgumentList $result.runasArgs -WindowStyle Normal | Out-Null
$result.started = $true
$result | ConvertTo-Json -Depth 12 -Compress
