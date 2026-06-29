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

function asOrderedActions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    id: asString(item?.id),
    ...(item?.gateId ? { gateId: asString(item.gateId) } : {}),
    phase: asString(item?.phase),
    command: asString(item?.command),
    ...(item?.reason ? { reason: asString(item.reason) } : {}),
    ...(item?.guidance ? { guidance: asString(item.guidance) } : {}),
    ...(item?.reportOnly === true ? { reportOnly: true } : {}),
    requiresGatewayStart: item?.requiresGatewayStart === true,
    requiresRealTraffic: item?.requiresRealTraffic === true,
    highImpact: item?.highImpact === true,
    blockedUntilExplicitUserApproval: item?.blockedUntilExplicitUserApproval === true,
  })).filter((item) => item.id).slice(0, 32);
}

function asOfflineSnapshotEvidence(value) {
  if (!value || typeof value !== "object") return null;
  return {
    connectorContentMatches: boolField(value, "connectorContentMatches"),
    appToolContentMatches: boolField(value, "appToolContentMatches"),
    refreshGateSatisfied: boolField(value, "refreshGateSatisfied"),
    refreshSelectedFile: asString(value.refreshSelectedFile || ""),
    sourceFingerprint: asString(value.sourceFingerprint || ""),
    sourceFileCount: has(value, "sourceFileCount") ? value.sourceFileCount : null,
    sourceMtimeMax: asString(value.sourceMtimeMax || ""),
    note: asString(value.note || ""),
  };
}

function asApprovalPlan(value) {
  if (!value || typeof value !== "object") return null;
  return {
    actionCount: has(value, "actionCount") ? value.actionCount : null,
    blockedCount: has(value, "blockedCount") ? value.blockedCount : null,
    requiresGatewayStartCount: has(value, "requiresGatewayStartCount") ? value.requiresGatewayStartCount : null,
    requiresRealTrafficCount: has(value, "requiresRealTrafficCount") ? value.requiresRealTrafficCount : null,
    highImpactCount: has(value, "highImpactCount") ? value.highImpactCount : null,
    reportOnlyCount: has(value, "reportOnlyCount") ? value.reportOnlyCount : null,
    requiredForShortCount: has(value, "requiredForShortCount") ? value.requiredForShortCount : null,
    requiredForReleaseCount: has(value, "requiredForReleaseCount") ? value.requiredForReleaseCount : null,
    firstBlockedAction: asString(value.firstBlockedAction || ""),
    phases: Array.isArray(value.phases) ? value.phases.map((phase) => ({
      phase: asString(phase?.phase || ""),
      count: has(phase || {}, "count") ? phase.count : null,
      requiresGatewayStart: phase?.requiresGatewayStart === true,
      requiresRealTraffic: phase?.requiresRealTraffic === true,
      highImpact: phase?.highImpact === true,
      reportOnly: phase?.reportOnly === true,
      blockedUntilExplicitUserApproval: phase?.blockedUntilExplicitUserApproval === true,
    })).filter((phase) => phase.phase).slice(0, 24) : [],
  };
}

function boolField(object, key) {
  return has(object, key) ? !!object[key] : null;
}

function asRepoMultiSettleEvidence(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ok: boolField(value, "ok"),
    kind: asString(value.kind),
    phase: asString(value.phase),
    historyToolOutputRequired: boolField(value, "historyToolOutputRequired"),
    historyToolOutputSeen: boolField(value, "historyToolOutputSeen"),
    artifactComplete: boolField(value, "artifactComplete"),
    inLoopIdleObserved: boolField(value, "inLoopIdleObserved"),
    diagnosticsPresent: value.diagnostics && typeof value.diagnostics === "object",
  };
}

function pathWithin(child, parent) {
  const childText = asString(child);
  const parentText = asString(parent);
  if (!childText || !parentText) return null;
  const normalizedChild = childText.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
  const normalizedParent = parentText.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

const report = JSON.parse(readFileSync(path, "utf8"));
const checks = report && report.checks ? report.checks : {};
function checkOk(name) {
  return has(checks, name) && checks[name] && has(checks[name], "ok") ? !!checks[name].ok : null;
}

function publicDocumentationAssertionOk(file, name) {
  const publicDocumentation = checks.publicDocumentation && typeof checks.publicDocumentation === "object"
    ? checks.publicDocumentation
    : null;
  const assertions = Array.isArray(publicDocumentation?.assertions) ? publicDocumentation.assertions : [];
  return assertions.some((item) => item?.file === file && item?.name === name && item?.ok === true);
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
  const initial = result && result.initial && typeof result.initial === "object" ? result.initial : null;
  return {
    action,
    ok: boolField(value, "ok"),
    lastUiOnly: result && has(result, "lastUiOnly") ? !!result.lastUiOnly : null,
    bridgeReady: initial && has(initial, "bridgeReady") ? !!initial.bridgeReady : (result && has(result, "bridgeReady") ? !!result.bridgeReady : null),
    overlayPresent: result && has(result, "overlayPresent") ? !!result.overlayPresent : (initial && has(initial, "overlayPresent") ? !!initial.overlayPresent : null),
    actionCenterHitsButton: initial && has(initial, "actionCenterHitsButton") ? !!initial.actionCenterHitsButton : null,
    closeHitAreaOk: initial && has(initial, "closeHitAreaOk") ? !!initial.closeHitAreaOk : null,
    closeHitResults: initial && Array.isArray(initial.closeHitResults) ? initial.closeHitResults.slice(0, 8).map((item) => ({
      name: asString(item?.name),
      hit: item?.hit === true,
      target: asString(item?.target),
    })) : [],
    managerOpenedNewPage: has(value, "managerOpenedNewPage") ? !!value.managerOpenedNewPage : (payload && has(payload, "managerOpenedNewPage") ? !!payload.managerOpenedNewPage : (result && has(result, "managerOpenedNewPage") ? !!result.managerOpenedNewPage : null)),
    pageTargetCountBeforeManagerOpen: has(value, "pageTargetCountBeforeManagerOpen") ? value.pageTargetCountBeforeManagerOpen : (payload && has(payload, "pageTargetCountBeforeManagerOpen") ? payload.pageTargetCountBeforeManagerOpen : (result && has(result, "pageTargetCountBeforeManagerOpen") ? result.pageTargetCountBeforeManagerOpen : null)),
    pageTargetCountAfterManagerOpen: has(value, "pageTargetCountAfterManagerOpen") ? value.pageTargetCountAfterManagerOpen : (payload && has(payload, "pageTargetCountAfterManagerOpen") ? payload.pageTargetCountAfterManagerOpen : (result && has(result, "pageTargetCountAfterManagerOpen") ? result.pageTargetCountAfterManagerOpen : null)),
  };
});

const failureCount = has(report, "failures")
  ? (Array.isArray(report.failures) ? report.failures.length : (report.failures === null ? 0 : 1))
  : 0;
const wait = report && report.wait ? report.wait : null;
const latestWait = wait && wait.latest ? wait.latest : null;
const isReleaseGateReport = report?.reportName === "release-gates" || /latest-release-gates\.json$/i.test(path);
const isLogDbGuardReport = report?.reportName === "log-db-guard" || /latest-log-db-guard\.json$/i.test(path) || has(report, "triggerPresent") || has(report, "protected");
const isMissingHistoryReport = report?.reportName === "missing-history" || /latest-missing-history\.json$/i.test(path);
const isAccountProxyReport = report?.reportName === "account-proxy-readiness" || /latest-account-proxy-readiness\.json$/i.test(path);
const isAmbientSuggestionsReport = report?.reportName === "ambient-suggestions" || /latest-ambient-suggestions\.json$/i.test(path);
const isUiChatSmokeReport = report?.reportName === "ui-chat-smoke" || /latest-ui-chat-smoke\.json$/i.test(path);
const isUiWebSearchSmokeReport = report?.reportName === "ui-web-search-smoke" || /latest-ui-web-search-smoke\.json$/i.test(path);
const isUiLocalProjectSmokeReport = report?.reportName === "ui-local-project-smoke" || /latest-ui-local-project-smoke\.json$/i.test(path);
const isUiCodingProjectSmokeReport = report?.reportName === "ui-coding-project-smoke" || /latest-ui-coding-project-smoke\.json$/i.test(path);
const isUiMultiTurnProjectSmokeReport = report?.reportName === "ui-multi-turn-project-smoke" || /latest-ui-multi-turn-project-smoke\.json$/i.test(path);
const isUiRepoFileEditSmokeReport = report?.reportName === "ui-repo-file-edit-smoke" || /latest-ui-repo-file-edit-smoke\.json$/i.test(path);
const isUiRepoMultiFileEditSmokeReport = report?.reportName === "ui-repo-multi-file-edit-smoke" || /latest-ui-repo-multi-file-edit-smoke\.json$/i.test(path);
const isUiComplexProjectSmokeReport = report?.reportName === "ui-complex-project-smoke" || /latest-ui-complex-project-smoke\.json$/i.test(path);
const isUiReportSiteSmokeReport = report?.reportName === "ui-report-site-smoke" || /latest-ui-report-site-smoke\.json$/i.test(path);
const isAntigravityCliProfilePrepareReport = report?.reportName === "antigravity-cli-profile-prepare" || /latest-antigravity-cli-profile-prepare\.json$/i.test(path);
const isAntigravityCliRealSmokeReport = report?.reportName === "antigravity-cli-real-smoke" || /latest-antigravity-cli-real-smoke\.json$/i.test(path);
const releaseGateEffectiveOk = isReleaseGateReport
  ? report?.releaseReady === true && (!Array.isArray(report?.damagedReports) || report.damagedReports.length === 0)
  : null;
const multiTurnHistory = report && report.multiTurnHistory ? report.multiTurnHistory : null;
const toolHistory = multiTurnHistory && multiTurnHistory.toolHistory ? multiTurnHistory.toolHistory : null;
const structuralEvidence = toolHistory && toolHistory.structuralEvidence ? toolHistory.structuralEvidence : null;
const providerSwitch = multiTurnHistory && multiTurnHistory.providerSwitch ? multiTurnHistory.providerSwitch : null;
const protocolSwitch = multiTurnHistory && multiTurnHistory.protocolSwitch ? multiTurnHistory.protocolSwitch : null;
const reverseProtocolSwitch = multiTurnHistory && multiTurnHistory.reverseProtocolSwitch ? multiTurnHistory.reverseProtocolSwitch : null;
const previousResponseContinuity = multiTurnHistory && multiTurnHistory.previousResponseContinuity
  ? multiTurnHistory.previousResponseContinuity
  : (report && report.previousResponseContinuity ? report.previousResponseContinuity : null);
const endpointEvidence = report && report.endpointEvidence ? report.endpointEvidence : null;
const capabilities = report && report.capabilities ? report.capabilities : null;
const connectorParity = capabilities && capabilities.connectorParity ? capabilities.connectorParity : (report && report.connectorParity ? report.connectorParity : null);
const appToolParity = capabilities && capabilities.appToolParity ? capabilities.appToolParity : (report && report.appToolParity ? report.appToolParity : null);
const tempIsolation = report && report.tempIsolation ? report.tempIsolation : null;
const connectorCacheSmoke = capabilities && capabilities.smoke ? capabilities.smoke.connectorCache : null;
const appToolsCacheSmoke = capabilities && capabilities.smoke ? capabilities.smoke.appToolsCache : null;
const refreshConnectorParity = report && report.connectorParity ? report.connectorParity : null;
const refreshAppToolParity = report && report.appToolParity ? report.appToolParity : null;
const refreshSkills = report && report.skills ? report.skills : null;
const refreshGuidance = report && report.guidance && typeof report.guidance === "object" ? report.guidance : null;
const appToolGetPostParity = capabilities && capabilities.appToolGetPostParity ? capabilities.appToolGetPostParity : (report && report.appToolGetPostParity ? report.appToolGetPostParity : null);
const mcp = report && report.mcp ? report.mcp : null;
const skills = report && report.skills ? report.skills : null;
const appTools = report && report.appTools ? report.appTools : null;
const appToolRegistry = appTools && appTools.registry ? appTools.registry : null;
const mcpRealList = mcp && mcp.smoke && Array.isArray(mcp.smoke.realList) ? mcp.smoke.realList : null;
const mcpRealListPassed = mcpRealList ? mcpRealList.filter((entry) => entry && entry.passed === true).length : null;
const mcpRealListToolCount = mcpRealList
  ? mcpRealList.reduce((total, entry) => total + (Number.isFinite(Number(entry?.toolCount)) ? Number(entry.toolCount) : 0), 0)
  : null;
const mcpRealListServers = mcpRealList ? mcpRealList.map((entry) => asString(entry?.server)).filter(Boolean) : [];
const realAntigravityEvidence = report && report.realAntigravityEvidence ? report.realAntigravityEvidence : null;
const toolBridge = report && report.toolBridge ? report.toolBridge : null;
const compatibilityTools = report && report.compatibilityTools ? report.compatibilityTools : null;
const nativeToolCapability = report && report.nativeToolCapability ? report.nativeToolCapability : null;
const modelRoutingResults = Array.isArray(report?.results) ? report.results : [];
const thinkingModels = Array.isArray(report?.models) && (has(report, "expectedModelCount") || has(report, "actualModelCount")) ? report.models : [];
const uiIdleSamples = Array.isArray(report?.samples) ? report.samples : [];
const sync = report && report.sync ? report.sync : null;
const activeHost = report && report.activeHost ? report.activeHost : null;
const phaseSummary = report && report.phaseSummary && typeof report.phaseSummary === "object" ? report.phaseSummary : null;
const antigravityLogSignals = report && report.antigravityLogSignals && typeof report.antigravityLogSignals === "object" ? report.antigravityLogSignals : null;
const shortcutVerification = sync && Array.isArray(sync.shortcutVerification) ? sync.shortcutVerification : [];
const managerBridge = sync && sync.managerBridge ? sync.managerBridge : null;
const updateStatus = sync && sync.updateStatus ? sync.updateStatus : null;
const updateGuardrails = updateStatus && updateStatus.guardrails ? updateStatus.guardrails : null;
const checkEntries = checks && typeof checks === "object" ? Object.entries(checks).map(([id, value]) => ({
  id,
  value: value && typeof value === "object" ? value : {},
})) : [];
const skippedCheckEntries = checkEntries.filter((entry) => entry.value.skipped === true);
const releaseGateFailures = Array.isArray(report?.gates)
  ? report.gates
    .filter((gate) => {
      const semanticFailures = has(gate, "semanticFailures") ? asStringArray(gate.semanticFailures) : [];
      return gate
        && gate.satisfied !== true
        && (gate.requiredForRelease === true || gate.requiredForShort === true || semanticFailures.length > 0 || (gate.present === true && (gate.error || gate.okField === false)));
    })
    .map((gate) => {
      const failureReasons = has(gate, "failureReasons") ? asStringArray(gate.failureReasons) : [];
      const semanticFailures = has(gate, "semanticFailures") ? asStringArray(gate.semanticFailures) : [];
      return {
        id: asString(gate.id),
        group: asString(gate.group),
        error: asString(gate.error),
        failureReason: asString(gate.failureReason),
        failureReasons,
        failureReasonsAvailableCount: failureReasons.length,
        failureReasonsHiddenCount: 0,
        semanticFailures,
        semanticFailuresAvailableCount: semanticFailures.length,
        semanticFailuresHiddenCount: 0,
        selectedFromHistory: gate.selectedFromHistory === true,
        historySourceMismatch: gate.historySourceMismatch === true,
        selectedKind: asString(gate.selectedKind || ""),
        selectedFile: asString(gate.selectedFile || ""),
        selectedMtime: asString(gate.selectedMtime || ""),
        reportFailureSamples: has(gate, "reportFailureSamples") ? asStringArray(gate.reportFailureSamples).slice(0, 3) : [],
        ...(has(gate, "reportFailureSampleCodes") && asStringArray(gate.reportFailureSampleCodes).length ? { reportFailureSampleCodes: asStringArray(gate.reportFailureSampleCodes).slice(0, 6) } : {}),
        guidance: asString(gate.guidance || ""),
        orderedActions: asOrderedActions(gate.orderedActions),
        ...(asOfflineSnapshotEvidence(gate.offlineSnapshotEvidence) ? { offlineSnapshotEvidence: asOfflineSnapshotEvidence(gate.offlineSnapshotEvidence) } : {}),
      };
    })
  : [];
const rawReleaseGateFailureReasons = has(report, "releaseGateFailureReasons") && Array.isArray(report.releaseGateFailureReasons)
  ? report.releaseGateFailureReasons
  : (Array.isArray(report?.gates) ? report.gates.filter((gate) => gate && gate.satisfied !== true) : []);
const releaseGateFailureReasons = rawReleaseGateFailureReasons
  .map((gate) => {
    const failureReasons = has(gate, "failureReasons") ? asStringArray(gate.failureReasons) : [];
    return {
      id: asString(gate.id),
      group: asString(gate.group),
      requiredForRelease: gate.requiredForRelease === true,
      requiredForShort: gate.requiredForShort === true,
      failureReason: asString(gate.failureReason),
      failureReasons,
      failureReasonsAvailableCount: failureReasons.length,
      failureReasonsHiddenCount: 0,
      ageHours: has(gate, "ageHours") ? gate.ageHours : null,
      fresh: boolField(gate, "fresh"),
      selectedFromHistory: gate.selectedFromHistory === true,
      historySourceMismatch: gate.historySourceMismatch === true,
      selectedKind: asString(gate.selectedKind || ""),
      selectedFile: asString(gate.selectedFile || ""),
      selectedMtime: asString(gate.selectedMtime || ""),
      reportFailureSamples: has(gate, "reportFailureSamples") ? asStringArray(gate.reportFailureSamples).slice(0, 3) : [],
      ...(has(gate, "reportFailureSampleCodes") && asStringArray(gate.reportFailureSampleCodes).length ? { reportFailureSampleCodes: asStringArray(gate.reportFailureSampleCodes).slice(0, 6) } : {}),
      guidance: asString(gate.guidance || ""),
      orderedActions: asOrderedActions(gate.orderedActions),
      ...(asOfflineSnapshotEvidence(gate.offlineSnapshotEvidence) ? { offlineSnapshotEvidence: asOfflineSnapshotEvidence(gate.offlineSnapshotEvidence) } : {}),
    };
  }).filter((entry) => entry.id).slice(0, 64)
const nextActions = asOrderedActions(report?.nextActions);
const nextActionsAvailableCount = has(report || {}, "nextActionsAvailableCount") ? report.nextActionsAvailableCount : null;
const nextActionsHiddenCount = has(report || {}, "nextActionsHiddenCount") ? report.nextActionsHiddenCount : null;
const nextActionsTruncated = boolField(report || {}, "nextActionsTruncated");
const approvalPlan = asApprovalPlan(report?.approvalPlan);
const rawReleaseGateGroups = Array.isArray(report?.releaseGateGroups)
  ? report.releaseGateGroups
  : (report && report.groups && typeof report.groups === "object" ? Object.entries(report.groups).map(([group, value]) => ({
    group: asString(group),
    total: value && has(value, "total") ? value.total : null,
    satisfied: value && has(value, "satisfied") ? value.satisfied : null,
    required: value && has(value, "required") ? value.required : null,
    requiredSatisfied: value && has(value, "requiredSatisfied") ? value.requiredSatisfied : null,
    optional: value && has(value, "optional") ? value.optional : null,
    optionalSatisfied: value && has(value, "optionalSatisfied") ? value.optionalSatisfied : null,
    missingRequired: value && has(value, "missingRequired") ? asStringArray(value.missingRequired) : [],
    missingOptional: value && has(value, "missingOptional") ? asStringArray(value.missingOptional) : [],
  })) : []);
const releaseGateGroups = rawReleaseGateGroups.map((value) => ({
  group: asString(value.group),
  total: value && has(value, "total") ? value.total : null,
  satisfied: value && has(value, "satisfied") ? value.satisfied : null,
  required: value && has(value, "required") ? value.required : null,
  requiredSatisfied: value && has(value, "requiredSatisfied") ? value.requiredSatisfied : null,
  optional: value && has(value, "optional") ? value.optional : null,
  optionalSatisfied: value && has(value, "optionalSatisfied") ? value.optionalSatisfied : null,
  missingRequired: value && has(value, "missingRequired") ? asStringArray(value.missingRequired) : [],
  missingOptional: value && has(value, "missingOptional") ? asStringArray(value.missingOptional) : [],
})).filter((entry) => entry.group).slice(0, 16);
const releaseGateSelectedReports = Array.isArray(report?.releaseGateSelectedReports)
  ? report.releaseGateSelectedReports
    .map((entry) => ({
      id: asString(entry.id),
      group: asString(entry.group),
      selectedFile: asString(entry.selectedFile),
      historySourceMismatch: entry.historySourceMismatch === true,
      ...(asString(entry.selectedMtime) ? { selectedMtime: asString(entry.selectedMtime) } : {}),
    }))
    .filter((entry) => entry.id && entry.selectedFile)
    .slice(0, 12)
  : (Array.isArray(report?.gates)
    ? report.gates
    .filter((gate) => gate && gate.selectedFromHistory === true)
    .map((gate) => ({
      id: asString(gate.id),
      group: asString(gate.group),
      selectedFile: asString(gate.selectedFile),
      historySourceMismatch: gate.historySourceMismatch === true,
      ...(asString(gate.selectedMtime) ? { selectedMtime: asString(gate.selectedMtime) } : {}),
    }))
    .filter((entry) => entry.id && entry.selectedFile)
    .slice(0, 12)
    : []);
const installedRuntimeGate = Array.isArray(report?.gates)
  ? report.gates.find((gate) => gate && gate.id === "installedRuntimeSync")
  : null;
const installedRuntimeEvidence = installedRuntimeGate ? {
  satisfied: boolField(installedRuntimeGate, "satisfied"),
  sourceFingerprint: has(installedRuntimeGate, "sourceFingerprint") ? asString(installedRuntimeGate.sourceFingerprint) : null,
  installedRuntimeFingerprint: has(installedRuntimeGate, "installedRuntimeFingerprint") ? asString(installedRuntimeGate.installedRuntimeFingerprint) : null,
  sourceFileCount: has(installedRuntimeGate, "sourceFileCount") ? installedRuntimeGate.sourceFileCount : null,
  installedRuntimeFileCount: has(installedRuntimeGate, "installedRuntimeFileCount") ? installedRuntimeGate.installedRuntimeFileCount : null,
  sourceMtimeMax: has(installedRuntimeGate, "sourceMtimeMax") ? asString(installedRuntimeGate.sourceMtimeMax) : null,
  installedRuntimeMtimeMax: has(installedRuntimeGate, "installedRuntimeMtimeMax") ? asString(installedRuntimeGate.installedRuntimeMtimeMax) : null,
  missingSourceFiles: has(installedRuntimeGate, "missingSourceFiles") ? asStringArray(installedRuntimeGate.missingSourceFiles) : [],
  missingInstalledRuntimeFiles: has(installedRuntimeGate, "missingInstalledRuntimeFiles") ? asStringArray(installedRuntimeGate.missingInstalledRuntimeFiles) : [],
  mismatchedRuntimeFiles: has(installedRuntimeGate, "mismatchedRuntimeFiles") ? asStringArray(installedRuntimeGate.mismatchedRuntimeFiles) : [],
} : null;

function structuralEvidenceClean(evidence) {
  return !!evidence
    && evidence.pairedByCallId === true
    && evidence.resultAfterToolCall === true
    && evidence.protocolShapeClean === true;
}

function orderedHistoryClean(evidence) {
  return !!evidence
    && evidence.ok === true
    && Number(evidence.checked || 0) > 0
    && Array.isArray(evidence.matched)
    && evidence.matched.length === Number(evidence.checked || 0);
}

function emptyArrayField(object, key) {
  return object && Array.isArray(object[key]) ? object[key].length === 0 : null;
}

const summary = {
  ok: has(report, "ok") ? report.ok : null,
  effectiveOk: isReleaseGateReport ? releaseGateEffectiveOk : (has(report, "ok") ? report.ok : null),
  reportName: has(report, "reportName") ? asString(report.reportName) : null,
  noTraffic: boolField(report, "noTraffic"),
  usedRealTraffic: boolField(report, "usedRealTraffic"),
  behaviorCovered: boolField(report, "behaviorCovered"),
  coverageKind: has(report, "coverageKind") ? asString(report.coverageKind) : null,
  shortBudgetMode: boolField(report, "shortBudgetMode"),
  skipFullRegression: boolField(report, "skipFullRegression"),
  failureCount,
  elapsedMs: has(report, "elapsedMs") ? report.elapsedMs : null,
  actions: has(report, "actions") ? asStringArray(report.actions) : [],
  managerButtonOk: managerButton ? boolField(managerButton, "ok") : null,
  managerButtonResults,
  javascriptSyntaxOk: checkOk("javascriptSyntax"),
  powershellSyntaxOk: checkOk("powershellSyntax"),
  uiStateSelfTestOk: checkOk("uiStateSelfTest"),
  upstreamProfileStorageOk: checkOk("upstreamProfileStorage"),
  antigravityCliIsolationProfileOk: checkOk("antigravityCliIsolationProfile"),
  antigravityCliProfilePrepareOk: checkOk("antigravityCliProfilePrepare"),
  localConnectorVerifierOk: checkOk("localConnectorVerifier"),
  publicDocumentationOk: checkOk("publicDocumentation"),
  publicDocumentationClientCopySyncContractOk: report.reportName === "source-preflight"
    ? publicDocumentationAssertionOk("README.md", "client-copy-sync-contract") && publicDocumentationAssertionOk("README_EN.md", "client-copy-sync-contract")
    : null,
  translatorRegressionOk: checkOk("translatorRegression"),
  diffWhitespaceOk: checkOk("diffWhitespace"),
  baseUrl: has(report, "baseUrl") ? report.baseUrl : null,
  modelCount: has(report, "modelCount") ? report.modelCount : null,
  models: has(report, "models") ? asStringArray(report.models) : [],
  modelThinkingEvidence: has(report, "expectedModelCount") || has(report, "actualModelCount") ? {
    expectedModelCount: has(report, "expectedModelCount") ? report.expectedModelCount : null,
    actualModelCount: has(report, "actualModelCount") ? report.actualModelCount : null,
    modelCount: thinkingModels.length,
    supportsThinkingCount: thinkingModels.filter((item) => item && item.supports_thinking === true).length,
    missingBudgetCount: thinkingModels.filter((item) => !item || !Number.isFinite(Number(item.thinking_budget)) || !Number.isFinite(Number(item.min_thinking_budget)) || Number(item.thinking_budget) < Number(item.min_thinking_budget)).length,
    missingReasoningLevelCount: thinkingModels.filter((item) => !item || !item.reasoning_level).length,
    reasoningLevels: Array.from(new Set(thinkingModels.map((item) => item?.reasoning_level).filter(Boolean).map(String))).sort(),
  } : null,
  ambientSuggestionsEvidence: isAmbientSuggestionsReport ? {
    noTraffic: boolField(report, "noTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: asString(report.coverageKind),
    sqliteCheckCount: Array.isArray(report.sqliteChecks) ? report.sqliteChecks.length : 0,
    sqliteSourceHitCount: Array.isArray(report.sqliteChecks)
      ? report.sqliteChecks.reduce((sum, item) => sum
        + (Array.isArray(item?.tableHits) ? item.tableHits.length : 0)
        + (Array.isArray(item?.columnHits) ? item.columnHits.length : 0)
        + (Array.isArray(item?.targetHits) ? item.targetHits.length : 0), 0)
      : 0,
    bodyTextHitCount: Array.isArray(report.sqliteChecks)
      ? report.sqliteChecks.reduce((sum, item) => sum + Number(item?.bodyTextHitCount || 0), 0)
      : 0,
    unallowedNameCount: [
      ...(Array.isArray(report.nameScans?.codexHome?.entries) ? report.nameScans.codexHome.entries : []),
      ...(Array.isArray(report.nameScans?.installRoot?.entries) ? report.nameScans.installRoot.entries : []),
    ].filter((item) => item?.allowed !== true).length,
    chromiumHeadSuggestFileCount: Number.isFinite(Number(report.chromiumOnDeviceHeadSuggestModel?.fileCount)) ? Number(report.chromiumOnDeviceHeadSuggestModel.fileCount) : null,
  } : null,
  uiChatSmokeEvidence: isUiChatSmokeReport ? {
    requestedRealTraffic: boolField(report, "requestedRealTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: asString(report.coverageKind),
    clicked: boolField(report, "clicked"),
    markerCount: has(report, "markerCount") ? report.markerCount : null,
    answerMarkerCount: has(report, "answerMarkerCount") ? report.answerMarkerCount : null,
    composerCleared: boolField(report, "composerCleared"),
    activeReconnectSeen: boolField(report, "activeReconnectSeen"),
    sessionLockActive: report.antigravitySessionLock && has(report.antigravitySessionLock, "active") ? !!report.antigravitySessionLock.active : null,
    sessionLockQueued: report.antigravitySessionLock && has(report.antigravitySessionLock, "queued") ? report.antigravitySessionLock.queued : null,
  } : null,
  uiWebSearchSmokeEvidence: isUiWebSearchSmokeReport ? {
    requestedRealTraffic: boolField(report, "requestedRealTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: asString(report.coverageKind),
    clicked: boolField(report, "clicked"),
    markerCount: has(report, "markerCount") ? report.markerCount : null,
    answerMarkerCount: has(report, "answerMarkerCount") ? report.answerMarkerCount : null,
    composerCleared: boolField(report, "composerCleared"),
    activeReconnectSeen: boolField(report, "activeReconnectSeen"),
    sessionLockClear: boolField(report, "sessionLockClear"),
    hasSourceUrls: /https?:\/\//i.test(asString(report.lastSample)),
  } : null,
  uiLocalProjectEvidence: isUiLocalProjectSmokeReport ? {
    requestedRealTraffic: boolField(report, "requestedRealTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: asString(report.coverageKind),
    clicked: boolField(report, "clicked"),
    markerCount: has(report, "markerCount") ? report.markerCount : null,
    answerMarkerCount: has(report, "answerMarkerCount") ? report.answerMarkerCount : null,
    composerCleared: boolField(report, "composerCleared"),
    activeReconnectSeen: boolField(report, "activeReconnectSeen"),
    sessionLockClear: boolField(report, "sessionLockClear"),
    artifactDir: asString(report.artifactDir),
    artifactFiles: report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence.files || null : null,
    artifactDoneExact: report.artifactEvidence && has(report.artifactEvidence, "doneExact") ? !!report.artifactEvidence.doneExact : null,
    artifactIndexHasMarker: report.artifactEvidence && has(report.artifactEvidence, "indexHasMarker") ? !!report.artifactEvidence.indexHasMarker : null,
    artifactReadmeNonEmpty: report.artifactEvidence && has(report.artifactEvidence, "readmeNonEmpty") ? !!report.artifactEvidence.readmeNonEmpty : null,
  } : null,
  uiCodingProjectEvidence: isUiCodingProjectSmokeReport ? {
    requestedRealTraffic: boolField(report, "requestedRealTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: asString(report.coverageKind),
    clicked: boolField(report, "clicked"),
    markerCount: has(report, "markerCount") ? report.markerCount : null,
    answerMarkerCount: has(report, "answerMarkerCount") ? report.answerMarkerCount : null,
    composerCleared: boolField(report, "composerCleared"),
    activeReconnectSeen: boolField(report, "activeReconnectSeen"),
    sessionLockClear: boolField(report, "sessionLockClear"),
    artifactDir: asString(report.artifactDir),
    artifactFiles: report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence.files || null : null,
    artifactDoneExact: report.artifactEvidence && has(report.artifactEvidence, "doneExact") ? !!report.artifactEvidence.doneExact : null,
    exportsFunction: report.artifactEvidence && has(report.artifactEvidence, "exportsFunction") ? !!report.artifactEvidence.exportsFunction : null,
    testPassed: report.artifactEvidence && has(report.artifactEvidence, "testPassed") ? !!report.artifactEvidence.testPassed : null,
    cliPassed: report.artifactEvidence && has(report.artifactEvidence, "cliPassed") ? !!report.artifactEvidence.cliPassed : null,
    cliJson: report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence.cliJson || null : null,
  } : null,
  uiMultiTurnProjectEvidence: isUiMultiTurnProjectSmokeReport ? {
    requestedRealTraffic: boolField(report, "requestedRealTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: asString(report.coverageKind),
    clicked: boolField(report, "clicked"),
    markerCount: has(report, "markerCount") ? report.markerCount : null,
    answerMarkerCount: has(report, "answerMarkerCount") ? report.answerMarkerCount : null,
    turnCount: Array.isArray(report.turnEvidence) ? report.turnEvidence.length : null,
    turnFailures: Array.isArray(report.turnEvidence) ? report.turnEvidence.reduce((sum, turn) => sum + (Array.isArray(turn?.failures) ? turn.failures.length : 0), 0) : null,
    composerCleared: boolField(report, "composerCleared"),
    activeReconnectSeen: boolField(report, "activeReconnectSeen"),
    sessionLockClear: boolField(report, "sessionLockClear"),
    artifactDir: asString(report.artifactDir),
    artifactFiles: report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence.files || null : null,
    firstDoneExact: report.artifactEvidence && has(report.artifactEvidence, "firstDoneExact") ? !!report.artifactEvidence.firstDoneExact : null,
    followupExact: report.artifactEvidence && has(report.artifactEvidence, "followupExact") ? !!report.artifactEvidence.followupExact : null,
    changelogHasFinalMarker: report.artifactEvidence && has(report.artifactEvidence, "changelogHasFinalMarker") ? !!report.artifactEvidence.changelogHasFinalMarker : null,
    exportsTallyWords: report.artifactEvidence && has(report.artifactEvidence, "exportsTallyWords") ? !!report.artifactEvidence.exportsTallyWords : null,
    exportsUniqueWords: report.artifactEvidence && has(report.artifactEvidence, "exportsUniqueWords") ? !!report.artifactEvidence.exportsUniqueWords : null,
    testPassed: report.artifactEvidence && has(report.artifactEvidence, "testPassed") ? !!report.artifactEvidence.testPassed : null,
    cliPassed: report.artifactEvidence && has(report.artifactEvidence, "cliPassed") ? !!report.artifactEvidence.cliPassed : null,
    cliJson: report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence.cliJson || null : null,
  } : null,
  uiRepoFileEditEvidence: isUiRepoFileEditSmokeReport ? {
    requestedRealTraffic: boolField(report, "requestedRealTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: asString(report.coverageKind),
    clicked: boolField(report, "clicked"),
    markerCount: has(report, "markerCount") ? report.markerCount : null,
    answerMarkerCount: has(report, "answerMarkerCount") ? report.answerMarkerCount : null,
    composerCleared: boolField(report, "composerCleared"),
    activeReconnectSeen: boolField(report, "activeReconnectSeen"),
    sessionLockClear: boolField(report, "sessionLockClear"),
    artifactDir: asString(report.artifactDir),
    artifactFiles: report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence.files || null : null,
    testPassed: report.artifactEvidence && has(report.artifactEvidence, "testPassed") ? !!report.artifactEvidence.testPassed : null,
    sourceHasLowercase: report.artifactEvidence && has(report.artifactEvidence, "sourceHasLowercase") ? !!report.artifactEvidence.sourceHasLowercase : null,
    sourceHandlesInvalidChars: report.artifactEvidence && has(report.artifactEvidence, "sourceHandlesInvalidChars") ? !!report.artifactEvidence.sourceHandlesInvalidChars : null,
    sourceTrimsHyphens: report.artifactEvidence && has(report.artifactEvidence, "sourceTrimsHyphens") ? !!report.artifactEvidence.sourceTrimsHyphens : null,
  } : null,
  uiRepoMultiFileEditEvidence: isUiRepoMultiFileEditSmokeReport ? {
    requestedRealTraffic: boolField(report, "requestedRealTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: asString(report.coverageKind),
    clicked: boolField(report, "clicked"),
    markerCount: has(report, "markerCount") ? report.markerCount : null,
    answerMarkerCount: has(report, "answerMarkerCount") ? report.answerMarkerCount : null,
    composerCleared: boolField(report, "composerCleared"),
    activeReconnectSeen: boolField(report, "activeReconnectSeen"),
    sessionLockClear: boolField(report, "sessionLockClear"),
    artifactDir: asString(report.artifactDir),
    artifactFiles: report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence.files || null : null,
    exportsNormalizeStatus: report.artifactEvidence && has(report.artifactEvidence, "exportsNormalizeStatus") ? !!report.artifactEvidence.exportsNormalizeStatus : null,
    exportsSummarizeRecords: report.artifactEvidence && has(report.artifactEvidence, "exportsSummarizeRecords") ? !!report.artifactEvidence.exportsSummarizeRecords : null,
    exportsRenderSummaryHtml: report.artifactEvidence && has(report.artifactEvidence, "exportsRenderSummaryHtml") ? !!report.artifactEvidence.exportsRenderSummaryHtml : null,
    sourceChangedFromFixture: report.artifactEvidence && has(report.artifactEvidence, "sourceChangedFromFixture") ? !!report.artifactEvidence.sourceChangedFromFixture : null,
    testUnchanged: report.artifactEvidence && has(report.artifactEvidence, "testUnchanged") ? !!report.artifactEvidence.testUnchanged : null,
    dataUnchanged: report.artifactEvidence && has(report.artifactEvidence, "dataUnchanged") ? !!report.artifactEvidence.dataUnchanged : null,
    testPassed: report.artifactEvidence && has(report.artifactEvidence, "testPassed") ? !!report.artifactEvidence.testPassed : null,
    cliPassed: report.artifactEvidence && has(report.artifactEvidence, "cliPassed") ? !!report.artifactEvidence.cliPassed : null,
    htmlComplete: report.artifactEvidence && has(report.artifactEvidence, "htmlComplete") ? !!report.artifactEvidence.htmlComplete : null,
    htmlHasChinese: report.artifactEvidence && has(report.artifactEvidence, "htmlHasChinese") ? !!report.artifactEvidence.htmlHasChinese : null,
    htmlMentionsStatuses: report.artifactEvidence && has(report.artifactEvidence, "htmlMentionsStatuses") ? !!report.artifactEvidence.htmlMentionsStatuses : null,
    htmlAvoidsObjectObject: report.artifactEvidence && has(report.artifactEvidence, "htmlAvoidsObjectObject") ? !!report.artifactEvidence.htmlAvoidsObjectObject : null,
    readmeHasChinese: report.artifactEvidence && has(report.artifactEvidence, "readmeHasChinese") ? !!report.artifactEvidence.readmeHasChinese : null,
    readmeMentionsCommand: report.artifactEvidence && has(report.artifactEvidence, "readmeMentionsCommand") ? !!report.artifactEvidence.readmeMentionsCommand : null,
    firstTurnSettle: asRepoMultiSettleEvidence(report.firstTurnSettle),
    finalTurnSettle: asRepoMultiSettleEvidence(report.finalTurnSettle),
  } : null,
  uiComplexProjectEvidence: isUiComplexProjectSmokeReport ? {
    requestedRealTraffic: boolField(report, "requestedRealTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: asString(report.coverageKind),
    clicked: boolField(report, "clicked"),
    markerCount: has(report, "markerCount") ? report.markerCount : null,
    answerMarkerCount: has(report, "answerMarkerCount") ? report.answerMarkerCount : null,
    composerCleared: boolField(report, "composerCleared"),
    activeReconnectSeen: boolField(report, "activeReconnectSeen"),
    sessionLockClear: boolField(report, "sessionLockClear"),
    artifactDir: asString(report.artifactDir),
    artifactFiles: report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence.files || null : null,
    artifactDoneExact: report.artifactEvidence && has(report.artifactEvidence, "doneExact") ? !!report.artifactEvidence.doneExact : null,
    exportsFunction: report.artifactEvidence && has(report.artifactEvidence, "exportsFunction") ? !!report.artifactEvidence.exportsFunction : null,
    testPassed: report.artifactEvidence && has(report.artifactEvidence, "testPassed") ? !!report.artifactEvidence.testPassed : null,
    cliPassed: report.artifactEvidence && has(report.artifactEvidence, "cliPassed") ? !!report.artifactEvidence.cliPassed : null,
    cliJson: report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence.cliJson || null : null,
    sourceUrlCount: report.artifactEvidence && has(report.artifactEvidence, "sourceUrlCount") ? report.artifactEvidence.sourceUrlCount : null,
    reportUrlCount: report.artifactEvidence && has(report.artifactEvidence, "reportUrlCount") ? report.artifactEvidence.reportUrlCount : null,
    htmlUrlCount: report.artifactEvidence && has(report.artifactEvidence, "htmlUrlCount") ? report.artifactEvidence.htmlUrlCount : null,
    sharedUrlCount: report.artifactEvidence && has(report.artifactEvidence, "sharedUrlCount") ? report.artifactEvidence.sharedUrlCount : null,
    htmlComplete: report.artifactEvidence && has(report.artifactEvidence, "htmlComplete") ? !!report.artifactEvidence.htmlComplete : null,
    htmlLinksReport: report.artifactEvidence && has(report.artifactEvidence, "htmlLinksReport") ? !!report.artifactEvidence.htmlLinksReport : null,
  } : null,
  uiReportSiteEvidence: isUiReportSiteSmokeReport ? {
    requestedRealTraffic: boolField(report, "requestedRealTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: asString(report.coverageKind),
    clicked: boolField(report, "clicked"),
    markerCount: has(report, "markerCount") ? report.markerCount : null,
    answerMarkerCount: has(report, "answerMarkerCount") ? report.answerMarkerCount : null,
    composerCleared: boolField(report, "composerCleared"),
    activeReconnectSeen: boolField(report, "activeReconnectSeen"),
    sessionLockClear: boolField(report, "sessionLockClear"),
    artifactDir: asString(report.artifactDir),
    artifactFiles: report.artifactEvidence && typeof report.artifactEvidence === "object" ? report.artifactEvidence.files || null : null,
    artifactDoneExact: report.artifactEvidence && has(report.artifactEvidence, "doneExact") ? !!report.artifactEvidence.doneExact : null,
    reportHasMarker: report.artifactEvidence && has(report.artifactEvidence, "reportHasMarker") ? !!report.artifactEvidence.reportHasMarker : null,
    htmlHasMarker: report.artifactEvidence && has(report.artifactEvidence, "htmlHasMarker") ? !!report.artifactEvidence.htmlHasMarker : null,
    reportHasChinese: report.artifactEvidence && has(report.artifactEvidence, "reportHasChinese") ? !!report.artifactEvidence.reportHasChinese : null,
    htmlHasChinese: report.artifactEvidence && has(report.artifactEvidence, "htmlHasChinese") ? !!report.artifactEvidence.htmlHasChinese : null,
    reportMentionsCodex: report.artifactEvidence && has(report.artifactEvidence, "reportMentionsCodex") ? !!report.artifactEvidence.reportMentionsCodex : null,
    htmlMentionsCodex: report.artifactEvidence && has(report.artifactEvidence, "htmlMentionsCodex") ? !!report.artifactEvidence.htmlMentionsCodex : null,
    reportUrlCount: report.artifactEvidence && has(report.artifactEvidence, "reportUrlCount") ? report.artifactEvidence.reportUrlCount : null,
    htmlUrlCount: report.artifactEvidence && has(report.artifactEvidence, "htmlUrlCount") ? report.artifactEvidence.htmlUrlCount : null,
    sharedUrlCount: report.artifactEvidence && has(report.artifactEvidence, "sharedUrlCount") ? report.artifactEvidence.sharedUrlCount : null,
    htmlComplete: report.artifactEvidence && has(report.artifactEvidence, "htmlComplete") ? !!report.artifactEvidence.htmlComplete : null,
    htmlLinksReport: report.artifactEvidence && has(report.artifactEvidence, "htmlLinksReport") ? !!report.artifactEvidence.htmlLinksReport : null,
  } : null,
  antigravityCliProfilePrepareEvidence: isAntigravityCliProfilePrepareReport ? {
    reportName: has(report, "reportName") ? asString(report.reportName) : null,
    separateAccountVerified: boolField(report, "separateAccountVerified"),
    accountIsolationBoundary: has(report, "accountIsolationBoundary") ? asString(report.accountIsolationBoundary) : null,
    accountIsolationCaveat: has(report, "accountIsolationCaveat") ? asString(report.accountIsolationCaveat) : null,
  } : null,
  antigravityCliRealSmokeEvidence: isAntigravityCliRealSmokeReport ? {
    reportName: has(report, "reportName") ? asString(report.reportName) : null,
    requestedRealTraffic: boolField(report, "requestedRealTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    coverageKind: has(report, "coverageKind") ? asString(report.coverageKind) : null,
    separateAccountVerified: boolField(report, "separateAccountVerified"),
    accountIsolationBoundary: has(report, "accountIsolationBoundary") ? asString(report.accountIsolationBoundary) : null,
    accountIsolationCaveat: has(report, "accountIsolationCaveat") ? asString(report.accountIsolationCaveat) : null,
    preparationReport: report.preparationReport && typeof report.preparationReport === "object" ? {
      profileMatched: boolField(report.preparationReport, "profileMatched"),
    } : null,
  } : null,
  skipRequests: boolField(report, "skipRequests"),
  modelRoutingEvidence: has(report, "skipRequests") || modelRoutingResults.length ? {
    mode: asString(report.mode),
    providerProtocol: asString(report.providerProtocol),
    providerModel: asString(report.providerModel),
    toolBridgeMode: report.toolBridge && typeof report.toolBridge === "object" ? asString(report.toolBridge.mode) : null,
    resultCount: modelRoutingResults.length,
    skippedRequestCount: modelRoutingResults.filter((item) => item && item.skippedRequest === true).length,
    failedResultCount: modelRoutingResults.filter((item) => item && item.ok !== true).length,
    resultErrorCount: modelRoutingResults.filter((item) => item && item.error).length,
  } : null,
  toolBridgeEvidence: toolBridge || compatibilityTools || nativeToolCapability ? {
    mode: toolBridge && has(toolBridge, "mode") ? asString(toolBridge.mode) : null,
    transport: toolBridge && has(toolBridge, "transport") ? asString(toolBridge.transport) : null,
    localAdapter: toolBridge && has(toolBridge, "localAdapter") ? asString(toolBridge.localAdapter) : null,
    nativeAntigravityToolEvents: toolBridge ? boolField(toolBridge, "nativeAntigravityToolEvents") : null,
    nativeMcpDiscoveryVerified: toolBridge ? boolField(toolBridge, "nativeMcpDiscoveryVerified") : null,
    nativeBridgeDefaultEnabled: toolBridge ? boolField(toolBridge, "nativeBridgeDefaultEnabled") : null,
    acceptsExternalToolDefinitions: toolBridge ? boolField(toolBridge, "acceptsExternalToolDefinitions") : null,
    compatibilityBridge: compatibilityTools && has(compatibilityTools, "bridge") ? asString(compatibilityTools.bridge) : null,
    requestEnvelope: nativeToolCapability && has(nativeToolCapability, "requestEnvelope") ? asString(nativeToolCapability.requestEnvelope) : null,
    externalToolDefinitionsField: nativeToolCapability && has(nativeToolCapability, "externalToolDefinitionsField") ? asString(nativeToolCapability.externalToolDefinitionsField) : null,
    externalToolDefinitionsUsable: nativeToolCapability ? boolField(nativeToolCapability, "externalToolDefinitionsUsable") : null,
    schemaLikeRequestAcceptance: nativeToolCapability && has(nativeToolCapability, "schemaLikeRequestAcceptance") ? asString(nativeToolCapability.schemaLikeRequestAcceptance) : null,
    nativeMcpToolCallStatus: nativeToolCapability && has(nativeToolCapability, "nativeMcpToolCallStatus") ? asString(nativeToolCapability.nativeMcpToolCallStatus) : null,
    nativeMcpApprovalProtocolVerified: nativeToolCapability ? boolField(nativeToolCapability, "nativeMcpApprovalProtocolVerified") : null,
    nativeMcpPermissionMode: nativeToolCapability && has(nativeToolCapability, "nativeMcpPermissionMode") ? asString(nativeToolCapability.nativeMcpPermissionMode) : null,
    sameCascadeResumeProbeVerified: nativeToolCapability ? boolField(nativeToolCapability, "sameCascadeResumeProbeVerified") : null,
    antigravityOwnedToolsDisabled: nativeToolCapability ? boolField(nativeToolCapability, "antigravityOwnedToolsDisabled") : null,
    permissionPromptsDisabled: nativeToolCapability ? boolField(nativeToolCapability, "permissionPromptsDisabled") : null,
    disabledToolCount: nativeToolCapability && has(nativeToolCapability, "disabledToolCount") ? nativeToolCapability.disabledToolCount : null,
    codexToolBridge: nativeToolCapability && has(nativeToolCapability, "codexToolBridge") ? asString(nativeToolCapability.codexToolBridge) : null,
  } : null,
  uiIdleEvidence: has(report, "sampleCount") || uiIdleSamples.length ? {
    durationSec: has(report, "durationSec") ? report.durationSec : null,
    intervalSec: has(report, "intervalSec") ? report.intervalSec : null,
    sampleCount: has(report, "sampleCount") ? report.sampleCount : uiIdleSamples.length,
    sampleEntryCount: uiIdleSamples.length,
    healthySampleCount: uiIdleSamples.filter((item) => item && item.healthOk === true && item.accountReady === true && item.uiOk === true).length,
    reconnectTextCount: uiIdleSamples.filter((item) => item && item.hasReconnectText === true).length,
    loginTextCount: uiIdleSamples.filter((item) => item && item.hasLoginText === true).length,
    missingModelTextCount: uiIdleSamples.filter((item) => !item || !item.matchedModelText).length,
  } : null,
  syncReadinessEvidence: sync || activeHost ? {
    noTrafficReady: report.reportName === "sync-readiness" && report.noTraffic === true && report.usedRealTraffic === false && report.behaviorCovered === true && report.coverageKind === "installed-no-traffic",
    fullMode: report.fast === false && report.skipIconPaletteProbe === false,
    clientSyncMode: report.clientSyncContract && has(report.clientSyncContract, "mode") ? asString(report.clientSyncContract.mode) : null,
    clientSyncMaintenancePath: report.clientSyncContract && has(report.clientSyncContract, "maintenancePath") ? asString(report.clientSyncContract.maintenancePath) : null,
    nativeClientBehaviorCarriedByHostSync: report.clientSyncContract ? boolField(report.clientSyncContract, "nativeClientBehaviorCarriedByHostSync") : null,
    forbidsFeatureByFeatureReimplementation: report.clientSyncContract ? boolField(report.clientSyncContract, "forbidsFeatureByFeatureReimplementation") : null,
    sourcePackageName: report.clientSyncContract && has(report.clientSyncContract, "sourcePackageName") ? asString(report.clientSyncContract.sourcePackageName) : (updateStatus?.source && has(updateStatus.source, "packageName") ? asString(updateStatus.source.packageName) : null),
    activeSourcePackageName: report.clientSyncContract && has(report.clientSyncContract, "activeSourcePackageName") ? asString(report.clientSyncContract.activeSourcePackageName) : (activeHost && has(activeHost, "sourcePackageName") ? asString(activeHost.sourcePackageName) : null),
    clientSyncHostHashMatches: report.clientSyncContract ? boolField(report.clientSyncContract, "sourceHostHashMatches") : null,
    clientSyncCliHashMatches: report.clientSyncContract ? boolField(report.clientSyncContract, "sourceCliHashMatches") : null,
    antiCodexPatchScope: Array.isArray(report.clientSyncContract?.antiCodexPatchScope) ? report.clientSyncContract.antiCodexPatchScope.map(asString).filter(Boolean) : [],
    codexVersion: activeHost && has(activeHost, "codexVersion") ? asString(activeHost.codexVersion) : null,
    sourcePackageVersion: report.clientSyncContract && has(report.clientSyncContract, "sourcePackageVersion") ? asString(report.clientSyncContract.sourcePackageVersion) : (updateStatus?.source && has(updateStatus.source, "packageVersion") ? asString(updateStatus.source.packageVersion) : (activeHost && has(activeHost, "sourcePackageVersion") ? asString(activeHost.sourcePackageVersion) : null)),
    activeSourcePackageVersion: report.clientSyncContract && has(report.clientSyncContract, "activeSourcePackageVersion") ? asString(report.clientSyncContract.activeSourcePackageVersion) : (updateStatus?.active && has(updateStatus.active, "packageVersion") ? asString(updateStatus.active.packageVersion) : null),
    clientSyncVersionMatches: report.clientSyncContract && has(report.clientSyncContract, "sourcePackageVersion") && has(report.clientSyncContract, "activeSourcePackageVersion")
      ? asString(report.clientSyncContract.sourcePackageVersion) === asString(report.clientSyncContract.activeSourcePackageVersion)
      : null,
    activeHostReady: !!activeHost && activeHost.exists === true && activeHost.markerExists === true && activeHost.manifestValid === true && activeHost.exeExists === true,
    brandReady: activeHost?.productName === "Anti-Codex" && activeHost?.fileDescription === "Anti-Codex" && activeHost?.originalFilename === "Anti-Codex.exe",
    iconReady: activeHost?.hostIconExists === true && activeHost?.trayIconExists === true && activeHost?.appRootIconExists === true && activeHost?.hostIconPalette?.ok === true && activeHost?.trayIconPalette?.ok === true && activeHost?.appRootIconPalette?.ok === true && (!sync?.desktopShortcutIconPalette || sync.desktopShortcutIconPalette.ok === true),
    syncScriptsReady: !!sync && sync.scriptExists === true && sync.launcherExists === true && sync.rollbackScriptExists === true && sync.rollbackLauncherExists === true && sync.updateCheckExists === true && sync.validatorExists === true && sync.failureSafetyVerifierExists === true && sync.installerExists === true && sync.startScriptExists === true,
    updateStatusSource: sync && has(sync, "updateStatusSource") ? asString(sync.updateStatusSource) : null,
    updateStatusReason: updateStatus && has(updateStatus, "reason") ? asString(updateStatus.reason) : null,
    updateDriftState: updateStatus?.drift && has(updateStatus.drift, "state") ? asString(updateStatus.drift.state) : null,
    updateDriftHostChanged: updateStatus?.drift ? boolField(updateStatus.drift, "hostChanged") : null,
    updateDriftCliChanged: updateStatus?.drift ? boolField(updateStatus.drift, "cliChanged") : null,
    activePackageVersion: updateStatus?.drift && has(updateStatus.drift, "activePackageVersion") ? asString(updateStatus.drift.activePackageVersion) : null,
    sourceHostHash: updateStatus?.source && has(updateStatus.source, "hostHash") ? asString(updateStatus.source.hostHash) : null,
    activeHostHash: updateStatus?.active && has(updateStatus.active, "hostHash") ? asString(updateStatus.active.hostHash) : null,
    sourceCliHash: updateStatus?.source && has(updateStatus.source, "cliHash") ? asString(updateStatus.source.cliHash) : null,
    activeCliHash: updateStatus?.active && has(updateStatus.active, "cliHash") ? asString(updateStatus.active.cliHash) : null,
    hostHashMatches: updateStatus?.source?.hostHash && updateStatus?.active?.hostHash ? updateStatus.source.hostHash === updateStatus.active.hostHash : null,
    cliHashMatches: updateStatus?.source?.cliHash && updateStatus?.active?.cliHash ? updateStatus.source.cliHash === updateStatus.active.cliHash : null,
    updateReady: updateStatus?.ok === true && updateStatus?.updateNeeded === false && updateStatus?.drift?.state === "synced",
    guardrailsReady: updateGuardrails?.brandPreserved === true && updateGuardrails?.iconPreserved === true && updateGuardrails?.activeHostValid === true && Array.isArray(updateGuardrails?.failures) && updateGuardrails.failures.length === 0,
    shortcutCount: shortcutVerification.length,
    shortcutReadyCount: shortcutVerification.filter((item) => item && item.ok === true && item.exists === true && item.displayNameMatches === true && item.targetMatches === true && item.launcherTargetMatches === true && item.scriptMatches === true && item.iconMatches === true && item.forbiddenCodexBranding !== true).length,
    desktopShortcutCount: Array.isArray(sync?.desktopAntiCodexShortcuts) ? sync.desktopAntiCodexShortcuts.length : null,
    forbiddenDesktopHelperCount: Array.isArray(sync?.forbiddenDesktopHelperShortcuts) ? sync.forbiddenDesktopHelperShortcuts.length : null,
    managerBridgeProcessCount: managerBridge && has(managerBridge, "processCount") ? managerBridge.processCount : null,
    managerBridgeStaleProcessCount: managerBridge && has(managerBridge, "staleProcessCount") ? managerBridge.staleProcessCount : null,
    managerBridgeReady: !!managerBridge && Number(managerBridge.processCount) === 1 && Number(managerBridge.staleProcessCount) === 0 && Array.isArray(managerBridge.processes) && managerBridge.processes.every((item) => item && item.hasExpectedBaseUrl === true),
    cleanSyncState: sync?.hostSyncMarkerExists === false && sync?.staleCandidateExists === false && sync?.rollbackHostExists === true && sync?.rollbackMarkerExists === true,
  } : null,
  installedOverallEvidence: report.reportName === "installed-overall" || report.reportName === "installed-overall-fast" ? {
    reportName: asString(report.reportName),
    fast: boolField(report, "fast"),
    noTraffic: boolField(report, "noTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: has(report, "coverageKind") ? asString(report.coverageKind) : null,
    fastMaxElapsedMs: has(report, "fastMaxElapsedMs") ? report.fastMaxElapsedMs : null,
    elapsedMs: has(report, "elapsedMs") ? report.elapsedMs : null,
    checkCount: checkEntries.length,
    okCheckCount: checkEntries.filter((entry) => entry.value.ok === true).length,
    failedCheckCount: checkEntries.filter((entry) => entry.value.ok !== true).length,
    skippedCheckCount: skippedCheckEntries.length,
    skippedChecks: skippedCheckEntries.map((entry) => entry.id).sort(),
    missingSkipMetadataCount: skippedCheckEntries.filter((entry) => !entry.value.reason || !entry.value.coveredBy).length,
    realTrafficSkippedChecks: skippedCheckEntries.filter((entry) => entry.id === "realMiniTool" || entry.id === "realWork" || entry.id === "realSmallProject").map((entry) => entry.id).sort(),
    modelTextTransport: has(report.health || {}, "modelTextTransport") ? asString(report.health.modelTextTransport) : null,
    modelDiscoverySource: has(report.health || {}, "modelDiscoverySource") ? asString(report.health.modelDiscoverySource) : null,
    antigravityCoworkerDefault: has(report.health || {}, "antigravityCoworkerDefault") ? boolField(report.health, "antigravityCoworkerDefault") : null,
  } : null,
  coldRelaunchEvidence: report.reportName === "cold-relaunch" ? {
    healthOk: boolField(report.health || {}, "ok"),
    providerReady: boolField(report.health || {}, "providerReady"),
    mode: asString(report.health?.mode),
    upstream: asString(report.health?.upstream),
    modelCount: has(report.health || {}, "modelCount") ? report.health.modelCount : null,
    mainCount: has(report.processes || {}, "mainCount") ? report.processes.mainCount : null,
    translatorCount: has(report.processes || {}, "translatorCount") ? report.processes.translatorCount : null,
    launcherCount: has(report.processes || {}, "launcherCount") ? report.processes.launcherCount : null,
    launcherStarted: boolField(report.launcher || {}, "started"),
    launcherHasExited: has(report.launcher || {}, "hasExited") ? report.launcher.hasExited : null,
    launcherExitCode: has(report.launcher || {}, "exitCode") ? report.launcher.exitCode : null,
    launcherStdoutTail: asString(report.launcher?.stdoutTail),
    launcherStderrTail: asString(report.launcher?.stderrTail),
    originalCodexUnchanged: boolField(report.originalCodex || {}, "unchanged"),
    stageCount: Array.isArray(report.stages) ? report.stages.length : 0,
    failedStageCount: Array.isArray(report.stages) ? report.stages.filter((stage) => !stage || stage.ok !== true).length : 0,
  } : null,
  stabilitySoakEvidence: report.reportName === "stability-soak" ? {
    mode: asString(report.mode),
    model: asString(report.model),
    providerReady: boolField(report, "providerReady"),
    startReady: boolField(report, "startReady"),
    endReady: boolField(report, "endReady"),
    modelCount: has(report, "modelCount") ? report.modelCount : null,
    pidStable: boolField(report, "pidStable"),
    startPid: has(report, "startPid") ? report.startPid : null,
    endPid: has(report, "endPid") ? report.endPid : null,
    healthChecks: has(report, "healthChecks") ? report.healthChecks : null,
    turnCount: Array.isArray(report.turns) ? report.turns.length : 0,
    failedTurnCount: Array.isArray(report.turns) ? report.turns.filter((turn) => !turn || turn.ok !== true).length : 0,
    elapsedMs: has(report, "elapsedMs") ? report.elapsedMs : null,
  } : null,
  state: has(report, "state") ? asString(report.state) : null,
  skipped: boolField(report, "skipped"),
  reason: has(report, "reason") ? asString(report.reason) : null,
  coveredBy: has(report, "coveredBy") ? asString(report.coveredBy) : null,
  behaviorCovered: boolField(report, "behaviorCovered"),
  coverageKind: has(report, "coverageKind") ? asString(report.coverageKind) : null,
  usedRealTraffic: boolField(report, "usedRealTraffic"),
  requestedRealTraffic: boolField(report, "requestedRealTraffic"),
  latestDiagnosis: wait && has(wait, "latestDiagnosis") ? asString(wait.latestDiagnosis) : null,
  latestDiagnosisDetail: latestWait && has(latestWait, "diagnosisDetail") ? asString(latestWait.diagnosisDetail) : null,
  accountProxyEvidence: isAccountProxyReport ? {
    diagnosisDetail: has(report, "diagnosisDetail") ? asString(report.diagnosisDetail) : null,
    suggestedAction: has(report, "suggestedAction") ? asString(report.suggestedAction) : null,
    localProxyBypassed: boolField(report, "localProxyBypassed"),
    phaseSummary: phaseSummary ? {
      accountOk: boolField(phaseSummary, "accountOk"),
      refreshOk: boolField(phaseSummary, "refreshOk"),
      modelCount: has(phaseSummary, "modelCount") ? phaseSummary.modelCount : null,
      realRequestAttempted: boolField(phaseSummary, "realRequestAttempted"),
      realRequestOk: boolField(phaseSummary, "realRequestOk"),
      accountError: has(phaseSummary, "accountError") ? asString(phaseSummary.accountError) : null,
      refreshError: has(phaseSummary, "refreshError") ? asString(phaseSummary.refreshError) : null,
      realRequestError: has(phaseSummary, "realRequestError") ? asString(phaseSummary.realRequestError) : null,
    } : null,
    antigravityLogSignals: antigravityLogSignals ? {
      sourcePresent: boolField(antigravityLogSignals, "sourcePresent"),
      sourceFresh: boolField(antigravityLogSignals, "sourceFresh"),
      tailLinesScanned: has(antigravityLogSignals, "tailLinesScanned") ? antigravityLogSignals.tailLinesScanned : null,
      verificationRequiredCount: has(antigravityLogSignals, "verificationRequiredCount") ? antigravityLogSignals.verificationRequiredCount : null,
      tokenRefreshMissingCount: has(antigravityLogSignals, "tokenRefreshMissingCount") ? antigravityLogSignals.tokenRefreshMissingCount : null,
      oauthNetworkFailureCount: has(antigravityLogSignals, "oauthNetworkFailureCount") ? antigravityLogSignals.oauthNetworkFailureCount : null,
      generalNetworkFailureCount: has(antigravityLogSignals, "generalNetworkFailureCount") ? antigravityLogSignals.generalNetworkFailureCount : null,
    } : null,
  } : null,
  attempts: wait && has(wait, "attempts") ? wait.attempts : null,
  repairedCount: has(report, "repairedCount") ? report.repairedCount : null,
  repairedAt: has(report, "repairedAt") ? asString(report.repairedAt) : null,
  sourceSnapshotEvidence: report.sourceSnapshot && typeof report.sourceSnapshot === "object" ? {
    fingerprint: has(report.sourceSnapshot, "fingerprint") ? asString(report.sourceSnapshot.fingerprint) : null,
    sourceMtimeMax: has(report.sourceSnapshot, "sourceMtimeMax") ? asString(report.sourceSnapshot.sourceMtimeMax) : null,
    fileCount: has(report.sourceSnapshot, "fileCount") ? report.sourceSnapshot.fileCount : null,
    cacheHitCount: has(report.sourceSnapshot, "cacheHitCount") ? report.sourceSnapshot.cacheHitCount : null,
    cacheMissCount: has(report.sourceSnapshot, "cacheMissCount") ? report.sourceSnapshot.cacheMissCount : null,
    reusedFromPreviousReport: has(report.sourceSnapshot, "reusedFromPreviousReport") ? !!report.sourceSnapshot.reusedFromPreviousReport : null,
    refreshSkippedReason: has(report.sourceSnapshot, "refreshSkippedReason") ? asString(report.sourceSnapshot.refreshSkippedReason) : null,
  } : null,
  logDbGuardEvidence: isLogDbGuardReport ? {
    reportName: has(report, "reportName") ? asString(report.reportName) : null,
    noTraffic: boolField(report, "noTraffic"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: has(report, "coverageKind") ? asString(report.coverageKind) : null,
    exists: boolField(report, "exists"),
    logsTable: boolField(report, "logsTable"),
    levelColumn: boolField(report, "levelColumn"),
    triggerPresent: boolField(report, "triggerPresent"),
    protected: boolField(report, "protected"),
    walBytes: has(report, "walBytes") ? report.walBytes : null,
  } : null,
  missingHistoryEvidence: isMissingHistoryReport ? {
    reportName: has(report, "reportName") ? asString(report.reportName) : null,
    status: has(report, "status") ? report.status : null,
    errorType: has(report, "errorType") ? asString(report.errorType) : null,
    retryable: boolField(report, "retryable"),
    previousResponseIdMatched: boolField(report, "previousResponseIdMatched"),
    recoveryGuidancePresent: boolField(report, "recoveryGuidancePresent"),
    noRouteChange: boolField(report, "noRouteChange"),
    usedRealTraffic: boolField(report, "usedRealTraffic"),
    behaviorCovered: boolField(report, "behaviorCovered"),
    coverageKind: has(report, "coverageKind") ? asString(report.coverageKind) : null,
    model: has(report, "model") ? asString(report.model) : null,
    routeBeforeStatus: has(report.routeBefore || {}, "latestStatus") ? asString(report.routeBefore.latestStatus) : null,
    routeAfterStatus: has(report.routeAfter || {}, "latestStatus") ? asString(report.routeAfter.latestStatus) : null,
  } : null,
  releaseReady: boolField(report, "releaseReady"),
  shortReady: boolField(report, "shortReady"),
  releaseBlockedOnlyByRequiredRealTraffic: boolField(report, "releaseBlockedOnlyByRequiredRealTraffic"),
  requiredRealTrafficBlockedGates: has(report, "requiredRealTrafficBlockedGates") ? asStringArray(report.requiredRealTrafficBlockedGates) : [],
  strictOptionalRealTraffic: boolField(report, "strictOptionalRealTraffic"),
  optionalRealTrafficReady: boolField(report, "optionalRealTrafficReady"),
  optionalRealTrafficFailures: has(report, "optionalRealTrafficFailures") ? asStringArray(report.optionalRealTrafficFailures) : [],
  missingRequired: has(report, "missingRequired") ? asStringArray(report.missingRequired) : [],
  missingShort: has(report, "missingShort") ? asStringArray(report.missingShort) : [],
  missingOptional: has(report, "missingOptional") ? asStringArray(report.missingOptional) : [],
  damagedReports: has(report, "damagedReports") ? asStringArray(report.damagedReports) : [],
  releaseGateFailures,
  releaseGateFailureReasons,
  nextActions,
  nextActionsAvailableCount,
  nextActionsHiddenCount,
  nextActionsTruncated,
  approvalPlan,
  releaseGateGroups,
  releaseGateSelectedReports,
  installedRuntimeEvidence,
  upstreamFullUrlAccepted: boolField(report, "upstreamFullUrlAccepted"),
  unauthorizedManagerBlocked: boolField(report, "unauthorizedManagerBlocked"),
  savedWithoutHistoryLoss: boolField(report, "savedWithoutHistoryLoss"),
  restoredAntigravityWithoutHistoryLoss: boolField(report, "restoredAntigravityWithoutHistoryLoss"),
  restartedProviderWithoutHistoryLoss: boolField(report, "restartedProviderWithoutHistoryLoss"),
  switchedProviderWithoutHistoryLoss: boolField(report, "switchedProviderWithoutHistoryLoss"),
  crossProtocolWithoutHistoryLoss: boolField(report, "crossProtocolWithoutHistoryLoss"),
  reverseCrossProtocolWithoutHistoryLoss: boolField(report, "reverseCrossProtocolWithoutHistoryLoss"),
  secretsRedacted: boolField(report, "secretsRedacted"),
  localConnectorEvidence: endpointEvidence ? {
    connectors: has(endpointEvidence, "connectors") ? endpointEvidence.connectors : null,
    exposedToolsGet: has(endpointEvidence, "exposedToolsGet") ? endpointEvidence.exposedToolsGet : null,
    exposedToolsPost: has(endpointEvidence, "exposedToolsPost") ? endpointEvidence.exposedToolsPost : null,
    linkedConnectorAccessible: boolField(endpointEvidence, "linkedConnectorAccessible"),
    allowlistedConnectorAccessible: boolField(endpointEvidence, "allowlistedConnectorAccessible"),
    allowlistedConnectorLocallyAllowlisted: boolField(endpointEvidence, "allowlistedConnectorLocallyAllowlisted"),
    chatgptInstallUrlsScrubbed: boolField(endpointEvidence, "chatgptInstallUrlsScrubbed"),
    linkEndpointsUnsupported: boolField(endpointEvidence, "linkEndpointsUnsupported"),
    upstreamRequestsBeforeLocalEndpoints: has(endpointEvidence, "upstreamRequestsBeforeLocalEndpoints") ? endpointEvidence.upstreamRequestsBeforeLocalEndpoints : null,
    upstreamRequestsAfterLocalEndpoints: has(endpointEvidence, "upstreamRequestsAfterLocalEndpoints") ? endpointEvidence.upstreamRequestsAfterLocalEndpoints : null,
    upstreamRequestsDuringLocalEndpoints: has(endpointEvidence, "upstreamRequestsDuringLocalEndpoints") ? endpointEvidence.upstreamRequestsDuringLocalEndpoints : null,
    hiddenConnectorAccessible: boolField(endpointEvidence, "hiddenConnectorAccessible"),
    exposedToolNames: has(endpointEvidence, "exposedToolNames") ? asStringArray(endpointEvidence.exposedToolNames) : [],
    connectorParityClean: connectorParity ? connectorParity.contentMatches === true : null,
    connectorSharedExists: connectorParity ? boolField(connectorParity, "sharedExists") : null,
    connectorLocalExists: connectorParity ? boolField(connectorParity, "localExists") : null,
    connectorFingerprintMatches: connectorParity && has(connectorParity, "sharedFingerprint") && has(connectorParity, "localFingerprint")
      ? asString(connectorParity.sharedFingerprint) === asString(connectorParity.localFingerprint)
      : null,
    connectorParityMissingShared: connectorParity && has(connectorParity, "missingShared") ? asStringArray(connectorParity.missingShared) : [],
    connectorParityExtraLocal: connectorParity && has(connectorParity, "extraLocal") ? asStringArray(connectorParity.extraLocal) : [],
    connectorParityChangedShared: connectorParity && has(connectorParity, "changedShared") ? asStringArray(connectorParity.changedShared) : [],
    appToolParityClean: appToolParity ? appToolParity.contentMatches === true : null,
    appToolSharedExists: appToolParity ? boolField(appToolParity, "sharedExists") : null,
    appToolLocalExists: appToolParity ? boolField(appToolParity, "localExists") : null,
    appToolFingerprintMatches: appToolParity && has(appToolParity, "sharedFingerprint") && has(appToolParity, "localFingerprint")
      ? asString(appToolParity.sharedFingerprint) === asString(appToolParity.localFingerprint)
      : null,
    appToolParityMissingShared: appToolParity && has(appToolParity, "missingShared") ? asStringArray(appToolParity.missingShared) : [],
    appToolParityExtraLocal: appToolParity && has(appToolParity, "extraLocal") ? asStringArray(appToolParity.extraLocal) : [],
    appToolParityChangedShared: appToolParity && has(appToolParity, "changedShared") ? asStringArray(appToolParity.changedShared) : [],
    appToolGetPostParityClean: appToolGetPostParity ? appToolGetPostParity.contentMatches === true : null,
    appToolGetPostParityContentMatches: appToolGetPostParity ? boolField(appToolGetPostParity, "contentMatches") : null,
    appToolGetPostMissingFromGet: appToolGetPostParity && has(appToolGetPostParity, "missingFromGet") ? asStringArray(appToolGetPostParity.missingFromGet) : [],
    appToolGetPostExtraFromGet: appToolGetPostParity && has(appToolGetPostParity, "extraFromGet") ? asStringArray(appToolGetPostParity.extraFromGet) : [],
    tempSharedHomeUsed: tempIsolation ? boolField(tempIsolation, "sharedHomeUsed") : null,
    tempCodexHomeUnderStateRoot: tempIsolation ? pathWithin(tempIsolation.codexHome, tempIsolation.stateRoot) : null,
    tempSharedCodexHomeUnderStateRoot: tempIsolation ? pathWithin(tempIsolation.sharedCodexHome, tempIsolation.stateRoot) : null,
    tempCodexHomeDistinctFromShared: tempIsolation && tempIsolation.codexHome && tempIsolation.sharedCodexHome
      ? asString(tempIsolation.codexHome).replace(/\\/g, "/").toLowerCase() !== asString(tempIsolation.sharedCodexHome).replace(/\\/g, "/").toLowerCase()
      : null,
    disclaimer: asString(report.disclaimer),
  } : null,
  pluginCapabilityEvidence: capabilities ? {
    snapshotSource: asString(capabilities.snapshotSource),
    nativeCodexWriteback: boolField(capabilities, "nativeCodexWriteback"),
    capabilityState: asString(capabilities.capabilityState),
    degraded: boolField(capabilities, "degraded"),
    connectorCount: has(capabilities, "connectorCount") ? capabilities.connectorCount : null,
    enabledConnectorCount: has(capabilities, "enabledConnectorCount") ? capabilities.enabledConnectorCount : null,
    accessibleConnectorCount: has(capabilities, "accessibleConnectorCount") ? capabilities.accessibleConnectorCount : null,
    appToolCount: has(capabilities, "appToolCount") ? capabilities.appToolCount : null,
    appToolGetCount: has(capabilities, "appToolGetCount") ? capabilities.appToolGetCount : null,
    unattributedAppToolCount: has(capabilities, "unattributedAppToolCount") ? capabilities.unattributedAppToolCount : null,
    unauthorizedAppToolCount: has(capabilities, "unauthorizedAppToolCount") ? capabilities.unauthorizedAppToolCount : null,
    appToolsNote: asString(capabilities.appToolsNote),
    smokeChecked: capabilities.smoke ? boolField(capabilities.smoke, "checked") : null,
    endpointProjectionReadable: capabilities.smoke ? boolField(capabilities.smoke, "endpointProjectionReadable") : null,
    callableState: asString(capabilities.smoke?.callableState),
    connectorParityChecked: connectorParity ? boolField(connectorParity, "checked") : null,
    connectorParitySharedCount: connectorParity && has(connectorParity, "sharedCount") ? connectorParity.sharedCount : null,
    connectorParityLocalCount: connectorParity && has(connectorParity, "localCount") ? connectorParity.localCount : null,
    connectorParityClean: connectorParity ? boolField(connectorParity, "checked") === true && emptyArrayField(connectorParity, "missingShared") && emptyArrayField(connectorParity, "extraLocal") && emptyArrayField(connectorParity, "changedShared") : null,
    connectorParityMissingShared: connectorParity && has(connectorParity, "missingShared") ? asStringArray(connectorParity.missingShared) : [],
    connectorParityExtraLocal: connectorParity && has(connectorParity, "extraLocal") ? asStringArray(connectorParity.extraLocal) : [],
    connectorParityChangedShared: connectorParity && has(connectorParity, "changedShared") ? asStringArray(connectorParity.changedShared) : [],
    appToolParityChecked: appToolParity ? boolField(appToolParity, "checked") : null,
    appToolParityClean: appToolParity ? boolField(appToolParity, "checked") === true && emptyArrayField(appToolParity, "missingShared") && emptyArrayField(appToolParity, "extraLocal") && emptyArrayField(appToolParity, "changedShared") : null,
    appToolParityMissingShared: appToolParity && has(appToolParity, "missingShared") ? asStringArray(appToolParity.missingShared) : [],
    appToolParityExtraLocal: appToolParity && has(appToolParity, "extraLocal") ? asStringArray(appToolParity.extraLocal) : [],
    appToolParityChangedShared: appToolParity && has(appToolParity, "changedShared") ? asStringArray(appToolParity.changedShared) : [],
    appToolGetPostParityClean: appToolGetPostParity ? boolField(appToolGetPostParity, "contentMatches") === true : null,
    appToolGetPostParityContentMatches: appToolGetPostParity ? boolField(appToolGetPostParity, "contentMatches") : null,
    appToolGetPostParityChecked: appToolGetPostParity ? boolField(appToolGetPostParity, "checked") : null,
    appToolGetPostMissingFromGet: appToolGetPostParity && has(appToolGetPostParity, "missingFromGet") ? asStringArray(appToolGetPostParity.missingFromGet) : [],
    appToolGetPostExtraFromGet: appToolGetPostParity && has(appToolGetPostParity, "extraFromGet") ? asStringArray(appToolGetPostParity.extraFromGet) : [],
    connectorCacheChecked: connectorCacheSmoke ? boolField(connectorCacheSmoke, "checked") : null,
    connectorCacheExists: connectorCacheSmoke ? boolField(connectorCacheSmoke, "cacheExists") : null,
    connectorCacheFileCount: connectorCacheSmoke && has(connectorCacheSmoke, "fileCount") ? connectorCacheSmoke.fileCount : null,
    connectorCacheSampleReadable: connectorCacheSmoke ? boolField(connectorCacheSmoke, "sampleReadable") : null,
    connectorCacheSampleConnectorCount: connectorCacheSmoke && has(connectorCacheSmoke, "sampleConnectorCount") ? connectorCacheSmoke.sampleConnectorCount : null,
    appToolsCacheChecked: appToolsCacheSmoke ? boolField(appToolsCacheSmoke, "checked") : null,
    appToolsCacheExists: appToolsCacheSmoke ? boolField(appToolsCacheSmoke, "cacheExists") : null,
    appToolsCacheFileCount: appToolsCacheSmoke && has(appToolsCacheSmoke, "fileCount") ? appToolsCacheSmoke.fileCount : null,
    appToolsCacheSampleReadable: appToolsCacheSmoke ? boolField(appToolsCacheSmoke, "sampleReadable") : null,
    appToolsCacheSampleToolCount: appToolsCacheSmoke && has(appToolsCacheSmoke, "sampleToolCount") ? appToolsCacheSmoke.sampleToolCount : null,
  } : null,
  mcpSkillEvidence: (mcp || skills) ? {
    hashCacheHitCount: has(report.hashCache || {}, "hitCount") ? report.hashCache.hitCount : null,
    hashCacheMissCount: has(report.hashCache || {}, "missCount") ? report.hashCache.missCount : null,
    hashCacheEntryCount: has(report.hashCache || {}, "entryCount") ? report.hashCache.entryCount : null,
    mcpCount: mcp && has(mcp, "count") ? mcp.count : null,
    mcpSharedCount: mcp && has(mcp, "sharedCount") ? mcp.sharedCount : null,
    mcpMissingShared: mcp && has(mcp, "missingShared") ? asStringArray(mcp.missingShared) : [],
    mcpMissingSharedCount: mcp && has(mcp, "missingShared") ? asStringArray(mcp.missingShared).length : null,
    mcpExtraLocal: mcp && has(mcp, "extraLocal") ? asStringArray(mcp.extraLocal) : [],
    mcpExtraLocalCount: mcp && has(mcp, "extraLocal") ? asStringArray(mcp.extraLocal).length : null,
    mcpChangedShared: mcp && has(mcp, "changedShared") ? asStringArray(mcp.changedShared) : [],
    mcpChangedSharedCount: mcp && has(mcp, "changedShared") ? asStringArray(mcp.changedShared).length : null,
    mcpChangedSharedDetails: mcp && Array.isArray(mcp.changedSharedDetails) ? mcp.changedSharedDetails : [],
    hasNodeRepl: mcp ? boolField(mcp, "hasNodeRepl") : null,
    mcpSmokePassed: mcp && mcp.smoke ? boolField(mcp.smoke, "passed") : null,
    mcpRealCallPassed: mcp && mcp.smoke && mcp.smoke.realCall ? boolField(mcp.smoke.realCall, "passed") : null,
    mcpRealListCount: mcpRealList ? mcpRealList.length : null,
    mcpRealListPassed,
    mcpRealListToolCount,
    mcpRealListServers,
    skillCount: skills && has(skills, "count") ? skills.count : null,
    skillSharedCount: skills && has(skills, "sharedCount") ? skills.sharedCount : null,
    agentsSkillCount: skills && has(skills, "agentsCount") ? skills.agentsCount : null,
    expectedSharedSkillCount: skills && has(skills, "expectedSharedCount") ? skills.expectedSharedCount : null,
    missingSharedSkills: skills && has(skills, "missingShared") ? asStringArray(skills.missingShared) : [],
    missingSharedSkillCount: skills && has(skills, "missingShared") ? asStringArray(skills.missingShared).length : null,
    extraLocalSkills: skills && has(skills, "extraLocal") ? asStringArray(skills.extraLocal) : [],
    extraLocalSkillCount: skills && has(skills, "extraLocal") ? asStringArray(skills.extraLocal).length : null,
    changedSharedSkills: skills && has(skills, "changedShared") ? asStringArray(skills.changedShared) : [],
    changedSharedSkillCount: skills && has(skills, "changedShared") ? asStringArray(skills.changedShared).length : null,
    changedSharedSkillDetails: skills && Array.isArray(skills.changedSharedDetails) ? skills.changedSharedDetails : [],
    duplicateSkillNames: skills && has(skills, "duplicateNames") ? asStringArray(skills.duplicateNames) : [],
    conflictingDuplicateSkillNames: skills && has(skills, "conflictingDuplicateNames") ? asStringArray(skills.conflictingDuplicateNames) : [],
    conflictingDuplicateSkillCount: skills && has(skills, "conflictingDuplicateNames") ? asStringArray(skills.conflictingDuplicateNames).length : null,
    skillFingerprintSkipped: skills && has(skills, "fingerprintSkipped") ? !!skills.fingerprintSkipped : null,
    skillSmokeReadable: skills && skills.smoke ? boolField(skills.smoke, "readable") : null,
    appToolRegistryExists: appToolRegistry ? boolField(appToolRegistry, "exists") : null,
    appToolRegistryContentMatches: appToolRegistry ? boolField(appToolRegistry, "contentMatches") : null,
    appToolRegistryFingerprintMatches: appToolRegistry
      ? !!asString(appToolRegistry.sharedFingerprint) && !!asString(appToolRegistry.localFingerprint) && asString(appToolRegistry.sharedFingerprint) === asString(appToolRegistry.localFingerprint)
      : null,
    appToolRegistrySharedFileCount: appToolRegistry && has(appToolRegistry, "sharedFileCount") ? appToolRegistry.sharedFileCount : null,
    appToolRegistryLocalFileCount: appToolRegistry && has(appToolRegistry, "localFileCount") ? appToolRegistry.localFileCount : null,
  } : null,
  refreshFeatureEvidence: refreshConnectorParity || refreshAppToolParity || refreshSkills || refreshGuidance ? {
    verifyOnly: boolField(report, "verifyOnly"),
    elapsedMs: has(report, "elapsedMs") ? report.elapsedMs : null,
    hashCacheHitCount: has(report.hashCache || {}, "hitCount") ? report.hashCache.hitCount : null,
    hashCacheMissCount: has(report.hashCache || {}, "missCount") ? report.hashCache.missCount : null,
    hashCacheEntryCount: has(report.hashCache || {}, "entryCount") ? report.hashCache.entryCount : null,
    connectorSharedExists: refreshConnectorParity ? boolField(refreshConnectorParity, "sharedExists") : null,
    connectorLocalExists: refreshConnectorParity ? boolField(refreshConnectorParity, "localExists") : null,
    connectorContentMatches: refreshConnectorParity ? boolField(refreshConnectorParity, "contentMatches") : null,
    connectorMissingSharedCount: refreshConnectorParity && has(refreshConnectorParity, "missingSharedCount") ? refreshConnectorParity.missingSharedCount : null,
    connectorMissingSharedSample: refreshConnectorParity && has(refreshConnectorParity, "missingSharedSample") ? asStringArray(refreshConnectorParity.missingSharedSample) : [],
    connectorExtraLocalCount: refreshConnectorParity && has(refreshConnectorParity, "extraLocalCount") ? refreshConnectorParity.extraLocalCount : null,
    connectorExtraLocalSample: refreshConnectorParity && has(refreshConnectorParity, "extraLocalSample") ? asStringArray(refreshConnectorParity.extraLocalSample) : [],
    connectorChangedSharedCount: refreshConnectorParity && has(refreshConnectorParity, "changedSharedCount") ? refreshConnectorParity.changedSharedCount : null,
    connectorChangedSharedSample: refreshConnectorParity && has(refreshConnectorParity, "changedSharedSample") ? asStringArray(refreshConnectorParity.changedSharedSample) : [],
    appToolSharedExists: refreshAppToolParity ? boolField(refreshAppToolParity, "sharedExists") : null,
    appToolLocalExists: refreshAppToolParity ? boolField(refreshAppToolParity, "localExists") : null,
    appToolContentMatches: refreshAppToolParity ? boolField(refreshAppToolParity, "contentMatches") : null,
    appToolMissingSharedCount: refreshAppToolParity && has(refreshAppToolParity, "missingSharedCount") ? refreshAppToolParity.missingSharedCount : null,
    appToolMissingSharedSample: refreshAppToolParity && has(refreshAppToolParity, "missingSharedSample") ? asStringArray(refreshAppToolParity.missingSharedSample) : [],
    appToolExtraLocalCount: refreshAppToolParity && has(refreshAppToolParity, "extraLocalCount") ? refreshAppToolParity.extraLocalCount : null,
    appToolExtraLocalSample: refreshAppToolParity && has(refreshAppToolParity, "extraLocalSample") ? asStringArray(refreshAppToolParity.extraLocalSample) : [],
    appToolChangedSharedCount: refreshAppToolParity && has(refreshAppToolParity, "changedSharedCount") ? refreshAppToolParity.changedSharedCount : null,
    appToolChangedSharedSample: refreshAppToolParity && has(refreshAppToolParity, "changedSharedSample") ? asStringArray(refreshAppToolParity.changedSharedSample) : [],
    changedExpectedSkills: refreshSkills && has(refreshSkills, "changedExpected") ? asStringArray(refreshSkills.changedExpected) : [],
    changedExpectedSkillDetails: refreshSkills && Array.isArray(refreshSkills.changedExpectedDetails) ? refreshSkills.changedExpectedDetails : [],
    guidanceChanged: refreshGuidance ? Object.entries(refreshGuidance)
      .filter(([, entry]) => entry && entry.sharedExists === true && entry.localExists === true && entry.contentMatches !== true)
      .map(([name]) => name) : [],
  } : null,
  optionalRealProviderEvidence: has(report, "firstMarkerObserved") || has(report, "secondMarkerObserved") || has(report, "historyContinuationObserved") ? {
    firstMarkerObserved: boolField(report, "firstMarkerObserved"),
    secondMarkerObserved: boolField(report, "secondMarkerObserved"),
    historyContinuationObserved: boolField(report, "historyContinuationObserved"),
    routeTransport: asString(report.routeEvidence?.transport),
    routeProviderProtocol: asString(report.routeEvidence?.providerProtocol),
    routeRequestedModel: asString(report.routeEvidence?.requestedModel),
    routeResolvedModel: asString(report.routeEvidence?.resolvedModel),
    routeStatus: asString(report.routeEvidence?.status),
    secretsRedacted: boolField(report, "secretsRedacted"),
    turns: has(report, "turns") ? report.turns : null,
  } : null,
  realProviderToAntigravityReturnEvidence: report.realProviderToAntigravityReturnEvidence && typeof report.realProviderToAntigravityReturnEvidence === "object" ? {
    requested: boolField(report.realProviderToAntigravityReturnEvidence, "requested"),
    realAntigravityTurnUsed: boolField(report.realProviderToAntigravityReturnEvidence, "realAntigravityTurnUsed"),
    returnedToAntigravityWithHistory: boolField(report.realProviderToAntigravityReturnEvidence, "returnedToAntigravityWithHistory"),
    previousResponseIdMatched: boolField(report.realProviderToAntigravityReturnEvidence, "previousResponseIdMatched"),
    markerCount: has(report.realProviderToAntigravityReturnEvidence, "markerCount") ? report.realProviderToAntigravityReturnEvidence.markerCount : null,
    missingMarkerCount: has(report.realProviderToAntigravityReturnEvidence, "missingMarkerCount") ? report.realProviderToAntigravityReturnEvidence.missingMarkerCount : null,
    returnUpstream: asString(report.realProviderToAntigravityReturnEvidence.returnUpstream),
    routeTransport: asString(report.realProviderToAntigravityReturnEvidence.routeTransport),
    requestedModel: asString(report.realProviderToAntigravityReturnEvidence.requestedModel),
    resolvedModel: asString(report.realProviderToAntigravityReturnEvidence.resolvedModel),
  } : null,
  antigravityReturnEvidence: realAntigravityEvidence ? {
    requested: boolField(realAntigravityEvidence, "requested"),
    realAntigravityTurnUsed: boolField(realAntigravityEvidence, "realAntigravityTurnUsed"),
    returnedToAntigravityWithHistory: boolField(realAntigravityEvidence, "returnedToAntigravityWithHistory"),
    previousResponseIdMatched: boolField(realAntigravityEvidence, "previousResponseIdMatched"),
    markerCount: has(realAntigravityEvidence, "markerCount") ? realAntigravityEvidence.markerCount : null,
    missingMarkerCount: has(realAntigravityEvidence, "missingMarkerCount") ? realAntigravityEvidence.missingMarkerCount : null,
    routeTransport: asString(realAntigravityEvidence.routeTransport),
    resolvedModel: asString(realAntigravityEvidence.resolvedModel),
  } : null,
  providerContinuity: multiTurnHistory ? {
    turns: has(multiTurnHistory, "turns") ? multiTurnHistory.turns : null,
    toolHistoryTurns: has(multiTurnHistory, "toolHistoryTurns") ? multiTurnHistory.toolHistoryTurns : null,
    providerModelUsedForEveryTurn: boolField(multiTurnHistory, "providerModelUsedForEveryTurn"),
    restartPreservesOpenAiToolPair: toolHistory ? boolField(toolHistory, "restartPreservesOpenAiToolPair") : null,
    providerSwitchPreservesOpenAiToolPair: toolHistory ? boolField(toolHistory, "providerSwitchPreservesOpenAiToolPair") : null,
    protocolSwitchPreservesAnthropicToolPair: toolHistory ? boolField(toolHistory, "protocolSwitchPreservesAnthropicToolPair") : null,
    reverseProtocolSwitchPreservesOpenAiToolPair: toolHistory ? boolField(toolHistory, "reverseProtocolSwitchPreservesOpenAiToolPair") : null,
    structuralEvidenceClean: structuralEvidence ? [
      structuralEvidence.fifthOpenAiToolEvidence,
      structuralEvidence.sixthOpenAiToolEvidence,
      structuralEvidence.seventhOpenAiToolEvidence,
      structuralEvidence.eighthAnthropicToolEvidence,
      structuralEvidence.ninthOpenAiToolEvidence,
    ].every(structuralEvidenceClean) : null,
    orderedHistoryClean: structuralEvidence ? [
      structuralEvidence.sixthOrderedHistory,
      structuralEvidence.seventhOrderedHistory,
      structuralEvidence.eighthOrderedHistory,
      structuralEvidence.ninthOrderedHistory,
    ].every(orderedHistoryClean) : null,
    sixthOrderedHistoryCount: has(structuralEvidence?.sixthOrderedHistory || {}, "checked") ? structuralEvidence.sixthOrderedHistory.checked : null,
    seventhOrderedHistoryCount: has(structuralEvidence?.seventhOrderedHistory || {}, "checked") ? structuralEvidence.seventhOrderedHistory.checked : null,
    eighthOrderedHistoryCount: has(structuralEvidence?.eighthOrderedHistory || {}, "checked") ? structuralEvidence.eighthOrderedHistory.checked : null,
    ninthOrderedHistoryCount: has(structuralEvidence?.ninthOrderedHistory || {}, "checked") ? structuralEvidence.ninthOrderedHistory.checked : null,
    fourthTurnContextIncludesPriorTurns: boolField(multiTurnHistory, "fourthTurnContextIncludesPriorTurns"),
    fifthAfterSavePreservesHistory: boolField(multiTurnHistory, "fifthAfterSavePreservesHistory"),
    sixthAfterRestartPreservesHistory: boolField(multiTurnHistory, "sixthAfterRestartPreservesHistory"),
    sixthAfterRestartPreservesAllHistoryMarkers: boolField(multiTurnHistory, "sixthAfterRestartPreservesAllHistoryMarkers"),
    sixthAfterRestartAllHistoryMarkerCount: has(multiTurnHistory, "sixthAfterRestartAllHistoryMarkerCount") ? multiTurnHistory.sixthAfterRestartAllHistoryMarkerCount : null,
    seventhAfterProviderSwitchPreservesHistory: boolField(multiTurnHistory, "seventhAfterProviderSwitchPreservesHistory"),
    seventhAfterProviderSwitchPreservesAllHistoryMarkers: boolField(multiTurnHistory, "seventhAfterProviderSwitchPreservesAllHistoryMarkers"),
    seventhAfterProviderSwitchAllHistoryMarkerCount: has(multiTurnHistory, "seventhAfterProviderSwitchAllHistoryMarkerCount") ? multiTurnHistory.seventhAfterProviderSwitchAllHistoryMarkerCount : null,
    eighthAfterProtocolSwitchPreservesHistory: boolField(multiTurnHistory, "eighthAfterProtocolSwitchPreservesHistory"),
    eighthAfterProtocolSwitchPreservesAllHistoryMarkers: boolField(multiTurnHistory, "eighthAfterProtocolSwitchPreservesAllHistoryMarkers"),
    eighthAfterProtocolSwitchAllHistoryMarkerCount: has(multiTurnHistory, "eighthAfterProtocolSwitchAllHistoryMarkerCount") ? multiTurnHistory.eighthAfterProtocolSwitchAllHistoryMarkerCount : null,
    ninthAfterReverseProtocolSwitchPreservesHistory: boolField(multiTurnHistory, "ninthAfterReverseProtocolSwitchPreservesHistory"),
    ninthAfterReverseProtocolSwitchPreservesAllHistoryMarkers: boolField(multiTurnHistory, "ninthAfterReverseProtocolSwitchPreservesAllHistoryMarkers"),
    ninthAfterReverseProtocolSwitchAllHistoryMarkerCount: has(multiTurnHistory, "ninthAfterReverseProtocolSwitchAllHistoryMarkerCount") ? multiTurnHistory.ninthAfterReverseProtocolSwitchAllHistoryMarkerCount : null,
    previousResponseContinuity: {
      savePresent: Boolean(multiTurnHistory.savedContinuationPreviousResponseId),
      restartPresent: Boolean(multiTurnHistory.restartContinuationPreviousResponseId),
      providerSwitchPresent: Boolean(multiTurnHistory.providerSwitchContinuationPreviousResponseId),
      protocolSwitchPresent: Boolean(multiTurnHistory.protocolSwitchContinuationPreviousResponseId),
      reverseProtocolSwitchPresent: Boolean(multiTurnHistory.reverseProtocolSwitchContinuationPreviousResponseId),
      saveMatched: boolField(previousResponseContinuity || {}, "saveMatched"),
      restartMatched: boolField(previousResponseContinuity || {}, "restartMatched"),
      providerSwitchMatched: boolField(previousResponseContinuity || {}, "providerSwitchMatched"),
      protocolSwitchMatched: boolField(previousResponseContinuity || {}, "protocolSwitchMatched"),
      reverseProtocolSwitchMatched: boolField(previousResponseContinuity || {}, "reverseProtocolSwitchMatched"),
      providerSwitchMatchesNested: Boolean(multiTurnHistory.providerSwitchContinuationPreviousResponseId && providerSwitch?.continuationPreviousResponseId && multiTurnHistory.providerSwitchContinuationPreviousResponseId === providerSwitch.continuationPreviousResponseId),
      protocolSwitchMatchesNested: Boolean(multiTurnHistory.protocolSwitchContinuationPreviousResponseId && protocolSwitch?.continuationPreviousResponseId && multiTurnHistory.protocolSwitchContinuationPreviousResponseId === protocolSwitch.continuationPreviousResponseId),
      reverseProtocolSwitchMatchesNested: Boolean(multiTurnHistory.reverseProtocolSwitchContinuationPreviousResponseId && reverseProtocolSwitch?.continuationPreviousResponseId && multiTurnHistory.reverseProtocolSwitchContinuationPreviousResponseId === reverseProtocolSwitch.continuationPreviousResponseId),
    },
    previousResponseIdChain: {
      save: asString(multiTurnHistory.savedContinuationPreviousResponseId),
      restart: asString(multiTurnHistory.restartContinuationPreviousResponseId),
      providerSwitch: asString(multiTurnHistory.providerSwitchContinuationPreviousResponseId),
      protocolSwitch: asString(multiTurnHistory.protocolSwitchContinuationPreviousResponseId),
      reverseProtocolSwitch: asString(multiTurnHistory.reverseProtocolSwitchContinuationPreviousResponseId),
      providerSwitchNested: asString(providerSwitch?.continuationPreviousResponseId),
      protocolSwitchNested: asString(protocolSwitch?.continuationPreviousResponseId),
      reverseProtocolSwitchNested: asString(reverseProtocolSwitch?.continuationPreviousResponseId),
    },
    providerSwitch: providerSwitch ? {
      from: asString(providerSwitch.from),
      to: asString(providerSwitch.to),
      requestReachedSecondProvider: boolField(providerSwitch, "requestReachedSecondProvider"),
    } : null,
    protocolSwitch: protocolSwitch ? {
      from: asString(protocolSwitch.from),
      to: asString(protocolSwitch.to),
      provider: asString(protocolSwitch.provider),
      model: asString(protocolSwitch.model),
      requestReachedAnthropicProvider: boolField(protocolSwitch, "requestReachedAnthropicProvider"),
    } : null,
    reverseProtocolSwitch: reverseProtocolSwitch ? {
      from: asString(reverseProtocolSwitch.from),
      to: asString(reverseProtocolSwitch.to),
      provider: asString(reverseProtocolSwitch.provider),
      model: asString(reverseProtocolSwitch.model),
      requestReachedOpenAiCompatibleProvider: boolField(reverseProtocolSwitch, "requestReachedOpenAiCompatibleProvider"),
    } : null,
  } : null,
};

process.stdout.write(JSON.stringify(summary));
