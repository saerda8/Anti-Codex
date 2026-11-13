# Anti-Codex

**[中文说明 (README.md)](README.md)** | **English Documentation**

Anti-Codex is an isolated copy of the official Codex Desktop application for Windows. It keeps the native Codex UI and agent harness intact, replaces only the model provider integration layer, and never mutates your original Codex installation, sign-in state, or local conversation data.

---

## 1. Project Purpose (Why Anti-Codex)

1. **Zero-Intrusion Side-by-Side Coexistence**: Official Codex Desktop is tied to its default account flow. Anti-Codex creates an isolated `Anti-Codex.exe` binary, distinct pink taskbar/tray icons, and separate state directories so you can run both official Codex and Anti-Codex simultaneously without conflict.
2. **100% Native Codex Agent Loop**: Anti-Codex does not reimplement task control. The native Codex harness exclusively owns planning, tools, shell commands, file edits, approvals, retries, continuation, context compaction, and completion judgment.
3. **Flexible Provider Routing**: Connect directly to ordinary third-party Responses or Chat Completions APIs, or reuse the model catalog and quota of a locally signed-in Antigravity Desktop app.
4. **Guarded Updates & Atomic Rollback**: Whenever official Codex Desktop updates on Windows, Anti-Codex builds a staged candidate, audits file deltas, re-signs ASAR integrity hashes, and validates compatibility before activation while keeping the previous working version ready for one-click rollback.

---

## 2. Three-Layer Architecture

The cornerstone of this repository is the locked [three-layer architecture](docs/THREE_LAYER_ARCHITECTURE.md) (see also [Adaptive Provider Stack](docs/ADAPTIVE_ONE_API_STACK.md)). No implementation may introduce a fourth task-control layer:

1. **Layer 1 — Isolated Official Codex Shell**: A guarded copy of the installed official Codex client with minimal isolation patches (branding, dedicated AppUserModelId, pink icons, local config bridge, and the in-app `管理` manager entry). Native Codex owns planning, tools, approvals, retries, compaction, and completion judgment.
2. **Layer 2 — CodexPlusPlus General Provider Layer**: Upstream `CodexPlusPlus` (pinned release + audited isolation patches) handles general Responses/Chat conversion and ordinary third-party API connections. Ordinary third-party traffic connects directly and bypasses Antigravity completely.
3. **Layer 3 — Thin Antigravity Adapter**: Activated only when an Antigravity model is selected. This thin adapter maps standard Chat Completions requests to the local Antigravity Desktop Cascade service, reusing its signed-in account, model catalog, and quota without taking over tools or task control.

> **Security & Authorization Boundary**: Original Codex files and user data remain untouched. Connector-backed app tools remain unavailable until genuinely authorized; copied local metadata never fakes or grants authorization.

---

## 3. Requirements

1. **OS & Base Client**: Windows 10 / 11 (x64) with the official **Codex Desktop** installed.
2. **Runtime**: **Node.js** (`node.exe` available on `PATH`) and Windows PowerShell 5.1.
3. **Model Source (either or both)**:
   - **Ordinary third-party API**: Endpoint URL, model name, and API key (does not require Antigravity).
   - **Antigravity models**: A signed-in **Antigravity Desktop** client with a working network connection.

---

## 4. Installation & Usage

### 1. First-Time Installation

From the root of this repository, double-click:

```text
install-windows.bat
```

(Or run `powershell -ExecutionPolicy Bypass -File .\scripts\install-anticodex.ps1` in PowerShell.)

The installer builds and validates the isolated host copy, installs the verified `CodexPlusPlus` component, and creates the `Anti-Codex` desktop shortcut and Start Menu folder.

### 2. Launching Anti-Codex

Open **Anti-Codex** from your Desktop shortcut or `Start Menu > Anti-Codex > Anti-Codex`.
- If Anti-Codex is already running, launching the shortcut cleanly focuses the existing window rather than spawning duplicate instances.

### 3. Selecting Models & Configuring Third-Party APIs

- **Open Manager**: Click the `管理` (Manage) item in the bottom-left profile menu inside Anti-Codex, or open `Start Menu > Anti-Codex > Manage Anti-Codex`.
- **Use Antigravity Models**: Ensure Antigravity Desktop is signed in, refresh status/models in `管理`, and pick your model and reasoning effort directly from the native Codex composer model menu.
- **Use Third-Party APIs**: Enter, test, and save your third-party provider URL, key, and model in `管理`. `CodexPlusPlus` routes ordinary third-party requests directly without entering the Antigravity adapter.
- **Fail-Closed Routing**: Provider or route mismatches fail closed with an explicit error instead of silently falling back to an unintended model.

### 4. Syncing After Official Codex Updates

After official Codex Desktop receives an update from Windows/Store, run:

```text
Start Menu > Anti-Codex > Sync Anti-Codex with Codex
```

Sync stages a candidate build, applies and verifies all critical shell patches and integrity hashes, and replaces the active host only when every gate passes. If validation fails, your active version and rollback checkpoint remain untouched.

### 5. Rolling Back

To revert to the previous validated host version at any time, run:

```text
Start Menu > Anti-Codex > Rollback Anti-Codex
```

---

## 5. Developer & Diagnostic Commands

```powershell
# Read-only check for official Codex updates and host drift
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-anticodex-update.ps1 -NoPersist

# Repair desktop/Start Menu shortcuts and isolated scheduled tasks
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\repair-anticodex-shortcuts.ps1

# Run fast no-traffic installed health & UI verification (zero token cost)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-anticodex-installed-overall.ps1 -NoTraffic -Fast

# Run unit & contract test suite
node --test --test-concurrency=2 translator/tests/*.test.mjs
```

---

## 6. Isolated Local Paths & Documentation Map

### Isolated Local Directories

```text
Install Root:  %LOCALAPPDATA%\Anti-Codex
Isolated State: %APPDATA%\anticodex
Reports:       %APPDATA%\anticodex\reports
```

### Key Repository Documents

- **Chinese README**: [README.md](README.md)
- **Windows Setup & Runtime Guide**: [docs/WINDOWS.md](docs/WINDOWS.md)
- **Three-Layer Architecture**: [docs/THREE_LAYER_ARCHITECTURE.md](docs/THREE_LAYER_ARCHITECTURE.md)
- **Adaptive Provider Stack**: [docs/ADAPTIVE_ONE_API_STACK.md](docs/ADAPTIVE_ONE_API_STACK.md)
- **1.0 Completion Checklist**: [COMPLETION_CHECKLIST.md](COMPLETION_CHECKLIST.md)
- **Upstream Maintenance Guide**: [MAINTENANCE.md](MAINTENANCE.md)
- **Known Limitations**: [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)
- **Legacy Removal Manifest**: [docs/LEGACY_REMOVAL_MANIFEST.md](docs/LEGACY_REMOVAL_MANIFEST.md)
- **License & Third-Party Notices**: [LICENSE](LICENSE) / [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
