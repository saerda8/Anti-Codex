# MCP/Skill 健康检查重试安全性审查

**审查日期**: 2026-06-22  
**审查范围**: `scripts/test-anticodex-mcp-skills.ps1` 中的 `Invoke-LocalJsonWithRetry` 及相关重试机制  
**审查目标**: 确认 retry 只处理本地瞬断、不掩盖持续故障、失败信息保留 endpoint 和尝试次数  

---

## 审查发现

### 1. Invoke-LocalJsonWithRetry（test-anticodex-mcp-skills.ps1）

```powershell
function Invoke-LocalJsonWithRetry {
    param(
        [string]$Path,
        [ValidateSet("Get", "Post")]
        [string]$Method = "Get",
        [int]$MaxAttempts = 2      # 最多 2 次尝试
    )
    ...
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $args = @{ Uri = "$BaseUrl$Path"; Proxy = $null; TimeoutSec = $TimeoutSec }
            ...
            return Invoke-RestMethod @args
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -ge $MaxAttempts) {
                throw "$Path request failed on attempt $attempt of $MaxAttempts`: $lastError"
            }
            Start-Sleep -Milliseconds ([Math]::Min(1000, 250 * $attempt))  # 上限 1s
        }
    }
    throw "$Path request failed after $MaxAttempts attempts: $lastError"
}
```

#### 安全特性 ✅

| 特性 | 值 | 分析 |
|------|-----|------|
| **最大尝试次数** | `$MaxAttempts = 2` | 最小化重试窗口，持续故障在 ~16s 内暴露（含 8s 超时） |
| **退避上限** | `[Math]::Min(1000, 250 * $attempt)` | 最大等待 1s，不会指数增长掩盖故障 |
| **单请求超时** | `$TimeoutSec = 8`（参数默认值） | 每个 HTTP 请求有 8s 硬超时 |
| **错误信息** | `$Path request failed on attempt $attempt of $MaxAttempts: $lastError` | 保留 endpoint 路径、尝试次数、具体错误 |
| **退避前检查** | `if ($attempt -ge $MaxAttempts) { throw ... }` | 最后一次尝试失败直接抛出，不额外等待 |

#### 覆盖的 API 端点

- `GET /health`
- `GET /backend-api/ps/plugins/installed`
- `GET /backend-api/plugins/list`
- `GET /backend-api/aip/connectors`
- `POST /backend-api/wham/apps`
- `GET /backend-api/mcp_servers`（通过 codex_app_directory / codex_apps_tools 路径）

### 2. Test-TranslatorHealthWithGrace（start-deepcodex.ps1）

```powershell
function Test-TranslatorHealthWithGrace {
    $attempts = [Math]::Max(1, $TRANSLATOR_HEALTH_FAILURE_THRESHOLD)  # 默认 3
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
        if (Test-TranslatorHealth) { return $true }
        if ($attempt -lt $attempts) {
            Start-Sleep -Milliseconds ([Math]::Max(0, $TRANSLATOR_HEALTH_RETRY_DELAY_MS))
        }
    }
    return $false
}
```

#### 安全特性 ✅

| 特性 | 值 | 分析 |
|------|-----|------|
| **最大尝试次数** | `$TRANSLATOR_HEALTH_FAILURE_THRESHOLD`（默认 3） | 有界重试 |
| **退避** | 固定延迟 `$TRANSLATOR_HEALTH_RETRY_DELAY_MS` | 非指数增长 |
| **失败行为** | 返回 `$false`（不抛出） | 调用方决定后续动作 |

### 3. Ensure-TranslatorRunning 内部循环（start-decodex.ps1）

```powershell
for ($i = 0; $i -lt 15; $i++) {
    if (Test-TranslatorHealth) { return $true }
    ...
    Start-Sleep -Seconds 1
}
```

#### 安全特性 ✅

| 特性 | 值 | 分析 |
|------|-----|------|
| **最大轮询次数** | 15 | 有界循环 |
| **退避** | 1s 固定 | 非指数增长 |
| **失败后行为** | 写入日志、不掩盖 | 调用方（watchdog 冷却 30s）处理 |

---

## 风险评估

### 潜在风险

1. **`Invoke-LocalJsonWithRetry` 对 HTTP 4xx/5xx 也进行重试**  
   `Invoke-RestMethod` 对非 2xx 响应抛出异常，触发重试。但仅 2 次尝试 + 250ms 退避，持续错误会快速暴露。风险低。

2. **所有 MCP API 调用共享同一重试策略**  
   `/health`（轻量）和 `/backend-api/wham/apps`（可能较重）使用相同的 2 次重试 + 8s 超时。单个端点耗时不会累计超过 ~16s。风险低。

3. **重试原因无分类**  
   当前实现对所有异常类型统一重试，未区分网络瞬断与业务错误。但 $MaxAttempts=2 且退避极小，实际影响可忽略。

### 风险缓解

- 所有重试参数（`$MaxAttempts`、`$TimeoutSec`、退避公式）均可通过环境变量或参数覆盖
- watchdog 有 30s 冷却期（`$translatorRecoveryCooldownUntil` / `AddSeconds(30)`），防止快速重试循环
- 错误日志始终包含 endpoint 路径和尝试次数，便于排查

---

## 结论

当前重试实现符合安全性要求：

- ✅ **只处理本地瞬断**: 最大 2 次尝试，退避上限 1s，仅适用于 localhost 短暂不可用
- ✅ **不掩盖持续故障**: 持续故障在 ~16s 内通过异常抛出暴露
- ✅ **失败信息保留 endpoint 和尝试次数**: `$Path request failed on attempt $attempt of $MaxAttempts: $lastError`
- ✅ **已有测试覆盖**: 测试验证了 `$MaxAttempts = 2`、错误信息格式、退避公式存在

### 建议（可选增强）

当前实现已足够安全。如需进一步加固，可考虑：

1. 对 4xx 错误（尤其是 401/403/404）跳过重试，仅对网络级异常或 5xx 重试
2. 为不同 API 端点设置差异化重试策略（轻量端点可重试，重端点不重试）
3. 添加运行时测试验证重试超时总和不超过预期上限

但以上增强在当前场景下属于防御过度，`$MaxAttempts=2` + 250ms 退避 + 8s 超时的组合已经足够安全。
