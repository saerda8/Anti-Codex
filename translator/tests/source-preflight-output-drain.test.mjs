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
