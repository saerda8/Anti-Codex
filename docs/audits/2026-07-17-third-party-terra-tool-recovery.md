# Third-Party Terra Tool Recovery

- Date: 2026-07-17
- Route: copied Codex shell -> pinned CodexPlusPlus -> third-party Chat API
- Model: `gpt-5.6-terra`
- Reasoning: medium
- Result: pass

## Root Cause

The third-party API and Terra model supported structured tool calls. The failure occurred earlier: the copied Codex harness did not recognize the third-party model ID as a complete tool-capable model, so the main task reached CodexPlusPlus with zero tools.

CodexPlusPlus was not stripping the tools. A sanitized boundary capture showed known bundled helper-model requests carrying tools in the same process while the Terra task carried none.

## Repair

The fixed-route supervisor now:

1. reads the bundled model catalog from the copied Codex CLI;
2. clones the native `gpt-5.4` capability template for the selected third-party model;
3. changes only identity and display fields;
4. writes `third-party-model-catalog.json` inside the isolated Codex home;
5. sets `model_catalog_json` before CodexPlusPlus launches the copied client.

This does not change CodexPlusPlus protocol translation, the official Codex task loop, or the Antigravity adapter.

## Evidence

- Route/supervisor focused tests: 25/25 pass.
- Real file-edit task: 20 tools exposed, 7 task tool calls, tool output observed, 2/2 tests pass.
- Real complex project: exactly 7 required files, `node:test` pass, CLI output `sourceCount:3` and `codexMentionCount:3`.
- Route restored after diagnosis to `http://localhost:8080`; the temporary recorder and capture files were removed.
- No API key appears in source or this report.
- The saved third-party profile remains available, while the final active route was switched once to `gemini-3-flash-agent` after quota recovery.
- Fresh Gemini same-task continuation: two visible turns, 2/2 host tests, exact first/final marker bytes, and CLI output `{"red":2,"blue":1,"green":1}`.
- Final no-traffic regression: 373/373 tests, MCP/Skills and plugin checks green, actual Manager close mouse checks green, release gates 1-8 complete and overall progress 100%.

## Product MCP Boundary

The nine project-development workers are not Anti-Codex product MCPs. They remain outside the copied client. The product currently keeps its native `node_repl`; verification rejects accidental development-worker inclusion.
