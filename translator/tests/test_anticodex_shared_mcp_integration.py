from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
import pytest


PROXY_SCRIPT = Path(__file__).parents[2] / "scripts" / "anticodex_shared_mcp_proxy.py"
COMPONENT_PYTHON = Path(os.environ.get("ANTICODEX_SHARED_MCP_PYTHON", ""))
pytestmark = pytest.mark.skipif(
    not COMPONENT_PYTHON.is_file(),
    reason="set ANTICODEX_SHARED_MCP_PYTHON to the isolated Anti-Codex component Python",
)


def _worker_block(name: str, script: Path, marker: Path) -> str:
    prefix = name.replace("-", "_").replace("_external", "")
    return (
        f"[mcp_servers.{name}]\n"
        f'command = "{Path(sys.executable).as_posix()}"\n'
        f'args = ["{script.as_posix()}"]\n\n'
        f"[mcp_servers.{name}.env]\n"
        f'WORKER_NAME = "{name}"\n'
        f'WORKER_MARKER = "{marker.as_posix()}"\n\n'
        f"[mcp_servers.{name}.tools.{prefix}_start_implementation]\n"
        "enabled = true\n"
    )


def _wait_port(port: int, process: subprocess.Popen[bytes], error_log: Path, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            detail = error_log.read_text(encoding="utf-8", errors="replace") if error_log.exists() else ""
            raise AssertionError(f"proxy exited early: {process.returncode}: {detail[-2_000:]}")
        with socket.socket() as client:
            client.settimeout(0.2)
            if client.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise AssertionError("proxy did not listen")


async def _list_tools(url: str, token: str) -> tuple[str, ...]:
    async with streamablehttp_client(
        url,
        headers={"Authorization": f"Bearer {token}"},
        timeout=3,
        sse_read_timeout=3,
    ) as (read_stream, write_stream, _):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            return tuple(tool.name for tool in (await session.list_tools()).tools)


def _marker_pids(marker: Path) -> dict[str, set[int]]:
    result: dict[str, set[int]] = {}
    if not marker.exists():
        return result
    for line in marker.read_text(encoding="utf-8").splitlines():
        name, raw_pid = line.split(" ", 1)
        result.setdefault(name, set()).add(int(raw_pid))
    return result


def _pid_running(pid: int) -> bool:
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", f"if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }}; exit 1"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def _stop_test_pid(pid: int, root: Path) -> None:
    env = {**os.environ, "ANTICODEX_TEST_PID": str(pid), "ANTICODEX_TEST_ROOT": str(root)}
    script = (
        '$row = Get-CimInstance Win32_Process -Filter "ProcessId = $env:ANTICODEX_TEST_PID" '
        '-ErrorAction SilentlyContinue; if (!$row) { exit 0 }; '
        'if ([string]$row.CommandLine -notlike ("*" + $env:ANTICODEX_TEST_ROOT + "*")) { exit 42 }; '
        'Stop-Process -Id ([int]$env:ANTICODEX_TEST_PID) -Force -ErrorAction Stop'
    )
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        check=True,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def test_four_channels_share_each_worker_and_isolate_auth_duplicates_and_failure() -> None:
    port = 47_632
    test_parent = os.environ.get("ANTICODEX_SHARED_MCP_TEST_ROOT") or None
    with tempfile.TemporaryDirectory(prefix="anticodex-shared-mcp-", dir=test_parent) as raw_root:
        root = Path(raw_root)
        state = root / "state"
        marker = root / "worker-pids.txt"
        worker = root / "future-worker-mcp.py"
        broken = root / "broken-worker-mcp.py"
        worker.write_text(
            "import os\nfrom pathlib import Path\n"
            "Path(os.environ['WORKER_MARKER']).open('a', encoding='utf-8').write(f\"{os.environ['WORKER_NAME']} {os.getpid()}\\n\")\n"
            "from mcp.server.fastmcp import FastMCP\nserver=FastMCP(os.environ['WORKER_NAME'])\n"
            "@server.tool()\ndef sample_start_implementation(task: str = '') -> str: return task or 'ok'\n"
            "server.run(transport='stdio')\n",
            encoding="utf-8",
        )
        broken.write_text("raise SystemExit(23)\n", encoding="utf-8")
        config = root / "config.toml"
        config.write_text(
            "\n\n".join(
                [
                    _worker_block("deepseek-external", worker, marker),
                    _worker_block("future-autonomous-worker", worker, marker),
                    _worker_block("broken-worker", broken, marker),
                ]
            ),
            encoding="utf-8",
        )
        prepared = json.loads(
            subprocess.check_output(
                [
                    str(COMPONENT_PYTHON),
                    "-B",
                    str(PROXY_SCRIPT),
                    "prepare",
                    "--config",
                    str(config),
                    "--state",
                    str(state),
                    "--port",
                    str(port),
                ],
                text=True,
            )
        )
        assert prepared["worker_names"] == ["broken-worker", "deepseek-external", "future-autonomous-worker"]
        runtime = json.loads((state / "servers.json").read_text(encoding="utf-8"))
        token = runtime["token"]
        logs: dict[str, tuple[object, object]] = {}
        proxies: dict[str, subprocess.Popen[bytes]] = {}
        for index, name in enumerate(prepared["worker_names"], start=1):
            log = (root / f"proxy-{index}.log").open("wb")
            err = (root / f"proxy-{index}.err.log").open("wb")
            logs[name] = (log, err)
            proxies[name] = subprocess.Popen(
                [
                    str(COMPONENT_PYTHON),
                    "-B",
                    str(PROXY_SCRIPT),
                    "run",
                    "--runtime",
                    prepared["runtime_paths"][name],
                ],
                stdout=log,
                stderr=err,
            )
        tracked: set[int] = set()
        try:
            for index, name in enumerate(("deepseek-external", "future-autonomous-worker"), start=2):
                _wait_port(prepared["server_ports"][name], proxies[name], root / f"proxy-{index}.err.log")
            deadline = time.monotonic() + 5
            while proxies["broken-worker"].poll() is None and time.monotonic() < deadline:
                time.sleep(0.1)
            assert proxies["broken-worker"].poll() not in (None, 0)

            def url(name: str) -> str:
                return f"http://127.0.0.1:{prepared['server_ports'][name]}/servers/{name}/mcp"

            assert httpx.post(url("deepseek-external"), timeout=3).status_code == 401

            async def four_channels() -> list[tuple[str, ...]]:
                calls = [
                    _list_tools(url(name), token)
                    for _ in range(4)
                    for name in ("deepseek-external", "future-autonomous-worker")
                ]
                return await asyncio.gather(*calls)

            tool_sets = asyncio.run(four_channels())
            assert all("sample_start_implementation" in tools for tools in tool_sets)
            pids = _marker_pids(marker)
            assert len(pids["deepseek-external"]) == 1
            assert len(pids["future-autonomous-worker"]) == 1
            tracked.update(pids["deepseek-external"] | pids["future-autonomous-worker"])

            duplicate = subprocess.run(
                [
                    str(COMPONENT_PYTHON),
                    "-B",
                    str(PROXY_SCRIPT),
                    "run",
                    "--runtime",
                    prepared["runtime_paths"]["deepseek-external"],
                ],
                timeout=5,
                check=False,
            )
            assert duplicate.returncode == 0
            assert _marker_pids(marker) == pids

            assert "sample_start_implementation" in asyncio.run(
                _list_tools(url("deepseek-external"), token)
            )
        finally:
            for proxy in proxies.values():
                if proxy.poll() is None:
                    proxy.terminate()
                    try:
                        proxy.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proxy.kill()
                        proxy.wait(timeout=5)
            for log, err in logs.values():
                log.close()
                err.close()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and any(_pid_running(pid) for pid in tracked):
                time.sleep(0.1)
            residual = {pid for pid in tracked if _pid_running(pid)}
            for pid in residual:
                _stop_test_pid(pid, root)
            assert not residual, f"shared Worker processes survived proxy shutdown: {sorted(residual)}"
