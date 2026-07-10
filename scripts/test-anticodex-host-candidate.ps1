#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)]
    [string]$CandidateRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

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

$required = @(
    (Join-Path $candidate "codex-patched-app.ok"),
    (Join-Path $candidate "codex-patched-app\Anti-Codex.exe"),
    (Join-Path $candidate "codex-patched-app\Codex.exe"),
    (Join-Path $candidate "codex-patched-app\resources\app.asar"),
    (Join-Path $candidate "codex-patched-app\resources\codex.exe"),
    (Join-Path $candidate "codex-patched-app\resources\icon.ico"),
    (Join-Path $candidate "codex-patched-app\resources\codex-tray.ico"),
    (Join-Path $candidate "codex-patched-app\icon.ico")
)
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Anti-Codex candidate is incomplete: $path"
    }
}

$markerPath = Join-Path $candidate "codex-patched-app.ok"
$manifest = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne "anticodex-host-manifest-v1") {
    throw "Anti-Codex candidate marker schema is invalid."
}
$expectedCriticalPatches = @(
    "package-json",
    "webview-html-title",
    "app-name",
    "app-user-model-id",
    "session-title",
    "auth-requirement",
    "app-route-gate",
    "profile-dropdown-settings",
    "browser-window-icon",
    "local-model-availability",
    "local-plugin-catalog",
    "electron-local-plugin-catalog",
    "webview-local-plugin-catalog",
    "retry-stream-error-visibility"
)
$recordedCriticalPatches = @($manifest.criticalPatches)
if (($recordedCriticalPatches.Count -ne $expectedCriticalPatches.Count) -or
    (@($expectedCriticalPatches | Where-Object { $_ -notin $recordedCriticalPatches }).Count -gt 0)) {
    throw "Anti-Codex candidate marker is missing critical compatibility patches."
}

$antiCodex = Join-Path $candidate "codex-patched-app\Anti-Codex.exe"
$asarPath = Join-Path $candidate "codex-patched-app\resources\app.asar"
$codex = Join-Path $candidate "codex-patched-app\resources\codex.exe"
$copiedSourceHost = Join-Path $candidate "codex-patched-app\Codex.exe"
$hostIcon = Join-Path $candidate "codex-patched-app\resources\icon.ico"
$trayIcon = Join-Path $candidate "codex-patched-app\resources\codex-tray.ico"
$appRootIcon = Join-Path $candidate "codex-patched-app\icon.ico"
$hostIconPalette = Test-AntiCodexIconPalette -Path $hostIcon
$trayIconPalette = Test-AntiCodexIconPalette -Path $trayIcon
$appRootIconPalette = Test-AntiCodexIconPalette -Path $appRootIcon
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
    antiCodexExe = (Get-FileHash -LiteralPath $antiCodex -Algorithm SHA256).Hash
    appAsar = (Get-FileHash -LiteralPath $asarPath -Algorithm SHA256).Hash
    codexCli = (Get-FileHash -LiteralPath $codex -Algorithm SHA256).Hash
    hostIcon = (Get-FileHash -LiteralPath $hostIcon -Algorithm SHA256).Hash
    trayIcon = (Get-FileHash -LiteralPath $trayIcon -Algorithm SHA256).Hash
    appRootIcon = (Get-FileHash -LiteralPath $appRootIcon -Algorithm SHA256).Hash
}
foreach ($name in $expectedHashes.Keys) {
    if ([string]$manifest.files.$name -ne [string]$expectedHashes[$name]) {
        throw "Anti-Codex candidate marker hash mismatch: $name"
    }
}
if (-not $manifest.source -or -not $manifest.source.codexHost -or -not $manifest.source.codexCli) {
    throw "Anti-Codex candidate marker is missing source Codex fingerprints."
}
if ([string]$manifest.source.codexHost -ne [string](Get-FileHash -LiteralPath $copiedSourceHost -Algorithm SHA256).Hash) {
    throw "Anti-Codex candidate source host fingerprint does not match the copied Codex host."
}
if ([string]$manifest.source.codexCli -ne [string]$expectedHashes.codexCli) {
    throw "Anti-Codex candidate source CLI fingerprint does not match the copied Codex CLI."
}

$versionInfo = (Get-Item -LiteralPath $antiCodex).VersionInfo
$productName = [string]$versionInfo.ProductName
$fileDescription = [string]$versionInfo.FileDescription
$originalFilename = [string]$versionInfo.OriginalFilename
if ($productName -ne "Anti-Codex" -or $fileDescription -ne "Anti-Codex" -or $originalFilename -ne "Anti-Codex.exe") {
    $rcedit = Join-Path $env:LOCALAPPDATA "Anti-Codex\tools\rcedit.exe"
    if (-not (Test-Path -LiteralPath $rcedit -PathType Leaf)) {
        throw "Anti-Codex candidate branding verifier is unavailable."
    }
    $productName = ([string](& $rcedit $antiCodex --get-version-string "ProductName" 2>$null)).Trim()
    $productNameExitCode = $LASTEXITCODE
    $fileDescription = ([string](& $rcedit $antiCodex --get-version-string "FileDescription" 2>$null)).Trim()
    $fileDescriptionExitCode = $LASTEXITCODE
    $originalFilename = ([string](& $rcedit $antiCodex --get-version-string "OriginalFilename" 2>$null)).Trim()
    $originalFilenameExitCode = $LASTEXITCODE
    if ($productNameExitCode -ne 0 -or $fileDescriptionExitCode -ne 0 -or $originalFilenameExitCode -ne 0) {
        throw "Anti-Codex candidate branding read-back failed."
    }
}
if ($productName -ne "Anti-Codex") {
    throw "Anti-Codex candidate host branding is invalid: $productName"
}
if ($fileDescription -ne "Anti-Codex") {
    throw "Anti-Codex candidate host file description is invalid: $fileDescription"
}
if ($originalFilename -ne "Anti-Codex.exe") {
    throw "Anti-Codex candidate host original filename is invalid: $originalFilename"
}

$asar = Get-Item -LiteralPath $asarPath
if ($asar.Length -lt 1MB) {
    throw "Anti-Codex candidate app package is invalid."
}

$versionOutput = @(& $codex --version 2>&1)
if ($LASTEXITCODE -ne 0 -or -not ($versionOutput -join "").Trim()) {
    throw "Anti-Codex candidate bundled Codex CLI did not start."
}

Write-Host "Anti-Codex candidate validated: $($versionOutput -join ' ')"
