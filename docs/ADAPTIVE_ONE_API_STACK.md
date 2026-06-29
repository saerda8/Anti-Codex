# Anti-Codex provider stack

Current topology:

```text
Anti-Codex desktop/runtime
  -> local translator gateway :8282
  -> Antigravity entitlement supplies model text
  -> optional third-party provider profile when explicitly configured
```

This document describes the current provider path. It replaces the older
one-api bootstrap notes, which are no longer the default setup path.

## Current defaults

- Anti-Codex talks to the local translator at `http://127.0.0.1:8282`.
- Antigravity entitlement supplies model text through the local runtime.
- Optional third-party providers are configured through the Manager third-party
  API panel and must be explicitly saved, tested, and applied.
- Provider keys stay in the local Anti-Codex profile storage. Do not put real
  keys in this document, examples, or checked-in scripts.
- The original Codex installation and account state are not mutated.

## Provider switching contract

- Switching from Antigravity to a third-party provider must not require a
  ChatGPT login path.
- Switching between third-party providers must preserve usable multi-turn
  history, including structured tool-call/tool-result pairs.
- Switching protocols must preserve the conversation in the target request
  shape:
  - OpenAI-compatible providers receive `assistant.tool_calls` plus matching
    `role:"tool"` results.
  - Anthropic-compatible providers receive `tool_use` plus matching
    `tool_result` blocks.
- A saved provider profile that cannot be read or decrypted must fail closed
  instead of silently falling back to the wrong upstream.
- Restoring Antigravity must remain possible even when an old third-party key
  is unreadable.

## Local tool and connector boundary

- Shared MCP servers, skills, plugin metadata, and connector metadata are
  mirrored into Anti-Codex-owned local state so Anti-Codex sees the same local
  capabilities as this Codex session.
- Metadata parity does not grant connector authorization. Callable app tools
  remain unavailable until the real connector is authorized.
- Anti-Codex must not spoof connector access, expose blocked connector install
  URLs, or mark hidden/orphan cached tools as callable.
- Local metadata refreshes should copy capability snapshots only and must not
  write back into the original Codex state.

## Translator responsibility

- Convert Codex Responses requests into the active provider protocol.
- Preserve local tool surfaces:
  - `function` tools remain callable.
  - `custom` tools such as `apply_patch` keep freeform/grammar metadata in the
    routing table.
  - `namespace` tools are flattened to callable chat tools and mapped back on
    response.
- Keep hosted/account-bound tools disabled when the active upstream cannot
  genuinely provide them.
- Inject translator-owned internal tools only when allowed and only outside
  compact mode.
- Treat `/responses/compact` as a separate request mode with no tools.

## Legacy one-api notes

The old one-api relay path was useful during early provider-routing work, but
it is not the current Anti-Codex default. Scripts or paths with compatibility
names may still exist for historical or migration reasons; do not present them
as the user setup path unless a future task deliberately revives that route and
adds fresh verification.

Before reintroducing one-api, require new evidence that it preserves current
Anti-Codex invariants: no ChatGPT login path, no original Codex mutation, no
fake connector authorization, provider history continuity, local MCP/skill
parity, and bounded verifier coverage.
