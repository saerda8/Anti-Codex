# Anti-Codex Three-Layer Architecture

- Status: project cornerstone; supersedes conflicting runtime architecture decisions
- Decision date: 2026-07-14
- Decision owner: user-approved product direction
- Upstream reference: `BigPizzaV3/CodexPlusPlus` commit `37c628e58b21cd3698b68a72c15133c91ccc5f92` (`v1.2.39`)

## 1. Final Product Shape

Anti-Codex has exactly three layers. A fourth task-control layer is forbidden.

```mermaid
flowchart LR
    U["User"] --> C["Layer 1: official Codex Desktop shell and native harness"]
    P["Layer 2: upstream CodexPlusPlus with seven narrow compatibility patches"] -. "launches and configures isolated client" .-> C
    C --> P
    P --> X["Third-party Responses or Chat API"]
    X --> P
    P --> H["Antigravity provider: standard Chat Completions API"]
    H --> A["Layer 3: thin Anti-Codex Antigravity Chat Adapter"]
    A --> G["Antigravity Desktop Cascade and account entitlement"]
    G --> A --> H --> P --> C
    C --> T["Codex tools, MCP, skills, approvals, files and shell"]
    T --> C
```

The official Codex harness owns planning, tool selection, tool execution, approvals, retries, cancellation, compaction, conversation state and task completion. Neither CodexPlusPlus nor the Antigravity Provider Adapter may take over those decisions.

Layer 3 is used only when the selected provider is Antigravity. A normal third-party API provider goes directly from CodexPlusPlus to that provider and never enters the Antigravity adapter or any Anti-Codex translator.

## 2. Layer 1: Official Codex Shell

Use the official Codex Desktop package as the product shell.

Keep:

- guarded copy/update/rollback of the current official package;
- native Codex UI, harness, tool executor, MCP, skills, permissions, conversations and compaction;
- isolated Anti-Codex state so original Codex data is not modified;
- Anti-Codex application/taskbar/tray/shortcut icons and product name;
- a minimal Chinese `管理` entry and launcher-owned diagnostics.

Development-worker boundary:

- the nine project-development MCP workers (DeepSeek, MIMO Claude Coworker, MiMoCode, DevEco, OpenCode, Kilo, CodeBuddy, Agnes and Antigravity Code Worker) belong to the outer development environment and must not be synchronized into the Anti-Codex product configuration;
- the copied Codex shell may keep its own native runtime MCP such as `node_repl`, plus future user-configured product MCPs that pass the normal isolation rules;
- a verifier must fail if a development worker appears in the Anti-Codex product config, not when those workers are absent.

Forbidden:

- replacing the Codex task loop;
- modifying `app.asar` or copied application logic to decide tools or task completion;
- keeping a forked UI implementation when the same surface can come from the current official package;
- treating injected UI helpers as an agent controller.

Every official Codex update must be synchronized from the official package, then the small branding/management compatibility layer is reapplied and verified. Product logic must not be manually copied between UI builds.

### 2.1 Hard Isolation From Original Codex

The official Codex installation is a read-only source for guarded package synchronization. It is not the executable or state used by Anti-Codex.

- The Anti-Codex CodexPlusPlus build must target the Anti-Codex client copy, never the original installed Codex executable.
- Anti-Codex must use its own `CODEX_HOME`, application-data root, session database, logs, reports, ports, shortcuts and process tree.
- CodexPlusPlus state used by Anti-Codex must also be isolated from any CodexPlusPlus configuration that targets original Codex.
- Original Codex installation files, `%USERPROFILE%\.codex`, sessions, login state, running processes and shortcuts must remain unchanged.
- Every compatibility, update and release test snapshots original Codex process IDs plus relevant file/state fingerprints before and after. Any unexplained change fails the gate.
- If the upstream CodexPlusPlus provider/proxy plus the seven approved patches cannot select the copied client path and isolated state, the compatibility gate fails. Anti-Codex must not fall back to operating on original Codex.

## 3. Layer 2: CodexPlusPlus Integration

Use upstream CodexPlusPlus as a separately licensed component. Its provider management and Responses/Chat protocol implementation remain upstream behavior. Anti-Codex carries exactly seven rebaseable patches: copied-product isolation, plain-HTTP loopback cancellation, exact native-helper tool suppression, frontend-model-directed dual-relay and compaction routing, image-bearing tool-output preservation, structured `apply_patch` priority/guidance, and suppression of late reasoning only after visible text has already begun so one Chat stream maps to one active Responses output item.

The native Codex frontend is authoritative for provider and model selection. Anti-Codex must expose one stable catalog containing exact Antigravity models, a generic Antigravity slot, a generic third-party slot and namespaced third-party models. The backend may translate those identifiers to an upstream relay/model, but it must never silently replace a concrete frontend selection with a different saved or fixed model.

Both Anti-Codex relay profiles remain configured and resident for the copied client's lifetime. Selecting a model routes the next request to the matching relay without restarting the copied client, the CodexPlusPlus helper, the fixed-route owner or the current native task. A provider failure must fail on that provider; it must not spend another provider through fallback rotation.

CodexPlusPlus responsibilities:

- launch the official desktop application without patching its installed files;
- configure an official-login-plus-API or pure-API provider;
- configure model catalog, base URL and Chat Completions protocol;
- expose Anti-Codex `管理` as the user-facing entry for a third-party provider URL, API key, model and supported protocol; test, save and apply that profile only to the isolated CodexPlusPlus state;
- route ordinary third-party Responses or Chat providers directly, with no Antigravity dependency;
- route reserved Anti-Codex model slots to one of the two resident relays while preserving concrete frontend-selected Antigravity models;
- provide its already implemented provider/session/UI integration where needed;
- translate the Codex client's Responses protocol to and from the adapter's standard Chat Completions protocol.

For Antigravity, the preferred route deliberately uses CodexPlusPlus's existing Chat Completions protocol proxy. For every other supported provider, CodexPlusPlus keeps its normal direct provider route. Anti-Codex does not reimplement provider management, Responses envelopes, history conversion or streaming state machines.

When a native task created under an Antigravity model is resumed after switching to a third-party provider, the unified catalog still retains that historical model id and its Codex tool-capability metadata. Explicit third-party choices use the `anticodex/third-party/` namespace and are stripped only at the upstream boundary. Generic slots resolve to the corresponding saved model. This is model-catalog and relay continuity only: it does not add retries, task control or another protocol layer.

Official Codex may issue native compaction before the next user turn while retaining the task's historical model id. The fourth patch recognizes only Codex's canonical `request_kind: compaction` metadata and aligns that request's model to the current known Anti-Codex frontend selection from isolated state. It changes no messages, tools, history, retry policy, compaction policy or task state. Unmarked user requests, unknown selections and ordinary CodexPlusPlus routes remain unchanged. This is a model-routing correction inside the existing CodexPlusPlus boundary, not a fourth controller or a home-grown compaction implementation.

The isolation patch is limited to an explicit CodexPlusPlus state directory, independently configurable proxy/guard ports, explicit fail-closed selection of the branded executable inside the copied app directory, copied-app-path-scoped process/manager handling, fail-closed absolute copied-app selection, and refusal to modify the shared current-user logon watcher. It may not alter provider payloads, model semantics, protocol conversion, retries or task behavior.

One transport-only exception is approved: plain HTTP loopback model streams use one-shot cancel-aware connections. A real downstream Codex cancellation drops that request immediately, including while response headers are pending, while every normal response is allowed to finish and close gracefully. The transport must never enable zero-linger or reset a successful stream. This exception does not inspect or change requests, responses, models, tools, history, retries, task state or completion. HTTPS and non-loopback third-party endpoints continue through upstream CodexPlusPlus's existing reqwest path. Gate 2 proves this boundary with deterministic checks.

One helper-safety exception is approved: when the **current user message** exactly matches the official Codex title helper or task-suggestion helper contract, CodexPlusPlus omits `tools`, `tool_choice` and `parallel_tool_calls` from that background request. Detection requires the official prefix and all stable contract markers; quoted helper text inside an ordinary user task does not match. Messages, model, stream mode, output conversion, retries and the active user task are unchanged. This prevents background helpers from executing workspace tools or competing with the real task without adding a task controller. The current complete protocol-proxy regression is 54/54.

License rule:

- do not paste or merge AGPL CodexPlusPlus source into the current non-commercial codebase;
- keep the component and isolation patch in a separately licensed AGPL source/build boundary and retain upstream notices;
- record every isolation patch hunk and keep it rebaseable against the pinned upstream commit;
- if any additional provider or protocol modification beyond the seven documented patches becomes necessary, stop and record the exact missing behavior before implementation;
- do not silently reimplement CodexPlusPlus behavior after a compatibility failure.

## 4. Layer 3: Thin Antigravity Chat Adapter

This is the only product-specific protocol component Anti-Codex writes, and only the Antigravity provider uses it.

It exposes only the standard upstream interfaces consumed by CodexPlusPlus, including:

- model discovery and model metadata;
- Chat Completions create and streaming lifecycle;
- standard text, reasoning and structured `tool_calls` fields that CodexPlusPlus supports;
- stable tool-call IDs and exact tool-result continuation;
- HTTP disconnect cancellation and local timeout propagation;
- authentication, account readiness, quota, network and upstream error mapping.

Its Antigravity-specific work is limited to:

- map system/developer/user content into structured Cascade inputs;
- publish Codex tool definitions through Antigravity native custom tools/MCP;
- convert a Cascade tool request into one standard Chat Completions tool call;
- resume the same Cascade with the exact tool result supplied by Codex;
- map Cascade text, finish, cancellation and errors back to Chat Completions output;
- maintain only the bounded opaque call/session correlation needed to resume the same Cascade.
- preserve official Codex structured helper schemas; Layer 2 enforces that title and task-suggestion helpers are text-only and cannot receive user-task tools.

It must not:

- execute user tools;
- generate or rewrite shell commands, patches, files or tests;
- infer a tool call from ordinary prose;
- retry a task, invent a repair turn, or decide that work is complete;
- inspect a workspace to compensate for model behavior;
- contain task names, marker rules, expected files or business-specific recovery;
- suppress a model request based on command meaning. Protocol-level duplicate call identifiers may be rejected, but a new semantic decision belongs to Codex.
- implement Codex Responses envelopes, `previous_response_id` history reconstruction, compaction or Codex streaming state; those belong to Codex and CodexPlusPlus.

## 5. Existing Asset Disposition

### Keep

- official Codex package synchronization, rollback and fingerprint checks;
- independent Anti-Codex state and process ownership;
- icons, product naming, shortcuts and minimal management entry;
- CodexPlusPlus's ordinary third-party provider catalog, configuration and direct routes;
- Antigravity account discovery, model catalog and health checks;
- proven Antigravity Cascade transport and native MCP/custom-tool access;
- response/cascade cancellation primitives and bounded identity storage;
- host-side real-task verifiers that inspect files, commands, exit codes and process state.

### Reuse only inside the new Provider Adapter after review

- `translator/antigravity-agentapi.mjs`;
- `translator/antigravity-native-mcp-bridge.mjs`;
- `translator/antigravity-native-harness-upstream.mjs`;
- Antigravity request registry, model routing, account and error classifiers;
- pure Antigravity transport and Chat framing helpers after contract review.

### Exit the active route

- the one-megabyte mixed `translator/adaptive-server.mjs` request path;
- self-written Codex/Chat translation that CodexPlusPlus already supplies;
- internal tools, deterministic tasks, marker/file/test awareness and artifact guards;
- command and Patch synthesis/rewrite used to compensate for agent behavior;
- automatic repair turns, forced verification, completion guessing and semantic retry loops;
- release gates that accept assistant wording or stale reports as product success.

Old code may remain temporarily for rollback while the new route is proven, but it must be unreachable from the default product route and visibly marked legacy. It is deleted after the real-task gates pass.

The exact file-by-file deletion ledger is [`LEGACY_REMOVAL_MANIFEST.md`](LEGACY_REMOVAL_MANIFEST.md). It is mandatory, not advisory.

## 6. Migration Gates

The steps are sequential. A failed gate blocks the next step.

1. **Inventory gate**: this document and the implementation audit identify every kept, reused and retired active-path module.
2. **No-traffic compatibility gate**: CodexPlusPlus with only the six documented patches launches/configures the Anti-Codex client copy with disposable isolated state against a deterministic local fake third-party Chat Completions provider. Model selection, history, one tool call/result, streaming, cancellation, terminal errors and text-only native helpers must pass without the Antigravity adapter, and original Codex files/processes/state must have zero changes. **Complete on v1.2.39; copied-client release proof must be rerun after each upstream update.**
3. **Provider contract gate**: a small standalone Antigravity Chat Adapter passes deterministic Chat Completions contract tests without the mixed server. **Complete: 19/19 deterministic tests plus one real exact native-tool continuation.**
4. **Route switch gate**: the disposable CodexPlusPlus provider points to the adapter; diagnostics prove the mixed translator is not serving the request. **Complete: 23/23 with one real native file-tool continuation and zero old-route hits.**
5. **Component integration gate**: the visible copied client is wired to the fixed route; current official Codex UI/features, Anti-Codex branding and bounded text/tool work pass. **Complete.**
6. **Bounded edge gate**: quota exhaustion, cancellation, tool failure, malformed arguments, adapter restart, client restart, same-task resume and parallel calls pass through focused tests. **Complete.**
7. **Component completion and release gate**: old active-path code is removed, official UI/brand regressions pass, packaging/update/rollback are proven, validation tasks are backed up/cleaned, and each of the three reported product parts reaches 100% implementation completion. **Complete.**
8. **Final long-task acceptance gate**: formal inventory and combined migration/greenfield journeys pass result-based host verification, followed by tangible media and website maintenance tasks across third-party and Antigravity routes. **Complete; current artifacts and receipts are recorded in `CURRENT_LONG_TASK_ACCEPTANCE.md`.**

## 7. Current Implemented Status (2026-07-19)

1. **Layer 1 shell/client: 100%.** The isolated copy is synchronized to official Codex `26.715.4045.0` with CLI `0.145.0-alpha.18`. Anti-Codex icons, Chinese `管理`, native task/tool behavior and original-Codex isolation remain intact. The required scheduled-task Node owner is hidden; a 120-second, eight-sample check kept one visible Anti-Codex window and the original Codex process alive.
2. **Layer 2 CodexPlusPlus: 100%.** Pinned upstream `v1.2.39` plus the six documented patches replays to tree `d8d9fd0f35e3eae44591b7a008a628b8006b6eea`. Ordinary third-party APIs still bypass Antigravity and use upstream conversion.
3. **Layer 3 Antigravity adapter: 100%.** The adapter remains a thin Chat-to-Cascade mapping. Real quota/location failures stop honestly, while provider fallback and artifact continuation remain Codex-owned.

Overall implementation and tangible long-task acceptance are 100%. Future Codex/CodexPlusPlus updates reopen only their compatibility and release checks, not this architecture.

## 8. Acceptance Rules

- Only host-observed files, byte hashes, command counts, exit codes, test results, protocol events, process state and conversation continuity count as proof.
- Model prose, final markers, local green summaries and report freshness never prove task completion by themselves.
- A command that completed successfully must not be repeatedly executed because of adapter state loss.
- Official Codex background title and task-suggestion helpers must not execute workspace tools or create competing task loops through the Antigravity route.
- A read-only turn must leave every project hash unchanged.
- A quota-exhausted model must fail promptly and must not be retried with the same exhausted model by the adapter.
- A client restart must resume through native Codex state without the adapter reconstructing the task.
- Release acceptance must cover repair of an existing project, interrupted/idempotent migration, and a new multi-module project. Every style is validated from files, hashes, command exits and hidden host checks rather than assistant wording.

## 9. Stop Rules

- If upstream CodexPlusPlus provider/proxy behavior cannot consume the standard local Chat Completions provider after isolation, stop after the compatibility proof and report the exact unsupported contract. Do not start another home-grown general translator.
- If Antigravity cannot produce one required structured Chat behavior, isolate only that mapping in the adapter and report it. Do not move task control upward or duplicate the CodexPlusPlus Responses translator.
- Any proposed change that adds task semantics outside Codex requires explicit user approval and a revision to this cornerstone document.
