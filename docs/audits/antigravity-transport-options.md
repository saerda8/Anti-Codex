# Anti-Codex 核心稳定性重建 Phase 1: Antigravity 传输方案审计报告

> **审计背景**: Anti-Codex 核心稳定性重建 Phase 1
> **审计目标**: 评估和对比本机 Antigravity CLI 与桌面语言服务（Language Server）中用于长期稳定模型执行的接口，评估 CLI 每轮启动、持久 CLI 会话、桌面 HTTP/Connect 服务、直接调用内部服务四种方案。
> **审计时间**: 2026-06-11
> **运行态目录策略**: 本审计遵循只读安全策略，不修改任何 Codex/Antigravity 状态及原有项目代码。

---

## 1. 本机环境探测与模型来源验证

基于本机环境的实际运行状态和只读接口探测，确认以下事实：

### 1.1 关键二进制文件与路径
* **Antigravity CLI**: [antigravity.exe](file:///C:/Users/XD/bin/antigravity.exe)
* **内部服务封装脚本**: [agentapi.bat](file:///C:/Users/XD/AppData/Local/Temp/antigravity-code-worker-home-7d85a2e8-56e8-40d9-bfb2-eaf91b8d923d/.gemini/antigravity-cli/bin/agentapi.bat)
* **桌面语言服务服务**: [language_server.exe](file:///C:/Users/XD/AppData/Local/Programs/antigravity/resources/bin/language_server.exe)

### 1.2 桌面语言服务运行态观察 (PID: 10404)
通过 PowerShell 执行 CIM/TCP 状态探测，确认 `language_server.exe` 的命令行参数及监听端口如下：
* **启动命令行参数**:
  ```text
  language_server.exe --standalone --override_ide_name antigravity --subclient_type hub 
  --override_ide_version 2.0.11 --override_user_agent_name antigravity --https_server_port 0 
  --csrf_token <redacted> --app_data_dir antigravity 
  --api_server_url https://generativelanguage.googleapis.com 
  --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com --enable_sidecars
  ```
* **CSRF Token**: `<redacted>` (从运行进程参数动态解析获取)
* **监听端口**:
  * `62248` (lsAddress - HTTP Connect 服务端口)
  * `62247` (agentApiAddress - 闭合 gRPC 服务端口，直接通过 HTTP/1.1 POST 调用会遭遇连接重置/超时)

### 1.3 模型名与 ID 来源验证
通过向 `http://127.0.0.1:62248/exa.language_server_pb.LanguageServerService/GetAvailableModels` 发送带有 `X-Codeium-Csrf-Token` 的 HTTP POST 请求，成功实时获取到当前 Antigravity 账号下可用的 8 个模型 ID：
1. `gemini-3.5-flash-low` (系统默认代理模型)
2. `gemini-3-flash-agent`
3. `gemini-3.5-flash-extra-low`
4. `gemini-3.1-pro-low`
5. `gemini-pro-agent`
6. `claude-sonnet-4-6`
7. `claude-opus-4-6-thinking`
8. `gpt-oss-120b-medium`

> [!NOTE]
> 这里的模型 ID 和显示名称均来自当前本地登录的 Antigravity 云端账户同步结果。这些 ID 在 `translator/antigravity-model-catalog.mjs` 中被映射到 Codex 能够理解的 `slug` 和 `supported_reasoning_levels` 字段中。

---

## 2. 方案对比矩阵

| 评估维度 | 方案 1: CLI 每轮启动 | 方案 2: 持久 CLI 会话 | 方案 3: 桌面 HTTP/Connect 服务 | 方案 4: 直接调用内部服务 |
| :--- | :--- | :--- | :--- | :--- |
| **工作原理** | 每次 turn 启动新 CLI 进程，读取本地 SQLite DB 获取回复 | 维持一个交互式 CLI 子进程，通过 stdin/stdout 流式交互 | 发现本地端口和 CSRF，直接向本地 HTTP 服务发送 Connect 请求 | 调用 `language_server.exe agentapi` 提供的封装命令 |
| **流式支持 (Streaming)** | ❌ 不支持 (必须等进程退出) | ⚠️ 伪支持 (解析控制台 ANSI 符号) |  **支持 (Connect 协议 Server-Stream)** | ❌ 不支持 (同步阻塞返回) |
| **取消响应 (Cancellation)**| ❌ 弱 (仅杀本地进程，云端不中断) | ❌ 弱 (Windows 下子进程 SIGINT 极其脆弱)|  **支持 (Aborted HTTP Socket 自动传递)**| ❌ 弱 (仅杀本地进程) |
| **工具调用 (Tool Calling)**| ❌ 纯文本桥 (无法支持 native 循环) | ❌ 纯文本桥 (无法拦截或向外暴露) |  **支持 (支持 gRPC/Connect 结构化传递)**| ❌ 纯文本桥 (无法支持) |
| **长上下文 (Long Context)**| ❌ 差 (受命令行 32KB 限制且消耗大)| ⚠️ 中 (依赖交互式进程的内存状态) |  **支持 (无限制，支持 HTTP 结构化 Payload)**| ❌ 差 (受限于命令行及子命令参数)|
| **会话复用 (Session Reuse)**| ❌ 差 (每轮重新建立，开销极大) |  **支持 (进程内状态维持)** |  **支持 (通过 conversation_id 恢复上下文)**| ⚠️ 半支持 (可指定 recipient_id/UUID)|
| **模型精确选择** |  **支持** (通过 `--model` 参数) |  **支持** (启动时指定 `--model`) |  **支持** (请求 JSON 携带精确 model id) | ❌ 差 (只支持 flash_lite/flash/pro 粗分类) |
| **账号切换 (Account)** | ⚠️ 静态 (以当前机器登录态为准) | ❌ 差 (需重启子进程以重新载入) |  **支持 (随桌面服务动态更新模型列表)** | ⚠️ 静态 (以当前机器登录态为准) |
| **崩溃恢复 (Recovery)** |  **高** (单次失败不影响全局) | ❌ 差 (进程崩溃导致上下文全部丢失) |  **支持 (端口再发现与重试机制)** |  **高** (单次失败不影响全局) |
| **能力分类定位** | **纯文本桥 (Text-only Bridge)** | **纯文本桥 (Text-only Bridge)** | **Codex 原生语义支撑** | **纯文本桥 (Text-only Bridge)** |

---

## 3. 四大传输方案详细审计

### 方案 1: CLI 每轮启动 (CLI invocation per turn)
目前 Anti-Codex 已有代码实现的方案，主要通过 `antigravity.exe` 执行单次转写。

* **已验证事实**:
  * 每次转写需要新建临时 Prompt 文件和日志文件，调用 `antigravity.exe --print-timeout 5m --print` 启动。
  * 由于 `stdout` 的提取可能受干扰，当前实现从 `~/.gemini/antigravity-cli/conversations/<uuid>.db` (SQLite) 查找 `step_payload`（通过 `step_type = 15` 和 `status = 3`）。
  * 对 `step_payload` 进行正则式 Protobuf 字符串剥离 (`walkProtobuf`) 提取出 Assistant 文本。
* **推断**:
  * 进程每次冷启动会带来巨大的延迟开销（约 1.5s - 2.5s），导致即使在文本交互下 TTFB 也非常高。
  * Windows 命令行参数长度限制（虽 `CreateProcess` 限制为 32,767 字符，但仍构成对极长上下文的硬物理限制）。
* **脆弱内部依赖**:
  * 依赖 CLI 本地 SQLite 的数据库结构变化。若表名或 `step_type`/`status` 的定义变更将直接造成功能失效。
  * Protobuf 剥离逻辑基于 Heuristics 启发式匹配过滤（过滤类似 UUID, base64, 数值等），容易误杀助手正常输出中包含的哈希串或特定英文单词。
* **八个维度评估**:
  * *流式/取消/工具调用*: 均无法实现或仅为假取消/假流式模拟。
  * *会话复用*: 无，每一次都是独立的 CLI 交互重构。
  * *崩溃恢复*: 异常会被 translator 捕获进行重试，崩溃隔离度高，但容易残留临时文件。

### 方案 2: 持久 CLI 会话 (Persistent CLI session)
以 `-i` 或 `--prompt-interactive` 参数启动 `antigravity.exe`，使其作为常驻后台子进程，使用 `stdin` 写入 Prompt，使用 `stdout` 读出结果。

* **已验证事实**:
  * `antigravity.exe --help` 明确包含 `--prompt-interactive` (-i) 命令。
* **推断**:
  * 解析控制台输出非常困难。控制台伴随 ANSI 转义字符、Spinner 动态加载符号、`>` 提示符以及调试日志。从这些非结构化流中精准剔除出模型回复的 Markdown，可靠性极低。
  * Windows 系统下，在 Node.js 中向后台进程发送 SIGINT/Ctrl+C 会由于控制台组（Console Group）的限制，无法精准传递给子进程，极易导致父进程协同挂掉或上游根本无法中断。
* **脆弱内部依赖**:
  * 控制台输出格式高度依赖 CLI 版本，终端排版稍微变化就会使解析正则崩溃。
* **八个维度评估**:
  * *流式*: 理论上可以通过监听 `stdout` 增量事件做到，但需要清洗控制台符号。
  * *取消*: 在 Windows 系统下难以稳定实现。
  * *模型精确选择*: 仅能在启动时指定，中途更换模型必须重启进程。
  * *长上下文/会话复用*: 相比每轮启动有所改善，因为进程生命周期延续。

### 方案 3: 桌面 HTTP/Connect 服务 (Desktop HTTP/Connect Service)
直接向本地正在运行的 `language_server.exe` 发送符合 Connect (gRPC over HTTP) 协议的 HTTP 接口请求。

* **已验证事实**:
  * `language_server.exe` 运行时会将 CSRF Token 和监听端口作为进程命令行参数暴露。
  * 可以通过 Windows CIM (WMI) 稳定获取其参数，并根据 TCP 侦听状态找到对应的端口（如 `62248`）。
  * 成功通过 POST 请求直接调用 `GetAvailableModels` RPC 并获得完整的模型 JSON 列表，延迟极低（约十几毫秒）。
* **推断**:
  * 该服务在底层使用了符合标准的 Connect 协议（通常基于 `application/connect+json`），它天然支持 Chunked 流式返回，可直接映射到 Codex 的 SSE 协议流。
  * 对 HTTP 请求调用 `AbortController.abort()` 会物理切断 TCP 连接，本地 `language_server.exe` 收到连接断开信号后会立即向上游 Google AI API 发送取消请求，实现物理级取消。
  * 没有任何上下文长度的物理命令行限制，支持完整的 JSON/Protobuf 数据包交互。
* **脆弱内部依赖**:
  * 依赖 `language_server.exe` 启动参数的命名。如果未来 `--csrf_token` 或 `--app_data_dir` 参数格式改变，需要更新端口发现脚本。
  * 依赖 Connect 协议的具体 RPC 方法名与数据 Payload 格式（需要解析 protobuf 结构）。
* **八个维度评估**:
  * *流式/取消/会话/账号切换*: 全部原生支持，在所有方案中评级最高。
  * *工具调用*: 支持传递结构化工具声明，理论上可以支持模型原生的外部工具调用交互。
  * *崩溃恢复*: 即使桌面程序被用户重启，端口发生改变，我们的 Node 服务也可以在请求失败时重新执行端口与 Token 扫描，实现无缝崩溃恢复。

### 方案 4: 直接调用内部服务 (Direct internal service calls)
通过调用 `agentapi.bat` (即包装后的 `language_server.exe agentapi`) 发送指令。

* **已验证事实**:
  * 该脚本暴露了三个核心子命令：`new-conversation`、`send-message` 和 `get-conversation-metadata`。
* **推断**:
  * 无法支持具体的模型精确选择。它的 `--model` 仅支持 `flash_lite`、`flash`、`pro` 三个粗粒度分类，这与 Antigravity 实际拥有的 Claude/Gemini-Pro 多个模型 ID 冲突，会强行抹平模型精确性。
  * 缺乏流式接口支持，每个子命令均为同步阻塞调用直到最终结果产出。
* **脆弱内部依赖**:
  * 依赖 `agentapi` 子命令的存在及其特有的入参/出参 JSON 格式。
* **八个维度评估**:
  * *会话复用*: 支持通过 `send-message <recipient_id>` 传入 UUID 进行追加，这是唯一的优势。
  * *其他维度*: 由于不支持流式、无法选择精确模型、调用开销高，无法作为核心传输层。

---

## 4. 文本桥与 Codex 原生语义的判定边界

为了确保重建工作的质量，在此明确不同方案在语义支撑上的极限：

### 4.1 文本桥 (Text-only Bridge)
* **包含方案**: 方案 1 (CLI每轮启动)、方案 2 (持久CLI)、方案 4 (直接调用 `agentapi`)。
* **局限性**:
  * 它们只能在 adapter 层面将 Codex 发来的结构化上下文（包含系统指令、工具输出结果、对话历史）强制展平成一整段纯文本 `[USER]/[ASSISTANT]` 格式，再将模型的回复纯文本截取回来。
  * 彻底丧失了多模态数据输入（图像）、中间思维推理（Reasoning process delta）、原生取消（TCP Reset）以及 Codex 对工具循环的自主掌控权。

### 4.2 Codex 原生语义支撑 (Native Codex Semantics Support)
* **包含方案**: 方案 3 (桌面 HTTP/Connect 服务)。
* **优势**:
  * 只有此方案可以通过标准的 HTTP 协议双向交换结构化的 JSON/Protobuf 消息，从而保留每一个 `output_item`、`tool_call` 和 `reasoning_content` 的原子性。
  * 支持事件流（SSE）的逐 token 渲染，并在用户点击 UI 停止按钮时立即在 TCP 链路上传播取消信号，避免上游资源浪费。

---

## 5. 重建路线与方案推荐

### 5.1 v1 推荐 (短期方案 — 核心稳定性 Phase 1)
为满足 Phase 1 阶段不破坏已有代码和最小改动风险的要求，建议**对现有方案 1 (CLI 每轮启动) 进行以下局限性修复与调优**：

1. **改进 AbortController 的内存阻断**:
   * 在 `adaptive-server.mjs` 中，必须为每个请求在连接关闭时（`req.on('close')`）触发 Abort，即使无法中断云端，也必须立即中止本地 Node 端的等待，防止 HTTP Socket 积压导致的挂起或连接重连风暴。
2. **重构流式仿真粒度**:
   * 将当前 40 字符一次的块仿真修改为更加流畅的逐字/Token 级生成仿真，欺骗 Codex UI 使其不出现卡顿重连的假象。
3. **增加 `input_items` 内存暂存**:
   * 在内存中缓存每轮的 `input_items` 结构，保证 Codex 在调用 `GET /responses/<id>/input_items` 进行历史渲染时不会因返回空列表而报错。

### 5.2 长期推荐 (Phase 2+ 方案 — 核心稳定性重建阶段)
为了实现真正的 Codex 原生能力等价，长期必须彻底放弃对 CLI 启动和本地 SQLite 数据库的脆弱依赖，**整体迁移至方案 3 (桌面 HTTP/Connect 服务)**：

1. **开发标准的 Connect Protobuf 客户端**:
   * 在 Node 运行时直接引入或编写一个轻量级的 Connect 协议客户端。
2. **利用动态端口发现机制**:
   * 采用当前已验证 of `discoverDesktopConnection` 模块，在 Node 服务启动时和每次上游连接失败（如 ECONNREFUSED）时动态扫描，获取最新的 Port 和 CSRF Token。这样当用户重启 Antigravity Desktop 或切换账号时，Anti-Codex 能够自动恢复连接而无需手动重启。
3. **实现物理级取消与高保真流式**:
   * 将本地 HTTP 请求的 `AbortSignal` 直接绑定到对 `language_server.exe` 的网络请求上，实现物理级别的实时取消。直接解析 Connect 返回的 HTTP Stream 转换为标准 SSE 块，将首词延迟（TTFB）缩短至原生级别。
