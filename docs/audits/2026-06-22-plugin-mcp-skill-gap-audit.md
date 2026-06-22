# Anti-Codex Plugin, MCP, and Skill Capability Gap Audit

**Audit Date**: 2026-06-22  
**Target File**: docs/audits/2026-06-22-plugin-mcp-skill-gap-audit.md  
**Scope**: Verification of Anti-Codex plugin, skills, MCP, and connector/app tools relative to standard Codex (no-login fallback).

---

## 1. Executive Summary

This audit assesses the gap between Anti-Codex's current local features (Skills, MCP, custom tools) and the standard Codex experience. Our goal is to make the system fully usable as a local assistant without relying on a ChatGPT login or credentials.

Currently, Anti-Codex achieves strong isolation and local projection:
- It correctly serves configuration, plugins list, local skills count, and connectors directory metadata.
- It bypasses ChatGPT authentication, keeping the local Codex UI responsive and preventing login retry storms.
- Real tool calling works in two modes: Cloud-based Antigravity agent loops (via a temporary local MCP bridge) and Client-driven third-party provider loops (where Codex client manages the processes directly).
- Custom MCP servers are now checked with a real stdio initialize + `tools/list` handshake. `node_repl` also gets a real tool-call smoke test.

However, key user experience gaps remain. Specifically, remote connectors are still metadata-only because ChatGPT login/authorization is intentionally blocked, and plugin/app-tool execution needs a safe local allowlist before the model can call those tools without faking capability.

---

## 2. Capability Tiers Analysis

The system architecture defines four main local capability categories, summarized by the following status:

| Capability Category | Inventory Count | Usable/Configured Count | Callable Tool Count | Mode / Capability Tier | Current Status & Assessment |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Skills** | 69 (via plugins) + copies | 100+ local skills | 100+ local skills | `instruction` | **Fully Usable**. Skill instructions are successfully injected into prompt payloads by the Codex client. |
| **MCP Servers** | Config-driven | Configured local servers | `node_repl` call + other servers `tools/list` | `current-session-tool-list` | **Locally Usable**. Commands are statically checked, `node_repl` is tool-call tested, and other MCP servers are handshake/list tested. |
| **Plugins** | 178 installed | 0 accessible | 0 callable | `metadata-only` | **Compatible/Passive**. Projected for UI compatibility. No active tool calling to prevent fake capability issues. |
| **Connectors** | 1494 cached | 0 authorized | 0 callable | `authorization-required` | **Disabled (No Login)**. Projected as directory-visible only. Access is blocked because authentication requires ChatGPT login. |

---

## 3. Detail Analysis of Capability Gaps

### 3.1 Already Available Capabilities
- **Isolated Local Projection**: Anti-Codex projects local snapshot directories (`cache/codex_app_directory` and `cache/codex_apps_tools`) and plugin folders. Endpoints like `/backend-api/ps/plugins/installed`, `/backend-api/plugins/list`, `/backend-api/aip/connectors` return complete lists, keeping Codex UI functional.
- **Local Config Synchronization**: Config blocks from the shared Codex home (`SharedCodexHome/config.toml`) are merged into the isolated Anti-Codex directory (`CodexHome/config.toml`), carrying over custom MCP servers and restoring safety flags.
- **Antigravity Cloud Native MCP Bridge**: A temporary HTTP-to-Stdio MCP bridge (`antigravity-native-mcp-bridge.mjs`) successfully bridges cloud-agent requests back to local Codex execution, allowing the model to invoke local tools.
- **Prompt-Based Skill Injection**: Codex client reads the local `$CODEX_HOME/skills` directory and dynamically injects `SKILL.md` contents into `<skills_instructions>` in the system prompt.
- **Local Web Tools**: Built-in web search and fetch tools (translator-owned) are directly exposed to the model.

### 3.2 Explicitly Unavailable/Temporarily Forbidden Capabilities
- **ChatGPT Login Routes**: Entirely disabled to maintain isolation and prevent telemetry/credential leakage.
- **Remote Plugin Marketplace**: The online marketplace is disabled; no remote plugin lookups or downloads are permitted.
- **Remote Connectors Linking**: Endpoints for connecting remote apps (`/links/oauth`, `/links/noauth`) return unsupported error payloads, preventing the user from triggering standard login screens.
- **Faking Tool Schemas**: The system strictly forbids generating tool definitions for unauthorized connectors (`isAccessible: false`) to avoid model hallucinations and execution failures.
- **Write-back to Shared Configuration**: The synchronization process only reads from the global shared Codex config and writes to the isolated local directory, protecting the original Codex installation.

### 3.3 User Experience and Validation Gaps
- **No Local Connector Authorization Path**: Since remote authentication is blocked, the user is presented with a large number of connectors in the UI directory that cannot be activated or authorized. There is no local allowlist or local key mapping to authorize a connector for local execution.
- **Automated Snapshot Staleness Alerting**: The Manager requires manual clicks to check features/snapshots status. There is no passive background drift check or automatic user warning when isolated copies diverge from the shared folder.
- **Simulated Plugin Execution Test**: There is no end-to-end integration test to simulate tool calling on a dummy authorized plugin connector to verify that mapping logic works fine.

---

## 4. Recommended Next Batch of 3-5 Implementation Items

1. **Local Developer Allowlist for App Tool Authorization**  
   Add a local override map in `config.toml` (e.g., `[local_authorized_connectors]`) that allows developers to manually mark specific connector IDs as `isAccessible = true` and load their cached app-tool definitions. This unlocks testing of local-first plugins without requiring ChatGPT login.
   
2. **End-to-End Local Plugin Tool Calling Integration Test**  
   Create an integration test (e.g., `scripts/test-anticodex-plugin-tool-loop.ps1`) that simulates an accessible local plugin connector, exposes its tool definitions to the model, triggers a tool call, and verifies the return value through the translator gateway.

3. **Automated Background Drift and Snapshot Freshness Check**  
   Implement a lightweight check on startup/idle to compare file hash/mtime manifests between `SharedCodexHome` and `CodexHome`. If a drift or staleness is detected, display a non-intrusive alert/badge in the Manager UI prompting a sync.

---

## 5. Answers to Specific Focus Questions

### 5.1 Are the Manager Buttons Just for Display and Not Actually Verified?
No, the buttons are **not** just for display. They trigger real asynchronous processes:
- Clicking "Check MCP/Skill" executes `test-anticodex-mcp-skills.ps1`.
- Clicking "Check Plugins/Apps" executes `test-anticodex-plugin-capabilities.ps1`.
- Clicking "Refresh MCP/Skills" executes `refresh-anticodex-local-features.ps1`.
However, the verification they perform is limited: they verify snapshot existence, configuration matching, and node_repl stdio calls, but they do not run active runtime tests for custom MCPs or attempt to call mock plugins.

### 5.2 Can MCP Actually Be Called by the Model?
Yes!
- **In Antigravity mode**: The remote agent SDK connects to a temporary local HTTP server acting as an MCP bridge (`antigravity-native-mcp-bridge.mjs`). When the agent issues a tool call, the bridge holds the connection, yields the task to Codex client, and awaits the local execution result.
- **In third-party mode (DeepSeek/OpenAI/Anthropic)**: The local Codex Desktop client itself spawns and manages MCP server child processes from `config.toml` and drives the tool-execution loop. The translation gateway simply flattens and unflattens the schemas and responses.

### 5.3 Are Skills Just Copied or Can They Enter Prompts?
They **do** enter the prompts:
- The Codex client dynamically loads skills from the local `$CODEX_HOME/skills` directory, reads matching `SKILL.md` files, and embeds them into the `<skills_instructions>` block of prompt payloads.
- The translator's system prompt injection also informs the model of the available local skills count to guide model behavior.

### 5.4 Will Connector/App Tools Mislead the User?
Yes, there is potential for confusion:
- The UI lists 1494 connectors from cache, but accessible connectors and callable tools are both 0.
- The Manager UI mitigates this by explaining that remote connectors are metadata-only and require authorization.
- The system prompt also explicitly instructs the model to inform the user that these connectors need to be connected/activated via Codex Settings rather than pretending they are directly callable.
- A local authorization bypass or mock allowlist is needed to resolve this discrepancy.

### 5.5 Will Refreshing MCP/Skills Break the Original Codex?
No, it is **100% safe**:
- The script `refresh-anticodex-local-features.ps1` reads from `SharedCodexHome` and copies/merges data into the isolated Anti-Codex directory (`CodexHome`).
- No write actions are performed against the shared global Codex config or directories.
