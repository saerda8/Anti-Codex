export function patchCompiledProfileDropdownSettings(text) {
  if (!text.includes("id:`codex.profileDropdown.settingsPage`")) return text;
  if (text.includes("anticodex-manager") && text.includes("__ANTICODEX_OPEN_MANAGER__")) return text;

  const modern = /let A;t\[27\]!==p\|\|t\[28\]!==v\?\(A=\(0,J\.jsx\)\(M,\{leftIcon:te,keyboardShortcut:v,onClick:p,children:ne\}\),t\[27\]=p,t\[28\]=v,t\[29\]=A\):A=t\[29\];let j;/;
  const modernMatch = modern.exec(text);
  if (modernMatch) {
    const replacement = "let A=(0,J.jsx)(M,{onClick:window.__ANTICODEX_OPEN_MANAGER__,children:`\\u7ba1\\u7406`});let j;";
    if (replacement.length > modernMatch[0].length) {
      throw new Error(`Profile dropdown modern replacement grew: ${replacement.length} > ${modernMatch[0].length}`);
    }
    return text.slice(0, modernMatch.index) + replacement + " ".repeat(modernMatch[0].length - replacement.length) + text.slice(modernMatch.index + modernMatch[0].length);
  }

  const codex2738 = /let (?<label>[\w$]+);t\[\d+\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\((?<label2>\k<label>)=\(0,(?<jsx>[\w$]+)\.jsx\)\((?<message>[\w$]+),\{id:`codex\.profileDropdown\.settingsPage`,defaultMessage:`Settings`,description:`Menu item to open Codex settings page`\}\),t\[\d+\]=\k<label>\):\k<label>=t\[\d+\];let (?<item>[\w$]+);t\[\d+\]!==(?<open>[\w$]+)\|\|t\[\d+\]!==(?<shortcut>[\w$]+)\?\((?<item2>\k<item>)=\(0,\k<jsx>\.jsx\)\((?<component>[\w$]+),\{leftIcon:(?<icon>[\w$]+),keyboardShortcut:\k<shortcut>,onClick:\k<open>,children:\k<label>\}\),t\[\d+\]=\k<open>,t\[\d+\]=\k<shortcut>,t\[\d+\]=\k<item>\):\k<item>=t\[\d+\];/;
  const codex2738Match = codex2738.exec(text);
  if (codex2738Match?.groups) {
    const { item, open, shortcut, jsx, component, icon, label, message } = codex2738Match.groups;
    const manager = `(0,${jsx}.jsx)(${component},{leftIcon:${icon},onClick:globalThis.__ANTICODEX_OPEN_MANAGER__,children:\`\\u7ba1\\u7406\`},\`anticodex-manager\`)`;
    const managerName = `${item}m`;
    const childrenMarker = `${item},null`;
    const childrenIndex = text.indexOf(childrenMarker, codex2738Match.index);
    if (childrenIndex < 0) throw new Error("Profile dropdown Codex 26.924.2738 children group not found");
    const replacement = `let ${label}=(0,${jsx}.jsx)(${message},{id:\`codex.profileDropdown.settingsPage\`,defaultMessage:\`Settings\`,description:\`Menu item to open Codex settings page\`}),${item}=(0,${jsx}.jsx)(${component},{leftIcon:${icon},keyboardShortcut:${shortcut},onClick:${open},children:${label}}),${managerName}=${manager};`;
    const tail = text.slice(codex2738Match.index + codex2738Match[0].length, childrenIndex);
    const childrenReplacement = `${item},${managerName}`;
    const originalLength = childrenIndex + childrenMarker.length - codex2738Match.index;
    const combined = replacement + tail + childrenReplacement;
    if (combined.length > originalLength) {
      throw new Error(`Profile dropdown Codex 26.924.2738 replacement grew: ${combined.length} > ${originalLength}`);
    }
    return text.slice(0, codex2738Match.index) + combined + " ".repeat(originalLength - combined.length) + text.slice(childrenIndex + childrenMarker.length);
  }

  const compiledSettings = /let ([\w$]+);[^;]*?\1=\(0,([\w$]+)\.jsx\)\(([\w$]+),\{id:`codex\.profileDropdown\.settingsPage`,defaultMessage:`Settings`,description:`Menu item to open Codex settings page`\}\)[^;]*?;let ([\w$]+);[^;]*?\4=\(0,\2\.jsx\)\(([\w$]+),\{LeftIcon:([\w$]+),keyboardShortcut:([\w$]+),onClick:([\w$]+),children:\1\}\)[^;]*?(?=;let [\w$]+;)/g;
  return text.replace(compiledSettings, (match, label, jsx, message, item, menuItem, icon, shortcut, openSettings) => {
    const replacement = `let ${label}=(0,${jsx}.jsx)(${message},{id:\`codex.profileDropdown.settingsPage\`,defaultMessage:\`Settings\`,description:\`Menu item to open Codex settings page\`}),${item}=[(0,${jsx}.jsx)(${menuItem},{LeftIcon:${icon},keyboardShortcut:${shortcut},onClick:${openSettings},children:${label}}),(0,${jsx}.jsx)(${menuItem},{LeftIcon:${icon},onClick:globalThis.__ANTICODEX_OPEN_MANAGER__,children:\`\\u7ba1\\u7406\`},\`anticodex-manager\`)]`;
    if (replacement.length > match.length) {
      throw new Error(`Profile dropdown replacement grew: ${replacement.length} > ${match.length}`);
    }
    return replacement + " ".repeat(match.length - replacement.length);
  });
}
