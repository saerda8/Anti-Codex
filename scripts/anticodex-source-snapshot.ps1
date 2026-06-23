function Get-AntiCodexSourceSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$SharedCodexHome,
        [Parameter(Mandatory = $true)][string]$AgentsSkillsPath,
        [string]$CachePath = ""
    )

    $rows = New-Object System.Collections.Generic.List[string]
    $sources = New-Object System.Collections.Generic.List[object]
    $mtimeMax = $null
    $cacheHitCount = 0
    $cacheMissCount = 0

    if (-not $CachePath) {
        $stateRoot = if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }
        $CachePath = Join-Path $stateRoot "cache\source-snapshot-cache.json"
    }

    $cacheEntries = @{}
    if ($CachePath -and (Test-Path -LiteralPath $CachePath -PathType Leaf)) {
        try {
            $loaded = Get-Content -LiteralPath $CachePath -Raw | ConvertFrom-Json -ErrorAction Stop
            if ($loaded.entries) {
                foreach ($property in $loaded.entries.PSObject.Properties) {
                    $cacheEntries[$property.Name] = $property.Value
                }
            }
        } catch {
            $cacheEntries = @{}
        }
    }
    $newCacheEntries = [ordered]@{}

    function Get-FileSha256Hex {
        param([string]$Path)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $stream = $null
        try {
            $stream = [IO.File]::OpenRead($Path)
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        } finally {
            if ($stream) { $stream.Dispose() }
            $sha.Dispose()
        }
    }

    function Add-SourceFile {
        param([string]$Label, [string]$Path, [string]$Relative, [bool]$HashContent)
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
        $item = Get-Item -LiteralPath $Path -Force
        $normalized = ([string]$Relative).Replace("\", "/")
        $cacheKey = "$Label/$normalized"
        $metaSignature = "$($item.Length):$($item.LastWriteTimeUtc.Ticks)"
        $signature = if ($HashContent) {
            $cached = $cacheEntries[$cacheKey]
            if ($cached -and [string]$cached.meta -eq $metaSignature -and [string]$cached.hash) {
                $script:__anticodexSourceCacheHitCount += 1
                [string]$cached.hash
            } else {
                $script:__anticodexSourceCacheMissCount += 1
                Get-FileSha256Hex $Path
            }
        } else {
            $metaSignature
        }
        if ($HashContent) {
            $script:__anticodexSourceNewCacheEntries[$cacheKey] = [pscustomobject]@{
                meta = $metaSignature
                hash = $signature
            }
        }
        $rows.Add("$cacheKey`t$signature") | Out-Null
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
    $script:__anticodexSourceCacheHitCount = 0
    $script:__anticodexSourceCacheMissCount = 0
    $script:__anticodexSourceNewCacheEntries = $newCacheEntries
    Add-SourcePath -Label "shared-config" -Path (Join-Path $SharedCodexHome "config.toml") -Kind "file" -HashContent $true
    Add-SourcePath -Label "shared-skills" -Path (Join-Path $SharedCodexHome "skills") -Kind "directory" -HashContent $true
    Add-SourcePath -Label "agents-skills" -Path $AgentsSkillsPath -Kind "directory" -HashContent $true
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
    $cacheHitCount = $script:__anticodexSourceCacheHitCount
    $cacheMissCount = $script:__anticodexSourceCacheMissCount
    $cachePayloadEntries = $script:__anticodexSourceNewCacheEntries
    if ($CachePath) {
        try {
            $cacheDir = Split-Path -Parent $CachePath
            if ($cacheDir) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
            $payload = [pscustomobject]@{
                version = 1
                generatedAt = ([DateTime]::UtcNow.ToString("o"))
                entries = $cachePayloadEntries
            }
            $json = $payload | ConvertTo-Json -Depth 5 -Compress
            $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
            [IO.File]::WriteAllText($CachePath, $json, $utf8NoBom)
        } catch {
        }
    }
    Remove-Variable -Name __anticodexSourceMtimeMax -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable -Name __anticodexSourceCacheHitCount -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable -Name __anticodexSourceCacheMissCount -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable -Name __anticodexSourceNewCacheEntries -Scope Script -ErrorAction SilentlyContinue
    return [pscustomobject]@{
        fingerprint = $fingerprint
        sourceMtimeMax = if ($maxMtime) { $maxMtime.ToString("o") } else { "" }
        fileCount = $sortedRows.Count
        cachePath = $CachePath
        cacheHitCount = $cacheHitCount
        cacheMissCount = $cacheMissCount
        sources = @($sources.ToArray())
    }
}
