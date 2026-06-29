# 公众号文案：Anti-Codex 阶段稿

## 标题备选

1. 我把 Codex 工作流接到了 Antigravity 和本地 API 路线
2. Anti-Codex：一个不碰原版 Codex 的本地运行时
3. 不走 ChatGPT 登录，也不伪造连接器授权
4. 让 Codex 的 MCP、skills 和插件元数据在本地继续可见
5. Anti-Codex：把“能跑”继续做成“可信”

## 推荐标题

# Anti-Codex：把 Codex 工作流接到新的模型路线，但不把边界说假

我最近继续做 Anti-Codex。

它不是一个全新的编辑器，也不是把原版 Codex 直接改坏。

更准确地说，它是一个本地桌面运行时：

> 让 Codex 的主要工作流继续存在，同时用 Antigravity 权益提供模型文本，或接到你自己配置的第三方 API。

这件事听起来像只是换一个 base URL，但真正麻烦的地方不在这里。

Codex 的请求里有很多普通聊天应用没有的东西：

- Responses / Chat 兼容格式
- tool calls
- MCP 和本地工具
- context compaction
- 长上下文历史
- 插件和 connector 元数据
- 管理面板和本地诊断
- 流式输出、取消和恢复

Anti-Codex 要做的不是“把请求转发一下”，而是把这些边界都接住。

## 现在它能做什么

当前版本的重点是稳定和诚实。

它默认使用 Antigravity 权益提供模型文本，Codex 工具留在 Anti-Codex 侧；也可以在管理面板里配置第三方 OpenAI-compatible 或 Anthropic API。

配置第三方 provider 时，Anti-Codex 会保留同一个项目状态、会话目录和长上下文历史，不会因为换 provider 就清掉工作区。

本机已有的 MCP、skills、插件目录和 connector 元数据也会同步到 Anti-Codex 自己的本地状态里。

但这里有一条很重要的线：

> 能看见 connector 元数据，不等于已经获得远程授权。

所以 Anti-Codex 不会把未授权的 app tool 假装成可调用工具。没有授权就是 0 个可调用工具，这一点会在管理面板和验证报告里直接写出来。

## 为什么我一直强调边界

因为一个工具最容易坏掉信任的地方，不是功能少，而是把没做成的东西说成做成了。

Anti-Codex 现在刻意守住几条边界：

- 不走 ChatGPT 登录入口。
- 不破坏原版 Codex。
- 不伪造 connector / app tool 授权。
- 不把元数据当成真实调用能力。
- 不把旧品牌或旧提示词泄漏给用户。

这也是为什么最近很多工作都花在验证上：

- MCP/Skill 全量同步检查。
- 插件和 app-tool parity 检查。
- 第三方 provider 多轮历史连续性检查。
- Manager 真实按钮点击检查。
- 报告 JSON 和 SHA256 sidecar 完整性检查。
- Windows/macOS 可见文案的旧品牌残留检查。

这些工作不炫，但它们决定这个东西能不能长期用。

## 它和原版 Codex 的关系

原版 Codex 继续保留。

Anti-Codex 是独立入口、独立状态和独立运行时。它会读取和同步本机需要的能力，但不会把原版 Codex 当成要被覆盖的目标。

你可以把它理解成：

- 原版 Codex：继续走官方路线。
- Anti-Codex：走 Antigravity 或第三方 provider 路线。

两边并存，边界清楚。

## 当前最适合谁

如果你在意这些点，Anti-Codex 会比较适合：

- 想保留 Codex 的工作流。
- 想使用 Antigravity 权益或自己的 API provider。
- 需要 MCP、skills、插件元数据继续同步。
- 不希望为了 connector 能力去伪造授权状态。
- 不想让原版 Codex 被改坏。

它现在还不是“所有东西都 100% 替代原版”的状态。

但它正在从“能接上模型路线”变成“能把边界、验证和长期维护讲清楚”的状态。

这比单纯换一个模型入口重要得多。
