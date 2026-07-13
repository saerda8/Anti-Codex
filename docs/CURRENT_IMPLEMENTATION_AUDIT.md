# Anti-Codex 当前实现审计与处置清单

- 状态：架构执行台账，必须与 `PRODUCT_ARCHITECTURE.md` 一起读取
- 审计日期：2026-07-13
- 审计源码：`main` / `e256fedc` 加当前未提交架构与根因审计
- CC Switch 对照版本：`farion1231/cc-switch` / `c6197ae32450cd70e2bf03b35e3f5f53ac12044c`
- 当前安装状态：四个纯协议模块已同步到 Gateway 运行时，源码/运行时 SHA-256 一致；本地 Provider 当前在 `http://127.0.0.1:8484` 健康运行，`nativeHarnessOnly:true`。桌面客户端壳已安全同步到官方 Codex `26.707.8168.0`，源/活动 host 与 CLI 指纹一致，旧版 `26.707.3748.0` 保留为回滚点

## 1. 这份文件解决什么问题

`PRODUCT_ARCHITECTURE.md` 规定最终产品应该怎样工作；本文件记录当前代码到底做到了什么、什么没做、什么做错了、什么必须删除。后续频道不得仅凭旧报告、提交数量或聊天记忆判断进度。

状态只有四类：

- **保留**：方向正确，主体已实现；最终仍要随新协议主链路做一次回归。
- **改进**：方向正确，但实现或覆盖不完整，不能按完成计算。
- **未完成**：目标明确，但正式产品路径还没有可用实现。
- **删除**：违反“Codex 唯一控制任务”的架构基石；不能继续修补或扩展。

## 2. 总结

1. 项目不是从零开始。客户端副本、状态隔离、品牌图标、更新同步、Antigravity 账号与模型发现、真实文本传输、Manager、安装诊断和宿主结果验证都应保留。
2. 核心缺口仍是 Codex Responses 与 Antigravity 之间的严格协议层。请求/响应转换和 SSE 事件信封已有受测子集并已部署，但尚未覆盖真正增量流式、完整历史、压缩和 WebSocket。
3. 旧 Translator 明显越界。`translator/adaptive-server.mjs` 当前为 1,002,288 字节、按 PowerShell UTF-8 行读取为 15,575 行，仍有 615 个顶层函数；按名称保守统计，至少 190 个函数在分析任务、生成或改写命令、修补 Patch、强制验证、代发重试或判断业务完成。
4. 当前产品完成度仍按 **64%** 计算。23 个聚焦协议测试和网关级闭环证明了可复用子模块，但真实 Codex Desktop 简单任务失败，且上游轨迹证明单文本生产桥在架构上不可用，因此暂不虚增进度。

## 3. CC Switch 实际采用状态

### 3.1 已经完成的研究

- 已固定官方仓库、提交哈希和 MIT 许可证来源。
- 已读取并核对 Codex Provider 的请求转换、工具上下文、历史恢复、流式状态机和 Responses SSE 事件实现。
- 已确认 CC Switch 的产品壳不适合直接替代 Anti-Codex，但其 Codex 协议模块应成为协议实现和测试的上游基线。
- 已据此冻结 Anti-Codex 的边界：Codex 控制任务，Gateway 只做结构转换，Antigravity 只提供模型能力。

### 3.2 尚未完成的真实复用

截至本次审计，仓库中：

| 项目 | 当前数量 | 判断 |
|---|---:|---|
| 等价移植的 CC Switch 源码子集 | 2 | `transform_codex_chat.rs` 结构规则和 `codex_responses_sse.rs` 事件信封已移植 |
| 移植的 CC Switch 协议测试组 | 13 | 8 个转换/错误组和 5 个 SSE 顺序组已通过，完整协议仍未完成 |
| CC Switch 第三方版权声明 | 1 | `THIRD_PARTY_NOTICES.md` 已创建 |
| 依据 CC Switch 模块边界新建的纯协议模块 | 4 | 协议、SSE、上游和 turn 编排已拆开，不等于完整复用 |
| 当前聚焦测试项 | 23 | 全部通过；只证明已覆盖子集，不证明完整协议兼容 |

必须明确：`antigravity-native-harness-upstream.mjs` 和 `codex-native-harness-turn.mjs` 仍是本轮独立写的最小编排；`codex-native-protocol.mjs` 与 `codex-native-sse.mjs` 只完成 CC Switch 的协议子集。目前仍不能称为完整 CC Switch 移植版。后续必须继续以 CC Switch 已验证规则和测试驱动，不能回到自行猜协议。

### 3.3 应直接移植或逐项翻译的部分

CC Switch 使用 Rust，Anti-Codex Gateway 使用 Node.js，因此大部分不是逐字复制，而是按相同状态机和测试夹具等价移植。移植时保留来源注释，并新增第三方声明。

| CC Switch 模块 | 可直接利用的成熟能力 | Anti-Codex 落点 | 当前状态 |
|---|---|---|---|
| `transform_codex_chat.rs` | function/custom/namespace/tool_search 映射、工具名碰撞、输入文件、推理、tool choice、并行调用、错误和用量转换 | `translator/codex-native-protocol.mjs` | 两批已移植；完整 reasoning 历史、并行边界和更多 usage 边界待完成 |
| `codex_chat_common.rs` | call item、namespace、reasoning 和空值的共享规则 | 新建小型共享协议模块 | 未移植 |
| `codex_chat_history.rs` | 依据 `previous_response_id` 和 `call_id` 恢复调用、并行工具组、custom/tool_search 历史 | `translator/response-history.mjs` | 现有实现不够，未移植 |
| `codex_responses_sse.rs` | Responses SSE 唯一事件构造器和严格事件顺序 | `translator/codex-native-sse.mjs` | 基础信封和成功/失败顺序已移植；真正增量输入仍待流状态机 |
| `streaming_codex_chat.rs` | 文本、推理、工具参数增量、custom、namespace、失败和流结束状态机 | 新建流转换状态机 | 未移植 |
| `codex.rs` | Provider 路由、URL、模型和协议格式边界 | 保留必要子集，不移植 UI/商店 | 未移植 |
| `transform_responses.rs` | Responses 与其他结构化协议的成熟转换和错误边界 | 仅在 Antigravity 传输需要时采用 | 待评估 |

第一批至少要等价移植以下 CC Switch 测试事实：

- 有工具才保留 `tool_choice` 和 `parallel_tool_calls`。
- function、custom、namespace 和 tool_search 可双向恢复。
- 并行工具调用保持在同一个 assistant 工具组，`call_id` 不丢失。
- 工具输出保持原始文本或规范 JSON，不猜测业务含义。
- streamed arguments 能唯一重组，custom 输入使用独立事件。
- 流错误只发 `response.failed`，不能随后再发 `response.completed`。
- 有输出但缺结束原因时是 incomplete；完全无输出时是 failed。
- `input_file`、reasoning、usage 和 provider error 都有确定映射。

### 3.4 不从 CC Switch 移植的部分

- Tauri 桌面 UI、Provider 商店和多应用管理。
- 云同步、备份商店和 CC/Claude/Gemini 的整套配置管理。
- 与 Anti-Codex 单一 Antigravity 产品目标无关的 Provider 功能。
- 任何会改写原版 Codex 配置或取代现有独立客户端副本的逻辑。

## 4. 已符合方向，应保留

| 工作面 | 主要代码 | 当前事实 | 处置 |
|---|---|---|---|
| 官方 Codex 客户端副本 | `deepcodex.app/`、`scripts/install-anticodex.ps1`、`scripts/sync-anticodex.ps1` | 候选同步、校验、激活和回滚已存在；当前活动壳与官方 `26.707.8168.0` 一致 | 保留；后续 Codex 更新继续走同一受保护流程 |
| 独立状态 | `scripts/start-deepcodex.ps1` | 独立 `CODEX_HOME`、Electron user data 和 `%APPDATA%\anticodex` | 保留 |
| 品牌与图标 | `assets/`、`scripts/patch-exe-icon.ps1`、安装脚本 | 新版应用、窗口、任务栏、托盘和快捷方式图标已通过帧尺寸、颜色和路径校验 | 保留；不允许换回 GPT/Codex 图标 |
| 中文 Manager | `brand-profile-dropdown.mjs`、Manager 注入和 bridge | 新版个人菜单经真实鼠标打开后显示“管理”，没有 `Manager`；管理面功能保持 | 保留；入口必须继续叫“管理” |
| Manager 关闭交互 | Manager 注入脚本、`test-anticodex-manager-button.mjs` | 新版 `native-panel-v104` 上、中、下区域真实 mouse press/release 全部关闭成功 | 保留；每次客户端更新必须重跑三点验证 |
| Antigravity 账号与模型 | `antigravity-agentapi.mjs`、catalog、readiness、account tracker | 能发现本机登录态、账号和模型 | 保留 |
| Antigravity 文本传输 | `antigravity-agentapi.mjs` | Desktop Cascade 和 CLI 文本请求通路已存在 | 保留；剥离任务语义 |
| Antigravity 原生 MCP 结构化事件 | `antigravity-native-mcp-bridge.mjs`、`antigravity-agentapi.mjs` 的 native turn/resume | 已有工具 schema 暴露、`CORTEX_STEP_TYPE_MCP_TOOL` 提取、同 Cascade 结果回传、取消和 TTL 基础 | 保留并从旧语义上游中提取；只有无权限弹窗且 Codex 执行工具时才可进入主路 |
| 请求生命周期 | request queue、registry、session lock、failure circuit、route audit | 排队、取消、会话互斥、熔断和路由审计是传输级职责 | 保留；补新主路径测试 |
| 响应历史基础 | `response-history.mjs` | 可持久化 `previous_response_id` 上下文并显式报告过期 | 保留并按 CC Switch 加强 |
| 安装与诊断 | runtime sync、diagnostics、release reports | 可检查源码/运行时指纹、进程、图标、Manager 和报告 | 保留；发布结论改为结果优先 |
| 真人式验证基础 | UI smoke、human-edge、human-long verifier | 已能从宿主检查文件、命令、测试、进程和越界修改 | 保留 verifier；删除 Translator 为通过这些测试而写的特判 |
| 历史清理 | `scripts/clear-anticodex-conversations.ps1` | 有路径保护和备份优先的清理实现 | 保留；仍需大量频道下的性能和恢复实测 |

## 5. 方向正确，但做得不完整或不正确

### 5.1 新纯协议模块

| 文件 | 已做到 | 仍缺少 | 处置 |
|---|---|---|---|
| `codex-native-protocol.mjs` | 基本文本、function/custom/namespace/tool_search、`call_id`、无工具字段清理、输入文件/图片/音频、推理拆分、incomplete、Provider 错误、显式 DSML 和普通文字不猜工具 | reasoning 历史、并行边界、完整 tool choice、完整 usage | 继续按 CC Switch 夹具扩充 |
| `codex-native-sse.mjs` | created/in_progress、message、reasoning、function/custom delta/done、completed/failed 严格顺序 | 当前接收完整结果，缺少边到达边发出的流状态机 | 保持纯事件构造器，接入真正增量流 |
| `antigravity-native-harness-upstream.mjs` | 使用系统临时目录作为中性模型 workspace，生命周期接线较小 | 依赖 `buildAntigravityProtocolPrompt` 把角色和工具压成单文本；当前缓冲完整结果、固定 `finish_reason=stop`、模型名靠正则猜 | 保留小型生命周期外壳，彻底替换单文本传输实现 |
| `codex-native-harness-turn.mjs` | 只有“请求转换 -> 上游 -> 响应转换”三步 | 还没有流式接口、错误接口和完整契约 | 保持小，不能加入任务策略 |

### 5.2 主路由接线

- `ANTICODEX_NATIVE_HARNESS_ONLY` 默认值已经是 1，普通非 compact Antigravity 请求会优先进入新 handler。
- 该分支仍位于 websocket prewarm 和 ambient suggestions 特判之后，尚未证明所有正式任务都不会绕回语义逻辑；现有静态测试只检查它位于部分 deterministic 分支之前，门禁不完整。
- `/responses/compact` 仍走旧 `antigravity-upstream.mjs`，因此上下文压缩尚未符合新架构。
- WebSocket 只是把 HTTP Responses 转发回客户端，尚未用新流状态机验证增量、取消和失败事件。
- 四个新模块已加入 runtime sync 和安装完整性校验，已安装运行时指纹与源码一致；源码 preflight 与诊断中的逐模块显示仍需补齐。
- 当前 8484 运行时健康，`nativeHarnessOnly:true`。这证明默认 normal 路径已切换，不证明 compact、WebSocket 或 Codex Desktop 长任务已经迁移。

### 5.3 历史和流式

- `response-history.mjs` 能保存完整 input/output，但没有 CC Switch 的按 `call_id` 唯一恢复、歧义拒绝、并行工具组和 custom/tool_search 恢复规则。
- 当前新路径先等 Antigravity 完整结束，再由 `codex-native-sse.mjs` 一次性构造正确事件。这是严格 SSE 信封，不是真正实时流式。
- 缺少 UTF-8 分片、工具参数 delta、reasoning delta、custom input delta、流中断和缺 finish reason 的状态机测试。

### 5.4 Codex 客户端更新兼容

- 首次同步 `26.707.8168.0` 候选时，旧补丁按固定压缩变量和组件结构寻找个人菜单，找不到新版 `onOpenSettings` 结构；候选在激活前正确失败，活动版本未被替换。
- 已新增纯转换模块 `brand-profile-dropdown.mjs` 和两项 fixture 测试，按结构字段而不是变量名识别设置菜单；真实新版 `profile-dropdown-BM5_adAy.js` 长度不变注入通过。
- 第二次受保护同步成功，源/活动版本与 host/CLI 指纹一致，旧版本可回滚。个人菜单门禁也从 DOM `.click()` 改为真实 CDP mouse press/release，要求存在“管理”且禁止 `Manager`。
- 新版仍有五个非关键旧补丁找不到原结构：windows close-to-tray、default locale、i18n gate、onboarding gate、appearance settings。当前中文 UI 和主要入口正常，因此它们不阻塞激活；后续需逐项确认是上游已删除/原生满足，还是需要新结构适配，不能长期只记录为 skipped。

## 6. 方向错误，必须删除或移出生产路径

以下代码不是“兼容层”，而是在代替 Codex 控制任务。不得继续局部修补。

| 错误代码族 | 代表函数或位置 | 为什么错误 | 最终处置 |
|---|---|---|---|
| 内部工具注入和内部循环 | `callUpstreamWithInternalTools`、`callAntigravityWithInternalTools`、`chatBodyWithInternalTools` | Gateway 自己选择、执行和收尾工具 | 从 Antigravity 产品主路径删除 |
| 根据自然语言解析伪工具 | 旧 `parsePseudoToolCalls` 及宽松修复逻辑 | 会把模型文字猜成工具调用 | 仅保留新模块“完整显式 DSML 块”解析器 |
| 任务类型和固定产物特判 | `deterministicArtifact*`、`deterministicRepo*`、`deterministicExactReplyCompletion` | 根据文件名、marker 和测试任务直接构造结果 | 删除 |
| 生成业务命令和文件 | `*Artifact*PowerShell`、`repo*Command`、`writeWebBackedArtifactFiles` | Gateway 在替模型和 Codex 写实现 | 删除 |
| 修改模型命令 | `repairLocalArtifactToolArguments`、`blockRepeatedLaunchCommand`、`stripUnrequestedForeignTestRunners`、`explicitPostPatchVerificationCommand` | 改写模型真实工具参数，隐藏协议或模型问题 | 删除 |
| Patch 语法修复和重定向 | `normalize*Patch`、`generatedArtifactPatch*`、`anchorRelativeCodexPatchPaths` | Gateway 在修代码工具，而不是转换协议 | 删除 |
| 强制验证和业务完成判断 | `artifactMarkerMismatch*`、`guardAssistantToolClaims`、`completedVerification*` | Gateway 决定任务何时完成和该测什么 | 删除 |
| 代发修复/重试轮次 | fake-tool、empty-assistant、marker mismatch、repair relay | Codex 原生续跑被另一套控制器取代 | 删除 |
| 旧上游任务恢复状态机 | `antigravity-upstream.mjs` 的 implementation/patch/verification recovery | 传输层理解工作目录、补丁和任务阶段 | 拆除，只保留传输、额度、取消和有限网络重试 |
| 单文本角色/工具桥 | `buildAntigravityProtocolPrompt`、`antigravity-native-harness-upstream.mjs` 当前调用方式 | 把 system/developer/user/tool、工具 schema 和原始工具输出拼成普通用户文本；真实模型已判为提示注入，原始输出还可伪造分隔符 | 从生产路径删除；改接结构化上游 |
| 语义补偿测试 | `adaptive-pseudo-tools.test.mjs` 中命令合成、Patch 修复、marker 和固定项目测试 | 测试在锁定错误架构 | 迁移后删除对应测试；保留纯协议夹具 |

Manager 的快捷方式修复、安装回滚、诊断采集等运维动作不属于上述任务控制，可以继续保留。判断标准是：它是否参与当前用户聊天任务的工具选择、命令、文件和完成决定。

### 6.1 本轮发现并已拆除的未提交错误部分

本轮接手前已有约 1,127 行未提交变更，其中大部分是在继续增强旧语义补偿：

- Translator 新增强制测试命令、去除“外来”测试 runner、重复检查改写和多种 Patch 格式修复。
- `adaptive-pseudo-tools.test.mjs` 新增数百行测试来固定这些改写。
- UI smoke 增加识别 Translator 终止话术的逻辑。

这些 Translator 补偿代码、对应伪工具测试和 UI“停止话术”依赖已从当前未提交 diff 中拆除；`adaptive-server.mjs` 的本轮改动从 455 行收缩到纯协议接线约 48 行。真人长任务 verifier 的宿主结果校验保留。历史提交中的同类旧架构仍在主文件内，必须在新路径稳定后继续移出生产路径。

## 7. 尚未完成

按依赖顺序排列：

1. 继续移植 CC Switch 协议夹具；来源台账、第三方声明、13 个等价测试组和总计 23 个聚焦测试项已完成。
2. 完成 Responses 请求转换：所有 Codex 工具类型、内容类型、reasoning、tool choice 和并行调用。
3. 完成真正增量流状态机；Responses 输出和 SSE 信封的文本、推理、function、custom、错误和 incomplete 基线已完成。
4. 完成 CC Switch 式历史恢复：`previous_response_id`、唯一 `call_id`、并行工具组、歧义拒绝。
5. 把 Antigravity Desktop 传输收紧为模型传输，不暴露用户项目目录，不执行本地工具。
6. 让 normal、compact 和 WebSocket 都进入纯协议体系；关闭旧语义 fallback。
7. 新模块的 runtime sync、安装完整性和健康标记已完成；继续补 source preflight 和诊断逐模块显示。
8. 网关级真实 Antigravity 最小工具闭环已通过：结构化调用、真实临时文件写入、Node CLI 执行、结果回传和中文收尾均有宿主证据；仍需用 Codex Desktop 宿主复现读/写/执行闭环。
9. 通过三类长任务和取消、失败、重启、压缩、中途纠正等边缘情况。
10. 大量历史频道下的加载性能和备份恢复仍需完成；最新版 UI、中文“管理”、关闭按钮全区域和所有图标已通过本轮回归，不再是当前阻塞。

当前维护债务快照：Anti-Codex 独立 session 根下已有 79 个 JSONL 文件、约 21.36 MB，`response-history.json` 有 8 个恢复点，备份目录有 33 个；这与“频道太多、打开转圈”现象一致，但尚未完成性能基准和备份后清理验收。Git 当前注册 84 个 worktree，其中主工作树 1 个、额外历史 worker/detached worktree 83 个；它们不是产品功能，属于待审计清理的开发残留，未核对脏改动和未合并提交前不得批量删除。

### 7.1 2026-07-13 Codex Desktop 简单任务实测反证

- 报告：`latest-native-harness-desktop-simple-model-gemini-3-5-flash-low.json`，`ok:false`，耗时 289872 ms，使用真实 Antigravity 流量。
- 已证明正常的部分：桌面真实鼠标提交、指定模型路由、Responses 多轮、Codex 本地工具执行、工具结果回传均发生。
- 已证明失败的部分：模型只执行 `Get-ChildItem`，随后错误调用 `get_goal`；在得到 `goal:null` 后询问用户要做什么。三个要求文件均不存在，最终回复也没有任务标记。
- 原始用户任务在后续请求历史中没有丢失，因此当前主阻塞进一步收敛为：纯协议 Prompt 没有可靠保留“工具结果属于同一当前任务”的角色和续轮语义。阶段 B 仍未通过，完成度不得上调。
- 允许的修复仅限通用角色、轮次、工具调用/结果的结构化序列化；禁止恢复任何按目录、文件名、marker 或测试任务生成命令和判断完成的旧补偿。
- 已否决方案：仅在序列末尾追加 `[ASSISTANT]` 虽通过 26 项聚焦测试，但真实重跑开始重复 `Get-ChildItem/get_goal`，没有创建文件。任务已主动取消，补丁已回退；后续不得把静态 Prompt 形状测试当成续跑成功证据。
- 上游轨迹给出更强反证：实际发送内容为 10.9 万到 14.3 万字符，而模型计费输入稳定在约 1.72 万 token；模型思考明确把 `[CODEX_PROVIDER_PROTOCOL]`、`[CODEX_TOOLS]` 和 XML 工具块识别为用户提示注入，并坚持只认 Antigravity 自己的 `default_api:manage_task/schedule`。因此当前 `buildAntigravityProtocolPrompt` 单文本桥不是可继续调 Prompt 的半成品，而是必须退出生产主链路的错误传输形态。
- 正确下一步是接通能原生承载角色和工具 schema 的 Antigravity 结构化接口。优先调查复用登录态的原始模型接口；Desktop native MCP 只能在无权限弹窗、Codex 仍执行工具且调用/结果可严格对应时采用。CC Switch 的结构转换继续保留，但输出不能再压成一条普通用户消息。

## 8. 执行顺序和完成门槛

| 阶段 | 允许做什么 | 完成门槛 | 产品完成度 |
|---|---|---|---:|
| 当前 | 架构审计、纯模块、测试夹具和网关级真实闭环 | 静态越界门禁与 Codex Desktop 宿主闭环仍未完成 | 仍为 64% |
| A | 结构化上游与协议门禁 | 角色/工具结构化传输通过，normal 生产路由无语义控制或单文本回退 | 68% |
| B | 最小真实工具闭环 | 宿主证明读/写/执行/结果/收尾，零 Translator 补偿 | 81% |
| C | 长任务和边缘情况 | 三类长任务及取消、失败、恢复、压缩通过 | 95% |
| D | 产品收尾 | UI、图标、管理、历史性能、安装和新 release gate 全通过 | 100% |

阶段 B 以前不再用更多固定任务特判掩盖协议问题。任何旧测试若要求 Translator 生成命令、改 Patch 或判断 marker，应删除测试，而不是恢复错误实现。

## 9. 每次接手的核对项

1. 读取 `PRODUCT_ARCHITECTURE.md` 和本文件。
2. 核对当前源码提交、未提交 diff、已安装运行时指纹，并用 `resolve-anticodex-base-url.ps1` 解析当前 Provider 地址；不得硬编码旧端口。
3. 核对 CC Switch 对照提交是否变化；变化时先跑差异审计。
4. 检查生产 Antigravity 路由是否仍默认纯协议模式，compact 和 WebSocket 是否已迁移。
5. 检查新增代码是否理解用户任务、工作目录、文件名、测试命令或完成 marker；理解这些内容就可能越界。
6. 只有宿主文件、命令、测试、进程和协议事件通过，才更新完成度。

## 10. 不能被后续结论覆盖的事实

- CC Switch 原版不能直接满足完整产品，但它的 Codex 协议实现必须被实质复用，而不是只写“参考”。
- 当前纯协议骨架尚未完成 CC Switch 等价移植。
- 当前安装运行时默认进入新的 normal handler，但该 handler 后半段仍使用错误的单文本上游；这不是端到端纯协议完成。compact、WebSocket、历史和真正增量流也仍未完成。
- 旧全绿 release gate 已被用户简单任务失败和零文件变化长任务反证。
- 网关级简单真实工具闭环已经通过，但在 Codex Desktop 简单闭环和长任务通过前，Anti-Codex 仍不能被称为可用于真实项目。

## 11. 下一步固定顺序

1. 为结构化 Antigravity 上游写最小契约：角色、工具 schema、调用和结果必须是独立字段，不得是一条用户文本。
2. 优先接通复用登录权益的原始结构化模型接口；若采用 native MCP，先证明无权限弹窗、Codex 执行工具、同 `call_id` 结果可续回同 Cascade。
3. normal 路由切到结构化实现并 fail-closed，禁止失败后回落到旧语义补偿。
4. 用 Codex Desktop 完成一次真实读、写、执行、工具结果回传和正常收尾。
5. 移植真正增量流和 CC Switch 历史恢复，再迁移 compact 与 WebSocket。
6. 通过三类长任务及中途纠正、取消、失败、重启和压缩恢复。
7. 替代路径稳定后删除不可达语义代码、错误测试和旧 marker 发布规则。
8. 最后处理历史频道性能、备份清理、工作树残留和 UI/图标/安装总回归。
