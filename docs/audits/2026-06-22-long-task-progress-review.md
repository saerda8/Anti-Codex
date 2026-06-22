# Anti-Codex Long Task Progress Review

Date: 2026-06-22

## Existing Evidence

- `postVerificationFull` already writes progress into `latest-post-verification.json`.
- `syncHost` exposes sync operation state through the existing `updateStatus.operation` structure.
- Manager already has timer text while an action is running, but the status cards were too coarse after refresh.

## Gap

- The Manager did not have one compact place that answered: which long task is running, what stage it is in, and where the latest report is.
- Users had to infer progress from separate sync and post-verification cards.

## Implemented Direction

- Add a unified `longTasks` diagnostics summary.
- Show a read-only "background tasks" card in both embedded Manager and fallback Manager.
- Keep it local-only: it reads local status and report summaries, and does not consume Antigravity traffic.
