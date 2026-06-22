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

$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]
$model = if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "gemini-3.5-flash-low" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$artifactDir = Join-Path $ReportRoot "real-work\$stamp"
$artifactFile = Join-Path $artifactDir "anticodex-probe-tool.mjs"
$marker = "REAL_WORK_MARKER_$stamp"

function Add-Failure { param([string]$Message) $failures.Add($Message) | Out-Null }

function Save-Report {
    param($Payload)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $json = $Payload | ConvertTo-Json -Depth 14 -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $ReportRoot "latest-real-work.json"), $json, $utf8NoBom)
    [System.IO.File]::WriteAllText((Join-Path $ReportRoot "$stamp-real-work.json"), $json, $utf8NoBom)
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
    return Invoke-RestMethod `
        -Uri "$BaseUrl/v1/responses" `
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
            if ($content.type -eq "output_text" -and $content.text) { [string]$content.text }
        }
    }
    return ($parts -join "`n").Trim()
}

function Read-ToolArguments {
    param($Call)
    if (-not $Call -or -not $Call.arguments) { return $null }
    try { return $Call.arguments | ConvertFrom-Json } catch { Add-Failure "MCP tool arguments are invalid JSON: $($_.Exception.Message)"; return $null }
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

try {
    New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
    $mcpExecution = $null
    $mcpMarker = "MCP_OK_$marker"
    try {
        $mcpExecution = Invoke-RealNodeReplMcpResult -Code "nodeRepl.write('$mcpMarker')" -ExpectedMarker $mcpMarker
    } catch {
        Add-Failure "real node_repl MCP execution failed: $($_.Exception.Message)"
    }

    $probeSource = "console.log(JSON.stringify({ok:true,marker:'$marker',tool:'anticodex-real-work'}));"
    $fileTool = @{
        type = "function"
        name = "create_probe_file"
        description = "Create a small local probe file for Anti-Codex real-work verification."
        parameters = @{
            type = "object"
            properties = @{
                path = @{ type = "string"; description = "Absolute file path to create." }
                content = @{ type = "string"; description = "Exact file content." }
                marker = @{ type = "string"; description = "Verification marker." }
            }
            required = @("path", "content", "marker")
            additionalProperties = $false
        }
    }

    $first = Invoke-AntiCodexResponse @{
        model = $model
        stream = $false
        store = $true
        tool_choice = "required"
        tools = @($fileTool)
        input = @(@{
            type = "message"
            role = "user"
            content = @(@{
                type = "input_text"
                text = "请调用 create_probe_file 工具恰好一次来创建探针文件。工具结果返回前不要用自然语言回答。path 使用 '$artifactFile'，marker 使用 '$marker'，content 必须完全使用以下内容：$probeSource"
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
    if ($arguments -and [string]$arguments.content -ne $probeSource) {
        Add-Failure "create_probe_file content mismatch"
    }

    $probeRun = $null
    if ($arguments -and [string]$arguments.path -and [string]$arguments.content) {
        New-Item -ItemType Directory -Path (Split-Path -Parent ([string]$arguments.path)) -Force | Out-Null
        [IO.File]::WriteAllText([string]$arguments.path, [string]$arguments.content, [Text.Encoding]::UTF8)
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
    $finalText = ""
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
    Write-Error ("Anti-Codex real work verification failed: " + $_.Exception.Message)
    exit 1
} finally {
    Exit-AntiCodexRealTrafficLock $lock
}
