# Anti-Codex

**中文说明** | **[English Documentation (README_EN.md)](README_EN.md)**

Anti-Codex 是一份与原版互不干扰的官方 Codex Desktop 隔离副本（isolated official Codex）。它完整保留官方 Codex 的原生界面、交互体验与底层代理引擎（harness），仅替换模型提供方（Provider）接入层，让你在不触碰原版官方客户端任何文件、登录态和本地数据的前提下，自由使用第三方 API 或复用本机 Antigravity Desktop 的模型与额度。

---

## 一、项目目的（Why Anti-Codex）

1. **零侵入、双开共存**：原版官方 Codex Desktop 默认绑定官方账号体系。Anti-Codex 通过受控复制与最小隔离补丁生成独立的 `Anti-Codex.exe`、粉色专属图标与独立数据目录，与原版 Codex 可同时打开、互不干扰。
2. **保留 100% 原生代理能力**：不重写、不篡改 Codex 的核心任务循环。任务规划、工具调用（tools）、终端命令、文件读写、权限审批、错误重试、断点续跑、上下文压缩（compaction）与完成判断全部由官方原生 Codex harness 独占负责。
3. **灵活接入多模型来源**：既可以直接连接标准第三方 Responses / Chat Completions API，也可以通过极薄适配层复用本机已登录 Antigravity Desktop 的模型目录与额度。
4. **可验证、可回滚的跟随升级**：每当官方桌面端自动更新后，Anti-Codex 先在隔离候选目录完成复制、补丁应用、完整性哈希重签与门禁校验，全部通过后才原子切换激活，并自动保留上一版回滚点。

---

## 二、核心架构（三层锁定设计）

项目基石是 [三层架构](docs/THREE_LAYER_ARCHITECTURE.md)（详见 [自适应协议栈说明](docs/ADAPTIVE_ONE_API_STACK.md)）。任何实现均不在三层之外增加第四层任务控制器：

1. **第一层：官方 Codex 隔离壳（Isolated Official Codex Shell）**
   - 从本机已安装的官方 Codex 安全复制并打最小隔离补丁（品牌名、独立 AppUserModelId、粉色任务栏/托盘图标、独立配置桥接与中文“管理”入口）。
   - 原生 Codex 独占规划、tools、命令执行、审批、重试、compaction 与完成判断。
2. **第二层：CodexPlusPlus 通用接入层（General Provider Layer）**
   - 采用上游开源组件 `CodexPlusPlus`（固定已验证版本与隔离补丁清单）统一处理 Responses / Chat 协议转换与普通第三方 API 连接。
   - **第三方直连绕过适配层**：ordinary third-party traffic bypasses Antigravity，直接由 CodexPlusPlus 发往目标 API 服务，不依赖 Antigravity。
3. **第三层：Antigravity 薄适配层（Thin Antigravity Adapter）**
   - 仅当用户在模型菜单中选择 Antigravity 模型时启用，作为极薄适配层（thin adapter）将标准 Chat Completions 请求映射到本机 Antigravity Desktop 的 Cascade 接口，复用其登录态、模型列表和额度。
   - 该层只负责模型推理消息收发，不接管工具执行、不改写命令，也不判断任务是否完成。

> **安全与授权边界**：原版 Codex 的安装目录、账号令牌、历史会话与本地配置不会被改写；对于 connector-backed app tools，本地复制的元数据不代表已获授权，未完成真实授权前保持不可调用，绝不伪造授权状态。

---

## 三、环境要求

1. **操作系统**：Windows 10 / 11（x64），已安装官方 **Codex Desktop**（Microsoft Store / WindowsApps 版本）。
2. **运行环境**：已安装 **Node.js**（确保 `node.exe` 在系统 `PATH` 中可用）及 Windows PowerShell 5.1。
3. **模型接入条件（二选一或同时配置）**：
   - **使用普通第三方 API**：准备对应服务商的 API Base URL、模型名称与 API Key（无需安装 Antigravity）。
   - **使用 Antigravity 模型**：本机已安装并登录 **Antigravity Desktop**，且网络环境可正常访问其服务。

---

## 四、安装与使用方法

### 1. 首次安装

克隆或下载本仓库后，在仓库根目录直接双击运行：

```text
install-windows.bat
```

（或在 PowerShell 中执行 `powershell -ExecutionPolicy Bypass -File .\scripts\install-anticodex.ps1`）

安装脚本会自动完成：
- 从本机官方 Codex 构建并校验隔离副本；
- 部署已验证的 `CodexPlusPlus` 组件与本地管理服务；
- 在桌面创建 `Anti-Codex` 快捷方式，并在开始菜单创建 `Anti-Codex` 程序组。

### 2. 日常启动

直接双击桌面的 **Anti-Codex** 图标，或从 `开始菜单 > Anti-Codex > Anti-Codex` 启动。
- 启动器会自动拉起本地固定路由守护进程与独立客户端窗口；若窗口已在运行，再次点击快捷方式会直接唤醒并聚焦现有窗口，不会重复多开。

### 3. 切换模型与配置第三方 API

打开 Anti-Codex 后：
- **打开管理面板**：点击左下角个人菜单中的中文 **“管理”** 按钮（或从 `开始菜单 > Anti-Codex > Manage Anti-Codex` 打开）。
- **使用 Antigravity 模型**：保持本机 Antigravity Desktop 已登录，在“管理”面板刷新状态/模型后，直接在聊天输入框下方的原生模型选择器中切换所需模型与思考档位。
- **使用普通第三方 API**：在“管理”面板填写第三方服务的接口地址、API Key 和模型信息，点击测试并保存配置；普通第三方请求由 `CodexPlusPlus` 直接转发，完全不经过 Antigravity。
- **故障保护原则**：当上游路由或配置不匹配时，请求会明确报错关闭（fail-closed），绝不静默切换到错误模型。

### 4. 跟随官方 Codex 更新同步

当本机官方 Codex Desktop 自动升级到新版本后，无需重装，直接点击：

```text
开始菜单 > Anti-Codex > Sync Anti-Codex with Codex
```

（也可在“管理”面板中点击同步更新按钮）

同步流程会先在候选目录完成复制、补丁应用、ASAR 完整性重签和无流量校验，只有全部检查通过才会替换活动版本；若上游结构变化导致任一门禁未过，当前可用版本与回滚点均保持原样不受影响。

### 5. 一键回滚

如果升级后希望退回上一版已验证的宿主版本，点击：

```text
开始菜单 > Anti-Codex > Rollback Anti-Codex
```

即可原子切回上一版备份宿主。

---

## 五、开发者命令与自检说明

从源码直接启动或排障时，可在仓库根目录使用以下命令：

```powershell
# 检查官方 Codex 是否有新版本待同步（只读不改状态）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-anticodex-update.ps1 -NoPersist

# 修复桌面与开始菜单快捷方式及后台计划任务
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\repair-anticodex-shortcuts.ps1

# 运行安装态快速无流量总检（不消耗模型额度）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-anticodex-installed-overall.ps1 -NoTraffic -Fast

# 运行单元测试（建议限制并发为 2）
node --test --test-concurrency=2 translator/tests/*.test.mjs
```

---

## 六、本机隔离目录与项目文档索引

### 本机运行与状态目录（与官方 `%USERPROFILE%\.codex` 完全隔离）

```text
安装与宿主副本：%LOCALAPPDATA%\Anti-Codex
独立配置与状态：%APPDATA%\anticodex
诊断与验收报告：%APPDATA%\anticodex\reports
```

### 仓库文档导航

- **English README**：[README_EN.md](README_EN.md)
- **Windows 详细安装与运行说明**：[docs/WINDOWS.md](docs/WINDOWS.md)
- **三层架构定义**：[docs/THREE_LAYER_ARCHITECTURE.md](docs/THREE_LAYER_ARCHITECTURE.md)
- **协议栈与路由边界**：[docs/ADAPTIVE_ONE_API_STACK.md](docs/ADAPTIVE_ONE_API_STACK.md)
- **1.0 验收完成清单**：[COMPLETION_CHECKLIST.md](COMPLETION_CHECKLIST.md)
- **上游日常维护流程**：[MAINTENANCE.md](MAINTENANCE.md)
- **已知限制说明**：[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)
- **历史兼容命名清理台账**：[docs/LEGACY_REMOVAL_MANIFEST.md](docs/LEGACY_REMOVAL_MANIFEST.md)
- **开源许可与第三方声明**：[LICENSE](LICENSE) / [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

---

## English Summary

**Anti-Codex** is a guarded, isolated copy of the official Codex Desktop app for Windows. It preserves the native Codex UI, agent loop, tools, approvals, retries, and compaction while swapping only the model provider layer:
- **Ordinary third-party APIs** are handled directly by `CodexPlusPlus` (Responses / Chat Completions) and bypass Antigravity completely.
- **Antigravity models** use a thin Chat Completions-to-Cascade adapter that reuses your local signed-in Antigravity Desktop account and quota without taking over task control.
- **Quick Start**: Double-click `install-windows.bat` to install, launch `Anti-Codex` from Desktop/Start Menu, configure models or API profiles via the in-app `管理` (Manage) entry, and use `Sync Anti-Codex with Codex` whenever the official Codex Desktop updates.

For full English documentation, see **[README_EN.md](README_EN.md)**.
