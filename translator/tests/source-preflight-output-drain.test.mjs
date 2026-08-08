import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("source preflight drains redirected process output before reading report tails", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-source-preflight.ps1", import.meta.url), "utf8");
  const waitForExit = source.indexOf("$process.WaitForExit()", source.indexOf("function Invoke-SourceProcess"));
  const readStdout = source.indexOf("$stdout = Read-TextSafe $stdoutPath", source.indexOf("function Invoke-SourceProcess"));

  assert.ok(waitForExit >= 0, "external process output is not drained");
  assert.ok(readStdout > waitForExit, "redirected output is read before WaitForExit drains it");
});

test("source preflight keeps translator test concurrency below the Windows process-init failure threshold", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-source-preflight.ps1", import.meta.url), "utf8");

  assert.match(source, /@\("--test",\s*"--test-concurrency=2"\)\s*\+\s*\$testFiles/);
});

test("source preflight leaves patch-format whitespace to hash and replay verification", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-source-preflight.ps1", import.meta.url), "utf8");

  assert.match(source, /diff", "--check", "--", "\.", ":\(exclude\)third_party\/codexplusplus\/patches\/\*\.patch"/);
});

test("installed runtime preflight requires a complete manifest bound to a clean Git revision", async () => {
  const [preflight, runtimeSync] = await Promise.all([
    readFile(new URL("../../scripts/test-anticodex-source-preflight.ps1", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/sync-anticodex-runtime.ps1", import.meta.url), "utf8"),
  ]);

  assert.match(runtimeSync, /sourceGitHead\s*=/);
  assert.match(runtimeSync, /sourceGitClean\s*=/);
  assert.match(runtimeSync, /sourceRevisionProvenance\s*=/);
  assert.match(runtimeSync, /rev-parse --show-toplevel/);
  assert.match(runtimeSync, /source revision changed or became dirty/);
  assert.match(preflight, /anticodex-runtime-manifest-v2/);
  assert.match(preflight, /sourceRevisionProvenance/);
  assert.match(preflight, /git rev-parse --show-toplevel/);
  assert.match(preflight, /Get-SourceRuntimeInventory/);
  assert.match(preflight, /verifiedEntryCount/);
});
