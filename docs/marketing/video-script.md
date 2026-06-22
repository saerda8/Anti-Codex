# Anti-Codex Video Script

## 60-second short video

### Title

Anti-Codex: Codex-like desktop workflow, Antigravity by default

### Core points

- Separate Anti-Codex app/runtime.
- Original Codex stays untouched.
- Default route uses the local Antigravity Desktop provider.
- Optional third-party API profiles can be configured explicitly.
- MCP servers, skills, plugin metadata, and connector metadata are mirrored into
  Anti-Codex local state.
- Connector metadata sync does not fake authorization or make app tools
  callable without real authorization.
- No ChatGPT login path is used.

### Shot list

| Time | Visual | Voiceover |
|---|---|---|
| 0-5s | Anti-Codex and original Codex visible as separate entries | Anti-Codex is a separate desktop route for people who want the Codex workflow without touching their original Codex setup. |
| 5-12s | Anti-Codex starts and shows the Manager | It runs through a local translator gateway and uses Antigravity Desktop as the default provider. |
| 12-22s | Manager provider panel | If you need a third-party API, you configure it explicitly here. No ChatGPT login, no silent provider swap. |
| 22-34s | Provider switch continuity report | Provider switching keeps multi-turn history and structured tool results intact, including OpenAI-compatible and Anthropic-style requests. |
| 34-45s | MCP, skills, plugins, and connector summaries | Local MCP servers, skills, plugin metadata, and connector metadata are mirrored so the local capability surface stays in sync. |
| 45-54s | Connector/app-tool status shows unauthorized tools unavailable | Mirroring metadata is not authorization. Anti-Codex does not pretend a connector is callable before it is really authorized. |
| 54-60s | A short coding task completes in Anti-Codex | The goal is simple: keep the desktop workflow familiar, route through the chosen provider, and keep the boundaries honest. |

### Full voiceover

Anti-Codex is a separate desktop route for people who want the Codex workflow
without changing their original Codex install.

It starts its own local gateway and uses Antigravity Desktop as the default
provider. The original Codex account and app state stay untouched.

If you want to use a third-party API, you configure that explicitly in the
Manager. Anti-Codex does not use a ChatGPT login path and does not silently
switch providers behind your back.

The hard part is not just changing a base URL. The gateway has to preserve
multi-turn history, tool calls, tool results, compacted context, model routing,
and provider-specific request shapes.

That includes switching between OpenAI-compatible and Anthropic-style providers
without losing the useful conversation history.

Anti-Codex also mirrors local MCP servers, skills, plugin metadata, and
connector metadata so the local capability surface matches this Codex session.

But metadata is not authorization. If a connector is not really authorized,
Anti-Codex keeps its app tools unavailable instead of pretending they work.

So the pitch is not "everything is magically unlocked." The pitch is a familiar
desktop coding workflow, an explicit provider route, and honest local
capability boundaries.

## 15-second version

Anti-Codex is a separate desktop route that keeps the original Codex untouched.

It uses Antigravity Desktop by default, and third-party APIs only when you
explicitly configure them.

It mirrors MCP, skills, plugin metadata, and connector metadata, but it does not
fake connector authorization.

Same familiar workflow, cleaner provider control, honest boundaries.

## Screen captions

- Separate Anti-Codex runtime
- Original Codex stays untouched
- Antigravity Desktop by default
- Explicit third-party API profiles
- No ChatGPT login route
- MCP and skills mirrored locally
- Connector metadata is not authorization
- Multi-turn history survives provider switches
- Tool calls and tool results stay structured
- Honest local capability boundaries
