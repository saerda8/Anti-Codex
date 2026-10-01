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
        return Get-Process -Name "Antigravity", "Antigravity IDE" -ErrorAction SilentlyContinue |
            Where-Object {
                $processPath = try { ConvertTo-AntigravityExecutablePath ([string]$_.Path) } catch { $null }
                $isDesktopMain = $processPath -and
                    $processPath -notmatch "\\bin\\antigravity\.exe$"
                if (-not $isDesktopMain) { return $false }
                if (-not $expectedPath) { return $true }
                return $processPath -ieq $expectedPath
            } |
            Sort-Object @{ Expression = { if ($_.MainWindowHandle -ne 0) { 0 } else { 1 } } }, StartTime |
            Select-Object -First 1 `
                @{ Name = "ProcessId"; Expression = { [int]$_.Id } },
                @{ Name = "ExecutablePath"; Expression = { [string]$_.Path } },
                @{ Name = "CreationDate"; Expression = { $_.StartTime } },
                MainWindowHandle
    } catch {
        return $null
    }
}

function Set-AntigravityProxyEnvironment {
    $settings = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue
    if (-not $settings -or [int]$settings.ProxyEnable -ne 1) { return }
    $raw = [string]$settings.ProxyServer
    if ([string]::IsNullOrWhiteSpace($raw)) { return }
    $proxy = $raw
    if ($raw -match '(?i)(?:^|;)https?=([^;]+)') { $proxy = $Matches[1] }
    $proxy = $proxy.Trim()
    if ($proxy -notmatch '^https?://') { $proxy = "http://$proxy" }
    $env:HTTP_PROXY = $proxy
    $env:HTTPS_PROXY = $proxy
    $env:ALL_PROXY = $proxy
}

function Start-AntigravityDesktop {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [string]$StateRoot = ""
    )

    $resolvedStateRoot = if ($StateRoot) {
        [IO.Path]::GetFullPath($StateRoot)
    } elseif ($env:DEEPCODEX_STATE_ROOT) {
        [IO.Path]::GetFullPath($env:DEEPCODEX_STATE_ROOT)
    } else {
        [IO.Path]::GetFullPath((Join-Path $env:APPDATA "anticodex"))
    }
    New-Item -ItemType Directory -Path $resolvedStateRoot -Force | Out-Null
    $stdoutPath = Join-Path $resolvedStateRoot "antigravity-desktop.out.log"
    $stderrPath = Join-Path $resolvedStateRoot "antigravity-desktop.err.log"
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    Set-AntigravityProxyEnvironment
    return Start-Process -FilePath $ExecutablePath `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
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
