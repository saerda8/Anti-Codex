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
  "crates/codex-plus-core/src/app_paths.rs": "CODEX_PLUS_APP_EXECUTABLE configured_codex_executable explicit_codex_executable canonical_executable.parent() Some(explicit_codex_executable(app_dir, value).unwrap_or_default())",
  "crates/codex-plus-core/src/codex_home.rs": "std::env::var_os(\"CODEX_HOME\")",
  "crates/codex-plus-core/src/launcher.rs": "Command::new(executable).spawn() find_codex_processes_for_app_path",
  "crates/codex-plus-core/src/paths.rs": "std::env::var_os(\"CODEX_PLUS_STATE_DIR\")",
  "crates/codex-plus-core/src/protocol_proxy.rs": "std::env::var(\"CODEX_PLUS_PROTOCOL_PROXY_PORT\")",
  "crates/codex-plus-core/src/relay_config.rs": "protocol_proxy::protocol_proxy_port()",
  "crates/codex-plus-core/src/ports.rs": "CODEX_PLUS_LAUNCHER_GUARD_PORT",
  "crates/codex-plus-core/src/watcher.rs": "find_codex_processes_for_app_path find_codex_processes_from_snapshot_for_executable target_app_path build_codex_executable(target_app_path) isolated_instance_watcher_disabled",
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
