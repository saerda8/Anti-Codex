[CmdletBinding()]
param(
    [string]$StateRoot = $(Join-Path $env:APPDATA "anticodex"),
    [string]$RuntimeRoot = $(Join-Path $env:LOCALAPPDATA "Anti-Codex\runtime"),
    [string]$WorkspaceRoot = "G:\Trae-Project\Anti-Codex\deepcodex",
    [string]$BackupRoot = "",
    [int]$StopTimeoutSec = 8,
    [int]$RestartTimeoutSec = 120,
    [switch]$SkipProcessStop,
    [switch]$SkipRestart,
    [switch]$IncludeLogs,
    [switch]$AllowNonDefaultStateRoot,
    [switch]$WhatIfOnly
)

$ErrorActionPreference = "Stop"

function Normalize-Path {
    param([string]$Path)
    if (-not $Path) { return "" }
    return [IO.Path]::GetFullPath($Path)
}

function Test-IsUnderPath {
    param([string]$Path, [string]$Parent)
    $fullPath = Normalize-Path $Path
    $fullParent = (Normalize-Path $Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    return $fullPath.Equals($fullParent, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-UnderPath {
    param([string]$Path, [string]$Parent, [string]$Label)
    if (-not (Test-IsUnderPath -Path $Path -Parent $Parent)) {
        throw "refusing to touch $Label outside ${Parent}: $Path"
    }
}

function Read-JsonObject {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if (-not $text.Trim()) { return $null }
    return $text | ConvertFrom-Json -ErrorAction Stop
}

function Add-JsonProperty {
    param($Object, [string]$Name, $Value)
    if ($Object.PSObject.Properties.Name -contains $Name) {
        $Object.$Name = $Value
    } else {
        Add-Member -InputObject $Object -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Remove-JsonProperty {
    param($Object, [string]$Name)
    if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name) {
        $Object.PSObject.Properties.Remove($Name)
    }
}

function Get-JsonValue {
    param($Object, [string]$Name, $Fallback)
    if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name -and $null -ne $Object.$Name) {
        return $Object.$Name
    }
    return $Fallback
}

function ConvertTo-Array {
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Array]) { return @($Value) }
    return @($Value)
}

function Write-JsonFile {
    param($Object, [string]$Path)
    $json = $Object | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Move-IfExists {
    param([string]$Path, [string]$DestinationRoot, [string]$StateRootFull, [System.Collections.Generic.List[object]]$Moved)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $full = Normalize-Path $Path
    Assert-UnderPath -Path $full -Parent $StateRootFull -Label "conversation state"
    $name = Split-Path -Leaf $full
    if (-not $name) { $name = "root" }
    $destination = Join-Path $DestinationRoot $name
    $index = 1
    while (Test-Path -LiteralPath $destination) {
        $destination = Join-Path $DestinationRoot ("{0}.{1}" -f $name, $index)
        $index++
    }
    if (-not $WhatIfOnly) {
        Write-Verbose "moving $full -> $destination"
        if ((Get-Item -LiteralPath $full -Force).PSIsContainer) {
            [System.IO.Directory]::Move($full, $destination)
        } else {
            [System.IO.File]::Move($full, $destination)
        }
        Write-Verbose "moved $full"
    }
    $Moved.Add([pscustomobject]@{ from = $full; to = $destination }) | Out-Null
}

function Stop-ProcessList {
    param($Processes)
    foreach ($process in @($Processes)) {
        try {
            if ($process.ProcessId -ne $PID) {
                Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
}

function Wait-Until {
    param([scriptblock]$Predicate, [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSeconds))
    do {
        if (& $Predicate) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Get-AntiCodexProcesses {
    param([string]$RuntimeRootFull, [string]$StateRootFull)
    $localAppDataAntiCodex = Normalize-Path (Join-Path $env:LOCALAPPDATA "Anti-Codex")
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $pidValue = [int]$_.ProcessId
        if ($pidValue -eq $PID) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        $commandLine = [string]$_.CommandLine
        $isAntiCodexExe = $exe -and (Test-IsUnderPath -Path $exe -Parent $localAppDataAntiCodex)
        $usesAntiCodexState = $commandLine -and (
            $commandLine.IndexOf($StateRootFull, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $commandLine.IndexOf($RuntimeRootFull, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $commandLine.IndexOf("AppData\Roaming\anticodex", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $commandLine.IndexOf("AppData\Local\Anti-Codex", [StringComparison]::OrdinalIgnoreCase) -ge 0
        )
        return $isAntiCodexExe -or $usesAntiCodexState
    })
}

function Get-AntiCodexMainProcesses {
    $localAppDataAntiCodex = Normalize-Path (Join-Path $env:LOCALAPPDATA "Anti-Codex")
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        $commandLine = [string]$_.CommandLine
        return $_.Name -ieq "Anti-Codex.exe" -and
            (Test-IsUnderPath -Path $exe -Parent $localAppDataAntiCodex) -and
            ($commandLine -notmatch "\s--type=")
    })
}

function Get-OriginalCodexMainProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        $exe = Normalize-Path ([string]$_.ExecutablePath)
        $commandLine = [string]$_.CommandLine
        return ($_.Name -ieq "Codex.exe" -or $_.Name -ieq "ChatGPT.exe") -and
            ($exe.IndexOf("AppData\Local\Anti-Codex", [StringComparison]::OrdinalIgnoreCase) -lt 0) -and
            ($commandLine -notmatch "\s--type=")
    })
}

$stateRootFull = Normalize-Path $StateRoot
$runtimeRootFull = Normalize-Path $RuntimeRoot
$codexHomeFull = Normalize-Path (Join-Path $stateRootFull "codex-home-deepseek-app")
$defaultStateRoot = Normalize-Path (Join-Path $env:APPDATA "anticodex")
if (-not $AllowNonDefaultStateRoot -and -not $stateRootFull.Equals($defaultStateRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing non-default Anti-Codex state root without -AllowNonDefaultStateRoot: $stateRootFull"
}
Assert-UnderPath -Path $codexHomeFull -Parent $stateRootFull -Label "Anti-Codex CODEX_HOME"
if (-not (Test-Path -LiteralPath $stateRootFull -PathType Container)) {
    throw "Anti-Codex state root missing: $stateRootFull"
}
if (-not $BackupRoot) {
    $BackupRoot = Join-Path $stateRootFull "conversation-backups"
}
$backupRootFull = Normalize-Path $BackupRoot
Assert-UnderPath -Path $backupRootFull -Parent $stateRootFull -Label "conversation backup root"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $backupRootFull "cleanup-$stamp"
if (-not $WhatIfOnly) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

$moved = New-Object System.Collections.Generic.List[object]
$warnings = New-Object System.Collections.Generic.List[string]
$stoppedProcesses = @()
$stopTargets = @()
$wouldStopProcesses = @()
$originalCodexBefore = @()
$antiCodexWasRunning = $false

if (-not $SkipProcessStop) {
    $antiCodexWasRunning = @(Get-AntiCodexMainProcesses).Count -gt 0
    $originalCodexBefore = @(Get-OriginalCodexMainProcesses | ForEach-Object { [int]$_.ProcessId })
    $stopTargets = @(Get-AntiCodexProcesses -RuntimeRootFull $runtimeRootFull -StateRootFull $stateRootFull)
    $wouldStopProcesses = @($stopTargets | ForEach-Object {
        [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; executablePath = [string]$_.ExecutablePath }
    })
    $stopPids = @($stopTargets | ForEach-Object { [int]$_.ProcessId })
    $intersection = @($originalCodexBefore | Where-Object { $stopPids -contains $_ })
    if ($intersection.Count -gt 0) {
        throw "refusing to stop original Codex process ids: $($intersection -join ', ')"
    }
    if (-not $WhatIfOnly) {
        Stop-ProcessList $stopTargets
        $stopped = Wait-Until -TimeoutSeconds $StopTimeoutSec -Predicate {
            @(Get-AntiCodexProcesses -RuntimeRootFull $runtimeRootFull -StateRootFull $stateRootFull).Count -eq 0
        }
        $stoppedProcesses = @($wouldStopProcesses)
        if (-not $stopped) {
            $warnings.Add("some Anti-Codex processes were still visible after stop timeout") | Out-Null
        }
    }
}

$globalStatePath = Join-Path $stateRootFull ".codex-global-state.json"
$globalStateBakPath = "$globalStatePath.bak"
$codexGlobalStatePath = Join-Path $codexHomeFull ".codex-global-state.json"
$codexGlobalStateBakPath = "$codexGlobalStatePath.bak"
$globalState = Read-JsonObject $globalStatePath
$globalStateBak = Read-JsonObject $globalStateBakPath
$codexGlobalState = Read-JsonObject $codexGlobalStatePath
$codexGlobalStateBak = Read-JsonObject $codexGlobalStateBakPath
$workspaceRootFull = if ($WorkspaceRoot) { Normalize-Path $WorkspaceRoot } else { "" }

$savedWorkspaceRoots = @(ConvertTo-Array -Value (Get-JsonValue $globalState "electron-saved-workspace-roots" (Get-JsonValue $globalStateBak "electron-saved-workspace-roots" (Get-JsonValue $codexGlobalState "electron-saved-workspace-roots" (Get-JsonValue $codexGlobalStateBak "electron-saved-workspace-roots" @())))))
$activeWorkspaceRoots = @(ConvertTo-Array -Value (Get-JsonValue $globalState "active-workspace-roots" (Get-JsonValue $globalStateBak "active-workspace-roots" (Get-JsonValue $codexGlobalState "active-workspace-roots" (Get-JsonValue $codexGlobalStateBak "active-workspace-roots" @())))))
$workspaceRootLabels = Get-JsonValue $globalState "electron-workspace-root-labels" (Get-JsonValue $globalStateBak "electron-workspace-root-labels" (Get-JsonValue $codexGlobalState "electron-workspace-root-labels" (Get-JsonValue $codexGlobalStateBak "electron-workspace-root-labels" ([pscustomobject]@{}))))
$projectOrder = @(ConvertTo-Array -Value (Get-JsonValue $globalState "project-order" (Get-JsonValue $globalStateBak "project-order" (Get-JsonValue $codexGlobalState "project-order" (Get-JsonValue $codexGlobalStateBak "project-order" @())))))
if ($workspaceRootFull -and (Test-Path -LiteralPath $workspaceRootFull -PathType Container)) {
    $savedWorkspaceRoots = @($savedWorkspaceRoots + $workspaceRootFull | Where-Object { $_ } | Select-Object -Unique)
    $activeWorkspaceRoots = @($activeWorkspaceRoots + $workspaceRootFull | Where-Object { $_ } | Select-Object -Unique)
    $projectOrder = @($projectOrder + $workspaceRootFull | Where-Object { $_ } | Select-Object -Unique)
    $workspaceLabel = "Anti-Codex"
    if ($workspaceRootLabels.PSObject.Properties.Name -contains $workspaceRootFull) {
        if ([string]$workspaceRootLabels.$workspaceRootFull -ieq "deepcodex") {
            $workspaceRootLabels.$workspaceRootFull = $workspaceLabel
        }
    } else {
        Add-JsonProperty -Object $workspaceRootLabels -Name $workspaceRootFull -Value $workspaceLabel
    }
}

Move-IfExists -Path $globalStatePath -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path $globalStateBakPath -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path $codexGlobalStatePath -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path $codexGlobalStateBakPath -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "response-history.json") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "sessions") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "sessions") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "state_5.sqlite") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "state_5.sqlite-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "state_5.sqlite-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "state_5.sqlite") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "state_5.sqlite-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "state_5.sqlite-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "sqlite\codex-dev.db") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "sqlite\codex-dev.db-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "sqlite\codex-dev.db-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "sqlite\codex-dev.db") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "sqlite\codex-dev.db-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $codexHomeFull "sqlite\codex-dev.db-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "translator-lifecycle.json") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
Move-IfExists -Path (Join-Path $stateRootFull "translator-lifecycle.jsonl") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved

if ($IncludeLogs) {
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs_2.sqlite") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs_2.sqlite-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs_2.sqlite-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs\logs_2.sqlite") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs\logs_2.sqlite-wal") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $stateRootFull "codex-home-deepseek-app\logs\logs_2.sqlite-shm") -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    $warnings.Add("logs were cleared; re-run protect-anticodex-log-db.mjs after Anti-Codex recreates the log database") | Out-Null
}

$electronDefault = Join-Path $stateRootFull "electron-user-data-adaptive\Default"
$codexHomeElectronDefault = Join-Path $codexHomeFull "electron-user-data-adaptive\Default"
foreach ($name in @("Local Storage", "Session Storage", "Sessions", "History", "History-journal")) {
    Move-IfExists -Path (Join-Path $electronDefault $name) -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
    Move-IfExists -Path (Join-Path $codexHomeElectronDefault $name) -DestinationRoot $backupDir -StateRootFull $stateRootFull -Moved $moved
}

if (-not $WhatIfOnly) {
    New-Item -ItemType Directory -Path (Join-Path $stateRootFull "sessions") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stateRootFull "sqlite") -Force | Out-Null
    New-Item -ItemType Directory -Path $codexHomeFull -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $codexHomeFull "sessions") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $codexHomeFull "sqlite") -Force | Out-Null
    New-Item -ItemType Directory -Path $electronDefault -Force | Out-Null
    New-Item -ItemType Directory -Path $codexHomeElectronDefault -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $stateRootFull "response-history.json"), '{"entries":[]}', [System.Text.UTF8Encoding]::new($false))

    $newGlobalState = if ($codexGlobalState) { $codexGlobalState } elseif ($globalState) { $globalState } else { [pscustomobject]@{} }
    foreach ($propertyName in @($newGlobalState.PSObject.Properties.Name | Where-Object { $_ -like "thread-client-id-v1:*" })) {
        Remove-JsonProperty -Object $newGlobalState -Name $propertyName
    }
    Add-JsonProperty -Object $newGlobalState -Name "electron-saved-workspace-roots" -Value @($savedWorkspaceRoots)
    Add-JsonProperty -Object $newGlobalState -Name "active-workspace-roots" -Value @($activeWorkspaceRoots)
    Add-JsonProperty -Object $newGlobalState -Name "electron-workspace-root-labels" -Value $workspaceRootLabels
    Add-JsonProperty -Object $newGlobalState -Name "project-order" -Value @($projectOrder)
    Add-JsonProperty -Object $newGlobalState -Name "thread-client-id-v1" -Value $null
    Add-JsonProperty -Object $newGlobalState -Name "unread-thread-ids-by-host-v1" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "heartbeat-thread-permissions-by-id" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "projectless-thread-ids" -Value @()
    Add-JsonProperty -Object $newGlobalState -Name "thread-workspace-root-hints" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "thread-projectless-output-directories" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "prompt-history" -Value ([pscustomobject]@{ global = @() })
    Add-JsonProperty -Object $newGlobalState -Name "composer-drafts" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "composer-prompt-drafts-v1" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $newGlobalState -Name "composer-auto-context-enabled" -Value $false
    Add-JsonProperty -Object $newGlobalState -Name "onboarding-completed" -Value $true
    Add-JsonProperty -Object $newGlobalState -Name "electron:onboarding-override" -Value "app"
    Add-JsonProperty -Object $newGlobalState -Name "electron:onboarding-projectless-completed" -Value $true
    Add-JsonProperty -Object $newGlobalState -Name "electron:onboarding-welcome-pending" -Value $false
    Add-JsonProperty -Object $newGlobalState -Name "permissions-mode" -Value "full-access"
    $atomState = Get-JsonValue $newGlobalState "electron-persisted-atom-state" ([pscustomobject]@{})
    foreach ($propertyName in @($atomState.PSObject.Properties.Name | Where-Object { $_ -like "thread-client-id-v1:*" })) {
        Remove-JsonProperty -Object $atomState -Name $propertyName
    }
    Add-JsonProperty -Object $atomState -Name "composer-permission-mode-visibility" -Value ([pscustomobject]@{
        "guardian-approvals" = $true
        "full-access" = $true
    })
    Add-JsonProperty -Object $atomState -Name "skip-full-access-confirm" -Value $true
    Add-JsonProperty -Object $atomState -Name "agent-mode-by-host-id" -Value ([pscustomobject]@{ local = "full-access" })
    Add-JsonProperty -Object $atomState -Name "heartbeat-thread-permissions-by-id" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $atomState -Name "composer-prompt-drafts-v1" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $atomState -Name "unread-thread-ids-by-host-v1" -Value ([pscustomobject]@{ local = @() })
    Add-JsonProperty -Object $atomState -Name "projectless-thread-ids" -Value @()
    Add-JsonProperty -Object $atomState -Name "thread-workspace-root-hints" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $atomState -Name "thread-projectless-output-directories" -Value ([pscustomobject]@{})
    Add-JsonProperty -Object $atomState -Name "composer-auto-context-enabled" -Value $false
    Add-JsonProperty -Object $atomState -Name "electron:onboarding-override" -Value "app"
    Add-JsonProperty -Object $atomState -Name "electron:onboarding-projectless-completed" -Value $true
    Add-JsonProperty -Object $atomState -Name "electron:onboarding-welcome-pending" -Value $false
    Add-JsonProperty -Object $newGlobalState -Name "electron-persisted-atom-state" -Value $atomState
    Write-JsonFile -Object $newGlobalState -Path $globalStatePath
    Copy-Item -LiteralPath $globalStatePath -Destination $globalStateBakPath -Force
    Write-JsonFile -Object $newGlobalState -Path $codexGlobalStatePath
    Copy-Item -LiteralPath $codexGlobalStatePath -Destination $codexGlobalStateBakPath -Force
}

$restartRequested = $antiCodexWasRunning -and -not $WhatIfOnly -and -not $SkipRestart
$restartSucceeded = $false
$restartError = ""
$restartedProcessIds = @()
$restartLauncherProcessId = 0
if ($antiCodexWasRunning -and -not $WhatIfOnly -and -not $SkipRestart) {
    $installedLauncher = Join-Path $runtimeRootFull "scripts\start-anticodex.ps1"
    try {
        if (-not (Test-Path -LiteralPath $installedLauncher -PathType Leaf)) {
            throw "installed Anti-Codex launcher missing: $installedLauncher"
        }
        $powershellExe = Join-Path $PSHOME "powershell.exe"
        $launcherArgs = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", ('"{0}"' -f $installedLauncher),
            "-SkipUpdateCheck",
            "-InlineSupervisor"
        )
        $launcherProcess = Start-Process -FilePath $powershellExe -ArgumentList $launcherArgs -WindowStyle Hidden -PassThru
        $restartLauncherProcessId = [int]$launcherProcess.Id
        $restartSucceeded = Wait-Until -TimeoutSeconds $RestartTimeoutSec -Predicate {
            @(Get-AntiCodexMainProcesses).Count -gt 0
        }
        if (-not $restartSucceeded) {
            $launcherProcess.Refresh()
            $launcherStatus = if ($launcherProcess.HasExited) { "launcher exit code $($launcherProcess.ExitCode)" } else { "launcher still running" }
            throw "Anti-Codex main process did not return within $RestartTimeoutSec seconds ($launcherStatus)"
        }
        $restartedProcessIds = @(Get-AntiCodexMainProcesses | ForEach-Object { [int]$_.ProcessId })
    } catch {
        $restartError = $_.Exception.Message
        $warnings.Add("Anti-Codex restart failed: $restartError") | Out-Null
    }
}

$originalCodexAfter = @()
if (-not $SkipProcessStop) {
    $originalCodexAfter = @(Get-OriginalCodexMainProcesses | ForEach-Object { [int]$_.ProcessId })
}
$result = [pscustomobject]@{
    ok = -not ($restartRequested -and -not $restartSucceeded)
    whatIfOnly = [bool]$WhatIfOnly
    stateRoot = $stateRootFull
    backupDir = $backupDir
    wouldStopProcessCount = @($wouldStopProcesses).Count
    wouldStopProcesses = @($wouldStopProcesses)
    stoppedProcessCount = @($stoppedProcesses).Count
    stoppedProcesses = @($stoppedProcesses)
    moved = @($moved.ToArray())
    preservedWorkspaceRoots = @($activeWorkspaceRoots)
    preservedProjectOrder = @($projectOrder)
    responseHistoryReset = -not $WhatIfOnly
    originalCodexBefore = @($originalCodexBefore)
    originalCodexAfter = @($originalCodexAfter)
    antiCodexWasRunning = [bool]$antiCodexWasRunning
    restartRequested = [bool]$restartRequested
    restartSucceeded = [bool]$restartSucceeded
    restartedProcessIds = @($restartedProcessIds)
    restartLauncherProcessId = $restartLauncherProcessId
    restartError = $restartError
    warnings = @($warnings.ToArray())
}
$result | ConvertTo-Json -Depth 12 -Compress
if (-not $result.ok) { exit 1 }
