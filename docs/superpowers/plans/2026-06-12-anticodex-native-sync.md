# Anti-Codex Native Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely inherit new Codex Desktop releases without replacing a working Anti-Codex host until the new host passes compatibility checks.

**Architecture:** Build each update in an isolated candidate directory, validate the copied and patched host, then activate it while retaining the previous host for rollback. Keep Antigravity-specific behavior outside the copied Codex host wherever possible.

**Tech Stack:** PowerShell 5.1, Node.js tests, copied Codex Desktop host.

---

### Task 1: Candidate Host Contract

**Files:**
- Create: `scripts/test-anticodex-host-candidate.ps1`
- Modify: `translator/tests/anticodex-launcher.test.mjs`

- [x] Add a failing launcher test requiring a candidate validator.
- [x] Implement validation for required host files, patch marker, and bundled Codex CLI startup.
- [x] Run the focused launcher test.

### Task 2: Candidate Installation

**Files:**
- Modify: `scripts/install-anticodex.ps1`
- Modify: `translator/tests/anticodex-launcher.test.mjs`

- [x] Add a failing test requiring host-only installation into the guarded candidate path.
- [x] Allow only the normal install root or its fixed update-candidate child.
- [x] Ensure a failed critical branding patch cannot create a valid marker.
- [x] Run the focused launcher test.

### Task 3: Guarded Activation And Rollback

**Files:**
- Modify: `scripts/sync-anticodex.ps1`
- Modify: `translator/tests/anticodex-launcher.test.mjs`

- [x] Add a failing test requiring candidate validation before activation.
- [x] Build and validate the candidate before stopping the active Anti-Codex processes.
- [x] Move the current host to the rollback directory and activate the candidate.
- [x] Restore the rollback host if activation fails.
- [x] Run the focused launcher test.

### Task 4: Verification

**Files:**
- Test: `translator/tests/anticodex-launcher.test.mjs`

- [x] Parse all changed PowerShell scripts.
- [x] Run focused Anti-Codex launcher tests.
- [x] Run the Antigravity model/transport regression bundle.
- [x] Run `git diff --check`.
