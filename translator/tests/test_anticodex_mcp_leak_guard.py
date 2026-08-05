from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "anticodex_mcp_leak_guard.py"
INSTALLER_PATH = ROOT / "scripts" / "install-anticodex-mcp-leak-guard.ps1"


def load_guard():
    assert MODULE_PATH.exists(), "Anti-Codex MCP leak guard has not been implemented"
    spec = importlib.util.spec_from_file_location("anticodex_mcp_leak_guard", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def sample(
    guard,
    pid: int,
    *,
    created_at: float,
    signature: str = "worker",
    app_pid: int = 10,
    root_pid: int = 20,
    app_created_at: float = 1.0,
    root_created_at: float = 2.0,
):
    return guard.McpProcess(
        pid=pid,
        app_pid=app_pid,
        root_pid=root_pid,
        signature=signature,
        created_at=created_at,
        app_created_at=app_created_at,
        root_created_at=root_created_at,
        working_set_bytes=64 * 1024 * 1024,
    )


def test_matches_only_exact_anticodex_paths() -> None:
    guard = load_guard()
    app = r"C:\Users\XD\AppData\Local\Anti-Codex\codex-patched-app\Anti-Codex.exe"
    core = r"C:\Users\XD\AppData\Local\Anti-Codex\codex-patched-app\resources\codex.exe"

    assert guard.is_exact_windows_path(app, app)
    assert guard.is_exact_windows_path(core, core)
    assert not guard.is_exact_windows_path(
        r"C:\Program Files\WindowsApps\OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0\app\resources\codex.exe",
        core,
    )
    assert not guard.is_exact_windows_path(
        r"C:\Users\XD\AppData\Local\Anti-Codex-old\codex-patched-app\resources\codex.exe",
        core,
    )


def test_snapshot_requires_exact_app_core_and_direct_node_ancestry() -> None:
    guard = load_guard()
    app = r"C:\Users\XD\AppData\Local\Anti-Codex\codex-patched-app\Anti-Codex.exe"
    core = r"C:\Users\XD\AppData\Local\Anti-Codex\codex-patched-app\resources\codex.exe"
    user_data = r"C:\Users\XD\AppData\Roaming\anticodex\codex-home-deepseek-app\electron-user-data-adaptive"
    official = r"C:\Program Files\WindowsApps\OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0\app\resources\codex.exe"
    paths = {
        10: app,
        20: core,
        21: r"C:\Program Files\nodejs\node.exe",
        22: r"C:\Program Files\nodejs\node.exe",
        30: official,
        31: r"C:\Program Files\nodejs\node.exe",
        40: core,
        41: r"C:\Program Files\nodejs\node.exe",
    }
    commands = {
        10: f'"{app}" --user-data-dir="{user_data}" --lang=zh-CN',
        20: f'"{core}" -c features.code_mode_host=true app-server',
        21: "node worker.mjs",
        22: "node nested.mjs",
        30: f'"{official}" app-server',
        31: "node official.mjs",
        40: f'"{core}" -c features.code_mode_host=true app-server',
        41: "node rogue.mjs",
    }

    processes = guard.collect_mcp_processes(
        expected_app_path=app,
        expected_core_path=core,
        expected_user_data_path=user_data,
        process_rows_provider=lambda: [
            (10, 1, "Anti-Codex.exe"),
            (20, 10, "codex.exe"),
            (21, 20, "node.exe"),
            (22, 21, "node.exe"),
            (23, 20, "powershell.exe"),
            (30, 1, "codex.exe"),
            (31, 30, "node.exe"),
            (40, 1, "codex.exe"),
            (41, 40, "node.exe"),
        ],
        path_reader=paths.get,
        command_line_reader=commands.get,
        stats_reader=lambda pid: (float(pid), pid),
    )

    assert [process.pid for process in processes] == [21]
    assert processes[0].app_pid == 10
    assert processes[0].root_pid == 20


def test_reports_exact_anticodex_roots_without_candidates_and_excludes_official(
    tmp_path: Path,
) -> None:
    guard = load_guard()
    app = r"C:\Users\XD\AppData\Local\Anti-Codex\codex-patched-app\Anti-Codex.exe"
    core = r"C:\Users\XD\AppData\Local\Anti-Codex\codex-patched-app\resources\codex.exe"
    user_data = r"C:\Users\XD\AppData\Roaming\anticodex\codex-home-deepseek-app\electron-user-data-adaptive"
    official_app = r"C:\Program Files\WindowsApps\OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe"
    official_core = r"C:\Program Files\WindowsApps\OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0\app\resources\codex.exe"
    paths = {
        10: app,
        20: core,
        100: official_app,
        110: official_core,
        111: r"C:\Program Files\nodejs\node.exe",
    }
    commands = {
        10: f'"{app}" --user-data-dir="{user_data}" --lang=zh-CN',
        20: f'"{core}" -c features.code_mode_host=true app-server',
        100: f'"{official_app}" --user-data-dir="{user_data}"',
        110: f'"{official_core}" -c features.code_mode_host=true app-server',
        111: "node official-worker.mjs",
    }

    snapshot = guard.collect_mcp_snapshot(
        expected_app_path=app,
        expected_core_path=core,
        expected_user_data_path=user_data,
        process_rows_provider=lambda: [
            (10, 1, "Anti-Codex.exe"),
            (20, 10, "codex.exe"),
            (100, 1, "Anti-Codex.exe"),
            (110, 100, "codex.exe"),
            (111, 110, "node.exe"),
        ],
        path_reader=paths.get,
        command_line_reader=commands.get,
        stats_reader=lambda pid: (float(pid), pid),
    )

    assert snapshot.app_pids == (10,)
    assert snapshot.root_pids == (20,)
    assert snapshot.processes == ()

    report = guard.McpLeakGuard(
        runtime_dir=tmp_path,
        snapshot_provider=lambda: snapshot,
        clock=lambda: 1000.0,
    ).run_once(enforce=False)

    assert report["candidate_count"] == 0
    assert report["app_pids"] == [10]
    assert report["root_pids"] == [20]


def test_reads_current_process_command_line_on_windows() -> None:
    if os.name != "nt":
        return
    guard = load_guard()
    command_line = guard._query_process_command_line(os.getpid())
    assert command_line
    assert "python" in command_line.casefold()


def test_live_core_duplicates_are_report_only_and_never_selected(tmp_path: Path) -> None:
    guard = load_guard()
    processes = [sample(guard, pid, created_at=float(pid)) for pid in range(1, 7)]
    terminated: list[int] = []
    instance = guard.McpLeakGuard(
        runtime_dir=tmp_path,
        snapshot_provider=lambda: guard.McpSnapshot((10,), (20,), tuple(processes)),
        orphan_probe=lambda process: "live",
        terminator=lambda pid: terminated.append(pid) or True,
        clock=lambda: 2000.0,
    )
    report = instance.run_once(enforce=True)
    assert report["live_candidate_count"] == 6
    assert report["orphan_candidate_count"] == 0
    assert report["killed_count"] == 0
    assert terminated == []
    assert "MAX_PER_SIGNATURE" not in MODULE_PATH.read_text(encoding="utf-8")


def test_requires_two_stable_scans_sixty_seconds_apart() -> None:
    guard = load_guard()
    limiter = guard.HighWaterLimiter(confirm_seconds=60.0)
    excess = [sample(guard, 1, created_at=0.0)]

    assert limiter.confirm(excess, now=100.0) == []
    assert limiter.confirm(excess, now=159.0) == []
    assert limiter.confirm(excess, now=160.0) == excess
    assert limiter.confirm([], now=161.0) == []


def test_revalidates_orphan_state_immediately_before_termination() -> None:
    guard = load_guard()
    selected = sample(guard, 10, created_at=1.0)
    terminated: list[int] = []

    assert not guard.revalidate_and_terminate_orphan(
        selected,
        orphan_probe=lambda process: "live",
        terminator=lambda pid: terminated.append(pid) or True,
    )
    assert terminated == []

    assert guard.revalidate_and_terminate_orphan(
        selected,
        orphan_probe=lambda process: "orphan",
        terminator=lambda pid: terminated.append(pid) or True,
    )
    assert terminated == [10]


def test_only_previously_observed_anticodex_children_become_orphans(tmp_path: Path) -> None:
    guard = load_guard()
    live = [sample(guard, pid, created_at=0.0) for pid in range(1, 3)]
    scans = iter(
        [
            guard.McpSnapshot((10,), (20,), tuple(live)),
            guard.McpSnapshot((), (), ()),
            guard.McpSnapshot((), (), ()),
        ]
    )
    times = iter([1000.0, 1060.0, 1120.0])
    terminated: list[int] = []
    instance = guard.McpLeakGuard(
        runtime_dir=tmp_path,
        snapshot_provider=lambda: next(scans),
        orphan_probe=lambda process: "orphan",
        terminator=lambda pid: terminated.append(pid) or True,
        clock=lambda: next(times),
    )

    first = instance.run_once(enforce=True)
    second = instance.run_once(enforce=True)
    third = instance.run_once(enforce=True)

    assert first["orphan_candidate_count"] == 0
    assert second["orphan_candidate_count"] == 2
    assert second["confirmed_count"] == 0
    assert third["confirmed_count"] == 2
    assert third["killed_count"] == 2
    assert terminated == [1, 2]
    assert (tmp_path / "anticodex_mcp_leak_guard_state.json").exists()


def test_guard_and_startup_entry_are_independent_from_official_codex() -> None:
    guard = load_guard()
    assert guard.DEFAULT_MUTEX_NAME == r"Local\AntiCodex.McpLeakGuard"
    assert ".codex" not in str(guard.DEFAULT_RUNTIME_DIR).casefold()
    assert "anticodex" in str(guard.DEFAULT_RUNTIME_DIR).casefold()

    source = INSTALLER_PATH.read_text(encoding="utf-8")
    assert "Anti-Codex MCP Leak Guard.lnk" in source
    assert "anticodex\\maintenance" in source
    assert r".codex\maintenance\codex_mcp_leak_guard.py" not in source
    assert "CODEX_CLI_PATH" not in source
    assert "WindowsApps" not in source
    assert "-WindowStyle Hidden" in source
