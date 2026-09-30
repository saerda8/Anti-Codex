#!/usr/bin/env python3
"""Codex-owned stdio MCP server for local web search and fetch."""

import json
import sys
from typing import Any

from web_fetch import run as fetch
from web_search_urllib import run as search


SERVER_INFO = {"name": "anticodex-web", "version": "1.0.0"}
TOOLS = [
    {
        "name": "web_search",
        "description": "Search the public web with the local urllib DuckDuckGo fallback.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query."},
                "count": {"type": "integer", "minimum": 1, "maximum": 10},
                "fetch_top": {"type": "integer", "minimum": 0, "maximum": 10},
                "excerpt_chars": {"type": "integer", "minimum": 1, "maximum": 20000},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "web_fetch",
        "description": "Fetch a known HTTP(S) URL and return readable text.",
        "inputSchema": {
            "type": "object",
            "properties": {"url": {"type": "string", "format": "uri"}},
            "required": ["url"],
            "additionalProperties": False,
        },
    },
]
TOOL_NAMES = {tool["name"] for tool in TOOLS}


def _write(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _error(request_id: Any, code: int, message: str) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def _tool_result(value: Any, *, is_error: bool = False) -> dict[str, Any]:
    text = json.dumps(value, ensure_ascii=False, indent=2)
    result = {"content": [{"type": "text", "text": text}], "structuredContent": value}
    if is_error:
        result["isError"] = True
    return result


def _call_tool(name: str, arguments: Any) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        return _tool_result({"ok": False, "error": "arguments must be an object"}, is_error=True)
    if name == "web_search":
        query = arguments.get("query")
        if not isinstance(query, str) or len(query.strip()) < 2:
            return _tool_result({"ok": False, "error": "query too short"}, is_error=True)
        try:
            count = max(1, min(int(arguments.get("count", 5)), 10))
            fetch_top = max(0, min(int(arguments.get("fetch_top", 0)), count))
            excerpt_chars = max(1, min(int(arguments.get("excerpt_chars", 2500)), 20000))
        except (TypeError, ValueError):
            return _tool_result({"ok": False, "error": "count, fetch_top, and excerpt_chars must be integers"}, is_error=True)
        result = search(query, count, fetch_top, excerpt_chars)
        return _tool_result(result, is_error=result.get("ok") is not True)
    if name == "web_fetch":
        url = arguments.get("url")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            return _tool_result({"ok": False, "error": "invalid URL"}, is_error=True)
        result = fetch(url)
        return _tool_result(result, is_error=result.get("ok") is not True)
    return _tool_result({"ok": False, "error": f"unknown tool: {name}"}, is_error=True)


def handle(message: dict[str, Any]) -> None:
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize":
        params = message.get("params") or {}
        _write({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": str(params.get("protocolVersion", "2024-11-05")),
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        })
        return
    if method == "notifications/initialized":
        return
    if method == "ping":
        if request_id is not None:
            _write({"jsonrpc": "2.0", "id": request_id, "result": {}})
        return
    if method == "tools/list":
        if request_id is not None:
            _write({"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}})
        return
    if method == "tools/call":
        if request_id is not None:
            params = message.get("params") or {}
            name = str(params.get("name") or "")
            if name not in TOOL_NAMES:
                _error(request_id, -32602, f"unknown tool: {name}")
            else:
                try:
                    _write({"jsonrpc": "2.0", "id": request_id, "result": _call_tool(name, params.get("arguments", {}))})
                except Exception as exc:
                    _write({"jsonrpc": "2.0", "id": request_id, "result": _tool_result({"ok": False, "error": str(exc)[:300]}, is_error=True)})
        return
    if request_id is not None:
        _error(request_id, -32601, f"method not found: {method}")


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("JSON-RPC message must be an object")
            handle(message)
        except Exception as exc:
            _error(None, -32700, str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
