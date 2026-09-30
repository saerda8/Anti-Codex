[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$InstallRoot = $(if ($env:DEEPCODEX_INSTALL_ROOT) { $env:DEEPCODEX_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Anti-Codex" }),
    [string]$StateRoot = $(if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 90,
    [switch]$AllowRealTraffic
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "anticodex-real-traffic-lock.psm1") -Force

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}
$fixedRouteHealthUrl = if ($env:ANTICODEX_FIXED_ROUTE_HEALTH_URL) {
    [string]$env:ANTICODEX_FIXED_ROUTE_HEALTH_URL
} else {
    "http://127.0.0.1:18487/anticodex/fixed-route/health"
}
$responseUrl = "$BaseUrl/v1/responses"
$localProxyKey = ""
try {
    $authPath = Join-Path $StateRoot "codex-home-deepseek-app\auth.json"
    if (Test-Path -LiteralPath $authPath) {
        $auth = Get-Content -Raw -LiteralPath $authPath | ConvertFrom-Json
        $localProxyKey = [string]$auth.OPENAI_API_KEY
    }
} catch {}
try {
    $fixedRouteHealth = Invoke-RestMethod -Uri $fixedRouteHealthUrl -TimeoutSec 5 -Proxy $null
    $codexBaseUrl = [string]$fixedRouteHealth.route.codexBaseUrl
    if ($fixedRouteHealth.ok -eq $true -and $fixedRouteHealth.state -eq "ready" -and $codexBaseUrl) {
        $responseUrl = "$($codexBaseUrl.TrimEnd('/'))/responses"
    }
} catch {
    # Keep the manager URL fallback for older installations without fixed-route health.
}

$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]
$model = if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "gemini-3.5-flash-low" }
$stamp = "r$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
$artifactDir = Join-Path $ReportRoot "real-work-artifacts\$stamp"
$artifactFile = Join-Path $artifactDir "probe.mjs"
$marker = "REAL_WORK_MARKER_$stamp"

function Add-Failure { param([string]$Message) $failures.Add($Message) | Out-Null }

function Save-Report {
    param($Payload)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $json = $Payload | ConvertTo-Json -Depth 14 -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath (Join-Path $ReportRoot "latest-real-work.json") -HistoryPath (Join-Path $ReportRoot "$stamp-real-work.json") -Json $json -Encoding $utf8NoBom
}

function Complete-Skipped {
    param([string]$Reason)
    $result = [pscustomobject]@{
        ok = $true
        skipped = $true
        reason = $Reason
        model = $model
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    }
    Save-Report $result
    $result | ConvertTo-Json -Depth 14 -Compress
    exit 0
}

function Invoke-AntiCodexResponse {
    param([hashtable]$Body)

    $json = $Body | ConvertTo-Json -Depth 24 -Compress
    $request = @{
        Uri = $responseUrl
        Method = "Post"
        ContentType = "application/json; charset=utf-8"
        Body = [Text.Encoding]::UTF8.GetBytes($json)
        TimeoutSec = $TimeoutSec
        Proxy = $null
    }
    if ($localProxyKey) { $request.Headers = @{ Authorization = "Bearer $localProxyKey" } }
    try {
        return Invoke-RestMethod @request
    } catch {
        $status = 0
        $detail = $_.Exception.Message
        try {
            $status = [int]$_.Exception.Response.StatusCode
            $stream = $_.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = [IO.StreamReader]::new($stream)
                try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
                if ($body) { $detail = "$detail; body=$body" }
            }
        } catch {}
        throw "HTTP ${status}: $detail"
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
            if ($content.type -eq "output_text" -and $content.text) { [string]$content.text }
        }
    }
    return ($parts -join "`n").Trim()
}

function Read-ToolArguments {
    param($Call)
    if (-not $Call -or -not $Call.arguments) { return $null }
    try { return $Call.arguments | ConvertFrom-Json } catch { Add-Failure "function tool arguments are invalid JSON: $($_.Exception.Message)"; return $null }
}

function Resolve-NodeRuntime {
    $bundled = Join-Path $InstallRoot "codex-patched-app\resources\cua_node\bin\node.exe"
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    $node = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($node) { return $node.Source }
    throw "node.exe not found"
}

function Invoke-RealNodeReplMcpResult {
    param([string]$Code, [string]$ExpectedMarker)

    $scriptPath = Join-Path $PSScriptRoot "anticodex-real-mcp-smoke.mjs"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "real MCP smoke script missing: $scriptPath"
    }
    $node = Resolve-NodeRuntime
    $nodeArgs = @(
        $scriptPath,
        "--install-root", $InstallRoot,
        "--state-root", $StateRoot,
        "--server", "node_repl",
        "--timeout-ms", ([Math]::Max(5000, $TimeoutSec * 1000)),
        "--report-root", $ReportRoot,
        "--marker", $ExpectedMarker,
        "--code", $Code
    )
    $output = & $node @nodeArgs 2>&1
    $exitCode = $LASTEXITCODE
    $text = @($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($exitCode -ne 0) { throw "real MCP node_repl call failed: $text" }
    $parsed = $text | ConvertFrom-Json
    if (-not $parsed.ok -or -not $parsed.markerObserved) {
        throw "real MCP node_repl call did not return the expected marker"
    }
    return $parsed
}

function Invoke-ProbeFile {
    param([string]$Path)

    $node = Resolve-NodeRuntime
    $output = & $node $Path 2>&1
    $exitCode = $LASTEXITCODE
    $text = (@($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
    if ($exitCode -ne 0) { throw "generated probe file exited $exitCode`: $text" }
    return $text | ConvertFrom-Json
}

if (-not $AllowRealTraffic) {
    Complete-Skipped "real work verification is opt-in; rerun with -AllowRealTraffic"
}

$lock = Enter-AntiCodexRealTrafficLock -WaitSeconds 0
if (-not $lock.acquired) {
    Complete-Skipped "another Anti-Codex real Antigravity verification is already running"
}

$mcpExecution = $null
$first = $null
$call = $null
$probeRun = $null
$finalText = ""

try {
    New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
    $mcpMarker = "MCP_OK_$marker"
    try {
        $mcpExecution = Invoke-RealNodeReplMcpResult -Code "nodeRepl.write('$mcpMarker')" -ExpectedMarker $mcpMarker
    } catch {
        Add-Failure "real node_repl MCP execution failed: $($_.Exception.Message)"
    }

    $fileTool = @{
        type = "function"
        name = "create_probe_file"
        description = "Return the requested path and marker for a fixed Anti-Codex verification probe."
        parameters = @{
            type = "object"
            properties = @{
                path = @{ type = "string"; description = "Absolute probe path." }
                marker = @{ type = "string"; description = "Verification marker." }
            }
            required = @("path", "marker")
            additionalProperties = $false
        }
    }

    $probeSource = "console.log(JSON.stringify({ok:true,marker:'$marker',tool:'anticodex-real-work'}));"
    $first = Invoke-AntiCodexResponse @{
        model = $model
        stream = $false
        store = $true
        tool_choice = "auto"
        tools = @($fileTool)
        input = @(@{
            type = "message"
            role = "user"
            content = @(@{
                type = "input_text"
                text = "请调用 create_probe_file 工具恰好一次。工具结果返回前不要用自然语言回答。path=$artifactFile marker=$marker"
            })
        })
    }

    $call = @(Get-ResponseItems $first | Where-Object { $_.type -eq "function_call" -and $_.name -eq "create_probe_file" }) | Select-Object -First 1
    if (-not $first.id) { Add-Failure "first response did not contain an id" }
    if (-not $call -or -not $call.call_id) { Add-Failure "first response did not emit create_probe_file function_call" }
    $arguments = Read-ToolArguments $call
    if ($arguments -and [string]$arguments.path -ne $artifactFile) {
        Add-Failure "create_probe_file path mismatch"
    }
    if ($arguments -and [string]$arguments.marker -ne $marker) {
        Add-Failure "create_probe_file marker mismatch"
    }

    if ($arguments -and [string]$arguments.path -and [string]$arguments.marker) {
        New-Item -ItemType Directory -Path (Split-Path -Parent ([string]$arguments.path)) -Force | Out-Null
        [IO.File]::WriteAllText([string]$arguments.path, $probeSource, [Text.Encoding]::UTF8)
        if (-not (Test-Path -LiteralPath $artifactFile -PathType Leaf)) {
            Add-Failure "generated probe file was not created"
        } else {
            $content = [IO.File]::ReadAllText($artifactFile, [Text.Encoding]::UTF8)
            if ($content -notmatch [regex]::Escape($marker)) { Add-Failure "generated probe file does not contain the marker" }
            $probeRun = Invoke-ProbeFile $artifactFile
            if ($probeRun.ok -ne $true -or [string]$probeRun.marker -ne $marker) {
                Add-Failure "generated probe file did not run with the expected marker"
            }
        }
    }

    $second = $null
    if ($call -and $call.call_id) {
        $second = Invoke-AntiCodexResponse @{
            model = $model
            stream = $false
            store = $true
            previous_response_id = [string]$first.id
            tool_choice = "auto"
            tools = @($fileTool)
            input = @(
                @{ type = "function_call_output"; call_id = [string]$call.call_id; output = "FILE_OK $marker" },
                @{ type = "message"; role = "user"; content = @(@{
                    type = "input_text"
                    text = "请用中文一句话确认文件任务完成，必须包含 FILE_OK 和 $marker，不要再次调用工具。"
                }) }
            )
        }
        $finalCalls = @(Get-ResponseItems $second | Where-Object { $_.type -match "tool_call|function_call" })
        $finalText = Get-ResponseText $second
        if ($finalCalls.Count -gt 0) { Add-Failure "final response repeated a tool call" }
        if ($finalText -notmatch "FILE_OK" -or $finalText -notmatch [regex]::Escape($marker)) {
            Add-Failure "final response did not confirm the real work marker"
        }
        if ($finalText -notmatch "[\u4e00-\u9fff]") {
            Add-Failure "final response did not answer the Chinese request in Chinese"
        }
        if ($finalText -match "DeepCodex") {
            Add-Failure "final response leaked the legacy DeepCodex brand"
        }
    }

    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        reportName = "real-work"
        requestedRealTraffic = $true
        usedRealTraffic = $true
        behaviorCovered = ($failures.Count -eq 0)
        coverageKind = "real-traffic"
        failures = $failures.ToArray()
        model = $model
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
        first_response_id = if ($first) { $first.id } else { $null }
        call_id = if ($call) { $call.call_id } else { $null }
        artifact = [pscustomobject]@{
            directory = $artifactDir
            file = $artifactFile
            exists = Test-Path -LiteralPath $artifactFile -PathType Leaf
            ran = $null -ne $probeRun
            markerMatched = if ($probeRun) { [string]$probeRun.marker -eq $marker } else { $false }
        }
        executor = [pscustomobject]@{
            tool = "create_probe_file"
            realFileWrite = Test-Path -LiteralPath $artifactFile -PathType Leaf
            realMcp = $mcpExecution
        }
        final_text = $finalText
    }
    Save-Report $result
    $result | ConvertTo-Json -Depth 14 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    $failureMessage = [string]$_.Exception.Message
    $statusCode = try { [int]$_.Exception.Response.StatusCode } catch { $null }
    $failureType = if ($statusCode -eq 429 -or $failureMessage -match "(?i)(429|too many requests|quota)") {
        "antigravity_quota_exceeded"
    } else {
        "real_work_exception"
    }
    $failureError = [pscustomobject]@{
        type = $failureType
        status = $statusCode
        message = $failureMessage
        retryable = $false
    }
    Add-Failure "real work verification exception: $failureMessage"
    $result = [pscustomobject]@{
        ok = $false
        reportName = "real-work"
        requestedRealTraffic = $true
        usedRealTraffic = $true
        behaviorCovered = $false
        coverageKind = "real-traffic"
        failures = $failures.ToArray()
        model = $model
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
        first_response_id = if ($first) { $first.id } else { $null }
        call_id = if ($call) { $call.call_id } else { $null }
        artifact = [pscustomobject]@{
            directory = $artifactDir
            file = $artifactFile
            exists = Test-Path -LiteralPath $artifactFile -PathType Leaf
            ran = $null -ne $probeRun
            markerMatched = if ($probeRun) { [string]$probeRun.marker -eq $marker } else { $false }
        }
        executor = [pscustomobject]@{
            tool = "create_probe_file"
            realFileWrite = Test-Path -LiteralPath $artifactFile -PathType Leaf
            realMcp = $mcpExecution
        }
        final_text = $finalText
        failed_error = $failureError
    }
    Save-Report $result
    Write-Output ($result | ConvertTo-Json -Depth 14 -Compress)
    exit 1
} finally {
    Exit-AntiCodexRealTrafficLock $lock
}
