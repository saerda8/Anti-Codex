# Stage 7：Antigravity Gemini Stage 4C 真人媒体贡献

继续当前同一个原生 Anti-Codex 任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，只操作唯一工程目录：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

不得新建任务、不得打开第二个 Anti-Codex 窗口、不得修改 Anti-Codex 产品源码、不得调用九个开发 MCP worker。开始每组命令前先用一句简短中文说明目的。你必须真实调用 Codex 工具并产出新的媒体文件；只写评论、方案或复述第三方结果不算完成。

## 已通过基线

- `stage4b-third-party-directors-cut.mp4` 已通过第三方 Stage 4B 验收：50.342 秒、1080x1920、H.264/yuv420p、AAC 48 kHz、13 个剪辑段、三段真人说话窗口合计 25.304 秒、-17.03 LUFS、-1.50 dBTP。
- Stage 4B 视频 SHA-256：`2c59b39cc3004468d1b7c28e76a5e27bc3c640721d7f702066511e47f5363f0f`。
- Stage 4A、Stage 4B、原始口型素材、现有 QA 和完成标记都是只读基线；不得覆盖、删除、改名或伪造。
- 本阶段必须记录当前实际 Gemini 模型，不能把第三方模型的工作冒充为 Gemini 贡献。

## 必须完成的真实贡献

1. 先运行 `check-stage4b-third-party.mjs`，确认基线仍通过；不通过就停止，不得覆盖基线。
2. 实际审看 Stage 4B 联系表、三段口型连续帧和必要的视频抽帧，找出至少三项可观察、可落实的改进；不得只凭已有文字报告猜测。
3. 新建 `build-stage4c-gemini.mjs` 及必要的新字幕源。以 Stage 4B 和现有真人素材为输入，真实重做至少一段 4-8 秒的真人行动提示或结果段，并在完整时间线上形成至少三处可复核变化，例如镜头起止、字幕时机、真人反应镜头、产品动作或声音层次。不得直接复制 Stage 4B 后改文件名。
4. 输出完整新成片 `stage4c-antigravity-gemini-collab.mp4`：45-55 秒、1080x1920、H.264/yuv420p、AAC 48 kHz；前 2 秒仍有真人说话钩子；至少 12 个有意义剪辑段；至少 3 个真人讲话窗口且合计不少于 10 秒；问题、演示、真人回答、结果、行动提示闭环完整。
5. 保留音乐、环境、转场或动作拟音至少三类声音层，对白时压低其他声音。综合响度 -18 至 -14 LUFS，真峰值不高于 -1 dBTP，最长非剧情静音小于 1.5 秒。
6. 从 Stage 4C 新成片本身生成 `qa/stage4c-gemini-contact-sheet.png`、`qa/stage4c-gemini-motion-strip.png` 和 `qa/stage4c-gemini-cta-strip.png`；不得从输入素材抽帧冒充新成片证据。
7. 新建并实际运行 `check-stage4c-gemini.mjs`，完成完整解码、ffprobe、黑场、静音、响度、真峰值、字幕边界、连续帧、文件存在性和哈希检查。失败必须修复后重跑。
8. 从真实结果生成：
   - `stage4c-gemini-media-qa.json`
   - `stage4c-gemini-visual-qa.md`
   - `stage4c-gemini-comparison.md`
   - `stage4c-gemini-build-log.md`
   - `antigravity-gemini-stage4c.json`
   - `stage4c-gemini-captions.srt`
   对比报告必须列出 Stage 4B 与 Stage 4C 的实际差异、时间点和证据。
9. 只向 `provider-ledger.json` 末尾追加一条准确的 Antigravity Gemini Stage 4C 记录，不改写或重复已有记录。

## 完成标记

只有全部检查通过后，才创建 `phase4c-antigravity-gemini.done`，内容必须精确为：

`STAGE7_ANTIGRAVITY_GEMINI_STAGE4C_MEDIA_OK_20260720`

UTF-8 无 BOM、无回车、无换行。最终回复简要列出实际 Gemini 模型、新成片、三项真实变化、时长、真人讲话窗口、媒体 QA 和视频 SHA-256。最后一行只输出该标记。
