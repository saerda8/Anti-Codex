[CmdletBinding()]
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

function Test-RouteAtOrAfter {
    param($Route, [DateTime]$FloorAt)

    if ($FloorAt -eq [DateTime]::MinValue) {
        return $true
    }
    if (-not $Route -or -not [string]$Route.at) {
        return $false
    }
    try {
        return ([DateTime]::Parse([string]$Route.at).ToUniversalTime() -ge $FloorAt.ToUniversalTime())
    } catch {
        return $false
    }
}

function Assert-Route {
    param([string]$ExpectedModel, [string]$Stage, [string]$ResponseId = "", [DateTime]$RouteFloorAt = [DateTime]::MinValue)

    try {
        $routePayload = Invoke-LocalJson "/anticodex/model-routes"
        $route = $null
        $matchMode = ""
        if ($ResponseId -and $routePayload.entries) {
            $route = @($routePayload.entries | Where-Object {
                $_.requestId -eq $ResponseId -and (Test-RouteAtOrAfter $_ $RouteFloorAt)
            }) | Select-Object -First 1
            if ($route) { $matchMode = "requestId" }
        }

        if (-not $route -and $routePayload.entries) {
            $route = @($routePayload.entries | Where-Object {
                [string]$_.resolvedModel -eq $ExpectedModel -and (Test-RouteAtOrAfter $_ $RouteFloorAt)
            }) | Select-Object -First 1
            if ($route) { $matchMode = "expectedModel" }
        }

        if (-not $route) {
            $latest = $routePayload.latest
            if ($latest -and (Test-RouteAtOrAfter $latest $RouteFloorAt)) {
                $route = $latest
            }
            if (-not $route) {
                Add-Failure "$Stage model route audit is empty"
                return $null
            }
            $matchMode = "latest"
        }

        if ([string]$route.resolvedModel -ne $ExpectedModel) {
            Add-Failure "$Stage model route mismatch: selected=$ExpectedModel resolved=$($route.resolvedModel)"
        }
        if ($ResponseId -and $matchMode -eq "latest") {
            Add-Failure "$Stage model route: no matching entry for requestId=$ResponseId and no route for expected model=$ExpectedModel"
        }
        if (-not [string]$route.internalModel) {
            Add-Failure "$Stage model route missing internal model"
        }
        if (-not [string]$route.cascadeId) {
            Add-Failure "$Stage model route missing cascade id"
        }
        $route | Add-Member -NotePropertyName matchMode -NotePropertyValue $matchMode -Force
        return $route
    } catch {
        Add-Failure "$Stage model route audit request failed: $($_.Exception.Message)"
        return $null
    }
}

try {
    $tool = @{
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

    $first = Invoke-AntiCodexResponse @{
        model = $model
        stream = $false
        store = $true
        tool_choice = "required"
        tools = @($tool)
        input = @(
            @{
                type = "message"
                role = "user"
                content = @(
                    @{
                        type = "input_text"
                        text = "Call marker_tool exactly once with marker MARKER_731. Do not answer in prose before the tool result. Return exactly this tool markup and no prose: <tool_calls><invoke name=`"marker_tool`"><parameter name=`"marker`">MARKER_731</parameter></invoke></tool_calls>"
                    }
                )
            }
        )
    }
    $firstRoute = $null

    $call = @(Get-ResponseItems $first | Where-Object {
        $_.type -eq "function_call" -and $_.name -eq "marker_tool"
    }) | Select-Object -First 1

    if (-not $first.id) {
        Add-Failure "First response did not contain a response id."
    }
    if (-not $call -or -not $call.call_id) {
        Add-Failure "First response did not request marker_tool."
    }

    $second = $null
    $secondRoute = $null
    if ($first.id -and $call -and $call.call_id) {
        $second = Invoke-AntiCodexResponse @{
            model = $model
            stream = $false
            store = $true
            previous_response_id = [string]$first.id
            tool_choice = "auto"
            tools = @($tool)
            input = @(
                @{
                    type = "function_call_output"
                    call_id = [string]$call.call_id
                    output = "MARKER_731=42"
                },
                @{
                    type = "message"
                    role = "user"
                    content = @(
                        @{
                            type = "input_text"
                            text = "Use the completed tool result. Reply with one short sentence containing MARKER_731 and 42. Do not call the tool again."
                        }
                    )
                }
            )
        }
        $firstRoute = Assert-Route $model "first-turn" -ResponseId $first.id -RouteFloorAt $startedAt
        $secondRoute = Assert-Route $model "second-turn" -ResponseId $second.id -RouteFloorAt $startedAt
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
    if ($text -notmatch "MARKER_731" -or $text -notmatch "(^|\D)42(\D|$)") {
        Add-Failure "Second response did not preserve the marker and value."
    }
    if ($text -match "<tool_calls>|<invoke|TOOL_RESULT|ASSISTANT_TOOL_CALL") {
        Add-Failure "Second response leaked internal tool protocol markup."
    }

    $endedAt = [DateTime]::UtcNow
    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        reportName = "tool-loop"
        requestedRealTraffic = $true
        usedRealTraffic = $true
        behaviorCovered = ($failures.Count -eq 0)
        coverageKind = "real-traffic"
        failures = $failures.ToArray()
        model = $model
        elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
        first_response_id = [string]$first.id
        call_id = if ($call) { [string]$call.call_id } else { "" }
        final_text = $text
        routes = [pscustomobject]@{
            first = if ($firstRoute) {
                [pscustomobject]@{
                    requestedModel = $firstRoute.requestedModel
                    resolvedModel = $firstRoute.resolvedModel
                    displayName = $firstRoute.displayName
                    internalModel = $firstRoute.internalModel
                    cascadeId = $firstRoute.cascadeId
                    matchMode = $firstRoute.matchMode
                }
            } else { $null }
            second = if ($secondRoute) {
                [pscustomobject]@{
                    requestedModel = $secondRoute.requestedModel
                    resolvedModel = $secondRoute.resolvedModel
                    displayName = $secondRoute.displayName
                    internalModel = $secondRoute.internalModel
                    cascadeId = $secondRoute.cascadeId
                    matchMode = $secondRoute.matchMode
                }
            } else { $null }
        }
    }
    $reportPaths = New-ReportPaths "tool-loop"
    $result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
    Save-JsonReport $reportPaths $result
    $result | ConvertTo-Json -Depth 12 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Write-Error ("Anti-Codex tool loop failed: " + $_.Exception.Message)
    exit 1
}
