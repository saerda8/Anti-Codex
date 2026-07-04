[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 20,
    [int]$RequestTimeoutSec = 120,
    [int]$MaxModels = 0,
    [switch]$SkipRefresh,
    [switch]$SkipRequests
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$failures = New-Object System.Collections.Generic.List[string]
$results = New-Object System.Collections.Generic.List[object]
$startedAt = [DateTime]::UtcNow

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
        [int]$MaxAttempts = 2
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $args = @{
                Uri = "$BaseUrl$Path"
                Method = $Method
                Proxy = $null
                TimeoutSec = $Timeout
            }
            if ($null -ne $Body) {
                $json = $Body | ConvertTo-Json -Depth 30 -Compress
                $args.ContentType = "application/json; charset=utf-8"
                $args.Body = [Text.Encoding]::UTF8.GetBytes($json)
            }
            return Invoke-RestMethod @args
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -ge $MaxAttempts) {
                throw "$Path request failed on attempt $attempt of $MaxAttempts`: $lastError"
            }
            Start-Sleep -Milliseconds ([Math]::Min(1000, 250 * $attempt))
        }
    }

    throw "$Path request failed after $MaxAttempts attempts: $lastError"
}

function Invoke-LocalJsonSafe {
    param(
        [string]$Name,
        [string]$Path,
        [string]$Method = "GET",
        [object]$Body = $null,
        [int]$Timeout = $TimeoutSec
    )

    try {
        return [pscustomobject]@{
            ok = $true
            name = $Name
            payload = Invoke-LocalJson -Path $Path -Method $Method -Body $Body -Timeout $Timeout
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
    if (-not (Has-Property $DiagnosticsPayload "health")) { return "" }
    if (-not (Has-Property $DiagnosticsPayload.health "upstreamProfile")) { return "" }
    $profile = $DiagnosticsPayload.health.upstreamProfile
    if (-not $profile -or -not (Has-Property $profile $Name)) { return "" }
    return [string]$profile.$Name
}

if (-not $SkipRefresh) {
    $refresh = Invoke-LocalJsonSafe "model-refresh" "/anticodex/models/refresh" "POST" @{}
    if (-not $refresh.ok) {
        Add-Failure "model refresh failed: $($refresh.error.message)"
    }
}

$modelsResult = Invoke-LocalJsonSafe "models" "/models"
$modelRecords = if ($modelsResult.ok -and $modelsResult.payload -and $modelsResult.payload.data) {
    @($modelsResult.payload.data)
} else {
    @()
}
$models = @($modelRecords | ForEach-Object { [string]$_.id })
$models = @($models)

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

$diagnosticsResult = Invoke-LocalJsonSafe "diagnostics" "/anticodex/diagnostics" -Timeout $TimeoutSec
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

if ($SkipRequests -and $diagnosticsResult.ok -and $diagnosticsResult.payload.models) {
    $diagnosticCount = [int]$diagnosticsResult.payload.models.count
    if ($diagnosticCount -ne $models.Count) {
        Add-Failure "diagnostics model count mismatch: $diagnosticCount vs $($models.Count)"
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
    } $RequestTimeoutSec

    $text = ""
    $route = $null
    $routeResult = $null
    $modelAvailabilityUnavailable = $false
    if ($request.ok) {
        $text = Get-AntiCodexResponseText $request.payload
        $routeResult = Invoke-LocalJsonSafe "route-$model" "/anticodex/model-routes"
        if ($routeResult.ok -and $routeResult.payload) {
            $route = $routeResult.payload.latest
        }
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
    }

    if ($request.ok -and -not $routeResult.ok) {
        $ok = $false
        $checks.Add("route audit request failed: $($routeResult.error.message)") | Out-Null
    } elseif ($request.ok -and -not $route) {
        $ok = $false
        $checks.Add("route audit empty") | Out-Null
    } elseif ($request.ok) {
        if ([string]$route.resolvedModel -ne $model) {
            $ok = $false
            $checks.Add("resolved model mismatch: $($route.resolvedModel)") | Out-Null
        }
        if ($thirdPartyMode) {
            if ([string]$route.transport -ne "upstream-provider") {
                $ok = $false
                $checks.Add("third-party route transport mismatch: $($route.transport)") | Out-Null
            }
            if (-not [string]$route.providerProtocol) {
                $ok = $false
                $checks.Add("missing third-party provider protocol") | Out-Null
            }
            if ([string]$route.providerProtocol -ne $diagnosticProtocol) {
                $ok = $false
                $checks.Add("third-party provider protocol mismatch: $($route.providerProtocol)") | Out-Null
            }
        } else {
            if ([string]$route.transport -ne "cli" -and -not [string]$route.internalModel) {
                $ok = $false
                $checks.Add("missing internal model") | Out-Null
            }
            if (-not [string]$route.cascadeId) {
                $ok = $false
                $checks.Add("missing cascade id") | Out-Null
            }
            if ([string]$route.status -ne "success") {
                $ok = $false
                $checks.Add("route status is not success: $($route.status)") | Out-Null
            }
            $expectedReasoningLabel = Get-ExpectedReasoningLabel $model
            if ($expectedReasoningLabel -and [string]$route.displayName -notmatch "\($([regex]::Escape($expectedReasoningLabel))\)$") {
                $ok = $false
                $checks.Add("display name reasoning mismatch: expected $expectedReasoningLabel, got $($route.displayName)") | Out-Null
            }
        }
    }

    if (-not $ok) {
        Add-Failure "$model failed: $($checks -join '; ')"
    }

    $results.Add([pscustomobject]@{
        model = $model
        ok = $ok
        marker = $marker
        requestAvailable = -not $modelAvailabilityUnavailable
        availabilityUnavailable = $modelAvailabilityUnavailable
        responseContainsMarker = ($text -match [regex]::Escape($marker))
        text = $text
        route = if ($route) {
            [pscustomobject]@{
                requestId = $route.requestId
                requestedModel = $route.requestedModel
                resolvedModel = $route.resolvedModel
                displayName = $route.displayName
                transport = $route.transport
                provider = $route.provider
                providerProtocol = $route.providerProtocol
                internalModel = $route.internalModel
                cascadeId = $route.cascadeId
                status = $route.status
            }
        } else { $null }
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
    baseUrl = $BaseUrl
    mode = $diagnosticMode
    providerProtocol = $diagnosticProtocol
    providerModel = $diagnosticModel
    toolBridge = if ($diagnosticsResult.ok -and $diagnosticsResult.payload.toolBridge) { $diagnosticsResult.payload.toolBridge } else { $null }
    modelCount = $models.Count
    models = $models
    skipRequests = [bool]$SkipRequests
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
        usedRealTraffic = $true
        coverageKind = "real-traffic"
        elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
        baseUrl = $BaseUrl
        mode = $diagnosticMode
        providerProtocol = $diagnosticProtocol
        providerModel = $diagnosticModel
        modelCount = $models.Count
        models = $models
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


