import fs from "node:fs";
import path from "node:path";

const inputAsar = process.argv[2] || defaultInstalledAsarPath();
if (!inputAsar || !fs.existsSync(inputAsar)) {
  console.error(`Usage: node scripts/audit-codex-websocket-protocol.mjs <app.asar>`);
  process.exit(2);
}

const scanPatterns = [
  "responses_websockets",
  "responses_websockets_v2",
  "supports_websockets",
  "websocket_url",
  "CODEX_APP_SERVER_WS_URL",
  "/v1/responses",
  "/codex/responses",
  "response.created",
  "response.output_text.delta",
  "response.completed",
  "new WebSocket",
  "WebSocket(",
  "EventSource",
  "Dictation stream",
  "session.start",
];

function defaultInstalledAsarPath() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return "";
  const candidates = [
    path.join(base, "Anti-Codex", "codex-patched-app", "resources", "app.asar"),
    path.join(base, "Codex", "app-0.0.0", "resources", "app.asar"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function alignedAsarDataOffset(headerStringSize) {
  const prefixSize = 16;
  return prefixSize + headerStringSize + ((4 - ((prefixSize + headerStringSize) % 4)) % 4);
}

function* walkFiles(node, prefix = "") {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child.files) {
      yield* walkFiles(child, rel);
    } else {
      yield [rel, child];
    }
  }
}

function readFileFromAsar(fd, entry, dataOffset) {
  const size = Number(entry.size || 0);
  const offset = dataOffset + Number(entry.offset || 0);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, offset);
  return buf;
}

function isTextCandidate(rel, entry) {
  if (Number(entry.size || 0) > 12 * 1024 * 1024) return false;
  return /\.(js|mjs|cjs|html|json|css|map|txt)$/i.test(rel);
}

function compactSnippet(text, at, pattern) {
  const start = Math.max(0, at - 180);
  const end = Math.min(text.length, at + pattern.length + 180);
  return text
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
}

function scanAsar(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    const headerStringSize = sizeBuf.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerStringSize);
    fs.readSync(fd, headerBuf, 0, headerStringSize, 16);
    const header = JSON.parse(headerBuf.toString("utf8"));
    const dataOffset = alignedAsarDataOffset(headerStringSize);
    const hits = [];
    let scannedFiles = 0;
    let scannedBytes = 0;

    for (const [rel, entry] of walkFiles(header)) {
      if (!isTextCandidate(rel, entry)) continue;
      scannedFiles += 1;
      scannedBytes += Number(entry.size || 0);
      const text = readFileFromAsar(fd, entry, dataOffset).toString("utf8");
      for (const pattern of scanPatterns) {
        const at = text.indexOf(pattern);
        if (at < 0) continue;
        hits.push({
          rel,
          pattern,
          index: at,
          snippet: compactSnippet(text, at, pattern),
        });
      }
    }

    return {
      asarPath,
      scannedFiles,
      scannedBytes,
      hits,
      summary: summarizeHits(hits),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function summarizeHits(hits) {
  const byPattern = {};
  const byFile = {};
  for (const hit of hits) {
    byPattern[hit.pattern] = (byPattern[hit.pattern] || 0) + 1;
    byFile[hit.rel] ||= [];
    byFile[hit.rel].push(hit.pattern);
  }
  const filePatternMatrix = Object.fromEntries(
    Object.entries(byFile).map(([rel, patterns]) => [rel, Array.from(new Set(patterns)).sort()]),
  );
  const filesWithWebsocketCtor = Object.entries(filePatternMatrix)
    .filter(([, patterns]) => patterns.includes("new WebSocket") || patterns.includes("WebSocket("))
    .map(([rel]) => rel);
  const filesWithResponsesEndpoint = Object.entries(filePatternMatrix)
    .filter(([, patterns]) => patterns.includes("/v1/responses") || patterns.includes("/codex/responses"))
    .map(([rel]) => rel);
  const filesWithBothWebsocketAndResponses = filesWithWebsocketCtor
    .filter((rel) => filesWithResponsesEndpoint.includes(rel));
  const filesWithDictationWebsocket = Object.entries(filePatternMatrix)
    .filter(([, patterns]) => patterns.includes("Dictation stream") || patterns.includes("session.start"))
    .map(([rel]) => rel);
  const nonDictationFilesWithBothWebsocketAndResponses = filesWithBothWebsocketAndResponses
    .filter((rel) => !filesWithDictationWebsocket.includes(rel));
  return {
    hitCount: hits.length,
    byPattern,
    filePatternMatrix,
    hasResponsesWebsocketFlags: hits.some((hit) => hit.pattern.startsWith("responses_websockets")),
    hasAppServerWebsocketUrl: hits.some((hit) => hit.pattern === "websocket_url" || hit.pattern === "CODEX_APP_SERVER_WS_URL"),
    hasServerAdvertisedResponsesWebsocketFields: hits.some((hit) => hit.pattern === "supports_websockets"),
    hasBrowserWebsocketCtor: filesWithWebsocketCtor.length > 0,
    hasCodexResponsesHttpEndpointLiteral: hits.some((hit) => hit.pattern === "/codex/responses"),
    hasV1ResponsesEndpointLiteral: hits.some((hit) => hit.pattern === "/v1/responses"),
    filesWithBothWebsocketAndResponses,
    filesWithDictationWebsocket,
    nonDictationFilesWithBothWebsocketAndResponses,
    nativeModelResponsesWebsocketEvidence:
      hits.some((hit) => hit.pattern === "supports_websockets") ||
      hits.some((hit) => hit.pattern === "/v1/responses") ||
      nonDictationFilesWithBothWebsocketAndResponses.length > 0,
  };
}

const result = scanAsar(inputAsar);
console.log(JSON.stringify(result, null, 2));
