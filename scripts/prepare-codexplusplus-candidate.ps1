#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Tag,

    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA "Anti-Codex\component-sources\codexplusplus")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$metadataPath = Join-Path $projectRoot "third_party\codexplusplus\upstream.json"
$isolationAuditPath = Join-Path $PSScriptRoot "test-codexplusplus-isolation-compatibility.mjs"
$managedCargoRunner = Join-Path $PSScriptRoot "invoke-anticodex-cargo-xwin.ps1"
$hygieneVerifier = Join-Path $PSScriptRoot "test-anticodex-docker-build-hygiene.ps1"
$candidateReportName = "candidate.json"
$proposedMetadataName = "upstream.proposed.json"

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][string]$Value)

    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
}

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $pending = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).pending"
    try {
        [IO.File]::WriteAllText(
            $pending,
            (($Value | ConvertTo-Json -Depth 20) + "`n"),
            [Text.UTF8Encoding]::new($false)
        )
        [void]([IO.File]::ReadAllText($pending, [Text.Encoding]::UTF8) | ConvertFrom-Json)
        Move-Item -LiteralPath $pending -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $pending -PathType Leaf) {
            Remove-Item -LiteralPath $pending -Force
        }
    }
}

function Remove-DirectoryTree {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $deletePath = if ($fullPath.StartsWith("\\")) {
        "\\?\UNC\" + $fullPath.TrimStart("\")
    } else {
        "\\?\$fullPath"
    }
    for ($attempt = 1; $attempt -le 30; $attempt += 1) {
        if (-not (Test-Path -LiteralPath $fullPath)) {
            return
        }
        try {
            foreach ($file in [IO.Directory]::EnumerateFiles(
                $deletePath,
                "*",
                [IO.SearchOption]::AllDirectories
            )) {
                $attributes = [IO.File]::GetAttributes($file)
                if (($attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
                    [IO.File]::SetAttributes(
                        $file,
                        ($attributes -band (-bnot [IO.FileAttributes]::ReadOnly))
                    )
                }
            }
            [IO.Directory]::Delete($deletePath, $true)
        } catch {
            if (-not (Test-Path -LiteralPath $fullPath)) {
                return
            }
            if ($attempt -eq 30) {
                throw
            }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Name
    )

    Push-Location -LiteralPath $WorkingDirectory
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $resolvedCommand = Get-Command -Name $FilePath -CommandType Application -ErrorAction Stop |
            Select-Object -First 1
        $commandPath = $resolvedCommand.Path
        $output = & $commandPath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
        $output = @($output)
    } finally {
        $ErrorActionPreference = $previousErrorAction
        Pop-Location
    }
    if ($exitCode -ne 0) {
        $detail = ($output | ForEach-Object { [string]$_ }) -join "`n"
        throw "$Name failed to start or exited with code $exitCode.`n$detail"
    }
    return (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

function Assert-File {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file is missing: $Path"
    }
}

function Test-ExactString {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string]$Expected
    )

    return $Value -is [string] -and $Value -ceq $Expected
}

function Assert-CandidateWindowsLaunchable {
    param(
        [Parameter(Mandatory = $true)][string]$BinaryPath,
        [Parameter(Mandatory = $true)][string]$ExpectedHash
    )

    if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
        throw "The CodexPlusPlus candidate disappeared before its Windows launch probe; security software may have quarantined it."
    }
    $probeState = Join-Path (Split-Path -Parent $BinaryPath) ("launch-probe-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $probeState -Force | Out-Null
    $process = $null
    try {
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $BinaryPath
        $startInfo.Arguments = "--helper-only --helper-port 0"
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.EnvironmentVariables["CODEX_PLUS_STATE_DIR"] = $probeState
        try {
            $process = [Diagnostics.Process]::Start($startInfo)
        } catch {
            $quarantineHint = if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
                " The candidate disappeared during process creation; security software may have quarantined it."
            } else {
                ""
            }
            throw "Windows refused to start the CodexPlusPlus candidate before publication: $($_.Exception.Message)$quarantineHint"
        }
        Start-Sleep -Milliseconds 300
    } finally {
        if ($process) {
            if (-not $process.HasExited) {
                try {
                    $process.Kill()
                } catch {
                    if (-not $process.HasExited) { throw }
                }
            }
            [void]$process.WaitForExit(5000)
            $process.Dispose()
        }
        if (Test-Path -LiteralPath $probeState) {
            Remove-DirectoryTree -Path $probeState
        }
    }

    if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
        throw "The CodexPlusPlus candidate disappeared during its Windows launch probe; security software may have quarantined it."
    }
    if ((Get-Sha256 -Path $BinaryPath) -cne $ExpectedHash) {
        throw "The CodexPlusPlus candidate hash changed during its Windows launch probe."
    }
}

function Get-ReusableCandidateReport {
    param(
        [Parameter(Mandatory = $true)][string]$CandidateRoot,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$Tag,
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$UpstreamCommit,
        [Parameter(Mandatory = $true)][string]$IsolationPatchCommit,
        [Parameter(Mandatory = $true)][string]$PatchCommit,
        [Parameter(Mandatory = $true)][string]$PatchTree,
        [Parameter(Mandatory = $true)][object[]]$Patches,
        [Parameter(Mandatory = $true)][string]$SourceMetadataHash,
        [Parameter(Mandatory = $true)][string]$PrepareScriptHash,
        [Parameter(Mandatory = $true)][string]$IsolationAuditHash,
        [Parameter(Mandatory = $true)][string]$ManagedCargoRunnerHash,
        [Parameter(Mandatory = $true)][string]$HygieneVerifierHash,
        [Parameter(Mandatory = $true)][string]$RunnerImage,
        [Parameter(Mandatory = $true)][string[]]$BuildCommands,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    $reportPath = Join-Path $CandidateRoot $candidateReportName
    $proposedPath = Join-Path $CandidateRoot $proposedMetadataName
    $binaryPath = Join-Path $CandidateRoot "codex-plus-plus.exe"
    $sourcePath = Join-Path $CandidateRoot "source"
    foreach ($required in @($reportPath, $proposedPath, $binaryPath)) {
        Assert-File -Path $required
    }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "Existing CodexPlusPlus candidate source is missing: $sourcePath"
    }

    $report = [IO.File]::ReadAllText($reportPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $proposed = [IO.File]::ReadAllText($proposedPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $binaryHash = Get-Sha256 -Path $binaryPath
    $binaryLength = [int64](Get-Item -LiteralPath $binaryPath).Length
    $sourceHead = Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $sourcePath, "rev-parse", "HEAD"
    ) -WorkingDirectory $WorkingDirectory -Name "Reusable candidate commit identity"
    $sourceTree = Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $sourcePath, "rev-parse", "HEAD^{tree}"
    ) -WorkingDirectory $WorkingDirectory -Name "Reusable candidate tree identity"
    $sourceStatus = Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $sourcePath, "status", "--porcelain", "--untracked-files=all"
    ) -WorkingDirectory $WorkingDirectory -Name "Reusable candidate source cleanliness"
    if ($sourceStatus) {
        throw "Existing CodexPlusPlus candidate source is not clean.`n$sourceStatus"
    }

    $identityMatches = (
        $report.ok -is [bool] -and $report.ok -eq $true -and
        (Test-ExactString -Value $report.schema -Expected "codexplusplus-candidate-v1") -and
        (Test-ExactString -Value $report.version -Expected $Version) -and
        (Test-ExactString -Value $report.tag -Expected $Tag) -and
        (Test-ExactString -Value $report.upstreamCommit -Expected $UpstreamCommit) -and
        (Test-ExactString -Value $report.isolationPatchCommit -Expected $IsolationPatchCommit) -and
        (Test-ExactString -Value $report.patchCommit -Expected $PatchCommit) -and
        (Test-ExactString -Value $report.patchTree -Expected $PatchTree) -and
        (Test-ExactString -Value $report.candidateRoot -Expected $CandidateRoot) -and
        (Test-ExactString -Value $report.binary.path -Expected "codex-plus-plus.exe") -and
        (Test-ExactString -Value $report.binary.sha256 -Expected $binaryHash) -and
        [int64]$report.binary.length -eq $binaryLength -and
        (Test-ExactString -Value $proposed.component -Expected "CodexPlusPlus") -and
        (Test-ExactString -Value $proposed.repository -Expected $Repository) -and
        (Test-ExactString -Value $proposed.license -Expected "AGPL-3.0-only") -and
        (Test-ExactString -Value $proposed.version -Expected $Version) -and
        (Test-ExactString -Value $proposed.tag -Expected $Tag) -and
        (Test-ExactString -Value $proposed.upstreamCommit -Expected $UpstreamCommit) -and
        (Test-ExactString -Value $proposed.isolationPatchCommit -Expected $IsolationPatchCommit) -and
        (Test-ExactString -Value $proposed.patchCommit -Expected $PatchCommit) -and
        (Test-ExactString -Value $proposed.verification.launcherReleaseBuild -Expected "sha256:$binaryHash") -and
        (Test-ExactString -Value $report.inputs.sourceMetadata.path -Expected "upstream.input.json") -and
        (Test-ExactString -Value $report.inputs.sourceMetadata.sha256 -Expected $SourceMetadataHash) -and
        (Test-ExactString -Value $report.inputs.prepareScript.path -Expected "scripts/prepare-codexplusplus-candidate.ps1") -and
        (Test-ExactString -Value $report.inputs.prepareScript.sha256 -Expected $PrepareScriptHash) -and
        (Test-ExactString -Value $report.inputs.isolationAudit.path -Expected "scripts/test-codexplusplus-isolation-compatibility.mjs") -and
        (Test-ExactString -Value $report.inputs.isolationAudit.sha256 -Expected $IsolationAuditHash) -and
        (Test-ExactString -Value $report.inputs.managedCargoRunner.path -Expected "scripts/invoke-anticodex-cargo-xwin.ps1") -and
        (Test-ExactString -Value $report.inputs.managedCargoRunner.sha256 -Expected $ManagedCargoRunnerHash) -and
        (Test-ExactString -Value $report.inputs.hygieneVerifier.path -Expected "scripts/test-anticodex-docker-build-hygiene.ps1") -and
        (Test-ExactString -Value $report.inputs.hygieneVerifier.sha256 -Expected $HygieneVerifierHash) -and
        (Test-ExactString -Value $report.build.runnerImage -Expected $RunnerImage) -and
        $report.build.lockedDependencies -is [bool] -and
        $report.build.lockedDependencies -eq $true -and
        $sourceHead -ceq $PatchCommit -and
        $sourceTree -ceq $PatchTree
    )
    if (-not $identityMatches -or
        @($report.patches).Count -ne $Patches.Count -or
        @($proposed.patches).Count -ne $Patches.Count -or
        @($report.build.commands).Count -ne $BuildCommands.Count) {
        throw "Existing CodexPlusPlus candidate does not match the requested verified identity."
    }

    for ($index = 0; $index -lt $Patches.Count; $index += 1) {
        $expected = $Patches[$index]
        $reported = @($report.patches)[$index]
        $proposedPatch = @($proposed.patches)[$index]
        if (-not (Test-ExactString -Value $reported.file -Expected $expected.file) -or
            -not (Test-ExactString -Value $reported.snapshot -Expected $expected.snapshot) -or
            -not (Test-ExactString -Value $reported.sha256 -Expected $expected.sha256) -or
            -not (Test-ExactString -Value $proposedPatch.file -Expected $expected.file) -or
            -not (Test-ExactString -Value $proposedPatch.sha256 -Expected $expected.sha256) -or
            -not (Test-ExactString -Value $proposedPatch.scope -Expected $expected.scope)) {
            throw "Existing CodexPlusPlus candidate patch identity does not match at index $index."
        }
        $snapshotPath = Join-Path $CandidateRoot $expected.snapshot
        Assert-File -Path $snapshotPath
        if ((Get-Sha256 -Path $snapshotPath) -cne $expected.sha256) {
            throw "Existing CodexPlusPlus candidate patch snapshot hash does not match at index $index."
        }
    }
    for ($index = 0; $index -lt $BuildCommands.Count; $index += 1) {
        if (-not (Test-ExactString -Value @($report.build.commands)[$index] -Expected $BuildCommands[$index])) {
            throw "Existing CodexPlusPlus candidate build command does not match at index $index."
        }
    }

    return $report
}

if ($Tag -notmatch '^v(?<version>0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw "Tag must be an exact stable semantic version such as v1.2.43."
}
$version = $Tag.Substring(1)
$resolvedStateRoot = [IO.Path]::GetFullPath($StateRoot)
$statePathRoot = [IO.Path]::GetPathRoot($resolvedStateRoot)
if ($resolvedStateRoot -eq $statePathRoot) {
    throw "StateRoot cannot be a filesystem root."
}
$resolvedStateRoot = $resolvedStateRoot.TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
)
$mutexHash = Get-TextSha256 -Value $resolvedStateRoot.ToLowerInvariant()
$candidateMutex = [Threading.Mutex]::new(
    $false,
    "Local\AntiCodexCodexPlusPlusCandidate-$($mutexHash.Substring(0, 32))"
)
$mutexAcquired = $false
$stagingRoot = Join-Path $resolvedStateRoot ("staging\" + [Guid]::NewGuid().ToString("N"))
$worktree = Join-Path $stagingRoot "source"
$stage = "preflight"
$completed = $false
$utf8 = [Text.UTF8Encoding]::new($false)

try {
    $stage = "candidate_lock"
    try {
        $mutexAcquired = $candidateMutex.WaitOne([TimeSpan]::FromHours(2))
    } catch [Threading.AbandonedMutexException] {
        $mutexAcquired = $true
    }
    if (-not $mutexAcquired) {
        throw "Timed out waiting for the CodexPlusPlus candidate preparation lock."
    }
    $stage = "preflight"
    foreach ($required in @($metadataPath, $isolationAuditPath, $managedCargoRunner, $hygieneVerifier)) {
        Assert-File -Path $required
    }
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

    $metadataSnapshot = Join-Path $stagingRoot "upstream.input.json"
    Copy-Item -LiteralPath $metadataPath -Destination $metadataSnapshot
    $metadataInputHash = Get-Sha256 -Path $metadataSnapshot
    $metadata = [IO.File]::ReadAllText($metadataSnapshot, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $prepareScriptHash = Get-Sha256 -Path $PSCommandPath
    $isolationAuditHash = Get-Sha256 -Path $isolationAuditPath
    $managedCargoRunnerHash = Get-Sha256 -Path $managedCargoRunner
    $hygieneVerifierHash = Get-Sha256 -Path $hygieneVerifier
    $managedCargoRunnerText = [IO.File]::ReadAllText($managedCargoRunner, [Text.Encoding]::UTF8)
    $runnerImageMatch = [regex]::Match(
        $managedCargoRunnerText,
        '(?m)^\s*\$image\s*=\s*"(?<value>[^"]+)"\s*$'
    )
    if (-not $runnerImageMatch.Success) {
        throw "Managed Cargo runner has no fixed image identity."
    }
    $runnerImage = $runnerImageMatch.Groups["value"].Value
    $commands = @(
        @("fmt", "--all", "--", "--check"),
        @("test", "--locked", "-p", "codex-plus-core", "--test", "protocol_proxy"),
        @("test", "--locked", "-p", "codex-plus-core", "--test", "watcher"),
        @("xwin", "check", "--locked", "--release", "--target", "x86_64-pc-windows-msvc", "-p", "codex-plus-manager"),
        @("xwin", "build", "--locked", "--release", "--target", "x86_64-pc-windows-msvc", "-p", "codex-plus-launcher")
    )
    $commandDescriptions = [Collections.Generic.List[string]]::new()
    foreach ($command in $commands) {
        $commandDescriptions.Add(($command -join " "))
    }
    if (-not (Test-ExactString -Value $metadata.component -Expected "CodexPlusPlus") -or
        -not (Test-ExactString -Value $metadata.license -Expected "AGPL-3.0-only")) {
        throw "CodexPlusPlus source metadata component/license must be exact strings."
    }
    if ($metadata.repository -isnot [string] -or [string]::IsNullOrWhiteSpace($metadata.repository)) {
        throw "CodexPlusPlus source metadata repository must be a non-empty string."
    }
    $repository = $metadata.repository

    $metadataRoot = Split-Path -Parent $metadataPath
    $metadataRootFull = [IO.Path]::GetFullPath($metadataRoot).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    $patches = @()
    $patchSnapshotRoot = Join-Path $stagingRoot "patches"
    New-Item -ItemType Directory -Path $patchSnapshotRoot -Force | Out-Null
    $patchIndex = 0
    foreach ($patch in @($metadata.patches)) {
        $patchIndex += 1
        if ($patch.file -isnot [string] -or $patch.sha256 -isnot [string] -or
            $patch.scope -isnot [string]) {
            throw "CodexPlusPlus patch identity fields must be strings at index $patchIndex."
        }
        $relativePatch = $patch.file
        if ([string]::IsNullOrWhiteSpace($relativePatch) -or [IO.Path]::IsPathRooted($relativePatch)) {
            throw "CodexPlusPlus patch path is invalid: $relativePatch"
        }
        $patchPath = [IO.Path]::GetFullPath((Join-Path $metadataRoot $relativePatch))
        if (-not $patchPath.StartsWith(
            "$metadataRootFull$([IO.Path]::DirectorySeparatorChar)",
            [StringComparison]::OrdinalIgnoreCase
        )) {
            throw "CodexPlusPlus patch escapes the trusted metadata root: $relativePatch"
        }
        Assert-File -Path $patchPath
        $patchSnapshotName = "{0:D4}-{1}" -f $patchIndex, (Split-Path -Leaf $relativePatch)
        $patchSnapshot = Join-Path $patchSnapshotRoot $patchSnapshotName
        Copy-Item -LiteralPath $patchPath -Destination $patchSnapshot
        $actualPatchHash = Get-Sha256 -Path $patchSnapshot
        if ($actualPatchHash -ne ([string]$patch.sha256).ToLowerInvariant()) {
            throw "CodexPlusPlus patch SHA256 mismatch: $relativePatch"
        }
        $patches += [ordered]@{
            file = $relativePatch
            path = $patchSnapshot
            snapshot = "patches/$patchSnapshotName"
            sha256 = $actualPatchHash
            scope = [string]$patch.scope
        }
    }
    if ($patches.Count -eq 0) {
        throw "CodexPlusPlus source metadata has no isolation patches."
    }

    $stage = "fetch_tag"
    [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-c", "core.hooksPath=NUL", "init", $worktree
    ) -WorkingDirectory $stagingRoot -Name "Candidate repository initialization")
    [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "config", "core.hooksPath", "NUL"
    ) -WorkingDirectory $stagingRoot -Name "Hook isolation")
    [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "config", "core.autocrlf", "false"
    ) -WorkingDirectory $stagingRoot -Name "Line-ending isolation")
    [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "config", "commit.gpgSign", "false"
    ) -WorkingDirectory $stagingRoot -Name "Commit-signing isolation")
    [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "config", "apply.whitespace", "nowarn"
    ) -WorkingDirectory $stagingRoot -Name "Patch whitespace isolation")
    [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "config", "user.name", "Anti-Codex Candidate"
    ) -WorkingDirectory $stagingRoot -Name "Candidate committer name")
    [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "config", "user.email", "anticodex-candidate@example.invalid"
    ) -WorkingDirectory $stagingRoot -Name "Candidate committer email")
    [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "remote", "add", "origin", $repository
    ) -WorkingDirectory $stagingRoot -Name "Candidate repository origin")
    [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "fetch", "--depth", "1", "--no-tags", "origin",
        "+refs/tags/${Tag}:refs/tags/${Tag}"
    ) -WorkingDirectory $stagingRoot -Name "Exact tag fetch")
    [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "checkout", "--detach", "refs/tags/$Tag"
    ) -WorkingDirectory $stagingRoot -Name "Exact tag checkout")
    $upstreamCommit = Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "rev-parse", "HEAD"
    ) -WorkingDirectory $stagingRoot -Name "Upstream commit identity"
    if ($upstreamCommit -notmatch '^[0-9a-f]{40}$') {
        throw "CodexPlusPlus upstream commit identity is invalid: $upstreamCommit"
    }

    $cargoManifestPath = Join-Path $worktree "Cargo.toml"
    Assert-File -Path $cargoManifestPath
    $cargoManifest = [IO.File]::ReadAllText($cargoManifestPath, [Text.Encoding]::UTF8)
    $workspacePackage = [regex]::Match(
        $cargoManifest,
        '(?ms)^\[workspace\.package\]\s*(?<body>.*?)(?=^\[|\z)'
    )
    $workspaceVersion = if ($workspacePackage.Success) {
        [regex]::Match($workspacePackage.Groups["body"].Value, '(?m)^\s*version\s*=\s*"(?<value>[^"]+)"\s*$')
    } else {
        $null
    }
    if (-not $workspaceVersion -or -not $workspaceVersion.Success -or
        $workspaceVersion.Groups["value"].Value -ne $version) {
        throw "CodexPlusPlus tag $Tag does not match the root workspace version $version."
    }

    $stage = "patch_replay"
    $firstPatchCommit = ""
    foreach ($patch in $patches) {
        [void](Invoke-Checked -FilePath "git.exe" -Arguments @(
            "-C", $worktree, "-c", "core.hooksPath=NUL", "am",
            "--no-3way", "--committer-date-is-author-date", $patch.path
        ) -WorkingDirectory $stagingRoot -Name "Patch replay $($patch.file)")
        $currentCommit = Invoke-Checked -FilePath "git.exe" -Arguments @(
            "-C", $worktree, "rev-parse", "HEAD"
        ) -WorkingDirectory $stagingRoot -Name "Patch commit identity"
        if (-not $firstPatchCommit) {
            $firstPatchCommit = $currentCommit
        }
    }
    $patchCommit = Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "rev-parse", "HEAD"
    ) -WorkingDirectory $stagingRoot -Name "Candidate commit identity"
    $patchTree = Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "rev-parse", "HEAD^{tree}"
    ) -WorkingDirectory $stagingRoot -Name "Candidate tree identity"
    $candidateRoot = Join-Path $resolvedStateRoot (
        "candidates\$version\$upstreamCommit\$patchCommit"
    )
    if (Test-Path -LiteralPath $candidateRoot -PathType Container) {
        $candidateComplete = (Test-Path -LiteralPath (Join-Path $candidateRoot "candidate.json") -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $candidateRoot "upstream.proposed.json") -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $candidateRoot "codex-plus-plus.exe") -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $candidateRoot "source") -PathType Container)
        if (-not $candidateComplete) {
            Remove-DirectoryTree -Path $candidateRoot
        } else {
            $stage = "candidate_reuse"
            $existingReport = Get-ReusableCandidateReport `
                -CandidateRoot $candidateRoot `
                -Version $version `
                -Tag $Tag `
                -Repository $repository `
                -UpstreamCommit $upstreamCommit `
                -IsolationPatchCommit $firstPatchCommit `
                -PatchCommit $patchCommit `
                -PatchTree $patchTree `
                -Patches $patches `
                -SourceMetadataHash $metadataInputHash `
                -PrepareScriptHash $prepareScriptHash `
                -IsolationAuditHash $isolationAuditHash `
                -ManagedCargoRunnerHash $managedCargoRunnerHash `
                -HygieneVerifierHash $hygieneVerifierHash `
                -RunnerImage $runnerImage `
                -BuildCommands @($commandDescriptions) `
                -WorkingDirectory $stagingRoot
            $stage = "candidate_launchability"
            Assert-CandidateWindowsLaunchable `
                -BinaryPath (Join-Path $candidateRoot "codex-plus-plus.exe") `
                -ExpectedHash ([string]$existingReport.binary.sha256)
            $existingReport | ConvertTo-Json -Depth 20
            return
        }
    }

    $stage = "isolation_audit"
    [void](Invoke-Checked -FilePath "node.exe" -Arguments @(
        $isolationAuditPath, "--source", $worktree, "--compact"
    ) -WorkingDirectory $projectRoot -Name "Isolation compatibility audit")

    $stage = "build_hygiene_preflight"
    [void](& $hygieneVerifier -RequireRuntimeClean)

    $stage = "verification"
    $managerDist = Join-Path $worktree "apps\codex-plus-manager\dist"
    $createdManagerDist = -not (Test-Path -LiteralPath $managerDist)
    if ($createdManagerDist) {
        New-Item -ItemType Directory -Path $managerDist -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $managerDist "index.html"), "<!doctype html>`n", $utf8)
    }
    $verificationFailure = $null
    try {
        foreach ($command in $commands) {
            try {
                & $managedCargoRunner -Worktree $worktree -CargoArguments $command
            } catch {
                if ($_.Exception.Message -notmatch 'cargo-xwin container exited with code -1$') {
                    throw
                }
                Start-Sleep -Seconds 1
                [void](& $managedCargoRunner -Worktree $worktree -CargoArguments $command)
            }
        }
    } catch {
        $verificationFailure = $_
    } finally {
        if ($createdManagerDist -and (Test-Path -LiteralPath $managerDist)) {
            Remove-DirectoryTree -Path $managerDist
        }
    }
    $stage = "build_hygiene_postflight"
    $postflightFailure = $null
    try {
        [void](& $hygieneVerifier -RequireRuntimeClean)
    } catch {
        $postflightFailure = $_
    }
    if ($verificationFailure) {
        $stage = "verification"
        $detail = $verificationFailure.Exception.Message
        if ($postflightFailure) {
            $detail += "`nBuild hygiene postflight also failed: $($postflightFailure.Exception.Message)"
        }
        throw $detail
    }
    if ($postflightFailure) {
        throw $postflightFailure
    }

    $builtBinary = Join-Path $worktree "target\x86_64-pc-windows-msvc\release\codex-plus-plus.exe"
    Assert-File -Path $builtBinary
    $builtBinaryHash = Get-Sha256 -Path $builtBinary
    $builtBinaryLength = [int64](Get-Item -LiteralPath $builtBinary).Length
    $stagedBinary = Join-Path $stagingRoot "codex-plus-plus.exe"
    Copy-Item -LiteralPath $builtBinary -Destination $stagedBinary
    $stage = "candidate_binary_copy"
    $binaryHash = Get-Sha256 -Path $stagedBinary
    $binaryLength = [int64](Get-Item -LiteralPath $stagedBinary).Length
    if ($binaryHash -cne $builtBinaryHash -or $binaryLength -ne $builtBinaryLength) {
        throw "CodexPlusPlus binary changed during candidate staging."
    }
    $stage = "candidate_launchability"
    Assert-CandidateWindowsLaunchable -BinaryPath $stagedBinary -ExpectedHash $binaryHash
    $targetRoot = Join-Path $worktree "target"
    if (Test-Path -LiteralPath $targetRoot) {
        Remove-DirectoryTree -Path $targetRoot
    }
    $sourceStatus = Invoke-Checked -FilePath "git.exe" -Arguments @(
        "-C", $worktree, "status", "--porcelain", "--untracked-files=all"
    ) -WorkingDirectory $stagingRoot -Name "Candidate source cleanliness"
    if ($sourceStatus) {
        throw "CodexPlusPlus candidate source is not clean after verification.`n$sourceStatus"
    }

    if (Test-Path -LiteralPath $candidateRoot) {
        throw "CodexPlusPlus candidate already exists: $candidateRoot"
    }

    $stage = "candidate_publish"
    $proposedMetadata = [ordered]@{
        component = "CodexPlusPlus"
        repository = $repository
        license = "AGPL-3.0-only"
        version = $version
        tag = $Tag
        upstreamCommit = $upstreamCommit
        isolationPatchCommit = $firstPatchCommit
        patchCommit = $patchCommit
        patches = @($patches | ForEach-Object {
            [ordered]@{
                file = $_.file
                sha256 = $_.sha256
                scope = $_.scope
            }
        })
        verification = [ordered]@{
            patchReplay = "$($patches.Count) project patches replayed without automatic conflict resolution; head $patchCommit; tree $patchTree"
            sourceIsolationAudit = "passed"
            auditRegressionTests = "Candidate-local format, protocol proxy, watcher, Manager and launcher checks passed; complete project regression and promotion preflight remain required before replacing accepted upstream.json."
            cargoFmt = "passed"
            cargoCheck = "protocol proxy and watcher tests passed; Windows x64 Manager check passed"
            windowsNativeTests = "Windows x64 release launcher build passed through the managed project runner"
            launcherReleaseBuild = "sha256:$binaryHash"
            runtimeIsolation = "candidate only; not activated"
        }
    }
    $report = [ordered]@{
        ok = $true
        schema = "codexplusplus-candidate-v1"
        version = $version
        tag = $Tag
        upstreamCommit = $upstreamCommit
        isolationPatchCommit = $firstPatchCommit
        patchCommit = $patchCommit
        patchTree = $patchTree
        patchCount = $patches.Count
        patches = @($patches | ForEach-Object {
            [ordered]@{
                file = $_.file
                snapshot = $_.snapshot
                sha256 = $_.sha256
            }
        })
        candidateRoot = $candidateRoot
        binary = [ordered]@{
            path = "codex-plus-plus.exe"
            sha256 = $binaryHash
            length = $binaryLength
        }
        inputs = [ordered]@{
            sourceMetadata = [ordered]@{
                path = "upstream.input.json"
                sha256 = $metadataInputHash
            }
            prepareScript = [ordered]@{
                path = "scripts/prepare-codexplusplus-candidate.ps1"
                sha256 = $prepareScriptHash
            }
            isolationAudit = [ordered]@{
                path = "scripts/test-codexplusplus-isolation-compatibility.mjs"
                sha256 = $isolationAuditHash
            }
            managedCargoRunner = [ordered]@{
                path = "scripts/invoke-anticodex-cargo-xwin.ps1"
                sha256 = $managedCargoRunnerHash
            }
            hygieneVerifier = [ordered]@{
                path = "scripts/test-anticodex-docker-build-hygiene.ps1"
                sha256 = $hygieneVerifierHash
            }
        }
        build = [ordered]@{
            runnerImage = $runnerImage
            lockedDependencies = $true
            commands = @($commandDescriptions)
        }
        checks = @(
            "exact_tag",
            "patch_hashes",
            "patch_replay",
            "isolation_audit",
            "cargo_fmt",
            "protocol_proxy",
            "watcher",
            "manager_windows_check",
            "launcher_windows_build",
            "windows_process_creation",
            "build_hygiene_preflight",
            "build_hygiene_postflight",
            "clean_source"
        )
        preparedAt = [DateTime]::UtcNow.ToString("o")
    }
    Write-JsonAtomic -Path (Join-Path $stagingRoot $proposedMetadataName) -Value $proposedMetadata
    Write-JsonAtomic -Path (Join-Path $stagingRoot $candidateReportName) -Value $report
    New-Item -ItemType Directory -Path (Split-Path -Parent $candidateRoot) -Force | Out-Null
    Move-Item -LiteralPath $stagingRoot -Destination $candidateRoot
    $completed = $true
    $report | ConvertTo-Json -Depth 20
} catch {
    $failure = [ordered]@{
        ok = $false
        schema = "codexplusplus-candidate-failure-v1"
        tag = $Tag
        stage = $stage
        error = $_.Exception.Message
        failedAt = [DateTime]::UtcNow.ToString("o")
    }
    $failureRoot = Join-Path $resolvedStateRoot "failures"
    Write-JsonAtomic -Path (Join-Path $failureRoot "latest.json") -Value $failure
    Write-JsonAtomic -Path (Join-Path $failureRoot ("$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ'))-$([Guid]::NewGuid().ToString('N')).json")) -Value $failure
    throw
} finally {
    if (-not $completed -and (Test-Path -LiteralPath $stagingRoot)) {
        Remove-DirectoryTree -Path $stagingRoot
    }
    if ($mutexAcquired) {
        $candidateMutex.ReleaseMutex()
    }
    $candidateMutex.Dispose()
}
