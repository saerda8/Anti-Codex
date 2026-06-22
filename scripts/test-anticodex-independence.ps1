[CmdletBinding()]
param(
    [string]$StateRoot = $(if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }),
    [string]$CodexHome = $(if ($env:CODEX_HOME_DIR) { $env:CODEX_HOME_DIR } else { Join-Path $StateRoot "codex-home-deepseek-app" }),
    [string]$SharedCodexHome = $(if ($env:DEEPCODEX_SHARED_CODEX_HOME) { $env:DEEPCODEX_SHARED_CODEX_HOME } elseif ($env:GLOBAL_CODEX_HOME) { $env:GLOBAL_CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" })
)

$ErrorActionPreference = "Stop"

$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Get-LinkTargetValue {
    param($Item)
    if (-not $Item) { return @() }
    $isLink = [bool]($Item.LinkType -or (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0))
    if (-not $isLink) { return @() }
    return @($Item.Target | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
}

function Get-PathState {
    param(
        [string]$RelPath,
        [bool]$RequiredLocalCopy = $false,
        [bool]$AllowedSharedLink = $false
    )

    $fullPath = Join-Path $CodexHome $RelPath
    $exists = Test-Path -LiteralPath $fullPath
    $item = $null
    $isLink = $false
    $target = $null
    $itemType = $null

    if ($exists) {
        $item = Get-Item -LiteralPath $fullPath -Force
        $isLink = [bool]($item.LinkType -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0))
        $target = Get-LinkTargetValue $item
        $itemType = if ($item.PSIsContainer) { "directory" } else { "file" }
    }

    if ($RequiredLocalCopy -and -not $exists) {
        Add-Failure "required Anti-Codex local snapshot missing: $RelPath"
    }
    if ($RequiredLocalCopy -and $isLink) {
        Add-Failure "required Anti-Codex local snapshot is linked: $RelPath"
    }

    [pscustomobject]@{
        relPath = $RelPath
        fullPath = $fullPath
        exists = $exists
        itemType = $itemType
        requiredLocalCopy = $RequiredLocalCopy
        allowedSharedLink = $AllowedSharedLink
        isLink = $isLink
        linkType = if ($item) { $item.LinkType } else { $null }
        target = $target
    }
}

$paths = @(
    Get-PathState -RelPath "skills" -RequiredLocalCopy $true
    Get-PathState -RelPath "cache\codex_app_directory" -RequiredLocalCopy $true
    Get-PathState -RelPath "cache\codex_apps_tools" -RequiredLocalCopy $true
    Get-PathState -RelPath "plugins" -RequiredLocalCopy $true
    Get-PathState -RelPath ".tmp\plugins" -RequiredLocalCopy $true
    Get-PathState -RelPath "computer-use" -RequiredLocalCopy $true
)

$remainingSharedLinks = @($paths | Where-Object { $_.isLink -and $_.allowedSharedLink })

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    stateRoot = $StateRoot
    codexHome = $CodexHome
    sharedCodexHome = $SharedCodexHome
    paths = $paths
    remainingSharedLinks = $remainingSharedLinks
    note = "Anti-Codex runtime snapshots must be local directories, not live links to the original Codex home."
}

$result | ConvertTo-Json -Depth 8 -Compress
if ($failures.Count -gt 0) { exit 1 }
