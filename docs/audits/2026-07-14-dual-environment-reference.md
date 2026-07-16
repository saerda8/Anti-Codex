# Dual-Environment Reference Alignment

- Date: 2026-07-14
- Input: user-provided Windows official Codex plus CodexPlusPlus dual-environment design
- Purpose: cross-check isolation behavior; this is not a request to rebuild that standalone tool

## Adopted Principles

- `CODEX_HOME` and application-data overrides exist only in the launched child process environment; never set permanent user/system variables.
- Never read, display, copy or log credential file contents, and never copy `auth.json` between profiles.
- Different profile directories are necessary but do not prove desktop isolation.
- Runtime proof must detect single-instance activation, process reuse, CodexPlusPlus attaching to an existing original Codex process, and failure to propagate the intended state root.
- Unknown process environment or state ownership is recorded as unverified, never promoted to pass.
- Original Codex process IDs, executable paths, state fingerprints and shortcuts are captured before and after every launch test.
- Detection and dry-run checks precede any real launch. Tests use explicit copied paths and bounded install locations rather than guessing or scanning whole disks.

## Anti-Codex-Specific Differences

- Anti-Codex uses a guarded copy of the official Codex package, not a second launch of the installed package.
- Ordinary third-party API models use CodexPlusPlus directly and have no Antigravity dependency.
- Only Antigravity models use the thin Chat Completions-to-Cascade adapter.
- A fallback to one shared desktop instance, another Windows user, Sandbox or VM can be documented for diagnostics, but it cannot satisfy the Anti-Codex product release gate.

## Current CodexPlusPlus Source Result

Reusable without protocol changes:

- explicit copied application path;
- `CODEX_HOME` lookup;
- inherited child environment for a portable copied executable;
- configurable launcher guard port;
- complete existing third-party provider and Responses/Chat conversion behavior.

Isolation-only gaps:

- CodexPlusPlus settings/log/lock state is fixed to the user's `.codex-session-delete` directory;
- the protocol proxy port is fixed;
- portable-process discovery, activation, waiting and restart accept unrelated Codex installations instead of only the selected copied application path;
- a copied directory containing both `ChatGPT.exe` and `Anti-Codex.exe` defaults to `ChatGPT.exe` without an explicit branded-executable selector;
- logon watcher install/uninstall uses one shared current-user registry value and startup shortcut.

These gaps justify only a small separately licensed isolation patch. They do not justify changing or duplicating CodexPlusPlus provider/protocol code.

## Current Patch Result

- The separately licensed patch is pinned under `third_party/codexplusplus/` against upstream commit `91a83acd`.
- It adds an absolute state-root override, an independent protocol-proxy port, fail-closed branded executable selection, exact copied-app and manager process scope, fail-closed explicit app-path checks, and disables shared logon-watcher mutation in isolated mode.
- The repository audit passes 9/9 checks, its regression suite passes 7/7, and the saved patch cleanly replays with an identical tree on the pinned upstream commit.
- Pinned cargo-xwin checks pass for core and Manager, Windows-native execution passes 124 core plus 20 watcher tests, and the release launcher was built.
- Runtime isolation then passed 20/20 checks against copied Codex `26.707.9981.0`: child-only state paths received writes, invalid branded-executable selection failed closed, original Codex and the existing Anti-Codex stayed unchanged, and all test processes/state residue were cleaned. Gate 1 is complete.
