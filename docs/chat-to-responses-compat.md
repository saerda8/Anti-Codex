# Chat to Responses Compatibility and Responsibility Boundary

This document defines the responsibility boundary for protocol translation and routing between Codex Desktop, CodexPlusPlus, and the Antigravity Chat Adapter. It supersedes all legacy custom translation designs.

## 1. Core Responsibility Boundary

Anti-Codex operates strictly within a three-layer architecture. No fourth task-control layer is permitted.

```mermaid
flowchart TD
    Codex[Layer 1: Official Codex Shell] <--> CPP[Layer 2: CodexPlusPlus Isolation & Translation]
    CPP <-->|Third-Party Models| ThirdParty[Third-Party Responses or Chat API (Bypasses Antigravity)]
    CPP <-->|Antigravity Models| Adapter[Layer 3: Thin Antigravity Chat Adapter]
    Adapter <--> Cascade[Antigravity Desktop Cascade & Entitlement]
```

### Upstream CodexPlusPlus (Layer 2)
Upstream CodexPlusPlus is the sole layer responsible for the general protocol conversion between Codex Desktop's Responses-shaped protocol and standard Chat Completions.
* **Direct Connection:** All ordinary third-party Responses or Chat APIs are directly connected and managed by CodexPlusPlus. This traffic completely bypasses the Antigravity Chat Adapter.
* **Protocol Translation:** CodexPlusPlus handles the translation of Responses objects, SSE event sequences, `tool_call` mapping, `reasoning` mapping, `usage` / `finish_reason` mapping, and the `context_compaction` endpoint.
* **Anti-Codex Scope:** Anti-Codex does not reimplement these protocol elements or build a custom Responses translator.

### Thin Antigravity Chat Adapter (Layer 3)
The Antigravity Chat Adapter is a thin translation layer active **only** when an Antigravity model is selected.
* **Standard Interface:** It accepts standard Chat Completions structures (`messages`, `tools`, `tool_choice`) sent by CodexPlusPlus.
* **Structural Preservation:** It preserves the structural boundaries of messages, tools, tool-calls, and tool-results, mapping them directly to and from the Antigravity Desktop Cascade.
* **No Legacy Emulation:** It does not reimplement Responses objects, SSE event sequences, tool mapping, reasoning mapping, usage/finish reason mapping, or the compact endpoint.

---

## 2. Routing Separation and Fail-Closed Behavior

Third-party API routes and Antigravity routes must be explicitly separated at the gateway level.
* **Routing Separation:** If the selected provider is not Antigravity, the request must follow the standard CodexPlusPlus route to the external provider. It must never enter the Antigravity Chat Adapter or any other local translator.
* **Fail-Closed Policy:** Any invalid provider selection or routing mismatch must immediately fail-close, terminating the request path and returning appropriate error states.

---

## 3. Harness Ownership and Task Control

The official Codex harness retains exclusive ownership of execution loop decisions.
* **Harness Autonomy:** Codex Desktop's native harness alone decides planning, tool selection, tool execution, approvals, task retries, history compaction, and task completion.
* **No Cascade Intrusion:** The Antigravity Chat Adapter and Cascade must not take over these decisions. They are strictly prohibited from:
  - Executing user tools.
  - Rewriting, generating, or synthesizing shell commands, file edits, patches, or tests.
  - Inferring tool calls from prose or determining task completion.
  - Performing automatic repair turns or semantic retries.

---

## 4. Retired Legacy Components

The following legacy details and translations are retired and out of scope:
* **No Private Reasoning Replay:** Private reasoning hashes, decryption, or custom reasoning cache/replay prefixes are fully removed.
* **No Custom Translators:** All legacy details regarding custom DeepSeek, one-api, or mixed translators (`translator/adaptive-server.mjs`) are deleted from the active route.
