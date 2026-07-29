#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$FromUpdateTask
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Show-AntiCodexPopup {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Title = "Anti-Codex Sync",
        [int]$Icon = 64
    )

    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup($Message, 12, $Title, $Icon) | Out-Null
    } catch {
        Write-Host $Message
    }
}

$scriptRoot = Split-Path -Parent $PSCommandPath
$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $scriptRoot)))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
$updateTaskName = "Anti-Codex Updater"
$syncScript = Join-Path $scriptRoot "sync-anticodex.ps1"
$updateTaskScript = Join-Path $scriptRoot "start-anticodex-update-task.mjs"
$updateStatusModule = Join-Path $scriptRoot "anticodex-update-status.psm1"
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
$node = if ($nodeCommand) { [IO.Path]::GetFullPath([string]$nodeCommand.Source) } else { "" }
$expectedTaskArguments = "`"$updateTaskScript`" --hide-console"
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

function Get-AntiCodexUpdateTaskEvidence {
    try {
        $task = Get-AntiCodexRegisteredTask -TaskName $updateTaskName
    } catch {
        return [pscustomobject]@{ ok = $false; state = ""; stateCode = 0; task = $null; error = $_.Exception.Message }
    }

    $definition = $task.Definition
    $actionCount = [int]$definition.Actions.Count
    $action = if ($actionCount -eq 1) { $definition.Actions.Item(1) } else { $null }
    $currentUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $currentShortUserName = ($currentUserName -split "\\")[-1]
    $taskUserName = [string]$definition.Principal.UserId
    $actionMatches = (
        $actionCount -eq 1 -and
        $task.Enabled -and
        $action -and
        [string]$action.Path -ieq $node -and
        [string]$action.Arguments -ceq $expectedTaskArguments -and
        [string]$action.WorkingDirectory -ieq $installRoot
    )
    $principalMatches = (
        ($taskUserName -ieq $currentUserName -or $taskUserName -ieq $currentShortUserName) -and
        [int]$definition.Principal.LogonType -eq 3 -and
        [int]$definition.Principal.RunLevel -eq 0
    )
    $settingsMatch = (
        [int]$definition.Triggers.Count -eq 0 -and
        [int]$definition.Settings.MultipleInstances -eq 2 -and
        [bool]$definition.Settings.AllowDemandStart -and
        [bool]$definition.Settings.AllowHardTerminate -and
        -not [bool]$definition.Settings.RunOnlyIfIdle -and
        -not [bool]$definition.Settings.RunOnlyIfNetworkAvailable -and
        -not [bool]$definition.Settings.DisallowStartIfOnBatteries -and
        -not [bool]$definition.Settings.StopIfGoingOnBatteries -and
        [int]$definition.Settings.RestartCount -eq 0 -and
        [string]$definition.Settings.ExecutionTimeLimit -eq "PT0S"
    )
    $stateCode = [int]$task.State
    return [pscustomobject]@{
        ok = ($actionMatches -and $principalMatches -and $settingsMatch)
        state = (Get-AntiCodexTaskStateName -State $stateCode)
        stateCode = $stateCode
        task = $task
        error = ""
    }
}

function Wait-AntiCodexUpdateTaskRunning {
    param([int]$TimeoutSeconds = 5)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $evidence = Get-AntiCodexUpdateTaskEvidence
        if ($evidence.ok -and [int]$evidence.stateCode -eq 4) { return $true }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Set-AntiCodexUpdaterHandoffFailure {
    param([Parameter(Mandatory = $true)][string]$Message)

    if (-not (Get-Command Set-AntiCodexUpdateOperation -ErrorAction SilentlyContinue)) {
        return
    }
    try {
        [void](Set-AntiCodexUpdateOperation -State "failed" -Stage "updater_handoff_failed" -Message $Message -FailureCode "updater_handoff_failed" -ExpectedStates @("running") -ExpectedStages @("updater_queued", "updater_handoff"))
    } catch {
        Write-Warning "Anti-Codex could not record updater handoff failure: $($_.Exception.Message)"
    }
}

try {
    if ($installRoot -ne $expectedRoot) {
        throw "Anti-Codex sync launcher may only run from $expectedRoot"
    }
    if (-not (Test-Path -LiteralPath $syncScript -PathType Leaf)) {
        throw "Anti-Codex sync component is missing: $syncScript"
    }
    if (-not (Test-Path -LiteralPath $updateTaskScript -PathType Leaf)) {
        throw "Anti-Codex updater task broker is missing: $updateTaskScript"
    }
    if (-not (Test-Path -LiteralPath $updateStatusModule -PathType Leaf)) {
        throw "Anti-Codex update status component is missing: $updateStatusModule"
    }
    Import-Module $updateStatusModule -Force

    $taskEvidence = Get-AntiCodexUpdateTaskEvidence
    if (-not $taskEvidence.ok) {
        throw "The isolated Anti-Codex updater task is missing or stale. Run shortcut repair before updating."
    }

    if ($FromUpdateTask) {
        $taskEvidence = Get-AntiCodexUpdateTaskEvidence
        if ([int]$taskEvidence.stateCode -ne 4) {
            throw "Anti-Codex sync refused an unverified updater-task context."
        }
        [void](Set-AntiCodexUpdateOperation -State "running" -Stage "updater_handoff" -Message "The isolated updater task has taken over the sync." -ExpectedStates @("running") -ExpectedStages @("updater_queued"))
        $global:LASTEXITCODE = 0
        & $syncScript -FromUpdateTask
        if ($LASTEXITCODE -ne 0) {
            throw "Anti-Codex sync exited with code $LASTEXITCODE."
        }
        return
    }

    if (-not $FromUpdateTask) {
        if ([int]$taskEvidence.stateCode -in @(2, 4)) {
            Write-Host "Anti-Codex update is already running in the isolated updater task."
            exit 0
        }
        if ([int]$taskEvidence.stateCode -ne 3) {
            throw "The isolated Anti-Codex updater task is not ready."
        }
        $newOperationId = [Guid]::NewGuid().ToString("N")
        $queued = Set-AntiCodexUpdateOperation -State "running" -Stage "updater_queued" -Message "Waiting for the isolated updater task to take over." -NewOperationId $newOperationId -ExpectedStates @("idle", "succeeded", "failed", "rolled_back")
        if (-not $queued) {
            $queued = Set-AntiCodexUpdateOperation -State "running" -Stage "updater_queued" -Message "Waiting for the isolated updater task to take over." -NewOperationId $newOperationId -ExpectedStates @("running") -ExpectedStages @("updater_queued", "updater_handoff")
        }
        if (-not $queued) {
            throw "Anti-Codex refused to replace a detailed update status while starting the updater task."
        }
        [void]$taskEvidence.task.Run($null)
        if (-not (Wait-AntiCodexUpdateTaskRunning -TimeoutSeconds 5)) {
            throw "The isolated Anti-Codex updater task did not enter the running state."
        }
        [void](Set-AntiCodexUpdateOperation -State "running" -Stage "updater_handoff" -Message "The isolated updater task has taken over the sync." -ExpectedStates @("running") -ExpectedStages @("updater_queued"))
        Write-Host "Anti-Codex update was handed to the isolated updater task."
        exit 0
    }
} catch {
    Set-AntiCodexUpdaterHandoffFailure -Message $_.Exception.Message
    Show-AntiCodexPopup `
        -Title "Anti-Codex Sync Failed" `
        -Icon 16 `
        -Message ("Anti-Codex was not changed.`n`n" + $_.Exception.Message)
    exit 1
}
