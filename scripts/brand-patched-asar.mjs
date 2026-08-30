import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildAsarIntegrity,
  hasAppServerManagedSessionFlags,
  hasCrashRecoveryPageSignature,
  hasPatchedAuthRequirement,
  hasProductNameDrivenSessionTitle,
  hasStartupMcpConfigReload,
  hasSettingsExternalNavigationPatch,
  hasSettingsExternalNavigationRenderPatch,
  hasWindowsTrayIconPatchCandidate,
  hasWindowsTrayIconSelection,
  patchAppServerManagedSessionFlags,
  patchComputerUseLegacyNotifyOptOut,
  patchConfigWriteHandler as patchCurrentConfigWriteHandler,
  patchCrashRecoveryPage,
  patchElectronProductName,
  patchLocalModelAvailability,
  patchProductNameDrivenSessionTitle,
  patchStartupMcpConfigReload,
  patchSettingsExternalNavigation,
  patchSettingsExternalNavigationRender,
  patchWebviewHtmlTitle,
  patchWindowsTrayIconSelection,
  selectCrashRecoveryBundleCandidate,
} from "./brand-patch-compat.mjs";
import { patchCompiledProfileDropdownSettings } from "./brand-profile-dropdown.mjs";

const argv = process.argv.slice(2);
const profileIndex = argv.indexOf("--profile");
const patchProfile = profileIndex >= 0 ? String(argv[profileIndex + 1] || "") : "fixed-shell-v1";
const hostPatchRevision = 7;
const asarPath = argv[0];
const forcedFailurePatch = String(process.env.ANTICODEX_TEST_FAIL_CRITICAL_PATCH || "").trim();

if (!asarPath || patchProfile !== "fixed-shell-v1") {
  console.error("Usage: node brand-patched-asar.mjs <app.asar> [--profile fixed-shell-v1]");
  process.exit(2);
}

function walkToEntry(header, rel) {
  const parts = rel.split("/");
  let node = header;
  for (const part of parts) {
    node = node.files?.[part];
    if (!node) throw new Error(`Missing ASAR entry: ${rel}`);
  }
  return node;
}

function* walkFiles(node, prefix = "") {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child.files) {
      yield* walkFiles(child, rel);
    } else {
      yield [rel, child];
    }
  }
}

function readFileFromAsar(fd, entry, dataOffset) {
  const size = Number(entry.size || 0);
  const offset = dataOffset + Number(entry.offset || 0);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, offset);
  return { buf, offset };
}

function alignedAsarDataOffset(headerStringSize) {
  const prefixSize = 16;
  return prefixSize + headerStringSize + ((4 - ((prefixSize + headerStringSize) % 4)) % 4);
}

function replacePadded(text, search, replacement) {
  const index = text.indexOf(search);
  if (index < 0) throw new Error(`Pattern not found: ${search.slice(0, 80)}`);
  if (replacement.length > search.length) {
    throw new Error(`Replacement longer than search: ${replacement.length} > ${search.length}`);
  }
  return text.slice(0, index) + replacement + " ".repeat(search.length - replacement.length) + text.slice(index + search.length);
}

function replaceBetweenPadded(text, start, end, replacement) {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) throw new Error(`Start pattern not found: ${start}`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`End pattern not found: ${end}`);
  const searchLength = endIndex - startIndex;
  if (replacement.length > searchLength) {
    throw new Error(`Replacement longer than range: ${replacement.length} > ${searchLength}`);
  }
  return text.slice(0, startIndex) + replacement + " ".repeat(searchLength - replacement.length) + text.slice(endIndex);
}

function patchPackageJson(text) {
  if (text.includes('"productName": "Anti-Codex"') || text.includes('"productName":"Anti-Codex"')) return text;
  let next = text
    .replace('"productName": "DeepCodex"', '"productName": "Anti-Codex"')
    .replace('"productName": "Codex"', '"productName": "Anti-Codex"');
  if (next === text) throw new Error("package.json productName pattern not found");
  let extra = next.length - text.length;
  if (extra > 0) {
    next = next.replace(/: /g, (match) => {
      if (extra <= 0) return match;
      extra -= 1;
      return ":";
    });
  }
  if (next.length > text.length) {
    throw new Error(`package.json grew too large: ${next.length} > ${text.length}`);
  }
  return next + " ".repeat(text.length - next.length);
}

function patchBootstrapAppUserModelId(text) {
  if (text.includes("setAppUserModelId(`AntiCodex`)")) return text;
  // Anchor on the stable structure; minified variable names (n/r) and the arg
  // expression (t.b(x), n.E(S), ...) change between Codex builds, so capture them.
  const re = /process\.platform===`win32`&&([\w$]+)\.app\.setAppUserModelId\((?:[^()]|\([^()]*\))*\)/;
  const m = re.exec(text);
  if (!m) throw new Error("AppUserModelID bootstrap pattern not found");
  const replacement = `${m[1]}.app.setAppUserModelId(\`AntiCodex\`)`;
  if (replacement.length > m[0].length) throw new Error("AppUserModelID replacement longer than match");
  return text.slice(0, m.index) + replacement + " ".repeat(m[0].length - replacement.length) + text.slice(m.index + m[0].length);
}

function patchBootstrapAppName(text) {
  if (text.includes(".app.name=`Anti-Codex`")) return text;
  const re = /([\w$]+)\.app\.setName\((?:[^()]|\([^()]*\))*\)/;
  const m = re.exec(text);
  if (!m) throw new Error("Electron app.setName bootstrap pattern not found");
  const replacement = `${m[1]}.app.name=\`Anti-Codex\``;
  if (replacement.length > m[0].length) throw new Error("Electron app.name replacement longer than match");
  return text.slice(0, m.index) + replacement + " ".repeat(m[0].length - replacement.length) + text.slice(m.index + m[0].length);
}

function patchMainSession(text) {
  if (hasProductNameDrivenSessionTitle(text)) {
    return patchProductNameDrivenSessionTitle(text);
  }
  if (/var\s+[\w$]+=`Anti-Codex`;function\s+[\w$]+\([^)]*\)\{return null\}function\s+[\w$]+\([^)]*\)\{return [\w$]+\}/.test(text)) return text;
  const re = /var\s+([\w$]+)=`Codex`;function\s+([\w$]+)\(([\w$]+)\)\{switch\(\3\)\{[\s\S]{0,900}?case\s+[\w$.]+\.Prod:return null\}\}function\s+([\w$]+)\(([\w$]+)\)\{let\s+([\w$]+)=\2\(\5\);return \6==null\?\1:`\$\{\1\} \(\$\{\6\}\)`\}/;
  const match = re.exec(text);
  if (!match) throw new Error("main session title pattern not found");
  const replacement = `var ${match[1]}=\`Anti-Codex\`;function ${match[2]}(${match[3]}){return null}function ${match[4]}(${match[5]}){return ${match[1]}}`;
  if (replacement.length > match[0].length) throw new Error("main session title replacement longer than match");
  return text.slice(0, match.index) + replacement + " ".repeat(match[0].length - replacement.length) + text.slice(match.index + match[0].length);
}

function patchWindowsCloseBehavior(text) {
  const search = "if(process.platform===`win32`&&f===`local`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),j.hide();return}";
  const replacement = "if(process.platform===`win32`&&f===`local`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){n.app.quit();return}";
  if (!text.includes(search) && text.includes(replacement)) return text;
  return replacePadded(text, search, replacement);
}

function patchLocaleInfo(text) {
  const localeInfoRe = /"locale-info":async\(\)=>\(\{ideLocale:([A-Za-z_$][\w$]*)\.app\.getLocale\(\),systemLocale:\1\.app\.getSystemLocale\(\)\}\)/;
  const match = localeInfoRe.exec(text);
  const replacement = "\"locale-info\":async()=>({ideLocale:`zh-CN`,systemLocale:`zh-CN`})";
  if (!match && text.includes(replacement)) return text;
  if (!match) throw new Error("locale-info handler pattern not found");
  return text.slice(0, match.index) + replacement + " ".repeat(match[0].length - replacement.length) + text.slice(match.index + match[0].length);
}

function patchConfigWriteHandler(text) {
  const currentConfigWriteMarker = '"batch-write-config-value":e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(`config/batchWrite`,e)';
  if (text.includes(currentConfigWriteMarker)) return patchCurrentConfigWriteHandler(text);
  if (/"get-configuration":async\(\{key:[\w$]+\}\)=>\(\{value:this\.getConfigurationValue\([\w$]+\)\}\),/.test(text)) {
    return patchCurrentConfigWriteHandler(text);
  }
  const replacement = "\"get-configuration\":async({key:e})=>({value:this.globalState.get(e)}),\"write-config-value\":async e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(\"config/value/write\",e),\"batch-write-config-value\":async e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(\"config/batchWrite\",e),\"set-configuration\":async({key:t,value:n})=>(this.globalState.set(t,n),t===e.Or.APPEARANCE_THEME&&VT(n),(t===e.Or.APPEARANCE_THEME||t===e.Or.APPEARANCE_LIGHT_CHROME_THEME||t===e.Or.APPEARANCE_DARK_CHROME_THEME)&&this.windowManager.refreshWindowBackdropForHost(this.hostConfig.id),{success:!0}),\"apply-patch\":async n=>{let r=n.hostConfig,i=this.getAppServerClientForHostIdOrThrow(r.id);return t.zt(n,this.gitManager,i,re(t.Hr(r)))},\"mcp-codex-config\":async({cwd:e})=>({config:await this.buildMcpCodexConfig(e)}),\"worktree-shell-environment-config\":async({cwd:n,hostId:r})=>{let i=this.getRequestAppServerClient(r),a=i.hostConfig;return{shellEnvironment:await t.Lt(e.zt(a)?n:this.mapAgentPathToLocalPath(n,a)??n,i)}},\"ide-context\":async({workspaceRoot:e,origin:t})=>{let n=this.getIpcClientForOrigin(t),r=await n.sendRequest(\"ide-context\",{workspaceRoot:e});return{ideContext:r.result.ideContext}},";
  if (text.includes("\"batch-write-config-value\":async e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(\"config/batchWrite\",e)")) return text;
  const currentSearch = "\"get-configuration\":async({key:e})=>({value:this.globalState.get(e)}),\"write-config-value\":async e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(\"config/value/write\",e),\"set-configuration\":async({key:t,value:n})=>(this.globalState.set(t,n),t===e.Or.APPEARANCE_THEME&&VT(n),(t===e.Or.APPEARANCE_THEME||t===e.Or.APPEARANCE_LIGHT_CHROME_THEME||t===e.Or.APPEARANCE_DARK_CHROME_THEME)&&this.windowManager.refreshWindowBackdropForHost(this.hostConfig.id),{success:!0}),\"apply-patch\":async n=>{let r=n.hostConfig,i=this.getAppServerClientForHostIdOrThrow(r.id);return t.zt(n,this.gitManager,i,re(t.Hr(r)))},\"mcp-codex-config\":async({cwd:e})=>({config:await this.buildMcpCodexConfig(e)}),\"worktree-shell-environment-config\":async({cwd:n,hostId:r})=>{let i=this.getRequestAppServerClient(r),a=i.hostConfig;return{shellEnvironment:await t.Lt(e.zt(a)?n:this.mapAgentPathToLocalPath(n,a)??n,i)}},\"ide-context\":async({workspaceRoot:e,origin:t})=>{if(!e)throw Error(\"workspaceRoot required\");if(!this.isMultiClientTransport())throw Error(\"IPC\");let n=this.getIpcClientForOrigin(t);if(!n)throw Error(\"Missing IPC client\");let r=await n.sendRequest(\"ide-context\",{workspaceRoot:e});if(r.resultType===\"error\")throw Error(r.error);return{ideContext:r.result.ideContext}},";
  if (text.includes(currentSearch)) return replacePadded(text, currentSearch, replacement);
  const search = "\"get-configuration\":async({key:e})=>({value:this.globalState.get(e)}),\"set-configuration\":async({key:t,value:n})=>(this.globalState.set(t,n),t===e.Or.APPEARANCE_THEME&&VT(n),(t===e.Or.APPEARANCE_THEME||t===e.Or.APPEARANCE_LIGHT_CHROME_THEME||t===e.Or.APPEARANCE_DARK_CHROME_THEME)&&this.windowManager.refreshWindowBackdropForHost(this.hostConfig.id),{success:!0}),\"apply-patch\":async({origin:e,...n})=>{let r=n.hostConfig,i=this.getAppServerClientForHostIdOrThrow(r.id);return t.zt(n,this.gitManager,i,re(t.Hr(r)))},\"mcp-codex-config\":async({cwd:e})=>({config:await this.buildMcpCodexConfig(e)}),\"worktree-shell-environment-config\":async({cwd:n,hostId:r})=>{let i=this.getRequestAppServerClient(r),a=i.hostConfig;return{shellEnvironment:await t.Lt(e.zt(a)?n:this.mapAgentPathToLocalPath(n,a)??n,i)}},\"ide-context\":async({workspaceRoot:e,origin:t})=>{if(!e)throw Error(`workspaceRoot is required`);if(!this.isMultiClientTransport())throw Error(`IPC is disabled when connected to a non-stdio app server transport`);let n=this.getIpcClientForOrigin(t);if(!n)throw Error(`Missing IPC client for window`);let r=await n.sendRequest(`ide-context`,{workspaceRoot:e});if(r.resultType===`error`)throw Error(`Failed to get ide context: ${r.error}`);return{ideContext:r.result.ideContext}},";
  return replacePadded(text, search, replacement);
}

function patchDefaultLocale(text) {
  if (text.includes("var t=`zh-CN`,n=Object.assign")) return text;
  return replacePadded(text, "var t=`en-US`,n=Object.assign", "var t=`zh-CN`,n=Object.assign");
}

function patchEnableI18n(text) {
  if (!text.includes("()=>n?.get(`enable_i18n`,!1)")) return text;
  return replacePadded(text, "()=>n?.get(`enable_i18n`,!1)", "()=>true");
}

function patchI18nLoadingGate(text) {
  const search = "(0,$.jsx)(Eo,{locale:f,defaultLocale:Aj,messages:r&&m?.locale===f?m.messages:void 0,onError:()=>{},children:r&&d&&!m?null:e})                        ";
  const replacement = "(0,$.jsx)(Eo,{locale:f,defaultLocale:Aj,messages:(0,Q.useMemo)(()=>{if(r)return m?.locale===f?m.messages:void 0},[r,m,f]),onError:()=>{},children:e})";
  if (text.includes(search)) return replacePadded(text, search, replacement);
  return text;
}

function patchAuthRequirement(text) {
  let next = text;
  if (next.includes("function _(){return{openAIAuth:null,authMethod:null,requiresAuth:!0,email:null,planAtLogin:null}}")) {
    next = replacePadded(
      next,
      "function _(){return{openAIAuth:null,authMethod:null,requiresAuth:!0,email:null,planAtLogin:null}}",
      "function _(){return{authMethod:`apikey`,requiresAuth:!1,email:null,planAtLogin:null}}",
    );
  }
  if (next.includes("requiresAuth:!0 ,email:e.account?.type===`chatgpt`?e.account.email:null")) {
    next = replacePadded(
      next,
      "requiresAuth:!0 ,email:e.account?.type===`chatgpt`?e.account.email:null",
      "requiresAuth:!1 ,email:e.account?.type===`chatgpt`?e.account.email:null",
    );
  }
  if (next.includes("function T(){return{openAIAuth:null,authMethod:null,requiresAuth:!0,email:null,planAtLogin:null}}")) {
    next = replacePadded(
      next,
      "function T(){return{openAIAuth:null,authMethod:null,requiresAuth:!0,email:null,planAtLogin:null}}",
      "function T(){return{authMethod:`apikey`,requiresAuth:!1,email:null,planAtLogin:0}}",
    );
  }
  if (next.includes("function T(){return{openAIAuth:1,authMethod:1,requiresAuth:!1,email:null,planAtLogin:null}}")) {
    next = replacePadded(
      next,
      "function T(){return{openAIAuth:1,authMethod:1,requiresAuth:!1,email:null,planAtLogin:null}}",
      "function T(){return{authMethod:`apikey`,requiresAuth:!1,email:null,planAtLogin:0}}",
    );
  }
  if (next.includes("function T(){return{authMethod:`chatgpt`,requiresAuth:!0,email:null,planAtLogin:0}}")) {
    next = replacePadded(
      next,
      "function T(){return{authMethod:`chatgpt`,requiresAuth:!0,email:null,planAtLogin:0}}",
      "function T(){return{authMethod:`apikey`,requiresAuth:!1,email:null,planAtLogin:0}}",
    );
  }
  if (next.includes("requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!0)")) {
    next = replacePadded(
      next,
      "requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!0)",
      "requiresAuth:!1",
    );
  }
  if (next.includes("requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!1)")) {
    next = replacePadded(
      next,
      "requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!1)",
      "requiresAuth:!1",
    );
  }
  if (hasPatchedAuthRequirement(next)) {
    return next;
  }
  return next;
}

function patchOnboardingGate(text) {
  if (text.includes("v=()=>{},y=[h,_]")) return text;
  return replaceBetweenPadded(
    text,
    "v=()=>{if(!_)return;let e=_===`app`||_===`welcome`&&!h?`app`:`onboarding`;G.dispatchMessage(",
    ",e[0]=h",
    "v=()=>{},y=[h,_]",
  );
}

function patchAppRouteGate(text) {
  const marker = "to:`/login`,replace:!0";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return text;
  if (text.lastIndexOf("if(!0){", markerIndex) > text.lastIndexOf("if(", markerIndex)) return text;
  const gateStart = text.lastIndexOf("if(", markerIndex);
  const gateEnd = text.indexOf("{", gateStart) + 1;
  if (gateStart < 0 || gateEnd <= gateStart) return text;
  const search = text.slice(gateStart, gateEnd);
  if (!/^if\([\w$]+\|\|![\w$]+\)\{$/.test(search)) return text;
  return replacePadded(text, search, "if(!0){");
}

function patchAppearanceSettings(text) {
  if (text.includes("children:[(0,V.jsx)(R,{}),(0,V.jsx)(Q,{})]")) return text;
  const replacement = "function ee(){let e=(0,B.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,V.jsxs)(D,{title:(0,V.jsx)(T,{slug:`appearance`}),children:[(0,V.jsx)(R,{}),(0,V.jsx)(Q,{})]}),e[0]=t):t=e[0],t}";
  return replaceBetweenPadded(text, "function ee(){", "export{ee as AppearanceSettings};", replacement);
}

function patchGeneralAppearanceSettings(text) {
  const replacement = "function qn(){return(0,$.jsx)(Y,{children:(0,$.jsx)(Y.Content,{children:(0,$.jsxs)(mt,{children:[(0,$.jsx)(pr,{}),(0,$.jsx)(`div`,{className:`flex flex-col gap-2 p-1`,children:(0,$.jsx)(nn,{})}),(0,$.jsx)(mr,{})]})})})}";
  if (text.includes(replacement)) return text;
  return replaceBetweenPadded(text, "function qn(){", "function Jn(){", replacement);
}

function patchProfileDropdownSettings(text) {
  const search = ",Mt=xt,Nt=p(Se,`settings`)";
  const replacement = ",Mt=!0,Nt=p(Se,`settings`)";
  let next = text;
  if (next.includes(search)) {
    next = replacePadded(next, search, replacement);
  } else if (!next.includes(replacement) && !next.includes("codex.profileDropdown.settingsPage")) {
    throw new Error("Profile dropdown settings gate pattern not found");
  }
  const managerEntry = "let Ut=()=>{u(!1),d(`/settings/${Be}`,{state:je})},Wt=(0,Q.jsx)(O,{id:`codex.profileDropdown.settingsPage`,defaultMessage:`Settings`,description:`Menu item to open Codex settings page`}),Gt=(0,Q.jsx)(et,{LeftIcon:Me,keyboardShortcut:Ie,onClick:Ut,children:Wt}),Kt=(0,Q.jsxs)(V,{browser:!0,electron:!0,children:[Ht,Gt,(0,Q.jsx)(et,{LeftIcon:Me,onClick:()=>{u(!1),globalThis.__ANTICODEX_OPEN_MANAGER__?.()},children:`\\u7ba1\\u7406`},`anticodex-manager`)]});";
  if (next.includes("anticodex-manager") && next.includes("__ANTICODEX_OPEN_MANAGER__")) return next;
  const compiledProfileDropdown = patchCompiledProfileDropdownSettings(next);
  if (compiledProfileDropdown !== next) return compiledProfileDropdown;
  if (next.includes("let Ut;t[129]!==d||t[130]!==u||t[131]!==je?(") ||
       next.includes("let Ut=()=>{u(!1),d(`/settings/${Be}`,{state:je})}")) {
    const start = next.includes("let Ut;t[129]!==d||t[130]!==u||t[131]!==je?(")
      ? "let Ut;t[129]!==d||t[130]!==u||t[131]!==je?("
      : "let Ut=()=>{u(!1),d(`/settings/${Be}`,{state:je})}";
    return replaceBetweenPadded(next, start, "let qt;", managerEntry);
  }

  const currentProfileStart = "let C;t[13]!==p||t[14]!==S?(C=(0,J.jsx)(M,{electron:!0,children:(0,J.jsx)(I,{LeftIcon:tn,onClick:p,children:S})}),t[13]=p,t[14]=S,t[15]=C):C=t[15];";
  if (next.includes(currentProfileStart) && next.includes("children:[v,y,o,b,h,C,i,T,E]")) {
    const labelStart = next.indexOf("let w;", next.indexOf(currentProfileStart));
    const itemStart = next.indexOf("let T;", labelStart);
    if (labelStart < 0 || itemStart < 0) {
      throw new Error("Current profile dropdown settings label was not found");
    }
    const labelBlock = next.slice(labelStart, itemStart);
    const currentManagerEntry = "(0,J.jsx)(I,{onClick:globalThis.__ANTICODEX_OPEN_MANAGER__,children:`\\u7ba1\\u7406`},`anticodex-manager`)";
    const replacement = "let C=s?(0,J.jsx)(M,{electron:!0,children:(0,J.jsx)(I,{LeftIcon:tn,onClick:p,children:S})}):null;" +
      labelBlock +
      "let T=[(0,J.jsx)(I,{LeftIcon:rt,keyboardShortcut:m,onClick:d,children:w})," + currentManagerEntry + "];";
    return replaceBetweenPadded(next, currentProfileStart, "let E;", replacement);
  }

  const labelIndex = next.indexOf("codex.profileDropdown.settingsPage");
  const actionArrowIndex = next.lastIndexOf("=>{", labelIndex);
  const segmentStart = next.lastIndexOf("let ", actionArrowIndex);
  const groupIndex = next.indexOf("browser:!0,electron:!0,children:[", labelIndex);
  const segmentEnd = next.indexOf(";let ", groupIndex);
  if (labelIndex < 0 || actionArrowIndex < 0 || segmentStart < 0 || groupIndex < 0 || segmentEnd < 0) {
    throw new Error("Profile dropdown manager injection pattern not found");
  }
  const segment = next.slice(segmentStart, segmentEnd + 1);
  const action = /let ([\w$]+);[\s\S]*?\1=\(\)=>\{([\w$]+)\(!1\),([\w$]+)\(`\/settings\/\$\{([\w$]+)\}`,\{state:([\w$]+)\}\)/.exec(segment);
  const label = /let ([\w$]+);[^;]*?\(0,([\w$]+)\.jsx\)\(([\w$]+),\{id:`codex\.profileDropdown\.settingsPage`/.exec(segment);
  if (!action || !label) throw new Error("Profile dropdown settings item structure not found");
  const item = new RegExp(`let ([\\w$]+);[^;]*?\\(0,${label[2]}\\.jsx\\)\\(([\\w$]+),\\{LeftIcon:([\\w$]+),keyboardShortcut:([\\w$]+),onClick:${action[1]},children:${label[1]}\\}\\)`).exec(segment);
  const group = item && new RegExp(`let ([\\w$]+);[^;]*?\\(0,${label[2]}\\.jsxs\\)\\(([\\w$]+),\\{browser:!0,electron:!0,children:\\[([\\w$]+),${item[1]}\\]\\}\\)`).exec(segment);
  if (!item || !group) throw new Error("Profile dropdown browser/electron menu group not found");
  const injected = `let ${action[1]}=()=>{${action[2]}(!1),${action[3]}(\`/settings/\${${action[4]}}\`,{state:${action[5]}})},${label[1]}=(0,${label[2]}.jsx)(${label[3]},{id:\`codex.profileDropdown.settingsPage\`,defaultMessage:\`Settings\`,description:\`Menu item to open Codex settings page\`}),${item[1]}=(0,${label[2]}.jsx)(${item[2]},{LeftIcon:${item[3]},keyboardShortcut:${item[4]},onClick:${action[1]},children:${label[1]}}),${group[1]}=(0,${label[2]}.jsxs)(${group[2]},{browser:!0,electron:!0,children:[${group[3]},${item[1]},(0,${label[2]}.jsx)(${item[2]},{LeftIcon:${item[3]},onClick:()=>{${action[2]}(!1),globalThis.__ANTICODEX_OPEN_MANAGER__?.()},children:\`\\u7ba1\\u7406\`},\`anticodex-manager\`)]});`;
  if (injected.length > segment.length) throw new Error("Profile dropdown manager injection replacement did not fit");
  return next.slice(0, segmentStart) + injected + " ".repeat(segment.length - injected.length) + next.slice(segmentEnd + 1);
}

function patchBrowserWindowIcon(text) {
  let next = text;
  const currentSearch = '...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},';
  const currentReplacement = '...process.platform===`win32`?{icon:`icon.ico`,autoHideMenuBar:!0}:{},';
  if (next.includes(currentSearch)) next = replacePadded(next, currentSearch, currentReplacement);
  const search = '...process.platform===`win32`?{autoHideMenuBar:!0}:{},';
  const replacement = '...process.platform===`win32`?{icon:`icon.ico`}:{},';
  if (next.includes(search)) next = replacePadded(next, search, replacement);
  if (!next.includes("icon:`icon.ico`")) throw new Error("BrowserWindow icon pattern not found");
  return next;
}

function patchLocalPluginCatalog(text) {
  // Isolation patch only: disable the remote marketplace catalog, not installed local plugins.
  const source = /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{return \2\.sendRequest\(`plugin\/list`,\3\)\}/;
  const installed = /var ([\w$]+)=[\w$]+=>[\w$]+\.sendRequest\(`plugin\/installed`,\{\}\);/;
  const match = source.exec(text) || installed.exec(text);
  if (!match) {
    if (/var [\w$]+=async\(\)=>\(\{marketplaces:\[\]\}\);/.test(text)) return text;
    throw new Error("Local plugin catalog pattern not found");
  }
  const replacement = `var ${match[1]}=async()=>({marketplaces:[]});`;
  return text.slice(0, match.index) + replacement + " ".repeat(match[0].length - replacement.length) + text.slice(match.index + match[0].length);
}

function patchElectronLocalPluginCatalog(text) {
  // Keep Codex's installed-plugin path local; do not reimplement per-plugin behavior here.
  const start = "async listPlugins(";
  const end = "async addMarketplace(";
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error("Electron plugin catalog method not found");
  const current = text.slice(startIndex, endIndex);
  const match = /^async listPlugins\(([\w$]+)\)/.exec(current);
  if (!match) throw new Error("Electron plugin catalog signature not found");
  const replacement = `async listPlugins(${match[1]}){return{marketplaces:[],marketplaceLoadErrors:[]}}`;
  if (replacement.length > current.length) {
    throw new Error("Electron plugin catalog replacement did not fit");
  }
  return text.slice(0, startIndex) + replacement + " ".repeat(current.length - replacement.length) + text.slice(endIndex);
}

function patchWebviewLocalPluginCatalog(text) {
  // Route the webview marketplace list through the local installed-plugin API.
  const source = /"list-plugins":([\w$]+)\(\(([\w$]+),([\w$]+)\)=>\2\.sendRequest\(`plugin\/list`,\3\)\)/;
  const match = source.exec(text);
  if (!match) {
    if (/"list-plugins":[\w$]+\(([\w$]+)=>\1\.listPlugins\(\{\}\)\)/.test(text)) return text;
    throw new Error("Webview plugin catalog route not found");
  }
  const replacement = `"list-plugins":${match[1]}(${match[2]}=>${match[2]}.listPlugins({}))`;
  return text.slice(0, match.index) + replacement + " ".repeat(match[0].length - replacement.length) + text.slice(match.index + match[0].length);
}

function findBootstrapAppUserModelIdPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (/process\.platform===`win32`&&[\w$]+\.app\.setAppUserModelId\((?:[^()]|\([^()]*\))*\)/.test(text) ||
        text.includes("setAppUserModelId(`AntiCodex`)")) {
      return [rel, patchBootstrapAppUserModelId];
    }
  }
  throw new Error("Could not find Windows AppUserModelID bootstrap code");
}

function findBootstrapAppNamePatch(fd, header, dataOffset) {
  const productNameCandidates = [];
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes(".app.setName(") || text.includes(".app.name=`Anti-Codex`")) {
      try {
        patchBootstrapAppName(text);
        return [rel, patchBootstrapAppName];
      } catch {}
    }
    try {
      patchElectronProductName(text);
      productNameCandidates.push([rel, patchElectronProductName]);
    } catch {}
  }
  if (productNameCandidates.length === 1) return productNameCandidates[0];
  throw new Error(`Expected exactly one Electron app-name patch target, found ${productNameCandidates.length}`);
}

function findWebviewHtmlTitlePatch(fd, header, dataOffset) {
  const rel = "webview/index.html";
  const entry = walkToEntry(header, rel);
  const { buf } = readFileFromAsar(fd, entry, dataOffset);
  const text = buf.toString("utf8");
  try {
    patchWebviewHtmlTitle(text);
    return [rel, patchWebviewHtmlTitle];
  } catch {}
  throw new Error("Could not find webview HTML title");
}

function findMainSessionPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (/var\s+[\w$]+=`(?:Codex|DeepCodex|Anti-Codex)`;function\s+[\w$]+\(/.test(text) ||
        hasProductNameDrivenSessionTitle(text)) {
      return [rel, patchMainSession];
    }
  }
  throw new Error("Could not find Codex session title bundle under .vite/build/*.js");
}

function findWindowsClosePatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("canHideLastLocalWindowToTray?.()")) {
      return [rel, patchWindowsCloseBehavior];
    }
  }
  throw new Error("Could not find Windows close-to-tray behavior under .vite/build/*.js");
}

function findLocaleInfoPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (/"locale-info":async\(\)=>\(\{ideLocale:([A-Za-z_$][\w$]*)\.app\.getLocale\(\),systemLocale:\1\.app\.getSystemLocale\(\)\}\)/.test(text) ||
        text.includes("\"locale-info\":async()=>({ideLocale:`zh-CN`,systemLocale:`zh-CN`})")) {
      return [rel, patchLocaleInfo];
    }
  }
  throw new Error("Could not find locale-info under .vite/build/*.js");
}

function findConfigWriteHandlerPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    try {
      patchConfigWriteHandler(text);
      return [rel, patchConfigWriteHandler];
    } catch {}
  }
  throw new Error("Could not find Electron config write handler table");
}

function findStartupMcpConfigReloadPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (hasStartupMcpConfigReload(text)) {
      return [rel, patchStartupMcpConfigReload];
    }
  }
  throw new Error("Could not find startup MCP config reload under .vite/build/*.js");
}

function findAppServerManagedSessionFlagsPatch(fd, header, dataOffset) {
  const candidates = [];
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if ((!text.includes("Failed to spawn Codex CLI at") || !text.includes("spawnArgs??this.options.args")) &&
        !hasAppServerManagedSessionFlags(text)) continue;
    patchAppServerManagedSessionFlags(text);
    candidates.push([rel, patchAppServerManagedSessionFlags]);
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one native app-server spawn bundle, found ${candidates.length}`);
  }
  return candidates[0];
}

function findDefaultLocalePatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("var t=`en-US`,n=Object.assign") || text.includes("var t=`zh-CN`,n=Object.assign")) {
      return [rel, patchDefaultLocale];
    }
  }
  throw new Error("Could not find webview default locale resolver");
}

function findEnableI18nPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("()=>n?.get(`enable_i18n`,!1)") || /=>true\s*,\[n\]\)/.test(text)) {
      return [rel, patchEnableI18n];
    }
  }
  throw new Error("Could not find webview i18n feature gate");
}

function findI18nLoadingGatePatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("children:r&&d&&!m?null:e")) {
      return [rel, patchI18nLoadingGate];
    }
  }
  return ["package.json", (text) => text];
}

function findAuthRequirementPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("function _(){return{openAIAuth:null,authMethod:null,requiresAuth:!0,email:null,planAtLogin:null}}") ||
        text.includes("function _(){return{authMethod:`apikey`,requiresAuth:!1,email:null,planAtLogin:null}}") ||
        text.includes("requiresAuth:!0 ,email:e.account?.type===`chatgpt`?e.account.email:null") ||
        text.includes("requiresAuth:!1 ,email:e.account?.type===`chatgpt`?e.account.email:null") ||
        text.includes("function T(){return{openAIAuth:null,authMethod:null,requiresAuth:!0,email:null,planAtLogin:null}}") ||
        text.includes("function T(){return{openAIAuth:1,authMethod:1,requiresAuth:!1,email:null,planAtLogin:null}}") ||
        text.includes("function T(){return{authMethod:`chatgpt`,requiresAuth:!0,email:null,planAtLogin:0}}") ||
        text.includes("function T(){return{authMethod:`apikey`,requiresAuth:!1,email:null,planAtLogin:0}}") ||
        text.includes("requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!0)") ||
        hasPatchedAuthRequirement(text)) {
      return [rel, patchAuthRequirement];
    }
    if (text.includes("function T(){return{authMethod:`chatgpt`,requiresAuth:!0,email:null,planAtLogin:0}}") &&
        text.includes("requiresAuth:!0")) {
      return [rel, (text) => text];
    }
    if (text.includes("function T(){return{openAIAuth:null,authMethod:null,requiresAuth:!1,email:null,planAtLogin:null}}") &&
        (text.includes("requiresAuth:r===`copilot`||(e.requiresOpenaiAuth??!1)") ||
         text.includes("return{openAIAuth:n,authMethod:r,requiresAuth:!1"))) {
      return [rel, (text) => text];
    }
  }
  throw new Error("Could not find webview auth requirement hook");
}

function findOnboardingGatePatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if ((text.includes("function sE({auth:e,workspaceRootsData:t,workspaceRootsIsLoading:n,forcedOverride:r,postLoginWelcomePending:i,projectlessOnboardingCompleted:a,pathname:o})") &&
         (text.includes("return i&&s===0&&(o===iE||o===aE||o===oE)?`welcome`:s===0?`workspace`:`app`") ||
          text.includes("if(r)return r;if(n)return null;return`app`") ||
          text.includes("if(r)return r;return`app`") ||
          text.includes("{return`app`}"))) ||
        text.includes("function sE({auth:e,forcedOverride:t}){return e.isLoading?null:!e.authMethod&&e.requiresAuth?`login`:e.authMethod?`app`:t??`app`}") ||
        text.includes("function sE({auth:e}){return e.isLoading?null:!e.authMethod&&e.requiresAuth?`login`:`app`}")) {
      return [rel, patchOnboardingGate];
    }
  }
  throw new Error("Could not find webview onboarding gate");
}

function findAppRouteGatePatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("to:`/login`,replace:!0") ||
        ((text.includes("function XS(){") || text.includes("function XS(){return(0,$.jsx)(qS,{})}")) &&
        text.includes("function ZS("))) {
      return [rel, patchAppRouteGate];
    }
    if (text.includes("function dE(){") &&
        text.includes("function fE(e){") &&
        (text.includes("electron-set-window-mode") ||
         text.includes("function dE(){return(0,$.jsx)(Wr,{})}") ||
         text.includes("function dE(){let e=Zr().pathname,t=e===cE||e===lE||e===uE;"))) {
      return [rel, patchAppRouteGate];
    }
  }
  throw new Error("Could not find webview app route gate");
}

function findAppearanceSettingsPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/appearance-settings-") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("children:[(0,V.jsx)(R,{}),(0,V.jsx)(Q,{})]") ||
        text.includes("children:[(0,V.jsx)(R,{})]") ||
        text.includes("export{ee as AppearanceSettings}")) {
      return [rel, patchAppearanceSettings];
    }
  }
  throw new Error("Could not find webview appearance settings bundle");
}

function findGeneralAppearanceSettingsPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/general-settings-") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("function qn(){") && text.includes("function Jn(){")) {
      return [rel, patchGeneralAppearanceSettings];
    }
  }
  throw new Error("Could not find general appearance settings bundle");
}

function findProfileDropdownSettingsPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if ((!rel.startsWith("webview/assets/profile-dropdown-") &&
         !rel.startsWith("webview/assets/app-initial-")) ||
        !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes(",Mt=xt,Nt=p(Se,`settings`)") ||
        text.includes(",Mt=!0,Nt=p(Se,`settings`)") ||
        text.includes("codex.profileDropdown.settingsPage") ||
        text.includes("anticodex-manager")) {
      return [rel, patchProfileDropdownSettings];
    }
  }
  throw new Error("Could not find profile dropdown settings gate");
}

function findBrowserWindowIconPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/main-") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (text.includes("...process.platform===`win32`?{autoHideMenuBar:!0}:{}") ||
        text.includes("...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{}") ||
        text.includes("icon:`icon.ico`")) {
      return [rel, patchBrowserWindowIcon];
    }
  }
  throw new Error("Could not find BrowserWindow options under .vite/build/main-*.js");
}

function findSettingsExternalLinksPatch(fd, header, dataOffset) {
  const definitionCandidates = [];
  const renderCandidates = [];
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if ((text.includes("https://chatgpt.com/#settings") &&
         text.includes("https://chatgpt.com/open-security-settings")) ||
        hasSettingsExternalNavigationPatch(text)) {
      patchSettingsExternalNavigation(text);
      definitionCandidates.push([rel, patchSettingsExternalNavigation]);
    }
    try {
      patchSettingsExternalNavigationRender(text);
      renderCandidates.push([rel, patchSettingsExternalNavigationRender]);
    } catch {}
  }
  if (definitionCandidates.length !== 1 || renderCandidates.length !== 1) {
    throw new Error(`Expected one ChatGPT settings definition and render bundle, found ${definitionCandidates.length}/${renderCandidates.length}`);
  }
  return [definitionCandidates[0], renderCandidates[0]];
}

function findCrashRecoveryPagePatch(fd, header, dataOffset) {
  const bundles = [];
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (hasCrashRecoveryPageSignature(text)) {
      bundles.push({ rel, text });
    }
  }
  const selected = selectCrashRecoveryBundleCandidate(bundles);
  return [selected.rel, patchCrashRecoveryPage];
}

function findLocalModelAvailabilityPatch(fd, header, dataOffset) {
  const candidates = [];
  for (const [rel, entry] of walkFiles(header)) {
    if ((!rel.startsWith("webview/assets/model-list-filter-") &&
         !rel.startsWith("webview/assets/models-and-reasoning-efforts-") &&
         !rel.startsWith("webview/assets/app-initial-")) ||
        !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    try {
      patchLocalModelAvailability(text);
      candidates.push([rel, patchLocalModelAvailability]);
    } catch {}
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one webview model availability filter, found ${candidates.length}`);
  }
  return candidates[0];
}

function findLocalPluginCatalogPatch(fd, header, dataOffset) {
  let hasAppMainListPluginsRoute = false;
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (rel.startsWith("webview/assets/app-main-") && text.includes("\"list-plugins\"")) {
      hasAppMainListPluginsRoute = true;
      continue;
    }
    if (!rel.startsWith("webview/assets/app-server-manager-signals-")) continue;
    if (/function [\w$]+\(([\w$]+),([\w$]+)\)\{return \1\.sendRequest\(`plugin\/list`,\2\)\}/.test(text) ||
        /var [\w$]+=[\w$]+=>[\w$]+\.sendRequest\(`plugin\/installed`,\{\}\);/.test(text) ||
        /var [\w$]+=async\(\)=>\(\{marketplaces:\[\]\}\);/.test(text)) {
      return [rel, patchLocalPluginCatalog];
    }
  }
  if (hasAppMainListPluginsRoute) {
    return ["package.json", (text) => text];
  }
  throw new Error("Could not find webview plugin catalog request");
}

function findElectronLocalPluginCatalogPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/src-") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    const startIndex = text.indexOf("async listPlugins(");
    const endIndex = text.indexOf("async addMarketplace(", startIndex + 1);
    if (startIndex >= 0 && endIndex > startIndex) {
      const current = text.slice(startIndex, endIndex);
      if (current.includes("method:`plugin/list`") ||
          current.includes("method:`plugin/installed`") ||
          current.includes("return{marketplaces:[],marketplaceLoadErrors:[]}")) {
        return [rel, patchElectronLocalPluginCatalog];
      }
    }
  }
  throw new Error("Could not find Electron plugin catalog method");
}

function findWebviewLocalPluginCatalogPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/app-main-") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (/"list-plugins":[\w$]+\(\(([\w$]+),([\w$]+)\)=>\1\.sendRequest\(`plugin\/list`,\2\)\)/.test(text) ||
        /"list-plugins":[\w$]+\(\(([\w$]+),([\w$]+)\)=>\2\.sendRequest\(`plugin\/list`,\3\)\)/.test(text) ||
        /"list-plugins":[\w$]+\(([\w$]+)=>\1\.listPlugins\(\{\}\)\)/.test(text)) {
      return [rel, patchWebviewLocalPluginCatalog];
    }
  }
  throw new Error("Could not find webview plugin catalog route");
}

function findWindowsTrayIconPatch(fd, header, dataOffset) {
  const candidates = [];
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (hasWindowsTrayIconPatchCandidate(text)) candidates.push(rel);
  }
  if (candidates.length !== 1) throw new Error(`Expected one Windows tray icon/GUID bundle, found ${candidates.length}`);
  return [candidates[0], patchWindowsTrayIconSelection];
}

function findComputerUseLegacyNotifyOptOutPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith(".vite/build/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (!text.includes("codex-computer-use.exe")) continue;
    try {
      patchComputerUseLegacyNotifyOptOut(text);
      return [rel, patchComputerUseLegacyNotifyOptOut];
    } catch {}
  }
  throw new Error("Could not find the computer-use legacy notify installer under .vite/build/*.js");
}

function patchRetryStreamErrorVisibility(text) {
  if (/case`error`:if\(n\.willRetry\)\{break\}else if\(/.test(text)) return text;
  const search = /case`error`:if\(n\.willRetry\)\{[\s\S]*?\}else if\(/;
  const replacement = "case`error`:if(n.willRetry){break}else if(";
  const match = search.exec(text);
  if (!match) throw new Error("Retry stream-error reducer pattern not found");
  return replacePadded(text, match[0], replacement);
}

function findRetryStreamErrorVisibilityPatch(fd, header, dataOffset) {
  for (const [rel, entry] of walkFiles(header)) {
    if (!rel.startsWith("webview/assets/") || !rel.endsWith(".js")) continue;
    const { buf } = readFileFromAsar(fd, entry, dataOffset);
    const text = buf.toString("utf8");
    if (/case`error`:if\(n\.willRetry\)\{/.test(text) && text.includes("stream-error")) {
      return [rel, patchRetryStreamErrorVisibility];
    }
  }
  throw new Error("Could not find webview retry stream-error reducer");
}


const fd = fs.openSync(asarPath, "r+");
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
const headerStringSize = sizeBuf.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerStringSize);
fs.readSync(fd, headerBuf, 0, headerStringSize, 16);
const oldHeaderHash = crypto.createHash("sha256").update(headerBuf).digest("hex");
const header = JSON.parse(headerBuf.toString("utf8"));
const dataOffset = alignedAsarDataOffset(headerStringSize);

const patchSpecs = [
  ["package-json", () => ["package.json", patchPackageJson]],
  ["webview-html-title", () => findWebviewHtmlTitlePatch(fd, header, dataOffset)],
  ["app-name", () => findBootstrapAppNamePatch(fd, header, dataOffset)],
  ["app-user-model-id", () => findBootstrapAppUserModelIdPatch(fd, header, dataOffset)],
  ["session-title", () => findMainSessionPatch(fd, header, dataOffset)],
  ["windows-close", () => findWindowsClosePatch(fd, header, dataOffset)],
  ["locale-info", () => findLocaleInfoPatch(fd, header, dataOffset)],
  ["startup-mcp-config-reload", () => findStartupMcpConfigReloadPatch(fd, header, dataOffset)],
  ["app-server-managed-session-flags", () => findAppServerManagedSessionFlagsPatch(fd, header, dataOffset)],
  ["config-write", () => findConfigWriteHandlerPatch(fd, header, dataOffset)],
  ["default-locale", () => findDefaultLocalePatch(fd, header, dataOffset)],
  ["enable-i18n", () => findEnableI18nPatch(fd, header, dataOffset)],
  ["i18n-loading-gate", () => findI18nLoadingGatePatch(fd, header, dataOffset)],
  ["auth-requirement", () => findAuthRequirementPatch(fd, header, dataOffset)],
  ["onboarding-gate", () => findOnboardingGatePatch(fd, header, dataOffset)],
  ["app-route-gate", () => findAppRouteGatePatch(fd, header, dataOffset)],
  ["appearance-settings", () => findAppearanceSettingsPatch(fd, header, dataOffset)],
  ["profile-dropdown-settings", () => findProfileDropdownSettingsPatch(fd, header, dataOffset)],
  ["settings-external-links", () => findSettingsExternalLinksPatch(fd, header, dataOffset)],
  ["crash-recovery-page", () => findCrashRecoveryPagePatch(fd, header, dataOffset)],
  ["browser-window-icon", () => findBrowserWindowIconPatch(fd, header, dataOffset)],
  ["windows-tray-icon", () => findWindowsTrayIconPatch(fd, header, dataOffset)],
  ["computer-use-legacy-notify-opt-out", () => findComputerUseLegacyNotifyOptOutPatch(fd, header, dataOffset)],
  ["local-model-availability", () => findLocalModelAvailabilityPatch(fd, header, dataOffset)],
  ["local-plugin-catalog", () => findLocalPluginCatalogPatch(fd, header, dataOffset)],
  ["electron-local-plugin-catalog", () => findElectronLocalPluginCatalogPatch(fd, header, dataOffset)],
  ["webview-local-plugin-catalog", () => findWebviewLocalPluginCatalogPatch(fd, header, dataOffset)],
  ["retry-stream-error-visibility", () => findRetryStreamErrorVisibilityPatch(fd, header, dataOffset)],
];

const written = [];
const skipped = [];
const fixedShellCriticalPatchNames = new Set([
  "package-json",
  "webview-html-title",
  "app-name",
  "app-user-model-id",
  "session-title",
  "startup-mcp-config-reload",
  "app-server-managed-session-flags",
  "config-write",
  "auth-requirement",
  "app-route-gate",
  "profile-dropdown-settings",
  "settings-external-links",
  "crash-recovery-page",
  "browser-window-icon",
  "windows-tray-icon",
  "local-model-availability",
]);
const selectedPatchNames = fixedShellCriticalPatchNames;
const selectedPatchSpecs = patchSpecs.filter(([name]) => selectedPatchNames.has(name));
const activeCriticalPatchNames = fixedShellCriticalPatchNames;

for (const [name, findPatch] of selectedPatchSpecs) {
  try {
    if (forcedFailurePatch === name) {
      throw new Error(`Forced critical patch failure for transaction safety test: ${name}`);
    }
    const found = findPatch();
    const patchTargets = Array.isArray(found[0]) ? found : [found];
    for (const [rel, patch] of patchTargets) {
      const entry = walkToEntry(header, rel);
      const { buf, offset } = readFileFromAsar(fd, entry, dataOffset);
      const before = buf.toString("utf8");
      const after = patch(before);
      const afterBuf = Buffer.from(after, "utf8");
      if (afterBuf.length !== buf.length) {
        throw new Error(`${rel} size changed: ${afterBuf.length} !== ${buf.length}`);
      }
      fs.writeSync(fd, afterBuf, 0, afterBuf.length, offset);
      if (entry.integrity) {
        const integrity = buildAsarIntegrity(afterBuf, entry.integrity.blockSize);
        entry.integrity.hash = integrity.hash;
        entry.integrity.blocks = integrity.blocks;
      }
      written.push({ name, rel, size: afterBuf.length });
    }
  } catch (error) {
    skipped.push({ name, error: error?.message || String(error) });
  }
}

let nextHeaderText = JSON.stringify(header);
if (Buffer.byteLength(nextHeaderText, "utf8") > headerStringSize) {
  throw new Error(`ASAR header grew too large: ${Buffer.byteLength(nextHeaderText, "utf8")} > ${headerStringSize}`);
}
nextHeaderText += " ".repeat(headerStringSize - Buffer.byteLength(nextHeaderText, "utf8"));
const nextHeaderBuf = Buffer.from(nextHeaderText, "utf8");
fs.writeSync(fd, nextHeaderBuf, 0, nextHeaderBuf.length, 16);
fs.closeSync(fd);

const newHeaderHash = crypto.createHash("sha256").update(nextHeaderBuf).digest("hex");

const criticalSkipped = skipped.filter((item) => activeCriticalPatchNames.has(item.name));
console.log(JSON.stringify({
  asarPath,
  patchProfile,
  hostPatchRevision,
  selectedPatchNames: [...selectedPatchNames],
  written,
  skipped,
  criticalSkipped,
  oldHeaderHash,
  newHeaderHash,
}, null, 2));
if (criticalSkipped.length > 0) {
  process.exitCode = 1;
}
