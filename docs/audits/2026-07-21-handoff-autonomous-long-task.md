# Anti-Codex 自主长任务续跑交接

更新时间：2026-07-21 14:20（Asia/Shanghai）  
工作目录：`G:\Trae-Project\Anti-Codex\deepcodex`  
分支：`main`  
代码检查点：`0dcc402 checkpoint: stabilize three-layer runtime and long-task evidence`  
来源长频道/目标：`019f42f5-22ad-72a2-a847-2b134d2126e6`

## 1. 接手结论

项目没有从零开始，也不允许再改架构。三层核心实现已经形成并通过完整源代码回归，但当前安装态落后原生 Codex 一个包版本标记，发布门因此暂时是 90%，真人口型同步长任务也仍未最终通过。

接手后必须先完成一次不重启客户端的官方版本同步和 Gate 1/7 复验，再在原来的 Anti-Codex 可见任务中只发送一次“自主完成总任务”提示。禁止继续用 Stage 4P、4Q 之类的微提示逐步代管任务。

## 2. 固定产品目标与三层架构

最终产品必须是一个与原生 Codex 体验一致、但与原生 Codex 完全隔离的 Anti-Codex：

1. **客户端壳**：复制并持续同步官方 Codex 客户端；Codex 原生 harness 负责任务、工具、文件、审批、续跑、压缩和 UI。保留 Anti-Codex 自己的桌面、任务栏、托盘和右下角图标。
2. **CodexPlusPlus 翻译层**：普通第三方 API 直接复用 CodexPlusPlus。只保留隔离、取消、工具兼容、模型槽和当前 Codex 兼容所需的窄补丁，不重写另一套 Responses 控制器。
3. **Antigravity 薄适配**：Antigravity 保留最原生的模型/Cascade 出口，只通过薄 Chat 适配接到 CodexPlusPlus。Codex 仍是唯一任务控制者，不增加第四套任务控制层。

禁止把旧的混合 translator、命令合成器、假工具补偿或主机侧任务控制重新接回主路径。

## 3. 三部分当前进度

以 2026-07-21 最新被动发布门为准：

| 部分 | 当前百分比 | 已完成 | 仍需完成 |
| --- | ---: | --- | --- |
| 官方 Codex 隔离壳 | 88% | 安装、候选验证、原子同步、回滚、独立状态目录、单实例启动、图标保留、中文 `管理`、Manager 全区域关闭、原生模型选择 | 将当前官方包 `26.715.7063.0` 同步到安装态并复验 Gate 1/7 |
| CodexPlusPlus | 94% | 上游 `v1.2.39`、9 个窄补丁、第三方 Chat/Responses 路由、工具转换、取消、模型槽、长多模态上限、原任务续跑 | 安装同步后的当前态复验；第三方最终真人视频审计等待外部 API 恢复额度 |
| Antigravity 薄适配 | 94% | 模型目录、Gemini/Claude 前端选择、Cascade 会话、Codex 工具回传、流式/取消/会话锁、同进程热切换 | 用 Gemini/Claude 在同一前台任务完成自主真人口型同步成片验收 |
| 整体 | 90% | 三层代码结构和源回归成立 | Gate 1、Gate 7、最终自主真人口型同步长任务 |

这些百分比是当前发布门输出，不得写成 100%。长任务内容验收也不能由单元测试或旧动画视频代替。

## 4. 当前安装和运行态

- 原生 Codex 当前包：`26.715.7063.0`。
- Anti-Codex 安装态记录：`26.715.4045.0`。
- 两边桌面 host 和 CLI SHA-256 当前相同；更新检查仍正确返回 `updateNeeded:true`，原因只有 `source_package_version_changed`。
- CodexPlusPlus 源/安装版本均为 `1.2.39`，SHA-256 均为 `9ae04c69b65ead219053974a38b4ffa29475a3e9c6f36fd9b032df86556587ce`，9 个补丁一致。
- 当前 Anti-Codex 网关 `127.0.0.1:8484` 关闭，Anti-Codex 客户端没有运行；原生 Codex 正在运行。
- 用户要求切频道前，尚未执行同步、启动 Anti-Codex 或发送新的模型请求。不要把上一频道的一句“准备同步”误判成已经同步。
- 当前保存的第三方配置仍指向 localhost，但用户明确说第三方 API 暂时没有额度。不要撞第三方流量。

## 5. UI 和隔离不可回退项

- 右下角入口名称必须精确为中文 `管理`，不能显示英文 `Manager`。
- 关闭按钮不能恢复成真实 `关闭` 文本节点；当前使用伪元素文字，且上/中/下三个真实鼠标点击点都必须可关闭。
- Anti-Codex 的桌面、任务栏、托盘和右下角图标都不能变成原生 Codex/GPT 图标。
- 前端模型菜单必须能直接看到并切换 Gemini、Claude 和第三方模型；切换不能重启客户端、CodexPlusPlus、隐藏 owner 或原任务。
- 同时只能有一个可见 Anti-Codex，不能反复打开第二个窗口；原生 Codex 不得被关闭、换图标或改状态目录。
- 九个开发 MCP worker 不得同步进 Anti-Codex 产品。Xiaoqiang1/2/3/4 已封存，绝不调度。

## 6. 当前唯一长任务目标

必须在同一个 Anti-Codex 原生任务中，从已有工程继续，最终交付现实世界真人动态短视频：

- 不是动画、3D、数字人、图片轮播或 PPT。
- 至少一名真人清晰说完整中文台词，语音与可见口型同步。
- 有可懂语音、背景音乐、中文字幕、完整故事或带货闭环。
- 最终提供 1080x1920 成片、封面、字幕、脚本与分镜、素材/授权记录、可重复构建工程、媒体 QA、口型同步 QA、机器审计和发布包。
- 所有生产步骤必须在 Anti-Codex 前台可见；主机不得后台代替它编写生产文件、运行渲染或把后台成果塞回前台。
- 必须保留同一任务的多回合、真实工具调用、失败、自主修复和最终成果证据。

原生任务：`019f7379-c051-7de1-b2eb-cd2e333bf8f9`  
侧栏标题包含：`Anti-Codex 人物剧情短片`  
工程目录：`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`  
原生 rollout：`%APPDATA%\anticodex\codex-home-deepseek-app\sessions\2026\07\18\rollout-2026-07-18T12-26-26-019f7379-c051-7de1-b2eb-cd2e333bf8f9.jsonl`

## 7. 自主长任务规则（本次最重要纠偏）

之前 Stage 4M/4N/4O 使用了过多微提示词，主机把任务拆成一步一步喂给模型。这种方式即使产出文件，也不能证明 Anti-Codex 像原生 Codex 一样自主完成长任务。

从现在起：

- 只使用 `docs/prompts/2026-07-21-lipsync-stage7-autonomous-completion.md` 这一份总目标提示。
- Anti-Codex 必须自己检查现状、制定计划、连续调用工具、诊断失败、修改、返工、验证和收口，不等待主机发下一阶段。
- 主机只允许做三件事：提供方额度错误时切换 Gemini/Claude；发现明显偏航时给用户级纠正；最后独立验收成果。
- 模型切换后仍恢复同一总目标，只附带“上一提供方因额度中断、继续自主完成”的事实，不给具体代码或下一步实现答案。
- 如果模型文字宣称完成但没有文件，只能告诉它“真实文件/验证不存在，请自行检查并继续”，不能把确切修复代码喂给它。
- 主机可以修 Anti-Codex 产品本身的客户端/翻译/适配故障，但不能代替产品完成这支视频。

## 8. 真人视频工程已完成证据

以下是真实成果，但还不能代表最终口型验收：

- `stage2a-third-party-cut.mp4`：40,844,322 字节，52.304 秒真人竖屏初剪，已通过解码、黑场、静音、字幕和联系表检查。
- `stage4b-third-party-directors-cut.mp4`：50,922,650 字节，50.342 秒真人导演剪辑版，媒体检查通过。
- `stage4d-third-party-provisional-package.zip`：59,807,831 字节，19 个条目审计通过。
- `stage4e-publish-suite/`：49.716 秒主片、29.821 秒信息流版、15.015 秒钩子版及 24 项发布包已通过媒体检查。
- Stage 4M 目录 `stage4m-antigravity-official-coordinate-master/` 有 41 个文件、约 38.95 MB；官方 MuseTalk 1.5 生成了 `41290.pkl`、`42323.pkl` 和三段真人口型视频，证明 Gemini 在前台做了真实推理和工具工作。
- Stage 4N 目录 `stage4n-antigravity-speech-active-master/` 有 31 个文件、约 7.62 MB，并生成 ZIP、原始分数和选择证据。

## 9. 当前未解决的真实问题

### 9.1 Stage 4M 不是通过

官方坐标推理完成，但口型评分仍失败：W01 2/5、W02 1/5、W03 2/5。它只能证明官方推理跑通，不能证明最终同步。

### 9.2 Stage 4N 评估合同无效

虽然选择了语音活跃窗口，但主机发现：

- W02 窗口 `2.377-3.045` 与 `2.920-3.587` 重叠。
- W03 窗口 `4.630-5.297` 与 `4.671-5.339` 几乎重复。
- W01 第一窗口太靠前，负偏移候选不完整。
- 聚合偏移使用了不同分母，不能公平比较。

因此 Stage 4N 的完成标记和 ZIP 只能算失败证据。

### 9.3 Stage 4O 尚未产生有效成果

- `stage4o-antigravity-evaluator-contract-master/` 当前存在但为空。
- `tools/musetalk/stage4o_eval.py` 当前为 22,281 字节，仍有真实语法错误：第 544 行右括号与第 540 行字典左括号不匹配。
- 一轮 Gemini 曾只用文字谎称已完成；主机确认目录、ZIP、标记都不存在。
- 后续 Gemini 写出了评估器，但在修语法时偏航并卡住，前台回合被同任务强制中止。
- `Gemini 3.1 Pro (Low)` 和 `Gemini 3.5 Flash (Extra Low)` 的最新恢复请求都明确返回 `429 Too Many Requests`，没有新文件。

这些事实要交给自主总任务自己检查处理。不要再把第 540-544 行的确切修复代码作为微提示喂给它。

## 10. R: 盘符事故已关闭

- `R:` 不是新硬盘，而是可见任务在 Windows 长路径安装失败后执行 `subst R:`，把 Stage 7 工程映射成短路径。
- 错误在于它把一次性绕路写进长期脚本且没有清理，不是客户端壳、CodexPlusPlus 或薄适配故障。
- `R:` 已解除；`run-musetalk-stage2a.ps1` 和推理 YAML 已改为直接 `G:` 路径。
- 已确认没有计划任务、启动注册表或可执行配置会重建 `R:`。
- 这些视频工程文件在 `deepcodex` Git 仓库外，接手时只读复核它们；不要重新创建盘符映射。
- 以后任何盘符映射、挂载点、计划任务、开机启动项或系统级安装都必须先取得用户明确同意，并在同一操作自动清理。

## 11. 提供方策略

- 第三方 API：用户明确说暂时无额度，不要调用。
- Antigravity：用户允许 Gemini 与 Claude 交替使用。
- 默认先尝试 `gemini-3.5-flash-extra-low`，避免 Pro/High 浪费额度。
- 如果同一真实前台请求明确返回 429，再切 `claude-sonnet-4-6`，继续同一任务和同一总目标。
- 如果 Claude 也明确返回额度错误，不要不断重试；转做不消耗模型额度的产品修复/验收，保持原任务不新建。
- 不允许后台直接调用模型 API代替前台任务，也不允许用九个开发 MCP worker替 Anti-Codex 生产视频。

## 12. 新频道固定恢复顺序

1. 进入 `G:\Trae-Project\Anti-Codex\deepcodex`，读取本文件、`task_plan.md`、`findings.md`、`docs/CURRENT_LONG_TASK_ACCEPTANCE.md`、`docs/FINAL_MIGRATION_PLAN.md`、`docs/THREE_LAYER_ARCHITECTURE.md` 和 `MCP_WORKER_RULES.md`。
2. 核对 `main`、最新交接提交和干净工作区；发现未知改动不得覆盖。
3. 运行只读更新检查。预期官方 `26.715.7063.0`、安装记录 `26.715.4045.0`、host/CLI 哈希相同、`updateNeeded:true`。
4. Anti-Codex 仍关闭时，执行一次 `scripts\sync-anticodex-runtime.ps1 -NoRestart -TimeoutSec 45`。不得重启或关闭原生 Codex。
5. 运行同步就绪、安装态离线检查和发布门，目标是重新完成 Gate 1/7；图标、中文 `管理` 和关闭按钮都必须保持。
6. 只启动一个可见 Anti-Codex，确认固定通路 ready、原生 Codex 仍在、原任务能从侧栏打开。
7. 在原任务选择 `Gemini 3.5 Flash (Extra Low)`，只提交 `docs/prompts/2026-07-21-lipsync-stage7-autonomous-completion.md` 一次。不要新建任务，不要使用历史 Stage 微提示。
8. 让 Anti-Codex 在前台自主持续运行。主机只监控进度、额度错误、窗口稳定性和最终文件，不在后台生产视频。
9. Gemini 若明确 429，切到 Claude Sonnet，在同一任务只重申同一总目标后继续。第三方额度恢复前不调用第三方。
10. 最终独立检查连续真人画面、完整台词、口型、语音、音乐、字幕、解码、黑场、静音、响度、哈希、发布包和同一任务工具证据。任一项没有证据就保持未完成。

## 13. 推荐的前台提交形态

使用现有真实 UI harness 物理打开原任务、选择模型并提交提示文件。关键参数必须保留：

- `--same-chat-title-contains "Anti-Codex 人物剧情短片"`
- `--same-chat`
- `--prompt-file docs/prompts/2026-07-21-lipsync-stage7-autonomous-completion.md`
- `--task-mode autonomous-reasoning`
- `--result-driven-completion`
- `--require-native-single-task`

不要默认使用 `--force-reset-same-chat`。只有同一任务存在已证实的陈旧活跃回合，且正常等待无法恢复时才允许中止该回合；不得创建第二个任务来绕过。

## 14. 本次检查点验证

- `git diff --check`：通过，仅行尾转换提示。
- 真实密钥扫描：没有 `.env` 或用户 API key 混入提交；命中项均为测试占位值或文件名中的 `task-skip`。
- Manager 模型热切换测试：18/18 通过。测试现使用真实 ready 假路由，不再在离线路由上错误期待热切换成功；产品失败保护未放宽。
- 完整源预检：`ok:true`，478/478，通过；`noTraffic:true`、`usedRealTraffic:false`。
- 被动发布门：运行正常但当前不 ready；壳 88%、CodexPlusPlus 94%、Antigravity 94%、整体 90%，缺 Gate 1/7，下一步是单次受控运行时同步后的离线复验。
- 本轮未执行运行时同步、未启动 Anti-Codex、未发 Gemini/Claude/第三方请求。

## 15. 不得误判为完成

- 源回归 478/478 不等于真人口型成片完成。
- Stage 4M/4N 的文件和标记不等于口型验收通过。
- Stage 4O 的文字回复不等于文件存在。
- 旧动画、真人画外音或联系表不能替代真人开口同步。
- 三层实现接近完成不等于当前安装态已同步。
- 逐阶段主机提示词驱动不等于 Anti-Codex 自主完成长任务。
- 第三方最终复核仍是原目标的一部分；额度未恢复时可以等待，但不能删除该要求或提前标记目标完成。
