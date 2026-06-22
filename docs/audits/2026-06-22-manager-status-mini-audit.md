# Anti-Codex Manager Status Mini-Audit

Date: 2026-06-22
Scope: Manager status and report visibility.
Format: ASCII only.

## Findings

1. Latest reports were missing stability soak evidence.
   The Manager listed fast overall, full overall, post verification, real work, real mini tool, source preflight, and account/proxy reports, but not the stability soak report.
   Status: fixed in this batch by adding `latest-stability-soak.json`.

2. Long-running tasks show summaries, not live logs.
   The Manager background task card shows state, stage, elapsed time, failures, and report path. It does not yet show the latest live log line.
   Recommended next improvement: expose latest log tail and log age from diagnostics.

3. Report paths are plain text.
   This is acceptable for now because the Manager is embedded in the Codex shell and should stay low-risk. A future read-only "copy report path" or "open report folder" action would improve usability.

4. Connector/plugin numbers need careful wording.
   The product already treats connector/app tool state as metadata-only when authorizations are unavailable. Keep wording explicit so users do not confuse catalog size with callable tools.

5. Reconnect status is covered by UI state checks.
   The installed UI verifier already checks for login/reconnect text. Manager can later surface retry counters from diagnostics, but the current absence of reconnect text is already verified.

## Low-Risk Next Improvement

Add stability soak to latest report discovery, then verify the installed Manager `viewLatestReports` action returns that report after a short soak.
