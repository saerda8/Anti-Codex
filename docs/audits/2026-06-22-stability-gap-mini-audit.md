# Anti-Codex Stability Gap Mini-Audit

Date: 2026-06-22
Scope: remaining long-term reliability risks after green installed runtime checks.
Format: ASCII only.

## Top Risks

1. Native continuation cleanup needs stronger proof.
   Risk: abandoned native tool continuations can hold state until cleanup paths run.
   Next check: add or run a continuation-abandonment unit test that proves pending continuations are evicted after timeout/cancel.
   Release blocking: no, but important for long sessions.

2. Resumed native continuation retry is intentionally conservative.
   Risk: after tool output is submitted, transient Antigravity Desktop failures can drop the final assistant reply.
   Next check: add a verifier for same-Cascade resume after one transient desktop failure that occurs before any Codex-visible event.
   Release blocking: no, because current native real-tool verifiers pass.

3. Stability soak evidence was not visible in Manager.
   Risk: the soak could pass but users had to inspect terminal output; Manager latest reports did not show it.
   Status: fixed in this batch by writing `latest-stability-soak.json` and adding it to Manager latest report discovery.
   Release blocking: fixed.

4. Long-task status is summary-first, not log-live.
   Risk: for slow sync/post-verification actions, users may not know whether a task is still progressing or only stale.
   Next check: expose latest log line and age for background tasks in diagnostics.
   Release blocking: no.

5. Worker review output remains unreliable.
   Risk: DeepSeek/Antigravity worker review tasks can exit successfully while producing empty or mojibake content.
   Status: rules now require main-agent inspection; empty/mojibake output is failed evidence.
   Release blocking: no, because product verification does not depend on worker text.

## Current Evidence

- Installed fast no-traffic overall passed after the guard-wording changes.
- Real native tool loop passed after the streaming retry change.
- Real work verifier passed with file creation, node_repl MCP execution, and Chinese continuation.

## Next Practical Step

Run a short installed stability soak from the synced runtime and verify that `latest-stability-soak.json` appears in Manager latest reports.
