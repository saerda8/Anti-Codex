#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$startScript = Join-Path $PSScriptRoot "start-anticodex.ps1"
$fixedSupervisorScript = Join-Path $PSScriptRoot "start-anticodex-fixed-route.mjs"
foreach ($required in @($startScript, $fixedSupervisorScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Missing Anti-Codex fixed-route component: $required"
    }
}

$stateRoot = if ($env:DEEPCODEX_STATE_ROOT) {
    [IO.Path]::GetFullPath($env:DEEPCODEX_STATE_ROOT)
} else {
    [IO.Path]::GetFullPath((Join-Path $env:APPDATA "anticodex"))
}
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$stdoutPath = Join-Path $stateRoot "apply-upstream.out.log"
$stderrPath = Join-Path $stateRoot "apply-upstream.err.log"
Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

function Get-RunningFixedRouteSupervisor {
    $scriptName = [regex]::Escape((Split-Path -Leaf $fixedSupervisorScript))
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        [string]$_.CommandLine -match $scriptName
    })
}

$stoppedSupervisorPids = @()
foreach ($supervisor in @(Get-RunningFixedRouteSupervisor)) {
    $supervisorPid = [int]$supervisor.ProcessId
    $savedErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & taskkill.exe /PID $supervisorPid /T /F 2>$null | Out-Null
        $taskkillExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    $stillRunning = Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue
    if ($taskkillExitCode -ne 0 -and $stillRunning) {
        throw "Could not stop fixed-route supervisor PID $supervisorPid."
    }
    $stoppedSupervisorPids += $supervisorPid
}

if ($stoppedSupervisorPids.Count -gt 0) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if (@(Get-RunningFixedRouteSupervisor).Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (@(Get-RunningFixedRouteSupervisor).Count -gt 0) {
        throw "Fixed-route supervisor did not stop cleanly."
    }
}

$powerShell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "`"$startScript`"",
    "-SkipUpdateCheck"
)
$process = Start-Process -FilePath $powerShell `
    -ArgumentList $arguments `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru

[pscustomobject]@{
    ok = $true
    pid = $process.Id
    stoppedSupervisorPids = $stoppedSupervisorPids
    message = "Anti-Codex fixed-route restart started."
} | ConvertTo-Json -Compress
