# Gate 8 Rehearsal Review: Smallest Isolated Deterministic Long-Task Proof

- Date: 2026-07-15
- Author: architecture audit
- Gate under review: Gate 8 (Final long-task acceptance gate)
- Gate definition source: `THREE_LAYER_ARCHITECTURE.md` section 6, gate 8
- Constraint: rehearsal must not be mistaken for final Antigravity evidence

---

## 1. What Gate 8 Requires

Gate 8 is defined as the final long-task acceptance gate that runs only after all three product parts (Layer 1 shell, Layer 2 CodexPlusPlus, Layer 3 thin Antigravity adapter) reach 100% implementation completion. It must demonstrate:

1. **Repeated edits** across multiple user turns within a single task.
2. **Tests** executed by Codex native harness, results fed back to model.
3. **User dialogue and correction** mid-task without Cascade/adapter taking over.
4. **Native compaction** and same-thread resume after context pressure.
5. **Quota handling** that fails promptly and does not retry the same exhausted model.
6. **No replay** of stale or repeated responses.
7. **Host-verified artifacts**: files, byte hashes, command exit codes, test results, process state.
8. **Visible long project** run against the production three-layer stack.

The gate cannot pass with model prose, local green summaries, markers, or report freshness alone.

## 2. Current Gate Progress Context

Based on the accessible audit documentation:

| Gate | Status | Evidence |
|------|--------|----------|
| Gate 1 (Isolation patch) | Complete | 9/9 repository isolation, 20/20 runtime isolation |
| Gate 2 (Third-party no-traffic) | Complete | 27/27 against fake Chat provider; zero model traffic |
| Gate 3 (Provider contract) | Complete | 19/19 deterministic plus one real native-tool continuation |
| Gate 4 (Route switch) | Complete | 23/23 with one real native file-tool; old route fingerprint unchanged |
| Gate 5 (Component integration) | Headless preparatory 32/32; visible short integration pending | Current product completion ~76% per three-layer route |
| Gate 6 (Bounded edge) | Pending (blocked by Gate 5) | Preparatory evidence exists for adapter restart, cancellation, client restart/crash-same-task-resume |
| Gate 7 (Component completion) | Not started | Old active-path code not yet removed |
| Gate 8 (Final long-task) | Not started | Requires all three parts at 100% |

**Critical prerequisite**: Gate 8 cannot begin until Gates 5, 6, and 7 pass. This review designs the rehearsal so it is ready to execute once prerequisites are met.

## 3. Rehearsal Design: Minimum Viable Gate 8

### 3.1 Principle: Smallest Deterministic Scope

The rehearsal uses the **existing copied Codex shell** plus **upstream CodexPlusPlus** and a **scripted local Chat provider** (no Antigravity traffic). This makes it a rehearsal of the *Codex harness's long-task behavior through the CodexPlusPlus third-party route*, not a test of the Antigravity adapter. The key insight: if the harness cannot handle multi-turn edits, user correction, compaction, and same-thread resume through a standard third-party Chat API, it cannot do so through the Antigravity adapter either. The adapter is thinner, not more capable.

### 3.2 Rehearsal Scenario: 4-Turn File Project with Correction and Compaction

**Turn 1 — Create**: User asks Codex to create a small project (3 files: `counter.mjs`, `counter.test.mjs`, `package.json`).
- Fake provider returns a structured `tool_calls` array with `shell_command` or `apply_patch` to create each file.
- Second Chat request receives tool results and returns a completion message.
- Host verifies: 3 files exist, byte-exact content, `node:test` passes.

**Turn 2 — User correction**: User says "the test is wrong, `countTo` should include the endpoint."
- Same `previous_response_id` / thread continues.
- Fake provider returns updated patch for `counter.test.mjs` and a re-run test command.
- Host verifies: test file changed, test still passes, `counter.mjs` byte-identical to turn 1.

**Turn 3 — Pressure and compaction**: User sends a long context payload (128KB of padded history) to trigger compaction.
- Codex harness triggers `/responses/compact`.
- Fake provider returns a `context_compaction` summary.
- User sends a follow-up question referencing an early turn detail.
- Fake provider uses the compact summary to produce a correct answer referencing the original detail.
- Host verifies: compact endpoint was called exactly once, summary is present in history, follow-up answer is factually correct.

**Turn 4 — Same-thread resume after simulated interruption**: The test harness kills and restarts the Codex CLI process mid-turn.
- After restart, user sends a new message in the same thread.
- Codex harness reconstructs state from local native conversation files (not from adapter).
- Fake provider receives the reconstructed context and responds.
- Host verifies: the resumed conversation correctly references prior turns, no duplicate tool execution, zero stale replay.

### 3.3 Why This Covers All Gate 8 Requirements

| Requirement | How covered |
|-------------|-------------|
| Repeated edits | Turns 1 and 2 modify different files; turn 2 corrects turn 1 output |
| Tests | Turn 1 creates and runs tests; turn 2 fixes and re-runs |
| User correction | Turn 2 is a mid-task correction that changes only the targeted file |
| Native compaction | Turn 3 triggers compact with a large context payload |
| Same-thread resume | Turn 4 restarts CLI and resumes in the same conversation |
| Quota | Fake provider returns a 429 on one request; harness must fail that request and not retry the same model |
| No replay | Host checks that no tool output or assistant message appears twice |
| Host-verified artifacts | Every turn ends with host-side byte hash, exit code, and process count verification |

### 3.4 Why This Is Not Final Antigravity Evidence

The rehearsal deliberately uses:
- **Local fake Chat provider** on loopback (`127.0.0.1`), not Antigravity.
- **CodexPlusPlus third-party route**, not the Layer 3 Antigravity adapter.
- **Scripted deterministic responses**, not live model inference.

This proves the *Codex harness long-task behavior* is sound. Final Antigravity evidence (real model, real Cascade, real MCP tool bridge) is a separate gate that layers on top of this proven foundation.

## 4. Reusable Code and Assets

### 4.1 Directly Reusable from Gate 2

| Asset | Source | Reuse in Gate 8 Rehearsal |
|-------|--------|---------------------------|
| `scripts/fixtures/codexplusplus-gate2/fake-chat-server.mjs` | Gate 2 fixture | Extend with compaction response handler and quota-error injection mode |
| `scripts/fixtures/codexplusplus-gate2/fake-chat-server.test.mjs` | Gate 2 test | Add test cases for compact response, 429 quota error, and multi-turn history accumulation |
| Gate 2 probe/lib infrastructure | `scripts/lib/codexplusplus-gate2-probe.mjs` | Reuse protocol proxy startup, CDP connection, and candidate executable launch |
| CodexPlusPlus launcher and isolation patch | `third_party/codexplusplus/` | Unchanged; same binary, same isolation config |

### 4.2 Directly Reusable from Gate 3/4

| Asset | Source | Reuse in Gate 8 Rehearsal |
|-------|--------|---------------------------|
| Gate 4 route-switch harness | `scripts/test-codexplusplus-third-party-route.mjs` (if present) | Orchestrate candidate launch, fake provider binding, and process snapshot |
| Process snapshot and cleanup | Gate 4 JSON structure | Before/during/after process tracking for original Codex, Anti-Codex, and candidate |

### 4.3 Directly Reusable from Gate 5/6 Preparatory Evidence

| Asset | Source | Reuse in Gate 8 Rehearsal |
|-------|--------|---------------------------|
| Compaction contract test structure | `scripts/test-anticodex-native-compaction-resume.mjs` (Gate 6 prep) | Adapt pattern: trigger compact, verify summary, resume with summary context |
| Human long-journey verifier pattern | `scripts/test-anticodex-human-long-journey.mjs` (Gate 6 prep) | Adapt scope-violation checks: deny private dirs, require per-turn final reply |
| Gate 8 final long-task test skeleton | `scripts/test-anticodex-gate8-final-long-task.mjs` (if skeleton exists) | Use as structural starting point if it exists; if not, build from scratch |

### 4.4 Reusable Architecture Pieces

| Piece | Value |
|-------|-------|
| `THREE_LAYER_ARCHITECTURE.md` section 6 gates | Defines the exact acceptance criteria |
| Gate 2 fake-chat-server request log | Verifiable proof of no Antigravity traffic |
| Gate 4 process-snapshot pattern | Before/after fingerprinting for original Codex and Anti-Codex |
| Existing host-verifier patterns (from Gate 6 prep) | File hash, test runner, process count, scope-violation, and stable-idle checks |

## 5. Missing Pieces

### 5.1 Fake Provider Enhancements (Must Build)

| Missing | Why needed | Estimated scope |
|---------|-----------|-----------------|
| `/v1/responses/compact` handler | Gate 2 fake server does not handle compact requests | ~50 lines: parse compact input, return a deterministic summary referencing a seeded fact |
| Quota error injection mode | Gate 2 fake server has auth/quota error modes but not a mid-conversation 429 that halts one specific model | ~20 lines: track request count, return 429 on Nth request for a tagged model |
| Multi-turn history accumulator | Gate 2 fake server records requests but does not validate `previous_response_id` chains | ~30 lines: assert that turn N+1 carries the response ID from turn N |
| Tool-call-to-file-write simulation | Gate 2 fake server returns tool results but does not write files to a workspace | ~40 lines: parse `apply_patch` / `shell_command` tool calls, write to temp workspace, return output |
| Same-response replay detector | Gate 8 requires proof of no replay | ~15 lines: compare assistant messages across turns, fail if identical text appears twice |

### 5.2 Orchestration Script (Must Build)

A new orchestration script (e.g., `scripts/test-gate8-rehearsal.mjs`) that:

1. Starts the fake chat server with enhanced handlers.
2. Launches CodexPlusPlus in headless-helper mode against the copied Codex candidate.
3. Binds the protocol proxy to the fake server.
4. Creates a temporary workspace directory.
5. Drives 4 turns via Codex CLI stdin/JSONL.
6. After each turn, runs host-side verification (file hashes, test execution, process counts).
7. Triggers compaction in turn 3 by sending a large context payload.
8. Kills and restarts CLI for turn 4 resume.
9. Asserts quota failure handling at the designated turn.
10. Produces a structured JSON report following the Gate 2/4 schema convention.

Estimated scope: ~300-400 lines of orchestration code.

### 5.3 Test Cases (Must Build)

| Test | Validates |
|------|-----------|
| fake-chat-server compact handler returns deterministic summary | Compaction produces a valid, resumable summary |
| fake-chat-server quota mode returns 429 on tagged model | Quota failure is injectable and observable |
| fake-chat-server history chain validation | `previous_response_id` continuity across turns |
| fake-chat-server file-write simulation | Tool calls produce real workspace artifacts |
| fake-chat-server replay detector | No identical assistant text across turns |
| orchestration: 4-turn full scenario passes | End-to-end rehearsal succeeds |
| orchestration: host verification per turn | File hashes, test results, process counts match |
| orchestration: original Codex processes unchanged | Isolation maintained throughout |

### 5.4 Gate 7 Dependency (External)

Gate 7 (old active-path code removal) must complete before Gate 8 runs. This is a prerequisite, not something the rehearsal can substitute. The rehearsal should be structured so it can be validated against the post-Gate-7 codebase.

## 6. Contamination Risks

### 6.1 Risk: Rehearsal Evidence Mistaken for Final Antigravity Proof

**Severity: HIGH**

The rehearsal uses a fake provider, not Antigravity. If the report does not explicitly state this, a future gate review might accept it as proof of the full three-layer stack.

**Mitigation**: The report JSON must include:
- `"modelTraffic": "loopback fake provider only"` (same as Gate 2 convention)
- `"gate": "Gate 8 rehearsal: CodexPlusPlus third-party long-task proof"`
- `"antigravityTraffic": false`
- `"adapterInvolved": false`
- A `"note"` field: "This rehearsal proves Codex harness long-task behavior through the standard third-party Chat route. It does not exercise the Antigravity Chat Adapter, Antigravity Cascade, or any real model traffic."

### 6.2 Risk: Fake Provider Hides Real Protocol Gaps

**Severity: MEDIUM**

A scripted provider always returns well-formed responses. It cannot discover streaming edge cases, malformed upstream JSON, or real-world latency behavior.

**Mitigation**: The fake server must include at least:
- One response with a malformed JSON chunk (to test error mapping).
- One response with a delayed tool-call delta (to test streaming reassembly).
- One response with a `null` finish reason (to test incomplete handling).

These are already partially covered by Gate 2; extending them is incremental.

### 6.3 Risk: Compaction Is Not Triggered by Real Harness

**Severity: MEDIUM**

The fake server can return a compact response, but the Codex harness may not trigger compact unless the actual context window exceeds a threshold. The 128KB padding payload must be sized to guarantee compact trigger.

**Mitigation**:
- Check Gate 6 preparatory evidence for the exact compact trigger threshold.
- If the threshold is unknown, instrument the fake server to log whether a compact request arrives.
- As a fallback, test compact via direct API call to the protocol proxy (as Gate 6 prep already does).

### 6.4 Risk: Same-Thread Resume Depends on Native Codex State

**Severity: LOW (but critical to verify)**

The turn 4 resume depends on Codex's native conversation files, not on the adapter. If the candidate Codex shell does not persist conversation state correctly, resume fails regardless of the adapter.

**Mitigation**:
- Turn 4 must verify that the conversation JSONL exists in the candidate's `CODEX_HOME` before restart.
- After restart, verify the CLI loads the correct conversation and the fake server receives the reconstructed history.
- This is the same pattern Gate 6 prep already uses for `test-anticodex-native-compaction-resume.mjs`.

### 6.5 Risk: Quota Injection Conflicts with Compaction

**Severity: LOW**

If the 429 is injected during the same turn as compaction, the test becomes ambiguous.

**Mitigation**: Sequence the quota injection to turn 2 (correction turn), separate from compaction in turn 3.

## 7. Acceptance Evidence

The rehearsal passes if and only if **all** of the following are host-verified:

### 7.1 File Artifacts

| Check | Method |
|-------|--------|
| `counter.mjs` exists after turn 1 | `fs.readFileSync` + SHA-256 |
| `counter.test.mjs` exists after turn 1 | `fs.readFileSync` + SHA-256 |
| `package.json` exists after turn 1 | `fs.readFileSync` + SHA-256 |
| `counter.test.mjs` changed after turn 2 | SHA-256 differs from turn 1 |
| `counter.mjs` unchanged after turn 2 | SHA-256 identical to turn 1 |
| No unrequested files created | Directory listing matches exactly 3 files |

### 7.2 Test Execution

| Check | Method |
|-------|--------|
| `node --test counter.test.mjs` exits 0 after turn 1 | Process exit code |
| `node --test counter.test.mjs` exits 0 after turn 2 | Process exit code |
| Test output matches expected pattern | stdout regex |

### 7.3 Process State

| Check | Method |
|-------|--------|
| Original Codex processes unchanged before/after | PID + executable path comparison |
| Anti-Codex processes unchanged before/after | PID + executable path comparison |
| Candidate processes cleaned after rehearsal | Process list shows zero candidate children |
| No duplicate process launches | Process count stable across turns |

### 7.4 Protocol Events

| Check | Method |
|-------|--------|
| `previous_response_id` chain is continuous | Fake server request log: turn N+1 carries turn N's response ID |
| Compact request received exactly once | Fake server compact handler counter |
| 429 received on designated turn | Fake server error injection log |
| No duplicate assistant messages | Replay detector: zero identical text pairs across turns |
| Fake server request count matches expected | Total `/v1/chat/completions` calls = expected |

### 7.5 Resume Behavior

| Check | Method |
|-------|--------|
| Conversation JSONL exists before CLI restart | File exists in `CODEX_HOME` |
| After restart, fake server receives reconstructed history | Request roles include prior user/assistant/tool turns |
| Turn 4 response references turn 1 content | Response text contains a fact from the original creation |

### 7.6 Report Schema

The final JSON report must include at minimum:

```json
{
  "schemaVersion": 1,
  "gate": "Gate 8 rehearsal: CodexPlusPlus third-party long-task proof",
  "ok": true,
  "modelTraffic": "loopback fake provider only",
  "antigravityTraffic": false,
  "adapterInvolved": false,
  "turns": 4,
  "checks": [ ... ],
  "hostVerification": {
    "fileHashes": { ... },
    "testResults": { ... },
    "processSnapshots": { ... },
    "protocolEvents": { ... },
    "resumeBehavior": { ... }
  },
  "note": "This rehearsal proves Codex harness long-task behavior through the standard third-party Chat route. It does not exercise the Antigravity Chat Adapter, Antigravity Cascade, or any real model traffic."
}
```

## 8. Implementation Sequence

| Step | Depends on | Deliverable |
|------|-----------|-------------|
| 1. Enhance fake-chat-server with compact, quota, history-chain, file-write, and replay-detect handlers | Nothing (can start now) | Updated `fake-chat-server.mjs` + new test cases in `fake-chat-server.test.mjs` |
| 2. Build orchestration script | Step 1 | `scripts/test-gate8-rehearsal.mjs` |
| 3. Validate rehearsal against current codebase | Steps 1-2 | Green rehearsal run |
| 4. Gate 5 visible integration completes | External | Unblocks Gate 6 |
| 5. Gate 6 bounded edge passes | Step 4 | Unblocks Gate 7 |
| 6. Gate 7 old code removal completes | Step 5 | Unblocks Gate 8 |
| 7. Run final Gate 8 rehearsal against post-Gate-7 codebase | Steps 3, 6 | Gate 8 evidence |

Steps 1-3 can proceed in parallel with Gates 5-7. Step 7 is the only hard dependency on the full gate chain.

## 9. Scope Boundaries

### What this rehearsal IS

- A deterministic proof that the Codex harness can handle multi-turn edits, user correction, compaction, same-thread resume, and quota failure through a standard third-party Chat API via CodexPlusPlus.
- A prerequisite rehearsal for the final Antigravity-traffic Gate 8 run.
- A reusable extension of the Gate 2 fake-provider infrastructure.

### What this rehearsal is NOT

- Proof of Antigravity adapter correctness (that is Gate 3/4 evidence, already complete).
- Proof of real model behavior (that requires live Antigravity traffic).
- Proof of the full three-layer stack end-to-end (that requires all three layers at 100% plus real model traffic).
- A substitute for Gates 5, 6, or 7.

### Rehearsal vs Final Gate 8

| Dimension | Rehearsal | Final Gate 8 |
|-----------|-----------|-------------|
| Provider | Fake local Chat server | Real Antigravity Cascade via Layer 3 adapter |
| Model | Scripted deterministic | Live Gemini/Sonnet |
| Traffic | Loopback only | Real model traffic |
| Protocol route | CodexPlusPlus third-party | CodexPlusPlus to Antigravity adapter |
| Compaction trigger | Synthetic large payload | Real context pressure from model interaction |
| Resume trigger | Kill and restart CLI | Client crash or restart during real task |
| Evidence weight | Codex harness behavior proof | Full product acceptance |

## 10. Summary

The smallest isolated deterministic Gate 8 rehearsal is a **4-turn scripted scenario** using the **extended Gate 2 fake Chat server** and the **existing CodexPlusPlus isolated Codex candidate**. It reuses Gate 2 fixtures and probe infrastructure, Gate 4 process-snapshot patterns, and Gate 6 compaction/resume verifier patterns. It requires building approximately **50 lines of fake-server enhancements** and **300-400 lines of orchestration code**. The key contamination risk is misidentifying this rehearsal as final Antigravity evidence; this is mitigated by explicit metadata fields and a mandatory note in every report. The rehearsal can be built and validated before Gates 5-7 complete, and then re-run against the post-Gate-7 codebase as the actual Gate 8 evidence.

## 11. Host Disposition And Current State

This worker review used a stale gate snapshot. Host verification supersedes its Gate 5-7 progress table: Gates 5, 6 and 7 are complete, all three product parts are 100%, overall progress is 97%, and only formal Gate 8 remains.

The accepted implementation is `scripts/test-anticodex-gate8-deterministic-rehearsal.mjs` plus the isolated scripted-Chat harness and extended Gate 2 fixture. The current rerun passes with `failedIds:[]`, includes native app-server compaction and same-thread recovery, and produces `gate8-deterministic-rehearsal-6E176F061FDB.zip` with SHA-256 `66b7d913114bebd825c332a38f4b41926823f19bb40cd1feaf8ba50125f057e4`. The separate diverse-result matrix passes all 42 checks and produces a readable nested archive with SHA-256 `4f7ff08876f5144d815cb2f96d625b0fdd7b175d98d65f87b0907f9b2b39c0dc`. Both reports explicitly record no Antigravity traffic and cannot advance the formal gate.

One review recommendation was rejected: the fake provider does not write project files itself. It only returns normal Chat tool calls; the native Codex host executes those commands and the independent verifier checks resulting files, hashes and tests. This preserves the architecture rule that Codex, not the translation layer or provider fixture, owns tool execution.
