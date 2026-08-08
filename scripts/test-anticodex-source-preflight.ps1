[CmdletBinding()]
param(
    [string]$SourceRoot = "",
    [string]$ReportRoot = "",
    [int]$SubcheckTimeoutSec = 240,
    [switch]$SkipFullRegression,
    [switch]$SelfTestProcessLauncher
)

$ErrorActionPreference = "Stop"
if (-not $SourceRoot) {
    $SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
if (-not $ReportRoot) {
    $ReportRoot = Join-Path $env:APPDATA "anticodex\reports"
}
$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$checks = [ordered]@{}

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Add-Warning {
    param([string]$Message)
    $warnings.Add($Message) | Out-Null
}

function Invoke-OptionalCheck {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Check
    )

    try {
        $result = & $Check
        if ($null -eq $result) {
            Add-Warning "$Name returned no result"
            $result = [pscustomobject]@{ ok = $false; error = "missing_result" }
        }
    } catch {
        Add-Warning "$Name failed: $($_.Exception.Message)"
        $result = [pscustomobject]@{ ok = $false; error = [string]$_.Exception.Message }
    }
    $result | Add-Member -NotePropertyName optional -NotePropertyValue $true -Force
    $result | Add-Member -NotePropertyName productReleaseGating -NotePropertyValue $false -Force
    return $result
}

function Normalize-Path {
    param([string]$Path)
    if (-not $Path) { return "" }
    return [IO.Path]::GetFullPath($Path)
}

function Test-SourcePathInsideRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    try {
        $fullPath = [IO.Path]::GetFullPath($Path)
        $rootPrefix = [IO.Path]::GetFullPath($Root).TrimEnd("\") + "\"
        return $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Get-SourceSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
    } finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Get-SourceRuntimeInventory {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $directoryFull = [IO.Path]::GetFullPath($Directory).TrimEnd("\")
    $directoryItem = Get-Item -LiteralPath $directoryFull -Force -ErrorAction Stop
    if (-not $directoryItem.PSIsContainer -or
        (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "runtime root is not a real directory"
    }
    $directoryPrefix = $directoryFull + "\"
    $entries = [ordered]@{}
    foreach ($item in @(Get-ChildItem -LiteralPath $directoryFull -Recurse -Force -ErrorAction Stop | Sort-Object FullName)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "runtime contains a reparse point"
        }
        $itemFull = [IO.Path]::GetFullPath($item.FullName)
        if (-not $itemFull.StartsWith($directoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "runtime inventory escaped its root"
        }
        $relative = $itemFull.Substring($directoryPrefix.Length)
        if ($relative.Equals(".anticodex-runtime-manifest.json", [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        if ($item.PSIsContainer) {
            $entries[$relative] = [ordered]@{ type = "directory" }
        } elseif ($item -is [IO.FileInfo]) {
            $entries[$relative] = [ordered]@{
                type = "file"
                length = [long]$item.Length
                sha256 = Get-SourceSha256 -Path $itemFull
            }
        } else {
            throw "runtime contains an unsupported filesystem entry"
        }
    }
    return $entries
}

function Get-SourceRuntimeManifestRevision {
    $manifestPath = Join-Path $SourceRoot ".anticodex-runtime-manifest.json"
    try {
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            throw "trusted runtime manifest is missing"
        }
        $manifestItem = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
        if (($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "runtime manifest is a reparse point"
        }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $sourceGitClean = $manifest.sourceGitClean -is [bool] -and [bool]$manifest.sourceGitClean
        if ([string]$manifest.schema -cne "anticodex-runtime-manifest-v2" -or
            [string]$manifest.state -cne "validated" -or
            [string]$manifest.sourceRevisionProvenance -cne "git" -or
            [string]$manifest.sourceGitHead -notmatch "^[a-fA-F0-9]{40}$" -or
            -not $sourceGitClean -or
            [string]::IsNullOrWhiteSpace([string]$manifest.transactionId)) {
            throw "runtime manifest provenance is invalid"
        }
        $manifestActiveRuntime = [IO.Path]::GetFullPath([string]$manifest.activeRuntime).TrimEnd("\")
        $sourceRootFull = [IO.Path]::GetFullPath($SourceRoot).TrimEnd("\")
        if (-not $manifestActiveRuntime.Equals($sourceRootFull, [StringComparison]::OrdinalIgnoreCase)) {
            throw "runtime manifest does not bind the active source root"
        }
        $createdAt = [DateTimeOffset]::MinValue
        if (-not [DateTimeOffset]::TryParse([string]$manifest.createdAt, [ref]$createdAt)) {
            throw "runtime manifest timestamp is invalid"
        }
        if ($null -eq $manifest.entries -or $null -eq $manifest.files) {
            throw "runtime manifest inventory is missing"
        }
        $actualEntries = Get-SourceRuntimeInventory -Directory $SourceRoot
        $manifestEntries = @($manifest.entries.PSObject.Properties)
        if ([int]$manifest.entryCount -le 0 -or
            [int]$manifest.entryCount -ne $actualEntries.Count -or
            $manifestEntries.Count -ne $actualEntries.Count) {
            throw "runtime manifest entry count does not match"
        }
        $declaredEntries = @{}
        foreach ($property in $manifestEntries) {
            $relative = [string]$property.Name
            if ([string]::IsNullOrWhiteSpace($relative) -or
                [IO.Path]::IsPathRooted($relative) -or
                $relative.Equals(".anticodex-runtime-manifest.json", [StringComparison]::OrdinalIgnoreCase) -or
                $declaredEntries.ContainsKey($relative)) {
                throw "runtime manifest contains an invalid entry path"
            }
            $entryPath = [IO.Path]::GetFullPath((Join-Path $sourceRootFull $relative))
            if (-not (Test-SourcePathInsideRoot -Path $entryPath -Root $sourceRootFull)) {
                throw "runtime manifest entry escaped its root"
            }
            $declaredEntries[$relative] = $property.Value
        }
        foreach ($relative in $actualEntries.Keys) {
            if (-not $declaredEntries.ContainsKey($relative)) {
                throw "runtime contains an undeclared entry"
            }
            $actual = $actualEntries[$relative]
            $declared = $declaredEntries[$relative]
            if ([string]$declared.type -cne [string]$actual.type) {
                throw "runtime entry type does not match"
            }
            if ([string]$actual.type -ceq "file" -and (
                [long]$declared.length -ne [long]$actual.length -or
                [string]$declared.sha256 -notmatch "^[a-fA-F0-9]{64}$" -or
                -not ([string]$declared.sha256).Equals([string]$actual.sha256, [StringComparison]::OrdinalIgnoreCase)
            )) {
                throw "runtime file hash does not match"
            }
        }
        $manifestFiles = @($manifest.files.PSObject.Properties)
        if ([int]$manifest.verifiedFileCount -le 0 -or
            [int]$manifest.verifiedFileCount -ne $manifestFiles.Count) {
            throw "runtime verified file count does not match"
        }
        foreach ($property in $manifestFiles) {
            $relative = [string]$property.Name
            $expectedHash = [string]$property.Value
            if (-not $declaredEntries.ContainsKey($relative) -or
                [string]$declaredEntries[$relative].type -cne "file" -or
                $expectedHash -notmatch "^[a-fA-F0-9]{64}$") {
                throw "runtime verified file declaration is invalid"
            }
            $filePath = [IO.Path]::GetFullPath((Join-Path $sourceRootFull $relative))
            if (-not (Test-SourcePathInsideRoot -Path $filePath -Root $sourceRootFull) -or
                -not (Test-Path -LiteralPath $filePath -PathType Leaf) -or
                -not (Get-SourceSha256 -Path $filePath).Equals($expectedHash, [StringComparison]::OrdinalIgnoreCase)) {
                throw "runtime verified file hash does not match"
            }
        }
        return [pscustomobject]@{
            ok = $true
            head = ([string]$manifest.sourceGitHead).ToLowerInvariant()
            clean = $true
            provenance = "runtime-manifest"
            manifest = $manifestPath
            verifiedEntryCount = $actualEntries.Count
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            head = ""
            clean = $false
            provenance = "runtime-manifest"
            manifest = $manifestPath
            reason = [string]$_.Exception.Message
            verifiedEntryCount = 0
        }
    }
}

function Get-RelativeSourcePath {
    param([string]$Path)
    $root = Normalize-Path $SourceRoot
    $full = Normalize-Path $Path
    if (-not $root.EndsWith([IO.Path]::DirectorySeparatorChar)) {
        $root = "$root$([IO.Path]::DirectorySeparatorChar)"
    }
    if ($full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        return $full.Substring($root.Length)
    }
    return $full
}

function Read-TextSafe {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    try { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) } catch { return "" }
}

function ConvertTo-TailLines {
    param(
        [AllowNull()][object]$Value,
        [int]$Count = 40
    )
    $text = if ($null -eq $Value) { "" } else { [string]$Value }
    return (($text -split "\r?\n") | Select-Object -Last $Count)
}

function ConvertTo-PowerShellLiteral {
    param([string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

function Test-PowerShellFileInvocation {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )
    if (-not $FilePath -or ([IO.Path]::GetFileName($FilePath) -ine "powershell.exe")) { return $false }
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        if ([string]$Arguments[$i] -ieq "-File" -and ($i + 1) -lt $Arguments.Count) {
            return $true
        }
    }
    return $false
}

function Invoke-InProcessPowerShellFile {
    param(
        [string]$Name,
        [string[]]$Arguments,
        [int]$TimeoutSec,
        [DateTime]$CheckStartedAt
    )
    $fileIndex = -1
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        if ([string]$Arguments[$i] -ieq "-File") {
            $fileIndex = $i
            break
        }
    }
    if ($fileIndex -lt 0 -or ($fileIndex + 1) -ge $Arguments.Count) {
        throw "PowerShell -File invocation missing script path"
    }
    $scriptPath = [string]$Arguments[$fileIndex + 1]
    $scriptArgs = @()
    if (($fileIndex + 2) -lt $Arguments.Count) {
        $scriptArgs = @($Arguments[($fileIndex + 2)..($Arguments.Count - 1)])
    }
    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add("&") | Out-Null
    $parts.Add((ConvertTo-PowerShellLiteral $scriptPath)) | Out-Null
    foreach ($arg in $scriptArgs) {
        $text = [string]$arg
        if ($text -match '^-[A-Za-z][A-Za-z0-9_-]*$') {
            $parts.Add($text) | Out-Null
        } else {
            $parts.Add((ConvertTo-PowerShellLiteral $text)) | Out-Null
        }
    }
    $command = ($parts -join " ")
    $ps = [System.Management.Automation.PowerShell]::Create()
    try {
        [void]$ps.AddScript($command)
        $async = $ps.BeginInvoke()
        $timedOut = -not $async.AsyncWaitHandle.WaitOne([Math]::Max(1, $TimeoutSec) * 1000)
        if ($timedOut) {
            try { $ps.Stop() } catch {}
            $output = @()
        } else {
            $output = @($ps.EndInvoke($async))
        }
        $stdout = (($output | ForEach-Object { [string]$_ }) -join "`n")
        $stderrItems = New-Object System.Collections.Generic.List[string]
        foreach ($item in @($ps.Streams.Error)) {
            if ($item) { $stderrItems.Add([string]$item) | Out-Null }
        }
        $stderr = ($stderrItems.ToArray() -join "`n")
        $durationMs = [int]([DateTime]::UtcNow - $CheckStartedAt).TotalMilliseconds
        $exitCode = if ($timedOut) { -1 } elseif ($ps.HadErrors -or $ps.InvocationStateInfo.State -eq "Failed") { 1 } else { 0 }
        return [pscustomobject]@{
            ok = (-not $timedOut -and $exitCode -eq 0)
            name = $Name
            exitCode = $exitCode
            timedOut = $timedOut
            durationMs = $durationMs
            stdoutTail = ConvertTo-TailLines $stdout
            stderrTail = ConvertTo-TailLines $stderr
            inProcessPowerShell = $true
        }
    } catch {
        $durationMs = [int]([DateTime]::UtcNow - $CheckStartedAt).TotalMilliseconds
        return [pscustomobject]@{
            ok = $false
            name = $Name
            exitCode = 1
            timedOut = $false
            durationMs = $durationMs
            stdoutTail = @()
            stderrTail = ConvertTo-TailLines $_.Exception.Message
            inProcessPowerShell = $true
        }
    } finally {
        try { $ps.Dispose() } catch {}
    }
}

function Invoke-SourceProcess {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments,
        [int]$TimeoutSec = $SubcheckTimeoutSec
    )

    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    $checkStartedAt = [DateTime]::UtcNow
    try {
        if (Test-PowerShellFileInvocation -FilePath $FilePath -Arguments $Arguments) {
            return Invoke-InProcessPowerShellFile -Name $Name -Arguments $Arguments -TimeoutSec $TimeoutSec -CheckStartedAt $checkStartedAt
        }
        $process = Start-Process -FilePath $FilePath `
            -ArgumentList $Arguments `
            -WorkingDirectory $SourceRoot `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        [void]$process.Handle
        $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSec))
        while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 200
            try { $process.Refresh() } catch {}
        }
        $timedOut = -not $process.HasExited
        if ($timedOut) {
            try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
            Start-Sleep -Milliseconds 200
        } else {
            # Process.WaitForExit drains redirected file handles after HasExited flips.
            $process.WaitForExit()
        }
        $stdout = Read-TextSafe $stdoutPath
        $stderr = Read-TextSafe $stderrPath
        $exitCode = if ($timedOut) { -1 } else { [int]$process.ExitCode }
        $durationMs = [int]([DateTime]::UtcNow - $checkStartedAt).TotalMilliseconds
        return [pscustomobject]@{
            ok = (-not $timedOut -and $exitCode -eq 0)
            name = $Name
            exitCode = $exitCode
            timedOut = $timedOut
            durationMs = $durationMs
            stdoutTail = ConvertTo-TailLines $stdout
            stderrTail = ConvertTo-TailLines $stderr
        }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Test-ProcessLauncherSelfTest {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-launcher-selftest-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        $successScript = Join-Path $tempRoot "success.ps1"
        $failureScript = Join-Path $tempRoot "failure.ps1"
        Set-Content -LiteralPath $successScript -Encoding UTF8 -Value @'
param([string]$Name, [switch]$Flag)
[pscustomobject]@{ name = $Name; flag = [bool]$Flag } | ConvertTo-Json -Compress
exit 0
'@
        Set-Content -LiteralPath $failureScript -Encoding UTF8 -Value @'
"intentional-failure-output"
exit 7
'@
        $success = Invoke-SourceProcess `
            -Name "process launcher self-test success" `
            -FilePath $powershell `
            -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $successScript, "-Name", "anticodex", "-Flag") `
            -TimeoutSec 10
        $failure = Invoke-SourceProcess `
            -Name "process launcher self-test failure" `
            -FilePath $powershell `
            -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $failureScript) `
            -TimeoutSec 10
        $nodeCheck = Invoke-SourceProcess `
            -Name "process launcher self-test node" `
            -FilePath $node `
            -Arguments @("-e", "console.log('node-external-ok')") `
            -TimeoutSec 10

        $successText = (($success.stdoutTail + $success.stderrTail) -join "`n")
        $failureText = (($failure.stdoutTail + $failure.stderrTail) -join "`n")
        $nodeText = (($nodeCheck.stdoutTail + $nodeCheck.stderrTail) -join "`n")
        $checks = [ordered]@{
            powershellSuccessOk = ($success.ok -eq $true)
            powershellSuccessInProcess = ($success.inProcessPowerShell -eq $true)
            powershellSuccessArgsBound = ($successText -match '"name":"anticodex"' -and $successText -match '"flag":true')
            powershellFailureNonzero = ($failure.ok -eq $false -and [int]$failure.exitCode -ne 0)
            powershellFailureStayedInProcess = ($failure.inProcessPowerShell -eq $true)
            powershellFailureOutputCaptured = ($failureText -match "intentional-failure-output")
            nodeExternalOk = ($nodeCheck.ok -eq $true -and $nodeText -match "node-external-ok")
            nodeNotInProcessPowerShell = ($nodeCheck.PSObject.Properties.Name -notcontains "inProcessPowerShell")
        }
        $failed = @($checks.GetEnumerator() | Where-Object { $_.Value -ne $true } | ForEach-Object { $_.Key })
        $result = [ordered]@{
            ok = ($failed.Count -eq 0)
            reportName = "source-preflight-process-launcher-self-test"
            noTraffic = $true
            usedRealTraffic = $false
            behaviorCovered = ($failed.Count -eq 0)
            coverageKind = "source-preflight-process-launcher-self-test"
            checks = $checks
            failed = $failed
            success = $success
            failure = $failure
            node = $nodeCheck
        }
        $result | ConvertTo-Json -Depth 16 -Compress
        if ($failed.Count -gt 0) { exit 1 }
        exit 0
    } finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($SelfTestProcessLauncher) {
    Test-ProcessLauncherSelfTest
}

function Get-SourceJsonReportText {
    param(
        [Parameter(Mandatory = $true)][string]$ReportRoot,
        [Parameter(Mandatory = $true)][string]$LatestFileName,
        [string[]]$FallbackTail = @()
    )
    $latestPath = Join-Path $ReportRoot $LatestFileName
    if (Test-Path -LiteralPath $latestPath -PathType Leaf) {
        return Get-Content -LiteralPath $latestPath -Raw
    }
    return ($FallbackTail -join "`n")
}

function Test-JavaScriptSyntax {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $requiredScripts = @("scripts\test-anticodex-human-edge-matrix.mjs")
    foreach ($requiredScript in $requiredScripts) {
        if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot $requiredScript) -PathType Leaf)) {
            Add-Failure "Required JavaScript verifier missing: $requiredScript"
        }
    }
    $scanRoots = @("translator", "scripts")
    $files = @($scanRoots | ForEach-Object {
        $scanRoot = Join-Path $SourceRoot $_
        if (Test-Path -LiteralPath $scanRoot -PathType Container) {
            Get-ChildItem -LiteralPath $scanRoot -Recurse -File | Where-Object {
            $_.Extension -in @(".mjs", ".js") -and $_.FullName -notmatch '\\node_modules\\'
        } | ForEach-Object {
                Get-RelativeSourcePath $_.FullName
            }
        }
    } | Sort-Object -Unique)
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($relative in $files) {
        $path = Join-Path $SourceRoot $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            $items.Add([pscustomobject]@{ file = $relative; ok = $false; missing = $true }) | Out-Null
            Add-Failure "JavaScript syntax file missing: $relative"
            continue
        }
        $result = Invoke-SourceProcess -Name "node --check $relative" -FilePath $node -Arguments @("--check", $path) -TimeoutSec 30
        $items.Add([pscustomobject]@{ file = $relative; ok = $result.ok; exitCode = $result.exitCode; timedOut = $result.timedOut }) | Out-Null
        if (-not $result.ok) { Add-Failure "JavaScript syntax check failed: $relative" }
    }
    $failedItems = @($items | Where-Object { -not [bool]$_.ok })
    $ok = ($failedItems.Count -eq 0)
    $itemArray = @($items.ToArray())
    return [pscustomobject]@{
        ok = $ok
        files = $itemArray
    }
}

function Test-PowerShellSyntax {
    $files = @(Get-ChildItem -LiteralPath (Join-Path $SourceRoot "scripts") -Filter "*.ps1" -File | Sort-Object FullName)
    $bad = New-Object System.Collections.Generic.List[object]
    foreach ($file in $files) {
        $tokens = $null
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
        if ($errors -and $errors.Count -gt 0) {
            $bad.Add([pscustomobject]@{
                file = $file.Name
                errors = @($errors | ForEach-Object { $_.Message })
            }) | Out-Null
        }
    }
    if ($bad.Count -gt 0) { Add-Failure "PowerShell parser found $($bad.Count) script(s) with syntax errors" }
    $badArray = @($bad.ToArray())
    return [pscustomobject]@{
        ok = ($bad.Count -eq 0)
        parsed = $files.Count
        failures = $badArray
    }
}

function Test-UiStateSelfTest {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\test-anticodex-ui-state.mjs"
    $result = Invoke-SourceProcess -Name "UI state self-test" -FilePath $node -Arguments @($script, "--self-test") -TimeoutSec 30
    if (-not $result.ok) { Add-Failure "UI state self-test failed" }
    return $result
}

function Test-ManagerBridgeSelfTest {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\anticodex-manager-bridge.mjs"
    $result = Invoke-SourceProcess -Name "Manager bridge self-test" -FilePath $node -Arguments @($script, "--self-test") -TimeoutSec 30
    if (-not $result.ok) { Add-Failure "Manager bridge self-test failed" }
    return $result
}

function Test-LogDbGuardSelfTest {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\protect-anticodex-log-db.mjs"
    $result = Invoke-SourceProcess -Name "log database guard self-test" -FilePath $node -Arguments @($script, "--self-test") -TimeoutSec 30
    if (-not $result.ok) { Add-Failure "Log database guard self-test failed" }
    return $result
}

function Test-UpstreamProfileStorage {
    $powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\test-anticodex-upstream-profile.ps1"
    $result = Invoke-SourceProcess `
        -Name "upstream profile storage" `
        -FilePath $powershell `
        -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script) `
        -TimeoutSec 30
    if (-not $result.ok) { Add-Failure "Upstream profile storage test failed" }
    return $result
}

function Test-LocalConnectorVerifier {
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\test-anticodex-local-connectors.mjs"
    $timeoutMs = [Math]::Max(10000, $SubcheckTimeoutSec * 1000)
    $result = Invoke-SourceProcess `
        -Name "local connector/app-tool verifier" `
        -FilePath $node `
        -Arguments @($script, "--source-root", $SourceRoot, "--runtime-root", $SourceRoot, "--report-root", $ReportRoot, "--timeout-ms", "$timeoutMs") `
        -TimeoutSec $SubcheckTimeoutSec
    if (-not $result.ok) { Add-Failure "Local connector/app-tool verifier failed" }
    return $result
}

function Test-TranslatorRegression {
    if ($SkipFullRegression) {
        return [pscustomobject]@{ ok = $true; skipped = $true; reason = "SkipFullRegression" }
    }
    $node = (Get-Command "node" -ErrorAction Stop).Source
    $testFiles = @(Get-ChildItem -LiteralPath (Join-Path $SourceRoot "translator\tests") -Filter "*.test.mjs" -File | Sort-Object FullName | ForEach-Object { $_.FullName })
    if ($testFiles.Count -eq 0) {
        Add-Failure "No translator test files found"
        return [pscustomobject]@{ ok = $false; testFiles = 0 }
    }
    $result = Invoke-SourceProcess -Name "translator source regression" -FilePath $node -Arguments (@("--test", "--test-concurrency=2") + $testFiles) -TimeoutSec $SubcheckTimeoutSec
    if (-not $result.ok) { Add-Failure "Translator source regression failed" }
    $summary = ($result.stdoutTail + $result.stderrTail) -join "`n"
    return [pscustomobject]@{
        ok = $result.ok
        exitCode = $result.exitCode
        timedOut = $result.timedOut
        durationMs = $result.durationMs
        testFiles = $testFiles.Count
        tail = $result.stdoutTail
        tests = ([regex]::Match($summary, 'tests\s+(\d+)').Groups[1].Value)
        pass = ([regex]::Match($summary, 'pass\s+(\d+)').Groups[1].Value)
        fail = ([regex]::Match($summary, 'fail\s+(\d+)').Groups[1].Value)
        skipped = ([regex]::Match($summary, 'skipped\s+(\d+)').Groups[1].Value)
    }
}

function Test-ManagerRealButtonsReportContract {
    $script = Join-Path $SourceRoot "scripts\test-anticodex-manager-real-buttons.ps1"
    $text = Read-TextSafe $script
    $assertions = New-Object System.Collections.Generic.List[object]

    function Add-ManagerRealButtonsAssertion {
        param(
            [string]$Name,
            [bool]$Ok
        )
        $assertions.Add([pscustomobject]@{ name = $Name; ok = $Ok }) | Out-Null
        if (-not $Ok) { Add-Failure "manager real-buttons report contract failed: $Name" }
    }

    Add-ManagerRealButtonsAssertion -Name "script-readable" -Ok ([bool]$text)
    Add-ManagerRealButtonsAssertion -Name "release-required-actions-explicit" -Ok (
        $text -match '\$releaseRequiredActions\s*=\s*@\("updateCheck",\s*"repairShortcuts",\s*"pluginCapabilities",\s*"mcpSkills"\)'
    )
    Add-ManagerRealButtonsAssertion -Name "partial-report-name-present" -Ok (
        $text -match 'manager-real-buttons-partial'
    )
    Add-ManagerRealButtonsAssertion -Name "canonical-release-report-flag-present" -Ok (
        $text -match 'canonicalReleaseReport'
    )
    Add-ManagerRealButtonsAssertion -Name "canonical-report-only-when-required-actions-present" -Ok (
        $text -match '\$reportName\s*=\s*if\s*\(\$canonicalReleaseReport\)\s*\{\s*"manager-real-buttons"\s*\}\s*else\s*\{\s*"manager-real-buttons-partial"\s*\}'
    )

    $assertionItems = @($assertions.ToArray())
    $failedCount = @($assertionItems | Where-Object { $_.ok -ne $true }).Count
    return [pscustomobject]@{
        ok = ($failedCount -eq 0)
        assertions = $assertionItems
    }
}

function Test-ManagerMojibakeContracts {
    $assertions = New-Object System.Collections.Generic.List[object]

    function Add-ManagerMojibakeAssertion {
        param(
            [string]$Name,
            [bool]$Ok
        )
        $assertions.Add([pscustomobject]@{ name = $Name; ok = $Ok }) | Out-Null
        if (-not $Ok) { Add-Failure "manager mojibake contract failed: $Name" }
    }

    $server = Read-TextSafe (Join-Path $SourceRoot "scripts\anticodex-manager-service.mjs")
    $inject = Read-TextSafe (Join-Path $SourceRoot "scripts\anticodex-manager-inject.js")
    $managerHtmlStart = $server.IndexOf('const managerHtml = `<!doctype html>', [StringComparison]::Ordinal)
    $managerHtmlEnd = if ($managerHtmlStart -ge 0) { $server.IndexOf('export function createAntiCodexManagerService', $managerHtmlStart, [StringComparison]::Ordinal) } else { -1 }
    $managerServerSource = if ($managerHtmlStart -ge 0 -and $managerHtmlEnd -gt $managerHtmlStart) { $server.Substring($managerHtmlStart, $managerHtmlEnd - $managerHtmlStart) } else { "" }
    $managerVisibleSource = @($managerServerSource, $inject) -join "`n"
    $latestReportsLabel = [string]::Concat([char[]]@(0x67e5, 0x770b, 0x6700, 0x65b0, 0x62a5, 0x544a))
    $managerTitle = "Anti-Codex " + [string]::Concat([char[]]@(0x7ba1, 0x7406))
    $replacementChar = [string][char]0xfffd
    $garbledKun = [string][char]0x951f

    Add-ManagerMojibakeAssertion -Name "manager-visible-labels-readable" -Ok (
        $server.Contains($latestReportsLabel) -and
        $managerServerSource.Contains($managerTitle) -and
        $inject.Contains("\u67e5\u770b\u6700\u65b0\u62a5\u544a") -and
        $inject.Contains('const MANAGER_LABEL = "Anti-Codex \u7ba1\u7406"') -and
        $inject.Contains('const CLOSE_TEXT = "\u5173\u95ed"') -and
        -not $server.Contains('workerTransportStatus') -and
        -not $inject.Contains('workerTransportStatus') -and
        -not $server.Contains('secondAccountLoginStatus')
    )
    Add-ManagerMojibakeAssertion -Name "manager-visible-labels-not-mojibake" -Ok (
        -not $managerVisibleSource.Contains($replacementChar) -and
        -not $managerVisibleSource.Contains($garbledKun)
    )

    $assertionItems = @($assertions.ToArray())
    $failedCount = @($assertionItems | Where-Object { $_.ok -ne $true }).Count
    return [pscustomobject]@{
        ok = ($failedCount -eq 0)
        assertions = $assertionItems
    }
}

function Test-PublicDocumentationContracts {
    $assertions = New-Object System.Collections.Generic.List[object]

    function Add-DocAssertion {
        param(
            [string]$File,
            [string]$Name,
            [bool]$Ok
        )
        $assertions.Add([pscustomobject]@{ file = $File; name = $Name; ok = $Ok }) | Out-Null
        if (-not $Ok) { Add-Failure "public documentation contract failed: $File $Name" }
    }

    function Read-PublicDoc {
        param([string]$Relative)
        $path = Join-Path $SourceRoot $Relative
        $text = Read-TextSafe $path
        Add-DocAssertion -File $Relative -Name "exists-and-readable" -Ok ([bool]$text)
        return $text
    }

    $readme = Read-PublicDoc "README.md"
    $readmeEn = Read-PublicDoc "README_EN.md"
    $windowsDoc = Read-PublicDoc "docs\WINDOWS.md"
    $providerStack = Read-PublicDoc "docs\ADAPTIVE_ONE_API_STACK.md"
    $compatibility = Read-PublicDoc "docs\chat-to-responses-compat.md"
    $legacyMarketing = Read-PublicDoc "docs\marketing\legacy\deepcodex-video-script.md"
    $marketingDocs = @(
        (Read-PublicDoc "docs\marketing\launch-post.md"),
        (Read-PublicDoc "docs\marketing\video-script.md"),
        (Read-PublicDoc "docs\marketing\wechat-article.md")
    ) -join "`n`n"

    Add-DocAssertion -File "README.md" -Name "anti-codex-brand" -Ok ($readme -match '^# Anti-Codex')
    Add-DocAssertion -File "README.md" -Name "isolated-official-codex" -Ok ($readme -match 'official Codex' -and $readme -match 'isolated')
    Add-DocAssertion -File "README.md" -Name "codexplusplus-general-provider-layer" -Ok ($readme -match 'CodexPlusPlus')
    Add-DocAssertion -File "README.md" -Name "third-party-bypasses-antigravity" -Ok ($readme -match 'third-party' -and $readme -match 'bypass' -and $readme -match 'Antigravity')
    Add-DocAssertion -File "README.md" -Name "thin-antigravity-chat-adapter" -Ok ($readme -match 'Chat' -and $readme -match 'Cascade' -and $readme -match 'thin')
    Add-DocAssertion -File "README.md" -Name "codex-owns-agent-loop" -Ok ($readme -match 'Codex' -and $readme -match 'tools' -and $readme -match 'compaction')
    Add-DocAssertion -File "README.md" -Name "connector-authorization-boundary" -Ok ($readme -match 'connector-backed app tools')
    Add-DocAssertion -File "README.md" -Name "no-old-public-launch-claims" -Ok ($readme -notmatch 'DeepCodex app|DeepCodex launched successfully|DeepCodex for Windows is|DeepCodex\.lnk')
    Add-DocAssertion -File "README_EN.md" -Name "anti-codex-brand" -Ok ($readmeEn -match '^# Anti-Codex')
    Add-DocAssertion -File "README_EN.md" -Name "isolated-official-codex" -Ok ($readmeEn -match 'official Codex' -and $readmeEn -match 'isolated')
    Add-DocAssertion -File "README_EN.md" -Name "codexplusplus-general-provider-layer" -Ok ($readmeEn -match 'CodexPlusPlus')
    Add-DocAssertion -File "README_EN.md" -Name "third-party-bypasses-antigravity" -Ok ($readmeEn -match 'third-party' -and $readmeEn -match 'bypass' -and $readmeEn -match 'Antigravity')
    Add-DocAssertion -File "README_EN.md" -Name "thin-antigravity-chat-adapter" -Ok ($readmeEn -match 'Chat' -and $readmeEn -match 'Cascade' -and $readmeEn -match 'thin')
    Add-DocAssertion -File "README_EN.md" -Name "codex-owns-agent-loop" -Ok ($readmeEn -match 'Codex' -and $readmeEn -match 'tools' -and $readmeEn -match 'compaction')
    Add-DocAssertion -File "README_EN.md" -Name "connector-authorization-boundary" -Ok ($readmeEn -match 'Connector-backed app tools')
    Add-DocAssertion -File "README_EN.md" -Name "no-old-public-launch-claims" -Ok ($readmeEn -notmatch 'DeepCodex app|DeepCodex launched successfully|DeepCodex for Windows is|DeepCodex\.lnk')

    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "provider-stack-title" -Ok ($providerStack -match '^# Anti-Codex Adaptive Provider Stack')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "three-layers" -Ok ($providerStack -match 'Layer 1' -and $providerStack -match 'Layer 2' -and $providerStack -match 'Layer 3')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "codexplusplus-third-party-bypass" -Ok ($providerStack -match 'CodexPlusPlus' -and $providerStack -match 'third-party' -and $providerStack -match 'bypass.*Antigravity')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "thin-chat-cascade-adapter" -Ok ($providerStack -match 'Chat Completions' -and $providerStack -match 'Cascade' -and $providerStack -match 'thinnest possible adapter')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "codex-owns-agent-loop" -Ok ($providerStack -match 'Codex owns' -and $providerStack -match 'compaction')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "no-homegrown-responses-translator" -Ok ($providerStack -match 'does not implement a self-written Responses translator')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "no-old-one-api-default" -Ok ($providerStack -notmatch 'local translator gateway|translator-owned internal tools|/responses/compact.*separate request mode|setup-one-api-minimal|start-adaptive-oneapi')

    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "codexplusplus-owns-general-conversion" -Ok ($compatibility -match 'CodexPlusPlus')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "third-party-bypasses-antigravity" -Ok ($compatibility -match 'third-party' -and $compatibility -match 'bypass' -and $compatibility -match 'Antigravity')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "antigravity-chat-to-cascade-only" -Ok ($compatibility -match 'Chat Completions' -and $compatibility -match 'Cascade')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "no-homegrown-general-translator" -Ok ($compatibility -notmatch 'Scope: Anti-Codex translates Codex Desktop|Provider completions should be wrapped into a full Responses-shaped object|emit the normal Responses event progression')

    Add-DocAssertion -File "docs\marketing\*.md" -Name "anti-codex-brand" -Ok ($marketingDocs -match 'Anti-Codex')
    Add-DocAssertion -File "docs\marketing\*.md" -Name "provider-language" -Ok ($marketingDocs -match 'Antigravity' -and $marketingDocs -match 'third-party|provider|OpenAI-compatible|Anthropic API')
    Add-DocAssertion -File "docs\marketing\*.md" -Name "connector-boundary" -Ok ($marketingDocs -match 'connector|app tool' -and $marketingDocs -match 'does not fake authorization')
    Add-DocAssertion -File "docs\marketing\*.md" -Name "no-current-legacy-marketing" -Ok ($marketingDocs -notmatch 'DeepCodex|deepcodex|DeepSeek-only|DeepSeek route|DeepSeek API key')
    $currentPublicDocs = @($readme, $readmeEn, $providerStack, $compatibility, $marketingDocs) -join "`n"
    $currentArchitectureDocs = @($readme, $readmeEn, $windowsDoc, $providerStack, $compatibility) -join "`n"
    Add-DocAssertion -File "current public docs" -Name "no-cli-default-product-route" -Ok ($currentArchitectureDocs -notmatch 'CLI is the target text transport|Model text transport defaults to Antigravity CLI')
    Add-DocAssertion -File "current public docs" -Name "no-mixed-translator-default" -Ok ($currentArchitectureDocs -notmatch 'local translator gateway :8282|Anti-Codex translates Codex Desktop''s Responses-shaped traffic')
    Add-DocAssertion -File "current public docs" -Name "no-fourth-task-control-layer" -Ok ($currentArchitectureDocs -notmatch 'translator-owned internal tools|Cascade owns tool execution|Antigravity controls the task')
    Add-DocAssertion -File "docs\marketing\legacy\deepcodex-video-script.md" -Name "legacy-marker" -Ok ($legacyMarketing -match 'archived historical DeepCodex / DeepSeek launch material' -and $legacyMarketing -match 'not a current Anti-Codex launch asset')

    $legacyDeepseekNotes = Read-PublicDoc "docs\DEEPSEEK_RUNTIME_FAILURE_NOTES.md"
    Add-DocAssertion -File "docs\DEEPSEEK_RUNTIME_FAILURE_NOTES.md" -Name "no-stale-antigravity-desktop-default-provider" -Ok ($legacyDeepseekNotes -notmatch 'defaults to the local Antigravity Desktop provider')
    Add-DocAssertion -File "docs\DEEPSEEK_RUNTIME_FAILURE_NOTES.md" -Name "legacy-current-boundary-wording" -Ok ($legacyDeepseekNotes -match 'legacy route notes' -and $legacyDeepseekNotes -match 'not the current Anti-Codex default provider')

    $failed = @($assertions.ToArray() | Where-Object { -not [bool]$_.ok })
    return [pscustomobject]@{
        ok = ($failed.Count -eq 0)
        assertions = @($assertions.ToArray())
        failed = $failed
    }
}

function Test-GitDiffCheck {
    $gitCommand = Get-Command "git" -ErrorAction SilentlyContinue
    if (-not $gitCommand) {
        Add-Warning "git not found; skipped diff whitespace check"
        return [pscustomobject]@{ ok = $true; skipped = $true; reason = "git not found" }
    }
    $workTreeResult = Invoke-SourceProcess -Name "git rev-parse --is-inside-work-tree" -FilePath $gitCommand.Source -Arguments @("-C", $sourceRoot, "rev-parse", "--is-inside-work-tree") -TimeoutSec 10
    $insideWorkTree = (($workTreeResult.stdoutTail + $workTreeResult.stderrTail) | Where-Object { $_ } | Select-Object -First 1)
    if (-not $workTreeResult.ok -or [string]$insideWorkTree -ne "true") {
        Add-Warning "not a git worktree; skipped diff whitespace check"
        return [pscustomobject]@{ ok = $true; skipped = $true; reason = "not a git worktree" }
    }
    $result = Invoke-SourceProcess -Name "git diff --check" -FilePath $gitCommand.Source -Arguments @("-C", $sourceRoot, "diff", "--check", "--", ".", ":(exclude)third_party/codexplusplus/patches/*.patch") -TimeoutSec 30
    $lines = @($result.stdoutTail + $result.stderrTail | Where-Object { $_ })
    $nonWarningLines = @($lines | Where-Object {
        $_ -notmatch '^warning: in the working copy of .*, LF will be replaced by CRLF the next time Git touches it$'
    })
    if (-not $result.ok -and $nonWarningLines.Count -eq 0) {
        foreach ($line in $lines) { Add-Warning $line }
        return [pscustomobject]@{
            ok = $true
            exitCode = $result.exitCode
            warningsOnly = $true
            warningCount = $lines.Count
            warnings = $lines
        }
    }
    if (-not $result.ok) {
        Add-Failure "git diff --check reported whitespace errors"
    }
    return [pscustomobject]@{
        ok = $result.ok
        exitCode = $result.exitCode
        warningsOnly = $false
        output = $lines
    }
}

function Test-SourceGitRevision {
    $gitCommand = Get-Command "git" -ErrorAction SilentlyContinue
    $sourceIsGitRoot = $false
    if ($gitCommand) {
        $gitRootResult = Invoke-SourceProcess -Name "git rev-parse --show-toplevel" -FilePath $gitCommand.Source -Arguments @("-C", $SourceRoot, "rev-parse", "--show-toplevel") -TimeoutSec 10
        $gitRoot = @($gitRootResult.stdoutTail | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -First 1)
        $gitRoot = if ($gitRoot.Count -gt 0) { [string]$gitRoot[0] } else { "" }
        try { $gitRoot = [IO.Path]::GetFullPath($gitRoot).TrimEnd("\") } catch { $gitRoot = "" }
        $sourceIsGitRoot = $gitRootResult.ok -and
            $gitRoot.Equals(([IO.Path]::GetFullPath($SourceRoot)).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)
    }
    if (-not $sourceIsGitRoot) {
        $runtimeRevision = Get-SourceRuntimeManifestRevision
        if (-not $runtimeRevision.ok) {
            Add-Failure "source revision could not be verified: $([string]$runtimeRevision.reason)"
        }
        return $runtimeRevision
    }
    $result = Invoke-SourceProcess -Name "git rev-parse HEAD" -FilePath $gitCommand.Source -Arguments @("-C", $SourceRoot, "rev-parse", "HEAD") -TimeoutSec 10
    $head = @($result.stdoutTail | Where-Object { [string]$_ -match '^[0-9a-fA-F]{40}$' } | Select-Object -First 1)
    $head = if ($head.Count -gt 0) { [string]$head[0] } else { "" }
    if (-not $result.ok -or $head -notmatch '^[0-9a-fA-F]{40}$') {
        Add-Failure "source git revision could not be resolved"
        return [pscustomobject]@{ ok = $false; head = $head; clean = $false; exitCode = $result.exitCode }
    }
    $statusResult = Invoke-SourceProcess -Name "git status --porcelain" -FilePath $gitCommand.Source -Arguments @("-C", $SourceRoot, "status", "--porcelain=v1", "--untracked-files=normal") -TimeoutSec 10
    $clean = $statusResult.ok -and @($statusResult.stdoutTail | Where-Object { [string]$_ -ne "" }).Count -eq 0
    if (-not $statusResult.ok) {
        Add-Failure "source git status could not be resolved"
    } elseif (-not $clean) {
        Add-Failure "source git worktree is dirty"
    }
    return [pscustomobject]@{
        ok = $clean
        head = $head.ToLowerInvariant()
        clean = $clean
        exitCode = $statusResult.exitCode
        provenance = "git"
    }
}

function New-ReportPaths {
    param([string]$Name)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    return [pscustomobject]@{
        latest = Join-Path $ReportRoot "latest-$Name.json"
        history = Join-Path $ReportRoot "$stamp-$Name.json"
    }
}

function Save-JsonReport {
    param([string]$Name, $Payload)
    $paths = New-ReportPaths $Name
    $json = $Payload | ConvertTo-Json -Depth 24
    $encoding = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $paths.latest -HistoryPath $paths.history -Json $json -Encoding $encoding
    return $paths
}

try {
    $checks["sourceGitRevision"] = Test-SourceGitRevision
    $checks["javascriptSyntax"] = Test-JavaScriptSyntax
    $checks["powershellSyntax"] = Test-PowerShellSyntax
    $checks["uiStateSelfTest"] = Test-UiStateSelfTest
    $checks["managerBridgeSelfTest"] = Test-ManagerBridgeSelfTest
    $checks["logDbGuardSelfTest"] = Test-LogDbGuardSelfTest
    $checks["upstreamProfileStorage"] = Test-UpstreamProfileStorage
    $checks["localConnectorVerifier"] = Test-LocalConnectorVerifier
    $checks["managerRealButtonsReportContract"] = Test-ManagerRealButtonsReportContract
    $checks["managerMojibakeContracts"] = Test-ManagerMojibakeContracts
    $checks["publicDocumentation"] = Test-PublicDocumentationContracts
    $checks["translatorRegression"] = Test-TranslatorRegression
    $checks["diffWhitespace"] = Test-GitDiffCheck
} catch {
    $line = $_.InvocationInfo.ScriptLineNumber
    $command = $_.InvocationInfo.Line
    Add-Failure "source preflight failed at line ${line}: $($_.Exception.Message) $command"
}

$elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
$managerRealButtonsReportContractOk = $false
if ($checks["managerRealButtonsReportContract"]) {
    $managerRealButtonsReportContractOk = [bool]$checks["managerRealButtonsReportContract"].ok
}
$report = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "source-preflight"
    noTraffic = $true
    usedRealTraffic = $false
    behaviorCovered = ($failures.Count -eq 0)
    coverageKind = "source-no-traffic"
    managerRealButtonsReportContractOk = $managerRealButtonsReportContractOk
    sourceRoot = Normalize-Path $SourceRoot
    sourceGitHead = [string]$checks["sourceGitRevision"].head
    sourceGitClean = [bool]$checks["sourceGitRevision"].clean
    sourceRevisionProvenance = [string]$checks["sourceGitRevision"].provenance
    startedAt = $startedAt.ToString("o")
    elapsedMs = $elapsedMs
    skipFullRegression = [bool]$SkipFullRegression
    checks = $checks
    failures = @($failures)
    warnings = @($warnings)
}
$paths = Save-JsonReport "source-preflight" $report
$report.report = [ordered]@{
    latest = $paths.latest
    history = $paths.history
}

$jsonOut = $report | ConvertTo-Json -Depth 24
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Write-Output $jsonOut
if ($failures.Count -gt 0) { exit 1 }
