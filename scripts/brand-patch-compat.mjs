const ANTI_CODEX_TITLE = "`Anti-Codex`";
const ANTI_CODEX_TRAY_ICON = "`codex-tray.ico`";
const WINDOWS_TRAY_BRAND_ICONS = [
  "`icon-agent.ico`",
  "`chatgpt-tray-dark.ico`",
  "`chatgpt-tray-light.ico`",
];

const STARTUP_MCP_CONFIG_RELOAD_PATTERN =
  /await [\w$]+\.sendAppServerRequest\(`config\/batchWrite`,\{edits:[\w$]+\([\w$]+\),expectedVersion:null,filePath:null,reloadUserConfig:!(?<reload>[01])\}\)/;

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

export function hasPatchedAuthRequirement(text) {
  return /requiresAuth:!1\s*,email:([\w$]+)\.account\?\.type===`chatgpt`\?\1\.account\.email:null/.test(
    String(text ?? ""),
  );
}

export function hasPatchedLocalModelAvailability(text) {
  return /let [\w$]+=\[\],[\w$]+=null,[\w$]+=!1\s*(?=[,;])/.test(
    String(text ?? ""),
  );
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
