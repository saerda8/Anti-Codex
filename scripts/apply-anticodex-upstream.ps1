#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$DetachedWorker,
    [string]$StateRootPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$fixedSupervisorScript = Join-Path $PSScriptRoot "start-anticodex-fixed-route.mjs"
$stateRoot = if ($StateRootPath) {
    [IO.Path]::GetFullPath($StateRootPath)
} elseif ($env:DEEPCODEX_STATE_ROOT) {
    [IO.Path]::GetFullPath($env:DEEPCODEX_STATE_ROOT)
} else {
    [IO.Path]::GetFullPath((Join-Path $env:APPDATA "anticodex"))
}
$env:DEEPCODEX_STATE_ROOT = $stateRoot
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$applyStatusPath = Join-Path $stateRoot "apply-upstream-status.json"
$routeRestartRequestPath = Join-Path $stateRoot "route-restart-request.json"

function Write-ApplyStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$State,
        [int]$WorkerPid = 0,
        [int]$LauncherPid = 0,
        [string]$Message = ""
    )

    $payload = [ordered]@{
        schema = "anticodex-apply-upstream-status-v1"
        state = $State
        updatedAt = [DateTime]::UtcNow.ToString("o")
        workerPid = $WorkerPid
        launcherPid = $LauncherPid
        message = $Message
    }
    $temporaryPath = "$applyStatusPath.$PID.tmp"
    [IO.File]::WriteAllText(
        $temporaryPath,
        ($payload | ConvertTo-Json -Compress),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $applyStatusPath -Force
}

trap {
    if ($DetachedWorker -and (Test-Path -LiteralPath $routeRestartRequestPath -PathType Leaf)) {
        Remove-Item -LiteralPath $routeRestartRequestPath -Force -ErrorAction SilentlyContinue
    }
    Write-ApplyStatus -State "error" -WorkerPid $PID -Message $_.Exception.Message
    exit 1
}

foreach ($required in @($fixedSupervisorScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Missing Anti-Codex fixed-route component: $required"
    }
}

$powerShell = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
$taskkill = Join-Path ([Environment]::SystemDirectory) "taskkill.exe"
if (-not $DetachedWorker) {
    Write-ApplyStatus -State "delegating" -WorkerPid $PID
    $commandLine = "`"$powerShell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -DetachedWorker -StateRootPath `"$stateRoot`""
    $delegated = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
        CurrentDirectory = $PSScriptRoot
    }
    if ([int]$delegated.ReturnValue -ne 0 -or [int]$delegated.ProcessId -le 0) {
        throw "Could not delegate the Anti-Codex route switch outside the current process job (WMI $($delegated.ReturnValue))."
    }
    [pscustomobject]@{
        ok = $true
        delegated = $true
        workerPid = [int]$delegated.ProcessId
        message = "Anti-Codex route switch delegated."
    } | ConvertTo-Json -Compress
    exit 0
}

Start-Sleep -Milliseconds 750
Write-ApplyStatus -State "stopping" -WorkerPid $PID

function Get-RunningFixedRouteSupervisor {
    $statusPath = Join-Path $stateRoot "fixed-route-status.json"
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { return @() }
    try {
        $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$status.schema -ne "anticodex-fixed-route-status-v1") { return @() }
        $processId = [int]$status.pid
        if ($processId -le 0) { return @() }
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process -or [string]$process.ProcessName -ine "node") { return @() }
        try {
            $processRow = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop |
                Select-Object -First 1
            if ($processRow) {
                $commandLine = [string]$processRow.CommandLine
                $expectedSupervisorScript = [IO.Path]::GetFullPath($fixedSupervisorScript)
                $expectedStateRoot = [IO.Path]::GetFullPath($stateRoot)
                if ($commandLine.IndexOf($expectedSupervisorScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                    $commandLine.IndexOf($expectedStateRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    return @([pscustomobject]@{
                        ProcessId = [int]$processRow.ProcessId
                        ExecutablePath = [string]$processRow.ExecutablePath
                        CommandLine = $commandLine
                        IdentityEvidence = "wmi-command-line"
                    })
                }
            }
        } catch {
            # WMI can be unavailable under resource pressure. The fixed-route health endpoint is the bounded fallback.
        }

        $healthRequest = [Net.HttpWebRequest]::Create("http://127.0.0.1:18487/anticodex/fixed-route/health")
        $healthRequest.Method = "GET"
        $healthRequest.Proxy = $null
        $healthRequest.Timeout = 1500
        $healthRequest.ReadWriteTimeout = 1500
        $healthResponse = $healthRequest.GetResponse()
        try {
            $reader = [IO.StreamReader]::new($healthResponse.GetResponseStream(), [Text.Encoding]::UTF8)
            try {
                $health = $reader.ReadToEnd() | ConvertFrom-Json
            } finally {
                $reader.Dispose()
            }
        } finally {
            $healthResponse.Dispose()
        }
        if ([string]$health.schema -ne "anticodex-fixed-route-status-v1" -or
            $health.ok -ne $true -or
            [string]$health.state -ne "ready" -or
            [int]$health.pid -ne $processId) {
            return @()
        }
        return @([pscustomobject]@{
            ProcessId = $processId
            ExecutablePath = [string]$process.Path
            CommandLine = ""
            IdentityEvidence = "status-health-pid-match"
        })
    } catch {
        return @()
    }
}

function Invoke-AntiCodexFixedRouteShutdown {
    $authPath = Join-Path $stateRoot "codex-home-deepseek-app\auth.json"
    $controlToken = "anticodex-local-proxy-key"
    try {
        if (Test-Path -LiteralPath $authPath -PathType Leaf) {
            $auth = Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not [string]::IsNullOrWhiteSpace([string]$auth.OPENAI_API_KEY)) {
                $controlToken = [string]$auth.OPENAI_API_KEY
            }
        }
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:18487/anticodex/fixed-route/shutdown")
        $request.Method = "POST"
        $request.Proxy = $null
        $request.Timeout = 3000
        $request.ReadWriteTimeout = 3000
        $request.ContentLength = 0
        $request.Headers[[Net.HttpRequestHeader]::Authorization] = "Bearer $controlToken"
        $response = $request.GetResponse()
        try {
            return [int]$response.StatusCode -eq 202
        } finally {
            $response.Dispose()
        }
    } catch {
        return $false
    }
}

function Get-DescendantProcessRows {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$RootProcessId,
        [Parameter(Mandatory = $true)]
        [object[]]$Processes
    )

    $frontier = @($RootProcessId)
    $seen = @{}
    $rows = @()
    $depth = 1
    while ($frontier.Count -gt 0) {
        $next = @()
        foreach ($processRow in $Processes) {
            $processId = [int]$processRow.ProcessId
            $parentProcessId = [int]$processRow.ParentProcessId
            if ($frontier -notcontains $parentProcessId -or $seen.ContainsKey($processId)) { continue }
            $seen[$processId] = $true
            $rows += [pscustomobject]@{
                ProcessId = $processId
                Depth = $depth
            }
            $next += $processId
        }
        $frontier = @($next)
        $depth += 1
    }
    return @($rows)
}

function Stop-ProcessByIdVerified {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    $savedErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $taskkill /PID $ProcessId /F 2>$null | Out-Null
        $taskkillExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    $stillRunning = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($taskkillExitCode -ne 0 -and $stillRunning) {
        throw "Could not stop fixed-route process PID $ProcessId."
    }
}

function Write-RouteRestartRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$SupervisorPid
    )

    $requestId = [Guid]::NewGuid().ToString("N")
    $payload = [ordered]@{
        schema = "anticodex-route-restart-request-v1"
        requestId = $requestId
        requestedAt = [DateTime]::UtcNow.ToString("o")
        expectedSupervisorPid = $SupervisorPid
    }
    $temporaryPath = "$routeRestartRequestPath.$PID.tmp"
    [IO.File]::WriteAllText(
        $temporaryPath,
        ($payload | ConvertTo-Json -Compress),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $routeRestartRequestPath -Force
    return $requestId
}

$initialSupervisors = @(Get-RunningFixedRouteSupervisor)
$initialSupervisorPid = if ($initialSupervisors.Count -gt 0) {
    [int]$initialSupervisors[0].ProcessId
} else {
    0
}
if ($initialSupervisorPid -le 0) {
    throw "No active Anti-Codex fixed-route supervisor is available for a controlled route switch."
}
$stoppedSupervisorPids = @($initialSupervisors | ForEach-Object { [int]$_.ProcessId })
$routeRestartRequestId = Write-RouteRestartRequest -SupervisorPid $initialSupervisorPid

if ($initialSupervisors.Count -gt 0 -and (Invoke-AntiCodexFixedRouteShutdown)) {
    $gracefulDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (@(Get-RunningFixedRouteSupervisor).Count -gt 0 -and [DateTime]::UtcNow -lt $gracefulDeadline) {
        Start-Sleep -Milliseconds 100
    }
}

foreach ($supervisor in @(Get-RunningFixedRouteSupervisor)) {
    $supervisorPid = [int]$supervisor.ProcessId
    $processSnapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $descendants = @(Get-DescendantProcessRows -RootProcessId $supervisorPid -Processes $processSnapshot)

    Stop-ProcessByIdVerified -ProcessId $supervisorPid
    foreach ($descendant in @($descendants | Sort-Object Depth -Descending)) {
        if ($descendant.ProcessId -eq $PID) { continue }
        Stop-ProcessByIdVerified -ProcessId $descendant.ProcessId
    }

    $descendantExitDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $remainingDescendantPids = @($descendants | Where-Object {
            $_.ProcessId -ne $PID -and (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue)
        } | ForEach-Object { $_.ProcessId })
        if ($remainingDescendantPids.Count -eq 0) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $descendantExitDeadline)
    if ($remainingDescendantPids.Count -gt 0) {
        throw "Could not stop fixed-route child PIDs: $($remainingDescendantPids -join ', ')."
    }
    if ($stoppedSupervisorPids -notcontains $supervisorPid) {
        $stoppedSupervisorPids += $supervisorPid
    }
}

if ($stoppedSupervisorPids.Count -gt 0) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if (@(Get-RunningFixedRouteSupervisor).Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (@(Get-RunningFixedRouteSupervisor).Count -gt 0) {
        throw "Fixed-route supervisor did not stop cleanly."
    }
}

$restartDeadline = [DateTime]::UtcNow.AddSeconds(60)
$launcherPid = 0
do {
    $newSupervisors = @(Get-RunningFixedRouteSupervisor | Where-Object {
        $supervisor = $_
        $stoppedSupervisorPids -notcontains [int]$supervisor.ProcessId
    })
    if ($newSupervisors.Count -gt 0) {
        $launcherPid = [int]$newSupervisors[0].ProcessId
        break
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $restartDeadline)

if ($launcherPid -le 0) {
    throw "The Anti-Codex launch task did not honor route restart request $routeRestartRequestId within 60 seconds."
}

Write-ApplyStatus -State "restart_started" -WorkerPid $PID -LauncherPid $launcherPid

[pscustomobject]@{
    ok = $true
    pid = $launcherPid
    stoppedSupervisorPids = $stoppedSupervisorPids
    message = "Anti-Codex fixed-route restart started."
} | ConvertTo-Json -Compress
