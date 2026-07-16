# Anti-Codex Adaptive Provider Stack

This document defines the Anti-Codex three-layer provider architecture. The
authoritative specifications are [THREE_LAYER_ARCHITECTURE.md](THREE_LAYER_ARCHITECTURE.md)
and [FINAL_MIGRATION_PLAN.md](FINAL_MIGRATION_PLAN.md).

All legacy configurations, including the local mixed translator gateway (`:8282`), translator-owned tools, `/responses/compact` endpoints, and legacy `one-api` default routes are deprecated and removed from the active path.

---

## 1. Three-Layer Architecture

### Layer 1: Isolated Official Codex Shell
- **Definition**: A strictly isolated, guarded copy of the official Codex Desktop shell and native harness.
- **Ownership**: The official Codex native harness exclusively owns all core agent loop responsibilities. This means **Codex owns** planning, tool selection/execution, commands, files, approvals, continuation/retries, compaction, and task completion judgment.
- **Isolation**: Operates with its own runtime configuration, application-data root (`CODEX_HOME`), and environment variables. The original Codex installation files, user profiles (`%USERPROFILE%\.codex`), sessions, and login states remain completely untouched.

### Layer 2: CodexPlusPlus Integration
- **Definition**: Upstream **CodexPlusPlus** acts as the separate provider manager and protocol translation layer.
- **Function**: It directly handles ordinary **third-party** Responses/Chat API requests and general protocol conversion.
- **Routing**: All ordinary **third-party** APIs bypass **Antigravity** entirely, routing directly from **CodexPlusPlus** to the configured upstream endpoint.

### Layer 3: Thin Antigravity Chat Adapter
- **Definition**: The thinnest possible adapter mapping standard Chat Completions to the **Antigravity** Desktop **Cascade**.
- **Scope**: Used only for **Antigravity** models.
- **Function**: Reuses local desktop authentication, model catalog, and quota entitlements. It does not implement a self-written Responses translator, nor does it allow **Cascade** to take over tool execution or task control.

---

## 2. Security & Operational Boundaries

To ensure stability and isolate client state:
- **No Secrets in Database**: API keys and credentials must not be stored in a shared database or checked into source files. They must reside securely in local provider profile storage.
- **Original Codex Unmodified**: The original installed **official Codex** application, its databases, and user settings must never be mutated or interfered with.
- **Fail Closed**: Any provider routing failure, unreadable profile, or connection error must fail closed immediately. Misrouting of traffic or silent fallback to incorrect upstreams is strictly forbidden.
