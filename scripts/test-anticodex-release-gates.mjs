#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
const compactStatus = args.has("--compact-status") || args.has("--status");
const startedAt = Date.now();
const REQUIRED_WORKER_MCP_SERVERS = [
  "antigravity-code-worker",
  "deepseek-code-worker",
  "deveco-code-worker",
  "kilo-worker",
  "mimo-claude-coworker",
  "mimocode-worker",
  "opencode-worker",
];
const REQUIRED_WORKER_MCP_TASK_SMOKE_PASSED_WORKERS = 5;
const REPORT_READ_RETRY_COUNT = 4;
const REPORT_READ_RETRY_DELAY_MS = 75;
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
  "scripts/anticodex-manager-open-inject.js",
  "scripts/anticodex-report-io.ps1",
  "scripts/anticodex-powershell-json-invoke.ps1",
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
  "scripts/test-anticodex-ambient-suggestions.ps1",
  "scripts/prepare-anticodex-antigravity-cli-profile.ps1",
  "scripts/start-anticodex-antigravity-cli-login.ps1",
  "scripts/start-anticodex-antigravity-cli-login-windows-user.ps1",
  "scripts/start-anticodex-second-antigravity-account-login.ps1",
  "scripts/test-anticodex-second-account-login-entrypoint.ps1",
  "scripts/test-anticodex-windows-user-setup-guidance.ps1",
  "scripts/test-anticodex-antigravity-cli-dual-account-lanes.ps1",
  "scripts/test-anticodex-antigravity-cli-windows-user-readiness.ps1",
  "scripts/test-anticodex-antigravity-account-isolation-status.ps1",
  "scripts/test-anticodex-antigravity-cli-real-smoke.ps1",
  "scripts/test-anticodex-windows-user-account-prepare.ps1",
  "scripts/test-anticodex-local-connectors.mjs",
  "scripts/test-anticodex-manager-action.ps1",
  "scripts/test-anticodex-manager-button.mjs",
  "scripts/test-anticodex-manager-real-buttons.ps1",
  "scripts/test-anticodex-mcp-skills.ps1",
  "scripts/probe-anticodex-worker-mcp-servers.mjs",
  "scripts/test-anticodex-worker-mcp-status-probe.mjs",
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
  "scripts/test-anticodex-real-report-site.ps1",
  "scripts/test-anticodex-real-small-project.ps1",
  "scripts/test-anticodex-source-preflight.ps1",
  "scripts/test-anticodex-stability-soak.ps1",
  "scripts/test-anticodex-sync-readiness.ps1",
  "scripts/test-anticodex-third-party-provider.mjs",
  "scripts/test-anticodex-tool-bridge-mode.ps1",
  "scripts/test-anticodex-tool-loop.ps1",
  "scripts/test-anticodex-desktop-task-suite.mjs",
  "scripts/test-anticodex-cli-transport-boundary.mjs",
  "scripts/test-anticodex-long-task-landing-matrix.mjs",
  "scripts/test-anticodex-native-codex-parity-tasks.mjs",
  "scripts/test-anticodex-agentic-capability-matrix.mjs",
  "scripts/test-anticodex-goal-readiness.mjs",
  "scripts/test-anticodex-goal-real-run-readiness.mjs",
  "scripts/test-anticodex-real-task-coverage-roadmap.mjs",
  "scripts/test-anticodex-real-approval-plan.mjs",
  "scripts/test-anticodex-required-real-traffic-sequence.ps1",
  "scripts/test-anticodex-approved-real-run-sequence.mjs",
  "scripts/test-anticodex-ui-chat-smoke.mjs",
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

const allowedAntiCodexPatchScope = ["branding", "icons", "shortcuts", "isolation", "launcher", "model-adapter"];
const requiredAgenticDesktopTaskSuiteTasks = ["coding-project", "multi-turn-project", "report-site", "complex-project", "autonomous-reasoning", "agentic-step-flow", "repo-multi-file-edit"];

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
  { id: "antigravityCliRealSmokeOptional", group: "optional-real-traffic", file: "latest-antigravity-cli-real-smoke.json", requiredForRelease: false, requireOptionalRealTrafficSemantics: true },

  { id: "installedOverallNoTraffic", group: "no-traffic", file: "latest-installed-overall.json", requiredForRelease: true, requireInstalledOverallSemantics: true, expectedFast: false, expectedReportName: "installed-overall", expectedCoverageKind: "installed-no-traffic" },
  { id: "modelRouting", group: "no-traffic", file: "latest-model-routing.json", requiredForRelease: true, requireModelRoutingSemantics: true },
  { id: "logDbGuard", group: "no-traffic", file: "latest-log-db-guard.json", requiredForRelease: true, requireLogDbGuardSemantics: true },
  { id: "toolBridgeMode", group: "no-traffic", file: "latest-tool-bridge-mode.json", requiredForRelease: true, requireToolBridgeSemantics: true },
  { id: "uiIdleStability", group: "no-traffic", file: "latest-ui-idle-stability.json", requiredForRelease: true, requireUiIdleSemantics: true },
  { id: "syncReadiness", group: "no-traffic", file: "latest-sync-readiness.json", requiredForRelease: true, requireSyncReadinessSemantics: true },
  { id: "modelThinking", group: "no-traffic", file: "latest-model-thinking.json", requiredForRelease: true, requireModelThinkingSemantics: true },
  { id: "ambientSuggestions", group: "no-traffic", file: "latest-ambient-suggestions.json", requiredForRelease: true, requireAmbientSuggestionSemantics: true },
  { id: "antigravityCliWindowsUserReadiness", group: "no-traffic", file: "latest-antigravity-cli-windows-user-readiness.json", requiredForRelease: true, requireAntigravityCliWindowsUserReadinessSemantics: true },
  { id: "windowsUserAccountPrepare", group: "no-traffic", file: "latest-windows-user-account-prepare.json", requiredForRelease: true, requireWindowsUserAccountPrepareSemantics: true },
  { id: "windowsUserSetupGuidance", group: "no-traffic", file: "latest-windows-user-setup-guidance.json", requiredForRelease: true, requireWindowsUserSetupGuidanceSemantics: true },
  { id: "antigravityAccountIsolationStatus", group: "no-traffic", file: "latest-antigravity-account-isolation-status.json", requiredForRelease: true, requireAntigravityAccountIsolationStatusSemantics: true },
  { id: "secondAccountLoginEntrypoint", group: "no-traffic", file: "latest-second-antigravity-account-login-entrypoint.json", requiredForRelease: true, requireSecondAccountLoginEntrypointSemantics: true },
  { id: "secondAccountReadinessSummary", group: "no-traffic", file: "latest-second-account-readiness-summary.json", requiredForRelease: true, requireSecondAccountReadinessSummarySemantics: true },
  { id: "secondAccountPostLoginProof", group: "no-traffic", file: "latest-second-account-post-login-proof.json", requiredForRelease: true, requireSecondAccountPostLoginProofSemantics: true },
  { id: "cliTransportBoundary", group: "no-traffic", file: "latest-cli-transport-boundary.json", requiredForRelease: true, requireCliTransportBoundarySemantics: true },
  { id: "longTaskLandingMatrix", group: "no-traffic", file: "latest-long-task-landing-matrix.json", requiredForRelease: true, requireLongTaskLandingMatrixSemantics: true },
  { id: "agenticCapabilityMatrix", group: "no-traffic", file: "latest-agentic-capability-matrix.json", requiredForRelease: true, requireAgenticCapabilityMatrixSemantics: true },
  { id: "realTaskCoverageRoadmap", group: "no-traffic", file: "latest-real-task-coverage-roadmap.json", requiredForRelease: true, requireRealTaskCoverageRoadmapSemantics: true },
  { id: "nativeCodexParityTaskMatrix", group: "no-traffic", file: "latest-native-codex-parity-task-matrix.json", requiredForRelease: true, requireNativeCodexParityTaskMatrixSemantics: true },
  { id: "realApprovalPlan", group: "no-traffic", file: "latest-real-approval-plan.json", requiredForRelease: true, requireRealApprovalPlanSemantics: true },
  { id: "goalReadiness", group: "no-traffic", file: "latest-goal-readiness.json", requiredForRelease: true, requireGoalReadinessSemantics: true },
  { id: "requiredRealTrafficSequence", group: "no-traffic", file: "latest-required-real-traffic-sequence.json", requiredForRelease: true, requireRequiredRealTrafficSequenceSemantics: true },
  { id: "goalRealRunReadiness", group: "no-traffic", file: "latest-goal-real-run-readiness.json", requiredForRelease: true, requireGoalRealRunReadinessSemantics: true },
  { id: "approvedRealRunSequence", group: "no-traffic", file: "latest-approved-real-run-sequence.json", requiredForRelease: true, requireApprovedRealRunSequenceSemantics: true },

  { id: "postVerification", group: "real-traffic", file: "latest-post-verification.json", requiredForRelease: true, requireUsedRealTraffic: true, requirePostVerificationSemantics: true },
  { id: "codexResponses", group: "real-traffic", file: "latest-codex-responses.json", requiredForRelease: true, requireCodexResponsesSemantics: true },
  { id: "uiChatSmoke", group: "real-traffic", file: "latest-ui-chat-smoke.json", requiredForRelease: true, requireUiChatSmokeSemantics: true },
  { id: "uiWebSearchSmoke", group: "real-traffic", file: "latest-ui-web-search-smoke.json", requiredForRelease: true, requireUiTaskSmokeSemantics: { reportName: "ui-web-search-smoke", taskMode: "web-search", prefix: "ui_web_search_smoke", requireSourceUrls: true } },
  { id: "uiLocalProjectSmoke", group: "real-traffic", file: "latest-ui-local-project-smoke.json", requiredForRelease: true, requireUiTaskSmokeSemantics: { reportName: "ui-local-project-smoke", taskMode: "local-project", prefix: "ui_local_project_smoke", requiredFiles: ["indexHtml", "readmeMd", "doneTxt"] } },
  { id: "uiCodingProjectSmoke", group: "real-traffic", file: "latest-ui-coding-project-smoke.json", requiredForRelease: true, requireUiTaskSmokeSemantics: { reportName: "ui-coding-project-smoke", taskMode: "coding-project", prefix: "ui_coding_project_smoke", requiredFiles: ["packageJson", "wordTally", "testFile", "doneTxt"], requirePromptLanguage: "zh", requireCodingProject: true } },
  { id: "uiMultiTurnProjectSmoke", group: "real-traffic", file: "latest-ui-multi-turn-project-smoke.json", requiredForRelease: true, requireUiTaskSmokeSemantics: { reportName: "ui-multi-turn-project-smoke", taskMode: "multi-turn-project", prefix: "ui_multi_turn_project_smoke", requiredFiles: ["packageJson", "wordTally", "testFile", "doneTxt", "followupTxt", "changelogMd"], requirePromptLanguage: "zh", requireFollowupPromptLanguage: "zh", requireMultiTurnProject: true } },
  { id: "uiRepoFileEditSmoke", group: "real-traffic", file: "latest-ui-repo-file-edit-smoke.json", requiredForRelease: true, requireUiTaskSmokeSemantics: { reportName: "ui-repo-file-edit-smoke", taskMode: "repo-file-edit", prefix: "ui_repo_file_edit_smoke", requiredFiles: ["target", "test"], markerOptional: true, requireRepoFileEdit: true } },
  { id: "uiRepoMultiFileEditSmoke", group: "real-traffic", file: "latest-ui-repo-multi-file-edit-smoke.json", requiredForRelease: true, requireUiTaskSmokeSemantics: { reportName: "ui-repo-multi-file-edit-smoke", taskMode: "repo-multi-file-edit", prefix: "ui_repo_multi_file_edit_smoke", requiredFiles: ["source", "test", "data", "readme", "html"], markerOptional: true, requireRepoMultiFileEdit: true } },
  { id: "uiComplexProjectSmoke", group: "real-traffic", file: "latest-ui-complex-project-smoke.json", requiredForRelease: true, requireUiTaskSmokeSemantics: { reportName: "ui-complex-project-smoke", taskMode: "complex-project", prefix: "ui_complex_project_smoke", requiredFiles: ["packageJson", "analyzer", "testFile", "sourcesJson", "reportMd", "indexHtml", "doneTxt"], requireSourceJsonUrls: 3, requireCodingProject: true, requireReportSite: true } },
  { id: "uiReportSiteSmoke", group: "real-traffic", file: "latest-ui-report-site-smoke.json", requiredForRelease: true, requireUiTaskSmokeSemantics: { reportName: "ui-report-site-smoke", taskMode: "report-site", prefix: "ui_report_site_smoke", requiredFiles: ["reportMd", "indexHtml", "doneTxt"], requireReportSite: true } },
  { id: "desktopTaskSuite", group: "real-traffic", file: "latest-desktop-task-suite.json", requiredForRelease: true, requireDesktopTaskSuiteSemantics: true },
  { id: "toolLoop", group: "real-traffic", file: "latest-tool-loop.json", requiredForRelease: true, requireToolLoopSemantics: "standard" },
  { id: "nativeToolLoop", group: "real-traffic", file: "latest-native-tool-loop.json", requiredForRelease: false, requireToolLoopSemantics: "native", note: "Opt-in native bridge diagnostic; default Anti-Codex uses Codex-owned tools over the CLI model transport." },
  { id: "nativeMultiToolLoop", group: "real-traffic", file: "latest-native-multi-tool-loop.json", requiredForRelease: false, requireToolLoopSemantics: "native-multi", note: "Opt-in native bridge diagnostic; default Anti-Codex uses Codex-owned tools over the CLI model transport." },
  { id: "mcpToolLoop", group: "real-traffic", file: "latest-mcp-tool-loop.json", requiredForRelease: true, requireToolLoopSemantics: "mcp" },
  { id: "customToolLoop", group: "real-traffic", file: "latest-custom-tool-loop.json", requiredForRelease: true, requireToolLoopSemantics: "custom" },
  { id: "compactionResume", group: "real-traffic", file: "latest-compaction-resume.json", requiredForRelease: true, requireCompactionResumeSemantics: true },
  { id: "cancellation", group: "real-traffic", file: "latest-cancellation.json", requiredForRelease: true, requireCancellationSemantics: true },
  { id: "webTools", group: "real-traffic", file: "latest-web-tools.json", requiredForRelease: true, requireWebToolsSemantics: true },
  { id: "realMiniTool", group: "real-traffic", file: "latest-real-mini-tool.json", requiredForRelease: true, requireRealMiniToolSemantics: true },
  { id: "realWork", group: "real-traffic", file: "latest-real-work.json", requiredForRelease: true, requireRealWorkSemantics: true },
  { id: "realSmallProject", group: "real-traffic", file: "latest-real-small-project.json", requiredForRelease: true, requireRealSmallProjectSemantics: true },
  { id: "accountProxyReadiness", group: "real-traffic", file: "latest-account-proxy-readiness.json", requiredForRelease: true, requireAccountProxySemantics: true },

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

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function readSignedJsonWithRetry(filePath, options = {}) {
  const retryCount = Number.isFinite(Number(options.retryCount)) ? Math.max(1, Number(options.retryCount)) : REPORT_READ_RETRY_COUNT;
  const retryDelayMs = Number.isFinite(Number(options.retryDelayMs)) ? Math.max(0, Number(options.retryDelayMs)) : REPORT_READ_RETRY_DELAY_MS;
  let lastResult = {
    report: null,
    parseable: false,
    integrity: { signed: false, valid: null, error: "missing_report" },
    retryCount: 0,
    error: "missing_report",
  };
  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    const integrity = integrityFor(filePath);
    let parseError = "";
    if (integrity.signed === true && integrity.valid === true) {
      try {
        const report = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
        return { report, parseable: true, integrity, retryCount: attempt, error: "" };
      } catch (error) {
        parseError = error instanceof Error ? error.message : "parse_error";
      }
    }
    lastResult = {
      report: null,
      parseable: false,
      integrity,
      retryCount: attempt,
      error: parseError || integrity.error || "unreadable_report",
    };
    if (attempt + 1 < retryCount) sleepSync(retryDelayMs);
  }
  return lastResult;
}

function loadSignedJson(filePath) {
  if (!existsSync(filePath)) return null;
  return readSignedJsonWithRetry(filePath).report;
}

function syncReadinessFullEnough(report) {
  return !!report
    && report.reportName === "sync-readiness"
    && report.ok === true
    && report.fast === false
    && report.skipIconPaletteProbe === false
    && report.noTraffic === true
    && report.usedRealTraffic === false
    && report.behaviorCovered === true
    && report.coverageKind === "installed-no-traffic"
    && report.sync?.managerBridge?.processCount === 1
    && report.sync?.managerBridge?.staleProcessCount === 0
    && report.sync?.managerBridge?.expectedBaseUrl === "http://127.0.0.1:8484";
}

function syncReadinessSourceEvidence(report) {
  const contract = report?.clientSyncContract || {};
  const source = report?.sync?.updateStatus?.source || {};
  return {
    packageName: String(contract.sourcePackageName || source.packageName || ""),
    packageVersion: String(contract.sourcePackageVersion || source.packageVersion || ""),
    hostHash: String(source.hostHash || ""),
    cliHash: String(source.cliHash || ""),
  };
}

function syncReadinessSourceEvidenceMatches(report, reference) {
  const evidence = syncReadinessSourceEvidence(report);
  const fields = ["packageName", "packageVersion", "hostHash", "cliHash"].filter((field) => reference?.[field]);
  return fields.length === 0 || fields.every((field) => evidence[field] === reference[field]);
}

function selectReportPath(definition) {
  const latestPath = join(reportRoot, definition.file);
  if (definition.id !== "syncReadiness") return { path: latestPath, selectedFromHistory: false };
  const latestReport = loadSignedJson(latestPath);
  if (syncReadinessFullEnough(latestReport)) return { path: latestPath, selectedFromHistory: false };
  const latestSourceEvidence = syncReadinessSourceEvidence(latestReport);
  if (!existsSync(reportRoot)) return { path: latestPath, selectedFromHistory: false };
  const candidates = readdirSync(reportRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{8}-\d{6}-sync-readiness\.json$/i.test(entry.name))
    .map((entry) => join(reportRoot, entry.name))
    .filter((filePath) => {
      const ageHours = (Date.now() - statSync(filePath).mtimeMs) / 3_600_000;
      return Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? ageHours <= maxAgeHours : true;
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  let mismatchedHistory = null;
  for (const candidate of candidates) {
    const candidateReport = loadSignedJson(candidate);
    if (syncReadinessFullEnough(candidateReport)) {
      if (!syncReadinessSourceEvidenceMatches(candidateReport, latestSourceEvidence)) {
        mismatchedHistory ||= candidate;
        continue;
      }
      return { path: candidate, selectedFromHistory: true };
    }
  }
  if (mismatchedHistory) return { path: mismatchedHistory, selectedFromHistory: true, historySourceMismatch: true };
  return { path: latestPath, selectedFromHistory: false };
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

function installedRuntimeEvidenceFromGate(gate) {
  if (!gate || typeof gate !== "object") return null;
  return {
    satisfied: gate.satisfied === true,
    sourceFingerprint: typeof gate.sourceFingerprint === "string" ? gate.sourceFingerprint : "",
    installedRuntimeFingerprint: typeof gate.installedRuntimeFingerprint === "string" ? gate.installedRuntimeFingerprint : "",
    sourceFileCount: Number.isFinite(Number(gate.sourceFileCount)) ? Number(gate.sourceFileCount) : null,
    installedRuntimeFileCount: Number.isFinite(Number(gate.installedRuntimeFileCount)) ? Number(gate.installedRuntimeFileCount) : null,
    sourceMtimeMax: typeof gate.sourceMtimeMax === "string" ? gate.sourceMtimeMax : "",
    installedRuntimeMtimeMax: typeof gate.installedRuntimeMtimeMax === "string" ? gate.installedRuntimeMtimeMax : "",
    missingSourceFiles: Array.isArray(gate.missingSourceFiles) ? gate.missingSourceFiles.slice(0, 8) : [],
    missingInstalledRuntimeFiles: Array.isArray(gate.missingInstalledRuntimeFiles) ? gate.missingInstalledRuntimeFiles.slice(0, 8) : [],
    mismatchedRuntimeFiles: Array.isArray(gate.mismatchedRuntimeFiles) ? gate.mismatchedRuntimeFiles.slice(0, 8) : [],
  };
}

function isEmptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function hasSuccessfulDocAssertion(check, file, name) {
  const assertions = Array.isArray(check?.assertions) ? check.assertions : [];
  return assertions.some((item) => item?.file === file && item?.name === name && item?.ok === true);
}

function repoMultiSettleEvidenceOk(value, phase) {
  return value && typeof value === "object"
    && value.ok === true
    && value.kind === "artifact_idle_without_history_wait"
    && value.phase === phase
    && value.historyToolOutputRequired === false
    && value.artifactComplete === true
    && value.inLoopIdleObserved === true
    && value.diagnostics
    && typeof value.diagnostics === "object";
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
  const selection = selectReportPath(definition);
  const filePath = selection.path;
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
    selectedKind: selection.selectedFromHistory ? "history" : "latest",
    selectedMtime: "",
    satisfied: false,
    note: definition.note || "",
    error: present ? "" : "missing_report",
    selectedFromHistory: selection.selectedFromHistory === true,
    historySourceMismatch: selection.historySourceMismatch === true,
    selectedFile: filePath.split(/[\\/]/).pop(),
    reportFailureSamples: [],
    reportReadRetryCount: 0,
  };
  if (!present) return gate;

  const stat = statSync(filePath);
  gate.selectedMtime = stat.mtime.toISOString();
  const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
  gate.ageHours = Math.max(0, Number(ageHours.toFixed(3)));
  gate.fresh = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? ageHours <= maxAgeHours : true;
  const readResult = readSignedJsonWithRetry(filePath);
  const integrity = readResult.integrity || {};
  gate.signed = integrity.signed === true;
  gate.hashValid = integrity.valid;
  gate.reportReadRetryCount = readResult.retryCount || 0;
  if (integrity.error) gate.error = integrity.error;
  if (readResult.error) gate.error = readResult.error;

  const report = readResult.report;
  if (!readResult.parseable || !report) return gate;

  try {
    gate.parseable = true;
    gate.okField = report.ok === true;
    gate.reportName = typeof report.reportName === "string" ? report.reportName : "";
    gate.failureCount = Array.isArray(report.failures) ? report.failures.length : 0;
    gate.reportFailureSamples = Array.isArray(report.failures) ? report.failures.map((item) => String(item)).filter(Boolean).slice(0, 3) : [];
    gate.reportFailureSampleCodes = reportFailureSampleCodes(gate.reportFailureSamples);
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
    gate.sourceSnapshotReused = sourceSnapshot.reusedFromPreviousReport === true;
    const semanticFailures = [];
    if (definition.requireFastNoTraffic && (report.fast !== true || report.noTraffic !== true)) {
      semanticFailures.push("expected_fast_no_traffic");
    }
    if (definition.requireInstalledOverallSemantics) {
      const checks = report.checks && typeof report.checks === "object" ? report.checks : {};
      const entries = Object.entries(checks).map(([id, value]) => ({ id, value: value && typeof value === "object" ? value : {} }));
      const skippedEntries = entries.filter((entry) => entry.value.skipped === true);
      const managerVerifierBusyEntries = entries.filter((entry) => entry.value.coverageKind === "manager-verifier-lock-busy"
        || entry.value.reason === "Manager/UI verifier lock is already held; rerun installed overall serially");
      const allowedFullSkipped = new Set([
        "managerButtonSafeActions",
        "managerButtonReportActions",
        "managerButtonDiagnosticsBundle",
        "managerButtonMcpSkills",
        "managerButtonPluginCapabilities",
        "managerAction",
        "uiIdleStability",
        "mcpSkills",
        "pluginCapabilities",
        "realThirdPartyProviderOptional",
        "providerAntigravityReturnOptional",
        "antigravityCliRealSmokeOptional",
        "realMiniTool",
        "realWork",
        "realSmallProject",
      ]);
      if (report.reportName !== definition.expectedReportName) semanticFailures.push("installed_overall_report_name");
      if (report.fast !== definition.expectedFast) semanticFailures.push("installed_overall_fast_flag");
      if (report.noTraffic !== true) semanticFailures.push("installed_overall_no_traffic_flag");
      if (report.usedRealTraffic !== false) semanticFailures.push("installed_overall_used_real_traffic");
      if (report.coverageKind !== definition.expectedCoverageKind) semanticFailures.push("installed_overall_coverage_kind");
      if (report.behaviorCovered !== true) semanticFailures.push("installed_overall_behavior_not_covered");
      if (definition.expectedFast && Number(report.fastMaxElapsedMs || 0) > 0 && Number(report.elapsedMs || 0) > Number(report.fastMaxElapsedMs)) semanticFailures.push("installed_overall_fast_elapsed");
      const health = report.health && typeof report.health === "object" ? report.health : {};
      if (health.mode === "antigravity" || health.mode === undefined || health.mode === "") {
        const allowedModelDiscoverySources = new Set(["antigravity-desktop-catalog", "antigravity-cli-catalog", "antigravity-entitlement-catalog"]);
        if (health.modelTextTransport !== "desktop-cascade") semanticFailures.push("installed_overall_model_text_transport_not_desktop_cascade");
        if (typeof health.modelDiscoverySource !== "string" || !health.modelDiscoverySource) semanticFailures.push("installed_overall_model_discovery_source_missing");
        else if (!allowedModelDiscoverySources.has(health.modelDiscoverySource)) semanticFailures.push("installed_overall_model_discovery_source_not_allowed");
        if (health.antigravityCoworkerDefault !== false) semanticFailures.push("installed_overall_antigravity_coworker_default_not_false");
      }
      if (entries.length < 1) semanticFailures.push("installed_overall_checks_missing");
      const nonBlockingHostSyncCheck = (entry) => entry.id === "syncReadiness"
        && entry.value.ok !== true
        && entry.value.hostSyncRequired === true
        && entry.value.overallBlocking === false
        && entry.value.releaseBlocking === true
        && entry.value.overallClassification === "host_sync_required_not_runtime_unusable";
      if (entries.some((entry) => entry.value.ok !== true && !nonBlockingHostSyncCheck(entry))) semanticFailures.push("installed_overall_check_not_ok");
      if (skippedEntries.some((entry) => !entry.value.reason || !entry.value.coveredBy)) semanticFailures.push("installed_overall_skip_metadata_missing");
      if (managerVerifierBusyEntries.length > 0) semanticFailures.push("installed_overall_manager_verifier_lock_busy");
      if (!definition.expectedFast && skippedEntries.some((entry) => !allowedFullSkipped.has(entry.id))) semanticFailures.push("installed_overall_unexpected_skipped_check");
      const skippedIds = new Set(skippedEntries.map((entry) => entry.id));
      if (!skippedIds.has("realMiniTool") || !skippedIds.has("realWork") || !skippedIds.has("realSmallProject")) semanticFailures.push("installed_overall_real_traffic_skip_missing");
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
    if (definition.requirePostVerificationSemantics) {
      const wait = report.wait && typeof report.wait === "object" ? report.wait : {};
      const overall = report.overall && typeof report.overall === "object" ? report.overall : {};
      if (report.reportName !== "post-verification") semanticFailures.push("post_verification_report_name");
      if (report.state !== "completed") semanticFailures.push("post_verification_state_not_completed");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("post_verification_failures");
      if (wait.ready !== true) semanticFailures.push("post_verification_wait_not_ready");
      if (overall.ok !== true) semanticFailures.push("post_verification_overall_not_ok");
      if (overall.usedRealTraffic !== true) semanticFailures.push("post_verification_overall_real_traffic_missing");
      if (overall.releaseReady !== true) semanticFailures.push("post_verification_overall_not_release_ready");
    }
    if (definition.requireCodexResponsesSemantics) {
      const marker = String(report.marker || "");
      const finalText = String(report.final_text || "");
      if (report.reportName !== "codex-responses") semanticFailures.push("codex_responses_report_name");
      if (report.usedRealTraffic !== true) semanticFailures.push("codex_responses_real_traffic_missing");
      if (report.completed !== true) semanticFailures.push("codex_responses_not_completed");
      if (!marker || !finalText.includes(marker)) semanticFailures.push("codex_responses_marker_missing");
      if (!/[\u4e00-\u9fff]/.test(finalText)) semanticFailures.push("codex_responses_chinese_missing");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("codex_responses_failures");
    }
    if (definition.requireUiChatSmokeSemantics) {
      const marker = String(report.marker || "");
      const lastSample = String(report.lastSample || "");
      const sessionLock = report.antigravitySessionLock && typeof report.antigravitySessionLock === "object" ? report.antigravitySessionLock : {};
      if (report.reportName !== "ui-chat-smoke") semanticFailures.push("ui_chat_smoke_report_name");
      if (report.requestedRealTraffic !== true) semanticFailures.push("ui_chat_smoke_real_traffic_not_requested");
      if (report.usedRealTraffic !== true) semanticFailures.push("ui_chat_smoke_real_traffic_missing");
      if (report.behaviorCovered !== true) semanticFailures.push("ui_chat_smoke_behavior_not_covered");
      if (report.coverageKind !== "desktop-ui-real-traffic") semanticFailures.push("ui_chat_smoke_coverage_kind");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("ui_chat_smoke_failures");
      if (!marker || Number(report.markerCount || 0) < 2 || !lastSample.includes(marker)) semanticFailures.push("ui_chat_smoke_marker_missing");
      if (report.clicked !== true) semanticFailures.push("ui_chat_smoke_not_sent");
      if (report.composerCleared !== true) semanticFailures.push("ui_chat_smoke_composer_not_cleared");
      if (report.activeReconnectSeen === true) semanticFailures.push("ui_chat_smoke_active_reconnect_seen");
      if (sessionLock.active === true || Number(sessionLock.queued || 0) > 0) semanticFailures.push("ui_chat_smoke_session_lock_not_clear");
    }
    if (definition.requireUiTaskSmokeSemantics) {
      const spec = definition.requireUiTaskSmokeSemantics;
      const prefix = spec.prefix || definition.id.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`).replace(/^_/, "");
      const marker = String(report.marker || "");
      const lastSample = String(report.lastSample || "");
      const sessionLock = report.antigravitySessionLock && typeof report.antigravitySessionLock === "object" ? report.antigravitySessionLock : {};
      const artifact = report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence : {};
      const files = artifact.files && typeof artifact.files === "object" ? artifact.files : {};
      if (report.reportName !== spec.reportName) semanticFailures.push(`${prefix}_report_name`);
      if (report.taskMode !== spec.taskMode) semanticFailures.push(`${prefix}_task_mode`);
      if (report.requestedRealTraffic !== true) semanticFailures.push(`${prefix}_real_traffic_not_requested`);
      if (report.usedRealTraffic !== true) semanticFailures.push(`${prefix}_real_traffic_missing`);
      if (report.behaviorCovered !== true) semanticFailures.push(`${prefix}_behavior_not_covered`);
      if (report.coverageKind !== "desktop-ui-real-traffic") semanticFailures.push(`${prefix}_coverage_kind`);
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push(`${prefix}_failures`);
      if (spec.requirePromptLanguage && report.promptLanguage !== spec.requirePromptLanguage) semanticFailures.push(`${prefix}_prompt_language`);
      if (spec.requireFollowupPromptLanguage && report.followupPromptLanguage !== spec.requireFollowupPromptLanguage) semanticFailures.push(`${prefix}_followup_prompt_language`);
      if (!spec.markerOptional && (!marker || Number(report.answerMarkerCount || 0) < 1)) semanticFailures.push(`${prefix}_marker_missing`);
      if (report.clicked !== true) semanticFailures.push(`${prefix}_not_sent`);
      if (report.composerCleared !== true) semanticFailures.push(`${prefix}_composer_not_cleared`);
      if (report.activeReconnectSeen === true) semanticFailures.push(`${prefix}_active_reconnect_seen`);
      if (report.sessionLockClear !== true || sessionLock.active === true || Number(sessionLock.queued || 0) > 0) semanticFailures.push(`${prefix}_session_lock_not_clear`);
      for (const fileKey of spec.requiredFiles || []) {
        if (files[fileKey] !== true) semanticFailures.push(`${prefix}_${fileKey}_missing`);
      }
      if ((spec.requiredFiles || []).length > 0 && !spec.requireMultiTurnProject && !spec.requireRepoFileEdit && !spec.requireRepoMultiFileEdit && artifact.doneExact !== true) semanticFailures.push(`${prefix}_done_marker_mismatch`);
      if (spec.requireSourceUrls && !/https?:\/\//i.test(lastSample)) semanticFailures.push(`${prefix}_source_urls_missing`);
      if (spec.requireSourceJsonUrls && Number(artifact.sourceUrlCount || 0) < spec.requireSourceJsonUrls) semanticFailures.push(`${prefix}_source_json_urls_missing`);
      if (spec.requireCodingProject) {
        if (artifact.exportsFunction !== true) semanticFailures.push(`${prefix}_export_missing`);
        if (artifact.testPassed !== true) semanticFailures.push(`${prefix}_tests_not_passed`);
        if (artifact.cliPassed !== true) semanticFailures.push(`${prefix}_cli_not_passed`);
      }
      if (spec.requireMultiTurnProject) {
        const turns = Array.isArray(report.turnEvidence) ? report.turnEvidence : [];
        if (artifact.firstDoneExact !== true) semanticFailures.push(`${prefix}_first_done_marker_mismatch`);
        if (artifact.followupExact !== true) semanticFailures.push(`${prefix}_followup_marker_mismatch`);
        if (artifact.changelogHasFinalMarker !== true) semanticFailures.push(`${prefix}_changelog_marker_missing`);
        if (artifact.exportsTallyWords !== true) semanticFailures.push(`${prefix}_tally_export_missing`);
        if (artifact.exportsUniqueWords !== true) semanticFailures.push(`${prefix}_unique_export_missing`);
        if (artifact.testPassed !== true) semanticFailures.push(`${prefix}_tests_not_passed`);
        if (artifact.cliPassed !== true) semanticFailures.push(`${prefix}_cli_not_passed`);
        if (turns.length < 2) semanticFailures.push(`${prefix}_turns_missing`);
        if (turns.some((turn) => !turn || turn.clicked !== true || turn.submitSucceeded !== true || Number(turn.answerMarkerCount || 0) < 1)) semanticFailures.push(`${prefix}_turn_submit_missing`);
        if (turns.some((turn) => turn?.activeReconnectSeen === true)) semanticFailures.push(`${prefix}_turn_reconnect_seen`);
      }
      if (spec.requireRepoFileEdit) {
        if (artifact.testPassed !== true) semanticFailures.push(`${prefix}_tests_not_passed`);
        if (artifact.sourceHasLowercase !== true) semanticFailures.push(`${prefix}_lowercase_missing`);
        if (artifact.sourceHandlesInvalidChars !== true) semanticFailures.push(`${prefix}_invalid_char_handling_missing`);
        if (artifact.sourceTrimsHyphens !== true) semanticFailures.push(`${prefix}_hyphen_trim_missing`);
      }
      if (spec.requireRepoMultiFileEdit) {
        if (artifact.exportsNormalizeStatus !== true) semanticFailures.push(`${prefix}_normalize_export_missing`);
        if (artifact.exportsSummarizeRecords !== true) semanticFailures.push(`${prefix}_summary_export_missing`);
        if (artifact.exportsRenderSummaryHtml !== true) semanticFailures.push(`${prefix}_html_export_missing`);
        if (artifact.sourceChangedFromFixture !== true) semanticFailures.push(`${prefix}_source_unchanged`);
        if (artifact.testUnchanged !== true) semanticFailures.push(`${prefix}_test_modified`);
        if (artifact.dataUnchanged !== true) semanticFailures.push(`${prefix}_data_modified`);
        if (artifact.testPassed !== true) semanticFailures.push(`${prefix}_tests_not_passed`);
        if (artifact.cliPassed !== true) semanticFailures.push(`${prefix}_cli_not_passed`);
        if (artifact.htmlComplete !== true) semanticFailures.push(`${prefix}_html_not_complete`);
        if (artifact.htmlHasChinese !== true) semanticFailures.push(`${prefix}_html_chinese_missing`);
        if (artifact.htmlMentionsStatuses !== true) semanticFailures.push(`${prefix}_html_statuses_missing`);
        if (artifact.htmlAvoidsObjectObject !== true) semanticFailures.push(`${prefix}_html_object_leak`);
        if (artifact.readmeHasChinese !== true) semanticFailures.push(`${prefix}_readme_chinese_missing`);
        if (artifact.readmeMentionsCommand !== true) semanticFailures.push(`${prefix}_readme_command_missing`);
        if (!repoMultiSettleEvidenceOk(report.firstTurnSettle, "readme")) semanticFailures.push(`${prefix}_first_turn_settle_missing`);
        if (!repoMultiSettleEvidenceOk(report.finalTurnSettle, "full")) semanticFailures.push(`${prefix}_final_turn_settle_missing`);
      }
      if (spec.requireReportSite) {
        if (artifact.reportHasChinese !== true) semanticFailures.push(`${prefix}_report_chinese_missing`);
        if (artifact.htmlHasChinese !== true) semanticFailures.push(`${prefix}_html_chinese_missing`);
        if (artifact.reportMentionsCodex !== true) semanticFailures.push(`${prefix}_report_codex_missing`);
        if (artifact.htmlMentionsCodex !== true) semanticFailures.push(`${prefix}_html_codex_missing`);
        if (Number(artifact.reportUrlCount || 0) < 3) semanticFailures.push(`${prefix}_report_urls_missing`);
        if (Number(artifact.htmlUrlCount || 0) < 3) semanticFailures.push(`${prefix}_html_urls_missing`);
        if (Number(artifact.sharedUrlCount || 0) < 1) semanticFailures.push(`${prefix}_shared_urls_missing`);
        if (artifact.htmlComplete !== true) semanticFailures.push(`${prefix}_html_not_complete`);
        if (artifact.htmlLinksReport !== true) semanticFailures.push(`${prefix}_html_report_link_missing`);
      }
    }
    if (definition.requireDesktopTaskSuiteSemantics) {
      const selectedTasks = Array.isArray(report.selectedTasks) ? report.selectedTasks.map((task) => String(task || "")) : [];
      const latestRealTaskEvidence = report.latestRealTaskEvidence && typeof report.latestRealTaskEvidence === "object" ? report.latestRealTaskEvidence : {};
      const refreshPlan = report.realTaskEvidenceRefreshPlan && typeof report.realTaskEvidenceRefreshPlan === "object" ? report.realTaskEvidenceRefreshPlan : {};
      const taskScenarioCatalog = report.taskScenarioCatalog && typeof report.taskScenarioCatalog === "object" ? report.taskScenarioCatalog : {};
      const selectedTaskScenarios = report.selectedTaskScenarios && typeof report.selectedTaskScenarios === "object" ? report.selectedTaskScenarios : {};
      if (report.reportName !== "desktop-task-suite") semanticFailures.push("desktop_task_suite_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("desktop_task_suite_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("desktop_task_suite_used_real_traffic");
      if (report.dryRun !== true) semanticFailures.push("desktop_task_suite_not_dry_run");
      if (report.mode !== "dry-run") semanticFailures.push("desktop_task_suite_mode");
      if (report.behaviorCovered !== true) semanticFailures.push("desktop_task_suite_behavior_not_covered");
      if (report.coverageKind !== "desktop-task-suite-dry-run") semanticFailures.push("desktop_task_suite_coverage_kind");
      if (report.suiteProfile !== "agentic") semanticFailures.push("desktop_task_suite_profile_not_agentic");
      if (report.realTaskEvidenceComplete !== true) semanticFailures.push("desktop_task_suite_real_task_evidence_incomplete");
      if (report.realTaskEvidenceFresh !== true) semanticFailures.push("desktop_task_suite_real_task_evidence_not_fresh");
      if (Array.isArray(report.realTaskEvidenceFailures) && report.realTaskEvidenceFailures.length > 0) semanticFailures.push("desktop_task_suite_real_task_evidence_failures");
      if (Array.isArray(report.realTaskEvidenceHardFailures) && report.realTaskEvidenceHardFailures.length > 0) semanticFailures.push("desktop_task_suite_real_task_evidence_hard_failures");
      if (Array.isArray(report.realTaskEvidenceFreshnessFailures) && report.realTaskEvidenceFreshnessFailures.length > 0) semanticFailures.push("desktop_task_suite_real_task_evidence_freshness_failures");
      if (refreshPlan.needed !== false) semanticFailures.push("desktop_task_suite_refresh_needed");
      if (refreshPlan.requiresExplicitUserApproval !== false) semanticFailures.push("desktop_task_suite_refresh_approval_required");
      for (const task of requiredAgenticDesktopTaskSuiteTasks) {
        const evidence = latestRealTaskEvidence[task] && typeof latestRealTaskEvidence[task] === "object" ? latestRealTaskEvidence[task] : null;
        const scenario = taskScenarioCatalog[task] && typeof taskScenarioCatalog[task] === "object" ? taskScenarioCatalog[task] : null;
        const selectedScenario = selectedTaskScenarios[task] && typeof selectedTaskScenarios[task] === "object" ? selectedTaskScenarios[task] : null;
        if (!selectedTasks.includes(task)) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_not_selected`);
        if (!scenario) {
          semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_scenario_missing`);
        } else {
          const evidenceKeys = Array.isArray(scenario.expectedEvidence) ? scenario.expectedEvidence.map((item) => String(item || "")) : [];
          const profileCoverage = Array.isArray(scenario.profileCoverage) ? scenario.profileCoverage.map((item) => String(item || "")) : [];
          if (scenario.taskMode !== task) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_scenario_task_mismatch`);
          if (typeof scenario.workType !== "string" || !scenario.workType) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_scenario_work_type_missing`);
          if (!profileCoverage.includes("agentic")) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_scenario_profile_missing`);
          if (typeof scenario.requiresWeb !== "boolean") semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_scenario_requires_web_missing`);
          if (typeof scenario.mutatesRepoFixture !== "boolean") semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_scenario_repo_mutation_missing`);
          if (evidenceKeys.length < 1) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_scenario_expected_evidence_missing`);
          if (typeof scenario.reportFile !== "string" || !scenario.reportFile) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_scenario_report_file_missing`);
        }
        if (!selectedScenario || selectedScenario.taskMode !== task) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_selected_scenario_missing`);
        if (!evidence) {
          semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_evidence_missing`);
          continue;
        }
        if (evidence.present !== true) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_report_missing`);
        if (evidence.parseable !== true) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_report_unparseable`);
        if (evidence.ok !== true) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_not_ok`);
        if (evidence.requestedRealTraffic !== true) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_real_traffic_not_requested`);
        if (evidence.usedRealTraffic !== true) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_real_traffic_missing`);
        if (evidence.fresh !== true) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_not_fresh`);
        if (Array.isArray(evidence.failures) && evidence.failures.length > 0) semanticFailures.push(`desktop_task_suite_${task.replaceAll("-", "_")}_failures`);
      }
    }
    if (definition.requireAgenticCapabilityMatrixSemantics) {
      const required = [
        "coding_project_files_tests_cli",
        "multi_turn_continuation",
        "research_report_with_sources",
        "complex_research_code_site",
        "autonomous_reasoning_project",
        "repo_multi_file_edit",
        "visible_staged_tool_loop",
      ];
      const requiredCapabilities = Array.isArray(report.requiredCapabilities) ? report.requiredCapabilities.map((item) => String(item || "")) : [];
      const capabilities = Array.isArray(report.capabilities) ? report.capabilities : [];
      if (report.reportName !== "agentic-capability-matrix") semanticFailures.push("agentic_capability_matrix_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("agentic_capability_matrix_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("agentic_capability_matrix_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("agentic_capability_matrix_behavior_not_covered");
      if (report.coverageKind !== "agentic-capability-matrix-report-only") semanticFailures.push("agentic_capability_matrix_coverage_kind");
      if (report.complete !== true) semanticFailures.push("agentic_capability_matrix_incomplete");
      if (report.fresh !== true) semanticFailures.push("agentic_capability_matrix_not_fresh");
      if (report.suiteProfile !== "agentic") semanticFailures.push("agentic_capability_matrix_suite_profile");
      if (report.desktopTaskSuiteFresh !== true) semanticFailures.push("agentic_capability_matrix_desktop_suite_not_fresh");
      if (report.desktopTaskSuiteComplete !== true) semanticFailures.push("agentic_capability_matrix_desktop_suite_incomplete");
      if (report.desktopTaskSuiteEvidenceFresh !== true) semanticFailures.push("agentic_capability_matrix_desktop_suite_evidence_not_fresh");
      if (Array.isArray(report.missingCapabilities) && report.missingCapabilities.length > 0) semanticFailures.push("agentic_capability_matrix_missing_capabilities");
      if (Array.isArray(report.staleCapabilities) && report.staleCapabilities.length > 0) semanticFailures.push("agentic_capability_matrix_stale_capabilities");
      for (const capabilityId of required) {
        if (!requiredCapabilities.includes(capabilityId)) semanticFailures.push(`agentic_capability_matrix_${capabilityId}_not_required`);
        const entry = capabilities.find((item) => String(item?.id || "") === capabilityId);
        if (!entry) {
          semanticFailures.push(`agentic_capability_matrix_${capabilityId}_missing`);
          continue;
        }
        if (entry.ok !== true) semanticFailures.push(`agentic_capability_matrix_${capabilityId}_not_ok`);
        if (entry.fresh !== true) semanticFailures.push(`agentic_capability_matrix_${capabilityId}_not_fresh`);
        if (entry.requestedRealTraffic !== true) semanticFailures.push(`agentic_capability_matrix_${capabilityId}_real_traffic_not_requested`);
        if (entry.usedRealTraffic !== true) semanticFailures.push(`agentic_capability_matrix_${capabilityId}_real_traffic_missing`);
        if (Array.isArray(entry.failures) && entry.failures.length > 0) semanticFailures.push(`agentic_capability_matrix_${capabilityId}_failures`);
      }
    }
    if (definition.requireCliTransportBoundarySemantics) {
      const staticChecks = Array.isArray(report.staticChecks) ? report.staticChecks : [];
      const healthChecks = Array.isArray(report.healthChecks) ? report.healthChecks : [];
      const staticCheckIds = staticChecks.map((item) => String(item?.id || ""));
      const healthCheckIds = healthChecks.map((item) => String(item?.id || ""));
      if (report.reportName !== "cli-transport-boundary") semanticFailures.push("cli_transport_boundary_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("cli_transport_boundary_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("cli_transport_boundary_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("cli_transport_boundary_behavior_not_covered");
      if (report.coverageKind !== "cli-transport-boundary-report-only") semanticFailures.push("cli_transport_boundary_coverage_kind");
      if (report.cliTransportBoundaryComplete !== true) semanticFailures.push("cli_transport_boundary_incomplete");
      if (report.modelTextTransport !== "desktop-cascade") semanticFailures.push("cli_transport_boundary_model_text_transport_not_desktop_cascade");
      if (report.modelDiscoverySource !== "antigravity-desktop-catalog") semanticFailures.push("cli_transport_boundary_model_discovery_source");
      if (report.antigravityCoworkerDefault !== true) semanticFailures.push("cli_transport_boundary_coworker_default_not_false");
      if (report.desktopCascadeModelTextDefault !== true) semanticFailures.push("cli_transport_boundary_desktop_cascade_default_missing");
      if (report.cliTransportExplicitOnly !== true) semanticFailures.push("cli_transport_boundary_cli_not_explicit_only");
      if (report.antigravityDesktopRequiredForCliTransport !== false) semanticFailures.push("cli_transport_boundary_desktop_required");
      if (report.antigravityDesktopProcessAbsenceRequired !== false) semanticFailures.push("cli_transport_boundary_requires_process_absence");
      if (report.codexOwnedTools !== true) semanticFailures.push("cli_transport_boundary_codex_tools_missing");
      if (report.antigravityModelTextOnly !== true) semanticFailures.push("cli_transport_boundary_model_text_only_missing");
      for (const checkId of [
        "launcher-defaults-antigravity-transport-to-desktop-cascade",
        "launcher-explicit-cli-transport-does-not-require-desktop",
        "launcher-desktop-helper-is-guarded",
        "shared-launcher-watchdog-bails-for-cli-transport",
        "adaptive-server-splits-model-text-transport",
        "adaptive-server-reports-desktop-and-cli-catalogs",
        "adaptive-server-keeps-antigravity-coworker-disabled",
      ]) {
        if (!staticCheckIds.includes(checkId)) semanticFailures.push(`cli_transport_boundary_static_${checkId.replaceAll("-", "_")}_missing`);
      }
      for (const checkId of [
        "health-reachable",
        "health-model-text-transport-desktop-cascade",
        "health-model-discovery-desktop-catalog",
        "health-antigravity-coworker-disabled",
        "health-model-catalog-present",
      ]) {
        if (!healthCheckIds.includes(checkId)) semanticFailures.push(`cli_transport_boundary_health_${checkId.replaceAll("-", "_")}_missing`);
      }
      for (const item of [...staticChecks, ...healthChecks]) {
        const id = String(item?.id || "unknown").replaceAll("-", "_");
        if (item?.ok !== true) semanticFailures.push(`cli_transport_boundary_check_failed:${id}`);
      }
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("cli_transport_boundary_failures");
    }
    if (definition.requireLongTaskLandingMatrixSemantics) {
      const requiredTaskModes = [
        "coding-project",
        "multi-turn-project",
        "report-site",
        "complex-project",
        "autonomous-reasoning",
        "agentic-step-flow",
        "repo-multi-file-edit",
      ];
      const taskModes = Array.isArray(report.requiredLongTaskModes) ? report.requiredLongTaskModes.map((item) => String(item || "")) : [];
      const taskResults = Array.isArray(report.taskResults) ? report.taskResults : [];
      const pendingRealTaskModes = Array.isArray(report.pendingRealTaskModes) ? report.pendingRealTaskModes.map((item) => String(item || "")) : [];
      const pendingRealTaskScenarios = Array.isArray(report.pendingRealTaskScenarios) ? report.pendingRealTaskScenarios : [];
      if (report.reportName !== "long-task-landing-matrix") semanticFailures.push("long_task_landing_matrix_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("long_task_landing_matrix_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("long_task_landing_matrix_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("long_task_landing_matrix_behavior_not_covered");
      if (report.coverageKind !== "long-task-landing-matrix-report-only") semanticFailures.push("long_task_landing_matrix_coverage_kind");
      if (report.longTaskLandingComplete !== true) semanticFailures.push("long_task_landing_matrix_incomplete");
      if (report.codexClientCopy !== true) semanticFailures.push("long_task_landing_matrix_client_copy_missing");
      if (report.antigravityModelTextOnly !== true) semanticFailures.push("long_task_landing_matrix_model_text_boundary_missing");
      if (report.agenticCapabilityMatrixPresent !== true || report.agenticCapabilityMatrixComplete !== true) semanticFailures.push("long_task_landing_matrix_agentic_matrix_missing");
      if (report.realTaskCoverageRoadmapPresent !== true) semanticFailures.push("long_task_landing_matrix_roadmap_missing");
      if (Number(report.longTaskCount || 0) < requiredTaskModes.length) semanticFailures.push("long_task_landing_matrix_task_count");
      if (Number(report.landedLongTaskCount || 0) < requiredTaskModes.length) semanticFailures.push("long_task_landing_matrix_landed_count");
      if (Array.isArray(report.failedLongTaskModes) && report.failedLongTaskModes.length > 0) semanticFailures.push("long_task_landing_matrix_failed_tasks");
      for (const taskMode of requiredTaskModes) {
        if (!taskModes.includes(taskMode)) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_not_required`);
        const entry = taskResults.find((item) => String(item?.taskMode || "") === taskMode);
        if (!entry) {
          semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_missing`);
          continue;
        }
        if (entry.ok !== true) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_not_ok`);
        if (entry.fresh !== true) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_not_fresh`);
        if (entry.requestedRealTraffic !== true) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_real_traffic_not_requested`);
        if (entry.usedRealTraffic !== true) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_real_traffic_missing`);
        if (entry.reportOk !== true) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_report_not_ok`);
        if (entry.capabilityOk !== true) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_capability_not_ok`);
        if (entry.artifactProofComplete !== true) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_artifact_proof_missing`);
        if (entry.resultProofComplete !== true) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_result_proof_missing`);
        if (!Array.isArray(entry.requiredArtifactKeys) || entry.requiredArtifactKeys.length < 1) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_artifact_requirements_missing`);
        if (!Array.isArray(entry.requiredFiles) || entry.requiredFiles.length < 1) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_file_requirements_missing`);
        if (Array.isArray(entry.failures) && entry.failures.length > 0) semanticFailures.push(`long_task_landing_matrix_${taskMode.replaceAll("-", "_")}_failures`);
      }
      if (report.broaderRealTrafficStillRequired === true) {
        for (const taskMode of ["web-search", "free-chat"]) {
          if (!pendingRealTaskModes.includes(taskMode)) semanticFailures.push(`long_task_landing_matrix_pending_${taskMode.replaceAll("-", "_")}_missing`);
          const scenario = pendingRealTaskScenarios.find((item) => String(item?.taskMode || "") === taskMode);
          if (!scenario) {
            semanticFailures.push(`long_task_landing_matrix_pending_${taskMode.replaceAll("-", "_")}_scenario_missing`);
            continue;
          }
          if (typeof scenario.workType !== "string" || !scenario.workType) semanticFailures.push(`long_task_landing_matrix_pending_${taskMode.replaceAll("-", "_")}_work_type_missing`);
          if (scenario.realTrafficRequired !== true) semanticFailures.push(`long_task_landing_matrix_pending_${taskMode.replaceAll("-", "_")}_not_real_traffic`);
          if (!Array.isArray(scenario.acceptanceEvidence) || scenario.acceptanceEvidence.length < 1) semanticFailures.push(`long_task_landing_matrix_pending_${taskMode.replaceAll("-", "_")}_acceptance_missing`);
          if (scenario.expectedResultPresent !== true) semanticFailures.push(`long_task_landing_matrix_pending_${taskMode.replaceAll("-", "_")}_expected_missing`);
        }
      }
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("long_task_landing_matrix_failures");
    }
    if (definition.requireRequiredRealTrafficSequenceSemantics) {
      const requiredActionIds = Array.isArray(report.requiredActionIds) ? report.requiredActionIds.map((item) => String(item || "")) : [];
      const optionalActionIds = Array.isArray(report.optionalActionIds) ? report.optionalActionIds.map((item) => String(item || "")) : [];
      const requiredGateIds = Array.isArray(report.requiredGateIds) ? report.requiredGateIds.map((item) => String(item || "")) : [];
      const completedRequiredGateIds = Array.isArray(report.completedRequiredGateIds) ? report.completedRequiredGateIds.map((item) => String(item || "")) : [];
      const requiredReleaseComplete = report.requiredReleaseComplete === true;
      const commands = Array.isArray(report.commands) ? report.commands.map((item) => String(item || "")) : [];
      const mixedOptional = requiredActionIds.filter((id) => optionalActionIds.includes(id));
      if (report.reportName !== "required-real-traffic-sequence") semanticFailures.push("required_real_traffic_sequence_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("required_real_traffic_sequence_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("required_real_traffic_sequence_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("required_real_traffic_sequence_behavior_not_covered");
      if (report.coverageKind !== "required-real-traffic-sequence-report-only") semanticFailures.push("required_real_traffic_sequence_coverage_kind");
      if (report.approvalPlanPresent !== true) semanticFailures.push("required_real_traffic_sequence_approval_plan_missing");
      if (report.approvalPlanReportName !== "real-approval-plan") semanticFailures.push("required_real_traffic_sequence_approval_plan_name");
      if (Number(report.optionalActionCount || 0) < 1) semanticFailures.push("required_real_traffic_sequence_optional_actions_missing");
      if (report.noOptionalActionsInRequiredSequence !== true || mixedOptional.length > 0) semanticFailures.push("required_real_traffic_sequence_optional_actions_mixed");
      for (const gateId of ["accountProxyReadiness", "postVerification"]) {
        if (!requiredGateIds.includes(gateId)) semanticFailures.push(`required_real_traffic_sequence_${gateId}_gate_missing`);
        if (requiredReleaseComplete) {
          if (!completedRequiredGateIds.includes(gateId)) semanticFailures.push(`required_real_traffic_sequence_${gateId}_completed_gate_missing`);
        } else if (completedRequiredGateIds.includes(gateId)) {
          // Already completed gates stay in completedRequiredGateIds, not pending actions.
        } else {
          if (!requiredActionIds.includes(gateId)) semanticFailures.push(`required_real_traffic_sequence_${gateId}_action_missing`);
        }
      }
      if (requiredReleaseComplete) {
        if (Number(report.requiredActionCount || 0) !== 0) semanticFailures.push("required_real_traffic_sequence_completed_with_pending_actions");
        if (report.blockedUntilExplicitUserApproval !== false) semanticFailures.push("required_real_traffic_sequence_completed_still_approval_blocked");
      } else {
        if (Number(report.requiredActionCount || 0) < 1) semanticFailures.push("required_real_traffic_sequence_required_actions_missing");
        if (report.blockedUntilExplicitUserApproval !== true) semanticFailures.push("required_real_traffic_sequence_not_approval_blocked");
      }
      if (commands.length < requiredActionIds.length) semanticFailures.push("required_real_traffic_sequence_commands_missing");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("required_real_traffic_sequence_failures");
    }
    if (definition.requireGoalRealRunReadinessSemantics) {
      const refreshTasks = Array.isArray(report.uniqueRefreshTasks) ? report.uniqueRefreshTasks.map((item) => String(item || "")) : [];
      const refreshScenarios = Array.isArray(report.pendingRealTaskScenarios) ? report.pendingRealTaskScenarios : [];
      const missingTaskScenarios = Array.isArray(report.missingTaskScenarios) ? report.missingTaskScenarios.map((item) => String(item || "")) : [];
      const requiredGateIds = Array.isArray(report.requiredReleaseGateIds) ? report.requiredReleaseGateIds.map((item) => String(item || "")) : [];
      const completedRequiredGateIds = Array.isArray(report.completedRequiredGateIds) ? report.completedRequiredGateIds.map((item) => String(item || "")) : [];
      const requiredReleaseComplete = report.requiredReleaseComplete === true;
      const requiredActionIds = Array.isArray(report.requiredActionIds) ? report.requiredActionIds.map((item) => String(item || "")) : [];
      const blockedGates = Array.isArray(report.requiredRealTrafficBlockedGates) ? report.requiredRealTrafficBlockedGates.map((item) => String(item || "")) : [];
      const blockingStages = Array.isArray(report.blockingStages) ? report.blockingStages.map((item) => String(item || "")) : [];
      if (report.reportName !== "goal-real-run-readiness") semanticFailures.push("goal_real_run_readiness_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("goal_real_run_readiness_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("goal_real_run_readiness_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("goal_real_run_readiness_behavior_not_covered");
      if (report.coverageKind !== "goal-real-run-readiness-report-only") semanticFailures.push("goal_real_run_readiness_coverage_kind");
      if (report.readyForUserApprovedRealRun !== false) semanticFailures.push("goal_real_run_readiness_unexpectedly_ready");
      if (report.safeToAskUserForSecondAccountLogin !== true && (typeof report.accountReadinessBlockingReason !== "string" || !report.accountReadinessBlockingReason.trim())) semanticFailures.push("goal_real_run_readiness_account_blocking_reason_missing");
      if (report.separateAccountVerified === true) semanticFailures.push("goal_real_run_readiness_separate_account_claimed");
      if (report.releaseAcceptableAccountProof === true) semanticFailures.push("goal_real_run_readiness_release_account_proof_claimed");
      if (report.realTaskRefreshNeeded === true) {
        for (const taskMode of ["web-search", "free-chat"]) {
          if (!refreshTasks.includes(taskMode)) semanticFailures.push(`goal_real_run_readiness_${taskMode.replaceAll("-", "_")}_task_missing`);
          const scenario = refreshScenarios.find((item) => String(item?.taskMode || "") === taskMode);
          if (!scenario) {
            semanticFailures.push(`goal_real_run_readiness_${taskMode.replaceAll("-", "_")}_scenario_missing`);
            continue;
          }
          if (typeof scenario.workType !== "string" || !scenario.workType) semanticFailures.push(`goal_real_run_readiness_${taskMode.replaceAll("-", "_")}_work_type_missing`);
          if (scenario.realTrafficRequired !== true) semanticFailures.push(`goal_real_run_readiness_${taskMode.replaceAll("-", "_")}_not_real_traffic`);
          if (!Array.isArray(scenario.acceptanceEvidence) || scenario.acceptanceEvidence.length < 1) semanticFailures.push(`goal_real_run_readiness_${taskMode.replaceAll("-", "_")}_acceptance_missing`);
          if (scenario.expectedResultPresent !== true) semanticFailures.push(`goal_real_run_readiness_${taskMode.replaceAll("-", "_")}_expected_missing`);
        }
        if (report.realTaskRefreshCommandPresent !== true) semanticFailures.push("goal_real_run_readiness_refresh_command_missing");
      } else {
        if (refreshTasks.length > 0) semanticFailures.push("goal_real_run_readiness_unexpected_refresh_tasks");
        if (refreshScenarios.length > 0) semanticFailures.push("goal_real_run_readiness_unexpected_refresh_scenarios");
        if (report.realTaskRefreshCommandPresent !== false) semanticFailures.push("goal_real_run_readiness_unexpected_refresh_command");
      }
      if (refreshScenarios.length < refreshTasks.length) semanticFailures.push("goal_real_run_readiness_scenarios_incomplete");
      if (missingTaskScenarios.length > 0) semanticFailures.push("goal_real_run_readiness_missing_task_scenarios");
      for (const gateId of ["accountProxyReadiness", "postVerification"]) {
        if (!requiredGateIds.includes(gateId)) semanticFailures.push(`goal_real_run_readiness_${gateId}_gate_missing`);
        if (requiredReleaseComplete) {
          if (!completedRequiredGateIds.includes(gateId)) semanticFailures.push(`goal_real_run_readiness_${gateId}_completed_gate_missing`);
        } else if (completedRequiredGateIds.includes(gateId)) {
          // Already completed gates stay in completedRequiredGateIds, not pending actions.
        } else {
          if (!requiredActionIds.includes(gateId)) semanticFailures.push(`goal_real_run_readiness_${gateId}_action_missing`);
          if (!blockedGates.includes(gateId)) semanticFailures.push(`goal_real_run_readiness_${gateId}_blocked_gate_missing`);
        }
      }
      if (Number(report.requiredCommandCount || 0) < requiredActionIds.length) semanticFailures.push("goal_real_run_readiness_commands_missing");
      if (report.releaseShortReady !== true) semanticFailures.push("goal_real_run_readiness_short_not_ready");
      if (report.releaseReady !== true && report.releaseBlockedOnlyByRequiredRealTraffic !== true) semanticFailures.push("goal_real_run_readiness_release_not_ready_or_blocked_only_by_real_traffic");
      const requiredStages = report.releaseReady === true ? ["second_account_login_not_ready"] : ["second_account_login_not_ready", "release_gates_require_explicit_real_traffic"];
      for (const stage of requiredStages) {
        if (!blockingStages.includes(stage)) semanticFailures.push(`goal_real_run_readiness_${stage}_missing`);
      }
      if (report.realTaskRefreshNeeded === true && !blockingStages.includes("real_task_refresh_requires_explicit_approval")) semanticFailures.push("goal_real_run_readiness_real_task_refresh_stage_missing");
      if (report.realTaskRefreshNeeded !== true && blockingStages.includes("real_task_refresh_requires_explicit_approval")) semanticFailures.push("goal_real_run_readiness_unexpected_real_task_refresh_stage");
      if (typeof report.operatorNextAction !== "string" || !report.operatorNextAction) semanticFailures.push("goal_real_run_readiness_operator_next_action_missing");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("goal_real_run_readiness_failures");
    }
    if (definition.requireApprovedRealRunSequenceSemantics) {
      const requiredTaskModes = Array.isArray(report.requiredRealTaskModes) ? report.requiredRealTaskModes.map((item) => String(item || "")) : [];
      const scenarios = Array.isArray(report.pendingRealTaskScenarios) ? report.pendingRealTaskScenarios : [];
      const requiredGateIds = Array.isArray(report.requiredReleaseGateIds) ? report.requiredReleaseGateIds.map((item) => String(item || "")) : [];
      const requiredActionIds = Array.isArray(report.requiredActionIds) ? report.requiredActionIds.map((item) => String(item || "")) : [];
      const completedRequiredGateIds = Array.isArray(report.completedRequiredGateIds) ? report.completedRequiredGateIds.map((item) => String(item || "")) : [];
      const requiredReleaseComplete = report.requiredReleaseComplete === true;
      const optionalActionIds = Array.isArray(report.optionalActionIds) ? report.optionalActionIds.map((item) => String(item || "")) : [];
      const blockedGates = Array.isArray(report.requiredRealTrafficBlockedGates) ? report.requiredRealTrafficBlockedGates.map((item) => String(item || "")) : [];
      const sequence = Array.isArray(report.approvedRealRunSequence) ? report.approvedRealRunSequence : [];
      const prechecks = Array.isArray(report.noTrafficPrechecks) ? report.noTrafficPrechecks : [];
      const sourceReports = report.sourceReports && typeof report.sourceReports === "object" ? report.sourceReports : {};
      const realStages = sequence.filter((item) => item?.requiresRealTraffic === true);
      const loginStages = sequence.filter((item) => item?.startsLogin === true);
      const accountProofStages = sequence.filter((item) => String(item?.id || "") === "separateAccountIdentityProof");
      const mixedOptional = requiredActionIds.filter((id) => optionalActionIds.includes(id));
      const realTaskRefreshNeeded = requiredTaskModes.length > 0 || scenarios.length > 0;
      const releaseAcceptableAccountProof = report.releaseAcceptableAccountProof === true;
      const readyToRequestSecondAccountLoginApproval = report.readyToRequestSecondAccountLoginApproval === true;
      const readyToRequestPostLoginProofApproval = report.readyToRequestPostLoginProofApproval === true;
      const readyToRequestAnyUserApproval = readyToRequestSecondAccountLoginApproval || readyToRequestPostLoginProofApproval;
      if (report.reportName !== "approved-real-run-sequence") semanticFailures.push("approved_real_run_sequence_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("approved_real_run_sequence_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("approved_real_run_sequence_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("approved_real_run_sequence_behavior_not_covered");
      if (report.coverageKind !== "approved-real-run-sequence-report-only") semanticFailures.push("approved_real_run_sequence_coverage_kind");
      if (report.executionBlockedBeforeRealTraffic !== (releaseAcceptableAccountProof !== true)) semanticFailures.push("approved_real_run_sequence_block_state_inconsistent");
      if (report.readyToRequestUserApproval !== readyToRequestAnyUserApproval) semanticFailures.push("approved_real_run_sequence_ready_state_inconsistent");
      if (readyToRequestSecondAccountLoginApproval && report.safeToAskUserForSecondAccountLogin !== true) semanticFailures.push("approved_real_run_sequence_login_ready_without_safe_account");
      if (readyToRequestPostLoginProofApproval && report.safeToAskUserForSecondAccountLogin !== true) semanticFailures.push("approved_real_run_sequence_proof_ready_without_safe_account");
      if (readyToRequestAnyUserApproval && releaseAcceptableAccountProof === true) semanticFailures.push("approved_real_run_sequence_ready_after_proof_complete");
      if (Number(report.sequenceStageCount || 0) < 8 || sequence.length < 8) semanticFailures.push("approved_real_run_sequence_stage_count");
      if (Number(report.realTrafficStageCount || 0) < (realTaskRefreshNeeded ? 4 : 3) || realStages.length < (realTaskRefreshNeeded ? 4 : 3)) semanticFailures.push("approved_real_run_sequence_real_stage_count");
      if (Number(report.startsLoginStageCount || 0) !== 1 || loginStages.length !== 1) semanticFailures.push("approved_real_run_sequence_login_stage_count");
      if (Number(report.explicitApprovalStageCount || 0) < realStages.length) semanticFailures.push("approved_real_run_sequence_approval_stage_count");
      if (realTaskRefreshNeeded) {
        for (const taskMode of ["web-search", "free-chat"]) {
          if (!requiredTaskModes.includes(taskMode)) semanticFailures.push(`approved_real_run_sequence_${taskMode.replaceAll("-", "_")}_task_missing`);
          const scenario = scenarios.find((item) => String(item?.taskMode || "") === taskMode);
          if (!scenario) {
            semanticFailures.push(`approved_real_run_sequence_${taskMode.replaceAll("-", "_")}_scenario_missing`);
            continue;
          }
          if (typeof scenario.workType !== "string" || !scenario.workType) semanticFailures.push(`approved_real_run_sequence_${taskMode.replaceAll("-", "_")}_work_type_missing`);
          if (scenario.realTrafficRequired !== true) semanticFailures.push(`approved_real_run_sequence_${taskMode.replaceAll("-", "_")}_not_real_traffic`);
          if (!Array.isArray(scenario.acceptanceEvidence) || scenario.acceptanceEvidence.length < 1) semanticFailures.push(`approved_real_run_sequence_${taskMode.replaceAll("-", "_")}_acceptance_missing`);
          if (scenario.expectedResultPresent !== true) semanticFailures.push(`approved_real_run_sequence_${taskMode.replaceAll("-", "_")}_expected_missing`);
        }
      } else {
        if (requiredTaskModes.length > 0) semanticFailures.push("approved_real_run_sequence_unexpected_task_modes");
        if (scenarios.length > 0) semanticFailures.push("approved_real_run_sequence_unexpected_task_scenarios");
      }
      for (const gateId of ["accountProxyReadiness", "postVerification"]) {
        if (!requiredGateIds.includes(gateId)) semanticFailures.push(`approved_real_run_sequence_${gateId}_gate_missing`);
        if (requiredReleaseComplete) {
          if (!completedRequiredGateIds.includes(gateId)) semanticFailures.push(`approved_real_run_sequence_${gateId}_completed_gate_missing`);
        } else if (completedRequiredGateIds.includes(gateId)) {
          // Already completed gates stay in completedRequiredGateIds, not pending stages.
        } else {
          if (!requiredActionIds.includes(gateId)) semanticFailures.push(`approved_real_run_sequence_${gateId}_action_missing`);
          if (!blockedGates.includes(gateId)) semanticFailures.push(`approved_real_run_sequence_${gateId}_blocked_gate_missing`);
        }
      }
      if (report.optionalActionsSeparated !== true || mixedOptional.length > 0) semanticFailures.push("approved_real_run_sequence_optional_actions_mixed");
      if (report.releaseShortReady !== true) semanticFailures.push("approved_real_run_sequence_short_not_ready");
      if (sourceReports.secondAccountLoginEntrypoint?.present !== true) semanticFailures.push("approved_real_run_sequence_second_account_entrypoint_source_missing");
      if (report.safeToAskUserForSecondAccountLogin === true && readyToRequestSecondAccountLoginApproval !== true && releaseAcceptableAccountProof !== true) semanticFailures.push("approved_real_run_sequence_safe_login_not_actionable");
      if (releaseAcceptableAccountProof !== report.releaseAcceptableAccountProof) semanticFailures.push("approved_real_run_sequence_release_proof_state_mismatch");
      if (report.safeToAskUserForSecondAccountLogin !== true && (typeof report.accountReadinessBlockingReason !== "string" || !report.accountReadinessBlockingReason)) semanticFailures.push("approved_real_run_sequence_account_blocking_reason_missing");
      if (typeof report.operatorNextAction !== "string" || !report.operatorNextAction) semanticFailures.push("approved_real_run_sequence_operator_next_action_missing");
      if (prechecks.length < 4) semanticFailures.push("approved_real_run_sequence_precheck_count");
      if (prechecks.some((item) => item?.requiresRealTraffic === true || item?.startsLogin === true)) semanticFailures.push("approved_real_run_sequence_precheck_started_traffic_or_login");
      if (prechecks.some((item) => String(item?.id || "") === "accountIsolationStatus" && !String(item?.command || "").includes("-WindowsUser"))) semanticFailures.push("approved_real_run_sequence_status_command_missing_windows_user");
      if (realStages.some((item) => item?.requiresExplicitUserApproval !== true)) semanticFailures.push("approved_real_run_sequence_real_stage_without_approval");
      if (loginStages.some((item) => item?.requiresExplicitUserApproval !== true || item?.requiresRealTraffic === true)) semanticFailures.push("approved_real_run_sequence_login_stage_contract");
      if (loginStages.some((item) => !String(item?.command || "").includes("-WindowsUser") || !String(item?.command || "").includes("-StartLoginApproval start-separate-windows-user-login"))) semanticFailures.push("approved_real_run_sequence_login_command_not_isolated");
      if (accountProofStages.length !== 1) semanticFailures.push("approved_real_run_sequence_account_proof_stage_count");
      if (accountProofStages.some((item) => !String(item?.command || "").includes("-AllowSeparateAccountProof") || !String(item?.command || "").includes("SeparateAccountProofApprovalId") || !String(item?.command || "").includes("-WindowsUser"))) semanticFailures.push("approved_real_run_sequence_account_proof_command_incomplete");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("approved_real_run_sequence_failures");
    }
    if (definition.requireNativeCodexParityTaskMatrixSemantics) {
      const parityGroupIds = Array.isArray(report.parityGroupIds) ? report.parityGroupIds.map((item) => String(item || "")) : [];
      const taskModes = Array.isArray(report.taskModes) ? report.taskModes.map((item) => String(item || "")) : [];
      const toolTaskModes = Array.isArray(report.toolTaskModes) ? report.toolTaskModes.map((item) => String(item || "")) : [];
      const pendingRefreshTaskModes = Array.isArray(report.pendingRefreshTaskModes) ? report.pendingRefreshTaskModes.map((item) => String(item || "")) : [];
      const pendingRealTaskScenarios = Array.isArray(report.pendingRealTaskScenarios) ? report.pendingRealTaskScenarios : [];
      const minimalRefreshCommandArgs = Array.isArray(report.minimalRefreshCommandArgs) ? report.minimalRefreshCommandArgs.map((item) => String(item || "")) : [];
      if (report.reportName !== "native-codex-parity-task-matrix") semanticFailures.push("native_codex_parity_task_matrix_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("native_codex_parity_task_matrix_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("native_codex_parity_task_matrix_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("native_codex_parity_task_matrix_behavior_not_covered");
      if (report.coverageKind !== "native-codex-parity-task-matrix-report-only") semanticFailures.push("native_codex_parity_task_matrix_coverage_kind");
      for (const groupId of ["conversation", "research", "projectCreation", "codingAndRepoEditing", "multiTurnAgentic", "toolUse"]) {
        if (!parityGroupIds.includes(groupId)) semanticFailures.push(`native_codex_parity_task_matrix_${groupId}_group_missing`);
      }
      for (const taskMode of ["exact-marker", "free-chat", "web-search", "local-project", "coding-project", "multi-turn-project", "report-site", "complex-project", "autonomous-reasoning", "agentic-step-flow", "repo-file-edit", "repo-multi-file-edit"]) {
        if (!taskModes.includes(taskMode)) semanticFailures.push(`native_codex_parity_task_matrix_${taskMode.replaceAll("-", "_")}_task_missing`);
      }
      for (const toolMode of ["tool-loop", "mcp-tool-loop", "custom-tool-loop"]) {
        if (!toolTaskModes.includes(toolMode)) semanticFailures.push(`native_codex_parity_task_matrix_${toolMode.replaceAll("-", "_")}_missing`);
      }
      for (const taskMode of ["web-search", "free-chat"]) {
        if (report.realTrafficStillRequired === true && !pendingRefreshTaskModes.includes(taskMode)) semanticFailures.push("native_codex_parity_task_matrix_pending_task_modes_missing");
        const scenario = pendingRealTaskScenarios.find((item) => String(item?.taskMode || "") === taskMode);
        if (report.realTrafficStillRequired === true && !scenario) semanticFailures.push(`native_codex_parity_task_matrix_${taskMode.replaceAll("-", "_")}_scenario_missing`);
        if (scenario) {
          if (typeof scenario.workType !== "string" || !scenario.workType) semanticFailures.push(`native_codex_parity_task_matrix_${taskMode.replaceAll("-", "_")}_work_type_missing`);
          if (scenario.realTrafficRequired !== true) semanticFailures.push(`native_codex_parity_task_matrix_${taskMode.replaceAll("-", "_")}_not_real_traffic`);
          if (!Array.isArray(scenario.acceptanceEvidence) || scenario.acceptanceEvidence.length < 1) semanticFailures.push(`native_codex_parity_task_matrix_${taskMode.replaceAll("-", "_")}_acceptance_missing`);
        }
      }
      if (report.realTrafficStillRequired === true) {
        if (!minimalRefreshCommandArgs.some((item) => item.includes("test-anticodex-desktop-task-suite.mjs")) || !minimalRefreshCommandArgs.includes("--allow-real-traffic")) semanticFailures.push("native_codex_parity_task_matrix_minimal_refresh_command_args_missing");
      }
      if (report.codexOwnedTools !== true) semanticFailures.push("native_codex_parity_task_matrix_codex_tools_missing");
      if (report.antigravityModelTextOnly !== true) semanticFailures.push("native_codex_parity_task_matrix_model_text_boundary_missing");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("native_codex_parity_task_matrix_failures");
    }
    if (definition.requireRealTaskCoverageRoadmapSemantics) {
      const requiredProfiles = Array.isArray(report.requiredProfiles) ? report.requiredProfiles.map((item) => String(item || "")) : [];
      const profiles = Array.isArray(report.profiles) ? report.profiles : [];
      const taskModes = Array.isArray(report.taskModes) ? report.taskModes.map((item) => String(item || "")) : [];
      const uniqueRefreshTasks = Array.isArray(report.uniqueRefreshTasks) ? report.uniqueRefreshTasks.map((item) => String(item || "")) : [];
      const completeProfiles = Array.isArray(report.completeProfiles) ? report.completeProfiles.map((item) => String(item || "")) : [];
      const nextProfiles = Array.isArray(report.nextProfilesNeedingRealTraffic) ? report.nextProfilesNeedingRealTraffic.map((item) => String(item || "")) : [];
      const minimalRefreshCommandArgs = Array.isArray(report.minimalRefreshCommandArgs) ? report.minimalRefreshCommandArgs.map((item) => String(item || "")) : [];
      const refreshApprovalSummary = report.refreshApprovalSummary && typeof report.refreshApprovalSummary === "object" ? report.refreshApprovalSummary : {};
      const taskArtifactProofs = Array.isArray(report.taskArtifactProofs) ? report.taskArtifactProofs : [];
      const taskResultProofs = Array.isArray(report.taskResultProofs) ? report.taskResultProofs : [];
      const hasMissingArtifactProofTaskCount = Object.prototype.hasOwnProperty.call(report, "missingArtifactProofTaskCount");
      const hasMissingResultProofTaskCount = Object.prototype.hasOwnProperty.call(report, "missingResultProofTaskCount");
      if (report.reportName !== "real-task-coverage-roadmap") semanticFailures.push("real_task_coverage_roadmap_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("real_task_coverage_roadmap_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("real_task_coverage_roadmap_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("real_task_coverage_roadmap_behavior_not_covered");
      if (report.coverageKind !== "real-task-coverage-roadmap-report-only") semanticFailures.push("real_task_coverage_roadmap_coverage_kind");
      for (const profileName of ["core", "agentic", "extended", "all"]) {
        if (!requiredProfiles.includes(profileName)) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_profile_not_required`);
        const profile = profiles.find((item) => String(item?.profile || "") === profileName);
        if (!profile) {
          semanticFailures.push(`real_task_coverage_roadmap_${profileName}_profile_missing`);
          continue;
        }
        if (Number(profile.taskCount || 0) < 1) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_task_count`);
        if (Number(profile.resultProofRequiredCount || 0) < 1) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_result_profile_count`);
        if (Number(profile.resultProofCompleteCount || 0) < Number(profile.resultProofRequiredCount || 0)) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_result_profile_incomplete`);
        if (profile.profileResultProofComplete !== true) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_result_profile_incomplete`);
        if (Array.isArray(profile.missingResultProofTasks) && profile.missingResultProofTasks.length > 0) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_result_profile_missing_tasks`);
        if (Number(profile.artifactProofRequiredCount || 0) > 0 && Number(profile.artifactProofCompleteCount || 0) < Number(profile.artifactProofRequiredCount || 0)) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_artifact_profile_incomplete`);
        if (profile.profileArtifactProofComplete !== true) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_artifact_profile_incomplete`);
        if (Array.isArray(profile.missingArtifactProofTasks) && profile.missingArtifactProofTasks.length > 0) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_artifact_profile_missing_tasks`);
        if (typeof profile.refreshCommand !== "string" || !profile.refreshCommand.includes("test-anticodex-desktop-task-suite.mjs")) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_refresh_command_missing`);
      }
      if (taskModes.length < 12) semanticFailures.push("real_task_coverage_roadmap_task_modes_missing");
      for (const profileName of ["core", "agentic"]) {
        if (!completeProfiles.includes(profileName)) semanticFailures.push(`real_task_coverage_roadmap_${profileName}_not_complete`);
      }
      if (taskArtifactProofs.length < 9) semanticFailures.push("real_task_coverage_roadmap_artifact_proof_missing");
      if (!Array.isArray(report.missingArtifactProofTasks)) semanticFailures.push("real_task_coverage_roadmap_artifact_proof_missing");
      if (!hasMissingArtifactProofTaskCount) semanticFailures.push("real_task_coverage_roadmap_artifact_proof_missing");
      if (Number(report.missingArtifactProofTaskCount || 0) !== 0) semanticFailures.push("real_task_coverage_roadmap_artifact_proof_missing");
      for (const proof of taskArtifactProofs) {
        const taskMode = String(proof?.taskMode || "unknown").replaceAll("-", "_");
        const missingKeys = Array.isArray(proof?.missingArtifactProofKeys) ? proof.missingArtifactProofKeys : [];
        if (proof?.artifactProofComplete !== true) semanticFailures.push(`real_task_coverage_roadmap_${taskMode}_artifact_incomplete`);
        if (Number(proof?.artifactProofCount || 0) < 1) semanticFailures.push(`real_task_coverage_roadmap_${taskMode}_artifact_count`);
        if (missingKeys.length > 0) semanticFailures.push(`real_task_coverage_roadmap_${taskMode}_artifact_missing_keys`);
      }
      if (taskResultProofs.length < 12) semanticFailures.push("real_task_coverage_roadmap_result_proof_missing");
      if (!Array.isArray(report.missingResultProofTasks)) semanticFailures.push("real_task_coverage_roadmap_result_proof_missing");
      if (!hasMissingResultProofTaskCount) semanticFailures.push("real_task_coverage_roadmap_result_proof_missing");
      if (Number(report.missingResultProofTaskCount || 0) !== 0) semanticFailures.push("real_task_coverage_roadmap_result_proof_missing");
      for (const proof of taskResultProofs) {
        const taskMode = String(proof?.taskMode || "unknown").replaceAll("-", "_");
        const missingKeys = Array.isArray(proof?.missingResultProofKeys) ? proof.missingResultProofKeys : [];
        if (proof?.resultProofComplete !== true) semanticFailures.push(`real_task_coverage_roadmap_${taskMode}_result_incomplete`);
        if (Number(proof?.resultProofCount || 0) < 1) semanticFailures.push(`real_task_coverage_roadmap_${taskMode}_result_count`);
        if (missingKeys.length > 0) semanticFailures.push(`real_task_coverage_roadmap_${taskMode}_result_missing_keys`);
      }
      if (report.approvalRequiredForRefresh === true) {
        if (uniqueRefreshTasks.length < 1) semanticFailures.push("real_task_coverage_roadmap_unique_refresh_tasks_missing");
        if (report.minimalRefreshCommandRequiresRealTraffic !== true) semanticFailures.push("real_task_coverage_roadmap_minimal_refresh_command_not_real_traffic");
        if (typeof report.minimalRefreshCommand !== "string" || !report.minimalRefreshCommand.includes("test-anticodex-desktop-task-suite.mjs") || !report.minimalRefreshCommand.includes("--tasks") || !report.minimalRefreshCommand.includes("--allow-real-traffic")) semanticFailures.push("real_task_coverage_roadmap_minimal_refresh_command_missing");
        if (minimalRefreshCommandArgs.length < 1 || !minimalRefreshCommandArgs.some((item) => item.includes("test-anticodex-desktop-task-suite.mjs")) || !minimalRefreshCommandArgs.includes("--tasks") || !minimalRefreshCommandArgs.includes("--allow-real-traffic")) semanticFailures.push("real_task_coverage_roadmap_minimal_refresh_command_args_missing");
        if (refreshApprovalSummary.requiresExplicitUserApproval !== true) semanticFailures.push("real_task_coverage_roadmap_refresh_approval_summary_missing");
        if (String(refreshApprovalSummary.approvalReason || "") === "") semanticFailures.push("real_task_coverage_roadmap_refresh_approval_summary_missing");
        if (Number(refreshApprovalSummary.taskCount || 0) !== uniqueRefreshTasks.length) semanticFailures.push("real_task_coverage_roadmap_refresh_approval_task_count");
        const summaryTasks = Array.isArray(refreshApprovalSummary.refreshTaskModes) ? refreshApprovalSummary.refreshTaskModes.map((item) => String(item || "")) : [];
        if (summaryTasks.length !== uniqueRefreshTasks.length || uniqueRefreshTasks.some((taskMode) => !summaryTasks.includes(taskMode))) semanticFailures.push("real_task_coverage_roadmap_refresh_approval_tasks");
        if (nextProfiles.length < 1) semanticFailures.push("real_task_coverage_roadmap_next_profiles_missing");
      }
      if (typeof report.realTrafficApprovalReason !== "string" || !report.realTrafficApprovalReason) semanticFailures.push("real_task_coverage_roadmap_approval_reason_missing");
      if (typeof report.recommendedNoTrafficNextStep !== "string" || !report.recommendedNoTrafficNextStep) semanticFailures.push("real_task_coverage_roadmap_next_step_missing");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("real_task_coverage_roadmap_failures");
    }
    if (definition.requireRealApprovalPlanSemantics) {
      const refresh = report.realTaskRefresh && typeof report.realTaskRefresh === "object" ? report.realTaskRefresh : {};
      const releaseGates = report.releaseRealTrafficGates && typeof report.releaseRealTrafficGates === "object" ? report.releaseRealTrafficGates : {};
      const account = report.accountIsolation && typeof report.accountIsolation === "object" ? report.accountIsolation : {};
      const orderedActions = Array.isArray(report.orderedActions) ? report.orderedActions : [];
      const preLoginChecklist = Array.isArray(report.preLoginChecklist) ? report.preLoginChecklist : [];
      const sourceReports = report.sourceReports && typeof report.sourceReports === "object" ? report.sourceReports : {};
      const gateIds = Array.isArray(releaseGates.gateIds) ? releaseGates.gateIds.map((item) => String(item || "")) : [];
      const requiredGateIds = Array.isArray(releaseGates.requiredGateIds) ? releaseGates.requiredGateIds.map((item) => String(item || "")) : [];
      const completedGateIds = Array.isArray(releaseGates.completedGateIds) ? releaseGates.completedGateIds.map((item) => String(item || "")) : [];
      const requiredReleaseComplete = releaseGates.requiredReleaseComplete === true;
      const refreshTasks = Array.isArray(refresh.uniqueRefreshTasks) ? refresh.uniqueRefreshTasks.map((item) => String(item || "")) : [];
      const refreshCommandArgs = Array.isArray(refresh.commandArgs) ? refresh.commandArgs.map((item) => String(item || "")) : [];
      const refreshApprovalSummary = refresh.approvalSummary && typeof refresh.approvalSummary === "object" ? refresh.approvalSummary : {};
      if (report.reportName !== "real-approval-plan") semanticFailures.push("real_approval_plan_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("real_approval_plan_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("real_approval_plan_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("real_approval_plan_behavior_not_covered");
      if (report.coverageKind !== "real-approval-plan-report-only") semanticFailures.push("real_approval_plan_coverage_kind");
      if (refresh.needed === true) {
        if (refreshTasks.length < 1) semanticFailures.push("real_approval_plan_refresh_tasks_missing");
        if (typeof refresh.command !== "string" || !refresh.command.includes("--allow-real-traffic")) semanticFailures.push("real_approval_plan_refresh_command_missing");
        if (refreshCommandArgs.length < 1 || !refreshCommandArgs.some((item) => item.includes("test-anticodex-desktop-task-suite.mjs")) || !refreshCommandArgs.includes("--tasks") || !refreshCommandArgs.includes("--allow-real-traffic")) semanticFailures.push("real_approval_plan_refresh_command_args_missing");
        if (refreshApprovalSummary.requiresExplicitUserApproval !== true) semanticFailures.push("real_approval_plan_refresh_approval_summary_missing");
        if (String(refreshApprovalSummary.approvalReason || "") === "") semanticFailures.push("real_approval_plan_refresh_approval_summary_missing");
        if (Number(refreshApprovalSummary.taskCount || 0) !== refreshTasks.length) semanticFailures.push("real_approval_plan_refresh_approval_task_count");
      } else {
        if (refreshTasks.length > 0) semanticFailures.push("real_approval_plan_unexpected_refresh_tasks");
        if (typeof refresh.command === "string" && refresh.command.includes("--allow-real-traffic")) semanticFailures.push("real_approval_plan_unexpected_refresh_command");
        if (refreshCommandArgs.length > 0) semanticFailures.push("real_approval_plan_unexpected_refresh_command_args");
      }
      for (const gateId of ["accountProxyReadiness", "postVerification"]) {
        if (!requiredGateIds.includes(gateId)) semanticFailures.push(`real_approval_plan_${gateId}_required_gate_missing`);
        if (requiredReleaseComplete) {
          if (!completedGateIds.includes(gateId)) semanticFailures.push(`real_approval_plan_${gateId}_completed_gate_missing`);
        } else if (completedGateIds.includes(gateId)) {
          // Partially completed release gates should not be required as pending gates.
        } else if (!gateIds.includes(gateId)) {
          semanticFailures.push(`real_approval_plan_${gateId}_gate_missing`);
        }
      }
      if (requiredReleaseComplete) {
        if (releaseGates.releaseBlockedOnlyByRequiredRealTraffic !== false) semanticFailures.push("real_approval_plan_completed_still_blocked_by_real_traffic");
        if (Number(report.requiredReleaseRealTrafficActionCount || 0) !== 0) semanticFailures.push("real_approval_plan_completed_with_required_actions");
      } else {
        if (releaseGates.releaseBlockedOnlyByRequiredRealTraffic !== true) semanticFailures.push("real_approval_plan_release_not_blocked_only_by_real_traffic");
        if (Number(report.requiredReleaseRealTrafficActionCount || 0) < 1) semanticFailures.push("real_approval_plan_required_release_actions_missing");
      }
      if (report.optionalReleaseRealTrafficActionCount === undefined || report.optionalReleaseRealTrafficActionCount === null) semanticFailures.push("real_approval_plan_optional_release_actions_missing");
      if (account.targetUserMissing !== true) semanticFailures.push("real_approval_plan_target_user_missing_not_recorded");
      if (account.accountSetupBlocked !== true) semanticFailures.push("real_approval_plan_account_setup_not_blocked");
      if (orderedActions.length < 4) semanticFailures.push("real_approval_plan_ordered_actions_missing");
      if (Number(report.blockedUntilExplicitUserApprovalCount || 0) < 1) semanticFailures.push("real_approval_plan_explicit_approval_blockers_missing");
      if (Number(report.requiresRealTrafficCount || 0) < 1) semanticFailures.push("real_approval_plan_real_traffic_actions_missing");
      if (Number(report.operatorSetupBlockedCount || 0) < 1) semanticFailures.push("real_approval_plan_operator_setup_blockers_missing");
      if (typeof report.nextNoTrafficAction !== "string" || !report.nextNoTrafficAction) semanticFailures.push("real_approval_plan_next_no_traffic_action_missing");
      if (sourceReports.secondAccountLoginEntrypoint?.present !== true) semanticFailures.push("real_approval_plan_second_account_entrypoint_source_missing");
      if (report.preLoginChecklistComplete !== true) semanticFailures.push("real_approval_plan_pre_login_checklist_incomplete");
      for (const checklistId of ["windows-user-account-prepare", "account-isolation-status", "second-account-login-entrypoint-status"]) {
        const entry = preLoginChecklist.find((item) => String(item?.id || "") === checklistId);
        if (!entry) {
          semanticFailures.push(`real_approval_plan_pre_login_${checklistId.replaceAll("-", "_")}_missing`);
          continue;
        }
        if (entry.noTraffic !== true) semanticFailures.push(`real_approval_plan_pre_login_${checklistId.replaceAll("-", "_")}_not_no_traffic`);
        if (entry.mustPassBeforeLogin !== true) semanticFailures.push(`real_approval_plan_pre_login_${checklistId.replaceAll("-", "_")}_not_required`);
        if (typeof entry.command !== "string" || !entry.command) semanticFailures.push(`real_approval_plan_pre_login_${checklistId.replaceAll("-", "_")}_command_missing`);
        if (checklistId === "account-isolation-status" && typeof entry.command === "string" && !entry.command.includes("-WindowsUser")) semanticFailures.push("real_approval_plan_account_status_command_missing_windows_user");
        if (typeof entry.report !== "string" || !entry.report) semanticFailures.push(`real_approval_plan_pre_login_${checklistId.replaceAll("-", "_")}_report_missing`);
      }
      const loginAction = orderedActions.find((item) => String(item?.id || "") === "second-antigravity-account-login");
      if (!loginAction || !String(loginAction.command || "").includes("-StartLoginApproval start-separate-windows-user-login")) semanticFailures.push("real_approval_plan_login_action_missing_approval_token");
      if (!loginAction || !String(loginAction.command || "").includes("-WindowsUser")) semanticFailures.push("real_approval_plan_login_action_missing_windows_user");
      const proofAction = orderedActions.find((item) => String(item?.id || "") === "second-account-identity-real-smoke");
      if (!proofAction || !String(proofAction.command || "").includes("-AllowSeparateAccountProof")) semanticFailures.push("real_approval_plan_proof_action_missing_separate_account_flag");
      if (!proofAction || !String(proofAction.command || "").includes("SeparateAccountProofApprovalId")) semanticFailures.push("real_approval_plan_proof_action_missing_approval_id");
      if (!proofAction || !String(proofAction.command || "").includes("-WindowsUser")) semanticFailures.push("real_approval_plan_proof_action_missing_windows_user");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("real_approval_plan_failures");
    }
    if (definition.requireGoalReadinessSemantics) {
      const proven = report.proven && typeof report.proven === "object" ? report.proven : {};
      const releaseGateStatus = report.releaseGateStatus && typeof report.releaseGateStatus === "object" ? report.releaseGateStatus : {};
      const worker = report.workerMcp && typeof report.workerMcp === "object" ? report.workerMcp : {};
      const roadmap = report.realTaskCoverageRoadmap && typeof report.realTaskCoverageRoadmap === "object" ? report.realTaskCoverageRoadmap : {};
      const longTaskLanding = report.longTaskLandingMatrix && typeof report.longTaskLandingMatrix === "object" ? report.longTaskLandingMatrix : {};
      const approval = report.realApprovalPlan && typeof report.realApprovalPlan === "object" ? report.realApprovalPlan : {};
      const account = report.antigravityAccountIsolation && typeof report.antigravityAccountIsolation === "object" ? report.antigravityAccountIsolation : {};
      const entrypoint = report.secondAccountLoginEntrypoint && typeof report.secondAccountLoginEntrypoint === "object" ? report.secondAccountLoginEntrypoint : {};
      const secondSummary = report.secondAccountReadinessSummary && typeof report.secondAccountReadinessSummary === "object" ? report.secondAccountReadinessSummary : {};
      const requiredWorkerServers = ["antigravity-code-worker", "deepseek-code-worker", "deveco-code-worker", "kilo-worker", "mimo-claude-coworker", "mimocode-worker", "opencode-worker"];
      const blockedGates = Array.isArray(releaseGateStatus.requiredRealTrafficBlockedGates) ? releaseGateStatus.requiredRealTrafficBlockedGates.map((item) => String(item || "")) : [];
      const blockers = Array.isArray(report.blockers) ? report.blockers.map((item) => String(item || "")) : [];
      const completedApprovalGates = Array.isArray(approval.completedRequiredGateIds) ? approval.completedRequiredGateIds.map((item) => String(item || "")) : [];
      const requiredReleaseComplete = approval.requiredReleaseComplete === true;
      if (report.reportName !== "goal-readiness") semanticFailures.push("goal_readiness_report_name");
      if (report.requestedRealTraffic !== false) semanticFailures.push("goal_readiness_real_traffic_requested");
      if (report.usedRealTraffic !== false) semanticFailures.push("goal_readiness_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("goal_readiness_behavior_not_covered");
      if (report.coverageKind !== "goal-readiness-report-only") semanticFailures.push("goal_readiness_coverage_kind");
      if (report.goalComplete === true) semanticFailures.push("goal_readiness_goal_unexpectedly_complete");
      const goalOperatorActionCard = report.goalOperatorActionCard && typeof report.goalOperatorActionCard === "object" ? report.goalOperatorActionCard : null;
      if (!goalOperatorActionCard) semanticFailures.push("goal_readiness_operator_action_card_missing");
      else {
        if (String(goalOperatorActionCard.status || "") !== "external_actions_required") semanticFailures.push("goal_readiness_operator_action_card_status");
        if (goalOperatorActionCard.canClaimFullGoalNow !== false) semanticFailures.push("goal_readiness_operator_action_card_claims_goal");
        if (goalOperatorActionCard.releaseReady !== true) semanticFailures.push("goal_readiness_operator_action_card_release_state");
        if (goalOperatorActionCard.requiresFreshCodexChannel !== true) semanticFailures.push("goal_readiness_operator_action_card_fresh_channel_required");
        if (goalOperatorActionCard.requiresUserPresence !== true) semanticFailures.push("goal_readiness_operator_action_card_user_presence_required");
        if (goalOperatorActionCard.canMakeUnattendedProgress !== false) semanticFailures.push("goal_readiness_operator_action_card_unattended_progress");
        const unattendedSafeActions = Array.isArray(goalOperatorActionCard.unattendedSafeActions) ? goalOperatorActionCard.unattendedSafeActions.map(String) : [];
        for (const requiredUnattendedAction of ["refresh_no_traffic_goal_readiness", "refresh_current_channel_worker_recovery_status", "refresh_release_gate_summary"]) {
          if (!unattendedSafeActions.includes(requiredUnattendedAction)) semanticFailures.push(`goal_readiness_operator_action_card_unattended_action:${requiredUnattendedAction}`);
        }
        const freshChannelRequiredActions = Array.isArray(goalOperatorActionCard.freshChannelRequiredActions) ? goalOperatorActionCard.freshChannelRequiredActions.map(String) : [];
        if (!freshChannelRequiredActions.includes("reload_codex_or_open_fresh_channel_then_rerun_worker_read_only_probe")) semanticFailures.push("goal_readiness_operator_action_card_fresh_channel_action");
        const userPresenceRequiredActions = Array.isArray(goalOperatorActionCard.userPresenceRequiredActions) ? goalOperatorActionCard.userPresenceRequiredActions.map(String) : [];
        if (!userPresenceRequiredActions.includes("create_or_verify_target_windows_user_then_rerun_summary")) semanticFailures.push("goal_readiness_operator_action_card_user_presence_action");
        if (String(goalOperatorActionCard.workerStatus || "") !== "reload_required") semanticFailures.push("goal_readiness_operator_action_card_worker_status");
        if (goalOperatorActionCard.workerCanDispatchCurrentChannel !== false) semanticFailures.push("goal_readiness_operator_action_card_worker_dispatch");
        if (String(goalOperatorActionCard.secondAccountStatus || "") !== "manual_windows_user_setup_required") semanticFailures.push("goal_readiness_operator_action_card_second_account_status");
        if (goalOperatorActionCard.secondAccountCanAskUserToLoginNow !== false) semanticFailures.push("goal_readiness_operator_action_card_second_account_login_too_early");
        const cardMissingRequirements = Array.isArray(goalOperatorActionCard.missingRequirements) ? goalOperatorActionCard.missingRequirements.map(String) : [];
        for (const requiredCardMissing of ["reload_codex_channel_and_verify_worker_read_only_call", "second_antigravity_account_login_and_proof"]) {
          if (!cardMissingRequirements.includes(requiredCardMissing)) semanticFailures.push(`goal_readiness_operator_action_card_missing_requirement:${requiredCardMissing}`);
        }
        const cardNextActions = Array.isArray(goalOperatorActionCard.nextOperatorActions) ? goalOperatorActionCard.nextOperatorActions.map(String) : [];
        if (cardNextActions.length < 2) semanticFailures.push("goal_readiness_operator_action_card_next_actions");
      if (!String(goalOperatorActionCard.noTrafficStatusCommand || "").includes("test-anticodex-goal-readiness.mjs")) semanticFailures.push("goal_readiness_operator_action_card_status_command");
      if (!String(goalOperatorActionCard.secondAccountStatusCommand || "").includes("test-anticodex-second-account-readiness-summary.ps1")) semanticFailures.push("goal_readiness_operator_action_card_second_account_command");
      }
      const objectiveRequirementSummary = report.objectiveRequirementSummary && typeof report.objectiveRequirementSummary === "object" ? report.objectiveRequirementSummary : null;
      const objectiveRequirementAudit = Array.isArray(report.objectiveRequirementAudit) ? report.objectiveRequirementAudit : [];
      const objectiveIncompleteIds = objectiveRequirementSummary && Array.isArray(objectiveRequirementSummary.incompleteRequirementIds) ? objectiveRequirementSummary.incompleteRequirementIds.map(String) : [];
      if (!objectiveRequirementSummary) semanticFailures.push("goal_readiness_objective_requirement_summary_missing");
      else {
        if (Number(objectiveRequirementSummary.total || 0) !== 6) semanticFailures.push("goal_readiness_objective_requirement_total");
        if (Number(objectiveRequirementSummary.completeCount || 0) !== 4) semanticFailures.push("goal_readiness_objective_requirement_complete_count");
        if (Number(objectiveRequirementSummary.incompleteCount || 0) !== 2) semanticFailures.push("goal_readiness_objective_requirement_incomplete_count");
        if (objectiveRequirementSummary.canClaimFullGoalNow !== false) semanticFailures.push("goal_readiness_objective_requirement_claims_goal");
        for (const expectedIncomplete of ["separate_antigravity_accounts", "worker_mcp_multiuse"]) {
          if (!objectiveIncompleteIds.includes(expectedIncomplete)) semanticFailures.push(`goal_readiness_objective_requirement_missing_incomplete:${expectedIncomplete}`);
        }
      }
      if (objectiveRequirementAudit.length !== 6) semanticFailures.push("goal_readiness_objective_requirement_audit_count");
      for (const requiredAuditId of ["codex_client_copy", "antigravity_model_text", "separate_antigravity_accounts", "worker_mcp_multiuse", "real_long_tasks_with_results", "native_codex_like_agentic_experience"]) {
        if (!objectiveRequirementAudit.some((item) => String(item?.id || "") === requiredAuditId)) semanticFailures.push(`goal_readiness_objective_requirement_audit_missing:${requiredAuditId}`);
      }
      for (const proof of ["codexClientCopy", "workerMcp", "desktopAgenticTasks", "agenticCapabilityMatrix", "realTaskCoverageRoadmap", "longTaskLandingMatrix", "realApprovalPlan", "releaseShortPath", "secondAccountLoginEntrypoint", "secondAccountReadinessSummary", "accountIsolationPreparedOnly"]) {
        if (proven[proof] !== true) semanticFailures.push(`goal_readiness_${proof}_not_proven`);
      }
      if (Number(worker.passedServerCount || 0) < requiredWorkerServers.length) semanticFailures.push("goal_readiness_worker_mcp_passed_count");
      const toolCountByServer = worker.toolCountByServer && typeof worker.toolCountByServer === "object" ? worker.toolCountByServer : {};
      for (const server of requiredWorkerServers) {
        if (Number(toolCountByServer[server] || 0) < 1) semanticFailures.push(`goal_readiness_worker_mcp_tool_count:${server}`);
      }
      if (Array.isArray(worker.incompleteToolCountServers) && worker.incompleteToolCountServers.length > 0) semanticFailures.push("goal_readiness_worker_mcp_tool_count_incomplete");
      if (blockers.includes("worker_mcp_tool_count_incomplete")) semanticFailures.push("goal_readiness_worker_mcp_tool_count_blocker_present");
      if (worker.taskSmokeReportOk !== true) semanticFailures.push("goal_readiness_worker_mcp_task_smoke_not_ok");
      if (worker.taskSmokeUsedRealTraffic !== true) semanticFailures.push("goal_readiness_worker_mcp_task_smoke_real_traffic_missing");
      if (worker.taskSmokeAntigravityExcluded !== true) semanticFailures.push("goal_readiness_worker_mcp_task_smoke_antigravity_not_excluded");
      if (Number(worker.taskSmokePassedWorkerCount || 0) < REQUIRED_WORKER_MCP_TASK_SMOKE_PASSED_WORKERS) semanticFailures.push("goal_readiness_worker_mcp_task_smoke_passed_count");
      if (Array.isArray(worker.taskSmokeMissingRequiredWorkers) && worker.taskSmokeMissingRequiredWorkers.length > 0) semanticFailures.push("goal_readiness_worker_mcp_task_smoke_missing_required_workers");
      if (Array.isArray(worker.taskSmokeFailedWorkers) && worker.taskSmokeFailedWorkers.length > 0) semanticFailures.push("goal_readiness_worker_mcp_task_smoke_failed_workers");
      if (worker.projectSmokeReportOk !== true) semanticFailures.push("goal_readiness_worker_mcp_project_smoke_not_ok");
      if (worker.projectSmokeScenario !== "project") semanticFailures.push("goal_readiness_worker_mcp_project_smoke_scenario");
      if (worker.projectSmokeUsedRealTraffic !== true) semanticFailures.push("goal_readiness_worker_mcp_project_smoke_real_traffic_missing");
      if (worker.projectSmokeAntigravityExcluded !== true) semanticFailures.push("goal_readiness_worker_mcp_project_smoke_antigravity_not_excluded");
      if (Number(worker.projectSmokePassedWorkerCount || 0) < REQUIRED_WORKER_MCP_TASK_SMOKE_PASSED_WORKERS) semanticFailures.push("goal_readiness_worker_mcp_project_smoke_passed_count");
      if (Array.isArray(worker.projectSmokeMissingRequiredWorkers) && worker.projectSmokeMissingRequiredWorkers.length > 0) semanticFailures.push("goal_readiness_worker_mcp_project_smoke_missing_required_workers");
      if (Array.isArray(worker.projectSmokeFailedWorkers) && worker.projectSmokeFailedWorkers.length > 0) semanticFailures.push("goal_readiness_worker_mcp_project_smoke_failed_workers");
      if (worker.complexProjectSmokeReportOk !== true) semanticFailures.push("goal_readiness_worker_mcp_complex_project_smoke_not_ok");
      if (worker.complexProjectSmokeScenario !== "complex-project") semanticFailures.push("goal_readiness_worker_mcp_complex_project_smoke_scenario");
      if (worker.complexProjectSmokeUsedRealTraffic !== true) semanticFailures.push("goal_readiness_worker_mcp_complex_project_smoke_real_traffic_missing");
      if (worker.complexProjectSmokeAntigravityExcluded !== true) semanticFailures.push("goal_readiness_worker_mcp_complex_project_smoke_antigravity_not_excluded");
      if (Number(worker.complexProjectSmokePassedWorkerCount || 0) < REQUIRED_WORKER_MCP_TASK_SMOKE_PASSED_WORKERS) semanticFailures.push("goal_readiness_worker_mcp_complex_project_smoke_passed_count");
      if (Array.isArray(worker.complexProjectSmokeMissingRequiredWorkers) && worker.complexProjectSmokeMissingRequiredWorkers.length > 0) semanticFailures.push("goal_readiness_worker_mcp_complex_project_smoke_missing_required_workers");
      if (Array.isArray(worker.complexProjectSmokeFailedWorkers) && worker.complexProjectSmokeFailedWorkers.length > 0) semanticFailures.push("goal_readiness_worker_mcp_complex_project_smoke_failed_workers");
      if (releaseGateStatus.shortReady !== true) semanticFailures.push("goal_readiness_short_not_ready");
      for (const gateId of ["accountProxyReadiness", "postVerification"]) {
        if (requiredReleaseComplete) {
          if (!completedApprovalGates.includes(gateId)) semanticFailures.push(`goal_readiness_${gateId}_completed_gate_missing`);
        } else if (completedApprovalGates.includes(gateId)) {
          // Already completed gates do not need a pending blocker entry.
        } else {
          if (!blockedGates.includes(gateId)) semanticFailures.push(`goal_readiness_${gateId}_blocked_gate_missing`);
          if (!blockers.includes(`required_real_traffic_gate_blocked:${gateId}`)) semanticFailures.push(`goal_readiness_${gateId}_blocker_missing`);
        }
      }
      if (requiredReleaseComplete) {
        if (releaseGateStatus.releaseReady !== true) semanticFailures.push("goal_readiness_release_not_ready_after_completed_required_gates");
      } else {
        if (releaseGateStatus.releaseReady === true) semanticFailures.push("goal_readiness_release_unexpectedly_ready");
        if (releaseGateStatus.releaseBlockedOnlyByRequiredRealTraffic !== true) semanticFailures.push("goal_readiness_release_not_blocked_only_by_real_traffic");
      }
      if (!blockers.includes("second_antigravity_account_real_proof_missing")) semanticFailures.push("goal_readiness_account_real_proof_blocker_missing");
      if (Array.isArray(roadmap.missingProfiles) && roadmap.missingProfiles.length > 0) semanticFailures.push("goal_readiness_roadmap_missing_profiles");
      if (Number(roadmap.artifactProofTaskCount || 0) < 5) semanticFailures.push("goal_readiness_artifact_proof_missing");
      if (Number(roadmap.missingArtifactProofTaskCount || 0) !== 0) semanticFailures.push("goal_readiness_artifact_proof_missing");
      if (Array.isArray(roadmap.missingArtifactProofTasks) && roadmap.missingArtifactProofTasks.length > 0) semanticFailures.push("goal_readiness_artifact_proof_missing");
      if (roadmap.artifactProofComplete !== true) semanticFailures.push("goal_readiness_artifact_proof_missing");
      if (blockers.includes("real_task_artifact_proof_missing")) semanticFailures.push("goal_readiness_artifact_proof_blocker_present");
      if (Number(roadmap.resultProofTaskCount || 0) < 9) semanticFailures.push("goal_readiness_result_proof_missing");
      if (Number(roadmap.missingResultProofTaskCount || 0) !== 0) semanticFailures.push("goal_readiness_result_proof_missing");
      if (Array.isArray(roadmap.missingResultProofTasks) && roadmap.missingResultProofTasks.length > 0) semanticFailures.push("goal_readiness_result_proof_missing");
      if (roadmap.resultProofComplete !== true) semanticFailures.push("goal_readiness_result_proof_missing");
      if (blockers.includes("real_task_result_proof_missing")) semanticFailures.push("goal_readiness_result_proof_blocker_present");
      if (longTaskLanding.longTaskLandingComplete !== true) semanticFailures.push("goal_readiness_long_task_landing_incomplete");
      if (Number(longTaskLanding.landedLongTaskCount || 0) < 7) semanticFailures.push("goal_readiness_long_task_landing_count");
      if (Array.isArray(longTaskLanding.failedLongTaskModes) && longTaskLanding.failedLongTaskModes.length > 0) semanticFailures.push("goal_readiness_long_task_landing_failed_modes");
      if (roadmap.approvalRequiredForRefresh === true) {
        if (!Array.isArray(roadmap.uniqueRefreshTasks) || roadmap.uniqueRefreshTasks.length < 1) semanticFailures.push("goal_readiness_refresh_tasks_missing");
        if (roadmap.minimalRefreshCommandPresent !== true) semanticFailures.push("goal_readiness_refresh_command_missing");
        if (roadmap.minimalRefreshCommandRequiresRealTraffic !== true) semanticFailures.push("goal_readiness_refresh_command_not_real_traffic");
      }
      if (requiredReleaseComplete) {
        if (Number(approval.requiredReleaseRealTrafficActionCount || 0) !== 0) semanticFailures.push("goal_readiness_completed_release_still_has_required_actions");
      } else if (Number(approval.requiredReleaseRealTrafficActionCount || 0) < 1) {
        semanticFailures.push("goal_readiness_required_approval_actions_missing");
      }
      if (approval.optionalReleaseRealTrafficActionCount === undefined || approval.optionalReleaseRealTrafficActionCount === null) semanticFailures.push("goal_readiness_optional_approval_actions_missing");
      if (account.releaseAcceptableAccountProof !== false) semanticFailures.push("goal_readiness_account_proof_unexpectedly_acceptable");
      if (entrypoint.reportName !== "second-antigravity-account-login-entrypoint") semanticFailures.push("goal_readiness_second_account_entrypoint_report_name");
      if (entrypoint.noTraffic !== true) semanticFailures.push("goal_readiness_second_account_entrypoint_not_no_traffic");
      if (entrypoint.usedRealTraffic !== false) semanticFailures.push("goal_readiness_second_account_entrypoint_used_real_traffic");
      if (entrypoint.coverageKind !== "second-account-login-entrypoint-no-traffic") semanticFailures.push("goal_readiness_second_account_entrypoint_coverage_kind");
      if (entrypoint.statusOnlyOk !== true) semanticFailures.push("goal_readiness_second_account_entrypoint_status_only_missing");
      if (entrypoint.missingApprovalBlocked !== true) semanticFailures.push("goal_readiness_second_account_entrypoint_missing_approval_not_blocked");
      if (entrypoint.approvedStartBlockedByStatusGate !== true) semanticFailures.push("goal_readiness_second_account_entrypoint_status_gate_not_blocking");
      if (entrypoint.sameWindowsUserTargetBlocked !== true) semanticFailures.push("goal_readiness_second_account_entrypoint_same_user_not_blocked");
      if (!String(entrypoint.approvedLoginCommandTemplate || "").includes("-WindowsUser") || !String(entrypoint.approvedLoginCommandTemplate || "").includes("-StartLoginApproval start-separate-windows-user-login")) semanticFailures.push("goal_readiness_second_account_entrypoint_login_template_incomplete");
      if (!String(entrypoint.nextNoTrafficStatusCommand || "").includes("test-anticodex-antigravity-account-isolation-status.ps1") || !String(entrypoint.nextNoTrafficStatusCommand || "").includes("-WindowsUser")) semanticFailures.push("goal_readiness_second_account_entrypoint_status_template_incomplete");
      if (!String(entrypoint.postLoginProofCommandTemplate || "").includes("-AllowSeparateAccountProof") || !String(entrypoint.postLoginProofCommandTemplate || "").includes("SeparateAccountProofApprovalId") || !String(entrypoint.postLoginProofCommandTemplate || "").includes("-WindowsUser")) semanticFailures.push("goal_readiness_second_account_entrypoint_proof_template_incomplete");
      if (entrypoint.approvedLoginCommandPresent !== true) semanticFailures.push("goal_readiness_second_account_entrypoint_login_command_missing");
      if (entrypoint.nextNoTrafficStatusCommandPresent !== true) semanticFailures.push("goal_readiness_second_account_entrypoint_status_command_missing");
      if (entrypoint.postLoginProofCommandPresent !== true) semanticFailures.push("goal_readiness_second_account_entrypoint_proof_command_missing");
      if (entrypoint.postLoginProofCommandTemplateHasWindowsUser !== true) semanticFailures.push("goal_readiness_second_account_entrypoint_proof_command_windows_user_missing");
      if (entrypoint.postLoginProofPlanValid !== true) semanticFailures.push("goal_readiness_second_account_entrypoint_proof_plan_invalid");
      if (secondSummary.reportName !== "second-account-readiness-summary") semanticFailures.push("goal_readiness_second_account_readiness_summary_missing_or_invalid");
      if (secondSummary.noTraffic !== true) semanticFailures.push("goal_readiness_second_account_readiness_summary_not_no_traffic");
      if (secondSummary.usedRealTraffic !== false) semanticFailures.push("goal_readiness_second_account_readiness_summary_used_real_traffic");
      if (secondSummary.coverageKind !== "second-account-readiness-summary-no-traffic") semanticFailures.push("goal_readiness_second_account_readiness_summary_coverage_kind");
      if (secondSummary.releaseAcceptableAccountProof !== false) semanticFailures.push("goal_readiness_second_account_readiness_summary_release_proof_claimed");
      if (secondSummary.goalComplete !== false) semanticFailures.push("goal_readiness_second_account_readiness_summary_goal_complete_claimed");
      if (!String(secondSummary.nextOperatorAction || "")) semanticFailures.push("goal_readiness_second_account_readiness_summary_next_action_missing");
      const secondSummaryChecklistStages = Array.isArray(secondSummary.operatorChecklistStages) ? secondSummary.operatorChecklistStages.map(String) : [];
      const expectedSecondSummaryChecklistStages = ["create_target_windows_user", "windows_user_account_prepare", "account_isolation_status", "second_account_login_entrypoint_with_explicit_approval"];
      if (!String(secondSummary.manualSetupCommandHint || "")) semanticFailures.push("goal_readiness_second_account_readiness_summary_manual_hint_missing");
      if (secondSummaryChecklistStages.join("|") !== expectedSecondSummaryChecklistStages.join("|")) semanticFailures.push("goal_readiness_second_account_readiness_summary_checklist_order");
      if (Number(secondSummary.operatorChecklistStartsLoginCount || 0) !== 1) semanticFailures.push("goal_readiness_second_account_readiness_summary_checklist_login_count");
      if (Number(secondSummary.operatorChecklistUsesRealTrafficCount || 0) !== 0) semanticFailures.push("goal_readiness_second_account_readiness_summary_checklist_real_traffic_count");
      if (!String(secondSummary.accountIsolationCaveat || "")) semanticFailures.push("goal_readiness_second_account_readiness_summary_caveat_missing");
      if (!String(secondSummary.approvedLoginCommandTemplate || "").includes("start-anticodex-second-antigravity-account-login.ps1") || !String(secondSummary.approvedLoginCommandTemplate || "").includes("-StartLoginApproval start-separate-windows-user-login")) semanticFailures.push("goal_readiness_second_account_readiness_summary_login_template_incomplete");
      if (!String(secondSummary.nextNoTrafficStatusCommand || "").includes("test-anticodex-antigravity-account-isolation-status.ps1")) semanticFailures.push("goal_readiness_second_account_readiness_summary_status_template_incomplete");
      if (!String(secondSummary.postLoginProofCommandTemplate || "").includes("test-anticodex-antigravity-cli-real-smoke.ps1") || !String(secondSummary.postLoginProofCommandTemplate || "").includes("-AllowSeparateAccountProof") || !String(secondSummary.postLoginProofCommandTemplate || "").includes("SeparateAccountProofApprovalId") || !String(secondSummary.postLoginProofCommandTemplate || "").includes("-WindowsUser")) semanticFailures.push("goal_readiness_second_account_readiness_summary_proof_template_incomplete");
      if (secondSummary.approvedLoginCommandPresent !== true) semanticFailures.push("goal_readiness_second_account_readiness_summary_login_command_missing");
      if (secondSummary.nextNoTrafficStatusCommandPresent !== true) semanticFailures.push("goal_readiness_second_account_readiness_summary_status_command_missing");
      if (secondSummary.postLoginProofCommandPresent !== true) semanticFailures.push("goal_readiness_second_account_readiness_summary_proof_command_missing");
      if (secondSummary.postLoginProofCommandTemplateHasWindowsUser !== true) semanticFailures.push("goal_readiness_second_account_readiness_summary_proof_command_windows_user_missing");
      if (Number(secondSummary.stepCount || 0) < 7) semanticFailures.push("goal_readiness_second_account_readiness_summary_step_count");
      if (Number(secondSummary.failedStepCount || 0) !== 0) semanticFailures.push("goal_readiness_second_account_readiness_summary_failed_steps");
      if (Number(secondSummary.failureCount || 0) !== 0) semanticFailures.push("goal_readiness_second_account_readiness_summary_failures");
      if (typeof report.nextRequiredUserAction !== "string" || !report.nextRequiredUserAction) semanticFailures.push("goal_readiness_next_user_action_missing");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("goal_readiness_failures");
    }
    if (definition.requireToolLoopSemantics) {
      const finalText = String(report.final_text || "");
      const callId = String(report.call_id || "");
      const tool = report.tool && typeof report.tool === "object" ? report.tool : {};
      const containsNumber = (value, numberText) => new RegExp(`(^|\\D)${numberText}(\\D|$)`).test(value);
      const expectedToolLoopReportNames = {
        standard: "tool-loop",
        native: "native-tool-loop",
        "native-multi": "native-multi-tool-loop",
        mcp: "mcp-tool-loop",
        custom: "custom-tool-loop",
      };
      const expectedReportName = expectedToolLoopReportNames[definition.requireToolLoopSemantics];
      const failurePrefix = definition.id.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
      const nativeBridgeDisabledSkip = (
        (definition.requireToolLoopSemantics === "native" || definition.requireToolLoopSemantics === "native-multi") &&
        report.skipped === true &&
        report.nativeBridgeDefaultEnabled === false &&
        report.reason === "native_bridge_disabled"
      );
      if (nativeBridgeDisabledSkip) {
        if (report.reportName !== expectedReportName) semanticFailures.push(`${failurePrefix}_report_name`);
        if (report.requestedRealTraffic !== false) semanticFailures.push(`${failurePrefix}_disabled_skip_requested_real_traffic`);
        if (report.usedRealTraffic !== false) semanticFailures.push(`${failurePrefix}_disabled_skip_used_real_traffic`);
        if (report.behaviorCovered !== false) semanticFailures.push(`${failurePrefix}_disabled_skip_behavior_covered`);
        if (report.coverageKind !== "native-bridge-disabled") semanticFailures.push(`${failurePrefix}_disabled_skip_coverage_kind`);
        if (report.coveredBy !== "codex-owned-tools-model-only") semanticFailures.push(`${failurePrefix}_disabled_skip_covered_by`);
      } else {
      if (report.reportName !== expectedReportName) semanticFailures.push(`${failurePrefix}_report_name`);
      if (report.requestedRealTraffic !== true) semanticFailures.push(`${failurePrefix}_real_traffic_not_requested`);
      if (report.usedRealTraffic !== true) semanticFailures.push(`${failurePrefix}_real_traffic_missing`);
      if (report.behaviorCovered !== true) semanticFailures.push(`${failurePrefix}_behavior_not_covered`);
      if (report.coverageKind !== "real-traffic") semanticFailures.push(`${failurePrefix}_coverage_kind`);
      if (definition.requireToolLoopSemantics === "standard") {
        if (!callId) semanticFailures.push("tool_loop_call_id_missing");
        if (!finalText.includes("MARKER_731")) semanticFailures.push("tool_loop_marker_missing");
        if (!containsNumber(finalText, "42")) semanticFailures.push("tool_loop_value_missing");
      }
      if (definition.requireToolLoopSemantics === "native") {
        const argumentsObject = report.arguments && typeof report.arguments === "object" ? report.arguments : {};
        if (!callId) semanticFailures.push("native_tool_loop_call_id_missing");
        if (callId && /^pseudo_/.test(callId)) semanticFailures.push("native_tool_loop_pseudo_call_id");
        if (report.native_call_id !== true) semanticFailures.push("native_tool_loop_native_call_id_missing");
        if (String(argumentsObject.marker || "") !== "NATIVE_MARKER_8462") semanticFailures.push("native_tool_loop_marker_argument_missing");
        if (!finalText.includes("NATIVE_MARKER_8462") || !finalText.includes("RECORDED")) semanticFailures.push("native_tool_loop_result_missing");
      }
      if (definition.requireToolLoopSemantics === "native-multi") {
        const firstCall = report.first_call && typeof report.first_call === "object" ? report.first_call : {};
        const secondCall = report.second_call && typeof report.second_call === "object" ? report.second_call : {};
        if (firstCall.name !== "marker_tool" || !firstCall.call_id || /^pseudo_/.test(String(firstCall.call_id))) semanticFailures.push("native_multi_tool_loop_first_call_missing");
        if (secondCall.name !== "echo_tool" || !secondCall.call_id || /^pseudo_/.test(String(secondCall.call_id))) semanticFailures.push("native_multi_tool_loop_second_call_missing");
        if (report.native_call_ids !== true) semanticFailures.push("native_multi_tool_loop_native_call_ids_missing");
        if (!finalText.includes("NATIVE_MULTI_MARKER_739") || !containsNumber(finalText, "99")) semanticFailures.push("native_multi_tool_loop_marker_result_missing");
        if (!finalText.includes("NATIVE_MULTI_ECHO_284") || !finalText.includes("confirmed")) semanticFailures.push("native_multi_tool_loop_echo_result_missing");
      }
      if (definition.requireToolLoopSemantics === "mcp") {
        const realMcp = tool.realMcp && typeof tool.realMcp === "object" ? tool.realMcp : {};
        if (!callId) semanticFailures.push("mcp_tool_loop_call_id_missing");
        if (tool.emittedName !== "js" || tool.expectedFlattenedName !== "mcp__node_repl__js") semanticFailures.push("mcp_tool_loop_expected_tool_missing");
        if (realMcp.ok !== true || realMcp.markerObserved !== true || Number(realMcp.toolCount || 0) < 1) semanticFailures.push("mcp_tool_loop_real_mcp_missing");
        if (!String(tool.code || "").includes("MCP_NODE_REPL_417") || !String(realMcp.output || "").includes("MCP_NODE_REPL_417") || !finalText.includes("MCP_NODE_REPL_417")) semanticFailures.push("mcp_tool_loop_marker_missing");
        if (!String(tool.code || "").includes("42") || !String(realMcp.output || "").includes("42") || !containsNumber(finalText, "42")) semanticFailures.push("mcp_tool_loop_value_missing");
      }
      if (definition.requireToolLoopSemantics === "custom") {
        if (!callId) semanticFailures.push("custom_tool_loop_call_id_missing");
        if (tool.type !== "custom_tool_call") semanticFailures.push("custom_tool_loop_type_mismatch");
        if (tool.name !== "apply_patch") semanticFailures.push("custom_tool_loop_name_mismatch");
        if (tool.inputPreserved !== true) semanticFailures.push("custom_tool_loop_input_not_preserved");
        if (tool.marker !== "CUSTOM_PATCH_519" || !finalText.includes("CUSTOM_PATCH_519")) semanticFailures.push("custom_tool_loop_marker_missing");
      }
      }
    }
    if (definition.requireWebToolsSemantics) {
      const finalText = String(report.finalText || report.final_text || "");
      if (report.reportName !== "web-tools") semanticFailures.push("web_tools_report_name");
      if (report.requestedRealTraffic !== true) semanticFailures.push("web_tools_real_traffic_not_requested");
      if (report.usedRealTraffic !== true) semanticFailures.push("web_tools_real_traffic_missing");
      if (report.behaviorCovered !== true) semanticFailures.push("web_tools_behavior_not_covered");
      if (report.coverageKind !== "real-traffic") semanticFailures.push("web_tools_coverage_kind");
      if (!finalText || !/(Example Domain|documentation examples|Avoid use in operations)/i.test(finalText)) semanticFailures.push("web_tools_evidence_missing");
      if (/<tool_calls>|<invoke|web_fetch.+\{/i.test(finalText)) semanticFailures.push("web_tools_protocol_leak");
    }
    if (definition.requireCompactionResumeSemantics) {
      const seed = String(report.seed || "");
      const compactSummary = String(report.compact_summary_preview || report.compact_summary || "");
      const directResumeText = String(report.direct_resume_text || "");
      const chainedResumeText = String(report.chained_resume_text || "");
      const hasContinuationFacts = (text) => seed && text.includes(seed) && /verify/i.test(text) && /compaction/i.test(text) && /resume/i.test(text);
      if (report.reportName !== "compaction-resume") semanticFailures.push("compaction_resume_report_name");
      if (report.requestedRealTraffic !== true) semanticFailures.push("compaction_resume_real_traffic_not_requested");
      if (report.usedRealTraffic !== true) semanticFailures.push("compaction_resume_real_traffic_missing");
      if (report.behaviorCovered !== true) semanticFailures.push("compaction_resume_behavior_not_covered");
      if (report.coverageKind !== "real-traffic") semanticFailures.push("compaction_resume_coverage_kind");
      if (!seed) semanticFailures.push("compaction_resume_seed_missing");
      if (!report.first_response_id) semanticFailures.push("compaction_resume_first_response_missing");
      if (!report.compact_response_id) semanticFailures.push("compaction_resume_compact_response_missing");
      if (Number(report.compact_summary_length || 0) < 20) semanticFailures.push("compaction_resume_summary_too_short");
      if (!seed || !compactSummary.includes(seed)) semanticFailures.push("compaction_resume_summary_seed_missing");
      if (!hasContinuationFacts(directResumeText)) semanticFailures.push("compaction_resume_direct_resume_missing");
      if (!hasContinuationFacts(chainedResumeText)) semanticFailures.push("compaction_resume_chained_resume_missing");
    }
    if (definition.requireCancellationSemantics) {
      const eventNames = Array.isArray(report.eventNames) ? report.eventNames.map((item) => String(item)) : [];
      if (report.reportName !== "cancellation") semanticFailures.push("cancellation_report_name");
      if (report.requestedRealTraffic !== true) semanticFailures.push("cancellation_real_traffic_not_requested");
      if (report.usedRealTraffic !== true) semanticFailures.push("cancellation_real_traffic_missing");
      if (report.behaviorCovered !== true) semanticFailures.push("cancellation_behavior_not_covered");
      if (report.coverageKind !== "real-traffic") semanticFailures.push("cancellation_coverage_kind");
      if (!report.responseId) semanticFailures.push("cancellation_response_id_missing");
      if (report.cancelStatus !== "cancelled") semanticFailures.push("cancellation_status_not_cancelled");
      if (report.cancelError !== null && report.cancelError !== undefined && report.cancelError !== "") semanticFailures.push("cancellation_error_present");
      if (report.hasCancelled !== true) semanticFailures.push("cancellation_cancelled_event_missing");
      if (report.hasCompleted === true) semanticFailures.push("cancellation_completed_unexpected");
      if (report.hasFailed === true) semanticFailures.push("cancellation_failed_unexpected");
      if (!eventNames.includes("response.created") || !eventNames.includes("response.cancelled")) semanticFailures.push("cancellation_event_names_missing");
      if (report.providerReady !== true || report.preHealthReady !== true || report.postHealthReady !== true) semanticFailures.push("cancellation_provider_not_ready");
      if (!report.mode) semanticFailures.push("cancellation_mode_missing");
      if (!report.model) semanticFailures.push("cancellation_model_missing");
    }
    if (definition.requireRealMiniToolSemantics) {
      const artifact = report.artifact && typeof report.artifact === "object" ? report.artifact : {};
      const executor = report.executor && typeof report.executor === "object" ? report.executor : {};
      const finalText = String(report.final_text || "");
      if (report.reportName !== "real-mini-tool") semanticFailures.push("real_mini_tool_report_name");
      if (report.requestedRealTraffic !== true) semanticFailures.push("real_mini_tool_real_traffic_not_requested");
      if (report.usedRealTraffic !== true) semanticFailures.push("real_mini_tool_real_traffic_missing");
      if (report.behaviorCovered !== true) semanticFailures.push("real_mini_tool_behavior_not_covered");
      if (report.coverageKind !== "real-traffic") semanticFailures.push("real_mini_tool_coverage_kind");
      if (!report.first_response_id) semanticFailures.push("real_mini_tool_first_response_missing");
      if (!report.call_id) semanticFailures.push("real_mini_tool_call_id_missing");
      if (artifact.exists !== true) semanticFailures.push("real_mini_tool_artifact_missing");
      if (artifact.ran !== true) semanticFailures.push("real_mini_tool_artifact_not_run");
      if (artifact.markerMatched !== true) semanticFailures.push("real_mini_tool_marker_mismatch");
      if (executor.tool !== "create_mini_tool") semanticFailures.push("real_mini_tool_executor_mismatch");
      if (executor.realFileWrite !== true) semanticFailures.push("real_mini_tool_file_write_missing");
      if (!finalText.includes("CLI_OK")) semanticFailures.push("real_mini_tool_final_confirmation_missing");
      if (!/[\u4e00-\u9fff]/.test(finalText)) semanticFailures.push("real_mini_tool_chinese_missing");
      if (/DeepCodex|Deep Codex/.test(finalText)) semanticFailures.push("real_mini_tool_legacy_brand_leak");
    }
    if (definition.requireRealWorkSemantics) {
      const artifact = report.artifact && typeof report.artifact === "object" ? report.artifact : {};
      const executor = report.executor && typeof report.executor === "object" ? report.executor : {};
      const realMcp = executor.realMcp && typeof executor.realMcp === "object" ? executor.realMcp : {};
      const finalText = String(report.final_text || "");
      if (report.reportName !== "real-work") semanticFailures.push("real_work_report_name");
      if (report.requestedRealTraffic !== true) semanticFailures.push("real_work_real_traffic_not_requested");
      if (report.usedRealTraffic !== true) semanticFailures.push("real_work_real_traffic_missing");
      if (report.behaviorCovered !== true) semanticFailures.push("real_work_behavior_not_covered");
      if (report.coverageKind !== "real-traffic") semanticFailures.push("real_work_coverage_kind");
      if (!report.first_response_id) semanticFailures.push("real_work_first_response_missing");
      if (!report.call_id) semanticFailures.push("real_work_call_id_missing");
      if (artifact.exists !== true) semanticFailures.push("real_work_artifact_missing");
      if (artifact.ran !== true) semanticFailures.push("real_work_artifact_not_run");
      if (artifact.markerMatched !== true) semanticFailures.push("real_work_marker_mismatch");
      if (executor.tool !== "create_probe_file") semanticFailures.push("real_work_executor_mismatch");
      if (executor.realFileWrite !== true) semanticFailures.push("real_work_file_write_missing");
      if (realMcp.ok !== true || realMcp.markerObserved !== true) semanticFailures.push("real_work_mcp_missing");
      if (!finalText.includes("FILE_OK")) semanticFailures.push("real_work_final_confirmation_missing");
      if (!/[\u4e00-\u9fff]/.test(finalText)) semanticFailures.push("real_work_chinese_missing");
      if (/DeepCodex|Deep Codex/.test(finalText)) semanticFailures.push("real_work_legacy_brand_leak");
    }
    if (definition.requireRealSmallProjectSemantics) {
      const artifact = report.artifact && typeof report.artifact === "object" ? report.artifact : {};
      const files = Array.isArray(artifact.files) ? artifact.files.map((item) => String(item).replaceAll("\\", "/")) : [];
      const finalText = String(report.final_text || "");
      if (report.reportName !== "real-small-project") semanticFailures.push("real_small_project_report_name");
      if (report.requestedRealTraffic !== true) semanticFailures.push("real_small_project_real_traffic_not_requested");
      if (report.usedRealTraffic !== true) semanticFailures.push("real_small_project_real_traffic_missing");
      if (report.behaviorCovered !== true) semanticFailures.push("real_small_project_behavior_not_covered");
      if (report.coverageKind !== "real-traffic-small-project") semanticFailures.push("real_small_project_coverage_kind");
      if (!report.first_response_id) semanticFailures.push("real_small_project_first_response_missing");
      if (!report.call_id) semanticFailures.push("real_small_project_call_id_missing");
      for (const requiredFile of ["package.json", "word-tally.mjs", "word-tally.test.mjs"]) {
        if (!files.includes(requiredFile)) semanticFailures.push(`real_small_project_${requiredFile.replaceAll(".", "_")}_missing`);
      }
      if (artifact.testPassed !== true) semanticFailures.push("real_small_project_tests_not_passed");
      if (artifact.cliPassed !== true) semanticFailures.push("real_small_project_cli_not_passed");
      if (artifact.markerMatched !== true) semanticFailures.push("real_small_project_marker_mismatch");
      if (!finalText.includes("SMALL_PROJECT_OK")) semanticFailures.push("real_small_project_final_confirmation_missing");
      if (!/[\u4e00-\u9fff]/.test(finalText)) semanticFailures.push("real_small_project_chinese_missing");
      if (/DeepCodex|Deep Codex/.test(finalText)) semanticFailures.push("real_small_project_legacy_brand_leak");
    }
    if (definition.requireAccountProxySemantics) {
      const phaseSummary = report.phaseSummary && typeof report.phaseSummary === "object" ? report.phaseSummary : {};
      const antigravityLogSignals = report.antigravityLogSignals && typeof report.antigravityLogSignals === "object" ? report.antigravityLogSignals : {};
      if (!report.diagnosisDetail) semanticFailures.push("account_proxy_diagnosis_detail_missing");
      if (!report.suggestedAction) semanticFailures.push("account_proxy_suggested_action_missing");
      if (report.localProxyBypassed !== true) semanticFailures.push("account_proxy_local_proxy_not_bypassed");
      if (phaseSummary.accountOk !== true && !phaseSummary.accountProbeStaleButModelsAvailable) semanticFailures.push("account_proxy_account_not_ok");
      if (phaseSummary.refreshOk !== true && !(phaseSummary.accountProbeStaleButModelsAvailable && phaseSummary.realRequestOk === true)) semanticFailures.push("account_proxy_refresh_not_ok");
      if (Number(phaseSummary.modelCount || 0) < 1) semanticFailures.push("account_proxy_model_count");
      if (phaseSummary.realRequestAttempted !== true) semanticFailures.push("account_proxy_real_request_not_attempted");
      if (phaseSummary.realRequestOk !== true) semanticFailures.push("account_proxy_real_request_not_ok");
      if (phaseSummary.realRequestMode !== "non-stream" && phaseSummary.realRequestMode !== "streaming-fallback") semanticFailures.push("account_proxy_real_request_mode");
      if (!Number.isFinite(Number(phaseSummary.realRequestAttemptCount)) || Number(phaseSummary.realRequestAttemptCount) < 1) semanticFailures.push("account_proxy_real_request_attempt_count");
      if (antigravityLogSignals.sourcePresent !== true) semanticFailures.push("account_proxy_log_source_missing");
      if (typeof antigravityLogSignals.tailLinesScanned !== "number" || !Number.isFinite(antigravityLogSignals.tailLinesScanned) || antigravityLogSignals.tailLinesScanned < 0) semanticFailures.push("account_proxy_log_scan_missing");
    }
    if (definition.requireOptionalRealTrafficSemantics && present) {
      if (report.skipped === true) {
        semanticFailures.push("optional_real_traffic_not_requested");
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
        if (definition.id === "antigravityCliRealSmokeOptional") {
          if (report.reportName !== "antigravity-cli-real-smoke") semanticFailures.push("optional_antigravity_cli_real_smoke_report_name");
          if (report.loginVerified !== true) semanticFailures.push("optional_antigravity_cli_real_smoke_login_not_verified");
          if (!report.profileRoot) semanticFailures.push("optional_antigravity_cli_real_smoke_profile_missing");
          if (report.strictWindowsAppDataIsolation !== true) semanticFailures.push("optional_antigravity_cli_real_smoke_strict_isolation_missing");
          if (report.profileRoot && String(report.profileRoot).toLowerCase() === String(process.env.USERPROFILE || "").toLowerCase()) semanticFailures.push("optional_antigravity_cli_real_smoke_default_profile");
          if (report.separateAccountVerified === undefined) semanticFailures.push("optional_antigravity_cli_real_smoke_separate_account_verified_missing");
          if (report.separateAccountVerified === true) {
            const comparison = report.accountIdentityComparison && typeof report.accountIdentityComparison === "object" ? report.accountIdentityComparison : null;
            if (!comparison && !report.accountIdentityEvidence) semanticFailures.push("optional_antigravity_cli_real_smoke_separate_account_identity_evidence_missing");
            if (!comparison) {
              semanticFailures.push("optional_antigravity_cli_real_smoke_identity_comparison_missing");
            } else {
              const antiCodexAccountId = typeof comparison.antiCodexAccountId === "string" ? comparison.antiCodexAccountId.trim() : "";
              const mcpAccountId = typeof comparison.mcpAccountId === "string" ? comparison.mcpAccountId.trim() : "";
              if (!antiCodexAccountId) semanticFailures.push("optional_antigravity_cli_real_smoke_anticodex_account_id_missing");
              if (!mcpAccountId) semanticFailures.push("optional_antigravity_cli_real_smoke_mcp_account_id_missing");
              if (antiCodexAccountId && mcpAccountId && antiCodexAccountId === mcpAccountId) semanticFailures.push("optional_antigravity_cli_real_smoke_identity_accounts_match");
              if (comparison.antiCodexSource !== "anticodex-cli-real-smoke") semanticFailures.push("optional_antigravity_cli_real_smoke_anticodex_identity_source");
              if (comparison.mcpSource !== "external-mcp-antigravity-account") semanticFailures.push("optional_antigravity_cli_real_smoke_mcp_identity_source");
              if (comparison.comparisonMethod !== "explicit-user-approved-account-identity-parameter") semanticFailures.push("optional_antigravity_cli_real_smoke_identity_comparison_method");
              if (typeof comparison.capturedAt !== "string" || !comparison.capturedAt.trim() || Number.isNaN(Date.parse(comparison.capturedAt))) semanticFailures.push("optional_antigravity_cli_real_smoke_identity_captured_at");
              if (typeof comparison.approvalId !== "string" || !comparison.approvalId.trim()) semanticFailures.push("optional_antigravity_cli_real_smoke_identity_approval_id");
              if (comparison.approvalSource !== "explicit-user-approval") semanticFailures.push("optional_antigravity_cli_real_smoke_identity_approval_source");
            }
          }
          if (report.separateAccountVerified === false) {
            if (report.accountIdentityEvidence || report.accountIdentityComparison) {
              semanticFailures.push("optional_antigravity_cli_real_smoke_identity_evidence_without_verification");
            }
          }
          if (!report.accountIsolationBoundary) semanticFailures.push("optional_antigravity_cli_real_smoke_isolation_boundary_missing");
          if (!report.accountIsolationCaveat) semanticFailures.push("optional_antigravity_cli_real_smoke_isolation_caveat_missing");
          if (report.separateAccountVerified === true && !["separate-windows-user", "official-independent-credential-store"].includes(String(report.accountIsolationBoundary || ""))) {
            semanticFailures.push("optional_antigravity_cli_real_smoke_credential_boundary_insufficient");
          }
          if (report.accountLaneRole !== "anticodex-model-text") semanticFailures.push("optional_antigravity_cli_real_smoke_account_lane_role");
          if (report.mcpAccountLaneManagedByAntiCodex !== false) semanticFailures.push("optional_antigravity_cli_real_smoke_mcp_lane_managed_by_anticodex");
          if (report.mcpAccountLaneOwner !== "external-antigravity-account-not-managed-here") semanticFailures.push("optional_antigravity_cli_real_smoke_mcp_lane_owner_mismatch");
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
      const smoke = capabilities.smoke || {};
      if (report.shortBudgetMode === true) semanticFailures.push("plugin_capabilities_short_budget_report");
      if (["degraded_short_budget", "degraded_verification_failed", "degraded_missing_local_snapshot", "degraded_no_tools_for_accessible_connectors"].includes(String(capabilities.capabilityState || ""))) semanticFailures.push("plugin_capabilities_degraded");
      if (connectorParity.checked !== true || appToolParity.checked !== true || appToolGetPostParity.checked !== true) semanticFailures.push("plugin_capabilities_unchecked_parity");
      if (smoke.checked !== true) semanticFailures.push("plugin_capabilities_smoke_unchecked");
      if (capabilities.nativeCodexWriteback !== false) semanticFailures.push("plugin_capabilities_native_codex_writeback");
      if (capabilities.accessibleConnectorCount !== 0) semanticFailures.push("plugin_capabilities_accessible_connector_count");
      if (capabilities.unauthorizedAppToolCount !== 0) semanticFailures.push("plugin_capabilities_unauthorized_app_tools");
      if (appToolGetPostParity.contentMatches !== true || !isEmptyArray(appToolGetPostParity.missingFromGet) || !isEmptyArray(appToolGetPostParity.extraFromGet)) semanticFailures.push("plugin_capabilities_app_tool_get_post_mismatch");
      if (!isEmptyArray(connectorParity.missingShared)) semanticFailures.push("plugin_capabilities_local_connector_parity_missing_shared");
      if (!isEmptyArray(connectorParity.extraLocal)) semanticFailures.push("plugin_capabilities_local_connector_parity_extra_local");
      if (!isEmptyArray(connectorParity.changedShared)) semanticFailures.push("plugin_capabilities_local_connector_parity_changed_shared");
      if (!isEmptyArray(appToolParity.missingShared)) semanticFailures.push("plugin_capabilities_local_app_tool_parity_missing_shared");
      if (!isEmptyArray(appToolParity.extraLocal)) semanticFailures.push("plugin_capabilities_local_app_tool_parity_extra_local");
      if (!isEmptyArray(appToolParity.changedShared)) semanticFailures.push("plugin_capabilities_local_app_tool_parity_changed_shared");
      if (!gate.sourceFingerprint) semanticFailures.push("plugin_capabilities_source_snapshot_missing");
      if (!gate.sourceFingerprint || !Number.isFinite(gate.sourceFileCount) || gate.sourceFileCount <= 0 || !gate.sourceMtimeMax || Number.isNaN(Date.parse(gate.sourceMtimeMax))) semanticFailures.push("plugin_capabilities_source_snapshot_incomplete");
      if (gate.sourceSnapshotReused === true) semanticFailures.push("plugin_capabilities_source_snapshot_reused");
    }
    if (definition.requireMcpSkillSemantics) {
      const mcp = report.mcp || {};
      const skills = report.skills || {};
      const appTools = report.appTools && typeof report.appTools === "object" ? report.appTools : {};
      const appToolRegistry = appTools.registry && typeof appTools.registry === "object" ? appTools.registry : {};
      const mcpSmoke = mcp.smoke || {};
      const mcpRealCall = mcpSmoke.realCall || {};
      const mcpRealList = Array.isArray(mcpSmoke.realList) ? mcpSmoke.realList : [];
      const passedRealListServers = new Set(mcpRealList
        .filter((entry) => entry && entry.passed === true)
        .map((entry) => String(entry.server || ""))
        .filter(Boolean));
      const missingWorkerRealList = REQUIRED_WORKER_MCP_SERVERS.filter((server) => !passedRealListServers.has(server));
      if (Number(mcp.count || 0) < 1) semanticFailures.push("mcp_skills_no_mcp_servers");
      if (Number(mcp.sharedCount || 0) < 1) semanticFailures.push("mcp_skills_no_shared_mcp_servers");
      if (!isEmptyArray(mcp.missingShared)) semanticFailures.push("mcp_skills_missing_shared_mcp");
      if (!isEmptyArray(mcp.extraLocal)) semanticFailures.push("mcp_skills_extra_local_mcp");
      if (!isEmptyArray(mcp.changedShared)) semanticFailures.push("mcp_skills_changed_shared_mcp");
      if (mcp.hasNodeRepl !== true) semanticFailures.push("mcp_skills_missing_node_repl");
      if (mcpSmoke.passed !== true) semanticFailures.push("mcp_skills_smoke_not_passed");
      if (mcpRealCall.passed !== true) semanticFailures.push("mcp_skills_real_call_not_passed");
      if (missingWorkerRealList.length > 0) semanticFailures.push("mcp_skills_missing_worker_real_list");
      if (Number(skills.count || 0) < 1) semanticFailures.push("mcp_skills_no_local_skills");
      if (Number(skills.sharedCount || 0) < 1) semanticFailures.push("mcp_skills_no_shared_skills");
      if (Number(skills.agentsCount || 0) < 1) semanticFailures.push("mcp_skills_no_agents_skills");
      if (Number(skills.expectedSharedCount || 0) < Number(skills.count || 0)) semanticFailures.push("mcp_skills_expected_shared_count");
      if (!isEmptyArray(skills.missingShared)) semanticFailures.push("mcp_skills_missing_shared_skills");
      if (!isEmptyArray(skills.extraLocal)) semanticFailures.push("mcp_skills_extra_local_skills");
      if (!isEmptyArray(skills.changedShared)) semanticFailures.push("mcp_skills_changed_shared_skills");
      if (!isEmptyArray(skills.conflictingDuplicateNames)) semanticFailures.push("mcp_skills_conflicting_duplicate_skills");
      if (!skills.smoke || skills.smoke.readable !== true) semanticFailures.push("mcp_skills_skill_smoke_not_readable");
      if (appToolRegistry.exists !== true) semanticFailures.push("mcp_skills_app_tool_registry_missing");
      if (appToolRegistry.contentMatches !== true) semanticFailures.push("mcp_skills_app_tool_registry_content_mismatch");
      if (!appToolRegistry.sharedFingerprint || !appToolRegistry.localFingerprint || appToolRegistry.sharedFingerprint !== appToolRegistry.localFingerprint) semanticFailures.push("mcp_skills_app_tool_registry_fingerprint_mismatch");
      if (Number(appToolRegistry.sharedFileCount || 0) !== Number(appToolRegistry.localFileCount || 0)) semanticFailures.push("mcp_skills_app_tool_registry_file_count_mismatch");
      if (!gate.sourceFingerprint) semanticFailures.push("mcp_skills_source_snapshot_missing");
    }
    if (definition.requireRefreshFeatureSemantics) {
      const connectorParity = report.connectorParity || {};
      const appToolParity = report.appToolParity || {};
      const skills = report.skills || {};
      const guidance = report.guidance && typeof report.guidance === "object" ? report.guidance : {};
      gate.refreshFeatureSnapshotEvidence = {
        connectorSharedExists: connectorParity.sharedExists === true,
        connectorLocalExists: connectorParity.localExists === true,
        connectorContentMatches: connectorParity.contentMatches === true,
        appToolSharedExists: appToolParity.sharedExists === true,
        appToolLocalExists: appToolParity.localExists === true,
        appToolContentMatches: appToolParity.contentMatches === true,
        sourceFingerprint: gate.sourceFingerprint || "",
        sourceFileCount: gate.sourceFileCount,
        sourceMtimeMax: gate.sourceMtimeMax || "",
      };
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
      if (report.noTraffic !== true) semanticFailures.push("source_preflight_no_traffic");
      if (report.usedRealTraffic !== false) semanticFailures.push("source_preflight_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("source_preflight_behavior_not_covered");
      if (report.coverageKind !== "source-no-traffic") semanticFailures.push("source_preflight_coverage_kind");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("source_preflight_failures");
      if (!checks.javascriptSyntax || checks.javascriptSyntax.ok !== true) semanticFailures.push("source_preflight_javascript_syntax");
      if (!checks.powershellSyntax || checks.powershellSyntax.ok !== true) semanticFailures.push("source_preflight_powershell_syntax");
      if (!checks.uiStateSelfTest || checks.uiStateSelfTest.ok !== true) semanticFailures.push("source_preflight_ui_state_self_test");
      if (!checks.upstreamProfileStorage || checks.upstreamProfileStorage.ok !== true) semanticFailures.push("source_preflight_upstream_profile_storage");
      if (!checks.antigravityCliIsolationProfile || checks.antigravityCliIsolationProfile.ok !== true) semanticFailures.push("source_preflight_antigravity_cli_isolation_profile");
      if (checks.antigravityCliIsolationProfile && checks.antigravityCliIsolationProfile.ok === true) {
        const isolation = checks.antigravityCliIsolationProfile;
        if (isolation.usedRealTraffic !== false) semanticFailures.push("source_preflight_cli_isolation_used_real_traffic");
        if (isolation.loginVerified !== false) semanticFailures.push("source_preflight_cli_isolation_login_verified");
        if (isolation.separateAccountVerified !== false) semanticFailures.push("source_preflight_cli_isolation_separate_account_verified");
        if (isolation.accountLaneRole !== "anticodex-model-text") semanticFailures.push("source_preflight_cli_isolation_account_lane_role");
        if (isolation.mcpAccountLaneManagedByAntiCodex !== false) semanticFailures.push("source_preflight_cli_isolation_mcp_lane_managed_by_anticodex");
        if (isolation.mcpAccountLaneOwner !== "external-antigravity-account-not-managed-here") semanticFailures.push("source_preflight_cli_isolation_mcp_lane_owner_mismatch");
        if (!isolation.accountIsolationBoundary) semanticFailures.push("source_preflight_cli_isolation_boundary_missing");
        if (!isolation.accountIsolationCaveat) semanticFailures.push("source_preflight_cli_isolation_caveat_missing");
      }
      if (report.antigravityCliDualAccountLanesOk !== true || !checks.antigravityCliDualAccountLanes || checks.antigravityCliDualAccountLanes.ok !== true) semanticFailures.push("source_preflight_antigravity_cli_dual_account_lanes");
      if (!checks.antigravityCliDualAccountLanes || !checks.antigravityCliDualAccountLanes.contract) {
        semanticFailures.push("source_preflight_dual_account_lanes_contract_missing");
      } else {
        const dual = checks.antigravityCliDualAccountLanes.contract;
        if (dual.usedRealTraffic !== false) semanticFailures.push("source_preflight_dual_lanes_used_real_traffic");
        if (dual.loginVerified !== false) semanticFailures.push("source_preflight_dual_lanes_login_verified");
        if (dual.separateAccountVerified !== false) semanticFailures.push("source_preflight_dual_lanes_separate_account_verified");
        if (dual.accountLaneRole !== "dual-antigravity-cli-account-lanes") semanticFailures.push("source_preflight_dual_lanes_account_lane_role");
        if (dual.coverageKind !== "dual-account-lanes-prepared-no-traffic") semanticFailures.push("source_preflight_dual_lanes_coverage_kind");
        if (dual.antiCodexLaneRole !== "anticodex-model-text") semanticFailures.push("source_preflight_dual_lanes_anticodex_role");
        if (dual.mcpLaneRole !== "external-mcp-antigravity-account") semanticFailures.push("source_preflight_dual_lanes_mcp_role");
        if (dual.mcpLaneManagedByAntiCodex !== false) semanticFailures.push("source_preflight_dual_lanes_mcp_managed_by_anticodex");
        if (dual.profileRootsDifferent !== true) semanticFailures.push("source_preflight_dual_lanes_profile_roots_not_different");
        if (dual.profileRootsNested !== false) semanticFailures.push("source_preflight_dual_lanes_profile_roots_nested");
        if (dual.appDataDifferent !== true) semanticFailures.push("source_preflight_dual_lanes_appdata_not_different");
        if (dual.localAppDataDifferent !== true) semanticFailures.push("source_preflight_dual_lanes_localappdata_not_different");
        if (dual.geminiDirDifferent !== true) semanticFailures.push("source_preflight_dual_lanes_gemini_dir_not_different");
        if (dual.neitherUsesDefaultAntigravityProfile !== true) semanticFailures.push("source_preflight_dual_lanes_default_profile_used");
        if (!dual.accountIsolationBoundary) semanticFailures.push("source_preflight_dual_lanes_isolation_boundary_missing");
        if (!dual.accountIsolationCaveat) semanticFailures.push("source_preflight_dual_lanes_isolation_caveat_missing");
      }
      if (report.antigravityCliProfilePrepareOk !== true || !checks.antigravityCliProfilePrepare || checks.antigravityCliProfilePrepare.ok !== true) semanticFailures.push("source_preflight_antigravity_cli_profile_prepare");
      if (!checks.antigravityCliProfilePrepareRejectsDefaultChild || checks.antigravityCliProfilePrepareRejectsDefaultChild.ok !== true || checks.antigravityCliProfilePrepareRejectsDefaultChild.usedRealTraffic !== false) semanticFailures.push("source_preflight_antigravity_cli_profile_prepare_rejects_default_child");
      if (report.antigravityCliWindowsUserLoginDryRunOk !== true || !checks.antigravityCliWindowsUserLoginDryRun || checks.antigravityCliWindowsUserLoginDryRun.ok !== true) semanticFailures.push("source_preflight_antigravity_cli_windows_user_login_dry_run");
      if (checks.antigravityCliWindowsUserLoginDryRun && checks.antigravityCliWindowsUserLoginDryRun.ok === true) {
        const windowsUserLogin = checks.antigravityCliWindowsUserLoginDryRun.contract || checks.antigravityCliWindowsUserLoginDryRun;
        if (windowsUserLogin.noTraffic !== true) semanticFailures.push("source_preflight_windows_user_login_no_traffic");
        if (windowsUserLogin.usedRealTraffic !== false) semanticFailures.push("source_preflight_windows_user_login_used_real_traffic");
        if (windowsUserLogin.started !== false) semanticFailures.push("source_preflight_windows_user_login_started");
        if (windowsUserLogin.capturesLoginOutput !== false) semanticFailures.push("source_preflight_windows_user_login_captures_output");
        if (windowsUserLogin.readinessChecked !== true) semanticFailures.push("source_preflight_windows_user_login_readiness_not_checked");
        if (!windowsUserLogin.normalizedTargetWindowsUser) semanticFailures.push("source_preflight_windows_user_login_target_user_missing");
        if (!windowsUserLogin.currentWindowsUser) semanticFailures.push("source_preflight_windows_user_login_current_user_missing");
        if (windowsUserLogin.targetUserIsCurrentUser === true) semanticFailures.push("source_preflight_windows_user_login_target_is_current_user");
        if (!windowsUserLogin.currentWindowsUserSid) semanticFailures.push("source_preflight_windows_user_login_current_sid_missing");
        if (windowsUserLogin.targetUserSidMatchesCurrentUser === true) semanticFailures.push("source_preflight_windows_user_login_target_sid_matches_current_user");
        if (windowsUserLogin.readyForInteractiveLogin === true && !windowsUserLogin.targetWindowsUserSid) semanticFailures.push("source_preflight_windows_user_login_target_sid_missing");
        if (windowsUserLogin.readyForInteractiveLogin === true && windowsUserLogin.targetUserIdentityBoundaryOk !== true) semanticFailures.push("source_preflight_windows_user_login_identity_boundary_unverified");
        if (windowsUserLogin.readyForInteractiveLogin !== true && !windowsUserLogin.readinessBlockingReason) semanticFailures.push("source_preflight_windows_user_login_readiness_reason_missing");
        if (windowsUserLogin.credentialBoundary !== "separate-windows-user") semanticFailures.push("source_preflight_windows_user_login_credential_boundary");
        if (windowsUserLogin.expectedCredentialStoreIsolation !== true) semanticFailures.push("source_preflight_windows_user_login_expected_credential_isolation");
        if (!windowsUserLogin.runasWorkingDirectory) semanticFailures.push("source_preflight_windows_user_login_runas_workdir_missing");
        if (windowsUserLogin.bootstrapKeepsShellOpen !== false) semanticFailures.push("source_preflight_windows_user_login_bootstrap_keeps_shell");
        if (!windowsUserLogin.accountIsolationCaveat) semanticFailures.push("source_preflight_windows_user_login_caveat_missing");
      }
      if (!checks.antigravityCliProfilePrepare || !checks.antigravityCliProfilePrepare.contract) {
        semanticFailures.push("source_preflight_profile_prepare_contract_missing");
      } else {
        const contract = checks.antigravityCliProfilePrepare.contract;
        if (contract.usedRealTraffic !== false) semanticFailures.push("source_preflight_profile_prepare_used_real_traffic");
        if (contract.loginVerified !== false) semanticFailures.push("source_preflight_profile_prepare_login_verified");
        if (contract.separateAccountVerified !== false) semanticFailures.push("source_preflight_profile_prepare_separate_account_verified");
        if (contract.accountLaneRole !== "anticodex-model-text") semanticFailures.push("source_preflight_profile_prepare_account_lane_role");
        if (contract.mcpAccountLaneManagedByAntiCodex !== false) semanticFailures.push("source_preflight_profile_prepare_mcp_lane_managed_by_anticodex");
        if (contract.mcpAccountLaneOwner !== "external-antigravity-account-not-managed-here") semanticFailures.push("source_preflight_profile_prepare_mcp_lane_owner_mismatch");
        if (contract.coverageKind !== "profile-prepared-no-traffic") semanticFailures.push("source_preflight_profile_prepare_coverage_kind");
        if (!contract.accountIsolationBoundary) semanticFailures.push("source_preflight_profile_prepare_isolation_boundary_missing");
        if (!contract.accountIsolationCaveat) semanticFailures.push("source_preflight_profile_prepare_isolation_caveat_missing");
      }
      if (!checks.localConnectorVerifier || checks.localConnectorVerifier.ok !== true) semanticFailures.push("source_preflight_local_connector_verifier");
      if (!checks.publicDocumentation || checks.publicDocumentation.ok !== true) semanticFailures.push("source_preflight_public_documentation");
      if (!hasSuccessfulDocAssertion(checks.publicDocumentation, "README.md", "client-copy-sync-contract")
        || !hasSuccessfulDocAssertion(checks.publicDocumentation, "README_EN.md", "client-copy-sync-contract")) {
        semanticFailures.push("source_preflight_public_documentation_client_sync_contract");
      }
      if (!checks.translatorRegression || checks.translatorRegression.ok !== true) semanticFailures.push("source_preflight_translator_regression");
      if (!checks.diffWhitespace || checks.diffWhitespace.ok !== true) semanticFailures.push("source_preflight_diff_whitespace");
    }
    if (definition.requireAntigravityCliWindowsUserReadinessSemantics) {
      if (report.reportName !== "antigravity-cli-windows-user-readiness") semanticFailures.push("windows_user_readiness_report_name");
      if (report.noTraffic !== true) semanticFailures.push("windows_user_readiness_no_traffic");
      if (report.usedRealTraffic !== false) semanticFailures.push("windows_user_readiness_used_real_traffic");
      if (report.requestedRealTraffic !== false) semanticFailures.push("windows_user_readiness_requested_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("windows_user_readiness_behavior_not_covered");
      if (report.coverageKind !== "windows-user-login-readiness-no-traffic") semanticFailures.push("windows_user_readiness_coverage_kind");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("windows_user_readiness_failures");
      if (report.started !== false) semanticFailures.push("windows_user_readiness_started_login");
      if (report.capturesLoginOutput !== false) semanticFailures.push("windows_user_readiness_captures_login_output");
      if (report.credentialBoundary !== "separate-windows-user") semanticFailures.push("windows_user_readiness_credential_boundary");
      if (report.expectedCredentialStoreIsolation !== true) semanticFailures.push("windows_user_readiness_expected_credential_isolation");
      if (report.readinessChecked !== true) semanticFailures.push("windows_user_readiness_not_checked");
      if (!report.normalizedTargetWindowsUser) semanticFailures.push("windows_user_readiness_target_user_missing");
      if (!report.currentWindowsUser) semanticFailures.push("windows_user_readiness_current_user_missing");
      if (report.targetUserIsCurrentUser === true) semanticFailures.push("windows_user_readiness_target_is_current_user");
      if (report.targetUserEnabled === false && report.readyForInteractiveLogin === true) semanticFailures.push("windows_user_readiness_disabled_user_ready");
      if (report.targetUserSidMatchesCurrentUser === true) semanticFailures.push("windows_user_readiness_target_sid_matches_current_user");
      if (report.readyForInteractiveLogin === true && !report.currentWindowsUserSid) semanticFailures.push("windows_user_readiness_current_sid_missing");
      if (report.readyForInteractiveLogin === true && !report.targetWindowsUserSid) semanticFailures.push("windows_user_readiness_target_sid_missing");
      if (report.readyForInteractiveLogin === true && report.targetUserIdentityBoundaryOk !== true) semanticFailures.push("windows_user_readiness_identity_boundary_unverified");
      if (report.readyForInteractiveLogin !== true && !report.readinessBlockingReason) semanticFailures.push("windows_user_readiness_blocking_reason_missing");
      if (report.readyForInteractiveLogin === true && report.recommendedOperatorAction !== "run_interactive_login_with_explicit_user_approval") semanticFailures.push("windows_user_readiness_ready_action_mismatch");
      if (report.readyForInteractiveLogin !== true && report.requiresUserAction !== true) semanticFailures.push("windows_user_readiness_requires_user_action_missing");
      if (report.requiresRealTrafficForNextProof !== true) semanticFailures.push("windows_user_readiness_next_proof_real_traffic_missing");
      if (report.separateAccountVerified !== false) semanticFailures.push("windows_user_readiness_separate_account_verified");
      if (report.loginVerified !== false) semanticFailures.push("windows_user_readiness_login_verified");
      if (!report.accountIsolationCaveat) semanticFailures.push("windows_user_readiness_caveat_missing");
    }
    if (definition.requireWindowsUserAccountPrepareSemantics) {
      const safeToAskLogin = report.safeToAskUserForSecondAccountLogin === true;
      if (report.reportName !== "windows-user-account-prepare") semanticFailures.push("windows_user_prepare_report_name");
      if (report.noTraffic !== true) semanticFailures.push("windows_user_prepare_no_traffic");
      if (report.usedRealTraffic !== false) semanticFailures.push("windows_user_prepare_used_real_traffic");
      if (report.requestedRealTraffic !== false) semanticFailures.push("windows_user_prepare_requested_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("windows_user_prepare_behavior_not_covered");
      if (report.coverageKind !== "windows-user-account-prepare-no-traffic") semanticFailures.push("windows_user_prepare_coverage_kind");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("windows_user_prepare_failures");
      if (report.changedSystem !== false) semanticFailures.push("windows_user_prepare_changed_system");
      if (report.createdUser !== false) semanticFailures.push("windows_user_prepare_created_user");
      if (report.startedLogin !== false) semanticFailures.push("windows_user_prepare_started_login");
      if (report.capturesPassword !== false) semanticFailures.push("windows_user_prepare_captures_password");
      if (report.storesPassword !== false) semanticFailures.push("windows_user_prepare_stores_password");
      if (report.targetUserIsCurrentUser === true) semanticFailures.push("windows_user_prepare_target_is_current_user");
      if (report.targetUserEnabled === false && report.readyForInteractiveLogin === true) semanticFailures.push("windows_user_prepare_disabled_user_ready");
      if (report.targetUserSidMatchesCurrentUser === true) semanticFailures.push("windows_user_prepare_target_sid_matches_current_user");
      if (report.readyForInteractiveLogin === true && !report.currentWindowsUserSid) semanticFailures.push("windows_user_prepare_current_sid_missing");
      if (report.readyForInteractiveLogin === true && !report.targetWindowsUserSid) semanticFailures.push("windows_user_prepare_target_sid_missing");
      if (report.readyForInteractiveLogin === true && report.targetUserIdentityBoundaryOk !== true) semanticFailures.push("windows_user_prepare_identity_boundary_unverified");
      if (report.readyForInteractiveLogin !== true && !report.readinessBlockingReason) semanticFailures.push("windows_user_prepare_blocking_reason_missing");
      if (report.canProceedToInteractiveLogin !== safeToAskLogin) semanticFailures.push("windows_user_prepare_can_proceed_mismatch");
      if (report.blockedBeforeInteractiveLogin !== !safeToAskLogin) semanticFailures.push("windows_user_prepare_blocked_before_login_mismatch");
      if (report.setupActionRequired !== !safeToAskLogin) semanticFailures.push("windows_user_prepare_setup_action_mismatch");
      if (!report.operatorBlockingStage) semanticFailures.push("windows_user_prepare_operator_stage_missing");
      if (!report.operatorNextStep) semanticFailures.push("windows_user_prepare_operator_next_step_missing");
      if (report.readyForInteractiveLogin === true && report.operatorBlockingStage !== "ready") semanticFailures.push("windows_user_prepare_ready_stage_mismatch");
      if (report.readyForInteractiveLogin === true && report.operatorNextStep !== "run_windows_user_interactive_login_with_user_present") semanticFailures.push("windows_user_prepare_ready_next_step_mismatch");
      if (report.readyForInteractiveLogin === true && report.recommendedOperatorAction !== "run_interactive_login_with_explicit_user_approval") semanticFailures.push("windows_user_prepare_ready_action_mismatch");
      if (report.requiresUserPresence !== true) semanticFailures.push("windows_user_prepare_user_presence_missing");
      if (report.nextProofRequiresRealTraffic !== true) semanticFailures.push("windows_user_prepare_next_proof_real_traffic_missing");
      if (report.separateAccountVerified !== false) semanticFailures.push("windows_user_prepare_separate_account_verified");
      if (report.loginVerified !== false) semanticFailures.push("windows_user_prepare_login_verified");
    }
    if (definition.requireWindowsUserSetupGuidanceSemantics) {
      const safeToAskLogin = report.safeToAskUserForSecondAccountLogin === true;
      if (report.reportName !== "windows-user-setup-guidance") semanticFailures.push("windows_user_setup_guidance_report_name");
      if (report.noTraffic !== true) semanticFailures.push("windows_user_setup_guidance_no_traffic");
      if (report.usedRealTraffic !== false) semanticFailures.push("windows_user_setup_guidance_used_real_traffic");
      if (report.requestedRealTraffic !== false) semanticFailures.push("windows_user_setup_guidance_requested_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("windows_user_setup_guidance_behavior_not_covered");
      if (report.coverageKind !== "windows-user-setup-guidance-no-traffic") semanticFailures.push("windows_user_setup_guidance_coverage_kind");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("windows_user_setup_guidance_failures");
      if (report.guidanceSource !== "windows-user-account-prepare") semanticFailures.push("windows_user_setup_guidance_source");
      if (report.changedSystem !== false) semanticFailures.push("windows_user_setup_guidance_changed_system");
      if (report.createdUser !== false) semanticFailures.push("windows_user_setup_guidance_created_user");
      if (report.startedLogin !== false) semanticFailures.push("windows_user_setup_guidance_started_login");
      if (report.capturesPassword !== false) semanticFailures.push("windows_user_setup_guidance_captures_password");
      if (report.storesPassword !== false) semanticFailures.push("windows_user_setup_guidance_stores_password");
      if (report.opensSettings !== false) semanticFailures.push("windows_user_setup_guidance_opens_settings");
      if (report.runsSystemUserCommand !== false) semanticFailures.push("windows_user_setup_guidance_runs_system_user_command");
      if (report.targetUserSidMatchesCurrentUser === true) semanticFailures.push("windows_user_setup_guidance_target_sid_matches_current_user");
      if (report.readyForInteractiveLogin === true && !report.currentWindowsUserSid) semanticFailures.push("windows_user_setup_guidance_current_sid_missing");
      if (report.readyForInteractiveLogin === true && !report.targetWindowsUserSid) semanticFailures.push("windows_user_setup_guidance_target_sid_missing");
      if (report.readyForInteractiveLogin === true && report.targetUserIdentityBoundaryOk !== true) semanticFailures.push("windows_user_setup_guidance_identity_boundary_unverified");
      if (report.blockedBeforeInteractiveLogin !== !safeToAskLogin) semanticFailures.push("windows_user_setup_guidance_blocked_before_login_mismatch");
      if (!report.operatorBlockingStage) semanticFailures.push("windows_user_setup_guidance_operator_stage_missing");
      if (!report.operatorNextStep) semanticFailures.push("windows_user_setup_guidance_operator_next_step_missing");
      if (!report.manualSetupCommandHint) semanticFailures.push("windows_user_setup_guidance_manual_hint_missing");
      const postManualSetupValidationCommands = Array.isArray(report.postManualSetupValidationCommands) ? report.postManualSetupValidationCommands.map(String) : [];
      const postManualSetupRequiredReadyFields = Array.isArray(report.postManualSetupRequiredReadyFields) ? report.postManualSetupRequiredReadyFields.map(String) : [];
      if (postManualSetupValidationCommands.length < 3
        || !postManualSetupValidationCommands.some((command) => command.includes("test-anticodex-windows-user-account-prepare.ps1"))
        || !postManualSetupValidationCommands.some((command) => command.includes("test-anticodex-antigravity-account-isolation-status.ps1"))
        || !postManualSetupValidationCommands.some((command) => command.includes("start-anticodex-second-antigravity-account-login.ps1"))) semanticFailures.push("windows_user_setup_guidance_post_manual_commands");
      for (const requiredField of ["targetUserExists:true", "targetWindowsUserSid:present", "targetUserIdentityBoundaryOk:true", "safeToAskUserForSecondAccountLogin:true", "canProceedToInteractiveLogin:true", "startedLogin:false", "usedRealTraffic:false"]) {
        if (!postManualSetupRequiredReadyFields.includes(requiredField)) semanticFailures.push(`windows_user_setup_guidance_post_manual_ready_field:${requiredField}`);
      }
      const expectedSetupSequence = [
        "create_target_windows_user",
        "windows_user_account_prepare",
        "account_isolation_status",
        "second_account_login_entrypoint_with_explicit_approval",
      ];
      const readinessCheckSequence = Array.isArray(report.readinessCheckSequence) ? report.readinessCheckSequence : [];
      if (readinessCheckSequence.join("|") !== expectedSetupSequence.join("|")) semanticFailures.push("windows_user_setup_guidance_sequence_mismatch");
      const operatorChecklist = Array.isArray(report.operatorChecklist) ? report.operatorChecklist : [];
      const operatorChecklistStages = operatorChecklist.map((entry) => entry?.stage || "");
      if (operatorChecklist.length !== expectedSetupSequence.length) semanticFailures.push("windows_user_setup_guidance_checklist_missing");
      if (operatorChecklistStages.join("|") !== expectedSetupSequence.join("|")) semanticFailures.push("windows_user_setup_guidance_checklist_order_mismatch");
      if (operatorChecklist.some((entry) => entry?.usesRealTraffic === true)) semanticFailures.push("windows_user_setup_guidance_checklist_real_traffic");
      if (operatorChecklist.slice(0, 3).some((entry) => entry?.startsLogin === true)) semanticFailures.push("windows_user_setup_guidance_checklist_starts_login_too_early");
      if (operatorChecklist.length === expectedSetupSequence.length && operatorChecklist[3]?.startsLogin !== true) semanticFailures.push("windows_user_setup_guidance_checklist_login_step_missing");
      const operatorSetupPlan = report.operatorSetupPlan && typeof report.operatorSetupPlan === "object" ? report.operatorSetupPlan : null;
      if (!operatorSetupPlan) {
        semanticFailures.push("windows_user_setup_guidance_setup_plan_missing");
      } else {
        if (operatorSetupPlan.targetLocalWindowsUser !== "AntiCodexModel") semanticFailures.push("windows_user_setup_guidance_setup_plan_target");
        if (operatorSetupPlan.setupMode !== "manual-only") semanticFailures.push("windows_user_setup_guidance_setup_plan_mode");
        if (operatorSetupPlan.preferredSurface !== "windows-settings-other-users") semanticFailures.push("windows_user_setup_guidance_setup_plan_surface");
        if (operatorSetupPlan.antiCodexCreatesUser !== false) semanticFailures.push("windows_user_setup_guidance_setup_plan_creates_user");
        if (operatorSetupPlan.antiCodexOpensSettings !== false) semanticFailures.push("windows_user_setup_guidance_setup_plan_opens_settings");
        if (operatorSetupPlan.antiCodexStartsLogin !== false) semanticFailures.push("windows_user_setup_guidance_setup_plan_starts_login");
        if (operatorSetupPlan.antiCodexCapturesPassword !== false) semanticFailures.push("windows_user_setup_guidance_setup_plan_captures_password");
        if (operatorSetupPlan.antiCodexStoresPassword !== false) semanticFailures.push("windows_user_setup_guidance_setup_plan_stores_password");
        if (operatorSetupPlan.antiCodexUsesRealTraffic !== false) semanticFailures.push("windows_user_setup_guidance_setup_plan_uses_real_traffic");
        if (operatorSetupPlan.rawUserManagementCommandProvided !== false) semanticFailures.push("windows_user_setup_guidance_setup_plan_raw_command");
        const afterManualSetupChecks = Array.isArray(operatorSetupPlan.afterManualSetupChecks) ? operatorSetupPlan.afterManualSetupChecks : [];
        if (afterManualSetupChecks.join("|") !== "windows_user_account_prepare|account_isolation_status") semanticFailures.push("windows_user_setup_guidance_setup_plan_after_checks");
        const planPostManualCommands = Array.isArray(operatorSetupPlan.postManualSetupValidationCommands) ? operatorSetupPlan.postManualSetupValidationCommands.map(String) : [];
        const planPostManualReadyFields = Array.isArray(operatorSetupPlan.postManualSetupRequiredReadyFields) ? operatorSetupPlan.postManualSetupRequiredReadyFields.map(String) : [];
        if (planPostManualCommands.join("|") !== postManualSetupValidationCommands.join("|")) semanticFailures.push("windows_user_setup_guidance_setup_plan_post_manual_commands");
        if (planPostManualReadyFields.join("|") !== postManualSetupRequiredReadyFields.join("|")) semanticFailures.push("windows_user_setup_guidance_setup_plan_post_manual_ready_fields");
        if (operatorSetupPlan.finalLoginEntrypoint !== "start-anticodex-second-antigravity-account-login.ps1") semanticFailures.push("windows_user_setup_guidance_setup_plan_entrypoint");
        if (operatorSetupPlan.finalLoginApproval !== "start-separate-windows-user-login") semanticFailures.push("windows_user_setup_guidance_setup_plan_approval");
      }
      if (report.requiresUserPresence !== true) semanticFailures.push("windows_user_setup_guidance_user_presence_missing");
      if (report.nextProofRequiresRealTraffic !== true) semanticFailures.push("windows_user_setup_guidance_next_proof_real_traffic_missing");
      if (report.separateAccountVerified !== false) semanticFailures.push("windows_user_setup_guidance_separate_account_verified");
      if (report.loginVerified !== false) semanticFailures.push("windows_user_setup_guidance_login_verified");
      if (report.releaseAcceptableAccountProof !== false) semanticFailures.push("windows_user_setup_guidance_release_proof_claimed");
      if (!report.accountIsolationCaveat) semanticFailures.push("windows_user_setup_guidance_caveat_missing");
    }
    if (definition.requireAntigravityAccountIsolationStatusSemantics) {
      const safeToAskLogin = report.safeToAskUserForSecondAccountLogin === true;
      if (report.reportName !== "antigravity-account-isolation-status") semanticFailures.push("account_isolation_status_report_name");
      if (report.noTraffic !== true) semanticFailures.push("account_isolation_status_no_traffic");
      if (report.usedRealTraffic !== false) semanticFailures.push("account_isolation_status_used_real_traffic");
      if (report.requestedRealTraffic !== false) semanticFailures.push("account_isolation_status_requested_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("account_isolation_status_behavior_not_covered");
      if (report.coverageKind !== "account-isolation-status-no-traffic") semanticFailures.push("account_isolation_status_coverage_kind");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("account_isolation_status_failures");
      if (report.accountLaneRole !== "dual-antigravity-account-isolation-status") semanticFailures.push("account_isolation_status_account_lane_role");
      if (report.antiCodexLaneRole !== "anticodex-model-text") semanticFailures.push("account_isolation_status_anticodex_lane_role");
      if (report.mcpLaneRole !== "external-mcp-antigravity-account") semanticFailures.push("account_isolation_status_mcp_lane_role");
      if (report.mcpAccountLaneManagedByAntiCodex !== false) semanticFailures.push("account_isolation_status_mcp_lane_managed_by_anticodex");
      if (report.mcpAccountLaneOwner !== "external-antigravity-account-not-managed-here") semanticFailures.push("account_isolation_status_mcp_lane_owner");
      if (report.antiCodexModelTextLanePrepared !== true) semanticFailures.push("account_isolation_status_anticodex_lane_not_prepared");
      if (report.mcpExternalLanePrepared !== true) semanticFailures.push("account_isolation_status_mcp_lane_not_prepared");
      if (report.fileIsolationPrepared !== true) semanticFailures.push("account_isolation_status_file_isolation_not_prepared");
      if (report.credentialBoundary !== "separate-windows-user") semanticFailures.push("account_isolation_status_credential_boundary");
      if (report.expectedCredentialStoreIsolation !== true) semanticFailures.push("account_isolation_status_expected_credential_isolation");
      if (report.targetUserIsCurrentUser === true) semanticFailures.push("account_isolation_status_target_is_current_user");
      if (report.targetUserEnabled === false && report.readyForInteractiveLogin === true) semanticFailures.push("account_isolation_status_disabled_user_ready");
      if (report.targetUserSidMatchesCurrentUser === true) semanticFailures.push("account_isolation_status_target_sid_matches_current_user");
      if (report.readyForInteractiveLogin === true && !report.currentWindowsUserSid) semanticFailures.push("account_isolation_status_current_sid_missing");
      if (report.readyForInteractiveLogin === true && !report.targetWindowsUserSid) semanticFailures.push("account_isolation_status_target_sid_missing");
      if (report.readyForInteractiveLogin === true && report.targetUserIdentityBoundaryOk !== true) semanticFailures.push("account_isolation_status_identity_boundary_unverified");
      if (report.readyForInteractiveLogin !== true && !report.readinessBlockingReason) semanticFailures.push("account_isolation_status_blocking_reason_missing");
      if (report.canProceedToInteractiveLogin !== safeToAskLogin) semanticFailures.push("account_isolation_status_can_proceed_mismatch");
      if (report.blockedBeforeInteractiveLogin !== !safeToAskLogin) semanticFailures.push("account_isolation_status_blocked_before_login_mismatch");
      if (!report.operatorBlockingStage) semanticFailures.push("account_isolation_status_operator_stage_missing");
      if (!report.operatorNextStep) semanticFailures.push("account_isolation_status_operator_next_step_missing");
      if (report.nextProofRequiresRealTraffic !== true) semanticFailures.push("account_isolation_status_next_proof_real_traffic_missing");
      const finalProofPlan = report.finalProofPlan && typeof report.finalProofPlan === "object" ? report.finalProofPlan : null;
      if (!finalProofPlan) semanticFailures.push("account_isolation_status_final_proof_plan_missing");
      if (!finalProofPlan || finalProofPlan.requiresSeparateWindowsUserCredentialBoundary !== true) semanticFailures.push("account_isolation_status_final_proof_requires_credential_boundary");
      if (!finalProofPlan || finalProofPlan.requiresInteractiveLogin !== true) semanticFailures.push("account_isolation_status_final_proof_requires_interactive_login");
      if (!finalProofPlan || finalProofPlan.requiresApprovedRealTraffic !== true) semanticFailures.push("account_isolation_status_final_proof_requires_real_traffic");
      if (!finalProofPlan || finalProofPlan.requiresDistinctAccountIdentityComparison !== true) semanticFailures.push("account_isolation_status_final_proof_requires_distinct_identity");
      if (!finalProofPlan || finalProofPlan.accountIdsMustDiffer !== true) semanticFailures.push("account_isolation_status_final_proof_account_ids_must_differ");
      if (finalProofPlan && finalProofPlan.acceptsProfileAndAppDataOnlyProof === true) semanticFailures.push("account_isolation_status_final_proof_accepts_profile_only");
      if (finalProofPlan && finalProofPlan.releaseAcceptableAccountProof !== false) semanticFailures.push("account_isolation_status_final_proof_release_claimed");
      const postLoginProofPlan = report.postLoginProofPlan && typeof report.postLoginProofPlan === "object" ? report.postLoginProofPlan : null;
      const requiredIdentityInputs = Array.isArray(postLoginProofPlan?.requiredAccountIdentityInputs) ? postLoginProofPlan.requiredAccountIdentityInputs.map((item) => String(item || "")) : [];
      if (!postLoginProofPlan) semanticFailures.push("account_isolation_status_post_login_proof_plan_missing");
      if (!postLoginProofPlan || postLoginProofPlan.proofScript !== "test-anticodex-antigravity-cli-real-smoke.ps1") semanticFailures.push("account_isolation_status_post_login_proof_script");
      if (!postLoginProofPlan || !String(postLoginProofPlan.commandTemplate || "").includes("test-anticodex-antigravity-cli-real-smoke.ps1")) semanticFailures.push("account_isolation_status_post_login_proof_command_missing");
      if (!postLoginProofPlan || !String(postLoginProofPlan.commandTemplate || "").includes("-WindowsUser <target-windows-user>")) semanticFailures.push("account_isolation_status_post_login_proof_command_windows_user");
      if (!postLoginProofPlan || !String(postLoginProofPlan.commandTemplate || "").includes("-AllowSeparateAccountProof")) semanticFailures.push("account_isolation_status_post_login_proof_approval_switch_missing");
      if (!postLoginProofPlan || !String(postLoginProofPlan.commandTemplate || "").includes("-SeparateAccountProofApprovalId <explicit-user-approval-id>")) semanticFailures.push("account_isolation_status_post_login_proof_approval_id_missing");
      if (!postLoginProofPlan || postLoginProofPlan.accountIsolationBoundary !== "separate-windows-user") semanticFailures.push("account_isolation_status_post_login_proof_wrong_boundary");
      if (!postLoginProofPlan || !String(postLoginProofPlan.targetWindowsUser || "")) semanticFailures.push("account_isolation_status_post_login_proof_target_windows_user");
      if (!postLoginProofPlan || postLoginProofPlan.requiresInteractiveLoginComplete !== true) semanticFailures.push("account_isolation_status_post_login_proof_requires_login");
      if (!postLoginProofPlan || postLoginProofPlan.requiresProofRunAsTargetWindowsUser !== true) semanticFailures.push("account_isolation_status_post_login_proof_requires_target_user");
      if (!postLoginProofPlan || postLoginProofPlan.requiresApprovedRealTraffic !== true) semanticFailures.push("account_isolation_status_post_login_proof_requires_real_traffic");
      if (!postLoginProofPlan || postLoginProofPlan.requiresSeparateAccountProofApproval !== true) semanticFailures.push("account_isolation_status_post_login_proof_requires_approval");
      if (!postLoginProofPlan || postLoginProofPlan.requiresDistinctAccountIdentityComparison !== true) semanticFailures.push("account_isolation_status_post_login_proof_requires_identity");
      if (!requiredIdentityInputs.includes("AntiCodexAccountId") || !requiredIdentityInputs.includes("McpAccountId")) semanticFailures.push("account_isolation_status_post_login_proof_identity_inputs");
      if (!postLoginProofPlan || postLoginProofPlan.accountIdsMustDiffer !== true) semanticFailures.push("account_isolation_status_post_login_proof_account_ids_must_differ");
      if (!postLoginProofPlan || postLoginProofPlan.mcpAccountLaneManagedByAntiCodex !== false) semanticFailures.push("account_isolation_status_post_login_proof_mcp_managed_here");
      if (!postLoginProofPlan || postLoginProofPlan.mcpAccountLaneOwner !== "external-antigravity-account-not-managed-here") semanticFailures.push("account_isolation_status_post_login_proof_mcp_owner");
      if (report.separateAccountVerified !== false) semanticFailures.push("account_isolation_status_separate_account_verified");
      if (report.loginVerified !== false) semanticFailures.push("account_isolation_status_login_verified");
      if (report.releaseAcceptableAccountProof !== false) semanticFailures.push("account_isolation_status_release_proof_claimed");
      if (!report.accountIsolationCaveat) semanticFailures.push("account_isolation_status_caveat_missing");
    }
    if (definition.requireSecondAccountLoginEntrypointSemantics) {
      if (report.reportName !== "second-antigravity-account-login-entrypoint") semanticFailures.push("second_account_entrypoint_report_name");
      if (report.noTraffic !== true) semanticFailures.push("second_account_entrypoint_no_traffic");
      if (report.usedRealTraffic !== false) semanticFailures.push("second_account_entrypoint_used_real_traffic");
      if (report.requestedRealTraffic !== false) semanticFailures.push("second_account_entrypoint_requested_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("second_account_entrypoint_behavior_not_covered");
      if (report.coverageKind !== "second-account-login-entrypoint-no-traffic") semanticFailures.push("second_account_entrypoint_coverage_kind");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("second_account_entrypoint_failures");
      if (report.statusOnlyOk !== true) semanticFailures.push("second_account_entrypoint_status_only_not_ok");
      if (report.missingApprovalBlocked !== true) semanticFailures.push("second_account_entrypoint_missing_approval_not_blocked");
      if (report.approvedStartBlockedByStatusGate !== true) semanticFailures.push("second_account_entrypoint_status_gate_not_enforced");
      if (report.sameWindowsUserTargetBlocked !== true) semanticFailures.push("second_account_entrypoint_same_windows_user_not_blocked");
      if (report.sameWindowsUserTargetBlockingReason !== "target_windows_user_is_current_user") semanticFailures.push("second_account_entrypoint_same_windows_user_reason");
      if (report.sameWindowsUserTargetStartedLogin !== false) semanticFailures.push("second_account_entrypoint_same_windows_user_started_login");
      if (report.sameWindowsUserTargetSafetyFieldsOk !== true) semanticFailures.push("second_account_entrypoint_same_windows_user_safety_fields");
      if (report.requestedStartLogin !== false) semanticFailures.push("second_account_entrypoint_requested_start_login");
      if (report.startedLogin !== false) semanticFailures.push("second_account_entrypoint_started_login");
      if (report.changedSystem === true) semanticFailures.push("second_account_entrypoint_changed_system");
      if (report.createdUser === true) semanticFailures.push("second_account_entrypoint_created_user");
      if (report.capturesLoginOutput !== false) semanticFailures.push("second_account_entrypoint_captures_login_output");
      if (report.capturesPassword === true) semanticFailures.push("second_account_entrypoint_captures_password");
      if (report.storesPassword === true) semanticFailures.push("second_account_entrypoint_stores_password");
      if (report.requiredStartLoginApproval !== "start-separate-windows-user-login") semanticFailures.push("second_account_entrypoint_approval_token");
      if (!String(report.approvedLoginCommandTemplate || "").includes("start-anticodex-second-antigravity-account-login.ps1")
        || !String(report.approvedLoginCommandTemplate || "").includes("-StartLoginApproval start-separate-windows-user-login")) semanticFailures.push("second_account_entrypoint_login_command_template_missing");
      if (!String(report.nextNoTrafficStatusCommand || "").includes("test-anticodex-antigravity-account-isolation-status.ps1")) semanticFailures.push("second_account_entrypoint_status_command_missing");
      if (!String(report.postLoginProofCommandTemplate || "").includes("test-anticodex-antigravity-cli-real-smoke.ps1")
        || !String(report.postLoginProofCommandTemplate || "").includes("-AllowSeparateAccountProof")
        || !String(report.postLoginProofCommandTemplate || "").includes("-WindowsUser")
        || !String(report.postLoginProofCommandTemplate || "").includes("-AccountIsolationBoundary separate-windows-user")) semanticFailures.push("second_account_entrypoint_post_login_proof_command_missing");
      if (report.postLoginProofCommandTemplateHasWindowsUser !== true) semanticFailures.push("second_account_entrypoint_post_login_proof_command_windows_user");
      if (typeof report.canRunPostLoginProof !== "boolean") semanticFailures.push("second_account_entrypoint_post_login_flag_missing");
      const postLoginProofPlan = report.postLoginProofPlan || {};
      if (postLoginProofPlan.proofScript !== "test-anticodex-antigravity-cli-real-smoke.ps1"
        || postLoginProofPlan.accountIsolationBoundary !== "separate-windows-user"
        || !String(postLoginProofPlan.targetWindowsUser || "")
        || postLoginProofPlan.requiresProofRunAsTargetWindowsUser !== true
        || postLoginProofPlan.requiresApprovedRealTraffic !== true
        || postLoginProofPlan.requiresDistinctAccountIdentityComparison !== true
        || postLoginProofPlan.accountIdsMustDiffer !== true
        || postLoginProofPlan.mcpAccountLaneManagedByAntiCodex !== false) semanticFailures.push("second_account_entrypoint_post_login_proof_plan_invalid");
      if (report.safeToStartLogin !== true && !report.readinessBlockingReason) semanticFailures.push("second_account_entrypoint_blocking_reason_missing");
      if (!report.operatorBlockingStage) semanticFailures.push("second_account_entrypoint_operator_stage_missing");
      if (!report.operatorNextStep) semanticFailures.push("second_account_entrypoint_operator_next_step_missing");
      if (report.separateAccountVerified !== false) semanticFailures.push("second_account_entrypoint_separate_account_verified");
      if (report.loginVerified !== false) semanticFailures.push("second_account_entrypoint_login_verified");
      if (report.releaseAcceptableAccountProof !== false) semanticFailures.push("second_account_entrypoint_release_proof_claimed");
      if (!report.accountIsolationCaveat) semanticFailures.push("second_account_entrypoint_caveat_missing");
    }
    if (definition.requireSecondAccountReadinessSummarySemantics) {
      const steps = Array.isArray(report.steps) ? report.steps : [];
      const stepIds = steps.map((item) => String(item?.id || ""));
      if (report.reportName !== "second-account-readiness-summary") semanticFailures.push("second_account_readiness_summary_report_name");
      if (report.noTraffic !== true) semanticFailures.push("second_account_readiness_summary_no_traffic");
      if (report.requestedRealTraffic !== false) semanticFailures.push("second_account_readiness_summary_requested_real_traffic");
      if (report.usedRealTraffic !== false) semanticFailures.push("second_account_readiness_summary_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("second_account_readiness_summary_behavior_not_covered");
      if (report.coverageKind !== "second-account-readiness-summary-no-traffic") semanticFailures.push("second_account_readiness_summary_coverage_kind");
      if (!Array.isArray(report.failures) || report.failures.length !== 0) semanticFailures.push("second_account_readiness_summary_failures");
      if (report.changedSystem !== false) semanticFailures.push("second_account_readiness_summary_changed_system");
      if (report.createdUser !== false) semanticFailures.push("second_account_readiness_summary_created_user");
      if (report.startedLogin !== false) semanticFailures.push("second_account_readiness_summary_started_login");
      if (report.capturesPassword !== false) semanticFailures.push("second_account_readiness_summary_captures_password");
      if (report.storesPassword !== false) semanticFailures.push("second_account_readiness_summary_stores_password");
      if (report.readyForOperatorLogin !== false) semanticFailures.push("second_account_readiness_summary_ready_too_early");
      if (report.releaseAcceptableAccountProof !== false) semanticFailures.push("second_account_readiness_summary_release_proof_claimed");
      if (report.goalComplete !== false) semanticFailures.push("second_account_readiness_summary_goal_complete_claimed");
      if (typeof report.currentWindowsUserSid !== "string" || !report.currentWindowsUserSid.trim()) semanticFailures.push("second_account_readiness_summary_current_sid_missing");
      if (report.targetUserSidMatchesCurrentUser !== false) semanticFailures.push("second_account_readiness_summary_target_sid_matches_current");
      if (report.targetUserIsCurrentUser !== false) semanticFailures.push("second_account_readiness_summary_target_is_current_user");
      if (report.targetUserEnabled === false && report.readyForOperatorLogin === true) semanticFailures.push("second_account_readiness_summary_disabled_user_ready");
      if ((report.targetUserExists === true || report.readyForOperatorLogin === true || report.safeToAskUserForSecondAccountLogin === true)
        && (typeof report.targetWindowsUserSid !== "string" || !report.targetWindowsUserSid.trim())) semanticFailures.push("second_account_readiness_summary_target_sid_missing_when_ready");
      if ((report.readyForOperatorLogin === true || report.safeToAskUserForSecondAccountLogin === true)
        && report.targetUserIdentityBoundaryOk !== true) semanticFailures.push("second_account_readiness_summary_identity_boundary_unverified");
      if (!String(report.nextOperatorAction || "")) semanticFailures.push("second_account_readiness_summary_next_action_missing");
      const operatorActionCard = report.operatorActionCard && typeof report.operatorActionCard === "object" ? report.operatorActionCard : null;
      if (!operatorActionCard) semanticFailures.push("second_account_readiness_summary_operator_action_card_missing");
      else {
        if (!String(operatorActionCard.status || "")) semanticFailures.push("second_account_readiness_summary_operator_action_card_status");
        if (!String(operatorActionCard.windowsUser || "")) semanticFailures.push("second_account_readiness_summary_operator_action_card_windows_user");
        if (operatorActionCard.canAskUserToLoginNow !== false) semanticFailures.push("second_account_readiness_summary_operator_action_card_login_too_early");
        if (operatorActionCard.targetUserExists !== false) semanticFailures.push("second_account_readiness_summary_operator_action_card_target_exists");
        if (String(operatorActionCard.missingRequirement || "") !== "separate_windows_user_missing") semanticFailures.push("second_account_readiness_summary_operator_action_card_missing_requirement");
        if (!String(operatorActionCard.nextOperatorAction || "")) semanticFailures.push("second_account_readiness_summary_operator_action_card_next_action");
        if (!String(operatorActionCard.userVisibleNextStep || "")) semanticFailures.push("second_account_readiness_summary_operator_action_card_user_step");
        if (!String(operatorActionCard.noTrafficStatusCommand || "").includes("test-anticodex-second-account-readiness-summary.ps1")) semanticFailures.push("second_account_readiness_summary_operator_action_card_status_command");
      }
      const summaryPostManualCommands = Array.isArray(report.postManualSetupValidationCommands) ? report.postManualSetupValidationCommands.map(String) : [];
      const summaryPostManualReadyFields = Array.isArray(report.postManualSetupRequiredReadyFields) ? report.postManualSetupRequiredReadyFields.map(String) : [];
      if (summaryPostManualCommands.length < 3
        || !summaryPostManualCommands.some((command) => command.includes("test-anticodex-windows-user-account-prepare.ps1"))
        || !summaryPostManualCommands.some((command) => command.includes("test-anticodex-antigravity-account-isolation-status.ps1"))
        || !summaryPostManualCommands.some((command) => command.includes("start-anticodex-second-antigravity-account-login.ps1"))) semanticFailures.push("second_account_readiness_summary_post_manual_commands");
      for (const requiredField of ["targetUserExists:true", "targetWindowsUserSid:present", "targetUserIdentityBoundaryOk:true", "safeToAskUserForSecondAccountLogin:true", "canProceedToInteractiveLogin:true", "startedLogin:false", "usedRealTraffic:false"]) {
        if (!summaryPostManualReadyFields.includes(requiredField)) semanticFailures.push(`second_account_readiness_summary_post_manual_ready_field:${requiredField}`);
      }
      if (!String(report.approvedLoginCommandTemplate || "").includes("start-anticodex-second-antigravity-account-login.ps1")
        || !String(report.approvedLoginCommandTemplate || "").includes("-StartLoginApproval start-separate-windows-user-login")) semanticFailures.push("second_account_readiness_summary_login_command_missing");
      if (!String(report.nextNoTrafficStatusCommand || "").includes("test-anticodex-antigravity-account-isolation-status.ps1")) semanticFailures.push("second_account_readiness_summary_status_command_missing");
      if (!String(report.postLoginProofCommandTemplate || "").includes("test-anticodex-antigravity-cli-real-smoke.ps1")
        || !String(report.postLoginProofCommandTemplate || "").includes("-AllowSeparateAccountProof")
        || !String(report.postLoginProofCommandTemplate || "").includes("-WindowsUser")
        || !String(report.postLoginProofCommandTemplate || "").includes("SeparateAccountProofApprovalId")) semanticFailures.push("second_account_readiness_summary_proof_command_missing");
      if (report.postLoginProofCommandTemplateHasWindowsUser !== true) semanticFailures.push("second_account_readiness_summary_proof_command_windows_user");
      for (const requiredStep of ["windowsUserAccountPrepare", "windowsUserSetupGuidance", "accountIsolationStatus", "secondAccountLoginEntrypoint", "approvedRealRunSequence", "goalReadiness", "releaseGates"]) {
        if (!stepIds.includes(requiredStep)) semanticFailures.push(`second_account_readiness_summary_missing_step:${requiredStep}`);
      }
      if (steps.some((item) => item?.ok !== true)) semanticFailures.push("second_account_readiness_summary_step_not_ok");
      if (!report.accountIsolationCaveat) semanticFailures.push("second_account_readiness_summary_caveat_missing");
    }
    if (definition.requireSecondAccountPostLoginProofSemantics) {
      if (report.reportName !== "second-account-post-login-proof") semanticFailures.push("second_account_post_login_proof_report_name");
      if (report.behaviorCovered !== true) semanticFailures.push("second_account_post_login_proof_behavior_not_covered");
      if (report.changedSystem !== false) semanticFailures.push("second_account_post_login_proof_changed_system");
      if (report.createdUser !== false) semanticFailures.push("second_account_post_login_proof_created_user");
      if (report.capturesPassword !== false) semanticFailures.push("second_account_post_login_proof_captures_password");
      if (report.storesPassword !== false) semanticFailures.push("second_account_post_login_proof_stores_password");
      const postLoginDryRunValid = report.noTraffic === true
        && report.requestedRealTraffic === false
        && report.usedRealTraffic === false
        && report.coverageKind === "second-account-post-login-proof-dry-run"
        && report.willRunRealSmoke === false
        && report.loginVerified === false
        && report.separateAccountVerified === false
        && report.releaseAcceptableAccountProof === false;
      const postLoginRealProofValid = report.noTraffic === false
        && report.requestedRealTraffic === true
        && report.usedRealTraffic === true
        && report.coverageKind === "second-account-post-login-proof-real-traffic"
        && report.willRunRealSmoke === true
        && report.loginVerified === true
        && report.separateAccountVerified === true
        && report.releaseAcceptableAccountProof === true
        && report.accountIdentityComparisonPresent === true;
      if (!postLoginDryRunValid && !postLoginRealProofValid) semanticFailures.push("second_account_post_login_proof_invalid_mode");
      if (report.accountIsolationBoundary !== "separate-windows-user") semanticFailures.push("second_account_post_login_proof_boundary");
      if (!String(report.proofCommandPreview || "").includes("test-anticodex-antigravity-cli-real-smoke.ps1")
        || !String(report.proofCommandPreview || "").includes("-AllowSeparateAccountProof")
        || !String(report.proofCommandPreview || "").includes("-WindowsUser")) semanticFailures.push("second_account_post_login_proof_command_preview");
      const operatorActionCard = report.operatorActionCard && typeof report.operatorActionCard === "object" ? report.operatorActionCard : null;
      if (!operatorActionCard) semanticFailures.push("second_account_post_login_proof_operator_action_card_missing");
      else {
        const missingRequirements = Array.isArray(operatorActionCard.missingRequirements) ? operatorActionCard.missingRequirements.map(String) : [];
        if (!String(operatorActionCard.status || "")) semanticFailures.push("second_account_post_login_proof_operator_action_card_status");
        if (!String(operatorActionCard.windowsUser || "")) semanticFailures.push("second_account_post_login_proof_operator_action_card_windows_user");
        if (postLoginDryRunValid && operatorActionCard.canRunPostLoginProofNow !== false) semanticFailures.push("second_account_post_login_proof_operator_action_card_runs_too_early");
        if (postLoginDryRunValid && operatorActionCard.targetUserExists !== false) semanticFailures.push("second_account_post_login_proof_operator_action_card_target_exists");
        if (postLoginDryRunValid && operatorActionCard.canAskUserToLoginNow !== false) semanticFailures.push("second_account_post_login_proof_operator_action_card_login_too_early");
        if (postLoginDryRunValid && String(operatorActionCard.missingRequirement || "") !== "separate_windows_user_missing") semanticFailures.push("second_account_post_login_proof_operator_action_card_missing_requirement");
        if (postLoginDryRunValid && !missingRequirements.includes("separate_windows_user_missing")) semanticFailures.push("second_account_post_login_proof_operator_action_card_missing_requirements");
        if (!String(operatorActionCard.nextOperatorAction || "")) semanticFailures.push("second_account_post_login_proof_operator_action_card_next_action");
        if (!String(operatorActionCard.userVisibleNextStep || "")) semanticFailures.push("second_account_post_login_proof_operator_action_card_user_step");
        if (!String(operatorActionCard.noTrafficStatusCommand || "").includes("test-anticodex-second-account-post-login-proof.ps1")) semanticFailures.push("second_account_post_login_proof_operator_action_card_status_command");
        if (!String(operatorActionCard.proofCommandPreview || "").includes("test-anticodex-antigravity-cli-real-smoke.ps1")) semanticFailures.push("second_account_post_login_proof_operator_action_card_proof_command");
      }
      if (!report.accountIsolationCaveat) semanticFailures.push("second_account_post_login_proof_caveat_missing");
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
      const nativeBridgeEnabled = toolBridge.nativeBridgeDefaultEnabled === true;
      const modelOnlyOk = toolBridge.mode === "codex-owned-tools-model-only"
        && toolBridge.nativeBridgeDefaultEnabled === false
        && toolBridge.nativeAntigravityToolEvents === false
        && toolBridge.acceptsExternalToolDefinitions === false
        && compatibilityTools.bridge === "codex_owned_model_only_tool_bridge"
        && nativeToolCapability.codexToolBridge === "codex-owned-tools-model-only"
        && nativeToolCapability.nativeMcpPermissionMode === "disabled-with-native-bridge";
      const nativeOk = nativeBridgeEnabled
        && toolBridge.mode === "native-mcp-same-cascade"
        && toolBridge.localAdapter === "native-mcp-same-cascade-with-prompt-fallback"
        && toolBridge.nativeAntigravityToolEvents === true
        && toolBridge.nativeMcpDiscoveryVerified === true
        && toolBridge.acceptsExternalToolDefinitions === true
        && compatibilityTools.bridge === "native_mcp_same_cascade"
        && nativeToolCapability.nativeMcpApprovalProtocolVerified === true
        && nativeToolCapability.nativeMcpPermissionMode === "automatic-before-codex-execution"
        && nativeToolCapability.sameCascadeResumeProbeVerified === true
        && nativeToolCapability.codexToolBridge === "native-mcp-same-cascade-with-prompt-fallback";
      if (!modelOnlyOk && !nativeOk) semanticFailures.push("tool_bridge_not_model_only_or_explicit_native");
      if (!["cli", "native", "desktop-cascade", "upstream-provider"].includes(String(toolBridge.transport || ""))) semanticFailures.push("tool_bridge_transport_invalid");
      if (nativeToolCapability.antigravityOwnedToolsDisabled !== true) semanticFailures.push("tool_bridge_owned_tools_enabled");
      if (nativeToolCapability.permissionPromptsDisabled !== true) semanticFailures.push("tool_bridge_permission_prompts_enabled");
      if (Number(nativeToolCapability.disabledToolCount || 0) < 1) semanticFailures.push("tool_bridge_disabled_tool_count");
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
    if (definition.requireAmbientSuggestionSemantics) {
      const sqliteChecks = Array.isArray(report.sqliteChecks) ? report.sqliteChecks : [];
      const codexEntries = Array.isArray(report.nameScans?.codexHome?.entries) ? report.nameScans.codexHome.entries : [];
      const installEntries = Array.isArray(report.nameScans?.installRoot?.entries) ? report.nameScans.installRoot.entries : [];
      const nameEntries = [...codexEntries, ...installEntries];
      if (report.reportName !== "ambient-suggestions") semanticFailures.push("ambient_suggestions_report_name");
      if (report.noTraffic !== true) semanticFailures.push("ambient_suggestions_no_traffic");
      if (report.usedRealTraffic !== false) semanticFailures.push("ambient_suggestions_used_real_traffic");
      if (report.behaviorCovered !== true) semanticFailures.push("ambient_suggestions_behavior_not_covered");
      if (report.coverageKind !== "installed-no-traffic") semanticFailures.push("ambient_suggestions_coverage_kind");
      if (Array.isArray(report.failures) && report.failures.length > 0) semanticFailures.push("ambient_suggestions_failures");
      if (!sqliteChecks.length) semanticFailures.push("ambient_suggestions_sqlite_missing");
      if (sqliteChecks.some((item) => (Array.isArray(item?.tableHits) && item.tableHits.length) || (Array.isArray(item?.columnHits) && item.columnHits.length) || (Array.isArray(item?.targetHits) && item.targetHits.length))) semanticFailures.push("ambient_suggestions_sqlite_sources");
      if (nameEntries.some((item) => item?.allowed !== true)) semanticFailures.push("ambient_suggestions_unallowed_name");
      if (!report.chromiumOnDeviceHeadSuggestModel || !Number.isFinite(Number(report.chromiumOnDeviceHeadSuggestModel.fileCount))) semanticFailures.push("ambient_suggestions_chromium_probe_missing");
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
      const clientSyncContract = report.clientSyncContract || {};
      const patchScope = Array.isArray(clientSyncContract.antiCodexPatchScope) ? clientSyncContract.antiCodexPatchScope : [];
      const sourcePackageVersion = String(clientSyncContract.sourcePackageVersion || "");
      const activeSourcePackageVersion = String(clientSyncContract.activeSourcePackageVersion || "");
      if (report.reportName !== "sync-readiness") semanticFailures.push("sync_readiness_report_name");
      if (gate.selectedFromHistory === true && gate.historySourceMismatch === true) semanticFailures.push("sync_readiness_history_source_mismatch");
      if (report.noTraffic !== true || report.usedRealTraffic !== false || report.behaviorCovered !== true || report.coverageKind !== "installed-no-traffic") semanticFailures.push("sync_readiness_no_traffic_attestation");
      if (report.fast !== false || report.skipIconPaletteProbe !== false) semanticFailures.push("sync_readiness_full_mode_required");
      if (clientSyncContract.mode !== "codex-client-copy-plus-anticodex-patches"
        || clientSyncContract.maintenancePath !== "guarded-host-sync-then-reapply-anticodex-patches"
        || clientSyncContract.nativeClientBehaviorCarriedByHostSync !== true
        || clientSyncContract.forbidsFeatureByFeatureReimplementation !== true) semanticFailures.push("sync_readiness_client_sync_contract");
      if (!String(clientSyncContract.sourcePackageName || "").includes("Codex")
        || !String(clientSyncContract.activeSourcePackageName || "").includes("Codex")
        || clientSyncContract.sourceHostHashMatches !== true
        || clientSyncContract.sourceCliHashMatches !== true) semanticFailures.push("sync_readiness_client_sync_source_match");
      if (!sourcePackageVersion || !activeSourcePackageVersion || sourcePackageVersion !== activeSourcePackageVersion) semanticFailures.push("sync_readiness_client_sync_version_mismatch");
      for (const requiredPatch of allowedAntiCodexPatchScope) {
        if (!patchScope.includes(requiredPatch)) semanticFailures.push(`sync_readiness_client_patch_scope:${requiredPatch}`);
      }
      if (patchScope.length !== allowedAntiCodexPatchScope.length || patchScope.some((item) => !allowedAntiCodexPatchScope.includes(item))) semanticFailures.push("sync_readiness_client_patch_scope_extra");
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

function gateSatisfiedBeforeCrossSnapshotCheck(gate) {
  return !!gate
    && gate.present === true
    && gate.parseable === true
    && gate.hashValid === true
    && gate.okField === true
    && gate.fresh === true
    && (!Array.isArray(gate.semanticFailures) || gate.semanticFailures.length === 0);
}

function addSourceSnapshotMismatchFailures(gates, addFailure) {
  const checkedGates = [
    { id: "refreshFeatures", failure: "refresh_features_source_snapshot_mismatch" },
    { id: "mcpSkills", failure: "mcp_skills_source_snapshot_mismatch" },
    { id: "pluginCapabilities", failure: "plugin_capabilities_source_snapshot_mismatch" },
  ]
    .map((entry) => ({ ...entry, gate: gates.find((gate) => gate.id === entry.id) }))
    .filter((entry) => gateSatisfiedBeforeCrossSnapshotCheck(entry.gate) && entry.gate.sourceFingerprint);
  if (checkedGates.length !== 3) return;
  const fingerprints = new Set(checkedGates.map((entry) => entry.gate.sourceFingerprint));
  if (fingerprints.size <= 1) return;
  for (const entry of checkedGates) addFailure(entry.id, entry.failure);
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

function gateFailureReasons(gate) {
  const reasons = [];
  if (!gate.present) reasons.push("missing_report");
  if (gate.present && gate.parseable !== true) reasons.push("unparseable_report");
  if (gate.present && gate.signed !== true) reasons.push("unsigned_report");
  if (gate.present && gate.hashValid !== true) reasons.push(gate.error || "hash_invalid");
  if (gate.present && gate.parseable === true && gate.okField !== true) reasons.push("ok_false");
  if (gate.present && gate.parseable === true && gate.fresh !== true) reasons.push("stale_report");
  if (Array.isArray(gate.semanticFailures) && gate.semanticFailures.length) reasons.push("semantic_failures");
  if (gate.error && !reasons.includes(gate.error)) reasons.push(gate.error);
  return reasons.length ? reasons : (gate.satisfied ? [] : ["unsatisfied"]);
}

function isLocalGatewayFailureSample(value) {
  const text = String(value || "").toLowerCase();
  return text.includes("/health")
    || text.includes("endpoint failed")
    || text.includes("gateway offline")
    || text.includes("fetch failed")
    || text.includes("failed to fetch")
    || text.includes("timeout")
    || text.includes("connection refused")
    || text.includes("econnrefused")
    || text.includes("无法连接");
}

function reportFailureSampleCodes(samples) {
  const codes = new Set();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const text = String(sample || "").toLowerCase();
    if (!text) continue;
    if (text.includes("endpoint failed") || text.includes("/backend-api/") || text.includes("/health")) codes.add("gateway_endpoint_unreachable");
    if (isLocalGatewayFailureSample(text)) codes.add("local_gateway_offline");
    if (text.includes("source_codex_changed") || text.includes("anti-codex sync is required") || text.includes("installed codex changed")) codes.add("host_sync_required");
  }
  return [...codes].sort();
}

function mcpSkillsGatewayNeeded(gate) {
  return gate?.id === "mcpSkills"
    && Array.isArray(gate.reportFailureSamples)
    && gate.reportFailureSamples.some(isLocalGatewayFailureSample);
}

function gateGuidance(gate) {
  const failedReasons = Array.isArray(gate?.failureReasons) ? gate.failureReasons : [];
  const actions = rawGateOrderedActions(gate);
  if (mcpSkillsGatewayNeeded(gate)) {
    return "local_gateway_offline: start or restore the local Anti-Codex gateway, then rerun MCP/Skill release-grade verification.";
  }
  if (gate?.id === "pluginCapabilities" && Array.isArray(gate.reportFailureSamples) && gate.reportFailureSamples.some(isLocalGatewayFailureSample)) {
    return "local_gateway_offline: start or restore the local Anti-Codex gateway, then rerun plugin/app capability check.";
  }
  if (gate?.id === "missingHistory" && Array.isArray(gate.reportFailureSamples) && gate.reportFailureSamples.some(isLocalGatewayFailureSample)) {
    return "local_gateway_offline: start or restore the local Anti-Codex gateway, then rerun missing-history verification.";
  }
  if (gate?.id === "installedRuntimeSync" && failedReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    return "runtime_sync_refresh_required: rerun the no-restart runtime sync; if the local gateway is offline, use installedRuntimeEvidence fingerprints to distinguish copied files from live health.";
  }
  if (syncReadinessHostSyncNeeded(gate)) {
    return "host_sync_required: installed Codex changed; run Sync Codex Update only with explicit approval. It builds and validates a candidate before replacing Anti-Codex; failed validation leaves the current host intact.";
  }
  if (gate?.id === "realThirdPartyProviderOptional" && failedReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    return "optional_real_provider_required: optional real third-party provider evidence is stale or missing; run only with explicit user approval and an environment-variable API key, never ChatGPT login or stored connector authorization.";
  }
  if (gate?.id === "providerAntigravityReturnOptional" && failedReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    return "optional_antigravity_return_required: optional provider-to-Antigravity return evidence is stale or missing; run only with explicit user approval because it performs a real Antigravity return turn.";
  }
  if (gate?.id === "antigravityCliRealSmokeOptional" && failedReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    return "optional_antigravity_cli_real_smoke_required: Anti-Codex only verifies its model-text lane/profile; MCP Antigravity account lane is externally managed/not managed here; same-Windows-user profile/AppData isolation is insufficient; separate account proof requires a separate Windows user or official independent credential store plus explicit account-identity evidence. Run only with explicit user approval and no Antigravity Desktop/coworker dependency.";
  }
  if (actions.some((item) => item.id === "stabilitySoak") && failedReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    return "optional_stability_soak_required: optional soak evidence is stale; run only with explicit user approval because it uses the local gateway, real traffic, and a longer stability window.";
  }
  if (actions.some((item) => item.id === "coldRelaunch") && failedReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    return "optional_cold_relaunch_required: optional cold-relaunch evidence is missing or stale; run only with explicit user approval because it restarts the isolated Anti-Codex runtime.";
  }
  if (["short", "manager", "no-traffic"].includes(gate?.group || "") && failedReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures") && actions.some((item) => item.requiresGatewayStart === true && item.requiresRealTraffic !== true)) {
    return "local_gateway_required: start or restore the local Anti-Codex gateway, then rerun the listed gateway-dependent verifier.";
  }
  if (gate?.group === "real-traffic" && failedReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    return "real_traffic_evidence_stale: requires explicit user approval to start/verify Anti-Codex and refresh release-grade real-traffic reports.";
  }
  return "";
}

const realTrafficRefreshOrder = [
  ["accountProxyReadiness", "real-traffic-low-state", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-account-proxy-readiness.ps1 -TimeoutSec 120"],
  ["codexResponses", "real-traffic-low-state", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-codex-responses.ps1 -TimeoutSec 90"],
  ["uiChatSmoke", "real-traffic-low-state", "node scripts\\test-anticodex-ui-chat-smoke.mjs --timeout-ms 90000"],
  ["uiWebSearchSmoke", "real-traffic-low-state", "node scripts\\test-anticodex-ui-chat-smoke.mjs --task-mode web-search --timeout-ms 90000"],
  ["uiLocalProjectSmoke", "real-traffic-low-state", "node scripts\\test-anticodex-ui-chat-smoke.mjs --task-mode local-project --timeout-ms 120000"],
  ["uiCodingProjectSmoke", "real-traffic-low-state", "node scripts\\test-anticodex-ui-chat-smoke.mjs --task-mode coding-project --timeout-ms 120000"],
  ["uiMultiTurnProjectSmoke", "real-traffic-low-state", "node scripts\\test-anticodex-ui-chat-smoke.mjs --task-mode multi-turn-project --timeout-ms 240000"],
  ["uiRepoFileEditSmoke", "real-traffic-low-state", "node scripts\\test-anticodex-ui-chat-smoke.mjs --task-mode repo-file-edit --timeout-ms 240000"],
  ["uiRepoMultiFileEditSmoke", "real-traffic-low-state", "node scripts\\test-anticodex-ui-chat-smoke.mjs --task-mode repo-multi-file-edit --timeout-ms 300000"],
  ["uiComplexProjectSmoke", "real-traffic-low-state", "node scripts\\test-anticodex-ui-chat-smoke.mjs --task-mode complex-project --timeout-ms 180000"],
  ["uiReportSiteSmoke", "real-traffic-low-state", "node scripts\\test-anticodex-ui-chat-smoke.mjs --task-mode report-site --timeout-ms 150000"],
  ["desktopTaskSuite", "real-traffic-low-state", "node scripts\\test-anticodex-desktop-task-suite.mjs --suite-profile agentic --allow-real-traffic"],
  ["toolLoop", "real-traffic-low-state", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-tool-loop.ps1 -TimeoutSec 90"],
  ["customToolLoop", "real-traffic-low-state", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-custom-tool-loop.ps1 -TimeoutSec 90"],
  ["nativeToolLoop", "real-traffic-low-state", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-native-tool-loop.ps1 -TimeoutSec 90"],
  ["nativeMultiToolLoop", "real-traffic-low-state", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-native-multi-tool-loop.ps1 -TimeoutSec 90"],
  ["mcpToolLoop", "real-traffic-low-state", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-mcp-tool-loop.ps1 -TimeoutSec 90"],
  ["webTools", "real-traffic-low-state", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-web-tools.ps1 -TimeoutSec 90"],
  ["compactionResume", "real-traffic-session-state", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-compaction-resume.ps1 -TimeoutSec 90"],
  ["cancellation", "real-traffic-session-state", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-cancellation.ps1 -TimeoutSec 90"],
  ["realMiniTool", "real-traffic-high-impact", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-real-mini-tool.ps1 -TimeoutSec 90 -AllowRealTraffic"],
  ["realWork", "real-traffic-high-impact", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-real-work.ps1 -TimeoutSec 90 -AllowRealTraffic"],
  ["realSmallProject", "real-traffic-high-impact", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-real-small-project.ps1 -TimeoutSec 120 -AllowRealTraffic"],
  ["postVerification", "real-traffic-final", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-post-verification.ps1 -TimeoutMinutes 10"],
];

const optionalEvidenceRefreshOrder = [
  ["realThirdPartyProviderOptional", "optional-real-provider", "node scripts/test-anticodex-real-third-party-provider.mjs --allow-real-traffic --protocol <openai-compatible|anthropic> --base-url <provider-url> --model <model> --api-key-env <ENV_VAR_WITH_API_KEY>", { requiresRealTraffic: true, highImpact: true }],
  ["providerAntigravityReturnOptional", "optional-antigravity-return", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-provider-antigravity-return.ps1 -AllowRealTraffic", { requiresGatewayStart: true, requiresRealTraffic: true, highImpact: true }],
  ["antigravityCliRealSmokeOptional", "optional-antigravity-cli-real-smoke", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-antigravity-cli-real-smoke.ps1 -AllowRealTraffic -WindowsUser <target-windows-user> -ProfileRoot <isolated-antigravity-cli-profile> -StrictWindowsAppDataIsolation -AccountIsolationBoundary <separate-windows-user|official-independent-credential-store> -AllowSeparateAccountProof -AntiCodexAccountId <anticodex-account-id-or-fingerprint> -McpAccountId <mcp-account-id-or-fingerprint> -SeparateAccountProofApprovalId <explicit-user-approval-id>", { requiresRealTraffic: true, highImpact: true }],
  ["stabilitySoak", "optional-stability-soak", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-stability-soak.ps1 -DurationSec 180", { requiresGatewayStart: true, requiresRealTraffic: true, highImpact: true }],
  ["coldRelaunch", "optional-cold-relaunch", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-cold-relaunch.ps1 -ConfirmRelaunch", { requiresGatewayStart: true, highImpact: true }],
];

const shortEvidenceRefreshOrder = [
  ["fastOverallNoTraffic", "short-gateway", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-installed-overall.ps1 -Fast -SkipManagerActionProbe -SkipAccountProxyProbe -TimeoutSec 25", { requiresGatewayStart: true }],
  ["sourcePreflight", "short-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-source-preflight.ps1 -SkipFullRegression"],
  ["mcpSkills", "short-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-mcp-skills.ps1 -TimeoutSec 45"],
  ["localConnectors", "short-local", "powershell.exe -NoProfile -Command \"& node scripts\\test-anticodex-local-connectors.mjs --report-root $env:APPDATA\\anticodex\\reports\""],
  ["thirdPartyProvider", "short-local", "powershell.exe -NoProfile -Command \"& node scripts\\test-anticodex-third-party-provider.mjs --report-root $env:APPDATA\\anticodex\\reports\""],
  ["missingHistory", "short-gateway", "powershell.exe -NoProfile -Command \"& node scripts\\test-anticodex-missing-history.mjs --report-root $env:APPDATA\\anticodex\\reports\"", { requiresGatewayStart: true }],
  ["installedRuntimeSync", "short-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\sync-anticodex-runtime.ps1 -NoRestart -TimeoutSec 10"],
];

const managerEvidenceRefreshOrder = [
  ["managerRealButtons", "manager-gateway-check", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-manager-real-buttons.ps1 -TimeoutSec 120", { requiresGatewayStart: true }],
  ["refreshFeatures", "manager-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\refresh-anticodex-local-features.ps1 -VerifyOnly"],
];

const noTrafficEvidenceRefreshOrder = [
  ["installedOverallNoTraffic", "no-traffic-gateway", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-installed-overall.ps1 -NoTraffic -SkipManagerActionProbe -SkipAccountProxyProbe -TimeoutSec 25", { requiresGatewayStart: true }],
  ["modelRouting", "no-traffic-gateway", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-model-routing.ps1 -SkipRequests -TimeoutSec 20", { requiresGatewayStart: true }],
  ["logDbGuard", "no-traffic-local", "powershell.exe -NoProfile -Command \"& node scripts\\protect-anticodex-log-db.mjs --status --report-root $env:APPDATA\\anticodex\\reports\""],
  ["toolBridgeMode", "no-traffic-gateway", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-tool-bridge-mode.ps1 -TimeoutSec 20", { requiresGatewayStart: true }],
  ["uiIdleStability", "no-traffic-gateway", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-ui-idle-stability.ps1 -DurationSec 20 -IntervalSec 5 -TimeoutSec 8 -SkipManagerActionProbe", { requiresGatewayStart: true }],
  ["syncReadiness", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-sync-readiness.ps1"],
  ["modelThinking", "no-traffic-gateway", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-model-thinking.ps1 -TimeoutSec 8", { requiresGatewayStart: true }],
  ["ambientSuggestions", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-ambient-suggestions.ps1"],
  ["antigravityCliWindowsUserReadiness", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-antigravity-cli-windows-user-readiness.ps1"],
  ["windowsUserAccountPrepare", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-windows-user-account-prepare.ps1"],
  ["windowsUserSetupGuidance", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-windows-user-setup-guidance.ps1"],
  ["antigravityAccountIsolationStatus", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-antigravity-account-isolation-status.ps1"],
  ["secondAccountLoginEntrypoint", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-second-account-login-entrypoint.ps1"],
  ["secondAccountReadinessSummary", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-second-account-readiness-summary.ps1"],
  ["secondAccountPostLoginProof", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-second-account-post-login-proof.ps1"],
  ["cliTransportBoundary", "no-traffic-gateway", "node scripts\\test-anticodex-cli-transport-boundary.mjs", { requiresGatewayStart: true }],
  ["longTaskLandingMatrix", "no-traffic-local", "node scripts\\test-anticodex-long-task-landing-matrix.mjs"],
  ["agenticCapabilityMatrix", "no-traffic-local", "node scripts\\test-anticodex-agentic-capability-matrix.mjs"],
  ["realTaskCoverageRoadmap", "no-traffic-local", "node scripts\\test-anticodex-real-task-coverage-roadmap.mjs"],
  ["nativeCodexParityTaskMatrix", "no-traffic-local", "node scripts\\test-anticodex-native-codex-parity-tasks.mjs"],
  ["realApprovalPlan", "no-traffic-local", "node scripts\\test-anticodex-real-approval-plan.mjs"],
  ["goalReadiness", "no-traffic-local", "node scripts\\test-anticodex-goal-readiness.mjs"],
  ["requiredRealTrafficSequence", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-required-real-traffic-sequence.ps1"],
  ["goalRealRunReadiness", "no-traffic-local", "node scripts\\test-anticodex-goal-real-run-readiness.mjs"],
  ["approvedRealRunSequence", "no-traffic-local", "node scripts\\test-anticodex-approved-real-run-sequence.mjs"],
];

function action(id, phase, command, options = {}) {
  return {
    id,
    phase,
    command,
    reason: typeof options.reason === "string" ? options.reason : "",
    guidance: typeof options.guidance === "string" ? options.guidance : "",
    reportOnly: options.reportOnly === true,
    requiresGatewayStart: options.requiresGatewayStart === true,
    requiresRealTraffic: options.requiresRealTraffic === true,
    highImpact: options.highImpact === true,
    blockedUntilExplicitUserApproval: options.requiresGatewayStart === true || options.requiresRealTraffic === true || options.highImpact === true,
  };
}

function semanticReportOnlyAction(gate) {
  if (!Array.isArray(gate?.failureReasons) || !gate.failureReasons.includes("semantic_failures")) return [];
  return [action("releaseGateReportOnlyCheck", "report-only", "node scripts/test-anticodex-release-gates.mjs --strict", { reportOnly: true })];
}

function syncReadinessHostSyncNeeded(gate) {
  if (gate?.id !== "syncReadiness") return false;
  const semanticFailures = Array.isArray(gate.semanticFailures) ? gate.semanticFailures : [];
  const samples = Array.isArray(gate.reportFailureSamples) ? gate.reportFailureSamples.map((sample) => String(sample || "").toLowerCase()) : [];
  return semanticFailures.some((failure) => [
    "sync_readiness_update_status",
    "sync_readiness_source_active_hash_mismatch",
    "sync_readiness_guardrails",
  ].includes(failure)) || samples.some((sample) => sample.includes("source_codex_changed") || sample.includes("anti-codex sync is required"));
}

function rawGateOrderedActions(gate) {
  if (syncReadinessHostSyncNeeded(gate)) {
    return [
      ...semanticReportOnlyAction(gate),
      action("syncReadiness", "no-traffic-local", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-sync-readiness.ps1"),
      { id: "syncHost", phase: "host-sync", command: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\sync-anticodex-launcher.ps1", reportOnly: false, requiresGatewayStart: false, requiresRealTraffic: false, highImpact: true, blockedUntilExplicitUserApproval: true },
    ];
  }
  if (gate?.group === "short" && !gate.satisfied && gate.id !== "pluginCapabilities") {
    const index = shortEvidenceRefreshOrder.findIndex(([id]) => id === gate.id);
    if (index >= 0) {
      const [id, phase, command, options] = shortEvidenceRefreshOrder[index];
      const gatewayNeeded = mcpSkillsGatewayNeeded(gate);
      const actionOptions = gatewayNeeded ? { ...(options || {}), requiresGatewayStart: true } : (options || {});
      return [...semanticReportOnlyAction(gate), action(id, gatewayNeeded ? "short-gateway" : phase, command, actionOptions)];
    }
  }
  if (gate?.id === "pluginCapabilities" && !gate.satisfied) {
    return [
      ...semanticReportOnlyAction(gate),
      action("startGatewayTranslatorOnly", "gateway-start", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\start-deepcodex.ps1 -TranslatorOnly", { requiresGatewayStart: true }),
      action("pluginCapabilities", "plugin-capabilities", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\test-anticodex-plugin-capabilities.ps1 -TimeoutSec 45", { requiresGatewayStart: true }),
    ];
  }
  if (gate?.group === "manager" && Array.isArray(gate.failureReasons) && gate.failureReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    const index = managerEvidenceRefreshOrder.findIndex(([id]) => id === gate.id);
    if (index < 0) return [];
    const [id, phase, command, options] = managerEvidenceRefreshOrder[index];
    return [...semanticReportOnlyAction(gate), action(id, phase, command, options)];
  }
  if (gate?.group === "no-traffic" && Array.isArray(gate.failureReasons) && gate.failureReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    const index = noTrafficEvidenceRefreshOrder.findIndex(([id]) => id === gate.id);
    if (index < 0) return [];
    const [id, phase, command, options] = noTrafficEvidenceRefreshOrder[index];
    return [...semanticReportOnlyAction(gate), action(id, phase, command, options || {})];
  }
  if (gate?.group === "real-traffic" && Array.isArray(gate.failureReasons) && gate.failureReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    const index = realTrafficRefreshOrder.findIndex(([id]) => id === gate.id);
    if (index < 0) return [];
    const [id, phase, command] = realTrafficRefreshOrder[index];
    return [...semanticReportOnlyAction(gate), action(id, phase, command, { requiresGatewayStart: true, requiresRealTraffic: true, highImpact: ["realMiniTool", "realWork", "realSmallProject", "postVerification"].includes(id) })];
  }
  if ((gate?.group === "soak" || gate?.group === "cold") && Array.isArray(gate.failureReasons) && gate.failureReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    const index = optionalEvidenceRefreshOrder.findIndex(([id]) => id === gate.id);
    if (index < 0) return [];
    const [id, phase, command, options] = optionalEvidenceRefreshOrder[index];
    return [...semanticReportOnlyAction(gate), action(id, phase, command, options)];
  }
  if (gate?.group === "optional-real-traffic" && Array.isArray(gate.failureReasons) && gate.failureReasons.some((reason) => reason === "stale_report" || reason === "missing_report" || reason === "ok_false" || reason === "semantic_failures")) {
    const index = optionalEvidenceRefreshOrder.findIndex(([id]) => id === gate.id);
    if (index < 0) return [];
    const [id, phase, command, options] = optionalEvidenceRefreshOrder[index];
    return [...semanticReportOnlyAction(gate), action(id, phase, command, options)];
  }
  return [];
}

function gateActionReason(gate) {
  return gate?.failureReason || (Array.isArray(gate?.failureReasons) ? gate.failureReasons[0] : "") || "";
}

function gateOrderedActions(gate) {
  const reason = gateActionReason(gate);
  const guidance = gateGuidance(gate);
  return rawGateOrderedActions(gate).map((item) => ({
    ...item,
    reason: item.reason || reason,
    guidance: item.guidance || guidance,
  }));
}

const actionPhaseOrder = [
  "report-only",
  "gateway-start",
  "short-local",
  "short-gateway",
  "plugin-capabilities",
  "manager-local",
  "manager-gateway-check",
  "no-traffic-local",
  "no-traffic-gateway",
  "host-sync",
  "real-traffic-low-state",
  "real-traffic-session-state",
  "real-traffic-high-impact",
  "real-traffic-final",
  "optional-real-provider",
  "optional-antigravity-return",
  "optional-stability-soak",
  "optional-cold-relaunch",
];

function collectOrderedNextActions(failureReasons) {
  const items = failureReasons
    .flatMap((gate, gateIndex) => (Array.isArray(gate.orderedActions) ? gate.orderedActions : []).map((item, actionIndex) => {
      const failureReason = gate.failureReason || (Array.isArray(gate.failureReasons) ? gate.failureReasons[0] : "") || "";
      const guidance = typeof gate.guidance === "string" && gate.guidance ? gate.guidance : gateGuidance(gate);
      return {
        ...item,
        reason: item.reason || failureReason,
        guidance: item.guidance || guidance,
        gateId: gate.id,
        requiredForRelease: gate.requiredForRelease === true,
        requiredForShort: gate.requiredForShort === true,
        order: gateIndex * 100 + actionIndex,
      };
    }))
    .filter((item, index, array) => {
      const key = item.reportOnly === true ? `${item.phase}:${item.id}` : `${item.gateId}:${item.id}`;
      return array.findIndex((other) => (other.reportOnly === true ? `${other.phase}:${other.id}` : `${other.gateId}:${other.id}`) === key) === index;
    })
    .sort((left, right) => {
      const leftPhase = actionPhaseOrder.indexOf(left.phase);
      const rightPhase = actionPhaseOrder.indexOf(right.phase);
      const leftRank = leftPhase < 0 ? actionPhaseOrder.length : leftPhase;
      const rightRank = rightPhase < 0 ? actionPhaseOrder.length : rightPhase;
      return leftRank - rightRank || left.order - right.order;
    })
    .map(({ order, ...item }) => item);
  const requiredGatewayStartNeeded = items.some((item) => item.requiresGatewayStart === true
    && item.requiresRealTraffic !== true
    && (item.requiredForRelease === true || item.requiredForShort === true));
  if (requiredGatewayStartNeeded && !items.some((item) => item.id === "startGatewayTranslatorOnly")) {
    items.unshift(action("startGatewayTranslatorOnly", "gateway-start", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\start-deepcodex.ps1 -TranslatorOnly", {
      requiresGatewayStart: true,
      reason: "local_gateway_required",
      guidance: "local_gateway_required: start or restore the local Anti-Codex gateway before running gateway-dependent verifiers.",
    }));
  }
  return items;
}

const NEXT_ACTION_LIMIT = 32;

function visibleNextActions(available) {
  const actions = available.slice(0, NEXT_ACTION_LIMIT);
  const finalVerification = available.find((item) => item.id === "postVerification");
  if (finalVerification && !actions.some((item) => item.id === "postVerification") && actions.length > 0) {
    actions[actions.length - 1] = finalVerification;
  }
  return actions;
}

function orderedNextActions(failureReasons) {
  return visibleNextActions(collectOrderedNextActions(failureReasons));
}

function summarizeNextActions(failureReasons) {
  const available = collectOrderedNextActions(failureReasons);
  const actions = visibleNextActions(available);
  return {
    actions,
    allActions: available,
    availableCount: available.length,
    hiddenCount: Math.max(0, available.length - actions.length),
    truncated: available.length > actions.length,
  };
}

function summarizeApprovalPlan(actions) {
  const items = Array.isArray(actions) ? actions : [];
  const phases = actionPhaseOrder
    .map((phase) => {
      const phaseActions = items.filter((item) => item.phase === phase);
      if (!phaseActions.length) return null;
      return {
        phase,
        count: phaseActions.length,
        requiresGatewayStart: phaseActions.some((item) => item.requiresGatewayStart === true),
        requiresRealTraffic: phaseActions.some((item) => item.requiresRealTraffic === true),
        highImpact: phaseActions.some((item) => item.highImpact === true),
        reportOnly: phaseActions.some((item) => item.reportOnly === true),
        blockedUntilExplicitUserApproval: phaseActions.some((item) => item.blockedUntilExplicitUserApproval === true),
      };
    })
    .filter(Boolean);
  return {
    actionCount: items.length,
    blockedCount: items.filter((item) => item.blockedUntilExplicitUserApproval === true).length,
    requiresGatewayStartCount: items.filter((item) => item.requiresGatewayStart === true).length,
    requiresRealTrafficCount: items.filter((item) => item.requiresRealTraffic === true).length,
    highImpactCount: items.filter((item) => item.highImpact === true).length,
    reportOnlyCount: items.filter((item) => item.reportOnly === true).length,
    requiredForShortCount: items.filter((item) => item.requiredForShort === true).length,
    requiredForReleaseCount: items.filter((item) => item.requiredForRelease === true).length,
    firstBlockedAction: items.find((item) => item.blockedUntilExplicitUserApproval === true)?.id || "",
    phases,
  };
}

function compactReleaseGateStatus(payload) {
  const approvalPlan = payload?.approvalPlan && typeof payload.approvalPlan === "object" ? payload.approvalPlan : {};
  return {
    ok: payload?.ok === true,
    reportName: "release-gates-status",
    shortReady: payload?.shortReady === true,
    releaseReady: payload?.releaseReady === true,
    releaseBlockedOnlyByRequiredRealTraffic: payload?.releaseBlockedOnlyByRequiredRealTraffic === true,
    requiredRealTrafficBlockedGates: Array.isArray(payload?.requiredRealTrafficBlockedGates) ? payload.requiredRealTrafficBlockedGates : [],
    missingRequired: Array.isArray(payload?.missingRequired) ? payload.missingRequired : [],
    missingShort: Array.isArray(payload?.missingShort) ? payload.missingShort : [],
    damagedReports: Array.isArray(payload?.damagedReports) ? payload.damagedReports : [],
    firstBlockedAction: typeof approvalPlan.firstBlockedAction === "string" ? approvalPlan.firstBlockedAction : "",
    nextActionsAvailableCount: Number.isFinite(Number(payload?.nextActionsAvailableCount)) ? Number(payload.nextActionsAvailableCount) : 0,
    nextActionsHiddenCount: Number.isFinite(Number(payload?.nextActionsHiddenCount)) ? Number(payload.nextActionsHiddenCount) : 0,
    nextActionsTruncated: payload?.nextActionsTruncated === true,
    requiresGatewayStartCount: Number.isFinite(Number(approvalPlan.requiresGatewayStartCount)) ? Number(approvalPlan.requiresGatewayStartCount) : 0,
    requiresRealTrafficCount: Number.isFinite(Number(approvalPlan.requiresRealTrafficCount)) ? Number(approvalPlan.requiresRealTrafficCount) : 0,
    reportOnlyCount: Number.isFinite(Number(approvalPlan.reportOnlyCount)) ? Number(approvalPlan.reportOnlyCount) : 0,
  };
}

function attachGateFailureReasons(gates) {
  for (const gate of gates) {
    gate.failureReasons = gate.satisfied ? [] : gateFailureReasons(gate);
    gate.failureReason = gate.failureReasons[0] || "";
  }
  return gates;
}

function attachPluginOfflineSnapshotEvidence(gates) {
  const pluginGate = gates.find((gate) => gate.id === "pluginCapabilities");
  const refreshGate = gates.find((gate) => gate.id === "refreshFeatures");
  if (!pluginGate || !refreshGate?.refreshFeatureSnapshotEvidence) return gates;
  pluginGate.offlineSnapshotEvidence = {
    ...refreshGate.refreshFeatureSnapshotEvidence,
    refreshGateSatisfied: refreshGate.satisfied === true,
    refreshSelectedFile: refreshGate.selectedFile || "",
    note: "Local connector/app-tool metadata parity is proven by refreshFeatures; pluginCapabilities still needs the local gateway for runtime endpoint evidence.",
  };
  return gates;
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

    const fakeRoadmapTaskModes = [
      "free-chat",
      "web-search",
      "local-project",
      "coding-project",
      "multi-turn-project",
      "repo-file-edit",
      "repo-multi-file-edit",
      "report-site",
      "complex-project",
    ];

    function fakeRealTaskCoverageRoadmapReport(profileOverrides = {}) {
      const profileNames = ["core", "agentic", "extended", "all"];
      const profiles = profileNames.map((profile) => ({
        profile,
        taskCount: profile === "core" ? 4 : 2,
        artifactProofRequiredCount: 1,
        artifactProofCompleteCount: 1,
        missingArtifactProofTasks: [],
        profileArtifactProofComplete: true,
        resultProofRequiredCount: profile === "core" ? 4 : 2,
        resultProofCompleteCount: profile === "core" ? 4 : 2,
        missingResultProofTasks: [],
        profileResultProofComplete: true,
        refreshCommand: `node scripts/test-anticodex-desktop-task-suite.mjs --suite-profile ${profile} --allow-real-traffic`,
        ...(profileOverrides[profile] || {}),
      }));
      return {
        ok: true,
        reportName: "real-task-coverage-roadmap",
        requestedRealTraffic: false,
        usedRealTraffic: false,
        behaviorCovered: true,
        coverageKind: "real-task-coverage-roadmap-report-only",
        requiredProfiles: profileNames,
        profiles,
        taskModes: fakeRoadmapTaskModes,
        uniqueRefreshTasks: ["web-search"],
        completeProfiles: ["core", "agentic"],
        nextProfilesNeedingRealTraffic: ["extended"],
        taskArtifactProofs: fakeRoadmapTaskModes.slice(0, 5).map((taskMode) => ({
          taskMode,
          artifactProofComplete: true,
          artifactProofCount: 1,
          missingArtifactProofKeys: [],
        })),
        missingArtifactProofTasks: [],
        missingArtifactProofTaskCount: 0,
        taskResultProofs: fakeRoadmapTaskModes.map((taskMode) => ({
          taskMode,
          resultProofComplete: true,
          resultProofCount: 1,
          missingResultProofKeys: [],
        })),
        missingResultProofTasks: [],
        missingResultProofTaskCount: 0,
        approvalRequiredForRefresh: true,
        minimalRefreshCommandRequiresRealTraffic: true,
        minimalRefreshCommand: "node scripts/test-anticodex-desktop-task-suite.mjs --tasks web-search --allow-real-traffic",
        minimalRefreshCommandArgs: ["node", "scripts/test-anticodex-desktop-task-suite.mjs", "--tasks", "web-search", "--allow-real-traffic"],
        refreshApprovalSummary: {
          requiresExplicitUserApproval: true,
          approvalReason: "explicit_user_approval_required_for_desktop_task_refresh",
          taskCount: 1,
          refreshTaskModes: ["web-search"],
          nextProfilesNeedingRealTraffic: ["extended"],
        },
        realTrafficApprovalReason: "Some roadmap refreshes require explicit approved real traffic.",
        recommendedNoTrafficNextStep: "Keep no-traffic gates green while waiting for approval.",
        failures: [],
      };
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
      noTraffic: false,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      exists: true,
      logsTable: true,
      levelColumn: true,
      triggerPresent: false,
      protected: false,
      walBytes: -1,
    });

    writeFakeLatestReport("latest-plugin-capabilities.json", {
      ok: true,
      reportName: "plugin-capabilities",
      shortBudgetMode: true,
      capabilities: {
        nativeCodexWriteback: true,
        capabilityState: "degraded_short_budget",
        accessibleConnectorCount: 1,
        unauthorizedAppToolCount: 1,
        appToolGetPostParity: {
          checked: false,
          contentMatches: false,
          missingFromGet: ["unsafe-tool"],
          extraFromGet: [],
        },
        connectorParity: {
          checked: false,
          missingShared: ["missing-connector"],
          extraLocal: ["extra-connector"],
          changedShared: ["changed-connector"],
        },
        appToolParity: {
          checked: false,
          missingShared: ["missing-app-tool"],
          extraLocal: ["extra-app-tool"],
          changedShared: ["changed-app-tool"],
        },
        smoke: { checked: false },
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
        health: {
          mode: "antigravity",
          modelTextTransport: "cli",
          modelDiscoverySource: "antigravity-coworker",
          antigravityCoworkerDefault: true,
        },
        checks: {
          branding: { ok: false },
          skippedWithoutMetadata: { ok: true, skipped: true },
          managerVerifierBusy: { ok: true, skipped: true, reason: "Manager/UI verifier lock is already held; rerun installed overall serially", coveredBy: "serial rerun", coverageKind: "manager-verifier-lock-busy" },
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
        changedShared: ["changed-mcp"],
        hasNodeRepl: false,
        smoke: {
          passed: false,
          realCall: { passed: false },
        },
      },
      skills: {
        count: 2,
        sharedCount: 1,
        agentsCount: 0,
        expectedSharedCount: 1,
        missingShared: ["missing-skill"],
        extraLocal: ["extra-skill"],
        changedShared: ["changed-skill"],
        conflictingDuplicateNames: ["dupe-skill"],
        smoke: { readable: false },
      },
      appTools: {
        registry: {
          exists: true,
          contentMatches: false,
          sharedFingerprint: "shared-fingerprint",
          localFingerprint: "local-fingerprint",
          sharedFileCount: 36,
          localFileCount: 35,
        },
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

    writeFakeLatestReport("latest-ambient-suggestions.json", {
      ok: true,
      reportName: "wrong-ambient-suggestions",
      noTraffic: false,
      usedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "real-traffic",
      failures: ["ambient job found"],
      nameScans: {
        codexHome: { entries: [{ path: "ambient-task.json", allowed: false }] },
        installRoot: { entries: [] },
      },
      sqliteChecks: [
        { tableHits: ["ambient_suggestions"], columnHits: [], targetHits: [] },
      ],
      chromiumOnDeviceHeadSuggestModel: {},
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
        antigravityCliIsolationProfile: { ok: false },
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

    writeFakeLatestReport("latest-account-proxy-readiness.json", {
      ok: true,
      diagnosisDetail: "",
      suggestedAction: "",
      localProxyBypassed: false,
      phaseSummary: {
        accountOk: false,
        refreshOk: false,
        modelCount: 0,
        realRequestAttempted: false,
        realRequestOk: false,
      },
      antigravityLogSignals: {
        sourcePresent: false,
        tailLinesScanned: null,
      },
    });

    writeFakeLatestReport("latest-post-verification.json", {
      ok: true,
      reportName: "post-verification",
      usedRealTraffic: true,
      state: "verification_failed",
      failures: ["installed overall failed"],
      wait: { ready: false },
      overall: { ok: false, usedRealTraffic: false, releaseReady: false },
    });

    writeFakeLatestReport("latest-codex-responses.json", {
      ok: true,
      reportName: "codex-responses",
      usedRealTraffic: true,
      marker: "CODEX_RESPONSES_MARKER",
      completed: false,
      final_text: "missing marker and English only",
      failures: [],
    });

    writeFakeLatestReport("latest-ui-chat-smoke.json", {
      ok: true,
      reportName: "wrong-ui-chat-smoke",
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: false,
      coverageKind: "real-traffic",
      failures: ["still thinking"],
      marker: "UI_CHAT_SMOKE_MARKER",
      markerCount: 1,
      clicked: false,
      composerCleared: false,
      activeReconnectSeen: true,
      lastSample: "no assistant reply",
      antigravitySessionLock: { active: true, queued: 1 },
    });

    const invalidUiTaskReport = (reportName, taskMode, marker = "UI_TASK_MARKER") => ({
      ok: true,
      reportName: `wrong-${reportName}`,
      taskMode: `wrong-${taskMode}`,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: false,
      coverageKind: "real-traffic",
      failures: ["still thinking"],
      marker,
      answerMarkerCount: 0,
      clicked: false,
      composerCleared: false,
      activeReconnectSeen: true,
      sessionLockClear: false,
      lastSample: "no final desktop answer",
      antigravitySessionLock: { active: true, queued: 1 },
      artifactEvidence: { files: {}, doneExact: false },
    });
    writeFakeLatestReport("latest-ui-web-search-smoke.json", invalidUiTaskReport("ui-web-search-smoke", "web-search", "UI_WEB_SEARCH_MARKER"));
    writeFakeLatestReport("latest-ui-local-project-smoke.json", invalidUiTaskReport("ui-local-project-smoke", "local-project", "UI_LOCAL_PROJECT_MARKER"));
    writeFakeLatestReport("latest-ui-coding-project-smoke.json", invalidUiTaskReport("ui-coding-project-smoke", "coding-project", "UI_CODING_PROJECT_MARKER"));
    writeFakeLatestReport("latest-ui-multi-turn-project-smoke.json", invalidUiTaskReport("ui-multi-turn-project-smoke", "multi-turn-project", "UI_MULTI_TURN_PROJECT_MARKER"));
    writeFakeLatestReport("latest-ui-repo-file-edit-smoke.json", invalidUiTaskReport("ui-repo-file-edit-smoke", "repo-file-edit", "UI_REPO_FILE_EDIT_MARKER"));
    writeFakeLatestReport("latest-ui-repo-multi-file-edit-smoke.json", invalidUiTaskReport("ui-repo-multi-file-edit-smoke", "repo-multi-file-edit", "UI_REPO_MULTI_FILE_EDIT_MARKER"));
    writeFakeLatestReport("latest-ui-complex-project-smoke.json", invalidUiTaskReport("ui-complex-project-smoke", "complex-project", "UI_COMPLEX_PROJECT_MARKER"));
    writeFakeLatestReport("latest-ui-report-site-smoke.json", invalidUiTaskReport("ui-report-site-smoke", "report-site", "UI_REPORT_SITE_MARKER"));

    writeFakeLatestReport("latest-tool-loop.json", {
      ok: true,
      call_id: "",
      final_text: "plain English without the marker value",
    });

    writeFakeLatestReport("latest-native-tool-loop.json", {
      ok: true,
      call_id: "pseudo_123",
      native_call_id: false,
      arguments: { marker: "WRONG_NATIVE_MARKER" },
      final_text: "missing native result",
    });

    writeFakeLatestReport("latest-native-multi-tool-loop.json", {
      ok: true,
      first_call: { name: "marker_tool", call_id: "pseudo_1" },
      second_call: { name: "echo_tool", call_id: "" },
      native_call_ids: false,
      final_text: "missing echo and result",
    });

    writeFakeLatestReport("latest-mcp-tool-loop.json", {
      ok: true,
      call_id: "",
      tool: {
        emittedName: "wrong",
        expectedFlattenedName: "mcp__node_repl__js",
        code: "nodeRepl.write('wrong=0')",
        realMcp: { ok: false, markerObserved: false, toolCount: 0, output: "" },
      },
      final_text: "missing MCP marker",
    });

    writeFakeLatestReport("latest-custom-tool-loop.json", {
      ok: true,
      call_id: "",
      tool: {
        type: "function_call",
        name: "wrong_tool",
        inputPreserved: false,
        marker: "CUSTOM_PATCH_519",
      },
      final_text: "missing custom marker",
    });

    writeFakeLatestReport("latest-web-tools.json", {
      ok: true,
      reportName: "web-tools",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      finalText: "fetched something with <tool_calls>",
    });

    writeFakeLatestReport("latest-compaction-resume.json", {
      ok: true,
      reportName: "compaction-resume",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      seed: "COMPACT_SEED_BAD",
      first_response_id: "",
      compact_response_id: "",
      compact_summary_length: 0,
      compact_summary_preview: "",
      direct_resume_text: "",
      chained_resume_text: "",
    });

    writeFakeLatestReport("latest-cancellation.json", {
      ok: true,
      reportName: "cancellation",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      model: "",
      mode: "",
      responseId: "",
      cancelStatus: "cancelled",
      cancelError: "late cancel",
      hasCancelled: false,
      hasCompleted: true,
      hasFailed: true,
      eventNames: ["response.created", "response.completed"],
      providerReady: false,
      preHealthReady: false,
      postHealthReady: false,
    });

    writeFakeLatestReport("latest-real-mini-tool.json", {
      ok: true,
      reportName: "real-mini-tool",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      first_response_id: "",
      call_id: "",
      artifact: { exists: false, ran: false, markerMatched: false },
      executor: { tool: "wrong", realFileWrite: false },
      final_text: "CLI failed",
    });

    writeFakeLatestReport("latest-real-work.json", {
      ok: true,
      reportName: "real-work",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      first_response_id: "",
      call_id: "",
      artifact: { exists: false, ran: false, markerMatched: false },
      executor: { tool: "wrong", realFileWrite: false, realMcp: { ok: false, markerObserved: false } },
      final_text: "FILE failed",
    });

    writeFakeLatestReport("latest-real-small-project.json", {
      ok: true,
      reportName: "real-small-project",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic-small-project",
      first_response_id: "",
      call_id: "",
      artifact: {
        files: ["package.json"],
        testPassed: false,
        cliPassed: false,
        markerMatched: false,
      },
      final_text: "SMALL_PROJECT failed",
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

    writeFakeLatestReport("latest-antigravity-cli-windows-user-readiness.json", {
      ok: true,
      reportName: "wrong-windows-user-readiness",
      noTraffic: false,
      usedRealTraffic: true,
      requestedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "wrong",
      failures: ["should not be ignored"],
      windowsUser: ".\\XD",
      started: true,
      capturesLoginOutput: true,
      credentialBoundary: "profile-and-appdata-only",
      expectedCredentialStoreIsolation: false,
      readinessChecked: false,
      normalizedTargetWindowsUser: "",
      currentWindowsUser: "",
      currentWindowsUserSid: "",
      targetWindowsUserSid: "",
      targetUserSidMatchesCurrentUser: true,
      targetUserIdentityBoundaryOk: false,
      targetUserIsCurrentUser: true,
      readyForInteractiveLogin: false,
      readinessBlockingReason: "",
      recommendedOperatorAction: "run_interactive_login_with_explicit_user_approval",
      requiresUserAction: false,
      requiresRealTrafficForNextProof: false,
      separateAccountVerified: true,
      loginVerified: true,
      accountIsolationCaveat: "",
    });

    writeFakeLatestReport("latest-windows-user-account-prepare.json", {
      ok: true,
      reportName: "wrong-windows-user-account-prepare",
      noTraffic: false,
      usedRealTraffic: true,
      requestedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "wrong",
      failures: ["should not be ignored"],
      windowsUser: ".\\XD",
      changedSystem: true,
      createdUser: true,
      startedLogin: true,
      capturesPassword: true,
      storesPassword: true,
      targetUserIsCurrentUser: true,
      currentWindowsUserSid: "",
      targetWindowsUserSid: "",
      targetUserSidMatchesCurrentUser: true,
      targetUserIdentityBoundaryOk: false,
      readyForInteractiveLogin: false,
      readinessBlockingReason: "",
      recommendedOperatorAction: "run_interactive_login_with_explicit_user_approval",
      safeToAskUserForSecondAccountLogin: true,
      canProceedToInteractiveLogin: false,
      blockedBeforeInteractiveLogin: true,
      setupActionRequired: true,
      operatorBlockingStage: "",
      operatorNextStep: "",
      requiresUserPresence: false,
      nextProofRequiresRealTraffic: false,
      separateAccountVerified: true,
      loginVerified: true,
    });

    writeFakeLatestReport("latest-windows-user-setup-guidance.json", {
      ok: true,
      reportName: "wrong-windows-user-setup-guidance",
      noTraffic: false,
      usedRealTraffic: true,
      requestedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "wrong",
      failures: ["should not be ignored"],
      guidanceSource: "wrong",
      changedSystem: true,
      createdUser: true,
      startedLogin: true,
      capturesPassword: true,
      storesPassword: true,
      opensSettings: true,
      runsSystemUserCommand: true,
      currentWindowsUserSid: "",
      targetWindowsUserSid: "",
      targetUserSidMatchesCurrentUser: true,
      targetUserIdentityBoundaryOk: false,
      safeToAskUserForSecondAccountLogin: true,
      blockedBeforeInteractiveLogin: true,
      operatorBlockingStage: "",
      operatorNextStep: "",
      manualSetupCommandHint: "",
      requiresUserPresence: false,
      nextProofRequiresRealTraffic: false,
      separateAccountVerified: true,
      loginVerified: true,
      releaseAcceptableAccountProof: true,
      accountIsolationCaveat: "",
    });

    writeFakeLatestReport("latest-antigravity-account-isolation-status.json", {
      ok: true,
      reportName: "wrong-account-isolation-status",
      noTraffic: false,
      usedRealTraffic: true,
      requestedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "wrong",
      failures: ["should not be ignored"],
      accountLaneRole: "wrong",
      antiCodexLaneRole: "wrong",
      mcpLaneRole: "wrong",
      mcpAccountLaneManagedByAntiCodex: true,
      mcpAccountLaneOwner: "",
      antiCodexModelTextLanePrepared: false,
      mcpExternalLanePrepared: false,
      fileIsolationPrepared: false,
      credentialBoundary: "profile-and-appdata-only",
      expectedCredentialStoreIsolation: false,
      targetUserIsCurrentUser: true,
      currentWindowsUserSid: "",
      targetWindowsUserSid: "",
      targetUserSidMatchesCurrentUser: true,
      targetUserIdentityBoundaryOk: false,
      readyForInteractiveLogin: false,
      readinessBlockingReason: "",
      safeToAskUserForSecondAccountLogin: true,
      canProceedToInteractiveLogin: false,
      blockedBeforeInteractiveLogin: true,
      operatorBlockingStage: "",
      operatorNextStep: "",
      nextProofRequiresRealTraffic: false,
      separateAccountVerified: true,
      loginVerified: true,
      releaseAcceptableAccountProof: true,
      accountIsolationCaveat: "",
    });

    writeFakeLatestReport("latest-second-antigravity-account-login-entrypoint.json", {
      ok: true,
      reportName: "wrong-second-account-entrypoint",
      noTraffic: false,
      usedRealTraffic: true,
      requestedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "wrong",
      failures: ["should not be ignored"],
      statusOnlyOk: false,
      missingApprovalBlocked: false,
      approvedStartBlockedByStatusGate: false,
      sameWindowsUserTargetBlocked: false,
      sameWindowsUserTargetBlockingReason: "target_windows_user_missing",
      sameWindowsUserTargetStartedLogin: true,
      sameWindowsUserTargetSafetyFieldsOk: false,
      requestedStartLogin: true,
      startedLogin: true,
      changedSystem: true,
      createdUser: true,
      capturesLoginOutput: true,
      capturesPassword: true,
      storesPassword: true,
      safeToStartLogin: false,
      requiredStartLoginApproval: "",
      approvedLoginCommandTemplate: "",
      nextNoTrafficStatusCommand: "",
      postLoginProofCommandTemplate: "",
      canRunPostLoginProof: null,
      postLoginProofPlan: {
        proofScript: "wrong",
        accountIsolationBoundary: "profile-and-appdata-only",
        requiresApprovedRealTraffic: false,
        requiresDistinctAccountIdentityComparison: false,
        accountIdsMustDiffer: false,
        mcpAccountLaneManagedByAntiCodex: true,
      },
      completionState: "ready_for_interactive_login",
      readinessBlockingReason: "",
      operatorBlockingStage: "",
      operatorNextStep: "",
      separateAccountVerified: true,
      loginVerified: true,
      releaseAcceptableAccountProof: true,
      accountIsolationCaveat: "",
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
      "installed_overall_model_text_transport_not_desktop_cascade",
      "installed_overall_model_discovery_source_not_allowed",
      "installed_overall_antigravity_coworker_default_not_false",
      "installed_overall_check_not_ok",
      "installed_overall_skip_metadata_missing",
      "installed_overall_manager_verifier_lock_busy",
      "installed_overall_real_traffic_skip_missing",
    ]);
    semanticFailures.installedOverallNoTraffic = assertSemanticFailures("installedOverallNoTraffic", "self-test failed: semantically invalid installed-overall report satisfied the gate", [
      "installed_overall_report_name",
      "installed_overall_fast_flag",
      "installed_overall_no_traffic_flag",
      "installed_overall_used_real_traffic",
      "installed_overall_coverage_kind",
      "installed_overall_behavior_not_covered",
      "installed_overall_model_text_transport_not_desktop_cascade",
      "installed_overall_model_discovery_source_not_allowed",
      "installed_overall_antigravity_coworker_default_not_false",
      "installed_overall_check_not_ok",
      "installed_overall_skip_metadata_missing",
      "installed_overall_manager_verifier_lock_busy",
      "installed_overall_unexpected_skipped_check",
      "installed_overall_real_traffic_skip_missing",
    ]);
    semanticFailures.noTraffic = assertSemanticFailures("toolBridgeMode", "self-test failed: semantically invalid no-traffic report satisfied the gate", [
      "expected_no_real_traffic",
      "expected_behavior_covered",
      "expected_no_real_traffic_coverage_kind",
      "tool_bridge_not_model_only_or_explicit_native",
      "tool_bridge_transport_invalid",
      "tool_bridge_owned_tools_enabled",
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
    writeFakeLatestReport("latest-real-task-coverage-roadmap.json", fakeRealTaskCoverageRoadmapReport({
      core: {
        resultProofRequiredCount: 4,
        resultProofCompleteCount: 3,
        missingResultProofTasks: ["free-chat"],
        profileResultProofComplete: false,
      },
    }));
    semanticFailures.realTaskCoverageRoadmapProfileProofs = assertSemanticFailures("realTaskCoverageRoadmap", "self-test failed: roadmap profile-level result proof rollup weakness satisfied the gate", [
      "real_task_coverage_roadmap_core_result_profile_incomplete",
      "real_task_coverage_roadmap_core_result_profile_missing_tasks",
    ]);
    writeFakeLatestReport("latest-native-codex-parity-task-matrix.json", {
      ok: true,
      reportName: "wrong-native-codex-parity-task-matrix",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "real-traffic",
      nativeCodexParityComplete: true,
      realTrafficStillRequired: true,
      parityGroupIds: ["conversation"],
      taskModes: ["coding-project"],
      toolTaskModes: [],
      pendingRefreshTaskModes: [],
      pendingRealTaskScenarios: [],
      minimalRefreshCommandArgs: [],
      codexOwnedTools: false,
      antigravityModelTextOnly: false,
      failures: ["fake"],
    });
    semanticFailures.nativeCodexParityTaskMatrix = assertSemanticFailures("nativeCodexParityTaskMatrix", "self-test failed: semantically invalid native Codex parity task matrix satisfied the gate", [
      "native_codex_parity_task_matrix_report_name",
      "native_codex_parity_task_matrix_real_traffic_requested",
      "native_codex_parity_task_matrix_used_real_traffic",
      "native_codex_parity_task_matrix_behavior_not_covered",
      "native_codex_parity_task_matrix_coverage_kind",
      "native_codex_parity_task_matrix_research_group_missing",
      "native_codex_parity_task_matrix_tool_loop_missing",
      "native_codex_parity_task_matrix_pending_task_modes_missing",
      "native_codex_parity_task_matrix_web_search_scenario_missing",
      "native_codex_parity_task_matrix_free_chat_scenario_missing",
      "native_codex_parity_task_matrix_minimal_refresh_command_args_missing",
      "native_codex_parity_task_matrix_codex_tools_missing",
      "native_codex_parity_task_matrix_model_text_boundary_missing",
      "native_codex_parity_task_matrix_failures",
    ]);
    writeFakeLatestReport("latest-goal-real-run-readiness.json", {
      ok: true,
      reportName: "wrong-goal-real-run-readiness",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "real-traffic",
      readyForUserApprovedRealRun: true,
      safeToAskUserForSecondAccountLogin: false,
      accountReadinessBlockingReason: "",
      separateAccountVerified: true,
      releaseAcceptableAccountProof: true,
      realTaskRefreshNeeded: true,
      uniqueRefreshTasks: ["coding-project"],
      pendingRealTaskScenarios: [],
      missingTaskScenarios: ["web-search", "free-chat"],
      realTaskRefreshCommandPresent: false,
      requiredReleaseGateIds: ["postVerification"],
      requiredActionIds: ["postVerification"],
      requiredCommandCount: 0,
      requiredRealTrafficBlockedGates: ["postVerification"],
      releaseShortReady: false,
      releaseReady: true,
      releaseBlockedOnlyByRequiredRealTraffic: false,
      blockingStages: [],
      operatorNextAction: "",
      failures: ["fake"],
    });
    semanticFailures.goalRealRunReadiness = assertSemanticFailures("goalRealRunReadiness", "self-test failed: semantically invalid goal-real-run-readiness report satisfied the gate", [
      "goal_real_run_readiness_report_name",
      "goal_real_run_readiness_real_traffic_requested",
      "goal_real_run_readiness_used_real_traffic",
      "goal_real_run_readiness_behavior_not_covered",
      "goal_real_run_readiness_coverage_kind",
      "goal_real_run_readiness_unexpectedly_ready",
      "goal_real_run_readiness_account_blocking_reason_missing",
      "goal_real_run_readiness_separate_account_claimed",
      "goal_real_run_readiness_release_account_proof_claimed",
      "goal_real_run_readiness_web_search_task_missing",
      "goal_real_run_readiness_free_chat_task_missing",
      "goal_real_run_readiness_missing_task_scenarios",
      "goal_real_run_readiness_refresh_command_missing",
      "goal_real_run_readiness_real_task_refresh_stage_missing",
      "goal_real_run_readiness_accountProxyReadiness_gate_missing",
      "goal_real_run_readiness_accountProxyReadiness_action_missing",
      "goal_real_run_readiness_accountProxyReadiness_blocked_gate_missing",
      "goal_real_run_readiness_commands_missing",
      "goal_real_run_readiness_short_not_ready",
      "goal_real_run_readiness_second_account_login_not_ready_missing",
      "goal_real_run_readiness_operator_next_action_missing",
      "goal_real_run_readiness_failures",
    ]);
    writeFakeLatestReport("latest-approved-real-run-sequence.json", {
      ok: true,
      reportName: "wrong-approved-real-run-sequence",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "real-traffic",
      executionBlockedBeforeRealTraffic: false,
      readyToRequestUserApproval: true,
      sequenceStageCount: 2,
      explicitApprovalStageCount: 0,
      realTrafficStageCount: 0,
      startsLoginStageCount: 0,
      requiredRealTaskModes: ["coding-project"],
      pendingRealTaskScenarios: [],
      requiredReleaseGateIds: ["postVerification"],
      requiredActionIds: ["postVerification"],
      optionalActionIds: ["postVerification"],
      optionalActionsSeparated: false,
      requiredRealTrafficBlockedGates: ["postVerification"],
      releaseShortReady: false,
      releaseReady: true,
      accountReadinessBlockingReason: "",
      safeToAskUserForSecondAccountLogin: true,
      releaseAcceptableAccountProof: true,
      noTrafficPrechecks: [{ id: "bad", requiresRealTraffic: true, startsLogin: true }],
      approvedRealRunSequence: [{ id: "bad", startsLogin: true, requiresExplicitUserApproval: false, requiresRealTraffic: true }],
      operatorNextAction: "",
      failures: ["fake"],
    });
    semanticFailures.approvedRealRunSequence = assertSemanticFailures("approvedRealRunSequence", "self-test failed: semantically invalid approved-real-run-sequence report satisfied the gate", [
      "approved_real_run_sequence_report_name",
      "approved_real_run_sequence_real_traffic_requested",
      "approved_real_run_sequence_used_real_traffic",
      "approved_real_run_sequence_behavior_not_covered",
      "approved_real_run_sequence_coverage_kind",
      "approved_real_run_sequence_ready_state_inconsistent",
      "approved_real_run_sequence_stage_count",
      "approved_real_run_sequence_real_stage_count",
      "approved_real_run_sequence_login_stage_count",
      "approved_real_run_sequence_web_search_task_missing",
      "approved_real_run_sequence_free_chat_task_missing",
      "approved_real_run_sequence_accountProxyReadiness_gate_missing",
      "approved_real_run_sequence_accountProxyReadiness_action_missing",
      "approved_real_run_sequence_accountProxyReadiness_blocked_gate_missing",
      "approved_real_run_sequence_optional_actions_mixed",
      "approved_real_run_sequence_short_not_ready",
      "approved_real_run_sequence_operator_next_action_missing",
      "approved_real_run_sequence_precheck_count",
      "approved_real_run_sequence_precheck_started_traffic_or_login",
      "approved_real_run_sequence_real_stage_without_approval",
      "approved_real_run_sequence_login_stage_contract",
      "approved_real_run_sequence_failures",
    ]);
    semanticFailures.ambientSuggestions = assertSemanticFailures("ambientSuggestions", "self-test failed: semantically invalid ambient-suggestions report satisfied the gate", [
      "expected_no_real_traffic",
      "expected_behavior_covered",
      "expected_no_real_traffic_coverage_kind",
      "ambient_suggestions_report_name",
      "ambient_suggestions_no_traffic",
      "ambient_suggestions_used_real_traffic",
      "ambient_suggestions_behavior_not_covered",
      "ambient_suggestions_coverage_kind",
      "ambient_suggestions_failures",
      "ambient_suggestions_sqlite_sources",
      "ambient_suggestions_unallowed_name",
      "ambient_suggestions_chromium_probe_missing",
    ]);
    semanticFailures.antigravityCliWindowsUserReadiness = assertSemanticFailures("antigravityCliWindowsUserReadiness", "self-test failed: semantically invalid Windows-user readiness report satisfied the gate", [
      "windows_user_readiness_report_name",
      "windows_user_readiness_no_traffic",
      "windows_user_readiness_used_real_traffic",
      "windows_user_readiness_requested_real_traffic",
      "windows_user_readiness_behavior_not_covered",
      "windows_user_readiness_coverage_kind",
      "windows_user_readiness_failures",
      "windows_user_readiness_started_login",
      "windows_user_readiness_captures_login_output",
      "windows_user_readiness_credential_boundary",
      "windows_user_readiness_expected_credential_isolation",
      "windows_user_readiness_not_checked",
      "windows_user_readiness_target_user_missing",
      "windows_user_readiness_current_user_missing",
      "windows_user_readiness_target_is_current_user",
      "windows_user_readiness_target_sid_matches_current_user",
      "windows_user_readiness_blocking_reason_missing",
      "windows_user_readiness_requires_user_action_missing",
      "windows_user_readiness_next_proof_real_traffic_missing",
      "windows_user_readiness_separate_account_verified",
      "windows_user_readiness_login_verified",
      "windows_user_readiness_caveat_missing",
    ]);
    semanticFailures.windowsUserAccountPrepare = assertSemanticFailures("windowsUserAccountPrepare", "self-test failed: semantically invalid Windows-user account-prepare report satisfied the gate", [
      "windows_user_prepare_report_name",
      "windows_user_prepare_no_traffic",
      "windows_user_prepare_used_real_traffic",
      "windows_user_prepare_requested_real_traffic",
      "windows_user_prepare_behavior_not_covered",
      "windows_user_prepare_coverage_kind",
      "windows_user_prepare_failures",
      "windows_user_prepare_changed_system",
      "windows_user_prepare_created_user",
      "windows_user_prepare_started_login",
      "windows_user_prepare_captures_password",
      "windows_user_prepare_stores_password",
      "windows_user_prepare_target_is_current_user",
      "windows_user_prepare_target_sid_matches_current_user",
      "windows_user_prepare_blocking_reason_missing",
      "windows_user_prepare_can_proceed_mismatch",
      "windows_user_prepare_blocked_before_login_mismatch",
      "windows_user_prepare_setup_action_mismatch",
      "windows_user_prepare_operator_stage_missing",
      "windows_user_prepare_operator_next_step_missing",
      "windows_user_prepare_user_presence_missing",
      "windows_user_prepare_next_proof_real_traffic_missing",
      "windows_user_prepare_separate_account_verified",
      "windows_user_prepare_login_verified",
    ]);
    semanticFailures.windowsUserSetupGuidance = assertSemanticFailures("windowsUserSetupGuidance", "self-test failed: semantically invalid Windows-user setup-guidance report satisfied the gate", [
      "windows_user_setup_guidance_report_name",
      "windows_user_setup_guidance_no_traffic",
      "windows_user_setup_guidance_used_real_traffic",
      "windows_user_setup_guidance_requested_real_traffic",
      "windows_user_setup_guidance_behavior_not_covered",
      "windows_user_setup_guidance_coverage_kind",
      "windows_user_setup_guidance_failures",
      "windows_user_setup_guidance_source",
      "windows_user_setup_guidance_changed_system",
      "windows_user_setup_guidance_created_user",
      "windows_user_setup_guidance_started_login",
      "windows_user_setup_guidance_captures_password",
      "windows_user_setup_guidance_stores_password",
      "windows_user_setup_guidance_opens_settings",
      "windows_user_setup_guidance_runs_system_user_command",
      "windows_user_setup_guidance_target_sid_matches_current_user",
      "windows_user_setup_guidance_blocked_before_login_mismatch",
      "windows_user_setup_guidance_operator_stage_missing",
      "windows_user_setup_guidance_operator_next_step_missing",
      "windows_user_setup_guidance_manual_hint_missing",
      "windows_user_setup_guidance_sequence_mismatch",
      "windows_user_setup_guidance_checklist_missing",
      "windows_user_setup_guidance_checklist_order_mismatch",
      "windows_user_setup_guidance_setup_plan_missing",
      "windows_user_setup_guidance_user_presence_missing",
      "windows_user_setup_guidance_next_proof_real_traffic_missing",
      "windows_user_setup_guidance_separate_account_verified",
      "windows_user_setup_guidance_login_verified",
      "windows_user_setup_guidance_release_proof_claimed",
      "windows_user_setup_guidance_caveat_missing",
    ]);
    semanticFailures.antigravityAccountIsolationStatus = assertSemanticFailures("antigravityAccountIsolationStatus", "self-test failed: semantically invalid Antigravity account-isolation status report satisfied the gate", [
      "account_isolation_status_report_name",
      "account_isolation_status_no_traffic",
      "account_isolation_status_used_real_traffic",
      "account_isolation_status_requested_real_traffic",
      "account_isolation_status_behavior_not_covered",
      "account_isolation_status_coverage_kind",
      "account_isolation_status_failures",
      "account_isolation_status_account_lane_role",
      "account_isolation_status_anticodex_lane_role",
      "account_isolation_status_mcp_lane_role",
      "account_isolation_status_mcp_lane_managed_by_anticodex",
      "account_isolation_status_mcp_lane_owner",
      "account_isolation_status_anticodex_lane_not_prepared",
      "account_isolation_status_mcp_lane_not_prepared",
      "account_isolation_status_file_isolation_not_prepared",
      "account_isolation_status_credential_boundary",
      "account_isolation_status_expected_credential_isolation",
      "account_isolation_status_target_is_current_user",
      "account_isolation_status_target_sid_matches_current_user",
      "account_isolation_status_blocking_reason_missing",
      "account_isolation_status_can_proceed_mismatch",
      "account_isolation_status_blocked_before_login_mismatch",
      "account_isolation_status_operator_stage_missing",
      "account_isolation_status_operator_next_step_missing",
      "account_isolation_status_next_proof_real_traffic_missing",
      "account_isolation_status_final_proof_plan_missing",
      "account_isolation_status_final_proof_requires_credential_boundary",
      "account_isolation_status_final_proof_requires_interactive_login",
      "account_isolation_status_final_proof_requires_real_traffic",
      "account_isolation_status_final_proof_requires_distinct_identity",
      "account_isolation_status_final_proof_account_ids_must_differ",
      "account_isolation_status_post_login_proof_plan_missing",
      "account_isolation_status_post_login_proof_script",
      "account_isolation_status_post_login_proof_command_missing",
      "account_isolation_status_post_login_proof_approval_switch_missing",
      "account_isolation_status_post_login_proof_approval_id_missing",
      "account_isolation_status_post_login_proof_wrong_boundary",
      "account_isolation_status_post_login_proof_requires_login",
      "account_isolation_status_post_login_proof_requires_real_traffic",
      "account_isolation_status_post_login_proof_requires_approval",
      "account_isolation_status_post_login_proof_requires_identity",
      "account_isolation_status_post_login_proof_identity_inputs",
      "account_isolation_status_post_login_proof_account_ids_must_differ",
      "account_isolation_status_post_login_proof_mcp_managed_here",
      "account_isolation_status_post_login_proof_mcp_owner",
      "account_isolation_status_separate_account_verified",
      "account_isolation_status_login_verified",
      "account_isolation_status_release_proof_claimed",
      "account_isolation_status_caveat_missing",
    ]);
    semanticFailures.secondAccountLoginEntrypoint = assertSemanticFailures("secondAccountLoginEntrypoint", "self-test failed: semantically invalid second-account login entrypoint report satisfied the gate", [
      "second_account_entrypoint_report_name",
      "second_account_entrypoint_no_traffic",
      "second_account_entrypoint_used_real_traffic",
      "second_account_entrypoint_requested_real_traffic",
      "second_account_entrypoint_behavior_not_covered",
      "second_account_entrypoint_coverage_kind",
      "second_account_entrypoint_failures",
      "second_account_entrypoint_status_only_not_ok",
      "second_account_entrypoint_missing_approval_not_blocked",
      "second_account_entrypoint_status_gate_not_enforced",
      "second_account_entrypoint_same_windows_user_not_blocked",
      "second_account_entrypoint_same_windows_user_reason",
      "second_account_entrypoint_same_windows_user_started_login",
      "second_account_entrypoint_same_windows_user_safety_fields",
      "second_account_entrypoint_requested_start_login",
      "second_account_entrypoint_started_login",
      "second_account_entrypoint_changed_system",
      "second_account_entrypoint_created_user",
      "second_account_entrypoint_captures_login_output",
      "second_account_entrypoint_captures_password",
      "second_account_entrypoint_stores_password",
      "second_account_entrypoint_approval_token",
      "second_account_entrypoint_blocking_reason_missing",
      "second_account_entrypoint_operator_stage_missing",
      "second_account_entrypoint_operator_next_step_missing",
      "second_account_entrypoint_separate_account_verified",
      "second_account_entrypoint_login_verified",
      "second_account_entrypoint_release_proof_claimed",
      "second_account_entrypoint_caveat_missing",
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
      "sync_readiness_client_sync_contract",
      "sync_readiness_client_sync_source_match",
      "sync_readiness_client_sync_version_mismatch",
      "sync_readiness_client_patch_scope:branding",
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
    writeFakeLatestReport("20260624-000000-sync-readiness.json", {
      ok: true,
      reportName: "sync-readiness",
      fast: false,
      skipIconPaletteProbe: false,
      noTraffic: true,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "installed-no-traffic",
      clientSyncContract: {
        mode: "codex-client-copy-plus-anticodex-patches",
        maintenancePath: "guarded-host-sync-then-reapply-anticodex-patches",
        nativeClientBehaviorCarriedByHostSync: true,
        forbidsFeatureByFeatureReimplementation: true,
        sourcePackageName: "OpenAI.Codex",
        sourcePackageVersion: "26.623.5546.0",
        activeSourcePackageName: "OpenAI.Codex",
        activeSourcePackageVersion: "26.623.5546.0",
        sourceHostHashMatches: true,
        sourceCliHashMatches: true,
        antiCodexPatchScope: ["branding", "icons", "shortcuts", "isolation", "launcher", "model-adapter"],
      },
      activeHost: {
        exists: true,
        markerExists: true,
        manifestValid: true,
        exeExists: true,
        productName: "Anti-Codex",
        fileDescription: "Anti-Codex",
        originalFilename: "Anti-Codex.exe",
        hostIconExists: true,
        trayIconExists: true,
        appRootIconExists: true,
        hostIconPalette: { ok: true },
        trayIconPalette: { ok: true },
        appRootIconPalette: { ok: true },
        sourcePackageName: "OpenAI.Codex",
        sourcePackageVersion: "26.623.5546.0",
      },
      sync: {
        scriptExists: true,
        launcherExists: true,
        rollbackScriptExists: true,
        rollbackLauncherExists: true,
        updateCheckExists: true,
        validatorExists: true,
        failureSafetyVerifierExists: true,
        installerExists: true,
        startScriptExists: true,
        desktopShortcutIconPalette: { ok: true },
        updateStatus: {
          ok: true,
          updateNeeded: false,
          drift: { state: "synced" },
          source: { packageName: "OpenAI.Codex", packageVersion: "26.623.5546.0", hostHash: "host", cliHash: "cli" },
          active: { packageName: "OpenAI.Codex", packageVersion: "26.623.5546.0", hostHash: "host", cliHash: "cli" },
          operation: { state: "succeeded" },
          guardrails: { brandPreserved: true, iconPreserved: true, activeHostValid: true, failures: [] },
        },
        shortcutVerification: Array.from({ length: 5 }, () => ({
          ok: true,
          exists: true,
          displayNameMatches: true,
          targetMatches: true,
          launcherTargetMatches: true,
          scriptMatches: true,
          iconMatches: true,
          forbiddenCodexBranding: false,
        })),
        startMenuMainShortcutExists: true,
        startMenuSyncShortcutExists: true,
        startMenuRollbackShortcutExists: true,
        startMenuManagerShortcutExists: true,
        desktopMainShortcutExists: true,
        desktopAntiCodexShortcuts: ["Anti-Codex.lnk"],
        forbiddenDesktopHelperShortcuts: [],
        managerBridge: {
          expectedBaseUrl: "http://127.0.0.1:8484",
          processCount: 1,
          staleProcessCount: 0,
          processes: [{ hasExpectedBaseUrl: true }],
        },
        rollbackHostExists: true,
        rollbackMarkerExists: true,
        rollbackHost: {
          exists: true,
          markerExists: true,
          manifestValid: true,
          exeExists: true,
          productName: "Anti-Codex",
          fileDescription: "Anti-Codex",
          originalFilename: "Anti-Codex.exe",
          hostIconPalette: { ok: true },
          trayIconPalette: { ok: true },
          appRootIconPalette: { ok: true },
        },
        rollbackSwapHostExists: false,
        rollbackSwapMarkerExists: false,
        hostSyncMarkerExists: false,
        staleCandidateExists: false,
      },
    });
    const syncReadinessFallbackGate = summarizeGate(gateDefinitions.find((definition) => definition.id === "syncReadiness"));
    if (syncReadinessFallbackGate.satisfied !== true || syncReadinessFallbackGate.selectedFromHistory !== true) {
      throw new Error("self-test failed: sync-readiness did not use the latest full history report when latest is fast/invalid");
    }
    if (syncReadinessFallbackGate.selectedKind !== "history") throw new Error("self-test failed: history fallback selectedKind was not preserved");
    if (syncReadinessFallbackGate.selectedFile !== "20260624-000000-sync-readiness.json") throw new Error("self-test failed: history fallback selectedFile was not preserved");
    if (!syncReadinessFallbackGate.selectedMtime) throw new Error("self-test failed: history fallback selectedMtime was not preserved");
    const syncReadinessHistorySourceDriftLatest = loadSignedJson(join(tempRoot, "20260624-000000-sync-readiness.json"));
    syncReadinessHistorySourceDriftLatest.fast = true;
    syncReadinessHistorySourceDriftLatest.skipIconPaletteProbe = true;
    syncReadinessHistorySourceDriftLatest.clientSyncContract.sourcePackageVersion = "26.999.0000.0";
    syncReadinessHistorySourceDriftLatest.sync.updateStatus.source.packageVersion = "26.999.0000.0";
    syncReadinessHistorySourceDriftLatest.sync.updateStatus.source.hostHash = "new-host";
    syncReadinessHistorySourceDriftLatest.sync.updateStatus.source.cliHash = "new-cli";
    writeFakeLatestReport("latest-sync-readiness.json", syncReadinessHistorySourceDriftLatest);
    const syncReadinessHistorySourceDriftGate = summarizeGate(gateDefinitions.find((definition) => definition.id === "syncReadiness"));
    if (syncReadinessHistorySourceDriftGate.satisfied === true || !syncReadinessHistorySourceDriftGate.semanticFailures?.includes("sync_readiness_history_source_mismatch")) {
      throw new Error("self-test failed: stale sync-readiness history source satisfied the gate");
    }
    const syncReadinessVersionDriftReport = loadSignedJson(join(tempRoot, "20260624-000000-sync-readiness.json"));
    syncReadinessVersionDriftReport.clientSyncContract.activeSourcePackageVersion = "26.999.0000.0";
    writeFakeLatestReport("latest-sync-readiness.json", syncReadinessVersionDriftReport);
    const syncReadinessVersionDriftGate = summarizeGate(gateDefinitions.find((definition) => definition.id === "syncReadiness"));
    if (syncReadinessVersionDriftGate.satisfied === true || !syncReadinessVersionDriftGate.semanticFailures?.includes("sync_readiness_client_sync_version_mismatch")) {
      throw new Error("self-test failed: sync-readiness clientSyncContract version drift satisfied the gate");
    }
    const syncReadinessPatchScopeDriftReport = loadSignedJson(join(tempRoot, "20260624-000000-sync-readiness.json"));
    syncReadinessPatchScopeDriftReport.clientSyncContract.antiCodexPatchScope = [...allowedAntiCodexPatchScope, "feature-rebuild"];
    writeFakeLatestReport("latest-sync-readiness.json", syncReadinessPatchScopeDriftReport);
    const syncReadinessPatchScopeDriftGate = summarizeGate(gateDefinitions.find((definition) => definition.id === "syncReadiness"));
    if (syncReadinessPatchScopeDriftGate.satisfied === true || !syncReadinessPatchScopeDriftGate.semanticFailures?.includes("sync_readiness_client_patch_scope_extra")) {
      throw new Error("self-test failed: sync-readiness extra Anti-Codex patch scope satisfied the gate");
    }
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
    semanticFailures.accountProxyReadiness = assertSemanticFailures("accountProxyReadiness", "self-test failed: semantically invalid account-proxy report satisfied the gate", [
      "account_proxy_diagnosis_detail_missing",
      "account_proxy_suggested_action_missing",
      "account_proxy_local_proxy_not_bypassed",
      "account_proxy_account_not_ok",
      "account_proxy_refresh_not_ok",
      "account_proxy_model_count",
      "account_proxy_real_request_not_attempted",
      "account_proxy_real_request_not_ok",
      "account_proxy_real_request_attempt_count",
      "account_proxy_log_source_missing",
      "account_proxy_log_scan_missing",
    ]);
    semanticFailures.postVerification = assertSemanticFailures("postVerification", "self-test failed: semantically invalid post-verification report satisfied the gate", [
      "post_verification_state_not_completed",
      "post_verification_failures",
      "post_verification_wait_not_ready",
      "post_verification_overall_not_ok",
      "post_verification_overall_real_traffic_missing",
      "post_verification_overall_not_release_ready",
    ]);
    semanticFailures.codexResponses = assertSemanticFailures("codexResponses", "self-test failed: semantically invalid codex-responses report satisfied the gate", [
      "codex_responses_not_completed",
      "codex_responses_marker_missing",
      "codex_responses_chinese_missing",
    ]);
    semanticFailures.uiChatSmoke = assertSemanticFailures("uiChatSmoke", "self-test failed: semantically invalid ui-chat-smoke report satisfied the gate", [
      "ui_chat_smoke_report_name",
      "ui_chat_smoke_real_traffic_not_requested",
      "ui_chat_smoke_real_traffic_missing",
      "ui_chat_smoke_behavior_not_covered",
      "ui_chat_smoke_coverage_kind",
      "ui_chat_smoke_failures",
      "ui_chat_smoke_marker_missing",
      "ui_chat_smoke_not_sent",
      "ui_chat_smoke_composer_not_cleared",
      "ui_chat_smoke_active_reconnect_seen",
      "ui_chat_smoke_session_lock_not_clear",
    ]);
    semanticFailures.uiWebSearchSmoke = assertSemanticFailures("uiWebSearchSmoke", "self-test failed: semantically invalid ui-web-search-smoke report satisfied the gate", [
      "ui_web_search_smoke_report_name",
      "ui_web_search_smoke_task_mode",
      "ui_web_search_smoke_real_traffic_not_requested",
      "ui_web_search_smoke_real_traffic_missing",
      "ui_web_search_smoke_behavior_not_covered",
      "ui_web_search_smoke_coverage_kind",
      "ui_web_search_smoke_failures",
      "ui_web_search_smoke_marker_missing",
      "ui_web_search_smoke_not_sent",
      "ui_web_search_smoke_composer_not_cleared",
      "ui_web_search_smoke_active_reconnect_seen",
      "ui_web_search_smoke_session_lock_not_clear",
      "ui_web_search_smoke_source_urls_missing",
    ]);
    semanticFailures.uiLocalProjectSmoke = assertSemanticFailures("uiLocalProjectSmoke", "self-test failed: semantically invalid ui-local-project-smoke report satisfied the gate", [
      "ui_local_project_smoke_report_name",
      "ui_local_project_smoke_task_mode",
      "ui_local_project_smoke_real_traffic_not_requested",
      "ui_local_project_smoke_real_traffic_missing",
      "ui_local_project_smoke_behavior_not_covered",
      "ui_local_project_smoke_coverage_kind",
      "ui_local_project_smoke_failures",
      "ui_local_project_smoke_marker_missing",
      "ui_local_project_smoke_not_sent",
      "ui_local_project_smoke_composer_not_cleared",
      "ui_local_project_smoke_active_reconnect_seen",
      "ui_local_project_smoke_session_lock_not_clear",
      "ui_local_project_smoke_indexHtml_missing",
      "ui_local_project_smoke_readmeMd_missing",
      "ui_local_project_smoke_doneTxt_missing",
      "ui_local_project_smoke_done_marker_mismatch",
    ]);
    semanticFailures.uiCodingProjectSmoke = assertSemanticFailures("uiCodingProjectSmoke", "self-test failed: semantically invalid ui-coding-project-smoke report satisfied the gate", [
      "ui_coding_project_smoke_report_name",
      "ui_coding_project_smoke_task_mode",
      "ui_coding_project_smoke_real_traffic_not_requested",
      "ui_coding_project_smoke_real_traffic_missing",
      "ui_coding_project_smoke_behavior_not_covered",
      "ui_coding_project_smoke_coverage_kind",
      "ui_coding_project_smoke_failures",
      "ui_coding_project_smoke_prompt_language",
      "ui_coding_project_smoke_marker_missing",
      "ui_coding_project_smoke_not_sent",
      "ui_coding_project_smoke_composer_not_cleared",
      "ui_coding_project_smoke_active_reconnect_seen",
      "ui_coding_project_smoke_session_lock_not_clear",
      "ui_coding_project_smoke_packageJson_missing",
      "ui_coding_project_smoke_wordTally_missing",
      "ui_coding_project_smoke_testFile_missing",
      "ui_coding_project_smoke_doneTxt_missing",
      "ui_coding_project_smoke_done_marker_mismatch",
      "ui_coding_project_smoke_export_missing",
      "ui_coding_project_smoke_tests_not_passed",
      "ui_coding_project_smoke_cli_not_passed",
    ]);
    semanticFailures.uiMultiTurnProjectSmoke = assertSemanticFailures("uiMultiTurnProjectSmoke", "self-test failed: semantically invalid ui-multi-turn-project-smoke report satisfied the gate", [
      "ui_multi_turn_project_smoke_report_name",
      "ui_multi_turn_project_smoke_task_mode",
      "ui_multi_turn_project_smoke_real_traffic_not_requested",
      "ui_multi_turn_project_smoke_real_traffic_missing",
      "ui_multi_turn_project_smoke_behavior_not_covered",
      "ui_multi_turn_project_smoke_coverage_kind",
      "ui_multi_turn_project_smoke_failures",
      "ui_multi_turn_project_smoke_prompt_language",
      "ui_multi_turn_project_smoke_followup_prompt_language",
      "ui_multi_turn_project_smoke_marker_missing",
      "ui_multi_turn_project_smoke_not_sent",
      "ui_multi_turn_project_smoke_composer_not_cleared",
      "ui_multi_turn_project_smoke_active_reconnect_seen",
      "ui_multi_turn_project_smoke_session_lock_not_clear",
      "ui_multi_turn_project_smoke_packageJson_missing",
      "ui_multi_turn_project_smoke_wordTally_missing",
      "ui_multi_turn_project_smoke_testFile_missing",
      "ui_multi_turn_project_smoke_doneTxt_missing",
      "ui_multi_turn_project_smoke_followupTxt_missing",
      "ui_multi_turn_project_smoke_changelogMd_missing",
      "ui_multi_turn_project_smoke_first_done_marker_mismatch",
      "ui_multi_turn_project_smoke_followup_marker_mismatch",
      "ui_multi_turn_project_smoke_changelog_marker_missing",
      "ui_multi_turn_project_smoke_tally_export_missing",
      "ui_multi_turn_project_smoke_unique_export_missing",
      "ui_multi_turn_project_smoke_tests_not_passed",
      "ui_multi_turn_project_smoke_cli_not_passed",
      "ui_multi_turn_project_smoke_turns_missing",
    ]);
    semanticFailures.uiRepoFileEditSmoke = assertSemanticFailures("uiRepoFileEditSmoke", "self-test failed: semantically invalid ui-repo-file-edit-smoke report satisfied the gate", [
      "ui_repo_file_edit_smoke_report_name",
      "ui_repo_file_edit_smoke_task_mode",
      "ui_repo_file_edit_smoke_real_traffic_not_requested",
      "ui_repo_file_edit_smoke_real_traffic_missing",
      "ui_repo_file_edit_smoke_behavior_not_covered",
      "ui_repo_file_edit_smoke_coverage_kind",
      "ui_repo_file_edit_smoke_failures",
      "ui_repo_file_edit_smoke_not_sent",
      "ui_repo_file_edit_smoke_composer_not_cleared",
      "ui_repo_file_edit_smoke_active_reconnect_seen",
      "ui_repo_file_edit_smoke_session_lock_not_clear",
      "ui_repo_file_edit_smoke_target_missing",
      "ui_repo_file_edit_smoke_test_missing",
      "ui_repo_file_edit_smoke_tests_not_passed",
      "ui_repo_file_edit_smoke_lowercase_missing",
      "ui_repo_file_edit_smoke_invalid_char_handling_missing",
      "ui_repo_file_edit_smoke_hyphen_trim_missing",
    ]);
    semanticFailures.uiRepoMultiFileEditSmoke = assertSemanticFailures("uiRepoMultiFileEditSmoke", "self-test failed: semantically invalid ui-repo-multi-file-edit-smoke report satisfied the gate", [
      "ui_repo_multi_file_edit_smoke_report_name",
      "ui_repo_multi_file_edit_smoke_task_mode",
      "ui_repo_multi_file_edit_smoke_real_traffic_not_requested",
      "ui_repo_multi_file_edit_smoke_real_traffic_missing",
      "ui_repo_multi_file_edit_smoke_behavior_not_covered",
      "ui_repo_multi_file_edit_smoke_coverage_kind",
      "ui_repo_multi_file_edit_smoke_failures",
      "ui_repo_multi_file_edit_smoke_not_sent",
      "ui_repo_multi_file_edit_smoke_composer_not_cleared",
      "ui_repo_multi_file_edit_smoke_active_reconnect_seen",
      "ui_repo_multi_file_edit_smoke_session_lock_not_clear",
      "ui_repo_multi_file_edit_smoke_source_missing",
      "ui_repo_multi_file_edit_smoke_test_missing",
      "ui_repo_multi_file_edit_smoke_data_missing",
      "ui_repo_multi_file_edit_smoke_readme_missing",
      "ui_repo_multi_file_edit_smoke_html_missing",
      "ui_repo_multi_file_edit_smoke_normalize_export_missing",
      "ui_repo_multi_file_edit_smoke_summary_export_missing",
      "ui_repo_multi_file_edit_smoke_html_export_missing",
      "ui_repo_multi_file_edit_smoke_source_unchanged",
      "ui_repo_multi_file_edit_smoke_test_modified",
      "ui_repo_multi_file_edit_smoke_data_modified",
      "ui_repo_multi_file_edit_smoke_tests_not_passed",
      "ui_repo_multi_file_edit_smoke_cli_not_passed",
      "ui_repo_multi_file_edit_smoke_html_not_complete",
      "ui_repo_multi_file_edit_smoke_html_chinese_missing",
      "ui_repo_multi_file_edit_smoke_html_statuses_missing",
      "ui_repo_multi_file_edit_smoke_html_object_leak",
      "ui_repo_multi_file_edit_smoke_readme_chinese_missing",
      "ui_repo_multi_file_edit_smoke_readme_command_missing",
      "ui_repo_multi_file_edit_smoke_first_turn_settle_missing",
      "ui_repo_multi_file_edit_smoke_final_turn_settle_missing",
    ]);
    writeFakeLatestReport("latest-ui-repo-multi-file-edit-smoke.json", {
      ok: true,
      reportName: "ui-repo-multi-file-edit-smoke",
      taskMode: "repo-multi-file-edit",
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "desktop-ui-real-traffic",
      failures: [],
      clicked: true,
      composerCleared: true,
      activeReconnectSeen: false,
      sessionLockClear: true,
      antigravitySessionLock: { active: false, queued: 0 },
      artifactEvidence: {
        files: { source: true, test: true, data: true, readme: true, html: true },
        exportsNormalizeStatus: true,
        exportsSummarizeRecords: true,
        exportsRenderSummaryHtml: true,
        sourceChangedFromFixture: true,
        testUnchanged: true,
        dataUnchanged: true,
        testPassed: true,
        cliPassed: true,
        htmlComplete: true,
        htmlHasChinese: true,
        htmlMentionsStatuses: true,
        htmlAvoidsObjectObject: true,
        readmeHasChinese: true,
        readmeMentionsCommand: true,
      },
    });
    semanticFailures.uiRepoMultiFileEditSmokeMissingSettle = assertSemanticFailures("uiRepoMultiFileEditSmoke", "self-test failed: repo-multi report without settle evidence satisfied the gate", [
      "ui_repo_multi_file_edit_smoke_first_turn_settle_missing",
      "ui_repo_multi_file_edit_smoke_final_turn_settle_missing",
    ]);
    semanticFailures.uiComplexProjectSmoke = assertSemanticFailures("uiComplexProjectSmoke", "self-test failed: semantically invalid ui-complex-project-smoke report satisfied the gate", [
      "ui_complex_project_smoke_report_name",
      "ui_complex_project_smoke_task_mode",
      "ui_complex_project_smoke_real_traffic_not_requested",
      "ui_complex_project_smoke_real_traffic_missing",
      "ui_complex_project_smoke_behavior_not_covered",
      "ui_complex_project_smoke_coverage_kind",
      "ui_complex_project_smoke_failures",
      "ui_complex_project_smoke_marker_missing",
      "ui_complex_project_smoke_not_sent",
      "ui_complex_project_smoke_composer_not_cleared",
      "ui_complex_project_smoke_active_reconnect_seen",
      "ui_complex_project_smoke_session_lock_not_clear",
      "ui_complex_project_smoke_packageJson_missing",
      "ui_complex_project_smoke_analyzer_missing",
      "ui_complex_project_smoke_testFile_missing",
      "ui_complex_project_smoke_sourcesJson_missing",
      "ui_complex_project_smoke_reportMd_missing",
      "ui_complex_project_smoke_indexHtml_missing",
      "ui_complex_project_smoke_doneTxt_missing",
      "ui_complex_project_smoke_done_marker_mismatch",
      "ui_complex_project_smoke_source_json_urls_missing",
      "ui_complex_project_smoke_export_missing",
      "ui_complex_project_smoke_tests_not_passed",
      "ui_complex_project_smoke_cli_not_passed",
      "ui_complex_project_smoke_report_chinese_missing",
      "ui_complex_project_smoke_html_chinese_missing",
      "ui_complex_project_smoke_report_codex_missing",
      "ui_complex_project_smoke_html_codex_missing",
      "ui_complex_project_smoke_report_urls_missing",
      "ui_complex_project_smoke_html_urls_missing",
      "ui_complex_project_smoke_shared_urls_missing",
      "ui_complex_project_smoke_html_not_complete",
      "ui_complex_project_smoke_html_report_link_missing",
    ]);
    semanticFailures.uiReportSiteSmoke = assertSemanticFailures("uiReportSiteSmoke", "self-test failed: semantically invalid ui-report-site-smoke report satisfied the gate", [
      "ui_report_site_smoke_report_name",
      "ui_report_site_smoke_task_mode",
      "ui_report_site_smoke_real_traffic_not_requested",
      "ui_report_site_smoke_real_traffic_missing",
      "ui_report_site_smoke_behavior_not_covered",
      "ui_report_site_smoke_coverage_kind",
      "ui_report_site_smoke_failures",
      "ui_report_site_smoke_marker_missing",
      "ui_report_site_smoke_not_sent",
      "ui_report_site_smoke_composer_not_cleared",
      "ui_report_site_smoke_active_reconnect_seen",
      "ui_report_site_smoke_session_lock_not_clear",
      "ui_report_site_smoke_reportMd_missing",
      "ui_report_site_smoke_indexHtml_missing",
      "ui_report_site_smoke_doneTxt_missing",
      "ui_report_site_smoke_done_marker_mismatch",
      "ui_report_site_smoke_report_chinese_missing",
      "ui_report_site_smoke_html_chinese_missing",
      "ui_report_site_smoke_report_codex_missing",
      "ui_report_site_smoke_html_codex_missing",
      "ui_report_site_smoke_report_urls_missing",
      "ui_report_site_smoke_html_urls_missing",
      "ui_report_site_smoke_shared_urls_missing",
      "ui_report_site_smoke_html_not_complete",
      "ui_report_site_smoke_html_report_link_missing",
    ]);
    semanticFailures.optionalRealTraffic = assertSemanticFailures("realThirdPartyProviderOptional", "self-test failed: semantically invalid optional real-traffic report satisfied the gate", [
      "optional_skipped_requested_real_traffic_not_false",
      "optional_skipped_metadata_missing",
      "optional_requested_real_traffic_uncovered_but_ok",
    ]);
    writeFakeLatestReport("latest-real-third-party-provider.json", {
      ok: true,
      reportName: "real-third-party-provider",
      skipped: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: false,
      coverageKind: "skipped",
      reason: "real third-party provider verification is opt-in",
      coveredBy: "test-anticodex-real-third-party-provider.mjs",
    });
    semanticFailures.optionalRealProviderSkipped = assertSemanticFailures("realThirdPartyProviderOptional", "self-test failed: skipped optional real-provider report satisfied real-traffic evidence", [
      "optional_real_traffic_not_requested",
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
    writeFakeLatestReport("latest-antigravity-cli-real-smoke.json", {
      ok: true,
      reportName: "wrong-antigravity-cli-smoke",
      skipped: false,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      behaviorCovered: false,
      coverageKind: "fake-coverage",
      loginVerified: false,
      profileRoot: process.env.USERPROFILE || "C:\\Users\\testuser",
      strictWindowsAppDataIsolation: false,
    });
    semanticFailures.antigravityCliRealSmokeMissingFields = assertSemanticFailures("antigravityCliRealSmokeOptional", "self-test failed: semantically invalid optional Antigravity CLI real-smoke report with missing fields satisfied the gate", [
      "optional_real_traffic_not_requested",
      "optional_real_traffic_not_used",
      "optional_real_traffic_behavior_not_covered",
      "optional_real_traffic_coverage_kind",
      "optional_antigravity_cli_real_smoke_report_name",
      "optional_antigravity_cli_real_smoke_login_not_verified",
      "optional_antigravity_cli_real_smoke_strict_isolation_missing",
      "optional_antigravity_cli_real_smoke_separate_account_verified_missing",
      "optional_antigravity_cli_real_smoke_isolation_boundary_missing",
      "optional_antigravity_cli_real_smoke_isolation_caveat_missing",
      "optional_antigravity_cli_real_smoke_account_lane_role",
      "optional_antigravity_cli_real_smoke_mcp_lane_managed_by_anticodex",
      "optional_antigravity_cli_real_smoke_mcp_lane_owner_mismatch",
    ]);
    writeFakeLatestReport("latest-antigravity-cli-real-smoke.json", {
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      skipped: false,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      loginVerified: true,
      profileRoot: "C:\\isolated-antigravity-cli",
      strictWindowsAppDataIsolation: true,
      separateAccountVerified: true,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Shared Windows credential store caveat.",
    });
    semanticFailures.antigravityCliRealSmokeSeparateTrueMissingEvidence = assertSemanticFailures("antigravityCliRealSmokeOptional", "self-test failed: optional Antigravity CLI real-smoke report with separateAccountVerified=true but missing identity evidence satisfied the gate", [
      "optional_antigravity_cli_real_smoke_separate_account_identity_evidence_missing",
      "optional_antigravity_cli_real_smoke_identity_comparison_missing",
    ]);
    writeFakeLatestReport("latest-antigravity-cli-real-smoke.json", {
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      skipped: false,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      loginVerified: true,
      profileRoot: "C:\\isolated-antigravity-cli",
      strictWindowsAppDataIsolation: true,
      separateAccountVerified: true,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIdentityEvidence: "two different accounts observed",
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Shared Windows credential store caveat.",
    });
    semanticFailures.antigravityCliRealSmokeSeparateTrueTextEvidenceOnly = assertSemanticFailures("antigravityCliRealSmokeOptional", "self-test failed: optional Antigravity CLI real-smoke report with text-only account evidence satisfied the gate", [
      "optional_antigravity_cli_real_smoke_identity_comparison_missing",
    ]);
    writeFakeLatestReport("latest-antigravity-cli-real-smoke.json", {
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      skipped: false,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      loginVerified: true,
      profileRoot: "C:\\isolated-antigravity-cli",
      strictWindowsAppDataIsolation: true,
      separateAccountVerified: true,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIdentityComparison: {
        antiCodexAccountId: "same-account",
        mcpAccountId: "same-account",
      },
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Shared Windows credential store caveat.",
    });
    semanticFailures.antigravityCliRealSmokeSeparateTrueSameAccount = assertSemanticFailures("antigravityCliRealSmokeOptional", "self-test failed: optional Antigravity CLI real-smoke report with matching account IDs satisfied the gate", [
      "optional_antigravity_cli_real_smoke_identity_accounts_match",
    ]);
    writeFakeLatestReport("latest-antigravity-cli-real-smoke.json", {
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      skipped: false,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      loginVerified: true,
      profileRoot: "C:\\isolated-antigravity-cli",
      strictWindowsAppDataIsolation: true,
      separateAccountVerified: true,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIdentityComparison: {
        antiCodexAccountId: "",
        mcpAccountId: "",
      },
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Shared Windows credential store caveat.",
    });
    semanticFailures.antigravityCliRealSmokeSeparateTrueMissingAccountIds = assertSemanticFailures("antigravityCliRealSmokeOptional", "self-test failed: optional Antigravity CLI real-smoke report with missing comparison account IDs satisfied the gate", [
      "optional_antigravity_cli_real_smoke_anticodex_account_id_missing",
      "optional_antigravity_cli_real_smoke_mcp_account_id_missing",
    ]);
    writeFakeLatestReport("latest-antigravity-cli-real-smoke.json", {
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      skipped: false,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      loginVerified: true,
      profileRoot: "C:\\isolated-antigravity-cli",
      strictWindowsAppDataIsolation: true,
      separateAccountVerified: true,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIdentityComparison: {
        antiCodexAccountId: "anticodex-account",
        mcpAccountId: "mcp-account",
      },
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Shared Windows credential store caveat.",
    });
    semanticFailures.antigravityCliRealSmokeSeparateTrueMissingComparisonContext = assertSemanticFailures("antigravityCliRealSmokeOptional", "self-test failed: optional Antigravity CLI real-smoke report with missing comparison context satisfied the gate", [
      "optional_antigravity_cli_real_smoke_anticodex_identity_source",
      "optional_antigravity_cli_real_smoke_mcp_identity_source",
      "optional_antigravity_cli_real_smoke_identity_comparison_method",
      "optional_antigravity_cli_real_smoke_identity_captured_at",
      "optional_antigravity_cli_real_smoke_identity_approval_id",
      "optional_antigravity_cli_real_smoke_identity_approval_source",
    ]);
    writeFakeLatestReport("latest-antigravity-cli-real-smoke.json", {
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      skipped: false,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      loginVerified: true,
      profileRoot: "C:\\isolated-antigravity-cli",
      strictWindowsAppDataIsolation: true,
      separateAccountVerified: true,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIdentityComparison: {
        antiCodexAccountId: "anticodex-account",
        mcpAccountId: "mcp-account",
        antiCodexSource: "anticodex-cli-real-smoke",
        mcpSource: "external-mcp-antigravity-account",
        comparisonMethod: "explicit-user-approved-account-identity-parameter",
        capturedAt: "2026-06-29T18:00:00.000Z",
      },
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Shared Windows credential store caveat.",
    });
    semanticFailures.antigravityCliRealSmokeSeparateTrueMissingApproval = assertSemanticFailures("antigravityCliRealSmokeOptional", "self-test failed: optional Antigravity CLI real-smoke report with missing approval context satisfied the gate", [
      "optional_antigravity_cli_real_smoke_identity_approval_id",
      "optional_antigravity_cli_real_smoke_identity_approval_source",
    ]);
    writeFakeLatestReport("latest-antigravity-cli-real-smoke.json", {
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      skipped: false,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      loginVerified: true,
      profileRoot: "C:\\isolated-antigravity-cli",
      strictWindowsAppDataIsolation: true,
      separateAccountVerified: true,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIdentityComparison: {
        antiCodexAccountId: "anticodex-account",
        mcpAccountId: "mcp-account",
        antiCodexSource: "anticodex-cli-real-smoke",
        mcpSource: "external-mcp-antigravity-account",
        comparisonMethod: "explicit-user-approved-account-identity-parameter",
        capturedAt: "2026-06-29T18:00:00.000Z",
        approvalId: "approval-2026-06-29",
        approvalSource: "explicit-user-approval",
      },
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Shared Windows credential store caveat.",
    });
    semanticFailures.antigravityCliRealSmokeSeparateTrueInsufficientCredentialBoundary = assertSemanticFailures("antigravityCliRealSmokeOptional", "self-test failed: optional Antigravity CLI real-smoke report with only profile/AppData isolation satisfied the gate", [
      "optional_antigravity_cli_real_smoke_credential_boundary_insufficient",
    ]);
    writeFakeLatestReport("latest-antigravity-cli-real-smoke.json", {
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      skipped: false,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      loginVerified: true,
      profileRoot: "C:\\isolated-antigravity-cli",
      strictWindowsAppDataIsolation: true,
      separateAccountVerified: true,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIdentityComparison: {
        antiCodexAccountId: "anticodex-account",
        mcpAccountId: "mcp-account",
        antiCodexSource: "anticodex-cli-real-smoke",
        mcpSource: "external-mcp-antigravity-account",
        comparisonMethod: "explicit-user-approved-account-identity-parameter",
        capturedAt: "2026-06-29T18:00:00.000Z",
        approvalId: "approval-2026-06-29",
        approvalSource: "explicit-user-approval",
      },
      accountIsolationBoundary: "separate-windows-user",
      accountIsolationCaveat: "Separate Windows user credential boundary.",
    });
    const antigravityCliRealSmokeValidComparisonGate = summarizeGate(gateDefinitions.find((definition) => definition.id === "antigravityCliRealSmokeOptional"));
    if (antigravityCliRealSmokeValidComparisonGate.satisfied !== true) {
      throw new Error("self-test failed: optional Antigravity CLI real-smoke report with full identity comparison context did not satisfy the gate");
    }
    writeFakeLatestReport("latest-antigravity-cli-real-smoke.json", {
      ok: true,
      reportName: "antigravity-cli-real-smoke",
      skipped: false,
      requestedRealTraffic: true,
      usedRealTraffic: true,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      loginVerified: true,
      profileRoot: "C:\\isolated-antigravity-cli",
      strictWindowsAppDataIsolation: true,
      separateAccountVerified: false,
      accountLaneRole: "anticodex-model-text",
      mcpAccountLaneManagedByAntiCodex: false,
      mcpAccountLaneOwner: "external-antigravity-account-not-managed-here",
      accountIdentityEvidence: "cli-profile-isolation-only",
      accountIsolationBoundary: "profile-and-appdata-only",
      accountIsolationCaveat: "Profile isolation only; not proof of a separate account.",
    });
    semanticFailures.antigravityCliRealSmokeFalseWithIdentityEvidence = assertSemanticFailures("antigravityCliRealSmokeOptional", "self-test failed: optional Antigravity CLI real-smoke report with separateAccountVerified=false but identity evidence present satisfied the gate", [
      "optional_antigravity_cli_real_smoke_identity_evidence_without_verification",
    ]);
    semanticFailures.mcpSkills = assertSemanticFailures("mcpSkills", "self-test failed: semantically invalid MCP/Skill report satisfied the gate", [
      "mcp_skills_missing_shared_mcp",
      "mcp_skills_extra_local_mcp",
      "mcp_skills_changed_shared_mcp",
      "mcp_skills_missing_node_repl",
      "mcp_skills_smoke_not_passed",
      "mcp_skills_real_call_not_passed",
      "mcp_skills_missing_worker_real_list",
      "mcp_skills_no_agents_skills",
      "mcp_skills_expected_shared_count",
      "mcp_skills_missing_shared_skills",
      "mcp_skills_extra_local_skills",
      "mcp_skills_conflicting_duplicate_skills",
      "mcp_skills_skill_smoke_not_readable",
      "mcp_skills_app_tool_registry_content_mismatch",
      "mcp_skills_app_tool_registry_fingerprint_mismatch",
      "mcp_skills_app_tool_registry_file_count_mismatch",
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
      "source_preflight_antigravity_cli_isolation_profile",
      "source_preflight_antigravity_cli_profile_prepare",
      "source_preflight_antigravity_cli_profile_prepare_rejects_default_child",
      "source_preflight_antigravity_cli_windows_user_login_dry_run",
      "source_preflight_local_connector_verifier",
      "source_preflight_public_documentation",
      "source_preflight_public_documentation_client_sync_contract",
      "source_preflight_translator_regression",
      "source_preflight_diff_whitespace",
    ]);
    writeFakeLatestReport("latest-source-preflight.json", {
      ok: true,
      reportName: "source-preflight",
      noTraffic: false,
      usedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "real-traffic",
      failures: [],
      checks: {
        javascriptSyntax: { ok: true },
        powershellSyntax: { ok: true },
        uiStateSelfTest: { ok: true },
        upstreamProfileStorage: { ok: true },
        antigravityCliIsolationProfile: { ok: true },
        localConnectorVerifier: { ok: true },
        publicDocumentation: {
          ok: true,
          assertions: [
            { file: "README.md", name: "client-copy-sync-contract", ok: true },
            { file: "README_EN.md", name: "client-copy-sync-contract", ok: true },
          ],
        },
        translatorRegression: { ok: true },
        diffWhitespace: { ok: true },
      },
    });
    semanticFailures.sourcePreflightNoTraffic = assertSemanticFailures("sourcePreflight", "self-test failed: source-preflight real-traffic attestation was not rejected", [
      "source_preflight_no_traffic",
      "source_preflight_used_real_traffic",
      "source_preflight_behavior_not_covered",
      "source_preflight_coverage_kind",
    ]);
    writeFakeLatestReport("latest-source-preflight.json", {
      ok: true,
      reportName: "source-preflight",
      noTraffic: true,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "source-no-traffic",
      antigravityCliProfilePrepareOk: true,
      failures: [],
      checks: {
        javascriptSyntax: { ok: true },
        powershellSyntax: { ok: true },
        uiStateSelfTest: { ok: true },
        upstreamProfileStorage: { ok: true },
        antigravityCliIsolationProfile: { ok: true },
        antigravityCliProfilePrepare: {
          ok: true,
          contract: {
            ok: true,
            usedRealTraffic: true,
            loginVerified: true,
            separateAccountVerified: true,
            coverageKind: "real-traffic",
            accountIsolationBoundary: "",
            accountIsolationCaveat: "",
          },
        },
        antigravityCliWindowsUserLoginDryRun: {
          ok: true,
          contract: {
            ok: true,
            noTraffic: false,
            usedRealTraffic: true,
            started: true,
            capturesLoginOutput: true,
            readinessChecked: false,
            normalizedTargetWindowsUser: "",
            currentWindowsUser: "",
            currentWindowsUserSid: "",
            targetWindowsUserSid: "",
            targetUserSidMatchesCurrentUser: true,
            targetUserIdentityBoundaryOk: false,
            targetUserIsCurrentUser: true,
            readyForInteractiveLogin: false,
            readinessBlockingReason: "",
            credentialBoundary: "profile-and-appdata-only",
            expectedCredentialStoreIsolation: false,
            runasWorkingDirectory: "",
            bootstrapKeepsShellOpen: true,
            accountIsolationCaveat: "",
          },
        },
        localConnectorVerifier: { ok: true },
        publicDocumentation: {
          ok: true,
          assertions: [
            { file: "README.md", name: "client-copy-sync-contract", ok: true },
            { file: "README_EN.md", name: "client-copy-sync-contract", ok: true },
          ],
        },
        translatorRegression: { ok: true },
        diffWhitespace: { ok: true },
      },
    });
    semanticFailures.sourcePreflightProfilePrepareContract = assertSemanticFailures("sourcePreflight", "self-test failed: semantically invalid profile-prepare contract was not rejected", [
      "source_preflight_profile_prepare_used_real_traffic",
      "source_preflight_profile_prepare_login_verified",
      "source_preflight_profile_prepare_separate_account_verified",
      "source_preflight_profile_prepare_account_lane_role",
      "source_preflight_profile_prepare_mcp_lane_managed_by_anticodex",
      "source_preflight_profile_prepare_mcp_lane_owner_mismatch",
      "source_preflight_profile_prepare_coverage_kind",
      "source_preflight_profile_prepare_isolation_boundary_missing",
      "source_preflight_profile_prepare_isolation_caveat_missing",
    ]);
    semanticFailures.sourcePreflightWindowsUserLoginContract = assertSemanticFailures("sourcePreflight", "self-test failed: semantically invalid Windows-user login dry-run contract was not rejected", [
      "source_preflight_windows_user_login_no_traffic",
      "source_preflight_windows_user_login_used_real_traffic",
      "source_preflight_windows_user_login_started",
      "source_preflight_windows_user_login_captures_output",
      "source_preflight_windows_user_login_readiness_not_checked",
      "source_preflight_windows_user_login_target_user_missing",
      "source_preflight_windows_user_login_current_user_missing",
      "source_preflight_windows_user_login_target_is_current_user",
      "source_preflight_windows_user_login_current_sid_missing",
      "source_preflight_windows_user_login_target_sid_matches_current_user",
      "source_preflight_windows_user_login_readiness_reason_missing",
      "source_preflight_windows_user_login_credential_boundary",
      "source_preflight_windows_user_login_expected_credential_isolation",
      "source_preflight_windows_user_login_runas_workdir_missing",
      "source_preflight_windows_user_login_bootstrap_keeps_shell",
      "source_preflight_windows_user_login_caveat_missing",
    ]);
    writeFakeLatestReport("latest-source-preflight.json", {
      ok: true,
      reportName: "source-preflight",
      noTraffic: true,
      usedRealTraffic: false,
      behaviorCovered: true,
      coverageKind: "source-no-traffic",
      antigravityCliProfilePrepareOk: true,
      antigravityCliWindowsUserLoginDryRunOk: true,
      failures: [],
      checks: {
        javascriptSyntax: { ok: true },
        powershellSyntax: { ok: true },
        uiStateSelfTest: { ok: true },
        upstreamProfileStorage: { ok: true },
        antigravityCliIsolationProfile: { ok: true },
        antigravityCliProfilePrepare: { ok: true },
        localConnectorVerifier: { ok: true },
        publicDocumentation: {
          ok: true,
          assertions: [
            { file: "README.md", name: "client-copy-sync-contract", ok: true },
            { file: "README_EN.md", name: "client-copy-sync-contract", ok: true },
          ],
        },
        translatorRegression: { ok: true },
        diffWhitespace: { ok: true },
      },
    });
    semanticFailures.sourcePreflightProfilePrepareContractMissing = assertSemanticFailures("sourcePreflight", "self-test failed: missing profile-prepare contract was not rejected", [
      "source_preflight_profile_prepare_contract_missing",
    ]);
    semanticFailures.toolLoop = assertSemanticFailures("toolLoop", "self-test failed: semantically invalid tool-loop report satisfied the gate", [
      "tool_loop_call_id_missing",
      "tool_loop_marker_missing",
      "tool_loop_value_missing",
    ]);
    semanticFailures.nativeToolLoop = assertSemanticFailures("nativeToolLoop", "self-test failed: semantically invalid native tool-loop report satisfied the gate", [
      "native_tool_loop_pseudo_call_id",
      "native_tool_loop_native_call_id_missing",
      "native_tool_loop_marker_argument_missing",
      "native_tool_loop_result_missing",
    ]);
    semanticFailures.nativeMultiToolLoop = assertSemanticFailures("nativeMultiToolLoop", "self-test failed: semantically invalid native multi-tool-loop report satisfied the gate", [
      "native_multi_tool_loop_first_call_missing",
      "native_multi_tool_loop_second_call_missing",
      "native_multi_tool_loop_native_call_ids_missing",
      "native_multi_tool_loop_marker_result_missing",
      "native_multi_tool_loop_echo_result_missing",
    ]);
    semanticFailures.mcpToolLoop = assertSemanticFailures("mcpToolLoop", "self-test failed: semantically invalid MCP tool-loop report satisfied the gate", [
      "mcp_tool_loop_call_id_missing",
      "mcp_tool_loop_expected_tool_missing",
      "mcp_tool_loop_real_mcp_missing",
      "mcp_tool_loop_marker_missing",
      "mcp_tool_loop_value_missing",
    ]);
    semanticFailures.customToolLoop = assertSemanticFailures("customToolLoop", "self-test failed: semantically invalid custom tool-loop report satisfied the gate", [
      "custom_tool_loop_call_id_missing",
      "custom_tool_loop_type_mismatch",
      "custom_tool_loop_name_mismatch",
      "custom_tool_loop_input_not_preserved",
      "custom_tool_loop_marker_missing",
    ]);
    semanticFailures.webTools = assertSemanticFailures("webTools", "self-test failed: semantically invalid web-tools report satisfied the gate", [
      "web_tools_evidence_missing",
      "web_tools_protocol_leak",
    ]);
    semanticFailures.compactionResume = assertSemanticFailures("compactionResume", "self-test failed: semantically invalid compaction-resume report satisfied the gate", [
      "compaction_resume_first_response_missing",
      "compaction_resume_compact_response_missing",
      "compaction_resume_summary_too_short",
      "compaction_resume_summary_seed_missing",
      "compaction_resume_direct_resume_missing",
      "compaction_resume_chained_resume_missing",
    ]);
    semanticFailures.cancellation = assertSemanticFailures("cancellation", "self-test failed: semantically invalid cancellation report satisfied the gate", [
      "cancellation_response_id_missing",
      "cancellation_error_present",
      "cancellation_cancelled_event_missing",
      "cancellation_completed_unexpected",
      "cancellation_failed_unexpected",
      "cancellation_event_names_missing",
      "cancellation_provider_not_ready",
      "cancellation_mode_missing",
      "cancellation_model_missing",
    ]);
    semanticFailures.realMiniTool = assertSemanticFailures("realMiniTool", "self-test failed: semantically invalid real-mini-tool report satisfied the gate", [
      "real_mini_tool_first_response_missing",
      "real_mini_tool_call_id_missing",
      "real_mini_tool_artifact_missing",
      "real_mini_tool_artifact_not_run",
      "real_mini_tool_marker_mismatch",
      "real_mini_tool_executor_mismatch",
      "real_mini_tool_file_write_missing",
      "real_mini_tool_final_confirmation_missing",
      "real_mini_tool_chinese_missing",
    ]);
    semanticFailures.realWork = assertSemanticFailures("realWork", "self-test failed: semantically invalid real-work report satisfied the gate", [
      "real_work_first_response_missing",
      "real_work_call_id_missing",
      "real_work_artifact_missing",
      "real_work_artifact_not_run",
      "real_work_marker_mismatch",
      "real_work_executor_mismatch",
      "real_work_file_write_missing",
      "real_work_mcp_missing",
      "real_work_final_confirmation_missing",
      "real_work_chinese_missing",
    ]);
    semanticFailures.realSmallProject = assertSemanticFailures("realSmallProject", "self-test failed: semantically invalid real-small-project report satisfied the gate", [
      "real_small_project_first_response_missing",
      "real_small_project_call_id_missing",
      "real_small_project_word-tally_mjs_missing",
      "real_small_project_tests_not_passed",
      "real_small_project_cli_not_passed",
      "real_small_project_marker_mismatch",
      "real_small_project_final_confirmation_missing",
      "real_small_project_chinese_missing",
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
      "log_db_guard_no_traffic",
      "log_db_guard_used_real_traffic",
      "log_db_guard_coverage_kind",
      "log_db_guard_trigger_missing",
      "log_db_guard_not_protected",
      "log_db_guard_wal_bytes_invalid",
    ]);
    semanticFailures.pluginCapabilities = assertSemanticFailures("pluginCapabilities", "self-test failed: semantically invalid plugin-capability report satisfied the gate", [
      "plugin_capabilities_short_budget_report",
      "plugin_capabilities_degraded",
      "plugin_capabilities_unchecked_parity",
      "plugin_capabilities_smoke_unchecked",
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
      "plugin_capabilities_source_snapshot_incomplete",
    ]);
    writeFakeLatestReport("latest-plugin-capabilities.json", {
      ok: true,
      reportName: "plugin-capabilities",
      capabilities: {
        nativeCodexWriteback: false,
        capabilityState: "ready",
        accessibleConnectorCount: 0,
        unauthorizedAppToolCount: 0,
        connectorParity: { checked: true, missingShared: [], extraLocal: [], changedShared: [] },
        appToolParity: { checked: true, missingShared: [], extraLocal: [], changedShared: [] },
        appToolGetPostParity: { checked: true, contentMatches: true, missingFromGet: [], extraFromGet: [] },
        smoke: { checked: true },
      },
      sourceSnapshot: { fingerprint: "partial-plugin-source", reusedFromPreviousReport: true },
    });
    semanticFailures.pluginCapabilitiesReusedSnapshot = assertSemanticFailures("pluginCapabilities", "self-test failed: reused or incomplete plugin-capability source snapshot satisfied the gate", [
      "plugin_capabilities_source_snapshot_incomplete",
      "plugin_capabilities_source_snapshot_reused",
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
        smoke: {
          passed: true,
          realCall: { passed: true },
          realList: REQUIRED_WORKER_MCP_SERVERS.map((server) => ({ server, passed: true, toolCount: 1 })),
        },
      },
      skills: {
        count: 2,
        sharedCount: 1,
        agentsCount: 1,
        expectedSharedCount: 2,
        missingShared: [],
        extraLocal: [],
        changedShared: [],
        conflictingDuplicateNames: [],
        smoke: { readable: true },
      },
      appTools: {
        registry: {
          exists: true,
          contentMatches: true,
          sharedFingerprint: "app-tool-registry",
          localFingerprint: "app-tool-registry",
          sharedFileCount: 2,
          localFileCount: 2,
        },
      },
      sourceSnapshot: { fingerprint: "stale-mcp-source", fileCount: 3, sourceMtimeMax: "2026-06-23T00:00:00.000Z" },
    });
    writeFakeLatestReport("latest-plugin-capabilities.json", {
      ok: true,
      capabilities: {
        nativeCodexWriteback: false,
        accessibleConnectorCount: 0,
        unauthorizedAppToolCount: 0,
        connectorParity: { checked: true, missingShared: [], extraLocal: [], changedShared: [] },
        appToolParity: { checked: true, missingShared: [], extraLocal: [], changedShared: [] },
        appToolGetPostParity: { checked: true, contentMatches: true, missingFromGet: [], extraFromGet: [] },
        smoke: { checked: true },
      },
      sourceSnapshot: { fingerprint: "stale-plugin-source", fileCount: 3, sourceMtimeMax: "2026-06-23T00:00:00.000Z" },
    });
    const crossSourceGates = gateDefinitions.map(summarizeGate);
    addSourceSnapshotMismatchFailures(crossSourceGates, (gateId, failure) => {
      const gate = crossSourceGates.find((item) => item.id === gateId);
      if (!gate) return;
      if (!Array.isArray(gate.semanticFailures)) gate.semanticFailures = [];
      if (!gate.semanticFailures.includes(failure)) gate.semanticFailures.push(failure);
    });
    semanticFailures.sourceSnapshotMismatch = {
      refreshFeatures: crossSourceGates.find((gate) => gate.id === "refreshFeatures")?.semanticFailures || [],
      mcpSkills: crossSourceGates.find((gate) => gate.id === "mcpSkills")?.semanticFailures || [],
      pluginCapabilities: crossSourceGates.find((gate) => gate.id === "pluginCapabilities")?.semanticFailures || [],
    };
    if (!semanticFailures.sourceSnapshotMismatch.refreshFeatures.includes("refresh_features_source_snapshot_mismatch")) throw new Error("self-test failed: refresh-features source snapshot mismatch was not detected");
    if (!semanticFailures.sourceSnapshotMismatch.mcpSkills.includes("mcp_skills_source_snapshot_mismatch")) throw new Error("self-test failed: MCP/Skill source snapshot mismatch was not detected");
    if (!semanticFailures.sourceSnapshotMismatch.pluginCapabilities.includes("plugin_capabilities_source_snapshot_mismatch")) throw new Error("self-test failed: plugin-capability source snapshot mismatch was not detected");
    writeFakeLatestReport("latest-plugin-capabilities.json", {
      ok: false,
      failures: ["gateway offline"],
      capabilities: {
        nativeCodexWriteback: false,
        accessibleConnectorCount: 0,
        unauthorizedAppToolCount: 0,
        connectorParity: { checked: false, missingShared: [], extraLocal: [], changedShared: [] },
        appToolParity: { checked: false, missingShared: [], extraLocal: [], changedShared: [] },
        appToolGetPostParity: { checked: false, contentMatches: false, missingFromGet: [], extraFromGet: [] },
        smoke: { checked: false },
      },
      sourceSnapshot: { fingerprint: "offline-plugin-source", fileCount: 3, sourceMtimeMax: "2026-06-23T00:00:00.000Z" },
    });
    const offlinePluginGates = gateDefinitions.map(summarizeGate);
    const offlineMcpGate = offlinePluginGates.find((gate) => gate.id === "mcpSkills");
    const offlinePluginGate = offlinePluginGates.find((gate) => gate.id === "pluginCapabilities");
    attachPluginOfflineSnapshotEvidence(offlinePluginGates);
    if (offlinePluginGate?.offlineSnapshotEvidence?.connectorContentMatches !== true || offlinePluginGate?.offlineSnapshotEvidence?.appToolContentMatches !== true || offlinePluginGate?.offlineSnapshotEvidence?.refreshGateSatisfied !== true) {
      throw new Error("self-test failed: plugin offline snapshot evidence was not attached from refresh-features");
    }
    addSourceSnapshotMismatchFailures(offlinePluginGates, (gateId, failure) => {
      const gate = offlinePluginGates.find((item) => item.id === gateId);
      if (!gate) return;
      if (!Array.isArray(gate.semanticFailures)) gate.semanticFailures = [];
      if (!gate.semanticFailures.includes(failure)) gate.semanticFailures.push(failure);
    });
    if ((offlineMcpGate.semanticFailures || []).includes("mcp_skills_source_snapshot_mismatch")) {
      throw new Error("self-test failed: unsatisfied plugin report should not add source snapshot mismatch to MCP/Skill gate");
    }
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
    const runtimeEvidence = installedRuntimeEvidenceFromGate(runtimeGate);
    if (!runtimeEvidence || runtimeEvidence.satisfied !== false || runtimeEvidence.sourceFileCount !== runtimeSyncFiles.length || runtimeEvidence.installedRuntimeFileCount !== runtimeSyncFiles.length || runtimeEvidence.mismatchedRuntimeFiles.length < 1) {
      throw new Error("self-test failed: installed runtime evidence was not surfaced from runtime gate");
    }

    const reasonGates = attachGateFailureReasons([
      ...gateDefinitions.map(summarizeGate),
      runtimeGate,
    ]);
    function assertFailureReason(gateId, expectedReason) {
      const gate = reasonGates.find((item) => item.id === gateId);
      if (!gate) throw new Error(`self-test failed: ${gateId} gate missing while checking failure reason`);
      if (!Array.isArray(gate.failureReasons) || !gate.failureReasons.includes(expectedReason)) {
        throw new Error(`self-test failed: ${gateId} missing failure reason ${expectedReason}`);
      }
      if (!gate.failureReason) throw new Error(`self-test failed: ${gateId} missing primary failureReason`);
    }
    for (const gate of reasonGates.filter((item) => !item.satisfied)) {
      if (!Array.isArray(gate.failureReasons) || gate.failureReasons.length === 0) {
        throw new Error(`self-test failed: ${gate.id} has no failureReasons`);
      }
      if (!gate.failureReason) throw new Error(`self-test failed: ${gate.id} has no failureReason`);
    }
    assertFailureReason("postVerification", "semantic_failures");
    assertFailureReason("fastOverallNoTraffic", "semantic_failures");
    assertFailureReason("installedRuntimeSync", "semantic_failures");
    const postVerificationGate = reasonGates.find((item) => item.id === "postVerification");
    if (!gateGuidance(postVerificationGate).includes("real_traffic_evidence_stale")) throw new Error("self-test failed: real-traffic stale guidance was not attached");
    if (gateGuidance(postVerificationGate).includes("local_gateway_required")) throw new Error("self-test failed: real-traffic guidance was misclassified as gateway-only");
    const managerRealButtonGate = reasonGates.find((item) => item.id === "managerRealButtons");
    if (!gateGuidance(managerRealButtonGate).includes("local_gateway_required")) throw new Error("self-test failed: gateway-dependent stale guidance was not attached");
    const stabilitySoakGate = reasonGates.find((item) => item.id === "stabilitySoak");
    if (!gateGuidance(stabilitySoakGate).includes("optional_stability_soak_required")) throw new Error("self-test failed: optional stability-soak guidance was not attached");
    const coldRelaunchGate = reasonGates.find((item) => item.id === "coldRelaunch");
    if (!gateGuidance(coldRelaunchGate).includes("optional_cold_relaunch_required")) throw new Error("self-test failed: optional cold-relaunch guidance was not attached");
    const optionalRealProviderGate = reasonGates.find((item) => item.id === "realThirdPartyProviderOptional");
    if (!gateGuidance(optionalRealProviderGate).includes("optional_real_provider_required")) throw new Error("self-test failed: optional real-provider guidance was not attached");
    const optionalAntigravityReturnGate = reasonGates.find((item) => item.id === "providerAntigravityReturnOptional");
    if (!gateGuidance(optionalAntigravityReturnGate).includes("optional_antigravity_return_required")) throw new Error("self-test failed: optional Antigravity-return guidance was not attached");
    const optionalRealProviderActions = gateOrderedActions(optionalRealProviderGate);
    if (!optionalRealProviderActions.some((item) => item.id === "realThirdPartyProviderOptional" && item.requiresRealTraffic === true && item.highImpact === true && item.blockedUntilExplicitUserApproval === true && item.command.includes("--api-key-env"))) throw new Error("self-test failed: optional real-provider action was not approval-blocked real traffic");
    const optionalAntigravityReturnActions = gateOrderedActions(optionalAntigravityReturnGate);
    if (!optionalAntigravityReturnActions.some((item) => item.id === "providerAntigravityReturnOptional" && item.requiresGatewayStart === true && item.requiresRealTraffic === true && item.highImpact === true && item.blockedUntilExplicitUserApproval === true)) throw new Error("self-test failed: optional Antigravity-return action was not approval-blocked real traffic");
    const syncReadinessActions = gateOrderedActions({
      id: "syncReadiness",
      satisfied: false,
      failureReasons: ["semantic_failures"],
      semanticFailures: ["sync_readiness_update_status", "sync_readiness_source_active_hash_mismatch", "sync_readiness_guardrails"],
      reportFailureSamples: ["Codex update status is not comparable: source_codex_changed", "installed Codex changed; Anti-Codex sync is required"],
    });
    if (!syncReadinessActions.some((item) => item.id === "syncHost" && item.highImpact === true && item.blockedUntilExplicitUserApproval === true && item.command.includes("sync-anticodex-launcher.ps1"))) throw new Error("self-test failed: sync-readiness host-sync action was not marked high-impact");
    const syncReadinessSampleCodes = reportFailureSampleCodes(["Codex update status is not comparable: source_codex_changed", "installed Codex changed; Anti-Codex sync is required"]);
    if (!syncReadinessSampleCodes.includes("host_sync_required")) throw new Error("self-test failed: sync-readiness host-sync samples were not normalized");
    const postVerificationActions = gateOrderedActions(postVerificationGate);
    if (!postVerificationActions.some((item) => item.reportOnly === true && item.requiresGatewayStart === false && item.requiresRealTraffic === false && item.blockedUntilExplicitUserApproval === false)) throw new Error("self-test failed: semantic failure report-only action was not attached before real traffic");
    if (!postVerificationActions.some((item) => item.id === "postVerification" && item.requiresGatewayStart === true && item.requiresRealTraffic === true && item.highImpact === true)) throw new Error("self-test failed: real-traffic ordered action was not marked gateway and real-traffic");
    const realMiniActions = gateOrderedActions(reasonGates.find((item) => item.id === "realMiniTool"));
    if (!realMiniActions.some((item) => item.id === "realMiniTool" && item.requiresGatewayStart === true && item.requiresRealTraffic === true && item.highImpact === true && item.blockedUntilExplicitUserApproval === true)) throw new Error("self-test failed: realMiniTool ordered action was not marked gateway/high-impact");
    const realWorkActions = gateOrderedActions(reasonGates.find((item) => item.id === "realWork"));
    if (!realWorkActions.some((item) => item.id === "realWork" && item.requiresGatewayStart === true && item.requiresRealTraffic === true && item.highImpact === true && item.blockedUntilExplicitUserApproval === true)) throw new Error("self-test failed: realWork ordered action was not marked gateway/high-impact");
    const accountProxyGate = reasonGates.find((item) => item.id === "accountProxyReadiness");
    const accountProxyActions = gateOrderedActions(accountProxyGate);
    if (!accountProxyActions.some((item) => item.id === "accountProxyReadiness" && item.requiresGatewayStart === true && item.requiresRealTraffic === true && item.command.includes("test-anticodex-account-proxy-readiness.ps1"))) throw new Error("self-test failed: account-proxy ordered action was not marked gateway and real-traffic");
    const managerRealButtonActions = gateOrderedActions(managerRealButtonGate);
    if (!managerRealButtonActions.some((item) => item.id === "managerRealButtons" && item.requiresGatewayStart === true && item.blockedUntilExplicitUserApproval === true && item.command.includes("test-anticodex-manager-real-buttons.ps1"))) throw new Error("self-test failed: manager real-button ordered action was not attached");
    if (!managerRealButtonActions.some((item) => item.id === "managerRealButtons" && String(item.guidance || "").includes("local_gateway_required") && String(item.reason || ""))) throw new Error("self-test failed: gate ordered actions did not preserve reason and guidance");
    const missingHistoryActions = gateOrderedActions(reasonGates.find((item) => item.id === "missingHistory"));
    if (!missingHistoryActions.some((item) => item.id === "missingHistory" && item.requiresGatewayStart === true && item.blockedUntilExplicitUserApproval === true && item.command.includes("test-anticodex-missing-history.mjs"))) throw new Error("self-test failed: missing-history ordered action was not marked gateway-dependent");
    const mcpGatewayFailureGate = {
      id: "mcpSkills",
      group: "short",
      satisfied: false,
      failureReasons: ["ok_false", "semantic_failures"],
      semanticFailures: ["mcp_skills_source_snapshot_missing"],
      reportFailureSamples: [
        "health request failed: /health request failed on attempt 2 of 2: The operation has timed out.",
        "installed plugins endpoint failed: /backend-api/ps/plugins/installed request failed on attempt 2 of 2: The operation has timed out.",
      ],
    };
    const mcpGatewayActions = gateOrderedActions(mcpGatewayFailureGate);
    if (!gateGuidance(mcpGatewayFailureGate).includes("local_gateway_offline")) throw new Error("self-test failed: MCP/Skill gateway-offline guidance was not attached");
    if (!mcpGatewayActions.some((item) => item.id === "mcpSkills" && item.requiresGatewayStart === true && item.blockedUntilExplicitUserApproval === true && item.phase === "short-gateway")) throw new Error("self-test failed: MCP/Skill gateway-offline action was not marked gateway-dependent");
    const missingRequiredWithoutActions = reasonGates
      .filter((item) => item.requiredForRelease === true && !item.satisfied && gateOrderedActions(item).length < 1)
      .map((item) => item.id);
    if (missingRequiredWithoutActions.length) throw new Error(`self-test failed: required failed gates missing ordered actions: ${missingRequiredWithoutActions.join(",")}`);
    const nextActionSummary = summarizeNextActions(reasonGates.map((gate) => ({ ...gate, orderedActions: gateOrderedActions(gate) })));
    const sortedActions = nextActionSummary.actions;
    const allSortedActions = nextActionSummary.allActions;
    const sortedActionIds = sortedActions.map((item) => item.id);
    if (sortedActions.some((item) => !item.command)) throw new Error("self-test failed: nextActions contained an action without a command");
    const missingShortWithoutActions = reasonGates
      .filter((item) => item.requiredForShort === true && !item.satisfied)
      .filter((item) => !sortedActions.some((actionItem) => actionItem.id === item.id || actionItem.gateId === item.id))
      .map((item) => item.id);
    if (missingShortWithoutActions.length) throw new Error(`self-test failed: short failed gates missing next actions: ${missingShortWithoutActions.join(",")}`);
    if (!sortedActions.some((item) => item.id === "managerRealButtons" && String(item.guidance || "").includes("local_gateway_required"))) throw new Error("self-test failed: nextActions did not preserve gate guidance");
    if (!allSortedActions.some((item) => item.id === "accountProxyReadiness" && String(item.guidance || "").includes("real_traffic_evidence_stale"))) throw new Error("self-test failed: real-traffic nextActions did not preserve gate guidance");
    if (!allSortedActions.some((item) => item.id === "realThirdPartyProviderOptional" && item.phase === "optional-real-provider" && item.blockedUntilExplicitUserApproval === true)) throw new Error("self-test failed: optional real-provider nextAction missing approval block");
    if (!allSortedActions.some((item) => item.id === "providerAntigravityReturnOptional" && item.phase === "optional-antigravity-return" && item.requiresGatewayStart === true && item.requiresRealTraffic === true && item.highImpact === true && item.blockedUntilExplicitUserApproval === true && String(item.guidance || "").includes("optional_antigravity_return_required"))) throw new Error("self-test failed: optional Antigravity-return nextAction missing approval block");
    const allSortedActionIds = allSortedActions.map((item) => item.id);
    if (allSortedActionIds.indexOf("accountProxyReadiness") < 0 || allSortedActionIds.indexOf("postVerification") < 0 || allSortedActionIds.indexOf("accountProxyReadiness") > allSortedActionIds.indexOf("postVerification")) throw new Error("self-test failed: top-level nextActions did not keep post-verification last");
    const truncatedActions = summarizeNextActions(Array.from({ length: 40 }, (_, index) => ({
      id: `overflow${index}`,
      orderedActions: [action(`overflow${index}`, "real-traffic-low-state", `echo overflow-${index}`, { requiresGatewayStart: true, requiresRealTraffic: true })],
    })));
    if (truncatedActions.actions.length !== 32 || truncatedActions.availableCount <= truncatedActions.actions.length || truncatedActions.hiddenCount !== truncatedActions.availableCount - truncatedActions.actions.length || truncatedActions.truncated !== true) {
      throw new Error("self-test failed: nextActions truncation evidence was not summarized");
    }
    const hiddenHighImpactActions = summarizeNextActions([
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `lowRiskOverflow${index}`,
        orderedActions: [action(`lowRiskOverflow${index}`, "gateway-start", `echo low-risk-${index}`, { requiresGatewayStart: true })],
      })),
      {
        id: "hiddenOptionalRealTraffic",
        orderedActions: [action("hiddenOptionalRealTraffic", "optional-antigravity-return", "echo hidden-real-traffic", { requiresGatewayStart: true, requiresRealTraffic: true, highImpact: true })],
      },
    ]);
    const hiddenHighImpactPlan = summarizeApprovalPlan(hiddenHighImpactActions.allActions);
    if (hiddenHighImpactActions.actions.some((item) => item.id === "hiddenOptionalRealTraffic") || hiddenHighImpactPlan.requiresRealTrafficCount < 1 || hiddenHighImpactPlan.highImpactCount < 1) {
      throw new Error("self-test failed: approval plan did not count hidden high-risk actions");
    }
    const approvalPlan = summarizeApprovalPlan(nextActionSummary.allActions);
    if (approvalPlan.reportOnlyCount < 1) throw new Error("self-test failed: approval plan did not count report-only actions");
    if (approvalPlan.requiresGatewayStartCount < 1 || approvalPlan.requiresRealTrafficCount < 1 || approvalPlan.highImpactCount < 1 || approvalPlan.firstBlockedAction !== "startGatewayTranslatorOnly") {
      throw new Error("self-test failed: approval plan did not summarize gateway, real-traffic, and high-impact actions");
    }
    const optionalOnlySummary = summarizeNextActions([{
      id: "providerAntigravityReturnOptional",
      requiredForRelease: false,
      requiredForShort: false,
      orderedActions: [
        action("providerAntigravityReturnOptional", "optional-antigravity-return", "echo optional-return", {
          requiresGatewayStart: true,
          requiresRealTraffic: true,
          highImpact: true,
          blockedUntilExplicitUserApproval: true,
        }),
      ],
    }]);
    if (optionalOnlySummary.allActions.some((item) => item.id === "startGatewayTranslatorOnly")) {
      throw new Error("self-test failed: optional-only nextActions should not prepend gateway start as a required blocker");
    }
    const optionalOnlyPlan = summarizeApprovalPlan(optionalOnlySummary.allActions);
    if (optionalOnlyPlan.firstBlockedAction !== "providerAntigravityReturnOptional") {
      throw new Error("self-test failed: optional-only approval plan should point at the optional action itself");
    }
    const realTrafficOnlySummary = summarizeNextActions([
      {
        id: "postVerification",
        group: "real-traffic",
        requiredForRelease: true,
        requiredForShort: false,
        failureReason: "stale_report",
        failureReasons: ["stale_report"],
        guidance: "real_traffic_evidence_stale: requires explicit user approval.",
        orderedActions: [
          action("postVerification", "real-traffic-final", "echo post-verification", {
            requiresGatewayStart: true,
            requiresRealTraffic: true,
            highImpact: true,
          }),
        ],
      },
      {
        id: "accountProxyReadiness",
        group: "real-traffic",
        requiredForRelease: true,
        requiredForShort: false,
        failureReason: "stale_report",
        failureReasons: ["stale_report"],
        guidance: "real_traffic_evidence_stale: requires explicit user approval.",
        orderedActions: [
          action("accountProxyReadiness", "real-traffic-low-state", "echo account-proxy", {
            requiresGatewayStart: true,
            requiresRealTraffic: true,
          }),
        ],
      },
    ]);
    if (realTrafficOnlySummary.allActions.some((item) => item.id === "startGatewayTranslatorOnly")) {
      throw new Error("self-test failed: real-traffic-only nextActions should not prepend gateway start as a separate blocker");
    }
    const realTrafficOnlyPlan = summarizeApprovalPlan(realTrafficOnlySummary.allActions);
    if (realTrafficOnlyPlan.firstBlockedAction !== "accountProxyReadiness" || realTrafficOnlyPlan.requiredForReleaseCount !== 2) {
      throw new Error("self-test failed: real-traffic-only approval plan should point at the first required real-traffic gate");
    }
    const failedLatestGate = reasonGates.find((item) => item.id === "coldRelaunch");
    if (!failedLatestGate) throw new Error("self-test failed: coldRelaunch gate missing while checking selected report details");
    if (failedLatestGate.selectedFile !== "latest-cold-relaunch.json") throw new Error("self-test failed: latest report selectedFile was not preserved");
    if (failedLatestGate.selectedKind !== "latest") throw new Error("self-test failed: latest report selectedKind was not preserved");
    if (!failedLatestGate.selectedMtime) throw new Error("self-test failed: latest report selectedMtime was not preserved");
    if (!Array.isArray(failedLatestGate.reportFailureSamples) || !failedLatestGate.reportFailureSamples.includes("original Codex main process set changed")) {
      throw new Error("self-test failed: latest report failure samples were not preserved");
    }
    const coldActions = gateOrderedActions(failedLatestGate);
    if (!coldActions.some((item) => item.id === "coldRelaunch" && item.requiresGatewayStart === true && item.highImpact === true && item.command.includes("-ConfirmRelaunch"))) throw new Error("self-test failed: optional cold-relaunch action was not marked gateway/high-impact");
    const soakGate = reasonGates.find((item) => item.id === "stabilitySoak");
    const soakActions = gateOrderedActions(soakGate);
    if (!soakActions.some((item) => item.id === "stabilitySoak" && item.requiresGatewayStart === true && item.requiresRealTraffic === true && item.highImpact === true)) throw new Error("self-test failed: optional stability-soak action was not marked gateway and real-traffic");

    console.log(JSON.stringify({ ok: true, selfTest: true, semanticFailures }));
  } finally {
    reportRoot = originalReportRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  }
  process.exit(0);
}

const gates = [...gateDefinitions.map(summarizeGate), summarizeInstalledRuntimeSyncGate()];
const installedRuntimeEvidence = installedRuntimeEvidenceFromGate(gates.find((gate) => gate.id === "installedRuntimeSync"));
function addSemanticFailure(gateId, failure) {
  const gate = gates.find((item) => item.id === gateId);
  if (!gate) return;
  if (!Array.isArray(gate.semanticFailures)) gate.semanticFailures = [];
  if (!gate.semanticFailures.includes(failure)) gate.semanticFailures.push(failure);
  gate.satisfied = gate.present && gate.parseable && gate.hashValid === true && gate.okField === true && gate.fresh === true && gate.semanticFailures.length === 0;
}

addSourceSnapshotMismatchFailures(gates, addSemanticFailure);
const requiredRelease = gates.filter((gate) => gate.requiredForRelease);
const requiredShort = gates.filter((gate) => gate.requiredForShort);

attachGateFailureReasons(gates);
attachPluginOfflineSnapshotEvidence(gates);

const missingRequired = requiredRelease.filter((gate) => !gate.satisfied).map((gate) => gate.id);
const missingShort = requiredShort.filter((gate) => !gate.satisfied).map((gate) => gate.id);
const missingOptional = gates.filter((gate) => !gate.requiredForRelease && !gate.satisfied).map((gate) => gate.id);
const damagedReports = gates.filter((gate) => gate.present && (!gate.parseable || gate.hashValid !== true)).map((gate) => gate.id);
const releaseGateFailureReasons = gates
  .filter((gate) => !gate.satisfied)
  .map((gate) => {
    const failureReasons = Array.isArray(gate.failureReasons) ? gate.failureReasons : [];
    return {
      id: gate.id,
      group: gate.group,
      requiredForRelease: gate.requiredForRelease === true,
      requiredForShort: gate.requiredForShort === true,
      failureReason: gate.failureReason || "",
      failureReasons,
      failureReasonsAvailableCount: failureReasons.length,
      failureReasonsHiddenCount: 0,
      ageHours: gate.ageHours,
      fresh: gate.fresh === true,
      selectedFromHistory: gate.selectedFromHistory === true,
      historySourceMismatch: gate.historySourceMismatch === true,
      selectedKind: gate.selectedKind || "",
      selectedFile: gate.selectedFile || "",
      selectedMtime: gate.selectedMtime || "",
      reportFailureSamples: Array.isArray(gate.reportFailureSamples) ? gate.reportFailureSamples.slice(0, 3) : [],
      reportFailureSampleCodes: reportFailureSampleCodes(gate.reportFailureSamples),
      guidance: gateGuidance(gate),
      orderedActions: gateOrderedActions(gate),
      offlineSnapshotEvidence: gate.offlineSnapshotEvidence || null,
    };
  });
const releaseGateFailures = gates
  .filter((gate) => !gate.satisfied && Array.isArray(gate.semanticFailures) && gate.semanticFailures.length > 0)
  .map((gate) => {
    const semanticFailures = gate.semanticFailures;
    return {
      id: gate.id,
      group: gate.group,
      error: gate.error || "",
      failureReason: gate.failureReason || "",
      selectedFromHistory: gate.selectedFromHistory === true,
      historySourceMismatch: gate.historySourceMismatch === true,
      selectedKind: gate.selectedKind || "",
      selectedFile: gate.selectedFile || "",
      selectedMtime: gate.selectedMtime || "",
      semanticFailures,
      semanticFailuresAvailableCount: semanticFailures.length,
      semanticFailuresHiddenCount: 0,
    };
  });
const nextActionSummary = summarizeNextActions(releaseGateFailureReasons);
const nextActions = nextActionSummary.actions;
const approvalPlan = summarizeApprovalPlan(nextActionSummary.allActions);
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
const releaseGateGroups = Object.entries(groups).map(([group, value]) => ({
  group,
  total: value.total,
  satisfied: value.satisfied,
  required: value.required,
  requiredSatisfied: value.requiredSatisfied,
  optional: value.optional,
  optionalSatisfied: value.optionalSatisfied,
  missingRequired: Array.isArray(value.missingRequired) ? value.missingRequired : [],
  missingOptional: Array.isArray(value.missingOptional) ? value.missingOptional : [],
}));
const releaseGateSelectedReports = gates
  .filter((gate) => gate.selectedFromHistory === true)
  .map((gate) => ({
    id: gate.id,
    group: gate.group,
    selectedFile: gate.selectedFile || "",
    selectedMtime: gate.selectedMtime || "",
    historySourceMismatch: gate.historySourceMismatch === true,
  }))
  .filter((entry) => entry.id && entry.selectedFile);

const releaseReady = missingRequired.length === 0 && (!strictOptionalRealTraffic || optionalRealTrafficReady);
const shortReady = missingShort.length === 0;
const missingRequiredFailureReasons = releaseGateFailureReasons.filter((gate) => gate.requiredForRelease === true && missingRequired.includes(gate.id));
const requiredRealTrafficBlockedGates = missingRequiredFailureReasons
  .filter((gate) => {
    const actionable = Array.isArray(gate.orderedActions) ? gate.orderedActions.filter((actionItem) => actionItem?.reportOnly !== true) : [];
    return actionable.length > 0
      && actionable.every((actionItem) => actionItem?.requiresRealTraffic === true && actionItem?.blockedUntilExplicitUserApproval === true);
  })
  .map((gate) => gate.id);
const releaseBlockedOnlyByRequiredRealTraffic = releaseReady === false
  && shortReady === true
  && damagedReports.length === 0
  && missingRequired.length > 0
  && requiredRealTrafficBlockedGates.length === missingRequired.length;
const payload = {
  ok: strict ? releaseReady && damagedReports.length === 0 : true,
  releaseReady,
  shortReady,
  releaseBlockedOnlyByRequiredRealTraffic,
  requiredRealTrafficBlockedGates,
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
  releaseGateFailures,
  releaseGateGroups,
  releaseGateSelectedReports,
  releaseGateFailureReasons,
  nextActions,
  nextActionsAvailableCount: nextActionSummary.availableCount,
  nextActionsHiddenCount: nextActionSummary.hiddenCount,
  nextActionsTruncated: nextActionSummary.truncated,
  approvalPlan,
  installedRuntimeEvidence,
  groups,
  gates,
};
writeJsonReportAtomic(payload);
process.stdout.write(JSON.stringify(compactStatus ? compactReleaseGateStatus(payload) : payload));
