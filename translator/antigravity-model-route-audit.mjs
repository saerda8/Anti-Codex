import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX_ENTRIES = 200;

export function createAntigravityModelRouteAuditStore(options = {}) {
  const filePath = options.filePath || "";
  const maxEntries = Math.max(1, Number(options.maxEntries || DEFAULT_MAX_ENTRIES));
  let entries = loadEntries(filePath).slice(-maxEntries);

  function snapshot() {
    return {
      ok: true,
      object: "anticodex.model_route_audit",
      legacyObject: "antigravity.model_route_audit",
      count: entries.length,
      latest: entries.at(-1) || null,
      entries: entries.slice().reverse(),
    };
  }

  function record(entry) {
    const normalized = normalizeEntry(entry);
    entries.push(normalized);
    if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
    writeSnapshot(filePath, entries);
    return normalized;
  }

  return { snapshot, record };
}

function normalizeEntry(entry = {}) {
  return {
    at: entry.at || new Date().toISOString(),
    requestId: stringOrEmpty(entry.requestId),
    transport: stringOrEmpty(entry.transport || "native"),
    provider: stringOrEmpty(entry.provider),
    providerProtocol: stringOrEmpty(entry.providerProtocol || entry.protocol),
    requestedModel: stringOrEmpty(entry.requestedModel),
    resolvedModel: stringOrEmpty(entry.resolvedModel || entry.model),
    displayName: stringOrEmpty(entry.displayName),
    internalModel: stringOrEmpty(entry.internalModel),
    cascadeId: stringOrEmpty(entry.cascadeId || entry.conversationId),
    status: stringOrEmpty(entry.status || "success"),
  };
}

function loadEntries(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (Array.isArray(parsed)) return parsed.map(normalizeEntry);
    if (Array.isArray(parsed?.entries)) return parsed.entries.map(normalizeEntry);
  } catch {}
  return [];
}

function writeSnapshot(filePath, entries) {
  if (!filePath) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : (value == null ? "" : String(value));
}
