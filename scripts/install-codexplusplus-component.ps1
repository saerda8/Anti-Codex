#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Anti-Codex"),
    [string]$SourceBinary = "",
    [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-AntiCodexSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $hasher.ComputeHash($stream)
        return [BitConverter]::ToString($hash).Replace("-", "")
    } finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Test-ExactJsonString {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string]$Expected
    )

    return $Value -is [string] -and $Value -ceq $Expected
}

function Assert-JsonString {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
        throw "CodexPlusPlus metadata $Name must be a non-empty string."
    }
}

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
$requiredMetadataStrings = [ordered]@{
    component = $metadata.component
    repository = $metadata.repository
    license = $metadata.license
    version = $metadata.version
    tag = $metadata.tag
    upstreamCommit = $metadata.upstreamCommit
    isolationPatchCommit = $metadata.isolationPatchCommit
    patchCommit = $metadata.patchCommit
    "verification.launcherReleaseBuild" = $metadata.verification.launcherReleaseBuild
}
foreach ($name in $requiredMetadataStrings.Keys) {
    Assert-JsonString -Value $requiredMetadataStrings[$name] -Name $name
}
if ($metadata.component -cne "CodexPlusPlus" -or $metadata.license -cne "AGPL-3.0-only") {
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
    $identityParts = @(
        [string]$metadata.version,
        [string]$metadata.upstreamCommit,
        [string]$metadata.patchCommit
    )
    if (@($identityParts | Where-Object {
        [string]::IsNullOrWhiteSpace($_) -or $_ -in @(".", "..") -or $_ -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    }).Count -eq 0) {
        $preparedCandidateRoot = Join-Path $expectedInstallRoot (
            "component-sources\codexplusplus\candidates\$($metadata.version)\$($metadata.upstreamCommit)\$($metadata.patchCommit)"
        )
        $preparedCandidateBinary = Join-Path $preparedCandidateRoot "codex-plus-plus.exe"
        $preparedCandidateMetadata = Join-Path $preparedCandidateRoot "upstream.proposed.json"
        $preparedCandidateReport = Join-Path $preparedCandidateRoot "candidate.json"
        if ((Test-Path -LiteralPath $preparedCandidateBinary -PathType Leaf) -and
            (Test-Path -LiteralPath $preparedCandidateMetadata -PathType Leaf) -and
            (Test-Path -LiteralPath $preparedCandidateReport -PathType Leaf)) {
            try {
                $proposed = [IO.File]::ReadAllText(
                    $preparedCandidateMetadata,
                    [Text.Encoding]::UTF8
                ) | ConvertFrom-Json
                $candidateReport = [IO.File]::ReadAllText(
                    $preparedCandidateReport,
                    [Text.Encoding]::UTF8
                ) | ConvertFrom-Json
                $prepareCandidateScript = Join-Path $PSScriptRoot "prepare-codexplusplus-candidate.ps1"
                $isolationAudit = Join-Path $PSScriptRoot "test-codexplusplus-isolation-compatibility.mjs"
                $managedCargoRunner = Join-Path $PSScriptRoot "invoke-anticodex-cargo-xwin.ps1"
                $hygieneVerifier = Join-Path $PSScriptRoot "test-anticodex-docker-build-hygiene.ps1"
                foreach ($inputPath in @(
                    $prepareCandidateScript,
                    $isolationAudit,
                    $managedCargoRunner,
                    $hygieneVerifier
                )) {
                    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
                        throw "Prepared-candidate verifier input is missing: $inputPath"
                    }
                }
                $runnerText = [IO.File]::ReadAllText($managedCargoRunner, [Text.Encoding]::UTF8)
                $runnerImageMatch = [regex]::Match(
                    $runnerText,
                    '(?m)^\s*\$image\s*=\s*"(?<value>[^"]+)"\s*$'
                )
                if (-not $runnerImageMatch.Success) {
                    throw "Prepared-candidate runner has no fixed image identity."
                }
                $responseHistoryPatchFile = "patches/0013-v171-response-history.patch"
                $parsedCandidateVersion = $null
                $hasNumericVersion = [Version]::TryParse([string]$metadata.version, [ref]$parsedCandidateVersion)
                $hasResponseHistoryPatch = @($metadata.patches | Where-Object {
                    $_.file -is [string] -and $_.file -ceq $responseHistoryPatchFile
                }).Count -gt 0 -or ($hasNumericVersion -and $parsedCandidateVersion -ge [Version]"1.11.2")
                $protocolTest = "test --locked -p codex-plus-core --test protocol_proxy -- --test-threads=2"
                $watcherTest = "test --locked -p codex-plus-core --test watcher -- --test-threads=2"
                if ($hasNumericVersion -and $parsedCandidateVersion -ge [Version]"2.2.0") {
                    $protocolTest = "test --locked -p codex-plus-core --test all protocol_proxy:: -- --test-threads=2"
                    $watcherTest = "test --locked -p codex-plus-core --test all watcher:: -- --test-threads=2"
                }
                $expectedBuildCommands = @(
                    "fmt --all -- --check",
                    $protocolTest
                )
                if ($hasResponseHistoryPatch) {
                    $expectedBuildCommands += "test --locked -p codex-plus-core --test response_history -- --test-threads=2"
                    $expectedBuildCommands += "test --locked -p codex-plus-core --lib response_history -- --test-threads=1"
                    $expectedBuildCommands += "test --locked -p codex-plus-core --lib proxy_stream_tests -- --test-threads=1"
                    $expectedBuildCommands += "test --locked -p codex-plus-core --lib launcher::tests:: -- --test-threads=1"
                }
                if ($hasNumericVersion -and $parsedCandidateVersion -ge [Version]"2.2.0") {
                    $expectedBuildCommands += "test --locked -p codex-plus-core --lib anticodex_ -- --test-threads=1"
                }
                $expectedBuildCommands += @(
                    $watcherTest,
                    "xwin check --locked --release --target x86_64-pc-windows-msvc -p codex-plus-manager",
                    "xwin build --locked --release --target x86_64-pc-windows-msvc -p codex-plus-launcher"
                )
                $reportedBuildCommands = @($candidateReport.build.commands)
                $buildCommandsMatch = $reportedBuildCommands.Count -eq $expectedBuildCommands.Count
                if ($buildCommandsMatch) {
                    for ($index = 0; $index -lt $expectedBuildCommands.Count; $index += 1) {
                        if (-not (Test-ExactJsonString -Value $reportedBuildCommands[$index] -Expected $expectedBuildCommands[$index])) {
                            $buildCommandsMatch = $false
                            break
                        }
                    }
                }
                $proposedPatches = @($proposed.patches)
                $acceptedPatches = @($metadata.patches)
                $patchesMatch = $proposedPatches.Count -eq $acceptedPatches.Count
                if ($patchesMatch) {
                    for ($index = 0; $index -lt $acceptedPatches.Count; $index += 1) {
                        if (-not (Test-ExactJsonString -Value $proposedPatches[$index].file -Expected $acceptedPatches[$index].file) -or
                            -not (Test-ExactJsonString -Value $proposedPatches[$index].sha256 -Expected $acceptedPatches[$index].sha256) -or
                            -not (Test-ExactJsonString -Value $proposedPatches[$index].scope -Expected $acceptedPatches[$index].scope)) {
                            $patchesMatch = $false
                            break
                        }
                    }
                }
                $auditEntryHash = (Get-AntiCodexSha256 -Path $isolationAudit).ToLowerInvariant()
                $auditBundleMatches = $false
                $auditBundle = $candidateReport.inputs.isolationAudit.PSObject.Properties["bundleSha256"]
                if ($auditBundle) {
                    $expectedAuditBundle = $auditEntryHash
                    $auditDependency = Join-Path $PSScriptRoot "lib\codexplusplus-isolation-audit.mjs"
                    if (Test-Path -LiteralPath $auditDependency -PathType Leaf) {
                        $dependencyHash = (Get-AntiCodexSha256 -Path $auditDependency).ToLowerInvariant()
                        $bundleHasher = [Security.Cryptography.SHA256]::Create()
                        try {
                            $bundleBytes = [Text.Encoding]::UTF8.GetBytes("$auditEntryHash`n$dependencyHash")
                            $expectedAuditBundle = [BitConverter]::ToString($bundleHasher.ComputeHash($bundleBytes)).Replace("-", "").ToLowerInvariant()
                        } finally { $bundleHasher.Dispose() }
                    }
                    $auditBundleMatches = Test-ExactJsonString -Value $auditBundle.Value -Expected $expectedAuditBundle
                }
                $identityMatches = (
                    (Test-ExactJsonString -Value $proposed.component -Expected $metadata.component) -and
                    (Test-ExactJsonString -Value $proposed.repository -Expected $metadata.repository) -and
                    (Test-ExactJsonString -Value $proposed.license -Expected $metadata.license) -and
                    (Test-ExactJsonString -Value $proposed.version -Expected $metadata.version) -and
                    (Test-ExactJsonString -Value $proposed.tag -Expected $metadata.tag) -and
                    (Test-ExactJsonString -Value $proposed.upstreamCommit -Expected $metadata.upstreamCommit) -and
                    (Test-ExactJsonString -Value $proposed.isolationPatchCommit -Expected $metadata.isolationPatchCommit) -and
                    (Test-ExactJsonString -Value $proposed.patchCommit -Expected $metadata.patchCommit) -and
                    (Test-ExactJsonString -Value $proposed.verification.launcherReleaseBuild -Expected "sha256:$expectedHash") -and
                    $candidateReport.ok -is [bool] -and
                    $candidateReport.ok -eq $true -and
                    (Test-ExactJsonString -Value $candidateReport.schema -Expected "codexplusplus-candidate-v1") -and
                    (Test-ExactJsonString -Value $candidateReport.version -Expected $metadata.version) -and
                    (Test-ExactJsonString -Value $candidateReport.tag -Expected $metadata.tag) -and
                    (Test-ExactJsonString -Value $candidateReport.upstreamCommit -Expected $metadata.upstreamCommit) -and
                    (Test-ExactJsonString -Value $candidateReport.isolationPatchCommit -Expected $metadata.isolationPatchCommit) -and
                    (Test-ExactJsonString -Value $candidateReport.patchCommit -Expected $metadata.patchCommit) -and
                    (Test-ExactJsonString -Value $candidateReport.binary.sha256 -Expected $expectedHash) -and
                    (Test-ExactJsonString -Value $candidateReport.inputs.sourceMetadata.path -Expected "upstream.input.json") -and
                    $candidateReport.inputs.sourceMetadata.sha256 -is [string] -and
                    $candidateReport.inputs.sourceMetadata.sha256 -match '^[0-9a-f]{64}$' -and
                    (Test-ExactJsonString -Value $candidateReport.inputs.prepareScript.path -Expected "scripts/prepare-codexplusplus-candidate.ps1") -and
                    (Test-ExactJsonString -Value $candidateReport.inputs.prepareScript.sha256 -Expected (Get-AntiCodexSha256 -Path $prepareCandidateScript).ToLowerInvariant()) -and
                    (Test-ExactJsonString -Value $candidateReport.inputs.isolationAudit.path -Expected "scripts/test-codexplusplus-isolation-compatibility.mjs") -and
                    (Test-ExactJsonString -Value $candidateReport.inputs.isolationAudit.sha256 -Expected $auditEntryHash) -and
                    $auditBundleMatches -and
                    (Test-ExactJsonString -Value $candidateReport.inputs.managedCargoRunner.path -Expected "scripts/invoke-anticodex-cargo-xwin.ps1") -and
                    (Test-ExactJsonString -Value $candidateReport.inputs.managedCargoRunner.sha256 -Expected (Get-AntiCodexSha256 -Path $managedCargoRunner).ToLowerInvariant()) -and
                    (Test-ExactJsonString -Value $candidateReport.inputs.hygieneVerifier.path -Expected "scripts/test-anticodex-docker-build-hygiene.ps1") -and
                    (Test-ExactJsonString -Value $candidateReport.inputs.hygieneVerifier.sha256 -Expected (Get-AntiCodexSha256 -Path $hygieneVerifier).ToLowerInvariant()) -and
                    (Test-ExactJsonString -Value $candidateReport.build.runnerImage -Expected $runnerImageMatch.Groups["value"].Value) -and
                    $candidateReport.build.lockedDependencies -is [bool] -and
                    $candidateReport.build.lockedDependencies -eq $true -and
                    $buildCommandsMatch -and
                    $patchesMatch
                )
                if ($identityMatches) {
                    $sourceCandidates.Add($preparedCandidateBinary)
                }
            } catch {
                # An untrusted or incomplete prepared candidate is simply ineligible.
            }
        }
    }
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
    $candidateHash = (Get-AntiCodexSha256 -Path $resolvedCandidate).ToLowerInvariant()
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
    if ($patch.file -isnot [string] -or $patch.sha256 -isnot [string] -or
        $patch.scope -isnot [string]) {
        throw "CodexPlusPlus patch identity fields must be strings."
    }
    $relativePatch = $patch.file
    if (-not $relativePatch -or [IO.Path]::IsPathRooted($relativePatch)) {
        throw "CodexPlusPlus patch path is invalid: $relativePatch"
    }
    $patchPath = [IO.Path]::GetFullPath((Join-Path $metadataRoot $relativePatch))
    if (-not $patchPath.StartsWith("$resolvedMetadataRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
        throw "CodexPlusPlus patch escapes the trusted metadata root: $relativePatch"
    }
    if (Test-Path -LiteralPath $patchPath -PathType Leaf) {
        $patchHash = (Get-AntiCodexSha256 -Path $patchPath).ToLowerInvariant()
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
    backupCleanupWarning = $null
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
$activationCommitted = $false
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
    $stagedHash = (Get-AntiCodexSha256 -Path $stagingBinary).ToLowerInvariant()
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

    if ((Get-AntiCodexSha256 -Path $stagingBinary).ToLowerInvariant() -ne $expectedHash) {
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
    $installedHash = (Get-AntiCodexSha256 -Path $destinationBinary).ToLowerInvariant()
    if ($installedHash -ne $expectedHash) {
        throw "Installed CodexPlusPlus binary hash verification failed."
    }
    $installedMetadataRaw = [IO.File]::ReadAllText($destinationMetadata, [Text.Encoding]::UTF8)
    if ($installedMetadataRaw -cne $metadataRaw) {
        throw "Installed CodexPlusPlus metadata does not match the verified snapshot."
    }
    $null = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $activationCommitted = $true

    if ($oldMoved) {
        try {
            Assert-NoInstallReparsePoint -Path $backupComponent
            Remove-Item -LiteralPath $backupComponent -Recurse -Force
            $oldMoved = $false
        } catch {
            $result.backupCleanupWarning = "Verified new component remains active; old backup cleanup failed: $($_.Exception.Message)"
        }
    }
} catch {
    $installError = $_
    if ($activationCommitted) {
        throw $installError
    }
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
