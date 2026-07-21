# Anti-Codex 人物剧情短片：第三方 API 最终审计与交付

继续当前原生任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，不得新建任务。只在现有工程目录 `G:\Trae-Project\Anti-Codex\deliverables\2026-07-18-character-dialogue-short-video` 内工作，禁止调用九个开发 MCP worker，禁止修改 Anti-Codex 产品源码，禁止启动第二个 Anti-Codex 窗口。

前两阶段已经有真实产物：Stage 1 第三方 API 完成工程和首稿，Stage 2 Antigravity 完成增强成片。当前 `final-video.mp4` 的已知 SHA-256 为 `6d0db34f74717745a5b4a4441aa6bf03972344ba7f3ed6c2ccca6b7de5dca558`，`done-stage2.txt` 精确内容为 `CHARACTER_FILM_STAGE2_ANTIGRAVITY_OK_20260718`。本阶段是第三方 API 的独立最终审计和交付打包，不是重新设计或无条件重渲染。

开始每组命令前先用一句中文说明目的。不要读取 `node_modules`、视频二进制正文或无关大文件；媒体只能通过 ffprobe、ffmpeg、哈希、实际抽帧和可用的本地图片检查来验证。不要无意义重复命令、反复启动渲染器或只写文字自述。

## 执行顺序

1. 先检查 Stage 1、Stage 2 的清单、源码、QA 文本、标记和文件哈希，运行现有 `npm run check:stage2`。
2. 对 `final-video.mp4` 做一次独立完整解码，并独立核对：H.264、yuv420p、1920x1080、24/30 fps、60-75 秒、AAC 48 kHz、响度约 -16 LUFS、真峰值不高于 -1 dBTP、无非剧情黑场、最长非剧情静音少于 1.5 秒。
3. 检查 `contact-sheet-stage2.png` 和 `motion-strip-stage2.png`，确认 11 个镜头、至少 5 种机位、两名固定角色、嘴型/眨眼/肢体/位置变化和角色互动均有可见证据，不是静态幻灯片。
4. 只有发现可复现的真实失败时才修改源码并只重跑相关步骤；若全部通过，禁止为了制造工作量重新渲染视频或重做音频。
5. 检查工程中不得包含 API key、授权头、用户凭证、网络热链或绝对临时目录。报告可以写路由和模型名，但不得写 key 或 key 提示。

## 最终交付

- `final-audit.md`：逐项记录独立检查、实际命令、关键数值、视觉证据和最终结论。
- `release-manifest.json`：列出正式交付文件的相对路径、字节数和 SHA-256；不得包含 `node_modules`、`tmp`、`tmp-*`、缓存或密钥。
- `release-package.zip`：可独立交付的压缩包，至少包含最终视频、Stage 2 海报/联系表/运动条、README、角色设定、分镜、字幕、对白、素材清单、可重复渲染源码、必要本地素材、Stage 1/2/3 QA 和 `release-manifest.json`；不得包含 `node_modules`、`tmp`、临时测试文件、API key 或另一个压缩包。
- `stage3-third-party-final.json`：如实记录当前第三方路由、模型、前两阶段来源、执行过的关键命令、最终视频哈希、压缩包哈希、文件数量、全部检查结果和是否发生必要修复。不得包含 API key。
- 更新 `index.html` 和 `README.md`，让用户能找到 `final-video.mp4`、最终海报、联系表、运动条、最终审计和发布包。
- `done-stage3.txt`：只能在以上文件全部存在、非空、哈希自洽、压缩包可实际列出且所有检查通过后写入。内容精确为 `CHARACTER_FILM_STAGE3_THIRD_PARTY_OK_20260719`，UTF-8 无 BOM、无回车、无换行；字节长度必须按实际 UTF-8 编码动态验证。

完成后再重新读取 `stage3-third-party-final.json`、列出压缩包内容、核对 `done-stage3.txt` 精确字节。最终回复简要给出成片路径、视频哈希、压缩包路径、压缩包哈希和检查结论，最后一行只输出 `CHARACTER_FILM_STAGE3_THIRD_PARTY_OK_20260719`。主机将独立检查文件和当前原生任务的工具调用，文字自述不算通过。
