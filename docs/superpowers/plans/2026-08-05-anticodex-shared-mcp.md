# Anti-Codex Shared MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dynamically discovered, Anti-only shared MCP proxy and convert the existing leak guard to true-orphan-only enforcement.

**Architecture:** A Python preparer discovers local Worker MCPs by lifecycle tool contract, rewrites only their transports to an authenticated Anti-only loopback proxy, and persists exact source identities for the next start. The existing launcher starts the proxy before the copied client; the guard tracks exact Anti ownership and never caps live-core copies.

**Tech Stack:** Python 3.12 standard library, pinned `mcp-proxy`/MCP SDK in an Anti-only venv, PowerShell launcher integration, Node and Python tests.

---

### Task 1: Dynamic discovery and config generation

**Files:**
- Create: `scripts/anticodex_shared_mcp_proxy.py`
- Create: `translator/tests/test_anticodex_shared_mcp_proxy.py`

- [x] Write failing tests for Worker lifecycle discovery, exclusion of `node_repl`/remote/ordinary MCPs, generated authenticated URLs, and preservation of unrelated TOML.
- [x] Run `python -B -m pytest -p no:cacheprovider translator/tests/test_anticodex_shared_mcp_proxy.py -q`; expect failures because the module does not exist.
- [x] Implement the smallest dynamic parser and atomic prepare/rollback operations; do not add a name list.
- [x] Re-run the focused test; expect all cases to pass.

### Task 2: Isolated runtime and four-channel acceptance

**Files:**
- Modify: `scripts/anticodex_shared_mcp_proxy.py`
- Modify: `translator/tests/test_anticodex_shared_mcp_proxy.py`
- Create: `scripts/install-anticodex-shared-mcp.ps1`

- [x] Add failing tests for bearer rejection, duplicate-start mutex behavior, four simulated channel connections, one process per dummy service, and failure isolation.
- [x] Run the focused test and confirm the runtime assertions fail before implementation.
- [x] Adapt the pinned proxy runtime behind Anti-only defaults: loopback port, token, mutex, state, log, and venv paths.
- [x] Add an idempotent installer with private backup and uninstall/rollback metadata; it must not read or modify official Codex paths.
- [x] Run the focused test in an isolated temporary environment and verify no test processes or temporary directories remain.

### Task 3: Startup integration without hot restart

**Files:**
- Modify: `scripts/start-anticodex-fixed-route.mjs`
- Modify: `scripts/sync-anticodex-runtime.ps1`
- Modify: `translator/tests/anticodex-fixed-route-supervisor.test.mjs`

- [x] Add source-contract tests proving the shared layer is an identity-bound supervisor child, starts before the copied client, and is stopped by normal cleanup.
- [x] Run the focused Node test and confirm it fails.
- [x] Add the minimal supervisor child lifecycle and include the new runtime files in sync validation; never install dependencies or restart a live client from the launcher.
- [x] Re-run the focused Node test and PowerShell parser checks.

### Task 4: Remove fixed Worker-name assumptions

**Files:**
- Modify: `scripts/sync-shared-codex-config.mjs`
- Modify: `scripts/test-anticodex-mcp-skills.ps1`
- Modify: `translator/tests/shared-config-sync.test.mjs`

- [x] Replace the fixed 8/9-name fixture with arbitrary lifecycle-contract Workers, including a `deepseek-external` compatibility sample and a new unknown Worker.
- [x] Run `node --test translator/tests/shared-config-sync.test.mjs`; confirm the unknown Worker exposes the old fixed-list gap.
- [x] Classify development Workers by local transport plus lifecycle tool contract and keep ordinary/remote MCP behavior unchanged.
- [x] Re-run the focused tests and PowerShell parser check.

### Task 5: True-orphan-only guard

**Files:**
- Modify: `scripts/anticodex_mcp_leak_guard.py`
- Modify: `translator/tests/test_anticodex_mcp_leak_guard.py`

- [x] Add failing tests proving live Anti-core duplicates are report-only, only exact previously observed Anti-owned processes become orphan candidates after their recorded roots disappear, and official roots/workers are excluded.
- [x] Run the guard test; confirm the old high-water selection fails the new contract.
- [x] Replace live signature capping with persisted exact ownership tracking, two-scan confirmation, and final PID/creation/signature/root revalidation.
- [x] Re-run the focused guard test; expect all cases to pass.

### Task 6: Offline acceptance, checkpoint, and no-restart install

**Files:**
- Modify only if results require it: files listed above
- Update: `task_plan.md`
- Update: `findings.md`

- [x] Run all focused Python/Node/PowerShell checks plus the four-channel dummy acceptance.
- [x] Read-only snapshot official Codex PIDs/hashes before and after; confirm unchanged and confirm Anti/official target paths never overlap.
- [x] Remove test caches and temporary artifacts, review `git status`/`git diff`, then commit only task files.
- [x] If the source is green, run the existing runtime synchronizer in no-restart mode only. Do not start Anti-Codex; report whether next-start activation remains.

### 2026-08-07 closure evidence

- Source commits: `fd1c027b`, fixture repair `84d3ea4`, installer hash repair `9c55d1d`.
- Complete no-traffic source preflight passes `932/932`, with zero failure/warning and `usedRealTraffic:false`; report SHA-256 is `6cad6f776715831f822fda48cd88f3b595c55d3f81bacd8b4cc788ddac9dec9d`.
- No-restart transaction `20260807T053305680Z-a51d577a21644d819570936688f37456` activated 125 verified files. The shared component returns `already-current`; source/runtime/installed proxy hashes match.
- Anti-Codex remained stopped and official Codex PIDs were unchanged. Product-local Worker count is currently zero, so actual shared Worker processes will appear only after a future Worker is enabled and Anti-Codex is normally started.
