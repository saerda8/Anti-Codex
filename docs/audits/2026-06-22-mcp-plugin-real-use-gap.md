# Anti-Codex MCP 与插件“显示数量但不证明真实可用”缺口审计

**审计日期**: 2026-06-22

---

## 结论

当前 Anti-Codex 的架构通过提取本地缓存快照（如 `cache/codex_app_directory`、`cache/codex_apps_tools`）和读取本地配置文件，具备了向 Codex 客户端呈现完整连接器目录与 MCP 服务列表的能力。然而，在这种“清单兼容性”背后，系统在如何证明这些连接器和 MCP 服务器在运行态真正可用（即确实可被模型调用并成功执行）方面，存在以下三个最核心的技术缺口。

---

## 关键缺口

### 1. 插件连接器/工具列表“显示大数量”但实际可用工具为零的授权缺口
- **源码背景**：在 `scripts/test-anticodex-plugin-capabilities.ps1` 中，`/backend-api/aip/connectors` 接口通过投射本地缓存快照返回了 1494 个连接器（`connectorCount=1494`），但 `/backend-api/wham/apps` 接口中暴露给模型的 callable tools 仅针对 `isAccessible: true` 的连接器返回。目前系统由于没有本地/远程的授权状态写入流程，导致 `accessibleConnectorCount` 始终为 0，对应的实际可用工具数 `appToolCount` 也为 0。
- **缺口说明**：目前的验证机制虽然能够正确识别“当 accessible 数量为 0 时 tool 数量也为 0”这一安全降级逻辑，但缺乏持续的真实调用链验证。没有集成测试来验证：一旦外部某个连接器的 `isAccessible` 被标记为 true，系统是否能正常、安全地提取其下属的工具 Schema；以及在无授权时，是否有异常缓存泄露或虚假工具定义被传递给模型导致调用崩溃。
- **建议验证脚本名**：`scripts/test-anticodex-plugin-capabilities.ps1`

### 2. 非 node_repl 自定义 MCP 服务仅作静态配置路径检查、缺乏 Stdio 握手和工具回路验证
- **源码背景**：在 `scripts/test-anticodex-mcp-skills.ps1` 中，系统会通过正则匹配 `config.toml` 中定义的所有 `mcp_servers`（显示数量）。然而，测试逻辑对除 `node_repl` 以外的其它自定义 MCP 服务器仅在静态维度通过 `Resolve-McpCommand` 确认二进制文件路径以及第一个参数文件是否存在，而没有实际拉起子进程并跑 Stdio 交互。
- **缺口说明**：只有 `node_repl` 拥有真实的 Stdio 冒烟验证（`Invoke-RealNodeReplMcpSmoke`）以及完整的双回合工具调用链路测试（`test-anticodex-mcp-tool-loop.ps1`）。如果用户在 `config.toml` 中配置了其投产的其它自定义 MCP 服务器（如 Python / Java 编写的本地辅助工具），即使子进程由于运行时环境缺失、参数格式不匹配或端口冲突导致完全无法启动，静态验证测试依然会亮起绿灯。
- **建议验证脚本名**：`scripts/test-anticodex-mcp-tool-loop.ps1`（或扩展为 `scripts/test-anticodex-custom-tool-loop.ps1`）

### 3. 本地 Skills 与 Codex 宿主环境隔离导致的快照版本漂移与存活状态感知缺口
- **源码背景**：在 `scripts/test-anticodex-mcp-skills.ps1` 中，系统检查 local isolated Anti-Codex home 中的 `skills` 拷贝，并验证其是否包含如 `headroom` 等特定 Skill 快照（显示数量）。
- **缺口说明**：本地 Skills 是从上游共享目录（`SharedCodexHome`）拷贝而来的只读副本。当上游真实的 Codex 宿主环境中的技能文件发生删除、损毁或版本更新时，Anti-Codex 的本地快照由于缺乏与上游文件系统的时效性比对（Snapshot Freshness）、哈希一致性（Drift Check）或探活运行验证，可能依然会显示并向模型汇报旧版本甚至是已失效的 Skills 数量，造成“元数据可见但其实无法使用”的版本漂移缺口。
- **建议验证脚本名**：`scripts/test-anticodex-mcp-skills.ps1`（或 `scripts/test-anticodex-installed-overall.ps1`）
