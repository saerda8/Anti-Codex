from __future__ import annotations

import argparse
import asyncio
import ctypes
import hashlib
import hmac
import importlib.metadata
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sys
import tempfile
import tomllib
from typing import Any, Mapping


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 47631
MUTEX_NAME = r"Local\AntiCodexSharedMcpProxyV1"
PROXY_VERSION = "0.12.0"
MCP_SDK_VERSION = "1.27.1"
RUNTIME_SCHEMA = "anticodex-shared-mcp-runtime-v1"
MANIFEST_SCHEMA = "anticodex-shared-mcp-manifest-v1"
WORKER_TOOL_SUFFIX = "_start_implementation"
TRANSPORT_KEYS = {
    "command",
    "args",
    "env",
    "url",
    "bearer_token_env_var",
    "http_headers",
    "env_http_headers",
}
TABLE_HEADER = re.compile(r"^\s*\[([^\[\]]+)]\s*(?:#.*)?(?:\r?\n)?$")
ASSIGNMENT = re.compile(r"^\s*([A-Za-z0-9_-]+)\s*=")
MCP_TABLE = re.compile(
    r'^mcp_servers\.(?:"([^"]+)"|\'([^\']+)\'|([^\.]+))(?:\.(.+))?$'
)


class BearerAuthMiddleware:
    def __init__(self, app: Any, *, token: str) -> None:
        _validate_token(token)
        self.app = app
        self.expected = f"Bearer {token}".encode("ascii")

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        supplied = [
            value
            for key, value in scope.get("headers", [])
            if key.lower() == b"authorization"
        ]
        if len(supplied) != 1 or not hmac.compare_digest(supplied[0], self.expected):
            body = b"Unauthorized"
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"text/plain; charset=utf-8"),
                        (b"content-length", str(len(body)).encode("ascii")),
                        (b"cache-control", b"no-store"),
                        (b"www-authenticate", b"Bearer"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)


def _validate_token(token: object) -> str:
    if (
        not isinstance(token, str)
        or len(token) < 32
        or re.fullmatch(r"[A-Za-z0-9_-]+", token) is None
    ):
        raise ValueError("token must be at least 32 URL-safe characters")
    return token


def _parse_toml(text: str) -> dict[str, Any]:
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise ValueError(f"invalid TOML: {exc}") from exc
    servers = parsed.get("mcp_servers", {})
    if not isinstance(servers, dict):
        raise ValueError("mcp_servers must be a table")
    return parsed


def _enabled_tool_names(server: Mapping[str, Any]) -> set[str]:
    tools = server.get("tools")
    if not isinstance(tools, dict):
        return set()
    return {
        name
        for name, settings in tools.items()
        if isinstance(name, str)
        and isinstance(settings, dict)
        and settings.get("enabled", True) is not False
    }


def _has_worker_contract(server: Mapping[str, Any]) -> bool:
    names = _enabled_tool_names(server)
    return any(name.endswith(WORKER_TOOL_SUFFIX) for name in names)


def _is_local_worker(name: str, server: object) -> bool:
    if name == "node_repl" or not isinstance(server, dict):
        return False
    if server.get("enabled", True) is False or "url" in server:
        return False
    command = server.get("command")
    args = server.get("args", [])
    env = server.get("env", {})
    return (
        isinstance(command, str)
        and bool(command.strip())
        and isinstance(args, list)
        and all(isinstance(arg, str) for arg in args)
        and isinstance(env, dict)
        and all(isinstance(key, str) and isinstance(value, str) for key, value in env.items())
        and _has_worker_contract(server)
    )


def _load_runtime(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(value, Mapping) or value.get("schema") != RUNTIME_SCHEMA:
        return None
    if value.get("host") != DEFAULT_HOST:
        return None
    port = value.get("port")
    servers = value.get("mcpServers")
    server_ports = value.get("server_ports")
    try:
        _validate_token(value.get("token"))
    except ValueError:
        return None
    if (
        not isinstance(port, int)
        or not 1024 <= port <= 65535
        or not isinstance(servers, dict)
        or not isinstance(server_ports, dict)
        or set(server_ports) != set(servers)
        or any(not isinstance(value, int) or not 1024 <= value <= 65535 for value in server_ports.values())
        or len(set(server_ports.values())) != len(server_ports)
    ):
        return None
    for server in servers.values():
        if not isinstance(server, dict):
            return None
        if not isinstance(server.get("command"), str):
            return None
        if not isinstance(server.get("args"), list) or not isinstance(server.get("env"), dict):
            return None
    return dict(value)


def _is_generated_server(
    name: str,
    server: object,
    runtime: Mapping[str, Any] | None,
) -> bool:
    if not isinstance(server, dict) or not runtime or name not in runtime["mcpServers"]:
        return False
    if server.get("enabled", True) is False:
        return False
    expected_url = f"http://{runtime['host']}:{runtime['server_ports'][name]}/servers/{name}/mcp"
    expected_auth = {"Authorization": "Bearer " + runtime["token"]}
    return server.get("url") == expected_url and server.get("http_headers") == expected_auth


def discover_worker_names(
    text: str,
    previous_runtime: Mapping[str, Any] | None = None,
) -> tuple[str, ...]:
    parsed = _parse_toml(text)
    runtime = _load_runtime(previous_runtime)
    servers = parsed.get("mcp_servers", {})
    return tuple(
        sorted(
            name
            for name, server in servers.items()
            if _is_local_worker(name, server) or _is_generated_server(name, server, runtime)
        )
    )


def _validate_paths(name: str, server: Mapping[str, Any]) -> None:
    command = str(server["command"])
    command_path = Path(command)
    if command_path.is_absolute():
        if not command_path.is_file():
            raise ValueError(f"{name}: command path does not exist")
    elif shutil.which(command) is None:
        raise ValueError(f"{name}: command is not available")
    for arg in server.get("args", []):
        path = Path(arg)
        if path.is_absolute() and path.suffix.lower() in {".js", ".mjs", ".cjs", ".py"}:
            if not path.is_file():
                raise ValueError(f"{name}: worker entry path does not exist")
    for key, value in server.get("env", {}).items():
        path = Path(value)
        if key.endswith(("_BIN", "_FILE")) and path.is_absolute() and not path.is_file():
            raise ValueError(f"{name}: {key} path does not exist")


def _split_table_blocks(text: str) -> list[tuple[str | None, list[str]]]:
    lines = text.splitlines(keepends=True)
    starts: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        match = TABLE_HEADER.match(line)
        if match:
            starts.append((index, match.group(1).strip()))
    blocks: list[tuple[str | None, list[str]]] = []
    first = starts[0][0] if starts else len(lines)
    if first:
        blocks.append((None, lines[:first]))
    for position, (start, name) in enumerate(starts):
        end = starts[position + 1][0] if position + 1 < len(starts) else len(lines)
        blocks.append((name, lines[start:end]))
    return blocks


def _mcp_block_identity(table_name: str | None) -> tuple[str, str] | None:
    if not table_name:
        return None
    match = MCP_TABLE.match(table_name)
    if not match:
        return None
    return (str(match.group(1) or match.group(2) or match.group(3)), str(match.group(4) or ""))


def _rewrite_candidate(text: str, server_ports: Mapping[str, int], *, token: str) -> str:
    names = set(server_ports)
    if not names:
        return text
    newline = "\r\n" if "\r\n" in text else "\n"
    output: list[str] = []
    seen: set[str] = set()
    for table_name, lines in _split_table_blocks(text):
        identity = _mcp_block_identity(table_name)
        if identity is None or identity[0] not in names:
            output.extend(lines)
            continue
        name, suffix = identity
        if suffix == "env":
            continue
        if suffix:
            output.extend(lines)
            continue
        seen.add(name)
        kept = [lines[0]]
        for line in lines[1:]:
            match = ASSIGNMENT.match(line)
            if match and match.group(1) in TRANSPORT_KEYS:
                try:
                    tomllib.loads(f"[mcp_servers.test]\n{line.rstrip()}\n")
                except tomllib.TOMLDecodeError as exc:
                    raise ValueError(f"{name}: transport settings must be single-line") from exc
                continue
            kept.append(line)
        output.extend(
            [
                kept[0],
                f'url = "http://{DEFAULT_HOST}:{server_ports[name]}/servers/{name}/mcp"{newline}',
                f'http_headers = {{ Authorization = "Bearer {token}" }}{newline}',
                *kept[1:],
            ]
        )
    missing = names - seen
    if missing:
        raise ValueError("missing textual MCP server tables: " + ", ".join(sorted(missing)))
    return "".join(output)


def _server_source(
    name: str,
    server: Mapping[str, Any],
    previous_runtime: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if _is_local_worker(name, server):
        result = {
            "command": server["command"],
            "args": list(server.get("args", [])),
            "env": dict(server.get("env", {})),
            "enabled": True,
        }
    elif previous_runtime and _is_generated_server(name, server, previous_runtime):
        result = dict(previous_runtime["mcpServers"][name])
    else:
        raise ValueError(f"{name}: missing trusted local Worker source")
    return result


def build_artifacts(
    source_text: str,
    *,
    port: int = DEFAULT_PORT,
    token: str,
    previous_runtime: Mapping[str, Any] | None = None,
    check_paths: bool = True,
) -> tuple[dict[str, Any], str]:
    if not 1024 <= port <= 65535:
        raise ValueError("port must be between 1024 and 65535")
    _validate_token(token)
    parsed = _parse_toml(source_text)
    previous = _load_runtime(previous_runtime)
    names = discover_worker_names(source_text, previous)
    if names and port + len(names) - 1 > 65535:
        raise ValueError("not enough consecutive ports for discovered Workers")
    server_ports = {name: port + index for index, name in enumerate(names)}
    servers = parsed.get("mcp_servers", {})
    sources = {name: _server_source(name, servers[name], previous) for name in names}
    if check_paths:
        for name, server in sources.items():
            _validate_paths(name, server)
    candidate = _rewrite_candidate(source_text, server_ports, token=token)
    after = _parse_toml(candidate)
    if {key: value for key, value in parsed.items() if key != "mcp_servers"} != {
        key: value for key, value in after.items() if key != "mcp_servers"
    }:
        raise ValueError("generated config changed unrelated root settings")
    if set(servers) != set(after.get("mcp_servers", {})):
        raise ValueError("generated config changed the MCP server set")
    for name, old in servers.items():
        new = after["mcp_servers"][name]
        if name not in names:
            if old != new:
                raise ValueError(f"generated config changed unrelated server {name}")
            continue
        if new.get("url") != f"http://{DEFAULT_HOST}:{server_ports[name]}/servers/{name}/mcp":
            raise ValueError(f"{name}: generated URL mismatch")
        if new.get("http_headers") != {"Authorization": "Bearer " + token}:
            raise ValueError(f"{name}: generated authorization mismatch")
        if any(key in new for key in ("command", "args", "env", "bearer_token_env_var", "env_http_headers")):
            raise ValueError(f"{name}: old transport settings remain")
        old_other = {key: value for key, value in old.items() if key not in TRANSPORT_KEYS}
        new_other = {key: value for key, value in new.items() if key not in TRANSPORT_KEYS}
        if old_other != new_other:
            raise ValueError(f"{name}: permissions or non-transport settings changed")
    runtime = {
        "schema": RUNTIME_SCHEMA,
        "host": DEFAULT_HOST,
        "port": port,
        "server_ports": server_ports,
        "token": token,
        "source_sha256": hashlib.sha256(source_text.encode("utf-8")).hexdigest(),
        "generated_sha256": hashlib.sha256(candidate.encode("utf-8")).hexdigest(),
        "mcpServers": sources,
    }
    return runtime, candidate


def _write_private(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
            newline="",
        ) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _read_runtime_file(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return _load_runtime(value)


def prepare_config(
    config_path: Path,
    state_dir: Path,
    *,
    port: int = DEFAULT_PORT,
    token: str | None = None,
    check_paths: bool = True,
) -> dict[str, Any]:
    config_path = config_path.resolve()
    state_dir = state_dir.resolve()
    source_text = config_path.read_text(encoding="utf-8")
    runtime_path = state_dir / "servers.json"
    previous = _read_runtime_file(runtime_path)
    effective_token = token or (previous or {}).get("token") or secrets.token_urlsafe(32)
    runtime, candidate = build_artifacts(
        source_text,
        port=port,
        token=effective_token,
        previous_runtime=previous,
        check_paths=check_paths,
    )
    state_dir.mkdir(parents=True, exist_ok=True)
    source_hash = hashlib.sha256(source_text.encode("utf-8")).hexdigest()
    generated_hash = hashlib.sha256(candidate.encode("utf-8")).hexdigest()
    manifest_path = state_dir / "manifest.json"
    try:
        prior_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prior_manifest = {}
    prior_backup = Path(str(prior_manifest.get("backup_path", "")))
    preserve_backup = (
        prior_manifest.get("schema") == MANIFEST_SCHEMA
        and str(config_path).casefold() == str(prior_manifest.get("config_path", "")).casefold()
        and source_hash == prior_manifest.get("generated_sha256")
        and prior_backup.is_file()
    )
    backup_path = prior_backup if preserve_backup else state_dir / "backups" / f"config-{source_hash[:16]}.toml"
    if candidate != source_text and not backup_path.exists():
        _write_private(backup_path, source_text)
    _write_private(runtime_path, json.dumps(runtime, ensure_ascii=False, indent=2) + "\n")
    worker_runtime_dir = state_dir / "servers"
    worker_runtime_paths: dict[str, str] = {}
    for name, server in runtime["mcpServers"].items():
        worker_runtime_path = worker_runtime_dir / f"{hashlib.sha256(name.encode('utf-8')).hexdigest()[:16]}.json"
        worker_runtime = {
            **runtime,
            "port": runtime["server_ports"][name],
            "server_ports": {name: runtime["server_ports"][name]},
            "mcpServers": {name: server},
        }
        _write_private(worker_runtime_path, json.dumps(worker_runtime, ensure_ascii=False, indent=2) + "\n")
        worker_runtime_paths[name] = str(worker_runtime_path)
    old_paths = set((previous or {}).get("worker_runtime_paths", {}).values())
    for old_path in old_paths - set(worker_runtime_paths.values()):
        candidate_path = Path(str(old_path)).resolve()
        if candidate_path.parent == worker_runtime_dir.resolve():
            candidate_path.unlink(missing_ok=True)
    runtime["worker_runtime_paths"] = worker_runtime_paths
    _write_private(runtime_path, json.dumps(runtime, ensure_ascii=False, indent=2) + "\n")
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "config_path": str(config_path),
        "source_sha256": prior_manifest["source_sha256"] if preserve_backup else source_hash,
        "generated_sha256": generated_hash,
        "backup_path": str(backup_path) if candidate != source_text or preserve_backup else "",
        "worker_names": list(runtime["mcpServers"]),
    }
    _write_private(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    if candidate != source_text:
        _write_private(config_path, candidate)
    return {
        "worker_names": list(runtime["mcpServers"]),
        "changed": candidate != source_text,
        "generated_text": candidate,
        "runtime_path": str(runtime_path),
        "runtime_paths": worker_runtime_paths,
        "server_ports": runtime["server_ports"],
    }


def rollback_config(config_path: Path, state_dir: Path) -> None:
    manifest_path = state_dir.resolve() / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise ValueError("invalid shared MCP manifest")
    config_path = config_path.resolve()
    if str(config_path).casefold() != str(manifest.get("config_path", "")).casefold():
        raise RuntimeError("rollback config path mismatch")
    current = config_path.read_text(encoding="utf-8")
    current_hash = hashlib.sha256(current.encode("utf-8")).hexdigest()
    if current_hash != manifest.get("generated_sha256"):
        raise RuntimeError("config changed after generation; refusing rollback")
    backup = Path(str(manifest.get("backup_path", "")))
    if not backup.is_file():
        raise RuntimeError("shared MCP rollback backup is missing")
    _write_private(config_path, backup.read_text(encoding="utf-8"))
    runtime = _read_runtime_file(state_dir / "servers.json")
    for value in (runtime or {}).get("worker_runtime_paths", {}).values():
        worker_runtime_path = Path(str(value)).resolve()
        if worker_runtime_path.parent == (state_dir / "servers").resolve():
            worker_runtime_path.unlink(missing_ok=True)
    (state_dir / "servers.json").unlink(missing_ok=True)
    manifest_path.unlink(missing_ok=True)


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def _acquire_mutex(port: int) -> int | None:
    if os.name != "nt":
        raise RuntimeError("the Anti-Codex shared MCP proxy is Windows-only")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    handle = kernel32.CreateMutexW(None, True, f"{MUTEX_NAME}_{port}")
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        kernel32.CloseHandle(handle)
        return None
    return int(handle)


def _close_handle(handle: int) -> None:
    ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(ctypes.c_void_p(handle))


def _install_auth_middleware(token: str) -> None:
    import mcp_proxy.mcp_server as proxy_server
    from starlette.middleware import Middleware

    original_starlette = proxy_server.Starlette

    def secured_starlette(*args: Any, **kwargs: Any) -> Any:
        middleware = list(kwargs.pop("middleware", []) or [])
        middleware.insert(0, Middleware(BearerAuthMiddleware, token=token))
        kwargs["middleware"] = middleware
        return original_starlette(*args, **kwargs)

    proxy_server.Starlette = secured_starlette


def run_proxy(runtime_path: Path) -> int:
    runtime = _read_runtime_file(runtime_path)
    if runtime is None:
        raise ValueError("invalid Anti-Codex shared MCP runtime")
    if not runtime["mcpServers"]:
        return 0
    if len(runtime["mcpServers"]) != 1:
        raise ValueError("each Anti-Codex shared MCP runtime must contain exactly one Worker")
    handle = _acquire_mutex(runtime["port"])
    if handle is None:
        return 0
    try:
        if not port_is_free(runtime["host"], runtime["port"]):
            raise RuntimeError("Anti-Codex shared MCP port is occupied; no workers were started")
        if importlib.metadata.version("mcp-proxy") != PROXY_VERSION:
            raise RuntimeError(f"mcp-proxy {PROXY_VERSION} is required")
        if importlib.metadata.version("mcp") != MCP_SDK_VERSION:
            raise RuntimeError(f"mcp {MCP_SDK_VERSION} is required")
        from mcp_proxy.config_loader import load_named_server_configs_from_file
        from mcp_proxy.mcp_server import MCPServerSettings, run_mcp_server

        _install_auth_middleware(runtime["token"])
        params = load_named_server_configs_from_file(runtime_path, os.environ.copy())
        if set(params) != set(runtime["mcpServers"]):
            raise RuntimeError("proxy loader changed the discovered Worker set")
        settings = MCPServerSettings(
            bind_host=runtime["host"],
            port=runtime["port"],
            stateless=False,
            allow_origins=None,
            log_level="WARNING",
        )
        asyncio.run(run_mcp_server(settings, named_server_params=params))
        return 0
    finally:
        _close_handle(handle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Anti-Codex isolated shared MCP proxy")
    subparsers = parser.add_subparsers(dest="action", required=True)
    discover = subparsers.add_parser("discover")
    discover.add_argument("--config", type=Path, required=True)
    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--config", type=Path, required=True)
    prepare.add_argument("--state", type=Path, required=True)
    prepare.add_argument("--port", type=int, default=DEFAULT_PORT)
    run = subparsers.add_parser("run")
    run.add_argument("--runtime", type=Path, required=True)
    rollback = subparsers.add_parser("rollback")
    rollback.add_argument("--config", type=Path, required=True)
    rollback.add_argument("--state", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.action == "discover":
        names = discover_worker_names(args.config.read_text(encoding="utf-8"))
        print(json.dumps({"ok": True, "worker_names": names}, ensure_ascii=False))
        return 0
    if args.action == "prepare":
        result = prepare_config(args.config, args.state, port=args.port)
        print(json.dumps({key: value for key, value in result.items() if key != "generated_text"}, ensure_ascii=False))
        return 0
    if args.action == "rollback":
        rollback_config(args.config, args.state)
        print(json.dumps({"ok": True, "rolled_back": True}))
        return 0
    return run_proxy(args.runtime)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
