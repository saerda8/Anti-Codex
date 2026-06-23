#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(arg, next);
    i += 1;
  } else {
    args.set(arg, true);
  }
}

let reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || ".", "anticodex", "reports"));
const maxAgeHours = Number(args.get("--max-age-hours") || 48);
const strict = args.has("--strict");
const strictOptionalRealTraffic = args.has("--strict-optional-real-traffic");
const startedAt = Date.now();
function currentSourceRoot() {
  return resolve(args.get("--source-root") || join(dirname(fileURLToPath(import.meta.url)), ".."));
}

function currentTargetRuntime() {
  return resolve(args.get("--target-runtime") || join(process.env.LOCALAPPDATA || ".", "Anti-Codex", "runtime"));
}

const runtimeSyncFiles = [
  "scripts/start-deepcodex.ps1",
  "scripts/anticodex-manager-bridge.mjs",
  "scripts/anticodex-manager-inject.js",
  "scripts/anticodex-report-io.ps1",
  "scripts/collect-anticodex-diagnostics.ps1",
  "scripts/protect-anticodex-log-db.mjs",
  "scripts/refresh-anticodex-local-features.ps1",
  "scripts/resolve-anticodex-base-url.ps1",
  "scripts/summarize-anticodex-report.mjs",
  "scripts/test-anticodex-account-proxy-readiness.ps1",
  "scripts/test-anticodex-cold-relaunch.ps1",
  "scripts/test-anticodex-cancellation.ps1",
  "scripts/test-anticodex-codex-responses.ps1",
  "scripts/test-anticodex-compaction-resume.ps1",
  "scripts/test-anticodex-custom-tool-loop.ps1",
  "scripts/test-anticodex-diagnostics.ps1",
  "scripts/test-anticodex-installed-overall.ps1",
  "scripts/test-anticodex-local-connectors.mjs",
  "scripts/test-anticodex-manager-action.ps1",
  "scripts/test-anticodex-manager-button.mjs",
  "scripts/test-anticodex-manager-real-buttons.ps1",
  "scripts/test-anticodex-mcp-skills.ps1",
  "scripts/test-anticodex-mcp-tool-loop.ps1",
  "scripts/test-anticodex-missing-history.mjs",
  "scripts/test-anticodex-model-routing.ps1",
  "scripts/test-anticodex-model-switch-history.ps1",
  "scripts/test-anticodex-model-thinking.ps1",
  "scripts/test-anticodex-native-multi-tool-loop.ps1",
  "scripts/test-anticodex-native-tool-loop.ps1",
  "scripts/test-anticodex-plugin-capabilities.ps1",
  "scripts/test-anticodex-post-verification.ps1",
  "scripts/test-anticodex-provider-antigravity-return.ps1",
  "scripts/test-anticodex-release-gates.mjs",
  "scripts/test-anticodex-real-third-party-provider.mjs",
  "scripts/test-anticodex-real-work.ps1",
  "scripts/test-anticodex-real-mini-tool.ps1",
  "scripts/test-anticodex-source-preflight.ps1",
  "scripts/test-anticodex-stability-soak.ps1",
  "scripts/test-anticodex-sync-readiness.ps1",
  "scripts/test-anticodex-third-party-provider.mjs",
  "scripts/test-anticodex-tool-bridge-mode.ps1",
  "scripts/test-anticodex-tool-loop.ps1",
  "scripts/test-anticodex-ui-state.mjs",
  "scripts/test-anticodex-ui-state.ps1",
  "scripts/test-anticodex-ui-idle-stability.ps1",
  "scripts/test-anticodex-web-tools.ps1",
  "translator/adaptive-server.mjs",
  "translator/antigravity-agentapi.mjs",
  "translator/antigravity-model-catalog.mjs",
  "translator/antigravity-native-mcp-bridge.mjs",
  "translator/antigravity-session-lock.mjs",
  "translator/antigravity-upstream.mjs",
  "translator/compat-rules.mjs",
  "translator/local-projection/index.mjs",
  "translator/response-history.mjs",
  "translator/sync-antigravity-model-catalog.mjs",
  "translator/upstream-provider.mjs",
  "codex-home-deepseek-app/config.adaptive-oneapi.toml",
];

const gateDefinitions = [
  { id: "fastOverallNoTraffic", group: "short", file: "latest-installed-overall-fast.json", requiredForShort: true, requiredForRelease: true, requireFastNoTraffic: true, requireInstalledOverallSemantics: true, expectedFast: true, expectedReportName: "installed-overall-fast", expectedCoverageKind: "installed-fast-no-traffic" },
  { id: "sourcePreflight", group: "short", file: "latest-source-preflight.json", requiredForShort: true, requiredForRelease: true, requireSourcePreflightSemantics: true },
  { id: "mcpSkills", group: "short", file: "latest-mcp-skills.json", requiredForShort: true, requiredForRelease: true, requireMcpSkillSemantics: true },
  { id: "pluginCapabilities", group: "short", file: "latest-plugin-capabilities.json", requiredForShort: true, requiredForRelease: true, requirePluginCapabilitySemantics: true },
  { id: "localConnectors", group: "short", file: "latest-local-connectors.json", requiredForShort: true, requiredForRelease: true, requireLocalConnectorSemantics: true },
  { id: "thirdPartyProvider", group: "short", file: "latest-third-party-provider.json", requiredForShort: true, requiredForRelease: true, requireThirdPartyProviderSemantics: true },
  { id: "missingHistory", group: "short", file: "latest-missing-history.json", requiredForShort: true, requiredForRelease: true, requireMissingHistorySemantics: true },
  { id: "managerRealButtons", group: "manager", file: "latest-manager-real-buttons.json", requiredForShort: true, requiredForRelease: true, requireManagerActions: true },
  { id: "refreshFeatures", group: "manager", file: "latest-refresh-features.json", requiredForRelease: true, requireRefreshFeatureSemantics: true },
  { id: "realThirdPartyProviderOptional", group: "optional-real-traffic", file: "latest-real-third-party-provider.json", requiredForRelease: false, requireOptionalRealTrafficSemantics: true },
  { id: "providerAntigravityReturnOptional", group: "optional-real-traffic", file: "latest-provider-antigravity-return.json", requiredForRelease: false, requireOptionalRealTrafficSemantics: true },

  { id: "installedOverallNoTraffic", group: "no-traffic", file: "latest-installed-overall.json", requiredForRelease: true, requireInstalledOverallSemantics: true, expectedFast: false, expectedReportName: "installed-overall", expectedCoverageKind: "installed-no-traffic" },
  { id: "modelRouting", group: "no-traffic", file: "latest-model-routing.json", requiredForRelease: true, requireModelRoutingSemantics: true },
  { id: "logDbGuard", group: "no-traffic", file: "latest-log-db-guard.json", requiredForRelease: true, requireLogDbGuardSemantics: true },
  { id: "toolBridgeMode", group: "no-traffic", file: "latest-tool-bridge-mode.json", requiredForRelease: true, requireToolBridgeSemantics: true },
  { id: "uiIdleStability", group: "no-traffic", file: "latest-ui-idle-stability.json", requiredForRelease: true, requireUiIdleSemantics: true },
  { id: "syncReadiness", group: "no-traffic", file: "latest-sync-readiness.json", requiredForRelease: true, requireSyncReadinessSemantics: true },
  { id: "modelThinking", group: "no-traffic", file: "latest-model-thinking.json", requiredForRelease: true, requireModelThinkingSemantics: true },

  { id: "postVerification", group: "real-traffic", file: "latest-post-verification.json", requiredForRelease: true, requireUsedRealTraffic: true },
  { id: "codexResponses", group: "real-traffic", file: "latest-codex-responses.json", requiredForRelease: true },
  { id: "toolLoop", group: "real-traffic", file: "latest-tool-loop.json", requiredForRelease: true },
  { id: "nativeToolLoop", group: "real-traffic", file: "latest-native-tool-loop.json", requiredForRelease: true },
  { id: "nativeMultiToolLoop", group: "real-traffic", file: "latest-native-multi-tool-loop.json", requiredForRelease: true },
  { id: "mcpToolLoop", group: "real-traffic", file: "latest-mcp-tool-loop.json", requiredForRelease: true },
  { id: "customToolLoop", group: "real-traffic", file: "latest-custom-tool-loop.json", requiredForRelease: true },
  { id: "compactionResume", group: "real-traffic", file: "latest-compaction-resume.json", requiredForRelease: true },
  { id: "cancellation", group: "real-traffic", file: "latest-cancellation.json", requiredForRelease: true },
  { id: "webTools", group: "real-traffic", file: "latest-web-tools.json", requiredForRelease: true },
  { id: "realMiniTool", group: "real-traffic", file: "latest-real-mini-tool.json", requiredForRelease: true },
  { id: "realWork", group: "real-traffic", file: "latest-real-work.json", requiredForRelease: true },
  { id: "accountProxyReadiness", group: "real-traffic", file: "latest-account-proxy-readiness.json", requiredForRelease: true },

  { id: "stabilitySoak", group: "soak", file: "latest-stability-soak.json", requiredForRelease: false, requireStabilitySoakSemantics: true },
  { id: "coldRelaunch", group: "cold", file: "latest-cold-relaunch.json", requiredForRelease: false, requireColdRelaunchSemantics: true, note: "Manual/isolated restart evidence; optional for passive release readiness." },
];

function fileHash(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function integrityFor(filePath) {
  const sidecarPath = `${filePath}.sha256`;
  if (!existsSync(filePath)) return { signed: false, valid: null, error: "missing_report" };
  if (!existsSync(sidecarPath)) return { signed: false, valid: null, error: "missing_hash_sidecar" };
  const raw = readFileSync(sidecarPath, "ascii").trim();
  const match = raw.match(/^(?:sha256:)?([a-fA-F0-9]{64})$/);
  if (!match) return { signed: true, valid: false, error: "invalid_hash_sidecar" };
  const expected = match[1].toLowerCase();
  const actual = fileHash(filePath);
  return { signed: true, valid: actual === expected, hash: actual, expected, error: actual === expected ? "" : "hash_mismatch" };
}

function normalizedRuntimePath(relativePath) {
  return relativePath.split("/").join("\\");
}

function runtimeSyncFingerprint(root) {
  const fp = createHash("sha256");
  let maxMtimeMs = 0;
  const files = [];
  for (const relativePath of runtimeSyncFiles) {
    const absolutePath = join(root, ...relativePath.split("/"));
    if (!existsSync(absolutePath)) {
      files.push({ relativePath: normalizedRuntimePath(relativePath), exists: false, hash: "" });
      continue;
    }
    const stat = statSync(absolutePath);
    const hash = fileHash(absolutePath);
    if (stat.mtimeMs > maxMtimeMs) maxMtimeMs = stat.mtimeMs;
    files.push({ relativePath: normalizedRuntimePath(relativePath), exists: true, hash });
    fp.update(relativePath);
    fp.update(hash);
  }
  return {
    fingerprint: fp.digest("hex"),
    fileCount: files.filter((file) => file.exists).length,
    missing: files.filter((file) => !file.exists).map((file) => file.relativePath),
    files,
    sourceMtimeMax: maxMtimeMs > 0 ? new Date(maxMtimeMs).toISOString() : "",
  };
}

function summarizeInstalledRuntimeSyncGate() {
  const sourceRoot = currentSourceRoot();
  const targetRuntime = currentTargetRuntime();
  const gate = {
    id: "installedRuntimeSync",
    group: "short",
    file: "",
    requiredForShort: true,
    requiredForRelease: true,
    present: true,
    parseable: true,
    signed: true,
    hashValid: true,
    okField: false,
    fresh: true,
    ageHours: 0,
    satisfied: false,
    note: "Compares current source runtime files with the installed Anti-Codex runtime without restarting anything.",
    error: "",
    sourceRoot,
    targetRuntime,
  };
  const semanticFailures = [];
  try {
    const source = runtimeSyncFingerprint(sourceRoot);
    const installed = runtimeSyncFingerprint(targetRuntime);
    gate.sourceFingerprint = source.fingerprint;
    gate.installedRuntimeFingerprint = installed.fingerprint;
    gate.sourceFileCount = source.fileCount;
    gate.installedRuntimeFileCount = installed.fileCount;
    gate.sourceMtimeMax = source.sourceMtimeMax;
    gate.installedRuntimeMtimeMax = installed.sourceMtimeMax;
    gate.missingSourceFiles = source.missing;
    gate.missingInstalledRuntimeFiles = installed.missing;
    gate.mismatchedRuntimeFiles = runtimeSyncFiles
      .map(normalizedRuntimePath)
      .filter((relativePath) => {
        const sourceFile = source.files.find((file) => file.relativePath === relativePath);
        const installedFile = installed.files.find((file) => file.relativePath === relativePath);
        return sourceFile?.exists && installedFile?.exists && sourceFile.hash !== installedFile.hash;
      });
    if (source.missing.length > 0) semanticFailures.push("installed_runtime_source_missing");
    if (installed.missing.length > 0) semanticFailures.push("installed_runtime_target_missing");
    if (gate.mismatchedRuntimeFiles.length > 0) semanticFailures.push("installed_runtime_hash_mismatch");
    if (source.fingerprint !== installed.fingerprint) semanticFailures.push("installed_runtime_fingerprint_mismatch");
  } catch (error) {
    semanticFailures.push("installed_runtime_sync_probe_failed");
    gate.error = error instanceof Error ? error.message : String(error);
  }
  gate.semanticFailures = semanticFailures;
  gate.okField = semanticFailures.length === 0;
  gate.satisfied = gate.okField === true;
  return gate;
}

function isEmptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function validToolEvidence(evidence, protocol) {
  return !!evidence
    && evidence.protocol === protocol
    && evidence.pairedByCallId === true
    && evidence.resultAfterToolCall === true
    && evidence.protocolShapeClean === true;
}

function validOrderedHistoryEvidence(evidence, minChecked) {
  return !!evidence
    && evidence.ok === true
    && Number(evidence.checked || 0) >= minChecked
    && Array.isArray(evidence.matched)
    && evidence.matched.length >= minChecked;
}

function summarizeGate(definition) {
  const filePath = join(reportRoot, definition.file);
  const present = existsSync(filePath);
  const gate = {
    id: definition.id,
    group: definition.group,
    file: definition.file,
    requiredForShort: definition.requiredForShort === true,
    requiredForRelease: definition.requiredForRelease === true,
    present,
    parseable: false,
    signed: false,
    hashValid: null,
    okField: null,
    fresh: false,
    ageHours: null,
    satisfied: false,
    note: definition.note || "",
    error: present ? "" : "missing_report",
  };
  if (!present) return gate;

  const stat = statSync(filePath);
  const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
  gate.ageHours = Math.max(0, Number(ageHours.toFixed(3)));
  gate.fresh = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? ageHours <= maxAgeHours : true;
  const integrity = integrityFor(filePath);
  gate.signed = integrity.signed === true;
  gate.hashValid = integrity.valid;
  if (integrity.error) gate.error = integrity.error;

  try {
    const report = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    gate.parseable = true;
    gate.okField = report.ok === true;
    gate.reportName = typeof report.reportName === "string" ? report.reportName : "";
    gate.failureCount = Array.isArray(report.failures) ? report.failures.length : 0;
    gate.fast = report.fast === true;
    gate.noTraffic = report.noTraffic === true;
    gate.skipped = report.skipped === true;
    gate.requestedRealTraffic = report.requestedRealTraffic === true ? true : report.requestedRealTraffic === false ? false : null;
    gate.usedRealTraffic = report.usedRealTraffic === true ? true : report.usedRealTraffic === false ? false : null;
    gate.behaviorCovered = report.behaviorCovered === true ? true : report.behaviorCovered === false ? false : null;
    gate.coverageKind = typeof report.coverageKind === "string" ? report.coverageKind : "";
    const sourceSnapshot = report.sourceSnapshot && typeof report.sourceSnapshot === "object" ? report.sourceSnapshot : {};
    gate.sourceFingerprint = typeof sourceSnapshot.fingerprint === "string" ? sourceSnapshot.fingerprint : "";
    gate.sourceMtimeMax = typeof sourceSnapshot.sourceMtimeMax === "string" ? sourceSnapshot.sourceMtimeMax : "";
    gate.sourceFileCount = Number.isFinite(Number(sourceSnapshot.fileCount)) ? Number(sourceSnapshot.fileCount) : null;
    const semanticFailures = [];
    if (definition.requireFastNoTraffic && (report.fast !== true || report.noTraffic !== true)) {
      semanticFailures.push("expected_fast_no_traffic");
    }
    if (definition.requireInstalledOverallSemantics) {
      const checks = report.checks && typeof report.checks === "object" ? report.checks : {};
      const entries = Object.entries(checks).map(([id, value]) => ({ id, value: value && typeof value === "object" ? value : {} }));
      const skippedEntries = entries.filter((entry) => entry.value.skipped === true);
      const allowedFullSkipped = new Set([
        "managerButtonSafeActions",
        "managerButtonReportActions",
        "managerButtonDiagnosticsBundle",
        "managerButtonPluginCapabilities",
        "managerAction",
        "mcpSkills",
        "pluginCapabilities",
        "realThirdPartyProviderOptional",
        "providerAntigravityReturnOptional",
        "realMiniTool",
        "realWork",
      ]);
      if (report.reportName !== definition.expectedReportName) semanticFailures.push("installed_overall_report_name");
      if (report.fast !== definition.expectedFast) semanticFailures.push("installed_overall_fast_flag");
      if (report.noTraffic !== true) semanticFailures.push("installed_overall_no_traffic_flag");
      if (report.usedRealTraffic !== false) semanticFailures.push("installed_overall_used_real_traffic");
      if (report.coverageKind !== definition.expectedCoverageKind) semanticFailures.push("installed_overall_coverage_kind");
      if (report.behaviorCovered !== true) semanticFailures.push("installed_overall_behavior_not_covered");
      if (definition.expectedFast && Number(report.fastMaxElapsedMs || 0) > 0 && Number(report.elapsedMs || 0) > Number(report.fastMaxElapsedMs)) semanticFailures.push("installed_overall_fast_elapsed");
      if (entries.length < 1) semanticFailures.push("installed_overall_checks_missing");
      if (entries.some((entry) => entry.value.ok !== true)) semanticFailures.push("installed_overall_check_not_ok");
      if (skippedEntries.some((entry) => !entry.value.reason || !entry.value.coveredBy)) semanticFailures.push("installed_overall_skip_metadata_missing");
      if (!definition.expectedFast && skippedEntries.some((entry) => !allowedFullSkipped.has(entry.id))) semanticFailures.push("installed_overall_unexpected_skipped_check");
      const skippedIds = new Set(skippedEntries.map((entry) => entry.id));
      if (!skippedIds.has("realMiniTool") || !skippedIds.has("realWork")) semanticFailures.push("installed_overall_real_traffic_skip_missing");
    }
    if (definition.requireSkipRequests && report.skipRequests !== true) {
      semanticFailures.push("expected_skipRequests_true");
    }
    if (definition.requireLogDbGuardSemantics) {
      if (report.reportName !== "log-db-guard") semanticFailures.push("log_db_guard_report_name");
      if (report.noTraffic !== true) semanticFailures.push("log_db_guard_no_traffic");
      if (report.usedRealTraffic !== false) semanticFailures.push("log_db_guard_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("log_db_guard_behavior_not_covered");
      if (report.coverageKind !== "installed-no-traffic") semanticFailures.push("log_db_guard_coverage_kind");
      if (report.exists !== true) semanticFailures.push("log_db_guard_database_missing");
      if (report.logsTable !== true) semanticFailures.push("log_db_guard_logs_table_missing");
      if (report.levelColumn !== true) semanticFailures.push("log_db_guard_level_column_missing");
      if (report.triggerPresent !== true) semanticFailures.push("log_db_guard_trigger_missing");
      if (report.protected !== true) semanticFailures.push("log_db_guard_not_protected");
      if (!Number.isFinite(Number(report.walBytes)) || Number(report.walBytes) < 0) semanticFailures.push("log_db_guard_wal_bytes_invalid");
    }
    if (definition.requireUsedRealTraffic && report.usedRealTraffic !== true) {
      semanticFailures.push("expected_usedRealTraffic_true");
    }
    if (definition.requireOptionalRealTrafficSemantics && present) {
      if (report.skipped === true) {
        if (report.requestedRealTraffic !== false) semanticFailures.push("optional_skipped_requested_real_traffic_not_false");
        if (report.usedRealTraffic !== false) semanticFailures.push("optional_skipped_used_real_traffic");
        if (report.behaviorCovered !== false) semanticFailures.push("optional_skipped_behavior_covered");
        if (report.coverageKind !== "skipped") semanticFailures.push("optional_skipped_coverage_kind");
        if (!report.reason || !report.coveredBy) semanticFailures.push("optional_skipped_metadata_missing");
        if (report.requestedRealTraffic === true && report.ok === true) semanticFailures.push("optional_requested_real_traffic_uncovered_but_ok");
      } else {
        if (report.requestedRealTraffic !== true) semanticFailures.push("optional_real_traffic_not_requested");
        if (report.usedRealTraffic !== true) semanticFailures.push("optional_real_traffic_not_used");
        if (report.behaviorCovered !== true) semanticFailures.push("optional_real_traffic_behavior_not_covered");
        if (report.coverageKind !== "real-traffic") semanticFailures.push("optional_real_traffic_coverage_kind");
        if (definition.id === "realThirdPartyProviderOptional") {
          const routeEvidence = report.routeEvidence && typeof report.routeEvidence === "object" ? report.routeEvidence : {};
          const sameChainReturn = report.realProviderToAntigravityReturnEvidence && typeof report.realProviderToAntigravityReturnEvidence === "object" ? report.realProviderToAntigravityReturnEvidence : {};
          if (report.reportName !== "real-third-party-provider") semanticFailures.push("optional_real_provider_report_name");
          if (report.firstMarkerObserved !== true) semanticFailures.push("optional_real_provider_first_marker_missing");
          if (report.secondMarkerObserved !== true) semanticFailures.push("optional_real_provider_second_marker_missing");
          if (report.historyContinuationObserved !== true) semanticFailures.push("optional_real_provider_history_missing");
          if (report.secretsRedacted !== true) semanticFailures.push("optional_real_provider_secrets_not_redacted");
          if (Number(report.turns || 0) < 2) semanticFailures.push("optional_real_provider_turn_count");
          if (routeEvidence.transport !== "upstream-provider") semanticFailures.push("optional_real_provider_route_transport");
          if (!routeEvidence.providerProtocol) semanticFailures.push("optional_real_provider_route_protocol");
          if (!routeEvidence.requestedModel || !routeEvidence.resolvedModel || routeEvidence.requestedModel !== routeEvidence.resolvedModel) semanticFailures.push("optional_real_provider_route_model");
          if (routeEvidence.status !== "success") semanticFailures.push("optional_real_provider_route_status");
          if (sameChainReturn.requested === true) {
            if (sameChainReturn.realAntigravityTurnUsed !== true) semanticFailures.push("optional_real_provider_return_not_used");
            if (sameChainReturn.returnedToAntigravityWithHistory !== true) semanticFailures.push("optional_real_provider_return_history_missing");
            if (sameChainReturn.previousResponseIdMatched !== true) semanticFailures.push("optional_real_provider_return_previous_response_id_mismatch");
            if (Number(sameChainReturn.markerCount || 0) < 3) semanticFailures.push("optional_real_provider_return_marker_count");
            if (Number(sameChainReturn.missingMarkerCount || 0) !== 0) semanticFailures.push("optional_real_provider_return_missing_markers");
            if (sameChainReturn.returnUpstream !== "antigravity-desktop") semanticFailures.push("optional_real_provider_return_upstream_not_antigravity");
            if (!sameChainReturn.routeTransport || sameChainReturn.routeTransport === "upstream-provider") semanticFailures.push("optional_real_provider_return_route_transport");
            if (!sameChainReturn.requestedModel) semanticFailures.push("optional_real_provider_return_requested_model");
            if (!sameChainReturn.resolvedModel) semanticFailures.push("optional_real_provider_return_resolved_model");
          }
        }
        if (definition.id === "providerAntigravityReturnOptional") {
          const evidence = report.realAntigravityEvidence && typeof report.realAntigravityEvidence === "object" ? report.realAntigravityEvidence : {};
          if (report.reportName !== "provider-antigravity-return") semanticFailures.push("optional_antigravity_return_report_name");
          if (evidence.requested !== true) semanticFailures.push("optional_antigravity_return_not_requested");
          if (evidence.realAntigravityTurnUsed !== true) semanticFailures.push("optional_antigravity_return_not_used");
          if (evidence.returnedToAntigravityWithHistory !== true) semanticFailures.push("optional_antigravity_return_history_missing");
          if (evidence.previousResponseIdMatched !== true) semanticFailures.push("optional_antigravity_return_previous_response_id_mismatch");
          if (Number(evidence.markerCount || 0) < 6) semanticFailures.push("optional_antigravity_return_marker_count");
          if (Number(evidence.missingMarkerCount || 0) !== 0) semanticFailures.push("optional_antigravity_return_missing_markers");
          if (!evidence.routeTransport || evidence.routeTransport === "upstream-provider") semanticFailures.push("optional_antigravity_return_route_transport");
          if (!evidence.resolvedModel) semanticFailures.push("optional_antigravity_return_resolved_model");
        }
      }
    }
    if (definition.group === "no-traffic") {
      if (report.usedRealTraffic === true) semanticFailures.push("expected_no_real_traffic");
      if (report.behaviorCovered === false) semanticFailures.push("expected_behavior_covered");
      if (report.coverageKind === "real-traffic") semanticFailures.push("expected_no_real_traffic_coverage_kind");
    }
    if (definition.requireLocalConnectorSemantics) {
      const evidence = report.endpointEvidence || {};
      if (report.reportName !== "local-connectors") semanticFailures.push("local_connector_report_name");
      if (report.usedRealTraffic !== false) semanticFailures.push("local_connector_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("local_connector_behavior_not_covered");
      if (report.coverageKind !== "local-fake-provider") semanticFailures.push("local_connector_coverage_kind");
      if (evidence.chatgptInstallUrlsScrubbed !== true) semanticFailures.push("local_connector_chatgpt_urls_not_scrubbed");
      if (evidence.linkEndpointsUnsupported !== true) semanticFailures.push("local_connector_link_endpoints_not_metadata_only");
      if (evidence.upstreamRequestsDuringLocalEndpoints !== 0) semanticFailures.push("local_connector_upstream_requests_during_local_endpoints");
      if (evidence.linkedConnectorAccessible !== true) semanticFailures.push("local_connector_linked_connector_not_accessible");
      if (evidence.allowlistedConnectorAccessible !== false) semanticFailures.push("local_connector_allowlist_marked_accessible");
      if (evidence.allowlistedConnectorLocallyAllowlisted !== true) semanticFailures.push("local_connector_allowlist_not_recorded");
      if (evidence.hiddenConnectorAccessible !== false) semanticFailures.push("local_connector_hidden_connector_accessible");
      if (Number(evidence.exposedToolsPost) !== Number(evidence.exposedToolsGet)) semanticFailures.push("local_connector_get_post_tool_mismatch");
      if (!Array.isArray(evidence.exposedToolNames) || evidence.exposedToolNames.length !== Number(evidence.exposedToolsPost)) semanticFailures.push("local_connector_exposed_tool_names_mismatch");
      if (!Array.isArray(evidence.exposedToolNames) || evidence.exposedToolNames.length !== 1 || evidence.exposedToolNames[0] !== "linked_tool") semanticFailures.push("local_connector_unexpected_exposed_tool");
    }
    if (definition.requirePluginCapabilitySemantics) {
      const capabilities = report.capabilities || {};
      const connectorParity = capabilities.connectorParity || {};
      const appToolParity = capabilities.appToolParity || {};
      const appToolGetPostParity = capabilities.appToolGetPostParity || {};
      if (capabilities.nativeCodexWriteback !== false) semanticFailures.push("plugin_capabilities_native_codex_writeback");
      if (capabilities.accessibleConnectorCount !== 0) semanticFailures.push("plugin_capabilities_accessible_connector_count");
      if (capabilities.unauthorizedAppToolCount !== 0) semanticFailures.push("plugin_capabilities_unauthorized_app_tools");
      if (!isEmptyArray(appToolGetPostParity.missingFromGet) || !isEmptyArray(appToolGetPostParity.extraFromGet)) semanticFailures.push("plugin_capabilities_app_tool_get_post_mismatch");
      if (!isEmptyArray(connectorParity.missingShared)) semanticFailures.push("plugin_capabilities_local_connector_parity_missing_shared");
      if (!isEmptyArray(connectorParity.extraLocal)) semanticFailures.push("plugin_capabilities_local_connector_parity_extra_local");
      if (!isEmptyArray(connectorParity.changedShared)) semanticFailures.push("plugin_capabilities_local_connector_parity_changed_shared");
      if (!isEmptyArray(appToolParity.missingShared)) semanticFailures.push("plugin_capabilities_local_app_tool_parity_missing_shared");
      if (!isEmptyArray(appToolParity.extraLocal)) semanticFailures.push("plugin_capabilities_local_app_tool_parity_extra_local");
      if (!isEmptyArray(appToolParity.changedShared)) semanticFailures.push("plugin_capabilities_local_app_tool_parity_changed_shared");
      if (!gate.sourceFingerprint) semanticFailures.push("plugin_capabilities_source_snapshot_missing");
    }
    if (definition.requireMcpSkillSemantics) {
      const mcp = report.mcp || {};
      const skills = report.skills || {};
      const mcpSmoke = mcp.smoke || {};
      const mcpRealCall = mcpSmoke.realCall || {};
      if (Number(mcp.count || 0) < 1) semanticFailures.push("mcp_skills_no_mcp_servers");
      if (Number(mcp.sharedCount || 0) < 1) semanticFailures.push("mcp_skills_no_shared_mcp_servers");
      if (!isEmptyArray(mcp.missingShared)) semanticFailures.push("mcp_skills_missing_shared_mcp");
      if (!isEmptyArray(mcp.extraLocal)) semanticFailures.push("mcp_skills_extra_local_mcp");
      if (!isEmptyArray(mcp.changedShared)) semanticFailures.push("mcp_skills_changed_shared_mcp");
      if (mcp.hasNodeRepl !== true) semanticFailures.push("mcp_skills_missing_node_repl");
      if (mcpSmoke.passed !== true) semanticFailures.push("mcp_skills_smoke_not_passed");
      if (mcpRealCall.passed !== true) semanticFailures.push("mcp_skills_real_call_not_passed");
      if (Number(skills.count || 0) < 1) semanticFailures.push("mcp_skills_no_local_skills");
      if (Number(skills.sharedCount || 0) < 1) semanticFailures.push("mcp_skills_no_shared_skills");
      if (Number(skills.agentsCount || 0) < 1) semanticFailures.push("mcp_skills_no_agents_skills");
      if (Number(skills.expectedSharedCount || 0) < Number(skills.sharedCount || 0) + Number(skills.agentsCount || 0)) semanticFailures.push("mcp_skills_expected_shared_count");
      if (!isEmptyArray(skills.missingShared)) semanticFailures.push("mcp_skills_missing_shared_skills");
      if (!isEmptyArray(skills.extraLocal)) semanticFailures.push("mcp_skills_extra_local_skills");
      if (!isEmptyArray(skills.changedShared)) semanticFailures.push("mcp_skills_changed_shared_skills");
      if (!isEmptyArray(skills.conflictingDuplicateNames)) semanticFailures.push("mcp_skills_conflicting_duplicate_skills");
      if (!skills.smoke || skills.smoke.readable !== true) semanticFailures.push("mcp_skills_skill_smoke_not_readable");
      if (!gate.sourceFingerprint) semanticFailures.push("mcp_skills_source_snapshot_missing");
    }
    if (definition.requireRefreshFeatureSemantics) {
      const connectorParity = report.connectorParity || {};
      const appToolParity = report.appToolParity || {};
      const skills = report.skills || {};
      const guidance = report.guidance && typeof report.guidance === "object" ? report.guidance : {};
      if (report.reportName !== "refresh-features") semanticFailures.push("refresh_features_report_name");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("refresh_features_failures");
      if (connectorParity.sharedExists === true && connectorParity.localExists !== true) semanticFailures.push("refresh_features_connector_local_missing");
      if (connectorParity.sharedExists === true && connectorParity.contentMatches !== true) semanticFailures.push("refresh_features_connector_parity");
      if (appToolParity.sharedExists === true && appToolParity.localExists !== true) semanticFailures.push("refresh_features_app_tool_local_missing");
      if (appToolParity.sharedExists === true && appToolParity.contentMatches !== true) semanticFailures.push("refresh_features_app_tool_parity");
      if (Array.isArray(skills.changedExpected) && skills.changedExpected.length > 0) semanticFailures.push("refresh_features_skill_parity");
      if (Object.values(guidance).some((entry) => entry && entry.sharedExists === true && entry.localExists === true && entry.contentMatches !== true)) semanticFailures.push("refresh_features_guidance_parity");
      if (!gate.sourceFingerprint) semanticFailures.push("refresh_features_source_snapshot_missing");
    }
    if (definition.requireSourcePreflightSemantics) {
      const checks = report.checks || {};
      if (report.reportName !== "source-preflight") semanticFailures.push("source_preflight_report_name");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("source_preflight_failures");
      if (!checks.javascriptSyntax || checks.javascriptSyntax.ok !== true) semanticFailures.push("source_preflight_javascript_syntax");
      if (!checks.powershellSyntax || checks.powershellSyntax.ok !== true) semanticFailures.push("source_preflight_powershell_syntax");
      if (!checks.uiStateSelfTest || checks.uiStateSelfTest.ok !== true) semanticFailures.push("source_preflight_ui_state_self_test");
      if (!checks.upstreamProfileStorage || checks.upstreamProfileStorage.ok !== true) semanticFailures.push("source_preflight_upstream_profile_storage");
      if (!checks.localConnectorVerifier || checks.localConnectorVerifier.ok !== true) semanticFailures.push("source_preflight_local_connector_verifier");
      if (!checks.publicDocumentation || checks.publicDocumentation.ok !== true) semanticFailures.push("source_preflight_public_documentation");
      if (!checks.translatorRegression || checks.translatorRegression.ok !== true) semanticFailures.push("source_preflight_translator_regression");
      if (!checks.diffWhitespace || checks.diffWhitespace.ok !== true) semanticFailures.push("source_preflight_diff_whitespace");
    }
    if (definition.requireModelRoutingSemantics) {
      const results = Array.isArray(report.results) ? report.results : [];
      if (report.skipRequests !== true) semanticFailures.push("model_routing_skip_requests_not_true");
      if (Number(report.modelCount || 0) < 1) semanticFailures.push("model_routing_model_count");
      if (!Array.isArray(report.models) || report.models.length < Number(report.modelCount || 0)) semanticFailures.push("model_routing_models_missing");
      if (!report.mode) semanticFailures.push("model_routing_mode_missing");
      if (results.length < Number(report.modelCount || 0)) semanticFailures.push("model_routing_results_missing");
      if (results.some((item) => item?.ok !== true)) semanticFailures.push("model_routing_result_not_ok");
      if (results.some((item) => item?.skippedRequest !== true)) semanticFailures.push("model_routing_result_not_skipped");
      if (results.some((item) => item?.error)) semanticFailures.push("model_routing_result_error");
    }
    if (definition.requireToolBridgeSemantics) {
      const toolBridge = report.toolBridge || {};
      const compatibilityTools = report.compatibilityTools || {};
      const nativeToolCapability = report.nativeToolCapability || {};
      if (toolBridge.mode !== "native-mcp-same-cascade") semanticFailures.push("tool_bridge_mode_not_native_mcp_same_cascade");
      if (toolBridge.transport !== "desktop-cascade") semanticFailures.push("tool_bridge_transport_not_desktop_cascade");
      if (toolBridge.localAdapter !== "native-mcp-same-cascade-with-prompt-fallback") semanticFailures.push("tool_bridge_local_adapter");
      if (toolBridge.nativeAntigravityToolEvents !== true) semanticFailures.push("tool_bridge_native_events");
      if (toolBridge.nativeMcpDiscoveryVerified !== true) semanticFailures.push("tool_bridge_mcp_discovery");
      if (toolBridge.nativeBridgeDefaultEnabled !== true) semanticFailures.push("tool_bridge_default_disabled");
      if (toolBridge.acceptsExternalToolDefinitions !== true) semanticFailures.push("tool_bridge_external_tool_definitions");
      if (compatibilityTools.bridge !== "native_mcp_same_cascade") semanticFailures.push("tool_bridge_compatibility_bridge");
      if (nativeToolCapability.nativeMcpApprovalProtocolVerified !== true) semanticFailures.push("tool_bridge_approval_protocol");
      if (nativeToolCapability.nativeMcpPermissionMode !== "automatic-before-codex-execution") semanticFailures.push("tool_bridge_permission_mode");
      if (nativeToolCapability.sameCascadeResumeProbeVerified !== true) semanticFailures.push("tool_bridge_same_cascade_resume");
      if (nativeToolCapability.antigravityOwnedToolsDisabled !== true) semanticFailures.push("tool_bridge_owned_tools_enabled");
      if (nativeToolCapability.permissionPromptsDisabled !== true) semanticFailures.push("tool_bridge_permission_prompts_enabled");
      if (Number(nativeToolCapability.disabledToolCount || 0) < 1) semanticFailures.push("tool_bridge_disabled_tool_count");
      if (nativeToolCapability.codexToolBridge !== "native-mcp-same-cascade-with-prompt-fallback") semanticFailures.push("tool_bridge_codex_bridge");
    }
    if (definition.requireModelThinkingSemantics) {
      const models = Array.isArray(report.models) ? report.models : [];
      const expected = Number(report.expectedModelCount || 0);
      const actual = Number(report.actualModelCount || 0);
      const ids = models.map((item) => item?.id).filter(Boolean);
      if (expected < 1) semanticFailures.push("model_thinking_expected_count");
      if (actual !== expected) semanticFailures.push("model_thinking_actual_count");
      if (models.length !== actual) semanticFailures.push("model_thinking_models_length");
      if (new Set(ids).size !== ids.length || ids.length !== models.length) semanticFailures.push("model_thinking_unique_ids");
      if (models.some((item) => !item?.display_name)) semanticFailures.push("model_thinking_display_name");
      if (models.some((item) => !item?.reasoning_level)) semanticFailures.push("model_thinking_reasoning_level");
      if (models.some((item) => item?.supports_thinking !== true)) semanticFailures.push("model_thinking_supports_thinking");
      if (models.some((item) => !Number.isFinite(Number(item?.thinking_budget)) || !Number.isFinite(Number(item?.min_thinking_budget)) || Number(item.thinking_budget) < Number(item.min_thinking_budget))) semanticFailures.push("model_thinking_budget");
    }
    if (definition.requireUiIdleSemantics) {
      const samples = Array.isArray(report.samples) ? report.samples : [];
      if (Number(report.durationSec || 0) < 10) semanticFailures.push("ui_idle_duration");
      if (Number(report.sampleCount || 0) < 1) semanticFailures.push("ui_idle_sample_count");
      if (samples.length < Number(report.sampleCount || 0)) semanticFailures.push("ui_idle_samples_missing");
      if (samples.some((item) => item?.healthOk !== true)) semanticFailures.push("ui_idle_health_not_ok");
      if (samples.some((item) => item?.accountReady !== true)) semanticFailures.push("ui_idle_account_not_ready");
      if (samples.some((item) => Number(item?.modelCount || 0) < 1)) semanticFailures.push("ui_idle_model_count");
      if (samples.some((item) => item?.uiOk !== true)) semanticFailures.push("ui_idle_ui_not_ok");
      if (samples.some((item) => item?.hasReconnectText === true)) semanticFailures.push("ui_idle_reconnect_text");
      if (samples.some((item) => item?.hasLoginText === true)) semanticFailures.push("ui_idle_login_text");
      if (samples.some((item) => !item?.matchedModelText)) semanticFailures.push("ui_idle_model_text_missing");
    }
    if (definition.requireSyncReadinessSemantics) {
      const activeHost = report.activeHost || {};
      const sync = report.sync || {};
      const updateStatus = sync.updateStatus || {};
      const guardrails = updateStatus.guardrails || {};
      const shortcuts = Array.isArray(sync.shortcutVerification) ? sync.shortcutVerification : [];
      const managerBridge = sync.managerBridge || {};
      const rollbackHost = sync.rollbackHost || {};
      if (report.reportName !== "sync-readiness") semanticFailures.push("sync_readiness_report_name");
      if (report.noTraffic !== true || report.usedRealTraffic !== false || report.behaviorCovered !== true || report.coverageKind !== "installed-no-traffic") semanticFailures.push("sync_readiness_no_traffic_attestation");
      if (report.fast !== false || report.skipIconPaletteProbe !== false) semanticFailures.push("sync_readiness_full_mode_required");
      if (activeHost.exists !== true || activeHost.markerExists !== true || activeHost.manifestValid !== true || activeHost.exeExists !== true) semanticFailures.push("sync_readiness_active_host");
      if (activeHost.productName !== "Anti-Codex" || activeHost.fileDescription !== "Anti-Codex" || activeHost.originalFilename !== "Anti-Codex.exe") semanticFailures.push("sync_readiness_brand");
      if (activeHost.hostIconExists !== true || activeHost.trayIconExists !== true || activeHost.appRootIconExists !== true) semanticFailures.push("sync_readiness_icon_files");
      if (activeHost.hostIconPalette?.ok !== true || activeHost.trayIconPalette?.ok !== true || activeHost.appRootIconPalette?.ok !== true) semanticFailures.push("sync_readiness_icon_palette");
      if (sync.desktopShortcutIconPalette && sync.desktopShortcutIconPalette.ok !== true) semanticFailures.push("sync_readiness_desktop_icon_palette");
      if (sync.scriptExists !== true || sync.launcherExists !== true || sync.rollbackScriptExists !== true || sync.rollbackLauncherExists !== true || sync.updateCheckExists !== true || sync.validatorExists !== true || sync.failureSafetyVerifierExists !== true || sync.installerExists !== true || sync.startScriptExists !== true) semanticFailures.push("sync_readiness_scripts");
      if (updateStatus.ok !== true || updateStatus.updateNeeded !== false || updateStatus.drift?.state !== "synced") semanticFailures.push("sync_readiness_update_status");
      if (updateStatus.operation?.state !== "succeeded") semanticFailures.push("sync_readiness_operation_state");
      if (!updateStatus.source?.hostHash || updateStatus.source.hostHash !== updateStatus.active?.hostHash || !updateStatus.source?.cliHash || updateStatus.source.cliHash !== updateStatus.active?.cliHash) semanticFailures.push("sync_readiness_source_active_hash_mismatch");
      if (guardrails.brandPreserved !== true || guardrails.iconPreserved !== true || guardrails.activeHostValid !== true || !isEmptyArray(guardrails.failures)) semanticFailures.push("sync_readiness_guardrails");
      if (shortcuts.length < 5) semanticFailures.push("sync_readiness_shortcut_count");
      if (shortcuts.some((item) => item?.ok !== true || item?.exists !== true || item?.displayNameMatches !== true || item?.targetMatches !== true || item?.launcherTargetMatches !== true || item?.scriptMatches !== true || item?.iconMatches !== true || item?.forbiddenCodexBranding === true)) semanticFailures.push("sync_readiness_shortcuts");
      if (sync.startMenuMainShortcutExists !== true || sync.startMenuSyncShortcutExists !== true || sync.startMenuRollbackShortcutExists !== true || sync.startMenuManagerShortcutExists !== true || sync.desktopMainShortcutExists !== true) semanticFailures.push("sync_readiness_shortcut_inventory");
      if (!Array.isArray(sync.desktopAntiCodexShortcuts) || sync.desktopAntiCodexShortcuts.length !== 1 || sync.desktopAntiCodexShortcuts[0] !== "Anti-Codex.lnk") semanticFailures.push("sync_readiness_desktop_shortcuts");
      if (!isEmptyArray(sync.forbiddenDesktopHelperShortcuts)) semanticFailures.push("sync_readiness_forbidden_desktop_helpers");
      if (Number(managerBridge.processCount || 0) !== 1 || Number(managerBridge.staleProcessCount || 0) !== 0 || !Array.isArray(managerBridge.processes) || managerBridge.processes.some((item) => item?.hasExpectedBaseUrl !== true)) semanticFailures.push("sync_readiness_manager_bridge");
      if (managerBridge.expectedBaseUrl !== "http://127.0.0.1:8484") semanticFailures.push("sync_readiness_manager_bridge_base_url");
      if (sync.rollbackHostExists !== true || sync.rollbackMarkerExists !== true || rollbackHost.exists !== true || rollbackHost.markerExists !== true || rollbackHost.manifestValid !== true || rollbackHost.exeExists !== true) semanticFailures.push("sync_readiness_rollback_host");
      if (rollbackHost.productName !== "Anti-Codex" || rollbackHost.fileDescription !== "Anti-Codex" || rollbackHost.originalFilename !== "Anti-Codex.exe") semanticFailures.push("sync_readiness_rollback_brand");
      if (rollbackHost.hostIconPalette?.ok !== true || rollbackHost.trayIconPalette?.ok !== true || rollbackHost.appRootIconPalette?.ok !== true) semanticFailures.push("sync_readiness_rollback_icon_palette");
      if (sync.rollbackSwapHostExists === true || sync.rollbackSwapMarkerExists === true) semanticFailures.push("sync_readiness_rollback_swap_stale");
      if (sync.hostSyncMarkerExists !== false || sync.staleCandidateExists !== false || sync.rollbackHostExists !== true || sync.rollbackMarkerExists !== true) semanticFailures.push("sync_readiness_clean_state");
    }
    if (definition.requireColdRelaunchSemantics) {
      const health = report.health && typeof report.health === "object" ? report.health : {};
      const processes = report.processes && typeof report.processes === "object" ? report.processes : {};
      const originalCodex = report.originalCodex && typeof report.originalCodex === "object" ? report.originalCodex : {};
      const stages = Array.isArray(report.stages) ? report.stages : [];
      const stageNames = new Set(stages.filter((stage) => stage?.ok === true).map((stage) => String(stage.name || "")));
      if (report.reportName !== "cold-relaunch") semanticFailures.push("cold_relaunch_report_name");
      if (report.skipped === true) semanticFailures.push("cold_relaunch_skipped");
      if (report.requiresConfirmation === true) semanticFailures.push("cold_relaunch_requires_confirmation");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("cold_relaunch_failures");
      if (health.ok !== true || health.providerReady !== true) semanticFailures.push("cold_relaunch_health_not_ready");
      if (health.mode === "antigravity" && (health.upstream !== "antigravity-desktop" || Number(health.modelCount || 0) < 1)) semanticFailures.push("cold_relaunch_antigravity_not_ready");
      if (health.mode === "third-party" && (!health.protocol || !health.model)) semanticFailures.push("cold_relaunch_provider_not_ready");
      if (Number(processes.mainCount || 0) !== 1) semanticFailures.push("cold_relaunch_main_count");
      if (Number(processes.translatorCount || 0) < 1) semanticFailures.push("cold_relaunch_translator_count");
      if (Number(processes.launcherCount || 0) > 1) semanticFailures.push("cold_relaunch_launcher_count");
      if (originalCodex.unchanged !== true) semanticFailures.push("cold_relaunch_original_codex_not_proven");
      for (const name of ["stop-existing-processes", "launch-anticodex", "wait-health-ready"]) {
        if (!stageNames.has(name)) semanticFailures.push(`cold_relaunch_stage_missing:${name}`);
      }
      if (String((report.failures || []).join("\n")).includes("original Codex main process set changed")) semanticFailures.push("cold_relaunch_original_codex_changed");
    }
    if (definition.requireStabilitySoakSemantics) {
      const turns = Array.isArray(report.turns) ? report.turns : [];
      if (report.reportName !== "stability-soak") semanticFailures.push("stability_soak_report_name");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("stability_soak_failures");
      if (report.providerReady !== true || report.startReady !== true || report.endReady !== true) semanticFailures.push("stability_soak_provider_not_ready");
      if (report.pidStable !== true || !report.startPid || !report.endPid || report.startPid !== report.endPid) semanticFailures.push("stability_soak_pid_not_stable");
      if (Number(report.healthChecks || 0) < 1) semanticFailures.push("stability_soak_health_checks_missing");
      if (Number(report.elapsedMs || 0) < 1000) semanticFailures.push("stability_soak_elapsed_too_short");
      if (turns.length < 1) semanticFailures.push("stability_soak_turns_missing");
      if (turns.some((turn) => turn?.ok !== true)) semanticFailures.push("stability_soak_turn_not_ok");
      if (report.mode === "antigravity" && Number(report.modelCount || 0) < 1) semanticFailures.push("stability_soak_model_count");
      if (report.mode === "third-party" && !report.model) semanticFailures.push("stability_soak_provider_model");
    }
    if (definition.requireThirdPartyProviderSemantics) {
      const history = report.multiTurnHistory || {};
      const toolHistory = history.toolHistory || {};
      const structuralEvidence = toolHistory.structuralEvidence || {};
      const providerSwitch = history.providerSwitch || {};
      const protocolSwitch = history.protocolSwitch || {};
      const reverseProtocolSwitch = history.reverseProtocolSwitch || {};
      const previousResponseContinuity = history.previousResponseContinuity || report.previousResponseContinuity || {};
      if (report.reportName !== "third-party-provider") semanticFailures.push("third_party_provider_report_name");
      if (report.secretsRedacted !== true) semanticFailures.push("third_party_provider_secrets_not_redacted");
      if (history.turns !== 9) semanticFailures.push("third_party_provider_turn_count");
      if (report.savedWithoutHistoryLoss !== true) semanticFailures.push("third_party_provider_save_history_loss");
      if (report.restoredAntigravityWithoutHistoryLoss !== true) semanticFailures.push("third_party_provider_restore_history_loss");
      if (report.restartedProviderWithoutHistoryLoss !== true) semanticFailures.push("third_party_provider_restart_history_loss");
      if (report.switchedProviderWithoutHistoryLoss !== true) semanticFailures.push("third_party_provider_switch_history_loss");
      if (report.crossProtocolWithoutHistoryLoss !== true) semanticFailures.push("third_party_provider_cross_protocol_history_loss");
      if (report.reverseCrossProtocolWithoutHistoryLoss !== true) semanticFailures.push("third_party_provider_reverse_protocol_history_loss");
      if (history.providerModelUsedForEveryTurn !== true) semanticFailures.push("third_party_provider_stale_model_used");
      if (providerSwitch.requestReachedSecondProvider !== true) semanticFailures.push("third_party_provider_switch_not_reached");
      if (protocolSwitch.requestReachedAnthropicProvider !== true) semanticFailures.push("third_party_provider_protocol_switch_not_reached");
      if (reverseProtocolSwitch.requestReachedOpenAiCompatibleProvider !== true) semanticFailures.push("third_party_provider_reverse_protocol_switch_not_reached");
      if (toolHistory.providerSwitchPreservesOpenAiToolPair !== true) semanticFailures.push("third_party_provider_openai_tool_pair_lost");
      if (toolHistory.protocolSwitchPreservesAnthropicToolPair !== true) semanticFailures.push("third_party_provider_anthropic_tool_pair_lost");
      if (toolHistory.reverseProtocolSwitchPreservesOpenAiToolPair !== true) semanticFailures.push("third_party_provider_reverse_openai_tool_pair_lost");
      if (toolHistory.restartPreservesOpenAiToolPair !== true) semanticFailures.push("third_party_provider_restart_openai_tool_pair_lost");
      if (!validToolEvidence(structuralEvidence.seventhOpenAiToolEvidence, "openai-compatible")) semanticFailures.push("third_party_provider_openai_structural_tool_evidence");
      if (!validToolEvidence(structuralEvidence.eighthAnthropicToolEvidence, "anthropic")) semanticFailures.push("third_party_provider_anthropic_structural_tool_evidence");
      if (!validToolEvidence(structuralEvidence.ninthOpenAiToolEvidence, "openai-compatible")) semanticFailures.push("third_party_provider_reverse_openai_structural_tool_evidence");
      if (!validToolEvidence(structuralEvidence.fifthOpenAiToolEvidence, "openai-compatible")) semanticFailures.push("third_party_provider_save_structural_tool_evidence");
      if (!validToolEvidence(structuralEvidence.sixthOpenAiToolEvidence, "openai-compatible")) semanticFailures.push("third_party_provider_restart_structural_tool_evidence");
      if (!validOrderedHistoryEvidence(structuralEvidence.sixthOrderedHistory, 7)) semanticFailures.push("third_party_provider_turn6_ordered_history");
      if (!validOrderedHistoryEvidence(structuralEvidence.seventhOrderedHistory, 7)) semanticFailures.push("third_party_provider_turn7_ordered_history");
      if (!validOrderedHistoryEvidence(structuralEvidence.eighthOrderedHistory, 7)) semanticFailures.push("third_party_provider_turn8_ordered_history");
      if (!validOrderedHistoryEvidence(structuralEvidence.ninthOrderedHistory, 7)) semanticFailures.push("third_party_provider_turn9_ordered_history");
      if (!history.savedContinuationPreviousResponseId) semanticFailures.push("third_party_provider_save_previous_response_id_missing");
      if (!history.restartContinuationPreviousResponseId) semanticFailures.push("third_party_provider_restart_previous_response_id_missing");
      if (!history.providerSwitchContinuationPreviousResponseId) semanticFailures.push("third_party_provider_switch_previous_response_id_missing");
      if (!history.protocolSwitchContinuationPreviousResponseId) semanticFailures.push("third_party_provider_protocol_previous_response_id_missing");
      if (!history.reverseProtocolSwitchContinuationPreviousResponseId) semanticFailures.push("third_party_provider_reverse_protocol_previous_response_id_missing");
      if (!providerSwitch.continuationPreviousResponseId) semanticFailures.push("third_party_provider_switch_nested_previous_response_id_missing");
      if (!protocolSwitch.continuationPreviousResponseId) semanticFailures.push("third_party_provider_protocol_nested_previous_response_id_missing");
      if (!reverseProtocolSwitch.continuationPreviousResponseId) semanticFailures.push("third_party_provider_reverse_protocol_nested_previous_response_id_missing");
      if (previousResponseContinuity.saveMatched !== true) semanticFailures.push("third_party_provider_save_previous_response_id_mismatch");
      if (previousResponseContinuity.restartMatched !== true) semanticFailures.push("third_party_provider_restart_previous_response_id_mismatch");
      if (previousResponseContinuity.providerSwitchMatched !== true) semanticFailures.push("third_party_provider_switch_previous_response_id_mismatch");
      if (previousResponseContinuity.protocolSwitchMatched !== true) semanticFailures.push("third_party_provider_protocol_previous_response_id_mismatch");
      if (previousResponseContinuity.reverseProtocolSwitchMatched !== true) semanticFailures.push("third_party_provider_reverse_protocol_previous_response_id_mismatch");
      if (history.providerSwitchContinuationPreviousResponseId && providerSwitch.continuationPreviousResponseId && history.providerSwitchContinuationPreviousResponseId !== providerSwitch.continuationPreviousResponseId) semanticFailures.push("third_party_provider_switch_previous_response_id_mismatch");
      if (history.protocolSwitchContinuationPreviousResponseId && protocolSwitch.continuationPreviousResponseId && history.protocolSwitchContinuationPreviousResponseId !== protocolSwitch.continuationPreviousResponseId) semanticFailures.push("third_party_provider_protocol_previous_response_id_mismatch");
      if (history.reverseProtocolSwitchContinuationPreviousResponseId && reverseProtocolSwitch.continuationPreviousResponseId && history.reverseProtocolSwitchContinuationPreviousResponseId !== reverseProtocolSwitch.continuationPreviousResponseId) semanticFailures.push("third_party_provider_reverse_protocol_previous_response_id_mismatch");
      if (history.fifthAfterSavePreservesHistory !== true) semanticFailures.push("third_party_provider_save_marker_coverage");
      if (history.sixthAfterRestartPreservesHistory !== true) semanticFailures.push("third_party_provider_restart_marker_coverage");
      if (history.sixthAfterRestartPreservesAllHistoryMarkers !== true || Number(history.sixthAfterRestartAllHistoryMarkerCount) < 15) semanticFailures.push("third_party_provider_turn6_marker_coverage");
      if (history.seventhAfterProviderSwitchPreservesAllHistoryMarkers !== true || Number(history.seventhAfterProviderSwitchAllHistoryMarkerCount) < 16) semanticFailures.push("third_party_provider_turn7_marker_coverage");
      if (history.eighthAfterProtocolSwitchPreservesAllHistoryMarkers !== true || Number(history.eighthAfterProtocolSwitchAllHistoryMarkerCount) < 18) semanticFailures.push("third_party_provider_turn8_marker_coverage");
      if (history.ninthAfterReverseProtocolSwitchPreservesAllHistoryMarkers !== true || Number(history.ninthAfterReverseProtocolSwitchAllHistoryMarkerCount) < 20) semanticFailures.push("third_party_provider_turn9_marker_coverage");
    }
    if (definition.requireMissingHistorySemantics) {
      if (report.status !== 410) semanticFailures.push("missing_history_status_not_410");
      if (report.errorType !== "response_history_missing") semanticFailures.push("missing_history_error_type");
      if (report.retryable !== false) semanticFailures.push("missing_history_retryable_not_false");
      if (report.previousResponseIdMatched !== true) semanticFailures.push("missing_history_previous_response_id_not_matched");
      if (report.recoveryGuidancePresent !== true) semanticFailures.push("missing_history_recovery_guidance_missing");
      if (report.noRouteChange !== true) semanticFailures.push("missing_history_route_changed");
      if (report.usedRealTraffic !== false) semanticFailures.push("missing_history_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("missing_history_behavior_not_covered");
      if (report.coverageKind !== "installed-no-traffic") semanticFailures.push("missing_history_coverage_kind");
    }
    if (definition.requireManagerActions) {
      const actions = Array.isArray(report.actions) ? report.actions.map((item) => String(item)) : [];
      const results = report.managerButton?.results || {};
      for (const action of ["mcpSkills", "pluginCapabilities"]) {
        const result = results[action]?.result || results[action]?.payload?.result || results[action]?.payload?.results?.[action]?.result || null;
        if (!actions.includes(action)) semanticFailures.push(`missing_manager_action:${action}`);
        if (results[action]?.ok !== true) semanticFailures.push(`manager_action_not_ok:${action}`);
        if (!result || result.lastUiOnly !== false) semanticFailures.push(`manager_action_missing_real_click:${action}`);
      }
    }
    gate.semanticFailures = semanticFailures;
  } catch (error) {
    gate.error = String(error?.message || error || "JSON parse failed").replace(/[\r\n]+/g, " ").slice(0, 240);
  }

  gate.satisfied = gate.present && gate.parseable && gate.hashValid === true && gate.okField === true && gate.fresh === true && (!gate.semanticFailures || gate.semanticFailures.length === 0);
  return gate;
}

function writeTextAtomic(filePath, text) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    JSON.parse(readFileSync(tmp, "utf8"));
    renameSync(tmp, filePath);
    writeHashSidecar(filePath);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

function writeHashSidecar(filePath) {
  const hash = fileHash(filePath);
  const sidecar = `${filePath}.sha256`;
  const tmp = `${sidecar}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, `sha256:${hash}`, "ascii");
    renameSync(tmp, sidecar);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

function writeJsonReportAtomic(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const latest = join(reportRoot, "latest-release-gates.json");
  const history = join(reportRoot, `${stamp}-release-gates.json`);
  const text = JSON.stringify({ ...payload, report: { latest, history } });
  writeTextAtomic(history, text);
  writeTextAtomic(latest, text);
  return { latest, history };
}

if (args.has("--self-test")) {
  const originalReportRoot = reportRoot;
  const tempRoot = mkdtempSync(join(tmpdir(), "anticodex-release-gates-"));
  try {
    reportRoot = tempRoot;
    mkdirSync(tempRoot, { recursive: true });

    function writeFakeLatestReport(fileName, payload) {
      const filePath = join(tempRoot, fileName);
      writeFileSync(filePath, JSON.stringify(payload), "utf8");
      writeHashSidecar(filePath);
      return filePath;
    }

    function assertSemanticFailures(gateId, invalidReportMessage, requiredFailures) {
      const gate = summarizeGate(gateDefinitions.find((definition) => definition.id === gateId));
      const failures = gate.semanticFailures || [];
      if (gate.satisfied === true) throw new Error(invalidReportMessage);
      for (const failure of requiredFailures) {
        if (!failures.includes(failure)) throw new Error(`self-test failed: ${gateId} missing semantic failure ${failure}`);
      }
      return failures;
    }

    writeFakeLatestReport("latest-missing-history.json", {
      ok: true,
      reportName: "missing-history",
      status: 200,
      errorType: "ok",
      retryable: true,
      previousResponseIdMatched: false,
      recoveryGuidancePresent: false,
      noRouteChange: false,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "installed-no-traffic",
    });

    writeFakeLatestReport("latest-local-connectors.json", {
      ok: true,
      reportName: "wrong-local-connectors",
      usedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "real-traffic",
      endpointEvidence: {
        exposedToolsPost: 1,
        exposedToolsGet: 2,
        exposedToolNames: ["allowlisted_tool"],
        chatgptInstallUrlsScrubbed: false,
        linkEndpointsUnsupported: false,
        upstreamRequestsDuringLocalEndpoints: 1,
        linkedConnectorAccessible: false,
        allowlistedConnectorAccessible: true,
        allowlistedConnectorLocallyAllowlisted: false,
        hiddenConnectorAccessible: true,
      },
    });

    writeFakeLatestReport("latest-log-db-guard.json", {
      ok: true,
      reportName: "log-db-guard",
      noTraffic: true,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "installed-no-traffic",
      exists: true,
      logsTable: true,
      levelColumn: true,
      triggerPresent: false,
      protected: false,
      walBytes: 0,
    });

    writeFakeLatestReport("latest-plugin-capabilities.json", {
      ok: true,
      reportName: "plugin-capabilities",
      capabilities: {
        nativeCodexWriteback: true,
        accessibleConnectorCount: 1,
        unauthorizedAppToolCount: 1,
        appToolGetPostParity: {
          missingFromGet: ["unsafe-tool"],
          extraFromGet: [],
        },
        connectorParity: {
          missingShared: ["missing-connector"],
          extraLocal: ["extra-connector"],
          changedShared: ["changed-connector"],
        },
        appToolParity: {
          missingShared: ["missing-app-tool"],
          extraLocal: ["extra-app-tool"],
          changedShared: ["changed-app-tool"],
        },
      },
    });

    for (const fileName of ["latest-installed-overall-fast.json", "latest-installed-overall.json"]) {
      writeFakeLatestReport(fileName, {
        ok: true,
        reportName: "wrong-installed-overall",
        fast: fileName.includes("fast") ? false : true,
        noTraffic: false,
        usedRealTraffic: true,
        behaviorCovered: false,
        coverageKind: "real-traffic",
        fastMaxElapsedMs: 10,
        elapsedMs: 100,
        checks: {
          branding: { ok: false },
          skippedWithoutMetadata: { ok: true, skipped: true },
          unexpectedSkipped: { ok: true, skipped: true, reason: "bad", coveredBy: "bad" },
        },
      });
    }

    writeFakeLatestReport("latest-mcp-skills.json", {
      ok: true,
      reportName: "mcp-skills",
      mcp: {
        count: 1,
        sharedCount: 1,
        missingShared: ["missing-mcp"],
        extraLocal: ["extra-mcp"],
        hasNodeRepl: false,
        smoke: {
          passed: false,
          realCall: { passed: false },
        },
      },
      skills: {
        count: 1,
        sharedCount: 1,
        agentsCount: 0,
        expectedSharedCount: 1,
        missingShared: ["missing-skill"],
        extraLocal: ["extra-skill"],
        changedShared: ["changed-skill"],
        smoke: { readable: false },
      },
    });

    writeFakeLatestReport("latest-tool-bridge-mode.json", {
      ok: true,
      reportName: "tool-bridge-mode",
      usedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "real-traffic",
      toolBridge: {
        mode: "prompt-only",
        transport: "browser",
        localAdapter: "none",
        nativeAntigravityToolEvents: false,
        nativeMcpDiscoveryVerified: false,
        nativeBridgeDefaultEnabled: false,
        acceptsExternalToolDefinitions: false,
      },
      compatibilityTools: { bridge: "prompt" },
      nativeToolCapability: {
        nativeMcpApprovalProtocolVerified: false,
        nativeMcpPermissionMode: "manual",
        sameCascadeResumeProbeVerified: false,
        antigravityOwnedToolsDisabled: false,
        permissionPromptsDisabled: false,
        disabledToolCount: 0,
        codexToolBridge: "prompt",
      },
    });

    writeFakeLatestReport("latest-model-routing.json", {
      ok: true,
      reportName: "model-routing",
      skipRequests: false,
      modelCount: 2,
      models: ["fake-one"],
      mode: "",
      results: [
        { model: "fake-one", ok: false, skippedRequest: false, error: "should not happen" },
      ],
    });

    writeFakeLatestReport("latest-model-thinking.json", {
      ok: true,
      expectedModelCount: 2,
      actualModelCount: 1,
      models: [
        { id: "fake", display_name: "", reasoning_level: "", supports_thinking: false, thinking_budget: 1, min_thinking_budget: 32 },
        { id: "fake", display_name: "duplicate", reasoning_level: "low", supports_thinking: true, thinking_budget: 16, min_thinking_budget: 32 },
      ],
    });

    writeFakeLatestReport("latest-ui-idle-stability.json", {
      ok: true,
      durationSec: 1,
      sampleCount: 2,
      samples: [
        {
          healthOk: false,
          accountReady: false,
          modelCount: 0,
          uiOk: false,
          hasReconnectText: true,
          hasLoginText: true,
          matchedModelText: "",
        },
      ],
    });

    writeFakeLatestReport("latest-sync-readiness.json", {
      ok: true,
      activeHost: {
        exists: false,
        markerExists: false,
        manifestValid: false,
        exeExists: false,
        productName: "Codex",
        fileDescription: "Codex",
        originalFilename: "Codex.exe",
        hostIconExists: false,
        trayIconExists: false,
        appRootIconExists: false,
        hostIconPalette: { ok: false },
        trayIconPalette: { ok: false },
        appRootIconPalette: { ok: false },
      },
      sync: {
        scriptExists: false,
        launcherExists: false,
        rollbackScriptExists: false,
        rollbackLauncherExists: false,
        updateCheckExists: false,
        validatorExists: false,
        failureSafetyVerifierExists: false,
        installerExists: false,
        startScriptExists: false,
        desktopShortcutIconPalette: { ok: false },
        updateStatus: {
          ok: false,
          updateNeeded: true,
          drift: { state: "changed" },
          guardrails: { brandPreserved: false, iconPreserved: false, activeHostValid: false, failures: ["bad"] },
        },
        shortcutVerification: [
          { ok: false, exists: false, displayNameMatches: false, targetMatches: false, launcherTargetMatches: false, scriptMatches: false, iconMatches: false, forbiddenCodexBranding: true },
        ],
        desktopAntiCodexShortcuts: ["Anti-Codex.lnk", "Helper.lnk"],
        forbiddenDesktopHelperShortcuts: ["Helper.lnk"],
        managerBridge: { processCount: 2, staleProcessCount: 1, processes: [{ hasExpectedBaseUrl: false }] },
        hostSyncMarkerExists: true,
        staleCandidateExists: true,
        rollbackHostExists: false,
        rollbackMarkerExists: false,
        rollbackSwapHostExists: true,
        rollbackSwapMarkerExists: true,
      },
    });

    writeFakeLatestReport("latest-source-preflight.json", {
      ok: true,
      reportName: "wrong-source-preflight",
      failures: ["hidden failure"],
      checks: {
        javascriptSyntax: { ok: false },
        powershellSyntax: { ok: false },
        uiStateSelfTest: { ok: false },
        upstreamProfileStorage: { ok: false },
        localConnectorVerifier: { ok: false },
        publicDocumentation: { ok: false },
        translatorRegression: { ok: false },
        diffWhitespace: { ok: false },
      },
    });

    writeFakeLatestReport("latest-real-third-party-provider.json", {
      ok: true,
      reportName: "wrong-real-third-party-provider",
      skipped: true,
      requestedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "skipped",
      usedRealTraffic: false,
    });

    writeFakeLatestReport("latest-third-party-provider.json", {
      ok: true,
      reportName: "wrong-third-party-provider",
      secretsRedacted: false,
      savedWithoutHistoryLoss: false,
      restoredAntigravityWithoutHistoryLoss: false,
      restartedProviderWithoutHistoryLoss: false,
      switchedProviderWithoutHistoryLoss: false,
      crossProtocolWithoutHistoryLoss: false,
      reverseCrossProtocolWithoutHistoryLoss: false,
      multiTurnHistory: {
        turns: 3,
        providerModelUsedForEveryTurn: false,
        providerSwitch: { requestReachedSecondProvider: false },
        protocolSwitch: { requestReachedAnthropicProvider: false },
        reverseProtocolSwitch: { requestReachedOpenAiCompatibleProvider: false },
        toolHistory: {
          providerSwitchPreservesOpenAiToolPair: false,
          protocolSwitchPreservesAnthropicToolPair: false,
          reverseProtocolSwitchPreservesOpenAiToolPair: false,
          restartPreservesOpenAiToolPair: false,
          structuralEvidence: {
            fifthOpenAiToolEvidence: { protocol: "anthropic", pairedByCallId: false, resultAfterToolCall: false, protocolShapeClean: false },
            sixthOpenAiToolEvidence: { protocol: "anthropic", pairedByCallId: false, resultAfterToolCall: false, protocolShapeClean: false },
            seventhOpenAiToolEvidence: { protocol: "openai-compatible", pairedByCallId: false, resultAfterToolCall: false, protocolShapeClean: false },
            eighthAnthropicToolEvidence: { protocol: "openai-compatible", pairedByCallId: false, resultAfterToolCall: false, protocolShapeClean: false },
            ninthOpenAiToolEvidence: { protocol: "anthropic", pairedByCallId: false, resultAfterToolCall: false, protocolShapeClean: false },
            sixthOrderedHistory: { ok: false, checked: 1 },
          },
        },
        savedContinuationPreviousResponseId: "",
        restartContinuationPreviousResponseId: "",
        previousResponseContinuity: {
          saveMatched: false,
          restartMatched: false,
          providerSwitchMatched: false,
          protocolSwitchMatched: false,
          reverseProtocolSwitchMatched: false,
        },
        fifthAfterSavePreservesHistory: false,
        sixthAfterRestartPreservesHistory: false,
        sixthAfterRestartPreservesAllHistoryMarkers: false,
        sixthAfterRestartAllHistoryMarkerCount: 1,
        seventhAfterProviderSwitchPreservesHistory: false,
        seventhAfterProviderSwitchPreservesAllHistoryMarkers: false,
        seventhAfterProviderSwitchAllHistoryMarkerCount: 1,
        eighthAfterProtocolSwitchPreservesAllHistoryMarkers: false,
        eighthAfterProtocolSwitchAllHistoryMarkerCount: 1,
        ninthAfterReverseProtocolSwitchPreservesAllHistoryMarkers: false,
        ninthAfterReverseProtocolSwitchAllHistoryMarkerCount: 1,
      },
    });

    writeFakeLatestReport("latest-cold-relaunch.json", {
      ok: true,
      reportName: "wrong-cold-relaunch",
      skipped: true,
      requiresConfirmation: true,
      failures: ["original Codex main process set changed"],
      health: {
        ok: false,
        providerReady: false,
        mode: "antigravity",
        upstream: "unknown",
        modelCount: 0,
      },
      processes: {
        mainCount: 2,
        translatorCount: 0,
        launcherCount: 2,
      },
      originalCodex: { unchanged: false },
      stages: [
        { name: "stop-existing-processes", ok: false },
      ],
    });

    writeFakeLatestReport("latest-stability-soak.json", {
      ok: true,
      reportName: "wrong-stability-soak",
      failures: ["translator PID changed"],
      mode: "antigravity",
      model: "",
      providerReady: false,
      startReady: false,
      endReady: false,
      modelCount: 0,
      startPid: 100,
      endPid: 200,
      pidStable: false,
      healthChecks: 0,
      elapsedMs: 10,
      turns: [
        { name: "cn-1", ok: false },
      ],
    });

    const semanticFailures = {};
    semanticFailures.fastOverallNoTraffic = assertSemanticFailures("fastOverallNoTraffic", "self-test failed: semantically invalid fast installed-overall report satisfied the gate", [
      "installed_overall_report_name",
      "installed_overall_fast_flag",
      "installed_overall_no_traffic_flag",
      "installed_overall_used_real_traffic",
      "installed_overall_coverage_kind",
      "installed_overall_behavior_not_covered",
      "installed_overall_fast_elapsed",
      "installed_overall_check_not_ok",
      "installed_overall_skip_metadata_missing",
      "installed_overall_real_traffic_skip_missing",
    ]);
    semanticFailures.installedOverallNoTraffic = assertSemanticFailures("installedOverallNoTraffic", "self-test failed: semantically invalid installed-overall report satisfied the gate", [
      "installed_overall_report_name",
      "installed_overall_fast_flag",
      "installed_overall_no_traffic_flag",
      "installed_overall_used_real_traffic",
      "installed_overall_coverage_kind",
      "installed_overall_behavior_not_covered",
      "installed_overall_check_not_ok",
      "installed_overall_skip_metadata_missing",
      "installed_overall_unexpected_skipped_check",
      "installed_overall_real_traffic_skip_missing",
    ]);
    semanticFailures.noTraffic = assertSemanticFailures("toolBridgeMode", "self-test failed: semantically invalid no-traffic report satisfied the gate", [
      "expected_no_real_traffic",
      "expected_behavior_covered",
      "expected_no_real_traffic_coverage_kind",
      "tool_bridge_mode_not_native_mcp_same_cascade",
      "tool_bridge_transport_not_desktop_cascade",
      "tool_bridge_permission_mode",
      "tool_bridge_same_cascade_resume",
      "tool_bridge_owned_tools_enabled",
      "tool_bridge_codex_bridge",
    ]);
    semanticFailures.modelRouting = assertSemanticFailures("modelRouting", "self-test failed: semantically invalid model-routing report satisfied the gate", [
      "model_routing_skip_requests_not_true",
      "model_routing_models_missing",
      "model_routing_mode_missing",
      "model_routing_results_missing",
      "model_routing_result_not_ok",
      "model_routing_result_not_skipped",
      "model_routing_result_error",
    ]);
    semanticFailures.modelThinking = assertSemanticFailures("modelThinking", "self-test failed: semantically invalid model-thinking report satisfied the gate", [
      "model_thinking_actual_count",
      "model_thinking_models_length",
      "model_thinking_unique_ids",
      "model_thinking_display_name",
      "model_thinking_reasoning_level",
      "model_thinking_supports_thinking",
      "model_thinking_budget",
    ]);
    semanticFailures.uiIdleStability = assertSemanticFailures("uiIdleStability", "self-test failed: semantically invalid ui-idle report satisfied the gate", [
      "ui_idle_duration",
      "ui_idle_samples_missing",
      "ui_idle_health_not_ok",
      "ui_idle_account_not_ready",
      "ui_idle_model_count",
      "ui_idle_ui_not_ok",
      "ui_idle_reconnect_text",
      "ui_idle_login_text",
      "ui_idle_model_text_missing",
    ]);
    semanticFailures.syncReadiness = assertSemanticFailures("syncReadiness", "self-test failed: semantically invalid sync-readiness report satisfied the gate", [
      "sync_readiness_report_name",
      "sync_readiness_no_traffic_attestation",
      "sync_readiness_full_mode_required",
      "sync_readiness_active_host",
      "sync_readiness_brand",
      "sync_readiness_icon_files",
      "sync_readiness_icon_palette",
      "sync_readiness_scripts",
      "sync_readiness_update_status",
      "sync_readiness_operation_state",
      "sync_readiness_source_active_hash_mismatch",
      "sync_readiness_guardrails",
      "sync_readiness_shortcut_count",
      "sync_readiness_shortcuts",
      "sync_readiness_shortcut_inventory",
      "sync_readiness_desktop_shortcuts",
      "sync_readiness_forbidden_desktop_helpers",
      "sync_readiness_manager_bridge",
      "sync_readiness_manager_bridge_base_url",
      "sync_readiness_rollback_host",
      "sync_readiness_rollback_brand",
      "sync_readiness_rollback_icon_palette",
      "sync_readiness_rollback_swap_stale",
      "sync_readiness_clean_state",
    ]);
    semanticFailures.coldRelaunch = assertSemanticFailures("coldRelaunch", "self-test failed: semantically invalid cold-relaunch report satisfied the gate", [
      "cold_relaunch_report_name",
      "cold_relaunch_skipped",
      "cold_relaunch_requires_confirmation",
      "cold_relaunch_failures",
      "cold_relaunch_health_not_ready",
      "cold_relaunch_antigravity_not_ready",
      "cold_relaunch_main_count",
      "cold_relaunch_translator_count",
      "cold_relaunch_launcher_count",
      "cold_relaunch_original_codex_not_proven",
      "cold_relaunch_stage_missing:stop-existing-processes",
      "cold_relaunch_stage_missing:launch-anticodex",
      "cold_relaunch_stage_missing:wait-health-ready",
      "cold_relaunch_original_codex_changed",
    ]);
    semanticFailures.stabilitySoak = assertSemanticFailures("stabilitySoak", "self-test failed: semantically invalid stability-soak report satisfied the gate", [
      "stability_soak_report_name",
      "stability_soak_failures",
      "stability_soak_provider_not_ready",
      "stability_soak_pid_not_stable",
      "stability_soak_health_checks_missing",
      "stability_soak_elapsed_too_short",
      "stability_soak_turn_not_ok",
      "stability_soak_model_count",
    ]);
    semanticFailures.optionalRealTraffic = assertSemanticFailures("realThirdPartyProviderOptional", "self-test failed: semantically invalid optional real-traffic report satisfied the gate", [
      "optional_skipped_requested_real_traffic_not_false",
      "optional_skipped_metadata_missing",
      "optional_requested_real_traffic_uncovered_but_ok",
    ]);
    writeFakeLatestReport("latest-provider-antigravity-return.json", {
      ok: true,
      reportName: "provider-antigravity-return",
      skipped: true,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
    });
    semanticFailures.optionalAntigravitySkipped = assertSemanticFailures("providerAntigravityReturnOptional", "self-test failed: semantically invalid skipped Antigravity-return report satisfied the gate", [
      "optional_skipped_requested_real_traffic_not_false",
      "optional_skipped_used_real_traffic",
      "optional_skipped_behavior_covered",
      "optional_skipped_coverage_kind",
      "optional_skipped_metadata_missing",
      "optional_requested_real_traffic_uncovered_but_ok",
    ]);
    writeFakeLatestReport("latest-real-third-party-provider.json", {
      ok: true,
      reportName: "wrong-real-third-party-provider",
      skipped: false,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      usedRealTraffic: true,
      firstMarkerObserved: false,
      secondMarkerObserved: false,
      historyContinuationObserved: false,
      routeEvidence: {
        transport: "desktop-cascade",
        providerProtocol: "",
        requestedModel: "fake",
        resolvedModel: "",
        status: "failed",
      },
      realProviderToAntigravityReturnEvidence: {
        requested: true,
        realAntigravityTurnUsed: false,
        returnedToAntigravityWithHistory: false,
        previousResponseIdMatched: false,
        markerCount: 1,
        missingMarkerCount: 1,
        returnUpstream: "upstream-provider",
        routeTransport: "upstream-provider",
        requestedModel: "",
        resolvedModel: "",
      },
      secretsRedacted: false,
      turns: 1,
    });
    semanticFailures.optionalRealProvider = assertSemanticFailures("realThirdPartyProviderOptional", "self-test failed: semantically invalid real provider optional report satisfied the gate", [
      "optional_real_traffic_not_requested",
      "optional_real_provider_report_name",
      "optional_real_provider_first_marker_missing",
      "optional_real_provider_second_marker_missing",
      "optional_real_provider_history_missing",
      "optional_real_provider_secrets_not_redacted",
      "optional_real_provider_turn_count",
      "optional_real_provider_route_transport",
      "optional_real_provider_route_protocol",
      "optional_real_provider_route_model",
      "optional_real_provider_route_status",
      "optional_real_provider_return_not_used",
      "optional_real_provider_return_history_missing",
      "optional_real_provider_return_previous_response_id_mismatch",
      "optional_real_provider_return_marker_count",
      "optional_real_provider_return_missing_markers",
      "optional_real_provider_return_upstream_not_antigravity",
      "optional_real_provider_return_route_transport",
      "optional_real_provider_return_requested_model",
      "optional_real_provider_return_resolved_model",
    ]);
    writeFakeLatestReport("latest-provider-antigravity-return.json", {
      ok: true,
      reportName: "wrong-provider-antigravity-return",
      skipped: false,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      usedRealTraffic: true,
      realAntigravityEvidence: {
        requested: false,
        realAntigravityTurnUsed: false,
        returnedToAntigravityWithHistory: false,
        previousResponseIdMatched: false,
        markerCount: 2,
        missingMarkerCount: 1,
        routeTransport: "upstream-provider",
        resolvedModel: "",
      },
    });
    semanticFailures.optionalAntigravityReturn = assertSemanticFailures("providerAntigravityReturnOptional", "self-test failed: semantically invalid Antigravity return optional report satisfied the gate", [
      "optional_real_traffic_not_requested",
      "optional_antigravity_return_report_name",
      "optional_antigravity_return_not_requested",
      "optional_antigravity_return_not_used",
      "optional_antigravity_return_history_missing",
      "optional_antigravity_return_previous_response_id_mismatch",
      "optional_antigravity_return_marker_count",
      "optional_antigravity_return_missing_markers",
      "optional_antigravity_return_route_transport",
      "optional_antigravity_return_resolved_model",
    ]);
    semanticFailures.mcpSkills = assertSemanticFailures("mcpSkills", "self-test failed: semantically invalid MCP/Skill report satisfied the gate", [
      "mcp_skills_missing_shared_mcp",
      "mcp_skills_extra_local_mcp",
      "mcp_skills_changed_shared_mcp",
      "mcp_skills_missing_node_repl",
      "mcp_skills_smoke_not_passed",
      "mcp_skills_real_call_not_passed",
      "mcp_skills_no_agents_skills",
      "mcp_skills_missing_shared_skills",
      "mcp_skills_extra_local_skills",
      "mcp_skills_conflicting_duplicate_skills",
      "mcp_skills_skill_smoke_not_readable",
      "mcp_skills_source_snapshot_missing",
    ]);
    writeFakeLatestReport("latest-refresh-features.json", {
      ok: true,
      reportName: "refresh-features",
      failures: ["parity drift"],
      connectorParity: {
        sharedExists: true,
        localExists: false,
        contentMatches: false,
      },
      appToolParity: {
        sharedExists: true,
        localExists: true,
        contentMatches: false,
      },
      skills: {
        changedExpected: ["changed-skill"],
      },
      guidance: {
        "RTK.md": {
          sharedExists: true,
          localExists: true,
          contentMatches: false,
        },
      },
    });
    semanticFailures.refreshFeatures = assertSemanticFailures("refreshFeatures", "self-test failed: semantically invalid refresh-features report satisfied the gate", [
      "refresh_features_failures",
      "refresh_features_connector_local_missing",
      "refresh_features_connector_parity",
      "refresh_features_app_tool_parity",
      "refresh_features_skill_parity",
      "refresh_features_guidance_parity",
      "refresh_features_source_snapshot_missing",
    ]);
    semanticFailures.sourcePreflight = assertSemanticFailures("sourcePreflight", "self-test failed: semantically invalid source-preflight report satisfied the gate", [
      "source_preflight_report_name",
      "source_preflight_failures",
      "source_preflight_javascript_syntax",
      "source_preflight_powershell_syntax",
      "source_preflight_ui_state_self_test",
      "source_preflight_upstream_profile_storage",
      "source_preflight_local_connector_verifier",
      "source_preflight_public_documentation",
      "source_preflight_translator_regression",
      "source_preflight_diff_whitespace",
    ]);
    semanticFailures.thirdPartyProvider = assertSemanticFailures("thirdPartyProvider", "self-test failed: semantically invalid third-party provider report satisfied the gate", [
      "third_party_provider_report_name",
      "third_party_provider_secrets_not_redacted",
      "third_party_provider_turn_count",
      "third_party_provider_restore_history_loss",
      "third_party_provider_switch_history_loss",
      "third_party_provider_cross_protocol_history_loss",
      "third_party_provider_reverse_protocol_history_loss",
      "third_party_provider_stale_model_used",
      "third_party_provider_openai_tool_pair_lost",
      "third_party_provider_anthropic_tool_pair_lost",
      "third_party_provider_reverse_openai_tool_pair_lost",
      "third_party_provider_restart_openai_tool_pair_lost",
      "third_party_provider_save_structural_tool_evidence",
      "third_party_provider_restart_structural_tool_evidence",
      "third_party_provider_turn6_ordered_history",
      "third_party_provider_turn7_ordered_history",
      "third_party_provider_turn8_ordered_history",
      "third_party_provider_turn9_ordered_history",
      "third_party_provider_save_previous_response_id_missing",
      "third_party_provider_restart_previous_response_id_missing",
      "third_party_provider_switch_previous_response_id_missing",
      "third_party_provider_protocol_previous_response_id_missing",
      "third_party_provider_reverse_protocol_previous_response_id_missing",
      "third_party_provider_switch_nested_previous_response_id_missing",
      "third_party_provider_protocol_nested_previous_response_id_missing",
      "third_party_provider_reverse_protocol_nested_previous_response_id_missing",
      "third_party_provider_save_previous_response_id_mismatch",
      "third_party_provider_restart_previous_response_id_mismatch",
      "third_party_provider_switch_previous_response_id_mismatch",
      "third_party_provider_protocol_previous_response_id_mismatch",
      "third_party_provider_reverse_protocol_previous_response_id_mismatch",
      "third_party_provider_save_marker_coverage",
      "third_party_provider_restart_marker_coverage",
      "third_party_provider_turn6_marker_coverage",
      "third_party_provider_turn7_marker_coverage",
      "third_party_provider_turn8_marker_coverage",
      "third_party_provider_turn9_marker_coverage",
    ]);
    semanticFailures.missingHistory = assertSemanticFailures("missingHistory", "self-test failed: semantically invalid missing-history report satisfied the gate", [
      "missing_history_status_not_410",
      "missing_history_error_type",
      "missing_history_retryable_not_false",
      "missing_history_previous_response_id_not_matched",
      "missing_history_recovery_guidance_missing",
      "missing_history_route_changed",
      "missing_history_used_real_traffic",
    ]);
    semanticFailures.localConnectors = assertSemanticFailures("localConnectors", "self-test failed: semantically invalid local-connector report satisfied the gate", [
      "local_connector_report_name",
      "local_connector_used_real_traffic",
      "local_connector_behavior_not_covered",
      "local_connector_coverage_kind",
      "local_connector_chatgpt_urls_not_scrubbed",
      "local_connector_link_endpoints_not_metadata_only",
      "local_connector_upstream_requests_during_local_endpoints",
      "local_connector_linked_connector_not_accessible",
      "local_connector_allowlist_marked_accessible",
      "local_connector_allowlist_not_recorded",
      "local_connector_hidden_connector_accessible",
      "local_connector_get_post_tool_mismatch",
      "local_connector_unexpected_exposed_tool",
    ]);
    semanticFailures.logDbGuard = assertSemanticFailures("logDbGuard", "self-test failed: semantically invalid log-db guard report satisfied the gate", [
      "log_db_guard_trigger_missing",
      "log_db_guard_not_protected",
    ]);
    semanticFailures.pluginCapabilities = assertSemanticFailures("pluginCapabilities", "self-test failed: semantically invalid plugin-capability report satisfied the gate", [
      "plugin_capabilities_native_codex_writeback",
      "plugin_capabilities_accessible_connector_count",
      "plugin_capabilities_unauthorized_app_tools",
      "plugin_capabilities_app_tool_get_post_mismatch",
      "plugin_capabilities_local_connector_parity_missing_shared",
      "plugin_capabilities_local_connector_parity_extra_local",
      "plugin_capabilities_local_connector_parity_changed_shared",
      "plugin_capabilities_local_app_tool_parity_missing_shared",
      "plugin_capabilities_local_app_tool_parity_extra_local",
      "plugin_capabilities_local_app_tool_parity_changed_shared",
      "plugin_capabilities_source_snapshot_missing",
    ]);
    writeFakeLatestReport("latest-refresh-features.json", {
      ok: true,
      reportName: "refresh-features",
      failures: [],
      connectorParity: { sharedExists: true, localExists: true, contentMatches: true },
      appToolParity: { sharedExists: true, localExists: true, contentMatches: true },
      skills: { changedExpected: [] },
      guidance: { "RTK.md": { sharedExists: true, localExists: true, contentMatches: true } },
      sourceSnapshot: { fingerprint: "fresh-source", fileCount: 3, sourceMtimeMax: "2026-06-23T00:00:00.000Z" },
    });
    writeFakeLatestReport("latest-mcp-skills.json", {
      ok: true,
      mcp: {
        count: 1,
        sharedCount: 1,
        missingShared: [],
        extraLocal: [],
        changedShared: [],
        hasNodeRepl: true,
        smoke: { passed: true, realCall: { passed: true } },
      },
      skills: {
        count: 2,
        sharedCount: 1,
        agentsCount: 1,
        expectedSharedCount: 2,
        missingShared: [],
        changedShared: [],
        conflictingDuplicateNames: [],
        smoke: { readable: true },
      },
      sourceSnapshot: { fingerprint: "stale-mcp-source", fileCount: 3, sourceMtimeMax: "2026-06-23T00:00:00.000Z" },
    });
    writeFakeLatestReport("latest-plugin-capabilities.json", {
      ok: true,
      capabilities: {
        nativeCodexWriteback: false,
        accessibleConnectorCount: 0,
        unauthorizedAppToolCount: 0,
        connectorParity: { missingShared: [], extraLocal: [], changedShared: [] },
        appToolParity: { missingShared: [], extraLocal: [], changedShared: [] },
        appToolGetPostParity: { missingFromGet: [], extraFromGet: [] },
      },
      sourceSnapshot: { fingerprint: "stale-plugin-source", fileCount: 3, sourceMtimeMax: "2026-06-23T00:00:00.000Z" },
    });
    const crossSourceGates = gateDefinitions.map(summarizeGate);
    const crossMcpGate = crossSourceGates.find((gate) => gate.id === "mcpSkills");
    const crossPluginGate = crossSourceGates.find((gate) => gate.id === "pluginCapabilities");
    if (crossMcpGate?.sourceFingerprint && crossPluginGate?.sourceFingerprint && crossMcpGate.sourceFingerprint !== crossPluginGate.sourceFingerprint) {
      for (const [gate, failure] of [
        [crossMcpGate, "mcp_skills_source_snapshot_mismatch"],
        [crossPluginGate, "plugin_capabilities_source_snapshot_mismatch"],
      ]) {
        if (!Array.isArray(gate.semanticFailures)) gate.semanticFailures = [];
        gate.semanticFailures.push(failure);
      }
    }
    semanticFailures.sourceSnapshotMismatch = {
      mcpSkills: crossSourceGates.find((gate) => gate.id === "mcpSkills")?.semanticFailures || [],
      pluginCapabilities: crossSourceGates.find((gate) => gate.id === "pluginCapabilities")?.semanticFailures || [],
    };
    if (!semanticFailures.sourceSnapshotMismatch.mcpSkills.includes("mcp_skills_source_snapshot_mismatch")) throw new Error("self-test failed: MCP/Skill source snapshot mismatch was not detected");
    if (!semanticFailures.sourceSnapshotMismatch.pluginCapabilities.includes("plugin_capabilities_source_snapshot_mismatch")) throw new Error("self-test failed: plugin-capability source snapshot mismatch was not detected");
    const fakeSourceRoot = join(tempRoot, "source");
    const fakeTargetRuntime = join(tempRoot, "runtime");
    for (const relativePath of runtimeSyncFiles) {
      const sourcePath = join(fakeSourceRoot, ...relativePath.split("/"));
      const targetPath = join(fakeTargetRuntime, ...relativePath.split("/"));
      mkdirSync(dirname(sourcePath), { recursive: true });
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(sourcePath, `source:${relativePath}`, "utf8");
      writeFileSync(targetPath, `target:${relativePath}`, "utf8");
    }
    const originalSourceRoot = args.get("--source-root");
    const originalTargetRuntime = args.get("--target-runtime");
    args.set("--source-root", fakeSourceRoot);
    args.set("--target-runtime", fakeTargetRuntime);
    const runtimeGate = summarizeInstalledRuntimeSyncGate();
    if (originalSourceRoot === undefined) args.delete("--source-root"); else args.set("--source-root", originalSourceRoot);
    if (originalTargetRuntime === undefined) args.delete("--target-runtime"); else args.set("--target-runtime", originalTargetRuntime);
    semanticFailures.installedRuntimeSync = runtimeGate.semanticFailures || [];
    if (!semanticFailures.installedRuntimeSync.includes("installed_runtime_hash_mismatch")) throw new Error("self-test failed: installed runtime hash mismatch was not detected");
    if (!semanticFailures.installedRuntimeSync.includes("installed_runtime_fingerprint_mismatch")) throw new Error("self-test failed: installed runtime fingerprint mismatch was not detected");
    console.log(JSON.stringify({ ok: true, selfTest: true, semanticFailures }));
  } finally {
    reportRoot = originalReportRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  }
  process.exit(0);
}

const gates = [...gateDefinitions.map(summarizeGate), summarizeInstalledRuntimeSyncGate()];
function addSemanticFailure(gateId, failure) {
  const gate = gates.find((item) => item.id === gateId);
  if (!gate) return;
  if (!Array.isArray(gate.semanticFailures)) gate.semanticFailures = [];
  if (!gate.semanticFailures.includes(failure)) gate.semanticFailures.push(failure);
  gate.satisfied = gate.present && gate.parseable && gate.hashValid === true && gate.okField === true && gate.fresh === true && gate.semanticFailures.length === 0;
}

const mcpSkillGate = gates.find((gate) => gate.id === "mcpSkills");
const pluginCapabilityGate = gates.find((gate) => gate.id === "pluginCapabilities");
if (mcpSkillGate?.sourceFingerprint && pluginCapabilityGate?.sourceFingerprint && mcpSkillGate.sourceFingerprint !== pluginCapabilityGate.sourceFingerprint) {
  addSemanticFailure("mcpSkills", "mcp_skills_source_snapshot_mismatch");
  addSemanticFailure("pluginCapabilities", "plugin_capabilities_source_snapshot_mismatch");
}
const requiredRelease = gates.filter((gate) => gate.requiredForRelease);
const requiredShort = gates.filter((gate) => gate.requiredForShort);
const missingRequired = requiredRelease.filter((gate) => !gate.satisfied).map((gate) => gate.id);
const missingShort = requiredShort.filter((gate) => !gate.satisfied).map((gate) => gate.id);
const missingOptional = gates.filter((gate) => !gate.requiredForRelease && !gate.satisfied).map((gate) => gate.id);
const damagedReports = gates.filter((gate) => gate.present && (!gate.parseable || gate.hashValid !== true)).map((gate) => gate.id);
const optionalRealTrafficGates = gates.filter((gate) => gate.group === "optional-real-traffic");
const optionalRealTrafficFailures = optionalRealTrafficGates
  .filter((gate) => !gate.satisfied || gate.requestedRealTraffic !== true || gate.usedRealTraffic !== true || gate.behaviorCovered !== true || gate.coverageKind !== "real-traffic")
  .map((gate) => gate.id);
const optionalRealTrafficReady = optionalRealTrafficFailures.length === 0;
const groups = Object.fromEntries([...new Set(gates.map((gate) => gate.group))].map((group) => {
  const groupGates = gates.filter((gate) => gate.group === group);
  return [group, {
    total: groupGates.length,
    satisfied: groupGates.filter((gate) => gate.satisfied).length,
    required: groupGates.filter((gate) => gate.requiredForRelease).length,
    requiredSatisfied: groupGates.filter((gate) => gate.requiredForRelease && gate.satisfied).length,
    optional: groupGates.filter((gate) => !gate.requiredForRelease).length,
    optionalSatisfied: groupGates.filter((gate) => !gate.requiredForRelease && gate.satisfied).length,
    missingRequired: groupGates.filter((gate) => gate.requiredForRelease && !gate.satisfied).map((gate) => gate.id),
    missingOptional: groupGates.filter((gate) => !gate.requiredForRelease && !gate.satisfied).map((gate) => gate.id),
  }];
}));

const releaseReady = missingRequired.length === 0 && (!strictOptionalRealTraffic || optionalRealTrafficReady);
const shortReady = missingShort.length === 0;
const payload = {
  ok: strict ? releaseReady && damagedReports.length === 0 : true,
  releaseReady,
  shortReady,
  strict,
  strictOptionalRealTraffic,
  optionalRealTrafficReady,
  optionalRealTrafficFailures,
  reportName: "release-gates",
  elapsedMs: Date.now() - startedAt,
  reportRoot,
  maxAgeHours,
  missingRequired,
  missingShort,
  missingOptional,
  damagedReports,
  groups,
  gates,
};
writeJsonReportAtomic(payload);
process.stdout.write(JSON.stringify(payload));
