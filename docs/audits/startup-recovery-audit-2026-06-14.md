# Anti-Codex Startup And Recovery Audit

## Verified Result

- Cold relaunch completed with one Anti-Codex main process, one translator, one launcher, account-ready state, and eight models.
- The original Codex process set remained unchanged during cold relaunch and restart-refresh fallback.
- The launcher watchdog restores the translator and Antigravity Desktop, while maintenance markers prevent recovery from racing host synchronization.
- Anti-Codex starts hidden through installed shortcuts, so normal users do not depend on a visible PowerShell window.

## Fixed Gaps

- Host synchronization now builds and validates a separate candidate before activation.
- Candidate validity is bound to SHA-256 hashes of the executable, app package, and bundled CLI.
- A forced critical branding failure leaves no valid candidate marker and does not change the active host.
- Restart-refresh fallback now forces live Antigravity model discovery instead of reusing a previous account catalog.
- Operational and verification scripts now share a dynamic endpoint resolver instead of pinning the current private address.
- Failed translator watchdog restarts now enter a 30-second cooldown instead of repeatedly blocking the launcher recovery loop.

## Residual Risks

- Elevated and non-elevated process ownership mismatches can limit process discovery on Windows.
