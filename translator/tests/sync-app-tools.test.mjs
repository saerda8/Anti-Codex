import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..", "..");
const syncScript = resolve(root, "scripts", "sync-deepcodex-app-tools.mjs");

function tmpDir() {
  return mkdtempSync(resolve(tmpdir(), "anticodex-app-tools-test-"));
}

test("app tools sync records shared and local content fingerprints", () => {
  const tmp = tmpDir();
  const codexHome = resolve(tmp, "codex");
  const sharedHome = resolve(tmp, "shared");
  try {
    mkdirSync(resolve(sharedHome, "cache", "codex_apps_tools", "nested"), { recursive: true });
    writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "tools.json"), JSON.stringify({
      tools: [{ name: "alpha.search", connector_id: "connector.alpha" }],
    }, null, 2));
    writeFileSync(resolve(sharedHome, "cache", "codex_apps_tools", "nested", "tool.json"), JSON.stringify({
      name: "beta.search",
      connector_id: "connector.beta",
    }, null, 2));

    mkdirSync(resolve(sharedHome, ".tmp", "plugins", "plugins", "alpha", ".codex-plugin"), { recursive: true });
    writeFileSync(resolve(sharedHome, ".tmp", "plugins", "plugins", "alpha", ".app.json"), JSON.stringify({
      apps: { "alpha-app": { id: "connector.alpha" } },
    }));
    writeFileSync(resolve(sharedHome, ".tmp", "plugins", "plugins", "alpha", ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "Alpha",
      marketplace: "local",
      version: "1.0.0",
    }));

    const result = spawnSync(process.execPath, [syncScript, codexHome, sharedHome], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const registry = JSON.parse(readFileSync(resolve(codexHome, "cache", "deepcodex_app_connectors.json"), "utf8"));
    assert.equal(registry.content_matches, true);
    assert.match(registry.shared_tools_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(registry.local_tools_fingerprint, registry.shared_tools_fingerprint);
    assert.equal(registry.shared_tools_file_count, 2);
    assert.equal(registry.local_tools_file_count, 2);
    assert.deepEqual(registry.synced_tool_cache_files, ["nested", "tools.json"]);
    assert.equal(registry.connectors.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
