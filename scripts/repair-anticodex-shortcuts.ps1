#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Anti-Codex"),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installRootFull = [IO.Path]::GetFullPath($InstallRoot)
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRootFull -ne $expectedRoot) {
    throw "Anti-Codex shortcuts may only be repaired for $expectedRoot"
}

$runtimeRoot = Join-Path $installRootFull "runtime"
$hostRoot = Join-Path $installRootFull "codex-patched-app"
$startScript = Join-Path $runtimeRoot "scripts\start-anticodex.ps1"
$syncScript = Join-Path $runtimeRoot "scripts\sync-anticodex-launcher.ps1"
$rollbackScript = Join-Path $runtimeRoot "scripts\rollback-anticodex-launcher.ps1"
$managerScript = Join-Path $runtimeRoot "scripts\manage-anticodex.ps1"
$hostIcon = Join-Path $hostRoot "resources\icon.ico"
$desktopIcon = Join-Path $runtimeRoot "assets\anticodex-desktop.ico"
$powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")
$startMenuDir = Join-Path $programs "Anti-Codex"
$desktopShortcutIcon = if (Test-Path -LiteralPath $desktopIcon -PathType Leaf) { $desktopIcon } else { $hostIcon }

function Get-AntiCodexShortcutLauncherTarget {
    param([string]$Arguments)

    $match = [regex]::Match($Arguments, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|([^\s]+))')
    if (-not $match.Success) { return "" }

    $target = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    try { return [IO.Path]::GetFullPath($target) } catch { return $target }
}

function New-AntiCodexShortcutSpec {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Script,
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][string]$Icon
    )
    $displayName = Split-Path -Leaf $Path
    [pscustomobject]@{
        path = $Path
        displayName = $displayName
        expectedDisplayName = $displayName
        expectedScript = $Script
        expectedLauncherTarget = $Script
        expectedDescription = $Description
        expectedIconLocation = "$Icon,0"
        iconSource = $Icon
    }
}

$shortcutSpecs = @(
    New-AntiCodexShortcutSpec -Path (Join-Path $desktop "Anti-Codex.lnk") -Script $startScript -Description "Anti-Codex - Codex Desktop powered by Antigravity" -Icon $desktopShortcutIcon
    New-AntiCodexShortcutSpec -Path (Join-Path $startMenuDir "Anti-Codex.lnk") -Script $startScript -Description "Anti-Codex - Codex Desktop powered by Antigravity" -Icon $hostIcon
    New-AntiCodexShortcutSpec -Path (Join-Path $startMenuDir "Sync Anti-Codex with Codex.lnk") -Script $syncScript -Description "Rebuild Anti-Codex from the installed Codex Desktop host after Codex updates" -Icon $hostIcon
    New-AntiCodexShortcutSpec -Path (Join-Path $startMenuDir "Rollback Anti-Codex.lnk") -Script $rollbackScript -Description "Rollback Anti-Codex to the previous patched Codex host version" -Icon $hostIcon
    New-AntiCodexShortcutSpec -Path (Join-Path $startMenuDir "Manage Anti-Codex.lnk") -Script $managerScript -Description "Open the Anti-Codex maintenance and account manager" -Icon $hostIcon
)
$protectedShortcutPaths = @{}
foreach ($spec in $shortcutSpecs) {
    $protectedShortcutPaths[[IO.Path]::GetFullPath([string]$spec.path).ToLowerInvariant()] = $true
}
$residualShortcutNames = @(
    "Codex.lnk",
    "Codex Desktop.lnk",
    "DeepCodex.lnk",
    "DeepCodex Desktop.lnk"
)
$legacyDeepCodexStartMenuDir = Join-Path $programs "DeepCodex"
$residualShortcutRoots = @(
    [pscustomobject]@{ path = $desktop; location = "desktop"; removeCodexByName = $false },
    [pscustomobject]@{ path = $startMenuDir; location = "start-menu-anticodex"; removeCodexByName = $true },
    [pscustomobject]@{ path = $legacyDeepCodexStartMenuDir; location = "start-menu-deepcodex"; removeCodexByName = $true }
)

function New-ReportPaths {
    param([string]$Name)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    [pscustomobject]@{
        latest = Join-Path $ReportRoot "latest-$Name.json"
        history = Join-Path $ReportRoot "$stamp-$Name.json"
    }
}

function Save-JsonReport {
    param($Value, [string]$Name)
    $paths = New-ReportPaths $Name
    $json = $Value | ConvertTo-Json -Depth 8
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $paths.latest -HistoryPath $paths.history -Json $json -Encoding $utf8NoBom
    return $paths
}

function Test-AntiCodexOwnedResidualShortcut {
    param($ShortcutInfo)

    $text = @(
        [string]$ShortcutInfo.actualTarget,
        [string]$ShortcutInfo.actualArguments,
        [string]$ShortcutInfo.actualDescription,
        [string]$ShortcutInfo.actualLauncherTarget
    ) -join "`n"
    $installRootPattern = [regex]::Escape($installRootFull)
    $legacyDeepCodexPattern = [regex]::Escape((Join-Path $env:LOCALAPPDATA "deepcodex"))
    return (
        $text -match $installRootPattern -or
        $text -match $legacyDeepCodexPattern -or
        $text -match "(?i)start-(anti|deep)codex\.ps1|Anti-Codex|DeepCodex"
    )
}

function Get-AntiCodexResidualShortcutInspection {
    param([Parameter(Mandatory = $true)][string]$Path)

    $displayName = Split-Path -Leaf $Path
    $actualTarget = ""
    $actualArguments = ""
    $actualDescription = ""
    $actualLauncherTarget = ""
    $inspectionError = ""
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($Path)
        $actualTarget = [string]$shortcut.TargetPath
        $actualArguments = [string]$shortcut.Arguments
        $actualDescription = [string]$shortcut.Description
        $actualLauncherTarget = Get-AntiCodexShortcutLauncherTarget $actualArguments
    } catch {
        $inspectionError = $_.Exception.Message
    }
    $info = [pscustomobject]@{
        path = $Path
        displayName = $displayName
        actualTarget = $actualTarget
        actualArguments = $actualArguments
        actualDescription = $actualDescription
        actualLauncherTarget = $actualLauncherTarget
        inspectionError = $inspectionError
    }
    $info | Add-Member -NotePropertyName ownedByAntiCodexOrDeepCodex -NotePropertyValue (Test-AntiCodexOwnedResidualShortcut $info)
    return $info
}

function Repair-AntiCodexResidualShortcuts {
    $results = New-Object System.Collections.Generic.List[object]
    foreach ($root in $residualShortcutRoots) {
        if (-not (Test-Path -LiteralPath ([string]$root.path) -PathType Container)) { continue }
        foreach ($name in $residualShortcutNames) {
            $path = Join-Path ([string]$root.path) $name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
            $pathKey = [IO.Path]::GetFullPath($path).ToLowerInvariant()
            if ($protectedShortcutPaths.ContainsKey($pathKey)) { continue }

            $info = Get-AntiCodexResidualShortcutInspection -Path $path
            $isDeepCodexName = ([string]$info.displayName -match "(?i)DeepCodex")
            $shouldRemove = (
                [bool]$info.ownedByAntiCodexOrDeepCodex -or
                [bool]$root.removeCodexByName -or
                $isDeepCodexName
            )
            $action = if ($shouldRemove) { "removed" } else { "reported" }
            $error = ""
            if ($shouldRemove) {
                try {
                    Remove-Item -LiteralPath $path -Force
                } catch {
                    $action = "remove-failed"
                    $error = $_.Exception.Message
                }
            }
            $results.Add([pscustomobject]@{
                action = $action
                path = [string]$info.path
                displayName = [string]$info.displayName
                location = [string]$root.location
                ownedByAntiCodexOrDeepCodex = [bool]$info.ownedByAntiCodexOrDeepCodex
                actualTarget = [string]$info.actualTarget
                actualLauncherTarget = [string]$info.actualLauncherTarget
                actualArguments = [string]$info.actualArguments
                actualDescription = [string]$info.actualDescription
                inspectionError = [string]$info.inspectionError
                error = $error
            }) | Out-Null
        }
    }
    try {
        if ((Test-Path -LiteralPath $legacyDeepCodexStartMenuDir -PathType Container) -and
            -not @(Get-ChildItem -LiteralPath $legacyDeepCodexStartMenuDir -Force -ErrorAction SilentlyContinue | Select-Object -First 1).Count) {
            Remove-Item -LiteralPath $legacyDeepCodexStartMenuDir -Force -ErrorAction SilentlyContinue
        }
    } catch {}
    return $results.ToArray()
}

$residualShortcutEvidence = @(Repair-AntiCodexResidualShortcuts)
$residualShortcutFailures = @($residualShortcutEvidence | Where-Object { $_.action -ne "removed" })
$failures = New-Object System.Collections.Generic.List[string]
foreach ($path in @($startScript, $syncScript, $rollbackScript, $managerScript, $hostIcon, $desktopShortcutIcon)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $failures.Add("Required Anti-Codex shortcut target is missing: $path") | Out-Null
    }
}
foreach ($residual in $residualShortcutFailures) {
    if ($residual.action -eq "reported") {
        $failures.Add("Residual shortcut requires manual review: $($residual.path)") | Out-Null
    } else {
        $failures.Add("Residual shortcut could not be removed: $($residual.path)") | Out-Null
    }
}
if ($failures.Count -gt 0) {
    $result = [pscustomobject]@{
        ok = $false
        reportName = "shortcut-repair"
        repairedAt = [DateTime]::UtcNow.ToString("o")
        installRoot = $installRootFull
        repairedCount = 0
        residualShortcutCount = @($residualShortcutEvidence).Count
        removedResidualShortcutCount = @($residualShortcutEvidence | Where-Object { $_.action -eq "removed" }).Count
        reportedResidualShortcutCount = @($residualShortcutEvidence | Where-Object { $_.action -eq "reported" }).Count
        failures = $failures.ToArray()
        residualShortcuts = $residualShortcutEvidence
        shortcutEvidence = @()
        shortcuts = @()
    }
    $reportPaths = Save-JsonReport $result "shortcut-repair"
    $result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
    $result | ConvertTo-Json -Depth 8
    exit 1
}

function Set-AntiCodexShortcut {
    param(
        [Parameter(Mandatory = $true)]$Spec
    )

    $parent = Split-Path -Parent ([string]$Spec.path)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut([string]$Spec.path)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($Spec.expectedScript)`""
    $shortcut.WorkingDirectory = $installRootFull
    $shortcut.Description = [string]$Spec.expectedDescription
    $shortcut.IconLocation = [string]$Spec.expectedIconLocation
    $shortcut.Save()

    $verified = $shell.CreateShortcut([string]$Spec.path)
    $actualTarget = [string]$verified.TargetPath
    $actualArguments = [string]$verified.Arguments
    $actualDescription = [string]$verified.Description
    $actualIconLocation = [string]$verified.IconLocation
    $actualLauncherTarget = Get-AntiCodexShortcutLauncherTarget $actualArguments
    $displayName = Split-Path -Leaf ([string]$Spec.path)
    $launcherTargetMatches = ($actualLauncherTarget -and ($actualLauncherTarget -ieq [string]$Spec.expectedLauncherTarget))
    $scriptMatches = $launcherTargetMatches
    $iconMatches = ($actualIconLocation -ieq [string]$Spec.expectedIconLocation)
    $displayNameMatches = ($displayName -ceq [string]$Spec.expectedDisplayName)
    $targetMatches = ($actualTarget -match "powershell\.exe$")
    $descriptionMatches = ($actualDescription -eq [string]$Spec.expectedDescription)
    $forbiddenCodexBranding = ($displayName -notmatch "Anti-Codex") -or (($actualDescription -match "^Codex(\s|$)") -and ($actualDescription -notmatch "Anti-Codex"))

    [pscustomobject]@{
        ok = ($targetMatches -and $scriptMatches -and $iconMatches -and $displayNameMatches -and $descriptionMatches -and -not $forbiddenCodexBranding)
        path = [string]$Spec.path
        displayName = $displayName
        expectedDisplayName = [string]$Spec.expectedDisplayName
        displayNameMatches = $displayNameMatches
        expectedScript = [string]$Spec.expectedScript
        expectedLauncherTarget = [string]$Spec.expectedLauncherTarget
        expectedIconLocation = [string]$Spec.expectedIconLocation
        expectedDescription = [string]$Spec.expectedDescription
        actualTarget = $actualTarget
        actualLauncherTarget = $actualLauncherTarget
        actualArguments = $actualArguments
        actualDescription = $actualDescription
        actualIconLocation = $actualIconLocation
        targetMatches = $targetMatches
        launcherTargetMatches = $launcherTargetMatches
        scriptMatches = $scriptMatches
        iconMatches = $iconMatches
        descriptionMatches = $descriptionMatches
        forbiddenCodexBranding = $forbiddenCodexBranding
    }
}

$shortcutEvidence = @($shortcutSpecs | ForEach-Object { Set-AntiCodexShortcut -Spec $_ })
$repaired = $shortcutEvidence

try { & ie4uinit.exe -show | Out-Null } catch {}

$result = [pscustomobject]@{
    ok = $true
    reportName = "shortcut-repair"
    repairedAt = [DateTime]::UtcNow.ToString("o")
    installRoot = $installRootFull
    repairedCount = @($repaired).Count
    residualShortcutCount = @($residualShortcutEvidence).Count
    removedResidualShortcutCount = @($residualShortcutEvidence | Where-Object { $_.action -eq "removed" }).Count
    reportedResidualShortcutCount = @($residualShortcutEvidence | Where-Object { $_.action -eq "reported" }).Count
    residualShortcuts = $residualShortcutEvidence
    shortcutEvidence = $shortcutEvidence
    shortcuts = $repaired
}
$reportPaths = Save-JsonReport $result "shortcut-repair"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
$result | ConvertTo-Json -Depth 8
