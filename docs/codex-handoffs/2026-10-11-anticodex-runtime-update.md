# Anti-Codex 续接记录：官方壳同步完成，Codex++ 1.7.1 待适配

<source_thread_id>01a0b109-8e7d-7c33-b546-e690b8b2cefe</source_thread_id>

这份记录是 2026-10-11 的续接入口。新频道先读本文件，再读 `HANDOFF.md`、`COMPLETION_CHECKLIST.md` 和 `MAINTENANCE.md`，不要通读 `archive/`。

## 当前目标

继续维护 `G:\Trae-Project\Anti-Codex\deepcodex` 的 Anti-Codex 隔离运行时：保持官方 Codex 原生控制器、工具、审批、重试和完成判断不变，只维护官方壳同步、CodexPlusPlus 兼容层和 Antigravity 薄适配层。当前最重要的未完成项是把远端 Codex++ v1.7.1 在不破坏现有补丁的前提下完成重放、构建、候选验证和受管激活。

## 已完成并有证据的部分

- 官方 Codex 已同步到 `26.1007.2314.0`。活动壳与官方源版本一致，Host SHA-256 为 `13D7EE588D7AE20F04F7AA25A65AE82917ADA81501304AC8F5E679D0B3306601`，CLI 资源 SHA-256 为 `D13914CED6C7AF174D8D638DB938284231227312104B06A25E9608C632A7DAEC`，壳补丁 revision 7。
- 受管更新操作 `9595651b64a14891925ccdb470e1cc67` 已成功；候选构建、候选校验、激活、安装后检查和固定路由检查均通过。第一次同步因官方新增 `this.refreshAppBadgeCount()` 被严格校验器拒绝，补了兼容规则后重新同步成功。
- Anti-Codex 活动运行时已是成功同步后的版本：固定路由 `http://127.0.0.1:18487/anticodex/fixed-route/health` 为 ready，代理端口为 18484，当前 provider 为 Antigravity，当前模型为 `claude-sonnet-4-6`，Manager 为 v119。
- Codex++ 活动版本为 v1.5.0，二进制 SHA-256 为 `659f4b4897a8ceda304a15179c4219e8d0cb0006143f66f92fce541075ad548f`；当前身份锁定为 upstream commit `23ed5515e69431794cbef363a886d974abcc6179`、patch commit `638b582a7b1c0ae1b47f5d91e72f2e60ba68d425`，源码、活动组件和清单一致，只有一份累计补丁。`third_party/codexplusplus/upstream.json` 仍有 `runtimeIsolation: candidate only; not activated` 的旧元数据，不能覆盖活动清单和安装后实证；后续适配时要顺手修正或明确其历史性质。
- 用户已在桌面端确认图片上传、识别和同一任务追问图片正常。协议层也完成 Gemini 图片识别、Claude 工具读取图片、流式 delta、终端和文件任务、Gemini/Claude 切换、联网搜索、本地 DevSpace MCP、插件 parity、账号切换和恢复验证。
- 当前版本的无流量安装快检与同步就绪检查均退出 0：
  - `.validation/20261010-update/latest-installed-overall-fast.json`
  - `.validation/20261010-update/latest-sync-readiness.json`
- 测试数据清理已完成且可恢复：删除 Anti-Codex 内 128 个测试线程、7048 条历史项、372 个回合和相关临时项目；保留 2 个真实 CodexCPA 讨论线程。备份在 `C:\Users\XD\AppData\Roaming\anticodex\conversation-backups\selected-tests-20261008-160529`，含 manifest、恢复脚本和清理前数据；没有复制凭证，官方 `C:\Users\XD\.codex` 未动。

## 远端更新与未完成项

- 远端 Codex++ 已发现 v1.7.1，来源提交 `5fe25892eb312abbc091512565a8dc2621a8c999`。本机没有可复现的完整 tag object，因此以后以这个完整来源提交锁定，不把截短的 `ef83e8b...` 当身份。当前没有 v1.7.1 候选、构建或激活证据，活动版本仍是 v1.5.0。
- v1.7.1 与现有补丁在 launcher、core paths/watcher/protocol_proxy/relay_config、bridge、manager 命令与库、session host ownership、navigation/layout/plugins/encryption 等区域有较大重叠；历史 v1.3/v1.4 的补丁重放已经出现冲突。必须先做静态三方审计和窄范围红测，再按受管 Docker runner 构建；不能直接覆盖活动组件。
- 本轮采样的物理可用内存约 3.5 GB；`MAINTENANCE.md` 最新历史记录曾为约 4.9 GB，两者都低于项目规定的 8 GB 全量构建门槛。每次启动大型构建或并行全量测试前必须重新采样内存、确认没有其他重任务，并把并发限制为最多 2；当前先做只读 diff、冲突定位和最小测试。
- 外部 OAuth 连接器仍是 5 个已配置、0 个已连接；这是需要用户逐个登录授权的独立事项，不要把它误报成 Anti-Codex 核心故障。
- 原账号 Claude 周额度仍为 0；曾用备用账号验证 Claude 工具链并在任务中切到 Gemini，不能声称原账号额度恢复。

## 已验证的功能矩阵

- Gemini：图片语义识别、通用联网搜索、流式输出、工具和长任务续接均有报告。
- Claude：当前备用账号的终端、文件读取、图片读取和流式路径有报告；原账号额度不足时会按额度策略切到 Gemini。
- 图片：桌面上传和后续追问已由用户手动确认；协议层图像内容与文件 SHA-256 也已核对。
- 本地能力：终端命令、文件修改、DevSpace `search/fetch`、插件缓存 parity 和本地 MCP 已有通过证据。
- 账号：保存当前账号、切换备用账号、验证、恢复原账号的任务链已通过；目标账号第一次旧启动确认失败，修复后恢复任务成功。
- 清单：账号 schema 11 pass，账号/login suite 51 pass，账号+凭证+cascade 回归 41 pass，品牌/回滚 68 pass。

## 关键提交

- `e8d77968` 图片输入/原生配置
- `545117ec` 后续回合图片保留
- `09ee2008` 当前 Antigravity 登录 schema
- `90e308c4` 账号重启与 CSRF
- `efdfba98` 全量文档审计
- `0fd68a61` 账号切换实证
- `60865f0f` 官方新壳 tracker `refreshAppBadgeCount()` 兼容
- `e5664594` 官方 Codex `26.1007.2314.0` 同步记录

当前 `main` 工作树在本记录创建前是干净的；新增本文件后应提交一次，再创建新频道。

## 新频道执行顺序

1. 先确认 `git status` 干净，并读取本文件、`HANDOFF.md`、`MAINTENANCE.md`。
2. 只读比较 v1.5.0 现有补丁与 v1.7.1 上游提交，建立冲突清单和最小红测；不要在内存低于 8 GB 时启动全量构建。
3. 先验证 Codex++ 的流式 beta 头传递和 bridge quota gate 两个已知审计点，再决定是否进入 v1.7.1 补丁重放。
4. 通过源码门、补丁哈希、隔离审计、受管 Docker 构建、候选验证后，才允许受管安装、运行时同步和安装后固定路由检查。
5. 任何失败都保留候选和回滚点，不直接覆盖活动组件；不要重复已经通过的图片、账号和清理验收，除非出现新修改或新失败。

## 不可触碰的边界

- 不改官方 Codex 安装、官方进程、`C:\Users\XD\.codex` 数据、凭证、权限、全局启动路径或 `CODEX_CLI_PATH`。
- 不创建新的 `deepcodex-*` worktree，不向 `archive/` 追加内容，不把历史报告当当前运行证据。
- Codex++ 构建必须走项目受管 runner，容器必须自动清理；Anti-Codex 运行时切换必须走 `sync-anticodex-runtime.ps1` 事务。
- Docker 安全边界也必须保留：禁止全局 `docker kill`/`docker prune`，禁止停止、杀死、重启或强制删除用户或仍在运行的容器，禁止超时后换名字重试；测试容器必须有显式名称和 `com.anticodex.task-id` 标签。
- 当前频道和新频道保持完整；续接瘦身只允许处理更老的第三代及以前历史，且必须先做 gzip 备份和哈希校验。

## 回滚与恢复

- Anti-Codex 运行时：使用现有受管 rollback 目录和 `sync-anticodex-runtime.ps1`，不要手工拷贝活动文件。
- Codex++ 组件：使用 `install-codexplusplus-component.ps1` 的 staging/backup/verify 事务，失败自动回滚。
- 测试数据：使用 `C:\Users\XD\AppData\Roaming\anticodex\conversation-backups\selected-tests-20261008-160529\restore.py` 恢复清理前 Anti-Codex 数据；官方 Codex 数据不在备份内。

