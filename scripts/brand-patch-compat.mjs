import { createHash } from "node:crypto";

const ANTI_CODEX_TITLE = "`Anti-Codex`";
const ANTI_CODEX_TRAY_ICON = "`codex-tray.ico`";
const OFFICIAL_CODEX_TRAY_GUID = "e5768d8b-6936-4f45-b1ad-4c5fb414cb35";
const ANTI_CODEX_TRAY_GUID = "a91c0de5-7b42-4fa8-9d31-2e6c5b7048f3";
const WINDOWS_TRAY_BRAND_ICONS = [
  "`icon-agent.ico`",
  "`chatgpt-tray-dark.ico`",
  "`chatgpt-tray-light.ico`",
];

const STARTUP_MCP_CONFIG_RELOAD_PATTERN =
  /await [\w$]+\.sendAppServerRequest\(`config\/batchWrite`,\{edits:[\w$]+\([\w$]+\),expectedVersion:null,filePath:null,reloadUserConfig:!(?<reload>[01])\}\)/;
const STARTUP_MCP_CONFIG_RELOAD_DEFAULT_PATTERN =
  /async function [\w$]+\(\{(?=[^{}]{0,1600}\bappServerConnection:(?<connection>[\w$]+))(?=[^{}]{0,1600}\breloadUserConfig:(?<reload>[\w$]+)=!(?<value>[01]))[^{}]{0,1600}\}\)\{[\s\S]{0,20000}?await \k<connection>\.sendAppServerRequest\(`config\/batchWrite`,\{edits:[\w$]+,expectedVersion:null,filePath:null,reloadUserConfig:\k<reload>\}\)/;
const SETTINGS_EXTERNAL_NAVIGATION_PATTERN =
  /(?<binding>[\w$]+)=\{account:\{href:`https:\/\/chatgpt\.com\/#settings`,icon:(?<accountIcon>[\w$]+),message:(?<messages>[\w$]+)\.account\},securitySettings:\{href:`https:\/\/chatgpt\.com\/open-security-settings`,icon:(?<securityIcon>[\w$]+),message:\k<messages>\.securitySettings\}\}/g;
const SETTINGS_EXTERNAL_NAVIGATION_PATCHED_PATTERN =
  /[\w$]+=\{\/\*anticodex-local-settings-only\*\/account:\{href:`about:blank`,icon:[\w$]+,message:[\w$]+\.account\},securitySettings:\{href:`about:blank`,icon:[\w$]+,message:[\w$]+\.securitySettings\}\}/g;
const SETTINGS_EXTERNAL_ACCOUNT_RENDER_PATTERN =
  /[\w$]+\.key===\([\w$]+\?`personal`:`settings`\)\?\(0,[\w$]+\.jsx\)\([\w$]+,\{canCollapse:[\w$]+,externalTooltip:[\w$]+,hideLabels:[\w$]+\}\):null/g;
const SETTINGS_SECURITY_ENABLED_PATTERN =
  /(?<prefix>\(0,[\w$]+\.jsx\)\([\w$]+,\{\.\.\.[\w$]+,securitySettingsEnabled:)(?<value>[A-Za-z_$][\w$]*)(?<suffix>(?:,showMiniPetsLabel:[A-Za-z_$][\w$]*)?\}\))/g;
const SETTINGS_SECURITY_ENABLED_PATCHED_PATTERN =
  /\(0,[\w$]+\.jsx\)\([\w$]+,\{\.\.\.[\w$]+,securitySettingsEnabled:0\s*(?:,showMiniPetsLabel:[A-Za-z_$][\w$]*)?\}\)/g;
const SETTINGS_EXTERNAL_ACCOUNT_RENDER_PATCHED_PATTERN = /\/\*anticodex-hide-external-account\*\/null/g;
const APP_SERVER_NATIVE_SPAWN_PATTERN =
  /spawnProcess\(\)\{let (?<command>[\w$]+)=this\.options\.spawnCommand\?\?this\.options\.executablePath,(?<proc>[\w$]+)=(?<spawn>(?:\(0,[\w$]+\.spawn\)|[\w$]+\.spawn))\((?<resolver>[\w$]+)\.resolve\(\k<command>,\{env:this\.options\.env\}\)\?\?\k<command>,this\.options\.spawnArgs\?\?this\.options\.args,\{stdio:\[`pipe`,`pipe`,`pipe`\],env:this\.options\.env(?<cwd>,cwd:this\.options\.cwd)?\}\);if\(!\k<proc>\.pid\)throw Error\(`Failed to spawn Codex CLI at \$\{this\.options\.executablePath\}`\);/g;
const APP_SERVER_RESOLVED_NATIVE_SPAWN_PATTERN =
  /spawnProcess\(\)\{let (?<command>[\w$]+)=this\.options\.spawnCommand\?\?this\.options\.executablePath,(?<resolved>[\w$]+)=(?<resolver>[\w$]+)\.resolve\(\k<command>,\{env:this\.options\.env\}\)\?\?\k<command>,(?<proc>[\w$]+)=(?<spawn>(?:\(0,[\w$]+\.spawn\)|[\w$]+\.spawn))\(\k<resolved>,this\.options\.spawnArgs\?\?this\.options\.args,\{stdio:\[`pipe`,`pipe`,`pipe`\],env:this\.options\.env(?<cwd>,cwd:this\.options\.cwd)?\}\);if\(!\k<proc>\.pid\)throw Error\(`Failed to spawn Codex CLI at \$\{this\.options\.executablePath\}`\);let (?<coreRoot>[\w$]+)=(?<coreResolver>[\w$]+)\(\);this\.logger\.info\(`stdio_transport_spawned`,\{safe:\{executablePath:this\.options\.executablePath,argsCount:this\.options\.args\.length,coreRuntimeInUse:process\.platform===`win32`&&\k<coreRoot>!=null&&\k<resolved>===\(0,(?<pathModule>[\w$]+)\.join\)\(\k<coreRoot>,`codex\.exe`\),spawnCommand:this\.options\.spawnCommand\?\?this\.options\.executablePath,pid:\k<proc>\.pid\},sensitive:\{\}\}\),/g;
const APP_SERVER_MANAGED_SESSION_FLAGS_PATTERN =
  /spawnProcess\(\)\{let [\w$]+=this\.options,[\s\S]{0,600}?approval_policy="never"[\s\S]{0,200}?sandbox_mode="danger-full-access"[\s\S]{0,600}?Error`Codex CLI spawn failed`;/g;
const IDENTIFIER_SOURCE = String.raw`[A-Za-z_$][\w$]*`;
const CRASH_RECOVERY_REGION_PATTERN = new RegExp(
  String.raw`function ${IDENTIFIER_SOURCE}\(${IDENTIFIER_SOURCE}\)\{[\s\S]{0,2500}?id:\`appServerCrash\.title\`,defaultMessage:\`\{appName\} stopped unexpectedly\`[\s\S]{0,2500}?id:\`appServerCrash\.description\`,defaultMessage:\`Restart \{appName\} to continue\. If the problem persists, check your configuration or visit the \{documentationLink\}\`[\s\S]{0,5000}?id:\`appServerCrash\.restart\`,defaultMessage:\`Restart\`[\s\S]{0,3000}?\}function ${IDENTIFIER_SOURCE}\(\)\{return ${IDENTIFIER_SOURCE}\.dispatchMessage\(\`open-config-toml\`,\{\}\)\}`,
  "g",
);
const CRASH_TITLE_ORIGINAL_PATTERN =
  /id:`appServerCrash\.title`,defaultMessage:`\{appName\} stopped unexpectedly`,description:`[^`]+`,values:\{appName:[A-Za-z_$][\w$]*\}/g;
const CRASH_TITLE_PATCHED_PATTERN =
  /id:`appServerCrash\.title`,defaultMessage:`\{appName\} stopped unexpectedly`,values:\{appName:`Anti-Codex`\}/g;
const CRASH_DESCRIPTION_ORIGINAL_PATTERN =
  /id:`appServerCrash\.description`,defaultMessage:`Restart \{appName\} to continue\. If the problem persists, check your configuration or visit the \{documentationLink\}`,description:`[^`]+`,values:\{appName:[A-Za-z_$][\w$]*,documentationLink:/g;
const CRASH_DESCRIPTION_PATCHED_PATTERN =
  /id:`appServerCrash\.description`,defaultMessage:`Restart \{appName\} to continue\. If the problem persists, check your configuration or visit the \{documentationLink\}`,values:\{appName:`Anti-Codex`,documentationLink:/g;
const CRASH_RECOVERY_V2_REGION_PATTERN = new RegExp(
  String.raw`function ${IDENTIFIER_SOURCE}\(${IDENTIFIER_SOURCE}\)\{[\s\S]{0,9000}?id:\`appServerCrash\.recoveryTitle\`[\s\S]{0,9000}?id:\`appServerCrash\.configurationRecoveryDescription\`[\s\S]{0,9000}?id:\`appServerCrash\.recoveryDescription\`[\s\S]{0,9000}?id:\`appServerCrash\.restartChatGPT\`[\s\S]{0,9000}?hideUnavailable:!0[\s\S]{0,4000}?\}function ${IDENTIFIER_SOURCE}\(\)\{return ${IDENTIFIER_SOURCE}\.dispatchMessage\(\`open-config-toml\`,\{\}\)\}`,
  "g",
);
const CRASH_RECOVERY_V2_UPDATE_SLOT_PATTERN = new RegExp(
  String.raw`let (?<slot>${IDENTIFIER_SOURCE});[\s\S]{0,360}?\k<slot>=\(0,(?<jsx>${IDENTIFIER_SOURCE})\.jsx\)\(\k<jsx>\.Fragment,\{children:\(0,\k<jsx>\.jsx\)\((?<updateFn>${IDENTIFIER_SOURCE}),\{hideUnavailable:!0\}\)\}\)`,
  "g",
);
const CRASH_RECOVERY_V3_REGION_PATTERN = new RegExp(
  String.raw`function ${IDENTIFIER_SOURCE}\(${IDENTIFIER_SOURCE}\)\{[\s\S]{0,14000}?id:\`appServerCrash\.configurationRecoveryDescription\`[\s\S]{0,5000}?id:\`appServerCrash\.recoveryDescription\`[\s\S]{0,5000}?id:\`appServerCrash\.restartChatGPT\`[\s\S]{0,6000}?hideUnavailable:!0[\s\S]{0,3000}?(?:/\*anticodex-crash-recovery-actions-v3\*/)?children:\[${IDENTIFIER_SOURCE}(?:,${IDENTIFIER_SOURCE}){2,3}\][\s\S]{0,3000}?\}function ${IDENTIFIER_SOURCE}\(\)\{return ${IDENTIFIER_SOURCE}\.dispatchMessage\(\`open-config-toml\`,\{\}\)\}`,
  "g",
);
const CRASH_RECOVERY_V3_UPDATE_SLOT_PATTERN = new RegExp(
  String.raw`let (?<slot>${IDENTIFIER_SOURCE});(?:(?!;let ${IDENTIFIER_SOURCE};)[\s\S]){0,900}?\b\k<slot>=(?:(?!;let ${IDENTIFIER_SOURCE};)[\s\S]){0,700}?\(0,${IDENTIFIER_SOURCE}\.jsx\)\((?<updateFn>${IDENTIFIER_SOURCE}),\{hideUnavailable:!0\}\)(?:(?!;let ${IDENTIFIER_SOURCE};)[\s\S]){0,300}?(?=;let ${IDENTIFIER_SOURCE};)`,
  "g",
);
const CRASH_RECOVERY_V2_TITLE_ORIGINAL_PATTERN =
  /id:`appServerCrash\.recoveryTitle`,defaultMessage:`ChatGPT hit a snag`,description:`[^`]+`/g;
const CRASH_RECOVERY_V2_TITLE_PATCHED_PATTERN =
  /id:`appServerCrash\.recoveryTitle`,defaultMessage:`Anti-Codex hit a snag`(?=\s*\})/g;
const CRASH_RECOVERY_V2_CONFIG_ORIGINAL_PATTERN =
  /id:`appServerCrash\.configurationRecoveryDescription`,defaultMessage:`ChatGPT couldn't load your configuration\. Review it, then restart to try again\.`,description:`[^`]+`/g;
const CRASH_RECOVERY_V2_CONFIG_PATCHED_PATTERN =
  /id:`appServerCrash\.configurationRecoveryDescription`,defaultMessage:`Anti-Codex couldn't load your configuration\. Review it, then restart to try again\.`(?=\})/g;
const CRASH_RECOVERY_V2_DESCRIPTION_ORIGINAL_PATTERN =
  /id:`appServerCrash\.recoveryDescription`,defaultMessage:`Something went wrong\. Restart ChatGPT to try again\.`,description:`[^`]+`/g;
const CRASH_RECOVERY_V2_DESCRIPTION_PATCHED_PATTERN =
  /id:`appServerCrash\.recoveryDescription`,defaultMessage:`Something went wrong\. Restart Anti-Codex to try again\.`(?=\})/g;
const CRASH_RECOVERY_V2_RESTART_ORIGINAL_PATTERN =
  /id:`appServerCrash\.restartChatGPT`,defaultMessage:`Restart ChatGPT`,description:`[^`]+`/g;
const CRASH_RECOVERY_V2_RESTART_PATCHED_PATTERN =
  /id:`appServerCrash\.restartChatGPT`,defaultMessage:`Restart Anti-Codex`(?=\})/g;
const CRASH_UPDATE_SLOT_PATTERN = new RegExp(
  String.raw`let (?<slot>${IDENTIFIER_SOURCE});[\s\S]{0,260}?\b\k<slot>=\(0,(?<jsx>${IDENTIFIER_SOURCE})\.jsx\)\(\k<jsx>\.Fragment,\{children:\(0,\k<jsx>\.jsx\)\((?<updateFn>${IDENTIFIER_SOURCE}),\{\}\)\}\)`,
  "g",
);
const CRASH_ACTIONS_PATTERN = new RegExp(
  String.raw`(?<marker>/\*anticodex-crash-recovery-actions\*/)?children:\[(?<items>${IDENTIFIER_SOURCE}(?:,${IDENTIFIER_SOURCE}){1,2})\]`,
  "g",
);
const GENERIC_ERROR_REGION_PATTERN = new RegExp(
  String.raw`function ${IDENTIFIER_SOURCE}\(${IDENTIFIER_SOURCE}\)\{(?:(?!function ${IDENTIFIER_SOURCE}\()[\s\S]){0,1800}?id:\`codex\.errorBoundary\.genericError\`,defaultMessage:\`Oops, an error has occurred\`(?:(?!function ${IDENTIFIER_SOURCE}\()[\s\S]){0,1800}?id:\`codex\.errorBoundary\.goHome\`,defaultMessage:\`Try again\`(?:(?!function ${IDENTIFIER_SOURCE}\()[\s\S]){0,1800}?\}var ${IDENTIFIER_SOURCE}(?:,${IDENTIFIER_SOURCE}){2,}`,
  "g",
);
const GENERIC_ERROR_TITLE_ORIGINAL_PATTERN =
  /id:`codex\.errorBoundary\.genericError`,defaultMessage:`Oops, an error has occurred`,description:`Generic error message shown when the extension webview fails`/g;
const GENERIC_ERROR_TITLE_PATCHED_PATTERN =
  /id:`codex\.errorBoundary\.genericError`,defaultMessage:`Oops, an error has occurred`(?=\})/g;
const GENERIC_ERROR_RETRY_ORIGINAL_PATTERN =
  /id:`codex\.errorBoundary\.goHome`,defaultMessage:`Try again`,description:`Button label to navigate to the home page after an error`/g;
const GENERIC_ERROR_RETRY_PATCHED_PATTERN =
  /id:`codex\.errorBoundary\.goHome`,defaultMessage:`Try again`(?=\})/g;
const MODERN_CRASH_TITLE_PATTERN =
  /id:`appServerCrash\.recoveryTitle`,defaultMessage:`ChatGPT hit a snag`,description:`[^`]+`/;
const MODERN_CRASH_TITLE_PATCHED_PATTERN =
  /id:`appServerCrash\.recoveryTitle`,defaultMessage:`Anti-Codex hit a snag`/;

function isModernCrashRecoveryPage(text) {
  const source = String(text ?? "");
  return source.includes("Try again or update ChatGPT if this keeps happening") &&
    source.includes("id:`appServerCrash.feedbackGuidance`");
}

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

export function patchAppRouteGate(text) {
  const source = String(text ?? "");
  if (source.includes("/*anticodex-app-route*/")) return source;

  const currentRouteState = /(?:let|,)(?<target>[A-Za-z_$][\w$]*)=oMa\([\s\S]{0,8000}?\);(?<effect>\(0,[A-Za-z_$][\w$]*\.useEffect\)\(\(\)=>\{if\(!\k<target>\)return;)/;
  const currentRouteMatch = currentRouteState.exec(source);
  if (currentRouteMatch?.groups) {
    const separator = currentRouteMatch[0].startsWith(",") ? ";" : "";
    const replacement = `${separator}/*anticodex-app-route*/let ${currentRouteMatch.groups.target}=\`app\`;${currentRouteMatch.groups.effect}`;
    return source.slice(0, currentRouteMatch.index)
      + padReplacement(currentRouteMatch[0], replacement)
      + source.slice(currentRouteMatch.index + currentRouteMatch[0].length);
  }

  const modernStart = source.indexOf("function dui({auth:e,codexFeatureAccess:t,backendOnboardingCompleted:n,");
  if (modernStart >= 0) {
    const modernHeaderEnd = source.indexOf("}){return", modernStart);
    const modernEnd = source.indexOf("}function fui(", modernHeaderEnd);
    if (modernHeaderEnd > modernStart && modernEnd > modernHeaderEnd) {
      const old = source.slice(modernStart, modernEnd + 1);
      const params = source.slice(modernStart + "function dui({".length, modernHeaderEnd);
      const replacement = `/*anticodex-app-route*/function dui({${params}}){return\`app\`}`;
      return source.slice(0, modernStart) + padReplacement(old, replacement) + source.slice(modernEnd + 1);
    }
  }

  const loginMarker = "to:`/login`,replace:!0";
  const markerIndex = source.indexOf(loginMarker);
  if (markerIndex >= 0) {
    if (source.lastIndexOf("if(!0){", markerIndex) > source.lastIndexOf("if(", markerIndex)) return source;
    const gateStart = source.lastIndexOf("if(", markerIndex);
    const gateEnd = source.indexOf("{", gateStart) + 1;
    const search = source.slice(gateStart, gateEnd);
    if (gateStart >= 0 && gateEnd > gateStart && /^if\([\w$]+\|\|![\w$]+\)\{$/.test(search)) {
      return source.slice(0, gateStart)
        + padReplacement(search, "if(!0){")
        + source.slice(gateEnd);
    }
  }

  if ((source.includes("function XS(){") && source.includes("function ZS("))) {
    return source;
  }

  const currentPattern = new RegExp(
    String.raw`(?<target>${IDENTIFIER_SOURCE})=(?<gate>${IDENTIFIER_SOURCE})\(\{auth:${IDENTIFIER_SOURCE},codexFeatureAccess:${IDENTIFIER_SOURCE},[^{}]{0,1400}?workspaceRootsIsLoading:[^{};]{1,220}\}\)(?=;\(0,${IDENTIFIER_SOURCE}\.useEffect\)\(\(\)=>\{if\(!\k<target>\)return;)`,
    "g",
  );
  const matches = allMatches(source, currentPattern);
  if (matches.length !== 1) throw new Error("Expected exactly one supported webview app route gate");
  const match = matches[0];
  if (!source.includes("electron-set-window-mode") ||
      !source.includes(`{target:${match.groups.target},path:`)) {
    throw new Error("Expected exactly one supported webview app route gate");
  }
  const replacement = `/*anticodex-app-route*/${match.groups.target}=\`app\``;
  return source.slice(0, match.index)
    + padReplacement(match[0], replacement)
    + source.slice(match.index + match[0].length);
}

export function patchWebviewHtmlTitle(text) {
  const source = String(text ?? "");
  const replacement = "<title>Anti-Codex</title>";
  if (source.includes(replacement)) return source;
  const current = ["<title>Codex</title>", "<title>ChatGPT</title>"]
    .find((title) => source.includes(title));
  if (!current) throw new Error("webview HTML title pattern not found");

  let next = source.replace(current, replacement);
  let extra = next.length - source.length;
  while (extra > 0) {
    let changed = false;
    next = next.replace(/ {2,}/, (match) => {
      if (extra <= 0) return match;
      const remove = Math.min(extra, match.length - 1);
      extra -= remove;
      changed = true;
      return " ".repeat(match.length - remove);
    });
    if (!changed) break;
  }
  if (extra > 0 || next.length !== source.length) {
    throw new Error("webview HTML title size changed after branding patch");
  }
  return next;
}

export function patchElectronProductName(text) {
  const source = String(text ?? "");
  const originalPattern = new RegExp(
    String.raw`function (?<fn>${IDENTIFIER_SOURCE})\((?<arg>${IDENTIFIER_SOURCE})\)\{let (?<flavor>${IDENTIFIER_SOURCE})=(?<resolve>${IDENTIFIER_SOURCE})\(\k<arg>\);return \k<flavor>==null\?\`ChatGPT\`:\`ChatGPT \(\$\{\k<flavor>\}\)\`\}`,
    "g",
  );
  const patchedPattern = new RegExp(
    String.raw`function (?<fn>${IDENTIFIER_SOURCE})\((?<arg>${IDENTIFIER_SOURCE})\)\{let (?<flavor>${IDENTIFIER_SOURCE})=(?<resolve>${IDENTIFIER_SOURCE})\(\k<arg>\);return \k<flavor>\?\`Anti-Codex \(\$\{\k<flavor>\}\)\`:\`Anti-Codex\`\}`,
    "g",
  );
  const originals = allMatches(source, originalPattern);
  const patched = allMatches(source, patchedPattern);
  if (originals.length === 0 && patched.length === 1) return source;
  if (originals.length !== 1 || patched.length !== 0) {
    throw new Error("Expected exactly one supported Electron product-name mapper");
  }
  const match = originals[0];
  const replacement = `function ${match.groups.fn}(${match.groups.arg}){let ${match.groups.flavor}=${match.groups.resolve}(${match.groups.arg});return ${match.groups.flavor}?\`Anti-Codex ($\{${match.groups.flavor}})\`:\`Anti-Codex\`}`;
  return source.slice(0, match.index)
    + padReplacement(match[0], replacement)
    + source.slice(match.index + match[0].length);
}

function exactlyOne(source, pattern) {
  const matches = allMatches(source, pattern);
  return matches.length === 1 ? matches[0] : null;
}

function requireSupportedControlAssignments(region, variable, role, memoPattern) {
  const name = escapeRegExp(variable);
  const declaration = exactlyOne(region, new RegExp(String.raw`\blet ${name};`, "g"));
  if (!declaration) {
    throw new Error(`Anti-Codex ${role} control declaration is missing or ambiguous`);
  }
  const afterDeclaration = declaration.index + declaration[0].length;
  const statementTerminator = region.indexOf(";", afterDeclaration);
  const nextDeclarationPattern = new RegExp(String.raw`\blet ${IDENTIFIER_SOURCE};`, "g");
  nextDeclarationPattern.lastIndex = afterDeclaration;
  const nextDeclaration = nextDeclarationPattern.exec(region);
  const segmentEnd = statementTerminator >= 0
    ? statementTerminator + 1
    : (nextDeclaration?.index ?? region.length);
  const segment = region.slice(declaration.index, segmentEnd);
  const target = String.raw`(?<![.\w$])${name}(?![\w$])`;
  const writePattern = new RegExp(
    String.raw`(?:${target}\s*(?:\+\+|--|\*\*=|>>>=|<<=|>>=|&&=|\|\|=|\?\?=|[+\-*/%&|^]=|=(?!=|>))|(?:\+\+|--)\s*${target}|(?<![.\w$])\[[^\[\];]{0,800}?${target}[^\[\];]{0,800}?\]\s*=|(?<![.\w$])\{[^{};]{0,800}?${target}[^{};]{0,800}?\}\s*=|\bfor\s*\([^;)]{0,500}?${target}[^;)]{0,500}?\s+(?:of|in)\b)`,
    "g",
  );
  const writes = allMatches(region, writePattern);
  const segmentWrites = allMatches(segment, writePattern);
  if (writes.length === 1 && segmentWrites.length === 1) return;
  if (writes.length !== 2 || segmentWrites.length !== 2) {
    throw new Error(`Anti-Codex ${role} control has an unsupported assignment count`);
  }
  if (!(memoPattern instanceof RegExp) || !exactlyOne(segment, memoPattern)) {
    throw new Error(`Anti-Codex ${role} control cache binding is not the supported memo branch`);
  }
}

function requireSupportedUpdaterComponent(source, updateFunctionName) {
  const updateFunctionPattern = new RegExp(`function ${escapeRegExp(updateFunctionName)}\\(`, "g");
  const updateFunctionMatches = allMatches(source, updateFunctionPattern);
  if (updateFunctionMatches.length !== 1) {
    throw new Error("Expected exactly one supported Anti-Codex crash recovery updater component");
  }
  const updateStart = updateFunctionMatches[0].index;
  const nextFunction = new RegExp(`function ${IDENTIFIER_SOURCE}\\(`, "g");
  nextFunction.lastIndex = updateStart + updateFunctionMatches[0][0].length;
  const nextFunctionMatch = nextFunction.exec(source);
  const updateRegion = source.slice(updateStart, nextFunctionMatch?.index ?? source.length);
  const checkCount = (updateRegion.match(/appUpdates\?\.checkForUpdates\(\)/g) ?? []).length;
  const installCount = (updateRegion.match(/appUpdates\?\.installUpdate\(\)/g) ?? []).length;
  const legacy = (updateRegion.match(/appUpdate\.recovery\.updateCodex/g) ?? []).length >= 1
    && checkCount === 1 && installCount === 1;
  const latestHandler = /(?<state>[\w$]+)===`idle`&&[\w$]+!==`macOS`\?(?<api>[\w$]+)\.appUpdates\?\.checkForUpdates\(\):\k<api>\.appUpdates\?\.installUpdate\(\)/.exec(updateRegion);
  const latest = (updateRegion.match(/id:`appUpdate\.recovery\.updateChatGPT`/g) ?? []).length === 1
    && (updateRegion.match(/defaultMessage:`Update ChatGPT`/g) ?? []).length === 1
    && Boolean(latestHandler)
    && updateRegion.includes(`switch(${latestHandler?.groups?.state}){case\`idle\`:case\`ready\``)
    && checkCount === 1 && installCount === 1;
  if (!legacy && !latest) {
    throw new Error("Anti-Codex crash recovery update slot is not backed by the supported upstream updater");
  }
}

function requireAppCrashActionRoles(source, region, updateSlot, actionMatch) {
  const items = actionMatch.groups.items.split(",");
  const markerPresent = Boolean(actionMatch.groups.marker);
  const originalActions = !markerPresent && items.length === 3 && items[0] === updateSlot;
  const patchedActions = markerPresent && items.length === 2;
  if (!originalActions && !patchedActions) {
    throw new Error("Anti-Codex crash recovery action row has an unsupported shape");
  }
  const configVariable = items.at(-2);
  const restartVariable = items.at(-1);
  const configPattern = new RegExp(
    String.raw`\b${escapeRegExp(configVariable)}=[^;]{0,700}?onClick:(?<openConfig>${IDENTIFIER_SOURCE})[^;]{0,500}?id:\`loadingPage\.openConfigToml\``,
    "g",
  );
  const configMatch = exactlyOne(region, configPattern);
  if (!configMatch) {
    throw new Error("Anti-Codex crash recovery action row does not retain the config control");
  }
  const openConfigFunction = escapeRegExp(configMatch.groups.openConfig);
  const configName = escapeRegExp(configVariable);
  const dependencySource = String.raw`${IDENTIFIER_SOURCE}(?:\.${IDENTIFIER_SOURCE})*`;
  const configMemoPattern = new RegExp(
    String.raw`^let ${configName};(?<cache>${IDENTIFIER_SOURCE})\[(?<dependencyIndex>\d+)\]===(?<dependency>${dependencySource})\?${configName}=\k<cache>\[(?<valueIndex>\d+)\]:\(${configName}=(?:(?!=>|function)[\s\S]){1,900}?onClick:${openConfigFunction}(?:(?!=>|function)[\s\S]){1,700}?id:\`loadingPage\.openConfigToml\`(?:(?!=>|function)[\s\S]){0,400}?,\k<cache>\[\k<dependencyIndex>\]=\k<dependency>,\k<cache>\[\k<valueIndex>\]=${configName}\);?$`,
    "g",
  );
  requireSupportedControlAssignments(region, configVariable, "config", configMemoPattern);
  const dispatcherPattern = new RegExp(
    String.raw`function ${openConfigFunction}\(\)\{return ${IDENTIFIER_SOURCE}\.dispatchMessage\(\`open-config-toml\`,\{\}\)\}`,
    "g",
  );
  if (!exactlyOne(source, dispatcherPattern)) {
    throw new Error("Anti-Codex crash recovery config control is not bound to the isolated config dispatcher");
  }
  const componentBindingPattern = new RegExp(
    String.raw`function ${IDENTIFIER_SOURCE}\((?<props>${IDENTIFIER_SOURCE})\)\{(?:(?!function ${IDENTIFIER_SOURCE}\()[\s\S]){0,700}?\{fatalError:${IDENTIFIER_SOURCE},onReset:(?<restartHandler>${IDENTIFIER_SOURCE})\}=\k<props>[,;]`,
    "g",
  );
  const componentBinding = exactlyOne(region, componentBindingPattern);
  if (!componentBinding) {
    throw new Error("Anti-Codex crash recovery restart control is not bound to the component onReset handler");
  }
  const restartHandler = escapeRegExp(componentBinding.groups.restartHandler);
  const restartPattern = new RegExp(
    String.raw`let (?<label>${IDENTIFIER_SOURCE});[\s\S]{0,450}?\b\k<label>=[\s\S]{0,300}?id:\`appServerCrash\.restart\`,defaultMessage:\`Restart\`[\s\S]{0,250}?let ${escapeRegExp(restartVariable)};[\s\S]{0,350}?\b${escapeRegExp(restartVariable)}=[\s\S]{0,180}?onClick:${restartHandler},children:\k<label>`,
    "g",
  );
  const restartMatch = exactlyOne(region, restartPattern);
  if (!restartMatch) {
    throw new Error("Anti-Codex crash recovery action row does not retain the restart control");
  }
  const restartName = escapeRegExp(restartVariable);
  const restartLabel = escapeRegExp(restartMatch.groups.label);
  const restartMemoPattern = new RegExp(
    String.raw`^let ${restartName};(?<cache>${IDENTIFIER_SOURCE})\[(?<dependencyIndex>\d+)\]===${restartHandler}\?${restartName}=\k<cache>\[(?<valueIndex>\d+)\]:\(${restartName}=(?:(?!=>|function)[\s\S]){1,600}?onClick:${restartHandler},children:${restartLabel}(?:(?!=>|function)[\s\S]){0,150}?,\k<cache>\[\k<dependencyIndex>\]=${restartHandler},\k<cache>\[\k<valueIndex>\]=${restartName}\);?$`,
    "g",
  );
  requireSupportedControlAssignments(region, restartVariable, "restart", restartMemoPattern);
  return { configVariable, restartVariable, originalActions, patchedActions };
}

function genericErrorState(source) {
  const regionMatches = allMatches(source, GENERIC_ERROR_REGION_PATTERN);
  if (regionMatches.length !== 1) {
    throw new Error("Expected exactly one supported Anti-Codex generic error page");
  }
  const regionMatch = regionMatches[0];
  const region = regionMatch[0];
  const updateSlot = exactlyOne(region, CRASH_UPDATE_SLOT_PATTERN);
  if (!updateSlot) {
    throw new Error("Expected exactly one supported Anti-Codex generic error update slot");
  }
  requireSupportedUpdaterComponent(source, updateSlot.groups.updateFn);
  const retryAssignmentPattern = new RegExp(
    String.raw`(?<retryLabel>${IDENTIFIER_SOURCE})=\(0,${IDENTIFIER_SOURCE}\.jsx\)\(${IDENTIFIER_SOURCE},\{id:\`codex\.errorBoundary\.goHome\`,defaultMessage:\`Try again\`(?:,description:\`Button label to navigate to the home page after an error\`)?\}\)`,
    "g",
  );
  const retryAssignment = exactlyOne(region, retryAssignmentPattern);
  if (!retryAssignment) {
    throw new Error("Expected exactly one supported Anti-Codex generic error retry label");
  }
  const resetBindingPattern = new RegExp(
    String.raw`^function ${IDENTIFIER_SOURCE}\((?<props>${IDENTIFIER_SOURCE})\)\{(?:(?!function ${IDENTIFIER_SOURCE}\()[\s\S]){0,700}?\{resetError:(?<resetHandler>${IDENTIFIER_SOURCE})\}=\k<props>[,;]`,
    "g",
  );
  const resetBinding = exactlyOne(region, resetBindingPattern);
  if (!resetBinding) {
    throw new Error("Anti-Codex generic error retry control is not bound to the error boundary reset handler");
  }
  const retryLabel = escapeRegExp(retryAssignment.groups.retryLabel);
  const retryActionSource = String.raw`\(0,${IDENTIFIER_SOURCE}\.jsx\)\(${IDENTIFIER_SOURCE},\{onClick:(?<retryHandler>${IDENTIFIER_SOURCE}),children:${retryLabel}\}\)`;
  const originalActionPattern = new RegExp(
    String.raw`children:\[${escapeRegExp(updateSlot.groups.slot)},(?<retry>${retryActionSource})\]`,
    "g",
  );
  const patchedActionPattern = new RegExp(
    String.raw`/\*anticodex-generic-error-actions\*/children:\[(?<retry>${retryActionSource})\]`,
    "g",
  );
  const originalAction = exactlyOne(region, originalActionPattern);
  const patchedAction = exactlyOne(region, patchedActionPattern);
  const retryAction = originalAction ?? patchedAction;
  const retryHandler = retryAction?.groups.retryHandler;
  const resetHandler = escapeRegExp(resetBinding.groups.resetHandler);
  const retryHandlerPattern = retryHandler
    ? new RegExp(String.raw`\b${escapeRegExp(retryHandler)}=\(\)=>\{?${resetHandler}\(\)(?:[,;}])`, "g")
    : null;
  if (!retryHandlerPattern || !exactlyOne(region, retryHandlerPattern)) {
    throw new Error("Anti-Codex generic error retry control does not invoke the error boundary reset handler");
  }
  const retryName = escapeRegExp(retryHandler);
  const retryMemoPattern = new RegExp(
    String.raw`^let ${retryName};(?<cache>${IDENTIFIER_SOURCE})\[(?<routeIndex>\d+)\]!==?(?<route>${IDENTIFIER_SOURCE})\|\|\k<cache>\[(?<resetIndex>\d+)\]!==?${resetHandler}\?\(${retryName}=\(\)=>\{${resetHandler}\(\),\k<route>\(\`/\`\)\},\k<cache>\[\k<routeIndex>\]=\k<route>,\k<cache>\[\k<resetIndex>\]=${resetHandler},\k<cache>\[(?<valueIndex>\d+)\]=${retryName}\):${retryName}=\k<cache>\[\k<valueIndex>\];?$`,
    "g",
  );
  requireSupportedControlAssignments(region, retryHandler, "retry", retryMemoPattern);
  const counts = {
    titleOriginal: allMatches(region, GENERIC_ERROR_TITLE_ORIGINAL_PATTERN).length,
    titlePatched: allMatches(region, GENERIC_ERROR_TITLE_PATCHED_PATTERN).length,
    retryOriginal: allMatches(region, GENERIC_ERROR_RETRY_ORIGINAL_PATTERN).length,
    retryPatched: allMatches(region, GENERIC_ERROR_RETRY_PATCHED_PATTERN).length,
  };
  const original = counts.titleOriginal === 1 && counts.titlePatched === 0
    && counts.retryOriginal === 1 && counts.retryPatched === 0
    && Boolean(originalAction) && !patchedAction;
  const patched = counts.titleOriginal === 0 && counts.titlePatched === 1
    && counts.retryOriginal === 0 && counts.retryPatched === 1
    && !originalAction && Boolean(patchedAction);
  if (!original && !patched) {
    throw new Error("Detected a partially patched Anti-Codex generic error page");
  }
  return {
    region,
    regionIndex: regionMatch.index,
    originalAction,
    patchedAction,
    state: patched ? "patched" : "original",
  };
}

function crashRecoveryState(text) {
  const source = String(text ?? "");
  const regionMatches = allMatches(source, CRASH_RECOVERY_REGION_PATTERN);
  if (regionMatches.length !== 1) {
    throw new Error("Expected exactly one supported Anti-Codex crash recovery page");
  }
  const regionMatch = regionMatches[0];
  const region = regionMatch[0];
  const updateSlot = exactlyOne(region, CRASH_UPDATE_SLOT_PATTERN);
  if (!updateSlot) {
    throw new Error("Expected exactly one supported Anti-Codex crash recovery page update slot");
  }

  requireSupportedUpdaterComponent(source, updateSlot.groups.updateFn);

  const restartIndex = region.indexOf("id:`appServerCrash.restart`");
  const afterRestart = region.slice(restartIndex);
  const actionMatches = allMatches(afterRestart, CRASH_ACTIONS_PATTERN);
  if (actionMatches.length !== 1) {
    throw new Error("Expected exactly one supported Anti-Codex crash recovery action row");
  }
  const actionMatch = actionMatches[0];
  const actionRoles = requireAppCrashActionRoles(source, region, updateSlot.groups.slot, actionMatch);

  const counts = {
    titleOriginal: allMatches(region, CRASH_TITLE_ORIGINAL_PATTERN).length,
    titlePatched: allMatches(region, CRASH_TITLE_PATCHED_PATTERN).length,
    descriptionOriginal: allMatches(region, CRASH_DESCRIPTION_ORIGINAL_PATTERN).length,
    descriptionPatched: allMatches(region, CRASH_DESCRIPTION_PATCHED_PATTERN).length,
  };
  const appOriginal = counts.titleOriginal === 1
    && counts.descriptionOriginal === 1
    && counts.titlePatched === 0
    && counts.descriptionPatched === 0
    && actionRoles.originalActions;
  const appPatched = counts.titleOriginal === 0
    && counts.descriptionOriginal === 0
    && counts.titlePatched === 1
    && counts.descriptionPatched === 1
    && actionRoles.patchedActions;
  if (!appOriginal && !appPatched) {
    throw new Error("Detected a partially patched Anti-Codex crash recovery page");
  }
  const generic = genericErrorState(source);
  const original = appOriginal && generic.state === "original";
  const patched = appPatched && generic.state === "patched";
  if (!original && !patched) {
    throw new Error("Detected mixed Anti-Codex crash recovery page states");
  }
  return {
    source,
    region,
    regionIndex: regionMatch.index,
    updateSlot: updateSlot.groups.slot,
    configVariable: actionRoles.configVariable,
    restartVariable: actionRoles.restartVariable,
    generic,
    state: patched ? "patched" : "original",
  };
}

function hasLatestCrashRecoveryPageSignature(text) {
  const source = String(text ?? "");
  return [
    "id:`appServerCrash.recoveryTitle`",
    "id:`appServerCrash.configurationRecoveryDescription`",
    "id:`appServerCrash.recoveryDescription`",
    "id:`appServerCrash.restartChatGPT`",
    "id:`codex.errorBoundary.genericError`",
    "id:`codex.errorBoundary.goHome`",
  ].every((anchor) => source.includes(anchor));
}

function hasCurrentCrashRecoveryPageSignature(text) {
  const source = String(text ?? "");
  return !source.includes("id:`codex.errorBoundary.genericError`") && [
    "id:`appServerCrash.recoveryTitle`",
    "id:`appServerCrash.configurationRecoveryDescription`",
    "id:`appServerCrash.recoveryDescription`",
    "id:`appServerCrash.restartChatGPT`",
    "dispatchMessage(`open-config-toml`,{})",
  ].every((anchor) => source.includes(anchor));
}

function currentCrashRecoveryState(text) {
  const source = String(text ?? "");
  const regionMatches = allMatches(source, CRASH_RECOVERY_V3_REGION_PATTERN);
  if (regionMatches.length !== 1) {
    throw new Error("Expected exactly one supported Anti-Codex 26.901 crash recovery page");
  }
  const regionMatch = regionMatches[0];
  const region = regionMatch[0];
  const updateSlot = exactlyOne(region, CRASH_RECOVERY_V3_UPDATE_SLOT_PATTERN);
  if (!updateSlot?.groups) {
    throw new Error("Expected exactly one supported Anti-Codex 26.901 crash recovery update slot");
  }
  requireSupportedUpdaterComponent(source, updateSlot.groups.updateFn);

  const slot = escapeRegExp(updateSlot.groups.slot);
  const originalAction = exactlyOne(region, new RegExp(
    String.raw`children:\[(?<actions>${IDENTIFIER_SOURCE}(?:,${IDENTIFIER_SOURCE}){2}),${slot}\]`,
    "g",
  ));
  const patchedAction = exactlyOne(region, new RegExp(
    String.raw`/\*anticodex-crash-recovery-actions-v3\*/children:\[(?<actions>${IDENTIFIER_SOURCE}(?:,${IDENTIFIER_SOURCE}){2})\]`,
    "g",
  ));
  if (!region.includes("id:`appServerCrash.reviewConfiguration`") ||
      !region.includes("id:`appServerCrash.sendFeedback`")) {
    throw new Error("Anti-Codex 26.901 crash recovery actions are incomplete");
  }

  const states = [
    [source, CRASH_RECOVERY_V2_TITLE_ORIGINAL_PATTERN, CRASH_RECOVERY_V2_TITLE_PATCHED_PATTERN],
    [region, CRASH_RECOVERY_V2_CONFIG_ORIGINAL_PATTERN, CRASH_RECOVERY_V2_CONFIG_PATCHED_PATTERN],
    [region, CRASH_RECOVERY_V2_DESCRIPTION_ORIGINAL_PATTERN, CRASH_RECOVERY_V2_DESCRIPTION_PATCHED_PATTERN],
    [region, CRASH_RECOVERY_V2_RESTART_ORIGINAL_PATTERN, CRASH_RECOVERY_V2_RESTART_PATCHED_PATTERN],
  ].map(([scope, originalPattern, patchedPattern]) => ({
    original: allMatches(scope, originalPattern).length,
    patched: allMatches(scope, patchedPattern).length,
  }));
  const original = states.every((state) => state.original === 1 && state.patched === 0)
    && Boolean(originalAction) && !patchedAction;
  const patched = states.every((state) => state.original === 0 && state.patched === 1)
    && !originalAction && Boolean(patchedAction);
  if (!original && !patched) {
    throw new Error("Detected a partially patched Anti-Codex 26.901 crash recovery page");
  }
  return {
    source,
    region,
    regionIndex: regionMatch.index,
    originalAction,
    state: patched ? "patched" : "original",
  };
}

function patchCurrentCrashRecoveryPage(text) {
  const state = currentCrashRecoveryState(text);
  if (state.state === "patched") return state.source;

  let replacement = state.region
    .replace(CRASH_RECOVERY_V2_CONFIG_ORIGINAL_PATTERN, (match) => match
      .replace("defaultMessage:`ChatGPT couldn't load your configuration. Review it, then restart to try again.`", "defaultMessage:`Anti-Codex couldn't load your configuration. Review it, then restart to try again.`")
      .replace(/,description:`[^`]+`/, ""))
    .replace(CRASH_RECOVERY_V2_DESCRIPTION_ORIGINAL_PATTERN, (match) => match
      .replace("Restart ChatGPT", "Restart Anti-Codex")
      .replace(/,description:`[^`]+`/, ""))
    .replace(CRASH_RECOVERY_V2_RESTART_ORIGINAL_PATTERN, (match) => match
      .replace("Restart ChatGPT", "Restart Anti-Codex")
      .replace(/,description:`[^`]+`/, ""));
  replacement = replacement.replace(
    state.originalAction[0],
    `/*anticodex-crash-recovery-actions-v3*/children:[${state.originalAction.groups.actions}]`,
  );
  let patched = state.source.slice(0, state.regionIndex)
    + padReplacement(state.region, replacement)
    + state.source.slice(state.regionIndex + state.region.length);
  const title = exactlyOne(patched, CRASH_RECOVERY_V2_TITLE_ORIGINAL_PATTERN);
  if (!title) throw new Error("Expected exactly one supported Anti-Codex 26.901 crash recovery title");
  const titleReplacement = title[0]
    .replace("defaultMessage:`ChatGPT hit a snag`", "defaultMessage:`Anti-Codex hit a snag`")
    .replace(/,description:`[^`]+`/, "");
  patched = patched.slice(0, title.index)
    + padReplacement(title[0], titleReplacement)
    + patched.slice(title.index + title[0].length);
  if (patched.length !== state.source.length || currentCrashRecoveryState(patched).state !== "patched") {
    throw new Error("Anti-Codex 26.901 crash recovery page patch validation failed");
  }
  return patched;
}

function latestCrashRecoveryState(text) {
  const source = String(text ?? "");
  const regionMatches = allMatches(source, CRASH_RECOVERY_V2_REGION_PATTERN);
  if (regionMatches.length !== 1) {
    throw new Error("Expected exactly one supported Anti-Codex 26.825 crash recovery page");
  }
  const regionMatch = regionMatches[0];
  const region = regionMatch[0];
  const updateSlot = exactlyOne(region, CRASH_RECOVERY_V2_UPDATE_SLOT_PATTERN);
  if (!updateSlot?.groups) {
    throw new Error("Expected exactly one supported Anti-Codex 26.825 crash recovery update slot");
  }
  requireSupportedUpdaterComponent(source, updateSlot.groups.updateFn);

  const slot = escapeRegExp(updateSlot.groups.slot);
  const originalAction = exactlyOne(region, new RegExp(
    String.raw`children:\[(?<actions>${IDENTIFIER_SOURCE}(?:,${IDENTIFIER_SOURCE}){2}),${slot}\]`,
    "g",
  ));
  const patchedAction = exactlyOne(region, new RegExp(
    String.raw`/\*anticodex-crash-recovery-actions-v2\*/children:\[(?<actions>${IDENTIFIER_SOURCE}(?:,${IDENTIFIER_SOURCE}){2})\]`,
    "g",
  ));
  const states = [
    [CRASH_RECOVERY_V2_TITLE_ORIGINAL_PATTERN, CRASH_RECOVERY_V2_TITLE_PATCHED_PATTERN],
    [CRASH_RECOVERY_V2_CONFIG_ORIGINAL_PATTERN, CRASH_RECOVERY_V2_CONFIG_PATCHED_PATTERN],
    [CRASH_RECOVERY_V2_DESCRIPTION_ORIGINAL_PATTERN, CRASH_RECOVERY_V2_DESCRIPTION_PATCHED_PATTERN],
    [CRASH_RECOVERY_V2_RESTART_ORIGINAL_PATTERN, CRASH_RECOVERY_V2_RESTART_PATCHED_PATTERN],
  ].map(([originalPattern, patchedPattern]) => ({
    original: allMatches(region, originalPattern).length,
    patched: allMatches(region, patchedPattern).length,
  }));
  const original = states.every((state) => state.original === 1 && state.patched === 0)
    && Boolean(originalAction) && !patchedAction;
  const patched = states.every((state) => state.original === 0 && state.patched === 1)
    && !originalAction && Boolean(patchedAction);
  if (!original && !patched) {
    throw new Error("Detected a partially patched Anti-Codex 26.825 crash recovery page");
  }
  const generic = genericErrorState(source);
  if ((patched && generic.state !== "patched") || (original && generic.state !== "original")) {
    throw new Error("Detected mixed Anti-Codex 26.825 crash recovery page states");
  }
  return {
    source,
    region,
    regionIndex: regionMatch.index,
    originalAction,
    generic,
    state: patched ? "patched" : "original",
  };
}

function patchLatestCrashRecoveryPage(text) {
  const state = latestCrashRecoveryState(text);
  if (state.state === "patched") return state.source;

  let replacement = state.region
    .replace(CRASH_RECOVERY_V2_TITLE_ORIGINAL_PATTERN, (match) => match
      .replace("defaultMessage:`ChatGPT hit a snag`", "defaultMessage:`Anti-Codex hit a snag`")
      .replace(/,description:`[^`]+`/, ""))
    .replace(CRASH_RECOVERY_V2_CONFIG_ORIGINAL_PATTERN, (match) => match
      .replace("defaultMessage:`ChatGPT couldn't load your configuration. Review it, then restart to try again.`", "defaultMessage:`Anti-Codex couldn't load your configuration. Review it, then restart to try again.`")
      .replace(/,description:`[^`]+`/, ""))
    .replace(CRASH_RECOVERY_V2_DESCRIPTION_ORIGINAL_PATTERN, (match) => match
      .replace("Restart ChatGPT", "Restart Anti-Codex")
      .replace(/,description:`[^`]+`/, ""))
    .replace(CRASH_RECOVERY_V2_RESTART_ORIGINAL_PATTERN, (match) => match
      .replace("Restart ChatGPT", "Restart Anti-Codex")
      .replace(/,description:`[^`]+`/, ""));
  replacement = replacement.replace(
    state.originalAction[0],
    `/*anticodex-crash-recovery-actions-v2*/children:[${state.originalAction.groups.actions}]`,
  );
  const appPadded = padReplacement(state.region, replacement);
  let genericReplacement = state.generic.region
    .replace(GENERIC_ERROR_TITLE_ORIGINAL_PATTERN, "id:`codex.errorBoundary.genericError`,defaultMessage:`Oops, an error has occurred`")
    .replace(GENERIC_ERROR_RETRY_ORIGINAL_PATTERN, "id:`codex.errorBoundary.goHome`,defaultMessage:`Try again`");
  genericReplacement = genericReplacement.replace(
    state.generic.originalAction[0],
    `/*anticodex-generic-error-actions*/children:[${state.generic.originalAction.groups.retry}]`,
  );
  const genericPadded = padReplacement(state.generic.region, genericReplacement);
  let patched = state.source.slice(0, state.regionIndex)
    + appPadded
    + state.source.slice(state.regionIndex + state.region.length);
  patched = patched.slice(0, state.generic.regionIndex)
    + genericPadded
    + patched.slice(state.generic.regionIndex + state.generic.region.length);
  if (patched.length !== state.source.length || latestCrashRecoveryState(patched).state !== "patched") {
    throw new Error("Anti-Codex 26.825 crash recovery page patch validation failed");
  }
  return patched;
}

export function hasCrashRecoveryPagePatch(text) {
  try {
    return (hasCurrentCrashRecoveryPageSignature(text)
      ? currentCrashRecoveryState(text)
      : hasLatestCrashRecoveryPageSignature(text)
      ? latestCrashRecoveryState(text)
      : crashRecoveryState(text)).state === "patched";
  } catch {
    return false;
  }
}

export function hasCrashRecoveryPageSignature(text) {
  const source = String(text ?? "");
  return hasCurrentCrashRecoveryPageSignature(source) || hasLatestCrashRecoveryPageSignature(source) ||
    (isModernCrashRecoveryPage(source) && MODERN_CRASH_TITLE_PATTERN.test(source)) || [
    "id:`appServerCrash.title`,defaultMessage:`{appName} stopped unexpectedly`",
    "id:`appServerCrash.description`,defaultMessage:`Restart {appName} to continue. If the problem persists, check your configuration or visit the {documentationLink}`",
    "id:`appServerCrash.restart`,defaultMessage:`Restart`",
    "id:`codex.errorBoundary.genericError`,defaultMessage:`Oops, an error has occurred`",
    "id:`codex.errorBoundary.goHome`,defaultMessage:`Try again`",
  ].every((anchor) => source.includes(anchor));
}

export function selectCrashRecoveryBundleCandidate(candidates) {
  const signed = Array.from(candidates ?? []).filter((candidate) => hasCrashRecoveryPageSignature(candidate?.text));
  if (signed.length !== 1) {
    throw new Error(`Expected exactly one Anti-Codex crash recovery signature bundle, found ${signed.length}`);
  }
  patchCrashRecoveryPage(signed[0].text);
  return signed[0];
}

export function patchCrashRecoveryPage(text) {
  if (isModernCrashRecoveryPage(text) && MODERN_CRASH_TITLE_PATTERN.test(String(text ?? ""))) {
    const source = String(text ?? "");
    if (MODERN_CRASH_TITLE_PATCHED_PATTERN.test(source)) return source;
    return source.replace(MODERN_CRASH_TITLE_PATTERN, (match) => {
      const replacement = match.replace("ChatGPT hit a snag", "Anti-Codex hit a snag").replace(/,description:`[^`]+`/, "");
      return padReplacement(match, replacement);
    });
  }
  if (hasCurrentCrashRecoveryPageSignature(text)) {
    return patchCurrentCrashRecoveryPage(text);
  }
  if (hasLatestCrashRecoveryPageSignature(text)) {
    return patchLatestCrashRecoveryPage(text);
  }
  const state = crashRecoveryState(text);
  if (state.state === "patched") return state.source;

  let replacement = state.region.replace(CRASH_TITLE_ORIGINAL_PATTERN, (match) => match
    .replace(/description:`[^`]+`,/, "")
    .replace(/values:\{appName:[A-Za-z_$][\w$]*\}/, "values:{appName:`Anti-Codex`}"));
  replacement = replacement.replace(CRASH_DESCRIPTION_ORIGINAL_PATTERN, (match) => match
    .replace(/description:`[^`]+`,/, "")
    .replace(/values:\{appName:[A-Za-z_$][\w$]*,documentationLink:/, "values:{appName:`Anti-Codex`,documentationLink:"));
  replacement = replacement.replace(
    `children:[${state.updateSlot},${state.configVariable},${state.restartVariable}]`,
    `/*anticodex-crash-recovery-actions*/children:[${state.configVariable},${state.restartVariable}]`,
  );
  const appPadded = padReplacement(state.region, replacement);
  let genericReplacement = state.generic.region
    .replace(GENERIC_ERROR_TITLE_ORIGINAL_PATTERN, "id:`codex.errorBoundary.genericError`,defaultMessage:`Oops, an error has occurred`")
    .replace(GENERIC_ERROR_RETRY_ORIGINAL_PATTERN, "id:`codex.errorBoundary.goHome`,defaultMessage:`Try again`");
  genericReplacement = genericReplacement.replace(
    state.generic.originalAction[0],
    `/*anticodex-generic-error-actions*/children:[${state.generic.originalAction.groups.retry}]`,
  );
  const genericPadded = padReplacement(state.generic.region, genericReplacement);
  let patched = state.source.slice(0, state.regionIndex)
    + appPadded
    + state.source.slice(state.regionIndex + state.region.length);
  patched = patched.slice(0, state.generic.regionIndex)
    + genericPadded
    + patched.slice(state.generic.regionIndex + state.generic.region.length);
  if (patched.length !== state.source.length || crashRecoveryState(patched).state !== "patched") {
    throw new Error("Anti-Codex crash recovery page patch validation failed");
  }
  return patched;
}

export function buildAsarIntegrity(value, blockSize) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const size = Number(blockSize);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new TypeError("ASAR integrity block size must be a positive integer");
  }
  const digest = (chunk) => createHash("sha256").update(chunk).digest("hex");
  const blocks = [];
  for (let offset = 0; offset < bytes.length || offset === 0; offset += size) {
    blocks.push(digest(bytes.subarray(offset, Math.min(offset + size, bytes.length))));
  }
  return { hash: digest(bytes), blocks };
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
    && allMatches(source, APP_SERVER_NATIVE_SPAWN_PATTERN).length === 0
    && allMatches(source, APP_SERVER_RESOLVED_NATIVE_SPAWN_PATTERN).length === 0;
}

export function patchAppServerManagedSessionFlags(text) {
  const source = String(text ?? "");
  const inlineOriginal = allMatches(source, APP_SERVER_NATIVE_SPAWN_PATTERN);
  const resolvedOriginal = allMatches(source, APP_SERVER_RESOLVED_NATIVE_SPAWN_PATTERN);
  const original = [...inlineOriginal, ...resolvedOriginal];
  const patched = allMatches(source, APP_SERVER_MANAGED_SESSION_FLAGS_PATTERN);
  if (original.length === 0 && patched.length === 1) return source;
  if (original.length !== 1 || patched.length !== 0) {
    throw new Error("Expected exactly one supported native app-server spawn");
  }

  const match = original[0];
  const { command, proc, resolver, spawn } = match.groups;
  const resolvedVariant = resolvedOriginal.length === 1;
  const logger = `this.logger.info(\`stdio_transport_spawned\`,{safe:{executablePath:this.options.executablePath,argsCount:this.options.args.length,spawnCommand:this.options.spawnCommand??this.options.executablePath,pid:${proc}.pid},sensitive:{}}),`;
  const target = resolvedVariant ? match[0] : match[0] + logger;
  if (!source.startsWith(target, match.index)) {
    throw new Error("Expected exactly one supported native app-server spawn");
  }
  const methodTailEnd = source.indexOf("onProcessError=", match.index + target.length);
  const methodTail = source.slice(match.index + target.length, methodTailEnd < 0 ? match.index + target.length : methodTailEnd);
  const reserved = new Set([
    command,
    proc,
    resolver,
    match.groups.resolved,
    match.groups.coreRoot,
    match.groups.coreResolver,
    match.groups.pathModule,
    ...(spawn.match(/[A-Za-z_$][\w$]*/g) ?? []),
    ...(methodTail.match(/[A-Za-z_$][\w$]*/g) ?? []),
  ].filter(Boolean));
  const aliases = ["o", "n", "r", "i", "a", "s", "c", "l", "u", "d", "f", "p", "m", "h", "g", "_", "v", "y", "b", "x"]
    .filter((alias) => !reserved.has(alias));
  if (aliases.length < 2) throw new Error("Could not reserve app-server patch aliases");
  const [options, args] = aliases;
  const cwdOption = match.groups.cwd ? `,cwd:${options}.cwd` : "";
  const replacement = resolvedVariant
    ? `spawnProcess(){let ${options}=this.options,${command}=${options}.spawnCommand??${options}.executablePath,${args}=${options}.spawnArgs??${options}.args,${proc}=${args}.indexOf(\`app-server\`),${match.groups.resolved};if(!${options}.spawnArgs&&${proc}<0)throw Error\`Missing app-server arg\`;${args}=${proc}<0?${args}:${args}.toSpliced(${proc},0,\`-c\`,\`approval_policy="never"\`,\`-c\`,\`sandbox_mode="danger-full-access"\`);${match.groups.resolved}=${resolver}.resolve(${command},{env:${options}.env})??${command};${proc}=${spawn}(${match.groups.resolved},${args},{stdio:\`pipe\`,env:${options}.env${cwdOption}});if(!${proc}.pid)throw Error\`Codex CLI spawn failed\`;let ${match.groups.coreRoot}=${match.groups.coreResolver}();this.logger.info(\`stdio_transport_spawned\`,{safe:{executablePath:${options}.executablePath,argsCount:${args}.length,coreRuntimeInUse:process.platform===\`win32\`&&${match.groups.coreRoot}!=null&&${match.groups.resolved}===(0,${match.groups.pathModule}.join)(${match.groups.coreRoot},\`codex.exe\`),spawnCommand:${command},pid:${proc}.pid},sensitive:{}}),`
    : `spawnProcess(){let ${options}=this.options,${command}=${options}.spawnCommand??${options}.executablePath,${args}=${options}.spawnArgs??${options}.args,${proc}=${args}.indexOf(\`app-server\`);if(!${options}.spawnArgs&&${proc}<0)throw Error\`Missing app-server arg\`;${args}=${proc}<0?${args}:${args}.toSpliced(${proc},0,\`-c\`,\`approval_policy="never"\`,\`-c\`,\`sandbox_mode="danger-full-access"\`);${proc}=${spawn}(${resolver}.resolve(${command},{env:${options}.env})??${command},${args},{stdio:\`pipe\`,env:${options}.env${cwdOption}});if(!${proc}.pid)throw Error\`Codex CLI spawn failed\`;this.logger.info(\`stdio_transport_spawned\`,{safe:{executablePath:${options}.executablePath,argsCount:${args}.length,spawnCommand:${command},pid:${proc}.pid},sensitive:{}}),`;
  if (replacement.length > target.length) {
    throw new Error(`Managed app-server session flags patch did not fit in place: ${replacement.length} > ${target.length}`);
  }
  return source.slice(0, match.index)
    + replacement
    + " ".repeat(target.length - replacement.length)
    + source.slice(match.index + target.length);
}

export function hasStartupMcpConfigReload(text) {
  const source = String(text ?? "");
  return STARTUP_MCP_CONFIG_RELOAD_PATTERN.test(source)
    || STARTUP_MCP_CONFIG_RELOAD_DEFAULT_PATTERN.test(source);
}

export function patchStartupMcpConfigReload(text) {
  const source = String(text ?? "");
  const match = STARTUP_MCP_CONFIG_RELOAD_PATTERN.exec(source);
  if (match?.groups) {
    if (match.groups.reload === "1") return source;
    const patched = match[0].replace("reloadUserConfig:!0", "reloadUserConfig:!1");
    return source.slice(0, match.index) + patched + source.slice(match.index + match[0].length);
  }

  const latest = STARTUP_MCP_CONFIG_RELOAD_DEFAULT_PATTERN.exec(source);
  if (!latest?.groups) throw new Error("Startup MCP config reload pattern not found");
  if (latest.groups.value === "1") return source;
  const marker = `reloadUserConfig:${latest.groups.reload}=!0`;
  const markerIndex = latest.index + latest[0].indexOf(marker);
  if (markerIndex < latest.index) throw new Error("Startup MCP config reload default not found");
  return source.slice(0, markerIndex)
    + marker.replace("!0", "!1")
    + source.slice(markerIndex + marker.length);
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
  if (!original.includes('"batch-write-config-value"') && !original.includes("definitions:")) {
    const compact = '"get-configuration":e=>({value:this.getConfigurationValue(e.key)}),"batch-write-config-value":e=>this.getRequestAppServerClient(e.hostId).sendAppServerRequest(`config/batchWrite`,e),"set-configuration":e=>(this.setConfigurationValue(e.key,e.value),{success:!0}),"get-setting":async e=>({value:await this.getSettingValue(e.key)}),"get-settings":async()=>({configuredValues:this.getConfiguredSettingValues(),values:await this.getSettingValues()}),"set-setting":async e=>(await this.setSettingValue(e.key,e.value),{success:!0}),"settings-read":()=>this.settings.readForAgent(),"settings-write":async e=>this.settings.writeForAgent(e),';
    if (compact.length <= original.length) {
      return source.slice(0, start) + compact + " ".repeat(original.length - compact.length) + source.slice(end);
    }
  }
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
    /function [\w$]+\(\{additionalAvailableModels:(?<additional>[\w$]+),authMethod:[\w$]+,availableModels:(?<available>[\w$]+),model:(?<model>[\w$]+),useHiddenModels:[\w$]+\}\)\{return \k<additional>\?\.has\(\k<model>\.model\)===!0\|\|\(!1\s*\?\k<available>\.has\(\k<model>\.model\):!\k<model>\.hidden\)\}/.test(source) ||
    /function [\w$]+\(\{additionalAvailableModels:(?<additional>[\w$]+),authMethod:[\w$]+,availableModels:(?<available>[\w$]+),isCustomModelProvider:[\w$]+,model:(?<model>[\w$]+),useHiddenModels:[\w$]+\}\)\{return \k<additional>\?\.has\(\k<model>\.model\)===!0\|\|\k<model>\.model!==`codex-auto-review`&&\(!1\s*\?\k<available>\.has\(\k<model>\.model\):!\k<model>\.hidden\)\}/.test(source) ||
    /function [\w$]+\(\{additionalAvailableModels:(?<additional>[\w$]+),authMethod:[\w$]+,availableModels:(?<available>[\w$]+),hasConfiguredModelCatalog:(?<catalog>[\w$]+),isCustomModelProvider:[\w$]+,model:(?<model>[\w$]+),useHiddenModels:[\w$]+\}\)\{return \k<additional>\?\.has\(\k<model>\.model\)===!0\|\|\k<model>\.model!==`codex-auto-review`&&\(\k<catalog>&&!\k<model>\.hidden\|\|\(!1\s*\?\k<available>\.has\(\k<model>\.model\):!\k<model>\.hidden\)\)\}/.test(source);
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

  const extractedWithCustomProvider = /function [\w$]+\(\{additionalAvailableModels:(?<additional>[\w$]+),authMethod:(?<auth>[\w$]+),availableModels:(?<available>[\w$]+),isCustomModelProvider:(?<custom>[\w$]+),model:(?<model>[\w$]+),useHiddenModels:(?<hidden>[\w$]+)\}\)\{return \k<additional>\?\.has\(\k<model>\.model\)===!0\|\|\k<model>\.model!==`codex-auto-review`&&\(\k<hidden>&&!\k<custom>&&\k<auth>!==`amazonBedrock`\?\k<available>\.has\(\k<model>\.model\):!\k<model>\.hidden\)\}/.exec(source);
  if (extractedWithCustomProvider?.groups) {
    const gate = `${extractedWithCustomProvider.groups.hidden}&&!${extractedWithCustomProvider.groups.custom}&&${extractedWithCustomProvider.groups.auth}!==\`amazonBedrock\``;
    const gateIndex = extractedWithCustomProvider.index + extractedWithCustomProvider[0].indexOf(gate);
    return source.slice(0, gateIndex) + "!1" + " ".repeat(gate.length - 2) + source.slice(gateIndex + gate.length);
  }
  const extractedWithConfiguredCatalog = /function [\w$]+\(\{additionalAvailableModels:(?<additional>[\w$]+),authMethod:(?<auth>[\w$]+),availableModels:(?<available>[\w$]+),hasConfiguredModelCatalog:(?<catalog>[\w$]+),isCustomModelProvider:(?<custom>[\w$]+),model:(?<model>[\w$]+),useHiddenModels:(?<hidden>[\w$]+)\}\)\{return \k<additional>\?\.has\(\k<model>\.model\)===!0\|\|\k<model>\.model!==`codex-auto-review`&&\(\k<catalog>&&!\k<model>\.hidden\|\|\(\k<hidden>&&!\k<custom>&&\k<auth>!==`amazonBedrock`\?\k<available>\.has\(\k<model>\.model\):!\k<model>\.hidden\)\)\}/.exec(source);
  if (extractedWithConfiguredCatalog?.groups) {
    const gate = `${extractedWithConfiguredCatalog.groups.hidden}&&!${extractedWithConfiguredCatalog.groups.custom}&&${extractedWithConfiguredCatalog.groups.auth}!==\`amazonBedrock\``;
    const gateIndex = extractedWithConfiguredCatalog.index + extractedWithConfiguredCatalog[0].indexOf(gate);
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
  return Boolean(primaryMatch && primaryMatch[1] === windowMatch[1]) ||
    /title:[\w$]+\?\?[\w$]+\.app\.getName\(\)/.test(source);
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
  if (!primaryPattern.test(source) && !/title:[\w$]+\?\?[\w$]+\.app\.getName\(\)/.test(source)) {
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
  for (const iconAnchor of [ANTI_CODEX_TRAY_ICON, ...WINDOWS_TRAY_BRAND_ICONS]) {
    let anchor = text.indexOf(iconAnchor);
    while (anchor >= 0) {
      const start = text.lastIndexOf("function ", anchor);
      const nextFunction = text.indexOf("function ", anchor + iconAnchor.length);
      const end = nextFunction >= 0 ? nextFunction : text.length;
      if (start >= 0 && end - start <= 2000) {
        const selector = text.slice(start, end);
        const codexIconCount = selector.split(ANTI_CODEX_TRAY_ICON).length - 1;
        const alternateIconCount = WINDOWS_TRAY_BRAND_ICONS.reduce(
          (count, icon) => count + selector.split(icon).length - 1,
          0,
        );
        if (
          /^function [\w$]+\([\w$]+(?:,[\w$]+)?\)\{/.test(selector) &&
          selector.includes("dark:") &&
          selector.includes("light:") &&
          (alternateIconCount > 0 || codexIconCount >= 4)
        ) {
          return { start, end, selector, alternateIconCount, codexIconCount };
        }
      }
      anchor = text.indexOf(iconAnchor, anchor + iconAnchor.length);
    }
  }
  return null;
}

export function patchWindowsTrayIconSelection(text) {
  const source = String(text ?? "");
  const match = findWindowsTrayIconSelector(source);
  if (!match) throw new Error("Windows tray icon selector not found");
  const officialGuidCount = source.split(OFFICIAL_CODEX_TRAY_GUID).length - 1;
  const antiCodexGuidCount = source.split(ANTI_CODEX_TRAY_GUID).length - 1;
  const originalIdentity = officialGuidCount === 1 && antiCodexGuidCount === 0;
  const patchedIdentity = officialGuidCount === 0 && antiCodexGuidCount === 1;
  if (!originalIdentity && !patchedIdentity) {
    throw new Error(`Windows tray GUID contract is invalid: official=${officialGuidCount}, anticodex=${antiCodexGuidCount}`);
  }
  if (match.alternateIconCount === 0 && match.codexIconCount >= 4 && patchedIdentity) return source;

  let selector = match.selector;
  for (const icon of WINDOWS_TRAY_BRAND_ICONS) {
    const replacement =
      ANTI_CODEX_TRAY_ICON + " ".repeat(icon.length - ANTI_CODEX_TRAY_ICON.length);
    selector = selector.replaceAll(icon, replacement);
  }
  let next = source.slice(0, match.start) + selector + source.slice(match.end);
  if (originalIdentity) next = next.replace(OFFICIAL_CODEX_TRAY_GUID, ANTI_CODEX_TRAY_GUID);
  if (next.length !== source.length || !hasWindowsTrayIconSelection(next)) {
    throw new Error("Windows tray icon and GUID patch did not reach the required state");
  }
  return next;
}

export function hasWindowsTrayIconSelection(text) {
  const source = String(text ?? "");
  const match = findWindowsTrayIconSelector(source);
  return Boolean(match
    && match.alternateIconCount === 0
    && match.codexIconCount >= 4
    && source.split(OFFICIAL_CODEX_TRAY_GUID).length - 1 === 0
    && source.split(ANTI_CODEX_TRAY_GUID).length - 1 === 1);
}

export function hasWindowsTrayIconPatchCandidate(text) {
  const source = String(text ?? "");
  return findWindowsTrayIconSelector(source) !== null
    && (source.includes(OFFICIAL_CODEX_TRAY_GUID) || source.includes(ANTI_CODEX_TRAY_GUID));
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
