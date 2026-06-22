# Anti-Codex Real Chat/Tool Chain Follow-Up Audit

Date: 2026-06-22
Scope: verifiable gaps in the SSE response pipe, streaming mapper, tool-call guard, and client disconnect behaviour.
Audited source: `translator/adaptive-server.mjs` (pipeSSE, pipeStreamingChatAsResponses, ChatToResponsesStreamMapper, fake-tool-claim replay loop).
Baseline: existing test scripts (codex-responses, native-tool-loop, real-mini-tool, real-work, stability-soak) are referenced but not re-read.

## 1. Streaming upstream fetch lacks AbortSignal

`pipeStreamingChatAsResponses` (line 2409) calls `fetch()` with no `AbortSignal`.
When the HTTP client disconnects (tab close, navigation) the upstream Antigravity model continues generating tokens to completion.
This wastes quota and can leave a half-finished response cached upstream.
Verifiable: start a streaming request, drop the TCP connection, confirm the upstream fetch body reader stops.
Coverage: no existing test asserts upstream abort on disconnect.

## 2. Fake-tool-claim replay exhaustion message is untested

The internal web-tool path limits relay retries to `MAX_FAKE_TOOL_CLAIM_REPLAYS` (default 2, env `TRANSLATOR_MAX_FAKE_TOOL_CLAIM_REPLAYS`, line 41).
After exhaustion the server returns `blockedToolClaimMessageFor()` as the final answer (line 2000).
No existing test script drives a model into consecutive fake-claim replies and asserts the final user-visible message.
Existing single-turn interception tests do not cover the N-consecutive-replay exhausted path.
Verifiable: send a prompt that consistently produces fake tool claims; count SSE events; assert final text is the blocked-tool-claim message.
Coverage: covered for single-turn interception; exhaustion path is open.

## 3. Custom tool call type flip in streaming SSE

`ChatToResponsesStreamMapper.pushToolCallDelta()` emits `output_item.added` with `type: "custom_tool_call"` on first delta.
If `customArgumentsAreInvalid()` returns true at `complete()` time, the same output index gets `output_item.done` with `type: "message"` (an error string via `invalidCustomToolMessage()`).
The client receives contradictory type signals for the same output index.
Verifiable: send a request that triggers a custom-tool call with empty or malformed JSON args; capture SSE events; assert output_item.done type is "message".
Coverage: no test asserts the final item type for invalid custom tool arguments.

## 4. end_turn field is never set to true in any SSE path

`pipeStreamingChatAsResponses` conditionally injects `end_turn: false` via `shouldInjectEndTurn` (line 2073).
`pipeSSE` includes no `end_turn` field at all.
Neither path ever emits `end_turn: true`.
The Codex client may need an explicit affirmative signal to close the turn after all tool outputs are submitted.
Verifiable: capture the `response.completed` SSE payload; assert `end_turn` field is absent or correctly `true` for a final answer turn.
Coverage: no existing test asserts the `end_turn` field value on `response.completed`.

## 5. Guard text split between delta events and completed text

In `ChatToResponsesStreamMapper.pushTextDelta()`, raw text is emitted as `response.output_text.delta` events immediately as chunks arrive.
The guard (`shouldBlockAssistantToolClaim`) only runs at `complete()` time (or `completedItems()`).
If the guard triggers, the client sees the raw fake-claim text first (via deltas) and later receives different guarded text in `response.output_text.done`.
This causes visible text replacement in the UI, which may confuse users.
Verifiable: stream a model response that triggers the fake-claim guard; capture both delta and done events; assert the delta text differs from the done text.
Coverage: codex-responses test checks final SSE output but does not capture intermediate delta events.
