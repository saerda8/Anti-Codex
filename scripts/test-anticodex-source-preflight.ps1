[CmdletBinding()]
param(
    [string]$SourceRoot = "",
    [string]$ReportRoot = "",
    [int]$SubcheckTimeoutSec = 120,
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

function Normalize-Path {
    param([string]$Path)
    if (-not $Path) { return "" }
    return [IO.Path]::GetFullPath($Path)
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

function Test-AntigravityCliIsolationProfile {
    $powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\test-anticodex-antigravity-cli-isolation.ps1"
    $result = Invoke-SourceProcess `
        -Name "Antigravity CLI isolation profile" `
        -FilePath $powershell `
        -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script, "-ReportRoot", $ReportRoot) `
        -TimeoutSec 30
    $isolationJson = Get-SourceJsonReportText `
        -ReportRoot $ReportRoot `
        -LatestFileName "latest-antigravity-cli-isolation.json" `
        -FallbackTail $result.stdoutTail
    $isolationOk = $false
    $isolationContract = [ordered]@{
        ok = $false
        usedRealTraffic = $false
        loginVerified = $false
        separateAccountVerified = $false
        accountLaneRole = ""
        mcpAccountLaneManagedByAntiCodex = $true
        mcpAccountLaneOwner = ""
        accountIsolationBoundary = ""
        accountIsolationCaveat = ""
    }
    if ($result.ok -and $isolationJson) {
        try {
            $parsed = $isolationJson | ConvertFrom-Json
            $isolationContract.ok = [bool]$parsed.ok
            $isolationContract.usedRealTraffic = [bool]$parsed.usedRealTraffic
            $isolationContract.loginVerified = [bool]$parsed.loginVerified
            $isolationContract.separateAccountVerified = [bool]$parsed.separateAccountVerified
            $isolationContract.accountLaneRole = [string]$parsed.accountLaneRole
            $isolationContract.mcpAccountLaneManagedByAntiCodex = [bool]$parsed.mcpAccountLaneManagedByAntiCodex
            $isolationContract.mcpAccountLaneOwner = [string]$parsed.mcpAccountLaneOwner
            $isolationContract.accountIsolationBoundary = [string]$parsed.accountIsolationBoundary
            $isolationContract.accountIsolationCaveat = [string]$parsed.accountIsolationCaveat
            $isolationOk = $parsed.ok -eq $true `
                -and $parsed.usedRealTraffic -eq $false `
                -and $parsed.loginVerified -eq $false `
                -and $parsed.separateAccountVerified -eq $false `
                -and $parsed.accountLaneRole -eq "anticodex-model-text" `
                -and $parsed.mcpAccountLaneManagedByAntiCodex -eq $false `
                -and $parsed.mcpAccountLaneOwner -eq "external-antigravity-account-not-managed-here" `
                -and $parsed.accountIsolationBoundary `
                -and $parsed.accountIsolationCaveat
        } catch {
            Add-Failure "Antigravity CLI isolation profile JSON parse failed"
        }
    }
    if (-not $isolationOk -and $result.ok) {
        Add-Failure "Antigravity CLI isolation profile contract not satisfied"
    }
    if (-not $result.ok) { Add-Failure "Antigravity CLI isolation profile test failed" }
    return [pscustomobject]@{
        ok = $isolationOk
        name = "Antigravity CLI isolation profile"
        exitCode = $result.exitCode
        timedOut = $result.timedOut
        durationMs = $result.durationMs
        usedRealTraffic = $false
        loginVerified = $false
        separateAccountVerified = $false
        accountLaneRole = $isolationContract.accountLaneRole
        mcpAccountLaneManagedByAntiCodex = $isolationContract.mcpAccountLaneManagedByAntiCodex
        mcpAccountLaneOwner = $isolationContract.mcpAccountLaneOwner
        accountIsolationBoundary = $isolationContract.accountIsolationBoundary
        accountIsolationCaveat = $isolationContract.accountIsolationCaveat
        contract = $isolationContract
    }
}

function Test-AntigravityCliDualAccountLanes {
    $powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\test-anticodex-antigravity-cli-dual-account-lanes.ps1"
    $tempStateRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-dual-lanes-state-" + [Guid]::NewGuid().ToString("N"))
    $tempReportRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-dual-lanes-report-" + [Guid]::NewGuid().ToString("N"))
    $antiCodexRoot = Join-Path $tempStateRoot "anticodex-model-text"
    $mcpRoot = Join-Path $tempStateRoot "external-mcp-antigravity-account"
    try {
        $result = Invoke-SourceProcess `
            -Name "Antigravity CLI dual account lanes (no-traffic)" `
            -FilePath $powershell `
            -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script,
                "-StateRoot", $tempStateRoot,
                "-ReportRoot", $tempReportRoot,
                "-AntiCodexProfileRoot", $antiCodexRoot,
                "-McpProfileRoot", $mcpRoot) `
            -TimeoutSec 30
        $dualJson = Get-SourceJsonReportText `
            -ReportRoot $tempReportRoot `
            -LatestFileName "latest-antigravity-cli-dual-account-lanes.json" `
            -FallbackTail $result.stdoutTail
        $dualOk = $false
        $contract = [ordered]@{
            ok = $false
            usedRealTraffic = $false
            loginVerified = $false
            separateAccountVerified = $false
            accountLaneRole = ""
            coverageKind = "missing"
            antiCodexLaneRole = ""
            mcpLaneRole = ""
            mcpLaneManagedByAntiCodex = $true
            profileRootsDifferent = $false
            profileRootsNested = $true
            appDataDifferent = $false
            localAppDataDifferent = $false
            geminiDirDifferent = $false
            neitherUsesDefaultAntigravityProfile = $false
            accountIsolationBoundary = ""
            accountIsolationCaveat = ""
        }
        if ($result.ok -and $dualJson) {
            try {
                $parsed = $dualJson | ConvertFrom-Json
                $comparison = $parsed.laneComparison
                $contract.ok = [bool]$parsed.ok
                $contract.usedRealTraffic = [bool]$parsed.usedRealTraffic
                $contract.loginVerified = [bool]$parsed.loginVerified
                $contract.separateAccountVerified = [bool]$parsed.separateAccountVerified
                $contract.accountLaneRole = [string]$parsed.accountLaneRole
                $contract.coverageKind = [string]$parsed.coverageKind
                $contract.antiCodexLaneRole = [string]$parsed.antiCodexLane.role
                $contract.mcpLaneRole = [string]$parsed.mcpLane.role
                $contract.mcpLaneManagedByAntiCodex = [bool]$parsed.mcpLane.managedByAntiCodex
                $contract.profileRootsDifferent = [bool]$comparison.profileRootsDifferent
                $contract.profileRootsNested = [bool]$comparison.profileRootsNested
                $contract.appDataDifferent = [bool]$comparison.appDataDifferent
                $contract.localAppDataDifferent = [bool]$comparison.localAppDataDifferent
                $contract.geminiDirDifferent = [bool]$comparison.geminiDirDifferent
                $contract.neitherUsesDefaultAntigravityProfile = [bool]$comparison.neitherUsesDefaultAntigravityProfile
                $contract.accountIsolationBoundary = [string]$parsed.accountIsolationBoundary
                $contract.accountIsolationCaveat = [string]$parsed.accountIsolationCaveat
                $dualOk = $parsed.ok -eq $true `
                    -and $parsed.usedRealTraffic -eq $false `
                    -and $parsed.loginVerified -eq $false `
                    -and $parsed.separateAccountVerified -eq $false `
                    -and $parsed.accountLaneRole -eq "dual-antigravity-cli-account-lanes" `
                    -and $parsed.coverageKind -eq "dual-account-lanes-prepared-no-traffic" `
                    -and $parsed.antiCodexLane.role -eq "anticodex-model-text" `
                    -and $parsed.mcpLane.role -eq "external-mcp-antigravity-account" `
                    -and $parsed.mcpLane.managedByAntiCodex -eq $false `
                    -and $comparison.profileRootsDifferent -eq $true `
                    -and $comparison.profileRootsNested -eq $false `
                    -and $comparison.appDataDifferent -eq $true `
                    -and $comparison.localAppDataDifferent -eq $true `
                    -and $comparison.geminiDirDifferent -eq $true `
                    -and $comparison.neitherUsesDefaultAntigravityProfile -eq $true `
                    -and [string]$parsed.accountIsolationBoundary `
                    -and [string]$parsed.accountIsolationCaveat
            } catch {
                Add-Failure "Antigravity CLI dual account lanes JSON parse failed"
            }
        }
        if (-not $dualOk -and $result.ok) {
            Add-Failure "Antigravity CLI dual account lanes contract not satisfied"
        }
        if (-not $result.ok) { Add-Failure "Antigravity CLI dual account lanes verifier failed" }
        return [pscustomobject]@{
            ok = $dualOk
            name = "Antigravity CLI dual account lanes (no-traffic)"
            exitCode = $result.exitCode
            timedOut = $result.timedOut
            durationMs = $result.durationMs
            usedRealTraffic = $false
            loginVerified = $false
            separateAccountVerified = $false
            accountLaneRole = $contract.accountLaneRole
            coverageKind = $contract.coverageKind
            antiCodexLaneRole = $contract.antiCodexLaneRole
            mcpLaneRole = $contract.mcpLaneRole
            mcpLaneManagedByAntiCodex = $contract.mcpLaneManagedByAntiCodex
            accountIsolationBoundary = $contract.accountIsolationBoundary
            accountIsolationCaveat = $contract.accountIsolationCaveat
            contract = $contract
        }
    } finally {
        Remove-Item -LiteralPath $tempStateRoot, $tempReportRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-AntigravityCliProfilePrepare {
    $powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\prepare-anticodex-antigravity-cli-profile.ps1"
    $tempStateRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-state-" + [Guid]::NewGuid().ToString("N"))
    $tempReportRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-report-" + [Guid]::NewGuid().ToString("N"))
    $tempProfileRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-profile-" + [Guid]::NewGuid().ToString("N"))
    try {
        $result = Invoke-SourceProcess `
            -Name "Antigravity CLI profile prepare (no-traffic)" `
            -FilePath $powershell `
            -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script,
                "-StateRoot", $tempStateRoot,
                "-ReportRoot", $tempReportRoot,
                "-ProfileRoot", $tempProfileRoot,
                "-NoSaveProfile") `
            -TimeoutSec 30
        $prepareJson = Get-SourceJsonReportText `
            -ReportRoot $tempReportRoot `
            -LatestFileName "latest-antigravity-cli-profile-prepare.json" `
            -FallbackTail $result.stdoutTail
        $prepareOk = $false
        $prepareContract = [ordered]@{
            ok = $false
            usedRealTraffic = $false
            loginVerified = $false
            separateAccountVerified = $false
            accountLaneRole = ""
            mcpAccountLaneManagedByAntiCodex = $true
            mcpAccountLaneOwner = ""
            coverageKind = "missing"
            accountIsolationBoundary = ""
            accountIsolationCaveat = ""
        }
        if ($result.ok -and $prepareJson) {
            try {
                $parsed = $prepareJson | ConvertFrom-Json
                $prepareContract.ok = [bool]$parsed.ok
                $prepareContract.usedRealTraffic = [bool]$parsed.usedRealTraffic
                $prepareContract.loginVerified = [bool]$parsed.loginVerified
                $prepareContract.separateAccountVerified = [bool]$parsed.separateAccountVerified
                $prepareContract.accountLaneRole = [string]$parsed.accountLaneRole
                $prepareContract.mcpAccountLaneManagedByAntiCodex = [bool]$parsed.mcpAccountLaneManagedByAntiCodex
                $prepareContract.mcpAccountLaneOwner = [string]$parsed.mcpAccountLaneOwner
                $prepareContract.coverageKind = [string]$parsed.coverageKind
                $prepareContract.accountIsolationBoundary = [string]$parsed.accountIsolationBoundary
                $prepareContract.accountIsolationCaveat = [string]$parsed.accountIsolationCaveat
                $prepareOk = $parsed.ok -eq $true `
                    -and $parsed.usedRealTraffic -eq $false `
                    -and $parsed.loginVerified -eq $false `
                    -and $parsed.separateAccountVerified -eq $false `
                    -and $parsed.accountLaneRole -eq "anticodex-model-text" `
                    -and $parsed.mcpAccountLaneManagedByAntiCodex -eq $false `
                    -and $parsed.mcpAccountLaneOwner -eq "external-antigravity-account-not-managed-here" `
                    -and $parsed.coverageKind -eq "profile-prepared-no-traffic" `
                    -and $parsed.accountIsolationBoundary `
                    -and $parsed.accountIsolationCaveat
            } catch {
                Add-Failure "Antigravity CLI profile prepare JSON parse failed"
            }
        }
        if (-not $prepareOk -and $result.ok) {
            Add-Failure "Antigravity CLI profile prepare contract not satisfied"
        }
        if (-not $result.ok) { Add-Failure "Antigravity CLI profile prepare failed" }
        return [pscustomobject]@{
            ok = $prepareOk
            name = "Antigravity CLI profile prepare (no-traffic)"
            exitCode = $result.exitCode
            timedOut = $result.timedOut
            durationMs = $result.durationMs
            usedRealTraffic = $false
            loginVerified = $false
            separateAccountVerified = $false
            accountLaneRole = $prepareContract.accountLaneRole
            mcpAccountLaneManagedByAntiCodex = $prepareContract.mcpAccountLaneManagedByAntiCodex
            mcpAccountLaneOwner = $prepareContract.mcpAccountLaneOwner
            coverageKind = $prepareContract.coverageKind
            accountIsolationBoundary = $prepareContract.accountIsolationBoundary
            accountIsolationCaveat = $prepareContract.accountIsolationCaveat
            contract = $prepareContract
        }
    } finally {
        Remove-Item -LiteralPath $tempStateRoot, $tempReportRoot, $tempProfileRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-AntigravityCliProfilePrepareRejectsDefaultChild {
    $powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\prepare-anticodex-antigravity-cli-profile.ps1"
    $tempStateRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-badchild-state-" + [Guid]::NewGuid().ToString("N"))
    $tempReportRoot = Join-Path ([IO.Path]::GetTempPath()) ("anticodex-srcpreflight-badchild-report-" + [Guid]::NewGuid().ToString("N"))
    $badChildProfile = Join-Path $env:APPDATA ("Antigravity\anticodex-srcpreflight-bad-child-" + [Guid]::NewGuid().ToString("N"))
    try {
        $result = Invoke-SourceProcess `
            -Name "Antigravity CLI profile prepare (reject default child)" `
            -FilePath $powershell `
            -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script,
                "-StateRoot", $tempStateRoot,
                "-ReportRoot", $tempReportRoot,
                "-ProfileRoot", $badChildProfile,
                "-NoSaveProfile") `
            -TimeoutSec 30
        $prepareJson = Get-SourceJsonReportText `
            -ReportRoot $tempReportRoot `
            -LatestFileName "latest-antigravity-cli-profile-prepare.json" `
            -FallbackTail $result.stdoutTail
        $rejectedOk = $false
        $usedRealTraffic = $null
        $failureText = ""
        if ($prepareJson) {
            try {
                $parsed = $prepareJson | ConvertFrom-Json
                $usedRealTraffic = $parsed.usedRealTraffic
                $failureText = (($parsed.failures | ForEach-Object { [string]$_ }) -join "`n")
                $rejectedOk = $result.exitCode -ne 0 `
                    -and $parsed.ok -eq $false `
                    -and $parsed.usedRealTraffic -eq $false `
                    -and $parsed.coverageKind -eq "profile-prepare-failed" `
                    -and $failureText -match "known default Antigravity profile location"
            } catch {
                Add-Failure "Antigravity CLI profile prepare reject default child JSON parse failed"
            }
        }
        if (-not $rejectedOk) {
            Add-Failure "Antigravity CLI profile prepare did not reject default Antigravity child profile without real traffic"
        }
        return [pscustomobject]@{
            ok = $rejectedOk
            name = "Antigravity CLI profile prepare (reject default child)"
            exitCode = $result.exitCode
            timedOut = $result.timedOut
            durationMs = $result.durationMs
            profileRoot = $badChildProfile
            usedRealTraffic = $usedRealTraffic
            failureText = $failureText
        }
    } finally {
        Remove-Item -LiteralPath $tempStateRoot, $tempReportRoot, $badChildProfile -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-AntigravityCliWindowsUserLoginDryRun {
    $powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
    $script = Join-Path $SourceRoot "scripts\start-anticodex-antigravity-cli-login-windows-user.ps1"
    $result = Invoke-SourceProcess `
        -Name "Antigravity CLI Windows-user login terminal dry-run" `
        -FilePath $powershell `
        -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script,
            "-WindowsUser", ".\AntiCodexModel",
            "-DryRun") `
        -TimeoutSec 30
    $dryRunJson = ($result.stdoutTail -join "`n")
    $contractOk = $false
    $contract = [ordered]@{
        ok = $false
        noTraffic = $false
        usedRealTraffic = $true
        started = $true
        capturesLoginOutput = $true
        readinessChecked = $false
        normalizedTargetWindowsUser = ""
        currentWindowsUser = ""
        currentWindowsUserSid = ""
        targetWindowsUserSid = ""
        targetUserSidMatchesCurrentUser = $true
        targetUserIdentityBoundaryOk = $false
        localUserLookupAvailable = $false
        targetUserExists = $null
        targetUserEnabled = $null
        targetUserIsCurrentUser = $true
        readyForInteractiveLogin = $false
        readinessBlockingReason = ""
        credentialBoundary = ""
        expectedCredentialStoreIsolation = $false
        runasWorkingDirectory = ""
        bootstrapKeepsShellOpen = $true
        accountIsolationCaveat = ""
    }
    if ($result.ok -and $dryRunJson) {
        try {
            $parsed = $dryRunJson | ConvertFrom-Json
            $contract.ok = [bool]$parsed.ok
            $contract.noTraffic = [bool]$parsed.noTraffic
            $contract.usedRealTraffic = [bool]$parsed.usedRealTraffic
            $contract.started = [bool]$parsed.started
            $contract.capturesLoginOutput = [bool]$parsed.capturesLoginOutput
            $contract.readinessChecked = [bool]$parsed.readinessChecked
            $contract.normalizedTargetWindowsUser = [string]$parsed.normalizedTargetWindowsUser
            $contract.currentWindowsUser = [string]$parsed.currentWindowsUser
            $contract.currentWindowsUserSid = if ($parsed.PSObject.Properties.Name -contains "currentWindowsUserSid") { [string]$parsed.currentWindowsUserSid } else { "" }
            $contract.targetWindowsUserSid = if ($parsed.PSObject.Properties.Name -contains "targetWindowsUserSid") { [string]$parsed.targetWindowsUserSid } else { "" }
            $contract.targetUserSidMatchesCurrentUser = if ($parsed.PSObject.Properties.Name -contains "targetUserSidMatchesCurrentUser") { [bool]$parsed.targetUserSidMatchesCurrentUser } else { $true }
            $contract.targetUserIdentityBoundaryOk = if ($parsed.PSObject.Properties.Name -contains "targetUserIdentityBoundaryOk") { [bool]$parsed.targetUserIdentityBoundaryOk } else { $false }
            $contract.localUserLookupAvailable = [bool]$parsed.localUserLookupAvailable
            $contract.targetUserExists = $parsed.targetUserExists
            $contract.targetUserEnabled = if ($parsed.PSObject.Properties.Name -contains "targetUserEnabled") { $parsed.targetUserEnabled } else { $null }
            $contract.targetUserIsCurrentUser = [bool]$parsed.targetUserIsCurrentUser
            $contract.readyForInteractiveLogin = [bool]$parsed.readyForInteractiveLogin
            $contract.readinessBlockingReason = [string]$parsed.readinessBlockingReason
            $contract.credentialBoundary = [string]$parsed.credentialBoundary
            $contract.expectedCredentialStoreIsolation = [bool]$parsed.expectedCredentialStoreIsolation
            $contract.runasWorkingDirectory = [string]$parsed.runasWorkingDirectory
            $contract.bootstrapKeepsShellOpen = if ($parsed.PSObject.Properties.Name -contains "bootstrapKeepsShellOpen") { [bool]$parsed.bootstrapKeepsShellOpen } else { $true }
            $contract.accountIsolationCaveat = [string]$parsed.accountIsolationCaveat
            $contractOk = $parsed.ok -eq $true `
                -and $parsed.noTraffic -eq $true `
                -and $parsed.usedRealTraffic -eq $false `
                -and $parsed.started -eq $false `
                -and $parsed.capturesLoginOutput -eq $false `
                -and $parsed.readinessChecked -eq $true `
                -and [string]$parsed.normalizedTargetWindowsUser `
                -and [string]$parsed.currentWindowsUser `
                -and [string]$contract.currentWindowsUserSid `
                -and $parsed.targetUserIsCurrentUser -eq $false `
                -and $contract.targetUserSidMatchesCurrentUser -eq $false `
                -and ($parsed.readyForInteractiveLogin -ne $true -or $contract.targetUserEnabled -ne $false) `
                -and ($parsed.readyForInteractiveLogin -ne $true -or ([string]$contract.targetWindowsUserSid -and $contract.targetUserIdentityBoundaryOk -eq $true)) `
                -and $parsed.credentialBoundary -eq "separate-windows-user" `
                -and $parsed.expectedCredentialStoreIsolation -eq $true `
                -and [string]$parsed.runasWorkingDirectory `
                -and $parsed.bootstrapKeepsShellOpen -eq $false `
                -and [string]$parsed.accountIsolationCaveat
            if ($parsed.readyForInteractiveLogin -ne $true -and [string]$parsed.readinessBlockingReason) {
                Add-Warning "Antigravity CLI Windows-user login readiness gap: $($parsed.readinessBlockingReason)"
            }
        } catch {
            Add-Failure "Antigravity CLI Windows-user login dry-run JSON parse failed"
        }
    }
    if (-not $contractOk -and $result.ok) {
        Add-Failure "Antigravity CLI Windows-user login dry-run contract not satisfied"
    }
    if (-not $result.ok) { Add-Failure "Antigravity CLI Windows-user login dry-run failed" }
    return [pscustomobject]@{
        ok = $contractOk
        name = "Antigravity CLI Windows-user login terminal dry-run"
        exitCode = $result.exitCode
        timedOut = $result.timedOut
        durationMs = $result.durationMs
        noTraffic = $contract.noTraffic
        usedRealTraffic = $contract.usedRealTraffic
        started = $contract.started
        capturesLoginOutput = $contract.capturesLoginOutput
        readinessChecked = $contract.readinessChecked
        normalizedTargetWindowsUser = $contract.normalizedTargetWindowsUser
        currentWindowsUser = $contract.currentWindowsUser
        currentWindowsUserSid = $contract.currentWindowsUserSid
        targetWindowsUserSid = $contract.targetWindowsUserSid
        targetUserSidMatchesCurrentUser = $contract.targetUserSidMatchesCurrentUser
        targetUserIdentityBoundaryOk = $contract.targetUserIdentityBoundaryOk
        localUserLookupAvailable = $contract.localUserLookupAvailable
        targetUserExists = $contract.targetUserExists
        targetUserEnabled = $contract.targetUserEnabled
        targetUserIsCurrentUser = $contract.targetUserIsCurrentUser
        readyForInteractiveLogin = $contract.readyForInteractiveLogin
        readinessBlockingReason = $contract.readinessBlockingReason
        credentialBoundary = $contract.credentialBoundary
        expectedCredentialStoreIsolation = $contract.expectedCredentialStoreIsolation
        runasWorkingDirectory = $contract.runasWorkingDirectory
        bootstrapKeepsShellOpen = $contract.bootstrapKeepsShellOpen
        accountIsolationCaveat = $contract.accountIsolationCaveat
        contract = $contract
    }
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
    $result = Invoke-SourceProcess -Name "translator source regression" -FilePath $node -Arguments (@("--test") + $testFiles) -TimeoutSec $SubcheckTimeoutSec
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
    Add-DocAssertion -File "README.md" -Name "client-copy-sync-contract" -Ok ($readme -match 'client-copy sync' -and $readme -match 'feature-by-feature rebuild')
    Add-DocAssertion -File "README.md" -Name "antigravity-entitlement-model-text" -Ok ($readme -match 'Antigravity' -and $readme -match 'Anti-Codex/Codex')
    Add-DocAssertion -File "README.md" -Name "third-party-profile-boundary" -Ok ($readme -match 'upstream profile')
    Add-DocAssertion -File "README.md" -Name "connector-authorization-boundary" -Ok ($readme -match 'connector-backed app tools')
    Add-DocAssertion -File "README.md" -Name "no-old-public-launch-claims" -Ok ($readme -notmatch 'DeepCodex app|DeepCodex launched successfully|DeepCodex for Windows is|DeepCodex\.lnk')
    Add-DocAssertion -File "README_EN.md" -Name "anti-codex-brand" -Ok ($readmeEn -match '^# Anti-Codex')
    Add-DocAssertion -File "README_EN.md" -Name "client-copy-sync-contract" -Ok ($readmeEn -match 'guarded client sync' -and $readmeEn -match 'not a feature-by-feature reimplementation')
    Add-DocAssertion -File "README_EN.md" -Name "antigravity-entitlement-model-text" -Ok ($readmeEn -match 'Antigravity entitlement' -and $readmeEn -match 'Codex-owned tools stay in Anti-Codex')
    Add-DocAssertion -File "README_EN.md" -Name "third-party-profile-boundary" -Ok ($readmeEn -match 'upstream profile')
    Add-DocAssertion -File "README_EN.md" -Name "connector-authorization-boundary" -Ok ($readmeEn -match 'Connector-backed app tools')
    Add-DocAssertion -File "README_EN.md" -Name "no-old-public-launch-claims" -Ok ($readmeEn -notmatch 'DeepCodex app|DeepCodex launched successfully|DeepCodex for Windows is|DeepCodex\.lnk')

    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "provider-stack-title" -Ok ($providerStack -match '^# Anti-Codex provider stack')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "antigravity-entitlement-model-text" -Ok ($providerStack -match 'Antigravity entitlement supplies model text')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "third-party-provider" -Ok ($providerStack -match 'optional third-party provider profile')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "connector-boundary" -Ok ($providerStack -match 'Metadata parity does not grant connector authorization')
    Add-DocAssertion -File "docs\ADAPTIVE_ONE_API_STACK.md" -Name "no-old-one-api-default" -Ok ($providerStack -notmatch '# deepcodex adaptive one-api|deepcodex\.app|setup-one-api-minimal|start-adaptive-oneapi|creates or updates a `deepcodex`')

    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "anti-codex-scope" -Ok ($compatibility -match 'Scope: Anti-Codex translates Codex Desktop')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "antigravity-entitlement-model-text" -Ok ($compatibility -match 'Antigravity entitlement supplies model text')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "provider-shapes" -Ok ($compatibility -match 'OpenAI-compatible third-party providers' -and $compatibility -match 'Anthropic-compatible third-party providers')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "connector-boundary" -Ok ($compatibility -match 'Connector/app-tool metadata parity must not be treated as authorization')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "legacy-prefix-is-internal" -Ok ($compatibility -match 'deepcodex\.reasoning\.hex\.v1:<hex>' -and $compatibility -match 'internal compatibility token')
    Add-DocAssertion -File "docs\chat-to-responses-compat.md" -Name "no-old-deepseek-scope" -Ok ($compatibility -notmatch 'Scope: deepcodex|DeepSeek route|DeepSeek-specific|Current Deepcodex Gaps|Deepcodex should')

    Add-DocAssertion -File "docs\marketing\*.md" -Name "anti-codex-brand" -Ok ($marketingDocs -match 'Anti-Codex')
    Add-DocAssertion -File "docs\marketing\*.md" -Name "provider-language" -Ok ($marketingDocs -match 'Antigravity' -and $marketingDocs -match 'third-party|provider|OpenAI-compatible|Anthropic API')
    Add-DocAssertion -File "docs\marketing\*.md" -Name "connector-boundary" -Ok ($marketingDocs -match 'connector|app tool' -and $marketingDocs -match 'does not fake authorization')
    Add-DocAssertion -File "docs\marketing\*.md" -Name "no-current-legacy-marketing" -Ok ($marketingDocs -notmatch 'DeepCodex|deepcodex|DeepSeek-only|DeepSeek route|DeepSeek API key')
    $currentPublicDocs = @($readme, $readmeEn, $providerStack, $compatibility, $marketingDocs) -join "`n"
    $currentCliBoundaryDocs = @($readme, $readmeEn, $windowsDoc) -join "`n"
    $hasAntigravityCliTarget = $currentCliBoundaryDocs -match 'Antigravity CLI'
    $hasDesktopCoworkerBoundary = $currentCliBoundaryDocs -match 'Desktop/coworker'
    $hasCompatibilityLayerBoundary = $currentCliBoundaryDocs -match 'compatibility layer'
    $cliTargetDesktopCompatBoundaryOk = $hasAntigravityCliTarget -and $hasDesktopCoworkerBoundary -and $hasCompatibilityLayerBoundary
    $noDesktopDefaultPattern = 'Antigravity Desktop provider|Antigravity Desktop is the default|Antigravity Desktop remains the default route|default route remains the local signed-in Antigravity Desktop account|Antigravity Desktop by default'
    $noNativeBridgeDefaultPattern = 'native same-cascade MCP continuation'
    $noAntigravityDesktopDefaultRouteOk = $currentPublicDocs -notmatch $noDesktopDefaultPattern
    $noNativeBridgeDefaultWordingOk = $currentPublicDocs -notmatch $noNativeBridgeDefaultPattern
    Add-DocAssertion -File "current public docs" -Name "no-antigravity-desktop-default-route" -Ok $noAntigravityDesktopDefaultRouteOk
    Add-DocAssertion -File "current public docs" -Name "antigravity-cli-target-desktop-compat-boundary" -Ok $cliTargetDesktopCompatBoundaryOk
    Add-DocAssertion -File "current public docs" -Name "no-native-bridge-default-wording" -Ok $noNativeBridgeDefaultWordingOk
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
    $result = Invoke-SourceProcess -Name "git diff --check" -FilePath $gitCommand.Source -Arguments @("-C", $sourceRoot, "diff", "--check") -TimeoutSec 30
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
    $checks["javascriptSyntax"] = Test-JavaScriptSyntax
    $checks["powershellSyntax"] = Test-PowerShellSyntax
    $checks["uiStateSelfTest"] = Test-UiStateSelfTest
    $checks["managerBridgeSelfTest"] = Test-ManagerBridgeSelfTest
    $checks["logDbGuardSelfTest"] = Test-LogDbGuardSelfTest
    $checks["upstreamProfileStorage"] = Test-UpstreamProfileStorage
    $checks["antigravityCliIsolationProfile"] = Test-AntigravityCliIsolationProfile
    $checks["antigravityCliDualAccountLanes"] = Test-AntigravityCliDualAccountLanes
    $checks["antigravityCliProfilePrepare"] = Test-AntigravityCliProfilePrepare
    $checks["antigravityCliProfilePrepareRejectsDefaultChild"] = Test-AntigravityCliProfilePrepareRejectsDefaultChild
    $checks["antigravityCliWindowsUserLoginDryRun"] = Test-AntigravityCliWindowsUserLoginDryRun
    $checks["localConnectorVerifier"] = Test-LocalConnectorVerifier
    $checks["publicDocumentation"] = Test-PublicDocumentationContracts
    $checks["translatorRegression"] = Test-TranslatorRegression
    $checks["diffWhitespace"] = Test-GitDiffCheck
} catch {
    $line = $_.InvocationInfo.ScriptLineNumber
    $command = $_.InvocationInfo.Line
    Add-Failure "source preflight failed at line ${line}: $($_.Exception.Message) $command"
}

$elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
$antigravityCliProfilePrepareOk = $false
$antigravityCliDualAccountLanesOk = $false
$antigravityCliWindowsUserLoginDryRunOk = $false
if ($checks["antigravityCliDualAccountLanes"]) {
    $antigravityCliDualAccountLanesOk = [bool]$checks["antigravityCliDualAccountLanes"].ok
}
if ($checks["antigravityCliProfilePrepare"]) {
    $antigravityCliProfilePrepareOk = [bool]$checks["antigravityCliProfilePrepare"].ok
}
if ($checks["antigravityCliWindowsUserLoginDryRun"]) {
    $antigravityCliWindowsUserLoginDryRunOk = [bool]$checks["antigravityCliWindowsUserLoginDryRun"].ok
}
$report = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "source-preflight"
    noTraffic = $true
    usedRealTraffic = $false
    behaviorCovered = ($failures.Count -eq 0)
    coverageKind = "source-no-traffic"
    antigravityCliDualAccountLanesOk = $antigravityCliDualAccountLanesOk
    antigravityCliProfilePrepareOk = $antigravityCliProfilePrepareOk
    antigravityCliWindowsUserLoginDryRunOk = $antigravityCliWindowsUserLoginDryRunOk
    sourceRoot = Normalize-Path $SourceRoot
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
