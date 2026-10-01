#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  assistantMessageIsVisibleProgress,
  findScopedCommandViolations,
} from "./lib/ui-chat-marker-evidence.mjs";
import {
  buildTurnModelProof,
  allowMigrationIdempotencyDuplicate,
  correlateScopedCommandResultHashes,
  countDuplicateCommands,
  countTurnStaleConflicts,
  createTerminalProviderStopGate,
  evaluateGate8TurnEvidence,
  evaluateHistoryReopenEvidence,
  fetchJsonWithRetry,
  retainJourneyTurnEvidence,
  resolveFixedRouteModel,
} from "./lib/anticodex-gate8-evidence.mjs";
import { markerScopedHistoryEntries } from "./lib/native-codex-rollout-history.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === "--help" || key === "-h") {
    console.log(`Usage: node scripts/test-anticodex-human-long-journey.mjs [options]

Options:
  --allow-real-traffic  Run real desktop journeys (default: dry-run)
  --journey <ids>       Comma-separated journey ids (default: all)
  --model <id>          Model override (default: current fixed-route model)
  --timeout-ms <ms>     Per desktop turn timeout (default: 300000)
  --report-root <path>  Report directory
  --revalidate-report <path>  Recompute derived checks from one signed retained report; no model traffic
  --keep-artifacts      Keep successful temporary fixtures
  --help, -h            Show help`);
    process.exit(0);
  }
  if (!key.startsWith("--")) continue;
  const value = process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[++index]
    : "1";
  args.set(key, value);
}

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptRoot, "..");
const lockedRunnerScript = resolve(scriptRoot, "test-anticodex-human-long-journey.ps1");
const realTrafficLockName = String(process.env.ANTICODEX_REAL_TRAFFIC_LOCK_NAME || "Local\\AntiCodex.RealTrafficBridge");
const uiSmokeScript = resolve(scriptRoot, "test-anticodex-ui-chat-smoke.mjs");
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const responseHistoryPath = resolve(process.env.APPDATA || os.tmpdir(), "anticodex", "response-history.json");
const anticodexStateRoot = resolve(process.env.ANTICODEX_STATE_ROOT || join(process.env.APPDATA || os.tmpdir(), "anticodex"));
const anticodexCodexHome = resolve(process.env.ANTICODEX_CODEX_HOME || join(anticodexStateRoot, "codex-home-deepseek-app"));
const nativeCodexMemoryRoot = resolve(anticodexCodexHome, "memories");
const codexGlobalStatePath = resolve(anticodexStateRoot, ".codex-global-state.json");
const allowRealTraffic = args.has("--allow-real-traffic");
const keepArtifacts = args.has("--keep-artifacts");
const revalidateReportPath = String(args.get("--revalidate-report") || "").trim();
let model = String(args.get("--model") || "").trim();
const timeoutMs = Math.max(60_000, Number(args.get("--timeout-ms") || 300_000));
const startedAt = Date.now();
const runId = Date.now();
const allJourneyIds = ["messy-inventory-four-turn", "interrupted-migration-three-turn", "greenfield-project-three-turn"];
const supportedFixedRouteProviders = new Set(["antigravity", "third-party"]);
const requestedJourneyIds = String(args.get("--journey") || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const journeyIds = requestedJourneyIds.length > 0 ? [...new Set(requestedJourneyIds)] : allJourneyIds;
const unknownJourneyIds = journeyIds.filter((id) => !allJourneyIds.includes(id));
if (unknownJourneyIds.length > 0) throw new Error(`unknown journey id(s): ${unknownJourneyIds.join(", ")}`);
const terminalProviderGate = createTerminalProviderStopGate();
const observedTurnsByJourney = new Map();
let trustedProjectRoot = sourceRoot;
let trustedProjectLabel = "Anti-Codex";
let noTrafficStop = null;

function compactText(value, max = 1800) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function parseJsonOutput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

function workspacePathsEqual(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => resolve(String(value)).replace(/[\\/]+$/g, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function captureWorkspaceState() {
  const state = readJson(codexGlobalStatePath);
  const roots = Array.isArray(state?.["electron-saved-workspace-roots"])
    ? state["electron-saved-workspace-roots"].map(String)
    : [];
  const activeRoots = Array.isArray(state?.["active-workspace-roots"])
    ? state["active-workspace-roots"].map(String)
    : [];
  const labels = state?.["electron-workspace-root-labels"] && typeof state["electron-workspace-root-labels"] === "object"
    ? { ...state["electron-workspace-root-labels"] }
    : {};
  const projectOrder = Array.isArray(state?.["project-order"])
    ? state["project-order"].map(String)
    : [];
  if (roots.length === 0) throw new Error("Anti-Codex has no saved workspace root to restore after the journey");
  if (activeRoots.length > 1) throw new Error("Anti-Codex has more than one active workspace root; safe test restore is unavailable");
  return { roots, activeRoots, labels, projectOrder };
}

function workspaceStateMatches(snapshot) {
  const current = captureWorkspaceState();
  const expectedLabels = Object.fromEntries(snapshot.roots.map((root) => [root, String(snapshot.labels?.[root] || "")]));
  const currentLabels = Object.fromEntries(current.roots.map((root) => [root, String(current.labels?.[root] || "")]));
  return JSON.stringify(current.roots) === JSON.stringify(snapshot.roots)
    && JSON.stringify(current.activeRoots) === JSON.stringify(snapshot.activeRoots)
    && JSON.stringify(current.projectOrder) === JSON.stringify(snapshot.projectOrder)
    && JSON.stringify(currentLabels) === JSON.stringify(expectedLabels);
}

function restoreWorkspaceState(snapshotPath) {
  const child = spawnSync(process.execPath, [
    uiSmokeScript,
    "--workspace-command", "restore",
    "--workspace-state-file", snapshotPath,
    "--timeout-ms", "30000",
  ], {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  const payload = parseJsonOutput(child.stdout);
  const snapshot = readJson(snapshotPath);
  const deadline = Date.now() + 5_000;
  let restored = false;
  do {
    try { restored = workspaceStateMatches(snapshot); } catch { restored = false; }
    if (restored) break;
    syncSleep(150);
  } while (Date.now() < deadline);
  return {
    ok: child.status === 0 && payload?.ok === true && payload?.usedRealTraffic === false && restored,
    status: child.status,
    timedOut: child.error?.code === "ETIMEDOUT",
    stderr: compactText(child.stderr),
    payload,
    stateRestored: restored,
    phase: "workspace-state-restore",
  };
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = resolve(reportRoot, "latest-ui-human-long-journey.json");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const history = resolve(reportRoot, `${stamp}-ui-human-long-journey.json`);
  const finalPayload = { ...payload, report: { latest, history } };
  const json = `${JSON.stringify(finalPayload, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `${createHash("sha256").update(json).digest("hex")}\n`, "ascii");
  }
  return finalPayload;
}

function responseItemText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content?.text || content?.output_text || content?.input_text || "");
  return content.map((part) => String(part?.text || part?.output_text || part?.input_text || "")).join("\n");
}

function commandLooksLikeLaunch(command = "") {
  const value = String(command || "");
  return /(?:^|[;{}()\r\n|&]\s*|=\s*)Start-Process\b/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*|=\s*)Invoke-Item\b/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*)(?:cmd(?:\.exe)?\s+\/[dc]\s+)?start(?:\.exe)?\s+/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*)explorer(?:\.exe)?\s+/i.test(value);
}

function preCommandTextExplainsAction(text, marker) {
  const value = compactText(text, 800);
  if (!assistantMessageIsVisibleProgress(value, marker)) return false;
  const chineseCharacters = value.match(/[\u3400-\u9fff]/gu) || [];
  return chineseCharacters.length >= 4
    && /(?:先|接下来|现在|将|准备|检查|读取|查看|定位|修改|运行|执行|验证|测试|确认|恢复|继续|清理|生成|更新|修复)/u.test(value);
}

function markerHistoryEvidence(marker, artifactDir, { allowDuplicateCommand = null } = {}) {
  const entries = markerScopedHistoryEntries(marker, { responseHistoryPath });
  const latestEntry = entries.at(-1);
  const allItems = latestEntry ? [...(latestEntry.inputItems || []), ...(latestEntry.contextItems || [])] : [];
  let currentUserIndex = -1;
  for (let index = 0; index < allItems.length; index += 1) {
    const item = allItems[index];
    if (item?.type !== "message" || item?.role !== "user") continue;
    if (responseItemText(item.content).includes(marker)) currentUserIndex = index;
  }
  const items = allItems.slice(currentUserIndex + 1);
  const shellCommands = [];
  const scopedCommands = [];
  const assistantTexts = [];
  const preCommandTexts = [];
  const toolOutputRecords = [];
  let firstToolIndex = -1;
  let finalMarkerItemIndex = -1;
  let postFinalToolCallCount = 0;
  let postFinalToolOutputCount = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (finalMarkerItemIndex >= 0) postFinalToolCallCount += 1;
      if (firstToolIndex < 0) firstToolIndex = index;
      const raw = String(item.arguments || item.input || "");
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}
      const toolName = String(item.name || "");
      const parsedCommand = parsed?.command || parsed?.cmd || parsed?.script || "";
      const isShellCommand = /(?:^|__)shell_command$/i.test(toolName) || Boolean(parsedCommand);
      const isPatchCommand = /(?:^|__)apply_patch$/i.test(toolName);
      const command = String(parsedCommand || (isPatchCommand ? raw : ""));
      if (command) {
        const callId = String(item.call_id || item.callId || item.id || "").trim();
        scopedCommands.push({
          command,
          callId,
          workdir: String(parsed?.workdir || parsed?.cwd || ""),
          toolName,
        });
        if (isShellCommand) shellCommands.push(command);
      }
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (finalMarkerItemIndex >= 0) postFinalToolOutputCount += 1;
      toolOutputRecords.push({
        callId: String(item.call_id || item.callId || "").trim(),
        text: responseItemText(item.output || item.content),
      });
    }
    if (item.type === "message" && item.role === "assistant") {
      const text = responseItemText(item.content);
      assistantTexts.push(text);
      if (finalMarkerItemIndex < 0 && text.includes(marker)) finalMarkerItemIndex = index;
      if (firstToolIndex < 0 || index < firstToolIndex) preCommandTexts.push(text);
    }
  }
  const toolOutputs = toolOutputRecords.map((record) => record.text);
  const combined = [...assistantTexts, ...toolOutputs].join("\n");
  const visibleProgressTexts = assistantTexts.filter((text) => assistantMessageIsVisibleProgress(text, marker));
  const nonEmptyToolOutputs = toolOutputs.map((text) => text.trim()).filter(Boolean);
  const scopedCommandResultHashes = correlateScopedCommandResultHashes(scopedCommands, toolOutputRecords);
  const preCommandExplanationTexts = preCommandTexts.filter((text) => preCommandTextExplainsAction(text, marker));
  const duplicateCommandCount = countDuplicateCommands(scopedCommands, { allowDuplicate: allowDuplicateCommand });
  const scopeViolations = findScopedCommandViolations(scopedCommands, {
    artifactDir,
    allowedAbsolutePaths: [process.execPath],
    allowedRuntimePaths: [nativeCodexMemoryRoot],
  });
  return {
    entryCount: entries.length,
    entryId: String(latestEntry?.id || ""),
    threadId: String(latestEntry?.id || "").startsWith("rollout:")
      ? String(latestEntry.id).slice("rollout:".length)
      : "",
    sessionCwd: String(latestEntry?.sessionCwd || latestEntry?.cwd || ""),
    rolloutFile: String(latestEntry?.file || ""),
    historySource: String(latestEntry?.source || ""),
    shellCommands,
    scopedCommands,
    toolOutputSeen: nonEmptyToolOutputs.length > 0,
    nonEmptyToolOutputHashes: [...new Set(nonEmptyToolOutputs.map((text) => (
      createHash("sha256").update(text, "utf8").digest("hex")
    )))],
    scopedCommandResultHashes,
    taskCompleteSeen: latestEntry?.latestMarkerTurnComplete === true,
    assistantFinalMarkerSeen: assistantTexts.some((text) => text.includes(marker)),
    chinesePreCommandSeen: preCommandTexts.some((text) => /[\u3400-\u9fff]/u.test(text)),
    preCommandExplanationSeen: preCommandExplanationTexts.length > 0,
    preCommandExplanationHashes: [...new Set(preCommandExplanationTexts.map((text) => (
      createHash("sha256").update(text, "utf8").digest("hex")
    )))],
    parseErrorSeen: /(?:parse error|invalid xml|xml parse|malformed tool)/i.test(combined),
    launchCommandCount: shellCommands.filter(commandLooksLikeLaunch).length,
    verificationCommandCount: shellCommands.filter((command) => /(?:node\s+--test|npm\s+test|inventory\.mjs|migrate\.mjs)/i.test(command)).length,
    progressUpdateCount: new Set(visibleProgressTexts.map((text) => compactText(text, 800))).size,
    postFinalToolCallCount,
    postFinalToolOutputCount,
    duplicateCommandCount,
    scopeViolations,
    scopeViolationCount: scopeViolations.length,
  };
}

function settleMarkerHistoryEvidence(marker, artifactDir, waitMs = 5_000, options = {}) {
  const started = Date.now();
  let attempts = 0;
  let evidence;
  do {
    attempts += 1;
    evidence = markerHistoryEvidence(marker, artifactDir, options);
    if (evidence.entryCount > 0
      && evidence.taskCompleteSeen
      && evidence.scopedCommands.length > 0
      && evidence.toolOutputSeen
      && evidence.preCommandExplanationSeen) break;
    if (Date.now() - started >= waitMs) break;
    syncSleep(150);
  } while (true);
  return {
    ...evidence,
    settle: {
      attempts,
      elapsedMs: Date.now() - started,
      complete: evidence.entryCount > 0
        && evidence.taskCompleteSeen
        && evidence.scopedCommands.length > 0
        && evidence.toolOutputSeen
        && evidence.preCommandExplanationSeen,
    },
  };
}

function writePrompt(promptRoot, name, lines) {
  mkdirSync(promptRoot, { recursive: true });
  const path = resolve(promptRoot, `${name}.txt`);
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

function runUiTurn({
  journeyId,
  turnId,
  marker,
  promptPath,
  artifactDir,
  sameChat,
  sameChatTitleContains = "",
  navigateAwayBeforeHistoryReopen = false,
  requireHistoryResponsive = false,
  historyOpenBudgetMs = 3_000,
  forceResetSameChat = false,
  requiredFile = "",
  requiredContains = [],
  allowDuplicateCommand = null,
}) {
  terminalProviderGate.assertCanStart({ journeyId, turnId });
  const childArgs = [
    uiSmokeScript,
    "--task-mode", "exact-marker",
    "--timeout-ms", String(timeoutMs),
    "--marker", marker,
    "--prompt-file", promptPath,
    "--report-name", `ui-human-long-${journeyId}-${turnId}`,
    "--model", model,
    "--artifact-dir", artifactDir,
    "--require-native-single-task",
  ];
  childArgs.push("--project-root", trustedProjectRoot, "--project-label", trustedProjectLabel);
  if (sameChatTitleContains) {
    childArgs.push("--same-chat-title-contains", sameChatTitleContains);
    if (navigateAwayBeforeHistoryReopen) childArgs.push("--navigate-away-before-history-reopen");
    if (requireHistoryResponsive) childArgs.push("--require-history-responsive");
    childArgs.push("--history-open-budget-ms", String(historyOpenBudgetMs));
  } else if (sameChat) childArgs.push("--same-chat");
  if (forceResetSameChat) childArgs.push("--force-reset-same-chat");
  if (requiredFile) childArgs.push("--required-file", requiredFile);
  if (requiredContains.length > 0) childArgs.push("--required-file-contains", requiredContains.join("|"));
  childArgs.push("--result-driven-completion");
  const child = spawnSync(process.execPath, childArgs, {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: timeoutMs + 180_000,
    windowsHide: true,
  });
  const payload = parseJsonOutput(child.stdout);
  const history = settleMarkerHistoryEvidence(marker, artifactDir, 5_000, { allowDuplicateCommand });
  const modelProof = buildTurnModelProof(payload || {}, model);
  const expectedWorkspaceCwd = artifactDir && existsSync(artifactDir)
    ? resolve(artifactDir)
    : trustedProjectRoot;
  const workspaceCwdMatches = workspacePathsEqual(history.sessionCwd, expectedWorkspaceCwd);
  const turn = {
    journeyId,
    turnId,
    marker,
    ok: child.status === 0
      && payload?.ok === true
      && payload?.usedRealTraffic === true
      && modelProof.proven === true
      && workspaceCwdMatches,
    status: child.status,
    timedOut: child.error?.code === "ETIMEDOUT",
    error: child.error ? String(child.error.message || child.error) : "",
    stderr: compactText(child.stderr),
    report: payload?.report || null,
    elapsedMs: payload?.elapsedMs || null,
    failures: payload?.failures || [],
    usedRealTraffic: payload?.usedRealTraffic === true,
    requiredModel: payload?.requiredModel || null,
    actualModelProven: modelProof.proven === true,
    modelProof,
    resultDrivenCompletionObserved: payload?.resultDrivenCompletionObserved === true,
    taskToolCallCount: history.scopedCommands.length,
    activeReconnectSeen: payload?.activeReconnectSeen === true,
    reconnectOutcome: payload?.reconnectOutcome || null,
    sameChatEvidence: payload?.sameChatEvidence || null,
    projectRootEvidence: payload?.projectRootEvidence || null,
    expectedWorkspaceCwd,
    workspaceCwdMatches,
    history,
  };
  observedTurnsByJourney.set(
    journeyId,
    retainJourneyTurnEvidence(observedTurnsByJourney.get(journeyId) || [], turn),
  );
  terminalProviderGate.observe(turn);
  if (turn.usedRealTraffic !== true) {
    noTrafficStop = {
      journeyId,
      turnId,
      failures: turn.failures,
      reason: "desktop turn stopped before a model request was proven",
    };
    const error = new Error(`${turnId} stopped before real traffic; refusing automatic repair turns`);
    error.noTrafficStop = noTrafficStop;
    throw error;
  }
  return turn;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeHashes(root) {
  const result = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result[relative(root, path).replaceAll("\\", "/")] = sha256File(path);
    }
  };
  visit(root);
  return result;
}

function changedFiles(before = {}, after = {}) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

function fileNames(root) {
  const names = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) names.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  if (existsSync(root)) visit(root);
  return names.sort();
}

function spawnNode(cwd, nodeArgs, timeout = 30_000) {
  return spawnSync(process.execPath, nodeArgs, { cwd, encoding: "utf8", timeout, windowsHide: true });
}

function checkTurn(turn, failures) {
  const evaluated = evaluateGate8TurnEvidence(turn, model);
  if (!turn.ok) failures.push(`${turn.turnId} desktop turn failed: ${compactText(turn.failures.length ? turn.failures : turn.stderr || turn.error)}`);
  if (!turn.usedRealTraffic) failures.push(`${turn.turnId} did not use real traffic`);
  if (!turn.workspaceCwdMatches) {
    failures.push(`${turn.turnId} native Codex cwd ${turn.history.sessionCwd || "<missing>"} did not match ${turn.expectedWorkspaceCwd}`);
  }
  if (turn.requiredModel !== model) failures.push(`${turn.turnId} required model does not match ${model}`);
  if (!turn.actualModelProven) failures.push(`${turn.turnId} did not prove the actual request model`);
  else if (!evaluated.modelProofValid) failures.push(`${turn.turnId} model proof detail is incomplete`);
  if (!turn.history.assistantFinalMarkerSeen && !(turn.resultDrivenCompletionObserved && turn.history.taskCompleteSeen)) {
    failures.push(`${turn.turnId} final marker missing from assistant history`);
  }
  if (!turn.history.toolOutputSeen) failures.push(`${turn.turnId} has no real tool output`);
  else if (!evaluated.rolloutToolOutputEvidence) failures.push(`${turn.turnId} has no rollout-derived tool output hash`);
  if (!Array.isArray(turn.history.scopedCommands) || turn.history.scopedCommands.length === 0) {
    failures.push(`${turn.turnId} has no real scoped command`);
  } else if (!evaluated.hasNonEmptyScopedCommand) {
    failures.push(`${turn.turnId} has no non-empty real scoped command`);
  }
  if (evaluated.hasNonEmptyScopedCommand && !evaluated.scopedCommandCallIdsValid) {
    failures.push(`${turn.turnId} has a missing or duplicate command call-id`);
  }
  if (!turn.history.chinesePreCommandSeen) failures.push(`${turn.turnId} had no Chinese pre-command explanation`);
  if (!turn.history.preCommandExplanationSeen) failures.push(`${turn.turnId} did not explain its next action before the first command`);
  else if (!evaluated.rolloutPreCommandEvidence) failures.push(`${turn.turnId} has no rollout-derived pre-command explanation hash`);
  if (turn.history.launchCommandCount > 0) failures.push(`${turn.turnId} issued an unexpected program launch command`);
  if (turn.history.postFinalToolCallCount > 0) failures.push(`${turn.turnId} issued a tool call after its final marker`);
  if (turn.history.postFinalToolOutputCount > 0) failures.push(`${turn.turnId} received a tool output after its final marker`);
  if (turn.history.duplicateCommandCount > 0) failures.push(`${turn.turnId} repeated an identical command`);
  if (turn.history.parseErrorSeen) failures.push(`${turn.turnId} contains a tool parse error`);
  if (turn.history.scopeViolationCount > 0) {
    failures.push(`${turn.turnId} inspected outside its artifact scope: ${compactText(JSON.stringify(turn.history.scopeViolations))}`);
  }
}

function readSignedHumanLongJourneyReport(sourcePath) {
  const reportPath = resolve(sourcePath);
  const signaturePath = `${reportPath}.sha256`;
  if (!existsSync(reportPath) || !existsSync(signaturePath)) {
    throw new Error("stored human long-journey report or signature is missing");
  }
  const sourceText = readFileSync(reportPath, "utf8");
  const sourceSha256 = createHash("sha256").update(sourceText).digest("hex");
  const expectedSha256 = readFileSync(signaturePath, "ascii").trim().toLowerCase();
  if (!expectedSha256 || sourceSha256 !== expectedSha256) {
    throw new Error("stored human long-journey report signature does not match");
  }
  const report = JSON.parse(sourceText.replace(/^\uFEFF/, ""));
  if (report?.reportName !== "ui-human-long-journey" || report?.usedRealTraffic !== true) {
    throw new Error("stored report is not real human long-journey evidence");
  }
  return { reportPath, sourceSha256, report };
}

function revalidateStoredHumanLongJourney(sourcePath) {
  if (allowRealTraffic) throw new Error("stored report revalidation cannot be combined with real traffic");
  const revalidationStartedAt = Date.now();
  const { reportPath, sourceSha256, report: sourceReport } = readSignedHumanLongJourneyReport(sourcePath);
  model = String(sourceReport.model || "").trim();
  const journeys = (Array.isArray(sourceReport.journeys) ? sourceReport.journeys : []).map((journey) => {
    const allowDuplicate = journey?.id === "interrupted-migration-three-turn"
      ? allowMigrationIdempotencyDuplicate
      : null;
    const turns = (Array.isArray(journey?.turns) ? journey.turns : []).map((turn) => ({
      ...turn,
      history: {
        ...(turn?.history || {}),
        duplicateCommandCount: countDuplicateCommands(turn?.history?.scopedCommands || [], { allowDuplicate }),
      },
    }));
    const failures = (Array.isArray(journey?.failures) ? journey.failures : [])
      .filter((failure) => !String(failure).endsWith(" repeated an identical command"));
    for (const turn of turns) {
      if (Number(turn?.history?.duplicateCommandCount || 0) > 0) {
        failures.push(`${turn.turnId} repeated an identical command`);
      }
    }
    if (turns.length === 0 || turns.some((turn) => turn?.ok !== true)) {
      failures.push("stored journey contains an incomplete desktop turn");
    }
    if (!journey?.artifactEvidence || typeof journey.artifactEvidence !== "object") {
      failures.push("stored journey has no result artifact evidence");
    }
    return {
      ...journey,
      ok: failures.length === 0,
      failures,
      turns,
      turnCount: turns.length,
      passedTurnCount: turns.filter((turn) => turn?.ok === true).length,
    };
  });

  const expectedJourneyIds = ["greenfield-project-three-turn", "interrupted-migration-three-turn"];
  const actualJourneyIds = journeys.map((journey) => String(journey?.id || "")).sort();
  const failures = journeys.flatMap((journey) => journey.failures.map((failure) => `${journey.id}: ${failure}`));
  if (JSON.stringify(actualJourneyIds) !== JSON.stringify(expectedJourneyIds)) {
    failures.push("stored report does not contain the exact required multi-style journeys");
  }
  const totalTurnCount = journeys.reduce((sum, journey) => sum + journey.turnCount, 0);
  if (totalTurnCount < 7) failures.push(`stored report contains only ${totalTurnCount} visible turns`);
  if (sourceReport?.workspaceRestore?.ok !== true || sourceReport?.workspaceRestore?.stateRestored !== true) {
    failures.push("stored report did not restore the original workspace");
  }
  if (sourceReport?.terminalProviderStop) failures.push("stored report contains a terminal provider stop");
  const ok = failures.length === 0 && journeys.length === expectedJourneyIds.length;
  return writeReport({
    ...sourceReport,
    ok,
    behaviorCovered: ok,
    failures,
    journeyIds: journeys.map((journey) => journey.id),
    journeyCount: journeys.length,
    passedJourneyCount: journeys.filter((journey) => journey.ok).length,
    totalTurnCount,
    passedTurnCount: journeys.reduce((sum, journey) => sum + journey.passedTurnCount, 0),
    resultValidatedJourneyCount: journeys.filter((journey) => journey.ok && journey.artifactEvidence).length,
    journeys,
    cleanup: { ...(sourceReport.cleanup || {}), removed: false, kept: true, reason: "signed_evidence_revalidation" },
    revalidation: {
      sourceReport: reportPath,
      sourceSha256,
      sourceReportOk: sourceReport.ok === true,
      sourceFailures: Array.isArray(sourceReport.failures) ? sourceReport.failures : [],
      requestedRealTraffic: false,
      usedRealTraffic: false,
      rawTurnEvidencePreserved: true,
      artifactEvidencePreserved: true,
      policy: "bounded_migration_idempotency_duplicates",
      elapsedMs: Date.now() - revalidationStartedAt,
      generatedAt: new Date().toISOString(),
    },
  });
}

function createInventoryFixture(root) {
  mkdirSync(resolve(root, "data"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify({ type: "module", scripts: { test: "node --test inventory.test.mjs" } }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "inventory-contract.json"), `${JSON.stringify({ statuses: ["active", "backorder"], skuCase: "upper", negativeQuantity: "reject", duplicateRule: "latest-updatedAt-wins" }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "data", "inventory.json"), `${JSON.stringify([
    { sku: " a-1 ", qty: "2", status: "ACTIVE", updatedAt: "2026-07-01T09:00:00Z" },
    { sku: "A-1", qty: 3, status: "active", updatedAt: "2026-07-02T09:00:00Z" },
    { sku: "b-2", qty: "0", status: "BACKORDER", updatedAt: "2026-07-03T09:00:00Z" },
    { sku: "c-3", qty: "bad", status: "active", updatedAt: "2026-07-04T09:00:00Z" },
    { sku: " ", qty: 1, status: "active", updatedAt: "2026-07-05T09:00:00Z" },
  ], null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "inventory.mjs"), [
    "export function normalizeRecord(record) {",
    "  return record;",
    "}",
    "",
    "export function summarizeRecords(records) {",
    "  return { recordCount: records.length, totalQuantity: 0, backorderCount: 0 };",
    "}",
    "",
    "throw new Error('TODO: inventory CLI is not implemented');",
    "",
  ].join("\n"), "utf8");
  writeFileSync(resolve(root, "inventory.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { normalizeRecord, summarizeRecords } from './inventory.mjs';",
    "",
    "test('normalizes one inventory record', () => {",
    "  assert.deepEqual(normalizeRecord({ sku: ' a-1 ', qty: '2', status: 'ACTIVE', updatedAt: '2026-07-01T09:00:00Z' }),",
    "    { sku: 'A-1', qty: 2, status: 'active', updatedAt: '2026-07-01T09:00:00Z' });",
    "});",
    "",
    "test('summarizes normalized records', () => {",
    "  assert.deepEqual(summarizeRecords([{ sku: 'A-1', qty: 2, status: 'active' }, { sku: 'B-2', qty: 0, status: 'backorder' }]),",
    "    { recordCount: 2, totalQuantity: 2, backorderCount: 1 });",
    "});",
    "",
  ].join("\n"), "utf8");
  writeFileSync(resolve(root, "work-notes.txt"), "Existing project. Fix in place; do not scaffold a replacement.\n", "utf8");
}

const allowedInventoryFiles = new Set([
  "README.md",
  "data/inventory.json",
  "index.html",
  "inventory-contract.json",
  "inventory.mjs",
  "inventory.test.mjs",
  "package.json",
  "report.md",
  "summary.json",
  "work-notes.txt",
]);

function inspectInventory(root, marker = "") {
  const packagePath = resolve(root, "package.json");
  const contractPath = resolve(root, "inventory-contract.json");
  const dataPath = resolve(root, "data", "inventory.json");
  const test = spawnNode(root, ["--test", "inventory.test.mjs"]);
  const deliveredOutputPath = resolve(root, "summary.json");
  const verificationRoot = mkdtempSync(join(os.tmpdir(), "anticodex-inventory-inspect-"));
  const verificationOutputPath = resolve(verificationRoot, "explicit-summary.json");
  const verificationDefaultOutputPath = resolve(verificationRoot, "summary.json");
  let dryRun;
  let dryJson;
  let dryRunDidNotWrite;
  let regular;
  let regularJson;
  let verificationWrittenJson;
  let defaultRun;
  let defaultJson;
  let defaultWrittenJson;
  try {
    mkdirSync(resolve(verificationRoot, "data"), { recursive: true });
    copyFileSync(resolve(root, "package.json"), resolve(verificationRoot, "package.json"));
    copyFileSync(contractPath, resolve(verificationRoot, "inventory-contract.json"));
    copyFileSync(resolve(root, "inventory.mjs"), resolve(verificationRoot, "inventory.mjs"));
    copyFileSync(dataPath, resolve(verificationRoot, "data", "inventory.json"));
    dryRun = spawnNode(verificationRoot, ["inventory.mjs", "--input", "data/inventory.json", "--output", verificationOutputPath, "--dry-run"]);
    dryJson = parseJsonOutput(dryRun.stdout);
    dryRunDidNotWrite = !existsSync(verificationOutputPath) && !existsSync(verificationDefaultOutputPath);
    regular = spawnNode(verificationRoot, ["inventory.mjs", "--input", "data/inventory.json", "--output", verificationOutputPath]);
    regularJson = parseJsonOutput(regular.stdout);
    verificationWrittenJson = readJson(verificationOutputPath);
    defaultRun = spawnNode(verificationRoot, ["inventory.mjs", "--input", "data/inventory.json"]);
    defaultJson = parseJsonOutput(defaultRun.stdout);
    defaultWrittenJson = readJson(verificationDefaultOutputPath);
  } finally {
    rmSync(verificationRoot, { recursive: true, force: true });
  }
  const deliveredJson = readJson(deliveredOutputPath);
  const expected = { inputCount: 5, acceptedCount: 2, rejectedCount: 2, duplicateCount: 1, totalQuantity: 3, backorderCount: 1 };
  const expectedKeys = Object.keys(expected).sort();
  const exactSummaryMatches = (value) => value
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === expectedKeys.join("\0")
    && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
  const summaryMatches = [dryJson, regularJson, verificationWrittenJson, defaultJson, defaultWrittenJson, deliveredJson].every(exactSummaryMatches);
  const moduleUrl = pathToFileURL(resolve(root, "inventory.mjs")).href;
  const hiddenCode = `import * as m from ${JSON.stringify(moduleUrl)};
const input=${JSON.stringify(readJson(dataPath))};
if(typeof m.normalizeRecord!=="function"||typeof m.dedupeLatest!=="function"||typeof m.summarizeRecords!=="function")process.exit(2);
const normalized=[];let rejected=0;for(const row of input){try{const value=m.normalizeRecord(row);if(value&&value.sku&&Number.isFinite(value.qty)&&value.qty>=0)normalized.push(value);else rejected++;}catch{rejected++;}}
const deduped=m.dedupeLatest(normalized);const summary=m.summarizeRecords(deduped);
if(summary.totalQuantity!==3||summary.backorderCount!==1)process.exit(3);
if(JSON.stringify(deduped.map(x=>x.sku))!==JSON.stringify(["A-1","B-2"]))process.exit(4);`;
  const hidden = spawnNode(root, ["--input-type=module", "-e", hiddenCode]);
  const testText = existsSync(resolve(root, "inventory.test.mjs")) ? readFileSync(resolve(root, "inventory.test.mjs"), "utf8") : "";
  const readme = existsSync(resolve(root, "README.md")) ? readFileSync(resolve(root, "README.md"), "utf8") : "";
  const report = existsSync(resolve(root, "report.md")) ? readFileSync(resolve(root, "report.md"), "utf8") : "";
  const html = existsSync(resolve(root, "index.html")) ? readFileSync(resolve(root, "index.html"), "utf8") : "";
  const reportReady = Boolean(marker)
    && report.includes(marker)
    && html.includes(marker)
    && /[\u3400-\u9fff]/u.test(readme)
    && /[\u3400-\u9fff]/u.test(report)
    && /<html[\s>]/i.test(html)
    && /<\/html>/i.test(html)
    && ["5", "2", "2", "1", "3"].every((value) => report.includes(value) && html.includes(value));
  const actualFiles = fileNames(root);
  return {
    testPassed: test.status === 0,
    dryRunPassed: dryRun.status === 0,
    regularRunPassed: regular.status === 0,
    defaultRunPassed: defaultRun.status === 0,
    dryRunDidNotWrite,
    summaryMatches,
    hiddenVerifierPassed: hidden.status === 0,
    businessTestCoverage: ["dedupeLatest", "dry-run", "acceptedCount", "duplicateCount"].every((token) => testText.includes(token)),
    expectedSummary: expected,
    dryRunStdout: dryJson,
    regularStdout: regularJson,
    defaultRunStdout: defaultJson,
    writtenSummary: deliveredJson,
    verificationWrittenSummary: verificationWrittenJson,
    defaultWrittenSummary: defaultWrittenJson,
    exitCodes: {
      test: test.status,
      dryRun: dryRun.status,
      regular: regular.status,
      defaultRun: defaultRun.status,
      hidden: hidden.status,
    },
    reportReady,
    packageHash: sha256File(packagePath),
    contractHash: sha256File(contractPath),
    dataHash: sha256File(dataPath),
    actualFiles,
    unexpectedFiles: actualFiles.filter((path) => !allowedInventoryFiles.has(path)),
    diagnostics: {
      test: compactText(test.stderr || test.stdout),
      dryRun: compactText(dryRun.stderr || dryRun.stdout),
      regular: compactText(regular.stderr || regular.stdout),
      defaultRun: compactText(defaultRun.stderr || defaultRun.stdout),
      hidden: compactText(hidden.stderr || hidden.stdout),
    },
  };
}

function inventoryBusinessEvidence(result) {
  return compactText(JSON.stringify({
    expected: result.expectedSummary,
    dryRunStdout: result.dryRunStdout,
    regularStdout: result.regularStdout,
    defaultRunStdout: result.defaultRunStdout,
    writtenSummary: result.writtenSummary,
    verificationWrittenSummary: result.verificationWrittenSummary,
    defaultWrittenSummary: result.defaultWrittenSummary,
    exitCodes: result.exitCodes,
  }), 2400);
}

function runInventoryJourney(matrixRoot) {
  const id = "messy-inventory-four-turn";
  const root = resolve(matrixRoot, id);
  const promptRoot = resolve(matrixRoot, "prompts", id);
  mkdirSync(root, { recursive: true });
  createInventoryFixture(root);
  const protectedBefore = {
    packageHash: sha256File(resolve(root, "package.json")),
    contractHash: sha256File(resolve(root, "inventory-contract.json")),
    dataHash: sha256File(resolve(root, "data", "inventory.json")),
  };
  const turns = [];
  const failures = [];
  let recoveryTurnCount = 0;
  const titleNeedle = `G8I${String(runId).slice(-10)}`;
  const initialHashes = treeHashes(root);
  const editRounds = [];
  const userCorrections = [{ turnId: "turn-2-business-correction", kind: "business-requirement-correction" }];

  const marker1 = `UI_HUMAN_LONG_INVENTORY_T1_${runId}`;
  let turn1 = runUiTurn({
    journeyId: id,
    turnId: "turn-1-repair-existing-tests",
    marker: marker1,
    artifactDir: root,
    sameChat: false,
    requiredFile: resolve(root, "inventory.mjs"),
    requiredContains: ["normalizeRecord", "summarizeRecords"],
    promptPath: writePrompt(promptRoot, "turn-1", [
      `任务名：${titleNeedle}。这个目录是别人做到一半留下的，不要新建另一套项目，也不要先问我问题。`,
      `工作目录：${root}`,
      "先阅读 package.json、inventory.mjs、inventory.test.mjs 和 inventory-contract.json，修复现有 inventory.mjs，让现有测试通过。",
      "package.json、inventory-contract.json、data/inventory.json 和 work-notes.txt 都是保护文件，不能修改、覆盖或删除；不要降低测试标准。",
      "当前目录不是 Git 仓库，不要运行 git status，也不要读取父目录、Antigravity 私有历史或任何工作目录外的文件。这个回合只允许修改 inventory.mjs，不要创建输出、报告或临时文件。",
      "实际运行 node --test inventory.test.mjs。命令前先用一句中文说明你要验证什么，不能只回复说完成了。",
      `测试真正通过后，最后一行写 ${marker1}。`,
    ]),
  });
  turns.push(turn1);
  let firstTest = spawnNode(root, ["--test", "inventory.test.mjs"]);
  if (!turn1.ok || firstTest.status !== 0) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_INVENTORY_T1_REPAIR_${runId}`;
    turn1 = runUiTurn({
      journeyId: id,
      turnId: "turn-1-repair-after-result-check",
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn1.ok,
      requiredFile: resolve(root, "inventory.mjs"),
      requiredContains: ["normalizeRecord", "summarizeRecords"],
      promptPath: writePrompt(promptRoot, "turn-1-repair", [
        "继续当前任务。宿主实际运行现有测试仍失败，上一轮不能算完成。",
        `真实测试尾部：${compactText(firstTest.stderr || firstTest.stdout, 500)}`,
        "只读取当前 inventory.mjs 和 inventory.test.mjs 各一次，然后修复 inventory.mjs；不要改测试、package.json、契约、输入或 work-notes.txt。补丁失败时改用 shell_command 和 Node fs.writeFileSync 全量写回当前文件，不要重复套用旧内容。",
        "重新运行 node --test inventory.test.mjs，以退出码 0 为准。",
        `通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn1);
    firstTest = spawnNode(root, ["--test", "inventory.test.mjs"]);
  }
  checkTurn(turn1, failures);
  if (firstTest.status !== 0) failures.push(`inventory first-turn test still failed after recovery: ${compactText(firstTest.stderr || firstTest.stdout)}`);
  const initialThreadId = turn1.history.threadId;
  const afterFirstTurnHashes = treeHashes(root);
  editRounds.push({ id: "repair-existing-tests", changedFiles: changedFiles(initialHashes, afterFirstTurnHashes) });

  const marker2 = `UI_HUMAN_LONG_INVENTORY_T2_${runId}`;
  let turn2 = runUiTurn({
    journeyId: id,
    turnId: "turn-2-business-correction",
    marker: marker2,
    artifactDir: root,
    sameChat: true,
    requiredFile: resolve(root, "summary.json"),
    requiredContains: ["inputCount", "acceptedCount", "duplicateCount"],
    promptPath: writePrompt(promptRoot, "turn-2", [
      "我补充真实业务规则，继续改当前项目，别推倒第一轮已经正确的部分。",
      "空 SKU、非法数量和负数数量要拒绝；同 SKU 按 updatedAt 最新记录保留；SKU 大写，状态小写，最终按 SKU 排序。",
      "导出 normalizeRecord、dedupeLatest、summarizeRecords。dedupeLatest(records) 必须返回按 SKU 排序的最终记录数组，summarizeRecords(records) 直接接收这个数组；重复数量由处理流程另外统计。CLI 支持 --input、--output、--dry-run。dry-run 只能向标准输出打印 JSON，不能写输出文件；普通运行既打印同一份六指标 JSON，也写摘要文件。--output 指定的路径必须写入同一份六指标 JSON；没有 --output 时，命令 node inventory.mjs --input data/inventory.json 必须只在当前工作目录写 summary.json。绝对不能遍历父目录、向祖先目录写 summary.json，或把本次临时绝对路径硬编码进代码和测试。--output 不是去重记录数组文件。",
      "对现有 data/inventory.json，结果必须是 inputCount=5、acceptedCount=2、rejectedCount=2、duplicateCount=1、totalQuantity=3、backorderCount=1。",
      "保留旧测试并增加必要测试。最终修改后各运行一次 node --test inventory.test.mjs、node inventory.mjs --input data/inventory.json --dry-run，以及 node inventory.mjs --input data/inventory.json；不要重复已通过且中间没有改代码的命令。继续保护 package.json、inventory-contract.json、data/inventory.json、work-notes.txt。",
      "新增测试必须使用专用临时文件并自行清理，不能删除、覆盖或依赖项目已有的 summary.json、output.json、rejects.txt；验收结束前清理测试生成物。不要运行 git status，不要读取工作目录外的任何路径。",
      `全部真实结果通过后，最后一行写 ${marker2}。`,
    ]),
  });
  turns.push(turn2);
  let afterBusiness = inspectInventory(root);
  const businessPasses = (result) => result.testPassed
    && result.dryRunPassed
    && result.regularRunPassed
    && result.defaultRunPassed
    && result.dryRunDidNotWrite
    && result.summaryMatches
    && result.hiddenVerifierPassed
    && result.businessTestCoverage
    && result.unexpectedFiles.length === 0;
  for (let attempt = 1; attempt <= 4 && !businessPasses(afterBusiness); attempt += 1) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_INVENTORY_T2_REPAIR_${attempt}_${runId}`;
    turn2 = runUiTurn({
      journeyId: id,
      turnId: `turn-2-repair-after-host-validation-${attempt}`,
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn2.ok,
      requiredFile: resolve(root, "inventory.test.mjs"),
      requiredContains: ["dedupeLatest", "dry-run", "acceptedCount", "duplicateCount"],
      promptPath: writePrompt(promptRoot, `turn-2-repair-${attempt}`, [
        `继续当前同一个项目，这是第 ${attempt} 次宿主结果修复。上一轮业务结果没有通过，不能只解释原因。`,
        `测试结果：${afterBusiness.testPassed ? "通过" : "失败"}；dry-run：${afterBusiness.dryRunPassed ? "通过" : "失败"}；显式输出运行：${afterBusiness.regularRunPassed ? "通过" : "失败"}；默认输出运行：${afterBusiness.defaultRunPassed ? "通过" : "失败"}；六项指标：${afterBusiness.summaryMatches ? "一致" : "不一致"}；隐藏函数验收：${afterBusiness.hiddenVerifierPassed ? "通过" : "失败"}；新增规则测试：${afterBusiness.businessTestCoverage ? "已覆盖" : "未覆盖"}；意外文件：${afterBusiness.unexpectedFiles.join(",") || "无"}。`,
        `宿主逐值证据：${inventoryBusinessEvidence(afterBusiness)}`,
        "隐藏函数验收要求 dedupeLatest(records) 直接返回数组，不能返回 { kept, duplicateCount } 对象；summarizeRecords 接收该数组。",
        "dry-run 标准输出、普通运行标准输出和写入的摘要文件必须全部等于 expected 六指标对象。--output 指定的路径必须写入同一份六指标 JSON；没有 --output 时必须执行 node inventory.mjs --input data/inventory.json，并且只能在当前工作目录写 summary.json。禁止遍历父目录、向祖先目录写 summary.json 或硬编码本次临时绝对路径。--output 不是去重记录数组文件。普通运行不能输出去重后的记录数组；退出码 0 但 JSON 内容不一致仍然是失败。",
        "先用 Get-Content -Raw 各读取一次当前 inventory.mjs 和 inventory.test.mjs。不要再按旧文件内容打补丁；若 apply_patch 上下文不匹配，立即改用 shell_command 配合 Node fs.writeFileSync 全量写回这两个允许修改的文件。",
        "inventory.test.mjs 必须分别断言 dry-run stdout、普通 stdout 和写入文件的六项指标，不能只测导出函数。测试只能使用专用临时文件，不能删除或覆盖已有 summary.json、output.json、rejects.txt；结束时清理测试生成物。保留所有旧测试语义。",
        "最终修改后各运行一次 node --test inventory.test.mjs、node inventory.mjs --input data/inventory.json --dry-run、node inventory.mjs --input data/inventory.json，且所有 JSON 的六项指标精确为 5/2/2/1/3/1。清理当前目录内所有非交付临时文件；package.json、契约、输入和 work-notes.txt 都不能改。",
        `实际复核通过后，最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn2);
    afterBusiness = inspectInventory(root);
  }
  checkTurn(turn2, failures);
  if (!afterBusiness.testPassed || !afterBusiness.dryRunPassed || !afterBusiness.regularRunPassed || !afterBusiness.defaultRunPassed) failures.push("inventory tests or CLI did not execute successfully after business correction");
  if (!afterBusiness.dryRunDidNotWrite) failures.push("inventory dry-run wrote summary.json");
  if (!afterBusiness.summaryMatches || !afterBusiness.hiddenVerifierPassed) failures.push(`inventory host result mismatch: ${inventoryBusinessEvidence(afterBusiness)}`);
  if (!afterBusiness.businessTestCoverage) failures.push("inventory corrected business rules are not covered by the project test file");
  const afterBusinessHashes = treeHashes(root);
  editRounds.push({ id: "business-correction", changedFiles: changedFiles(afterFirstTurnHashes, afterBusinessHashes) });

  if (!businessPasses(afterBusiness)) {
    return {
      id,
      ok: false,
      failureStage: "business-correction",
      failures,
      turnCount: turns.length,
      passedTurnCount: turns.filter((turn) => turn.ok).length,
      recoveryTurnCount,
      usedRealTraffic: turns.every((turn) => turn.usedRealTraffic),
      turns,
      editRounds,
      userCorrections,
      historyReopen: null,
      edgeRecovery: null,
      artifactEvidence: {
        protectedFilesUnchanged: afterBusiness.packageHash === protectedBefore.packageHash
          && afterBusiness.contractHash === protectedBefore.contractHash
          && afterBusiness.dataHash === protectedBefore.dataHash,
        testsPassed: afterBusiness.testPassed,
        dryRunPassed: afterBusiness.dryRunPassed,
        dryRunDidNotWrite: afterBusiness.dryRunDidNotWrite,
        regularRunPassed: afterBusiness.regularRunPassed,
        defaultRunPassed: afterBusiness.defaultRunPassed,
        summaryMatches: afterBusiness.summaryMatches,
        hiddenVerifierPassed: afterBusiness.hiddenVerifierPassed,
        businessTestCoverage: afterBusiness.businessTestCoverage,
        observedBusinessResult: {
          expected: afterBusiness.expectedSummary,
          dryRunStdout: afterBusiness.dryRunStdout,
          regularStdout: afterBusiness.regularStdout,
          defaultRunStdout: afterBusiness.defaultRunStdout,
          writtenSummary: afterBusiness.writtenSummary,
          verificationWrittenSummary: afterBusiness.verificationWrittenSummary,
          defaultWrittenSummary: afterBusiness.defaultWrittenSummary,
          exitCodes: afterBusiness.exitCodes,
        },
        unexpectedFiles: afterBusiness.unexpectedFiles,
        actualFiles: afterBusiness.actualFiles,
      },
    };
  }

  const marker3 = `UI_HUMAN_LONG_INVENTORY_T3_${runId}`;
  let turn3 = runUiTurn({
    journeyId: id,
    turnId: "turn-3-deliver-report",
    marker: marker3,
    artifactDir: root,
    sameChat: true,
    requiredFile: resolve(root, "index.html"),
    requiredContains: [marker3, "库存"],
    promptPath: writePrompt(promptRoot, "turn-3", [
      "功能结果可以了，现在把同一个项目交付完整，但不要改业务输入和契约。",
      "新增中文 README.md、report.md、index.html。报告必须写清实际跑出来的 5 条输入、2 条接收、2 条拒绝、1 条去重、总数量 3、缺货 1。",
      "index.html 必须是完整离线 HTML，不引用网络资源，并展示同样指标；report.md 和 index.html 都要包含准确标记。",
      "各运行一次 node --test inventory.test.mjs、node inventory.mjs --input data/inventory.json --dry-run、node inventory.mjs --input data/inventory.json，并读取当前目录 summary.json，不准根据自己写的文字猜结果。不要重复命令。若需要临时 --output 文件，只能使用当前目录 verification-output.json，核对后必须删除。",
      "最终目录只能保留 README.md、data/inventory.json、index.html、inventory-contract.json、inventory.mjs、inventory.test.mjs、package.json、report.md、summary.json、work-notes.txt；删除本轮或前面留下的 output.json、rejects.txt、actual-*、verification-* 和其他临时文件。",
      `报告标记是 ${marker3}。所有结果复核后，最后一行写 ${marker3}。`,
    ]),
  });
  turns.push(turn3);
  let afterReport = inspectInventory(root, marker3);
  for (let attempt = 1; attempt <= 2 && (!turn3.ok || !afterReport.reportReady || !afterReport.summaryMatches || !afterReport.hiddenVerifierPassed); attempt += 1) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_INVENTORY_T3_REPAIR_${attempt}_${runId}`;
    const reportAlreadyReady = afterReport.reportReady && afterReport.summaryMatches && afterReport.hiddenVerifierPassed;
    turn3 = runUiTurn({
      journeyId: id,
      turnId: `turn-3-repair-report-from-real-results-${attempt}`,
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn3.ok,
      requiredFile: reportAlreadyReady ? "" : resolve(root, "index.html"),
      requiredContains: reportAlreadyReady ? [] : [marker3, "库存"],
      promptPath: writePrompt(promptRoot, `turn-3-repair-${attempt}`, [
        reportAlreadyReady
          ? "继续当前交付。宿主已确认 README.md、report.md、index.html 和六项指标正确；这个回合禁止修改任何文件，只做最终复核和收尾回复。"
          : "继续当前交付。宿主检查发现报告文件或实际指标没有通过，不要重写业务代码。",
        reportAlreadyReady
          ? "只运行 node --test、CLI dry-run，并读取已有 summary.json；不要重复执行同一命令。"
          : "各运行一次 node --test inventory.test.mjs、node inventory.mjs --input data/inventory.json --dry-run、node inventory.mjs --input data/inventory.json，并读取当前目录 summary.json。只允许修 README.md、report.md、index.html；两份报告都必须使用实际六项指标 5/2/2/1/3/1，并保留原报告标记。",
        `原报告标记：${marker3}。package.json、业务代码、测试、契约和输入都不能修改。`,
        `宿主结果全部一致后，最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn3);
    afterReport = inspectInventory(root, marker3);
  }
  checkTurn(turn3, failures);
  if (!afterReport.reportReady) failures.push("inventory Chinese Markdown/HTML report did not match host-observed metrics and marker");
  if (!afterReport.summaryMatches || !afterReport.hiddenVerifierPassed) failures.push("inventory result regressed while writing the report");
  const afterReportHashes = treeHashes(root);
  editRounds.push({ id: "deliver-report", changedFiles: changedFiles(afterBusinessHashes, afterReportHashes) });

  const edgeHelperPath = resolve(root, "edge-once.mjs");
  const edgeLogPath = resolve(root, "edge-executions.log");
  const edgeStalePath = resolve(root, ".inventory-write.tmp");
  const summaryPath = resolve(root, "summary.json");
  const edgeExecutionMarker = `EDGE_EXECUTION_${runId}`;
  const expectedSummaryHash = sha256File(summaryPath);
  writeFileSync(edgeHelperPath, [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const path = new URL('./edge-executions.log', import.meta.url);",
    "const existing = existsSync(path) ? readFileSync(path, 'utf8').split(/\\r?\\n/).filter(Boolean) : [];",
    `writeFileSync(path, [...existing, ${JSON.stringify(edgeExecutionMarker)}].join('\\n') + '\\n', 'utf8');`,
    "if (existing.length > 0) { console.error('duplicate edge execution'); process.exit(42); }",
    "console.log('edge execution recorded once');",
    "",
  ].join("\n"), "utf8");
  const edgeHelperHash = sha256File(edgeHelperPath);
  writeFileSync(edgeStalePath, "{\"partial\":true}\n", "utf8");
  writeFileSync(summaryPath, "{\"inputCount\":5,\"acceptedCount\":0,\"rejectedCount\":0,\"duplicateCount\":0,\"totalQuantity\":0,\"backorderCount\":0}\n", "utf8");
  const injectedSummaryHash = sha256File(summaryPath);
  const inspectEdgeRecovery = () => {
    const executionLines = existsSync(edgeLogPath)
      ? readFileSync(edgeLogPath, "utf8").split(/\r?\n/).filter(Boolean)
      : [];
    const summary = readJson(summaryPath);
    const expected = afterReport.expectedSummary;
    const summaryExact = summary
      && Object.keys(summary).sort().join("\0") === Object.keys(expected).sort().join("\0")
      && Object.entries(expected).every(([key, value]) => summary[key] === value);
    const test = spawnNode(root, ["--test", "inventory.test.mjs"]);
    const summaryHashBeforeDryRun = existsSync(summaryPath) ? sha256File(summaryPath) : "";
    const dryRun = spawnNode(root, ["inventory.mjs", "--input", "data/inventory.json", "--output", "summary.json", "--dry-run"]);
    const summaryHashAfterDryRun = existsSync(summaryPath) ? sha256File(summaryPath) : "";
    return {
      executionCount: executionLines.length,
      executionLines,
      helperUnchanged: existsSync(edgeHelperPath) && sha256File(edgeHelperPath) === edgeHelperHash,
      staleTempAbsent: !existsSync(edgeStalePath),
      summaryExact,
      summaryRestored: summaryExact && summaryHashAfterDryRun === expectedSummaryHash,
      testPassed: test.status === 0,
      testExitCode: test.status,
      dryRunPassed: dryRun.status === 0,
      dryRunExitCode: dryRun.status,
      dryRunDidNotWrite: summaryHashBeforeDryRun === summaryHashAfterDryRun,
    };
  };
  const edgeMarker = `UI_HUMAN_LONG_INVENTORY_EDGE_${runId}`;
  let edgeTurn = runUiTurn({
    journeyId: id,
    turnId: "turn-4-interrupted-write-recovery",
    marker: edgeMarker,
    artifactDir: root,
    sameChat: true,
    requiredFile: summaryPath,
    requiredContains: ["acceptedCount", "duplicateCount", "totalQuantity"],
    promptPath: writePrompt(promptRoot, "turn-4-edge-recovery", [
      "继续同一个项目。现在模拟了一次真实中断：summary.json 是错误的，且留下了 .inventory-write.tmp。不要解释后停下，必须恢复。",
      "先且只运行一次 node edge-once.mjs；它是一次性执行哨兵，第二次运行会退出 42，所以绝对不能重放。不要修改或删除 edge-once.mjs 和 edge-executions.log。",
      "然后删除 .inventory-write.tmp，只运行一次 node inventory.mjs --input data/inventory.json 恢复当前目录 summary.json，再各运行一次 node --test inventory.test.mjs 和 node inventory.mjs --input data/inventory.json --dry-run。三条命令都不要重复。",
      "summary.json 最终仍必须精确为 5/2/2/1/3/1；保护 package.json、契约、输入和 work-notes.txt，不要修改报告文件。命令前先用中文说明本次恢复动作。",
      `确认一次性哨兵、测试和六项指标都正确后，最后一行写 ${edgeMarker}。`,
    ]),
  });
  turns.push(edgeTurn);
  let edgeState = inspectEdgeRecovery();
  for (let attempt = 1; attempt <= 2 && edgeState.executionCount <= 1 && (!edgeTurn.ok || !edgeState.summaryRestored || !edgeState.staleTempAbsent || !edgeState.testPassed || !edgeState.dryRunPassed || !edgeState.dryRunDidNotWrite || edgeState.executionCount !== 1); attempt += 1) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_INVENTORY_EDGE_REPAIR_${attempt}_${runId}`;
    const runSentinel = edgeState.executionCount === 0;
    edgeTurn = runUiTurn({
      journeyId: id,
      turnId: `turn-4-interrupted-write-repair-${attempt}`,
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !edgeTurn.ok,
      requiredFile: edgeState.summaryRestored ? "" : summaryPath,
      requiredContains: edgeState.summaryRestored ? [] : ["acceptedCount", "duplicateCount", "totalQuantity"],
      promptPath: writePrompt(promptRoot, `turn-4-edge-repair-${attempt}`, [
        "继续当前中断恢复，宿主结果仍未全部通过。",
        runSentinel
          ? "一次性哨兵还没有执行。现在只运行一次 node edge-once.mjs，之后本任务内绝对不要再运行它。"
          : "一次性哨兵已经成功执行过一次，禁止再次运行 node edge-once.mjs。",
        `当前哨兵次数=${edgeState.executionCount}；summary 恢复=${edgeState.summaryRestored}；临时文件已删=${edgeState.staleTempAbsent}；测试=${edgeState.testPassed}；dry-run=${edgeState.dryRunPassed}。`,
        "只补未完成动作：删除 .inventory-write.tmp，用一次 node inventory.mjs --input data/inventory.json 恢复当前目录 summary.json，再各运行一次 node --test inventory.test.mjs 和 node inventory.mjs --input data/inventory.json --dry-run；不得修改保护文件、业务代码、测试和报告，也不要重复命令。",
        `全部宿主条件满足后，最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(edgeTurn);
    edgeState = inspectEdgeRecovery();
  }
  checkTurn(edgeTurn, failures);
  const edgeRecovered = edgeState.executionCount === 1
    && edgeState.helperUnchanged
    && edgeState.staleTempAbsent
    && edgeState.summaryRestored
    && edgeState.testPassed
    && edgeState.dryRunPassed
    && edgeState.dryRunDidNotWrite;
  if (!edgeRecovered) failures.push(`interrupted-write edge did not recover exactly once: ${compactText(JSON.stringify(edgeState))}`);
  const edgeRecovery = {
    injected: injectedSummaryHash !== expectedSummaryHash,
    recovered: edgeRecovered,
    executionCount: edgeState.executionCount,
    staleConflictCount: countTurnStaleConflicts(turns),
    recoveredReconnectCount: turns.filter((turn) => turn.reconnectOutcome?.recovered === true).length,
    expectedSummaryHash,
    injectedSummaryHash,
    restoredSummaryHash: existsSync(summaryPath) ? sha256File(summaryPath) : "",
    helperHash: edgeHelperHash,
    executionMarker: edgeExecutionMarker,
    testExitCode: edgeState.testExitCode,
    dryRunExitCode: edgeState.dryRunExitCode,
  };
  editRounds.push({
    id: "interrupted-write-recovery",
    changedFiles: edgeRecovered ? ["summary.json", ".inventory-write.tmp", "edge-executions.log"] : [],
  });
  if (edgeRecovered) {
    unlinkSync(edgeHelperPath);
    unlinkSync(edgeLogPath);
  }

  const beforeNoopHashes = treeHashes(root);
  const marker4 = `UI_HUMAN_LONG_INVENTORY_T4_${runId}`;
  turns.push(runUiTurn({
    journeyId: id,
    turnId: "turn-4-read-only-reverification",
    marker: marker4,
    artifactDir: root,
    sameChat: true,
    promptPath: writePrompt(promptRoot, "turn-4", [
      "先别继续加东西，我只要交付前复核。这个回合禁止修改、创建、删除任何文件，也不要启动或打开任何软件。",
      `仍在目录 ${root}。只运行现有 node --test inventory.test.mjs，再运行 CLI 的 --dry-run，并读取已有 summary.json 对比六个指标。`,
      "如果都一致就直接结束；不要重写文件、不要格式化、不要重复执行同一命令。命令前先说一句中文说明。",
      `复核结果真的通过后，最后一行写 ${marker4}。`,
    ]),
  }));
  checkTurn(turns.at(-1), failures);
  const afterNoopHashes = treeHashes(root);
  const noopHistory = turns.at(-1).history;
  if (JSON.stringify(afterNoopHashes) !== JSON.stringify(beforeNoopHashes)) failures.push("read-only reverification changed project files");
  if (noopHistory.launchCommandCount !== 0) failures.push("read-only reverification launched a process or program");
  if (noopHistory.verificationCommandCount < 1) failures.push("read-only reverification did not run a verification command");
  if (noopHistory.verificationCommandCount > 3) failures.push(`read-only reverification repeated verification commands ${noopHistory.verificationCommandCount} times`);
  if (!noopHistory.chinesePreCommandSeen) failures.push("read-only reverification had no Chinese pre-command explanation");

  const beforeScopeAuditHashes = treeHashes(root);
  const marker5 = `UI_HUMAN_LONG_INVENTORY_T5_${runId}`;
  turns.push(runUiTurn({
    journeyId: id,
    turnId: "turn-5-scope-boundary-audit",
    marker: marker5,
    artifactDir: root,
    sameChat: true,
    promptPath: writePrompt(promptRoot, "turn-5", [
      "我担心前面改动越界了，这一回合只做范围审计，禁止修改、创建、删除、格式化任何文件，也不要启动或打开软件。",
      `仍在目录 ${root}。用只读命令列出全部相对文件，并计算 package.json、inventory-contract.json、data/inventory.json 的 SHA-256；再读取 summary.json 的六项指标。`,
      "最多使用三条只读命令，不要再运行会写 summary.json 的普通 CLI。命令前先用一句中文说明要核对保护文件和交付范围。",
      `确认文件集合和六项指标后，最后一行写 ${marker5}。`,
    ]),
  }));
  checkTurn(turns.at(-1), failures);
  const afterScopeAuditHashes = treeHashes(root);
  const scopeAuditHistory = turns.at(-1).history;
  if (JSON.stringify(afterScopeAuditHashes) !== JSON.stringify(beforeScopeAuditHashes)) failures.push("scope-boundary audit changed project files");
  if (scopeAuditHistory.launchCommandCount !== 0) failures.push("scope-boundary audit launched a process or program");
  if (scopeAuditHistory.shellCommands.length < 1 || scopeAuditHistory.shellCommands.length > 3) failures.push(`scope-boundary audit used ${scopeAuditHistory.shellCommands.length} shell commands`);
  if (!scopeAuditHistory.chinesePreCommandSeen) failures.push("scope-boundary audit had no Chinese pre-command explanation");

  const beforeDeliveryAuditHashes = treeHashes(root);
  const marker6 = `UI_HUMAN_LONG_INVENTORY_T6_${runId}`;
  turns.push(runUiTurn({
    journeyId: id,
    turnId: "turn-6-final-delivery-audit",
    marker: marker6,
    artifactDir: root,
    sameChat: true,
    promptPath: writePrompt(promptRoot, "turn-6", [
      "这是最终交付核对，不再增加需求。禁止修改、创建、删除任何文件，也不要启动或打开软件。",
      `在 ${root} 只运行一次 node --test inventory.test.mjs、一次 CLI --dry-run，然后只读检查 summary.json、report.md 和 index.html。`,
      "必须以命令退出码和文件里的实际 5/2/2/1/3/1 为准；不要重复命令，不要运行会写文件的普通 CLI。检查 report.md 和 index.html 时只用 Select-String 或同类定向搜索核对指标和标记，不要一次输出完整大文件。命令前先用一句中文说明这是最终结果验收。",
      `全部结果一致后，最后一行写 ${marker6}。`,
    ]),
  }));
  checkTurn(turns.at(-1), failures);
  const afterDeliveryAuditHashes = treeHashes(root);
  const deliveryAuditHistory = turns.at(-1).history;
  if (JSON.stringify(afterDeliveryAuditHashes) !== JSON.stringify(beforeDeliveryAuditHashes)) failures.push("final delivery audit changed project files");
  if (deliveryAuditHistory.launchCommandCount !== 0) failures.push("final delivery audit launched a process or program");
  if (deliveryAuditHistory.verificationCommandCount < 1 || deliveryAuditHistory.verificationCommandCount > 3) failures.push(`final delivery audit used ${deliveryAuditHistory.verificationCommandCount} verification commands`);
  if (!deliveryAuditHistory.chinesePreCommandSeen) failures.push("final delivery audit had no Chinese pre-command explanation");

  const beforeHistoryReopenHashes = treeHashes(root);
  const historyMarker = `UI_HUMAN_LONG_INVENTORY_HISTORY_${runId}`;
  const historyTurn = runUiTurn({
    journeyId: id,
    turnId: "turn-8-reopen-history-and-resume",
    marker: historyMarker,
    artifactDir: root,
    sameChatTitleContains: titleNeedle,
    navigateAwayBeforeHistoryReopen: true,
    requireHistoryResponsive: true,
    historyOpenBudgetMs: 5_000,
    promptPath: writePrompt(promptRoot, "turn-8-history-reopen", [
      `从空白任务页重新打开历史任务 ${titleNeedle} 后，继续原来的库存项目，不要建立新项目。`,
      `仍在 ${root}。这个回合禁止修改、创建、删除任何文件，也不要启动软件。`,
      "只运行一次 node --test inventory.test.mjs，并只读核对 summary.json 仍为 5/2/2/1/3/1。命令前先用中文说明这是历史续跑验证，不要重复命令。",
      `确认你看到的是原任务文件和结果后，最后一行写 ${historyMarker}。`,
    ]),
  });
  turns.push(historyTurn);
  checkTurn(historyTurn, failures);
  const afterHistoryReopenHashes = treeHashes(root);
  const historySameChat = historyTurn.sameChatEvidence || {};
  const historyReopen = {
    ...evaluateHistoryReopenEvidence({
      initialThreadId,
      historyTurn,
      sameChatEvidence: historySameChat,
      filesUnchanged: JSON.stringify(afterHistoryReopenHashes) === JSON.stringify(beforeHistoryReopenHashes),
      historyOpenBudgetMs: 5_000,
    }),
    titleNeedle,
    marker: historyMarker,
    rolloutFile: historyTurn.history.rolloutFile,
  };
  if (!historyReopen.ok) failures.push(`inventory history did not reopen and resume cleanly: ${compactText(JSON.stringify(historyReopen))}`);
  if (historyTurn.history.launchCommandCount !== 0) failures.push("history reopen verification launched a process or program");
  const minimumEightTurns = turns.length >= 8;
  if (!minimumEightTurns) failures.push(`inventory journey completed only ${turns.length} user turns`);

  const final = inspectInventory(root, marker3);
  if (final.packageHash !== protectedBefore.packageHash) failures.push("package.json was modified");
  if (final.contractHash !== protectedBefore.contractHash) failures.push("inventory-contract.json was modified");
  if (final.dataHash !== protectedBefore.dataHash) failures.push("data/inventory.json was modified");
  if (final.unexpectedFiles.length > 0) failures.push(`inventory project contains unexpected files: ${final.unexpectedFiles.join(", ")}`);
  const artifactEvidence = {
    protectedFilesUnchanged: final.packageHash === protectedBefore.packageHash && final.contractHash === protectedBefore.contractHash && final.dataHash === protectedBefore.dataHash,
    testsPassed: final.testPassed,
    dryRunPassed: final.dryRunPassed,
    dryRunDidNotWrite: final.dryRunDidNotWrite,
    regularRunPassed: final.regularRunPassed,
    defaultRunPassed: final.defaultRunPassed,
    summaryMatches: final.summaryMatches,
    hiddenVerifierPassed: final.hiddenVerifierPassed,
    businessTestCoverage: final.businessTestCoverage,
    reportReady: final.reportReady,
    noopHashesUnchanged: JSON.stringify(afterNoopHashes) === JSON.stringify(beforeNoopHashes),
    noopLaunchCommandCount: noopHistory.launchCommandCount,
    noopVerificationCommandCount: noopHistory.verificationCommandCount,
    scopeAuditHashesUnchanged: JSON.stringify(afterScopeAuditHashes) === JSON.stringify(beforeScopeAuditHashes),
    scopeAuditLaunchCommandCount: scopeAuditHistory.launchCommandCount,
    deliveryAuditHashesUnchanged: JSON.stringify(afterDeliveryAuditHashes) === JSON.stringify(beforeDeliveryAuditHashes),
    deliveryAuditLaunchCommandCount: deliveryAuditHistory.launchCommandCount,
    minimumEightTurns,
    edgeRecovery,
    historyReopen,
    unexpectedFiles: final.unexpectedFiles,
    actualFiles: final.actualFiles,
  };
  return {
    id,
    ok: failures.length === 0,
    failures,
    turnCount: turns.length,
    passedTurnCount: turns.filter((turn) => turn.ok).length,
    recoveryTurnCount,
    usedRealTraffic: turns.every((turn) => turn.usedRealTraffic),
    turns,
    editRounds,
    userCorrections,
    edgeRecovery,
    historyReopen,
    artifactEvidence,
  };
}

function createMigrationFixture(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify({ type: "module", scripts: { test: "node --test migrate.test.mjs" } }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "migration-contract.json"), `${JSON.stringify({ duplicateRule: "last-line-wins", idCase: "upper", emailCase: "lower", outputOrder: "id-ascending", malformedPolicy: "reject-exact-line" }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "records.ndjson"), [
    JSON.stringify({ id: "B2", email: " B@EXAMPLE.COM ", active: true }),
    "{bad json",
    JSON.stringify({ id: "A1", email: "A@EXAMPLE.COM", active: true }),
    JSON.stringify({ id: "B2", email: "latest@example.com", active: false }),
    "",
  ].join("\n"), "utf8");
  writeFileSync(resolve(root, "migrate.mjs"), "throw new Error('TODO: interrupted migration implementation');\n", "utf8");
  writeFileSync(resolve(root, "migrate.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { parseRecords, migrateRecords } from './migrate.mjs';",
    "",
    "test('parses malformed NDJSON without hiding it', () => {",
    "  const parsed = parseRecords('{\"id\":\"A1\",\"email\":\"A@EXAMPLE.COM\",\"active\":true}\\n{bad json\\n');",
    "  assert.equal(parsed.valid.length, 1);",
    "  assert.deepEqual(parsed.rejected, ['{bad json']);",
    "});",
    "",
    "test('normalizes and keeps the last duplicate', () => {",
    "  const result = migrateRecords([{ id: 'b2', email: 'old@EXAMPLE.COM', active: true }, { id: 'B2', email: 'NEW@example.com', active: false }]);",
    "  assert.deepEqual(result.records, [{ id: 'B2', email: 'new@example.com', active: false }]);",
    "  assert.equal(result.duplicateCount, 1);",
    "});",
    "",
  ].join("\n"), "utf8");
}

const allowedMigrationFiles = new Set([
  "migrate.mjs",
  "migrate.test.mjs",
  "migration-contract.json",
  "migration-summary.json",
  "normalized.json",
  "package.json",
  "records.ndjson",
  "rejects.ndjson",
]);

function inspectMigration(root) {
  const inputPath = resolve(root, "records.ndjson");
  const contractPath = resolve(root, "migration-contract.json");
  const outputPath = resolve(root, "normalized.json");
  const rejectsPath = resolve(root, "rejects.ndjson");
  const summaryPath = resolve(root, "migration-summary.json");
  const test = spawnNode(root, ["--test", "migrate.test.mjs"]);
  const firstRun = spawnNode(root, ["migrate.mjs", "--input", "records.ndjson", "--output", "normalized.json", "--rejects", "rejects.ndjson", "--summary", "migration-summary.json"]);
  const firstHashes = [outputPath, rejectsPath, summaryPath].map((path) => existsSync(path) ? sha256File(path) : "");
  const secondRun = spawnNode(root, ["migrate.mjs", "--input", "records.ndjson", "--output", "normalized.json", "--rejects", "rejects.ndjson", "--summary", "migration-summary.json"]);
  const secondHashes = [outputPath, rejectsPath, summaryPath].map((path) => existsSync(path) ? sha256File(path) : "");
  const output = readJson(outputPath);
  const summary = readJson(summaryPath);
  const rejects = existsSync(rejectsPath) ? readFileSync(rejectsPath, "utf8") : "";
  const expectedOutput = [
    { id: "A1", email: "a@example.com", active: true },
    { id: "B2", email: "latest@example.com", active: false },
  ];
  const expectedSummary = { inputCount: 4, outputCount: 2, rejectedCount: 1, duplicateCount: 1 };
  const actualFiles = fileNames(root);
  return {
    testPassed: test.status === 0,
    firstRunPassed: firstRun.status === 0,
    secondRunPassed: secondRun.status === 0,
    outputMatches: JSON.stringify(output) === JSON.stringify(expectedOutput),
    summaryMatches: summary && Object.entries(expectedSummary).every(([key, value]) => summary[key] === value),
    rejectsExact: rejects === "{bad json",
    idempotent: JSON.stringify(firstHashes) === JSON.stringify(secondHashes) && firstHashes.every(Boolean),
    staleTempAbsent: !existsSync(resolve(root, ".normalized.json.tmp")),
    inputHash: sha256File(inputPath),
    contractHash: sha256File(contractPath),
    actualFiles,
    unexpectedFiles: actualFiles.filter((path) => !allowedMigrationFiles.has(path)),
    diagnostics: {
      test: compactText(test.stderr || test.stdout),
      firstRun: compactText(firstRun.stderr || firstRun.stdout),
      secondRun: compactText(secondRun.stderr || secondRun.stdout),
    },
  };
}

function runMigrationJourney(matrixRoot) {
  const id = "interrupted-migration-three-turn";
  const root = resolve(matrixRoot, id);
  const promptRoot = resolve(matrixRoot, "prompts", id);
  createMigrationFixture(root);
  const protectedBefore = {
    inputHash: sha256File(resolve(root, "records.ndjson")),
    contractHash: sha256File(resolve(root, "migration-contract.json")),
  };
  const turns = [];
  const failures = [];
  let recoveryTurnCount = 0;

  const marker1 = `UI_HUMAN_LONG_MIGRATION_T1_${runId}`;
  let turn1 = runUiTurn({
    journeyId: id,
    turnId: "turn-1-recover-broken-migrator",
    marker: marker1,
    artifactDir: root,
    sameChat: false,
    requiredFile: resolve(root, "normalized.json"),
    requiredContains: ["A1", "B2"],
    promptPath: writePrompt(promptRoot, "turn-1", [
      "这是一个中断后留下的数据迁移目录，不要另起项目。",
      `目录：${root}`,
      `所有 shell_command 都必须把 workdir 设为 ${root}；不得搜索或读取这个目录之外的文件，包括 Temp 里的其他任务、宿主项目和 Antigravity/Codex 私有运行记录。`,
      "阅读 migration-contract.json、records.ndjson、migrate.mjs、migrate.test.mjs。修复 migrate.mjs，导出 parseRecords 和 migrateRecords，并让现有测试通过。",
      "CLI 读取 NDJSON，把 ID 大写、邮箱小写去空格、重复 ID 保留最后一行，输出按 ID 排序的 normalized.json，同时写 migration-summary.json。坏 JSON 不能让整个任务崩掉。summary 字段固定为 inputCount、outputCount、rejectedCount、duplicateCount。",
      "第一轮必须用 node migrate.mjs --input records.ndjson --output normalized.json --summary migration-summary.json 实际验证，不能改成位置参数。",
      "records.ndjson、migration-contract.json 和现有测试第一轮都不能改。实际运行测试和 CLI，再读取输出核对。",
      "命令前先用一句中文说明你接下来要做什么。",
      `结果正确后，最后一行写 ${marker1}。`,
    ]),
  });
  turns.push(turn1);
  let firstTest = spawnNode(root, ["--test", "migrate.test.mjs"]);
  let firstOutput = readJson(resolve(root, "normalized.json"));
  const expectedOutput = [{ id: "A1", email: "a@example.com", active: true }, { id: "B2", email: "latest@example.com", active: false }];
  if (!turn1.ok || firstTest.status !== 0 || JSON.stringify(firstOutput) !== JSON.stringify(expectedOutput)) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_MIGRATION_T1_REPAIR_${runId}`;
    turn1 = runUiTurn({
      journeyId: id,
      turnId: "turn-1-repair-after-result-check",
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn1.ok,
      requiredFile: resolve(root, "normalized.json"),
      requiredContains: ["A1", "B2"],
      promptPath: writePrompt(promptRoot, "turn-1-repair", [
        "继续当前迁移。宿主实际测试或 normalized.json 没通过，上一轮不能算完成。",
        `所有 shell_command 的 workdir 必须是 ${root}，不得读取这个目录之外的任何文件。`,
        `测试尾部：${compactText(firstTest.stderr || firstTest.stdout, 500)}`,
        "只读取当前 migrate.mjs、migrate.test.mjs 各一次。修复 migrate.mjs，不修改测试、输入和契约；补丁上下文失败时用 shell_command 配合 Node fs.writeFileSync 全量写回 migrate.mjs。",
        "运行测试，并用 node migrate.mjs --input records.ndjson --output normalized.json --summary migration-summary.json 验证；normalized.json 必须只含排序后的 A1、B2，B2 使用最后一行邮箱。",
        "命令前先用一句中文说明你接下来要做什么。",
        `通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn1);
    firstTest = spawnNode(root, ["--test", "migrate.test.mjs"]);
    firstOutput = readJson(resolve(root, "normalized.json"));
  }
  checkTurn(turn1, failures);
  if (firstTest.status !== 0 || JSON.stringify(firstOutput) !== JSON.stringify(expectedOutput)) failures.push("migration first-turn tests or normalized output still failed after recovery");

  const marker2 = `UI_HUMAN_LONG_MIGRATION_T2_${runId}`;
  let turn2 = runUiTurn({
    journeyId: id,
    turnId: "turn-2-add-idempotent-rejects",
    marker: marker2,
    artifactDir: root,
    sameChat: true,
    requiredFile: resolve(root, "rejects.ndjson"),
    requiredContains: ["{bad json"],
    allowDuplicateCommand: allowMigrationIdempotencyDuplicate,
      promptPath: writePrompt(promptRoot, "turn-2", [
        "刚才漏了审计要求，继续当前迁移，不要重写输入。",
        `所有 shell_command 的 workdir 仍必须是 ${root}，不得读取这个目录之外的任何文件。`,
      "增加 --rejects 和 --summary 参数。rejects.ndjson 必须逐字保留坏行 `{bad json`，不能加解释文字、引号或额外换行。",
      "写 normalized.json、rejects.ndjson、migration-summary.json 时要可重复运行；连续执行两次不能追加、不能重复记录，三份结果字节必须稳定。",
        "summary 必须是 inputCount=4、outputCount=2、rejectedCount=1、duplicateCount=1。可扩充测试，但不能删旧断言。",
        "npm test 只运行一次；迁移 CLI 恰好运行两次：node migrate.mjs --input records.ndjson --output normalized.json --rejects rejects.ndjson --summary migration-summary.json，并实际比较三份文件。保护 records.ndjson 和 migration-contract.json。",
        "命令前先用一句中文说明你接下来要做什么。",
      `验证通过后，最后一行写 ${marker2}。`,
    ]),
  });
  turns.push(turn2);
  let afterIdempotency = inspectMigration(root);
  const migrationPasses = (result) => result.testPassed
    && result.firstRunPassed
    && result.secondRunPassed
    && result.outputMatches
    && result.summaryMatches
    && result.rejectsExact
    && result.idempotent;
  if (!turn2.ok || !migrationPasses(afterIdempotency)) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_MIGRATION_T2_REPAIR_${runId}`;
    turn2 = runUiTurn({
      journeyId: id,
      turnId: "turn-2-repair-after-host-validation",
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn2.ok,
      requiredFile: resolve(root, "rejects.ndjson"),
      requiredContains: ["{bad json"],
      allowDuplicateCommand: allowMigrationIdempotencyDuplicate,
      promptPath: writePrompt(promptRoot, "turn-2-repair", [
        "继续当前迁移。宿主连续运行两次后，审计输出仍未通过，不能只回复解释。",
        `所有 shell_command 的 workdir 必须是 ${root}，不得读取这个目录之外的任何文件。`,
        `测试=${afterIdempotency.testPassed}，首次 CLI=${afterIdempotency.firstRunPassed}，第二次 CLI=${afterIdempotency.secondRunPassed}，输出=${afterIdempotency.outputMatches}，摘要=${afterIdempotency.summaryMatches}，坏行精确=${afterIdempotency.rejectsExact}，幂等=${afterIdempotency.idempotent}。`,
        `关键错误：${compactText(afterIdempotency.diagnostics.test || afterIdempotency.diagnostics.firstRun, 700)}`,
        "读取当前 migrate.mjs 和测试各一次；只修允许文件。apply_patch 失败就用 shell_command 和 Node fs.writeFileSync 全量写回，不要反复猜旧上下文。",
        "npm test 只运行一次，不要在结尾重复；迁移 CLI 恰好运行两次：node migrate.mjs --input records.ndjson --output normalized.json --rejects rejects.ndjson --summary migration-summary.json；normalized.json、rejects.ndjson、migration-summary.json 三份字节必须稳定。",
        "命令前先用一句中文说明你接下来要做什么。",
        `通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn2);
    afterIdempotency = inspectMigration(root);
  }
  checkTurn(turn2, failures);
  if (!afterIdempotency.testPassed || !afterIdempotency.firstRunPassed || !afterIdempotency.secondRunPassed) failures.push("migration tests or repeated CLI run failed");
  if (!afterIdempotency.outputMatches || !afterIdempotency.summaryMatches || !afterIdempotency.rejectsExact) failures.push("migration host-observed files do not match the contract");
  if (!afterIdempotency.idempotent) failures.push("migration outputs are not byte-stable across two runs");

  writeFileSync(resolve(root, ".normalized.json.tmp"), "[{\"id\":\"PARTIAL\"}]", "utf8");
  if (existsSync(resolve(root, "normalized.json"))) unlinkSync(resolve(root, "normalized.json"));
  writeFileSync(resolve(root, "migration-summary.json"), "{\"state\":\"interrupted\"}\n", "utf8");
  const marker3 = `UI_HUMAN_LONG_MIGRATION_T3_${runId}`;
  let turn3 = runUiTurn({
    journeyId: id,
    turnId: "turn-3-resume-interrupted-state",
    marker: marker3,
    artifactDir: root,
    sameChat: true,
    requiredFile: resolve(root, "normalized.json"),
    requiredContains: ["A1", "latest@example.com"],
    allowDuplicateCommand: allowMigrationIdempotencyDuplicate,
    promptPath: writePrompt(promptRoot, "turn-3", [
      "刚才进程被打断了：normalized.json 不见了，migration-summary.json 是半成品，目录里还有 .normalized.json.tmp。请在当前项目恢复，不要让我手工清理。",
      `所有 shell_command 的 workdir 必须是 ${root}，不得读取这个目录之外的任何文件。`,
      "先检查现场，再让迁移脚本从 records.ndjson 安全重建三份最终输出，并清理这个已知的临时文件。不能把临时文件当成正确数据。",
      "恢复后 npm test 只运行一次；迁移 CLI 恰好运行两次：node migrate.mjs --input records.ndjson --output normalized.json --rejects rejects.ndjson --summary migration-summary.json，三份结果必须稳定；records.ndjson、migration-contract.json 仍然不能修改。不要启动或打开任何桌面软件。",
      "命令前先用一句中文说明你接下来要做什么。",
      `确认最终 normalized.json 只有 A1 和 B2、rejects.ndjson 仍逐字等于坏行后，最后一行写 ${marker3}。`,
    ]),
  });
  turns.push(turn3);
  let final = inspectMigration(root);
  if (!turn3.ok || !migrationPasses(final) || !final.staleTempAbsent) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_MIGRATION_T3_REPAIR_${runId}`;
    turn3 = runUiTurn({
      journeyId: id,
      turnId: "turn-3-repair-interrupted-state",
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn3.ok,
      requiredFile: resolve(root, "normalized.json"),
      requiredContains: ["A1", "latest@example.com"],
      allowDuplicateCommand: allowMigrationIdempotencyDuplicate,
      promptPath: writePrompt(promptRoot, "turn-3-repair", [
        "继续恢复现场。宿主检查显示中断恢复仍未完成。",
        `所有 shell_command 的 workdir 必须是 ${root}，不得读取这个目录之外的任何文件。`,
        `输出=${final.outputMatches}，摘要=${final.summaryMatches}，坏行=${final.rejectsExact}，幂等=${final.idempotent}，临时文件已清理=${final.staleTempAbsent}。`,
        "从受保护输入重新运行迁移并清理 .normalized.json.tmp；不要启动软件，不要修改输入和契约。npm test 只运行一次；迁移 CLI 恰好运行两次：node migrate.mjs --input records.ndjson --output normalized.json --rejects rejects.ndjson --summary migration-summary.json，之后再读回三份结果。",
        "命令前先用一句中文说明你接下来要做什么。",
        `全部通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn3);
    final = inspectMigration(root);
  }
  checkTurn(turn3, failures);
  if (!final.testPassed || !final.firstRunPassed || !final.secondRunPassed) failures.push("migration recovery did not leave tests and repeated CLI green");
  if (!final.outputMatches || !final.summaryMatches || !final.rejectsExact || !final.idempotent) failures.push("migration recovery result failed hidden host validation");
  if (!final.staleTempAbsent) failures.push("migration recovery left the known stale temp file");
  if (final.inputHash !== protectedBefore.inputHash) failures.push("records.ndjson was modified");
  if (final.contractHash !== protectedBefore.contractHash) failures.push("migration-contract.json was modified");
  if (final.unexpectedFiles.length > 0) failures.push(`migration project contains unexpected files: ${final.unexpectedFiles.join(", ")}`);
  if (turn3.history.launchCommandCount !== 0) failures.push("interrupted-state recovery launched a desktop program");

  const artifactEvidence = {
    protectedFilesUnchanged: final.inputHash === protectedBefore.inputHash && final.contractHash === protectedBefore.contractHash,
    testsPassed: final.testPassed,
    firstRunPassed: final.firstRunPassed,
    secondRunPassed: final.secondRunPassed,
    outputMatches: final.outputMatches,
    summaryMatches: final.summaryMatches,
    rejectsExact: final.rejectsExact,
    idempotent: final.idempotent,
    staleTempAbsent: final.staleTempAbsent,
    recoveryLaunchCommandCount: turn3.history.launchCommandCount,
    unexpectedFiles: final.unexpectedFiles,
    actualFiles: final.actualFiles,
  };
  return {
    id,
    ok: failures.length === 0,
    failures,
    turnCount: turns.length,
    passedTurnCount: turns.filter((turn) => turn.ok).length,
    recoveryTurnCount,
    usedRealTraffic: turns.every((turn) => turn.usedRealTraffic),
    turns,
    artifactEvidence,
  };
}

function createGreenfieldFixture(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify({
    type: "module",
    scripts: { test: "node --test stats.test.mjs" },
    name: "csv-stats-cli",
    version: "0.1.0",
    description: "CSV列统计CLI工具",
  }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "rules.json"), `${JSON.stringify({
    csvDelimiter: ",",
    numericColumns: ["score", "hours"],
    categoricalColumns: ["department"],
    statistics: ["count", "sum", "average", "min", "max"],
    outputFormat: "json",
    locale: "zh-CN",
    requirements: {
      cli: "必须支持 --input、--output、--format json|text 参数",
      tests: "必须使用 node:test",
      html: "必须包含中文标签的 HTML 报告",
      readme: "必须包含中文 README",
    },
  }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(root, "sample.csv"), [
    "name,department,score,hours",
    "Alice,Engineering,85,40",
    "Bob,Marketing,92,38",
    "Charlie,Engineering,78,42",
    "Diana,Sales,95,36",
    "Eve,Marketing,88,39",
    "Frank,Engineering,72,44",
    "Grace,Sales,91,37",
  ].join("\n"), "utf8");
}

const allowedGreenfieldFiles = new Set([
  "package.json",
  "rules.json",
  "sample.csv",
  "stats.mjs",
  "stats.test.mjs",
  "cli.mjs",
  "validate.mjs",
  "format.mjs",
  "index.html",
  "README.md",
  "summary.json",
  "report.json",
]);

function jsonDeepIncludes(obj, value) {
  if (obj === value) return true;
  if (typeof obj === "number" && typeof value === "number" && Math.abs(obj - value) < 0.01) return true;
  if (Array.isArray(obj)) return obj.some((item) => jsonDeepIncludes(item, value));
  if (obj && typeof obj === "object") return Object.values(obj).some((v) => jsonDeepIncludes(v, value));
  return false;
}

function inspectGreenfield(root, marker = "") {
  const rulesPath = resolve(root, "rules.json");
  const samplePath = resolve(root, "sample.csv");
  const packagePath = resolve(root, "package.json");
  const test = spawnNode(root, ["--test", "stats.test.mjs"]);
  const cliJson = spawnNode(root, ["cli.mjs", "--input", "sample.csv", "--format", "json"]);
  const cliJsonResult = parseJsonOutput(cliJson.stdout);
  const cliText = spawnNode(root, ["cli.mjs", "--input", "sample.csv", "--format", "text"]);
  const readme = existsSync(resolve(root, "README.md")) ? readFileSync(resolve(root, "README.md"), "utf8") : "";
  const html = existsSync(resolve(root, "index.html")) ? readFileSync(resolve(root, "index.html"), "utf8") : "";
  const summary = readJson(resolve(root, "summary.json"));
  const report = readJson(resolve(root, "report.json"));
  const readmeHasChinese = /[㐀-鿿]/u.test(readme);
  const htmlHasChinese = /[㐀-鿿]/u.test(html);
  const htmlIsFullPage = /<html[\s>]/i.test(html) && /<\/html>/i.test(html);
  const markerInHtml = marker ? html.includes(marker) : true;
  const markerInReadme = marker ? readme.includes(marker) : true;
  const cliJsonHasExpectedValues = cliJsonResult
    && jsonDeepIncludes(cliJsonResult, 7)
    && jsonDeepIncludes(cliJsonResult, 72)
    && jsonDeepIncludes(cliJsonResult, 95)
    && jsonDeepIncludes(cliJsonResult, 36)
    && jsonDeepIncludes(cliJsonResult, 44);
  const summaryHasExpectedValues = summary
    && jsonDeepIncludes(summary, 7)
    && jsonDeepIncludes(summary, 72)
    && jsonDeepIncludes(summary, 95);
  const actualFiles = fileNames(root);
  const nodeModulesPresent = actualFiles.some((f) => f.startsWith("node_modules/") || f.includes("/node_modules/"));
  return {
    testPassed: test.status === 0,
    cliJsonPassed: cliJson.status === 0,
    cliTextPassed: cliText.status === 0,
    cliJsonHasExpectedValues,
    readmeHasChinese,
    htmlHasChinese,
    htmlIsFullPage,
    markerInHtml,
    markerInReadme,
    summaryPresent: summary !== null,
    summaryHasExpectedValues,
    reportPresent: report !== null,
    rulesHash: sha256File(rulesPath),
    sampleHash: sha256File(samplePath),
    packageHash: sha256File(packagePath),
    actualFiles,
    fileCount: actualFiles.length,
    unexpectedFiles: actualFiles.filter((path) => !allowedGreenfieldFiles.has(path)),
    noNodeModules: !nodeModulesPresent,
    diagnostics: {
      test: compactText(test.stderr || test.stdout),
      cliJson: compactText(cliJson.stderr || cliJson.stdout),
      cliText: compactText(cliText.stderr || cliText.stdout),
    },
  };
}

function runGreenfieldJourney(matrixRoot) {
  const id = "greenfield-project-three-turn";
  const root = resolve(matrixRoot, id);
  const promptRoot = resolve(matrixRoot, "prompts", id);
  mkdirSync(root, { recursive: true });
  createGreenfieldFixture(root);
  const protectedBefore = {
    rulesHash: sha256File(resolve(root, "rules.json")),
    sampleHash: sha256File(resolve(root, "sample.csv")),
    packageHash: sha256File(resolve(root, "package.json")),
  };
  const turns = [];
  const failures = [];
  let recoveryTurnCount = 0;

  const marker1 = `UI_HUMAN_LONG_GREENFIELD_T1_${runId}`;
  let turn1 = runUiTurn({
    journeyId: id,
    turnId: "turn-1-build-multi-module",
    marker: marker1,
    artifactDir: root,
    sameChat: false,
    requiredFile: resolve(root, "stats.mjs"),
    requiredContains: ["parseCsv", "computeStats"],
    promptPath: writePrompt(promptRoot, "turn-1", [
      "这是一个全新项目目录，只有规则文件 rules.json、样例数据 sample.csv 和 package.json。",
      `工作目录：${root}`,
      `所有 shell_command 都必须把 workdir 设为 ${root}；不得搜索或读取这个目录之外的文件。`,
      "不要修改 rules.json、sample.csv 和 package.json，它们是只读输入。",
      "阅读 rules.json 了解需求规格，然后从零创建以下文件：",
      "1. stats.mjs - 核心统计模块，必须导出 parseCsv(csvText)、computeStats(rows, numericColumns)、breakdownByCategory(rows, categoryColumn) 函数",
      "2. cli.mjs - CLI 入口，支持 --input、--output、--format json|text 参数，默认格式 json",
      "3. stats.test.mjs - 使用 node:test 和 node:assert/strict 的测试，覆盖 CSV 解析、数值统计和分类分组",
      "4. index.html - 完整离线 HTML 页面，中文标题「CSV统计报告」，不引用外部网络资源",
      "sample.csv 有 7 行数据，score 列最小 72 最大 95，hours 列最小 36 最大 44，department 有 Engineering/Marketing/Sales 三组。",
      "CLI 必须能实际运行 node cli.mjs --input sample.csv --format json 并输出包含统计结果的 JSON。",
      "测试必须通过 node --test stats.test.mjs。命令前先用一句中文说明你要做什么。",
      `完成后最后一行写 ${marker1}。`,
    ]),
  });
  turns.push(turn1);
  let firstTest = spawnNode(root, ["--test", "stats.test.mjs"]);
  let firstCli = spawnNode(root, ["cli.mjs", "--input", "sample.csv", "--format", "json"]);
  if (!turn1.ok || firstTest.status !== 0 || firstCli.status !== 0) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_GREENFIELD_T1_REPAIR_${runId}`;
    turn1 = runUiTurn({
      journeyId: id,
      turnId: "turn-1-repair-after-result-check",
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn1.ok,
      requiredFile: resolve(root, "stats.mjs"),
      requiredContains: ["parseCsv", "computeStats"],
      promptPath: writePrompt(promptRoot, "turn-1-repair", [
        "继续当前项目。宿主实际运行测试或 CLI 未通过，上一轮不能算完成。",
        `所有 shell_command 的 workdir 必须是 ${root}，不得读取这个目录之外的任何文件。`,
        `测试尾部：${compactText(firstTest.stderr || firstTest.stdout, 500)}`,
        `CLI 尾部：${compactText(firstCli.stderr || firstCli.stdout, 500)}`,
        "只读取当前 stats.mjs 和 stats.test.mjs 各一次，然后修复。不要修改 rules.json、sample.csv 和 package.json。",
        "补丁失败时用 shell_command 配合 Node fs.writeFileSync 全量写回当前文件。",
        "实际运行 node --test stats.test.mjs 和 node cli.mjs --input sample.csv --format json，以退出码 0 为准。",
        `通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn1);
    firstTest = spawnNode(root, ["--test", "stats.test.mjs"]);
    firstCli = spawnNode(root, ["cli.mjs", "--input", "sample.csv", "--format", "json"]);
  }
  checkTurn(turn1, failures);
  if (firstTest.status !== 0) failures.push(`greenfield first-turn test failed: ${compactText(firstTest.stderr || firstTest.stdout)}`);
  if (firstCli.status !== 0) failures.push(`greenfield first-turn CLI failed: ${compactText(firstCli.stderr || firstCli.stdout)}`);

  const marker2 = `UI_HUMAN_LONG_GREENFIELD_T2_${runId}`;
  let turn2 = runUiTurn({
    journeyId: id,
    turnId: "turn-2-add-validation-formatting",
    marker: marker2,
    artifactDir: root,
    sameChat: true,
    requiredFile: resolve(root, "validate.mjs"),
    requiredContains: ["validate"],
    promptPath: writePrompt(promptRoot, "turn-2", [
      "我有新的需求，继续完善这个项目，不要重写已有的正确代码。",
      `工作目录：${root}`,
      `所有 shell_command 的 workdir 必须是 ${root}，不得读取这个目录之外的任何文件。`,
      "新增 validate.mjs 模块验证输入 CSV 格式（缺少必需列时报错，非数值内容标记异常），新增 format.mjs 模块支持文本表格格式输出。",
      "CLI 增加 --format text 支持，text 格式用中文表头输出统计表格。",
      "增加按 department 分组统计的功能，CLI JSON 输出中包含 breakdown 字段。",
      "保留并扩充 stats.test.mjs 测试，确保所有旧测试仍然通过，新增验证和格式化测试。",
      "不要修改 rules.json、sample.csv 和 package.json。",
      "运行 node --test stats.test.mjs 和 CLI 的 json、text 两种格式验证所有功能。",
      "命令前先用一句中文说明你要做什么。",
      `完成后最后一行写 ${marker2}。`,
    ]),
  });
  turns.push(turn2);
  let afterFeature = inspectGreenfield(root);
  const featurePasses = (result) => result.testPassed
    && result.cliJsonPassed
    && result.cliTextPassed
    && result.cliJsonHasExpectedValues;
  for (let attempt = 1; attempt <= 2 && (!turn2.ok || !featurePasses(afterFeature)); attempt += 1) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_GREENFIELD_T2_REPAIR_${attempt}_${runId}`;
    const featureAlreadyReady = featurePasses(afterFeature);
    turn2 = runUiTurn({
      journeyId: id,
      turnId: `turn-2-repair-after-host-validation-${attempt}`,
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn2.ok,
      requiredFile: featureAlreadyReady ? "" : resolve(root, "validate.mjs"),
      requiredContains: featureAlreadyReady ? [] : ["validate"],
      promptPath: writePrompt(promptRoot, `turn-2-repair-${attempt}`, [
        featureAlreadyReady
          ? `继续当前项目，这是第 ${attempt} 次宿主收尾复核。宿主已确认测试、CLI json/text 和统计值全部通过；这个回合禁止修改任何文件。`
          : `继续当前项目，这是第 ${attempt} 次宿主结果修复。上一轮功能验证没有通过，不能只解释原因。`,
        `所有 shell_command 的 workdir 必须是 ${root}，不得读取这个目录之外的任何文件。`,
        `测试=${afterFeature.testPassed}；CLI JSON=${afterFeature.cliJsonPassed}；CLI text=${afterFeature.cliTextPassed}；统计值=${afterFeature.cliJsonHasExpectedValues}。`,
        `关键错误：${compactText(afterFeature.diagnostics.test || afterFeature.diagnostics.cliJson, 700)}`,
        featureAlreadyReady
          ? "只运行 node --test stats.test.mjs 和 CLI 的 json/text 格式；不要修改任何文件。"
          : "读取当前 stats.mjs、cli.mjs、stats.test.mjs 各一次。补丁失败就用 shell_command 和 Node fs.writeFileSync 全量写回。不要修改 rules.json、sample.csv 和 package.json。",
        `全部通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn2);
    afterFeature = inspectGreenfield(root);
  }
  checkTurn(turn2, failures);
  if (!afterFeature.testPassed) failures.push("greenfield feature tests failed after turn 2");
  if (!afterFeature.cliJsonPassed || !afterFeature.cliJsonHasExpectedValues) failures.push("greenfield CLI JSON output missing expected values after turn 2");
  if (!afterFeature.cliTextPassed) failures.push("greenfield CLI text output failed after turn 2");

  const marker3 = `UI_HUMAN_LONG_GREENFIELD_T3_${runId}`;
  let turn3 = runUiTurn({
    journeyId: id,
    turnId: "turn-3-final-delivery",
    marker: marker3,
    artifactDir: root,
    sameChat: true,
    requiredFile: resolve(root, "index.html"),
    requiredContains: [marker3, "统计"],
    promptPath: writePrompt(promptRoot, "turn-3", [
      "项目功能基本完成，现在做最终交付。",
      `工作目录：${root}`,
      `所有 shell_command 的 workdir 必须是 ${root}，不得读取这个目录之外的任何文件。`,
      "新增中文 README.md，说明项目用途、安装和用法。",
      "完善 index.html，展示完整的统计结果（总数、各列最小最大值、分组统计），包含中文标签，必须是完整离线 HTML。",
      "生成 summary.json 包含最终统计指标：totalRows、各列的 count/min/max/sum/average、breakdown 分组数据。",
      "生成 report.json 包含完整详细报告数据。",
      `把 ${marker3} 作为 HTML 注释写入 index.html，供宿主核对本轮交付物确实来自当前回合。`,
      "重新运行 node --test stats.test.mjs 和 CLI json/text 格式，确保一切正常。",
      "不要修改 rules.json、sample.csv 和 package.json。",
      "根据实际运行结果填写报告，不能猜数据。",
      "命令前先用一句中文说明这是最终交付。",
      `报告标记是 ${marker3}。所有结果复核后，最后一行写 ${marker3}。`,
    ]),
  });
  turns.push(turn3);
  let afterDelivery = inspectGreenfield(root, marker3);
  for (let attempt = 1; attempt <= 2 && (!turn3.ok || !afterDelivery.readmeHasChinese || !afterDelivery.htmlHasChinese || !afterDelivery.htmlIsFullPage || !afterDelivery.summaryHasExpectedValues); attempt += 1) {
    recoveryTurnCount += 1;
    const repairMarker = `UI_HUMAN_LONG_GREENFIELD_T3_REPAIR_${attempt}_${runId}`;
    const deliveryReady = afterDelivery.readmeHasChinese
      && afterDelivery.htmlHasChinese
      && afterDelivery.htmlIsFullPage
      && afterDelivery.summaryHasExpectedValues
      && afterDelivery.markerInHtml;
    turn3 = runUiTurn({
      journeyId: id,
      turnId: `turn-3-repair-delivery-${attempt}`,
      marker: repairMarker,
      artifactDir: root,
      sameChat: true,
      forceResetSameChat: !turn3.ok,
      requiredFile: deliveryReady ? "" : resolve(root, "index.html"),
      requiredContains: deliveryReady ? [] : [marker3, "统计"],
      promptPath: writePrompt(promptRoot, `turn-3-repair-${attempt}`, [
        deliveryReady
          ? `继续当前交付，这是第 ${attempt} 次宿主收尾复核。宿主已确认 README 中文、HTML 完整页面和 summary 统计值全部通过；这个回合禁止修改任何文件。`
          : `继续当前交付。宿主检查发现交付物未通过，不要重写业务代码。`,
        `所有 shell_command 的 workdir 必须是 ${root}，不得读取这个目录之外的任何文件。`,
        `README 中文=${afterDelivery.readmeHasChinese}；HTML 中文=${afterDelivery.htmlHasChinese}；HTML 完整页面=${afterDelivery.htmlIsFullPage}；summary 指标=${afterDelivery.summaryHasExpectedValues}；marker=${afterDelivery.markerInHtml}。`,
        deliveryReady
          ? "只运行 node --test 和 CLI，读取已有文件；不要修改任何文件。"
          : "只允许修改 README.md、index.html、summary.json 和 report.json。运行测试和 CLI 后根据实际结果生成报告。不要修改 rules.json、sample.csv、package.json、stats.mjs、cli.mjs、validate.mjs、format.mjs。",
        `报告标记：${marker3}。命令前先用一句中文说明。`,
        `全部通过后最后一行写 ${repairMarker}。`,
      ]),
    });
    turns.push(turn3);
    afterDelivery = inspectGreenfield(root, marker3);
  }
  checkTurn(turn3, failures);
  if (!afterDelivery.readmeHasChinese) failures.push("greenfield README missing Chinese content");
  if (!afterDelivery.htmlHasChinese) failures.push("greenfield HTML missing Chinese content");
  if (!afterDelivery.htmlIsFullPage) failures.push("greenfield HTML is not a complete page");
  if (!afterDelivery.summaryPresent) failures.push("greenfield summary.json missing");
  if (!afterDelivery.summaryHasExpectedValues) failures.push("greenfield summary.json missing expected business metrics");

  const beforeNoopHashes = treeHashes(root);
  const marker4 = `UI_HUMAN_LONG_GREENFIELD_T4_${runId}`;
  turns.push(runUiTurn({
    journeyId: id,
    turnId: "turn-4-read-only-reverification",
    marker: marker4,
    artifactDir: root,
    sameChat: true,
    promptPath: writePrompt(promptRoot, "turn-4", [
      "先别继续加东西，我只要交付前复核。这个回合禁止修改、创建、删除任何文件，也不要启动或打开任何软件。",
      `仍在目录 ${root}。只运行现有 node --test stats.test.mjs，再运行 CLI 的 json 和 text 两种格式。`,
      "如果都一致就直接结束；不要重写文件、不要格式化、不要重复执行同一命令。命令前先说一句中文说明。",
      `复核结果真的通过后，最后一行写 ${marker4}。`,
    ]),
  }));
  checkTurn(turns.at(-1), failures);
  const afterNoopHashes = treeHashes(root);
  const noopHistory = turns.at(-1).history;
  if (JSON.stringify(afterNoopHashes) !== JSON.stringify(beforeNoopHashes)) failures.push("greenfield read-only reverification changed project files");
  if (noopHistory.launchCommandCount !== 0) failures.push("greenfield read-only reverification launched a process or program");
  if (noopHistory.verificationCommandCount < 1) failures.push("greenfield read-only reverification did not run a verification command");
  if (noopHistory.verificationCommandCount > 3) failures.push(`greenfield read-only reverification repeated verification commands ${noopHistory.verificationCommandCount} times`);
  if (!noopHistory.chinesePreCommandSeen) failures.push("greenfield read-only reverification had no Chinese pre-command explanation");

  const final = inspectGreenfield(root, marker3);
  if (final.fileCount < 12) failures.push(`greenfield project has only ${final.fileCount} files, expected at least 12`);
  if (final.rulesHash !== protectedBefore.rulesHash) failures.push("greenfield rules.json was modified");
  if (final.sampleHash !== protectedBefore.sampleHash) failures.push("greenfield sample.csv was modified");
  if (final.packageHash !== protectedBefore.packageHash) failures.push("greenfield package.json was modified");
  if (final.unexpectedFiles.length > 0) failures.push(`greenfield project contains unexpected files: ${final.unexpectedFiles.join(", ")}`);
  if (!final.noNodeModules) failures.push("greenfield project contains node_modules");
  if (!final.testPassed) failures.push("greenfield final tests failed");
  if (!final.cliJsonPassed || !final.cliJsonHasExpectedValues) failures.push("greenfield final CLI JSON output incorrect");
  if (!final.cliTextPassed) failures.push("greenfield final CLI text output failed");
  if (!final.markerInHtml) failures.push("greenfield HTML missing marker");
  const minimumTurns = turns.length >= 4;
  if (!minimumTurns) failures.push(`greenfield journey completed only ${turns.length} user turns`);

  const artifactEvidence = {
    protectedFilesUnchanged: final.rulesHash === protectedBefore.rulesHash && final.sampleHash === protectedBefore.sampleHash && final.packageHash === protectedBefore.packageHash,
    fileCount: final.fileCount,
    testPassed: final.testPassed,
    cliJsonPassed: final.cliJsonPassed,
    cliTextPassed: final.cliTextPassed,
    cliJsonHasExpectedValues: final.cliJsonHasExpectedValues,
    readmeHasChinese: final.readmeHasChinese,
    htmlHasChinese: final.htmlHasChinese,
    htmlIsFullPage: final.htmlIsFullPage,
    markerInHtml: final.markerInHtml,
    summaryPresent: final.summaryPresent,
    summaryHasExpectedValues: final.summaryHasExpectedValues,
    reportPresent: final.reportPresent,
    noopHashesUnchanged: JSON.stringify(afterNoopHashes) === JSON.stringify(beforeNoopHashes),
    noopLaunchCommandCount: noopHistory.launchCommandCount,
    noopVerificationCommandCount: noopHistory.verificationCommandCount,
    minimumTurns,
    unexpectedFiles: final.unexpectedFiles,
    actualFiles: final.actualFiles,
  };
  return {
    id,
    ok: failures.length === 0,
    failures,
    turnCount: turns.length,
    passedTurnCount: turns.filter((turn) => turn.ok).length,
    recoveryTurnCount,
    usedRealTraffic: turns.every((turn) => turn.usedRealTraffic),
    turns,
    artifactEvidence,
  };
}

if (revalidateReportPath) {
  const payload = revalidateStoredHumanLongJourney(revalidateReportPath);
  console.log(JSON.stringify(payload));
  process.exit(payload.ok ? 0 : 1);
}

if (!allowRealTraffic) {
  console.log(JSON.stringify({
    ok: true,
    reportName: "ui-human-long-journey",
    requestedRealTraffic: false,
    usedRealTraffic: false,
    skipped: true,
    requiresExplicitUserApproval: true,
    approvalReason: "real_traffic_required",
    journeyIds,
    commandPreview: `node scripts/test-anticodex-human-long-journey.mjs --allow-real-traffic${model ? ` --model ${model}` : ""}${requestedJourneyIds.length > 0 ? ` --journey ${journeyIds.join(",")}` : ""}`,
  }));
  process.exit(0);
}

if (process.env.ANTICODEX_REAL_TRAFFIC_LOCK_HELD !== "1") {
  const childArgs = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", lockedRunnerScript,
    "-AllowRealTraffic",
    "-Journey", journeyIds.join(","),
    "-TimeoutMs", String(timeoutMs),
    "-ReportRoot", reportRoot,
    "-NodePath", process.execPath,
    "-LockName", realTrafficLockName,
  ];
  if (model) childArgs.push("-Model", model);
  if (keepArtifacts) childArgs.push("-KeepArtifacts");
  const lockedRun = spawnSync("powershell.exe", childArgs, {
    cwd: sourceRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs * 24 + 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (lockedRun.stdout) process.stdout.write(lockedRun.stdout);
  if (lockedRun.stderr) process.stderr.write(lockedRun.stderr);
  if (lockedRun.error) process.stderr.write(`${lockedRun.error.message}\n`);
  process.exit(Number.isInteger(lockedRun.status) ? lockedRun.status : 1);
}

let humanPhase = "fixed-route-precondition";
let realTrafficMayHaveStarted = false;
let matrixRoot = "";
let journeys = [];
let workspaceStateSnapshotPath = "";
let workspaceRestore = null;
let fixedRouteProvider = "";

async function runHumanLongJourney() {
  const fixedRouteHealth = await fetchJsonWithRetry(
    fetch,
    "http://127.0.0.1:18487/anticodex/fixed-route/health",
    { attempts: 3, delayMs: 300, timeoutMs: 8_000 },
  );
  fixedRouteProvider = String(fixedRouteHealth?.route?.provider || fixedRouteHealth?.provider || "");
  if (fixedRouteHealth?.ok !== true || fixedRouteHealth?.state !== "ready" || !supportedFixedRouteProviders.has(fixedRouteProvider)) {
    throw new Error("supported fixed route is not ready for a real human journey");
  }
  model = resolveFixedRouteModel(fixedRouteHealth, model);

  humanPhase = "fixture-setup";
  const tempRoot = resolve(os.tmpdir());
  matrixRoot = resolve(tempRoot, `anticodex-human-long-${runId}-${process.pid}`);
  if (!matrixRoot.startsWith(`${tempRoot}${sep}`) || !basename(matrixRoot).startsWith("anticodex-human-long-")) {
    throw new Error("human-long fixture path escaped the temporary root");
  }
  mkdirSync(matrixRoot, { recursive: true });
  const workspaceStateSnapshot = captureWorkspaceState();
  trustedProjectLabel = String(workspaceStateSnapshot.labels?.[trustedProjectRoot] || basename(trustedProjectRoot)).trim();
  workspaceStateSnapshotPath = resolve(matrixRoot, "workspace-state-before.json");
  writeFileSync(workspaceStateSnapshotPath, `${JSON.stringify(workspaceStateSnapshot, null, 2)}\n`, "utf8");

  const runners = new Map([
    ["messy-inventory-four-turn", runInventoryJourney],
    ["interrupted-migration-three-turn", runMigrationJourney],
    ["greenfield-project-three-turn", runGreenfieldJourney],
  ]);
  journeys = [];
  try {
    for (const journeyId of journeyIds) {
      humanPhase = `journey-${journeyId}`;
      realTrafficMayHaveStarted = true;
      try {
        journeys.push(runners.get(journeyId)(matrixRoot));
      } catch (error) {
        const terminalProviderStop = error?.terminalProviderStop || terminalProviderGate.failure;
        const retainedTurns = retainJourneyTurnEvidence(
          observedTurnsByJourney.get(journeyId) || [],
          terminalProviderStop?.turn || null,
        );
        journeys.push({
          id: journeyId,
          ok: false,
          failureStage: terminalProviderStop ? "terminal-provider-error" : "unexpected-error",
          failures: [error instanceof Error ? error.message : String(error)],
          turnCount: retainedTurns.length,
          passedTurnCount: retainedTurns.filter((turn) => turn?.ok === true).length,
          usedRealTraffic: retainedTurns.some((turn) => turn?.usedRealTraffic === true),
          turns: retainedTurns,
          artifactEvidence: null,
          terminalProviderStop: terminalProviderStop || null,
        });
      }
      if (terminalProviderGate.failure || noTrafficStop) break;
    }
  } finally {
    humanPhase = "workspace-state-restore";
    workspaceRestore = restoreWorkspaceState(workspaceStateSnapshotPath);
  }

  const failures = journeys.flatMap((journey) => journey.failures.map((failure) => `${journey.id}: ${failure}`));
  if (workspaceRestore?.ok !== true) failures.push(`workspace state restore failed: ${compactText(JSON.stringify(workspaceRestore))}`);
  const ok = failures.length === 0 && journeys.length === journeyIds.length;
  let cleanup = { removed: false, kept: true, reason: ok ? "keep_artifacts" : "failure_evidence" };
  if (ok && !keepArtifacts) {
    humanPhase = "fixture-cleanup";
    rmSync(matrixRoot, { recursive: true, force: true });
    cleanup = { removed: true, kept: false, reason: "successful_fixture_cleanup" };
  }

  humanPhase = "report-publication";
  const payload = writeReport({
    ok,
    reportName: "ui-human-long-journey",
    requestedRealTraffic: true,
    usedRealTraffic: journeys.every((journey) => journey.usedRealTraffic),
    behaviorCovered: ok,
    coverageKind: "desktop-ui-real-human-long-journey",
    model,
    fixedRouteProvider,
    elapsedMs: Date.now() - startedAt,
    failures,
    journeyIds,
    journeyCount: journeys.length,
    passedJourneyCount: journeys.filter((journey) => journey.ok).length,
    totalTurnCount: journeys.reduce((sum, journey) => sum + journey.turnCount, 0),
    passedTurnCount: journeys.reduce((sum, journey) => sum + journey.passedTurnCount, 0),
    resultValidatedJourneyCount: journeys.filter((journey) => journey.ok && journey.artifactEvidence).length,
    stoppedAfterTerminalProviderFailure: terminalProviderGate.failure !== null,
    terminalProviderStop: terminalProviderGate.failure,
    stoppedAfterNoTrafficFailure: noTrafficStop !== null,
    noTrafficStop,
    journeys,
    fixtureRoot: matrixRoot,
    workspaceRestore,
    cleanup,
  });

  console.log(JSON.stringify(payload));
  process.exitCode = ok ? 0 : 1;
}

try {
  await runHumanLongJourney();
} catch (error) {
  if (!workspaceRestore && workspaceStateSnapshotPath && existsSync(workspaceStateSnapshotPath)) {
    try { workspaceRestore = restoreWorkspaceState(workspaceStateSnapshotPath); } catch {}
  }
  const failureMessage = compactText(error instanceof Error ? error.message : String(error), 1800)
    || "unexpected human long-journey runner failure";
  const fallbackReport = {
    ok: false,
    reportName: "ui-human-long-journey",
    requestedRealTraffic: true,
    usedRealTraffic: realTrafficMayHaveStarted,
    longTaskStarted: realTrafficMayHaveStarted,
    behaviorCovered: false,
    coverageKind: "desktop-ui-real-human-long-journey",
    model,
    fixedRouteProvider,
    elapsedMs: Date.now() - startedAt,
    failureStage: humanPhase,
    failures: [failureMessage],
    journeyIds,
    journeyCount: journeys.length,
    passedJourneyCount: journeys.filter((journey) => journey.ok).length,
    totalTurnCount: journeys.reduce((sum, journey) => sum + Number(journey.turnCount || 0), 0),
    passedTurnCount: journeys.reduce((sum, journey) => sum + Number(journey.passedTurnCount || 0), 0),
    resultValidatedJourneyCount: 0,
    stoppedAfterTerminalProviderFailure: terminalProviderGate.failure !== null,
    terminalProviderStop: terminalProviderGate.failure,
    stoppedAfterNoTrafficFailure: noTrafficStop !== null,
    noTrafficStop,
    journeys,
    fixtureRoot: matrixRoot,
    workspaceRestore,
    cleanup: { removed: false, kept: Boolean(matrixRoot), reason: "failure_evidence" },
  };
  try {
    const publishedFailure = writeReport(fallbackReport);
    console.log(JSON.stringify(publishedFailure));
  } catch (reportError) {
    process.stderr.write(`Human long-journey failed before its fallback report could be published: ${compactText(reportError?.message || reportError)}\n`);
  }
  process.exitCode = 1;
}
