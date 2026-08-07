[CmdletBinding()]
param(
    [string]$InstallRoot = $(if ($env:DEEPCODEX_INSTALL_ROOT) { $env:DEEPCODEX_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Anti-Codex" }),
    [string]$SourceScript = $(Join-Path $PSScriptRoot "anticodex_shared_mcp_proxy.py"),
    [string]$PythonExecutable = "",
    [switch]$Rollback
)

$ErrorActionPreference = "Stop"
$proxyVersion = "0.12.0"
$mcpVersion = "1.27.1"
$mutex = [Threading.Mutex]::new($false, "Global\AntiCodexSharedMcpInstall")
$acquired = $false
$stage = $null

function Test-PathInsideRoot {
    param([string]$Path, [string]$Root)
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    return $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-Sha256 {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Write-Result {
    param([bool]$Changed, [string]$Action, [string]$Target, [string]$Hash)
    [pscustomobject]@{
        ok = $true
        changed = $Changed
        action = $Action
        target = $Target
        sourceSha256 = $Hash
        mcpProxyVersion = $proxyVersion
        mcpSdkVersion = $mcpVersion
        restartRequired = $false
        activation = "next-normal-anticodex-start"
    } | ConvertTo-Json -Compress
}

try {
    try {
        $acquired = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
        $acquired = $true
    }
    if (-not $acquired) { throw "Another Anti-Codex shared MCP install is running." }

    $resolvedRoot = [IO.Path]::GetFullPath($InstallRoot)
    $target = [IO.Path]::GetFullPath((Join-Path $resolvedRoot "shared-mcp"))
    $rollbackTarget = [IO.Path]::GetFullPath((Join-Path $resolvedRoot "shared-mcp-rollback"))
    foreach ($path in @($target, $rollbackTarget)) {
        if (-not (Test-PathInsideRoot -Path $path -Root $resolvedRoot)) {
            throw "Refusing an Anti-Codex shared MCP path outside the install root: $path"
        }
    }
    New-Item -ItemType Directory -Path $resolvedRoot -Force | Out-Null

    if ($Rollback) {
        if (-not (Test-Path -LiteralPath $rollbackTarget -PathType Container)) {
            throw "No Anti-Codex shared MCP rollback is available."
        }
        $swap = [IO.Path]::GetFullPath((Join-Path $resolvedRoot ("shared-mcp-swap-" + [guid]::NewGuid().ToString("N"))))
        if (-not (Test-PathInsideRoot -Path $swap -Root $resolvedRoot)) { throw "Unsafe rollback swap path." }
        if (Test-Path -LiteralPath $target -PathType Container) { Move-Item -LiteralPath $target -Destination $swap }
        Move-Item -LiteralPath $rollbackTarget -Destination $target
        if (Test-Path -LiteralPath $swap -PathType Container) { Move-Item -LiteralPath $swap -Destination $rollbackTarget }
        $hash = Get-Sha256 (Join-Path $target "anticodex_shared_mcp_proxy.py")
        Write-Result -Changed $true -Action "rollback" -Target $target -Hash $hash
        return
    }

    if (-not (Test-Path -LiteralPath $SourceScript -PathType Leaf)) {
        throw "Anti-Codex shared MCP source is missing: $SourceScript"
    }
    $sourceHash = Get-Sha256 $SourceScript
    $currentManifest = Join-Path $target "component-manifest.json"
    if (Test-Path -LiteralPath $currentManifest -PathType Leaf) {
        try {
            $current = Get-Content -LiteralPath $currentManifest -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($current.schema -eq "anticodex-shared-mcp-component-v1" -and
                $current.sourceSha256 -eq $sourceHash -and
                $current.mcpProxyVersion -eq $proxyVersion -and
                $current.mcpSdkVersion -eq $mcpVersion -and
                (Test-Path -LiteralPath (Join-Path $target ".venv\Scripts\python.exe") -PathType Leaf)) {
                Write-Result -Changed $false -Action "already-current" -Target $target -Hash $sourceHash
                return
            }
        } catch {
        }
    }

    if (-not $PythonExecutable) {
        $pythonCommand = Get-Command python -ErrorAction Stop
        $PythonExecutable = $pythonCommand.Source
    }
    if (-not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
        throw "Python executable is unavailable: $PythonExecutable"
    }

    $stage = [IO.Path]::GetFullPath((Join-Path $resolvedRoot ("shared-mcp-stage-" + [guid]::NewGuid().ToString("N"))))
    if (-not (Test-PathInsideRoot -Path $stage -Root $resolvedRoot)) { throw "Unsafe install stage path." }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $venv = Join-Path $stage ".venv"
    $null = & $PythonExecutable -B -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Anti-Codex shared MCP virtual environment creation failed." }
    $venvPython = Join-Path $venv "Scripts\python.exe"
    $null = & $venvPython -B -m pip install --disable-pip-version-check --no-input --timeout 15 --retries 1 "mcp-proxy==$proxyVersion" "mcp==$mcpVersion"
    if ($LASTEXITCODE -ne 0) { throw "Anti-Codex shared MCP dependency install failed." }
    $null = & $venvPython -B -c "import importlib.metadata as m; assert m.version('mcp-proxy') == '$proxyVersion'; assert m.version('mcp') == '$mcpVersion'"
    if ($LASTEXITCODE -ne 0) { throw "Anti-Codex shared MCP dependency verification failed." }

    Copy-Item -LiteralPath $SourceScript -Destination (Join-Path $stage "anticodex_shared_mcp_proxy.py")
    [pscustomobject]@{
        schema = "anticodex-shared-mcp-component-v1"
        installedAt = [DateTime]::UtcNow.ToString("o")
        sourceSha256 = $sourceHash
        mcpProxyVersion = $proxyVersion
        mcpSdkVersion = $mcpVersion
        stateRoot = "%APPDATA%\anticodex\shared-mcp"
        mutex = "Local\AntiCodexSharedMcpProxyV1"
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stage "component-manifest.json") -Encoding UTF8

    if (Test-Path -LiteralPath $rollbackTarget -PathType Container) {
        Remove-Item -LiteralPath $rollbackTarget -Recurse -Force
    }
    if (Test-Path -LiteralPath $target -PathType Container) {
        Move-Item -LiteralPath $target -Destination $rollbackTarget
    }
    Move-Item -LiteralPath $stage -Destination $target
    $stage = $null
    Write-Result -Changed $true -Action "install" -Target $target -Hash $sourceHash
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage -PathType Container)) {
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        $resolvedRoot = [IO.Path]::GetFullPath($InstallRoot)
        if (Test-PathInsideRoot -Path $resolvedStage -Root $resolvedRoot) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
