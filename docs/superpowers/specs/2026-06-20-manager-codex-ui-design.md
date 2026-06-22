# Anti-Codex Manager Codex-Style UI

## Goal
Replace the engineering-dashboard appearance with a restrained Codex-style in-app management surface while making action risk obvious before a click.

## Visual Direction
- Match the host Codex desktop surface: light when Codex is light and dark when Codex is dark, with subtle borders, compact typography, restrained shadows, 10-12px radii, and inherited Segoe/system UI fonts.
- The embedded Manager detects the active host theme and observes later theme changes without reopening. The local fallback page follows the operating-system color preference.
- Keep the Manager embedded in Anti-Codex. Do not open a browser page or add another floating entry button.
- Use neutral gray controls for routine actions and muted dark red controls for high-impact actions. Avoid bright warning red unless an action is actively failing.

## Action Groups
### Daily Actions
Read-only, refresh, diagnostic, or navigation actions:
- Refresh status
- Refresh models
- Open Antigravity account switching
- Check account/proxy
- Check install/sync readiness
- Check Codex updates
- Check MCP/Skill
- Check plugins/apps
- Generate diagnostics bundle

### Maintenance And High-Impact Actions
Actions that restart/synchronize host state, write local snapshots, run long checks, or consume real Antigravity traffic:
- Sync Codex update
- Refresh local features
- Fast no-traffic check
- Full no-traffic check
- Full post-verification with real traffic

## Interaction Rules
- Every action keeps its existing action id and behavior.
- Risk grouping is visual and semantic; no action is silently renamed into a safer meaning.
- Risk buttons use the same dark-red family and retain visible hover, focus, disabled, and busy states.
- The close target remains at least 44px high with a full rectangular hit area.
- Status cards and model details stay below actions, with lower visual priority than controls.

## Verification
- Static regression proves every action appears exactly once in the correct group.
- UI state proves the embedded panel has no floating Manager button, daily and risk groups render, risk buttons use the danger class, light and dark palettes are visually distinct, the active Manager theme matches the host, and the close hit grid remains complete.
- Installed runtime validation confirms the real Anti-Codex window renders the new version without login/reconnect text.
