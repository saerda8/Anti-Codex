# Fixed-Route Supervisor Contract Audit

- **Date:** 2026-07-15
- **Status:** Worker draft reviewed and corrected by the main agent
- **Scope:** Contract definition; runtime evidence is tracked separately

## 1. Overview

This document establishes the formal, verifiable requirements for implementing the three-layer supervisor launcher script ([scripts/start-anticodex-fixed-route.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/start-anticodex-fixed-route.mjs)). Under the cornerstone product architecture ([docs/THREE_LAYER_ARCHITECTURE.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/THREE_LAYER_ARCHITECTURE.md)), the supervisor acts strictly as a thin launcher and process coordinator. It must not take over task control, execute tools, or modify files.

---

## 2. Verifiable Requirements

### Requirement 1: Side-Effect-Free `--plan-json` Mode (plan-json 无副作用)
When invoked with the `--plan-json` flag, the script must output a valid JSON execution plan to standard output and exit immediately with code `0`.
- **Verifiable checks:**
  1. It must not spawn any processes (Codex, CodexPlusPlus, or Antigravity adapter).
  2. It must not perform any directory or file writes.
  3. It must not bind TCP ports or initiate network connections.
  4. The output JSON must hide sensitive environment variables (such as `UPSTREAM_API_KEY` / `SUPERVISOR_TEST_SECRET`) and verify route parameters (`ok: true`, `planOnly: true`, `route`, `launcherArgs`).
  5. The output must not contain the string `"antigravity-chat"` when the `--provider` is `"third-party"`.
- **References:** Tested by [translator/tests/anticodex-fixed-route-supervisor.test.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/tests/anticodex-fixed-route-supervisor.test.mjs#L25).

### Requirement 2: Thin Antigravity Adapter Integration (Antigravity 薄适配)
When `--provider` is set to `"antigravity"`, the supervisor must configure and spawn the thin local Antigravity Chat Completions adapter (Layer 3) on `--adapter-port`, mapping CodexPlusPlus's standard Chat Completions to the native Antigravity Cascade.
- **Verifiable checks:**
  1. `plan.route.adapterEnabled` must be `true`.
  2. `codexPlusPlusUpstreamUrl` must point to the local adapter port (`http://127.0.0.1:<adapter-port>/v1`).
  3. The adapter itself must contain no agent loops, workspace scans, tool executions, command rewrites, or auto-repair logic.
- **References:** Tested by [translator/tests/anticodex-fixed-route-supervisor.test.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/tests/anticodex-fixed-route-supervisor.test.mjs#L60).

### Requirement 3: Strict Third-Party Provider Bypass (第三方直通)
When `--provider` is set to `"third-party"`, the supervisor must bypass the Antigravity adapter entirely, routing CodexPlusPlus directly to the external HTTP/HTTPS upstream URL.
- **Verifiable checks:**
  1. `plan.route.adapterEnabled` must be `false`.
  2. `codexPlusPlusUpstreamUrl` must point to the external third-party API base URL.
  3. No Antigravity adapter process must be spawned.
- **References:** Described in [docs/THREE_LAYER_ARCHITECTURE.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/THREE_LAYER_ARCHITECTURE.md#L28) and [docs/FINAL_MIGRATION_PLAN.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/FINAL_MIGRATION_PLAN.md#L20).

### Requirement 4: Hard Isolated Process and State Tree (隔离状态)
The supervisor must use [resolveProductPaths](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/lib/anticodex-fixed-route.mjs#L5) to determine all paths based on the provided `--install-root` and `--state-root` arguments.
- **Verifiable checks:**
  1. It must pass isolated directory parameters (`CODEX_PLUS_STATE_DIR`, `CODEX_PLUS_APP_EXECUTABLE`, etc.) to CodexPlusPlus.
  2. It must inject `CODEX_HOME` and other isolation variables (`windows-appdata`, `windows-localappdata`) strictly within the spawned child environment, never mutating user-wide or system-wide settings.
  3. The user's original installed Codex environment, processes, sessions, and `%USERPROFILE%\.codex` directory must remain completely unmodified.
- **References:** [docs/THREE_LAYER_ARCHITECTURE.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/THREE_LAYER_ARCHITECTURE.md#L52).

### Requirement 5: Scoped Process Lifecycle Cleanup (只清理自有子进程)
Upon exit (normal, error, or cancellation), the supervisor must terminate only processes it launched or copied-client PIDs it observed after its own launch. The Antigravity provider may run in the supervisor process and be closed through its owned server handle.
- **Verifiable checks:**
  1. It must keep references or exact PIDs for owned processes and stop those exact process trees.
  2. It must not run global process killing commands (e.g., wildcard `taskkill /f /im ...`) that would terminate independent background processes or affect original Codex processes.
- **References:** [docs/LEGACY_REMOVAL_MANIFEST.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/LEGACY_REMOVAL_MANIFEST.md#L48).

### Requirement 6: Graceful Failure and No Window Loop Spam (不得自动反复拉起窗口)
If the Codex client UI, helper, or adapter crashes, the supervisor must log the error, save diagnostics, and exit gracefully.
- **Verifiable checks:**
  1. The supervisor must not enter an infinite loop of repeatedly relaunching the visible Codex window.
  2. Process exit codes must propagate cleanly to support external diagnostics.
- **References:** [docs/FINAL_MIGRATION_PLAN.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/FINAL_MIGRATION_PLAN.md#L143).

### Requirement 7: Absence of 4th-Layer Task Control (不得提出第四层任务控制器)
All task control, planning, tool selection, command execution, and completions belong strictly to the Codex client shell (Layer 1). The supervisor and adapter must not implement any agent controller, command loops, or task recovery logic (i.e., no fourth layer).
- **Verifiable checks:**
  1. The supervisor code must not intercept tool calls or rewrite outputs.
  2. No task-aware heuristics or semantic retries may be implemented in the launcher.
- **References:** [docs/THREE_LAYER_ARCHITECTURE.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/THREE_LAYER_ARCHITECTURE.md#L10) and [docs/LEGACY_REMOVAL_MANIFEST.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/LEGACY_REMOVAL_MANIFEST.md#L13).

### Requirement 8: Static Token Matching Constraints
To pass the static test assertions in [translator/tests/anticodex-fixed-route-supervisor.test.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/tests/anticodex-fixed-route-supervisor.test.mjs), the source code of [scripts/start-anticodex-fixed-route.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/start-anticodex-fixed-route.mjs) must satisfy the following checks:
- **Verifiable checks:**
  1. It must contain the literal strings: `startAntigravityChatProvider`, `buildAntigravityModelCatalog`, `buildCodexPlusPlusSettings`, `mergeCodexRouteConfig`, `getLauncherArgs`, `CODEX_PLUS_STATE_DIR`, `CODEX_PLUS_APP_EXECUTABLE`, `CODEX_PLUS_PROTOCOL_PROXY_PORT`, and `codexplusplus-component-manifest-v1`.
  2. It must not contain the strings: `adaptive-server.mjs`, `codex-native-protocol.mjs`, or `codex-native-sse.mjs`.
  3. It must not contain the literal string `--help`.
- **References:** Checked by [translator/tests/anticodex-fixed-route-supervisor.test.mjs](file:///G:/Trae-Project/Anti-Codex/deepcodex/translator/tests/anticodex-fixed-route-supervisor.test.mjs#L10-L23).

### Requirement 9: Pre-requisite Gate Alignment (三个部分到 100% 后才做长任务)
The supervisor must only run short verification smoke runs (Gates 5 and 6) and must not be used to execute long-context or repeated-edit project tasks (Gate 8) until all three core parts reach 100% implementation completion:
1. Anti-Codex shell plus native Codex client features = 100%
2. CodexPlusPlus general translation layer = 100%
3. Native Antigravity export plus thin Chat adapter = 100%
- **Verifiable checks:**
  1. Any attempt to run a Gate 8 long-project acceptance test prior to 100% completion on all parts is strictly forbidden.
- **References:** [docs/FINAL_MIGRATION_PLAN.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/FINAL_MIGRATION_PLAN.md#L53-L61) and [docs/FINAL_MIGRATION_PLAN.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/FINAL_MIGRATION_PLAN.md#L211-L218).

### Requirement 10: Strict Read-Only Workspace Execution (禁止写入运行态目录与源码)
The supervisor must adhere to a strict read-only policy for production source files, test suites, and the active workspace directory.
- **Verifiable checks:**
  1. All transient states, temporary files, logs, and configuration overrides must be stored within the isolated `stateRoot` directory resolved by [resolveProductPaths](file:///G:/Trae-Project/Anti-Codex/deepcodex/scripts/lib/anticodex-fixed-route.mjs#L5).
  2. The supervisor must not create or modify files inside `src/`, `translator/`, `scripts/lib/`, or any other workspace source code paths.
- **References:** [docs/FINAL_MIGRATION_PLAN.md](file:///G:/Trae-Project/Anti-Codex/deepcodex/docs/FINAL_MIGRATION_PLAN.md#L40).
