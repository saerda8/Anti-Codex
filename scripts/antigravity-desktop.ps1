#Requires -Version 5.1

function ConvertTo-AntigravityExecutablePath {
    param([string]$Value)
    if (-not $Value) { return $null }

    $path = $Value.Trim()
    if ($path -match '^"([^"]+\.exe)"(?:,\d+)?$') {
        $path = $Matches[1]
    } else {
        $path = ($path -replace ',\d+$', '').Trim('"')
    }
    if (-not $path.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) { return $null }
    try { return [IO.Path]::GetFullPath($path) } catch { return $null }
}

function Get-AntigravityMainProcess {
    param([string]$ExecutablePath)

    $expectedPath = ConvertTo-AntigravityExecutablePath $ExecutablePath
    try {
        return Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $name = [string]$_.Name
                $commandLine = [string]$_.CommandLine
                $processPath = ConvertTo-AntigravityExecutablePath ([string]$_.ExecutablePath)
                $supportedName = $name -ieq "Antigravity.exe" -or $name -ieq "Antigravity IDE.exe"
                $isDesktopMain = $supportedName -and
                    $processPath -and
                    $commandLine -notmatch "\s--type=" -and
                    $commandLine -notmatch "\s--sandbox(?:\s|$)" -and
                    $processPath -notmatch "\\bin\\antigravity\.exe$"
                if (-not $isDesktopMain) { return $false }
                if (-not $expectedPath) { return $true }
                return $processPath -ieq $expectedPath
            } |
            Sort-Object CreationDate -Descending |
            Select-Object -First 1
    } catch {
        return $null
    }
}

function Get-AntigravityRegistryCandidates {
    $roots = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    $candidates = New-Object System.Collections.Generic.List[string]
    try {
        $entries = Get-ItemProperty $roots -ErrorAction SilentlyContinue |
            Where-Object { ([string]$_.DisplayName) -match "^Antigravity(?: IDE)?" } |
            Sort-Object DisplayVersion -Descending
        foreach ($entry in $entries) {
            $iconPath = ConvertTo-AntigravityExecutablePath ([string]$entry.DisplayIcon)
            if ($iconPath) { $candidates.Add($iconPath) }

            $installLocation = [string]$entry.InstallLocation
            if ($installLocation) {
                foreach ($name in @("Antigravity.exe", "Antigravity IDE.exe")) {
                    $candidates.Add((Join-Path $installLocation $name))
                }
            }
        }
    } catch {}
    return $candidates
}

function Resolve-AntigravityDesktopPath {
    $running = Get-AntigravityMainProcess
    if ($running -and $running.ExecutablePath) {
        return (ConvertTo-AntigravityExecutablePath ([string]$running.ExecutablePath))
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:ANTIGRAVITY_DESKTOP_PATH) {
        $candidates.Add($env:ANTIGRAVITY_DESKTOP_PATH)
    }
    foreach ($candidate in @(Get-AntigravityRegistryCandidates)) {
        if ($candidate) { $candidates.Add([string]$candidate) }
    }
    $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\antigravity\Antigravity.exe"))

    $seen = @{}
    foreach ($candidate in $candidates) {
        $path = ConvertTo-AntigravityExecutablePath $candidate
        if (-not $path -or $seen.ContainsKey($path)) { continue }
        $seen[$path] = $true
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
    return $null
}

function Wait-AntigravityDesktopStable {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [int]$TimeoutSeconds = 30,
        [int]$StableSeconds = 8
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $stableSince = $null
    $stableProcess = $null
    $observed = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        $process = Get-AntigravityMainProcess -ExecutablePath $ExecutablePath
        if ($process) {
            $observed = $true
            if (-not $stableProcess -or $stableProcess.ProcessId -ne $process.ProcessId) {
                $stableProcess = $process
                $stableSince = [DateTime]::UtcNow
            }
            if (([DateTime]::UtcNow - $stableSince).TotalSeconds -ge $StableSeconds) {
                return [pscustomobject]@{ Stable = $true; Process = $process; Observed = $true }
            }
        } else {
            $stableProcess = $null
            $stableSince = $null
        }
        Start-Sleep -Milliseconds 500
    }
    return [pscustomobject]@{ Stable = $false; Process = $stableProcess; Observed = $observed }
}
