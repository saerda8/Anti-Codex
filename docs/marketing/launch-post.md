# 发布短帖

## 主推版本

Anti-Codex 继续推进到一个更像独立产品的状态了。

它不是把原版 Codex 偷偷改坏，也不是要求你走 ChatGPT 登录。

它做的是：

- 独立 Anti-Codex 入口和图标。
- 默认接入已登录的 Antigravity Desktop 模型路线。
- 可选配置第三方 OpenAI-compatible / Anthropic API。
- 保留 Codex 的主要工作流、项目状态和长上下文历史。
- 同步本机已有 MCP、skills、插件和连接器元数据。
- 对未授权 connector / app tool 保持诚实：能显示元数据，但不伪装成可调用工具。

现在重点已经不是“能不能跑起来”，而是把它做得可信：

- 不碰原生 Codex。
- 不走 ChatGPT 授权入口。
- 不伪造工具权限。
- 管理面板可检查 MCP/Skill、插件/应用、报告和同步状态。
- 真实按钮、报告哈希、第三方 provider 历史连续性都有验证。

它适合想保留 Codex 工作流，但希望把模型路线接到 Antigravity 或自有 API 的本地开发者。

## 更短版本

Anti-Codex 是一个可与原版 Codex 并存的本地桌面运行时。

默认走 Antigravity Desktop，也支持第三方 API；同步你本机已有 MCP、skills 和插件元数据，但不会伪造 connector 授权。

重点是三个边界：

- 原版 Codex 不受影响。
- 不要求 ChatGPT 登录。
- 没授权的 app tool 不会被假装成可调用。

## 极短版本

Anti-Codex：一个和原版 Codex 并存的本地运行时。

默认 Antigravity，可选第三方 API，继承本机 MCP/skills，拒绝伪造连接器授权。
