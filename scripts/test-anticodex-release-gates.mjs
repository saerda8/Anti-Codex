#!/usr/bin/env node
import { createHash } from "node:crypto";
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
import { validateGate8MultiStyleReport } from "./lib/anticodex-gate8-evidence.mjs";

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
  --max-age-hours <n>     Maximum age for live Gate 7 evidence (default: 48)
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

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

const codexPlusPlusMetadata = readJson(join(sourceRoot, "third_party", "codexplusplus", "upstream.json"));
const expectedCodexPlusPlusPatchCommit = String(codexPlusPlusMetadata?.patchCommit || "");
if (!/^[0-9a-f]{40}$/.test(expectedCodexPlusPlusPatchCommit)) {
  throw new Error("Pinned CodexPlusPlus patch commit is missing or invalid.");
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

function reportTimestampMs(report, path) {
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
  return statSync(path).mtimeMs;
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

  const ageHours = parseable ? Math.max(0, (Date.now() - reportTimestampMs(report, path)) / 3_600_000) : null;
  const fresh = definition.live !== true || (Number.isFinite(ageHours) && ageHours <= maxAgeHours);
  const semanticFailures = [];
  if (parseable) definition.validate(report, semanticFailures);
  const satisfied = present && parseable && hash.valid === true && fresh && semanticFailures.length === 0;
  return {
    id: definition.id,
    path,
    selectedFile: basename(path),
    selectedKind: definition.live === true ? "latest" : definition.signed === true ? "signed-retained" : "tracked-audit",
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
  checkArray(report, 20, ["original_processes_unchanged", "stable_original_state_unchanged_after_cleanup"], failures, "gate1");
}

function validateGate2(report, failures) {
  if (report?.schemaVersion !== 1 || report?.gate !== "Gate 2 deterministic third-party provider route") failures.push("gate2_schema");
  if (report?.ok !== true || report?.modelTraffic !== "loopback fake provider only") failures.push("gate2_result");
  checkArray(report, 27, ["native_codex_cli_exact_tool_result_returned", "protocol_proxy_upstream_cancellation_before_headers", "original_stable_state_unchanged"], failures, "gate2");
}

function validateGate3(report, failures) {
  if (report?.schemaVersion !== 1 || report?.gate !== "Gate 3 thin Antigravity Chat adapter contract") failures.push("gate3_schema");
  if (report?.ok !== true || !empty(report?.failedIds)) failures.push("gate3_result");
  if (report?.realTraffic?.ok !== true || report?.realTraffic?.exactArguments !== true || report?.realTraffic?.exactToolResultObserved !== true) failures.push("gate3_real_result");
  if (report?.realTraffic?.counters?.start !== 1 || report?.realTraffic?.counters?.resume !== 1) failures.push("gate3_continuation");
  if (!Array.isArray(report?.providerSources) || report.providerSources.length !== 4 || report.providerSources.some((source) => source?.forbiddenImport || source?.forbiddenSemantics)) failures.push("gate3_provider_boundary");
  checkArray(report, 7, ["legacy_import_zero_hit", "task_semantics_zero_hit", "real_native_tool_round_trip"], failures, "gate3");
}

function validateGate4(report, failures) {
  if (report?.schemaVersion !== 1 || report?.gate !== "Gate 4 isolated CodexPlusPlus to Antigravity route switch") failures.push("gate4_schema");
  if (report?.ok !== true || report?.cli?.exitCode !== 0 || report?.cli?.fileChangeEventCount !== 1) failures.push("gate4_result");
  if (report?.counters?.start !== 1 || report?.counters?.resume !== 1) failures.push("gate4_continuation");
  if (JSON.stringify(report?.oldRoute?.before) !== JSON.stringify(report?.oldRoute?.after)) failures.push("gate4_old_route_changed");
  checkArray(report, 23, ["old_mixed_route_received_zero_requests", "provider_exact_single_tool_continuation", "temporary_artifacts_removed"], failures, "gate4");
}

function validateGate5(report, failures) {
  if (report?.schema !== "anticodex-gate5-visible-integration-v1" || report?.gate !== 5) failures.push("gate5_schema");
  if (report?.ok !== true || report?.gateComplete !== true || report?.sourceEvidenceUsedRealTraffic !== true) failures.push("gate5_result");
  if (report?.route?.provider !== "antigravity" || report?.route?.relayProtocol !== "chatCompletions") failures.push("gate5_route");
  if (!Array.isArray(report?.artifactEvidence) || report.artifactEvidence.length < 3 || report.artifactEvidence.some((artifact) => artifact?.ok !== true || artifact?.actualHash !== artifact?.expectedHash)) failures.push("gate5_artifacts");
  checkArray(report, 13, ["profile_menu_uses_exact_chinese_manager_label", "manager_close_full_height_actual_mouse", "live_tray_icon_preserved"], failures, "gate5");
}

function validateGate6(report, failures) {
  if (report?.schemaVersion !== 1 || report?.gate !== "Gate 6 edge and recovery matrix") failures.push("gate6_schema");
  if (report?.ok !== true || report?.formalGateAdvanced !== true || !empty(report?.failedIds)) failures.push("gate6_result");
  checkArray(report, 14, ["deterministic_quota_no_retry", "deterministic_restart_no_replay", "real_client_abort_cancel_and_recover", "real_copied_client_crash_same_task_resume"], failures, "gate6");
}

function validateLegacyZeroHit(report, failures) {
  if (report?.reportName !== "legacy-zero-hit" || report?.ok !== true || report?.noTraffic !== true || report?.usedRealTraffic !== false) failures.push("legacy_zero_hit_result");
  for (const field of ["legacyFilesExist", "forbiddenImports", "forbiddenBehaviors"]) {
    if (!empty(report?.[field])) failures.push(`legacy_zero_hit_${field}`);
  }
}

function validateSourcePreflight(report, failures) {
  if (report?.reportName !== "source-preflight" || report?.ok !== true || report?.noTraffic !== true || report?.usedRealTraffic !== false || report?.behaviorCovered !== true) failures.push("source_preflight_result");
  if (!empty(report?.failures)) failures.push("source_preflight_failures");
  checkObjectOk(report, ["javascriptSyntax", "powershellSyntax", "uiStateSelfTest", "managerBridgeSelfTest", "localConnectorVerifier", "managerMojibakeContracts", "translatorRegression", "diffWhitespace"], failures, "source_preflight");
}

function validateSyncReadiness(report, failures) {
  if (report?.reportName !== "sync-readiness" || report?.ok !== true || report?.noTraffic !== true || report?.usedRealTraffic !== false) failures.push("sync_readiness_result");
  if (!empty(report?.failures)) failures.push("sync_readiness_failures");
  const contract = report?.clientSyncContract;
  if (contract?.mode !== "codex-client-copy-plus-anticodex-patches" || contract?.nativeClientBehaviorCarriedByHostSync !== true || contract?.forbidsFeatureByFeatureReimplementation !== true || contract?.sourceHostHashMatches !== true || contract?.sourceCliHashMatches !== true) failures.push("sync_readiness_client_contract");
  const expectedPatchScope = ["branding", "icons", "shortcuts", "isolation", "launcher", "model-adapter"];
  if (JSON.stringify(contract?.antiCodexPatchScope) !== JSON.stringify(expectedPatchScope)) failures.push("sync_readiness_patch_scope");
  if (report?.activeHost?.manifestValid !== true || report?.activeHost?.productName !== "Anti-Codex" || report?.activeHost?.trayIconPalette?.ok !== true) failures.push("sync_readiness_active_host");
  const sync = report?.sync;
  if (sync?.scriptExists !== true || sync?.launcherExists !== true || sync?.rollbackScriptExists !== true || sync?.rollbackLauncherExists !== true || sync?.updateCheckExists !== true) failures.push("sync_readiness_entrypoints");
  if (sync?.updateStatus?.ok !== true || sync?.updateStatus?.guardrails?.brandPreserved !== true || sync?.updateStatus?.guardrails?.rollbackOnFailure !== true) failures.push("sync_readiness_update_status");
  if (["failed", "running"].includes(String(sync?.updateStatus?.operation?.state || "").toLowerCase())) failures.push("sync_readiness_operation_state");
  if (sync?.rollbackHost?.manifestValid !== true || sync?.rollbackHost?.productName !== "Anti-Codex" || sync?.rollbackHost?.trayIconPalette?.ok !== true) failures.push("sync_readiness_rollback_host");
  if (sync?.hostSyncMarkerExists !== false || sync?.staleCandidateExists !== false || sync?.rollbackSwapHostExists !== false || sync?.rollbackSwapMarkerExists !== false) failures.push("sync_readiness_stale_state");
}

function validateInstalledOverall(report, failures) {
  if (report?.reportName !== "installed-overall" || report?.ok !== true || report?.noTraffic !== true || report?.usedRealTraffic !== false || report?.coverageKind !== "fixed-three-layer-installed-no-traffic") failures.push("installed_overall_result");
  if (!empty(report?.failures)) failures.push("installed_overall_failures");
  if (report?.health?.schema !== "anticodex-fixed-route-status-v1" || report?.health?.state !== "ready" || !["antigravity", "third-party"].includes(report?.health?.provider)) failures.push("installed_overall_health");
  checkObjectOk(report, ["managerHealth", "fixedRouteHealth", "runtimeFiles", "codexPlusPlusComponent", "processOwnership", "stateIsolation", "branding", "rollbackCheckpoint", "legacyZeroHit", "modelCatalog", "uiState"], failures, "installed_overall");
}

function validateGate8(report, failures) {
  if (report?.schema !== "anticodex-gate8-final-long-task-v1" || report?.reportName !== "gate8-final-long-task" || report?.gate !== 8) failures.push("gate8_schema");
  if (report?.ok !== true || report?.gateComplete !== true || report?.requestedRealTraffic !== true || report?.usedRealTraffic !== true || report?.resultBasedVerification !== true) failures.push("gate8_result");
  if (report?.preflight?.accountReady !== true || report?.preflight?.selectedModelPresent !== true || report?.preflight?.quotaProbeReady !== true) failures.push("gate8_preflight");
  if (report?.route?.fixed !== true || report?.route?.provider !== "antigravity" || report?.route?.relayProtocol !== "chatCompletions" || report?.route?.oldRouteHits !== 0) failures.push("gate8_route");
  if (!Array.isArray(report?.artifacts) || report.artifacts.length < 5 || report.artifacts.some((artifact) => artifact?.exists !== true || !/^[a-f0-9]{64}$/i.test(String(artifact?.sha256 || "")) || Number(artifact?.bytes) <= 0)) failures.push("gate8_artifacts");
  if (!Array.isArray(report?.tests) || report.tests.length < 2 || report.tests.some((test) => test?.passed !== true || test?.exitCode !== 0)) failures.push("gate8_tests");
  if (Number(report?.interaction?.editRounds) < 3
    || Number(report?.interaction?.dialogueTurns) < 8
    || Number(report?.interaction?.passedDialogueTurns) < 8
    || Number(report?.interaction?.userCorrections) < 1
    || Number(report?.interaction?.progressUpdates) < 3
    || Number(report?.interaction?.toolCalls) < 5
    || Number(report?.interaction?.unexpectedLaunchCommands) !== 0
    || Number(report?.interaction?.postFinalToolCalls) !== 0
    || Number(report?.interaction?.postFinalToolOutputs) !== 0
    || Number(report?.interaction?.duplicateCommands) !== 0
    || Number(report?.interaction?.evidencedTurns) < 8
    || Number(report?.interaction?.modelProvenTurns) < 8
    || Number(report?.interaction?.preCommandExplanations) < 8
    || Number(report?.interaction?.nonEmptyToolResults) < 8
    || report?.interaction?.turnContractsPassed !== true) failures.push("gate8_interaction_depth");
  if (report?.continuity?.longContextReached !== true || report?.continuity?.compactionTriggered !== true || report?.continuity?.resumedSameTask !== true || report?.continuity?.historyReopened !== true) failures.push("gate8_continuity");
  if (report?.recovery?.edgeInjected !== true || report?.recovery?.recovered !== true || report?.recovery?.noDuplicateExecution !== true || Number(report?.recovery?.staleConflictCount) !== 0) failures.push("gate8_recovery");
  if (report?.processes?.oneVisibleAntiCodex !== true || report?.processes?.oneFixedRouteSupervisor !== true || report?.processes?.originalCodexUnchanged !== true || report?.processes?.legacyProcessCount !== 0) failures.push("gate8_processes");
  if (!empty(report?.failures)) failures.push("gate8_failures");
}

function validateGate8MultiStyle(report, failures) {
  failures.push(...validateGate8MultiStyleReport(report));
}

const gateDefinitions = [
  { id: "gate1", number: 1, name: "CodexPlusPlus isolation compatibility", group: "architecture", signed: false, live: false, path: join(sourceRoot, "docs", "audits", "2026-07-14-codexplusplus-runtime-isolation.json"), validate: validateGate1 },
  { id: "gate2", number: 2, name: "Deterministic third-party provider route", group: "architecture", signed: false, live: false, path: join(sourceRoot, "docs", "audits", "2026-07-14-codexplusplus-third-party-route.json"), validate: validateGate2 },
  { id: "gate3", number: 3, name: "Thin Antigravity Chat adapter", group: "architecture", signed: false, live: false, path: join(sourceRoot, "docs", "audits", "2026-07-14-antigravity-chat-adapter-contract.json"), validate: validateGate3 },
  { id: "gate4", number: 4, name: "Isolated fixed-route switch", group: "architecture", signed: false, live: false, path: join(sourceRoot, "docs", "audits", "2026-07-14-gate4-isolated-route-switch.json"), validate: validateGate4 },
  { id: "gate5", number: 5, name: "Visible copied-client integration", group: "integration", signed: true, live: false, path: join(sourceRoot, "docs", "audits", "2026-07-15-gate5-visible-integration.json"), validate: validateGate5 },
  { id: "gate6", number: 6, name: "Bounded edge and recovery matrix", group: "integration", signed: true, live: false, path: join(sourceRoot, "docs", "audits", "2026-07-15-gate6-edge-matrix.json"), validate: validateGate6 },
];

const gate7Definitions = [
  { id: "legacyZeroHit", signed: true, live: true, path: join(reportRoot, "latest-legacy-zero-hit.json"), validate: validateLegacyZeroHit },
  { id: "sourcePreflight", signed: true, live: true, path: join(reportRoot, "latest-source-preflight.json"), validate: validateSourcePreflight },
  { id: "syncReadiness", signed: true, live: true, path: join(reportRoot, "latest-sync-readiness.json"), validate: validateSyncReadiness },
  { id: "installedOverall", signed: true, live: true, path: join(reportRoot, "latest-installed-overall.json"), validate: validateInstalledOverall },
];

const gate8Definitions = [
  { id: "formalLongTask", signed: true, live: false, path: join(reportRoot, "latest-gate8-final-long-task.json"), validate: validateGate8 },
  { id: "multiStyleLongTasks", signed: true, live: false, path: join(reportRoot, "latest-ui-human-long-journey.json"), validate: validateGate8MultiStyle },
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
      command: "Run the formal inventory Gate 8; after it passes, run the locked combined interrupted-migration and greenfield-project journeys.",
      requiresRealTraffic: true,
      blockedUntilExplicitUserApproval: false,
      highImpact: true,
    };
  }
  if (missingEvidence.includes("multiStyleLongTasks")) {
    return {
      id: "runGate8",
      phase: "acceptance-multi-style",
      command: "Do not repeat the formal inventory run. Run only the locked combined interrupted-migration and greenfield-project journeys.",
      requiresRealTraffic: true,
      blockedUntilExplicitUserApproval: false,
      highImpact: true,
    };
  }
  return null;
}

function selfTest() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "anticodex-release-gates-"));
  try {
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
    writeFileSync(path, `${JSON.stringify({ ...valid, ok: false })}\n`, "utf8");
    const tampered = inspectEvidence({ id: "selfTestTampered", path, signed: true, live: true, validate: validateLegacyZeroHit });
    if (tampered.hashValid !== false || tampered.satisfied) throw new Error("tampered evidence was accepted");
    const placeholderFailures = [];
    validateGate8({ schema: "anticodex-gate8-final-long-task-v1", reportName: "gate8-final-long-task", gate: 8, ok: true }, placeholderFailures);
    if (placeholderFailures.length < 6) throw new Error("Gate 8 placeholder was not rejected comprehensively");
    const multiStylePlaceholderFailures = validateGate8MultiStyleReport({ reportName: "ui-human-long-journey", ok: true });
    if (multiStylePlaceholderFailures.length < 6) throw new Error("Gate 8 multi-style placeholder was not rejected comprehensively");
    const formalAction = gate8NextAction(["formalLongTask", "multiStyleLongTasks"]);
    const multiOnlyAction = gate8NextAction(["multiStyleLongTasks"]);
    if (!/formal inventory/i.test(formalAction?.command || "")) throw new Error("Gate 8 formal action is missing");
    if (!/Do not repeat the formal inventory/i.test(multiOnlyAction?.command || "")) throw new Error("Gate 8 multi-style action can replay the formal task");
    console.log(JSON.stringify({ ok: true, selfTest: true, checks: ["signed_evidence_acceptance", "tamper_rejection", "gate8_result_semantics", "gate8_multi_style_semantics"] }));
  } finally {
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
  guidance: gate.id === "gate8" ? "Gate 8 requires the formal inventory project plus result-proven migration and greenfield journeys, not response-text smoke." : "Refresh only the current three-layer evidence for this gate.",
  orderedActions: nextActions.filter((action) => action.id === (gate.id === "gate8" ? "runGate8" : "completeGate7")),
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
  shellProgress: gate7.satisfied ? 100 : 88,
  codexPlusPlusProgress: gate7.satisfied ? 100 : 94,
  antigravityAdapterProgress: gate7.satisfied ? 100 : 94,
  overallProgress: releaseReady ? 100 : gate7.satisfied ? 97 : 90,
  completedGates,
  currentGate,
  releaseReady,
  shortReady,
  releaseBlockedOnlyByRequiredRealTraffic: gate7.satisfied && !gate8.satisfied,
  requiredRealTrafficBlockedGates: gate7.satisfied && !gate8.satisfied ? ["gate8"] : [],
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
