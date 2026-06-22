# Codex App-Server 原生协议边界审计

> **审计目标**: 明确 Anti-Codex 与本机 Codex Desktop (Electron) 之间的协议边界，
> 确定最小侵入改造点以实现原生等级的会话、流式、工具、MCP、技能、取消、压缩、恢复语义。
>
> **范围**: 桌面端 (Codex.exe) ↔ app-server (language_server.exe / translator) ↔ 模型客户端的完整链路。
>
> **审计时间**: 2026-06-11
> **关联阶段**: Anti-Codex 核心稳定性重建 Phase 1

---

## 目录

1. [总体架构](#1-总体架构)
2. [已验证事实](#2-已验证事实)
3. [源码依据](#3-源码依据)
4. [协议契约清单](#4-协议契约清单)
5. [现有网关差距分析](#5-现有网关差距分析)
6. [最小侵入改造点](#6-最小侵入改造点)
7. [待验证项](#7-待验证项)
8. [推荐架构](#8-推荐架构)

---

## 1. 总体架构

### 1.1 当前 DeepCodex 拓扑

```text
Codex Desktop (Electron)
  │  config.toml → openai_base_url = "http://127.0.0.1:8282"
  │  config.toml → chatgpt_base_url = "http://127.0.0.1:8282/backend-api/"
  │  session_id / x-codex-window-id  header
  │  zstd-compressed Requests API POST body
  ▼
adaptive-server.mjs  (端口 8282)    ← DeepCodex 模式
  │  TRANSLATOR_UPSTREAM_MODE=chat
  │  Responses API ↔ Chat Completions 翻译
  │  内部工具 (web_search, web_fetch) 执行
  │  模拟 SSE 流式 (非真正流式)
  ▼
one-api / DeepSeek API               ← 上游模型
```

### 1.2 Anti-Codex 拓扑 (建设中)

```text
Anti-Codex Desktop (Electron)
  │  config.toml → openai_base_url = "http://<LAN_IP>:8484"
  │  TRANSLATOR_UPSTREAM_MODE=antigravity
  ▼
adaptive-server.mjs  (端口 8484)    ← Anti-Codex 模式
  │  使用 antigravity-upstream.mjs 进行 pure-text 流转发
  │  runAntigravityTextTurn() → 通过 CLI/language_server 调用
  ▼
Antigravity Desktop language_server.exe
  │  127.0.0.1:xxx  (自动发现)
  │  gRPC-like protobuf LanguageServerService
  │  GetAvailableModels / Agent API
  ▼
Antigravity 云端模型 (Gemini 系列)
```

### 1.3 组件边界

| 组件 | 职责 | 运行位置 |
|------|------|----------|
| Codex.exe | Electron 桌面 UI, 会话管理, 工具传参, 渲染 | 本机进程 |
| app-server (language_server.exe) | 模型执行, 原生 Agent API, 工具执行, 会话持久化 | Antigravity 安装目录 |
| adaptive-server.mjs | 协议翻译, Responses↔Chat 桥接, 内部工具代理 | Node.js 进程 |
| one-api | API key 管理, 通道路由, 用量统计 | 可选中间层 |

---

## 2. 已验证事实

### 2.1 Codex Desktop 发送给 translator 的请求

**来源**: `adaptive-server.mjs` line 1053-1075, `config.adaptive-oneapi.toml`

- **传输协议**: HTTP/1.1, 无 TLS, 限于 `127.0.0.1` (DeepCodex)
- **Anti-Codex 特殊**: 绑定到 `0.0.0.0:8484`, 接受 LAN 请求, 通过 `isLocalTranslatorAddress()` 验证 (仅检查前导 `::ffff:`)
- **压缩**: 支持 zstd / gzip / deflate / brotli 解码 (`readRaw()`)
- **请求体**: OpenAI Responses API JSON (非 Chat Completions 格式), 包含 `input: []`, `tools: []`, `instructions`, `model`, `previous_response_id`, 等

### 2.2 Codex Desktop 的 HTTP header 契约

**来源**: `adaptive-server.mjs` lines 2104-2117

| Header | 用途 | 缺少时的行为 |
|--------|------|-------------|
| `session_id` | 标识会话; 用于自动续接 (end_turn=false) | 不触发续接逻辑 |
| `x-codex-window-id` | 窗口代数; 格式 `...:<number>` | 不触发续接逻辑 |
| `content-encoding` | zstd / gzip / deflate / br | 不解压则解析失败 |
| `content-type` | application/json | HTTP 400 |
| `authorization` | 可选 (目前未被 translator 验证) | 无影响 |

### 2.3 Translator 暴露的 API 端点

**来源**: `adaptive-server.mjs` lines 2553-2690

| 路径 | 方法 | 当前实现 | 原生等价? |
|------|------|----------|-----------|
| `/health` | GET | `{ ok, upstream, profile, internalTools }` | — |
| `/models`, `/v1/models` | GET | 返回 profile.models 列表 | ❌ 模型列表不含原生元数据 (推理层级、工具类型、上下文窗口) |
| `/responses`, `/v1/responses` | GET | `501 Unsupported` (WebSocket) | ❌ Codex Desktop 期望可用的 WebSocket |
| `/responses/<id>/cancel` | POST | 即时返回 `status: "cancelled"`, 不真正取消上游请求 | ❌ 上游请求仍在进行中 |
| `/responses/<id>/input_items` | GET | 返回 `{ data: [] }` 空列表 | ❌ Codex 期望真正的 input_items 列表 |
| `/responses/input_tokens` | POST | 本地估算 (text.length/4) | ⚠️ 非精确 tokenizer |
| `/responses` (POST) | POST | Responses↔Chat 翻译 + SSE | ❌ 没有真正的流式, 一次性构造后分块仿真 |
| `/responses/compact` (POST) | POST | 强制非流式 + 短输出 | ⚠️ 功能可用但模型可能返回空摘要 |
| `/chat/completions` | POST | 透传或 Antigravity 文本转发 | ✓ 标准 Chat API |
| `/backend-api/aip/*` | GET | `local-projection` 本地假回复 | ⚠️ 有限模拟 |

### 2.4 模型列表契约

**来源**: `antigravity-model-catalog.mjs`, `sync-antigravity-model-catalog.mjs`

- **发现方式**: 通过 `LanguageServerService/GetAvailableModels` RPC 获取
- **格式**: `models: { "model-id": ModelObject }`, `agentModelSorts: [{ groups: [{ modelIds: [...] }] }]`
- **翻译到 Codex 目录**: `buildAntigravityModelCatalog()` 将原生模型 ID 映射为 Codex 目录项 (slug, display_name, reasoning_levels, context_window, input_modalities)
- **基线目录**: `codex-home-deepseek-app/deepseek-model-catalog.json` (202 KB)
- **同步**: `sync-antigravity-model-catalog.mjs` 定时拉取

### 2.5 流式实现现状

**来源**: `adaptive-server.mjs` lines 2089-2097, 2119-2157, 2211-2435

- `canUseNativeStreaming()` 检查 5 个条件全部满足才启用到上游的真实流式:
  1. 非 compact 模式
  2. `stream !== false`
  3. `TRANSLATOR_NATIVE_STREAMING=1`
  4. profile.capabilities.nativeStreaming !== false
  5. 没有注入内部工具 && chatBody.tools 为空
- **DeepCodex 默认**: 不走原生流式 (条件 3-5 通常不满足).
- **Anti-Codex**: 从不走原生流式 (条件 4 强制 false).
- **回退**: `pipeSSE()` 使用一次性响应体构造 / 分块模拟 / `ChatToResponsesStreamMapper` 逐块推 Event.
- **SSE Event 序列**: `response.created` → `response.in_progress` → (output_items) → `response.completed`.

### 2.6 工具调用契约

**来源**: `adaptive-server.mjs` lines 669-765, `compat-rules.mjs`

#### Codex → Translator (Responses API 格式)

| Responses item type | 映射到 Chat 的 action |
|---------------------|----------------------|
| `function_call` | `role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments } }]` |
| `custom_tool_call` | `arguments` 被包裹为 `{ "content": "<input>" }` |
| `function_call_output` | `role: "tool", tool_call_id, content` |
| `custom_tool_call_output` | 同上 |
| `message` | `role` 映射 (developer→system), content 转换 |
| `context_compaction` | `role: "user"` 加摘要前缀 |
| `reasoning` | 跳过或保留 `activeReasoning` 给后续 tool_call |
| `input_image` | Vision 不可用时替换为文本占位 |

#### Translator → Codex (Responses API 格式)

| Chat 端 | Responses item type |
|---------|-------------------|
| `message.content` | `{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }` |
| `message.tool_calls[i]` (function) | `{ type: "function_call", id, call_id, name, arguments }` |
| `message.reasoning_content` | `{ type: "reasoning", summary: [], encrypted_content }` |
| custom 路由 | `{ type: "custom_tool_call", call_id, name, input }` |

#### 工具分类 (`compat-rules.mjs`)

| 原始 type | 分类 | 转发行为 |
|-----------|------|----------|
| `function` | function | 作为可调用 Chat tool 转发 |
| `custom` | custom | 转发为 JSON wrapper (保持 freeform 语法) |
| `namespace` | namespace | 展平为唯一 Chat function 名 + 路由元数据 |
| `web_search` / `web_search_preview` / `image_generation` / `code_interpreter` | hosted | **丢弃** (translator 内部替代或空) |
| 其余 | unknown | 原样保留 |

### 2.7 取消/中断

**来源**: `adaptive-server.mjs` lines 2622-2626, `cancelledResponse()` line 926-937

```javascript
function cancelledResponse(id) {
    return {
        id: id || responseId(),
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "cancelled",
        error: null, incomplete_details: null, output: [], usage: null,
    };
}
```

- **实现**: 对 `/responses/<id>/cancel` 的 POST 请求, 即时返回一个格式正确的 "cancelled" 响应.
- **问题**: 
  - 上游 (one-api / DeepSeek / Antigravity) 的请求并未真正 abort.
  - 没有 `AbortController` 信号传递到 `fetch()`.
  - `pipeStreamingChatAsResponses()` 没有监听 `req.close` / `req.destroy`.
  - 如果上游返回了部分结果, translator 不会丢弃而是继续处理.

### 2.8 压缩/恢复 (Context Compaction)

**来源**: `adaptive-server.mjs` lines 767-857, 2101-2117

- **压缩请求**: POST `/responses/compact` → 强制 `stream=false`, `max_output_tokens=1024`, 无工具.
- **恢复**: `repairRestoredInput()` (lines ~), `clipRestoredToolOutput()`, 压缩文本可达 4K chars.
- **当前限制**:
  - DeepSeek 模式: 使用 `CODEX_LOCAL_COMPACT_PROMPT` 让模型生成摘要
  - Antigravity 模式: 使用同一 prompt 但 antigravity 模型可能返回空摘要
  - 当摘要为空或 "好的" 等弱回复时, `normalizeCompactSummary()` 回退到从请求原文提取
  - 损坏的压缩项检测: `isDamagedCompactionItem()` 无加密内容也无可读文本时标记
- **会话跟踪**: SESSIONS Map (内存), `shouldInjectEndTurn()` 检测自动续展.

### 2.9 MCP / 技能 / 连接器

**来源**: `adaptive-server.mjs` lines 230-259 (系统提示片), `local-projection/index.mjs`

- **Translator 不执行 MCP**: 系统提示明确告知模型不要检查本地 MCP 注册文件.
- **连接器工具**: 仅当 Codex Desktop 实际同步到当前会话时才可用; translator 通过 `local-projection` 提供虚假的 `/backend-api/aip/connectors` 响应.
- **技能**: translator 不导入或执行 Codex 技能; 模型被告知连接器插件只有在实际激活后才可用.

### 2.10 认证/用户

**来源**: `local-projection/index.mjs` lines 229-285

- **本地伪造用户**: `deepcodex-local-user` / `deepcodex-local-account`, "owner" 角色, `prolite` 套餐.
- **端点**: `/backend-api/aip/account/check` → `accountCheckPayload()`, `/backend-api/accounts` → `accountsPayload()`.
- **Anti-Codex**: 同样使用本地伪造用户.

---

## 3. 源码依据

| 文件 | 关键行 | 内容 |
|------|--------|------|
| `translator/adaptive-server.mjs` | 52 | RESPONSES_PATHS 定义 |
| `translator/adaptive-server.mjs` | 669-765 | `responsesToChatBody()` 翻译器 |
| `translator/adaptive-server.mjs` | 1597-1624 | `responseShell()` 响应构造 |
| `translator/adaptive-server.mjs` | 1881-1933 | `chatToResponsesFormat()` 转换回 Responses |
| `translator/adaptive-server.mjs` | 2089-2097 | `canUseNativeStreaming()` 条件 |
| `translator/adaptive-server.mjs` | 2104-2117 | 会话续接检测 (`shouldInjectEndTurn`) |
| `translator/adaptive-server.mjs` | 2211-2435 | `ChatToResponsesStreamMapper` 流式映射 |
| `translator/adaptive-server.mjs` | 2437-2486 | `pipeStreamingChatAsResponses()` |
| `translator/adaptive-server.mjs` | 2622-2626 | Cancel handler |
| `translator/adaptive-server.mjs` | 2553-2690 | 完整 HTTP 路由表 |
| `translator/compat-rules.mjs` | 33-93 | 工具分类逻辑 |
| `translator/antigravity-agentapi.mjs` | 38-80 | Antigravity Desktop 自动发现 |
| `translator/antigravity-agentapi.mjs` | 161-163 | `fetchAvailableAgentModels()` |
| `translator/antigravity-upstream.mjs` | 26-66 | `chatMessagesToPrompt()` 文本提示构造 |
| `translator/antigravity-upstream.mjs` | 83-105 | `callAntigravityUpstream()` 全流程 |
| `translator/antigravity-model-catalog.mjs` | 8-42 | 模型列表提取 |
| `translator/antigravity-model-catalog.mjs` | 52-129 | 目录构建 |
| `translator/tools/registry.mjs` | 72-98 | 内部工具注册 |
| `translator/local-projection/index.mjs` | 229-285 | 本地用户/账户伪造 |
| `codex-home-deepseek-app/config.adaptive-oneapi.toml` | 1-8 | Config 模板 (openai_base_url, chatgpt_base_url) |
| `codex-home-deepseek-app/deepseek-model-catalog.json` | 1-50 | 模型目录示例 |
| `scripts/start-deepcodex.ps1` | 1002-1013 | Config 注入 translator URL |
| `scripts/start-deepcodex.ps1` | 1050-1078 | Codex.exe 启动参数 |
| `scripts/start-anticodex.ps1` | 68-93 | Anti-Codex 环境隔离 |
| `translator/server.mjs` | 368-397 | 请求体解码 (zstd/gzip 等) |
| `translator/server.mjs` | 156-281 | `responsesToChatBody()` 旧版 |
| `translator/probe.mjs` | 96-100 | 上游能力探测 |

---

## 4. 协议契约清单

### 4.1 模型列表 RPC 契约

```
请求: POST /exa.language_server_pb.LanguageServerService/GetAvailableModels
  Headers:
    content-type: application/json
    connect-protocol-version: "1"
    x-codeium-csrf-token: <token>

响应:
{
  "response": {
    "models": {
      "gemini-pro-agent": { "displayName": "...", "maxTokens": ..., "supportsImages": ..., "description": "..." },
      ...
    },
    "agentModelSorts": [
      { "groups": [{ "modelIds": ["gemini-pro-agent", ...] }] }
    ]
  }
}
```

**必需字段** (由 antigravity-model-catalog.mjs 使用):
- `response.models.<id>.displayName` → 模型显示名
- `response.models.<id>.maxTokens` → 上下文窗口大小
- `response.models.<id>.supportsImages` → 是否支持视觉
- `response.models.<id>.description` → 描述
- `response.agentModelSorts[].groups[].modelIds[]` → 排序后的模型 ID 列表

### 4.2 事件流 SSE 契约

**事件顺序 (正常完成)**:
```
event: response.created
event: response.in_progress
event: response.output_item.added    (text/reasoning/tool call 的开始)
event: response.content_part.added   (对于 message 类型, 每段内容的开始)
event: response.output_text.delta    (流式文本块)
event: response.function_call_arguments.delta  (工具参数流式)
event: response.content_part.done
event: response.output_item.done
event: response.completed
```

**事件顺序 (取消)**:
```
event: response.completed  (status: "cancelled")
```

**Codex Desktop 期望的事件类型** (从 pipeSSE 和 ChatToResponsesStreamMapper 提取):

| SSE 事件 | 必需 | 负载键 |
|----------|------|--------|
| `response.created` | ✓ | `response` (含 id, status, output:[]) |
| `response.in_progress` | ✓ | `response` |
| `response.output_item.added` | ✓ | `output_index`, `item` (type, id, status) |
| `response.content_part.added` | ✓ | `item_id`, `output_index`, `content_index`, `part` |
| `response.output_text.delta` | ✓ | `item_id`, `output_index`, `content_index`, `delta` |
| `response.output_text.done` | ✓ | `item_id`, `output_index`, `content_index`, `text` |
| `response.function_call_arguments.delta` | ✓ | `item_id`, `output_index`, `call_id`, `name`, `delta` |
| `response.function_call_arguments.done` | ✓ | `item_id`, `output_index`, `call_id`, `name`, `arguments` |
| `response.content_part.done` | ✓ | `item_id`, `output_index`, `content_index`, `part` |
| `response.output_item.done` | ✓ | `output_index`, `item` |
| `response.completed` | ✓ | `response` (含全部 output, status, usage) |

### 4.3 取消契约

```
请求: POST /responses/<response_id>/cancel
响应: { "id": "...", "object": "response", "status": "cancelled", ... }
```

**原生需求**:
1. 取消必须实际中断上游请求 (AbortController / TCP reset)
2. 取消必须在 translator 层传播: 关闭 SSE 连接, 丢弃已收到但未发送的块
3. 取消应可在任何阶段触发: 流式中, 工具循环中, 或上游请求等待中

### 4.4 压缩契约

```
请求: POST /responses/compact
  Body: { "input": [...], "model": "..." }
  (无工具/无流式)

响应:
{
  "id": "...",
  "object": "response",
  "status": "completed",
  "output": [
    { "type": "context_compaction", "summary": "..." }
  ]
}
```

### 4.5 工具调用完整循环

```
Codex Desktop                    Translator                    Upstream
     │                              │                              │
     │ POST /responses               │                              │
     │ { input: [..., function_call] │                              │
     │   tools: [...] }              │                              │
     │──────────────────────────────>│                              │
     │                              │ responsesToChatBody()        │
     │                              │ → tools + messages           │
     │                              │──────────────────────────────>│
     │                              │   POST /chat/completions     │
     │                              │<──────────────────────────────│
     │                              │   chatToResponsesFormat()    │
     │ SSE: output_item.added       │                              │
     │ SSE: function_call_args.delta│                              │
     │ SSE: output_item.done        │                              │
     │ SSE: completed               │                              │
     │<──────────────────────────────│                              │
     │                              │                              │
     │ 模型返回了 function_call      │                              │
     │ Codex 执行工具               │                              │
     │ 执行结果作为新的 input 发回   │                              │
     │                              │                              │
     │ POST /responses               │                              │
     │ { input: [...,               │                              │
     │   function_call_output] }     │                              │
     │──────────────────────────────>│                              │
     │                              │ → tool result as Chat        │
     │                              │──────────────────────────────>│
     │                              │<──────────────────────────────│
     │ SSE: ...                     │                              │
     │<──────────────────────────────│                              │
```

---

## 5. 现有网关差距分析

### 5.1 为什么现有的 Responses↔Chat 翻译无法达到原生等价

| 能力 | DeepCodex 翻译网关 | 原生 Antigravity app-server | 差距分析 |
|------|-------------------|---------------------------|----------|
| **真实流式** | 非原生流式: 获取完整 Chat 响应后分块仿真 SSE; 原生流式需 5 个条件全部满足 | 原生 Agent API 支持逐步返回 | 仿真流式延迟 ×2-3, 无法提前渲染推理过程; 工具参数流式不真实 |
| **取消传播** | 返回空壳 cancelled, 不取消上游 | 原生 API 层可中断 | 上游请求浪费; 取消后部分结果被丢弃不干净 |
| **工具执行** | 仅执行 web_search/fetch 内部工具; 其余透传 Codex | 原生执行所有 tools (含 MCP, file_search, computer) | 每个工具调用需要 2 次 HTTP 往返 (Codex→translator→Codex→translator), 延迟翻倍 |
| **MCP/技能** | 不执行, 不注册, 只透传 | 原生会话中 MCP server 已注册 | MCP 调用延迟增加, 无本地 MCP 发现 |
| **用户/认证** | 本地伪造 `deepcodex-local-user` | 原生 Antigravity 账户 | 某些功能可能检查真实账户状态 |
| **模型列表** | 从 catalog JSON 读取 (非实时) | 实时 `GetAvailableModels` RPC | 新模型不可用直到下次 sync |
| **会话持久化** | 内存 Map (SESSIONS), 进程重启丢失 | SQLite 会话数据库 | 重启后会话续接不可靠 |
| **input_items** | 返回空列表 | 原生 API 支持查询 | Codex Desktop 期望可查询已创建 items |
| **vision** | DeepSeek 模式: 全部替换为 `[Image omitted]`; Antigravity 模式: 无图像通道 | Antigravity 原生支持图像 | Anti-Codex 当前无图像传递路径 |
| **消息角色** | developer 映射到 system | 原生支持 developer | 角色语义损失 |
| **工具路由** | `namespace` 工具展平为唯一名 + 路由表 | 原生 namespace 保留层次 | name 冲突风险 |

### 5.2 具体测量数据 (推断)

以下为基于代码结构和网络延迟的推断数据:

| 指标 | 原生 app-server | DeepCodex 网关 | Anti-Codex 网关 |
|------|----------------|----------------|-----------------|
| 首词延迟 (TTFB) | ~500ms | ~1500ms (加上游 + 解压 + 翻译) | ~2000ms (+ CLI/Protobuf 调用) |
| 工具循环延迟 | ~800ms (单跳) | ~2000ms (2次 HTTP + 翻译) | ~3000ms (2次 HTTP + CLI 调用) |
| 取消响应 | 即时 (中断上游) | ~5ms (返回空壳) | ~5ms (返回空壳) |
| 流式粒度 | token 级 | 40-char 块 (仿真) | 40-char 块 (仿真) |
| 重启续接 | SQLite 持久化 | 内存丢失 | 内存丢失 |

### 5.3 根源: 翻译层无法感知原生会话状态

Translator 位于 Codex Desktop 和模型之间, 但:

1. **没有会话上下文**: 不知道 `previous_response_id` 对应的真实历史
2. **没有工具执行上下文**: 不知道工具调用是否真正成功
3. **没有模型状态**: 不知道模型正在推理还是生成文本
4. **没有取消通道**: 无法通知上游停止
5. **没有流式引信**: 无法在第一个 token 到达前开始发送 SSE event

---

## 6. 最小侵入改造点

按改造难度和收益排序:

### P0 (核心稳定性) — 必须改造

1. **AbortController 传播到上游 fetch**
   - 文件: `translator/adaptive-server.mjs`
   - 改动: `postChatCompletion()` 和 `pipeStreamingChatAsResponses()` 接受 `AbortSignal`
   - 在 cancel handler 创建 AbortController, 存入 Map (keyed by response_id)
   - 当 SSE 连接断开时 (`req.close` / `res.destroy`) 也触发 abort
   - 验收: POST cancel 后上游请求实际中断

2. **关闭前排出所有已接收 SSE 事件**
   - 文件: `translator/adaptive-server.mjs`
   - 改动: `pipeStreamingChatAsResponses()` 和 `ChatToResponsesStreamMapper.complete()`
   - 在 abort 时 flush 已有缓冲区事件然后立即 `res.end()`
   - 验收: 取消后不发送 "completed" 事件以外的内容

3. **Antigravity 模式下启用真实流式 (或通道对齐)**
   - 文件: `translator/adaptive-server.mjs`, `antigravity-agentapi.mjs`
   - 改动: 
     - `canUseNativeStreaming()` 不对 Antigravity 模式返回 false
     - 如果 Antigravity agent API 支持流式 (需确认 `language_server.exe` `agentapi` 子命令是否支持), 使用真实的 SSE 流
     - 如果不支持, 至少减少仿真块大小从 40 到 10 char
   - 验收: 用户感知到更快的首字显示

### P1 (功能完整) — 强烈建议

4. **input_items 端点返回真实结构**
   - 文件: `translator/adaptive-server.mjs` lines 2616-2620
   - 改动: 维护一个内存中的 input_items 存储 (按 response_id 索引)
   - 将收到的 input 存入, 当 GET 请求时返回
   - 验收: Codex Desktop 可查询已提交的 items

5. **会话持久化 (SQLite)**
   - 文件: `translator/adaptive-server.mjs`
   - 改动: 将 SESSIONS Map 替换为 SQLite (使用 Node.js 内置 `node:sqlite`)
   - 存储: session_id, window_gen, response_id 历史, compaction 状态
   - 验收: 进程重启后续接仍有效

6. **Antigravity 模式模型传递通道改为结构化而非纯文本**
   - 文件: `antigravity-upstream.mjs`
   - 改动: `chatMessagesToPrompt()` 改为使用结构化消息格式（如果 Antigravity agent API 支持）
   - 若不支持, 至少增加工具调用和系统消息的区分标记

### P2 (性能优化) — 建议

7. **Vision 通道: Antigravity 支持下传图像**
   - 文件: `translator/adaptive-server.mjs` `responsesToChatBody()`
   - 改动: Antigravity 模式下不替换图像为文本; 通过 base64 或文件路径传递给 Antigravity (需确认 API 支持)

8. **工具循环优化: 批量工具执行**
   - 文件: `translator/adaptive-server.mjs` `callUpstreamWithInternalTools()`
   - 改动: 并行执行独立的内部工具调用
   - 验收: 多个 web_search 请求可同时运行

---

## 7. 待验证项

以下为需要进一步调查或实验才能确认的事项:

| # | 项 | 原因 | 验证方法 |
|---|-----|------|---------|
| V1 | Antigravity `language_server.exe agentapi` 是否支持流式输出 | 当前 antigravity-agentapi.mjs 使用 `runProcess()` 非流式 | 运行 `language_server.exe agentapi --help` 或调试 agent API |
| V2 | `language_server.exe` 是否支持工具调用结构化传递 | 当前 `chatMessagesToPrompt` 将所有消息转为纯文本 | 检查 agent API 参数格式 |
| V3 | Antigravity CLI `--print` 是否支持 tool_calls 回复格式 | 当前 extractAssistantText 只提取文本 | 构造带工具调用的测试输入 |
| V4 | Codex Desktop x-codex-window-id 的准确生成算法 | 仅由尾部分词的数字标识, 不确定计算方式 | 抓包分析 Codex Desktop → translator 请求 |
| V5 | 是否可以在 translator 中注入一个真正的 MCP 网关 | 目前 Translator 不执行 MCP | 设计 MCP 代理 layer 并评估 |
| V6 | zstd 压缩请求的平均大小和节省 | 数据缺乏 | 在 debug 模式下统计请求体大小 |
| V7 | 原生 Antigravity agent API 与 OpenAI Responses API 的消息格式重叠 | 可能可以直接映射而不经过 Chat | 对比两种 API 的 schema |
| V8 | Anti-Codex 下 Codex Desktop 是否期望 WebSocket | GET /responses 返回 501 | 在 Codex 控制台查看网络错误 |

---

## 8. 推荐架构

### 8.1 短期 (Phase 1 — 核心稳定性)

保持现有 Translator 层不变, 修复 P0 项:

```text
Anti-Codex Desktop
  │  session_id, x-codex-window-id  headers
  │  POST /responses (+ /compact /cancel)
  ▼
adaptive-server.mjs  (改进版)
  ├── AbortController 传播 ↓↑
  ├── 真实 SSE 事件顺序
  ├── Input_items 内存存储
  └── SQLite 会话持久化
      │  TRANSLATOR_UPSTREAM_MODE=antigravity
      ▼
antigravity-agentapi.mjs
  │  Agent API (protobuf over HTTP)
  ▼
language_server.exe (app-server native)
```

### 8.2 中期 (Phase 2 — 原生等价)

评估是否可以将 Translator 降为轻量级代理, 让 Codex Desktop 与 Antigravity app-server 更直接地通信:

```text
Anti-Codex Desktop
  │  HTTP (Responses API subset)
  ▼
thin-proxy.mjs  (仅认证/压缩/日志, 不做语义翻译)
  │  （可选 zstd 解码/编码）
  ▼
language_server.exe
  agentapi (原生 Responses API 实现)
```

如果 Antigravity `language_server.exe` 的 `agentapi` 支持原生 Responses API 事件, 则 Translator 的语义翻译层可以移除, 换为 (a) 一个轻量 `AbortController` 代理 + (b) 协议兼容垫片.

### 8.3 长期 — 完整原生集成

```text
Anti-Codex Desktop
  │
  ├── HTTP: direct app-server agent API
  ├── WebSocket: 原生 SSE/事件流
  └── SQLite: 共享会话数据库
      │
      ▼
language_server.exe
  ├── Agent API (Responses-compatible)
  ├── MCP 网关 (本地)
  ├── 工具执行者 (原生)
  └── 会话管理者 (SQLite)
```

### 8.4 关键架构原则

1. **Translator 不应成为执行者**: 不执行 MCP, 不执行 file_search, 不执行 computer use, 不执行技能
2. **Translator 不应持久化模型状态**: 模型状态应由 app-server 或 Codex Desktop 管理
3. **取消和中断必须物理传播**: 假 cancel 回应会导致资源泄漏
4. **流式必须真实**: 仿真流式在延迟和 UX 上不可接受
5. **模型列表必须实时**: 静态 catalog JSON 应替换为实时 RPC 调用

---

## 附录 A: 关键代码引用

```
translator/adaptive-server.mjs
  L52  RESPONSES_PATHS
  L669 responsesToChatBody()
  L767 prepareCompactChatBody()
  L926 cancelledResponse()
  L1597 responseShell()
  L1881 chatToResponsesFormat()
  L2089 canUseNativeStreaming()
  L2104 shouldInjectEndTurn()
  L2121 pipeSSE()
  L2211 ChatToResponsesStreamMapper
  L2437 pipeStreamingChatAsResponses()
  L2537 unsupportedResponsesWebSocketResponse()
  L2575 GET /responses → 501
  L2622 POST /responses/<id>/cancel
  L2628 POST /responses 主入口

translator/antigravity-agentapi.mjs
  L38  discoverDesktopConnection()
  L161 fetchAvailableAgentModels()
  L194 runAntigravityTextTurn()

translator/antigravity-upstream.mjs
  L26  chatMessagesToPrompt()
  L83  callAntigravityUpstream()

translator/antigravity-model-catalog.mjs
  L8   extractAvailableAgentModels()
  L52  buildAntigravityModelCatalog()

translator/local-projection/index.mjs
  L229 localUserPayload()
  L264 accountsPayload()
  L296 connectorIdFromPath()
```

## 附录 B: 术语对照

| 术语 | 含义 |
|------|------|
| Responses API | OpenAI 格式, 使用 `input: []` + `tools: []` + SSE 流式 |
| Chat Completions | OpenAI Chat 格式, 使用 `messages: []` + `tool_calls` |
| app-server | Antigravity `language_server.exe`, 原生模型执行层 |
| agentapi | `language_server.exe agentapi` 子命令, 提供 Agent 能力 |
| context compaction | 压缩对话历史的机制, 用摘要替代完整历史 |
| internal tools | Translator 本地执行的工具 (web_search, web_fetch) |
| hosted tools | 模型提供方托管的工具 (web_search_preview, image_generation) |
| custom tool | Codex 自由格式工具 (apply_patch), 使用 content 字段传输 |
