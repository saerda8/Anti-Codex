#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node summarize-anticodex-report.mjs <report.json>");
  process.exit(2);
}

const path = resolve(input);
const report = JSON.parse(readFileSync(path, "utf8"));
const forbiddenText = /prompt|messages|input_items|tool output|return exactly this/i;

function optionalBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function optionalString(value, maxLength = 240) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > maxLength || forbiddenText.test(text)) return undefined;
  return text;
}

function safeStringArray(value, maxItems = 40) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => optionalString(item, 160))
    .filter(Boolean)
    .slice(0, maxItems);
}

function checkPassed(value) {
  if (value === true) return true;
  return Boolean(value && typeof value === "object" && value.ok === true);
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, compact(item)])
      .filter(([, item]) => item !== undefined));
  }
  return value === undefined ? undefined : value;
}

const checks = report && typeof report.checks === "object" && !Array.isArray(report.checks)
  ? Object.values(report.checks)
  : [];
const failures = Array.isArray(report.failures) ? report.failures : [];
const failedIds = safeStringArray(report.failedIds || report.failed || report.failureIds);
const inferredFailureCount = failures.length > 0 ? failures.length : (failedIds?.length || 0);

const summary = compact({
  file: basename(path),
  reportName: optionalString(report.reportName || report.schema || basename(path, ".json")),
  schema: optionalString(report.schema),
  generatedAt: optionalString(report.generatedAt || report.completedAt || report.createdAt),
  ok: optionalBoolean(report.ok),
  effectiveOk: optionalBoolean(report.effectiveOk ?? report.ok),
  noTraffic: optionalBoolean(report.noTraffic),
  requestedRealTraffic: optionalBoolean(report.requestedRealTraffic),
  usedRealTraffic: optionalBoolean(report.usedRealTraffic),
  behaviorCovered: optionalBoolean(report.behaviorCovered),
  coverageKind: optionalString(report.coverageKind),
  architecture: optionalString(report.architecture, 320),
  state: optionalString(report.state || report.status),
  currentGate: optionalString(report.currentGate),
  releaseReady: optionalBoolean(report.releaseReady),
  shortReady: optionalBoolean(report.shortReady),
  shellProgress: optionalNumber(report.shellProgress),
  codexPlusPlusProgress: optionalNumber(report.codexPlusPlusProgress),
  antigravityAdapterProgress: optionalNumber(report.antigravityAdapterProgress),
  overallProgress: optionalNumber(report.overallProgress),
  elapsedMs: optionalNumber(report.elapsedMs),
  total: optionalNumber(report.total ?? report.totalChecks ?? report.checkCount),
  passed: optionalNumber(report.passed ?? report.passedChecks ?? report.passCount),
  failureCount: optionalNumber(report.failureCount ?? inferredFailureCount),
  checkCount: checks.length || undefined,
  checkPassedCount: checks.length ? checks.filter(checkPassed).length : undefined,
  completedGates: safeStringArray(report.completedGates),
  missingRequired: safeStringArray(report.missingRequired),
  missingShort: safeStringArray(report.missingShort),
  missingOptional: safeStringArray(report.missingOptional),
  failedIds,
  damagedReportCount: Array.isArray(report.damagedReports) ? report.damagedReports.length : undefined,
  artifactCount: Array.isArray(report.artifacts) ? report.artifacts.length : undefined,
  provider: optionalString(report.provider),
  model: optionalString(report.model),
});

process.stdout.write(`${JSON.stringify(summary)}\n`);
