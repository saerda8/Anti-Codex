function Get-AntiCodexSourceSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$SharedCodexHome,
        [Parameter(Mandatory = $true)][string]$AgentsSkillsPath
    )

    $rows = New-Object System.Collections.Generic.List[string]
    $sources = New-Object System.Collections.Generic.List[object]
    $mtimeMax = $null

    function Add-SourceFile {
        param([string]$Label, [string]$Path, [string]$Relative, [bool]$HashContent)
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
        $item = Get-Item -LiteralPath $Path -Force
        $normalized = ([string]$Relative).Replace("\", "/")
        $signature = if ($HashContent) {
            (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        } else {
            "$($item.Length):$($item.LastWriteTimeUtc.Ticks)"
        }
        $rows.Add("$Label/$normalized`t$signature") | Out-Null
        if ($null -eq $script:__anticodexSourceMtimeMax -or $item.LastWriteTimeUtc -gt $script:__anticodexSourceMtimeMax) {
            $script:__anticodexSourceMtimeMax = $item.LastWriteTimeUtc
        }
    }

    function Add-SourcePath {
        param(
            [string]$Label,
            [string]$Path,
            [ValidateSet("file", "directory")]
            [string]$Kind,
            [bool]$HashContent = $false
        )
        $exists = if ($Kind -eq "file") {
            Test-Path -LiteralPath $Path -PathType Leaf
        } else {
            Test-Path -LiteralPath $Path -PathType Container
        }
        $countBefore = $rows.Count
        if ($exists -and $Kind -eq "file") {
            Add-SourceFile -Label $Label -Path $Path -Relative ([IO.Path]::GetFileName($Path)) -HashContent $HashContent
        } elseif ($exists -and $Kind -eq "directory") {
            $rootPath = (Resolve-Path -LiteralPath $Path).Path.TrimEnd("\", "/")
            $files = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction Stop |
                Where-Object { $_.Name -ne ".anticodex-source-manifest.json" } |
                Sort-Object FullName)
            foreach ($file in $files) {
                $relative = $file.FullName.Substring($rootPath.Length).TrimStart("\", "/")
                Add-SourceFile -Label $Label -Path $file.FullName -Relative $relative -HashContent $HashContent
            }
        }
        $sources.Add([pscustomobject]@{
            label = $Label
            kind = $Kind
            path = $Path
            exists = $exists
            fileCount = $rows.Count - $countBefore
        }) | Out-Null
    }

    $script:__anticodexSourceMtimeMax = $null
    Add-SourcePath -Label "shared-config" -Path (Join-Path $SharedCodexHome "config.toml") -Kind "file" -HashContent $true
    Add-SourcePath -Label "shared-skills" -Path (Join-Path $SharedCodexHome "skills") -Kind "directory"
    Add-SourcePath -Label "agents-skills" -Path $AgentsSkillsPath -Kind "directory"
    Add-SourcePath -Label "shared-connectors" -Path (Join-Path $SharedCodexHome "cache\codex_app_directory") -Kind "directory" -HashContent $true
    Add-SourcePath -Label "shared-app-tools" -Path (Join-Path $SharedCodexHome "cache\codex_apps_tools") -Kind "directory" -HashContent $true
    foreach ($name in @("AGENTS.md", "DEFAULT_SKILL_ALLOWLIST.md", "RTK.md", "MCP_WORKER_USAGE_GUIDE.md")) {
        Add-SourcePath -Label "shared-guidance-$name" -Path (Join-Path $SharedCodexHome $name) -Kind "file" -HashContent $true
    }

    $sortedRows = @($rows.ToArray() | Sort-Object)
    $joined = [string]::Join("`n", $sortedRows)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }

    $maxMtime = $script:__anticodexSourceMtimeMax
    Remove-Variable -Name __anticodexSourceMtimeMax -Scope Script -ErrorAction SilentlyContinue
    return [pscustomobject]@{
        fingerprint = $fingerprint
        sourceMtimeMax = if ($maxMtime) { $maxMtime.ToString("o") } else { "" }
        fileCount = $sortedRows.Count
        sources = @($sources.ToArray())
    }
}
