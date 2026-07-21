import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFixedRoutePlan,
  cdpPageReady,
  sanitizeFixedRoutePlan,
} from "../../scripts/start-anticodex-fixed-route.mjs";

function targetResponse(targets) {
  return {
    ok: true,
    async json() {
      return targets;
    },
  };
}

test("fixed-route readiness requires a hydrated copied-client renderer", async () => {
  const target = {
    type: "page",
    webSocketDebuggerUrl: "ws://127.0.0.1:18318/devtools/page/anticodex",
  };
  const probes = [];

  const blank = await cdpPageReady(18318, {
    fetchImpl: async () => targetResponse([target]),
    rendererProbe: async (url) => {
      probes.push(url);
      return false;
    },
  });
  assert.equal(blank, false);
  assert.deepEqual(probes, [target.webSocketDebuggerUrl]);

  const hydrated = await cdpPageReady(18318, {
    fetchImpl: async () => targetResponse([target]),
    rendererProbe: async () => true,
  });
  assert.equal(hydrated, true);
});

test("fixed-route readiness ignores non-page and non-debuggable targets", async () => {
  let probeCount = 0;
  const ready = await cdpPageReady(18318, {
    fetchImpl: async () => targetResponse([
      { type: "worker", webSocketDebuggerUrl: "ws://127.0.0.1:18318/devtools/worker/1" },
      { type: "page" },
    ]),
    rendererProbe: async () => {
      probeCount += 1;
      return true;
    },
  });

  assert.equal(ready, false);
  assert.equal(probeCount, 0);
});

test("headless fixed route runs the CodexPlusPlus protocol proxy without a desktop client", () => {
  const plan = buildFixedRoutePlan([
    "--headless",
    "--provider", "antigravity",
    "--model", "claude-sonnet-4-6",
  ], {
    LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
    APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
  });
  const publicPlan = sanitizeFixedRoutePlan(plan);

  assert.equal(plan.headless, true);
  assert.deepEqual(plan.launcherArgs, ["--helper-only", "--helper-port", "18484"]);
  assert.deepEqual(plan.clientArgs, []);
  assert.equal(publicPlan.lifecycle.launchesVisibleClientOnce, false);
  assert.equal(publicPlan.lifecycle.headlessProtocolProxy, true);
  assert.equal(publicPlan.lifecycle.codexPlusPlusOwnsClient, false);
  assert.equal(publicPlan.lifecycle.clientOwner, null);
  assert.equal(publicPlan.lifecycle.ownsTaskControl, false);
});
