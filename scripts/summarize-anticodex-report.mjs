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
const multiTurnHistory = report && report.multiTurnHistory ? report.multiTurnHistory : null;
const toolHistory = multiTurnHistory && multiTurnHistory.toolHistory ? multiTurnHistory.toolHistory : null;
const structuralEvidence = toolHistory && toolHistory.structuralEvidence ? toolHistory.structuralEvidence : null;
const providerSwitch = multiTurnHistory && multiTurnHistory.providerSwitch ? multiTurnHistory.providerSwitch : null;
const protocolSwitch = multiTurnHistory && multiTurnHistory.protocolSwitch ? multiTurnHistory.protocolSwitch : null;
const reverseProtocolSwitch = multiTurnHistory && multiTurnHistory.reverseProtocolSwitch ? multiTurnHistory.reverseProtocolSwitch : null;
const endpointEvidence = report && report.endpointEvidence ? report.endpointEvidence : null;
const capabilities = report && report.capabilities ? report.capabilities : null;
const connectorParity = capabilities && capabilities.connectorParity ? capabilities.connectorParity : null;
const appToolParity = capabilities && capabilities.appToolParity ? capabilities.appToolParity : null;
const appToolGetPostParity = capabilities && capabilities.appToolGetPostParity ? capabilities.appToolGetPostParity : null;
const mcp = report && report.mcp ? report.mcp : null;
const skills = report && report.skills ? report.skills : null;
const realAntigravityEvidence = report && report.realAntigravityEvidence ? report.realAntigravityEvidence : null;
const releaseGateFailures = Array.isArray(report?.gates)
  ? report.gates
    .filter((gate) => {
      const semanticFailures = has(gate, "semanticFailures") ? asStringArray(gate.semanticFailures) : [];
      return gate
        && gate.satisfied !== true
        && (gate.requiredForRelease === true || gate.requiredForShort === true || semanticFailures.length > 0 || (gate.present === true && (gate.error || gate.okField === false)));
    })
    .map((gate) => ({
      id: asString(gate.id),
      group: asString(gate.group),
      error: asString(gate.error),
      semanticFailures: has(gate, "semanticFailures") ? asStringArray(gate.semanticFailures) : [],
    }))
  : [];

function structuralEvidenceClean(evidence) {
  return !!evidence
    && evidence.pairedByCallId === true
    && evidence.resultAfterToolCall === true
    && evidence.protocolShapeClean === true;
}

function emptyArrayField(object, key) {
  return object && Array.isArray(object[key]) ? object[key].length === 0 : null;
}

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
  upstreamProfileStorageOk: checkOk("upstreamProfileStorage"),
  publicDocumentationOk: checkOk("publicDocumentation"),
  translatorRegressionOk: checkOk("translatorRegression"),
  diffWhitespaceOk: checkOk("diffWhitespace"),
  baseUrl: has(report, "baseUrl") ? report.baseUrl : null,
  modelCount: has(report, "modelCount") ? report.modelCount : null,
  models: has(report, "models") ? asStringArray(report.models) : [],
  skipRequests: boolField(report, "skipRequests"),
  state: has(report, "state") ? asString(report.state) : null,
  skipped: boolField(report, "skipped"),
  reason: has(report, "reason") ? asString(report.reason) : null,
  behaviorCovered: boolField(report, "behaviorCovered"),
  coverageKind: has(report, "coverageKind") ? asString(report.coverageKind) : null,
  usedRealTraffic: boolField(report, "usedRealTraffic"),
  requestedRealTraffic: boolField(report, "requestedRealTraffic"),
  latestDiagnosis: wait && has(wait, "latestDiagnosis") ? asString(wait.latestDiagnosis) : null,
  latestDiagnosisDetail: latestWait && has(latestWait, "diagnosisDetail") ? asString(latestWait.diagnosisDetail) : null,
  attempts: wait && has(wait, "attempts") ? wait.attempts : null,
  repairedCount: has(report, "repairedCount") ? report.repairedCount : null,
  repairedAt: has(report, "repairedAt") ? asString(report.repairedAt) : null,
  releaseReady: boolField(report, "releaseReady"),
  shortReady: boolField(report, "shortReady"),
  missingRequired: has(report, "missingRequired") ? asStringArray(report.missingRequired) : [],
  missingShort: has(report, "missingShort") ? asStringArray(report.missingShort) : [],
  damagedReports: has(report, "damagedReports") ? asStringArray(report.damagedReports) : [],
  releaseGateFailures,
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
    upstreamRequestsDuringLocalEndpoints: has(endpointEvidence, "upstreamRequestsDuringLocalEndpoints") ? endpointEvidence.upstreamRequestsDuringLocalEndpoints : null,
    hiddenConnectorAccessible: boolField(endpointEvidence, "hiddenConnectorAccessible"),
    exposedToolNames: has(endpointEvidence, "exposedToolNames") ? asStringArray(endpointEvidence.exposedToolNames) : [],
  } : null,
  pluginCapabilityEvidence: capabilities ? {
    snapshotSource: asString(capabilities.snapshotSource),
    nativeCodexWriteback: boolField(capabilities, "nativeCodexWriteback"),
    capabilityState: asString(capabilities.capabilityState),
    connectorCount: has(capabilities, "connectorCount") ? capabilities.connectorCount : null,
    accessibleConnectorCount: has(capabilities, "accessibleConnectorCount") ? capabilities.accessibleConnectorCount : null,
    appToolCount: has(capabilities, "appToolCount") ? capabilities.appToolCount : null,
    appToolGetCount: has(capabilities, "appToolGetCount") ? capabilities.appToolGetCount : null,
    unattributedAppToolCount: has(capabilities, "unattributedAppToolCount") ? capabilities.unattributedAppToolCount : null,
    unauthorizedAppToolCount: has(capabilities, "unauthorizedAppToolCount") ? capabilities.unauthorizedAppToolCount : null,
    connectorParityClean: connectorParity ? emptyArrayField(connectorParity, "missingShared") : null,
    connectorParityMissingShared: connectorParity && has(connectorParity, "missingShared") ? asStringArray(connectorParity.missingShared) : [],
    connectorParityExtraLocal: connectorParity && has(connectorParity, "extraLocal") ? asStringArray(connectorParity.extraLocal) : [],
    appToolParityClean: appToolParity ? emptyArrayField(appToolParity, "missingShared") : null,
    appToolParityMissingShared: appToolParity && has(appToolParity, "missingShared") ? asStringArray(appToolParity.missingShared) : [],
    appToolParityExtraLocal: appToolParity && has(appToolParity, "extraLocal") ? asStringArray(appToolParity.extraLocal) : [],
    appToolGetPostParityClean: appToolGetPostParity
      ? emptyArrayField(appToolGetPostParity, "missingFromGet") === true && emptyArrayField(appToolGetPostParity, "extraFromGet") === true
      : null,
    appToolGetPostMissingFromGet: appToolGetPostParity && has(appToolGetPostParity, "missingFromGet") ? asStringArray(appToolGetPostParity.missingFromGet) : [],
    appToolGetPostExtraFromGet: appToolGetPostParity && has(appToolGetPostParity, "extraFromGet") ? asStringArray(appToolGetPostParity.extraFromGet) : [],
  } : null,
  mcpSkillEvidence: (mcp || skills) ? {
    mcpCount: mcp && has(mcp, "count") ? mcp.count : null,
    mcpSharedCount: mcp && has(mcp, "sharedCount") ? mcp.sharedCount : null,
    mcpMissingShared: mcp && has(mcp, "missingShared") ? asStringArray(mcp.missingShared) : [],
    mcpExtraLocal: mcp && has(mcp, "extraLocal") ? asStringArray(mcp.extraLocal) : [],
    hasNodeRepl: mcp ? boolField(mcp, "hasNodeRepl") : null,
    mcpSmokePassed: mcp && mcp.smoke ? boolField(mcp.smoke, "passed") : null,
    mcpRealCallPassed: mcp && mcp.smoke && mcp.smoke.realCall ? boolField(mcp.smoke.realCall, "passed") : null,
    skillCount: skills && has(skills, "count") ? skills.count : null,
    skillSharedCount: skills && has(skills, "sharedCount") ? skills.sharedCount : null,
    agentsSkillCount: skills && has(skills, "agentsCount") ? skills.agentsCount : null,
    expectedSharedSkillCount: skills && has(skills, "expectedSharedCount") ? skills.expectedSharedCount : null,
    missingSharedSkills: skills && has(skills, "missingShared") ? asStringArray(skills.missingShared) : [],
    extraLocalSkills: skills && has(skills, "extraLocal") ? asStringArray(skills.extraLocal) : [],
    skillSmokeReadable: skills && skills.smoke ? boolField(skills.smoke, "readable") : null,
  } : null,
  optionalRealProviderEvidence: has(report, "firstMarkerObserved") || has(report, "secondMarkerObserved") || has(report, "historyContinuationObserved") ? {
    firstMarkerObserved: boolField(report, "firstMarkerObserved"),
    secondMarkerObserved: boolField(report, "secondMarkerObserved"),
    historyContinuationObserved: boolField(report, "historyContinuationObserved"),
    secretsRedacted: boolField(report, "secretsRedacted"),
    turns: has(report, "turns") ? report.turns : null,
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
    fourthTurnContextIncludesPriorTurns: boolField(multiTurnHistory, "fourthTurnContextIncludesPriorTurns"),
    fifthAfterSavePreservesHistory: boolField(multiTurnHistory, "fifthAfterSavePreservesHistory"),
    seventhAfterProviderSwitchPreservesHistory: boolField(multiTurnHistory, "seventhAfterProviderSwitchPreservesHistory"),
    seventhAfterProviderSwitchPreservesAllHistoryMarkers: boolField(multiTurnHistory, "seventhAfterProviderSwitchPreservesAllHistoryMarkers"),
    seventhAfterProviderSwitchAllHistoryMarkerCount: has(multiTurnHistory, "seventhAfterProviderSwitchAllHistoryMarkerCount") ? multiTurnHistory.seventhAfterProviderSwitchAllHistoryMarkerCount : null,
    eighthAfterProtocolSwitchPreservesHistory: boolField(multiTurnHistory, "eighthAfterProtocolSwitchPreservesHistory"),
    eighthAfterProtocolSwitchPreservesAllHistoryMarkers: boolField(multiTurnHistory, "eighthAfterProtocolSwitchPreservesAllHistoryMarkers"),
    eighthAfterProtocolSwitchAllHistoryMarkerCount: has(multiTurnHistory, "eighthAfterProtocolSwitchAllHistoryMarkerCount") ? multiTurnHistory.eighthAfterProtocolSwitchAllHistoryMarkerCount : null,
    ninthAfterReverseProtocolSwitchPreservesHistory: boolField(multiTurnHistory, "ninthAfterReverseProtocolSwitchPreservesHistory"),
    ninthAfterReverseProtocolSwitchPreservesAllHistoryMarkers: boolField(multiTurnHistory, "ninthAfterReverseProtocolSwitchPreservesAllHistoryMarkers"),
    ninthAfterReverseProtocolSwitchAllHistoryMarkerCount: has(multiTurnHistory, "ninthAfterReverseProtocolSwitchAllHistoryMarkerCount") ? multiTurnHistory.ninthAfterReverseProtocolSwitchAllHistoryMarkerCount : null,
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
