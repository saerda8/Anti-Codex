# Anti-Codex 真实用例与测试测试覆盖率审计报告

本报告对 Anti-Codex 的真实回复与工具任务验收测试脚本进行了静态代码审查。审查目标是确定现有的三个测试脚本及其调用的辅助脚本，是否能有效覆盖以下四项核心体验：
1. **中文正常回复**
2. **真实工具调用**
3. **任务最终完成**
4. **禁止 DeepCodex 残留提示**

---

## 已覆盖

审查的三个核心测试脚本为：
* [test-anticodex-codex-responses.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-codex-responses.ps1)
* [test-anticodex-real-mini-tool.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1)
* [test-anticodex-real-work.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1)

经审查，现有测试脚本对四项核心体验的覆盖情况如下：

### 1. 中文正常回复 (未覆盖 - 0%)
现有的任何测试脚本**均未覆盖**中文回复的验证。
* [test-anticodex-codex-responses.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-codex-responses.ps1) 在 [L116](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-codex-responses.ps1#L116) 使用的输入提示词是英文：`"Return exactly this marker and no extra words: $marker"`。
* [test-anticodex-real-mini-tool.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1) 在 [L150](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1#L150) 的首轮提示词与 [L223](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1#L223) 的次轮确认提示词均为英文。
* [test-anticodex-real-work.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1) 在 [L174](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1#L174) 的首轮提示词与 [L223](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1#L223) 的次轮确认提示词也均为英文。
* 没有任何断言（Assert/Match）来检测输出是否包含中文，或在中文请求下是否能保持正确的 UTF-8 编码格式输出。

### 2. 真实工具调用 (部分覆盖 - 仅覆盖模型生成 tool call 意图)
测试脚本实现了对**模型输出符合特定工具调用 schema** 的验证，但没有覆盖真实的、由后端 agent 引擎自主运行的工具调用。
* **模型意图生成验证**：
  * [test-anticodex-real-mini-tool.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1) 的 [L168](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1#L168) 验证模型返回了类型为 `function_call` 且名称为 `create_mini_tool` 的输出。
  * [test-anticodex-real-work.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1) 的 [L179](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1#L179) 验证模型返回了类型为 `function_call` 且名称为 `create_probe_file` 的输出。
  * 脚本对工具调用的参数字段进行了结构化校验（如校验路径 `$artifactFile` 和标记 `$marker` 是否正确）。

### 3. 任务最终完成 (部分覆盖 - 局限于简易的两轮对话完成)
测试脚本覆盖了**精简的“两轮式”任务闭环**，用于验证工具执行完毕后，模型能正确接收结果并给出最终总结。
* **两轮闭环验证**：
  * 在第二轮交互中，测试脚本通过向 `/v1/responses` 传递上一轮的 `previous_response_id` 与工具结果（`FILE_OK` 或 `CLI_OK`）来模拟任务推进。
  * **终态断言**：
    * [test-anticodex-real-mini-tool.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1) 在 [L229-230](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1#L229-L230) 校验了最终回复中不再产生新的工具调用（`finalCalls.Count -eq 0`），且内容匹配了 `CLI_OK` 以及 `$marker`。
    * [test-anticodex-real-work.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1) 在 [L227-230](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1#L227-L230) 校验了同样的行为（必须匹配 `FILE_OK` 和 `$marker`，无新 tool call）。

### 4. 禁止 DeepCodex 残留提示 (未覆盖 - 0%)
虽然在翻译服务 [adaptive-server.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/adaptive-server.mjs) 的 [L4070-4072](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/adaptive-server.mjs#L4070-L4072) 中实现了利用 [TRANSLATOR_BRAND](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/adaptive-server.mjs#L118)（即 `Anti-Codex`）对 `"DeepCodex"` 进行全局替换的机制，但在测试层**没有任何代码**断言排除了 `"DeepCodex"` 的泄露。
* [test-anticodex-codex-responses.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-codex-responses.ps1) 的 [L145](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-codex-responses.ps1#L145) 仅匹配了 XML 标签式泄露：`-match "<tool_calls>|</tool_calls>|custom_tool_call_output|function_call_output"`。
* 没有对回复文本是否包含旧品牌名词 `"DeepCodex"` 进行匹配拦截校验。

---

## 缺口

### 1. 中文正常回复的测试缺口
* **无中文输入/输出路径验证**：测试缺乏至少一个以中文编写的 Prompt 提问用例，导致无法测试在中文环境下的分词、实体提取以及中文字符集在 EventSource (SSE) 传输流中的编码兼容性（防乱码/截断）。

### 2. 真实工具调用的测试缺口
* **环境执行的 Mocking 偏差**：在 [test-anticodex-real-mini-tool.ps1:L181](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1#L181) 和 [test-anticodex-real-work.ps1:L196](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1#L196) 中，往磁盘写入 CLI 工具和 Probe 文件的动作是**由 PowerShell 脚本自身（客户端环境）代劳的**，而不是让 Anti-Codex 的 MCP 服务器/命令执行插件等实际执行端在受控环境下自主写入。
* **闲置的 MCP 验证逻辑**：[test-anticodex-real-work.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1) 定义了私有函数 [Invoke-RealNodeReplMcpResult](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1#L95-L122)，该函数会调用外部真实的 stdio 协议脚本 [anticodex-real-mcp-smoke.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/anticodex-real-mcp-smoke.mjs)，但该函数在整个脚本主体中**从未被实际调用**。

### 3. 任务最终完成的测试缺口
* **过于死板的流程步数断言**：测试仅允许两轮对话（Turn 1: Tool Call; Turn 2: Text Response）。如果模型因为网络不稳定、前置依赖缺失而需要额外进行一轮重试（例如先读取文件再写入），在当前脚本中会因为 Turn 2 依然抛出 Tool Call 而直接判定测试失败（触发 `finalCalls.Count -gt 0` 失败）。这无法客观评估在动态、复杂的长任务流中模型的自主决策与容错闭环。

### 4. 禁止 DeepCodex 残留提示的测试缺口
* **品牌敏感词过滤验证缺失**：由于在重构前该项目品牌名为 `deepcodex`，在 `/codex/responses` 或 `/v1/responses` 的最终回复中，可能由于 Prompt 历史残留或系统 compact 遗留而输出 `"DeepCodex"` 字样。现有的断言链条对敏感词完全放任，缺少对流式输出和最终输出文本的正则排查过滤。

---

## 建议的最小新增断言

为了填补上述覆盖率缺口，且不引入对真实流量测试的重构负担，建议在测试脚本中引入以下最小改动的 PowerShell 断言：

### 1. 验证“中文正常回复”
在 [test-anticodex-codex-responses.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-codex-responses.ps1) 中新增一个使用中文的请求案例。在获取可用模型后，执行以下校验：

```powershell
# 新增中文问答测试用例
$zhBody = [ordered]@{
    model = $model
    input = @(
        [ordered]@{
            type = "message"
            role = "user"
            content = @(
                [ordered]@{
                    type = "input_text"
                    text = "请用中文简要确认你已准备就绪，并在回复中包含此标记：$marker"
                }
            )
        }
    )
    tools = @()
    tool_choice = "none"
    stream = $true
}
$zhResponseText = Invoke-LocalPostText "/codex/responses" ($zhBody | ConvertTo-Json -Depth 16 -Compress)
$zhEvents = @(Read-SseEvents $zhResponseText)
$zhCompleted = @($zhEvents | Where-Object { $_.event -eq "response.completed" }) | Select-Object -Last 1
if (-not $zhCompleted) {
    Add-Failure "中文回复 SSE 未发送 response.completed"
} else {
    $zhTextParts = @(@($zhCompleted.data.response.output) | ForEach-Object { @($_.content) } | ForEach-Object { $_.text }) | Where-Object { $_ }
    $zhFinalText = ($zhTextParts -join "`n")
    if ($zhFinalText -notmatch "[\u4e00-\u9fa5]") {
        Add-Failure "模型收到中文 Prompt 时未回复任何中文字符"
    }
}
```

### 2. 激活并校验“真实工具调用”
在 [test-anticodex-real-work.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1) 的主流程中（如首轮交互前），激活原先定义但闲置的 `Invoke-RealNodeReplMcpResult`。这可利用已部署的 stdio MCP 通道实现对真实工具运行的端到端覆盖：

```powershell
# 激活被遗留的真实 Node REPL 工具调用测试
try {
    $mcpTestMarker = "MCP_SMOKE_VERIFY_$stamp"
    $mcpRun = Invoke-RealNodeReplMcpResult -Code "console.log('$mcpTestMarker')" -ExpectedMarker $mcpTestMarker
    if (-not $mcpRun.ok -or -not $mcpRun.markerObserved) {
        Add-Failure "真实工具调用 (Node REPL MCP client) 验证未成功输出期望 of Marker"
    }
} catch {
    Add-Failure "运行真实工具调用测试失败: $($_.Exception.Message)"
}
```

### 3. 增强“任务最终完成”的验证
在 [test-anticodex-real-mini-tool.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1) 和 [test-anticodex-real-work.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1) 的第二轮响应校验中，除了检查特定硬编码的短句外，还需对模型最终文本的实质内容完整性进行断言，以确保任务真正闭环：

```powershell
# 强化任务完成状态校验 (要求包含实质性总结文本)
if ($finalText.Length -lt 20) {
    Add-Failure "任务完成的最终回复文本过短，未提供实质性的完成说明"
}
```

### 4. 验证“禁止 DeepCodex 残留提示”
在所有发起接口调用的测试脚本（[test-anticodex-codex-responses.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-codex-responses.ps1)、[test-anticodex-real-mini-tool.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-mini-tool.ps1)、[test-anticodex-real-work.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-real-work.ps1)）中，添加对最终回复内容的敏感词黑名单拦截校验：

```powershell
# 严格禁止模型响应与系统日志中带入前代品牌 'DeepCodex' 的残留提示
if ($finalText -match "DeepCodex") {
    Add-Failure "最终回复内容中泄露了禁用的 'DeepCodex' 历史品牌/残留提示信息"
}
```
