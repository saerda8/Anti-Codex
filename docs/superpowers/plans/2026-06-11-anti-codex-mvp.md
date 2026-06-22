# Anti-Codex MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dual-runnable Codex Desktop copy whose text-only model turns use the active local Antigravity account.

**Architecture:** Reuse DeepCodex's copied-host launcher and isolated state. Add an Antigravity adapter behind the existing local Responses-compatible translator, then replace DeepSeek-specific setup and branding with Anti-Codex behavior.

**Tech Stack:** PowerShell, Node.js, Codex Desktop copied host, Antigravity local language server `agentapi`.

---

### Task 1: Antigravity adapter probe

**Files:**
- Create: `translator/antigravity-agentapi.mjs`
- Create: `translator/tests/antigravity-agentapi.test.mjs`

- [ ] Write failing tests for connection discovery, prompt extraction, and agentapi output parsing.
- [ ] Run the focused test and confirm it fails because the adapter does not exist.
- [ ] Implement the smallest adapter that can create a text-only Antigravity conversation.
- [ ] Run focused tests and a real read-only smoke prompt.

### Task 2: Responses translator integration

**Files:**
- Modify: `translator/adaptive-server.mjs`
- Modify: `translator/tests/translator-compat.test.mjs`

- [ ] Write a failing test for selecting the Antigravity upstream.
- [ ] Add an explicit Antigravity upstream mode without changing the DeepSeek path.
- [ ] Return assistant text using the existing Responses response and event helpers.
- [ ] Reject unsupported MVP tool requests with a clear error.

### Task 3: Anti-Codex launcher and setup

**Files:**
- Modify: `scripts/start-deepcodex.ps1`
- Modify: `scripts/install-deepcodex.ps1`
- Modify: `install-windows.bat`

- [ ] Add an Anti-Codex mode with independent state and display name.
- [ ] Replace API-key setup with Antigravity installation/login readiness checks.
- [ ] Add an action that opens Antigravity for manual account switching.
- [ ] Verify the copied Codex host and official Codex can run together.

### Task 4: End-to-end validation

- [ ] Run all translator tests.
- [ ] Install the copied Anti-Codex host from the current Codex Desktop version.
- [ ] Start official Codex and Anti-Codex together.
- [ ] Complete one text-only Anti-Codex conversation through Antigravity.
- [ ] Confirm closing Anti-Codex leaves official Codex available.

