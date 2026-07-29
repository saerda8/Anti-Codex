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
$powershell = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
$interactivePowerShell = $powershell
$interactivePowerShellCandidate = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\pwsh.exe" } else { "" }
if ($interactivePowerShellCandidate -and (Test-Path -LiteralPath $interactivePowerShellCandidate -PathType Leaf)) {
    $interactivePowerShell = [IO.Path]::GetFullPath($interactivePowerShellCandidate)
}
$schtasks = Join-Path ([Environment]::SystemDirectory) "schtasks.exe"
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
$node = if ($nodeCommand) { [IO.Path]::GetFullPath([string]$nodeCommand.Source) } else { "" }
$launchTaskName = "Anti-Codex Launcher"
$updateTaskName = "Anti-Codex Updater"
$hideConsoleScript = Join-Path $runtimeRoot "scripts\hide-anticodex-console.ps1"
$launchTaskScript = Join-Path $runtimeRoot "scripts\start-anticodex-task.mjs"
$shortcutBrokerScript = Join-Path $runtimeRoot "scripts\start-anticodex-shortcut-broker.ps1"
$launchTaskActionArguments = "`"$launchTaskScript`" --hide-console"
$updateTaskScript = Join-Path $runtimeRoot "scripts\start-anticodex-update-task.mjs"
$launchTaskShortcutArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$shortcutBrokerScript`" -InstallRoot `"$installRootFull`""
$updateTaskActionArguments = "`"$updateTaskScript`" --hide-console"
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
        [Parameter(Mandatory = $true)][string]$Icon,
        [switch]$InlineSupervisor,
        [switch]$UseLaunchTask
    )
    $displayName = Split-Path -Leaf $Path
    $expectedArguments = if ($UseLaunchTask) {
        $launchTaskShortcutArguments
    } else {
        $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""
        if ($InlineSupervisor) { $arguments += " -InlineSupervisor" }
        $arguments
    }
    [pscustomobject]@{
        path = $Path
        displayName = $displayName
        expectedDisplayName = $displayName
        expectedTarget = if ($UseLaunchTask) { $interactivePowerShell } else { $powershell }
        expectedScript = $Script
        expectedLauncherTarget = $Script
        expectedArguments = $expectedArguments
        expectedDescription = $Description
        expectedIconLocation = "$Icon,0"
        iconSource = $Icon
        inlineSupervisor = [bool]$InlineSupervisor
        launchMode = if ($UseLaunchTask) { "shortcut-broker" } else { "powershell-direct" }
        useNativeLauncher = $false
    }
}

$script:antiCodexScheduleService = $null
$script:antiCodexScheduleRoot = $null

function Get-AntiCodexScheduleRoot {
    if ($null -eq $script:antiCodexScheduleService -or $null -eq $script:antiCodexScheduleRoot) {
        $service = New-Object -ComObject "Schedule.Service"
        $service.Connect()
        $script:antiCodexScheduleService = $service
        $script:antiCodexScheduleRoot = $service.GetFolder("\")
    }
    return $script:antiCodexScheduleRoot
}

function Get-AntiCodexRegisteredTask {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    return (Get-AntiCodexScheduleRoot).GetTask("\$TaskName")
}

function Set-AntiCodexExistingTaskAction {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$Arguments
    )

    $action = New-ScheduledTaskAction -Execute $node -Argument $Arguments -WorkingDirectory $installRootFull
    Set-ScheduledTask -TaskPath "\" -TaskName $TaskName -Action $action -ErrorAction Stop | Out-Null
}

function Get-AntiCodexTaskStateName {
    param([int]$State)
    switch ($State) {
        1 { return "Disabled" }
        2 { return "Queued" }
        3 { return "Ready" }
        4 { return "Running" }
        default { return "Unknown" }
    }
}

function Get-AntiCodexLaunchTaskEvidence {
    try {
        $task = Get-AntiCodexRegisteredTask -TaskName $launchTaskName
    } catch {
        return [pscustomobject]@{
            ok = $false
            exists = $false
            taskName = $launchTaskName
            expectedScript = $launchTaskScript
            actualScript = ""
            error = $_.Exception.Message
        }
    }

    $definition = $task.Definition
    $actionCount = [int]$definition.Actions.Count
    $action = if ($actionCount -eq 1) { $definition.Actions.Item(1) } else { $null }
    $actualExecute = if ($action) { [string]$action.Path } else { "" }
    $actualArguments = if ($action) { [string]$action.Arguments } else { "" }
    $actualWorkingDirectory = if ($action) { [string]$action.WorkingDirectory } else { "" }
    $argumentMatch = [regex]::Match($actualArguments, '^"([^"]+)"\s+--hide-console$')
    $actualScript = if ($argumentMatch.Success) { $argumentMatch.Groups[1].Value } else { "" }
    try { $actualScript = [IO.Path]::GetFullPath($actualScript) } catch {}
    $actionMatches = (
        $actualExecute -ieq $node -and
        $actualArguments -ceq $launchTaskActionArguments -and
        $actualWorkingDirectory -ieq $installRootFull -and
        $actualScript -ieq $launchTaskScript
    )
    $currentUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $currentShortUserName = ($currentUserName -split "\\")[-1]
    $taskUserName = [string]$definition.Principal.UserId
    $principalMatches = (
        ($taskUserName -ieq $currentUserName -or $taskUserName -ieq $currentShortUserName) -and
        [int]$definition.Principal.LogonType -eq 3 -and
        [int]$definition.Principal.RunLevel -eq 0
    )
    $settingsMatch = (
        [bool]$task.Enabled -and
        [int]$definition.Triggers.Count -eq 0 -and
        [int]$definition.Settings.MultipleInstances -eq 2 -and
        [bool]$definition.Settings.AllowDemandStart -and
        [bool]$definition.Settings.AllowHardTerminate -and
        -not [bool]$definition.Settings.RunOnlyIfIdle -and
        -not [bool]$definition.Settings.RunOnlyIfNetworkAvailable -and
        [bool]$definition.Settings.DisallowStartIfOnBatteries -eq $false -and
        [bool]$definition.Settings.StopIfGoingOnBatteries -eq $false -and
        [int]$definition.Settings.Priority -eq 4 -and
        [int]$definition.Settings.RestartCount -eq 0 -and
        [string]$definition.Settings.ExecutionTimeLimit -eq "PT0S"
    )
    $stateCode = [int]$task.State
    return [pscustomobject]@{
        ok = ($actionMatches -and $principalMatches -and $settingsMatch)
        exists = $true
        taskName = $launchTaskName
        expectedExecute = $node
        actualExecute = $actualExecute
        expectedArguments = $launchTaskActionArguments
        actualArguments = $actualArguments
        expectedWorkingDirectory = $installRootFull
        actualWorkingDirectory = $actualWorkingDirectory
        expectedScript = $launchTaskScript
        actualScript = $actualScript
        taskScript = $launchTaskScript
        actionMatches = $actionMatches
        principalMatches = $principalMatches
        settingsMatch = $settingsMatch
        state = (Get-AntiCodexTaskStateName -State $stateCode)
        stateCode = $stateCode
        error = ""
    }
}

function Set-AntiCodexLaunchTask {
    $existing = Get-AntiCodexLaunchTaskEvidence
    if ($existing.ok) { return $existing }

    $actionUpdateError = ""
    if ($existing.exists) {
        try {
            Set-AntiCodexExistingTaskAction -TaskName $launchTaskName -Arguments $launchTaskActionArguments
            $updated = Get-AntiCodexLaunchTaskEvidence
            if ($updated.ok) { return $updated }
        } catch {
            $actionUpdateError = $_.Exception.Message
        }
    }

    $taskXmlPath = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-launch-task-" + [Guid]::NewGuid().ToString("N") + ".xml")
    try {
        $sidXml = [Security.SecurityElement]::Escape([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
        $nodeXml = [Security.SecurityElement]::Escape($node)
        $argumentsXml = [Security.SecurityElement]::Escape($launchTaskActionArguments)
        $workingDirectoryXml = [Security.SecurityElement]::Escape($installRootFull)
        $taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Launch Anti-Codex outside the native Codex process job.</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>$sidXml</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Priority>4</Priority>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
  </Settings>
  <Triggers />
  <Actions Context="Author">
    <Exec>
      <Command>$nodeXml</Command>
      <Arguments>$argumentsXml</Arguments>
      <WorkingDirectory>$workingDirectoryXml</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
        [IO.File]::WriteAllText($taskXmlPath, $taskXml, [Text.UnicodeEncoding]::new($false, $true))
        $taskOutput = @(& $schtasks /Create /TN $launchTaskName /XML $taskXmlPath /F 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw (($taskOutput | ForEach-Object { [string]$_ }) -join " ")
        }
    } catch {
        $registrationError = $_.Exception.Message
        if ($actionUpdateError) {
            $registrationError = "Existing task action update failed: $actionUpdateError Full task registration failed: $registrationError"
        }
        return [pscustomobject]@{
            ok = $false
            exists = $false
            taskName = $launchTaskName
            expectedScript = $startScript
            actualScript = ""
            error = $registrationError
        }
    } finally {
        if (Test-Path -LiteralPath $taskXmlPath -PathType Leaf) {
            Remove-Item -LiteralPath $taskXmlPath -Force -ErrorAction SilentlyContinue
        }
    }
    return Get-AntiCodexLaunchTaskEvidence
}

function Get-AntiCodexUpdateTaskEvidence {
    try {
        $task = Get-AntiCodexRegisteredTask -TaskName $updateTaskName
    } catch {
        return [pscustomobject]@{
            ok = $false
            exists = $false
            taskName = $updateTaskName
            expectedScript = $updateTaskScript
            error = $_.Exception.Message
        }
    }

    $definition = $task.Definition
    $actionCount = [int]$definition.Actions.Count
    $action = if ($actionCount -eq 1) { $definition.Actions.Item(1) } else { $null }
    $actualExecute = if ($action) { [string]$action.Path } else { "" }
    $actualArguments = if ($action) { [string]$action.Arguments } else { "" }
    $actualWorkingDirectory = if ($action) { [string]$action.WorkingDirectory } else { "" }
    $argumentMatch = [regex]::Match($actualArguments, '^"([^"]+)"\s+--hide-console$')
    $actualScript = if ($argumentMatch.Success) { $argumentMatch.Groups[1].Value } else { "" }
    try { $actualScript = [IO.Path]::GetFullPath($actualScript) } catch {}
    $currentUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $currentShortUserName = ($currentUserName -split "\\")[-1]
    $taskUserName = [string]$definition.Principal.UserId
    $actionMatches = (
        $actionCount -eq 1 -and
        $actualExecute -ieq $node -and
        $actualArguments -ceq $updateTaskActionArguments -and
        $actualWorkingDirectory -ieq $installRootFull -and
        $actualScript -ieq $updateTaskScript
    )
    $principalMatches = (
        ($taskUserName -ieq $currentUserName -or $taskUserName -ieq $currentShortUserName) -and
        [int]$definition.Principal.LogonType -eq 3 -and
        [int]$definition.Principal.RunLevel -eq 0
    )
    $settingsMatch = (
        [bool]$task.Enabled -and
        [int]$definition.Triggers.Count -eq 0 -and
        [int]$definition.Settings.MultipleInstances -eq 2 -and
        [bool]$definition.Settings.AllowDemandStart -and
        [bool]$definition.Settings.AllowHardTerminate -and
        -not [bool]$definition.Settings.RunOnlyIfIdle -and
        -not [bool]$definition.Settings.RunOnlyIfNetworkAvailable -and
        [bool]$definition.Settings.DisallowStartIfOnBatteries -eq $false -and
        [bool]$definition.Settings.StopIfGoingOnBatteries -eq $false -and
        [int]$definition.Settings.RestartCount -eq 0 -and
        [string]$definition.Settings.ExecutionTimeLimit -eq "PT0S"
    )
    $stateCode = [int]$task.State
    return [pscustomobject]@{
        ok = ($actionMatches -and $principalMatches -and $settingsMatch)
        exists = $true
        taskName = $updateTaskName
        expectedExecute = $node
        actualExecute = $actualExecute
        expectedArguments = $updateTaskActionArguments
        actualArguments = $actualArguments
        expectedWorkingDirectory = $installRootFull
        actualWorkingDirectory = $actualWorkingDirectory
        expectedScript = $updateTaskScript
        actualScript = $actualScript
        actionMatches = $actionMatches
        principalMatches = $principalMatches
        settingsMatch = $settingsMatch
        state = (Get-AntiCodexTaskStateName -State $stateCode)
        stateCode = $stateCode
        error = ""
    }
}

function Set-AntiCodexUpdateTask {
    $existing = Get-AntiCodexUpdateTaskEvidence
    if ($existing.ok) { return $existing }

    $actionUpdateError = ""
    if ($existing.exists) {
        try {
            Set-AntiCodexExistingTaskAction -TaskName $updateTaskName -Arguments $updateTaskActionArguments
            $updated = Get-AntiCodexUpdateTaskEvidence
            if ($updated.ok) { return $updated }
        } catch {
            $actionUpdateError = $_.Exception.Message
        }
    }

    $taskXmlPath = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-update-task-" + [Guid]::NewGuid().ToString("N") + ".xml")
    try {
        $sidXml = [Security.SecurityElement]::Escape([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
        $nodeXml = [Security.SecurityElement]::Escape($node)
        $argumentsXml = [Security.SecurityElement]::Escape($updateTaskActionArguments)
        $workingDirectoryXml = [Security.SecurityElement]::Escape($installRootFull)
        $taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Update Anti-Codex outside the running Anti-Codex process job.</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>$sidXml</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
  </Settings>
  <Triggers />
  <Actions Context="Author">
    <Exec>
      <Command>$nodeXml</Command>
      <Arguments>$argumentsXml</Arguments>
      <WorkingDirectory>$workingDirectoryXml</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
        [IO.File]::WriteAllText($taskXmlPath, $taskXml, [Text.UnicodeEncoding]::new($false, $true))
        $taskOutput = @(& $schtasks /Create /TN $updateTaskName /XML $taskXmlPath /F 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw (($taskOutput | ForEach-Object { [string]$_ }) -join " ")
        }
    } catch {
        $registrationError = $_.Exception.Message
        if ($actionUpdateError) {
            $registrationError = "Existing task action update failed: $actionUpdateError Full task registration failed: $registrationError"
        }
        return [pscustomobject]@{
            ok = $false
            exists = $false
            taskName = $updateTaskName
            expectedScript = $updateTaskScript
            error = $registrationError
        }
    } finally {
        if (Test-Path -LiteralPath $taskXmlPath -PathType Leaf) {
            Remove-Item -LiteralPath $taskXmlPath -Force -ErrorAction SilentlyContinue
        }
    }
    return Get-AntiCodexUpdateTaskEvidence
}

$shortcutSpecs = @(
    New-AntiCodexShortcutSpec -Path (Join-Path $desktop "Anti-Codex.lnk") -Script $shortcutBrokerScript -Description "Anti-Codex - Codex Desktop powered by Antigravity" -Icon $desktopShortcutIcon -UseLaunchTask
    New-AntiCodexShortcutSpec -Path (Join-Path $startMenuDir "Anti-Codex.lnk") -Script $shortcutBrokerScript -Description "Anti-Codex - Codex Desktop powered by Antigravity" -Icon $hostIcon -UseLaunchTask
    New-AntiCodexShortcutSpec -Path (Join-Path $startMenuDir "Sync Anti-Codex with Codex.lnk") -Script $syncScript -Description "Rebuild Anti-Codex from the installed Codex Desktop host after Codex updates" -Icon $hostIcon
    New-AntiCodexShortcutSpec -Path (Join-Path $startMenuDir "Rollback Anti-Codex.lnk") -Script $rollbackScript -Description "Rollback Anti-Codex to the previous patched Codex host version" -Icon $hostIcon
    New-AntiCodexShortcutSpec -Path (Join-Path $startMenuDir "Manage Anti-Codex.lnk") -Script $managerScript -Description "Open the Anti-Codex maintenance and account manager" -Icon $hostIcon
)
$protectedShortcutPaths = @{}
foreach ($spec in $shortcutSpecs) {
    $protectedShortcutPaths[[IO.Path]::GetFullPath([string]$spec.path).ToLowerInvariant()] = $true
}
$residualShortcutNames = @(
    "Anti-Codex.lnk",
    "Codex.lnk",
    "Codex Desktop.lnk",
    "DeepCodex.lnk",
    "DeepCodex Desktop.lnk"
)
$legacyDeepCodexStartMenuDir = Join-Path $programs "DeepCodex"
$residualShortcutRoots = @(
    [pscustomobject]@{ path = $desktop; location = "desktop"; removeCodexByName = $false },
    [pscustomobject]@{ path = $programs; location = "start-menu-root"; removeCodexByName = $false },
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
            $action = if ($shouldRemove) { "removed" } else { "preserved-native-codex" }
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
$residualShortcutFailures = @($residualShortcutEvidence | Where-Object { $_.action -ne "removed" -and $_.action -ne "preserved-native-codex" })
$failures = New-Object System.Collections.Generic.List[string]
foreach ($path in @($startScript, $hideConsoleScript, $launchTaskScript, $shortcutBrokerScript, $updateTaskScript, $syncScript, $rollbackScript, $managerScript, $hostIcon, $desktopShortcutIcon, $node, $powershell, $schtasks)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $failures.Add("Required Anti-Codex shortcut target is missing: $path") | Out-Null
    }
}
$launchTaskEvidence = if ($failures.Count -eq 0) { Set-AntiCodexLaunchTask } else { $null }
if ($null -ne $launchTaskEvidence -and -not $launchTaskEvidence.ok) {
    $launchTaskError = if ($launchTaskEvidence.error) { [string]$launchTaskEvidence.error } else { "task contract mismatch" }
    $failures.Add("Anti-Codex launch task could not be installed or verified: $launchTaskError") | Out-Null
}
$updateTaskEvidence = if ($failures.Count -eq 0) { Set-AntiCodexUpdateTask } else { $null }
if ($null -ne $updateTaskEvidence -and -not $updateTaskEvidence.ok) {
    $updateTaskError = if ($updateTaskEvidence.error) { [string]$updateTaskEvidence.error } else { "task contract mismatch" }
    $failures.Add("Anti-Codex update task could not be installed or verified: $updateTaskError") | Out-Null
}
foreach ($residual in $residualShortcutFailures) {
    if ($residual.action -eq "reported") {
        $failures.Add("Residual shortcut requires manual review: $($residual.path)") | Out-Null
    } else {
        $failures.Add("Residual shortcut could not be removed: $($residual.path)") | Out-Null
    }
}
$nativeLauncherBuild = [pscustomobject]@{
    path = $null
    mode = "shortcut-focus-broker"
    reason = "Focus the exact installed Anti-Codex window, or start it through the isolated Windows launch task."
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
        preservedNativeCodexShortcutCount = @($residualShortcutEvidence | Where-Object { $_.action -eq "preserved-native-codex" }).Count
        failures = $failures.ToArray()
        residualShortcuts = $residualShortcutEvidence
        nativeLauncher = $nativeLauncherBuild
        launchTask = $launchTaskEvidence
        updateTask = $updateTaskEvidence
        shortcutEvidence = @()
        shortcuts = @()
    }
    $reportPaths = Save-JsonReport $result "shortcut-repair"
    $result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
    $result | ConvertTo-Json -Depth 8
    exit 1
}

function Get-AntiCodexShortcutEvidence {
    param(
        [Parameter(Mandatory = $true)]$Spec
    )

    $shortcutPath = [string]$Spec.path
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { return $null }

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    try {
        $actualTarget = [string]$shortcut.TargetPath
        $actualArguments = [string]$shortcut.Arguments
        $actualDescription = [string]$shortcut.Description
        $actualIconLocation = [string]$shortcut.IconLocation
    } finally {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }

    $actualLauncherTarget = if ([string]$Spec.launchMode -eq "scheduled-task") {
        if ($launchTaskEvidence) { [string]$launchTaskEvidence.actualScript } else { "" }
    } else {
        Get-AntiCodexShortcutLauncherTarget $actualArguments
    }
    $displayName = Split-Path -Leaf $shortcutPath
    $launcherTargetMatches = ($actualLauncherTarget -and ($actualLauncherTarget -ieq [string]$Spec.expectedLauncherTarget))
    $scriptMatches = $launcherTargetMatches
    $argumentsMatches = ($actualArguments -ceq [string]$Spec.expectedArguments)
    $iconMatches = ($actualIconLocation -ieq [string]$Spec.expectedIconLocation)
    $displayNameMatches = ($displayName -ceq [string]$Spec.expectedDisplayName)
    $targetMatches = ($actualTarget -ieq [string]$Spec.expectedTarget)
    $descriptionMatches = ($actualDescription -eq [string]$Spec.expectedDescription)
    $forbiddenCodexBranding = ($displayName -notmatch "Anti-Codex") -or (($actualDescription -match "^Codex(\s|$)") -and ($actualDescription -notmatch "Anti-Codex"))

    return [pscustomobject]@{
        ok = ($targetMatches -and $scriptMatches -and $argumentsMatches -and $iconMatches -and $displayNameMatches -and $descriptionMatches -and -not $forbiddenCodexBranding)
        path = $shortcutPath
        displayName = $displayName
        expectedDisplayName = [string]$Spec.expectedDisplayName
        displayNameMatches = $displayNameMatches
        launchMode = [string]$Spec.launchMode
        expectedTarget = [string]$Spec.expectedTarget
        expectedScript = [string]$Spec.expectedScript
        expectedLauncherTarget = [string]$Spec.expectedLauncherTarget
        expectedArguments = [string]$Spec.expectedArguments
        expectedIconLocation = [string]$Spec.expectedIconLocation
        expectedDescription = [string]$Spec.expectedDescription
        actualTarget = $actualTarget
        actualLauncherTarget = $actualLauncherTarget
        actualArguments = $actualArguments
        actualDescription = $actualDescription
        actualIconLocation = $actualIconLocation
        useNativeLauncher = $false
        targetMatches = $targetMatches
        launcherTargetMatches = $launcherTargetMatches
        scriptMatches = $scriptMatches
        argumentsMatches = $argumentsMatches
        iconMatches = $iconMatches
        descriptionMatches = $descriptionMatches
        forbiddenCodexBranding = $forbiddenCodexBranding
    }
}

function Set-AntiCodexShortcut {
    param(
        [Parameter(Mandatory = $true)]$Spec
    )

    $parent = Split-Path -Parent ([string]$Spec.path)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $existingEvidence = Get-AntiCodexShortcutEvidence -Spec $Spec
    if ($existingEvidence -and $existingEvidence.ok) { return $existingEvidence }

    $shortcutPath = [string]$Spec.path
    $pendingShortcut = Join-Path $parent ((Split-Path -Leaf $shortcutPath) + ".pending." + [Guid]::NewGuid().ToString("N") + ".lnk")
    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($pendingShortcut)
        $shortcut.TargetPath = [string]$Spec.expectedTarget
        $shortcut.Arguments = [string]$Spec.expectedArguments
        $shortcut.WorkingDirectory = $installRootFull
        $shortcut.Description = [string]$Spec.expectedDescription
        $shortcut.IconLocation = [string]$Spec.expectedIconLocation
        $shortcut.Save()
    } finally {
        if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    }

    $shortcutInstalled = $false
    try {
        for ($attempt = 0; $attempt -lt 10 -and -not $shortcutInstalled; $attempt++) {
            try {
                [IO.File]::Copy($pendingShortcut, $shortcutPath, $true)
                $shortcutInstalled = $true
            } catch {
                if ($attempt -lt 9) { Start-Sleep -Milliseconds 100 }
            }
        }
        if (-not $shortcutInstalled) {
            throw "Unable to replace Anti-Codex shortcut: $shortcutPath"
        }
    } finally {
        if (Test-Path -LiteralPath $pendingShortcut -PathType Leaf) {
            Remove-Item -LiteralPath $pendingShortcut -Force -ErrorAction SilentlyContinue
        }
    }

    return Get-AntiCodexShortcutEvidence -Spec $Spec
}

$shortcutEvidence = @($shortcutSpecs | ForEach-Object { Set-AntiCodexShortcut -Spec $_ })
$repaired = $shortcutEvidence

$legacyNativeLauncherCandidates = @(
    Get-ChildItem -LiteralPath $installRootFull -Filter "Anti-Codex Launcher.exe*" -File -ErrorAction SilentlyContinue
)
foreach ($candidate in $legacyNativeLauncherCandidates) {
    try { Remove-Item -LiteralPath $candidate.FullName -Force -ErrorAction Stop } catch {}
}
$legacyNativeLauncherResiduals = @(
    Get-ChildItem -LiteralPath $installRootFull -Filter "Anti-Codex Launcher.exe*" -File -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
)

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
    preservedNativeCodexShortcutCount = @($residualShortcutEvidence | Where-Object { $_.action -eq "preserved-native-codex" }).Count
    residualShortcuts = $residualShortcutEvidence
    nativeLauncher = $nativeLauncherBuild
    launchTask = $launchTaskEvidence
    updateTask = $updateTaskEvidence
    legacyNativeLauncherResiduals = $legacyNativeLauncherResiduals
    shortcutEvidence = $shortcutEvidence
    shortcuts = $repaired
}
$reportPaths = Save-JsonReport $result "shortcut-repair"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
$result | ConvertTo-Json -Depth 8
