[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 8
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$expected = @(
    [pscustomobject]@{ id = "gemini-3.5-flash-low"; display_name = "Gemini 3.5 Flash (Low)"; reasoning_level = "low"; thinking_budget = 4000; min_thinking_budget = 32 },
    [pscustomobject]@{ id = "gemini-3-flash-agent"; display_name = "Gemini 3.5 Flash (High)"; reasoning_level = "high"; thinking_budget = 10000; min_thinking_budget = 32 },
    [pscustomobject]@{ id = "gemini-3.5-flash-extra-low"; display_name = "Gemini 3.5 Flash (Extra Low)"; reasoning_level = "low"; thinking_budget = 1000; min_thinking_budget = 32 },
    [pscustomobject]@{ id = "gemini-3.1-pro-low"; display_name = "Gemini 3.1 Pro (Low)"; reasoning_level = "low"; thinking_budget = 1001; min_thinking_budget = 128 },
    [pscustomobject]@{ id = "gemini-pro-agent"; display_name = "Gemini 3.1 Pro (High)"; reasoning_level = "high"; thinking_budget = 10001; min_thinking_budget = 128 },
    [pscustomobject]@{ id = "claude-sonnet-4-6"; display_name = "Claude Sonnet 4.6 (Thinking)"; reasoning_level = "xhigh"; thinking_budget = 1024; min_thinking_budget = 32 },
    [pscustomobject]@{ id = "claude-opus-4-6-thinking"; display_name = "Claude Opus 4.6 (Thinking)"; reasoning_level = "xhigh"; thinking_budget = 1024; min_thinking_budget = 32 },
    [pscustomobject]@{ id = "gpt-oss-120b-medium"; display_name = "GPT-OSS 120B (Medium)"; reasoning_level = "medium"; thinking_budget = 8192; min_thinking_budget = 32 }
)

$failures = New-Object System.Collections.Generic.List[string]
$models = @()
$startedAt = [DateTime]::UtcNow

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

try {
    $requestArgs = @{
        Uri = "$BaseUrl/v1/models"
        Method = "GET"
        Proxy = $null
        TimeoutSec = $TimeoutSec
    }
    $response = Invoke-RestMethod @requestArgs
    $models = @($response.data)
} catch {
    Add-Failure "models request failed: $($_.Exception.Message)"
}

if ($models.Count -ne $expected.Count) {
    Add-Failure "model count mismatch: expected $($expected.Count), got $($models.Count)"
}

$duplicateIds = @($models | Group-Object id | Where-Object Count -gt 1 | ForEach-Object Name)
if ($duplicateIds.Count -gt 0) {
    Add-Failure "duplicate model ids: $($duplicateIds -join ', ')"
}

$expectedIds = @($expected | ForEach-Object id)
$unexpectedIds = @($models | Where-Object { $expectedIds -notcontains [string]$_.id } | ForEach-Object id)
if ($unexpectedIds.Count -gt 0) {
    Add-Failure "unexpected model ids: $($unexpectedIds -join ', ')"
}

foreach ($wanted in $expected) {
    $actual = @($models | Where-Object { [string]$_.id -eq $wanted.id })
    if ($actual.Count -ne 1) {
        Add-Failure "model $($wanted.id) expected once, got $($actual.Count)"
        continue
    }

    $model = $actual[0]
    foreach ($property in @("display_name", "reasoning_level", "supports_thinking", "thinking_budget")) {
        if (-not (Has-Property $model $property)) {
            Add-Failure "model $($wanted.id) missing $property"
        }
    }
    if ([string]$model.display_name -ne $wanted.display_name) { Add-Failure "model $($wanted.id) display_name drifted: $($model.display_name)" }
    if ([string]$model.reasoning_level -ne $wanted.reasoning_level) { Add-Failure "model $($wanted.id) reasoning_level drifted: $($model.reasoning_level)" }
    if ($model.supports_thinking -ne $true) { Add-Failure "model $($wanted.id) supports_thinking is not true" }
    if ([int64]$model.thinking_budget -ne [int64]$wanted.thinking_budget) { Add-Failure "model $($wanted.id) thinking_budget drifted: $($model.thinking_budget)" }
    if ($null -eq $wanted.min_thinking_budget) {
        if ((Has-Property $model "min_thinking_budget") -and $null -ne $model.min_thinking_budget) { Add-Failure "model $($wanted.id) min_thinking_budget drifted: $($model.min_thinking_budget)" }
    } elseif (-not (Has-Property $model "min_thinking_budget")) {
        Add-Failure "model $($wanted.id) missing min_thinking_budget"
    } elseif ([int64]$model.min_thinking_budget -ne [int64]$wanted.min_thinking_budget) {
        Add-Failure "model $($wanted.id) min_thinking_budget drifted: $($model.min_thinking_budget)"
    }
}

$report = [pscustomobject]@{
    ok = $failures.Count -eq 0
    checkedAt = [DateTime]::UtcNow.ToString("o")
    durationMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    baseUrl = $BaseUrl
    expectedModelCount = $expected.Count
    actualModelCount = $models.Count
    failures = @($failures)
    models = @($models | Select-Object id, display_name, reasoning_level, supports_thinking, thinking_budget, min_thinking_budget)
}

New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
$json = $report | ConvertTo-Json -Depth 8
$utf8 = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
Write-AntiCodexTextAtomic -Path (Join-Path $ReportRoot "latest-model-thinking.json") -Text $json -Encoding $utf8 -ValidateJson
$json

if (-not $report.ok) {
    exit 1
}
