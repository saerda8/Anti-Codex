[CmdletBinding()]
param(
    [string]$BaseUrl = "http://127.0.0.1:8484",
    [string]$FixedRouteHealthUrl = "http://127.0.0.1:18487/anticodex/fixed-route/health",
    [string]$Model = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [string]$StateRoot = $(Join-Path $env:APPDATA "anticodex"),
    [string]$LockName = "Local\AntiCodex.RealTrafficBridge",
    [int]$TimeoutSec = 90,
    [switch]$AllowRealTraffic
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "anticodex-real-traffic-lock.psm1") -Force
. (Join-Path $PSScriptRoot "anticodex-report-io.ps1")

$startedAt = [DateTime]::UtcNow
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$marker = "GATE8_QUOTA_READY_$stamp"
$requestCount = 0
$lock = $null

function Get-TextSha256 {
    param([string]$Text)

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$Text)
        return ($sha256.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join ""
    } finally {
        $sha256.Dispose()
    }
}

function Get-CompactText {
    param([string]$Text, [int]$MaxLength = 500)

    $value = ([string]$Text -replace "\s+", " ").Trim()
    if ($value.Length -le $MaxLength) { return $value }
    return $value.Substring(0, $MaxLength)
}

function Save-ProbeReport {
    param([System.Collections.IDictionary]$Payload)

    $latestPath = Join-Path $ReportRoot "latest-gate8-quota-probe.json"
    $historyPath = Join-Path $ReportRoot "$stamp-gate8-quota-probe.json"
    $Payload["report"] = [ordered]@{
        latest = $latestPath
        history = $historyPath
    }
    $json = $Payload | ConvertTo-Json -Depth 12 -Compress
    $encoding = [Text.UTF8Encoding]::new($false)
    Write-AntiCodexJsonReport -LatestPath $latestPath -HistoryPath $historyPath -Json $json -Encoding $encoding
    return $Payload
}

function Invoke-SingleChatRequest {
    param([string]$Uri, [hashtable]$RequestBody, [string]$LocalProxyKey)

    $json = $RequestBody | ConvertTo-Json -Depth 12 -Compress
    try {
        $response = Invoke-WebRequest `
            -Uri $Uri `
            -Method Post `
            -Headers @{ Authorization = "Bearer $LocalProxyKey" } `
            -ContentType "application/json; charset=utf-8" `
            -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
            -TimeoutSec $TimeoutSec `
            -Proxy $null `
            -UseBasicParsing
        return [pscustomobject]@{
            statusCode = [int]$response.StatusCode
            body = [string]$response.Content
            transportError = ""
        }
    } catch {
        $statusCode = 0
        $responseBody = ""
        $exceptionMessage = [string]$_.Exception.Message
        $webResponse = $_.Exception.Response
        if ($webResponse) {
            try { $statusCode = [int]$webResponse.StatusCode } catch {}
            try {
                $stream = $webResponse.GetResponseStream()
                if ($stream) {
                    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
                    try { $responseBody = $reader.ReadToEnd() } finally { $reader.Dispose() }
                }
            } catch {}
        }
        if ($statusCode -eq 0 -and $exceptionMessage -match "(?<!\d)([45]\d\d)(?!\d)") {
            $statusCode = [int]$Matches[1]
        }
        return [pscustomobject]@{
            statusCode = $statusCode
            body = $responseBody
            transportError = Get-CompactText $exceptionMessage
        }
    }
}

if (-not $AllowRealTraffic) {
    [ordered]@{
        schema = "anticodex-gate8-quota-probe-v1"
        reportName = "gate8-quota-probe"
        ok = $true
        skipped = $true
        requestedRealTraffic = $false
        usedRealTraffic = $false
        requestCount = 0
        model = $Model
        reason = "real traffic is opt-in; rerun with -AllowRealTraffic after the quota window"
        generatedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Depth 8 -Compress
    exit 0
}

$lock = Enter-AntiCodexRealTrafficLock -Name $LockName -WaitSeconds 0
if (-not $lock.acquired) {
    [ordered]@{
        schema = "anticodex-gate8-quota-probe-v1"
        reportName = "gate8-quota-probe"
        ok = $true
        skipped = $true
        busy = $true
        requestedRealTraffic = $true
        usedRealTraffic = $false
        requestCount = 0
        model = $Model
        reason = "another Anti-Codex real-traffic verifier is running"
        generatedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Depth 8 -Compress
    exit 0
}

$preflight = [ordered]@{
    routeReady = $false
    accountReady = $false
    fixedRouteModel = ""
    modelMatchesFixedRoute = $false
    selectedModelPresent = $false
    modelCount = 0
    adapterPort = 0
}
$result = $null

try {
    $route = Invoke-RestMethod -Uri $FixedRouteHealthUrl -Method Get -TimeoutSec 10 -Proxy $null
    $account = Invoke-RestMethod -Uri "$BaseUrl/anticodex/account" -Method Get -TimeoutSec 10 -Proxy $null
    $catalog = Invoke-RestMethod -Uri "$BaseUrl/models" -Method Get -TimeoutSec 10 -Proxy $null
    $modelIds = @($catalog.data | ForEach-Object { [string]$_.id } | Where-Object { $_ })

    $preflight.routeReady = $route.ok -eq $true -and $route.state -eq "ready" -and $route.provider -eq "antigravity"
    $preflight.accountReady = $account.signedIn -eq $true -and $account.identityAvailable -eq $true
    $fixedRouteModel = ""
    if ($route.route -and $route.route.model) {
        $fixedRouteModel = ([string]$route.route.model).Trim()
    } elseif ($route.model) {
        $fixedRouteModel = ([string]$route.model).Trim()
    }
    if (-not $Model) { $Model = $fixedRouteModel }
    $Model = ([string]$Model).Trim()
    $preflight.fixedRouteModel = $fixedRouteModel
    $preflight.modelMatchesFixedRoute = [string]::Equals($Model, $fixedRouteModel, [StringComparison]::OrdinalIgnoreCase)
    if ($preflight.modelMatchesFixedRoute) { $Model = $fixedRouteModel }
    $preflight.selectedModelPresent = $modelIds -contains $Model
    $preflight.modelCount = $modelIds.Count
    $preflight.adapterPort = [int]$route.ports.adapter

    if (-not $preflight.routeReady) { throw "fixed Antigravity route is not ready" }
    if (-not $preflight.accountReady) { throw "signed-in Antigravity account identity is not ready" }
    if (-not $preflight.fixedRouteModel) { throw "fixed Antigravity route did not report a model" }
    if (-not $preflight.modelMatchesFixedRoute) { throw "selected model does not match the fixed Antigravity route: $Model" }
    if (-not $preflight.selectedModelPresent) { throw "selected model is absent from the current model catalog: $Model" }
    if ($preflight.adapterPort -lt 1 -or $preflight.adapterPort -gt 65535) { throw "fixed route returned an invalid adapter port" }

    $proxyUrl = [uri]([string]$route.route.codexBaseUrl)
    if (-not $proxyUrl.IsAbsoluteUri -or $proxyUrl.Scheme -ne 'http' -or -not $proxyUrl.IsLoopback -or $proxyUrl.UserInfo -or $proxyUrl.Query -or $proxyUrl.Fragment) {
        throw "fixed route returned an invalid local proxy URL"
    }
    $authFile = Join-Path $StateRoot 'codex-home-deepseek-app\auth.json'
    $localProxyKey = [string]((Get-Content -Raw -LiteralPath $authFile | ConvertFrom-Json).OPENAI_API_KEY)
    if (-not $localProxyKey) { throw "local proxy credential is unavailable" }
    $requestCount = 1
    $chat = Invoke-SingleChatRequest -Uri "$($proxyUrl.AbsoluteUri.TrimEnd('/'))/responses" -LocalProxyKey $localProxyKey -RequestBody @{
        model = $Model
        stream = $false
        temperature = 0
        max_output_tokens = 64
        input = @(@{
            role = "user"
            content = @(@{ type = 'input_text'; text = "Reply with exactly $marker and nothing else." })
        })
    }

    $payload = $null
    if ($chat.body) {
        try { $payload = $chat.body | ConvertFrom-Json } catch {}
    }
    $content = ""
    $finishReason = ""
    $errorType = ""
    $errorCode = ""
    $payloadErrorMessage = ""
    if ($payload) {
        $content = (@($payload.output | Where-Object { $_.type -eq 'message' } | ForEach-Object { $_.content } | Where-Object { $_.type -eq 'output_text' } | ForEach-Object { [string]$_.text }) -join '')
        $finishReason = [string]$payload.status
        if ($payload.error) {
            $errorType = [string]$payload.error.type
            $errorCode = [string]$payload.error.code
            $payloadErrorMessage = [string]$payload.error.message
        }
    }
    $markerMatched = $content.Trim() -eq $marker
    $errorMessage = Get-CompactText $payloadErrorMessage
    if (-not $errorMessage) { $errorMessage = Get-CompactText $chat.transportError }
    $quotaReady = $chat.statusCode -eq 200 -and $markerMatched
    $failureType = if ($quotaReady) {
        ""
    } elseif ($chat.statusCode -eq 429 -or $errorMessage -match "429|RESOURCE_EXHAUSTED|quota|limit reached|limit exceeded") {
        "quota_exhausted"
    } elseif ($chat.statusCode -in @(401, 403)) {
        "account_or_auth"
    } elseif ($chat.statusCode -eq 200) {
        "unexpected_model_output"
    } else {
        "transport_or_provider"
    }

    $result = [ordered]@{
        schema = "anticodex-gate8-quota-probe-v1"
        reportName = "gate8-quota-probe"
        ok = $quotaReady
        quotaReady = $quotaReady
        formalGateEvidence = $false
        longTaskStarted = $false
        requestedRealTraffic = $true
        usedRealTraffic = $true
        requestCount = $requestCount
        model = $Model
        markerMatched = $markerMatched
        preflight = $preflight
        response = [ordered]@{
            statusCode = $chat.statusCode
            finishReason = $finishReason
            contentLength = $content.Length
            contentSha256 = if ($content) { Get-TextSha256 $content } else { "" }
            errorType = $errorType
            errorCode = $errorCode
            errorMessage = $errorMessage
        }
        failureType = $failureType
        failures = [string[]]@(if (-not $quotaReady) { "bounded quota probe failed: $failureType" })
        generatedAt = [DateTime]::UtcNow.ToString("o")
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    }
} catch {
    $failureMessage = Get-CompactText $_.Exception.Message
    $failureLocation = Get-CompactText $_.InvocationInfo.PositionMessage
    $result = [ordered]@{
        schema = "anticodex-gate8-quota-probe-v1"
        reportName = "gate8-quota-probe"
        ok = $false
        quotaReady = $false
        formalGateEvidence = $false
        longTaskStarted = $false
        requestedRealTraffic = $true
        usedRealTraffic = $requestCount -eq 1
        requestCount = $requestCount
        model = $Model
        markerMatched = $false
        preflight = $preflight
        response = $null
        failureType = if ($requestCount -eq 0) { "preflight" } else { "transport_or_provider" }
        failures = @((Get-CompactText "$failureMessage $failureLocation"))
        generatedAt = [DateTime]::UtcNow.ToString("o")
        elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    }
} finally {
    Exit-AntiCodexRealTrafficLock -Lock $lock
}

$saved = Save-ProbeReport -Payload $result
$saved | ConvertTo-Json -Depth 12 -Compress
exit $(if ($saved.ok) { 0 } else { 1 })
