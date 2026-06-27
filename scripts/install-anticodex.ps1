#Requires -Version 5.1
param(
    [string]$InstallTarget = (Join-Path $env:LOCALAPPDATA "Anti-Codex"),
    [switch]$HostOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
$PATCH_EXE_ICON_SCRIPT = Join-Path $ROOT "scripts\patch-exe-icon.ps1"
$SOURCE_PREFLIGHT_SCRIPT = Join-Path $ROOT "scripts\test-anticodex-source-preflight.ps1"
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
$expectedCandidateRoot = [IO.Path]::GetFullPath((Join-Path $expectedRoot "update-candidate"))
$resolvedTarget = [IO.Path]::GetFullPath($InstallTarget)
if ($resolvedTarget -ne $expectedRoot -and (-not $HostOnly -or $resolvedTarget -ne $expectedCandidateRoot)) {
    throw "Anti-Codex may only install to $expectedRoot or build a host-only candidate at $expectedCandidateRoot"
}
$existingActiveMarker = Join-Path $expectedRoot "codex-patched-app.ok"
if (-not $HostOnly -and (Test-Path -LiteralPath $existingActiveMarker -PathType Leaf)) {
    throw "Anti-Codex is already installed. Use Sync Anti-Codex with Codex for host updates so the active installation and rollback checkpoint stay protected."
}

function Invoke-AntiCodexSourcePreflight {
    if (-not (Test-Path -LiteralPath $SOURCE_PREFLIGHT_SCRIPT -PathType Leaf)) {
        throw "Anti-Codex source preflight is missing: $SOURCE_PREFLIGHT_SCRIPT"
    }
    $global:LASTEXITCODE = 0
    & $SOURCE_PREFLIGHT_SCRIPT -SkipFullRegression | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Anti-Codex source preflight failed. Installation was stopped before copying the host."
    }
}

function Find-CodexAppRoot {
    foreach ($name in @("OpenAI.Codex", "OpenAI.Codex_8wekyb3d8bbwe")) {
        $pkg = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($pkg -and (Test-Path -LiteralPath (Join-Path $pkg.InstallLocation "app\Codex.exe"))) {
            return (Join-Path $pkg.InstallLocation "app")
        }
    }
    throw "Codex Desktop was not found. Install or update Codex first."
}

function Find-PhantomDirectories {
    param([Parameter(Mandatory = $true)][string]$Root)

    return @(Get-ChildItem -LiteralPath $Root -Directory -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
        -not (Test-Path -LiteralPath $_.FullName -PathType Container)
    } | ForEach-Object {
        [string]$_.FullName
    })
}

function Copy-Tree {
    param([string]$Source, [string]$Destination, [switch]$Mirror)
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    if (Get-Command robocopy.exe -ErrorAction SilentlyContinue) {
        $copyMode = if ($Mirror) { "/MIR" } else { "/E" }
        $copyArguments = @($Source, $Destination, $copyMode, "/XJ", "/COPY:DT", "/DCOPY:DT", "/R:1", "/W:1", "/NFL", "/NDL", "/NP", "/NJH", "/NJS")
        $phantomDirectories = @(Find-PhantomDirectories -Root $Source)
        if ($phantomDirectories.Count -gt 0) {
            $copyArguments += "/XD"
            $copyArguments += $phantomDirectories
        }
        $deferredFiles = @(Get-ChildItem -LiteralPath $Source -Filter "*.dll" -File -Force -ErrorAction Stop | ForEach-Object {
            [string]$_.FullName
        })
        if ($deferredFiles.Count -gt 0) {
            $copyArguments += "/XF"
            $copyArguments += $deferredFiles
        }
        $copyOutput = @()
        for ($attempt = 1; $attempt -le 3; $attempt += 1) {
            $copyOutput = @(& robocopy.exe @copyArguments 2>&1)
            $copyExitCode = $LASTEXITCODE
            if ($copyExitCode -lt 8) {
                foreach ($deferredFile in $deferredFiles) {
                    $deferredDestination = Join-Path $Destination (Split-Path -Leaf $deferredFile)
                    $deferredPending = "$deferredDestination.anticodex-pending"
                    for ($fileAttempt = 1; $fileAttempt -le 5; $fileAttempt += 1) {
                        try {
                            Remove-Item -LiteralPath $deferredPending -Force -ErrorAction SilentlyContinue
                            Copy-Item -LiteralPath $deferredFile -Destination $deferredPending -Force -ErrorAction Stop
                            Move-Item -LiteralPath $deferredPending -Destination $deferredDestination -Force -ErrorAction Stop
                            break
                        } catch {
                            Remove-Item -LiteralPath $deferredPending -Force -ErrorAction SilentlyContinue
                            if ($fileAttempt -eq 5) { throw }
                            Start-Sleep -Seconds (3 * $fileAttempt)
                        }
                    }
                }
                return
            }
            if ($attempt -lt 3) { Start-Sleep -Seconds (15 * $attempt) }
        }
        if ($phantomDirectories.Count -eq 0) {
            try {
                Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force -ErrorAction Stop
                return
            } catch {
                throw "Copy failed after 3 attempts and fallback copy failed (robocopy exit $copyExitCode): $Source; $($_.Exception.Message)"
            }
        }
        $copyTail = (($copyOutput | Select-Object -Last 12) -join " | ").Trim()
        throw "Copy failed after 3 attempts while excluding $($phantomDirectories.Count) unreadable packaged directories (robocopy exit $copyExitCode): $Source; $copyTail"
    }
    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force -ErrorAction Stop
}

function Find-CSharpCompiler {
    $candidates = @(
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $found = Get-Command csc.exe -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    return $null
}

function Find-Rcedit {
    $found = Get-Command rcedit.exe -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }

    $toolRoot = Join-Path $expectedRoot "tools"
    $cached = Join-Path $toolRoot "rcedit.exe"
    if (Test-Path -LiteralPath $cached -PathType Leaf) { return $cached }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm.exe -ErrorAction SilentlyContinue }
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if (-not $npm -or -not $tar) { return $null }

    $temp = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-rcedit-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    try {
        & $npm.Source pack rcedit@5.0.2 --silent --pack-destination $temp | Out-Null
        $package = Get-ChildItem -LiteralPath $temp -Filter "rcedit-*.tgz" | Select-Object -First 1
        if (-not $package) { return $null }
        & $tar.Source -xf $package.FullName -C $temp
        $candidate = Join-Path $temp "package\bin\rcedit-x64.exe"
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $candidate = Join-Path $temp "package\bin\rcedit.exe"
        }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
        New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
        Copy-Item -LiteralPath $candidate -Destination $cached -Force
        return $cached
    } catch {
        return $null
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Update-ExeVersionInfo {
    param([string]$Path)
    $rcedit = Find-Rcedit
    if (-not $rcedit) {
        throw "Anti-Codex Windows branding tool was not available. The copied host was not activated."
    }
    & $rcedit $Path `
        --set-version-string "ProductName" "Anti-Codex" `
        --set-version-string "FileDescription" "Anti-Codex" `
        --set-version-string "InternalName" "Anti-Codex.exe" `
        --set-version-string "OriginalFilename" "Anti-Codex.exe" `
        --set-version-string "CompanyName" "Anti-Codex"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to update Anti-Codex Windows version information. The copied host was not activated."
    }
    $versionInfo = (Get-Item -LiteralPath $Path).VersionInfo
    if ([string]$versionInfo.ProductName -ne "Anti-Codex" -or
        [string]$versionInfo.FileDescription -ne "Anti-Codex" -or
        [string]$versionInfo.OriginalFilename -ne "Anti-Codex.exe") {
        throw "Anti-Codex Windows branding verification failed. The copied host was not activated."
    }
}

function Resolve-AntiCodexIconPath {
    $icon = Join-Path $ROOT "assets\anticodex.ico"
    if (Test-Path -LiteralPath $icon -PathType Leaf) { return $icon }
    throw "Anti-Codex icon asset is missing: $icon"
}

function Install-AntiCodexHostIcon {
    param(
        [Parameter(Mandatory = $true)][string]$HostRoot,
        [Parameter(Mandatory = $true)][string]$ExePath
    )

    $icon = Resolve-AntiCodexIconPath
    $resourceIcon = Join-Path $HostRoot "resources\icon.ico"
    $trayIcon = Join-Path $HostRoot "resources\codex-tray.ico"
    $appRootIcon = Join-Path $HostRoot "icon.ico"
    $resourceDir = Split-Path -Parent $resourceIcon
    if (-not (Test-Path -LiteralPath $resourceDir -PathType Container)) {
        throw "Anti-Codex host resources directory is missing: $resourceDir"
    }
    Copy-Item -LiteralPath $icon -Destination $resourceIcon -Force
    Copy-Item -LiteralPath $icon -Destination $trayIcon -Force
    Copy-Item -LiteralPath $icon -Destination $appRootIcon -Force

    if (-not (Test-Path -LiteralPath $PATCH_EXE_ICON_SCRIPT -PathType Leaf)) {
        throw "Anti-Codex icon patcher is missing: $PATCH_EXE_ICON_SCRIPT"
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PATCH_EXE_ICON_SCRIPT -ExePath $ExePath -IconPath $icon | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Anti-Codex executable icon patch failed."
    }
    try { & ie4uinit.exe -show | Out-Null } catch {}
}

function Write-HostManifest {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$HostRoot,
        [Parameter(Mandatory = $true)][string]$SourceRoot
    )

    $marker = Join-Path $TargetRoot "codex-patched-app.ok"
    $temporaryMarker = "$marker.tmp"
    $sourcePackage = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object {
        try {
            [IO.Path]::GetFullPath((Join-Path $_.InstallLocation "app")) -eq [IO.Path]::GetFullPath($SourceRoot)
        } catch {
            $false
        }
    } | Select-Object -First 1
    $manifest = [ordered]@{
        schema = "anticodex-host-manifest-v1"
        generatedAtUtc = [DateTime]::UtcNow.ToString("o")
        source = [ordered]@{
            packageName = if ($sourcePackage) { [string]$sourcePackage.Name } else { $null }
            packageVersion = if ($sourcePackage) { [string]$sourcePackage.Version } else { $null }
            codexHost = (Get-FileHash -LiteralPath (Join-Path $SourceRoot "Codex.exe") -Algorithm SHA256).Hash
            codexCli = (Get-FileHash -LiteralPath (Join-Path $SourceRoot "resources\codex.exe") -Algorithm SHA256).Hash
        }
        criticalPatches = @(
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
            "webview-local-plugin-catalog"
        )
        files = [ordered]@{
            antiCodexExe = (Get-FileHash -LiteralPath (Join-Path $HostRoot "Anti-Codex.exe") -Algorithm SHA256).Hash
            appAsar = (Get-FileHash -LiteralPath (Join-Path $HostRoot "resources\app.asar") -Algorithm SHA256).Hash
            codexCli = (Get-FileHash -LiteralPath (Join-Path $HostRoot "resources\codex.exe") -Algorithm SHA256).Hash
            hostIcon = (Get-FileHash -LiteralPath (Join-Path $HostRoot "resources\icon.ico") -Algorithm SHA256).Hash
            trayIcon = (Get-FileHash -LiteralPath (Join-Path $HostRoot "resources\codex-tray.ico") -Algorithm SHA256).Hash
            appRootIcon = (Get-FileHash -LiteralPath (Join-Path $HostRoot "icon.ico") -Algorithm SHA256).Hash
        }
    }
    Remove-Item -LiteralPath $temporaryMarker -Force -ErrorAction SilentlyContinue
    $json = $manifest | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($temporaryMarker, $json, [System.Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporaryMarker, $marker)
}

$runtime = Join-Path $resolvedTarget "runtime"
$copiedCodex = Join-Path $resolvedTarget "codex-patched-app"
$copiedCodexStaging = Join-Path $resolvedTarget "codex-host-staging"
Invoke-AntiCodexSourcePreflight
$sourceCodex = Find-CodexAppRoot
$hostMarker = Join-Path $resolvedTarget "codex-patched-app.ok"

# A marker is valid only for a fully patched host whose hashes were recorded last.
Remove-Item -LiteralPath $hostMarker -Force -ErrorAction SilentlyContinue

if (-not $HostOnly) {
    foreach ($dir in @("scripts", "translator", "assets", "codex-home-deepseek-app")) {
        Copy-Tree (Join-Path $ROOT $dir) (Join-Path $runtime $dir)
    }
    foreach ($requiredRuntimePath in @(
        (Join-Path $runtime "scripts\start-anticodex.ps1"),
        (Join-Path $runtime "scripts\anticodex-update-status.psm1"),
        (Join-Path $runtime "scripts\sync-anticodex.ps1"),
        (Join-Path $runtime "scripts\rollback-anticodex.ps1"),
        (Join-Path $runtime "scripts\manage-anticodex.ps1"),
        (Join-Path $runtime "translator\adaptive-server.mjs"),
        (Join-Path $runtime "codex-home-deepseek-app\config.adaptive-oneapi.toml")
    )) {
        if (-not (Test-Path -LiteralPath $requiredRuntimePath -PathType Leaf)) {
            throw "Anti-Codex runtime is incomplete: $requiredRuntimePath"
        }
    }
}
if (Test-Path -LiteralPath $copiedCodexStaging) {
    [IO.Directory]::Delete("\\?\$([IO.Path]::GetFullPath($copiedCodexStaging))", $true)
}
Copy-Tree $sourceCodex $copiedCodexStaging -Mirror

foreach ($requiredHostFile in @("Codex.exe", "resources\app.asar", "resources\codex.exe")) {
    if (-not (Test-Path -LiteralPath (Join-Path $copiedCodexStaging $requiredHostFile) -PathType Leaf)) {
        throw "The copied Codex host is incomplete: $requiredHostFile"
    }
}
if (Test-Path -LiteralPath $copiedCodex) {
    [IO.Directory]::Delete("\\?\$([IO.Path]::GetFullPath($copiedCodex))", $true)
}
Move-Item -LiteralPath $copiedCodexStaging -Destination $copiedCodex
$antiCodexHost = Join-Path $copiedCodex "Anti-Codex.exe"
Copy-Item -LiteralPath (Join-Path $copiedCodex "Codex.exe") -Destination $antiCodexHost -Force
Update-ExeVersionInfo $antiCodexHost
Install-AntiCodexHostIcon -HostRoot $copiedCodex -ExePath $antiCodexHost
$brandScript = Join-Path $ROOT "scripts\brand-patched-asar.mjs"
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node $brandScript (Join-Path $copiedCodex "resources\app.asar") $antiCodexHost
if ($LASTEXITCODE -ne 0) {
    throw "Critical Anti-Codex compatibility patches failed. No valid host marker was created."
}
Write-HostManifest -TargetRoot $resolvedTarget -HostRoot $copiedCodex -SourceRoot $sourceCodex

$snapshotSync = Join-Path $runtime "scripts\sync-shared-codex-plugin-host.mjs"
if (Test-Path -LiteralPath $snapshotSync -PathType Leaf) {
    try {
        $isolatedCodexHome = Join-Path (Join-Path $env:APPDATA "anticodex") "codex-home-deepseek-app"
        $sharedCodexHome = Join-Path $env:USERPROFILE ".codex"
        $snapshotOutput = & $node $snapshotSync $isolatedCodexHome $sharedCodexHome --local-snapshots 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "snapshot command failed: $(($snapshotOutput | Out-String).Trim())"
        }
        $snapshotResult = (($snapshotOutput | Out-String).Trim() | ConvertFrom-Json)
        if ($snapshotResult.ok -ne $true) {
            throw "snapshot reported a copy failure"
        }
    } catch {
        Write-Warning "Anti-Codex host is ready, but the optional full local feature snapshot needs a later Manager refresh: $($_.Exception.Message)"
    }
}

if (-not $HostOnly) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $programs = [Environment]::GetFolderPath("Programs")
    $startMenuDir = Join-Path $programs "Anti-Codex"
    $shell = New-Object -ComObject WScript.Shell
    $icon = Join-Path $copiedCodex "resources\icon.ico"
    $desktopIcon = Join-Path $runtime "assets\anticodex-desktop.ico"
    $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"

    $shortcut = $shell.CreateShortcut((Join-Path $desktop "Anti-Codex.lnk"))
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runtime\scripts\start-anticodex.ps1`""
    $shortcut.WorkingDirectory = $resolvedTarget
    $shortcut.Description = "Anti-Codex - Codex Desktop powered by Antigravity"
    if (Test-Path -LiteralPath $desktopIcon) {
        $shortcut.IconLocation = "$desktopIcon,0"
    } elseif (Test-Path -LiteralPath $icon) {
        $shortcut.IconLocation = "$icon,0"
    }
    $shortcut.Save()

    New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
    $startShortcut = $shell.CreateShortcut((Join-Path $startMenuDir "Anti-Codex.lnk"))
    $startShortcut.TargetPath = $powershell
    $startShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runtime\scripts\start-anticodex.ps1`""
    $startShortcut.WorkingDirectory = $resolvedTarget
    $startShortcut.Description = "Anti-Codex - Codex Desktop powered by Antigravity"
    if (Test-Path -LiteralPath $icon) { $startShortcut.IconLocation = "$icon,0" }
    $startShortcut.Save()

    $syncShortcut = $shell.CreateShortcut((Join-Path $startMenuDir "Sync Anti-Codex with Codex.lnk"))
    $syncShortcut.TargetPath = $powershell
    $syncShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runtime\scripts\sync-anticodex-launcher.ps1`""
    $syncShortcut.WorkingDirectory = $resolvedTarget
    $syncShortcut.Description = "Rebuild Anti-Codex from the installed Codex Desktop host after Codex updates"
    if (Test-Path -LiteralPath $icon) { $syncShortcut.IconLocation = "$icon,0" }
    $syncShortcut.Save()

    $rollbackShortcut = $shell.CreateShortcut((Join-Path $startMenuDir "Rollback Anti-Codex.lnk"))
    $rollbackShortcut.TargetPath = $powershell
    $rollbackShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runtime\scripts\rollback-anticodex-launcher.ps1`""
    $rollbackShortcut.WorkingDirectory = $resolvedTarget
    $rollbackShortcut.Description = "Rollback Anti-Codex to the previous patched Codex host version"
    if (Test-Path -LiteralPath $icon) { $rollbackShortcut.IconLocation = "$icon,0" }
    $rollbackShortcut.Save()

    $managerShortcut = $shell.CreateShortcut((Join-Path $startMenuDir "Manage Anti-Codex.lnk"))
    $managerShortcut.TargetPath = $powershell
    $managerShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runtime\scripts\manage-anticodex.ps1`""
    $managerShortcut.WorkingDirectory = $resolvedTarget
    $managerShortcut.Description = "Open the Anti-Codex maintenance and account manager"
    if (Test-Path -LiteralPath $icon) { $managerShortcut.IconLocation = "$icon,0" }
    $managerShortcut.Save()
}

Write-Host "Anti-Codex installed."
Write-Host "  Runtime:  $runtime"
