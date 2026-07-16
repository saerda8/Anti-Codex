#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = new Map();
const names = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--report") {
    const next = process.argv[i + 1];
    if (next) {
      names.push(next);
      i += 1;
    }
    continue;
  }
  if (!arg.startsWith("--")) {
    names.push(arg);
    continue;
  }
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(arg, next);
    i += 1;
  } else {
    args.set(arg, true);
  }
}

const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || ".", "anticodex", "reports"));
const write = args.has("--write");
const force = args.has("--force");
const requireOk = !args.has("--allow-not-ok");
const strict = args.has("--strict");
const defaultReports = [
  "latest-legacy-zero-hit.json",
  "latest-source-preflight.json",
  "latest-sync-readiness.json",
  "latest-installed-overall.json",
  "latest-installed-overall-fast.json",
  "latest-release-gates.json",
  "latest-manager-real-buttons.json",
  "latest-gate5-visible-integration.json",
  "latest-gate6-edge-matrix.json",
  "latest-gate8-final-long-task.json",
  "latest-conversation-hygiene.json",
  "latest-model-availability.json",
  "latest-log-db-guard.json",
  "latest-cold-relaunch.json",
  "latest-stability-soak.json",
];
const reportNames = names.length > 0 ? names : defaultReports;

function fileHash(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function safeParseReport(filePath) {
  try {
    return { ok: true, report: JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || "JSON parse failed") };
  }
}

const results = [];
for (const name of reportNames) {
  const file = resolve(reportRoot, name);
  const relativeName = file.startsWith(reportRoot) ? name : file;
  if (!existsSync(file)) {
    results.push({ file: relativeName, signed: false, skipped: true, reason: "missing_report" });
    continue;
  }

  const parsed = safeParseReport(file);
  if (!parsed.ok) {
    results.push({ file: relativeName, signed: false, skipped: true, reason: "parse_failed", error: parsed.error });
    continue;
  }
  if (requireOk && parsed.report.ok !== true) {
    results.push({ file: relativeName, signed: false, skipped: true, reason: "ok_not_true" });
    continue;
  }

  const hash = fileHash(file);
  const sidecar = `${file}.sha256`;
  let existingHash = "";
  if (existsSync(sidecar)) {
    const raw = readFileSync(sidecar, "ascii").trim();
    const match = raw.match(/^(?:sha256:)?([a-fA-F0-9]{64})$/);
    if (!match) {
      results.push({ file: relativeName, signed: false, skipped: true, reason: "invalid_hash_sidecar" });
      continue;
    }
    existingHash = match[1].toLowerCase();
    if (existingHash !== hash && !force) {
      results.push({ file: relativeName, signed: false, skipped: true, reason: "hash_mismatch", hash, existingHash });
      continue;
    }
  }
  if (write) writeFileSync(sidecar, `sha256:${hash}`, "ascii");
  results.push({
    file: relativeName,
    signed: write && (force || existingHash !== hash),
    skipped: false,
    hash,
    existingHash,
    sidecar: `${relativeName}.sha256`,
    reportName: typeof parsed.report.reportName === "string" ? parsed.report.reportName : "",
  });
}

const failed = results.filter((item) => item.skipped && item.reason !== "missing_report");
const payload = {
  ok: failed.length === 0 && (!strict || results.every((item) => item.skipped === false)),
  dryRun: !write,
  reportRoot,
  requireOk,
  force,
  strict,
  total: results.length,
  signed: results.filter((item) => item.signed).length,
  signable: results.filter((item) => item.skipped === false).length,
  skipped: results.filter((item) => item.skipped).length,
  failed: failed.length,
  results,
};

process.stdout.write(JSON.stringify(payload));
if (!payload.ok) process.exit(1);
