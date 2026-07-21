# Stage 7：第三方 API 过渡生产，等待 Antigravity 恢复

继续同一个原生任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9` 和唯一工程目录：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

不得新建任务、第二个 Anti-Codex 窗口、修改 Anti-Codex 产品源码或调用九个开发 MCP worker。开始每组命令前先用一句简短中文说明目的，不要重复下载、重复启动同一安装命令或只写文字报告。

## 当前断点

- 第三方第一阶段已通过，`phase1-third-party.done` 必须保持不变。
- Antigravity Gemini 在任何工具调用前失败：`User location is not supported for the API use`。
- Antigravity Claude 在任何工具调用前失败：`429 Too Many Requests`。
- 主机确认两次失败都没有改工程。必须把这两条提供方失败追加到 `failures.md` 和 `provider-ledger.json`，不得改写第一阶段记录。
- Antigravity 恢复后还必须回到本任务真实检查和修改产物，因此本阶段不得写 `phase2-antigravity.done`。

## 本阶段目标

用当前第三方 `gpt-5.6-sol` 把等待期间可以完成的实作全部完成：在项目内安装固定提交的官方 MuseTalk 1.5 推理环境和公开权重，真实生成三段真人中文口型同步镜头，并完成正式初剪和机器 QA。不得用动画、数字人、静帧或画外音冒充口型同步。

## 必须完成

1. 验证现有 7 段真人素材、3 段 48 kHz 对白、MuseTalk 提交 `0a89dec45a0192b824e3cf4daf96c239440c5ed8` 和第一阶段哈希，不重新下载已经正确的文件。
2. 在工程 `cache/` 与 `tools/musetalk/` 范围内完成 Python 3.10、CUDA/PyTorch、MuseTalk 依赖和官方公开权重。不得改系统 Python，不得碰用户已有 Docker 容器。若使用临时容器，名称必须以 `anticodex-stage7-` 开头并在本阶段结束前删除。
3. 真实生成至少三段 `shots/lipsync-*.mp4`：女主播主台词至少 4 秒、男主播问句至少 2.5 秒、女主播结尾至少 3 秒；合计可见讲话时长至少 10 秒。每段保留输入视频区间、WAV、台词、命令、时长、编码和 SHA-256。
4. 从实际口型输出生成每段至少 12 个连续帧的 `qa/lipsync-*-strip.png` 和总联系表；连续帧必须能看到真人嘴部形态变化，不能从输入源片冒充输出。
5. 用口型镜头和现有真人护肤动作素材制作 `stage2a-third-party-cut.mp4`：40-60 秒、1080x1920、H.264/yuv420p、AAC 48 kHz，包含对白、合法/自制 BGM、字幕、钩子、问题、演示、结果和行动提示。
6. 输出 `third-party-lipsync-production.json`、`stage2a-media-qa.json`、`stage2a-visual-qa.md`、`captions.srt`、`qa/stage2a-contact-sheet.png`、`qa/stage2a-motion-strip.png` 和可重复构建脚本。JSON 必须来自实际命令结果。
7. 本地验收必须检查三段口型视频和初剪完整解码、音视频时长、脸部连续帧、总可见讲话时长、规格、字幕、黑场、静音、响度和哈希；失败就修复受影响项再重跑。
8. 向 `provider-ledger.json` 追加 Gemini 失败、Claude 失败和第三方过渡生产三条有序记录。明确说明 Antigravity 尚无工具/文件贡献，阶段 2 仍未通过。

只有上述真实文件和 QA 全部通过后，才写 `phase2a-third-party-production.done`，内容精确为：

`STAGE7_THIRD_PARTY_PRODUCTION_BRIDGE_OK_20260719`

UTF-8 无 BOM、无回车、无换行。最终回复给出口型段数、可见讲话总时长、初剪路径、MuseTalk 环境和 QA 结果，最后一行只输出该标记。
