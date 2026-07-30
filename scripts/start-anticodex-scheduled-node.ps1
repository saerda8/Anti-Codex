#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("launcher", "updater")]
    [string]$TaskKind
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $scriptRoot)))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
$stateRoot = Join-Path $env:APPDATA "anticodex"
$logRoot = Join-Path $stateRoot "logs"
$taskScript = Join-Path $scriptRoot $(if ($TaskKind -eq "updater") { "start-anticodex-update-task.mjs" } else { "start-anticodex-task.mjs" })

function Report-AntiCodexScheduledNodeFailure {
    param([Parameter(Mandatory = $true)][string]$Message)

    try {
        New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
        Add-Content -LiteralPath (Join-Path $logRoot "anticodex-scheduled-node.err.log") `
            -Value ("{0} {1} broker failed: {2}" -f [DateTime]::UtcNow.ToString("o"), $TaskKind, $Message) `
            -Encoding UTF8
    } catch {}

    if ($TaskKind -eq "updater") {
        try {
            Import-Module (Join-Path $scriptRoot "anticodex-update-status.psm1") -Force
            [void](Set-AntiCodexUpdateOperation `
                -State "failed" `
                -Stage "updater_handoff_failed" `
                -Message $Message `
                -FailureCode "updater_handoff_failed" `
                -ExpectedStates @("running") `
                -ExpectedStages @("updater_queued", "updater_handoff"))
        } catch {}
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup(
            ("Anti-Codex could not start its {0} task.`n`n{1}" -f $TaskKind, $Message),
            12,
            "Anti-Codex",
            16
        )
    } catch {}
}

try {
    if ($installRoot -ine $expectedRoot) {
        throw "Anti-Codex scheduled tasks may only run from $expectedRoot"
    }
    if (-not (Test-Path -LiteralPath $taskScript -PathType Leaf)) {
        throw "Anti-Codex scheduled task script is missing: $taskScript"
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $nodeCommand) { throw "Node.js was not found." }
    $node = [IO.Path]::GetFullPath([string]$nodeCommand.Source)

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $node
    $startInfo.Arguments = '"' + $taskScript.Replace('"', '\"') + '"'
    $startInfo.WorkingDirectory = $installRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden

    $process = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw "The hidden Node.js task process did not start." }
    try {
        $process.WaitForExit()
        exit [int]$process.ExitCode
    } finally {
        $process.Dispose()
    }
} catch {
    Report-AntiCodexScheduledNodeFailure -Message $_.Exception.Message
    exit 1
}
