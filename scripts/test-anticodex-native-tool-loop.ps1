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
$model = if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "gemini-3.5-flash-low" }
$marker = "NATIVE_MARKER_8462"

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function ConvertFrom-JsonEscapedString {
    param([string]$Text)
    return ('"' + ($Text -replace '"', '\"') + '"') | ConvertFrom-Json
}

function Invoke-AntiCodexResponse {
    param([hashtable]$Body)
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
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
    if ($null -eq $Response -or $null -eq $Response.output) { return @() }
    return @($Response.output)
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

function Save-Report {
    param($Payload)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $json = $Payload | ConvertTo-Json -Depth 12 -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $ReportRoot "latest-native-tool-loop.json"), $json, $utf8NoBom)
    [System.IO.File]::WriteAllText((Join-Path $ReportRoot "$(Get-Date -Format 'yyyyMMdd-HHmmss')-native-tool-loop.json"), $json, $utf8NoBom)
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

    $tool = @{
        type = "function"
        name = "anticodex_native_marker"
        description = "Record the exact marker requested by the user."
        parameters = @{
            type = "object"
            properties = @{
                marker = @{ type = "string"; description = "The exact marker to record." }
            }
            required = @("marker")
            additionalProperties = $false
        }
    }

    $firstPrompt = (ConvertFrom-JsonEscapedString "\u8bf7\u8c03\u7528 anticodex_native_marker \u5de5\u5177\u6070\u597d\u4e00\u6b21\u6765\u8bb0\u5f55 ") +
        $marker +
        (ConvertFrom-JsonEscapedString "\u3002\u5de5\u5177\u7ed3\u679c\u8fd4\u56de\u524d\u4e0d\u8981\u7528\u81ea\u7136\u8bed\u8a00\u56de\u7b54\u3002")
    $secondPrompt = (ConvertFrom-JsonEscapedString "\u8bf7\u7528\u4e2d\u6587\u4e00\u53e5\u8bdd\u786e\u8ba4\u539f\u751f\u5de5\u5177\u7ed3\u679c\u5df2\u7ecf\u5b8c\u6210\uff0c\u5fc5\u987b\u5305\u542b ") +
        $marker +
        (ConvertFrom-JsonEscapedString " \u548c RECORDED\uff0c\u4e0d\u8981\u518d\u6b21\u8c03\u7528\u5de5\u5177\uff0c\u4e5f\u4e0d\u8981\u51fa\u73b0 DeepCodex\u3002")

    $first = Invoke-AntiCodexResponse @{
        model = $model
        stream = $false
        store = $true
        tool_choice = "required"
        tools = @($tool)
        input = @(@{
            type = "message"
            role = "user"
            content = @(@{
                type = "input_text"
                text = $firstPrompt
            })
        })
    }

    $call = @(Get-ResponseItems $first | Where-Object {
        $_.type -eq "function_call" -and $_.name -eq "anticodex_native_marker"
    }) | Select-Object -First 1

    if (-not $call) {
        Add-Failure "Antigravity did not return the native marker tool call."
    } elseif (-not $call.call_id) {
        Add-Failure "Native marker tool call has no call_id."
    } elseif ([string]$call.call_id -match "^pseudo_") {
        Add-Failure "Tool call used a pseudo call_id instead of a native Antigravity call_id."
    }

    $arguments = $null
    if ($call -and $call.arguments) {
        try { $arguments = [string]$call.arguments | ConvertFrom-Json } catch {
            Add-Failure "Native marker tool arguments are not valid JSON."
        }
    }
    if (-not $arguments -or [string]$arguments.marker -ne $marker) {
        Add-Failure "Native marker tool did not preserve the requested marker."
    }

    $second = $null
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
                    output = "$marker=RECORDED"
                },
                @{
                    type = "message"
                    role = "user"
                    content = @(@{
                        type = "input_text"
                        text = $secondPrompt
                    })
                }
            )
        }
    }

    $secondCalls = @(Get-ResponseItems $second | Where-Object { $_.type -match "tool_call|function_call" })
    $finalText = Get-ResponseText $second
    if ($secondCalls.Count -gt 0) { Add-Failure "Continuation repeated a tool call." }
    if ($finalText -notmatch [regex]::Escape($marker) -or $finalText -notmatch "RECORDED") {
        Add-Failure "Continuation did not preserve the native tool result."
    }
    if ($finalText -notmatch "[\u4e00-\u9fff]") {
        Add-Failure "Continuation did not answer the Chinese request in Chinese."
    }
    if ($finalText -match "DeepCodex|Deep Codex") {
        Add-Failure "Continuation leaked the legacy DeepCodex brand."
    }

    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        failures = $failures.ToArray()
        model = $model
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
        response_id = [string]$first.id
        call_id = if ($call) { [string]$call.call_id } else { "" }
        native_call_id = if ($call) { ([string]$call.call_id -notmatch "^pseudo_") } else { $false }
        arguments = $arguments
        final_text = $finalText
    }
    Save-Report $result
    $result | ConvertTo-Json -Depth 12 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Write-Error ("Anti-Codex native tool loop failed: " + $_.Exception.Message)
    exit 1
}
