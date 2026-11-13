# Anti-Codex Worker 规则(精简版)

> 旧版全文(约 234KB 的多 worker 调度规则与失败记忆)已归档到
> [`archive/MCP_WORKER_RULES.md`](archive/MCP_WORKER_RULES.md),不再作为当前规则。
> 本文件只保留仍然生效的少数硬性规则。

## 构建卫生(仍然生效)

1. CodexPlusPlus 的 Windows 候选构建必须通过受管 runner
   `scripts/invoke-anticodex-cargo-xwin.ps1` 执行;不得手工拼 Docker 命令。
2. 禁止持久化临时构建容器:不得使用 `docker create` 配合 `sleep infinity`
   之类的方式保留 ad-hoc 构建 shell;构建容器必须 `--rm` 一次性运行并在结束后不留残余。
3. 构建结束后 `docker ps -a` 中不得存在任何 `anticodex-cpp-*` 或带
   `com.anticodex.ephemeral-build=true` 标签的容器;`scripts/test-anticodex-docker-build-hygiene.ps1`
   负责验证。

## 工作区纪律(新增)

4. 不得在 `H:\CodexProject\Anti-Codex` 根目录创建新的 `deepcodex-*` 克隆副本或
   worktree 用于并行实验;历史副本已归档,唯一工作仓是 `deepcodex`。
5. 不得向 `archive/` 内的任何文件追加内容;状态更新只写入
   `COMPLETION_CHECKLIST.md`(验收结果)或 `MAINTENANCE.md`(上游维护日志)。
