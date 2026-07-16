import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts", "test-codexplusplus-runtime-isolation.ps1");

async function source() {
  return fs.readFile(scriptPath, "utf8");
}

test("runtime isolation probe injects every state and port override into the child only", async () => {
  const text = await source();

  for (const name of [
    "CODEX_PLUS_STATE_DIR",
    "CODEX_PLUS_APP_EXECUTABLE",
    "CODEX_PLUS_PROTOCOL_PROXY_PORT",
    "CODEX_PLUS_LAUNCHER_GUARD_PORT",
    "CODEX_PLUS_MANAGER_GUARD_PORT",
    "CODEX_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "--user-data-dir",
  ]) {
    assert.match(text, new RegExp(name.replaceAll("-", "\\-")), name);
  }
  assert.match(text, /ProcessStartInfo/);
  assert.match(text, /PreflightOnly/);
  assert.doesNotMatch(text, /SetEnvironmentVariable\s*\(/i);
});

test("runtime isolation probe verifies real process ownership and fails closed", async () => {
  const text = await source();

  for (const token of [
    "invalid_executable_rejected",
    "candidate_process_exact_path",
    "candidate_parent_is_launcher",
    "original_processes_unchanged",
    "existing_anticodex_processes_unchanged",
    "isolated_status_path",
    "global_watcher_unchanged",
    "test_processes_cleaned",
  ]) {
    assert.match(text, new RegExp(token), token);
  }
});

test("runtime isolation probe never reads or hashes Codex credentials", async () => {
  const text = await source();

  assert.match(text, /auth\.json/i);
  assert.match(text, /MetadataOnly/);
  assert.doesNotMatch(text, /Get-Content[^\r\n]*auth\.json/i);
  assert.doesNotMatch(text, /Get-FileHash[^\r\n]*auth\.json/i);
});
