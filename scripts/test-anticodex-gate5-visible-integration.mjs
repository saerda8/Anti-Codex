#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const compact = args.has("--compact");
const reportRoot = resolve(args.get("--report-root") || `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`);
const auditPath = resolve(args.get("--audit-out") || resolve(root, "docs", "audits", "2026-07-15-gate5-visible-integration.json"));
const fixedHealthUrl = args.get("--fixed-health-url") || "http://127.0.0.1:18487/anticodex/fixed-route/health";
const maxSourceAgeMs = positiveInteger(args.get("--max-source-age-ms"), 12 * 60 * 60 * 1000);
const expectedModel = "gemini-3-flash-agent";
const expectedModelLabel = "Gemini 3.5 Flash (High)";
const developmentWorkers = [
  "deepseek-code-worker",
  "mimo-claude-coworker",
  "mimocode-worker",
  "deveco-code-worker",
  "opencode-worker",
  "kilo-worker",
  "codebuddy-worker",
  "agnes-worker",
  "antigravity-code-worker",
];
const sourceDefinitions = [
  {
    id: "visible_text",
    file: "latest-gate5-visible-text-b-model-gemini-3-flash-agent.json",
    taskMode: "exact-marker",
    marker: "GATE5_VISIBLE_TEXT_20260715_B",
  },
  {
    id: "visible_tool",
    file: "latest-gate5-visible-tool-b-model-gemini-3-flash-agent.json",
    taskMode: "local-project",
    marker: "GATE5_VISIBLE_TOOL_20260715_B",
  },
  {
    id: "history_continuation",
    file: "latest-gate5-visible-history-b-model-gemini-3-flash-agent.json",
    taskMode: "exact-marker",
    marker: "GATE5_VISIBLE_TEXT_CONTINUE_20260715_B",
  },
];
const checks = [];
const sourceReports = {};

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) continue;
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed.set(key, next);
      index += 1;
    } else {
      parsed.set(key, "1");
    }
  }
  return parsed;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function record(id, ok, evidence = {}) {
  checks.push({ id, ok: ok === true, ...evidence });
}

function readSignedReport(fileName) {
  const path = resolve(reportRoot, fileName);
  const sidecarPath = `${path}.sha256`;
  if (!existsSync(path)) throw new Error(`missing report: ${path}`);
  if (!existsSync(sidecarPath)) throw new Error(`missing report sidecar: ${sidecarPath}`);
  const bytes = readFileSync(path);
  const actualHash = sha256(bytes);
  const sidecar = readFileSync(sidecarPath, "ascii").trim();
  const match = sidecar.match(/^(?:sha256:)?([a-f0-9]{64})$/i);
  const stats = statSync(path);
  return {
    path,
    sidecarPath,
    data: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")),
    sha256: actualHash,
    signed: Boolean(match) && match[1].toLowerCase() === actualHash,
    modifiedAt: stats.mtime.toISOString(),
    ageMs: Math.max(0, Date.now() - stats.mtimeMs),
  };
}

function parseJsonOutput(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("command returned no JSON output");
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("command output did not contain a JSON object");
}

function runJson(command, commandArgs, timeoutMs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  let data = null;
  let parseError = "";
  try {
    data = parseJsonOutput(result.stdout);
  } catch (error) {
    parseError = String(error?.message || error);
  }
  return {
    ok: result.status === 0 && data?.ok === true,
    status: result.status,
    signal: result.signal || "",
    error: result.error?.message || parseError,
    stderr: String(result.stderr || "").trim().slice(-1200),
    data,
  };
}

async function fetchJson(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function writeSignedAtomic(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, body, "utf8");
  renameSync(temporaryPath, path);
  writeFileSync(`${path}.sha256`, `sha256:${sha256(body)}`, "ascii");
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

for (const definition of sourceDefinitions) {
  try {
    const report = readSignedReport(definition.file);
    const data = report.data;
    const semanticallyValid = data.ok === true
      && data.requestedRealTraffic === true
      && data.usedRealTraffic === true
      && data.coverageKind === "desktop-ui-real-traffic"
      && data.taskMode === definition.taskMode
      && data.marker === definition.marker
      && data.requiredModel === expectedModel
      && data.requiredModelLabel === expectedModelLabel
      && data.preSubmitModelSelectionEvidence?.matched === true
      && data.submitSucceeded === true
      && data.behaviorCovered === true
      && data.repairAttempted === false
      && Array.isArray(data.failures)
      && data.failures.length === 0
      && Number(data.answerMarkerCount || 0) >= 1;
    sourceReports[definition.id] = {
      ...report,
      summary: {
        ok: data.ok,
        reportName: data.reportName,
        taskMode: data.taskMode,
        marker: data.marker,
        requiredModel: data.requiredModel,
        elapsedMs: data.elapsedMs,
        submitSucceeded: data.submitSucceeded,
        repairAttempted: data.repairAttempted,
      },
    };
    record(`${definition.id}_signed_fresh_real_result`, report.signed && report.ageMs <= maxSourceAgeMs && semanticallyValid, {
      path: report.path,
      sha256: report.sha256,
      signed: report.signed,
      ageMs: report.ageMs,
      semanticResult: semanticallyValid,
    });
  } catch (error) {
    record(`${definition.id}_signed_fresh_real_result`, false, { error: String(error?.message || error) });
  }
}

const textReport = sourceReports.visible_text?.data || null;
const toolReport = sourceReports.visible_tool?.data || null;
const historyReport = sourceReports.history_continuation?.data || null;

record("history_reopened_by_actual_mouse_within_budget", Boolean(
  historyReport?.sameChatEvidence?.actualMouseClick === true
    && historyReport.sameChatEvidence.wanted === "GATE5_VISIBLE_TEXT_20260715_B"
    && Number(historyReport.sameChatEvidence.openLatencyMs) > 0
    && Number(historyReport.sameChatEvidence.openLatencyMs) <= 3000
    && historyReport.sameChatEvidence.visibleIdleAfterClick?.ok === true,
), {
  actualMouseClick: historyReport?.sameChatEvidence?.actualMouseClick === true,
  openLatencyMs: historyReport?.sameChatEvidence?.openLatencyMs ?? null,
  sameTaskWanted: historyReport?.sameChatEvidence?.wanted || "",
});

const artifactDir = toolReport?.artifactDir ? resolve(toolReport.artifactDir) : "";
const expectedArtifacts = [
  ["done.txt", "c3fd546b148c8614ec25e9dffc61287971386dda08dc215a9cd9b55e62f82052"],
  ["index.html", "9b60ae55440e55646f2a5597b656ab7b1306ae0ba110e721de649cc146e4bdbd"],
  ["README.md", "05c1f6ba87ee56341a25af63af7b029968bd88b42176af04187a7914c5756e69"],
];
const artifactEvidence = expectedArtifacts.map(([name, expectedHash]) => {
  const path = artifactDir ? resolve(artifactDir, name) : "";
  const bytes = path && existsSync(path) ? readFileSync(path) : null;
  const actualHash = bytes ? sha256(bytes) : "";
  return { name, path, exists: Boolean(bytes), bytes: bytes?.length || 0, expectedHash, actualHash, ok: actualHash === expectedHash };
});
record("tool_result_files_exist_with_exact_hashes", artifactEvidence.every((entry) => entry.ok), {
  artifactDir,
  files: artifactEvidence,
});
record("tool_turn_showed_progress_and_host_tool_results", Boolean(
  toolReport?.artifactEvidence?.responseHistory?.visibleProgressCount >= 1
    && toolReport.artifactEvidence.responseHistory.taskToolCallCount >= 1
    && toolReport.artifactEvidence.responseHistory.taskToolOutputSeen === true
    && toolReport.artifactEvidence.responseHistory.taskScopedToolOutputSeen === true
    && toolReport.artifactEvidence.responseHistory.modelLedExecution === true,
), {
  visibleProgressCount: toolReport?.artifactEvidence?.responseHistory?.visibleProgressCount ?? 0,
  taskToolCallCount: toolReport?.artifactEvidence?.responseHistory?.taskToolCallCount ?? 0,
  taskToolOutputSeen: toolReport?.artifactEvidence?.responseHistory?.taskToolOutputSeen === true,
});

let fixedHealth = null;
try {
  fixedHealth = await fetchJson(fixedHealthUrl);
  record("fixed_three_layer_route_ready", Boolean(
    fixedHealth.ok === true
      && fixedHealth.state === "ready"
      && fixedHealth.provider === "antigravity"
      && fixedHealth.model === expectedModel
      && fixedHealth.route?.adapterEnabled === true
      && fixedHealth.route?.relayProtocol === "chatCompletions"
      && fixedHealth.component?.version === "1.2.36"
      && fixedHealth.antigravityReady === true
      && Array.isArray(fixedHealth.processes?.copiedClient)
      && fixedHealth.processes.copiedClient.length === 1,
  ), {
    url: fixedHealthUrl,
    state: fixedHealth.state,
    provider: fixedHealth.provider,
    model: fixedHealth.model,
    relayProtocol: fixedHealth.route?.relayProtocol || "",
    codexPlusPlusVersion: fixedHealth.component?.version || "",
    copiedClientPids: fixedHealth.processes?.copiedClient || [],
  });
} catch (error) {
  record("fixed_three_layer_route_ready", false, { url: fixedHealthUrl, error: String(error?.message || error) });
}

const configPath = resolve(
  textReport?.configModelOverrideEvidence?.configPath
    || `${process.env.APPDATA || os.tmpdir()}/anticodex/codex-home-deepseek-app/config.toml`,
);
let mcpNames = [];
try {
  const config = readFileSync(configPath, "utf8");
  mcpNames = [...new Set([...config.matchAll(/^\[mcp_servers\.([^\.\]]+)/gm)].map((match) => match[1]))].sort();
  const developmentNames = mcpNames.filter((name) => developmentWorkers.includes(name));
  record("isolated_product_config_excludes_development_workers", mcpNames.includes("node_repl") && developmentNames.length === 0, {
    configPath,
    mcpNames,
    developmentNames,
  });
} catch (error) {
  record("isolated_product_config_excludes_development_workers", false, { configPath, error: String(error?.message || error) });
}

const uiState = runJson(process.execPath, [
  resolve(root, "scripts", "test-anticodex-ui-state.mjs"),
  "--fast", "true",
  "--skip-manager-action-probe", "true",
  "--manager-probe-timeout-ms", "10000",
  "--timeout-ms", "20000",
], 30_000);
record("official_shell_ui_and_current_model_visible", Boolean(
  uiState.ok
    && uiState.data?.target?.title === "Anti-Codex"
    && uiState.data?.selectedContextProbe?.version === "native-panel-v105"
    && uiState.data?.matchedModelText === expectedModelLabel
    && uiState.data?.managerPage?.hasZhLang === true
    && Number(uiState.data?.port) === Number(fixedHealth?.ports?.cdp || 18318),
), {
  status: uiState.status,
  error: uiState.error,
  title: uiState.data?.target?.title || "",
  version: uiState.data?.selectedContextProbe?.version || "",
  matchedModelText: uiState.data?.matchedModelText || "",
  cdpPort: uiState.data?.port ?? null,
});

const profileEntry = runJson(process.execPath, [
  resolve(root, "scripts", "test-anticodex-manager-button.mjs"),
  "--profile-entry-only", "true",
  "--timeout-ms", "30000",
  "--compact",
], 45_000);
record("profile_menu_uses_exact_chinese_manager_label", Boolean(
  profileEntry.ok
    && profileEntry.data?.profileEntry?.profileEntryText === "\u7ba1\u7406"
    && profileEntry.data.profileEntry.forbiddenEnglishVisible === false
    && profileEntry.data.profileEntry.actualMouseOpened === true,
), {
  status: profileEntry.status,
  error: profileEntry.error,
  profileEntryText: profileEntry.data?.profileEntry?.profileEntryText || "",
  forbiddenEnglishVisible: profileEntry.data?.profileEntry?.forbiddenEnglishVisible ?? null,
  actualMouseOpened: profileEntry.data?.profileEntry?.actualMouseOpened ?? null,
});

const closeButton = runJson(process.execPath, [
  resolve(root, "scripts", "test-anticodex-manager-button.mjs"),
  "--close-only", "true",
  "--timeout-ms", "30000",
  "--compact",
], 45_000);
const closeProbes = closeButton.data?.closeActualMouse?.probes || [];
record("manager_close_full_height_actual_mouse", Boolean(
  closeButton.ok
    && closeButton.data?.finalOverlayClosed === true
    && closeButton.data?.closeActualMouse?.finalOverlayClosed === true
    && closeProbes.length === 3
    && closeProbes.map((entry) => entry.name).join(",") === "upper-center,center,lower-center"
    && closeProbes.every((entry) => entry.ok === true && entry.closed === true && entry.hasTextNode === false && entry.webkitAppRegion === "no-drag"),
), {
  status: closeButton.status,
  error: closeButton.error,
  finalOverlayClosed: closeButton.data?.finalOverlayClosed === true,
  probes: closeProbes.map((entry) => ({
    name: entry.name,
    target: entry.target,
    closed: entry.closed,
    hasTextNode: entry.hasTextNode,
    webkitAppRegion: entry.webkitAppRegion,
  })),
});

const processHygiene = runJson(process.execPath, [
  resolve(root, "scripts", "test-anticodex-worker-process-hygiene.mjs"),
  "--report-root", reportRoot,
], 30_000);
const antiAppServers = (processHygiene.data?.appServers || []).filter((entry) => entry.kind === "anticodex-app-server");
record("one_anti_appserver_and_no_development_worker_multiplication", Boolean(
  processHygiene.ok
    && processHygiene.data?.workerProcessHygieneOk === true
    && processHygiene.data?.anticodexWorkerProcessCount === 0
    && processHygiene.data?.anticodexDuplicateWorkerProcessCount === 0
    && antiAppServers.length === 1
    && fixedHealth?.processes?.copiedClient?.includes(antiAppServers[0].parentPid),
), {
  status: processHygiene.status,
  error: processHygiene.error,
  anticodexWorkerProcessCount: processHygiene.data?.anticodexWorkerProcessCount ?? null,
  anticodexDuplicateWorkerProcessCount: processHygiene.data?.anticodexDuplicateWorkerProcessCount ?? null,
  antiAppServers,
  originalCodexWorkerProcessCountInformational: processHygiene.data?.codexWorkerProcessCount ?? null,
  originalCodexDuplicateWorkerProcessCountInformational: processHygiene.data?.codexDuplicateWorkerProcessCount ?? null,
});

const trayCapturePath = resolve(reportRoot, "gate5-live-tray-icon.png");
const trayIcon = runJson("powershell.exe", [
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", resolve(root, "scripts", "test-anticodex-live-tray-icon.ps1"),
  "-MinimumPinkPixels", "8",
  "-CapturePath", trayCapturePath,
], 30_000);
record("live_tray_icon_preserved", Boolean(
  trayIcon.ok
    && trayIcon.data?.name === "Anti-Codex"
    && Number(trayIcon.data?.pinkPixels || 0) >= 8
    && existsSync(trayCapturePath),
), {
  status: trayIcon.status,
  error: trayIcon.error,
  name: trayIcon.data?.name || "",
  pinkPixels: trayIcon.data?.pinkPixels ?? null,
  minimumPinkPixels: trayIcon.data?.minimumPinkPixels ?? 8,
  capturePath: trayCapturePath,
});

const failures = checks.filter((entry) => !entry.ok).map((entry) => entry.id);
const latestPath = resolve(reportRoot, "latest-gate5-visible-integration.json");
const historyPath = resolve(reportRoot, `${stamp()}-gate5-visible-integration.json`);
const reportPaths = { latest: latestPath, history: historyPath, audit: auditPath };
const payload = {
  schema: "anticodex-gate5-visible-integration-v1",
  reportName: "gate5-visible-integration",
  gate: 5,
  ok: failures.length === 0,
  gateComplete: failures.length === 0,
  checkedAt: new Date().toISOString(),
  requestedRealTraffic: false,
  usedRealTraffic: false,
  sourceEvidenceUsedRealTraffic: sourceDefinitions.every((definition) => sourceReports[definition.id]?.data?.usedRealTraffic === true),
  coverageKind: "visible-desktop-integration-aggregate",
  expectedModel,
  expectedModelLabel,
  sourceReports: Object.fromEntries(Object.entries(sourceReports).map(([id, entry]) => [id, {
    path: entry.path,
    sidecarPath: entry.sidecarPath,
    sha256: entry.sha256,
    signed: entry.signed,
    modifiedAt: entry.modifiedAt,
    ageMs: entry.ageMs,
    summary: entry.summary,
  }])),
  artifactEvidence,
  route: fixedHealth ? {
    state: fixedHealth.state,
    provider: fixedHealth.provider,
    model: fixedHealth.model,
    relayProtocol: fixedHealth.route?.relayProtocol || "",
    codexPlusPlusVersion: fixedHealth.component?.version || "",
    ports: fixedHealth.ports,
    processes: fixedHealth.processes,
  } : null,
  isolatedMcpConfig: { path: configPath, names: mcpNames, excludedDevelopmentWorkers: developmentWorkers.filter((name) => !mcpNames.includes(name)) },
  checks,
  failures,
  report: reportPaths,
};
const body = `${JSON.stringify(payload, null, 2)}\n`;
for (const path of [latestPath, historyPath, auditPath]) writeSignedAtomic(path, body);

if (compact) {
  console.log(JSON.stringify({
    ok: payload.ok,
    gateComplete: payload.gateComplete,
    checks: checks.length,
    passed: checks.length - failures.length,
    failures,
    model: payload.route?.model || "",
    codexPlusPlusVersion: payload.route?.codexPlusPlusVersion || "",
    anticodexWorkerProcessCount: processHygiene.data?.anticodexWorkerProcessCount ?? null,
    historyOpenLatencyMs: historyReport?.sameChatEvidence?.openLatencyMs ?? null,
    managerFinalOverlayClosed: closeButton.data?.finalOverlayClosed === true,
    report: reportPaths,
  }));
} else {
  console.log(JSON.stringify(payload));
}
process.exit(payload.ok ? 0 : 1);
