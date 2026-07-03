[CmdletBinding()]
param(
    [string]$ReportRoot = "",
    [int]$MaxAgeMs = 21600000
)

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = (Get-Command node -ErrorAction Stop).Source
$Script = Join-Path $ScriptRoot "test-anticodex-current-channel-worker-recovery.mjs"

$ArgsList = @($Script, "--max-age-ms", [string]$MaxAgeMs)
if ($ReportRoot) {
    $ArgsList += @("--report-root", $ReportRoot)
}

& $Node @ArgsList
exit $LASTEXITCODE
