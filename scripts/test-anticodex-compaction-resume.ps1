[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 300,
    [int]$LongContextChars = 100000,
    [string]$ThreadId = "",
    [string]$RolloutFile = "",
    [string]$TitleContains = "",
    [string]$ExpectedMarker = "",
    [string]$ArtifactDir = "",
    [string]$Model = $(if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "gemini-3.5-flash-low" }),
    [long]$CppLogOffset = 0,
    [long]$ExistingCompactionOffset = -1,
    [switch]$AllowRealTraffic
)

$ErrorActionPreference = "Stop"
$node = Get-Command node -ErrorAction Stop
$script = Join-Path $PSScriptRoot "test-anticodex-native-compaction-resume.mjs"
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "Native Codex compaction verifier is missing: $script"
}

$childArgs = @(
    $script,
    "--model", $Model,
    "--timeout-ms", ([Math]::Max(60000, $TimeoutSec * 1000)),
    "--min-long-context-bytes", $LongContextChars,
    "--report-root", $ReportRoot,
    "--cpp-log-offset", $CppLogOffset
)
if ($AllowRealTraffic) { $childArgs += "--allow-real-traffic" }
if ($ThreadId) { $childArgs += @("--thread-id", $ThreadId) }
if ($RolloutFile) { $childArgs += @("--rollout-file", $RolloutFile) }
if ($TitleContains) { $childArgs += @("--title-contains", $TitleContains) }
if ($ExpectedMarker) { $childArgs += @("--expected-marker", $ExpectedMarker) }
if ($ArtifactDir) { $childArgs += @("--artifact-dir", $ArtifactDir) }
if ($ExistingCompactionOffset -ge 0) { $childArgs += @("--existing-compaction-offset", $ExistingCompactionOffset) }

& $node.Source @childArgs
exit $LASTEXITCODE
