# Responses WebSocket Gap

Date: 2026-06-14

## Current State

Anti-Codex still does not implement the native Responses WebSocket protocol. The installed client is configured to use HTTP/SSE fallback, and that path is currently stable.

This change tightens the fallback:

- HTTP `GET /responses` and `GET /v1/responses` return explicit `501` JSON with `unsupported_websocket`.
- Real WebSocket `Upgrade` requests for `/responses` and `/v1/responses` now also receive an explicit `HTTP/1.1 501 Not Implemented` response and a closed socket.
- Unknown WebSocket upgrade paths return `404` instead of being left to Node's default socket handling.
- Installed verification now probes a real TCP WebSocket upgrade and includes the result in the default overall check.

## Why Not Implement a Fake WebSocket

The actual Codex Responses WebSocket protocol is not captured in this repository yet. Implementing a guessed protocol would be riskier than rejecting the upgrade because the client may expect specific frame formats, event ordering, cancellation messages, heartbeat behavior, and reconnect semantics.

A fake `101 Switching Protocols` could make Codex Desktop believe the transport is supported, then fail later in harder-to-debug ways. A clear `501` keeps the fallback honest.

## What Would Prove Native Support

Before replacing the fallback with native WebSocket support, capture or document:

- handshake headers and optional subprotocols
- first client message after upgrade
- normal response event sequence
- tool-call and tool-result event sequence
- cancellation message shape
- error event shape
- ping/pong or heartbeat rules

Until those are known, HTTP/SSE remains the supported transport.

## Verification

Current installed proof:

- `/health` reports `antigravity-desktop`, account ready, eight models.
- `test-anticodex-websocket-fallback.ps1` receives `HTTP/1.1 501 Not Implemented` with `unsupported_websocket`.
- `test-anticodex-websocket-protocol-audit.ps1` scans the installed Codex `app.asar` and currently reports no native model Responses WebSocket evidence. The present WebSocket markers are app-server transport and dictation/audio related, not the chat model Responses channel.
- `test-anticodex-installed-overall.ps1` includes the WebSocket fallback check.
- UI state check still shows no reconnect text.
