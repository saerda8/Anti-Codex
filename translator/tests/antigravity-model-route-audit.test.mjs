import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAntigravityModelRouteAuditStore } from "../antigravity-model-route-audit.mjs";

test("model route audit stores bounded model metadata without prompt text", () => {
  const dir = mkdtempSync(join(tmpdir(), "anticodex-route-audit-"));
  const filePath = join(dir, "audit.json");
  try {
    const store = createAntigravityModelRouteAuditStore({ filePath, maxEntries: 2 });
    store.record({
      requestId: "resp_1",
      requestedModel: "gemini-3.5-flash-low",
      resolvedModel: "gemini-3.5-flash-low",
      displayName: "Gemini 3.5 Flash (Low)",
      transport: "upstream-provider",
      provider: "openai-compatible",
      providerProtocol: "openai",
      internalModel: "MODEL_1",
      cascadeId: "cascade_1",
      prompt: "must not be stored",
    });
    store.record({
      requestId: "resp_2",
      requestedModel: "gemini-3.1-pro-low",
      resolvedModel: "gemini-3.1-pro-low",
      internalModel: "MODEL_2",
    });
    store.record({
      requestId: "resp_3",
      requestedModel: "claude-sonnet-4-6",
      resolvedModel: "claude-sonnet-4-6",
      transport: "upstream-provider",
      provider: "anthropic",
      providerProtocol: "anthropic",
      internalModel: "MODEL_3",
    });

    const snapshot = store.snapshot();
    assert.equal(snapshot.count, 2);
    assert.equal(snapshot.object, "anticodex.model_route_audit");
    assert.equal(snapshot.legacyObject, "antigravity.model_route_audit");
    assert.equal(snapshot.latest.requestId, "resp_3");
    assert.equal(snapshot.entries[0].requestId, "resp_3");
    assert.equal(snapshot.entries[1].requestId, "resp_2");
    assert.equal(JSON.stringify(snapshot).includes("must not be stored"), false);
    assert.equal(snapshot.latest.transport, "upstream-provider");
    assert.equal(snapshot.latest.provider, "anthropic");
    assert.equal(snapshot.latest.providerProtocol, "anthropic");

    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(persisted.entries.length, 2);
    assert.equal(JSON.stringify(persisted).includes("must not be stored"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
