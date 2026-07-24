import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as brandPatchCompat from "../../scripts/brand-patch-compat.mjs";

const { hasProductNameDrivenSessionTitle } = brandPatchCompat;
const brandPatcherSource = readFileSync(new URL("../../scripts/brand-patched-asar.mjs", import.meta.url), "utf8");

test("finds settings and model patches in Codex's consolidated app-initial bundle", () => {
  const profileFinder = brandPatcherSource.match(/function findProfileDropdownSettingsPatch[\s\S]*?(?=function findBrowserWindowIconPatch)/)?.[0] ?? "";
  const modelFinder = brandPatcherSource.match(/function findLocalModelAvailabilityPatch[\s\S]*?(?=function findLocalPluginCatalogPatch)/)?.[0] ?? "";

  assert.match(profileFinder, /webview\/assets\/app-initial-/);
  assert.match(modelFinder, /webview\/assets\/app-initial-/);
});

test("patches startup MCP config reload across minified variable renames", () => {
  const previous = "await e.sendAppServerRequest(`config/batchWrite`,{edits:vo(f),expectedVersion:null,filePath:null,reloadUserConfig:!0})";
  const current = "await e.sendAppServerRequest(`config/batchWrite`,{edits:go(f),expectedVersion:null,filePath:null,reloadUserConfig:!0})";
  const unrelated = "await e.sendAppServerRequest(`config/batchWrite`,{edits:[{keyPath:`plugins.x.enabled`}],reloadUserConfig:!0})";

  for (const source of [previous, current]) {
    assert.equal(brandPatchCompat.hasStartupMcpConfigReload(source), true);
    const patched = brandPatchCompat.patchStartupMcpConfigReload(source);
    assert.equal(patched.length, source.length);
    assert.match(patched, /reloadUserConfig:!1/);
    assert.equal(brandPatchCompat.patchStartupMcpConfigReload(patched), patched);
  }

  assert.equal(brandPatchCompat.hasStartupMcpConfigReload(unrelated), false);
  assert.throws(
    () => brandPatchCompat.patchStartupMcpConfigReload(unrelated),
    /pattern not found/,
  );
});

test("recognizes padded idempotent auth and local-model patches", () => {
  assert.equal(
    brandPatchCompat.hasPatchedAuthRequirement(
      "requiresAuth:!1                                       ,email:e.account?.type===`chatgpt`?e.account.email:null",
    ),
    true,
  );
  assert.equal(
    brandPatchCompat.hasPatchedLocalModelAvailability(
      "function r({authMethod:e,availableModels:n,defaultModel:r,enabledReasoningEfforts:i,includeUltraReasoningEffort:a,models:o,useHiddenModels:s}){let c=[],l=null,u=!1                    ,d=o.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`))}",
    ),
    true,
  );
  assert.equal(
    brandPatchCompat.hasPatchedLocalModelAvailability(
      "function MJr({additionalAvailableModels:e,authMethod:t,availableModels:n,defaultModel:r,enabledReasoningEfforts:i,includeUltraReasoningEffort:a,models:o,useHiddenModels:s}){let c=[],l=null,u=!1                    ,d=o.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`))}",
    ),
    true,
  );
  assert.equal(
    brandPatchCompat.hasPatchedAuthRequirement("requiresAuth:!0,email:null"),
    false,
  );
  assert.equal(
    brandPatchCompat.hasPatchedLocalModelAvailability("let c=[],l=null,u=e&&e!==`amazonBedrock`,d=1"),
    false,
  );
  assert.equal(
    brandPatchCompat.hasPatchedLocalModelAvailability(
      "function DGc({agentItems:e}){let r=[],i=null,a=!1,o=!1}",
    ),
    false,
  );
  assert.equal(
    brandPatchCompat.hasPatchedLocalModelAvailability(
      "function $cl(e){let t=[],n=null,r=!1,i=e=>t.push(e)}",
    ),
    false,
  );
});

test("patches Codex 26.609 system window titles without changing bundle size", () => {
  const source = [
    "let M=new r.BrowserWindow({width:b,height:x,",
    "title:i??r.app.getName(),backgroundColor:A});",
    "let re=async({show:e})=>{",
    "let n=await N.createPrimaryWindow({title:r.app.getName(),show:e});",
    "return n};",
  ].join("");

  assert.equal(hasProductNameDrivenSessionTitle(source), true);
  assert.equal(
    typeof brandPatchCompat.patchProductNameDrivenSessionTitle,
    "function",
  );
  const { patchProductNameDrivenSessionTitle } = brandPatchCompat;
  const patched = patchProductNameDrivenSessionTitle(source);

  assert.equal(patched.length, source.length);
  assert.doesNotMatch(patched, /title:i\?\?r\.app\.getName\(\)/);
  assert.doesNotMatch(patched, /title:r\.app\.getName\(\)/);
  assert.match(patched, /title:i\?\?`Anti-Codex`\s*,backgroundColor/);
  assert.match(
    patched,
    /createPrimaryWindow\(\{title:`Anti-Codex`\s*,show:e\}\)/,
  );
  assert.equal(hasProductNameDrivenSessionTitle(patched), true);
});

test("does not accept a generic app.getName reference as session-title proof", () => {
  assert.equal(
    hasProductNameDrivenSessionTitle("dialog.showMessageBox({title:r.app.getName()})"),
    false,
  );
});

test("keeps Codex's official primary BrowserWindow throttling policy", () => {
  assert.doesNotMatch(brandPatcherSource, /patchPrimaryWindowBackgroundThrottling/);
});

test("routes every Windows tray brand to the Anti-Codex tray resource", () => {
  const source = [
    "function x_(e,t){",
    "if(e===i.a.Agent&&t===n.Vc.ChatGPT)",
    "return{dark:`icon-agent.ico`,light:`icon-agent.ico`};",
    "switch(t){",
    "case n.Vc.Codex:return{dark:`codex-tray.ico`,light:`codex-tray.ico`};",
    "case n.Vc.ChatGPT:return{dark:`chatgpt-tray-dark.ico`,light:`chatgpt-tray-light.ico`}",
    "}}",
  ].join("");

  assert.equal(
    typeof brandPatchCompat.patchWindowsTrayIconSelection,
    "function",
  );
  const patched = brandPatchCompat.patchWindowsTrayIconSelection(source);

  assert.equal(patched.length, source.length);
  assert.doesNotMatch(patched, /icon-agent\.ico|chatgpt-tray-(?:dark|light)\.ico/);
  assert.equal((patched.match(/codex-tray\.ico/g) || []).length, 6);
  assert.equal(
    brandPatchCompat.patchWindowsTrayIconSelection(patched),
    patched,
  );
});

test("preserves an empty notify array as an Anti-Codex legacy-notify opt-out", () => {
  const source = "function Hn(e,t){let n=Wn(e),r=Gn(n),i=[t,zn];return r!=null&&i.push(Rn,JSON.stringify(r)),Xn(n,i)?{content:e,hadNotify:!0}:{content:Jn(e,L({notify:i}).trimEnd()),hadNotify:n!=null}}";

  assert.equal(
    typeof brandPatchCompat.patchComputerUseLegacyNotifyOptOut,
    "function",
  );
  const patched = brandPatchCompat.patchComputerUseLegacyNotifyOptOut(source);
  assert.equal(patched.length, source.length);
  assert.match(patched, /n\?\.length<1\|\|Xn\(n,i\)/);
  assert.doesNotMatch(patched, /r!=null/);

  let notify = [];
  const createEnsureNotify = new Function(
    "Wn", "Gn", "zn", "Rn", "Xn", "Jn", "L",
    `${patched}; return Hn;`,
  );
  const ensureNotify = createEnsureNotify(
    () => notify,
    (value) => value,
    "turn-ended",
    "--previous-notify",
    (left, right) => JSON.stringify(left) === JSON.stringify(right),
    (_content, nextLine) => `rewritten:${nextLine}`,
    ({ notify: nextNotify }) => `notify=${JSON.stringify(nextNotify)}`,
  );

  assert.deepStrictEqual(ensureNotify("notify = []\n", "helper.exe"), {
    content: "notify = []\n",
    hadNotify: true,
  });
  notify = null;
  assert.deepStrictEqual(ensureNotify("", "helper.exe"), {
    content: 'rewritten:notify=["helper.exe","turn-ended"]',
    hadNotify: false,
  });
  assert.equal(brandPatchCompat.patchComputerUseLegacyNotifyOptOut(patched), patched);
});
