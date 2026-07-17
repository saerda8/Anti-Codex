#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { summarizeNativeCodexRolloutExecution } from "./lib/native-codex-rollout-history.mjs";

function parseArgs(argv) {
  const files = [];
  let output = "";
  let markdown = "";
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") {
      output = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--markdown") {
      markdown = argv[index + 1] || "";
      index += 1;
      continue;
    }
    files.push(value);
  }
  if (files.length === 0) {
    throw new Error("Usage: node scripts/audit-anticodex-rollout-execution.mjs [--output <json>] [--markdown <md>] <rollout.jsonl>...");
  }
  if (argv.includes("--output") && !output) throw new Error("--output requires a file path.");
  if (argv.includes("--markdown") && !markdown) throw new Error("--markdown requires a file path.");
  return {
    files: files.map((file) => resolve(file)),
    output: output ? resolve(output) : "",
    markdown: markdown ? resolve(markdown) : "",
  };
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

function executionTotals(tasks) {
  return tasks.reduce((result, task) => {
    result.toolCalls += task.toolCallCount;
    result.toolOutputs += task.toolOutputCount;
    result.commands += task.commandCount;
    for (const turn of task.turns) {
      if (turn.commandCount > 0) {
        result.commandTurns += 1;
        if (turn.preCommandExplanationSeen) result.explainedTurns += 1;
      } else {
        result.emptyTurns += 1;
      }
      result.duplicates += turn.adjacentDuplicateCommandCount;
      result.launches += turn.launchCommandCount;
      result.postComplete += turn.postCompleteToolCallCount + turn.postCompleteToolOutputCount;
      result.unpaired += turn.unpairedToolCallIds.length + turn.unpairedToolOutputIds.length;
    }
    return result;
  }, {
    toolCalls: 0,
    toolOutputs: 0,
    commands: 0,
    commandTurns: 0,
    explainedTurns: 0,
    emptyTurns: 0,
    duplicates: 0,
    launches: 0,
    postComplete: 0,
    unpaired: 0,
  });
}

function markdownReport(report) {
  const totals = executionTotals(report.tasks);
  const lines = [
    "# Anti-Codex 原任务执行审计",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    `**严格结果：${report.ok ? "通过" : "未通过（保留质量缺口）"}**`,
    "",
    `- 工具调用 / 结果：${totals.toolCalls} / ${totals.toolOutputs}`,
    `- 有命令回合的中文执行前说明：${totals.explainedTurns} / ${totals.commandTurns}`,
    `- 程序启动命令：${totals.launches}；完成后工具事件：${totals.postComplete}；未配对工具记录：${totals.unpaired}`,
    `- 相邻重复命令：${totals.duplicates}；无命令回合：${totals.emptyTurns}`,
    "",
    "| 任务 | 任务 ID | 回合 | 工具调用 / 结果 | 命令 | 中文说明回合 | 相邻重复 | 程序启动 | 完成后工具 | 未配对 | 无命令回合 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const task of report.tasks) {
    const taskTotals = executionTotals([task]);
    lines.push(`| ${markdownCell(basename(task.sessionCwd) || task.threadId)} | \`${task.threadId}\` | ${task.turnCount} | ${task.toolCallCount} / ${task.toolOutputCount} | ${task.commandCount} | ${taskTotals.explainedTurns} / ${taskTotals.commandTurns} | ${taskTotals.duplicates} | ${taskTotals.launches} | ${taskTotals.postComplete} | ${taskTotals.unpaired} | ${taskTotals.emptyTurns} |`);
  }
  lines.push("", "## 严格发现", "");
  if (report.failures.length === 0) {
    lines.push("- 无异常。", "");
  } else {
    for (const task of report.tasks) {
      for (const failure of task.failures) {
        lines.push(`- \`${task.threadId}\`：${localizedFailure(failure)}`);
      }
    }
    lines.push("");
  }
  lines.push("严格结果只评价原任务的执行质量；交付物内容、哈希、解码、测试和发布包由独立成果验收报告负责。", "");
  return lines.join("\n");
}

function localizedFailure(value) {
  return String(value)
    .replace(/^(\S+) has no real command$/u, "回合 $1 没有真实命令")
    .replace(/^(\S+) lacks a Chinese pre-command explanation$/u, "回合 $1 缺少中文执行前说明")
    .replace(/^(\S+) has (\d+) adjacent duplicate command\(s\)$/u, "回合 $1 有 $2 次相邻重复命令")
    .replace(/^(\S+) has (\d+) unexpected program launch command\(s\)$/u, "回合 $1 有 $2 次程序启动命令")
    .replace(/^(\S+) has unpaired tool call\/output ids$/u, "回合 $1 有未配对的工具调用或结果")
    .replace(/^(\S+) continued tool work after task_complete$/u, "回合 $1 在 task_complete 后继续执行工具")
    .replace(/^(\S+) has invalid task_complete evidence$/u, "回合 $1 的 task_complete 证据无效");
}

function markdownCell(value) {
  return String(value || "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function main() {
  const { files, output, markdown } = parseArgs(process.argv.slice(2));
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
  if (markdown) writeFileSync(markdown, markdownReport(report), "utf8");
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
