function Enter-AntiCodexRealTrafficLock {
    [CmdletBinding()]
    param(
        [string]$Name = "Local\AntiCodex.RealTrafficBridge",
        [int]$WaitSeconds = 0
    )

    $mutex = [Threading.Mutex]::new($false, $Name)
    $acquired = $false
    try {
        $timeoutMs = [Math]::Max(0, $WaitSeconds) * 1000
        $acquired = $mutex.WaitOne($timeoutMs)
        if (-not $acquired) {
            $mutex.Dispose()
            return [pscustomobject]@{
                acquired = $false
                mutex = $null
                name = $Name
                waitSeconds = $WaitSeconds
            }
        }

        return [pscustomobject]@{
            acquired = $true
            mutex = $mutex
            name = $Name
            waitSeconds = $WaitSeconds
        }
    } catch {
        if ($mutex) { $mutex.Dispose() }
        throw
    }
}

function Exit-AntiCodexRealTrafficLock {
    [CmdletBinding()]
    param($Lock)

    if (-not $Lock -or $Lock.acquired -ne $true -or -not $Lock.mutex) { return }
    try {
        $Lock.mutex.ReleaseMutex()
    } finally {
        $Lock.mutex.Dispose()
    }
}

function New-AntiCodexRealTrafficBusyResult {
    [CmdletBinding()]
    param(
        [string]$Name,
        [string]$Reason = "Another Anti-Codex real Antigravity verification is already running.",
        [int]$ElapsedMs = 0
    )

    return [pscustomobject]@{
        ok = $true
        skipped = $true
        busy = $true
        name = $Name
        reason = $Reason
        elapsedMs = $ElapsedMs
    }
}

Export-ModuleMember -Function Enter-AntiCodexRealTrafficLock, Exit-AntiCodexRealTrafficLock, New-AntiCodexRealTrafficBusyResult
