# Anti-Codex Tool Guard Chain Audit

Date: 2026-06-22

Scope: `translator/adaptive-server.mjs` fake-execution guard and user-visible fallback behavior.

## Findings

1. The current source guard text is branded as `Anti-Codex`, not `DeepCodex`.
   `blockedToolClaimMessage()` and `webToolUnavailableClaimMessage()` pass through `brandTranslatorText()`, which also replaces legacy `DeepCodex` text if an old string enters this path.

2. The user-visible "DeepCodex intercepted" report is most likely caused by an old installed runtime, stale conversation context, or an older guard string in a previous build.
   The current installed runtime has already been synced and source tests reject `DeepCodex` leakage in guard output.

3. The normal chat/tool path can still surface a guard message as the final assistant response when the model claims it acted but emits no structured tool call.
   This protects against fake execution, but the previous wording looked like an internal error and told the user to "continue".

4. The internal web-tool path has replay behavior: it can feed a correction prompt back to the model before giving up.
   The generic Responses formatting path and streaming mapper mostly sanitize the final text instead of re-driving the model.

## Fix Applied

The generic fake-execution fallback now says, in plain Chinese, that the model did not actually read files, run commands, start services, generate files, move files, or search the web.

The fallback keeps the technical phrase `tool call` only as evidence wording, and no longer uses the old "please continue when..." style instruction.

## Remaining Risk

For non-web tools, Anti-Codex still cannot safely invent a tool call from prose.
If Antigravity returns only natural-language claims, the safest behavior is still to block completion and ask for a real tool call or a clear missing-tool explanation.

The next stronger improvement is a bounded retry layer for the non-web/native path, mirroring the existing internal web-tool retry loop.

## Verification

Run:

```powershell
node --check translator\adaptive-server.mjs
node --test translator\tests\adaptive-pseudo-tools.test.mjs
```

Expected:

- Guard output contains `Anti-Codex`.
- Guard output does not contain `DeepCodex`.
- Guard output does not contain the old `请继续时` wording.
- Guard output clearly says no real tool action happened in this turn.
