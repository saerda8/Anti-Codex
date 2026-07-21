# Stage 7：Antigravity Claude 从 Gemini 地区限制处续跑

继续当前原生任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，不得新建任务或第二个窗口。上一条 Stage 7 Antigravity 生产请求已经真实提交给 `gemini-3-flash-agent`，但在任何工具调用前终止为：

`FAILED_PRECONDITION (code 400): User location is not supported for the API use.`

主机已确认 Gemini 没有修改工程文件。现在固定路由已经切为 `claude-sonnet-4-6`。不要重做第三方第一阶段，不要重新下载素材或生成对白；从现有工程继续：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

先验证 `phase1-third-party.done`、现有 7 段素材、3 段对白、MuseTalk 提交和环境报告。把上述 Gemini 地区限制追加到 `failures.md` 和 `provider-ledger.json`，不得覆盖第一阶段记录。

然后完整执行 `2026-07-19-lipsync-stage7-antigravity-production.md` 的生产要求：安装项目内 MuseTalk 依赖和权重，真实生成至少 3 段、合计至少 10 秒的真人中文口型同步镜头，生成连续帧证据，完成 40-60 秒竖屏正式初剪、字幕、媒体 QA、口型生产记录和阶段验收。不得用动画、数字人、静帧或画外音冒充口型同步。开始每组命令前先用一句简短中文说明目的，失败只做一次有实质变化的修复，不要重复启动同一命令。

只有实际文件和全部阶段验收通过后，才写 `phase2-antigravity.done`，内容精确为：

`STAGE7_ANTIGRAVITY_LIPSYNC_OK_20260719`

UTF-8 无 BOM、无回车、无换行。最终回复给出口型段数、可见讲话总时长、初剪路径和实际 QA，最后一行只输出该标记。
