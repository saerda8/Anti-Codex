# Agentic Step-Flow Tool Call Gap Analysis

## Current Status
Resolved in the main worktree on 2026-07-01.

Fresh visible desktop evidence passed with `gemini-3.5-flash-low`, real Antigravity/model traffic, a Chinese prompt, visible `阶段1` / `阶段2` text, marker-scoped tool calls and outputs, exact `done.txt`, Chinese title in `index.html`, and `artifactGuardUsed:false`.

Evidence report: `%APPDATA%\anticodex\reports\latest-ui-agentic-step-flow-smoke.json`, marker `UI_AGENTIC_STEP_FLOW_SMOKE_1782887696258`.

## Former Symptom
The visible agentic-step-flow showed the model text route succeeding while producing no actual tool call or artifact. This meant the flow could appear to progress without real tool execution output, masking the lack of genuine agentic loop closure.

## Likely Code Areas
- `deterministicArtifactToolCallCompletion`
- `fakeToolClaimRelayPrompt`
- `parsePseudoToolCalls` / internal tools
- Translators and adaptive-server paths that synthesize or short-circuit tool results

## Fix Direction
The failure was not that Gemini could not be called. Direct non-streaming Gemini completion could emit a usable shell tool call, while CLI streaming could degrade local-artifact work into prose or fake-tool claims.

The translator now detects local-artifact shell-tool tasks and uses a non-streaming Antigravity model completion for that tool turn, then relays the result back to the Codex client as streaming Responses events.

## Guardrail
Do not count deterministic artifact guards as model-led evidence for this smoke. This smoke must keep requiring real tool-call/output evidence and `artifactGuardUsed:false`.
