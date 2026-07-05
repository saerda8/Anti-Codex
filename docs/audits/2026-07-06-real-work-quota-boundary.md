# Real Work Quota Boundary - 2026-07-06

## Scope

This audit covers `latest-real-work.json` and `latest-real-small-project.json` after the user observed that the provider quota dashboard did not visibly decrement.

## Local Evidence Now Summarized

`realWorkEvidence` exposes bounded local evidence:

- `firstResponseId` and `callId` for local request correlation.
- artifact `exists`, `ran`, and `markerMatched`.
- executor `tool`, `realFileWrite`, and real MCP success booleans.
- final-text booleans for `FILE_OK` and Chinese output.
- `localRequestEvidencePresent`.

`realSmallProjectEvidence` exposes bounded local evidence:

- `firstResponseId` and `callId` for local request correlation.
- artifact `testPassed`, `cliPassed`, and `markerMatched`.
- final-text booleans for `SMALL_PROJECT_OK` and Chinese output.
- `localRequestEvidencePresent`.

Both summaries set:

- `externalQuotaDecrementProven:false`
- `externalQuotaEvidence:"not_collected"`

## Boundary

These reports can prove local Anti-Codex request, tool, artifact, MCP, test, and CLI execution evidence. They cannot prove external provider quota or billing decrement.

A quota decrement claim still requires provider-side before/after evidence such as a dashboard/API usage capture for the same account, quota bucket, and run window, plus a concurrency note proving no unrelated activity explains the delta.
