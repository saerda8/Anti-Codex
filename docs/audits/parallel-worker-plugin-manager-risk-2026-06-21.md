# Anti-Codex 插件、MCP 与 Manager 入口剩余风险审计报告

**审计日期**: 2026-06-21
**前置验证文件**:
- [scripts/anticodex-manager-inject.js](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/anticodex-manager-inject.js)
- [scripts/test-anticodex-plugin-capabilities.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-plugin-capabilities.ps1)
- [scripts/test-anticodex-mcp-skills.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-mcp-skills.ps1)
- [translator/local-projection/index.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/local-projection/index.mjs)

---

## 已确认

经过审查，Anti-Codex 在插件本地投影、MCP 状态校验以及内置 Manager 管理面板交互上，已确认实现了以下能力边界，保证系统在此范围内的稳定安全运行，且不依赖或消耗真实的 ChatGPT/LLM 流量：

### 1. 插件与远程连接器缓存投影边界
- **本地化元数据投影**: 在 [index.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/local-projection/index.mjs) 中，由 [installedPluginsPayload](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/local-projection/index.mjs#L237) 和 [readConnectorDirectory](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/local-projection/index.mjs#L47) 实现的连接器列表主要服务于本地 Codex UI 的接口兼容，不对外发起实际登录行为。
- **真假调用隔离规则**: 接口 [whamAppsPayload](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/local-projection/index.mjs#L257) 和 [readAppTools](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/local-projection/index.mjs#L64) 严格限定了仅在远程连接器被显式标记为 `isAccessible === true` 时才暴露应用工具。若可访问连接器数为零，暴露的工具数必为零，在源头上防止了将未授权连接器伪造成可用工具的可能。

### 2. 本地 MCP 与 Skill 文件防伪隔离
- **物理路径重 reparse 检测**: 脚本 [test-anticodex-mcp-skills.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-mcp-skills.ps1) 能够强校验 `skills` 目录和各类全局指引文档不为符号链接或软链接（ReparsePoint），确保 Skill 加载不超逸出隔离环境的本地文件系统。
- **真实工具连通校验**: 通过 [Invoke-RealNodeReplMcpSmoke](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-mcp-skills.ps1#L126) 执行本地 REPL 环境冒烟测试，可确认在宿主环境真实暴露了相应 Stdio 工具之后，MCP 通道才算可用。

### 3. Manager 界面注入与安全认证边界
- **UI 管理器单例防干扰**: 在 [anticodex-manager-inject.js](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/anticodex-manager-inject.js) 中，[openManager](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/anticodex-manager-inject.js#L838) 在注入页面前会清理可能存在的旧版本 DOM 和定时器，保证管理界面的生命周期与环境清洁。
- **管理请求认证流**: 敏感管理操作均通过 [runActionViaBridge](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/anticodex-manager-inject.js#L352)（优先）和 [runActionViaScript](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/anticodex-manager-inject.js#L376) 代理，所有接口均需要 Manager token 校验，防止未授权宿主恶意劫持后台网关操作。

---

## 剩余风险

基于对上述文件的代码审查，发现如下 5 条剩余风险：

1. **JSONP 注入备选链路的安全暴露面 (Script Fallback Exposure)**
   - **风险描述**: [runActionViaScript](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/anticodex-manager-inject.js#L376) 用于兼容桥接不可用的环境，它动态向文档注入 `<script>` 标签以进行跨域 JSONP 调用。尽管有 `managerToken` 和 Referrer 验证，但该链路在前端页面上下文的防护能力相比沙箱化 IPC 仍然较弱。
2. **同 Windows 用户进程的环回网关访问限制 (Local Process Trust Boundary)**
   - **风险描述**: 本地网关默认监听 `http://127.0.0.1:8484`，虽然实现了基于 `Origin` 和 `Referer` 的跨域阻断保护，但在单用户 Windows 系统下，由于所有本地运行进程（如其他未受信任的后台服务）均能以同等权限发起环回网络请求，若能读取到 Token，仍存在被同机恶意软件伪造请求的风险。
3. **本地连接器缓存文件修改检测机制缺失 (Snapshot Staleness and Mutation Gap)**
   - **风险描述**: 脚本 [test-anticodex-plugin-capabilities.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-plugin-capabilities.ps1) 通过 [Test-ProjectionCache](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-plugin-capabilities.ps1#L91) 确认缓存的可读性及文件数，但由于系统缺少对本地目录 `cache/codex_app_directory` 变化的实时监听机制，若缓存文件在网关运行中被外部进程篡改，网关只有在重启或刷新时才能同步最新授权状态。
4. **模型思考预算动态配置引发的流量溢出隐患 (Thinking Budget Dynamic Selection)**
   - **风险描述**: Manager 面板支持显示和控制模型思考预算（如 `thinking_budget`）。如果第三方 API 处于激活状态，但在切换或配置过程中误配了不支持思考特征的模型，可能导致本地路由处理逻辑降级，若无降级流控，可能会引发意外的重试流量消耗。
5. **本地 Node.js 运行时执行路径劫持风险 (Node Stdio Execution Path Hijack)**
   - **风险描述**: Stdio 连通校验脚本通过 `Resolve-NodeRuntime` 搜索系统 `node.exe`，如果用户系统环境中的 `PATH` 环境变量被恶意程序修改或劫持，运行 [Invoke-RealNodeReplMcpSmoke](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-mcp-skills.ps1#L126) 可能会拉起恶意的 Node 解释器，导致本地执行提权。

---

## 建议测试

为验证剩余风险是否处于可控范围，并保障在各种极端异常场景下的鲁棒性，建议执行以下测试：

1. **零授权连接器测试 (Zero-Authorized Connectors Gate)**
   - **测试目标**: 确认 `/backend-api/wham/apps` 确实不输出任何虚假应用工具。
   - **测试步骤**: 清空本地授权，运行 [test-anticodex-plugin-capabilities.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-plugin-capabilities.ps1)，核对返回的 JSON 中 `capabilities.appToolCount` 必须等于 0，且 `capabilities.capabilityState` 状态转换符合预期。
2. **跨域 / 无 Token 防御测试 (Cross-Origin Token Validation)**
   - **测试目标**: 确认未授权进程无法任意操作 Manager 管理指令。
   - **测试步骤**: 伪造一个 HTML 页面托管于外部 origin（如 `http://evil.example.com`），尝试通过脚本注入或直接 Fetch 访问 `/anticodex/upstream-test`，验证网关能始终返回 `403 Forbidden`。
3. **恶意 Symlink 溢出测试 (ReparsePoint Shielding)**
   - **测试目标**: 验证系统不会读取到 `skills` 外部的恶意文件。
   - **测试步骤**: 在 `skills` 目录下创建一个指向系统敏感路径（如系统敏感配置）的 Junction 点或符号链接，运行 [test-anticodex-mcp-skills.ps1](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/test-anticodex-mcp-skills.ps1)，验证脚本能立刻抛出异常并拦截。
4. **宿主暗色/亮色切换联动测试 (Theme Sync Dynamic Toggle)**
   - **测试目标**: 确保注入的管理器在宿主主题剧烈切换时不会发生闪烁或失效。
   - **测试步骤**: 在 Chromium DevTools 控制台中模拟触发 `prefers-color-scheme` 变化或修改根节点 `data-theme`，检查管理器面板的颜色标记是否能瞬时且平滑地完成暗/亮色系自适应同步。
