[CmdletBinding()]
param(
    [switch]$RequireRuntimeClean
)

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

if ($RequireRuntimeClean) {
    if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
        $failures.Add("Docker CLI is unavailable; build-container cleanup cannot be verified")
    } else {
        $buildContainers = [System.Collections.Generic.HashSet[string]]::new(
            [StringComparer]::OrdinalIgnoreCase
        )
        $queries = @(
            @("ps", "-a", "--filter", "label=com.anticodex.ephemeral-build=true", "--format", "{{.ID}} {{.Names}}"),
            @("ps", "-a", "--filter", "name=anticodex-cpp-", "--format", "{{.ID}} {{.Names}}")
        )
        foreach ($query in $queries) {
            $previousErrorAction = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                $output = @(& docker.exe @query 2>&1)
                $exitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousErrorAction
            }
            if ($exitCode -ne 0) {
                $failures.Add("Docker build-container cleanup query failed")
                continue
            }
            foreach ($line in $output) {
                $text = ([string]$line).Trim()
                if ($text) { [void]$buildContainers.Add($text) }
            }
        }
        if ($buildContainers.Count -gt 0) {
            $failures.Add("Anti-Codex build containers remain: $(@($buildContainers) -join '; ')")
        }
    }
}

if ($failures.Count -gt 0) {
    throw ($failures -join [Environment]::NewLine)
}

Write-Output "Anti-Codex Docker build hygiene: PASS"
