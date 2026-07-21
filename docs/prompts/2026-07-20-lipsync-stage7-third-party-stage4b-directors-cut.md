# Stage 7：第三方 Stage 4B 真人导演剪辑版

继续同一个原生 Anti-Codex 任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，只操作唯一工程目录：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

不得新建任务、不得打开第二个 Anti-Codex 窗口、不得修改 Anti-Codex 产品源码、不得调用九个开发 MCP worker。开始每组命令前先用一句简短中文说明目的。必须真实调用 Codex 工具、检查现有成片、修改剪辑工程、重新渲染并运行验收；只写方案、口头评价或重复已有 Stage 4A 不算完成。

## 当前事实与边界

- `stage4a-third-party-master.mp4` 已通过独立主机验收：52.304 秒、1080x1920、三段真人口型窗口合计 25.304 秒，视频 SHA-256 为 `6ce9980c10f68b61de0445ded27d39b2417796211d45d62b6f934e98ee96b915`。
- Stage 2A、Stage 2B、Stage 4A、全部原始口型素材及其完成标记均为只读基线；不得覆盖、删除、改名或伪造。
- Antigravity 当前外部模型不可用：Gemini 返回地区限制，GPT-OSS 返回 429。不得把这些失败写成 Antigravity 成功贡献。本阶段只是继续推进真实成片质量，最终三段提供方验收仍须等待 Antigravity 真实贡献。
- 不下载新模型或大体积素材，不制造可再生成的缓存副本；优先复用现有真人动态素材、口型素材、音频与 Stage 4A 工程。

## 必须完成的实物

1. 先实际运行 `check-stage4a-third-party.mjs`，核对 Stage 4A 成片和三段口型证据；任一基线不符就停止，不能自行覆盖基线。
2. 对 Stage 4A 做逐段导演审片，明确找出至少三项可观察的改善点，重点检查：前两秒钩子、真人表演连续性、口型自然度、镜头重复、字幕遮脸、产品动作、声音层次和行动提示。结论必须基于最终视频抽帧、连续帧和音轨检查，不能凭文字猜测。
3. 新建 `build-stage4b-third-party.mjs` 和必要的 Stage 4B 字幕源，只在新文件中调整剪辑节奏、镜头顺序、字幕和混音；不得复制一份未改动的 Stage 4A 冒充新成果。
4. 输出 `stage4b-third-party-directors-cut.mp4`：45-55 秒、1080x1920、H.264/yuv420p、AAC 48 kHz。前 2 秒出现清晰真人说话钩子，全片至少 12 个有意义剪辑段，并形成问题、演示、真人回答、结果和行动提示闭环。
5. 保留至少 3 个真人可见讲话窗口，总时长至少 10 秒；逐句核对人物、台词、最终起止时间、对应音频和连续脸部帧。任何嘴不动、错人、明显音画提前/滞后、跳脸或严重伪影必须修复。
6. 保留音乐、环境、转场/动作拟音至少三类声音层；对白时自动压低其他声音。综合响度目标 -18 至 -14 LUFS，真峰值不高于 -1 dBTP，最长非剧情静音小于 1.5 秒。
7. 字幕不得遮挡眼睛、嘴和关键产品动作；至少三处克制的步骤提示和一处明确行动提示。不得用大块图形、PPT 页面或动画代替真人画面。
8. 必须从 Stage 4B 成片本身生成：
   - `qa/stage4b-third-party-contact-sheet.png`
   - `qa/stage4b-third-party-motion-strip.png`，至少 16 个连续真人讲话帧
   - 每个口型窗口一张 `qa/stage4b-lipsync-*-strip.png`
   不得从输入素材抽帧冒充成片证据。
9. 从真实检查结果生成：
   - `check-stage4b-third-party.mjs`
   - `stage4b-third-party-media-qa.json`
   - `stage4b-third-party-lipsync-qa.json`
   - `stage4b-third-party-visual-qa.md`
   - `third-party-stage4b.json`
   - `stage4b-build-log.md`
   - `stage4b-captions.srt`
   - `stage4b-comparison.md`
   比较报告必须列出 Stage 4A 与 Stage 4B 的实际差异和可复核证据，不能只写“更好”。
10. 实际运行构建、完整解码、ffprobe、黑场、静音、响度、真峰值、字幕边界、连续帧、文件存在性和哈希检查。失败必须修复后重跑。只向 `provider-ledger.json` 末尾追加一条准确的 Stage 4B 第三方记录，不改写已有记录。

## 完成标记

只有全部检查通过后，才创建 `phase4b-third-party.done`，内容必须精确为：

`STAGE7_THIRD_PARTY_STAGE4B_DIRECTORS_CUT_OK_20260720`

UTF-8 无 BOM、无回车、无换行。最终回复简要列出新成片、真实改善项、时长、口型窗口、媒体 QA、视频 SHA-256，并明确说明“仍待 Antigravity 真实贡献后才能最终验收”。最后一行只输出该标记。
