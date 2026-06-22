# Anti-Codex Native Sync Design

## Goal

Keep Anti-Codex aligned with the currently installed Codex Desktop while changing
only the model execution boundary to Antigravity. New Codex features should flow
into Anti-Codex automatically when they do not require OpenAI-hosted account
services.

## Architecture Boundary

Anti-Codex continues to copy the installed Codex Desktop host. It does not
reimplement the desktop UI, Git integration, terminal, approvals, sandbox,
threads, skills, MCP, worktrees, or automations.

The maintained Anti-Codex surface is limited to:

1. Independent application identity and state.
2. The Antigravity model-provider adapter.
3. Compatibility patches required to run without ChatGPT authentication.
4. A guarded Codex host update and rollback mechanism.

The current Responses-compatible translator remains available while the
Antigravity provider becomes more faithful. It is a compatibility boundary, not
a replacement for Codex runtime behavior.

## Update Strategy

Updating Anti-Codex must never overwrite the working host directly.

```text
Installed Codex update
  -> copy into an isolated candidate directory
  -> apply Anti-Codex patches to the candidate
  -> validate required files and the bundled Codex CLI
  -> move the current host to a rollback directory
  -> activate the candidate
  -> retain the rollback host until the next successful update
```

If candidate creation or validation fails, the active Anti-Codex host remains
unchanged. If activation fails, the previous host is restored.

## Capability Tiers

### Core parity

These capabilities must behave like Codex before Anti-Codex is considered
complete:

- Structured tool calls and Codex-owned tool execution.
- MCP and skills.
- Real streaming and cancellation.
- Long context, compaction, session resume, and tool-result continuity.
- Exact dynamic Antigravity models, reasoning choices, and image input.
- Recovery after Antigravity restart, proxy interruption, and account switch.
- Safe Codex host updates with compatibility validation and rollback.
- Independent processes, state, and conversations from official Codex.

### Important parity

These should be inherited from Codex after the core provider boundary is stable:

- Worktrees and parallel threads.
- Automations and long-running task recovery.
- Browser and Chrome-based validation.
- Goals, memories, and diagnostics.
- Local plugin allowlist.

### Explicitly non-parity

These are not required because they depend on OpenAI-hosted account services:

- ChatGPT login and subscription surfaces.
- OpenAI-hosted connectors and remote plugin marketplace.
- OpenAI-hosted search, image generation, and code interpreter.
- OpenAI account usage and billing pages.

Local MCP, skills, browser automation, or other providers may replace these
capabilities, but Anti-Codex must not pretend the OpenAI-hosted service exists.

## Validation

A Codex host update is accepted only when:

1. The candidate contains the desktop executable, app ASAR, bundled Codex CLI,
   and Anti-Codex patch marker.
2. The bundled Codex CLI starts and reports a version.
3. The critical Anti-Codex branding/auth/model patches complete successfully.
4. Candidate failure leaves the active host untouched.
5. Activation failure restores the previous host.

