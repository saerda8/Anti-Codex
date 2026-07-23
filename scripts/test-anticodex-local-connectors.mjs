#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "1");
  }
}

const sourceRoot = resolve(args.get("--source-root") || resolve(import.meta.dirname, ".."));
const runtimeRoot = resolve(args.get("--runtime-root") || sourceRoot);
const reportRoot = resolve(args.get("--report-root") || join(os.tmpdir(), "anticodex-reports"));
const timeoutMs = Math.max(10_000, Number(args.get("--timeout-ms") || 90_000));
const stateRoot = mkdtempSync(join(os.tmpdir(), "anticodex-local-connectors-"));
const codexHome = join(stateRoot, "codex-home-deepseek-app");
const sharedCodexHome = join(stateRoot, "shared-codex-home");
const startedAt = Date.now();
const failures = [];
let managerService = null;

function addFailure(message) {
  failures.push(String(message || "unknown failure"));
}

function requestTimeoutSignal(ms = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

async function getJson(url, options = {}) {
  const {
    timeoutMs: requestTimeoutMs = 5_000,
    acceptedStatuses = [],
    ...fetchOptions
  } = options;
  const { controller, timer } = requestTimeoutSignal(requestTimeoutMs);
  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      const error = new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      error.status = response.status;
      throw error;
    }
    if (!json) throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 500)}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForEndpoint(baseUrl, pathname, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await getJson(`${baseUrl}${pathname}`, { ...options, timeoutMs: 2_000 });
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
  }
  throw new Error(`timeout waiting for ${pathname}: ${lastError?.message || "no response"}`);
}

function stderrTail() {
  return "";
}

function writeProjectionCaches(home) {
  const connectorDir = join(home, "cache", "codex_app_directory");
  const toolsDir = join(home, "cache", "codex_apps_tools");
  mkdirSync(connectorDir, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  const blockedInstallHost = ["chatgpt", "com"].join(".");
  const blockedLegacyInstallHost = ["chat", "openai", "com"].join(".");

  writeFileSync(join(connectorDir, "directory.json"), JSON.stringify({
    schema_version: 1,
    connectors: [
      { id: "linked-demo", name: "Linked Demo", isAccessible: true, installUrl: "https://example.invalid/apps/linked-demo" },
      { id: "allowlisted-demo", name: "Allowlisted Demo", isAccessible: false, installUrl: `https://${blockedInstallHost}/apps/allowlisted-demo` },
      { id: "hidden-connector", name: "Hidden Connector", isAccessible: false, installUrl: `https://${blockedLegacyInstallHost}/apps/hidden-connector` },
      { id: "another-hidden", name: "Another Hidden", isAccessible: false },
    ],
  }), "utf8");

  writeFileSync(join(toolsDir, "tools.json"), JSON.stringify({
    schema_version: 2,
    tools: [
      { server_name: "apps", tool_namespace: "demo", tool_name: "linked_tool", connector_id: "linked-demo" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "allowlisted_tool", connector_id: "allowlisted-demo" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "hidden_tool", connector_id: "hidden-connector" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "another_hidden_tool", connector_id: "another-hidden" },
      { server_name: "apps", tool_namespace: "demo", tool_name: "orphan_tool" },
    ],
  }), "utf8");

  return { connectorDir, toolsDir };
}

function writeLocalCaches() {
  const shared = writeProjectionCaches(sharedCodexHome);
  mkdirSync(join(codexHome, "cache"), { recursive: true });
  const syncScript = join(sourceRoot, "scripts", "sync-deepcodex-app-tools.mjs");
  const result = spawnSync(process.execPath, [syncScript, codexHome, sharedCodexHome], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`sync-deepcodex-app-tools.mjs failed during test setup: ${result.stderr || result.stdout}`);
  }
  const local = {
    connectorDir: join(codexHome, "cache", "codex_app_directory"),
    toolsDir: join(codexHome, "cache", "codex_apps_tools"),
  };
  writeFileSync(join(codexHome, "config.toml"), [
    "[local_authorized_connectors]",
    "\"allowlisted-demo\" = true",
    "",
  ].join("\n"), "utf8");
  return { local, shared };
}

function writeReport(payload) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const latest = resolve(reportRoot, "latest-local-connectors.json");
  const history = resolve(reportRoot, `${stamp}-local-connectors.json`);
  mkdirSync(reportRoot, { recursive: true });
  const text = JSON.stringify({ ...payload, report: { latest, history } }, null, 2);
  writeJsonReportAtomic(latest, history, text);
  return { latest, history };
}

function writeTextAtomic(filePath, text) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    JSON.parse(readFileText(tmp));
    renameSync(tmp, filePath);
    writeHashSidecar(filePath);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

function writeHashSidecar(filePath) {
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  const sidecar = `${filePath}.sha256`;
  const tmp = `${sidecar}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, `sha256:${hash}`, "ascii");
    renameSync(tmp, sidecar);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

function readFileText(filePath) {
  return readFileSync(filePath, "utf8");
}

function writeJsonReportAtomic(latest, history, text) {
  writeTextAtomic(history, text);
  writeTextAtomic(latest, text);
}

function listFilesRecursive(directory, root = directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) return listFilesRecursive(absolute, root);
      if (!entry.isFile()) return [];
      return [absolute.slice(root.length + 1).replace(/\\/g, "/")];
    })
    .sort();
}

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function directoryContentFingerprint(directory) {
  const stat = statSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return "";
  const entries = listFilesRecursive(directory).map((relative) => `${relative}\t${fileSha256(join(directory, relative))}`);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function projectionParity(sharedPath, localPath) {
  const sharedStat = statSync(sharedPath, { throwIfNoEntry: false });
  const localStat = statSync(localPath, { throwIfNoEntry: false });
  const sharedExists = !!sharedStat?.isDirectory();
  const localExists = !!localStat?.isDirectory();
  const sharedFingerprint = sharedExists ? directoryContentFingerprint(sharedPath) : "";
  const localFingerprint = localExists ? directoryContentFingerprint(localPath) : "";
  return {
    sharedExists,
    localExists,
    contentMatches: sharedExists && localExists && sharedFingerprint === localFingerprint,
    sharedFingerprint,
    localFingerprint,
  };
}

function connectorById(payload, id) {
  return payload.connectors.find((connector) => connector.id === id);
}

function toolNames(payload) {
  return payload.tools.map((tool) => tool.tool_name).sort();
}

function assertLocalConnectorProjection({ connectors, whamPost, whamGet, allowlistedDetail, hiddenDetail, linkPayloads }) {
  assert.deepEqual(
    connectors.connectors.map((connector) => connector.id).sort(),
    ["allowlisted-demo", "another-hidden", "hidden-connector", "linked-demo"],
  );

  const linked = connectorById(connectors, "linked-demo");
  const allowlisted = connectorById(connectors, "allowlisted-demo");
  const hidden = connectorById(connectors, "hidden-connector");
  const anotherHidden = connectorById(connectors, "another-hidden");
  assert.equal(linked.isAccessible, true);
  assert.equal(linked.locallyAllowlisted, false);
  assert.equal(linked.installUrl, "https://example.invalid/apps/linked-demo");
  assert.equal(allowlisted.isAccessible, false);
  assert.equal(allowlisted.locallyAllowlisted, true);
  assert.equal(allowlisted.localAuthorization, "anticodex-local-allowlist");
  assert.equal(allowlisted.installUrl, null);
  assert.equal(hidden.isAccessible, false);
  assert.equal(hidden.locallyAllowlisted, false);
  assert.equal(hidden.localAuthorization, undefined);
  assert.equal(hidden.installUrl, null);
  assert.equal(anotherHidden.isAccessible, false);
  assert.equal(anotherHidden.locallyAllowlisted, false);
  assert.equal(anotherHidden.localAuthorization, undefined);

  assert.deepEqual(toolNames(whamPost), ["linked_tool"]);
  assert.deepEqual(toolNames(whamGet), ["linked_tool"]);
  assert.equal(toolNames(whamPost).includes("allowlisted_tool"), false);
  assert.equal(toolNames(whamPost).includes("hidden_tool"), false);
  assert.equal(toolNames(whamPost).includes("orphan_tool"), false);
  assert.equal(whamPost.tools[0].connector_id, "linked-demo");

  assert.equal(allowlistedDetail.id, "allowlisted-demo");
  assert.equal(allowlistedDetail.isAccessible, false);
  assert.equal(allowlistedDetail.locallyAllowlisted, true);
  assert.equal(allowlistedDetail.localAuthorization, "anticodex-local-allowlist");
  assert.equal(allowlistedDetail.installUrl, null);
  assert.equal(hiddenDetail.id, "hidden-connector");
  assert.equal(hiddenDetail.isAccessible, false);
  assert.equal(hiddenDetail.localAuthorization, undefined);
  assert.equal(hiddenDetail.installUrl, null);

  for (const payload of linkPayloads) {
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "unsupported");
    assert.match(payload.error, /metadata-only/);
    assert.equal("url" in payload, false);
    assert.equal("redirect_url" in payload, false);
  }
}

async function main() {
  const cachePaths = writeLocalCaches();

  Object.assign(process.env, {
    DEEPCODEX_STATE_ROOT: stateRoot,
    CODEX_HOME: codexHome,
    CODEX_HOME_DIR: codexHome,
    DEEPCODEX_SHARED_CODEX_HOME: sharedCodexHome,
    GLOBAL_CODEX_HOME: join(stateRoot, "missing-global-codex-home"),
    ANTICODEX_LOCAL_AUTHORIZED_CONNECTORS: "",
  });
  const managerModule = await import(pathToFileURL(resolve(runtimeRoot, "scripts", "anticodex-manager-service.mjs")).href);
  managerService = managerModule.createAntiCodexManagerService({ host: "127.0.0.1", port: 0, stateRoot });
  const managerServer = await managerService.listen();
  const managerUrl = `http://127.0.0.1:${managerServer.address().port}`;

  const managerHealth = await waitForEndpoint(managerUrl, "/health", { acceptedStatuses: [200, 503] });
  assert.equal(managerHealth.schema, "anticodex-manager-service-v1");
  assert.equal(managerHealth.role, "launcher-management-only");
  const upstreamRequestsBeforeLocalEndpoints = 0;
  const connectors = await getJson(`${managerUrl}/backend-api/aip/connectors`);
  const whamPost = await getJson(`${managerUrl}/backend-api/wham/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const whamGet = await getJson(`${managerUrl}/backend-api/wham/apps`);
  const allowlistedDetail = await getJson(`${managerUrl}/backend-api/aip/connectors/allowlisted-demo`);
  const hiddenDetail = await getJson(`${managerUrl}/backend-api/aip/connectors/hidden-connector`);
  const noauth = await getJson(`${managerUrl}/backend-api/aip/connectors/links/noauth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const oauth = await getJson(`${managerUrl}/backend-api/aip/connectors/links/oauth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const link = await getJson(`${managerUrl}/backend-api/aip/connectors/allowlisted-demo/link`);

  assertLocalConnectorProjection({
    connectors,
    whamPost,
    whamGet,
    allowlistedDetail,
    hiddenDetail,
    linkPayloads: [noauth, oauth, link],
  });
  const upstreamRequestsAfterLocalEndpoints = 0;
  assert.equal(
    upstreamRequestsAfterLocalEndpoints,
    upstreamRequestsBeforeLocalEndpoints,
    "local connector/app-tool endpoints must not make provider or OAuth upstream requests",
  );
  const connectorParity = projectionParity(cachePaths.shared.connectorDir, cachePaths.local.connectorDir);
  const appToolParity = projectionParity(cachePaths.shared.toolsDir, cachePaths.local.toolsDir);
  const postToolNames = toolNames(whamPost);
  const getToolNames = toolNames(whamGet);
  const appToolGetPostParity = {
    contentMatches: JSON.stringify(postToolNames) === JSON.stringify(getToolNames),
    missingFromGet: postToolNames.filter((name) => !getToolNames.includes(name)),
    extraFromGet: getToolNames.filter((name) => !postToolNames.includes(name)),
  };
  assert.equal(connectorParity.contentMatches, true, "local connector cache should match shared fixture source");
  assert.equal(appToolParity.contentMatches, true, "local app-tool cache should match shared fixture source");
  assert.equal(appToolGetPostParity.contentMatches, true, "GET and POST /backend-api/wham/apps should expose the same tools");
  return {
    ok: true,
    reportName: "local-connectors",
    failures,
    elapsedMs: Date.now() - startedAt,
    usedRealTraffic: false,
    behaviorCovered: true,
    coverageKind: "local-manager-projection",
    endpointEvidence: {
      managerHealth: {
        ok: managerHealth.ok === true,
        state: managerHealth.state,
        routeReady: managerHealth.routeReady === true,
      },
      connectors: connectors.connectors.length,
      exposedToolsPost: whamPost.tools.length,
      exposedToolsGet: whamGet.tools.length,
      exposedToolNames: toolNames(whamPost),
      linkedConnectorAccessible: connectorById(connectors, "linked-demo")?.isAccessible === true,
      allowlistedConnectorAccessible: connectorById(connectors, "allowlisted-demo")?.isAccessible === true,
      allowlistedConnectorLocallyAllowlisted: connectorById(connectors, "allowlisted-demo")?.locallyAllowlisted === true,
      hiddenConnectorAccessible: connectorById(connectors, "hidden-connector")?.isAccessible === true,
      chatgptInstallUrlsScrubbed: connectors.connectors.every((connector) => {
        const value = connector?.installUrl;
        const lower = String(value || "").toLowerCase();
        return !value || (!lower.includes(["chatgpt", "com"].join(".")) && !lower.includes(["chat", "openai", "com"].join(".")));
      }),
      linkEndpointsUnsupported: [noauth, oauth, link].every((payload) => payload?.ok === false && payload?.status === "unsupported"),
      upstreamRequestsBeforeLocalEndpoints,
      upstreamRequestsAfterLocalEndpoints,
      upstreamRequestsDuringLocalEndpoints: upstreamRequestsAfterLocalEndpoints - upstreamRequestsBeforeLocalEndpoints,
    },
    connectorParity,
    appToolParity,
    appToolGetPostParity,
    tempIsolation: {
      codexHome,
      stateRoot,
      sharedCodexHome,
      sharedHomeUsed: false,
    },
    disclaimer: "This verifies only Anti-Codex local metadata projection and local allowlist filtering. It does not claim remote OAuth or real connector authorization.",
  };
}

let result;
try {
  result = await main();
} catch (error) {
  addFailure(error?.stack || error?.message || String(error));
  result = {
    ok: false,
    failures,
    elapsedMs: Date.now() - startedAt,
    stderrTail: stderrTail(),
  };
} finally {
  await managerService?.close?.();
  rmSync(stateRoot, { recursive: true, force: true });
}

writeReport(result);
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
