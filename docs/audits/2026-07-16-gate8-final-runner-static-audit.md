# Gate 8 Final Runner Static Defect Audit

- Date: 2026-07-16
- Scope: static-only review of the Gate 8 formal long-task runner, quota probe, human long journey, lock wrapper, evidence module, and evidence tests
- Constraint: one quota probe after 08:39, one formal Gate 8 after a 200 marker match

## Files Audited

1. scripts/test-anticodex-gate8-final-long-task.mjs
2. scripts/test-anticodex-gate8-final-long-task.ps1
3. scripts/test-anticodex-gate8-quota-probe.ps1
4. scripts/test-anticodex-human-long-journey.mjs
5. scripts/lib/anticodex-gate8-evidence.mjs
6. translator/tests/anticodex-gate8-evidence.test.mjs
7. docs/FINAL_MIGRATION_PLAN.md

---

## Host Review Verdict

- D-001 is rejected. PowerShell process-environment updates are inherited by child processes started afterward. A direct local probe set `ANTICODEX_LOCK_PROPAGATION_PROBE=1` and the child Node process printed `1`. The existing formal wrapper pattern is valid.
- D-002 is a bounded external quota race, not an actionable code defect. Quota can change immediately after any successful probe; policy permits exactly one request and forbids a second confirmation. The 10-minute maximum remains, and the scheduled operator starts formal Gate 8 immediately after success.
- D-003 is not a current blocker. Live health exposes matching top-level and nested provider/model values. The quota probe's top-level provider check therefore matches the current contract and sends zero requests if the contract drifts.
- D-004 was valid as a diagnostic-only casing inconsistency and is fixed: a case-insensitive match is canonicalized to the fixed route's exact model ID before request/report generation.
- The worker missed the actionable direct-journey gap. `test-anticodex-human-long-journey.mjs` still defaulted to a retired Gemini model and direct migration/greenfield runs lacked the full-run mutex. Host RED/green changes now resolve the current fixed route before traffic and automatically wrap every direct real journey in the shared mutex. Focused coverage passes 56/56.

---

## Defect D-001: Lock wrapper does not propagate lock-held state to child processes

**Severity**: medium
**Files**: scripts/test-anticodex-gate8-final-long-task.ps1:54, scripts/test-anticodex-gate8-final-long-task.mjs:89-113

**Root cause**: The PowerShell lock wrapper sets `$env:ANTICODEX_REAL_TRAFFIC_LOCK_HELD = "1"` (line 54) in the PowerShell process scope. This environment variable does not propagate to the Node child process spawned via `& $NodePath @childArgs` (line 55). Node's `process.env.ANTICODEX_REAL_TRAFFIC_LOCK_HELD` remains `undefined` in the child.

As a result, the formal runner (line 89: `if (process.env.ANTICODEX_REAL_TRAFFIC_LOCK_HELD !== "1")`) always evaluates this condition as `true` and re-enters the PowerShell lock-wrapper path (lines 90-113). The wrapper then attempts to acquire the same lock its parent already holds, producing a contention report (exit 75) instead of deadlocking. This is the correct fail-closed behavior, but it means the lock-held state is never actually communicated from the wrapper to the formal runner's own Node process.

In the quota probe, the same pattern applies: `$env:ANTICODEX_REAL_TRAFFIC_LOCK_HELD = "1"` (line 54 of the formal runner, not in the quota probe) is never set by the quota probe, so the quota probe's child process also cannot signal lock-held state.

**Wasted request scenario**: If two formal runner processes are spawned concurrently and both call the PowerShell wrapper, the second one correctly receives exit 75 (no wasted request). However, if a future code path were to pass `ANTICODEX_REAL_TRAFFIC_LOCK_HELD=1` via Node's `env` option to bypass the wrapper, two concurrent formal runners could both skip lock acquisition and both start real model traffic, wasting up to N formal-task requests (where N is the number of concurrent runners minus one).

**RED test suggestion**: Spawn two formal runner processes with `ANTICODEX_REAL_TRAFFIC_LOCK_HELD=1` injected via Node's `env: { ...process.env, ANTICODEX_REAL_TRAFFIC_LOCK_HELD: "1" }` and verify that at most one succeeds with real traffic. Assert the other exits non-zero or with `usedRealTraffic: false`.

---

## Defect D-002: Quota probe freshness window allows stale probe to pass precondition without re-validating quota availability

**Severity**: medium
**Files**: scripts/test-anticodex-gate8-final-long-task.mjs:69,185-222, scripts/lib/anticodex-gate8-evidence.mjs:5,386-395

**Root cause**: The formal runner's `quotaProbePrecondition` (line 206) validates the probe's `generatedAt` timestamp against `MAX_QUOTA_PROBE_AGE_MS = 10 * 60_000` (line 69). A probe generated up to 10 minutes before the formal runner starts passes this check. The check only validates the report's age, not whether quota is currently available.

The quota probe writes `requestCount: 1` and `ok: true` to its report. The formal runner's precondition (line 202) verifies `requestCount === 1`, confirming exactly one probe request was sent. However, between the probe's successful response and the formal runner's precondition check, up to 10 minutes elapse during which:

- Another client could send model requests and exhaust the quota.
- The Antigravity account's quota window could reset or shift.
- The fixed-route health endpoint could report a different model.

The real-traffic lock serializes the quota probe and formal runner within a single process chain (the probe acquires/releases, then the formal runner acquires via the wrapper). But if the formal runner's precondition check or journey setup takes significant time after acquiring the lock, the quota state proven by the probe may no longer be accurate.

The `quotaProbePrecondition` also does not re-invoke `fixedRouteHealth()` or `accountReadiness()` to verify current state; it trusts the stale probe report for all preflight evidence.

**Wasted request scenario**: Quota probe succeeds at T+0, formal runner starts at T+8 minutes, the Antigravity quota is exhausted between T+0 and T+8 by an external client, the formal runner passes the freshness check, sends the first real long-task request at T+9, receives 429 RESOURCE_EXHAUSTED. One formal-task request wasted.

**RED test suggestion**: Create a loopback fixture that returns HTTP 200 for the quota probe and HTTP 429 for all subsequent requests. Run the quota probe, then advance the fixture's clock by 9 minutes (or use a timestamp injection), then run the formal runner. Assert the formal runner's report contains `ok: false` with a failure mentioning the quota probe or model traffic, and that `usedRealTraffic` is `false` for the formal task (the formal runner should fail at the journey step, not at the precondition, so the formal runner does send one request before failing - this is the wasted request).

---

## Defect D-003: Provider validation inconsistency between quota probe preflight and formal report builder

**Severity**: low
**Files**: scripts/test-anticodex-gate8-quota-probe.ps1:152, scripts/lib/anticodex-gate8-evidence.mjs:655-661

**Root cause**: The quota probe preflight (line 152) validates the fixed-route health response using:

```powershell
$preflight.routeReady = $route.ok -eq $true -and $route.state -eq "ready" -and $route.provider -eq "antigravity"
```

This requires `$route.provider` (the top-level provider field) to equal `"antigravity"`.

The formal report builder's `routeReady` function (evidence.mjs line 655-661) validates using:

```js
(value?.route?.provider || value?.provider) === "antigravity"
```

This accepts either `route.route.provider` (nested) or `route.provider` (top-level).

If the health endpoint returns a response where only `route.route.provider` is `"antigravity"` and the top-level `route.provider` is missing or different, the quota probe preflight would reject the route (`$preflight.routeReady = false`) while the formal report builder would accept it (`routeReady` returns `true`).

This inconsistency means the quota probe is stricter than the formal report. In practice, the health endpoint consistently returns both fields with matching values, so this defect is unlikely to manifest. However, the inconsistency could mask a routing misconfiguration where the quota probe blocks the formal runner for an unclear reason.

**Wasted request scenario**: If the health endpoint returns `route.route.provider = "antigravity"` but `route.provider = undefined`, the quota probe preflight fails before sending any POST request. No request wasted. The formal runner would also fail the quota probe precondition (no valid report). No inconsistency in wasted requests, but the error message ("fixed Antigravity route is not ready") is misleading because the route IS ready from the formal runner's perspective.

**RED test suggestion**: Create a loopback fixture that returns `route.provider` as `undefined` and `route.route.provider` as `"antigravity"`. Run the quota probe and assert it fails with `routeReady: false`. Run the formal report builder with the same health response and assert `routeReady` is `true`. Assert the discrepancy is documented.

---

## Defect D-004: Quota probe model comparison is case-insensitive while formal runner quota probe precondition comparison is case-sensitive

**Severity**: low
**Files**: scripts/test-anticodex-gate8-quota-probe.ps1:163, scripts/test-anticodex-gate8-final-long-task.mjs:203

**Root cause**: The quota probe preflight (line 163) compares the selected model to the fixed-route model using ordinal case-insensitive comparison:

```powershell
$preflight.modelMatchesFixedRoute = [string]::Equals($Model, $fixedRouteModel, [StringComparison]::OrdinalIgnoreCase)
```

If the user passes `--Model Gemini-3-Flash-Agent` and the route returns `gemini-3-flash-agent`, the quota probe accepts the model (case-insensitive match) and stores the user-provided casing in the report (`model = $Model` on line 234).

The formal runner's `quotaProbePrecondition` (line 203) compares the report's model to the selected model using JavaScript's strict inequality:

```js
if (String(report?.model || "") !== selectedModel) failures.push("model");
```

This is case-sensitive. If the quota probe stored `"Gemini-3-Flash-Agent"` (user-provided) and the formal runner derived `"gemini-3-flash-agent"` from the health endpoint, the comparison fails and the formal runner throws before sending any request.

In normal operation, both scripts derive the model from the same `fixedRouteHealth()` response, so the values should be identical. The defect only manifests if a caller passes a differently-cased `--model` argument to the quota probe.

**Wasted request scenario**: If the quota probe succeeds with a case-mismatched model (case-insensitive accept), the formal runner rejects the precondition before sending any request. No request wasted. However, the error message ("model" in the failures list) does not explain the case sensitivity discrepancy, which could cause confusion during debugging.

**RED test suggestion**: Run the quota probe with `--Model Gemini-3-Flash-Agent` against a fixture returning `gemini-3-flash-agent` as the fixed-route model. Assert the probe succeeds (`ok: true`). Then run the formal runner's `quotaProbePrecondition` with `selectedModel = "gemini-3-flash-agent"` and the probe report. Assert it throws with `"model"` in the failures. This confirms the case sensitivity gap.

---

## No Actionable Defect: Formal runner correctly prevents duplicate formal tasks

The formal runner's lock-wrapper path (lines 89-113) ensures that only one formal runner holds the real-traffic lock at any time. The quota probe precondition (lines 185-222) is read-only (no model traffic) and runs after the lock is acquired. The journey (line 333) runs synchronously via `spawnSync` while the lock is held. The compaction (line 376) runs synchronously within the same lock scope. No code path allows a second formal runner to start while the first is alive, because the PowerShell wrapper's `Enter-AntiCodexRealTrafficLock` with `WaitSeconds 0` returns `acquired: false` and exits with code 75.

## No Actionable Defect: Formal runner correctly prevents duplicate quota probes

The quota probe script (test-anticodex-gate8-quota-probe.ps1) acquires the real-traffic lock (line 117) before sending any POST request (line 176). The lock is released in the `finally` block (line 274). No code path allows two concurrent quota probes. The formal runner does not re-run the quota probe; it only reads the existing report file.

## No Actionable Defect: Turn evidence validation is comprehensive

The formal report builder's `turnContractsPassed` (evidence.mjs lines 426-445) validates every turn for: `ok`, `usedRealTraffic`, `modelProofValid`, `completionSeen`, `hasNonEmptyScopedCommand`, `scopedCommandCallIdsValid`, `rolloutToolOutputEvidence`, `rolloutPreCommandEvidence`, `launchCommandCount === 0`, `postFinalToolCallCount === 0`, `postFinalToolOutputCount === 0`, `duplicateCommandCount === 0`, `parseErrorSeen !== true`, and `scopeViolationCount === 0`. The human long journey's `checkTurn` (human-long-journey.mjs lines 366-397) independently validates the same set. The evidence tests (lines 189-205) verify these checks exist in source. No gap found.

## No Actionable Defect: Model proof chain is sound

The `buildTurnModelProof` function (evidence.mjs lines 222-282) requires `usedRealTraffic`, `requiredModelMatches`, `selectionMatched`, `preSubmitSelectionMatched`, and at least one proof source (`marker-scoped-submit` or `new-model-route`). The `evaluateGate8TurnEvidence` function (lines 168-220) additionally validates `observedModels` match the selected model and that proof source flags are consistent. The formal report builder counts `modelProvenTurns` and requires all 8 turns to pass. The human long journey's `runUiTurn` (lines 251-324) calls `buildTurnModelProof` on every turn and sets `ok` to `false` if the proof fails. No gap found.
