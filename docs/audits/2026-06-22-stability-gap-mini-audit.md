# Anti-Codex Stability Gap Mini-Audit

Date: 2026-06-22
Scope: remaining long-term reliability risks after green installed runtime checks.
Format: ASCII only.

## Top Risks

1. Native continuation cleanup needs stronger proof.
   Risk: abandoned native tool continuations can hold state until cleanup paths run.
   Status: fixed by native bridge pending-call timeout plus upstream `NATIVE_CONTINUATIONS` TTL/failed-resume unit tests.
   Release blocking: no, but important for long sessions.

2. Resumed native continuation retry is intentionally conservative.
   Risk: after tool output is submitted, transient Antigravity Desktop failures can drop the final assistant reply.
   Status: fixed for pre-event transient failures. Upstream resume now retries without cancelling the Cascade between attempts, and agentapi exposes `cancelOnError:false` for that retry path.
   Release blocking: no, because current native real-tool verifiers pass.

3. Stability soak evidence was not visible in Manager.
   Risk: the soak could pass but users had to inspect terminal output; Manager latest reports did not show it.
   Status: fixed in this batch by writing `latest-stability-soak.json` and adding it to Manager latest report discovery.
   Release blocking: fixed.

4. Long-task status is summary-first, not log-live.
   Risk: for slow sync/post-verification actions, users may not know whether a task is still progressing or only stale.
   Status: fixed with structured diagnostics fields `latestLogLine`, `logUpdatedAt`, and `logAgeMs` on long-task entries.
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

Next practical installed check remains a short installed stability soak from the synced runtime, when the operator is ready to run longer installed/runtime evidence.
