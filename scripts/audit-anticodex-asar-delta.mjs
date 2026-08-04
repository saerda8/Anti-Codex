#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

const leftPath = resolveRequired(process.argv[2], "left app.asar");
const rightPath = resolveRequired(process.argv[3], "right app.asar");
const compact = process.argv.includes("--compact");
const includeSnippets = process.argv.includes("--snippets");
const includePath = argumentValue("--include");

const left = openAsar(leftPath);
const right = openAsar(rightPath);
try {
  const leftEntries = fileEntries(left.header);
  const rightEntries = fileEntries(right.header);
  const allPaths = [...new Set([...leftEntries.keys(), ...rightEntries.keys()])].sort();
  const onlyLeft = [];
  const onlyRight = [];
  const changed = [];
  const unchanged = [];

  for (const path of allPaths) {
    const leftEntry = leftEntries.get(path);
    const rightEntry = rightEntries.get(path);
    if (!rightEntry) {
      onlyLeft.push(path);
      continue;
    }
    if (!leftEntry) {
      onlyRight.push(path);
      continue;
    }
    const leftHash = entryHash(left, leftEntry);
    const rightHash = entryHash(right, rightEntry);
    if (leftEntry.size === rightEntry.size && leftHash === rightHash) {
      unchanged.push(path);
      continue;
    }
    const leftText = textualEntry(path, leftEntry) ? readEntry(left, leftEntry).toString("utf8") : "";
    const rightText = textualEntry(path, rightEntry) ? readEntry(right, rightEntry).toString("utf8") : "";
    const changedEntry = {
      path,
      leftSize: leftEntry.size,
      rightSize: rightEntry.size,
      leftSha256: leftHash,
      rightSha256: rightHash,
      markers: markerDelta(leftText, rightText),
      ...(includeSnippets && (!includePath || path.includes(includePath))
        ? { snippets: diffSnippets(leftText, rightText) }
        : {}),
    };
    changed.push(changedEntry);
  }

  const report = {
    schemaVersion: 1,
    left: { path: leftPath, headerSha256: left.headerSha256, fileCount: leftEntries.size },
    right: { path: rightPath, headerSha256: right.headerSha256, fileCount: rightEntries.size },
    counts: {
      changed: changed.length,
      unchanged: unchanged.length,
      onlyLeft: onlyLeft.length,
      onlyRight: onlyRight.length,
    },
    changed,
    onlyLeft,
    onlyRight,
  };
  process.stdout.write(`${JSON.stringify(compact ? {
    left: report.left,
    right: report.right,
    counts: report.counts,
    changed,
    onlyLeft,
    onlyRight,
  } : report, null, compact ? 0 : 2)}\n`);
} finally {
  closeSync(left.fd);
  closeSync(right.fd);
}

function openAsar(path) {
  const fd = openSync(path, "r");
  const prefix = Buffer.alloc(16);
  readSync(fd, prefix, 0, prefix.length, 0);
  const headerSize = prefix.readUInt32LE(12);
  const headerBuffer = Buffer.alloc(headerSize);
  readSync(fd, headerBuffer, 0, headerSize, 16);
  return {
    fd,
    path,
    header: JSON.parse(headerBuffer.toString("utf8")),
    headerSha256: sha256(headerBuffer),
    dataOffset: alignedDataOffset(headerSize),
  };
}

function fileEntries(header) {
  const entries = new Map();
  walk(header, "", entries);
  return entries;
}

function walk(node, prefix, entries) {
  for (const [name, child] of Object.entries(node?.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (child?.files) walk(child, path, entries);
    else if (!child?.unpacked) entries.set(path, {
      offset: Number(child?.offset ?? 0),
      size: Number(child?.size ?? 0),
      integrityHash: String(child?.integrity?.hash ?? ""),
    });
  }
}

function entryHash(asar, entry) {
  return entry.integrityHash || sha256(readEntry(asar, entry));
}

function readEntry(asar, entry) {
  const buffer = Buffer.alloc(entry.size);
  readSync(asar.fd, buffer, 0, buffer.length, asar.dataOffset + entry.offset);
  return buffer;
}

function markerDelta(left, right) {
  const markers = [
    "Anti-Codex",
    "AntiCodex",
    "__ANTICODEX_OPEN_MANAGER__",
    "anticodex-manager",
    "native-panel-v114",
    "Manager",
    "\\u7ba1\\u7406",
    "管理",
    "icon.ico",
    "enable_i18n",
    "requiresAuth",
    "plugin/list",
  ];
  return markers.map((marker) => ({
    marker,
    left: occurrences(left, marker),
    right: occurrences(right, marker),
  })).filter((entry) => entry.left !== entry.right);
}

function occurrences(text, search) {
  if (!text || !search) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(search, index)) >= 0) {
    count += 1;
    index += search.length;
  }
  return count;
}

function diffSnippets(left, right) {
  if (!left || !right || left.length !== right.length) return [];
  const ranges = [];
  let index = 0;
  while (index < left.length && ranges.length < 24) {
    while (index < left.length && left[index] === right[index]) index += 1;
    if (index >= left.length) break;
    const firstDiff = index;
    let lastDiff = index;
    let equalRun = 0;
    index += 1;
    while (index < left.length) {
      if (left[index] !== right[index]) {
        lastDiff = index;
        equalRun = 0;
      } else {
        equalRun += 1;
        if (equalRun >= 160) break;
      }
      index += 1;
    }
    const start = Math.max(0, firstDiff - 100);
    const end = Math.min(left.length, lastDiff + 101);
    ranges.push({
      firstDiff,
      lastDiff,
      left: cleanSnippet(left.slice(start, end)),
      right: cleanSnippet(right.slice(start, end)),
    });
  }
  return ranges;
}

function cleanSnippet(value) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/ {3,}/g, "  ").slice(0, 800);
}

function textualEntry(path, entry) {
  return entry.size <= 30 * 1024 * 1024 && /(?:\.c?js|\.mjs|\.json|\.html|\.css|\.txt)$/i.test(path);
}

function alignedDataOffset(headerSize) {
  const prefixSize = 16;
  return prefixSize + headerSize + ((4 - ((prefixSize + headerSize) % 4)) % 4);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveRequired(value, label) {
  const text = String(value ?? "").trim();
  if (!text || text === "--compact") throw new Error(`${label} is required.`);
  return resolve(text);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}
