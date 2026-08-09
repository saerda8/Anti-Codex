#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGate8AutonomousVideoReport } from "./lib/anticodex-gate8-evidence.mjs";
import {
  RELEASE_BINDING_FIELDS,
  createCurrentReleaseBinding,
} from "./lib/anticodex-release-binding.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, true);
  }
}

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/test-anticodex-release-gates.mjs [options]

Options:
  --report-root <path>    Anti-Codex report directory
  --source-root <path>    Source workspace root
  --max-age-hours <n>     Maximum age for current Gate 1-8 evidence (default: 48)
  --strict                Exit non-zero until all eight gates pass
  --summary               Print the compact status
  --compact               Print the compact status
  --compact-status        Print the compact status
  --self-test             Run deterministic integrity/semantic tests only`);
  process.exit(0);
}

const startedAt = Date.now();
const sourceRoot = resolve(args.get("--source-root") || join(dirname(fileURLToPath(import.meta.url)), ".."));
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || ".", "anticodex", "reports"));
const maxAgeHours = Math.max(0.01, Number(args.get("--max-age-hours") || 48));
const strict = args.has("--strict");
const compactOutput = args.has("--summary") || args.has("--compact") || args.has("--compact-status") || args.has("--status");
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
  refreshStatus: ["virtual", "scripts/anticodex-manager-service.mjs", "virtual"], refreshModels: ["virtual", "scripts/anticodex-manager-service.mjs", "virtual"],
  accountSwitch: ["script", "scripts/anticodex-manager-service.mjs", "open-antigravity-account-switch.ps1"], accountProxy: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-account-proxy-readiness.ps1"],
  syncReadiness: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-sync-readiness.ps1"], repairShortcuts: ["script", "scripts/anticodex-manager-service.mjs", "repair-anticodex-shortcuts.ps1"],
  updateCheck: ["script", "scripts/anticodex-manager-service.mjs", "check-anticodex-update.ps1"], sourcePreflight: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-source-preflight.ps1"],
  mcpSkills: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-mcp-skills.ps1"], pluginCapabilities: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-plugin-capabilities.ps1"],
  diagnosticsBundle: ["script", "scripts/anticodex-manager-service.mjs", "collect-anticodex-diagnostics.ps1"], viewLatestReports: ["virtual", "scripts/anticodex-manager-service.mjs", "virtual"],
  syncHost: ["script", "scripts/anticodex-manager-service.mjs", "sync-anticodex-launcher.ps1"], upstreamConfig: ["ui-function", "scripts/anticodex-manager-inject.js", "ui-function"],
  refreshFeatures: ["script", "scripts/anticodex-manager-service.mjs", "refresh-anticodex-local-features.ps1"], stabilitySoak: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-stability-soak.ps1"],
  coldRelaunch: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-cold-relaunch.ps1"], fastOverallNoTraffic: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-installed-overall.ps1"],
  overallNoTraffic: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-installed-overall.ps1"], postVerificationFull: ["script", "scripts/anticodex-manager-service.mjs", "test-anticodex-post-verification.ps1"],
});

function exactStringList(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function samePath(left, right) {
  try { return resolve(String(left || "")).toLowerCase() === resolve(String(right || "")).toLowerCase(); } catch { return false; }
}

function normalizedContractPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return normalized && !normalized.startsWith("/") && !normalized.split("/").includes("..") ? normalized : "";
}

function validateManagerHandlerProvenance(handlerVerification, runtimeIdentity) {
  const contracts = handlerVerification?.contracts || {};
  const entries = Object.entries(contracts);
  const provenance = handlerVerification?.provenance || {};
  const runtimeRoot = resolve(String(provenance?.runtimeRoot || ""));
  const manifestPath = resolve(String(provenance?.manifestPath || ""));
  const taskRuntimePid = Number(provenance?.taskRuntimePid || 0);
  const taskRuntimeCreationDateUtc = String(provenance?.taskRuntimeCreationDateUtc || "");
  const sourceGit = currentSourceGitState();
  const liveTaskRuntime = queryExactWindowsProcess(taskRuntimePid);
  const expectedTaskRuntimeScript = resolve(runtimeRoot, "scripts", "start-anticodex-fixed-route.mjs");
  if (entries.length !== managerActions.length || !entries.every(([action, entry], index) => {
    const expected = managerHandlerContractByAction[action];
    return action === managerActions[index] && entry?.verified === true && String(entry?.kind || "") === expected?.[0]
      && String(entry?.source || "") === expected?.[1] && String(entry?.handler || "") === expected?.[2];
  }) || provenance?.schema !== "anticodex-manager-handler-provenance-v1" || provenance?.verified !== true
    || !samePath(provenance?.scriptsRoot, resolve(runtimeRoot, "scripts"))
    || !samePath(manifestPath, resolve(runtimeRoot, ".anticodex-runtime-manifest.json"))
    || !samePath(provenance?.sourceRoot, sourceRoot) || sourceGit.ok !== true
    || taskRuntimePid <= 0 || taskRuntimePid !== Number(runtimeIdentity?.supervisorPid || 0)
    || !samePath(provenance?.taskRuntimeScriptPath, expectedTaskRuntimeScript)
    || !liveTaskRuntime || Number(liveTaskRuntime.processId) !== taskRuntimePid
    || String(liveTaskRuntime.executablePath || "").replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() !== "node.exe"
    || !Array.isArray(liveTaskRuntime.arguments) || liveTaskRuntime.arguments.length < 2
    || !samePath(liveTaskRuntime.arguments[1], expectedTaskRuntimeScript)
    || !taskRuntimeCreationDateUtc || String(liveTaskRuntime.creationDateUtc || "") !== taskRuntimeCreationDateUtc
    || String(provenance?.sourceGitHead || "").toLowerCase() !== sourceGit.head
    || provenance?.sourceGitClean !== true || provenance?.sourceRevisionProvenance !== "git"
    || !existsSync(manifestPath) || !statSync(manifestPath).isFile()
    || sha256File(manifestPath) !== String(provenance?.manifestSha256 || "").toLowerCase()) return false;
  let manifest;
  try { manifest = readJson(manifestPath); } catch { return false; }
  if (manifest?.schema !== "anticodex-runtime-manifest-v2" || manifest?.state !== "validated"
    || !samePath(manifest?.activeRuntime, runtimeRoot) || !samePath(manifest?.sourceRoot, sourceRoot)
    || String(manifest?.sourceGitHead || "").toLowerCase() !== sourceGit.head
    || manifest?.sourceGitClean !== true || manifest?.sourceRevisionProvenance !== "git") return false;
  const expectedFiles = [...new Set(["scripts/start-anticodex-fixed-route.mjs", ...entries.flatMap(([, entry]) => [
    normalizedContractPath(entry?.source), String(entry?.handler || "").toLowerCase().endsWith(".ps1") ? normalizedContractPath(`scripts/${entry.handler}`) : "",
  ])].filter(Boolean))];
  const files = Array.isArray(provenance?.files) ? provenance.files : [];
  const fileByPath = new Map(files.map((entry) => [normalizedContractPath(entry?.relativePath), entry]));
  if (files.length !== expectedFiles.length || fileByPath.size !== files.length) return false;
  return expectedFiles.every((relativePath) => {
    const entry = fileByPath.get(relativePath);
    const expectedHash = String(entry?.fileSha256 || "").toLowerCase();
    const manifestEntry = Object.entries(manifest?.files || {}).find(([path]) => normalizedContractPath(path) === relativePath);
    const runtimePath = resolve(runtimeRoot, relativePath);
    const currentSourcePath = resolve(sourceRoot, relativePath);
    return /^[a-f0-9]{64}$/.test(expectedHash) && String(entry?.manifestSha256 || "").toLowerCase() === expectedHash
      && String(manifestEntry?.[1] || "").toLowerCase() === expectedHash
      && existsSync(runtimePath) && statSync(runtimePath).isFile() && sha256File(runtimePath) === expectedHash
      && existsSync(currentSourcePath) && statSync(currentSourcePath).isFile() && sha256File(currentSourcePath) === expectedHash;
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function currentSourceGitState(root = sourceRoot) {
  const run = (gitArgs) => spawnSync("git", ["-C", root, ...gitArgs], {
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
public static class AntiCodexReleaseCommandLine {
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
  arguments = @([AntiCodexReleaseCommandLine]::Parse([string]$row.CommandLine))
} | ConvertTo-Json -Depth 4 -Compress
`;
  const result = spawnSync(powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  if (result.error || result.status !== 0) return null;
  try { return JSON.parse(String(result.stdout || "").trim()); } catch { return null; }
}

function startSuspendedSelfTestSupervisor(scriptPath) {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, NODE_OPTIONS: "--inspect-brk=0" },
    stdio: "ignore",
    windowsHide: true,
  });
  let snapshot = null;
  for (let attempt = 0; attempt < 20 && !snapshot; attempt += 1) {
    snapshot = queryExactWindowsProcess(child.pid);
    if (!snapshot) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (!snapshot) {
    child.kill();
    throw new Error("could not observe suspended fixed-route self-test supervisor");
  }
  return { child, snapshot };
}

function stopSelfTestSupervisor(supervisor, {
  queryProcess = queryExactWindowsProcess,
  killProcessTree = (processId) => spawnSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], { windowsHide: true, stdio: "ignore" }),
} = {}) {
  const processId = Number(supervisor?.child?.pid || 0);
  const capturedProcessId = Number(supervisor?.snapshot?.processId || 0);
  const expectedCreationDateUtc = String(supervisor?.snapshot?.creationDateUtc || "");
  if (!Number.isInteger(processId) || processId <= 0 || capturedProcessId !== processId || !expectedCreationDateUtc) return false;
  const liveProcess = queryProcess(processId);
  if (Number(liveProcess?.processId || 0) !== processId
    || String(liveProcess?.creationDateUtc || "") !== expectedCreationDateUtc) return false;
  return killProcessTree(processId)?.status === 0;
}

const codexPlusPlusMetadata = readJson(join(sourceRoot, "third_party", "codexplusplus", "upstream.json"));
const expectedCodexPlusPlusPatchCommit = String(codexPlusPlusMetadata?.patchCommit || "");
const expectedCodexPlusPlusVersion = String(codexPlusPlusMetadata?.version || "");
const expectedCodexPlusPlusBinarySha256 = String(codexPlusPlusMetadata?.verification?.launcherReleaseBuild || "")
  .replace(/^sha256:/i, "")
  .toLowerCase();
if (!/^[0-9a-f]{40}$/.test(expectedCodexPlusPlusPatchCommit)) {
  throw new Error("Pinned CodexPlusPlus patch commit is missing or invalid.");
}
if (!expectedCodexPlusPlusVersion || !/^[0-9a-f]{64}$/.test(expectedCodexPlusPlusBinarySha256)) {
  throw new Error("Pinned CodexPlusPlus version or release binary hash is missing or invalid.");
}

function writeAtomic(path, value, encoding = "utf8") {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, value, encoding);
  renameSync(temporary, path);
}

function writeSignedJson(path, payload) {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  writeAtomic(path, json);
  writeAtomic(`${path}.sha256`, `sha256:${sha256Buffer(json)}\n`, "ascii");
}

function integrity(path, requireSidecar) {
  if (!existsSync(path)) return { signed: false, valid: null, error: "missing_report" };
  const actual = sha256File(path);
  if (!requireSidecar) return { signed: false, valid: true, hash: actual, error: "" };
  const sidecar = `${path}.sha256`;
  if (!existsSync(sidecar)) return { signed: false, valid: false, hash: actual, error: "missing_hash_sidecar" };
  const match = readFileSync(sidecar, "ascii").trim().match(/^(?:sha256:)?([a-f0-9]{64})$/i);
  if (!match) return { signed: true, valid: false, hash: actual, error: "invalid_hash_sidecar" };
  const expected = match[1].toLowerCase();
  return { signed: true, valid: actual === expected, hash: actual, expected, error: actual === expected ? "" : "hash_mismatch" };
}

function currentReleaseBinding() {
  return createCurrentReleaseBinding({ sourceRoot, reportRoot });
}

const releaseBindingFields = RELEASE_BINDING_FIELDS;

function validateReleaseBinding(candidate, failures, prefix) {
  const expected = currentReleaseBinding();
  if (expected.valid !== true) failures.push(`${prefix}_current_release_binding_unavailable`);
  if (candidate?.valid !== true
    || releaseBindingFields.some((field) => String(candidate?.[field] ?? "") !== String(expected[field] ?? ""))) {
    failures.push(`${prefix}_release_binding`);
  }
}

function reportTimestampMs(report, path = "") {
  for (const value of [
    report?.generatedAt,
    report?.generatedAtUtc,
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
  return path ? statSync(path).mtimeMs : Number.NaN;
}

function empty(value) {
  return Array.isArray(value) && value.length === 0;
}

function checkObjectOk(report, names, failures, prefix) {
  for (const name of names) {
    if (report?.checks?.[name]?.ok !== true) failures.push(`${prefix}_${name}_not_ok`);
  }
}

function checkArray(report, minimum, requiredIds, failures, prefix) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  if (checks.length < minimum) failures.push(`${prefix}_check_count`);
  if (checks.some((check) => check?.ok !== true)) failures.push(`${prefix}_failed_check`);
  const ids = new Set(checks.map((check) => String(check?.id || "")));
  for (const id of requiredIds) {
    if (!ids.has(id)) failures.push(`${prefix}_missing_${id}`);
  }
}

function validateArtifactFiles(artifacts, failures, prefix, expectedHashField) {
  if (!Array.isArray(artifacts)) return;
  let missing = false;
  let sizeMismatch = false;
  let hashMismatch = false;
  for (const artifact of artifacts) {
    const path = String(artifact?.path || "");
    if (!path || !existsSync(path)) {
      missing = true;
      continue;
    }
    const stats = statSync(path);
    if (!stats.isFile() || Number(artifact?.bytes || 0) <= 0 || stats.size !== Number(artifact.bytes)) {
      sizeMismatch = true;
      continue;
    }
    const expectedHash = String(artifact?.[expectedHashField] || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedHash) || sha256File(path) !== expectedHash) hashMismatch = true;
  }
  if (missing) failures.push(`${prefix}_artifact_file_missing`);
  if (sizeMismatch) failures.push(`${prefix}_artifact_file_size_mismatch`);
  if (hashMismatch) failures.push(`${prefix}_artifact_file_hash_mismatch`);
}

function validateGate5CurrentUiEvidence(report, failures) {
  const evidence = report?.currentUiEvidence || {};
  const manager = evidence.manager_actual_mouse_matrix;
  const closeProbes = Array.isArray(manager?.closeProbes) ? manager.closeProbes : [];
  const closeByName = Object.fromEntries(closeProbes.map((entry) => [String(entry?.name || ""), entry]));
  const protocol = manager?.protocolInteraction || {};
  const uiInteraction = manager?.uiInteraction || {};
  const handlerVerification = manager?.handlerVerification || {};
  if (manager?.ok !== true
    || manager?.usedRealTraffic !== false
    || manager?.actualMouse !== true
    || Number(manager?.actionCount) < 20
    || manager?.zeroSideEffects !== true
    || uiInteraction?.scope !== "ui-interaction-only"
    || Number(uiInteraction?.verifiedCount) !== managerActions.length
    || !exactStringList(uiInteraction?.verifiedActionIds, managerActions)
    || !exactStringList(handlerVerification?.offlineContractVerifiedActionIds, managerActions)
    || !exactStringList(handlerVerification?.safeRealActionIds, safeRealManagerActions)
    || !exactStringList(handlerVerification?.realExecutedActionIds, [])
    || !exactStringList(handlerVerification?.pendingAuthorizedActionIds, highImpactManagerActions)
    || handlerVerification?.allFunctionsVerified !== false
    || !validateManagerHandlerProvenance(handlerVerification, manager?.runtimeIdentity)
    || manager?.profileEntryText !== "管理"
    || manager?.forbiddenEnglishVisible !== false
    || manager?.trayIconPreserved !== true
    || manager?.closeUpper !== true
    || manager?.closeCenter !== true
    || manager?.closeLower !== true
    || manager?.closeHasTextNode !== false
    || closeProbes.length !== 3
    || !["upper-center", "center", "lower-center"].every((name) => closeByName[name]?.ok === true
      && closeByName[name]?.actualMouse === true
      && closeByName[name]?.closed === true
      && closeByName[name]?.hasTextNode === false)
    || protocol?.before !== "chatCompletions"
    || protocol?.alternate !== "responses"
    || protocol?.restored !== protocol?.before
    || protocol?.selectedAlternate !== true
    || protocol?.restoredOriginal !== true
    || protocol?.profileUnchanged !== true) failures.push("gate5_current_ui_manager_actual_mouse_matrix");

  const modelSwitch = evidence.frontend_model_hot_switch;
  const switches = Array.isArray(modelSwitch?.switches) ? modelSwitch.switches : [];
  const providers = new Set(switches.map((entry) => String(entry?.provider || "")));
  const pidNames = ["supervisor", "codexPlusPlus", "antiCodexMain"];
  const baseline = switches[0] || {};
  if (modelSwitch?.ok !== true
    || modelSwitch?.usedRealTraffic !== false
    || modelSwitch?.sameTask !== true
    || String(modelSwitch?.taskId || "") === ""
    || modelSwitch?.noRestart !== true
    || modelSwitch?.requestCountUnchanged !== true
    || modelSwitch?.pidUnchanged !== true
    || Number(modelSwitch?.switchCount) !== switches.length
    || switches.length < 3
    || !providers.has("gemini")
    || !providers.has("claude")
    || !providers.has("third-party")
    || switches.some((entry) => entry?.ok !== true
      || entry?.actualMouse !== true
      || entry?.taskId !== modelSwitch?.taskId
      || Number(entry?.requestCountBefore) !== Number(entry?.requestCountAfter)
      || Number(entry?.latestRequestRowIdBefore) !== Number(entry?.latestRequestRowIdAfter)
      || entry?.originalCodexAlive !== true
      || pidNames.some((name) => Number(entry?.[`${name}PidBefore`]) <= 0
        || Number(entry?.[`${name}PidBefore`]) !== Number(entry?.[`${name}PidAfter`])
        || Number(entry?.[`${name}PidBefore`]) !== Number(baseline?.[`${name}PidBefore`])))
    || modelSwitch?.originalCodexAlive !== true) failures.push("gate5_current_ui_frontend_model_hot_switch");

  const restore = evidence.shortcut_restore_single_window_no_blank_frames;
  const rounds = Array.isArray(restore?.rounds) ? restore.rounds : [];
  const mainPid = Number(rounds[0]?.expectedMainPid || 0);
  const originalCodexPid = Number(rounds[0]?.expectedOriginalCodexPid || 0);
  if (restore?.ok !== true
    || restore?.usedRealTraffic !== false
    || restore?.sameMainPid !== true
    || Number(restore?.mainPid) !== mainPid
    || Number(restore?.roundCount) !== rounds.length
    || rounds.length < 3
    || mainPid <= 0
    || originalCodexPid <= 0
    || Number(restore?.maxRootProcessCount) !== 1
    || Number(restore?.maxVisibleWindowCount) !== 1
    || Number(restore?.maxAppPageCount) !== 1
    || Number(restore?.blankFrameCount) !== 0
    || rounds.some((round) => round?.ok !== true
      || Number(round?.expectedMainPid) !== mainPid
      || Number(round?.expectedOriginalCodexPid) !== originalCodexPid
      || round?.minimizedObserved !== true
      || Number(round?.restoredAtMs) <= 0
      || Number(round?.maxRootProcessCount) !== 1
      || Number(round?.maxVisibleWindowCount) !== 1
      || Number(round?.maxAppPageCount) !== 1
      || Number(round?.appPagesAfter) !== 1
      || Number(round?.blankFrameCount) !== 0
      || Number(round?.frameCount) < 1
      || round?.originalCodexAlive !== true
      || !Array.isArray(round?.after?.rootProcessIds)
      || round.after.rootProcessIds.length !== 1
      || Number(round.after.rootProcessIds[0]) !== mainPid
      || !Array.isArray(round?.after?.visibleWindowProcessIds)
      || round.after.visibleWindowProcessIds.length !== 1
      || Number(round.after.visibleWindowProcessIds[0]) !== mainPid)
    || restore?.originalCodexAlive !== true) failures.push("gate5_current_ui_shortcut_restore_single_window_no_blank_frames");
}

function validateGate5SourceEvidence(report, failures) {
  const required = ["taskManifest", "managerEvidence", "modelSwitchEvidence", "shortcutRestoreEvidence", "releaseBindingEvidence"];
  let invalid = false;
  for (const id of required) {
    const entry = report?.sourceEvidence?.[id];
    const path = String(entry?.path || "");
    if (!path || !existsSync(path)) {
      invalid = true;
      continue;
    }
    const hash = integrity(path, true);
    const timestamp = Date.parse(String(entry?.checkedAt || ""));
    const ageHours = Number.isFinite(timestamp) ? (Date.now() - timestamp) / 3_600_000 : Number.POSITIVE_INFINITY;
    if (hash.valid !== true
      || String(hash.hash || "") !== String(entry?.sha256 || "")
      || ageHours < -(5 / 60)
      || ageHours > maxAgeHours) {
      invalid = true;
      continue;
    }
    try {
      const data = readJson(path);
      const sourceTimestampMs = reportTimestampMs(data);
      const sourceAgeHours = Number.isFinite(sourceTimestampMs) ? (Date.now() - sourceTimestampMs) / 3_600_000 : Number.POSITIVE_INFINITY;
      const binding = data?.releaseBinding || data;
      if (!Number.isFinite(sourceTimestampMs)
        || sourceAgeHours < -(5 / 60)
        || sourceAgeHours > maxAgeHours
        || new Date(sourceTimestampMs).toISOString() !== String(entry?.checkedAt || "")
        || binding?.valid !== true
        || releaseBindingFields.some((field) => String(binding?.[field] ?? "") !== String(report?.releaseBinding?.[field] ?? ""))) invalid = true;
    } catch {
      invalid = true;
    }
  }
  if (invalid) failures.push("gate5_source_evidence_invalid");
}

function inspectEvidence(definition) {
  const path = resolve(definition.path);
  const present = existsSync(path);
  const hash = integrity(path, definition.signed === true);
  let report = null;
  let parseable = false;
  let parseError = "";
  if (present && hash.valid === true) {
    try {
      report = readJson(path);
      parseable = true;
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  const embeddedTimestampMs = parseable ? reportTimestampMs(report) : Number.NaN;
  const timestampMs = Number.isFinite(embeddedTimestampMs) ? embeddedTimestampMs : (parseable ? reportTimestampMs(report, path) : Number.NaN);
  const rawAgeHours = Number.isFinite(timestampMs) ? (Date.now() - timestampMs) / 3_600_000 : null;
  const ageHours = Number.isFinite(rawAgeHours) ? Math.max(0, rawAgeHours) : null;
  const freshnessRequired = definition.live === true || definition.freshnessRequired === true;
  const embeddedTimestampRequired = definition.freshnessRequired === true;
  const fresh = !freshnessRequired || (
    Number.isFinite(rawAgeHours)
    && rawAgeHours >= -(5 / 60)
    && rawAgeHours <= maxAgeHours
    && (!embeddedTimestampRequired || Number.isFinite(embeddedTimestampMs))
  );
  const semanticFailures = [];
  if (parseable) definition.validate(report, semanticFailures);
  const satisfied = present && parseable && hash.valid === true && fresh && semanticFailures.length === 0;
  return {
    id: definition.id,
    path,
    selectedFile: basename(path),
    selectedKind: freshnessRequired ? "current" : definition.signed === true ? "signed-retained" : "tracked-audit",
    selectedMtime: present ? statSync(path).mtime.toISOString() : "",
    present,
    parseable,
    signed: hash.signed,
    hashValid: hash.valid,
    hash: hash.hash || "",
    integrityError: hash.error,
    error: parseError,
    okField: report?.ok === true,
    ageHours,
    timestampEmbedded: Number.isFinite(embeddedTimestampMs),
    fresh,
    semanticFailures,
    reportFailureSamples: Array.isArray(report?.failures) ? report.failures.slice(0, 3).map(String) : [],
    satisfied,
  };
}

function validateGate1(report, failures) {
  if (report?.schema !== "anticodex-codexplusplus-runtime-isolation-v1") failures.push("gate1_schema");
  if (report?.ok !== true || report?.noModelTraffic !== true) failures.push("gate1_result");
  if (!empty(report?.failedCheckIds)) failures.push("gate1_failed_ids");
  if (report?.launcher?.patchCommit !== expectedCodexPlusPlusPatchCommit) failures.push("gate1_patch_commit");
  validateReleaseBinding(report?.releaseBinding, failures, "gate1");
  checkArray(report, 21, ["original_processes_unchanged", "stable_original_state_unchanged_after_cleanup", "run_artifacts_cleaned"], failures, "gate1");
}

function validateGate2(report, failures) {
  if (report?.schemaVersion !== 1 || report?.gate !== "Gate 2 deterministic third-party provider route") failures.push("gate2_schema");
  if (report?.ok !== true || report?.modelTraffic !== "loopback fake provider only") failures.push("gate2_result");
  validateReleaseBinding(report?.releaseBinding, failures, "gate2");
  checkArray(report, 27, ["native_codex_cli_exact_tool_result_returned", "protocol_proxy_upstream_cancellation_before_headers", "original_stable_state_unchanged"], failures, "gate2");
}

function validateGate3(report, failures) {
  if (report?.schemaVersion !== 1 || report?.gate !== "Gate 3 thin Antigravity Chat adapter contract") failures.push("gate3_schema");
  if (report?.ok !== true || !empty(report?.failedIds)) failures.push("gate3_result");
  if (report?.realTraffic?.ok !== true || report?.realTraffic?.exactArguments !== true || report?.realTraffic?.exactToolResultObserved !== true) failures.push("gate3_real_result");
  if (report?.realTraffic?.counters?.start !== 1 || report?.realTraffic?.counters?.resume !== 1) failures.push("gate3_continuation");
  if (!Array.isArray(report?.providerSources) || report.providerSources.length !== 4 || report.providerSources.some((source) => source?.forbiddenImport || source?.forbiddenSemantics)) failures.push("gate3_provider_boundary");
  validateReleaseBinding(report?.releaseBinding, failures, "gate3");
  checkArray(report, 7, ["legacy_import_zero_hit", "task_semantics_zero_hit", "real_native_tool_round_trip"], failures, "gate3");
}

function validateGate4(report, failures) {
  if (report?.schemaVersion !== 1 || report?.gate !== "Gate 4 isolated CodexPlusPlus to Antigravity route switch") failures.push("gate4_schema");
  if (report?.ok !== true || report?.cli?.exitCode !== 0 || report?.cli?.fileChangeEventCount !== 1) failures.push("gate4_result");
  if (report?.counters?.start !== 1 || report?.counters?.resume !== 1) failures.push("gate4_continuation");
  if (JSON.stringify(report?.oldRoute?.before) !== JSON.stringify(report?.oldRoute?.after)) failures.push("gate4_old_route_changed");
  validateReleaseBinding(report?.releaseBinding, failures, "gate4");
  checkArray(report, 23, ["old_mixed_route_received_zero_requests", "provider_exact_single_tool_continuation", "temporary_artifacts_removed"], failures, "gate4");
}

function validateGate5(report, failures) {
  if (report?.schema !== "anticodex-gate5-visible-integration-v1" || report?.gate !== 5) failures.push("gate5_schema");
  if (report?.ok !== true
    || report?.gateComplete !== true
    || report?.requestedRealTraffic !== false
    || report?.usedRealTraffic !== false
    || report?.sourceEvidenceUsedRealTraffic !== true
    || report?.coverageKind !== "current-release-explicit-evidence-aggregate") failures.push("gate5_result");
  if (report?.task?.newTask !== true
    || report?.task?.nativeTask !== true
    || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(report?.task?.taskId || ""))
    || Number(report?.task?.promptSubmissionCount) !== 1
    || Number(report?.task?.totalGoalPromptCount) !== 1
    || Number(report?.task?.hostIntermediatePromptCount) !== 0) failures.push("gate5_native_task_contract");
  if (report?.route?.provider !== "antigravity" || report?.route?.relayProtocol !== "chatCompletions") failures.push("gate5_route");
  if (report?.route?.codexPlusPlusVersion !== expectedCodexPlusPlusVersion) failures.push("gate5_component_version");
  if (!Array.isArray(report?.artifactEvidence) || report.artifactEvidence.length < 3 || report.artifactEvidence.some((artifact) => artifact?.ok !== true || artifact?.actualHash !== artifact?.expectedHash)) failures.push("gate5_artifacts");
  validateArtifactFiles(report?.artifactEvidence, failures, "gate5", "expectedHash");
  validateReleaseBinding(report?.releaseBinding, failures, "gate5");
  validateGate5SourceEvidence(report, failures);
  validateGate5CurrentUiEvidence(report, failures);
  checkArray(report, 20, [
    "profile_menu_uses_exact_chinese_manager_label",
    "manager_close_full_height_actual_mouse",
    "live_tray_icon_preserved",
    "manager_protocol_physical_round_trip",
    "manager_actual_mouse_matrix",
    "frontend_model_hot_switch",
    "frontend_model_hot_switch_same_task",
    "frontend_model_hot_switch_zero_requests",
    "frontend_model_hot_switch_stable_processes",
    "shortcut_restore_single_window_no_blank_frames",
    "shortcut_restore_three_rounds",
  ], failures, "gate5");
}

function validateGate6(report, failures) {
  if (report?.schemaVersion !== 1 || report?.gate !== "Gate 6 edge and recovery matrix") failures.push("gate6_schema");
  if (report?.ok !== true || report?.formalGateAdvanced !== true || !empty(report?.failedIds)) failures.push("gate6_result");
  validateReleaseBinding(report?.releaseBinding, failures, "gate6");
  checkArray(report, 14, ["deterministic_quota_no_retry", "deterministic_restart_no_replay", "real_client_abort_cancel_and_recover", "real_copied_client_crash_same_task_resume"], failures, "gate6");
}

function validateLegacyZeroHit(report, failures) {
  if (report?.reportName !== "legacy-zero-hit" || report?.ok !== true || report?.noTraffic !== true || report?.usedRealTraffic !== false) failures.push("legacy_zero_hit_result");
  for (const field of ["legacyFilesExist", "forbiddenImports", "forbiddenBehaviors"]) {
    if (!empty(report?.[field])) failures.push(`legacy_zero_hit_${field}`);
  }
}

function validateSourcePreflight(report, failures, sourceGit = currentSourceGitState()) {
  if (report?.reportName !== "source-preflight" || report?.ok !== true || report?.noTraffic !== true || report?.usedRealTraffic !== false || report?.behaviorCovered !== true) failures.push("source_preflight_result");
  if (!empty(report?.failures)) failures.push("source_preflight_failures");
  checkObjectOk(report, ["sourceGitRevision", "javascriptSyntax", "powershellSyntax", "uiStateSelfTest", "managerBridgeSelfTest", "localConnectorVerifier", "managerMojibakeContracts", "translatorRegression", "diffWhitespace"], failures, "source_preflight");
  if (report?.skipFullRegression !== false || report?.checks?.translatorRegression?.skipped === true) failures.push("source_preflight_full_regression");
  if (report?.sourceGitClean !== true || report?.checks?.sourceGitRevision?.clean !== true) failures.push("source_preflight_git_generated_dirty");
  if (sourceGit?.ok !== true) failures.push("source_preflight_git_state");
  else {
    if (!/^[0-9a-f]{40}$/i.test(String(report?.sourceGitHead || "")) || String(report.sourceGitHead).toLowerCase() !== sourceGit.head) failures.push("source_preflight_git_revision");
    if (sourceGit.clean !== true) failures.push("source_preflight_git_dirty");
  }
}

function validateSyncReadiness(report, failures) {
  if (report?.reportName !== "sync-readiness" || report?.ok !== true || report?.noTraffic !== true || report?.usedRealTraffic !== false) failures.push("sync_readiness_result");
  if (!empty(report?.failures)) failures.push("sync_readiness_failures");
  const contract = report?.clientSyncContract;
  if (contract?.mode !== "codex-client-copy-plus-anticodex-patches" || contract?.nativeClientBehaviorCarriedByHostSync !== true || contract?.forbidsFeatureByFeatureReimplementation !== true || contract?.sourceHostHashMatches !== true || contract?.sourceCliHashMatches !== true) failures.push("sync_readiness_client_contract");
  const expectedPatchScope = ["branding", "icons", "shortcuts", "isolation", "launcher", "model-adapter"];
  if (JSON.stringify(contract?.antiCodexPatchScope) !== JSON.stringify(expectedPatchScope)) failures.push("sync_readiness_patch_scope");
  if (report?.activeHost?.manifestValid !== true || report?.activeHost?.hostBinaryPreserved !== true || report?.activeHost?.trayIconPalette?.ok !== true) failures.push("sync_readiness_active_host");
  const sync = report?.sync;
  if (sync?.scriptExists !== true || sync?.launcherExists !== true || sync?.rollbackScriptExists !== true || sync?.rollbackLauncherExists !== true || sync?.updateCheckExists !== true) failures.push("sync_readiness_entrypoints");
  if (sync?.updateStatus?.ok !== true || sync?.updateStatus?.guardrails?.brandPreserved !== true || sync?.updateStatus?.guardrails?.rollbackOnFailure !== true) failures.push("sync_readiness_update_status");
  if (["failed", "running"].includes(String(sync?.updateStatus?.operation?.state || "").toLowerCase())) failures.push("sync_readiness_operation_state");
  if (sync?.rollbackHost?.manifestValid !== true || sync?.rollbackHost?.hostBinaryPreserved !== true || sync?.rollbackHost?.trayIconPalette?.ok !== true) failures.push("sync_readiness_rollback_host");
  if (sync?.hostSyncMarkerExists !== false || sync?.staleCandidateExists !== false || sync?.rollbackSwapHostExists !== false || sync?.rollbackSwapMarkerExists !== false) failures.push("sync_readiness_stale_state");
}

function validateInstalledOverall(report, failures) {
  if (report?.reportName !== "installed-overall" || report?.ok !== true || report?.noTraffic !== true || report?.usedRealTraffic !== false || report?.coverageKind !== "fixed-three-layer-installed-no-traffic") failures.push("installed_overall_result");
  if (!empty(report?.failures)) failures.push("installed_overall_failures");
  if (report?.health?.schema !== "anticodex-fixed-route-status-v1" || report?.health?.state !== "ready" || !["antigravity", "third-party"].includes(report?.health?.provider)) failures.push("installed_overall_health");
  checkObjectOk(report, ["managerHealth", "fixedRouteHealth", "runtimeFiles", "codexPlusPlusComponent", "processOwnership", "stateIsolation", "branding", "rollbackCheckpoint", "legacyZeroHit", "modelCatalog", "uiState"], failures, "installed_overall");
}

function validateGate8(report, failures) {
  const semanticFailures = validateGate8AutonomousVideoReport(report);
  failures.push(...semanticFailures.map((failure) => `gate8_${failure.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`));
  validateArtifactFiles(report?.artifacts, failures, "gate8", "sha256");
  validateReleaseBinding(report?.releaseBinding, failures, "gate8");
  const builderPath = join(sourceRoot, "scripts", "build-anticodex-gate8-autonomous-video-evidence.mjs");
  const input = report?.evidenceInput || {};
  if (input?.integritySidecarVerified !== true
    || input?.inProcessWitnessVerified !== true
    || input?.cryptographicHostIdentity !== false
    || input?.sourceBuilderMatched !== true
    || !existsSync(builderPath)
    || resolve(String(input?.sourceBuilder?.path || "")) !== resolve(builderPath)
    || String(input?.sourceBuilder?.sha256 || "").toLowerCase() !== sha256File(builderPath)) {
    failures.push("gate8_integrity_witness_source_builder_provenance");
  }
}

const gateDefinitions = [
  { id: "gate1", number: 1, name: "CodexPlusPlus isolation compatibility", group: "architecture", signed: true, live: false, freshnessRequired: true, path: join(sourceRoot, "docs", "audits", "2026-07-14-codexplusplus-runtime-isolation.json"), validate: validateGate1 },
  { id: "gate2", number: 2, name: "Deterministic third-party provider route", group: "architecture", signed: true, live: false, freshnessRequired: true, path: join(sourceRoot, "docs", "audits", "2026-07-14-codexplusplus-third-party-route.json"), validate: validateGate2 },
  { id: "gate3", number: 3, name: "Thin Antigravity Chat adapter", group: "architecture", signed: true, live: false, freshnessRequired: true, path: join(sourceRoot, "docs", "audits", "2026-07-14-antigravity-chat-adapter-contract.json"), validate: validateGate3 },
  { id: "gate4", number: 4, name: "Isolated fixed-route switch", group: "architecture", signed: true, live: false, freshnessRequired: true, path: join(sourceRoot, "docs", "audits", "2026-07-14-gate4-isolated-route-switch.json"), validate: validateGate4 },
  { id: "gate5", number: 5, name: "Visible copied-client integration", group: "integration", signed: true, live: false, freshnessRequired: true, path: join(sourceRoot, "docs", "audits", "2026-07-15-gate5-visible-integration.json"), validate: validateGate5 },
  { id: "gate6", number: 6, name: "Bounded edge and recovery matrix", group: "integration", signed: true, live: false, freshnessRequired: true, path: join(sourceRoot, "docs", "audits", "2026-07-15-gate6-edge-matrix.json"), validate: validateGate6 },
];

const gate7Definitions = [
  { id: "legacyZeroHit", signed: true, live: true, path: join(reportRoot, "latest-legacy-zero-hit.json"), validate: validateLegacyZeroHit },
  { id: "sourcePreflight", signed: true, live: true, path: join(reportRoot, "latest-source-preflight.json"), validate: validateSourcePreflight },
  { id: "syncReadiness", signed: true, live: true, path: join(reportRoot, "latest-sync-readiness.json"), validate: validateSyncReadiness },
  { id: "installedOverall", signed: true, live: true, path: join(reportRoot, "latest-installed-overall.json"), validate: validateInstalledOverall },
];

const gate8Definitions = [
  { id: "formalLongTask", signed: true, live: false, freshnessRequired: true, path: join(reportRoot, "latest-gate8-final-long-task.json"), validate: validateGate8 },
];

function makeGate(definition) {
  const evidence = inspectEvidence(definition);
  return {
    ...evidence,
    id: definition.id,
    gate: definition.number,
    name: definition.name,
    group: definition.group,
    requiredForShort: definition.number <= 7,
    requiredForRelease: true,
    status: evidence.satisfied ? "complete" : "incomplete",
  };
}

function makeGate7() {
  const evidence = gate7Definitions.map(inspectEvidence);
  const semanticFailures = evidence.flatMap((item) => item.semanticFailures.map((failure) => `${item.id}:${failure}`));
  const unsatisfied = evidence.filter((item) => !item.satisfied).map((item) => item.id);
  const satisfied = unsatisfied.length === 0;
  return {
    id: "gate7",
    gate: 7,
    name: "Component completion and release closeout",
    group: "release",
    requiredForShort: true,
    requiredForRelease: true,
    present: evidence.every((item) => item.present),
    parseable: evidence.every((item) => item.parseable),
    signed: true,
    hashValid: evidence.every((item) => item.hashValid === true),
    okField: evidence.every((item) => item.okField === true),
    fresh: evidence.every((item) => item.fresh),
    ageHours: evidence.reduce((maximum, item) => Math.max(maximum, Number(item.ageHours) || 0), 0),
    semanticFailures,
    reportFailureSamples: evidence.flatMap((item) => item.reportFailureSamples).slice(0, 3),
    selectedFile: evidence.map((item) => item.selectedFile).join(","),
    selectedKind: "latest-composite",
    selectedMtime: evidence.map((item) => item.selectedMtime).sort().at(-1) || "",
    missingEvidence: unsatisfied,
    evidence,
    satisfied,
    status: satisfied ? "complete" : "in_progress",
  };
}

function makeGate8() {
  const evidence = gate8Definitions.map(inspectEvidence);
  const semanticFailures = evidence.flatMap((item) => item.semanticFailures.map((failure) => `${item.id}:${failure}`));
  const unsatisfied = evidence.filter((item) => !item.satisfied).map((item) => item.id);
  const satisfied = unsatisfied.length === 0;
  return {
    id: "gate8",
    gate: 8,
    name: "Final visible long-task acceptance",
    group: "acceptance",
    requiredForShort: false,
    requiredForRelease: true,
    present: evidence.every((item) => item.present),
    parseable: evidence.every((item) => item.parseable),
    signed: true,
    hashValid: evidence.every((item) => item.hashValid === true),
    okField: evidence.every((item) => item.okField === true),
    fresh: evidence.every((item) => item.fresh),
    ageHours: evidence.reduce((maximum, item) => Math.max(maximum, Number(item.ageHours) || 0), 0),
    semanticFailures,
    reportFailureSamples: evidence.flatMap((item) => item.reportFailureSamples).slice(0, 3),
    selectedFile: evidence.map((item) => item.selectedFile).join(","),
    selectedKind: "latest-composite",
    selectedMtime: evidence.map((item) => item.selectedMtime).sort().at(-1) || "",
    missingEvidence: unsatisfied,
    evidence,
    satisfied,
    status: satisfied ? "complete" : "in_progress",
  };
}

function compactStatus(payload) {
  return {
    ok: payload.ok,
    reportName: payload.reportName,
    architecture: payload.architecture,
    shellProgress: payload.shellProgress,
    codexPlusPlusProgress: payload.codexPlusPlusProgress,
    antigravityAdapterProgress: payload.antigravityAdapterProgress,
    overallProgress: payload.overallProgress,
    completedGates: payload.completedGates,
    currentGate: payload.currentGate,
    shortReady: payload.shortReady,
    releaseReady: payload.releaseReady,
    releaseBinding: payload.releaseBinding,
    missingRequired: payload.missingRequired,
    missingShort: payload.missingShort,
    damagedReports: payload.damagedReports,
    nextActions: payload.nextActions,
  };
}

function gate8NextAction(missingEvidence = []) {
  if (missingEvidence.includes("formalLongTask")) {
    return {
      id: "runGate8",
      phase: "acceptance",
      command: "After the one native autonomous task finishes, run scripts/test-anticodex-gate8-autonomous-video.mjs for offline Gate 8 live-action video acceptance against its signed task, provider, media-QA, lip-sync, hash, and package evidence.",
      requiresRealTraffic: false,
      blockedUntilExplicitUserApproval: false,
      highImpact: false,
    };
  }
  return null;
}

function selfTest() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "anticodex-release-gates-"));
  let gate5Supervisor = null;
  try {
    const cleanupIdentity = {
      child: { pid: 999999999 },
      snapshot: { processId: 999999999, creationDateUtc: "2026-08-09T00:00:00.0000000Z" },
    };
    let cleanupKillCalls = 0;
    const cleanupKillProcessTree = () => { cleanupKillCalls += 1; return { status: 0 }; };
    if (stopSelfTestSupervisor(cleanupIdentity, {
      queryProcess: () => ({ processId: cleanupIdentity.child.pid, creationDateUtc: "2026-08-09T00:00:01.0000000Z" }),
      killProcessTree: cleanupKillProcessTree,
    }) !== false || cleanupKillCalls !== 0) throw new Error("self-test supervisor cleanup accepted a reused PID identity");
    if (stopSelfTestSupervisor(cleanupIdentity, {
      queryProcess: () => cleanupIdentity.snapshot,
      killProcessTree: cleanupKillProcessTree,
    }) !== true || cleanupKillCalls !== 1) throw new Error("self-test supervisor cleanup rejected its captured process identity");
    const path = join(temporaryRoot, "latest-legacy-zero-hit.json");
    const valid = {
      reportName: "legacy-zero-hit",
      ok: true,
      noTraffic: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: true,
      checkedAt: new Date().toISOString(),
      legacyFilesExist: [],
      forbiddenImports: [],
      forbiddenBehaviors: [],
    };
    writeSignedJson(path, valid);
    const accepted = inspectEvidence({ id: "selfTestValid", path, signed: true, live: true, validate: validateLegacyZeroHit });
    if (!accepted.satisfied) throw new Error(`valid signed evidence rejected: ${accepted.semanticFailures.join(",")}`);
    const stalePath = join(temporaryRoot, "stale-signed-report.json");
    writeSignedJson(stalePath, { ...valid, checkedAt: new Date(Date.now() - 72 * 3_600_000).toISOString() });
    const stale = inspectEvidence({
      id: "selfTestStale",
      path: stalePath,
      signed: true,
      live: false,
      freshnessRequired: true,
      validate: validateLegacyZeroHit,
    });
    if (stale.fresh !== false || stale.satisfied) throw new Error("stale signed current-release evidence was accepted");
    const noTimestampPath = join(temporaryRoot, "signed-report-without-embedded-time.json");
    const { checkedAt: _discardedCheckedAt, ...withoutTimestamp } = valid;
    writeSignedJson(noTimestampPath, withoutTimestamp);
    const noTimestamp = inspectEvidence({
      id: "selfTestNoTimestamp",
      path: noTimestampPath,
      signed: true,
      live: false,
      freshnessRequired: true,
      validate: validateLegacyZeroHit,
    });
    if (noTimestamp.fresh !== false || noTimestamp.satisfied) throw new Error("current-release evidence without an embedded timestamp was accepted from filesystem mtime");
    writeFileSync(path, `${JSON.stringify({ ...valid, ok: false })}\n`, "utf8");
    const tampered = inspectEvidence({ id: "selfTestTampered", path, signed: true, live: true, validate: validateLegacyZeroHit });
    if (tampered.hashValid !== false || tampered.satisfied) throw new Error("tampered evidence was accepted");
    const sourceGitHead = "a".repeat(40);
    const sourcePreflightFixture = {
      reportName: "source-preflight",
      ok: true,
      noTraffic: true,
      usedRealTraffic: false,
      behaviorCovered: true,
      skipFullRegression: false,
      sourceGitHead,
      sourceGitClean: true,
      failures: [],
      checks: Object.fromEntries([
        "sourceGitRevision", "javascriptSyntax", "powershellSyntax", "uiStateSelfTest", "managerBridgeSelfTest",
        "localConnectorVerifier", "managerMojibakeContracts", "translatorRegression", "diffWhitespace",
      ].map((name) => [name, { ok: true }])),
    };
    sourcePreflightFixture.checks.sourceGitRevision.clean = true;
    const validSourceFailures = [];
    validateSourcePreflight(sourcePreflightFixture, validSourceFailures, { ok: true, head: sourceGitHead, clean: true });
    if (validSourceFailures.length > 0) throw new Error(`valid source preflight rejected: ${validSourceFailures.join(",")}`);
    for (const [name, candidate, gitState, expectedFailure] of [
      ["skipped regression", { ...sourcePreflightFixture, skipFullRegression: true }, { ok: true, head: sourceGitHead, clean: true }, "source_preflight_full_regression"],
      ["old revision", sourcePreflightFixture, { ok: true, head: "b".repeat(40), clean: true }, "source_preflight_git_revision"],
      ["dirty source at preflight generation", { ...sourcePreflightFixture, sourceGitClean: false }, { ok: true, head: sourceGitHead, clean: true }, "source_preflight_git_generated_dirty"],
      ["dirty source", sourcePreflightFixture, { ok: true, head: sourceGitHead, clean: false }, "source_preflight_git_dirty"],
    ]) {
      const failures = [];
      validateSourcePreflight(candidate, failures, gitState);
      if (!failures.includes(expectedFailure)) throw new Error(`source preflight accepted ${name}`);
    }
    const placeholderFailures = [];
    validateGate8({ schema: "anticodex-gate8-final-long-task-v1", reportName: "gate8-final-long-task", gate: 8, ok: true }, placeholderFailures);
    if (placeholderFailures.length < 6) throw new Error("Gate 8 placeholder was not rejected comprehensively");
    const releaseBinding = currentReleaseBinding();
    const gate5Checks = [
      "profile_menu_uses_exact_chinese_manager_label",
      "manager_close_full_height_actual_mouse",
      "live_tray_icon_preserved",
      "manager_protocol_physical_round_trip",
      "manager_actual_mouse_matrix",
      "frontend_model_hot_switch",
      "frontend_model_hot_switch_same_task",
      "frontend_model_hot_switch_zero_requests",
      "frontend_model_hot_switch_stable_processes",
      "shortcut_restore_single_window_no_blank_frames",
      "shortcut_restore_three_rounds",
      ...Array.from({ length: 10 }, (_, index) => `self_test_${index}`),
    ].map((id) => ({ id, ok: true }));
    const gate5TaskId = "019f9000-1111-7222-8333-444444444444";
    const gate5Switches = ["gemini", "claude", "third-party"].map((provider) => ({
      ok: true, provider, taskId: gate5TaskId, actualMouse: true,
      requestCountBefore: 7, requestCountAfter: 7, latestRequestRowIdBefore: 12, latestRequestRowIdAfter: 12,
      supervisorPidBefore: 101, supervisorPidAfter: 101,
      codexPlusPlusPidBefore: 102, codexPlusPlusPidAfter: 102,
      antiCodexMainPidBefore: 103, antiCodexMainPidAfter: 103,
      originalCodexAlive: true,
    }));
    const gate5RestoreRounds = [1, 2, 3].map(() => ({
      ok: true, expectedMainPid: 103, expectedOriginalCodexPid: 201,
      minimizedObserved: true, restoredAtMs: 900,
      maxRootProcessCount: 1, maxVisibleWindowCount: 1, maxAppPageCount: 1, appPagesAfter: 1,
      blankFrameCount: 0, frameCount: 3, originalCodexAlive: true,
      after: { rootProcessIds: [103], visibleWindowProcessIds: [103] },
    }));
    const gate5ManagerContracts = Object.fromEntries(managerActions.map((action) => {
      const expected = managerHandlerContractByAction[action];
      return [action, { verified: true, kind: expected[0], source: expected[1], handler: expected[2] }];
    }));
    const gate5ManagerFiles = [...new Set(["scripts/start-anticodex-fixed-route.mjs", ...Object.values(gate5ManagerContracts).flatMap((entry) => [
      entry.source, String(entry.handler).endsWith(".ps1") ? `scripts/${entry.handler}` : "",
    ])].filter(Boolean))];
    const gate5RuntimeRoot = join(temporaryRoot, "runtime");
    mkdirSync(join(gate5RuntimeRoot, "scripts"), { recursive: true });
    const gate5RuntimeFiles = gate5ManagerFiles.map((relativePath) => {
      const bytes = readFileSync(resolve(sourceRoot, relativePath));
      const runtimePath = resolve(gate5RuntimeRoot, relativePath);
      mkdirSync(dirname(runtimePath), { recursive: true });
      writeFileSync(runtimePath, bytes);
      const fileSha256 = sha256Buffer(bytes);
      return { relativePath, fileSha256, manifestSha256: fileSha256 };
    });
    const gate5SourceHead = currentSourceGitState().head;
    const gate5ManifestPath = join(gate5RuntimeRoot, ".anticodex-runtime-manifest.json");
    writeFileSync(gate5ManifestPath, `${JSON.stringify({
      schema: "anticodex-runtime-manifest-v2", state: "validated", activeRuntime: gate5RuntimeRoot,
      sourceRoot, sourceGitHead: gate5SourceHead, sourceGitClean: true, sourceRevisionProvenance: "git",
      files: Object.fromEntries(gate5RuntimeFiles.map((entry) => [entry.relativePath.replaceAll("/", "\\"), entry.fileSha256])),
    }, null, 2)}\n`, "utf8");
    gate5Supervisor = startSuspendedSelfTestSupervisor(join(gate5RuntimeRoot, "scripts", "start-anticodex-fixed-route.mjs"));
    const gate5SupervisorPid = gate5Supervisor.child.pid;
    for (const entry of gate5Switches) {
      entry.supervisorPidBefore = gate5SupervisorPid;
      entry.supervisorPidAfter = gate5SupervisorPid;
    }
    const gate5Fixture = {
      schema: "anticodex-gate5-visible-integration-v1",
      gate: 5,
      ok: true,
      gateComplete: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      sourceEvidenceUsedRealTraffic: true,
      coverageKind: "current-release-explicit-evidence-aggregate",
      task: {
        taskId: gate5TaskId, newTask: true, nativeTask: true,
        promptSubmissionCount: 1, totalGoalPromptCount: 1, hostIntermediatePromptCount: 0,
      },
      route: { provider: "antigravity", relayProtocol: "chatCompletions", codexPlusPlusVersion: expectedCodexPlusPlusVersion },
      releaseBinding,
      artifactEvidence: Array.from({ length: 3 }, (_, index) => ({
        path: join(temporaryRoot, `missing-${index}.txt`),
        bytes: 1,
        ok: true,
        expectedHash: "a".repeat(64),
        actualHash: "a".repeat(64),
      })),
      currentUiEvidence: {
        manager_actual_mouse_matrix: {
          ok: true, usedRealTraffic: false, actualMouse: true, actionCount: 20, zeroSideEffects: true,
          uiInteraction: {
            scope: "ui-interaction-only", verifiedActionIds: [...managerActions], verifiedCount: managerActions.length,
          },
          handlerVerification: {
            offlineContractVerifiedActionIds: [...managerActions], safeRealActionIds: [...safeRealManagerActions],
            realExecutedActionIds: [], pendingAuthorizedActionIds: [...highImpactManagerActions], allFunctionsVerified: false,
            contracts: gate5ManagerContracts,
            provenance: {
              schema: "anticodex-manager-handler-provenance-v1", verified: true,
              runtimeRoot: gate5RuntimeRoot, scriptsRoot: join(gate5RuntimeRoot, "scripts"), manifestPath: gate5ManifestPath,
              manifestSha256: sha256File(gate5ManifestPath), sourceRoot, sourceGitHead: gate5SourceHead,
              sourceGitClean: true, sourceRevisionProvenance: "git", files: gate5RuntimeFiles,
              taskRuntimePid: gate5SupervisorPid,
              taskRuntimeScriptPath: join(gate5RuntimeRoot, "scripts", "start-anticodex-fixed-route.mjs"),
              taskRuntimeCreationDateUtc: gate5Supervisor.snapshot.creationDateUtc,
            },
          },
          profileEntryText: "管理", forbiddenEnglishVisible: false, trayIconPreserved: true,
          closeUpper: true, closeCenter: true, closeLower: true, closeHasTextNode: false,
          closeProbes: ["upper-center", "center", "lower-center"].map((name) => ({ name, ok: true, actualMouse: true, closed: true, hasTextNode: false })),
          protocolInteraction: {
            before: "chatCompletions", alternate: "responses", restored: "chatCompletions",
            selectedAlternate: true, restoredOriginal: true, profileUnchanged: true,
          },
          runtimeIdentity: { supervisorPid: gate5SupervisorPid },
        },
        frontend_model_hot_switch: {
          ok: true, usedRealTraffic: false, sameTask: true, taskId: gate5TaskId,
          noRestart: true, requestCountUnchanged: true, pidUnchanged: true, switchCount: 3,
          providers: ["gemini", "claude", "third-party"], originalCodexAlive: true, switches: gate5Switches,
        },
        shortcut_restore_single_window_no_blank_frames: {
          ok: true, usedRealTraffic: false, sameMainPid: true, mainPid: 103, roundCount: 3,
          maxRootProcessCount: 1, maxVisibleWindowCount: 1, maxAppPageCount: 1,
          blankFrameCount: 0, originalCodexAlive: true, rounds: gate5RestoreRounds,
        },
      },
      checks: gate5Checks,
    };
    const missingArtifactFailures = [];
    validateGate5(gate5Fixture, missingArtifactFailures);
    if (!missingArtifactFailures.includes("gate5_artifact_file_missing")) throw new Error("Gate 5 accepted deleted artifact files");
    const missingUiFailures = [];
    validateGate5({ ...gate5Fixture, currentUiEvidence: {} }, missingUiFailures);
    if (!["gate5_current_ui_manager_actual_mouse_matrix", "gate5_current_ui_frontend_model_hot_switch", "gate5_current_ui_shortcut_restore_single_window_no_blank_frames"]
      .every((failure) => missingUiFailures.includes(failure))) throw new Error("Gate 5 accepted missing current UI evidence");
    const validUiFailures = [];
    validateGate5CurrentUiEvidence(gate5Fixture, validUiFailures);
    if (validUiFailures.length > 0) throw new Error(`valid Gate 5 UI evidence was rejected: ${validUiFailures.join(",")}`);
    const expectUiFailure = (mutate, expectedFailure, message) => {
      const candidate = structuredClone(gate5Fixture);
      mutate(candidate.currentUiEvidence);
      const candidateFailures = [];
      validateGate5CurrentUiEvidence(candidate, candidateFailures);
      if (!candidateFailures.includes(expectedFailure)) throw new Error(message);
    };
    expectUiFailure((ui) => { ui.manager_actual_mouse_matrix.protocolInteraction.restored = "responses"; }, "gate5_current_ui_manager_actual_mouse_matrix", "Gate 5 accepted an unrestored protocol");
    expectUiFailure((ui) => { ui.manager_actual_mouse_matrix.protocolInteraction.profileUnchanged = false; }, "gate5_current_ui_manager_actual_mouse_matrix", "Gate 5 accepted a changed profile");
    expectUiFailure((ui) => { ui.manager_actual_mouse_matrix.handlerVerification.provenance.runtimeRoot = join(temporaryRoot, "wrong-runtime"); }, "gate5_current_ui_manager_actual_mouse_matrix", "Gate 5 accepted Manager handler evidence from the wrong runtime root");
    expectUiFailure((ui) => { ui.manager_actual_mouse_matrix.handlerVerification.provenance.taskRuntimePid = 999; }, "gate5_current_ui_manager_actual_mouse_matrix", "Gate 5 accepted Manager handler evidence from a different supervisor PID");
    expectUiFailure((ui) => { ui.manager_actual_mouse_matrix.handlerVerification.provenance.taskRuntimeCreationDateUtc = "2020-01-01T00:00:00.0000000Z"; }, "gate5_current_ui_manager_actual_mouse_matrix", "Gate 5 accepted a reused supervisor PID");
    expectUiFailure((ui) => { ui.manager_actual_mouse_matrix.handlerVerification.provenance.files[0].fileSha256 = "f".repeat(64); }, "gate5_current_ui_manager_actual_mouse_matrix", "Gate 5 accepted a stale Manager handler file hash");
    expectUiFailure((ui) => { ui.frontend_model_hot_switch.switches[1].requestCountAfter += 1; }, "gate5_current_ui_frontend_model_hot_switch", "Gate 5 accepted model traffic during a switch");
    expectUiFailure((ui) => { ui.frontend_model_hot_switch.switches[1].antiCodexMainPidAfter += 1; }, "gate5_current_ui_frontend_model_hot_switch", "Gate 5 accepted a client restart during a switch");
    expectUiFailure((ui) => { ui.frontend_model_hot_switch.switches[1].taskId = "019f9000-1111-7222-8333-555555555555"; }, "gate5_current_ui_frontend_model_hot_switch", "Gate 5 accepted a switch in another task");
    expectUiFailure((ui) => { ui.shortcut_restore_single_window_no_blank_frames.rounds.pop(); }, "gate5_current_ui_shortcut_restore_single_window_no_blank_frames", "Gate 5 accepted fewer than three restore rounds");
    expectUiFailure((ui) => { ui.shortcut_restore_single_window_no_blank_frames.rounds[1].blankFrameCount = 1; }, "gate5_current_ui_shortcut_restore_single_window_no_blank_frames", "Gate 5 accepted a blank restore frame");
    expectUiFailure((ui) => { ui.shortcut_restore_single_window_no_blank_frames.rounds[1].maxVisibleWindowCount = 2; }, "gate5_current_ui_shortcut_restore_single_window_no_blank_frames", "Gate 5 accepted a second visible window");
    const gate8ArtifactFailures = [];
    validateGate8({
      schema: "anticodex-gate8-final-long-task-v1",
      reportName: "gate8-final-long-task",
      gate: 8,
      artifacts: Array.from({ length: 5 }, (_, index) => ({
        path: join(temporaryRoot, `missing-gate8-${index}.txt`), exists: true, bytes: 1, sha256: "b".repeat(64),
      })),
      evidence: {
        releasePrecondition: { releaseBinding },
        routeBefore: { component: { version: "0.0.0", patchCommit: "0".repeat(40), binarySha256: "0".repeat(64) } },
        routeAfter: { component: { version: "0.0.0", patchCommit: "0".repeat(40), binarySha256: "0".repeat(64) } },
      },
    }, gate8ArtifactFailures);
    if (!gate8ArtifactFailures.includes("gate8_artifact_file_missing")) throw new Error("Gate 8 accepted deleted artifact files");
    if (!gate8ArtifactFailures.includes("gate8_release_binding")) throw new Error("Gate 8 accepted an old component binding");
    const formalAction = gate8NextAction(["formalLongTask"]);
    if (!/one native autonomous task/i.test(formalAction?.command || "")
      || !/live-action video acceptance/i.test(formalAction?.command || "")
      || formalAction?.requiresRealTraffic !== false) {
      throw new Error("Gate 8 autonomous-video action is missing or can start model traffic");
    }
    console.log(JSON.stringify({ ok: true, selfTest: true, checks: [
      "signed_evidence_acceptance",
      "stale_signed_evidence_rejection",
      "filesystem_mtime_freshness_rejection",
      "tamper_rejection",
      "source_preflight_full_current_revision",
      "gate5_deleted_artifact_rejection",
      "gate5_current_ui_evidence_required",
      "gate5_current_ui_deep_validation",
      "gate8_result_semantics",
      "gate8_deleted_artifact_rejection",
      "gate8_current_component_binding",
      "gate8_autonomous_video_semantics",
      "self_test_supervisor_pid_reuse_guard",
    ] }));
  } finally {
    stopSelfTestSupervisor(gate5Supervisor);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (args.has("--self-test")) {
  selfTest();
  process.exit(0);
}

const gates = [...gateDefinitions.map(makeGate), makeGate7(), makeGate8()];
const missingRequired = gates.filter((gate) => gate.requiredForRelease && !gate.satisfied).map((gate) => gate.id);
const missingShort = gates.filter((gate) => gate.requiredForShort && !gate.satisfied).map((gate) => gate.id);
const damagedReports = gates.filter((gate) => gate.present && (!gate.parseable || gate.hashValid !== true)).map((gate) => gate.id);
const completedGates = gates.filter((gate) => gate.satisfied).map((gate) => gate.id);
const shortReady = missingShort.length === 0;
const releaseReady = missingRequired.length === 0 && damagedReports.length === 0;
const currentGate = gates.find((gate) => !gate.satisfied)?.id || "complete";
const gate5 = gates.find((gate) => gate.id === "gate5");
const gate7 = gates.find((gate) => gate.id === "gate7");
const gate8 = gates.find((gate) => gate.id === "gate8");
const nextActions = [];
if (!gate7.satisfied) {
  nextActions.push({
    id: "completeGate7",
    phase: "release",
    command: "Run current source, sync-readiness, installed-overall and legacy-zero-hit verification after the single controlled runtime sync.",
    requiresRealTraffic: false,
    highImpact: false,
  });
} else if (!gate5.satisfied) {
  nextActions.push({
    id: "refreshGate5",
    phase: "integration",
    command: "Generate one fresh signed Gate 5 aggregate bound to the current shell/component and include Manager actual-mouse, same-task model hot-switch, and single-window shortcut-restore evidence.",
    requiresRealTraffic: true,
    highImpact: true,
  });
} else if (!gate8.satisfied) {
  const action = gate8NextAction(gate8.missingEvidence);
  if (action) nextActions.push(action);
}

const releaseGateFailureReasons = gates.filter((gate) => !gate.satisfied).map((gate) => ({
  id: gate.id,
  group: gate.group,
  requiredForRelease: gate.requiredForRelease,
  requiredForShort: gate.requiredForShort,
  failureReason: gate.present ? (gate.semanticFailures.length ? "semantic_failure" : gate.fresh ? "report_invalid" : "stale_report") : "missing_report",
  failureReasons: gate.semanticFailures,
  ageHours: gate.ageHours,
  fresh: gate.fresh,
  selectedKind: gate.selectedKind,
  selectedFile: gate.selectedFile,
  selectedMtime: gate.selectedMtime,
  reportFailureSamples: gate.reportFailureSamples,
  guidance: gate.id === "gate8"
    ? "Gate 8 requires one new native autonomous task, one total-goal prompt, current provider/component receipts, and hashed live-action video, subtitle, audio, lip-sync, media-QA, and release-package evidence."
    : gate.id === "gate5"
      ? "Gate 5 requires a fresh current-release aggregate with real UI mouse, model hot-switch, and shortcut restore evidence."
      : "Refresh only the current three-layer evidence for this gate.",
  orderedActions: nextActions.filter((action) => action.id === (gate.id === "gate8" ? "runGate8" : gate.id === "gate5" ? "refreshGate5" : "completeGate7")),
}));

const groups = Object.fromEntries([...new Set(gates.map((gate) => gate.group))].map((group) => {
  const members = gates.filter((gate) => gate.group === group);
  return [group, {
    total: members.length,
    satisfied: members.filter((gate) => gate.satisfied).length,
    required: members.length,
    requiredSatisfied: members.filter((gate) => gate.satisfied).length,
    optional: 0,
    optionalSatisfied: 0,
    missingRequired: members.filter((gate) => !gate.satisfied).map((gate) => gate.id),
    missingOptional: [],
  }];
}));
const releaseGateGroups = Object.entries(groups).map(([group, value]) => ({ group, ...value }));

const payload = {
  schema: "anticodex-release-gates-v3",
  reportName: "release-gates",
  generatedAt: new Date().toISOString(),
  ok: strict ? releaseReady : true,
  architecture: "official-codex-copy -> CodexPlusPlus -> optional Antigravity Chat adapter",
  shellProgress: releaseReady ? 100 : gate7.satisfied ? 99 : 88,
  codexPlusPlusProgress: releaseReady ? 100 : gate7.satisfied ? 99 : 94,
  antigravityAdapterProgress: releaseReady ? 100 : gate7.satisfied ? 99 : 94,
  overallProgress: releaseReady ? 100 : gate7.satisfied ? 97 : 90,
  completedGates,
  currentGate,
  releaseReady,
  releaseBinding: currentReleaseBinding(),
  shortReady,
  releaseBlockedOnlyByRequiredRealTraffic: missingRequired.length === 1 && missingRequired[0] === "gate8",
  requiredRealTrafficBlockedGates: missingRequired.filter((gate) => ["gate5", "gate8"].includes(gate)),
  strict,
  strictOptionalRealTraffic: false,
  optionalRealTrafficReady: true,
  optionalRealTrafficFailures: [],
  reportRoot,
  sourceRoot,
  maxAgeHours,
  elapsedMs: Date.now() - startedAt,
  missingRequired,
  missingShort,
  missingOptional: [],
  damagedReports,
  releaseGateFailures: releaseGateFailureReasons.filter((gate) => gate.failureReasons.length > 0),
  releaseGateFailureReasons,
  releaseGateGroups,
  releaseGateSelectedReports: [],
  nextActions,
  nextActionsAvailableCount: nextActions.length,
  nextActionsHiddenCount: 0,
  nextActionsTruncated: false,
  approvalPlan: {
    requiredActionCount: nextActions.length,
    realTrafficActionCount: nextActions.filter((action) => action.requiresRealTraffic).length,
    highImpactActionCount: nextActions.filter((action) => action.highImpact).length,
  },
  groups,
  gates,
};

mkdirSync(reportRoot, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
writeSignedJson(join(reportRoot, "latest-release-gates.json"), payload);
writeSignedJson(join(reportRoot, `${stamp}-release-gates.json`), payload);

process.stdout.write(JSON.stringify(compactOutput ? compactStatus(payload) : payload));
if (strict && !releaseReady) process.exitCode = 1;
