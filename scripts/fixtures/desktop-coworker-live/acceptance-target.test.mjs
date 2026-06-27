import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStatus, summarizeStatuses } from "./acceptance-target.mjs";

test("normalizes status values for report grouping", () => {
  assert.equal(normalizeStatus(" OK "), "ok");
  assert.equal(normalizeStatus("Needs Review"), "needs-review");
  assert.equal(normalizeStatus("blocked_by_proxy"), "blocked-by-proxy");
  assert.equal(normalizeStatus("  __Needs!! Review__  "), "needs-review");
  assert.equal(normalizeStatus("***Blocked_by Proxy!!"), "blocked-by-proxy");
});

test("summarizes normalized status values", () => {
  assert.deepEqual(summarizeStatuses([" OK ", "ok", "Needs Review", "", "blocked_by_proxy"]), {
    ok: 2,
    "needs-review": 1,
    "blocked-by-proxy": 1,
  });
});
