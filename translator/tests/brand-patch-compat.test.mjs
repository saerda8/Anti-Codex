import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import * as brandPatchCompat from "../../scripts/brand-patch-compat.mjs";

const { hasProductNameDrivenSessionTitle } = brandPatchCompat;
const brandPatcherSource = readFileSync(new URL("../../scripts/brand-patched-asar.mjs", import.meta.url), "utf8");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("brands Codex and ChatGPT webview titles without changing HTML size", () => {
  for (const title of ["Codex", "ChatGPT"]) {
    const source = `<!doctype html>\n  <head>\n    <title>${title}</title>\n  </head>\n`;
    const patched = brandPatchCompat.patchWebviewHtmlTitle(source);

    assert.equal(patched.length, source.length);
    assert.match(patched, /<title>Anti-Codex<\/title>/);
    assert.equal(brandPatchCompat.patchWebviewHtmlTitle(patched), patched);
  }
});

test("discovers webview titles through the shared compatibility patch", () => {
  const finder = brandPatcherSource.match(
    /function findWebviewHtmlTitlePatch[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(finder, /patchWebviewHtmlTitle\(text\)/);
});

const crashRecoveryBundle = [
  'function U(e){if(e===`idle`)return A.appUpdates?.checkForUpdates(),j(Z,{id:`appUpdate.recovery.updateCodex`,defaultMessage:`Update {appName}`,description:`Button label shown on the full-screen error page to install a desktop app update`,values:{appName:P}});if(e===`ready`)return A.appUpdates?.installUpdate()}',
  'function C(e){let {fatalError:n,onReset:R}=e;let c;c=j(`h1`,{children:j(Z,{id:`appServerCrash.title`,defaultMessage:`{appName} stopped unexpectedly`,description:`Title shown when the Codex app-server process crashes`,values:{appName:P}})});let l;l=jsxs(`div`,{children:[c,j(`p`,{children:j(Z,{id:`appServerCrash.description`,defaultMessage:`Restart {appName} to continue. If the problem persists, check your configuration or visit the {documentationLink}`,description:`Recovery guidance shown when the Codex app-server process crashes`,values:{appName:P,documentationLink:j(`button`,{onClick:D,children:`documentation`})}})})]});let u;u=(0,j.jsx)(j.Fragment,{children:(0,j.jsx)(U,{})});let d;d=j(B,{onClick:O,children:j(Z,{id:`loadingPage.openConfigToml`,defaultMessage:`Open Config.toml`,description:`Button label to open the Config.toml file`})});let f;f=j(Z,{id:`appServerCrash.restart`,defaultMessage:`Restart`,description:`Button label that restarts the Codex app-server after a crash`});let p;p=j(B,{onClick:R,children:f});let m;m=jsxs(`div`,{children:[u,d,p]});return jsxs(`main`,{children:[s,l,m,h]})}',
  'function O(){return A.dispatchMessage(`open-config-toml`,{})}',
  'function G(e){let {resetError:n}=e,r=M();let a;a=(0,j.jsx)(Z,{id:`codex.errorBoundary.genericError`,defaultMessage:`Oops, an error has occurred`,description:`Generic error message shown when the extension webview fails`});let q;q=(0,j.jsx)(j.Fragment,{children:(0,j.jsx)(U,{})});let s;s=()=>{n(),r(`/`)};let c;c=(0,j.jsx)(Z,{id:`codex.errorBoundary.goHome`,defaultMessage:`Try again`,description:`Button label to navigate to the home page after an error`});let l;return l=(0,j.jsxs)(`div`,{children:[a,(0,j.jsxs)(`div`,{children:[q,(0,j.jsx)(B,{onClick:s,children:c})]})]}),l}var R,z,J;',
].join("");

const latestCrashRecoveryBundle = [
  'function U(e){let{appUpdateLifecycleState:c}=e;switch(c){case`idle`:case`ready`:{let h;h=()=>{c===`idle`&&o!==`macOS`?A.appUpdates?.checkForUpdates():A.appUpdates?.installUpdate()};return j(Z,{id:`appUpdate.recovery.updateChatGPT`,defaultMessage:`Update ChatGPT`,onClick:h})}}}',
  'function C(e){let t=c(28),{fatalError:n,onReset:r}=e;let l;l=j(Z,{id:`appServerCrash.recoveryTitle`,defaultMessage:`ChatGPT hit a snag`,description:`Title on the full-screen app recovery page after an unexpected error`});let u;u=n.bad?j(Z,{id:`appServerCrash.configurationRecoveryDescription`,defaultMessage:`ChatGPT couldn\'t load your configuration. Review it, then restart to try again.`,description:`Recovery guidance when invalid configuration prevents the app from starting`}):j(Z,{id:`appServerCrash.recoveryDescription`,defaultMessage:`Something went wrong. Restart ChatGPT to try again.`,description:`Recovery guidance after an unexpected app error`});let p;p=j(Z,{id:`appServerCrash.restartChatGPT`,defaultMessage:`Restart ChatGPT`,description:`Button that restarts the app-server after an error`});let m;m=j(B,{onClick:r,children:p});let h;h=j(B,{onClick:F,children:`feedback`});let g;g=j(B,{onClick:L,children:`config`});let _;t[18]===S?(_=(0,j.jsx)(j.Fragment,{children:(0,j.jsx)(U,{hideUnavailable:!0})}),t[18]=_):_=t[18];let v;v=jsxs(`div`,{children:[m,h,g,_]});return jsxs(`main`,{children:[l,u,v]})}',
  'function L(){return A.dispatchMessage(`open-config-toml`,{})}',
  'function G(e){let {resetError:n}=e,r=M();let a;a=(0,j.jsx)(Z,{id:`codex.errorBoundary.genericError`,defaultMessage:`Oops, an error has occurred`,description:`Generic error message shown when the extension webview fails`});let q;q=(0,j.jsx)(j.Fragment,{children:(0,j.jsx)(U,{})});let s;s=()=>{n(),r(`/`)};let c;c=(0,j.jsx)(Z,{id:`codex.errorBoundary.goHome`,defaultMessage:`Try again`,description:`Button label to navigate to the home page after an error`});let l;return l=(0,j.jsxs)(`div`,{children:[a,(0,j.jsxs)(`div`,{children:[q,(0,j.jsx)(B,{onClick:s,children:c})]})]}),l}var R,z,J;',
].join("");

test("brands and narrows the crash recovery page atomically without changing bundle length", () => {
  const patched = brandPatchCompat.patchCrashRecoveryPage(crashRecoveryBundle);

  assert.equal(patched.length, crashRecoveryBundle.length);
  assert.equal([...patched.matchAll(/values:\{appName:`Anti-Codex`/g)].length, 2);
  assert.match(patched, /\/\*anticodex-crash-recovery-actions\*\/children:\[d,p\]/);
  assert.doesNotMatch(patched, /children:\[u,d,p\]/);
  assert.match(patched, /\/\*anticodex-generic-error-actions\*\/children:\[\(0,j\.jsx\)\(B,\{onClick:s,children:c\}\)\]/);
  assert.doesNotMatch(patched, /children:\[q,\(0,j\.jsx\)\(B,\{onClick:s,children:c\}\)\]/);
  assert.match(patched, /appUpdate\.recovery\.updateCodex/);
  assert.match(patched, /appUpdates\?\.checkForUpdates\(\)/);
  assert.match(patched, /appUpdates\?\.installUpdate\(\)/);
  assert.match(patched, /documentationLink:j\(`/);
  assert.match(patched, /dispatchMessage\(`open-config-toml`,\{\}\)/);
  assert.match(patched, /id:`appServerCrash\.restart`/);
  assert.equal(brandPatchCompat.patchCrashRecoveryPage(patched), patched);
});

test("fails closed on missing, repeated, or partially patched crash recovery anchors", () => {
  assert.throws(
    () => brandPatchCompat.patchCrashRecoveryPage(crashRecoveryBundle.replace(/function O\(\)[\s\S]+$/, "")),
    /exactly one supported Anti-Codex crash recovery page/i,
  );
  assert.throws(
    () => brandPatchCompat.patchCrashRecoveryPage(crashRecoveryBundle.repeat(2)),
    /exactly one supported Anti-Codex crash recovery page/i,
  );
  const patched = brandPatchCompat.patchCrashRecoveryPage(crashRecoveryBundle);
  assert.throws(
    () => brandPatchCompat.patchCrashRecoveryPage(patched.replace("values:{appName:`Anti-Codex`}", "values:{appName:P}             ")),
    /partially patched Anti-Codex crash recovery page/i,
  );
  assert.throws(
    () => brandPatchCompat.patchCrashRecoveryPage(patched.replace("children:[d,p]", "children:[u,p]")),
    /action row|partially patched/i,
  );
  assert.throws(
    () => brandPatchCompat.patchCrashRecoveryPage(patched.replace("onClick:s,children:c", "onClick:U,children:c")),
    /retry|partially patched/i,
  );
  assert.throws(
    () => brandPatchCompat.patchCrashRecoveryPage(patched.replace("onClick:R,children:f", "onClick:U,children:f")),
    /restart|partially patched/i,
  );
  assert.throws(
    () => brandPatchCompat.patchCrashRecoveryPage(patched.replace(
      "/*anticodex-crash-recovery-actions*/children:[d,p]",
      "d=j(B,{onClick:U,children:j(Z,{id:`loadingPage.openConfigToml`,defaultMessage:`Open Config.toml`})});/*anticodex-crash-recovery-actions*/children:[d,p]",
    )),
    /config|assignment|partially patched/i,
  );
  assert.throws(
    () => brandPatchCompat.patchCrashRecoveryPage(patched.replace(
      "/*anticodex-crash-recovery-actions*/children:[d,p]",
      "p=j(B,{onClick:U,children:f});/*anticodex-crash-recovery-actions*/children:[d,p]",
    )),
    /restart|assignment|partially patched/i,
  );
  assert.throws(
    () => brandPatchCompat.patchCrashRecoveryPage(patched.replace(
      "/*anticodex-generic-error-actions*/children:[(0,j.jsx)(B,{onClick:s,children:c})]",
      "s=U;/*anticodex-generic-error-actions*/children:[(0,j.jsx)(B,{onClick:s,children:c})]",
    )),
    /retry|assignment|partially patched/i,
  );
  for (const [variable, marker] of [
    ["d", "/*anticodex-crash-recovery-actions*/children:[d,p]"],
    ["p", "/*anticodex-crash-recovery-actions*/children:[d,p]"],
    ["s", "/*anticodex-generic-error-actions*/children:[(0,j.jsx)(B,{onClick:s,children:c})]"],
  ]) {
    assert.throws(
      () => brandPatchCompat.patchCrashRecoveryPage(patched.replace(marker, `${variable}=t[99];t[99]=${variable};${marker}`)),
      /cache|assignment|reassigned|partially patched/i,
    );
    assert.throws(
      () => brandPatchCompat.patchCrashRecoveryPage(patched.replace(marker, `${variable}&&=U;${marker}`)),
      /assignment|reassigned|partially patched/i,
    );
    assert.throws(
      () => brandPatchCompat.patchCrashRecoveryPage(patched.replace(marker, `[${variable}]=[U];${marker}`)),
      /reference|assignment|reassigned|partially patched/i,
    );
    assert.throws(
      () => brandPatchCompat.patchCrashRecoveryPage(patched.replace(marker, `for(${variable} of q){}${marker}`)),
      /reference|assignment|reassigned|partially patched/i,
    );
  }
  for (const nestedThunk of [
    patched.replace(/let d;d=(?<control>[\s\S]*?);(?=let f;)/, "let d;x?d=t[99]:(()=>{d=$<control>;t[99]=d});"),
    patched.replace(/let p;p=(?<control>[\s\S]*?);(?=let m;)/, "let p;x?p=t[99]:(()=>{p=$<control>;t[99]=p});"),
    patched.replace(/let s;s=(?<handler>[\s\S]*?);(?=let c;)/, "let s;x?s=t[99]:(()=>{s=$<handler>;t[99]=s});"),
  ]) {
    assert.throws(
      () => brandPatchCompat.patchCrashRecoveryPage(nestedThunk),
      /cache|assignment|retry|restart|config|partially patched/i,
    );
  }
});

test("wires the crash recovery page as one fixed-shell critical patch", () => {
  assert.match(brandPatcherSource, /\["crash-recovery-page",\s*\(\)\s*=>\s*findCrashRecoveryPagePatch/);
  const criticalBlock = brandPatcherSource.match(/const fixedShellCriticalPatchNames = new Set\(\[[\s\S]*?\]\);/)?.[0] ?? "";
  assert.equal((criticalBlock.match(/"crash-recovery-page"/g) ?? []).length, 1);
  assert.match(brandPatcherSource, /const hostPatchRevision = 7;/);
});

test("selects exactly one signed crash bundle and never hides a partial second bundle", () => {
  const unrelated = "function ordinary(){return true}";
  assert.equal(brandPatchCompat.hasCrashRecoveryPageSignature(crashRecoveryBundle), true);
  assert.equal(brandPatchCompat.hasCrashRecoveryPageSignature(unrelated), false);
  assert.deepEqual(
    brandPatchCompat.selectCrashRecoveryBundleCandidate([
      { rel: "webview/assets/ordinary.js", text: unrelated },
      { rel: "webview/assets/app.js", text: crashRecoveryBundle },
    ]),
    { rel: "webview/assets/app.js", text: crashRecoveryBundle },
  );
  const partial = crashRecoveryBundle.replace("children:[u,d,p]", "children:[u,p]");
  assert.throws(
    () => brandPatchCompat.selectCrashRecoveryBundleCandidate([
      { rel: "webview/assets/app.js", text: crashRecoveryBundle },
      { rel: "webview/assets/partial.js", text: partial },
    ]),
    /exactly one.*signature/i,
  );
  const finder = brandPatcherSource.match(/function findCrashRecoveryPagePatch[\s\S]*?(?=function findLocalModelAvailabilityPatch)/)?.[0] ?? "";
  assert.match(finder, /hasCrashRecoveryPageSignature\(text\)/);
  assert.match(finder, /if\s*\(hasCrashRecoveryPageSignature\(text\)\)\s*\{\s*bundles\.push/);
});

test("rebuilds every ASAR integrity block after patching a large renderer bundle", () => {
  const payload = Buffer.from("abcdefghij");
  assert.deepEqual(brandPatchCompat.buildAsarIntegrity(payload, 4), {
    hash: sha256(payload),
    blocks: ["abcd", "efgh", "ij"].map((value) => sha256(value)),
  });
  assert.deepEqual(brandPatchCompat.buildAsarIntegrity(Buffer.alloc(0), 4), {
    hash: sha256(Buffer.alloc(0)),
    blocks: [sha256(Buffer.alloc(0))],
  });
  assert.throws(() => brandPatchCompat.buildAsarIntegrity(payload, 0), /block size/i);
  assert.match(brandPatcherSource, /buildAsarIntegrity\(afterBuf,\s*entry\.integrity\.blockSize\)/);
  assert.doesNotMatch(brandPatcherSource, /entry\.integrity\.blocks\s*=\s*\[hash\]/);
});

test("finds settings and model patches in Codex's consolidated app-initial bundle", () => {
  const profileFinder = brandPatcherSource.match(/function findProfileDropdownSettingsPatch[\s\S]*?(?=function findBrowserWindowIconPatch)/)?.[0] ?? "";
  const modelFinder = brandPatcherSource.match(/function findLocalModelAvailabilityPatch[\s\S]*?(?=function findLocalPluginCatalogPatch)/)?.[0] ?? "";

  assert.match(profileFinder, /webview\/assets\/app-initial-/);
  assert.match(modelFinder, /webview\/assets\/app-initial-/);
  assert.match(modelFinder, /const candidates = \[\]/);
  assert.match(modelFinder, /candidates\.length !== 1/);
  assert.match(modelFinder, /return candidates\[0\]/);
});

test("fixed shell leaves native locale detection and language-source selection untouched", () => {
  const selectedBlock = brandPatcherSource.match(/const fixedShellCriticalPatchNames = new Set\(\[[\s\S]*?\]\);/)?.[0] ?? "";

  assert.ok(selectedBlock, "fixed-shell patch selection is explicit");
  assert.doesNotMatch(selectedBlock, /"(?:locale-info|default-locale|enable-i18n|i18n-loading-gate)"/);
  assert.match(brandPatcherSource, /const selectedPatchNames = fixedShellCriticalPatchNames;/);
  assert.match(brandPatcherSource, /const selectedPatchSpecs = patchSpecs\.filter\(\(\[name\]\) => selectedPatchNames\.has\(name\)\);/);
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
    assert.match(patched, /account:\{href:`about:blank`,icon:[\w$]+,message:[\w$]+\.account\}/);
    assert.match(patched, /securitySettings:\{href:`about:blank`,icon:[\w$]+,message:[\w$]+\.securitySettings\}/);
    assert.match(patched, /agent:/);
    assert.match(patched, /"plugins-settings":/);
    assert.equal(brandPatchCompat.patchSettingsExternalNavigation(patched), patched);
  }
});

const settingsExternalRenderFixture = "e.key===(ee?`personal`:`settings`)?(0,Q.jsx)(sn,{canCollapse:h,externalTooltip:he,hideLabels:S}):null;let ye;ye=!w&&m?(0,Q.jsx)(ln,{canCollapse:h,externalTooltip:he,hideLabels:S}):null;function Yt(e){let n=oe(ut);return (0,Q.jsx)(Zt,{...e,securitySettingsEnabled:n})}";

test("hides external account and security controls without deleting their shared definitions", () => {
  const patched = brandPatchCompat.patchSettingsExternalNavigationRender(settingsExternalRenderFixture);
  assert.equal(patched.length, settingsExternalRenderFixture.length);
  assert.match(patched, /anticodex-hide-external-account/);
  assert.match(patched, /securitySettingsEnabled:0/);
  assert.match(patched, /ye=!w&&m\?\(0,Q\.jsx\)\(ln,/);
  assert.equal(brandPatchCompat.patchSettingsExternalNavigationRender(patched), patched);
});

test("keeps a padded multi-character security flag idempotent", () => {
  const source = settingsExternalRenderFixture.replace(
    "securitySettingsEnabled:n",
    "securitySettingsEnabled:enabledFlag",
  );
  const patched = brandPatchCompat.patchSettingsExternalNavigationRender(source);
  assert.equal(patched.length, source.length);
  assert.match(patched, /securitySettingsEnabled:0\s+\}/);
  assert.equal(brandPatchCompat.patchSettingsExternalNavigationRender(patched), patched);
});

test("fails closed when the semantic security settings flag is missing or repeated", () => {
  assert.throws(
    () => brandPatchCompat.patchSettingsExternalNavigationRender(settingsExternalRenderFixture.replace(/function Yt[\s\S]+$/, "")),
    /exactly one supported ChatGPT settings navigation render/i,
  );
  assert.throws(
    () => brandPatchCompat.patchSettingsExternalNavigationRender(`${settingsExternalRenderFixture}function Yt2(e){return (0,Q.jsx)(Zt,{...e,securitySettingsEnabled:m})}`),
    /exactly one supported ChatGPT settings navigation render/i,
  );
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

function appServerResolvedSpawnFixture({
  command = "e",
  resolved = "t",
  proc = "n",
  spawn = "(0,d.spawn)",
  resolver = "GI",
  coreRoot = "r",
  coreResolver = "BP",
  pathModule = "i",
} = {}) {
  return `class C{constructor(options){this.options=options;this.logger={info(){}}}spawnProcess(){let ${command}=this.options.spawnCommand??this.options.executablePath,${resolved}=${resolver}.resolve(${command},{env:this.options.env})??${command},${proc}=${spawn}(${resolved},this.options.spawnArgs??this.options.args,{stdio:[\`pipe\`,\`pipe\`,\`pipe\`],env:this.options.env});if(!${proc}.pid)throw Error(\`Failed to spawn Codex CLI at \${this.options.executablePath}\`);let ${coreRoot}=${coreResolver}();this.logger.info(\`stdio_transport_spawned\`,{safe:{executablePath:this.options.executablePath,argsCount:this.options.args.length,coreRuntimeInUse:process.platform===\`win32\`&&${coreRoot}!=null&&${resolved}===(0,${pathModule}.join)(${coreRoot},\`codex.exe\`),spawnCommand:this.options.spawnCommand??this.options.executablePath,pid:${proc}.pid},sensitive:{}}),this.proc=${proc}}onProcessError=()=>{}}`;
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

test("brands and narrows the 26.825 crash recovery page without changing bundle length", () => {
  const patched = brandPatchCompat.patchCrashRecoveryPage(latestCrashRecoveryBundle);

  assert.equal(patched.length, latestCrashRecoveryBundle.length);
  assert.match(patched, /defaultMessage:`Anti-Codex hit a snag`/);
  assert.match(patched, /defaultMessage:`Anti-Codex couldn't load your configuration\./);
  assert.match(patched, /defaultMessage:`Something went wrong\. Restart Anti-Codex to try again\.`/);
  assert.match(patched, /defaultMessage:`Restart Anti-Codex`/);
  assert.match(patched, /\/\*anticodex-crash-recovery-actions-v2\*\/children:\[m,h,g\]/);
  assert.doesNotMatch(patched, /children:\[m,h,g,_\]/);
  assert.match(patched, /\/\*anticodex-generic-error-actions\*\/children:/);
  assert.match(patched, /dispatchMessage\(`open-config-toml`,\{\}\)/);
  assert.equal(brandPatchCompat.patchCrashRecoveryPage(patched), patched);
});

test("injects managed session flags when command resolution is hoisted", () => {
  const source = appServerResolvedSpawnFixture();
  const patched = brandPatchCompat.patchAppServerManagedSessionFlags(source);

  assert.equal(patched.length, source.length);
  assert.equal((patched.match(/approval_policy="never"/g) ?? []).length, 1);
  assert.equal((patched.match(/sandbox_mode="danger-full-access"/g) ?? []).length, 1);
  assert.match(patched, /coreRuntimeInUse/);
  assert.equal(brandPatchCompat.patchAppServerManagedSessionFlags(patched), patched);

  const calls = [];
  const SpawnClass = new Function("d", "GI", "BP", "i", `${patched};return C;`)(
    { spawn: (command, args) => (calls.push({ command, args }), { pid: 1 }) },
    { resolve: (command) => command },
    () => "runtime",
    { join: (root, file) => `${root}/${file}` },
  );
  new SpawnClass({
    executablePath: "codex.exe",
    env: {},
    args: ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
  }).spawnProcess();

  assert.deepEqual(calls[0].args, [
    "-c", "features.code_mode_host=true",
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="danger-full-access"',
    "app-server", "--analytics-default-enabled",
  ]);
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

test("patches the 26.825 startup MCP reload default used by the batch-write call", () => {
  const source = "async function os({appServerConnection:e,reloadUserConfig:c=!0,resourcesPath:p}){return await e.sendAppServerRequest(`config/batchWrite`,{edits:w,expectedVersion:null,filePath:null,reloadUserConfig:c})}";
  const unrelated = "async function os({reloadUserConfig:c=!0}){return doSomethingElse(c)}";

  assert.equal(brandPatchCompat.hasStartupMcpConfigReload(source), true);
  const patched = brandPatchCompat.patchStartupMcpConfigReload(source);
  assert.equal(patched.length, source.length);
  assert.match(patched, /reloadUserConfig:c=!1/);
  assert.equal(brandPatchCompat.patchStartupMcpConfigReload(patched), patched);
  assert.equal(brandPatchCompat.hasStartupMcpConfigReload(unrelated), false);
});

test("patches the extracted 26.810 local-model availability helper without changing its new guards", () => {
  const source = "function vti({additionalAvailableModels:e,authMethod:t,availableModels:n,isCustomModelProvider:r,model:i,useHiddenModels:a}){return e?.has(i.model)===!0||i.model!==`codex-auto-review`&&(a&&!r&&t!==`amazonBedrock`?n.has(i.model):!i.hidden)}";
  const patched = brandPatchCompat.patchLocalModelAvailability(source);

  assert.equal(patched.length, source.length);
  assert.equal(brandPatchCompat.hasPatchedLocalModelAvailability(patched), true);
  assert.equal(brandPatchCompat.patchLocalModelAvailability(patched), patched);
  const filter = new Function(`${patched};return vti;`)();
  const hidden = { model: "hidden", hidden: true };
  const visible = { model: "visible", hidden: false };
  const review = { model: "codex-auto-review", hidden: false };
  assert.equal(filter({ additionalAvailableModels: new Set(["hidden"]), authMethod: "chatgpt", availableModels: new Set(), isCustomModelProvider: false, model: hidden, useHiddenModels: true }), true);
  assert.equal(filter({ additionalAvailableModels: new Set(), authMethod: "chatgpt", availableModels: new Set(["hidden"]), isCustomModelProvider: false, model: hidden, useHiddenModels: true }), false);
  assert.equal(filter({ additionalAvailableModels: new Set(), authMethod: "chatgpt", availableModels: new Set(["visible"]), isCustomModelProvider: false, model: visible, useHiddenModels: true }), true);
  assert.equal(filter({ additionalAvailableModels: new Set(), authMethod: "chatgpt", availableModels: new Set(["codex-auto-review"]), isCustomModelProvider: false, model: review, useHiddenModels: true }), false);
});

test("patches the 26.825 local-model helper while preserving configured-catalog and review guards", () => {
  const source = "function $ii({additionalAvailableModels:e,authMethod:t,availableModels:n,hasConfiguredModelCatalog:r,isCustomModelProvider:i,model:a,useHiddenModels:o}){return e?.has(a.model)===!0||a.model!==`codex-auto-review`&&(r&&!a.hidden||(o&&!i&&t!==`amazonBedrock`?n.has(a.model):!a.hidden))}";
  const patched = brandPatchCompat.patchLocalModelAvailability(source);

  assert.equal(patched.length, source.length);
  assert.equal(brandPatchCompat.hasPatchedLocalModelAvailability(patched), true);
  assert.equal(brandPatchCompat.patchLocalModelAvailability(patched), patched);
  const filter = new Function(`${patched};return $ii;`)();
  const hidden = { model: "hidden", hidden: true };
  const visible = { model: "visible", hidden: false };
  const review = { model: "codex-auto-review", hidden: false };
  assert.equal(filter({ additionalAvailableModels: new Set(["hidden"]), authMethod: "chatgpt", availableModels: new Set(), hasConfiguredModelCatalog: false, isCustomModelProvider: false, model: hidden, useHiddenModels: true }), true);
  assert.equal(filter({ additionalAvailableModels: new Set(), authMethod: "chatgpt", availableModels: new Set(["hidden"]), hasConfiguredModelCatalog: false, isCustomModelProvider: false, model: hidden, useHiddenModels: true }), false);
  assert.equal(filter({ additionalAvailableModels: new Set(), authMethod: "chatgpt", availableModels: new Set(), hasConfiguredModelCatalog: true, isCustomModelProvider: false, model: visible, useHiddenModels: true }), true);
  assert.equal(filter({ additionalAvailableModels: new Set(), authMethod: "chatgpt", availableModels: new Set(), hasConfiguredModelCatalog: true, isCustomModelProvider: false, model: review, useHiddenModels: true }), false);
});

test("patches the 26.825 Electron product-name mapper when the bootstrap call no longer has room", () => {
  const source = "function vT(e){switch(e){case ry.Dev:return`Dev`;case ry.Prod:return null}}function yT(e){let t=vT(e);return t==null?`ChatGPT`:`ChatGPT (${t})`}";
  assert.equal(typeof brandPatchCompat.patchElectronProductName, "function");
  const patched = brandPatchCompat.patchElectronProductName(source);

  assert.equal(patched.length, source.length);
  assert.match(patched, /return t\?`Anti-Codex \(\$\{t\}\)`:`Anti-Codex`/);
  assert.equal(brandPatchCompat.patchElectronProductName(patched), patched);
  assert.match(brandPatcherSource, /patchElectronProductName/);
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

test("revision 7 leaves the official primary-window tracker unpatched", () => {
  const method = "trackPrimaryWindow(e){this.primaryWindows.add(e),e.isFocused()?(this.lastActivePrimaryWindow=e,this.primaryWindowLastActiveAtMs.set(e,Date.now())):this.lastActivePrimaryWindow??=e,this.emitPrimaryWindowChangeIfNeeded(),e.on(`focus`,()=>{this.lastActivePrimaryWindow=e,this.primaryWindowLastActiveAtMs.set(e,Date.now()),this.emitPrimaryWindowChangeIfNeeded()}),e.on(`blur`,()=>{this.primaryWindowLastActiveAtMs.set(e,Date.now())})}";
  const source = `before:${method}:after`;

  const patchSpecs = brandPatcherSource.match(/const patchSpecs = \[[\s\S]*?\n\];/)?.[0] ?? "";
  const criticalBlock = brandPatcherSource.match(/const fixedShellCriticalPatchNames = new Set\(\[[\s\S]*?\]\);/)?.[0] ?? "";
  assert.doesNotMatch(patchSpecs, /primary-window-restore-repaint/);
  assert.doesNotMatch(criticalBlock, /primary-window-restore-repaint/);
  assert.equal(brandPatchCompat.hasPrimaryWindowRestoreRepaint(source), false);
  assert.doesNotMatch(method, /on\(`restore`|webContents\.invalidate|setImmediate/);
});

test("routes every Windows tray brand to the Anti-Codex tray resource", () => {
  const officialTrayGuid = "e5768d8b-6936-4f45-b1ad-4c5fb414cb35";
  const antiCodexTrayGuid = "a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3";
  const source = [
    `function dEe(e){switch(e){case\`Prod\`:return\`${officialTrayGuid}\`;default:return}}`,
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
  assert.equal((patched.match(new RegExp(officialTrayGuid, "g")) || []).length, 0);
  assert.equal((patched.match(new RegExp(antiCodexTrayGuid, "g")) || []).length, 1);
  assert.equal(brandPatchCompat.hasWindowsTrayIconSelection(patched), true);
  assert.equal(
    brandPatchCompat.patchWindowsTrayIconSelection(patched),
    patched,
  );
  assert.throws(
    () => brandPatchCompat.patchWindowsTrayIconSelection(source.replace(officialTrayGuid, "00000000-0000-0000-0000-000000000000")),
    /tray GUID/i,
  );
  assert.throws(
    () => brandPatchCompat.patchWindowsTrayIconSelection(`${source}${officialTrayGuid}`),
    /tray GUID/i,
  );
});

test("routes the 26.825 one-argument Windows tray selector to the Anti-Codex resource", () => {
  const officialTrayGuid = "e5768d8b-6936-4f45-b1ad-4c5fb414cb35";
  const antiCodexTrayGuid = "a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3";
  const source = [
    `function dEe(e){switch(e){case\`Prod\`:return\`${officialTrayGuid}\`;default:return}}`,
    "function SS(e){return e===a.a.Agent?{dark:`icon-agent.ico`,light:`icon-agent.ico`}:{dark:`chatgpt-tray-dark.ico`,light:`chatgpt-tray-light.ico`}}",
  ].join("");
  const patched = brandPatchCompat.patchWindowsTrayIconSelection(source);

  assert.equal(patched.length, source.length);
  assert.doesNotMatch(patched, /icon-agent\.ico|chatgpt-tray-(?:dark|light)\.ico/);
  assert.equal((patched.match(/codex-tray\.ico/g) || []).length, 4);
  assert.equal((patched.match(new RegExp(officialTrayGuid, "g")) || []).length, 0);
  assert.equal((patched.match(new RegExp(antiCodexTrayGuid, "g")) || []).length, 1);
  assert.equal(brandPatchCompat.patchWindowsTrayIconSelection(patched), patched);
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
