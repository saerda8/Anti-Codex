# Anti-Codex Plugin, Skill, MCP Boundary Audit

Date: 2026-06-20

Checked files:
- `translator/local-projection/index.mjs`
- `translator/adaptive-server.mjs`
- `translator/compat-rules.mjs`
- `translator/tools/registry.mjs`
- `scripts/test-anticodex-plugin-capabilities.ps1`
- `scripts/test-anticodex-mcp-skills.ps1`

## Current Real Capabilities

- Local Skills are real local instructions. Anti-Codex copies the Skill tree into its own state and reports Skill inventory to the model-facing system block. They are guidance, not remote executable plugins.
- Local MCP configuration is real local configuration. Anti-Codex can inherit and verify configured MCP servers, and the current runtime exposes MCP names as local context. Actual MCP execution still depends on the host exposing the matching tool in the current tool list.
- Internal web tools are real local tools. `web_search` and `web_fetch` can be injected and executed by the translator when hosted web tools are unavailable.
- The native Antigravity MCP bridge is a real bridge path for Codex-owned tool calls. It must keep tool execution on the Anti-Codex/Codex side and only treat Antigravity as the model route unless native tool events are actually observed and verified.
- Local account/auth projection is real local UI compatibility. It keeps Anti-Codex out of ChatGPT login while allowing the copied Codex UI to start.

## Snapshot-Only Surfaces

- Connector directory responses are metadata snapshots from the local Anti-Codex cache.
- Installed plugin list responses are metadata projections from local plugin cache files.
- `/backend-api/wham/apps` must expose callable app tools only for connectors that are actually accessible. With zero accessible connectors, zero app tools is the correct honest result.
- Cached connector install URLs or marketplace metadata do not prove a remote app is authorized.

## Do Not Claim

- Do not claim remote app connectors are callable when `isAccessible` is false or absent.
- Do not ask the user to log in with ChatGPT to make Anti-Codex work.
- Do not claim remote plugin marketplace features are enabled.
- Do not claim hosted OpenAI-only tools are available unless the current tool list actually exposes them.
- Do not convert plugin cache metadata into fake tool calls.

## Recommended Next Gates

- Keep the plugin capability verifier strict: if accessible connectors are zero, app tool count should remain zero.
- Keep Manager copy explicit: "local Skill/MCP available, remote connectors are directory-only unless authorized."
- Add a regression gate for any future local connector allowlist before exposing app tools.
- Keep all no-login and no-fake-callable assertions in the installed overall verifier.
