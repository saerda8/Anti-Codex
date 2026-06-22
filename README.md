# Anti-Codex

Anti-Codex 是一份独立运行的 Codex Desktop 副本。界面和主要工作流沿用 Codex，模型请求使用当前已登录的 Antigravity Desktop 账号，不需要 ChatGPT 登录，也不使用 DeepSeek API Key。

它不会修改原生 Codex。两者有独立的程序、任务栏名称、运行状态和本地数据，可以同时运行。

## 当前能力

- 独立的 `Anti-Codex.exe`、桌面入口、任务栏名称和窗口名称
- 自动读取 Antigravity Desktop 当前账号可用的精确模型名称与推理档位
- 支持模型切换、流式回复、取消任务、长上下文和上下文压缩恢复
- 支持 Codex function/custom 工具、原生 MCP 同一会话续接、Skills 和本地插件快照
- 支持中文跟随、网页搜索与网页读取
- 独立保存 Anti-Codex 状态，不改写原生 Codex 配置
- 检测原生 Codex 更新，并通过安全候选、兼容检查、回滚点完成同步
- 提供账号/代理、模型、界面、同步、诊断和整体稳定性检查

## 依赖

1. Windows 版官方 Codex Desktop
2. Antigravity Desktop，并已登录可用账号
3. Antigravity 访问 Google 服务所需的代理

Anti-Codex 到本机 Antigravity Desktop 的通信不走代理；Antigravity Desktop 访问外部模型服务时使用它自己的网络设置。

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

模型菜单来自 Antigravity Desktop 当前账号实际返回的可用模型。Anti-Codex 不伪造模型，也不会把推理档位冒充成模型名。当前机器已验证八个模型，包括精确数字版本与推理档位。

## Skills、MCP 与插件

- Skills、MCP 配置和插件缓存会复制到 Anti-Codex 的独立状态目录。
- Codex 工具定义通过本地原生 MCP 通道交给 Antigravity，工具结果在同一会话中继续。
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
