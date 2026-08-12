# Anti-Codex 1.0 完成清单(唯一有效)

> 本文件是判断 Anti-Codex 是否完成的**唯一**清单,取代已归档的
> `archive/FINAL_100_PERCENT_REVIEW_PLAN.md`、`archive/task_plan.md` 及其全部规则。

## 完成定义(与旧体系的三点不同)

1. **基线冻结。** 验收在一组冻结版本上进行:执行验收轮时的 `deepcodex` main HEAD、
   当时安装的官方 Codex 版本、CodexPlusPlus `v1.2.45`。勾选后**不因上游更新而重开**;
   上游漂移属于日常维护,走 [`MAINTENANCE.md`](MAINTENANCE.md),与"是否完成"无关。
2. **概率性物理现象不阻塞发布。** 偶发、不可稳定复现的单帧白屏等 OS 合成器行为记入
   [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md),不作为验收项。只有**可稳定复现**的
   崩溃/白屏才算缺陷。
3. **自主长任务(旧 Gate 8)不在完成定义内。** 它是模型能力演示,已降级为可选 demo。

**勾选规则:** 每项在冻结基线上有一次可复现的通过证据(一行说明 + 日期 + 必要的报告文件名)即可勾选。
禁止追加任何形式的 `CURRENT OVERRIDE` 段落;发现新缺陷就在对应项下加一行子任务,修好后勾掉。
全部 13 项勾选即宣布 1.0 完成并打 tag `v1.0.0`。

## 验收项(13 项)

### 安装与共存

- [ ] 1. 运行 `install-windows.bat` 完成安装;桌面与开始菜单出现 Anti-Codex 入口,
      安装落点为 `%LOCALAPPDATA%\Anti-Codex`,状态目录为 `%APPDATA%\anticodex`。
- [ ] 2. 双击启动后有且只有一个 Anti-Codex 窗口;原生 Codex 的安装、进程与数据不受影响,
      两者可同时运行且任务栏/托盘图标各自独立。
- [x] 3. 隔离检查:计划任务只有 Anti-Codex Launcher/Updater 两项且参数正确;
      无开发 worker、Docker 容器或 `R:` 盘残留串入产品。

### 模型路由(产品核心)

- [x] 4. Antigravity 路由:在管理页选择当前登录账号的一个 Antigravity 模型,
      发出一次真实对话请求并收到正常回复。
- [ ] 5. 第三方路由:在管理页测试、保存并应用一个第三方 API profile,
      发出一次真实请求并收到正常回复;人为填错密钥时请求失败关闭,不静默切换到其它模型。
- [x] 6. 原生 harness 完整性:跑一个包含工具调用(shell 或 MCP)的任务,
      确认规划、审批、工具执行、上下文压缩、完成判断均由原生 Codex 处理。

### 界面与设置

- [x] 7. 原生 Settings:逐页打开当前版本全部设置页,不出现"糟糕,出错了";
      被隐藏的外部 ChatGPT Account / web Security 项不可见,其余本地项可正常交互。
- [ ] 8. 提示词管理:`管理 → 提示词` 完成一次 写入隔离 `AGENTS.md` → 重开读回 → 恢复默认 的闭环。
- [ ] 9. Manager 按钮:管理页每个可见按钮点击后都有真实终态反馈(成功/失败/进度),
      无"已开始"式假成功,无游离控制台窗口。

### 更新与回滚

- [ ] 10. 更新闭环:`检查更新` 报告官方与 CodexPlusPlus 的源/活动版本;`同步更新`
      走完 候选构建 → 无流量验证 → 激活 → 安装后检查 的一次成功闭环,或在失败时自动回滚且保留原始失败原因。
- [ ] 11. 回滚:从当前版本回滚到上一 revision,回滚后可正常启动且原生 Codex 不受影响。

### 稳定性与源码门

- [ ] 12. 窗口稳定:最小化/任务栏恢复、关闭/重开各若干次,无崩溃、无可稳定复现的空白窗口
      (偶发单帧白屏按 KNOWN_LIMITATIONS 处理,不阻塞)。
- [x] 13. 无流量源码门:在冻结基线提交上完整跑一次 translator 测试套件与源码预检,全绿。

## 验收记录

| 项 | 日期 | 证据 | 结果 |
|---|---|---|---|
| (示例) 4 | 2026-08-xx | 一次 Gemini 对话往返,无错误 | 通过 |
| 3 | 2026-08-13 | `test-anticodex-independence.ps1` 通过;计划任务仅 Launcher/Updater 两项且参数指向安装运行时;无 Anti-Codex/CodexPlusPlus 容器,无 `R:` 盘;官方 Codex 前后 PID/路径一致 | 通过 |
| 4 | 2026-08-13 | 真实桌面鼠标选择 `Claude Sonnet 4.6 (Thinking)` 后收到精确标记回复;报告 `20260812-210158-acceptance-item4-antigravity-model-claude-sonnet-4-6.json`;官方 Codex 进程保持存活 | 通过 |
| 6 | 2026-08-13 | 原生任务完成 4 次 shell 工具调用并生成、校验 3 个文件;原生 `/compact` 产生 `compacted/context_compacted` 后在同一线程续接成功;报告 `20260812-210348-acceptance-item6-native-tool-flow-model-claude-sonnet-4-6.json`、`20260812-211046-compaction-resume.json` | 通过 |
| 7 | 2026-08-13 | 真实鼠标逐页打开当前 16 个可见 Settings 页面,全部无崩溃;12 个隐藏入口均有运行时条件证据,无 ChatGPT/OpenAI 账号入口;个性化测试写入后原样恢复;验收器修正 `d1def33` | 通过 |
| 13 | 2026-08-13 | `ee468d5b75d46cb849106c38d6725b3df6f7ce97`; translator `1009/1009` 通过; `source-preflight` 报告 `C:\Users\XD\AppData\Roaming\anticodex\reports\20260813-041520-source-preflight.json`, `noTraffic=true` | 通过 |
