import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const launcher = readFileSync(resolve(root, "scripts", "start-anticodex.ps1"), "utf8");
const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
const runtimeSync = readFileSync(resolve(root, "scripts", "sync-anticodex-runtime.ps1"), "utf8");
const manager = readFileSync(resolve(root, "scripts", "manage-anticodex.ps1"), "utf8");

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

test("already-running client is reused only when fixed-route health matches", () => {
  const branch = launcher.match(/if \(\$runningMain\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(branch, /Test-AntiCodexFixedRouteMatches/);
  assert.match(branch, /Activate-AntiCodexWindow/);
  assert.match(branch, /Write-Error/);
  assert.doesNotMatch(branch, /-TranslatorOnly|Stop-Process|start-anticodex-fixed-route/);
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
  assert.match(installer, /Remove-Item -LiteralPath \$legacyPath -Force/);
});
