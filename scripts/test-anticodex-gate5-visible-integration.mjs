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
import { basename, dirname, resolve } from "node:path";

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
      parsed.set(key, true);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/test-anticodex-gate5-visible-integration.mjs [options]

Offline aggregation only. This command never launches UI, processes, or model traffic.

Required signed current evidence:
  --task-manifest <path>              New native autonomous task manifest
  --manager-evidence <path>           Manager actual-mouse matrix
  --model-switch-evidence <path>      Three-provider physical hot-switch matrix
  --shortcut-restore-evidence <path>  Ten-or-more shortcut restore rounds
  --release-binding-evidence <path>   Current release binding report

Output:
  --report-root <path>        Report directory
  --audit-out <path>          Tracked Gate 5 audit destination
  --max-source-age-hours <n>  Maximum evidence age (default: 48)
  --compact                   Compact JSON output
  --help, -h                  Show help without writing files`);
  process.exit(0);
}

const sourceRoot = resolve(import.meta.dirname, "..");
const compact = args.has("--compact");
const reportRoot = resolve(args.get("--report-root") || `${process.env.APPDATA || os.tmpdir()}/anticodex/reports`);
const auditPath = resolve(args.get("--audit-out") || resolve(sourceRoot, "docs", "audits", "2026-07-15-gate5-visible-integration.json"));
const maxSourceAgeHours = positiveNumber(args.get("--max-source-age-hours"), 48);
const runtimeManifestClockToleranceMs = 1;
const requiredShortcutRestoreRounds = 10;
const requiredInputs = {
  taskManifest: "--task-manifest",
  managerEvidence: "--manager-evidence",
  modelSwitchEvidence: "--model-switch-evidence",
  shortcutRestoreEvidence: "--shortcut-restore-evidence",
  releaseBindingEvidence: "--release-binding-evidence",
};
const managerActions = Object.freeze([
  "refreshStatus", "refreshModels", "accountSwitch", "accountProxy",
  "syncReadiness", "repairShortcuts", "updateCheck", "sourcePreflight",
  "mcpSkills", "pluginCapabilities", "diagnosticsBundle", "viewLatestReports",
  "syncHost", "upstreamConfig", "refreshFeatures", "stabilitySoak",
  "coldRelaunch", "fastOverallNoTraffic", "overallNoTraffic", "postVerificationFull",
]);
const safeRealManagerActions = Object.freeze([
  "updateCheck", "repairShortcuts", "mcpSkills", "pluginCapabilities",
  "viewLatestReports", "diagnosticsBundle",
]);
const highImpactManagerActions = Object.freeze([
  "syncHost", "refreshFeatures", "stabilitySoak", "coldRelaunch",
  "fastOverallNoTraffic", "overallNoTraffic", "postVerificationFull",
]);
const managerHandlerContractByAction = Object.freeze({
  refreshStatus: ["virtual", "scripts/anticodex-manager-service.mjs", "virtual"],
  refreshModels: ["virtual", "scripts/anticodex-manager-service.mjs", "virtual"],
  accountSwitch: ["script", "scripts/anticodex-manager-service.mjs", "open-antigravity-account-switch.ps1"],
  accountProxy: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-account-proxy-readiness.ps1"],
  syncReadiness: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-sync-readiness.ps1"],
  repairShortcuts: ["script", "scripts/anticodex-manager-service.mjs", "repair-anticodex-shortcuts.ps1"],
  updateCheck: ["script", "scripts/anticodex-manager-service.mjs", "check-anticodex-update.ps1"],
  sourcePreflight: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-source-preflight.ps1"],
  mcpSkills: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-mcp-skills.ps1"],
  pluginCapabilities: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-plugin-capabilities.ps1"],
  diagnosticsBundle: ["script", "scripts/anticodex-manager-service.mjs", "collect-anticodex-diagnostics.ps1"],
  viewLatestReports: ["virtual", "scripts/anticodex-manager-service.mjs", "virtual"],
  syncHost: ["script", "scripts/anticodex-manager-service.mjs", "sync-anticodex-launcher.ps1"],
  upstreamConfig: ["ui-function", "scripts/anticodex-manager-inject.js", "ui-function"],
  refreshFeatures: ["script", "scripts/anticodex-manager-service.mjs", "refresh-anticodex-local-features.ps1"],
  stabilitySoak: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-stability-soak.ps1"],
  coldRelaunch: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-cold-relaunch.ps1"],
  fastOverallNoTraffic: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-installed-overall.ps1"],
  overallNoTraffic: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-installed-overall.ps1"],
  postVerificationFull: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-post-verification.ps1"],
});
const missingArguments = Object.values(requiredInputs).filter((flag) => !String(args.get(flag) || "").trim());
if (missingArguments.length > 0) {
  console.error(JSON.stringify({ ok: false, error: "missing_required_arguments", missingArguments }));
  process.exit(2);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function exactStringList(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function samePath(left, right) {
  try { return resolve(String(left || "")).toLowerCase() === resolve(String(right || "")).toLowerCase(); } catch { return false; }
}

function shortcutRestorePhysicalTraceSha256(round) {
  const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const bool = (value) => typeof value === "boolean" ? value : null;
  const activationSentAtMs = finite(round?.activationSentAtMs);
  const expectedMainPid = finite(round?.expectedMainPid);
  const windowHandleBefore = finite(round?.windowHandleBefore);
  const earlyFrames = Array.isArray(round?.earlyFrameTimeline) ? round.earlyFrameTimeline.map((entry) => [
    finite(entry?.relativeToForegroundMs), finite(entry?.mean), finite(entry?.standardDeviation), finite(entry?.darkRatio), bool(entry?.isBlank),
  ]) : null;
  const windowTransitions = Array.isArray(round?.windowStateTransitions) ? round.windowStateTransitions.map((entry) => {
    const elapsedMs = finite(entry?.elapsedMs);
    const foregroundWindowHandle = finite(entry?.foregroundWindowHandle);
    const foregroundProcessId = finite(entry?.foregroundProcessId);
    return [
      elapsedMs === null || activationSentAtMs === null ? null : elapsedMs - activationSentAtMs,
      bool(entry?.visible), bool(entry?.minimized), bool(entry?.exactForeground),
      foregroundWindowHandle === null || windowHandleBefore === null ? null : foregroundWindowHandle === windowHandleBefore,
      foregroundProcessId === null || expectedMainPid === null ? null : foregroundProcessId === expectedMainPid,
    ];
  }) : null;
  const watcherSampling = [
    finite(round?.topologyWatcherSampleCount), finite(round?.topologyWatcherMaxIntervalMs), finite(round?.topologyWatcherTailGapMs),
    finite(round?.appPageSampleCount), finite(round?.appPageWatcherMinCount), finite(round?.appPageWatcherMaxCount),
    finite(round?.appPageWatcherMaxIntervalMs), finite(round?.appPageWatcherTailGapMs),
  ];
  if (activationSentAtMs === null || activationSentAtMs < 0
    || expectedMainPid === null || expectedMainPid <= 0
    || windowHandleBefore === null || windowHandleBefore <= 0
    || earlyFrames === null || earlyFrames.length < 1
    || Number(round?.earlyFrameCount) !== earlyFrames.length
    || earlyFrames.some((entry) => entry.some((value) => value === null) || entry[0] < 0)
    || windowTransitions === null || windowTransitions.length < 1
    || windowTransitions.some((entry) => entry.some((value) => value === null) || entry[0] < 0)
    || watcherSampling.some((value) => value === null)
    || !Number.isInteger(watcherSampling[0]) || watcherSampling[0] < 2
    || watcherSampling[1] < 0 || watcherSampling[2] < 0
    || !Number.isInteger(watcherSampling[3]) || watcherSampling[3] < 2
    || watcherSampling[4] !== 1 || watcherSampling[5] !== 1
    || watcherSampling[6] < 0 || watcherSampling[7] < 0) return "";
  return sha256(JSON.stringify({ earlyFrames, windowTransitions, watcherSampling }));
}

function independentShortcutRestoreRounds(rounds) {
  const identities = rounds.map((round) => {
    const probeId = String(round?.probeId || "").toLowerCase();
    const checkedAt = String(round?.checkedAt || "");
    const topologyStartedAt = String(round?.topologyWatcherFirstSampleAtUtc || "");
    const appPageStartedAt = String(round?.appPageWatcherFirstSampleAtUtc || "");
    const sourcePath = String(round?.sourcePath || "");
    const sourceSha256 = String(round?.sourceSha256 || "").toLowerCase();
    const historyPath = String(round?.report?.history || "");
    const physicalTraceSha256 = shortcutRestorePhysicalTraceSha256(round);
    const checkedAtMs = Date.parse(checkedAt);
    const topologyStartedAtMs = Date.parse(topologyStartedAt);
    const appPageStartedAtMs = Date.parse(appPageStartedAt);
    if (!/^[a-f0-9]{32}$/.test(probeId)
      || !Number.isFinite(checkedAtMs) || String(round?.generatedAt || "") !== checkedAt
      || !Number.isFinite(topologyStartedAtMs) || topologyStartedAtMs > checkedAtMs
      || !Number.isFinite(appPageStartedAtMs) || appPageStartedAtMs > checkedAtMs
      || !sourcePath || !historyPath || !samePath(sourcePath, historyPath)
      || basename(historyPath).toLowerCase().endsWith(`-shortcut-restore-${probeId}.json`) !== true
      || !/^[a-f0-9]{64}$/.test(sourceSha256)
      || !/^[a-f0-9]{64}$/.test(physicalTraceSha256)
      || String(round?.physicalTraceSha256 || "").toLowerCase() !== physicalTraceSha256) return null;
    return { probeId, checkedAt, topologyStartedAt, appPageStartedAt, sourcePath: resolve(sourcePath).toLowerCase(), sourceSha256, physicalTraceSha256 };
  });
  return identities.every(Boolean) && ["probeId", "checkedAt", "topologyStartedAt", "appPageStartedAt", "sourcePath", "sourceSha256", "physicalTraceSha256"]
    .every((key) => new Set(identities.map((identity) => identity[key])).size === rounds.length);
}

function normalizedContractPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return normalized && !normalized.startsWith("/") && !normalized.split("/").includes("..") ? normalized : "";
}

function processStartedForManifest(processCreatedAt, manifestCreatedAt) {
  const processCreatedAtMs = Date.parse(String(processCreatedAt || ""));
  const manifestCreatedAtMs = Date.parse(String(manifestCreatedAt || ""));
  return Number.isFinite(processCreatedAtMs) && Number.isFinite(manifestCreatedAtMs)
    && processCreatedAtMs + runtimeManifestClockToleranceMs >= manifestCreatedAtMs;
}

function currentSourceGitState() {
  const run = (gitArgs) => spawnSync("git", ["-C", sourceRoot, ...gitArgs], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  const headResult = run(["rev-parse", "HEAD"]);
  const head = String(headResult.stdout || "").trim().toLowerCase();
  if (headResult.error || headResult.status !== 0 || !/^[0-9a-f]{40}$/.test(head)) {
    return { ok: false, head, clean: false };
  }
  const statusResult = run(["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (statusResult.error || statusResult.status !== 0) return { ok: false, head, clean: false };
  return { ok: true, head, clean: String(statusResult.stdout || "").trim() === "" };
}

function queryExactWindowsProcess(processId) {
  if (!Number.isInteger(processId) || processId <= 0 || process.platform !== "win32") return null;
  const powershellPath = resolve(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AntiCodexGate5CommandLine {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CommandLineToArgvW(string value, out int count);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr LocalFree(IntPtr value);
  public static string[] Parse(string value) {
    int count; IntPtr vector = CommandLineToArgvW(value, out count);
    if (vector == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { var result = new string[count]; for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(vector, i * IntPtr.Size)) ?? String.Empty; return result; }
    finally { LocalFree(vector); }
  }
}
'@
$rows = @(Get-CimInstance Win32_Process -Filter "ProcessId = ${processId}" -ErrorAction Stop)
if ($rows.Count -ne 1) { throw "exact process not found" }
$row = $rows[0]
[pscustomobject]@{
  processId = [int]$row.ProcessId
  executablePath = [string]$row.ExecutablePath
  creationDateUtc = ([DateTime]$row.CreationDate).ToUniversalTime().ToString("o", [Globalization.CultureInfo]::InvariantCulture)
  arguments = @([AntiCodexGate5CommandLine]::Parse([string]$row.CommandLine))
} | ConvertTo-Json -Depth 4 -Compress
`;
  const result = spawnSync(powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  if (result.error || result.status !== 0) return null;
  try { return JSON.parse(String(result.stdout || "").trim()); } catch { return null; }
}

function validateManagerHandlerProvenance(handlerVerification, runtimeIdentity) {
  const contracts = handlerVerification?.contracts || {};
  const contractEntries = Object.entries(contracts);
  const provenance = handlerVerification?.provenance || {};
  const runtimeRoot = resolve(String(provenance?.runtimeRoot || ""));
  const manifestPath = resolve(String(provenance?.manifestPath || ""));
  const taskRuntimePid = Number(provenance?.taskRuntimePid || 0);
  const taskRuntimeCreationDateUtc = String(provenance?.taskRuntimeCreationDateUtc || "");
  const files = Array.isArray(provenance?.files) ? provenance.files : [];
  const sourceGit = currentSourceGitState();
  const liveTaskRuntime = queryExactWindowsProcess(taskRuntimePid);
  const expectedTaskRuntimeScript = resolve(runtimeRoot, "scripts", "start-anticodex-fixed-route.mjs");
  if (contractEntries.length !== managerActions.length
    || !contractEntries.every(([action, entry], index) => {
      const expected = managerHandlerContractByAction[action];
      return action === managerActions[index] && entry?.verified === true
        && String(entry?.kind || "") === expected?.[0]
        && String(entry?.source || "") === expected?.[1]
        && String(entry?.handler || "") === expected?.[2];
    })
    || provenance?.schema !== "anticodex-manager-handler-provenance-v1"
    || provenance?.verified !== true
    || !samePath(provenance?.scriptsRoot, resolve(runtimeRoot, "scripts"))
    || !samePath(manifestPath, resolve(runtimeRoot, ".anticodex-runtime-manifest.json"))
    || !samePath(provenance?.sourceRoot, sourceRoot)
    || sourceGit.ok !== true || sourceGit.clean !== true
    || provenance?.sourceGitClean !== sourceGit.clean
    || taskRuntimePid <= 0
    || taskRuntimePid !== Number(runtimeIdentity?.supervisorPid || 0)
    || !samePath(provenance?.taskRuntimeScriptPath, expectedTaskRuntimeScript)
    || !liveTaskRuntime || Number(liveTaskRuntime.processId) !== taskRuntimePid
    || String(liveTaskRuntime.executablePath || "").replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() !== "node.exe"
    || !Array.isArray(liveTaskRuntime.arguments) || liveTaskRuntime.arguments.length < 2
    || !samePath(liveTaskRuntime.arguments[1], expectedTaskRuntimeScript)
    || !taskRuntimeCreationDateUtc || String(liveTaskRuntime.creationDateUtc || "") !== taskRuntimeCreationDateUtc
    || provenance?.sourceRevisionProvenance !== "git"
    || String(provenance?.sourceGitHead || "").toLowerCase() !== sourceGit.head
    || !existsSync(manifestPath) || !statSync(manifestPath).isFile()
    || !/^[a-f0-9]{64}$/i.test(String(provenance?.manifestSha256 || ""))
    || sha256(readFileSync(manifestPath)) !== String(provenance.manifestSha256).toLowerCase()) return false;
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")); } catch { return false; }
  if (manifest?.schema !== "anticodex-runtime-manifest-v2" || manifest?.state !== "validated"
    || !samePath(manifest?.activeRuntime, runtimeRoot) || !samePath(manifest?.sourceRoot, sourceRoot)
    || manifest?.sourceGitClean !== sourceGit.clean || manifest?.sourceRevisionProvenance !== "git"
    || String(manifest?.sourceGitHead || "").toLowerCase() !== sourceGit.head
    || !processStartedForManifest(taskRuntimeCreationDateUtc, manifest?.createdAt)) return false;
  const expectedFiles = [...new Set(["scripts/start-anticodex-fixed-route.mjs", ...contractEntries.flatMap(([, entry]) => [
    normalizedContractPath(entry?.source),
    String(entry?.handler || "").toLowerCase().endsWith(".ps1") ? normalizedContractPath(`scripts/${entry.handler}`) : "",
  ])].filter(Boolean))];
  const fileByPath = new Map(files.map((entry) => [normalizedContractPath(entry?.relativePath), entry]));
  if (files.length !== expectedFiles.length || fileByPath.size !== files.length) return false;
  return expectedFiles.every((relativePath) => {
    const entry = fileByPath.get(relativePath);
    const expectedHash = String(entry?.fileSha256 || "").toLowerCase();
    const manifestEntry = Object.entries(manifest?.files || {}).find(([path]) => normalizedContractPath(path) === relativePath);
    const runtimePath = resolve(runtimeRoot, relativePath);
    const sourcePath = resolve(sourceRoot, relativePath);
    return /^[a-f0-9]{64}$/.test(expectedHash)
      && String(entry?.manifestSha256 || "").toLowerCase() === expectedHash
      && String(manifestEntry?.[1] || "").toLowerCase() === expectedHash
      && existsSync(runtimePath) && statSync(runtimePath).isFile() && sha256(readFileSync(runtimePath)) === expectedHash
      && existsSync(sourcePath) && statSync(sourcePath).isFile() && sha256(readFileSync(sourcePath)) === expectedHash;
  });
}

function embeddedTimestampMs(data) {
  for (const value of [data?.checkedAt, data?.generatedAt, data?.completedAt, data?.createdAt]) {
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function readSignedCurrent(pathValue) {
  const path = resolve(String(pathValue || ""));
  const sidecarPath = `${path}.sha256`;
  if (!existsSync(path)) throw new Error(`missing evidence: ${path}`);
  if (!existsSync(sidecarPath)) throw new Error(`missing evidence sidecar: ${sidecarPath}`);
  const bytes = readFileSync(path);
  const actualHash = sha256(bytes);
  const sidecar = readFileSync(sidecarPath, "ascii").trim();
  const match = sidecar.match(/^(?:sha256:)?([a-f0-9]{64})$/i);
  if (!match || match[1].toLowerCase() !== actualHash) throw new Error(`invalid evidence signature: ${path}`);
  const data = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  const timestampMs = embeddedTimestampMs(data);
  if (!Number.isFinite(timestampMs)) throw new Error(`evidence has no embedded timestamp: ${path}`);
  const ageHours = (Date.now() - timestampMs) / 3_600_000;
  if (ageHours < -(5 / 60) || ageHours > maxSourceAgeHours) throw new Error(`evidence is stale or future-dated: ${path}`);
  return {
    path,
    sidecarPath,
    data,
    sha256: actualHash,
    checkedAt: new Date(timestampMs).toISOString(),
    ageHours: Math.max(0, ageHours),
  };
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

function releaseBindingFrom(data) {
  return data?.releaseBinding || data;
}

const releaseBindingFields = [
  "schema",
  "officialShellVersion",
  "activeShellVersion",
  "codexPlusPlusVersion",
  "codexPlusPlusPatchCommit",
  "codexPlusPlusBinarySha256",
  "codexPlusPlusPatchTreeSha256",
  "codexPlusPlusPatchCount",
  "syncReadinessSha256",
];

function sameReleaseBinding(candidate, expected) {
  return candidate?.valid === true
    && expected?.valid === true
    && releaseBindingFields.every((field) => String(candidate?.[field] ?? "") === String(expected?.[field] ?? ""));
}

function validReleaseBinding(binding) {
  return binding?.schema === "anticodex-release-binding-v1"
    && binding?.valid === true
    && String(binding?.officialShellVersion || "") !== ""
    && binding.officialShellVersion === binding.activeShellVersion
    && String(binding?.codexPlusPlusVersion || "") !== ""
    && /^[a-f0-9]{40}$/i.test(String(binding?.codexPlusPlusPatchCommit || ""))
    && /^[a-f0-9]{64}$/i.test(String(binding?.codexPlusPlusBinarySha256 || ""))
    && /^[a-f0-9]{64}$/i.test(String(binding?.codexPlusPlusPatchTreeSha256 || ""))
    && Number(binding?.codexPlusPlusPatchCount) > 0
    && /^[a-f0-9]{64}$/i.test(String(binding?.syncReadinessSha256 || ""));
}

function normalizeProtocol(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[_\s-]/g, "");
  if (["chatcompletions", "openaicompatible"].includes(normalized)) return "chatCompletions";
  if (normalized === "responses") return "responses";
  return String(value || "");
}

function verifyArtifacts(artifacts) {
  return (Array.isArray(artifacts) ? artifacts : []).map((artifact) => {
    const path = resolve(String(artifact?.path || ""));
    const expectedHash = String(artifact?.sha256 || artifact?.expectedHash || "").toLowerCase();
    const expectedBytes = Number(artifact?.bytes || 0);
    const exists = Boolean(path) && existsSync(path) && statSync(path).isFile();
    const actualBytes = exists ? statSync(path).size : 0;
    const actualHash = exists ? sha256(readFileSync(path)) : "";
    return {
      name: String(artifact?.name || basename(path)),
      path,
      exists,
      bytes: expectedBytes,
      actualBytes,
      expectedHash,
      actualHash,
      ok: exists && expectedBytes > 0 && actualBytes === expectedBytes && /^[a-f0-9]{64}$/.test(expectedHash) && actualHash === expectedHash,
    };
  });
}

function verifyNativeRollout(data) {
  const rollout = data?.rollout || {};
  const path = resolve(String(rollout?.path || ""));
  const expectedHash = String(rollout?.sha256 || "").toLowerCase();
  const expectedBytes = Number(rollout?.bytes || 0);
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    return { ok: false, path, expectedHash, expectedBytes, actualHash: "", actualBytes: 0 };
  }
  const bytes = readFileSync(path);
  const actualHash = sha256(bytes);
  return {
    ok: /^[a-f0-9]{64}$/.test(expectedHash)
      && expectedBytes > 0
      && bytes.length === expectedBytes
      && actualHash === expectedHash,
    path,
    expectedHash,
    expectedBytes,
    actualHash,
    actualBytes: bytes.length,
  };
}

function validateTaskManifest(data, releaseBinding, artifactEvidence, rolloutEvidence) {
  const continuationCount = Number(data?.continuationPromptCount);
  const hostMessageCount = Number(data?.hostMessageCount);
  const continuations = Array.isArray(data?.continuations) ? data.continuations : [];
  const continuationTurnIds = continuations.map((entry) => String(entry?.turnId || ""));
  const exactContinuationSha256 = sha256("继续");
  return data?.schema === "anticodex-native-autonomous-task-manifest-v1"
    && data?.reportName === "native-autonomous-task-manifest"
    && data?.ok === true
    && data?.newTask === true
    && data?.nativeTask === true
    && data?.sameTask === true
    && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(data?.taskId || ""))
    && Number(data?.promptSubmissionCount) === 1
    && Number(data?.totalGoalPromptCount) === 1
    && Number.isInteger(continuationCount)
    && continuationCount >= 0
    && hostMessageCount === 1 + continuationCount
    && Number(data?.hostIntermediatePromptCount) === 0
    && continuations.length === continuationCount
    && new Set(continuationTurnIds).size === continuations.length
    && continuations.every((entry, index) => String(entry?.turnId || "")
      && Number(entry?.sequence) === index + 1
      && String(entry?.previousTurnId || "") === (
        index === 0
          ? String(data?.turnId || "")
          : String(continuations[index - 1]?.turnId || "")
      )
      && Number.isFinite(Date.parse(String(entry?.at || "")))
      && Number.isFinite(Date.parse(String(entry?.interruptionAt || "")))
      && Date.parse(String(entry?.interruptionAt || "")) <= Date.parse(String(entry?.at || ""))
      && ["task_complete.error", "turn_aborted"].includes(String(entry?.interruptionKind || ""))
      && /^[a-f0-9]{64}$/.test(String(entry?.interruptionErrorSha256 || ""))
      && entry?.messageSha256 === exactContinuationSha256)
    && Number(data?.rollout?.messageCount) === hostMessageCount
    && Number(data?.rollout?.userTurnCount) === hostMessageCount
    && rolloutEvidence?.ok === true
    && data?.requestedRealTraffic === true
    && data?.usedRealTraffic === true
    && data?.route?.provider === "antigravity"
    && normalizeProtocol(data?.route?.relayProtocol) === "chatCompletions"
    && data?.route?.codexPlusPlusVersion === releaseBinding?.codexPlusPlusVersion
    && artifactEvidence.length >= 3
    && artifactEvidence.every((artifact) => artifact.ok);
}

const antiCodexTrayGuid = "a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3";

function validateLiveTrayEvidence(data, runtimeIdentity) {
  const item = data?.notificationAreaItem || {};
  const identity = data?.identity || {};
  const rectangle = item?.rectangle || {};
  const checkedAtMs = Date.parse(String(data?.checkedAt || ""));
  const ageMinutes = (Date.now() - checkedAtMs) / 60_000;
  return data?.schema === "anticodex-live-tray-icon-v2"
    && data?.ok === true
    && data?.requestedRealTraffic === false
    && data?.usedRealTraffic === false
    && Number.isFinite(checkedAtMs)
    && ageMinutes >= -5
    && ageMinutes <= 5
    && item?.present === true
    && item?.visible === true
    && item?.clickable === true
    && item?.name === "Anti-Codex"
    && item?.provider === "MSAA+Shell_NotifyIconGetRect"
    && Number(item?.role) === 43
    && Number(item?.state) >= 0
    && Number(item?.childId) > 0
    && Number(item?.toolbarWindowHandle) > 0
    && Number(item?.rawNameCandidateCount) >= 1
    && Number(item?.verifiedAntiCandidateCount) === 1
    && Number(item?.expectedMainPid) === Number(runtimeIdentity?.antiCodexMainPid)
    && Number(item?.ownerWindowHandle) > 0
    && Number(item?.ownerProcessId) === Number(runtimeIdentity?.antiCodexMainPid)
    && item?.ownerWindowClass === "OwlElectron_NotifyIconHostWindow"
    && Number(item?.notifyIconId) > 0
    && String(item?.notifyIconGuid || "").toLowerCase() === antiCodexTrayGuid
    && item?.shellNotifyIconRectMatched === true
    && item?.isEnabled === true
    && item?.isInvisible === false
    && item?.isOffscreen === false
    && item?.hitTestMatched === true
    && Number.isFinite(rectangle?.x)
    && Number.isFinite(rectangle?.y)
    && Number(rectangle?.width) >= 16
    && Number(rectangle?.height) >= 16
    && identity?.exactAccessibleName === true
    && identity?.expectedMainPidMatched === true
    && identity?.ownerWindowClassMatched === true
    && identity?.antiGuidRectMatched === true
    && identity?.pinkArtwork === true
    && Number(identity?.minimumPinkPixels) >= 8
    && Number(identity?.pinkPixels) >= Number(identity?.minimumPinkPixels)
    && String(data?.sourcePath || "").trim() !== ""
    && /^[a-f0-9]{64}$/i.test(String(data?.sourceSha256 || ""));
}

function validateManager(data) {
  const closes = Array.isArray(data?.closeProbes) ? data.closeProbes : [];
  const closeByName = Object.fromEntries(closes.map((entry) => [String(entry?.name || ""), entry]));
  const protocol = data?.protocolInteraction || {};
  const uiInteraction = data?.uiInteraction || {};
  const handlerVerification = data?.handlerVerification || {};
  return data?.schema === "anticodex-manager-actual-mouse-matrix-v2"
    && data?.ok === true
    && data?.requestedRealTraffic === false
    && data?.usedRealTraffic === false
    && Number(data?.actionCount) >= 20
    && data?.zeroSideEffects === true
    && uiInteraction?.scope === "ui-interaction-only"
    && Number(uiInteraction?.verifiedCount) === managerActions.length
    && exactStringList(uiInteraction?.verifiedActionIds, managerActions)
    && exactStringList(handlerVerification?.offlineContractVerifiedActionIds, managerActions)
    && exactStringList(handlerVerification?.safeRealActionIds, safeRealManagerActions)
    && exactStringList(handlerVerification?.realExecutedActionIds, [])
    && exactStringList(handlerVerification?.pendingAuthorizedActionIds, highImpactManagerActions)
    && handlerVerification?.allFunctionsVerified === false
    && validateManagerHandlerProvenance(handlerVerification, data?.runtimeIdentity)
    && data?.actualMouse === true
    && data?.profileEntryText === "管理"
    && data?.forbiddenEnglishVisible === false
    && data?.trayIconPreserved === true
    && validateLiveTrayEvidence(data?.liveTrayEvidence, data?.runtimeIdentity)
    && ["upper-center", "center", "lower-center"].every((name) => {
      const entry = closeByName[name];
      return entry?.ok === true
        && entry?.actualMouse === true
        && entry?.closed === true
        && entry?.hasTextNode === false;
    })
    && normalizeProtocol(protocol?.before) === "chatCompletions"
    && normalizeProtocol(protocol?.alternate) === "responses"
    && normalizeProtocol(protocol?.restored) === "chatCompletions"
    && protocol?.selectedAlternate === true
    && protocol?.restoredOriginal === true
    && protocol?.profileUnchanged === true;
}

function validateModelSwitch(data, taskId) {
  const switches = Array.isArray(data?.switches) ? data.switches : [];
  const providers = new Set(switches.map((entry) => String(entry?.provider || "")));
  const pidKeys = ["supervisor", "codexPlusPlus", "antiCodexMain"];
  const perSwitchValid = switches.every((entry) => entry?.ok === true
    && entry?.actualMouse === true
    && entry?.taskId === taskId
    && Number(entry?.requestCountBefore) === Number(entry?.requestCountAfter)
    && Number(entry?.latestRequestRowIdBefore) === Number(entry?.latestRequestRowIdAfter)
    && entry?.originalCodexAlive === true
    && pidKeys.every((key) => Number(entry?.[`${key}PidBefore`]) > 0
      && Number(entry?.[`${key}PidBefore`]) === Number(entry?.[`${key}PidAfter`])));
  const baselinePids = switches[0] || {};
  const crossSwitchPidsStable = switches.every((entry) => pidKeys.every((key) => (
    Number(entry?.[`${key}PidBefore`]) === Number(baselinePids?.[`${key}PidBefore`])
  )));
  return data?.schema === "anticodex-frontend-model-hot-switch-v1"
    && data?.ok === true
    && data?.requestedRealTraffic === false
    && data?.usedRealTraffic === false
    && data?.sameTask === true
    && data?.taskId === taskId
    && switches.length >= 3
    && providers.has("gemini")
    && providers.has("claude")
    && providers.has("third-party")
    && perSwitchValid
    && crossSwitchPidsStable;
}

function validateShortcutRestore(data) {
  const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
  const mainPid = Number(rounds[0]?.expectedMainPid || 0);
  const originalCodexPid = Number(rounds[0]?.expectedOriginalCodexPid || 0);
  return data?.schema === "anticodex-shortcut-restore-matrix-v1"
    && data?.ok === true
    && data?.requestedRealTraffic === false
    && data?.usedRealTraffic === false
    && rounds.length >= requiredShortcutRestoreRounds
    && independentShortcutRestoreRounds(rounds)
    && mainPid > 0
    && originalCodexPid > 0
    && rounds.every((round) => round?.ok === true
      && Number(round?.expectedMainPid) === mainPid
      && Number(round?.expectedOriginalCodexPid) === originalCodexPid
      && round?.minimizedObserved === true
      && Number(round?.restoredAtMs) > 0
      && Number(round?.maxRootProcessCount) === 1
      && Number(round?.maxVisibleWindowCount) === 1
      && Number(round?.maxAppPageCount) === 1
      && Number(round?.appPagesAfter) === 1
      && Number(round?.blankFrameCount) === 0
      && Number(round?.frameCount) >= 1
      && round?.originalCodexAlive === true
      && Array.isArray(round?.after?.rootProcessIds)
      && round.after.rootProcessIds.length === 1
      && Number(round.after.rootProcessIds[0]) === mainPid
      && Array.isArray(round?.after?.visibleWindowProcessIds)
      && round.after.visibleWindowProcessIds.length === 1
      && Number(round.after.visibleWindowProcessIds[0]) === mainPid);
}

const checks = [];
function record(id, ok, evidence = {}) {
  checks.push({ id, ok: ok === true, ...evidence });
}

const sources = {};
for (const [id, flag] of Object.entries(requiredInputs)) {
  try {
    sources[id] = readSignedCurrent(args.get(flag));
    record(`${id}_signed_fresh`, true, {
      path: sources[id].path,
      sha256: sources[id].sha256,
      checkedAt: sources[id].checkedAt,
      ageHours: sources[id].ageHours,
    });
  } catch (error) {
    sources[id] = null;
    record(`${id}_signed_fresh`, false, { path: resolve(String(args.get(flag) || "")), error: String(error?.message || error) });
  }
}

const releaseBinding = releaseBindingFrom(sources.releaseBindingEvidence?.data);
const allEvidence = [sources.taskManifest, sources.managerEvidence, sources.modelSwitchEvidence, sources.shortcutRestoreEvidence]
  .map((source) => source?.data)
  .filter(Boolean);
record("release_binding_current_and_shared", validReleaseBinding(releaseBinding)
  && allEvidence.length === 4
  && allEvidence.every((data) => sameReleaseBinding(releaseBindingFrom(data), releaseBinding)));

const taskManifest = sources.taskManifest?.data || {};
const artifactEvidence = verifyArtifacts(taskManifest?.artifacts);
const rolloutEvidence = verifyNativeRollout(taskManifest);
const taskOk = validateTaskManifest(taskManifest, releaseBinding, artifactEvidence, rolloutEvidence);
record("new_native_task_one_total_goal", taskOk, {
  taskId: String(taskManifest?.taskId || ""),
  promptSubmissionCount: taskManifest?.promptSubmissionCount ?? null,
  totalGoalPromptCount: taskManifest?.totalGoalPromptCount ?? null,
  continuationPromptCount: taskManifest?.continuationPromptCount ?? null,
  hostMessageCount: taskManifest?.hostMessageCount ?? null,
  hostIntermediatePromptCount: taskManifest?.hostIntermediatePromptCount ?? null,
});
record("native_rollout_rehashed", rolloutEvidence.ok, rolloutEvidence);
record("current_task_artifacts_rehashed", artifactEvidence.length >= 3 && artifactEvidence.every((artifact) => artifact.ok), { artifacts: artifactEvidence });
record("current_antigravity_route_bound", taskManifest?.route?.provider === "antigravity"
  && normalizeProtocol(taskManifest?.route?.relayProtocol) === "chatCompletions"
  && taskManifest?.route?.codexPlusPlusVersion === releaseBinding?.codexPlusPlusVersion);

const manager = sources.managerEvidence?.data || {};
const managerOk = validateManager(manager);
const closeByName = Object.fromEntries((Array.isArray(manager?.closeProbes) ? manager.closeProbes : []).map((entry) => [entry?.name, entry]));
record("manager_actual_mouse_matrix", managerOk, {
  uiInteractionCount: manager?.uiInteraction?.verifiedCount ?? null,
  realHandlerExecutedCount: manager?.handlerVerification?.realExecutedActionIds?.length ?? null,
  pendingAuthorizedCount: manager?.handlerVerification?.pendingAuthorizedActionIds?.length ?? null,
});
record("profile_menu_uses_exact_chinese_manager_label", manager?.profileEntryText === "管理" && manager?.forbiddenEnglishVisible === false);
record("manager_close_full_height_actual_mouse", ["upper-center", "center", "lower-center"].every((name) => closeByName[name]?.actualMouse === true && closeByName[name]?.closed === true && closeByName[name]?.hasTextNode === false));
record("manager_protocol_physical_round_trip", normalizeProtocol(manager?.protocolInteraction?.before) === "chatCompletions"
  && normalizeProtocol(manager?.protocolInteraction?.alternate) === "responses"
  && normalizeProtocol(manager?.protocolInteraction?.restored) === "chatCompletions"
  && manager?.protocolInteraction?.profileUnchanged === true);
record("live_tray_icon_preserved", manager?.trayIconPreserved === true
  && validateLiveTrayEvidence(manager?.liveTrayEvidence, manager?.runtimeIdentity));

const modelSwitch = sources.modelSwitchEvidence?.data || {};
const switches = Array.isArray(modelSwitch?.switches) ? modelSwitch.switches : [];
const modelSwitchOk = validateModelSwitch(modelSwitch, taskManifest?.taskId);
record("frontend_model_hot_switch", modelSwitchOk, { switchCount: switches.length, providers: switches.map((entry) => entry?.provider) });
record("frontend_model_hot_switch_same_task", switches.length >= 3 && switches.every((entry) => entry?.taskId === taskManifest?.taskId));
record("frontend_model_hot_switch_zero_requests", switches.length >= 3 && switches.every((entry) => Number(entry?.requestCountBefore) === Number(entry?.requestCountAfter)
  && Number(entry?.latestRequestRowIdBefore) === Number(entry?.latestRequestRowIdAfter)));
record("frontend_model_hot_switch_stable_processes", switches.length >= 3 && modelSwitchOk);

const shortcutRestore = sources.shortcutRestoreEvidence?.data || {};
const restoreRounds = Array.isArray(shortcutRestore?.rounds) ? shortcutRestore.rounds : [];
const shortcutOk = validateShortcutRestore(shortcutRestore);
record("shortcut_restore_single_window_no_blank_frames", shortcutOk, { roundCount: restoreRounds.length });
record("shortcut_restore_ten_rounds", restoreRounds.length >= requiredShortcutRestoreRounds);
record("original_codex_survived_all_ui_checks", switches.length >= 3
  && switches.every((entry) => entry?.originalCodexAlive === true)
  && restoreRounds.length >= requiredShortcutRestoreRounds
  && restoreRounds.every((round) => round?.originalCodexAlive === true));
record("aggregate_performed_no_traffic", true, { requestedRealTraffic: false, usedRealTraffic: false });

const failures = checks.filter((entry) => entry.ok !== true).map((entry) => entry.id);
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
  sourceEvidenceUsedRealTraffic: taskManifest?.usedRealTraffic === true,
  coverageKind: "current-release-explicit-evidence-aggregate",
  task: {
    taskId: String(taskManifest?.taskId || ""),
    newTask: taskManifest?.newTask === true,
    nativeTask: taskManifest?.nativeTask === true,
    promptSubmissionCount: Number(taskManifest?.promptSubmissionCount || 0),
    totalGoalPromptCount: Number(taskManifest?.totalGoalPromptCount || 0),
    continuationPromptCount: Number(taskManifest?.continuationPromptCount || 0),
    hostMessageCount: Number(taskManifest?.hostMessageCount || 0),
    hostIntermediatePromptCount: Number(taskManifest?.hostIntermediatePromptCount || 0),
  },
  releaseBinding,
  sourceEvidence: Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, source ? {
    path: source.path,
    sidecarPath: source.sidecarPath,
    sha256: source.sha256,
    checkedAt: source.checkedAt,
    ageHours: source.ageHours,
  } : null])),
  artifactEvidence,
  rolloutEvidence,
  route: taskManifest?.route ? {
    state: String(taskManifest.route.state || "ready"),
    provider: taskManifest.route.provider,
    model: String(taskManifest.route.model || ""),
    relayProtocol: normalizeProtocol(taskManifest.route.relayProtocol),
    codexPlusPlusVersion: taskManifest.route.codexPlusPlusVersion,
  } : null,
  currentUiEvidence: {
    manager_actual_mouse_matrix: {
      ok: managerOk,
      usedRealTraffic: false,
      actualMouse: manager?.actualMouse === true,
      actionCount: Number(manager?.actionCount || 0),
      zeroSideEffects: manager?.zeroSideEffects === true,
      uiInteraction: manager?.uiInteraction || null,
      handlerVerification: manager?.handlerVerification || null,
      profileEntryText: String(manager?.profileEntryText || ""),
      forbiddenEnglishVisible: manager?.forbiddenEnglishVisible === false,
      trayIconPreserved: manager?.trayIconPreserved === true,
      liveTrayEvidence: manager?.liveTrayEvidence || null,
      closeUpper: closeByName["upper-center"]?.ok === true,
      closeCenter: closeByName.center?.ok === true,
      closeLower: closeByName["lower-center"]?.ok === true,
      closeHasTextNode: ["upper-center", "center", "lower-center"].every((name) => closeByName[name]?.hasTextNode === false),
      closeProbes: ["upper-center", "center", "lower-center"].map((name) => ({
        name,
        ok: closeByName[name]?.ok === true,
        actualMouse: closeByName[name]?.actualMouse === true,
        closed: closeByName[name]?.closed === true,
        hasTextNode: closeByName[name]?.hasTextNode,
      })),
      protocolInteraction: {
        before: normalizeProtocol(manager?.protocolInteraction?.before),
        alternate: normalizeProtocol(manager?.protocolInteraction?.alternate),
        restored: normalizeProtocol(manager?.protocolInteraction?.restored),
        selectedAlternate: manager?.protocolInteraction?.selectedAlternate === true,
        restoredOriginal: manager?.protocolInteraction?.restoredOriginal === true,
        profileUnchanged: manager?.protocolInteraction?.profileUnchanged === true,
      },
    },
    frontend_model_hot_switch: {
      ok: modelSwitchOk,
      usedRealTraffic: false,
      sameTask: modelSwitch?.sameTask === true,
      taskId: String(modelSwitch?.taskId || ""),
      noRestart: modelSwitchOk,
      requestCountUnchanged: switches.length >= 3 && switches.every((entry) => Number(entry?.requestCountBefore) === Number(entry?.requestCountAfter)),
      pidUnchanged: modelSwitchOk,
      switchCount: switches.length,
      providers: [...new Set(switches.map((entry) => String(entry?.provider || "")))],
      originalCodexAlive: switches.length >= 3 && switches.every((entry) => entry?.originalCodexAlive === true),
      switches,
    },
    shortcut_restore_single_window_no_blank_frames: {
      ok: shortcutOk,
      usedRealTraffic: false,
      roundCount: restoreRounds.length,
      sameMainPid: restoreRounds.length >= requiredShortcutRestoreRounds && restoreRounds.every((round) => Number(round?.expectedMainPid) === Number(restoreRounds[0]?.expectedMainPid)),
      mainPid: Number(restoreRounds[0]?.expectedMainPid || 0),
      maxRootProcessCount: Math.max(0, ...restoreRounds.map((round) => Number(round?.maxRootProcessCount || 0))),
      maxVisibleWindowCount: Math.max(0, ...restoreRounds.map((round) => Number(round?.maxVisibleWindowCount || 0))),
      maxAppPageCount: Math.max(0, ...restoreRounds.map((round) => Number(round?.maxAppPageCount || 0))),
      blankFrameCount: restoreRounds.reduce((sum, round) => sum + Number(round?.blankFrameCount || 0), 0),
      originalCodexAlive: restoreRounds.length >= requiredShortcutRestoreRounds && restoreRounds.every((round) => round?.originalCodexAlive === true),
      rounds: restoreRounds,
    },
  },
  checks,
  failures,
  report: reportPaths,
};

const body = `${JSON.stringify(payload, null, 2)}\n`;
for (const path of [latestPath, historyPath, auditPath]) writeSignedAtomic(path, body);

console.log(JSON.stringify(compact ? {
  ok: payload.ok,
  gateComplete: payload.gateComplete,
  checks: checks.length,
  passed: checks.length - failures.length,
  failures,
  taskId: payload.task.taskId,
  artifactCount: artifactEvidence.length,
  managerUiInteractionCount: payload.currentUiEvidence.manager_actual_mouse_matrix.uiInteraction?.verifiedCount ?? 0,
  modelSwitchCount: payload.currentUiEvidence.frontend_model_hot_switch.switchCount,
  shortcutRestoreRounds: payload.currentUiEvidence.shortcut_restore_single_window_no_blank_frames.roundCount,
  report: reportPaths,
} : payload));
process.exit(payload.ok ? 0 : 1);
