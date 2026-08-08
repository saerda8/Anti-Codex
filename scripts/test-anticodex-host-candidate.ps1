#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)]
    [string]$CandidateRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

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

function Test-AntiCodexIconPalette {
    param([Parameter(Mandatory = $true)][string]$Path)

    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 22 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0 -or [BitConverter]::ToUInt16($bytes, 2) -ne 1) {
        throw "Anti-Codex icon is not a valid ICO: $Path"
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
        throw "Anti-Codex icon has an invalid ICO frame table: $Path"
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
        $originalBluePurple = 0
        $transparent = 0
        $solid = 0
        for ($y = 0; $y -lt $bitmap.Height; $y += 8) {
            for ($x = 0; $x -lt $bitmap.Width; $x += 8) {
                $pixel = $bitmap.GetPixel($x, $y)
                if ($pixel.A -lt 10) {
                    $transparent += 1
                    continue
                }
                $solid += 1
                if ($pixel.R -gt 205 -and $pixel.B -gt 135 -and $pixel.G -lt 165) { $pinkBlob += 1 }
                if ($pixel.R -gt 230 -and $pixel.G -gt 230 -and $pixel.B -gt 230) { $whiteCommand += 1 }
                if ($pixel.R -ge 30 -and $pixel.R -le 95 -and $pixel.G -ge 105 -and $pixel.G -le 170 -and $pixel.B -ge 120 -and $pixel.B -le 180) { $tealBackground += 1 }
                if ($pixel.B -gt 185 -and $pixel.R -lt 190 -and $pixel.G -lt 185) { $originalBluePurple += 1 }
            }
        }
        return [pscustomobject]@{
            width = $bitmap.Width
            height = $bitmap.Height
            pinkBlobSamples = $pinkBlob
            whiteCommandSamples = $whiteCommand
            tealBackgroundSamples = $tealBackground
            originalBluePurpleSamples = $originalBluePurple
            transparentSamples = $transparent
            solidSamples = $solid
            ok = ($pinkBlob -ge 120 -and $whiteCommand -ge 10 -and $transparent -ge 100 -and $tealBackground -le 3 -and $originalBluePurple -le 10)
        }
    } finally {
        $bitmap.Dispose()
        $image.Dispose()
        $stream.Dispose()
    }
}

$candidate = [IO.Path]::GetFullPath($CandidateRoot)
$expectedCandidate = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex\update-candidate"))
if ($candidate -ne $expectedCandidate) {
    throw "Anti-Codex candidate validation may only run for $expectedCandidate"
}

$candidateAppRoot = Join-Path $candidate "codex-patched-app"
$detectedDesktopHost = $null
foreach ($hostName in @("ChatGPT.exe", "Codex.exe")) {
    if (Test-Path -LiteralPath (Join-Path $candidateAppRoot $hostName) -PathType Leaf) {
        $detectedDesktopHost = $hostName
        break
    }
}
if (-not $detectedDesktopHost) {
    throw "Anti-Codex candidate is missing a desktop host executable (ChatGPT.exe or Codex.exe)."
}

$required = @(
    (Join-Path $candidate "codex-patched-app.ok"),
    (Join-Path $candidateAppRoot "Anti-Codex.exe"),
    (Join-Path $candidateAppRoot $detectedDesktopHost),
    (Join-Path $candidateAppRoot "resources\app.asar"),
    (Join-Path $candidateAppRoot "resources\codex.exe"),
    (Join-Path $candidateAppRoot "resources\codex-windows-sandbox-setup.exe"),
    (Join-Path $candidateAppRoot "resources\cua_node\bin\node_repl.exe"),
    (Join-Path $candidateAppRoot "resources\cua_node\bin\node.exe"),
    (Join-Path $candidateAppRoot "resources\icon.ico"),
    (Join-Path $candidateAppRoot "resources\codex-tray.ico"),
    (Join-Path $candidateAppRoot "icon.ico")
)
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Anti-Codex candidate is incomplete: $path"
    }
}

$markerPath = Join-Path $candidate "codex-patched-app.ok"
$manifest = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne "anticodex-host-manifest-v2") {
    throw "Anti-Codex candidate marker schema is invalid."
}
if (($manifest.PSObject.Properties.Name -notcontains "patchProfile") -or [string]$manifest.patchProfile -ne "fixed-shell-v1") {
    throw "Anti-Codex candidate marker patch profile is invalid."
}
if (($manifest.PSObject.Properties.Name -notcontains "hostPatchRevision") -or [string]$manifest.hostPatchRevision -ne "4") {
    throw "Anti-Codex candidate marker patch revision is invalid."
}
$expectedFixedShellCriticalPatches = @(
    "package-json",
    "webview-html-title",
    "app-name",
    "app-user-model-id",
    "session-title",
    "startup-mcp-config-reload",
    "app-server-managed-session-flags",
    "config-write",
    "auth-requirement",
    "app-route-gate",
    "profile-dropdown-settings",
    "settings-external-links",
    "browser-window-icon",
    "primary-window-restore-repaint",
    "windows-tray-icon",
    "local-model-availability"
)
$recordedCriticalPatches = @($manifest.criticalPatches)
if (($recordedCriticalPatches.Count -ne $expectedFixedShellCriticalPatches.Count) -or
    (@($expectedFixedShellCriticalPatches | Where-Object { $_ -notin $recordedCriticalPatches }).Count -gt 0)) {
    throw "Anti-Codex candidate marker is missing critical compatibility patches."
}
$recordedFiles = @()
$recordedFilesProperty = $manifest.PSObject.Properties["unpackedFiles"]
if ($recordedFilesProperty) {
    $recordedFiles = @($recordedFilesProperty.Value)
}
if ($recordedFiles.Count -eq 0) {
    throw "Anti-Codex candidate marker is missing unpacked file inventory."
}
$candidateAppRootFull = [IO.Path]::GetFullPath($candidateAppRoot).TrimEnd("\")
$candidateUnpackedRoot = [IO.Path]::GetFullPath((Join-Path $candidateAppRootFull "resources\app.asar.unpacked")).TrimEnd("\")
$candidateUnpackedPrefix = "$candidateUnpackedRoot\"
$recordedPaths = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
foreach ($recordedFile in $recordedFiles) {
    $relativePath = [string]$recordedFile.path
    $recordedHash = [string]$recordedFile.sha256
    $recordedSizeProperty = $recordedFile.PSObject.Properties["size"]
    if (-not $relativePath -or -not $recordedHash -or -not $recordedSizeProperty -or [IO.Path]::IsPathRooted($relativePath)) {
        throw "Anti-Codex candidate marker contains an invalid unpacked file entry."
    }
    $unpackedFilePath = [IO.Path]::GetFullPath((Join-Path $candidateAppRootFull $relativePath))
    $unpackedFileAccessPath = "\\?\$unpackedFilePath"
    if (-not $unpackedFilePath.StartsWith($candidateUnpackedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.File]::Exists($unpackedFileAccessPath)) {
        throw "Anti-Codex candidate unpacked file is missing or outside app.asar.unpacked: $relativePath"
    }
    if ([string](Get-AntiCodexSha256 -Path $unpackedFileAccessPath) -ne $recordedHash) {
        throw "Anti-Codex candidate unpacked file hash mismatch: $relativePath"
    }
    if ([long](Get-Item -LiteralPath $unpackedFileAccessPath).Length -ne [long]$recordedSizeProperty.Value) {
        throw "Anti-Codex candidate unpacked file size mismatch: $relativePath"
    }
    if (-not $recordedPaths.Add($unpackedFilePath)) {
        throw "Anti-Codex candidate marker repeats an unpacked file path: $relativePath"
    }
}
$actualFiles = @(Get-ChildItem -LiteralPath "\\?\$candidateUnpackedRoot" -File -Recurse -Force -ErrorAction Stop)
if ($actualFiles.Count -ne $recordedFiles.Count) {
    throw "Anti-Codex candidate unpacked file inventory is incomplete."
}

$antiCodex = Join-Path $candidateAppRoot "Anti-Codex.exe"
$asarPath = Join-Path $candidateAppRoot "resources\app.asar"
$codex = Join-Path $candidateAppRoot "resources\codex.exe"
$copiedSourceHost = Join-Path $candidateAppRoot $detectedDesktopHost
$hostIcon = Join-Path $candidateAppRoot "resources\icon.ico"
$trayIcon = Join-Path $candidateAppRoot "resources\codex-tray.ico"
$appRootIcon = Join-Path $candidateAppRoot "icon.ico"
$hostIconPalette = Test-AntiCodexIconPalette -Path $hostIcon
$trayIconPalette = Test-AntiCodexIconPalette -Path $trayIcon
$appRootIconPalette = Test-AntiCodexIconPalette -Path $appRootIcon
$asarText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($asarPath))
$settingsDefinitionPattern = '/\*anticodex-local-settings-only\*/account:\{href:`about:blank`,icon:[\w$]+,message:(?<messages>[\w$]+)\.account\},securitySettings:\{href:`about:blank`,icon:[\w$]+,message:\k<messages>\.securitySettings\}'
$settingsAccountHiddenPattern = '/\*anticodex-hide-external-account\*/null'
$settingsSecurityDisabledPattern = 'securitySettingsEnabled:0\s*\}'
$settingsDynamicWrapperPattern = '\{\.\.\.[\w$]+,securitySettingsEnabled:[A-Za-z_$][\w$]*\s*\}'
if ([regex]::Matches($asarText, $settingsDefinitionPattern).Count -ne 1 -or
    [regex]::Matches($asarText, $settingsAccountHiddenPattern).Count -ne 1 -or
    [regex]::Matches($asarText, $settingsSecurityDisabledPattern).Count -ne 1 -or
    [regex]::Matches($asarText, $settingsDynamicWrapperPattern).Count -ne 0 -or
    [regex]::Matches($asarText, '\.securitySettings\.message').Count -lt 1 -or
    [regex]::Matches($asarText, '/\*anticodex-local-settings-only\*/\s*\}').Count -ne 0) {
    throw "Anti-Codex candidate Settings compatibility patch is invalid."
}
$configWriteBridgePattern = '"batch-write-config-value":(?:async )?([\w$]+)=>this\.getRequestAppServerClient\(\1\.hostId\)\.sendAppServerRequest\([`"]config/batchWrite[`"],\1\)'
if ([regex]::Matches($asarText, $configWriteBridgePattern).Count -ne 1) {
    throw "Anti-Codex candidate native config write bridge count is invalid."
}
$codexTraySelectorCount = [regex]::Matches($asarText, 'codex-tray\.ico').Count
$alternateTraySelectorCount = [regex]::Matches($asarText, 'icon-agent\.ico|chatgpt-tray-(?:dark|light)\.ico').Count
if ($codexTraySelectorCount -lt 4 -or $alternateTraySelectorCount -ne 0) {
    throw "Anti-Codex candidate still selects a ChatGPT-branded Windows tray icon."
}
$primaryDeferredRestoreRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{let ([\w$]+)=\(\)=>this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\),([\w$]+)=\(\)=>\{try\{\1\.webContents\.invalidate\(\)\}catch\{\}\};this\.primaryWindows\.add\(\1\),\1\.isFocused\(\)\?\(this\.lastActivePrimaryWindow=\1,\2\(\)\):this\.lastActivePrimaryWindow\?\?=\1,this\.emitPrimaryWindowChangeIfNeeded\(\),\1\.on\(`focus`,\(\)=>\{this\.lastActivePrimaryWindow=\1,\2\(\),this\.emitPrimaryWindowChangeIfNeeded\(\)\}\),\1\.on\(`blur`,\2\),\1\.on\(`restore`,\(\)=>setImmediate\(\3\)\)\}'
$primaryFocusRestoreRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{let ([\w$]+)=\(\)=>this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\),([\w$]+)=\(\)=>\{try\{\1\.webContents\.invalidate\(\)\}catch\{\}\};this\.primaryWindows\.add\(\1\),\1\.isFocused\(\)\?\(this\.lastActivePrimaryWindow=\1,\2\(\)\):this\.lastActivePrimaryWindow\?\?=\1,this\.emitPrimaryWindowChangeIfNeeded\(\),\1\.on\(`focus`,\(\)=>\{this\.lastActivePrimaryWindow=\1,\2\(\),this\.emitPrimaryWindowChangeIfNeeded\(\),\3\(\)\}\),\1\.on\(`blur`,\2\),\1\.on\(`restore`,\(\)=>setImmediate\(\3\)\)\}'
$legacyPrimaryRestoreRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{let ([\w$]+)=\(\)=>this\.primaryWindowLastActiveAtMs\.set\(\1,Date\.now\(\)\);this\.primaryWindows\.add\(\1\),\1\.isFocused\(\)\?\(this\.lastActivePrimaryWindow=\1,\2\(\)\):this\.lastActivePrimaryWindow\?\?=\1,this\.emitPrimaryWindowChangeIfNeeded\(\),\1\.on\(`focus`,\(\)=>\{this\.lastActivePrimaryWindow=\1,\2\(\),this\.emitPrimaryWindowChangeIfNeeded\(\)\}\),\1\.on\(`blur`,\2\),\1\.on\(`restore`,\(\)=>\1\.webContents\.invalidate\?\.\(\)\)\}'
$anyPrimaryWindowRepaintPattern = 'trackPrimaryWindow\(([\w$]+)\)\{.{0,700}?\1\.webContents\.invalidate(?:\?\.)?\(\)'
if ([regex]::Matches($asarText, $primaryDeferredRestoreRepaintPattern).Count -ne 1) {
    throw "Anti-Codex candidate is missing the single deferred primary-window restore repaint."
}
if ([regex]::Matches($asarText, $primaryFocusRestoreRepaintPattern).Count -ne 0) {
    throw "Anti-Codex candidate still contains the revision-2 focus repaint."
}
if ([regex]::Matches($asarText, $anyPrimaryWindowRepaintPattern).Count -ne 1) {
    throw "Anti-Codex candidate contains an unexpected primary-window repaint shape."
}
if ([regex]::Matches($asarText, $legacyPrimaryRestoreRepaintPattern).Count -ne 0) {
    throw "Anti-Codex candidate still contains the legacy synchronous primary-window restore repaint."
}
foreach ($managerMarker in @("__ANTICODEX_OPEN_MANAGER__", "\u7ba1\u7406")) {
    if (-not $asarText.Contains($managerMarker)) {
        throw "Anti-Codex candidate is missing the Chinese Manager entry: $managerMarker"
    }
}
$retiredFeaturePatchPatterns = @(
    '\?\.length<1\|\|[\w$]+\([\w$]+,[\w$]+\)',
    'var [\w$]+=async\(\)=>\(\{marketplaces:\[\]\}\);',
    'async listPlugins\([\w$]+\)\{return\{marketplaces:\[\],marketplaceLoadErrors:\[\]\}\}',
    '"list-plugins":[\w$]+\(([\w$]+)=>\1\.listPlugins\(\{\}\)\)',
    'case`error`:if\([\w$]+\.willRetry\)\{break\}else if\('
)
foreach ($pattern in $retiredFeaturePatchPatterns) {
    if ($asarText -match $pattern) {
        throw "Anti-Codex fixed shell candidate contains a retired feature patch: $pattern"
    }
}
if ($hostIconPalette.ok -ne $true) {
    throw "Anti-Codex candidate host icon is not the pink Codex cloud with white command marks."
}
if ($trayIconPalette.ok -ne $true) {
    throw "Anti-Codex candidate tray icon is not the pink Codex cloud with white command marks."
}
if ($appRootIconPalette.ok -ne $true) {
    throw "Anti-Codex candidate app-root icon is not the pink Codex cloud with white command marks."
}
$expectedHashes = [ordered]@{
    antiCodexExe = Get-AntiCodexSha256 -Path $antiCodex
    appAsar = Get-AntiCodexSha256 -Path $asarPath
    codexCli = Get-AntiCodexSha256 -Path $codex
    sandboxHelper = Get-AntiCodexSha256 -Path (Join-Path $candidateAppRoot "resources\codex-windows-sandbox-setup.exe")
    nodeRepl = Get-AntiCodexSha256 -Path (Join-Path $candidateAppRoot "resources\cua_node\bin\node_repl.exe")
    nodeRuntime = Get-AntiCodexSha256 -Path (Join-Path $candidateAppRoot "resources\cua_node\bin\node.exe")
    hostIcon = Get-AntiCodexSha256 -Path $hostIcon
    trayIcon = Get-AntiCodexSha256 -Path $trayIcon
    appRootIcon = Get-AntiCodexSha256 -Path $appRootIcon
}
foreach ($name in $expectedHashes.Keys) {
    if ([string]$manifest.files.$name -ne [string]$expectedHashes[$name]) {
        throw "Anti-Codex candidate marker hash mismatch: $name"
    }
}
if (-not $manifest.source -or -not $manifest.source.codexHost -or -not $manifest.source.codexCli) {
    throw "Anti-Codex candidate marker is missing source Codex fingerprints."
}
if ([string]$manifest.source.codexHost -ne [string](Get-AntiCodexSha256 -Path $copiedSourceHost)) {
    throw "Anti-Codex candidate source host fingerprint does not match the copied Codex host."
}
if ([string]$manifest.source.codexCli -ne [string]$expectedHashes.codexCli) {
    throw "Anti-Codex candidate source CLI fingerprint does not match the copied Codex CLI."
}
if ([string]$expectedHashes.antiCodexExe -ne [string]$manifest.source.codexHost) {
    throw "Anti-Codex candidate must preserve the copied source Codex host bytes."
}

$asar = Get-Item -LiteralPath $asarPath
if ($asar.Length -lt 1MB) {
    throw "Anti-Codex candidate app package is invalid."
}

$asarIntegrityScript = Join-Path $PSScriptRoot "verify-anticodex-asar-integrity.mjs"
$nodeRuntime = Join-Path $candidateAppRoot "resources\cua_node\bin\node.exe"
& $nodeRuntime $asarIntegrityScript $asarPath
if ($LASTEXITCODE -ne 0) {
    throw "Anti-Codex candidate ASAR integrity validation failed."
}

$versionOutput = @(& $codex --version 2>&1)
if ($LASTEXITCODE -ne 0 -or -not ($versionOutput -join "").Trim()) {
    throw "Anti-Codex candidate bundled Codex CLI did not start."
}

Write-Host "Anti-Codex candidate validated: $($versionOutput -join ' ')"
