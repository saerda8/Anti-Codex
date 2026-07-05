# Xiaoqiang3 Usage Ledger Docs Review

Scope: review whether the Xiaoqiang usage ledger evidence matches `MCP_WORKER_RULES.md` Dispatch Rules and Failure Protocol.

Evidence read: top Dispatch/Failure Protocol in `MCP_WORKER_RULES.md`, the top two Xiaoqiang entries in `findings.md`, and `docs/audits/2026-07-05-xiaoqiang3-worker-usage-review.md`.

## Ledger events that should be verified

- Failed attempts must be recorded with worker, job id, task, terminal state, logs, changed files, and a cause classification before retry.
- The failed broad/no-change jobs must remain visible as consumed attempts: xq1 `xqw_mr7thgfo_d32uga`, xq2 `xqw_mr7thq3o_915pb8`, xq1 `xqw_mr7qihmz_c4bmy9`, and xq2 `xqw_mr7qiifo_ckbg67`.
- Successful retries should prove one exact output path, one behavior goal, no more than three acceptance checks, and host review of `git status`, changed-file scope, diff, syntax, and tests.
- Accepted Xiaoqiang proof should include real traffic, job ids for `xiaoqiang1/2/3`, clean workspace verification, passing tests/CLI/report/html where required, `sourceCount:3`, and Antigravity exclusion for complex-project evidence.

## Events that should not count as passed

- No-traffic inventory, host-only documentation, or local script output without Xiaoqiang job ids and worker-produced files.
- Broad review prompts that end with `caller_timeout_no_valid_changes`, zero workspace changes, or model success without an accepted diff.
- Generic worker evidence that is not explicitly Xiaoqiang-specific or lacks all required `xiaoqiang1/2/3` job ids.
- Reports missing clean workspace verification, changed-file scope review, or the exact task checks required by the dispatch.

## Future worker task shape

- Write follow-up tasks as narrow generated-file or exact-file edits with one observable output and one behavior goal.
- Name the exact output path, require a marker assertion, and include one real script check instead of broad review language.
- Use the smallest practical writable directory, but do not forbid directories the worker must read, import, or execute for validation.
- Run Xiaoqiang jobs serially in one worktree, or use separate worktrees for parallel workers; the host must not write the same worktree while a worker runs.

## Check run

- `node scripts/test-anticodex-ecosystem-surfaces.mjs --no-write-report`

Conclusion: the ledger should accept only narrow, isolated, job-id-bearing worker edits with explicit host verification, and should preserve no-change attempts as failures rather than proof.
XQ3_USAGE_LEDGER_DOCS_REVIEW_DONE
