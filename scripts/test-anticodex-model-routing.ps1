[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$ManagerBaseUrl = "",
    [string]$ProxyBaseUrl = "",
    [string]$StateRoot = $(if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "anticodex" }),
    [string]$ProxyAuthToken = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 20,
    [int]$RequestTimeoutSec = 120,
    [int]$MaxModels = 0,
    [switch]$SkipRefresh,
    [switch]$SkipRequests
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
$fixedRouteStatus = $null
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

$failures = New-Object System.Collections.Generic.List[string]
$results = New-Object System.Collections.Generic.List[object]
$startedAt = [DateTime]::UtcNow
$script:modelPostAttempts = 0
$script:modelPostSuccesses = 0

if ($endpointFailure) {
    $failures.Add($endpointFailure) | Out-Null
}

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Get-ErrorPayload {
    param($ErrorRecord)

    $response = $ErrorRecord.Exception.Response
    $status = $null
    $payload = $null
    $text = ""
    if ($response) {
        try { $status = [int]$response.StatusCode } catch {}
        $stream = $response.GetResponseStream()
        if ($stream) {
            $reader = New-Object IO.StreamReader($stream)
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
    }
    if ($text) {
        try { $payload = $text | ConvertFrom-Json } catch {}
    }

    return [pscustomobject]@{
        status = $status
        type = if ($payload -and (Has-Property $payload "type")) { [string]$payload.type } elseif ($payload -and $payload.error -and (Has-Property $payload.error "type")) { [string]$payload.error.type } else { $null }
        message = if ($payload -and (Has-Property $payload "message")) { [string]$payload.message } elseif ($payload -and $payload.error -and (Has-Property $payload.error "message")) { [string]$payload.error.message } elseif ($text) { $text } else { [string]$ErrorRecord.Exception.Message }
        retryable = if ($payload -and (Has-Property $payload "retryable")) { [bool]$payload.retryable } elseif ($payload -and $payload.error -and (Has-Property $payload.error "retryable")) { [bool]$payload.error.retryable } else { $null }
    }
}

function Test-ExpectedModelAvailabilityError {
    param($ErrorPayload)

    $status = $ErrorPayload.status
    $message = [string]$ErrorPayload.message
    return $status -in @(429, 503) -or $message -match "\(429\)|429|Too Many Requests|\(503\)|503|Server Unavailable"
}

function Invoke-LocalJson {
    param(
        [string]$Path,
        [string]$Method = "GET",
        [object]$Body = $null,
        [int]$Timeout = $TimeoutSec,
        [int]$MaxAttempts = 2,
        [string]$RootUrl = $ManagerBaseUrl,
        [hashtable]$Headers = $null
    )

    $lastError = $null
    $attemptLimit = if ($Method.ToUpperInvariant() -eq "GET") { $MaxAttempts } else { 1 }
    $isModelPost = $RootUrl -eq $ProxyBaseUrl -and $Method.ToUpperInvariant() -eq "POST" -and $Path -eq "/v1/responses"
    for ($attempt = 1; $attempt -le $attemptLimit; $attempt++) {
        try {
            $args = @{
                Uri = "$RootUrl$Path"
                Method = $Method
                Proxy = $null
                TimeoutSec = $Timeout
            }
            $requestHeaders = @{}
            if ($Headers) {
                foreach ($name in $Headers.Keys) { $requestHeaders[$name] = $Headers[$name] }
            }
            if ($RootUrl -eq $ProxyBaseUrl) {
                if (-not $ProxyAuthToken) { throw "Anti-Codex local proxy auth token is unavailable" }
                $requestHeaders.Authorization = "Bearer $ProxyAuthToken"
            }
            if ($requestHeaders.Count -gt 0) { $args.Headers = $requestHeaders }
            if ($null -ne $Body) {
                $json = $Body | ConvertTo-Json -Depth 30 -Compress
                $args.ContentType = "application/json; charset=utf-8"
                $args.Body = [Text.Encoding]::UTF8.GetBytes($json)
            }
            if ($isModelPost) { $script:modelPostAttempts += 1 }
            $response = Invoke-RestMethod @args
            if ($isModelPost) { $script:modelPostSuccesses += 1 }
            return $response
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -ge $attemptLimit) {
                throw "$Path request failed on attempt $attempt of $attemptLimit`: $lastError"
            }
            Start-Sleep -Milliseconds ([Math]::Min(1000, 250 * $attempt))
        }
    }

    throw "$Path request failed after $attemptLimit attempts: $lastError"
}

function Invoke-LocalJsonSafe {
    param(
        [string]$Name,
        [string]$Path,
        [string]$Method = "GET",
        [object]$Body = $null,
        [int]$Timeout = $TimeoutSec,
        [string]$RootUrl = $ManagerBaseUrl,
        [hashtable]$Headers = $null
    )

    try {
        return [pscustomobject]@{
            ok = $true
            name = $Name
            payload = Invoke-LocalJson -Path $Path -Method $Method -Body $Body -Timeout $Timeout -RootUrl $RootUrl -Headers $Headers
            error = $null
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            name = $Name
            payload = $null
            error = Get-ErrorPayload $_
        }
    }
}

function New-MessageInput {
    param([string]$Text)
    return , [object[]]@(
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
}

function Get-AntiCodexResponseText {
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

function Get-ExpectedReasoningLabel {
    param([string]$Model)

    $value = $Model.ToLowerInvariant()
    if ($value -match "extra[-_]low") { return "Extra Low" }
    if ($value -match "(?:thinking|xhigh|max)") { return "Thinking" }
    if ($value -match "(?:^|[-_])low(?:$|[-_])") { return "Low" }
    if ($value -match "(?:^|[-_])medium(?:$|[-_])") { return "Medium" }
    if ($value -match "(?:^|[-_])high(?:$|[-_])") { return "High" }
    return ""
}

function Get-ModelDisplayMap {
    param($DiagnosticsPayload)

    $map = @{}
    $ids = @()
    $displayNames = @()
    if ($DiagnosticsPayload -and $DiagnosticsPayload.models) {
        $ids = @($DiagnosticsPayload.models.ids | ForEach-Object { [string]$_ })
        $displayNames = @($DiagnosticsPayload.models.displayNames | ForEach-Object { [string]$_ })
    }
    for ($i = 0; $i -lt $ids.Count; $i++) {
        $map[$ids[$i]] = if ($i -lt $displayNames.Count) { $displayNames[$i] } else { "" }
    }
    return $map
}

function Get-DiagnosticsMode {
    param($DiagnosticsPayload)

    if (-not $DiagnosticsPayload) { return "unknown" }
    foreach ($candidate in @($DiagnosticsPayload.fixedRoute.provider, $DiagnosticsPayload.health.provider, $DiagnosticsPayload.mode.upstreamMode)) {
        $value = [string]$candidate
        if ($value -eq "antigravity" -or $value -eq "third-party") { return $value }
    }
    if ((Has-Property $DiagnosticsPayload "health") -and
        (Has-Property $DiagnosticsPayload.health "upstreamProfile") -and
        $DiagnosticsPayload.health.upstreamProfile -and
        (Has-Property $DiagnosticsPayload.health.upstreamProfile "mode")) {
        return [string]$DiagnosticsPayload.health.upstreamProfile.mode
    }
    if ((Has-Property $DiagnosticsPayload "mode") -and
        (Has-Property $DiagnosticsPayload.mode "upstream") -and
        $DiagnosticsPayload.mode.upstream -eq "antigravity-desktop") {
        return "antigravity"
    }
    return "unknown"
}

function Get-DiagnosticsProfileValue {
    param($DiagnosticsPayload, [string]$Name)

    if (-not $DiagnosticsPayload) { return "" }
    if ($DiagnosticsPayload.health -and $DiagnosticsPayload.health.upstreamProfile -and (Has-Property $DiagnosticsPayload.health.upstreamProfile $Name)) {
        return [string]$DiagnosticsPayload.health.upstreamProfile.$Name
    }
    if ($Name -eq "protocol" -and $DiagnosticsPayload.fixedRoute) { return [string]$DiagnosticsPayload.fixedRoute.relayProtocol }
    if ($Name -eq "model" -and $DiagnosticsPayload.health) { return [string]$DiagnosticsPayload.health.model }
    return ""
}

function Get-ManagerActionHeaders {
    $trusted = @{
        Origin = $ManagerBaseUrl
        Referer = "$ManagerBaseUrl/anticodex/manager"
    }
    $bootstrap = Invoke-RestMethod -Uri "$ManagerBaseUrl/anticodex/manager/bootstrap" -Headers $trusted -Proxy $null -TimeoutSec $TimeoutSec
    $token = [string]$bootstrap.token
    if (-not $token) { throw "manager bootstrap did not return an action token" }
    $trusted["x-anticodex-manager-token"] = $token
    return $trusted
}

if (-not $SkipRefresh -and -not $endpointFailure) {
    try {
        $managerActionHeaders = Get-ManagerActionHeaders
        $refresh = Invoke-LocalJsonSafe "model-refresh" "/anticodex/models/refresh" "POST" @{} -Headers $managerActionHeaders
    } catch {
        $refresh = [pscustomobject]@{ ok = $false; error = Get-ErrorPayload $_ }
    }
    if (-not $refresh.ok) {
        Add-Failure "model refresh failed: $($refresh.error.message)"
    }
}

$modelsResult = if ($endpointFailure) {
    [pscustomobject]@{ ok = $false; payload = $null; error = [pscustomobject]@{ message = $endpointFailure } }
} else {
    Invoke-LocalJsonSafe "models" "/models" -RootUrl $ProxyBaseUrl
}
$modelRecords = if ($modelsResult.ok -and $modelsResult.payload -and $modelsResult.payload.data) {
    @($modelsResult.payload.data)
} else {
    @()
}
$models = @($modelRecords | ForEach-Object { [string]$_.id })
$models = @($models)
$modelCatalogCount = $models.Count

if (-not $modelsResult.ok) {
    Add-Failure "models request failed: $($modelsResult.error.message)"
}

if ($models.Count -lt 1) {
    Add-Failure "model catalog is empty"
}

if ($MaxModels -gt 0 -and $models.Count -gt $MaxModels) {
    $models = @($models | Select-Object -First $MaxModels)
}

$displayByModel = @{}
foreach ($modelRecord in @($modelRecords)) {
    if ((Has-Property $modelRecord "id") -and (Has-Property $modelRecord "display_name")) {
        $displayByModel[[string]$modelRecord.id] = [string]$modelRecord.display_name
    }
}

$diagnosticsResult = if ($endpointFailure) {
    [pscustomobject]@{ ok = $false; payload = $null; error = [pscustomobject]@{ message = $endpointFailure } }
} else {
    Invoke-LocalJsonSafe "diagnostics" "/anticodex/diagnostics" -Timeout $TimeoutSec
}
$diagnosticMode = "unknown"
$diagnosticProtocol = ""
$diagnosticModel = ""
if ($diagnosticsResult.ok) {
    $diagnosticDisplayByModel = Get-ModelDisplayMap $diagnosticsResult.payload
    foreach ($key in @($diagnosticDisplayByModel.Keys)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$diagnosticDisplayByModel[$key])) {
            $displayByModel[$key] = $diagnosticDisplayByModel[$key]
        }
    }
    $diagnosticMode = Get-DiagnosticsMode $diagnosticsResult.payload
    $diagnosticProtocol = Get-DiagnosticsProfileValue $diagnosticsResult.payload "protocol"
    $diagnosticModel = Get-DiagnosticsProfileValue $diagnosticsResult.payload "model"
} elseif ($SkipRequests) {
    Add-Failure "diagnostics failed: $($diagnosticsResult.error.message)"
}

if ($SkipRequests -and $diagnosticsResult.ok -and $diagnosticsResult.payload.models -and (Has-Property $diagnosticsResult.payload.models "count")) {
    $diagnosticCount = [int]$diagnosticsResult.payload.models.count
    if ($diagnosticCount -ne $modelCatalogCount) {
        Add-Failure "diagnostics model count mismatch: $diagnosticCount vs $modelCatalogCount"
    }
}

$thirdPartyMode = $diagnosticMode -eq "third-party"
if ($thirdPartyMode) {
    if (-not $diagnosticProtocol) { Add-Failure "third-party model routing missing provider protocol" }
    if (-not $diagnosticModel) { Add-Failure "third-party model routing missing provider model" }
    if ($models.Count -gt 0 -and $diagnosticModel -and ($diagnosticModel -notin $models)) {
        Add-Failure "third-party provider model is absent from /models: $diagnosticModel"
    }
    if ($diagnosticsResult.ok -and $diagnosticsResult.payload.toolBridge) {
        if ($diagnosticsResult.payload.toolBridge.mode -ne "provider-native-or-compat") {
            Add-Failure "third-party model routing bridge mode is not provider-native-or-compat"
        }
        if ($diagnosticsResult.payload.toolBridge.transport -ne "upstream-provider") {
            Add-Failure "third-party model routing transport is not upstream-provider"
        }
    }
}

foreach ($model in $models) {
    if ($SkipRequests) {
        $ok = $true
        $checks = New-Object System.Collections.Generic.List[string]
        $displayName = if ($displayByModel.ContainsKey($model)) { [string]$displayByModel[$model] } else { "" }

        if ((-not $thirdPartyMode) -and (-not $displayName)) {
            $ok = $false
            $checks.Add("missing diagnostics display name") | Out-Null
        }
        if ((-not $thirdPartyMode) -and $model -match "\d" -and $displayName -notmatch "\d") {
            $ok = $false
            $checks.Add("display name is missing numeric model/version detail: $displayName") | Out-Null
        }
        $expectedReasoningLabel = Get-ExpectedReasoningLabel $model
        if ((-not $thirdPartyMode) -and $expectedReasoningLabel -and $displayName -notmatch "\($([regex]::Escape($expectedReasoningLabel))\)$") {
            $ok = $false
            $checks.Add("display name reasoning mismatch: expected $expectedReasoningLabel, got $displayName") | Out-Null
        }
        if ($thirdPartyMode -and $diagnosticModel -and $model -eq $diagnosticModel) {
            $checks.Add("third-party provider model is present in /models") | Out-Null
        }

        if (-not $ok) {
            Add-Failure "$model failed: $($checks -join '; ')"
        }

        $results.Add([pscustomobject]@{
            model = $model
            ok = $ok
            skippedRequest = $true
            displayName = $displayName
            marker = $null
            responseContainsMarker = $false
            text = ""
            route = $null
            checks = $checks.ToArray()
            error = $null
        }) | Out-Null
        continue
    }

    $marker = "MODEL_ROUTE_" + ($model -replace "[^A-Za-z0-9]", "_") + "_" + (Get-Random -Minimum 10000 -Maximum 99999)
    $request = Invoke-LocalJsonSafe "request-$model" "/v1/responses" "POST" @{
        model = $model
        stream = $false
        store = $false
        input = New-MessageInput "Reply with exactly this marker and no extra words: $marker"
    } $RequestTimeoutSec $ProxyBaseUrl

    $text = ""
    $responseModel = ""
    $responseId = ""
    $modelAvailabilityUnavailable = $false
    if ($request.ok) {
        $text = Get-AntiCodexResponseText $request.payload
        $responseModel = [string]$request.payload.model
        $responseId = [string]$request.payload.id
    }

    $ok = $true
    $checks = New-Object System.Collections.Generic.List[string]
    if (-not $request.ok) {
        if (Test-ExpectedModelAvailabilityError $request.error) {
            $modelAvailabilityUnavailable = $true
            $checks.Add("model availability unavailable: $($request.error.message)") | Out-Null
        } else {
            $ok = $false
            $checks.Add("request failed: $($request.error.message)") | Out-Null
        }
    } elseif ($text -notmatch [regex]::Escape($marker)) {
        $ok = $false
        $checks.Add("marker missing from response") | Out-Null
    } elseif (-not $responseId) {
        $ok = $false
        $checks.Add("response id is missing") | Out-Null
    } elseif ($responseModel -ne $model) {
        $ok = $false
        $checks.Add("response model mismatch: requested=$model response=$responseModel") | Out-Null
    }

    if (-not $ok) {
        Add-Failure "$model failed: $($checks -join '; ')"
    }

    $results.Add([pscustomobject]@{
        model = $model
        ok = $ok
        marker = $marker
        requestAvailable = [bool]$request.ok
        availabilityUnavailable = $modelAvailabilityUnavailable
        responseContainsMarker = ($text -match [regex]::Escape($marker))
        responseId = $responseId
        responseModel = $responseModel
        evidenceKind = "fixed-route-response"
        text = $text
        route = $null
        checks = $checks.ToArray()
        error = if (-not $request.ok) { $request.error } else { $null }
    }) | Out-Null
}

$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    reportName = "model-routing"
    failures = $failures.ToArray()
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    baseUrl = $ManagerBaseUrl
    managerBaseUrl = $ManagerBaseUrl
    proxyBaseUrl = $ProxyBaseUrl
    mode = $diagnosticMode
    providerProtocol = $diagnosticProtocol
    providerModel = $diagnosticModel
    toolBridge = if ($diagnosticsResult.ok -and $diagnosticsResult.payload.toolBridge) { $diagnosticsResult.payload.toolBridge } else { $null }
    modelCount = $models.Count
    modelCatalogCount = $modelCatalogCount
    models = $models
    skipRequests = [bool]$SkipRequests
    requestAttemptCount = $script:modelPostAttempts
    successfulRequestCount = $script:modelPostSuccesses
    usedRealTraffic = $script:modelPostAttempts -gt 0
    results = $results.ToArray()
}

$reportPaths = New-ReportPaths "model-routing"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
Save-JsonReport $reportPaths $result

if (-not $SkipRequests) {
    $availabilityReport = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        reportName = "model-availability"
        failures = $failures.ToArray()
        requestedRealTraffic = $true
        usedRealTraffic = $script:modelPostAttempts -gt 0
        coverageKind = "real-traffic"
        elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
        baseUrl = $ManagerBaseUrl
        mode = $diagnosticMode
        providerProtocol = $diagnosticProtocol
        providerModel = $diagnosticModel
        modelCount = $models.Count
        modelCatalogCount = $modelCatalogCount
        models = $models
        requestAttemptCount = $script:modelPostAttempts
        successfulRequestCount = $script:modelPostSuccesses
        requestAvailableModels = @($results.ToArray() | Where-Object { $_.requestAvailable -eq $true } | ForEach-Object { [string]$_.model })
        availabilityUnavailableModels = @($results.ToArray() | Where-Object { $_.availabilityUnavailable -eq $true } | ForEach-Object { [string]$_.model })
        availabilityUnavailableCount = @($results.ToArray() | Where-Object { $_.availabilityUnavailable -eq $true }).Count
        results = $results.ToArray()
    }
    $availabilityReportPaths = New-ReportPaths "model-availability"
    $availabilityReport | Add-Member -NotePropertyName report -NotePropertyValue $availabilityReportPaths -Force
    Save-JsonReport $availabilityReportPaths $availabilityReport
}

$result | ConvertTo-Json -Depth 12 -Compress
if ($failures.Count -gt 0) { exit 1 }


