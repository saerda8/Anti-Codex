# Anti-Codex Third-Party API Gap Audit

Date: 2026-06-22

Scope: OpenAI-compatible and Anthropic provider configuration, model identity, key storage, connection tests, history continuity, and failure handling.

## Current Status

- Third-party mode is implemented and isolated from Antigravity. When a third-party profile is active, failures do not silently fall back to Antigravity traffic.
- OpenAI-compatible and Anthropic profiles are supported. API keys are saved through the Windows DPAPI helper and public status only exposes masked key hints.
- The embedded Manager can test a profile, save it only after a server-side retest, restore Antigravity mode, and keep the same response history/state root.
- A new local end-to-end verifier exists: `scripts/test-anticodex-third-party-provider.mjs`.

## Fix Added In This Pass

- The third-party model list no longer mixes generic fallback models into the UI when the user configured a concrete model.
- For a full OpenAI-compatible URL such as `/v1/chat/completions`, the model menu now shows the configured model plus provider-returned models only.
- 401/403 upstream failures are classified as `auth_error`, even if the provider message says only that the bearer token was rejected.
- Error payloads are verified not to leak configured or saved API keys.

## Verified Locally

- Temporary fake OpenAI-compatible provider returned only `fake-gpt-4.1`.
- `/v1/models` exposed only `fake-gpt-4.1`.
- `/v1/responses` routed through `upstream-provider` and preserved `resolvedModel=fake-gpt-4.1`.
- Manager `/anticodex/upstream-test` rejected unauthenticated requests with 403 before contacting the provider.
- Authenticated Manager test/save flow succeeded.
- Saving the third-party profile did not change `response-history.json`.
- Saved profile did not contain the raw API key.
- Provider auth failure returned 401 with `auth_error` and redacted keys.

## Remaining Gaps

- An optional real third-party smoke verifier now exists, but no user-provided real endpoint/key has been exercised yet.
- Anthropic has no generic public model-list endpoint in this implementation, so model selection still depends on the configured model.
- Long multi-turn history across provider switching is now covered by the local fake-provider verifier across provider save, restart, OpenAI-compatible switch, Anthropic switch, and reverse switch.
- Provider capability probing is intentionally conservative. It does not claim hosted web/image tools unless proven or configured.
- Manager connection testing now returns a human-readable summary for auth, quota/billing, model-not-found, rate-limit, network, timeout, URL, TLS, and protocol mismatch failures.

## Next Recommended Work

1. Run the new explicit opt-in provider-to-Antigravity turn-10 verifier when real traffic is approved.
2. Add optional real-provider smoke tests that use explicitly supplied throwaway keys and never run by default.
3. If operators approve real provider testing, exercise the same Manager summary path against a throwaway real key without making it part of routine checks.
