#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Show-AntiCodexPopup {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Title = "Anti-Codex Sync",
        [int]$Icon = 64
    )

    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup($Message, 12, $Title, $Icon) | Out-Null
    } catch {
        Write-Host $Message
    }
}

$scriptRoot = Split-Path -Parent $PSCommandPath
$syncScript = Join-Path $scriptRoot "sync-anticodex.ps1"

try {
    if (-not (Test-Path -LiteralPath $syncScript -PathType Leaf)) {
        throw "Anti-Codex sync component is missing: $syncScript"
    }

    $global:LASTEXITCODE = 0
    & $syncScript
    if ($LASTEXITCODE -ne 0) {
        throw "Anti-Codex sync exited with code $LASTEXITCODE."
    }
} catch {
    Show-AntiCodexPopup `
        -Title "Anti-Codex Sync Failed" `
        -Icon 16 `
        -Message ("Anti-Codex was not changed.`n`n" + $_.Exception.Message)
    exit 1
}
