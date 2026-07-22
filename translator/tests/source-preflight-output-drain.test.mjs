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

test("source preflight bounds translator test concurrency on Windows", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-source-preflight.ps1", import.meta.url), "utf8");

  assert.match(source, /@\("--test",\s*"--test-concurrency=4"\)\s*\+\s*\$testFiles/);
});

test("source preflight leaves patch-format whitespace to hash and replay verification", async () => {
  const source = await readFile(new URL("../../scripts/test-anticodex-source-preflight.ps1", import.meta.url), "utf8");

  assert.match(source, /diff", "--check", "--", "\.", ":\(exclude\)third_party\/codexplusplus\/patches\/\*\.patch"/);
});
