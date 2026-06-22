# Anti-Codex Status: Third-Party Provider and Local Connectors

Date: 2026-06-22

## Completed

- Third-party provider model lists no longer inject generic fallback models when a concrete provider model is configured.
- `/v1/models` now shows the configured model plus provider-returned models only.
- Third-party upstream 401/403 failures are classified as `auth_error`, including providers that say only that the bearer token was rejected.
- Error payloads are verified to redact configured and saved API keys.
- Added `scripts/test-anticodex-third-party-provider.mjs`, a local fake OpenAI-compatible provider verifier.
- The verifier covers full endpoint URLs, model identity, Manager auth, server-side save, history preservation, route audit evidence, and credential redaction.
- Installed runtime was synced and the installed third-party provider verifier passed with `fake-gpt-4.1` as the only exposed model.
- Local connector/app-tool projection now supports an explicit Anti-Codex-only allowlist via `[local_authorized_connectors]` in the isolated config or `ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS`.
- Unlisted connectors remain metadata-only and expose no tools.

## Verification

- `node --check translator/adaptive-server.mjs`
- `node --check translator/local-projection/index.mjs`
- `node --test translator/tests/upstream-integration.test.mjs`
- `node --test translator/tests/adaptive-pseudo-tools.test.mjs`
- `node --test translator/tests/anticodex-launcher.test.mjs`
- `node --test translator/tests/local-access.test.mjs translator/tests/mcp-stdio-client.test.mjs`
- Installed `test-anticodex-third-party-provider.mjs`

## Worker Lesson

- DeepSeek job `dsw_mqoixlah_2poy3t` produced advisory output but failed policy attribution in a shared dirty worktree.
- The lesson is recorded in `MCP_WORKER_RULES.md`: docs-only workers should use an isolated worktree or wait until source edits are complete.
