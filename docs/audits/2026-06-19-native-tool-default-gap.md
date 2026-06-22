# Native Tool Default Closure

## Result

Anti-Codex now uses Antigravity's native MCP customization path by default for Codex function, MCP-namespace, and custom tools. The prompt-mediated bridge remains a bounded compatibility fallback, not the normal path.

## Default Data Flow

1. Codex sends Responses tool schemas to the local translator.
2. `antigravity-upstream.mjs` creates a loopback MCP server and passes its URL through `StartCascade.customAgentSpec`.
3. Antigravity discovers the tools through MCP `initialize` and `tools/list`.
4. When the trajectory exposes a waiting `CORTEX_STEP_TYPE_MCP_TOOL`, `antigravity-agentapi.mjs` immediately sends the proven `HandleCascadeUserInteraction` approval and captures the resulting MCP `tools/call` request.
5. Anti-Codex emits the call through the Codex Responses contract. Codex owns approval and execution of the actual local tool.
6. The Codex tool result completes the pending MCP HTTP call, and Antigravity resumes the same Cascade.

## Permission Behavior

Antigravity-owned file, command, browser, MCP, and permission tools remain disabled through `antigravityModelOnlyToolConfig()`. The only enabled external tools are the ephemeral Codex schemas exposed by Anti-Codex. Their MCP permission interaction is answered automatically before Codex execution, so the user does not need to approve the same action again in Antigravity.

## Fallback Boundary

If native MCP setup or interaction fails before any Codex-visible event, Anti-Codex retries the turn through the prompt-mediated compatibility bridge. It does not use this fallback for account verification, quota, proxy, network, or other real upstream failures. After a Codex-visible event, it never restarts through fallback because that could duplicate output or tool execution.

## Evidence

- Source regression: 491 tests, 457 passed, 34 skipped, 0 failed.
- Installed diagnostics: `native-mcp-same-cascade`, native default enabled, automatic permission mode, eight models.
- Installed live single-tool loop: passed in 6.4 seconds.
- Installed live serialized two-tool loop: passed in 10.5 seconds.
- Translator recovery, sync readiness, and desktop UI state: passed; original Codex config unchanged.

## Remaining Explicit Boundaries

- Responses WebSocket remains an explicit verified `501 unsupported_websocket` fallback until the real Codex model WebSocket frame protocol is captured. Do not fake `101 Switching Protocols`.
- Model names and IDs remain sourced from the active Antigravity desktop account. Do not invent or normalize away version numbers.
- The prompt bridge is still retained for native-protocol recovery and explicit opt-out. Its use must not be reported as a native Antigravity tool event.
