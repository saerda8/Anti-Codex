# Stage 7：第三方 Stage 4A 真人口型发布候选

继续同一个原生 Anti-Codex 任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，只操作唯一工程目录：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

不得新建任务、不得打开第二个 Anti-Codex 窗口、不得修改 Anti-Codex 产品源码、不得调用九个开发 MCP worker。开始每组命令前先用一句简短中文说明目的。必须真实调用 Codex 工具、读取现有工程、运行剪辑和检查；只写方案或复述要求不算完成。

## 当前事实与边界

- 第三方 Stage 2B 已通过主机独立检查，基线成片为 `stage2b-third-party-cut.mp4`，52.304 秒、1080x1920、H.264/yuv420p、AAC 48 kHz，SHA-256 为 `573eb67b484a7c815399094267064b8eba192bcfc0173e2f3c9a40cdb66082d8`。
- `phase2b-third-party.done` 必须精确等于 `STAGE7_THIRD_PARTY_STAGE2B_MEDIA_OK_20260720`。
- 三段真人口型窗口必须继续保留，原始口型素材、Stage 2A 和 Stage 2B 均为只读基线，不得覆盖、删除或改名。
- Antigravity 本轮尝试已被上游明确拒绝：`FAILED_PRECONDITION (code 400): User location is not supported for the API use.`。这是真实外部阻碍，不得伪造 Antigravity 文件贡献、成功记录或阶段标记。
- 本阶段目的是在等待 Antigravity 恢复期间，先由本地 8080 第三方 API 产出可发布的真人口型候选及完整证据。它不是最终三提供方顺序验收，完成后仍需 Antigravity 真实修改，再由第三方做最终复核。

## 必须完成的实物

1. 先实际运行 `check-stage2b.mjs`，并核对 Stage 2A、Stage 2B 和三段口型源文件哈希。任一基线不符立即停止并明确指出，不能自行重建或覆盖基线。
2. 创建唯一的新构建脚本 `build-stage4a-third-party.mjs` 和字幕源 `captions-stage4a-third-party.ass`，从现有真人动态素材和三段口型素材重建发布候选。不得使用动画、3D、数字人、静帧平移缩放或 PPT 画面。
3. 输出 `stage4a-third-party-master.mp4`：40-60 秒、1080x1920、23.976/24/30 fps、H.264、yuv420p、AAC 48 kHz。前 2 秒必须出现真人讲话钩子；全片至少 12 个有意义剪辑段，形成问题、演示、真人回答、结果、行动提示闭环。
4. 至少保留 3 个真人可见讲话窗口，总时长至少 10 秒。逐句核对人物、台词、对应音频、最终起止时间和连续脸部帧；口型明显提前/滞后、嘴不动、错人、跳脸或严重伪影必须修复后重跑。
5. 保留并改善音乐、环境、转场/动作拟音三类以上独立声音层；对白窗口自动压低其他声音。目标综合响度 -18 至 -14 LUFS，真峰值不高于 -1 dBTP，最长非剧情静音小于 1.5 秒。
6. 字幕必须在竖屏安全区，区分对白与说明，不遮挡眼睛、嘴和关键产品动作，不越界、不重叠、不超出视频时长。至少加入三处克制的步骤/重点提示和一处清晰行动提示。
7. 从 `stage4a-third-party-master.mp4` 本身生成：
   - `qa/stage4a-third-party-contact-sheet.png`，覆盖全部段落；
   - `qa/stage4a-third-party-motion-strip.png`，覆盖一段真实讲话窗口且至少 16 个连续帧；
   - 每个口型窗口各一张 `qa/stage4a-lipsync-*-strip.png`。
   不得从输入素材抽帧冒充最终成片证据。
8. 从真实命令结果生成：
   - `check-stage4a-third-party.mjs`
   - `stage4a-third-party-media-qa.json`
   - `stage4a-third-party-lipsync-qa.json`
   - `stage4a-third-party-visual-qa.md`
   - `third-party-stage4a.json`
   - `stage4a-build-log.md`
   - `stage4a-captions.srt`
   - `stage4a-source-license.md`
   其中口型 QA 必须列出每句台词的最终视频窗口、人物、音频、输出镜头哈希和连续帧证据，不能自填虚构评分。
9. 实际运行构建、ffprobe、完整解码、黑场、静音、响度、真峰值、字幕边界、文件存在性、哈希和压缩包可读性检查。失败必须先修复再重跑受影响检查。
10. 创建 `stage4a-third-party-package.zip`，只包含本阶段成片、字幕、封面/联系表、口型证据、脚本/对白/分镜、来源授权、构建源码、QA 和提供方账本。排除缓存、临时帧、下载残留、密钥和模型权重；验证包内每项可读且包内视频哈希与外部一致。
11. 只向 `provider-ledger.json` 末尾追加一条 Stage 4A 第三方记录，准确记录本次模型路由、开始/结束时间、实际工具、文件、命令、输入/输出哈希、失败和修复。不得改写已有记录；不得把失败的 Antigravity 尝试写成贡献成功。

## 完成标记

只有以上检查全部通过后，才创建 `phase4a-third-party.done`，内容必须精确为：

`STAGE7_THIRD_PARTY_STAGE4A_MASTER_OK_20260720`

UTF-8 无 BOM、无回车、无换行。最终回复简要列出候选成片、时长、三段口型窗口、声音层、媒体/口型 QA、视频与压缩包 SHA-256，并明确说明“仍待 Antigravity 真实贡献后才能最终验收”。最后一行只输出该标记。
