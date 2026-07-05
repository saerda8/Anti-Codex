# Xiaoqiang worker evidence review - 2026-07-05

Report file was missing before this review.

## Accepted evidence

- The three marker files exist and contain worker-specific text: `2026-07-05-xiaoqiang1-status-marker.md`, `2026-07-05-xiaoqiang2-status-marker.md`, and `2026-07-05-xiaoqiang3-status-marker.md`.
- `findings.md` records a later accepted three-worker project smoke after wrapper isolation: the Xiaoqiang wrapper leak was fixed and the three-worker project smoke passed.
- `findings.md` also records the earlier exact Node word-tally project smoke as passed 3/3, with expected tests/CLI output and no extra files.

## Rejected evidence

- The current marker files are only write markers, not proof of product coverage, real task completion, or traffic-path success.
- Broad current-channel review jobs that timed out or ended with `no_code_changed` / `caller_timeout_no_valid_changes` must not be counted as passing evidence.
- The failed post-prefix-repair smoke with `model_result_error` / missing Claude provider `base_url` is provider config drift evidence, not a passing Xiaoqiang task.
- The parallel xiaoqiang2/xiaoqiang3 marker jobs are contaminated by shared-worktree bleed because both could observe the same broad `docs/audits` scope.

## Next worker scheduling rule

Schedule Xiaoqiang workers only on small, serial, one-output tasks with exactly one writable file per worker, or use isolated worktrees for parallel runs; count success only when the terminal job produces the requested file/check output without timeout or caller-side acceptance gaps.
