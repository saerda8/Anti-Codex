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
  assert.match(modelFinder, /const candidates = \[\]/);
  assert.match(modelFinder, /candidates\.length !== 1/);
  assert.match(modelFinder, /return candidates\[0\]/);
});

const settingsExternalLinksFixtures = [
  "var G=m({account:{id:`settings.nav.chatSettings`},securitySettings:{id:`settings.nav.securitySettings`}}),q={account:{href:`https://chatgpt.com/#settings`,icon:we,message:G.account},securitySettings:{href:`https://chatgpt.com/open-security-settings`,icon:W,message:G.securitySettings}},it={agent:L,personalization:r,\"plugins-settings\":v};",
  "var A=x({account:{id:`settings.nav.account`},securitySettings:{id:`settings.nav.securitySettings`}}),B={account:{href:`https://chatgpt.com/#settings`,icon:C,message:A.account},securitySettings:{href:`https://chatgpt.com/open-security-settings`,icon:D,message:A.securitySettings}},E={agent:F,\"mcp-settings\":G,\"plugins-settings\":H};",
];

test("hides only ChatGPT account and web security settings links across supported settings bundles", () => {
  for (const source of settingsExternalLinksFixtures) {
    const patched = brandPatchCompat.patchSettingsExternalNavigation(source);
    assert.equal(patched.length, source.length);
    assert.doesNotMatch(patched, /https:\/\/chatgpt\.com\/(?:#settings|open-security-settings)/);
    assert.match(patched, /anticodex-local-settings-only/);
    assert.match(patched, /agent:/);
    assert.match(patched, /"plugins-settings":/);
    assert.equal(brandPatchCompat.patchSettingsExternalNavigation(patched), patched);
  }
});

test("fails closed when ChatGPT settings navigation anchors are missing or repeated", () => {
  assert.throws(
    () => brandPatchCompat.patchSettingsExternalNavigation("var local={agent:1};"),
    /exactly one supported ChatGPT settings navigation/i,
  );
  assert.throws(
    () => brandPatchCompat.patchSettingsExternalNavigation(settingsExternalLinksFixtures[0].repeat(2)),
    /exactly one supported ChatGPT settings navigation/i,
  );
});

function appServerSpawnFixture({ command = "e", proc = "t", spawn = "(0,d.spawn)", resolver = "VF" } = {}) {
  return `class C{constructor(options){this.options=options;this.logger={info(){}}}spawnProcess(){let ${command}=this.options.spawnCommand??this.options.executablePath,${proc}=${spawn}(${resolver}.resolve(${command},{env:this.options.env})??${command},this.options.spawnArgs??this.options.args,{stdio:[\`pipe\`,\`pipe\`,\`pipe\`],env:this.options.env});if(!${proc}.pid)throw Error(\`Failed to spawn Codex CLI at \${this.options.executablePath}\`);this.logger.info(\`stdio_transport_spawned\`,{safe:{executablePath:this.options.executablePath,argsCount:this.options.args.length,spawnCommand:this.options.spawnCommand??this.options.executablePath,pid:${proc}.pid},sensitive:{}}),this.proc=${proc}}onProcessError=()=>{}}`;
}

test("injects managed approval and sandbox session flags into only the native app-server argv", () => {
  for (const source of [
    appServerSpawnFixture(),
    appServerSpawnFixture({ command: "n", proc: "r", spawn: "s.spawn", resolver: "T" }),
  ]) {
    const patched = brandPatchCompat.patchAppServerManagedSessionFlags(source);
    assert.equal(patched.length, source.length);
    assert.equal((patched.match(/approval_policy="never"/g) ?? []).length, 1);
    assert.equal((patched.match(/sandbox_mode="danger-full-access"/g) ?? []).length, 1);
    assert.match(patched, /spawnArgs\?\?/);
    assert.equal(brandPatchCompat.patchAppServerManagedSessionFlags(patched), patched);
  }

  const calls = [];
  const source = brandPatchCompat.patchAppServerManagedSessionFlags(appServerSpawnFixture());
  const SpawnClass = new Function("d", "VF", `${source};return C;`)(
    { spawn: (_command, args) => (calls.push(args), { pid: 1 }) },
    { resolve: (command) => command },
  );
  new SpawnClass({
    executablePath: "codex.exe",
    env: {},
    args: ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
  }).spawnProcess();
  new SpawnClass({
    executablePath: "codex.exe",
    env: {},
    args: ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
    spawnArgs: ["wsl.exe", "-lc", "codex app-server"],
  }).spawnProcess();

  assert.deepEqual(calls[0], [
    "-c", "features.code_mode_host=true",
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="danger-full-access"',
    "app-server", "--analytics-default-enabled",
  ]);
  assert.deepEqual(calls[1], ["wsl.exe", "-lc", "codex app-server"]);
  assert.throws(
    () => new SpawnClass({ executablePath: "codex.exe", env: {}, args: ["status"] }).spawnProcess(),
    /Missing app-server arg/,
  );
  const FailingSpawnClass = new Function("d", "VF", `${source};return C;`)(
    { spawn: () => ({ pid: 0 }) },
    { resolve: (command) => command },
  );
  assert.throws(
    () => new FailingSpawnClass({ executablePath: "codex.exe", env: {}, args: ["app-server"] }).spawnProcess(),
    /Codex CLI spawn failed/,
  );
});

test("fails closed when app-server spawn anchors are missing or repeated", () => {
  assert.throws(
    () => brandPatchCompat.patchAppServerManagedSessionFlags("class C{spawnProcess(){}}"),
    /exactly one supported native app-server spawn/i,
  );
  assert.throws(
    () => brandPatchCompat.patchAppServerManagedSessionFlags(appServerSpawnFixture().repeat(2)),
    /exactly one supported native app-server spawn/i,
  );
});

test("wires external-settings hiding and managed session flags as critical ASAR patches", () => {
  assert.match(brandPatcherSource, /\["settings-external-links",\s*\(\)\s*=>\s*findSettingsExternalLinksPatch/);
  assert.match(brandPatcherSource, /\["app-server-managed-session-flags",\s*\(\)\s*=>\s*findAppServerManagedSessionFlagsPatch/);
  const criticalBlock = brandPatcherSource.match(/const fixedShellCriticalPatchNames = new Set\(\[[\s\S]*?\]\);/)?.[0] ?? "";
  assert.match(criticalBlock, /"settings-external-links"/);
  assert.match(criticalBlock, /"app-server-managed-session-flags"/);
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

const configHandlerSource = '"get-configuration":async({key:e})=>({value:this.getConfigurationValue(e)}),"set-configuration":async({key:e,value:t})=>(this.setConfigurationValue(e,t),{success:!0}),"get-setting":async({key:e})=>({value:this.getSettingValue(e)}),"get-settings":async()=>({configuredValues:this.getConfiguredSettingValues(),values:this.getSettingValues()}),"set-setting":async({key:e,value:t})=>(this.setSettingValue(e,t),{success:!0}),"settings-read":async()=>({filePath:this.getSettingsStore().getStateFilePath(),settings:this.getToolVisibleSettings(),effectiveSettings:this.getToolVisibleEffectiveSettings(),definitions:n.qi}),"settings-write":async({settings:e})=>{let t=Object.entries(e).map(([e,t])=>{let r=n.Wi(e);if(r==null)throw Error(`Unknown setting: ${e}`);if(r.agentAccess!==`read-write`)throw Error(`Setting cannot be written by Codex: ${e}`);return{definition:r,value:n.Gi(r.key).parse(t)}});for(let{definition:e,value:n}of t)this.setSettingValue(e.key,n);return await this.getSettingsStore().flush(),{settings:this.getToolVisibleSettings(),effectiveSettings:this.getToolVisibleEffectiveSettings()}},"apply-patch":()=>{},';
const latestConfigHandlerSource = '"get-configuration":async({key:e})=>({value:this.getConfigurationValue(e)}),"set-configuration":async({key:e,value:t})=>(this.setConfigurationValue(e,t),{success:!0}),"get-setting":async({key:e})=>({value:this.getSettingValue(e)}),"get-settings":async()=>({configuredValues:this.getConfiguredSettingValues(),values:this.getSettingValues()}),"set-setting":async({key:e,value:t})=>(this.setSettingValue(e,t),{success:!0}),"settings-read":async()=>({filePath:this.getSettingsStore().getStateFilePath(),settings:this.getToolVisibleSettings(),effectiveSettings:this.getToolVisibleEffectiveSettings(),definitions:n.Ii}),"settings-write":async({settings:e})=>{let t=Object.entries(e).map(([e,t])=>{let r=n.Ni(e);if(r==null)throw Error(`Unknown setting: ${e}`);if(r.agentAccess!==`read-write`)throw Error(`Setting cannot be written by Codex: ${e}`);return{definition:r,value:n.Pi(r.key).parse(t)}});for(let{definition:e,value:n}of t)this.setSettingValue(e.key,n);return await this.getSettingsStore().flush(),{settings:this.getToolVisibleSettings(),effectiveSettings:this.getToolVisibleEffectiveSettings()}},"apply-patch":async({origin:e,...t})=>n.R(t,this.gitManager),';

test("adds the native batch config bridge to the current desktop handler table", () => {
  const source = configHandlerSource;

  assert.equal(typeof brandPatchCompat.patchConfigWriteHandler, "function");
  const patched = brandPatchCompat.patchConfigWriteHandler(source);

  assert.equal(patched.length, source.length);
  assert.match(patched, /"batch-write-config-value":e=>this\.getRequestAppServerClient\(e\.hostId\)\.sendAppServerRequest\(`config\/batchWrite`,e\)/);
  assert.match(patched, /"settings-write":async/);
  assert.equal(brandPatchCompat.patchConfigWriteHandler(patched), patched);
  const asarConfigDispatcher = brandPatcherSource.match(/function patchConfigWriteHandler\(text\)[\s\S]*?(?=function patchDefaultLocale)/)?.[0] ?? "";
  assert.match(asarConfigDispatcher, /currentConfigWriteMarker/);
  assert.match(asarConfigDispatcher, /patchCurrentConfigWriteHandler\(text\)/);
  const criticalBlock = brandPatcherSource.match(/const fixedShellCriticalPatchNames = new Set\(\[[\s\S]*?\]\);/)?.[0] ?? "";
  assert.match(criticalBlock, /"config-write"/);
});

test("preserves the 26.727 settings contract while adding the native batch config bridge", () => {
  const patched = brandPatchCompat.patchConfigWriteHandler(latestConfigHandlerSource);

  assert.equal(patched.length, latestConfigHandlerSource.length);
  assert.match(patched, /"batch-write-config-value":e=>this\.getRequestAppServerClient\(e\.hostId\)\.sendAppServerRequest\(`config\/batchWrite`,e\)/);
  assert.match(patched, /definitions:n\.Ii/);
  assert.match(patched, /n\.Ni\(e\)/);
  assert.match(patched, /n\.Pi\(r\.key\)\.parse\(t\)/);
  assert.equal(brandPatchCompat.patchConfigWriteHandler(patched), patched);
});

test("validates every settings write before applying any of them", async () => {
  const patched = brandPatchCompat.patchConfigWriteHandler(configHandlerSource);
  const applied = [];
  const definitions = {
    qi: {},
    Wi: (key) => key === "good" ? { key, agentAccess: "read-write" } : null,
    Gi: () => ({ parse: (value) => value }),
  };
  const context = {
    setSettingValue: (key, value) => applied.push([key, value]),
    getSettingsStore: () => ({ flush: async () => {} }),
    getToolVisibleSettings: () => ({}),
    getToolVisibleEffectiveSettings: () => ({}),
  };
  const handlers = new Function("n", `return function(){return ({${patched}})}`)(definitions).call(context);

  await assert.rejects(
    handlers["settings-write"]({ settings: { good: 1, unknown: 2 } }),
    /Unknown setting: unknown/,
  );
  assert.deepEqual(applied, []);
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

test("patches the extracted 26.727 local-model availability helper without changing its other rules", () => {
  const source = "function q$r({additionalAvailableModels:e,authMethod:t,availableModels:n,model:r,useHiddenModels:i}){return e?.has(r.model)===!0||(i&&t!==`amazonBedrock`?n.has(r.model):!r.hidden)}";
  assert.equal(typeof brandPatchCompat.patchLocalModelAvailability, "function");
  const patched = brandPatchCompat.patchLocalModelAvailability(source);

  assert.equal(patched.length, source.length);
  assert.equal(brandPatchCompat.hasPatchedLocalModelAvailability(patched), true);
  assert.equal(brandPatchCompat.patchLocalModelAvailability(patched), patched);
  const filter = new Function(`${patched};return q$r;`)();
  const hidden = { model: "hidden", hidden: true };
  const visible = { model: "visible", hidden: false };
  assert.equal(filter({ additionalAvailableModels: new Set(["hidden"]), authMethod: "chatgpt", availableModels: new Set(), model: hidden, useHiddenModels: true }), true);
  assert.equal(filter({ additionalAvailableModels: new Set(), authMethod: "chatgpt", availableModels: new Set(["hidden"]), model: hidden, useHiddenModels: true }), false);
  assert.equal(filter({ additionalAvailableModels: new Set(), authMethod: "chatgpt", availableModels: new Set(), model: visible, useHiddenModels: true }), true);
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

test("repaints the primary window on focus before restore without changing bundle size", () => {
  const method = "trackPrimaryWindow(e){this.primaryWindows.add(e),e.isFocused()?(this.lastActivePrimaryWindow=e,this.primaryWindowLastActiveAtMs.set(e,Date.now())):this.lastActivePrimaryWindow??=e,this.emitPrimaryWindowChangeIfNeeded(),e.on(`focus`,()=>{this.lastActivePrimaryWindow=e,this.primaryWindowLastActiveAtMs.set(e,Date.now()),this.emitPrimaryWindowChangeIfNeeded()}),e.on(`blur`,()=>{this.primaryWindowLastActiveAtMs.set(e,Date.now())})}";
  const source = `before:${method}:after`;

  assert.equal(brandPatchCompat.hasPrimaryWindowRestoreRepaint(source), false);
  const patched = brandPatchCompat.patchPrimaryWindowRestoreRepaint(source);
  const patchedMethod = patched.slice(patched.indexOf("trackPrimaryWindow"), patched.indexOf(":after"));

  assert.equal(patched.length, source.length);
  assert.equal(brandPatchCompat.hasPrimaryWindowRestoreRepaint(patched), true);
  assert.equal((patchedMethod.match(/on\(`restore`/g) || []).length, 1);
  assert.match(patchedMethod, /let t=.*?,n=\(\)=>\{try\{e\.webContents\.invalidate\(\)\}catch\{\}\};/);
  assert.match(patchedMethod, /on\(`focus`,\(\)=>\{[^}]*n\(\)\}\)/);
  assert.match(patchedMethod, /on\(`restore`,\(\)=>setImmediate\(n\)\)/);
  assert.equal((patchedMethod.match(/webContents\.invalidate/g) ?? []).length, 1);
  assert.doesNotMatch(patchedMethod, /on\(`(?:show|hide)`[^}]*invalidate/);
  assert.equal(brandPatchCompat.patchPrimaryWindowRestoreRepaint(patched), patched);
  assert.match(brandPatcherSource, /\["primary-window-restore-repaint",\s*\(\)\s*=>\s*findPrimaryWindowRestoreRepaintPatch/);
  assert.match(brandPatcherSource, /"primary-window-restore-repaint",[\s\S]*?const selectedPatchNames/);
  assert.throws(
    () => brandPatchCompat.patchPrimaryWindowRestoreRepaint("trackPrimaryWindow(e){broken}"),
    /exactly one supported primary-window tracker/i,
  );
  assert.throws(
    () => brandPatchCompat.patchPrimaryWindowRestoreRepaint(`${source}${source}`),
    /exactly one supported primary-window tracker/i,
  );
  for (const windowAlias of ["t", "n"]) {
    const aliasedMethod = `trackPrimaryWindow(${windowAlias}){this.primaryWindows.add(${windowAlias}),${windowAlias}.isFocused()?(this.lastActivePrimaryWindow=${windowAlias},this.primaryWindowLastActiveAtMs.set(${windowAlias},Date.now())):this.lastActivePrimaryWindow??=${windowAlias},this.emitPrimaryWindowChangeIfNeeded(),${windowAlias}.on(\`focus\`,()=>{this.lastActivePrimaryWindow=${windowAlias},this.primaryWindowLastActiveAtMs.set(${windowAlias},Date.now()),this.emitPrimaryWindowChangeIfNeeded()}),${windowAlias}.on(\`blur\`,()=>{this.primaryWindowLastActiveAtMs.set(${windowAlias},Date.now())})}`;
    const aliasedPatched = brandPatchCompat.patchPrimaryWindowRestoreRepaint(aliasedMethod);
    assert.equal(brandPatchCompat.hasPrimaryWindowRestoreRepaint(aliasedPatched), true);
    assert.doesNotMatch(aliasedPatched, new RegExp(`let ${windowAlias}=`));
  }
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
