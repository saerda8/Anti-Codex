#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Anti-Codex"),
    [string]$SourceBinary = "",
    [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedInstallRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
$resolvedInstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$allowedInstallRoots = @(
    $expectedInstallRoot,
    [IO.Path]::GetFullPath((Join-Path $expectedInstallRoot "update-candidate"))
)
if ($resolvedInstallRoot -notin $allowedInstallRoots) {
    throw "CodexPlusPlus may only be installed in the active or fixed update-candidate Anti-Codex root."
}

$componentRoot = Join-Path $resolvedInstallRoot "components\codexplusplus"
$destinationBinary = Join-Path $componentRoot "codex-plus-plus.exe"
$destinationMetadata = Join-Path $componentRoot "upstream.json"
$manifestPath = Join-Path $componentRoot "component-manifest.json"
$noticePath = Join-Path $componentRoot "LICENSE-NOTICE.txt"
$sourceRoot = Split-Path -Parent $PSScriptRoot
$sourceMetadata = Join-Path $sourceRoot "third_party\codexplusplus\upstream.json"
if (-not (Test-Path -LiteralPath $sourceMetadata -PathType Leaf)) {
    $sourceMetadata = $destinationMetadata
}
if (-not (Test-Path -LiteralPath $sourceMetadata -PathType Leaf)) {
    throw "CodexPlusPlus metadata is missing: third_party\codexplusplus\upstream.json"
}

$metadata = Get-Content -LiteralPath $sourceMetadata -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$metadata.component -ne "CodexPlusPlus" -or [string]$metadata.license -ne "AGPL-3.0-only") {
    throw "CodexPlusPlus metadata component/license is invalid."
}
$expectedHash = ([string]$metadata.verification.launcherReleaseBuild).Replace("sha256:", "").ToLowerInvariant()
if ($expectedHash -notmatch '^[0-9a-f]{64}$') {
    throw "CodexPlusPlus metadata does not contain a valid release binary hash."
}

if (-not $SourceBinary -and $env:ANTICODEX_CODEXPLUSPLUS_BINARY) {
    $SourceBinary = [string]$env:ANTICODEX_CODEXPLUSPLUS_BINARY
}
if (-not $SourceBinary -and (Test-Path -LiteralPath $destinationBinary -PathType Leaf)) {
    $SourceBinary = $destinationBinary
}
if (-not $SourceBinary) {
    $activeBinary = Join-Path $expectedInstallRoot "components\codexplusplus\codex-plus-plus.exe"
    if (Test-Path -LiteralPath $activeBinary -PathType Leaf) {
        $SourceBinary = $activeBinary
    }
}
if (-not $SourceBinary) {
    $localBuild = Join-Path $env:LOCALAPPDATA "Temp\CodexPlusPlus-analysis-20260714\target\x86_64-pc-windows-msvc\release\codex-plus-plus.exe"
    if (Test-Path -LiteralPath $localBuild -PathType Leaf) {
        $SourceBinary = $localBuild
    }
}
if (-not $SourceBinary -or -not (Test-Path -LiteralPath $SourceBinary -PathType Leaf)) {
    throw "The pinned CodexPlusPlus release binary is missing. Set ANTICODEX_CODEXPLUSPLUS_BINARY or pass -SourceBinary."
}

$resolvedSourceBinary = [IO.Path]::GetFullPath($SourceBinary)
$actualHash = (Get-FileHash -LiteralPath $resolvedSourceBinary -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
    throw "CodexPlusPlus binary SHA256 mismatch. Expected $expectedHash but found $actualHash."
}

$verifiedPatches = @()
$metadataRoot = Split-Path -Parent $sourceMetadata
foreach ($patch in @($metadata.patches)) {
    $patchPath = Join-Path $metadataRoot ([string]$patch.file)
    if (Test-Path -LiteralPath $patchPath -PathType Leaf) {
        $patchHash = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($patchHash -ne ([string]$patch.sha256).ToLowerInvariant()) {
            throw "CodexPlusPlus patch SHA256 mismatch: $($patch.file)"
        }
        $verifiedPatches += [ordered]@{
            file = [string]$patch.file
            sha256 = $patchHash
        }
    } elseif ($sourceMetadata -ne $destinationMetadata) {
        throw "CodexPlusPlus patch is missing: $patchPath"
    } else {
        $verifiedPatches += [ordered]@{
            file = [string]$patch.file
            sha256 = ([string]$patch.sha256).ToLowerInvariant()
        }
    }
}

$result = [ordered]@{
    ok = $true
    schema = "codexplusplus-component-manifest-v1"
    component = "CodexPlusPlus"
    license = "AGPL-3.0-only"
    version = [string]$metadata.version
    upstreamCommit = [string]$metadata.upstreamCommit
    isolationPatchCommit = [string]$metadata.isolationPatchCommit
    patchCommit = [string]$metadata.patchCommit
    binary = [ordered]@{
        path = "codex-plus-plus.exe"
        sha256 = $actualHash
        length = [int64](Get-Item -LiteralPath $resolvedSourceBinary).Length
    }
    patches = $verifiedPatches
    verifyOnly = [bool]$VerifyOnly
}

if ($VerifyOnly) {
    $result | ConvertTo-Json -Depth 10
    exit 0
}

function Write-Utf8NoBomAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )
    $pending = "$Path.anticodex-pending"
    [IO.File]::WriteAllText($pending, $Text, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $pending -Destination $Path -Force
}

New-Item -ItemType Directory -Path $componentRoot -Force | Out-Null
if (-not $resolvedSourceBinary.Equals([IO.Path]::GetFullPath($destinationBinary), [StringComparison]::OrdinalIgnoreCase)) {
    $pendingBinary = "$destinationBinary.anticodex-pending"
    Remove-Item -LiteralPath $pendingBinary -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $resolvedSourceBinary -Destination $pendingBinary -Force
    $pendingHash = (Get-FileHash -LiteralPath $pendingBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($pendingHash -ne $expectedHash) {
        Remove-Item -LiteralPath $pendingBinary -Force -ErrorAction SilentlyContinue
        throw "CodexPlusPlus staged binary hash changed during copy."
    }
    Move-Item -LiteralPath $pendingBinary -Destination $destinationBinary -Force
}

$installedHash = (Get-FileHash -LiteralPath $destinationBinary -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installedHash -ne $expectedHash) {
    throw "Installed CodexPlusPlus binary hash verification failed."
}
Copy-Item -LiteralPath $sourceMetadata -Destination $destinationMetadata -Force
$notice = @"
CodexPlusPlus is a separately licensed AGPL-3.0-only component.
Upstream: $([string]$metadata.repository)
Version: $([string]$metadata.version)
Upstream commit: $([string]$metadata.upstreamCommit)
Accepted patched commit: $([string]$metadata.patchCommit)
Anti-Codex keeps this executable, metadata and state at a separate component boundary.
"@
Write-Utf8NoBomAtomic -Path $noticePath -Text $notice
$result.verifyOnly = $false
$result.installedAt = [DateTime]::UtcNow.ToString("o")
Write-Utf8NoBomAtomic -Path $manifestPath -Text (($result | ConvertTo-Json -Depth 10) + "`n")
$result | ConvertTo-Json -Depth 10
