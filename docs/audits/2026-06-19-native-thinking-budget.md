# Native Thinking Budget Audit

## Finding

Antigravity thinking depth is selected by the account-visible model route. The live model catalog exposes `supportsThinking`, `thinkingBudget`, and `minThinkingBudget`, while the verified `CascadePlannerConfig` schema does not expose a generic reasoning-level override.

Anti-Codex must therefore preserve exact model identity and report the model's native budget. It must not silently swap a Low model for a High sibling when the Codex reasoning selector changes, and it must not claim that an unverified planner field controls thinking.

## Implemented Contract

- The generated Codex model catalog retains the native thinking fields.
- Each account-visible model exposes one supported reasoning level matching its model identity.
- `/models` returns the native budget as additional local metadata without changing the OpenAI-compatible identity fields.
- The in-app Manager displays the exact model name, ID, native budget, and minimum budget.
- The existing reasoning prompt hint remains compatibility guidance; the native budget proof comes from the selected Antigravity model route.

## Installed Evidence

| Model | Native budget | Minimum |
| --- | ---: | ---: |
| Gemini 3.5 Flash Low | 4000 | 32 |
| Gemini 3.5 Flash High | 10000 | 32 |
| Gemini 3.5 Flash Extra Low | 1000 | 32 |
| Gemini 3.1 Pro Low | 1001 | 128 |
| Gemini 3.1 Pro High | 10001 | 128 |
| Claude Sonnet 4.6 Thinking | 1024 | n/a |
| Claude Opus 4.6 Thinking | 1024 | n/a |
| GPT-OSS 120B Medium | 8192 | n/a |

Manager `native-panel-v54`, model refresh, sync readiness, and UI state passed. A live request preserved `gemini-pro-agent` and routed it to `MODEL_PLACEHOLDER_M16`.
