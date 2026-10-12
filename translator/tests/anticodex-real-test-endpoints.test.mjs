import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const scripts = {
  routing: new URL("../../scripts/test-anticodex-model-routing.ps1", import.meta.url),
  switching: new URL("../../scripts/test-anticodex-model-switch-history.ps1", import.meta.url),
};

test("real model routing separates manager APIs from the fixed response proxy", async () => {
  const source = await readFile(scripts.routing, "utf8");
  assert.match(source, /\[string\]\$ManagerBaseUrl/);
  assert.match(source, /\[string\]\$ProxyBaseUrl/);
  assert.match(source, /function Invoke-LocalJsonSafe/);
  assert.match(source, /\[string\]\$RootUrl = \$ManagerBaseUrl/);
  assert.match(source, /Invoke-LocalJsonSafe "models" "\/models" -RootUrl \$ProxyBaseUrl/);
  assert.match(source, /\} \$RequestTimeoutSec \$ProxyBaseUrl/);
});

test("real model switch history separates manager APIs from the fixed response proxy", async () => {
  const source = await readFile(scripts.switching, "utf8");
  assert.match(source, /\[string\]\$ManagerBaseUrl/);
  assert.match(source, /\[string\]\$ProxyBaseUrl/);
  assert.match(source, /Invoke-ManagerJson .*\/health/);
  assert.match(source, /Invoke-ProxyJson .*\/models/);
  assert.match(source, /Invoke-ManagerJson .*\/anticodex\/model-routes/);
  assert.match(source, /-Uri "\$ProxyBaseUrl\/v1\/responses"/);
  assert.match(source, /role = "assistant"/);
  assert.match(source, /type = "output_text"/);
  assert.match(source, /text = \$firstText/);
});
