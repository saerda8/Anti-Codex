# Anti-Codex 项目交接文档(新会话必读)

> 写于 2026-08-13。这是新会话接手项目的**唯一入口文档**。读完本文即可开工,
> **不需要**也**不应该**去通读 `archive/` 里的历史账本(合计超过 250 万字符,
> 只是历史证据)。

---

## 1. 项目是什么

**Anti-Codex** 是官方 Codex Desktop(Windows)的一份**隔离副本**:保留 Codex
原生界面和任务控制,只替换模型提供方接入。与原版 Codex 互不干扰、可同时运行。

架构是**锁定的三层结构**(详见 `docs/THREE_LAYER_ARCHITECTURE.md`),任何实现
不得在三层之外新增任务控制层:

1. **官方 Codex 隔离壳**:从官方 Codex 复制并打最小补丁(当前 16 个逻辑补丁,
   `hostPatchRevision:2`)。规划、工具、审批、重试、压缩、完成判断全部由原生
   harness 独占。
2. **CodexPlusPlus 通用接入层**(第三方 Rust 项目,AGPL):处理 Responses/Chat
   协议与普通第三方 API 直连。本仓只 pin 上游版本 + 维护窄补丁
   (`third_party/codexplusplus/patches/`,12 个),不 vendor 源码。
3. **Antigravity 薄适配层**(`translator/provider/`):仅在选 Antigravity 模型时,
   把 Chat Completions 映射到本机 Antigravity Desktop 的 Cascade,复用其登录与额度。
   不执行工具、不判断任务完成。

**关键路径:**

| 内容 | 位置 |
|---|---|
| 唯一工作仓 | `G:\Trae-Project\Anti-Codex\deepcodex`(main 分支) |
| 安装入口 | `install-windows.bat` → `scripts/install-anticodex.ps1` |
| 安装落点 / 状态 | `%LOCALAPPDATA%\Anti-Codex` / `%APPDATA%\anticodex` |
| 启动 supervisor | `scripts/start-anticodex-fixed-route.mjs` |
| Manager 管理页注入 | `scripts/anticodex-manager-inject.js` + `anticodex-manager-service.mjs` |
| 壳补丁 | `scripts/brand-patched-asar.mjs` / `brand-patch-compat.mjs` |
| 测试 | `translator/tests/*.test.mjs`(64 个文件)+ `scripts/test-anticodex-*` |
| 完整源码门 | `scripts/test-anticodex-source-preflight.ps1`(无流量,要求 git 工作区干净) |

## 2. 当前状态快照(2026-08-13)

- **产品可用**:已安装版本为 revision 7 壳(基于官方 Codex `26.803.5235.0`)
  + CodexPlusPlus `v1.2.45`(已验收激活)。
- **上游漂移(两项待办,登记在 `MAINTENANCE.md`)**:
  - 官方 Codex 已自动更新到 `26.803.10989.0`;只读检查确认 16/16 补丁可应用,
    还需一次受控同步(检查 → 候选 → 无流量验证 → 激活 → 冒烟)。
  - CodexPlusPlus 上游发布 `v1.2.46`;12 补丁源码重放与隔离审计已通过,
    还需受管 Docker 构建 + 候选验证后才能激活。
- **测试**:完整 translator 套件在干净提交上全绿(64 文件,约 1000+ 断言)。
  注意:多个 gate 校验器要求 `git status` 干净,**工作区有未提交改动时部分测试必红**,
  这是设计行为,不是产品缺陷。
- **未提交改动**:2026-08-13 的治理重构(本文档所属批次)已暂存未提交。
  **新会话第 0 步就是提交它**(见第 5 节)。

## 3. 历史与教训(为什么这个项目做了 9 个月收不了尾)

简要了解即可,不要重蹈覆辙:

- 旧体系把"100% 完成"定义为:安装字节 + 真实鼠标全矩阵 + 当前哈希自主长任务成片,
  且**任何一次上游更新/运行时激活/设置变更都自动重开已通过的验收项**。
  完成目标与持续变化的外部上游耦合,数学上不可闭合,项目长期停在"总体 90%"。
- 状态靠往 `task_plan.md`/`findings.md` 顶部无限追加 "CURRENT OVERRIDE" 段落维护,
  账本膨胀到 2.6MB,每个新会话先啃账本、再堆新段落,永远在"还差一步"。
- 曾有 67 个并行实验克隆 + 42 个 worktree 淹没仓库(2026-08-13 已全部归档到
  根目录 `_archive/`,审计确认零独有提交)。
- 一个已退役的测试(`archive/retired-tests/anticodex-plan-truth.test.mjs`)曾逐字
  断言账本内容,强迫每次修改都往账本堆新段落。

**2026-08-13 起换用新体系**:基线冻结 + 短清单 + 维护日志(见下节)。

## 4. 新治理体系(必须遵守)

| 文件 | 作用 |
|---|---|
| `COMPLETION_CHECKLIST.md` | **唯一**完成判定:13 项验收,全部勾选即发布 1.0 并打 tag `v1.0.0` |
| `MAINTENANCE.md` | 上游更新的日常处理流程 + 维护日志;**上游漂移不重开已勾选项** |
| `KNOWN_LIMITATIONS.md` | 被接受的限制(偶发单帧白屏、自主长视频 demo 化等),不阻塞发布 |
| `MCP_WORKER_RULES.md` | 精简版硬规则(Docker 构建卫生 + 工作区纪律) |
| `archive/` | 全部历史账本,只读,禁止追加 |

**硬性禁令:**

1. 不得在三层之外新增任务控制层,不得重写 Codex 控制器。
2. 不得改动、关闭或降级原生官方 Codex 的安装与数据。
3. 不得创建新的 `deepcodex-*` 克隆或 worktree;唯一工作仓是 `deepcodex`。
4. 不得向 `archive/` 内文件追加内容;不得新建任何形式的累积式计划/账本文件。
   状态只写两处:`COMPLETION_CHECKLIST.md` 的验收记录表、`MAINTENANCE.md` 的维护日志。
5. 不得因官方 Codex 又更新了就宣布"项目未完成"——那是维护事件,走 `MAINTENANCE.md`。
6. 概率性、不可稳定复现的物理现象(如单帧白屏)按 `KNOWN_LIMITATIONS.md` 处理,
   不得为它无限加大采样轮数或阻塞发布。
7. CodexPlusPlus 构建必须走受管 runner(`scripts/invoke-anticodex-cargo-xwin.ps1`),
   容器必须 `--rm`,构建后零残留。

## 5. 接手后的执行顺序

**第 0 步:提交暂存的治理重构**(如果 `git status` 还不干净):

```powershell
cd G:\Trae-Project\Anti-Codex\deepcodex
git commit -m "governance: freeze completion baseline, archive append-only ledgers, retire plan-truth test"
```

提交后完整跑一次测试套件确认全绿:

```powershell
$files = Get-ChildItem translator\tests\*.test.mjs | Select-Object -ExpandProperty FullName
node --test --test-concurrency=2 @files
```

**第 1 步:按 `COMPLETION_CHECKLIST.md` 逐项验收 1–13。**
每项通过后在文末验收记录表填一行(日期 + 一句证据)并勾选。发现缺陷就在该项下
加一行子任务,修复走正常 TDD,修完勾掉子任务再验收该项。

**第 2 步(可与第 1 步穿插):清掉 `MAINTENANCE.md` 里的两条维护待办**
(官方 Codex 受控同步、CodexPlusPlus v1.2.46 受管构建)。它们不是完成清单的一部分,
但做完能让验收项 10/11(更新/回滚)在最新版本上进行,更省事。

**第 3 步:13 项全勾后**,宣布 1.0 完成,打 tag `v1.0.0`,以后只做 `MAINTENANCE.md`
的日常维护。

## 6. 常见坑(前任会话反复踩过)

- **测试红 ≠ 产品坏**:先看失败是不是 git-clean / 证据新鲜度类的验收器检查。
  验收器自身有缺陷的历史案例很多,修验收器时不要顺手改产品行为。
- **运行时激活要走事务**:同步安装用 `scripts/sync-anticodex-runtime.ps1` 的
  受控事务(候选验证 → 激活 → 回滚点),不要手工拷文件。
- **产品在跑长任务时不要激活运行时**,事务会正确地 `staged_deferred_running`,等空闲。
- **Windows 控制台中文易乱码**:往文件写中文用 Node `fs.writeFileSync` 或
  `[System.IO.File]::WriteAllText` + 无 BOM UTF-8,别用 `Set-Content`。
- 根目录 `_archive/`、`.validation/`、`deliverables/` 是归档/证据/交付物,别当工作区。

## 7. 一句话给新会话的开工指令

> 读 `deepcodex/HANDOFF.md` 后开工:先完成第 5 节第 0 步的提交与全绿确认,
> 然后按 `COMPLETION_CHECKLIST.md` 逐项验收 1–13,状态只写验收记录表和维护日志,
> 遵守第 4 节全部禁令。
