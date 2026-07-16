import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../../scripts/test-anticodex-installed-overall.ps1", import.meta.url);

test("installed overall report never equates route readiness with model quota", async () => {
  const source = await readFile(scriptUrl, "utf8");

  assert.doesNotMatch(source, /accountTrafficReady\s*=\s*\$fixedReady/);
  assert.match(source, /\$managerTrafficReady\s*=/);
  assert.match(source, /accountTrafficReady\s*=\s*\$managerTrafficReady/);
  assert.match(source, /accountTrafficSuggestedAction\s*=/);
});
