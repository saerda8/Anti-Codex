# Anti-Codex 项目全量总结与迁移接手总文档 (PROJECT_MASTER_HANDOFF)

> **更新时间**：2026-11-08（北京时间 2026-11-09）
> **文档用途**：本文档汇总了 Anti-Codex 项目的完整背景、聊天记录演进、三层架构设计、目录与文档地图、当前版本与运行进度、Git 提交记录与远端地址、**路径搬迁（改项目地址）完整步骤**，以及供其他 AI 工具或新会话零门槛接手的操作手册。

---

## 一、项目核心定位与三层架构设计

### 1.1 项目是什么
**Anti-Codex** 是官方 Windows 版 Codex Desktop（`OpenAI.Codex` WindowsApps 包）的一份**完全隔离副本**：
- **100% 保留官方原生能力**：界面、任务规划、工具调用、审批策略、错误重试、上下文自动压缩（compaction）、完成判断全部由官方原生 Codex 客户端与 `codex.exe` 独占负责。
- **仅替换模型提供方接入与隔离身份**：与本机原版官方 Codex Desktop 互不干扰、可同时运行，拥有独立的粉色图标、独立的进程身份（`Anti-Codex.exe`）、独立的配置目录与数据目录。

### 1.2 锁定的三层结构（不可擅改的项目基石）
详见 `docs/THREE_LAYER_ARCHITECTURE.md` 与 `docs/ADAPTIVE_ONE_API_STACK.md`，任何后续修改**严禁在三层之外新增任务控制层或重写自研转换器**：

1. **第一层：官方 Codex 隔离壳（Host Shell Layer）**
   - 从本机已安装的官方 `OpenAI.Codex` 复制到 `%LOCALAPPDATA%\Anti-Codex\codex-patched-app`。
   - 通过 `scripts/brand-patched-asar.mjs` 与 `scripts/brand-patch-compat.mjs` 对 `resources/app.asar` 打上固定壳补丁集（`patchProfile: "fixed-shell-v1"`, `hostPatchRevision: 7`，共 18 个关键补丁项）。
   - 通过 `scripts/electron-asar-integrity-host.mjs` 与 `scripts/patch-exe-identity.ps1` 更新可执行文件内嵌 ASAR Header SHA-256 哈希与粉色品牌图标。
2. **第二层：CodexPlusPlus 通用接入层（Protocol & Provider Proxy Layer）**
   - 第三方开源 Rust 组件（AGPL-3.0，上游仓库 `https://github.com/BigPizzaV3/CodexPlusPlus.git`）。
   - 负责将官方 Codex 发出的 Responses API 请求转换为第三方 API 或下游所需的协议（含 SSE 流式转发、402 额度错误转换、120s 空闲超时保护、本地回环鉴权、历史记录持久化等）。
   - 本仓不直接 vendor 全量源码，只通过 `third_party/codexplusplus/upstream.json` 固定已验收的上游版本（当前为 `v2.2.0`，提交 `58ef969c0b16a97c436d74bac8632cd7376f875c`）及 3 个项目补丁（`0018`、`0019`、`0020`）。
3. **第三层：Antigravity 薄适配层（Thin Antigravity Adapter Layer）**
   - 位于 `translator/provider/`，监听本地 `127.0.0.1:18488`。
   - 仅在用户选择 Antigravity 模型（如 `gemini-4-argon-high`、`claude-opus-5-5-high` 等）时，将标准 Chat Completions 请求映射到本机 Antigravity Desktop 的 Cascade 接口，复用其登录态与额度。
   - 普通第三方 API 直连时直接绕过（bypass）Antigravity 适配层。

### 1.3 本地运行端口与进程拓扑（Fixed Route）
| 端口 / 进程 | 作用说明 |
|---|---|
| `127.0.0.1:8484` | Manager 管理服务主端口（`scripts/anticodex-manager-service.mjs`） |
| `127.0.0.1:18484` | CodexPlusPlus 代理入口（`codexBaseUrl: http://127.0.0.1:18484/v1`） |
| `127.0.0.1:18485` | Launcher Guard 端口 |
| `127.0.0.1:18486` | Manager Guard 端口 |
| `127.0.0.1:18487` | Fixed-Route 健康检查端口（`http://127.0.0.1:18487/anticodex/fixed-route/health`） |
| `127.0.0.1:18488` | Antigravity 薄适配层入口（`codexPlusPlusUpstreamUrl: http://127.0.0.1:18488/v1`） |
| `127.0.0.1:18489` | 本地 Helper 辅助端口 |
| `127.0.0.1:18318` | Anti-Codex 客户端受管 CDP 端口（用于中文「管理」面板桥接与状态探针） |

---

## 二、近期聊天记录与关键修复总结

在最近两轮连续会话中，围绕“续接旧频道任务、同步最新官方 Codex、深度排查前序模型修改漏洞并恢复全套运行”完成了以下工作：

1. **接手与基线摸底**
   - 梳理确认历史 `1.11.2` / `1.12.1` 均已演进至 CodexPlusPlus `v2.2.0`（哈希 `3b63ae6676d111233f853c8c9f2d25ae3832e503c26eca6c93922331a610de0b`）。
   - 官方 WindowsApps Codex 先后从 `26.1029.7803.0` 自动更新到 `26.1103.7773.0`，随后再次更新到当前最新 `26.1106.6628.0`（内置 `codex-cli 0.167.0-alpha.3.2`）。
2. **Codex 26.1103 壳补丁适配（前序会话提交 `f29a9662` ~ `914c1053`）**
   - 适配 `26.1103` 匿名启动 MCP 配置重载函数签名（`async function({appServerConnection:...})`）。
   - 适配 `26.1103` 拆分后的 Settings 渲染 bundle（`securitySettingsEnabled:0`）与候选/回滚验证器正则。
   - 适配模型升级横幅 UI 组件在新版官方壳中已移除、仅保留 `modelUpgrades:o.model_upgrades` 数据面的变化。
   - 修复 `clear-anticodex-conversations.ps1` 清理嵌套陈旧会话引用，以及 `anticodex-prompt-policy.test.mjs` 对 `pub(crate) const PATCH_TOOL_SYSTEM_GUIDANCE` 的提取正则（消除 6 条测试失败）。
3. **本轮深度复核抓出的 2 个真漏洞与彻底修复（提交 `2e421ee7`）**
   - **漏洞 1（高危）：`auth-requirement` 补丁打偏文件，漏掉核心认证状态机 `webview/assets/async/182735.*.js`**
     - **根因**：前序模型在 `findAuthRequirementPatch` 中新增了宽泛匹配 `/[A-Za-z_$][\w$]*\?\.requiresAuth\?\?!0/` 且一命中就 `return`，导致补丁器只改了外层消费文件 `309406.*.js`，跳过了真正计算 `requiresAuth` 与默认 `authState` 的核心文件 `182735.*.js`（在新版中 React Compiler 将其编译为 `let _="copilot"===m||(l?.requiresOpenaiAuth??!0)` 及内联 `I??{openAIAuth:null,authMethod:null,requiresAuth:!0,...}`）。
     - **修复**：在 `scripts/brand-patched-asar.mjs` 与 `scripts/brand-patch-compat.mjs` 中新增对 React Compiler 认证状态与 fallback 的原位等长替换，并将 `findAuthRequirementPatch` 改为收集所有匹配 bundle 多目标同时打补丁；在 `translator/tests/brand-patch-compat.test.mjs` 新增单元测试验证。
   - **漏洞 2（启动阻断）：Windows 计划任务 `\Anti-Codex\Anti-Codex Launcher` 被外部篡改为 `"by user disabled"`**
     - **根因**：计划任务 Action 的 `Execute` 被系统/外部工具改成了 `"by user disabled"`，导致 `test-anticodex-sync-readiness.ps1` 报错 `Anti-Codex launch task is missing or stale`，且桌面快捷方式无法拉起客户端。
     - **修复**：执行 `scripts/repair-anticodex-shortcuts.ps1` 重建计划任务与 5 个快捷方式，恢复 `actualExecute: C:\WINDOWS\system32\conhost.exe`。
   - **重刷与实机运行验证**：
     - 运行 `sync-anticodex-runtime.ps1` 与受管更新任务 `Anti-Codex Updater`，将 `2e421ee7` 补丁完整写入活动宿主 `26.1106.6628.0` 并自动拉起 Anti-Codex。
     - 实测 `test-anticodex-sync-readiness.ps1`（`ok: true, failures: []`）与 `test-anticodex-installed-overall.ps1 -NoTraffic -Fast`（`ok: true, failures: []`）全部零失败通过。

---

## 三、当前项目进度与运行态基线（2026-11-08）

| 维度 | 当前状态 | 详细数据 / 证据 |
|---|---|---|
| **官方源版本** | `26.1106.6628.0` | `C:\Program Files\WindowsApps\OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0\app` |
| **活动 Anti-Codex 宿主** | `26.1106.6628.0`（rev 7） | `%LOCALAPPDATA%\Anti-Codex\codex-patched-app`，Host/CLI 哈希与源完全一致 |
| **回滚点宿主** | `26.1103.7773.0`（rev 7） | `%LOCALAPPDATA%\Anti-Codex\rollback-host`，随时可一键回滚 |
| **CodexPlusPlus 组件** | `2.2.0` | `%LOCALAPPDATA%\Anti-Codex\components\codexplusplus\codex-plus-plus.exe`（SHA256: `3b63ae66...`） |
| **Fixed Route 状态** | `ready` | UI 就绪、Manager 就绪、Antigravity 就绪（13 个直通模型 / 48 个目录模型）、6/6 共享 MCP 就绪 |
| **单元测试与总检** | 全绿 | `brand-patch-compat` (62/62)、`host-icon-packaging` (22/22)、`prompt-policy` (10/10)、`shortcut-repair-contract` (28/28)、`sync-readiness` (`ok: true`)、`installed-overall-fast` (`ok: true`) |
| **1.0 完成度清单** | 12 / 13 已勾选 | 详见 `COMPLETION_CHECKLIST.md`（第 1–12 项已完成验收；仅剩第 13 项“长任务端到端”待在需要消耗真实额度时勾选） |

---

## 四、仓库地址与 Git 提交记录

### 4.1 仓库与分支信息
- **GitHub 远端地址（origin）**：`https://github.com/saerda8/Anti-Codex.git`
- **当前分支**：`main`
- **当前本地领先远端（未 push 提交）**：领先 `origin/main`（`5ce1379f`）共 9~10 个本地提交（可根据需要随时 `git push origin main`）。

### 4.2 最近关键提交记录（倒序）
| Commit Hash | 提交说明 | 涉及核心文件 |
|---|---|---|
| `HEAD`（当前最新） | `docs: add master project handoff and path migration guide` | `PROJECT_MASTER_HANDOFF.md`, `HANDOFF.md` |
| `2e421ee7` | `fix: patch compiler auth state in Codex 26.1103` | `scripts/brand-patch-compat.mjs`, `scripts/brand-patched-asar.mjs`, `translator/tests/brand-patch-compat.test.mjs` |
| `914c1053` | `fix: clear nested stale thread state` | `scripts/clear-anticodex-conversations.ps1`, `translator/tests/anticodex-prompt-policy.test.mjs`, `translator/tests/clear-anticodex-process-safety.test.mjs` |
| `f001884c` | `fix: accept current settings validation shape` | `scripts/rollback-anticodex.ps1`, `scripts/test-anticodex-host-candidate.ps1` |
| `9ccbf30f` | `fix: accept settings flag in current renderer` | `scripts/brand-patch-compat.mjs` |
| `387ce2f6` | `fix: trim settings render whitespace` | `scripts/brand-patch-compat.mjs` |
| `a21dd8d5` | `fix: support split settings render bundle` | `scripts/brand-patch-compat.mjs` |
| `8c1fe6e6` | `fix: detect current settings render prop` | `scripts/brand-patch-compat.mjs` |
| `b2b61065` | `fix: match current settings render call` | `scripts/brand-patch-compat.mjs` |
| `f29a9662` | `fix: adapt host patches for Codex 26.1103` | `scripts/brand-patch-compat.mjs`, `scripts/brand-patched-asar.mjs`, `translator/tests/brand-patch-compat.test.mjs` |
| `5ce1379f` | `fix: resolve default workspace root after param binding in conversation cleanup`（`origin/main`） | `scripts/clear-anticodex-conversations.ps1` |
| `cd7419f3` | `chore: align repo url with Anti-Codex and remove hardcoded deepcodex paths` | 多文件仓库路径解耦与 URL 对齐 |
| `5da5aea7` | `feat: promote CodexPlusPlus v2.2.0 and brand host exe identity` | CodexPlusPlus `v2.2.0` 升级与宿主身份签名 |

---

## 五、目录结构与项目文档地图

### 5.1 两层目录关系说明（搬迁时务必注意）
当前磁盘上有两层目录：
- **外层工作区容器目录**：`H:\CodexProject\Anti-Codex`
  - 包含 `deepcodex/`（真正的 Git 源码仓），以及历史归档 `_archive/`、历史离线验证工作区 `.validation/`、历史交付物 `deliverables/`、参考资料 `antigravity-cli-reference/`。
- **内层核心 Git 仓库目录（唯一权威源码仓）**：`H:\CodexProject\Anti-Codex\deepcodex`
  - 包含 `.git/`、全部脚本 `scripts/`、适配层与测试 `translator/`、组件清单 `third_party/`、图标资源 `assets/`、文档 `docs/`。
  - **注意**：您可以只搬迁 `deepcodex` 文件夹（并可将其重命名为任意名字，如 `D:\Projects\Anti-Codex`），也可以连外层一起搬迁。

### 5.2 核心文档索引
| 文档路径（相对于仓库根） | 内容说明 |
|---|---|
| `PROJECT_MASTER_HANDOFF.md` | **本文件**：全量项目总结、演进记录、搬迁指南与 AI 接手手册 |
| `HANDOFF.md` | 治理重构后的快速交接入口与纪律规范 |
| `COMPLETION_CHECKLIST.md` | 1.0 发布的 13 项唯一验收标准与完成记录 |
| `MAINTENANCE.md` | 官方 Codex 与 CodexPlusPlus 上游更新的日常受控维护流程与维护台账 |
| `KNOWN_LIMITATIONS.md` | 已知且被接受的物理/边界限制（不阻塞发布） |
| `MCP_WORKER_RULES.md` | Docker 构建卫生与工作区纪律 |
| `README.md` / `README_EN.md` | 中英文项目公开说明文档 |
| `docs/THREE_LAYER_ARCHITECTURE.md` | 三层架构边界与职责定义 |
| `docs/ADAPTIVE_ONE_API_STACK.md` | 固定路由与提供方协议栈说明 |
| `docs/WINDOWS.md` | Windows 安装、运行态目录与排障说明 |

---

## 六、项目路径搬迁指南（改变项目地址时怎么做）

当您把项目文件夹移动到新路径（例如从 `H:\CodexProject\Anti-Codex\deepcodex` 移到 `D:\NewPath\Anti-Codex`）后，请按以下 **3 步**操作：

### 第 1 步：核心运行脚本已支持动态路径，只需重刷一次 Runtime 同步
生产主链路脚本（`sync-anticodex-runtime.ps1`、`sync-anticodex.ps1`、`install-anticodex.ps1`、`test-anticodex-source-preflight.ps1` 等）均已使用 `$PSScriptRoot` 动态解析源码路径（提交 `cd7419f3` 已清理主脚本硬编码路径）。
但是已安装的运行态清单 `%LOCALAPPDATA%\Anti-Codex\runtime\.anticodex-runtime-manifest.json` 中记录了上一次同步时的 `sourceRoot`。
因此，**移动文件夹后，在新路径下运行以下一条命令即可把运行态 `sourceRoot` 更新到新路径**：

```powershell
cd <你的新项目路径>
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\sync-anticodex-runtime.ps1 -NoRestart
```

### 第 2 步：更新或了解少量测试/旁路探针中的旧路径字面量
如果搬迁后需要修改以下旁路脚本或测试 fixture，请注意这几处仍带有 `G:\Trae-Project` 字符串：
1. **旁路 MCP 探针脚本**（不影响 Anti-Codex 本体运行）：
   - `scripts/probe-anticodex-worker-mcp-servers.mjs`（第 106-108 行）
   - `scripts/test-anticodex-worker-mcp-status-probe.mjs`（第 6-8 行）
   - `scripts/test-anticodex-worker-mcp-task-smoke.mjs`（第 7-9 行）
   - 说明：这 3 个旁路探针借用了 `file:///G:/Trae-Project/mimocode-worker-mcp-main/node_modules/@modelcontextprotocol/sdk/...`。如果搬迁了 `G:\Trae-Project`，且需要跑这 3 个 MCP 探针，只需把它们指向新的 `@modelcontextprotocol/sdk` 路径即可。
2. **静态测试 Fixture 字符串**（纯字符串断言，不访问真实磁盘，无需修改也能通过测试）：
   - `translator/tests/anticodex-gate8-autonomous-video.test.mjs`（第 11、303 行：测试离线证据 JSON 结构的假数据字符串）
   - `translator/tests/ui-chat-marker-evidence.test.mjs`（第 422、442 行：测试越界路径拦截规则的用例字符串）
   - `scripts/test-codexplusplus-antigravity-real-task-matrix.mjs`（第 223 行：用于防止测试任务误改宿主源码仓的正则黑名单，如果换了路径可按需把新路径也加进正则）

### 第 3 步：验证搬迁后全绿
在新路径下执行：
```powershell
# 1. 核对更新与同步状态
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\check-anticodex-update.ps1 -NoPersist

# 2. 跑核心单元测试
node --test translator/tests/brand-patch-compat.test.mjs translator/tests/anticodex-host-icon-packaging.test.mjs translator/tests/shortcut-repair-contract.test.mjs

# 3. 跑安装态快速无流量总检
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\test-anticodex-installed-overall.ps1 -NoTraffic -Fast
```

---

## 七、其他 AI 工具接手指南（可直接复制给新 AI 的提示词）

如果切换到 Cursor、Claude Code、Windsurf、Cline 或新的 Codex 频道接手本项目，直接让它先读本文件 `PROJECT_MASTER_HANDOFF.md` 即可。

### 7.1 必须遵守的 5 条安全红线
1. **严禁破坏官方原版 Codex**：绝不修改、关闭或删除 `C:\Program Files\WindowsApps\OpenAI.Codex_*`、`%USERPROFILE%\.codex` 或正在运行的官方 `ChatGPT.exe` / `codex.exe`。
2. **严禁直接手改安装目录**：所有对 `%LOCALAPPDATA%\Anti-Codex\runtime` 或 `codex-patched-app` 的改动，必须先改源码仓并提交 Git，再走 `scripts/sync-anticodex-runtime.ps1` 和 `Anti-Codex Updater`（或 `scripts/sync-anticodex-launcher.ps1`）事务激活。
3. **保持 Git 工作区干净**：项目的源码门（`test-anticodex-source-preflight.ps1`）和运行时同步（`sync-anticodex-runtime.ps1`）要求源码仓 `git status` 干净且修订号来自真实 Git commit。
4. **ASAR 补丁必须保持字节等长**：修改 `scripts/brand-patched-asar.mjs` 或 `scripts/brand-patch-compat.mjs` 时，所有对 `app.asar` 内 JS/HTML 的替换必须使用 `replacePadded` / `padReplacement` 保持字节长度完全不变，并由脚本自动重算块级完整性哈希。
5. **全量测试并发限制**：运行 `node --test` 全量测试时加上 `--test-concurrency=2`，避免在 Windows 上一次性拉起过多子进程。

### 7.2 常用日常维护命令速查
- **检查官方 Codex 是否有新版本需要同步**：
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\check-anticodex-update.ps1 -NoPersist`
- **修改源码脚本后同步到运行时**：
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\sync-anticodex-runtime.ps1 -NoRestart`
- **当官方 Codex 升级后，重建候选、校验并激活 Anti-Codex**：
  `Start-ScheduledTask -TaskName "Anti-Codex Updater"`
- **当快捷方式或启动计划任务损坏时一键修复**：
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\repair-anticodex-shortcuts.ps1`
- **遇到问题一键回滚到上一版已验证宿主**：
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\rollback-anticodex.ps1`
