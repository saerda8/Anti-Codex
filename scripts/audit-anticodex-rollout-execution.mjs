#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { summarizeNativeCodexRolloutExecution } from "./lib/native-codex-rollout-history.mjs";

function parseArgs(argv) {
  const files = [];
  let output = "";
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") {
      output = argv[index + 1] || "";
      index += 1;
      continue;
    }
    files.push(value);
  }
  if (files.length === 0) {
    throw new Error("Usage: node scripts/audit-anticodex-rollout-execution.mjs [--output <json>] <rollout.jsonl>...");
  }
  if (argv.includes("--output") && !output) throw new Error("--output requires a file path.");
  return { files: files.map((file) => resolve(file)), output: output ? resolve(output) : "" };
}

function readJsonLines(file) {
  return readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${file}:${index + 1}: ${error.message}`);
      }
    });
}

function main() {
  const { files, output } = parseArgs(process.argv.slice(2));
  const tasks = files.map((file) => ({
    file,
    ...summarizeNativeCodexRolloutExecution(readJsonLines(file), { requireCommandPerTurn: true }),
  }));
  const failures = tasks.flatMap((task) => task.failures.map((failure) => `${task.file}: ${failure}`));
  const report = {
    schema: "anticodex-rollout-execution-audit-v1",
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    taskCount: tasks.length,
    tasks,
    failures,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(output, text, "utf8");
  process.stdout.write(text);
  process.exitCode = report.ok ? 0 : 1;
}

try {
  main();
} catch (error) {
  const report = {
    schema: "anticodex-rollout-execution-audit-v1",
    ok: false,
    generatedAt: new Date().toISOString(),
    taskCount: 0,
    tasks: [],
    failures: [String(error?.message || error)],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
}
