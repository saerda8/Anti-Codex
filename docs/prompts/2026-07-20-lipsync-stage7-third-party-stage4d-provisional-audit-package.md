# Stage 7：第三方 Stage 4D 独立复验与暂定交付包

继续当前同一个原生 Anti-Codex 任务 `019f7379-c051-7de1-b2eb-cd2e333bf8f9`，只操作：

`G:\Trae-Project\Anti-Codex\deliverables\2026-07-19-alternating-provider-live-action-lipsync-stage7`

不得新建任务、不得打开第二个客户端、不得修改 Anti-Codex 产品源码、不得调用九个开发 MCP worker。开始每组命令前先用一句简短中文说明目的。必须真实运行工具和检查，不能只根据已有报告写总结。

## 当前事实

- Stage 4B 已由第三方 `gpt-5.6-sol` 完成，标记 `phase4b-third-party.done` 应精确为 `STAGE7_THIRD_PARTY_STAGE4B_DIRECTORS_CUT_OK_20260720`。
- Stage 4B 成片预期 SHA-256 为 `2c59b39cc3004468d1b7c28e76a5e27bc3c640721d7f702066511e47f5363f0f`。
- 随后的 Antigravity Gemini 3.5 Flash Extra Low 与 Gemini 3.1 Pro Low 均真实请求并由外部服务返回 `FAILED_PRECONDITION` / `unsupported_location`。它们没有工具调用或文件贡献，`phase4c-antigravity-gemini.done` 必须不存在。
- 因 Gemini 尚无真实贡献，本阶段只能形成“暂定交付包”，不得宣称整个三提供方顺序验收完成。

## 必须完成

1. 实际重新运行 `check-stage4a-third-party.mjs` 和 `check-stage4b-third-party.mjs`；核对 Stage 4A、Stage 4B 视频哈希、完成标记原始字节、三段口型素材哈希、所有 Stage 4B QA 文件和 `provider-ledger.json`。任一失败必须停止并准确记录，不能改写只读视频基线。
2. 对 `stage4b-third-party-directors-cut.mp4` 重新执行完整解码和 ffprobe，并重新测量黑场、长静音、综合响度和真峰值。结果必须与 Stage 4B 报告一致或解释可接受的工具舍入差异。
3. 新建 `stage4d-third-party-independent-audit.json` 和 `stage4d-third-party-independent-audit.md`，记录实际命令、退出码、媒体规格、时长、13 个剪辑段、三段口型窗口、25.304 秒真人说话、所有关键哈希、文件清单以及两次 Gemini `unsupported_location` 失败。不得包含 API key。
4. 新建 `stage4d-delivery-manifest.json`，列出暂定交付包中每个文件的相对路径、字节数和 SHA-256。至少包含 Stage 4B 成片、构建脚本、字幕、检查脚本、媒体/口型/视觉 QA、联系表、运动条、三张口型条、比较报告、构建日志、Stage 4B 提供方记录、账本和 Stage 4B 标记。不得塞入缓存、原始下载、临时帧或无关旧任务文件。
5. 生成 `stage4d-third-party-provisional-package.zip`。随后从 ZIP 本身重新读取目录和每个条目，确认无绝对路径、无 `..`、无空条目、清单文件齐全，并将 ZIP 字节数、条目数和 SHA-256 写回审计 JSON/MD。包大小要与必要内容相称，不能重复塞入同一视频或可再生成缓存。
6. `provider-ledger.json` 若尚无 Stage 4D 第三方独立复验记录，只追加一条；若已存在则不得重复。记录必须明确 `finalAcceptance: pending_antigravity_gemini_real_contribution`。

## 完成标记

只有以上检查和 ZIP 复读全部通过，才创建 `phase4d-third-party-provisional-audit.done`，内容精确为：

`STAGE7_THIRD_PARTY_STAGE4D_PROVISIONAL_AUDIT_OK_20260720`

UTF-8 无 BOM、无回车、无换行。最终回复简要列出成片、暂定包、条目数、ZIP SHA-256、复验结果，并明确说明 Antigravity Gemini 因外部地区限制仍未完成真实贡献，整个项目验收尚不能宣称完成。最后一行只输出该标记。
