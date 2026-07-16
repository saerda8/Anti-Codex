# CodexPlusPlus Runtime Adoption Audit

- Date: 2026-07-14
- Upstream: `BigPizzaV3/CodexPlusPlus`
- Pinned commit: `91a83acd8bdf79a388a106c7c1ea76f9df6bcea9` (`v1.2.36`)
- Upstream license: `AGPL-3.0-only`
- Decision: runtime component at a separate AGPL source/build boundary

## 1. Final Decision

Anti-Codex uses CodexPlusPlus rather than rewriting its provider and Responses/Chat conversion stack.

```text
isolated copied official Codex
  -> CodexPlusPlus
     -> ordinary third-party Responses/Chat API directly
     -> Antigravity only: thin standard Chat API to native Cascade adapter
```

Codex keeps task planning, tools, execution, retries, history, continuation, compaction and completion. CodexPlusPlus keeps provider management and the general Responses/Chat conversion. The Anti-Codex adapter maps only standard Chat fields and structured tool calls to native Antigravity Cascade transport.

The previous idea of using CodexPlusPlus only as a behavioral reference and independently rewriting its protocol layer is superseded.

## 2. What Is Reused Unchanged

- provider configuration and selection;
- ordinary third-party Responses and Chat Completions routes;
- Codex Responses-to-Chat request conversion;
- text, reasoning, tool-call and tool-result streaming conversion;
- provider error and usage mapping;
- official copied-client launch support through explicit `--app-path`;
- `CODEX_HOME` propagation and configurable launcher/manager guard ports.

No Anti-Codex code may duplicate or semantically modify those paths without a new user-approved architecture decision.

## 3. Why Antigravity Still Needs One Thin Adapter

CodexPlusPlus expects a standard provider API. Antigravity's direct usable boundary is the stateful Desktop Cascade API:

- `StartCascade` plus structured system/current-user input;
- native custom/MCP tool definitions and trajectory events;
- exact same-Cascade tool-result continuation;
- Cascade cancellation, completion, quota and transport errors.

The adapter exposes this boundary as standard Chat Completions. It does not execute tools, inspect workspaces, invent commands, retry tasks, reconstruct Codex Responses history or judge completion.

Ordinary third-party providers never enter this adapter.

## 4. Required Isolation Patch

Unpatched upstream is reusable but cannot safely coexist with another CodexPlusPlus/Codex environment on this machine because it has four isolation blocker families:

1. fixed CodexPlusPlus state under the shared user profile;
2. fixed protocol-proxy port;
3. cross-installation Codex/Manager process discovery, activation, waiting and restart;
4. shared current-user logon watcher registry/shortcut registration.

The approved patch is limited to:

- absolute `CODEX_PLUS_STATE_DIR`;
- configurable `CODEX_PLUS_PROTOCOL_PROXY_PORT`;
- exact copied-app and Manager executable process scope;
- fail-closed isolated launch/restart without an absolute copied app path;
- refusal to install or uninstall the global logon watcher in isolated mode.

It does not change provider payloads, protocol conversion, model behavior, history, retries or task semantics.

## 5. Source And License Boundary

- The upstream source is not pasted into the deepcodex tree.
- `third_party/codexplusplus/upstream.json` pins the repository, version, commit, patch hash and verification state.
- `third_party/codexplusplus/patches/` contains the rebaseable derived patch.
- Any built/distributed CodexPlusPlus component and patch remain AGPL-licensed with upstream notices.
- Anti-Codex product-specific adapter code remains outside the CodexPlusPlus source tree.

## 6. Current Evidence

- patch cleanly replays on upstream `91a83acd`;
- repository isolation audit passes 9/9;
- audit regression suite passes 7/7;
- `cargo fmt --all -- --check` passes;
- patch and main-tree `git diff --check` pass;
- no Codex/CodexPlusPlus client was launched and no model traffic was used during this source gate;
- pinned cargo-xwin checks pass for core and Manager;
- Windows-native execution passes 124 core tests and 20 watcher tests;
- the release launcher build passes with SHA-256 `56dded2e546a9a54e4d6fc3988b324fb4a8102702a0d8b83140aa80fe22d54a1`.

Runtime isolation also passed 20/20 checks against copied Codex `26.707.9981.0`. The built launcher created only the selected `Anti-Codex.exe`, wrote only child-scoped state roots, left original Codex and the active Anti-Codex unchanged, and cleaned all test processes. Gate 1 is complete; Gate 2 now tests the unchanged upstream third-party Chat provider route.
