[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$scriptsRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptsRoot
$runnerPath = Join-Path $scriptsRoot "invoke-anticodex-cargo-xwin.ps1"
$rulesPath = Join-Path $repoRoot "MCP_WORKER_RULES.md"

$failures = [System.Collections.Generic.List[string]]::new()
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    $failures.Add("missing managed cargo-xwin runner")
} else {
    $runner = Get-Content -LiteralPath $runnerPath -Raw -Encoding UTF8
    if ($runner -notmatch '(?m)"--rm"') { $failures.Add("runner does not force Docker --rm") }
    if ($runner -notmatch 'com\.anticodex\.ephemeral-build=true') { $failures.Add("runner does not label ephemeral build containers") }
    if ($runner -match 'docker\s+create|sleep\s+infinity') { $failures.Add("runner permits persistent build-shell behavior") }
    if ($runner -notmatch '(?m)^finally\s*\{') { $failures.Add("runner has no finally cleanup") }
}

$rules = Get-Content -LiteralPath $rulesPath -Raw -Encoding UTF8
if ($rules -notmatch 'invoke-anticodex-cargo-xwin\.ps1') {
    $failures.Add("project rules do not require the managed runner")
}
if ($rules -notmatch 'docker create.*sleep infinity') {
    $failures.Add("project rules do not ban persistent ad-hoc build shells")
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Output "Anti-Codex Docker build hygiene: PASS"
