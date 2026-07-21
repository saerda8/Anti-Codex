# Stage 7: Antigravity Stage 3 真人成片精修

继续同一个原生 Anti-Codex 任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，只操作唯一工程目录：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

不得新建任务、不得打开第二个 Anti-Codex 窗口、不得修改 Anti-Codex 产品源码、不得调用九个开发 MCP worker。每组命令前先用一句简短中文说明目的，然后真实执行工具。当前模型必须是 Antigravity `gemini-3.1-pro-low`。不得只写方案、报告或完成声明。

## 只读基线

先从磁盘验证下列事实，任何不符都停止并如实报告：

- `phase2b-third-party.done` 精确为 `STAGE7_THIRD_PARTY_STAGE2B_MEDIA_OK_20260720`；
- `stage2b-third-party-cut.mp4` 可完整解码，SHA-256 为 `573eb67b484a7c815399094267064b8eba192bcfc0173e2f3c9a40cdb66082d8`；
- 时长 52.304 秒，1080x1920，H.264/yuv420p，AAC 48 kHz，综合响度 -17.02 LUFS，真峰值 -1.50 dBTP；
- 三段 `shots/lipsync-*.mp4` 仍存在且可解码；不得重新运行 MuseTalk，不得下载模型或素材；
- 读取 Stage 2B 构建脚本、字幕、媒体/视觉 QA、生产记录和 `provider-ledger.json`。

Stage 2A 和第三方 Stage 2B 全部是受保护基线。除只向 `provider-ledger.json` 末尾追加一条记录外，不得修改、删除、覆盖或重命名既有文件。

## 必须完成的真实贡献

1. 新建 `build-stage3-antigravity.mjs`、`captions-stage3-antigravity.ass`，实际生成 `stage3-antigravity-cut.mp4`。必须从现有真人源素材和三段口型镜头重新组合，不得复制、重封装或仅改元数据。
2. 保留三段完整真人口型及原音同步，开头两秒内出现真人讲话钩子；全片 40-60 秒，至少 12 个有意义剪辑段，顺序形成问题、步骤、专家回答、结果、行动提示闭环。
3. 做可观察的 Antigravity 精修贡献：至少包含节奏重排、克制的画面色彩/对比统一、三处不遮脸的步骤或重点提示，以及一处明确的行动提示。提示必须位于安全区，不能遮挡眼睛、嘴和产品动作。
4. 保留并改进至少三类独立声音层。对白窗口必须自动压低音乐、环境和拟音；转场提示音与动作拟音不得压住台词。生产记录要写明每层来源和可重复生成方式。
5. 字幕区分对白与说明，无前导逗号、越界、重叠或超时；保持竖屏安全边距，不遮挡眼口和关键动作。
6. 输出为 1080x1920、H.264、yuv420p、AAC 48 kHz；完整解码通过，无非剧情黑场，最长非剧情静音小于 1.5 秒，综合响度 -18 至 -14 LUFS，真峰值不高于 -1 dBTP。
7. 从 Stage 3 成片本身生成 `qa/stage3-antigravity-contact-sheet.png` 和 `qa/stage3-antigravity-motion-strip.png`，后者覆盖一段真实讲话窗口。不得从输入素材抽帧冒充。
8. 从真实命令结果生成 `stage3-antigravity-media-qa.json`、`stage3-antigravity-visual-qa.md`、`antigravity-stage3.json` 和 `check-stage3-antigravity.mjs`；实际运行构建、完整解码和验收，失败先修复再重跑。
9. 只向 `provider-ledger.json` 末尾追加一条本次 Antigravity 记录，包含模型、开始/结束时间、真实工具和文件、输入/输出哈希、失败与修复。保留全部历史记录。

只有全部检查通过后，才新建 `phase3-antigravity.done`，内容必须精确为：

`STAGE7_ANTIGRAVITY_STAGE3_MEDIA_OK_20260720`

UTF-8 无 BOM、无回车、无换行。最终回复简要列出新成片、时长、三段口型窗口、Antigravity 的具体精修、声音层、媒体检查和新旧哈希，最后一行只输出该标记。
