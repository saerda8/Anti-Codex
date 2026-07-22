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

test("installed overall accepts the isolated unified catalog when an unavailable third-party upstream cannot answer models", async () => {
  const source = await readFile(scriptUrl, "utf8");

  assert.match(source, /anticodex-model-catalog\.json/);
  assert.match(source, /\$unifiedCatalogCount\s*-gt\s*0/);
  assert.match(source, /\[int\]\$fixed\.catalogModelCount\s*-eq\s*\$unifiedCatalogCount/);
  assert.match(source, /source\s*=\s*\$modelCatalogSource/);
});

test("installed overall runs the verifier from the same audited source tree", async () => {
  const source = await readFile(scriptUrl, "utf8");

  assert.match(source, /Join-Path \$PSScriptRoot "test-anticodex-ui-state\.mjs"/);
});

test("installed overall accepts the supervisor's CDP handoff without trusting a stale client PID", async () => {
  const source = await readFile(scriptUrl, "utf8");

  assert.match(source, /\$reportedClientPidMatchesMain\s*=/);
  assert.match(source, /\$cdpHandoffMatchesMain\s*=\s*\[bool\]\([\s\S]*?\$reportedClientPids\.Count\s+-eq\s+0[\s\S]*?\$fixedReady/);
  assert.match(source, /\$clientOwnershipProven\s*=\s*\$reportedClientPidMatchesMain\s+-or\s+\$cdpHandoffMatchesMain/);
  assert.match(source, /clientOwnershipMode\s*=\s*\$clientOwnershipMode/);
});
