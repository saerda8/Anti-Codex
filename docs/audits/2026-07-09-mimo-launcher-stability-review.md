# Launcher Stability Review - 2026-07-09

Scope: review the launcher fixes in `scripts/install-anticodex.ps1` and
`scripts/start-deepcodex.ps1`.

## Findings

- `install-anticodex.ps1` no longer launches a nested `powershell.exe` to patch
  the host icon. That matches the observed `Access is denied` failure in this
  environment.
- The icon patcher is now invoked in the current PowerShell session. Its script
  uses `throw` and `ErrorActionPreference = "Stop"`, so a failed patch still
  fails the install path without relying on a child process.
- The old `$LASTEXITCODE` check was removed after the in-process switch because
  script invocation does not make that value a reliable success signal.
- `start-deepcodex.ps1` now treats a missing main-window handle while
  `Anti-Codex.exe` is still alive as a stale handle, clears the handle, and
  keeps monitoring instead of classifying it as a user close.
- This matches the observed startup failure where the launcher wrote a normal
  close message and then let the runtime disappear while the product was still
  recovering its window/CDP state.

## Remaining Risk

- If the main window handle repeatedly disappears for a long time while the
  process stays alive, the launcher will keep waiting instead of escalating.
  That is safer than killing a valid startup, but a future focused guard could
  add a bounded retry counter.

## Verdict

The fixes are scoped to the install and launcher paths and directly match the
observed failures. Keep the current verification requirement: runtime sync,
desktop UI state, real-click manager close test, and release gates must pass
before treating this as closed.
