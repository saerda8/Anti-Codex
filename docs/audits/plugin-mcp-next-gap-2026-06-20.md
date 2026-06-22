# Anti-Codex Plugin, Skill, and MCP Next Gaps

Date: 2026-06-20

## Current Truth

- Skills are local instruction files copied into the isolated Anti-Codex home.
- MCP entries are real local configuration, but a server is callable only when the Codex host exposes its tools in the current session.
- Internal `web_search` and `web_fetch` are real translator-owned tools.
- The Antigravity native MCP bridge is a real model/tool continuation path when native events are observed.
- Plugin and connector endpoints mostly project local cache metadata for Codex UI compatibility.
- App tools are exposed only for connectors whose cached state says `isAccessible === true`.

## Hard Boundaries

- Connector directory entries are not authorization.
- App-tool cache files are not proof that a tool is callable.
- A local allowlist must never turn an unauthorized remote connector into an apparently authorized tool.
- Anti-Codex must not require ChatGPT login to activate plugins or connectors.
- MCP names in configuration must not be described as active tools unless the host exposes them.
- Plugin metadata must not be converted into invented tool schemas.

## Completed Gate

The plugin capability verifier and local projection tests now enforce both directions:

- Accessible connector with no projected tools is reported as a mismatch.
- No accessible connector with projected tools is reported as fake callable capability.
- With mixed connectors, `/backend-api/wham/apps` returns tools only for accessible connector IDs.

## Next Developable Items

1. Real authorization-state inheritance

   Import connector accessibility only from a verified Codex local snapshot or another real local provider. Do not synthesize authorization. Verify with `test-anticodex-plugin-capabilities.ps1`.

2. Snapshot staleness reporting

   Surface whether Skill, MCP, connector, and app-tool snapshots are older than their shared source. Keep refresh explicit and isolated. Extend `test-anticodex-mcp-skills.ps1`.

3. Three-tier capability display

   Manager and diagnostics should distinguish inventory, locally verifiable configuration, and currently callable tools. Counts must satisfy inventory >= verifiable >= callable.

## Product Direction

The useful first-party plugin path is local Skills plus real MCP servers. Remote connector support should remain metadata-only until Anti-Codex can inherit genuine authorization and prove a working tool call without ChatGPT login.
