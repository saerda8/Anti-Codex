# App Tools Gap: `appToolCount=0`

Date: 2026-06-14

## Finding

`appToolCount=0` is currently expected for the installed Anti-Codex runtime.

The local projection exposes connector directories and installed plugin metadata, but `/backend-api/wham/apps` only exposes callable app tools for connectors marked `isAccessible: true`. The installed runtime currently has:

- connectors: 1494
- enabled connectors: 1494
- accessible connectors: 0
- cached app-tool JSON files: present
- cached tool definitions inside those files: 0

So there is no real app-tool surface to expose.

## Why This Should Stay Conservative

The connector list is a directory, not proof that tools are authorized or callable. Exposing tools for `isAccessible: false` connectors would create fake capability in the UI and could make the model try calls that cannot succeed.

The current behavior is safer:

- show installed plugins and connector directory metadata
- keep skills and MCP available
- expose `/backend-api/wham/apps` tools only after a connector has real accessible tool definitions

## Verification Boundary

`scripts/test-anticodex-plugin-capabilities.ps1` now treats `appToolCount=0` as valid when `accessibleConnectorCount=0`. It fails only if accessible connectors exist but no tools are exposed, which would indicate a cache or projection mismatch.

## Next Real Fix

A future implementation should add one of these, in order:

1. A real Antigravity or local app-tool authorization path that writes `isAccessible: true` and tool definitions.
2. A local-only developer allowlist for specific connector IDs, clearly marked unsafe for normal use.
3. A generated local tool index from plugin metadata, only if each generated tool can actually execute.

Do not fake app tools just to make the count nonzero.
