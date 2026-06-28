import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";

const {
  deterministicWebSocketPrewarmResponse,
} = await import("../adaptive-server.mjs");

test("responses websocket generate=false prewarm completes locally without output", () => {
  const response = deterministicWebSocketPrewarmResponse({
    type: "response.create",
    model: "gpt-5.5",
    generate: false,
    stream: true,
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "context only" }],
    }],
  });

  assert.equal(response.status, "completed");
  assert.equal(response.model, "gpt-5.5");
  assert.deepEqual(response.output, []);
  assert.equal(response.usage, null);
  assert.match(response.id, /^resp_/);
});

test("ordinary responses websocket requests are not treated as prewarm", () => {
  assert.equal(deterministicWebSocketPrewarmResponse({
    type: "response.create",
    model: "gpt-5.5",
    input: "answer this",
  }), null);
});

test("responses route handles generate=false before chat conversion and upstream work", () => {
  const source = readFileSync(new URL("../adaptive-server.mjs", import.meta.url), "utf8");
  const routeStart = source.indexOf('if (req.method === "POST" && RESPONSES_PATHS.has(url.pathname))');
  assert.ok(routeStart >= 0, "missing POST Responses route");
  const route = source.slice(routeStart);
  const resetCancellation = route.indexOf("resetCancelledPreviousResponseFailure(parsed)");
  const prewarmBranch = route.indexOf("deterministicWebSocketPrewarmResponse(parsed)");
  const chatConversion = route.indexOf("const chatBody = responsesToChatBody(parsed");

  assert.ok(resetCancellation >= 0, "missing reset cancellation branch");
  assert.ok(prewarmBranch >= 0, "missing local websocket prewarm branch");
  assert.ok(chatConversion >= 0, "missing Responses chat conversion");
  assert.ok(resetCancellation < prewarmBranch, "cancelled reset replay must be rejected before local prewarm");
  assert.ok(prewarmBranch < chatConversion, "websocket prewarm must finish before chat conversion and upstream work");
});
