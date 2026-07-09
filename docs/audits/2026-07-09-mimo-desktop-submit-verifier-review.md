# Desktop Submit Verifier Fix -- Bypass Review

**Date:** 2026-07-09
**Scope:** Bypass (read-only) review of the main-thread desktop submit verifier fix
**Allowed output:** This file only

---

## Commits Reviewed

| Commit | Subject |
|--------|---------|
| `9d818aed` | `fix: confirm desktop submits from websocket payloads` |

Files touched by that commit:

- `scripts/test-anticodex-ui-chat-smoke.mjs` (52 ins, 34 del)
- `findings.md` (4 ins)

---

## What Changed (Summary)

The desktop local-project smoke lane in `test-anticodex-ui-chat-smoke.mjs`
previously treated submit success as a purely **UI-state signal**: composer
clearing, visible-marker timing, or send-button click acknowledgement. If the
desktop client was slow to clear the composer after the click, the verifier
reported "send click did not submit the composer prompt" even though the
backend had already received the `response.create` request.

The fix introduces **Responses-websocket payload confirmation** as an
additional (and stronger) submit signal:

1. After the click-and-send-button probe, the verifier now calls
   `waitForRealResponsesSubmitAfter(baseUrl, submitPayloadsBefore, timeout)`
   **before** checking the UI-state result.
2. If the websocket confirms a new payload and `submitSucceeded` was still
   `false`, the verifier sets `submitConfirmedBy = "responses-websocket"` and
   flips `submitSucceeded = true`.
3. The same pattern was applied to the **CDP mouse enter fallback** code
   path (the outer block starting around the `if (submitSucceeded)` that
   handles the non-programmatic click).
4. In the retry path and the `maxInputItems` gate, the cached
   `submitEvidence.realSubmit` value is reused when available, avoiding a
   redundant (and possibly slower) second websocket wait.

### Specific code flow after the fix

```
click send button
        |
        v
waitForRealResponsesSubmitAfter (20 s when UI-state failed, 15 s when it passed)
        |
        +---> websocket ok? --> submitConfirmedBy = "responses-websocket"
        |
        v
if submitSucceeded && realSubmit?.ok !== true  --> retry flow
```

---

## Blocking Issues Found

**None.**

The fix is narrowly scoped to the test verifier. No production runtime code,
no release-gate logic, no account/credential files, and no scripts outside the
smoke test were modified.

---

## Non-Blocking Observations

### 1. Timeout budget asymmetry

The fix increases the websocket wait from a flat 15 s to **20 s** when the
UI-state path failed (`submitSucceeded ? 15_000 : 20_000`). This is sensible
because the UI signal is already known to be stale in that branch, so the
verifier needs more patience for the websocket to arrive. No concern here,
but worth noting for future timeout tuning.

### 2. Cached realSubmit in retry path

The retry path reuses `submitEvidence.realSubmit` from the first attempt:

```js
const realSubmit = submitEvidence.realSubmit ||
  await waitForRealResponsesSubmitAfter(baseUrl, submitPayloadsBefore, 15_000);
```

This is correct for the retry case because the retry click is a fresh click
with a fresh `retryPayloadsBefore` snapshot -- the `submitEvidence.realSubmit`
from the first click would not match and the `||` branch would trigger. The
code path is safe.

### 3. Local-project lane remains a guard-backed artifact lane

The fix strengthens the local-project smoke lane, but the commit message and
`findings.md` entry both note this lane is still **not** equivalent to
coding/complex/agentic task evidence. Stronger model-led proof should come
from the coding, complex, and agentic task lanes. This is a pre-existing
boundary, not a regression.

---

## Remaining Risks

| Risk | Severity | Notes |
|------|----------|-------|
| Slow backend could exhaust even the 20 s window | Low | The websocket wait already has a generous timeout; extremely slow backends would also break the UI-state check. Mitigation: the retry flow covers the empty-prewarm case. |
| WebSocket payload arrives from a previous unrelated request | Low | `waitForRealResponsesSubmitAfter` takes a `submitPayloadsBefore` snapshot and only counts payloads that arrived after the click. Stale payloads from before the snapshot are excluded. |
| No regression in the non-desktop (browser) lane | None observed | The changes are guarded by the desktop-specific code paths. The browser lane was not modified. |

---

## Conclusion

Commit `9d818aed` is a **correct, narrowly-scoped verifier fix** that resolves
a real false-negative in the desktop local-project smoke lane. It replaces a
fragile UI-timing heuristic with a websocket payload confirmation signal,
while preserving the existing retry and input-guard flows. No blocking issues
were found. The change does not affect production runtime code.
