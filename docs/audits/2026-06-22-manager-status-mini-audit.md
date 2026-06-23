# Anti-Codex Manager Status Mini-Audit

Date: 2026-06-22
Scope: Manager status and report visibility.
Format: ASCII only.

## Findings

1. Latest reports were missing stability soak evidence.
   The Manager listed fast overall, full overall, post verification, real work, real mini tool, source preflight, and account/proxy reports, but not the stability soak report.
   Status: fixed in this batch by adding `latest-stability-soak.json`.

2. Long-running tasks show summaries, not live logs.
   The Manager background task card originally showed state, stage, elapsed time, failures, and report path, but not structured freshness.
   Status: fixed on 2026-06-23 by rendering structured `latestLogLine` and `logAgeMs` from diagnostics in both Manager surfaces. The implementation does not tail raw logs.

3. Report paths are plain text.
   This is acceptable for now because the Manager is embedded in the Codex shell and should stay low-risk. A future read-only "copy report path" or "open report folder" action would improve usability.

4. Connector/plugin numbers need careful wording.
   The product already treats connector/app tool state as metadata-only when authorizations are unavailable. Keep wording explicit so users do not confuse catalog size with callable tools.

5. Reconnect status is covered by UI state checks.
   The installed UI verifier already checks for login/reconnect text. Manager can later surface retry counters from diagnostics, but the current absence of reconnect text is already verified.

## Low-Risk Next Improvement

No low-risk Manager visibility gap is open in this audit. Remaining checks are installed/runtime acceptance gates and should be run only when the operator is ready for longer or real-traffic verification.
