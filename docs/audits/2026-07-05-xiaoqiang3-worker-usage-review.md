# Xiaoqiang3 Worker Usage/Isolation Review

Scope: narrow review of how follow-up Xiaoqiang jobs should be dispatched so they create real worker traffic, while preserving isolation and release evidence quality.

## Evidence reviewed

- `MCP_WORKER_RULES.md` requires one observable output and one behavior goal per dispatch, preferably one target file, at most three acceptance checks, smallest practical writable directory, no shared-worktree writes while a worker is running, separate worktrees for parallel workers, and host review of `git status`, changed-file scope, diff, syntax, and tests before trusting a worker report.
- `findings.md` Current Authoritative Status says the accepted Xiaoqiang complex-project evidence is `latest-worker-mcp-complex-project-smoke.json`, summarized as `workerMcpComplexProjectSmokeEvidence`, and the verifier requires real traffic, `complex-project`, all `xiaoqiang1/2/3`, job ids, clean workspace verification, passing tests/CLI/report/html, `sourceCount:3`, and Antigravity exclusion. It also records that broad review prompts caused xq1 job `xqw_mr7qihmz_c4bmy9` and xq2 job `xqw_mr7qiifo_ckbg67` to time out with `caller_timeout_no_valid_changes`; narrow generated-file tasks with exact checks are the preferred traffic shape.
- `docs/audits/2026-07-05-xiaoqiang3-mcp-skill-surface-review.md` confirms release-visible ecosystem coverage for `latest-xiaoqiang-mcp.json` no-traffic inventory, `latest-xiaoqiang-worker-mcp-project-smoke.json` real `xiaoqiang-project` traffic, and `latest-worker-mcp-complex-project-smoke.json` real `complex-project` traffic with 3/3 Xiaoqiang workers, job ids, clean workspace verification, source validation, tests/CLI, report verification, and HTML verification.

## How to dispatch follow-up Xiaoqiang work so it really consumes worker traffic

1. Use a real implementation dispatch through the Xiaoqiang worker path, not a local host-only audit, and require job ids for `xiaoqiang1`, `xiaoqiang2`, and `xiaoqiang3` in the resulting evidence.
2. Shape each job as one narrow generated-file or exact-file implementation task with one observable output, one behavior goal, and no more than three acceptance checks.
3. Give the worker the smallest practical writable directory, but do not forbid files it must read/import/execute for validation.
4. Keep workers serial in one worktree; if multiple Xiaoqiang workers must run in parallel, use separate worktrees. The main agent and other workers must not write that same worktree during the run.
5. Require host-side verification after completion: `git status`, changed-file scope, diff review, syntax/tests/CLI as applicable, and clean workspace verification in the report.
6. Prefer the already-proven traffic pattern: `xiaoqiang-project` or `complex-project` exact outputs with source/report/html or CLI validation, because those are the surfaces already promoted by ecosystem diagnostics.

## What should not count as passing evidence

- No-traffic MCP inventory such as `latest-xiaoqiang-mcp.json`; it proves tool listing and endpoint reachability, not worker usage.
- Broad review prompts that produce no valid workspace change or end as `caller_timeout_no_valid_changes`.
- Host-authored documentation or local script checks without Xiaoqiang job ids and real worker-produced files.
- Generic non-Xiaoqiang worker reports unless they are explicitly Xiaoqiang-specific and include `xiaoqiang1/2/3` evidence.
- Reports missing clean workspace verification, changed-file scope review, passing test/CLI/report/html checks required by the task, or Antigravity exclusion where the Xiaoqiang evidence contract requires it.

## Check run

- `node scripts/test-anticodex-ecosystem-surfaces.mjs --no-write-report` - passed (`ok:true`, `noTraffic:true`, `usedRealTraffic:false`, 9/9 reports passed, 0 failures).

## Conclusion

XQ3_WORKER_USAGE_REVIEW_DONE - Future Xiaoqiang proof should be accepted only when it is narrow, isolated, job-id-bearing, real worker traffic with host-side verification, not merely no-traffic inventory or broad review text.
