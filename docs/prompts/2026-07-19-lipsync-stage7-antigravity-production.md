# Stage 7：Antigravity 真人口型镜头与正式初剪

继续同一个原生 Anti-Codex 任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，继续操作唯一工程目录：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

不得新建任务、不得打开第二个 Anti-Codex 窗口、不得修改 Anti-Codex 产品源码、不得调用九个开发 MCP worker。开始每组命令前先用一句简短中文说明目的。必须先读取第一阶段全部文件并验证 `phase1-third-party.done` 的精确内容；缺失或不一致就停止并明确指出，不能另起炉灶。

## 本阶段目标

使用第一阶段固定的官方 MuseTalk 1.5 环境，把真人女主播和男主播素材与中文对白实际合成为可见口型同步镜头，并完成一版可播放的 40-60 秒竖屏正式初剪。口型镜头必须是真人脸部动态视频，不得使用动画、数字人、静帧、图片嘴型或只加画外音冒充。

## 必须完成

1. 复核素材哈希、音频采样率、GPU 和 MuseTalk 提交/模型权重。若第一阶段只完成环境预检，按其固定提交完成依赖和权重准备；失败只允许一次有实质变化的修复后重试，并写入 `failures.md`。
2. 至少生成 3 段实际口型同步视频到 `shots/`：
   - 女主播主台词至少 4 秒，脸部清晰且持续可见；
   - 男主播问句至少 2.5 秒；
   - 女主播结尾行动提示至少 3 秒；
   - 三段合计可见说话时长至少 10 秒。
3. 每段输出必须保留对应输入视频区间、输入 WAV、精确台词、实际输出时长、帧率、分辨率、编码、SHA-256 和 MuseTalk 命令。音轨不能错配人物或错位到其他镜头。
4. 从每段口型输出的实际连续帧生成 `qa/lipsync-*-strip.png`；每个讲话窗口至少 12 个连续样本，覆盖闭口、张口和过渡。再生成一张标注台词时间窗的 `qa/lipsync-contact-sheet.png`。
5. 编写或完善可重复构建脚本，把口型镜头、Stage 6 真人护肤动作素材、对白、克制的合法/自制 BGM、环境声和字幕剪成 `stage2-live-action-cut.mp4`。开头 2 秒内出现真人和明确钩子，中段有问题/演示/结果，结尾有行动提示与“测试成片/非功效承诺”。
6. 初剪规格：40-60 秒、1080x1920、23.976/24/30 fps、H.264、yuv420p、AAC 48 kHz；完整解码通过，无非剧情黑场，最长非剧情静音小于 1.5 秒，目标约 -16 LUFS，真峰值不高于 -1 dBTP。
7. 输出 `lip-sync-production.json`、`stage2-media-qa.json`、`stage2-visual-qa.md`、`captions.srt`、`qa/stage2-contact-sheet.png` 和 `qa/stage2-motion-strip.png`。所有 JSON 必须来自实际命令结果，不得手填假通过。
8. 向 `provider-ledger.json` 追加本阶段 Antigravity 的模型、时间、输入、实际生成文件、命令和失败/修复摘要，不得改写第一阶段记录。

阶段验收必须实际检查每段口型输出能完整解码、音视频时长合理、脸部连续帧存在、三段总可见讲话时长达标、初剪媒体规格/音频/字幕/黑场/静音达标。若不能证明真人口型同步，不得写完成标记。

只有全部通过后，才写 `phase2-antigravity.done`，内容必须精确为：

`STAGE7_ANTIGRAVITY_LIPSYNC_OK_20260719`

UTF-8 无 BOM、无回车、无换行。最终回复简要给出口型段数、可见讲话总时长、初剪路径、媒体 QA 与仍需第三方终剪的事项，最后一行输出该标记。
