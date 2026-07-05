# Xiaoqiang1 Plugin Source Snapshot Review

Marker: XQ1_PLUGIN_SNAPSHOT_REVIEW_20260706

## Scope

This review checks the stale `sourceSnapshot` risk for Anti-Codex plugin capability evidence. It is a documentation-only audit: no runtime directory, report, AppData, script, or configuration path should be written for this task.

## Source snapshot behavior reviewed

- In `scripts/test-anticodex-plugin-capabilities.ps1`, `shortBudgetMode` is enabled when `TimeoutSec < 5`. That path writes a failed/degraded plugin report and calls `Get-ReusedSourceSnapshot`, which copies `sourceSnapshot` from `latest-plugin-capabilities.json` if one exists.
- The timeout-budget path before the parity scan does the same reuse when less than 2000 ms remains. Both reuse paths stamp `sourceSnapshot.reusedFromPreviousReport = true` and add `refreshSkippedReason`.
- A normal/full plugin run only creates fresh source evidence near the end with `Get-AntiCodexSourceSnapshot -SharedCodexHome ... -AgentsSkillsPath ...`, after the live endpoint and local parity checks have run.
- In `scripts/summarize-anticodex-report.mjs`, `sourceSnapshotEvidence` preserves the key review fields: `fingerprint`, `sourceMtimeMax`, `fileCount`, `cacheHitCount`, `cacheMissCount`, `reusedFromPreviousReport`, and `refreshSkippedReason`. The summarizer exposes these fields; it does not make reused snapshot evidence fresh.
- The same summarizer reports plugin details separately under `pluginCapabilityEvidence` (`snapshotSource`, `capabilityState`, connector/app-tool counts, parity checks, and cache smoke fields), so a reviewer must read the snapshot freshness and plugin capability state together.

## Recent task-plan context

Recent `task_plan.md` plugin/MCP entries show the intended recovery pattern: connector/app-tool drift is repaired or verified through `refresh-anticodex-local-features.ps1`, then plugin capability verification is rerun with an explicit larger timeout budget. The plan also notes that default short budgets can false-red or skip enough work to make prior reports only historical. MCP/Skills and plugin reports are useful evidence only when their current report is fresh for the surface being claimed.

## Risk conclusion

A stale or reused `sourceSnapshot` is a review warning and should not be accepted as current plugin evidence. If a plugin capability report is green but `sourceSnapshot.reusedFromPreviousReport` is true, or `refreshSkippedReason` says the snapshot refresh was skipped, the report proves at most the state captured by the older snapshot. It cannot prove the current plugin/cache/source state.

The correct remediation is to refresh/verify local features first, then rerun plugin capabilities with enough verifier budget to produce a fresh source snapshot and parity evidence. In practice, that means using the refresh-features flow to repair or confirm connector/app-tool/skill parity, followed by a non-short-budget `test-anticodex-plugin-capabilities.ps1` rerun. Only the rerun whose report has a fresh `sourceSnapshot` and current plugin parity fields should be treated as current Anti-Codex plugin capability evidence.

## Evidence-use rule

Do not treat an old green `latest-plugin-capabilities.json` or any summarized green report as current plugin proof when the source snapshot was reused or refresh was skipped. Old green reports remain historical evidence only; current claims require current refresh/features evidence plus a fresh plugin rerun.
