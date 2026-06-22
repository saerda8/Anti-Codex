param(
    [string]$BaseUrl = "",
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
$markerValue = "PARALLEL_881"
$echoValue = "ECHO_DATA_42"

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Invoke-AntiCodexResponse {
    param([hashtable]$Body)

    $json = $Body | ConvertTo-Json -Depth 20 -Compress
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

function Get-CallArguments {
    param($Call)

    if (-not $Call -or -not $Call.arguments) {
        return $null
    }
    try {
        return ([string]$Call.arguments | ConvertFrom-Json)
    } catch {
        Add-Failure "Could not parse arguments for $($Call.name): $($_.Exception.Message)"
        return $null
    }
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
    [System.IO.File]::WriteAllText($Paths.latest, $json, $utf8NoBom)
    [System.IO.File]::WriteAllText($Paths.history, $json, $utf8NoBom)
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
        if (-not [string]$route.internalModel) {
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

try {
    $markerTool = @{
        type = "function"
        name = "marker_tool"
        description = "Return a deterministic marker value for an Anti-Codex transport test."
        parameters = @{
            type = "object"
            properties = @{
                marker = @{
                    type = "string"
                    description = "The marker requested by the user."
                }
            }
            required = @("marker")
            additionalProperties = $false
        }
    }

    $echoTool = @{
        type = "function"
        name = "echo_tool"
        description = "Echo back the provided text verbatim."
        parameters = @{
            type = "object"
            properties = @{
                text = @{
                    type = "string"
                    description = "The text to echo back."
                }
            }
            required = @("text")
            additionalProperties = $false
        }
    }

    $first = Invoke-AntiCodexResponse @{
        model = $model
        stream = $false
        store = $true
        tool_choice = "required"
        tools = @($markerTool, $echoTool)
        input = @(
            @{
                type = "message"
                role = "user"
                content = @(
                    @{
                        type = "input_text"
                        text = "Call marker_tool with marker $markerValue AND echo_tool with text $echoValue both at the same time. Do not answer in prose before the tool results. Return exactly this tool markup and no prose: <tool_calls><invoke name=`"marker_tool`"><parameter name=`"marker`">$markerValue</parameter></invoke><invoke name=`"echo_tool`"><parameter name=`"text`">$echoValue</parameter></invoke></tool_calls>"
                    }
                )
            }
        )
    }
    $firstRoute = Assert-Route $model "first-turn"

    $calls = @(Get-ResponseItems $first | Where-Object {
        $_.type -eq "function_call"
    })

    $markerCall = @($calls | Where-Object { $_.name -eq "marker_tool" }) | Select-Object -First 1
    $echoCall = @($calls | Where-Object { $_.name -eq "echo_tool" }) | Select-Object -First 1

    if (-not $first.id) {
        Add-Failure "First response did not contain a response id."
    }
    if ($calls.Count -ne 2) {
        Add-Failure "First response did not return exactly two function_calls (got $($calls.Count))."
    }
    if (-not $markerCall -or -not $markerCall.call_id) {
        Add-Failure "First response did not request marker_tool."
    }
    if (-not $echoCall -or -not $echoCall.call_id) {
        Add-Failure "First response did not request echo_tool."
    }
    if ($markerCall -and $echoCall -and $markerCall.call_id -eq $echoCall.call_id) {
        Add-Failure "marker_tool and echo_tool call_id values are not unique."
    }
    $markerArguments = Get-CallArguments $markerCall
    $echoArguments = Get-CallArguments $echoCall
    if ($markerArguments -and [string]$markerArguments.marker -ne $markerValue) {
        Add-Failure "marker_tool arguments did not preserve the requested marker."
    }
    if ($echoArguments -and [string]$echoArguments.text -ne $echoValue) {
        Add-Failure "echo_tool arguments did not preserve the requested text."
    }

    $second = $null
    $secondRoute = $null
    if ($first.id -and $markerCall -and $markerCall.call_id -and $echoCall -and $echoCall.call_id) {
        $second = Invoke-AntiCodexResponse @{
            model = $model
            stream = $false
            store = $true
            previous_response_id = [string]$first.id
            tool_choice = "auto"
            tools = @($markerTool, $echoTool)
            input = @(
                @{
                    type = "function_call_output"
                    call_id = [string]$echoCall.call_id
                    output = "$echoValue=confirmed"
                },
                @{
                    type = "function_call_output"
                    call_id = [string]$markerCall.call_id
                    output = "$markerValue=99"
                },
                @{
                    type = "message"
                    role = "user"
                    content = @(
                        @{
                            type = "input_text"
                            text = "Use both completed tool results. Reply with one short sentence containing $markerValue, 99, $echoValue, and confirmed. Do not call any tool again."
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
    if ($text -notmatch $markerValue -or $text -notmatch "(^|\D)99(\D|$)") {
        Add-Failure "Second response did not preserve marker_tool marker and value."
    }
    if ($text -notmatch $echoValue -or $text -notmatch "confirmed") {
        Add-Failure "Second response did not preserve echo_tool text and confirmation."
    }
    if ($text -match "<tool_calls>|<invoke|TOOL_RESULT|ASSISTANT_TOOL_CALL") {
        Add-Failure "Second response leaked internal tool protocol markup."
    }

    $endedAt = [DateTime]::UtcNow
    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        failures = $failures.ToArray()
        model = $model
        elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
        first_response_id = [string]$first.id
        marker_call_id = if ($markerCall) { [string]$markerCall.call_id } else { "" }
        echo_call_id = if ($echoCall) { [string]$echoCall.call_id } else { "" }
        tool_count = $calls.Count
        call_ids_unique = ($markerCall -and $echoCall -and $markerCall.call_id -ne $echoCall.call_id)
        outputs_returned_in_reverse_order = $true
        arguments_preserved = (
            $markerArguments -and
            $echoArguments -and
            [string]$markerArguments.marker -eq $markerValue -and
            [string]$echoArguments.text -eq $echoValue
        )
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
    $reportPaths = New-ReportPaths "parallel-tool-loop"
    $result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
    Save-JsonReport $reportPaths $result
    $result | ConvertTo-Json -Depth 12 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Write-Error ("Anti-Codex parallel tool loop failed: " + $_.Exception.Message)
    exit 1
}


