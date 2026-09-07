#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = "",
    [string]$SourceRoot = "",
    [string]$StateRoot = "",
    [switch]$Prompt,
    [switch]$NoPersist,
    [switch]$CheckRemoteComponents
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$expectedHostPatchRevision = 7

if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA "Anti-Codex" }
if (-not $StateRoot) { $StateRoot = Join-Path $env:APPDATA "anticodex" }

if ($PSVersionTable.PSEdition -eq "Core" -and -not $SourceRoot) {
    $windowsPowerShell = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
        throw "Windows PowerShell is required to query the installed Codex package: $windowsPowerShell"
    }
    $delegateArgs = @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-InstallRoot", $InstallRoot,
        "-StateRoot", $StateRoot
    )
    if ($Prompt) { $delegateArgs += "-Prompt" }
    if ($NoPersist) { $delegateArgs += "-NoPersist" }
    if ($CheckRemoteComponents) { $delegateArgs += "-CheckRemoteComponents" }
    $delegateOutput = & $windowsPowerShell @delegateArgs
    $delegateExitCode = $LASTEXITCODE
    if ($delegateExitCode -ne 0) {
        throw "Windows PowerShell update check exited with code $delegateExitCode."
    }
    $delegateOutput
    return
}

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$StateRoot = [IO.Path]::GetFullPath($StateRoot)
$updateStatusModule = Join-Path $PSScriptRoot "anticodex-update-status.psm1"
if (-not (Test-Path -LiteralPath $updateStatusModule -PathType Leaf)) {
    throw "Anti-Codex update status module is missing: $updateStatusModule"
}
Import-Module $updateStatusModule -Force
$expectedInstallRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
$allowTestRoot = [bool]$SourceRoot
if (-not $allowTestRoot -and $InstallRoot -ne $expectedInstallRoot) {
    throw "Anti-Codex update check may only inspect $expectedInstallRoot unless an explicit source root is supplied."
}

function Resolve-CodexDesktopHost {
    param([Parameter(Mandatory = $true)][string]$AppRoot)

    $chatGpt = Join-Path $AppRoot "ChatGPT.exe"
    if (Test-Path -LiteralPath $chatGpt -PathType Leaf) { return "ChatGPT.exe" }
    $codexHost = Join-Path $AppRoot "Codex.exe"
    if (Test-Path -LiteralPath $codexHost -PathType Leaf) { return "Codex.exe" }
    return $null
}

function Resolve-CodexSource {
    if ($SourceRoot) {
        $desktopHost = Resolve-CodexDesktopHost -AppRoot $SourceRoot
        if (-not $desktopHost) { return $null }
        return [pscustomobject]@{
            root = [IO.Path]::GetFullPath($SourceRoot)
            packageVersion = $null
            packageName = "explicit"
            desktopHostName = $desktopHost
        }
    }
    $packages = @(
        foreach ($name in @("OpenAI.Codex", "OpenAI.Codex_8wekyb3d8bbwe")) {
            Get-AppxPackage -Name $name -ErrorAction SilentlyContinue
        }
    ) | Sort-Object Version -Descending
    foreach ($pkg in $packages) {
        $root = Join-Path $pkg.InstallLocation "app"
        $desktopHost = Resolve-CodexDesktopHost -AppRoot $root
        if ($desktopHost) {
            return [pscustomobject]@{
                root = [IO.Path]::GetFullPath($root)
                packageVersion = [string]$pkg.Version
                packageName = [string]$pkg.Name
                desktopHostName = $desktopHost
            }
        }
    }
    return $null
}

function Get-AntiCodexSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($stream)
        return [BitConverter]::ToString($hash).Replace("-", "")
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Get-OptionalHash {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return Get-AntiCodexSha256 -Path $Path
}

function Get-ObjectPropertyValue {
    param(
        [object]$InputObject,
        [string]$Name
    )
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-CodexPlusPlusPatchSet {
    param(
        [object]$ExpectedPatches,
        [object]$ActualPatches
    )

    $expected = @($ExpectedPatches)
    $actual = @($ActualPatches)
    if ($expected.Count -eq 0 -or $expected.Count -ne $actual.Count) {
        return $false
    }
    for ($index = 0; $index -lt $expected.Count; $index += 1) {
        $expectedPatch = $expected[$index]
        $actualPatch = $actual[$index]
        $expectedFile = Get-ObjectPropertyValue -InputObject $expectedPatch -Name "file"
        $actualFile = Get-ObjectPropertyValue -InputObject $actualPatch -Name "file"
        $expectedHash = Get-ObjectPropertyValue -InputObject $expectedPatch -Name "sha256"
        $actualHash = Get-ObjectPropertyValue -InputObject $actualPatch -Name "sha256"
        if ($expectedFile -isnot [string] -or $actualFile -isnot [string] -or
            $expectedHash -isnot [string] -or $actualHash -isnot [string] -or
            [string]::IsNullOrWhiteSpace($expectedFile) -or
            $expectedFile -cne $actualFile -or
            $expectedHash -notmatch '^[0-9a-fA-F]{64}$' -or
            $actualHash -notmatch '^[0-9a-fA-F]{64}$' -or
            $expectedHash.ToLowerInvariant() -cne $actualHash.ToLowerInvariant()) {
            return $false
        }
    }
    return $true
}

function Get-CodexPlusPlusRemoteRelease {
    param([object]$Metadata)

    $result = [ordered]@{
        remoteState = "failed"
        remoteTag = $null
        remoteVersion = $null
        remoteNewerThanProject = $null
        remoteCheckedAt = [DateTime]::UtcNow.ToString("o")
        remoteError = $null
    }
    $repository = [string](Get-ObjectPropertyValue -InputObject $Metadata -Name "repository")
    $projectVersion = ([string](Get-ObjectPropertyValue -InputObject $Metadata -Name "version")).Trim()
    if ([string]::IsNullOrWhiteSpace($repository) -or [string]::IsNullOrWhiteSpace($projectVersion)) {
        $result.remoteError = "component_metadata_unavailable"
        return [pscustomobject]$result
    }

    $repository = $repository.TrimEnd("/")
    if ($repository.EndsWith(".git", [StringComparison]::OrdinalIgnoreCase)) {
        $repository = $repository.Substring(0, $repository.Length - 4)
    }
    if ($repository -notmatch '^https://github\.com/[^/]+/[^/]+$') {
        $result.remoteError = "unsupported_component_repository"
        return [pscustomobject]$result
    }

    $curl = Join-Path ([Environment]::SystemDirectory) "curl.exe"
    if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) {
        $result.remoteError = "curl_unavailable"
        return [pscustomobject]$result
    }

    try {
        $wire = (@(& $curl --silent --show-error --head --location --connect-timeout 3 --max-time 8 --output NUL --write-out '%{url_effective}|%{http_code}' "$repository/releases/latest" 2>$null) -join "").Trim()
        if ($LASTEXITCODE -ne 0) { throw "curl_exit_$LASTEXITCODE" }
        $separator = $wire.LastIndexOf("|", [StringComparison]::Ordinal)
        if ($separator -lt 1) { throw "invalid_remote_response" }
        $effectiveUrl = $wire.Substring(0, $separator)
        $statusCode = $wire.Substring($separator + 1)
        $tagPrefix = "$repository/releases/tag/"
        if ($statusCode -ne "200" -or -not $effectiveUrl.StartsWith($tagPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "latest_release_unavailable"
        }
        $tag = [Uri]::UnescapeDataString($effectiveUrl.Substring($tagPrefix.Length))
        if ($tag -notmatch '^v?(\d+)\.(\d+)\.(\d+)$' -or $projectVersion -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') {
            throw "invalid_release_tag"
        }
        $remoteVersion = ([regex]::Match($tag, '^v?(\d+\.\d+\.\d+)$')).Groups[1].Value
        $pinnedVersion = ([regex]::Match($projectVersion, '^v?(\d+\.\d+\.\d+)$')).Groups[1].Value
        $comparison = ([version]$remoteVersion).CompareTo([version]$pinnedVersion)
        $result.remoteState = if ($comparison -gt 0) { "newer_available" } elseif ($comparison -eq 0) { "current" } else { "project_ahead" }
        $result.remoteTag = $tag
        $result.remoteVersion = $remoteVersion
        $result.remoteNewerThanProject = ($comparison -gt 0)
    } catch {
        $result.remoteError = $_.Exception.Message
    }
    return [pscustomobject]$result
}

function Read-ActiveHostManifest {
    param([string]$MarkerPath)
    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) { return $null }
    try {
        return Get-Content -LiteralPath $MarkerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Test-StaleRunningUpdateOperation {
    param(
        [object]$Operation,
        [int]$MaxAgeMinutes = 15
    )

    if ((Get-ObjectPropertyValue -InputObject $Operation -Name "state") -ne "running") {
        return $false
    }
    $updatedAtText = [string](Get-ObjectPropertyValue -InputObject $Operation -Name "updatedAt")
    if ([string]::IsNullOrWhiteSpace($updatedAtText)) {
        return $false
    }
    $updatedAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($updatedAtText, [ref]$updatedAt)) {
        return $false
    }
    return ([DateTimeOffset]::UtcNow - $updatedAt).TotalMinutes -ge $MaxAgeMinutes
}

function Test-StaleFailedUpdateOperation {
    param(
        [object]$Operation,
        [int]$MaxAgeMinutes = 15
    )

    if ((Get-ObjectPropertyValue -InputObject $Operation -Name "state") -ne "failed") {
        return $false
    }
    $updatedAtText = [string](Get-ObjectPropertyValue -InputObject $Operation -Name "updatedAt")
    if ([string]::IsNullOrWhiteSpace($updatedAtText)) {
        return $false
    }
    $updatedAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($updatedAtText, [ref]$updatedAt)) {
        return $false
    }
    return ([DateTimeOffset]::UtcNow - $updatedAt).TotalMinutes -ge $MaxAgeMinutes
}

function Test-AntiCodexIconPalette {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $bytes = [IO.File]::ReadAllBytes($Path)
        if ($bytes.Length -lt 22 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0 -or [BitConverter]::ToUInt16($bytes, 2) -ne 1) {
            return $false
        }
        $count = [BitConverter]::ToUInt16($bytes, 4)
        $best = $null
        for ($i = 0; $i -lt $count; $i += 1) {
            $entry = 6 + ($i * 16)
            $width = [int]$bytes[$entry]
            if ($width -eq 0) { $width = 256 }
            $size = [int][BitConverter]::ToUInt32($bytes, $entry + 8)
            $offset = [int][BitConverter]::ToUInt32($bytes, $entry + 12)
            if ($null -eq $best -or $width -gt $best.Width) {
                $best = [pscustomobject]@{ Width = $width; Size = $size; Offset = $offset }
            }
        }
        if ($null -eq $best -or $best.Offset -lt 0 -or ($best.Offset + $best.Size) -gt $bytes.Length) {
            return $false
        }

        $frame = New-Object byte[] $best.Size
        [Array]::Copy($bytes, $best.Offset, $frame, 0, $best.Size)
        $stream = New-Object IO.MemoryStream(,$frame)
        $image = [System.Drawing.Image]::FromStream($stream)
        $bitmap = New-Object System.Drawing.Bitmap $image
        try {
            $pinkBlob = 0
            $whiteCommand = 0
            $tealBackground = 0
            $oldBluePurple = 0
            $transparent = 0
            for ($y = 0; $y -lt $bitmap.Height; $y += 8) {
                for ($x = 0; $x -lt $bitmap.Width; $x += 8) {
                    $pixel = $bitmap.GetPixel($x, $y)
                    if ($pixel.A -lt 10) {
                        $transparent += 1
                        continue
                    }
                    if ($pixel.R -gt 205 -and $pixel.B -gt 135 -and $pixel.G -lt 165) { $pinkBlob += 1 }
                    if ($pixel.R -gt 230 -and $pixel.G -gt 230 -and $pixel.B -gt 230) { $whiteCommand += 1 }
                    if ($pixel.R -ge 30 -and $pixel.R -le 95 -and $pixel.G -ge 105 -and $pixel.G -le 170 -and $pixel.B -ge 120 -and $pixel.B -le 180) { $tealBackground += 1 }
                    if ($pixel.B -gt 185 -and $pixel.R -lt 190 -and $pixel.G -lt 185) { $oldBluePurple += 1 }
                }
            }
            return ($pinkBlob -ge 120 -and $whiteCommand -ge 10 -and $transparent -ge 100 -and $tealBackground -le 3 -and $oldBluePurple -le 10)
        } finally {
            $bitmap.Dispose()
            $image.Dispose()
            $stream.Dispose()
        }
    } catch {
        return $false
    }
}

function Test-ActiveHostGuardrails {
    param(
        [object]$Manifest,
        [string]$HostRoot,
        [string]$SourceHostHash,
        [string]$SourceCliHash
    )

    $failures = New-Object System.Collections.Generic.List[string]
    if ($null -eq $Manifest) {
        $failures.Add("active host marker is missing or unreadable") | Out-Null
    } else {
        $manifestSchema = [string](Get-ObjectPropertyValue -InputObject $Manifest -Name "schema")
        if ($manifestSchema -eq "anticodex-host-manifest-v1") {
            $failures.Add("active host requires unpacked file inventory migration") | Out-Null
        } elseif ($manifestSchema -ne "anticodex-host-manifest-v2") {
            $failures.Add("active host marker schema is invalid") | Out-Null
        }
        if ([string](Get-ObjectPropertyValue -InputObject $Manifest -Name "patchProfile") -ne "fixed-shell-v1") {
            $failures.Add("active host patch profile is invalid") | Out-Null
        }
        if ([string](Get-ObjectPropertyValue -InputObject $Manifest -Name "hostPatchRevision") -ne [string]$expectedHostPatchRevision) {
            $failures.Add("active host patch revision is not current") | Out-Null
        }
    }
    $manifestFiles = Get-ObjectPropertyValue -InputObject $Manifest -Name "files"
    $manifestSource = Get-ObjectPropertyValue -InputObject $Manifest -Name "source"
    if ($null -eq $manifestFiles) {
        $failures.Add("active host marker is missing file hashes") | Out-Null
    }
    if ($null -eq $manifestSource) {
        $failures.Add("active host marker is missing source fingerprints") | Out-Null
    }

    $required = [ordered]@{
        antiCodexExe = (Join-Path $HostRoot "Anti-Codex.exe")
        appAsar = (Join-Path $HostRoot "resources\app.asar")
        codexCli = (Join-Path $HostRoot "resources\codex.exe")
        sandboxHelper = (Join-Path $HostRoot "resources\codex-windows-sandbox-setup.exe")
        nodeRepl = (Join-Path $HostRoot "resources\cua_node\bin\node_repl.exe")
        nodeRuntime = (Join-Path $HostRoot "resources\cua_node\bin\node.exe")
        hostIcon = (Join-Path $HostRoot "resources\icon.ico")
        trayIcon = (Join-Path $HostRoot "resources\codex-tray.ico")
        appRootIcon = (Join-Path $HostRoot "icon.ico")
    }
    foreach ($name in $required.Keys) {
        $path = $required[$name]
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            $failures.Add("active host is missing $name") | Out-Null
            continue
        }
        if ($manifestFiles) {
            $actual = Get-AntiCodexSha256 -Path $path
            $recorded = Get-ObjectPropertyValue -InputObject $manifestFiles -Name $name
            if (-not $recorded -or [string]$recorded -ne [string]$actual) {
                $failures.Add("active host marker hash mismatch: $name") | Out-Null
            }
        }
    }

    $manifestSchema = [string](Get-ObjectPropertyValue -InputObject $Manifest -Name "schema")
    if ($manifestSchema -eq "anticodex-host-manifest-v2") {
        $recordedFilesValue = Get-ObjectPropertyValue -InputObject $Manifest -Name "unpackedFiles"
        $recordedFiles = @()
        if ($null -ne $recordedFilesValue) {
            $recordedFiles = @($recordedFilesValue)
        }
        if ($recordedFiles.Count -eq 0) {
            $failures.Add("active host requires unpacked file inventory migration") | Out-Null
        } else {
            try {
                $hostRootFull = [IO.Path]::GetFullPath($HostRoot).TrimEnd("\")
                $unpackedRoot = [IO.Path]::GetFullPath((Join-Path $hostRootFull "resources\app.asar.unpacked")).TrimEnd("\")
                $unpackedRootPrefix = "$unpackedRoot\"
                $recordedPaths = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
                foreach ($recordedFile in $recordedFiles) {
                    $relativePath = [string](Get-ObjectPropertyValue -InputObject $recordedFile -Name "path")
                    $recordedHash = [string](Get-ObjectPropertyValue -InputObject $recordedFile -Name "sha256")
                    $recordedSize = Get-ObjectPropertyValue -InputObject $recordedFile -Name "size"
                    if (-not $relativePath -or -not $recordedHash -or $null -eq $recordedSize -or [IO.Path]::IsPathRooted($relativePath)) {
                        $failures.Add("active host marker contains an invalid unpacked file entry") | Out-Null
                        continue
                    }
                    $unpackedFilePath = [IO.Path]::GetFullPath((Join-Path $hostRootFull $relativePath))
                    $unpackedFileAccessPath = "\\?\$unpackedFilePath"
                    if (-not $unpackedFilePath.StartsWith($unpackedRootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
                        -not [IO.File]::Exists($unpackedFileAccessPath)) {
                        $failures.Add("active host unpacked file is missing or outside app.asar.unpacked: $relativePath") | Out-Null
                        continue
                    }
                    if ([string](Get-AntiCodexSha256 -Path $unpackedFileAccessPath) -ne $recordedHash) {
                        $failures.Add("active host unpacked file hash mismatch: $relativePath") | Out-Null
                    }
                    if ([long](Get-Item -LiteralPath $unpackedFileAccessPath).Length -ne [long]$recordedSize) {
                        $failures.Add("active host unpacked file size mismatch: $relativePath") | Out-Null
                    }
                    if (-not $recordedPaths.Add($unpackedFilePath)) {
                        $failures.Add("active host marker repeats an unpacked file path: $relativePath") | Out-Null
                    }
                }
                $unpackedAccessRoot = "\\?\$unpackedRoot"
                if (-not [IO.Directory]::Exists($unpackedAccessRoot)) {
                    $failures.Add("active host unpacked resource directory is missing") | Out-Null
                } else {
                    $actualFiles = @(Get-ChildItem -LiteralPath $unpackedAccessRoot -File -Recurse -Force -ErrorAction Stop)
                    if ($actualFiles.Count -ne $recordedFiles.Count) {
                        $failures.Add("active host unpacked file inventory is incomplete") | Out-Null
                    }
                }
            } catch {
                $failures.Add("active host unpacked file inventory validation failed: $($_.Exception.Message)") | Out-Null
            }
        }
    }

    if ($manifestSource) {
        $recordedSourceHost = Get-ObjectPropertyValue -InputObject $manifestSource -Name "codexHost"
        $recordedSourceCli = Get-ObjectPropertyValue -InputObject $manifestSource -Name "codexCli"
        if ($SourceHostHash) {
            if (-not $recordedSourceHost) {
                $failures.Add("active source host fingerprint is missing") | Out-Null
            } elseif ([string]$recordedSourceHost -ne [string]$SourceHostHash) {
                $failures.Add("active source host fingerprint differs from installed Codex") | Out-Null
            }
        }
        if ($SourceCliHash) {
            if (-not $recordedSourceCli) {
                $failures.Add("active source CLI fingerprint is missing") | Out-Null
            } elseif ([string]$recordedSourceCli -ne [string]$SourceCliHash) {
                $failures.Add("active source CLI fingerprint differs from installed Codex") | Out-Null
            }
        }
        $recordedAntiCodexHost = Get-ObjectPropertyValue -InputObject $manifestFiles -Name "antiCodexExe"
        if (-not $recordedAntiCodexHost) {
            $failures.Add("active Anti-Codex.exe fingerprint is missing") | Out-Null
        } elseif ([string]$recordedAntiCodexHost -ne [string]$recordedSourceHost) {
            $integrity = Get-ObjectPropertyValue -InputObject $Manifest -Name "asarIntegrity"
            $desktopHostName = [string](Get-ObjectPropertyValue -InputObject $manifestSource -Name "desktopHostName")
            $sourceHostPath = if ($desktopHostName) { Join-Path $HostRoot $desktopHostName } else { "" }
            $helper = Join-Path $PSScriptRoot "electron-asar-integrity-host.mjs"
            $node = $required.nodeRuntime
            $originalHeaderHash = [string](Get-ObjectPropertyValue -InputObject $integrity -Name "originalHeaderHash")
            $patchedHeaderHash = [string](Get-ObjectPropertyValue -InputObject $integrity -Name "patchedHeaderHash")
            if (-not $sourceHostPath -or -not (Test-Path -LiteralPath $sourceHostPath -PathType Leaf) -or
                -not (Test-Path -LiteralPath $helper -PathType Leaf) -or
                -not (Test-Path -LiteralPath $node -PathType Leaf)) {
                $failures.Add("active Anti-Codex.exe ASAR integrity provenance is incomplete") | Out-Null
            } else {
                & $node $helper --verify $sourceHostPath $required.antiCodexExe $originalHeaderHash $patchedHeaderHash *> $null
                if ($LASTEXITCODE -ne 0) {
                    $failures.Add("active Anti-Codex.exe differs outside the isolated ASAR integrity hash") | Out-Null
                }
            }
        }
    }

    if (-not $SourceRoot) {
        foreach ($iconName in @("hostIcon", "trayIcon", "appRootIcon")) {
            if ((Test-Path -LiteralPath $required[$iconName] -PathType Leaf) -and (Test-AntiCodexIconPalette -Path $required[$iconName]) -ne $true) {
                $failures.Add("active host icon content is not the Anti-Codex artwork: $iconName") | Out-Null
            }
        }
    }

    [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        failures = $failures.ToArray()
    }
}

$source = Resolve-CodexSource
$activeRoot = Join-Path $InstallRoot "codex-patched-app"
$activeMarker = Join-Path $InstallRoot "codex-patched-app.ok"
$activeManifest = Read-ActiveHostManifest -MarkerPath $activeMarker
$sourceComponentMetadataPath = if (-not $allowTestRoot) { Join-Path (Split-Path -Parent $PSScriptRoot) "third_party\codexplusplus\upstream.json" } else { $null }
$sourceComponentMetadata = if ($sourceComponentMetadataPath) { Read-ActiveHostManifest -MarkerPath $sourceComponentMetadataPath } else { $null }
$activeComponentRoot = Join-Path $InstallRoot "components\codexplusplus"
$activeComponentManifestPath = Join-Path $activeComponentRoot "component-manifest.json"
$activeComponentBinaryPath = Join-Path $activeComponentRoot "codex-plus-plus.exe"
$activeComponentManifest = Read-ActiveHostManifest -MarkerPath $activeComponentManifestPath
$activeManifestSource = Get-ObjectPropertyValue -InputObject $activeManifest -Name "source"
$activePackageVersion = Get-ObjectPropertyValue -InputObject $activeManifestSource -Name "packageVersion"
$activeHostPatchRevision = Get-ObjectPropertyValue -InputObject $activeManifest -Name "hostPatchRevision"
$statusPath = Join-Path $StateRoot "update-status.json"
$existingStatus = Get-AntiCodexUpdateStatus -StateRoot $StateRoot
$existingOperation = $existingStatus.operation
$cachedStatus = $null
if (-not $NoPersist -and $source -and $source.packageVersion -and (Test-Path -LiteralPath $statusPath)) {
    $cachedStatus = $existingStatus
}
$sourceDesktopHost = if ($source) { $source.desktopHostName } else { $null }
$activeDesktopHost = if (Test-Path -LiteralPath $activeRoot) {
    foreach ($name in @("ChatGPT.exe", "Codex.exe")) {
        $candidate = Join-Path $activeRoot $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $name; break }
    }
} else { $null }
$sourceHostHash = if ($source -and $sourceDesktopHost) { Get-OptionalHash (Join-Path $source.root $sourceDesktopHost) } else { $null }
$sourceCliHash = if ($source) { Get-OptionalHash (Join-Path $source.root "resources\codex.exe") } else { $null }
$activeHostHash = if ($activeDesktopHost) { Get-OptionalHash (Join-Path $activeRoot $activeDesktopHost) } else { $null }
$activeCliHash = Get-OptionalHash (Join-Path $activeRoot "resources\codex.exe")
$activeGuardrails = Test-ActiveHostGuardrails -Manifest $activeManifest -HostRoot $activeRoot -SourceHostHash $sourceHostHash -SourceCliHash $sourceCliHash
$comparable = [bool]($sourceHostHash -and $sourceCliHash -and $activeHostHash -and $activeCliHash)
$hostChanged = [bool]($sourceHostHash -and $activeHostHash -and $sourceHostHash -ne $activeHostHash)
$cliChanged = [bool]($sourceCliHash -and $activeCliHash -and $sourceCliHash -ne $activeCliHash)
$packageVersionChanged = [bool](
    $source -and
    -not [string]::IsNullOrWhiteSpace([string]$source.packageVersion) -and
    [string]$source.packageVersion -ne [string]$activePackageVersion
)
$guardrailDrift = [bool]($source -and $comparable -and $activeGuardrails.ok -ne $true)
$sourceComponentVersion = Get-ObjectPropertyValue -InputObject $sourceComponentMetadata -Name "version"
$sourceComponentVerification = Get-ObjectPropertyValue -InputObject $sourceComponentMetadata -Name "verification"
$sourceComponentPatches = Get-ObjectPropertyValue -InputObject $sourceComponentMetadata -Name "patches"
$remoteComponentRelease = if ($CheckRemoteComponents) {
    Get-CodexPlusPlusRemoteRelease -Metadata $sourceComponentMetadata
} else {
    [pscustomobject]@{
        remoteState = "not_checked"
        remoteTag = $null
        remoteVersion = $null
        remoteNewerThanProject = $null
        remoteCheckedAt = $null
        remoteError = $null
    }
}
$sourceComponentHash = ([string](Get-ObjectPropertyValue -InputObject $sourceComponentVerification -Name "launcherReleaseBuild")).Replace("sha256:", "").ToLowerInvariant()
$activeComponentVersion = Get-ObjectPropertyValue -InputObject $activeComponentManifest -Name "version"
$activeComponentExpectedHash = ([string](Get-ObjectPropertyValue -InputObject (Get-ObjectPropertyValue -InputObject $activeComponentManifest -Name "binary") -Name "sha256")).ToLowerInvariant()
$activeComponentPatches = Get-ObjectPropertyValue -InputObject $activeComponentManifest -Name "patches"
$activeComponentActualHash = (Get-OptionalHash $activeComponentBinaryPath)
if ($activeComponentActualHash) { $activeComponentActualHash = $activeComponentActualHash.ToLowerInvariant() }
$componentPatchSetMatches = Test-CodexPlusPlusPatchSet -ExpectedPatches $sourceComponentPatches -ActualPatches $activeComponentPatches
$componentComparable = [bool]($sourceComponentVersion -and ($sourceComponentHash -match '^[0-9a-f]{64}$') -and @($sourceComponentPatches).Count -gt 0 -and $activeComponentVersion -and $activeComponentActualHash)
$componentDrift = [bool]($sourceComponentMetadata -and (
    -not $componentComparable -or
    [string]$sourceComponentVersion -ne [string]$activeComponentVersion -or
    $sourceComponentHash -ne $activeComponentActualHash -or
    $activeComponentExpectedHash -ne $activeComponentActualHash -or
    -not $componentPatchSetMatches
))
$updateNeeded = [bool]($comparable -and ($hostChanged -or $cliChanged -or $packageVersionChanged -or $guardrailDrift -or $componentDrift))
$driftState = if (-not $source -or -not $comparable) {
    "unknown"
} elseif ($updateNeeded) {
    "drifted"
} else {
    "synced"
}
$reason = if (-not $source) {
    "source_codex_not_found"
} elseif (-not $comparable) {
    "fingerprint_unavailable"
} elseif ($hostChanged -or $cliChanged) {
    "source_codex_changed"
} elseif ($componentDrift) {
    "codexplusplus_component_changed"
} elseif ($packageVersionChanged) {
    "source_package_version_changed"
} elseif ($cachedStatus -and
    $cachedStatus.ok -eq $true -and
    $cachedStatus.updateNeeded -eq $false -and
    [string]$cachedStatus.source.packageVersion -eq [string]$source.packageVersion -and
    $activeGuardrails.ok -eq $true -and
    -not $componentDrift) {
    "up_to_date_cached"
} elseif ($guardrailDrift) {
    "active_host_guardrail_failed"
} else {
    "up_to_date"
}

if (-not $NoPersist -and
    $driftState -eq "synced" -and
    $updateNeeded -ne $true -and
    $activeGuardrails.ok -eq $true -and
    ((Test-StaleRunningUpdateOperation -Operation $existingOperation) -or
        (Test-StaleFailedUpdateOperation -Operation $existingOperation))) {
    $rollbackAvailable = [bool](Get-ObjectPropertyValue -InputObject $existingOperation -Name "rollbackAvailable")
    Set-AntiCodexUpdateOperation -State "succeeded" -Stage "complete" -Message "Anti-Codex is synced; cleared a stale sync operation." -RollbackAvailable $rollbackAvailable -StateRoot $StateRoot
    $existingOperation = (Get-AntiCodexUpdateStatus -StateRoot $StateRoot).operation
}

$syncLauncher = Join-Path $InstallRoot "runtime\scripts\sync-anticodex-launcher.ps1"
$launchedSync = $false
$prompted = $false
$sourceFingerprint = if ($sourceHostHash -and $sourceCliHash) {
    "$($source.packageName):$($source.packageVersion):$sourceHostHash`:$sourceCliHash`:hostPatchRevision=$expectedHostPatchRevision"
} else { $null }
$promptStatePath = Join-Path $StateRoot "update-prompt.json"
$lastPromptFingerprint = $null
if (Test-Path -LiteralPath $promptStatePath) {
    try { $lastPromptFingerprint = [string](Get-Content -LiteralPath $promptStatePath -Raw | ConvertFrom-Json).sourceFingerprint } catch {}
}

if ($Prompt -and $updateNeeded -and $sourceFingerprint -ne $lastPromptFingerprint) {
    $prompted = $true
    $choice = -1
    try {
        $shell = New-Object -ComObject WScript.Shell
        $choice = $shell.Popup(
            "Codex Desktop or CodexPlusPlus has an update. Update Anti-Codex now?`n`nAnti-Codex will stage and validate both components first. The current release stays available if validation fails.",
            30,
            "Anti-Codex Update Available",
            68
        )
    } catch {}
    if (-not $NoPersist) {
        New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
        [pscustomobject]@{
            sourceFingerprint = $sourceFingerprint
            promptedAt = [DateTime]::UtcNow.ToString("o")
            choice = $choice
        } | ForEach-Object {
            $json = $_ | ConvertTo-Json -Compress
            [System.IO.File]::WriteAllText($promptStatePath, $json, [System.Text.UTF8Encoding]::new($false))
        }
    }
    if ($choice -eq 6 -and (Test-Path -LiteralPath $syncLauncher -PathType Leaf)) {
        $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
        Start-Process -FilePath $powershell `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $syncLauncher) `
            -WindowStyle Hidden | Out-Null
        $launchedSync = $true
    }
}

$guardrailMessage = if ($activeGuardrails.ok) {
    "Anti-Codex brand and icon are preserved; sync builds and validates a candidate before replacing the active host."
} else {
    "Anti-Codex active host guardrails need validation; cache was not accepted as proof."
}

$result = [pscustomobject]@{
    ok = [bool]($comparable -and $activeGuardrails.ok -and -not $componentDrift)
    checkedAt = [DateTime]::UtcNow.ToString("o")
    updateNeeded = $updateNeeded
    reason = $reason
    source = [pscustomobject]@{
        packageName = if ($source) { $source.packageName } else { $null }
        packageVersion = if ($source) { $source.packageVersion } else { $null }
        root = if ($source) { $source.root } else { $null }
        desktopHostName = $sourceDesktopHost
        hostHash = $sourceHostHash
        cliHash = $sourceCliHash
        hostPatchRevision = $expectedHostPatchRevision
    }
    active = [pscustomobject]@{
        root = $activeRoot
        hostHash = $activeHostHash
        cliHash = $activeCliHash
        packageVersion = $activePackageVersion
        hostPatchRevision = $activeHostPatchRevision
    }
    components = [pscustomobject]@{
        updateNeeded = $componentDrift
        comparable = $componentComparable
        sourceVersion = $sourceComponentVersion
        activeVersion = $activeComponentVersion
        sourceHash = $sourceComponentHash
        activeHash = $activeComponentActualHash
        manifestHash = $activeComponentExpectedHash
        expectedPatchCount = if ($sourceComponentMetadata) { @($sourceComponentPatches).Count } else { 0 }
        patchCount = if ($activeComponentManifest) { @($activeComponentPatches).Count } else { 0 }
        remoteState = $remoteComponentRelease.remoteState
        remoteTag = $remoteComponentRelease.remoteTag
        remoteVersion = $remoteComponentRelease.remoteVersion
        remoteNewerThanProject = $remoteComponentRelease.remoteNewerThanProject
        remoteCheckedAt = $remoteComponentRelease.remoteCheckedAt
        remoteError = $remoteComponentRelease.remoteError
    }
    drift = [pscustomobject]@{
        state = $driftState
        hostChanged = $hostChanged
        cliChanged = $cliChanged
        packageVersionChanged = $packageVersionChanged
        activePackageVersion = $activePackageVersion
        sourcePackageVersion = if ($source) { $source.packageVersion } else { $null }
    }
    guardrails = [pscustomobject]@{
        brandPreserved = [bool]($activeGuardrails.ok)
        iconPreserved = [bool]($activeGuardrails.ok)
        activeHostValid = [bool]($activeGuardrails.ok)
        failures = $activeGuardrails.failures
        activationRequiresValidation = $true
        rollbackOnFailure = $true
        message = $guardrailMessage
    }
    sync = [pscustomobject]@{
        launcher = $syncLauncher
        available = (Test-Path -LiteralPath $syncLauncher -PathType Leaf)
        prompted = $prompted
        launched = $launchedSync
    }
    operation = $existingOperation
}

if (-not $NoPersist) {
    Save-AntiCodexUpdateStatus -Status $result -StateRoot $StateRoot
}
$result | ConvertTo-Json -Depth 8 -Compress
