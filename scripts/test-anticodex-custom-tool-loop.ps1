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
$marker = "CUSTOM_PATCH_519"
$patchBody = "*** Begin Patch`n*** Add File: tmp/anticodex_custom_tool_probe.txt`n+$marker`n*** End Patch"

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
    $customTool = @{
        type = "custom"
        name = "apply_patch"
        description = "Apply a freeform patch."
        format = @{
            type = "grammar"
            syntax = "lark"
            definition = "start: /.+/"
        }
    }

    $first = Invoke-AntiCodexResponse @{
        model = $model
        stream = $false
        store = $true
        tool_choice = "required"
        tools = @($customTool)
        input = @(
            @{
                type = "message"
                role = "user"
                content = @(
                    @{
                        type = "input_text"
                        text = "Call apply_patch exactly once with the complete patch body below. Do not answer in prose before the tool result. Return exactly this tool markup and no prose: <tool_calls><invoke name=`"apply_patch`"><parameter name=`"content`">$patchBody</parameter></invoke></tool_calls>"
                    }
                )
            }
        )
    }
    $firstRoute = Assert-Route $model "first-turn"

    $call = @(Get-ResponseItems $first | Where-Object {
        $_.type -eq "custom_tool_call" -and $_.name -eq "apply_patch"
    }) | Select-Object -First 1

    if (-not $first.id) {
        Add-Failure "First response did not contain a response id."
    }
    if (-not $call -or -not $call.call_id) {
        Add-Failure "First response did not emit custom_tool_call name=apply_patch."
    }
    if ($call -and [string]$call.input -ne $patchBody) {
        Add-Failure "apply_patch custom input mismatch."
    }
    if ($call -and ([string]$call.input -match "^\s*\{")) {
        Add-Failure "apply_patch custom input was not unwrapped from JSON content wrapper."
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
            tools = @($customTool)
            input = @(
                @{
                    type = "custom_tool_call_output"
                    call_id = [string]$call.call_id
                    output = "apply_patch verifier did not execute the patch; $marker would be written."
                },
                @{
                    type = "message"
                    role = "user"
                    content = @(
                        @{
                            type = "input_text"
                            text = "Use the completed custom apply_patch tool result. Reply with one short sentence containing $marker. Do not call any tool again."
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
    if ($text -notmatch $marker) {
        Add-Failure "Second response did not preserve the custom tool marker."
    }
    if ($text -match "<tool_calls>|<invoke|ASSISTANT_TOOL_CALL") {
        Add-Failure "Second response leaked internal custom tool protocol markup."
    }

    $endedAt = [DateTime]::UtcNow
    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        failures = $failures.ToArray()
        model = $model
        elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
        first_response_id = [string]$first.id
        call_id = if ($call) { [string]$call.call_id } else { "" }
        tool = [pscustomobject]@{
            type = if ($call) { [string]$call.type } else { "" }
            name = if ($call) { [string]$call.name } else { "" }
            inputPreserved = ($call -and [string]$call.input -eq $patchBody)
            marker = $marker
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
    $reportPaths = New-ReportPaths "custom-tool-loop"
    $result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
    Save-JsonReport $reportPaths $result
    $result | ConvertTo-Json -Depth 12 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Write-Error ("Anti-Codex custom tool loop failed: " + $_.Exception.Message)
    exit 1
}


