#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$LauncherPath,
    [string]$CandidateRoot = (Join-Path $env:LOCALAPPDATA "Anti-Codex\update-candidate"),
    [string]$ReportPath = "",
    [int]$TimeoutSec = 60,
    [switch]$PreflightOnly,
    [switch]$KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:Checks = New-Object System.Collections.Generic.List[object]
$script:LauncherProcess = $null
$script:InvalidLauncherProcess = $null
$script:RunRoot = $null
$script:CandidateAppDir = $null
$script:CandidateExe = $null
$script:OriginalBefore = $null
$script:ExistingAntiBefore = $null
$script:StableBefore = $null
$script:Failure = $null

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-SamePath {
    param(
        [AllowNull()][string]$Left,
        [AllowNull()][string]$Right
    )
    if (-not $Left -or -not $Right) { return $false }
    return [string]::Equals((Get-FullPath $Left), (Get-FullPath $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Test-PathUnderRoot {
    param(
        [AllowNull()][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    if (-not $Path) { return $false }
    $fullPath = Get-FullPath $Path
    $fullRoot = Get-FullPath $Root
    return (Test-SamePath $fullPath $fullRoot) -or $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-StableJson {
    param([AllowNull()]$Value)
    return ($Value | ConvertTo-Json -Depth 12 -Compress)
}

function Add-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [AllowNull()]$Evidence
    )
    $script:Checks.Add([pscustomobject]@{
        id = $Id
        ok = $Ok
        evidence = $Evidence
    })
    if (-not $Ok) {
        throw "Isolation check failed: $Id"
    }
}

function Get-FreeTcpPort {
    $listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return [int]$listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }
}

function Get-UniquePorts {
    param([int]$Count)
    $ports = New-Object System.Collections.Generic.List[int]
    while ($ports.Count -lt $Count) {
        $port = Get-FreeTcpPort
        if (-not $ports.Contains($port)) { $ports.Add($port) }
    }
    return @($ports)
}

function Get-ProcessRows {
    param([Parameter(Mandatory = $true)][scriptblock]$Predicate)
    $rows = @()
    foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
        $path = $null
        try { $path = [string]$process.Path } catch {}
        $name = if ($path) { [IO.Path]::GetFileName($path) } else { [string]$process.ProcessName + '.exe' }
        $row = [pscustomobject]@{
            ProcessId = [int]$process.Id
            ParentProcessId = 0
            Name = $name
            ExecutablePath = $path
            CreationDate = $null
        }
        if (-not (& $Predicate $row)) { continue }

        try { $row.CreationDate = $process.StartTime } catch {}
        try {
            $parentProperty = $process.PSObject.Properties['Parent']
            if ($parentProperty -and $parentProperty.Value) {
                $row.ParentProcessId = [int]$parentProperty.Value.Id
            }
        } catch {}
        if ($row.ParentProcessId -eq 0) {
            try {
                $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction Stop
                $row.ParentProcessId = [int]$cim.ParentProcessId
            } catch {}
        }

        $created = $null
        if ($row.CreationDate) {
            try { $created = ([DateTime]$row.CreationDate).ToUniversalTime().ToString('o') } catch { $created = [string]$row.CreationDate }
        }
        $rows += [pscustomobject]@{
            processId = [int]$row.ProcessId
            parentProcessId = [int]$row.ParentProcessId
            name = [string]$row.Name
            executablePath = [string]$row.ExecutablePath
            createdAtUtc = $created
        }
    }
    return @($rows | Sort-Object executablePath, processId)
}

function Get-OriginalCodexProcesses {
    return @(Get-ProcessRows {
        param($process)
        $path = [string]$process.ExecutablePath
        return $path -and $path -match '\\WindowsApps\\OpenAI\.Codex_' -and $process.Name -in @('ChatGPT.exe', 'Codex.exe', 'codex.exe')
    })
}

function Get-ExistingAntiCodexProcesses {
    return @(Get-ProcessRows {
        param($process)
        return $process.Name -eq 'Anti-Codex.exe' -and $process.ExecutablePath -and -not (Test-PathUnderRoot ([string]$process.ExecutablePath) $script:CandidateAppDir)
    })
}

function Get-CandidateProcesses {
    return @(Get-ProcessRows {
        param($process)
        return $process.ExecutablePath -and (Test-PathUnderRoot ([string]$process.ExecutablePath) $script:CandidateAppDir)
    })
}

function Get-FileFingerprint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$MetadataOnly
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{ path = $Path; exists = $false; metadataOnly = [bool]$MetadataOnly }
    }
    $item = Get-Item -LiteralPath $Path
    $hash = $null
    if (-not $MetadataOnly) {
        $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return [pscustomobject]@{
        path = $item.FullName
        exists = $true
        metadataOnly = [bool]$MetadataOnly
        length = [long]$item.Length
        lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
        sha256 = $hash
    }
}

function Get-TreeMetadata {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return [pscustomobject]@{ path = $Path; exists = $false; files = @() }
    }
    $root = Get-FullPath $Path
    $prefix = $root + '\'
    $files = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $root -Force -Recurse -File -ErrorAction Stop | Sort-Object FullName)) {
        $files += [pscustomobject]@{
            relativePath = $item.FullName.Substring($prefix.Length)
            length = [long]$item.Length
            lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
        }
    }
    return [pscustomobject]@{ path = $root; exists = $true; files = $files }
}

function Get-TreeSummary {
    param([Parameter(Mandatory = $true)][string]$Path)
    $tree = Get-TreeMetadata -Path $Path
    if (-not $tree.exists) {
        return [pscustomobject]@{ path=$tree.path; exists=$false; fileCount=0; totalBytes=0; samples=@() }
    }
    $files = @($tree.files)
    return [pscustomobject]@{
        path = $tree.path
        exists = $true
        fileCount = $files.Count
        totalBytes = [long](($files | Measure-Object -Property length -Sum).Sum)
        samples = @($files | Select-Object -First 12)
    }
}

function Get-WatcherSnapshot {
    $runValue = $null
    try {
        $key = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction Stop
        $property = $key.PSObject.Properties['CodexPlusPlusWatcher']
        if ($property) { $runValue = [string]$property.Value }
    } catch {}
    $shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\CodexPlusPlusWatcher.lnk'
    return [pscustomobject]@{
        registryValue = $runValue
        startupShortcut = Get-FileFingerprint -Path $shortcut -MetadataOnly
    }
}

function Get-EnvironmentSnapshot {
    $rows = @()
    foreach ($name in @(
        'CODEX_PLUS_STATE_DIR',
        'CODEX_PLUS_APP_EXECUTABLE',
        'CODEX_PLUS_PROTOCOL_PROXY_PORT',
        'CODEX_PLUS_LAUNCHER_GUARD_PORT',
        'CODEX_PLUS_MANAGER_GUARD_PORT',
        'CODEX_HOME'
    )) {
        $rows += [pscustomobject]@{
            name = $name
            user = [Environment]::GetEnvironmentVariable($name, 'User')
            machine = [Environment]::GetEnvironmentVariable($name, 'Machine')
        }
    }
    return $rows
}

function Get-StableOriginalSnapshot {
    $officialProcesses = Get-OriginalCodexProcesses
    $officialFiles = @()
    $officialRoots = @($officialProcesses | ForEach-Object { Split-Path -Parent $_.executablePath } | Sort-Object -Unique)
    foreach ($root in $officialRoots) {
        foreach ($relative in @('ChatGPT.exe', 'Codex.exe', 'resources\app.asar', 'resources\codex.exe')) {
            $path = Join-Path $root $relative
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                $officialFiles += Get-FileFingerprint -Path $path
            }
        }
    }

    $codexHome = Join-Path $env:USERPROFILE '.codex'
    $stableCodexFiles = @(
        $(Get-FileFingerprint -Path (Join-Path $codexHome 'config.toml'))
        $(Get-FileFingerprint -Path (Join-Path $codexHome 'AGENTS.md'))
        $(Get-FileFingerprint -Path (Join-Path $codexHome 'auth.json') -MetadataOnly)
    )
    $shortcuts = @(
        $(Get-FileFingerprint -Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex.lnk') -MetadataOnly)
        $(Get-FileFingerprint -Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex.lnk') -MetadataOnly)
    )
    return [pscustomobject]@{
        officialFiles = $officialFiles
        stableCodexFiles = $stableCodexFiles
        shortcuts = $shortcuts
        defaultCodexPlusState = (Get-TreeMetadata -Path (Join-Path $env:USERPROFILE '.codex-session-delete'))
        watcher = (Get-WatcherSnapshot)
        persistentEnvironment = @(Get-EnvironmentSnapshot)
    }
}

function New-IsolatedLayout {
    param([Parameter(Mandatory = $true)][string]$Root)
    $layout = [pscustomobject]@{
        root = Get-FullPath $Root
        state = Get-FullPath (Join-Path $Root 'codex-plus-state')
        codexHome = Get-FullPath (Join-Path $Root 'codex-home')
        appData = Get-FullPath (Join-Path $Root 'appdata')
        localAppData = Get-FullPath (Join-Path $Root 'localappdata')
        userData = Get-FullPath (Join-Path $Root 'electron-user-data')
        temp = Get-FullPath (Join-Path $Root 'temp')
        antiCodexState = Get-FullPath (Join-Path $Root 'anticodex-state')
    }
    foreach ($path in @($layout.root, $layout.state, $layout.codexHome, $layout.appData, $layout.localAppData, $layout.userData, $layout.temp, $layout.antiCodexState)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
    $settings = [ordered]@{
        codexExtraArgs = @("--user-data-dir=$($layout.userData)", '--no-first-run')
        enhancementsEnabled = $false
        providerSyncEnabled = $false
        relayProfilesEnabled = $false
        computerUseGuardEnabled = $false
        codexAppPluginMarketplaceUnlock = $false
        codexAppNativeMenuLocalization = $false
        codexAppFastStartup = $false
    }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $layout.state 'settings.json'), ($settings | ConvertTo-Json -Depth 8), $encoding)
    return $layout
}

function New-LauncherStartInfo {
    param(
        [Parameter(Mandatory = $true)]$Layout,
        [Parameter(Mandatory = $true)][string]$ExecutableOverride,
        [Parameter(Mandatory = $true)][int[]]$Ports
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $script:LauncherPath
    $info.WorkingDirectory = $script:CandidateAppDir
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.Arguments = "--app-path `"$($script:CandidateAppDir)`" --debug-port $($Ports[0]) --helper-port $($Ports[1])"
    $childEnvironment = [ordered]@{
        CODEX_PLUS_STATE_DIR = $Layout.state
        CODEX_PLUS_APP_EXECUTABLE = $ExecutableOverride
        CODEX_PLUS_PROTOCOL_PROXY_PORT = [string]$Ports[2]
        CODEX_PLUS_LAUNCHER_GUARD_PORT = [string]$Ports[3]
        CODEX_PLUS_MANAGER_GUARD_PORT = [string]$Ports[4]
        CODEX_HOME = $Layout.codexHome
        CODEX_HOME_DIR = $Layout.codexHome
        APPDATA = $Layout.appData
        LOCALAPPDATA = $Layout.localAppData
        TEMP = $Layout.temp
        TMP = $Layout.temp
        DEEPCODEX_STATE_ROOT = $Layout.antiCodexState
        DEEPCODEX_CDP_PORT = [string]$Ports[0]
    }
    foreach ($entry in $childEnvironment.GetEnumerator()) {
        $info.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
    }
    return $info
}

function Test-CdpReady {
    param([int]$Port)
    try {
        $result = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -Method Get -TimeoutSec 2 -UseBasicParsing
        return [bool]$result.webSocketDebuggerUrl
    } catch {
        return $false
    }
}

function Stop-TestProcesses {
    $candidate = @(Get-CandidateProcesses | Sort-Object processId -Descending)
    foreach ($process in $candidate) {
        Stop-Process -Id $process.processId -Force -ErrorAction SilentlyContinue
    }
    foreach ($process in @($script:InvalidLauncherProcess, $script:LauncherProcess)) {
        if ($process -and -not $process.HasExited) {
            try {
                $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction Stop
                if (Test-SamePath ([string]$live.ExecutablePath) $script:LauncherPath) {
                    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                }
            } catch {}
        }
    }
    Start-Sleep -Milliseconds 750
}

$startedAtUtc = [DateTime]::UtcNow
$runId = 'r' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$script:LauncherPath = Get-FullPath (Resolve-Path -LiteralPath $LauncherPath -ErrorAction Stop).Path
$candidateRootFull = Get-FullPath (Resolve-Path -LiteralPath $CandidateRoot -ErrorAction Stop).Path
$script:CandidateAppDir = Get-FullPath (Join-Path $candidateRootFull 'codex-patched-app')
$script:CandidateExe = Get-FullPath (Join-Path $script:CandidateAppDir 'Anti-Codex.exe')
if (-not (Test-Path -LiteralPath $script:CandidateExe -PathType Leaf)) { throw "Candidate executable is missing: $($script:CandidateExe)" }
if (-not (Test-Path -LiteralPath (Join-Path $candidateRootFull 'codex-patched-app.ok') -PathType Leaf)) { throw "Candidate manifest is missing." }

$repoRoot = Split-Path -Parent $PSScriptRoot
$upstream = Get-Content -LiteralPath (Join-Path $repoRoot 'third_party\codexplusplus\upstream.json') -Raw | ConvertFrom-Json
$actualLauncherHash = (Get-FileHash -LiteralPath $script:LauncherPath -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedLauncherHash = ([string]$upstream.verification.launcherReleaseBuild).Replace('sha256:', '').ToLowerInvariant()
if ($actualLauncherHash -ne $expectedLauncherHash) { throw "Launcher hash does not match the sealed build." }

if (-not $ReportPath) {
    $ReportPath = Join-Path $env:TEMP "AntiCodex-CodexPlusPlus-Isolation\latest-runtime-isolation.json"
}
$reportFull = Get-FullPath $ReportPath
$preflightOriginal = @(Get-OriginalCodexProcesses)
$preflightExistingAnti = @(Get-ExistingAntiCodexProcesses)
$preflightCandidate = @(Get-CandidateProcesses)
if ($PreflightOnly) {
    $preflightChecks = @(
        [pscustomobject]@{ id='sealed_launcher_hash'; ok=($actualLauncherHash -eq $expectedLauncherHash); evidence=$actualLauncherHash }
        [pscustomobject]@{ id='candidate_executable_present'; ok=(Test-Path -LiteralPath $script:CandidateExe -PathType Leaf); evidence=$script:CandidateExe }
        [pscustomobject]@{ id='candidate_not_running'; ok=($preflightCandidate.Count -eq 0); evidence=$preflightCandidate }
        [pscustomobject]@{ id='original_codex_detected'; ok=($preflightOriginal.Count -gt 0); evidence=$preflightOriginal }
        [pscustomobject]@{ id='existing_anticodex_baseline_captured'; ok=$true; evidence=$preflightExistingAnti }
    )
    $preflightFailed = @($preflightChecks | Where-Object { $_.ok -ne $true })
    $preflightReport = [ordered]@{
        schema = 'anticodex-codexplusplus-runtime-isolation-preflight-v1'
        runId = $runId
        startedAtUtc = $startedAtUtc.ToString('o')
        finishedAtUtc = [DateTime]::UtcNow.ToString('o')
        preflightOnly = $true
        ok = ($preflightFailed.Count -eq 0)
        noModelTraffic = $true
        launcher = [ordered]@{ path=$script:LauncherPath; sha256=$actualLauncherHash; patchCommit=[string]$upstream.patchCommit }
        candidate = [ordered]@{ root=$candidateRootFull; appDir=$script:CandidateAppDir; executable=$script:CandidateExe }
        checks = $preflightChecks
        failedCheckIds = @($preflightFailed | ForEach-Object { $_.id })
    }
    $reportDirectory = Split-Path -Parent $reportFull
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($reportFull, ($preflightReport | ConvertTo-Json -Depth 12), $utf8)
    [pscustomobject]@{ ok=$preflightReport.ok; preflightOnly=$true; reportPath=$reportFull; checkCount=$preflightChecks.Count; failedCheckIds=$preflightReport.failedCheckIds } | ConvertTo-Json -Compress
    if ($preflightReport.ok -ne $true) { exit 1 }
    exit 0
}

$script:RunRoot = Get-FullPath (Join-Path $env:TEMP "AntiCodex-CodexPlusPlus-Isolation\$runId")
New-Item -ItemType Directory -Path $script:RunRoot -Force | Out-Null

$ports = Get-UniquePorts -Count 5
$invalidLayout = New-IsolatedLayout -Root (Join-Path $script:RunRoot 'invalid-selector')
$validLayout = New-IsolatedLayout -Root (Join-Path $script:RunRoot 'valid-launch')
$invalidExitCode = $null
$launchStatus = $null
$candidateDuring = @()
$originalDuring = @()
$existingAntiDuring = @()
$stableDuring = $null
$originalAfter = @()
$existingAntiAfter = @()
$stableAfter = $null

try {
    $preexistingCandidate = @(Get-CandidateProcesses)
    Add-Check -Id 'candidate_not_running_before_test' -Ok ($preexistingCandidate.Count -eq 0) -Evidence $preexistingCandidate

    $script:OriginalBefore = @(Get-OriginalCodexProcesses)
    $script:ExistingAntiBefore = @(Get-ExistingAntiCodexProcesses)
    $script:StableBefore = Get-StableOriginalSnapshot
    Add-Check -Id 'original_codex_detected' -Ok ($script:OriginalBefore.Count -gt 0) -Evidence $script:OriginalBefore

    $invalidExecutable = Join-Path $script:CandidateAppDir 'missing-Anti-Codex.exe'
    $invalidInfo = New-LauncherStartInfo -Layout $invalidLayout -ExecutableOverride $invalidExecutable -Ports $ports
    $script:InvalidLauncherProcess = [Diagnostics.Process]::Start($invalidInfo)
    $invalidExited = $script:InvalidLauncherProcess.WaitForExit(15000)
    if ($invalidExited) { $invalidExitCode = $script:InvalidLauncherProcess.ExitCode }
    Add-Check -Id 'invalid_executable_rejected' -Ok ($invalidExited -and $invalidExitCode -ne 0 -and @(Get-CandidateProcesses).Count -eq 0) -Evidence ([pscustomobject]@{ exited=$invalidExited; exitCode=$invalidExitCode })
    Add-Check -Id 'invalid_probe_original_processes_unchanged' -Ok ((ConvertTo-StableJson $script:OriginalBefore) -eq (ConvertTo-StableJson @(Get-OriginalCodexProcesses))) -Evidence $null

    $validInfo = New-LauncherStartInfo -Layout $validLayout -ExecutableOverride $script:CandidateExe -Ports $ports
    $script:LauncherProcess = [Diagnostics.Process]::Start($validInfo)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    $ready = $false
    do {
        if ($script:LauncherProcess.HasExited) { break }
        $candidateDuring = @(Get-CandidateProcesses)
        $statusPath = Join-Path $validLayout.state 'latest-status.json'
        if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
            try { $launchStatus = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } catch { $launchStatus = $null }
        }
        if ($candidateDuring.Count -gt 0 -and $launchStatus -and $launchStatus.status -eq 'running' -and (Test-CdpReady -Port $ports[0])) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)

    Add-Check -Id 'launcher_remained_running' -Ok (-not $script:LauncherProcess.HasExited) -Evidence ([pscustomobject]@{ processId=$script:LauncherProcess.Id })
    Add-Check -Id 'candidate_process_exact_path' -Ok ($ready -and @($candidateDuring | Where-Object { $_.name -eq 'Anti-Codex.exe' -and (Test-SamePath $_.executablePath $script:CandidateExe) }).Count -gt 0) -Evidence $candidateDuring
    Add-Check -Id 'candidate_parent_is_launcher' -Ok (@($candidateDuring | Where-Object { $_.name -eq 'Anti-Codex.exe' -and $_.parentProcessId -eq $script:LauncherProcess.Id }).Count -gt 0) -Evidence ([pscustomobject]@{ launcherProcessId=$script:LauncherProcess.Id })
    Add-Check -Id 'isolated_status_path' -Ok ($launchStatus -and $launchStatus.status -eq 'running' -and [int]$launchStatus.debug_port -eq $ports[0] -and (Test-SamePath ([string]$launchStatus.codex_app) $script:CandidateAppDir)) -Evidence $launchStatus
    Add-Check -Id 'isolated_user_data_written' -Ok (@(Get-ChildItem -LiteralPath $validLayout.userData -Force -Recurse -File -ErrorAction SilentlyContinue).Count -gt 0) -Evidence (Get-TreeSummary -Path $validLayout.userData)
    Add-Check -Id 'isolated_codex_home_written' -Ok (@(Get-ChildItem -LiteralPath $validLayout.codexHome -Force -Recurse -File -ErrorAction SilentlyContinue).Count -gt 0) -Evidence (Get-TreeSummary -Path $validLayout.codexHome)

    $originalDuring = @(Get-OriginalCodexProcesses)
    $existingAntiDuring = @(Get-ExistingAntiCodexProcesses)
    $stableDuring = Get-StableOriginalSnapshot
    Add-Check -Id 'original_processes_unchanged' -Ok ((ConvertTo-StableJson $script:OriginalBefore) -eq (ConvertTo-StableJson $originalDuring)) -Evidence ([pscustomobject]@{ before=$script:OriginalBefore; during=$originalDuring })
    Add-Check -Id 'existing_anticodex_processes_unchanged' -Ok ((ConvertTo-StableJson $script:ExistingAntiBefore) -eq (ConvertTo-StableJson $existingAntiDuring)) -Evidence ([pscustomobject]@{ before=$script:ExistingAntiBefore; during=$existingAntiDuring })
    Add-Check -Id 'original_files_unchanged' -Ok ((ConvertTo-StableJson $script:StableBefore.officialFiles) -eq (ConvertTo-StableJson $stableDuring.officialFiles) -and (ConvertTo-StableJson $script:StableBefore.stableCodexFiles) -eq (ConvertTo-StableJson $stableDuring.stableCodexFiles) -and (ConvertTo-StableJson $script:StableBefore.shortcuts) -eq (ConvertTo-StableJson $stableDuring.shortcuts)) -Evidence $null
    Add-Check -Id 'default_codexplus_state_unchanged' -Ok ((ConvertTo-StableJson $script:StableBefore.defaultCodexPlusState) -eq (ConvertTo-StableJson $stableDuring.defaultCodexPlusState)) -Evidence $stableDuring.defaultCodexPlusState
    Add-Check -Id 'global_watcher_unchanged' -Ok ((ConvertTo-StableJson $script:StableBefore.watcher) -eq (ConvertTo-StableJson $stableDuring.watcher)) -Evidence $stableDuring.watcher
    Add-Check -Id 'persistent_environment_unchanged' -Ok ((ConvertTo-StableJson $script:StableBefore.persistentEnvironment) -eq (ConvertTo-StableJson $stableDuring.persistentEnvironment)) -Evidence $stableDuring.persistentEnvironment
} catch {
    $script:Failure = $_.Exception.Message
} finally {
    Stop-TestProcesses
    $originalAfter = @(Get-OriginalCodexProcesses)
    $existingAntiAfter = @(Get-ExistingAntiCodexProcesses)
    $stableAfter = Get-StableOriginalSnapshot
    $candidateAfter = @(Get-CandidateProcesses)
    $cleanupOk = $candidateAfter.Count -eq 0
    $script:Checks.Add([pscustomobject]@{ id='test_processes_cleaned'; ok=$cleanupOk; evidence=$candidateAfter })
    $script:Checks.Add([pscustomobject]@{ id='original_processes_unchanged_after_cleanup'; ok=((ConvertTo-StableJson $script:OriginalBefore) -eq (ConvertTo-StableJson $originalAfter)); evidence=$originalAfter })
    $script:Checks.Add([pscustomobject]@{ id='existing_anticodex_unchanged_after_cleanup'; ok=((ConvertTo-StableJson $script:ExistingAntiBefore) -eq (ConvertTo-StableJson $existingAntiAfter)); evidence=$existingAntiAfter })
    $script:Checks.Add([pscustomobject]@{ id='stable_original_state_unchanged_after_cleanup'; ok=((ConvertTo-StableJson $script:StableBefore) -eq (ConvertTo-StableJson $stableAfter)); evidence=$null })
}

$failedChecks = @($script:Checks | Where-Object { $_.ok -ne $true })
$report = [ordered]@{
    schema = 'anticodex-codexplusplus-runtime-isolation-v1'
    runId = $runId
    startedAtUtc = $startedAtUtc.ToString('o')
    finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    ok = (-not $script:Failure -and $failedChecks.Count -eq 0)
    noModelTraffic = $true
    launcher = [ordered]@{ path=$script:LauncherPath; sha256=$actualLauncherHash; patchCommit=[string]$upstream.patchCommit }
    candidate = [ordered]@{ root=$candidateRootFull; appDir=$script:CandidateAppDir; executable=$script:CandidateExe }
    ports = [ordered]@{ debug=$ports[0]; helper=$ports[1]; protocolProxy=$ports[2]; launcherGuard=$ports[3]; managerGuard=$ports[4] }
    isolatedPaths = $validLayout
    invalidSelectorExitCode = $invalidExitCode
    checks = $script:Checks
    failedCheckIds = @($failedChecks | ForEach-Object { $_.id })
    failure = $script:Failure
    processEvidence = [ordered]@{
        originalBefore = $script:OriginalBefore
        originalDuring = $originalDuring
        originalAfter = $originalAfter
        existingAntiBefore = $script:ExistingAntiBefore
        existingAntiDuring = $existingAntiDuring
        existingAntiAfter = $existingAntiAfter
        candidateDuring = $candidateDuring
    }
}

$reportDirectory = Split-Path -Parent $reportFull
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($reportFull, ($report | ConvertTo-Json -Depth 16), $utf8)

if (-not $KeepArtifacts -and $report.ok -eq $true -and (Test-Path -LiteralPath $script:RunRoot -PathType Container)) {
    $tempRoot = Get-FullPath (Join-Path $env:TEMP 'AntiCodex-CodexPlusPlus-Isolation')
    if (Test-PathUnderRoot $script:RunRoot $tempRoot) {
        Remove-Item -LiteralPath $script:RunRoot -Recurse -Force
    }
}

[pscustomobject]@{ ok=$report.ok; reportPath=$reportFull; checkCount=$script:Checks.Count; failedCheckIds=$report.failedCheckIds; failure=$report.failure } | ConvertTo-Json -Compress
if ($report.ok -ne $true) { exit 1 }
