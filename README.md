# Anti-Codex

Anti-Codex 是一份独立运行的 Codex Desktop 副本。界面和主要工作流沿用 Codex，模型请求使用当前 Antigravity 权益提供的模型文本，不需要 ChatGPT 登录，也不使用 DeepSeek API Key。

项目的唯一架构基线是 [`docs/PRODUCT_ARCHITECTURE.md`](docs/PRODUCT_ARCHITECTURE.md)，当前代码的完成/改进/删除/未完成台账是 [`docs/CURRENT_IMPLEMENTATION_AUDIT.md`](docs/CURRENT_IMPLEMENTATION_AUDIT.md)。CC Switch 协议移植来源见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。后续实现、测试和完成度判断都必须以这两份项目文档和最新真实任务结果为准。

客户端维护原则很简单：Codex 更新后，Anti-Codex 通过受保护的客户端同步跟进，再重新套用 Anti-Codex 的品牌、隔离、启动器和模型接入补丁；这不是把 Codex 功能一个一个重做出来。换句话说，这是 client-copy sync，不是 feature-by-feature rebuild。

它不会修改原生 Codex。两者有独立的程序、任务栏名称、运行状态和本地数据，可以同时运行。

## 已确认保留的基础

- 独立的 `Anti-Codex.exe`、桌面入口、任务栏名称和窗口名称
- 自动读取当前 Antigravity 权益可用的精确模型名称与推理档位
- 已有模型目录、切换、取消、历史和上下文压缩基础；新纯协议主路径仍在迁移
- 可同步 Codex function/custom/MCP/Skills 工具定义；网关级真实简单工具闭环已通过，Codex Desktop 宿主闭环仍待验收
- 支持中文跟随、网页搜索与网页读取
- 独立保存 Anti-Codex 状态，不改写原生 Codex 配置
- 检测原生 Codex 更新，并通过安全候选、兼容检查、回滚点完成同步
- 提供账号/代理、模型、界面、同步、诊断和整体稳定性检查

当前不能宣称真实项目可用：CC Switch 协议等价移植仍不完整，真正增量流式、历史恢复、Codex Desktop 简单任务和长任务验收仍未完成。新纯协议路径已同步到当前运行时并通过一次真实 Antigravity 网关级工具闭环；这不等于桌面产品已经可用。准确进度和删除清单以实现审计为准。

当前安装快照已对齐：Gateway 运行时健康，Anti-Codex 桌面壳与本机官方 Codex 都是 `26.707.8168.0`。同步经过候选构建和校验后激活，旧版 `26.707.3748.0` 仍可回滚；中文“管理”、Anti-Codex 图标和关闭按钮全区域均已在新版实机通过。

## 依赖

1. Windows 版官方 Codex Desktop
2. Antigravity CLI 或 Desktop，已登录可用账号（用于获取模型权益文本）
3. Antigravity 访问 Google 服务所需的代理

当前文本传输默认走 Antigravity CLI；模型目录和账号发现仍可使用 Antigravity Desktop 兼容层。目标方向是以 Antigravity CLI/权益模型能力为主；Desktop/coworker 不作为默认工作路径，仅作为当前兼容层。

## 安装

首次安装双击：

```text
install-windows.bat
```

安装完成后，桌面只保留一个 `Anti-Codex` 快捷方式。维护入口位于开始菜单的 `Anti-Codex` 文件夹。

已安装后不要再次运行完整安装。需要跟随原生 Codex 更新时，使用：

```text
开始菜单 > Anti-Codex > Sync Anti-Codex with Codex
```

同步会先构建并验证候选版本，保留上一版回滚点，失败时不会替换当前可用版本。

## 账号切换

打开：

```text
开始菜单 > Anti-Codex > Manage Anti-Codex > Switch Antigravity Account
```

在 Antigravity Desktop 中切换账号后，回到切换窗口继续。Anti-Codex 会重新读取账号指纹与模型列表，并执行安装状态检查。第一版允许切换账号时关闭并重新打开 Anti-Codex。

## 模型

模型菜单来自当前 Antigravity 权益实际返回的可用模型。Anti-Codex 不伪造模型，也不会把推理档位冒充成模型名。当前机器已验证八个模型，包括精确数字版本与推理档位。

## Skills、MCP 与插件

- Skills、MCP 配置和插件缓存会复制到 Anti-Codex 的独立状态目录。
- Codex 工具、MCP、Skills 和本地插件能力由 Anti-Codex/Codex 侧承接；Antigravity 只提供模型文本。
- 远程 ChatGPT 插件市场和需要 ChatGPT 账号授权的连接器保持关闭。

## 已知边界

- Responses 模型 WebSocket 当前明确回退为 HTTP/SSE；不会伪装成已支持。
- 需要 ChatGPT 授权的远程连接器不可用。
- Antigravity Desktop 账号切换和外部代理开关仍需要用户在对应界面操作。
- 原生 Codex 更新后若内部结构改变，同步会在兼容检查失败时保留当前 Anti-Codex，不会强行激活。

## 本机路径

```text
安装目录：%LOCALAPPDATA%\Anti-Codex
独立状态：%APPDATA%\anticodex
维护报告：%APPDATA%\anticodex\reports
```

本项目是在 `deepcodex` 基础上改造的，因此源码内仍保留部分历史文件名；默认安装入口和运行产品均为 Anti-Codex。

## 第三方 API 配置

默认路线是 Antigravity 权益提供模型文本、Codex 工具留在 Anti-Codex 侧。需要使用第三方 API 时，正式入口是 Anti-Codex Manager：先测试，再保存并应用 upstream profile；底层脚本只用于受控写入和重启。旧配置读取失败时不会静默切回错误上游，也不需要 ChatGPT 登录。

## Connector 授权边界

Anti-Codex 会把本机 MCP、skills、插件元数据和 connector 元数据同步到自己的独立状态里，但元数据不是授权。未授权的 connector-backed app tools 必须继续显示为不可调用，不能因为本地缓存存在就伪装成已授权。
