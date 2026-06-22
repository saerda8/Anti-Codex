# Anti-Codex 本地快照独立性收紧审计

审计日期：2026-06-14

## 改动范围

本次收紧将 Anti-Codex 的运行时快照从「共享原始 Codex 目录的实时链接」迁移为「Anti-Codex 自有本地副本」。涉及六项必需本地目录：

- `skills` —— 技能目录
- `cache\codex_app_directory` —— 连接器目录元数据
- `cache\codex_apps_tools` —— 应用工具缓存
- `plugins` —— 插件宿主数据
- `.tmp\plugins` —— 插件临时宿主数据
- `computer-use` —— computer-use 配置和 sidecar 数据

## 为什么本地复制比共享链接更符合长期独立 Anti-Codex

1. **消除对原始 Codex 的运行时依赖**。技能从 live junction 改为真实副本后，Anti-Codex 不再依赖原始 Codex 技能目录的存在状态、权限或布局。即使原始 Codex 的技能目录被删除、损坏或变更，Anti-Codex 仍能正常启动并提供本地技能。

2. **写路径隔离**。Anti-Codex 启动态不再将插件注册恢复或权限默认值写回 `%USERPROFILE%\.codex\config.toml`。原始 Codex 配置文件在 translator-only 恢复前后的长度和 `LastWriteTime` 均保持不变（已通过 `originalCodexConfigUnchanged:true` 验证）。

3. **投影优先读取本地快照**。连接器目录和 app-tool 缓存优先从 Anti-Codex 本地快照读取，原始 Codex 的对应缓存仅作为后备且不会混入运行时响应。已安装验证报告 `remainingSharedLinks:[]`（当前机器无残留共享链接）。

4. **规避外部生态泄露**。缓存连接器曾包含 `chatgpt.com/apps/...` 等 ChatGPT 安装 URL。本地投影已将其擦除，最新安装验证确认 1494 个连接器条目中零 ChatGPT 安装 URL。

5. **不虚假承诺不可达能力**。工具暴露按 `isAccessible` 过滤，`accessibleConnectorCount=0` 时 app-tool 保持零暴露，避免将缓存但未授权的 app 工具暴露到 Codex 工具表面。

6. **恢复路径自愈**。Translator-only 恢复在启动网关前刷新三项本地快照，技能和连接器元数据随网关一起恢复，不依赖完整的桌面重启流程。

7. **Merge 式导入保留本地演化**。技能目录首次从链接转换为副本后，后续采用 merge 语义而非覆盖。已有本地技能不会在正常启动或技能同步中被删除，允许 Anti-Codex 积累独立于原始 Codex 的技能变体。

## 剩余风险

1. **本地快照可能陈旧**。快照在启动/恢复同步时刷新，但在正常运行期间不会持续同步。如果原始 Codex 的技能、插件或连接器目录在运行时被更新，Anti-Codex 的快照可能落后，直到下一次刷新触发。

2. **全局 MCP server 块仍为导入模式**。Anti-Codex 的启动配置仍从原始 Codex 导入全局 MCP server 块。这些 MCP 声明未提供 Anti-Codex 专属编辑界面，因此原始 Codex 对 MCP 配置的修改可能影响 Anti-Codex 的下一轮启动同步。

3. **合并导入的不对称风险**。Merge 式导入保护了 Anti-Codex 本地数据，但如果原始 Codex 有意删除某些项目（如废弃或安全问题），Anti-Codex 本地副本可能保留已删除内容。

4. **仅当前机器验证通过**。`remainingSharedLinks:[]` 在当前安装环境中成立，但其他部署（不同 Codex 版本、不同安装顺序）可能有不同的快照状态。独立性收紧的泛化需要跨环境验证。

## 需要主 agent 验证的安装态证据

以下证据可以通过运行已安装的验证脚本来确认（当前禁止访问 `scripts/` 目录，无法在此 worker 进程中执行）：

1. 运行 `test-anticodex-independence.ps1`，确认：
   - `skills.linkType:null`（技能目录非链接）
   - `connectorDirectory` 路径在 Anti-Codex 状态主目录下
   - `cacheLinkType:null`（缓存非链接）
   - `remainingSharedLinks:[]`
2. 运行 translator-only 恢复后再次确认上述快照仍然存在且正确。
3. 检查 `connectorDirectory` 条目中是否仍有 `chatgpt.com` 安装 URL（预期为零）。
4. 确认 `%USERPROFILE%\.codex\config.toml` 在 Anti-Codex 启动前后的 `LastWriteTime` 无变化。
5. 确认六项本地目录存在、不是链接，并且不缺失关键技能、插件、MCP 或 sidecar 数据。

> 注：本文档不声称独立性收紧已最终完成。以上剩余风险应在后续迭代中逐项评估和关闭。
