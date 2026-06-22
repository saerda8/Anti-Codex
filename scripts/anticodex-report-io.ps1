function Write-AntiCodexTextAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text,
        [System.Text.Encoding]$Encoding = (New-Object System.Text.UTF8Encoding($false)),
        [switch]$ValidateJson
    )

    $targetPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $directory = Split-Path -Parent $targetPath
    if ([string]::IsNullOrWhiteSpace($directory)) { $directory = "." }
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $leaf = Split-Path -Leaf $targetPath
    $tempPath = Join-Path $directory (".{0}.{1}.{2}.tmp" -f $leaf, $PID, ([guid]::NewGuid().ToString("N")))
    $backupPath = Join-Path $directory (".{0}.{1}.{2}.bak" -f $leaf, $PID, ([guid]::NewGuid().ToString("N")))

    try {
        [System.IO.File]::WriteAllText($tempPath, $Text, $Encoding)
        if ($ValidateJson) {
            [void]([System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($tempPath)) | ConvertFrom-Json -ErrorAction Stop)
        }

        if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
            [System.IO.File]::Replace($tempPath, $targetPath, $backupPath, $true)
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
        } else {
            [System.IO.File]::Move($tempPath, $targetPath)
        }
    } catch {
        if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Write-AntiCodexJsonReport {
    param(
        [Parameter(Mandatory = $true)][string]$LatestPath,
        [Parameter(Mandatory = $true)][string]$HistoryPath,
        [Parameter(Mandatory = $true)][string]$Json,
        [System.Text.Encoding]$Encoding = (New-Object System.Text.UTF8Encoding($false))
    )

    Write-AntiCodexTextAtomic -Path $HistoryPath -Text $Json -Encoding $Encoding -ValidateJson
    Write-AntiCodexTextAtomic -Path $LatestPath -Text $Json -Encoding $Encoding -ValidateJson
}
