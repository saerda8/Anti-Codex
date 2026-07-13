# Anti-Codex

Anti-Codex is an independently runnable copy of Codex Desktop powered by model text from the current Antigravity entitlement. It does not require ChatGPT login or a DeepSeek API key.

The authoritative architecture is [`docs/PRODUCT_ARCHITECTURE.md`](docs/PRODUCT_ARCHITECTURE.md), and the current keep/improve/delete/incomplete ledger is [`docs/CURRENT_IMPLEMENTATION_AUDIT.md`](docs/CURRENT_IMPLEMENTATION_AUDIT.md). Current product completion is **64%**; Anti-Codex must not yet be described as ready for real projects.

It preserves the Codex UI and core workflow while keeping its executable, taskbar identity, state, and configuration isolated from the original Codex installation. Both applications can run at the same time.

Client maintenance follows one rule: when Codex updates, Anti-Codex tracks it through guarded client sync and then reapplies Anti-Codex branding, isolation, launcher, and model-adapter patches. It is not a feature-by-feature reimplementation of Codex.

## Capabilities

- Exact Antigravity-entitlement model names and reasoning levels
- Cancellation and long-context foundations; true incremental streaming and pure-protocol compaction are still being migrated
- Codex function/custom tool, MCP, Skill, and plugin definitions can be discovered, but the Codex Desktop tool loop is not yet accepted on the new architecture
- Independent state with no writes to the original Codex configuration
- Guarded synchronization after Codex updates, with candidate validation and rollback
- Installed checks for models, UI, account/proxy readiness, sync, diagnostics, and stability

## Requirements

1. Official Codex Desktop for Windows
2. Antigravity CLI or Desktop with a signed-in account (for model-entitlement text)
3. Any proxy Antigravity needs to reach Google services

The installed runtime currently uses Antigravity Desktop Cascade for model text, catalog, and account discovery. The production target is a structured model interface that reuses the signed-in entitlement without letting the Antigravity agent control the task. The current single-text role/tool bridge is a deletion target because a real Cascade classified it as prompt injection.

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
