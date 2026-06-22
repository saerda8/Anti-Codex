# Anti-Codex 第三方 Provider 历史连续性状态

**首次审计日期**: 2026-06-22
**更新日期**: 2026-06-23
**状态**: 原核心缺口已解决，剩余两项可选真实流量验证

## 已解决

- 本地第三方 provider 验证已覆盖 9 轮 `previous_response_id` 连续对话。
- 覆盖保存 profile、临时 translator 重启、OpenAI-compatible provider 切换。
- 覆盖 OpenAI-compatible -> Anthropic -> OpenAI-compatible 双向协议切换。
- 覆盖同一调用 ID 的结构化工具调用和工具结果历史。
- 第 7、8、9 轮分别检查全部既有历史标记，防止中段历史被截断。
- profile、公开接口、报告、路由审计和错误文本均检查 API key 脱敏。
- 恢复 Antigravity 模式时已证明历史文件不被重写。

当前本地验证使用隔离临时状态和本地假 provider，不产生付费流量，也不修改原生 Codex。

## 仍待补充

### 1. 真实第三方 API 可选 smoke

需要一个默认跳过、显式允许真实流量后才运行的 verifier：

- API key 只能从用户明确指定的环境变量读取，不读取 `.env`，不接受命令行明文 key。
- 使用隔离临时状态，不修改已安装 Anti-Codex profile。
- 只记录协议、模型、状态和脱敏错误，不记录 key、prompt 或完整响应正文。
- 无凭据时写入 `ok:true, skipped:true` 报告。

### 2. 切回真实 Antigravity 后的第 10 轮

需要在隔离状态中完成第三方 9 轮后：

- 显式恢复 Antigravity。
- 重启隔离 translator。
- 使用第 9 轮 `previous_response_id` 发送第 10 轮真实 Antigravity 请求。
- 证明路由已经回到 Antigravity，并证明此前文本标记和结构化工具历史仍可见。
- 该检查必须显式允许真实流量，不能成为普通无流量门禁。

## 其他边界状态

- DPAPI key 文件损坏/不可解密的本地存储边界已由 `test-anticodex-upstream-profile.ps1` 覆盖，并已接入 fast source preflight；完整桌面交互提示体验仍可单独加强。
- 历史修剪后 `410 response_history_missing` 到桌面客户端的完整容错表现。

这些问题不再与“跨协议工具历史是否保留”混为同一个缺口。
