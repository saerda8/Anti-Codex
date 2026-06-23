#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("--port") || process.env.DEEPCODEX_CDP_PORT || 58317);
const baseUrl = String(args.get("--base-url") || process.env.ANTICODEX_MANAGER_API || process.env.TRANSLATOR_URL || "http://127.0.0.1:8484").replace(/\/$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = options.body ? Buffer.from(options.body) : null;
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method || "GET",
      timeout: options.timeout || 120000,
      headers: { ...(options.headers || {}), ...(body ? { "content-length": body.length } : {}) },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(json?.error?.message || text || `HTTP ${response.statusCode}`));
          return;
        }
        resolve(json);
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Timed out: ${url}`)));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

class LocalWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.onEvent = null;
    this.onClose = null;
  }
  async open() {
    const key = crypto.randomBytes(16).toString("base64");
    this.socket = net.createConnection({ host: this.url.hostname, port: Number(this.url.port) });
    this.socket.on("close", () => this.onClose?.());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out opening ${this.url.href}`)), 5000);
      this.socket.once("connect", () => {
        this.socket.write([
          `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
          `Host: ${this.url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      });
      const onHandshake = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const split = this.buffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const header = this.buffer.slice(0, split).toString("utf8");
        this.buffer = this.buffer.slice(split + 4);
        this.socket.off("data", onHandshake);
        this.socket.on("data", (data) => this.onData(data));
        clearTimeout(timer);
        if (!/^HTTP\/1.1 101\b/.test(header)) reject(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
        else resolve();
      };
      this.socket.on("data", onHandshake);
      this.socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseFrames();
  }
  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = this.buffer.readUInt32BE(offset + 4);
        offset += 8;
      }
      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      let payload = this.buffer.slice(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = this.buffer.slice(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.slice(offset + maskLength + length);
      if ((first & 0x0f) !== 0x1) continue;
      const message = JSON.parse(payload.toString("utf8"));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message);
      } else if (message.method) {
        this.onEvent?.(message);
      }
    }
  }
  sendText(text) {
    const payload = Buffer.from(text, "utf8");
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  call(id, method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.sendText(JSON.stringify({ id, method, params }));
    });
  }
}

async function cdpTargets() {
  return httpJson(`http://127.0.0.1:${port}/json`, { timeout: 3000 });
}

function pickTarget(targets) {
  return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl && `${target.title} ${target.url}`.toLowerCase().includes("codex"))
    || targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
}

async function managerSnapshot() {
  const responses = {};
  const errors = {};
  for (const path of [
    "/anticodex/manager/bootstrap",
    "/health",
    "/models",
    "/anticodex/diagnostics",
    "/anticodex/upstream-profile",
    "/backend-api/ps/plugins/installed",
    "/backend-api/aip/connectors",
    "/backend-api/plugins/list",
  ]) {
    try { responses[path] = await httpJson(`${baseUrl}${path}`, { timeout: 10000 }); }
    catch (error) { errors[path] = error.message; }
  }
  try { responses["/backend-api/wham/apps"] = await httpJson(`${baseUrl}/backend-api/wham/apps`, { method: "POST", timeout: 10000, body: "{}" }); }
  catch (error) { errors["/backend-api/wham/apps"] = error.message; }
  responses["/backend-api/ps/plugins/installed"] ||= { plugins: [] };
  responses["/backend-api/aip/connectors"] ||= { connectors: [] };
  responses["/backend-api/plugins/list"] ||= { plugins: [] };
  responses["/backend-api/wham/apps"] ||= { tools: [] };
  return { ok: Boolean(responses["/health"]), baseUrl, responses, errors };
}

async function runAction(action) {
  if (action === "refreshStatus") return { ok: true, action, result: { ok: true }, snapshot: await managerSnapshot() };
  if (action === "refreshModels") {
    return { ok: true, action, result: await httpJson(`${baseUrl}/anticodex/models/refresh`, { method: "POST", timeout: 120000 }) };
  }
  const bootstrap = await httpJson(`${baseUrl}/anticodex/manager/bootstrap`, {
    timeout: 10000,
    headers: {
      origin: baseUrl,
      referer: `${baseUrl}/anticodex/manager`,
    },
  });
  return httpJson(`${baseUrl}/anticodex/manager/action`, {
    method: "POST",
    timeout: 180000,
    headers: {
      "content-type": "application/json",
      "x-anticodex-manager-token": bootstrap.token,
      origin: baseUrl,
      referer: `${baseUrl}/anticodex/manager`,
    },
    body: JSON.stringify({ action }),
  });
}

function reportSummaryLines(result) {
  const r = result || {};
  const report = r.report || {};
  return [
    r.reportName ? `\u8bc1\u636e\uff1a${r.reportName}` : "",
    report.latest ? `\u6700\u65b0\u62a5\u544a\uff1a${report.latest}` : "",
    report.history ? `\u5386\u53f2\u62a5\u544a\uff1a${report.history}` : "",
  ].filter(Boolean);
}

function failureSummaryLine(result) {
  const failures = Array.isArray(result?.failures) ? result.failures.filter(Boolean) : [];
  if (!failures.length) return "";
  return `\u5931\u8d25\u9879\uff1a${failures.length}\n${failures.slice(0, 3).join("\n")}`;
}

function formatReportAge(ageMs) {
  const numericAge = Number(ageMs);
  if (!Number.isFinite(numericAge)) return "";
  const seconds = Math.max(0, Math.round(numericAge / 1000));
  if (seconds < 60) return `${seconds} \u79d2\u524d`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} \u5206\u949f\u524d`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} \u5c0f\u65f6\u524d`;
  return `${Math.round(hours / 24)} \u5929\u524d`;
}

function latestReportsSummary(result) {
  const reports = Array.isArray(result?.reports) ? result.reports : [];
  if (!reports.length) return "\u8fd8\u6ca1\u6709\u53ef\u663e\u793a\u7684\u9a8c\u6536\u62a5\u544a\u3002\n\u53ef\u5148\u8fd0\u884c\u201c\u5feb\u901f\u603b\u68c0\u201d\u6216\u201c\u7a33\u5b9a\u6027\u5de1\u68c0\u201d\u751f\u6210\u62a5\u544a\u3002";
  const lines = [
    `\u62a5\u544a\u76ee\u5f55\uff1a${result.reportRoot || "\u672a\u77e5"}`,
    `\u5df2\u627e\u5230\uff1a${result.existingCount ?? reports.filter((item) => item.exists).length} \u4efd`,
  ];
  if (result.staleCount) lines.push(`\u9700\u91cd\u8dd1\uff1a${result.staleCount} \u4efd\u62a5\u544a\u5df2\u8fc7\u671f`);
  if (result.missingCount) lines.push(`\u672a\u751f\u6210\uff1a${result.missingCount} \u4efd`);
  if (result.invalidCount) lines.push(`\u635f\u574f\u62a5\u544a\uff1a${result.invalidCount} \u4efd\u65e0\u6cd5\u8bfb\u53d6`);
  if (!(result.existingCount ?? reports.filter((item) => item.exists).length)) {
    lines.push("\u63d0\u793a\uff1a\u8bf7\u5148\u8fd0\u884c\u5feb\u901f\u603b\u68c0\u3001\u5b8c\u6574\u603b\u68c0\u6216\u7a33\u5b9a\u6027\u5de1\u68c0\u3002");
  }
  for (const item of reports) {
    const status = item.exists ? ((item.parseable === false || item.invalid) ? "\u62a5\u544a\u635f\u574f" : (item.stale ? "\u9700\u91cd\u8dd1" : (item.ok ? "\u901a\u8fc7" : "\u9700\u5904\u7406"))) : "\u672a\u751f\u6210";
    const elapsed = item.elapsedMs != null ? ` / ${item.elapsedMs} ms` : "";
    lines.push(`${item.label}\uff1a${status}${elapsed}`);
    const age = formatReportAge(item.ageMs);
    if (item.exists && age) lines.push(`  \u66f4\u65b0\uff1a${age}`);
    if (item.firstFailure) lines.push(`  \u9996\u4e2a\u5931\u8d25\uff1a${item.firstFailure}`);
    if (item.publicDocumentationOk !== null && item.publicDocumentationOk !== undefined) lines.push(`  \u516c\u5f00\u6587\u6863\uff1a${item.publicDocumentationOk ? "\u901a\u8fc7" : "\u9700\u5904\u7406"}`);
    if (item.releaseReady !== null && item.releaseReady !== undefined) {
      lines.push(`  Release Gate: short=${item.shortReady ? "true" : "false"} / release=${item.releaseReady ? "true" : "false"}`);
      if (Array.isArray(item.missingRequired) && item.missingRequired.length) lines.push(`  missingRequired: ${item.missingRequired.slice(0, 6).join(", ")}`);
      if (Array.isArray(item.missingShort) && item.missingShort.length) lines.push(`  missingShort: ${item.missingShort.slice(0, 6).join(", ")}`);
      if (Array.isArray(item.damagedReports) && item.damagedReports.length) lines.push(`  damagedReports: ${item.damagedReports.slice(0, 6).join(", ")}`);
      if (Array.isArray(item.releaseGateGroups) && item.releaseGateGroups.length) {
        const groupSummary = item.releaseGateGroups.slice(0, 8).map((group) => `${group.group} req ${group.requiredSatisfied ?? 0}/${group.required ?? 0} opt ${group.optionalSatisfied ?? 0}/${group.optional ?? 0}`).join(" | ");
        lines.push(`  Release groups: ${groupSummary}`);
      }
    }
    if (Array.isArray(item.releaseGateFailures) && item.releaseGateFailures.length) {
      const gateFailures = item.releaseGateFailures.slice(0, 4).map((gate) => {
        const details = Array.isArray(gate.semanticFailures) && gate.semanticFailures.length ? gate.semanticFailures.slice(0, 4).join(", ") : (gate.error || "unsatisfied");
        return `${gate.id}:${details}`;
      });
      lines.push(`  semanticFailures: ${gateFailures.join(" | ")}`);
    }
    if (item.sourcePreflightEvidence) {
      const evidence = item.sourcePreflightEvidence;
      lines.push(`  sourcePreflight: js=${evidence.javascriptSyntaxOk ? "true" : "false"} / ps=${evidence.powershellSyntaxOk ? "true" : "false"} / profile=${evidence.upstreamProfileStorageOk ? "true" : "false"} / docs=${evidence.publicDocumentationOk ? "true" : "false"}`);
      lines.push(`  sourcePreflight: ui=${evidence.uiStateSelfTestOk ? "true" : "false"} / regression=${evidence.translatorRegressionOk ? "true" : "false"} / diff=${evidence.diffWhitespaceOk ? "true" : "false"} / skipFull=${evidence.skipFullRegression ? "true" : "false"}`);
    }
    if (item.modelThinkingEvidence) {
      const evidence = item.modelThinkingEvidence;
      lines.push(`  modelThinking: models=${evidence.actualModelCount ?? "\u672a\u77e5"}/${evidence.expectedModelCount ?? "\u672a\u77e5"} / thinking=${evidence.supportsThinkingCount ?? 0}/${evidence.modelCount ?? 0} / budgetMissing=${evidence.missingBudgetCount ?? 0}`);
      if (Array.isArray(evidence.reasoningLevels) && evidence.reasoningLevels.length) lines.push(`  modelThinking levels: ${evidence.reasoningLevels.join(", ")}`);
    }
    if (item.mcpSkillEvidence) {
      const evidence = item.mcpSkillEvidence;
      const clean = evidence.mcpMissingSharedCount === 0 && evidence.missingSharedSkillCount === 0 && evidence.hasNodeRepl === true && evidence.skillSmokeReadable === true;
      lines.push(`  MCP/Skill \u8bc1\u636e\uff1aMCP ${evidence.mcpCount ?? "\u672a\u77e5"}/${evidence.mcpSharedCount ?? "\u672a\u77e5"} / skills ${evidence.skillCount ?? "\u672a\u77e5"}/${evidence.expectedSharedSkillCount ?? "\u672a\u77e5"} / parity ${clean ? "\u5e72\u51c0" : "\u9700\u5904\u7406"}`);
    }
    if (item.localConnectorEvidence) {
      const evidence = item.localConnectorEvidence;
      lines.push(`  \u8fde\u63a5\u5668\u8bc1\u636e\uff1aChatGPT URL ${evidence.chatgptInstallUrlsScrubbed ? "\u5df2\u6e05\u7406" : "\u9700\u5904\u7406"} / \u4e0a\u6e38\u8bf7\u6c42 ${evidence.upstreamRequestsDuringLocalEndpoints ?? "\u672a\u77e5"} / allowlist ${evidence.allowlistedConnectorAccessible ? "\u88ab\u5f53\u6210\u6388\u6743" : "\u4e0d\u7b49\u4e8e\u6388\u6743"}`);
      if (Array.isArray(evidence.exposedToolNames) && evidence.exposedToolNames.length) lines.push(`  \u53ef\u89c1\u5de5\u5177\uff1a${evidence.exposedToolNames.join(", ")}`);
    }
    if (item.pluginCapabilityEvidence) {
      const evidence = item.pluginCapabilityEvidence;
      const parityClean = evidence.connectorParityClean === true && evidence.appToolParityClean === true && evidence.appToolGetPostParityClean === true;
      lines.push(`  \u5e94\u7528\u5de5\u5177\u8bc1\u636e\uff1a\u672a\u6388\u6743\u5de5\u5177 ${evidence.unauthorizedAppToolCount ?? "\u672a\u77e5"} / \u65e0 connector_id ${evidence.unattributedAppToolCount ?? "\u672a\u77e5"} / parity ${parityClean ? "\u5e72\u51c0" : "\u9700\u5904\u7406"}`);
      lines.push(`  \u539f\u751f Codex \u5199\u56de\uff1a${evidence.nativeCodexWriteback ? "\u9700\u5904\u7406" : "\u65e0"}`);
    }
    if (item.optionalRealProviderEvidence) {
      const evidence = item.optionalRealProviderEvidence;
      lines.push(`  realProvider: first=${evidence.firstMarkerObserved ? "true" : "false"} / second=${evidence.secondMarkerObserved ? "true" : "false"} / history=${evidence.historyContinuationObserved ? "true" : "false"} / turns=${evidence.turns ?? "\u672a\u77e5"}`);
      lines.push(`  realProvider route: ${evidence.routeTransport || "\u672a\u77e5"} / ${evidence.routeProviderProtocol || "\u672a\u77e5"} / ${evidence.routeResolvedModel || "\u672a\u77e5"} / ${evidence.routeStatus || "\u672a\u77e5"}`);
    }
    if (item.antigravityReturnEvidence) {
      const evidence = item.antigravityReturnEvidence;
      lines.push(`  antigravityReturn: history=${evidence.returnedToAntigravityWithHistory ? "true" : "false"} / previousId=${evidence.previousResponseIdMatched ? "true" : "false"} / markers=${evidence.markerCount ?? "\u672a\u77e5"} missing=${evidence.missingMarkerCount ?? "\u672a\u77e5"}`);
    }
    if (item.coldRelaunchEvidence) {
      const evidence = item.coldRelaunchEvidence;
      lines.push(`  coldRelaunch: health=${evidence.healthOk ? "true" : "false"} / ready=${evidence.providerReady ? "true" : "false"} / main=${evidence.mainCount ?? "?"} / translator=${evidence.translatorCount ?? "?"} / originalCodex=${evidence.originalCodexUnchanged ? "unchanged" : "unknown"}`);
    }
    if (item.stabilitySoakEvidence) {
      const evidence = item.stabilitySoakEvidence;
      lines.push(`  stabilitySoak: ready=${evidence.providerReady && evidence.startReady && evidence.endReady ? "true" : "false"} / model=${evidence.model || "\u672a\u77e5"} / pidStable=${evidence.pidStable ? "true" : "false"} / healthChecks=${evidence.healthChecks ?? "?"} / turns=${evidence.turnCount ?? "?"} failed=${evidence.failedTurnCount ?? "?"}`);
    }
    if (item.exists && item.latestPath) lines.push(`  \u6587\u4ef6\uff1a${item.latestPath}`);
  }
  return lines.join("\n");
}

function managerSummary(action, payload) {
  const result = payload?.result || payload || {};
  const unwrappedResult = result?.result && typeof result.result === "object" ? result.result : result;
  if (action === "refreshStatus") return `\u72b6\u6001\u5237\u65b0\uff1a${result.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`;
  if (action === "refreshModels") return `\u6a21\u578b\u5237\u65b0\uff1a${result.ok ? "\u5b8c\u6210" : "\u5931\u8d25"}\n\u6a21\u578b\u6570\uff1a${result.modelCount ?? result.models?.length ?? "\u672a\u77e5"}`;
  if (action === "resetAntigravitySessionLock") return [
    "Antigravity \u4f1a\u8bdd\u9501\u5df2\u91cd\u7f6e\u3002",
    `\u5df2\u91ca\u653e\u6b63\u5728\u8fd0\u884c\u7684\u4f1a\u8bdd\uff1a${result.activeReleased ? "\u662f" : "\u5426"}`,
    `\u5df2\u53d6\u6d88\u6392\u961f\u4f1a\u8bdd\uff1a${result.queuedCancelled ?? 0}`,
  ].join("\n");
  if (action === "accountSwitch") return [
    "\u5df2\u6253\u5f00 Antigravity \u684c\u9762\u7aef\u3002",
    "\u8bf7\u5728 Antigravity \u4e2d\u5207\u6362\u8d26\u53f7\uff0c\u5b8c\u6210\u540e\u56de\u5230 Anti-Codex \u70b9\u201c\u5237\u65b0\u6a21\u578b\u201d\u3002",
    result.nextAction === "refreshModels" ? "\u4e0b\u4e00\u6b65\uff1a\u5237\u65b0\u6a21\u578b" : "",
  ].filter(Boolean).join("\n");
  if (action === "updateCheck") return `Codex \u66f4\u65b0\u68c0\u67e5\uff1a${result.updateNeeded ? "\u53d1\u73b0\u65b0\u7248" : "\u5df2\u662f\u6700\u65b0"}`;
  if (action === "syncReadiness") return [
    `\u5b89\u88c5/\u540c\u6b65\u68c0\u67e5\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
    failureSummaryLine(result),
  ].filter(Boolean).join("\n");
  if (action === "repairShortcuts") return [
    `\u5feb\u6377\u65b9\u5f0f\u4fee\u590d\uff1a${result.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`,
    `\u5df2\u4fee\u590d\uff1a${result.repairedCount ?? result.shortcuts?.length ?? "\u672a\u77e5"}`,
    failureSummaryLine(result),
  ].filter(Boolean).join("\n");
  if (action === "mcpSkills") return [
    `MCP/Skill \u6e05\u5355\u53ef\u89c1\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
    `MCP ${result.mcp?.count ?? "\u672a\u77e5"} / Skill ${result.skills?.count ?? "\u672a\u77e5"}`,
    `\u771f\u5b9e\u5de5\u5177\u8c03\u7528\uff1anode_repl ${result.mcp?.smoke?.realCall?.passed ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}\uff0cSkill \u6587\u4ef6 ${result.skills?.smoke?.readable ? "\u53ef\u8bfb" : "\u672a\u8bfb\u5230"}`,
  ].join("\n");
  if (action === "pluginCapabilities") {
    const capabilities = result.capabilities || {};
    const appTools = capabilities.appToolCount ?? 0;
    return [
      `\u63d2\u4ef6/\u5e94\u7528\u6e05\u5355\u53ef\u89c1\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
      `\u5df2\u5b89\u88c5\u63d2\u4ef6 ${capabilities.installedPluginCount ?? "\u672a\u77e5"} / \u8fde\u63a5\u5668 ${capabilities.connectorCount ?? "\u672a\u77e5"}`,
      `\u6295\u5f71 smoke\uff1a${capabilities.smoke?.endpointProjectionReadable ? "\u7aef\u70b9\u53ef\u8bfb" : "\u7aef\u70b9\u672a\u8bfb\u5230"}\uff0c\u7f13\u5b58 ${capabilities.smoke?.connectorCache?.sampleReadable ? "\u53ef\u8bfb" : "\u672a\u8bfb\u5230"}`,
      `\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a${appTools > 0 ? `\u5e94\u7528\u5de5\u5177 ${appTools}` : "\u672a\u6388\u6743\u8fde\u63a5\u5668\uff0c\u4e0d\u4f2a\u88c5\u53ef\u8c03\u7528\uff08\u6b63\u5e38\uff09"}`,
      capabilities.appToolsNote ? `\u8bf4\u660e\uff1a${capabilities.appToolsNote}` : "",
    ].filter(Boolean).join("\n");
  }
  if (action === "refreshFeatures" && payload?.background) return payload?.alreadyRunning ? "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u8bf7\u7a0d\u540e\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u6216 MCP/Skill\u3001\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838\u3002" : "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u5f00\u59cb\u540e\u53f0\u6267\u884c\u3002\n\u754c\u9762\u4e0d\u4f1a\u7b49\u5f85\u957f\u65f6\u590d\u5236\uff1b\u5b8c\u6210\u540e\u7528 MCP/Skill \u548c\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838\u3002";
  if (action === "refreshFeatures") return `\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a${result.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}\nSkill ${result.skills?.count ?? "\u672a\u77e5"} / \u8fde\u63a5\u5668\u7f13\u5b58 ${result.connectors?.count ?? "\u672a\u77e5"}\n\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a\u5237\u65b0\u540e\u4ecd\u9700\u5355\u72ec smoke \u9a8c\u8bc1`;
  if (action === "stabilitySoak") {
    if (payload.alreadyRunning) return "\u7a33\u5b9a\u6027\u5de1\u68c0\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u5b83\u4f1a\u6d88\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff1b\u8bf7\u7a0d\u540e\u70b9\u201c\u67e5\u770b\u6700\u65b0\u62a5\u544a\u201d\u786e\u8ba4\u7ed3\u679c\u3002";
    return `${payload.ok ? "\u5df2\u5728\u540e\u53f0\u5f00\u59cb\u7a33\u5b9a\u6027\u5de1\u68c0\u3002" : "\u542f\u52a8\u7a33\u5b9a\u6027\u5de1\u68c0\u5931\u8d25\u3002"}\n\u8fd9\u4f1a\u6d88\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff0c\u5b8c\u6210\u540e\u4f1a\u5199\u5165 latest-stability-soak.json\u3002`;
  }
  if (action === "syncHost") return payload?.alreadyRunning ? "\u540c\u6b65\u5df2\u5728\u540e\u53f0\u8fd0\u884c" : "\u5df2\u5f00\u59cb\u540e\u53f0\u540c\u6b65 Codex \u66f4\u65b0";
  if (action === "diagnosticsBundle") return [
    `\u8bca\u65ad\u5305\uff1a${unwrappedResult.ok ?? result.ok ? "\u5df2\u751f\u6210" : "\u5931\u8d25"}`,
    unwrappedResult.zipPath ? `ZIP\uff1a${unwrappedResult.zipPath}` : "",
    unwrappedResult.bundleRoot ? `\u76ee\u5f55\uff1a${unwrappedResult.bundleRoot}` : "",
    failureSummaryLine(unwrappedResult),
    (!unwrappedResult.zipPath && !unwrappedResult.bundleRoot && !unwrappedResult.failures?.length) ? (payload?.message || result.message || "") : "",
  ].filter(Boolean).join("\n");
  if (action === "viewLatestReports") return latestReportsSummary(result);
  if (action === "fastOverallNoTraffic") return [
    `\u5feb\u901f\u68c0\u67e5\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
    `\u8017\u65f6\uff1a${result.elapsedMs ?? "\u672a\u77e5"} ms`,
    ...reportSummaryLines(result),
    failureSummaryLine(result),
  ].filter(Boolean).join("\n");
  if (action === "overallNoTraffic") return [
    `\u6574\u4f53\u68c0\u67e5\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
    `\u8017\u65f6\uff1a${result.elapsedMs ?? "\u672a\u77e5"} ms`,
    ...reportSummaryLines(result),
    failureSummaryLine(result),
  ].filter(Boolean).join("\n");
  if (action === "postVerificationFull") return "\u5df2\u5f00\u59cb\u540e\u53f0\u5b8c\u6574\u9a8c\u8bc1";
  return JSON.stringify(result, null, 2);
}

if (args.has("--self-test")) {
  const okSummary = latestReportsSummary({
    reportRoot: "C:\\tmp\\anticodex\\reports",
    existingCount: 1,
    reports: [{
      label: "\u6e90\u7801\u9884\u68c0",
      exists: true,
      ok: true,
      elapsedMs: 18000,
      publicDocumentationOk: true,
      latestPath: "latest-source-preflight.json",
    }],
  });
  assert.match(okSummary, /\u516c\u5f00\u6587\u6863\uff1a\u901a\u8fc7/);
  assert.match(okSummary, /\u6e90\u7801\u9884\u68c0\uff1a\u901a\u8fc7/);

  const failingSummary = latestReportsSummary({
    reportRoot: "C:\\tmp\\anticodex\\reports",
    existingCount: 1,
    reports: [{
      label: "\u6e90\u7801\u9884\u68c0",
      exists: true,
      ok: false,
      publicDocumentationOk: false,
      firstFailure: "public docs mismatch",
    }],
  });
  assert.match(failingSummary, /\u516c\u5f00\u6587\u6863\uff1a\u9700\u5904\u7406/);
  assert.match(failingSummary, /public docs mismatch/);

  const connectorSummary = latestReportsSummary({
    reportRoot: "C:\\tmp\\anticodex\\reports",
    existingCount: 2,
    reports: [{
      label: "\u672c\u5730\u8fde\u63a5\u5668\u68c0\u67e5",
      exists: true,
      ok: true,
      localConnectorEvidence: {
        chatgptInstallUrlsScrubbed: true,
        allowlistedConnectorAccessible: false,
        upstreamRequestsDuringLocalEndpoints: 0,
        exposedToolNames: ["linked_tool"],
      },
    }, {
      label: "\u63d2\u4ef6/\u5e94\u7528\u68c0\u67e5",
      exists: true,
      ok: true,
      pluginCapabilityEvidence: {
        nativeCodexWriteback: false,
        unauthorizedAppToolCount: 0,
        unattributedAppToolCount: 0,
        connectorParityClean: true,
        appToolParityClean: true,
        appToolGetPostParityClean: true,
      },
    }],
  });
  assert.match(connectorSummary, /\u8fde\u63a5\u5668\u8bc1\u636e/);
  assert.match(connectorSummary, /\u4e0a\u6e38\u8bf7\u6c42 0/);
  assert.match(connectorSummary, /\u5e94\u7528\u5de5\u5177\u8bc1\u636e/);
  assert.match(connectorSummary, /\u672a\u6388\u6743\u5de5\u5177 0/);
  const evidenceSummary = latestReportsSummary({
    reportRoot: "C:\\tmp\\anticodex\\reports",
    existingCount: 6,
    reports: [{
      label: "Release Gate",
      exists: true,
      ok: true,
      releaseReady: true,
      shortReady: true,
      missingShort: ["latest-ui-idle.json"],
      damagedReports: ["latest-native-tool-loop.json"],
      releaseGateGroups: [{ group: "cold", required: 0, requiredSatisfied: 0, optional: 1, optionalSatisfied: 0 }],
      releaseGateFailures: [{ id: "ui-idle", semanticFailures: ["ui_idle_missing_samples"] }],
    }, {
      label: "\u6a21\u578b\u601d\u8003\u9884\u7b97",
      exists: true,
      ok: true,
      modelThinkingEvidence: { expectedModelCount: 2, actualModelCount: 2, modelCount: 2, supportsThinkingCount: 2, missingBudgetCount: 0, reasoningLevels: ["high", "low"] },
    }, {
      label: "\u6e90\u7801\u9884\u68c0",
      exists: true,
      ok: true,
      sourcePreflightEvidence: { javascriptSyntaxOk: true, powershellSyntaxOk: true, upstreamProfileStorageOk: true, publicDocumentationOk: true, uiStateSelfTestOk: true, translatorRegressionOk: true, diffWhitespaceOk: true, skipFullRegression: false },
    }, {
      label: "MCP/Skill",
      exists: true,
      ok: true,
      mcpSkillEvidence: { mcpCount: 3, mcpSharedCount: 3, skillCount: 126, expectedSharedSkillCount: 126, mcpMissingSharedCount: 0, missingSharedSkillCount: 0, hasNodeRepl: true, skillSmokeReadable: true },
    }, {
      label: "\u51b7\u542f\u52a8",
      exists: true,
      ok: true,
      coldRelaunchEvidence: { healthOk: true, providerReady: true, mainCount: 1, translatorCount: 1, originalCodexUnchanged: true },
    }, {
      label: "\u7a33\u5b9a\u6027",
      exists: true,
      ok: true,
      stabilitySoakEvidence: { providerReady: true, startReady: true, endReady: true, model: "gemini", pidStable: true, healthChecks: 5, turnCount: 2, failedTurnCount: 0 },
    }, {
      label: "\u53ef\u9009\u771f\u5b9e\u7b2c\u4e09\u65b9",
      exists: true,
      ok: true,
      optionalRealProviderEvidence: { firstMarkerObserved: true, secondMarkerObserved: true, historyContinuationObserved: true, turns: 2, routeTransport: "upstream-provider", routeProviderProtocol: "openai-compatible", routeResolvedModel: "real-model", routeStatus: "success" },
    }, {
      label: "\u56de\u5230 Antigravity",
      exists: true,
      ok: true,
      antigravityReturnEvidence: { returnedToAntigravityWithHistory: true, previousResponseIdMatched: true, markerCount: 6, missingMarkerCount: 0 },
    }],
  });
  assert.match(evidenceSummary, /Release Gate: short=true \/ release=true/);
  assert.match(evidenceSummary, /Release groups: cold req 0\/0 opt 0\/1/);
  assert.match(evidenceSummary, /missingShort: latest-ui-idle\.json/);
  assert.match(evidenceSummary, /damagedReports: latest-native-tool-loop\.json/);
  assert.match(evidenceSummary, /semanticFailures: ui-idle:ui_idle_missing_samples/);
  assert.match(evidenceSummary, /modelThinking: models=2\/2 \/ thinking=2\/2 \/ budgetMissing=0/);
  assert.match(evidenceSummary, /modelThinking levels: high, low/);
  assert.match(evidenceSummary, /sourcePreflight: js=true \/ ps=true \/ profile=true \/ docs=true/);
  assert.match(evidenceSummary, /sourcePreflight: ui=true \/ regression=true \/ diff=true \/ skipFull=false/);
  assert.match(evidenceSummary, /MCP\/Skill/);
  assert.match(evidenceSummary, /realProvider route: upstream-provider \/ openai-compatible \/ real-model \/ success/);
  assert.match(evidenceSummary, /antigravityReturn: history=true \/ previousId=true/);
  assert.match(evidenceSummary, /coldRelaunch: health=true \/ ready=true/);
  assert.match(evidenceSummary, /stabilitySoak: ready=true/);
  console.log(JSON.stringify({ ok: true, selfTest: true }));
  process.exit(0);
}

async function main() {
  const deadline = Date.now() + 45000;
  let target = null;
  while (!target && Date.now() < deadline) {
    try {
      target = pickTarget(await cdpTargets());
      if (target) break;
    } catch {}
    await sleep(500);
  }
  if (!target) throw new Error("No Anti-Codex page target found.");

  const ws = new LocalWebSocket(target.webSocketDebuggerUrl);
  await ws.open();
  ws.onClose = () => process.exit(0);
  let id = 1;

  const bridgeSource = `
(() => {
  globalThis.__ANTICODEX_MANAGER_BRIDGE_READY__ = true;
  globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__ ||= {};
  globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__ ||= [];
  globalThis.__ANTICODEX_RESOLVE_MANAGER_ACTION__ = (id, payload) => {
    const entry = globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__?.[id];
    if (!entry) return;
    delete globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__[id];
    entry.resolve(payload);
  };
  globalThis.__ANTICODEX_RUN_MANAGER_ACTION__ = (action) => new Promise((resolve) => {
    const id = Date.now() + ":" + Math.random().toString(36).slice(2);
    globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__[id] = { resolve };
    globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__.push({ id, action });
  });
})();`;

  await ws.call(id++, "Runtime.enable");
  await ws.call(id++, "Page.addScriptToEvaluateOnNewDocument", { source: bridgeSource });
  await ws.call(id++, "Runtime.evaluate", { expression: bridgeSource, awaitPromise: false, allowUnsafeEvalBlockedByCSP: true });
  console.log(JSON.stringify({ ok: true, port, baseUrl, target: { id: target.id, title: target.title, url: target.url } }));

  async function evaluate(expression, timeout = 30000) {
    return ws.call(id++, "Runtime.evaluate", {
      expression,
      awaitPromise: false,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    }, timeout);
  }

  async function deliver(request) {
    const requestId = String(request.id || "");
    const action = String(request.action || "");
    console.log(JSON.stringify({ event: "manager-action-received", action, requestId: requestId.slice(0, 32) }));
    let payload;
    try {
      payload = await runAction(action);
      payload.action ||= action;
      payload.snapshot = await managerSnapshot();
      payload.managerSummary = managerSummary(action, payload);
    } catch (error) {
      payload = { ok: false, action, message: error.message, managerSummary: `\u8fd0\u884c\u5931\u8d25\uff1a${error.message}`, snapshot: await managerSnapshot().catch(() => null) };
    }
    await evaluate(`(() => {
      const payload = ${JSON.stringify(payload)};
      const action = ${JSON.stringify(action)};
      const deliveredAction = payload.action || action;
      payload.action = deliveredAction;
      if (payload.snapshot) globalThis.__ANTICODEX_MANAGER_SNAPSHOT__ = payload.snapshot;
      const suppressRefreshStatusResult = deliveredAction === "refreshStatus" && globalThis.__ANTICODEX_MANAGER_SUPPRESS_REFRESH_STATUS_RESULT__ === true;
      if (!suppressRefreshStatusResult) globalThis.__ANTICODEX_MANAGER_LAST_ACTION_RESULT__ = payload;
      let result = document.querySelector('[data-anticodex-result="action"]');
      if (!result && typeof globalThis.__ANTICODEX_OPEN_MANAGER__ === "function") {
        document.querySelector("#anticodex-manager-overlay")?.remove();
        globalThis.__ANTICODEX_OPEN_MANAGER__();
        result = document.querySelector('[data-anticodex-result="action"]');
      }
      const runningAction = result?.getAttribute('data-anticodex-running') || "";
      const isCurrentAction = !runningAction || runningAction === deliveredAction;
      if (isCurrentAction && result && payload.managerSummary && !suppressRefreshStatusResult) result.textContent = payload.managerSummary;
      if (isCurrentAction && !suppressRefreshStatusResult) globalThis.__ANTICODEX_REFRESH_MANAGER_PANEL__?.();
      if (isCurrentAction && !suppressRefreshStatusResult) for (const button of document.querySelectorAll('button[data-action]')) button.disabled = false;
      globalThis.__ANTICODEX_RESOLVE_MANAGER_ACTION__?.(${JSON.stringify(requestId)}, payload);
      delete globalThis.__ANTICODEX_MANAGER_ACTION_PROMISES__?.[${JSON.stringify(requestId)}];
    })()`);
    console.log(JSON.stringify({ event: "manager-action-resolved", action, ok: payload.ok !== false }));
  }

  let polling = false;
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const message = await evaluate("globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__ ? globalThis.__ANTICODEX_MANAGER_ACTION_QUEUE__.splice(0) : []", 5000);
      const queued = message.result?.result?.value || [];
      if (Array.isArray(queued) && queued.length > 0) {
        console.log(JSON.stringify({ event: "manager-action-queue", count: queued.length }));
        for (const request of queued) await deliver(request);
      }
    } catch (error) {
      console.error(`[anticodex-manager-bridge] poll failed: ${error.message}`);
    } finally {
      polling = false;
    }
  }, 250);

  setInterval(() => {}, 60000);
}

main().catch((error) => {
  console.error(`[anticodex-manager-bridge] ${error.stack || error.message || error}`);
  process.exit(1);
});
