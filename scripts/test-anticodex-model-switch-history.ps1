[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$ManagerBaseUrl = "",
    [string]$ProxyBaseUrl = "",
    [string]$StateRoot = $(if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }),
    [string]$ProxyAuthToken = "",
    [int]$TimeoutSec = 90,
    [string]$FirstModel = "",
    [string]$SecondModel = "",
    [switch]$PreviousResponseIdOnly
)

$ErrorActionPreference = "Stop"

function ConvertTo-SafeLoopbackBaseUrl {
    param([string]$Value, [string]$Name, [string[]]$AllowedPaths = @("/"))

    try { $uri = [Uri]$Value } catch { throw "$Name must be a safe HTTP loopback URL" }
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne "http" -or -not $uri.IsLoopback -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -notin $AllowedPaths) {
        throw "$Name must be a safe HTTP loopback URL"
    }
    return ($uri.GetLeftPart([UriPartial]::Authority) + $(if ($uri.AbsolutePath -eq "/") { "" } else { $uri.AbsolutePath.TrimEnd('/') }))
}

if (-not $ManagerBaseUrl) {
    $ManagerBaseUrl = if ($BaseUrl) { $BaseUrl } else { & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1") }
}
$endpointFailure = ""
try {
    $ManagerBaseUrl = ConvertTo-SafeLoopbackBaseUrl $ManagerBaseUrl "ManagerBaseUrl"
} catch {
    $endpointFailure = $_.Exception.Message
}
if (-not $endpointFailure -and -not $ProxyBaseUrl) {
    try {
        $fixedRouteStatusPath = Join-Path $StateRoot "fixed-route-status.json"
        $fixedRouteStatus = Get-Content -Raw -LiteralPath $fixedRouteStatusPath | ConvertFrom-Json
        $healthPort = [int]$fixedRouteStatus.ports.health
        if ($healthPort -le 0) { throw "fixed-route health port is unavailable" }
        $fixedRouteHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$healthPort/anticodex/fixed-route/health" -Proxy $null -TimeoutSec 5
        if ($fixedRouteHealth.ok -ne $true -or [string]$fixedRouteHealth.state -ne "ready") {
            throw "fixed-route health is not ready"
        }
        $ProxyBaseUrl = [string]$fixedRouteHealth.route.codexBaseUrl
        if (-not $ProxyBaseUrl) { $ProxyBaseUrl = [string]$fixedRouteStatus.route.codexBaseUrl }
        if (-not $ProxyBaseUrl) {
            $proxyPort = [int]$fixedRouteStatus.ports.proxy
            if ($proxyPort -gt 0) { $ProxyBaseUrl = "http://127.0.0.1:$proxyPort" }
        }
    } catch {
        $endpointFailure = "fixed-route proxy discovery failed: $($_.Exception.Message)"
    }
}
if (-not $endpointFailure -and $ProxyBaseUrl) {
    try {
        $ProxyBaseUrl = ConvertTo-SafeLoopbackBaseUrl $ProxyBaseUrl "ProxyBaseUrl" @("/", "/v1")
    } catch {
        $endpointFailure = $_.Exception.Message
    }
}
if ($ProxyBaseUrl) { $ProxyBaseUrl = ($ProxyBaseUrl.TrimEnd('/') -replace '/v1$', '') }
if (-not $ProxyBaseUrl -and -not $endpointFailure) { $endpointFailure = "fixed-route proxy address is unavailable" }

if (-not $endpointFailure -and -not $ProxyAuthToken) {
    try {
        $authPath = Join-Path $StateRoot "codex-home-deepseek-app\auth.json"
        $ProxyAuthToken = [string](Get-Content -Raw -LiteralPath $authPath | ConvertFrom-Json).OPENAI_API_KEY
    } catch {}
}
if (-not $ProxyAuthToken -and -not $endpointFailure) { $endpointFailure = "Anti-Codex local proxy auth token is unavailable" }

$startedAt = [DateTime]::UtcNow
$failures = New-Object System.Collections.Generic.List[string]
$marker = "MODEL_SWITCH_HISTORY_$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
$firstPrompt = "Remember the exact marker $marker. Reply with only that exact marker."
$secondPrompt = "Continue the same conversation after switching models. What exact marker did I ask you to remember? Reply with only the exact marker."
$historyMode = if ($PreviousResponseIdOnly) { "previous_response_id_only" } else { "explicit_client_history" }
$responseRequestCount = 0

if ($endpointFailure) {
    $failures.Add($endpointFailure) | Out-Null
}

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Invoke-ManagerJson {
    param([string]$Path, [int]$RequestTimeoutSec = $TimeoutSec)
    return Invoke-RestMethod -Uri "$ManagerBaseUrl$Path" -Proxy $null -TimeoutSec $RequestTimeoutSec
}

function Invoke-ProxyJson {
    param([string]$Path, [int]$RequestTimeoutSec = $TimeoutSec)
    return Invoke-RestMethod -Uri "$ProxyBaseUrl$Path" -Headers @{ Authorization = "Bearer $ProxyAuthToken" } -Proxy $null -TimeoutSec $RequestTimeoutSec
}

function Invoke-AntiCodexResponse {
    param([hashtable]$Body)

    $script:responseRequestCount += 1
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
    try {
        return Invoke-RestMethod `
            -Uri "$ProxyBaseUrl/v1/responses" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $ProxyAuthToken" } `
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

if (-not $endpointFailure) {
    try {
        $health = Invoke-ManagerJson "/health"
        if ($health.ok -ne $true) { Add-Failure "health ok=false" }
        if ([string]$health.role -ne "launcher-management-only") { Add-Failure "health endpoint is not the launcher Manager" }
    } catch {
        Add-Failure "health request failed: $($_.Exception.Message)"
    }

    try {
        $modelsPayload = Invoke-ProxyJson "/models"
        $models = @($modelsPayload.data | ForEach-Object { [string]$_.id } | Where-Object { $_ })
        if ($models.Count -lt 1) {
            Add-Failure "/models returned no usable model ids"
        }
    } catch {
        Add-Failure "models request failed: $($_.Exception.Message)"
    }
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
            input = New-UserInput $firstPrompt
        }
        $firstText = Get-ResponseText $first
        if (-not $first.id) {
            Add-Failure "first response did not include an id"
        }
        if ([string]$first.model -ne $FirstModel) {
            Add-Failure "first response model mismatch: requested=$FirstModel response=$($first.model)"
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
        $secondInput = if ($PreviousResponseIdOnly) {
            New-UserInput $secondPrompt
        } else {
            @(
                @{
                    type = "message"
                    role = "user"
                    content = @(@{ type = "input_text"; text = $firstPrompt })
                },
                @{
                    type = "message"
                    role = "assistant"
                    content = @(@{ type = "output_text"; text = $firstText })
                },
                @{
                    type = "message"
                    role = "user"
                    content = @(@{ type = "input_text"; text = $secondPrompt })
                }
            )
        }
        $second = Invoke-AntiCodexResponse @{
            model = $SecondModel
            previous_response_id = [string]$first.id
            stream = $false
            store = $true
            tools = @()
            tool_choice = "none"
            input = $secondInput
        }
        $secondText = Get-ResponseText $second
        if (-not $second.id) {
            Add-Failure "second response did not include an id"
        }
        if ([string]$second.model -ne $SecondModel) {
            Add-Failure "second response model mismatch: requested=$SecondModel response=$($second.model)"
        }
        if ($secondText -notmatch [regex]::Escape($marker)) {
            if ($PreviousResponseIdOnly) {
                Add-Failure "previous_response_id-only history was not preserved after model switch"
            } else {
                Add-Failure "second response did not preserve explicit client history after model switch"
            }
        }
        if ($secondText -match "DeepCodex") {
            Add-Failure "second response leaked the legacy DeepCodex brand"
        }
    } catch {
        Add-Failure "second model request failed: $($_.Exception.Message)"
    }
}

$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    skipped = $skipped
    reason = $skipReason
    failures = $failures.ToArray()
    baseUrl = $ManagerBaseUrl
    managerBaseUrl = $ManagerBaseUrl
    proxyBaseUrl = $ProxyBaseUrl
    historyMode = $historyMode
    previousResponseIdOnlySupported = if ($PreviousResponseIdOnly -and $second) { $secondText -match [regex]::Escape($marker) } else { $null }
    requestCount = $responseRequestCount
    evidenceKind = "fixed-route-response"
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    marker = $marker
    firstModel = $FirstModel
    secondModel = $SecondModel
    modelCount = @($models).Count
    firstResponseId = if ($first) { $first.id } else { $null }
    secondResponseId = if ($second) { $second.id } else { $null }
    firstText = $firstText
    secondText = $secondText
    responseModels = [pscustomobject]@{
        first = if ($first) { [string]$first.model } else { "" }
        second = if ($second) { [string]$second.model } else { "" }
    }
    route = $null
}

Write-Output ($result | ConvertTo-Json -Depth 12 -Compress)
if ($failures.Count -gt 0) { exit 1 }
