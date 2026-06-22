#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Show-AntiCodexPopup {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Title = "Anti-Codex Rollback",
        [int]$Icon = 64,
        [int]$TimeoutSeconds = 12
    )
    try {
        $shell = New-Object -ComObject WScript.Shell
        return $shell.Popup($Message, $TimeoutSeconds, $Title, $Icon)
    } catch {
        Write-Host $Message
        return 1
    }
}

$scriptRoot = Split-Path -Parent $PSCommandPath
$rollbackScript = Join-Path $scriptRoot "rollback-anticodex.ps1"
$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $scriptRoot)))
$rollbackHost = Join-Path $installRoot "rollback-host"
$rollbackMarker = Join-Path $installRoot "rollback-host.ok"

if (-not (Test-Path -LiteralPath $rollbackHost) -or -not (Test-Path -LiteralPath $rollbackMarker)) {
    Show-AntiCodexPopup `
        -Title "Anti-Codex Rollback Unavailable" `
        -Icon 48 `
        -Message "Cannot rollback: No previous version exists.`n`nSync Anti-Codex with a newer Codex version once to create a rollback checkpoint." | Out-Null
    exit 0
}

$confirm = Show-AntiCodexPopup `
    -Icon (4 + 32) `
    -TimeoutSeconds 0 `
    -Message "Are you sure you want to rollback Anti-Codex to the previous version?`n`nThis will stop any running Anti-Codex sessions."

if ($confirm -ne 6) {
    exit 0
}

try {
    if (-not (Test-Path -LiteralPath $rollbackScript -PathType Leaf)) {
        throw "Anti-Codex rollback script is missing: $rollbackScript"
    }

    & $rollbackScript
    if ($LASTEXITCODE -ne 0) {
        throw "Anti-Codex rollback exited with code $LASTEXITCODE."
    }

    Show-AntiCodexPopup `
        -Title "Anti-Codex Rollback Complete" `
        -Icon 64 `
        -Message "Anti-Codex has been rolled back successfully and is restarting." | Out-Null
} catch {
    Show-AntiCodexPopup `
        -Title "Anti-Codex Rollback Failed" `
        -Icon 16 `
        -Message ("Anti-Codex was not changed, or automatic recovery restored it.`n`n" + $_.Exception.Message) | Out-Null
    exit 1
}
