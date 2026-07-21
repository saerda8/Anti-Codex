# Anti-Codex 长任务：人物剧情短片 Stage 5 首映网站

这是一次真实产出验收，不是问答。你必须在当前 Anti-Codex 原生任务中持续工作，实际读取素材、创建文件、运行检查、修复失败并交付可打开的网站和发布包。

## 唯一工作范围

- 输入项目：`G:\Trae-Project\Anti-Codex\deliverables\2026-07-18-character-dialogue-short-video`
- 输出目录：`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-character-film-premiere-site`
- 禁止修改：`G:\Trae-Project\Anti-Codex\deepcodex`、原视频项目中的任何文件、用户配置、Codex/Anti-Codex 安装目录。
- 不调用任何 MCP worker，不安装依赖，不访问外网，不启动常驻服务，不创建额外任务。

## 交付目标

制作一个可离线打开、可直接发布的人物剧情短片首映网站。网站必须实际嵌入并播放 Stage 4 成片，不得用占位视频或纯文字代替。

至少完成：

1. 将 `final-video-stage4.mp4` 和 `poster-stage4.png` 复制到输出目录的 `assets`，并核对视频 SHA-256 与源文件一致。
2. 创建 `index.html`、`styles.css`、`app.js`，不依赖 CDN 或外部资源。
3. 提供 13 段可点击章节导航，点击后跳转到真实时间点；章节名称和时间点从 Stage 4 时间轴/报告中提取，不能随便编造。
4. 提供 16 句中文同步字幕，产出合法的 `subtitles.vtt`，播放器默认加载字幕。
5. 提供播放/暂停、静音、全屏、章节切换、当前章节高亮和播放进度；原生播放器能力可以复用，但交互必须可用。
6. 页面包含角色、故事简介、制作规格和媒体质检结果，但首屏必须以真实成片和片名为主，不做营销空壳。
7. 桌面和手机布局都可用；按钮有明确图标或文字、焦点态、键盘操作和可读对比度。
8. 创建 `data/scenes.json`、`README.md`、`qa-report.json`、`release-package-stage5.zip`。
9. 发布包必须自包含且只收录必要文件；不得包含密钥、缓存、日志、临时帧、`node_modules` 或原工程源代码。

## 验收

- 实际运行 JavaScript 语法检查、JSON/VTT/HTML 引用检查、媒体哈希检查和 ZIP 白名单检查。
- `qa-report.json` 必须记录每项检查、视频参数、源/目标哈希、章节数、字幕数、发布包文件数和最终结论。
- 失败后只修真实原因并重跑对应检查，不得把失败写成通过。
- 整个过程中用中文给出至少 10 条互不重复的短进度说明；先说明要做什么，再调用工具。
- 完成前不要提前给最终答复。所有检查通过后，最后写入：
  `G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-character-film-premiere-site\done-stage5.txt`
- 该文件内容必须恰好为：
  `CHARACTER_FILM_STAGE5_ANTIGRAVITY_OK_20260719`

最终答复必须列出网站入口、发布包、视频哈希、章节数、字幕数、质检结果，并在独立一行输出：

`CHARACTER_FILM_STAGE5_ANTIGRAVITY_OK_20260719`
