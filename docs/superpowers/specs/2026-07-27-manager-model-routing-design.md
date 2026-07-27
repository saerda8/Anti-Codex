# Anti-Codex 管理页与模型切换设计

## 目标

管理页只负责状态、账号、第三方 API 配置、更新和故障排查。聊天输入框右下角的原生模型菜单是唯一模型切换入口。选择 Gemini 或 Claude 就使用常驻 Antigravity relay；选择第三方模型就使用已保存的第三方 relay。不存在“恢复 Antigravity”操作。

三段式架构保持不变：官方 Codex 隔离壳仍是唯一任务控制者，CodexPlusPlus 仍是唯一翻译/relay 层，Antigravity 仍是薄 Chat 适配。不得新增任务控制器、模型切换守护进程或第四层路由。

## 模型路由

- Antigravity 与第三方 relay 同时常驻 CodexPlusPlus 设置。
- 统一模型目录同时暴露 Gemini、Claude 和已配置第三方 API 返回的全部可用模型。
- 原生模型菜单选择的模型 slug 随当前 Codex 请求传入 CodexPlusPlus。
- 现有 CodexPlusPlus 补丁 `0004-route-anticodex-model-slots.patch` 按请求模型选择 resident relay：Gemini/Claude 进入 Antigravity，`anticodex/third-party/*` 进入第三方 API。
- 明确指向某个 provider 的请求失败时必须原样报错，禁止静默改用另一 provider。
- 未明确或未知模型的内部 fallback 固定为 Antigravity；第三方配置保存不得改变该 fallback。

## 第三方 API 配置

“配置第三方 API”页面只做以下事情：

1. 输入协议、地址、主测试模型、上下文窗口和 API key。
2. “测试连接”验证地址、凭据、模型调用兼容性，并读取 provider 模型目录。
3. “保存配置”原子保存第三方 profile、可用模型和上下文信息，并刷新统一模型目录。

保存成功后只提示“配置已保存，可在聊天输入框的模型菜单选择第三方模型”。它不得：

- 切换当前任务模型；
- 修改 CodexPlusPlus `activeRelayId`；
- 改写原生 Codex 根级上下文窗口配置；
- 调用原生模型选择或任务重载；
- 重启 Anti-Codex、CodexPlusPlus、Antigravity 或当前任务。

删除第三方配置页中的 Antigravity 模型下拉框、“恢复 Antigravity”和“保存并切换”。保存按钮名称固定为“保存配置”。连接或保存失败时保留旧配置并显示明确失败阶段与建议。

## 管理页信息架构

默认页面只显示四个普通用户区域：

1. **当前状态**：Anti-Codex、原生 Codex、CodexPlusPlus、Antigravity 账号和模型目录状态；自动刷新，保留一个手动刷新入口。
2. **账号与模型来源**：切换 Antigravity 账号、配置第三方 API。这里不提供模型切换按钮。
3. **Codex 更新**：检查更新、同步 Codex 更新。检查结果必须显示官方版本、当前 Anti-Codex 版本和是否需要更新；同步必须显示阶段、进度、成功或可操作失败，且不得弹出无说明 Node.js 窗口。
4. **故障排查**：修复快捷方式、生成诊断包、查看最新报告。

开发和发布验收操作统一放入默认折叠的“高级诊断”：账号/代理检查、安装/同步检查、源码预检、MCP/Skill 检查、插件/应用检查、刷新本地功能、快速/整体无流量检查、稳定性流量巡检、冷启动验证和验证后完整检查。现有能力保留，但不再与日常功能并列。

高影响操作继续要求二次确认；后台运行操作必须防重复提交。每个按钮都必须在原页面显示运行中、最终结果和完成时间。

## 数据与失败处理

- 第三方 key 继续存放在 Anti-Codex 隔离状态中，不进入仓库、报告或界面明文。
- 配置写入继续使用现有原子快照/回滚机制，但不再包含模型切换和原生上下文重载。
- 统一目录刷新失败时回滚第三方 profile 和目录，不影响当前任务或 Antigravity relay。
- 更新失败继续 fail-closed：候选未通过不得替换活动壳，原生 Codex 不得被关闭或改动。

## 验收

- 离线合同证明第三方保存不改变当前模型、`activeRelayId`、根级上下文配置或进程身份。
- provider 返回的全部模型出现在统一模型目录，第三方模型带独立命名空间和配置的上下文窗口。
- Gemini、Claude、第三方三个模型只通过聊天输入框模型菜单往返切换，任务 ID、cwd、历史和进程均不变。
- 管理页不存在“恢复 Antigravity”“保存并切换”或 Antigravity 模型下拉框。
- 管理页四个默认区域与折叠高级诊断均通过真实点击；每项显示明确状态和结果。
- 用户操作电脑时不运行抢焦点的真实鼠标验收；需要点击时先通知用户，待用户腾出窗口后执行。

## 非目标

- 不重写 CodexPlusPlus，不新增 provider router。
- 不改变 Gemini、Claude、第三方的额度优先级。
- 不把开发 MCP worker 注入 Anti-Codex。
- 不在本次修改中处理最终视频内容质量；产品修复通过后，原长任务仍只接收逐字“继续”。
