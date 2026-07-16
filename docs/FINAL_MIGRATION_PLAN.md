# Anti-Codex Final Migration Plan

- Status: authoritative execution plan; Gates 1-8 complete
- Updated: 2026-07-16
- Architecture: [`THREE_LAYER_ARCHITECTURE.md`](THREE_LAYER_ARCHITECTURE.md)
- Removal ledger: [`LEGACY_REMOVAL_MANIFEST.md`](LEGACY_REMOVAL_MANIFEST.md)
- Implementation inventory: [`CURRENT_IMPLEMENTATION_AUDIT.md`](CURRENT_IMPLEMENTATION_AUDIT.md)
- Dual-environment reference: [`audits/2026-07-14-dual-environment-reference.md`](audits/2026-07-14-dual-environment-reference.md)

## 1. Fixed Target

```text
isolated official Codex copy
  -> CodexPlusPlus launcher/provider stack with isolation-only patch
     -> ordinary third-party Responses or Chat API
     -> Antigravity provider: thin Chat Completions to Cascade adapter
        -> native Antigravity Desktop Cascade, account, models and quota
```

There is no fourth task-control layer. Codex owns planning, tools, commands, files, approvals, retries, continuation, compaction and completion. CodexPlusPlus owns all ordinary third-party provider integration and the general Codex Responses/Chat conversion. Third-party models bypass Antigravity completely. Anti-Codex owns only the smallest Chat-to-Cascade mapping for Antigravity models.

Changing this target, routing third-party APIs through Antigravity, moving task decisions out of Codex, replacing CodexPlusPlus conversion, or changing the adapter to a self-written Responses translator requires an explicit user decision and a prior update to the cornerstone architecture.

## 2. Mandatory Work-Cycle Gate

Before every implementation, repair or test cycle:

1. Read the fixed target above and the current gate in section 4.
2. Check the proposed work against `THREE_LAYER_ARCHITECTURE.md` and `LEGACY_REMOVAL_MANIFEST.md`.
3. Inspect branch, current commit, worktree changes and running processes before any write or launch.
4. Confirm the cycle does not add task semantics, duplicate CodexPlusPlus conversion, touch original Codex state, or revive a file marked for deletion.
5. Limit edits and tests to the current gate. Do not use Xiaoqiang1/2/3/4.
6. Do not start real Antigravity traffic unless the current gate explicitly requires it.

At the end of every cycle:

1. Inspect the exact diff and runtime side effects.
2. Run the gate's concrete verification.
3. Update this plan's current status and append durable findings to `findings.md`.
4. Do not advance the gate from model prose or a green summary; advance only from files, protocol events, process state and test results.

## 3. Current Completion Baseline

- Reusable shell, isolation, branding, Antigravity connection and verifier assets: complete for the fixed route.
- Deliverable completion on the fixed three-layer runtime route: 100%. Gates 1 through 8 are complete and the independent release summary reports `releaseReady:true`.
- Inventory and exact keep/adapt/delete classification: complete.
- CodexPlusPlus isolation review, rebaseable patch, reproducible Windows launcher build and real copied-client isolation proof: complete.
- Deterministic third-party Chat Completions route: complete. The only non-isolation CodexPlusPlus change is the documented abortive-close transport for plain HTTP loopback model streams; remote provider payloads, protocol conversion, retries and task behavior remain upstream.
- Thin Antigravity adapter and isolated CodexPlusPlus route switch: complete. The persistent copied-client matrix, visible-client short proof, formal edge/recovery matrix, legacy zero-hit gate, release packaging proof and final multi-style Gate 8 are green.

Old percentages from the mixed translator describe historical reusable evidence only. They are not completion claims for this plan.

### Progress Reporting Format

Every progress report to the user must use these three product parts in this order, with separate evidence-based percentages:

1. **Anti-Codex shell plus native Codex client features - 100% implementation.** Isolation, native task behavior, crash/same-task resume, packaging, upgrade/rollback, exact Chinese `管理`, preserved Anti-Codex icons, responsive history and upper/center/lower real-mouse close clicks all pass.
2. **CodexPlusPlus general translation layer - 100% implementation.** General Codex Responses/Chat translation remains upstream CodexPlusPlus `1.2.36`; Anti-Codex carries only the rebaseable isolation patch and documented plain-HTTP-loopback abortive-close transport patch. The ordinary third-party API route passes 27/27 and bypasses Antigravity.
3. **Native Antigravity export plus thin Chat adapter - 100% implementation.** Real native tools, multi-turn work, adapter restart, cancellation/recovery, exact failed-tool results, parallel tool results and deterministic quota/auth/network/timeout mapping pass. The adapter remains Chat-to-Cascade only and contains no Codex task controller. Gate 8 is acceptance of the assembled product, not unfinished adapter implementation.

Overall fixed-route completion is 100%. Component percentages and the integrated release acceptance gate are all complete. Each future maintenance report must still say what changed in each part and whether third-party API routing is affected.

## 4. Sequential Gates

### Gate 1: CodexPlusPlus Isolation Compatibility - COMPLETE

Prove without model traffic that CodexPlusPlus with no changes outside the isolation boundary can:

- launch only the copied Anti-Codex executable through its alternate app-path option;
- propagate an isolated `CODEX_HOME` and isolated application-data root;
- keep its own settings, ports and helper processes separate;
- avoid detecting, stopping, changing or reconfiguring original Codex processes;
- use explicit non-conflicting CDP/helper/proxy ports.
- receive `CODEX_HOME` and application-data paths only in the launched child environment, never as permanent user/system variables;
- create a distinct copied-client process rather than activate, attach to or reuse an original Codex process.

Evidence required: focused upstream/static tests, source trace for every path/environment handoff, and before/after process/file fingerprints of original Codex. Do not read or copy credential contents. If the real process cannot prove which state root it used, record the check as unverified and keep the gate closed.

Current source result:

- passed: explicit copied app path, `CODEX_HOME`, inherited child environment and configurable launcher guard port;
- unpatched-upstream blockers: independent CodexPlusPlus state root, independent protocol-proxy port, branded copied-executable selection, copied-app-path-scoped process/manager handling, and shared current-user logon-watcher registration;
- isolated patch: commit `3487f1a4c25aa8d525b6eec055ef6339f8a0f0d6`, pinned under `third_party/codexplusplus/` against upstream `91a83acd`; isolated launch/restart and branded executable selection fail closed instead of falling back to original Codex or `ChatGPT.exe`;
- repository audit: 7/7 regression tests pass, the patched source passes 9/9 checks, and the saved patch cleanly replays with an identical tree on the pinned upstream commit;
- compiled checks: pinned cargo-xwin Docker checks pass for core and Manager. Windows-native execution passes 124 core tests and 20 watcher tests;
- reproducible launcher: release build passed with SHA-256 `56dded2e546a9a54e4d6fc3988b324fb4a8102702a0d8b83140aa80fe22d54a1`;
- runtime result: copied Codex `26.707.9981.0` passed 20/20 checks. Invalid branded-executable selection exited with code 1; the valid process was created only from the candidate path with the sealed launcher as parent; isolated state, Electron user data and `CODEX_HOME` received real writes; original Codex and the existing Anti-Codex process sets, stable files, shortcuts, persistent environment and global watcher stayed unchanged before, during and after cleanup;
- cleanup result: zero candidate or launcher processes and no default `.codex-session-delete` state remained. Gate 1 used no model traffic.

### Gate 2: Deterministic Third-Party Provider Route - COMPLETE

Connect the isolated client through CodexPlusPlus directly to a local fake third-party Chat Completions provider, with no Antigravity process or adapter. Prove model selection, text streaming, one structured tool call and exact result, multi-turn history, cancellation, quota/auth/network errors and one terminal outcome. Original Codex must remain byte/state/process unchanged.

Current result:

- accepted CodexPlusPlus commit: `0c7c4fb156fc1635c9d4da0f930213d33db540fa`, based on upstream `91a83acd` plus the Gate 1 isolation commit;
- transport exception: only plain HTTP loopback model endpoints use an abortive Hyper connector so Codex cancellation reaches the controlled local adapter after streaming starts or while response headers are pending; remote third-party endpoints retain the upstream reqwest route;
- formal report: `docs/audits/2026-07-14-codexplusplus-third-party-route.json`, 27/27 checks passed, `failedIds:[]`, loopback fake provider only and no model traffic;
- real copied native Codex CLI executed exactly one PowerShell command and returned its exact output through the second Chat request;
- focused evidence: fixture 16/16, core 125/125, protocol-proxy integration 44/44, launcher 64/64 with one unrelated Windows symlink-privilege test skipped;
- release launcher SHA-256: `AAE5E052A03B82B0C0B1F4AA0DFF175DE2AA51F5A2572C4C757FEC9CFCF1B02B`;
- original Codex and the active Anti-Codex process/state fingerprints stayed unchanged, and candidate/helper/fake processes were zero after cleanup.

### Gate 3: Thin Antigravity Chat Adapter - COMPLETE

Extract only native Antigravity primitives into a small independent adapter:

- connection, account and model discovery;
- `StartCascade`, structured system sections and current user input;
- native MCP/custom-tool definitions and trajectory tool events;
- exact same-Cascade tool-result continuation;
- text streaming, completion, cancellation and direct error mapping.

The adapter must not inspect the workspace, execute tools, rewrite commands, infer completion, retry user work, reconstruct Codex Responses history or implement compaction.

Current result:

- standalone provider boundary: four files under `translator/provider/`, 52,007 bytes total, with zero imports from the legacy mixed server or home-grown Codex Responses modules;
- formal report: `docs/audits/2026-07-14-antigravity-chat-adapter-contract.json`, `ok:true`, `failedIds:[]`;
- deterministic contract: 19/19 tests cover Chat mapping, streaming, reasoning chunks, stable tool calls, exact/parallel tool-result continuation, bounded sessions, disconnect cancellation, error mapping, real HTTP lifecycle and stale desktop-port rediscovery;
- related transport regression: 94/94 tests pass across the new provider plus existing Agent API, native MCP bridge and request registry;
- read-only real desktop proof: 20 models discovered, signed-in identity available, Pro plan, no model request;
- bounded real traffic proof: `gemini-3.5-flash-low` called `echo_probe` exactly once with exact arguments, the host supplied the exact CRLF-bearing result, the same Cascade resumed and returned the exact final marker; counters were `start:1`, `resume:1`, `cancel:0`;
- two real lifecycle defects found and fixed: a normal non-stream HTTP close no longer aborts a retained MCP call, and ending the first async iteration after a tool terminal no longer closes the handed-off continuation.

### Gate 4: Isolated Route Switch - COMPLETE

Point disposable Anti-Codex state to the adapter through CodexPlusPlus and prove the old mixed server receives zero product requests.

Current result:

- formal report: `docs/audits/2026-07-14-gate4-isolated-route-switch.json`, 23/23 checks passed with `failed:[]`;
- copied native Codex used the current generated model catalog, CodexPlusPlus exposed its upstream `apply_patch_*` proxy tools, and real `gemini-3.5-flash-low` performed exactly one native file change;
- host evidence verified the exact artifact, the only workspace file, one `start`, one same-Cascade `resume`, zero `cancel`, no `409 Conflict` and no duplicate tool action;
- the old mixed translator route fingerprint was byte-for-byte unchanged before and after; original Codex and the active Anti-Codex root process stayed unchanged; all candidate/helper/temp artifacts were removed;
- two red probes identified missing candidate model metadata and a read-only Windows permission mismatch. The accepted route reuses the existing Antigravity model-catalog builder and the product's existing Antigravity writable permission mode; no task logic or protocol translation was added.

Physical removal is intentionally deferred until Gates 5 and 6 pass, as required by the cornerstone gate order and `LEGACY_REMOVAL_MANIFEST.md`. Git remains the only archive; no legacy source tree may be created.

### Gate 5: Component Integration and Visible Short Smoke - COMPLETE

Complete the visible Anti-Codex client wiring without running another long project:

- launch only one visible Anti-Codex instance after explicit user approval and after the currently active instance is closed;
- prove the current official Codex UI/features and isolated state are present while Anti-Codex icons and exact Chinese labels remain;
- run one bounded text turn and one bounded exact tool turn through the fixed CodexPlusPlus/Antigravity route;
- verify Manager close hit area, history responsiveness, process isolation and cleanup;
- do not run a large project, long context or repeated edit loop in this gate.

Judge files, hashes, command counts, exit codes and tests, never only the final reply.

Current route-level result:

- formal report: `docs/audits/2026-07-15-gate5-real-task-matrix.json`, 32/32 checks passed with `failed:[]`;
- one isolated native Codex session completed an exactly-once command, a 13-file Node ESM project, a multi-turn requirement correction and a read-only audit;
- independent host checks passed project tests, corrected-feature acceptance, exact file layout, command-scope limits and the read-only before/after hash comparison;
- provider counters were `start:4`, `resume:36`, `cancel:0`; the old mixed route fingerprint was unchanged, original Codex and the active Anti-Codex root were unchanged, and cleanup left zero candidate processes or temporary roots;
- accepted archive: `gate5-event-report-1784051505283-h8p9l8m9.zip`, 10,143 bytes, SHA-256 `61fe8c78dc8774b9e5c82636e927a8d144ca67b2590cb42021f6ab1f7643c9c3`;
- the preceding red run exposed Gemini's Antigravity-native `command` alias for Codex's `shell_command`. The thin native MCP boundary now advertises that alias and restores the canonical Codex name before returning the call. Deterministic provider regressions pass 36/36; CodexPlusPlus request/response semantics were not changed.

Visible-client completion evidence:

- formal aggregate: `docs/audits/2026-07-15-gate5-visible-integration.json`, 13/13 checks passed with `failures:[]` and signed latest/history copies;
- real visible text completed in 25.7 seconds, real visible exact-file work completed in 103.7 seconds, and a real mouse reopened the same native task in 335 ms before the continuation completed with no repair turn or stale-request 409;
- host verification re-read the three exact tool artifacts: `done.txt` 29 bytes with SHA-256 `c3fd546b148c8614ec25e9dffc61287971386dda08dc215a9cd9b55e62f82052`, `index.html` SHA-256 `9b60ae55440e55646f2a5597b656ab7b1306ae0ba110e721de649cc146e4bdbd`, and `README.md` SHA-256 `05c1f6ba87ee56341a25af63af7b029968bd88b42176af04187a7914c5756e69`;
- the profile menu shows exact Chinese `管理` with no visible English `Manager`; upper/center/lower close probes use real CDP mouse press/release, hit the button with no text-node layer, close successfully, and leave the overlay closed;
- the current visible shell reports `native-panel-v104`, the fixed route is ready on CodexPlusPlus `1.2.36` with `gemini-3-flash-agent`, and the live Anti-Codex tray artwork passes with 111 pink pixels;
- task-history cleanup was backup-first. Filtering the nine development-orchestrator MCP workers from the isolated product config removed the per-task `9*N` process multiplication: Anti-Codex stayed at zero development-worker children across the three visible task activations, while `node_repl` and ordinary user MCP support remain available. Original Codex processes were not stopped or modified.

The 32/32 headless matrix remains supporting integration evidence; the 13/13 visible aggregate closes Gate 5. The complete visible long-project sequence remains deferred to Gate 8 after all three product parts reach 100%.

Current fixed-shell candidate evidence:

- official source is Codex `26.707.9981.0`; candidate manifest is `anticodex-host-manifest-v2` with profile `fixed-shell-v1`;
- file-level ASAR comparison is 8 changed, 6,529 unchanged, 0 added and 0 removed;
- native Settings remains and the only additional profile action is exact escaped Chinese `管理`;
- the retired plugin catalog, retry visibility and computer-use behavior patches are absent;
- app/taskbar/tray icons match the accepted Anti-Codex hashes, candidate validation passes and no candidate process was launched;
- formal evidence: `docs/audits/2026-07-15-fixed-shell-candidate.md`.

### Gate 6: Edge and Recovery Matrix - COMPLETE

Prove quota exhaustion, cancellation, tool failure, malformed tool arguments, parallel tool calls, client crash/restart, same-task resume and adapter restart through bounded focused probes. A local session reset after a completed command must continue through a fresh Codex request: no stale-request replay, no `409 Conflict`, and no duplicate execution of the completed command. No edge handler may take over Codex's task decisions. Long-context and compaction project acceptance belongs to Gate 8.

Current adapter-restart result:

- formal report: `docs/audits/2026-07-15-gate6-adapter-restart-recovery.json`;
- real `gemini-3.5-flash-low` requested one exact host tool call, the host wrote the artifact once, the local adapter was closed and recreated with no opaque session, and the full Chat transcript was submitted to the fresh adapter;
- both model turns returned HTTP 200, the recovered turn made zero repeated tool calls, returned the exact required final result, and left the artifact hash unchanged;
- counters were `start:2`, `resume:0`, `cancel:1`, proving the second turn used a fresh Cascade instead of replaying or resuming the cancelled one;
- the active Anti-Codex root and original Codex process sets were unchanged, no candidate desktop was launched, and the old `8484` route fingerprint was unchanged;
- the initial red probe was a harness-only stale HTTP connection reuse after rebinding the same loopback port. Requests now explicitly close their test connection; the product path did not return 409 and no second model turn or duplicate host execution occurred in that red probe.

Current client-cancellation result:

- formal report: `docs/audits/2026-07-15-gate6-adapter-cancellation.json`;
- a real Chat request was disconnected immediately after `SendUserCascadeMessage:200`; the in-flight idle wait aborted and Antigravity received exactly one real `CancelCascadeInvocation:200`;
- the adapter retained zero tool sessions, and a fresh bounded Gemini request immediately returned HTTP 200 with the exact recovery result and no stale-session 409;
- counters were `start:2`, `resume:0`, `cancel:0`; cancellation occurred inside the owning Cascade client rather than through a retained tool continuation;
- original Codex, the active Anti-Codex root and the old `8484` route fingerprint were unchanged, and no desktop candidate was launched.

Current copied-client crash/restart and same-task result:

- formal report: `docs/audits/2026-07-15-gate6-client-restart-resume.json`;
- the headless copied native Codex completed `once-action.mjs`, then its CLI process was forcibly terminated during a 120-second foreground command;
- a fresh CLI resumed the exact same thread ID `019f61e1-aa19-7fb0-9a55-331f46b4b479`, returned exit code 0 and produced the exact required result without any stale-request 409;
- the host-side execution count was 1 before and after resume, and the completed-action marker hash stayed `2ef35ce760bba2a4a017ec506de22fb5e6314ae541ddec792f6ed879a1d0c4a8`;
- provider counters were `start:3`, `resume:3`, `cancel:0`; the interrupted process was in a local Codex tool command rather than an active Cascade request, while the separate real cancellation probe covers in-flight Cascade cancellation;
- accepted workspace archive: `gate6-client-restart-3C6EF911EE7A.zip`, 1,234 bytes, SHA-256 `5cc267e587a5c419f6f2f328103dab733b2531f31fde01582368da6bba8cc76e`;
- original Codex, active Anti-Codex and old route fingerprints were unchanged; cleanup left zero candidate processes and opened no desktop window.

The formal edge matrix is `docs/audits/2026-07-15-gate6-edge-matrix.json`: 14/14 checks pass, `formalGateAdvanced:true`, `blockedBy:null`, and its signed Gate 5 dependency is green. The matrix consumes accepted real adapter restart, cancellation/recovery and copied-client crash/resume reports plus 43/43 deterministic provider/session/HTTP/registry/harness tests with zero additional model traffic. It covers quota/auth/network/timeout no-retry mapping, abort propagation, complete parallel-result enforcement, malformed-argument 502 plus continuation cancellation, exact failed-tool output, adapter restart no-replay and the visible-launch guard.

The cancellation verifier now writes no-traffic readiness to a separate report, so report-only checks cannot overwrite formal real-cancellation evidence. The focused red/green regression passes 2/2; the refreshed real probe observed exactly one `CancelCascadeInvocation:200` and a fresh HTTP 200 recovery with no 409.

### Gate 7: Three-Part Completion, Legacy Removal, UI and Release Closeout - COMPLETE

Delete every obsolete production file and test in `LEGACY_REMOVAL_MANIFEST.md`, then run the production zero-hit gate. Synchronize the current official Codex shell, preserve Anti-Codex icons, exact Chinese `管理`, full close-button hit area, responsive task history and isolated cleanup. Finish packaging, original-Codex zero-change audit, update/rollback proof and checkpoint. At the end of this gate the shell/client, CodexPlusPlus layer and Antigravity thin-adapter part must each have concrete 100% implementation evidence.

Current release summary reports `shellProgress:100`, `codexPlusPlusProgress:100`, `antigravityAdapterProgress:100`, overall 100%, completed Gates 1-8, `releaseReady:true`, no missing gate and no damaged report.

### Gate 8: Final Visible Long-Task Acceptance - COMPLETE

Only after all three reported product parts are at 100%, run the final visible long project. It must include repeated file edits, real tests, at least one mid-task user correction/dialogue, long-context pressure and native Codex compaction/resume. Judge artifacts, hashes, command counts, test exits, continuity and cleanup. Do not use the long task as an implementation-debug loop; if it fails, reopen the responsible component percentage and fix that component before rerunning the failed lane.

Final accepted evidence has two parts. The signed formal inventory journey completed eight visible turns, four edit rounds, 49 real tool calls, correction, controlled interruption/recovery, actual-mouse history reopen and native compaction/same-thread continuation. The signed multi-style run then completed interrupted migration and a greenfield 12-file project in 8/8 additional visible turns. Migration passed protected-input, test, exact-output, two-run idempotency and stale-temp recovery checks. Greenfield passed tests, JSON/text CLI, expected metrics, Chinese README/full HTML and hash-stable read-only verification. Each project's title and task-suggestion helpers made one request and zero tools. Final no-traffic source regression passes 369/369; installed fast checks and sync readiness pass on official Codex `26.707.12708.0` / CLI `0.144.5`.

The paragraphs below retain the chronological Gate 8 failure and hardening record. They are historical diagnostics, not current blockers.

Current Gate 8 harness uses a unique task token and a marker from the exact native rollout before it allows `/compact`; it selects the localized native compression command with a real mouse click and fails before traffic on any title/thread ambiguity. A diagnostic against two old same-title tasks proved the former Enter-only harness could select the wrong task. The selected old task did reach native `上下文已压缩`, but the active Antigravity account then returned Gemini `429 quota_exceeded` for both low and high routes. The user therefore approved `claude-sonnet-4-6` for the formal rerun.

The first formal Claude journey proved the real route before quota exhaustion: 81 native `/v1/responses` requests all reached the fixed adapter as `/v1/chat/completions`, the host produced seven hashed artifacts, and tests plus the exact `5/2/2/1/3/1` inventory result passed. It did not advance the gate because the visible prompt left `dedupeLatest`'s return shape undefined while the hidden verifier assumed an array; later repair turns then ended with `RESOURCE_EXHAUSTED`. The contract now explicitly requires a sorted array, recovered reconnects no longer fail a completed turn, only explicit 409 text counts as a stale conflict, the Cascade idle snapshot race has a bounded ten-read retry window, and the formal long-context threshold reaches the native compaction verifier. The user reported a new Antigravity quota hold at 03:39 local time on 2026-07-16 and expects recovery in about five hours, so no real model request or Antigravity worker dispatch is allowed before about 08:39 unless the user explicitly confirms earlier recovery.

The formal runner now fails before its first long-task request unless the anonymized account endpoint reports both signed-in and identity-ready, the selected model id is present in the current `/models` catalog, and a separate bounded quota probe for the same model succeeded within ten minutes. The quota probe is opt-in, holds the shared real-traffic lock, sends exactly one tool-free Chat request, never starts the long task, and records only status, marker match, response length/hash and provider error metadata. A 429 is classified as `quota_exhausted` and is never retried. The final report aggregator and release validator independently require these proofs before Gate 8 can pass.

Formal interaction acceptance is eight visible user turns and eight passed turns, not the older four-turn minimum. The report must contain eight complete turn-history records, and every turn must prove real traffic, a non-empty real tool result, completion, and a Chinese action explanation before its first command; unexpected program-launch commands, duplicate commands within one turn, and any tool call or tool output after the visible final marker are release failures. CodexPlusPlus request replay is a release failure only when a stable request id or body fingerprint repeats inside the bounded window; equal path and byte count remain diagnostic because the upstream log does not currently record either stable identity. Exactly-once host execution and complete normalized commands remain mandatory. The final Node entry automatically re-enters through the shared real-traffic mutex, so a desktop crash or automatic continuation cannot start a second formal run while the first is alive; an abandoned-owner regression proves the next process can acquire the mutex after an owner exits without releasing it. Focused evidence tests pass 37/37, including live mutex contention and abandoned-owner recovery, loopback-only success and 429 fixtures with one POST each, report redaction, stale/mismatched probe rejection, shallow/partially-passed journey rejection, claimed-turn rejection, per-turn contract rejection, launch-loop rejection, duplicate-command rejection, request-replay identity rejection, same-size non-replay acceptance, post-final-tool rejection, installed release-audit dependency coverage and safe help exits. The complete no-traffic source preflight passes 299/299 across 37 test files. Runtime sync carries the six tracked Gate 1-6 audits and the two required hash sidecars, so the installed release summary also reports Gates 1-7 complete and only Gate 8 missing. Neither fixture nor the complete preflight uses Antigravity traffic.

While real traffic is unavailable, the supporting deterministic rehearsal remains green through an isolated native Codex thread, upstream CodexPlusPlus and a loopback scripted Chat provider: four dialogue turns, three edit rounds, hashed artifacts, host tests, explicit correction, read-only audit, official app-server compaction, controlled interruption, same-thread resume, exactly-once action and one terminal quota request. Its current archive is `gate8-deterministic-rehearsal-D70BFC9DC8B1.zip`, SHA-256 `f5f9129751fc512f73c2c26c4b20bd1dc114f6f9eda7c0a4645d10ffed55aaee`. The separate 42-check diverse-result matrix also passes failed-launch exactly-once behavior, native compaction and a readable nested archive; its current archive is `gate8-diverse-result-matrix-87DA50D6584B.zip`, SHA-256 `2d5747febbfec1812b85705c83a7ad0e635c73de7f3f34362263ad98d9998ba2`.

These rehearsals are deliberately marked no-real-traffic and cannot advance the formal gate. They prove the Codex host, general CodexPlusPlus long-task path, archive evidence and native headless compaction/resume, but they do not substitute for the visible UI click path or real Antigravity inference. Formal Gate 8 and `releaseReady` remain pending until the quota-capable Claude run passes.

Current superseding preflight on 2026-07-16: formal evidence no longer accepts a claimed/requested model value by itself. Every counted turn must carry the exact selected model plus fresh marker-scoped request/rollout evidence or a matching newly resolved/display/internal model route; substring lookalikes and a requested-model field paired with a different resolved model fail. The report validates the complete model-proof object, at least one non-empty marker-scoped command with a unique native call ID, a non-empty tool output linked by that same call ID, and rollout-derived SHA-256 evidence for the linked result and pre-command action explanation; internal booleans or unrelated tool output cannot pass. Focused evidence tests pass 54/54, the release self-test passes and the complete no-traffic source preflight passes 316/316 across 37 files. Fresh deterministic rehearsal and diverse-matrix archives are `4304c5379d21cd7ce658bb6ca17b96dbbedb7c883f052eafb91b525b5d27d6e4` and `6d329fee600a0cbac25a155b484529a85b36f6f7d55e118bb7dc8105c4a89552`. Runtime sync/readiness is green without a restart. The current fixed route is `gemini-3-flash-agent`; after the user's reported 03:39 five-hour hold, use the then-current fixed-route model for one bounded probe no earlier than about 08:39, and start exactly one formal Gate 8 only after a 200 marker match. After that formal inventory acceptance, the separate interrupted-migration and greenfield-project real journeys remain required before the broader multi-style usability objective is claimed complete.

The quota probe now derives that model from the live fixed-route health response instead of defaulting to a historical model. A caller-supplied model must equal the fixed-route model with ordinal case-insensitive comparison and must still exist in the catalog; an equal value is canonicalized to the route's exact model ID, while a missing route model or mismatch fails during preflight with zero POSTs. The loopback RED/green fixture proves a catalog-present wrong model can no longer consume the one post-hold request.

The two required post-Gate-8 human journeys also have no historical model default. A real run resolves the ready fixed-route model before creating fixtures or opening the UI, rejects any explicit mismatch, and automatically acquires the shared real-traffic mutex through `test-anticodex-human-long-journey.ps1`. This prevents a crash/recovery or second operator from starting a duplicate migration/greenfield journey. The formal runner publishes a signed phase-specific failure report for any unexpected preflight, journey, compaction, host-verification or report-publication error. The shared human-journey runner now does the same for route preflight, fixture setup, journey execution, cleanup and publication, and only claims behavior coverage after the requested journey passes. Dynamic missing-probe and mismatched-model injections proved exit 1, matching sidecar hashes and zero traffic/long-task start. Focused launch/evidence coverage is 58/58. The complete source preflight passes 320/320 across 37 files with no traffic, runtime synchronization/readiness passes without restarting the client, and all five source/runtime hashes match. Fresh local scripted practice passes 44/44 and 42/42 with actual files, host tests, correction, native compaction, interruption/resume and failed-launch exactly-once evidence; archive hashes are `0308ba3c5756869df346198946f354ee7f506fdbe42a52746b14e2ce983b1e3a` and `efb5de1bdea19747cde462426b502aceacd42be358ec7635bdb932e47f2e27a7`. Current hashes are formal runner `21541773f4b8f0eb126de9620a63818fdcb73845ed3e3542fa26258633968e2f`, quota probe `249e798a9203038ba0a3034d50c1cd808f4dc9c375bdd041952f2caf7453cf0f`, evidence helper `912cd4d1d846ce13874c0d385fec8c1e45d2f614e7037edda7417ca837032dc0`, human journey `cbbd4a57a6b94b2dac69d551fe4f9cab2c365c91565b6dcf2a890bc8cdf30fd4`, and journey lock wrapper `fce168c829cb7064c4e3575fd4159dad29e26fd1b3c98d186ba4472396b1c3f8`.

## 5. Gate Advancement Rule

A gate advances only when every listed observation has fresh evidence from the current route. A unit test cannot substitute for the copied desktop path; the Gate 5 short smoke cannot substitute for the final Gate 8 long project; a response marker cannot substitute for artifacts; and a previous mixed-translator success cannot substitute for CodexPlusPlus route evidence. Gate 8 cannot start until the three progress-report components each have 100% implementation evidence.

## 6. Current Three-Part Status And Final Acceptance Blocker (2026-07-16 09:51 +08:00)

1. **Official copied Codex shell: 100%.** The active copy matches official Codex `26.707.9981.0` and CLI `0.144.2`, while Anti-Codex state, process tree, branding and icons remain isolated. Chinese `管理`, `native-panel-v105`, and real upper/center/lower close clicks pass. The official project's current `在 <项目> 中新建任务` control is used for fixture-rooted verification.
2. **Upstream CodexPlusPlus integration: 100%.** Pinned upstream `1.2.36` owns Responses/Chat conversion and ordinary provider behavior. Anti-Codex carries only the documented isolation and loopback-cancellation transport patches. Third-party API URL, key, model and Chat/Responses protocol are configured in `管理`, stored only in isolated Anti-Codex state, and routed directly through CodexPlusPlus without Antigravity.
3. **Native Antigravity export plus thin Chat adapter: 100%.** The fixed route is `gemini-3-flash-agent`; model discovery, structured tools, exact tool-result continuation, cancellation and errors map through standard Chat Completions. The adapter contains no task controller, command generator or completion policy.

Historical partial status: overall remained **97%** and `releaseReady:false` at that point because Gate 8 result acceptance was incomplete. A one-request quota probe at 09:49 returned HTTP 200. The single formal inventory run then proved the corrected native fixture cwd, seven real Codex tool calls, actual file editing, six hashed deliverables, 2/2 tests and a correct default CLI result before the provider returned `RESOURCE_EXHAUSTED` during the first visible user turn. The reported reset interval was 3h13m32s; no retry was permitted before approximately 13:05 +08:00.

The partial run also hardened the acceptance tool without changing product semantics: project selection recognizes the current official Chinese new-task label; verification commands separated by a file mutation are not mislabeled as a loop; and partial reports record actual traffic truthfully. Focused evidence tests pass 98/98, the complete no-traffic source preflight passes 324/324 across 37 files, and the synchronized runtime remains ready without a restart. After quota recovery, the only valid order is one fresh quota probe, one locked formal inventory rerun, native compaction/same-thread resume, then the separate interrupted-migration and greenfield real journeys. Only those result-based passes can move overall completion from 97% to 100%.

Fresh quota-free supporting evidence after that hardening is deterministic run `E994B3EFA40F` at 44/44 and diverse edge run `F2C6222BDD00` at 42/42. Their archive SHA-256 values are `90a39d3dd877ef0262569aa17706eab9a75683cd47b270e98d7056f14a1fef48` and `faea4e05e9e445ab6349a36b4a161839ec7adcf5de8cade394bad9403f41a63a`. They prove actual files, tests, correction, read-only stability, native compaction, interruption/resume, already-running no-relaunch and failed-launch exactly once through copied Codex plus CodexPlusPlus; they still do not count as real Antigravity acceptance. The three active validation-only history entries were archived after exact verification, leaving the visible Anti-Codex sidebar empty while preserving their audit transcripts.

### Third-Party Manager Runtime Contract

Third-party API configuration is part of the isolated Manager surface, not the Antigravity adapter. The visible workflow is `管理` -> `配置第三方 API` -> choose Chat Completions or Responses -> enter URL, model and key -> `测试连通` -> `保存并切换`. Restore uses `恢复 Antigravity`. The save control must remain disabled until the exact current field fingerprint has passed connection testing.

The `app:` renderer must never depend on direct access to loopback or private host aliases for this workflow. `anticodex-manager-bridge.mjs` owns a bounded CDP request bridge with explicit path/method and body-size limits; Manager reads and profile writes go through that bridge to the launcher-owned loopback service. Both bridge and startup injector snapshots must contain the complete 11-endpoint Manager read set. The bridge queue poll must reinstall action and request functions after any renderer reset. A final private-address fetch error is not evidence that address selection is the root cause; inspect bridge globals and snapshot keys first.

Acceptance requires a renderer-only reload followed by actual CDP mouse press/release on both high-impact confirmation clicks. The form must expose both protocols, URL/model/password fields, test/save/restore controls, disabled save before testing, unchanged profile when no test/save is requested, zero model traffic, and an actual close click. The 2026-07-16 repair passes these observations, the 7/7 bridge contracts, 36/36 related route/service regressions, fast UI state, full sync readiness, and upper/center/lower close probes without changing the single Anti-Codex root PID or icons. This closes the Manager configuration defect but does not advance Gate 8; overall completion remains 97% until the real long-task acceptance passes.

The post-reload follow-up closes two additional runtime gaps without changing this architecture. High-impact confirmation now resolves its result node inside the live overlay instead of referring to an out-of-scope variable, and the third-party form consumes the validated upstream-profile snapshot for first paint instead of issuing a redundant read. All mutating or provider-contacting operations remain live bridge calls. Current evidence is 9/9 Manager bridge contracts, 38/38 related route/service tests and 329/329 complete no-traffic preflight tests. A Windows trusted-mouse journey proves `设置` -> exact Chinese `管理` -> the same-page Manager overlay, while trusted CDP input proves both confirmation clicks, unchanged profile, zero traffic and the full close hit area. The single root, bridge, watcher and page-target invariants remain intact.

Verifier isolation is part of this permanent contract. A Manager test may replace the action bridge only for an action it must intercept, must preserve the exact original function and readiness state, and must restore them before closing its CDP socket. It must also clear its queue, promises, resolver, original markers and fallback timer; a bounded renderer-side self-restore protects against an external verifier crash. Close-only and third-party-form-only checks must never replace the live action bridge. The watcher must not be relied on to recognize an arbitrary callable test function as stale.

The accepted implementation proves this boundary with an installed actual-mouse third-party form run and a separate close run. The form exposes Chat Completions/Responses, URL/model/key, test/save/restore, disabled save before testing, unchanged profile and zero traffic. The close run hits upper/center/lower, has no real label text node and leaves the exact same live action function reference. After both runs, the snapshot has all 11 responses, is not in flight, and no verifier global remains. Current regression evidence is 11/11 Manager bridge contracts, 40/40 related Manager/service/route tests and 331/331 complete no-traffic preflight tests; the synchronized verifier hash is `ABFBB65D98788F6C21AFEFD8FEAA1AD1E063D2D24A0D473091C93A7BA8A1DB64`.

The final pre-reset practice refresh remains result-based. Deterministic run `BEF4919C5961` passed 44/44 with four same-thread dialogue turns, three edit rounds, four host test runs, user correction, read-only stability, native compaction, controlled interruption/resume and exactly-once execution; archive SHA-256 is `56feb3d1c42161347f5a3147d6a4aab2aaae5e12be82538b9b72c397d3c7b95b`. Diverse run `D963645D1FE3` passed 42/42 for repair, correction, interruption/resume, already-running no-relaunch and failed-launch single-attempt diagnosis; archive SHA-256 is `504ad4a4c22d3847de69b34784380f2a5ee18daabe5c4f39f1958035faf979ae`. Both used copied native Codex plus CodexPlusPlus and a loopback scripted Chat provider, sent zero Antigravity traffic, and left original Codex, the single Anti-Codex root and candidate-process counts unchanged. They strengthen the practice record but cannot replace the visible real-Antigravity Gate 8 journey.
