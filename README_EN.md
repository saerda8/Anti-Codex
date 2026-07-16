# Anti-Codex

Anti-Codex is an isolated copy of the official Codex Desktop application. It
keeps the native Codex UI and harness, changes only provider integration, and
does not reimplement Codex task control.

The project cornerstone is the [three-layer architecture](docs/THREE_LAYER_ARCHITECTURE.md).
The current execution state is tracked in the [final migration plan](docs/FINAL_MIGRATION_PLAN.md).
No implementation may add a fourth task-control layer.

## Three Layers

1. **Isolated official Codex shell**: a guarded copy of the current official
   client with minimal isolation patches. The native Codex harness owns planning,
   tools, commands, files, approvals, retries, continuation, compaction, and
   completion judgment.
2. **CodexPlusPlus provider layer**: upstream CodexPlusPlus owns general
   Responses/Chat conversion and ordinary third-party API integration. Third-party
   traffic connects directly and bypasses Antigravity completely.
3. **Thin Antigravity adapter**: only Antigravity models use the standard Chat
   Completions-to-Cascade adapter. It reuses the signed-in Antigravity Desktop
   account, model catalog, and quota without taking over tools or task control.

The original Codex installation, account, tasks, and local data are not mutated.
Both applications can run together with independent names, taskbar/tray icons,
processes, and state roots.

## Capabilities

- Guarded synchronization with official Codex updates, including candidate
  copies, file-delta audit, verification, and rollback.
- Preserved Anti-Codex identity, icons, Chinese `管理` entry, and isolated runtime.
- Real Antigravity Desktop model catalog and account quota.
- Ordinary third-party Responses or Chat APIs with fail-closed routing.
- Native Codex function/custom tools, MCP, Skills, plugins, history,
  cancellation, and compaction.
- Connector-backed app tools remain unavailable until genuinely authorized;
  copied metadata never grants authorization.

## Requirements

1. Official Codex Desktop for Windows.
2. Node.js.
3. A signed-in Antigravity Desktop account and working network path when using
   Antigravity models.
4. The endpoint, model, and key for any ordinary third-party provider. This route
   does not depend on Antigravity.

## Install And Update

Run `install-windows.bat` for the first installation. Launch `Anti-Codex` from
the desktop or Start Menu. After official Codex updates, use:

```text
Start Menu > Anti-Codex > Sync Anti-Codex with Codex
```

Sync validates a candidate copy and its official-file delta before activation.
Failure keeps the current version and rollback point intact.

## Models And APIs

- Choose an available Antigravity model from `管理`.
- Test, save, and apply ordinary provider profiles from `管理`; CodexPlusPlus
  sends this traffic directly without entering the Antigravity adapter.
- The product uses one active Antigravity account and has no dual-account scheduler.

## Isolated Paths

```text
Install: %LOCALAPPDATA%\Anti-Codex
State:   %APPDATA%\anticodex
Reports: %APPDATA%\anticodex\reports
```

Some source files may retain historical compatibility names, but they cannot
return to the active architecture. See [LEGACY_REMOVAL_MANIFEST.md](docs/LEGACY_REMOVAL_MANIFEST.md).
