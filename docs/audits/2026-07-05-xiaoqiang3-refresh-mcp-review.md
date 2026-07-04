# 2026-07-05 Xiaoqiang3 Refresh MCP Review

## Scope
Reviewed the current diff only in `scripts/refresh-anticodex-local-features.ps1` and `scripts/test-anticodex-mcp-skills.ps1`, focusing on UTF-8 config reads, quoted MCP names, final config resync, and longer MCP smoke timeout. No external config or secrets were accessed.

## Findings
1. PASS: Config reads now use `Get-Content -Raw -Encoding UTF8` in the refreshed local config checks and MCP skill verifier comparisons.
2. PASS: Quoted MCP table keys are normalized during enumeration, and the MCP skill verifier can locate both bare and quoted server sections.
3. PASS: The refresh flow performs a final shared config resync after sidecar refresh before post-refresh config verification.
4. PASS: The MCP smoke timeout now allows a longer per-process window, capped at 20 seconds while keeping a 3 second floor.

## Final verdict
PASS
