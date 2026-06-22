# Anti-Codex Real Task Verifier Review

Date: 2026-06-22

Purpose: check which existing verifiers prove the user-facing chain: Chinese reply, real Antigravity model traffic, tool-call loop, and no legacy DeepCodex text.

## Findings

- `scripts/test-anticodex-codex-responses.ps1` validates the client-facing `/codex/responses` SSE path, Chinese output, marker preservation, model route audit, and no `DeepCodex` leakage. It does use real Antigravity traffic.
- `scripts/test-anticodex-native-tool-loop.ps1` validates the native MCP same-Cascade tool bridge with real tool call events and continuation. It is the strongest low-level tool-loop verifier, but it does not currently assert Chinese output or legacy-brand leakage.
- `scripts/test-anticodex-real-mini-tool.ps1` validates a two-turn real-model function-call contract, Chinese final answer, marker preservation, and no `DeepCodex` leakage. The test harness executes the local file write itself after the model emits a function call, so it proves the model/tool-call contract rather than the native MCP execution layer.
- `scripts/test-anticodex-real-work.ps1` adds a real `node_repl` MCP smoke call plus the same two-turn model contract. It is broader than the mini verifier, but still does not combine every signal into one single user-facing scenario.

## Recommendation

Run in this order:

1. `test-anticodex-codex-responses.ps1` to prove normal Chinese response streaming and branding.
2. `test-anticodex-native-tool-loop.ps1` to prove the native tool bridge.
3. Add or extend a single combined verifier later: Chinese prompt + native tool call + final Chinese answer + no `DeepCodex`.

Worker note: the first Antigravity audit job returned an empty parsed result, so this report was reviewed and corrected by the main agent before use.
