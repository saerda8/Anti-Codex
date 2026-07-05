# Xiaoqiang3 Heavy Worker Isolation Audit

Marker: XIAOQIANG3_HEAVY_WORKER_ISOLATION_AUDIT_20260705

Scope: audit worker scheduling/isolation evidence for Xiaoqiang heavy tasks without starting real worker traffic.

Files actually read and cross-referenced:
- `MCP_WORKER_RULES.md`
- `scripts/test-anticodex-worker-mcp-task-smoke.mjs`
- `scripts/test-anticodex-ecosystem-surfaces.mjs`
- `task_plan.md`
- `findings.md`

## Accepted Worker Evidence

1. `task_plan.md` records the current Xiaoqiang accepted run as `xiaoqiang1`, `xiaoqiang2`, and `xiaoqiang3` project jobs.
2. Accepted job id `xqw_mr7f1hmk_da9agq` is cited for `xiaoqiang1` project completion.
3. Accepted job id `xqw_mr7f3jlb_uvj4i2` is cited for `xiaoqiang2` project completion.
4. Accepted job id `xqw_mr7f5qr4_56qiir` is cited for `xiaoqiang3` project completion.
5. The accepted jobs wrote exact Node project files and passed `node:test` according to `task_plan.md`.
6. The accepted jobs printed CLI JSON with `red=2` and `blue=1`, matching the project verifier contract.
7. `findings.md` also preserves an earlier accepted Xiaoqiang project-smoke pass in `latest-xiaoqiang-worker-mcp-project-smoke.json`.
8. Earlier accepted job id `dsw_mr6zg4h2_0xskgy` is recorded for `xiaoqiang1`.
9. Earlier accepted job id `dsw_mr6zhuer_l2mhh9` is recorded for `xiaoqiang2`.
10. Earlier accepted job id `dsw_mr6zj3av_ycwzsb` is recorded for `xiaoqiang3`.
11. `scripts/test-anticodex-worker-mcp-task-smoke.mjs` maps the `xiaoqiang-project` scenario to the normal `project` task shape through `taskScenarioForScenario`.
12. The same script writes a separate report stem `xiaoqiang-worker-mcp-project-smoke`, avoiding pollution of the five-worker report.
13. The report file name expected by the ecosystem rollup is `latest-xiaoqiang-worker-mcp-project-smoke.json`.
14. Accepted report fields include `requestedRealTraffic:true`, `usedRealTraffic:true`, and `coverageKind:"worker-mcp-real-task-smoke"`.
15. Accepted worker-level fields include `worker`, `ok`, `jobId`, `marker`, `workspace`, `terminalStatus`, and `workspaceVerification`.
16. Accepted verifier fields include `workspaceVerification.ok`, `extraFiles`, `doneTextMatches`, `testExitCode`, `cliExitCode`, and `cliJson`.
17. The ecosystem rollup requires `workerCount` equal to 3 and `passedWorkerCount` equal to 3 for the Xiaoqiang worker surface.
18. The ecosystem rollup requires `failedWorkers` to be empty for the Xiaoqiang worker surface.
19. The ecosystem rollup requires each Xiaoqiang result to have a non-empty `jobId`.
20. The ecosystem rollup requires `workspaceVerification.cliJson.red` to equal 2 and `workspaceVerification.cliJson.blue` to equal 1.

## Rejected Worker Evidence

21. `findings.md` records a rejected Xiaoqiang run after prefix repair with all three workers reaching the model layer but failing before file edits.
22. Rejected job id `xqw_mr7cpvte_9e51ob` belongs to that failed Xiaoqiang run.
23. Rejected job id `xqw_mr7cpygu_ov01mo` belongs to that failed Xiaoqiang run.
24. Rejected job id `xqw_mr7cq18b_8bu2f0` belongs to that failed Xiaoqiang run.
25. The rejected terminal class was `model_result_error`.
26. The rejected error summary was a Claude Provider missing `base_url` configuration error.
27. `findings.md` classifies that rejected run as Xiaoqiang worker provider config drift.
28. The rejected run is not evidence that the project prompt is impossible.
29. The rejected run is not evidence that Anti-Codex MCP/Skills failed.
30. The rejected run should not be retried unchanged until the provider `base_url` path is fixed or identified.
31. `findings.md` also records Xiaoqiang MCP tool-prefix drift from stale DeepSeek-prefixed expectations to `xiaoqiang_*` tools.
32. The required Xiaoqiang tools include `xiaoqiang_implement_in_workspace`, `xiaoqiang_start_implementation`, and `xiaoqiang_wait_for_job`.
33. A failed manual `deepseek_implement_in_workspace` review call is rejected as stale verifier expectation evidence, not task inability.
34. `MCP_WORKER_RULES.md` rejects current-channel worker `Transport closed` observations as dispatch readiness evidence.
35. Examples of rejected current-channel calls include `kilo_get_job`, `opencode_get_job`, and `deepseek_get_job` returning `Transport closed`.
36. Those rejected calls support the no-dispatch rule for that channel but do not prove direct worker servers are broken.

## Shared Worktree Hazard

37. `MCP_WORKER_RULES.md` says the main agent and other workers must not write the same worktree while a worker is running.
38. `MCP_WORKER_RULES.md` says parallel workers require separate worktrees; otherwise workers must be dispatched serially.
39. `MCP_WORKER_RULES.md` says a worker report is untrusted until `git status`, changed-file scope, diff, syntax, and tests are reviewed.
40. The 2026-06-22 incident records DeepSeek job `dsw_mqo2x1p9_lz8865` failing policy in a dirty shared worktree.
41. The same incident records Antigravity job `ag-c8a4e91b-655f-4b6e-8495-c1620c4d6611` producing no usable output.
42. The lesson from that incident is to use smaller read-only audit tasks or one-file patch tasks with explicit output paths in a dirty checkout.
43. The 2026-06-29 incident records DeepSeek job `dsw_mqynzce3_02g06n` editing `findings.md` despite a read-only audit instruction.
44. That incident rejects edit-capable DeepSeek as a shared-worktree read-only auditor unless it has an explicit writable docs output file or isolated worktree.
45. The 2026-06-29 shared-worktree collision records MIMO job `dsw_mqyt754b_w6owgo` and MiMoCode job `mcw_mqyt7cts_43y8uu` seeing or producing out-of-scope changes.
46. That incident also records a temporary helper `translator/tests/_count-patches.mjs` left by MiMoCode and removed before verification.
47. The hazard for Xiaoqiang3 heavy work is therefore not only model correctness; it is concurrent edit autonomy in the same checkout.
48. A shared-worktree Xiaoqiang3 heavy task must not overlap with main-agent edits to `src`, `translator`, scripts, package files, or release artifacts.
49. A docs-only audit worker can be accepted only when the writable scope is exactly the intended audit file and the final diff contains no other paths.
50. For this audit, no real worker traffic was started by the task prompt; the worker wrapper still ran a no-traffic ecosystem surface check after the edit.

## Recommended Scheduling Policy

51. Schedule Xiaoqiang3 heavy implementation serially in the current checkout unless a separate worktree is allocated.
52. Use isolated generated workspaces for worker smokes, matching `allowed_dirs:[workspace]` in `scripts/test-anticodex-worker-mcp-task-smoke.mjs`.
53. Keep `permission_mode:"acceptEdits"` and `safety_mode:"permissive"` only inside those isolated workspaces.
54. Preserve `worker_profile:"scoped_patch"` for Xiaoqiang-style task smokes.
55. Preserve `use_case:"simple_agent_task"`, `verification_profile:"smoke"`, and `reasoning_effort:"high"` for workers whose names start with `xiaoqiang`.
56. Do not dispatch multiple Xiaoqiang workers into one shared repo checkout.
57. If parallel Xiaoqiang jobs are needed, allocate separate worktrees or separate generated workspaces per worker.
58. For real project smokes, keep the host-side exact-file verification: `missingFiles`, `extraFiles`, `doneTextMatches`, `testExitCode`, `cliExitCode`, and `cliJson`.
59. Do not count a result without a `jobId`, even if a workspace later contains plausible files.
60. Do not count `tools/list` or MCP server exposure as worker-task success.
61. Do not count direct server health as current-channel dispatch readiness.
62. After any red Xiaoqiang run, record worker name, `jobId`, terminal status, terminal failure reason, terminal error summary, changed files, and workspace verification fields.
63. Change one concrete cause before retrying: route/base URL, writable boundary, task size, or worktree isolation.
64. Do not reword the same heavy Xiaoqiang3 prompt against the same broken provider route.
65. For report review, prefer signed JSON report files such as `latest-xiaoqiang-worker-mcp-project-smoke.json` and `latest-ecosystem-surfaces.json` over console summaries.
66. Strip a possible UTF-8 BOM before ad hoc JSON parsing, as required by the command evidence lesson in `findings.md`.

## Future Heavy Tasks

67. Future Xiaoqiang3 heavy task A: run a fresh no-traffic ecosystem surface check after reports are already present and fresh.
68. Future Xiaoqiang3 heavy task B: run one real `xiaoqiang-project` smoke only after confirming the provider route still uses the fixed 8080/local setting path.
69. Future Xiaoqiang3 heavy task C: compare `latest-xiaoqiang-mcp.json` with `latest-xiaoqiang-worker-mcp-project-smoke.json` to ensure tools-list health and real-task health stay separate.
70. Future Xiaoqiang3 heavy task D: add a review-only audit that reads `latest-worker-mcp-status-probe.json` without dispatching implementation work.
71. Future Xiaoqiang3 heavy task E: test a heavier `complex-project` shape in a disposable workspace, not in the product checkout.
72. Future Xiaoqiang3 heavy task F: record whether `artifactVerifiedAfterNonterminalWorker` was needed; if true, require extra reviewer scrutiny.
73. Future Xiaoqiang3 heavy task G: keep Antigravity worker excluded until dual-account isolation is proven, matching `antigravityWorkerExcluded:true`.
74. Future Xiaoqiang3 heavy task H: keep report freshness from custom exploratory checks from overwriting release-canonical latest reports.
75. Future Xiaoqiang3 heavy task I: verify the report-site and ecosystem rollups remain no-traffic unless a command explicitly requests real traffic.
76. Future Xiaoqiang3 heavy task J: if shared-worktree edits are unavoidable, reduce the job to exactly one output file and review `git status` before and after.
77. Future Xiaoqiang3 heavy task K: store review outputs under `docs/audits` so the worker output is an explicit patch, not an implicit read-only assertion.
78. Future Xiaoqiang3 heavy task L: reject any worker run that creates helper scripts, logs, README files, or other extras outside the expected project-smoke files.
79. Future Xiaoqiang3 heavy task M: keep `latest-refresh-features.json`, `latest-mcp-skills.json`, `latest-xiaoqiang-mcp.json`, `latest-plugin-capabilities.json`, `latest-worker-mcp-source-hygiene.json`, `latest-worker-mcp-server-probe.json`, `latest-worker-mcp-status-probe.json`, and `latest-xiaoqiang-worker-mcp-project-smoke.json` visible in rollups.

## Worker Validation Note

- Worker job: `xqw_mr7mw4uf_raa237`.
- Isolated worktree: `G:\Trae-Project\Anti-Codex\deepcodex-xq3`.
- Worker accepted exactly one changed file: this audit file.
- Wrapper check passed after the worker edit: `node scripts\test-anticodex-ecosystem-surfaces.mjs`.
