[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}

$failures = New-Object System.Collections.Generic.List[string]
$startedAt = [DateTime]::UtcNow

$model = if ($env:ANTICODEX_TEST_MODEL) {
    $env:ANTICODEX_TEST_MODEL
} else {
    "gemini-3.5-flash-low"
}

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
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
                $reader = New-Object IO.StreamReader($stream)
                try {
                    $detail = $reader.ReadToEnd()
                    if ($detail) {
                        throw "Local gateway returned an error: $detail"
                    }
                } finally {
                    $reader.Dispose()
                }
            }
        }
        throw
    }
}

function Invoke-AntiCodexCompact {
    param([hashtable]$Body)

    $json = $Body | ConvertTo-Json -Depth 20 -Compress
    try {
        return Invoke-RestMethod `
            -Uri "$BaseUrl/v1/responses/compact" `
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
                $reader = New-Object IO.StreamReader($stream)
                try {
                    $detail = $reader.ReadToEnd()
                    if ($detail) {
                        throw "Local gateway returned an error: $detail"
                    }
                } finally {
                    $reader.Dispose()
                }
            }
        }
        throw
    }
}

function Get-ResponseItems {
    param($Response)

    if ($null -eq $Response -or $null -eq $Response.output) {
        return @()
    }
    return @($Response.output)
}

function Get-ResponseText {
    param($Response)

    $parts = foreach ($item in (Get-ResponseItems $Response)) {
        if ($item.type -ne "message") {
            continue
        }
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

function Test-ContinuationFacts {
    param([string]$Text, [string]$Marker)
    if (-not $Text -or $Text -notmatch [regex]::Escape($Marker)) {
        return $false
    }
    return $Text -match "(?i)verify" -and $Text -match "(?i)compaction" -and $Text -match "(?i)resume"
}

$seed = "COMPACT_SEED_$(Get-Random -Maximum 99999)_$(Get-Date -Format 'yyyyMMdd')"
$nextAction = "verify installed compaction resume"
$compactSummary = $null
$directResumeText = ""
$chainedResumeText = ""

try {
    # Step 1: Initial response with a unique seed marker that must survive compaction
    $first = Invoke-AntiCodexResponse @{
        model = $model
        stream = $false
        store = $true
        input = @(
            @{
                type = "message"
                role = "user"
                content = @(
                    @{
                        type = "input_text"
                        text = "Remember this seed number: $seed. Reply with exactly the seed number and nothing else."
                    }
                )
            }
        )
    }

    if (-not $first.id) {
        Add-Failure "First response did not contain a response id"
    }

    # Step 2: Compact the conversation via the compaction endpoint
    $compact = Invoke-AntiCodexCompact @{
        model = $model
        previous_response_id = [string]$first.id
        tool_choice = "required"
        tools = @(
            @{
                type = "function"
                name = "forbidden_compact_tool"
                description = "This tool must never be called while compacting context."
                parameters = @{
                    type = "object"
                    properties = @{}
                    additionalProperties = $false
                }
            }
        )
        input = @(
            @{
                type = "message"
                role = "user"
                content = @(
                    @{
                        type = "input_text"
                        text = "Active task marker: $seed. Completed: installed routing validation. Next action: $nextAction. Preserve the exact marker and next action for the next turn."
                    }
                )
            }
        )
    }

    if ($compact.status -ne "completed") {
        Add-Failure "Compact response status is '$($compact.status)', expected 'completed'"
    }

    $compactItems = Get-ResponseItems $compact
    $compactionItem = @($compactItems | Where-Object { $_.type -eq "context_compaction" }) | Select-Object -First 1

    if (-not $compactionItem) {
        Add-Failure "Compact response did not contain a context_compaction output item"
    } else {
        $compactSummary = [string]$compactionItem.summary
        if (-not $compactSummary -or $compactSummary.Length -lt 20) {
            Add-Failure "Compact response context_compaction summary is too short or empty (length=$($compactSummary.Length))"
        }
        if ($compactSummary -notmatch [regex]::Escape($seed)) {
            Add-Failure "Compact summary did not preserve the active task marker"
        }
        if (-not (Test-ContinuationFacts $compactSummary $seed)) {
            Add-Failure "Compact summary did not preserve the next action"
        }
    }

    # Verify compact response has NO tool calls (function_call or custom_tool_call)
    $toolCalls = @($compactItems | Where-Object { $_.type -eq "function_call" -or $_.type -eq "custom_tool_call" })
    if ($toolCalls.Count -gt 0) {
        Add-Failure "Compact response contained $($toolCalls.Count) tool call(s), but should have none"
    }

    # Step 3: Feed the context_compaction item back directly.
    if ($compactSummary) {
        $directResume = Invoke-AntiCodexResponse @{
            model = $model
            stream = $false
            store = $true
            input = @(
                @{
                    type = "context_compaction"
                    summary = $compactSummary
                }
                @{
                    type = "message"
                    role = "user"
                    content = @(
                        @{
                            type = "input_text"
                            text = "Continue from the compacted context. Reply with the exact active task marker and exact next action."
                        }
                    )
                }
            )
        }

        $directResumeText = Get-ResponseText $directResume

        if (-not $directResumeText) {
            Add-Failure "Direct compaction resume response did not contain assistant text"
        } elseif (-not (Test-ContinuationFacts $directResumeText $seed)) {
            Add-Failure "Direct compaction resume did not preserve the marker and next action. Got: '$directResumeText'"
        }

        $chainedResume = Invoke-AntiCodexResponse @{
            model = $model
            stream = $false
            store = $true
            previous_response_id = [string]$compact.id
            input = @(
                @{
                    type = "message"
                    role = "user"
                    content = @(
                        @{
                            type = "input_text"
                            text = "Continue from the saved compact response. Reply with the exact active task marker and exact next action."
                        }
                    )
                }
            )
        }
        $chainedResumeText = Get-ResponseText $chainedResume

        if (-not $chainedResumeText) {
            Add-Failure "Chained compaction resume response did not contain assistant text"
        } elseif (-not (Test-ContinuationFacts $chainedResumeText $seed)) {
            Add-Failure "Chained compaction resume did not preserve the marker and next action. Got: '$chainedResumeText'"
        }
    }

    $endedAt = [DateTime]::UtcNow
    $result = [pscustomobject]@{
        ok = ($failures.Count -eq 0)
        reportName = "compaction-resume"
        requestedRealTraffic = $true
        usedRealTraffic = $true
        behaviorCovered = ($failures.Count -eq 0)
        coverageKind = "real-traffic"
        failures = $failures.ToArray()
        model = $model
        seed = $seed
        elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
        first_response_id = [string]$first.id
        compact_response_id = [string]$compact.id
        compact_summary_length = if ($compactSummary) { $compactSummary.Length } else { 0 }
        compact_summary_preview = if ($compactSummary) { $compactSummary.Substring(0, [Math]::Min(200, $compactSummary.Length)) } else { "" }
        direct_resume_text = $directResumeText
        chained_resume_text = $chainedResumeText
    }

    $reportPaths = New-ReportPaths "compaction-resume"
    $result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
    Save-JsonReport $reportPaths $result

    $result | ConvertTo-Json -Depth 12 -Compress
    if ($failures.Count -gt 0) { exit 1 }
} catch {
    Write-Error ("Anti-Codex compaction resume test failed: " + $_.Exception.Message)
    exit 1
}


