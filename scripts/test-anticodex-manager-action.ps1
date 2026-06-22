#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [int]$TimeoutSec = 10,
    [switch]$RunSafeAction,
    [string]$SafeActionName = "refreshStatus",
    [switch]$RunUpdateCheckAction,
    [switch]$RunSessionResetAction
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}
$BaseUrl = $BaseUrl.TrimEnd("/")
try {
    $baseUri = [Uri]$BaseUrl
    if ($baseUri.Scheme -eq "http" -and $baseUri.Port -gt 0 -and $baseUri.Host -notin @("127.0.0.1", "localhost")) {
        $BaseUrl = "http://127.0.0.1:$($baseUri.Port)"
    }
} catch {}
$failures = New-Object System.Collections.Generic.List[string]
$ActionTimeoutSec = [Math]::Max($TimeoutSec, 60)

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Invoke-ManagerPost {
    param(
        [hashtable]$Headers = @{},
        [string]$Body = '{"action":"__anticodex_probe__"}',
        [int]$RequestTimeoutSec = $TimeoutSec
    )
    try {
        $response = Invoke-WebRequest -Uri "$BaseUrl/anticodex/manager/action" `
            -Method Post `
            -Body $Body `
            -ContentType "application/json" `
            -Headers $Headers `
            -Proxy $null `
            -TimeoutSec $RequestTimeoutSec `
            -UseBasicParsing
        return [pscustomobject]@{
            ok = $true
            status = [int]$response.StatusCode
            body = [string]$response.Content
        }
    } catch {
        $statusCode = 0
        $body = ""
        if ($_.Exception.Response) {
            try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                if ($stream) {
                    $reader = New-Object IO.StreamReader($stream)
                    $body = $reader.ReadToEnd()
                    $reader.Dispose()
                }
            } catch {}
        }
        return [pscustomobject]@{
            ok = $false
            status = $statusCode
            body = $body
            error = $_.Exception.Message
        }
    }
}

$manager = $null
try {
    $manager = Invoke-WebRequest -Uri "$BaseUrl/anticodex/manager" -Proxy $null -TimeoutSec $TimeoutSec -UseBasicParsing
} catch {
    Add-Failure "manager page request failed: $($_.Exception.Message)"
}

$token = ""
$corsHeader = $null
$managerHtml = ""
$managerActionNames = @()
$dailyManagerActions = @()
$highImpactManagerActions = @()
$highImpactDangerCount = 0
$expectedDailyManagerActions = @(
    "refreshStatus",
    "refreshModels",
    "accountSwitch",
    "accountProxy",
    "syncReadiness",
    "repairShortcuts",
    "updateCheck",
    "sourcePreflight",
    "mcpSkills",
    "pluginCapabilities",
    "diagnosticsBundle",
    "viewLatestReports"
)
$expectedHighImpactManagerActions = @(
    "syncHost",
    "upstreamConfig",
    "refreshFeatures",
    "fastOverallNoTraffic",
    "overallNoTraffic",
    "postVerificationFull",
    "resetAntigravitySessionLock"
)
if ($manager) {
    $corsHeader = $manager.Headers["Access-Control-Allow-Origin"]
    if ($corsHeader) { Add-Failure "manager page exposes access-control-allow-origin: $corsHeader" }
    $managerHtml = [string]$manager.Content
    $match = [regex]::Match($managerHtml, 'const managerActionToken="([^"]+)"')
    if ($match.Success) {
        $token = $match.Groups[1].Value
    } else {
        Add-Failure "manager action token was not embedded in the local manager page"
    }
    if ($managerHtml -match "/anticodex/manager/open") {
        Add-Failure "manager page still references old external open endpoint"
    }
    if ($managerHtml -match "window\.open|target=`"_blank`"") {
        Add-Failure "manager page still contains external-window navigation"
    }
    if ($managerHtml -match "<iframe\b") {
        Add-Failure "manager page still contains iframe embedding"
    }
    if ($managerHtml -notmatch '<html lang="zh-CN"') {
        Add-Failure "manager page is not marked as zh-CN"
    }
    if ($managerHtml -notmatch 'color-scheme:light dark' -or $managerHtml -notmatch '@media \(prefers-color-scheme:light\)') {
        Add-Failure "manager page does not follow the operating-system light/dark theme"
    }
    if ($managerHtml -notmatch 'id="actionResult"') {
        Add-Failure "manager page is missing the action result output"
    }
    if ($managerHtml -notmatch 'document\.querySelectorAll\("button\[data-action\]"\)') {
        Add-Failure "manager page is missing data-action button binding"
    }
    if ($managerHtml -notmatch 'setActionButtonsDisabled\(true\)' -or $managerHtml -notmatch 'finally\{setActionButtonsDisabled\(false\);') {
        Add-Failure "manager page action buttons do not disable and re-enable during requests"
    }
    if ($managerHtml -notmatch '/anticodex/manager/action') {
        Add-Failure "manager page is missing the local manager action endpoint"
    }
    $hasRouteProviderFields = (
        $managerHtml -match '/anticodex/model-routes' -and
        $managerHtml -match 'function routeSummary' -and
        $managerHtml -match 'providerProtocol' -and
        $managerHtml -match 'transport' -and
        $managerHtml -match 'Provider'
    )
    if (-not $hasRouteProviderFields) {
        Add-Failure "manager page route summary is missing third-party provider/protocol/transport fields"
    }
    $noLoginNoticePattern = '\u4e0d\u8d70 ChatGPT \u767b\u5f55'
    $noTrafficNoticePattern = '\u4e0d\u6d88\u8017\u6a21\u578b\u6d41\u91cf'
    if ($managerHtml -notmatch $noLoginNoticePattern -or $managerHtml -notmatch $noTrafficNoticePattern) {
        Add-Failure "manager page is missing the Chinese no-login/no-traffic notice"
    }

    $requiredManagerActions = @($expectedDailyManagerActions + $expectedHighImpactManagerActions)
    foreach ($requiredAction in $requiredManagerActions) {
        if ($managerHtml -notmatch ('data-manager-action="' + [regex]::Escape($requiredAction) + '"')) {
            Add-Failure "manager page is missing action button: $requiredAction"
        }
    }
    $managerActionNames = [regex]::Matches($managerHtml, 'data-manager-action="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

    $dailySection = [regex]::Match($managerHtml, '<section class="action-section" data-action-group="daily"[\s\S]*?</section>')
    $highImpactSection = [regex]::Match($managerHtml, '<section class="action-section" data-action-group="high-impact"[\s\S]*?</section>')
    if (-not $dailySection.Success) { Add-Failure "manager page is missing the daily action group" }
    if (-not $highImpactSection.Success) { Add-Failure "manager page is missing the high-impact action group" }
    if ($dailySection.Success) {
        $dailyManagerActions = [regex]::Matches($dailySection.Value, 'data-manager-action="([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
    }
    if ($highImpactSection.Success) {
        $highImpactManagerActions = [regex]::Matches($highImpactSection.Value, 'data-manager-action="([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
        $highImpactDangerCount = [regex]::Matches($highImpactSection.Value, '<button[^>]*class="danger"').Count
    }
    if (@(Compare-Object $expectedDailyManagerActions $dailyManagerActions).Count -gt 0) {
        Add-Failure "manager daily action group does not match the approved safe action inventory"
    }
    if (@(Compare-Object $expectedHighImpactManagerActions $highImpactManagerActions).Count -gt 0) {
        Add-Failure "manager high-impact action group does not match the approved risk action inventory"
    }
    if ($highImpactDangerCount -ne $expectedHighImpactManagerActions.Count) {
        Add-Failure "manager high-impact action buttons are not all styled as danger buttons"
    }
}

$withoutToken = Invoke-ManagerPost
if ($withoutToken.status -ne 403) { Add-Failure "manager action without token returned $($withoutToken.status), expected 403" }

$badOrigin = $null
$nullOrigin = $null
$missingSource = $null
$sameOriginUnknown = $null
$safeAction = $null
$updateCheck = $null
if ($token) {
    $badOrigin = Invoke-ManagerPost -Headers @{
        "x-anticodex-manager-token" = $token
        "Origin" = "http://evil.example"
        "Referer" = "http://evil.example/"
    }
    if ($badOrigin.status -ne 403) { Add-Failure "manager action with bad origin returned $($badOrigin.status), expected 403" }

    $nullOrigin = Invoke-ManagerPost -Headers @{
        "x-anticodex-manager-token" = $token
        "Origin" = "null"
    }
    if ($nullOrigin.status -ne 403) { Add-Failure "manager action with null origin returned $($nullOrigin.status), expected 403" }

    $missingSource = Invoke-ManagerPost -Headers @{
        "x-anticodex-manager-token" = $token
    }
    if ($missingSource.status -ne 403) { Add-Failure "manager action with missing origin/referrer returned $($missingSource.status), expected 403" }

    $sameOriginUnknown = Invoke-ManagerPost -Headers @{
        "x-anticodex-manager-token" = $token
        "Origin" = $BaseUrl
        "Referer" = "$BaseUrl/anticodex/manager"
    }
    if ($sameOriginUnknown.status -ne 404) { Add-Failure "manager action same-origin unknown action returned $($sameOriginUnknown.status), expected 404" }
    if ($sameOriginUnknown.body -notmatch "Unknown Anti-Codex manager action") {
        Add-Failure "manager action same-origin probe did not reach the action router"
    }

    if ($RunSafeAction) {
        $safeActionBody = @{ action = $SafeActionName } | ConvertTo-Json -Compress
        $safeAction = Invoke-ManagerPost -Headers @{
            "x-anticodex-manager-token" = $token
            "Origin" = $BaseUrl
            "Referer" = "$BaseUrl/anticodex/manager"
        } -Body $safeActionBody -RequestTimeoutSec $ActionTimeoutSec
        if ($safeAction.status -ne 200) { Add-Failure "manager safe action '$SafeActionName' returned $($safeAction.status), expected 200" }
        if ($safeAction.body -and ($safeAction.body | ConvertFrom-Json).ok -ne $true) {
            Add-Failure "manager safe action '$SafeActionName' returned ok=false"
        }
    }

    if ($RunUpdateCheckAction) {
        $updateCheck = Invoke-ManagerPost -Headers @{
            "x-anticodex-manager-token" = $token
            "Origin" = $BaseUrl
            "Referer" = "$BaseUrl/anticodex/manager"
        } -Body '{"action":"updateCheck"}' -RequestTimeoutSec $ActionTimeoutSec
        if ($updateCheck.status -ne 200) { Add-Failure "manager updateCheck action returned $($updateCheck.status), expected 200" }
        if ($updateCheck.body -and ($updateCheck.body | ConvertFrom-Json).ok -ne $true) {
            Add-Failure "manager updateCheck action returned ok=false"
        }
    }

    $sessionResetResult = $null
    if ($RunSessionResetAction) {
        $isIdle = $false
        $diagnosticsErr = $null
        $lockActive = $null
        $lockQueued = $null
        $activeRequestCount = $null
        $canResetStaleLock = $false
        try {
            $diagResponse = Invoke-WebRequest -Uri "$BaseUrl/anticodex/diagnostics" -Method Get -Proxy $null -TimeoutSec $TimeoutSec -UseBasicParsing
            if ($diagResponse.StatusCode -eq 200) {
                $diagnostics = $diagResponse.Content | ConvertFrom-Json
                if ($diagnostics -and $diagnostics.antigravitySessionLock) {
                    $lockActive = $diagnostics.antigravitySessionLock.active
                    $lockQueued = $diagnostics.antigravitySessionLock.queued
                    if ($lockActive -eq $false -and $lockQueued -eq 0) {
                        $isIdle = $true
                    }
                    if ($diagnostics.activeAntigravityRequests -and $diagnostics.activeAntigravityRequests.PSObject.Properties.Match("active").Count -gt 0) {
                        $activeRequestCount = [int]$diagnostics.activeAntigravityRequests.active
                        if ($activeRequestCount -eq 0) {
                            $canResetStaleLock = $true
                        }
                    }
                } else {
                    $diagnosticsErr = "diagnostics output is missing antigravitySessionLock property"
                }
            } else {
                $diagnosticsErr = "diagnostics returned status $($diagResponse.StatusCode)"
            }
        } catch {
            $diagnosticsErr = $_.Exception.Message
        }

        if (-not $isIdle -and -not $canResetStaleLock) {
            $sessionResetResult = [pscustomobject]@{
                skipped = $true
                reason = if ($diagnosticsErr) { $diagnosticsErr } else { "Session lock is not safe to reset (active=$lockActive, queued=$lockQueued, activeRequests=$activeRequestCount)" }
            }
        } else {
            $resetBody = @{ action = "resetAntigravitySessionLock" } | ConvertTo-Json -Compress
            $resetResponse = Invoke-ManagerPost -Headers @{
                "x-anticodex-manager-token" = $token
                "Origin" = $BaseUrl
                "Referer" = "$BaseUrl/anticodex/manager"
            } -Body $resetBody -RequestTimeoutSec $ActionTimeoutSec
            
            $payloadOk = $false
            $resultOk = $false
            $hasActiveReleased = $false
            $hasQueuedCancelled = $false
            $hasSnapshot = $false
            
            if ($resetResponse.status -eq 200) {
                try {
                    $payload = $resetResponse.body | ConvertFrom-Json
                    if ($payload) {
                        if ($payload.ok -eq $true) { $payloadOk = $true }
                        if ($payload.result) {
                            if ($payload.result.ok -eq $true) { $resultOk = $true }
                            
                            $resObj = $null
                            if ($payload.result.PSObject.Properties.Match("activeReleased").Count -gt 0) {
                                $resObj = $payload.result
                            } elseif ($payload.result.result -and $payload.result.result.PSObject.Properties.Match("activeReleased").Count -gt 0) {
                                $resObj = $payload.result.result
                            }
                            
                            if ($resObj) {
                                if ($resObj.PSObject.Properties.Match("activeReleased").Count -gt 0) { $hasActiveReleased = $true }
                                if ($resObj.PSObject.Properties.Match("queuedCancelled").Count -gt 0) { $hasQueuedCancelled = $true }
                                if ($resObj.PSObject.Properties.Match("snapshot").Count -gt 0) { $hasSnapshot = $true }
                            }
                        }
                    }
                } catch {
                    Add-Failure "failed to parse session reset action response: $($_.Exception.Message)"
                }
            } else {
                Add-Failure "session reset action returned status $($resetResponse.status), expected 200"
            }
            
            if ($resetResponse.status -ne 200) { Add-Failure "session reset response status is $($resetResponse.status), expected 200" }
            if (-not $payloadOk) { Add-Failure "session reset response payload.ok is not true" }
            if (-not $resultOk) { Add-Failure "session reset response result.ok is not true" }
            if (-not $hasActiveReleased) { Add-Failure "session reset response result does not contain activeReleased" }
            if (-not $hasQueuedCancelled) { Add-Failure "session reset response result does not contain queuedCancelled" }
            if (-not $hasSnapshot) { Add-Failure "session reset response result does not contain snapshot" }
            
            $sessionResetResult = [pscustomobject]@{
                skipped = $false
                status = $resetResponse.status
                payloadOk = $payloadOk
                resultOk = $resultOk
                hasActiveReleased = $hasActiveReleased
                hasQueuedCancelled = $hasQueuedCancelled
                hasSnapshot = $hasSnapshot
                resetMode = if ($isIdle) { "idle" } else { "stale-lock" }
            }
        }
    }
}

# ── JSONP action-script bridge tests ──────────────────────────
function Invoke-ManagerJsonp {
    param(
        [string]$Query = "",
        [hashtable]$Headers = @{},
        [int]$RequestTimeoutSec = $TimeoutSec
    )
    try {
        $url = "$BaseUrl/anticodex/manager/action-script$Query"
        $webParams = @{
            Uri = $url
            Method = "Get"
            Proxy = $null
            TimeoutSec = $RequestTimeoutSec
            UseBasicParsing = $true
        }
        if ($Headers -and $Headers.Count -gt 0) {
            $webParams["Headers"] = $Headers
        }
        $response = Invoke-WebRequest @webParams
        return [pscustomobject]@{
            ok = $true
            status = [int]$response.StatusCode
            body = [string]$response.Content
            contentType = [string]$response.Headers["Content-Type"]
        }
    } catch {
        $statusCode = 0
        $body = ""
        $contentType = ""
        if ($_.Exception.Response) {
            try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                if ($stream) {
                    $reader = New-Object IO.StreamReader($stream)
                    $body = $reader.ReadToEnd()
                    $reader.Dispose()
                }
            } catch {}
            try { $contentType = [string]$_.Exception.Response.Headers["Content-Type"] } catch {}
        }
        return [pscustomobject]@{
            ok = $false
            status = $statusCode
            body = $body
            contentType = $contentType
            error = $_.Exception.Message
        }
    }
}

$jsonpActionName = "refreshStatus"

$jsonpNoToken = Invoke-ManagerJsonp -Query "?action=$jsonpActionName&callback=test"
if ($jsonpNoToken.status -ne 403) { Add-Failure "action-script without token returned $($jsonpNoToken.status), expected 403" }
if ($jsonpNoToken.contentType -notmatch "application/json") { Add-Failure "action-script without token content-type is not application/json: $($jsonpNoToken.contentType)" }

$jsonpBadToken = Invoke-ManagerJsonp -Query "?action=$jsonpActionName&callback=test&token=bad"
if ($jsonpBadToken.status -ne 403) { Add-Failure "action-script with bad token returned $($jsonpBadToken.status), expected 403" }
if ($jsonpBadToken.contentType -notmatch "application/json") { Add-Failure "action-script with bad token content-type is not application/json: $($jsonpBadToken.contentType)" }

$jsonpBadCallback = Invoke-ManagerJsonp -Query "?action=$jsonpActionName&callback=alert(1)&token=$token"
if ($jsonpBadCallback.status -ne 400) { Add-Failure "action-script with bad callback returned $($jsonpBadCallback.status), expected 400" }

$jsonpValid = $null
if ($token) {
    $jsonpValid = Invoke-ManagerJsonp -Query "?action=$jsonpActionName&callback=test_cb&token=$token" -Headers @{
        "Origin" = $BaseUrl
        "Referer" = "$BaseUrl/anticodex/manager"
    }
    if ($jsonpValid.status -ne 200) { Add-Failure "action-script with valid token returned $($jsonpValid.status), expected 200" }
    if ($jsonpValid.contentType -notmatch "application/javascript") { Add-Failure "action-script with valid token content-type is not application/javascript: $($jsonpValid.contentType)" }
    if ($jsonpValid.body -notmatch 'globalThis\["test_cb"\]\(') { Add-Failure "action-script with valid token did not call the callback correctly" }
    try {
        $jsonObj = $null
        $match = [regex]::Match($jsonpValid.body, 'globalThis\["test_cb"\]\((\{.*\})\)')
        if ($match.Success) { $jsonObj = $match.Groups[1].Value | ConvertFrom-Json }
        if (-not $jsonObj -or $jsonObj.ok -ne $true) { Add-Failure "action-script with valid token returned ok=false or unparseable" }
    } catch { Add-Failure "action-script with valid token callback body parse failed: $($_.Exception.Message)" }
}

$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    manager = [pscustomobject]@{
        hasToken = [bool]$token
        corsHeader = $corsHeader
    }
    page = [pscustomobject]@{
        actionCount = @($managerActionNames).Count
        actionNames = @($managerActionNames)
        dailyActionNames = @($dailyManagerActions)
        highImpactActionNames = @($highImpactManagerActions)
        highImpactDangerCount = $highImpactDangerCount
        hasZhCn = [bool]($managerHtml -match '<html lang="zh-CN"')
        hasAdaptiveTheme = [bool](($managerHtml -match 'color-scheme:light dark') -and ($managerHtml -match '@media \(prefers-color-scheme:light\)'))
        hasActionResult = [bool]($managerHtml -match 'id="actionResult"')
        hasButtonClickBinding = [bool]($managerHtml -match 'document\.querySelectorAll\("button\[data-action\]"\)')
        hasDisableReenable = [bool](($managerHtml -match 'setActionButtonsDisabled\(true\)') -and ($managerHtml -match 'finally\{setActionButtonsDisabled\(false\);'))
        hasNoLoginNoTrafficNotice = [bool](($managerHtml -match $noLoginNoticePattern) -and ($managerHtml -match $noTrafficNoticePattern))
        hasRouteProviderFields = [bool]$hasRouteProviderFields
        hasNoExternalWindowOpen = [bool]($managerHtml -notmatch "window\.open|target=`"_blank`"")
        hasNoIframe = [bool]($managerHtml -notmatch "<iframe\b")
    }
    probes = [pscustomobject]@{
        withoutTokenStatus = $withoutToken.status
        badOriginStatus = if ($badOrigin) { $badOrigin.status } else { $null }
        nullOriginStatus = if ($nullOrigin) { $nullOrigin.status } else { $null }
        sameOriginUnknownStatus = if ($sameOriginUnknown) { $sameOriginUnknown.status } else { $null }
        safeActionStatus = if ($safeAction) { $safeAction.status } else { $null }
        safeActionRan = [bool]$RunSafeAction
        safeActionName = $SafeActionName
        updateCheckStatus = if ($updateCheck) { $updateCheck.status } else { $null }
        updateCheckRan = [bool]$RunUpdateCheckAction
        sessionReset = if ($sessionResetResult) { $sessionResetResult } else { $null }
    }
    jsonp = [pscustomobject]@{
        actionName = $jsonpActionName
        noTokenStatus = $jsonpNoToken.status
        noTokenContentType = $jsonpNoToken.contentType
        badTokenStatus = $jsonpBadToken.status
        badCallbackStatus = $jsonpBadCallback.status
        validStatus = if ($jsonpValid) { $jsonpValid.status } else { $null }
        validContentType = if ($jsonpValid) { $jsonpValid.contentType } else { $null }
        validBodyHasCallback = if ($jsonpValid) { [bool]($jsonpValid.body -match 'globalThis\["test_cb"\]\(') } else { $false }
    }
}
Write-Output ($result | ConvertTo-Json -Depth 8 -Compress)
if ($failures.Count -gt 0) { exit 1 }
