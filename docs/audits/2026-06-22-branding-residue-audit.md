# Anti-Codex 品牌与文案残留审计报告

日期：2026-06-22

## 审计目标

查找用户可见的 `DeepCodex`、`deepcodex`、`ChatGPT 登录`、`reconnecting/正在重新连接` 相关文本或路径中，哪些还可能影响 Anti-Codex 体验，并区分内部兼容路径名与用户可见文案，提出最小化安全修复建议。

---

## 审计发现

### 一、 品牌与文本残留 (`DeepCodex` / `deepcodex`)

为了保证系统安全与兼容性，本报告将残留项分为两类：**内部兼容路径与变量（建议保留）** 以及 **用户或模型可见残留（建议修复）**。

#### 1. 内部兼容路径与变量（建议保留，不重命名）
*   **残留位置**：
    *   **环境变量**：`DEEPCODEX_STATE_ROOT`, `DEEPCODEX_SHARED_CODEX_HOME`, `DEEPCODEX_PROJECTS_ROOT`, `DEEPCODEX_WORKSPACE`, `DEEPCODEX_CDP_PORT`, `DEEPCODEX_DISABLE_GPU`, `DEEPCODEX_DISPLAY_NAME`, `DEEPCODEX_SKIP_PLUGIN_SYNC` 等。
    *   **源码/脚本文件名**：`scripts/start-deepcodex.ps1`, `scripts/start-deepcodex.sh`, `scripts/deepcodex-cdp-inject.mjs`, `scripts/deepcodex-plugin-unlock-inject.js`, `scripts/deepcodex-setup-ui.mjs`, `scripts/DeepCodexSetup.swift`, `scripts/sync-deepcodex-*` 等。
    *   **本地运行态日志/缓存文件**：`deepcodex-plugin-host-sync.log`, `deepcodex-cdp-inject.log`, `deepcodex-lifecycle.log`, `codex-home-deepseek-app` 文件夹等。
*   **是否用户可见**：**否**（仅在开发者调试、日志目录或系统进程列表中可见）。
*   **风险等级**：**极低**。
*   **说明**：这些属于内部兼容性路径和变量，用于同 Codex 现有的本地目录和 Electron 壳进行钩子绑定。大规模重命名不仅成本高，还会带来极高的破坏现有自动化逻辑和进程管理逻辑的风险，因此不建议重命名。

#### 2. 用户或控制台可见文本（建议修复）
*   **残留位置**：
    *   [start-deepcodex.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/start-deepcodex.ps1):
        *   第 179 行：`Write-Host "DeepCodex is already starting or running."`
        *   第 189 行：`[System.Windows.Forms.MessageBox]::Show($Message, "deepcodex", "OK", "Warning")`（弹窗标题为 "deepcodex"）
        *   第 1481 行：`Show-Alert "Node.js was not found. Install Node.js or set NODE_BIN before launching deepcodex."`（提示中含 "...before launching deepcodex"）
        *   第 1589 行：`Show-Alert "DeepCodex setup page is missing: $SETUP_UI_SCRIPT"`（提示中含 "DeepCodex setup page..."）
        *   第 2049 行：`Show-Alert "DeepCodex started but no window appeared. Please launch DeepCodex from the desktop shortcut or Start Menu..."`（提示中含 "DeepCodex started..." / "launch DeepCodex...")
    *   [DeepCodexSetup.swift](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/DeepCodexSetup.swift):
        *   第 43 行：`退出 DeepCodex` / `Quit DeepCodex` 菜单项
        *   第 60 行：窗口标题 `DeepCodex`
        *   第 76 行：文本框标签 `DeepCodex`
        *   第 231 行：`当前上游不支持读图，已按文本模式接入`, `This upstream does not support image input. DeepCodex will use text mode.`
        *   第 239 行：`连接成功，正在启动 DeepCodex...`, `Connected. Starting DeepCodex...`
        *   *注：此 Swift 程序用于配置第三方 API 时的备用旧界面，在默认的 Antigravity 模式下虽不会启动，但在用户使用第三方配置遇到回退情况时可能展现给用户，具有较高的残留感知。*
    *   [deepcodex-setup-ui.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/deepcodex-setup-ui.mjs):
        *   配置页面含有大量 "连接 DeepSeek"、"DeepSeek 连接失败"、"DeepSeek API key" 等品牌文案（这主要涉及第三方 DeepSeek 配置残留）。
*   **是否用户可见**：**是**（在脚本报错、弹窗警告或使用非 Antigravity 备用配置工具时可见）。
*   **风险等级**：**中**。
*   **说明**：这些是面向用户的错误提示或界面元素，会直接破坏 Anti-Codex 的独立产品体验，增加用户的品牌困惑。

#### 3. 模型可见文本 (Model Context / System Prompt Injection)（建议修复）
*   **残留位置**：
    *   [adaptive-server.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/adaptive-server.mjs):
        *   第 3410 行：`DeepCodex detected a damaged previous context_compaction item...`
        *   第 3427 行：`...[older tool output clipped by DeepCodex translator: ...]`
        *   第 3435 行：`[DeepCodex tool result: command completed with no stdout...]`
        *   第 3447 行：`...[DeepCodex folded ... chars from a long restored tool output...]`
        *   第 3469 行：`[DeepCodex tool result: patch applied successfully...]`
        *   第 3506 行：`...[older custom tool body clipped by DeepCodex translator: ...]`
        *   第 3826/3832 行：`DeepCodex task ledger` / `DeepCodex task ledger from recent explicit user/assistant text:`
        *   第 3844/3850 行：`DeepCodex durable environment facts` / `DeepCodex durable environment facts from verified tool results:`
        *   第 3891 行：`DeepCodex omitted volatile restored polling/status transcripts...`
        *   第 3963 行：`DeepCodex omitted older restored tool transcripts...`
*   **是否用户可见**：**间接可见**。这些提示词会直接注入到 LLM 的上下文缓存中。模型在阅读包含 `DeepCodex` 的系统提示词/上下文整理标记时，极易被“带偏”，进而在对用户的回复中声称自己是 `DeepCodex`，导致品牌泄露。
*   **风险等级**：**高**（会直接污染模型认知并最终显示在聊天中）。
*   **说明**：这些硬编码的 context/ledger 字符串没有经过 `brandTranslatorText` 的正则处理，应该被更新为 `Anti-Codex` 相关的文案。

---

### 二、 ChatGPT 相关文案 ("ChatGPT 登录" / "ChatGPT")

#### 1. 正常教学提示（无需修改，建议保留）
*   **残留位置**：
    *   [adaptive-server.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/adaptive-server.mjs) 第 1961 行、第 2120 行。
    *   [anticodex-manager-inject.js](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/anticodex-manager-inject.js) 第 647 行、第 842 行、第 979 行、第 992 行。
*   **内容**：说明本产品“不走 ChatGPT 登录”、“不需要 ChatGPT 账号授权”、“不消耗模型流量”等提示词。
*   **是否用户可见**：**是**。
*   **风险等级**：**无风险**。
*   **说明**：这是 Anti-Codex 向用户告知其安全及运行机制的核心教育文本，能有效消除用户隐私顾虑，符合设计意图，应当保留。

#### 2. 底层协议与配置占位（建议保留，不重命名）
*   **残留位置**：
    *   `codex-home-deepseek-app/config.adaptive-oneapi.toml` 中的 `chatgpt_base_url` 配置项。
    *   [start-deepcodex.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/start-deepcodex.ps1) 中的 `auth_mode = "chatgpt"` 底层伪造登录令牌与 JWT 生成参数。
*   **是否用户可见**：**否**。
*   **风险等级**：**极低**。
*   **说明**：这是 Codex Electron 壳所要求的原生 API 路由接口，必须保持字段拼写一致才能绕过客户端的认证校验。不能为了去 ChatGPT 化而重命名该字段，否则会导致客户端启动闪退或弹出真正的 ChatGPT 认证页面。

---

### 三、 重连相关文案与验证缺口 ("reconnecting" / "正在重新连接")

#### 1. 真实界面重连表现
*   **说明**：官方 Codex 界面在 WebSocket 断开连接时，会在顶部显示“正在重新连接...”或“Reconnecting 1-5/5...”。Anti-Codex 当前设计中已经强制重定向 Responses WebSocket 通信至本地 HTTP，避免了正常使用中的重连循环。然而，若本地 translator 挂掉或本地端口冲突，此提示依然会被 Codex UI 触发。

#### 2. 测试验证漏洞（核心严重隐患！建议立即修复）
*   **残留/缺陷位置**：
    *   [test-anticodex-ui-state.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-ui-state.mjs) 中的 `pageStateProbeExpression`：
        ```javascript
        const pageStateProbeExpression = `(() => {
          const text = "";
          const reconnectEvidence = [];
          return {
            title: document.title,
            href: location.href,
            textLength: 1,
            textSample: text,
            hasLoginText: !!document.querySelector("a[href*='auth/login'], form[action*='auth/login']"),
            hasReconnectText: false,
            reconnectEvidence
          };
        })()`;
        ```
*   **是否用户可见**：**否**（仅在自动化测试执行时运行）。
*   **风险等级**：**高**（造成自动化验证“虚假安全”）。
*   **说明**：
    *   为了在单元测试中通过对 `hasReconnectText` 关键字的检测（`anticodex-launcher.test.mjs` 存在正则匹配），该脚本硬编码了 `hasReconnectText: false` 并且硬编码 `text = ""`，导致该探针返回的结果永远没有重连文本。
    *   这使得后续等待模型加载的循环（第 720-730 行的 `while (Date.now() < pageDeadline) { ... if (state?.textSample === "") break; }`）在检测到 `""` 后直接跳出，实际上**完全没有执行**“等待页面模型菜单加载”的步骤，同时也导致 UI 闲置稳定性检测脚本 `test-anticodex-ui-idle-stability.ps1` 变成了“睁眼瞎”，永远无法捕获实际的重连文本。

---

## 推荐最小修复顺序与策略

| 修复顺序 | 残留类别 / 修复目标 | 涉及文件 | 用户可见性 | 风险等级 | 最小修复策略 |
| :---: | --- | --- | :---: | :---: | --- |
| **1** | **修复 CDP 状态探针的虚假测试逻辑** | [test-anticodex-ui-state.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-ui-state.mjs) | 间接（影响验证） | **高** | 停止硬编码 `hasReconnectText`，改为通过 DOM 匹配重连文本（如检测页面中是否包含带有 `reconnect` 样式的重连横幅或“重新连接”等文案）；获取真实的 `innerText` 样本，不再硬编码为 `""`，从而修复加载等待机制。 |
| **2** | **修复模型上下文提示词硬编码污染** | [adaptive-server.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/adaptive-server.mjs) | 间接（模型输出） | **高** | 将 `context_compaction` 整理模板和 `folded`/`clipped` 信息提示中的硬编码 `"DeepCodex"` 全部替换为 `TRANSLATOR_BRAND` 或直接写为 `"Anti-Codex"`，避免污染模型认知。 |
| **3** | **修复用户可见命令行报错及弹窗品牌** | [start-deepcodex.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/start-deepcodex.ps1) | **是** | **中** | 将 `Show-Alert` 的弹窗标题 `"deepcodex"` 替换为 `"Anti-Codex"`；将各种找不到 Node/Codex 的命令行 `Write-Host` 及 `Show-Alert` 提示中的 `deepcodex` 更改为 `Anti-Codex`。 |
| **4** | **修改 Swift 备用配置工具与配置脚本文案** | [DeepCodexSetup.swift](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/DeepCodexSetup.swift)<br>[deepcodex-setup-ui.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/deepcodex-setup-ui.mjs) | **是** | **低** | 更新 Swift 窗口标题和按钮文案为 `"Anti-Codex"`；脱敏 `deepcodex-setup-ui.mjs` 中的 `DeepSeek` 显式指向（由于第三方配置属于高级备选，修复优先级可降低）。 |
| **保留** | **内部兼容配置与环境变量路径** | 各种 `.ps1`, `.js`, `.toml` 配置文件 | **否** | **无** | 坚决不进行重命名，以保证底层系统启动逻辑、ASAR 注入模块和 Electron 壳兼容性的绝对稳定。 |
