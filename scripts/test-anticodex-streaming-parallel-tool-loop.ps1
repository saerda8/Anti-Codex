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
$markerValue = "STREAM_PARALLEL_771"
$echoValue = "STREAM_ECHO_42"

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Invoke-AntiCodexStream {
    param(
        [hashtable]$Body
    )

    $request = [System.Net.WebRequest]::Create("$BaseUrl/v1/responses")
    $request.Method = "POST"
    $request.Proxy = $null
    $request.Timeout = $TimeoutSec * 1000
    $request.ReadWriteTimeout = $TimeoutSec * 1000
    $request.ContentType = "application/json; charset=utf-8"
    $response = $null
    $reader = $null
    try {
        $json = $Body | ConvertTo-Json -Depth 30 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $request.ContentLength = $bytes.Length
        $requestStream = $request.GetRequestStream()
        try {
            $requestStream.Write($bytes, 0, $bytes.Length)
        } finally {
            $requestStream.Dispose()
        }
        $response = $request.GetResponse()
        $reader = [IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8)
        $events = New-Object System.Collections.Generic.List[object]
        $eventName = ""
        $dataLines = New-Object System.Collections.Generic.List[string]

        function Add-SseEvent {
            if ($dataLines.Count -le 0) { return }
            $data = ($dataLines.ToArray() -join "`n")
            $parsed = $null
            try { $parsed = $data | ConvertFrom-Json } catch {}
            $events.Add([pscustomobject]@{ event = $eventName; data = $parsed }) | Out-Null
        }

        while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()
            if ($line -eq "") {
                Add-SseEvent
                $eventName = ""
                $dataLines.Clear()
                continue
            }
            if ($line.StartsWith("event: ")) {
                $eventName = $line.Substring(7)
            } elseif ($line.StartsWith("data: ")) {
                $dataLines.Add($line.Substring(6)) | Out-Null
            }
        }
        Add-SseEvent

        return [pscustomobject]@{ events = $events.ToArray() }
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Invoke-LocalJson {
    param([string]$Path)
    return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $TimeoutSec
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

    # ===== ROUND 1: streaming parallel function calls =====

    $firstStream = Invoke-AntiCodexStream @{
        model = $model
        stream = $true
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

    $firstRoute = Assert-Route $model "first-turn-stream"

    # Extract response.id and completed response from the SSE stream
    $completedEvent = @($firstStream.events | Where-Object { $_.event -eq "response.completed" }) | Select-Object -First 1
    $firstResponseId = if ($completedEvent -and $completedEvent.data -and $completedEvent.data.response -and $completedEvent.data.response.id) {
        [string]$completedEvent.data.response.id
    } else {
        $null
    }

    # Verify SSE function_call output_item.done events
    $sseFunctionCallEvents = @($firstStream.events | Where-Object {
        $_.event -eq "response.output_item.done" -and
        $_.data -and
        $_.data.item -and
        $_.data.item.type -eq "function_call"
    })
    $sseFunctionCalls = @($sseFunctionCallEvents | ForEach-Object { $_.data.item })

    # Verify completed response function_calls
    $completedCalls = @()
    if ($completedEvent -and $completedEvent.data -and $completedEvent.data.response -and $completedEvent.data.response.output) {
        $completedCalls = @($completedEvent.data.response.output | Where-Object {
            $_.type -eq "function_call"
        })
    }

    if (-not $firstResponseId) {
        Add-Failure "First streaming response did not contain a response id."
    }
    if ($sseFunctionCallEvents.Count -ne 2) {
        Add-Failure "First streaming SSE did not contain exactly two function_call output_item.done events (got $($sseFunctionCallEvents.Count))."
    }
    if ($completedCalls.Count -ne 2) {
        Add-Failure "First streaming completed response did not contain exactly two function_calls (got $($completedCalls.Count))."
    }
    if ($sseFunctionCalls.Count -eq 2 -and $completedCalls.Count -eq 2) {
        $sseSignatures = @($sseFunctionCalls | ForEach-Object { "$($_.name):$($_.call_id)" } | Sort-Object)
        $completedSignatures = @($completedCalls | ForEach-Object { "$($_.name):$($_.call_id)" } | Sort-Object)
        if (($sseSignatures -join "|") -ne ($completedSignatures -join "|")) {
            Add-Failure "First streaming SSE function calls did not match the completed response calls."
        }
    }

    $markerCall = @($completedCalls | Where-Object { $_.name -eq "marker_tool" }) | Select-Object -First 1
    $echoCall = @($completedCalls | Where-Object { $_.name -eq "echo_tool" }) | Select-Object -First 1

    if (-not $markerCall -or -not $markerCall.call_id) {
        Add-Failure "First streaming response did not request marker_tool."
    }
    if (-not $echoCall -or -not $echoCall.call_id) {
        Add-Failure "First streaming response did not request echo_tool."
    }
    if ($markerCall -and $echoCall -and $markerCall.call_id -eq $echoCall.call_id) {
        Add-Failure "marker_tool and echo_tool call_id values are not unique in streaming response."
    }

    $markerArguments = Get-CallArguments $markerCall
    $echoArguments = Get-CallArguments $echoCall
    if ($markerArguments -and [string]$markerArguments.marker -ne $markerValue) {
        Add-Failure "marker_tool arguments did not preserve the requested marker in streaming response."
    }
    if ($echoArguments -and [string]$echoArguments.text -ne $echoValue) {
        Add-Failure "echo_tool arguments did not preserve the requested text in streaming response."
    }

    # Verify no output_text in completed response output alongside function_calls
    $outputTextItems = @()
    if ($completedEvent -and $completedEvent.data -and $completedEvent.data.response -and $completedEvent.data.response.output) {
        $outputTextItems = @($completedEvent.data.response.output | Where-Object {
            $_.type -eq "message" -and @($_.content | Where-Object { $_.type -eq "output_text" }).Count -gt 0
        })
    }
    if ($outputTextItems.Count -gt 0) {
        Add-Failure "First streaming response leaked output_text alongside function_calls."
    }

    # Check for internal protocol leakage in SSE event data
    $allSseText = ($firstStream.events | ForEach-Object {
        if ($_.data) { $_.data | ConvertTo-Json -Depth 10 -Compress } else { "" }
    }) -join " "
    if ($allSseText -match "<tool_calls>|<invoke|TOOL_RESULT|ASSISTANT_TOOL_CALL") {
        Add-Failure "First streaming SSE leaked internal tool protocol markup."
    }

    # ===== ROUND 2: streaming with reverse-order function_call_output =====

    $secondStream = $null
    $secondRoute = $null
    if ($firstResponseId -and $markerCall -and $markerCall.call_id -and $echoCall -and $echoCall.call_id) {
        $secondStream = Invoke-AntiCodexStream @{
            model = $model
            stream = $true
            store = $true
            previous_response_id = $firstResponseId
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
        $secondRoute = Assert-Route $model "second-turn-stream"
    }

    $secondCompletedEvent = @($secondStream.events | Where-Object { $_.event -eq "response.completed" }) | Select-Object -First 1

    # Extract second response items from completed event
    $secondCalls = @()
    $secondText = ""
    if ($secondCompletedEvent -and $secondCompletedEvent.data -and $secondCompletedEvent.data.response -and $secondCompletedEvent.data.response.output) {
        $secondCalls = @($secondCompletedEvent.data.response.output | Where-Object {
            $_.type -eq "function_call" -or $_.type -eq "custom_tool_call"
        })
        $secondText = (($secondCompletedEvent.data.response.output | Where-Object { $_.type -eq "message" }) | ForEach-Object {
            @($_.content | Where-Object { $_.type -eq "output_text" } | ForEach-Object { [string]$_.text })
        }) -join "`n"
    }

    # Also check SSE events for round 2 for function_call/custom_tool_call
    $sseSecondFunctionCallEvents = @($secondStream.events | Where-Object {
        $_.event -eq "response.output_item.done" -and
        $_.data -and
        $_.data.item -and
        ($_.data.item.type -eq "function_call" -or $_.data.item.type -eq "custom_tool_call")
    })

    if ($sseSecondFunctionCallEvents.Count -ne 0) {
        Add-Failure "Second streaming SSE contained unexpected function_call or custom_tool_call events (got $($sseSecondFunctionCallEvents.Count))."
    }
    if ($secondCalls.Count -ne 0) {
        Add-Failure "Second streaming response repeated a tool call."
    }
    if (-not $secondText) {
        Add-Failure "Second streaming response did not contain assistant text."
    }
    if ($secondText -notmatch $markerValue -or $secondText -notmatch "(^|\D)99(\D|$)") {
        Add-Failure "Second streaming response did not preserve marker_tool marker and value."
    }
    if ($secondText -notmatch $echoValue -or $secondText -notmatch "confirmed") {
        Add-Failure "Second streaming response did not preserve echo_tool text and confirmation."
    }
    if ($secondText -match "<tool_calls>|<invoke|TOOL_RESULT|ASSISTANT_TOOL_CALL") {
        Add-Failure "Second streaming response leaked internal tool protocol markup."
    }

    # Verify that output_text is present in completed response
    $secondOutputTextItems = @()
    if ($secondCompletedEvent -and $secondCompletedEvent.data -and $secondCompletedEvent.data.response -and $secondCompletedEvent.data.response.output) {
        $secondOutputTextItems = @($secondCompletedEvent.data.response.output | Where-Object {
            $_.type -eq "message" -and @($_.content | Where-Object { $_.type -eq "output_text" }).Count -gt 0
        })
    }
    if ($secondOutputTextItems.Count -eq 0) {
        Add-Failure "Second streaming completed response missing output_text."
    }

    $endedAt = [DateTime]::UtcNow
    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        failures = $failures.ToArray()
        model = $model
        elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
        first_response_id = $firstResponseId
        marker_call_id = if ($markerCall) { [string]$markerCall.call_id } else { "" }
        echo_call_id = if ($echoCall) { [string]$echoCall.call_id } else { "" }
        sse_function_call_count = $sseFunctionCallEvents.Count
        completed_function_call_count = $completedCalls.Count
        sse_completed_calls_match = (
            $sseFunctionCalls.Count -eq 2 -and
            $completedCalls.Count -eq 2 -and
            (@($sseFunctionCalls | ForEach-Object { "$($_.name):$($_.call_id)" } | Sort-Object) -join "|") -eq
            (@($completedCalls | ForEach-Object { "$($_.name):$($_.call_id)" } | Sort-Object) -join "|")
        )
        call_ids_unique = ($markerCall -and $echoCall -and $markerCall.call_id -ne $echoCall.call_id)
        outputs_returned_in_reverse_order = $true
        arguments_preserved = (
            $markerArguments -and
            $echoArguments -and
            [string]$markerArguments.marker -eq $markerValue -and
            [string]$echoArguments.text -eq $echoValue
        )
        no_output_text_leak = ($outputTextItems.Count -eq 0)
        second_round_sse_function_call_events = $sseSecondFunctionCallEvents.Count
        second_round_completed_calls = $secondCalls.Count
        second_round_has_text = (-not [string]::IsNullOrEmpty($secondText))
        second_round_marker_preserved = ($secondText -match $markerValue -and $secondText -match "(^|\D)99(\D|$)")
        second_round_echo_preserved = ($secondText -match $echoValue -and $secondText -match "confirmed")
        second_round_no_protocol_leak = ($secondText -notmatch "<tool_calls>|<invoke|TOOL_RESULT|ASSISTANT_TOOL_CALL")
        second_round_has_output_text = ($secondOutputTextItems.Count -gt 0)
        final_text = $secondText
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
    $reportPaths = New-ReportPaths "streaming-parallel-tool-loop"
    $result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
    Save-JsonReport $reportPaths $result
    $result | ConvertTo-Json -Depth 12 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Write-Error ("Anti-Codex streaming parallel tool loop failed: " + $_.Exception.Message)
    exit 1
}


