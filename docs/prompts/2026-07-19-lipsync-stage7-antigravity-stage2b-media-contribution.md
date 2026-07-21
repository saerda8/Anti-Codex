# Stage 7: Antigravity 实际重剪与声音设计

继续同一个原生 Anti-Codex 任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，只操作唯一工程目录：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

不得新建任务、不得打开第二个 Anti-Codex 窗口、不得修改 Anti-Codex 产品源码、不得调用九个开发 MCP worker。开始每组命令前先用一句简短中文说明目的，然后真实执行工具；不要只描述计划或声称执行过。此阶段已有合格口型镜头，不得重新运行 MuseTalk、不得下载模型或素材、不得改写 Stage 2A 基线文件。

## 开始前硬检查

先实际读取并检查以下现有成果：

- `phase1-third-party.done` 精确为 `STAGE7_THIRD_PARTY_INIT_OK_20260719`；
- `phase2a-third-party-production.done` 精确为 `STAGE7_THIRD_PARTY_PRODUCTION_BRIDGE_OK_20260719`；
- `phase2a-caption-schema-fixed.done` 精确为 `STAGE7_THIRD_PARTY_CAPTION_SCHEMA_FIXED_20260719`；
- `stage2a-third-party-cut.mp4` 可完整解码，SHA-256 为 `27f18575be47188afab0995be9a15f41f8ecfc29ee99dfa257bc1db3fa21b286`；
- 三段 `shots/lipsync-*.mp4` 均可解码且音视频存在；
- 读取 `stage2a-media-qa.json`、`stage2a-visual-qa.md`、`captions-stage2a.ass`、`build-stage2a.mjs` 和 `provider-ledger.json`。

任一硬检查不符就停止并明确指出，不要另起工程或伪造通过。

## 本阶段必须产生的实际媒体贡献

以 Stage 2A 和现有真人素材为输入，完成一支独立的 Antigravity Stage 2B 重剪，不得只复制或无损重封装旧成片：

1. 新建 `build-stage2b.mjs` 和 `captions-stage2b.ass`，输出 `stage2b-antigravity-cut.mp4`。保持三段真实口型镜头及其原始音频完整，不得替换成源素材、画外音、静帧、动画或数字人。
2. 对画面做可观察的正式重剪：开头 2 秒内真人钩子；问题、演示、回答、结果、行动提示顺序清楚；至少 10 个有意义的剪辑段；允许基于现有素材调整段落长度、入出点、顺序和克制转场，但不得让口型音频错位。
3. 做实际声音设计，而不是沿用单一正弦底噪：用 FFmpeg 可重复生成或从工程现有合法音频制作至少三类独立声音层，例如低音量音乐床、开场/转场提示音、产品动作拟音或环境层。讲话窗口必须自动压低非人声层，BGM 不得压对白；所有声音来源和生成方法写进 `antigravity-stage2.json`。
4. 重做竖屏字幕样式：区分人物或对白/说明层级，保留安全边距，不遮挡眼睛、嘴和产品动作；不得再次出现前导逗号、越界、重叠或最后一句超出视频时长。
5. 输出规格为 40-60 秒、1080x1920、23.976/24/30 fps、H.264、yuv420p、AAC 48 kHz。完整解码通过，无非剧情黑场，最长非剧情静音小于 1.5 秒，综合响度 -18 至 -14 LUFS，真峰值不高于 -1 dBTP。
6. 从 `stage2b-antigravity-cut.mp4` 本身实际抽帧生成 `qa/stage2b-contact-sheet.png` 和 `qa/stage2b-motion-strip.png`；联系表覆盖全部段落，连续帧条覆盖一段真实讲话窗口。不得从输入素材抽帧冒充最终输出。
7. 从真实命令结果生成 `stage2b-media-qa.json`、`stage2b-visual-qa.md` 和 `antigravity-stage2.json`。至少记录新旧成片哈希、时长、编码、音频、完整解码、黑场、静音、响度、真峰值、字幕数量/边界、三个讲话窗口及合计可见讲话时长，以及本阶段具体改变了什么。
8. 只向 `provider-ledger.json` 追加一条 Antigravity 记录，保留全部既有记录。记录当前模型、开始/结束时间、实际工具与文件、Stage 2A 输入哈希、Stage 2B 输出哈希、失败与修复；不得把模型自述当作命令证据。

## 防止假完成

- `stage2b-antigravity-cut.mp4` 必须与 Stage 2A 哈希不同，且构建脚本从已有源素材和口型镜头重新生成它；仅改元数据、复制、重封装或重复编码不算贡献。
- 必须实际运行构建和检查，不能只创建脚本或 JSON。
- 任一检查失败时先修复再重跑受影响检查；不要因为命令退出 0 就跳过媒体、连续帧、音轨和字幕结果。
- Stage 2A 所有文件是受保护基线，除向 `provider-ledger.json` 追加记录外不得修改、删除或覆盖。

全部通过后，才写 `phase2-antigravity.done`，内容必须精确为：

`STAGE7_ANTIGRAVITY_MEDIA_OK_20260719`

UTF-8 无 BOM、无回车、无换行。最终回复简要列出实际重剪、声音层、成片路径、时长、三个讲话窗口、媒体检查和新旧哈希，最后一行只输出该标记。
