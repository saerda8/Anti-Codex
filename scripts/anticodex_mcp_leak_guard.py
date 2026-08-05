from __future__ import annotations

import argparse
from collections import defaultdict
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path, PureWindowsPath
import subprocess
import tempfile
import time
from typing import Callable, Iterable, Mapping


POLL_SECONDS = 60.0
MINIMUM_AGE_SECONDS = 15 * 60.0
CONFIRM_SECONDS = 60.0
MEMORY_HIGH_WATER_BYTES = 3 * 1024**3
DEFAULT_MUTEX_NAME = r"Local\AntiCodex.McpLeakGuard"


def _local_app_data() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")


def _roaming_app_data() -> Path:
    return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")


DEFAULT_INSTALL_ROOT = _local_app_data() / "Anti-Codex"
DEFAULT_APP_PATH = DEFAULT_INSTALL_ROOT / "codex-patched-app" / "Anti-Codex.exe"
DEFAULT_CORE_PATH = DEFAULT_INSTALL_ROOT / "codex-patched-app" / "resources" / "codex.exe"
DEFAULT_USER_DATA_PATH = (
    _roaming_app_data()
    / "anticodex"
    / "codex-home-deepseek-app"
    / "electron-user-data-adaptive"
)
DEFAULT_RUNTIME_DIR = _roaming_app_data() / "anticodex" / "maintenance" / "runtime"
_CANDIDATE_NAMES = {"node.exe", "node_repl.exe"}


@dataclass(frozen=True, slots=True)
class McpProcess:
    pid: int
    app_pid: int
    root_pid: int
    signature: str
    created_at: float
    app_created_at: float
    root_created_at: float
    working_set_bytes: int


@dataclass(frozen=True, slots=True)
class McpSnapshot:
    app_pids: tuple[int, ...]
    root_pids: tuple[int, ...]
    processes: tuple[McpProcess, ...]


class _ProcessEntry32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


class _UnicodeString(ctypes.Structure):
    _fields_ = [
        ("Length", wintypes.USHORT),
        ("MaximumLength", wintypes.USHORT),
        ("Buffer", ctypes.c_void_p),
    ]


class _FileTime(ctypes.Structure):
    _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]


class _ProcessMemoryCounters(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("page_fault_count", wintypes.DWORD),
        ("peak_working_set_size", ctypes.c_size_t),
        ("working_set_size", ctypes.c_size_t),
        ("quota_peak_paged_pool_usage", ctypes.c_size_t),
        ("quota_paged_pool_usage", ctypes.c_size_t),
        ("quota_peak_non_paged_pool_usage", ctypes.c_size_t),
        ("quota_non_paged_pool_usage", ctypes.c_size_t),
        ("pagefile_usage", ctypes.c_size_t),
        ("peak_pagefile_usage", ctypes.c_size_t),
    ]


class WindowsNamedMutex:
    def __init__(self, name: str = DEFAULT_MUTEX_NAME) -> None:
        self.name = name
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True) if os.name == "nt" else None
        self._handle: object | None = None

    def acquire(self) -> bool:
        if self._kernel32 is None:
            return True
        create_mutex = self._kernel32.CreateMutexW
        create_mutex.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        create_mutex.restype = wintypes.HANDLE
        close_handle = self._kernel32.CloseHandle
        close_handle.argtypes = [wintypes.HANDLE]
        close_handle.restype = wintypes.BOOL
        ctypes.set_last_error(0)
        handle = create_mutex(None, False, self.name)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if ctypes.get_last_error() == 183:
            close_handle(handle)
            return False
        self._handle = handle
        return True

    def release(self) -> None:
        if self._handle is None or self._kernel32 is None:
            return
        self._kernel32.CloseHandle(self._handle)
        self._handle = None


def _normalized_windows_path(path: os.PathLike[str] | str | None) -> str | None:
    if not path:
        return None
    try:
        return str(PureWindowsPath(os.fspath(path))).casefold()
    except (TypeError, ValueError):
        return None


def is_exact_windows_path(
    actual: os.PathLike[str] | str | None,
    expected: os.PathLike[str] | str,
) -> bool:
    return _normalized_windows_path(actual) == _normalized_windows_path(expected)


def _is_anticodex_main_command(command_line: str | None, user_data_path: Path | str) -> bool:
    if not command_line:
        return False
    normalized = command_line.casefold()
    expected_data = _normalized_windows_path(user_data_path)
    return (
        "--type=" not in normalized
        and "--user-data-dir" in normalized
        and expected_data is not None
        and expected_data in normalized
    )


def _is_anticodex_core_command(command_line: str | None) -> bool:
    normalized = (command_line or "").casefold()
    return "app-server" in normalized and "features.code_mode_host=true" in normalized


def _signature(executable_path: str, command_line: str) -> str:
    value = f"{PureWindowsPath(executable_path)}\0{command_line.strip()}".casefold()
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _toolhelp_process_rows() -> Iterable[tuple[int, int, str]]:
    if os.name != "nt":
        return ()
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_snapshot = kernel32.CreateToolhelp32Snapshot
    create_snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    create_snapshot.restype = wintypes.HANDLE
    process_first = kernel32.Process32FirstW
    process_first.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32W)]
    process_first.restype = wintypes.BOOL
    process_next = kernel32.Process32NextW
    process_next.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32W)]
    process_next.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL

    snapshot = create_snapshot(0x00000002, 0)
    if snapshot == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    rows: list[tuple[int, int, str]] = []
    try:
        entry = _ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(entry)
        if process_first(snapshot, ctypes.byref(entry)):
            while True:
                rows.append(
                    (
                        int(entry.th32ProcessID),
                        int(entry.th32ParentProcessID),
                        entry.szExeFile,
                    )
                )
                if not process_next(snapshot, ctypes.byref(entry)):
                    break
    finally:
        close_handle(snapshot)
    return rows


def _query_process_path(pid: int) -> str | None:
    if os.name != "nt":
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    open_process = kernel32.OpenProcess
    open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    open_process.restype = wintypes.HANDLE
    query_image_name = kernel32.QueryFullProcessImageNameW
    query_image_name.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    query_image_name.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL
    handle = open_process(0x1000, False, pid)
    if not handle:
        return None
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        length = wintypes.DWORD(len(buffer))
        if not query_image_name(handle, 0, buffer, ctypes.byref(length)):
            return None
        return buffer.value
    finally:
        close_handle(handle)


def _query_process_command_line(pid: int) -> str | None:
    if os.name != "nt":
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    open_process = kernel32.OpenProcess
    open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    open_process.restype = wintypes.HANDLE
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL
    query_information = ntdll.NtQueryInformationProcess
    query_information.argtypes = [
        wintypes.HANDLE,
        wintypes.ULONG,
        wintypes.LPVOID,
        wintypes.ULONG,
        ctypes.POINTER(wintypes.ULONG),
    ]
    query_information.restype = wintypes.LONG
    handle = open_process(0x1000, False, pid)
    if not handle:
        return None
    try:
        required_size = wintypes.ULONG()
        query_information(handle, 60, None, 0, ctypes.byref(required_size))
        if required_size.value < ctypes.sizeof(_UnicodeString):
            return None
        buffer = ctypes.create_string_buffer(required_size.value)
        status = query_information(
            handle,
            60,
            buffer,
            required_size.value,
            ctypes.byref(required_size),
        )
        if status != 0:
            return None
        command_line = ctypes.cast(buffer, ctypes.POINTER(_UnicodeString)).contents
        if command_line.Length == 0:
            return ""
        if not command_line.Buffer:
            return None
        return ctypes.wstring_at(
            command_line.Buffer,
            command_line.Length // ctypes.sizeof(ctypes.c_wchar),
        )
    finally:
        close_handle(handle)


def _read_process_stats(pid: int) -> tuple[float, int] | None:
    if os.name != "nt":
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    open_process = kernel32.OpenProcess
    open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    open_process.restype = wintypes.HANDLE
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL
    get_process_times = kernel32.GetProcessTimes
    get_process_times.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
    ]
    get_process_times.restype = wintypes.BOOL
    handle = open_process(0x0410, False, pid) or open_process(0x1000, False, pid)
    if not handle:
        return None
    try:
        created = _FileTime()
        exited = _FileTime()
        kernel = _FileTime()
        user = _FileTime()
        if not get_process_times(
            handle,
            ctypes.byref(created),
            ctypes.byref(exited),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return None
        filetime = (created.high << 32) | created.low
        created_at = filetime / 10_000_000 - 11_644_473_600
        working_set = 0
        try:
            counters = _ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            get_memory_info = ctypes.WinDLL("psapi").GetProcessMemoryInfo
            get_memory_info.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(_ProcessMemoryCounters),
                wintypes.DWORD,
            ]
            get_memory_info.restype = wintypes.BOOL
            if get_memory_info(handle, ctypes.byref(counters), counters.cb):
                working_set = int(counters.working_set_size)
        except (AttributeError, OSError):
            pass
        return created_at, working_set
    finally:
        close_handle(handle)


def collect_mcp_snapshot(
    *,
    expected_app_path: Path | str = DEFAULT_APP_PATH,
    expected_core_path: Path | str = DEFAULT_CORE_PATH,
    expected_user_data_path: Path | str = DEFAULT_USER_DATA_PATH,
    process_rows_provider: Callable[[], Iterable[tuple[int, int, str]]] = _toolhelp_process_rows,
    path_reader: Callable[[int], str | None] = _query_process_path,
    command_line_reader: Callable[[int], str | None] = _query_process_command_line,
    stats_reader: Callable[[int], tuple[float, int] | None] = _read_process_stats,
) -> McpSnapshot:
    try:
        rows = list(process_rows_provider())
    except OSError:
        return McpSnapshot((), (), ())

    apps: dict[int, float] = {}
    for pid, _parent_pid, executable_name in rows:
        if executable_name.casefold() != "anti-codex.exe":
            continue
        try:
            command_line = command_line_reader(pid)
            stats = stats_reader(pid)
            if (
                is_exact_windows_path(path_reader(pid), expected_app_path)
                and _is_anticodex_main_command(command_line, expected_user_data_path)
                and stats is not None
            ):
                apps[pid] = stats[0]
        except Exception:
            continue

    roots: dict[int, tuple[int, float, float]] = {}
    for pid, parent_pid, executable_name in rows:
        if executable_name.casefold() != "codex.exe" or parent_pid not in apps:
            continue
        try:
            command_line = command_line_reader(pid)
            stats = stats_reader(pid)
            if (
                is_exact_windows_path(path_reader(pid), expected_core_path)
                and _is_anticodex_core_command(command_line)
                and stats is not None
            ):
                roots[pid] = (parent_pid, apps[parent_pid], stats[0])
        except Exception:
            continue

    processes: list[McpProcess] = []
    for pid, parent_pid, executable_name in rows:
        if parent_pid not in roots or executable_name.casefold() not in _CANDIDATE_NAMES:
            continue
        try:
            executable_path = path_reader(pid)
            command_line = command_line_reader(pid)
            stats = stats_reader(pid)
        except Exception:
            continue
        if not executable_path or not command_line or stats is None:
            continue
        app_pid, app_created_at, root_created_at = roots[parent_pid]
        processes.append(
            McpProcess(
                pid=pid,
                app_pid=app_pid,
                root_pid=parent_pid,
                signature=_signature(executable_path, command_line),
                created_at=stats[0],
                app_created_at=app_created_at,
                root_created_at=root_created_at,
                working_set_bytes=max(0, stats[1]),
            )
        )
    return McpSnapshot(
        tuple(sorted(apps)),
        tuple(sorted(roots)),
        tuple(sorted(processes, key=lambda process: (process.app_pid, process.root_pid, process.created_at))),
    )


def collect_mcp_processes(
    *,
    expected_app_path: Path | str = DEFAULT_APP_PATH,
    expected_core_path: Path | str = DEFAULT_CORE_PATH,
    expected_user_data_path: Path | str = DEFAULT_USER_DATA_PATH,
    process_rows_provider: Callable[[], Iterable[tuple[int, int, str]]] = _toolhelp_process_rows,
    path_reader: Callable[[int], str | None] = _query_process_path,
    command_line_reader: Callable[[int], str | None] = _query_process_command_line,
    stats_reader: Callable[[int], tuple[float, int] | None] = _read_process_stats,
) -> list[McpProcess]:
    return list(
        collect_mcp_snapshot(
            expected_app_path=expected_app_path,
            expected_core_path=expected_core_path,
            expected_user_data_path=expected_user_data_path,
            process_rows_provider=process_rows_provider,
            path_reader=path_reader,
            command_line_reader=command_line_reader,
            stats_reader=stats_reader,
        ).processes
    )


def _coerce_mcp_snapshot(value: McpSnapshot | Iterable[McpProcess]) -> McpSnapshot:
    if isinstance(value, McpSnapshot):
        return value
    processes = tuple(value)
    return McpSnapshot(
        tuple(sorted({process.app_pid for process in processes})),
        tuple(sorted({process.root_pid for process in processes})),
        processes,
    )


def _identity(process: McpProcess) -> tuple[int, int, int, str, float, float, float]:
    return (
        process.app_pid,
        process.root_pid,
        process.pid,
        process.signature,
        process.app_created_at,
        process.root_created_at,
        process.created_at,
    )


class HighWaterLimiter:
    def __init__(self, *, confirm_seconds: float = CONFIRM_SECONDS) -> None:
        self.confirm_seconds = confirm_seconds
        self._first_seen: dict[tuple[int, int, int, str, float, float, float], float] = {}

    def confirm(self, processes: Iterable[McpProcess], *, now: float) -> list[McpProcess]:
        current = {_identity(process): process for process in processes}
        self._first_seen = {
            key: seen_at for key, seen_at in self._first_seen.items() if key in current
        }
        confirmed: list[McpProcess] = []
        for key, process in current.items():
            first_seen = self._first_seen.setdefault(key, now)
            if now - first_seen >= self.confirm_seconds:
                confirmed.append(process)
        return confirmed


def _terminate_process_tree(pid: int) -> bool:
    if pid <= 0:
        return False
    completed = subprocess.run(
        ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return completed.returncode == 0


def probe_tracked_process(
    process: McpProcess,
    *,
    expected_app_path: Path | str = DEFAULT_APP_PATH,
    expected_core_path: Path | str = DEFAULT_CORE_PATH,
    expected_user_data_path: Path | str = DEFAULT_USER_DATA_PATH,
    path_reader: Callable[[int], str | None] = _query_process_path,
    command_line_reader: Callable[[int], str | None] = _query_process_command_line,
    stats_reader: Callable[[int], tuple[float, int] | None] = _read_process_stats,
) -> str:
    try:
        worker_path = path_reader(process.pid)
        worker_command = command_line_reader(process.pid)
        worker_stats = stats_reader(process.pid)
    except Exception:
        return "gone"
    if (
        not worker_path
        or not worker_command
        or worker_stats is None
        or worker_stats[0] != process.created_at
        or _signature(worker_path, worker_command) != process.signature
    ):
        return "gone"

    app_alive = False
    root_alive = False
    try:
        app_stats = stats_reader(process.app_pid)
        app_alive = (
            app_stats is not None
            and app_stats[0] == process.app_created_at
            and is_exact_windows_path(path_reader(process.app_pid), expected_app_path)
            and _is_anticodex_main_command(
                command_line_reader(process.app_pid), expected_user_data_path
            )
        )
    except Exception:
        pass
    try:
        root_stats = stats_reader(process.root_pid)
        root_alive = (
            root_stats is not None
            and root_stats[0] == process.root_created_at
            and is_exact_windows_path(path_reader(process.root_pid), expected_core_path)
            and _is_anticodex_core_command(command_line_reader(process.root_pid))
        )
    except Exception:
        pass
    return "live" if app_alive or root_alive else "orphan"


def revalidate_and_terminate_orphan(
    selected: McpProcess,
    *,
    orphan_probe: Callable[[McpProcess], str] = probe_tracked_process,
    terminator: Callable[[int], bool] = _terminate_process_tree,
) -> bool:
    return orphan_probe(selected) == "orphan" and terminator(selected.pid)


def atomic_write_json(path: Path, payload: Mapping[str, object]) -> None:
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
        ) as stream:
            temporary = Path(stream.name)
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def configure_logging(path: Path) -> logging.Logger:
    path.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(f"anticodex-mcp-leak-guard:{path.resolve()}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for handler in tuple(logger.handlers):
        handler.close()
        logger.removeHandler(handler)
    handler = RotatingFileHandler(path, maxBytes=1_000_000, backupCount=5, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    return logger


def _group_report(processes: Iterable[McpProcess]) -> list[dict[str, object]]:
    groups: dict[tuple[int, int, str], list[McpProcess]] = defaultdict(list)
    for process in processes:
        groups[(process.app_pid, process.root_pid, process.signature)].append(process)
    return [
        {
            "app_pid": app_pid,
            "root_pid": root_pid,
            "signature": signature,
            "count": len(group),
            "working_set_mib": round(
                sum(process.working_set_bytes for process in group) / 1024**2,
                1,
            ),
        }
        for (app_pid, root_pid, signature), group in sorted(groups.items())
    ]


class McpLeakGuard:
    def __init__(
        self,
        *,
        runtime_dir: Path = DEFAULT_RUNTIME_DIR,
        snapshot_provider: Callable[[], McpSnapshot | Iterable[McpProcess]] = collect_mcp_snapshot,
        orphan_probe: Callable[[McpProcess], str] = probe_tracked_process,
        terminator: Callable[[int], bool] = _terminate_process_tree,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.runtime_dir = runtime_dir
        self.snapshot_provider = snapshot_provider
        self.orphan_probe = orphan_probe
        self.terminator = terminator
        self.clock = clock
        self.limiter = HighWaterLimiter()
        self.tracked: dict[tuple[int, int, int, str, float, float, float], McpProcess] = {}
        self.logger = configure_logging(runtime_dir / "anticodex_mcp_leak_guard.log")

    def run_once(self, *, enforce: bool) -> dict[str, object]:
        now = self.clock()
        scan = _coerce_mcp_snapshot(self.snapshot_provider())
        live = list(scan.processes)
        live_identities = {_identity(process) for process in live}
        for process in live:
            self.tracked[_identity(process)] = process
        orphan_candidates: list[McpProcess] = []
        retained = dict(self.tracked)
        for identity, process in tuple(self.tracked.items()):
            if identity in live_identities:
                continue
            state = self.orphan_probe(process)
            if state == "gone":
                retained.pop(identity, None)
            elif state == "orphan" and now - process.created_at >= MINIMUM_AGE_SECONDS:
                orphan_candidates.append(process)
        self.tracked = retained
        orphan_candidates.sort(key=lambda process: process.created_at)
        confirmed = self.limiter.confirm(orphan_candidates, now=now)
        killed: list[int] = []
        if enforce:
            for process in confirmed:
                if revalidate_and_terminate_orphan(
                    process,
                    orphan_probe=self.orphan_probe,
                    terminator=self.terminator,
                ):
                    killed.append(process.pid)
                    self.tracked.pop(_identity(process), None)
        observed = list({process.pid: process for process in [*live, *orphan_candidates]}.values())
        total_working_set = sum(process.working_set_bytes for process in observed)
        post_working_set = sum(
            process.working_set_bytes for process in observed if process.pid not in killed
        )
        report: dict[str, object] = {
            "schema": "anticodex-mcp-leak-guard-state-v1",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "mode": "enforce" if enforce else "dry-run",
            "target": {
                "app_path": str(DEFAULT_APP_PATH),
                "core_path": str(DEFAULT_CORE_PATH),
                "user_data_path": str(DEFAULT_USER_DATA_PATH),
            },
            "selection_policy": "true-orphan-only",
            "candidate_count": len(live),
            "live_candidate_count": len(live),
            "post_candidate_count": len(live),
            "orphan_candidate_count": len(orphan_candidates),
            "excess_count": len(orphan_candidates),
            "confirmed_count": len(confirmed),
            "killed_count": len(killed),
            "killed_pids": killed,
            "working_set_mib": round(total_working_set / 1024**2, 1),
            "post_working_set_mib": round(post_working_set / 1024**2, 1),
            "memory_high_water_mib": MEMORY_HIGH_WATER_BYTES // 1024**2,
            "memory_over_high_water": total_working_set > MEMORY_HIGH_WATER_BYTES,
            "minimum_age_seconds": int(MINIMUM_AGE_SECONDS),
            "confirm_seconds": int(CONFIRM_SECONDS),
            "app_pids": list(scan.app_pids),
            "root_pids": list(scan.root_pids),
            "groups": _group_report(observed),
            "excess": [
                {
                    "pid": process.pid,
                    "app_pid": process.app_pid,
                    "root_pid": process.root_pid,
                    "signature": process.signature,
                    "age_seconds": int(max(0.0, now - process.created_at)),
                }
                for process in orphan_candidates
            ],
        }
        atomic_write_json(self.runtime_dir / "anticodex_mcp_leak_guard_state.json", report)
        self.logger.info(
            "event=scan mode=%s live=%d orphans=%d confirmed=%d killed=%d working_set_mib=%.1f",
            report["mode"],
            len(live),
            len(orphan_candidates),
            len(confirmed),
            len(killed),
            report["working_set_mib"],
        )
        return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Clean only confirmed orphaned Anti-Codex MCP processes")
    parser.add_argument("--enforce", action="store_true", help="terminate confirmed true orphans")
    parser.add_argument("--once", action="store_true", help="run one scan and exit")
    args = parser.parse_args()
    guard = McpLeakGuard()
    if not args.enforce:
        print(json.dumps(guard.run_once(enforce=False), ensure_ascii=False, indent=2))
        return 0
    mutex = WindowsNamedMutex()
    if not mutex.acquire():
        return 0
    try:
        while True:
            try:
                report = guard.run_once(enforce=True)
                if args.once:
                    print(json.dumps(report, ensure_ascii=False, indent=2))
                    return 0
            except Exception:
                guard.logger.exception("event=scan_failed")
                if args.once:
                    return 1
            time.sleep(POLL_SECONDS)
    finally:
        mutex.release()


if __name__ == "__main__":
    raise SystemExit(main())
