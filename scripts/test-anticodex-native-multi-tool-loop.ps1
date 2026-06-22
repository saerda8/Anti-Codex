[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = "Stop"
if (-not $BaseUrl) { $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1") }

$failures = New-Object System.Collections.Generic.List[string]
$startedAt = [DateTime]::UtcNow
$model = if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "gemini-3.5-flash-low" }
$markerValue = "NATIVE_MULTI_MARKER_739"
$echoValue = "NATIVE_MULTI_ECHO_284"

function Add-Failure { param([string]$Message) $failures.Add($Message) | Out-Null }
function Invoke-Response {
    param([hashtable]$Body)
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
    Invoke-RestMethod -Uri "$BaseUrl/v1/responses" -Method Post -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec $TimeoutSec -Proxy $null
}
function Get-Items { param($Response) if ($Response -and $Response.output) { @($Response.output) } else { @() } }
function Get-Call { param($Response) @(Get-Items $Response | Where-Object { $_.type -eq "function_call" }) | Select-Object -First 1 }
function Get-Text {
    param($Response)
    $parts = foreach ($item in (Get-Items $Response)) {
        if ($item.type -ne "message") { continue }
        foreach ($content in @($item.content)) {
            if ($content.type -eq "output_text" -and $content.text) { [string]$content.text }
        }
    }
    ($parts -join "`n").Trim()
}
function Get-Arguments {
    param($Call)
    if (-not $Call -or -not $Call.arguments) { return $null }
    try { [string]$Call.arguments | ConvertFrom-Json } catch { $null }
}
function Save-Report {
    param($Payload)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $json = $Payload | ConvertTo-Json -Depth 12 -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath (Join-Path $ReportRoot "latest-native-multi-tool-loop.json") -HistoryPath (Join-Path $ReportRoot "$(Get-Date -Format 'yyyyMMdd-HHmmss')-native-multi-tool-loop.json") -Json $json -Encoding $utf8NoBom
}
function New-ToolOutput {
    param($Call)
    if ($Call.name -eq "marker_tool") { return "$markerValue=99" }
    if ($Call.name -eq "echo_tool") { return "$echoValue=confirmed" }
    return "unexpected"
}

try {
    $diagnostics = Invoke-RestMethod -Uri "$BaseUrl/anticodex/diagnostics" -Proxy $null -TimeoutSec $TimeoutSec
    if ($diagnostics.toolBridge.nativeBridgeDefaultEnabled -ne $true) {
        Add-Failure "Native bridge is disabled in the running gateway. Restart Anti-Codex with ANTICODEX_NATIVE_TOOL_BRIDGE=1 before running this opt-in verifier."
        $result = [pscustomobject]@{
            ok = $false
            failures = $failures.ToArray()
            model = $model
            elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
            nativeBridgeDefaultEnabled = $diagnostics.toolBridge.nativeBridgeDefaultEnabled
        }
        Save-Report $result
        $result | ConvertTo-Json -Depth 12 -Compress
        exit 1
    }

    $markerTool = @{
        type = "function"; name = "marker_tool"; description = "Record the exact marker."
        parameters = @{ type = "object"; properties = @{ marker = @{ type = "string" } }; required = @("marker"); additionalProperties = $false }
    }
    $echoTool = @{
        type = "function"; name = "echo_tool"; description = "Echo the exact text."
        parameters = @{ type = "object"; properties = @{ text = @{ type = "string" } }; required = @("text"); additionalProperties = $false }
    }
    $tools = @($markerTool, $echoTool)

    $first = Invoke-Response @{
        model = $model; stream = $false; store = $true; tool_choice = "required"; tools = $tools
        input = @(@{ type = "message"; role = "user"; content = @(@{
            type = "input_text"
            text = "Use both available tools to record marker $markerValue and echo text $echoValue. Start with either tool and do not answer in prose."
        }) })
    }
    $firstCall = Get-Call $first
    if (-not $firstCall -or -not $firstCall.call_id) { Add-Failure "First native tool call is missing." }
    if ($firstCall -and [string]$firstCall.call_id -match "^pseudo_") { Add-Failure "First tool call is not native." }

    $remainingName = if ($firstCall.name -eq "marker_tool") { "echo_tool" } else { "marker_tool" }
    $remainingInstruction = if ($remainingName -eq "marker_tool") {
        "Now call marker_tool with marker $markerValue. Do not answer in prose."
    } else {
        "Now call echo_tool with text $echoValue. Do not answer in prose."
    }
    $second = Invoke-Response @{
        model = $model; stream = $false; store = $true; previous_response_id = [string]$first.id; tool_choice = "required"; tools = $tools
        input = @(
            @{ type = "function_call_output"; call_id = [string]$firstCall.call_id; output = (New-ToolOutput $firstCall) },
            @{ type = "message"; role = "user"; content = @(@{ type = "input_text"; text = $remainingInstruction }) }
        )
    }
    $secondCall = Get-Call $second
    if (-not $secondCall -or -not $secondCall.call_id) { Add-Failure "Second native tool call is missing." }
    if ($secondCall -and $secondCall.name -ne $remainingName) { Add-Failure "Second native tool call did not use the remaining tool." }
    if ($secondCall -and [string]$secondCall.call_id -match "^pseudo_") { Add-Failure "Second tool call is not native." }
    if ($firstCall -and $secondCall -and $firstCall.call_id -eq $secondCall.call_id) { Add-Failure "Native tool call ids are not unique." }

    $callsByName = @{}
    if ($firstCall) { $callsByName[[string]$firstCall.name] = $firstCall }
    if ($secondCall) { $callsByName[[string]$secondCall.name] = $secondCall }
    $markerArgs = Get-Arguments $callsByName["marker_tool"]
    $echoArgs = Get-Arguments $callsByName["echo_tool"]
    if (-not $markerArgs -or [string]$markerArgs.marker -ne $markerValue) { Add-Failure "marker_tool arguments were not preserved." }
    if (-not $echoArgs -or [string]$echoArgs.text -ne $echoValue) { Add-Failure "echo_tool arguments were not preserved." }

    $third = Invoke-Response @{
        model = $model; stream = $false; store = $true; previous_response_id = [string]$second.id; tool_choice = "auto"; tools = $tools
        input = @(
            @{ type = "function_call_output"; call_id = [string]$secondCall.call_id; output = (New-ToolOutput $secondCall) },
            @{ type = "message"; role = "user"; content = @(@{
                type = "input_text"
                text = "Confirm both completed results in one short sentence containing $markerValue, 99, $echoValue, and confirmed. Do not call another tool."
            }) }
        )
    }
    $finalCalls = @(Get-Items $third | Where-Object { $_.type -match "tool_call|function_call" })
    $finalText = Get-Text $third
    if ($finalCalls.Count -gt 0) { Add-Failure "Final response repeated a tool call." }
    if ($finalText -notmatch [regex]::Escape($markerValue) -or $finalText -notmatch "(^|\D)99(\D|$)") { Add-Failure "Final response lost marker result." }
    if ($finalText -notmatch [regex]::Escape($echoValue) -or $finalText -notmatch "confirmed") { Add-Failure "Final response lost echo result." }

    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0); failures = $failures.ToArray(); model = $model
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
        first_call = if ($firstCall) { [pscustomobject]@{ name = $firstCall.name; call_id = $firstCall.call_id } } else { $null }
        second_call = if ($secondCall) { [pscustomobject]@{ name = $secondCall.name; call_id = $secondCall.call_id } } else { $null }
        native_call_ids = ($firstCall -and $secondCall -and [string]$firstCall.call_id -notmatch "^pseudo_" -and [string]$secondCall.call_id -notmatch "^pseudo_")
        final_text = $finalText
    }
    Save-Report $result
    $result | ConvertTo-Json -Depth 12 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Write-Error ("Anti-Codex native multi-tool loop failed: " + $_.Exception.Message)
    exit 1
}
