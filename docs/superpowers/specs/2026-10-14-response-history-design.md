# Persistent Responses continuation

Approved by the user on 2026-10-14: add history storage and complete the `previous_response_id` interface.

## Boundary

Implement as a separately licensed CodexPlusPlus Layer 2 compatibility patch. The native Codex harness still owns planning, tools, retries, compaction, cancellation and completion. Layer 3 remains a Chat-to-Cascade adapter. No new controller or dependency is needed.

## Contract

- Enable local history only with an explicit isolated `CODEX_PLUS_STATE_DIR`. Use its `responses-history-v1` directory.
- Store self-contained effective input and complete output items for successful Responses, preserving tool calls, tool results, multimodal content and opaque output items. Do not inherit top-level instructions, tools or model selection.
- Namespace records by a SHA-256 digest of the request authorization scope and response ID. Never save raw credentials or request headers. A credential can continue across models; another credential cannot read its record.
- Default `store` to true. `store:false` may read a parent but does not save the current response.
- Resolve a known parent and prepend its input and output to the current delta. If the current input already begins with the same complete history after narrow transport normalization, retain it without duplication. Do not infer completeness from item counts.
- For Chat-backed requests, a missing, expired or corrupt parent fails before forwarding: HTTP 410, `error.type=response_history_missing`, `details.status=410`, `retryable=false`, and the exact previous ID. The message instructs the caller to start a fresh request or reopen the original conversation context.
- For native Responses providers, a local hit hydrates input and removes the ID from the upstream payload, retaining it in client response metadata. A local miss keeps the provider's original ID handling and does not save the resulting child locally: the unknown remote ancestry cannot be represented by a complete local snapshot. Later requests keep using native provider continuation. `/responses/compact` is unchanged.
- Bound storage to 256 records, 64 MiB total, 16 MiB per record, and 30 days. Use a cross-process file lock and atomic writes. Validate stored envelopes and reject symlinks, nonregular entries and conflicting ID reuse. Same-content saves are idempotent.
- Save nonstreaming completion before reporting success. Stream intermediate data normally, but withhold terminal completion until the complete successful response is saved. Failed, incomplete and cancelled upstream responses must not become resumable. Once a completed result is committed, a subsequent client write failure must not delete a snapshot another request may already have read. Storage errors produce explicit failures.

## Acceptance

Rust regressions cover persistence across reopen, branching, credentials, bounds, expiry, collisions, concurrent access, instructions and tool order. Black-box tests cover native and Chat providers, streaming and nonstreaming, ID-only and full-history input, missing parent and `store:false`.

After a reproducible patch replay and managed build, use the guarded installation transaction. Verify one real same-model and cross-model ID continuation, plus persistence across an owned helper restart. Keep official Codex untouched. Prior desktop-upload evidence and current UI automation restrictions remain separate from this protocol test.

References: [conversation state](https://developers.openai.com/api/docs/guides/conversation-state), [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses).
