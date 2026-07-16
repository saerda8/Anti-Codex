import fs from "node:fs/promises";
import path from "node:path";

const SOURCE_PATHS = {
  launcherMain: "apps/codex-plus-launcher/src/main.rs",
  managerCommands: "apps/codex-plus-manager/src-tauri/src/commands.rs",
  managerLib: "apps/codex-plus-manager/src-tauri/src/lib.rs",
  appPaths: "crates/codex-plus-core/src/app_paths.rs",
  codexHome: "crates/codex-plus-core/src/codex_home.rs",
  launcher: "crates/codex-plus-core/src/launcher.rs",
  paths: "crates/codex-plus-core/src/paths.rs",
  protocolProxy: "crates/codex-plus-core/src/protocol_proxy.rs",
  ports: "crates/codex-plus-core/src/ports.rs",
  watcher: "crates/codex-plus-core/src/watcher.rs",
};

async function readRequiredSource(root, relativePath) {
  try {
    return await fs.readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    throw new Error(`CodexPlusPlus source file missing: ${relativePath}`, { cause: error });
  }
}

function check(id, ok, summary, blocker) {
  return { id, ok, summary, ...(ok || !blocker ? {} : { blocker }) };
}

export async function auditCodexPlusPlusIsolation(root) {
  const source = Object.fromEntries(
    await Promise.all(
      Object.entries(SOURCE_PATHS).map(async ([key, relativePath]) => [
        key,
        await readRequiredSource(root, relativePath),
      ]),
    ),
  );

  const checks = [
    check(
      "alternate_app_path",
      source.launcherMain.includes("--app-path")
        && source.launcherMain.includes("options.app_dir.as_deref()"),
      "Launcher accepts and resolves an explicit copied application path.",
      "The launcher cannot be pinned to the copied Anti-Codex application.",
    ),
    check(
      "explicit_copied_executable",
      source.appPaths.includes("CODEX_PLUS_APP_EXECUTABLE")
        && source.appPaths.includes("configured_codex_executable")
        && source.appPaths.includes("explicit_codex_executable")
        && source.appPaths.includes("canonical_executable.parent()")
        && source.appPaths.includes("Some(explicit_codex_executable(app_dir, value).unwrap_or_default())")
        && source.watcher.includes("find_codex_processes_from_snapshot_for_executable")
        && source.watcher.includes("build_codex_executable(target_app_path)"),
      "The copied application can select its branded executable and scope process discovery to it.",
      "The copied directory can fall back to ChatGPT.exe or share process scope with another executable.",
    ),
    check(
      "isolated_codex_home",
      source.codexHome.includes('var_os("CODEX_HOME")'),
      "Codex configuration and session state can use an explicit CODEX_HOME.",
      "Codex state would fall back to the original user profile.",
    ),
    check(
      "inherited_child_environment",
      source.launcher.includes("Command::new(executable)")
        && source.launcher.includes(".spawn()")
        && !source.launcher.includes(".env_clear()"),
      "The copied application inherits the isolated parent environment.",
      "The launcher clears the environment required for isolated Codex state.",
    ),
    check(
      "isolated_guard_port",
      source.ports.includes("CODEX_PLUS_LAUNCHER_GUARD_PORT"),
      "The launcher single-instance guard port is independently configurable.",
      "The Anti-Codex launcher could collide with another CodexPlusPlus launcher.",
    ),
    check(
      "isolated_state_dir",
      source.paths.includes("CODEX_PLUS_STATE_DIR"),
      "CodexPlusPlus settings, logs and locks have an explicit state root.",
      "CodexPlusPlus state is fixed to the user's shared .codex-session-delete directory.",
    ),
    check(
      "isolated_protocol_proxy_port",
      source.protocolProxy.includes("CODEX_PLUS_PROTOCOL_PROXY_PORT"),
      "The Chat/Responses protocol proxy port is independently configurable.",
      "The protocol proxy is fixed to one process-wide port and cannot coexist independently.",
    ),
    check(
      "target_scoped_process_watcher",
      source.watcher.includes("find_codex_processes_for_app_path")
        && source.watcher.includes("target_app_path")
        && source.launcherMain.includes("find_codex_processes_for_app_path")
        && source.launcherMain.includes("validate_isolated_app_path")
        && source.launcherMain.includes("isolated_instance_mode")
        && source.launcher.includes("find_codex_processes_for_app_path")
        && source.managerCommands.includes("stop_launcher_processes_and_wait_for_path")
        && source.managerCommands.includes("stop_codex_processes_and_wait_for_app_path")
        && source.managerCommands.includes("validate_isolated_launch_app_path")
        && source.managerLib.includes("same_windows_executable_path")
        && source.managerLib.includes("std::env::current_exe()")
        && source.managerLib.includes("process.executable_path"),
      "Process discovery, activation, waiting and restart are scoped to the copied application.",
      "An isolated launcher or manager can still fall back to, activate, inspect, wait for or stop an unrelated Codex path.",
    ),
    check(
      "isolated_watcher_registration",
      source.watcher.includes("isolated_instance_watcher_disabled"),
      "The isolated build refuses global logon-watcher installation and removal.",
      "The isolated build can still modify the shared current-user logon watcher or shortcut.",
    ),
  ];

  const blockers = checks
    .filter((item) => !item.ok)
    .map((item) => ({ id: item.id, message: item.blocker }));

  return {
    compatibilityReady: blockers.length === 0,
    root: path.resolve(root),
    checks,
    blockers,
  };
}
