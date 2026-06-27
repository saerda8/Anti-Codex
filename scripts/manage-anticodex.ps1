#Requires -Version 5.1
param(
    [ValidateSet("Ui", "Status", "Window")]
    [string]$Action = "Ui"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $scriptRoot)))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Anti-Codex"))
if ($installRoot -ne $expectedRoot) { throw "Anti-Codex 管理器只能从 $expectedRoot 运行" }

$powerShell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$baseUrlResolver = Join-Path $scriptRoot "resolve-anticodex-base-url.ps1"
$antigravityHelper = Join-Path $scriptRoot "antigravity-desktop.ps1"
$stateRoot = Join-Path $env:APPDATA "anticodex"
$postVerificationReport = Join-Path $stateRoot "reports\latest-post-verification.json"

function Resolve-ManagerBaseUrl {
    param([string]$BaseUrl)
    if (-not $BaseUrl) { return [string](& $baseUrlResolver) }
    return $BaseUrl
}

function Start-ManagerScript {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string[]]$Arguments = @(),
        [switch]$Visible
    )
    $path = Join-Path $scriptRoot $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "缺少 Anti-Codex 组件：$Name" }
    $options = @{
        FilePath = $powerShell
        ArgumentList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $path) + $Arguments
    }
    if (-not $Visible) { $options.WindowStyle = "Hidden" }
    Start-Process @options | Out-Null
}

function Get-ManagerHealthSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [int]$TimeoutSec = 4
    )
    $script:LastManagerGatewayError = ""
    try {
        return Invoke-RestMethod -Uri "$BaseUrl/health" -Proxy $null -TimeoutSec $TimeoutSec
    } catch {
        $script:LastManagerGatewayError = $_.Exception.Message
        return $null
    }
}

function Wait-ManagerHealth {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [int]$TimeoutSeconds = 90
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $health = Get-ManagerHealthSnapshot -BaseUrl $BaseUrl -TimeoutSec 2
        if ($health -and $health.ok -eq $true) { return $health }
        Start-Sleep -Milliseconds 750
    }
    return $null
}

function Wait-AntiCodexManagerChildProcess {
    param(
        [Diagnostics.Process]$Process,
        [int]$TimeoutMs,
        [int]$PollMs = 200
    )
    if (-not $Process) { return $true }
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(1, $TimeoutMs))
    while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds ([Math]::Max(50, $PollMs))
        try { $Process.Refresh() } catch {}
    }
    return [bool]$Process.HasExited
}

function Start-AntiCodexGatewayAndWait {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [int]$TimeoutSeconds = 25
    )
    $health = Get-ManagerHealthSnapshot -BaseUrl $BaseUrl -TimeoutSec 2
    if ($health -and $health.ok -eq $true) { return $health }

    $startDeepCodex = Join-Path $scriptRoot "start-deepcodex.ps1"
    if (-not (Test-Path -LiteralPath $startDeepCodex -PathType Leaf)) {
        $script:LastManagerGatewayError = " 缺少 Anti-Codex 网关启动组件：start-deepcodex.ps1"
        return $null
    }

    $baseUri = [Uri]$BaseUrl
    $savedEnv = @{}
    $envNames = @(
        "DEEPCODEX_STATE_ROOT",
        "CODEX_HOME_DIR",
        "CODEX_HOME",
        "GLOBAL_CODEX_HOME",
        "DEEPCODEX_SHARED_CODEX_HOME",
        "DEEPCODEX_PROJECTS_ROOT",
        "TRANSLATOR_PORT",
        "TRANSLATOR_HOST",
        "TRANSLATOR_LISTEN_HOST",
        "TRANSLATOR_URL",
        "DEEPCODEX_DISPLAY_NAME",
        "TRANSLATOR_UPSTREAM_MODE",
        "UPSTREAM_PROTOCOL",
        "UPSTREAM_URL",
        "UPSTREAM_MODEL",
        "UPSTREAM_API_KEY",
        "ANTICODEX_ACTIVE_UPSTREAM",
        "ANTICODEX_NATIVE_TOOL_BRIDGE",
        "DEEPCODEX_SKIP_PLUGIN_SYNC"
    )
    foreach ($name in $envNames) {
        $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }

    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $codexHome = Join-Path $stateRoot "codex-home-deepseek-app"
        $globalCodexHome = Join-Path $env:USERPROFILE ".codex"
        $env:DEEPCODEX_STATE_ROOT = $stateRoot
        $env:CODEX_HOME_DIR = $codexHome
        $env:CODEX_HOME = $codexHome
        $env:GLOBAL_CODEX_HOME = $globalCodexHome
        $env:DEEPCODEX_SHARED_CODEX_HOME = $globalCodexHome
        $env:DEEPCODEX_PROJECTS_ROOT = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)) "anticodex"
        $env:TRANSLATOR_PORT = [string]$baseUri.Port
        $env:TRANSLATOR_HOST = $baseUri.Host
        $env:TRANSLATOR_LISTEN_HOST = $baseUri.Host
        $env:TRANSLATOR_URL = $BaseUrl
        $env:DEEPCODEX_DISPLAY_NAME = "Anti-Codex"
        $upstreamProfileScript = Join-Path $scriptRoot "anticodex-upstream-profile.ps1"
        $usesAntigravity = $true
        if (Test-Path -LiteralPath $upstreamProfileScript -PathType Leaf) {
            try {
                $runtimeProfile = & $upstreamProfileScript -Action GetRuntime -StateRoot $stateRoot | ConvertFrom-Json
                if ($runtimeProfile.mode -eq "third-party" -and $runtimeProfile.baseUrl -and $runtimeProfile.apiKey -and $runtimeProfile.model) {
                    $usesAntigravity = $false
                    $env:TRANSLATOR_UPSTREAM_MODE = "chat"
                    $env:UPSTREAM_PROTOCOL = [string]$runtimeProfile.protocol
                    $env:UPSTREAM_URL = [string]$runtimeProfile.baseUrl
                    $env:UPSTREAM_MODEL = [string]$runtimeProfile.model
                    $env:UPSTREAM_API_KEY = [string]$runtimeProfile.apiKey
                    $env:ANTICODEX_ACTIVE_UPSTREAM = "third-party"
                    $env:ANTICODEX_NATIVE_TOOL_BRIDGE = "0"
                }
            } catch {}
        }
        if ($usesAntigravity) {
            $env:TRANSLATOR_UPSTREAM_MODE = "antigravity"
            Remove-Item Env:UPSTREAM_API_KEY -ErrorAction SilentlyContinue
            $env:ANTICODEX_ACTIVE_UPSTREAM = "antigravity"
            $env:ANTICODEX_NATIVE_TOOL_BRIDGE = "1"
        }
        $env:DEEPCODEX_SKIP_PLUGIN_SYNC = "1"

        $proc = Start-Process -FilePath $powerShell `
            -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $startDeepCodex, "-TranslatorOnly") `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -WindowStyle Hidden `
            -PassThru
        $launchTimeoutMs = [Math]::Min(30000, [Math]::Max(8000, $TimeoutSeconds * 1000))
        [void]$proc.Handle
        if (-not (Wait-AntiCodexManagerChildProcess -Process $proc -TimeoutMs $launchTimeoutMs)) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
            Wait-AntiCodexManagerChildProcess -Process $proc -TimeoutMs 3000 -PollMs 100 | Out-Null
            $script:LastManagerGatewayError = " 已尝试只恢复本地网关，但启动脚本超过 $launchTimeoutMs ms 未返回。"
        } elseif ($proc.ExitCode -ne 0) {
            $stderr = if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { (Get-Content -LiteralPath $stderrPath -Tail 5) -join " " } else { "" }
            $stdout = if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { (Get-Content -LiteralPath $stdoutPath -Tail 5) -join " " } else { "" }
            $detail = if ($stderr) { $stderr } else { $stdout }
            $script:LastManagerGatewayError = " 本地网关恢复失败：$detail"
        }
    } catch {
        $script:LastManagerGatewayError = " 本地网关恢复失败：$($_.Exception.Message)"
    } finally {
        foreach ($name in $envNames) {
            if ($null -eq $savedEnv[$name]) {
                [Environment]::SetEnvironmentVariable($name, $null, "Process")
            } else {
                [Environment]::SetEnvironmentVariable($name, [string]$savedEnv[$name], "Process")
            }
        }
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }

    return Wait-ManagerHealth -BaseUrl $BaseUrl -TimeoutSeconds ([Math]::Min(10, [Math]::Max(2, $TimeoutSeconds)))
}

function Start-AntiCodexAndWait {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [int]$TimeoutSeconds = 90
    )
    $health = Get-ManagerHealthSnapshot -BaseUrl $BaseUrl -TimeoutSec 2
    if ($health -and $health.ok -eq $true) { return $health }
    Start-ManagerScript "start-anticodex.ps1"
    return Wait-ManagerHealth -BaseUrl $BaseUrl -TimeoutSeconds $TimeoutSeconds
}

function Invoke-ManagerScriptJson {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string[]]$Arguments = @(),
        [int]$TimeoutMs = 15000,
        [switch]$AllowFailureJson
    )
    $path = Join-Path $scriptRoot $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "缺少 Anti-Codex 组件：$Name" }

    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $powerShell `
            -ArgumentList (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $path) + $Arguments) `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -WindowStyle Hidden `
            -PassThru
        [void]$proc.Handle
        if (-not (Wait-AntiCodexManagerChildProcess -Process $proc -TimeoutMs $TimeoutMs)) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
            Wait-AntiCodexManagerChildProcess -Process $proc -TimeoutMs 3000 -PollMs 100 | Out-Null
            throw "$Name 超时未返回。"
        }
        $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
        $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
        $json = $null
        if ($stdout.Trim()) {
            $jsonLine = @($stdout -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)
            if ($jsonLine) {
                try { $json = $jsonLine | ConvertFrom-Json } catch {}
            }
        }
        if ($proc.ExitCode -ne 0) {
            if ($AllowFailureJson -and $json) { return $json }
            $message = if ($stderr.Trim()) { $stderr.Trim() } elseif ($stdout.Trim()) { $stdout.Trim() } else { "$Name 执行失败，退出码 $($proc.ExitCode)。" }
            throw $message
        }
        if ($json) { return $json }
        return ($stdout | ConvertFrom-Json)
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-ReadOnlyModelCheck {
    $result = Invoke-ManagerScriptJson "test-anticodex-model-routing.ps1" -Arguments @("-SkipRefresh", "-SkipRequests") -AllowFailureJson
    if ($result.ok -ne $true) {
        $failureText = (@($result.failures) | Where-Object { $_ } | Select-Object -First 3) -join "`r`n"
        if (-not $failureText) { $failureText = "先打开 Anti-Codex，等本地网关启动后再检查。" }
        return "模型检查暂不可用，未消耗模型流量。`r`n$failureText"
    }
    $models = @($result.results | Where-Object { $_.ok } | ForEach-Object { [string]$_.displayName })
    $modelLine = if ($models.Count -gt 0) { $models -join ", " } else { ($result.models -join ", ") }
    return "模型检查通过：$($result.modelCount) 个模型，未消耗模型流量。`r`n$modelLine"
}

function Invoke-DiagnosticBundleCollection {
    $result = Invoke-ManagerScriptJson "collect-anticodex-diagnostics.ps1" -TimeoutMs 90000
    $refreshPath = Join-Path ([string]$result.bundleRoot) "model-routing-refresh.json"
    $refreshLine = "模型刷新摘要不可用。"
    if (Test-Path -LiteralPath $refreshPath -PathType Leaf) {
        $refresh = Get-Content -LiteralPath $refreshPath -Raw | ConvertFrom-Json
        if ($refresh.ok -eq $true) {
            $refreshLine = "模型数：$($refresh.modelCount)    未跑真实请求：$($refresh.skipRequests)"
        } else {
            $refreshLine = "模型摘要不可用。需要实时模型信息时，请先打开 Anti-Codex 后再收集。"
        }
    }
    return "诊断包已生成：`r`n$($result.zipPath)`r`n$refreshLine"
}

function Convert-DiagnosisText {
    param([string]$Value)
    switch -Regex ($Value) {
        "^ready$" { return "就绪" }
        "^account_verification_required$" { return "需要完成 Antigravity 账号验证" }
        "^account_verification_with_missing_token$" { return "需要完成 Antigravity 账号验证，后台令牌尚未刷新" }
        "^antigravity_account_unavailable$" { return "Antigravity 账号不可用" }
        "^antigravity_temporarily_unavailable$" { return "Antigravity 或代理暂时不可用" }
        "^quota_or_limit_reached$" { return "Antigravity 账号额度/限额已到" }
        "^antigravity_quota_exceeded$" { return "Antigravity 账号额度/限额已到" }
        "^proxy|network|oauth" { return "代理或网络异常" }
        "^unknown$" { return "未知" }
        default { return $Value }
    }
}

function Get-AccountActionText {
    param([object]$Result)
    $detail = if ($Result.diagnosisDetail) { [string]$Result.diagnosisDetail } else { [string]$Result.diagnosis }
    switch -Regex ($detail) {
        "account_verification" { return "操作：请在 Antigravity 桌面端完成账号验证，然后重试。" }
        "antigravity_account_unavailable" { return "操作：打开 Antigravity 桌面端，确认已登录且可正常使用，然后重试。" }
        "temporarily|proxy|network|oauth" { return "操作：Antigravity 到 Google 的代理或网络暂时不可用，等代理恢复后重试。" }
        "^ready$" { return "操作：无需处理。" }
        default { return "操作：打开 Anti-Codex 和 Antigravity 桌面端后重试。" }
    }
}

function Format-AccountPhaseSummary {
    param([object]$Result)
    if (-not $Result.phaseSummary) { return "" }
    $phase = $Result.phaseSummary
    $account = if ($phase.accountOk -eq $true) { "正常" } else { "不可用" }
    $refresh = if ($phase.refreshOk -eq $true) { "成功" } else { "失败" }
    $request = if ($phase.realRequestOk -eq $true) {
        "成功"
    } elseif ($phase.realRequestAttempted -eq $true) {
        "失败"
    } else {
        "未执行"
    }
    $modelCount = if ($null -ne $phase.modelCount) { [string]$phase.modelCount } else { "未知" }
    return "阶段：账号 $account    模型刷新 $refresh    缓存模型 $modelCount    真实请求 $request"
}

function Invoke-AccountProxyCheck {
    $result = Invoke-ManagerScriptJson "test-anticodex-account-proxy-readiness.ps1" -Arguments @("-AllowUnready") -TimeoutMs 120000 -AllowFailureJson
    $action = Get-AccountActionText $result
    $modelLine = if ($result.models -and $result.models.selected) { "模型：$($result.models.selected)" } else { "模型：不可用" }
    $detail = if ($result.diagnosisDetail) { [string]$result.diagnosisDetail } else { [string]$result.diagnosis }
    $phaseLine = Format-AccountPhaseSummary $result
    $lines = @("账号/代理检查：$(Convert-DiagnosisText $detail)", $action, $modelLine)
    if ($phaseLine) { $lines += $phaseLine }
    return ($lines -join "`r`n")
}

function Invoke-InstallSyncCheck {
    $result = Invoke-ManagerScriptJson "test-anticodex-sync-readiness.ps1" -Arguments @("-Fast", "-SkipAccountProxyProbe") -TimeoutMs 30000 -AllowFailureJson
    $desktopLine = if ($result.sync -and $result.sync.desktopAntiCodexShortcuts) {
        "桌面快捷方式：$(@($result.sync.desktopAntiCodexShortcuts) -join ', ')"
    } else {
        "桌面快捷方式：不可用"
    }
    $rollbackLine = if ($result.sync -and $result.sync.rollbackHost) {
        "回滚点：$($result.sync.rollbackHost.manifestValid)"
    } else {
        "回滚点：不可用"
    }
    $updateLine = if ($result.sync -and $result.sync.updateStatus) {
        "需要同步 Codex：$($result.sync.updateStatus.updateNeeded)"
    } else {
        "需要同步 Codex：未知"
    }
    if ($result.ok -ne $true) {
        $failureText = (@($result.failures) | Where-Object { $_ } | Select-Object -First 4) -join "`r`n"
        return "安装/同步检查失败。`r`n$updateLine    $rollbackLine`r`n$desktopLine`r`n$failureText"
    }
    return "安装/同步检查通过。`r`n$updateLine    $rollbackLine`r`n$desktopLine"
}

function Invoke-UiStateCheck {
    $result = Invoke-ManagerScriptJson "test-anticodex-ui-state.ps1" -TimeoutMs 30000 -AllowFailureJson
    if ($result.ok -ne $true) {
        $failureText = (@($result.failures) | Where-Object { $_ } | Select-Object -First 4) -join "`r`n"
        if (-not $failureText) { $failureText = "先打开 Anti-Codex，等界面启动后再试。" }
        if ($failureText -match "ECONNREFUSED|connection refused|refused|connect") {
            $failureText = "先打开 Anti-Codex，等界面启动后再试。"
        }
        return "界面检查暂不可用，未消耗模型流量。`r`n$failureText"
    }
    $targetTitle = if ($result.target -and $result.target.title) { [string]$result.target.title } else { "未知" }
    $matchedModel = if ($result.matchedModelText) { [string]$result.matchedModelText } else { "未找到" }
    return "界面检查通过，未消耗模型流量。`r`n标题：$targetTitle    模型数：$($result.modelCount)`r`n匹配到的模型文字：$matchedModel"
}

function Get-OfflineHint {
    param([object]$Result, [string]$Fallback)
    $failureText = (@($Result.failures) | Where-Object { $_ } | Select-Object -First 4) -join "`r`n"
    if (-not $failureText) { return $Fallback }
    if ($failureText -match "ECONNREFUSED|connection refused|refused|connect|health request failed") {
        return "先打开 Anti-Codex，等本地网关启动后再试。"
    }
    return $failureText
}

function Test-OnlyGatewayFailures {
    param([object]$Result)
    $items = @($Result.failures) | Where-Object { $_ }
    if ($items.Count -lt 1) { return $false }
    foreach ($item in $items) {
        if ([string]$item -notmatch "health request failed|endpoint failed|request failed|ECONNREFUSED|connection refused|refused|connect") {
            return $false
        }
    }
    return $true
}

function Invoke-McpSkillsCheck {
    $result = Invoke-ManagerScriptJson "test-anticodex-mcp-skills.ps1" -TimeoutMs 60000 -AllowFailureJson
    $mcpLine = if ($result.mcp) {
        "MCP: $($result.mcp.count)    node_repl: $($result.mcp.hasNodeRepl)"
    } else {
        "MCP：不可用"
    }
    $skillsLine = if ($result.skills) {
        "Skills: $($result.skills.count)    local copy: $(-not [bool]$result.skills.linkType)"
    } else {
        "Skill：不可用"
    }
    $cacheLine = if ($result.connectors -and $result.appTools) {
        "Connector cache: $($result.connectors.cacheFileCount)    app tools cache: $($result.appTools.cacheFileCount)"
    } else {
        "连接器/应用工具缓存：不可用"
    }
    $guidanceLine = if ($result.guidance) {
        "Guidance files: $(@($result.guidance).Count)"
    } else {
        "规则文件：不可用"
    }
    if ($result.ok -ne $true) {
        $localReady = $result.mcp -and $result.skills -and $result.mcp.hasNodeRepl -and
            ([int]$result.mcp.count -gt 0) -and ([int]$result.skills.count -gt 0) -and
            (-not [bool]$result.skills.linkType)
        if ($localReady -and (Test-OnlyGatewayFailures $result)) {
            return "MCP/Skill 本地检查通过，但网关未在线。`r`n$mcpLine    $skillsLine`r`n$cacheLine    $guidanceLine`r`n先打开 Anti-Codex，等本地网关启动后再检查实时插件。"
        }
        return "MCP/Skill 检查需要处理。`r`n$mcpLine    $skillsLine`r`n$cacheLine    $guidanceLine`r`n$(Get-OfflineHint $result '打开 Anti-Codex 后重试。')"
    }
    return "MCP/Skill 检查通过。`r`n$mcpLine    $skillsLine`r`n$cacheLine    $guidanceLine"
}

function Invoke-PluginCapabilityCheck {
    $result = Invoke-ManagerScriptJson "test-anticodex-plugin-capabilities.ps1" -TimeoutMs 60000 -AllowFailureJson
    $cap = $result.capabilities
    if (-not $cap) {
        return "插件/应用能力检查暂不可用。`r`n$(Get-OfflineHint $result '打开 Anti-Codex 后重试。')"
    }
    $pluginLine = "插件：已安装 $($cap.installedPluginCount) / 列表 $($cap.pluginListCount)"
    $featureLine = "Skill：$($cap.pluginsWithSkills)    MCP：$($cap.pluginsWithMcpServers)    应用：$($cap.pluginsWithApps)"
    $connectorLine = "连接器：$($cap.connectorCount)    已授权：$($cap.accessibleConnectorCount)    应用工具：$($cap.appToolCount)"
    if ($result.ok -ne $true) {
        return "插件/应用能力检查需要处理。`r`n$pluginLine`r`n$featureLine`r`n$connectorLine`r`n$(Get-OfflineHint $result '打开 Anti-Codex 后重试。')"
    }
    return "插件/应用能力检查通过。`r`n$pluginLine`r`n$featureLine`r`n$connectorLine"
}

function Invoke-LocalFeatureRefresh {
    $result = Invoke-ManagerScriptJson "refresh-anticodex-local-features.ps1" -TimeoutMs 300000 -AllowFailureJson
    $mcpLine = if ($result.mcp) { "MCP：$($result.mcp.count)    node_repl：$($result.mcp.hasNodeRepl)" } else { "MCP：不可用" }
    $skillsLine = if ($result.skills) { "Skill：$($result.skills.count)    本地副本：$(-not [bool]$result.skills.linkType)" } else { "Skill：不可用" }
    $cacheLine = if ($result.connectors -and $result.appTools) {
        "连接器缓存：$($result.connectors.count)    应用工具缓存：$($result.appTools.count)"
    } else {
        "连接器/应用工具缓存：不可用"
    }
    $guidanceLine = if ($result.guidance) {
        "规则文件：$(@($result.guidance.PSObject.Properties).Count)"
    } else {
        "规则文件：不可用"
    }
    if ($result.ok -ne $true) {
        $failureText = (@($result.failures) | Where-Object { $_ } | Select-Object -First 4) -join "`r`n"
        return "本地功能刷新失败。`r`n$mcpLine    $skillsLine`r`n$cacheLine    $guidanceLine`r`n$failureText"
    }
    return "本地功能刷新完成。`r`n$mcpLine    $skillsLine`r`n$cacheLine    $guidanceLine`r`n方便时重开 Anti-Codex，就能加载刷新后的桌面能力。"
}

function Invoke-OverallNoTrafficCheck {
    $result = Invoke-ManagerScriptJson "test-anticodex-installed-overall.ps1" -Arguments @("-EnsureRunning", "-NoTraffic", "-SkipAccountProxyProbe", "-SkipManagerActionProbe") -TimeoutMs 240000 -AllowFailureJson
    $healthLine = if ($result.health) {
        $trafficDiagnosis = if ($result.health.accountTrafficDiagnosis) { [string]$result.health.accountTrafficDiagnosis } else { [string]$result.health.accountTrafficState }
        $traffic = if ($null -eq $result.health.accountTrafficReady) {
            "未检查"
        } elseif ($result.health.accountTrafficReady -eq $true) {
            "就绪"
        } elseif ($trafficDiagnosis) {
            Convert-DiagnosisText $trafficDiagnosis
        } else {
            "受阻"
        }
        "健康：$($result.health.ok)    账号：$($result.health.accountState)    流量：$traffic    模型数：$($result.health.modelCount)"
    } else {
        "健康：不可用"
    }
    $checksLine = if ($result.checks) {
        "检查项：$(@($result.checks.PSObject.Properties.Name).Count)    未跑真实请求：$($result.noTraffic)"
    } else {
        "检查项：不可用"
    }
    if ($result.ok -ne $true) {
        $failureText = (@($result.failures) | Where-Object { $_ } | Select-Object -First 5) -join "`r`n"
        return "整体检查失败，未消耗模型流量。`r`n$healthLine`r`n$checksLine`r`n$failureText"
    }
    return "整体检查通过，未消耗模型流量。`r`n$healthLine`r`n$checksLine"
}

function Get-PostVerificationProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
        [string]$_.CommandLine -match "test-anticodex-post-verification\.ps1"
    })
}

function Get-PostVerificationStatusLine {
    $running = @(Get-PostVerificationProcesses).Count -gt 0
    $result = $null
    if (Test-Path -LiteralPath $postVerificationReport -PathType Leaf) {
        try { $result = Get-Content -LiteralPath $postVerificationReport -Raw | ConvertFrom-Json } catch {}
    }
    if (-not $result) {
        return $(if ($running) { "完整真实流量检查：运行中。" } else { "完整真实流量检查：未运行。" })
    }
    $state = if ($result.state) { [string]$result.state } else { "unknown" }
    $diagnosis = if ($result.wait -and $result.wait.latestDiagnosis) { [string]$result.wait.latestDiagnosis } else { "unknown" }
    $diagnosisDetail = if ($result.wait -and $result.wait.latest -and $result.wait.latest.diagnosisDetail) { [string]$result.wait.latest.diagnosisDetail } else { $diagnosis }
    $attempts = if ($result.wait) { [int]$result.wait.attempts } else { 0 }
    if ($running) {
        return "完整真实流量检查：$state    诊断：$(Convert-DiagnosisText $diagnosisDetail)    次数：$attempts"
    }
    if ($result.ok -eq $true) {
        return "完整真实流量检查：已通过。"
    }
    return "完整真实流量检查：$state    诊断：$(Convert-DiagnosisText $diagnosisDetail)"
}

function Get-CachedUpdateNeeded {
    param([object]$Diagnostics)
    $status = Get-CachedUpdateStatus $Diagnostics
    if ($status -and $null -ne (Get-ManagerObjectProperty -InputObject $status -Name "updateNeeded")) {
        return [string](Get-ManagerObjectProperty -InputObject $status -Name "updateNeeded")
    }
    return "未知"
}

function Get-ManagerObjectProperty {
    param(
        [object]$InputObject,
        [string]$Name
    )
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-CachedUpdateStatus {
    param([object]$Diagnostics)
    if ($Diagnostics -and $Diagnostics.updateStatus) {
        return $Diagnostics.updateStatus
    }
    $statusPath = Join-Path $stateRoot "update-status.json"
    if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
        try {
            return Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
        } catch {}
    }
    return $null
}

function Convert-AntiCodexUpdateStageText {
    param([string]$Stage)
    switch ($Stage) {
        "candidate_build" { return "候选构建" }
        "candidate_validation" { return "候选验证" }
        "stopping_host" { return "停止旧主进程" }
        "activation" { return "激活替换" }
        "feature_refresh" { return "刷新本地能力" }
        "restart" { return "重启 Anti-Codex" }
        "acceptance" { return "验收检查" }
        "complete" { return "完成" }
        "rollback_validation" { return "回滚验证" }
        "rollback_stopping_host" { return "停止当前主进程" }
        "rollback_activation" { return "回滚替换" }
        "rollback_restart" { return "回滚后重启" }
        "rollback_acceptance" { return "回滚验收检查" }
        "none" { return "无" }
        default {
            if ([string]::IsNullOrWhiteSpace($Stage)) { return "未知" }
            return $Stage
        }
    }
}

function Convert-AntiCodexUpdateOperationText {
    param([object]$Operation)
    $state = [string](Get-ManagerObjectProperty -InputObject $Operation -Name "state")
    $stage = Convert-AntiCodexUpdateStageText ([string](Get-ManagerObjectProperty -InputObject $Operation -Name "stage"))
    $message = [string](Get-ManagerObjectProperty -InputObject $Operation -Name "message")
    $rollbackAvailable = (Get-ManagerObjectProperty -InputObject $Operation -Name "rollbackAvailable") -eq $true
    $prefix = switch ($state) {
        "running" { "同步中" }
        "succeeded" { "已同步" }
        "failed" { "同步失败" }
        "rolled_back" { "已回滚" }
        "idle" { "空闲" }
        default { if ([string]::IsNullOrWhiteSpace($state)) { "未知" } else { $state } }
    }
    $rollbackText = if ($rollbackAvailable) { "    可回滚：True" } else { "" }
    $messageText = if ($message) { "    $message" } else { "" }
    return "$prefix / $stage$rollbackText$messageText"
}

function Format-CachedUpdateSummary {
    param([object]$Diagnostics)
    $status = Get-CachedUpdateStatus $Diagnostics
    if (-not $status) { return "未知" }
    $needed = Get-ManagerObjectProperty -InputObject $status -Name "updateNeeded"
    $drift = Get-ManagerObjectProperty -InputObject $status -Name "drift"
    $source = Get-ManagerObjectProperty -InputObject $status -Name "source"
    $active = Get-ManagerObjectProperty -InputObject $status -Name "active"
    $guardrails = Get-ManagerObjectProperty -InputObject $status -Name "guardrails"
    $sourceVersion = [string](Get-ManagerObjectProperty -InputObject $source -Name "packageVersion")
    if (-not $sourceVersion) { $sourceVersion = "未知" }
    $activeVersion = [string](Get-ManagerObjectProperty -InputObject $active -Name "packageVersion")
    if (-not $activeVersion) {
        $activeVersion = [string](Get-ManagerObjectProperty -InputObject $drift -Name "activePackageVersion")
    }
    if (-not $activeVersion) { $activeVersion = "未知" }
    $driftState = [string](Get-ManagerObjectProperty -InputObject $drift -Name "state")
    $base = if ($needed -eq $true -or $driftState -eq "drifted") {
        "版本漂移"
    } elseif ($needed -eq $false -or $driftState -eq "synced") {
        "已同步"
    } else {
        "未知"
    }
    $guardText = if ($guardrails) { "    品牌/图标保护：True" } else { "" }
    return "$base    原生 Codex：$sourceVersion    Anti-Codex：$activeVersion$guardText"
}

function Start-PostVerificationFullCheck {
    if (@(Get-PostVerificationProcesses).Count -gt 0) {
        return "完整真实流量检查已经在运行。`r`n点刷新状态查看当前进度。"
    }
    Start-ManagerScript "test-anticodex-post-verification.ps1" -Arguments @(
        "-OpenAntigravityOnVerification",
        "-TimeoutMinutes", "15",
        "-PollSeconds", "15"
    )
    return "完整真实流量检查已在后台开始。`r`n它会消耗真实 Antigravity 流量；如果 Antigravity 弹出验证，请先完成，再点刷新状态。"
}

function Open-AntigravityDesktop {
    if (-not (Test-Path -LiteralPath $antigravityHelper -PathType Leaf)) { throw "缺少 Antigravity 桌面端辅助脚本。" }
    . $antigravityHelper
    $path = Resolve-AntigravityDesktopPath
    if (-not $path) { throw "没有找到 Antigravity 桌面端。" }
    $running = Get-AntigravityMainProcess -ExecutablePath $path
    if (-not $running) { Start-Process -FilePath $path | Out-Null }
}

function Get-AntiCodexDebugPort {
    $mainExe = Join-Path $installRoot "codex-patched-app\Anti-Codex.exe"
    $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -eq $mainExe -and [string]$_.CommandLine -match "--remote-debugging-port=(\d+)"
    } | Select-Object -First 1
    if (-not $proc) { return $null }
    $match = [regex]::Match([string]$proc.CommandLine, "--remote-debugging-port=(\d+)")
    if ($match.Success) { return [int]$match.Groups[1].Value }
    return $null
}

function Wait-AntiCodexDebugPort {
    param([int]$TimeoutSeconds = 45)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $port = Get-AntiCodexDebugPort
        if ($port) { return $port }
        Start-Sleep -Milliseconds 750
    }
    return $null
}

function Resolve-ManagerNode {
    $bundled = Join-Path $installRoot "codex-patched-app\resources\cua_node\bin\node.exe"
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) { return $node.Source }
    throw "node.exe not found"
}

function Test-EmbeddedManagerBridgeRunning {
    param([int]$Port, [string]$BaseUrl = "")
    $bridgeName = "anticodex-manager-bridge.mjs"
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $commandLine = [string]$_.CommandLine
        $matchesBridge = $commandLine -match [regex]::Escape($bridgeName) -and $commandLine -match "--port\s+$Port(\s|$)"
        if (-not $matchesBridge) { return $false }
        if (-not $BaseUrl) { return $true }
        return $commandLine -match "--base-url\s+$([regex]::Escape($BaseUrl))(\s|$)"
    }).Count -gt 0
}

function Stop-StaleEmbeddedManagerBridge {
    param([int]$Port, [string]$BaseUrl)
    $bridgeName = "anticodex-manager-bridge.mjs"
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $commandLine = [string]$_.CommandLine
        $commandLine -match [regex]::Escape($bridgeName) -and
        $commandLine -match "--port\s+$Port(\s|$)" -and
        $commandLine -notmatch "--base-url\s+$([regex]::Escape($BaseUrl))(\s|$)"
    } | ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
}

function Start-EmbeddedManagerBridge {
    param(
        [Parameter(Mandatory = $true)][string]$Node,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$BaseUrl
    )
    $bridge = Join-Path $scriptRoot "anticodex-manager-bridge.mjs"
    if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) {
        $script:LastManagerGatewayError = " 管理面板桥接组件缺失。"
        return
    }
    Stop-StaleEmbeddedManagerBridge -Port $Port -BaseUrl $BaseUrl
    if (Test-EmbeddedManagerBridgeRunning -Port $Port -BaseUrl $BaseUrl) { return }
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    $stdout = Join-Path $stateRoot "anticodex-manager-bridge.log"
    $stderr = Join-Path $stateRoot "anticodex-manager-bridge.err.log"
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    try {
        $proc = Start-Process -FilePath $Node `
            -ArgumentList @($bridge, "--port", "$Port", "--base-url", $BaseUrl) `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -WindowStyle Hidden `
            -PassThru
        Start-Sleep -Milliseconds 1200
        if ($proc.HasExited -or -not (Test-EmbeddedManagerBridgeRunning -Port $Port -BaseUrl $BaseUrl)) {
            $detail = if (Test-Path -LiteralPath $stderr -PathType Leaf) { (Get-Content -LiteralPath $stderr -Tail 8) -join " " } else { "" }
            if (-not $detail -and (Test-Path -LiteralPath $stdout -PathType Leaf)) { $detail = (Get-Content -LiteralPath $stdout -Tail 8) -join " " }
            $script:LastManagerGatewayError = " 管理面板桥接未保持运行。$detail"
        }
    } catch {
        $script:LastManagerGatewayError = " 管理面板桥接启动失败：$($_.Exception.Message)"
    }
}

function Open-AntiCodexManagerPanel {
    $baseUrl = Resolve-ManagerBaseUrl
    # Bounded gateway recovery: start only the translator, never the full desktop.
    $health = Start-AntiCodexGatewayAndWait -BaseUrl $baseUrl -TimeoutSeconds 25
    $port = Get-AntiCodexDebugPort
    if (-not $port -and $health -and $health.ok -eq $true) {
        # Gateway is healthy; launch the full desktop window for CDP injection
        Start-ManagerScript "start-anticodex.ps1"
        $port = Wait-AntiCodexDebugPort
    } elseif (-not $port) {
        $port = Wait-AntiCodexDebugPort
    }
    if ($port) {
        try {
            $node = Resolve-ManagerNode
            $injector = Join-Path $scriptRoot "deepcodex-cdp-inject.mjs"
            $managerInject = Join-Path $scriptRoot "anticodex-manager-inject.js"
            $opener = Join-Path $scriptRoot "anticodex-manager-open-inject.js"
            if ((Test-Path -LiteralPath $injector -PathType Leaf) -and (Test-Path -LiteralPath $managerInject -PathType Leaf) -and (Test-Path -LiteralPath $opener -PathType Leaf)) {
                $previousManagerApi = $env:ANTICODEX_MANAGER_API
                $env:ANTICODEX_MANAGER_API = $baseUrl
                    # Step 1: inject the latest native-panel-v96 manager script
                $installOutput = @(& $node $injector "$port" $managerInject 2>&1)
                $installExitCode = $LASTEXITCODE
                if ($installExitCode -eq 0) {
                    Start-EmbeddedManagerBridge -Node $node -Port $port -BaseUrl $baseUrl
                    # Step 2: only call the opener after confirming the inject installed successfully
                    $output = @(& $node $injector "$port" $opener 2>&1)
                    if ($null -eq $previousManagerApi) { Remove-Item Env:\ANTICODEX_MANAGER_API -ErrorAction SilentlyContinue } else { $env:ANTICODEX_MANAGER_API = $previousManagerApi }
                    if ($LASTEXITCODE -eq 0) {
                        if ($health -and $health.ok -eq $true) { return "已在 Anti-Codex 主界面打开管理面板。" }
                        return "已在 Anti-Codex 主界面打开管理面板；本地网关仍在启动，请稍等后点刷新状态。$script:LastManagerGatewayError"
                    }
                    $script:LastManagerGatewayError = " 管理面板打开失败：$(@($output | Select-Object -Last 3) -join ' ')"
                } else {
                    if ($null -eq $previousManagerApi) { Remove-Item Env:\ANTICODEX_MANAGER_API -ErrorAction SilentlyContinue } else { $env:ANTICODEX_MANAGER_API = $previousManagerApi }
                    $script:LastManagerGatewayError = " 管理面板安装失败：$(@($installOutput | Select-Object -Last 3) -join ' ')"
                }
            }
        } catch {
            $script:LastManagerGatewayError = " 管理面板注入失败：$($_.Exception.Message)"
        }
    }
    if ($health -and $health.ok -eq $true) {
        return "Anti-Codex 已就绪，但内嵌管理面板没有打开成功。请再点一次管理入口。$script:LastManagerGatewayError"
    }
    return "Anti-Codex 正在启动，但内嵌管理面板还没打开成功。请稍等后再点一次管理入口。$script:LastManagerGatewayError"
}

function Get-ManagerStatus {
    $baseUrl = Resolve-ManagerBaseUrl
    $health = Start-AntiCodexGatewayAndWait -BaseUrl $baseUrl -TimeoutSeconds 25
    $gatewayError = $script:LastManagerGatewayError
    $accountInfo = $null
    $diagnostics = $null
    if ($health) {
        try { $accountInfo = Invoke-RestMethod -Uri "$baseUrl/anticodex/account" -Proxy $null -TimeoutSec 4 } catch {}
        try { $diagnostics = Invoke-RestMethod -Uri "$baseUrl/anticodex/diagnostics" -Proxy $null -TimeoutSec 4 } catch {}
    }
    $cachedUpdateStatus = Get-CachedUpdateStatus $diagnostics
    $updateSummary = Format-CachedUpdateSummary $diagnostics
    $operationSummary = Convert-AntiCodexUpdateOperationText (Get-ManagerObjectProperty -InputObject $cachedUpdateStatus -Name "operation")
    $rollbackAvailable = (Test-Path -LiteralPath (Join-Path $installRoot "rollback-host")) -and
        (Test-Path -LiteralPath (Join-Path $installRoot "rollback-host.ok"))
    if (-not $health) {
        return "网关：离线    账号：不可用    模型数：0`r`nCodex 同步：$updateSummary    回滚点：$rollbackAvailable`r`n同步阶段：$operationSummary`r`n说明：失败会保留当前 Anti-Codex，验收不通过会尝试自动回滚。`r`n$(Get-PostVerificationStatusLine)`r`n已尝试自动恢复本地网关，但本地网关还没就绪。请稍等后点刷新状态。$gatewayError"
    }
    $account = if ($health.accountReady -and [string]$health.accountState -eq "model_catalog_ready") {
        "模型已就绪"
    } elseif ($health.accountReady) {
        "就绪"
    } else {
        Convert-DiagnosisText ([string]$health.accountState)
    }
    $trafficDiagnosis = if ($health.accountTrafficDiagnosis) { [string]$health.accountTrafficDiagnosis } else { [string]$health.accountTrafficState }
    $traffic = if ($null -eq $health.accountTrafficReady) {
        "未检查"
    } elseif ($health.accountTrafficReady -eq $true) {
        "就绪"
    } elseif ($trafficDiagnosis) {
        Convert-DiagnosisText $trafficDiagnosis
    } else {
        "受阻"
    }
    $trafficState = [string]$health.accountTrafficState
    $trafficType = [string]$health.accountTrafficType
    $trafficAction = if ($trafficDiagnosis -eq "quota_or_limit_reached" -or $trafficType -eq "antigravity_quota_exceeded") {
        $suggestion = if ($health.accountTrafficSuggestedAction) { [string]$health.accountTrafficSuggestedAction } else { "切换 Antigravity 账号，或等待额度/限额恢复后重试。" }
        "`r`n操作：$suggestion Anti-Codex 不会切到 ChatGPT 登录。"
    } elseif ($trafficDiagnosis -eq "account_verification_with_missing_token") {
        "`r`n操作：请在 Antigravity 桌面端重新登录或完成账号验证，等后台令牌刷新后再重试。"
    } elseif ($trafficDiagnosis -eq "account_verification_required" -or $trafficState -eq "account_verification_required") {
        "`r`n操作：请在 Antigravity 桌面端完成账号验证，然后重试 Anti-Codex。"
    } elseif ($trafficType -eq "antigravity_account_unavailable" -or $trafficState -eq "antigravity_account_unavailable") {
        "`r`n操作：打开 Antigravity 桌面端，确认已登录且可正常使用，然后重试 Anti-Codex。"
    } elseif ($trafficType -eq "antigravity_temporarily_unavailable" -or $health.accountTrafficRetryable -eq $true) {
        "`r`n操作：Antigravity 或代理暂时不可用，等网络恢复后重试。"
    } else {
        ""
    }
    $plan = if ($accountInfo -and $accountInfo.planName) {
        [string]$accountInfo.planName
    } elseif ($accountInfo -and $accountInfo.degraded) {
        "详情不可用"
    } else {
        "未知"
    }
    $tier = if ($accountInfo -and $accountInfo.tierName) {
        [string]$accountInfo.tierName
    } elseif ($accountInfo -and $accountInfo.degraded) {
        "缓存模型"
    } else {
        "未知"
    }
    $postVerificationLine = Get-PostVerificationStatusLine
    $limitLine = ""
    if ($diagnostics -and $diagnostics.limits) {
        $promptMax = [long]$diagnostics.limits.promptMaxChars
        $toolOutputMax = [long]$diagnostics.limits.toolOutputMaxChars
        if ($promptMax -gt 0 -and $toolOutputMax -gt 0) {
            $limitLine = "`r`n上下文保护：$("{0:N0}" -f $promptMax) 字符    工具输出保护：$("{0:N0}" -f $toolOutputMax) 字符"
        }
    }
    $toolLine = ""
    if ($diagnostics -and $diagnostics.toolBridge) {
        $bridgeMode = [string]$diagnostics.toolBridge.mode
        $nativeDefault = $diagnostics.toolBridge.nativeBridgeDefaultEnabled -eq $true
        $toolOwner = if ($bridgeMode -eq "codex-owned-tools-prompt-mediated") {
            "原生工具桥已手动关闭；当前使用兼容模式"
        } elseif ($nativeDefault) {
            "Antigravity 原生 MCP 工具桥已开启；权限自动处理"
        } else {
            $bridgeMode
        }
        $toolLine = "`r`n工具：$toolOwner"
    }
    $queueLine = ""
    if ($diagnostics -and $diagnostics.antigravityQueue) {
        $activeRequests = if ($diagnostics.activeAntigravityRequests) { $diagnostics.activeAntigravityRequests.active } else { "未知" }
        $queueLine = "`r`n请求队列：$($diagnostics.antigravityQueue.queued) / $($diagnostics.antigravityQueue.maxQueued) 排队    运行中：$($diagnostics.antigravityQueue.running)    活跃流：$activeRequests"
    }
    $accountTrackingLine = ""
    if ($diagnostics -and $diagnostics.accountTracking -and $diagnostics.accountTracking.changePending -eq $true) {
        $accountTrackingLine = "`r`n账号切换：确认中 $($diagnostics.accountTracking.pendingObservations) / $($diagnostics.accountTracking.requiredObservations)"
    }
    return "网关：$($health.ok)    账号：$account    流量：$traffic    模型数：$($health.modelCount)    熔断：$($health.antigravityCircuitState)`r`n套餐：$plan / $tier    Codex 同步：$updateSummary    回滚点：$rollbackAvailable`r`n同步阶段：$operationSummary`r`n说明：失败会保留当前 Anti-Codex，验收不通过会尝试自动回滚。`r`n$postVerificationLine$limitLine$toolLine$queueLine$accountTrackingLine$trafficAction"
}

if ($Action -eq "Status") {
    Write-Output (Get-ManagerStatus)
    exit 0
}

if ($Action -eq "Ui") {
    Write-Output (Open-AntiCodexManagerPanel)
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "Anti-Codex 管理"
$form.Size = New-Object System.Drawing.Size(560, 790)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = "Anti-Codex 管理"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 16, [Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(22, 18)
$title.Size = New-Object System.Drawing.Size(500, 34)
$form.Controls.Add($title)

$status = New-Object System.Windows.Forms.TextBox
$status.Text = "正在读取状态..."
$status.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$status.Multiline = $true
$status.ReadOnly = $true
$status.ScrollBars = "Vertical"
$status.WordWrap = $true
$status.Location = New-Object System.Drawing.Point(24, 62)
$status.Size = New-Object System.Drawing.Size(500, 118)
$form.Controls.Add($status)

function Add-ManagerButton {
    param([string]$Text, [int]$X, [int]$Y, [scriptblock]$Action)
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $Text
    $button.Location = New-Object System.Drawing.Point($X, $Y)
    $button.Size = New-Object System.Drawing.Size(238, 42)
    $button.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $button.Add_Click({
        try {
            $message = & $Action
            if ($message) {
                $status.Text = [string]$message
            } else {
                $status.Text = "$Text 已启动。完成后点刷新状态查看结果。"
            }
        } catch {
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Anti-Codex 管理", "确定", "错误") | Out-Null
        }
    }.GetNewClosure())
    $form.Controls.Add($button)
}

Add-ManagerButton "打开 Anti-Codex" 24 202 {
    $baseUrl = Resolve-ManagerBaseUrl
    # Bounded gateway recovery: start only the translator, then launch the full desktop
    $health = Start-AntiCodexGatewayAndWait -BaseUrl $baseUrl -TimeoutSeconds 25
    if ($health -and $health.ok -eq $true) {
        Start-ManagerScript "start-anticodex.ps1"
        return "Anti-Codex 已打开，本地网关已就绪。"
    }
    return "Anti-Codex 已启动，但本地网关还没就绪。请稍等后点刷新状态。$script:LastManagerGatewayError"
}
Add-ManagerButton "打开 Antigravity 桌面端" 286 202 { Open-AntigravityDesktop }
Add-ManagerButton "刷新模型" 24 256 { Start-ManagerScript "refresh-anticodex-models.ps1" }
Add-ManagerButton "切换 Antigravity 账号" 286 256 { Start-ManagerScript "switch-anticodex-account.ps1" -Visible }
Add-ManagerButton "同步 Codex 更新" 24 310 { Start-ManagerScript "sync-anticodex-launcher.ps1" }
Add-ManagerButton "回滚 Anti-Codex" 286 310 { Start-ManagerScript "rollback-anticodex-launcher.ps1" }
Add-ManagerButton "检查模型（不耗流量）" 24 364 {
    Invoke-ReadOnlyModelCheck
}
Add-ManagerButton "收集诊断包" 286 364 { Invoke-DiagnosticBundleCollection }
Add-ManagerButton "检查账号/代理" 24 418 { Invoke-AccountProxyCheck }
Add-ManagerButton "检查安装/同步" 24 472 { Invoke-InstallSyncCheck }
Add-ManagerButton "检查界面（不耗流量）" 286 472 { Invoke-UiStateCheck }
Add-ManagerButton "检查 MCP/Skill" 24 526 { Invoke-McpSkillsCheck }
Add-ManagerButton "检查插件/应用" 286 526 { Invoke-PluginCapabilityCheck }
Add-ManagerButton "刷新 MCP/Skill" 24 580 { Invoke-LocalFeatureRefresh }
Add-ManagerButton "整体检查（不耗流量）" 286 580 { Invoke-OverallNoTrafficCheck }
Add-ManagerButton "验证后完整检查" 24 634 { Start-PostVerificationFullCheck }

$refresh = New-Object System.Windows.Forms.Button
$refresh.Text = "刷新状态"
$refresh.Location = New-Object System.Drawing.Point(286, 418)
$refresh.Size = New-Object System.Drawing.Size(238, 42)
$refresh.Add_Click({
    try { $status.Text = Get-ManagerStatus } catch { $status.Text = "状态不可用：$($_.Exception.Message)" }
})
$form.Controls.Add($refresh)

$form.Add_Shown({
    try { $status.Text = Get-ManagerStatus } catch { $status.Text = "状态不可用：$($_.Exception.Message)" }
})
[void]$form.ShowDialog()

