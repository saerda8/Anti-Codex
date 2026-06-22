#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRoot -ne $expectedRoot) {
    throw "Anti-Codex model refresh may only run from $expectedRoot"
}

$activeHost = Join-Path $installRoot "codex-patched-app"
$startAntiCodex = Join-Path $installRoot "runtime\scripts\start-anticodex.ps1"
$stateRoot = Join-Path $env:APPDATA "anticodex"
$hostSyncMarker = Join-Path $stateRoot "host-sync.lock"
$refreshLog = Join-Path $stateRoot "model-refresh.log"
if (-not (Test-Path -LiteralPath $startAntiCodex)) {
    throw "Anti-Codex launcher is missing: $startAntiCodex"
}

function Get-AntiCodexHostProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        try {
            return ([IO.Path]::GetFullPath([string]$_.ExecutablePath)).StartsWith(
                $activeHost,
                [StringComparison]::OrdinalIgnoreCase
            )
        } catch {
            return $false
        }
    })
}

function Stop-AntiCodexLaunchers {
    $escapedStartScript = [regex]::Escape($startAntiCodex)
    $launchers = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and
        ([string]$_.CommandLine) -match $escapedStartScript
    })
    foreach ($launcher in $launchers) {
        Stop-Process -Id $launcher.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Write-RefreshLog {
    param([string]$Message)
    try {
        New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
        "$(Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff") $Message" | Add-Content -LiteralPath $refreshLog -Encoding utf8
    } catch {}
}

function Read-JsonResponseBody {
    param([Parameter(Mandatory = $true)] $Response)
    try {
        $reader = New-Object IO.StreamReader($Response.GetResponseStream(), [Text.Encoding]::UTF8)
        try {
            $text = $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return $text | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
}

function Find-AntiCodexLocalAddress {
    if ($env:ANTICODEX_LOCAL_ADDRESS) { return $env:ANTICODEX_LOCAL_ADDRESS }
    try {
        $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object {
                $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' -and
                -not $_.SkipAsSource
            })
        $preferred = $addresses | Sort-Object @{
            Expression = {
                if ($_.IPAddress -like "192.168.*") { 0 }
                elseif ($_.IPAddress -like "10.*") { 1 }
                else { 2 }
            }
        }, InterfaceMetric | Select-Object -First 1
        if ($preferred) { return [string]$preferred.IPAddress }
    } catch {}
    return "127.0.0.1"
}

function Invoke-AntiCodexHotModelRefresh {
    if ($env:ANTICODEX_TEST_FORCE_REFRESH_FALLBACK -eq "1") {
        Write-RefreshLog "Hot model refresh intentionally bypassed for fallback recovery verification."
        return $false
    }
    $urls = @()
    if ($env:TRANSLATOR_URL) { $urls += $env:TRANSLATOR_URL }
    $urls += "http://$(Find-AntiCodexLocalAddress):8484"
    $urls += "http://127.0.0.1:8484"
    foreach ($url in @($urls | Select-Object -Unique)) {
        $response = $null
        try {
            $request = [System.Net.WebRequest]::Create("$url/anticodex/models/refresh")
            $request.Method = "POST"
            $request.Proxy = $null
            $request.Timeout = 20000
            $bytes = [Text.Encoding]::UTF8.GetBytes("{}")
            $request.ContentType = "application/json; charset=utf-8"
            $request.ContentLength = $bytes.Length
            $stream = $request.GetRequestStream()
            try {
                $stream.Write($bytes, 0, $bytes.Length)
            } finally {
                $stream.Dispose()
            }
            $response = $request.GetResponse()
            if ([int]$response.StatusCode -eq 200) {
                $payload = Read-JsonResponseBody -Response $response
                if ($payload -and $payload.skipped) {
                    Write-RefreshLog "Provider model refresh kept $($payload.defaultModel) via $url; Antigravity refresh skipped."
                } else {
                    Write-RefreshLog "Hot model refresh succeeded via $url."
                }
                return $true
            }
        } catch {
            Write-RefreshLog "Hot model refresh failed via ${url}: $($_.Exception.Message)"
        } finally {
            if ($response) { $response.Dispose() }
        }
    }
    return $false
}

Write-RefreshLog "Refresh requested."
if (Invoke-AntiCodexHotModelRefresh) {
    return
}
Write-RefreshLog "Hot model refresh unavailable; falling back to restart refresh."

$mutex = New-Object Threading.Mutex($false, "Local\AntiCodexHostSync")
if (-not $mutex.WaitOne(0)) {
    $mutex.Dispose()
    throw "Anti-Codex is currently updating. Wait for the update to finish, then refresh models again."
}

try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $hostSyncMarker) -Force | Out-Null
    "Model refresh $(Get-Date -Format o)" | Set-Content -LiteralPath $hostSyncMarker -Encoding ASCII
    Write-RefreshLog "Maintenance marker created."

    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        if (@(Get-AntiCodexHostProcesses).Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    Write-RefreshLog "Cooperative shutdown wait finished."

    Stop-AntiCodexLaunchers
    Write-RefreshLog "Legacy launchers stopped."
    $remainingHosts = @(Get-AntiCodexHostProcesses)
    Write-RefreshLog "Stopping $($remainingHosts.Count) remaining host processes."
    foreach ($process in $remainingHosts) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-RefreshLog "Remaining host processes stopped."
} finally {
    Remove-Item -LiteralPath $hostSyncMarker -Force -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex()
    $mutex.Dispose()
    Write-RefreshLog "Maintenance marker removed."
}

Write-RefreshLog "Starting Anti-Codex in a detached launcher process."
$powerShellBin = (Get-Command "powershell.exe" -ErrorAction Stop).Source
$previousForceStartupModelRefresh = $env:ANTICODEX_FORCE_STARTUP_MODEL_REFRESH
try {
    # A fallback restart must discover the selected account instead of reusing its predecessor's catalog.
    $env:ANTICODEX_FORCE_STARTUP_MODEL_REFRESH = "1"
    Start-Process `
        -FilePath $powerShellBin `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$startAntiCodex`"") `
        -WindowStyle Hidden | Out-Null
} finally {
    $env:ANTICODEX_FORCE_STARTUP_MODEL_REFRESH = $previousForceStartupModelRefresh
}

$healthUrls = @(
    "http://$(Find-AntiCodexLocalAddress):8484/health",
    "http://127.0.0.1:8484/health"
) | Select-Object -Unique
$deadline = [DateTime]::UtcNow.AddSeconds(90)
$healthy = $false
do {
    foreach ($healthUrl in $healthUrls) {
        $healthResponse = $null
        try {
            $healthRequest = [System.Net.WebRequest]::Create($healthUrl)
            $healthRequest.Method = "GET"
            $healthRequest.Proxy = $null
            $healthRequest.Timeout = 5000
            $healthResponse = $healthRequest.GetResponse()
            if ([int]$healthResponse.StatusCode -eq 200) {
                $healthy = $true
                break
            }
        } catch {
        } finally {
            if ($healthResponse) { $healthResponse.Dispose() }
        }
    }
    if (-not $healthy) { Start-Sleep -Seconds 2 }
} while (-not $healthy -and [DateTime]::UtcNow -lt $deadline)

if (-not $healthy) {
    throw "Anti-Codex did not recover within 90 seconds after the model refresh restart."
}
Write-RefreshLog "Detached Anti-Codex launcher recovered and the gateway is healthy."
