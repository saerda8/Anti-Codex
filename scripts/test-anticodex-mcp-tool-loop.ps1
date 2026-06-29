param(
    [string]$BaseUrl = "",
    [string]$InstallRoot = $(if ($env:DEEPCODEX_INSTALL_ROOT) { $env:DEEPCODEX_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Anti-Codex" }),
    [string]$StateRoot = $(if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}
$failures = New-Object System.Collections.Generic.List[string]
$startedAt = [DateTime]::UtcNow
$model = if ($env:ANTICODEX_TEST_MODEL) {
    $env:ANTICODEX_TEST_MODEL
} else {
    "gemini-3.5-flash-low"
}
$marker = "MCP_NODE_REPL_417"

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Invoke-AntiCodexResponse {
    param([hashtable]$Body)

    $json = $Body | ConvertTo-Json -Depth 24 -Compress
    try {
        return Invoke-RestMethod `
            -Uri "$BaseUrl/v1/responses" `
            -Method Post `
            -ContentType "application/json; charset=utf-8" `
            -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
            -TimeoutSec $TimeoutSec `
            -Proxy $null
    } catch {
        $response = $_.Exception.Response
        if ($response) {
            $stream = $response.GetResponseStream()
            if ($stream) {
                $reader = New-Object IO.StreamReader($stream)
                try {
                    $detail = $reader.ReadToEnd()
                    if ($detail) {
                        throw "Local gateway returned an error: $detail"
                    }
                } finally {
                    $reader.Dispose()
                }
            }
        }
        throw
    }
}

function Invoke-LocalJson {
    param([string]$Path)
    return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec 10
}

function Get-ResponseItems {
    param($Response)

    if ($null -eq $Response -or $null -eq $Response.output) {
        return @()
    }
    return @($Response.output)
}

function Get-ResponseText {
    param($Response)

    $parts = foreach ($item in (Get-ResponseItems $Response)) {
        if ($item.type -ne "message") {
            continue
        }
        foreach ($content in @($item.content)) {
            if ($content.type -eq "output_text" -and $content.text) {
                [string]$content.text
            }
        }
    }
    return ($parts -join "`n").Trim()
}

function New-ReportPaths {
    param([string]$Name)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    return [pscustomobject]@{
        latest = (Join-Path $ReportRoot "latest-$Name.json")
        history = (Join-Path $ReportRoot "$stamp-$Name.json")
    }
}

function Save-JsonReport {
    param($Paths, $Payload, [int]$Depth = 12)
    $json = $Payload | ConvertTo-Json -Depth $Depth -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath $Paths.latest -HistoryPath $Paths.history -Json $json -Encoding $utf8NoBom
}

function Assert-Route {
    param([string]$ExpectedModel, [string]$Stage)

    try {
        $routePayload = Invoke-LocalJson "/anticodex/model-routes"
        $route = $routePayload.latest
        if (-not $route) {
            Add-Failure "$Stage model route audit is empty"
            return $null
        }
        if ([string]$route.resolvedModel -ne $ExpectedModel) {
            Add-Failure "$Stage model route mismatch: selected=$ExpectedModel resolved=$($route.resolvedModel)"
        }
        if ([string]$route.transport -ne "cli" -and -not [string]$route.internalModel) {
            Add-Failure "$Stage model route missing internal model"
        }
        if (-not [string]$route.cascadeId) {
            Add-Failure "$Stage model route missing cascade id"
        }
        return $route
    } catch {
        Add-Failure "$Stage model route audit request failed: $($_.Exception.Message)"
        return $null
    }
}

function Read-ToolArguments {
    param($Call)

    if (-not $Call -or -not $Call.arguments) {
        return $null
    }
    try {
        return $Call.arguments | ConvertFrom-Json
    } catch {
        Add-Failure "MCP tool call arguments are not valid JSON: $($_.Exception.Message)"
        return $null
    }
}

function Resolve-NodeRuntime {
    $bundled = Join-Path $InstallRoot "codex-patched-app\resources\cua_node\bin\node.exe"
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    $node = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($node) { return $node.Source }
    throw "node.exe not found"
}

function Invoke-RealNodeReplMcpResult {
    param(
        [string]$Code,
        [string]$ExpectedMarker
    )

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
    if ($exitCode -ne 0) {
        throw "real MCP node_repl call failed: $text"
    }
    $parsed = $text | ConvertFrom-Json
    if (-not $parsed.ok -or -not $parsed.markerObserved -or -not $parsed.text) {
        throw "real MCP node_repl call did not return the expected marker"
    }
    return $parsed
}

try {
    $namespaceTool = @{
        type = "namespace"
        name = "mcp__node_repl__"
        tools = @(
            @{
                type = "function"
                name = "js"
                description = "Run JavaScript in the node_repl MCP server."
                parameters = @{
                    type = "object"
                    properties = @{
                        code = @{
                            type = "string"
                            description = "JavaScript source to execute."
                        }
                    }
                    required = @("code")
                    additionalProperties = $false
                }
            }
        )
    }

    $expectedCode = "nodeRepl.write('$marker=42')"
    $first = Invoke-AntiCodexResponse @{
        model = $model
        stream = $false
        store = $true
        tool_choice = "required"
        tools = @($namespaceTool)
        input = @(
            @{
                type = "message"
                role = "user"
                content = @(
                    @{
                        type = "input_text"
                        text = "Call the node_repl MCP js tool exactly once. Do not answer in prose before the tool result. Return exactly this tool markup and no prose: <tool_calls><invoke name=`"mcp__node_repl__js`"><parameter name=`"code`">$expectedCode</parameter></invoke></tool_calls>"
                    }
                )
            }
        )
    }
    $firstRoute = Assert-Route $model "first-turn"

    $call = @(Get-ResponseItems $first | Where-Object {
        $_.type -eq "function_call" -and $_.name -eq "js"
    }) | Select-Object -First 1

    if (-not $first.id) {
        Add-Failure "First response did not contain a response id."
    }
    if (-not $call -or -not $call.call_id) {
        Add-Failure "First response did not emit Codex MCP subtool function_call name=js."
    }
    $arguments = Read-ToolArguments $call
    if ($arguments -and [string]$arguments.code -ne $expectedCode) {
        Add-Failure "MCP js call code mismatch: '$($arguments.code)'"
    }

    $second = $null
    $secondRoute = $null
    $realMcpResult = $null
    $actualMcpOutput = ""
    if ($arguments -and [string]$arguments.code) {
        try {
            $realMcpResult = Invoke-RealNodeReplMcpResult -Code ([string]$arguments.code) -ExpectedMarker $marker
            $actualMcpOutput = [string]$realMcpResult.text
        } catch {
            Add-Failure "Real node_repl MCP result failed: $($_.Exception.Message)"
        }
    }

    if ($first.id -and $call -and $call.call_id -and $actualMcpOutput) {
        $second = Invoke-AntiCodexResponse @{
            model = $model
            stream = $false
            store = $true
            previous_response_id = [string]$first.id
            tool_choice = "auto"
            tools = @($namespaceTool)
            input = @(
                @{
                    type = "function_call_output"
                    call_id = [string]$call.call_id
                    output = $actualMcpOutput
                },
                @{
                    type = "message"
                    role = "user"
                    content = @(
                        @{
                            type = "input_text"
                            text = "Use the completed MCP node_repl js result. Reply with one short sentence containing $marker and 42. Do not call any tool again."
                        }
                    )
                }
            )
        }
        $secondRoute = Assert-Route $model "second-turn"
    }

    $secondCalls = @(Get-ResponseItems $second | Where-Object {
        $_.type -eq "function_call" -or $_.type -eq "custom_tool_call"
    })
    $text = Get-ResponseText $second

    if ($secondCalls.Count -ne 0) {
        Add-Failure "Second response repeated a tool call."
    }
    if (-not $text) {
        Add-Failure "Second response did not contain assistant text."
    }
    if ($text -notmatch $marker -or $text -notmatch "(^|\D)42(\D|$)") {
        Add-Failure "Second response did not preserve the MCP marker and value."
    }
    if ($text -match "<tool_calls>|<invoke|mcp__node_repl__js|ASSISTANT_TOOL_CALL") {
        Add-Failure "Second response leaked internal MCP tool protocol markup."
    }

    $endedAt = [DateTime]::UtcNow
    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        reportName = "mcp-tool-loop"
        requestedRealTraffic = $true
        usedRealTraffic = $true
        behaviorCovered = ($failures.Count -eq 0)
        coverageKind = "real-traffic"
        failures = $failures.ToArray()
        model = $model
        elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
        first_response_id = [string]$first.id
        call_id = if ($call) { [string]$call.call_id } else { "" }
        tool = [pscustomobject]@{
            namespace = "mcp__node_repl__"
            emittedName = if ($call) { [string]$call.name } else { "" }
            expectedFlattenedName = "mcp__node_repl__js"
            code = if ($arguments) { [string]$arguments.code } else { "" }
            realMcp = if ($realMcpResult) {
                [pscustomobject]@{
                    ok = [bool]$realMcpResult.ok
                    tool = [string]$realMcpResult.toolName
                    markerObserved = [bool]$realMcpResult.markerObserved
                    toolCount = [int]$realMcpResult.toolCount
                    elapsedMs = [int]$realMcpResult.elapsedMs
                    output = [string]$realMcpResult.text
                }
            } else { $null }
        }
        final_text = $text
        routes = [pscustomobject]@{
            first = if ($firstRoute) {
                [pscustomobject]@{
                    requestedModel = $firstRoute.requestedModel
                    resolvedModel = $firstRoute.resolvedModel
                    displayName = $firstRoute.displayName
                    internalModel = $firstRoute.internalModel
                    cascadeId = $firstRoute.cascadeId
                }
            } else { $null }
            second = if ($secondRoute) {
                [pscustomobject]@{
                    requestedModel = $secondRoute.requestedModel
                    resolvedModel = $secondRoute.resolvedModel
                    displayName = $secondRoute.displayName
                    internalModel = $secondRoute.internalModel
                    cascadeId = $secondRoute.cascadeId
                }
            } else { $null }
        }
    }
    $reportPaths = New-ReportPaths "mcp-tool-loop"
    $result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
    Save-JsonReport $reportPaths $result
    $result | ConvertTo-Json -Depth 12 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Write-Error ("Anti-Codex MCP tool loop failed: " + $_.Exception.Message)
    exit 1
}


