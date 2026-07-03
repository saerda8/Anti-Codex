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

function Invoke-SafeSessionResetIfIdle {
    param([string]$Reason = "real_small_project_timeout")
    try {
        $diagnostics = Invoke-RestMethod -Uri "$script:ResolvedBaseUrl/anticodex/diagnostics" -Proxy $null -TimeoutSec 8
        $lockActive = $diagnostics -and $diagnostics.antigravitySessionLock -and $diagnostics.antigravitySessionLock.active -eq $true
        $queued = if ($diagnostics -and $diagnostics.antigravitySessionLock) { [int]$diagnostics.antigravitySessionLock.queued } else { 0 }
        $activeRequests = if ($diagnostics -and $diagnostics.activeAntigravityRequests) { [int]$diagnostics.activeAntigravityRequests.active } else { 1 }
        if (-not $lockActive -or $activeRequests -ne 0) {
            return [pscustomobject]@{ attempted = $false; reason = "not_idle_or_no_lock"; lockActive = $lockActive; queued = $queued; activeRequests = $activeRequests }
        }

        $manager = Invoke-WebRequest -Uri "$script:ResolvedBaseUrl/anticodex/manager" -Proxy $null -TimeoutSec 8 -UseBasicParsing
        $token = ""
        if ($manager.Content -match 'managerActionToken="([^"]+)"') {
            $token = $matches[1]
        } elseif ($manager.Content -match 'name="anti-codex-manager-token"\s+content="([^"]+)"') {
            $token = $matches[1]
        }
        if (-not $token) {
            return [pscustomobject]@{ attempted = $false; reason = "manager_token_missing"; lockActive = $lockActive; queued = $queued; activeRequests = $activeRequests }
        }

        $body = @{ action = "resetAntigravitySessionLock"; reason = $Reason } | ConvertTo-Json -Compress
        $reset = Invoke-RestMethod `
            -Uri "$script:ResolvedBaseUrl/anticodex/manager/action" `
            -Method Post `
            -Headers @{ "x-anticodex-manager-token" = $token; "Origin" = $script:ResolvedBaseUrl; "Referer" = "$script:ResolvedBaseUrl/anticodex/manager" } `
            -ContentType "application/json" `
            -Body $body `
            -Proxy $null `
            -TimeoutSec 20
        return [pscustomobject]@{ attempted = $true; ok = ($reset.ok -eq $true); lockActive = $lockActive; queued = $queued; activeRequests = $activeRequests; reset = $reset }
    } catch {
        return [pscustomobject]@{ attempted = $false; reason = "reset_failed"; error = $_.Exception.Message }
    }
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

    $sessionResetAfterFailure = $null
    if ($failures.Count -gt 0) {
        $sessionResetAfterFailure = Invoke-SafeSessionResetIfIdle
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
        sessionResetAfterFailure = $sessionResetAfterFailure
    }
    Save-Report $payload
    Write-Output ($payload | ConvertTo-Json -Depth 24 -Compress)
    if (-not $payload.ok) { exit 1 }
} catch {
    Add-Failure $_.Exception.Message
    $resetAfterFailure = Invoke-SafeSessionResetIfIdle
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
        sessionResetAfterFailure = $resetAfterFailure
    }
    Save-Report $payload
    Write-Output ($payload | ConvertTo-Json -Depth 24 -Compress)
    exit 1
}
