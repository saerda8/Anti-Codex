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
$componentsRoot = Join-Path $resolvedInstallRoot "components"
$destinationBinary = Join-Path $componentRoot "codex-plus-plus.exe"
$destinationMetadata = Join-Path $componentRoot "upstream.json"
$manifestPath = Join-Path $componentRoot "component-manifest.json"
$noticePath = Join-Path $componentRoot "LICENSE-NOTICE.txt"
$sourceRoot = Split-Path -Parent $PSScriptRoot
$sourceMetadata = Join-Path $sourceRoot "third_party\codexplusplus\upstream.json"
if (-not (Test-Path -LiteralPath $sourceMetadata -PathType Leaf)) {
    throw "Trusted CodexPlusPlus source metadata is missing: third_party\codexplusplus\upstream.json"
}

$metadataRaw = [IO.File]::ReadAllText($sourceMetadata, [Text.Encoding]::UTF8)
$metadata = $metadataRaw | ConvertFrom-Json
if ([string]$metadata.component -ne "CodexPlusPlus" -or [string]$metadata.license -ne "AGPL-3.0-only") {
    throw "CodexPlusPlus metadata component/license is invalid."
}
$expectedHash = ([string]$metadata.verification.launcherReleaseBuild).Replace("sha256:", "").ToLowerInvariant()
if ($expectedHash -notmatch '^[0-9a-f]{64}$') {
    throw "CodexPlusPlus metadata does not contain a valid release binary hash."
}

$explicitSourceBinary = [bool]$SourceBinary
if (-not $SourceBinary -and $env:ANTICODEX_CODEXPLUSPLUS_BINARY) {
    $SourceBinary = [string]$env:ANTICODEX_CODEXPLUSPLUS_BINARY
    $explicitSourceBinary = $true
}

$sourceCandidates = New-Object System.Collections.Generic.List[string]
if ($SourceBinary) {
    $sourceCandidates.Add([string]$SourceBinary)
} else {
    $sourceCandidates.Add($destinationBinary)
    $activeBinary = Join-Path $expectedInstallRoot "components\codexplusplus\codex-plus-plus.exe"
    $sourceCandidates.Add($activeBinary)
    $localBuild = Join-Path $env:LOCALAPPDATA "Temp\CodexPlusPlus-analysis-20260714\target\x86_64-pc-windows-msvc\release\codex-plus-plus.exe"
    $sourceCandidates.Add($localBuild)
}

$resolvedSourceBinary = ""
$actualHash = ""
$rejectedSourceHashes = @()
$seenSourceCandidates = @{}
foreach ($candidate in $sourceCandidates) {
    if (-not $candidate) { continue }
    $resolvedCandidate = [IO.Path]::GetFullPath([string]$candidate)
    $candidateKey = $resolvedCandidate.ToLowerInvariant()
    if ($seenSourceCandidates.ContainsKey($candidateKey)) { continue }
    $seenSourceCandidates[$candidateKey] = $true
    if (-not (Test-Path -LiteralPath $resolvedCandidate -PathType Leaf)) { continue }
    $candidateHash = (Get-FileHash -LiteralPath $resolvedCandidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($candidateHash -eq $expectedHash) {
        $resolvedSourceBinary = $resolvedCandidate
        $actualHash = $candidateHash
        break
    }
    $rejectedSourceHashes += "$resolvedCandidate=$candidateHash"
    if ($explicitSourceBinary) {
        throw "CodexPlusPlus binary SHA256 mismatch. Expected $expectedHash but found $candidateHash."
    }
}
if (-not $resolvedSourceBinary) {
    $detail = if ($rejectedSourceHashes.Count -gt 0) { " Checked mismatched candidates: $($rejectedSourceHashes -join '; ')." } else { "" }
    throw "The pinned CodexPlusPlus release binary is missing. Set ANTICODEX_CODEXPLUSPLUS_BINARY or pass -SourceBinary.$detail"
}

$verifiedPatches = @()
$metadataRoot = Split-Path -Parent $sourceMetadata
$resolvedMetadataRoot = [IO.Path]::GetFullPath($metadataRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
foreach ($patch in @($metadata.patches)) {
    $relativePatch = [string]$patch.file
    if (-not $relativePatch -or [IO.Path]::IsPathRooted($relativePatch)) {
        throw "CodexPlusPlus patch path is invalid: $relativePatch"
    }
    $patchPath = [IO.Path]::GetFullPath((Join-Path $metadataRoot $relativePatch))
    if (-not $patchPath.StartsWith("$resolvedMetadataRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
        throw "CodexPlusPlus patch escapes the trusted metadata root: $relativePatch"
    }
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

function Assert-NoInstallReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    $root = $expectedInstallRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $insideRoot = $full.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
        $full.StartsWith("$root$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)
    if (-not $insideRoot) {
        throw "Refusing CodexPlusPlus component path outside the fixed Anti-Codex root: $full"
    }

    $cursor = $full
    while ($cursor.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing CodexPlusPlus component path through a reparse point: $cursor"
            }
        }
        if ($cursor.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent.Equals($cursor, [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $parent
    }
}

$transactionId = [Guid]::NewGuid().ToString("N")
$stagingComponent = Join-Path $componentsRoot "codexplusplus.anticodex-staging-$transactionId"
$backupComponent = Join-Path $componentsRoot "codexplusplus.anticodex-backup-$transactionId"
$stagingBinary = Join-Path $stagingComponent "codex-plus-plus.exe"
$stagingMetadata = Join-Path $stagingComponent "upstream.json"
$stagingManifest = Join-Path $stagingComponent "component-manifest.json"
$stagingNotice = Join-Path $stagingComponent "LICENSE-NOTICE.txt"
$oldMoved = $false
$newActivated = $false
$installMutex = New-Object Threading.Mutex($false, "Local\AntiCodexCodexPlusPlusInstall")
$installMutexOwned = $false

try {
    if (-not $installMutex.WaitOne(0)) {
        throw "Another CodexPlusPlus component installation is already running."
    }
    $installMutexOwned = $true

    Assert-NoInstallReparsePoint -Path $expectedInstallRoot
    if (-not (Test-Path -LiteralPath $expectedInstallRoot)) {
        New-Item -ItemType Directory -Path $expectedInstallRoot | Out-Null
    }
    Assert-NoInstallReparsePoint -Path $expectedInstallRoot
    Assert-NoInstallReparsePoint -Path $resolvedInstallRoot
    if (-not (Test-Path -LiteralPath $resolvedInstallRoot)) {
        New-Item -ItemType Directory -Path $resolvedInstallRoot | Out-Null
    }
    Assert-NoInstallReparsePoint -Path $resolvedInstallRoot
    Assert-NoInstallReparsePoint -Path $componentsRoot
    if (-not (Test-Path -LiteralPath $componentsRoot)) {
        New-Item -ItemType Directory -Path $componentsRoot | Out-Null
    }
    Assert-NoInstallReparsePoint -Path $componentsRoot
    Assert-NoInstallReparsePoint -Path $componentRoot
    foreach ($componentPath in @($destinationBinary, $destinationMetadata, $manifestPath, $noticePath)) {
        Assert-NoInstallReparsePoint -Path $componentPath
    }

    Assert-NoInstallReparsePoint -Path $stagingComponent
    Assert-NoInstallReparsePoint -Path $backupComponent
    New-Item -ItemType Directory -Path $stagingComponent -Force | Out-Null
    Assert-NoInstallReparsePoint -Path $stagingComponent

    Copy-Item -LiteralPath $resolvedSourceBinary -Destination $stagingBinary
    $stagedHash = (Get-FileHash -LiteralPath $stagingBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($stagedHash -ne $expectedHash) {
        throw "CodexPlusPlus staged binary hash changed during copy."
    }
    $result.binary.length = [int64](Get-Item -LiteralPath $stagingBinary).Length
    Write-Utf8NoBomAtomic -Path $stagingMetadata -Text $metadataRaw

    $notice = @"
CodexPlusPlus is a separately licensed AGPL-3.0-only component.
Upstream: $([string]$metadata.repository)
Version: $([string]$metadata.version)
Upstream commit: $([string]$metadata.upstreamCommit)
Accepted patched commit: $([string]$metadata.patchCommit)
Anti-Codex keeps this executable, metadata and state at a separate component boundary.
"@
    Write-Utf8NoBomAtomic -Path $stagingNotice -Text $notice
    $result.verifyOnly = $false
    $result.installedAt = [DateTime]::UtcNow.ToString("o")
    Write-Utf8NoBomAtomic -Path $stagingManifest -Text (($result | ConvertTo-Json -Depth 10) + "`n")

    if ((Get-FileHash -LiteralPath $stagingBinary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw "CodexPlusPlus staged component verification failed."
    }
    $stagedMetadataRaw = [IO.File]::ReadAllText($stagingMetadata, [Text.Encoding]::UTF8)
    if ($stagedMetadataRaw -cne $metadataRaw) {
        throw "CodexPlusPlus staged metadata does not match the verified snapshot."
    }
    $null = $stagedMetadataRaw | ConvertFrom-Json
    $null = [IO.File]::ReadAllText($stagingManifest, [Text.Encoding]::UTF8) | ConvertFrom-Json

    Assert-NoInstallReparsePoint -Path $componentRoot
    if (Test-Path -LiteralPath $componentRoot) {
        Move-Item -LiteralPath $componentRoot -Destination $backupComponent
        $oldMoved = $true
    }
    Move-Item -LiteralPath $stagingComponent -Destination $componentRoot
    $newActivated = $true

    Assert-NoInstallReparsePoint -Path $componentRoot
    $installedHash = (Get-FileHash -LiteralPath $destinationBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($installedHash -ne $expectedHash) {
        throw "Installed CodexPlusPlus binary hash verification failed."
    }
    $installedMetadataRaw = [IO.File]::ReadAllText($destinationMetadata, [Text.Encoding]::UTF8)
    if ($installedMetadataRaw -cne $metadataRaw) {
        throw "Installed CodexPlusPlus metadata does not match the verified snapshot."
    }
    $null = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json

    if ($oldMoved) {
        Assert-NoInstallReparsePoint -Path $backupComponent
        Remove-Item -LiteralPath $backupComponent -Recurse -Force
        $oldMoved = $false
    }
} catch {
    $installError = $_
    if ($newActivated -and (Test-Path -LiteralPath $componentRoot)) {
        Assert-NoInstallReparsePoint -Path $componentRoot
        Remove-Item -LiteralPath $componentRoot -Recurse -Force
        $newActivated = $false
    }
    if ($oldMoved -and (Test-Path -LiteralPath $backupComponent)) {
        Assert-NoInstallReparsePoint -Path $backupComponent
        Move-Item -LiteralPath $backupComponent -Destination $componentRoot
        $oldMoved = $false
    }
    throw $installError
} finally {
    try {
        if (Test-Path -LiteralPath $stagingComponent) {
            Assert-NoInstallReparsePoint -Path $stagingComponent
            Remove-Item -LiteralPath $stagingComponent -Recurse -Force
        }
    } finally {
        if ($installMutexOwned) {
            $installMutex.ReleaseMutex()
        }
        $installMutex.Dispose()
    }
}
$result | ConvertTo-Json -Depth 10
