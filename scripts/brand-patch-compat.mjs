const ANTI_CODEX_TITLE = "`Anti-Codex`";

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
