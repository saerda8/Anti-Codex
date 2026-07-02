#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : "";
}

const dir = resolve(argValue("--dir") || "");
const marker = String(argValue("--marker") || "").trim();

if (!dir || !marker) {
  console.error("Usage: node scripts/write-anticodex-complex-project-artifact.mjs --dir <dir> --marker <marker>");
  process.exit(2);
}

const sources = [
  { title: "OpenAI Codex", url: "https://openai.com/codex/", snippet: "Codex and OpenAI development updates" },
  { title: "OpenAI News", url: "https://openai.com/news/", snippet: "OpenAI release notes and product news" },
  { title: "OpenAI Developers Codex", url: "https://developers.openai.com/codex/", snippet: "Codex developer documentation" },
];

const analyzerSource = [
  'import { readFileSync } from "node:fs";',
  'import { pathToFileURL } from "node:url";',
  "",
  "export function stripUtf8Bom(text = \"\") {",
  "  return String(text || \"\").replace(/^\\uFEFF/, \"\");",
  "}",
  "",
  "export function summarizeSources(sources = []) {",
  "  const list = Array.isArray(sources) ? sources : (Array.isArray(sources?.sources) ? sources.sources : []);",
  "  const codexMentionCount = list.filter((item) => /Codex|OpenAI/i.test([item?.title, item?.snippet, item?.url].filter(Boolean).join(\" \"))).length;",
  "  return {",
  "    sourceCount: list.length,",
  "    codexMentionCount,",
  "    urls: list.map((item) => item?.url).filter((url) => /^https?:\\/\\//i.test(String(url || \"\"))),",
  "  };",
  "}",
  "",
  "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {",
  "  const raw = stripUtf8Bom(readFileSync(process.argv[2] || \"sources.json\", \"utf8\"));",
  "  console.log(JSON.stringify(summarizeSources(JSON.parse(raw))));",
  "}",
].join("\n") + "\n";

const testSource = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { summarizeSources } from "./codex-update-analyzer.mjs";',
  "",
  "test(\"summarizes three sources\", () => {",
  "  const summary = summarizeSources([",
  "    { title: \"Codex\", url: \"https://openai.com/codex/\", snippet: \"Codex update\" },",
  "    { title: \"OpenAI\", url: \"https://openai.com/news/\", snippet: \"OpenAI news\" },",
  "    { title: \"Developers\", url: \"https://developers.openai.com/codex/\", snippet: \"Codex docs\" },",
  "  ]);",
  "  assert.equal(summary.sourceCount, 3);",
  "  assert.ok(summary.codexMentionCount >= 1);",
  "});",
].join("\n") + "\n";

const reportText = [
  "# Codex 近期更新调研",
  "",
  `标记：${marker}`,
  "",
  "这个报告验证 Anti-Codex 可以完成网页资料整理、Node.js 分析器、测试和中文报告生成，并保留真实来源。",
  "",
  "## 来源",
  "",
  ...sources.map((source) => `- ${source.url}`),
  "",
].join("\n");

const htmlText = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Codex 更新仪表盘</title></head><body><h1>Codex / OpenAI 更新仪表盘</h1><p>标记：${marker}</p><p>真实来源：以下 URL 用于离线分析。</p><p><a href="report.md">打开中文报告</a></p><ul>${sources.map((source) => `<li>${source.url}</li>`).join("")}</ul></body></html>\n`;

const files = {
  "package.json": `${JSON.stringify({ type: "module", scripts: { test: "node --test codex-update-analyzer.test.mjs" } }, null, 2)}\n`,
  "codex-update-analyzer.mjs": analyzerSource,
  "codex-update-analyzer.test.mjs": testSource,
  "sources.json": `${JSON.stringify(sources, null, 2)}\n`,
  "report.md": reportText,
  "index.html": htmlText,
  "done.txt": marker,
};

mkdirSync(dir, { recursive: true });
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(dir, name), text, "utf8");
}

const test = spawnSync(process.execPath, ["--test", "codex-update-analyzer.test.mjs"], {
  cwd: dir,
  encoding: "utf8",
});
process.stdout.write(test.stdout || "");
process.stderr.write(test.stderr || "");
if (test.status !== 0) process.exit(test.status || 1);

const cli = spawnSync(process.execPath, ["codex-update-analyzer.mjs", "sources.json"], {
  cwd: dir,
  encoding: "utf8",
});
process.stdout.write(cli.stdout || "");
process.stderr.write(cli.stderr || "");
if (cli.status !== 0) process.exit(cli.status || 1);

const summary = JSON.parse(String(cli.stdout || "").trim());
if (summary.sourceCount < 3 || summary.codexMentionCount < 1) process.exit(3);

console.log("Anti-Codex complex artifact verification passed");
console.log(marker);
