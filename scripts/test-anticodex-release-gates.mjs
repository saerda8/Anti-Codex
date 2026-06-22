#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
const startedAt = Date.now();

const gateDefinitions = [
  { id: "fastOverallNoTraffic", group: "short", file: "latest-installed-overall-fast.json", requiredForShort: true, requiredForRelease: true, requireFastNoTraffic: true },
  { id: "sourcePreflight", group: "short", file: "latest-source-preflight.json", requiredForShort: true, requiredForRelease: true },
  { id: "mcpSkills", group: "short", file: "latest-mcp-skills.json", requiredForShort: true, requiredForRelease: true, requireMcpSkillSemantics: true },
  { id: "pluginCapabilities", group: "short", file: "latest-plugin-capabilities.json", requiredForShort: true, requiredForRelease: true, requirePluginCapabilitySemantics: true },
  { id: "localConnectors", group: "short", file: "latest-local-connectors.json", requiredForShort: true, requiredForRelease: true, requireLocalConnectorSemantics: true },
  { id: "thirdPartyProvider", group: "short", file: "latest-third-party-provider.json", requiredForShort: true, requiredForRelease: true, requireThirdPartyProviderSemantics: true },
  { id: "missingHistory", group: "short", file: "latest-missing-history.json", requiredForShort: true, requiredForRelease: true, requireMissingHistorySemantics: true },
  { id: "managerRealButtons", group: "manager", file: "latest-manager-real-buttons.json", requiredForShort: true, requiredForRelease: true, requireManagerActions: true },
  { id: "refreshFeatures", group: "manager", file: "latest-refresh-features.json", requiredForRelease: false },
  { id: "realThirdPartyProviderOptional", group: "optional-real-traffic", file: "latest-real-third-party-provider.json", requiredForRelease: false, requireOptionalRealTrafficSemantics: true },
  { id: "providerAntigravityReturnOptional", group: "optional-real-traffic", file: "latest-provider-antigravity-return.json", requiredForRelease: false, requireOptionalRealTrafficSemantics: true },

  { id: "installedOverallNoTraffic", group: "no-traffic", file: "latest-installed-overall.json", requiredForRelease: true },
  { id: "modelRouting", group: "no-traffic", file: "latest-model-routing.json", requiredForRelease: true, requireSkipRequests: true },
  { id: "toolBridgeMode", group: "no-traffic", file: "latest-tool-bridge-mode.json", requiredForRelease: true },
  { id: "uiIdleStability", group: "no-traffic", file: "latest-ui-idle-stability.json", requiredForRelease: true },
  { id: "syncReadiness", group: "no-traffic", file: "latest-sync-readiness.json", requiredForRelease: true },
  { id: "modelThinking", group: "no-traffic", file: "latest-model-thinking.json", requiredForRelease: true },

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

  { id: "stabilitySoak", group: "soak", file: "latest-stability-soak.json", requiredForRelease: false },
  { id: "coldRelaunch", group: "cold", file: "latest-cold-relaunch.json", requiredForRelease: false, note: "Manual/isolated restart evidence; optional for passive release readiness." },
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
    gate.behaviorCovered = report.behaviorCovered === false ? false : null;
    gate.coverageKind = typeof report.coverageKind === "string" ? report.coverageKind : "";
    const semanticFailures = [];
    if (definition.requireFastNoTraffic && (report.fast !== true || report.noTraffic !== true)) {
      semanticFailures.push("expected_fast_no_traffic");
    }
    if (definition.requireSkipRequests && report.skipRequests !== true) {
      semanticFailures.push("expected_skipRequests_true");
    }
    if (definition.requireUsedRealTraffic && report.usedRealTraffic !== true) {
      semanticFailures.push("expected_usedRealTraffic_true");
    }
    if (definition.requireOptionalRealTrafficSemantics && present) {
      if (report.skipped === true) {
        if (report.usedRealTraffic !== false) semanticFailures.push("optional_skipped_used_real_traffic");
        if (report.behaviorCovered !== false) semanticFailures.push("optional_skipped_behavior_covered");
        if (report.coverageKind !== "skipped") semanticFailures.push("optional_skipped_coverage_kind");
        if (report.requestedRealTraffic === true && report.ok === true) semanticFailures.push("optional_requested_real_traffic_uncovered_but_ok");
      } else {
        if (report.usedRealTraffic !== true) semanticFailures.push("optional_real_traffic_not_used");
        if (report.behaviorCovered !== true) semanticFailures.push("optional_real_traffic_behavior_not_covered");
        if (report.coverageKind !== "real-traffic") semanticFailures.push("optional_real_traffic_coverage_kind");
        if (definition.id === "realThirdPartyProviderOptional") {
          if (report.firstMarkerObserved !== true) semanticFailures.push("optional_real_provider_first_marker_missing");
          if (report.secondMarkerObserved !== true) semanticFailures.push("optional_real_provider_second_marker_missing");
          if (report.historyContinuationObserved !== true) semanticFailures.push("optional_real_provider_history_missing");
          if (report.secretsRedacted !== true) semanticFailures.push("optional_real_provider_secrets_not_redacted");
          if (Number(report.turns || 0) < 2) semanticFailures.push("optional_real_provider_turn_count");
        }
        if (definition.id === "providerAntigravityReturnOptional") {
          const evidence = report.realAntigravityEvidence && typeof report.realAntigravityEvidence === "object" ? report.realAntigravityEvidence : {};
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
      if (evidence.chatgptInstallUrlsScrubbed !== true) semanticFailures.push("local_connector_chatgpt_urls_not_scrubbed");
      if (evidence.linkEndpointsUnsupported !== true) semanticFailures.push("local_connector_link_endpoints_not_metadata_only");
      if (evidence.upstreamRequestsDuringLocalEndpoints !== 0) semanticFailures.push("local_connector_upstream_requests_during_local_endpoints");
      if (evidence.allowlistedConnectorAccessible !== false) semanticFailures.push("local_connector_allowlist_marked_accessible");
      if (evidence.allowlistedConnectorLocallyAllowlisted !== true) semanticFailures.push("local_connector_allowlist_not_recorded");
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
      if (!isEmptyArray(appToolParity.missingShared)) semanticFailures.push("plugin_capabilities_local_app_tool_parity_missing_shared");
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
      if (mcp.hasNodeRepl !== true) semanticFailures.push("mcp_skills_missing_node_repl");
      if (mcpSmoke.passed !== true) semanticFailures.push("mcp_skills_smoke_not_passed");
      if (mcpRealCall.passed !== true) semanticFailures.push("mcp_skills_real_call_not_passed");
      if (Number(skills.count || 0) < 1) semanticFailures.push("mcp_skills_no_local_skills");
      if (Number(skills.sharedCount || 0) < 1) semanticFailures.push("mcp_skills_no_shared_skills");
      if (Number(skills.agentsCount || 0) < 1) semanticFailures.push("mcp_skills_no_agents_skills");
      if (Number(skills.expectedSharedCount || 0) < Number(skills.sharedCount || 0) + Number(skills.agentsCount || 0)) semanticFailures.push("mcp_skills_expected_shared_count");
      if (!isEmptyArray(skills.missingShared)) semanticFailures.push("mcp_skills_missing_shared_skills");
      if (!skills.smoke || skills.smoke.readable !== true) semanticFailures.push("mcp_skills_skill_smoke_not_readable");
    }
    if (definition.requireThirdPartyProviderSemantics) {
      const history = report.multiTurnHistory || {};
      const toolHistory = history.toolHistory || {};
      const structuralEvidence = toolHistory.structuralEvidence || {};
      const providerSwitch = history.providerSwitch || {};
      const protocolSwitch = history.protocolSwitch || {};
      const reverseProtocolSwitch = history.reverseProtocolSwitch || {};
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
      if (!validToolEvidence(structuralEvidence.seventhOpenAiToolEvidence, "openai-compatible")) semanticFailures.push("third_party_provider_openai_structural_tool_evidence");
      if (!validToolEvidence(structuralEvidence.eighthAnthropicToolEvidence, "anthropic")) semanticFailures.push("third_party_provider_anthropic_structural_tool_evidence");
      if (!validToolEvidence(structuralEvidence.ninthOpenAiToolEvidence, "openai-compatible")) semanticFailures.push("third_party_provider_reverse_openai_structural_tool_evidence");
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
      reportName: "local-connectors",
      endpointEvidence: {
        chatgptInstallUrlsScrubbed: false,
        linkEndpointsUnsupported: false,
        upstreamRequestsDuringLocalEndpoints: 1,
        allowlistedConnectorAccessible: true,
        allowlistedConnectorLocallyAllowlisted: false,
      },
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
        },
        appToolParity: {
          missingShared: ["missing-app-tool"],
        },
      },
    });

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
        smoke: { readable: false },
      },
    });

    writeFakeLatestReport("latest-tool-bridge-mode.json", {
      ok: true,
      reportName: "tool-bridge-mode",
      usedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "real-traffic",
    });

    writeFakeLatestReport("latest-real-third-party-provider.json", {
      ok: true,
      reportName: "real-third-party-provider",
      skipped: true,
      requestedRealTraffic: true,
      behaviorCovered: false,
      coverageKind: "skipped",
      usedRealTraffic: false,
    });

    writeFakeLatestReport("latest-third-party-provider.json", {
      ok: true,
      reportName: "third-party-provider",
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
          structuralEvidence: {
            seventhOpenAiToolEvidence: { protocol: "openai-compatible", pairedByCallId: false, resultAfterToolCall: false, protocolShapeClean: false },
            eighthAnthropicToolEvidence: { protocol: "openai-compatible", pairedByCallId: false, resultAfterToolCall: false, protocolShapeClean: false },
            ninthOpenAiToolEvidence: { protocol: "anthropic", pairedByCallId: false, resultAfterToolCall: false, protocolShapeClean: false },
          },
        },
        seventhAfterProviderSwitchPreservesAllHistoryMarkers: false,
        seventhAfterProviderSwitchAllHistoryMarkerCount: 1,
        eighthAfterProtocolSwitchPreservesAllHistoryMarkers: false,
        eighthAfterProtocolSwitchAllHistoryMarkerCount: 1,
        ninthAfterReverseProtocolSwitchPreservesAllHistoryMarkers: false,
        ninthAfterReverseProtocolSwitchAllHistoryMarkerCount: 1,
      },
    });

    const semanticFailures = {};
    semanticFailures.noTraffic = assertSemanticFailures("toolBridgeMode", "self-test failed: semantically invalid no-traffic report satisfied the gate", [
      "expected_no_real_traffic",
      "expected_behavior_covered",
      "expected_no_real_traffic_coverage_kind",
    ]);
    semanticFailures.optionalRealTraffic = assertSemanticFailures("realThirdPartyProviderOptional", "self-test failed: semantically invalid optional real-traffic report satisfied the gate", [
      "optional_requested_real_traffic_uncovered_but_ok",
    ]);
    writeFakeLatestReport("latest-real-third-party-provider.json", {
      ok: true,
      reportName: "real-third-party-provider",
      skipped: false,
      behaviorCovered: true,
      coverageKind: "real-traffic",
      usedRealTraffic: true,
      firstMarkerObserved: false,
      secondMarkerObserved: false,
      historyContinuationObserved: false,
      secretsRedacted: false,
      turns: 1,
    });
    semanticFailures.optionalRealProvider = assertSemanticFailures("realThirdPartyProviderOptional", "self-test failed: semantically invalid real provider optional report satisfied the gate", [
      "optional_real_provider_first_marker_missing",
      "optional_real_provider_second_marker_missing",
      "optional_real_provider_history_missing",
      "optional_real_provider_secrets_not_redacted",
      "optional_real_provider_turn_count",
    ]);
    writeFakeLatestReport("latest-provider-antigravity-return.json", {
      ok: true,
      reportName: "provider-antigravity-return",
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
      "mcp_skills_missing_node_repl",
      "mcp_skills_smoke_not_passed",
      "mcp_skills_real_call_not_passed",
      "mcp_skills_no_agents_skills",
      "mcp_skills_missing_shared_skills",
      "mcp_skills_skill_smoke_not_readable",
    ]);
    semanticFailures.thirdPartyProvider = assertSemanticFailures("thirdPartyProvider", "self-test failed: semantically invalid third-party provider report satisfied the gate", [
      "third_party_provider_secrets_not_redacted",
      "third_party_provider_turn_count",
      "third_party_provider_switch_history_loss",
      "third_party_provider_cross_protocol_history_loss",
      "third_party_provider_reverse_protocol_history_loss",
      "third_party_provider_stale_model_used",
      "third_party_provider_openai_tool_pair_lost",
      "third_party_provider_anthropic_tool_pair_lost",
      "third_party_provider_reverse_openai_tool_pair_lost",
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
      "local_connector_chatgpt_urls_not_scrubbed",
      "local_connector_link_endpoints_not_metadata_only",
      "local_connector_upstream_requests_during_local_endpoints",
      "local_connector_allowlist_marked_accessible",
      "local_connector_allowlist_not_recorded",
    ]);
    semanticFailures.pluginCapabilities = assertSemanticFailures("pluginCapabilities", "self-test failed: semantically invalid plugin-capability report satisfied the gate", [
      "plugin_capabilities_native_codex_writeback",
      "plugin_capabilities_accessible_connector_count",
      "plugin_capabilities_unauthorized_app_tools",
      "plugin_capabilities_app_tool_get_post_mismatch",
      "plugin_capabilities_local_connector_parity_missing_shared",
      "plugin_capabilities_local_app_tool_parity_missing_shared",
    ]);
    console.log(JSON.stringify({ ok: true, selfTest: true, semanticFailures }));
  } finally {
    reportRoot = originalReportRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  }
  process.exit(0);
}

const gates = gateDefinitions.map(summarizeGate);
const requiredRelease = gates.filter((gate) => gate.requiredForRelease);
const requiredShort = gates.filter((gate) => gate.requiredForShort);
const missingRequired = requiredRelease.filter((gate) => !gate.satisfied).map((gate) => gate.id);
const missingShort = requiredShort.filter((gate) => !gate.satisfied).map((gate) => gate.id);
const damagedReports = gates.filter((gate) => gate.present && (!gate.parseable || gate.hashValid !== true)).map((gate) => gate.id);
const groups = Object.fromEntries([...new Set(gates.map((gate) => gate.group))].map((group) => {
  const groupGates = gates.filter((gate) => gate.group === group);
  return [group, {
    total: groupGates.length,
    satisfied: groupGates.filter((gate) => gate.satisfied).length,
    required: groupGates.filter((gate) => gate.requiredForRelease).length,
    missingRequired: groupGates.filter((gate) => gate.requiredForRelease && !gate.satisfied).map((gate) => gate.id),
  }];
}));

const releaseReady = missingRequired.length === 0;
const shortReady = missingShort.length === 0;
const payload = {
  ok: strict ? releaseReady && damagedReports.length === 0 : true,
  releaseReady,
  shortReady,
  strict,
  reportName: "release-gates",
  elapsedMs: Date.now() - startedAt,
  reportRoot,
  maxAgeHours,
  missingRequired,
  missingShort,
  damagedReports,
  groups,
  gates,
};
writeJsonReportAtomic(payload);
process.stdout.write(JSON.stringify(payload));
