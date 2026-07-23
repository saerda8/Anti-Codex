#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_BINDING_FIELDS = Object.freeze([
  "schema",
  "officialShellVersion",
  "activeShellVersion",
  "codexPlusPlusVersion",
  "codexPlusPlusPatchCommit",
  "codexPlusPlusBinarySha256",
  "codexPlusPlusPatchTreeSha256",
  "codexPlusPlusPatchCount",
  "syncReadinessSha256",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function signedIntegrity(path) {
  if (!existsSync(path) || !existsSync(`${path}.sha256`)) {
    return { valid: false, hash: "" };
  }
  const bytes = readFileSync(path);
  const actual = sha256(bytes);
  const match = readFileSync(`${path}.sha256`, "ascii").trim().match(/^(?:sha256:)?([a-f0-9]{64})$/i);
  return { valid: Boolean(match) && match[1].toLowerCase() === actual, hash: actual };
}

export function createCurrentReleaseBinding({ sourceRoot, reportRoot }) {
  const resolvedSourceRoot = resolve(sourceRoot);
  const resolvedReportRoot = resolve(reportRoot);
  const metadata = readJson(join(resolvedSourceRoot, "third_party", "codexplusplus", "upstream.json"));
  const patchCommit = String(metadata?.patchCommit || "");
  const version = String(metadata?.version || "");
  const binarySha256 = String(metadata?.verification?.launcherReleaseBuild || "")
    .replace(/^sha256:/i, "")
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(patchCommit)) {
    throw new Error("Pinned CodexPlusPlus patch commit is missing or invalid.");
  }
  if (!version || !/^[0-9a-f]{64}$/.test(binarySha256)) {
    throw new Error("Pinned CodexPlusPlus version or release binary hash is missing or invalid.");
  }

  const patches = (Array.isArray(metadata?.patches) ? metadata.patches : []).map((patch) => {
    const relativePath = String(patch?.file || "");
    const path = resolve(resolvedSourceRoot, "third_party", "codexplusplus", relativePath);
    const expectedSha256 = String(patch?.sha256 || "").toLowerCase();
    const actualSha256 = existsSync(path) ? sha256(readFileSync(path)) : "";
    return {
      relativePath,
      actualSha256,
      valid: /^[0-9a-f]{64}$/.test(expectedSha256) && actualSha256 === expectedSha256,
    };
  });
  const patchTreeValid = patches.length > 0
    && patches.length === Number(metadata?.patches?.length || 0)
    && patches.every((patch) => patch.valid);
  const patchTreeSha256 = sha256(patches.map((patch) => `${patch.relativePath}:${patch.actualSha256}`).join("\n"));

  const syncPath = join(resolvedReportRoot, "latest-sync-readiness.json");
  const syncIntegrity = signedIntegrity(syncPath);
  let syncReport = null;
  if (syncIntegrity.valid) {
    try {
      syncReport = readJson(syncPath);
    } catch {
      syncReport = null;
    }
  }
  const contract = syncReport?.clientSyncContract || {};
  const components = syncReport?.sync?.updateStatus?.components || {};
  const officialShellVersion = String(contract.sourcePackageVersion || "");
  const activeShellVersion = String(contract.activeSourcePackageVersion || "");
  const valid = syncReport?.ok === true
    && syncReport?.noTraffic === true
    && syncReport?.usedRealTraffic === false
    && officialShellVersion !== ""
    && activeShellVersion === officialShellVersion
    && String(contract.activeSourcePackageVersionFromMarker || "") === officialShellVersion
    && String(components.sourceVersion || "") === version
    && String(components.activeVersion || "") === version
    && String(components.sourceHash || "").toLowerCase() === binarySha256
    && String(components.activeHash || "").toLowerCase() === binarySha256
    && String(components.manifestHash || "").toLowerCase() === binarySha256
    && Number(components.expectedPatchCount) === patches.length
    && Number(components.patchCount) === patches.length
    && patchTreeValid;

  return {
    schema: "anticodex-release-binding-v1",
    valid,
    officialShellVersion,
    activeShellVersion,
    codexPlusPlusVersion: version,
    codexPlusPlusPatchCommit: patchCommit,
    codexPlusPlusBinarySha256: binarySha256,
    codexPlusPlusPatchTreeSha256: patchTreeSha256,
    codexPlusPlusPatchCount: patches.length,
    syncReadinessSha256: syncIntegrity.valid ? syncIntegrity.hash : "",
  };
}

export function releaseBindingsEqual(candidate, expected) {
  return candidate?.valid === true
    && expected?.valid === true
    && RELEASE_BINDING_FIELDS.every(
      (field) => String(candidate?.[field] ?? "") === String(expected?.[field] ?? ""),
    );
}

export function releaseEvidenceTimestampMs(report) {
  for (const value of [
    report?.generatedAtUtc,
    report?.generatedAt,
    report?.checkedAt,
    report?.endedAt,
    report?.finishedAt,
    report?.finishedAtUtc,
    report?.completedAt,
    report?.startedAt,
  ]) {
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

export function isFreshReleaseEvidence(report, { now = Date.now(), maxAgeHours = 48 } = {}) {
  const timestamp = releaseEvidenceTimestampMs(report);
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = Number(now) - timestamp;
  return ageMs >= -5 * 60 * 1000 && ageMs <= Number(maxAgeHours) * 60 * 60 * 1000;
}

function parseArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) continue;
    const value = values[index + 1];
    if (value && !value.startsWith("--")) {
      result.set(key, value);
      index += 1;
    } else {
      result.set(key, true);
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = args.get("--source-root") || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const reportRoot = args.get("--report-root")
    || resolve(process.env.APPDATA || ".", "anticodex", "reports");
  process.stdout.write(`${JSON.stringify(createCurrentReleaseBinding({ sourceRoot, reportRoot }))}\n`);
}
