# Anti-Codex Windows

Anti-Codex for Windows installs an isolated patched Codex Desktop host under `%LOCALAPPDATA%\Anti-Codex`. It keeps the official Codex installation untouched and runs through the local Anti-Codex gateway.

## Requirements

- Codex Desktop for Windows
- Node.js available as `node.exe`
- A signed-in Antigravity Desktop account for the default model route

## Install

From the repository or release package root, double-click:

```text
install-windows.bat
```

The installer copies the Anti-Codex runtime to:

```text
%LOCALAPPDATA%\Anti-Codex\runtime
```

It also creates:

- Launcher shortcut: `Anti-Codex.lnk`
- Start Menu folder: `Anti-Codex`
- Patched Codex host: `%LOCALAPPDATA%\Anti-Codex\codex-patched-app`
- Isolated state root: `%APPDATA%\anticodex`

## Run Without Installing

For development, the shared launcher script is still named for legacy compatibility:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\start-deepcodex.ps1
```

That script starts Anti-Codex mode when the Anti-Codex environment is active. Do not rename it without a dedicated migration because installed recovery, sync, and tests still use the compatibility entry point.

Optional environment variables:

```powershell
$env:CODEX_BIN = "C:\Path\To\Codex.exe"
$env:NODE_BIN = "C:\Path\To\node.exe"
$env:DEEPCODEX_WORKSPACE = "C:\Path\To\Project"
```

## Runtime Paths

```text
%LOCALAPPDATA%\Anti-Codex\runtime
%LOCALAPPDATA%\Anti-Codex\codex-patched-app
%APPDATA%\anticodex\codex-home-deepseek-app
%APPDATA%\anticodex\reports
```

Some internal files and environment variables still contain `deepcodex` or `DEEPCODEX_*` for compatibility with older state, launchers, and recovery scripts. These are internal names, not user-facing branding.

## Notes

- Anti-Codex does not require ChatGPT login or connector authorization.
- The default route uses Antigravity Desktop through the local gateway.
- Third-party API profiles are configured from the Anti-Codex Manager and use the same isolated state root.
- PowerShell 5.1 is supported.
- The installed Anti-Codex state is separate from the normal Codex state.
- Anti-Codex sets `CODEX_ELECTRON_USER_DATA_PATH` so it can run while normal Codex is already open.
- Skills, MCP config, plugin metadata, connector directory snapshots, and app-tool cache snapshots are copied into the isolated Anti-Codex home.
- Remote connectors are shown as metadata until truly authorized; local allowlists do not make app tools callable.
- The official Codex installation is not modified. Anti-Codex copies the Codex app into its own local patched folder.

## Windows npm / npx Command Note

Anti-Codex creates command shims under its isolated runtime/state paths.

On Windows, plugin or skill commands should call Node package managers through their `.cmd` launchers:

```powershell
npx.cmd --version
npm.cmd --version
pnpm.cmd --version
yarn.cmd --version
```

Avoid this pattern:

```powershell
$env:Path = "C:\Program Files\nodejs;" + $env:Path
Start-Process -FilePath "npx" -ArgumentList "remotion","studio"
```

That can cause Windows to open `C:\Program Files\nodejs\npx.ps1` as a text document. Prefer:

```powershell
Start-Process -FilePath "npx.cmd" -ArgumentList "remotion","studio"
```

or:

```powershell
cmd.exe /d /s /c "npx.cmd remotion studio"
```
