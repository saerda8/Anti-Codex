#Requires -Version 5.1
param(
    [string]$BaseUrl = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [string]$Model = $(if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "gemini-3.5-flash-low" }),
    [int]$TimeoutSec = 180,
    [switch]$AllowRealTraffic
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$failures = [System.Collections.Generic.List[string]]::new()
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$marker = "SMALL_PROJECT_MARKER_$stamp"
$artifactDir = Join-Path $ReportRoot "real-small-project\$stamp"
$started = Get-Date

function Add-Failure { param([string]$Message) $failures.Add($Message) | Out-Null }

function Resolve-NodeRuntime {
    if ($env:NODE_EXE -and (Test-Path -LiteralPath $env:NODE_EXE -PathType Leaf)) { return $env:NODE_EXE }
    return "node"
}

function Resolve-BaseUrl {
    if (-not $BaseUrl) {
        $resolver = Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1"
        if (Test-Path -LiteralPath $resolver -PathType Leaf) {
            return [string](& $resolver)
        }
        return "http://127.0.0.1:8484"
    }
    return $BaseUrl.TrimEnd("/")
}

function Save-Report {
    param($Payload)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $json = $Payload | ConvertTo-Json -Depth 24 -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    $latest = Join-Path $ReportRoot "latest-real-small-project.json"
    $history = Join-Path $ReportRoot "$stamp-real-small-project.json"
    Write-AntiCodexJsonReport -LatestPath $latest -HistoryPath $history -Json $json -Encoding $utf8NoBom
    $Payload | Add-Member -NotePropertyName report -NotePropertyValue ([pscustomobject]@{ latest = $latest; history = $history }) -Force
}

function Complete-Skipped {
    param([string]$Reason)
    $payload = [pscustomobject]@{
        ok = $true
        reportName = "real-small-project"
        skipped = $true
        requestedRealTraffic = $false
        usedRealTraffic = $false
        behaviorCovered = $false
        coverageKind = "skipped"
        reason = $Reason
        elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
    }
    Save-Report $payload
    Write-Output ($payload | ConvertTo-Json -Depth 24 -Compress)
    exit 0
}

function Invoke-ResponsesJson {
    param([hashtable]$Body)
    $json = $Body | ConvertTo-Json -Depth 24 -Compress
    return Invoke-RestMethod `
        -Uri "$script:ResolvedBaseUrl/v1/responses" `
        -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
        -TimeoutSec $TimeoutSec `
        -Proxy $null
}

function Get-ResponseItems {
    param($Response)
    if ($Response -and $Response.output) { return @($Response.output) }
    return @()
}

function Get-ResponseText {
    param($Response)
    $parts = foreach ($item in (Get-ResponseItems $Response)) {
        if ($item.type -ne "message") { continue }
        foreach ($content in @($item.content)) {
            if ($content.text) { [string]$content.text }
        }
    }
    return ($parts -join "`n").Trim()
}

function Read-ToolArguments {
    param($Call)
    if (-not $Call -or -not $Call.arguments) { return $null }
    try { return $Call.arguments | ConvertFrom-Json } catch { Add-Failure "tool arguments are invalid JSON: $($_.Exception.Message)"; return $null }
}

function Convert-ToRelativePath {
    param([string]$Path)
    $normalized = $Path -replace "\\", "/"
    $normalized = $normalized.TrimStart("/")
    if ($normalized -match "\.\." -or $normalized -match "^[A-Za-z]:") {
        throw "unsafe project file path: $Path"
    }
    return $normalized
}

function Write-SmallProjectFiles {
    param($Arguments)
    New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
    $written = @()
    foreach ($file in @($Arguments.files)) {
        $relative = Convert-ToRelativePath ([string]$file.path)
        $target = Join-Path $artifactDir $relative
        $parent = Split-Path -Parent $target
        if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        [IO.File]::WriteAllText($target, [string]$file.content, [Text.UTF8Encoding]::new($false))
        $written += $relative
    }
    return $written
}

function Invoke-NodeJson {
    param([string[]]$Arguments, [int]$TimeoutMilliseconds = 30000)
    $node = Resolve-NodeRuntime
    $stdout = Join-Path $artifactDir ("node-out-" + [guid]::NewGuid().ToString("N") + ".txt")
    $stderr = Join-Path $artifactDir ("node-err-" + [guid]::NewGuid().ToString("N") + ".txt")
    $process = Start-Process -FilePath $node -ArgumentList $Arguments -WorkingDirectory $artifactDir -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
        try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
        throw "node process timed out"
    }
    $process.Refresh()
    $outText = if (Test-Path -LiteralPath $stdout) { [IO.File]::ReadAllText($stdout, [Text.Encoding]::UTF8) } else { "" }
    $errText = if (Test-Path -LiteralPath $stderr) { [IO.File]::ReadAllText($stderr, [Text.Encoding]::UTF8) } else { "" }
    return [pscustomobject]@{ exitCode = [int]$process.ExitCode; stdout = $outText; stderr = $errText }
}

if (-not $AllowRealTraffic) {
    Complete-Skipped "real small-project verification is opt-in; rerun with -AllowRealTraffic"
}

$script:ResolvedBaseUrl = Resolve-BaseUrl
$health = $null
$first = $null
$final = $null
$call = $null
$arguments = $null
$writtenFiles = @()
$testRun = $null
$cliRun = $null
$cliJson = $null
$toolCallAttemptCount = 0
$toolCallRetryReason = ""

try {
    $health = Invoke-RestMethod -Uri "$script:ResolvedBaseUrl/health" -Proxy $null -TimeoutSec 8
    if ($health.ok -ne $true) { Add-Failure "health is not ok" }

    $projectTool = @{
        type = "function"
        name = "write_small_project"
        description = "Write files for a tiny local Node.js CLI project."
        parameters = @{
            type = "object"
            properties = @{
                files = @{
                    type = "array"
                    minItems = 3
                    items = @{
                        type = "object"
                        properties = @{
                            path = @{ type = "string" }
                            content = @{ type = "string" }
                        }
                        required = @("path", "content")
                        additionalProperties = $false
                    }
                }
                marker = @{ type = "string" }
            }
            required = @("files", "marker")
            additionalProperties = $false
        }
    }

    $prompt = @(
        "Create a tiny Node.js CLI project and call write_small_project exactly once to write the project files.",
        "Requirements:",
        "- The project must include package.json, word-tally.mjs, and word-tally.test.mjs.",
        "- The CLI reads text from command line arguments and prints one JSON line.",
        "- JSON must include ok:true, marker:""$marker"", words, characters, and uniqueWords.",
        "- words are split by whitespace; empty input returns 0.",
        "- characters is the original input string length.",
        "- uniqueWords is case-insensitive.",
        "- The test file must use node:test and assert/strict, covering normal text, case-insensitive unique words, and empty input.",
        "- Use no external dependencies.",
        "- marker must be $marker.",
        "Do not answer in natural language before the tool result is returned."
    ) -join "`n"

    $toolCallAttemptCount = 1
    $first = Invoke-ResponsesJson @{
        model = $Model
        stream = $false
        store = $true
        tool_choice = "required"
        tools = @($projectTool)
        input = @(@{
            type = "message"
            role = "user"
            content = @(@{ type = "input_text"; text = $prompt })
        })
    }

    $call = @(Get-ResponseItems $first | Where-Object { $_.type -eq "function_call" -and $_.name -eq "write_small_project" }) | Select-Object -First 1
    if (-not $call -or -not $call.call_id) {
        $toolCallRetryReason = "missing_write_small_project_function_call"
        $toolCallAttemptCount = 2
        $retryPrompt = @(
            "MUST call write_small_project exactly once as a tool call. Do not write prose first.",
            "files must include package.json, word-tally.mjs, and word-tally.test.mjs.",
            "word-tally.mjs must join command-line arguments into input text and print one JSON line.",
            "JSON must include ok:true, marker:""$marker"", words, characters, and uniqueWords.",
            "word-tally.test.mjs must use node:test and assert/strict.",
            "Tests must cover normal text, case-insensitive uniqueWords, and empty input.",
            "The marker field must exactly equal $marker."
        ) -join "`n"
        $first = Invoke-ResponsesJson @{
            model = $Model
            stream = $false
            store = $true
            tool_choice = "required"
            tools = @($projectTool)
            input = @(@{
                type = "message"
                role = "user"
                content = @(@{ type = "input_text"; text = $retryPrompt })
            })
        }
        $call = @(Get-ResponseItems $first | Where-Object { $_.type -eq "function_call" -and $_.name -eq "write_small_project" }) | Select-Object -First 1
    }
    if (-not $first.id) { Add-Failure "first response did not contain an id" }
    if (-not $call -or -not $call.call_id) { Add-Failure "first response did not emit write_small_project function_call" }
    $arguments = Read-ToolArguments $call
    if ($arguments) {
        if ([string]$arguments.marker -ne $marker) { Add-Failure "tool marker mismatch" }
        $writtenFiles = Write-SmallProjectFiles $arguments
        foreach ($required in @("package.json", "word-tally.mjs", "word-tally.test.mjs")) {
            if ($writtenFiles -notcontains $required) { Add-Failure "missing required project file: $required" }
        }
    }

    if ($failures.Count -eq 0) {
        $testRun = Invoke-NodeJson @("--test", "word-tally.test.mjs")
        if ($testRun.exitCode -ne 0) { Add-Failure "node:test failed: $($testRun.stderr)" }
        $cliRun = Invoke-NodeJson @("word-tally.mjs", "Hello hello CLI")
        if ($cliRun.exitCode -ne 0) { Add-Failure "CLI exited non-zero: $($cliRun.stderr)" }
        try { $cliJson = $cliRun.stdout.Trim() | ConvertFrom-Json } catch { Add-Failure "CLI output is not JSON: $($_.Exception.Message)" }
        if ($cliJson) {
            if ($cliJson.ok -ne $true) { Add-Failure "CLI ok field mismatch" }
            if ([string]$cliJson.marker -ne $marker) { Add-Failure "CLI marker mismatch" }
            if ([int]$cliJson.words -ne 3) { Add-Failure "CLI words mismatch" }
            if ([int]$cliJson.uniqueWords -ne 2) { Add-Failure "CLI uniqueWords mismatch" }
        }
    }

    $finalText = ""
    if ($failures.Count -eq 0) {
        $final = Invoke-ResponsesJson @{
            model = $Model
            stream = $false
            store = $true
            previous_response_id = [string]$first.id
            tool_choice = "auto"
            tools = @($projectTool)
            input = @(
                @{ type = "function_call_output"; call_id = [string]$call.call_id; output = "SMALL_PROJECT_OK $marker files=$($writtenFiles -join ',')" },
                @{ type = "message"; role = "user"; content = @(@{
                    type = "input_text"
                    text = "Reply in one Chinese sentence confirming the small project is complete. The sentence must include SMALL_PROJECT_OK and $marker. Do not call tools again."
                }) }
            )
        }
        $finalText = Get-ResponseText $final
        if ($finalText -notmatch "SMALL_PROJECT_OK" -or $finalText -notmatch [regex]::Escape($marker)) {
            Add-Failure "final response did not confirm the small project marker"
        }
        if ($finalText -notmatch "[\u4e00-\u9fff]") {
            Add-Failure "final response is not Chinese"
        }
    }

    $failureCleanup = [pscustomobject]@{
        attempted = $false
        reason = if ($failures.Count -eq 0) { "task_passed" } else { "no_owned_active_response_id" }
    }

    $payload = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        reportName = "real-small-project"
        requestedRealTraffic = $true
        usedRealTraffic = $true
        behaviorCovered = ($failures.Count -eq 0)
        coverageKind = "real-traffic-small-project"
        failures = @($failures)
        model = $Model
        baseUrl = $script:ResolvedBaseUrl
        elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
        first_response_id = if ($first) { [string]$first.id } else { "" }
        call_id = if ($call) { [string]$call.call_id } else { "" }
        toolCallAttemptCount = $toolCallAttemptCount
        toolCallRetryReason = $toolCallRetryReason
        marker = $marker
        artifact = [pscustomobject]@{
            directory = $artifactDir
            files = @($writtenFiles)
            testPassed = ($testRun -and $testRun.exitCode -eq 0)
            cliPassed = ($cliJson -and $cliJson.ok -eq $true)
            markerMatched = ($cliJson -and [string]$cliJson.marker -eq $marker)
        }
        final_text = $finalText
        health = $health
        failureCleanup = $failureCleanup
    }
    Save-Report $payload
    Write-Output ($payload | ConvertTo-Json -Depth 24 -Compress)
    if (-not $payload.ok) { exit 1 }
} catch {
    Add-Failure $_.Exception.Message
    $payload = [pscustomobject]@{
        ok = $false
        reportName = "real-small-project"
        requestedRealTraffic = $true
        usedRealTraffic = $true
        behaviorCovered = $false
        coverageKind = "real-traffic-small-project"
        failures = @($failures)
        model = $Model
        baseUrl = $script:ResolvedBaseUrl
        elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
        marker = $marker
        artifact = [pscustomobject]@{ directory = $artifactDir; files = @($writtenFiles) }
        failureCleanup = [pscustomobject]@{ attempted = $false; reason = "no_owned_active_response_id" }
    }
    Save-Report $payload
    Write-Output ($payload | ConvertTo-Json -Depth 24 -Compress)
    exit 1
}
