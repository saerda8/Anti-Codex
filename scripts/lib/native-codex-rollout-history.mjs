import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { collectCodexRolloutMarkerEvidence } from "./ui-chat-marker-evidence.mjs";

function defaultRolloutRoot() {
  const stateRoot = resolve(process.env.DEEPCODEX_STATE_ROOT
    || join(process.env.APPDATA || os.tmpdir(), "anticodex"));
  const codexHome = resolve(process.env.ANTICODEX_CODEX_HOME
    || join(stateRoot, "codex-home-deepseek-app"));
  return resolve(codexHome, "sessions");
}

export function recentNativeCodexRolloutFiles(rolloutRoot = defaultRolloutRoot(), limit = 160) {
  if (!existsSync(rolloutRoot)) return [];
  const files = [];
  const pending = [rolloutRoot];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !/^rollout-.*\.jsonl$/i.test(entry.name)) continue;
      try {
        const stat = statSync(path);
        files.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit);
}

export function summarizeNativeCodexRolloutExecution(records = [], options = {}) {
  const requireCommandPerTurn = options.requireCommandPerTurn === true;
  const turns = [];
  const turnById = new Map();
  let threadId = "";
  let sessionCwd = "";
  let currentTurn = null;

  const ensureTurn = (value = "") => {
    const id = String(value || `turn-${turns.length + 1}`);
    if (turnById.has(id)) return turnById.get(id);
    const turn = {
      turnId: id,
      models: new Set(),
      userMessageCount: 0,
      assistantMessageCount: 0,
      toolCallIds: [],
      toolOutputIds: [],
      commandEntries: [],
      preCommandAssistantTexts: [],
      firstCommandSeen: false,
      taskCompleteSeen: false,
      taskCompleteCount: 0,
      postCompleteToolCallCount: 0,
      postCompleteToolOutputCount: 0,
      adjacentDuplicateCommandCount: 0,
      launchCommandCount: 0,
      nonZeroToolOutputCount: 0,
    };
    turns.push(turn);
    turnById.set(id, turn);
    return turn;
  };

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object") continue;
    const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
    if (record.type === "session_meta") {
      threadId ||= String(payload.id || payload.session_id || "");
      sessionCwd ||= String(payload.cwd || payload.session?.cwd || "");
      continue;
    }
    if (record.type === "turn_context") {
      currentTurn = ensureTurn(payload.turn_id || payload.id);
      const model = String(payload.model || payload.collaboration_mode?.settings?.model || "").trim();
      if (model) currentTurn.models.add(model);
      continue;
    }
    if (record.type === "event_msg") {
      if (payload.type === "task_started") {
        currentTurn = ensureTurn(payload.turn_id || payload.id);
      } else if (payload.type === "task_complete") {
        const completedTurn = ensureTurn(payload.turn_id || currentTurn?.turnId);
        completedTurn.taskCompleteSeen = true;
        completedTurn.taskCompleteCount += 1;
        currentTurn = completedTurn;
      }
      continue;
    }
    if (record.type !== "response_item") continue;
    currentTurn ||= ensureTurn();
    const item = payload;
    if (item.type === "message") {
      if (item.role === "user") currentTurn.userMessageCount += 1;
      if (item.role === "assistant") {
        currentTurn.assistantMessageCount += 1;
        if (!currentTurn.firstCommandSeen) {
          currentTurn.preCommandAssistantTexts.push(responseItemText(item.content));
        }
      }
      continue;
    }
    if (isToolCallItem(item)) {
      if (currentTurn.taskCompleteSeen) currentTurn.postCompleteToolCallCount += 1;
      const callId = toolCallId(item);
      if (callId) currentTurn.toolCallIds.push(callId);
      const commandEntry = commandEntryFromToolCall(item);
      if (!commandEntry) continue;
      currentTurn.firstCommandSeen = true;
      const previous = currentTurn.commandEntries.at(-1);
      if (previous && previous.normalized === commandEntry.normalized) {
        currentTurn.adjacentDuplicateCommandCount += 1;
      }
      if (commandLooksLikeUnexpectedProgramLaunch(commandEntry.command)) {
        currentTurn.launchCommandCount += 1;
      }
      currentTurn.commandEntries.push(commandEntry);
      continue;
    }
    if (isToolOutputItem(item)) {
      if (currentTurn.taskCompleteSeen) currentTurn.postCompleteToolOutputCount += 1;
      const callId = toolCallId(item);
      if (callId) currentTurn.toolOutputIds.push(callId);
      const output = responseItemText(item.output ?? item.content);
      if (/(?:exit code|process exited with code)\s*[:=]?\s*[1-9]\d*/i.test(output)) {
        currentTurn.nonZeroToolOutputCount += 1;
      }
    }
  }

  const failures = [];
  const finalTurns = turns.map((turn) => {
    const callIds = new Set(turn.toolCallIds);
    const outputIds = new Set(turn.toolOutputIds);
    const unpairedToolCallIds = [...callIds].filter((id) => !outputIds.has(id));
    const unpairedToolOutputIds = [...outputIds].filter((id) => !callIds.has(id));
    const preCommandExplanationSeen = turn.preCommandAssistantTexts.some(preCommandTextExplainsAction);
    const toolPairsComplete = unpairedToolCallIds.length === 0 && unpairedToolOutputIds.length === 0;
    if (requireCommandPerTurn && turn.commandEntries.length === 0) {
      failures.push(`${turn.turnId} has no real command`);
    }
    if (turn.commandEntries.length > 0 && !preCommandExplanationSeen) {
      failures.push(`${turn.turnId} lacks a Chinese pre-command explanation`);
    }
    if (turn.adjacentDuplicateCommandCount > 0) {
      failures.push(`${turn.turnId} has ${turn.adjacentDuplicateCommandCount} adjacent duplicate command(s)`);
    }
    if (turn.launchCommandCount > 0) {
      failures.push(`${turn.turnId} has ${turn.launchCommandCount} unexpected program launch command(s)`);
    }
    if (!toolPairsComplete) {
      failures.push(`${turn.turnId} has unpaired tool call/output ids`);
    }
    if (turn.postCompleteToolCallCount > 0 || turn.postCompleteToolOutputCount > 0) {
      failures.push(`${turn.turnId} continued tool work after task_complete`);
    }
    if (!turn.taskCompleteSeen || turn.taskCompleteCount !== 1) {
      failures.push(`${turn.turnId} has invalid task_complete evidence`);
    }
    return {
      turnId: turn.turnId,
      models: [...turn.models],
      userMessageCount: turn.userMessageCount,
      assistantMessageCount: turn.assistantMessageCount,
      toolCallCount: turn.toolCallIds.length,
      toolOutputCount: turn.toolOutputIds.length,
      commandCount: turn.commandEntries.length,
      commands: turn.commandEntries.map(({ command, callId, toolName }) => ({ command, callId, toolName })),
      taskCompleteSeen: turn.taskCompleteSeen,
      taskCompleteCount: turn.taskCompleteCount,
      preCommandExplanationSeen,
      toolPairsComplete,
      unpairedToolCallIds,
      unpairedToolOutputIds,
      adjacentDuplicateCommandCount: turn.adjacentDuplicateCommandCount,
      launchCommandCount: turn.launchCommandCount,
      postCompleteToolCallCount: turn.postCompleteToolCallCount,
      postCompleteToolOutputCount: turn.postCompleteToolOutputCount,
      nonZeroToolOutputCount: turn.nonZeroToolOutputCount,
    };
  });

  return {
    ok: failures.length === 0,
    threadId,
    sessionCwd,
    turnCount: finalTurns.length,
    toolCallCount: finalTurns.reduce((sum, turn) => sum + turn.toolCallCount, 0),
    toolOutputCount: finalTurns.reduce((sum, turn) => sum + turn.toolOutputCount, 0),
    commandCount: finalTurns.reduce((sum, turn) => sum + turn.commandCount, 0),
    turns: finalTurns,
    failures,
  };
}

function isToolCallItem(item) {
  return ["function_call", "custom_tool_call", "local_shell_call"].includes(String(item?.type || ""));
}

function isToolOutputItem(item) {
  return ["function_call_output", "custom_tool_call_output", "local_shell_call_output"].includes(String(item?.type || ""));
}

function toolCallId(item) {
  return String(item?.call_id || item?.callId || item?.id || "").trim();
}

function commandEntryFromToolCall(item) {
  const toolName = String(item?.name || "");
  const raw = String(item?.arguments ?? item?.input ?? item?.action ?? "");
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  const parsedCommand = parsed?.command || parsed?.cmd || parsed?.script || "";
  const patchCommand = /(?:^|__)apply_patch$/i.test(toolName) ? raw : "";
  const command = String(parsedCommand || patchCommand).trim();
  if (!command) return null;
  return {
    command,
    normalized: command.replace(/\s+/g, " ").trim().toLowerCase(),
    callId: toolCallId(item),
    toolName,
  };
}

function commandLooksLikeUnexpectedProgramLaunch(command = "") {
  const value = String(command || "");
  return /(?:^|[;{}()\r\n|&]\s*|=\s*)Start-Process\b/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*|=\s*)Invoke-Item\b/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*)(?:cmd(?:\.exe)?\s+\/[dc]\s+)?start(?:\.exe)?\s+/i.test(value)
    || /(?:^|[;{}()\r\n|&]\s*)explorer(?:\.exe)?\s+/i.test(value);
}

function preCommandTextExplainsAction(text = "") {
  const value = String(text || "").replace(/\s+/g, " ").trim().slice(0, 800);
  const chineseCharacters = value.match(/[\u3400-\u9fff]/gu) || [];
  return chineseCharacters.length >= 4
    && /(?:先|接下来|现在|将|准备|检查|读取|查看|定位|修改|运行|执行|验证|测试|确认|恢复|继续|清理|生成|更新|修复)/u.test(value);
}

function responseItemText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return String(part.text ?? part.output_text ?? part.input_text ?? "");
    }).join("\n");
  }
  if (!content || typeof content !== "object") return "";
  return String(content.text ?? content.output_text ?? content.input_text ?? "");
}

function nativeCodexMarkerEntries(marker, rolloutRoot) {
  const needle = String(marker || "");
  if (!needle) return [];
  const entries = [];
  for (const file of recentNativeCodexRolloutFiles(rolloutRoot)) {
    let content = "";
    try { content = readFileSync(file.path, "utf8"); } catch { continue; }
    if (!content.includes(needle)) continue;
    const records = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line.replace(/^\uFEFF/, ""))); } catch {}
    }
    const evidence = collectCodexRolloutMarkerEvidence(records, needle);
    if (evidence.userMarkerSeen !== true) continue;
    entries.push({
      id: `rollout:${evidence.sessionId || file.path}`,
      source: "codex-rollout",
      inputItems: [],
      contextItems: evidence.contextItems,
      markerTurnIds: evidence.markerTurnIds,
      completedMarkerTurnIds: evidence.completedMarkerTurnIds,
      latestMarkerTurnComplete: evidence.latestMarkerTurnComplete,
      sessionCwd: evidence.sessionCwd,
      file: file.path,
    });
  }
  return entries;
}

export function markerScopedHistoryEntries(marker, {
  responseHistoryPath = resolve(process.env.APPDATA || os.tmpdir(), "anticodex", "response-history.json"),
  rolloutRoot = defaultRolloutRoot(),
} = {}) {
  const needle = String(marker || "");
  if (!needle) return [];
  let legacyEntries = [];
  try {
    const history = JSON.parse(readFileSync(responseHistoryPath, "utf8").replace(/^\uFEFF/, ""));
    legacyEntries = (Array.isArray(history?.entries) ? history.entries : [])
      .filter((entry) => JSON.stringify(entry).includes(needle))
      .map((entry) => ({ ...entry, source: entry.source || "legacy-response-history" }));
  } catch {}
  return [...legacyEntries, ...nativeCodexMarkerEntries(needle, rolloutRoot)];
}
