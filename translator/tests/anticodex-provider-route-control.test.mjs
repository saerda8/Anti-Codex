import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const profile = readFileSync(resolve(root, "scripts", "anticodex-upstream-profile.ps1"), "utf8");
const managerUi = readFileSync(resolve(root, "scripts", "anticodex-manager-inject.js"), "utf8");
const applyRoute = readFileSync(resolve(root, "scripts", "apply-anticodex-upstream.ps1"), "utf8");
const controlApi = readFileSync(resolve(root, "scripts", "anticodex-manager-service.mjs"), "utf8");

test("saved third-party profiles expose only CodexPlusPlus-native protocols", () => {
  assert.match(profile, /ValidateSet\("",\s*"openai-compatible",\s*"responses"\)/);
  assert.match(profile, /Protocol must be openai-compatible or responses/);
  assert.doesNotMatch(profile, /ValidateSet\([^\n]+"anthropic"/);
  assert.doesNotMatch(profile, /\$Protocol -ne "anthropic"/);
});

test("Manager labels third-party routes as Chat Completions or Responses", () => {
  assert.match(managerUi, /value:\s*"openai-compatible",\s*text:\s*"Chat Completions"/);
  assert.match(managerUi, /value:\s*"responses",\s*text:\s*"Responses"/);
  assert.match(managerUi, /\/v1\/chat\/completions/);
  assert.match(managerUi, /\/v1\/responses/);
  assert.doesNotMatch(managerUi, /value:\s*"anthropic",\s*text:\s*"Anthropic 原生"/);
});

test("apply route restarts the fixed supervisor instead of the legacy model translator", () => {
  assert.match(applyRoute, /start-anticodex-fixed-route\.mjs/);
  assert.match(applyRoute, /start-anticodex\.ps1/);
  assert.match(applyRoute, /Get-RunningFixedRouteSupervisor/);
  assert.match(applyRoute, /taskkill\.exe/);
  assert.match(applyRoute, /\/PID/);
  assert.match(applyRoute, /\/T/);
  assert.doesNotMatch(applyRoute, /start-deepcodex\.ps1|-TranslatorOnly/);
  assert.doesNotMatch(applyRoute, /\/IM|Anti-Codex\.exe.*Stop-Process/i);
});

test("apply route tolerates a taskkill child-exit race only after the supervisor PID is gone", () => {
  assert.match(applyRoute, /\$savedErrorActionPreference\s*=\s*\$ErrorActionPreference/);
  assert.match(applyRoute, /\$ErrorActionPreference\s*=\s*"Continue"/);
  assert.match(applyRoute, /\$taskkillExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(applyRoute, /Get-Process\s+-Id\s+\$supervisorPid\s+-ErrorAction\s+SilentlyContinue/);
  assert.match(applyRoute, /if\s*\(\$taskkillExitCode\s+-ne\s+0\s+-and\s+\$stillRunning\)/);
});

test("Manager control plane probes CodexPlusPlus protocols and waits for the fixed route", () => {
  assert.match(controlApi, /from "\.\.\/translator\/provider\/codexplusplus-upstream-probe\.mjs"/);
  assert.match(controlApi, /testCodexPlusPlusUpstreamConnection\(/);
  assert.match(controlApi, /fixedRouteHealthSnapshot\(/);
  assert.match(controlApi, /runtime:\s*\{\s*mode:\s*activeUpstreamMode\(fixedRoute\),\s*provider:\s*fixedRoute\.provider,\s*model:\s*fixedRoute\.model/);
  assert.match(controlApi, /saved,\s*fixedRoute,/);
  assert.doesNotMatch(controlApi, /OpenAI 兼容或 Anthropic|\/v1\/messages/);
  assert.match(managerUi, /current\.fixedRoute\?\.ready === true/);
});
