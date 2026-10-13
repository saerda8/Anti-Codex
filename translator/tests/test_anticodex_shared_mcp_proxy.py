from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tomllib

import pytest


MODULE_PATH = Path(__file__).parents[2] / "scripts" / "anticodex_shared_mcp_proxy.py"
INSTALLER_PATH = Path(__file__).parents[2] / "scripts" / "install-anticodex-shared-mcp.ps1"
RUNTIME_SYNC_PATH = Path(__file__).parents[2] / "scripts" / "sync-anticodex-runtime.ps1"
PRODUCT_INSTALL_PATH = Path(__file__).parents[2] / "scripts" / "install-anticodex.ps1"
SPEC = importlib.util.spec_from_file_location("anticodex_shared_mcp_proxy", MODULE_PATH)
assert SPEC and SPEC.loader
shared = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = shared
SPEC.loader.exec_module(shared)


def worker_blocks(
    name: str,
    *,
    command: str = "node.exe",
    enabled: bool = True,
    entrypoint: str | None = None,
) -> str:
    prefix = name.replace("-worker", "").replace("-external", "")
    entrypoint = entrypoint or ("deepseek-worker-mcp.mjs" if name == "deepseek-external" else f"{name}-worker-mcp.mjs")
    enabled_line = "" if enabled else "enabled = false\n"
    return (
        f"[mcp_servers.{name}]\n"
        f'{enabled_line}command = "{command}"\n'
        f'args = ["C:/workers/{entrypoint}"]\n\n'
        f"[mcp_servers.{name}.env]\n"
        f'WORKER_NAME = "{name}"\n\n'
        f"[mcp_servers.{name}.tools.{prefix}_start_implementation]\n"
        "enabled = true\n"
    )


def absolute_worker_blocks(name: str, command: Path) -> str:
    prefix = name.replace("-worker", "")
    return (
        f"[mcp_servers.{name}]\n"
        f'command = "{command.as_posix()}"\n'
        "args = []\n\n"
        f"[mcp_servers.{name}.tools.{prefix}_start_implementation]\n"
        "enabled = true\n"
    )


def mixed_config() -> str:
    return "\n".join(
        [
            'model = "anticodex"',
            "",
            "[mcp_servers.node_repl]",
            'command = "node_repl.exe"',
            "args = []",
            "",
            "[mcp_servers.remote-worker]",
            'url = "https://example.invalid/mcp"',
            "",
            "[mcp_servers.ordinary-local]",
            'command = "ordinary.exe"',
            'args = ["C:/workers/ordinary.mjs"]',
            "",
            "[mcp_servers.ordinary-local.tools.ordinary_ping]",
            "enabled = true",
            "",
            worker_blocks("deepseek-external"),
            "",
            worker_blocks("future-worker", entrypoint="C:/workers/arbitrary-entrypoint.mjs"),
            "",
            worker_blocks("disabled-worker", enabled=False),
            "",
            "[features]",
            "apps = true",
            "",
        ]
    )


def test_discovers_workers_by_contract_without_fixed_names() -> None:
    assert shared.discover_worker_names(mixed_config()) == (
        "deepseek-external",
        "future-worker",
    )
    source = MODULE_PATH.read_text(encoding="utf-8")
    assert "deepseek-external" not in source
    assert "deepseek-code-worker" not in source
    assert "WORKER_ENTRYPOINT" not in source


def test_build_artifacts_rewrites_only_discovered_workers() -> None:
    runtime, candidate = shared.build_artifacts(
        mixed_config(),
        port=47631,
        token="T" * 43,
        check_paths=False,
    )
    before = tomllib.loads(mixed_config())
    after = tomllib.loads(candidate)

    assert tuple(runtime["mcpServers"]) == ("deepseek-external", "future-worker")
    assert before["model"] == after["model"]
    assert before["features"] == after["features"]
    for untouched in ("node_repl", "remote-worker", "ordinary-local", "disabled-worker"):
        assert before["mcp_servers"][untouched] == after["mcp_servers"][untouched]
    for name in runtime["mcpServers"]:
        old = before["mcp_servers"][name]
        new = after["mcp_servers"][name]
        assert new["url"] == f"http://127.0.0.1:{runtime['server_ports'][name]}/servers/{name}/mcp"
        assert new["http_headers"] == {"Authorization": "Bearer " + "T" * 43}
        assert "command" not in new
        assert "args" not in new
        assert "env" not in new
        assert new["tools"] == old["tools"]
        assert runtime["mcpServers"][name]["command"] == old["command"]


def test_missing_local_worker_is_reported_and_recovers_on_next_prepare(tmp_path: Path) -> None:
    good_command = tmp_path / "good-worker.cmd"
    restored_command = tmp_path / "restored-worker.cmd"
    good_command.write_text("@echo off\n", encoding="utf-8")
    restored_command.write_text("@echo off\n", encoding="utf-8")
    source = "\n".join(
        [
            absolute_worker_blocks("good-worker", good_command),
            absolute_worker_blocks("restored-worker", restored_command),
            "[mcp_servers.remote-worker]",
            'url = "https://example.invalid/mcp"',
        ]
    )
    config = tmp_path / "config.toml"
    state = tmp_path / "shared-mcp"
    config.write_text(source, encoding="utf-8", newline="")
    token = "M" * 43

    first = shared.prepare_config(config, state, port=47631, token=token)
    assert first["worker_names"] == ["good-worker", "restored-worker"]
    restored_command.unlink()

    degraded = shared.prepare_config(config, state, port=47631, token=token)
    assert degraded["worker_names"] == ["good-worker"]
    assert degraded["discovered_worker_names"] == ["good-worker", "restored-worker"]
    assert degraded["unavailable_workers"] == [{
        "name": "restored-worker",
        "reason": "command_path_missing",
        "error": "restored-worker: command path does not exist",
    }]
    runtime = json.loads((state / "servers.json").read_text(encoding="utf-8"))
    assert set(runtime["mcpServers"]) == {"good-worker", "restored-worker"}
    assert set(runtime["worker_runtime_paths"]) == {"good-worker"}
    assert tomllib.loads(config.read_text(encoding="utf-8"))["mcp_servers"]["remote-worker"] == {
        "url": "https://example.invalid/mcp"
    }

    restored_command.write_text("@echo off\n", encoding="utf-8")
    recovered = shared.prepare_config(config, state, port=47631, token=token)
    assert recovered["worker_names"] == ["good-worker", "restored-worker"]
    assert recovered["unavailable_workers"] == []


def test_missing_codebuddy_bin_env_degrades_only_that_worker_and_recovers(tmp_path: Path) -> None:
    wrapper = tmp_path / "worker-wrapper.cmd"
    codebuddy_bin = tmp_path / "codebuddy.cmd"
    wrapper.write_text("@echo off\n", encoding="utf-8")
    source = "\n".join(
        [
            absolute_worker_blocks("good-worker", wrapper),
            (
                "[mcp_servers.codebuddy-worker]\n"
                f'command = "{wrapper.as_posix()}"\n'
                "args = []\n\n"
                "[mcp_servers.codebuddy-worker.env]\n"
                f'CODEBUDDY_BIN = "{codebuddy_bin.as_posix()}"\n\n'
                "[mcp_servers.codebuddy-worker.tools.codebuddy_start_implementation]\n"
                "enabled = true\n"
            ),
        ]
    )
    config = tmp_path / "config.toml"
    state = tmp_path / "shared-mcp"
    config.write_text(source, encoding="utf-8", newline="")

    degraded = shared.prepare_config(config, state, port=47631, token="C" * 43)
    assert degraded["worker_names"] == ["good-worker"]
    assert degraded["unavailable_workers"] == [{
        "name": "codebuddy-worker",
        "reason": "env_path_missing",
        "error": "codebuddy-worker: CODEBUDDY_BIN path does not exist",
    }]
    runtime = json.loads((state / "servers.json").read_text(encoding="utf-8"))
    assert set(runtime["mcpServers"]) == {"codebuddy-worker", "good-worker"}
    assert set(runtime["worker_runtime_paths"]) == {"good-worker"}

    codebuddy_bin.write_text("@echo off\n", encoding="utf-8")
    recovered = shared.prepare_config(config, state, port=47631, token="C" * 43)
    assert recovered["worker_names"] == ["codebuddy-worker", "good-worker"]
    assert recovered["unavailable_workers"] == []


def test_only_missing_entry_errors_are_degraded(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    command = tmp_path / "worker.cmd"
    command.write_text("@echo off\n", encoding="utf-8")
    source = absolute_worker_blocks("future-worker", command)

    def unexpected(_name: str, _server: object) -> None:
        raise RuntimeError("unexpected validation failure")

    monkeypatch.setattr(shared, "_validate_paths", unexpected)
    with pytest.raises(RuntimeError, match="unexpected validation failure"):
        shared.build_artifacts(source, port=47631, token="U" * 43)


def test_previous_generated_worker_is_reused_then_stops_when_disabled_or_deleted() -> None:
    source = worker_blocks("future-worker")
    runtime, candidate = shared.build_artifacts(
        source,
        port=47631,
        token="S" * 43,
        check_paths=False,
    )
    runtime2, candidate2 = shared.build_artifacts(
        candidate,
        port=47631,
        token="S" * 43,
        previous_runtime=runtime,
        check_paths=False,
    )
    assert tuple(runtime2["mcpServers"]) == ("future-worker",)
    assert candidate2 == candidate

    disabled = candidate.replace(
        "[mcp_servers.future-worker]\n",
        "[mcp_servers.future-worker]\nenabled = false\n",
        1,
    )
    disabled_runtime, _ = shared.build_artifacts(
        disabled,
        port=47631,
        token="S" * 43,
        previous_runtime=runtime,
        check_paths=False,
    )
    assert disabled_runtime["mcpServers"] == {}

    deleted = "\n".join(
        line
        for line in candidate.splitlines()
        if "mcp_servers.future-worker" not in line
        and not line.startswith(("url =", "http_headers =", "enabled ="))
    )
    deleted_runtime, _ = shared.build_artifacts(
        deleted,
        port=47631,
        token="S" * 43,
        previous_runtime=runtime,
        check_paths=False,
    )
    assert deleted_runtime["mcpServers"] == {}


def test_prepare_and_safe_rollback_preserve_unrelated_changes(tmp_path: Path) -> None:
    config = tmp_path / "config.toml"
    state = tmp_path / "shared-mcp"
    config.write_text(worker_blocks("future-worker"), encoding="utf-8", newline="")

    prepared = shared.prepare_config(
        config,
        state,
        port=47631,
        token="R" * 43,
        check_paths=False,
    )
    assert prepared["worker_names"] == ["future-worker"]
    assert set(prepared["runtime_paths"]) == {"future-worker"}
    assert prepared["server_ports"] == {"future-worker": 47631}
    assert Path(prepared["runtime_paths"]["future-worker"]).is_file()
    assert (state / "servers.json").is_file()
    assert "http://127.0.0.1:47631" in config.read_text(encoding="utf-8")

    config.write_text(config.read_text(encoding="utf-8") + "\n# user change\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="changed after generation"):
        shared.rollback_config(config, state)

    config.write_text(prepared["generated_text"], encoding="utf-8", newline="")
    shared.rollback_config(config, state)
    assert 'command = "node.exe"' in config.read_text(encoding="utf-8")


def test_repeated_prepare_keeps_first_backup_for_exact_rollback(tmp_path: Path) -> None:
    config = tmp_path / "config.toml"
    state = tmp_path / "shared-mcp"
    original = worker_blocks("future-worker")
    config.write_text(original, encoding="utf-8", newline="")

    shared.prepare_config(config, state, port=47631, token="R" * 43, check_paths=False)
    first_manifest = json.loads((state / "manifest.json").read_text(encoding="utf-8"))
    shared.prepare_config(config, state, port=47631, token="R" * 43, check_paths=False)
    second_manifest = json.loads((state / "manifest.json").read_text(encoding="utf-8"))

    assert second_manifest["backup_path"] == first_manifest["backup_path"]
    assert second_manifest["source_sha256"] == first_manifest["source_sha256"]
    shared.rollback_config(config, state)
    assert config.read_text(encoding="utf-8") == original


def test_bearer_auth_rejects_missing_wrong_and_duplicate_headers() -> None:
    calls: list[str] = []

    async def downstream(scope, receive, send):
        calls.append(scope["path"])
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    token = "A" * 43
    middleware = shared.BearerAuthMiddleware(downstream, token=token)

    async def request(values: list[str]) -> int:
        sent = []
        scope = {
            "type": "http",
            "path": "/servers/future-worker/mcp",
            "headers": [(b"authorization", value.encode("ascii")) for value in values],
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        await middleware(scope, receive, send)
        return next(item["status"] for item in sent if item["type"] == "http.response.start")

    assert asyncio.run(request([])) == 401
    assert asyncio.run(request(["Bearer wrong"])) == 401
    assert asyncio.run(request(["Bearer " + token, "Bearer " + token])) == 401
    assert asyncio.run(request(["Bearer " + token])) == 204
    assert calls == ["/servers/future-worker/mcp"]


def test_installer_uses_only_anticodex_paths_and_keeps_a_rollback() -> None:
    source = INSTALLER_PATH.read_text(encoding="utf-8")
    assert "AntiCodexSharedMcpInstall" in source
    assert '"shared-mcp"' in source
    assert '"shared-mcp-rollback"' in source
    assert '$proxyVersion = "0.12.0"' in source
    assert '$mcpVersion = "1.27.1"' in source
    assert '"mcp-proxy==$proxyVersion"' in source
    assert '"mcp==$mcpVersion"' in source
    assert "--timeout 15 --retries 1" in source
    assert ".codex\\mcp\\shared-proxy" not in source
    assert "CODEX_CLI_PATH" not in source
    assert "Start-Process" not in source
    assert "shared-mcp-backups" not in source
    assert "exit 0" not in source
    assert "$null = & $venvPython" in source


def test_product_install_and_runtime_sync_install_the_isolated_component() -> None:
    for path in (PRODUCT_INSTALL_PATH, RUNTIME_SYNC_PATH):
        source = path.read_text(encoding="utf-8-sig")
        assert 'install-anticodex-shared-mcp.ps1' in source
        assert 'anticodex_shared_mcp_proxy.py' in source
        assert '-InstallRoot' in source
