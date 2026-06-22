# Chat to Responses Compatibility Notes

Scope: Anti-Codex translates Codex Desktop's Responses-shaped traffic into the
active upstream provider protocol, then maps the provider response back into the
Responses shape Codex expects.

The translator is a compatibility layer. It preserves Codex runtime semantics,
normalizes provider differences, and exposes diagnostics, but it must not become
a separate local control plane or pretend unsupported hosted features succeeded.

## Supported Provider Shapes

- Antigravity Desktop is the default upstream.
- OpenAI-compatible third-party providers use Chat Completions-compatible
  request and response shapes.
- Anthropic-compatible third-party providers use Messages-compatible request and
  response shapes.
- Legacy compatibility names and internal prefixes may remain in code when they
  are part of persisted state or test fixtures. User-facing text should still
  say Anti-Codex.

## Compatibility Rules

### Response Shell

Provider completions should be wrapped into a full Responses-shaped object, not
just `{ output }`.

Preserve or echo when present:

- `instructions`
- `model`
- `parallel_tool_calls`
- `previous_response_id`
- `reasoning`
- `store`
- `temperature`
- `text`
- `tool_choice`
- `tools`
- `top_p`
- `truncation`
- `usage`
- `metadata`

Anti-Codex may omit fields only when Codex has been tested to accept the reduced
shape.

### Message Output

Provider assistant text maps to:

```json
{
  "type": "message",
  "role": "assistant",
  "status": "completed",
  "content": [
    { "type": "output_text", "text": "..." }
  ]
}
```

For streaming, emit the normal Responses event progression:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`

### Tool Calls

OpenAI-compatible `tool_calls[]` map to Responses `function_call` items.

- Allocate stable response item ids separately from provider call ids.
- Preserve `call_id` from the provider tool-call id when present.
- Stream arguments through `response.function_call_arguments.delta`.
- Finish with `response.function_call_arguments.done` and
  `response.output_item.done`.
- Do not execute unknown calls inside the protocol bridge.

Anthropic-compatible `tool_use` blocks map to the same Responses tool-call
surface. On later provider switches, matching tool results must be rehydrated in
the target protocol:

- OpenAI-compatible history needs `assistant.tool_calls` plus paired
  `role:"tool"` messages.
- Anthropic-compatible history needs `tool_use` plus paired `tool_result`
  blocks.

Anti-Codex-specific routing still applies after protocol mapping:

- Internal `web_search` / `web_fetch` may be intercepted only when registered
  and allowed.
- Unknown, MCP, plugin, custom, and connector/app-tool calls must be preserved
  for Codex unless explicitly recognized as internal.
- Connector/app-tool metadata parity must not be treated as authorization.

### Reasoning

Provider-native reasoning text may be returned as a Responses `reasoning` item
when the active route supplies it in a supported field.

Anti-Codex must not decode or reinterpret OpenAI private reasoning blobs. If
reasoning replay is needed, the translator owns an opaque replay blob or local
cache keyed by session/call id.

The current persisted replay prefix is intentionally legacy-compatible:

```text
deepcodex.reasoning.hex.v1:<hex>
```

- Treat that prefix as an internal compatibility token, not user-facing
  branding.
- Never treat OpenAI encrypted reasoning as prompt text.
- Never try to decode OpenAI private blobs.
- Keep provider-native reasoning separate from assistant text deltas.

Provider-specific handling is allowed when it repairs or preserves what the
active provider actually returns. Runtime implementation is not allowed inside
the protocol bridge.

Provider-specific handling examples:

- Reconstruct streamed tool calls by stable index or id, not arrival order
  alone.
- Preserve provider-native reasoning fields across tool-call round trips only
  when the provider requires them for continuity.
- Map provider cache counters into Responses `usage` diagnostics when known.
- Classify transient upstream failures separately from protocol translation
  failures.

Runtime implementation examples that stay out of scope:

- Files, Vector Stores, and hosted `file_search`.
- Computer-use execution.
- MCP execution inside the translator.
- Conversation CRUD or response-store emulation.
- Fake success for unsupported hosted OpenAI features.

### Finish Status

Map provider finish reasons into Responses status:

- `stop` or absent successful completion -> `completed`
- length/token limit -> `incomplete` with `incomplete_details`
- tool calls -> completed response containing function-call output items

This needs tests because Codex uses response status to decide whether to
continue the turn.

### Streaming

Prefer real upstream streaming when no internal tool loop is active.

- Track text, reasoning, and tool calls independently.
- Allocate output indices in the order items first appear.
- Handle tool-call deltas before arguments are complete.
- Emit final `response.completed` with the same output items that were streamed.
- Merge partial tool-call chunks only when name and arguments are complete enough
  for Codex to continue safely.

Synthetic SSE is acceptable only as a bounded fallback.

## Out of Scope

- Browser automation protocol translation.
- Provider-native multimodal formats other than supported chat-compatible image
  inputs.
- Granting connector/app-tool access from cached metadata.
- Mutating the original Codex installation or account state.
- Using ChatGPT login as a setup route.

## Current Gaps

- Streaming still needs focused coverage around provider-native reasoning and
  partial tool-call reconstruction.
- `context_compaction` as a later input item needs explicit handling in
  Responses -> provider conversion; this is adjacent to, but not part of,
  provider -> Responses mapping.
- Unknown tool calls should stay unresolved and pass back to Codex, not be
  executed by the bridge.
- Cross-provider history tests must keep checking structured tool history, not
  just text markers.
