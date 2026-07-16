import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertVisibleCandidateLaunch,
  archiveDirectory,
  codexPlusPlusLauncherArgs,
  runProcess,
  treeManifest,
} from "../../scripts/lib/codexplusplus-antigravity-harness.mjs";

test("archiveDirectory creates a readable zip from the complete workspace", {
  skip: process.platform !== "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "AntiCodex-Archive-Test-"));
  const destination = `${root}.zip`;
  try {
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, ".evidence.json"), "{}\n", "utf8");
    writeFileSync(join(root, "nested", "result.txt"), "verified\n", "utf8");
    const archive = archiveDirectory(root, destination);
    const listing = spawnSync("tar.exe", ["-tf", destination], { encoding: "utf8", windowsHide: true });
    assert.equal(archive.ok, true);
    assert.equal(existsSync(destination), true);
    assert.ok(archive.bytes > 0);
    assert.equal(listing.status, 0);
    assert.match(listing.stdout, /\.evidence\.json/);
    assert.match(listing.stdout, /nested\/result\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(destination, { force: true });
  }
});

test("launcher arguments keep headless helper-only mode isolated", () => {
  assert.deepEqual(codexPlusPlusLauncherArgs({
    launchDesktop: false,
    candidateAppDir: "C:\\candidate\\codex-patched-app",
    cdpPort: 41001,
    protocolProxyPort: 41002,
  }), ["--helper-only", "--helper-port", "41002"]);
});

test("launcher arguments use the full CodexPlusPlus path for a visible candidate", () => {
  assert.deepEqual(codexPlusPlusLauncherArgs({
    launchDesktop: true,
    candidateAppDir: "C:\\candidate\\codex-patched-app",
    cdpPort: 41001,
    protocolProxyPort: 41002,
  }), [
    "--app-path", "C:\\candidate\\codex-patched-app",
    "--debug-port", "41001",
    "--helper-port", "41002",
  ]);
});

test("visible candidate launch requires approval and no active Anti-Codex root", () => {
  assert.doesNotThrow(() => assertVisibleCandidateLaunch({ launchDesktop: false }));
  assert.throws(
    () => assertVisibleCandidateLaunch({ launchDesktop: true, activeAntiCodexRoots: [] }),
    /explicit approval/i,
  );
  assert.throws(
    () => assertVisibleCandidateLaunch({
      launchDesktop: true,
      approved: true,
      activeAntiCodexRoots: [{ processId: 40148 }],
    }),
    /active PID: 40148/i,
  );
  assert.doesNotThrow(() => assertVisibleCandidateLaunch({
    launchDesktop: true,
    approved: true,
    activeAntiCodexRoots: [],
  }));
});

test("tree manifest preserves nested paths relative to the requested root", () => {
  const root = mkdtempSync(join(tmpdir(), "AntiCodex-Harness-Test-"));
  try {
    mkdirSync(join(root, "event-report", "src"), { recursive: true });
    writeFileSync(join(root, "README.md"), "root\n", "utf8");
    writeFileSync(join(root, "event-report", "src", "cli.mjs"), "export {};\n", "utf8");

    assert.deepEqual(treeManifest(root).map((entry) => entry.path), [
      "event-report/src/cli.mjs",
      "README.md",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runProcess timeout closes inherited pipes and removes descendant processes", {
  skip: process.platform !== "win32",
}, async () => {
  const childScript = [
    'const { spawn } = require("node:child_process");',
    'const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "inherit"] });',
    'console.log(`GRANDCHILD_PID=${grandchild.pid}`);',
    'setTimeout(() => {}, 60000);',
  ].join("\n");
  const startedAt = Date.now();
  const result = await runProcess(process.execPath, ["-e", childScript], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 500,
  });
  const elapsedMs = Date.now() - startedAt;
  const grandchildPid = Number(result.stdout.match(/GRANDCHILD_PID=(\d+)/)?.[1]);

  assert.equal(result.timedOut, true);
  assert.ok(elapsedMs < 8_000, `timed out process settled after ${elapsedMs}ms`);
  assert.ok(Number.isInteger(grandchildPid));
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  assert.throws(() => process.kill(grandchildPid, 0), /ESRCH|not found|no such process/i);
});
