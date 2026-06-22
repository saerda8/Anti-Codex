[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [int]$TimeoutSec = 90,
    [string]$FirstModel = "",
    [string]$SecondModel = ""
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]
$marker = "MODEL_SWITCH_HISTORY_$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Invoke-LocalJson {
    param([string]$Path, [int]$RequestTimeoutSec = $TimeoutSec)
    return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $RequestTimeoutSec
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
                $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
                try {
                    $detail = $reader.ReadToEnd()
                    if ($detail) { throw "Local gateway returned an error: $detail" }
                } finally {
                    $reader.Dispose()
                }
            }
        }
        throw
    }
}

function Get-ResponseText {
    param($Response)
    $parts = foreach ($item in @($Response.output)) {
        if ($item.type -ne "message") { continue }
        foreach ($content in @($item.content)) {
            if ($content.type -eq "output_text" -and $content.text) {
                [string]$content.text
            }
        }
    }
    return ($parts -join "`n").Trim()
}

function New-UserInput {
    param([string]$Text)
    $items = @(
        @{
            type = "message"
            role = "user"
            content = @(
                @{
                    type = "input_text"
                    text = $Text
                }
            )
        }
    )
    return ,$items
}

$health = $null
$modelsPayload = $null
$models = @()
$first = $null
$second = $null
$firstText = ""
$secondText = ""
$route = $null
$skipped = $false
$skipReason = ""

try {
    $health = Invoke-LocalJson "/health"
    if ($health.ok -ne $true) { Add-Failure "health ok=false" }
} catch {
    Add-Failure "health request failed: $($_.Exception.Message)"
}

try {
    $modelsPayload = Invoke-LocalJson "/models"
    $models = @($modelsPayload.data | ForEach-Object { [string]$_.id } | Where-Object { $_ })
    if ($models.Count -lt 1) {
        Add-Failure "/models returned no usable model ids"
    }
} catch {
    Add-Failure "models request failed: $($_.Exception.Message)"
}

if ($failures.Count -eq 0) {
    if (-not $FirstModel) { $FirstModel = [string]$models[0] }
    if (-not $SecondModel) {
        $SecondModel = [string](@($models | Where-Object { $_ -ne $FirstModel }) | Select-Object -First 1)
    }
    if (-not $SecondModel) {
        $skipped = $true
        $skipReason = "Only one model is visible; model-switch history verification needs at least two models."
    }
}

if (($failures.Count -eq 0) -and (-not $skipped)) {
    try {
        $first = Invoke-AntiCodexResponse @{
            model = $FirstModel
            stream = $false
            store = $true
            tools = @()
            tool_choice = "none"
            input = New-UserInput "Remember the exact marker $marker. Reply with only that exact marker."
        }
        $firstText = Get-ResponseText $first
        if (-not $first.id) {
            Add-Failure "first response did not include an id"
        }
        if ($firstText -notmatch [regex]::Escape($marker)) {
            Add-Failure "first response did not echo the marker"
        }
        if ($firstText -match "DeepCodex") {
            Add-Failure "first response leaked the legacy DeepCodex brand"
        }
    } catch {
        Add-Failure "first model request failed: $($_.Exception.Message)"
    }
}

if (($failures.Count -eq 0) -and (-not $skipped)) {
    try {
        $second = Invoke-AntiCodexResponse @{
            model = $SecondModel
            previous_response_id = [string]$first.id
            stream = $false
            store = $true
            tools = @()
            tool_choice = "none"
            input = New-UserInput "Continue the same conversation after switching models. What exact marker did I ask you to remember? Reply with only the exact marker."
        }
        $secondText = Get-ResponseText $second
        if (-not $second.id) {
            Add-Failure "second response did not include an id"
        }
        if ($secondText -notmatch [regex]::Escape($marker)) {
            Add-Failure "second response did not preserve previous_response_id history after model switch"
        }
        if ($secondText -match "DeepCodex") {
            Add-Failure "second response leaked the legacy DeepCodex brand"
        }
    } catch {
        Add-Failure "second model request failed: $($_.Exception.Message)"
    }
}

if (($failures.Count -eq 0) -and (-not $skipped)) {
    try {
        $routes = Invoke-LocalJson "/anticodex/model-routes" 8
        $route = $routes.latest
        if (-not $route) {
            Add-Failure "model route audit missing latest route after model switch"
        } elseif ([string]$route.requestedModel -ne $SecondModel) {
            Add-Failure "model route audit did not record the switched model: requested=$($route.requestedModel) expected=$SecondModel"
        }
    } catch {
        Add-Failure "model route audit failed: $($_.Exception.Message)"
    }
}

$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    skipped = $skipped
    reason = $skipReason
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    marker = $marker
    firstModel = $FirstModel
    secondModel = $SecondModel
    modelCount = @($models).Count
    firstResponseId = if ($first) { $first.id } else { $null }
    secondResponseId = if ($second) { $second.id } else { $null }
    firstText = $firstText
    secondText = $secondText
    route = $route
}

Write-Output ($result | ConvertTo-Json -Depth 12 -Compress)
if ($failures.Count -gt 0) { exit 1 }
