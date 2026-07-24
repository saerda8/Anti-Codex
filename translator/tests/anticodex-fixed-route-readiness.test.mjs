import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import * as fixedRoute from "../../scripts/start-anticodex-fixed-route.mjs";

import {
  buildFixedRoutePlan,
  cdpPageReady,
  sanitizeFixedRoutePlan,
} from "../../scripts/start-anticodex-fixed-route.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const fixedRouteSource = readFileSync(resolve(root, "scripts", "start-anticodex-fixed-route.mjs"), "utf8");
const uiStateSource = readFileSync(resolve(root, "scripts", "test-anticodex-ui-state.mjs"), "utf8");

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

test("fixed-route readiness ignores a ready avatar overlay and waits for the primary page", async () => {
  const overlay = {
    type: "page",
    url: "app://-/index.html?initialRoute=%2Favatar-overlay",
    webSocketDebuggerUrl: "ws://127.0.0.1:18318/devtools/page/overlay",
  };
  const primary = {
    type: "page",
    url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:18318/devtools/page/primary",
  };
  const probes = [];

  const notReady = await cdpPageReady(18318, {
    fetchImpl: async () => targetResponse([overlay, primary]),
    rendererProbe: async (url) => {
      probes.push(url);
      return url === overlay.webSocketDebuggerUrl;
    },
  });
  assert.equal(notReady, false);
  assert.deepEqual(probes, [primary.webSocketDebuggerUrl]);

  const ready = await cdpPageReady(18318, {
    fetchImpl: async () => targetResponse([overlay, primary]),
    rendererProbe: async (url) => url === primary.webSocketDebuggerUrl,
  });
  assert.equal(ready, true);
});

test("a fatal copied-client page is never renderer-ready even when it has a retry button", () => {
  assert.equal(typeof fixedRoute.isCdpRendererSnapshotReady, "function");
  assert.equal(typeof fixedRoute.classifyCdpRendererSnapshot, "function");
  assert.deepEqual(fixedRoute.classifyCdpRendererSnapshot({
    readyState: "complete",
    hasBody: true,
    text: "ChatGPT 已意外停止 重试",
    hasInteractive: true,
    hasComposer: false,
    primaryHeading: "ChatGPT 已意外停止",
    buttonLabels: ["重试"],
  }), {
    ready: false,
    fatal: true,
  });
  assert.equal(fixedRoute.isCdpRendererSnapshotReady({
    readyState: "complete",
    hasBody: true,
    text: "ChatGPT 已意外停止 重试",
    hasInteractive: true,
    hasComposer: false,
    primaryHeading: "ChatGPT 已意外停止",
    buttonLabels: ["更新 ChatGPT", "打开 Config.toml", "重启"],
  }), false);
  assert.equal(fixedRoute.isCdpRendererSnapshotReady({
    readyState: "complete",
    hasBody: true,
    text: "Anti-Codex 新任务 管理",
    hasInteractive: true,
    hasComposer: false,
    primaryHeading: "Anti-Codex",
    buttonLabels: ["新任务", "管理"],
  }), true);
  assert.equal(fixedRoute.isCdpRendererSnapshotReady({
    readyState: "complete",
    hasBody: true,
    text: "用户消息：为什么页面会显示 ChatGPT has unexpectedly stopped？助手正在解释。",
    hasInteractive: true,
    hasComposer: true,
    primaryHeading: "Anti-Codex 人物剧情短片",
    buttonLabels: ["发送", "管理"],
  }), true);
});

test("fatal-page probes accept a visible h2 heading and exclude hidden recovery buttons", () => {
  assert.deepEqual(fixedRoute.classifyCdpRendererSnapshot({
    readyState: "complete",
    hasBody: true,
    text: "ChatGPT 已意外停止 重启",
    hasInteractive: true,
    hasComposer: false,
    primaryHeadingTag: "H2",
    primaryHeading: "ChatGPT 已意外停止",
    buttonLabels: ["重启"],
  }), { ready: false, fatal: true });

  for (const source of [fixedRouteSource, uiStateSource]) {
    assert.match(source, /main h1, main h2, h1, h2, \[role=["']heading["']\]/);
    assert.match(source, /getBoundingClientRect/);
    assert.match(source, /visibility\s*!==\s*['"]hidden['"]/);
  }
});

test("installed UI verifier rejects a fatal-page fixture", () => {
  const fixture = {
    title: "Anti-Codex",
    href: "file:///anticodex/index.html",
    textLength: 18,
    textSample: "ChatGPT 已意外停止 重试",
    hasLoginText: false,
    hasReconnectText: false,
    hasComposer: false,
    primaryHeading: "ChatGPT 已意外停止",
    buttonLabels: ["重试"],
  };
  const result = spawnSync(process.execPath, [
    resolve(root, "scripts", "test-anticodex-ui-state.mjs"),
    "--page-state-json", JSON.stringify(fixture),
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const output = JSON.parse(String(result.stdout || "{}").trim());
  assert.equal(output.ok, false);
  assert.ok(output.failures.some((failure) => /fatal client page/i.test(failure)));

  const ordinaryChat = spawnSync(process.execPath, [
    resolve(root, "scripts", "test-anticodex-ui-state.mjs"),
    "--page-state-json", JSON.stringify({
      title: "Anti-Codex",
      href: "file:///anticodex/index.html",
      textLength: 48,
      textSample: "用户消息：为什么会显示 ChatGPT 已意外停止？助手正在解释。",
      hasLoginText: false,
      hasReconnectText: false,
      hasComposer: true,
      primaryHeading: "Anti-Codex 人物剧情短片",
      buttonLabels: ["发送", "管理"],
    }),
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(ordinaryChat.error, undefined);
  assert.equal(ordinaryChat.status, 0);
  assert.equal(JSON.parse(String(ordinaryChat.stdout || "{}").trim()).ok, true);
});

test("structured CDP readiness preserves fatal evidence while boolean callers stay compatible", async () => {
  const target = {
    type: "page",
    webSocketDebuggerUrl: "ws://127.0.0.1:18318/devtools/page/anticodex",
  };
  const status = await cdpPageReady(18318, {
    fetchImpl: async () => targetResponse([target]),
    rendererProbe: async () => ({ ready: false, fatal: true }),
    returnStatus: true,
  });
  assert.deepEqual(status, { ready: false, fatal: true });
  assert.equal(await cdpPageReady(18318, {
    fetchImpl: async () => targetResponse([target]),
    rendererProbe: async () => ({ ready: true, fatal: false }),
  }), true);
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
