function Write-AntiCodexTextAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text,
        [System.Text.Encoding]$Encoding = (New-Object System.Text.UTF8Encoding($false)),
        [switch]$ValidateJson,
        [switch]$SkipHash
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
            try {
                [System.IO.File]::Move($tempPath, $targetPath)
            } catch [System.IO.IOException] {
                if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
                    throw
                }
                [System.IO.File]::Replace($tempPath, $targetPath, $backupPath, $true)
                Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
            }
        }

        if (-not $SkipHash) {
            $sha256 = [System.Security.Cryptography.SHA256]::Create()
            try {
                $bytes = [System.IO.File]::ReadAllBytes($targetPath)
                $hash = ($sha256.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join ""
            } finally {
                $sha256.Dispose()
            }
            Write-AntiCodexTextAtomic -Path "$targetPath.sha256" -Text "sha256:$hash" -Encoding ([System.Text.ASCIIEncoding]::new()) -SkipHash
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
