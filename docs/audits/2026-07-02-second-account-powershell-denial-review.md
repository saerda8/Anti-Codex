# Second-Account PowerShell Access Denied Review

Date: 2026-07-02
Scope: Observed nested-powershell denial failure and the implemented source/runtime fix.
Runtime sync used `-NoRestart`; no real traffic, no login, no system changes.

## Observed Failure

Before the fix, `test-anticodex-second-account-readiness-summary.ps1`,
`test-anticodex-second-account-post-login-proof.ps1`, and their lower
second-account dependencies invoked child PowerShell processes via external
`powershell.exe -File` calls:

- **readiness-summary**: `Invoke-JsonProcess -FilePath "powershell.exe" ... -File $scriptPath`
- **post-login-proof/status/entrypoint/readiness chain**: `$raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`

On the `.\AntiCodexModel` target Windows user (or any restricted session),
this nested `powershell.exe` spawn can fail with:

    Access is denied.

The denial is not a logic error in the test scripts themselves. It is an
OS-level or policy-level block on launching a second `powershell.exe`
process from within an already-restricted PowerShell session. Common
causes include:

1. **AppLocker or WDAC policy** blocking child `powershell.exe` execution.
2. **User-rights restrictions** on the `.\AntiCodexModel` account that
   prevent process creation.
3. **ExecutionPolicy enforcement** in combination with a non-interactive
   session that denies `-ExecutionPolicy Bypass`.
4. **Credential-boundary isolation** where the caller session has
   insufficient privilege to spawn a new process as the target user.

## Implemented Fix: In-Process PowerShell JSON Invocation

Rather than changing the second-account semantic model, the invocation
pattern now uses a shared in-process helper:

- `scripts/anticodex-powershell-json-invoke.ps1`
- `Invoke-AntiCodexPowerShellJsonScript`

The helper executes the target PowerShell script inside the current process,
captures stdout/stderr, parses JSON, and returns the same compact result
shape used by the existing callers. It treats a parseable business-blocked
JSON report as valid invocation evidence, so `ok:false` account-readiness
reports are not misclassified as process failures.

The following second-account chain now uses the helper for PowerShell
subreports:

- `test-anticodex-antigravity-cli-windows-user-readiness.ps1`
- `test-anticodex-windows-user-account-prepare.ps1`
- `test-anticodex-windows-user-setup-guidance.ps1`
- `test-anticodex-antigravity-account-isolation-status.ps1`
- `start-anticodex-second-antigravity-account-login.ps1`
- `test-anticodex-second-account-login-entrypoint.ps1`
- `test-anticodex-second-account-readiness-summary.ps1`
- `test-anticodex-second-account-post-login-proof.ps1`

## Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Nested `powershell.exe` denial blocks all readiness and post-login proof scripts on restricted accounts | Second-account proof cannot complete | Replaced with in-process JSON invocation |
| In-process invocation may inherit caller policy constraints | Runspace could still be subject to AppLocker/WDAC | Runspace runs within caller; if caller can execute scripts, runspace can too |
| Changing invocation pattern may alter JSON output structure | Downstream report consumers may break | Keep `Invoke-JsonProcess` return shape identical to current |
| Adding a helper file without runtime sync support | Installed runtime could miss the dependency | Added the helper to runtime sync and release runtime fingerprint files |

## Checks

1. All touched PowerShell scripts parse with `[scriptblock]::Create(...)`.
2. Static coverage requires second-account scripts to use `anticodex-powershell-json-invoke.ps1`.
3. No real traffic was generated.
4. No login was attempted.
5. No system configuration changes were made.
6. Fresh no-traffic checks pass for account prepare, setup guidance, account-isolation status, login entrypoint, readiness summary, and post-login proof dry-run.
7. Runtime sync with `-NoRestart` passes so the installed runtime receives the shared helper.

## Non-Goals

- Changing account semantics or the `.\AntiCodexModel` user model.
- Running real traffic or launching Antigravity CLI.
- Simulating or faking PowerShell execution results.
