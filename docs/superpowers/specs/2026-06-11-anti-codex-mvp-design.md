# Anti-Codex MVP Design

## Goal

Run Anti-Codex beside the official Codex Desktop. Anti-Codex reuses the installed
Codex host and its local capabilities, keeps independent app state, and routes
model turns through the locally signed-in Antigravity account.

## MVP Boundary

- Official Codex remains untouched and can run at the same time.
- Anti-Codex uses a separate `CODEX_HOME`, Electron user-data directory, app
  identity, conversations, and launcher process.
- Shared Codex rules, skills, plugins, and MCP registrations are synchronized
  into the isolated Anti-Codex state.
- Account switching is manual: close Anti-Codex, open Antigravity, switch or
  sign in, then reopen Anti-Codex.
- The first milestone only needs one real text conversation through
  Antigravity. Tool-call compatibility is the next milestone.

## Architecture

```text
Anti-Codex launcher
  -> isolated, patched copy of the currently installed Codex Desktop
  -> local Responses-compatible translator
  -> Antigravity local language server / agentapi
  -> active Antigravity account
```

The launcher and installer follow DeepCodex's current update model: installation
copies the user's current Codex Desktop host, patches only the copied host, and
never modifies the official app.

The translator owns protocol adaptation. It accepts Codex Responses-shaped
requests and converts the current turn into an Antigravity conversation request.
It then converts the returned assistant text into the Responses event format
expected by Codex Desktop.

## Failure Behavior

- If Antigravity is not installed, Anti-Codex shows a direct setup error.
- If Antigravity is not signed in or its local runtime is unavailable,
  Anti-Codex offers to open Antigravity and asks the user to retry after login.
- If a request contains unsupported tool behavior in the MVP, the translator
  returns a clear compatibility error instead of silently claiming completion.
- Closing Anti-Codex stops only Anti-Codex-owned translator and copied-host
  processes. It does not stop official Codex or Antigravity.

## Validation

The MVP is accepted when:

1. Official Codex and Anti-Codex can be open together.
2. Their local state and conversations are separate.
3. Anti-Codex can complete one real text-only turn using the active Antigravity
   account.
4. Closing and reopening Anti-Codex reconnects after a manual Antigravity
   account switch.

