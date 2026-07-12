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

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "anticodex-mini-tool-$stamp"
$artifactFile = Join-Path $tempDir "text-stats-cli.js"
$inputFile = Join-Path $tempDir "input.txt"
$marker = "MINI_TOOL_MARKER_$stamp"

$inputText = "hello world`nhello world`nanticodex real mini tool test"

function Add-Failure { param([string]$Message) $failures.Add($Message) | Out-Null }

function Save-Report {
    param($Payload)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $json = $Payload | ConvertTo-Json -Depth 14 -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath (Join-Path $ReportRoot "latest-real-mini-tool.json") -HistoryPath (Join-Path $ReportRoot "$stamp-real-mini-tool.json") -Json $json -Encoding $utf8NoBom
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

function Invoke-MiniToolCLI {
    param([string]$CliPath, [string]$InputFilePath)

    $node = Resolve-NodeRuntime
    $output = & $node $CliPath $InputFilePath 2>&1
    $exitCode = $LASTEXITCODE
    $text = (@($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
    if ($exitCode -ne 0) { throw "Generated CLI tool exited with code $exitCode`: $text" }
    return $text | ConvertFrom-Json
}

if (-not $AllowRealTraffic) {
    Complete-Skipped "real mini tool verification is opt-in; rerun with -AllowRealTraffic"
}

$lock = Enter-AntiCodexRealTrafficLock -WaitSeconds 0
if (-not $lock.acquired) {
    Complete-Skipped "another Anti-Codex real Antigravity verification is already running"
}

$cliResult = $null
$first = $null
$call = $null
$second = $null
$finalText = ""

try {
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    $cliSource = @"
const fs = require("node:fs");
const input = fs.readFileSync(process.argv[2], "utf8");
const lines = input.length === 0 ? 0 : input.split(/\r?\n/).length;
const trimmed = input.trim();
const words = trimmed ? trimmed.split(/\s+/).length : 0;
console.log(JSON.stringify({ lines, words, chars: input.length, marker: "$marker" }));
"@

    $miniToolDef = @{
        type = "function"
        name = "create_mini_tool"
        description = "Create the fixed Anti-Codex text statistics CLI at the requested temporary path."
        parameters = @{
            type = "object"
            properties = @{
                path = @{ type = "string"; description = "The absolute file path where the Node.js CLI tool should be saved." }
                marker = @{ type = "string"; description = "The verification marker string that the CLI tool must output in JSON." }
            }
            required = @("path", "marker")
            additionalProperties = $false
        }
    }

    $promptText = "请调用 create_mini_tool 工具恰好一次，path 使用 '$artifactFile'，marker 使用 '$marker'。工具结果返回前不要用自然语言回答。"

    $first = Invoke-AntiCodexResponse @{
        model = $model
        stream = $false
        store = $true
        tool_choice = "required"
        tools = @($miniToolDef)
        input = @(@{
            type = "message"
            role = "user"
            content = @(@{
                type = "input_text"
                text = $promptText
            })
        })
    }

    $call = @(Get-ResponseItems $first | Where-Object { $_.type -eq "function_call" -and $_.name -eq "create_mini_tool" }) | Select-Object -First 1
    if (-not $first.id) { Add-Failure "first response did not contain an id" }
    if (-not $call -or -not $call.call_id) { Add-Failure "first response did not emit create_mini_tool function_call" }
    
    $arguments = Read-ToolArguments $call
    if ($arguments) {
        if ([string]$arguments.path -ne $artifactFile) {
            Add-Failure "create_mini_tool path mismatch: expected '$artifactFile', got '$($arguments.path)'"
        }
        if ([string]$arguments.marker -ne $marker) {
            Add-Failure "create_mini_tool marker mismatch: expected '$marker', got '$($arguments.marker)'"
        }
        if ([string]$arguments.path -eq $artifactFile -and [string]$arguments.marker -eq $marker) {
            [IO.File]::WriteAllText($artifactFile, $cliSource, [Text.Encoding]::UTF8)
            if (-not (Test-Path -LiteralPath $artifactFile -PathType Leaf)) {
                Add-Failure "generated CLI file was not created"
            } else {
                [IO.File]::WriteAllBytes($inputFile, [Text.Encoding]::UTF8.GetBytes($inputText))
                try {
                    $cliResult = Invoke-MiniToolCLI $artifactFile $inputFile
                    if (-not $cliResult) {
                        Add-Failure "CLI tool execution yielded empty output"
                    } else {
                        if ($cliResult.lines -ne 3) {
                            Add-Failure "CLI output lines count mismatch: expected 3, got $($cliResult.lines)"
                        }
                        if ($cliResult.words -ne 9) {
                            Add-Failure "CLI output words count mismatch: expected 9, got $($cliResult.words)"
                        }
                        if ($cliResult.chars -ne 53) {
                            Add-Failure "CLI output chars count mismatch: expected 53, got $($cliResult.chars)"
                        }
                        if ($cliResult.marker -ne $marker) {
                            Add-Failure "CLI output marker mismatch: expected '$marker', got '$($cliResult.marker)'"
                        }
                    }
                } catch {
                    Add-Failure "Failed to execute CLI tool or parse JSON: $($_.Exception.Message)"
                }
            }
        }
    }

    if ($call -and $call.call_id) {
        $miniToolOutput = [ordered]@{
            ok = $null -ne $cliResult
            status = if ($cliResult) { "executed" } else { "failed" }
            path = $artifactFile
            marker = $marker
            confirmation = "CLI_OK $marker"
            result = $cliResult
        }
        $second = Invoke-AntiCodexResponse @{
            model = $model
            stream = $false
            store = $true
            previous_response_id = [string]$first.id
            input = @(
                @{ type = "function_call_output"; call_id = [string]$call.call_id; output = ($miniToolOutput | ConvertTo-Json -Depth 8 -Compress) },
                @{ type = "message"; role = "user"; content = @(@{
                    type = "input_text"
                    text = "工具输出已经是执行器完成文件写入和 CLI 运行后的最终结果，无需读取文件或目录。请用中文一句话确认小工具执行成功，必须包含 CLI_OK 和 $marker，不要再次调用工具。"
                }) }
            )
        }
        $finalCalls = @(Get-ResponseItems $second | Where-Object { $_.type -match "tool_call|function_call" })
        $finalText = Get-ResponseText $second
        if ($finalCalls.Count -gt 0) { Add-Failure "final response repeated a tool call" }
        if ($finalText -notmatch "CLI_OK" -or $finalText -notmatch [regex]::Escape($marker)) {
            Add-Failure "final response did not confirm the CLI execution and marker"
        }
        if ($finalText -notmatch "^\s*[\u4e00-\u9fff]") {
            Add-Failure "final response did not begin in Chinese"
        }
        if ($finalText -match "model did not produce a reliable summary|Completed tool result:|\{\s*`"ok`"\s*:") {
            Add-Failure "final response exposed raw tool fallback"
        }
        if ($finalText -match "DeepCodex") {
            Add-Failure "final response leaked the legacy DeepCodex brand"
        }
    }

    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        reportName = "real-mini-tool"
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
            directory = $tempDir
            file = $artifactFile
            exists = Test-Path -LiteralPath $artifactFile -PathType Leaf
            ran = $null -ne $cliResult
            markerMatched = if ($cliResult) { [string]$cliResult.marker -eq $marker } else { $false }
        }
        executor = [pscustomobject]@{
            tool = "create_mini_tool"
            realFileWrite = Test-Path -LiteralPath $artifactFile -PathType Leaf
        }
        final_text = $finalText
    }
    Save-Report $result
    $result | ConvertTo-Json -Depth 14 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    $message = $_.Exception.Message
    Add-Failure "real mini tool verification exception: $message"
    $result = [pscustomobject]@{
        ok = $false
        reportName = "real-mini-tool"
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
            directory = $tempDir
            file = $artifactFile
            exists = Test-Path -LiteralPath $artifactFile -PathType Leaf
            ran = $null -ne $cliResult
            markerMatched = if ($cliResult) { [string]$cliResult.marker -eq $marker } else { $false }
        }
        executor = [pscustomobject]@{
            tool = "create_mini_tool"
            realFileWrite = Test-Path -LiteralPath $artifactFile -PathType Leaf
        }
        final_text = $finalText
        error = $message
    }
    Save-Report $result
    $result | ConvertTo-Json -Depth 14 -Compress
    Write-Error ("Anti-Codex real mini tool verification failed: " + $message)
    exit 1
} finally {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Exit-AntiCodexRealTrafficLock $lock
}
