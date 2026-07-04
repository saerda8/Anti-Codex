#Requires -Version 5.1
param(
    [string]$BaseUrl = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [string]$Model = $(if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "gemini-3.5-flash-low" }),
    [int]$TimeoutSec = 240,
    [switch]$AllowRealTraffic
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$failures = [System.Collections.Generic.List[string]]::new()
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$marker = "REPORT_SITE_MARKER_$stamp"
$artifactDir = Join-Path $ReportRoot "real-report-site\$stamp"
$started = Get-Date

function Add-Failure { param([string]$Message) $failures.Add($Message) | Out-Null }

function Resolve-BaseUrl {
    if (-not $BaseUrl) {
        $resolver = Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1"
        if (Test-Path -LiteralPath $resolver -PathType Leaf) { return [string](& $resolver) }
        return "http://127.0.0.1:8484"
    }
    return $BaseUrl.TrimEnd("/")
}

function Save-Report {
    param($Payload)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $json = $Payload | ConvertTo-Json -Depth 32 -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    $latest = Join-Path $ReportRoot "latest-real-report-site.json"
    $history = Join-Path $ReportRoot "$stamp-real-report-site.json"
    Write-AntiCodexJsonReport -LatestPath $latest -HistoryPath $history -Json $json -Encoding $utf8NoBom
    $Payload | Add-Member -NotePropertyName report -NotePropertyValue ([pscustomobject]@{ latest = $latest; history = $history }) -Force
}

function Complete-Skipped {
    param([string]$Reason)
    $payload = [pscustomobject]@{
        ok = $true
        reportName = "real-report-site"
        skipped = $true
        requestedRealTraffic = $false
        usedRealTraffic = $false
        behaviorCovered = $false
        coverageKind = "skipped"
        reason = $Reason
        elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
    }
    Save-Report $payload
    Write-Output ($payload | ConvertTo-Json -Depth 24 -Compress)
    exit 0
}

function Invoke-ResponsesJson {
    param([hashtable]$Body)
    $json = $Body | ConvertTo-Json -Depth 32 -Compress
    return Invoke-RestMethod `
        -Uri "$script:ResolvedBaseUrl/v1/responses" `
        -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
        -TimeoutSec $TimeoutSec `
        -Proxy $null
}

function Invoke-ResponsesJsonWithRetry {
    param(
        [hashtable]$Body,
        [string]$Stage
    )
    $lastError = $null
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        try { return Invoke-ResponsesJson $Body } catch {
            $lastError = $_
            $message = $_.Exception.Message
            $retryable = $message -match "connection.*closed|ECONNRESET|temporarily unavailable|timeout"
            if (-not $retryable -or $attempt -ge 2) { throw }
            Start-Sleep -Seconds 2
        }
    }
    throw $lastError
}

function Get-ResponseItems {
    param($Response)
    if ($Response -and $Response.output) { return @($Response.output) }
    return @()
}

function Get-ResponseText {
    param($Response)
    $parts = foreach ($item in (Get-ResponseItems $Response)) {
        if ($item.type -ne "message") { continue }
        foreach ($content in @($item.content)) {
            if ($content.text) { [string]$content.text }
        }
    }
    return ($parts -join "`n").Trim()
}

function Read-ToolArguments {
    param($Call)
    if (-not $Call -or -not $Call.arguments) { return $null }
    try { return $Call.arguments | ConvertFrom-Json } catch { Add-Failure "tool arguments are invalid JSON: $($_.Exception.Message)"; return $null }
}

function Convert-ToRelativePath {
    param([string]$Path)
    $normalized = $Path -replace "\\", "/"
    $normalized = $normalized.TrimStart("/")
    if ($normalized -match "\.\." -or $normalized -match "^[A-Za-z]:") { throw "unsafe artifact path: $Path" }
    return $normalized
}

function Write-ArtifactFiles {
    param($Arguments)
    New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
    $written = @()
    if ($Arguments.PSObject.Properties.Match("report_md").Count -gt 0 -or $Arguments.PSObject.Properties.Match("index_html").Count -gt 0) {
        $pairs = @(
            [pscustomobject]@{ path = "report.md"; content = [string]$Arguments.report_md },
            [pscustomobject]@{ path = "index.html"; content = [string]$Arguments.index_html }
        )
    } else {
        $pairs = @($Arguments.files)
    }
    foreach ($file in @($pairs)) {
        $relative = Convert-ToRelativePath ([string]$file.path)
        $target = Join-Path $artifactDir $relative
        $parent = Split-Path -Parent $target
        if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        [IO.File]::WriteAllText($target, [string]$file.content, [Text.UTF8Encoding]::new($false))
        $written += $relative
    }
    return $written
}

function Get-Urls {
    param([string]$Text)
    return @([regex]::Matches($Text, "https?://[^\s)>'""]+") | ForEach-Object { $_.Value.TrimEnd([char[]]@(".", ",", ";", [char]0x60)) } | Select-Object -Unique)
}

if (-not $AllowRealTraffic) {
    Complete-Skipped "real report-site verification is opt-in; rerun with -AllowRealTraffic"
}

$script:ResolvedBaseUrl = Resolve-BaseUrl
$health = $null
$search = $null
$artifact = $null
$call = $null
$arguments = $null
$writtenFiles = @()
$searchText = ""
$reportText = ""
$htmlText = ""
$sourceUrls = @()
$toolCallAttemptCount = 0
$toolCallRetryReason = ""

try {
    $health = Invoke-RestMethod -Uri "$script:ResolvedBaseUrl/health" -Proxy $null -TimeoutSec 8
    if ($health.ok -ne $true) { Add-Failure "health is not ok" }

    $searchPrompt = @(
        "Use web_search to research recent OpenAI Codex updates.",
        "Return a concise Chinese evidence brief with at least three source URLs. Keep the answer under 1200 characters.",
        "Do not create files yet. Do not say browsing is unavailable unless a real web_search call failed."
    ) -join "`n"

    $search = Invoke-ResponsesJsonWithRetry -Stage "search" -Body @{
        model = $Model
        stream = $false
        store = $true
        input = @(@{
            type = "message"
            role = "user"
            content = @(@{ type = "input_text"; text = $searchPrompt })
        })
    }
    $searchText = Get-ResponseText $search
    if ($searchText.Length -gt 2400) { $searchText = $searchText.Substring(0, 2400) }
    $sourceUrls = @(Get-Urls $searchText)
    if (-not $search.id) { Add-Failure "search response did not contain an id" }
    if ($sourceUrls.Count -lt 3) { Add-Failure "web research did not produce at least three source URLs" }
    if ($searchText -notmatch "Codex|OpenAI") { Add-Failure "web research did not mention Codex/OpenAI" }
    if ($searchText -notmatch "[\u4e00-\u9fff]") { Add-Failure "web research was not Chinese" }
    if ($searchText -match "web_search.{0,40}(unavailable|not available|missing|不可用|缺少)") { Add-Failure "web research reported missing web_search" }

    $writeTool = @{
        type = "function"
        name = "write_report_site"
        description = "Required artifact writer. Use this tool call, not prose, to write report.md and index.html content."
        parameters = @{
            type = "object"
            properties = @{
                report_md = @{ type = "string"; minLength = 200; description = "Complete UTF-8 markdown content for report.md." }
                index_html = @{ type = "string"; minLength = 300; description = "Complete standalone UTF-8 HTML content for index.html." }
                marker = @{ type = "string" }
            }
            required = @("report_md", "index_html", "marker")
            additionalProperties = $false
        }
    }

    $artifactPrompt = @(
        "Evidence from the completed Anti-Codex web research:",
        $searchText,
        "",
        "Based only on the previous web research, emit a write_report_site function_call exactly once.",
        "This turn is invalid unless the output item type is function_call with name write_report_site.",
        "Use report_md for the complete report.md content and index_html for the complete index.html content.",
        "report_md requirements: Chinese title, three update bullets, each with a raw source URL, a short risk/recommendation section, and marker $marker.",
        "index_html requirements: standalone HTML, Chinese visible content, links to the source URLs, a link to report.md, a compact visual layout, and marker $marker.",
        "Do not answer in prose. Do not explain. Do not say you will write files. Only call write_report_site."
    ) -join "`n"

    $forcedToolChoice = @{ type = "function"; function = @{ name = "write_report_site" } }
    $toolCallAttemptCount = 1
    $artifact = Invoke-ResponsesJsonWithRetry -Stage "artifact" -Body @{
        model = $Model
        stream = $false
        store = $true
        tool_choice = $forcedToolChoice
        tools = @($writeTool)
        input = @(@{
            type = "message"
            role = "user"
            content = @(@{ type = "input_text"; text = $artifactPrompt })
        })
    }

    $call = @(Get-ResponseItems $artifact | Where-Object { $_.type -eq "function_call" -and $_.name -eq "write_report_site" }) | Select-Object -First 1
    if (-not $call -or -not $call.call_id) {
        $toolCallRetryReason = "missing_write_report_site_function_call"
        $toolCallAttemptCount = 2
        $retryPrompt = @(
            "MUST emit a function_call now. The only valid response is write_report_site.",
            "Do not return markdown prose in the assistant message.",
            "report_md must be complete Chinese Markdown with marker $marker and these raw source URLs:",
            ($sourceUrls -join "`n"),
            "index_html must be complete standalone HTML with Chinese text, a report.md link, the same source URLs, and marker $marker.",
            "Use the write_report_site tool arguments report_md, index_html, and marker. marker must exactly equal $marker."
        ) -join "`n"
        $artifact = Invoke-ResponsesJsonWithRetry -Stage "artifact_retry" -Body @{
            model = $Model
            stream = $false
            store = $true
            tool_choice = $forcedToolChoice
            tools = @($writeTool)
            input = @(@{
                type = "message"
                role = "user"
                content = @(@{ type = "input_text"; text = $retryPrompt })
            })
        }
        $call = @(Get-ResponseItems $artifact | Where-Object { $_.type -eq "function_call" -and $_.name -eq "write_report_site" }) | Select-Object -First 1
    }
    if (-not $artifact.id) { Add-Failure "artifact response did not contain an id" }
    if (-not $call -or -not $call.call_id) { Add-Failure "artifact response did not emit write_report_site function_call" }
    $arguments = Read-ToolArguments $call
    if ($arguments) {
        if ([string]$arguments.marker -ne $marker) { Add-Failure "artifact marker mismatch" }
        $writtenFiles = Write-ArtifactFiles $arguments
    }

    foreach ($required in @("report.md", "index.html")) {
        if ($writtenFiles -notcontains $required) { Add-Failure "missing required artifact file: $required" }
    }

    $reportPath = Join-Path $artifactDir "report.md"
    $htmlPath = Join-Path $artifactDir "index.html"
    if (Test-Path -LiteralPath $reportPath -PathType Leaf) { $reportText = [IO.File]::ReadAllText($reportPath, [Text.Encoding]::UTF8) }
    if (Test-Path -LiteralPath $htmlPath -PathType Leaf) { $htmlText = [IO.File]::ReadAllText($htmlPath, [Text.Encoding]::UTF8) }

    $reportUrls = @(Get-Urls $reportText)
    $htmlUrls = @(Get-Urls $htmlText)
    $sharedReportUrls = @($sourceUrls | Where-Object { $reportText.Contains($_) })
    $sharedHtmlUrls = @($sourceUrls | Where-Object { $htmlText.Contains($_) })

    if ($reportText -notmatch [regex]::Escape($marker)) { Add-Failure "report.md missing marker" }
    if ($htmlText -notmatch [regex]::Escape($marker)) { Add-Failure "index.html missing marker" }
    if ($reportText -notmatch "[\u4e00-\u9fff]") { Add-Failure "report.md missing Chinese content" }
    if ($htmlText -notmatch "[\u4e00-\u9fff]") { Add-Failure "index.html missing Chinese content" }
    if ($reportText -notmatch "Codex|OpenAI") { Add-Failure "report.md missing Codex/OpenAI content" }
    if ($htmlText -notmatch "Codex|OpenAI") { Add-Failure "index.html missing Codex/OpenAI content" }
    if ($reportUrls.Count -lt 3) { Add-Failure "report.md has fewer than three source URLs" }
    if ($htmlUrls.Count -lt 3) { Add-Failure "index.html has fewer than three source URLs" }
    if ($sharedReportUrls.Count -lt 1) { Add-Failure "report.md did not reuse any URL from the web research" }
    if ($sharedHtmlUrls.Count -lt 1) { Add-Failure "index.html did not reuse any URL from the web research" }
    if ($htmlText -notmatch "<html|<!doctype" -or $htmlText -notmatch "</html>") { Add-Failure "index.html is not a complete HTML document" }
    if ($htmlText -notmatch "report\.md") { Add-Failure "index.html does not link to report.md" }

    $payload = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        reportName = "real-report-site"
        requestedRealTraffic = $true
        usedRealTraffic = $true
        behaviorCovered = ($failures.Count -eq 0)
        coverageKind = "real-traffic-report-site"
        failures = @($failures)
        model = $Model
        baseUrl = $script:ResolvedBaseUrl
        elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
        marker = $marker
        search_response_id = if ($search) { [string]$search.id } else { "" }
        artifact_response_id = if ($artifact) { [string]$artifact.id } else { "" }
        call_id = if ($call) { [string]$call.call_id } else { "" }
        toolCallAttemptCount = $toolCallAttemptCount
        toolCallRetryReason = $toolCallRetryReason
        sourceUrls = @($sourceUrls)
        artifact = [pscustomobject]@{
            directory = $artifactDir
            files = @($writtenFiles)
            reportUrlCount = $reportUrls.Count
            htmlUrlCount = $htmlUrls.Count
            sharedReportUrlCount = $sharedReportUrls.Count
            sharedHtmlUrlCount = $sharedHtmlUrls.Count
        }
        health = $health
    }
    Save-Report $payload
    Write-Output ($payload | ConvertTo-Json -Depth 32 -Compress)
    if (-not $payload.ok) { exit 1 }
} catch {
    Add-Failure $_.Exception.Message
    $payload = [pscustomobject]@{
        ok = $false
        reportName = "real-report-site"
        requestedRealTraffic = $true
        usedRealTraffic = $true
        behaviorCovered = $false
        coverageKind = "real-traffic-report-site"
        failures = @($failures)
        model = $Model
        baseUrl = $script:ResolvedBaseUrl
        elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
        marker = $marker
        search_response_id = if ($search) { [string]$search.id } else { "" }
        artifact_response_id = if ($artifact) { [string]$artifact.id } else { "" }
        artifact = [pscustomobject]@{ directory = $artifactDir; files = @($writtenFiles) }
    }
    Save-Report $payload
    Write-Output ($payload | ConvertTo-Json -Depth 32 -Compress)
    exit 1
}
