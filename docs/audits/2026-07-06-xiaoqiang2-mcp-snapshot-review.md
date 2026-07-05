# Xiaoqiang2 MCP/Skills Source Snapshot Review

Marker: XQ2_MCP_SNAPSHOT_REVIEW_20260706

Scope: review the stale source snapshot risk in Anti-Codex MCP/Skills evidence after the current four-Xiaoqiang transition. This is a documentation-only audit and does not write runtime directories.

## Findings

- `scripts/test-anticodex-mcp-skills.ps1` now treats `xiaoqiang1`, `xiaoqiang2`, `xiaoqiang3`, and `xiaoqiang4` as expected MCP servers and requires each to pass real stdio `tools/list` with the six Xiaoqiang job tools: cancel, get, implement, start, tail, and wait.
- The same MCP/Skills verifier compares shared Codex MCP config to the Anti-Codex local config, checks missing/extra/changed MCP entries, validates inherited skills against shared/agent skill sources, and emits `sourceSnapshot` evidence into `latest-mcp-skills.json`.
- In short-budget mode, the verifier may reuse a previous source snapshot through `reusedFromPreviousReport:true` with a `refreshSkippedReason`. That is useful for fast smoke checks, but it is not fresh proof that the current 12-MCP surface and current skills copy were snapshotted after the four-Xiaoqiang config change.
- `scripts/test-anticodex-diagnostics.ps1` accepts MCP/Skill summaries only when `latest-mcp-skills.json` is ok, has `sourceSnapshotEvidence`, has MCP smoke and real-call evidence, and has enough real `tools/list` coverage for worker MCP servers. For short-budget summaries it explicitly expects reused snapshot metadata, which makes stale-snapshot provenance visible rather than silently fresh.
- `task_plan.md` records the current state as four Xiaoqiang workers exposed in global Codex config, Anti-Codex installed config, and the current Codex channel, with fresh `xiaoqiang-project` proof passing 4/4. It also states older 3/3 Xiaoqiang complex-project evidence remains historical only and future project smoke should use the four-worker shape.

## Stale snapshot risk

After the surface expands to 12 MCP servers with `xiaoqiang1` through `xiaoqiang4`, a reused or older MCP/Skills source snapshot can prove only that some earlier local-copy state was fingerprinted. It can miss exactly the change that matters now: whether the installed Anti-Codex config and skills snapshot were refreshed after `xiaoqiang4` and the full four-worker MCP set became visible.

The risk is not that the historical reports are invalid; they remain historical evidence. The risk is overclaiming current readiness from a `sourceSnapshotEvidence` block whose fingerprint predates the new 12-MCP inventory. A stale snapshot could coexist with fresh runtime `tools/list` evidence, leaving the report unable to prove that the source-copy fingerprint, MCP parity checks, and skill parity checks all describe the same post-transition state.

## Required evidence refresh

For current readiness claims, rerun MCP/Skills evidence with enough verifier budget to create a fresh source snapshot rather than relying on `reusedFromPreviousReport:true`. The refreshed `latest-mcp-skills.json` should show:

- 12 MCP entries in the installed/local Anti-Codex config, with no missing, extra, or changed shared MCP servers.
- Real stdio `tools/list` evidence for the worker MCP surface, including passing checks for `xiaoqiang1`, `xiaoqiang2`, `xiaoqiang3`, and `xiaoqiang4`.
- Skill inventory and fingerprint parity checks that are not merely skipped because of budget exhaustion.
- `sourceSnapshotEvidence` that is fresh for this run, not a previous-report reuse marker, so diagnostics can summarize a post-four-Xiaoqiang snapshot.

## Verdict

Stale source snapshots are acceptable only as labeled short-budget smoke provenance. They are insufficient for a current 12-MCP / four-Xiaoqiang readiness claim. The MCP/Skills report should be rerun after the four-Xiaoqiang exposure with a fresh source snapshot, and runtime directories must remain read-only during this review.
