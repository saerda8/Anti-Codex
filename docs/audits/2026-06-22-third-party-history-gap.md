# Anti-Codex 第三方 API 配置与切换模型历史遗留缺口审计

**审计日期**: 2026-06-22

---

## 结论

当前 Anti-Codex 已实现基础的第三方 API 连通性测试（`/anticodex/upstream-test`）、DPAPI 密钥管理以及纯文本聊天的历史会话恢复（基于本地 `response-history.json` 的 `hydrate`/`remember`）等核心逻辑。然而，针对以下关键边界与异常场景，现有测试套件（如 `upstream-integration.test.mjs` 和 `response-history.test.mjs`）中仍存在以下几处关键的测试缺口。

---

## 缺口

### 1. 跨协议切换时复杂工具调用历史转换与恢复验证缺失
- **源码背景**：`translator/response-history.mjs` 中的 `hydrate` 仅执行简单的上下文消息数组拼接。而 `upstream-provider.test.mjs` 中的 `tool_use`/`tool_result` 协议转换逻辑仅在单元测试中针对静态对象进行了验证。
- **缺口说明**：在真实会话中，历史往往包含复杂的工具调用与执行结果（如 Codex 文件操作、终端命令运行等）。集成测试 `upstream-integration.test.mjs` 中仅验证了纯文本对话下的模型切换与历史恢复。当用户在包含工具调用的会话中途将第三方 API 协议从 `openai-compatible` 切换到 `anthropic`（或反之）并发送后续请求时，缺乏集成测试来验证 Translator 是否能够将历史中旧协议格式的工具消息正确转换为目标协议所需的格式，存在因协议格式不兼容而导致上游报错或上下文断裂的风险。

### 2. Windows DPAPI 密钥文件损坏或不可读的异常恢复缺口
- **源码背景**：`scripts/anticodex-upstream-profile.ps1` 采用 Windows DPAPI 对 API key 进行加密，并存储为二进制文件 `upstream-profile.key`。解密时若发生异常（例如由不同 Windows 用户账号运行、密钥文件损坏或被篡改等），`Unprotect-ApiKey` 会抛出密文解密失败的异常。
- **缺口说明**：现有测试套件假定 DPAPI 始终处于工作状态。缺少针对 `.key` 文件损坏、数据不完整（如 0 字节文件）或因 Windows 权限变更导致解密失败时的边界测试，无法保证 Translator 会优雅捕获该异常并引导用户重新授权或平滑回滚至 Antigravity 模式，而不是导致本地服务进程崩溃或持续报错。

### 3. 历史记录修剪导致 410 过期时 Codex 客户端感知与容错流缺失验证
- **源码背景**：`translator/response-history.mjs` 存在容量修剪机制（`prune()`），一旦超出最大条目限制，旧的历史会被移出。若此时携带已过期的 `previous_response_id` 访问 `/v1/responses`，系统会抛出 410 状态码并带有 `response_history_missing` 错误。
- **缺口说明**：当前的测试仅在 `response-history.test.mjs` 中对 `assert.throws` 进行了抛出行为的单元测试验证。没有集成测试或端到端测试来验证当该 410 错误传递至 Codex 客户端时，客户端的容错流与用户交互表现（如是否会卡死、是否能优雅降级引导用户重置会话或自动重发客户端缓存的完整历史上下文）。

---

## 建议测试

### 1. 跨协议切换工具历史恢复测试
- **建议测试名**：`test("Cross-protocol switch (OpenAI to Anthropic) preserves tool call history and resolves first followup response")`
- **验证步骤**：
  1. 在 OpenAI 兼容模式下发起带工具调用的对话，完成响应以在 `response-history.json` 中保存相应的 OpenAI tool 消息格式。
  2. 修改并保存第三方配置为 Anthropic 原生协议。
  3. 发送 followup 续写请求，验证 Translator 能正确把历史中的 OpenAI tool 消息转译为 Anthropic 支持的 `tool_use`/`tool_result` 结构，并确保上游 Anthropic 能够正常响应。

### 2. DPAPI 密钥损坏容错测试
- **建议测试名**：`test("Upstream profile DPAPI decryption failure fallback gracefully prompts re-authentication and handles unreadable keys")`
- **验证步骤**：
  1. 往本地 `upstream-profile.key` 写入不合法的二进制数据（模拟文件损坏）。
  2. 调用 `/anticodex/upstream-profile` 的 GET 和 POST 接口。
  3. 验证系统能捕获解密异常，返回红区错误提示，并引导用户重新输入 API key，确保不会引起本地模型通道崩溃。

### 3. 410 历史记录丢失客户端容错流测试
- **建议测试名**：`test("Translator 410 response_history_missing error propagates correctly and triggers Codex client recovery workflow")`
- **验证步骤**：
  1. 设定极小的 `maxEntries` 参数以触发修剪逻辑，使首条会话历史记录过期。
  2. 使用过期的 `previous_response_id` 向 `/v1/responses` 发送新请求。
  3. 验证接口正确返回 410，并且上层客户端接收到该错误后，能够触发预设的重置/降级会话工作流，而不会挂起或卡死 UI。
