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
