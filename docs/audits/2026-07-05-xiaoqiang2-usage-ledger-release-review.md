# Xiaoqiang2 usage ledger release review

- Scope: review whether a new Xiaoqiang usage ledger verifier should enter release gates or ecosystem surfaces.
- Inputs read: `scripts/test-anticodex-release-gates.mjs` gate list and refresh-action hints.
- Inputs read: `scripts/test-anticodex-ecosystem-surfaces.mjs` required report matrix.
- Inputs read: top `task_plan.md` current status for recent Xiaoqiang evidence and failures.
- Recommendation: treat the usage ledger verifier as auxiliary evidence for now.
- It should not become a new default release-required gate in the first landing.
- It should not become a new first-class ecosystem surface until its report schema and freshness semantics are stable.
- If implemented, it can be linked from Xiaoqiang audit notes or summaries as corroborating evidence.
- Release gates already require `ecosystemSurfaces` as a no-traffic release gate.
- Ecosystem surfaces already cover `xiaoqiangMcp`, `xiaoqiangWorkerProjectSmoke`, and `xiaoqiangWorkerComplexProjectSmoke`.
- Those existing surfaces prove capability: tool listing, real worker traffic, 3/3 workers, clean workspaces, and task outputs.
- A usage ledger proves consumption/accounting quality, not a distinct user-facing capability.
- Making it release-required immediately would add another freshness dependency without closing a current release gap.
- The task-plan status shows some Xiaoqiang attempts are intentionally recorded as failed or consumed, not accepted proof.
- That makes ledger data useful for auditability and operator confidence.
- It also means ledger verification should be tolerant of failed attempts and retries, unlike capability gates that expect green proof.
- The better integration point is auxiliary evidence attached to the existing Xiaoqiang MCP/worker-task story.
- Promotion to ecosystem surface can be reconsidered after the ledger has stable fields for worker, job id, outcome, accepted proof, and consumed attempts.
- Promotion to release-required should require evidence that missing or stale ledger data can hide a release-critical regression.
- Until then, release readiness should continue to depend on the current capability reports and the ecosystem rollup.
- Check run after this doc change: `node scripts/test-anticodex-release-gates.mjs --summary`.
- Expected validation focus: existing release gates remain green and no script/config/runtime paths are modified.
- Changed-file scope for this review is this single Markdown audit under `docs/audits`.

XQ2_USAGE_LEDGER_RELEASE_REVIEW_DONE
