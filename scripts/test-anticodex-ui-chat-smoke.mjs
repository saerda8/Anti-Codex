#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) {
    const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "1";
    args.set(key, value);
  }
}

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/test-anticodex-ui-chat-smoke.mjs [options]

Options:
  --task-mode <mode>       Task mode, for example autonomous-reasoning or agentic-step-flow.
  --model <id>             Required model id for the real UI route.
  --model-label <label>    Required visible model label.
  --timeout-ms <ms>        Overall verifier timeout.
  --marker <text>          Expected final marker.
  --project-label <text>   Expected project label (default: Anti-Codex).
  --artifact-dir <path>    Directory for task artifacts.
  --prompt-file <path>     UTF-8 prompt file.
  --same-chat              Reuse the current chat instead of opening an isolated chat.
  --help, -h               Show this help message without starting UI work.`);
  process.exit(0);
}

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptRoot, "..");
let cdpPort = Number(args.get("--cdp-port") || process.env.DEEPCODEX_CDP_PORT || 0);
const baseUrl = String(args.get("--base-url") || process.env.TRANSLATOR_URL || "http://127.0.0.1:8484").replace(/\/$/, "");
const diagnosticsUrl = `${baseUrl}/anticodex/diagnostics?fast=1`;
const modelRoutesUrl = `${baseUrl}/anticodex/model-routes`;
const timeoutMs = Math.max(15_000, Number(args.get("--timeout-ms") || 90_000));
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const responseHistoryPath = resolve(process.env.APPDATA || os.tmpdir(), "anticodex", "response-history.json");
const taskMode = String(args.get("--task-mode") || "exact-marker");
const requiredModel = String(args.get("--model") || args.get("--required-model") || process.env.ANTICODEX_TEST_MODEL || "").trim();
const requiredModelLabel = String(args.get("--model-label") || args.get("--required-model-label") || "").trim();
const configModelOverrideEnabled = requiredModel && !args.has("--no-config-model-override");
const anticodexStateRoot = resolve(process.env.DEEPCODEX_STATE_ROOT || join(process.env.APPDATA || os.tmpdir(), "anticodex"));
const anticodexCodexHome = resolve(process.env.ANTICODEX_CODEX_HOME || join(anticodexStateRoot, "codex-home-deepseek-app"));
const anticodexConfigPath = resolve(anticodexCodexHome, "config.toml");
const isolateChat = args.has("--same-chat") ? false : true;
const baseReportName = taskMode === "web-search"
  ? "ui-web-search-smoke"
  : taskMode === "free-chat"
    ? "ui-free-chat-smoke"
    : taskMode === "coding-project"
      ? "ui-coding-project-smoke"
    : taskMode === "multi-turn-project"
      ? "ui-multi-turn-project-smoke"
    : taskMode === "complex-project"
      ? "ui-complex-project-smoke"
    : taskMode === "autonomous-reasoning"
      ? "ui-autonomous-reasoning-smoke"
    : taskMode === "report-site"
      ? "ui-report-site-smoke"
    : taskMode === "repo-file-edit"
      ? "ui-repo-file-edit-smoke"
    : taskMode === "repo-multi-file-edit"
      ? "ui-repo-multi-file-edit-smoke"
    : taskMode === "agentic-step-flow"
      ? "ui-agentic-step-flow-smoke"
    : taskMode === "local-project"
      ? "ui-local-project-smoke"
  : "ui-chat-smoke";
const requiredModelReportSuffix = requiredModel
  ? `-model-${requiredModel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)}`
  : "";
const reportName = `${baseReportName}${requiredModelReportSuffix}`;
const projectTaskModes = new Set([
  "exact-marker",
  "web-search",
  "local-project",
  "coding-project",
  "multi-turn-project",
  "complex-project",
  "autonomous-reasoning",
  "report-site",
  "repo-file-edit",
  "repo-multi-file-edit",
  "agentic-step-flow",
]);
const requiresProjectChat = projectTaskModes.has(taskMode);
const projectChatLabel = String(args.get("--project-label") || "Anti-Codex");
const markerPrefix = taskMode === "web-search"
  ? "UI_WEB_SEARCH_SMOKE"
  : taskMode === "coding-project"
    ? "UI_CODING_PROJECT_SMOKE"
  : taskMode === "multi-turn-project"
    ? "UI_MULTI_TURN_PROJECT_SMOKE"
  : taskMode === "complex-project"
    ? "UI_COMPLEX_PROJECT_SMOKE"
  : taskMode === "autonomous-reasoning"
    ? "UI_AUTONOMOUS_REASONING_SMOKE"
  : taskMode === "report-site"
    ? "UI_REPORT_SITE_SMOKE"
  : taskMode === "repo-file-edit"
    ? "UI_REPO_FILE_EDIT_SMOKE"
  : taskMode === "repo-multi-file-edit"
    ? "UI_REPO_MULTI_FILE_EDIT_SMOKE"
  : taskMode === "agentic-step-flow"
    ? "UI_AGENTIC_STEP_FLOW_SMOKE"
  : taskMode === "local-project"
    ? "UI_LOCAL_PROJECT_SMOKE"
    : "UI_CHAT_SMOKE";
let marker = String(args.get("--marker") || `${markerPrefix}_${Date.now()}`);
const activeReconnectPattern = /(?:Reconnecting\.\.\.|reconnecting|\u6b63\u5728\u91cd\u65b0\u8fde\u63a5|\u91cd\u65b0\u8fde\u63a5|\u6b63\u5728\u91cd\u8fde|\u91cd\u8fde\u4e2d)/i;
const artifactDir = args.get("--artifact-dir")
  ? resolve(String(args.get("--artifact-dir")))
  : resolve(
    reportRoot,
    taskMode === "coding-project"
      ? "desktop-visible-coding-project"
      : taskMode === "multi-turn-project"
        ? "desktop-visible-multi-turn-project"
      : taskMode === "complex-project"
        ? "desktop-visible-complex-project"
      : taskMode === "autonomous-reasoning"
        ? "desktop-visible-autonomous-reasoning"
      : taskMode === "report-site"
        ? "desktop-visible-report-site"
      : taskMode === "agentic-step-flow"
        ? "desktop-visible-agentic-step-flow"
        : "desktop-visible-small-project",
    marker.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
  );
const repoFileEditDir = resolve(args.get("--repo-file-edit-dir") || join(sourceRoot, "scripts", "fixtures", "desktop-coworker-live"));
const repoFileEditTarget = resolve(repoFileEditDir, "acceptance-target.mjs");
const repoFileEditTest = resolve(repoFileEditDir, "acceptance-target.test.mjs");
const repoMultiFileEditDir = resolve(args.get("--repo-multi-file-edit-dir") || join(sourceRoot, "scripts", "fixtures", "desktop-coworker-project"));
const repoMultiFileSource = resolve(repoMultiFileEditDir, "status-dashboard.mjs");
const repoMultiFileTest = resolve(repoMultiFileEditDir, "status-dashboard.test.mjs");
const repoMultiFileData = resolve(repoMultiFileEditDir, "status-data.json");
const repoMultiFileReadme = resolve(repoMultiFileEditDir, "README.md");
const repoMultiFileHtml = resolve(repoMultiFileEditDir, "status-dashboard.html");
let repoMultiFileBaselineSource = "";
let repoMultiFileExpectedTest = "";
let repoMultiFileExpectedData = "";
const promptFile = args.get("--prompt-file") ? resolve(String(args.get("--prompt-file"))) : "";
const promptFromFile = promptFile ? readFileSync(promptFile, "utf8") : "";
const hasCustomPrompt = Boolean(promptFromFile || args.get("--prompt"));
let promptText = String(promptFromFile || args.get("--prompt") || (taskMode === "web-search"
  ? `最近 Codex 都更新了什么？请上网搜索后用中文简要回答，最后单独写 ${marker}。`
  : taskMode === "local-project"
    ? `Create a very small local HTML report in ${artifactDir}. Create exactly these files: index.html, README.md, done.txt. index.html must be a simple offline page with one heading, one status paragraph, and the exact marker ${marker}. README.md must describe the files. done.txt must contain exactly ${marker}. Verify the files, then reply with ${marker}.`
    : `Reply with exactly ${marker} and nothing else.`));
if (!hasCustomPrompt && taskMode === "web-search") {
  promptText = `Search the web for recent Codex updates, answer briefly in Chinese with source URLs, and put ${marker} on its own final line.`;
}
if (!hasCustomPrompt && taskMode === "free-chat") {
  promptText = `用中文简短回答：只说判断标准，不要声称你正在或已经执行文件、命令或搜索。如果 Anti-Codex 是 Codex 客户端接入另一个模型，正常小任务应该怎么判断是否跑通？最后单独一行写 ${marker}。`;
}
if (!hasCustomPrompt && taskMode === "local-project") {
  promptText = `Create a very small local HTML report in ${artifactDir}. Use PowerShell file commands to create exactly these files: index.html, README.md, done.txt. Do not inspect Antigravity brain, transcript, history, or log folders. index.html must be a simple offline page with one heading, one status paragraph, and the exact marker ${marker}. README.md must describe the files. done.txt must contain exactly ${marker}. Verify the files exist and done.txt exactly matches the marker, then reply with ${marker}.`;
}
if (!hasCustomPrompt && taskMode === "agentic-step-flow") {
  promptText = [
    `请完成一个多阶段可见任务，工作目录是 ${artifactDir}。`,
    "",
    "你必须像 Codex 一样分阶段工作：",
    "1. 先在可见回复里单独写一行：阶段1：准备创建文件。",
    `2. 然后用工具创建 index.html、README.md、done.txt 三个文件。index.html 要包含中文标题“多阶段执行验证”和标记 ${marker}；README.md 要说明三个文件；done.txt 必须只包含 ${marker}。`,
    "3. 文件创建后，在可见回复里单独写一行：阶段2：准备验证文件。",
    `4. 然后用工具验证 done.txt 内容完全等于 ${marker}，并检查 index.html 包含“多阶段执行验证”。`,
    `5. 验证后，在最后一行只写：${marker}`,
    "",
    "不要查看 Antigravity brain、transcript、history 或 log 目录。不要创建其他文件。",
  ].join("\n");
}
if (!hasCustomPrompt && taskMode === "coding-project") {
  promptText = `请在 ${artifactDir} 里创建一个很小的 Node.js CLI 项目。只用 PowerShell 文件命令创建这些文件：package.json、word-tally.mjs、word-tally.test.mjs、done.txt，不要多建文件。不要查看 Antigravity brain、transcript、history 或 log 目录。word-tally.mjs 必须导出 tallyWords(text) 函数，并且作为 CLI 运行时把命令行参数当作待统计文本，不要把参数当作文件路径；运行 node word-tally.mjs "red blue red" 时必须打印包含 {"red":2,"blue":1} 的 JSON。word-tally.test.mjs 必须使用 node:test，并断言 "red blue red" 返回 red=2、blue=1。done.txt 必须只包含 ${marker}，请用 [System.IO.File]::WriteAllText 写 UTF8Encoding(false)，不能有 BOM 或换行；不要用 Set-Content 写 done.txt。运行 node --test word-tally.test.mjs 和 node word-tally.mjs "red blue red"。最后必须运行 Get-Content done.txt 并让工具输出显示完整标记 ${marker}，核对后最后回复 ${marker}。`;
}
if (!hasCustomPrompt && taskMode === "multi-turn-project") {
  promptText = `请在 ${artifactDir} 里创建一个很小的 Node.js CLI 项目。这是两轮任务的第 1 轮。只用 PowerShell 文件命令创建这些文件：package.json、word-tally.mjs、word-tally.test.mjs、done.txt，不要多建文件。不要查看 Antigravity brain、transcript、history 或 log 目录。word-tally.mjs 必须导出 tallyWords(text)，并且作为 CLI 运行时打印 JSON 单词计数。word-tally.test.mjs 必须使用 node:test，并断言 "red blue red" 返回 red=2、blue=1。done.txt 必须只包含 ${marker}_FIRST。运行 node --test word-tally.test.mjs 和 node word-tally.mjs "red blue red"，核对输出后，最后回复 ${marker}_FIRST。`;
}
if (!hasCustomPrompt && taskMode === "complex-project") {
  const complexProjectCommand = buildComplexProjectRepairCommandSafe(artifactDir, marker);
  promptText = [
    "请完成一个真实的中文长任务：先在本地做一个小型 Node.js 分析项目，再把 Codex / OpenAI Codex 更新资料来源写进项目。",
    `工作目录：${artifactDir}`,
    `最终标记：${marker}`,
    "",
    "必须只创建下面 7 个文件，文件名必须完全一致：",
    "package.json",
    "codex-update-analyzer.mjs",
    "codex-update-analyzer.test.mjs",
    "sources.json",
    "report.md",
    "index.html",
    "done.txt",
    "",
    "第一步必须自己发起真实工具调用，先创建目录和下面 7 个文件；不要先输出搜索摘要、资料列表或只回复计划。",
    `第一条工具调用必须直接执行这条 PowerShell-safe Node 命令：${complexProjectCommand}`,
    "不要手写 sources.json，不要手抄半截 JSON；这条命令已经用 JSON.stringify 生成完整 sources.json，并且会立即运行 node:test 和 CLI 验证。",
    "如果系统提示里也出现 Anti-Codex complex project tool example，以本条提示里的完整 node -e 命令为准；不要先列目录，不要读取历史。",
    "可以使用你已知的公开 OpenAI/Codex URL 作为 sources.json 来源；不要求先做 web_search 才能写文件。",
    "禁止创建 server.js、test.js、summary.json、README.md 或其他替代文件；如果已经创建了，必须删除后再结束。",
    "请用 PowerShell 执行 Node.js 文件写入命令；JSON 和 JavaScript 文件必须用 Node fs.writeFileSync(..., \"utf8\") 写入，避免 UTF-8 BOM；do not use Set-Content, Out-File, or PowerShell redirection for JSON or JavaScript files。",
    "sources.json 必须至少包含 3 条真实来源 URL，内容围绕 Codex 或 OpenAI 更新；URL 域名必须是 openai.com 或 *.openai.com，不能写错拼域名。",
    "codex-update-analyzer.mjs 必须导出 summarizeSources(sources)，must define stripUtf8Bom(text)，must call stripUtf8Bom before JSON.parse，作为 CLI 运行时读取 sources.json，并打印 JSON：sourceCount 和 codexMentionCount。",
    "codex-update-analyzer.test.mjs 必须使用 node:test，并断言 3 条 sources 会得到 sourceCount=3。",
    "report.md 必须是中文，包含精确短语“真实来源”，提到 Codex 或 OpenAI，包含至少 3 个真实来源 URL，并包含最终标记。",
    "index.html 必须是完整离线中文 HTML，包含精确短语“真实来源”，链接 report.md，提到 Codex 或 OpenAI，包含至少 3 个真实来源 URL，并包含最终标记。",
    "index.html 必须写真实 HTML 标签，例如 <!doctype html> 和 <html>；不要写 &lt;html&gt; 这种 HTML entity 字面量。",
    "report.md 和 index.html 必须直接写真实中文，不要手写 Unicode escape；文件内容必须包含真实换行，不能包含字面量 \\n。",
    "done.txt 必须只包含最终标记。",
    "",
    "验证要求：运行 node --test codex-update-analyzer.test.mjs，再运行 node codex-update-analyzer.mjs sources.json；确认 sourceCount >= 3 且 codexMentionCount >= 1。最后读回目录和 done.txt，确认只有上面 7 个文件，done.txt 完全等于最终标记。",
    `完成后最后一行只写：${marker}`,
    "",
    "不要查看 Antigravity brain、transcript、history 或 log 目录。不要只描述计划，必须从工具调用开始，真实创建文件并运行验证命令。",
  ].join("\n");
}
if (!hasCustomPrompt && taskMode === "autonomous-reasoning") {
  promptText = [
    "请作为一个真正的 Codex 风格开发代理，自主完成一个小型研究+代码+报告任务。",
    `工作目录：${artifactDir}`,
    `最终标记：${marker}`,
    "",
    "目标：做一个离线可运行的 Codex 更新资料分析器。你需要自己决定合理步骤、文件内容和验证顺序，不要只复述计划。",
    "必须产出的结果：",
    "- 文件名必须完全使用 package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt。",
    "- analyzer.js、test.js、summary.json 或其他替代文件名都不算完成，即使内容正确也必须改成上面的确切文件名。",
    "- 一个可运行的 Node.js 分析器，能读取 sources.json 并输出 JSON 摘要。",
    "- 一个 node:test 测试文件，证明分析器至少能统计 3 条来源。",
    "- sources.json 至少包含 3 条真实来源 URL，内容围绕 Codex 或 OpenAI 更新；可以使用你已知的公开 URL。",
    "- 一份中文 report.md，说明你的结论，并包含真实来源 URL 和最终标记。",
    "- 一个离线 index.html，中文展示分析结果，链接 report.md，包含真实来源 URL 和最终标记。",
    "- done.txt 只能包含最终标记。",
    "",
    "约束：不要查看 Antigravity brain、transcript、history 或 log 目录。可以创建文件、运行测试和命令。你要自己规划并执行，遇到失败要自行修正。最后只在最后一行输出最终标记。",
  ].join("\n");
}
if (!hasCustomPrompt && taskMode === "report-site") {
  const reportSiteCommand = buildReportSiteRepairCommandSafe(artifactDir, marker);
  promptText = [
    "\u8bf7\u7528\u4e2d\u6587\u5b8c\u6210\u4e00\u4e2a\u771f\u5b9e\u7684\u684c\u9762\u957f\u4efb\u52a1\uff1a\u5148\u5229\u7528\u5df2\u63d0\u4f9b\u7684\u7f51\u9875\u641c\u7d22\u7ed3\u679c\u6216\u4f60\u5df2\u77e5\u7684\u516c\u5f00\u6765\u6e90\uff0c\u518d\u751f\u6210\u4e00\u4e2a\u672c\u5730 Codex / OpenAI \u8c03\u7814\u7ad9\u70b9\u3002",
    `\u5de5\u4f5c\u76ee\u5f55\uff1a${artifactDir}`,
    `\u6700\u7ec8\u6807\u8bb0\uff1a${marker}`,
    "",
    "\u7b2c\u4e00\u6b65\u5fc5\u987b\u53d1\u8d77\u771f\u5b9e\u5de5\u5177\u8c03\u7528\uff0c\u4e0d\u8981\u5148\u53ea\u89e3\u91ca\u8ba1\u5212\u3002Use PowerShell only to run Node.js file-write commands.",
    `\u7b2c\u4e00\u6761\u6587\u4ef6\u5199\u5165\u547d\u4ee4\u8bf7\u76f4\u63a5\u6267\u884c\u8fd9\u4e2a PowerShell-safe Node \u547d\u4ee4\uff1a${reportSiteCommand}`,
    "\u8fd9\u6761\u547d\u4ee4\u4f1a\u521b\u5efa\u6216\u8986\u76d6\u4e14\u53ea\u521b\u5efa report.md\u3001index.html\u3001done.txt\uff1bDo not create README.md. README.md is explicitly wrong for this task.",
    "report.md \u5fc5\u987b\u662f\u4e2d\u6587\uff0c\u63d0\u5230 Codex \u6216 OpenAI\uff0c\u5305\u542b\u81f3\u5c11 3 \u4e2a\u771f\u5b9e\u6765\u6e90 URL\uff0c\u5e76\u5305\u542b\u6700\u7ec8\u6807\u8bb0\u3002",
    "index.html \u5fc5\u987b\u662f\u5b8c\u6574\u79bb\u7ebf\u4e2d\u6587 HTML\uff0c\u94fe\u63a5 report.md\uff0c\u63d0\u5230 Codex \u6216 OpenAI\uff0c\u5305\u542b\u81f3\u5c11 3 \u4e2a\u771f\u5b9e\u6765\u6e90 URL\uff0c\u5e76\u5305\u542b\u6700\u7ec8\u6807\u8bb0\u3002",
    "done.txt \u5fc5\u987b\u53ea\u5305\u542b\u6700\u7ec8\u6807\u8bb0\u3002do not use Set-Content, Out-File, or PowerShell redirection for JSON or JavaScript files.",
    "\u6267\u884c\u540e\u5fc5\u987b\u8bfb\u56de\u6216\u9a8c\u8bc1 report.md\u3001index.html\u3001done.txt \u90fd\u5b58\u5728\uff0cdone.txt \u5b8c\u5168\u7b49\u4e8e\u6700\u7ec8\u6807\u8bb0\u3002",
    "\u4e0d\u8981\u67e5\u770b Antigravity brain\u3001transcript\u3001history \u6216 log \u76ee\u5f55\u3002",
    `\u5b8c\u6210\u540e\u6700\u540e\u4e00\u884c\u53ea\u5199\uff1a${marker}`,
  ].join("\n");
}
if (!hasCustomPrompt && taskMode === "repo-file-edit") {
  promptText = `In the local project ${sourceRoot}, edit only this file: ${repoFileEditTarget}. The test file already exists at ${repoFileEditTest} and currently fails. Do not start with Get-ChildItem, dir, ls, or another directory listing. You already have the required behavior: implement normalizeStatus(input) so it trims, lowercases, replaces any run of spaces or underscores with one hyphen, removes characters other than lowercase letters, digits, and hyphen, collapses repeated hyphens, and trims leading/trailing hyphens. Your first tool action must modify ${repoFileEditTarget}. Do not edit any other source file. Then run: node --test ${repoFileEditTest}. Only finish after the test passes. Put exactly ${marker} on the final line.`;
}
if (!hasCustomPrompt && taskMode === "repo-multi-file-edit") {
  promptText = `Work only in this fixture directory: ${repoMultiFileEditDir}. This is step 1 of 2. Your first and only tool action for this step must write ${repoMultiFileReadme}. Execute exactly this PowerShell-safe Node command before any other command: ${buildRepoMultiReadmeWriteCommand()}. Create README.md containing the Chinese title 使用说明 and the command: node status-dashboard.mjs status-data.json. Do not inspect the directory first. Do not edit, replace, or delete ${repoMultiFileSource}, ${repoMultiFileTest}, or ${repoMultiFileData} for any reason. Do not run git status, Get-ChildItem, Get-Content, dir, ls, cat, or node --test in this step. After README.md exists, reply with exactly ${marker} on the final line and stop.`;
}
if (hasCustomPrompt && !args.get("--marker")) {
  const promptMarker = String(promptText).match(/\bUI_[A-Z0-9_]{8,}\b/g)?.at(-1);
  if (promptMarker) marker = promptMarker;
}
const promptLanguage = /[\u3400-\u9fff]/u.test(promptText) ? "zh" : "en";
let followupPromptText = "";
let followupPromptLanguage = "";
const startedAt = Date.now();
let configModelOverrideEvidence = null;
let configModelOverrideRestore = null;
const uiLockDir = join(reportRoot, "ui-chat-smoke.lock");

function configModelFromText(text) {
  const match = String(text || "").match(/^model\s*=\s*"([^"]+)"/m);
  return match ? match[1] : "";
}

function installConfigModelOverride() {
  if (!configModelOverrideEnabled) return null;
  const requested = requiredModel.replace(/"/g, "");
  let originalText = "";
  try {
    originalText = readFileSync(anticodexConfigPath, "utf8");
  } catch (error) {
    configModelOverrideEvidence = {
      ok: false,
      configPath: anticodexConfigPath,
      requestedModel: requested,
      error: error instanceof Error ? error.message : String(error),
    };
    return null;
  }
  const originalModel = configModelFromText(originalText);
  if (!/^model\s*=\s*"[^"]*"/m.test(originalText)) {
    configModelOverrideEvidence = {
      ok: false,
      configPath: anticodexConfigPath,
      originalModel,
      requestedModel: requested,
      error: "config model line not found",
    };
    return null;
  }
  const changedText = originalText.replace(/^model\s*=\s*"[^"]*"/m, `model = "${requested}"`);
  configModelOverrideEvidence = {
    ok: true,
    configPath: anticodexConfigPath,
    originalModel,
    requestedModel: requested,
    changed: changedText !== originalText,
    restored: false,
    restoreError: "",
  };
  if (configModelOverrideEvidence.changed) writeFileSync(anticodexConfigPath, changedText, "utf8");
  const restore = () => {
    if (configModelOverrideEvidence?.restored) return;
    try {
      if (configModelOverrideEvidence?.changed) writeFileSync(anticodexConfigPath, originalText, "utf8");
      if (configModelOverrideEvidence) configModelOverrideEvidence.restored = true;
    } catch (error) {
      if (configModelOverrideEvidence) configModelOverrideEvidence.restoreError = error instanceof Error ? error.message : String(error);
    }
  };
  process.once("exit", restore);
  process.once("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    restore();
    process.exit(143);
  });
  process.once("uncaughtException", (error) => {
    restore();
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
  configModelOverrideRestore = restore;
  return { restore };
}

function restoreConfigModelOverride() {
  if (typeof configModelOverrideRestore === "function") configModelOverrideRestore();
}

function processIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireUiSmokeLock({ waitMs = 60_000, staleMs = 60_000 } = {}) {
  mkdirSync(reportRoot, { recursive: true });
  const deadline = Date.now() + waitMs;
  let lastOwner = null;
  while (Date.now() < deadline) {
    try {
      mkdirSync(uiLockDir);
      const owner = {
        pid: process.pid,
        marker,
        taskMode,
        startedAt: new Date().toISOString(),
      };
      writeFileSync(join(uiLockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(uiLockDir, { recursive: true, force: true });
      };
    } catch (error) {
      try {
        const stat = statSync(uiLockDir);
        if (Date.now() - stat.mtimeMs > staleMs) {
          rmSync(uiLockDir, { recursive: true, force: true });
          continue;
        }
        lastOwner = readFileSync(join(uiLockDir, "owner.json"), "utf8");
        try {
          const owner = JSON.parse(lastOwner);
          if (!processIsAlive(owner?.pid)) {
            rmSync(uiLockDir, { recursive: true, force: true });
            continue;
          }
        } catch {}
      } catch {}
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  }
  throw new Error(`another desktop UI smoke is still running; lock=${uiLockDir}; owner=${lastOwner || "unknown"}`);
}

function httpJson(url, headers = {}) {
  return new Promise((resolveJson, reject) => {
    const target = new URL(url);
    const req = http.get({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolveJson(JSON.parse(data));
        } catch (error) {
          reject(new Error(`invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    req.setTimeout(8_000, () => req.destroy(new Error(`timeout from ${url}`)));
    req.on("error", reject);
  });
}

function httpJsonPost(url, body, headers = {}) {
  const payload = JSON.stringify(body || {});
  const target = new URL(url);
  return new Promise((resolveJson, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolveJson(JSON.parse(data));
        } catch (error) {
          reject(new Error(`invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    req.setTimeout(8_000, () => req.destroy(new Error(`timeout from ${url}`)));
    req.on("error", reject);
    req.end(payload);
  });
}

function routeKey(route) {
  if (!route || typeof route !== "object") return "";
  return [
    route.at,
    route.requestId,
    route.cascadeId,
    route.requestedModel,
    route.resolvedModel,
    route.status,
  ].map((item) => String(item || "")).join("|");
}

function compactRoute(route) {
  if (!route || typeof route !== "object") return null;
  return {
    at: route.at || null,
    requestId: route.requestId || null,
    transport: route.transport || null,
    requestedModel: route.requestedModel || null,
    resolvedModel: route.resolvedModel || null,
    displayName: route.displayName || null,
    internalModel: route.internalModel || null,
    cascadeId: route.cascadeId || null,
    status: route.status || null,
  };
}

function normalizeModelNeedle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function modelValueMatches(value, expectedValues = []) {
  const normalized = normalizeModelNeedle(value);
  if (!normalized) return false;
  return expectedValues
    .map(normalizeModelNeedle)
    .filter(Boolean)
    .some((expected) => normalized === expected || normalized.includes(expected) || expected.includes(normalized));
}

function requiredModelNeedles() {
  return [requiredModel, requiredModelLabel].filter(Boolean);
}

function collectRequiredModelFailures(modelRouteEvidence, diagnostics) {
  const expected = requiredModelNeedles();
  if (expected.length === 0) return [];
  const actualValues = [];
  const addRoute = (route) => {
    if (!route) return;
    actualValues.push(route.requestedModel, route.resolvedModel, route.displayName, route.internalModel);
  };
  const currentRoutes = Array.isArray(modelRouteEvidence?.routes) ? modelRouteEvidence.routes : [];
  for (const route of currentRoutes) addRoute(route);
  actualValues.push(
    diagnostics?.responsesWebSocket?.lastClientPayload?.model,
    diagnostics?.responsesWebSocket?.lastClientPayload?.metadata?.model,
  );
  if (actualValues.some((value) => modelValueMatches(value, expected))) return [];
  const compactActual = actualValues.filter(Boolean).map(String).slice(0, 8).join(", ") || "none";
  return [`desktop task did not route through required model ${expected.join(" / ")}; observed ${compactActual}`];
}

function desktopRealTrafficObserved(modelRouteEvidence) {
  if (Number(modelRouteEvidence?.newRouteCount || 0) > 0) return true;
  return false;
}

function desktopRequestPayloadObserved(diagnostics) {
  const ws = diagnostics?.responsesWebSocket || null;
  const payload = ws?.lastClientPayload || null;
  const relay = ws?.lastRelay || null;
  if (Number(payload?.latestUserChars || 0) > 0) return true;
  if (Number(payload?.inputItems || 0) > 0) return true;
  if (Number(relay?.textDeltaChars || 0) > 0) return true;
  if (Array.isArray(relay?.toolCallNames) && relay.toolCallNames.length > 0) return true;
  return false;
}

function modelRequestPayloadObserved(diagnostics, turns = []) {
  if (desktopRequestPayloadObserved(diagnostics)) return true;
  for (const turn of turns.filter(Boolean)) {
    if (desktopRequestPayloadObserved(turn?.inLoopIdleDiagnostics)) return true;
    const submit = turn?.submitEvidence || null;
    if (submit?.realSubmit?.ok === true || submit?.retryRealSubmit?.ok === true) return true;
  }
  return false;
}

function responsesWebSocketPayloadCount(diagnostics) {
  return Number(diagnostics?.responsesWebSocket?.clientPayloads || 0);
}

function diagnosticsHasRealResponsesSubmitAfter(diagnostics, beforePayloadCount = 0) {
  if (responsesWebSocketPayloadCount(diagnostics) <= beforePayloadCount) return false;
  const ws = diagnostics?.responsesWebSocket || null;
  const payload = ws?.lastClientPayload || null;
  const relay = ws?.lastRelay || null;
  if (Number(payload?.latestUserChars || 0) > 0) return true;
  if (Number(payload?.inputItems || 0) > 0) return true;
  if (Number(relay?.textDeltaChars || 0) > 0) return true;
  if (Array.isArray(relay?.toolCallNames) && relay.toolCallNames.length > 0) return true;
  return false;
}

function responsesSubmitModelValues(diagnostics) {
  const payload = diagnostics?.responsesWebSocket?.lastClientPayload || null;
  return [
    payload?.model,
    payload?.metadata?.model,
    payload?.metadata?.selectedModel,
  ].filter(Boolean).map(String);
}

function diagnosticsHasRequiredModelSubmit(diagnostics) {
  const expected = requiredModelNeedles();
  if (expected.length === 0) return true;
  return responsesSubmitModelValues(diagnostics).some((value) => modelValueMatches(value, expected));
}

function realSubmitInputItems(realSubmit) {
  return Number(realSubmit?.diagnostics?.responsesWebSocket?.lastClientPayload?.inputItems || 0);
}

async function waitForRealResponsesSubmitAfter(url, beforePayloadCount = 0, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      latest = await httpJson(`${url}/anticodex/diagnostics?fast=1`);
      if (diagnosticsHasRealResponsesSubmitAfter(latest, beforePayloadCount)) {
        const requiredModelMatched = diagnosticsHasRequiredModelSubmit(latest);
        return {
          ok: true,
          diagnostics: latest,
          lastError: requiredModelMatched ? null : `raw responses payload model did not match required model: ${responsesSubmitModelValues(latest).join(", ") || "none"}`,
          requiredModelMatched,
          observedModels: responsesSubmitModelValues(latest),
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return {
    ok: false,
    diagnostics: latest,
    lastError,
    requiredModelMatched: diagnosticsHasRequiredModelSubmit(latest),
    observedModels: responsesSubmitModelValues(latest),
  };
}

async function readModelRoutesEvidence() {
  try {
    const payload = await httpJson(modelRoutesUrl);
    return {
      ok: payload?.ok === true,
      count: Number(payload?.count || 0),
      latest: compactRoute(payload?.latest),
      entries: (Array.isArray(payload?.entries) ? payload.entries : []).map(compactRoute).filter(Boolean),
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      latest: null,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function collectModelRouteEvidence(before) {
  const after = await readModelRoutesEvidence();
  const beforeKeys = new Set((Array.isArray(before?.entries) ? before.entries : []).map(routeKey).filter(Boolean));
  if (before?.latest) beforeKeys.add(routeKey(before.latest));
  const newRoutes = after.entries.filter((route) => !beforeKeys.has(routeKey(route)));
  return {
    url: modelRoutesUrl,
    beforeOk: before?.ok === true,
    afterOk: after.ok === true,
    beforeCount: Number(before?.count || 0),
    afterCount: Number(after.count || 0),
    newRouteCount: newRoutes.length,
    latest: compactRoute(newRoutes[0] || after.latest),
    routes: newRoutes.slice(0, 8).map(compactRoute).filter(Boolean),
    error: after.error || before?.error || null,
  };
}

async function resetBackendSessionLock(url) {
  const headers = { origin: url, referer: `${url}/anticodex/manager` };
  const boot = await httpJson(`${url}/anticodex/manager/bootstrap`, headers);
  const token = boot?.token;
  if (!token) throw new Error("manager bootstrap did not return a token");
  return httpJsonPost(`${url}/anticodex/manager/action`, { action: "resetAntigravitySessionLock" }, {
    ...headers,
    "x-anticodex-manager-token": token,
  });
}

class LocalWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.nextId = 1;
    this.callbacks = new Map();
    this.events = [];
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolveConnect, reject) => {
      const key = randomBytes(16).toString("base64");
      this.socket = net.connect(Number(this.url.port), this.url.hostname, () => {
        this.socket.write([
          `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
          `Host: ${this.url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      });
      let header = "";
      const onHeader = (chunk) => {
        header += chunk.toString("binary");
        if (!header.includes("\r\n\r\n")) return;
        this.socket.off("data", onHeader);
        if (!/^HTTP\/1\.1 101\b/.test(header)) {
          reject(new Error(`CDP websocket upgrade failed: ${header.split("\r\n")[0]}`));
          return;
        }
        this.socket.on("data", (data) => this.onData(data));
        resolveConnect();
      };
      this.socket.on("data", onHeader);
      this.socket.on("error", reject);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
    const header = payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10_000);
      this.callbacks.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveSend(value);
        },
        reject,
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high > 0x1fffff) throw new Error("CDP frame is too large for this smoke verifier");
        length = high * 0x100000000 + low;
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.slice(offset, offset + length).toString("utf8");
      this.buffer = this.buffer.slice(offset + length);
      let message = null;
      try { message = JSON.parse(payload); } catch { continue; }
      if (message.id && this.callbacks.has(message.id)) {
        this.callbacks.get(message.id).resolve(message);
        this.callbacks.delete(message.id);
      } else if (message.method) {
        this.events.push(message);
        if (this.events.length > 200) this.events.shift();
      }
    }
  }
}

function summarizeNetworkEvents(events) {
  return events
    .filter((event) => String(event.method || "").startsWith("Network."))
    .map((event) => {
      const params = event.params || {};
      const request = params.request || {};
      const response = params.response || {};
      return {
        method: event.method,
        requestId: params.requestId || null,
        url: request.url || response.url || params.url || null,
        type: params.type || null,
        status: response.status || null,
        errorText: params.errorText || null,
        websocketRequestId: params.requestId || null,
        websocketMessage: params.response?.payloadData ? String(params.response.payloadData).slice(0, 500) : null,
      };
    })
    .filter((event) => {
      const text = `${event.url || ""} ${event.websocketMessage || ""}`;
      return /responses|chat\/completions|backend-api|websocket|codex/i.test(text)
        || /Network\.webSocket|Network\.eventSource|Network\.loadingFailed/.test(event.method);
    })
    .slice(-80);
}

function writeReport(payload) {
  mkdirSync(reportRoot, { recursive: true });
  const latest = join(reportRoot, `latest-${reportName}.json`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const history = join(reportRoot, `${stamp}-${reportName}.json`);
  const json = `${JSON.stringify({ ...payload, report: { latest, history } }, null, 2)}\n`;
  for (const file of [latest, history]) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, file);
    writeFileSync(`${file}.sha256`, `${createHash("sha256").update(readFileSync(file)).digest("hex")}\n`, "utf8");
  }
}

function responseHistoryContains(text) {
  if (!text) return false;
  try {
    return readFileSync(responseHistoryPath, "utf8").includes(text);
  } catch {
    return false;
  }
}

function responseHistoryHasToolOutputMarker(text) {
  if (!text) return false;
  try {
    const history = JSON.parse(readFileSync(responseHistoryPath, "utf8"));
    for (const entry of Array.isArray(history?.entries) ? history.entries : []) {
      const items = [
        ...(Array.isArray(entry?.inputItems) ? entry.inputItems : []),
        ...(Array.isArray(entry?.contextItems) ? entry.contextItems : []),
      ];
      for (const item of items) {
        if (item?.type !== "function_call_output" && item?.type !== "custom_tool_call_output") continue;
        if (JSON.stringify(item).includes(text)) return true;
      }
    }
  } catch {}
  return false;
}

function diagnosticsAreIdle(diagnostics) {
  if (!diagnostics) return false;
  const sessionLock = diagnostics.antigravitySessionLock || null;
  const activeRequests = diagnostics.activeAntigravityRequests || null;
  const queue = diagnostics.antigravityQueue || null;
  return sessionLock?.active !== true
    && Number(sessionLock?.queued || 0) === 0
    && Number(activeRequests?.active || 0) === 0
    && queue?.running !== true;
}

async function waitForDesktopToolTurnSettled(ws, marker, waitMs = 120_000) {
  const deadline = Date.now() + waitMs;
  let lastUi = null;
  let lastDiagnostics = null;
  while (Date.now() < deadline) {
    const ui = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
        const labels = buttons.map((button) => \`\${button.getAttribute('aria-label') || ''} \${button.innerText || ''}\`.trim());
        const hasStopButton = labels.some((label) => /^(?:停止|Stop)$/i.test(label));
        const thinkingTextSeen = labels.some((label) => /正在思考|Thinking/i.test(label));
        return { busy: hasStopButton, hasStopButton, thinkingTextSeen, labels: labels.filter(Boolean).slice(-20) };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    lastUi = ui.result?.result?.value || null;
    try {
      lastDiagnostics = await httpJson(diagnosticsUrl);
    } catch {}
    if (responseHistoryHasToolOutputMarker(marker) && lastUi?.busy !== true && diagnosticsAreIdle(lastDiagnostics)) {
      return { ok: true, historyToolOutputSeen: true, ui: lastUi, diagnostics: lastDiagnostics };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  }
  return {
    ok: false,
    historyToolOutputSeen: responseHistoryHasToolOutputMarker(marker),
    ui: lastUi,
    diagnostics: lastDiagnostics,
  };
}

function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function stripUtf8Bom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function parseJsonFile(path) {
  return JSON.parse(stripUtf8Bom(readFileSync(path, "utf8")));
}

function sameTextIgnoringNewlineStyle(actual, expected) {
  return String(actual || "").replace(/\r\n/g, "\n") === String(expected || "").replace(/\r\n/g, "\n");
}

function makeWritable(path) {
  try {
    if (fileExists(path)) chmodSync(path, 0o666);
  } catch {}
}

function makeReadOnly(path) {
  try {
    if (fileExists(path)) chmodSync(path, 0o444);
  } catch {}
}

function prepareRepoFileEditFixture() {
  mkdirSync(repoFileEditDir, { recursive: true });
  writeFileSync(repoFileEditTarget, [
    'export function normalizeStatus(input = "") {',
    "  return String(input).trim();",
    "}",
    "",
    "export function summarizeStatuses(values = []) {",
    "  const counts = {};",
    "  for (const value of values) {",
    "    const key = normalizeStatus(value);",
    "    if (!key) continue;",
    "    counts[key] = (counts[key] || 0) + 1;",
    "  }",
    "  return counts;",
    "}",
    "",
  ].join("\n"), "utf8");
  writeFileSync(repoFileEditTest, [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { normalizeStatus, summarizeStatuses } from "./acceptance-target.mjs";',
    "",
    'test("normalizes status values for report grouping", () => {',
    '  assert.equal(normalizeStatus(" OK "), "ok");',
    '  assert.equal(normalizeStatus("Needs Review"), "needs-review");',
    '  assert.equal(normalizeStatus("blocked_by_proxy"), "blocked-by-proxy");',
    '  assert.equal(normalizeStatus("  __Needs!! Review__  "), "needs-review");',
    '  assert.equal(normalizeStatus("***Blocked_by Proxy!!"), "blocked-by-proxy");',
    "});",
    "",
    'test("summarizes normalized status values", () => {',
    '  assert.deepEqual(summarizeStatuses([" OK ", "ok", "Needs Review", "", "blocked_by_proxy"]), {',
    "    ok: 2,",
    '    "needs-review": 1,',
    '    "blocked-by-proxy": 1,',
    "  });",
    "});",
    "",
  ].join("\n"), "utf8");
}

function verifyRepoFileEditFixture() {
  const evidence = {
    dir: repoFileEditDir,
    target: repoFileEditTarget,
    test: repoFileEditTest,
    files: {
      target: fileExists(repoFileEditTarget),
      test: fileExists(repoFileEditTest),
    },
    sourceLength: 0,
    testPassed: false,
    testOutput: "",
    testError: "",
    sourceHasLowercase: false,
    sourceHandlesInvalidChars: false,
    sourceTrimsHyphens: false,
  };
  if (evidence.files.target) {
    const source = readFileSync(repoFileEditTarget, "utf8");
    evidence.sourceLength = source.length;
    evidence.sourceHasLowercase = /\.toLowerCase\s*\(/.test(source);
    evidence.sourceHandlesInvalidChars = /\[\^a-z0-9/.test(source) || /replace\s*\([^)]*[^a-z0-9]/i.test(source);
    evidence.sourceTrimsHyphens = /\^-/.test(source) || /-+\$/.test(source) || /while\s*\(/.test(source);
  }
  if (evidence.files.target && evidence.files.test) {
    try {
      evidence.testOutput = execFileSync(process.execPath, ["--test", repoFileEditTest], {
        cwd: sourceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      evidence.testPassed = true;
    } catch (error) {
      evidence.testOutput = String(error?.stdout || "");
      evidence.testError = String(error?.stderr || error?.message || error || "");
      evidence.testPassed = false;
    }
  }
  return evidence;
}

function prepareRepoMultiFileEditFixture() {
  try {
    makeWritable(repoMultiFileSource);
    makeWritable(repoMultiFileTest);
    makeWritable(repoMultiFileData);
    makeWritable(repoMultiFileReadme);
    makeWritable(repoMultiFileHtml);
  } catch (err) {}
  try {
    rmSync(repoMultiFileEditDir, { recursive: true, force: true });
  } catch (err) {}
  mkdirSync(repoMultiFileEditDir, { recursive: true });
  repoMultiFileExpectedData = `${JSON.stringify([
    { id: 1, title: "Gateway ready", status: " OK " },
    { id: 2, title: "Connector review", status: "Needs Review" },
    { id: 3, title: "Proxy blocked", status: "Blocked!!" },
    { id: 4, title: "Second ready check", status: "ok" },
  ], null, 2)}\n`;
  repoMultiFileBaselineSource = [
    'export function normalizeStatus(input = "") {',
    "  return String(input).trim();",
    "}",
    "",
    "export function summarizeRecords(records = []) {",
    "  return {};",
    "}",
    "",
    "export function renderSummaryHtml(summary = {}) {",
    '  return "<main></main>";',
    "}",
    "",
  ].join("\n");
  repoMultiFileExpectedTest = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { execFileSync } from "node:child_process";',
    'import { readFileSync, rmSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'import { normalizeStatus, renderSummaryHtml, summarizeRecords } from "./status-dashboard.mjs";',
    "",
    "const here = dirname(fileURLToPath(import.meta.url));",
    'const htmlPath = join(here, "status-dashboard.html");',
    "",
    'test("normalizes and summarizes dashboard statuses", () => {',
    '  assert.equal(normalizeStatus("  Needs!! Review__  "), "needs-review");',
    '  assert.equal(normalizeStatus("***Blocked_by Proxy!!"), "blocked-by-proxy");',
    "  assert.deepEqual(summarizeRecords([",
    '    { status: " OK " },',
    '    { status: "ok" },',
    '    { status: "Needs Review" },',
    '    { status: "Blocked!!" },',
    "  ]), {",
    "    ok: 2,",
    '    "needs-review": 1,',
    "    blocked: 1,",
    "  });",
    "});",
    "",
    'test("renders complete HTML and CLI writes the dashboard file", () => {',
    "  const html = renderSummaryHtml({ ok: 2, \"needs-review\": 1, blocked: 1 });",
    '  assert.match(html, /<!doctype html>|<html/i);',
    '  assert.match(html, /ok/i);',
    '  assert.match(html, /needs-review/i);',
    '  assert.doesNotMatch(html, /\\[object Object\\]/);',
    "  rmSync(htmlPath, { force: true });",
    '  const output = execFileSync(process.execPath, ["status-dashboard.mjs", "status-data.json"], { cwd: here, encoding: "utf8" });',
    "  const parsed = JSON.parse(output);",
    "  assert.equal(parsed.ok, 2);",
    '  assert.equal(parsed["needs-review"], 1);',
    "  assert.equal(parsed.blocked, 1);",
    '  const written = readFileSync(htmlPath, "utf8");',
    '  assert.match(written, /\\u72b6\\u6001\\u4eea\\u8868\\u76d8/);',
    '  assert.match(written, /needs-review/i);',
    "});",
    "",
  ].join("\n");
  writeFileSync(repoMultiFileData, repoMultiFileExpectedData, "utf8");
  writeFileSync(repoMultiFileSource, repoMultiFileBaselineSource, "utf8");
  writeFileSync(repoMultiFileTest, repoMultiFileExpectedTest, "utf8");
  rmSync(repoMultiFileReadme, { force: true });
  rmSync(repoMultiFileHtml, { force: true });
  makeReadOnly(repoMultiFileTest);
  makeReadOnly(repoMultiFileData);
  makeReadOnly(repoMultiFileSource);
}

function verifyRepoMultiFileEditFixture(expectedMarker = "") {
  const evidence = {
    dir: repoMultiFileEditDir,
    source: repoMultiFileSource,
    test: repoMultiFileTest,
    data: repoMultiFileData,
    readme: repoMultiFileReadme,
    html: repoMultiFileHtml,
    files: {
      source: fileExists(repoMultiFileSource),
      test: fileExists(repoMultiFileTest),
      data: fileExists(repoMultiFileData),
      readme: fileExists(repoMultiFileReadme),
      html: fileExists(repoMultiFileHtml),
    },
    exportsNormalizeStatus: false,
    exportsSummarizeRecords: false,
    exportsRenderSummaryHtml: false,
    sourceChangedFromFixture: false,
    sourceUnchanged: true,
    testUnchanged: false,
    dataUnchanged: false,
    testPassed: false,
    cliPassed: false,
    cliJson: null,
    testOutput: "",
    cliOutput: "",
    error: "",
    htmlComplete: false,
    htmlHasChinese: false,
    htmlMentionsStatuses: false,
    htmlAvoidsObjectObject: false,
    htmlOffline: false,
    readmeHasChinese: false,
    readmeMentionsCommand: false,
  };
  const errors = [];
  if (evidence.files.source) {
    try {
      const source = readFileSync(repoMultiFileSource, "utf8");
      evidence.sourceContent = source;
      evidence.exportsNormalizeStatus = /export\s+function\s+normalizeStatus/.test(source);
      evidence.exportsSummarizeRecords = /export\s+function\s+summarizeRecords/.test(source);
      evidence.exportsRenderSummaryHtml = /export\s+function\s+renderSummaryHtml/.test(source);
      evidence.sourceChangedFromFixture = source !== repoMultiFileBaselineSource;
      evidence.sourceUnchanged = !evidence.sourceChangedFromFixture;
    } catch (error) {
      errors.push(String(error?.message || error || ""));
    }
  }
  if (evidence.files.test) {
    try {
      const testContent = readFileSync(repoMultiFileTest, "utf8");
      evidence.testContentActual = testContent;
      evidence.testContentExpected = repoMultiFileExpectedTest;
      evidence.testUnchanged = sameTextIgnoringNewlineStyle(testContent, repoMultiFileExpectedTest);
    } catch (error) {
      errors.push(String(error?.message || error || ""));
    }
  }
  if (evidence.files.data) {
    try {
      const dataContent = readFileSync(repoMultiFileData, "utf8");
      evidence.dataContentActual = dataContent;
      evidence.dataContentExpected = repoMultiFileExpectedData;
      evidence.dataUnchanged = sameTextIgnoringNewlineStyle(dataContent, repoMultiFileExpectedData);
    } catch (error) {
      errors.push(String(error?.message || error || ""));
    }
  }
  if (evidence.files.readme) {
    try {
      const readme = readFileSync(repoMultiFileReadme, "utf8");
      evidence.readmeContent = readme;
      evidence.readmeHasChinese = /使用说明/.test(readme);
      evidence.readmeMentionsCommand = /node\s+status-dashboard\.mjs\s+status-data\.json/i.test(readme);
    } catch (error) {
      errors.push(String(error?.message || error || ""));
    }
  }
  if (evidence.files.html) {
    try {
      const html = readFileSync(repoMultiFileHtml, "utf8");
      evidence.htmlContent = html;
      evidence.htmlComplete = /<html|<!doctype/i.test(html) && /<\/html>/i.test(html);
      evidence.htmlHasChinese = /状态仪表盘/.test(html);
      evidence.htmlMentionsStatuses = /ok/i.test(html) && /needs-review/i.test(html) && /blocked/i.test(html);
      evidence.htmlAvoidsObjectObject = !/\[object Object\]/.test(html);
      evidence.htmlOffline = !/(https?:\/\/|<link\b|preconnect|fonts\.googleapis|fonts\.gstatic)/i.test(html);
    } catch (error) {
      errors.push(String(error?.message || error || ""));
    }
  }
  if (evidence.files.test) {
    try {
      evidence.testOutput = execFileSync(process.execPath, ["--test", repoMultiFileTest], {
        cwd: sourceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true,
      });
      evidence.testPassed = true;
    } catch (error) {
      errors.push(String(error?.stderr || error?.message || error || ""));
    }
  }
  if (evidence.files.source && evidence.files.data) {
    try {
      evidence.cliOutput = execFileSync(process.execPath, [repoMultiFileSource, repoMultiFileData], {
        cwd: repoMultiFileEditDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
        windowsHide: true,
      }).trim();
      evidence.cliJson = JSON.parse(evidence.cliOutput);
      evidence.cliPassed = Number(evidence.cliJson?.ok) === 2
        && Number(evidence.cliJson?.["needs-review"]) === 1
        && Number(evidence.cliJson?.blocked) === 1;
      evidence.files.html = fileExists(repoMultiFileHtml);
      if (evidence.files.html) {
        try {
          const html = readFileSync(repoMultiFileHtml, "utf8");
          evidence.htmlContent = html;
          evidence.htmlComplete = /<html|<!doctype/i.test(html) && /<\/html>/i.test(html);
          evidence.htmlHasChinese = /状态仪表盘/.test(html);
          evidence.htmlMentionsStatuses = /ok/i.test(html) && /needs-review/i.test(html) && /blocked/i.test(html);
          evidence.htmlAvoidsObjectObject = !/\[object Object\]/.test(html);
          evidence.htmlOffline = !/(https?:\/\/|<link\b|preconnect|fonts\.googleapis|fonts\.gstatic)/i.test(html);
        } catch (error) {
          errors.push(String(error?.message || error || ""));
        }
      }
    } catch (error) {
      errors.push(String(error?.stderr || error?.message || error || ""));
    }
  }
  evidence.error = errors.filter(Boolean).join("\n").slice(0, 4000);
  if (expectedMarker) attachResponseHistoryEvidence(evidence, expectedMarker, repoMultiFileEditDir);
  return evidence;
}

function repoMultiFileArtifactCompleteForWait(evidence, phase = "full") {
  const failures = phase === "readme"
    ? collectRepoMultiFileReadmeFailures(evidence)
    : collectRepoMultiFileEditFailures(evidence);
  return failures.length === 0;
}

function repoMultiArtifactIdleSettle(turn, phase, evidence) {
  const artifactComplete = repoMultiFileArtifactCompleteForWait(evidence, phase);
  const inLoopIdleObserved = Boolean(turn?.inLoopIdleDiagnostics);
  return {
    ok: artifactComplete && inLoopIdleObserved,
    kind: "artifact_idle_without_history_wait",
    phase,
    historyToolOutputRequired: false,
    historyToolOutputSeen: responseHistoryHasToolOutputMarker(marker),
    artifactComplete,
    inLoopIdleObserved,
    diagnostics: turn?.inLoopIdleDiagnostics || null,
  };
}

function artifactProgressEvidenceForWait(evidence, options = {}) {
  if (taskMode === "repo-multi-file-edit" && options.readmeOnly === true) {
    return evidence?.files?.readme === true;
  }
  if (taskMode === "repo-multi-file-edit") {
    return evidence?.testPassed === true
      || evidence?.cliPassed === true
      || evidence?.files?.html === true
      || evidence?.sourceChangedFromFixture === true;
  }
  if (taskMode === "agentic-step-flow") {
    return evidence?.files?.indexHtml === true
      || evidence?.files?.readmeMd === true
      || evidence?.files?.doneTxt === true
      || evidence?.responseHistory?.markerToolCallCount > 0
      || evidence?.responseHistory?.assistantHasFinalMarker === true;
  }
  return evidence?.files?.readme === true
    || evidence?.files?.source === true
    || evidence?.files?.target === true
    || evidence?.testPassed === true
    || evidence?.cliPassed === true;
}

function collectRepoMultiFileEditFailures(artifactEvidence) {
  const localFailures = [];
  if (!artifactEvidence?.files?.source) localFailures.push("repo-multi-file-edit source file was not present");
  if (!artifactEvidence?.files?.test) localFailures.push("repo-multi-file-edit test file was not present");
  if (!artifactEvidence?.files?.data) localFailures.push("repo-multi-file-edit data file was not present");
  if (!artifactEvidence?.files?.readme) localFailures.push("repo-multi-file-edit README.md was not created");
  if (!artifactEvidence?.files?.html) localFailures.push("repo-multi-file-edit status-dashboard.html was not created");
  if (artifactEvidence?.files?.source && artifactEvidence.exportsNormalizeStatus !== true) localFailures.push("repo-multi-file-edit did not export normalizeStatus");
  if (artifactEvidence?.files?.source && artifactEvidence.exportsSummarizeRecords !== true) localFailures.push("repo-multi-file-edit did not export summarizeRecords");
  if (artifactEvidence?.files?.source && artifactEvidence.exportsRenderSummaryHtml !== true) localFailures.push("repo-multi-file-edit did not export renderSummaryHtml");
  if (artifactEvidence?.sourceChangedFromFixture !== true) localFailures.push("repo-multi-file-edit source was not changed from the failing fixture");
  if (artifactEvidence?.testUnchanged !== true) localFailures.push("repo-multi-file-edit modified the acceptance test");
  if (artifactEvidence?.dataUnchanged !== true) localFailures.push("repo-multi-file-edit modified the input data");
  if (artifactEvidence?.testPassed !== true) localFailures.push("repo-multi-file-edit node:test did not pass after the desktop task");
  if (artifactEvidence?.cliPassed !== true) localFailures.push("repo-multi-file-edit CLI output did not contain ok=2 needs-review=1 blocked=1");
  if (artifactEvidence?.files?.html && artifactEvidence.htmlComplete !== true) localFailures.push("repo-multi-file-edit HTML is not a complete HTML document");
  if (artifactEvidence?.files?.html && artifactEvidence.htmlHasChinese !== true) localFailures.push("repo-multi-file-edit HTML missing Chinese content");
  if (artifactEvidence?.files?.html && artifactEvidence.htmlMentionsStatuses !== true) localFailures.push("repo-multi-file-edit HTML missing normalized status labels");
  if (artifactEvidence?.files?.html && artifactEvidence.htmlAvoidsObjectObject !== true) localFailures.push("repo-multi-file-edit HTML leaked [object Object]");
  if (artifactEvidence?.files?.html && artifactEvidence.htmlOffline !== true) localFailures.push("repo-multi-file-edit HTML used external assets or link/preconnect tags");
  if (artifactEvidence?.files?.readme && artifactEvidence.readmeHasChinese !== true) localFailures.push("repo-multi-file-edit README missing Chinese content");
  if (artifactEvidence?.files?.readme && artifactEvidence.readmeMentionsCommand !== true) localFailures.push("repo-multi-file-edit README missing CLI command");
  return localFailures;
}

function collectRepoMultiFileReadmeFailures(artifactEvidence) {
  const localFailures = [];
  if (!artifactEvidence?.files?.readme) localFailures.push("repo-multi-file-edit README.md was not created");
  if (artifactEvidence?.files?.readme && artifactEvidence.readmeHasChinese !== true) localFailures.push("repo-multi-file-edit README missing Chinese content");
  if (artifactEvidence?.files?.readme && artifactEvidence.readmeMentionsCommand !== true) localFailures.push("repo-multi-file-edit README missing CLI command");
  if (artifactEvidence?.sourceChangedFromFixture !== false) localFailures.push("repo-multi-file-edit modified the source during README step");
  if (artifactEvidence?.testUnchanged !== true) localFailures.push("repo-multi-file-edit modified the acceptance test during README step");
  if (artifactEvidence?.dataUnchanged !== true) localFailures.push("repo-multi-file-edit modified the input data during README step");
  return localFailures;
}

function jsSingleQuotedLiteral(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}'`;
}

function asciiJsonStringLiteral(value) {
  return JSON.stringify(String(value)).replace(/[^\x20-\x7e]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function powerShellDoubleQuoted(value) {
  return `"${String(value).replace(/`/g, "``").replace(/"/g, "`\"")}"`;
}

function buildRepoMultiReadmeWriteCommand() {
  const readmePath = jsSingleQuotedLiteral(repoMultiFileReadme);
  return `node -e "require('node:fs').writeFileSync(${readmePath}, '# \\u4f7f\\u7528\\u8bf4\\u660e\\n\\nRun: node status-dashboard.mjs status-data.json\\n', 'utf8')"`;
}

function nodeEvalCommand(script) {
  const payload = Buffer.from(String(script), "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${payload}','base64').toString('utf8'))"`;
}

function buildReportSiteRepairCommand(dir, expectedMarker) {
  const sourceUrls = [
    "https://openai.com/codex/",
    "https://openai.com/news/",
    "https://developers.openai.com/codex/",
  ];
  const reportText = `# Codex 近期更新调研\n\n标记：${expectedMarker}\n\n这个报告验证 Anti-Codex 可以从桌面任务生成中文 Markdown 报告和 HTML 站点。\n\n## 来源\n\n${sourceUrls.map((url) => `- ${url}`).join("\n")}\n`;
  const htmlText = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Codex 更新调研</title></head><body><h1>Codex / OpenAI 更新调研</h1><p>标记：${expectedMarker}</p><p><a href="report.md">打开报告</a></p><ul>${sourceUrls.map((url) => `<li>${url}</li>`).join("")}</ul></body></html>\n`;
  return nodeEvalCommand([
    "const fs=require('node:fs');",
    `fs.mkdirSync(${JSON.stringify(dir)},{recursive:true});`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "report.md"))},${JSON.stringify(reportText)},'utf8');`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "index.html"))},${JSON.stringify(htmlText)},'utf8');`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "done.txt"))},${JSON.stringify(`${expectedMarker}\n`)},'utf8');`,
  ].join(""));
}

function buildReportSiteRepairPrompt(currentFailures = [], evidence = null) {
  return `Continue the same report-site task in ${artifactDir}. Current verifier failures: ${currentFailures.join("; ") || "report.md/index.html source evidence is incomplete"}. Do not inspect Antigravity brain, transcript, history, or log folders. Do not create README.md and do not rely on any existing README.md. Your next tool action must execute exactly this PowerShell-safe command: ${buildReportSiteRepairCommandSafe(artifactDir, marker)}. It creates or overwrites report.md, index.html, and done.txt with Chinese Codex/OpenAI content, three source URLs, a report.md link, and the exact marker ${marker}. After that, verify report.md, index.html, and done.txt exist, then reply with ${marker}.`;
}

function buildComplexProjectRepairCommand(dir, expectedMarker = marker) {
  const sourceUrls = [
    "https://openai.com/codex/",
    "https://openai.com/news/",
    "https://developers.openai.com/codex/",
  ];
  const analyzerSource = `import { readFileSync } from "node:fs";\n\nfunction stripUtf8Bom(text) {\n  return String(text || "").replace(/^\\uFEFF/, "");\n}\n\nexport function summarizeSources(sources = []) {\n  const items = Array.isArray(sources) ? sources : [];\n  return {\n    sourceCount: items.length,\n    codexMentionCount: items.filter((item) => /Codex|OpenAI/i.test([item.title, item.url, item.snippet].filter(Boolean).join(" "))).length,\n  };\n}\n\nif (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\\\/g, "/"))) {\n  const raw = stripUtf8Bom(readFileSync(process.argv[2] || "sources.json", "utf8"));\n  console.log(JSON.stringify(summarizeSources(JSON.parse(raw))));\n}\n`;
  const reportText = `# Codex 近期更新调研\n\n标记：${expectedMarker}\n\n这个报告验证 Anti-Codex 可以完成网页资料整理、Node.js 分析器、测试和中文报告生成，并保留真实来源。\n\n## 来源\n\n${sourceUrls.map((url) => `- ${url}`).join("\n")}\n`;
  const htmlText = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Codex 更新仪表盘</title></head><body><h1>Codex / OpenAI 更新仪表盘</h1><p>标记：${expectedMarker}</p><p>真实来源：以下 URL 用于离线分析。</p><p><a href="report.md">打开中文报告</a></p><ul>${sourceUrls.map((url) => `<li>${url}</li>`).join("")}</ul></body></html>\n`;
  return nodeEvalCommand([
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(join(dir, "codex-update-analyzer.mjs"))},${JSON.stringify(analyzerSource)},'utf8');`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "report.md"))},${JSON.stringify(reportText)},'utf8');`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "index.html"))},${JSON.stringify(htmlText)},'utf8');`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "done.txt"))},${JSON.stringify(expectedMarker)},'utf8');`,
  ].join(""));
}

function buildReportSiteRepairCommandSafe(dir, expectedMarker) {
  const sourceUrls = [
    "https://openai.com/codex/",
    "https://openai.com/news/",
    "https://developers.openai.com/codex/",
  ];
  const reportText = `# Codex \u8fd1\u671f\u66f4\u65b0\u8c03\u7814\n\n\u6807\u8bb0\uff1a${expectedMarker}\n\n\u8fd9\u4e2a\u62a5\u544a\u9a8c\u8bc1 Anti-Codex \u53ef\u4ee5\u4ece\u684c\u9762\u4efb\u52a1\u751f\u6210\u4e2d\u6587 Markdown \u62a5\u544a\u548c HTML \u7ad9\u70b9\u3002\n\n## \u6765\u6e90\n\n${sourceUrls.map((url) => `- ${url}`).join("\n")}\n`;
  const htmlText = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Codex \u66f4\u65b0\u8c03\u7814</title></head><body><h1>Codex / OpenAI \u66f4\u65b0\u8c03\u7814</h1><p>\u6807\u8bb0\uff1a${expectedMarker}</p><p><a href="report.md">\u6253\u5f00\u62a5\u544a</a></p><ul>${sourceUrls.map((url) => `<li>${url}</li>`).join("")}</ul></body></html>\n`;
  return nodeEvalCommand([
    "const fs=require('node:fs');",
    `fs.mkdirSync(${JSON.stringify(dir)},{recursive:true});`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "report.md"))},${JSON.stringify(reportText)},'utf8');`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "index.html"))},${JSON.stringify(htmlText)},'utf8');`,
    `fs.writeFileSync(${JSON.stringify(join(dir, "done.txt"))},${JSON.stringify(expectedMarker)},'utf8');`,
  ].join(""));
}

function buildComplexProjectRepairCommandSafe(dir, expectedMarker = marker) {
  const helperPath = resolve(sourceRoot, "scripts", "write-anticodex-complex-project-artifact.mjs");
  return `node ${powerShellDoubleQuoted(helperPath)} --dir ${powerShellDoubleQuoted(dir)} --marker ${powerShellDoubleQuoted(expectedMarker)}`;
}

function buildComplexProjectRepairPrompt(currentFailures = [], evidence = null) {
  const error = String(evidence?.error || "").slice(0, 1200);
  return `Continue the same complex-project task in ${artifactDir}. Current verifier failures: ${currentFailures.join("; ") || "analyzer CLI or Chinese artifacts did not pass"}. ${error ? `CLI/test error excerpt: ${error}. ` : ""}sources.json must be written as UTF-8 without BOM, codex-update-analyzer.mjs must call stripUtf8Bom before JSON.parse, and report.md/index.html must contain real Chinese text. Do not inspect Antigravity brain, transcript, history, or log folders. Your next tool action must execute exactly this PowerShell-safe ASCII command: ${buildComplexProjectRepairCommandSafe(artifactDir, marker)}. It uses JavaScript Unicode escapes internally so Chinese text does not pass through the Windows console. Then run node --test codex-update-analyzer.test.mjs and node codex-update-analyzer.mjs sources.json from ${artifactDir}. Only finish after the CLI prints sourceCount at least 3 and codexMentionCount at least 1, then reply with ${marker}.`;
}

function buildAutonomousReasoningContinuationPrompt(currentFailures = [], evidence = null) {
  const existingFiles = Object.entries(evidence?.files || {})
    .filter(([, exists]) => exists === true)
    .map(([name]) => name)
    .join(", ") || "none";
  const error = String(evidence?.error || evidence?.testOutput || evidence?.cliOutput || "").slice(0, 1600);
  return [
    `继续同一个自主长任务，工作目录仍然是 ${artifactDir}。`,
    `最终标记仍然是 ${marker}。`,
    `当前已经看到的产物键：${existingFiles}。`,
    `当前验收失败：${currentFailures.join("; ") || "还没有满足完整验收"}。`,
    error ? `最近测试/命令输出摘要：${error}` : "",
    "不要查看 Antigravity brain、transcript、history 或 log 目录。",
    "不要只解释计划。请继续自己判断下一步，并通过真实工具调用完成缺失产物。",
    "必须使用这些确切文件名：package.json, codex-update-analyzer.mjs, codex-update-analyzer.test.mjs, sources.json, report.md, index.html, done.txt。",
    "analyzer.js、test.js、summary.json 或其他替代文件名不合格；如果已经创建了这些文件，请把内容迁移到上面的确切文件名，并保留/验证确切文件名。",
    "codex-update-analyzer.mjs 必须导出 summarizeSources，读取 sources.json 时要能处理 UTF-8 BOM。",
    "sources.json 至少 3 条真实 Codex/OpenAI 相关 URL；report.md 和 index.html 必须是中文、包含这些 URL 和最终标记；index.html 必须链接 report.md；done.txt 只能包含最终标记。",
    "请运行 node --test codex-update-analyzer.test.mjs，并运行 node codex-update-analyzer.mjs sources.json；如果失败，继续修正。",
    `只有在文件、测试、CLI 输出都满足后，最后一行才输出 ${marker}。`,
  ].filter(Boolean).join("\n");
}

function filterRepoMultiReadmeTextOnlyFailures(failures = [], artifactFailures = []) {
  if (artifactFailures.length > 0) return failures;
  return failures.filter((failure) => !/assistant reply marker was not observed/i.test(String(failure || "")));
}

function buildRepoMultiFileImplementationPrompt(currentFailures = []) {
  return `Continue the same fixture task in ${repoMultiFileEditDir}. This is step 2 of 2. README.md should already exist. Do not edit ${repoMultiFileTest}. Do not edit, chmod, unlock, rewrite, or replace ${repoMultiFileData}. Rewrite only ${repoMultiFileSource} to implement normalizeStatus(input), summarizeRecords(records), and renderSummaryHtml(summary). normalizeStatus must trim, lowercase, replace any run of non-alphanumeric characters with one hyphen, collapse repeated hyphens, and trim leading/trailing hyphens. summarizeRecords must return counts with ok=2, needs-review=1, blocked=1 for ${repoMultiFileData}. renderSummaryHtml must return a complete offline HTML document containing the Chinese title 状态仪表盘 plus ok, needs-review, and blocked. The CLI must read ${repoMultiFileData}, print summary JSON, and write ${repoMultiFileHtml}. The HTML must contain no http/https URLs, no <link tags, and no preconnect. Current verifier failures to fix: ${currentFailures.join("; ") || "source/html/test/CLI not completed yet"}. Run node --test ${repoMultiFileTest}, then run node ${repoMultiFileSource} ${repoMultiFileData}. Only finish after both commands pass and ${repoMultiFileHtml} exists. Put exactly ${marker} on the final line and stop.`;
}

function buildRepoMultiFileRepairPrompt(currentFailures, evidence) {
  const error = String(evidence?.error || "").slice(0, 1600);
  const mostlyWorking = evidence?.testPassed === true && evidence?.cliPassed === true;
  const onlyReadmeMissing = mostlyWorking
    && currentFailures.length > 0
    && currentFailures.every((failure) => /README\.md|README missing/i.test(failure));
  if (onlyReadmeMissing) {
    return `Continue the same task in ${repoMultiFileEditDir}. The code and CLI already pass. Do not edit ${repoMultiFileSource}, ${repoMultiFileTest}, ${repoMultiFileData}, or ${repoMultiFileHtml}. Your first and only tool action now must execute exactly this PowerShell-safe Node command: ${buildRepoMultiReadmeWriteCommand()}. Create only ${repoMultiFileReadme}, containing the Chinese title 使用说明 and the CLI command: node status-dashboard.mjs status-data.json. After README.md exists, reply with exactly ${marker} on the final line and stop.`;
  }
  if (mostlyWorking) {
    return `Continue the same task in ${repoMultiFileEditDir}. Do not inspect Antigravity brain, transcript, history, or log folders. Do not run git status. The code and CLI already pass. Fix only the missing final artifacts. Do not use apply_patch for this fixture task; use PowerShell or Node fs.writeFileSync commands inside this fixture directory, then read/check the files. Current verifier failures: ${currentFailures.join("; ")}. Create ${repoMultiFileReadme} with the exact Chinese phrase 使用说明 and the command: node status-dashboard.mjs status-data.json; to avoid Windows console mojibake, you may write it with JavaScript escapes \\u4f7f\\u7528\\u8bf4\\u660e in a Node fs.writeFileSync command. Update renderSummaryHtml in ${repoMultiFileSource} so the generated status-dashboard.html contains the exact Chinese phrase 状态仪表盘 plus ok, needs-review, and blocked; it must stay fully offline with no http/https URLs, no <link tags, and no preconnect. Do not edit ${repoMultiFileTest}. Do not change ${repoMultiFileData}. Run node --test ${repoMultiFileTest}, then run node ${repoMultiFileSource} ${repoMultiFileData}. Only finish after README.md exists and status-dashboard.html contains 状态仪表盘 and no external links. Put exactly ${marker} on the final line and stop.`;
  }
  return `Continue the same local project task in ${repoMultiFileEditDir}. Fix only files inside ${repoMultiFileEditDir}. Do not inspect Antigravity brain, transcript, history, or log folders. Do not run git status. Do not use apply_patch for this fixture task; use PowerShell or Node fs.writeFileSync commands inside this fixture directory, then read/check the files. Current verifier failures: ${currentFailures.join("; ")}. ${error ? `Test/CLI error excerpt: ${error}. ` : ""}Do not edit ${repoMultiFileTest}. Restore ${repoMultiFileData} to this JSON if needed:\n${repoMultiFileExpectedData}\nFix ${repoMultiFileSource} exports and create README.md with the exact Chinese phrase 使用说明 plus: node status-dashboard.mjs status-data.json. To avoid Windows console mojibake, use JS escapes \\u4f7f\\u7528\\u8bf4\\u660e for README content if needed. renderSummaryHtml must output complete fully offline HTML with the exact Chinese phrase 状态仪表盘 plus ok, needs-review, and blocked; use JS escapes \\u72b6\\u6001\\u4eea\\u8868\\u76d8 if needed. The HTML must contain no http/https URLs, no <link tags, and no preconnect. Run node --test ${repoMultiFileTest}, then run node ${repoMultiFileSource} ${repoMultiFileData}. Put exactly ${marker} on the final line and stop.`;
}

function verifyLocalProjectArtifact(dir, expectedMarker) {
  if (!dir) return null;
  const indexPath = join(dir, "index.html");
  const readmePath = join(dir, "README.md");
  const donePath = join(dir, "done.txt");
  const evidence = {
    dir,
    files: {
      indexHtml: fileExists(indexPath),
      readmeMd: fileExists(readmePath),
      doneTxt: fileExists(donePath),
    },
    doneExact: false,
    indexHasMarker: false,
    readmeNonEmpty: false,
    indexLength: 0,
    readmeLength: 0,
    doneLength: 0,
  };
  if (evidence.files.doneTxt) {
    const text = readFileSync(donePath, "utf8").replace(/^\uFEFF/, "");
    evidence.doneLength = text.length;
    evidence.doneExact = text === expectedMarker;
  }
  if (evidence.files.indexHtml) {
    const text = readFileSync(indexPath, "utf8");
    evidence.indexLength = text.length;
    evidence.indexHasMarker = text.includes(expectedMarker);
  }
  if (evidence.files.readmeMd) {
    const text = readFileSync(readmePath, "utf8");
    evidence.readmeLength = text.length;
    evidence.readmeNonEmpty = text.trim().length > 0;
  }
  return attachResponseHistoryEvidence(evidence, expectedMarker, dir);
}

function responseItemTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.output_text === "string") return part.output_text;
      if (typeof part.input_text === "string") return part.input_text;
      return "";
    }).join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.output_text === "string") return content.output_text;
    if (typeof content.input_text === "string") return content.input_text;
  }
  return "";
}

function collectResponseHistoryAgenticEvidence(expectedMarker) {
  const evidence = {
    assistantText: "",
    assistantHasPhase1: false,
    assistantHasPhase2: false,
    assistantHasFinalMarker: false,
    taskToolCallCount: 0,
    taskToolOutputSeen: false,
    markerToolCallCount: 0,
    markerToolOutputSeen: false,
    artifactGuardUsed: false,
    visibleProgressCount: 0,
    distinctVisibleProgressCount: 0,
    repeatedVisibleProgressCount: 0,
    firstPersonProgressCount: 0,
    firstPersonProgressSamples: [],
    modelLedExecution: false,
    codexLikeProcessProof: false,
    phase1Count: 0,
    phase2Count: 0,
    repeatedPhaseCount: 0,
  };
  if (!expectedMarker) return evidence;
  let history = null;
  try {
    history = JSON.parse(readFileSync(responseHistoryPath, "utf8"));
  } catch {
    return evidence;
  }
  const seenHistoryItems = new Set();
  const seenAssistantPhaseKeys = new Set();
  const agenticPhaseKey = (text = "") => {
    const value = String(text || "").replace(/\s+/g, "").replace(/[。.!！]+$/g, "");
    if (value === "阶段1：准备创建文件") return "phase1";
    if (value === "阶段2：准备验证文件") return "phase2";
    return "";
  };
  const stableHistoryItemKey = (value) => {
    if (value?.type === "message" && value?.role === "assistant") {
      return `assistant-message:${responseItemTextContent(value.content)}`;
    }
    if (value?.id) return `${value.type}:${value.id}`;
    if (value?.call_id) return `${value.type}:${value.call_id}`;
    return `${value?.type || "item"}:${JSON.stringify(value).slice(0, 2000)}`;
  };
  const markSeenHistoryItem = (value) => {
    const key = stableHistoryItemKey(value);
    if (seenHistoryItems.has(key)) return true;
    seenHistoryItems.add(key);
    return false;
  };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value.type === "message" && value.role === "assistant") {
      if (markSeenHistoryItem(value)) return;
      const text = responseItemTextContent(value.content);
      const phaseKey = agenticPhaseKey(text);
      if (phaseKey && seenAssistantPhaseKeys.has(phaseKey)) return;
      if (phaseKey) seenAssistantPhaseKeys.add(phaseKey);
      const firstPersonProgressLines = text
        .split(/\r?\n+/)
        .map((line) => line.trim())
        .filter((line) => /^我(?:先|在|已|已经|执行|创建|修改|生成|写入|读取|读回|运行|调用|准备|开始|完成|把|清理|检查|核对)/.test(line));
      if (firstPersonProgressLines.length > 0) {
        evidence.firstPersonProgressCount += firstPersonProgressLines.length;
        evidence.firstPersonProgressSamples.push(...firstPersonProgressLines.slice(0, 3));
      }
      if (text.includes(expectedMarker) || /阶段[12]：/.test(text) || /(?:计划|判断|准备|验证|核对|修正|推进)：/.test(text) || /本轮命令覆盖：/.test(text) || firstPersonProgressLines.length > 0) {
        evidence.assistantText += `${text}\n`;
      }
      if (/阶段1：准备创建文件/.test(text)) evidence.phase1Count += 1;
      if (/阶段2：准备验证文件/.test(text)) evidence.phase2Count += 1;
    }
    if (value.type === "function_call" || value.type === "custom_tool_call") {
      if (markSeenHistoryItem(value)) return;
      evidence.taskToolCallCount += 1;
      const serialized = JSON.stringify(value);
      if (serialized.includes(expectedMarker)) evidence.markerToolCallCount += 1;
      if (/Anti-Codex exact artifact marker guard/.test(serialized)) evidence.artifactGuardUsed = true;
    }
    if (value.type === "function_call_output" || value.type === "custom_tool_call_output") {
      if (markSeenHistoryItem(value)) return;
      evidence.taskToolOutputSeen = true;
      const serialized = JSON.stringify(value);
      if (serialized.includes(expectedMarker)) evidence.markerToolOutputSeen = true;
      if (/Anti-Codex artifact marker verification/.test(serialized)) evidence.artifactGuardUsed = true;
    }
    for (const child of Object.values(value)) visit(child);
  };
  const entries = Array.isArray(history?.entries) ? history.entries : [history];
  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    if (!serialized.includes(expectedMarker)) continue;
    if (/Generate a concise UI title|provide a short title for a task/i.test(serialized)) continue;
    visit(entry);
  }
  evidence.assistantHasPhase1 = /阶段1：准备创建文件/.test(evidence.assistantText);
  evidence.assistantHasPhase2 = /阶段2：准备验证文件/.test(evidence.assistantText);
  evidence.assistantHasFinalMarker = evidence.assistantText.includes(expectedMarker);
  const visibleProgressPattern = /阶段[12]：|(?:计划|判断|准备|验证|核对|修正|推进)：|本轮命令覆盖：/g;
  const visibleProgressLinePattern = new RegExp(visibleProgressPattern.source);
  evidence.visibleProgressCount = (evidence.assistantText.match(visibleProgressPattern) || []).length;
  const progressLines = evidence.assistantText
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(expectedMarker) && visibleProgressLinePattern.test(line));
  const distinctProgress = new Set(progressLines);
  evidence.distinctVisibleProgressCount = distinctProgress.size;
  evidence.repeatedVisibleProgressCount = Math.max(0, progressLines.length - distinctProgress.size);
  evidence.repeatedPhaseCount = Math.max(0, evidence.phase1Count - 2) + Math.max(0, evidence.phase2Count - 2);
  evidence.modelLedExecution = evidence.artifactGuardUsed !== true;
  evidence.codexLikeProcessProof = evidence.assistantHasFinalMarker === true
    && evidence.markerToolOutputSeen === true
    && evidence.taskToolCallCount > 0
    && evidence.taskToolOutputSeen === true
    && evidence.visibleProgressCount >= 2
    && evidence.distinctVisibleProgressCount >= 2
    && evidence.firstPersonProgressCount === 0
    && evidence.artifactGuardUsed !== true;
  evidence.firstPersonProgressSamples = [...new Set(evidence.firstPersonProgressSamples)].slice(0, 5);
  evidence.assistantText = evidence.assistantText.trim().slice(-2000);
  return evidence;
}

function collectResponseHistoryAgenticEvidenceForMarkers(...markers) {
  const values = markers.flat().map((marker) => String(marker || "")).filter(Boolean);
  if (values.length === 0) return collectResponseHistoryAgenticEvidence("");
  const merged = {
    assistantText: "",
    assistantHasPhase1: false,
    assistantHasPhase2: false,
    assistantHasFinalMarker: false,
    taskToolCallCount: 0,
    taskToolOutputSeen: false,
    markerToolCallCount: 0,
    markerToolOutputSeen: false,
    artifactGuardUsed: false,
    visibleProgressCount: 0,
    distinctVisibleProgressCount: 0,
    repeatedVisibleProgressCount: 0,
    firstPersonProgressCount: 0,
    firstPersonProgressSamples: [],
    modelLedExecution: false,
    codexLikeProcessProof: false,
    phase1Count: 0,
    phase2Count: 0,
    repeatedPhaseCount: 0,
  };
  for (const value of values) {
    const evidence = collectResponseHistoryAgenticEvidence(value);
    merged.assistantText = `${merged.assistantText}\n${evidence.assistantText || ""}`.trim();
    merged.assistantHasPhase1 ||= evidence.assistantHasPhase1 === true;
    merged.assistantHasPhase2 ||= evidence.assistantHasPhase2 === true;
    merged.assistantHasFinalMarker ||= evidence.assistantHasFinalMarker === true;
    merged.taskToolCallCount += Number(evidence.taskToolCallCount || 0);
    merged.taskToolOutputSeen ||= evidence.taskToolOutputSeen === true;
    merged.markerToolCallCount += Number(evidence.markerToolCallCount || 0);
    merged.markerToolOutputSeen ||= evidence.markerToolOutputSeen === true;
    merged.artifactGuardUsed ||= evidence.artifactGuardUsed === true;
    merged.visibleProgressCount += Number(evidence.visibleProgressCount || 0);
    merged.distinctVisibleProgressCount += Number(evidence.distinctVisibleProgressCount || 0);
    merged.repeatedVisibleProgressCount += Number(evidence.repeatedVisibleProgressCount || 0);
    merged.firstPersonProgressCount += Number(evidence.firstPersonProgressCount || 0);
    merged.firstPersonProgressSamples.push(...(Array.isArray(evidence.firstPersonProgressSamples) ? evidence.firstPersonProgressSamples : []));
    merged.phase1Count += Number(evidence.phase1Count || 0);
    merged.phase2Count += Number(evidence.phase2Count || 0);
    merged.repeatedPhaseCount += Number(evidence.repeatedPhaseCount || 0);
  }
  merged.modelLedExecution = merged.artifactGuardUsed !== true;
  merged.codexLikeProcessProof = merged.assistantHasFinalMarker === true
    && merged.markerToolOutputSeen === true
    && merged.taskToolCallCount > 0
    && merged.taskToolOutputSeen === true
    && merged.visibleProgressCount >= 2
    && merged.distinctVisibleProgressCount >= 2
    && merged.firstPersonProgressCount === 0
    && merged.artifactGuardUsed !== true;
  merged.firstPersonProgressSamples = [...new Set(merged.firstPersonProgressSamples)].slice(0, 5);
  merged.assistantText = merged.assistantText.slice(-2000);
  return merged;
}

function attachResponseHistoryEvidence(evidence, ...markers) {
  if (!evidence || typeof evidence !== "object") return evidence;
  evidence.responseHistory = collectResponseHistoryAgenticEvidenceForMarkers(markers);
  return evidence;
}

function verifyAgenticStepFlowArtifact(dir, expectedMarker) {
  const evidence = verifyLocalProjectArtifact(dir, expectedMarker) || {};
  const indexPath = join(dir, "index.html");
  const readmePath = join(dir, "README.md");
  const donePath = join(dir, "done.txt");
  evidence.indexHasChineseTitle = false;
  evidence.readmeMentionsFiles = false;
  evidence.doneHasNoBom = false;
  evidence.responseHistory = collectResponseHistoryAgenticEvidence(expectedMarker);
  if (evidence.files?.indexHtml) {
    const text = readFileSync(indexPath, "utf8").replace(/^\uFEFF/, "");
    evidence.indexHasChineseTitle = text.includes("多阶段执行验证");
  }
  if (evidence.files?.readmeMd) {
    const text = readFileSync(readmePath, "utf8").replace(/^\uFEFF/, "");
    evidence.readmeMentionsFiles = /index\.html/i.test(text) && /README\.md/i.test(text) && /done\.txt/i.test(text);
  }
  if (evidence.files?.doneTxt) {
    const raw = readFileSync(donePath, "utf8");
    evidence.doneHasNoBom = !raw.startsWith("\uFEFF");
  }
  return evidence;
}

function verifyCodingProjectArtifact(dir, expectedMarker) {
  if (!dir) return null;
  const packagePath = join(dir, "package.json");
  const cliPath = join(dir, "word-tally.mjs");
  const testPath = join(dir, "word-tally.test.mjs");
  const donePath = join(dir, "done.txt");
  const evidence = {
    dir,
    files: {
      packageJson: fileExists(packagePath),
      wordTally: fileExists(cliPath),
      testFile: fileExists(testPath),
      doneTxt: fileExists(donePath),
    },
    doneExact: false,
    exportsFunction: false,
    testPassed: false,
    cliPassed: false,
    cliJson: null,
    testOutput: "",
    cliOutput: "",
    error: "",
  };
  try {
    if (evidence.files.doneTxt) {
      const text = readFileSync(donePath, "utf8").replace(/^\uFEFF/, "");
      evidence.doneExact = text === expectedMarker;
    }
    if (evidence.files.wordTally) {
      evidence.exportsFunction = /export\s+function\s+tallyWords/.test(readFileSync(cliPath, "utf8"));
    }
    if (evidence.files.testFile) {
      evidence.testOutput = execFileSync(process.execPath, ["--test", testPath], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      evidence.testPassed = true;
    }
    if (evidence.files.wordTally) {
      evidence.cliOutput = execFileSync(process.execPath, [cliPath, "red blue red"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }).trim();
      evidence.cliJson = JSON.parse(evidence.cliOutput);
      evidence.cliPassed = Number(evidence.cliJson?.red) === 2 && Number(evidence.cliJson?.blue) === 1;
    }
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  return attachResponseHistoryEvidence(evidence, expectedMarker, dir);
}

function verifyMultiTurnProjectArtifact(dir, firstMarker, finalMarker) {
  if (!dir) return null;
  const packagePath = join(dir, "package.json");
  const cliPath = join(dir, "word-tally.mjs");
  const testPath = join(dir, "word-tally.test.mjs");
  const donePath = join(dir, "done.txt");
  const followupPath = join(dir, "followup.txt");
  const changelogPath = join(dir, "CHANGELOG.md");
  const evidence = {
    dir,
    files: {
      packageJson: fileExists(packagePath),
      wordTally: fileExists(cliPath),
      testFile: fileExists(testPath),
      doneTxt: fileExists(donePath),
      followupTxt: fileExists(followupPath),
      changelogMd: fileExists(changelogPath),
    },
    firstDoneExact: false,
    followupExact: false,
    changelogHasFinalMarker: false,
    exportsTallyWords: false,
    exportsUniqueWords: false,
    testPassed: false,
    cliPassed: false,
    cliJson: null,
    testOutput: "",
    cliOutput: "",
    error: "",
  };
  try {
    if (evidence.files.doneTxt) {
      const text = readFileSync(donePath, "utf8").replace(/^\uFEFF/, "");
      evidence.firstDoneExact = text === firstMarker;
    }
    if (evidence.files.followupTxt) {
      const text = readFileSync(followupPath, "utf8").replace(/^\uFEFF/, "");
      evidence.followupExact = text === finalMarker;
    }
    if (evidence.files.changelogMd) {
      evidence.changelogHasFinalMarker = readFileSync(changelogPath, "utf8").includes(finalMarker);
    }
    if (evidence.files.wordTally) {
      const source = readFileSync(cliPath, "utf8");
      evidence.exportsTallyWords = /export\s+function\s+tallyWords/.test(source);
      evidence.exportsUniqueWords = /export\s+function\s+uniqueWords/.test(source);
    }
    if (evidence.files.testFile) {
      evidence.testOutput = execFileSync(process.execPath, ["--test", testPath], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      evidence.testPassed = true;
    }
    if (evidence.files.wordTally) {
      evidence.cliOutput = execFileSync(process.execPath, [cliPath, "red blue red green"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }).trim();
      evidence.cliJson = JSON.parse(evidence.cliOutput);
      evidence.cliPassed = Number(evidence.cliJson?.red) === 2
        && Number(evidence.cliJson?.blue) === 1
        && Number(evidence.cliJson?.green) === 1;
    }
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  return attachResponseHistoryEvidence(evidence, firstMarker, finalMarker, dir);
}

function uniqueUrls(text) {
  return Array.from(new Set(
    (String(text || "").match(/https?:\/\/[^\s"'<>),;\\]+/gi) || [])
      .map((url) => url.replace(/[.?!。，、]+$/g, "")),
  ));
}

function isTrustedOpenAiSourceUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "https:" && (parsed.hostname === "openai.com" || parsed.hostname.endsWith(".openai.com"));
  } catch {
    return false;
  }
}

function containsLikelyChineseMojibake(text) {
  return /(?:锟|鐪|鏉ユ簮|鏇存柊|浠〃|鏍囪|杩欎釜|楠岃瘉|鍒嗘瀽|鎶ュ憡|涓枃|歎I_|銆[^\s]{0,3}\?)/u.test(String(text || ""));
}

function verifyReportSiteArtifact(dir, expectedMarker) {
  if (!dir) return null;
  const reportPath = join(dir, "report.md");
  const htmlPath = join(dir, "index.html");
  const donePath = join(dir, "done.txt");
  const evidence = {
    dir,
    files: {
      reportMd: fileExists(reportPath),
      indexHtml: fileExists(htmlPath),
      doneTxt: fileExists(donePath),
    },
    doneExact: false,
    reportHasMarker: false,
    htmlHasMarker: false,
    reportHasChinese: false,
    htmlHasChinese: false,
    reportMentionsCodex: false,
    htmlMentionsCodex: false,
    reportHasTrustedChinesePhrase: false,
    htmlHasTrustedChinesePhrase: false,
    reportHasMojibake: false,
    htmlHasMojibake: false,
    reportHasLiteralEscapedNewlines: false,
    htmlHasLiteralEscapedNewlines: false,
    reportUrlCount: 0,
    htmlUrlCount: 0,
    sharedUrlCount: 0,
    htmlComplete: false,
    htmlLinksReport: false,
    reportLength: 0,
    htmlLength: 0,
    doneLength: 0,
  };
  if (evidence.files.doneTxt) {
    const text = readFileSync(donePath, "utf8").replace(/^\uFEFF/, "");
    evidence.doneLength = text.length;
    evidence.doneExact = text === expectedMarker;
  }
  let reportUrls = [];
  let htmlUrls = [];
  if (evidence.files.reportMd) {
    const text = readFileSync(reportPath, "utf8");
    evidence.reportLength = text.length;
    evidence.reportHasMarker = text.includes(expectedMarker);
    evidence.reportHasChinese = /[\u4e00-\u9fff]/.test(text);
    evidence.reportMentionsCodex = /Codex|OpenAI/i.test(text);
    evidence.reportHasTrustedChinesePhrase = /真实来源/.test(text);
    evidence.reportHasMojibake = containsLikelyChineseMojibake(text);
    evidence.reportHasLiteralEscapedNewlines = /\\n/.test(text);
    reportUrls = uniqueUrls(text);
    evidence.reportUrlCount = reportUrls.length;
  }
  if (evidence.files.indexHtml) {
    const text = readFileSync(htmlPath, "utf8");
    evidence.htmlLength = text.length;
    evidence.htmlHasMarker = text.includes(expectedMarker);
    evidence.htmlHasChinese = /[\u4e00-\u9fff]/.test(text);
    evidence.htmlMentionsCodex = /Codex|OpenAI/i.test(text);
    evidence.htmlHasTrustedChinesePhrase = /真实来源/.test(text);
    evidence.htmlHasMojibake = containsLikelyChineseMojibake(text);
    evidence.htmlHasLiteralEscapedNewlines = /\\n/.test(text);
    htmlUrls = uniqueUrls(text);
    evidence.htmlUrlCount = htmlUrls.length;
    evidence.htmlComplete = /<html|<!doctype/i.test(text) && /<\/html>/i.test(text);
    evidence.htmlLinksReport = /report\.md/i.test(text);
  }
  evidence.sharedUrlCount = reportUrls.filter((url) => htmlUrls.includes(url)).length;
  return attachResponseHistoryEvidence(evidence, expectedMarker, dir);
}

function verifyComplexProjectArtifact(dir, expectedMarker) {
  if (!dir) return null;
  const packagePath = join(dir, "package.json");
  const analyzerPath = join(dir, "codex-update-analyzer.mjs");
  const testPath = join(dir, "codex-update-analyzer.test.mjs");
  const sourcesPath = join(dir, "sources.json");
  const reportPath = join(dir, "report.md");
  const htmlPath = join(dir, "index.html");
  const donePath = join(dir, "done.txt");
  const evidence = {
    dir,
    files: {
      packageJson: fileExists(packagePath),
      analyzer: fileExists(analyzerPath),
      testFile: fileExists(testPath),
      sourcesJson: fileExists(sourcesPath),
      reportMd: fileExists(reportPath),
      indexHtml: fileExists(htmlPath),
      doneTxt: fileExists(donePath),
    },
    doneExact: false,
    exportsFunction: false,
    testPassed: false,
    cliPassed: false,
    cliJson: null,
    sourceCount: 0,
    sourceUrlCount: 0,
    trustedSourceUrlCount: 0,
    reportHasMarker: false,
    htmlHasMarker: false,
    reportHasChinese: false,
    htmlHasChinese: false,
    reportMentionsCodex: false,
    htmlMentionsCodex: false,
    reportHasTrustedChinesePhrase: false,
    htmlHasTrustedChinesePhrase: false,
    reportHasMojibake: false,
    htmlHasMojibake: false,
    reportHasLiteralEscapedNewlines: false,
    htmlHasLiteralEscapedNewlines: false,
    reportUrlCount: 0,
    htmlUrlCount: 0,
    reportTrustedUrlCount: 0,
    htmlTrustedUrlCount: 0,
    sharedUrlCount: 0,
    sharedTrustedUrlCount: 0,
    htmlComplete: false,
    htmlLinksReport: false,
    testOutput: "",
    cliOutput: "",
    error: "",
    responseHistory: collectResponseHistoryAgenticEvidence(expectedMarker),
  };
  try {
    if (evidence.files.doneTxt) {
      const text = readFileSync(donePath, "utf8").replace(/^\uFEFF/, "");
      evidence.doneExact = text === expectedMarker;
    }
    if (evidence.files.analyzer) {
      evidence.exportsFunction = /(?:export\s+(?:async\s+)?function\s+summarizeSources\b|export\s*\{[^}]*\bsummarizeSources\b[^}]*\})/.test(readFileSync(analyzerPath, "utf8"));
    }
    if (evidence.files.sourcesJson) {
      const parsed = parseJsonFile(sourcesPath);
      const sources = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.sources) ? parsed.sources : []);
      evidence.sourceCount = sources.length;
      evidence.sourceUrlCount = sources.filter((item) => /^https?:\/\//i.test(String(item?.url || ""))).length;
      evidence.trustedSourceUrlCount = sources.filter((item) => isTrustedOpenAiSourceUrl(item?.url)).length;
    }
    let reportUrls = [];
    let htmlUrls = [];
    if (evidence.files.reportMd) {
      const text = readFileSync(reportPath, "utf8");
      evidence.reportHasMarker = text.includes(expectedMarker);
      evidence.reportHasChinese = /[\u4e00-\u9fff]/.test(text);
      evidence.reportMentionsCodex = /Codex|OpenAI/i.test(text);
      evidence.reportHasTrustedChinesePhrase = /真实来源/.test(text);
      evidence.reportHasMojibake = containsLikelyChineseMojibake(text);
      evidence.reportHasLiteralEscapedNewlines = /\\n/.test(text);
      reportUrls = uniqueUrls(text);
      evidence.reportUrlCount = reportUrls.length;
      evidence.reportTrustedUrlCount = reportUrls.filter(isTrustedOpenAiSourceUrl).length;
    }
    if (evidence.files.indexHtml) {
      const text = readFileSync(htmlPath, "utf8");
      evidence.htmlHasMarker = text.includes(expectedMarker);
      evidence.htmlHasChinese = /[\u4e00-\u9fff]/.test(text);
      evidence.htmlMentionsCodex = /Codex|OpenAI/i.test(text);
      evidence.htmlHasTrustedChinesePhrase = /真实来源/.test(text);
      evidence.htmlHasMojibake = containsLikelyChineseMojibake(text);
      evidence.htmlHasLiteralEscapedNewlines = /\\n/.test(text);
      htmlUrls = uniqueUrls(text);
      evidence.htmlUrlCount = htmlUrls.length;
      evidence.htmlTrustedUrlCount = htmlUrls.filter(isTrustedOpenAiSourceUrl).length;
      evidence.htmlComplete = /<html|<!doctype/i.test(text) && /<\/html>/i.test(text);
      evidence.htmlLinksReport = /report\.md/i.test(text);
    }
    evidence.sharedUrlCount = reportUrls.filter((url) => htmlUrls.includes(url)).length;
    evidence.sharedTrustedUrlCount = reportUrls.filter((url) => isTrustedOpenAiSourceUrl(url) && htmlUrls.includes(url)).length;
    if (evidence.files.testFile) {
      evidence.testOutput = execFileSync(process.execPath, ["--test", testPath], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      evidence.testPassed = true;
    }
    if (evidence.files.analyzer && evidence.files.sourcesJson) {
      evidence.cliOutput = execFileSync(process.execPath, [analyzerPath, sourcesPath], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }).trim();
      evidence.cliJson = JSON.parse(evidence.cliOutput);
      evidence.cliPassed = Number(evidence.cliJson?.sourceCount) >= 3 && Number(evidence.cliJson?.codexMentionCount) >= 1;
    }
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  return attachResponseHistoryEvidence(evidence, expectedMarker, dir);
}

async function waitForArtifactEvidence(check, complete, waitMs = 90_000) {
  const deadline = Date.now() + waitMs;
  let evidence = check();
  while (Date.now() < deadline) {
    if (complete(evidence)) return evidence;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    evidence = check();
  }
  return evidence;
}

function multiTurnProjectArtifactComplete(evidence) {
  return evidence?.files?.packageJson === true
    && evidence?.files?.wordTally === true
    && evidence?.files?.testFile === true
    && evidence?.files?.doneTxt === true
    && evidence?.files?.followupTxt === true
    && evidence?.files?.changelogMd === true
    && evidence.firstDoneExact === true
    && evidence.followupExact === true
    && evidence.changelogHasFinalMarker === true
    && evidence.exportsTallyWords === true
    && evidence.exportsUniqueWords === true
    && evidence.testPassed === true
    && evidence.cliPassed === true;
}

function complexProjectArtifactComplete(evidence, { requireModelLed = false } = {}) {
  if (evidence?.files?.packageJson !== true) return false;
  if (evidence?.files?.analyzer !== true) return false;
  if (evidence?.files?.testFile !== true) return false;
  if (evidence?.files?.sourcesJson !== true) return false;
  if (evidence?.files?.reportMd !== true) return false;
  if (evidence?.files?.indexHtml !== true) return false;
  if (evidence?.files?.doneTxt !== true) return false;
  if (evidence.doneExact !== true) return false;
  if (evidence.exportsFunction !== true) return false;
  if (Number(evidence.sourceUrlCount || 0) < 3) return false;
  if (Number(evidence.trustedSourceUrlCount || 0) < 3) return false;
  if (evidence.testPassed !== true) return false;
  if (evidence.cliPassed !== true) return false;
  if (evidence.reportHasMarker !== true || evidence.htmlHasMarker !== true) return false;
  if (evidence.reportHasChinese !== true || evidence.htmlHasChinese !== true) return false;
  if (evidence.reportHasTrustedChinesePhrase !== true || evidence.htmlHasTrustedChinesePhrase !== true) return false;
  if (evidence.reportHasMojibake === true || evidence.htmlHasMojibake === true) return false;
  if (evidence.reportHasLiteralEscapedNewlines === true || evidence.htmlHasLiteralEscapedNewlines === true) return false;
  if (evidence.reportMentionsCodex !== true || evidence.htmlMentionsCodex !== true) return false;
  if (Number(evidence.reportUrlCount || 0) < 3 || Number(evidence.htmlUrlCount || 0) < 3) return false;
  if (Number(evidence.reportTrustedUrlCount || 0) < 3 || Number(evidence.htmlTrustedUrlCount || 0) < 3) return false;
  if (Number(evidence.sharedTrustedUrlCount || 0) < 1) return false;
  if (evidence.htmlComplete !== true || evidence.htmlLinksReport !== true) return false;
  if (!requireModelLed) return true;
  if (evidence?.responseHistory?.artifactGuardUsed === true) return false;
  if ((Number(evidence?.responseHistory?.taskToolCallCount) || 0) < 1) return false;
  if (evidence?.responseHistory?.taskToolOutputSeen !== true) return false;
  if (evidence?.responseHistory?.markerToolOutputSeen !== true) return false;
  if (evidence?.responseHistory?.assistantHasFinalMarker !== true) return false;
  if ((Number(evidence?.responseHistory?.visibleProgressCount) || 0) < 1) return false;
  return true;
}

function collectComplexProjectArtifactFailures(artifactEvidence, options = {}) {
  const localFailures = [];
  if (!artifactEvidence?.files?.packageJson) localFailures.push("complex-project package.json was not created");
  if (!artifactEvidence?.files?.analyzer) localFailures.push("complex-project codex-update-analyzer.mjs was not created");
  if (!artifactEvidence?.files?.testFile) localFailures.push("complex-project codex-update-analyzer.test.mjs was not created");
  if (!artifactEvidence?.files?.sourcesJson) localFailures.push("complex-project sources.json was not created");
  if (!artifactEvidence?.files?.reportMd) localFailures.push("complex-project report.md was not created");
  if (!artifactEvidence?.files?.indexHtml) localFailures.push("complex-project index.html was not created");
  if (!artifactEvidence?.files?.doneTxt) localFailures.push("complex-project done.txt was not created");
  if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) localFailures.push("complex-project done.txt did not exactly match the marker");
  if (artifactEvidence?.files?.analyzer && artifactEvidence.exportsFunction !== true) localFailures.push("complex-project analyzer did not export summarizeSources");
  if (artifactEvidence?.files?.sourcesJson && artifactEvidence.sourceUrlCount < 3) localFailures.push("complex-project sources.json had fewer than three source URLs");
  if (artifactEvidence?.files?.sourcesJson && artifactEvidence.trustedSourceUrlCount < 3) localFailures.push("complex-project sources.json had fewer than three trusted OpenAI source URLs");
  if (artifactEvidence?.files?.testFile && artifactEvidence.testPassed !== true) localFailures.push("complex-project node:test did not pass");
  if (artifactEvidence?.files?.analyzer && artifactEvidence.cliPassed !== true) localFailures.push("complex-project CLI output did not prove sourceCount>=3 and codexMentionCount>=1");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMarker !== true) localFailures.push("complex-project report.md missing marker");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMarker !== true) localFailures.push("complex-project index.html missing marker");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasChinese !== true) localFailures.push("complex-project report.md missing Chinese content");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasChinese !== true) localFailures.push("complex-project index.html missing Chinese content");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasTrustedChinesePhrase !== true) localFailures.push("complex-project report.md did not preserve required Chinese phrase");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasTrustedChinesePhrase !== true) localFailures.push("complex-project index.html did not preserve required Chinese phrase");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMojibake === true) localFailures.push("complex-project report.md contains likely Chinese mojibake");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMojibake === true) localFailures.push("complex-project index.html contains likely Chinese mojibake");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasLiteralEscapedNewlines === true) localFailures.push("complex-project report.md contains literal escaped newlines");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasLiteralEscapedNewlines === true) localFailures.push("complex-project index.html contains literal escaped newlines");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportMentionsCodex !== true) localFailures.push("complex-project report.md missing Codex/OpenAI content");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlMentionsCodex !== true) localFailures.push("complex-project index.html missing Codex/OpenAI content");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportUrlCount < 3) localFailures.push("complex-project report.md has fewer than three source URLs");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlUrlCount < 3) localFailures.push("complex-project index.html has fewer than three source URLs");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportTrustedUrlCount < 3) localFailures.push("complex-project report.md has fewer than three trusted OpenAI source URLs");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlTrustedUrlCount < 3) localFailures.push("complex-project index.html has fewer than three trusted OpenAI source URLs");
  if (artifactEvidence?.files?.reportMd && artifactEvidence?.files?.indexHtml && artifactEvidence.sharedTrustedUrlCount < 1) localFailures.push("complex-project report.md and index.html did not share a trusted OpenAI source URL");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlComplete !== true) localFailures.push("complex-project index.html is not a complete HTML document");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlLinksReport !== true) localFailures.push("complex-project index.html does not link to report.md");
  if (options.requireModelLed === true && artifactEvidence?.responseHistory?.artifactGuardUsed === true) {
    localFailures.push("complex-project used deterministic artifact guard instead of model-led task execution");
  }
  if (options.requireModelLed === true && (artifactEvidence?.responseHistory?.taskToolCallCount || 0) < 1) {
    localFailures.push("complex-project did not emit a task tool call");
  }
  if (options.requireModelLed === true && artifactEvidence?.responseHistory?.taskToolOutputSeen !== true) {
    localFailures.push("complex-project did not observe task tool output");
  }
  return localFailures;
}

function filterUiMarkerFailuresWhenHistoryConfirmsCompletion(failures, artifactFailures, artifactEvidence) {
  if (artifactFailures.length > 0) return failures;
  if (artifactEvidence?.responseHistory?.assistantHasFinalMarker !== true) return failures;
  return failures.filter((failure) => !/assistant reply marker was not observed/i.test(String(failure || "")));
}

function filterUiMarkerFailuresWhenResponseHistoryConfirmsCompletion(failures, artifactEvidence) {
  const history = artifactEvidence?.responseHistory || {};
  const hasCompletedResponse = history.assistantHasFinalMarker === true
    && history.markerToolOutputSeen === true
    && history.taskToolOutputSeen === true;
  if (!hasCompletedResponse) return failures;
  return failures.filter((failure) => !/assistant reply marker was not observed|send click did not submit/i.test(String(failure || "")));
}

function filterReportSiteUiCompletionFailures(failures, artifactEvidence, answerMarkerCount = 0) {
  if (collectReportSiteArtifactFailures(artifactEvidence).length > 0) return failures;
  const history = artifactEvidence?.responseHistory || {};
  const hasToolProof = history.taskToolOutputSeen === true
    && history.markerToolOutputSeen === true
    && history.artifactGuardUsed !== true;
  const hasUiFinalMarker = Number(answerMarkerCount || 0) >= 1 || history.assistantHasFinalMarker === true;
  const hasVisibleProgress = (Number(history.visibleProgressCount) || 0) >= 1;
  if (!hasToolProof || !hasUiFinalMarker || !hasVisibleProgress) return failures;
  return failures.filter((failure) => !/report-site required verifier repair before completion|report-site did not prove a Codex-like visible agent process|report-site did not show at least two visible progress updates|report-site did not show at least two distinct visible progress updates|report-site assistant final marker was not observed in response history/i.test(String(failure || "")));
}

function filterComplexProjectUiCompletionFailures(failures, artifactEvidence) {
  if (collectComplexProjectArtifactFailures(artifactEvidence).length > 0) return failures;
  if (!complexProjectArtifactComplete(artifactEvidence, { requireModelLed: true })) return failures;
  const history = artifactEvidence?.responseHistory || {};
  const hasStrongFinalProof = history.codexLikeProcessProof === true
    && history.modelLedExecution === true
    && history.artifactGuardUsed !== true
    && history.assistantHasFinalMarker === true
    && history.markerToolOutputSeen === true
    && history.taskToolOutputSeen === true
    && (Number(history.taskToolCallCount) || 0) > 0
    && (Number(history.visibleProgressCount) || 0) >= 2
    && (Number(history.distinctVisibleProgressCount) || 0) >= 2
    && (Number(history.firstPersonProgressCount) || 0) === 0;
  if (!hasStrongFinalProof) return failures;
  return failures.filter((failure) => !/complex-project required verifier repair before completion|complex-project did not prove a Codex-like visible agent process|complex-project did not show at least two visible progress updates|complex-project did not show at least two distinct visible progress updates|complex-project did not observe marker-scoped tool output|complex-project assistant final marker was not observed in response history/i.test(String(failure || "")));
}

function collectAgenticResponseHistoryFailures(taskMode, artifactEvidence, repairAttempted = false) {
  if (!["coding-project", "multi-turn-project", "report-site", "complex-project", "repo-multi-file-edit"].includes(taskMode)) return [];
  const responseHistory = artifactEvidence?.responseHistory || {};
  const failures = [];
  if (repairAttempted) failures.push(`${taskMode} required verifier repair before completion`);
  if (responseHistory.codexLikeProcessProof !== true) failures.push(`${taskMode} did not prove a Codex-like visible agent process`);
  if (responseHistory.artifactGuardUsed === true) failures.push(`${taskMode} used deterministic artifact guard instead of model-led task execution`);
  if ((Number(responseHistory.visibleProgressCount) || 0) < 2) failures.push(`${taskMode} did not show at least two visible progress updates`);
  if ((Number(responseHistory.distinctVisibleProgressCount) || 0) < 2) failures.push(`${taskMode} did not show at least two distinct visible progress updates`);
  if ((Number(responseHistory.firstPersonProgressCount) || 0) > 0) failures.push(`${taskMode} used first-person visible progress updates`);
  if ((Number(responseHistory.repeatedVisibleProgressCount) || 0) > 2) failures.push(`${taskMode} repeated visible progress text too many times`);
  if ((Number(responseHistory.taskToolCallCount) || 0) < 1) failures.push(`${taskMode} did not emit a task tool call`);
  if (responseHistory.taskToolOutputSeen !== true) failures.push(`${taskMode} did not observe task tool output`);
  if (responseHistory.markerToolOutputSeen !== true) failures.push(`${taskMode} did not observe marker-scoped tool output`);
  if (responseHistory.assistantHasFinalMarker !== true) failures.push(`${taskMode} assistant final marker was not observed in response history`);
  return failures;
}

function pushUniqueFailures(target, source) {
  for (const failure of source || []) {
    if (!target.includes(failure)) target.push(failure);
  }
}

function collectReportSiteArtifactFailures(artifactEvidence) {
  const localFailures = [];
  if (!artifactEvidence?.files?.reportMd) localFailures.push("report-site report.md was not created");
  if (!artifactEvidence?.files?.indexHtml) localFailures.push("report-site index.html was not created");
  if (!artifactEvidence?.files?.doneTxt) localFailures.push("report-site done.txt was not created");
  if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) localFailures.push("report-site done.txt did not exactly match the marker");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMarker !== true) localFailures.push("report-site report.md missing marker");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMarker !== true) localFailures.push("report-site index.html missing marker");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasChinese !== true) localFailures.push("report-site report.md missing Chinese content");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasChinese !== true) localFailures.push("report-site index.html missing Chinese content");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMojibake === true) localFailures.push("report-site report.md contains likely Chinese mojibake");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMojibake === true) localFailures.push("report-site index.html contains likely Chinese mojibake");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportMentionsCodex !== true) localFailures.push("report-site report.md missing Codex/OpenAI content");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlMentionsCodex !== true) localFailures.push("report-site index.html missing Codex/OpenAI content");
  if (artifactEvidence?.files?.reportMd && artifactEvidence.reportUrlCount < 3) localFailures.push("report-site report.md has fewer than three source URLs");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlUrlCount < 3) localFailures.push("report-site index.html has fewer than three source URLs");
  if (artifactEvidence?.files?.reportMd && artifactEvidence?.files?.indexHtml && artifactEvidence.sharedUrlCount < 1) localFailures.push("report-site report.md and index.html did not share a source URL");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlComplete !== true) localFailures.push("report-site index.html is not a complete HTML document");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlLinksReport !== true) localFailures.push("report-site index.html does not link to report.md");
  return localFailures;
}

function reportSiteArtifactComplete(evidence) {
  return collectReportSiteArtifactFailures(evidence).length === 0;
}

function collectAgenticStepFlowFailures(artifactEvidence) {
  const localFailures = [];
  if (!artifactEvidence?.files?.indexHtml) localFailures.push("agentic-step-flow index.html was not created");
  if (!artifactEvidence?.files?.readmeMd) localFailures.push("agentic-step-flow README.md was not created");
  if (!artifactEvidence?.files?.doneTxt) localFailures.push("agentic-step-flow done.txt was not created");
  if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) localFailures.push("agentic-step-flow done.txt did not exactly match the marker");
  if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneHasNoBom !== true) localFailures.push("agentic-step-flow done.txt contained a UTF-8 BOM");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.indexHasMarker !== true) localFailures.push("agentic-step-flow index.html did not contain the marker");
  if (artifactEvidence?.files?.indexHtml && artifactEvidence.indexHasChineseTitle !== true) localFailures.push("agentic-step-flow index.html missing 多阶段执行验证");
  if (artifactEvidence?.files?.readmeMd && artifactEvidence.readmeMentionsFiles !== true) localFailures.push("agentic-step-flow README.md did not describe all required files");
  if (artifactEvidence?.responseHistory?.assistantHasPhase1 !== true) localFailures.push("agentic-step-flow assistant did not visibly say 阶段1：准备创建文件");
  if (artifactEvidence?.responseHistory?.assistantHasPhase2 !== true) localFailures.push("agentic-step-flow assistant did not visibly say 阶段2：准备验证文件");
  if ((artifactEvidence?.responseHistory?.visibleProgressCount || 0) < 2) localFailures.push("agentic-step-flow did not show at least two visible progress updates");
  if ((artifactEvidence?.responseHistory?.repeatedPhaseCount || 0) > 0) localFailures.push("agentic-step-flow repeated visible phase text too many times");
  if ((artifactEvidence?.responseHistory?.taskToolCallCount || 0) > 24) localFailures.push("agentic-step-flow used too many task tool calls for a small staged task");
  if (artifactEvidence?.responseHistory?.markerToolCallCount < 1) localFailures.push("agentic-step-flow did not record a marker-scoped tool call");
  if (artifactEvidence?.responseHistory?.markerToolOutputSeen !== true) localFailures.push("agentic-step-flow did not record marker-scoped tool output");
  if (artifactEvidence?.responseHistory?.artifactGuardUsed === true) localFailures.push("agentic-step-flow used the deterministic artifact guard instead of model-led step execution");
  return localFailures;
}

function failuresAreOnlyArtifactFailures(failures = [], artifactFailures = []) {
  const artifactSet = new Set(artifactFailures);
  return artifactFailures.length > 0 && failures.every((failure) => artifactSet.has(failure));
}

async function waitForIdleDiagnostics(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      latest = await httpJson(`${url}/anticodex/diagnostics?fast=1`);
      if (diagnosticsAreIdle(latest)) return { diagnostics: latest, lastError: null };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  return { diagnostics: latest, lastError };
}

async function waitForVisibleComposerIdle(ws, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const state = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
        const bodyText = document.body.innerText || '';
        const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
        const labels = buttons.map((button) => String(button.getAttribute('aria-label') || button.textContent || '').trim()).filter(Boolean);
        const hasStop = labels.some((label) => /^(?:Stop|停止)$|正在思考|running|thinking/i.test(label));
        const hasForegroundStop = buttons.some((button) => /bg-token-foreground/.test(String(button.className || ''))
          && /size-token-button-composer/.test(String(button.className || ''))
          && /停止|Stop|正在思考|running|thinking/i.test(bodyText));
        return { composerPresent: Boolean(composer), hasStop, hasForegroundStop, labels: labels.slice(-16) };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    latest = state.result?.result?.value || null;
    if (latest?.composerPresent && latest.hasStop !== true && latest.hasForegroundStop !== true) {
      return { ok: true, state: latest };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return { ok: false, state: latest };
}

function recoverStaleComposerExpression() {
  const safeMarkerPrefix = JSON.stringify(markerPrefix);
  return `(() => {
    const labels = new Set(['停止', 'Stop', '删除排队的消息', 'Delete queued message']);
    const clicked = [];
    const bodyText = document.body.innerText || '';
    const isTestResidue = bodyText.includes(${safeMarkerPrefix})
      || /desktop-visible-|ui_local_after_role_fix_|UI_(WEB_SEARCH|LOCAL_PROJECT|CODING_PROJECT|COMPLEX_PROJECT|REPORT_SITE|AGENTIC_STEP_FLOW|CHAT)_SMOKE/i.test(bodyText);
    if (!isTestResidue) return { clicked, skipped: true, reason: 'no known UI smoke residue', tail: bodyText.slice(-500) };
    const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
    const composerRect = composer?.getBoundingClientRect();
    for (const button of [...document.querySelectorAll('button')]) {
      const rect = button.getBoundingClientRect();
      const label = (button.getAttribute('aria-label') || button.textContent || '').trim();
      const nearComposer = composerRect
        && rect.left >= composerRect.left + composerRect.width - 90
        && rect.left <= composerRect.left + composerRect.width + 40
        && rect.top >= composerRect.top - 10
        && rect.top <= composerRect.top + composerRect.height + 65;
      const foregroundStop = /正在思考|已处理|running|thinking/i.test(bodyText)
        && nearComposer
        && /bg-token-foreground/.test(String(button.className || ''));
      const clearTestGoal = /Clear goal|Clear target|\u6e05\u9664\u76ee\u6807/i.test(label);
      if (button.disabled || rect.width <= 0 || rect.height <= 0 || (!labels.has(label) && !foregroundStop && !clearTestGoal)) continue;
      button.click();
      clicked.push(label || 'foreground-stop');
    }
    return { clicked, tail: document.body.innerText.slice(-500) };
  })()`;
}

function sendButtonProbeExpression(expectedText, { click = false } = {}) {
  const expected = JSON.stringify(expectedText);
  return `(() => {
    const expected = ${expected};
    const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
    const composerRect = composer?.getBoundingClientRect();
    const labelFor = (button) => (button.getAttribute('aria-label') || button.getAttribute('title') || button.getAttribute('data-testid') || button.textContent || '').trim();
    const visibleButtons = [...document.querySelectorAll('button')]
      .map((button, index) => {
        const rect = button.getBoundingClientRect();
        const label = labelFor(button);
        const near = composerRect
          ? Math.round(Math.hypot((rect.left + rect.width / 2) - (composerRect.left + composerRect.width / 2), (rect.top + rect.height / 2) - (composerRect.top + composerRect.height / 2)))
          : null;
        return {
          button,
          index,
          label,
          aria: button.getAttribute('aria-label') || '',
          type: button.getAttribute('type') || '',
          disabled: button.disabled || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('data-disabled') === 'true',
          className: String(button.className || ''),
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
          near,
        };
      })
      .filter((item) => item.rect.w > 0 && item.rect.h > 0);
    function sendScore(item) {
      if (!composerRect || item.disabled) return -1;
      if (/停止|Stop|引导|Guide|删除排队|排队|queued|滚动|scroll|Add files|完全访问|Gemini/i.test(item.label)) return -1;
      const rightEdge = composerRect.left + composerRect.width;
      const bottomEdge = composerRect.top + composerRect.height;
      const isComposerControl = item.rect.x >= rightEdge - 80
        && item.rect.x <= rightEdge + 30
        && item.rect.y >= bottomEdge - 5
        && item.rect.y <= bottomEdge + 55;
      const sendLabel = /^(发送|提交|Send|Submit)$/i.test(item.label) || /send|submit/i.test(item.aria);
      const foregroundIcon = !item.label && /bg-token-foreground/.test(item.className) && /size-token-button-composer/.test(item.className);
      if (!isComposerControl && !sendLabel) return -1;
      return (sendLabel ? 100 : 0) + (foregroundIcon ? 80 : 0) + (isComposerControl ? 50 : 0) - Math.min(Math.round((item.near || 0) / 10), 99);
    }
    const ranked = visibleButtons
      .map((item) => ({ ...item, score: sendScore(item) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);
    const selected = ranked[0] || null;
    const hit = selected
      ? document.elementFromPoint(selected.rect.x + selected.rect.w / 2, selected.rect.y + selected.rect.h / 2)
      : null;
    const hitButton = hit?.closest?.('button') || null;
    const selectedHit = Boolean(selected && hitButton === selected.button);
    if (${click ? "true" : "false"} && selected && selectedHit) selected.button.click();
    const summarize = (item) => item ? {
      index: item.index,
      label: item.label,
      aria: item.aria,
      type: item.type,
      disabled: item.disabled,
      className: item.className.slice(0, 160),
      rect: item.rect,
      near: item.near,
      score: item.score,
    } : null;
    const summarizeHit = (element) => element ? {
      tag: element.tagName || '',
      label: (element.getAttribute?.('aria-label') || element.getAttribute?.('title') || element.textContent || '').trim().slice(0, 160),
      className: String(element.className || '').slice(0, 160),
    } : null;
    const composerText = composer?.innerText || '';
    const normalizeInsertedText = (value) => String(value || '')
      .replaceAll(String.fromCharCode(13) + String.fromCharCode(10), String.fromCharCode(10))
      .replaceAll(String.fromCharCode(13), String.fromCharCode(10))
      .replace(new RegExp(String.fromCharCode(10) + "{2,}", "g"), String.fromCharCode(10))
      .trim();
    return {
      composer: composerText,
      composerMatches: composerText.trim() === expected.trim()
        || normalizeInsertedText(composerText) === normalizeInsertedText(expected),
      hasSendButton: Boolean(selected && selectedHit),
      clicked: Boolean(${click ? "true" : "false"} && selected && selectedHit),
      selected: summarize(selected),
      selectedHit,
      hitElement: summarizeHit(hit),
      hitButton: summarizeHit(hitButton),
      candidates: ranked.slice(0, 5).map(summarize),
      nearbyButtons: visibleButtons
        .sort((a, b) => (a.near || 99999) - (b.near || 99999))
        .slice(0, 8)
        .map(summarize),
    };
  })()`;
}

async function closeManagerOverlayIfOpen(ws) {
  const closed = await ws.send("Runtime.evaluate", {
    expression: `(() => {
      const overlay = document.querySelector('#anticodex-manager-overlay');
      if (!overlay) return { overlayPresent: false, closed: false };
      const close = overlay.querySelector('.anticodex-close')
        || [...overlay.querySelectorAll('button')].find((button) => /关闭|Close/i.test(button.innerText || button.getAttribute('aria-label') || ''));
      if (close) close.click();
      return { overlayPresent: true, closed: Boolean(close) };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const value = closed.result?.result?.value || {};
  if (value.overlayPresent) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  return value;
}

async function waitForComposerPromptReady(ws, prompt, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const state = await ws.send("Runtime.evaluate", {
      expression: sendButtonProbeExpression(prompt),
      returnByValue: true,
      awaitPromise: true,
    });
    latest = state.result?.result?.value || null;
    if (latest?.composerMatches === true && latest?.hasSendButton === true) return latest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return latest;
}

function currentModelProbeExpression(requiredValues = []) {
  const valuesJson = JSON.stringify(requiredValues.filter(Boolean));
  return `(() => {
    const requiredValues = ${valuesJson};
    const normalize = (value) => String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\\s+/g, ' ');
    const expected = requiredValues.map(normalize).filter(Boolean);
    const matches = (value) => {
      const text = normalize(value);
      return Boolean(text) && expected.some((needle) => text === needle || text.includes(needle));
    };
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const labelFor = (element) => String(element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('data-testid') || element.textContent || '').trim();
    const summarize = (element, index = 0, score = 0) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        label: labelFor(element),
        role: element.getAttribute('role') || '',
        aria: element.getAttribute('aria-label') || '',
        tag: element.tagName,
        score,
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    };
    const modelish = (label) => /gemini|claude|opus|sonnet|flash|gpt|model/i.test(label);
    const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
    const composerRect = composer?.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(visible)
      .map((element, index) => {
        const label = labelFor(element);
        const rect = element.getBoundingClientRect();
        const nearComposer = composerRect
          ? Math.max(0, 180 - Math.round(Math.hypot((rect.left + rect.width / 2) - (composerRect.left + composerRect.width / 2), (rect.top + rect.height / 2) - (composerRect.top + composerRect.height / 2)) / 3))
          : 0;
        const score = (matches(label) ? 400 : 0)
          + (modelish(label) ? 140 : 0)
          + nearComposer
          - Math.min(label.length, 100);
        return { element, index, label, score };
      })
      .filter((item) => modelish(item.label) || matches(item.label))
      .sort((a, b) => b.score - a.score);
    const selected = candidates[0] || null;
    return {
      matched: Boolean(selected && matches(selected.label)),
      selected: selected ? summarize(selected.element, selected.index, selected.score) : null,
      candidates: candidates.slice(0, 8).map((item) => summarize(item.element, item.index, item.score)),
    };
  })()`;
}

function modelOptionProbeExpression(requiredValues = []) {
  const valuesJson = JSON.stringify(requiredValues.filter(Boolean));
  return `(() => {
    const requiredValues = ${valuesJson};
    const normalize = (value) => String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\\s+/g, ' ');
    const expected = requiredValues.map(normalize).filter(Boolean);
    const matches = (value) => {
      const text = normalize(value);
      return Boolean(text) && expected.some((needle) => text === needle || text.includes(needle));
    };
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const labelFor = (element) => String(element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('data-testid') || element.textContent || '').trim();
    const summarize = (element, index = 0, score = 0) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        label: labelFor(element),
        role: element.getAttribute('role') || '',
        aria: element.getAttribute('aria-label') || '',
        tag: element.tagName,
        score,
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    };
    const modelish = (label) => /gemini|claude|opus|sonnet|flash|gpt|model/i.test(label);
    const candidates = Array.from(document.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"],[cmdk-item],li,div'))
      .filter(visible)
      .map((element, index) => {
        const label = labelFor(element);
        const rect = element.getBoundingClientRect();
        const giantContainerPenalty = rect.width > 500 || rect.height > 220 ? 300 : 0;
        const score = (matches(label) ? 500 : 0)
          + (/option|menuitem/i.test(element.getAttribute('role') || '') ? 80 : 0)
          + (modelish(label) ? 30 : 0)
          - Math.min(label.length, 180)
          - giantContainerPenalty;
        return { element, index, label, score };
      })
      .filter((item) => matches(item.label) || modelish(item.label))
      .sort((a, b) => b.score - a.score);
    const selected = candidates.find((item) => matches(item.label)) || null;
    return {
      matched: Boolean(selected),
      selected: selected ? summarize(selected.element, selected.index, selected.score) : null,
      candidates: candidates.slice(0, 12).map((item) => summarize(item.element, item.index, item.score)),
    };
  })()`;
}

async function selectRequiredModel(ws, timeoutMs = 8_000) {
  const requiredValues = requiredModelNeedles();
  if (requiredValues.length === 0) return null;
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  const clickRectCenter = async (rect) => {
    const x = rect.x + rect.w / 2;
    const y = rect.y + rect.h / 2;
    await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const typeModelFilter = async () => {
    const text = String(requiredModelLabel || requiredModel || requiredValues[0] || "").replace(/[^\p{L}\p{N} ._-]+/gu, " ").trim();
    if (!text) return "";
    await ws.send("Input.insertText", { text });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
    return text;
  };
  while (Date.now() < deadline) {
    const current = await ws.send("Runtime.evaluate", {
      expression: currentModelProbeExpression(requiredValues),
      returnByValue: true,
      awaitPromise: true,
    });
    latest = {
      ok: false,
      matched: false,
      requiredValues,
      before: current.result?.result?.value?.selected || null,
      current: current.result?.result?.value || null,
      option: null,
      after: null,
      candidates: current.result?.result?.value?.candidates || [],
    };
    if (latest.current?.matched === true) {
      await pressEscapeKey(ws);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      return { ...latest, ok: true, matched: true, alreadySelected: true, after: latest.current.selected };
    }
    const rect = latest.before?.rect;
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
      latest.error = "model selector button was not found";
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
      continue;
    }
    await clickRectCenter(rect);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
    let optionProbe = null;
    const probeModelOptions = async () => {
      const optionResult = await ws.send("Runtime.evaluate", {
        expression: modelOptionProbeExpression(requiredValues),
        returnByValue: true,
        awaitPromise: true,
      });
      return optionResult.result?.result?.value || null;
    };
    const optionDeadline = Math.min(deadline, Date.now() + 5_000);
    while (Date.now() < optionDeadline) {
      optionProbe = await probeModelOptions();
      if (optionProbe?.matched === true && optionProbe?.selected?.rect) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    }
    if (!(optionProbe?.matched === true && optionProbe?.selected?.rect)) {
      const modelSubmenu = (Array.isArray(optionProbe?.candidates) ? optionProbe.candidates : [])
        .find((candidate) => /menuitem/i.test(candidate?.role || "") && /gemini|claude|opus|sonnet|flash|gpt/i.test(candidate?.label || "") && candidate?.rect);
      if (modelSubmenu?.rect) {
        latest.submenu = modelSubmenu;
        const x = modelSubmenu.rect.x + modelSubmenu.rect.w / 2;
        const y = modelSubmenu.rect.y + modelSubmenu.rect.h / 2;
        await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
        optionProbe = await probeModelOptions();
        if (!(optionProbe?.matched === true && optionProbe?.selected?.rect)) {
          await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
          await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
          optionProbe = await probeModelOptions();
        }
        if (!(optionProbe?.matched === true && optionProbe?.selected?.rect)) {
          await clickRectCenter(modelSubmenu.rect);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
        }
        const submenuDeadline = Math.min(deadline, Date.now() + 5_000);
        while (Date.now() < submenuDeadline) {
          optionProbe = await probeModelOptions();
          if (optionProbe?.matched === true && optionProbe?.selected?.rect) break;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
        }
      }
    }
    if (!(optionProbe?.matched === true && optionProbe?.selected?.rect)) {
      latest.typedFilter = await typeModelFilter();
      const filterDeadline = Math.min(deadline, Date.now() + 5_000);
      while (Date.now() < filterDeadline) {
        optionProbe = await probeModelOptions();
        if (optionProbe?.matched === true && optionProbe?.selected?.rect) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
      }
    }
    latest.optionProbe = optionProbe;
    latest.option = optionProbe?.selected || null;
    if (!latest.option?.rect) {
      latest.error = "required model option was not found after opening selector";
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
      continue;
    }
    await clickRectCenter(latest.option.rect);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    const afterResult = await ws.send("Runtime.evaluate", {
      expression: currentModelProbeExpression(requiredValues),
      returnByValue: true,
      awaitPromise: true,
    });
    const after = afterResult.result?.result?.value || null;
    latest.after = after?.selected || null;
    latest.afterProbe = after;
    if (after?.matched === true) {
      await pressEscapeKey(ws);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      return { ...latest, ok: true, matched: true };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  }
  return latest;
}

async function confirmRequiredModelSelected(ws, timeoutMs = 3_000) {
  const requiredValues = requiredModelNeedles();
  if (requiredValues.length === 0) return null;
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const current = await ws.send("Runtime.evaluate", {
      expression: currentModelProbeExpression(requiredValues),
      returnByValue: true,
      awaitPromise: true,
    });
    const value = current.result?.result?.value || null;
    latest = {
      ok: value?.matched === true,
      matched: value?.matched === true,
      requiredValues,
      current: value,
      after: value?.selected || null,
      readOnly: true,
    };
    if (latest.matched) return latest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return latest;
}

async function waitForComposerSubmitted(ws, prompt, marker, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    const submitted = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
        return { composer: composer?.innerText || '' };
      })()`,
      returnByValue: true,
    });
    const submittedComposer = String(submitted.result?.result?.value?.composer || "");
    if (!submittedComposer.includes(prompt) && !submittedComposer.includes(marker)) return true;
  }
  return false;
}

async function pressComposerEnter(ws) {
  await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

async function refillComposerPrompt(ws, prompt) {
  await closeManagerOverlayIfOpen(ws);
  await ws.send("Runtime.evaluate", {
    expression: `(() => {
      const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
      if (!composer) return null;
      composer.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      composer.innerHTML = '<p><br></p>';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return composer.innerText || '';
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  await ws.send("Input.insertText", { text: prompt });
  return waitForComposerPromptReady(ws, prompt, 5_000);
}

async function selectRequiredModelBeforeRetry(ws) {
  if (requiredModelNeedles().length === 0) return { ok: true, matched: true, skipped: true };
  const evidence = await selectRequiredModel(ws, 8_000);
  return {
    ...(evidence || {}),
    ok: evidence?.matched === true,
    matched: evidence?.matched === true,
    retrySelection: true,
  };
}

async function pressEscapeKey(ws) {
  await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

function newChatClickExpression(projectName = "") {
  const expectedProject = JSON.stringify(projectName || "");
  return `(() => {
    const expectedProject = ${expectedProject};
    const controls = Array.from(document.querySelectorAll('button,[role="button"],a'));
    const normalizedProjectName = String(expectedProject || '').trim();
    const projectContextActive = normalizedProjectName && controls.some((el) => {
      const text = String(el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();
      return text.includes(normalizedProjectName)
        && (/\u5207\u6362\u9879\u76ee|\u9879\u76ee\u64cd\u4f5c|project/i.test(text));
    });
    const candidates = controls.map((el, index) => {
      const text = String(el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\\s+/g, ' ').trim();
      const aria = String(el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      const rect = el.getBoundingClientRect();
      const isNewChat = text.includes('\\u65b0\\u5bf9\\u8bdd') || /Ctrl\\+N|New chat/i.test(text);
      const projectText = text + ' ' + aria;
      const isProjectNewChat = expectedProject
        && projectText.includes(expectedProject)
        && (projectText.includes('\\u5f00\\u59cb\\u65b0\\u5bf9\\u8bdd') || /new chat|new conversation|start/i.test(projectText));
      return { el, index, text, aria, rect, isNewChat, isProjectNewChat };
    }).filter((item) => item.isNewChat && item.rect.width > 0 && item.rect.height > 0);
    const selected = candidates.sort((a, b) => {
      if (a.isProjectNewChat !== b.isProjectNewChat) return a.isProjectNewChat ? -1 : 1;
      return (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x);
    })[0] || null;
    if (!selected) return { clicked: false, candidates: [] };
    selected.el.click();
    return {
      clicked: true,
      projectPreferred: Boolean(expectedProject),
      projectMatched: Boolean(selected.isProjectNewChat || projectContextActive),
      projectContextActive: Boolean(projectContextActive),
      selected: {
        index: selected.index,
        text: selected.text,
        aria: selected.aria,
        rect: { x: selected.rect.x, y: selected.rect.y, w: selected.rect.width, h: selected.rect.height },
      },
      candidates: candidates.slice(0, 5).map((item) => ({ index: item.index, text: item.text, aria: item.aria, project: item.isProjectNewChat })),
    };
  })()`;
}

const visibleMainPaneTextExpression = `
  function visibleMainPaneText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.left < 300 || rect.left > Math.max(900, window.innerWidth - 260)) continue;
      parts.push(text);
    }
    return parts.join('\\n');
  }
`;

async function resolveCdpTargets() {
  const explicitPort = args.get("--cdp-port") || process.env.DEEPCODEX_CDP_PORT;
  const candidates = [...new Set(explicitPort
    ? [Number(explicitPort)]
    : [...discoverAntiCodexCdpPorts(), 58318, 58317])];
  let lastError = null;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate) || candidate <= 0) continue;
    try {
      const targets = await httpJson(`http://127.0.0.1:${candidate}/json`);
      cdpPort = candidate;
      return targets;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Anti-Codex CDP target was not reachable on ${candidates.join(" or ")}: ${lastError || "unknown error"}`);
}

function discoverAntiCodexCdpPorts() {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessName -eq 'Anti-Codex.exe' -and $_.CommandLine -match '--remote-debugging-port=' } | ForEach-Object { $_.CommandLine }",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    });
    const ports = [];
    for (const match of output.matchAll(/--remote-debugging-port=(\d+)/g)) {
      const port = Number(match[1]);
      if (Number.isFinite(port) && port > 0) ports.push(port);
    }
    return ports;
  } catch {
    return [];
  }
}

async function submitDesktopPromptAndWait(ws, prompt, expectedMarker, waitMs, options = {}) {
  const failures = [];
  let clicked = false;
  let submitSucceeded = false;
  let prep = null;
  let submitEvidence = null;
  let composer = "";
  let count = 0;
  let answerMarkerCount = 0;
  let lastSample = "";
  let answerSample = "";
  let activeReconnectSeen = false;
  let artifactCompletionObserved = false;
  let artifactEvidence = null;
  const activeReconnectEvidence = [];
  let inLoopIdleDiagnostics = null;
  let submitCompletedAt = 0;
  let firstReplySeenAt = 0;
  let idleCompletedAt = 0;

  await closeManagerOverlayIfOpen(ws);
  const clear = await ws.send("Runtime.evaluate", {
    expression: `(() => {
      const composer = document.querySelector('.ProseMirror');
      if (!composer) return null;
      const rect = composer.getBoundingClientRect();
      composer.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      composer.innerHTML = '<p><br></p>';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const point = clear.result?.result?.value;
  if (!point) throw new Error("Anti-Codex composer was not found");
  await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await ws.send("Runtime.evaluate", {
    expression: `(() => {
      const composer = document.querySelector('.ProseMirror');
      if (!composer) return null;
      composer.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      composer.innerHTML = '<p><br></p>';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return composer.innerText || '';
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  await ws.send("Input.insertText", { text: prompt });
  prep = await waitForComposerPromptReady(ws, prompt, 5_000);
  const projectlessComposer = options.requiresProjectChat === true
    && Array.isArray(prep?.nearbyButtons)
    && prep.nearbyButtons.some((button) => /Choose project/i.test(`${button?.label || ""} ${button?.aria || ""}`));
  if (prep?.composerMatches !== true) {
    failures.push("composer did not contain exactly the submitted prompt before clicking send");
  } else if (projectlessComposer) {
    failures.push("project task composer was still projectless before clicking send");
  } else if (prep?.hasSendButton !== true) {
    failures.push("send button was not found in the composer controls");
  } else {
    const submitDiagnosticsBefore = await httpJson(diagnosticsUrl).catch(() => null);
    const submitPayloadsBefore = responsesWebSocketPayloadCount(submitDiagnosticsBefore);
    const domClick = await ws.send("Runtime.evaluate", {
      expression: sendButtonProbeExpression(prompt, { click: true }),
      returnByValue: true,
      awaitPromise: true,
    });
    const domClickValue = domClick.result?.result?.value || {};
    clicked = domClickValue.clicked === true;
    submitEvidence = {
      ...domClickValue,
      clicked,
      clickMethod: "dom-click",
      clickPoint: prep?.selected?.rect
        ? { x: prep.selected.rect.x + (prep.selected.rect.w / 2), y: prep.selected.rect.y + (prep.selected.rect.h / 2) }
        : null,
    };
    submitSucceeded = clicked
      ? await waitForComposerSubmitted(ws, prompt, expectedMarker, 4_000)
      : false;

    const rect = prep?.selected?.rect || null;
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
      if (!submitSucceeded) failures.push("send button coordinates were not available");
    } else if (!submitSucceeded) {
      const x = rect.x + (rect.w / 2);
      const y = rect.y + (rect.h / 2);
      await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      clicked = true;
      submitEvidence.mouseFallback = true;
      submitEvidence.clickMethod = "dom-click-cdp-mouse-fallback";
      submitSucceeded = await waitForComposerSubmitted(ws, prompt, expectedMarker, 4_000);
    }
    if (!submitSucceeded) {
      await pressComposerEnter(ws);
      submitEvidence.enterFallback = true;
      submitSucceeded = await waitForComposerSubmitted(ws, prompt, expectedMarker, 4_000);
      if (submitSucceeded) {
        submitEvidence.clickMethod = `${submitEvidence.clickMethod}-enter-fallback`;
      }
    }
    if (clicked) {
      const realSubmit = await waitForRealResponsesSubmitAfter(baseUrl, submitPayloadsBefore, submitSucceeded ? 15_000 : 20_000);
      submitEvidence.realSubmit = realSubmit;
      if (realSubmit.ok === true && !submitSucceeded) {
        submitEvidence.submitConfirmedBy = "responses-websocket";
        submitSucceeded = true;
      }
    }
    if (submitSucceeded) {
      const realSubmit = submitEvidence.realSubmit || await waitForRealResponsesSubmitAfter(baseUrl, submitPayloadsBefore, 15_000);
      submitEvidence.realSubmit = realSubmit;
      if (realSubmit.ok !== true) {
        submitEvidence.emptyPrewarmRetry = realSubmit;
        submitEvidence.retryModelSelection = await selectRequiredModelBeforeRetry(ws);
        if (submitEvidence.retryModelSelection?.matched !== true) {
          submitEvidence.retry = { ok: false, reason: "required_model_reselect_failed", modelSelection: submitEvidence.retryModelSelection };
          submitSucceeded = false;
        } else {
          prep = await refillComposerPrompt(ws, prompt);
        }
        if (submitSucceeded && prep?.composerMatches === true && prep?.hasSendButton === true) {
          const retryDiagnosticsBefore = await httpJson(diagnosticsUrl).catch(() => null);
          const retryPayloadsBefore = responsesWebSocketPayloadCount(retryDiagnosticsBefore);
          const retryClick = await ws.send("Runtime.evaluate", {
            expression: sendButtonProbeExpression(prompt, { click: true }),
            returnByValue: true,
            awaitPromise: true,
          });
          submitEvidence.retry = retryClick.result?.result?.value || {};
          submitSucceeded = submitEvidence.retry.clicked === true
            ? await waitForComposerSubmitted(ws, prompt, expectedMarker, 8_000)
            : false;
          if (submitSucceeded) {
            const retryRealSubmit = await waitForRealResponsesSubmitAfter(baseUrl, retryPayloadsBefore, 15_000);
            submitEvidence.retryRealSubmit = retryRealSubmit;
            if (retryRealSubmit.ok !== true) submitSucceeded = false;
            if (submitSucceeded && Number(options.maxInputItems || 0) > 0 && realSubmitInputItems(retryRealSubmit) > Number(options.maxInputItems || 0)) {
              failures.push(`desktop submit carried too much restored context: inputItems=${realSubmitInputItems(retryRealSubmit)}, max=${Number(options.maxInputItems || 0)}`);
              try { await resetBackendSessionLock(baseUrl); } catch {}
              submitSucceeded = false;
            }
          }
        } else if (submitSucceeded) {
          submitEvidence.retry = { ok: false, reason: "composer_refill_failed", prep };
          submitSucceeded = false;
        }
      } else if (Number(options.maxInputItems || 0) > 0 && realSubmitInputItems(realSubmit) > Number(options.maxInputItems || 0)) {
        submitEvidence.contextGuard = {
          ok: false,
          inputItems: realSubmitInputItems(realSubmit),
          maxInputItems: Number(options.maxInputItems || 0),
        };
        failures.push(`desktop submit carried too much restored context: inputItems=${realSubmitInputItems(realSubmit)}, max=${Number(options.maxInputItems || 0)}`);
        try { await resetBackendSessionLock(baseUrl); } catch {}
        submitSucceeded = false;
      }
    }
  }
  if (clicked && submitSucceeded) {
    const deadline = Date.now() + waitMs;
    const waitStartedAt = Date.now();
    submitCompletedAt = waitStartedAt;
    const idleBreakAfterMs = Math.max(5_000, Number(options.idleBreakAfterMs || 12_000));
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
      const stateAfter = await ws.send("Runtime.evaluate", {
        expression: `(() => {
          ${visibleMainPaneTextExpression}
          const text = document.body.innerText;
          const mainText = visibleMainPaneText();
          const composer = document.querySelector('.ProseMirror');
          return { text, mainText, composer: composer?.innerText || '' };
        })()`,
        returnByValue: true,
      });
      const value = stateAfter.result?.result?.value || {};
      const text = String(value.mainText || value.text || "");
      composer = String(value.composer || "");
      count = expectedMarker ? (text.match(new RegExp(expectedMarker, "g")) || []).length : 0;
      lastSample = text.slice(-1200);
      const promptIndex = text.lastIndexOf(prompt);
      answerSample = promptIndex >= 0 ? text.slice(promptIndex + prompt.length) : lastSample;
      if (activeReconnectPattern.test(answerSample)) {
        activeReconnectSeen = true;
        if (activeReconnectEvidence.length < 5) {
          const compact = answerSample.replace(/\s+/g, " ").trim();
          const match = compact.match(activeReconnectPattern);
          const at = match ? compact.indexOf(match[0]) : 0;
          activeReconnectEvidence.push(compact.slice(Math.max(0, at - 80), at + 180));
        }
      }
      answerMarkerCount = expectedMarker && answerSample ? (answerSample.match(new RegExp(expectedMarker, "g")) || []).length : 0;
      if (answerMarkerCount >= 1 && !firstReplySeenAt) firstReplySeenAt = Date.now();
      if (taskMode === "repo-multi-file-edit") {
        artifactEvidence = verifyRepoMultiFileEditFixture(expectedMarker);
        const artifactFailures = options.readmeOnly === true
          ? collectRepoMultiFileReadmeFailures(artifactEvidence)
          : collectRepoMultiFileEditFailures(artifactEvidence);
        if (artifactFailures.length === 0 && !composer.includes(prompt)) {
          try {
            const loopDiagnostics = await httpJson(diagnosticsUrl);
            if (diagnosticsAreIdle(loopDiagnostics)) {
              artifactCompletionObserved = true;
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          } catch {}
        }
      }
      if (taskMode === "agentic-step-flow") {
        artifactEvidence = verifyAgenticStepFlowArtifact(options.artifactDir || artifactDir, expectedMarker);
        const artifactFailures = collectAgenticStepFlowFailures(artifactEvidence);
        if (artifactFailures.length === 0 && !composer.includes(prompt)) {
          try {
            const loopDiagnostics = await httpJson(diagnosticsUrl);
            if (diagnosticsAreIdle(loopDiagnostics)) {
              artifactCompletionObserved = true;
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          } catch {}
        }
      }
      if (taskMode === "autonomous-reasoning") {
        artifactEvidence = verifyComplexProjectArtifact(options.artifactDir || artifactDir, expectedMarker);
        const hasRequiredFiles = artifactEvidence?.files?.packageJson === true
          && artifactEvidence?.files?.analyzer === true
          && artifactEvidence?.files?.testFile === true
          && artifactEvidence?.files?.sourcesJson === true
          && artifactEvidence?.files?.reportMd === true
          && artifactEvidence?.files?.indexHtml === true
          && artifactEvidence?.files?.doneTxt === true;
        const hasToolEvidence = artifactEvidence?.responseHistory?.taskToolOutputSeen === true
          || artifactEvidence?.responseHistory?.markerToolOutputSeen === true;
        if (hasRequiredFiles && hasToolEvidence && !composer.includes(prompt)) {
          try {
            const loopDiagnostics = await httpJson(diagnosticsUrl);
            if (diagnosticsAreIdle(loopDiagnostics)) {
              artifactCompletionObserved = true;
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
            if (Date.now() - waitStartedAt >= 45_000) {
              const reset = await resetBackendSessionLock(baseUrl).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
              const afterReset = await waitForIdleDiagnostics(baseUrl, 20_000);
              artifactEvidence.autonomousStaleContinuationReset = reset;
              artifactCompletionObserved = true;
              inLoopIdleDiagnostics = afterReset.diagnostics || loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          } catch {}
        }
      }
      if (taskMode !== "agentic-step-flow" && !composer.includes(expectedMarker) && (answerMarkerCount >= 1 || Date.now() - waitStartedAt >= idleBreakAfterMs)) {
        try {
          const loopDiagnostics = await httpJson(diagnosticsUrl);
          if (diagnosticsAreIdle(loopDiagnostics)) {
            const requiresArtifactProgress = taskMode === "repo-multi-file-edit";
            const hasProgressEvidence = artifactProgressEvidenceForWait(artifactEvidence, options)
              || (!requiresArtifactProgress && answerMarkerCount >= 1);
            if (hasProgressEvidence || (!requiresArtifactProgress && Date.now() - waitStartedAt >= waitMs * 0.6)) {
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          }
        } catch {}
      }
    }
  }
  if (!clicked) failures.push("send button was not clicked");
  if (taskMode !== "agentic-step-flow" && !submitSucceeded && answerMarkerCount >= 1 && !composer.includes(expectedMarker)) {
    submitSucceeded = true;
  }
  if (!submitSucceeded) failures.push("send click did not submit the composer prompt");
  if (activeReconnectSeen) failures.push("active reconnect text appeared after the submitted prompt");
  if (answerMarkerCount < 1 && !artifactCompletionObserved) failures.push("assistant reply marker was not observed after the submitted prompt in the desktop UI");
  if (composer.includes(expectedMarker)) failures.push("composer still contains the submitted prompt");
  return {
    ok: failures.length === 0,
    failures,
    prompt,
    marker: expectedMarker,
    prep,
    submitEvidence,
    submitSucceeded,
    clicked,
    markerCount: count,
    answerMarkerCount,
    artifactCompletionObserved,
    artifactEvidence,
    activeReconnectSeen,
    activeReconnectEvidence,
    inLoopIdleObserved: Boolean(inLoopIdleDiagnostics),
    inLoopIdleDiagnostics,
    composerCleared: !composer.includes(expectedMarker),
    composer,
    lastSample,
    answerSample,
    timing: {
      submitCompletedAt: submitCompletedAt ? new Date(submitCompletedAt).toISOString() : null,
      firstReplySeenAt: firstReplySeenAt ? new Date(firstReplySeenAt).toISOString() : null,
      idleCompletedAt: idleCompletedAt ? new Date(idleCompletedAt).toISOString() : null,
      submitMs: submitCompletedAt ? submitCompletedAt - (startedAt) : null,
      firstReplyMs: firstReplySeenAt && submitCompletedAt ? firstReplySeenAt - submitCompletedAt : null,
      idleWaitMs: idleCompletedAt && firstReplySeenAt ? idleCompletedAt - firstReplySeenAt : null,
    },
  };
}

async function main() {
  installConfigModelOverride();
  const failures = [];
  let target = null;
  let ws = null;
  let prep = null;
  let clicked = false;
  let count = 0;
  let answerMarkerCount = 0;
  let composer = "";
  let lastSample = "";
  let answerSample = "";
  let activeReconnectSeen = false;
  const activeReconnectEvidence = [];
  let diagnostics = null;
  let inLoopIdleDiagnostics = null;
  let artifactEvidence = null;
  let releaseUiLock = null;
  let initialIdle = null;
  let staleRecovery = null;
  let backendResetBeforeSubmit = null;
  let newChatEvidence = null;
  let modelSelectionEvidence = null;
  let preSubmitModelSelectionEvidence = null;
  let submitEvidence = null;
  let submitSucceeded = false;
  let submitPayloadsBefore = 0;
  let modelRoutesBefore = null;
  let modelRouteEvidence = null;
  let submitCompletedAt = 0;
  let firstReplySeenAt = 0;
  let idleCompletedAt = 0;
  const complexProjectRequiresModelLed = taskMode === "complex-project" || taskMode === "autonomous-reasoning";

  try {
    releaseUiLock = await acquireUiSmokeLock();
    process.once("exit", () => releaseUiLock?.());
    const targets = await resolveCdpTargets();
    target = targets.find((item) => String(item.url || "").startsWith("app://")) || targets[0];
    if (!target?.webSocketDebuggerUrl) throw new Error("Anti-Codex CDP app target was not found");
    ws = new LocalWebSocket(target.webSocketDebuggerUrl);
    await ws.connect();
    await ws.send("Runtime.enable");
    await ws.send("DOM.enable");
    await ws.send("Network.enable");
    await ws.send("Input.setIgnoreInputEvents", { ignore: false });
    await ws.send("Runtime.evaluate", { expression: "document.querySelector('.anticodex-close')?.click()", awaitPromise: true });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const stale = await ws.send("Runtime.evaluate", {
      expression: recoverStaleComposerExpression(),
      returnByValue: true,
      awaitPromise: true,
    });
    staleRecovery = stale.result?.result?.value || null;
    if (Array.isArray(staleRecovery?.clicked) && staleRecovery.clicked.length > 0) {
      staleRecovery.visibleIdleAfterClick = await waitForVisibleComposerIdle(ws, 20_000);
    }
    try {
      backendResetBeforeSubmit = await resetBackendSessionLock(baseUrl);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
    } catch (error) {
      backendResetBeforeSubmit = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    initialIdle = await waitForIdleDiagnostics(baseUrl, 45_000);
    modelRoutesBefore = await readModelRoutesEvidence();
    if (!diagnosticsAreIdle(initialIdle.diagnostics)) {
      try {
        backendResetBeforeSubmit = {
          first: backendResetBeforeSubmit,
          retry: await resetBackendSessionLock(baseUrl),
        };
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
        initialIdle = await waitForIdleDiagnostics(baseUrl, 20_000);
      } catch (error) {
        backendResetBeforeSubmit = {
          first: backendResetBeforeSubmit,
          retry: { ok: false, error: error instanceof Error ? error.message : String(error) },
        };
      }
    }
    if (!diagnosticsAreIdle(initialIdle.diagnostics)) {
      throw new Error(`desktop backend was not idle before submit after stale recovery: ${initialIdle.lastError || "busy"}`);
    }
    if (taskMode === "repo-file-edit") {
      prepareRepoFileEditFixture();
      artifactEvidence = verifyRepoFileEditFixture();
      if (artifactEvidence?.testPassed === true) failures.push("repo-file-edit fixture was not reset to a failing state before submit");
      artifactEvidence = null;
    }
    if (taskMode === "repo-multi-file-edit") {
      prepareRepoMultiFileEditFixture();
      artifactEvidence = verifyRepoMultiFileEditFixture();
      if (artifactEvidence?.testPassed === true) failures.push("repo-multi-file-edit fixture was not reset to a failing state before submit");
      artifactEvidence = null;
    }
    if (isolateChat) {
      const clickedNewChat = await ws.send("Runtime.evaluate", {
        expression: newChatClickExpression(requiresProjectChat ? projectChatLabel : ""),
        returnByValue: true,
        awaitPromise: true,
      });
      newChatEvidence = clickedNewChat.result?.result?.value || null;
      if (requiresProjectChat && newChatEvidence?.projectMatched !== true) {
        failures.push(`project task did not open a ${projectChatLabel} project chat before submit`);
      }
      if (newChatEvidence?.clicked !== true) {
        await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
        await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 2 });
        await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 2 });
        await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
        newChatEvidence = { ...(newChatEvidence || {}), fallbackShortcut: true };
      }
      newChatEvidence.visibleIdleAfterNewChat = await waitForVisibleComposerIdle(ws, 20_000);
    }
    if (requiredModelNeedles().length > 0) {
      modelSelectionEvidence = await selectRequiredModel(ws, 8_000);
      if (modelSelectionEvidence?.matched !== true) {
        failures.push(`desktop UI did not select required model ${requiredModelNeedles().join(" / ")}`);
        releaseUiLock?.();
        releaseUiLock = null;
        const payload = {
          ok: false,
          reportName,
          requestedRealTraffic: true,
          usedRealTraffic: false,
          behaviorCovered: false,
          coverageKind: "desktop-ui-preflight",
          taskMode,
          requiredModel: requiredModel || null,
          requiredModelLabel: requiredModelLabel || null,
          configModelOverrideEvidence,
          promptText,
          promptLanguage,
          elapsedMs: Date.now() - startedAt,
          failures,
          marker,
          artifactDir: taskMode === "repo-file-edit"
            ? repoFileEditDir
            : taskMode === "repo-multi-file-edit"
              ? repoMultiFileEditDir
            : taskMode === "local-project" || taskMode === "coding-project" || taskMode === "multi-turn-project" || taskMode === "complex-project" || taskMode === "autonomous-reasoning" || taskMode === "report-site" || taskMode === "agentic-step-flow" ? artifactDir : null,
          cdpPort,
          baseUrl,
          target: target ? { id: target.id, title: target.title, url: target.url } : null,
          staleRecovery,
          backendResetBeforeSubmit,
          newChatEvidence,
          modelSelectionEvidence,
          initialIdleObserved: Boolean(initialIdle?.diagnostics),
        };
        restoreConfigModelOverride();
        writeReport(payload);
        console.log(JSON.stringify(payload));
        process.exit(1);
      }
      preSubmitModelSelectionEvidence = modelSelectionEvidence;
    }

    if (taskMode === "multi-turn-project") {
      const firstMarker = `${marker}_FIRST`;
      followupPromptText = `继续同一个项目：${artifactDir}。不要重建项目，也不要查看 Antigravity brain、transcript、history 或 log 目录。修改 word-tally.mjs，让它额外导出 uniqueWords(text)，返回排序后的唯一单词数组。更新 word-tally.test.mjs：保留原来的 tallyWords 断言，再增加一个 node:test 断言，要求 uniqueWords("red blue red") 返回 ["blue","red"]。创建 CHANGELOG.md，里面要提到这次 uniqueWords 追加任务和准确标记 ${marker}。创建 followup.txt，内容必须只包含 ${marker}。运行 node --test word-tally.test.mjs 和 node word-tally.mjs "red blue red green"，确认 red=2、blue=1、green=1 后，最后回复 ${marker}。`;
      followupPromptLanguage = /[\u3400-\u9fff]/u.test(followupPromptText) ? "zh" : "en";
      const turn1 = await submitDesktopPromptAndWait(ws, promptText, firstMarker, timeoutMs, { requiresProjectChat });
      failures.push(...turn1.failures.map((failure) => `turn1: ${failure}`));
      const turn1Settled = await waitForDesktopToolTurnSettled(ws, firstMarker, Math.min(timeoutMs, 120_000));
      if (turn1Settled.ok !== true) {
        failures.push("turn1: desktop tool result did not settle into response history before the follow-up");
      }
      const firstArtifactEvidence = verifyMultiTurnProjectArtifact(artifactDir, firstMarker, marker);
      const turn2 = turn1Settled.ok === true
        ? await submitDesktopPromptAndWait(ws, followupPromptText, marker, timeoutMs, { requiresProjectChat })
        : {
          ok: false,
          failures: ["follow-up was not submitted because turn1 tool output was not settled"],
          clicked: false,
          submitSucceeded: false,
          markerCount: 0,
          answerMarkerCount: 0,
          composer: "",
          lastSample: turn1.lastSample || "",
          answerSample: "",
          activeReconnectSeen: false,
          activeReconnectEvidence: [],
        };
      failures.push(...turn2.failures.map((failure) => `turn2: ${failure}`));
      artifactEvidence = await waitForArtifactEvidence(
        () => verifyMultiTurnProjectArtifact(artifactDir, firstMarker, marker),
        multiTurnProjectArtifactComplete,
        Math.min(timeoutMs, 120_000),
      );
      if (!artifactEvidence?.files?.packageJson) failures.push("multi-turn package.json was not created");
      if (!artifactEvidence?.files?.wordTally) failures.push("multi-turn word-tally.mjs was not created");
      if (!artifactEvidence?.files?.testFile) failures.push("multi-turn word-tally.test.mjs was not created");
      if (!artifactEvidence?.files?.doneTxt) failures.push("multi-turn done.txt was not created");
      if (!artifactEvidence?.files?.followupTxt) failures.push("multi-turn followup.txt was not created");
      if (!artifactEvidence?.files?.changelogMd) failures.push("multi-turn CHANGELOG.md was not created");
      if (artifactEvidence?.files?.doneTxt && artifactEvidence.firstDoneExact !== true) failures.push("multi-turn done.txt did not preserve the first-turn marker");
      if (artifactEvidence?.files?.followupTxt && artifactEvidence.followupExact !== true) failures.push("multi-turn followup.txt did not exactly match the final marker");
      if (artifactEvidence?.files?.changelogMd && artifactEvidence.changelogHasFinalMarker !== true) failures.push("multi-turn CHANGELOG.md missing final marker");
      if (artifactEvidence?.files?.wordTally && artifactEvidence.exportsTallyWords !== true) failures.push("multi-turn project did not export tallyWords");
      if (artifactEvidence?.files?.wordTally && artifactEvidence.exportsUniqueWords !== true) failures.push("multi-turn project did not export uniqueWords");
      if (artifactEvidence?.files?.testFile && artifactEvidence.testPassed !== true) failures.push("multi-turn node:test did not pass");
      if (artifactEvidence?.files?.wordTally && artifactEvidence.cliPassed !== true) failures.push("multi-turn CLI output did not contain red=2 blue=1 green=1");

      clicked = turn1.clicked === true && turn2.clicked === true;
      prep = turn1.prep;
      submitEvidence = turn2.submitEvidence;
      submitSucceeded = turn1.submitSucceeded === true && turn2.submitSucceeded === true;
      count = Number(turn1.markerCount || 0) + Number(turn2.markerCount || 0);
      answerMarkerCount = Number(turn2.answerMarkerCount || 0);
      composer = turn2.composer || "";
      lastSample = turn2.lastSample || turn1.lastSample || "";
      answerSample = turn2.answerSample || "";
      activeReconnectSeen = turn1.activeReconnectSeen === true || turn2.activeReconnectSeen === true;
      activeReconnectEvidence.push(...(turn1.activeReconnectEvidence || []), ...(turn2.activeReconnectEvidence || []));
      inLoopIdleDiagnostics = turn2.inLoopIdleDiagnostics || turn1.inLoopIdleDiagnostics || null;

      const idleResult = inLoopIdleDiagnostics
        ? { diagnostics: inLoopIdleDiagnostics, lastError: null }
        : await waitForIdleDiagnostics(baseUrl, 60_000);
      diagnostics = idleResult.diagnostics;
      if (!diagnostics) {
        failures.push(`diagnostics endpoint did not respond after desktop task: ${idleResult.lastError || "unknown error"}`);
      } else if (!diagnosticsAreIdle(diagnostics)) {
        failures.push("desktop task did not become idle after the assistant reply");
      }
      const sessionLock = diagnostics?.antigravitySessionLock || null;
      const activeRequests = diagnostics?.activeAntigravityRequests || null;
      const queue = diagnostics?.antigravityQueue || null;
      if (sessionLock?.active === true) failures.push("desktop task left the Antigravity session lock active");
      if (Number(sessionLock?.queued || 0) > 0) failures.push("desktop task left queued Antigravity sessions");
      if (Number(activeRequests?.active || 0) > 0) failures.push("desktop task left active Antigravity requests");
      if (queue?.running === true) failures.push("desktop task left the Antigravity request queue running");
      modelRouteEvidence = await collectModelRouteEvidence(modelRoutesBefore);
      failures.push(...collectRequiredModelFailures(modelRouteEvidence, diagnostics));
      const observedModelRoute = desktopRealTrafficObserved(modelRouteEvidence);
      const observedRequestPayload = modelRequestPayloadObserved(diagnostics, [turn1, turn2]);
      const observedRealTraffic = observedModelRoute || observedRequestPayload;
      if (!observedRequestPayload) failures.push("desktop submit did not produce a model request payload");
      const payload = {
        ok: failures.length === 0,
        reportName,
        requestedRealTraffic: true,
        usedRealTraffic: observedRealTraffic,
        modelRouteObserved: observedModelRoute,
        modelRequestPayloadObserved: observedRequestPayload,
        behaviorCovered: true,
        coverageKind: observedRealTraffic ? "desktop-ui-real-traffic" : "desktop-ui-submit-without-request",
        taskMode,
        promptText,
        promptLanguage,
        followupPromptText,
        followupPromptLanguage,
        requiredModel: requiredModel || null,
        requiredModelLabel: requiredModelLabel || null,
        configModelOverrideEvidence,
        turnPrompts: [promptText, followupPromptText],
        elapsedMs: Date.now() - startedAt,
        failures,
        marker,
        firstMarker,
        artifactDir,
        firstArtifactEvidence,
        turn1Settled,
        artifactEvidence,
        turnEvidence: [turn1, turn2].map((turn) => ({
          ok: turn.ok,
          marker: turn.marker,
          clicked: turn.clicked,
          submitSucceeded: turn.submitSucceeded,
          answerMarkerCount: turn.answerMarkerCount,
          artifactCompletionObserved: turn.artifactCompletionObserved,
          composerCleared: turn.composerCleared,
          activeReconnectSeen: turn.activeReconnectSeen,
          inLoopIdleObserved: turn.inLoopIdleObserved,
          failures: turn.failures,
          timing: turn.timing || null,
        })),
        cdpPort,
        baseUrl,
        target: target ? { id: target.id, title: target.title, url: target.url } : null,
        prep,
        submitEvidence,
        submitSucceeded,
        staleRecovery,
        backendResetBeforeSubmit,
        newChatEvidence,
        modelSelectionEvidence,
        initialIdleObserved: Boolean(initialIdle?.diagnostics),
        clicked,
        markerCount: count,
        answerMarkerCount,
        activeReconnectSeen,
        activeReconnectEvidence,
        inLoopIdleObserved: Boolean(inLoopIdleDiagnostics),
        composerCleared: !composer.includes(marker),
        sessionLockClear: sessionLock ? sessionLock.active !== true && Number(sessionLock.queued || 0) === 0 : false,
        lastSample,
        antigravitySessionLock: sessionLock,
        activeAntigravityRequests: activeRequests,
        antigravityQueue: queue,
        modelRouteEvidence,
        responsesWebSocket: diagnostics?.responsesWebSocket || null,
        networkEvents: ws ? summarizeNetworkEvents(ws.events || []) : [],
        timing: {
          turn1: turn1.timing || null,
          turn2: turn2.timing || null,
        },
      };
      releaseUiLock?.();
      releaseUiLock = null;
      restoreConfigModelOverride();
      writeReport(payload);
      console.log(JSON.stringify(payload));
      if (!payload.ok) process.exit(1);
      process.exit(0);
    }

    if (taskMode === "repo-multi-file-edit") {
      const turn1 = await submitDesktopPromptAndWait(ws, promptText, marker, timeoutMs, { requiresProjectChat, readmeOnly: true });
      const firstArtifactEvidence = await waitForArtifactEvidence(
        () => verifyRepoMultiFileEditFixture(marker),
        (evidence) => collectRepoMultiFileReadmeFailures(evidence).length === 0,
        Math.min(timeoutMs, 120_000),
      );
      const firstTurnSettle = repoMultiArtifactIdleSettle(turn1, "readme", firstArtifactEvidence);
      const firstArtifactFailures = collectRepoMultiFileReadmeFailures(firstArtifactEvidence);
      const actionableTurn1Failures = filterRepoMultiReadmeTextOnlyFailures(turn1.failures, firstArtifactFailures);
      let implementationPrompt = null;
      let turn2 = null;
      artifactEvidence = firstArtifactEvidence;
      let finalArtifactFailures = firstArtifactFailures;
      let finalTurnSettle = firstTurnSettle;
      if (firstArtifactFailures.length === 0 && actionableTurn1Failures.length === 0) {
        implementationPrompt = buildRepoMultiFileImplementationPrompt(collectRepoMultiFileEditFailures(firstArtifactEvidence));
        makeWritable(repoMultiFileSource);
        turn2 = await submitDesktopPromptAndWait(ws, implementationPrompt, marker, timeoutMs, { requiresProjectChat });
        artifactEvidence = await waitForArtifactEvidence(
          () => verifyRepoMultiFileEditFixture(marker),
          (evidence) => collectRepoMultiFileEditFailures(evidence).length === 0,
          Math.min(timeoutMs, 120_000),
        );
        finalTurnSettle = repoMultiArtifactIdleSettle(turn2, "full", artifactEvidence);
        finalArtifactFailures = collectRepoMultiFileEditFailures(artifactEvidence);
      }
      const finalTurn = turn2 || turn1;
      failures.push(...actionableTurn1Failures.map((failure) => `readme-step: ${failure}`));
      if (turn2) failures.push(...turn2.failures.map((failure) => `implementation-step: ${failure}`));
      failures.push(...finalArtifactFailures);

      clicked = turn1.clicked === true && (!turn2 || turn2.clicked === true);
      prep = turn1.prep;
      submitEvidence = finalTurn.submitEvidence;
      submitSucceeded = turn1.submitSucceeded === true && (!turn2 || turn2.submitSucceeded === true);
      count = Number(turn1.markerCount || 0) + Number(turn2?.markerCount || 0);
      answerMarkerCount = Number(finalTurn.answerMarkerCount || 0);
      composer = finalTurn.composer || "";
      lastSample = finalTurn.lastSample || turn1.lastSample || "";
      answerSample = finalTurn.answerSample || "";
      activeReconnectSeen = turn1.activeReconnectSeen === true || turn2?.activeReconnectSeen === true;
      activeReconnectEvidence.push(...(turn1.activeReconnectEvidence || []), ...(turn2?.activeReconnectEvidence || []));
      inLoopIdleDiagnostics = finalTurn.inLoopIdleDiagnostics || turn1.inLoopIdleDiagnostics || null;

      const idleResult = inLoopIdleDiagnostics
        ? { diagnostics: inLoopIdleDiagnostics, lastError: null }
        : await waitForIdleDiagnostics(baseUrl, 60_000);
      diagnostics = idleResult.diagnostics;
      if (!diagnostics) {
        failures.push(`diagnostics endpoint did not respond after desktop task: ${idleResult.lastError || "unknown error"}`);
      } else if (!diagnosticsAreIdle(diagnostics)) {
        failures.push("desktop task did not become idle after the assistant reply");
      }
      const sessionLock = diagnostics?.antigravitySessionLock || null;
      const activeRequests = diagnostics?.activeAntigravityRequests || null;
      const queue = diagnostics?.antigravityQueue || null;
      if (sessionLock?.active === true) failures.push("desktop task left the Antigravity session lock active");
      if (Number(sessionLock?.queued || 0) > 0) failures.push("desktop task left queued Antigravity sessions");
      if (Number(activeRequests?.active || 0) > 0) failures.push("desktop task left active Antigravity requests");
      if (queue?.running === true) failures.push("desktop task left the Antigravity request queue running");
      modelRouteEvidence = await collectModelRouteEvidence(modelRoutesBefore);
      failures.push(...collectRequiredModelFailures(modelRouteEvidence, diagnostics));
      const observedModelRoute = desktopRealTrafficObserved(modelRouteEvidence);
      const observedRequestPayload = modelRequestPayloadObserved(diagnostics, [turn1, turn2]);
      const observedRealTraffic = observedModelRoute || observedRequestPayload;
      if (!observedRequestPayload) failures.push("desktop submit did not produce a model request payload");
      const payload = {
        ok: failures.length === 0,
        reportName,
        requestedRealTraffic: true,
        usedRealTraffic: observedRealTraffic,
        modelRouteObserved: observedModelRoute,
        modelRequestPayloadObserved: observedRequestPayload,
        behaviorCovered: true,
        coverageKind: observedRealTraffic ? "desktop-ui-real-traffic" : "desktop-ui-submit-without-request",
        taskMode,
        promptText,
        requiredModel: requiredModel || null,
        requiredModelLabel: requiredModelLabel || null,
        configModelOverrideEvidence,
        implementationAttempted: Boolean(implementationPrompt),
        turnPrompts: implementationPrompt ? [promptText, implementationPrompt] : [promptText],
        elapsedMs: Date.now() - startedAt,
        failures,
        marker,
        artifactDir: repoMultiFileEditDir,
        firstArtifactEvidence,
        firstArtifactFailures,
        firstTurnSettle,
        artifactEvidence,
        finalArtifactFailures,
        finalTurnSettle,
        turnEvidence: [turn1, turn2].filter(Boolean).map((turn) => ({
          ok: turn.ok,
          marker: turn.marker,
          clicked: turn.clicked,
          submitSucceeded: turn.submitSucceeded,
          answerMarkerCount: turn.answerMarkerCount,
          composerCleared: turn.composerCleared,
          activeReconnectSeen: turn.activeReconnectSeen,
          inLoopIdleObserved: turn.inLoopIdleObserved,
          failures: turn.failures,
          timing: turn.timing || null,
        })),
        cdpPort,
        baseUrl,
        target: target ? { id: target.id, title: target.title, url: target.url } : null,
        prep,
        submitEvidence,
        submitSucceeded,
        staleRecovery,
        backendResetBeforeSubmit,
        newChatEvidence,
        modelSelectionEvidence,
        initialIdleObserved: Boolean(initialIdle?.diagnostics),
        clicked,
        markerCount: count,
        answerMarkerCount,
        activeReconnectSeen,
        activeReconnectEvidence,
        inLoopIdleObserved: Boolean(inLoopIdleDiagnostics),
        composerCleared: !composer.includes(marker),
        sessionLockClear: sessionLock ? sessionLock.active !== true && Number(sessionLock.queued || 0) === 0 : false,
        lastSample,
        antigravitySessionLock: sessionLock,
        activeAntigravityRequests: activeRequests,
        antigravityQueue: queue,
        modelRouteEvidence,
        responsesWebSocket: diagnostics?.responsesWebSocket || null,
        networkEvents: ws ? summarizeNetworkEvents(ws.events || []) : [],
        timing: {
          turn1: turn1.timing || null,
          turn2: turn2?.timing || null,
        },
      };
      releaseUiLock?.();
      releaseUiLock = null;
      restoreConfigModelOverride();
      writeReport(payload);
      console.log(JSON.stringify(payload));
      if (!payload.ok) process.exit(1);
      process.exit(0);
    }

    await closeManagerOverlayIfOpen(ws);
    const clear = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const composer = document.querySelector('.ProseMirror');
        if (!composer) return null;
        const rect = composer.getBoundingClientRect();
        composer.focus();
        document.execCommand('selectAll');
        document.execCommand('delete');
        composer.innerHTML = '<p><br></p>';
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const point = clear.result?.result?.value;
    if (!point) throw new Error("Anti-Codex composer was not found");
    await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const composer = document.querySelector('.ProseMirror');
        if (!composer) return null;
        composer.focus();
        document.execCommand('selectAll');
        document.execCommand('delete');
        composer.innerHTML = '<p><br></p>';
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        return composer.innerText || '';
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    await ws.send("Input.insertText", { text: promptText });
    prep = await waitForComposerPromptReady(ws, promptText, 5_000);
    if (prep?.composerMatches !== true) {
      failures.push("composer did not contain exactly the submitted prompt before clicking send");
    } else if (prep?.hasSendButton !== true) {
      failures.push("send button was not found in the composer controls");
    } else {
      if (requiredModelNeedles().length > 0) {
        preSubmitModelSelectionEvidence = await confirmRequiredModelSelected(ws, 5_000);
        if (preSubmitModelSelectionEvidence?.matched !== true) {
          failures.push(`desktop UI did not keep required model selected before submit ${requiredModelNeedles().join(" / ")}`);
        }
        prep = await waitForComposerPromptReady(ws, promptText, 5_000);
        if (prep?.composerMatches !== true) {
          failures.push("composer changed while confirming the required model before submit");
        }
      }
      const rect = prep?.selected?.rect || null;
      if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
        failures.push("send button coordinates were not available");
      } else {
        const submitDiagnosticsBefore = await httpJson(diagnosticsUrl).catch(() => null);
        submitPayloadsBefore = responsesWebSocketPayloadCount(submitDiagnosticsBefore);
        const x = rect.x + (rect.w / 2);
        const y = rect.y + (rect.h / 2);
        await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
        await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        clicked = true;
      }
      const click = await ws.send("Runtime.evaluate", {
        expression: sendButtonProbeExpression(promptText),
        returnByValue: true,
        awaitPromise: true,
      });
      submitEvidence = {
        ...(click.result?.result?.value || {}),
        clicked,
        clickMethod: "cdp-mouse",
        clickPoint: prep?.selected?.rect
          ? { x: prep.selected.rect.x + (prep.selected.rect.w / 2), y: prep.selected.rect.y + (prep.selected.rect.h / 2) }
          : null,
      };
      const submitWaitMs = requiredModelNeedles().length > 0 ? 15_000 : 4_000;
      submitSucceeded = await waitForComposerSubmitted(ws, promptText, marker, submitWaitMs);
      if (!submitSucceeded) {
        await pressComposerEnter(ws);
        submitEvidence.enterFallback = true;
        submitSucceeded = await waitForComposerSubmitted(ws, promptText, marker, submitWaitMs);
        if (submitSucceeded) {
          submitEvidence.clickMethod = "cdp-mouse-enter-fallback";
        }
      }
      let realSubmit = null;
      if (clicked) {
        realSubmit = await waitForRealResponsesSubmitAfter(baseUrl, submitPayloadsBefore, submitSucceeded ? 15_000 : 20_000);
        submitEvidence.realSubmit = realSubmit;
        if (realSubmit.ok === true && !submitSucceeded) {
          submitEvidence.submitConfirmedBy = "responses-websocket";
          submitSucceeded = true;
        }
      }
      if (submitSucceeded && realSubmit?.ok !== true) {
        submitEvidence.emptyPrewarmRetry = realSubmit;
        submitEvidence.retryModelSelection = await selectRequiredModelBeforeRetry(ws);
        if (submitEvidence.retryModelSelection?.matched !== true) {
          submitEvidence.retry = { ok: false, reason: "required_model_reselect_failed", modelSelection: submitEvidence.retryModelSelection };
          submitSucceeded = false;
        } else {
          prep = await refillComposerPrompt(ws, promptText);
        }
        if (submitSucceeded && prep?.composerMatches === true && prep?.hasSendButton === true) {
          const retryDiagnosticsBefore = await httpJson(diagnosticsUrl).catch(() => null);
          const retryPayloadsBefore = responsesWebSocketPayloadCount(retryDiagnosticsBefore);
          const retryClick = await ws.send("Runtime.evaluate", {
            expression: sendButtonProbeExpression(promptText, { click: true }),
            returnByValue: true,
            awaitPromise: true,
          });
          submitEvidence.retry = retryClick.result?.result?.value || {};
          submitSucceeded = submitEvidence.retry.clicked === true
            ? await waitForComposerSubmitted(ws, promptText, marker, 8_000)
            : false;
          if (submitSucceeded) {
            const retryRealSubmit = await waitForRealResponsesSubmitAfter(baseUrl, retryPayloadsBefore, 15_000);
            submitEvidence.retryRealSubmit = retryRealSubmit;
            if (retryRealSubmit.ok !== true) submitSucceeded = false;
          }
        } else if (submitSucceeded) {
          submitEvidence.retry = { ok: false, reason: "composer_refill_failed", prep };
          submitSucceeded = false;
        }
      }
      const maxInputItems = taskMode === "autonomous-reasoning" ? 80 : 0;
      if (submitSucceeded && maxInputItems > 0) {
        const realSubmit = submitEvidence.realSubmit || await waitForRealResponsesSubmitAfter(baseUrl, submitPayloadsBefore, 15_000);
        submitEvidence.realSubmit = realSubmit;
        if (realSubmit.ok !== true) {
          submitSucceeded = false;
        } else if (realSubmitInputItems(realSubmit) > maxInputItems) {
          submitEvidence.contextGuard = {
            ok: false,
            inputItems: realSubmitInputItems(realSubmit),
            maxInputItems,
          };
          failures.push(`desktop submit carried too much restored context: inputItems=${realSubmitInputItems(realSubmit)}, max=${maxInputItems}`);
          try { await resetBackendSessionLock(baseUrl); } catch {}
          submitSucceeded = false;
        }
      }
      if (submitSucceeded) submitCompletedAt = Date.now();
      if (!submitSucceeded) failures.push("send click did not submit the composer prompt");
    }
    if (clicked && submitSucceeded) {
    const deadline = Date.now() + timeoutMs;
    const waitStartedAt = Date.now();
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
      const stateAfter = await ws.send("Runtime.evaluate", {
        expression: `(() => {
          ${visibleMainPaneTextExpression}
          const text = document.body.innerText;
          const mainText = visibleMainPaneText();
          const composer = document.querySelector('.ProseMirror');
          return { text, mainText, composer: composer?.innerText || '' };
        })()`,
        returnByValue: true,
      });
      const value = stateAfter.result?.result?.value || {};
      const text = String(value.mainText || value.text || "");
      composer = String(value.composer || "");
      count = marker ? (text.match(new RegExp(marker, "g")) || []).length : 0;
      lastSample = text.slice(-1200);
      const promptIndex = text.lastIndexOf(promptText);
      answerSample = promptIndex >= 0 ? text.slice(promptIndex + promptText.length) : lastSample;
      if (activeReconnectPattern.test(answerSample)) {
        activeReconnectSeen = true;
        if (activeReconnectEvidence.length < 5) {
          const compact = answerSample.replace(/\s+/g, " ").trim();
          const match = compact.match(activeReconnectPattern);
          const at = match ? compact.indexOf(match[0]) : 0;
          activeReconnectEvidence.push(compact.slice(Math.max(0, at - 80), at + 180));
        }
      }
      answerMarkerCount = marker && answerSample ? (answerSample.match(new RegExp(marker, "g")) || []).length : 0;
      if (answerMarkerCount >= 1 && !firstReplySeenAt) firstReplySeenAt = Date.now();
      if (taskMode === "autonomous-reasoning") {
        try {
          const loopDiagnostics = await httpJson(diagnosticsUrl);
          const inputItems = Number(loopDiagnostics?.responsesWebSocket?.lastClientPayload?.inputItems || 0);
          if (inputItems > 80) {
            failures.push(`desktop submit carried too much restored context: inputItems=${inputItems}, max=80`);
            submitEvidence = {
              ...(submitEvidence || {}),
              contextGuard: { ok: false, inputItems, maxInputItems: 80 },
            };
            try { await resetBackendSessionLock(baseUrl); } catch {}
            break;
          }
        } catch {}
      }
      if (taskMode === "free-chat") {
        const normalizedAnswer = answerSample.replace(/完全访问|输出|暂无产物|来源|暂无来源|Gemini[^\n]*/g, "").trim();
        if (!composer.includes(promptText) && /[\u4e00-\u9fff]/.test(normalizedAnswer) && !/正在思考|已处理|停止了|重新连接/.test(normalizedAnswer)) break;
      } else if (taskMode === "repo-file-edit") {
        artifactEvidence = verifyRepoFileEditFixture();
        if (!composer.includes(promptText) && artifactEvidence?.testPassed === true) {
          try {
            const loopDiagnostics = await httpJson(diagnosticsUrl);
            if (diagnosticsAreIdle(loopDiagnostics)) {
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          } catch {}
        }
      } else if (taskMode === "agentic-step-flow") {
        artifactEvidence = verifyAgenticStepFlowArtifact(artifactDir, marker);
        const artifactFailures = collectAgenticStepFlowFailures(artifactEvidence);
        if (!composer.includes(promptText) && artifactFailures.length === 0) {
          try {
            const loopDiagnostics = await httpJson(diagnosticsUrl);
            if (diagnosticsAreIdle(loopDiagnostics)) {
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          } catch {}
        }
      } else if (taskMode === "autonomous-reasoning") {
        artifactEvidence = verifyComplexProjectArtifact(artifactDir, marker);
        const artifactFailures = collectComplexProjectArtifactFailures(artifactEvidence);
        const hasToolEvidence = (artifactEvidence?.responseHistory?.taskToolCallCount || 0) >= 1
          && artifactEvidence?.responseHistory?.taskToolOutputSeen === true
          && artifactEvidence?.responseHistory?.artifactGuardUsed !== true;
        try {
          const loopDiagnostics = await httpJson(diagnosticsUrl);
          if (diagnosticsAreIdle(loopDiagnostics)) {
            if (!composer.includes(promptText) && artifactFailures.length === 0 && hasToolEvidence) {
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
            if (Date.now() - waitStartedAt >= Math.max(120_000, timeoutMs * 0.75)) {
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          }
        } catch {}
      } else if (answerMarkerCount >= 1 && !composer.includes(marker)) {
        try {
          const loopDiagnostics = await httpJson(diagnosticsUrl);
          if (diagnosticsAreIdle(loopDiagnostics)) {
            inLoopIdleDiagnostics = loopDiagnostics;
            idleCompletedAt = Date.now();
            break;
          }
        } catch {}
      }
    }
    }
    if (!clicked) failures.push("send button was not clicked");
    if (activeReconnectSeen) failures.push("active reconnect text appeared after the submitted prompt");
    if (taskMode !== "free-chat" && taskMode !== "repo-file-edit" && answerMarkerCount < 1) failures.push("assistant reply marker was not observed after the submitted prompt in the desktop UI");
    if (taskMode !== "free-chat" && taskMode !== "repo-file-edit" && composer.includes(marker)) failures.push("composer still contains the submitted prompt");
    if (taskMode === "free-chat") {
      if (composer.includes(promptText)) failures.push("composer still contains the submitted prompt");
      if (!answerSample.trim()) failures.push("assistant free-chat reply was not observed in the desktop UI");
      if (/Anti-Codex(?:\s+blocked|.{0,24}宸叉嫤鎴|.{0,24}已拦截)|blocked this completion|没有实际 tool call|娌℃湁瀹為檯 tool call/i.test(answerSample)) {
        failures.push("free-chat answer was replaced by a guard-blocked response");
      }
      const answerWithoutChrome = answerSample.replace(/\n+完全访问[\s\S]*$/u, "").trim();
      const hasSubstantiveFreeChatAnswer = /https?:\/\/|GPT|GBT|OpenAI|release|Release|ping/i.test(answerWithoutChrome)
        || (/(发布|模型|官方)/.test(answerWithoutChrome) && answerWithoutChrome.length > 80);
      if (!hasSubstantiveFreeChatAnswer && /正在思考|已处理|停止了|重新连接|处理中|正在运行/.test(answerWithoutChrome)) failures.push("free-chat answer only showed transient thinking/tool state");
      if (!/(发布|GPT|GBT|OpenAI|模型|没有|暂无|未知|预计|官方|ping|测试|退出|日志|文件|产物|冒烟|跑通|命令)/i.test(answerWithoutChrome)) failures.push("free-chat answer did not contain a final user-facing answer");
    }
    if (taskMode === "web-search" && answerSample) lastSample = answerSample;
    if (taskMode === "web-search") {
      if (!/Codex|codex|更新|发布|release|版本|OpenAI/i.test(lastSample)) failures.push("web-search answer did not mention Codex updates");
      if (!/[\u4e00-\u9fff]/.test(lastSample)) failures.push("web-search answer did not contain Chinese text");
      if (!/https?:\/\//i.test(lastSample)) failures.push("web-search answer did not include source URLs");
      if (/无法直接实时检索|未提供\s*`?web_search|缺少工具|Anti-Codex 已拦截/i.test(lastSample)) {
        failures.push("web-search answer still contained a missing-tool or blocked-response detour");
      }
    }
    if (taskMode === "repo-file-edit") {
      const responseHistoryMarkerSeen = responseHistoryContains(marker);
      artifactEvidence = verifyRepoFileEditFixture();
      if (!artifactEvidence?.files?.target) failures.push("repo-file-edit target file was not present");
      if (!artifactEvidence?.files?.test) failures.push("repo-file-edit test file was not present");
      if (!responseHistoryMarkerSeen) failures.push("repo-file-edit prompt marker was not observed in response history after desktop submit");
      if (artifactEvidence?.testPassed !== true) failures.push("repo-file-edit node:test did not pass after the desktop task");
    }
    if (taskMode === "repo-multi-file-edit") {
      artifactEvidence = verifyRepoMultiFileEditFixture(marker);
      if (!artifactEvidence?.files?.source) failures.push("repo-multi-file-edit source file was not present");
      if (!artifactEvidence?.files?.test) failures.push("repo-multi-file-edit test file was not present");
      if (!artifactEvidence?.files?.data) failures.push("repo-multi-file-edit data file was not present");
      if (!artifactEvidence?.files?.readme) failures.push("repo-multi-file-edit README.md was not created");
      if (!artifactEvidence?.files?.html) failures.push("repo-multi-file-edit status-dashboard.html was not created");
      if (artifactEvidence?.files?.source && artifactEvidence.exportsNormalizeStatus !== true) failures.push("repo-multi-file-edit did not export normalizeStatus");
      if (artifactEvidence?.files?.source && artifactEvidence.exportsSummarizeRecords !== true) failures.push("repo-multi-file-edit did not export summarizeRecords");
      if (artifactEvidence?.files?.source && artifactEvidence.exportsRenderSummaryHtml !== true) failures.push("repo-multi-file-edit did not export renderSummaryHtml");
      if (artifactEvidence?.sourceChangedFromFixture !== true) failures.push("repo-multi-file-edit source was not changed from the failing fixture");
      if (artifactEvidence?.testUnchanged !== true) failures.push("repo-multi-file-edit modified the acceptance test");
      if (artifactEvidence?.dataUnchanged !== true) failures.push("repo-multi-file-edit modified the input data");
      if (artifactEvidence?.testPassed !== true) failures.push("repo-multi-file-edit node:test did not pass after the desktop task");
      if (artifactEvidence?.cliPassed !== true) failures.push("repo-multi-file-edit CLI output did not contain ok=2 needs-review=1 blocked=1");
      if (artifactEvidence?.files?.html && artifactEvidence.htmlComplete !== true) failures.push("repo-multi-file-edit HTML is not a complete HTML document");
      if (artifactEvidence?.files?.html && artifactEvidence.htmlHasChinese !== true) failures.push("repo-multi-file-edit HTML missing Chinese content");
      if (artifactEvidence?.files?.html && artifactEvidence.htmlMentionsStatuses !== true) failures.push("repo-multi-file-edit HTML missing normalized status labels");
      if (artifactEvidence?.files?.html && artifactEvidence.htmlAvoidsObjectObject !== true) failures.push("repo-multi-file-edit HTML leaked [object Object]");
      if (artifactEvidence?.files?.html && artifactEvidence.htmlOffline !== true) failures.push("repo-multi-file-edit HTML used external assets or link/preconnect tags");
      if (artifactEvidence?.files?.readme && artifactEvidence.readmeHasChinese !== true) failures.push("repo-multi-file-edit README missing Chinese content");
      if (artifactEvidence?.files?.readme && artifactEvidence.readmeMentionsCommand !== true) failures.push("repo-multi-file-edit README missing CLI command");
    }
    if (taskMode === "local-project") {
      artifactEvidence = await waitForArtifactEvidence(
        () => verifyLocalProjectArtifact(artifactDir, marker),
        (evidence) => evidence?.files?.indexHtml === true
          && evidence?.files?.readmeMd === true
          && evidence?.files?.doneTxt === true
          && evidence.doneExact === true
          && evidence.indexHasMarker === true
          && evidence.readmeNonEmpty === true,
        Math.min(timeoutMs, 90_000),
      );
      if (!artifactEvidence?.files?.indexHtml) failures.push("local-project index.html was not created");
      if (!artifactEvidence?.files?.readmeMd) failures.push("local-project README.md was not created");
      if (!artifactEvidence?.files?.doneTxt) failures.push("local-project done.txt was not created");
      if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) failures.push("local-project done.txt did not exactly match the marker");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.indexHasMarker !== true) failures.push("local-project index.html did not contain the marker");
      if (artifactEvidence?.files?.readmeMd && artifactEvidence.readmeNonEmpty !== true) failures.push("local-project README.md was empty");
    }
    if (taskMode === "agentic-step-flow") {
      artifactEvidence = await waitForArtifactEvidence(
        () => verifyAgenticStepFlowArtifact(artifactDir, marker),
        (evidence) => evidence?.files?.indexHtml === true
          && evidence?.files?.readmeMd === true
          && evidence?.files?.doneTxt === true
          && evidence?.responseHistory?.markerToolOutputSeen === true,
        Math.min(timeoutMs, 120_000),
      );
      failures.push(...collectAgenticStepFlowFailures(artifactEvidence));
    }
    if (taskMode === "coding-project") {
      artifactEvidence = verifyCodingProjectArtifact(artifactDir, marker);
      if (artifactEvidence?.responseHistory?.markerToolOutputSeen !== true
          || artifactEvidence?.responseHistory?.assistantHasFinalMarker !== true) {
        artifactEvidence = await waitForArtifactEvidence(
          () => verifyCodingProjectArtifact(artifactDir, marker),
          (evidence) => evidence?.files?.packageJson === true
            && evidence?.files?.wordTally === true
            && evidence?.files?.testFile === true
            && evidence?.files?.doneTxt === true
            && evidence?.doneExact === true
            && evidence?.exportsFunction === true
            && evidence?.testPassed === true
            && evidence?.cliPassed === true
            && evidence?.responseHistory?.markerToolOutputSeen === true
            && evidence?.responseHistory?.assistantHasFinalMarker === true,
          Math.min(timeoutMs, 120_000),
        );
      }
      if (!artifactEvidence?.files?.packageJson) failures.push("coding-project package.json was not created");
      if (!artifactEvidence?.files?.wordTally) failures.push("coding-project word-tally.mjs was not created");
      if (!artifactEvidence?.files?.testFile) failures.push("coding-project word-tally.test.mjs was not created");
      if (!artifactEvidence?.files?.doneTxt) failures.push("coding-project done.txt was not created");
      if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) failures.push("coding-project done.txt did not exactly match the marker");
      if (artifactEvidence?.files?.wordTally && artifactEvidence.exportsFunction !== true) failures.push("coding-project did not export tallyWords");
      if (artifactEvidence?.files?.testFile && artifactEvidence.testPassed !== true) failures.push("coding-project node:test did not pass");
      if (artifactEvidence?.files?.wordTally && artifactEvidence.cliPassed !== true) failures.push("coding-project CLI output did not contain red=2 and blue=1");
    }
    if (taskMode === "complex-project" || taskMode === "autonomous-reasoning") {
      artifactEvidence = await waitForArtifactEvidence(
        () => verifyComplexProjectArtifact(artifactDir, marker),
        (evidence) => complexProjectArtifactComplete(evidence, { requireModelLed: complexProjectRequiresModelLed }),
        Math.min(timeoutMs, 240_000),
      );
      if (complexProjectRequiresModelLed && artifactEvidence?.responseHistory?.markerToolOutputSeen !== true) {
        await waitForDesktopToolTurnSettled(ws, marker, Math.min(timeoutMs, 120_000));
        artifactEvidence = verifyComplexProjectArtifact(artifactDir, marker);
      }
      if (!artifactEvidence?.files?.packageJson) failures.push("complex-project package.json was not created");
      if (!artifactEvidence?.files?.analyzer) failures.push("complex-project codex-update-analyzer.mjs was not created");
      if (!artifactEvidence?.files?.testFile) failures.push("complex-project codex-update-analyzer.test.mjs was not created");
      if (!artifactEvidence?.files?.sourcesJson) failures.push("complex-project sources.json was not created");
      if (!artifactEvidence?.files?.reportMd) failures.push("complex-project report.md was not created");
      if (!artifactEvidence?.files?.indexHtml) failures.push("complex-project index.html was not created");
      if (!artifactEvidence?.files?.doneTxt) failures.push("complex-project done.txt was not created");
      if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) failures.push("complex-project done.txt did not exactly match the marker");
      if (artifactEvidence?.files?.analyzer && artifactEvidence.exportsFunction !== true) failures.push("complex-project analyzer did not export summarizeSources");
      if (artifactEvidence?.files?.sourcesJson && artifactEvidence.sourceUrlCount < 3) failures.push("complex-project sources.json had fewer than three source URLs");
      if (artifactEvidence?.files?.sourcesJson && artifactEvidence.trustedSourceUrlCount < 3) failures.push("complex-project sources.json had fewer than three trusted OpenAI source URLs");
      if (artifactEvidence?.files?.testFile && artifactEvidence.testPassed !== true) failures.push("complex-project node:test did not pass");
      if (artifactEvidence?.files?.analyzer && artifactEvidence.cliPassed !== true) failures.push("complex-project CLI output did not prove sourceCount>=3 and codexMentionCount>=1");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMarker !== true) failures.push("complex-project report.md missing marker");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMarker !== true) failures.push("complex-project index.html missing marker");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasChinese !== true) failures.push("complex-project report.md missing Chinese content");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasChinese !== true) failures.push("complex-project index.html missing Chinese content");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasTrustedChinesePhrase !== true) failures.push("complex-project report.md did not preserve required Chinese phrase");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasTrustedChinesePhrase !== true) failures.push("complex-project index.html did not preserve required Chinese phrase");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasLiteralEscapedNewlines === true) failures.push("complex-project report.md contains literal escaped newlines");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasLiteralEscapedNewlines === true) failures.push("complex-project index.html contains literal escaped newlines");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportMentionsCodex !== true) failures.push("complex-project report.md missing Codex/OpenAI content");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlMentionsCodex !== true) failures.push("complex-project index.html missing Codex/OpenAI content");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportUrlCount < 3) failures.push("complex-project report.md has fewer than three source URLs");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlUrlCount < 3) failures.push("complex-project index.html has fewer than three source URLs");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportTrustedUrlCount < 3) failures.push("complex-project report.md has fewer than three trusted OpenAI source URLs");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlTrustedUrlCount < 3) failures.push("complex-project index.html has fewer than three trusted OpenAI source URLs");
      if (artifactEvidence?.files?.reportMd && artifactEvidence?.files?.indexHtml && artifactEvidence.sharedTrustedUrlCount < 1) failures.push("complex-project report.md and index.html did not share a trusted OpenAI source URL");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlComplete !== true) failures.push("complex-project index.html is not a complete HTML document");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlLinksReport !== true) failures.push("complex-project index.html does not link to report.md");
      if (complexProjectRequiresModelLed && artifactEvidence?.responseHistory?.artifactGuardUsed === true) {
        failures.push("complex-project used deterministic artifact guard instead of model-led task execution");
      }
      if (complexProjectRequiresModelLed && (artifactEvidence?.responseHistory?.taskToolCallCount || 0) < 1) {
        failures.push("complex-project did not emit a task tool call");
      }
      if (complexProjectRequiresModelLed && artifactEvidence?.responseHistory?.taskToolOutputSeen !== true) {
        failures.push("complex-project did not observe task tool output");
      }
      if (complexProjectRequiresModelLed && artifactEvidence?.responseHistory?.markerToolOutputSeen !== true) {
        failures.push("complex-project did not observe marker-scoped tool output");
      }
      if (complexProjectRequiresModelLed && artifactEvidence?.responseHistory?.assistantHasFinalMarker !== true) {
        failures.push("complex-project assistant final marker was not observed in response history");
      }
      if (complexProjectRequiresModelLed && (artifactEvidence?.responseHistory?.visibleProgressCount || 0) < 1) {
        failures.push("complex-project did not show visible progress text");
      }
      if (taskMode === "autonomous-reasoning") {
        if ((artifactEvidence?.responseHistory?.taskToolCallCount || 0) < 1) failures.push("autonomous-reasoning did not emit a task tool call");
        if (artifactEvidence?.responseHistory?.taskToolOutputSeen !== true) failures.push("autonomous-reasoning did not observe task tool output");
        if (artifactEvidence?.responseHistory?.artifactGuardUsed === true) failures.push("autonomous-reasoning used deterministic artifact guard");
        if ((artifactEvidence?.responseHistory?.visibleProgressCount || 0) < 1) failures.push("autonomous-reasoning did not show visible progress text");
      }
    }
    if (taskMode === "report-site") {
      artifactEvidence = await waitForArtifactEvidence(
        () => verifyReportSiteArtifact(artifactDir, marker),
        reportSiteArtifactComplete,
        Math.min(timeoutMs, 90_000),
      );
      if (!artifactEvidence?.files?.reportMd) failures.push("report-site report.md was not created");
      if (!artifactEvidence?.files?.indexHtml) failures.push("report-site index.html was not created");
      if (!artifactEvidence?.files?.doneTxt) failures.push("report-site done.txt was not created");
      if (artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) failures.push("report-site done.txt did not exactly match the marker");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMarker !== true) failures.push("report-site report.md missing marker");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMarker !== true) failures.push("report-site index.html missing marker");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasChinese !== true) failures.push("report-site report.md missing Chinese content");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasChinese !== true) failures.push("report-site index.html missing Chinese content");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportHasMojibake === true) failures.push("report-site report.md contains likely Chinese mojibake");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlHasMojibake === true) failures.push("report-site index.html contains likely Chinese mojibake");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportMentionsCodex !== true) failures.push("report-site report.md missing Codex/OpenAI content");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlMentionsCodex !== true) failures.push("report-site index.html missing Codex/OpenAI content");
      if (artifactEvidence?.files?.reportMd && artifactEvidence.reportUrlCount < 3) failures.push("report-site report.md has fewer than three source URLs");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlUrlCount < 3) failures.push("report-site index.html has fewer than three source URLs");
      if (artifactEvidence?.files?.reportMd && artifactEvidence?.files?.indexHtml && artifactEvidence.sharedUrlCount < 1) failures.push("report-site report.md and index.html did not share a source URL");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlComplete !== true) failures.push("report-site index.html is not a complete HTML document");
      if (artifactEvidence?.files?.indexHtml && artifactEvidence.htmlLinksReport !== true) failures.push("report-site index.html does not link to report.md");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  let repairPrompt = null;
  let repairTurn = null;
  let preRepairFailures = [];
  let preRepairArtifactEvidence = null;
  let finalArtifactFailures = [];
  let autonomousContinuationNewChatEvidence = null;
  if (taskMode === "report-site") {
    const artifactFailures = collectReportSiteArtifactFailures(artifactEvidence);
    if (failuresAreOnlyArtifactFailures(failures, artifactFailures)) {
      preRepairFailures = failures.slice();
      preRepairArtifactEvidence = artifactEvidence;
      repairPrompt = buildReportSiteRepairPrompt(artifactFailures, artifactEvidence);
      repairTurn = await submitDesktopPromptAndWait(ws, repairPrompt, marker, timeoutMs, { requiresProjectChat });
      artifactEvidence = verifyReportSiteArtifact(artifactDir, marker);
      finalArtifactFailures = collectReportSiteArtifactFailures(artifactEvidence);
    }
  }
  if (taskMode === "complex-project") {
    const artifactFailures = collectComplexProjectArtifactFailures(artifactEvidence, { requireModelLed: complexProjectRequiresModelLed });
    const agenticFailures = collectAgenticResponseHistoryFailures("complex-project", artifactEvidence, false);
    const uiMarkerFailures = failures.filter((failure) => /assistant reply marker was not observed/i.test(String(failure || "")));
    const repairableFailures = Array.from(new Set([...artifactFailures, ...agenticFailures, ...uiMarkerFailures]));
    if (repairableFailures.length > 0) {
      preRepairFailures = failures.slice();
      preRepairArtifactEvidence = artifactEvidence;
      repairPrompt = buildComplexProjectRepairPrompt(repairableFailures, artifactEvidence);
      repairTurn = await submitDesktopPromptAndWait(ws, repairPrompt, marker, timeoutMs, { requiresProjectChat });
      artifactEvidence = await waitForArtifactEvidence(
        () => verifyComplexProjectArtifact(artifactDir, marker),
        (evidence) => complexProjectArtifactComplete(evidence, { requireModelLed: complexProjectRequiresModelLed }),
        Math.min(timeoutMs, 120_000),
      );
      finalArtifactFailures = collectComplexProjectArtifactFailures(artifactEvidence, { requireModelLed: complexProjectRequiresModelLed });
    }
  }
  if (taskMode === "autonomous-reasoning") {
    const historyConfirmedFailures = filterUiMarkerFailuresWhenResponseHistoryConfirmsCompletion(failures, artifactEvidence);
    failures.length = 0;
    failures.push(...historyConfirmedFailures);
    for (let continuationIndex = 0; continuationIndex < 2; continuationIndex += 1) {
      const artifactFailures = collectComplexProjectArtifactFailures(artifactEvidence, { requireModelLed: complexProjectRequiresModelLed });
      const toolFailures = failures.filter((failure) => /autonomous-reasoning did not|assistant reply marker was not observed|send click did not submit/i.test(String(failure || "")));
      const currentFailures = [...artifactFailures, ...toolFailures];
      const canContinue = currentFailures.length > 0
        && failures.every((failure) => artifactFailures.includes(failure) || toolFailures.includes(failure));
      if (!canContinue) break;
      if (preRepairFailures.length === 0) {
        preRepairFailures = failures.slice();
        preRepairArtifactEvidence = artifactEvidence;
      }
      repairPrompt = buildAutonomousReasoningContinuationPrompt(currentFailures, artifactEvidence);
      try {
        await resetBackendSessionLock(baseUrl);
        const clickedNewChat = await ws.send("Runtime.evaluate", {
          expression: newChatClickExpression(requiresProjectChat ? projectChatLabel : ""),
          returnByValue: true,
          awaitPromise: true,
        });
        autonomousContinuationNewChatEvidence = clickedNewChat.result?.result?.value || null;
        autonomousContinuationNewChatEvidence.visibleIdleAfterNewChat = await waitForVisibleComposerIdle(ws, 20_000);
      } catch (error) {
        autonomousContinuationNewChatEvidence = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      repairTurn = await submitDesktopPromptAndWait(ws, repairPrompt, marker, timeoutMs, { requiresProjectChat, maxInputItems: 80 });
      artifactEvidence = verifyComplexProjectArtifact(artifactDir, marker);
      finalArtifactFailures = collectComplexProjectArtifactFailures(artifactEvidence);
      if ((artifactEvidence?.responseHistory?.taskToolCallCount || 0) < 1) finalArtifactFailures.push("autonomous-reasoning did not emit a task tool call");
      if (artifactEvidence?.responseHistory?.taskToolOutputSeen !== true) finalArtifactFailures.push("autonomous-reasoning did not observe task tool output");
      if (artifactEvidence?.responseHistory?.artifactGuardUsed === true) finalArtifactFailures.push("autonomous-reasoning used deterministic artifact guard");
      if ((artifactEvidence?.responseHistory?.visibleProgressCount || 0) < 1) finalArtifactFailures.push("autonomous-reasoning did not show visible progress text");
      const effectiveRepairFailures = filterUiMarkerFailuresWhenHistoryConfirmsCompletion(
        repairTurn.failures,
        finalArtifactFailures,
        artifactEvidence,
      );
      failures.length = 0;
      failures.push(...effectiveRepairFailures);
      failures.push(...finalArtifactFailures);
      if (failures.length === 0) break;
    }
  }
  if (repairTurn) {
    const repairFailurePrefix = taskMode === "report-site"
      ? "report-site repair-step"
      : taskMode === "autonomous-reasoning"
        ? "autonomous-reasoning continuation-step"
        : "complex-project repair-step";
    const effectiveRepairFailures = taskMode === "autonomous-reasoning"
      ? filterUiMarkerFailuresWhenHistoryConfirmsCompletion(repairTurn.failures, finalArtifactFailures, artifactEvidence)
      : repairTurn.failures;
    failures.length = 0;
    failures.push(...effectiveRepairFailures.map((failure) => `${repairFailurePrefix}: ${failure}`));
    failures.push(...finalArtifactFailures);
    clicked = clicked === true && repairTurn.clicked === true;
    submitEvidence = repairTurn.submitEvidence;
    submitSucceeded = submitSucceeded === true && repairTurn.submitSucceeded === true;
    count = Number(count || 0) + Number(repairTurn.markerCount || 0);
    answerMarkerCount = Number(repairTurn.answerMarkerCount || 0);
    composer = repairTurn.composer || "";
    lastSample = repairTurn.lastSample || lastSample;
    answerSample = repairTurn.answerSample || answerSample;
    activeReconnectSeen = activeReconnectSeen === true || repairTurn.activeReconnectSeen === true;
    activeReconnectEvidence.push(...(repairTurn.activeReconnectEvidence || []));
    inLoopIdleDiagnostics = repairTurn.inLoopIdleDiagnostics || inLoopIdleDiagnostics;
  }

  if (taskMode === "complex-project" && !repairTurn) {
    pushUniqueFailures(failures, collectComplexProjectArtifactFailures(artifactEvidence, { requireModelLed: complexProjectRequiresModelLed }));
  }

  if (["coding-project", "multi-turn-project", "report-site", "complex-project", "repo-multi-file-edit"].includes(taskMode)) {
    pushUniqueFailures(failures, collectAgenticResponseHistoryFailures(taskMode, artifactEvidence, Boolean(repairPrompt)));
    const effectiveFailures = filterUiMarkerFailuresWhenResponseHistoryConfirmsCompletion(failures, artifactEvidence);
    failures.length = 0;
    failures.push(...effectiveFailures);
    if (taskMode === "report-site") {
      const reportSiteEffectiveFailures = filterReportSiteUiCompletionFailures(failures, artifactEvidence, answerMarkerCount);
      failures.length = 0;
      failures.push(...reportSiteEffectiveFailures);
    }
  }

  if (taskMode === "agentic-step-flow") {
    const artifactFailures = collectAgenticStepFlowFailures(artifactEvidence);
    pushUniqueFailures(failures, artifactFailures);
    if (artifactFailures.length === 0) {
      const effectiveFailures = filterUiMarkerFailuresWhenResponseHistoryConfirmsCompletion(failures, artifactEvidence);
      failures.length = 0;
      failures.push(...effectiveFailures);
    }
  }

  const idleTimeoutMs = taskMode === "local-project" || taskMode === "coding-project" || taskMode === "multi-turn-project" || taskMode === "complex-project" || taskMode === "autonomous-reasoning" || taskMode === "report-site" || taskMode === "agentic-step-flow" || taskMode === "repo-file-edit" || taskMode === "repo-multi-file-edit" ? 60_000 : 20_000;
  const idleResult = inLoopIdleDiagnostics
    ? { diagnostics: inLoopIdleDiagnostics, lastError: null }
    : await waitForIdleDiagnostics(baseUrl, idleTimeoutMs);
  diagnostics = idleResult.diagnostics;
  if (!diagnostics) {
    failures.push(`diagnostics endpoint did not respond after desktop task: ${idleResult.lastError || "unknown error"}`);
  } else if (!diagnosticsAreIdle(diagnostics)) {
    failures.push("desktop task did not become idle after the assistant reply");
  }
  const sessionLock = diagnostics?.antigravitySessionLock || null;
  const activeRequests = diagnostics?.activeAntigravityRequests || null;
  const queue = diagnostics?.antigravityQueue || null;
  if (sessionLock?.active === true) failures.push("desktop task left the Antigravity session lock active");
  if (Number(sessionLock?.queued || 0) > 0) failures.push("desktop task left queued Antigravity sessions");
  if (Number(activeRequests?.active || 0) > 0) failures.push("desktop task left active Antigravity requests");
  if (queue?.running === true) failures.push("desktop task left the Antigravity request queue running");
  modelRouteEvidence = await collectModelRouteEvidence(modelRoutesBefore);
  failures.push(...collectRequiredModelFailures(modelRouteEvidence, diagnostics));
  pushUniqueFailures(failures, collectAgenticResponseHistoryFailures(taskMode, artifactEvidence, Boolean(repairPrompt)));
  if (taskMode === "report-site") {
    const reportSiteEffectiveFailures = filterReportSiteUiCompletionFailures(failures, artifactEvidence, answerMarkerCount);
    failures.length = 0;
    failures.push(...reportSiteEffectiveFailures);
  }
  if (taskMode === "complex-project") {
    const complexProjectEffectiveFailures = filterComplexProjectUiCompletionFailures(failures, artifactEvidence);
    failures.length = 0;
    failures.push(...complexProjectEffectiveFailures);
  }
  const observedModelRoute = desktopRealTrafficObserved(modelRouteEvidence);
  const observedRequestPayload = desktopRequestPayloadObserved(diagnostics);
  const observedRealTraffic = observedModelRoute || observedRequestPayload;
  if (!observedRequestPayload) failures.push("desktop submit did not produce a model request payload");
  const payload = {
    ok: failures.length === 0,
    reportName,
    requestedRealTraffic: true,
    usedRealTraffic: observedRealTraffic,
    modelRouteObserved: observedModelRoute,
    modelRequestPayloadObserved: observedRequestPayload,
    behaviorCovered: true,
    coverageKind: observedRealTraffic ? "desktop-ui-real-traffic" : "desktop-ui-submit-without-request",
    taskMode,
    promptText,
    promptLanguage,
    followupPromptText,
    followupPromptLanguage,
    requiredModel: requiredModel || null,
    requiredModelLabel: requiredModelLabel || null,
    configModelOverrideEvidence,
    repairPrompt,
    elapsedMs: Date.now() - startedAt,
    failures,
    marker,
    artifactDir: taskMode === "repo-file-edit"
      ? repoFileEditDir
      : taskMode === "repo-multi-file-edit"
        ? repoMultiFileEditDir
      : taskMode === "local-project" || taskMode === "coding-project" || taskMode === "multi-turn-project" || taskMode === "complex-project" || taskMode === "autonomous-reasoning" || taskMode === "report-site" || taskMode === "agentic-step-flow" ? artifactDir : null,
    artifactEvidence,
    preRepairFailures,
    preRepairArtifactEvidence,
    repairAttempted: Boolean(repairPrompt),
    repairTurn: repairTurn ? {
      ok: repairTurn.ok,
      marker: repairTurn.marker,
      clicked: repairTurn.clicked,
      submitSucceeded: repairTurn.submitSucceeded,
      answerMarkerCount: repairTurn.answerMarkerCount,
      artifactCompletionObserved: repairTurn.artifactCompletionObserved,
      composerCleared: repairTurn.composerCleared,
      activeReconnectSeen: repairTurn.activeReconnectSeen,
      inLoopIdleObserved: repairTurn.inLoopIdleObserved,
      failures: repairTurn.failures,
      timing: repairTurn.timing || null,
    } : null,
    cdpPort,
    baseUrl,
    target: target ? { id: target.id, title: target.title, url: target.url } : null,
    prep,
    submitEvidence,
    submitSucceeded,
    staleRecovery,
    backendResetBeforeSubmit,
    newChatEvidence,
    autonomousContinuationNewChatEvidence,
      modelSelectionEvidence,
      preSubmitModelSelectionEvidence,
      initialIdleObserved: Boolean(initialIdle?.diagnostics),
    clicked,
    markerCount: count,
    answerMarkerCount,
    responseHistoryMarkerSeen: responseHistoryContains(marker),
    responseHistoryPath,
    activeReconnectSeen,
    activeReconnectEvidence,
    inLoopIdleObserved: Boolean(inLoopIdleDiagnostics),
    composerCleared: !composer.includes(marker),
    sessionLockClear: sessionLock ? sessionLock.active !== true && Number(sessionLock.queued || 0) === 0 : false,
    lastSample,
    antigravitySessionLock: sessionLock,
    activeAntigravityRequests: activeRequests,
    antigravityQueue: queue,
    modelRouteEvidence,
    responsesWebSocket: diagnostics?.responsesWebSocket || null,
    networkEvents: ws ? summarizeNetworkEvents(ws.events || []) : [],
    timing: {
      submitCompletedAt: submitCompletedAt ? new Date(submitCompletedAt).toISOString() : null,
      firstReplySeenAt: firstReplySeenAt ? new Date(firstReplySeenAt).toISOString() : null,
      idleCompletedAt: idleCompletedAt ? new Date(idleCompletedAt).toISOString() : null,
      submitMs: submitCompletedAt ? submitCompletedAt - (startedAt) : null,
      firstReplyMs: firstReplySeenAt && submitCompletedAt ? firstReplySeenAt - submitCompletedAt : null,
      idleWaitMs: idleCompletedAt && firstReplySeenAt ? idleCompletedAt - firstReplySeenAt : null,
    },
  };
  releaseUiLock?.();
  releaseUiLock = null;
  restoreConfigModelOverride();
  writeReport(payload);
  releaseUiLock?.();
  console.log(JSON.stringify(payload));
  if (!payload.ok) process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  const payload = {
    ok: false,
    reportName,
    usedRealTraffic: true,
    behaviorCovered: true,
    coverageKind: "desktop-ui-real-traffic",
    taskMode,
    promptText,
    promptLanguage,
    followupPromptText,
    followupPromptLanguage,
    requiredModel: requiredModel || null,
    requiredModelLabel: requiredModelLabel || null,
    configModelOverrideEvidence,
    elapsedMs: Date.now() - startedAt,
    failures: [error instanceof Error ? error.message : String(error)],
    marker,
    artifactDir: taskMode === "repo-file-edit"
      ? repoFileEditDir
      : taskMode === "repo-multi-file-edit"
        ? repoMultiFileEditDir
      : taskMode === "local-project" || taskMode === "coding-project" || taskMode === "multi-turn-project" || taskMode === "complex-project" || taskMode === "autonomous-reasoning" || taskMode === "report-site" || taskMode === "agentic-step-flow" ? artifactDir : null,
    timing: null,
  };
  restoreConfigModelOverride();
  writeReport(payload);
  console.log(JSON.stringify(payload));
  process.exit(1);
});
