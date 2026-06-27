param(
    [string]$BaseUrl = "",
    [string]$ReportRoot = $(Join-Path $env:APPDATA "anticodex\reports"),
    [int]$TimeoutSec = 20
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    $BaseUrl = & (Join-Path $PSScriptRoot "resolve-anticodex-base-url.ps1")
}
$failures = New-Object System.Collections.Generic.List[string]
$startedAt = [DateTime]::UtcNow

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Get-RemainingVerifierBudgetMs {
    $elapsedMs = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
    return [Math]::Max(0, ($TimeoutSec * 1000) - [int]$elapsedMs)
}

function Has-Property {
    param($Value, [string]$Name)
    return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name
}

function Invoke-LocalJson {
    param([string]$Path, [int]$MaxAttempts = 2)
    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $remainingBudgetMs = Get-RemainingVerifierBudgetMs
            if ($remainingBudgetMs -lt 250) {
                throw "verifier budget exhausted before $Path request attempt $attempt"
            }
            $requestTimeoutSec = [Math]::Max(1, [Math]::Min(8, [Math]::Min($TimeoutSec, [int][Math]::Ceiling($remainingBudgetMs / 1000))))
            return Invoke-RestMethod -Uri "$BaseUrl$Path" -Proxy $null -TimeoutSec $requestTimeoutSec
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -ge $MaxAttempts) {
                throw "$Path request failed on attempt $attempt of $MaxAttempts`: $lastError"
            }
            $sleepMs = [Math]::Min([Math]::Min(1000, 250 * $attempt), [Math]::Max(0, (Get-RemainingVerifierBudgetMs)))
            if ($sleepMs -gt 0) {
                Start-Sleep -Milliseconds $sleepMs
            }
        }
    }
    throw "$Path request failed after $MaxAttempts attempts: $lastError"
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

$diagnostics = $null
try {
    $diagnostics = Invoke-LocalJson "/anticodex/diagnostics"
} catch {
    Add-Failure "diagnostics request failed: $($_.Exception.Message)"
}

if ($diagnostics) {
    if ($diagnostics.object -ne "anticodex.diagnostics") {
        Add-Failure "diagnostics object mismatch"
    }
    if ($diagnostics.mode.upstream -ne "antigravity-desktop") {
        Add-Failure "tool bridge mode verifier must run against antigravity-desktop upstream"
    }
    if (-not (Has-Property $diagnostics "toolBridge")) {
        Add-Failure "diagnostics missing toolBridge section"
    } else {
        $bridge = $diagnostics.toolBridge
        if ($bridge.mode -ne "native-mcp-same-cascade") {
            Add-Failure "toolBridge.mode is '$($bridge.mode)', expected 'native-mcp-same-cascade'"
        }
        if ($bridge.transport -ne "desktop-cascade") {
            Add-Failure "toolBridge.transport is '$($bridge.transport)', expected 'desktop-cascade'"
        }
        if ($bridge.localAdapter -ne "native-mcp-same-cascade-with-prompt-fallback") {
            Add-Failure "toolBridge.localAdapter is '$($bridge.localAdapter)', expected native MCP with prompt fallback"
        }
        if ($bridge.nativeBridgeDefaultEnabled -ne $true) {
            Add-Failure "toolBridge should enable the native bridge by default"
        }
        if ($bridge.nativeAntigravityToolEvents -ne $true) {
            Add-Failure "toolBridge should confirm native Antigravity tool events"
        }
        if ($bridge.acceptsExternalToolDefinitions -ne $true) {
            Add-Failure "toolBridge should confirm native external tool definitions"
        }
        if ($bridge.verifier -ne "test-anticodex-native-tool-loop.ps1") {
            Add-Failure "toolBridge verifier should be test-anticodex-native-tool-loop.ps1"
        }
        if ($bridge.nativeVerifier -ne "test-anticodex-native-tool-loop.ps1") {
            Add-Failure "toolBridge native verifier should remain available"
        }
    }

    if (-not (Has-Property $diagnostics "tools")) {
        Add-Failure "diagnostics missing backward-compatible tools section"
    } else {
        if ($diagnostics.tools.bridge -ne "native_mcp_same_cascade") {
            Add-Failure "diagnostics.tools.bridge is '$($diagnostics.tools.bridge)', expected 'native_mcp_same_cascade'"
        }
        if ($diagnostics.tools.antigravityMode -ne $true) {
            Add-Failure "diagnostics.tools.antigravityMode should be true"
        }
    }

    if (-not (Has-Property $diagnostics "nativeToolCapability")) {
        Add-Failure "diagnostics missing nativeToolCapability section"
    } else {
        $native = $diagnostics.nativeToolCapability
        if ($native.transport -ne "desktop-cascade") {
            Add-Failure "nativeToolCapability.transport is '$($native.transport)', expected 'desktop-cascade'"
        }
        if ($native.externalToolDefinitionsField -ne "StartCascade.customAgentSpec.customizationConfig.customizationServerUrl") {
            Add-Failure "nativeToolCapability external tool definition field mismatch"
        }
        if ($native.acceptsExternalToolDefinitions -ne $true) {
            Add-Failure "nativeToolCapability should confirm external tool definitions are accepted"
        }
        if ($native.externalToolDefinitionsUsable -ne $true) {
            Add-Failure "nativeToolCapability should confirm external tool definitions are usable"
        }
        if ($native.schemaLikeRequestAcceptance -ne "verified-native-mcp-initialize-and-tools-list") {
            Add-Failure "nativeToolCapability schema-like request status is '$($native.schemaLikeRequestAcceptance)'"
        }
        if ($native.nativeBridgeDefaultEnabled -ne $true) {
            Add-Failure "nativeToolCapability should enable the native bridge by default"
        }
        if ($native.nativeAntigravityToolEvents -ne $true) {
            Add-Failure "nativeToolCapability should confirm native Antigravity tool events"
        }
        if ($native.antigravityOwnedToolsDisabled -ne $true) {
            Add-Failure "nativeToolCapability should confirm Antigravity-owned tools are disabled"
        }
        if ($native.permissionPromptsDisabled -ne $true) {
            Add-Failure "nativeToolCapability should confirm Antigravity permission prompts are disabled"
        }
        if ([int]$native.disabledToolCount -lt 10) {
            Add-Failure "nativeToolCapability disabledToolCount is unexpectedly low: $($native.disabledToolCount)"
        }
        if ($native.nativeMcpPermissionMode -ne "automatic-before-codex-execution") {
            Add-Failure "nativeToolCapability should auto-handle permission before Codex execution"
        }
        if ($native.codexToolBridge -ne "native-mcp-same-cascade-with-prompt-fallback") {
            Add-Failure "nativeToolCapability codexToolBridge is '$($native.codexToolBridge)'"
        }
    }

    $serialized = $diagnostics | ConvertTo-Json -Depth 20 -Compress
    if ($serialized -match "(?i)tool output|messages|input_items|Return exactly this") {
        Add-Failure "diagnostics appears to expose transcript fields"
    }
}

$endedAt = [DateTime]::UtcNow
$result = [pscustomobject]@{
    ok = ($failures.Count -eq 0)
    failures = $failures.ToArray()
    baseUrl = $BaseUrl
    elapsedMs = [int]($endedAt - $startedAt).TotalMilliseconds
    toolBridge = if ($diagnostics) { $diagnostics.toolBridge } else { $null }
    compatibilityTools = if ($diagnostics) { $diagnostics.tools } else { $null }
    nativeToolCapability = if ($diagnostics) { $diagnostics.nativeToolCapability } else { $null }
}

$reportPaths = New-ReportPaths "tool-bridge-mode"
$result | Add-Member -NotePropertyName report -NotePropertyValue $reportPaths -Force
Save-JsonReport $reportPaths $result
$result | ConvertTo-Json -Depth 12 -Compress
if ($failures.Count -gt 0) { exit 1 }


