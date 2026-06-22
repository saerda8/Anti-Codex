# Anti-Codex Final Reliability Closure

Date: 2026-06-16

## Result

The installed Anti-Codex runtime passed the final reliability closure after a real rollback and a real guarded sync.

## Verified

- Anti-Codex remains independent from the original Codex runtime and account.
- The installed app and taskbar identity are Anti-Codex.
- No ChatGPT login or reconnect text appears in the installed UI.
- Eight exact Antigravity model routes passed live marker requests.
- Codex-facing tools, native Antigravity MCP calls, skills, MCP configuration, compaction resume, cancellation, streaming, and proxy/account readiness passed the installed overall verifier.
- A real rollback returned only after the app and gateway became healthy.
- A real guarded sync retained a valid rollback checkpoint and passed post-sync verification.
- A three-minute soak passed with 33 health checks and a stable translator PID.
- Source regression: 435 tests, 401 passed, 34 skipped, 0 failed.

## Remaining Explicit Boundaries

- Responses WebSocket remains an intentional verified `501 unsupported_websocket` fallback because the copied Codex host does not expose a verified native model Responses WebSocket protocol.
- Switching to a different Antigravity account requires the user to complete the account change in Antigravity Desktop and restart Anti-Codex. The workflow now refuses to claim success when no change is observable.
- Deliberately breaking and restoring Antigravity's external proxy requires user interaction. Anti-Codex-to-Antigravity local traffic bypasses that proxy, and the guided diagnostic drill is installed.
