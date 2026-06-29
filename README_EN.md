# Anti-Codex

Anti-Codex is an independently runnable copy of Codex Desktop powered by model text from the current Antigravity entitlement. It does not require ChatGPT login or a DeepSeek API key.

It preserves the Codex UI and core workflow while keeping its executable, taskbar identity, state, and configuration isolated from the original Codex installation. Both applications can run at the same time.

## Capabilities

- Exact Antigravity-entitlement model names and reasoning levels
- Streaming, cancellation, long context, and compaction resume
- Codex function/custom tools, MCP, Skills, and local plugin snapshots owned by Anti-Codex/Codex
- Independent state with no writes to the original Codex configuration
- Guarded synchronization after Codex updates, with candidate validation and rollback
- Installed checks for models, UI, account/proxy readiness, sync, diagnostics, and stability

## Requirements

1. Official Codex Desktop for Windows
2. Antigravity Desktop with a signed-in account
3. Any proxy Antigravity needs to reach Google services

Local Anti-Codex-to-Antigravity traffic bypasses the proxy. Antigravity uses its own network settings for external model traffic.

## Install And Update

Run `install-windows.bat` for the first installation. Afterwards, use the Start Menu entry `Anti-Codex > Sync Anti-Codex with Codex` when the official Codex app updates.

The sync flow builds and validates a candidate first, retains a rollback host, and does not replace the active host when compatibility checks fail.

## Account Switching

Use `Anti-Codex > Manage Anti-Codex > Switch Antigravity Account`. Switch the account in Antigravity Desktop, then continue the guided check. Anti-Codex refreshes the anonymized account fingerprint and model catalog and verifies the installation.

## Third-Party API Configuration

The default route uses Antigravity entitlement for model text while Codex-owned tools stay in Anti-Codex. When a third-party API is needed, the supported entry point is Anti-Codex Manager: test the connection, then save and apply the upstream profile. Lower-level scripts are controlled write and restart helpers only. If a saved profile cannot be read, Anti-Codex refuses a silent wrong-upstream fallback.

## Connector Authorization Boundary

Anti-Codex syncs local MCP, Skills, plugin metadata, and connector metadata into its own isolated state, but metadata is not authorization. Connector-backed app tools remain unavailable until the real connector is authorized; Anti-Codex must not fake callable app tools from a cache snapshot.

## Explicit Boundaries

- Model Responses WebSocket currently uses an explicit HTTP/SSE fallback.
- Remote connectors requiring ChatGPT authorization remain disabled.
- Account changes and external proxy toggles require user interaction in their respective applications.

This project was adapted from `deepcodex`, so some historical source filenames remain. The default installer and runtime product are Anti-Codex.
