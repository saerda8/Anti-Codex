[CmdletBinding()]
param(
    [string]$SourceRoot = "",
    [string]$ReportRoot = "",
    [int]$SubcheckTimeoutSec = 120,
    [switch]$SkipFullRegression
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
            stdoutTail = (($stdout -split "\r?\n") | Select-Object -Last 40)
            stderrTail = (($stderr -split "\r?\n") | Select-Object -Last 40)
        }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
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
    $checks["translatorRegression"] = Test-TranslatorRegression
    $checks["diffWhitespace"] = Test-GitDiffCheck
} catch {
    $line = $_.InvocationInfo.ScriptLineNumber
    $command = $_.InvocationInfo.Line
    Add-Failure "source preflight failed at line ${line}: $($_.Exception.Message) $command"
}

$elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
$report = [ordered]@{
    ok = ($failures.Count -eq 0)
    reportName = "source-preflight"
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
