# Anti-Codex 人物剧情短片：Antigravity 第二阶段续跑

继续同一个原生任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9` 和同一个工程目录，不得新建任务。Claude Sonnet 4.6 已真实创建 `src/timeline-stage2.mjs`、`src/frame-stage2.mjs`、`src/build-stage2.mjs`、`src/check-stage2.mjs` 并更新 `package.json`，随后 Antigravity Claude 返回 429，原生回合在达到重试上限后终止。保留这些可用改动，从当前文件状态继续，不要重做已经完成的源码。

最新续跑状态：一次 Gemini 3 Flash Agent 尝试在首个模型响应前因 `FAILED_PRECONDITION: User location is not supported for the API use` 失败，未改动任何产物。当前固定路由已切回 Antigravity Claude Sonnet 4.6。`stage2-antigravity.json` 必须如实记录最初 Claude 429、Gemini 地区限制和本次 Claude 续跑，不得把失败尝试写成成功贡献。构建脚本生成的 README 仍有一句过时的 `PowerShell System.Speech` 依赖说明，实际构建已不调用 TTS；请在本次更新 README 时删除该误导说明。

上一回合走偏到重新生成 TTS 和列出系统声音，并连续失败。现在明确纠正：

主机已经完成最小修复：`timeline-stage2.mjs` 现在保持 Stage 1 的 68 秒和原 16 句对白，只在原时间轴内拆成 11 个镜头；`build-stage2.mjs` 已移除 TTS 和对白重混步骤，只复用已验收音轨并新增脚步声；`frame-stage2.mjs` 的动作时间已同步。以上修复已通过语法与时间轴一致性检查，不得回退或重新设计。

1. **禁止重新生成对白、禁止查询系统声音、禁止再次运行那四条失败的嵌套 PowerShell/TTS 命令。**
2. Stage 1 的 `assets/dialogue/dialogue-track.wav`、`assets/sfx/`、音乐和环境音已经通过独立验收。Stage 2 必须复用这些现有音频；只重新渲染增强后的逐帧画面，然后与现成音轨混合。
3. 先用窄搜索确认 `build-stage2.mjs` 不再调用 TTS；若确认无调用，不要再改时间轴或音频逻辑。不要读取 `node_modules` 或视频二进制。
4. 运行关键时间点帧测试，再只启动一次完整 Stage 2 构建。生成 `final-video.mp4`、15 帧以上的 `contact-sheet-stage2.png` 和同一动作段连续 8 帧以上的 `motion-strip-stage2.png`。
5. 完成 `ffprobe-stage2.json`、`media-qa-stage2.json`、`visual-qa-stage2.md`、`stage2-antigravity.json`，更新分镜、角色设定和 README，并运行 `npm run check:stage2`。
6. 必须确认 `draft-video.mp4` 的 SHA-256 仍为 `6a71f97a0e1d9dd31b773a59977cbe79f051ebecac8f1ed0befec6560752334f`；完整解码最终视频并验证编码、时长、响度、真峰值、黑帧、静音、11 镜头、5 景别、角色动作和三种嘴型。
7. 全部通过后才写 `done-stage2.txt`，精确内容 `CHARACTER_FILM_STAGE2_ANTIGRAVITY_OK_20260718`，UTF-8 无 BOM、无 CR/LF；字节数必须动态计算。

开始每组命令前用一句中文说明目的。不要伪造任何提供方完成；`stage2-antigravity.json` 必须如实记录三次尝试及各自结果。最终回复最后一行只输出 `CHARACTER_FILM_STAGE2_ANTIGRAVITY_OK_20260718`。
