import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: summarize-anticodex-report.mjs <report.json>");
  process.exit(2);
}

function has(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function asString(value) {
  return value === undefined || value === null ? null : String(value);
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value === undefined || value === null) return [];
  return [String(value)];
}

function boolField(object, key) {
  return has(object, key) ? !!object[key] : null;
}

const report = JSON.parse(readFileSync(path, "utf8"));
const checks = report && report.checks ? report.checks : {};
function checkOk(name) {
  return has(checks, name) && checks[name] && has(checks[name], "ok") ? !!checks[name].ok : null;
}

const managerButton = report && report.managerButton ? report.managerButton : null;
const managerResults = managerButton && managerButton.results ? managerButton.results : {};
const managerButtonResults = Object.entries(managerResults).map(([action, entry]) => {
  const value = entry && typeof entry === "object" ? entry : {};
  const payload = value.payload && typeof value.payload === "object" ? value.payload : null;
  let result = value.result && typeof value.result === "object" ? value.result : null;
  if (!result && payload && payload.result && typeof payload.result === "object") {
    result = payload.result;
  }
  if (!result && payload && payload.results && payload.results[action] && payload.results[action].result) {
    result = payload.results[action].result;
  }
  return {
    action,
    ok: boolField(value, "ok"),
    lastUiOnly: result && has(result, "lastUiOnly") ? !!result.lastUiOnly : null,
  };
});

const failureCount = has(report, "failures")
  ? (Array.isArray(report.failures) ? report.failures.length : (report.failures === null ? 0 : 1))
  : 0;
const wait = report && report.wait ? report.wait : null;
const latestWait = wait && wait.latest ? wait.latest : null;

const summary = {
  ok: has(report, "ok") ? report.ok : null,
  reportName: has(report, "reportName") ? asString(report.reportName) : null,
  skipFullRegression: boolField(report, "skipFullRegression"),
  failureCount,
  elapsedMs: has(report, "elapsedMs") ? report.elapsedMs : null,
  actions: has(report, "actions") ? asStringArray(report.actions) : [],
  managerButtonOk: managerButton ? boolField(managerButton, "ok") : null,
  managerButtonResults,
  javascriptSyntaxOk: checkOk("javascriptSyntax"),
  powershellSyntaxOk: checkOk("powershellSyntax"),
  uiStateSelfTestOk: checkOk("uiStateSelfTest"),
  publicDocumentationOk: checkOk("publicDocumentation"),
  translatorRegressionOk: checkOk("translatorRegression"),
  diffWhitespaceOk: checkOk("diffWhitespace"),
  baseUrl: has(report, "baseUrl") ? report.baseUrl : null,
  modelCount: has(report, "modelCount") ? report.modelCount : null,
  models: has(report, "models") ? asStringArray(report.models) : [],
  skipRequests: boolField(report, "skipRequests"),
  state: has(report, "state") ? asString(report.state) : null,
  usedRealTraffic: boolField(report, "usedRealTraffic"),
  latestDiagnosis: wait && has(wait, "latestDiagnosis") ? asString(wait.latestDiagnosis) : null,
  latestDiagnosisDetail: latestWait && has(latestWait, "diagnosisDetail") ? asString(latestWait.diagnosisDetail) : null,
  attempts: wait && has(wait, "attempts") ? wait.attempts : null,
  repairedCount: has(report, "repairedCount") ? report.repairedCount : null,
  repairedAt: has(report, "repairedAt") ? asString(report.repairedAt) : null,
};

process.stdout.write(JSON.stringify(summary));
