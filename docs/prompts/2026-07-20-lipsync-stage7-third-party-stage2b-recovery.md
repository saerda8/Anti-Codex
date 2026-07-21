# Stage 7: 第三方 API 接续真人重剪与声音设计

继续同一个原生 Anti-Codex 任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，只操作唯一工程目录：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

不得新建任务、不得打开第二个 Anti-Codex 窗口、不得修改 Anti-Codex 产品源码、不得调用九个开发 MCP worker。开始每组命令前先用一句简短中文说明目的，然后真实执行工具；不要只描述计划或声称执行过。当前使用第三方 API `gpt-5.6-sol`。上一轮 Gemini 请求在任何工具调用前因 429 结束，工程没有被修改；这不是停止本阶段的理由。

## 当前基线

先读取磁盘上的实际文件，以磁盘内容为准，不要沿用聊天历史里写错的旧标记：

- `phase1-third-party.done` 为 `STAGE7_THIRD_PARTY_INIT_OK_20260719`；
- `phase2a-third-party-production.done` 为 `STAGE7_THIRD_PARTY_PRODUCTION_BRIDGE_OK_20260719`；
- `phase2a-caption-schema-fixed.done` 为 `STAGE7_THIRD_PARTY_CAPTION_SCHEMA_FIXED_20260719`；
- `stage2a-third-party-cut.mp4` SHA-256 为 `27f18575be47188afab0995be9a15f41f8ecfc29ee99dfa257bc1db3fa21b286`；
- 三段 `shots/lipsync-*.mp4` 是已经生成的真人口型同步镜头，不得重新运行 MuseTalk，不得下载模型或素材；
- Stage 2A 文件是只读基线，除向 `provider-ledger.json` 追加记录外不得覆盖。

## 必须完成的实际产出

1. 读取 `acceptance-contract.json`、Stage 2A 构建脚本、字幕、媒体/视觉 QA 和 provider ledger。
2. 新建 `build-stage2b.mjs`、`captions-stage2b.ass`，实际生成 `stage2b-third-party-cut.mp4`。它必须是由已有真人素材和三段口型镜头重新剪辑的独立成片，不得复制、重封装或只改元数据。
3. 保留三段真人口型镜头及原始对白同步，开头两秒内出现真人钩子；全片 40-60 秒、至少 10 个有意义剪辑段，形成问题、演示、回答、结果、行动提示的闭环。
4. 实际制作至少三类独立声音层：低音量音乐床、开场或转场提示音、动作拟音或环境层。讲话窗口必须压低非人声层，BGM 不得盖住对白；记录每层来源和可重复生成方法。
5. 重做竖屏字幕，区分对白与说明，保持安全边距，不遮挡眼睛、嘴和产品动作；无前导逗号、越界、重叠或超时字幕。
6. 输出必须为 1080x1920、H.264、yuv420p、AAC 48 kHz；完整解码通过，无非剧情黑场，最长非剧情静音小于 1.5 秒，综合响度 -18 至 -14 LUFS，真峰值不高于 -1 dBTP。
7. 从 Stage 2B 成片本身生成 `qa/stage2b-contact-sheet.png` 和 `qa/stage2b-motion-strip.png`，不得从输入素材抽帧冒充。
8. 从真实命令结果生成 `stage2b-media-qa.json`、`stage2b-visual-qa.md`、`third-party-stage2b.json` 和 `check-stage2b.mjs`；实际运行构建、完整检查和验收脚本，失败先修复再重跑。
9. 向 `provider-ledger.json` 追加两条记录：本次 Gemini 429 的失败尝试（无文件贡献），以及第三方 Stage 2B 的真实贡献。保留所有既有记录。

只有所有检查通过后，才新建 `phase2b-third-party.done`，内容必须精确为：

`STAGE7_THIRD_PARTY_STAGE2B_MEDIA_OK_20260720`

UTF-8 无 BOM、无回车、无换行。最终回复简要列出新成片、时长、三段口型窗口、声音层、媒体检查和新旧哈希，最后一行只输出该标记。
