# Stage 5 同一任务续跑：完成真实打包和验收

上一轮 Claude 因 429 在创建 `qa-report.json` 后停止。继续当前原生任务，不创建新任务，不重做已经正确存在的网站与媒体。

工作目录：`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-character-film-premiere-site`

只做以下收尾：

1. 读取并核对现有文件；确认 `index.html`、`styles.css`、`app.js`、`data/scenes.json`、`assets/subtitles.vtt`、视频和海报真实存在。
2. 重新运行 JS 语法、JSON、VTT、HTML 引用和视频源/目标 SHA-256 检查。
3. `qa-report.json` 当前在压缩包尚不存在时预写了 `releasePackage.status=PASS`，必须改成由真实打包结果生成的数据，记录 ZIP 字节数、SHA-256、实际文件数和白名单检查结果。
4. 创建自包含 `release-package-stage5.zip`。包内只允许 9 个发布文件：`index.html`、`styles.css`、`app.js`、`README.md`、`qa-report.json`、`assets/final-video-stage4.mp4`、`assets/poster-stage4.png`、`assets/subtitles.vtt`、`data/scenes.json`。
5. 实际列出 ZIP 内容并从压缩包读取其中的 JSON，确认包内 `qa-report.json` 合法；如报告需在打包后记录最终 ZIP 哈希，明确根目录报告是打包后补全版本，不要为了自引用哈希无限重打包。
6. 全部检查通过后才写 `done-stage5.txt`，内容必须恰好是：
   `CHARACTER_FILM_STAGE5_ANTIGRAVITY_OK_20260719`

不要调用 MCP worker，不访问外网，不安装依赖，不修改 `deepcodex` 或源视频工程。先用中文说明当前收尾动作，再调用工具。最终列出入口、ZIP、哈希、13 章节、16 字幕和检查结论，并独立输出完成标记。
