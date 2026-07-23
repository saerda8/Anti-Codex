#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$LauncherPath,
    [string]$CandidateRoot = (Join-Path $env:LOCALAPPDATA 'Anti-Codex\update-candidate'),
    [string]$ReportPath = '',
    [int]$TimeoutSec = 90,
    [switch]$LaunchDesktop,
    [switch]$KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Checks = New-Object System.Collections.Generic.List[object]
$script:Failure = $null
$script:RunRoot = $null
$script:LauncherProcess = $null
$script:FakeProcess = $null
$script:CandidateAppDir = $null
$script:CandidateExe = $null
$script:LauncherExecutable = $null
$script:OriginalBefore = $null
$script:AntiCodexBefore = $null
$script:StableBefore = $null
$script:ProbeResult = $null
$script:NativeCliResult = $null
$script:Ports = @()

function Get-AntiCodexSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace("-", "")
    } finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-PathUnderRoot {
    param(
        [AllowNull()][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    if (-not $Path) { return $false }
    $fullPath = Get-FullPath $Path
    $fullRoot = Get-FullPath $Root
    return [string]::Equals($fullPath, $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-StableJson {
    param([AllowNull()]$Value)
    return ($Value | ConvertTo-Json -Depth 16 -Compress)
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Contents
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Contents, $encoding)
}

function Add-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [AllowNull()]$Evidence
    )
    $script:Checks.Add([pscustomobject]@{ id = $Id; ok = $Ok; evidence = $Evidence })
    if (-not $Ok) { throw "Gate 2 check failed: $Id" }
}

function Record-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [AllowNull()]$Evidence
    )
    $script:Checks.Add([pscustomobject]@{ id = $Id; ok = $Ok; evidence = $Evidence })
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
    $rows = @()
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
        $created = $null
        if ($process.CreationDate) {
            try { $created = ([DateTime]$process.CreationDate).ToUniversalTime().ToString('o') } catch { $created = [string]$process.CreationDate }
        }
        $rows += [pscustomobject]@{
            processId = [int]$process.ProcessId
            parentProcessId = [int]$process.ParentProcessId
            name = [string]$process.Name
            executablePath = [string]$process.ExecutablePath
            createdAtUtc = $created
        }
    }
    return @($rows | Sort-Object executablePath, processId)
}

function Get-OriginalCodexProcesses {
    return @(Get-ProcessRows | Where-Object {
        $_.executablePath -and
        $_.executablePath -match '\\WindowsApps\\OpenAI\.Codex_' -and
        $_.name -in @('ChatGPT.exe', 'Codex.exe', 'codex.exe')
    })
}

function Get-ExistingAntiCodexProcesses {
    return @(Get-ProcessRows | Where-Object {
        $_.name -eq 'Anti-Codex.exe' -and
        $_.executablePath -and
        -not (Test-PathUnderRoot $_.executablePath $script:CandidateAppDir)
    })
}

function Get-CandidateProcesses {
    return @(Get-ProcessRows | Where-Object {
        $_.executablePath -and (Test-PathUnderRoot $_.executablePath $script:CandidateAppDir)
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
        $hash = (Get-AntiCodexSha256 -Path $Path).ToLowerInvariant()
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
            sha256 = (Get-AntiCodexSha256 -Path $item.FullName).ToLowerInvariant()
        }
    }
    return [pscustomobject]@{ path = $root; exists = $true; files = $files }
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
    return [pscustomobject]@{
        officialFiles = $officialFiles
        stableCodexFiles = @(
            $(Get-FileFingerprint -Path (Join-Path $codexHome 'config.toml'))
            $(Get-FileFingerprint -Path (Join-Path $codexHome 'AGENTS.md'))
            $(Get-FileFingerprint -Path (Join-Path $codexHome 'auth.json') -MetadataOnly)
        )
        shortcuts = @(
            $(Get-FileFingerprint -Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex.lnk') -MetadataOnly)
            $(Get-FileFingerprint -Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex.lnk') -MetadataOnly)
        )
        persistentEnvironment = @(Get-EnvironmentSnapshot)
        watcher = Get-WatcherSnapshot
    }
}

function Quote-ProcessArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Join-ProcessArguments {
    param([Parameter(Mandatory = $true)][string[]]$Values)
    return (($Values | ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join ' ')
}

function Invoke-ChildProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [hashtable]$Environment = @{},
        [int]$TimeoutMilliseconds = 90000
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $FileName
    $info.Arguments = Join-ProcessArguments $Arguments
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($entry in $Environment.GetEnumerator()) {
        $info.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
    }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw "failed to start $FileName" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
        try { $process.Kill() } catch {}
        throw "process timed out after $TimeoutMilliseconds ms: $FileName"
    }
    return [pscustomobject]@{
        exitCode = [int]$process.ExitCode
        stdout = $stdoutTask.GetAwaiter().GetResult()
        stderr = $stderrTask.GetAwaiter().GetResult()
        processId = [int]$process.Id
    }
}

function Wait-Until {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [int]$Seconds = 60,
        [string]$Description = 'condition'
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        try {
            $value = & $Condition
            if ($value) { return $value }
        } catch {}
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "timed out waiting for $Description"
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
        workspace = Get-FullPath (Join-Path $Root 'workspace')
        fakeReady = Get-FullPath (Join-Path $Root 'fake-ready.json')
        fakeLog = Get-FullPath (Join-Path $Root 'fake-chat.jsonl')
    }
    foreach ($path in @(
        $layout.root, $layout.state, $layout.codexHome, $layout.appData,
        $layout.localAppData, $layout.userData, $layout.temp,
        $layout.antiCodexState, $layout.workspace
    )) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
    return $layout
}

function New-ChildEnvironment {
    param(
        [Parameter(Mandatory = $true)]$Layout,
        [Parameter(Mandatory = $true)][int[]]$Ports
    )
    return @{
        CODEX_PLUS_STATE_DIR = $Layout.state
        CODEX_PLUS_APP_EXECUTABLE = $script:CandidateExe
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
}

function Start-FakeServer {
    param(
        [Parameter(Mandatory = $true)]$Layout,
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string]$FixturePath
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $NodePath
    $info.Arguments = Join-ProcessArguments @($FixturePath, '--host', '127.0.0.1', '--port', '0', '--ready', $Layout.fakeReady, '--log', $Layout.fakeLog)
    $info.WorkingDirectory = Split-Path -Parent $FixturePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'failed to start fake Chat server' }
    return $process
}

function Start-SealedLauncher {
    param(
        [Parameter(Mandatory = $true)]$Layout,
        [Parameter(Mandatory = $true)][int[]]$Ports,
        [Parameter(Mandatory = $true)][hashtable]$Environment
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $script:LauncherExecutable
    $info.WorkingDirectory = $script:CandidateAppDir
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    if ($LaunchDesktop) {
        $info.Arguments = Join-ProcessArguments @('--app-path', $script:CandidateAppDir, '--debug-port', [string]$Ports[0], '--helper-port', [string]$Ports[1])
    } else {
        $info.Arguments = Join-ProcessArguments @('--helper-only', '--helper-port', [string]$Ports[2])
    }
    foreach ($entry in $Environment.GetEnumerator()) {
        $info.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
    }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'failed to start sealed CodexPlusPlus launcher' }
    return $process
}

function Stop-TestProcesses {
    foreach ($process in @(Get-CandidateProcesses | Sort-Object processId -Descending)) {
        Stop-Process -Id $process.processId -Force -ErrorAction SilentlyContinue
    }
    foreach ($process in @($script:LauncherProcess, $script:FakeProcess)) {
        if ($process -and -not $process.HasExited) {
            try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    Start-Sleep -Milliseconds 750
}

$startedAtUtc = [DateTime]::UtcNow
$runId = 'r' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$repoRoot = Get-FullPath (Split-Path -Parent $PSScriptRoot)
$script:LauncherExecutable = Get-FullPath (Resolve-Path -LiteralPath $LauncherPath -ErrorAction Stop).Path
$candidateRootFull = Get-FullPath (Resolve-Path -LiteralPath $CandidateRoot -ErrorAction Stop).Path
$script:CandidateAppDir = Get-FullPath (Join-Path $candidateRootFull 'codex-patched-app')
$script:CandidateExe = Get-FullPath (Join-Path $script:CandidateAppDir 'Anti-Codex.exe')
$candidateCli = Get-FullPath (Join-Path $script:CandidateAppDir 'resources\codex.exe')
$fixturePath = Get-FullPath (Join-Path $repoRoot 'scripts\fixtures\codexplusplus-gate2\fake-chat-server.mjs')
$probePath = Get-FullPath (Join-Path $repoRoot 'scripts\lib\codexplusplus-gate2-probe.mjs')
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$releaseReportRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'anticodex\reports'
$releaseBindingHelper = Join-Path $repoRoot 'scripts\lib\anticodex-release-binding.mjs'
$releaseBindingJson = & $nodePath $releaseBindingHelper --source-root $repoRoot --report-root $releaseReportRoot
if ($LASTEXITCODE -ne 0 -or -not $releaseBindingJson) {
    throw 'Gate 2 could not derive the current Anti-Codex release binding.'
}
$releaseBinding = $releaseBindingJson | ConvertFrom-Json
if (-not $ReportPath) {
    $ReportPath = Join-Path $repoRoot 'docs\audits\2026-07-14-codexplusplus-third-party-route.json'
}
$reportFull = Get-FullPath $ReportPath
$script:RunRoot = Get-FullPath (Join-Path $env:TEMP "AntiCodex-CodexPlusPlus-Gate2-$runId")
$layout = $null
$stableAfter = $null
$originalAfter = @()
$antiCodexAfter = @()
$cleanupCandidate = @()
$cleanupLauncherAlive = $false
$cleanupFakeAlive = $false

try {
    Add-Check 'current_release_binding_available' ($releaseBinding.valid -eq $true) $releaseBinding
    if ($releaseBinding.valid -ne $true) { throw 'Current Anti-Codex release binding is invalid.' }
    Add-Check 'launcher_exists' (Test-Path -LiteralPath $script:LauncherExecutable -PathType Leaf) $script:LauncherExecutable
    Add-Check 'candidate_exists' (Test-Path -LiteralPath $script:CandidateExe -PathType Leaf) $script:CandidateExe
    Add-Check 'candidate_cli_exists' (Test-Path -LiteralPath $candidateCli -PathType Leaf) $candidateCli
    Add-Check 'fixture_exists' (Test-Path -LiteralPath $fixturePath -PathType Leaf) $fixturePath
    Add-Check 'probe_exists' (Test-Path -LiteralPath $probePath -PathType Leaf) $probePath

    $preexistingCandidates = @(Get-CandidateProcesses)
    Add-Check 'candidate_not_already_running' ($preexistingCandidates.Count -eq 0) $preexistingCandidates
    $script:OriginalBefore = @(Get-OriginalCodexProcesses)
    $script:AntiCodexBefore = @(Get-ExistingAntiCodexProcesses)
    $script:StableBefore = Get-StableOriginalSnapshot

    $layout = New-IsolatedLayout $script:RunRoot
    $script:Ports = Get-UniquePorts 5
    $childEnvironment = New-ChildEnvironment $layout $script:Ports

    $script:FakeProcess = Start-FakeServer $layout $nodePath $fixturePath
    $fakeReady = Wait-Until -Seconds $TimeoutSec -Description 'fake Chat server ready file' -Condition {
        if (-not (Test-Path -LiteralPath $layout.fakeReady -PathType Leaf)) { return $null }
        try { return (Get-Content -LiteralPath $layout.fakeReady -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
    }
    Add-Check 'fake_server_loopback' ([string]$fakeReady.baseUrl -match '^http://127\.0\.0\.1:\d+$') $fakeReady

    $proxyBase = "http://127.0.0.1:$($script:Ports[2])/v1"
    $config = @"
model = "gate2-chat-model"
model_provider = "gate2"
approval_policy = "never"
sandbox_mode = "workspace-write"

[model_providers.gate2]
name = "Gate 2 fake Chat through CodexPlusPlus"
wire_api = "responses"
requires_openai_auth = true
base_url = "$proxyBase"
experimental_bearer_token = "gate2-proxy-key"

[features]
plugins = false
plugin_sharing = false
remote_plugin = false
"@
    Write-Utf8NoBom (Join-Path $layout.codexHome 'config.toml') $config
    Write-Utf8NoBom (Join-Path $layout.codexHome 'auth.json') "{`n  `"OPENAI_API_KEY`": `"gate2-proxy-key`"`n}`n"

    $settings = [ordered]@{
        codexExtraArgs = @("--user-data-dir=$($layout.userData)", '--no-first-run')
        enhancementsEnabled = $false
        providerSyncEnabled = $false
        relayProfilesEnabled = $true
        computerUseGuardEnabled = $false
        codexAppPluginMarketplaceUnlock = $false
        codexAppNativeMenuLocalization = $false
        codexAppFastStartup = $false
        relayProfiles = @([ordered]@{
            id = 'gate2-chat'
            name = 'Gate 2 fake Chat'
            upstreamBaseUrl = "$($fakeReady.baseUrl)/v1"
            protocol = 'chatCompletions'
            relayMode = 'pureApi'
            testModel = 'gate2-chat-model'
            configContents = $config
            authContents = "{`n  `"OPENAI_API_KEY`": `"gate2-test-key`"`n}`n"
            useCommonConfig = $false
            modelList = 'gate2-chat-model'
        })
        activeRelayId = 'gate2-chat'
        relayTestModel = 'gate2-chat-model'
    }
    Write-Utf8NoBom (Join-Path $layout.state 'settings.json') ($settings | ConvertTo-Json -Depth 12)

    $workspaceBefore = Get-TreeMetadata $layout.workspace
    $script:LauncherProcess = Start-SealedLauncher $layout $script:Ports $childEnvironment

    if ($LaunchDesktop) {
        $candidateProcesses = Wait-Until -Seconds $TimeoutSec -Description 'copied Anti-Codex process' -Condition {
            $rows = @(Get-CandidateProcesses)
            if ($rows.Count -gt 0) { return $rows }
            return $null
        }
        Add-Check 'copied_client_launched' ($candidateProcesses.Count -gt 0) $candidateProcesses
        Add-Check 'branded_executable_only' (@($candidateProcesses | Where-Object { $_.name -ne 'Anti-Codex.exe' -and $_.name -ne 'codex.exe' }).Count -eq 0) $candidateProcesses

        $cdpReady = Wait-Until -Seconds $TimeoutSec -Description 'copied client CDP' -Condition {
            try {
                $value = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:Ports[0])/json/version" -TimeoutSec 2 -UseBasicParsing
                if ($value.webSocketDebuggerUrl) { return $value }
            } catch {}
            return $null
        }
        Add-Check 'copied_desktop_cdp_ready' ([bool]$cdpReady.webSocketDebuggerUrl) @{ port = $script:Ports[0] }
    } else {
        Add-Check 'headless_protocol_mode' $true @{ visibleClientLaunched = $false; helperPort = $script:Ports[2] }
    }

    $modelsReady = Wait-Until -Seconds $TimeoutSec -Description 'CodexPlusPlus protocol proxy' -Condition {
        try {
            $value = Invoke-RestMethod -Uri "$proxyBase/models" -Headers @{ Authorization = 'Bearer gate2-proxy-key' } -TimeoutSec 2 -UseBasicParsing
            if (@($value.data | Where-Object { $_.id -eq 'gate2-chat-model' }).Count -eq 1) { return $value }
        } catch {}
        return $null
    }
    Add-Check 'protocol_proxy_model_ready' (@($modelsReady.data | Where-Object { $_.id -eq 'gate2-chat-model' }).Count -eq 1) @{ port = $script:Ports[2] }

    $probeExecution = Invoke-ChildProcess -FileName $nodePath -Arguments @($probePath, '--proxy-url', $proxyBase, '--fake-log', $layout.fakeLog) -WorkingDirectory $repoRoot -TimeoutMilliseconds (($TimeoutSec + 30) * 1000)
    Add-Check 'direct_protocol_probe_exit' ($probeExecution.exitCode -eq 0) @{ exitCode = $probeExecution.exitCode; stderr = $probeExecution.stderr.Trim() }
    $probeLine = @($probeExecution.stdout -split "`r?`n" | Where-Object { $_.Trim() })[-1]
    $script:ProbeResult = $probeLine | ConvertFrom-Json
    Add-Check 'direct_protocol_probe_result' ([bool]$script:ProbeResult.ok) $script:ProbeResult
    Record-Check 'protocol_proxy_upstream_cancellation' ([bool]$script:ProbeResult.checks.cancellation) @{
        observed = [bool]$script:ProbeResult.checks.cancellation
        note = 'A downstream TCP reset did not close the silent upstream stream within the bounded window.'
    }
    Record-Check 'protocol_proxy_upstream_cancellation_before_headers' ([bool]$script:ProbeResult.checks.cancellationBeforeHeaders) @{
        observed = [bool]$script:ProbeResult.checks.cancellationBeforeHeaders
        note = 'A downstream TCP reset did not close an upstream request that was still waiting for response headers.'
    }

    $cliExecution = Invoke-ChildProcess -FileName $candidateCli -Arguments @(
        'exec', '--skip-git-repo-check', '--ephemeral', '-C', $layout.workspace,
        '--sandbox', 'workspace-write', '--color', 'never', '--json',
        'GATE2_TOOL NATIVE_CLI'
    ) -WorkingDirectory $layout.workspace -Environment $childEnvironment -TimeoutMilliseconds (($TimeoutSec + 30) * 1000)
    $script:NativeCliResult = [pscustomobject]@{
        exitCode = $cliExecution.exitCode
        stdoutTail = if ($cliExecution.stdout.Length -gt 4000) { $cliExecution.stdout.Substring($cliExecution.stdout.Length - 4000) } else { $cliExecution.stdout }
        stderrTail = if ($cliExecution.stderr.Length -gt 2000) { $cliExecution.stderr.Substring($cliExecution.stderr.Length - 2000) } else { $cliExecution.stderr }
    }
    Add-Check 'native_codex_cli_exit' ($cliExecution.exitCode -eq 0) $script:NativeCliResult
    Add-Check 'native_codex_cli_final_result' ($cliExecution.stdout -like '*GATE2_TOOL_RESULT:*GATE2_TOOL_OUTPUT*') $script:NativeCliResult
    Add-Check 'native_codex_cli_no_external_plugin_calls' (
        $cliExecution.stderr -notmatch 'chatgpt\.com/backend-api/plugins' -and
        $cliExecution.stderr -notmatch 'remote installed plugin bundle sync failed'
    ) $script:NativeCliResult

    Start-Sleep -Milliseconds 400
    $nativeLogs = @()
    if (Test-Path -LiteralPath $layout.fakeLog -PathType Leaf) {
        foreach ($line in @(Get-Content -LiteralPath $layout.fakeLog -Encoding UTF8 | Where-Object { $_.Trim() })) {
            $entry = $line | ConvertFrom-Json
            if ($entry.response_mode -eq 'GATE2_TOOL' -and [string]$entry.latest_user_text -like '*NATIVE_CLI*') {
                $nativeLogs += $entry
            }
        }
    }
    Add-Check 'native_codex_cli_two_turn_tool_loop' ($nativeLogs.Count -eq 2) $nativeLogs
    Add-Check 'native_codex_cli_exact_tool_result_returned' (@($nativeLogs | Where-Object {
        $_.roles -contains 'tool' -and @($_.tool_message_contents | Where-Object { [string]$_ -like '*GATE2_TOOL_OUTPUT*' }).Count -gt 0
    }).Count -eq 1) $nativeLogs

    $workspaceAfter = Get-TreeMetadata $layout.workspace
    Add-Check 'native_cli_workspace_unchanged' ((ConvertTo-StableJson $workspaceBefore) -eq (ConvertTo-StableJson $workspaceAfter)) @{ before = $workspaceBefore; after = $workspaceAfter }

    $originalDuring = @(Get-OriginalCodexProcesses)
    $antiCodexDuring = @(Get-ExistingAntiCodexProcesses)
    Add-Check 'original_processes_unchanged_during' ((ConvertTo-StableJson $script:OriginalBefore) -eq (ConvertTo-StableJson $originalDuring)) @{ before = $script:OriginalBefore; during = $originalDuring }
    Add-Check 'existing_anticodex_unchanged_during' ((ConvertTo-StableJson $script:AntiCodexBefore) -eq (ConvertTo-StableJson $antiCodexDuring)) @{ before = $script:AntiCodexBefore; during = $antiCodexDuring }
} catch {
    $script:Failure = [pscustomobject]@{
        message = $_.Exception.Message
        type = $_.Exception.GetType().FullName
        scriptStackTrace = $_.ScriptStackTrace
    }
} finally {
    try { Stop-TestProcesses } catch {}
    try { $cleanupCandidate = @(Get-CandidateProcesses) } catch { $cleanupCandidate = @() }
    if ($script:LauncherProcess) {
        try { $cleanupLauncherAlive = -not $script:LauncherProcess.HasExited } catch { $cleanupLauncherAlive = $false }
    }
    if ($script:FakeProcess) {
        try { $cleanupFakeAlive = -not $script:FakeProcess.HasExited } catch { $cleanupFakeAlive = $false }
    }
    try { $originalAfter = @(Get-OriginalCodexProcesses) } catch { $originalAfter = @() }
    try { $antiCodexAfter = @(Get-ExistingAntiCodexProcesses) } catch { $antiCodexAfter = @() }
    try { $stableAfter = Get-StableOriginalSnapshot } catch { $stableAfter = $null }

    $cleanupChecks = @(
        [pscustomobject]@{ id = 'cleanup_candidate_processes'; ok = ($cleanupCandidate.Count -eq 0); evidence = $cleanupCandidate }
        [pscustomobject]@{ id = 'cleanup_launcher_process'; ok = (-not $cleanupLauncherAlive); evidence = @{ alive = $cleanupLauncherAlive } }
        [pscustomobject]@{ id = 'cleanup_fake_process'; ok = (-not $cleanupFakeAlive); evidence = @{ alive = $cleanupFakeAlive } }
        [pscustomobject]@{ id = 'original_processes_unchanged_after'; ok = ((ConvertTo-StableJson $script:OriginalBefore) -eq (ConvertTo-StableJson $originalAfter)); evidence = @{ before = $script:OriginalBefore; after = $originalAfter } }
        [pscustomobject]@{ id = 'existing_anticodex_unchanged_after'; ok = ((ConvertTo-StableJson $script:AntiCodexBefore) -eq (ConvertTo-StableJson $antiCodexAfter)); evidence = @{ before = $script:AntiCodexBefore; after = $antiCodexAfter } }
        [pscustomobject]@{ id = 'original_stable_state_unchanged'; ok = ($stableAfter -and ((ConvertTo-StableJson $script:StableBefore) -eq (ConvertTo-StableJson $stableAfter))); evidence = @{ before = $script:StableBefore; after = $stableAfter } }
    )
    foreach ($check in $cleanupChecks) { $script:Checks.Add($check) }

    $allChecks = $script:Checks.ToArray()
    $report = [ordered]@{
        schemaVersion = 1
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        startedAtUtc = $startedAtUtc.ToString('o')
        runId = $runId
        ok = (-not $script:Failure -and @($allChecks | Where-Object { -not $_.ok }).Count -eq 0)
        gate = 'Gate 2 deterministic third-party provider route'
        launchMode = if ($LaunchDesktop) { 'copied-desktop' } else { 'headless-helper' }
        modelTraffic = 'loopback fake provider only'
        launcherPath = $script:LauncherExecutable
        candidateExecutable = $script:CandidateExe
        candidateCli = $candidateCli
        ports = [ordered]@{
            cdp = if ($script:Ports.Count -ge 1) { $script:Ports[0] } else { $null }
            helper = if ($script:Ports.Count -ge 2) { $script:Ports[1] } else { $null }
            protocolProxy = if ($script:Ports.Count -ge 3) { $script:Ports[2] } else { $null }
            launcherGuard = if ($script:Ports.Count -ge 4) { $script:Ports[3] } else { $null }
            managerGuard = if ($script:Ports.Count -ge 5) { $script:Ports[4] } else { $null }
        }
        checks = $allChecks
        directProbe = $script:ProbeResult
        nativeCli = $script:NativeCliResult
        failure = $script:Failure
        artifactRoot = if ($KeepArtifacts) { $script:RunRoot } else { $null }
        releaseBinding = $releaseBinding
    }
    $reportDirectory = Split-Path -Parent $reportFull
    if (-not (Test-Path -LiteralPath $reportDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    }
    Write-Utf8NoBom $reportFull ($report | ConvertTo-Json -Depth 20)
    if ($report.ok -eq $true) {
        $reportHash = (Get-AntiCodexSha256 -Path $reportFull).ToLowerInvariant()
        [IO.File]::WriteAllText("$reportFull.sha256", "sha256:$reportHash", [Text.Encoding]::ASCII)
    } elseif (Test-Path -LiteralPath "$reportFull.sha256") {
        Remove-Item -LiteralPath "$reportFull.sha256" -Force
    }
    if (-not $KeepArtifacts -and $script:RunRoot -and (Test-Path -LiteralPath $script:RunRoot -PathType Container)) {
        $tempRoot = Get-FullPath $env:TEMP
        if (Test-PathUnderRoot $script:RunRoot $tempRoot) {
            Remove-Item -LiteralPath $script:RunRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$final = Get-Content -LiteralPath $reportFull -Raw -Encoding UTF8 | ConvertFrom-Json
$nativeCliExit = $null
if ($final.nativeCli -and $final.nativeCli.PSObject.Properties['exitCode']) {
    $nativeCliExit = $final.nativeCli.exitCode
}
$summary = [ordered]@{
    ok = [bool]$final.ok
    report = $reportFull
    passed = @($final.checks | Where-Object { $_.ok }).Count
    failed = @($final.checks | Where-Object { -not $_.ok }).Count
    failedIds = @($final.checks | Where-Object { -not $_.ok } | ForEach-Object { $_.id })
    directProbe = $final.directProbe
    nativeCliExit = $nativeCliExit
    failure = $final.failure
}
$summary | ConvertTo-Json -Depth 12 -Compress
if (-not $final.ok) { exit 1 }
