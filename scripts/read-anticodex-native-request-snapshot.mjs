#!/usr/bin/env node
import { resolve } from "node:path";

import { readNativeCodexRequestSnapshot } from "./lib/anticodex-native-request-activity.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key.startsWith("--")) continue;
  if (value && !value.startsWith("--")) {
    args.set(key, value);
    index += 1;
  } else {
    args.set(key, true);
  }
}

if (args.has("--help") || args.has("-h")) {
  console.log("Usage: node scripts/read-anticodex-native-request-snapshot.mjs --codex-home <path> [--database-path <path>]");
  process.exit(0);
}

const codexHome = String(args.get("--codex-home") || "").trim();
const databasePath = String(args.get("--database-path") || "").trim();
if (!codexHome && !databasePath) throw new Error("--codex-home or --database-path is required");

const snapshot = await readNativeCodexRequestSnapshot({
  codexHome: codexHome ? resolve(codexHome) : "",
  databasePath: databasePath ? resolve(databasePath) : undefined,
});
console.log(JSON.stringify({ ok: snapshot.databasePresent === true, ...snapshot }));
if (snapshot.databasePresent !== true) process.exitCode = 1;
