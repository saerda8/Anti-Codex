# Stage 7：第三方 Stage 4B 在 413 修复后原地续跑

继续当前同一个原生 Anti-Codex 任务和同一个工程目录：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

上一轮在你已经生成并实际查看 Stage 4B 成片及 5 张 QA 图片后，翻译层因 32 MiB 请求体上限返回 413。该上限现已修复为有界 128 MiB。已有文件都是真实成果，必须从当前状态继续，不得从头重建、不得新建任务、不得打开第二个客户端、不得调用九个开发 MCP worker。

开始命令前先用一句简短中文说明目的。先检查现有 `stage4b-third-party-directors-cut.mp4`、`build-stage4b-third-party.mjs`、`captions-stage4b-third-party.ass`、`check-stage4b-third-party.mjs` 和现有 5 张 Stage 4B QA 图片。除非检查失败并且确实需要修复，不要再次打开或重复生成已查看的图片。

现在完成原 Stage 4B 指令中尚未收尾的工作：

1. 实际运行 `check-stage4b-third-party.mjs`、完整解码、ffprobe、黑场、静音、响度、真峰值、字幕边界、连续帧、文件存在性和哈希检查；失败时只修复对应 Stage 4B 文件并重跑。
2. 确保这些真实检查产物存在且内容来自当前 Stage 4B 成片：`stage4b-third-party-media-qa.json`、`stage4b-third-party-lipsync-qa.json`、`stage4b-third-party-visual-qa.md`、`third-party-stage4b.json`、`stage4b-build-log.md`、`stage4b-captions.srt`、`stage4b-comparison.md`。
3. 核对 Stage 4B 是 45-55 秒、1080x1920、H.264/yuv420p、AAC 48 kHz，至少 12 个有意义剪辑段、至少 3 个真人讲话窗口且合计至少 10 秒，响度 -18 至 -14 LUFS、真峰值不高于 -1 dBTP。
4. `provider-ledger.json` 若尚无本次 Stage 4B 第三方记录，只追加一条准确记录；若已存在则不得重复追加。
5. 只有全部检查通过后，创建 `phase4b-third-party.done`，原始字节必须精确为 `STAGE7_THIRD_PARTY_STAGE4B_DIRECTORS_CUT_OK_20260720`，UTF-8 无 BOM、无回车、无换行。

最终回复简要列出成片、实际改善项、时长、口型窗口、媒体 QA、视频 SHA-256，并明确说明仍待 Antigravity Gemini 真实贡献后才能最终验收。最后一行只输出：

`STAGE7_THIRD_PARTY_STAGE4B_DIRECTORS_CUT_OK_20260720`
