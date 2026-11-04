import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditCodexPlusPlusIsolation } from "../../scripts/lib/codexplusplus-isolation-audit.mjs";

const FILES = {
  "apps/codex-plus-launcher/src/main.rs": "--app-path resolve_app_dir(options.app_dir.as_deref() find_codex_processes_for_app_path validate_isolated_app_path isolated_instance_mode",
  "apps/codex-plus-manager/src-tauri/src/commands.rs": "stop_launcher_processes_and_wait_for_path stop_codex_processes_and_wait_for_app_path validate_isolated_launch_app_path",
  "apps/codex-plus-manager/src-tauri/src/lib.rs": "same_windows_executable_path std::env::current_exe() process.executable_path",
  "apps/codex-plus-manager/src-tauri/src/auto_takeover.rs": "protocol_proxy::protocol_proxy_port()",
  "crates/codex-plus-core/src/app_paths.rs": "CODEX_PLUS_APP_EXECUTABLE configured_codex_executable explicit_codex_executable canonical_executable.parent() Some(explicit_codex_executable(app_dir, value).unwrap_or_default())",
  "crates/codex-plus-core/src/codex_home.rs": "std::env::var_os(\"CODEX_HOME\")",
  "crates/codex-plus-core/src/launcher.rs": "Command::new(executable).spawn() find_codex_processes_for_app_path",
  "crates/codex-plus-core/src/paths.rs": "std::env::var_os(\"CODEX_PLUS_STATE_DIR\")",
  "crates/codex-plus-core/src/protocol_proxy.rs": "std::env::var(\"CODEX_PLUS_PROTOCOL_PROXY_PORT\")",
  "crates/codex-plus-core/src/relay_config.rs": "protocol_proxy::protocol_proxy_port()",
  "crates/codex-plus-core/src/ports.rs": "CODEX_PLUS_LAUNCHER_GUARD_PORT",
  "crates/codex-plus-core/src/watcher.rs": "find_codex_processes_for_app_path find_codex_processes_from_snapshot_for_executable target_app_path build_codex_executable(target_app_path) isolated_instance_watcher_disabled",
  "crates/codex-plus-core/src/windows_integration.rs": "",
};

const MODERN_FILES = {
  "apps/codex-plus-launcher/Cargo.toml": `[[bin]]
name = "codex-plus-plus"
path = "src/anticodex-helper.rs"
`,
  "apps/codex-plus-launcher/src/anticodex-helper.rs": `
    fn parse_args(args: Args) { match arg { "--helper-only" => result.helper_only = true, "--app-path" => { result.app_dir = Some(PathBuf::from(next)); }, "--helper-port" => { result.helper_port_explicit = true; } } if result.helper_only == result.app_dir.is_some() { return Err(error); } }
    fn validate_helper_port_for_isolation(args: &Arguments, isolated: bool) { if isolated && args.helper_only && !args.helper_port_explicit { return Err(error); } Ok(()) }
    fn run() { let args = parse_args(args)?; let isolated = validate_isolated_environment()?; validate_helper_port_for_isolation(&args, isolated).map_err(error)?; if args.helper_only { resident_helper::ensure_resident_helper(args.helper_port)?; } else { validate_isolated_protocol_proxy_port(true)?; codex_plus_launcher::start(options)?; } }
  `,
  "apps/codex-plus-manager/src-tauri/src/main.rs": `
    fn main() { if let Err(error) = codex_plus_core::paths::validate_isolated_protocol_proxy_port(true) { std::process::exit(1); } codex_plus_manager_lib::run(); }
  `,
  "crates/codex-plus-core/src/paths.rs": `
    std::env::var_os("CODEX_PLUS_STATE_DIR")
    fn validate_isolated_environment() { validate_protocol_proxy_port_value(true, std::env::var_os("CODEX_PLUS_PROTOCOL_PROXY_PORT").as_deref(), false)?; }
    fn validate_protocol_proxy_port_value(isolated: bool, value: Option<&OsStr>, required: bool) { if !isolated || (value.is_none() && !required) { return Ok(()); } anyhow::ensure!(value.and_then(|value| value.trim().parse::<u16>().ok()).is_some_and(|port| port != 0), "invalid"); }
    fn validate_isolated_protocol_proxy_port(required: bool) { validate_protocol_proxy_port_value(validate_isolated_environment()?, std::env::var_os("CODEX_PLUS_PROTOCOL_PROXY_PORT").as_deref(), required) }
  `,
  "apps/codex-plus-launcher/src/main.rs": `
    pub fn start(options: LaunchOptions) { validate_isolated_app_path(options.app_dir.as_deref())?; send_runtime_command(|reply| RuntimeCommand::Start(options, reply)); }
    pub fn stop() { send_runtime_command(RuntimeCommand::Stop) }
    async fn runtime_commands() { match command { Some(RuntimeCommand::Stop(reply)) => { let result = match session.take() { Some(current) => current.stop().await, None => Ok(()) }; } } }
    fn validate_isolated_app_path(path: Option<&Path>) { if isolated_instance_mode() { let app = path.ok_or_else(error)?; validate_isolated_copied_app_dir(app)?; } }
    async fn activate_existing_codex_app(options: &LaunchOptions) { validate_isolated_app_path(options.app_dir.as_deref())?; let process_ids = if isolated_instance_mode() { find_codex_processes_for_app_path(&app_dir)? } else { find_codex_processes() }; }
    async fn launcher_session(options: LaunchOptions) { launch_and_inject_with_hooks(options, hooks).await?; }
  `,
  "apps/codex-plus-manager/src-tauri/src/commands.rs": `
    fn default_helper_port() -> u16 { codex_plus_core::protocol_proxy::protocol_proxy_port() }
    fn default_dream_skin_helper_port() -> u16 { codex_plus_core::protocol_proxy::protocol_proxy_port() }
    fn validate_isolated_launch_app_path(request: &LaunchRequest) { let Some(expected) = isolated_app_path()? else { return Ok(None) }; let raw = request.app_path.trim(); anyhow::ensure!(!raw.is_empty(), "required"); validate_isolated_copied_app_dir(&path)?; Ok(Some(path)) }
    fn start_embedded_launcher_with(request: &LaunchRequest) { let isolated = validate_isolated_launch_app_path(request)?.is_some(); codex_plus_launcher::start(LaunchOptions { app_dir: (!request.app_path.trim().is_empty()).then(|| PathBuf::from(request.app_path.trim())), replace_blocking_main_instance: replace_blocking_main_instance && !isolated }) }
    fn restart_codex_plus_blocking(request: LaunchRequest) { let target_app_path = validate_isolated_launch_app_path(&request); stop_codex_plus_for_restart(|| stop_main_codex_process(request.debug_port, target_app_path.as_deref()), codex_plus_launcher::stop, wait); }
    fn stop_codex_plus_blocking(request: LaunchRequest) { let target_app_path = validate_isolated_launch_app_path(&request); stop_codex_plus_for_restart(|| stop_main_codex_process(request.debug_port, target_app_path.as_deref()), codex_plus_launcher::stop, wait); }
    fn stop_main_codex_process(port: u16, isolated_app_path: Option<&Path>) { if let Some(path) = isolated_app_path { stop_codex_processes_and_wait_for_app_path(path)?; return Ok(()); } stop_codex_processes_for_debug_port_with_fallback(port, true); }
  `,
  "apps/codex-plus-manager/src-tauri/src/lib.rs": `
    pub fn focus_existing_manager_window() { let current_executable = std::env::current_exe().ok(); for process in windows_enumerate_processes() { if names.iter().any(|name| process.exe_file.eq_ignore_ascii_case(name)) && current_executable.as_deref().is_some_and(|current| process.executable_path.as_deref().is_some_and(|path| same_windows_executable_path(path, current))) && windows_activate_process_window(process.process_id) {} } }
    fn same_windows_executable_path(left: &Path, right: &Path) { let normalize = |path: &Path| path.to_string_lossy().to_ascii_lowercase(); normalize(left) == normalize(right) }
  `,
  "apps/codex-plus-manager/src-tauri/src/auto_takeover.rs": `
    fn spawn_takeover(port: u16) { let helper_port = select_platform_loopback_port(codex_plus_core::protocol_proxy::protocol_proxy_port()); }
  `,
  "crates/codex-plus-core/src/app_paths.rs": `
    const APP_EXECUTABLE_ENV: &str = "CODEX_PLUS_APP_EXECUTABLE";
    fn explicit_codex_executable(app_dir: &Path, value: OsString) { if !executable.is_absolute() || !executable.is_file() { return None; } let canonical_app_dir = canonicalize(app_dir)?; let canonical_executable = canonicalize(&executable)?; (canonical_executable.parent() == Some(canonical_app_dir.as_path())).then_some(executable) }
    fn configured_codex_executable_from_value(app_dir: &Path, value: Option<OsString>) { let value = value?; Some(explicit_codex_executable(app_dir, value).unwrap_or_default()) }
    pub fn configured_codex_executable(app_dir: &Path) { configured_codex_executable_from_value(app_dir, var_os(APP_EXECUTABLE_ENV)) }
    pub fn build_codex_executable(app_dir: &Path) { if let Some(executable) = configured_codex_executable(app_dir) { return executable; } if let Some(executable) = executable_in_dir(app_dir) { return executable; } }
    pub fn validate_isolated_copied_app_dir(app_dir: &Path) { validate_isolated_copied_app_dir_against(app_dir, &executable) }
    fn validate_isolated_copied_app_dir_against(app_dir: &Path, configured_executable: &Path) { if !configured_executable.file_name().is_some_and(|name| name.eq_ignore_ascii_case("Anti-Codex.exe")) { bail(); } if !exact_app_path_matches(app_dir, configured_app_dir) { bail(); } reject_symlink_components(app_dir)?; reject_symlink_components(configured_executable)?; }
  `,
  "crates/codex-plus-core/src/launcher.rs": `
    impl Default for LaunchOptions {
      fn default() -> Self { Self { helper_port: crate::protocol_proxy::protocol_proxy_port() } }
    }
    pub async fn launch_and_inject_with_hooks(options: LaunchOptions) { let isolated = validate_isolated_environment()?; if isolated { validate_isolated_protocol_proxy_port(true)?; let path = options.app_dir.as_deref().ok_or(error)?; validate_isolated_copied_app_dir(path)?; } let app_dir = hooks.resolve_app_dir(options.app_dir.as_deref(), &settings)?; if isolated && !can_bind(debug_port) { find_codex_processes_for_app_path_and_debug_port(&app_dir, debug_port)?; } hooks.launch_codex().await?; if isolated { loop { if !find_codex_processes_for_app_path_and_debug_port(&app_dir, debug_port)?.is_empty() { break; } } } hooks.ensure_injection(debug_port).await; Command::new(executable).spawn(); }
  `,
  "crates/codex-plus-core/src/watcher.rs": `
    pub fn isolated_instance_watcher_disabled() {}
    fn same_isolated_executable(left: &Path, right: &Path) { let normalize = |path: &Path| path.to_string_lossy().to_ascii_lowercase(); normalize(left) == normalize(right) }
    fn ensure_isolated_processes_visible(processes: &[Process], executable: &Path) { let name = executable.file_name(); anyhow::ensure!(!processes.iter().any(|p| p.exe_file.eq_ignore_ascii_case(&name) && p.executable_path.is_none()), "unidentified"); }
    fn find_isolated_processes_from_snapshot(processes: &[Process], executable: &Path) { processes.iter().filter(|process| process.executable_path.as_deref().is_some_and(|path| same_isolated_executable(path, executable))).map(|process| process.process_id).collect() }
    pub fn find_codex_processes_for_app_path(target_app_path: &Path) { validate_isolated_copied_app_dir(target_app_path)?; let executable = build_codex_executable(target_app_path); ensure_isolated_processes_visible(&snapshot, &executable)?; Ok(find_isolated_processes_from_snapshot(&snapshot, &executable)) }
    pub fn find_codex_processes_for_app_path_and_debug_port(target_app_path: &Path, debug_port: u16) { validate_isolated_copied_app_dir(target_app_path)?; let executable = build_codex_executable(target_app_path); let Some(owner) = capture_debug_listener(debug_port, &executable)? else { anyhow::ensure!(loopback_listener_process_ids(debug_port)?.is_empty(), "wrong owner"); return Ok(Vec::new()); }; if owner.is_alive()? { Ok(vec![owner.process_id]) } else { Ok(Vec::new()) } }
    pub fn stop_codex_processes_and_wait_for_app_path(target_app_path: &Path) { validate_isolated_copied_app_dir(target_app_path)?; let executable = build_codex_executable(target_app_path); ensure_isolated_processes_visible(&snapshot, &executable)?; if !process.executable_path.as_deref().is_some_and(|path| same_isolated_executable(path, &executable)) { continue; } let handle = VerifiedStopProcess::capture(pid, true)?; if !same_isolated_executable(&handle.image()?, &executable) { continue; } handle.terminate()?; handle.is_alive()?; }
  `,
  "crates/codex-plus-core/src/windows_integration.rs": `
    pub fn capture_debug_listener(port: u16, executable: &Path) { let Some(pid) = unique_listener_process_id(&loopback_listener_process_ids(port)?)? else { return Ok(None); }; let Some(process) = TrackedWindowsProcess::capture(pid, executable)? else { return Ok(None); }; if unique_listener_process_id(&loopback_listener_process_ids(port)?)? != Some(pid) { return Ok(None); } Ok(Some(process)) }
    impl TrackedWindowsProcess {
      pub fn capture(pid: u32, expected_executable: &Path) { let handle = OwnedHandle::from_raw_handle(native.0); QueryFullProcessImageNameW(native_handle, args); if normalize(&actual) != normalize(&expected) { return Ok(None); } GetProcessTimes(native_handle, args); Ok(Some(Self { handle })) }
    }
  `,
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "scripts", "test-codexplusplus-isolation-compatibility.mjs");

async function writeFixture(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexplusplus-isolation-audit-"));
  for (const [relativePath, contents] of Object.entries({ ...FILES, ...overrides })) {
    const filePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");
  }
  return root;
}

test("accepts a CodexPlusPlus tree with independently configurable state, ports and process scope", async (t) => {
  const root = await writeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await auditCodexPlusPlusIsolation(root);

  assert.equal(result.compatibilityReady, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.checks.every((check) => check.ok), true);
});

test("accepts the 2.2 typed launcher with exact copied-process checks", async (t) => {
  const root = await writeFixture(MODERN_FILES);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await auditCodexPlusPlusIsolation(root);
  assert.equal(result.compatibilityReady, true, JSON.stringify(result.blockers));
});

test("modern audit rejects a missing or unguarded actual launcher binary", async (t) => {
  const cargo = "apps/codex-plus-launcher/Cargo.toml";
  const helper = "apps/codex-plus-launcher/src/anticodex-helper.rs";
  for (const changes of [
    { [cargo]: MODERN_FILES[cargo].replace('name = "codex-plus-plus"', 'name = "unused"') },
    { [helper]: MODERN_FILES[helper].replace("validate_isolated_environment()?;", "/* validate_isolated_environment()?; */") },
    { [helper]: MODERN_FILES[helper].replace("if isolated && args.helper_only && !args.helper_port_explicit { return Err(error); }", "/* if isolated && args.helper_only && !args.helper_port_explicit { return Err(error); } */") },
    { [helper]: MODERN_FILES[helper].replace("validate_isolated_protocol_proxy_port(true)?;", "/* validate_isolated_protocol_proxy_port(true)?; */") },
    { [helper]: MODERN_FILES[helper].replace("ensure_resident_helper(args.helper_port)?;", "return Ok(());") },
  ]) {
    const root = await writeFixture({ ...MODERN_FILES, ...changes });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await auditCodexPlusPlusIsolation(root);
    assert.ok(result.blockers.some((blocker) => blocker.id === "alternate_app_path"));
  }
});

test("modern audit rejects isolation port guards that are bypassed at real entry points", async (t) => {
  const manager = "apps/codex-plus-manager/src-tauri/src/main.rs";
  const launcher = "crates/codex-plus-core/src/launcher.rs";
  const paths = "crates/codex-plus-core/src/paths.rs";
  for (const changes of [
    { [manager]: MODERN_FILES[manager].replace("std::process::exit(1);", "/* std::process::exit(1); */") },
    { [launcher]: MODERN_FILES[launcher].replace("validate_isolated_protocol_proxy_port(true)?;", "/* validate_isolated_protocol_proxy_port(true)?; */") },
    { [paths]: MODERN_FILES[paths].replace("validate_protocol_proxy_port_value(true, std::env::var_os(\"CODEX_PLUS_PROTOCOL_PROXY_PORT\").as_deref(), false)?;", "return Ok(true);") },
  ]) {
    const root = await writeFixture({ ...MODERN_FILES, ...changes });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await auditCodexPlusPlusIsolation(root);
    assert.ok(result.blockers.some((blocker) => blocker.id === "isolated_protocol_proxy_consumers"));
  }
});

test("new proof files are required for current layouts without breaking legacy layouts", async (t) => {
  const optional = [
    "apps/codex-plus-manager/src-tauri/src/auto_takeover.rs",
    "crates/codex-plus-core/src/windows_integration.rs",
  ];
  const legacy = await writeFixture();
  const current = await writeFixture(MODERN_FILES);
  t.after(() => Promise.all([fs.rm(legacy, { recursive: true, force: true }), fs.rm(current, { recursive: true, force: true })]));
  for (const relative of optional) {
    await fs.rm(path.join(legacy, relative));
    await fs.rm(path.join(current, relative));
  }
  assert.equal((await auditCodexPlusPlusIsolation(legacy)).compatibilityReady, true);
  const blockers = (await auditCodexPlusPlusIsolation(current)).blockers.map(({ id }) => id);
  assert.ok(blockers.includes("isolated_protocol_proxy_consumers"));
  assert.ok(blockers.includes("target_scoped_process_watcher"));
});

test("rejects commented-out validation and reordered executable fallback", async (t) => {
  const cases = [
    {
      id: "alternate_app_path",
      files: { ...MODERN_FILES, "apps/codex-plus-launcher/src/main.rs": MODERN_FILES["apps/codex-plus-launcher/src/main.rs"].replace(
        "validate_isolated_app_path(options.app_dir.as_deref())?; send_runtime_command(|reply| RuntimeCommand::Start(options, reply))",
        "/* validate_isolated_app_path(options.app_dir.as_deref())?; */ send_runtime_command(|reply| RuntimeCommand::Start(options, reply))",
      ) },
    },
    {
      id: "alternate_app_path",
      files: { ...MODERN_FILES, "apps/codex-plus-launcher/src/main.rs": MODERN_FILES["apps/codex-plus-launcher/src/main.rs"].replace(
        "validate_isolated_app_path(options.app_dir.as_deref())?; send_runtime_command(|reply| RuntimeCommand::Start(options, reply))",
        "let _ = \"validate_isolated_app_path(options.app_dir.as_deref())?\"; send_runtime_command(|reply| RuntimeCommand::Start(options, reply))",
      ) },
    },
    {
      id: "alternate_app_path",
      files: { ...MODERN_FILES, "apps/codex-plus-launcher/src/main.rs": MODERN_FILES["apps/codex-plus-launcher/src/main.rs"].replace(
        "if isolated_instance_mode() { let app = path.ok_or_else(error)?;",
        "if false && isolated_instance_mode() { let app = path.ok_or_else(error)?;",
      ) },
    },
    {
      id: "explicit_copied_executable",
      files: { ...MODERN_FILES, "crates/codex-plus-core/src/app_paths.rs": MODERN_FILES["crates/codex-plus-core/src/app_paths.rs"].replace(
        "if let Some(executable) = configured_codex_executable(app_dir) { return executable; } if let Some(executable) = executable_in_dir(app_dir) { return executable; }",
        "if let Some(executable) = executable_in_dir(app_dir) { return executable; } if let Some(executable) = configured_codex_executable(app_dir) { return executable; }",
      ) },
    },
  ];
  for (const item of cases) {
    const root = await writeFixture(item.files);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await auditCodexPlusPlusIsolation(root);
    assert.ok(result.blockers.some((blocker) => blocker.id === item.id), item.id);
  }
});

test("rejects a permissive snapshot selector or an unscoped stop branch", async (t) => {
  const cases = [
    {
      id: "explicit_copied_executable",
      files: { ...MODERN_FILES, "crates/codex-plus-core/src/watcher.rs": MODERN_FILES["crates/codex-plus-core/src/watcher.rs"].replace(
        "same_isolated_executable(path, executable)", "true /* same_isolated_executable(path, executable) */",
      ) },
    },
    {
      id: "target_scoped_process_watcher",
      files: { ...MODERN_FILES, "apps/codex-plus-manager/src-tauri/src/commands.rs": MODERN_FILES["apps/codex-plus-manager/src-tauri/src/commands.rs"].replace(
        "if let Some(path) = isolated_app_path { stop_codex_processes_and_wait_for_app_path(path)?; return Ok(()); }",
        "if false { stop_codex_processes_and_wait_for_app_path(path)?; return Ok(()); }",
      ) },
    },
  ];
  for (const item of cases) {
    const root = await writeFixture(item.files);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await auditCodexPlusPlusIsolation(root);
    assert.ok(result.blockers.some((blocker) => blocker.id === item.id), item.id);
  }
});

test("rejects dead safe helpers and debug-port checks hidden in comments", async (t) => {
  const cases = [
    {
      id: "explicit_copied_executable",
      files: { ...MODERN_FILES, "crates/codex-plus-core/src/watcher.rs": MODERN_FILES["crates/codex-plus-core/src/watcher.rs"].replace(
        "Ok(find_isolated_processes_from_snapshot(&snapshot, &executable))",
        "let _unused = find_isolated_processes_from_snapshot(&snapshot, &executable); Ok(find_codex_processes())",
      ) },
    },
    {
      id: "target_scoped_process_watcher",
      files: { ...MODERN_FILES, "crates/codex-plus-core/src/launcher.rs": MODERN_FILES["crates/codex-plus-core/src/launcher.rs"].replace(
        "if isolated { loop { if !find_codex_processes_for_app_path_and_debug_port(&app_dir, debug_port)?.is_empty() { break; } } }",
        "/* if isolated { loop { if !find_codex_processes_for_app_path_and_debug_port(&app_dir, debug_port)?.is_empty() { break; } } } */",
      ) },
    },
  ];
  for (const item of cases) {
    const root = await writeFixture(item.files);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await auditCodexPlusPlusIsolation(root);
    assert.ok(result.blockers.some((blocker) => blocker.id === item.id), item.id);
  }
});

test("rejects missing process visibility, unsafe stop and cross-installation focus", async (t) => {
  const cases = [
    {
      id: "target_scoped_process_watcher",
      files: { ...MODERN_FILES, "crates/codex-plus-core/src/watcher.rs": MODERN_FILES["crates/codex-plus-core/src/watcher.rs"].replace(
        "anyhow::ensure!(!processes.iter().any(|p| p.exe_file.eq_ignore_ascii_case(&name) && p.executable_path.is_none()), \"unidentified\");",
        "Ok(()) /* executable_path.is_none() */;",
      ) },
    },
    {
      id: "target_scoped_process_watcher",
      files: { ...MODERN_FILES, "crates/codex-plus-core/src/watcher.rs": MODERN_FILES["crates/codex-plus-core/src/watcher.rs"].replace(
        "if !same_isolated_executable(&handle.image()?, &executable) { continue; }",
        "if !same_isolated_executable(&handle.image()?, &executable) { /* continue; */ }",
      ) },
    },
    {
      id: "target_scoped_process_watcher",
      files: { ...MODERN_FILES, "apps/codex-plus-manager/src-tauri/src/lib.rs": MODERN_FILES["apps/codex-plus-manager/src-tauri/src/lib.rs"].replace(
        "))) && windows_activate_process_window", "))) || windows_activate_process_window",
      ) },
    },
    {
      id: "target_scoped_process_watcher",
      files: { ...MODERN_FILES, "apps/codex-plus-manager/src-tauri/src/lib.rs": MODERN_FILES["apps/codex-plus-manager/src-tauri/src/lib.rs"].replace(
        "&& current_executable.as_deref()", "|| current_executable.as_deref()",
      ) },
    },
  ];
  for (const item of cases) {
    const root = await writeFixture(item.files);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await auditCodexPlusPlusIsolation(root);
    assert.ok(result.blockers.some((blocker) => blocker.id === item.id), item.id);
  }
});

test("rejects debug listeners that are not revalidated against the copied executable", async (t) => {
  const name = "crates/codex-plus-core/src/windows_integration.rs";
  const root = await writeFixture({ ...MODERN_FILES, [name]: MODERN_FILES[name].replace(
    "if unique_listener_process_id(&loopback_listener_process_ids(port)?)? != Some(pid) { return Ok(None); }",
    "/* if unique_listener_process_id(&loopback_listener_process_ids(port)?)? != Some(pid) { return Ok(None); } */",
  ) });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await auditCodexPlusPlusIsolation(root);
  assert.ok(result.blockers.some((blocker) => blocker.id === "target_scoped_process_watcher"));
});

test("current layout cannot bypass scoped checks with legacy marker comments", async (t) => {
  const watcher = "crates/codex-plus-core/src/watcher.rs";
  const manager = "apps/codex-plus-manager/src-tauri/src/commands.rs";
  const root = await writeFixture({
    ...MODERN_FILES,
    [watcher]: MODERN_FILES[watcher].replace("fn find_isolated_processes_from_snapshot", "fn removed_snapshot")
      + "\n// find_codex_processes_from_snapshot_for_executable build_codex_executable(target_app_path)",
    [manager]: MODERN_FILES[manager].replace("fn stop_main_codex_process", "fn removed_stop")
      + "\n// stop_launcher_processes_and_wait_for_path stop_codex_processes_and_wait_for_app_path",
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await auditCodexPlusPlusIsolation(root);
  assert.ok(result.blockers.some((blocker) => blocker.id === "target_scoped_process_watcher"));
});

test("rejects fixed ports in current launcher defaults or takeover consumers", async (t) => {
  for (const name of ["crates/codex-plus-core/src/launcher.rs", "apps/codex-plus-manager/src-tauri/src/auto_takeover.rs"]) {
    const root = await writeFixture({ ...MODERN_FILES, [name]: MODERN_FILES[name].replace("protocol_proxy::protocol_proxy_port()", "57321") });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await auditCodexPlusPlusIsolation(root);
    assert.ok(result.blockers.some((blocker) => blocker.id === "isolated_protocol_proxy_consumers"), name);
  }
  const launcher = "crates/codex-plus-core/src/launcher.rs";
  const decoy = `fn default() -> Self { Self { helper_port: crate::protocol_proxy::protocol_proxy_port() } }\n${MODERN_FILES[launcher].replace("helper_port: crate::protocol_proxy::protocol_proxy_port()", "helper_port: 57321")}`;
  const root = await writeFixture({ ...MODERN_FILES, [launcher]: decoy });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await auditCodexPlusPlusIsolation(root);
  assert.ok(result.blockers.some((blocker) => blocker.id === "isolated_protocol_proxy_consumers"));
});

test("rejects runtime protocol-proxy consumers that bypass the isolated port", async (t) => {
  const root = await writeFixture({
    "apps/codex-plus-manager/src-tauri/src/lib.rs":
      `${FILES["apps/codex-plus-manager/src-tauri/src/lib.rs"]} protocol_proxy::DEFAULT_PROTOCOL_PROXY_PORT`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await auditCodexPlusPlusIsolation(root);

  assert.equal(result.compatibilityReady, false);
  assert.equal(
    result.blockers.some((blocker) => blocker.id === "isolated_protocol_proxy_consumers"),
    true,
  );
});

test("rejects a hard-coded serde helper-port default", async (t) => {
  const root = await writeFixture({
    "apps/codex-plus-manager/src-tauri/src/commands.rs":
      `${FILES["apps/codex-plus-manager/src-tauri/src/commands.rs"]}\nfn default_helper_port() -> u16 { 57321 }`,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await auditCodexPlusPlusIsolation(root);

  assert.equal(result.compatibilityReady, false);
  assert.equal(
    result.blockers.some((blocker) => blocker.id === "isolated_protocol_proxy_consumers"),
    true,
  );
});

test("reports the exact upstream isolation gaps without hiding reusable capabilities", async (t) => {
  const root = await writeFixture({
    "crates/codex-plus-core/src/app_paths.rs": "ChatGPT.exe Codex.exe",
    "crates/codex-plus-core/src/paths.rs": "home_dir.join(\".codex-session-delete\")",
    "crates/codex-plus-core/src/protocol_proxy.rs": "pub const DEFAULT_PROTOCOL_PROXY_PORT: u16 = 57321;",
    "crates/codex-plus-core/src/watcher.rs": "if process.exe_file == \"Codex.exe\" { ids.push(process.process_id); }",
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await auditCodexPlusPlusIsolation(root);

  assert.equal(result.compatibilityReady, false);
  assert.deepEqual(
    result.blockers.map((blocker) => blocker.id),
    [
      "explicit_copied_executable",
      "isolated_state_dir",
      "isolated_protocol_proxy_port",
      "target_scoped_process_watcher",
      "isolated_watcher_registration",
    ],
  );
  assert.deepEqual(
    result.checks.filter((check) => check.ok).map((check) => check.id),
    [
      "alternate_app_path",
      "isolated_codex_home",
      "inherited_child_environment",
      "isolated_guard_port",
      "isolated_protocol_proxy_consumers",
    ],
  );
});

test("rejects copied application selection that can silently fall back to ChatGPT.exe", async (t) => {
  const root = await writeFixture({
    "crates/codex-plus-core/src/app_paths.rs": "ChatGPT.exe Codex.exe",
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await auditCodexPlusPlusIsolation(root);

  assert.equal(result.compatibilityReady, false);
  assert.equal(
    result.blockers.some((blocker) => blocker.id === "explicit_copied_executable"),
    true,
  );
});

test("rejects a dormant scoped watcher helper when active launcher and manager calls remain global", async (t) => {
  const root = await writeFixture({
    "apps/codex-plus-launcher/src/main.rs": "--app-path resolve_app_dir(options.app_dir.as_deref() find_codex_processes()",
    "apps/codex-plus-manager/src-tauri/src/commands.rs": "stop_launcher_processes_and_wait stop_codex_processes_and_wait",
    "crates/codex-plus-core/src/launcher.rs": "Command::new(executable).spawn() find_codex_processes()",
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await auditCodexPlusPlusIsolation(root);

  assert.equal(result.compatibilityReady, false);
  assert.equal(
    result.blockers.some((blocker) => blocker.id === "target_scoped_process_watcher"),
    true,
  );
});

test("rejects isolated launch fallback and cross-installation manager activation", async (t) => {
  const root = await writeFixture({
    "apps/codex-plus-launcher/src/main.rs": "--app-path resolve_app_dir(options.app_dir.as_deref() find_codex_processes_for_app_path",
    "apps/codex-plus-manager/src-tauri/src/commands.rs": "stop_launcher_processes_and_wait_for_path stop_codex_processes_and_wait_for_app_path",
    "apps/codex-plus-manager/src-tauri/src/lib.rs": "focus_existing_manager_window windows_enumerate_processes",
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await auditCodexPlusPlusIsolation(root);

  assert.equal(result.compatibilityReady, false);
  assert.equal(
    result.blockers.some((blocker) => blocker.id === "target_scoped_process_watcher"),
    true,
  );
});

test("rejects isolated builds that can still register a global logon watcher", async (t) => {
  const root = await writeFixture({
    "crates/codex-plus-core/src/watcher.rs": "find_codex_processes_for_app_path target_app_path install_watcher uninstall_watcher",
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await auditCodexPlusPlusIsolation(root);

  assert.equal(result.compatibilityReady, false);
  assert.equal(
    result.blockers.some((blocker) => blocker.id === "isolated_watcher_registration"),
    true,
  );
});

test("CLI returns success only for an isolation-compatible source tree", async (t) => {
  const compatibleRoot = await writeFixture();
  const incompatibleRoot = await writeFixture({
    "crates/codex-plus-core/src/paths.rs": "home_dir.join(\".codex-session-delete\")",
  });
  t.after(() => Promise.all([
    fs.rm(compatibleRoot, { recursive: true, force: true }),
    fs.rm(incompatibleRoot, { recursive: true, force: true }),
  ]));

  const compatible = spawnSync(process.execPath, [cliPath, "--source", compatibleRoot, "--compact"], {
    encoding: "utf8",
  });
  const incompatible = spawnSync(process.execPath, [cliPath, "--source", incompatibleRoot, "--compact"], {
    encoding: "utf8",
  });

  assert.equal(compatible.status, 0, compatible.stderr);
  assert.equal(JSON.parse(compatible.stdout).compatibilityReady, true);
  assert.equal(incompatible.status, 1, incompatible.stderr);
  assert.equal(JSON.parse(incompatible.stdout).compatibilityReady, false);
});
