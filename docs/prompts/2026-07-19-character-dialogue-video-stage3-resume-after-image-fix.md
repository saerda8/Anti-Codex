# Anti-Codex 人物剧情短片：第三方 API 断点续做

继续当前原生任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，不得新建任务。只在现有工程目录 `G:\Trae-Project\Anti-Codex\deliverables\2026-07-18-character-dialogue-short-video` 内工作，禁止调用九个开发 MCP worker，禁止修改 Anti-Codex 产品源码，禁止启动第二个 Anti-Codex 窗口。

上一轮已经完成并通过原始 Stage 3 提示中的第 1、2 步：`npm.cmd run check:stage2` 通过；`final-video.mp4` 已完成独立完整解码和媒体检查，结论为 68 秒、H.264/yuv420p、1920x1080、24 fps、AAC 48 kHz、完整解码退出码 0、约 -17.40 LUFS、真峰值约 -1.43 dBTP、无非剧情黑场和超限静音。不要重复这些耗时检查，不要重新渲染视频。

上一轮只在首次读取 `contact-sheet-stage2.png` 后因旧翻译组件把图片 Base64 当普通文本转发而中断。该翻译组件现已修复并重启。现在从原始 Stage 3 提示的第 3 步继续：

1. 开始每组命令或工具调用前先用一句中文说明目的。
2. 使用本地图片查看工具实际检查 `contact-sheet-stage2.png`，再检查 `motion-strip-stage2.png`；不得只凭已有文字报告推断。确认 11 个镜头、至少 5 种机位、两名固定角色、嘴型、眨眼、肢体、位置变化和角色互动有可见证据，并把观察写入 `final-audit.md`。
3. 只有发现可复现的真实失败时才修改源码并只重跑相关步骤；若视觉检查通过，不得重渲染视频或重做音频。
4. 检查工程中不得包含 API key、授权头、用户凭证、网络热链或绝对临时目录。不要读取 `node_modules`、视频二进制正文或无关大文件。
5. 完成原始 Stage 3 提示要求的全部最终交付：`final-audit.md`、`release-manifest.json`、`release-package.zip`、`stage3-third-party-final.json`，并更新 `index.html` 和 `README.md`。发布包必须能实际列出，排除 `node_modules`、`tmp`、`tmp-*`、缓存、密钥和另一个压缩包。
6. 重新读取 `stage3-third-party-final.json`、列出压缩包内容并核对所有哈希。只有全部文件存在、非空、哈希自洽且检查通过后，才写入 `done-stage3.txt`。其精确内容必须为 `CHARACTER_FILM_STAGE3_THIRD_PARTY_OK_20260719`，UTF-8 无 BOM、无回车、无换行，并按实际 UTF-8 编码动态验证字节长度。

最终回复简要给出成片路径、视频哈希、压缩包路径、压缩包哈希和检查结论，最后一行只输出 `CHARACTER_FILM_STAGE3_THIRD_PARTY_OK_20260719`。主机将独立检查文件、本次真实图片工具调用和当前原生任务，文字自述不算通过。
