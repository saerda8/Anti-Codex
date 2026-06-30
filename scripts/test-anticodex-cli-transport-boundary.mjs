#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argValue(name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

const startedAt = Date.now();
const sourceRoot = resolve(argValue("--source-root", join(dirname(fileURLToPath(import.meta.url)), "..")));
const reportRoot = resolve(argValue("--report-root", process.env.APPDATA ? join(process.env.APPDATA, "anticodex", "reports") : join(process.cwd(), ".anticodex-reports")));
const baseUrl = String(argValue("--base-url", process.env.ANTICODEX_BASE_URL || "http://127.0.0.1:8484")).replace(/\/+$/g, "");
const timeoutMs = Number(argValue("--timeout-ms", "8000"));

function source(relativePath) {
  const path = resolve(sourceRoot, relativePath);
  return {
    relativePath,
    path,
    present: existsSync(path),
    text: existsSync(path) ? readFileSync(path, "utf8").replace(/^\uFEFF/, "") : "",
  };
}

function check(id, ok, evidence = {}) {
  return { id, ok: Boolean(ok), ...evidence };
}

function httpJson(url) {
  return new Promise((resolveRequest) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolveRequest({ ok: response.statusCode === 200, statusCode: response.statusCode, json: JSON.parse(body), error: "" });
        } catch (error) {
          resolveRequest({ ok: false, statusCode: response.statusCode, json: null, error: String(error?.message || error) });
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    request.on("error", (error) => {
      resolveRequest({ ok: false, statusCode: 0, json: null, error: String(error?.message || error) });
    });
  });
}

const launcher = source("scripts/start-anticodex.ps1");
const sharedLauncher = source("scripts/start-deepcodex.ps1");
const server = source("translator/adaptive-server.mjs");

const staticChecks = [
  check("launcher-present", launcher.present, { file: launcher.relativePath }),
  check("shared-launcher-present", sharedLauncher.present, { file: sharedLauncher.relativePath }),
  check("adaptive-server-present", server.present, { file: server.relativePath }),
  check("launcher-defaults-antigravity-transport-to-cli", /ANTICODEX_ANTIGRAVITY_TRANSPORT\s*=\s*"cli"/i.test(launcher.text), { file: launcher.relativePath }),
  check("launcher-has-desktop-requirement-function", /function Test-AntiCodexRequiresAntigravityDesktop/.test(launcher.text), { file: launcher.relativePath }),
  check("launcher-cli-transport-does-not-require-desktop", /transport\.ToLowerInvariant\(\) -ne "cli"/.test(launcher.text), { file: launcher.relativePath }),
  check("launcher-desktop-helper-is-guarded", /\. \$antigravityDesktopHelper/.test(launcher.text) && /if \(Test-AntiCodexRequiresAntigravityDesktop \$antiCodexUsesAntigravity\)/.test(launcher.text), { file: launcher.relativePath }),
  check("launcher-cli-status-says-desktop-not-required", /Antigravity CLI model text transport; Antigravity Desktop is not required/.test(launcher.text), { file: launcher.relativePath }),
  check("shared-launcher-has-desktop-requirement-function", /function Test-AntiCodexRequiresAntigravityDesktop/.test(sharedLauncher.text), { file: sharedLauncher.relativePath }),
  check("shared-launcher-cli-transport-does-not-require-desktop", /transport\.ToLowerInvariant\(\) -ne "cli"/.test(sharedLauncher.text), { file: sharedLauncher.relativePath }),
  check("shared-launcher-watchdog-bails-for-cli-transport", /if \(-not \(Test-AntiCodexRequiresAntigravityDesktop\)\) \{ return \$true \}/.test(sharedLauncher.text), { file: sharedLauncher.relativePath }),
  check("adaptive-server-splits-model-text-transport", /modelTextTransport/.test(server.text) && /process\.env\.ANTICODEX_ANTIGRAVITY_TRANSPORT \|\| "cli"/.test(server.text), { file: server.relativePath }),
  check("adaptive-server-reports-cli-catalog", /function antigravityModelDiscoverySource/.test(server.text) && /antigravity-cli-catalog/.test(server.text), { file: server.relativePath }),
  check("adaptive-server-keeps-antigravity-coworker-disabled", /antigravityCoworkerDefault:\s*false/.test(server.text), { file: server.relativePath }),
];

const healthResult = await httpJson(`${baseUrl}/health`);
const health = healthResult.json || {};
const healthChecks = [
  check("health-reachable", healthResult.ok, { baseUrl, statusCode: healthResult.statusCode, error: healthResult.error }),
  check("health-antigravity-context", healthResult.ok && (health.mode === "antigravity" || health.upstream === "antigravity-desktop"), { mode: String(health.mode || ""), upstream: String(health.upstream || "") }),
  check("health-model-text-transport-cli", healthResult.ok && health.modelTextTransport === "cli", { modelTextTransport: String(health.modelTextTransport || "") }),
  check("health-model-discovery-cli-catalog", healthResult.ok && health.modelDiscoverySource === "antigravity-cli-catalog", { modelDiscoverySource: String(health.modelDiscoverySource || "") }),
  check("health-antigravity-coworker-disabled", healthResult.ok && health.antigravityCoworkerDefault === false, { antigravityCoworkerDefault: health.antigravityCoworkerDefault }),
  check("health-model-catalog-present", healthResult.ok && Number(health.modelCount || 0) > 0, { modelCount: Number(health.modelCount || 0) }),
];

const allChecks = [...staticChecks, ...healthChecks];
const failures = allChecks.filter((item) => item.ok !== true).map((item) => item.id);

const payload = {
  ok: failures.length === 0,
  reportName: "cli-transport-boundary",
  requestedRealTraffic: false,
  usedRealTraffic: false,
  behaviorCovered: true,
  coverageKind: "cli-transport-boundary-report-only",
  sourceRoot,
  reportRoot,
  baseUrl,
  staticChecks,
  healthChecks,
  cliTransportBoundaryComplete: failures.length === 0,
  modelTextTransport: String(health.modelTextTransport || ""),
  modelDiscoverySource: String(health.modelDiscoverySource || ""),
  antigravityCoworkerDefault: health.antigravityCoworkerDefault === false,
  antigravityDesktopRequiredForCliTransport: false,
  antigravityDesktopProcessAbsenceRequired: false,
  desktopProcessObservationPolicy: "not-required; user or MCP account lanes may have their own Antigravity Desktop process",
  codexOwnedTools: true,
  antigravityModelTextOnly: true,
  failures,
  elapsedMs: Date.now() - startedAt,
};

mkdirSync(reportRoot, { recursive: true });
const latest = resolve(reportRoot, "latest-cli-transport-boundary.json");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
const history = resolve(reportRoot, `${stamp}-cli-transport-boundary.json`);
const body = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
for (const file of [latest, history]) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, body, "utf8");
  renameSync(temp, file);
  writeFileSync(`${file}.sha256`, `${createHash("sha256").update(body).digest("hex")}\n`, "ascii");
}

console.log(JSON.stringify({ ...payload, report: { latest, history } }));
if (!payload.ok) process.exit(1);
