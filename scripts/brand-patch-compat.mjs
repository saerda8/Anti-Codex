const ANTI_CODEX_TITLE = "`Anti-Codex`";
const ANTI_CODEX_TRAY_ICON = "`codex-tray.ico`";
const WINDOWS_TRAY_BRAND_ICONS = [
  "`icon-agent.ico`",
  "`chatgpt-tray-dark.ico`",
  "`chatgpt-tray-light.ico`",
];

const STARTUP_MCP_CONFIG_RELOAD_PATTERN =
  /await [\w$]+\.sendAppServerRequest\(`config\/batchWrite`,\{edits:[\w$]+\([\w$]+\),expectedVersion:null,filePath:null,reloadUserConfig:!(?<reload>[01])\}\)/;
const SETTINGS_EXTERNAL_NAVIGATION_PATTERN =
  /(?<binding>[\w$]+)=\{account:\{href:`https:\/\/chatgpt\.com\/#settings`,icon:(?<accountIcon>[\w$]+),message:(?<messages>[\w$]+)\.account\},securitySettings:\{href:`https:\/\/chatgpt\.com\/open-security-settings`,icon:(?<securityIcon>[\w$]+),message:\k<messages>\.securitySettings\}\}/g;
const SETTINGS_EXTERNAL_NAVIGATION_PATCHED_PATTERN =
  /[\w$]+=\{\/\*anticodex-local-settings-only\*\/account:\{href:`about:blank`,icon:[\w$]+,message:[\w$]+\.account\},securitySettings:\{href:`about:blank`,icon:[\w$]+,message:[\w$]+\.securitySettings\}\}/g;
const SETTINGS_EXTERNAL_ACCOUNT_RENDER_PATTERN =
  /[\w$]+\.key===\([\w$]+\?`personal`:`settings`\)\?\(0,[\w$]+\.jsx\)\([\w$]+,\{canCollapse:[\w$]+,externalTooltip:[\w$]+,hideLabels:[\w$]+\}\):null/g;
const SETTINGS_SECURITY_ENABLED_PATTERN =
  /(?<prefix>\(0,[\w$]+\.jsx\)\([\w$]+,\{\.\.\.[\w$]+,securitySettingsEnabled:)(?<value>[A-Za-z_$][\w$]*)(?<suffix>\}\))/g;
const SETTINGS_SECURITY_ENABLED_PATCHED_PATTERN =
  /\(0,[\w$]+\.jsx\)\([\w$]+,\{\.\.\.[\w$]+,securitySettingsEnabled:0\s*\}\)/g;
const SETTINGS_EXTERNAL_ACCOUNT_RENDER_PATCHED_PATTERN = /\/\*anticodex-hide-external-account\*\/null/g;
const APP_SERVER_NATIVE_SPAWN_PATTERN =
  /spawnProcess\(\)\{let (?<command>[\w$]+)=this\.options\.spawnCommand\?\?this\.options\.executablePath,(?<proc>[\w$]+)=(?<spawn>(?:\(0,[\w$]+\.spawn\)|[\w$]+\.spawn))\((?<resolver>[\w$]+)\.resolve\(\k<command>,\{env:this\.options\.env\}\)\?\?\k<command>,this\.options\.spawnArgs\?\?this\.options\.args,\{stdio:\[`pipe`,`pipe`,`pipe`\],env:this\.options\.env\}\);if\(!\k<proc>\.pid\)throw Error\(`Failed to spawn Codex CLI at \$\{this\.options\.executablePath\}`\);/g;
const APP_SERVER_MANAGED_SESSION_FLAGS_PATTERN =
  /spawnProcess\(\)\{let [\w$]+=this\.options,[\s\S]{0,600}?approval_policy="never"[\s\S]{0,200}?sandbox_mode="danger-full-access"[\s\S]{0,600}?Error`Codex CLI spawn failed`;/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function padReplacement(match, replacement) {
  if (replacement.length > match.length) {
    throw new Error(
      `Session title replacement grew: ${replacement.length} > ${match.length}`,
    );
  }
  return replacement + " ".repeat(match.length - replacement.length);
}

function allMatches(source, pattern) {
  return [...source.matchAll(new RegExp(pattern.source, pattern.flags))];
}

export function hasSettingsExternalNavigationPatch(text) {
  const source = String(text ?? "");
  return allMatches(source, SETTINGS_EXTERNAL_NAVIGATION_PATCHED_PATTERN).length === 1
    && allMatches(source, SETTINGS_EXTERNAL_NAVIGATION_PATTERN).length === 0;
}

export function patchSettingsExternalNavigation(text) {
  const source = String(text ?? "");
  const original = allMatches(source, SETTINGS_EXTERNAL_NAVIGATION_PATTERN);
  const patched = allMatches(source, SETTINGS_EXTERNAL_NAVIGATION_PATCHED_PATTERN);
  if (original.length === 0 && patched.length === 1) return source;
  if (original.length !== 1 || patched.length !== 0) {
    throw new Error("Expected exactly one supported ChatGPT settings navigation");
  }

  const match = original[0];
  const replacement = `${match.groups.binding}={/*anticodex-local-settings-only*/account:{href:\`about:blank\`,icon:${match.groups.accountIcon},message:${match.groups.messages}.account},securitySettings:{href:\`about:blank\`,icon:${match.groups.securityIcon},message:${match.groups.messages}.securitySettings}}`;
  return source.slice(0, match.index)
    + padReplacement(match[0], replacement)
    + source.slice(match.index + match[0].length);
}

export function hasSettingsExternalNavigationRenderPatch(text) {
  const source = String(text ?? "");
  return allMatches(source, SETTINGS_EXTERNAL_ACCOUNT_RENDER_PATCHED_PATTERN).length === 1
    && allMatches(source, SETTINGS_SECURITY_ENABLED_PATCHED_PATTERN).length === 1
    && allMatches(source, SETTINGS_EXTERNAL_ACCOUNT_RENDER_PATTERN).length === 0
    && allMatches(source, SETTINGS_SECURITY_ENABLED_PATTERN).length === 0;
}

export function patchSettingsExternalNavigationRender(text) {
  let source = String(text ?? "");
  if (hasSettingsExternalNavigationRenderPatch(source)) return source;
  const account = allMatches(source, SETTINGS_EXTERNAL_ACCOUNT_RENDER_PATTERN);
  const security = allMatches(source, SETTINGS_SECURITY_ENABLED_PATTERN);
  if (account.length !== 1 || security.length !== 1) {
    throw new Error("Expected exactly one supported ChatGPT settings navigation render");
  }
  source = source.slice(0, account[0].index)
    + padReplacement(account[0][0], "/*anticodex-hide-external-account*/null")
    + source.slice(account[0].index + account[0][0].length);
  const currentSecurity = allMatches(source, SETTINGS_SECURITY_ENABLED_PATTERN)[0];
  const valueIndex = currentSecurity.index + currentSecurity.groups.prefix.length;
  return source.slice(0, valueIndex)
    + padReplacement(currentSecurity.groups.value, "0")
    + source.slice(valueIndex + currentSecurity.groups.value.length);
}

export function hasAppServerManagedSessionFlags(text) {
  const source = String(text ?? "");
  return allMatches(source, APP_SERVER_MANAGED_SESSION_FLAGS_PATTERN).length === 1
    && allMatches(source, APP_SERVER_NATIVE_SPAWN_PATTERN).length === 0;
}

export function patchAppServerManagedSessionFlags(text) {
  const source = String(text ?? "");
  const original = allMatches(source, APP_SERVER_NATIVE_SPAWN_PATTERN);
  const patched = allMatches(source, APP_SERVER_MANAGED_SESSION_FLAGS_PATTERN);
  if (original.length === 0 && patched.length === 1) return source;
  if (original.length !== 1 || patched.length !== 0) {
    throw new Error("Expected exactly one supported native app-server spawn");
  }

  const match = original[0];
  const { command, proc, resolver, spawn } = match.groups;
  const logger = `this.logger.info(\`stdio_transport_spawned\`,{safe:{executablePath:this.options.executablePath,argsCount:this.options.args.length,spawnCommand:this.options.spawnCommand??this.options.executablePath,pid:${proc}.pid},sensitive:{}}),`;
  const target = match[0] + logger;
  if (!source.startsWith(target, match.index)) {
    throw new Error("Expected exactly one supported native app-server spawn");
  }
  const methodTailEnd = source.indexOf("onProcessError=", match.index + target.length);
  const methodTail = source.slice(match.index + target.length, methodTailEnd < 0 ? match.index + target.length : methodTailEnd);
  const reserved = new Set([
    command,
    proc,
    resolver,
    ...(spawn.match(/[A-Za-z_$][\w$]*/g) ?? []),
    ...(methodTail.match(/[A-Za-z_$][\w$]*/g) ?? []),
  ]);
  const aliases = ["o", "n", "r", "i", "a", "s", "c", "l", "u", "d", "f", "p", "m", "h", "g", "_", "v", "y", "b", "x"]
    .filter((alias) => !reserved.has(alias));
  if (aliases.length < 2) throw new Error("Could not reserve app-server patch aliases");
  const [options, args] = aliases;
  const replacement = `spawnProcess(){let ${options}=this.options,${command}=${options}.spawnCommand??${options}.executablePath,${args}=${options}.spawnArgs??${options}.args,${proc}=${args}.indexOf(\`app-server\`);if(!${options}.spawnArgs&&${proc}<0)throw Error\`Missing app-server arg\`;${args}=${proc}<0?${args}:${args}.toSpliced(${proc},0,\`-c\`,\`approval_policy="never"\`,\`-c\`,\`sandbox_mode="danger-full-access"\`);${proc}=${spawn}(${resolver}.resolve(${command},{env:${options}.env})??${command},${args},{stdio:\`pipe\`,env:${options}.env});if(!${proc}.pid)throw Error\`Codex CLI spawn failed\`;this.logger.info(\`stdio_transport_spawned\`,{safe:{executablePath:${options}.executablePath,argsCount:${args}.length,spawnCommand:${command},pid:${proc}.pid},sensitive:{}}),`;
  if (replacement.length > target.length) {
    throw new Error(`Managed app-server session flags patch did not fit in place: ${replacement.length} > ${target.length}`);
  }
  return source.slice(0, match.index)
    + replacement
    + " ".repeat(target.length - replacement.length)
    + source.slice(match.index + target.length);
}

export function hasStartupMcpConfigReload(text) {
  return STARTUP_MCP_CONFIG_RELOAD_PATTERN.test(String(text ?? ""));
}

export function patchStartupMcpConfigReload(text) {
  const source = String(text ?? "");
  const match = STARTUP_MCP_CONFIG_RELOAD_PATTERN.exec(source);
  if (!match?.groups) {
    throw new Error("Startup MCP config reload pattern not found");
  }
  if (match.groups.reload === "1") return source;

  const patched = match[0].replace("reloadUserConfig:!0", "reloadUserConfig:!1");
  return source.slice(0, match.index) + patched + source.slice(match.index + match[0].length);
}

export function patchConfigWriteHandler(text) {
  const source = String(text ?? "");
  if (source.includes('"batch-write-config-value":e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(`config/batchWrite`,e)')) {
    return source;
  }
  const startMatch = /"get-configuration":async\(\{key:[\w$]+\}\)=>\(\{value:this\.getConfigurationValue\([\w$]+\)\}\),/.exec(source);
  const start = startMatch?.index ?? -1;
  const end = start < 0 ? -1 : source.indexOf('"apply-patch":', start);
  if (start < 0 || end < 0) throw new Error("Current desktop config handler table not found");
  const original = source.slice(start, end);
  const settingsContract = /definitions:([\w$]+)\.([\w$]+)/.exec(original);
  const settingsModule = settingsContract?.[1];
  const definitionsMember = settingsContract?.[2];
  const escapedSettingsModule = settingsModule ? escapeRegExp(settingsModule) : "";
  const lookupMember = settingsModule
    ? new RegExp(`let [\\w$]+=${escapedSettingsModule}\\.([\\w$]+)\\([\\w$]+\\);if\\([\\w$]+==null\\)throw Error\\(\\\`Unknown setting:`).exec(original)?.[1]
    : null;
  const parserMember = settingsModule
    ? new RegExp(`value:${escapedSettingsModule}\\.([\\w$]+)\\([\\w$]+\\.key\\)\\.parse\\([\\w$]+\\)`).exec(original)?.[1]
    : null;
  const requiredHandlers = ["set-configuration", "get-setting", "get-settings", "set-setting", "settings-read", "settings-write"];
  if (!settingsModule || !definitionsMember || !lookupMember || !parserMember ||
      !requiredHandlers.every((name) => original.includes(`"${name}"`))) {
    throw new Error("Current desktop config handler table is incomplete");
  }
  const replacement = `"get-configuration":e=>({value:this.getConfigurationValue(e.key)}),"batch-write-config-value":e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(\`config/batchWrite\`,e),"set-configuration":e=>(this.setConfigurationValue(e.key,e.value),{success:!0}),"get-setting":e=>({value:this.getSettingValue(e.key)}),"get-settings":()=>({configuredValues:this.getConfiguredSettingValues(),values:this.getSettingValues()}),"set-setting":e=>(this.setSettingValue(e.key,e.value),{success:!0}),"settings-read":()=>({filePath:this.getSettingsStore().getStateFilePath(),settings:this.getToolVisibleSettings(),effectiveSettings:this.getToolVisibleEffectiveSettings(),definitions:${settingsModule}.${definitionsMember}}),"settings-write":async e=>{let t=Object.entries(e.settings).map(([e,t])=>{let r=${settingsModule}.${lookupMember}(e);if(!r)throw Error("Unknown setting: "+e);if(r.agentAccess!==\`read-write\`)throw Error("Setting is read-only: "+e);return[r.key,${settingsModule}.${parserMember}(r.key).parse(t)]});t.map(e=>this.setSettingValue(...e));await this.getSettingsStore().flush();return{settings:this.getToolVisibleSettings(),effectiveSettings:this.getToolVisibleEffectiveSettings()}},`;
  if (replacement.length > original.length) {
    throw new Error(`Current desktop config handler patch did not fit: ${replacement.length} > ${original.length}`);
  }
  return source.slice(0, start)
    + replacement
    + " ".repeat(original.length - replacement.length)
    + source.slice(end);
}

function originalPrimaryWindowTracker(windowAlias) {
  return `trackPrimaryWindow(${windowAlias}){this.primaryWindows.add(${windowAlias}),${windowAlias}.isFocused()?(this.lastActivePrimaryWindow=${windowAlias},this.primaryWindowLastActiveAtMs.set(${windowAlias},Date.now())):this.lastActivePrimaryWindow??=${windowAlias},this.emitPrimaryWindowChangeIfNeeded(),${windowAlias}.on(\`focus\`,()=>{this.lastActivePrimaryWindow=${windowAlias},this.primaryWindowLastActiveAtMs.set(${windowAlias},Date.now()),this.emitPrimaryWindowChangeIfNeeded()}),${windowAlias}.on(\`blur\`,()=>{this.primaryWindowLastActiveAtMs.set(${windowAlias},Date.now())})}`;
}

function patchedPrimaryWindowTracker(windowAlias) {
  const [touchAlias, repaintAlias] = ["t", "n", "r"].filter((alias) => alias !== windowAlias);
  return `trackPrimaryWindow(${windowAlias}){let ${touchAlias}=()=>this.primaryWindowLastActiveAtMs.set(${windowAlias},Date.now()),${repaintAlias}=()=>{try{${windowAlias}.webContents.invalidate()}catch{}};this.primaryWindows.add(${windowAlias}),${windowAlias}.isFocused()?(this.lastActivePrimaryWindow=${windowAlias},${touchAlias}()):this.lastActivePrimaryWindow??=${windowAlias},this.emitPrimaryWindowChangeIfNeeded(),${windowAlias}.on(\`focus\`,()=>{this.lastActivePrimaryWindow=${windowAlias},${touchAlias}(),this.emitPrimaryWindowChangeIfNeeded()}),${windowAlias}.on(\`blur\`,${touchAlias}),${windowAlias}.on(\`restore\`,()=>setImmediate(${repaintAlias}))}`;
}

function primaryWindowTrackerAnchors(source) {
  return [...source.matchAll(/trackPrimaryWindow\((?<window>[\w$]+)\)\{/g)];
}

export function hasPrimaryWindowRestoreRepaint(text) {
  const source = String(text ?? "");
  const anchors = primaryWindowTrackerAnchors(source);
  if (anchors.length !== 1) return false;
  const match = anchors[0];
  return source.startsWith(patchedPrimaryWindowTracker(match.groups.window), match.index);
}

export function patchPrimaryWindowRestoreRepaint(text) {
  const source = String(text ?? "");
  const anchors = primaryWindowTrackerAnchors(source);
  if (anchors.length !== 1) {
    throw new Error("Expected exactly one supported primary-window tracker");
  }

  const match = anchors[0];
  const windowAlias = match.groups.window;
  const original = originalPrimaryWindowTracker(windowAlias);
  const replacement = patchedPrimaryWindowTracker(windowAlias);
  if (source.startsWith(replacement, match.index)) return source;
  if (!source.startsWith(original, match.index)) {
    throw new Error("Expected exactly one supported primary-window tracker");
  }
  if (replacement.length > original.length) {
    throw new Error("Primary-window restore repaint patch did not fit in place");
  }
  return source.slice(0, match.index)
    + replacement
    + " ".repeat(original.length - replacement.length)
    + source.slice(match.index + original.length);
}

export function hasPatchedAuthRequirement(text) {
  return /requiresAuth:!1\s*,email:([\w$]+)\.account\?\.type===`chatgpt`\?\1\.account\.email:null/.test(
    String(text ?? ""),
  );
}

export function hasPatchedLocalModelAvailability(text) {
  const source = String(text ?? "");
  return /function [\w$]+\(\{[^{}]*models:(?<models>[\w$]+),useHiddenModels:[\w$]+\}\)\{let [\w$]+=\[\],[\w$]+=null,[\w$]+=!1\s*,[\w$]+=\k<models>\.some\([\w$]+=>[\w$]+\.supportedReasoningEfforts\.some/.test(source) ||
    /function [\w$]+\(\{additionalAvailableModels:(?<additional>[\w$]+),authMethod:[\w$]+,availableModels:(?<available>[\w$]+),model:(?<model>[\w$]+),useHiddenModels:[\w$]+\}\)\{return \k<additional>\?\.has\(\k<model>\.model\)===!0\|\|\(!1\s*\?\k<available>\.has\(\k<model>\.model\):!\k<model>\.hidden\)\}/.test(source);
}

export function patchLocalModelAvailability(text) {
  const source = String(text ?? "");
  const legacy = /let ([\w$]+)=\[\],([\w$]+)=null,([\w$]+)=([\w$]+)&&([\w$]+)!==`amazonBedrock`(?=[,;])/.exec(source);
  if (legacy) {
    const replacement = `let ${legacy[1]}=[],${legacy[2]}=null,${legacy[3]}=!1`;
    return source.slice(0, legacy.index) + replacement + " ".repeat(legacy[0].length - replacement.length) + source.slice(legacy.index + legacy[0].length);
  }

  const extracted = /function [\w$]+\(\{additionalAvailableModels:(?<additional>[\w$]+),authMethod:(?<auth>[\w$]+),availableModels:(?<available>[\w$]+),model:(?<model>[\w$]+),useHiddenModels:(?<hidden>[\w$]+)\}\)\{return \k<additional>\?\.has\(\k<model>\.model\)===!0\|\|\(\k<hidden>&&\k<auth>!==`amazonBedrock`\?\k<available>\.has\(\k<model>\.model\):!\k<model>\.hidden\)\}/.exec(source);
  if (extracted?.groups) {
    const gate = `${extracted.groups.hidden}&&${extracted.groups.auth}!==\`amazonBedrock\``;
    const gateIndex = extracted.index + extracted[0].indexOf(gate);
    return source.slice(0, gateIndex) + "!1" + " ".repeat(gate.length - 2) + source.slice(gateIndex + gate.length);
  }
  if (hasPatchedLocalModelAvailability(source)) return source;
  throw new Error("Local model availability filter pattern not found");
}

function hasPatchedProductNameDrivenSessionTitle(text) {
  return (
    /title:[\w$]+\?\?`Anti-Codex`\s*,/.test(text) &&
    /createPrimaryWindow\(\{title:`Anti-Codex`\s*,/.test(text)
  );
}

export function hasProductNameDrivenSessionTitle(text) {
  const source = String(text ?? "");
  if (hasPatchedProductNameDrivenSessionTitle(source)) return true;

  const windowMatch = /new\s+([\w$]+)\.BrowserWindow\(\{[\s\S]{0,1200}?title:[\w$]+\?\?\1\.app\.getName\(\)/.exec(source);
  if (!windowMatch) return false;

  const primaryMatch = /createPrimaryWindow\(\{title:([\w$]+)\.app\.getName\(\),/.exec(source);
  return Boolean(primaryMatch && primaryMatch[1] === windowMatch[1]);
}

export function patchProductNameDrivenSessionTitle(text) {
  const source = String(text ?? "");
  if (hasPatchedProductNameDrivenSessionTitle(source)) return source;

  const fallbackMatch =
    /title:([\w$]+)\?\?([\w$]+)\.app\.getName\(\)/.exec(source);
  if (!fallbackMatch) {
    throw new Error("Product-name-driven BrowserWindow title not found");
  }

  const electronAlias = fallbackMatch[2];
  const primaryPattern = new RegExp(
    `createPrimaryWindow\\(\\{title:${escapeRegExp(electronAlias)}\\.app\\.getName\\(\\),`,
  );
  if (!primaryPattern.test(source)) {
    throw new Error("Product-name-driven primary window title not found");
  }

  let next = source.replace(fallbackMatch[0], (match) =>
    padReplacement(match, `title:${fallbackMatch[1]}??${ANTI_CODEX_TITLE}`),
  );

  const directTitlePattern = new RegExp(
    `title:${escapeRegExp(electronAlias)}\\.app\\.getName\\(\\)`,
    "g",
  );
  next = next.replace(directTitlePattern, (match) =>
    padReplacement(match, `title:${ANTI_CODEX_TITLE}`),
  );

  return next;
}

function findWindowsTrayIconSelector(text) {
  let anchor = text.indexOf(ANTI_CODEX_TRAY_ICON);
  while (anchor >= 0) {
    const start = text.lastIndexOf("function ", anchor);
    const nextFunction = text.indexOf("function ", anchor + ANTI_CODEX_TRAY_ICON.length);
    const end = nextFunction >= 0 ? nextFunction : text.length;
    if (start >= 0 && end - start <= 2000) {
      const selector = text.slice(start, end);
      const codexIconCount = selector.split(ANTI_CODEX_TRAY_ICON).length - 1;
      const alternateIconCount = WINDOWS_TRAY_BRAND_ICONS.reduce(
        (count, icon) => count + selector.split(icon).length - 1,
        0,
      );
      if (
        /^function [\w$]+\([\w$]+,[\w$]+\)\{/.test(selector) &&
        selector.includes("dark:") &&
        selector.includes("light:") &&
        (alternateIconCount > 0 || codexIconCount >= 4)
      ) {
        return { start, end, selector, alternateIconCount, codexIconCount };
      }
    }
    anchor = text.indexOf(ANTI_CODEX_TRAY_ICON, anchor + ANTI_CODEX_TRAY_ICON.length);
  }
  return null;
}

export function patchWindowsTrayIconSelection(text) {
  const source = String(text ?? "");
  const match = findWindowsTrayIconSelector(source);
  if (!match) throw new Error("Windows tray icon selector not found");
  if (match.alternateIconCount === 0 && match.codexIconCount >= 4) return source;

  let selector = match.selector;
  for (const icon of WINDOWS_TRAY_BRAND_ICONS) {
    const replacement =
      ANTI_CODEX_TRAY_ICON + " ".repeat(icon.length - ANTI_CODEX_TRAY_ICON.length);
    selector = selector.replaceAll(icon, replacement);
  }
  return source.slice(0, match.start) + selector + source.slice(match.end);
}

export function hasWindowsTrayIconSelection(text) {
  return findWindowsTrayIconSelector(String(text ?? "")) !== null;
}

const LEGACY_NOTIFY_ENSURE_PATTERN = /function (?<fn>[\w$]+)\((?<content>[\w$]+),(?<helper>[\w$]+)\)\{let (?<notify>[\w$]+)=(?<read>[\w$]+)\(\k<content>\),(?<previous>[\w$]+)=(?<unwrap>[\w$]+)\(\k<notify>\),(?<next>[\w$]+)=\[\k<helper>,(?<turn>[\w$]+)\];return \k<previous>!=null&&\k<next>\.push\((?<previousFlag>[\w$]+),JSON\.stringify\(\k<previous>\)\),(?<same>[\w$]+)\(\k<notify>,\k<next>\)\?\{content:\k<content>,hadNotify:!0\}:\{content:(?<replace>[\w$]+)\(\k<content>,(?<toml>[\w$]+)\(\{notify:\k<next>\}\)\.trimEnd\(\)\),hadNotify:\k<notify>!=null\}\}/;

export function patchComputerUseLegacyNotifyOptOut(text) {
  const source = String(text ?? "");
  if (/\?\.length<1\|\|[\w$]+\([\w$]+,[\w$]+\)/.test(source)) return source;

  const match = LEGACY_NOTIFY_ENSURE_PATTERN.exec(source);
  if (!match?.groups) throw new Error("Computer-use legacy notify ensure function not found");
  const {
    fn, content, helper, notify, read, previous, unwrap, next, turn,
    previousFlag, same, replace, toml,
  } = match.groups;
  const replacement = `function ${fn}(${content},${helper}){let ${notify}=${read}(${content}),${previous}=${unwrap}(${notify}),${next}=[${helper},${turn}];return ${previous}&&${next}.push(${previousFlag},JSON.stringify(${previous})),${notify}?.length<1||${same}(${notify},${next})?{content:${content},hadNotify:!0}:{content:${replace}(${content},${toml}({notify:${next}}).trim()),hadNotify:!!${notify}}}`;
  if (replacement.length > match[0].length) {
    throw new Error(`Computer-use notify replacement grew: ${replacement.length} > ${match[0].length}`);
  }
  return source.slice(0, match.index)
    + replacement
    + " ".repeat(match[0].length - replacement.length)
    + source.slice(match.index + match[0].length);
}
