# Anti-Codex

Anti-Codex 是一份与原版互不干扰的官方 Codex Desktop 隔离副本（isolated official Codex）。它保留
Codex 原生界面和 harness，只替换模型提供方接入方式，不重写 Codex 的任务控制。

项目基石是 [三层架构](docs/THREE_LAYER_ARCHITECTURE.md)，执行进度和剩余门禁见
[最终迁移计划](docs/FINAL_MIGRATION_PLAN.md)。任何实现都不得在三层之外增加新的
任务控制层。

## 三层结构

1. **官方 Codex 隔离壳**：从当前官方 Codex 安全复制并打最小隔离补丁。Codex
   原生 harness 独占规划、工具（tools）、命令、文件、审批、重试、续跑、上下文压缩
   （compaction）和完成判断。
2. **CodexPlusPlus 通用接入层**：直接使用上游 CodexPlusPlus 处理 Responses/Chat
   协议和普通第三方 API。third-party traffic bypasses Antigravity，第三方 API 直接连接。
3. **Antigravity 薄适配层（thin adapter）**：仅在选择 Antigravity 模型时，把标准 Chat
   Completions 结构映射到本机 Antigravity Desktop Cascade，复用登录、模型和额度。
   它不执行工具、不改写命令，也不判断任务是否完成。

原版 Codex 的安装、账号、任务和本地数据不会被 Anti-Codex 改写；两者可以同时运行，
并保留各自的程序名、任务栏图标、托盘图标和状态目录。

## 功能

- 跟随官方 Codex 更新，通过候选复制、差异审计、验证和回滚点同步原生功能与 UI。
- 保留 Anti-Codex 名称、图标、中文“管理”入口和独立运行状态。
- 使用 Antigravity Desktop 当前账号的真实模型目录与额度。
- 支持普通第三方 Responses 或 Chat API，路由失败时关闭请求，不静默切到错误模型。
- Codex function/custom 工具、MCP、Skills、插件、历史、取消和压缩仍由原生 harness 管理。
- connector-backed app tools 的本地元数据不等于授权；未真正授权时不得伪装成可调用。

## 依赖

1. Windows 版官方 Codex Desktop。
2. Node.js。
3. 使用 Antigravity 模型时，需要已登录的 Antigravity Desktop 及其网络环境。
4. 使用第三方 API 时，需要对应服务的地址、模型名和密钥；该路线不依赖 Antigravity。

## 安装与更新

首次安装双击：

```text
install-windows.bat
```

安装后从桌面或开始菜单打开 `Anti-Codex`。官方 Codex 更新后，使用：

```text
开始菜单 > Anti-Codex > Sync Anti-Codex with Codex
```

同步先构建候选副本并检查官方文件差异，只在门禁通过后激活；失败时保留当前版本和回滚点。

## 模型与 API

- Antigravity 模型：在“管理”中选择当前登录账号实际提供的模型。
- 第三方 API：在“管理”中测试、保存并应用 provider profile。普通第三方流量由
  CodexPlusPlus 直接处理，不经过 Antigravity 适配层。
- 当前产品只使用一个活动 Antigravity 账号，不包含双账号调度机制。

## 本机隔离路径

```text
安装目录：%LOCALAPPDATA%\Anti-Codex
独立状态：%APPDATA%\anticodex
维护报告：%APPDATA%\anticodex\reports
```

源码仍可能保留少量历史兼容命名，但它们不能重新成为运行架构。删除台账见
[LEGACY_REMOVAL_MANIFEST.md](docs/LEGACY_REMOVAL_MANIFEST.md)。
