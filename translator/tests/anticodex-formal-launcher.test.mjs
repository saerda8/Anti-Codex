import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const launcher = readFileSync(resolve(root, "scripts", "start-anticodex.ps1"), "utf8");
const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
const manager = readFileSync(resolve(root, "scripts", "manage-anticodex.ps1"), "utf8");
const fixedRouteSupervisor = readFileSync(resolve(root, "scripts", "start-anticodex-fixed-route.mjs"), "utf8");
const antigravityDesktop = readFileSync(resolve(root, "scripts", "antigravity-desktop.ps1"), "utf8");
const postVerification = readFileSync(resolve(root, "scripts", "test-anticodex-post-verification.ps1"), "utf8");
const modelRefresh = readFileSync(resolve(root, "scripts", "refresh-anticodex-models.ps1"), "utf8");
const conversationCleanup = readFileSync(resolve(root, "scripts", "clear-anticodex-conversations.ps1"), "utf8");
const hostSync = readFileSync(resolve(root, "scripts", "sync-anticodex.ps1"), "utf8");
const rollback = readFileSync(resolve(root, "scripts", "rollback-anticodex.ps1"), "utf8");

test("formal launcher uses the fixed CodexPlusPlus route as the only model path", () => {
  assert.match(launcher, /start-anticodex-fixed-route\.mjs/);
  assert.match(launcher, /18487/);
  assert.match(launcher, /anticodex\/fixed-route\/health/);
  assert.match(launcher, /ANTICODEX_PROVIDER/);
  assert.match(launcher, /ANTICODEX_MODEL/);
  assert.match(launcher, /UPSTREAM_PROTOCOL/);
  assert.match(launcher, /UPSTREAM_URL/);
  assert.match(launcher, /UPSTREAM_API_KEY/);
  assert.match(launcher, /Start-Process -FilePath \$nodeExecutable/);
  assert.match(launcher, /-WindowStyle Hidden/);
  assert.doesNotMatch(launcher, /Test-AntiCodexTranslatorMatchesConfiguredUpstream/);
  assert.doesNotMatch(launcher, /Normalize-AntiCodexAntigravityTransport/);
  assert.doesNotMatch(launcher, /ANTICODEX_NATIVE_TOOL_BRIDGE/);
});

test("formal launcher records startup stages and surfaces hidden-launch failures", () => {
  assert.match(launcher, /launcher-state\.json/);
  assert.match(launcher, /function Write-AntiCodexLauncherState/);
  assert.match(launcher, /trap\s*\{/);
  assert.match(launcher, /System\.Windows\.Forms\.MessageBox/);
});

test("inline supervisor keeps its parent alive and contains native stderr in durable logs", () => {
  const start = launcher.lastIndexOf("if ($InlineSupervisor) {");
  const end = launcher.indexOf("\n}", start);
  const inlineBlock = start >= 0 && end > start ? launcher.slice(start, end + 2) : "";
  assert.match(inlineBlock, /& \$nodeExecutable @inlineSupervisorArgs 1>> \$launcherOutLog 2>> \$launcherErrLog/);
  assert.match(inlineBlock, /\$savedErrorActionPreference\s*=\s*\$ErrorActionPreference/);
  assert.match(inlineBlock, /\$ErrorActionPreference\s*=\s*"Continue"/);
  assert.match(inlineBlock, /finally\s*\{\s*\$ErrorActionPreference\s*=\s*\$savedErrorActionPreference\s*\}/);
  assert.match(inlineBlock, /\$inlineExitCode = \[int\]\$LASTEXITCODE/);
  assert.doesNotMatch(inlineBlock, /Start-Process/);
});

test("every production relaunch keeps the fixed-route supervisor attached", () => {
  const managerLaunches = [...manager.matchAll(/Start-ManagerScript "start-anticodex\.ps1"[^\r\n]*/g)]
    .map((match) => match[0]);
  assert.equal(managerLaunches.length, 3);
  assert.ok(managerLaunches.every((line) => /-Arguments\s+@\("-InlineSupervisor"\)/.test(line)));

  const managerGatewayStart = manager.match(/\$launcher = Join-Path \$scriptRoot "start-anticodex\.ps1"[\s\S]*?return Wait-ManagerHealth/)?.[0] ?? "";
  assert.match(managerGatewayStart, /-InlineSupervisor/);
  assert.match(modelRefresh, /-File[^\r\n]*\$startAntiCodex[^\r\n]*-InlineSupervisor/);
  assert.match(conversationCleanup, /"-SkipUpdateCheck"[\s\S]*?"-InlineSupervisor"/);
  assert.match(hostSync, /-File[^\r\n]*\$StartScript[^\r\n]*-InlineSupervisor/);
  assert.match(rollback, /-File[^\r\n]*\$startAntiCodex[^\r\n]*-InlineSupervisor/);
});

test("launcher gives an auto-started Antigravity desktop durable output handles", () => {
  assert.match(antigravityDesktop, /function Start-AntigravityDesktop/);
  assert.match(antigravityDesktop, /antigravity-desktop\.out\.log/);
  assert.match(antigravityDesktop, /antigravity-desktop\.err\.log/);
  assert.match(antigravityDesktop, /Start-Process -FilePath \$ExecutablePath[\s\S]*?-RedirectStandardOutput \$stdoutPath[\s\S]*?-RedirectStandardError \$stderrPath/);
  assert.match(launcher, /Start-AntigravityDesktop -ExecutablePath \$antigravityPath -StateRoot \$StateRoot/);
  assert.match(launcher, /Ensure-AntigravityDesktop -StateRoot \$stateRoot/);
  assert.doesNotMatch(launcher, /Start-Process -FilePath \$antigravityPath\s*\|/);
  assert.match(postVerification, /Start-AntigravityDesktop -ExecutablePath \$path/);
  assert.doesNotMatch(postVerification, /Start-Process -FilePath \$path\s*\|/);
  assert.doesNotMatch(antigravityDesktop, /Get-CimInstance/);
  assert.match(launcher, /function Test-AntiCodexManagedLaunchBoundary/);
  assert.match(launcher, /Get-CimInstance Win32_Process/);
});

test("Antigravity fixed route preserves native UI model selection", () => {
  assert.doesNotMatch(fixedRouteSupervisor, /adapterOptions:\s*\{\s*fixedModel:/);
  assert.doesNotMatch(fixedRouteSupervisor, /CODEX_PLUS_FIXED_MODEL/);
});

test("already-running client is reused only when fixed-route health matches", () => {
  const branch = launcher.match(/if \(\$runningMain\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(branch, /Test-AntiCodexFixedRouteMatches/);
  assert.match(branch, /Activate-AntiCodexWindow/);
  assert.match(branch, /Write-Error/);
  assert.doesNotMatch(branch, /-TranslatorOnly|Stop-Process|start-anticodex-fixed-route/);
});

test("a stale persisted supervisor PID cannot block a fresh desktop launch", () => {
  const start = launcher.indexOf("function Get-RunningFixedRouteSupervisor");
  const end = launcher.indexOf("function Activate-AntiCodexWindow", start);
  const block = start >= 0 && end > start ? launcher.slice(start, end) : "";
  assert.match(block, /Get-AntiCodexFixedRouteHealth/);
  assert.match(block, /\[int\]\$health\.pid\s+-ne\s+\$processId/);
  assert.match(block, /return \$null/);
});

test("interactive launch gracefully hands off an existing headless route", () => {
  const functionStart = launcher.indexOf("function Stop-AntiCodexHeadlessFixedRoute");
  const functionEnd = launcher.indexOf("function Ensure-AntigravityDesktop", functionStart);
  const handoff = functionStart >= 0 && functionEnd > functionStart
    ? launcher.slice(functionStart, functionEnd)
    : "";
  assert.match(handoff, /fixed-route\/shutdown/);
  assert.match(handoff, /auth\.json/);
  assert.match(handoff, /Authorization/);
  assert.match(handoff, /Get-Process -Id/);
  assert.doesNotMatch(handoff, /taskkill|Get-CimInstance/);

  const branchStart = launcher.indexOf("$existingSupervisor = Get-RunningFixedRouteSupervisor");
  const branchEnd = launcher.indexOf("if ($selection.provider -eq \"antigravity\")", branchStart);
  const branch = branchStart >= 0 && branchEnd > branchStart
    ? launcher.slice(branchStart, branchEnd)
    : "";
  assert.match(branch, /\.headless\s+-eq\s+\$true/);
  assert.match(branch, /Stop-AntiCodexHeadlessFixedRoute/);
  assert.match(branch, /\$existingSupervisor\s*=\s*\$null/);
});

test("launcher delegates Manager ownership to the fixed-route supervisor", () => {
  assert.match(launcher, /ANTICODEX_MANAGER_API/);
  assert.doesNotMatch(launcher, /Ensure-AntiCodexManagerApi/);
  assert.doesNotMatch(launcher, /-TranslatorOnly/);
  assert.doesNotMatch(launcher, /start-deepcodex\.ps1/);
  assert.doesNotMatch(launcher, /translatorLoopbackUrl/);
  assert.doesNotMatch(launcher, /base_url\s*=.*8484/i);
});

test("launcher never contains an automatic visible-client relaunch loop", () => {
  assert.doesNotMatch(launcher, /MAX_RESTARTS|RESTART_BACKOFF|auto-restart|start-deepcodex\.ps1["']?\s*\)$/i);
  assert.match(launcher, /Refusing to launch a second Anti-Codex window/);
});

test("install and runtime sync require every fixed-route production module", () => {
  const required = [
    "scripts\\antigravity-desktop.ps1",
    "scripts\\apply-anticodex-upstream.ps1",
    "scripts\\start-anticodex-task.mjs",
    "scripts\\start-anticodex-fixed-route.mjs",
    "scripts\\anticodex-manager-service.mjs",
    "scripts\\install-codexplusplus-component.ps1",
    "scripts\\lib\\anticodex-fixed-route.mjs",
    "scripts\\deepcodex-cdp-inject.mjs",
    "scripts\\anticodex-manager-bridge.mjs",
    "scripts\\anticodex-manager-inject.js",
    "scripts\\anticodex-manager-open-inject.js",
    "translator\\antigravity-model-catalog.mjs",
    "translator\\antigravity-native-mcp-bridge.mjs",
    "translator\\provider\\antigravity-cascade-client.mjs",
    "translator\\provider\\antigravity-chat-adapter.mjs",
    "translator\\provider\\antigravity-chat-server.mjs",
    "translator\\provider\\codexplusplus-upstream-probe.mjs",
    "translator\\provider\\start-antigravity-chat-provider.mjs",
  ];
  for (const path of required) {
    assert.ok(installer.includes(path), `installer missing ${path}`);
    assert.ok(runtimeSync.includes(path), `runtime sync missing ${path}`);
  }
  const syntaxList = runtimeSync.match(/\$syntaxCheckedJavaScriptFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  for (const path of required.filter((path) => /\.m?js$/.test(path))) {
    assert.ok(syntaxList.includes(path), `runtime syntax checks missing ${path}`);
  }
  assert.match(runtimeSync, /-Label "source \$relative"/);
  assert.match(runtimeSync, /-Label "runtime \$relative"/);
  assert.match(runtimeSync, /anticodex-manager-service-v1/);
  assert.match(runtimeSync, /anticodex\/fixed-route\/health/);
  assert.doesNotMatch(runtimeSync, /Wait-AntiCodexSessionLock|antigravitySessionLockPresent/);
});

test("runtime sync restarts only the fixed three-layer supervisor", () => {
  const requiredList = runtimeSync.match(/\$requiredSourceFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  const syntaxList = runtimeSync.match(/\$syntaxCheckedJavaScriptFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  for (const legacy of [
    "translator\\adaptive-server.mjs",
    "translator\\antigravity-upstream.mjs",
    "translator\\upstream-provider.mjs",
    "translator\\compat-rules.mjs",
    "translator\\codex-native-harness-turn.mjs",
    "translator\\codex-native-protocol.mjs",
    "translator\\codex-native-sse.mjs",
    "translator\\codex-native-compact.mjs",
    "translator\\response-history.mjs",
  ]) {
    assert.ok(!requiredList.includes(legacy), `runtime sync still requires ${legacy}`);
    assert.ok(!syntaxList.includes(legacy), `runtime sync still syntax-checks ${legacy}`);
  }
  assert.match(runtimeSync, /Stop-AntiCodexFixedRouteSupervisor/);
  assert.match(runtimeSync, /Invoke-AntiCodexFixedRouteLauncher/);
  assert.match(runtimeSync, /start-anticodex\.ps1/);
  assert.doesNotMatch(runtimeSync, /Start-AntiCodexTranslatorDirect|Set-AntiCodexTranslatorRestartEnvironment|Get-AntiCodexTranslatorProcesses|ANTICODEX_TRANSLATOR_RESTART/);
});

test("runtime sync no-restart mode verifies copied files without polling live health", () => {
  assert.match(runtimeSync, /\$runtimeHashMismatches\s*=\s*@\(/);
  assert.match(runtimeSync, /Get-FileHash[^\r\n]*SHA256/);
  assert.match(runtimeSync, /if \(-not \$NoRestart\) \{[\s\S]*?Wait-AntiCodexHealth/);
  assert.match(runtimeSync, /mode = if \(\$NoRestart\) \{ "synced_without_restart" \}/);
  assert.match(runtimeSync, /verifiedFileCount = \$requiredSourceFiles\.Count/);
});

test("runtime sync verifies the supervisor PID after a taskkill child-exit race", () => {
  const start = runtimeSync.indexOf("function Stop-AntiCodexFixedRouteSupervisor");
  const end = runtimeSync.indexOf("function Remove-AntiCodexLegacyRuntimeFiles", start);
  const stop = runtimeSync.slice(start, end);
  assert.match(stop, /\$savedErrorActionPreference/);
  assert.match(stop, /\$ErrorActionPreference\s*=\s*"Continue"/);
  assert.match(stop, /\$taskkillExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(stop, /\$stillRunning\s*=\s*Get-Process -Id/);
  assert.match(stop, /if \(\$taskkillExitCode -ne 0 -and \$stillRunning\)/);
});

test("runtime sync requests graceful fixed-route shutdown before taskkill fallback", () => {
  const start = runtimeSync.indexOf("function Stop-AntiCodexFixedRouteSupervisor");
  const end = runtimeSync.indexOf("function Remove-AntiCodexLegacyRuntimeFiles", start);
  const stop = runtimeSync.slice(start, end);
  const graceful = stop.indexOf("Invoke-AntiCodexFixedRouteShutdown");
  const force = stop.indexOf("taskkill.exe");
  assert.ok(graceful >= 0, "missing graceful shutdown request");
  assert.ok(force > graceful, "taskkill must remain a fallback");
  assert.match(runtimeSync, /anticodex\/fixed-route\/shutdown/);
  assert.match(runtimeSync, /Authorization/);
});

test("standalone Manager recovery uses the formal fixed-route launcher", () => {
  assert.match(manager, /start-anticodex\.ps1/);
  assert.doesNotMatch(manager, /start-deepcodex\.ps1|-TranslatorOnly|TRANSLATOR_(?:PORT|HOST|LISTEN_HOST|URL|UPSTREAM_MODE)|ANTICODEX_NATIVE_TOOL_BRIDGE/);
});

test("installer requires fixed-route modules and removes legacy runtime files", () => {
  const requiredRuntimeList = installer.match(/foreach \(\$requiredRuntimePath in @\(([\s\S]*?)\n\s*\)\)/)?.[1] ?? "";
  for (const legacy of [
    "translator\\adaptive-server.mjs",
    "translator\\codex-native-compact.mjs",
    "translator\\codex-native-harness-turn.mjs",
    "translator\\codex-native-protocol.mjs",
    "translator\\codex-native-sse.mjs",
  ]) {
    assert.ok(!requiredRuntimeList.includes(legacy), `installer still requires ${legacy}`);
  }
  assert.match(installer, /\$legacyRuntimeFiles\s*=\s*@\(/);
  assert.match(installer, /scripts\\start-anticodex-task-hidden\.vbs/);
  assert.match(installer, /scripts\\start-anticodex-task-hidden\.ps1/);
  assert.match(installer, /Remove-Item -LiteralPath \$legacyPath -Force/);
});
