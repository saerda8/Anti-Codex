import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

function normalizedPromptSettingsState(value = {}) {
  const editor = (entry = {}) => ({
    enabled: entry.enabled === true,
    useDefault: entry.useDefault === true,
    content: String(entry.content ?? ""),
  });
  return {
    codexSystem: editor(value.codexSystem),
    codexDeveloper: editor(value.codexDeveloper),
    user: {
      enabled: value.user?.enabled === true,
      content: String(value.user?.content ?? ""),
    },
    nativeCustomInstructions: {
      content: String(value.nativeCustomInstructions?.content ?? ""),
      existed: value.nativeCustomInstructions?.existed === true,
    },
  };
}

export function promptSettingsStatesEqual(left, right) {
  return JSON.stringify(normalizedPromptSettingsState(left)) === JSON.stringify(normalizedPromptSettingsState(right));
}

export function promptSettingsStatesSemanticallyEqual(left, right) {
  const normalizedLeft = normalizedPromptSettingsState(left);
  const normalizedRight = normalizedPromptSettingsState(right);
  normalizedLeft.nativeCustomInstructions.existed = false;
  normalizedRight.nativeCustomInstructions.existed = false;
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

export function captureExactFileSnapshot(filePath) {
  const target = resolve(String(filePath || ""));
  if (!existsSync(target)) return { target, existed: false, bytes: null };
  if (!lstatSync(target).isFile()) throw new Error(`Acceptance state path is not a regular file: ${target}`);
  return { target, existed: true, bytes: readFileSync(target) };
}

export function restoreExactFileSnapshot(snapshot) {
  const target = resolve(String(snapshot?.target || ""));
  if (!snapshot?.existed) {
    if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`Refusing to remove a non-file acceptance state path: ${target}`);
    rmSync(target, { force: true });
    return;
  }
  if (!Buffer.isBuffer(snapshot.bytes)) throw new Error(`Acceptance snapshot bytes are missing: ${target}`);
  if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`Refusing to replace a non-file acceptance state path: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.acceptance-restore.tmp`;
  try {
    writeFileSync(temporary, snapshot.bytes);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function exactFileSnapshotMatches(snapshot) {
  const target = resolve(String(snapshot?.target || ""));
  if (!snapshot?.existed) return !existsSync(target);
  if (!existsSync(target) || !lstatSync(target).isFile() || !Buffer.isBuffer(snapshot.bytes)) return false;
  return readFileSync(target).equals(snapshot.bytes);
}

export function resolveNativeSettingsAsarPath({ explicitPath = "", scriptDirectory = "" } = {}) {
  if (explicitPath) return resolve(String(explicitPath));
  const scripts = resolve(String(scriptDirectory || ""));
  const candidates = [
    join(scripts, "..", "codex-patched-app", "resources", "app.asar"),
    join(scripts, "..", "..", "codex-patched-app", "resources", "app.asar"),
  ].map((value) => resolve(value));
  const matches = [...new Set(candidates.filter((value) => existsSync(value)))];
  if (matches.length !== 1) throw new Error(`Expected one native Settings ASAR candidate, found ${matches.length}.`);
  return matches[0];
}

export function extractNativeSettingsRegistrationSlugs(source = "") {
  return extractNativeSettingsRegistrationContract(source)?.slugs || [];
}

function extractNativeSettingsRegistrationContract(source = "") {
  const candidates = [];
  for (const match of String(source).matchAll(/(?:^|[;,])(?:var |let |const )?([A-Za-z_$][\w$]*)\s*=\s*\{([^{}]{1,1200})\}/g)) {
    const keys = [...match[2].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$-]*))\s*:\s*[A-Za-z_$][\w$]*/g)]
      .map((entry) => String(entry[1] || entry[2] || ""))
      .filter(Boolean);
    if (!keys.includes("agent") || !keys.some((key) => key === "personalization" || key.endsWith("-settings"))) continue;
    if (new Set(keys).size !== keys.length) continue;
    candidates.push({ variableName: match[1], slugs: keys });
  }
  const unique = [...new Map(candidates.map((candidate) => [
    `${candidate.variableName}\0${JSON.stringify(candidate.slugs)}`,
    candidate,
  ])).values()];
  if (unique.length > 1) throw new Error("Ambiguous native Settings registration contract.");
  return unique[0] || null;
}

export function extractNativeSettingsGateSlugs(source = "", evidence = {}) {
  const text = String(source);
  const registrationContract = extractNativeSettingsRegistrationContract(text);
  if (!registrationContract) return [];
  return extractNativeSettingsVisibilityGateContract(text, registrationContract, evidence).gatedSlugs;
}

function extractNativeSettingsVisibilityCandidates(source, registered) {
  const candidates = [];
  for (const functionMatch of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]{0,1200}\)\s*\{/g)) {
    const functionBody = readBalancedBlock(source, functionMatch.index + functionMatch[0].lastIndexOf("{"));
    if (!functionBody) continue;
    if (!["activeSettingsSection", "settingsNavigationSections", "shouldRedirectToVisibleSettingsSection", "shouldRenderRouteContent", "visibleSettingsSections"]
      .every((key) => new RegExp(`\\b${key}\\s*:`).test(functionBody))) continue;
    for (const filterMatch of functionBody.matchAll(/(?:^|[,{;])\s*(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.filter\(\s*(?:\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*=>\s*\{/g)) {
      const visibleName = filterMatch[1];
      const filterSourceName = filterMatch[2];
      const entryName = filterMatch[3];
      const escapedVisibleName = escapeRegExp(visibleName);
      if (!new RegExp(`\\bsettingsNavigationSections\\s*:\\s*${escapedVisibleName}\\.filter\\(`).test(functionBody)
        || !new RegExp(`\\bvisibleSettingsSections\\s*:\\s*${escapedVisibleName}\\b`).test(functionBody)) continue;
      const filterBody = readBalancedBlock(functionBody, filterMatch.index + filterMatch[0].lastIndexOf("{"));
      const escapedEntryName = escapeRegExp(entryName);
      const switchMatches = [...filterBody.matchAll(new RegExp(`switch\\(\\s*${escapedEntryName}\\.slug\\s*\\)\\s*\\{`, "g"))];
      if (switchMatches.length !== 1) continue;
      const switchBody = readBalancedBlock(filterBody, switchMatches[0].index + switchMatches[0][0].lastIndexOf("{"));
      const gated = new Set();
      for (const returnMatch of switchBody.matchAll(/((?:case(?:`[^`]+`|"[^"]+"|'[^']+'|[A-Za-z_$][\w$-]*)\s*:\s*)+)return(?:!1|false)(?:;|(?=case|$))/g)) {
        for (const caseMatch of returnMatch[1].matchAll(/case(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*:/g)) {
          const slug = String(caseMatch[1] || caseMatch[2] || caseMatch[3] || caseMatch[4] || "");
          if (registered.has(slug)) gated.add(slug);
        }
      }
      candidates.push({
        functionName: functionMatch[1],
        filterSourceName,
        gatedSlugs: [...gated].sort(),
      });
    }
  }
  return candidates;
}

function parseNamedBindings(body, importedKey, localKey) {
  const bindings = [];
  for (const part of String(body).split(",")) {
    const match = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (!match) continue;
    bindings.push({ [importedKey]: match[1], [localKey]: match[2] || match[1] });
  }
  return bindings;
}

function parseNamedImports(source) {
  const imports = [];
  for (const match of String(source).matchAll(/import\s*\{([^{}]+)\}\s*from\s*(["'`])([^"'`]+)\2/g)) {
    for (const binding of parseNamedBindings(match[1], "importedName", "localName")) {
      imports.push({ ...binding, specifier: match[3] });
    }
  }
  return imports;
}

function parseNamedExports(source) {
  const exports = [];
  for (const match of String(source).matchAll(/export\s*\{([^{}]+)\}/g)) {
    exports.push(...parseNamedBindings(match[1], "localName", "exportedName"));
  }
  return exports;
}

function resolveAsarModulePath(modulePath, specifier) {
  if (!modulePath || !String(specifier).startsWith(".")) return "";
  return posix.normalize(posix.join(posix.dirname(modulePath), String(specifier)));
}

function normalizeModuleSources(evidence, source) {
  const sources = evidence?.moduleSources instanceof Map
    ? new Map(evidence.moduleSources)
    : new Map(Object.entries(evidence?.moduleSources || {}));
  const modulePath = String(evidence?.modulePath || "").replaceAll("\\", "/");
  if (modulePath) sources.set(modulePath, String(source));
  return { modulePath, sources };
}

function extractSlugArray(source, variableName) {
  const escapedVariableName = escapeRegExp(variableName);
  const bodies = [];
  for (const match of String(source).matchAll(new RegExp(`(?:^|[;,])\\s*(?:(?:var|let|const)\\s+)?${escapedVariableName}\\s*=\\s*\\[`, "g"))) {
    const body = readBalancedArray(source, match.index + match[0].lastIndexOf("["));
    const slugs = [...body.matchAll(/\{\s*slug\s*:\s*(?:`([^`]+)`|"([^"]+)"|'([^']+)')/g)]
      .map((entry) => String(entry[1] || entry[2] || entry[3] || ""))
      .filter(Boolean);
    if (slugs.length > 0 && new Set(slugs).size === slugs.length) bodies.push(slugs);
  }
  return bodies.length === 1 ? bodies[0] : [];
}

function hasNavigationRegistryEvidence({ candidate, definitionSource, modulePath, sources, registered }) {
  const sourceImports = parseNamedImports(definitionSource)
    .filter((entry) => entry.localName === candidate.filterSourceName);
  if (sourceImports.length !== 1) return false;
  const navigationPath = resolveAsarModulePath(modulePath, sourceImports[0].specifier);
  const navigationSource = sources.get(navigationPath);
  if (!navigationSource) return false;
  const navigationExports = parseNamedExports(navigationSource)
    .filter((entry) => entry.exportedName === sourceImports[0].importedName);
  if (navigationExports.length !== 1) return false;
  const navigationSlugs = extractSlugArray(navigationSource, navigationExports[0].localName);
  if (!navigationSlugs.includes("agent") || !navigationSlugs.includes("personalization")) return false;
  if (navigationSlugs.some((slug) => !registered.has(slug))) return false;
  return candidate.gatedSlugs.every((slug) => navigationSlugs.includes(slug));
}

function extractNamedFunctions(source) {
  const functions = [];
  for (const match of String(source).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]{0,1200})\)\s*\{/g)) {
    const parameter = match[2].trim().match(/^([A-Za-z_$][\w$]*)/)?.[1] || "";
    const body = readBalancedBlock(source, match.index + match[0].lastIndexOf("{"));
    if (body) functions.push({ name: match[1], parameter, body });
  }
  return functions;
}

function hasDirectRegistryIteration(functionBody, parameterName, registrationLocalName) {
  const escapedParameter = escapeRegExp(parameterName);
  const escapedRegistration = escapeRegExp(registrationLocalName);
  const settingsMatches = [...functionBody.matchAll(new RegExp(`\\{[^{}]{0,1600}\\bsettingsSections\\s*:\\s*([A-Za-z_$][\\w$]*)[^{}]{0,1600}\\}\\s*=\\s*${escapedParameter}\\b`, "g"))];
  for (const settingsMatch of settingsMatches) {
    const settingsLocal = escapeRegExp(settingsMatch[1]);
    const directPattern = new RegExp(`${settingsLocal}\\.(?:map|flatMap)\\(\\s*([A-Za-z_$][\\w$]*)\\s*=>[\\s\\S]{0,1600}${escapedRegistration}\\s*\\[\\s*\\1\\.slug\\s*\\]`);
    if (directPattern.test(functionBody)) return true;
    const groupPattern = new RegExp(`(?:^|[,{;])\\s*(?:(?:let|const|var)\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*\\[\\{[^{}]{0,1200}\\bsections\\s*:\\s*[A-Za-z_$][\\w$]*\\(\\s*${settingsLocal}\\b[^)]*\\)[^{}]{0,1200}\\}\\]`, "g");
    for (const groupMatch of functionBody.matchAll(groupPattern)) {
      const groupLocal = escapeRegExp(groupMatch[1]);
      const iterationPattern = new RegExp(`${groupLocal}\\.map\\(\\s*([A-Za-z_$][\\w$]*)\\s*=>[\\s\\S]{0,2400}\\1\\.sections\\.map\\(\\s*([A-Za-z_$][\\w$]*)\\s*=>[\\s\\S]{0,1600}${escapedRegistration}\\s*\\[\\s*\\2\\.slug\\s*\\]`);
      if (iterationPattern.test(functionBody)) return true;
    }
  }
  return false;
}

function forwardingRegion(functionBody) {
  for (const match of functionBody.matchAll(/(?:^|[;}])\s*\{/g)) {
    const openingIndex = match.index + match[0].lastIndexOf("{");
    const blockBody = readBalancedBlock(functionBody, openingIndex);
    if (/\breturn\b/.test(blockBody)) return functionBody.slice(0, openingIndex + blockBody.length + 2);
  }
  return functionBody;
}

function extractForwardedTargets(functionBody, parameterName) {
  const escapedParameter = escapeRegExp(parameterName);
  const spreadPattern = new RegExp(`\\.\\.\\.${escapedParameter}\\b`);
  const targets = [];
  const region = forwardingRegion(functionBody);
  for (const match of region.matchAll(new RegExp(`\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*\\{([^{}]{0,3200}\\.\\.\\.${escapedParameter}\\b[^{}]{0,3200})\\}\\s*\\)`, "g"))) {
    const spread = match[2].match(spreadPattern);
    if (!spread) continue;
    const afterSpread = match[2].slice((spread.index || 0) + spread[0].length);
    if (/\bsettingsSections\s*:/.test(afterSpread)) continue;
    targets.push(match[1]);
  }
  return targets;
}

function countRegistryConsumerPaths(functionsByName, functionName, registrationLocalName, visited = new Set()) {
  if (visited.has(functionName) || visited.size >= 6) return 0;
  const matches = functionsByName.get(functionName) || [];
  if (matches.length !== 1) return 0;
  const current = matches[0];
  if (!current.parameter) return 0;
  let count = hasDirectRegistryIteration(current.body, current.parameter, registrationLocalName) ? 1 : 0;
  const nextVisited = new Set(visited).add(functionName);
  for (const target of extractForwardedTargets(current.body, current.parameter)) {
    count += countRegistryConsumerPaths(functionsByName, target, registrationLocalName, nextVisited);
    if (count > 1) throw new Error("Ambiguous native Settings consumer path.");
  }
  return count;
}

function countConsumerChains({ candidate, registrationVariableName, definitionSource, modulePath, sources }) {
  const definitionExports = parseNamedExports(definitionSource);
  const visibilityExports = definitionExports.filter((entry) => entry.localName === candidate.functionName);
  const registrationExports = definitionExports.filter((entry) => entry.localName === registrationVariableName);
  if (visibilityExports.length !== 1 || registrationExports.length !== 1) return 0;
  let count = 0;
  for (const [consumerPath, consumerSource] of sources) {
    if (consumerPath === modulePath) continue;
    const imports = parseNamedImports(consumerSource)
      .filter((entry) => resolveAsarModulePath(consumerPath, entry.specifier) === modulePath);
    const visibilityImports = imports.filter((entry) => entry.importedName === visibilityExports[0].exportedName);
    const registrationImports = imports.filter((entry) => entry.importedName === registrationExports[0].exportedName);
    if (visibilityImports.length !== 1 || registrationImports.length !== 1) continue;
    const visibilityLocal = escapeRegExp(visibilityImports[0].localName);
    const registrationLocal = registrationImports[0].localName;
    const functions = extractNamedFunctions(consumerSource);
    const functionsByName = new Map();
    for (const entry of functions) functionsByName.set(entry.name, [...(functionsByName.get(entry.name) || []), entry]);
    const callPattern = new RegExp(`\\{[^{}]{0,1600}\\bsettingsNavigationSections\\s*:\\s*([A-Za-z_$][\\w$]*)[^{}]{0,1600}\\}\\s*=\\s*${visibilityLocal}\\s*\\(`, "g");
    for (const consumerFunction of functions) {
      for (const callMatch of consumerFunction.body.matchAll(callPattern)) {
      const derivedCollection = escapeRegExp(callMatch[1]);
        const componentTargets = [...consumerFunction.body.matchAll(new RegExp(`\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*\\{[^{}]{0,2400}\\bsettingsSections\\s*:\\s*${derivedCollection}\\b[^{}]{0,2400}\\}\\s*\\)`, "g"))]
          .map((match) => match[1]);
        let provenPaths = 0;
        for (const target of componentTargets) {
          provenPaths += countRegistryConsumerPaths(functionsByName, target, registrationLocal);
          if (provenPaths > 1) throw new Error("Ambiguous native Settings consumer path.");
        }
        if (provenPaths === 1) count += 1;
      }
    }
  }
  return count;
}

function extractNativeSettingsVisibilityGateContract(source, registrationContract, evidence = {}) {
  const registered = new Set(registrationContract.slugs);
  const { modulePath, sources } = normalizeModuleSources(evidence, source);
  if (!modulePath) return { matched: false, gatedSlugs: [] };
  const fullChains = [];
  for (const candidate of extractNativeSettingsVisibilityCandidates(source, registered)) {
    if (!hasNavigationRegistryEvidence({ candidate, definitionSource: source, modulePath, sources, registered })) continue;
    const consumerCount = countConsumerChains({
      candidate,
      registrationVariableName: registrationContract.variableName,
      definitionSource: source,
      modulePath,
      sources,
    });
    if (consumerCount > 1) throw new Error("Ambiguous native Settings consumer contract.");
    if (consumerCount === 1) fullChains.push(candidate);
  }
  if (fullChains.length > 1) throw new Error("Ambiguous native Settings visibility contract.");
  if (fullChains.length === 0) return { matched: false, gatedSlugs: [] };
  return { matched: true, gatedSlugs: fullChains[0].gatedSlugs };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readBalancedBlock(source, openingBraceIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(openingBraceIndex + 1, index);
  }
  return "";
}

function readBalancedArray(source, openingBracketIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openingBracketIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") depth += 1;
    else if (character === "]" && --depth === 0) return source.slice(openingBracketIndex + 1, index);
  }
  return "";
}

export function compareNativeSettingsSlugSets(expectedSlugs = [], visibleSlugs = [], explicitGatedSlugs = []) {
  const expected = [...new Set(expectedSlugs.map(String))].sort();
  const visible = visibleSlugs.map(String);
  const counts = new Map();
  for (const slug of visible) counts.set(slug, (counts.get(slug) || 0) + 1);
  const visibleSet = new Set(visible);
  const expectedSet = new Set(expected);
  const explicitGatedSet = new Set(explicitGatedSlugs.map(String));
  const missing = expected.filter((slug) => !visibleSet.has(slug));
  const gated = missing.filter((slug) => explicitGatedSet.has(slug));
  const missingWithoutGateEvidence = missing.filter((slug) => !explicitGatedSet.has(slug));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([slug]) => slug).sort();
  const unexpected = [...visibleSet].filter((slug) => !expectedSet.has(slug)).sort();
  return {
    ok: missingWithoutGateEvidence.length === 0 && duplicates.length === 0 && unexpected.length === 0,
    expected,
    visible,
    gated,
    missingWithoutGateEvidence,
    duplicates,
    unexpected,
  };
}

function alignedAsarDataOffset(headerSize) {
  const prefixSize = 16;
  return prefixSize + headerSize + ((4 - ((prefixSize + headerSize) % 4)) % 4);
}

function walkAsarFiles(node, prefix, entries) {
  for (const [name, child] of Object.entries(node?.files || {})) {
    const itemPath = prefix ? `${prefix}/${name}` : name;
    if (child?.files) walkAsarFiles(child, itemPath, entries);
    else if (!child?.unpacked && /\.js$/i.test(itemPath)) entries.push({
      path: itemPath,
      offset: Number(child?.offset || 0),
      size: Number(child?.size || 0),
    });
  }
}

export function readNativeSettingsContract(asarPath) {
  const fd = openSync(asarPath, "r");
  try {
    const prefix = Buffer.alloc(16);
    readSync(fd, prefix, 0, prefix.length, 0);
    const headerSize = prefix.readUInt32LE(12);
    const headerBuffer = Buffer.alloc(headerSize);
    readSync(fd, headerBuffer, 0, headerSize, 16);
    const header = JSON.parse(headerBuffer.toString("utf8"));
    const dataOffset = alignedAsarDataOffset(headerSize);
    const entries = [];
    walkAsarFiles(header, "", entries);
    const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
    const definitions = [];
    const consumerSources = new Map();
    for (const entry of entries) {
      if (entry.size <= 0 || entry.size > 20 * 1024 * 1024) continue;
      const buffer = Buffer.alloc(entry.size);
      readSync(fd, buffer, 0, buffer.length, dataOffset + entry.offset);
      const text = buffer.toString("utf8");
      if (text.includes("settingsNavigationSections") && text.includes("settingsSections") && text.includes(".slug]")) {
        consumerSources.set(entry.path, text);
      }
      if (!text.includes("settings") || !text.includes("agent")) continue;
      const registrationContract = extractNativeSettingsRegistrationContract(text);
      if (registrationContract) definitions.push({ path: entry.path, text, registrationContract });
    }
    const unique = [...new Map(definitions.map((definition) => [
      JSON.stringify(definition.registrationContract.slugs),
      definition.registrationContract.slugs,
    ])).values()];
    if (unique.length !== 1) throw new Error(`Expected one native Settings registration contract, found ${unique.length}.`);
    const registrationSlugs = unique[0];
    const registrationSet = new Set(registrationSlugs);
    const matchingVisibilityContracts = [];
    for (const definition of definitions.filter((entry) => JSON.stringify(entry.registrationContract.slugs) === JSON.stringify(registrationSlugs))) {
      const moduleSources = new Map(consumerSources);
      moduleSources.set(definition.path, definition.text);
      const imports = parseNamedImports(definition.text);
      for (const candidate of extractNativeSettingsVisibilityCandidates(definition.text, registrationSet)) {
        for (const sourceImport of imports.filter((entry) => entry.localName === candidate.filterSourceName)) {
          const dependencyPath = resolveAsarModulePath(definition.path, sourceImport.specifier);
          const dependency = entryByPath.get(dependencyPath);
          if (!dependency || dependency.size <= 0 || dependency.size > 20 * 1024 * 1024 || moduleSources.has(dependencyPath)) continue;
          const dependencyBuffer = Buffer.alloc(dependency.size);
          readSync(fd, dependencyBuffer, 0, dependencyBuffer.length, dataOffset + dependency.offset);
          moduleSources.set(dependencyPath, dependencyBuffer.toString("utf8"));
        }
      }
      const visibilityContract = extractNativeSettingsVisibilityGateContract(
        definition.text,
        definition.registrationContract,
        { modulePath: definition.path, moduleSources },
      );
      if (visibilityContract.matched) matchingVisibilityContracts.push(visibilityContract);
    }
    if (matchingVisibilityContracts.length !== 1) {
      throw new Error(`Expected one native Settings visibility contract, found ${matchingVisibilityContracts.length}.`);
    }
    const gatedSlugs = matchingVisibilityContracts[0].gatedSlugs
      .filter((slug) => registrationSet.has(slug))
      .sort();
    return { registrationSlugs, gatedSlugs };
  } finally {
    closeSync(fd);
  }
}

export function readNativeSettingsRegistrationSlugs(asarPath) {
  return readNativeSettingsContract(asarPath).registrationSlugs;
}

export function classifyUnsupportedExternalSettingsTarget({ href = "", label = "" } = {}) {
  const normalizedHref = String(href).trim();
  const normalizedLabel = String(label).replace(/\s+/g, " ").trim();
  const lowerHref = normalizedHref.toLowerCase();
  const knownSettingsHref = lowerHref.includes("chatgpt.com/#settings")
    || lowerHref.includes("chatgpt.com/open-security-settings");
  const providerHref = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com)(?:[/:?#]|$)/i.test(normalizedHref);
  const accountSurfaceLabel = /^(?:(?:ChatGPT|OpenAI)\s+)?(?:Account|Account Settings|Security Settings|Usage|Profile)$|^(?:Manage|Open)\s+(?:Account|Account Settings|Security Settings|Usage|Profile)$|^(?:(?:ChatGPT|OpenAI)\s*)?(?:账户|账号|账户设置|账号设置|安全设置|用量|使用情况|个人资料|个人档案)$|^(?:管理|打开)(?:账户|账号|账户设置|账号设置|安全设置|用量|使用情况|个人资料|个人档案)$/i.test(normalizedLabel);

  if (knownSettingsHref) {
    return { href: normalizedHref, label: normalizedLabel, reason: "known-chatgpt-settings" };
  }
  if (accountSurfaceLabel && (providerHref || normalizedHref.length === 0)) {
    return { href: normalizedHref, label: normalizedLabel, reason: providerHref ? "provider-account-surface" : "button-account-surface" };
  }
  return null;
}

export function classifyNativeSettingsCrashSnapshot({
  headings = [],
  buttons = [],
  bodyText = "",
  hasComposer = false,
} = {}) {
  if (hasComposer === true) return false;
  const normalizedHeadings = Array.isArray(headings)
    ? headings.map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  const normalizedButtons = Array.isArray(buttons)
    ? buttons.map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
    : [];
  const normalizedBody = String(bodyText ?? "").replace(/\s+/g, " ").trim();
  const fatalHeading = normalizedHeadings.some((heading) => /^(?:(?:ChatGPT|Anti-Codex)\s*)?(?:已意外停止|unexpectedly\s+(?:stopped|quit|closed)|has\s+unexpectedly\s+(?:stopped|crashed)|(?:quit|stopped|closed)\s+unexpectedly)[.!。！]?$/i.test(heading));
  const genericError = normalizedBody.length > 0
    && normalizedBody.length <= 1_600
    && /(?:^|\s)(?:糟糕[，,]\s*出错了|Oops,?\s+an error has occurred|Something went wrong)[.!。！]?(?:\s|$)/i.test(normalizedBody);
  const recoveryAction = normalizedButtons.some((label) => /^(?:重试|重新加载|重新启动|重启|再试一次|retry|reload|restart|try again)$/i.test(label));
  return recoveryAction && (fatalHeading || genericError);
}
