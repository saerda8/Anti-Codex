# Anti-Codex Real Usage Test Coverage Audit

Date: 2026-06-23
Status: refreshed after DeepCodex-branding and real-tool coverage updates

This audit tracks the real-user checks that matter most for Anti-Codex:

1. Chinese responses.
2. Real tool invocation.
3. Final task completion.
4. No user-visible `DeepCodex` residue.

## Current Coverage

### Chinese Responses

Covered by focused real-response scripts:

- `scripts/test-anticodex-codex-responses.ps1` sends a Chinese prompt through `/codex/responses`, requires `response.completed`, requires the marker, and checks for CJK text.
- `scripts/test-anticodex-real-mini-tool.ps1` and `scripts/test-anticodex-real-work.ps1` ask the model to confirm completion in Chinese after tool-result continuation and reject final replies without CJK text.
- `scripts/test-anticodex-native-tool-loop.ps1` also requires a Chinese continuation sentence after native-tool evidence.

### Real Tool Invocation

Partially covered, with stronger coverage than the original audit recorded:

- `scripts/test-anticodex-real-mini-tool.ps1` verifies model-generated `create_mini_tool` function-call intent and the final tool-result continuation.
- `scripts/test-anticodex-real-work.ps1` verifies model-generated `create_probe_file` function-call intent and now invokes the real local `node_repl` MCP smoke path through `Invoke-RealNodeReplMcpResult`.
- MCP/Skill coverage is separately checked by `scripts/test-anticodex-mcp-skills.ps1`, including a real `node_repl` smoke.

Remaining boundary: the mini-tool and probe-file scripts still simulate the requested tool result from the verifier side after checking the model's function-call shape. That is acceptable for routine no-traffic checks, while real MCP execution is covered by the MCP/Skill verifier and the real-work Node REPL smoke.

### Final Task Completion

Covered for the routine two-turn task shape:

- The mini-tool and real-work scripts require the second turn to include `CLI_OK` or `FILE_OK`, the unique marker, and no additional tool call.
- The native-tool loop requires `RECORDED`, the marker, Chinese text, and no legacy-brand leak.

Remaining boundary: these are bounded verifier scenarios, not a proof that every arbitrary long autonomous task will finish. Longer real work still belongs in explicit real-traffic or release gates.

### No User-Visible DeepCodex Residue

Covered by multiple layers:

- `scripts/test-anticodex-codex-responses.ps1` fails if the final `/codex/responses` text contains `DeepCodex`.
- `scripts/test-anticodex-real-mini-tool.ps1` and `scripts/test-anticodex-real-work.ps1` fail if final completion text leaks `DeepCodex`.
- `scripts/test-anticodex-native-tool-loop.ps1` fails on `DeepCodex` or `Deep Codex` in the continuation.
- `scripts/test-anticodex-model-switch-history.ps1` checks both turns for legacy-brand leakage.
- `scripts/test-anticodex-installed-overall.ps1` includes guard-wording checks and records `hasLegacyDeepCodex`.
- `translator/tests/anticodex-launcher.test.mjs` rejects legacy DeepCodex setup, launcher, documentation, and native Windows message-box wording in user-visible surfaces.

Internal compatibility names remain intentionally allowed, including `DEEPCODEX_*`, `start-deepcodex.ps1`, `deepcodex-translator.exe`, local state paths, and source class names. These names are not user-facing branding unless surfaced in UI text, dialogs, prompts, or model-visible output.

## Current Gaps

- Full installed desktop and live Antigravity traffic gates are still intentionally reserved for combined acceptance passes.
- The verifier set proves bounded scenarios. It does not replace broader release testing for long multi-step tasks.
- If new UI, launcher, or model-visible text paths are added, they should join the same legacy-brand rejection contract instead of relying on manual review.
