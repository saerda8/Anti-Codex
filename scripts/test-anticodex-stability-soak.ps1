[CmdletBinding()]
param(
    [string]$BaseUrl = "",
    [string]$Model = $(if ($env:ANTICODEX_TEST_MODEL) { $env:ANTICODEX_TEST_MODEL } else { "" }),
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$DurationSec = 180,
    [int]$RequestTimeoutSec = 150,
    [int]$HealthIntervalSec = 5,
    [int]$LongContextRepeat = 12000
)

$ErrorActionPreference = "Stop"

if ([System.Net.ServicePointManager]::DefaultConnectionLimit -lt 16) {
    [System.Net.ServicePointManager]::DefaultConnectionLimit = 16
}

if (-not $BaseUrl) {
    $BaseUrl = "http://127.0.0.1:18484"
}
$fixedRouteHealthUrl = "http://127.0.0.1:18487/anticodex/fixed-route/health"
$authPath = Join-Path $env:APPDATA "anticodex\codex-home-deepseek-app\auth.json"
if (-not (Test-Path -LiteralPath $authPath -PathType Leaf)) { throw "Anti-Codex local proxy auth is missing: $authPath" }
$localProxyKey = [string]((Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json).OPENAI_API_KEY)
if ([string]::IsNullOrWhiteSpace($localProxyKey)) { throw "Anti-Codex local proxy key is empty" }
$proxyHeaders = @{ Authorization = "Bearer $localProxyKey" }

$startedAt = [DateTime]::UtcNow
$reportStamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Save-Report {
    param($Payload)
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $json = $Payload | ConvertTo-Json -Depth 14 -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot "anticodex-report-io.ps1")
    Write-AntiCodexJsonReport -LatestPath (Join-Path $ReportRoot "latest-stability-soak.json") -HistoryPath (Join-Path $ReportRoot "$reportStamp-stability-soak.json") -Json $json -Encoding $utf8NoBom
}

function Join-Codepoints {
    param([int[]]$Codes)
    return -join ($Codes | ForEach-Object { [char]$_ })
}

$ChineseReplyPrefix = Join-Codepoints @(29992, 20013, 25991, 22238, 22797, 65306)
$OneSentenceSuffix = Join-Codepoints @(12290, 21482, 36755, 20986, 36825, 19968, 21477, 35805, 65292, 19981, 35201, 35299, 37322, 12290)
$LongContextFill = Join-Codepoints @(38271, 19978, 19979, 25991, 31283, 23450, 24615, 22635, 20805, 12290)

function New-ChineseMarkerPrompt {
    param([string]$Marker)
    return "$ChineseReplyPrefix$Marker$OneSentenceSuffix"
}

function Invoke-AntiCodexHealth {
    return Invoke-RestMethod -Uri $fixedRouteHealthUrl -Proxy $null -TimeoutSec 8
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Resolve-AntiCodexMode {
    param($Health)
    if (Has-Property $Health "provider") { return [string]$Health.provider }
    return "unknown"
}

function Resolve-AntiCodexTestModel {
    param($Health, [string]$RequestedModel)
    if ($RequestedModel) { return $RequestedModel }
    if ((Has-Property $Health "model") -and $Health.model) { return [string]$Health.model }
    throw "fixed-route health did not report a model"
}

function Test-AntiCodexReadyForTraffic {
    param($Health, [string]$Mode)
    return [bool]($Health.ok -eq $true -and [string]$Health.state -eq "ready" -and @("antigravity", "third-party") -contains $Mode -and $Health.model)
}

function Get-AntiCodexSupervisorPid {
    $process = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*Anti-Codex*runtime*scripts*start-anticodex-fixed-route.mjs*" } |
        Select-Object -First 1
    if ($process) { return [int]$process.ProcessId }
    return $null
}

function Invoke-AntiCodexResponse {
    param([hashtable]$Body)

    $json = $Body | ConvertTo-Json -Depth 30 -Compress
    try {
        return Invoke-RestMethod `
            -Uri "$BaseUrl/v1/responses" `
            -Method Post `
            -Headers $proxyHeaders `
            -ContentType "application/json; charset=utf-8" `
            -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
            -TimeoutSec $RequestTimeoutSec `
            -Proxy $null
    } catch {
        $response = $_.Exception.Response
        if ($response) {
            $stream = $response.GetResponseStream()
            if ($stream) {
                $reader = New-Object IO.StreamReader($stream)
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

function Invoke-AntiCodexCancelResponse {
    param([string]$ResponseId)

    $cancelRequest = [System.Net.WebRequest]::Create("$BaseUrl/v1/responses/$ResponseId/cancel")
    $cancelRequest.Method = "POST"
    $cancelRequest.Headers[[System.Net.HttpRequestHeader]::Authorization] = "Bearer $localProxyKey"
    $cancelRequest.Proxy = $null
    $cancelRequest.Timeout = 15000
    $cancelRequest.ReadWriteTimeout = 15000
    $cancelRequest.ContentType = "application/json; charset=utf-8"
    if ($cancelRequest -is [System.Net.HttpWebRequest]) {
        $cancelRequest.KeepAlive = $false
    }

    $cancelBytes = [Text.Encoding]::UTF8.GetBytes("{}")
    $cancelRequest.ContentLength = $cancelBytes.Length
    $cancelStream = $cancelRequest.GetRequestStream()
    try {
        $cancelStream.Write($cancelBytes, 0, $cancelBytes.Length)
    } finally {
        $cancelStream.Dispose()
    }

    $cancelResponse = $null
    try {
        $cancelResponse = $cancelRequest.GetResponse()
    } finally {
        if ($cancelResponse) { $cancelResponse.Dispose() }
    }
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

function Invoke-AntiCodexStream {
    param(
        [hashtable]$Body,
        [switch]$CancelAfterCreated
    )

    $request = [System.Net.WebRequest]::Create("$BaseUrl/v1/responses")
    $request.Method = "POST"
    $request.Headers[[System.Net.HttpRequestHeader]::Authorization] = "Bearer $localProxyKey"
    $request.Proxy = $null
    $request.Timeout = $RequestTimeoutSec * 1000
    $request.ReadWriteTimeout = $RequestTimeoutSec * 1000
    $request.ContentType = "application/json; charset=utf-8"
    if ($request -is [System.Net.HttpWebRequest]) {
        $request.KeepAlive = $false
    }
    $response = $null
    $reader = $null
    try {
        $json = $Body | ConvertTo-Json -Depth 30 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $request.ContentLength = $bytes.Length
        $requestStream = $request.GetRequestStream()
        try {
            $requestStream.Write($bytes, 0, $bytes.Length)
        } finally {
            $requestStream.Dispose()
        }
        $response = $request.GetResponse()
        $reader = [IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8)
        $events = New-Object System.Collections.Generic.List[object]
        $eventName = ""
        $dataLines = New-Object System.Collections.Generic.List[string]
        $state = [pscustomobject]@{ responseId = $null; cancelled = $false }

        function Add-SseEvent {
            if ($dataLines.Count -le 0) { return }
            $data = ($dataLines.ToArray() -join "`n")
            $parsed = $null
            try { $parsed = $data | ConvertFrom-Json } catch {}
            $events.Add([pscustomobject]@{ event = $eventName; data = $parsed }) | Out-Null
            if (-not $state.responseId -and $parsed -and $parsed.response -and $parsed.response.id) {
                $state.responseId = [string]$parsed.response.id
            }
            if ($CancelAfterCreated -and $state.responseId -and -not $state.cancelled) {
                $state.cancelled = $true
                Invoke-AntiCodexCancelResponse -ResponseId $state.responseId
                $events.Add([pscustomobject]@{ event = "response.cancelled"; data = [pscustomobject]@{ response_id = $state.responseId; localCancelAccepted = $true } }) | Out-Null
            }
        }

        while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()
            if ($line -eq "") {
                Add-SseEvent
                if ($CancelAfterCreated -and $state.cancelled) { break }
                $eventName = ""
                $dataLines.Clear()
                continue
            }
            if ($line.StartsWith("event: ")) {
                $eventName = $line.Substring(7)
            } elseif ($line.StartsWith("data: ")) {
                $dataLines.Add($line.Substring(6)) | Out-Null
            }
        }
        Add-SseEvent

        return [pscustomobject]@{ responseId = $state.responseId; events = $events.ToArray() }
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function New-MessageInput {
    param([string]$Text)
    return ,[object[]]@(
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

$startHealth = Invoke-AntiCodexHealth
$upstreamMode = Resolve-AntiCodexMode $startHealth
$providerReady = Test-AntiCodexReadyForTraffic $startHealth $upstreamMode
$Model = Resolve-AntiCodexTestModel $startHealth $Model
if (-not $providerReady) {
    throw "Anti-Codex provider is not ready for stability soak: mode=$upstreamMode message=$($startHealth.accountMessage)"
}

$startPid = Get-AntiCodexSupervisorPid
if (-not $startPid) {
    throw "Anti-Codex fixed-route supervisor process was not found."
}

$turns = New-Object System.Collections.Generic.List[object]
$healthChecks = New-Object System.Collections.Generic.List[object]
$failures = New-Object System.Collections.Generic.List[string]

foreach ($index in 1..3) {
    $marker = "SOAK_CN_$index"
    $inputItems = New-MessageInput (New-ChineseMarkerPrompt $marker)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-AntiCodexResponse @{
        model = $Model
        stream = $false
        store = $true
        input = $inputItems
    }
    $sw.Stop()
    $text = Get-AntiCodexResponseText $response
    $ok = $text -match [regex]::Escape($marker)
    if (-not $ok) { $failures.Add("non-streaming marker failed: $marker -> $text") | Out-Null }
    $turns.Add([pscustomobject]@{ name = "cn-$index"; ok = $ok; ms = $sw.ElapsedMilliseconds; text = $text; pid = Get-AntiCodexSupervisorPid }) | Out-Null
}

$longHead = "LONGCTX_HEAD_" + (Get-Random -Minimum 10000 -Maximum 99999)
$longTail = "LONGCTX_TAIL_" + (Get-Random -Minimum 10000 -Maximum 99999)
$longBody = $longHead + "`n" + ($LongContextFill * [Math]::Max(1, $LongContextRepeat)) + "`n" + $longTail
$longPrompt = "Return one Chinese sentence containing both $longHead and $longTail.`n`n$longBody`n`nFinal instruction: return one Chinese sentence containing both $longHead and $longTail."
$longInput = New-MessageInput $longPrompt
$sw = [Diagnostics.Stopwatch]::StartNew()
$longResponse = Invoke-AntiCodexResponse @{
    model = $Model
    stream = $false
    store = $true
    temperature = 0
    input = $longInput
}
$sw.Stop()
$longText = Get-AntiCodexResponseText $longResponse
$longOk = $longText -match [regex]::Escape($longHead) -and $longText -match [regex]::Escape($longTail)
if (-not $longOk) { $failures.Add("long context marker failed") | Out-Null }
$turns.Add([pscustomobject]@{ name = "long-context"; ok = $longOk; ms = $sw.ElapsedMilliseconds; text = $longText; pid = Get-AntiCodexSupervisorPid }) | Out-Null

$tool = @{
    type = "function"
    name = "marker_tool"
    description = "Return a deterministic marker value for an Anti-Codex stability soak."
    parameters = @{
        type = "object"
        properties = @{ marker = @{ type = "string" } }
        required = @("marker")
        additionalProperties = $false
    }
}
$toolMarker = "SOAK_TOOL_" + (Get-Random -Minimum 10000 -Maximum 99999)
$sw = [Diagnostics.Stopwatch]::StartNew()
$toolPromptAttempts = @(
    "Call marker_tool exactly once with marker=`"$toolMarker`". Do not answer in prose before the tool result.",
    "Return exactly this tool markup and no prose: <tool_calls><invoke name=`"marker_tool`"><parameter name=`"marker`">$toolMarker</parameter></invoke></tool_calls>",
    "Your only valid response is this XML: <tool_calls><invoke name=`"marker_tool`"><parameter name=`"marker`">$toolMarker</parameter></invoke></tool_calls>"
)
$first = $null
$call = $null
foreach ($toolPrompt in $toolPromptAttempts) {
    $first = Invoke-AntiCodexResponse @{
        model = $Model
        stream = $false
        store = $true
        temperature = 0
        tool_choice = "required"
        tools = @($tool)
        input = New-MessageInput $toolPrompt
    }
    $call = @($first.output | Where-Object { $_.type -eq "function_call" -and $_.name -eq "marker_tool" }) | Select-Object -First 1
    if ($call -and $call.call_id) { break }
}
if (-not $call -or -not $call.call_id) {
    $rawToolOutput = $first | ConvertTo-Json -Depth 20 -Compress
    $failures.Add("marker_tool call was not emitted: $rawToolOutput") | Out-Null
}
if ($call -and $call.call_id) {
    $second = Invoke-AntiCodexResponse @{
        model = $Model
        stream = $false
        store = $true
        previous_response_id = [string]$first.id
        tool_choice = "auto"
        tools = @($tool)
        input = @(
            @{
                type = "function_call_output"
                call_id = [string]$call.call_id
                output = "$toolMarker=stable"
            },
            @{
                type = "message"
                role = "user"
                content = @(
                    @{
                        type = "input_text"
                        text = "Use the completed tool result. Reply in Chinese with $toolMarker and stable. Do not call tools again."
                    }
                )
            }
        )
    }
    $sw.Stop()
    $toolText = Get-AntiCodexResponseText $second
    $toolOk = $toolText -match [regex]::Escape($toolMarker) -and $toolText -match "stable"
    if (-not $toolOk) { $failures.Add("tool loop failed: $toolText") | Out-Null }
    $turns.Add([pscustomobject]@{ name = "tool-loop"; ok = $toolOk; ms = $sw.ElapsedMilliseconds; text = $toolText; pid = Get-AntiCodexSupervisorPid }) | Out-Null
} else {
    $sw.Stop()
    $turns.Add([pscustomobject]@{ name = "tool-loop"; ok = $false; ms = $sw.ElapsedMilliseconds; text = "no marker_tool call"; pid = Get-AntiCodexSupervisorPid }) | Out-Null
}

$streamMarker = "STREAM_MARKER_" + (Get-Random -Minimum 10000 -Maximum 99999)
$streamInput = New-MessageInput (New-ChineseMarkerPrompt $streamMarker)
$stream = Invoke-AntiCodexStream @{
    model = $Model
    stream = $true
    input = $streamInput
}
$doneEvent = @($stream.events | Where-Object { $_.event -eq "response.output_text.done" }) | Select-Object -Last 1
$completedEvent = @($stream.events | Where-Object { $_.event -eq "response.completed" }) | Select-Object -Last 1
$streamText = [string]$doneEvent.data.text
$completedText = ""
if ($completedEvent -and $completedEvent.data -and $completedEvent.data.response) {
    $completedText = Get-AntiCodexResponseText $completedEvent.data.response
}
if (-not $completedText) { $completedText = $streamText }
$streamOk = $streamText -match [regex]::Escape($streamMarker) -and $completedText -match [regex]::Escape($streamMarker)
if (-not $streamOk) { $failures.Add("stream completion missing final marker: done=$streamText completed=$completedText") | Out-Null }
$turns.Add([pscustomobject]@{ name = "stream"; ok = $streamOk; ms = $null; text = $streamText; pid = Get-AntiCodexSupervisorPid }) | Out-Null

$cancelInput = New-MessageInput "Please wait before answering CANCEL_SHOULD_STOP."
$cancel = Invoke-AntiCodexStream @{
    model = $Model
    stream = $true
    input = $cancelInput
} -CancelAfterCreated
$cancelEventNames = @($cancel.events | ForEach-Object { $_.event })
$cancelOk = $cancelEventNames -contains "response.cancelled" -and -not ($cancelEventNames -contains "response.completed")
if (-not $cancelOk) { $failures.Add("stream cancellation failed: $($cancelEventNames -join ',')") | Out-Null }
$turns.Add([pscustomobject]@{ name = "cancel"; ok = $cancelOk; ms = $null; text = ($cancelEventNames -join ","); pid = Get-AntiCodexSupervisorPid }) | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(0, $DurationSec))
$loopIndex = 0
while ([DateTime]::UtcNow -lt $deadline) {
    $loopIndex += 1
    $health = Invoke-AntiCodexHealth
    $supervisorPid = Get-AntiCodexSupervisorPid
    $healthChecks.Add([pscustomobject]@{
        index = $loopIndex
        ready = [bool](Test-AntiCodexReadyForTraffic $health $upstreamMode)
        providerReady = [bool](Test-AntiCodexReadyForTraffic $health $upstreamMode)
        state = [string]$health.state
        model = [string]$health.model
        pid = $supervisorPid
    }) | Out-Null
    if (-not (Test-AntiCodexReadyForTraffic $health $upstreamMode)) { $failures.Add("health not ready at loop $loopIndex") | Out-Null }
    if ($supervisorPid -ne $startPid) { $failures.Add("fixed-route supervisor PID changed from $startPid to $supervisorPid") | Out-Null }

    if ($loopIndex % 4 -eq 1) {
        $loopMarker = "SOAK_LOOP_$loopIndex"
        $loopInput = New-MessageInput (New-ChineseMarkerPrompt $loopMarker)
        $response = Invoke-AntiCodexResponse @{
            model = $Model
            stream = $false
            store = $true
            input = $loopInput
        }
        $loopText = Get-AntiCodexResponseText $response
        $loopOk = $loopText -match [regex]::Escape($loopMarker)
        if (-not $loopOk) { $failures.Add("loop marker failed: $loopMarker -> $loopText") | Out-Null }
        $turns.Add([pscustomobject]@{ name = "loop-$loopIndex"; ok = $loopOk; ms = $null; text = $loopText; pid = Get-AntiCodexSupervisorPid }) | Out-Null
    }
    Start-Sleep -Seconds ([Math]::Max(1, $HealthIntervalSec))
}

$endHealth = Invoke-AntiCodexHealth
$endPid = Get-AntiCodexSupervisorPid
$result = [pscustomobject]@{
    ok = $failures.Count -eq 0
    reportName = "stability-soak"
    model = $Model
    mode = $upstreamMode
    providerReady = [bool]$providerReady
    startReady = [bool](Test-AntiCodexReadyForTraffic $startHealth $upstreamMode)
    endReady = [bool](Test-AntiCodexReadyForTraffic $endHealth $upstreamMode)
    provider = [string]$endHealth.provider
    routeState = [string]$endHealth.state
    startPid = $startPid
    endPid = $endPid
    pidStable = $startPid -eq $endPid
    healthChecks = $healthChecks.Count
    elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    turns = $turns.ToArray()
    failures = $failures.ToArray()
    report = [pscustomobject]@{
        latest = (Join-Path $ReportRoot "latest-stability-soak.json")
        history = (Join-Path $ReportRoot "$reportStamp-stability-soak.json")
    }
}

Save-Report $result
$result | ConvertTo-Json -Depth 10 -Compress
if (-not $result.ok) { exit 1 }


