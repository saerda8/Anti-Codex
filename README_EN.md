# Anti-Codex

<div align="center">

<img src="assets/anticodex-desktop-icon.png" alt="Anti-Codex Pink Desktop Icon" width="136" />

### Guarded, Isolated Official Codex Desktop Copy for Windows

[![Platform](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-0078D4?style=flat-square&logo=windows)](#3-requirements--prerequisites)
[![Architecture](https://img.shields.io/badge/Architecture-Locked%203--Layer-EC4899?style=flat-square)](#2-core-architecture-locked-3-layer-design)
[![Provider Layer](https://img.shields.io/badge/Provider-CodexPlusPlus%202.2.0-0EA5E9?style=flat-square)](#2-core-architecture-locked-3-layer-design)
[![Antigravity Route](https://img.shields.io/badge/Antigravity-Keep%20Desktop%20App%20Open-F59E0B?style=flat-square)](#important-keep-antigravity-desktop-open-when-using-antigravity-models)
[![License](https://img.shields.io/badge/License-Apache--2.0-10B981?style=flat-square)](LICENSE)

**[简体中文说明 (README.md)](README.md)** · **English Documentation** · **[3-Layer Architecture](docs/THREE_LAYER_ARCHITECTURE.md)** · **[Windows Guide](docs/WINDOWS.md)**

</div>

---

**Anti-Codex** is a guarded, `isolated` copy of the `official Codex` Desktop application for Windows. It preserves **100% of the native `Codex` UI, workflow, and underlying agent harness (`Codex` exclusively owns planning, `tools`, terminal commands, file edits, approvals, retries, and `compaction`)** while replacing only the model provider layer — letting you connect directly to third-party APIs or reuse your local **Antigravity Desktop** models and quota without touching a single file or login token of your original Codex installation.

> [!IMPORTANT]
> ### Important: Keep Antigravity Desktop Open When Using Antigravity Models!
> - **When using Antigravity models (MUST stay open)**: **Antigravity Desktop must be launched, signed in, and kept running in the background** (minimized is fine — do not quit it) the entire time you use Antigravity models in Anti-Codex. Anti-Codex bridges requests through your live local Antigravity Desktop `Cascade` service to fetch models and reuse your account quota; closing Antigravity will immediately stop model refresh and inference requests.
> - **When using ordinary third-party APIs (not required)**: Ordinary `third-party` traffic is routed directly by `CodexPlusPlus` to your configured provider endpoint and `bypasses` `Antigravity` completely. You do not need Antigravity open (or even installed) for standard API keys.

---

## 1. Visual Overview: Official Codex vs. Anti-Codex

<div align="center">
<table>
  <thead>
    <tr>
      <th align="center" width="240">Official Codex Desktop</th>
      <th align="center" width="240">Anti-Codex Isolated Copy</th>
      <th align="left">Side-by-Side Isolation Highlights</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center">
        <img src="assets/codex-icon-source.png" alt="Original Blue Codex Icon" width="76" /><br/>
        <sub><b>Original Blue Icon</b> · <code>ChatGPT.exe</code></sub>
      </td>
      <td align="center">
        <img src="assets/anticodex-icon.png" alt="Anti-Codex Pink Icon" width="84" /><br/>
        <sub><b>Distinct Pink Icon</b> · <code>Anti-Codex.exe</code></sub>
      </td>
      <td>
        <ul>
          <li><b>True Side-by-Side Coexistence</b>: Separate executable, pink taskbar/tray identity, and isolated Electron user-data paths.</li>
          <li><b>Zero Mutation to Original</b>: Never alters official WindowsApps files or <code>%USERPROFILE%\.codex</code> sessions/auth.</li>
          <li><b>100% Native Experience</b>: Keeps native diffs, terminal tool loop, approvals, compaction, and multimodal vision.</li>
        </ul>
      </td>
    </tr>
  </tbody>
</table>
</div>

### Why Anti-Codex?

| Goal | How Anti-Codex Solves It |
| :--- | :--- |
| **Protect your official Codex setup** | Copies the host into `%LOCALAPPDATA%\Anti-Codex` and stores all runtime state inside `%APPDATA%\anticodex`. |
| **Keep the real Codex agent harness** | No custom task loop; native `Codex` owns planning, `tools`, shell execution, approvals, retries, and `compaction`. |
| **Reuse local Antigravity Desktop quota** | Keep **Antigravity Desktop** open and pick Gemini / Claude models straight from the native Codex composer via a `thin` `Chat`-to-`Cascade` adapter. |
| **Connect any standard 3rd-party API** | Built-in `管理` (Manage) panel lets you test and switch to Responses or Chat Completions APIs directly. |
| **Safe updates & instant rollback** | Candidate host builds are patched, re-hashed, and gate-verified before atomic activation, keeping the prior version ready for 1-click rollback. |

---

## 2. Core Architecture (Locked 3-Layer Design)

<div align="center">
  <img src="assets/readme-architecture-en.svg" alt="Anti-Codex Locked Three-Layer Architecture Diagram" width="900" />
</div>

Anti-Codex is governed by a strict **[Three-Layer Architecture](docs/THREE_LAYER_ARCHITECTURE.md)** (see also **[Adaptive Provider Stack](docs/ADAPTIVE_ONE_API_STACK.md)**) and never introduces a fourth task-control layer:

1. **Layer 1 — Isolated Official Codex Shell**
   - Guarded copy of the installed official Codex Desktop app with minimal isolation patches (separate `Anti-Codex.exe`, AppUserModelId, pink icons, isolated state paths, and the in-app `管理` entry).
   - Native `Codex` owns planning, `tools`, command execution, approvals, retries, `compaction`, and completion decisions.
2. **Layer 2 — CodexPlusPlus General Provider Layer**
   - Upstream `CodexPlusPlus` (pinned release + audited isolation patches) handles general Responses/Chat conversion and ordinary third-party API connections.
   - **Direct Third-Party Bypass**: Ordinary `third-party` traffic connects directly to external providers and `bypasses` `Antigravity` completely.
3. **Layer 3 — Thin Antigravity Adapter**
   - Activated only when an Antigravity model is selected. This `thin` adapter maps standard `Chat` Completions requests to the running local Antigravity Desktop `Cascade` service, reusing its signed-in account, model catalog, and quota without taking over tools or task control.

> [!NOTE]
> **Security & Authorization Boundary**: Original Codex files and user data remain untouched. `Connector-backed app tools` remain unavailable until genuinely authorized; copied local metadata never fakes or grants authorization.

---

## 3. Requirements & Prerequisites

| Category | Requirement |
| :--- | :--- |
| **OS & Base Client** | Windows 10 / 11 (x64) with the official **Codex Desktop** installed (Microsoft Store / WindowsApps). |
| **Runtime** | **Node.js** (`node.exe` available on `PATH`) and Windows PowerShell 5.1. |
| **Route A: Antigravity Models** | **Antigravity Desktop** installed, signed in, and **kept open/running while using Anti-Codex**, with working network access. |
| **Route B: Ordinary 3rd-Party API** | Provider endpoint URL, model name, and API key (Antigravity does **not** need to be running or installed). |

---

## 4. Installation & Step-by-Step Usage

### Step 1: First-Time Installation

From the root of this repository, double-click:

```text
install-windows.bat
```

<details>
<summary>Or install from PowerShell (click to expand)</summary>

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-anticodex.ps1
```

The installer builds and validates the isolated host copy, deploys the verified `CodexPlusPlus` component, and creates the pink **Anti-Codex** Desktop shortcut and Start Menu folder.

</details>

### Step 2: Launch Anti-Codex (Check Prerequisites First!)

1. **If you plan to use Antigravity models**: **Launch Antigravity Desktop first and make sure it stays open and signed in** (leaving it in the background or minimized is fine).
2. Open **Anti-Codex** from your Desktop shortcut or `Start Menu > Anti-Codex > Anti-Codex`.
   - Launching the shortcut again while Anti-Codex is already open cleanly focuses the existing window instead of spawning duplicate instances.

### Step 3: Select Models, Vision Input & Third-Party APIs

- **Open Manager**: Click `管理` (Manage) in the bottom-left profile menu inside Anti-Codex, or open `Start Menu > Anti-Codex > Manage Anti-Codex`.
- **Use Antigravity Models**: Keep **Antigravity Desktop running**, refresh status/models in `管理`, and choose your desired model and reasoning effort directly from the native Codex composer menu.
- **Use Third-Party APIs**: In `管理`, click `配置第三方 API`, select Chat Completions or Responses, enter URL / model / API key, pass `测试连通` (Test Connection), and click `保存并切换` (Save & Switch). Click `恢复 Antigravity` anytime to switch back.
- **Fail-Closed Routing**: If the selected upstream is unreachable (for example, if Antigravity Desktop was closed), Anti-Codex fails closed with a clear error rather than silently switching to another model.

<div align="center">
  <img src="assets/vision-smoke.png" alt="Anti-Codex Multimodal Vision Smoke Asset" width="380" /><br/>
  <sub>Built-in multimodal vision verification asset (<code>assets/vision-smoke.png</code>) — native image attachment and visual inspection work out of the box</sub>
</div>

### Step 4: Sync After Official Codex Updates

Whenever official Codex Desktop updates via Microsoft Store, run:

```text
Start Menu > Anti-Codex > Sync Anti-Codex with Codex
```

Sync stages a candidate build, applies all shell/icon patches and ASAR integrity hashes, and replaces the active host only if every validation gate passes.

### Step 5: One-Click Rollback

To revert to the previous validated host version at any time, run:

```text
Start Menu > Anti-Codex > Rollback Anti-Codex
```

---

## 5. Quick Troubleshooting (FAQ)

1. **Why did model refresh or chat fail when using an Antigravity model?**
   - Make sure **Antigravity Desktop is currently open and signed in** on your machine, then click refresh inside Anti-Codex `管理`.
2. **Can I run original blue Codex and pink Anti-Codex at the same time?**
   - Yes. Their binaries, local ports, Electron user-data directories, and state roots are completely isolated.
3. **Do I need Antigravity running when using my own third-party API key?**
   - No. Ordinary third-party APIs are routed directly by `CodexPlusPlus` and bypass Antigravity.

---

## 6. Developer Commands & Documentation Map

<details>
<summary><b>Diagnostic & Verification Commands (click to expand)</b></summary>

```powershell
# 1. Read-only check for official Codex updates and host drift
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-anticodex-update.ps1 -NoPersist

# 2. Repair desktop/Start Menu shortcuts and isolated scheduled tasks
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\repair-anticodex-shortcuts.ps1

# 3. Fast no-traffic installed health & UI verification (zero token cost)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-anticodex-installed-overall.ps1 -EnsureRunning -NoTraffic -Fast

# 4. Full source preflight & unit test suite (concurrency capped at 2)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-anticodex-source-preflight.ps1
node --test --test-concurrency=2 translator/tests/*.test.mjs
```

</details>

### Isolated Local Directories (Untouched `%USERPROFILE%\.codex`)

| Purpose | Path |
| :--- | :--- |
| **Install & Patched Host Root** | `%LOCALAPPDATA%\Anti-Codex` |
| **Isolated Config & State** | `%APPDATA%\anticodex` |
| **Health & Verification Reports** | `%APPDATA%\anticodex\reports` |

### Key Repository Documents

- **Chinese README**: [README.md](README.md)
- **Windows Setup & Runtime Guide**: [docs/WINDOWS.md](docs/WINDOWS.md)
- **Three-Layer Architecture**: [docs/THREE_LAYER_ARCHITECTURE.md](docs/THREE_LAYER_ARCHITECTURE.md)
- **Adaptive Provider Stack**: [docs/ADAPTIVE_ONE_API_STACK.md](docs/ADAPTIVE_ONE_API_STACK.md)
- **1.0 Completion Checklist**: [COMPLETION_CHECKLIST.md](COMPLETION_CHECKLIST.md)
- **Upstream Maintenance Guide**: [MAINTENANCE.md](MAINTENANCE.md)
- **Known Limitations**: [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)
- **Legacy Removal Manifest**: [docs/LEGACY_REMOVAL_MANIFEST.md](docs/LEGACY_REMOVAL_MANIFEST.md)
- **License & Third-Party Notices**: [LICENSE](LICENSE) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)