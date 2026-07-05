# XQ3 Skill Snapshot Review - 2026-07-06

Marker: `XQ3_SKILL_SNAPSHOT_REVIEW_20260706`

## Scope reviewed

Read-only review of the Anti-Codex local feature / MCP skills snapshot path:

- `scripts/anticodex-source-snapshot.ps1`
- `scripts/test-anticodex-mcp-skills.ps1`
- `scripts/refresh-anticodex-local-features.ps1`
- `scripts/summarize-anticodex-report.mjs` `sourceSnapshotEvidence`, `mcpSkillEvidence`, and `refreshFeatureEvidence` extraction blocks
- `C:\Users\XD\.codex\MCP_WORKER_USAGE_GUIDE.md` relevant MCP / worker rules

No runtime directories were written during this review.

## Finding

The current source snapshot logic covers both skill sources:

- `.codex/skills`: `Get-AntiCodexSourceSnapshot` adds label `shared-skills` from `Join-Path $SharedCodexHome "skills"`; default `$SharedCodexHome` is `%USERPROFILE%\.codex`.
- `.agents/skills`: `Get-AntiCodexSourceSnapshot` adds label `agents-skills` from `$AgentsSkillsPath`; default `$AgentsSkillsPath` is `%USERPROFILE%\.agents\skills`.

Both verification paths then compare the Anti-Codex local skills copy against the union of those two sources:

- `test-anticodex-mcp-skills.ps1` builds `expectedSharedSkillNames = sharedSkillNames + agentsSkillNames`, reports `sharedCount`, `agentsCount`, `expectedSharedCount`, `missingShared`, `changedShared`, duplicate/conflicting duplicate names, and source snapshot evidence.
- `refresh-anticodex-local-features.ps1` builds `expectedSkillNames = sharedSkillNames + agentsSkillNames`, then reports `sharedCount`, `agentsCount`, `expectedCount`, `missingExpected`, and `changedExpected` after refresh / verify.
- `summarize-anticodex-report.mjs` preserves this evidence via `sourceSnapshotEvidence`, `mcpSkillEvidence.agentsSkillCount`, and `refreshFeatureEvidence.changedExpectedSkills`.

Conclusion: the feature snapshot design does cover both `.codex/skills` and `.agents/skills`, and the report surface is sufficient to distinguish shared Codex skills from Agents skills.

## Why source changes require refresh + rerun

Do not rely only on an old report after skill source changes. Reports are point-in-time evidence:

1. The `sourceSnapshot.fingerprint`, `sourceMtimeMax`, file counts, and cache counters are generated when the verifier or refresh script runs. They do not automatically update when `.codex/skills` or `.agents/skills` changes later.
2. The Anti-Codex runtime uses a local skills copy under the configured `CodexHome` (`codex-home-deepseek-app\skills` by default), not the source directories directly. A source-side add/edit/delete must be propagated by the feature refresh path before the local copy can be trusted.
3. MCP/Skills verification must then be rerun to prove the refreshed local copy still matches the union of `.codex/skills` and `.agents/skills`, and to catch missing, extra, changed, duplicate, or conflicting skills.
4. Short-budget MCP smoke mode can reuse a previous full `sourceSnapshot` and mark `reusedFromPreviousReport` / `refreshSkippedReason`; that is useful for smoke speed, but it is explicitly not fresh evidence for a changed source tree.
5. The summarizer only extracts fields from existing JSON reports. If the underlying feature refresh and MCP/Skills reports are stale, the summary will also be stale even though it still displays structured evidence.

Required operational sequence after skill source changes: refresh Anti-Codex local features, then rerun MCP/Skills verification, then summarize the newly generated reports.
