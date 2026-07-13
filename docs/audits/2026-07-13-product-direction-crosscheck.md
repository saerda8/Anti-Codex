# Anti-Codex 产品方向独立交叉审计

- 日期：2026-07-13
- 产出：Antigravity Pro worker `ag-21b5ddcd-9901-4402-bd47-68cdf4037178`
- 主 Agent 复核：已复核范围、源码证据和迁移顺序；本文件只作旁路证据，最终状态以 [`../PRODUCT_ARCHITECTURE.md`](../PRODUCT_ARCHITECTURE.md) 和 [`../CURRENT_IMPLEMENTATION_AUDIT.md`](../CURRENT_IMPLEMENTATION_AUDIT.md) 为准

## 结论

当前项目不是从零开始，但还不能用于真实项目。客户端副本、隔离、品牌、更新同步、Antigravity 登录和模型发现、Manager 与诊断都可保留；核心阻塞是生产主路仍把 Codex 的角色、工具定义、调用和结果压成一条 Antigravity 普通用户消息。

真实 Cascade 轨迹已经证明，模型把 `[CODEX_PROVIDER_PROTOCOL]`、`[CODEX_TOOLS]` 和 XML 工具块当成提示注入，并坚持使用 Antigravity 自己的工具。这个问题不能继续靠提示词修补，必须换成结构化上游。

## 已符合并基本完成

| 工作面 | 源码证据 | 判断 |
|---|---|---|
| 独立 Codex 客户端和状态 | `deepcodex.app/`、`scripts/start-deepcodex.ps1` | 保留；不重做 Codex harness |
| 品牌和图标 | `assets/`、`scripts/patch-exe-icon.ps1` | 保留；不得换回 Codex/GPT 图标 |
| 中文管理入口和关闭交互 | `scripts/brand-profile-dropdown.mjs`、`scripts/test-anticodex-manager-button.mjs` | 当前 `native-panel-v104` 已实机通过 |
| Antigravity 登录、账号和模型发现 | `translator/antigravity-agentapi.mjs`、`translator/antigravity-model-catalog.mjs` | 保留 |
| 传输级排队、取消和互斥 | request queue、request registry、session lock、failure circuit | 保留；不属于任务控制 |
| Codex 请求/响应转换子集 | `translator/codex-native-protocol.mjs` | 方向正确，已移植 CC Switch 的一部分结构规则 |
| Responses SSE 信封子集 | `translator/codex-native-sse.mjs` | 方向正确，成功/失败事件顺序已有测试 |

## 方向正确但未完成

| 模块 | 当前缺口 | 处置 |
|---|---|---|
| `codex-native-protocol.mjs` | reasoning 历史、并行边界、完整 tool choice/usage | 继续用 CC Switch 夹具补齐 |
| `codex-native-sse.mjs` | 现在是完整响应结束后再打包，不是真增量流 | 移植 `streaming_codex_chat.rs` 状态机 |
| `response-history.mjs` | 只拼接历史，没有唯一 `call_id` 恢复、并行工具组和歧义拒绝 | 移植 `codex_chat_history.rs` 规则 |
| normal 路由 | `nativeHarnessOnly:true` 只证明选中了新 handler，不能证明上游是结构化的 | 接入结构化 Antigravity 上游 |
| compact | `/responses/compact` 仍走旧 `antigravity-upstream.mjs` | 迁入纯协议体系 |
| WebSocket | 仍是 HTTP relay/旧事件路径 | 与新流状态机一起迁移 |
| native MCP 结构化工具桥 | `antigravity-native-mcp-bridge.mjs` 和同 Cascade continuation 已有可复用实现 | 只提取结构化工具事件、`call_id`、取消和 TTL；先验证无权限弹窗 |

## 方向错误，应退出生产路径

| 错误代码族 | 代表位置 | 原因 |
|---|---|---|
| 单文本协议桥 | `buildAntigravityProtocolPrompt`、`antigravity-native-harness-upstream.mjs` | 把角色和工具伪装成用户文本，真实模型已拒绝 |
| 内部工具注入和内部循环 | `callUpstreamWithInternalTools`、`callAntigravityWithInternalTools` | Gateway 接管工具选择和续跑 |
| 自然语言伪工具解析 | 旧 `parsePseudoToolCalls` 宽松路径 | 从模型文字猜工具调用 |
| 任务和固定产物特判 | `deterministicArtifact*`、`deterministicRepo*`、`deterministicExactReplyCompletion` | 根据任务/文件名伪造结果 |
| 业务命令合成 | `*Artifact*PowerShell`、`repo*Command` | Gateway 替 Codex/模型写命令 |
| 参数和 Patch 修复 | `repairLocalArtifactToolArguments`、`normalize*Patch`、`blockRepeatedLaunchCommand` | 改写模型真实工具参数，隐藏根因 |
| 强制验证和业务完成判断 | marker/verification/completion 系列 | Gateway 决定任务何时完成 |
| 代发修复/重试轮次 | fake-tool、repair relay、empty-assistant 系列 | 形成第二套任务控制器 |

## 做法不对，需要改进

1. `adaptive-server.mjs` 仍把协议、Manager、兼容逻辑和任务语义混在约 1 MB 的单文件内；应先把生产路由切到小型纯模块，再逐批删除不可达旧代码。
2. `adaptive-pseudo-tools.test.mjs` 中锁定命令合成、Patch 修复和 marker 完成的测试必须随旧路径退役；宿主文件、命令、测试和进程证据测试应保留。
3. 当前静态路由测试只证明 native 分支位于部分旧特判之前，未阻止 websocket prewarm、ambient suggestions、compact 和其他旁路回到旧代码。
4. 旧 release gate 曾在真实桌面任务失败时仍全绿；新门禁必须以磁盘、退出码、进程次数、真实工具历史和最终收尾为准。
5. Codex 新版同步仍有 5 项旧补丁被跳过；当前 UI 正常不等于这些项可永久忽略，需逐项确认上游已原生满足还是要重新适配。

## CC Switch 实际采用边界

- 已采用：`transform_codex_chat.rs` 的部分请求/响应结构规则、`codex_responses_sse.rs` 的事件信封规则、MIT 第三方声明。
- 当前证据：13 个 CC Switch 等价行为组，连同本地边界共 23 个聚焦测试通过。
- 尚未采用：`codex_chat_common.rs`、`codex_chat_history.rs`、`streaming_codex_chat.rs`、完整 Provider 路由和更多 Responses 边界。
- 不采用：CC Switch 的 Tauri UI、Provider 商店、云同步和多应用管理。
- Anti-Codex 自有部分：Antigravity 登录权益桥、独立 Codex 客户端、品牌、状态隔离、更新同步和 Manager。

## 依赖顺序

1. 给结构化 Antigravity 上游写最小契约测试，证明角色、工具 schema、调用和结果不是一条用户文本。
2. 接通结构化上游，优先复用登录态的原始模型接口；native MCP 仅作可验证备选。
3. 保持旧路径暂时可回滚，但让 normal 生产路由 fail-closed，禁止回退到语义补偿。
4. 用 Codex Desktop 通过一次真实读、写、执行、结果回传和正常收尾。
5. 移植真正增量流和 CC Switch 历史恢复。
6. 将 compact 和 WebSocket 迁入同一纯协议路径。
7. 跑三类长任务及取消、纠正、失败、重启和压缩边缘情况。
8. 在替代路径通过后删除不可达语义代码和对应错误测试，再完成 UI、历史性能和发布门禁收尾。
