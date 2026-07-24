function replacePadded(text, search, replacement) {
  const index = text.indexOf(search);
  if (index < 0) return text;
  if (replacement.length > search.length) {
    throw new Error(`Profile dropdown replacement grew: ${replacement.length} > ${search.length}`);
  }
  return text.slice(0, index) + replacement + " ".repeat(search.length - replacement.length) + text.slice(index + search.length);
}

export function patchCompiledProfileDropdownSettings(text) {
  if (text.includes("anticodex-manager") && text.includes("__ANTICODEX_OPEN_MANAGER__")) return text;
  if (!text.includes("id:`codex.profileDropdown.settingsPage`")) return text;

  const compiledSettings = /let ([\w$]+);[^;]*?\1=\(0,([\w$]+)\.jsx\)\(([\w$]+),\{id:`codex\.profileDropdown\.settingsPage`,defaultMessage:`Settings`,description:`Menu item to open Codex settings page`\}\)[^;]*?;let ([\w$]+);[^;]*?\4=\(0,\2\.jsx\)\(([\w$]+),\{LeftIcon:([\w$]+),keyboardShortcut:([\w$]+),onClick:([\w$]+),children:\1\}\)[^;]*?(?=;let [\w$]+;)/;
  const match = compiledSettings.exec(text);
  if (!match) return text;

  const [, label, jsx, message, item, menuItem, icon, shortcut, openSettings] = match;
  const replacement = `let ${label}=(0,${jsx}.jsx)(${message},{id:\`codex.profileDropdown.settingsPage\`,defaultMessage:\`Settings\`,description:\`Menu item to open Codex settings page\`}),${item}=[(0,${jsx}.jsx)(${menuItem},{LeftIcon:${icon},keyboardShortcut:${shortcut},onClick:${openSettings},children:${label}}),(0,${jsx}.jsx)(${menuItem},{LeftIcon:${icon},onClick:globalThis.__ANTICODEX_OPEN_MANAGER__,children:\`\\u7ba1\\u7406\`},\`anticodex-manager\`)]`;
  return replacePadded(text, match[0], replacement);
}
