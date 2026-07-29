#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceStableIdleWindow,
  assistantMessageIsVisibleProgress,
  autonomousContinuationHasFreshCompletion,
  classifyReconnectOutcome,
  codexLikeAgentProcessProven,
  collectCodexRolloutMarkerEvidence,
  composerHasUnsubmittedMarker,
  countMarkerOccurrences,
  countNewAssistantMarkers,
  countObservedAssistantMarkers,
  countUniqueAssistantMarkerMessages,
  filterAssistantMarkerObservationFailures,
  freshDesktopTurnConfirmsSubmit,
  hasAssistantFinalMarkerEvidence,
  latestMarkerTurnCompleted,
  multiTurnFirstTurnReadyForFollowup,
  parseWordCountCliOutput,
  pendingDesktopTaskConfirmsSubmit,
  repoMultiTurnCompletionReady,
  resultDrivenTurnCompletionReady,
  responsesPayloadAdvanceConfirmsSubmit,
  shouldRecoverIdleAutonomousTurn,
  stableIdleTimeoutForTaskMode,
  stableIdleWindowReady,
  taskScopedToolOutputObserved,
  utf8BytesExactlyMatch,
} from "./lib/ui-chat-marker-evidence.mjs";
import {
  analyzeNativeCodexActivityRows,
  readNativeCodexRequestSnapshot,
  nativeExpectedRequestObserved,
  readNativeCodexActivityRows,
  waitForNativeCodexRequestQuiet,
} from "./lib/anticodex-native-request-activity.mjs";
import {
  diffProtectedTreeSnapshots,
  snapshotProtectedTree,
} from "./lib/protected-tree-evidence.mjs";

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
  --project-root <path>    Activate this existing directory as the native Codex project before a new task.
  --artifact-dir <path>    Directory for task artifacts.
  --prompt-file <path>     UTF-8 prompt file.
  --followup-prompt-file <path>  UTF-8 second-turn prompt file for multi-turn-project.
  --followup-prompt <text>       Inline second-turn prompt for multi-turn-project.
  --report-name <name>     Isolated report name for a custom scenario.
  --required-file <path>   Require this file to be newly created or updated and non-empty.
  --required-file-contains <a|b>  Require every pipe-separated UTF-8 string in the file.
  --required-file-authoritative  For follow-up local-project turns, validate the marker in --required-file instead of reusing the first-turn done/index marker contract.
  --protect-root <path>    Fail if anything except --required-file changes below this directory.
  --result-driven-completion      Accept the current native Codex task-complete event; final text markers stay diagnostic.
  --require-native-single-task    Require native Codex request quiet before submit and reject hidden tool execution.
  --same-chat              Reuse the current chat instead of opening an isolated chat.
  --same-chat-title-contains <text>  Reopen an existing task whose visible title contains this text.
  --expected-task-id <id>    Bind a no-traffic same-task model probe to the exact native task id.
  --expected-original-codex-pid <pid>  Require the original Codex process to remain alive.
  --expected-anticodex-main-pid <pid>  Bind evidence to the current Anti-Codex main process.
  --expected-supervisor-pid <pid>      Bind evidence to the current fixed-route supervisor.
  --expected-codexplusplus-pid <pid>   Bind evidence to the current CodexPlusPlus process.
  --navigate-away-before-history-reopen  Open a blank new task before reopening --same-chat-title-contains.
  --require-history-responsive       Fail when reopening history exceeds the configured budget.
  --history-open-budget-ms <ms>      Maximum history click-to-interactive time (default: 3000).
  --history-probe-only               Reopen and time an existing task without submitting model traffic.
  --frontend-model-probe-only        Physically select --model in the current task without submitting model traffic.
  --single-submit-handoff            Create one fresh exact-marker task, submit once, write a bounded startup receipt, then exit.
  --force-reset-same-chat  Allow stale recovery to interrupt/reset a reused chat.
  --workspace-command <command>  No-traffic workspace command (restore only).
  --workspace-state-file <path>  Workspace snapshot JSON used by --workspace-command restore.
  --help, -h               Show this help message without starting UI work.`);
  process.exit(0);
}

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptRoot, "..");
let cdpPort = Number(args.get("--cdp-port") || process.env.DEEPCODEX_CDP_PORT || 0);
const baseUrl = String(args.get("--base-url") || process.env.TRANSLATOR_URL || "http://127.0.0.1:8484").replace(/\/$/, "");
const diagnosticsUrl = `${baseUrl}/anticodex/diagnostics?fast=1`;
const modelRoutesUrl = `${baseUrl}/anticodex/model-routes`;
const fixedRouteHealthUrl = String(args.get("--fixed-route-health-url")
  || process.env.ANTICODEX_FIXED_ROUTE_HEALTH_URL
  || "http://127.0.0.1:18487/anticodex/fixed-route/health").replace(/\/$/, "");
const timeoutMs = Math.max(15_000, Number(args.get("--timeout-ms") || 90_000));
const DESKTOP_SUBMIT_REQUEST_GRACE_MS = 70_000;
const SINGLE_SUBMIT_EVIDENCE_MS = 25_000;
const reportRoot = resolve(args.get("--report-root") || join(process.env.APPDATA || os.tmpdir(), "anticodex", "reports"));
const responseHistoryPath = resolve(process.env.APPDATA || os.tmpdir(), "anticodex", "response-history.json");
const taskMode = String(args.get("--task-mode") || "exact-marker");
const singleSubmitHandoff = args.has("--single-submit-handoff");
const resultDrivenCompletionEnabled = args.has("--result-driven-completion");
const requireNativeSingleTask = args.has("--require-native-single-task");
const requiredModel = String(args.get("--model") || args.get("--required-model") || process.env.ANTICODEX_TEST_MODEL || "").trim();
let requiredModelLabel = String(args.get("--model-label") || args.get("--required-model-label") || "").trim();
const configModelOverrideEnabled = requiredModel && !args.has("--no-config-model-override");
const anticodexStateRoot = resolve(process.env.DEEPCODEX_STATE_ROOT || join(process.env.APPDATA || os.tmpdir(), "anticodex"));
const anticodexCodexHome = resolve(process.env.ANTICODEX_CODEX_HOME || join(anticodexStateRoot, "codex-home-deepseek-app"));
const anticodexConfigPath = resolve(anticodexCodexHome, "config.toml");
const anticodexModelCatalogPath = resolve(anticodexCodexHome, "deepseek-model-catalog.json");
const codexRolloutRoot = resolve(anticodexCodexHome, "sessions");
const codexPlusPlusLogPath = resolve(anticodexStateRoot, "codexplusplus", "codex-plus.log");
if (!requiredModelLabel && requiredModel && existsSync(anticodexModelCatalogPath)) {
  try {
    const catalog = JSON.parse(readFileSync(anticodexModelCatalogPath, "utf8").replace(/^\uFEFF/, ""));
    const matchedModel = Array.isArray(catalog?.models)
      ? catalog.models.find((model) => model?.slug === requiredModel)
      : null;
    requiredModelLabel = String(matchedModel?.display_name || "").trim();
  } catch {
    // Route verification still works with the model slug when the catalog is unreadable.
  }
}
const sameChatTitleContains = String(args.get("--same-chat-title-contains") || "").trim();
const expectedTaskId = String(args.get("--expected-task-id") || "").trim();
const navigateAwayBeforeHistoryReopen = args.has("--navigate-away-before-history-reopen");
const isolateChat = !(args.has("--same-chat") || sameChatTitleContains);
const preserveSameChatActiveTask = !isolateChat && !args.has("--force-reset-same-chat");
const requireHistoryResponsive = args.has("--require-history-responsive");
const historyOpenBudgetMs = Math.max(250, Number(args.get("--history-open-budget-ms") || 3_000));
const historyProbeOnly = args.has("--history-probe-only");
const frontendModelProbeOnly = args.has("--frontend-model-probe-only");
if (frontendModelProbeOnly && !expectedTaskId) {
  throw new Error("--frontend-model-probe-only requires --expected-task-id");
}
const customBaseReportName = String(args.get("--report-name") || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 100);
const baseReportName = customBaseReportName || (singleSubmitHandoff
  ? "ui-single-submit-handoff"
  : taskMode === "web-search"
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
  : "ui-chat-smoke");
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
const projectChatRoot = args.get("--project-root") ? resolve(String(args.get("--project-root"))) : "";
const workspaceCommand = String(args.get("--workspace-command") || "").trim().toLowerCase();
const workspaceStateFile = args.get("--workspace-state-file")
  ? resolve(String(args.get("--workspace-state-file")))
  : "";
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
const followupPromptFile = args.get("--followup-prompt-file") ? resolve(String(args.get("--followup-prompt-file"))) : "";
const followupPromptFromFile = followupPromptFile ? readFileSync(followupPromptFile, "utf8") : "";
const customFollowupPromptText = String(followupPromptFromFile || args.get("--followup-prompt") || "").trim();
const singleSubmitForbiddenArgs = [
  "--same-chat",
  "--same-chat-title-contains",
  "--followup-prompt-file",
  "--followup-prompt",
  "--prompt",
  "--force-reset-same-chat",
  "--navigate-away-before-history-reopen",
  "--history-probe-only",
  "--frontend-model-probe-only",
  "--workspace-command",
  "--result-driven-completion",
];
if (singleSubmitHandoff && taskMode !== "exact-marker") {
  throw new Error("--single-submit-handoff requires --task-mode exact-marker");
}
if (singleSubmitHandoff) {
  const forbidden = singleSubmitForbiddenArgs.filter((name) => args.has(name));
  if (forbidden.length > 0) {
    throw new Error(`--single-submit-handoff cannot be combined with ${forbidden.join(", ")}`);
  }
  if (!args.get("--project-root") || !args.get("--prompt-file") || !args.get("--model")) {
    throw new Error("--single-submit-handoff requires --project-root, --prompt-file, and --model");
  }
  if (!String(promptFromFile || "").trim()) {
    throw new Error("--single-submit-handoff requires a non-empty UTF-8 --prompt-file");
  }
  if (!requireNativeSingleTask) {
    throw new Error("--single-submit-handoff requires --require-native-single-task");
  }
}
const requiredFile = args.get("--required-file") ? resolve(String(args.get("--required-file"))) : "";
const requiredFileContains = String(args.get("--required-file-contains") || "")
  .split("|")
  .map(value => value.trim())
  .filter(Boolean);
const requiredFileAuthoritative = args.has("--required-file-authoritative");
if (requiredFileAuthoritative && (!requiredFile || !requiredFileContains.includes(marker))) {
  throw new Error("--required-file-authoritative requires --required-file and the exact marker in --required-file-contains.");
}
const requiredFileBefore = requiredFile && existsSync(requiredFile)
  ? { exists: true, size: statSync(requiredFile).size, mtimeMs: statSync(requiredFile).mtimeMs }
  : { exists: false, size: 0, mtimeMs: 0 };

function requiredFileCompletionReady() {
  if (!requiredFileAuthoritative) return true;
  if (!requiredFile || !existsSync(requiredFile)) return false;
  const current = statSync(requiredFile);
  const changed = !requiredFileBefore.exists
    || current.size !== requiredFileBefore.size
    || current.mtimeMs > requiredFileBefore.mtimeMs;
  if (!changed || current.size <= 0) return false;
  const contents = readFileSync(requiredFile, "utf8");
  return requiredFileContains.every((value) => contents.includes(value));
}
const protectedRoot = args.get("--protect-root") ? resolve(String(args.get("--protect-root"))) : "";
if (protectedRoot && requiredFile) {
  const requiredRelative = relative(protectedRoot, requiredFile);
  if (requiredRelative === "" || requiredRelative === ".." || requiredRelative.startsWith(`..${sep}`) || isAbsolute(requiredRelative)) {
    throw new Error("--required-file must be a file below --protect-root.");
  }
}
const protectedRootBefore = protectedRoot
  ? snapshotProtectedTree(protectedRoot, { ignoredPaths: requiredFile ? [requiredFile] : [] })
  : null;

function collectProtectedRootEvidence() {
  if (!protectedRootBefore) return null;
  try {
    const after = snapshotProtectedTree(protectedRoot, { ignoredPaths: requiredFile ? [requiredFile] : [] });
    return {
      root: protectedRoot,
      ignoredPath: requiredFile || null,
      ...diffProtectedTreeSnapshots(protectedRootBefore, after),
    };
  } catch (error) {
    return {
      root: protectedRoot,
      ignoredPath: requiredFile || null,
      ok: false,
      beforeFingerprint: protectedRootBefore.fingerprint,
      afterFingerprint: "",
      added: [],
      removed: [],
      changed: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
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
    `2. 然后用工具创建 index.html、README.md、done.txt 三个文件。index.html 要包含中文标题“多阶段执行验证”和标记 ${marker}；README.md 要说明三个文件；done.txt 的原始 UTF-8 字节必须只包含 ${marker}，不能有 BOM、回车或换行。请用 [System.IO.File]::WriteAllText 和 New-Object System.Text.UTF8Encoding($false) 写 done.txt，不要用 Set-Content、Out-File 或重定向。`,
    "3. 文件创建后，在可见回复里单独写一行：阶段2：准备验证文件。",
    `4. 然后用工具按原始字节验证 done.txt 完全等于 ${marker}，并检查 index.html 包含“多阶段执行验证”。`,
    `5. 验证后，在最后一行只写：${marker}`,
    "",
    "不要查看 Antigravity brain、transcript、history 或 log 目录。不要创建其他文件。",
  ].join("\n");
}
if (!hasCustomPrompt && taskMode === "coding-project") {
  promptText = `请在 ${artifactDir} 里创建一个很小的 Node.js CLI 项目。只用 PowerShell 文件命令创建这些文件：package.json、word-tally.mjs、word-tally.test.mjs、done.txt，不要多建文件。不要查看 Antigravity brain、transcript、history 或 log 目录。word-tally.mjs 必须导出 tallyWords(text) 函数，并且作为 CLI 运行时把命令行参数当作待统计文本，不要把参数当作文件路径；运行 node word-tally.mjs "red blue red" 时必须打印包含 {"red":2,"blue":1} 的 JSON。word-tally.test.mjs 必须使用 node:test，并断言 "red blue red" 返回 red=2、blue=1。done.txt 必须只包含 ${marker}，请用 [System.IO.File]::WriteAllText 写 UTF8Encoding(false)，不能有 BOM 或换行；不要用 Set-Content 写 done.txt。运行 node --test word-tally.test.mjs 和 node word-tally.mjs "red blue red"。最后必须运行 Get-Content done.txt 并让工具输出显示完整标记 ${marker}，核对后最后回复 ${marker}。`;
}
if (!hasCustomPrompt && taskMode === "multi-turn-project") {
  promptText = `请在 ${artifactDir} 里创建一个很小的 Node.js CLI 项目。这是两轮任务的第 1 轮。只用 PowerShell 文件命令创建这些文件：package.json、word-tally.mjs、word-tally.test.mjs、done.txt，不要多建文件。不要查看 Antigravity brain、transcript、history 或 log 目录。word-tally.mjs 必须导出 tallyWords(text)，并且作为 CLI 运行时打印 JSON 单词计数。word-tally.test.mjs 必须使用 node:test，并断言 "red blue red" 返回 red=2、blue=1。done.txt 的原始字节必须只包含 ${marker}_FIRST，不能有 UTF-8 BOM、回车或换行；用 [System.IO.File]::WriteAllText 和 New-Object System.Text.UTF8Encoding($false) 写入，不能用 Set-Content、Out-File 或重定向写 done.txt。运行 node --test word-tally.test.mjs 和 node word-tally.mjs "red blue red"，再按原始字节验证 done.txt，核对输出后，最后回复 ${marker}_FIRST。`;
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
    "codex-update-analyzer.mjs 必须同时导出 analyze(filePath) 和 summarizeSources(filePath)，must define stripUtf8Bom(text)，两者都读取 UTF-8 sources.json、在 JSON.parse 前移除可选 BOM，并返回 sourceCount 和 codexMentionCount。CLI 必须打印这两个字段组成的 JSON。",
    "codex-update-analyzer.test.mjs 必须使用 node:test，并分别断言 analyze 和 summarizeSources 对 3 条 sources 都得到 sourceCount=3。",
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
    "- 只能保留上面 7 个交付文件；不得创建 setup.js、analyzer.js、test.js、summary.json 或任何第 8 个文件。",
    "- codex-update-analyzer.mjs 必须同时导出 analyze(filePath) 和 summarizeSources(filePath)；两者都读取 UTF-8 sources.json、移除可选 BOM，并返回数字字段 sourceCount 和 codexMentionCount。CLI 也必须把这两个字段组成的单个 JSON 对象打印到标准输出。",
    "- 一个 node:test 测试文件，分别验证 analyze 和 summarizeSources 至少能统计 3 条来源。",
    "- sources.json 必须是对象数组，每项形如 {\"title\":\"Codex\",\"url\":\"https://openai.com/codex/\"}，至少 3 项，且每个 url 的域名必须是 openai.com 或其子域名；另外两项可使用 https://openai.com/news/、https://developers.openai.com/codex/。",
    "- 一份中文 report.md，说明你的结论，包含精确短语“真实来源”、上面的 3 条 URL 和最终标记。",
    "- 一个离线 index.html，中文展示分析结果，链接 report.md，包含精确短语“真实来源”、上面的 3 条 URL 和最终标记。",
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
  const values = [requiredModel, requiredModelLabel].filter(Boolean);
  const gptDisplayAliases = values
    .filter((value) => /^gpt[- ]\d/i.test(String(value)))
    .map((value) => String(value).replace(/^gpt[- ]/i, ""))
    .filter(Boolean);
  values.push(...gptDisplayAliases);
  if (values.some((value) => /^gpt[- ]oss\b/i.test(String(value)))) {
    values.push(...values.map((value) => String(value).replace(/^gpt[- ]/i, "")).filter(Boolean));
  }
  return [...new Set(values)];
}

function turnSubmitModelValues(turns = []) {
  const values = [];
  for (const turn of turns.filter(Boolean)) {
    const submit = turn?.submitEvidence || turn;
    for (const evidence of [submit?.realSubmit, submit?.retryRealSubmit, submit?.nativeSubmit]) {
      values.push(...(Array.isArray(evidence?.observedModels) ? evidence.observedModels : []));
    }
  }
  return values.filter(Boolean).map(String);
}

function collectRequiredModelFailures(modelRouteEvidence, diagnostics, turns = []) {
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
    ...turnSubmitModelValues(turns),
  );
  if (actualValues.some((value) => modelValueMatches(value, expected))) return [];
  const compactActual = actualValues.filter(Boolean).map(String).slice(0, 8).join(", ") || "none";
  return [`desktop task did not route through required model ${expected.join(" / ")}; observed ${compactActual}`];
}

function desktopRealTrafficObserved(modelRouteEvidence, turns = []) {
  if (Number(modelRouteEvidence?.newRouteCount || 0) > 0) return true;
  return turns.filter(Boolean).some((turn) => {
    const submit = turn?.submitEvidence || turn;
    return submit?.realSubmit?.ok === true
      || submit?.retryRealSubmit?.ok === true
      || submit?.nativeSubmit?.ok === true;
  });
}

function desktopRequestPayloadObserved(diagnostics) {
  const ws = diagnostics?.responsesWebSocket || null;
  const payload = ws?.lastClientPayload || null;
  const relay = ws?.lastRelay || null;
  if (payload?.requestKind === "task_title" || relay?.requestKind === "task_title") return false;
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
    if (submit?.realSubmit?.ok === true
      || submit?.retryRealSubmit?.ok === true
      || submit?.nativeSubmit?.ok === true) return true;
  }
  return false;
}

function responsesWebSocketPayloadCount(diagnostics) {
  return Number(diagnostics?.responsesWebSocket?.clientPayloads || 0);
}

function diagnosticsHasRealResponsesSubmitAfter(diagnostics, beforePayloadCount = 0) {
  const ws = diagnostics?.responsesWebSocket || null;
  const payload = ws?.lastClientPayload || null;
  const relay = ws?.lastRelay || null;
  const requestKind = payload?.requestKind === "task_title" || relay?.requestKind === "task_title"
    ? "task_title"
    : payload?.requestKind || relay?.requestKind || "";
  return responsesPayloadAdvanceConfirmsSubmit({
    beforePayloadCount,
    currentPayloadCount: responsesWebSocketPayloadCount(diagnostics),
    requestKind,
    latestUserChars: payload?.latestUserChars,
    inputItems: payload?.inputItems,
    relayTextDeltaChars: relay?.textDeltaChars,
    relayToolCallCount: Array.isArray(relay?.toolCallNames) ? relay.toolCallNames.length : 0,
  });
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

function diagnosticsShowsActiveTask(diagnostics) {
  return diagnostics?.antigravitySessionLock?.active === true
    || Number(diagnostics?.activeAntigravityRequests?.active || 0) > 0
    || diagnostics?.antigravityQueue?.running === true;
}

function realSubmitInputItems(realSubmit) {
  return Number(realSubmit?.diagnostics?.responsesWebSocket?.lastClientPayload?.inputItems || 0);
}

async function waitForRealResponsesSubmitAfter(
  url,
  beforePayloadCount = 0,
  timeoutMs = 15_000,
  expectedMarker = "",
  beforeMarkerEntryIds = [],
) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let lastError = null;
  let markerEntryIds = responseHistoryMarkerEntryIds(expectedMarker);
  while (Date.now() < deadline) {
    const rolloutBundles = codexRolloutMarkerBundles(expectedMarker);
    markerEntryIds = responseHistoryMarkerEntryIds(expectedMarker);
    const markerScopedRequestObserved = !expectedMarker
      || markerEntryIds.some((id) => !beforeMarkerEntryIds.includes(id));
    const rolloutModels = [...new Set(rolloutBundles.flatMap((bundle) => bundle.models || []).map(String).filter(Boolean))];
    const rolloutModelMatched = requiredModelNeedles().length === 0
      || rolloutModels.some((value) => modelValueMatches(value, requiredModelNeedles()));
    if (markerScopedRequestObserved
      && rolloutBundles.length > 0
      && (requiredModelNeedles().length === 0 || rolloutModels.length > 0)) {
      return {
        ok: true,
        source: "codex-rollout",
        diagnostics: latest,
        lastError: rolloutModelMatched ? null : `native Codex rollout model did not match required model: ${rolloutModels.join(", ") || "none"}`,
        requiredModelMatched: rolloutModelMatched,
        observedModels: rolloutModels,
        markerScopedRequestObserved,
        markerEntryIds,
        rolloutEvidence: compactCodexRolloutEvidence(rolloutBundles),
      };
    }
    try {
      latest = await httpJson(`${url}/anticodex/diagnostics?fast=1`);
      markerEntryIds = responseHistoryMarkerEntryIds(expectedMarker);
      const legacyMarkerScopedRequestObserved = !expectedMarker
        || markerEntryIds.some((id) => !beforeMarkerEntryIds.includes(id));
      if (legacyMarkerScopedRequestObserved
        && diagnosticsHasRealResponsesSubmitAfter(latest, beforePayloadCount)) {
        const requiredModelMatched = diagnosticsHasRequiredModelSubmit(latest);
        return {
          ok: true,
          diagnostics: latest,
          lastError: requiredModelMatched ? null : `raw responses payload model did not match required model: ${responsesSubmitModelValues(latest).join(", ") || "none"}`,
          requiredModelMatched,
          observedModels: responsesSubmitModelValues(latest),
          markerScopedRequestObserved: legacyMarkerScopedRequestObserved,
          markerEntryIds,
        };
      }
      const activeTaskObserved = diagnosticsShowsActiveTask(latest);
      if (activeTaskObserved && legacyMarkerScopedRequestObserved) {
        return {
          ok: true,
          diagnostics: latest,
          lastError: null,
          requiredModelMatched: diagnosticsHasRequiredModelSubmit(latest),
          observedModels: responsesSubmitModelValues(latest),
          activeTaskObserved,
          markerScopedRequestObserved: legacyMarkerScopedRequestObserved,
          markerEntryIds,
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
    markerScopedRequestObserved: false,
    markerEntryIds,
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
  if (!payload.checkedAt) payload.checkedAt = new Date().toISOString();
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

const codexRolloutFileCache = new Map();

function recentCodexRolloutFiles(limit = 120) {
  if (!existsSync(codexRolloutRoot)) return [];
  const files = [];
  const pending = [codexRolloutRoot];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
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

function snapshotSingleSubmitRollouts() {
  return new Map(recentCodexRolloutFiles(500).map((file) => [file.path, {
    size: file.size,
    mtimeMs: file.mtimeMs,
  }]));
}

function readJsonLines(path) {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line.replace(/^\uFEFF/, ""))]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

function sameNativePath(left, right) {
  const normalize = (value) => resolve(String(value || "")).replaceAll("/", "\\").toLowerCase();
  return Boolean(left && right) && normalize(left) === normalize(right);
}

function recordContainsExactPrompt(record, expectedPrompt) {
  const normalize = (value) => String(value || "").replace(/\r\n?/g, "\n");
  const prompt = normalize(expectedPrompt);
  if (!prompt) return false;
  if (record?.type === "event_msg"
    && record?.payload?.type === "user_message"
    && normalize(record?.payload?.message) === prompt) return true;
  if (record?.type !== "response_item"
    || record?.payload?.type !== "message"
    || record?.payload?.role !== "user") return false;
  const text = (Array.isArray(record?.payload?.content) ? record.payload.content : [])
    .filter((item) => item?.type === "input_text")
    .map((item) => String(item?.text || ""))
    .join("");
  return normalize(text) === prompt;
}

function readSingleSubmitRolloutEvidence(baseline, expectedCwd, expectedPrompt) {
  const candidates = [];
  for (const file of recentCodexRolloutFiles(500)) {
    if (baseline.has(file.path)) continue;
    const records = readJsonLines(file.path);
    const sessionMeta = records.find((record) => record?.type === "session_meta") || null;
    const sessionId = String(sessionMeta?.payload?.id || sessionMeta?.payload?.session_id || "").trim();
    const turnContexts = records.filter((record) => record?.type === "turn_context");
    const turnContext = turnContexts.at(-1) || null;
    const cwd = String(turnContext?.payload?.cwd || sessionMeta?.payload?.cwd || "").trim();
    const model = String(
      turnContext?.payload?.model
      || turnContext?.payload?.collaboration_mode?.settings?.model
      || "",
    ).trim();
    const promptSeen = records.some((record) => recordContainsExactPrompt(record, expectedPrompt));
    const cwdMatched = sameNativePath(cwd, expectedCwd);
    const modelMatched = modelValueMatches(model, requiredModelNeedles());
    candidates.push({
      ok: Boolean(sessionId && promptSeen && cwdMatched && modelMatched),
      newTask: true,
      sessionId,
      taskId: sessionId,
      turnId: String(turnContext?.payload?.turn_id || "").trim() || null,
      file: file.path,
      cwd,
      cwdMatched,
      model,
      modelMatched,
      promptSeen,
      recordCount: records.length,
    });
  }
  return candidates.find((candidate) => candidate.ok) || candidates[0] || {
    ok: false,
    newTask: false,
    sessionId: null,
    taskId: null,
    turnId: null,
    file: null,
    cwd: null,
    cwdMatched: false,
    model: null,
    modelMatched: false,
    promptSeen: false,
    recordCount: 0,
  };
}

function findPriorSingleSubmitTask(expectedCwd, expectedPrompt) {
  for (const file of recentCodexRolloutFiles(500)) {
    const records = readJsonLines(file.path);
    if (!records.some((record) => recordContainsExactPrompt(record, expectedPrompt))) continue;
    const sessionMeta = records.find((record) => record?.type === "session_meta") || null;
    const turnContext = records.filter((record) => record?.type === "turn_context").at(-1) || null;
    const cwd = String(turnContext?.payload?.cwd || sessionMeta?.payload?.cwd || "").trim();
    if (!sameNativePath(cwd, expectedCwd)) continue;
    return {
      found: true,
      sessionId: String(sessionMeta?.payload?.id || sessionMeta?.payload?.session_id || "").trim() || null,
      turnId: String(turnContext?.payload?.turn_id || "").trim() || null,
      file: file.path,
      cwd,
      model: String(turnContext?.payload?.model || turnContext?.payload?.collaboration_mode?.settings?.model || "").trim() || null,
    };
  }
  return { found: false, sessionId: null, turnId: null, file: null, cwd: null, model: null };
}

function readSingleSubmitUpstreamEvidence(offset) {
  if (!existsSync(codexPlusPlusLogPath)) {
    return { ok: false, logPath: codexPlusPlusLogPath, offset, end: 0, rotated: false, request: null, response: null };
  }
  const end = statSync(codexPlusPlusLogPath).size;
  const rotated = end < offset;
  const effectiveOffset = rotated ? 0 : offset;
  const length = Math.max(0, end - effectiveOffset);
  const body = Buffer.alloc(length);
  const descriptor = openSync(codexPlusPlusLogPath, "r");
  try {
    if (length > 0) readSync(descriptor, body, 0, length, effectiveOffset);
  } finally {
    closeSync(descriptor);
  }
  const records = body.toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  const requestIndex = records.findIndex((record) => (
    record?.event === "protocol_proxy.upstream_request"
    && record?.detail?.relayId === "anticodex-antigravity"
    && Number(record?.detail?.candidateCount || 0) === 1
    && Number(record?.detail?.requestTools?.count || 0) > 0
    && Number(record?.detail?.upstreamTools?.count || 0) > 0
  ));
  const requestRecord = requestIndex >= 0 ? records[requestIndex] : null;
  const responseRecord = requestRecord
    ? records.slice(requestIndex + 1).find((record) => (
      record?.event === "protocol_proxy.upstream_response"
      && record?.detail?.relayId === requestRecord.detail.relayId
      && record?.detail?.endpoint === requestRecord.detail.endpoint
      && Number(record?.detail?.attempt || 0) === Number(requestRecord.detail.attempt || 0)
      && Number(record?.detail?.candidateCount || 0) === Number(requestRecord.detail.candidateCount || 0)
    )) || null
    : null;
  const statusCode = Number(responseRecord?.detail?.statusCode || 0);
  const request = requestRecord ? {
    timestampMs: Number(requestRecord.timestamp_ms || 0),
    relayId: requestRecord.detail.relayId,
    relayName: requestRecord.detail.relayName || null,
    endpoint: requestRecord.detail.endpoint || null,
    wireApi: requestRecord.detail.wireApi || null,
    attempt: Number(requestRecord.detail.attempt || 0),
    candidateCount: Number(requestRecord.detail.candidateCount || 0),
    requestTools: requestRecord.detail.requestTools || null,
    upstreamTools: requestRecord.detail.upstreamTools || null,
  } : null;
  const response = responseRecord ? {
    timestampMs: Number(responseRecord.timestamp_ms || 0),
    statusCode,
    relayId: responseRecord.detail.relayId || null,
    endpoint: responseRecord.detail.endpoint || null,
    attempt: Number(responseRecord.detail.attempt || 0),
    candidateCount: Number(responseRecord.detail.candidateCount || 0),
  } : null;
  return {
    ok: !rotated && request !== null && statusCode >= 200 && statusCode < 300,
    logPath: codexPlusPlusLogPath,
    offset: effectiveOffset,
    requestedOffset: offset,
    end,
    rotated,
    parsedRecordCount: records.length,
    request,
    response,
  };
}

async function readSingleSubmitNativeEvidence(preflight, rollout) {
  const taskId = String(rollout?.taskId || "").trim();
  if (!taskId || preflight?.ok !== true) {
    return {
      ok: false,
      taskId: taskId || null,
      reason: taskId ? "native_preflight_missing" : "rollout_task_id_missing",
      activity: null,
    };
  }
  const rows = await readNativeCodexActivityRows({
    codexHome: anticodexCodexHome,
    afterId: Number(preflight.baselineId || 0),
  });
  const activity = analyzeNativeCodexActivityRows(rows, { expectedThreadIds: [rollout.taskId] });
  const expectedRequestObserved = nativeExpectedRequestObserved(activity);
  const ok = expectedRequestObserved
    && activity.expectedThreadIds.length === 1
    && activity.expectedThreadIds[0] === taskId
    && activity.unexpectedRequestThreadIds.length === 0
    && activity.unexpectedExecutionThreadIds.length === 0
    && activity.titleThreadsUsedTools !== true
    && activity.taskSuggestionThreadsUsedTools !== true;
  return {
    ok,
    taskId,
    reason: ok ? "task_bound_native_request" : "native_request_not_exclusive_to_rollout_task",
    expectedRequestObserved,
    activity,
  };
}

async function waitForSingleSubmitReadOnlyEvidence(rolloutBaseline, codexPlusPlusLogOffset, nativePreflight) {
  const deadline = Date.now() + SINGLE_SUBMIT_EVIDENCE_MS;
  let rollout = readSingleSubmitRolloutEvidence(rolloutBaseline, projectChatRoot, promptText);
  let native = await readSingleSubmitNativeEvidence(nativePreflight, rollout);
  let upstream = readSingleSubmitUpstreamEvidence(codexPlusPlusLogOffset);
  while (Date.now() < deadline && !(rollout.ok && native.ok && upstream.ok)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    rollout = readSingleSubmitRolloutEvidence(rolloutBaseline, projectChatRoot, promptText);
    native = await readSingleSubmitNativeEvidence(nativePreflight, rollout);
    upstream = readSingleSubmitUpstreamEvidence(codexPlusPlusLogOffset);
  }
  return {
    ok: rollout.ok === true && native.ok === true && upstream.ok === true,
    waitedMs: SINGLE_SUBMIT_EVIDENCE_MS - Math.max(0, deadline - Date.now()),
    timedOut: !(rollout.ok && native.ok && upstream.ok),
    rollout,
    native,
    upstream,
  };
}

function codexRolloutMarkerBundles(text) {
  const markerText = String(text || "");
  if (!markerText) return [];
  const bundles = [];
  for (const file of recentCodexRolloutFiles()) {
    const signature = `${file.mtimeMs}:${file.size}:${markerText}`;
    const cached = codexRolloutFileCache.get(file.path);
    let evidence = cached?.signature === signature ? cached.evidence : null;
    if (!evidence) {
      const records = [];
      try {
        const content = readFileSync(file.path, "utf8");
        if (content.includes(markerText)) {
          for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try { records.push(JSON.parse(line.replace(/^\uFEFF/, ""))); } catch {}
          }
        }
      } catch {}
      evidence = collectCodexRolloutMarkerEvidence(records, markerText);
      codexRolloutFileCache.set(file.path, { signature, evidence });
    }
    if (evidence.userMarkerSeen !== true) continue;
    bundles.push({
      ...evidence,
      file: file.path,
      entryId: `rollout:${evidence.sessionId || file.path}`,
    });
  }
  return bundles;
}

async function beginNativeSingleTaskWindow() {
  if (!requireNativeSingleTask) return { ok: true, skipped: true, reason: "not_required", baselineId: 0 };
  const preflight = await waitForNativeCodexRequestQuiet({
    codexHome: anticodexCodexHome,
    quietMs: 8_000,
    timeoutMs: 20_000,
    pollMs: 500,
  });
  if (preflight.ok !== true) {
    throw new Error(`native Codex single-task preflight failed: ${preflight.reason}`);
  }
  return preflight;
}

async function inspectNativeSingleTaskWindow(preflight, markerText) {
  if (!requireNativeSingleTask || preflight?.skipped === true) {
    return { ok: true, skipped: true, reason: "not_required" };
  }
  const rows = await readNativeCodexActivityRows({
    codexHome: anticodexCodexHome,
    afterId: Number(preflight?.baselineId || 0),
  });
  const expectedThreadIds = codexRolloutMarkerBundles(markerText)
    .map((bundle) => String(bundle?.sessionId || "").trim())
    .filter(Boolean);
  const activity = analyzeNativeCodexActivityRows(rows, { marker: markerText, expectedThreadIds });
  const ok = activity.unexpectedExecutionThreadIds.length === 0
    && activity.titleThreadsUsedTools !== true
    && activity.titleThreadsRepeated.length === 0
    && activity.taskSuggestionThreadsUsedTools !== true
    && activity.taskSuggestionThreadsRepeated.length === 0;
  return {
    ok,
    skipped: false,
    preflight,
    activity,
    failureReasons: [
      ...(activity.unexpectedExecutionThreadIds.length > 0
        ? [`unexpected native execution threads: ${activity.unexpectedExecutionThreadIds.join(", ")}`]
        : []),
      ...(activity.titleThreadsUsedTools ? ["native Codex title generation executed a tool"] : []),
      ...(activity.titleThreadsRepeated.length > 0
        ? [`native Codex title generation repeated requests: ${activity.titleThreadsRepeated.join(", ")}`]
        : []),
      ...(activity.taskSuggestionThreadsUsedTools
        ? ["native Codex task suggestion generation executed a tool"]
        : []),
      ...(activity.taskSuggestionThreadsRepeated.length > 0
        ? [`native Codex task suggestion generation repeated requests: ${activity.taskSuggestionThreadsRepeated.join(", ")}`]
        : []),
    ],
  };
}

function compactCodexRolloutEvidence(bundles = []) {
  return bundles.map((bundle) => ({
    sessionId: bundle.sessionId || null,
    file: bundle.file || null,
    models: Array.isArray(bundle.models) ? bundle.models : [],
    assistantMarkerCount: Number(bundle.assistantMarkerCount || 0),
    taskCompleteSeen: bundle.taskCompleteSeen === true,
    markerTurnIds: Array.isArray(bundle.markerTurnIds) ? bundle.markerTurnIds : [],
    completedMarkerTurnIds: Array.isArray(bundle.completedMarkerTurnIds) ? bundle.completedMarkerTurnIds : [],
    failedMarkerTurnIds: Array.isArray(bundle.failedMarkerTurnIds) ? bundle.failedMarkerTurnIds : [],
    latestMarkerTurnId: bundle.latestMarkerTurnId || null,
    latestMarkerTurnComplete: bundle.latestMarkerTurnComplete === true,
    latestMarkerTurnError: bundle.latestMarkerTurnError || null,
    contextItemCount: Array.isArray(bundle.contextItems) ? bundle.contextItems.length : 0,
  }));
}

function responseHistoryContains(text) {
  if (!text) return false;
  try {
    if (readFileSync(responseHistoryPath, "utf8").includes(text)) return true;
  } catch {
    // Fixed-route requests are recorded by native Codex rollouts instead.
  }
  return codexRolloutMarkerBundles(text).length > 0;
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
  return codexRolloutMarkerBundles(text).some((bundle) => bundle.contextItems.some((item) =>
    item?.type === "function_call_output" || item?.type === "custom_tool_call_output"));
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

function diagnosticsActivitySequence(diagnostics) {
  return [
    Number(diagnostics?.responsesWebSocket?.clientPayloads || 0),
    Number(diagnostics?.antigravityQueue?.accepted || 0),
    Number(diagnostics?.modelRoutes?.count || 0),
    Number(diagnostics?.toolBridge?.nativeSessions?.registeredResponses || 0),
  ].join(":");
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

function repoMultiArtifactIdleSettle(turn, phase, evidence, stableIdleResult = null) {
  const artifactComplete = repoMultiFileArtifactCompleteForWait(evidence, phase);
  const inLoopIdleObserved = Boolean(turn?.inLoopIdleDiagnostics);
  const finalMarkerObserved = Number(turn?.answerMarkerCount || 0) >= 1;
  const taskToolOutputSeen = taskScopedToolOutputObserved(evidence?.responseHistory);
  const stableIdleObserved = stableIdleResult?.stable === true;
  return {
    ok: artifactComplete
      && inLoopIdleObserved
      && finalMarkerObserved
      && taskToolOutputSeen
      && stableIdleObserved,
    kind: "artifact_final_reply_stable_idle",
    phase,
    historyToolOutputRequired: true,
    historyToolOutputSeen: taskToolOutputSeen,
    finalMarkerObserved,
    artifactComplete,
    inLoopIdleObserved,
    stableIdleObserved,
    quietMs: stableIdleResult?.quietMs || 0,
    diagnostics: turn?.inLoopIdleDiagnostics || null,
    stableIdleDiagnostics: stableIdleResult?.diagnostics || null,
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
  const analyzerSource = `import { readFileSync } from "node:fs";\n\nfunction stripUtf8Bom(text) {\n  return String(text || "").replace(/^\\uFEFF/, "");\n}\n\nfunction readSources(input = "sources.json") {\n  if (Array.isArray(input)) return input;\n  const parsed = JSON.parse(stripUtf8Bom(readFileSync(input, "utf8")));\n  return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.sources) ? parsed.sources : []);\n}\n\nexport function summarizeSources(filePath = "sources.json") {\n  const items = readSources(filePath);\n  return {\n    sourceCount: items.length,\n    codexMentionCount: items.filter((item) => /Codex|OpenAI/i.test([item.title, item.url, item.snippet].filter(Boolean).join(" "))).length,\n  };\n}\n\nexport function analyze(filePath = "sources.json") {\n  return summarizeSources(filePath);\n}\n\nif (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\\\/g, "/"))) {\n  console.log(JSON.stringify(analyze(process.argv[2] || "sources.json")));\n}\n`;
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
    "只能保留上面 7 个交付文件；不得创建 setup.js、analyzer.js、test.js、summary.json 或任何第 8 个文件。如果 setup.js 或其他替代文件已经存在，请把必要内容迁移到上面的确切文件名后删除多余文件。",
    "codex-update-analyzer.mjs 必须保留 analyze(filePath) 现有公共导出，并同时导出 summarizeSources(filePath)；两者都要读取 UTF-8 sources.json、移除可选 BOM，并返回 sourceCount 和 codexMentionCount。不要为了新增 summarizeSources 删除 analyze。CLI 必须向标准输出打印一个 JSON 对象，其中 sourceCount>=3 且 codexMentionCount>=1。",
    "sources.json 必须是对象数组，每项都要有 title 和 url 字段，至少 3 项，且每个 url 的域名必须是 openai.com 或其子域名；可直接使用 https://openai.com/codex/、https://openai.com/news/、https://developers.openai.com/codex/。report.md 和 index.html 必须是中文、包含精确短语“真实来源”、这 3 条 URL 和最终标记；index.html 必须链接 report.md；done.txt 只能包含最终标记。",
    "请运行 node --test codex-update-analyzer.test.mjs，并运行 node codex-update-analyzer.mjs sources.json；确认第二条命令的标准输出是可解析 JSON 且 sourceCount>=3、codexMentionCount>=1，如果失败就继续修正。",
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
    taskScopedToolOutputSeen: false,
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
  const progressMessages = [];
  const markerScopedCallIds = new Set();
  let history = null;
  try {
    history = JSON.parse(readFileSync(responseHistoryPath, "utf8"));
  } catch {}
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
      const isVisibleProgress = assistantMessageIsVisibleProgress(text, expectedMarker);
      if (isVisibleProgress) progressMessages.push(text.trim());
      if (text.includes(expectedMarker) || isVisibleProgress) {
        evidence.assistantText += `${text}\n`;
      }
      if (/阶段1：准备创建文件/.test(text)) evidence.phase1Count += 1;
      if (/阶段2：准备验证文件/.test(text)) evidence.phase2Count += 1;
    }
    if (value.type === "function_call" || value.type === "custom_tool_call") {
      if (markSeenHistoryItem(value)) return;
      evidence.taskToolCallCount += 1;
      const serialized = JSON.stringify(value);
      if (serialized.includes(expectedMarker)) {
        evidence.markerToolCallCount += 1;
        const callId = String(value.call_id || value.id || "");
        if (callId) markerScopedCallIds.add(callId);
      }
      if (/Anti-Codex exact artifact marker guard/.test(serialized)) evidence.artifactGuardUsed = true;
    }
    if (value.type === "function_call_output" || value.type === "custom_tool_call_output") {
      if (markSeenHistoryItem(value)) return;
      evidence.taskToolOutputSeen = true;
      evidence.taskScopedToolOutputSeen = true;
      const serialized = JSON.stringify(value);
      if (serialized.includes(expectedMarker)
          || markerScopedCallIds.has(String(value.call_id || value.id || ""))) {
        evidence.markerToolOutputSeen = true;
      }
      if (/Anti-Codex artifact marker verification/.test(serialized)) evidence.artifactGuardUsed = true;
    }
    for (const child of Object.values(value)) visit(child);
  };
  const legacyEntries = Array.isArray(history?.entries) ? history.entries : history ? [history] : [];
  const rolloutEntries = codexRolloutMarkerBundles(expectedMarker).map((bundle) => ({
    id: bundle.entryId,
    contextItems: bundle.contextItems,
  }));
  const entries = [...legacyEntries, ...rolloutEntries];
  if (entries.length === 0) return evidence;
  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    if (!serialized.includes(expectedMarker)) continue;
    if (/Generate a concise UI title|provide a short title for a task/i.test(serialized)) continue;
    const contextItems = Array.isArray(entry?.contextItems) ? entry.contextItems : null;
    if (!contextItems) {
      visit(entry);
      continue;
    }
    const markerPromptIndex = contextItems.findIndex((item) => item?.type === "message"
      && item?.role === "user"
      && responseItemTextContent(item.content).includes(expectedMarker));
    visit(markerPromptIndex >= 0 ? contextItems.slice(markerPromptIndex + 1) : contextItems);
  }
  evidence.assistantHasPhase1 = /阶段1：准备创建文件/.test(evidence.assistantText);
  evidence.assistantHasPhase2 = /阶段2：准备验证文件/.test(evidence.assistantText);
  evidence.assistantHasFinalMarker = evidence.assistantText.includes(expectedMarker);
  evidence.visibleProgressCount = progressMessages.length;
  const distinctProgress = new Set(progressMessages);
  evidence.distinctVisibleProgressCount = distinctProgress.size;
  evidence.repeatedVisibleProgressCount = Math.max(0, progressMessages.length - distinctProgress.size);
  evidence.repeatedPhaseCount = Math.max(0, evidence.phase1Count - 2) + Math.max(0, evidence.phase2Count - 2);
  evidence.modelLedExecution = evidence.artifactGuardUsed !== true;
  evidence.codexLikeProcessProof = codexLikeAgentProcessProven(evidence);
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
    taskScopedToolOutputSeen: false,
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
    merged.taskScopedToolOutputSeen ||= evidence.taskScopedToolOutputSeen === true;
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
  merged.codexLikeProcessProof = codexLikeAgentProcessProven(merged);
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
    exportsAnalyze: false,
    exportsSummarizeSources: false,
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
      evidence.cliJson = parseWordCountCliOutput(evidence.cliOutput);
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
      evidence.firstDoneExact = utf8BytesExactlyMatch(readFileSync(donePath), firstMarker);
    }
    if (evidence.files.followupTxt) {
      evidence.followupExact = utf8BytesExactlyMatch(readFileSync(followupPath), finalMarker);
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
      evidence.cliJson = parseWordCountCliOutput(evidence.cliOutput);
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
      const source = readFileSync(analyzerPath, "utf8");
      evidence.exportsAnalyze = /(?:export\s+(?:async\s+)?function\s+analyze\b|export\s+(?:const|let|var)\s+analyze\b|export\s*\{[^}]*\banalyze\b[^}]*\})/.test(source);
      evidence.exportsSummarizeSources = /(?:export\s+(?:async\s+)?function\s+summarizeSources\b|export\s+(?:const|let|var)\s+summarizeSources\b|export\s*\{[^}]*\bsummarizeSources\b[^}]*\})/.test(source);
      evidence.exportsFunction = evidence.exportsAnalyze && evidence.exportsSummarizeSources;
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

async function waitForArtifactEvidence(check, complete, waitMs = 90_000, terminal = null) {
  const deadline = Date.now() + waitMs;
  let evidence = check();
  while (Date.now() < deadline) {
    if (complete(evidence)) return evidence;
    if (typeof terminal === "function" && terminal(evidence) === true) return evidence;
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
  if (!taskScopedToolOutputObserved(evidence?.responseHistory)) return false;
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
  if (artifactEvidence?.files?.analyzer && artifactEvidence.exportsFunction !== true) localFailures.push("complex-project analyzer did not export analyze and summarizeSources");
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
    && taskScopedToolOutputObserved(history);
  if (!hasCompletedResponse) return failures;
  return failures.filter((failure) => !/assistant reply marker was not observed|send click did not submit/i.test(String(failure || "")));
}

function filterReportSiteUiCompletionFailures(failures, artifactEvidence, answerMarkerCount = 0) {
  if (collectReportSiteArtifactFailures(artifactEvidence).length > 0) return failures;
  const history = artifactEvidence?.responseHistory || {};
  const hasToolProof = taskScopedToolOutputObserved(history)
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
    && taskScopedToolOutputObserved(history)
    && (Number(history.taskToolCallCount) || 0) > 0
    && (Number(history.visibleProgressCount) || 0) >= 2
    && (Number(history.distinctVisibleProgressCount) || 0) >= 2;
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
  if ((Number(responseHistory.repeatedVisibleProgressCount) || 0) > 2) failures.push(`${taskMode} repeated visible progress text too many times`);
  if ((Number(responseHistory.taskToolCallCount) || 0) < 1) failures.push(`${taskMode} did not emit a task tool call`);
  if (!taskScopedToolOutputObserved(responseHistory)) failures.push(`${taskMode} did not observe task-scoped tool output`);
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

function responseHistoryMarkerEntryIds(text) {
  if (!text) return [];
  const entryIds = [];
  try {
    const history = JSON.parse(readFileSync(responseHistoryPath, "utf8").replace(/^\uFEFF/, ""));
    entryIds.push(...(Array.isArray(history?.entries) ? history.entries : [])
      .filter((entry) => JSON.stringify(entry).includes(text))
      .map((entry, index) => `response-history:${String(entry?.id || `entry-${index}`)}`));
  } catch {}
  for (const bundle of codexRolloutMarkerBundles(text)) {
    const markerTurnIds = Array.isArray(bundle.markerTurnIds) ? bundle.markerTurnIds.filter(Boolean) : [];
    if (markerTurnIds.length > 0) {
      entryIds.push(...markerTurnIds.map((turnId) => `${bundle.entryId}:turn:${turnId}`));
    } else {
      entryIds.push(bundle.entryId);
    }
  }
  return [...new Set(entryIds)];
}

function reportSiteFinalEvidenceComplete(evidence) {
  const history = evidence?.responseHistory || {};
  return reportSiteArtifactComplete(evidence)
    && taskScopedToolOutputObserved(history)
    && history.assistantHasFinalMarker === true;
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

async function waitForStableIdleDiagnostics(url, timeoutMs = 20_000, quietMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let lastError = null;
  let stableState = null;
  while (Date.now() < deadline) {
    try {
      latest = await httpJson(`${url}/anticodex/diagnostics?fast=1`);
      const nowMs = Date.now();
      stableState = advanceStableIdleWindow(stableState, {
        nowMs,
        idle: diagnosticsAreIdle(latest),
        activitySequence: diagnosticsActivitySequence(latest),
      });
      if (stableIdleWindowReady(stableState, { nowMs, quietMs })) {
        return { diagnostics: latest, lastError: null, stable: true, quietMs };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      stableState = null;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  return { diagnostics: latest, lastError, stable: false, quietMs };
}

function fixedRouteHealthIsReady(health) {
  return health?.ok === true && health?.state === "ready";
}

function fixedRouteIdleDiagnostics(health, source = "fixed-route-ready") {
  return {
    antigravitySessionLock: { active: false, queued: 0, source },
    activeAntigravityRequests: { active: 0, statuses: {}, source },
    antigravityQueue: { running: false, queued: 0, source },
    fixedRouteHealth: health,
  };
}

async function readFixedRouteHealth() {
  try {
    return await httpJson(fixedRouteHealthUrl);
  } catch {
    return null;
  }
}

async function readFixedRouteRequiredModelEvidence(requiredValues = requiredModelNeedles()) {
  const health = await readFixedRouteHealth();
  const observedModels = [health?.requestModelOverride, health?.route?.requestModelOverride]
    .map(String)
    .filter(Boolean);
  const matched = fixedRouteHealthIsReady(health)
    && observedModels.some((value) => modelValueMatches(value, requiredValues));
  return {
    ok: matched,
    matched,
    requiredValues,
    observedModels,
    selectionSource: "fixed-route-request-model-override",
    fixedRouteReady: fixedRouteHealthIsReady(health),
    provider: health?.provider || null,
  };
}

async function waitForStableDesktopIdle(ws, expectedMarker, url, timeoutMs = 20_000, quietMs = 12_000) {
  const startedAt = Date.now();
  const nativeProbeDeadline = startedAt + Math.min(Math.max(5_000, quietMs), 12_000);
  const nativeOverallDeadline = startedAt + timeoutMs;
  let latestRollouts = [];
  let nativeEvidenceSeen = false;
  let nativeTaskComplete = false;
  let outcomeComplete = false;
  let visibleIdle = null;
  let fixedRouteHealth = null;
  while (Date.now() < (nativeEvidenceSeen ? nativeOverallDeadline : nativeProbeDeadline)) {
    latestRollouts = codexRolloutMarkerBundles(expectedMarker);
    nativeEvidenceSeen ||= latestRollouts.length > 0;
    const responseHistoryEvidence = collectResponseHistoryAgenticEvidenceForMarkers(expectedMarker);
    nativeTaskComplete = latestMarkerTurnCompleted(latestRollouts);
    outcomeComplete = !nativeEvidenceSeen && responseHistoryEvidence.codexLikeProcessProof === true;
    if (nativeTaskComplete || outcomeComplete) {
      visibleIdle = await waitForVisibleComposerIdle(ws, 5_000);
      fixedRouteHealth = await readFixedRouteHealth();
      if (visibleIdle.ok === true && fixedRouteHealthIsReady(fixedRouteHealth)) {
        return {
          stable: true,
          source: nativeTaskComplete
            ? "codex-rollout-task-complete"
            : "response-history-outcome-complete",
          quietMs: 0,
          lastError: null,
          nativeTaskComplete,
          outcomeComplete,
          visibleIdle,
          fixedRouteHealth,
          responseHistoryEvidence,
          rolloutEvidence: compactCodexRolloutEvidence(latestRollouts),
          diagnostics: fixedRouteIdleDiagnostics(
            fixedRouteHealth,
            nativeTaskComplete ? "codex-rollout-task-complete" : "response-history-outcome-complete",
          ),
        };
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  if (nativeEvidenceSeen) {
    fixedRouteHealth ||= await readFixedRouteHealth();
    return {
      stable: false,
      source: "codex-rollout-current-turn-timeout",
      quietMs,
      lastError: nativeTaskComplete
        ? "current native Codex turn completed but the visible composer remained busy"
        : "current native Codex turn did not complete before timeout",
      nativeTaskComplete,
      outcomeComplete,
      visibleIdle,
      fixedRouteHealth,
      rolloutEvidence: compactCodexRolloutEvidence(latestRollouts),
      diagnostics: fixedRouteHealthIsReady(fixedRouteHealth)
        ? fixedRouteIdleDiagnostics(fixedRouteHealth, "codex-rollout-current-turn-timeout")
        : null,
    };
  }
  return waitForStableIdleDiagnostics(url, timeoutMs, quietMs);
}

async function waitForVisibleComposerIdle(ws, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const ignoreHistoricalForegroundStop = !isolateChat;
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
        const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
        const labels = buttons.map((button) => String(button.getAttribute('aria-label') || button.textContent || '').trim()).filter(Boolean);
        const isStopControl = (button) => {
          const label = String(button.getAttribute('aria-label') || button.textContent || '').trim();
          const stopPath = button.querySelector('svg path')?.getAttribute('d') || '';
          return /^(?:Stop|停止|正在思考|running|thinking)$/i.test(label)
            || /^M4\.5 5\.75C4\.5/.test(stopPath);
        };
        const hasStop = buttons.some(isStopControl);
        const hasForegroundStop = buttons.some((button) => /bg-token-foreground/.test(String(button.className || ''))
          && /size-token-button-composer/.test(String(button.className || ''))
          && isStopControl(button));
        return { composerPresent: Boolean(composer), hasStop, hasForegroundStop, labels: labels.slice(-16) };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    latest = state.result?.result?.value || null;
    if (latest?.composerPresent
      && latest.hasStop !== true
      && (ignoreHistoricalForegroundStop || latest.hasForegroundStop !== true)) {
      return { ok: true, state: latest, historicalForegroundStopIgnored: ignoreHistoricalForegroundStop && latest.hasForegroundStop === true };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return { ok: false, state: latest };
}

function recoverStaleComposerExpression() {
  const safeMarkerPrefix = JSON.stringify(markerPrefix);
  const safeMarker = JSON.stringify(marker);
  return `(() => {
    const labels = new Set(['停止', 'Stop', '删除排队的消息', 'Delete queued message']);
    const controls = [];
    const bodyText = document.body.innerText || '';
    const isTestResidue = bodyText.includes(${safeMarker})
      || bodyText.includes(${safeMarkerPrefix})
      || /desktop-visible-|ui_local_after_role_fix_|UI_(WEB_SEARCH|LOCAL_PROJECT|CODING_PROJECT|COMPLEX_PROJECT|REPORT_SITE|AGENTIC_STEP_FLOW|CHAT)_SMOKE/i.test(bodyText);
    if (!isTestResidue) return { controls, skipped: true, reason: 'no known UI smoke residue', tail: bodyText.slice(-500) };
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
      const stopPath = button.querySelector('svg path')?.getAttribute('d') || '';
      const squareStop = nearComposer && /^M4\.5 5\.75C4\.5/.test(stopPath);
      const clearTestGoal = /Clear goal|Clear target|\u6e05\u9664\u76ee\u6807/i.test(label);
      const terminalControl = labels.has(label) || squareStop;
      if (button.disabled || rect.width <= 0 || rect.height <= 0 || (!terminalControl && !clearTestGoal)) continue;
      controls.push({
        label: label || (squareStop ? 'square-stop' : 'clear-test-goal'),
        priority: terminalControl && nearComposer ? 100 : terminalControl ? 80 : 10,
        rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      });
    }
    controls.sort((left, right) => right.priority - left.priority);
    return { controls, tail: document.body.innerText.slice(-500) };
  })()`;
}

function responseHistoryAssistantMarkerCount(text) {
  if (!text) return 0;
  let legacyCount = 0;
  try {
    const history = JSON.parse(readFileSync(responseHistoryPath, "utf8").replace(/^\uFEFF/, ""));
    legacyCount = countUniqueAssistantMarkerMessages(history, text);
  } catch {}
  const rolloutCount = codexRolloutMarkerBundles(text)
    .reduce((count, bundle) => count + Number(bundle.assistantMarkerCount || 0), 0);
  return Math.max(legacyCount, rolloutCount);
}

function recoverIdleBackendStaleComposerExpression() {
  return `(() => {
    const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
    const composerRect = composer?.getBoundingClientRect();
    const controls = [];
    for (const button of [...document.querySelectorAll('button')]) {
      const rect = button.getBoundingClientRect();
      const label = (button.getAttribute('aria-label') || button.textContent || '').trim();
      const nearComposer = composerRect
        && rect.left >= composerRect.left + composerRect.width - 90
        && rect.left <= composerRect.left + composerRect.width + 40
        && rect.top >= composerRect.top - 10
        && rect.top <= composerRect.top + composerRect.height + 65;
      const stopPath = button.querySelector('svg path')?.getAttribute('d') || '';
      const terminalControl = /^(?:Stop|\u505c\u6b62|Delete queued message|\u5220\u9664\u6392\u961f\u7684\u6d88\u606f)$/i.test(label)
        || (nearComposer && /^M4\.5 5\.75C4\.5/.test(stopPath));
      if (button.disabled || rect.width <= 0 || rect.height <= 0 || !terminalControl) continue;
      controls.push({
        label: label || 'square-stop',
        priority: nearComposer ? 100 : 80,
        rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      });
    }
    controls.sort((left, right) => right.priority - left.priority);
    return { controls };
  })()`;
}

async function clickRecoveryControlsWithMouse(ws, recovery) {
  const controls = Array.isArray(recovery?.controls) ? recovery.controls : [];
  const control = controls[0] || null;
  const rect = control?.rect || null;
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
    return { ...(recovery || {}), clicked: [], clickMethod: null };
  }
  const x = rect.x + (rect.w / 2);
  const y = rect.y + (rect.h / 2);
  await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return {
    ...(recovery || {}),
    clicked: [String(control.label || "composer-recovery-control")],
    clickMethod: "cdp-mouse",
    clickPoint: { x, y },
  };
}

function sendButtonProbeExpression(expectedText) {
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
      if (/停止|Stop|引导|Guide|删除排队|排队|queued|滚动|scroll|Add files|完全访问|Gemini|Claude|Opus|Sonnet|GPT-OSS/i.test(item.label)) return -1;
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
    const hitTooltip = hit?.closest?.('[role="tooltip"]') || null;
    const tooltipDescribesSelected = Boolean(
      selected
      && hitTooltip?.id
      && String(selected.button.getAttribute('aria-describedby') || '').split(/\s+/).includes(hitTooltip.id)
    );
    const selectedHit = Boolean(selected && (hitButton === selected.button || tooltipDescribesSelected));
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
      clicked: false,
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

async function closeOpenModelMenusAndOverlays(ws, { timeoutMs = 6_000 } = {}) {
  const probeExpression = `(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const selectors = [
      '.codex-dialog-overlay',
      '[role="dialog"][aria-modal="true"]',
      '[data-state="open"][role="menu"]',
      '[data-state="open"][role="listbox"]',
      '[data-codex-popover]',
      '[data-floating-ui-portal]',
    ];
    const seen = new Set();
    const blocking = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const key = String(el.tagName) + '|' + (el.getAttribute('role') || '') + '|' + String(el.className || '').slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        blocking.push({
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          modal: el.getAttribute('aria-modal') || '',
          state: el.getAttribute('data-state') || '',
          cls: String(el.className || '').slice(0, 140),
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        });
      }
    }
    return { blocking };
  })()`;
  const deadline = Date.now() + timeoutMs;
  let lastBlocking = [];
  while (Date.now() < deadline) {
    const probe = await ws.send("Runtime.evaluate", {
      expression: probeExpression,
      returnByValue: true,
      awaitPromise: true,
    });
    const blocking = Array.isArray(probe.result?.result?.value?.blocking)
      ? probe.result.result.value.blocking
      : [];
    lastBlocking = blocking;
    if (blocking.length === 0) return { ok: true, closed: true, remaining: [] };
    await pressEscapeKey(ws);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  return { ok: false, closed: false, remaining: lastBlocking };
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

function currentModelProbeExpression(requiredValues = [], { clickSelected = false } = {}) {
  const valuesJson = JSON.stringify(requiredValues.filter(Boolean));
  const clickSelectedJson = JSON.stringify(clickSelected === true);
  return `(() => {
    const requiredValues = ${valuesJson};
    const clickSelected = ${clickSelectedJson};
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
    const modelish = (label) => /gemini|claude|opus|sonnet|flash|gpt|oss|model|模型|自定义/i.test(label);
    const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
    const composerRect = composer?.getBoundingClientRect();
    const inspectedCandidates = Array.from(document.querySelectorAll('button,[role="button"],[role="menu"],[aria-haspopup]'))
      .filter(visible)
      .map((element, index) => {
        const label = labelFor(element);
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const horizontalGap = composerRect
          ? Math.max(composerRect.left - centerX, 0, centerX - composerRect.right)
          : 0;
        const verticalGap = composerRect
          ? Math.max(composerRect.top - centerY, 0, centerY - composerRect.bottom)
          : 0;
        const composerDistance = composerRect ? Math.hypot(horizontalGap, verticalGap) : 0;
        const nearComposer = composerRect ? Math.max(0, 180 - Math.round(composerDistance / 3)) : 0;
        const isMenuTrigger = element.getAttribute('aria-haspopup') === 'menu' || element.getAttribute('role') === 'menu';
        const outsideHistorySidebar = !composerRect || rect.right > composerRect.left;
        const score = (matches(label) ? 400 : 0)
          + (modelish(label) ? 140 : 0)
          + (isMenuTrigger ? 260 : 0)
          + nearComposer
          - Math.min(label.length, 100);
        return { element, index, label, score, composerDistance, outsideHistorySidebar };
      });
    const candidates = inspectedCandidates
      .filter((item) => item.outsideHistorySidebar)
      .filter((item) => (!composerRect || item.composerDistance <= 360) && (modelish(item.label) || matches(item.label)))
      .sort((a, b) => b.score - a.score);
    const selected = candidates[0] || null;
    if (clickSelected && selected?.element instanceof HTMLElement) {
      selected.element.click();
    }
    return {
      matched: Boolean(selected && matches(selected.label)),
      clicked: Boolean(clickSelected && selected),
      composerRect: composerRect ? { x: Math.round(composerRect.x), y: Math.round(composerRect.y), w: Math.round(composerRect.width), h: Math.round(composerRect.height) } : null,
      selected: selected ? summarize(selected.element, selected.index, selected.score) : null,
      candidates: candidates.slice(0, 8).map((item) => summarize(item.element, item.index, item.score)),
      inspectedNearComposerControls: inspectedCandidates
        .filter((item) => !composerRect || item.composerDistance <= 520)
        .sort((a, b) => a.composerDistance - b.composerDistance)
        .slice(0, 20)
        .map((item) => ({ ...summarize(item.element, item.index, item.score), composerDistance: Math.round(item.composerDistance) })),
      inspectedModelCandidates: inspectedCandidates
        .filter((item) => modelish(item.label) || matches(item.label))
        .sort((a, b) => a.composerDistance - b.composerDistance)
        .slice(0, 12)
        .map((item) => ({ ...summarize(item.element, item.index, item.score), composerDistance: Math.round(item.composerDistance) })),
    };
  })()`;
}

function modelOptionProbeExpression(requiredValues = [], { focusSelected = false, clickSelected = false } = {}) {
  const valuesJson = JSON.stringify(requiredValues.filter(Boolean));
  const focusSelectedJson = JSON.stringify(focusSelected === true);
  const clickSelectedJson = JSON.stringify(clickSelected === true);
  return `(() => {
    const requiredValues = ${valuesJson};
    const focusSelected = ${focusSelectedJson};
    const clickSelected = ${clickSelectedJson};
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
    const modelish = (label) => /gemini|claude|opus|sonnet|flash|gpt|oss|model/i.test(label);
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
    const visibleSelected = candidates.find((item) => {
      if (!matches(item.label)) return false;
      const rect = item.element.getBoundingClientRect();
      const actionableRole = /option|menuitem/i.test(item.element.getAttribute('role') || '');
      return actionableRole || (rect.width <= 400 && rect.height <= 70);
    }) || null;
    const retainedSelectedElement = Array.from(document.querySelectorAll('[role="menuitem"],[role="option"]'))
      .find((element) => matches(labelFor(element))) || null;
    const selected = visibleSelected || (retainedSelectedElement
      ? { element: retainedSelectedElement, index: -1, label: labelFor(retainedSelectedElement), score: 450 }
      : null);
    if (focusSelected && selected?.element instanceof HTMLElement) {
      selected.element.scrollIntoView({ block: 'center', inline: 'nearest' });
      selected.element.focus({ preventScroll: true });
    }
    const selectedPointerEvents = selected?.element instanceof HTMLElement ? getComputedStyle(selected.element).pointerEvents : '';
    let reactSelectInvoked = false;
    let reactHandlerNames = [];
    if (clickSelected && selected?.element instanceof HTMLElement) {
      selected.element.click();
      const reactPropsKey = Object.keys(selected.element).find((key) => key.startsWith('__reactProps$'));
      const reactProps = reactPropsKey ? selected.element[reactPropsKey] : null;
      reactHandlerNames = reactProps && typeof reactProps === 'object'
        ? Object.keys(reactProps).filter((key) => /^on[A-Z]/.test(key))
        : [];
      if (typeof reactProps?.onSelect === 'function') {
        reactProps.onSelect({
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
        });
        reactSelectInvoked = true;
      }
    }
    const menuContainer = candidates.find((item) => {
      const label = String(item.label || '');
      const rect = item.element.getBoundingClientRect();
      return label.length > 100 && rect.width < 400 && rect.height > 200;
    });
    return {
      matched: Boolean(selected),
      focused: Boolean(selected && document.activeElement && (document.activeElement === selected.element || selected.element.contains(document.activeElement))),
      clicked: Boolean(clickSelected && selected),
      retainedSelection: Boolean(!visibleSelected && retainedSelectedElement),
      reactSelectInvoked,
      reactHandlerNames,
      selectedPointerEvents,
      selected: selected ? summarize(selected.element, selected.index, selected.score) : null,
      candidates: candidates.slice(0, 12).map((item) => summarize(item.element, item.index, item.score)),
      menuHtmlSample: menuContainer?.element?.outerHTML?.slice(0, 12000) || '',
    };
  })()`;
}

function atomicModelSelectionExpression(requiredValues = []) {
  const valuesJson = JSON.stringify(requiredValues.filter(Boolean));
  return `(async () => {
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
    const labelFor = (element) => String(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').trim();
    const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
    const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
    const composerRect = composer?.getBoundingClientRect();
    const selector = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(visible)
      .map((element) => {
        const label = labelFor(element);
        const rect = element.getBoundingClientRect();
        const distance = composerRect
          ? Math.hypot((rect.left + rect.width / 2) - (composerRect.left + composerRect.width / 2), (rect.top + rect.height / 2) - (composerRect.top + composerRect.height / 2))
          : 99999;
        return { element, label, distance };
      })
      .filter((item) => /gemini|claude|opus|sonnet|flash|gpt|oss/i.test(item.label))
      .sort((a, b) => a.distance - b.distance)[0] || null;
    if (!selector) return { ok: false, reason: 'model_selector_not_found' };
    selector.element.click();
    await delay(60);
    const submenuTrigger = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .filter(visible)
      .find((element) => {
        const label = labelFor(element);
        return element.getAttribute('aria-haspopup') === 'menu' || /^\\s*模型/i.test(label);
      }) || null;
    if (!submenuTrigger) {
      return {
        ok: false,
        reason: 'model_submenu_trigger_not_found',
        selector: selector.label,
        openMenus: Array.from(document.querySelectorAll('[role="menu"]')).map((menu) => menu.getAttribute('data-state') || ''),
      };
    }
    const rect = submenuTrigger.getBoundingClientRect();
    const eventInit = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    submenuTrigger.dispatchEvent(new PointerEvent('pointerover', { ...eventInit, pointerType: 'mouse' }));
    submenuTrigger.dispatchEvent(new PointerEvent('pointermove', { ...eventInit, pointerType: 'mouse' }));
    submenuTrigger.dispatchEvent(new MouseEvent('mouseover', eventInit));
    submenuTrigger.dispatchEvent(new MouseEvent('mousemove', eventInit));
    submenuTrigger.focus({ preventScroll: true });
    submenuTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
    await delay(100);
    let target = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .filter(visible)
      .find((element) => matches(labelFor(element))) || null;
    if (!target) {
      submenuTrigger.click();
      await delay(100);
      target = Array.from(document.querySelectorAll('[role="menuitem"]'))
        .filter(visible)
        .find((element) => matches(labelFor(element))) || null;
    }
    if (!target) {
      return {
        ok: false,
        reason: 'required_model_menuitem_not_found',
        selector: selector.label,
        submenu: labelFor(submenuTrigger),
        menuitems: Array.from(document.querySelectorAll('[role="menuitem"]')).filter(visible).map(labelFor).slice(0, 16),
        openMenus: Array.from(document.querySelectorAll('[role="menu"]')).map((menu) => menu.getAttribute('data-state') || ''),
      };
    }
    const targetLabel = labelFor(target);
    target.click();
    await delay(150);
    return { ok: true, selector: selector.label, submenu: labelFor(submenuTrigger), target: targetLabel };
  })()`;
}

async function selectRequiredModel(ws, timeoutMs = 20_000) {
  const requiredValues = requiredModelNeedles();
  if (requiredValues.length === 0) return null;
  const fixedRouteEvidence = await readFixedRouteRequiredModelEvidence(requiredValues);
  if (fixedRouteEvidence.matched) return fixedRouteEvidence;
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  const knownModelMenuOrder = [
    "gemini-3.5-flash-low",
    "gemini-3-flash-agent",
    "gemini-3.5-flash-extra-low",
    "gemini-3.1-pro-low",
    "gemini-pro-agent",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
  ];
  const requiredModelMenuIndex = knownModelMenuOrder.indexOf(String(requiredModel || ""));
  const pressKey = async (key, code, windowsVirtualKeyCode) => {
    await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
    await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
  };
  const clickRectCenter = async (rect) => {
    const x = rect.x + rect.w / 2;
    const y = rect.y + rect.h / 2;
    await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
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
    const atomicSelectionResult = await ws.send("Runtime.evaluate", {
      expression: atomicModelSelectionExpression(requiredValues),
      returnByValue: true,
      awaitPromise: true,
    });
    latest.atomicSelection = atomicSelectionResult.result?.result?.value || null;
    if (latest.atomicSelection?.ok === true) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
      const atomicSelectionAfterResult = await ws.send("Runtime.evaluate", {
        expression: currentModelProbeExpression(requiredValues),
        returnByValue: true,
        awaitPromise: true,
      });
      const atomicSelectionAfter = atomicSelectionAfterResult.result?.result?.value || null;
      latest.atomicSelectionAfter = atomicSelectionAfter;
      if (atomicSelectionAfter?.matched === true) {
        await pressEscapeKey(ws);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        return { ...latest, ok: true, matched: true, after: atomicSelectionAfter.selected };
      }
    }
    const rect = latest.before?.rect;
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
      latest.error = "model selector button was not found";
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
      continue;
    }
    await clickRectCenter(rect);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    const immediateOptionClickResult = await ws.send("Runtime.evaluate", {
      expression: modelOptionProbeExpression(requiredValues, { clickSelected: true }),
      returnByValue: true,
      awaitPromise: true,
    });
    latest.immediateOptionClick = immediateOptionClickResult.result?.result?.value || null;
    if (latest.immediateOptionClick?.clicked === true) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
      const immediateAfterResult = await ws.send("Runtime.evaluate", {
        expression: currentModelProbeExpression(requiredValues),
        returnByValue: true,
        awaitPromise: true,
      });
      const immediateAfter = immediateAfterResult.result?.result?.value || null;
      latest.immediateAfter = immediateAfter;
      if (immediateAfter?.matched === true) {
        await pressEscapeKey(ws);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        return { ...latest, ok: true, matched: true, after: immediateAfter.selected };
      }
    }
    if (latest.immediateOptionClick?.clicked !== true) {
      const atomicDomOpenResult = await ws.send("Runtime.evaluate", {
        expression: currentModelProbeExpression(requiredValues, { clickSelected: true }),
        returnByValue: true,
        awaitPromise: true,
      });
      latest.atomicDomOpen = atomicDomOpenResult.result?.result?.value || null;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
      const atomicOptionClickResult = await ws.send("Runtime.evaluate", {
        expression: modelOptionProbeExpression(requiredValues, { clickSelected: true }),
        returnByValue: true,
        awaitPromise: true,
      });
      latest.atomicOptionClick = atomicOptionClickResult.result?.result?.value || null;
      if (latest.atomicOptionClick?.clicked === true) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
        const atomicAfterResult = await ws.send("Runtime.evaluate", {
          expression: currentModelProbeExpression(requiredValues),
          returnByValue: true,
          awaitPromise: true,
        });
        const atomicAfter = atomicAfterResult.result?.result?.value || null;
        latest.atomicAfter = atomicAfter;
        if (atomicAfter?.matched === true) {
          await pressEscapeKey(ws);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
          return { ...latest, ok: true, matched: true, after: atomicAfter.selected };
        }
      }
    }
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
    const hasActionableModelMenu = (probe) => (Array.isArray(probe?.candidates) ? probe.candidates : [])
      .some((candidate) => /option|menuitem/i.test(candidate?.role || ""));
    if (!(optionProbe?.matched === true && optionProbe?.selected?.rect) && !hasActionableModelMenu(optionProbe)) {
      const domOpenResult = await ws.send("Runtime.evaluate", {
        expression: currentModelProbeExpression(requiredValues, { clickSelected: true }),
        returnByValue: true,
        awaitPromise: true,
      });
      latest.domOpenFallback = domOpenResult.result?.result?.value || null;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
      optionProbe = await probeModelOptions();
    }
    const menuCandidateText = (Array.isArray(optionProbe?.candidates) ? optionProbe.candidates : [])
      .map((candidate) => String(candidate?.label || ""))
      .join("\n")
      .toLowerCase();
    const requiredMenuTextVisible = requiredValues
      .map((value) => String(value || "").toLowerCase())
      .filter((value) => value.includes(" "))
      .some((value) => menuCandidateText.includes(value));
    if (!(optionProbe?.matched === true && optionProbe?.selected?.rect)
      && requiredModelMenuIndex >= 0
      && requiredMenuTextVisible) {
      await pressKey("Home", "Home", 36);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      for (let index = 0; index < requiredModelMenuIndex; index += 1) {
        await pressKey("ArrowDown", "ArrowDown", 40);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
      }
      await pressKey("Enter", "Enter", 13);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
      const keyboardMenuAfterResult = await ws.send("Runtime.evaluate", {
        expression: currentModelProbeExpression(requiredValues),
        returnByValue: true,
        awaitPromise: true,
      });
      const keyboardMenuAfter = keyboardMenuAfterResult.result?.result?.value || null;
      latest.keyboardMenuFallback = {
        menuIndex: requiredModelMenuIndex,
        after: keyboardMenuAfter,
      };
      if (keyboardMenuAfter?.matched === true) {
        await pressEscapeKey(ws);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        return { ...latest, ok: true, matched: true, after: keyboardMenuAfter.selected };
      }
    }
    if (!(optionProbe?.matched === true && optionProbe?.selected?.rect)) {
      const modelSubmenu = (Array.isArray(optionProbe?.candidates) ? optionProbe.candidates : [])
        .find((candidate) => /menuitem/i.test(candidate?.role || "") && /gemini|claude|opus|sonnet|flash|gpt|oss/i.test(candidate?.label || "") && candidate?.rect);
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
    const focusedOptionResult = await ws.send("Runtime.evaluate", {
      expression: modelOptionProbeExpression(requiredValues, { focusSelected: true }),
      returnByValue: true,
      awaitPromise: true,
    });
    latest.focusedOption = focusedOptionResult.result?.result?.value || null;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    const focusedOptionProbe = await probeModelOptions();
    if (focusedOptionProbe?.matched === true && focusedOptionProbe?.selected?.rect) {
      latest.optionProbe = focusedOptionProbe;
      latest.option = focusedOptionProbe.selected;
    }
    await clickRectCenter(latest.option.rect);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    const afterResult = await ws.send("Runtime.evaluate", {
      expression: currentModelProbeExpression(requiredValues),
      returnByValue: true,
      awaitPromise: true,
    });
    let after = afterResult.result?.result?.value || null;
    latest.after = after?.selected || null;
    latest.afterProbe = after;
    if (after?.matched !== true) {
      const selectorRect = after?.selected?.rect || latest.before?.rect;
      if (selectorRect) {
        await clickRectCenter(selectorRect);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
        let fallbackProbeResult = await ws.send("Runtime.evaluate", {
          expression: modelOptionProbeExpression(requiredValues),
          returnByValue: true,
          awaitPromise: true,
        });
        let fallbackProbe = fallbackProbeResult.result?.result?.value || null;
        if (fallbackProbe?.matched !== true && !hasActionableModelMenu(fallbackProbe)) {
          const domOpenResult = await ws.send("Runtime.evaluate", {
            expression: currentModelProbeExpression(requiredValues, { clickSelected: true }),
            returnByValue: true,
            awaitPromise: true,
          });
          latest.domOpenFallbackAfterMouse = domOpenResult.result?.result?.value || null;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
          fallbackProbeResult = await ws.send("Runtime.evaluate", {
            expression: modelOptionProbeExpression(requiredValues),
            returnByValue: true,
            awaitPromise: true,
          });
          fallbackProbe = fallbackProbeResult.result?.result?.value || null;
        }
        if (fallbackProbe?.matched !== true) {
          const fallbackSubmenu = (Array.isArray(fallbackProbe?.candidates) ? fallbackProbe.candidates : [])
            .find((candidate) => /menuitem/i.test(candidate?.role || "") && /gemini|claude|opus|sonnet|flash|gpt|oss/i.test(candidate?.label || "") && candidate?.rect);
          if (fallbackSubmenu?.rect) {
            latest.keyboardFallbackSubmenu = fallbackSubmenu;
            const x = fallbackSubmenu.rect.x + fallbackSubmenu.rect.w / 2;
            const y = fallbackSubmenu.rect.y + fallbackSubmenu.rect.h / 2;
            await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
          }
        }
        const focusResult = await ws.send("Runtime.evaluate", {
          expression: modelOptionProbeExpression(requiredValues, { focusSelected: true }),
          returnByValue: true,
          awaitPromise: true,
        });
        latest.keyboardFallback = focusResult.result?.result?.value || fallbackProbe;
        if (latest.keyboardFallback?.matched === true) {
          const domClickResult = await ws.send("Runtime.evaluate", {
            expression: modelOptionProbeExpression(requiredValues, { clickSelected: true }),
            returnByValue: true,
            awaitPromise: true,
          });
          latest.domClickFallback = domClickResult.result?.result?.value || null;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
          let keyboardAfterResult = await ws.send("Runtime.evaluate", {
            expression: currentModelProbeExpression(requiredValues),
            returnByValue: true,
            awaitPromise: true,
          });
          after = keyboardAfterResult.result?.result?.value || null;
          if (after?.matched !== true) {
            await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
            keyboardAfterResult = await ws.send("Runtime.evaluate", {
              expression: currentModelProbeExpression(requiredValues),
              returnByValue: true,
              awaitPromise: true,
            });
            after = keyboardAfterResult.result?.result?.value || null;
          }
          latest.after = after?.selected || null;
          latest.afterProbe = after;
        }
      }
    }
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
  const fixedRouteEvidence = await readFixedRouteRequiredModelEvidence(requiredValues);
  if (fixedRouteEvidence.matched) return { ...fixedRouteEvidence, readOnly: true };
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
        const visibleComposerTexts = [...document.querySelectorAll('[data-codex-composer].ProseMirror, .ProseMirror')]
          .filter((composer) => {
            const rect = composer.getBoundingClientRect();
            const style = getComputedStyle(composer);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          })
          .map((composer) => composer.innerText || '');
        return { composer: visibleComposerTexts.join('\n'), visibleComposerTexts };
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

async function confirmDesktopSubmitBeforeReplay(
  ws,
  prompt,
  expectedMarker,
  beforePayloadCount,
  beforeMarkerEntryIds,
  timeoutMs = 15_000,
) {
  const [composerCleared, realSubmit] = await Promise.all([
    waitForComposerSubmitted(ws, prompt, expectedMarker, timeoutMs),
    waitForRealResponsesSubmitAfter(
      baseUrl,
      beforePayloadCount,
      timeoutMs,
      expectedMarker,
      beforeMarkerEntryIds,
    ),
  ]);
  return {
    ok: composerCleared || realSubmit?.ok === true,
    composerCleared,
    realSubmit,
  };
}

async function refillComposerPrompt(ws, prompt) {
  await closeManagerOverlayIfOpen(ws);
  await closeOpenModelMenusAndOverlays(ws, { timeoutMs: 4_000 });
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
  const evidence = await selectRequiredModel(ws, 20_000);
  return {
    ...(evidence || {}),
    ok: evidence?.matched === true,
    matched: evidence?.matched === true,
    retrySelection: true,
  };
}

async function retryDesktopSubmitAfterMissingPayload(ws, prompt, expectedMarker, options = {}) {
  const retryEvidence = {
    ok: false,
    clickMethod: "cdp-mouse-retry",
    newChatEvidence: null,
    prep: null,
    realSubmit: null,
  };

  if (options.openNewChat === true) {
    const clickedNewChat = await ws.send("Runtime.evaluate", {
      expression: newChatClickExpression(options.requiresProjectChat === true ? projectChatLabel : ""),
      returnByValue: true,
      awaitPromise: true,
    });
    retryEvidence.newChatEvidence = clickedNewChat.result?.result?.value || null;
    if (retryEvidence.newChatEvidence?.clicked !== true) {
      return { ...retryEvidence, reason: "retry_new_chat_not_found" };
    }
    if (options.requiresProjectChat === true && retryEvidence.newChatEvidence?.projectMatched !== true) {
      return { ...retryEvidence, reason: "retry_project_chat_not_matched" };
    }
    retryEvidence.newChatEvidence.visibleIdleAfterNewChat = await waitForVisibleComposerIdle(ws, 20_000);
    if (retryEvidence.newChatEvidence.visibleIdleAfterNewChat?.ok !== true) {
      return { ...retryEvidence, reason: "retry_new_chat_not_idle" };
    }
  } else {
    retryEvidence.newChatEvidence = { skipped: true, reason: "same_task_retry" };
    retryEvidence.visibleIdleBeforeRetry = await waitForVisibleComposerIdle(ws, 20_000);
    if (retryEvidence.visibleIdleBeforeRetry?.ok !== true) {
      return { ...retryEvidence, reason: "retry_same_task_not_idle" };
    }
  }

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200));
  if (requiredModelNeedles().length > 0) {
    retryEvidence.modelConfirmation = await confirmRequiredModelSelected(ws, 5_000);
    if (retryEvidence.modelConfirmation?.matched !== true) {
      return { ...retryEvidence, reason: "retry_required_model_not_retained" };
    }
  }

  retryEvidence.prep = await refillComposerPrompt(ws, prompt);
  if (retryEvidence.prep?.composerMatches !== true || retryEvidence.prep?.hasSendButton !== true) {
    return { ...retryEvidence, reason: "retry_composer_not_ready" };
  }
  const rect = retryEvidence.prep?.selected?.rect || null;
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
    return { ...retryEvidence, reason: "retry_send_coordinates_unavailable" };
  }

  const diagnosticsBefore = await httpJson(diagnosticsUrl).catch(() => null);
  const payloadsBefore = responsesWebSocketPayloadCount(diagnosticsBefore);
  const markerEntryIdsBefore = responseHistoryMarkerEntryIds(expectedMarker);
  const x = rect.x + (rect.w / 2);
  const y = rect.y + (rect.h / 2);
  await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  retryEvidence.clicked = true;
  retryEvidence.clickPoint = { x, y };
  const firstConfirmation = await confirmDesktopSubmitBeforeReplay(
    ws,
    prompt,
    expectedMarker,
    payloadsBefore,
    markerEntryIdsBefore,
    15_000,
  );
  retryEvidence.firstConfirmation = firstConfirmation;
  retryEvidence.composerCleared = firstConfirmation.composerCleared;
  retryEvidence.realSubmit = firstConfirmation.realSubmit;
  if (!firstConfirmation.ok) {
    await pressComposerEnter(ws);
    retryEvidence.enterFallback = true;
    const enterConfirmation = await confirmDesktopSubmitBeforeReplay(
      ws,
      prompt,
      expectedMarker,
      payloadsBefore,
      markerEntryIdsBefore,
      15_000,
    );
    retryEvidence.enterConfirmation = enterConfirmation;
    retryEvidence.composerCleared = enterConfirmation.composerCleared;
    retryEvidence.realSubmit = enterConfirmation.realSubmit;
  }
  retryEvidence.ok = retryEvidence.composerCleared || (retryEvidence.realSubmit?.ok === true
    && (requiredModelNeedles().length === 0 || retryEvidence.realSubmit?.requiredModelMatched === true));
  if (!retryEvidence.ok) retryEvidence.reason = retryEvidence.realSubmit?.lastError || "retry_real_submit_not_observed";
  return retryEvidence;
}

async function pressEscapeKey(ws) {
  await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

function visibleProjectControlsExpression(projectLabel) {
  const label = JSON.stringify(String(projectLabel || ""));
  return `(() => {
    const expected = ${label};
    const texts = Array.from(document.querySelectorAll('button,[role="button"],a'))
      .map((el) => String(el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    const matches = texts.filter((text) => expected && text.includes(expected)).slice(0, 8);
    return { matched: matches.length > 0, matches, href: location.href };
  })()`;
}

async function waitForVisibleProjectLabel(ws, projectLabel, waitMs = 10_000) {
  const deadline = Date.now() + waitMs;
  let evidence = { matched: false, matches: [] };
  do {
    const result = await ws.send("Runtime.evaluate", {
      expression: visibleProjectControlsExpression(projectLabel),
      returnByValue: true,
      awaitPromise: true,
    });
    evidence = result.result?.result?.value || evidence;
    if (evidence.matched === true) return evidence;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  } while (Date.now() < deadline);
  return evidence;
}

async function activateNativeProjectRoot(ws, root, label) {
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`native project root is not an existing directory: ${root || "<empty>"}`);
  }
  const rootJson = JSON.stringify(root);
  const labelJson = JSON.stringify(label);
  const result = await ws.send("Runtime.evaluate", {
    expression: `(async () => {
      const bridge = window.electronBridge?.sendMessageFromView;
      if (!bridge) return { ok: false, reason: 'electron_bridge_missing' };
      await bridge({ type: 'electron-add-new-workspace-root-option', root: ${rootJson} });
      await bridge({ type: 'electron-rename-workspace-root-option', root: ${rootJson}, label: ${labelJson} });
      return { ok: true };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const bridge = result.result?.result?.value || null;
  if (bridge?.ok !== true) throw new Error(`native project activation failed: ${bridge?.reason || "unknown"}`);
  const selector = await waitForVisibleProjectLabel(ws, label);
  if (selector.matched !== true) throw new Error(`native project label did not become visible: ${label}`);
  return { root, label, bridge, selector };
}

async function restoreNativeWorkspaceState(ws, snapshot) {
  const roots = Array.isArray(snapshot?.roots) ? snapshot.roots.map(String) : [];
  const activeRoots = Array.isArray(snapshot?.activeRoots) ? snapshot.activeRoots.map(String) : [];
  const labels = snapshot?.labels && typeof snapshot.labels === "object" ? snapshot.labels : {};
  if (roots.length === 0) throw new Error("workspace snapshot has no saved roots");
  if (activeRoots.length > 1) throw new Error("workspace snapshot has more than one active root");
  const messages = [
    { type: "electron-update-workspace-root-options", roots },
    ...roots.flatMap((root) => String(labels[root] || "").trim()
      ? [{ type: "electron-rename-workspace-root-option", root, label: String(labels[root]).trim() }]
      : []),
    ...(activeRoots[0]
      ? [{ type: "electron-set-active-workspace-root", root: activeRoots[0] }]
      : [{ type: "electron-clear-active-workspace-root" }]),
  ];
  const result = await ws.send("Runtime.evaluate", {
    expression: `(async () => {
      const bridge = window.electronBridge?.sendMessageFromView;
      if (!bridge) return { ok: false, reason: 'electron_bridge_missing' };
      const messages = ${JSON.stringify(messages)};
      for (const message of messages) await bridge(message);
      return { ok: true, messageCount: messages.length };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const bridge = result.result?.result?.value || null;
  if (bridge?.ok !== true) throw new Error(`native workspace restore failed: ${bridge?.reason || "unknown"}`);
  const activeLabel = activeRoots[0] ? String(labels[activeRoots[0]] || "").trim() : "";
  const selector = activeLabel ? await waitForVisibleProjectLabel(ws, activeLabel) : { matched: true, matches: [] };
  if (activeLabel && selector.matched !== true) throw new Error(`restored project label did not become visible: ${activeLabel}`);
  return { roots, activeRoots, labels, bridge, selector };
}

function newChatClickExpression(projectName = "") {
  const expectedProject = JSON.stringify(projectName || "");
  return `(() => {
    const expectedProject = ${expectedProject};
    const controls = Array.from(document.querySelectorAll('button,[role="button"],a'));
    const normalizedProjectName = String(expectedProject || '').trim();
    const projectContextActive = normalizedProjectName && controls.some((el) => {
      const text = [el.innerText, el.getAttribute('aria-label'), el.title]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text.includes(normalizedProjectName)
        && (/\u5207\u6362\u9879\u76ee|\u9879\u76ee\u64cd\u4f5c|project/i.test(text));
    });
    const candidates = controls.map((el, index) => {
      const text = [el.innerText, el.getAttribute('aria-label'), el.title]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\\s+/g, ' ')
        .trim();
      const aria = String(el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      const rect = el.getBoundingClientRect();
      const isNewChat = text.includes('\\u65b0\\u5bf9\\u8bdd')
        || text.includes('\\u65b0\\u5efa\\u4efb\\u52a1')
        || /Ctrl\\+N|New chat/i.test(text);
      const projectText = text + ' ' + aria;
      const isProjectNewChat = expectedProject
        && projectText.includes(expectedProject)
        && (projectText.includes('\\u5f00\\u59cb\\u65b0\\u5bf9\\u8bdd')
          || projectText.includes('\\u65b0\\u5efa\\u4efb\\u52a1')
          || /new chat|new conversation|start/i.test(projectText));
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

function singleSubmitNewTaskProbeExpression(projectName = "") {
  const expectedProject = JSON.stringify(String(projectName || ""));
  return `(() => {
    const expectedProject = ${expectedProject};
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const controls = Array.from(document.querySelectorAll('button,[role="button"],a')).filter(visible);
    const normalizedProjectName = String(expectedProject || '').trim();
    const projectContextActive = normalizedProjectName && controls.some((element) => {
      const text = [element.innerText, element.getAttribute('aria-label'), element.title]
        .map((value) => String(value || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ');
      return text.includes(normalizedProjectName) && /切换项目|项目操作|project/i.test(text);
    });
    const candidates = controls.map((element, index) => {
      const text = [element.innerText, element.getAttribute('aria-label'), element.title]
        .map((value) => String(value || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ');
      const aria = String(element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      const rect = element.getBoundingClientRect();
      const isNewTask = text.includes('新对话') || text.includes('新建任务') || /Ctrl\\+N|New chat/i.test(text);
      const projectText = text + ' ' + aria;
      const isProjectNewTask = normalizedProjectName
        && projectText.includes(normalizedProjectName)
        && (projectText.includes('开始新对话') || projectText.includes('新建任务') || /new chat|new conversation|start/i.test(projectText));
      return { element, index, text, aria, rect, isNewTask, isProjectNewTask };
    }).filter((item) => item.isNewTask);
    const selected = candidates.sort((left, right) => {
      if (left.isProjectNewTask !== right.isProjectNewTask) return left.isProjectNewTask ? -1 : 1;
      return (left.rect.y - right.rect.y) || (left.rect.x - right.rect.x);
    })[0] || null;
    const hit = selected
      ? document.elementFromPoint(selected.rect.left + selected.rect.width / 2, selected.rect.top + selected.rect.height / 2)
      : null;
    const hitControl = hit?.closest?.('button,[role="button"],a') || null;
    const selectedHit = Boolean(selected && (hitControl === selected.element || selected.element.contains(hit)));
    return {
      found: Boolean(selected),
      selectedHit,
      clicked: false,
      projectPreferred: Boolean(normalizedProjectName),
      projectMatched: Boolean(selected?.isProjectNewTask || projectContextActive),
      projectContextActive: Boolean(projectContextActive),
      selected: selected ? {
        index: selected.index,
        text: selected.text,
        aria: selected.aria,
        rect: { x: selected.rect.x, y: selected.rect.y, w: selected.rect.width, h: selected.rect.height },
      } : null,
      hit: hit ? {
        tag: hit.tagName || '',
        label: String(hit.getAttribute?.('aria-label') || hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      } : null,
    };
  })()`;
}

async function createSingleSubmitTaskWithPhysicalMouse(ws) {
  const probe = async () => {
    const result = await ws.send("Runtime.evaluate", {
      expression: singleSubmitNewTaskProbeExpression(projectChatLabel),
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result?.result?.value || null;
  };
  const deadline = Date.now() + 8_000;
  let initial = null;
  while (Date.now() < deadline) {
    initial = await probe();
    if (initial?.found === true && initial?.selectedHit === true) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  if (initial?.found !== true || initial?.selectedHit !== true) {
    throw new Error(`fresh task control was not a live physical mouse target: ${JSON.stringify(initial)}`);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const live = await probe();
  if (live?.found !== true || live?.selectedHit !== true || !live?.selected?.rect) {
    throw new Error(`fresh task control changed before the physical click: ${JSON.stringify(live)}`);
  }
  if (live.projectPreferred && live.projectMatched !== true) {
    throw new Error(`fresh task control was not bound to project ${projectChatLabel}`);
  }
  const rect = live.selected.rect;
  const x = Number(rect.x) + Number(rect.w) / 2;
  const y = Number(rect.y) + Number(rect.h) / 2;
  if (![x, y].every(Number.isFinite)) throw new Error("fresh task control did not expose finite coordinates");
  await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  const visibleIdle = await waitForVisibleComposerIdle(ws, 20_000);
  if (visibleIdle?.ok !== true) throw new Error("fresh native task did not open an idle composer");
  return {
    ok: true,
    actualMouseClick: true,
    clickCount: 1,
    initial,
    live,
    clickPoint: { x, y },
    visibleIdle,
  };
}

async function sendSingleSubmitPromptWithPhysicalMouse(ws) {
  await closeOpenModelMenusAndOverlays(ws, { timeoutMs: 4_000 });
  const cleared = await ws.send("Runtime.evaluate", {
    expression: `(() => {
      const composer = document.querySelector('[data-codex-composer].ProseMirror') || document.querySelector('.ProseMirror');
      if (!composer) return { ok: false };
      composer.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      composer.innerHTML = '<p><br></p>';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return { ok: true };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (cleared.result?.result?.value?.ok !== true) throw new Error("fresh task composer was not found");
  await ws.send("Input.insertText", { text: promptText });
  await closeOpenModelMenusAndOverlays(ws, { timeoutMs: 4_000 });
  const modelConfirmation = await confirmRequiredModelSelected(ws, 5_000);
  if (modelConfirmation?.matched !== true) {
    throw new Error(`required model was not selected immediately before handoff: ${requiredModel}`);
  }
  let prep = await waitForComposerPromptReady(ws, promptText, 5_000);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  prep = await waitForComposerPromptReady(ws, promptText, 2_000);
  const rect = prep?.selected?.rect || null;
  if (prep?.composerMatches !== true || prep?.hasSendButton !== true || prep?.selectedHit !== true || !rect) {
    throw new Error(`single-submit send control was not a live exact-prompt target: ${JSON.stringify(prep)}`);
  }
  const x = Number(rect.x) + Number(rect.w) / 2;
  const y = Number(rect.y) + Number(rect.h) / 2;
  if (![x, y].every(Number.isFinite)) throw new Error("single-submit send control did not expose finite coordinates");
  await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return {
    ok: true,
    clickMethod: "cdp-mouse",
    sendClickCount: 1,
    clickPoint: { x, y },
    prep,
    modelConfirmation,
  };
}

function sameChatClickExpression(titleNeedle) {
  const needle = JSON.stringify(String(titleNeedle || ""));
  return `(() => {
    const wanted = ${needle}.replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 1
        && rect.height > 1
        && rect.left < 420
        && rect.right <= 520
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], [role="treeitem"], [tabindex]'))
      .filter(visible)
      .map((el) => ({ el, text: String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim() }))
      .filter((item) => wanted && item.text.includes(wanted))
      .sort((a, b) => {
        const ar = a.el.getBoundingClientRect();
        const br = b.el.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      });
    const selected = candidates[0];
    if (!selected) return { clicked: false, wanted, candidates: [] };
    const rect = selected.el.getBoundingClientRect();
    const identityElement = selected.el.closest('[data-app-action-sidebar-thread-id]')
      || selected.el.querySelector('[data-app-action-sidebar-thread-id]');
    const rawTaskId = String(identityElement?.getAttribute('data-app-action-sidebar-thread-id') || '').trim();
    const taskId = rawTaskId.includes(':') ? rawTaskId.slice(rawTaskId.lastIndexOf(':') + 1) : rawTaskId;
    return {
      clicked: true,
      wanted,
      taskId: taskId || null,
      rawTaskId: rawTaskId || null,
      text: selected.text.slice(0, 240),
      tag: selected.el.tagName,
      role: selected.el.getAttribute("role") || "",
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      candidateCount: candidates.length,
    };
  })()`;
}

function historyShowMoreExpression() {
  return `(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 1
        && rect.height > 1
        && rect.left < 420
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map((el) => ({
        el,
        text: String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim(),
        rect: el.getBoundingClientRect(),
      }))
      .filter((item) => /^(展开显示|show more)$/i.test(item.text))
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const selected = candidates[0];
    if (!selected) return { found: false, labels: [] };
    return {
      found: true,
      text: selected.text,
      rect: {
        x: selected.rect.x,
        y: selected.rect.y,
        w: selected.rect.width,
        h: selected.rect.height,
      },
      labels: candidates.map((item) => item.text),
    };
  })()`;
}

function historySidebarScrollExpression({ reset = false, restoreOriginal = false, originalScrollTop = 0 } = {}) {
  return `(() => {
    const reset = ${reset ? "true" : "false"};
    const restoreOriginal = ${restoreOriginal ? "true" : "false"};
    const requestedOriginalScrollTop = ${Number(originalScrollTop) || 0};
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width >= 100
        && rect.height >= 80
        && rect.left < 420
        && rect.right <= 520
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll("*"))
      .filter((el) => visible(el) && el.scrollHeight > el.clientHeight + 8)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const overflowScrollable = /auto|scroll|overlay/i.test(style.overflowY || "");
        return {
          el,
          rect,
          overflowScrollable,
          range: Math.max(0, el.scrollHeight - el.clientHeight),
        };
      })
      .sort((a, b) => Number(b.overflowScrollable) - Number(a.overflowScrollable)
        || b.range - a.range
        || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    const selected = candidates[0];
    if (!selected) return { scrolled: false, reason: "sidebar_scroll_container_not_found" };
    const target = selected.el;
    const originalScrollTop = target.scrollTop;
    const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
    const step = Math.max(120, Math.floor(target.clientHeight * 0.75));
    const nextScrollTop = restoreOriginal
      ? Math.min(maxScrollTop, Math.max(0, requestedOriginalScrollTop))
      : reset
        ? 0
        : Math.min(maxScrollTop, target.scrollTop + step);
    target.scrollTop = nextScrollTop;
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
    return {
      scrolled: true,
      reset,
      restoreOriginal,
      originalScrollTop,
      nextScrollTop,
      maxScrollTop,
      clientHeight: target.clientHeight,
      scrollHeight: target.scrollHeight,
      atEnd: nextScrollTop >= maxScrollTop,
      rect: {
        x: selected.rect.x,
        y: selected.rect.y,
        w: selected.rect.width,
        h: selected.rect.height,
      },
    };
  })()`;
}

async function openSameChatByTitle(ws, titleNeedle, { waitForIdle = true, idleTimeoutMs = 20_000 } = {}) {
  const openedAt = Date.now();
  const findVisibleTask = async () => {
    const result = await ws.send("Runtime.evaluate", {
      expression: sameChatClickExpression(titleNeedle),
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result?.result?.value || null;
  };
  let evidence = await findVisibleTask();
  const historyExpandEvidence = [];
  if (evidence?.clicked !== true) {
    for (let historyExpandAttempt = 0; historyExpandAttempt < 8; historyExpandAttempt += 1) {
      const showMoreResult = await ws.send("Runtime.evaluate", {
        expression: historyShowMoreExpression(),
        returnByValue: true,
        awaitPromise: true,
      });
      const showMore = showMoreResult.result?.result?.value || null;
      if (showMore?.found !== true) break;
      const rect = showMore.rect || {};
      const x = Number(rect.x) + Number(rect.w) / 2;
      const y = Number(rect.y) + Number(rect.h) / 2;
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
      await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      historyExpandEvidence.push({ ...showMore, actualMouseClick: true });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      evidence = await findVisibleTask();
      if (evidence?.clicked === true) break;
    }
  }
  const historyScrollEvidence = [];
  let originalScrollTop = null;
  if (evidence?.clicked !== true) {
    for (let historyScrollAttempt = 0; historyScrollAttempt < 40; historyScrollAttempt += 1) {
      const scrollResult = await ws.send("Runtime.evaluate", {
        expression: historySidebarScrollExpression({ reset: historyScrollAttempt === 0 }),
        returnByValue: true,
        awaitPromise: true,
      });
      const scrollEvidence = scrollResult.result?.result?.value || null;
      historyScrollEvidence.push(scrollEvidence);
      if (historyScrollAttempt === 0 && Number.isFinite(Number(scrollEvidence?.originalScrollTop))) {
        originalScrollTop = Number(scrollEvidence.originalScrollTop);
      }
      if (scrollEvidence?.scrolled !== true) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
      evidence = await findVisibleTask();
      if (evidence?.clicked === true || scrollEvidence.atEnd === true) break;
    }
  }
  if (evidence?.clicked !== true) {
    if (originalScrollTop !== null) {
      await ws.send("Runtime.evaluate", {
        expression: historySidebarScrollExpression({ restoreOriginal: true, originalScrollTop }),
        returnByValue: true,
        awaitPromise: true,
      });
    }
    throw new Error(`same-chat task title was not found: ${titleNeedle}`);
  }
  evidence.historyExpandEvidence = historyExpandEvidence;
  evidence.historyScrollEvidence = historyScrollEvidence;
  const sameChatRect = evidence.rect || {};
  const sameChatX = Number(sameChatRect.x) + Number(sameChatRect.w) / 2;
  const sameChatY = Number(sameChatRect.y) + Number(sameChatRect.h) / 2;
  if (!Number.isFinite(sameChatX) || !Number.isFinite(sameChatY)) {
    throw new Error(`same-chat task did not expose a clickable rectangle: ${titleNeedle}`);
  }
  await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sameChatX, y: sameChatY, button: "none" });
  await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x: sameChatX, y: sameChatY, button: "left", clickCount: 1 });
  await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: sameChatX, y: sameChatY, button: "left", clickCount: 1 });
  evidence.actualMouseClick = true;
  if (waitForIdle) {
    evidence.visibleIdleAfterClick = await waitForVisibleComposerIdle(ws, idleTimeoutMs);
    if (evidence.visibleIdleAfterClick?.ok !== true) {
      throw new Error(`same-chat task did not open an idle composer: ${titleNeedle}`);
    }
  }
  evidence.openLatencyMs = Date.now() - openedAt;
  return evidence;
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

function pickPrimaryAppTarget(targets) {
  const pages = targets.filter((target) => target?.type === "page"
    && target.webSocketDebuggerUrl
    && !String(target.url || "").toLowerCase().includes("avatar-overlay"));
  return pages.find((target) => /^app:\/\/-\/index\.html(?:[?#]|$)/i.test(String(target.url || "")))
    || pages.find((target) => String(target.url || "").startsWith("app://"))
    || pages[0]
    || null;
}

async function resolveCdpTargets() {
  const explicitPort = args.get("--cdp-port") || process.env.DEEPCODEX_CDP_PORT;
  const candidates = [...new Set(explicitPort
    ? [Number(explicitPort)]
    : [...discoverAntiCodexCdpPorts(), 18318, 58318, 58317])];
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

function activateAntiCodexWindow(processId) {
  const numericProcessId = Number(processId || 0);
  if (process.platform !== "win32" || !Number.isInteger(numericProcessId) || numericProcessId <= 0) {
    return { attempted: false, ok: process.platform !== "win32", processId: numericProcessId || null };
  }
  try {
    const activationScript = `
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AntiCodexForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
}
'@
$target = [IntPtr](Get-Process -Id ${numericProcessId} -ErrorAction Stop).MainWindowHandle
$foreground = [AntiCodexForegroundWindow]::GetForegroundWindow()
[uint32]$foregroundProcessId = 0
$foregroundThread = [AntiCodexForegroundWindow]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
[uint32]$targetProcessId = 0
$targetThread = [AntiCodexForegroundWindow]::GetWindowThreadProcessId($target, [ref]$targetProcessId)
$currentThread = [AntiCodexForegroundWindow]::GetCurrentThreadId()
$attachedForeground = [AntiCodexForegroundWindow]::AttachThreadInput($currentThread, $foregroundThread, $true)
$attachedTarget = [AntiCodexForegroundWindow]::AttachThreadInput($currentThread, $targetThread, $true)
[AntiCodexForegroundWindow]::ShowWindowAsync($target, 9) | Out-Null
[AntiCodexForegroundWindow]::BringWindowToTop($target) | Out-Null
$setForeground = [AntiCodexForegroundWindow]::SetForegroundWindow($target)
[AntiCodexForegroundWindow]::SetFocus($target) | Out-Null
if ($attachedTarget) { [AntiCodexForegroundWindow]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null }
if ($attachedForeground) { [AntiCodexForegroundWindow]::AttachThreadInput($currentThread, $foregroundThread, $false) | Out-Null }
Start-Sleep -Milliseconds 100
$after = [AntiCodexForegroundWindow]::GetForegroundWindow()
[uint32]$afterProcessId = 0
[AntiCodexForegroundWindow]::GetWindowThreadProcessId($after, [ref]$afterProcessId) | Out-Null
$visible = [AntiCodexForegroundWindow]::IsWindowVisible($target)
$minimized = [AntiCodexForegroundWindow]::IsIconic($target)
$topMost = ([AntiCodexForegroundWindow]::GetWindowLong($target, -20) -band 0x8) -ne 0
[pscustomobject]@{ ok = (($after -eq $target) -and $visible -and (-not $minimized) -and (-not $topMost)); processId = ${numericProcessId}; foregroundProcessId = $afterProcessId; setForeground = $setForeground; visible = $visible; minimized = $minimized; topMost = $topMost } | ConvertTo-Json -Compress
`;
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-WindowStyle",
      "Hidden",
      "-Command",
      activationScript,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    });
    const evidence = JSON.parse(output.trim());
    return { attempted: true, ...evidence, processId: numericProcessId };
  } catch (error) {
    return { attempted: true, ok: false, processId: numericProcessId, error: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForVisibleDocument(ws, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const result = await ws.send("Runtime.evaluate", {
      expression: "({ focused: document.hasFocus(), visibility: document.visibilityState })",
      returnByValue: true,
      awaitPromise: true,
    });
    latest = result.result?.result?.value || null;
    if (latest?.visibility === "visible") return { ok: true, ...latest };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return { ok: false, ...(latest || {}) };
}

async function readVisibleMainPaneText(ws) {
  const result = await ws.send("Runtime.evaluate", {
    expression: `(() => {
      ${visibleMainPaneTextExpression}
      return visibleMainPaneText();
    })()`,
    returnByValue: true,
  });
  return String(result.result?.result?.value || "");
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
  let assistantMarkerHistoryCount = 0;
  const nativeActivityPreflight = await beginNativeSingleTaskWindow();

  await closeManagerOverlayIfOpen(ws);
  await closeOpenModelMenusAndOverlays(ws, { timeoutMs: 6_000 });
  const markerBaselineText = await readVisibleMainPaneText(ws);
  const markerBaselineCount = countMarkerOccurrences(markerBaselineText, expectedMarker);
  const assistantMarkerHistoryBaselineCount = responseHistoryAssistantMarkerCount(expectedMarker);
  const requestMarkerEntryIdsBefore = responseHistoryMarkerEntryIds(expectedMarker);
  assistantMarkerHistoryCount = assistantMarkerHistoryBaselineCount;
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
  await closeOpenModelMenusAndOverlays(ws, { timeoutMs: 6_000 });
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
    const rect = prep?.selected?.rect || null;
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
      failures.push("send button coordinates were not available");
    } else {
      const x = rect.x + (rect.w / 2);
      const y = rect.y + (rect.h / 2);
      await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      clicked = true;
      const probe = await ws.send("Runtime.evaluate", {
        expression: sendButtonProbeExpression(prompt),
        returnByValue: true,
        awaitPromise: true,
      });
      submitEvidence = {
        ...(probe.result?.result?.value || {}),
        clicked,
        clickMethod: "cdp-mouse",
        clickPoint: { x, y },
      };
      const firstConfirmation = await confirmDesktopSubmitBeforeReplay(
        ws,
        prompt,
        expectedMarker,
        submitPayloadsBefore,
        requestMarkerEntryIdsBefore,
        15_000,
      );
      submitEvidence.firstConfirmation = firstConfirmation;
      submitSucceeded = firstConfirmation.ok;
      let finalConfirmation = firstConfirmation;
      if (!submitSucceeded) {
        await pressComposerEnter(ws);
        submitEvidence.enterFallback = true;
        submitEvidence.clickMethod = "cdp-mouse-enter-fallback";
        finalConfirmation = await confirmDesktopSubmitBeforeReplay(
          ws,
          prompt,
          expectedMarker,
          submitPayloadsBefore,
          requestMarkerEntryIdsBefore,
          15_000,
        );
        submitEvidence.enterConfirmation = finalConfirmation;
        submitSucceeded = finalConfirmation.ok;
      }
      const realSubmit = finalConfirmation.realSubmit;
      submitEvidence.composerCleared = finalConfirmation.composerCleared;
      submitEvidence.realSubmit = realSubmit;
      if (realSubmit.ok === true) {
        submitEvidence.submitConfirmedBy = realSubmit.source === "codex-rollout" ? "codex-rollout" : "responses-websocket";
        submitSucceeded = true;
      } else if (finalConfirmation.composerCleared) {
        submitEvidence.emptyPrewarmRetry = realSubmit;
        submitEvidence.submitConfirmedBy = "composer-cleared-no-replay";
      }
      const effectiveRealSubmit = realSubmit;
      if (submitSucceeded && Number(options.maxInputItems || 0) > 0 && realSubmitInputItems(effectiveRealSubmit) > Number(options.maxInputItems || 0)) {
        submitEvidence.contextGuard = {
          ok: false,
          inputItems: realSubmitInputItems(effectiveRealSubmit),
          maxInputItems: Number(options.maxInputItems || 0),
        };
        failures.push(`desktop submit carried too much restored context: inputItems=${realSubmitInputItems(effectiveRealSubmit)}, max=${Number(options.maxInputItems || 0)}`);
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
      count = countMarkerOccurrences(text, expectedMarker);
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
      const visibleAnswerMarkerCount = countNewAssistantMarkers({
        visibleText: text,
        marker: expectedMarker,
        baselineMarkerCount: markerBaselineCount,
        submittedPrompt: prompt,
      });
      assistantMarkerHistoryCount = responseHistoryAssistantMarkerCount(expectedMarker);
      answerMarkerCount = countObservedAssistantMarkers({
        visibleNewMarkerCount: visibleAnswerMarkerCount,
        recentVisibleText: lastSample,
        marker: expectedMarker,
        assistantHistoryCount: assistantMarkerHistoryCount,
        assistantHistoryBaselineCount: assistantMarkerHistoryBaselineCount,
      });
      if (answerMarkerCount >= 1 && !firstReplySeenAt) firstReplySeenAt = Date.now();
      if (taskMode === "complex-project"
          && latestMarkerTurnCompleted(codexRolloutMarkerBundles(expectedMarker))
          && !composerHasUnsubmittedMarker({ composerText: composer, marker: expectedMarker, answerMarkerCount })) {
        const fixedRouteHealth = await readFixedRouteHealth();
        if (fixedRouteHealthIsReady(fixedRouteHealth)) {
          artifactCompletionObserved = true;
          inLoopIdleDiagnostics = fixedRouteIdleDiagnostics(fixedRouteHealth, "codex-rollout-current-turn-complete");
          idleCompletedAt = Date.now();
          break;
        }
      }
      if (taskMode === "repo-multi-file-edit") {
        artifactEvidence = verifyRepoMultiFileEditFixture(expectedMarker);
        const artifactFailures = options.readmeOnly === true
          ? collectRepoMultiFileReadmeFailures(artifactEvidence)
          : collectRepoMultiFileEditFailures(artifactEvidence);
        const composerBlocked = composerHasUnsubmittedMarker({
          composerText: composer,
          marker: expectedMarker,
          answerMarkerCount,
        });
        if (artifactFailures.length === 0 && !composerBlocked) {
          try {
            const loopDiagnostics = await httpJson(diagnosticsUrl);
            if (repoMultiTurnCompletionReady({
              artifactFailureCount: artifactFailures.length,
              answerMarkerCount,
              composerHasMarker: composerBlocked,
              diagnosticsIdle: diagnosticsAreIdle(loopDiagnostics),
              responseHistory: artifactEvidence?.responseHistory,
            })) {
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
        if (artifactFailures.length === 0 && !composerHasUnsubmittedMarker({ composerText: composer, marker: expectedMarker, answerMarkerCount })) {
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
      if (taskMode === "report-site") {
        artifactEvidence = verifyReportSiteArtifact(options.artifactDir || artifactDir, expectedMarker);
        const artifactFailures = collectReportSiteArtifactFailures(artifactEvidence);
        if (artifactFailures.length === 0 && !composerHasUnsubmittedMarker({ composerText: composer, marker: expectedMarker, answerMarkerCount })) {
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
        const hasToolEvidence = taskScopedToolOutputObserved(artifactEvidence?.responseHistory);
        if (hasRequiredFiles && hasToolEvidence && !composerHasUnsubmittedMarker({ composerText: composer, marker: expectedMarker, answerMarkerCount })) {
          try {
            const loopDiagnostics = await httpJson(diagnosticsUrl);
            if (diagnosticsAreIdle(loopDiagnostics)) {
              if (autonomousContinuationHasFreshCompletion({
                answerMarkerCount,
                hasRequiredFiles,
                hasToolEvidence,
              })) {
                artifactCompletionObserved = true;
                inLoopIdleDiagnostics = loopDiagnostics;
                idleCompletedAt = Date.now();
                break;
              }
              if (shouldRecoverIdleAutonomousTurn({
                diagnosticsIdle: true,
                elapsedMs: Date.now() - waitStartedAt,
                artifactFailureCount: 1,
              })) {
                inLoopIdleDiagnostics = loopDiagnostics;
                idleCompletedAt = Date.now();
                break;
              }
            }
          } catch {}
        }
      }
      if (taskMode !== "agentic-step-flow" && taskMode !== "autonomous-reasoning" && taskMode !== "repo-multi-file-edit" && !composerHasUnsubmittedMarker({ composerText: composer, marker: expectedMarker, answerMarkerCount }) && (answerMarkerCount >= 1 || Date.now() - waitStartedAt >= idleBreakAfterMs)) {
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
  if (taskMode !== "agentic-step-flow" && !submitSucceeded && answerMarkerCount >= 1 && !composerHasUnsubmittedMarker({ composerText: composer, marker: expectedMarker, answerMarkerCount })) {
    submitSucceeded = true;
  }
  if (!submitSucceeded) failures.push("send click did not submit the composer prompt");
  const reconnectOutcome = classifyReconnectOutcome({
    reconnectSeen: activeReconnectSeen,
    answerText: answerSample,
    completionObserved: answerMarkerCount >= 1 || artifactCompletionObserved,
    stableIdleObserved: Boolean(inLoopIdleDiagnostics),
  });
  if (reconnectOutcome.terminalProviderError) {
    failures.push(`provider turn failed: ${reconnectOutcome.terminalProviderError}`);
  } else if (reconnectOutcome.unresolved) {
    failures.push("reconnect remained unresolved after the submitted prompt");
  }
  if (answerMarkerCount < 1 && !artifactCompletionObserved) failures.push("assistant reply marker was not observed after the submitted prompt in the desktop UI");
  if (composerHasUnsubmittedMarker({ composerText: composer, marker: expectedMarker, answerMarkerCount })) failures.push("composer still contains the submitted prompt");
  const nativeSingleTaskEvidence = await inspectNativeSingleTaskWindow(nativeActivityPreflight, expectedMarker);
  if (nativeSingleTaskEvidence.ok !== true) failures.push(...nativeSingleTaskEvidence.failureReasons);
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
    markerBaselineCount,
    assistantMarkerHistoryBaselineCount,
    assistantMarkerHistoryCount,
    artifactCompletionObserved,
    artifactEvidence,
    activeReconnectSeen,
    activeReconnectEvidence,
    reconnectOutcome,
    inLoopIdleObserved: Boolean(inLoopIdleDiagnostics),
    inLoopIdleDiagnostics,
    composerCleared: !composerHasUnsubmittedMarker({ composerText: composer, marker: expectedMarker, answerMarkerCount }),
    composer,
    lastSample,
    answerSample,
    nativeSingleTaskEvidence,
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

async function runHistoryProbeOnly() {
  if (!sameChatTitleContains) {
    throw new Error("--history-probe-only requires --same-chat-title-contains");
  }
  let releaseUiLock = null;
  let ws = null;
  try {
    releaseUiLock = await acquireUiSmokeLock();
    const targets = await resolveCdpTargets();
    const target = pickPrimaryAppTarget(targets);
    if (!target?.webSocketDebuggerUrl) throw new Error("Anti-Codex CDP app target was not found");
    ws = new LocalWebSocket(target.webSocketDebuggerUrl);
    await ws.connect();
    await ws.send("Page.bringToFront");
    await ws.send("Runtime.enable");
    await ws.send("DOM.enable");
    await ws.send("Input.setIgnoreInputEvents", { ignore: false });
    await ws.send("Runtime.evaluate", {
      expression: "document.querySelector('.anticodex-close')?.click()",
      awaitPromise: true,
    });

    const projectRootEvidence = projectChatRoot
      ? await activateNativeProjectRoot(ws, projectChatRoot, projectChatLabel)
      : null;
    let historyReopenNavigation = null;
    if (navigateAwayBeforeHistoryReopen) {
      const clickedNewChat = await ws.send("Runtime.evaluate", {
        expression: newChatClickExpression(requiresProjectChat ? projectChatLabel : ""),
        returnByValue: true,
        awaitPromise: true,
      });
      historyReopenNavigation = clickedNewChat.result?.result?.value || null;
      if (historyReopenNavigation?.clicked !== true) {
        await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
        await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 2 });
        await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 2 });
        await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
        historyReopenNavigation = { ...(historyReopenNavigation || {}), fallbackShortcut: true };
      }
      historyReopenNavigation.visibleIdleAfterNewChat = await waitForVisibleComposerIdle(ws, 20_000);
      if (historyReopenNavigation.visibleIdleAfterNewChat?.ok !== true) {
        throw new Error("history probe did not reach a blank idle task before reopening history");
      }
      historyReopenNavigation.navigatedAwayFirst = true;
    }

    const sameChatEvidence = await openSameChatByTitle(ws, sameChatTitleContains, {
      waitForIdle: true,
      idleTimeoutMs: Math.max(5_000, historyOpenBudgetMs + 2_000),
    });
    if (historyReopenNavigation) {
      sameChatEvidence.historyReopenNavigation = historyReopenNavigation;
      sameChatEvidence.navigatedAwayFirst = true;
    }
    const failures = sameChatEvidence.openLatencyMs > historyOpenBudgetMs
      ? [`history task took ${sameChatEvidence.openLatencyMs} ms to become interactive (budget ${historyOpenBudgetMs} ms)`]
      : [];
    return {
      ok: failures.length === 0,
      historyProbeOnly: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      coverageKind: "desktop-ui-history-no-traffic",
      failures,
      sameChatTitleContains,
      historyOpenBudgetMs,
      sameChatEvidence,
      projectRootEvidence,
      cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
    };
  } finally {
    try { ws?.socket?.destroy(); } catch {}
    releaseUiLock?.();
  }
}

function physicalModelMenuProbeExpression(requiredValues = []) {
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
      return Boolean(text) && expected.some((needle) => text === needle || text.includes(needle) || needle.includes(text));
    };
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const labelFor = (element) => String(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\\s+/g, ' ').trim();
    const summarize = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        label: labelFor(element),
        role: element.getAttribute('role') || '',
        hasPopup: element.getAttribute('aria-haspopup') || '',
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    };
    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[cmdk-item]')).filter(visible);
    const target = menuItems.find((element) => element.getAttribute('aria-haspopup') !== 'menu' && matches(labelFor(element))) || null;
    const submenuCandidates = menuItems.filter((element) => {
      const label = labelFor(element);
      return element.getAttribute('aria-haspopup') === 'menu' || /^\\s*(模型|model)\\b/i.test(label);
    });
    const submenu = submenuCandidates.find((element) => /^\\s*(模型|model)\\b/i.test(labelFor(element)))
      || null;
    return {
      target: target ? summarize(target) : null,
      submenu: submenu ? summarize(submenu) : null,
      items: menuItems.map(summarize).slice(0, 24),
      controls: Array.from(document.querySelectorAll('button,[role],[aria-haspopup],[data-state="open"]'))
        .filter(visible)
        .map(summarize)
        .filter((item) => item.label || item.role || item.hasPopup)
        .slice(-40),
    };
  })()`;
}

async function waitForFrontendModelSelector(ws, requiredValues, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const result = await ws.send("Runtime.evaluate", {
      expression: currentModelProbeExpression(requiredValues),
      returnByValue: true,
      awaitPromise: true,
    });
    latest = result.result?.result?.value || null;
    if (latest?.selected?.rect) return latest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return latest;
}

async function selectFrontendModelWithPhysicalMouse(ws, timeoutMs = 20_000) {
  const requiredValues = requiredModelNeedles();
  if (requiredValues.length === 0) throw new Error("--frontend-model-probe-only requires --model or --model-label");
  await closeOpenModelMenusAndOverlays(ws, { timeoutMs: 3_000 });

  const before = await waitForFrontendModelSelector(ws, requiredValues, 5_000);
  const selector = before?.selected || before?.candidates?.[0] || null;
  if (!selector?.rect) throw new Error(`native model selector button was not found: ${JSON.stringify(before)}`);

  const selectorHitResult = await ws.send("Runtime.evaluate", {
    expression: `(() => {
      const rect = ${JSON.stringify(selector.rect)};
      const x = Number(rect.x) + Number(rect.w) / 2;
      const y = Number(rect.y) + Number(rect.h) / 2;
      const hit = document.elementFromPoint(x, y);
      const chain = [];
      for (let element = hit; element instanceof HTMLElement && chain.length < 6; element = element.parentElement) {
        chain.push({
          tag: element.tagName,
          role: element.getAttribute('role') || '',
          aria: element.getAttribute('aria-label') || '',
          label: String(element.getAttribute('title') || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
          className: String(element.className || '').slice(0, 160),
          pointerEvents: getComputedStyle(element).pointerEvents,
        });
      }
      return { x, y, focused: document.hasFocus(), visibility: document.visibilityState, chain };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const selectorHit = selectorHitResult.result?.result?.value || null;

  const pointForRect = (rect) => ({
    x: Number(rect.x) + Number(rect.w) / 2,
    y: Number(rect.y) + Number(rect.h) / 2,
  });
  const physicalMove = async (fromRect, toRect, steps = 10) => {
    const from = pointForRect(fromRect);
    const to = pointForRect(toRect);
    if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) {
      throw new Error("model control returned an invalid mouse path");
    }
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      await ws.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x + ((to.x - from.x) * progress),
        y: from.y + ((to.y - from.y) * progress),
        button: "none",
        buttons: 0,
        pointerType: "mouse",
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 18));
    }
  };
  const physicalClick = async (rect, { move = true } = {}) => {
    const { x, y } = pointForRect(rect);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("model control returned an invalid click rectangle");
    if (move) {
      await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse" });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    }
    await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
    await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  };
  const pressArrowRight = async () => {
    await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  };
  const probeOpenModelMenu = async () => {
    const menuResult = await ws.send("Runtime.evaluate", {
      expression: physicalModelMenuProbeExpression(requiredValues),
      returnByValue: true,
      awaitPromise: true,
    });
    return menuResult.result?.result?.value || null;
  };
  const focusModelSubmenu = async () => {
    const focusResult = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const submenuItems = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(visible);
        const item = submenuItems.find((element) => {
          const label = String(element.getAttribute('aria-label') || element.textContent || '').trim();
          return label.startsWith('模型') || label.toLowerCase().startsWith('model');
        }) || null;
        item?.focus();
        return { found: Boolean(item), focused: document.activeElement === item, label: String(item?.getAttribute('aria-label') || item?.textContent || '').trim(), ariaExpanded: item?.getAttribute('aria-expanded') || '' };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    return focusResult.result?.result?.value || null;
  };
  const scrollTargetModelOptionIntoView = async () => {
    const valuesJson = JSON.stringify(requiredValues);
    const scrollResult = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const requiredValues = ${valuesJson};
        const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\\s+/g, ' ');
        const expected = requiredValues.map(normalize).filter(Boolean);
        const matches = (value) => {
          const text = normalize(value);
          return Boolean(text) && expected.some((needle) => text === needle || text.includes(needle) || needle.includes(text));
        };
        const options = Array.from(document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"]'));
        const target = options.find((element) => element.getAttribute('aria-haspopup') !== 'menu' && matches(element.getAttribute('aria-label') || element.textContent || '')) || null;
        target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = target?.getBoundingClientRect();
        return { found: Boolean(target), viewportHeight: innerHeight, rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    return scrollResult.result?.result?.value || null;
  };

  await physicalClick(selector.rect);
  const deadline = Date.now() + timeoutMs;
  let lastSelectorClickAt = Date.now();
  let selectorRetryCount = 0;
  let menu = null;
  let submenuActivated = false;
  let submenuActivationAttempts = 0;
  let submenuFocus = null;
  while (Date.now() < deadline) {
    menu = await probeOpenModelMenu();
    if (menu?.target?.rect) break;
    if (menu?.submenu?.rect && submenuActivationAttempts < 2) {
      submenuActivationAttempts += 1;
      const rect = menu.submenu.rect;
      await physicalMove(selector.rect, rect, 14);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
      const hoveredMenu = await probeOpenModelMenu();
      if (hoveredMenu?.target?.rect) {
        menu = hoveredMenu;
        submenuActivated = true;
        break;
      }
      submenuFocus = await focusModelSubmenu();
      await pressArrowRight();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      const keyboardMenu = await probeOpenModelMenu();
      if (keyboardMenu?.target?.rect) {
        menu = keyboardMenu;
        submenuActivated = true;
        break;
      }
      await physicalClick(rect, { move: false });
      submenuFocus = await focusModelSubmenu();
      await pressArrowRight();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    } else if (selectorRetryCount === 0 && Date.now() - lastSelectorClickAt >= 1_000) {
      await physicalClick(selector.rect);
      lastSelectorClickAt = Date.now();
      selectorRetryCount = 1;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  if (!menu?.target?.rect) {
    const visibleItems = (menu?.items || []).map((item) => item.label).filter(Boolean).join(" | ");
    const visibleControls = (menu?.controls || []).map((item) => `${item.role || item.hasPopup || item.label}:${item.label}`).join(" | ");
    throw new Error(`required native model option was not found: ${requiredValues.join(" / ")}; selector: ${selector.label || "unknown"} @ ${JSON.stringify(selector.rect)}; selector hit: ${JSON.stringify(selectorHit)}; submenu focus: ${JSON.stringify(submenuFocus)}; visible menu items: ${visibleItems || "none"}; controls: ${visibleControls || "none"}`);
  }

  const targetScroll = await scrollTargetModelOptionIntoView();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  const scrolledMenu = await probeOpenModelMenu();
  if (scrolledMenu?.target?.rect) menu = scrolledMenu;
  await physicalMove(menu.submenu?.rect || selector.rect, menu.target.rect);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  const optionHitResult = await ws.send("Runtime.evaluate", {
    expression: `(() => {
      const rect = ${JSON.stringify(menu.target.rect)};
      const x = Number(rect.x) + Number(rect.w) / 2;
      const y = Number(rect.y) + Number(rect.h) / 2;
      const hit = document.elementFromPoint(x, y);
      const item = hit?.closest?.('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"]') || null;
      const reactPropsKey = item ? Object.keys(item).find((key) => key.startsWith('__reactProps$')) : null;
      const reactProps = reactPropsKey ? item[reactPropsKey] : null;
      window.__anticodexPhysicalModelEvents = [];
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        document.addEventListener(type, (event) => {
          window.__anticodexPhysicalModelEvents.push({
            type,
            target: String(event.target?.getAttribute?.('aria-label') || event.target?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
            role: event.target?.getAttribute?.('role') || '',
            defaultPrevented: event.defaultPrevented,
          });
        }, { capture: true, once: true });
      }
      return {
        x,
        y,
        hitTag: hit?.tagName || '',
        hitLabel: String(hit?.getAttribute?.('aria-label') || hit?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        itemTag: item?.tagName || '',
        itemLabel: String(item?.getAttribute?.('aria-label') || item?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        ariaDisabled: item?.getAttribute?.('aria-disabled') || '',
        dataDisabled: item?.getAttribute?.('data-disabled') ?? null,
        pointerEvents: item ? getComputedStyle(item).pointerEvents : '',
        tabIndex: item?.tabIndex ?? null,
        reactHandlers: reactProps && typeof reactProps === 'object'
          ? Object.keys(reactProps).filter((key) => /^on[A-Z]/.test(key))
          : [],
        outerHtml: String(item?.outerHTML || hit?.outerHTML || '').slice(0, 600),
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const optionHit = optionHitResult.result?.result?.value || null;
  await physicalClick(menu.target.rect, { move: false });
  const optionEventsResult = await ws.send("Runtime.evaluate", {
    expression: "window.__anticodexPhysicalModelEvents || []",
    returnByValue: true,
    awaitPromise: true,
  });
  const optionEvents = optionEventsResult.result?.result?.value || [];
  let after = null;
  while (Date.now() < deadline) {
    const afterResult = await ws.send("Runtime.evaluate", {
      expression: currentModelProbeExpression(requiredValues),
      returnByValue: true,
      awaitPromise: true,
    });
    after = afterResult.result?.result?.value || null;
    if (after?.matched === true) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  await pressEscapeKey(ws);
  return {
    ok: after?.matched === true,
    actualMouseClick: true,
    selectorClick: true,
    selectorClickCount: 1 + selectorRetryCount,
    optionClick: true,
    submenuActivated,
    submenuActivationAttempts,
    submenuFocus,
    targetScroll,
    requiredValues,
    before: before?.selected || null,
    selectorHit,
    option: menu.target,
    optionHit,
    optionEvents,
    after: after?.selected || null,
    menuItems: menu.items || [],
  };
}

async function readFrontendRuntimeReady() {
  const health = await httpJson(fixedRouteHealthUrl);
  return {
    ok: health?.ok === true && health?.state === "ready",
    health,
  };
}

async function runFrontendModelProbeOnly() {
  if (!sameChatTitleContains) {
    throw new Error("--frontend-model-probe-only requires --same-chat-title-contains");
  }
  let releaseUiLock = null;
  let ws = null;
  try {
    releaseUiLock = await acquireUiSmokeLock();
    const targets = await resolveCdpTargets();
    const target = pickPrimaryAppTarget(targets);
    if (!target?.webSocketDebuggerUrl) throw new Error("Anti-Codex CDP app target was not found");
    ws = new LocalWebSocket(target.webSocketDebuggerUrl);
    await ws.connect();
    await ws.send("Page.enable");
    await ws.send("Page.bringToFront");
    await ws.send("Runtime.enable");
    await ws.send("DOM.enable");
    await ws.send("Input.setIgnoreInputEvents", { ignore: false });
    await ws.send("Runtime.evaluate", {
      expression: "(() => { window.focus(); return { focused: document.hasFocus(), visibility: document.visibilityState }; })()",
      returnByValue: true,
      awaitPromise: true,
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    await ws.send("Runtime.evaluate", {
      expression: "document.querySelector('.anticodex-close')?.click()",
      awaitPromise: true,
    });

    const requestsBefore = await readNativeCodexRequestSnapshot({ codexHome: anticodexCodexHome });
    const healthBefore = await httpJson(fixedRouteHealthUrl);
    const expectedOriginalCodexPid = Number(args.get("--expected-original-codex-pid") || 0);
    const expectedSupervisorPid = Number(args.get("--expected-supervisor-pid") || 0);
    const expectedCodexPlusPlusPid = Number(args.get("--expected-codexplusplus-pid") || 0);
    const expectedAntiCodexMainPid = Number(args.get("--expected-anticodex-main-pid") || 0);
    const sameChatEvidence = await openSameChatByTitle(ws, sameChatTitleContains, {
      waitForIdle: true,
      idleTimeoutMs: 12_000,
    });
    const windowActivation = activateAntiCodexWindow(expectedAntiCodexMainPid || healthBefore?.processes?.copiedClient?.[0]);
    const visibleWindow = await waitForVisibleDocument(ws, 3_000);
    const osWindowInteractive = windowActivation?.ok === true
      && windowActivation?.visible === true
      && windowActivation?.minimized === false
      && windowActivation?.topMost === false
      && visibleWindow?.focused === true;
    if (visibleWindow.ok !== true && !osWindowInteractive) {
      throw new Error(`Anti-Codex window was not visible for physical model selection: ${JSON.stringify({ windowActivation, visibleWindow })}`);
    }
    const selection = await selectFrontendModelWithPhysicalMouse(ws, 20_000);
    const runtime = await readFrontendRuntimeReady();
    const requestsAfter = await readNativeCodexRequestSnapshot({ codexHome: anticodexCodexHome });
    const healthAfter = runtime.health || await httpJson(fixedRouteHealthUrl);
    const firstCopiedClientPid = (health) => Number(Array.isArray(health?.processes?.copiedClient) ? health.processes.copiedClient[0] : 0);
    const processIdentity = {
      supervisorBefore: Number(healthBefore?.pid || 0),
      supervisorAfter: Number(healthAfter?.pid || 0),
      codexPlusPlusBefore: Number(healthBefore?.processes?.codexPlusPlus || 0),
      codexPlusPlusAfter: Number(healthAfter?.processes?.codexPlusPlus || 0),
      antiCodexMainBefore: firstCopiedClientPid(healthBefore),
      antiCodexMainAfter: firstCopiedClientPid(healthAfter),
      expectedOriginalCodexPid,
      originalCodexAlive: expectedOriginalCodexPid > 0 ? (() => { try { process.kill(expectedOriginalCodexPid, 0); return true; } catch { return false; } })() : null,
    };
    const failures = [];
    if (sameChatEvidence?.taskId !== expectedTaskId) {
      failures.push(`same-chat task id ${sameChatEvidence?.taskId || "<missing>"} did not match ${expectedTaskId}`);
    }
    if (selection.ok !== true || selection.actualMouseClick !== true) failures.push("native model was not selected with physical mouse input");
    if (runtime.ok !== true) failures.push("fixed-route runtime was not ready after frontend selection");
    if (requestsAfter.requestCount !== requestsBefore.requestCount || requestsAfter.latestRequestRowId !== requestsBefore.latestRequestRowId) {
      failures.push("frontend model probe sent a model request");
    }
    if (processIdentity.supervisorBefore !== processIdentity.supervisorAfter) failures.push("fixed-route supervisor restarted during frontend selection");
    if (processIdentity.codexPlusPlusBefore !== processIdentity.codexPlusPlusAfter) failures.push("CodexPlusPlus restarted during frontend selection");
    if (processIdentity.antiCodexMainBefore !== processIdentity.antiCodexMainAfter) failures.push("Anti-Codex client restarted during frontend selection");
    if (expectedSupervisorPid > 0 && processIdentity.supervisorAfter !== expectedSupervisorPid) failures.push("fixed-route supervisor changed from the acceptance baseline");
    if (expectedCodexPlusPlusPid > 0 && processIdentity.codexPlusPlusAfter !== expectedCodexPlusPlusPid) failures.push("CodexPlusPlus changed from the acceptance baseline");
    if (expectedAntiCodexMainPid > 0 && processIdentity.antiCodexMainAfter !== expectedAntiCodexMainPid) failures.push("Anti-Codex main process changed from the acceptance baseline");
    if (expectedOriginalCodexPid > 0 && processIdentity.originalCodexAlive !== true) failures.push("original Codex process exited during frontend selection");
    return {
      ok: failures.length === 0,
      frontendModelProbeOnly: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      coverageKind: "desktop-ui-physical-model-switch-no-traffic",
      failures,
      taskId: sameChatEvidence?.taskId || null,
      expectedTaskId,
      sameChatTitleContains,
      sameChatEvidence,
      windowActivation,
      visibleWindow,
      osWindowInteractive,
      selection,
      selectedModel: {
        model: requiredModel || null,
        label: requiredModelLabel || null,
        evidence: selection.after || null,
      },
      runtime: {
        ok: runtime.ok,
        modelDirected: true,
        baseProvider: healthAfter?.provider || null,
        baseModel: healthAfter?.model || null,
      },
      requestEvidence: {
        beforeCount: requestsBefore.requestCount,
        afterCount: requestsAfter.requestCount,
        beforeLatestRequestRowId: requestsBefore.latestRequestRowId,
        afterLatestRequestRowId: requestsAfter.latestRequestRowId,
      },
      processIdentity,
      cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
    };
  } finally {
    try { ws?.socket?.destroy(); } catch {}
    releaseUiLock?.();
  }
}

async function runWorkspaceCommandOnly() {
  if (workspaceCommand !== "restore") throw new Error(`unsupported workspace command: ${workspaceCommand || "<empty>"}`);
  if (!workspaceStateFile || !existsSync(workspaceStateFile)) {
    throw new Error(`workspace state file is missing: ${workspaceStateFile || "<empty>"}`);
  }
  const snapshot = JSON.parse(readFileSync(workspaceStateFile, "utf8").replace(/^\uFEFF/, ""));
  let releaseUiLock = null;
  let ws = null;
  try {
    releaseUiLock = await acquireUiSmokeLock();
    const targets = await resolveCdpTargets();
    const target = pickPrimaryAppTarget(targets);
    if (!target?.webSocketDebuggerUrl) throw new Error("Anti-Codex CDP app target was not found");
    ws = new LocalWebSocket(target.webSocketDebuggerUrl);
    await ws.connect();
    await ws.send("Runtime.enable");
    const restore = await restoreNativeWorkspaceState(ws, snapshot);
    return {
      ok: true,
      workspaceCommand,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      restore,
      cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
    };
  } finally {
    try { ws?.socket?.destroy(); } catch {}
    releaseUiLock?.();
  }
}

async function runSingleSubmitHandoff() {
  const failures = [];
  let releaseUiLock = null;
  let ws = null;
  let target = null;
  let projectRootEvidence = null;
  let newTaskEvidence = null;
  let modelSelectionEvidence = null;
  let submitEvidence = null;
  let startupEvidence = null;
  let windowActivationEvidence = null;
  let currentTaskIdleEvidence = null;
  let priorTaskEvidence = null;
  let nativeActivityPreflight = null;
  let processIdentity = null;
  let codexPlusPlusLogOffset = 0;
  let rolloutBaseline = new Map();
  let sendDispatched = false;
  const handoffStartedAt = Date.now();

  try {
    releaseUiLock = await acquireUiSmokeLock();
    const targets = await resolveCdpTargets();
    target = pickPrimaryAppTarget(targets);
    if (!target?.webSocketDebuggerUrl) throw new Error("Anti-Codex CDP app target was not found");
    ws = new LocalWebSocket(target.webSocketDebuggerUrl);
    await ws.connect();
    await ws.send("Page.bringToFront");
    await ws.send("Runtime.enable");
    await ws.send("DOM.enable");
    await ws.send("Input.setIgnoreInputEvents", { ignore: false });

    const fixedRouteHealth = await readFixedRouteHealth();
    if (!fixedRouteHealthIsReady(fixedRouteHealth)) throw new Error("fixed-route runtime was not ready for single-submit handoff");
    const foregroundProcessId = Number(fixedRouteHealth?.processes?.copiedClient?.[0] || 0);
    const originalCodexPid = Number(args.get("--expected-original-codex-pid") || 0);
    processIdentity = {
      supervisorPid: Number(fixedRouteHealth?.pid || 0),
      codexPlusPlusPid: Number(fixedRouteHealth?.processes?.codexPlusPlus || 0),
      antiCodexMainPid: foregroundProcessId,
      originalCodexPid,
      originalCodexAlive: originalCodexPid > 0
        ? (() => { try { process.kill(originalCodexPid, 0); return true; } catch { return false; } })()
        : null,
    };
    const activation = activateAntiCodexWindow(foregroundProcessId);
    const visibleWindow = await waitForVisibleDocument(ws, 3_000);
    windowActivationEvidence = { ...activation, document: visibleWindow };
    if (activation?.ok !== true || visibleWindow?.focused !== true || visibleWindow?.visibility !== "visible") {
      throw new Error(`Anti-Codex window was not foreground and visible before single-submit handoff: ${JSON.stringify(windowActivationEvidence)}`);
    }
    const overlayProbe = await ws.send("Runtime.evaluate", {
      expression: `(() => {
        const overlay = document.querySelector('#anticodex-manager-overlay');
        if (!overlay) return { open: false };
        const rect = overlay.getBoundingClientRect();
        const style = getComputedStyle(overlay);
        return { open: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (overlayProbe.result?.result?.value?.open === true) {
      throw new Error("Anti-Codex manager overlay must be closed before single-submit handoff");
    }
    currentTaskIdleEvidence = await waitForVisibleComposerIdle(ws, 5_000);
    if (currentTaskIdleEvidence?.ok !== true) {
      throw new Error("an existing visible Anti-Codex task is still active; single-submit handoff did not touch it");
    }
    priorTaskEvidence = findPriorSingleSubmitTask(projectChatRoot, promptText);
    if (priorTaskEvidence.found === true) {
      throw new Error(`the exact handoff goal was already submitted to task ${priorTaskEvidence.sessionId || "<unknown>"}`);
    }

    rolloutBaseline = snapshotSingleSubmitRollouts();
    codexPlusPlusLogOffset = existsSync(codexPlusPlusLogPath) ? statSync(codexPlusPlusLogPath).size : 0;
    nativeActivityPreflight = await beginNativeSingleTaskWindow();
    projectRootEvidence = await activateNativeProjectRoot(ws, projectChatRoot, projectChatLabel);
    newTaskEvidence = await createSingleSubmitTaskWithPhysicalMouse(ws);
    modelSelectionEvidence = await selectFrontendModelWithPhysicalMouse(ws, 20_000);
    if (modelSelectionEvidence?.ok !== true || modelSelectionEvidence?.actualMouseClick !== true) {
      throw new Error(`required model was not selected with native physical input: ${JSON.stringify(modelSelectionEvidence)}`);
    }

    submitEvidence = await sendSingleSubmitPromptWithPhysicalMouse(ws);
    sendDispatched = submitEvidence?.ok === true && submitEvidence?.sendClickCount === 1;
    try { ws.socket?.destroy(); } catch {}
    ws = null;

    startupEvidence = await waitForSingleSubmitReadOnlyEvidence(
      rolloutBaseline,
      codexPlusPlusLogOffset,
      nativeActivityPreflight,
    );
    if (startupEvidence?.rollout?.ok !== true) failures.push("fresh native rollout/task/cwd/model evidence was not observed");
    if (startupEvidence?.native?.ok !== true) failures.push("fresh native request was not exclusively bound to the new rollout task");
    if (startupEvidence?.upstream?.request === null) failures.push("first tool-bearing Antigravity upstream request was not observed");
    if (startupEvidence?.upstream?.ok !== true) failures.push("first tool-bearing Antigravity upstream request did not receive a 2xx response");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    try { ws?.socket?.destroy(); } catch {}
    releaseUiLock?.();
  }

  const payload = {
    ok: sendDispatched && startupEvidence?.ok === true && failures.length === 0,
    reportName,
    coverageKind: "desktop-ui-single-submit-handoff",
    singleSubmitHandoff: true,
    taskMode,
    taskStartedAt: new Date(handoffStartedAt).toISOString(),
    requestedRealTraffic: true,
    usedRealTraffic: sendDispatched || startupEvidence?.upstream?.request !== null,
    promptFile,
    promptSha256: createHash("sha256").update(promptText, "utf8").digest("hex"),
    projectRoot: projectChatRoot,
    projectLabel: projectChatLabel,
    requiredModel,
    requiredModelLabel: requiredModelLabel || null,
    maximumSendClicks: 1,
    sendClickCount: Number(submitEvidence?.sendClickCount || 0),
    sendDispatched,
    waitedForTaskCompletion: false,
    harnessInterruptedTask: false,
    harnessSubmittedAdditionalTurns: false,
    evidenceWindowMs: SINGLE_SUBMIT_EVIDENCE_MS,
    elapsedMs: Date.now() - handoffStartedAt,
    failures,
    cdpPort,
    target: target ? { id: target.id, title: target.title, url: target.url } : null,
    processIdentity: processIdentity ? {
      ...processIdentity,
      originalCodexAlive: processIdentity.originalCodexPid > 0
        ? (() => { try { process.kill(processIdentity.originalCodexPid, 0); return true; } catch { return false; } })()
        : null,
    } : null,
    windowActivationEvidence,
    currentTaskIdleEvidence,
    priorTaskEvidence,
    nativeActivityPreflight,
    projectRootEvidence,
    newTaskEvidence,
    modelSelectionEvidence,
    submitEvidence,
    codexPlusPlusLogOffset,
    rolloutBaselineCount: rolloutBaseline.size,
    startupEvidence,
  };
  writeReport(payload);
  return payload;
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
  let failureCleanup = null;
  let newChatEvidence = null;
  let sameChatEvidence = null;
  let preservedActiveTask = null;
  let modelSelectionEvidence = null;
  let preSubmitModelSelectionEvidence = null;
  let projectRootEvidence = null;
  let submitEvidence = null;
  let submitSucceeded = false;
  let submitPayloadsBefore = 0;
  let modelRoutesBefore = null;
  let modelRouteEvidence = null;
  let submitCompletedAt = 0;
  let firstReplySeenAt = 0;
  let idleCompletedAt = 0;
  let markerBaselineCount = 0;
  let assistantMarkerHistoryBaselineCount = 0;
  let assistantMarkerHistoryCount = 0;
  let requestMarkerEntryIdsBefore = [];
  let nativeActivityPreflight = null;
  let nativeSingleTaskEvidence = { ok: true, skipped: true, reason: "not_required" };
  let windowActivationEvidence = null;
  let autonomousIdleIncompleteObserved = false;
  let resultDrivenCompletionObserved = false;
  let resultDrivenCompletionError = "";
  const complexProjectRequiresModelLed = taskMode === "complex-project" || taskMode === "autonomous-reasoning";

  try {
    releaseUiLock = await acquireUiSmokeLock();
    process.once("exit", () => releaseUiLock?.());
    const targets = await resolveCdpTargets();
    target = pickPrimaryAppTarget(targets);
    if (!target?.webSocketDebuggerUrl) throw new Error("Anti-Codex CDP app target was not found");
    ws = new LocalWebSocket(target.webSocketDebuggerUrl);
    await ws.connect();
    await ws.send("Page.bringToFront");
    await ws.send("Runtime.enable");
    await ws.send("DOM.enable");
    await ws.send("Network.enable");
    await ws.send("Input.setIgnoreInputEvents", { ignore: false });
    const foregroundHealth = await readFixedRouteHealth().catch(() => null);
    const foregroundProcessId = Number(foregroundHealth?.processes?.copiedClient?.[0] || 0);
    const windowActivation = activateAntiCodexWindow(foregroundProcessId);
    const visibleWindow = await waitForVisibleDocument(ws, 3_000);
    windowActivationEvidence = { ...windowActivation, document: visibleWindow };
    if (windowActivation?.ok !== true || visibleWindow?.focused !== true || visibleWindow?.visibility !== "visible") {
      throw new Error(`Anti-Codex window was not foreground and visible before desktop submit: ${JSON.stringify(windowActivationEvidence)}`);
    }
    await ws.send("Runtime.evaluate", { expression: "document.querySelector('.anticodex-close')?.click()", awaitPromise: true });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    if (projectChatRoot && (isolateChat || sameChatTitleContains)) {
      projectRootEvidence = await activateNativeProjectRoot(ws, projectChatRoot, projectChatLabel);
    }
    if (preserveSameChatActiveTask && sameChatTitleContains) {
      let historyReopenNavigation = null;
      if (navigateAwayBeforeHistoryReopen) {
        const clickedNewChat = await ws.send("Runtime.evaluate", {
          expression: newChatClickExpression(requiresProjectChat ? projectChatLabel : ""),
          returnByValue: true,
          awaitPromise: true,
        });
        historyReopenNavigation = clickedNewChat.result?.result?.value || null;
        if (historyReopenNavigation?.clicked !== true) {
          await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
          await ws.send("Input.dispatchKeyEvent", { type: "keyDown", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 2 });
          await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 2 });
          await ws.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
          historyReopenNavigation = { ...(historyReopenNavigation || {}), fallbackShortcut: true };
        }
        historyReopenNavigation.visibleIdleAfterNewChat = await waitForVisibleComposerIdle(ws, 20_000);
        if (historyReopenNavigation.visibleIdleAfterNewChat?.ok !== true) {
          throw new Error("history reopen precondition did not reach a blank idle task");
        }
        historyReopenNavigation.navigatedAwayFirst = true;
      }
      sameChatEvidence = await openSameChatByTitle(ws, sameChatTitleContains, {
        waitForIdle: requireHistoryResponsive,
        idleTimeoutMs: Math.max(5_000, historyOpenBudgetMs + 2_000),
      });
      if (historyReopenNavigation) {
        sameChatEvidence.historyReopenNavigation = historyReopenNavigation;
        sameChatEvidence.navigatedAwayFirst = historyReopenNavigation.navigatedAwayFirst === true;
      }
      if (requireHistoryResponsive && sameChatEvidence.openLatencyMs > historyOpenBudgetMs) {
        failures.push(`history task took ${sameChatEvidence.openLatencyMs} ms to become interactive (budget ${historyOpenBudgetMs} ms)`);
      }
    }
    if (preserveSameChatActiveTask) {
      staleRecovery = { skipped: true, reason: "preserve_same_chat_active_task" };
      backendResetBeforeSubmit = { skipped: true, reason: "preserve_same_chat_active_task" };
      const fixedRouteHealth = await readFixedRouteHealth();
      const diagnosticsBeforeWait = fixedRouteHealthIsReady(fixedRouteHealth)
        ? fixedRouteIdleDiagnostics(fixedRouteHealth)
        : await httpJson(diagnosticsUrl).catch(() => null);
      const activeBeforeWait = diagnosticsShowsActiveTask(diagnosticsBeforeWait);
      initialIdle = fixedRouteHealthIsReady(fixedRouteHealth)
        ? {
          diagnostics: fixedRouteIdleDiagnostics(fixedRouteHealth),
          fixedRouteHealth,
          source: "fixed-route-ready",
          lastError: null,
        }
        : await waitForIdleDiagnostics(baseUrl, timeoutMs);
      let visibleIdleAfterWait = sameChatEvidence?.visibleIdleAfterClick?.ok === true
        ? sameChatEvidence.visibleIdleAfterClick
        : diagnosticsAreIdle(initialIdle.diagnostics)
          ? await waitForVisibleComposerIdle(ws, Math.min(timeoutMs, 45_000))
          : null;
      let idleBackendStaleComposerRecovery = null;
      if (diagnosticsAreIdle(initialIdle.diagnostics) && visibleIdleAfterWait?.ok !== true) {
        const recovered = await ws.send("Runtime.evaluate", {
          expression: recoverIdleBackendStaleComposerExpression(),
          returnByValue: true,
          awaitPromise: true,
        });
        idleBackendStaleComposerRecovery = recovered.result?.result?.value || null;
        idleBackendStaleComposerRecovery = await clickRecoveryControlsWithMouse(ws, idleBackendStaleComposerRecovery);
        if (Array.isArray(idleBackendStaleComposerRecovery?.clicked) && idleBackendStaleComposerRecovery.clicked.length > 0) {
          visibleIdleAfterWait = await waitForVisibleComposerIdle(ws, 20_000);
        }
      }
      preservedActiveTask = {
        enabled: true,
        activeBeforeWait,
        waitedForExistingTask: activeBeforeWait,
        idleObserved: diagnosticsAreIdle(initialIdle.diagnostics),
        visibleIdleAfterWait,
        idleBackendStaleComposerRecovery,
      };
      if (sameChatEvidence) sameChatEvidence.visibleIdleAfterClick = visibleIdleAfterWait;
    } else {
      const stale = await ws.send("Runtime.evaluate", {
        expression: recoverStaleComposerExpression(),
        returnByValue: true,
        awaitPromise: true,
      });
      staleRecovery = stale.result?.result?.value || null;
      staleRecovery = await clickRecoveryControlsWithMouse(ws, staleRecovery);
      if (Array.isArray(staleRecovery?.clicked) && staleRecovery.clicked.length > 0) {
        staleRecovery.visibleIdleAfterClick = await waitForVisibleComposerIdle(ws, 20_000);
      }
      const fixedRouteHealth = await readFixedRouteHealth();
      if (fixedRouteHealthIsReady(fixedRouteHealth)) {
        const visibleIdle = await waitForVisibleComposerIdle(ws, 20_000);
        backendResetBeforeSubmit = {
          skipped: true,
          reason: "fixed_route_does_not_use_legacy_session_lock",
        };
        initialIdle = {
          diagnostics: fixedRouteIdleDiagnostics(fixedRouteHealth),
          fixedRouteHealth,
          visibleIdle,
          source: "fixed-route-ready",
          lastError: null,
        };
      } else {
        backendResetBeforeSubmit = {
          skipped: true,
          reason: "global_session_reset_removed_waiting_for_idle",
        };
        initialIdle = await waitForIdleDiagnostics(baseUrl, 45_000);
      }
    }
    modelRoutesBefore = await readModelRoutesEvidence();
    if (!diagnosticsAreIdle(initialIdle.diagnostics)) {
      const recoveryMode = preserveSameChatActiveTask ? "without interrupting the existing task" : "after stale recovery";
      throw new Error(`desktop backend was not idle before submit ${recoveryMode}: ${initialIdle.lastError || "busy"}`);
    }
    const visibleIdleForSubmit = preserveSameChatActiveTask
      ? preservedActiveTask?.visibleIdleAfterWait
      : initialIdle.visibleIdle;
    if (initialIdle.source === "fixed-route-ready" && visibleIdleForSubmit?.ok !== true) {
      throw new Error("fixed-route backend was ready but the visible composer still showed an active task");
    }
    if (preserveSameChatActiveTask && visibleIdleForSubmit?.ok !== true) {
      throw new Error("same-chat task backend became idle but the visible composer did not");
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
    } else if (sameChatTitleContains) {
      sameChatEvidence = sameChatEvidence || await openSameChatByTitle(ws, sameChatTitleContains, {
        waitForIdle: preserveSameChatActiveTask,
      });
      if (!preserveSameChatActiveTask && sameChatEvidence?.visibleIdleAfterClick?.ok !== true) {
        const reopenedRecovery = await ws.send("Runtime.evaluate", {
          expression: recoverStaleComposerExpression(),
          returnByValue: true,
          awaitPromise: true,
        });
        sameChatEvidence.staleRecovery = reopenedRecovery.result?.result?.value || null;
        sameChatEvidence.staleRecovery = await clickRecoveryControlsWithMouse(ws, sameChatEvidence.staleRecovery);
        sameChatEvidence.visibleIdleAfterClick = await waitForVisibleComposerIdle(ws, 20_000);
        if (sameChatEvidence.visibleIdleAfterClick?.ok !== true) {
          throw new Error(`same-chat task did not become idle after stale recovery: ${sameChatTitleContains}`);
        }
      }
    }
    if (requiredModelNeedles().length > 0) {
      modelSelectionEvidence = await selectRequiredModel(ws, 20_000);
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
          sameChatEvidence,
          preservedActiveTask,
          modelSelectionEvidence,
          projectRootEvidence,
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
      followupPromptText = customFollowupPromptText || `继续同一个项目：${artifactDir}。不要重建项目，也不要查看 Antigravity brain、transcript、history 或 log 目录。修改 word-tally.mjs，让它额外导出 uniqueWords(text)，返回排序后的唯一单词数组。更新 word-tally.test.mjs：保留原来的 tallyWords 断言，再增加一个 node:test 断言，要求 uniqueWords("red blue red") 返回 ["blue","red"]。创建 CHANGELOG.md，里面要提到这次 uniqueWords 追加任务和准确标记 ${marker}。创建 followup.txt，它的原始字节必须只包含 ${marker}，不能有 UTF-8 BOM、回车或换行；用 [System.IO.File]::WriteAllText 和 New-Object System.Text.UTF8Encoding($false) 写入，不能用 Set-Content、Out-File 或重定向写 followup.txt。运行 node --test word-tally.test.mjs 和 node word-tally.mjs "red blue red green"，再按原始字节验证 followup.txt，确认 red=2、blue=1、green=1 后，最后回复 ${marker}。`;
      followupPromptLanguage = /[\u3400-\u9fff]/u.test(followupPromptText) ? "zh" : "en";
      const turn1 = await submitDesktopPromptAndWait(ws, promptText, firstMarker, timeoutMs, { requiresProjectChat });
      failures.push(...turn1.failures.map((failure) => `turn1: ${failure}`));
      let firstArtifactEvidence = verifyMultiTurnProjectArtifact(artifactDir, firstMarker, marker);
      let turn1Settled = multiTurnFirstTurnReadyForFollowup({ turnOk: turn1.ok, evidence: firstArtifactEvidence })
        ? { ok: true, source: "host-results-and-tool-history" }
        : await waitForDesktopToolTurnSettled(ws, firstMarker, Math.min(timeoutMs, 120_000));
      if (turn1Settled.ok === true && turn1Settled.source !== "host-results-and-tool-history") {
        firstArtifactEvidence = verifyMultiTurnProjectArtifact(artifactDir, firstMarker, marker);
      }
      const turn1ReadyForFollowup = turn1Settled.ok === true
        || multiTurnFirstTurnReadyForFollowup({ turnOk: turn1.ok, evidence: firstArtifactEvidence });
      if (!turn1ReadyForFollowup) {
        failures.push("turn1: desktop tool result did not settle into response history before the follow-up");
      }
      const turn2 = turn1ReadyForFollowup
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
      artifactEvidence = await waitForArtifactEvidence(
        () => verifyMultiTurnProjectArtifact(artifactDir, firstMarker, marker),
        multiTurnProjectArtifactComplete,
        Math.min(timeoutMs, 120_000),
      );
      const turn2HistoryMarkerCount = responseHistoryAssistantMarkerCount(marker);
      const turn2FinalMarkerObserved = hasAssistantFinalMarkerEvidence({
        answerMarkerCount: turn2.answerMarkerCount,
        responseHistoryMarkerSeen: turn2HistoryMarkerCount > Number(turn2.assistantMarkerHistoryBaselineCount || 0),
      });
      const turn2Failures = filterAssistantMarkerObservationFailures(turn2.failures, turn2FinalMarkerObserved);
      failures.push(...turn2Failures.map((failure) => `turn2: ${failure}`));
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
      answerMarkerCount = Math.max(
        Number(turn2.answerMarkerCount || 0),
        turn2FinalMarkerObserved ? 1 : 0,
      );
      composer = turn2.composer || "";
      lastSample = turn2.lastSample || turn1.lastSample || "";
      answerSample = turn2.answerSample || "";
      activeReconnectSeen = turn1.activeReconnectSeen === true || turn2.activeReconnectSeen === true;
      activeReconnectEvidence.push(...(turn1.activeReconnectEvidence || []), ...(turn2.activeReconnectEvidence || []));
      inLoopIdleDiagnostics = turn2.inLoopIdleDiagnostics || turn1.inLoopIdleDiagnostics || null;

      const idleResult = await waitForStableDesktopIdle(ws, marker, baseUrl, 60_000);
      diagnostics = idleResult.diagnostics;
      if (!diagnostics) {
        failures.push(`diagnostics endpoint did not respond after desktop task: ${idleResult.lastError || "unknown error"}`);
      } else if (idleResult.stable !== true) {
        failures.push(`desktop task did not remain idle for ${idleResult.quietMs} ms after the assistant reply`);
      } else if (!diagnosticsAreIdle(diagnostics)) {
        failures.push("desktop task did not become idle after the assistant reply");
      }
      if (failures.length > 0 && submitSucceeded && diagnosticsShowsActiveTask(diagnostics)) {
        failureCleanup = {
          attempted: false,
          reason: "owned_turn_still_active",
        };
      } else {
        failureCleanup = {
          attempted: false,
          reason: failures.length === 0 ? "task_passed" : "no_active_request",
        };
      }
      const sessionLock = diagnostics?.antigravitySessionLock || null;
      const activeRequests = diagnostics?.activeAntigravityRequests || null;
      const queue = diagnostics?.antigravityQueue || null;
      if (sessionLock?.active === true) failures.push("desktop task left the Antigravity session lock active");
      if (Number(sessionLock?.queued || 0) > 0) failures.push("desktop task left queued Antigravity sessions");
      if (Number(activeRequests?.active || 0) > 0) failures.push("desktop task left active Antigravity requests");
      if (queue?.running === true) failures.push("desktop task left the Antigravity request queue running");
      modelRouteEvidence = await collectModelRouteEvidence(modelRoutesBefore);
      failures.push(...collectRequiredModelFailures(modelRouteEvidence, diagnostics, [turn1, turn2]));
      const observedModelRoute = desktopRealTrafficObserved(modelRouteEvidence, [turn1, turn2]);
      const observedRequestPayload = modelRequestPayloadObserved(diagnostics, [turn1, turn2]);
      const observedRealTraffic = observedModelRoute || observedRequestPayload;
      if (!observedRequestPayload && !observedModelRoute) failures.push("desktop submit did not produce model request evidence");
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
        failureCleanup,
        stableIdleObserved: idleResult.stable === true,
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
      let firstArtifactEvidence = await waitForArtifactEvidence(
        () => verifyRepoMultiFileEditFixture(marker),
        (evidence) => collectRepoMultiFileReadmeFailures(evidence).length === 0,
        Math.min(timeoutMs, 120_000),
      );
      const firstStableIdle = await waitForStableDesktopIdle(ws, marker, baseUrl, Math.min(timeoutMs, 45_000), 3_000);
      firstArtifactEvidence = verifyRepoMultiFileEditFixture(marker);
      const firstTurnSettle = repoMultiArtifactIdleSettle(turn1, "readme", firstArtifactEvidence, firstStableIdle);
      const firstArtifactFailures = collectRepoMultiFileReadmeFailures(firstArtifactEvidence);
      const actionableTurn1Failures = filterRepoMultiReadmeTextOnlyFailures(turn1.failures, firstArtifactFailures);
      if (firstTurnSettle.ok !== true) {
        actionableTurn1Failures.push("first turn did not finish with fresh final text, tool output, and stable idle");
      }
      let implementationPrompt = null;
      let turn2 = null;
      artifactEvidence = firstArtifactEvidence;
      let finalArtifactFailures = firstArtifactFailures;
      let finalTurnSettle = firstTurnSettle;
      let finalStableIdle = firstStableIdle;
      if (firstArtifactFailures.length === 0 && actionableTurn1Failures.length === 0) {
        implementationPrompt = buildRepoMultiFileImplementationPrompt(collectRepoMultiFileEditFailures(firstArtifactEvidence));
        makeWritable(repoMultiFileSource);
        turn2 = await submitDesktopPromptAndWait(ws, implementationPrompt, marker, timeoutMs, { requiresProjectChat });
        artifactEvidence = await waitForArtifactEvidence(
          () => verifyRepoMultiFileEditFixture(marker),
          (evidence) => collectRepoMultiFileEditFailures(evidence).length === 0,
          Math.min(timeoutMs, 120_000),
        );
        finalStableIdle = await waitForStableDesktopIdle(ws, marker, baseUrl, Math.min(timeoutMs, 60_000), 10_000);
        artifactEvidence = verifyRepoMultiFileEditFixture(marker);
        finalTurnSettle = repoMultiArtifactIdleSettle(turn2, "full", artifactEvidence, finalStableIdle);
        finalArtifactFailures = collectRepoMultiFileEditFailures(artifactEvidence);
        if (finalTurnSettle.ok !== true) {
          finalArtifactFailures.push("repo-multi-file-edit did not finish with fresh final text, tool output, and stable idle");
        }
      }
      const finalTurn = turn2 || turn1;
      failures.push(...actionableTurn1Failures.map((failure) => `readme-step: ${failure}`));
      if (turn2) failures.push(...turn2.failures.map((failure) => `implementation-step: ${failure}`));
      failures.push(...finalArtifactFailures);
      pushUniqueFailures(failures, collectAgenticResponseHistoryFailures(taskMode, artifactEvidence, false));

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

      const idleResult = finalStableIdle;
      diagnostics = idleResult.diagnostics;
      if (!diagnostics) {
        failures.push(`diagnostics endpoint did not respond after desktop task: ${idleResult.lastError || "unknown error"}`);
      } else if (idleResult.stable !== true || !diagnosticsAreIdle(diagnostics)) {
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
      failures.push(...collectRequiredModelFailures(modelRouteEvidence, diagnostics, [turn1, turn2]));
      const observedModelRoute = desktopRealTrafficObserved(modelRouteEvidence, [turn1, turn2]);
      const observedRequestPayload = modelRequestPayloadObserved(diagnostics, [turn1, turn2]);
      const observedRealTraffic = observedModelRoute || observedRequestPayload;
      if (!observedRequestPayload && !observedModelRoute) failures.push("desktop submit did not produce model request evidence");
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
        stableIdleObserved: idleResult.stable === true,
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

    nativeActivityPreflight = await beginNativeSingleTaskWindow();
    await closeManagerOverlayIfOpen(ws);
    markerBaselineCount = countMarkerOccurrences(await readVisibleMainPaneText(ws), marker);
    assistantMarkerHistoryBaselineCount = responseHistoryAssistantMarkerCount(marker);
    assistantMarkerHistoryCount = assistantMarkerHistoryBaselineCount;
    requestMarkerEntryIdsBefore = responseHistoryMarkerEntryIds(marker);
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
    await closeOpenModelMenusAndOverlays(ws, { timeoutMs: 6_000 });
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
      }
      // Model selection can leave a dialog mask over the send control. Dismiss it,
      // then locate the control again before the real CDP mouse click.
      const overlayClose = await closeOpenModelMenusAndOverlays(ws, { timeoutMs: 6_000 });
      prep = await waitForComposerPromptReady(ws, promptText, 5_000);
      if (prep?.composerMatches !== true) {
        failures.push("composer changed while confirming the required model before submit");
      }
      if (prep?.hasSendButton !== true) {
        const overlayCloseRetry = await closeOpenModelMenusAndOverlays(ws, { timeoutMs: 4_000 });
        prep = await waitForComposerPromptReady(ws, promptText, 5_000);
        overlayClose.ok = overlayClose.ok === true || overlayCloseRetry.ok === true;
      }
      if (prep?.hasSendButton !== true) {
        failures.push("send button remained blocked after closing model menus and overlays");
      }
      const rect = prep?.hasSendButton === true ? prep?.selected?.rect || null : null;
      if (prep?.hasSendButton === true && (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h))) {
        failures.push("send button coordinates were not available");
      } else {
        if (rect) {
          const submitDiagnosticsBefore = await httpJson(diagnosticsUrl).catch(() => null);
          submitPayloadsBefore = responsesWebSocketPayloadCount(submitDiagnosticsBefore);
          const x = rect.x + (rect.w / 2);
          const y = rect.y + (rect.h / 2);
          await ws.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
          await ws.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await ws.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          clicked = true;
        }
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
        overlayClearedBeforeClick: overlayClose?.ok === true,
        clickPoint: prep?.selected?.rect
          ? { x: prep.selected.rect.x + (prep.selected.rect.w / 2), y: prep.selected.rect.y + (prep.selected.rect.h / 2) }
          : null,
      };
      const submitWaitMs = requiredModelNeedles().length > 0 ? 15_000 : 4_000;
      const firstConfirmation = await confirmDesktopSubmitBeforeReplay(
        ws,
        promptText,
        marker,
        submitPayloadsBefore,
        requestMarkerEntryIdsBefore,
        submitWaitMs,
      );
      submitEvidence.firstConfirmation = firstConfirmation;
      submitSucceeded = firstConfirmation.ok;
      let finalConfirmation = firstConfirmation;
      if (!firstConfirmation.ok) {
        await pressComposerEnter(ws);
        submitEvidence.enterFallback = true;
        submitEvidence.clickMethod = "cdp-mouse-enter-fallback";
        finalConfirmation = await confirmDesktopSubmitBeforeReplay(
          ws,
          promptText,
          marker,
          submitPayloadsBefore,
          requestMarkerEntryIdsBefore,
          submitWaitMs,
        );
        submitEvidence.enterConfirmation = finalConfirmation;
        submitSucceeded = finalConfirmation.ok;
      }
      const realSubmit = finalConfirmation.realSubmit;
      submitEvidence.composerCleared = finalConfirmation.composerCleared;
      submitEvidence.realSubmit = realSubmit;
      if (realSubmit?.ok === true) {
        submitEvidence.submitConfirmedBy = realSubmit.source === "codex-rollout" ? "codex-rollout" : "responses-websocket";
        submitSucceeded = true;
      } else if (finalConfirmation.composerCleared) {
        submitEvidence.submitConfirmedBy = "composer-cleared-no-replay";
      }
      if (clicked && realSubmit?.ok !== true && !finalConfirmation.composerCleared) {
        submitEvidence.emptyPrewarmRetry = realSubmit;
        submitEvidence.submitConfirmedBy = "submit-not-confirmed";
      }
      const maxInputItems = taskMode === "autonomous-reasoning" ? 80 : 0;
      if (submitSucceeded && maxInputItems > 0) {
        const effectiveRealSubmit = submitEvidence.retryRealSubmit?.ok === true
          ? submitEvidence.retryRealSubmit
          : submitEvidence.realSubmit;
        if (effectiveRealSubmit?.ok !== true) {
          submitSucceeded = false;
        } else if (realSubmitInputItems(effectiveRealSubmit) > maxInputItems) {
          submitEvidence.contextGuard = {
            ok: false,
            inputItems: realSubmitInputItems(effectiveRealSubmit),
            maxInputItems,
          };
          failures.push(`desktop submit carried too much restored context: inputItems=${realSubmitInputItems(effectiveRealSubmit)}, max=${maxInputItems}`);
          submitSucceeded = false;
        }
      }
      if (submitSucceeded) {
        submitCompletedAt = Date.now();
        windowActivationEvidence.postSubmit = activateAntiCodexWindow(windowActivationEvidence?.processId);
      }
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
      count = countMarkerOccurrences(text, marker);
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
      const visibleAnswerMarkerCount = countNewAssistantMarkers({
        visibleText: text,
        marker,
        baselineMarkerCount: markerBaselineCount,
        submittedPrompt: promptText,
      });
      assistantMarkerHistoryCount = responseHistoryAssistantMarkerCount(marker);
      answerMarkerCount = countObservedAssistantMarkers({
        visibleNewMarkerCount: visibleAnswerMarkerCount,
        recentVisibleText: lastSample,
        marker,
        assistantHistoryCount: assistantMarkerHistoryCount,
        assistantHistoryBaselineCount: assistantMarkerHistoryBaselineCount,
      });
      if (answerMarkerCount >= 1 && !firstReplySeenAt) firstReplySeenAt = Date.now();
      if (resultDrivenCompletionEnabled) {
        const rolloutBundles = codexRolloutMarkerBundles(marker);
        const latestTurnError = String(rolloutBundles[0]?.latestMarkerTurnError || "").trim();
        if (latestTurnError) {
          resultDrivenCompletionError = latestTurnError;
          firstReplySeenAt ||= Date.now();
          idleCompletedAt = Date.now();
          break;
        }
        const fixedRouteHealth = await readFixedRouteHealth();
        if (resultDrivenTurnCompletionReady({
          enabled: true,
          rolloutBundles,
          composerText: composer,
          marker,
          routeReady: fixedRouteHealthIsReady(fixedRouteHealth),
          authoritativeArtifactReady: requiredFileCompletionReady(),
        })) {
          resultDrivenCompletionObserved = true;
          inLoopIdleDiagnostics = fixedRouteIdleDiagnostics(fixedRouteHealth, "codex-rollout-current-turn-complete");
          firstReplySeenAt ||= Date.now();
          idleCompletedAt = Date.now();
          break;
        }
      }
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
            break;
          }
        } catch {}
      }
      if (taskMode === "free-chat") {
        const normalizedAnswer = answerSample.replace(/完全访问|输出|暂无产物|来源|暂无来源|Gemini[^\n]*/g, "").trim();
        if (!composer.includes(promptText) && /[\u4e00-\u9fff]/.test(normalizedAnswer) && !/正在思考|已处理|停止了|重新连接/.test(normalizedAnswer)) break;
      } else if (taskMode === "repo-file-edit") {
        artifactEvidence = verifyRepoFileEditFixture();
        if (answerMarkerCount >= 1
          && !composerHasUnsubmittedMarker({ composerText: composer, marker, answerMarkerCount })
          && artifactEvidence?.testPassed === true) {
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
        if (!composerHasUnsubmittedMarker({ composerText: composer, marker, answerMarkerCount }) && artifactFailures.length === 0) {
          try {
            const loopDiagnostics = await httpJson(diagnosticsUrl);
            if (diagnosticsAreIdle(loopDiagnostics)) {
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
          } catch {}
        }
      } else if (taskMode === "report-site") {
        artifactEvidence = verifyReportSiteArtifact(artifactDir, marker);
        const artifactFailures = collectReportSiteArtifactFailures(artifactEvidence);
        if (!composerHasUnsubmittedMarker({ composerText: composer, marker, answerMarkerCount }) && artifactFailures.length === 0) {
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
        const artifactComplete = complexProjectArtifactComplete(artifactEvidence, { requireModelLed: true });
        try {
          const loopDiagnostics = await httpJson(diagnosticsUrl);
          if (diagnosticsAreIdle(loopDiagnostics)) {
            if (!composerHasUnsubmittedMarker({ composerText: composer, marker, answerMarkerCount }) && artifactComplete) {
              inLoopIdleDiagnostics = loopDiagnostics;
              idleCompletedAt = Date.now();
              break;
            }
            if (shouldRecoverIdleAutonomousTurn({
              diagnosticsIdle: true,
              elapsedMs: Date.now() - waitStartedAt,
              artifactFailureCount: artifactComplete ? 0 : Math.max(1, artifactFailures.length),
              hasToolEvidence,
            })) {
              autonomousIdleIncompleteObserved = true;
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
      } else if (answerMarkerCount >= 1
          && requiredFileCompletionReady()
          && (!requiredFileAuthoritative || latestMarkerTurnCompleted(codexRolloutMarkerBundles(marker)))
          && !composerHasUnsubmittedMarker({ composerText: composer, marker, answerMarkerCount })) {
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
    if (resultDrivenCompletionError) failures.push(`provider turn failed: ${resultDrivenCompletionError}`);
    if (taskMode !== "free-chat" && taskMode !== "repo-file-edit" && answerMarkerCount < 1 && !resultDrivenCompletionObserved && !resultDrivenCompletionError) failures.push("assistant reply marker was not observed after the submitted prompt in the desktop UI");
    if (taskMode !== "free-chat" && taskMode !== "repo-file-edit" && composerHasUnsubmittedMarker({ composerText: composer, marker, answerMarkerCount })) failures.push("composer still contains the submitted prompt");
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
      artifactEvidence.responseHistory = collectResponseHistoryAgenticEvidence(marker);
      if (!artifactEvidence?.files?.target) failures.push("repo-file-edit target file was not present");
      if (!artifactEvidence?.files?.test) failures.push("repo-file-edit test file was not present");
      if (!responseHistoryMarkerSeen) failures.push("repo-file-edit prompt marker was not observed in response history after desktop submit");
      if (artifactEvidence?.testPassed !== true) failures.push("repo-file-edit node:test did not pass after the desktop task");
      if ((artifactEvidence?.responseHistory?.taskToolCallCount || 0) < 1) failures.push("repo-file-edit did not emit a task tool call");
      if (!taskScopedToolOutputObserved(artifactEvidence?.responseHistory)) failures.push("repo-file-edit did not observe task-scoped tool output");
      if (artifactEvidence?.responseHistory?.assistantHasFinalMarker !== true) failures.push("repo-file-edit assistant final marker was not observed in native task history");
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
        (evidence) => requiredFileAuthoritative
          ? requiredFileCompletionReady()
          : evidence?.files?.indexHtml === true
            && evidence?.files?.readmeMd === true
            && evidence?.files?.doneTxt === true
            && evidence.doneExact === true
            && evidence.indexHasMarker === true
            && evidence.readmeNonEmpty === true,
        Math.min(timeoutMs, 90_000),
      );
      artifactEvidence.markerContract = requiredFileAuthoritative ? "required-file" : "local-project-default";
      if (!requiredFileAuthoritative && !artifactEvidence?.files?.indexHtml) failures.push("local-project index.html was not created");
      if (!requiredFileAuthoritative && !artifactEvidence?.files?.readmeMd) failures.push("local-project README.md was not created");
      if (!requiredFileAuthoritative && !artifactEvidence?.files?.doneTxt) failures.push("local-project done.txt was not created");
      if (!requiredFileAuthoritative && artifactEvidence?.files?.doneTxt && artifactEvidence.doneExact !== true) failures.push("local-project done.txt did not exactly match the marker");
      if (!requiredFileAuthoritative && artifactEvidence?.files?.indexHtml && artifactEvidence.indexHasMarker !== true) failures.push("local-project index.html did not contain the marker");
      if (!requiredFileAuthoritative && artifactEvidence?.files?.readmeMd && artifactEvidence.readmeNonEmpty !== true) failures.push("local-project README.md was empty");
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
      if (!taskScopedToolOutputObserved(artifactEvidence?.responseHistory)
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
            && taskScopedToolOutputObserved(evidence?.responseHistory)
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
      const artifactWaitMs = taskMode === "autonomous-reasoning" && autonomousIdleIncompleteObserved
        ? Math.min(timeoutMs, 10_000)
        : Math.min(timeoutMs, 240_000);
      artifactEvidence = await waitForArtifactEvidence(
        () => verifyComplexProjectArtifact(artifactDir, marker),
        (evidence) => complexProjectArtifactComplete(evidence, { requireModelLed: complexProjectRequiresModelLed }),
        artifactWaitMs,
        () => taskMode === "complex-project"
          && latestMarkerTurnCompleted(codexRolloutMarkerBundles(marker)),
      );
      const autonomousStillIncomplete = taskMode === "autonomous-reasoning"
        && autonomousIdleIncompleteObserved
        && !complexProjectArtifactComplete(artifactEvidence, { requireModelLed: complexProjectRequiresModelLed });
      if (complexProjectRequiresModelLed && !autonomousStillIncomplete && !taskScopedToolOutputObserved(artifactEvidence?.responseHistory)) {
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
      if (artifactEvidence?.files?.analyzer && artifactEvidence.exportsFunction !== true) failures.push("complex-project analyzer did not export analyze and summarizeSources");
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
      if (complexProjectRequiresModelLed && !taskScopedToolOutputObserved(artifactEvidence?.responseHistory)) {
        failures.push("complex-project did not observe task-scoped tool output");
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
        () => latestMarkerTurnCompleted(codexRolloutMarkerBundles(marker)),
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
        const idleBeforeContinuation = await waitForIdleDiagnostics(baseUrl, 15_000);
        if (!diagnosticsAreIdle(idleBeforeContinuation.diagnostics)) {
          throw new Error("previous owned turn is still active; refusing a global session reset");
        }
        let visibleIdleBeforeContinuation = await waitForVisibleComposerIdle(ws, 10_000);
        let staleComposerRecovery = null;
        if (diagnosticsAreIdle(idleBeforeContinuation.diagnostics) && visibleIdleBeforeContinuation?.ok !== true) {
          const recovered = await ws.send("Runtime.evaluate", {
            expression: recoverIdleBackendStaleComposerExpression(),
            returnByValue: true,
            awaitPromise: true,
          });
          staleComposerRecovery = recovered.result?.result?.value || null;
          staleComposerRecovery = await clickRecoveryControlsWithMouse(ws, staleComposerRecovery);
          visibleIdleBeforeContinuation = await waitForVisibleComposerIdle(ws, 10_000);
        }
        autonomousContinuationNewChatEvidence = {
          strategy: "same-task-continuation",
          resetEvidence: { attempted: false, reason: "previous_turn_became_idle" },
          diagnosticsIdleBeforeContinuation: diagnosticsAreIdle(idleBeforeContinuation.diagnostics),
          visibleIdleBeforeContinuation,
          staleComposerRecovery,
        };
        await ws.send("Runtime.evaluate", {
          expression: "document.querySelector('.ProseMirror')?.focus()",
          returnByValue: true,
          awaitPromise: true,
        });
      } catch (error) {
        autonomousContinuationNewChatEvidence = { strategy: "same-task-continuation", ok: false, error: error instanceof Error ? error.message : String(error) };
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
  if (repairTurn) inLoopIdleDiagnostics = null;
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

  if (taskMode === "complex-project") {
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

  const idleTimeoutMs = stableIdleTimeoutForTaskMode(taskMode);
  const idleResult = await waitForStableDesktopIdle(ws, marker, baseUrl, idleTimeoutMs);
  const reconnectOutcome = classifyReconnectOutcome({
    reconnectSeen: activeReconnectSeen,
    answerText: answerSample,
    completionObserved: answerMarkerCount >= 1 || resultDrivenCompletionObserved || Boolean(artifactEvidence),
    stableIdleObserved: idleResult.stable === true,
  });
  if (reconnectOutcome.terminalProviderError) {
    failures.push(`provider turn failed: ${reconnectOutcome.terminalProviderError}`);
  } else if (reconnectOutcome.unresolved) {
    failures.push("reconnect remained unresolved after the submitted prompt");
  }
  diagnostics = idleResult.diagnostics;
  if (!diagnostics) {
    failures.push(`diagnostics endpoint did not respond after desktop task: ${idleResult.lastError || "unknown error"}`);
  } else if (idleResult.stable !== true) {
    failures.push(`desktop task did not remain idle for ${idleResult.quietMs} ms after the assistant reply`);
  } else if (!diagnosticsAreIdle(diagnostics)) {
    failures.push("desktop task did not become idle after the assistant reply");
  }
  if (taskMode === "agentic-step-flow") {
    const finalAgenticStepFlowEvidence = verifyAgenticStepFlowArtifact(artifactDir, marker);
    artifactEvidence = finalAgenticStepFlowEvidence;
  }
  if (failures.length > 0 && submitSucceeded && diagnosticsShowsActiveTask(diagnostics)) {
    failureCleanup = {
      attempted: false,
      reason: "owned_turn_still_active",
    };
  } else {
    failureCleanup = {
      attempted: false,
      reason: failures.length === 0 ? "task_passed" : "no_active_request",
    };
  }
  const sessionLock = diagnostics?.antigravitySessionLock || null;
  const activeRequests = diagnostics?.activeAntigravityRequests || null;
  const queue = diagnostics?.antigravityQueue || null;
  if (sessionLock?.active === true) failures.push("desktop task left the Antigravity session lock active");
  if (Number(sessionLock?.queued || 0) > 0) failures.push("desktop task left queued Antigravity sessions");
  if (Number(activeRequests?.active || 0) > 0) failures.push("desktop task left active Antigravity requests");
  if (queue?.running === true) failures.push("desktop task left the Antigravity request queue running");
  if (taskMode === "report-site") {
    artifactEvidence = await waitForArtifactEvidence(
      () => verifyReportSiteArtifact(artifactDir, marker),
      reportSiteFinalEvidenceComplete,
      Math.min(timeoutMs, 15_000),
    );
  }
  nativeSingleTaskEvidence = await inspectNativeSingleTaskWindow(nativeActivityPreflight, marker);
  if (nativeSingleTaskEvidence.ok !== true) failures.push(...nativeSingleTaskEvidence.failureReasons);
  const fixedRouteHealthEvidence = await readFixedRouteHealth();
  const nativeModelRequestObserved = nativeSingleTaskEvidence.ok === true
    && nativeExpectedRequestObserved(nativeSingleTaskEvidence.activity);
  const nativeObservedModels = [...new Set([
    fixedRouteHealthEvidence?.model,
    fixedRouteHealthEvidence?.route?.model,
  ].map((value) => String(value || "").trim()).filter(Boolean))];
  const expectedModelValues = requiredModelNeedles();
  const nativeRequiredModelMatched = expectedModelValues.length === 0
    || nativeObservedModels.some((value) => modelValueMatches(value, expectedModelValues));
  const nativeSubmit = {
    ok: nativeModelRequestObserved
      && fixedRouteHealthIsReady(fixedRouteHealthEvidence)
      && nativeRequiredModelMatched,
    source: "marker-scoped-native-fixed-route",
    markerScopedRequestObserved: nativeModelRequestObserved,
    requiredModelMatched: nativeRequiredModelMatched,
    observedModels: nativeObservedModels,
    expectedThreadIds: nativeSingleTaskEvidence?.activity?.expectedThreadIds || [],
    requestCountsByThread: nativeSingleTaskEvidence?.activity?.requestCountsByThread || {},
    fixedRouteReady: fixedRouteHealthIsReady(fixedRouteHealthEvidence),
  };
  if (submitEvidence && typeof submitEvidence === "object") submitEvidence.nativeSubmit = nativeSubmit;
  modelRouteEvidence = await collectModelRouteEvidence(modelRoutesBefore);
  const submitTurns = [{ submitEvidence }];
  failures.push(...collectRequiredModelFailures(modelRouteEvidence, diagnostics, submitTurns));
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
  const observedModelRoute = desktopRealTrafficObserved(modelRouteEvidence, submitTurns);
  const observedRequestPayload = modelRequestPayloadObserved(diagnostics, submitTurns);
  const observedRealTraffic = observedModelRoute || observedRequestPayload;
  if (!observedRequestPayload && !observedModelRoute) failures.push("desktop submit did not produce model request evidence");
  const requiredFileAfter = requiredFile && existsSync(requiredFile)
    ? { exists: true, size: statSync(requiredFile).size, mtimeMs: statSync(requiredFile).mtimeMs }
    : { exists: false, size: 0, mtimeMs: 0 };
  const requiredFileEvidence = requiredFile ? {
    path: requiredFile,
    before: requiredFileBefore,
    after: requiredFileAfter,
    changed: requiredFileAfter.exists && (!requiredFileBefore.exists
      || requiredFileAfter.size !== requiredFileBefore.size
      || requiredFileAfter.mtimeMs > requiredFileBefore.mtimeMs),
    requiredContains: requiredFileContains,
    missingContains: requiredFileAfter.exists
      ? requiredFileContains.filter(value => !readFileSync(requiredFile, "utf8").includes(value))
      : requiredFileContains,
  } : null;
  if (requiredFile && !requiredFileAfter.exists) failures.push("desktop task did not create the required file");
  else if (requiredFile && requiredFileAfter.size <= 0) failures.push("desktop task created an empty required file");
  else if (requiredFile && requiredFileEvidence.changed !== true) failures.push("desktop task did not update the required file");
  if (requiredFileEvidence?.missingContains?.length > 0) {
    failures.push(`desktop task required file is missing expected text: ${requiredFileEvidence.missingContains.join(", ")}`);
  }
  const protectedRootEvidence = collectProtectedRootEvidence();
  if (protectedRootEvidence && protectedRootEvidence.ok !== true) {
    failures.push("protected root changed outside the required file");
  }
  const lastRelay = diagnostics?.responsesWebSocket?.lastRelay || null;
  const lastRelayAt = Date.parse(String(lastRelay?.at || ""));
  if (Number(lastRelay?.status || 0) === 409
    && Number.isFinite(lastRelayAt)
    && lastRelayAt >= startedAt - 1000
    && /continuation limit reached/i.test(String(lastRelay?.error || ""))) {
    failures.push("desktop task hit the Antigravity continuation limit");
  }
  assistantMarkerHistoryCount = responseHistoryAssistantMarkerCount(marker);
  const responseHistoryMarkerSeenFinal = assistantMarkerHistoryCount > assistantMarkerHistoryBaselineCount;
  const assistantFinalMarkerObserved = hasAssistantFinalMarkerEvidence({
    answerMarkerCount,
    responseHistoryMarkerSeen: responseHistoryMarkerSeenFinal,
    assistantHasFinalMarker: artifactEvidence?.responseHistory?.assistantHasFinalMarker === true,
  });
  if (taskMode === "report-site" && !assistantFinalMarkerObserved) {
    pushUniqueFailures(failures, ["report-site assistant final marker was not observed at report finalization"]);
  }
  const payload = {
    ok: failures.length === 0,
    reportName,
    requestedRealTraffic: true,
    usedRealTraffic: observedRealTraffic,
    modelRouteObserved: observedModelRoute,
    modelRequestPayloadObserved: observedRequestPayload,
    nativeModelRequestObserved,
    fixedRouteHealthEvidence,
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
    requiredFile: requiredFile || null,
    requiredFileAuthoritative,
    requiredFileEvidence,
    protectedRoot: protectedRoot || null,
    protectedRootEvidence,
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
    windowActivationEvidence,
    submitEvidence,
    submitSucceeded,
    nativeSingleTaskEvidence,
    staleRecovery,
    backendResetBeforeSubmit,
    failureCleanup,
    stableIdleObserved: idleResult.stable === true,
    newChatEvidence,
    sameChatEvidence,
    projectRootEvidence,
    preservedActiveTask,
    autonomousContinuationNewChatEvidence,
      modelSelectionEvidence,
      preSubmitModelSelectionEvidence,
      initialIdleObserved: Boolean(initialIdle?.diagnostics),
    clicked,
    markerCount: count,
    answerMarkerCount,
    markerBaselineCount,
    assistantMarkerHistoryBaselineCount,
    assistantMarkerHistoryCount,
    responseHistoryMarkerSeen: responseHistoryMarkerSeenFinal,
    responseHistoryAnyMarkerSeen: responseHistoryContains(marker),
    assistantFinalMarkerObserved,
    resultDrivenCompletionEnabled,
    resultDrivenCompletionObserved,
    resultDrivenCompletionError: resultDrivenCompletionError || null,
    responseHistoryPath,
    activeReconnectSeen,
    activeReconnectEvidence,
    reconnectOutcome,
    inLoopIdleObserved: Boolean(inLoopIdleDiagnostics),
    composerCleared: !composerHasUnsubmittedMarker({ composerText: composer, marker, answerMarkerCount }),
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

if (singleSubmitHandoff) {
  runSingleSubmitHandoff().then((payload) => {
    console.log(JSON.stringify(payload));
    process.exit(payload.ok ? 0 : 1);
  }).catch((error) => {
    const payload = {
      ok: false,
      reportName,
      singleSubmitHandoff: true,
      taskMode,
      requestedRealTraffic: true,
      usedRealTraffic: false,
      waitedForTaskCompletion: false,
      harnessInterruptedTask: false,
      harnessSubmittedAdditionalTurns: false,
      failures: [error instanceof Error ? error.message : String(error)],
    };
    writeReport(payload);
    console.log(JSON.stringify(payload));
    process.exit(1);
  });
} else if (frontendModelProbeOnly) {
  runFrontendModelProbeOnly().then((payload) => {
    writeReport(payload);
    console.log(JSON.stringify(payload));
    process.exit(payload.ok ? 0 : 1);
  }).catch((error) => {
    const payload = {
      ok: false,
      reportName,
      frontendModelProbeOnly: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      failures: [error instanceof Error ? error.message : String(error)],
    };
    writeReport(payload);
    console.log(JSON.stringify(payload));
    process.exit(1);
  });
} else if (historyProbeOnly) {
  runHistoryProbeOnly().then((payload) => {
    console.log(JSON.stringify(payload));
    process.exit(payload.ok ? 0 : 1);
  }).catch((error) => {
    console.log(JSON.stringify({
      ok: false,
      historyProbeOnly: true,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      failures: [error instanceof Error ? error.message : String(error)],
    }));
    process.exit(1);
  });
} else if (workspaceCommand) {
  runWorkspaceCommandOnly().then((payload) => {
    console.log(JSON.stringify(payload));
    process.exit(0);
  }).catch((error) => {
    console.log(JSON.stringify({
      ok: false,
      workspaceCommand,
      requestedRealTraffic: false,
      usedRealTraffic: false,
      failures: [error instanceof Error ? error.message : String(error)],
    }));
    process.exit(1);
  });
} else {
  main().catch((error) => {
    const protectedRootEvidence = collectProtectedRootEvidence();
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
      requiredFile: requiredFile || null,
      requiredFileAuthoritative,
      protectedRoot: protectedRoot || null,
      protectedRootEvidence,
      projectChatRoot: projectChatRoot || null,
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
}
