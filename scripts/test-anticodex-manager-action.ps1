#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [int]$TimeoutSec = 10,
    [switch]$RunSafeAction,
    [string]$SafeActionName = "refreshStatus",
    [switch]$RunUpdateCheckAction
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
        if (-not $body -and $_.ErrorDetails.Message) {
            $body = [string]$_.ErrorDetails.Message
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
$managerActionsByGroup = [ordered]@{}
$highImpactDangerActions = @()
$expectedActionGroups = [ordered]@{
    status = @("refreshStatus")
    modelSources = @("refreshModels", "accountSwitch")
    updates = @("updateCheck", "syncHost")
    troubleshooting = @("repairShortcuts", "diagnosticsBundle", "viewLatestReports")
    advanced = @(
        "accountProxy", "syncReadiness", "sourcePreflight", "mcpSkills",
        "pluginCapabilities", "refreshFeatures", "fastOverallNoTraffic",
        "overallNoTraffic", "stabilitySoak", "coldRelaunch", "postVerificationFull"
    )
}
$expectedHighImpactManagerActions = @(
    "syncHost",
    "refreshFeatures",
    "stabilitySoak",
    "coldRelaunch",
    "fastOverallNoTraffic",
    "overallNoTraffic",
    "postVerificationFull"
)
if ($manager) {
    $corsHeader = $manager.Headers["Access-Control-Allow-Origin"]
    if ($corsHeader) { Add-Failure "manager page exposes access-control-allow-origin: $corsHeader" }
    $managerHtml = [string]$manager.Content
    try {
        $bootstrap = Invoke-WebRequest -Uri "$BaseUrl/anticodex/manager/bootstrap" `
            -Headers @{ "Origin" = $BaseUrl; "Referer" = "$BaseUrl/anticodex/manager" } `
            -Proxy $null `
            -TimeoutSec $TimeoutSec `
            -UseBasicParsing
        $token = [string](($bootstrap.Content | ConvertFrom-Json).token)
        if (-not $token) { Add-Failure "manager bootstrap did not return an action token" }
    } catch {
        Add-Failure "manager bootstrap failed: $($_.Exception.Message)"
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
    if ($managerHtml -notmatch 'color-scheme:\s*light dark' -or $managerHtml -notmatch '@media \(prefers-color-scheme:\s*dark\)') {
        Add-Failure "manager page does not follow the operating-system light/dark theme"
    }
    if ($managerHtml -notmatch 'id="actionResult"') {
        Add-Failure "manager page is missing the action result output"
    }
    if ($managerHtml -notmatch 'document\.querySelectorAll\("button\[data-manager-action\]"\)') {
        Add-Failure "manager page is missing data-action button binding"
    }
    if ($managerHtml -notmatch 'buttons\.forEach\(\(item\) => \{ item\.disabled = true; \}\)' -or $managerHtml -notmatch 'buttons\.forEach\(\(item\) => \{ item\.disabled = false; \}\)') {
        Add-Failure "manager page action buttons do not disable and re-enable during requests"
    }
    if ($managerHtml -notmatch '/anticodex/manager/action') {
        Add-Failure "manager page is missing the local manager action endpoint"
    }
    $localOnlyNoticePattern = '只管理本机 Anti-Codex'
    $impactNoticePattern = '真实流量或重启'
    if ($managerHtml -notmatch $localOnlyNoticePattern -or $managerHtml -notmatch $impactNoticePattern) {
        Add-Failure "manager page is missing the Chinese local-only/high-impact notice"
    }

    $requiredManagerActions = @($expectedActionGroups.Values | ForEach-Object { @($_) })
    foreach ($requiredAction in $requiredManagerActions) {
        if ($managerHtml -notmatch ('data-manager-action="' + [regex]::Escape($requiredAction) + '"')) {
            Add-Failure "manager page is missing action button: $requiredAction"
        }
    }
    $managerActionNames = [regex]::Matches($managerHtml, 'data-manager-action="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

    foreach ($groupName in $expectedActionGroups.Keys) {
        $groupPattern = '<(?:section|details)[^>]*data-action-group="' + [regex]::Escape($groupName) + '"[\s\S]*?</(?:section|details)>'
        $section = [regex]::Match($managerHtml, $groupPattern)
        if (-not $section.Success) {
            Add-Failure "manager page is missing action group: $groupName"
            $managerActionsByGroup[$groupName] = @()
            continue
        }
        $actual = @([regex]::Matches($section.Value, 'data-manager-action="([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
        $managerActionsByGroup[$groupName] = $actual
        if (@(Compare-Object @($expectedActionGroups[$groupName]) $actual).Count -gt 0) {
            Add-Failure "manager action group '$groupName' does not match the approved inventory"
        }
    }
    $highImpactDangerActions = @([regex]::Matches($managerHtml, '<button class="danger" data-action="[^"]+" data-manager-action="([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
    if (@(Compare-Object $expectedHighImpactManagerActions $highImpactDangerActions).Count -gt 0) {
        Add-Failure "manager high-impact action buttons do not match the danger inventory"
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
        $request = [System.Net.HttpWebRequest]::Create($url)
        $request.Method = "GET"
        $request.Proxy = $null
        $request.Timeout = [Math]::Max(1, $RequestTimeoutSec) * 1000
        $request.ReadWriteTimeout = [Math]::Max(1, $RequestTimeoutSec) * 1000
        if ($Headers -and $Headers.Count -gt 0) {
            foreach ($key in $Headers.Keys) {
                $value = [string]$Headers[$key]
                if ($key -ieq "Referer") {
                    $request.Referer = $value
                } elseif ($key -ieq "User-Agent") {
                    $request.UserAgent = $value
                } else {
                    $request.Headers[$key] = $value
                }
            }
        }
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Dispose()
        return [pscustomobject]@{
            ok = $true
            status = [int]$response.StatusCode
            body = [string]$body
            contentType = [string]$response.ContentType
        }
    } catch {
        $statusCode = 0
        $body = ""
        $contentType = ""
        $errorResponse = if ($_.Exception.Response) { $_.Exception.Response } elseif ($_.Exception.InnerException -and $_.Exception.InnerException.Response) { $_.Exception.InnerException.Response } else { $null }
        if ($errorResponse) {
            try { $statusCode = [int]$errorResponse.StatusCode } catch {}
            try {
                $stream = $errorResponse.GetResponseStream()
                if ($stream) {
                    $reader = New-Object IO.StreamReader($stream)
                    $body = $reader.ReadToEnd()
                    $reader.Dispose()
                }
            } catch {}
            try { $contentType = [string]$errorResponse.ContentType } catch {}
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
    $encodedToken = [Uri]::EscapeDataString($token)
    $jsonpValid = Invoke-ManagerJsonp -Query "?action=$jsonpActionName&callback=test_cb&token=$encodedToken" -Headers @{
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
        actionGroups = $managerActionsByGroup
        highImpactActionNames = @($highImpactDangerActions)
        hasZhCn = [bool]($managerHtml -match '<html lang="zh-CN"')
        hasAdaptiveTheme = [bool](($managerHtml -match 'color-scheme:\s*light dark') -and ($managerHtml -match '@media \(prefers-color-scheme:\s*dark\)'))
        hasActionResult = [bool]($managerHtml -match 'id="actionResult"')
        hasButtonClickBinding = [bool]($managerHtml -match 'document\.querySelectorAll\("button\[data-manager-action\]"\)')
        hasDisableReenable = [bool](($managerHtml -match 'item\.disabled = true') -and ($managerHtml -match 'item\.disabled = false'))
        hasLocalOnlyImpactNotice = [bool](($managerHtml -match $localOnlyNoticePattern) -and ($managerHtml -match $impactNoticePattern))
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
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
if ($failures.Count -gt 0) { exit 1 }
