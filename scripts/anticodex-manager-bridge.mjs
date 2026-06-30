#!/usr/bin/env node
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("--port") || process.env.DEEPCODEX_CDP_PORT || 58317);
const baseUrl = String(args.get("--base-url") || process.env.ANTICODEX_MANAGER_API || process.env.TRANSLATOR_URL || "http://127.0.0.1:8484").replace(/\/$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const triStateText = (value) => value === true ? "true" : (value === false ? "false" : "unknown");

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
          const error = new Error(json?.error?.message || text || `HTTP ${response.statusCode}`);
          error.statusCode = response.statusCode;
          reject(error);
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
  const bootstrapManagerActionToken = async () => {
    const bootstrap = await httpJson(`${baseUrl}/anticodex/manager/bootstrap`, {
      timeout: 10000,
      headers: {
        origin: baseUrl,
        referer: `${baseUrl}/anticodex/manager`,
      },
    });
    return bootstrap.token;
  };
  const postManagerActionWithToken = (token) => {
    return httpJson(`${baseUrl}/anticodex/manager/action`, {
      method: "POST",
      timeout: 180000,
      headers: {
        "content-type": "application/json",
        "x-anticodex-manager-token": token,
        origin: baseUrl,
        referer: `${baseUrl}/anticodex/manager`,
      },
      body: JSON.stringify({ action }),
    });
  };
  const token = await bootstrapManagerActionToken();
  try {
    return await postManagerActionWithToken(token);
  } catch (error) {
    if (error?.statusCode !== 403) throw error;
    return await postManagerActionWithToken(await bootstrapManagerActionToken());
  }
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

function localGatewayGuidanceLine(result) {
  const failures = Array.isArray(result?.failures) ? result.failures.filter(Boolean) : [];
  const text = failures.join("\n").toLowerCase();
  if (!text.includes("/health") && !text.includes("endpoint failed") && !text.includes("gateway offline") && !text.includes("failed to fetch") && !text.includes("timeout") && !text.includes("connection refused") && !text.includes("econnrefused") && !text.includes("无法连接")) return "";
  return "guidance: local Anti-Codex gateway is offline; start or restore the local gateway, then rerun plugin/app capability check.";
}

function sourceSnapshotLine(result) {
  const evidence = result?.sourceSnapshot && typeof result.sourceSnapshot === "object" ? result.sourceSnapshot : null;
  if (!evidence) return "";
  const fileCount = evidence.fileCount ?? "\u672a\u77e5";
  const fingerprint = evidence.fingerprint ? String(evidence.fingerprint).slice(0, 12) : "\u7f3a\u5931";
  const cache = evidence.cacheHitCount != null || evidence.cacheMissCount != null ? ` / cache=${evidence.cacheHitCount ?? "\u672a\u77e5"}/${evidence.cacheMissCount ?? "\u672a\u77e5"}` : "";
  const reused = evidence.reusedFromPreviousReport === true ? " / reused=true" : "";
  const skipped = evidence.refreshSkippedReason ? ` / reason=${evidence.refreshSkippedReason}` : "";
  return `sourceSnapshot: files=${fileCount} / fingerprint=${fingerprint}${cache}${reused}${skipped}`;
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
    const passed = item.effectiveOk !== null && item.effectiveOk !== undefined ? item.effectiveOk : item.ok;
    const status = item.exists ? ((item.parseable === false || item.invalid) ? "\u62a5\u544a\u635f\u574f" : (item.stale ? "\u9700\u91cd\u8dd1" : (passed ? "\u901a\u8fc7" : "\u9700\u5904\u7406"))) : "\u672a\u751f\u6210";
    const elapsed = item.elapsedMs != null ? ` / ${item.elapsedMs} ms` : "";
    lines.push(`${item.label}\uff1a${status}${elapsed}`);
    const age = formatReportAge(item.ageMs);
    if (item.exists && age) lines.push(`  \u66f4\u65b0\uff1a${age}`);
    if (item.firstFailure) lines.push(`  \u9996\u4e2a\u5931\u8d25\uff1a${item.firstFailure}`);
    if (item.publicDocumentationOk !== null && item.publicDocumentationOk !== undefined) lines.push(`  \u516c\u5f00\u6587\u6863\uff1a${item.publicDocumentationOk ? "\u901a\u8fc7" : "\u9700\u5904\u7406"}`);
    if (item.releaseReady !== null && item.releaseReady !== undefined) {
      lines.push(`  Release Gate: short=${item.shortReady ? "true" : "false"} / release=${item.releaseReady ? "true" : "false"}`);
      if (item.releaseBlockedOnlyByRequiredRealTraffic === true) lines.push(`  release blocker: required real-traffic evidence only (${(item.requiredRealTrafficBlockedGates || []).join(", ") || "unknown"}); short/no-traffic gates are clear`);
      if (item.strictOptionalRealTraffic !== null && item.strictOptionalRealTraffic !== undefined) lines.push(`  optionalRealTraffic: strict=${item.strictOptionalRealTraffic ? "true" : "false"} / ready=${item.optionalRealTrafficReady ? "true" : "false"}`);
      if (Array.isArray(item.optionalRealTrafficFailures) && item.optionalRealTrafficFailures.length) lines.push(`  optionalRealTrafficFailures: ${item.optionalRealTrafficFailures.slice(0, 6).join(", ")}`);
      if (Array.isArray(item.missingRequired) && item.missingRequired.length) lines.push(`  missingRequired: ${item.missingRequired.slice(0, 6).join(", ")}`);
      if (Array.isArray(item.missingShort) && item.missingShort.length) lines.push(`  missingShort: ${item.missingShort.slice(0, 6).join(", ")}`);
      if (Array.isArray(item.missingOptional) && item.missingOptional.length) lines.push(`  missingOptional: ${item.missingOptional.slice(0, 6).join(", ")}`);
      if (Array.isArray(item.damagedReports) && item.damagedReports.length) lines.push(`  damagedReports: ${item.damagedReports.slice(0, 6).join(", ")}`);
      function actionDisplayLabel(action, fallbackGateId = "") {
        const id = action?.id || "";
        const gateId = action?.gateId || fallbackGateId || id;
        const flags = [];
        if (action?.reportOnly === true) flags.push("reportOnly");
        if (action?.blockedUntilExplicitUserApproval === true) flags.push("approval");
        if (action?.requiresGatewayStart === true) flags.push("gateway");
        if (action?.requiresRealTraffic === true) flags.push("realTraffic");
        if (action?.highImpact === true) flags.push("highImpact");
        return `${gateId}:${id}${flags.length ? `[${flags.join(",")}]` : ""}`;
      }
      function failureReasonDisplayLabel(gate) {
        const hiddenReasons = gate?.failureReasonsHiddenCount != null && Number.isFinite(Number(gate.failureReasonsHiddenCount)) ? Math.max(0, Number(gate.failureReasonsHiddenCount)) : 0;
        const reason = `${gate?.failureReason || (Array.isArray(gate?.failureReasons) ? gate.failureReasons[0] : "unsatisfied")}${hiddenReasons ? `(+${hiddenReasons} reasons)` : ""}`;
        const details = [];
        if (gate?.ageHours !== undefined && gate.ageHours !== null && Number.isFinite(Number(gate.ageHours))) details.push(`age=${Number(gate.ageHours).toFixed(1)}h`);
        if (typeof gate?.fresh === "boolean") details.push(`fresh=${triStateText(gate.fresh)}`);
        if (typeof gate?.selectedFromHistory === "boolean") details.push(`history=${triStateText(gate.selectedFromHistory)}`);
        if (typeof gate?.historySourceMismatch === "boolean") details.push(`sourceMismatch=${triStateText(gate.historySourceMismatch)}`);
        if (typeof gate?.requiredForShort === "boolean" || typeof gate?.requiredForRelease === "boolean") details.push(`required=${triStateText(gate.requiredForShort)}/${triStateText(gate.requiredForRelease)}`);
        return `${gate?.id || "unknown"}:${reason}${details.length ? `[${details.join("/")}]` : ""}`;
      }
      function mergedNextActionObjects() {
        const seen = new Set();
        const actions = [];
        const add = (action, fallbackGateId = "") => {
          if (!action?.id) return;
          const key = `${action.gateId || fallbackGateId || action.id}:${action.id}`;
          if (seen.has(key)) return;
          seen.add(key);
          actions.push({ ...action, __fallbackGateId: fallbackGateId });
        };
        if (Array.isArray(item.nextActions)) item.nextActions.forEach((action) => add(action, action?.gateId || ""));
        if (Array.isArray(item.releaseGateFailureReasons)) {
          item.releaseGateFailureReasons.forEach((gate) => {
            if (Array.isArray(gate?.orderedActions)) gate.orderedActions.forEach((action) => add(action, gate.id));
          });
        }
        return actions;
      }
      if (Array.isArray(item.releaseGateFailureReasons) && item.releaseGateFailureReasons.length) {
        const failureReasonItems = item.releaseGateFailureReasons.slice(0, 6).map((gate) => failureReasonDisplayLabel(gate));
        const hiddenFailureReasons = Math.max(0, item.releaseGateFailureReasons.length - failureReasonItems.length);
        lines.push(`  failureReasons: ${failureReasonItems.join(", ")}${hiddenFailureReasons ? ` (+${hiddenFailureReasons} more)` : ""}`);
        const reportFailureSource = item.releaseGateFailureReasons
          .filter((gate) => gate?.selectedFile || (Array.isArray(gate?.reportFailureSamples) && gate.reportFailureSamples.length))
        const reportFailureDetails = reportFailureSource
          .slice(0, 4)
          .map((gate) => {
            const sample = Array.isArray(gate.reportFailureSamples) && gate.reportFailureSamples.length ? ` / sample ${gate.reportFailureSamples.slice(0, 2).join(" | ")}` : "";
            const codes = Array.isArray(gate.reportFailureSampleCodes) && gate.reportFailureSampleCodes.length ? ` / codes ${gate.reportFailureSampleCodes.slice(0, 3).join(",")}` : "";
            return `${gate.id}:${gate.selectedFile || "no-file"}${gate.selectedMtime ? ` @ ${gate.selectedMtime}` : ""}${codes}${sample}`;
        });
        const hiddenReportFailures = Math.max(0, reportFailureSource.length - reportFailureDetails.length);
        if (reportFailureDetails.length) lines.push(`  reportFailures: ${reportFailureDetails.join("; ")}${hiddenReportFailures ? ` (+${hiddenReportFailures} more)` : ""}`);
        const guidanceSource = item.releaseGateFailureReasons
          .filter((gate) => gate?.guidance);
        const guidanceDetails = guidanceSource
          .slice(0, 4)
          .map((gate) => `${gate.id}:${gate.guidance}`);
        const hiddenGuidance = Math.max(0, guidanceSource.length - guidanceDetails.length);
        if (guidanceDetails.length) lines.push(`  guidance: ${guidanceDetails.join("; ")}${hiddenGuidance ? ` (+${hiddenGuidance} more)` : ""}`);
        const realTrafficEvidenceGates = item.releaseGateFailureReasons
          .filter((gate) => gate?.group === "real-traffic" && (["stale_report", "missing_report"].includes(gate.failureReason) || (Array.isArray(gate.failureReasons) && gate.failureReasons.some((reason) => ["stale_report", "missing_report"].includes(reason)))))
          .map((gate) => gate.id)
          .filter(Boolean);
        if (realTrafficEvidenceGates.length) {
          lines.push(`  真实流量验收证据需更新/未生成：这不是普通功能缺失；请显式运行耗真实流量的验证后再做完整检查（${realTrafficEvidenceGates.slice(0, 6).join(", ")}）`);
        }
      }
      const allNextActionObjects = mergedNextActionObjects();
      const allNextActions = allNextActionObjects.map((action) => actionDisplayLabel(action, action.__fallbackGateId || ""));
      const nextActions = allNextActions.slice(0, 8);
      const reportHiddenNextActions = item.nextActionsHiddenCount != null && Number.isFinite(Number(item.nextActionsHiddenCount)) ? Math.max(0, Number(item.nextActionsHiddenCount)) : null;
      const reportAvailableNextActions = item.nextActionsAvailableCount != null && Number.isFinite(Number(item.nextActionsAvailableCount)) ? Math.max(0, Number(item.nextActionsAvailableCount)) : null;
      const hiddenNextActions = Math.max(0, reportHiddenNextActions ?? (allNextActions.length - nextActions.length));
      const availableNextActions = reportAvailableNextActions ?? allNextActions.length;
      if (nextActions.length) lines.push(`  nextActions: ${nextActions.join(" -> ")}${hiddenNextActions ? ` (+${hiddenNextActions} hidden of ${availableNextActions})` : ""}`);
      const actionReasonDetails = allNextActionObjects.filter((action) => action?.reason).slice(0, 6).map((action) => `${actionDisplayLabel(action, action.__fallbackGateId || "")}=${action.reason}`);
      const hiddenActionReasons = Math.max(0, allNextActionObjects.filter((action) => action?.reason).length - actionReasonDetails.length);
      if (actionReasonDetails.length) lines.push(`  actionReasons: ${actionReasonDetails.join("; ")}${hiddenActionReasons ? ` (+${hiddenActionReasons} more)` : ""}`);
      const actionGuidanceDetails = allNextActionObjects.filter((action) => action?.guidance).slice(0, 4).map((action) => `${actionDisplayLabel(action, action.__fallbackGateId || "")}=${action.guidance}`);
      const hiddenActionGuidance = Math.max(0, allNextActionObjects.filter((action) => action?.guidance).length - actionGuidanceDetails.length);
      if (actionGuidanceDetails.length) lines.push(`  actionGuidance: ${actionGuidanceDetails.join("; ")}${hiddenActionGuidance ? ` (+${hiddenActionGuidance} more)` : ""}`);
      if (item.approvalPlan) {
        const plan = item.approvalPlan;
        lines.push(`  approvalPlan: actions=${plan.actionCount ?? "unknown"} / reportOnly=${plan.reportOnlyCount ?? "unknown"} / blocked=${plan.blockedCount ?? "unknown"} / gateway=${plan.requiresGatewayStartCount ?? "unknown"} / realTraffic=${plan.requiresRealTrafficCount ?? "unknown"} / highImpact=${plan.highImpactCount ?? "unknown"} / required=${plan.requiredForShortCount ?? "unknown"}/${plan.requiredForReleaseCount ?? "unknown"} / phases=${Array.isArray(plan.phases) ? plan.phases.length : "unknown"} / first=${plan.firstBlockedAction || "none"}`);
        if (Array.isArray(plan.phases) && plan.phases.length) {
          const phaseSummary = plan.phases.slice(0, 8).map((phase) => {
            const flags = [];
            if (phase.reportOnly === true) flags.push("reportOnly");
            if (phase.requiresGatewayStart === true) flags.push("gateway");
            if (phase.requiresRealTraffic === true) flags.push("realTraffic");
            if (phase.highImpact === true) flags.push("highImpact");
            if (phase.blockedUntilExplicitUserApproval === true) flags.push("blocked");
            return `${phase.phase || "unknown"}:${phase.count ?? "?"}${flags.length ? `[${flags.join(",")}]` : ""}`;
          }).join(" | ");
          const hiddenPhases = Math.max(0, plan.phases.length - 8);
          lines.push(`  approvalPhases: ${phaseSummary}${hiddenPhases ? ` (+${hiddenPhases} more)` : ""}`);
        }
      }
      if (Array.isArray(item.releaseGateSelectedReports) && item.releaseGateSelectedReports.length) {
        const selectedReports = item.releaseGateSelectedReports.slice(0, 6).map((entry) => `${entry.id}:${entry.selectedFile}${entry.historySourceMismatch === true ? "[sourceMismatch]" : ""}`).join(", ");
        lines.push(`  selectedHistory: ${selectedReports}`);
      }
      if (Array.isArray(item.releaseGateGroups) && item.releaseGateGroups.length) {
        const groupSummary = item.releaseGateGroups.slice(0, 8).map((group) => {
          const missingRequired = Array.isArray(group.missingRequired) && group.missingRequired.length ? ` missingReq=${group.missingRequired.slice(0, 3).join(",")}` : "";
          const missingOptional = Array.isArray(group.missingOptional) && group.missingOptional.length ? ` missingOpt=${group.missingOptional.slice(0, 3).join(",")}` : "";
          return `${group.group} req ${group.requiredSatisfied ?? 0}/${group.required ?? 0} opt ${group.optionalSatisfied ?? 0}/${group.optional ?? 0}${missingRequired}${missingOptional}`;
        }).join(" | ");
        lines.push(`  Release groups: ${groupSummary}`);
      }
      if (item.installedRuntimeEvidence) {
        const evidence = item.installedRuntimeEvidence;
        const fingerprintMatch = evidence.sourceFingerprint && evidence.installedRuntimeFingerprint && evidence.sourceFingerprint === evidence.installedRuntimeFingerprint;
        lines.push(`  installedRuntime: satisfied=${evidence.satisfied ?? "unknown"} / files=${evidence.sourceFileCount ?? "unknown"}/${evidence.installedRuntimeFileCount ?? "unknown"} / fingerprint=${fingerprintMatch ? "match" : "mismatch"} / mismatches=${Array.isArray(evidence.mismatchedRuntimeFiles) ? evidence.mismatchedRuntimeFiles.length : 0} / sourceMtime=${evidence.sourceMtimeMax || "unknown"} / installedMtime=${evidence.installedRuntimeMtimeMax || "unknown"}`);
        const runtimeSamples = [
          ...(Array.isArray(evidence.missingSourceFiles) ? evidence.missingSourceFiles.map((item) => `missingSource:${item}`) : []),
          ...(Array.isArray(evidence.missingInstalledRuntimeFiles) ? evidence.missingInstalledRuntimeFiles.map((item) => `missingInstalled:${item}`) : []),
          ...(Array.isArray(evidence.mismatchedRuntimeFiles) ? evidence.mismatchedRuntimeFiles.map((item) => `mismatch:${item}`) : []),
        ].slice(0, 3);
        if (runtimeSamples.length) lines.push(`  installedRuntime drift: ${runtimeSamples.join(", ")}`);
      }
    }
    if (Array.isArray(item.releaseGateFailures) && item.releaseGateFailures.length) {
      const gateFailures = item.releaseGateFailures.slice(0, 4).map((gate) => {
        const semanticFailures = Array.isArray(gate.semanticFailures) ? gate.semanticFailures : [];
        const shownSemanticFailures = semanticFailures.slice(0, 4);
        const hiddenSemanticFailures = Math.max(0, semanticFailures.length - shownSemanticFailures.length) + (gate.semanticFailuresHiddenCount != null && Number.isFinite(Number(gate.semanticFailuresHiddenCount)) ? Math.max(0, Number(gate.semanticFailuresHiddenCount)) : 0);
        const details = shownSemanticFailures.length ? `${shownSemanticFailures.join(", ")}${hiddenSemanticFailures ? ` (+${hiddenSemanticFailures} more)` : ""}` : (gate.error || "unsatisfied");
        return `${gate.id}:${details}`;
      });
      const hiddenGateFailures = Math.max(0, item.releaseGateFailures.length - gateFailures.length);
      lines.push(`  semanticFailures: ${gateFailures.join(" | ")}${hiddenGateFailures ? ` (+${hiddenGateFailures} more)` : ""}`);
      const sourceSnapshotMismatchGates = item.releaseGateFailures
        .filter((gate) => Array.isArray(gate.semanticFailures) && gate.semanticFailures.some((failure) => /_source_snapshot_mismatch$/.test(String(failure))))
        .map((gate) => gate.id)
        .filter(Boolean);
      if (sourceSnapshotMismatchGates.length) {
        lines.push(`  source snapshot mismatch: stale reports for ${sourceSnapshotMismatchGates.join(", ")}; refresh local features, MCP/Skill, and plugin capability reports`);
        lines.push("  source snapshot refresh: refresh local features first, then run normal MCP/Skill and plugin capability verifiers; do not edit latest report JSON by hand");
      }
      const pluginOfflineSnapshot = item.releaseGateFailures.find((gate) => gate.id === "pluginCapabilities" && gate.offlineSnapshotEvidence);
      if (pluginOfflineSnapshot) {
        const evidence = pluginOfflineSnapshot.offlineSnapshotEvidence;
        lines.push(`  plugin offline snapshot: connector=${evidence.connectorContentMatches ? "ok" : "needs-refresh"} / appTool=${evidence.appToolContentMatches ? "ok" : "needs-refresh"} / refreshGate=${evidence.refreshGateSatisfied ? "ok" : "needs-refresh"} / runtimeGateway=required`);
      }
    }
    if (item.sourceSnapshotEvidence) {
      const evidence = item.sourceSnapshotEvidence;
      const cache = evidence.cacheHitCount != null || evidence.cacheMissCount != null ? ` / cache=${evidence.cacheHitCount ?? "\u672a\u77e5"}/${evidence.cacheMissCount ?? "\u672a\u77e5"}` : "";
      const reused = evidence.reusedFromPreviousReport === true ? " / reused=true" : "";
      const skipped = evidence.refreshSkippedReason ? ` / reason=${evidence.refreshSkippedReason}` : "";
      lines.push(`  sourceSnapshot: files=${evidence.fileCount ?? "\u672a\u77e5"} / fingerprint=${evidence.fingerprint ? String(evidence.fingerprint).slice(0, 12) : "\u7f3a\u5931"}${cache}${reused}${skipped}`);
    }
    if (item.sourcePreflightEvidence) {
      const evidence = item.sourcePreflightEvidence;
      lines.push(`  sourcePreflight: js=${evidence.javascriptSyntaxOk ? "true" : "false"} / ps=${evidence.powershellSyntaxOk ? "true" : "false"} / profile=${evidence.upstreamProfileStorageOk ? "true" : "false"} / cliIsolation=${evidence.antigravityCliIsolationProfileOk ? "true" : "false"} / prepare=${evidence.antigravityCliProfilePrepareOk ? "true" : "false"} / rejectDefaultChild=${evidence.antigravityCliProfilePrepareRejectsDefaultChildOk ? "true" : "false"} / winUserLogin=${evidence.antigravityCliWindowsUserLoginDryRunOk ? "true" : "false"} / localConnector=${evidence.localConnectorVerifierOk ? "true" : "false"} / docs=${evidence.publicDocumentationOk ? "true" : "false"} / clientCopyDocs=${evidence.publicDocumentationClientCopySyncContractOk ? "true" : "false"}`);
      lines.push(`  sourcePreflight: ui=${evidence.uiStateSelfTestOk ? "true" : "false"} / regression=${evidence.translatorRegressionOk ? "true" : "false"} / diff=${evidence.diffWhitespaceOk ? "true" : "false"} / skipFull=${evidence.skipFullRegression ? "true" : "false"}`);
      if (evidence.antigravityCliIsolationProfileContract) {
        const c = evidence.antigravityCliIsolationProfileContract;
        lines.push(`  sourcePreflight cliIsolation lane: role=${c.accountLaneRole || "unknown"} / mcpManagedHere=${c.mcpAccountLaneManagedByAntiCodex ? "true" : "false"} / mcpOwner=${c.mcpAccountLaneOwner || "unknown"}`);
      }
      if (evidence.antigravityCliProfilePrepareContract) {
        const c = evidence.antigravityCliProfilePrepareContract;
        lines.push(`  sourcePreflight profilePrepare: traffic=${c.usedRealTraffic ? "true" : "false"} / login=${c.loginVerified ? "true" : "false"} / separateAccount=${c.separateAccountVerified ? "true" : "false"} / coverage=${c.coverageKind || "unknown"} / boundary=${c.accountIsolationBoundary || "unknown"}`);
        lines.push(`  sourcePreflight profilePrepare lane: role=${c.accountLaneRole || "unknown"} / mcpManagedHere=${c.mcpAccountLaneManagedByAntiCodex ? "true" : "false"} / mcpOwner=${c.mcpAccountLaneOwner || "unknown"}`);
        if (c.accountIsolationCaveat) lines.push(`  sourcePreflight profilePrepare caveat: ${c.accountIsolationCaveat}`);
      }
      if (evidence.antigravityCliWindowsUserLoginDryRunContract) {
        const c = evidence.antigravityCliWindowsUserLoginDryRunContract;
        lines.push(`  sourcePreflight windowsUserLogin: traffic=${c.usedRealTraffic ? "true" : "false"} / started=${c.started ? "true" : "false"} / capturesOutput=${c.capturesLoginOutput ? "true" : "false"} / boundary=${c.credentialBoundary || "unknown"} / expectedCredentialStoreIsolation=${c.expectedCredentialStoreIsolation ? "true" : "false"} / runasWorkdir=${c.runasWorkingDirectory ? "set" : "missing"} / bootstrapKeepsShell=${c.bootstrapKeepsShellOpen ? "true" : "false"}`);
        lines.push(`  sourcePreflight windowsUserLogin readiness: checked=${c.readinessChecked ? "true" : "false"} / userExists=${c.targetUserExists === true ? "true" : c.targetUserExists === false ? "false" : "unknown"} / currentUser=${c.targetUserIsCurrentUser ? "true" : "false"} / ready=${c.readyForInteractiveLogin ? "true" : "false"} / reason=${c.readinessBlockingReason || "none"}`);
        if (c.accountIsolationCaveat) lines.push(`  sourcePreflight windowsUserLogin caveat: ${c.accountIsolationCaveat}`);
      }
    }
    if (item.logDbGuardEvidence) {
      const evidence = item.logDbGuardEvidence;
      lines.push(`  logDbGuard: protected=${evidence.protected ? "true" : "false"} / trigger=${evidence.triggerPresent ? "true" : "false"} / noTraffic=${evidence.noTraffic ? "true" : "false"} / wal=${evidence.walBytes ?? "unknown"}`);
    }
    if (item.missingHistoryEvidence) {
      const evidence = item.missingHistoryEvidence;
      lines.push(`  missingHistory: status=${evidence.status ?? "unknown"} / type=${evidence.errorType || "unknown"} / retryable=${evidence.retryable === false ? "false" : "true"} / previousId=${evidence.previousResponseIdMatched ? "true" : "false"} / routeStable=${evidence.noRouteChange ? "true" : "false"} / noTraffic=${evidence.usedRealTraffic === false ? "true" : "false"}`);
    }
    if (item.accountProxyEvidence) {
      const evidence = item.accountProxyEvidence;
      const phase = evidence.phaseSummary || {};
      const signals = evidence.antigravityLogSignals || {};
      lines.push(`  accountProxy: detail=${evidence.diagnosisDetail || "unknown"} / action=${evidence.suggestedAction || "none"} / localProxyBypassed=${evidence.localProxyBypassed ? "true" : "false"}`);
      lines.push(`  accountProxy phase: account=${phase.accountOk ? "ok" : "check"} / refresh=${phase.refreshOk ? "ok" : "check"} / models=${phase.modelCount ?? "unknown"} / real=${phase.realRequestAttempted ? (phase.realRequestOk ? "ok" : "check") : "not-attempted"}`);
      lines.push(`  accountProxy logs: source=${signals.sourcePresent ? "present" : "missing"} / fresh=${signals.sourceFresh ? "true" : "false"} / scanned=${signals.tailLinesScanned ?? "unknown"} / verify=${signals.verificationRequiredCount ?? 0} / network=${signals.generalNetworkFailureCount ?? 0}`);
    }
    if (item.antigravityCliRealSmokeEvidence) {
      const evidence = item.antigravityCliRealSmokeEvidence;
      lines.push(`  antigravityCliRealSmoke: login=${evidence.loginVerified ? "true" : "false"} / separateAccount=${evidence.separateAccountVerified ? "true" : "false"} / strictAppData=${evidence.strictWindowsAppDataIsolation ? "true" : "false"} / source=${evidence.profileSource || "unknown"}`);
      lines.push(`  antigravityCliRealSmoke lane: role=${evidence.accountLaneRole || "unknown"} / mcpManagedHere=${evidence.mcpAccountLaneManagedByAntiCodex ? "true" : "false"} / mcpOwner=${evidence.mcpAccountLaneOwner || "unknown"}`);
      if (evidence.accountIdentityComparison) {
        const comparison = evidence.accountIdentityComparison;
        lines.push(`  antigravityCliRealSmoke identity: antiCodexId=${comparison.antiCodexAccountIdPresent ? "present" : "missing"} / mcpId=${comparison.mcpAccountIdPresent ? "present" : "missing"} / distinct=${comparison.accountIdsDiffer === true ? "true" : comparison.accountIdsDiffer === false ? "false" : "unknown"}`);
      }
      if (evidence.separateAccountVerificationReason) lines.push(`  antigravityCliRealSmoke caveat: ${evidence.separateAccountVerificationReason}`);
      else if (evidence.accountIsolationCaveat) lines.push(`  antigravityCliRealSmoke caveat: ${evidence.accountIsolationCaveat}`);
    }
    if (item.antigravityCliProfilePrepareEvidence) {
      const evidence = item.antigravityCliProfilePrepareEvidence;
      lines.push(`  antigravityCliProfilePrepare: separateAccount=${evidence.separateAccountVerified ? "true" : "false"} / boundary=${evidence.accountIsolationBoundary || "unknown"}`);
      lines.push(`  antigravityCliProfilePrepare lane: role=${evidence.accountLaneRole || "unknown"} / mcpManagedHere=${evidence.mcpAccountLaneManagedByAntiCodex ? "true" : "false"} / mcpOwner=${evidence.mcpAccountLaneOwner || "unknown"}`);
      if (evidence.accountIsolationCaveat) lines.push(`  antigravityCliProfilePrepare caveat: ${evidence.accountIsolationCaveat}`);
    }
    if (item.antigravityCliWindowsUserReadinessEvidence) {
      const evidence = item.antigravityCliWindowsUserReadinessEvidence;
      lines.push(`  antigravityCliWindowsUserReadiness: ready=${evidence.readyForInteractiveLogin ? "true" : "false"} / userExists=${evidence.targetUserExists === true ? "true" : evidence.targetUserExists === false ? "false" : "unknown"} / currentUser=${evidence.targetUserIsCurrentUser ? "true" : "false"} / action=${evidence.recommendedOperatorAction || "unknown"}`);
      lines.push(`  antigravityCliWindowsUserReadiness guard: traffic=${evidence.usedRealTraffic ? "true" : "false"} / started=${evidence.started ? "true" : "false"} / capturesOutput=${evidence.capturesLoginOutput ? "true" : "false"} / boundary=${evidence.credentialBoundary || "unknown"} / separateAccount=${evidence.separateAccountVerified ? "true" : "false"} / login=${evidence.loginVerified ? "true" : "false"}`);
      if (evidence.readinessBlockingReason) lines.push(`  antigravityCliWindowsUserReadiness reason: ${evidence.readinessBlockingReason}`);
      if (evidence.accountIsolationCaveat) lines.push(`  antigravityCliWindowsUserReadiness caveat: ${evidence.accountIsolationCaveat}`);
    }
    if (item.windowsUserAccountPrepareEvidence) {
      const evidence = item.windowsUserAccountPrepareEvidence;
      lines.push(`  windowsUserAccountPrepare: elevated=${evidence.currentProcessElevated ? "true" : "false"} / userExists=${evidence.targetUserExists === true ? "true" : evidence.targetUserExists === false ? "false" : "unknown"} / canCreate=${evidence.canCreateTargetWindowsUser ? "true" : "false"} / action=${evidence.recommendedOperatorAction || "unknown"}`);
      lines.push(`  windowsUserAccountPrepare guard: traffic=${evidence.usedRealTraffic ? "true" : "false"} / changedSystem=${evidence.changedSystem ? "true" : "false"} / createdUser=${evidence.createdUser ? "true" : "false"} / startedLogin=${evidence.startedLogin ? "true" : "false"} / storesPassword=${evidence.storesPassword ? "true" : "false"}`);
      lines.push(`  windowsUserAccountPrepare next: safeToAskLogin=${evidence.safeToAskUserForSecondAccountLogin ? "true" : "false"} / canProceedLogin=${evidence.canProceedToInteractiveLogin ? "true" : "false"} / blockedBeforeLogin=${evidence.blockedBeforeInteractiveLogin ? "true" : "false"} / stage=${evidence.operatorBlockingStage || "unknown"} / next=${evidence.operatorNextStep || "unknown"}`);
      if (evidence.readinessBlockingReason) lines.push(`  windowsUserAccountPrepare reason: ${evidence.readinessBlockingReason}`);
    }
    if (item.windowsUserSetupGuidanceEvidence) {
      const evidence = item.windowsUserSetupGuidanceEvidence;
      lines.push(`  windowsUserSetupGuidance: userExists=${evidence.targetUserExists === true ? "true" : evidence.targetUserExists === false ? "false" : "unknown"} / safeToAskLogin=${evidence.safeToAskUserForSecondAccountLogin ? "true" : "false"} / stage=${evidence.operatorBlockingStage || "unknown"} / next=${evidence.operatorNextStep || "unknown"}`);
      lines.push(`  windowsUserSetupGuidance guard: traffic=${evidence.usedRealTraffic ? "true" : "false"} / changedSystem=${evidence.changedSystem ? "true" : "false"} / createdUser=${evidence.createdUser ? "true" : "false"} / startedLogin=${evidence.startedLogin ? "true" : "false"} / storesPassword=${evidence.storesPassword ? "true" : "false"}`);
      lines.push(`  windowsUserSetupGuidance sequence: ${Array.isArray(evidence.readinessCheckSequence) && evidence.readinessCheckSequence.length ? evidence.readinessCheckSequence.join(" -> ") : "missing"}`);
      lines.push(`  windowsUserSetupGuidance checklist: stages=${Array.isArray(evidence.operatorChecklistStages) && evidence.operatorChecklistStages.length ? evidence.operatorChecklistStages.join(" -> ") : "missing"} / loginSteps=${evidence.operatorChecklistStartsLoginCount ?? 0} / realTrafficSteps=${evidence.operatorChecklistUsesRealTrafficCount ?? 0}`);
      if (evidence.operatorSetupPlan) {
        const plan = evidence.operatorSetupPlan;
        lines.push(`  windowsUserSetupGuidance setupPlan: target=${plan.targetLocalWindowsUser || "unknown"} / mode=${plan.setupMode || "unknown"} / surface=${plan.preferredSurface || "unknown"} / createsUser=${plan.antiCodexCreatesUser ? "true" : "false"} / opensSettings=${plan.antiCodexOpensSettings ? "true" : "false"} / startsLogin=${plan.antiCodexStartsLogin ? "true" : "false"} / rawCommand=${plan.rawUserManagementCommandProvided ? "true" : "false"}`);
        lines.push(`  windowsUserSetupGuidance afterManualSetup: checks=${Array.isArray(plan.afterManualSetupChecks) && plan.afterManualSetupChecks.length ? plan.afterManualSetupChecks.join(" -> ") : "missing"} / entrypoint=${plan.finalLoginEntrypoint || "unknown"} / approval=${plan.finalLoginApproval || "unknown"}`);
      }
      if (evidence.manualSetupCommandHint) lines.push(`  windowsUserSetupGuidance hint: ${evidence.manualSetupCommandHint}`);
    }
    if (Array.isArray(item.managerButtonResults) && item.managerButtonResults.length) {
      const actions = item.managerButtonResults.slice(0, 4).map((entry) => `${entry.action || "unknown"}:${entry.ok ? "ok" : "fail"}/bridge=${entry.bridgeReady ? "true" : "false"}/overlay=${entry.overlayPresent ? "true" : "false"}/hit=${entry.actionCenterHitsButton ? "true" : "false"}/close=${entry.closeHitAreaOk ? "true" : "false"}/newPage=${entry.managerOpenedNewPage ? "true" : "false"}/targets=${entry.pageTargetCountBeforeManagerOpen ?? "?"}->${entry.pageTargetCountAfterManagerOpen ?? "?"}`);
      lines.push(`  managerButtons: ${actions.join(" | ")}`);
    }
    if (item.skipped === true) {
      lines.push(`  skipped: ${item.reason || "no reason"} / requestedRealTraffic=${item.requestedRealTraffic ? "true" : "false"} / coverage=${item.coverageKind || "unknown"}`);
    }
    if (item.modelRoutingEvidence) {
      const evidence = item.modelRoutingEvidence;
      lines.push(`  modelRouting: mode=${evidence.mode || "unknown"} / skipRequests=${item.skipRequests ? "true" : "false"} / results=${evidence.skippedRequestCount ?? 0}/${evidence.resultCount ?? 0} / failed=${evidence.failedResultCount ?? 0}`);
      if (evidence.providerProtocol || evidence.providerModel || evidence.toolBridgeMode) lines.push(`  modelRouting route: protocol=${evidence.providerProtocol || "native"} / providerModel=${evidence.providerModel || "none"} / toolBridge=${evidence.toolBridgeMode || "unknown"}`);
    }
    if (item.modelThinkingEvidence) {
      const evidence = item.modelThinkingEvidence;
      lines.push(`  modelThinking: models=${evidence.actualModelCount ?? "\u672a\u77e5"}/${evidence.expectedModelCount ?? "\u672a\u77e5"} / thinking=${evidence.supportsThinkingCount ?? 0}/${evidence.modelCount ?? 0} / budgetMissing=${evidence.missingBudgetCount ?? 0}`);
      if (Array.isArray(evidence.reasoningLevels) && evidence.reasoningLevels.length) lines.push(`  modelThinking levels: ${evidence.reasoningLevels.join(", ")}`);
    }
    if (item.uiIdleEvidence) {
      const evidence = item.uiIdleEvidence;
      lines.push(`  uiIdle: samples=${evidence.healthySampleCount ?? 0}/${evidence.sampleCount ?? 0} / duration=${evidence.durationSec ?? "unknown"}s / reconnectText=${evidence.reconnectTextCount ?? 0} / loginText=${evidence.loginTextCount ?? 0}`);
    }
    if (item.syncReadinessEvidence) {
      const evidence = item.syncReadinessEvidence;
      lines.push(`  syncReadiness: noTraffic=${evidence.noTrafficReady ? "true" : "check"} / full=${evidence.fullMode ? "true" : "check"} / host=${evidence.activeHostReady && evidence.brandReady ? "ok" : "check"} / icons=${evidence.iconReady ? "ok" : "check"} / update=${evidence.updateReady ? "synced" : "check"} / guardrails=${evidence.guardrailsReady ? "ok" : "check"}`);
      lines.push(`  syncReadiness versions: codex=${evidence.codexVersion || "unknown"} / source=${evidence.sourcePackageVersion || "unknown"} / active=${evidence.activePackageVersion || "unknown"} / activeSource=${evidence.activeSourcePackageVersion || "unknown"} / versionMatch=${triStateText(evidence.clientSyncVersionMatches)} / drift=${evidence.updateDriftState || "unknown"} / reason=${evidence.updateStatusReason || "unknown"} / updateSource=${evidence.updateStatusSource || "unknown"} / hostChanged=${triStateText(evidence.updateDriftHostChanged)} / cliChanged=${triStateText(evidence.updateDriftCliChanged)}`);
      lines.push(`  syncReadiness hashes: host=${String(evidence.activeHostHash || "").slice(0, 8) || "unknown"}/${String(evidence.sourceHostHash || "").slice(0, 8) || "unknown"} match=${triStateText(evidence.hostHashMatches)} / cli=${String(evidence.activeCliHash || "").slice(0, 8) || "unknown"}/${String(evidence.sourceCliHash || "").slice(0, 8) || "unknown"} match=${triStateText(evidence.cliHashMatches)}`);
      lines.push(`  syncReadiness shortcuts: ${evidence.shortcutReadyCount ?? 0}/${evidence.shortcutCount ?? 0} / managerBridge=${evidence.managerBridgeReady ? "ok" : "check"} / processes=${evidence.managerBridgeProcessCount ?? "?"} / stale=${evidence.managerBridgeStaleProcessCount ?? "?"} / clean=${evidence.cleanSyncState ? "true" : "false"}`);
    }
    if (item.installedOverallEvidence) {
      const evidence = item.installedOverallEvidence;
      lines.push(`  installedOverall: noTraffic=${evidence.noTraffic ? "true" : "false"} / coverage=${evidence.coverageKind || "unknown"} / usedRealTraffic=${evidence.usedRealTraffic ? "true" : "false"} / behaviorCovered=${evidence.behaviorCovered ? "true" : "false"}`);
      lines.push(`  installedOverall model: transport=${evidence.modelTextTransport || "unknown"} / discovery=${evidence.modelDiscoverySource || "unknown"} / coworkerDefault=${evidence.antigravityCoworkerDefault === false ? "false" : "check"}`);
      lines.push(`  installedOverall checks: ok=${evidence.okCheckCount ?? 0}/${evidence.checkCount ?? 0} / skipped=${evidence.skippedCheckCount ?? 0} / realSkipped=${Array.isArray(evidence.realTrafficSkippedChecks) ? evidence.realTrafficSkippedChecks.join(",") : ""}`);
    }
    if (item.desktopTaskSuiteEvidence) {
      const evidence = item.desktopTaskSuiteEvidence;
      const plan = evidence.realTaskEvidenceRefreshPlan || {};
      lines.push(`  desktopTaskSuite: profile=${evidence.suiteProfile || "unknown"} / tasks=${evidence.selectedTaskCount ?? "unknown"} / complete=${evidence.realTaskEvidenceComplete ? "true" : "false"} / fresh=${evidence.realTaskEvidenceFresh ? "true" : "false"} / stale=${evidence.realTaskEvidenceFreshnessFailureCount ?? "unknown"}`);
      lines.push(`  desktopTaskSuite refresh: needed=${plan.needed ? "true" : "false"} / approval=${plan.requiresExplicitUserApproval ? "true" : "false"} / reason=${plan.approvalReason || "none"} / tasks=${Array.isArray(plan.refreshTaskModes) && plan.refreshTaskModes.length ? plan.refreshTaskModes.join(",") : "none"}`);
    }
    if (item.realTaskCoverageRoadmapEvidence) {
      const evidence = item.realTaskCoverageRoadmapEvidence;
      const scenarios = Array.isArray(evidence.pendingRealTaskScenarios) ? evidence.pendingRealTaskScenarios : [];
      const scenarioText = scenarios.slice(0, 4).map((scenario) => `${scenario.taskMode || "unknown"}:${scenario.workType || "unknown"}`).join(", ");
      lines.push(`  realTaskCoverage next: profiles=${Array.isArray(evidence.nextProfilesNeedingRealTraffic) && evidence.nextProfilesNeedingRealTraffic.length ? evidence.nextProfilesNeedingRealTraffic.join(",") : "none"} / tasks=${Array.isArray(evidence.uniqueRefreshTasks) && evidence.uniqueRefreshTasks.length ? evidence.uniqueRefreshTasks.join(",") : "none"} / approval=${evidence.approvalRequiredForRefresh ? "true" : "false"}`);
      if (scenarioText) lines.push(`  realTaskCoverage scenarios: ${scenarioText}`);
    }
    if (item.nativeCodexParityTaskMatrixEvidence) {
      const evidence = item.nativeCodexParityTaskMatrixEvidence;
      lines.push(`  nativeParity: complete=${evidence.nativeCodexParityComplete ? "true" : "false"} / proven=${evidence.provenTaskCount ?? "unknown"} / pending=${Array.isArray(evidence.pendingRefreshTaskModes) && evidence.pendingRefreshTaskModes.length ? evidence.pendingRefreshTaskModes.join(",") : "none"} / tools=${evidence.codexOwnedTools ? "codex-owned" : "unknown"}`);
    }
    if (item.realApprovalPlanEvidence) {
      const evidence = item.realApprovalPlanEvidence;
      lines.push(`  realApprovalPlan preLogin: complete=${evidence.preLoginChecklistComplete ? "true" : "false"} / checks=${evidence.preLoginChecklistCount ?? "unknown"} / next=${evidence.nextNoTrafficAction || "unknown"}`);
      lines.push(`  realApprovalPlan preLogin checks: ${Array.isArray(evidence.preLoginChecklistIds) && evidence.preLoginChecklistIds.length ? evidence.preLoginChecklistIds.join(" -> ") : "missing"}`);
    }
    if (item.goalRealRunReadinessEvidence) {
      const evidence = item.goalRealRunReadinessEvidence;
      const blockers = Array.isArray(evidence.blockingStages) && evidence.blockingStages.length ? evidence.blockingStages.join(",") : "none";
      const tasks = Array.isArray(evidence.pendingRealTaskScenarios) && evidence.pendingRealTaskScenarios.length
        ? evidence.pendingRealTaskScenarios.slice(0, 4).map((scenario) => `${scenario.taskMode || "unknown"}:${scenario.workType || "unknown"}`).join(", ")
        : "none";
      lines.push(`  goalRealRun: ready=${evidence.readyForUserApprovedRealRun ? "true" : "false"} / accountSafe=${evidence.safeToAskUserForSecondAccountLogin ? "true" : "false"} / releaseReady=${evidence.releaseReady ? "true" : "false"} / blockers=${blockers}`);
      lines.push(`  goalRealRun tasks: ${tasks}`);
    }
    if (item.approvedRealRunSequenceEvidence) {
      const evidence = item.approvedRealRunSequenceEvidence;
      const tasks = Array.isArray(evidence.pendingRealTaskScenarios) && evidence.pendingRealTaskScenarios.length
        ? evidence.pendingRealTaskScenarios.slice(0, 4).map((scenario) => `${scenario.taskMode || "unknown"}:${scenario.workType || "unknown"}`).join(", ")
        : "none";
      lines.push(`  approvedRealRun: blocked=${evidence.executionBlockedBeforeRealTraffic ? "true" : "false"} / stages=${evidence.sequenceStageCount ?? "unknown"} / real=${evidence.realTrafficStageCount ?? "unknown"} / login=${evidence.startsLoginStageCount ?? "unknown"} / approvals=${evidence.explicitApprovalStageCount ?? "unknown"}`);
      lines.push(`  approvedRealRun tasks: ${tasks}`);
    }
    if (item.toolBridgeEvidence) {
      const evidence = item.toolBridgeEvidence;
      lines.push(`  toolBridge: mode=${evidence.mode || "unknown"} / transport=${evidence.transport || "unknown"} / adapter=${evidence.localAdapter || "unknown"}`);
      lines.push(`  toolBridge native: events=${evidence.nativeAntigravityToolEvents ? "true" : "false"} / discovery=${evidence.nativeMcpDiscoveryVerified ? "true" : "false"} / approval=${evidence.nativeMcpApprovalProtocolVerified ? "true" : "false"} / resume=${evidence.sameCascadeResumeProbeVerified ? "true" : "false"}`);
      lines.push(`  toolBridge nativeMcp: envelope=${evidence.requestEnvelope || "unknown"} / field=${evidence.externalToolDefinitionsField || "unknown"} / usable=${evidence.externalToolDefinitionsUsable ? "true" : "false"} / schema=${evidence.schemaLikeRequestAcceptance || "unknown"} / call=${evidence.nativeMcpToolCallStatus || "unknown"}`);
    }
    if (item.mcpSkillEvidence) {
      const evidence = item.mcpSkillEvidence;
      const realListClean = evidence.mcpRealListCount == null || (evidence.mcpRealListCount >= 2 && evidence.mcpRealListPassed === evidence.mcpRealListCount);
      const clean = evidence.mcpMissingSharedCount === 0 && evidence.mcpExtraLocalCount === 0 && evidence.mcpChangedSharedCount === 0 && evidence.missingSharedSkillCount === 0 && (evidence.changedSharedSkillCount ?? 0) === 0 && evidence.conflictingDuplicateSkillCount === 0 && evidence.hasNodeRepl === true && evidence.skillSmokeReadable === true && realListClean;
      const hashCache = evidence.hashCacheHitCount != null || evidence.hashCacheMissCount != null ? ` / hashCache=${evidence.hashCacheHitCount ?? "\u672a\u77e5"}/${evidence.hashCacheMissCount ?? "\u672a\u77e5"}` : "";
      const realList = evidence.mcpRealListCount != null || evidence.mcpRealListPassed != null ? ` / list ${evidence.mcpRealListPassed ?? "\u672a\u77e5"}/${evidence.mcpRealListCount ?? "\u672a\u77e5"} tools=${evidence.mcpRealListToolCount ?? "\u672a\u77e5"}` : "";
      lines.push(`  MCP/Skill \u8bc1\u636e\uff1aMCP ${evidence.mcpCount ?? "\u672a\u77e5"}/${evidence.mcpSharedCount ?? "\u672a\u77e5"} / skills ${evidence.skillCount ?? "\u672a\u77e5"}/${evidence.expectedSharedSkillCount ?? "\u672a\u77e5"} / agents ${evidence.agentsSkillCount ?? "\u672a\u77e5"}${hashCache}`);
      lines.push(`  MCP/Skill parity: ${clean ? "\u5e72\u51c0" : "\u9700\u5904\u7406"} / smoke ${evidence.mcpSmokePassed ? "MCP ok" : "MCP ?"} / real ${evidence.mcpRealCallPassed ? "ok" : "?"}${realList} / skill ${evidence.skillSmokeReadable ? "ok" : "?"}`);
      if (evidence.appToolRegistryExists !== null && evidence.appToolRegistryExists !== undefined) {
        const registryClean = evidence.appToolRegistryExists === true && evidence.appToolRegistryContentMatches === true && evidence.appToolRegistryFingerprintMatches === true && evidence.appToolRegistrySharedFileCount != null && evidence.appToolRegistryLocalFileCount != null && evidence.appToolRegistrySharedFileCount === evidence.appToolRegistryLocalFileCount;
        lines.push(`  app-tool registry: ${registryClean ? "ok" : "\u9700\u5904\u7406"} / files=${evidence.appToolRegistrySharedFileCount ?? "\u672a\u77e5"}/${evidence.appToolRegistryLocalFileCount ?? "\u672a\u77e5"} / content=${evidence.appToolRegistryContentMatches ? "match" : "mismatch"} / fingerprint=${evidence.appToolRegistryFingerprintMatches ? "match" : "mismatch"}`);
      }
      if (Array.isArray(evidence.mcpMissingSharedSample) && evidence.mcpMissingSharedSample.length) lines.push(`  MCP missing: ${evidence.mcpMissingSharedSample.join(", ")}`);
      if (Array.isArray(evidence.mcpExtraLocalSample) && evidence.mcpExtraLocalSample.length) lines.push(`  MCP extra: ${evidence.mcpExtraLocalSample.join(", ")}`);
      if (Array.isArray(evidence.mcpChangedSharedSample) && evidence.mcpChangedSharedSample.length) lines.push(`  MCP changed: ${evidence.mcpChangedSharedSample.join(", ")}`);
      if (Array.isArray(evidence.missingSharedSkillSample) && evidence.missingSharedSkillSample.length) lines.push(`  skill missing: ${evidence.missingSharedSkillSample.join(", ")}`);
      if (Array.isArray(evidence.extraLocalSkillSample) && evidence.extraLocalSkillSample.length) lines.push(`  skill extra: ${evidence.extraLocalSkillSample.join(", ")}`);
      if (Array.isArray(evidence.changedSharedSkillSample) && evidence.changedSharedSkillSample.length) lines.push(`  skill changed: ${evidence.changedSharedSkillSample.join(", ")}`);
      if (Array.isArray(evidence.conflictingDuplicateSkillSample) && evidence.conflictingDuplicateSkillSample.length) lines.push(`  skill duplicate conflicts: ${evidence.conflictingDuplicateSkillSample.join(", ")}`);
    }
    if (item.refreshFeatureEvidence) {
      const evidence = item.refreshFeatureEvidence;
      const connectorOk = evidence.connectorSharedExists !== true || evidence.connectorContentMatches === true;
      const appToolOk = evidence.appToolSharedExists !== true || evidence.appToolContentMatches === true;
      const skillChanged = Array.isArray(evidence.changedExpectedSkills) ? evidence.changedExpectedSkills : [];
      const guidanceChanged = Array.isArray(evidence.guidanceChanged) ? evidence.guidanceChanged : [];
      const elapsed = evidence.elapsedMs != null ? ` / elapsed=${evidence.elapsedMs} ms` : "";
      const mode = evidence.verifyOnly === true ? " / verifyOnly=true" : "";
      const hashCache = evidence.hashCacheHitCount != null || evidence.hashCacheMissCount != null ? ` / hashCache=${evidence.hashCacheHitCount ?? "\u672a\u77e5"}/${evidence.hashCacheMissCount ?? "\u672a\u77e5"}` : "";
      const refreshSamples = [
        ...(evidence.connectorMissingSharedSample || []),
        ...(evidence.connectorExtraLocalSample || []),
        ...(evidence.connectorChangedSharedSample || []),
        ...(evidence.appToolMissingSharedSample || []),
        ...(evidence.appToolExtraLocalSample || []),
        ...(evidence.appToolChangedSharedSample || []),
      ].slice(0, 5);
      const refreshDrift = ` / connectorDrift=${evidence.connectorMissingSharedCount ?? 0}/${evidence.connectorExtraLocalCount ?? 0}/${evidence.connectorChangedSharedCount ?? 0} / appToolDrift=${evidence.appToolMissingSharedCount ?? 0}/${evidence.appToolExtraLocalCount ?? 0}/${evidence.appToolChangedSharedCount ?? 0}${refreshSamples.length ? ` / sample ${refreshSamples.join(", ")}` : ""}`;
      lines.push(`  refresh parity: connector=${connectorOk ? "ok" : "\u9700\u5904\u7406"} / appTool=${appToolOk ? "ok" : "\u9700\u5904\u7406"}${refreshDrift}${mode}${elapsed}${hashCache}`);
      if (skillChanged.length || guidanceChanged.length) lines.push(`  refresh drift: skills=${skillChanged.length ? skillChanged.slice(0, 5).join(", ") : "ok"} / guidance=${guidanceChanged.length ? guidanceChanged.slice(0, 5).join(", ") : "ok"}`);
      const recoveryActions = Array.isArray(evidence.recoveryActions) ? evidence.recoveryActions : [];
      if (recoveryActions.length) {
        const recoveryText = recoveryActions.slice(0, 3).map((action) => {
          const commands = Array.isArray(action.commands) ? action.commands.slice(0, 2).join(" | ") : "";
          return [action.id, action.guidance, commands].filter(Boolean).join(" / ");
        }).filter(Boolean).join(" ; ");
        if (recoveryText) lines.push(`  refresh recovery: ${recoveryText}`);
      }
    }
    if (item.localConnectorEvidence) {
      const evidence = item.localConnectorEvidence;
      lines.push(`  \u8fde\u63a5\u5668\u8bc1\u636e\uff1aChatGPT URL ${evidence.chatgptInstallUrlsScrubbed ? "\u5df2\u6e05\u7406" : "\u9700\u5904\u7406"} / \u4e0a\u6e38\u8bf7\u6c42 ${evidence.upstreamRequestsDuringLocalEndpoints ?? "\u672a\u77e5"} / allowlist ${evidence.allowlistedConnectorAccessible ? "\u88ab\u5f53\u6210\u6388\u6743" : "\u4e0d\u7b49\u4e8e\u6388\u6743"}`);
      const getPostMissing = Array.isArray(evidence.appToolGetPostMissingFromGet) ? evidence.appToolGetPostMissingFromGet : [];
      const getPostExtra = Array.isArray(evidence.appToolGetPostExtraFromGet) ? evidence.appToolGetPostExtraFromGet : [];
      const getPostSamples = [...getPostMissing, ...getPostExtra].slice(0, 5);
      const connectorMissing = Array.isArray(evidence.connectorParityMissingShared) ? evidence.connectorParityMissingShared : [];
      const connectorExtra = Array.isArray(evidence.connectorParityExtraLocal) ? evidence.connectorParityExtraLocal : [];
      const connectorChanged = Array.isArray(evidence.connectorParityChangedShared) ? evidence.connectorParityChangedShared : [];
      const appToolMissing = Array.isArray(evidence.appToolParityMissingShared) ? evidence.appToolParityMissingShared : [];
      const appToolExtra = Array.isArray(evidence.appToolParityExtraLocal) ? evidence.appToolParityExtraLocal : [];
      const appToolChanged = Array.isArray(evidence.appToolParityChangedShared) ? evidence.appToolParityChangedShared : [];
      const driftSamples = [...connectorMissing, ...connectorExtra, ...connectorChanged, ...appToolMissing, ...appToolExtra, ...appToolChanged].slice(0, 5);
      lines.push(`  local connector upstream: before=${evidence.upstreamRequestsBeforeLocalEndpoints ?? "\u672a\u77e5"} / after=${evidence.upstreamRequestsAfterLocalEndpoints ?? "\u672a\u77e5"} / delta=${evidence.upstreamRequestsDuringLocalEndpoints ?? "\u672a\u77e5"}`);
      lines.push(`  local connector isolation: sharedHomeUsed=${evidence.tempSharedHomeUsed ? "true" : "false"} / codexHomeUnderState=${evidence.tempCodexHomeUnderStateRoot ? "true" : "false"} / sharedUnderState=${evidence.tempSharedCodexHomeUnderStateRoot ? "true" : "false"} / distinct=${evidence.tempCodexHomeDistinctFromShared ? "true" : "false"}`);
      lines.push(`  local connector parity: connector=${evidence.connectorParityClean ? "ok" : "\u9700\u5904\u7406"} / appTool=${evidence.appToolParityClean ? "ok" : "\u9700\u5904\u7406"} / getPost=${evidence.appToolGetPostParityClean ? "ok" : "\u9700\u5904\u7406"} / getPostMissing=${getPostMissing.length} / getPostExtra=${getPostExtra.length}${getPostSamples.length ? ` / sample ${getPostSamples.join(", ")}` : ""}`);
      lines.push(`  local connector drift: connectorMissing=${connectorMissing.length} / connectorExtra=${connectorExtra.length} / connectorChanged=${connectorChanged.length} / appToolMissing=${appToolMissing.length} / appToolExtra=${appToolExtra.length} / appToolChanged=${appToolChanged.length}${driftSamples.length ? ` / sample ${driftSamples.join(", ")}` : ""}`);
      lines.push(`  local cache fingerprints: connector=${evidence.connectorFingerprintMatches ? "match" : "\u672a\u77e5"} / appTool=${evidence.appToolFingerprintMatches ? "match" : "\u672a\u77e5"} / connectorFiles=${evidence.connectorSharedExists && evidence.connectorLocalExists ? "present" : "\u9700\u5904\u7406"} / appToolFiles=${evidence.appToolSharedExists && evidence.appToolLocalExists ? "present" : "\u9700\u5904\u7406"}`);
      if (Array.isArray(evidence.exposedToolNames) && evidence.exposedToolNames.length) lines.push(`  \u53ef\u89c1\u5de5\u5177\uff1a${evidence.exposedToolNames.join(", ")}`);
    }
    if (item.pluginCapabilityEvidence) {
      const evidence = item.pluginCapabilityEvidence;
      const parityClean = evidence.connectorParityClean === true && evidence.appToolParityClean === true && evidence.appToolGetPostParityClean === true;
      lines.push(`  \u5e94\u7528\u5de5\u5177\u8bc1\u636e\uff1a\u672a\u6388\u6743\u5de5\u5177 ${evidence.unauthorizedAppToolCount ?? "\u672a\u77e5"} / \u65e0 connector_id ${evidence.unattributedAppToolCount ?? "\u672a\u77e5"} / parity ${parityClean ? "\u5e72\u51c0" : "\u9700\u5904\u7406"}`);
      lines.push(`  app capability: state=${evidence.capabilityState || "unknown"} / degraded=${evidence.degraded ? "true" : "false"} / smokeChecked=${evidence.smokeChecked ? "true" : "false"} / endpointReadable=${evidence.endpointProjectionReadable ? "true" : "false"} / connectors=${evidence.accessibleConnectorCount ?? "\u672a\u77e5"}/${evidence.enabledConnectorCount ?? "\u672a\u77e5"}/${evidence.connectorCount ?? "\u672a\u77e5"} / tools=${evidence.appToolCount ?? "\u672a\u77e5"}/${evidence.appToolGetCount ?? "\u672a\u77e5"} / callable=${evidence.callableState || "unknown"} / nativeWriteback=${evidence.nativeCodexWriteback ? "true" : "false"}`);
      lines.push(`  app cache smoke: connector=${evidence.connectorCacheChecked ? "checked" : "\u672a\u77e5"}/${evidence.connectorCacheSampleReadable ? "readable" : "\u672a\u77e5"}/${evidence.connectorCacheFileCount ?? "\u672a\u77e5"} / appTools=${evidence.appToolsCacheChecked ? "checked" : "\u672a\u77e5"}/${evidence.appToolsCacheSampleReadable ? "readable" : "\u672a\u77e5"}/${evidence.appToolsCacheFileCount ?? "\u672a\u77e5"} / connectorChecked=${evidence.connectorParityChecked ? "true" : "false"} / appToolChecked=${evidence.appToolParityChecked ? "true" : "false"} / getPostChecked=${evidence.appToolGetPostParityChecked ? "true" : "false"}`);
      if (evidence.appToolsNote) lines.push(`  app capability note: ${evidence.appToolsNote}`);
      if (!parityClean) {
        const samples = [...(evidence.connectorParityMissingSharedSample || []), ...(evidence.connectorParityExtraLocalSample || []), ...(evidence.connectorParityChangedSharedSample || []), ...(evidence.appToolParityMissingSharedSample || []), ...(evidence.appToolParityExtraLocalSample || []), ...(evidence.appToolParityChangedSharedSample || []), ...(evidence.appToolGetPostMissingFromGetSample || []), ...(evidence.appToolGetPostExtraFromGetSample || [])].slice(0, 5);
        lines.push(`  parity drift: connectorMissing=${evidence.connectorParityMissingSharedCount ?? "\u672a\u77e5"} / connectorExtra=${evidence.connectorParityExtraLocalCount ?? "\u672a\u77e5"} / connectorChanged=${evidence.connectorParityChangedSharedCount ?? "\u672a\u77e5"} / appToolMissing=${evidence.appToolParityMissingSharedCount ?? "\u672a\u77e5"} / appToolExtra=${evidence.appToolParityExtraLocalCount ?? "\u672a\u77e5"} / appToolChanged=${evidence.appToolParityChangedSharedCount ?? "\u672a\u77e5"} / getPostMissing=${evidence.appToolGetPostMissingFromGetCount ?? "\u672a\u77e5"} / getPostExtra=${evidence.appToolGetPostExtraFromGetCount ?? "\u672a\u77e5"}${samples.length ? ` / sample ${samples.join(", ")}` : ""}`);
      }
      lines.push(`  \u539f\u751f Codex \u5199\u56de\uff1a${evidence.nativeCodexWriteback ? "\u9700\u5904\u7406" : "\u65e0"}`);
    }
    if (item.providerContinuity) {
      const continuity = item.providerContinuity;
      const markerCounts = [continuity.sixthMarkerCount, continuity.seventhMarkerCount, continuity.eighthMarkerCount, continuity.ninthMarkerCount].filter((value) => value !== null && value !== undefined).join("/");
      lines.push(`  providerContinuity: turns=${continuity.turns ?? "unknown"} / markers=${markerCounts || "unknown"}`);
      lines.push(`  toolPairs: restart=${continuity.restartPreservesOpenAiToolPair ? "true" : "false"} / openai=${continuity.providerSwitchPreservesOpenAiToolPair ? "true" : "false"} / anthropic=${continuity.protocolSwitchPreservesAnthropicToolPair ? "true" : "false"} / reverse=${continuity.reverseProtocolSwitchPreservesOpenAiToolPair ? "true" : "false"} / markerThresholds=${continuity.markerThresholdsOk ? "true" : "false"}`);
      lines.push(`  providerRoutes: provider=${continuity.providerSwitch?.from || "unknown"}->${continuity.providerSwitch?.to || "unknown"} reached=${continuity.providerSwitch?.requestReachedSecondProvider ? "true" : "false"} / protocol=${continuity.protocolSwitch?.from || "unknown"}->${continuity.protocolSwitch?.to || "unknown"} ${continuity.protocolSwitch?.provider || "unknown"}/${continuity.protocolSwitch?.model || "unknown"} reached=${continuity.protocolSwitch?.requestReachedAnthropicProvider ? "true" : "false"} / reverse=${continuity.reverseProtocolSwitch?.from || "unknown"}->${continuity.reverseProtocolSwitch?.to || "unknown"} ${continuity.reverseProtocolSwitch?.provider || "unknown"}/${continuity.reverseProtocolSwitch?.model || "unknown"} reached=${continuity.reverseProtocolSwitch?.requestReachedOpenAiCompatibleProvider ? "true" : "false"} / structural=${continuity.structuralEvidenceClean ? "true" : "false"} / toolTurns=${continuity.toolHistoryTurns ?? "unknown"}`);
      if (continuity.previousResponseContinuity) {
        const ids = continuity.previousResponseContinuity;
        lines.push(`  previousIds: save=${ids.savePresent ? "true" : "false"} / restart=${ids.restartPresent ? "true" : "false"} / provider=${ids.providerSwitchPresent ? "true" : "false"} / protocol=${ids.protocolSwitchPresent ? "true" : "false"} / reverse=${ids.reverseProtocolSwitchPresent ? "true" : "false"}`);
        lines.push(`  previousMatches: save=${ids.saveMatched ? "true" : "false"} / restart=${ids.restartMatched ? "true" : "false"} / provider=${ids.providerSwitchMatched ? "true" : "false"} / protocol=${ids.protocolSwitchMatched ? "true" : "false"} / reverse=${ids.reverseProtocolSwitchMatched ? "true" : "false"}`);
        lines.push(`  nestedMatches: provider=${ids.providerSwitchMatchesNested ? "true" : "false"} / protocol=${ids.protocolSwitchMatchesNested ? "true" : "false"} / reverse=${ids.reverseProtocolSwitchMatchesNested ? "true" : "false"}`);
      }
      if (continuity.previousResponseIdChain) {
        const chain = continuity.previousResponseIdChain;
        lines.push(`  previousChain: save=${chain.save || "missing"} / restart=${chain.restart || "missing"} / provider=${chain.providerSwitch || "missing"} / protocol=${chain.protocolSwitch || "missing"} / reverse=${chain.reverseProtocolSwitch || "missing"}`);
      }
      lines.push(`  orderedHistory: clean=${continuity.orderedHistoryClean ? "true" : "false"} / counts=${[continuity.sixthOrderedHistoryCount, continuity.seventhOrderedHistoryCount, continuity.eighthOrderedHistoryCount, continuity.ninthOrderedHistoryCount].filter((value) => value !== null && value !== undefined).join("/") || "unknown"}`);
    }
    if (item.optionalRealProviderEvidence) {
      const evidence = item.optionalRealProviderEvidence;
      lines.push(`  realProviderSmoke: first=${evidence.firstMarkerObserved ? "true" : "false"} / second=${evidence.secondMarkerObserved ? "true" : "false"} / history=${evidence.historyContinuationObserved ? "true" : "false"} / turns=${evidence.turns ?? "\u672a\u77e5"}`);
      lines.push(`  realProviderSmoke route: ${evidence.routeTransport || "\u672a\u77e5"} / ${evidence.routeProviderProtocol || "\u672a\u77e5"} / requested=${evidence.routeRequestedModel || "\u672a\u77e5"} / resolved=${evidence.routeResolvedModel || "\u672a\u77e5"} / status=${evidence.routeStatus || "\u672a\u77e5"} / redaction=${evidence.secretsRedacted ? "true" : "false"}`);
    }
    if (item.realProviderToAntigravityReturnEvidence) {
      const evidence = item.realProviderToAntigravityReturnEvidence;
      lines.push(`  realProviderToAntigravityReturn: requested=${evidence.requested ? "true" : "false"} / used=${evidence.realAntigravityTurnUsed ? "true" : "false"} / history=${evidence.returnedToAntigravityWithHistory ? "true" : "false"} / previousId=${evidence.previousResponseIdMatched ? "true" : "false"} / markers=${evidence.markerCount ?? "\u672a\u77e5"} missing=${evidence.missingMarkerCount ?? "\u672a\u77e5"}`);
      lines.push(`  realProviderToAntigravityRoute: ${evidence.returnUpstream || "\u672a\u77e5"} / ${evidence.routeTransport || "\u672a\u77e5"} / requested=${evidence.requestedModel || "\u672a\u77e5"} / resolved=${evidence.resolvedModel || "\u672a\u77e5"}`);
    }
    if (item.antigravityReturnEvidence) {
      const evidence = item.antigravityReturnEvidence;
      lines.push(`  fakeProviderToAntigravityReturn: history=${evidence.returnedToAntigravityWithHistory ? "true" : "false"} / previousId=${evidence.previousResponseIdMatched ? "true" : "false"} / markers=${evidence.markerCount ?? "\u672a\u77e5"} missing=${evidence.missingMarkerCount ?? "\u672a\u77e5"}`);
      lines.push(`  fakeProviderToAntigravityRoute: ${evidence.routeTransport || "\u672a\u77e5"} / ${evidence.resolvedModel || "\u672a\u77e5"}`);
    }
    if (item.coldRelaunchEvidence) {
      const evidence = item.coldRelaunchEvidence;
      lines.push(`  coldRelaunch: health=${evidence.healthOk ? "true" : "false"} / ready=${evidence.providerReady ? "true" : "false"} / mode=${evidence.mode || "unknown"} / main=${evidence.mainCount ?? "?"} / translator=${evidence.translatorCount ?? "?"} / launcher=${evidence.launcherCount ?? "?"} / originalCodex=${evidence.originalCodexUnchanged ? "unchanged" : "unknown"} / failedStages=${evidence.failedStageCount ?? "?"}`);
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
    `\u771f\u5b9e\u5de5\u5177\u8c03\u7528\uff1anode_repl ${result.mcp?.smoke?.realCall?.passed ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}\uff0cworker list ${Array.isArray(result.mcp?.smoke?.realList) ? result.mcp.smoke.realList.filter((entry) => entry && entry.passed === true).length : "\u672a\u77e5"}/${Array.isArray(result.mcp?.smoke?.realList) ? result.mcp.smoke.realList.length : "\u672a\u77e5"}\uff0cSkill \u6587\u4ef6 ${result.skills?.smoke?.readable ? "\u53ef\u8bfb" : "\u672a\u8bfb\u5230"}`,
  ].join("\n");
  if (action === "pluginCapabilities") {
    const capabilities = result.capabilities || {};
    const appTools = capabilities.appToolCount ?? 0;
    const accessibleConnectors = capabilities.accessibleConnectorCount ?? 0;
    const callableState = capabilities.smoke?.callableState || capabilities.callableState || "";
    const smokeChecked = capabilities.smoke?.checked === true;
    const capabilityState = capabilities.capabilityState || "";
    const callableSummary = appTools > 0
      ? `\u5e94\u7528\u5de5\u5177 ${appTools} / callable=${smokeChecked && callableState ? callableState : "unknown"}`
      : accessibleConnectors > 0
        ? `\u5df2\u6388\u6743\u8fde\u63a5\u5668 ${accessibleConnectors} \u4f46\u672a\u53d1\u73b0\u53ef\u8c03\u7528\u5e94\u7528\u5de5\u5177 / callable=${callableState || "unknown"}`
        : `\u65e0\u6388\u6743\u8fde\u63a5\u5668\uff0cmetadata-only \u4e0d\u4f2a\u88c5\u53ef\u8c03\u7528 / state=${capabilityState || "unknown"} / callable=${callableState || "unknown"}`;
    return [
      `\u63d2\u4ef6/\u5e94\u7528\u6e05\u5355\u53ef\u89c1\uff1a${result.ok ? "\u901a\u8fc7" : "\u9700\u8981\u5904\u7406"}`,
      `\u5df2\u5b89\u88c5\u63d2\u4ef6 ${capabilities.installedPluginCount ?? "\u672a\u77e5"} / \u8fde\u63a5\u5668 ${capabilities.connectorCount ?? "\u672a\u77e5"}`,
      `\u77ed\u9884\u7b97\uff1a${result.shortBudgetMode ? "\u662f" : "\u5426"} / state=${capabilityState || "unknown"}`,
      sourceSnapshotLine(result),
      `\u6295\u5f71 smoke\uff1a${capabilities.smoke?.endpointProjectionReadable ? "\u7aef\u70b9\u53ef\u8bfb" : "\u7aef\u70b9\u672a\u8bfb\u5230"}\uff0c\u7f13\u5b58 ${capabilities.smoke?.connectorCache?.sampleReadable ? "\u53ef\u8bfb" : "\u672a\u8bfb\u5230"}`,
      `\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a${callableSummary}`,
      capabilities.appToolsNote ? `\u8bf4\u660e\uff1a${capabilities.appToolsNote}` : "",
      localGatewayGuidanceLine(result),
      failureSummaryLine(result),
    ].filter(Boolean).join("\n");
  }
  if (action === "refreshFeatures" && payload?.background) return payload?.alreadyRunning ? "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u8bf7\u7a0d\u540e\u70b9\u201c\u5237\u65b0\u72b6\u6001\u201d\u6216 MCP/Skill\u3001\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838\u3002" : "\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a\u5df2\u5f00\u59cb\u540e\u53f0\u6267\u884c\u3002\n\u754c\u9762\u4e0d\u4f1a\u7b49\u5f85\u957f\u65f6\u590d\u5236\uff1b\u5b8c\u6210\u540e\u7528 MCP/Skill \u548c\u63d2\u4ef6/\u5e94\u7528\u6309\u94ae\u590d\u6838\u3002";
  const recoveryActionIds = Array.isArray(result.recoveryActions) ? result.recoveryActions.map((action) => action?.id).filter(Boolean).slice(0, 3) : [];
  if (action === "refreshFeatures") return [
    `\u672c\u5730\u529f\u80fd\u5237\u65b0\uff1a${result.ok ? "\u5b8c\u6210" : "\u9700\u8981\u5904\u7406"}`,
    `Skill ${result.skills?.count ?? "\u672a\u77e5"} / \u8fde\u63a5\u5668\u7f13\u5b58 ${result.connectors?.count ?? "\u672a\u77e5"}`,
    sourceSnapshotLine(result),
    recoveryActionIds.length ? `recoveryActions: ${recoveryActionIds.join(", ")}` : "",
    "\u53ef\u8c03\u7528\u9a8c\u8bc1\uff1a\u5237\u65b0\u540e\u4ecd\u9700\u5355\u72ec smoke \u9a8c\u8bc1",
  ].filter(Boolean).join("\n");
  if (action === "stabilitySoak") {
    if (payload.alreadyRunning) return "\u7a33\u5b9a\u6027\u5de1\u68c0\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u5b83\u4f1a\u6d88\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff1b\u8bf7\u7a0d\u540e\u70b9\u201c\u67e5\u770b\u6700\u65b0\u62a5\u544a\u201d\u786e\u8ba4\u7ed3\u679c\u3002";
    return `${payload.ok ? "\u5df2\u5728\u540e\u53f0\u5f00\u59cb\u7a33\u5b9a\u6027\u5de1\u68c0\u3002" : "\u542f\u52a8\u7a33\u5b9a\u6027\u5de1\u68c0\u5931\u8d25\u3002"}\n\u8fd9\u4f1a\u6d88\u8017\u771f\u5b9e Antigravity \u6d41\u91cf\uff0c\u5b8c\u6210\u540e\u4f1a\u5199\u5165 latest-stability-soak.json\u3002`;
  }
  if (action === "coldRelaunch") {
    if (payload.alreadyRunning) return "\u51b7\u542f\u52a8\u9a8c\u8bc1\u5df2\u5728\u540e\u53f0\u8fd0\u884c\u3002\n\u5b83\u4f1a\u91cd\u542f Anti-Codex\uff1b\u8bf7\u7a0d\u540e\u70b9\u201c\u67e5\u770b\u6700\u65b0\u62a5\u544a\u201d\u786e\u8ba4\u7ed3\u679c\u3002";
    return `${payload.ok ? "\u5df2\u5728\u540e\u53f0\u5f00\u59cb\u51b7\u542f\u52a8\u9a8c\u8bc1\u3002" : "\u542f\u52a8\u51b7\u542f\u52a8\u9a8c\u8bc1\u5931\u8d25\u3002"}\n\u8fd9\u4f1a\u91cd\u542f Anti-Codex\uff0c\u5b8c\u6210\u540e\u4f1a\u5199\u5165 latest-cold-relaunch.json\u3002`;
  }
  if (action === "syncHost") return payload?.alreadyRunning ? "\u540c\u6b65\u5df2\u5728\u540e\u53f0\u8fd0\u884c" : "\u5df2\u5f00\u59cb\u540e\u53f0\u540c\u6b65 Codex \u66f4\u65b0";
  if (action === "diagnosticsBundle") {
    const longTasks = unwrappedResult.diagnosticsSummary?.longTasks;
    const otherRunningCount = longTasks?.otherRunningItems?.length;
    return [
      `\u8bca\u65ad\u5305\uff1a${unwrappedResult.ok ?? result.ok ? "\u5df2\u751f\u6210" : "\u5931\u8d25"}`,
      unwrappedResult.zipPath ? `ZIP\uff1a${unwrappedResult.zipPath}` : "",
      unwrappedResult.bundleRoot ? `\u76ee\u5f55\uff1a${unwrappedResult.bundleRoot}` : "",
      longTasks ? `\u957f\u4efb\u52a1\uff1a\u8fd0\u884c ${longTasks.runningCount ?? 0} / \u9700\u5904\u7406 ${longTasks.attentionCount ?? 0} / \u5176\u4ed6\u8fd0\u884c ${otherRunningCount ?? 0}` : "",
      failureSummaryLine(unwrappedResult),
      (!unwrappedResult.zipPath && !unwrappedResult.bundleRoot && !unwrappedResult.failures?.length) ? (payload?.message || result.message || "") : "",
    ].filter(Boolean).join("\n");
  }
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
  const selfSource = readFileSync(new URL(import.meta.url), "utf8");
  assert.match(selfSource, /error\.statusCode = response\.statusCode/);
  assert.match(selfSource, /const token = await bootstrapManagerActionToken\(\);[\s\S]*?try \{[\s\S]*?return await postManagerActionWithToken\(token\);/);
  assert.match(selfSource, /error\?\.statusCode !== 403/);
  assert.match(selfSource, /return await postManagerActionWithToken\(await bootstrapManagerActionToken\(\)\)/);

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
    existingCount: 3,
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
    }, {
      label: "\u672c\u5730\u529f\u80fd\u5237\u65b0",
      exists: true,
      ok: false,
      refreshFeatureEvidence: {
        connectorSharedExists: true,
        connectorContentMatches: true,
        appToolSharedExists: true,
        appToolContentMatches: true,
        hashCacheHitCount: 12000,
        hashCacheMissCount: 42,
        changedExpectedSkills: ["changed-skill"],
        guidanceChanged: ["RTK.md"],
      },
    }],
  });
  assert.match(connectorSummary, /\u8fde\u63a5\u5668\u8bc1\u636e/);
  assert.match(connectorSummary, /\u4e0a\u6e38\u8bf7\u6c42 0/);
  assert.match(connectorSummary, /\u5e94\u7528\u5de5\u5177\u8bc1\u636e/);
  assert.match(connectorSummary, /\u672a\u6388\u6743\u5de5\u5177 0/);
  assert.match(connectorSummary, /refresh drift: skills=changed-skill \/ guidance=RTK\.md/);
  assert.match(connectorSummary, /hashCache=12000\/42/);
  const evidenceSummary = latestReportsSummary({
    reportRoot: "C:\\tmp\\anticodex\\reports",
    existingCount: 6,
    reports: [{
      label: "Release Gate",
      exists: true,
      ok: true,
      releaseReady: true,
      shortReady: true,
      strictOptionalRealTraffic: true,
      optionalRealTrafficReady: false,
      optionalRealTrafficFailures: ["realThirdPartyProviderOptional"],
      missingShort: ["latest-ui-idle.json"],
      missingOptional: ["coldRelaunch"],
      damagedReports: ["latest-native-tool-loop.json"],
      releaseGateFailureReasons: [
        { id: "postVerification", group: "real-traffic", failureReason: "stale_report", failureReasons: ["stale_report"], failureReasonsHiddenCount: 2, ageHours: 56.1, fresh: false, selectedFromHistory: true, requiredForShort: false, requiredForRelease: true, selectedFile: "latest-post-verification.json", selectedMtime: "2026-06-24T01:02:03.000Z", reportFailureSampleCodes: ["local_gateway_offline"], reportFailureSamples: ["gateway offline", "health timeout", "extra hidden"], orderedActions: [{ id: "postVerification", reason: "stale_report", guidance: "rerun post verification with real traffic" }] },
        { id: "realWork", group: "real-traffic", failureReason: "missing_report", failureReasons: ["missing_report"], orderedActions: [{ id: "realWork", reason: "missing_report", guidance: "run real work verifier after approval" }] },
        { id: "sourcePreflight", group: "short", failureReason: "semantic_failures", failureReasons: ["semantic_failures"], selectedFile: "latest-source-preflight.json", reportFailureSampleCodes: ["source_preflight_no_traffic"], reportFailureSamples: ["noTraffic missing"], guidance: "rerun source preflight", orderedActions: [{ id: "sourcePreflight" }] },
        { id: "mcpSkills", group: "short", failureReason: "semantic_failures", failureReasons: ["semantic_failures"], selectedFile: "latest-mcp-skills.json", reportFailureSampleCodes: ["mcp_skills_source_snapshot_mismatch"], reportFailureSamples: ["source mismatch"], guidance: "rerun MCP skills", orderedActions: [{ id: "mcpSkills" }] },
        { id: "localConnectors", group: "short", failureReason: "semantic_failures", failureReasons: ["semantic_failures"], selectedFile: "latest-local-connectors.json", reportFailureSampleCodes: ["local_connector_parity"], reportFailureSamples: ["connector drift"], guidance: "rerun local connectors", orderedActions: [{ id: "localConnectors" }] },
        { id: "modelRouting", group: "no-traffic", failureReason: "missing_report", failureReasons: ["missing_report"], selectedFile: "latest-model-routing.json", reportFailureSampleCodes: ["missing_report"], reportFailureSamples: ["missing model routing"], guidance: "rerun model routing", orderedActions: [{ id: "modelRouting" }] },
        { id: "syncReadiness", group: "no-traffic", failureReason: "stale_report", failureReasons: ["stale_report"], selectedFile: "latest-sync-readiness.json", reportFailureSampleCodes: ["stale_report"], reportFailureSamples: ["stale sync"], guidance: "rerun sync readiness", orderedActions: [{ id: "syncReadiness" }] },
      ],
      nextActions: [
        { id: "releaseGateReportOnlyCheck", gateId: "postVerification", reportOnly: true, reason: "semantic_failures", guidance: "review release gate details first" },
        { id: "realWork", gateId: "realWork", reason: "missing_report", guidance: "run real work verifier after approval" },
        { id: "postVerification", gateId: "postVerification", reason: "stale_report", guidance: "rerun post verification with real traffic" },
        ...Array.from({ length: 8 }, (_, index) => ({ id: `action${index + 3}`, gateId: `gate${index + 3}` })),
      ],
      approvalPlan: {
        actionCount: 3,
        reportOnlyCount: 1,
        blockedCount: 2,
        requiresGatewayStartCount: 2,
        requiresRealTrafficCount: 2,
        highImpactCount: 1,
        requiredForShortCount: 1,
        requiredForReleaseCount: 2,
        firstBlockedAction: "realWork",
        phases: [
          { phase: "real-traffic-high-impact", count: 1, requiresGatewayStart: true, requiresRealTraffic: true, highImpact: true, blockedUntilExplicitUserApproval: true },
          { phase: "real-traffic-final", count: 1, requiresGatewayStart: true, requiresRealTraffic: true, blockedUntilExplicitUserApproval: true },
        ],
      },
      releaseGateSelectedReports: [{ id: "syncReadiness", group: "no-traffic", selectedFile: "20260624-071841-sync-readiness.json" }],
      releaseGateGroups: [{ group: "cold", required: 0, requiredSatisfied: 0, optional: 1, optionalSatisfied: 0, missingOptional: ["coldRelaunch"] }, { group: "real-traffic", required: 2, requiredSatisfied: 0, optional: 0, optionalSatisfied: 0, missingRequired: ["postVerification", "realWork"] }],
      releaseGateFailures: [
        { id: "ui-idle", semanticFailures: ["ui_idle_missing_samples", "ui_idle_no_idle", "ui_idle_no_timestamp", "ui_idle_bad_state"], semanticFailuresHiddenCount: 2 },
        { id: "mcpSkills", semanticFailures: ["mcp_skills_source_snapshot_mismatch"] },
        { id: "pluginCapabilities", semanticFailures: ["plugin_capabilities_source_snapshot_mismatch"] },
        { id: "sourcePreflight", semanticFailures: ["source_preflight_no_traffic"] },
        { id: "syncReadiness", semanticFailures: ["sync_readiness_full_mode_required"] },
      ],
      installedRuntimeEvidence: { satisfied: false, sourceFileCount: 58, installedRuntimeFileCount: 58, sourceFingerprint: "abcdef012345", installedRuntimeFingerprint: "abcdef012345", sourceMtimeMax: "2026-06-24T01:02:03.000Z", installedRuntimeMtimeMax: "2026-06-24T01:03:04.000Z", missingSourceFiles: ["scripts/a.ps1"], missingInstalledRuntimeFiles: ["scripts/b.ps1"], mismatchedRuntimeFiles: ["scripts/c.ps1"] },
    }, {
      label: "\u6a21\u578b\u601d\u8003\u9884\u7b97",
      exists: true,
      ok: true,
      modelThinkingEvidence: { expectedModelCount: 2, actualModelCount: 2, modelCount: 2, supportsThinkingCount: 2, missingBudgetCount: 0, reasoningLevels: ["high", "low"] },
    }, {
      label: "\u6e90\u7801\u9884\u68c0",
      exists: true,
      ok: true,
      sourceSnapshotEvidence: { fingerprint: "abcdef0123456789", fileCount: 15589, cacheHitCount: 12000, cacheMissCount: 42, reusedFromPreviousReport: true, refreshSkippedReason: "short_budget_reused_previous_snapshot" },
      sourcePreflightEvidence: { javascriptSyntaxOk: true, powershellSyntaxOk: true, upstreamProfileStorageOk: true, antigravityCliIsolationProfileOk: true, antigravityCliProfilePrepareOk: true, antigravityCliProfilePrepareRejectsDefaultChildOk: true, antigravityCliWindowsUserLoginDryRunOk: true, localConnectorVerifierOk: true, publicDocumentationOk: true, publicDocumentationClientCopySyncContractOk: true, uiStateSelfTestOk: true, translatorRegressionOk: true, diffWhitespaceOk: true, skipFullRegression: false },
    }, {
      label: "\u65e5\u5fd7\u5e93\u9632\u62a4",
      exists: true,
      ok: true,
      logDbGuardEvidence: { protected: true, triggerPresent: true, noTraffic: true, walBytes: 0 },
    }, {
      label: "MCP/Skill",
      exists: true,
      ok: true,
      mcpSkillEvidence: { mcpCount: 3, mcpSharedCount: 3, skillCount: 126, expectedSharedSkillCount: 126, agentsSkillCount: 26, hashCacheHitCount: 12000, hashCacheMissCount: 42, mcpMissingSharedCount: 0, mcpExtraLocalCount: 0, mcpChangedSharedCount: 0, missingSharedSkillCount: 0, conflictingDuplicateSkillCount: 0, hasNodeRepl: true, mcpSmokePassed: true, mcpRealCallPassed: true, mcpRealListCount: 2, mcpRealListPassed: 2, mcpRealListToolCount: 12, skillSmokeReadable: true, appToolRegistryExists: true, appToolRegistryContentMatches: true, appToolRegistryFingerprintMatches: true, appToolRegistrySharedFileCount: 36, appToolRegistryLocalFileCount: 36 },
    }, {
      label: "\u7b2c\u4e09\u65b9 provider \u8fde\u7eed\u6027",
      exists: true,
      ok: true,
      providerContinuity: { turns: 9, restartPreservesOpenAiToolPair: true, providerSwitchPreservesOpenAiToolPair: true, protocolSwitchPreservesAnthropicToolPair: true, reverseProtocolSwitchPreservesOpenAiToolPair: true, sixthMarkerCount: 15, seventhMarkerCount: 16, eighthMarkerCount: 18, ninthMarkerCount: 20, markerThresholdsOk: true, orderedHistoryClean: true, sixthOrderedHistoryCount: 7, seventhOrderedHistoryCount: 8, eighthOrderedHistoryCount: 9, ninthOrderedHistoryCount: 10, previousResponseContinuity: { savePresent: true, restartPresent: true, providerSwitchPresent: true, protocolSwitchPresent: true, reverseProtocolSwitchPresent: true } },
    }, {
      label: "\u51b7\u542f\u52a8",
      exists: true,
      ok: true,
      coldRelaunchEvidence: { healthOk: true, providerReady: true, mode: "antigravity", mainCount: 1, translatorCount: 1, launcherCount: 1, originalCodexUnchanged: true, failedStageCount: 0 },
    }, {
      label: "\u7a33\u5b9a\u6027",
      exists: true,
      ok: true,
      stabilitySoakEvidence: { providerReady: true, startReady: true, endReady: true, model: "gemini", pidStable: true, healthChecks: 5, turnCount: 2, failedTurnCount: 0 },
    }, {
      label: "\u53ef\u9009\u771f\u5b9e\u7b2c\u4e09\u65b9",
      exists: true,
      ok: true,
      optionalRealProviderEvidence: { firstMarkerObserved: true, secondMarkerObserved: true, historyContinuationObserved: true, turns: 2, routeTransport: "upstream-provider", routeProviderProtocol: "openai-compatible", routeRequestedModel: "real-model", routeResolvedModel: "real-model", routeStatus: "success", secretsRedacted: true },
      realProviderToAntigravityReturnEvidence: { requested: true, realAntigravityTurnUsed: true, returnedToAntigravityWithHistory: true, previousResponseIdMatched: true, markerCount: 3, missingMarkerCount: 0, returnUpstream: "antigravity-desktop", routeTransport: "antigravity-native", requestedModel: "gemini-pro-agent", resolvedModel: "gemini-pro-agent" },
    }, {
      label: "\u56de\u5230 Antigravity",
      exists: true,
      ok: true,
      antigravityReturnEvidence: { returnedToAntigravityWithHistory: true, previousResponseIdMatched: true, markerCount: 6, missingMarkerCount: 0, routeTransport: "antigravity-native", resolvedModel: "gemini-pro-agent" },
    }],
  });
  assert.match(evidenceSummary, /Release Gate: short=true \/ release=true/);
  assert.match(evidenceSummary, /optionalRealTraffic: strict=true \/ ready=false/);
  assert.match(evidenceSummary, /optionalRealTrafficFailures: realThirdPartyProviderOptional/);
  assert.match(evidenceSummary, /Release groups: cold req 0\/0 opt 0\/1 missingOpt=coldRelaunch/);
  assert.match(evidenceSummary, /real-traffic req 0\/2 opt 0\/0 missingReq=postVerification,realWork/);
  assert.match(evidenceSummary, /installedRuntime: satisfied=false \/ files=58\/58 \/ fingerprint=match \/ mismatches=1 \/ sourceMtime=2026-06-24T01:02:03.000Z \/ installedMtime=2026-06-24T01:03:04.000Z/);
  assert.match(evidenceSummary, /installedRuntime drift: missingSource:scripts\/a\.ps1, missingInstalled:scripts\/b\.ps1, mismatch:scripts\/c\.ps1/);
  assert.match(evidenceSummary, /missingShort: latest-ui-idle\.json/);
  assert.match(evidenceSummary, /missingOptional: coldRelaunch/);
  assert.match(evidenceSummary, /damagedReports: latest-native-tool-loop\.json/);
  assert.match(evidenceSummary, /failureReasons: postVerification:stale_report\(\+2 reasons\)\[age=56\.1h\/fresh=false\/history=true\/required=false\/true\]/);
  assert.match(evidenceSummary, /failureReasons: postVerification:stale_report\(\+2 reasons\)\[age=56\.1h\/fresh=false\/history=true\/required=false\/true\], realWork:missing_report.*\(\+1 more\)/);
  assert.match(evidenceSummary, /reportFailures: postVerification:latest-post-verification\.json @ 2026-06-24T01:02:03\.000Z \/ codes local_gateway_offline \/ sample gateway offline \| health timeout/);
  assert.match(evidenceSummary, /reportFailures: .*\(\+2 more\)/);
  assert.match(evidenceSummary, /guidance: .*\(\+1 more\)/);
  assert.match(evidenceSummary, /nextActions: postVerification:releaseGateReportOnlyCheck\[reportOnly\] -> realWork:realWork -> postVerification:postVerification/);
  assert.match(evidenceSummary, /nextActions: .*\(\+8 hidden of 16\)/);
  assert.match(evidenceSummary, /actionReasons: postVerification:releaseGateReportOnlyCheck\[reportOnly\]=semantic_failures; realWork:realWork=missing_report; postVerification:postVerification=stale_report/);
  assert.match(evidenceSummary, /actionGuidance: postVerification:releaseGateReportOnlyCheck\[reportOnly\]=review release gate details first; realWork:realWork=run real work verifier after approval; postVerification:postVerification=rerun post verification with real traffic/);
  assert.match(evidenceSummary, /approvalPlan: actions=3 \/ reportOnly=1 \/ blocked=2 \/ gateway=2 \/ realTraffic=2 \/ highImpact=1 \/ required=1\/2 \/ phases=2 \/ first=realWork/);
  assert.match(evidenceSummary, /approvalPhases: real-traffic-high-impact:1\[gateway,realTraffic,highImpact,blocked\] \| real-traffic-final:1\[gateway,realTraffic,blocked\]/);
  assert.match(evidenceSummary, /approvalPlan: .*reportOnly=1 .*blocked=2 .*required=1\/2 .*phases=2/);
  assert.doesNotMatch(evidenceSummary, /extra hidden/);
  assert.match(evidenceSummary, /真实流量验收证据需更新\/未生成：这不是普通功能缺失；请显式运行耗真实流量的验证后再做完整检查（postVerification, realWork）/);
  assert.match(evidenceSummary, /selectedHistory: syncReadiness:20260624-071841-sync-readiness\.json/);
  assert.match(evidenceSummary, /semanticFailures: ui-idle:ui_idle_missing_samples, ui_idle_no_idle, ui_idle_no_timestamp, ui_idle_bad_state \(\+2 more\)/);
  assert.match(evidenceSummary, /semanticFailures: .*\(\+1 more\)/);
  assert.match(evidenceSummary, /source snapshot mismatch: stale reports for mcpSkills, pluginCapabilities; refresh local features, MCP\/Skill, and plugin capability reports/);
  assert.match(evidenceSummary, /source snapshot refresh: refresh local features first, then run normal MCP\/Skill and plugin capability verifiers; do not edit latest report JSON by hand/);
  assert.match(evidenceSummary, /modelThinking: models=2\/2 \/ thinking=2\/2 \/ budgetMissing=0/);
  assert.match(evidenceSummary, /modelThinking levels: high, low/);
  assert.match(evidenceSummary, /sourceSnapshot: files=15589 \/ fingerprint=abcdef012345 \/ cache=12000\/42 \/ reused=true \/ reason=short_budget_reused_previous_snapshot/);
  assert.match(evidenceSummary, /sourcePreflight: js=true \/ ps=true \/ profile=true \/ cliIsolation=true \/ prepare=true \/ rejectDefaultChild=true \/ winUserLogin=true \/ localConnector=true \/ docs=true \/ clientCopyDocs=true/);
  assert.match(evidenceSummary, /sourcePreflight: ui=true \/ regression=true \/ diff=true \/ skipFull=false/);
  assert.match(evidenceSummary, /logDbGuard: protected=true \/ trigger=true \/ noTraffic=true \/ wal=0/);
  const missingHistorySummary = latestReportsSummary({
    reports: [{
      label: "\u5386\u53f2\u8fc7\u671f\u6062\u590d",
      exists: true,
      ok: true,
      missingHistoryEvidence: {
        status: 410,
        errorType: "response_history_missing",
        retryable: false,
        previousResponseIdMatched: true,
        noRouteChange: true,
        usedRealTraffic: false,
      },
    }],
  });
  assert.match(missingHistorySummary, /missingHistory: status=410 \/ type=response_history_missing \/ retryable=false \/ previousId=true \/ routeStable=true \/ noTraffic=true/);
  const skippedSummary = latestReportsSummary({
    reports: [{
      label: "optional real",
      exists: true,
      ok: true,
      skipped: true,
      reason: "real traffic opt-in",
      requestedRealTraffic: false,
      coverageKind: "skipped",
    }],
  });
  assert.match(skippedSummary, /skipped: real traffic opt-in \/ requestedRealTraffic=false \/ coverage=skipped/);
  assert.match(evidenceSummary, /MCP\/Skill/);
  assert.match(evidenceSummary, /agents 26/);
  assert.match(evidenceSummary, /hashCache=12000\/42/);
  assert.match(evidenceSummary, /app-tool registry: ok \/ files=36\/36 \/ content=match \/ fingerprint=match/);
  assert.match(evidenceSummary, /providerContinuity: turns=9 \/ markers=15\/16\/18\/20/);
  assert.match(evidenceSummary, /previousIds: save=true \/ restart=true \/ provider=true \/ protocol=true \/ reverse=true/);
  assert.match(evidenceSummary, /orderedHistory: clean=true \/ counts=7\/8\/9\/10/);
  assert.match(evidenceSummary, /MCP\/Skill parity: .+ \/ smoke MCP ok \/ real ok \/ list 2\/2 tools=12 \/ skill ok/);
  assert.match(evidenceSummary, /realProviderSmoke route: upstream-provider \/ openai-compatible \/ requested=real-model \/ resolved=real-model \/ status=success \/ redaction=true/);
  assert.match(evidenceSummary, /realProviderToAntigravityReturn: requested=true \/ used=true \/ history=true \/ previousId=true \/ markers=3 missing=0/);
  assert.match(evidenceSummary, /realProviderToAntigravityRoute: antigravity-desktop \/ antigravity-native \/ requested=gemini-pro-agent \/ resolved=gemini-pro-agent/);
  assert.match(evidenceSummary, /fakeProviderToAntigravityReturn: history=true \/ previousId=true/);
  assert.match(evidenceSummary, /fakeProviderToAntigravityRoute: antigravity-native \/ gemini-pro-agent/);
  assert.match(evidenceSummary, /coldRelaunch: health=true \/ ready=true/);
  assert.match(evidenceSummary, /coldRelaunch: .*mode=antigravity.*launcher=1.*failedStages=0/);
  assert.match(evidenceSummary, /stabilitySoak: ready=true/);
  const pluginDriftSummary = latestReportsSummary({
    reports: [{
      label: "\u5e94\u7528\u5de5\u5177",
      exists: true,
      ok: false,
      pluginCapabilityEvidence: {
        unauthorizedAppToolCount: 0,
        unattributedAppToolCount: 0,
        nativeCodexWriteback: false,
        smokeChecked: false,
        endpointProjectionReadable: false,
        connectorParityChecked: false,
        appToolParityChecked: false,
        appToolGetPostParityChecked: false,
        connectorParityClean: false,
        appToolParityClean: false,
        appToolGetPostParityClean: false,
        connectorParityMissingSharedCount: 1,
        connectorParityMissingSharedSample: ["missing-connector"],
        connectorParityExtraLocalCount: 1,
        connectorParityExtraLocalSample: ["extra-connector"],
        connectorParityChangedSharedCount: 1,
        connectorParityChangedSharedSample: ["changed-connector"],
        appToolParityMissingSharedCount: 1,
        appToolParityMissingSharedSample: ["missing-tool"],
        appToolParityExtraLocalCount: 1,
        appToolParityExtraLocalSample: ["extra-tool"],
        appToolParityChangedSharedCount: 1,
        appToolParityChangedSharedSample: ["changed-tool"],
        appToolGetPostMissingFromGetCount: 1,
        appToolGetPostMissingFromGetSample: ["missing-get"],
        appToolGetPostExtraFromGetCount: 1,
        appToolGetPostExtraFromGetSample: ["extra-get"],
      },
    }],
  });
  assert.match(pluginDriftSummary, /smokeChecked=false \/ endpointReadable=false/);
  assert.match(pluginDriftSummary, /connectorChecked=false \/ appToolChecked=false \/ getPostChecked=false/);
  assert.match(pluginDriftSummary, /parity drift: connectorMissing=1 \/ connectorExtra=1 \/ connectorChanged=1 \/ appToolMissing=1 \/ appToolExtra=1 \/ appToolChanged=1 \/ getPostMissing=1 \/ getPostExtra=1 \/ sample missing-connector, extra-connector, changed-connector, missing-tool, extra-tool/);
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
