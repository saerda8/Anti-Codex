# Anti-Codex Manager UI Gap Audit

Date: 2026-06-22
Status: fixed in Manager `native-panel-v77`

This file replaces an earlier Antigravity worker report that was saved with broken text encoding. The original audit was still useful: it pointed at several Manager UX issues that could make the panel feel stale or unreliable. Those findings have now been reconciled against the current source.

## Fixed Findings

1. Reopening an already-open embedded Manager now refreshes the existing panel instead of leaving stale status visible.

2. Closing the embedded Manager now clears the background status timer, so the closed panel does not keep polling `/health`.

3. High-impact actions now check whether another action is already running or pending before asking the user for the second confirmation click.

4. The installed UI verifier now refreshes an already-open Manager panel before reading state, so a stale test overlay no longer creates a false failure.

## Verification

- `node --check scripts/anticodex-manager-inject.js`
- `node --check scripts/anticodex-manager-open-inject.js`
- `node --check scripts/test-anticodex-ui-state.mjs`
- `node --test translator/tests/anticodex-launcher.test.mjs`
- Installed UI state verification passed after the v77 runtime sync.

## Remaining Risk

The embedded Manager should still be covered by the combined installed acceptance pass after larger UI or launcher changes, because repeated desktop automation probes can leave the live window stale. If that happens, cold-relaunch Anti-Codex before judging the product state.
