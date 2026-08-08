Set-StrictMode -Version Latest

function Get-AntiCodexUpdateStateRoot {
    param([string]$StateRoot)

    if (-not [string]::IsNullOrWhiteSpace($StateRoot)) {
        return $StateRoot
    }
    if (-not [string]::IsNullOrWhiteSpace($env:DEEPCODEX_STATE_ROOT)) {
        return $env:DEEPCODEX_STATE_ROOT
    }
    return Join-Path $env:APPDATA "anticodex"
}

function New-AntiCodexIdleOperation {
    return [pscustomobject]@{
        state = "idle"
        stage = "none"
    }
}

function Get-AntiCodexObjectProperty {
    param(
        [object]$InputObject,
        [string]$Name
    )

    if ($null -eq $InputObject) {
        return $null
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-AntiCodexUpdateStatus {
    [CmdletBinding()]
    param([string]$StateRoot)

    $resolvedStateRoot = Get-AntiCodexUpdateStateRoot -StateRoot $StateRoot
    $statusPath = Join-Path $resolvedStateRoot "update-status.json"

    if (-not (Test-Path -LiteralPath $statusPath)) {
        return [pscustomobject]@{
            operation = New-AntiCodexIdleOperation
        }
    }

    try {
        $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $operationProperty = $status.PSObject.Properties["operation"]
        if ($null -eq $operationProperty -or $null -eq $operationProperty.Value) {
            $status | Add-Member -NotePropertyName operation -NotePropertyValue (New-AntiCodexIdleOperation)
        }
        return $status
    }
    catch {
        return [pscustomobject]@{
            operation = New-AntiCodexIdleOperation
        }
    }
}

function Invoke-AntiCodexUpdateStatusLocked {
    param([Parameter(Mandatory = $true)][scriptblock]$Action)

    $mutex = New-Object Threading.Mutex($false, "Local\AntiCodexUpdateStatus")
    $acquired = $false
    try {
        try {
            $acquired = $mutex.WaitOne(5000)
        }
        catch [Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) {
            throw "Timed out waiting for the Anti-Codex update status writer."
        }
        & $Action
    }
    finally {
        if ($acquired) {
            try { $mutex.ReleaseMutex() } catch {}
        }
        $mutex.Dispose()
    }
}

function Write-AntiCodexUpdateStatusFile {
    param(
        [Parameter(Mandatory = $true)][object]$Status,
        [Parameter(Mandatory = $true)][string]$StateRoot
    )

    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $statusPath = Join-Path $StateRoot "update-status.json"
    $temporaryPath = "$statusPath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = $Status | ConvertTo-Json -Depth 12
        [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $statusPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Save-AntiCodexUpdateStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Status,
        [string]$StateRoot
    )

    $resolvedStateRoot = Get-AntiCodexUpdateStateRoot -StateRoot $StateRoot
    try {
        Invoke-AntiCodexUpdateStatusLocked {
            $latestStatus = Get-AntiCodexUpdateStatus -StateRoot $resolvedStateRoot
            $latestOperation = Get-AntiCodexObjectProperty -InputObject $latestStatus -Name "operation"
            $operationProperty = $Status.PSObject.Properties["operation"]
            if ($null -eq $operationProperty) {
                $Status | Add-Member -NotePropertyName operation -NotePropertyValue $latestOperation
            }
            else {
                $operationProperty.Value = $latestOperation
            }
            Write-AntiCodexUpdateStatusFile -Status $Status -StateRoot $resolvedStateRoot
        }
    }
    catch {
        Write-Warning "Anti-Codex could not persist update status: $($_.Exception.Message)"
    }
}

function Set-AntiCodexUpdateOperation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("idle", "running", "succeeded", "failed", "rolled_back")]
        [string]$State,

        [Parameter(Mandatory = $true)]
        [string]$Stage,

        [string]$Message,
        [string]$FailureCode,
        [bool]$RollbackAvailable = $false,
        [object]$OriginalFailure,
        [string]$NewOperationId,
        [string[]]$ExpectedStates,
        [string[]]$ExpectedStages,
        [string]$StateRoot
    )

    $resolvedStateRoot = Get-AntiCodexUpdateStateRoot -StateRoot $StateRoot
    $hasExpectedStates = $PSBoundParameters.ContainsKey("ExpectedStates") -and $ExpectedStates.Count -gt 0
    $hasExpectedStages = $PSBoundParameters.ContainsKey("ExpectedStages") -and $ExpectedStages.Count -gt 0
    $hasOriginalFailure = $PSBoundParameters.ContainsKey("OriginalFailure") -and $null -ne $OriginalFailure
    $conditionalWrite = $hasExpectedStates -or $hasExpectedStages
    try {
        $written = Invoke-AntiCodexUpdateStatusLocked {
            $status = Get-AntiCodexUpdateStatus -StateRoot $resolvedStateRoot
            $existingOperation = Get-AntiCodexObjectProperty -InputObject $status -Name "operation"
            $existingState = [string](Get-AntiCodexObjectProperty -InputObject $existingOperation -Name "state")
            $existingStage = [string](Get-AntiCodexObjectProperty -InputObject $existingOperation -Name "stage")
            if (($hasExpectedStates -and $existingState -notin $ExpectedStates) -or
                ($hasExpectedStages -and $existingStage -notin $ExpectedStages)) {
                return $false
            }

            $now = [DateTimeOffset]::UtcNow.ToString("o")
            $operationId = Get-AntiCodexObjectProperty -InputObject $existingOperation -Name "operationId"
            $startedAt = Get-AntiCodexObjectProperty -InputObject $existingOperation -Name "startedAt"
            $recordedOriginalFailure = Get-AntiCodexObjectProperty -InputObject $existingOperation -Name "originalFailure"
            $isRollbackStage = $Stage.StartsWith("rollback_", [StringComparison]::OrdinalIgnoreCase)
            $continuesFailedUpdate = $State -eq "running" -and $isRollbackStage -and $existingState -eq "failed"
            $startsNewOperation = -not [string]::IsNullOrWhiteSpace($NewOperationId) -or
                [string]::IsNullOrWhiteSpace($operationId) -or
                ($State -eq "running" -and $existingState -ne "running" -and -not $continuesFailedUpdate)

            if (-not [string]::IsNullOrWhiteSpace($NewOperationId)) {
                $operationId = $NewOperationId
                $startedAt = $now
            }
            elseif ($startsNewOperation) {
                $operationId = [Guid]::NewGuid().ToString("N")
                $startedAt = $now
            }
            if ([string]::IsNullOrWhiteSpace($startedAt)) {
                $startedAt = $now
            }

            if ($hasOriginalFailure) {
                $recordedOriginalFailure = $OriginalFailure
            }
            elseif ($startsNewOperation -or $State -eq "succeeded") {
                $recordedOriginalFailure = $null
            }
            elseif ($null -eq $recordedOriginalFailure -and $existingState -eq "failed" -and
                ($isRollbackStage -or $State -eq "rolled_back")) {
                $failureAt = Get-AntiCodexObjectProperty -InputObject $existingOperation -Name "completedAt"
                if ([string]::IsNullOrWhiteSpace([string]$failureAt)) {
                    $failureAt = Get-AntiCodexObjectProperty -InputObject $existingOperation -Name "updatedAt"
                }
                $recordedOriginalFailure = [pscustomobject]@{
                    stage = $existingStage
                    message = Get-AntiCodexObjectProperty -InputObject $existingOperation -Name "message"
                    error = Get-AntiCodexObjectProperty -InputObject $existingOperation -Name "failureCode"
                    at = $failureAt
                }
            }

            $completedAt = if ($State -in @("succeeded", "failed", "rolled_back")) { $now } else { $null }
            $operation = [pscustomobject]@{
                state = $State
                stage = $Stage
                operationId = $operationId
                startedAt = $startedAt
                updatedAt = $now
                completedAt = $completedAt
                message = $Message
                failureCode = $FailureCode
                rollbackAvailable = $RollbackAvailable
            }
            if ($null -ne $recordedOriginalFailure) {
                $operation | Add-Member -NotePropertyName originalFailure -NotePropertyValue $recordedOriginalFailure
            }

            $operationProperty = $status.PSObject.Properties["operation"]
            if ($null -eq $operationProperty) {
                $status | Add-Member -NotePropertyName operation -NotePropertyValue $operation
            }
            else {
                $operationProperty.Value = $operation
            }
            Write-AntiCodexUpdateStatusFile -Status $status -StateRoot $resolvedStateRoot
            return $true
        }
        if ($conditionalWrite) {
            return [bool]$written
        }
    }
    catch {
        Write-Warning "Anti-Codex could not persist update operation state: $($_.Exception.Message)"
        if ($conditionalWrite) {
            return $false
        }
    }
}

Export-ModuleMember -Function Get-AntiCodexUpdateStatus, Save-AntiCodexUpdateStatus, Set-AntiCodexUpdateOperation
