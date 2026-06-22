#!/usr/bin/env node

/**
 * extract-antigravity-protocol-strings.mjs
 *
 * Offline printable-ASCII extractor for the Antigravity language_server
 * binary.  Scans a binary for protobuf message / field name strings related
 * to SdkCustomizationConfig / SdkToolOverride / CustomAgentSpec and returns
 * a window of neighbouring strings for each hit.
 *
 * Usage:
 *   node scripts/extract-antigravity-protocol-strings.mjs <binary-path>
 *
 * Environment variables (all optional):
 *   EXTRACT_WINDOW     -- neighbouring strings per match  (default 5)
 *   EXTRACT_MIN_LENGTH -- minimum ASCII run length        (default 3)
 *   EXTRACT_MAX_OUTPUT -- max output JSON bytes           (default 10240)
 *   EXTRACT_TOKENS     -- comma-separated tokens to search (default TARGET_TOKENS)
 *
 * Output: JSON to stdout, errors to stderr.
 * Side-effect policy: read-only on the binary, no runtime writes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// -- Constants ---------------------------------------------------------

export const TARGET_TOKENS = Object.freeze([
  "SdkCustomizationConfig",
  "SdkToolOverride",
  "CustomAgentSpec",
]);

const DEFAULT_WINDOW = 5;
const DEFAULT_MIN_LENGTH = 3;
const DEFAULT_MAX_OUTPUT = 10240;

// -- Core extraction ---------------------------------------------------

/**
 * Scan a buffer and return every printable-ASCII run (bytes 0x20-0x7E)
 * whose length >= minLength.
 *
 * @param {Buffer} buffer
 * @param {{ minLength?: number }} [options]
 * @returns {{ offset: number, value: string }[]}
 */
export function extractStrings(buffer, { minLength = DEFAULT_MIN_LENGTH } = {}) {
  const strings = [];
  let start = -1;
  const chunk = [];

  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (b >= 0x20 && b <= 0x7e) {
      if (chunk.length === 0) start = i;
      chunk.push(b);
    } else {
      if (chunk.length >= minLength) {
        strings.push({ offset: start, value: Buffer.from(chunk).toString("ascii") });
      }
      chunk.length = 0;
      start = -1;
    }
  }

  // trailing run
  if (chunk.length >= minLength) {
    strings.push({ offset: start, value: Buffer.from(chunk).toString("ascii") });
  }

  return strings;
}

// -- Token matching ----------------------------------------------------

/**
 * For every string that contains a target token, collect a window of
 * neighbouring strings.  Identical token+context combinations are
 * deduplicated.
 *
 * @param {{ offset: number, value: string }[]} strings  -- result of extractStrings
 * @param {{ tokens?: string[], windowSize?: number }} [options]
 * @returns {{ token: string, offset: number, string: string, before: string[], after: string[] }[]}
 */
export function findTokenWindows(
  strings,
  { tokens = TARGET_TOKENS, windowSize = DEFAULT_WINDOW, maxContextChars = 500 } = {},
) {
  const seen = new Set();
  const windows = [];

  for (let i = 0; i < strings.length; i++) {
    const str = strings[i];
    for (const token of tokens) {
      if (!str.value.includes(token)) continue;

      const before = strings
        .slice(Math.max(0, i - windowSize), i)
        .map((s) => clipContext(s.value, maxContextChars));
      const after = strings
        .slice(i + 1, Math.min(strings.length, i + windowSize + 1))
        .map((s) => clipContext(s.value, maxContextChars));

      // dedup key: token + matching string + before window + after window
      const key = `${token}\x00${str.value}\x00${before.join("\x00")}\x00${after.join("\x00")}`;
      if (seen.has(key)) continue;
      seen.add(key);

      windows.push({ token, offset: str.offset, string: clipContext(str.value, maxContextChars), before, after });
    }
  }

  return windows;
}

function clipContext(value, maxChars) {
  if (value.length <= maxChars) return value;
  const half = Math.max(1, Math.floor((maxChars - 17) / 2));
  return `${value.slice(0, half)}...[clipped]...${value.slice(-half)}`;
}

// -- Result builder with length limit ----------------------------------

/**
 * Build a JSON-serialisable result object, capping output at
 * maxOutputBytes by progressively discarding windows.
 */
export function buildResult(
  binaryPath,
  fileSize,
  strings,
  windows,
  {
    tokens = TARGET_TOKENS,
    windowSize = DEFAULT_WINDOW,
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
  } = {},
) {
  const matchesByToken = {};
  for (const token of tokens) {
    matchesByToken[token] = windows.filter((w) => w.token === token).length;
  }

  const result = {
    ok: true,
    binaryPath,
    fileSize,
    targetTokens: [...tokens],
    windowSize,
    totalStringsFound: strings.length,
    matchesByToken,
    totalWindows: windows.length,
    windows: [...windows],
    truncated: false,
  };

  let json = JSON.stringify(result, null, 2);
  let truncated = false;

  // Shrink windows until the payload fits (or we have nothing left)
  while (Buffer.byteLength(json, "utf8") > maxOutputBytes && result.windows.length > 0) {
    result.windows = result.windows.slice(0, Math.floor(result.windows.length * 0.7));
    truncated = true;
    json = JSON.stringify(result, null, 2);
  }

  result.windows = result.windows;
  result.truncated = truncated;
  return result;
}

// -- CLI entry point ---------------------------------------------------

export function main() {
  const binaryPath = process.argv[2];
  if (!binaryPath) {
    console.error("Usage: node extract-antigravity-protocol-strings.mjs <binary-path>");
    process.exit(1);
  }

  const windowSize = Number(process.env.EXTRACT_WINDOW) || DEFAULT_WINDOW;
  const minLength = Number(process.env.EXTRACT_MIN_LENGTH) || DEFAULT_MIN_LENGTH;
  const maxOutputBytes = Number(process.env.EXTRACT_MAX_OUTPUT) || DEFAULT_MAX_OUTPUT;
  const customTokens = String(process.env.EXTRACT_TOKENS ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  let buffer;
  try {
    buffer = readFileSync(binaryPath);
  } catch (err) {
    console.error(`Cannot read binary: ${err.message}`);
    process.exit(1);
  }

  const strings = extractStrings(buffer, { minLength });
  const selectedTokens = customTokens.length > 0 ? customTokens : TARGET_TOKENS;
  const windows = findTokenWindows(strings, {
    windowSize,
    tokens: selectedTokens,
  });
  const result = buildResult(binaryPath, buffer.length, strings, windows, {
    tokens: selectedTokens,
    windowSize,
    maxOutputBytes,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.truncated) process.exitCode = 0; // truncation is not an error
}

// -- Detect direct invocation ------------------------------------------

const __filename = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] || "") === resolve(__filename)) {
  main();
}
