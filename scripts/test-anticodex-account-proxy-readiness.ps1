[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$Model = $(if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "gemini-3.5-flash-low" }),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 8,
    [int]$RequestTimeoutSec = 90,
    [switch]$AllowUnready
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$failures = New-Object System.Collections.Generic.List[string]

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
    $detail = if ($payload -and $payload.error -and (Has-Property $payload.error "details")) { $payload.error.details } else { $null }

    return [pscustomobject]@{
        status = $status
        type = if ($payload -and (Has-Property $payload "type")) { [string]$payload.type } elseif ($payload -and $payload.error -and (Has-Property $payload.error "type")) { [string]$payload.error.type } elseif ($detail -and (Has-Property $detail "type")) { [string]$detail.type } else { $null }
        diagnosis = if ($payload -and (Has-Property $payload "diagnosis")) { [string]$payload.diagnosis } elseif ($payload -and $payload.error -and (Has-Property $payload.error "diagnosis")) { [string]$payload.error.diagnosis } elseif ($detail -and (Has-Property $detail "diagnosis")) { [string]$detail.diagnosis } else { $null }
        message = if ($payload -and (Has-Property $payload "message")) { [string]$payload.message } elseif ($payload -and $payload.error -and (Has-Property $payload.error "message")) { [string]$payload.error.message } elseif ($text) { $text } else { [string]$ErrorRecord.Exception.Message }
        retryable = if ($payload -and (Has-Property $payload "retryable")) { [bool]$payload.retryable } elseif ($payload -and $payload.error -and (Has-Property $payload.error "retryable")) { [bool]$payload.error.retryable } elseif ($detail -and (Has-Property $detail "retryable")) { [bool]$detail.retryable } else { $null }
        retryAfterMs = if ($payload -and (Has-Property $payload "retryAfterMs")) { [int]$payload.retryAfterMs } elseif ($payload -and $payload.error -and (Has-Property $payload.error "retryAfterMs")) { [int]$payload.error.retryAfterMs } elseif ($detail -and (Has-Property $detail "retryAfterMs")) { [int]$detail.retryAfterMs } else { 0 }
    }
}

function Invoke-LocalJson {
    param(
        [string]$Path,
        [string]$Method = "GET",
        [object]$Body = $null,
        [int]$Timeout = $TimeoutSec
    )

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

function Get-AntigravityLogSignals {
    $candidates = @(
        (Join-Path $env:APPDATA "Antigravity\logs\language_server.log"),
        (Join-Path $env:APPDATA "Antigravity IDE\logs\language_server.log")
    )
    $source = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
    if (-not $source) {
        return [pscustomobject]@{
            sourcePresent = $false
            sourceFresh = $false
            sourceLastWriteUtc = $null
            tailLinesScanned = 0
            verificationRequiredCount = 0
            tokenRefreshMissingCount = 0
            oauthNetworkFailureCount = 0
            generalNetworkFailureCount = 0
        }
    }

    try {
        $item = Get-Item -LiteralPath $source[0] -ErrorAction Stop
        $tail = @(Get-Content -LiteralPath $source[0] -Tail 1000 -ErrorAction Stop)
        return [pscustomobject]@{
            sourcePresent = $true
            sourceFresh = (([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalHours -le 24)
            sourceLastWriteUtc = $item.LastWriteTimeUtc.ToString("o")
            tailLinesScanned = $tail.Count
            verificationRequiredCount = @($tail | Select-String -Pattern "Verify your account to continue|account verification required").Count
            tokenRefreshMissingCount = @($tail | Select-String -Pattern "Background token refresh failed: no token found|You are not logged into Antigravity").Count
            oauthNetworkFailureCount = @($tail | Select-String -Pattern "oauth2\.googleapis\.com/token.*(?:EOF|timeout|failed)|userinfo.*(?:timeout|failed)").Count
            generalNetworkFailureCount = @($tail | Select-String -Pattern "unexpected EOF|connectex|deadline exceeded|connection attempt failed|i/o timeout").Count
        }
    } catch {
        return [pscustomobject]@{
            sourcePresent = $true
            sourceFresh = $false
            sourceLastWriteUtc = $null
            tailLinesScanned = 0
            verificationRequiredCount = 0
            tokenRefreshMissingCount = 0
            oauthNetworkFailureCount = 0
            generalNetworkFailureCount = 0
        }
    }
}

function Get-Diagnosis {
    param($Health, $RequestError, $RefreshError, $AccountError, $LogSignals)

    if (-not $Health) { return "local_gateway_offline" }
    if (($RequestError -and (($RequestError.diagnosis -eq "account_verification_required") -or ($RequestError.message -match "Verify your account to continue|PERMISSION_DENIED|account verification"))) -or
        ($RefreshError -and (($RefreshError.diagnosis -eq "account_verification_required") -or ($RefreshError.message -match "Verify your account to continue|PERMISSION_DENIED|account verification")))) {
        return "account_verification_required"
    }
    if ($Health -and $Health.antigravityCircuitState -eq "open") { return "proxy_or_network_circuit_open" }
    if (($LogSignals -and ([int]$LogSignals.oauthNetworkFailureCount -gt 0 -or [int]$LogSignals.generalNetworkFailureCount -gt 0)) -and
        (($AccountError -and $AccountError.message -match "aborted|timed out|timeout|unexpected EOF|connectex|connection.*failed|network|fetch failed") -or
         ($RefreshError -and $RefreshError.message -match "aborted|timed out|timeout|unexpected EOF|connectex|connection.*failed|network|fetch failed|empty model list") -or
         ($RequestError -and $RequestError.message -match "confirm its proxy connection|aborted|timed out|timeout|unexpected EOF|connectex|connection.*failed|network|fetch failed"))) {
        return "proxy_or_network_transient"
    }
    if ($RequestError -and $RequestError.type -eq "antigravity_temporarily_unavailable") { return "proxy_or_network_unavailable" }
    if ($RefreshError -and $RefreshError.type -eq "antigravity_temporarily_unavailable") { return "proxy_or_network_unavailable" }
    if ($RequestError -and $RequestError.type -eq "antigravity_account_unavailable") { return "account_signed_out_or_no_models" }
    if ($RefreshError -and $RefreshError.type -eq "antigravity_account_unavailable") { return "account_signed_out_or_no_models" }
    if ($RequestError -and $RequestError.message -match "aborted|timed out|timeout|unexpected EOF|connectex|connection.*failed|network|fetch failed") { return "proxy_or_network_transient" }
    if ($RefreshError -and $RefreshError.message -match "empty model list|aborted|timed out|timeout|unexpected EOF|connectex|connection.*failed|network|fetch failed") { return "proxy_or_network_transient" }
    if ($Health -and $Health.accountTrafficReady -eq $false) {
        if ($Health.accountTrafficDiagnosis -eq "account_verification_required") { return "account_verification_required" }
        if ($Health.accountTrafficType -eq "antigravity_account_unavailable") { return "account_signed_out_or_no_models" }
        return "proxy_or_network_unavailable"
    }
    if ($Health -and $Health.accountState -eq "account_unavailable") { return "account_signed_out_or_no_models" }
    if ($Health -and $Health.accountState -eq "transient_error") { return "proxy_or_network_transient" }
    if ($Health -and $Health.accountReady -eq $true) { return "ready" }
    return "unknown"
}

function Get-DiagnosisDetail {
    param([string]$Diagnosis, $LogSignals)
    if (-not $LogSignals -or $LogSignals.sourceFresh -ne $true) { return $Diagnosis }
    if ($Diagnosis -eq "account_verification_required" -and [int]$LogSignals.tokenRefreshMissingCount -gt 0) {
        return "account_verification_with_missing_token"
    }
    if ($Diagnosis -match "^proxy_or_network" -and [int]$LogSignals.oauthNetworkFailureCount -gt 0) {
        return "antigravity_oauth_network_failure"
    }
    return $Diagnosis
}

function Get-SuggestedAction {
    param([string]$Diagnosis, [string]$DiagnosisDetail)
    if ($DiagnosisDetail -eq "account_verification_with_missing_token") {
        return "Open Antigravity Desktop, re-authenticate the signed-in account and complete its verification prompt, then retry Anti-Codex."
    }
    if ($DiagnosisDetail -eq "antigravity_oauth_network_failure") {
        return "Confirm Antigravity Desktop can reach Google account services through its proxy, then re-authenticate and retry."
    }
    switch ($Diagnosis) {
        "ready" { return "No action needed." }
        "local_gateway_offline" { return "Open Anti-Codex to start the local gateway, then retry." }
        "account_verification_required" { return "Open Antigravity Desktop, complete the account verification prompt, then retry Anti-Codex." }
        "account_signed_out_or_no_models" { return "Open Antigravity Desktop, sign in, then run Refresh Anti-Codex Models." }
        "proxy_or_network_circuit_open" { return "Confirm Antigravity Desktop can reach Google through your proxy, wait for the retry window, then retry." }
        "proxy_or_network_unavailable" { return "Check the proxy used by Antigravity Desktop, then retry; Anti-Codex local traffic is already bypassing proxy." }
        "proxy_or_network_transient" { return "Keep Anti-Codex open and retry after the transient Antigravity/proxy error clears." }
        default { return "Check Antigravity Desktop account and proxy state, then retry." }
    }
}

$startedAt = [DateTime]::UtcNow
$healthBeforeResult = Invoke-LocalJsonSafe "health-before" "/health"
$healthBefore = $healthBeforeResult.payload
if (-not $healthBeforeResult.ok) {
    Add-Failure "local gateway health request failed: $($healthBeforeResult.error.message)"
}

$accountResult = Invoke-LocalJsonSafe "account" "/anticodex/account"
$account = $accountResult.payload
if (-not $accountResult.ok) {
    Add-Failure "Antigravity account status request failed: $($accountResult.error.message)"
} elseif ($account.signedIn -ne $true) {
    Add-Failure "Antigravity account status does not report a signed-in account"
} elseif ($account.identityAvailable -ne $true -or -not [string]$account.fingerprint) {
    Add-Failure "Antigravity account status did not provide an anonymized identity fingerprint"
}

$refreshResult = Invoke-LocalJsonSafe "model-refresh" "/anticodex/models/refresh" "POST" @{}
$modelsResult = Invoke-LocalJsonSafe "models" "/models"
$models = if ($modelsResult.ok -and $modelsResult.payload -and $modelsResult.payload.data) { @($modelsResult.payload.data) } else { @() }

if (-not $refreshResult.ok) {
    Add-Failure "model refresh failed: $($refreshResult.error.message)"
}
if ($models.Count -lt 1) {
    Add-Failure "model catalog is empty"
}

$selectedModel = $Model
if ($models.Count -gt 0 -and -not (@($models | ForEach-Object { [string]$_.id }) -contains $selectedModel)) {
    $selectedModel = [string]$models[0].id
}

$requestResult = $null
$requestText = ""
$requestMarker = "ACCOUNT_PROXY_READY_" + (Get-Random -Minimum 10000 -Maximum 99999)
if ($healthBefore -and $healthBefore.accountReady -eq $true -and $models.Count -gt 0) {
    $requestResult = Invoke-LocalJsonSafe "real-response" "/v1/responses" "POST" @{
        model = $selectedModel
        stream = $false
        store = $false
        input = New-MessageInput "Reply with exactly this marker and no extra words: $requestMarker"
    } $RequestTimeoutSec

    if ($requestResult.ok) {
        $requestText = Get-AntiCodexResponseText $requestResult.payload
        if ($requestText -notmatch [regex]::Escape($requestMarker)) {
            Add-Failure "real request did not echo marker: $requestText"
        }
    } else {
        Add-Failure "real request failed: $($requestResult.error.message)"
    }
}

$routeAuditResult = Invoke-LocalJsonSafe "model-route-audit" "/anticodex/model-routes"
$latestRoute = if ($routeAuditResult.ok -and $routeAuditResult.payload) { $routeAuditResult.payload.latest } else { $null }
if ($requestResult -and $requestResult.ok) {
    if (-not $routeAuditResult.ok) {
        Add-Failure "model route audit request failed: $($routeAuditResult.error.message)"
    } elseif (-not $latestRoute) {
        Add-Failure "model route audit is empty after a real request"
    } elseif ([string]$latestRoute.resolvedModel -ne $selectedModel) {
        Add-Failure "model route audit mismatch: selected=$selectedModel resolved=$($latestRoute.resolvedModel)"
    } elseif (-not [string]$latestRoute.internalModel) {
        Add-Failure "model route audit did not record an Antigravity internal model"
    }
}

$healthAfterResult = Invoke-LocalJsonSafe "health-after" "/health"
$healthAfter = $healthAfterResult.payload
if (-not $healthAfterResult.ok) {
    Add-Failure "post-check health request failed: $($healthAfterResult.error.message)"
}

$antigravityLogSignals = Get-AntigravityLogSignals
$diagnosis = Get-Diagnosis `
    -Health $(if ($healthAfter) { $healthAfter } else { $healthBefore }) `
    -RequestError $(if ($requestResult -and -not $requestResult.ok) { $requestResult.error } else { $null }) `
    -RefreshError $(if (-not $refreshResult.ok) { $refreshResult.error } else { $null }) `
    -AccountError $(if (-not $accountResult.ok) { $accountResult.error } else { $null }) `
    -LogSignals $antigravityLogSignals
$diagnosisDetail = Get-DiagnosisDetail -Diagnosis $diagnosis -LogSignals $antigravityLogSignals

if ($AllowUnready -and $diagnosis -ne "ready") {
    $failures.Clear()
}

$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    diagnosis = $diagnosis
    diagnosisDetail = $diagnosisDetail
    detail = $diagnosisDetail
    suggestedAction = Get-SuggestedAction -Diagnosis $diagnosis -DiagnosisDetail $diagnosisDetail
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    baseUrl = $BaseUrl
    localProxyBypassed = $true
    antigravityLogSignals = $antigravityLogSignals
    account = [pscustomobject]@{
        ok = $accountResult.ok
        signedIn = if ($account) { $account.signedIn } else { $false }
        identityAvailable = if ($account) { $account.identityAvailable } else { $false }
        fingerprint = if ($account) { $account.fingerprint } else { "" }
        planName = if ($account) { $account.planName } else { "" }
        tierName = if ($account) { $account.tierName } else { "" }
        error = if (-not $accountResult.ok) { $accountResult.error } else { $null }
    }
    health = [pscustomobject]@{
        before = if ($healthBefore) {
            [pscustomobject]@{
                ok = $healthBefore.ok
                upstream = $healthBefore.upstream
                accountReady = $healthBefore.accountReady
                accountState = $healthBefore.accountState
                modelCount = $healthBefore.modelCount
                circuitState = $healthBefore.antigravityCircuitState
                retryAfterMs = $healthBefore.antigravityCircuitRetryAfterMs
            }
        } else { $null }
        after = if ($healthAfter) {
            [pscustomobject]@{
                ok = $healthAfter.ok
                upstream = $healthAfter.upstream
                accountReady = $healthAfter.accountReady
                accountState = $healthAfter.accountState
                modelCount = $healthAfter.modelCount
                circuitState = $healthAfter.antigravityCircuitState
                retryAfterMs = $healthAfter.antigravityCircuitRetryAfterMs
            }
        } else { $null }
    }
    refresh = [pscustomobject]@{
        ok = $refreshResult.ok
        error = $refreshResult.error
    }
    models = [pscustomobject]@{
        count = $models.Count
        selected = $selectedModel
        ids = @($models | ForEach-Object { [string]$_.id })
    }
    realRequest = [pscustomobject]@{
        attempted = $null -ne $requestResult
        ok = if ($requestResult) { [bool]$requestResult.ok -and ($requestText -match [regex]::Escape($requestMarker)) } else { $false }
        marker = $requestMarker
        text = $requestText
        error = if ($requestResult -and -not $requestResult.ok) { $requestResult.error } else { $null }
    }
    phaseSummary = [pscustomobject]@{
        accountOk = [bool]($accountResult.ok -and $account -and $account.signedIn -eq $true)
        refreshOk = [bool]$refreshResult.ok
        modelCount = $models.Count
        realRequestAttempted = $null -ne $requestResult
        realRequestOk = if ($requestResult) { [bool]$requestResult.ok -and ($requestText -match [regex]::Escape($requestMarker)) } else { $false }
        accountError = if (-not $accountResult.ok) { $accountResult.error.message } elseif ($account -and $account.signedIn -ne $true) { "not_signed_in_or_status_unavailable" } else { "" }
        refreshError = if (-not $refreshResult.ok) { $refreshResult.error.message } else { "" }
        realRequestError = if ($requestResult -and -not $requestResult.ok) { $requestResult.error.message } elseif ($null -eq $requestResult) { "not_attempted" } else { "" }
    }
    modelRouteAudit = [pscustomobject]@{
        ok = $routeAuditResult.ok
        latest = if ($latestRoute) {
            [pscustomobject]@{
                requestId = $latestRoute.requestId
                requestedModel = $latestRoute.requestedModel
                resolvedModel = $latestRoute.resolvedModel
                displayName = $latestRoute.displayName
                internalModel = $latestRoute.internalModel
                cascadeId = $latestRoute.cascadeId
                status = $latestRoute.status
            }
        } else { $null }
        error = if (-not $routeAuditResult.ok) { $routeAuditResult.error } else { $null }
    }
}

$reportStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportPaths = [pscustomobject]@{
    latest = (Join-Path $ReportRoot "latest-account-proxy-readiness.json")
    history = (Join-Path $ReportRoot "$reportStamp-account-proxy-readiness.json")
}
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths
$json = $result | ConvertTo-Json -Depth 10 -Compress
. (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
Write-AntiCodexJsonReport -LatestPath $reportPaths.latest -HistoryPath $reportPaths.history -Json $json -Encoding ([System.Text.UTF8Encoding]::new($false))
$json
if ($failures.Count -gt 0) { exit 1 }


