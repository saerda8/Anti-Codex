# Stage 7：第三方 API 立项与真人口型制作准备

继续同一个原生 Anti-Codex 任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`。不得新建任务、不得打开第二个 Anti-Codex 窗口、不得修改 Anti-Codex 产品源码、不得调用九个开发 MCP worker。本阶段只在下面的新工程目录内工作：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

开始每组命令前先用一句简短中文说明目的。必须真实读取、下载、探测和创建文件；不要只回复方案，不要重复启动同一命令，不要把模型自述当作完成证据。

## 最终项目目标

制作一支 40-60 秒、1080x1920 的真人护肤剧情/带货短片。最终画面必须是现实世界真人动态视频，不得使用动画、3D、数字人、图片平移缩放、PPT 或静帧冒充。至少一名主要人物要在清晰可见的正脸或四分之三脸镜头中说完整中文台词，实际音频与可见口型同步。最终还必须有对白、背景音乐、字幕、故事闭环、来源授权、可复现工程、媒体 QA、口型同步 QA、成片和发布包。

本阶段只负责立项、素材、对白、分镜、制作方案和可执行环境准备；后续 Antigravity 会在这个同一任务和同一目录内生成正式口型镜头，最后再切回第三方 API 完成成片。

## 已预检的真人说话素材

必须下载并实际 ffprobe 以下两段 Mixkit 真人竖屏视频，记录来源页、直接 URL、下载时间、字节数、SHA-256 和许可证页。下载失败只重试对应文件一次。

1. 女主播对镜讲话，约 17 秒：
   - 来源页：`https://mixkit.co/free-stock-video/portrait-of-an-influencer-talking-to-the-camera-42323/`
   - 下载：`https://assets.mixkit.co/videos/42323/42323-720.mp4`
2. 男主播对镜讲话，约 13 秒：
   - 来源页：`https://mixkit.co/free-stock-video/face-of-a-vlogger-speaking-to-the-camera-41290/`
   - 下载：`https://assets.mixkit.co/videos/41290/41290-720.mp4`
3. 许可证：`https://mixkit.co/license/`

可以复用 Stage 6 的五段真人护肤动作素材，但本工程必须保留自包含的素材副本或可验证的本地来源映射和哈希：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-18-character-dialogue-short-video\live-action-stage6\assets\source`

## 口型工具边界

使用官方 MuseTalk 1.5：`https://github.com/TMElyralab/MuseTalk`。固定并记录实际提交号。允许使用 `uv` 准备 Python 3.10 环境，或使用一次性的 GPU Docker 环境；不得改系统 Python，不得碰用户已有 Docker 容器。模型权重、虚拟环境和推理缓存属于可再生成中间物，放入本工程的明确缓存目录并排除出发布包。任何临时容器必须带项目专用名称并在最终阶段删除。

不得改用仅允许非商业使用的 Wav2Lip，也不得用动画嘴型、字幕或画外音冒充真人口型同步。若 MuseTalk 预检失败，必须在 `failures.md` 写明准确命令、错误和已验证前置条件；只允许一次有实质变化的修复后重试。

## 本阶段必须交付

1. `case-brief.md`：受众、主题、卖点边界、无医疗功效承诺和完整故事闭环。
2. `script.md`、`dialogue.md`、`storyboard.md`：至少 10 个镜头；至少 3 个可见真人讲话窗口；每个窗口写明人物、台词、时长、脸部可见性、音频文件和后续口型输出名。
3. `production-plan.md`：第三方立项 -> Antigravity 口型制作 -> 第三方终剪的固定顺序、每阶段输入/输出和失败停止条件。
4. `acceptance-contract.json`：机器可读地列出真人、可见中文口型、语音、BGM、字幕、40-60 秒、1080x1920、H.264/yuv420p、AAC 48 kHz、黑场/静音/响度、哈希和发布包要求。
5. `sources.json`：两段说话素材和复用护肤素材的来源、授权、字节数、时长、视频流和 SHA-256。
6. `assets/audio/`：按人物拆分的自然中文对白 WAV；至少一段完整台词 4 秒以上，采样率统一为 48 kHz。保留对白文本到音频文件的映射。
7. `tools/musetalk/` 或等价的项目内固定源码；`environment-report.json` 必须记录 GPU、驱动、FFmpeg、Python、MuseTalk 提交、依赖预检和模型文件状态。大权重不进入发布包。
8. `provider-ledger.json`：先建立三阶段账本，第一条必须记录本阶段由第三方 `gpt-5.6-sol` 完成，列出实际文件和时间；后续阶段只能追加，不得覆盖。
9. `failures.md`：如实记录本阶段失败与修复，不得伪造成功。

运行本地阶段验收，确认所有必需文件存在、素材可完整读取、两段真人说话视频有视频流、对白 WAV 有音频流、来源哈希一致、MuseTalk 固定源码和环境状态可检查。只有全部通过后，才写 `phase1-third-party.done`，内容必须精确为：

`STAGE7_THIRD_PARTY_INIT_OK_20260719`

UTF-8 无 BOM、无回车、无换行。最终回复只简要列出工程目录、素材数量、对白窗口、MuseTalk 环境状态和阶段验收结果，最后一行输出该标记。
