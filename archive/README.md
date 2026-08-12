# archive/ — 历史证据归档(不可复用)

本目录内的文件是 2026-06 至 2026-08 期间的累积执行账本与旧验收体系。它们**只是历史证据**:

- 不得作为当前状态的依据;
- 不得向其中追加新的 `CURRENT OVERRIDE` / `CURRENT EXECUTION` 段落;
- 其中任何"100% / 97% / Gate 红绿"结论均已失效。

当前唯一有效的完成判定见仓库根目录 [`COMPLETION_CHECKLIST.md`](../COMPLETION_CHECKLIST.md);
上游更新的日常处理见 [`MAINTENANCE.md`](../MAINTENANCE.md);
已知且被接受的限制见 [`KNOWN_LIMITATIONS.md`](../KNOWN_LIMITATIONS.md)。

## 归档清单

| 文件 | 原位置 | 说明 |
|---|---|---|
| `task_plan.md` | 仓库根 | 3700+ 行按日期堆叠的执行日志与旧复查清单 |
| `findings.md` | 仓库根 | 约 1.3MB 缺陷与证据账本 |
| `progress.md` | 仓库根 | 按日进度日志 |
| `MCP_WORKER_RULES.md` | 仓库根 | 旧多 worker 调度规则全文;根目录现保留精简版,仅含仍然生效的构建卫生规则 |
| `CURRENT_LONG_TASK_ACCEPTANCE.md` | `docs/` | 旧 Gate 8 自主长任务验收(已降级为可选 demo,见 KNOWN_LIMITATIONS) |
| `FINAL_100_PERCENT_REVIEW_PLAN.md` | `docs/` | 旧"唯一 100% 清单";其"上游一变即重开"规则已被 COMPLETION_CHECKLIST 的冻结基线规则取代 |
| `retired-tests/anticodex-plan-truth.test.mjs` | `translator/tests/` | 逐字断言旧账本内容的测试;账本归档后随之退役 |

## 为什么归档

旧体系把"完成"定义为:任何一次官方 Codex 或 CodexPlusPlus 更新、运行时激活、
提示词/设置变更、新长任务成片都会自动重开已通过的验收项。该定义与持续变化的
外部上游耦合,在数学上不可能闭合,导致项目长期停在"总体 90%"。新体系将完成
基线冻结在一组明确的版本上,上游漂移改由 `MAINTENANCE.md` 的日常流程处理。
