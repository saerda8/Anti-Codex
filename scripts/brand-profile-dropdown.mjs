export function patchCompiledProfileDropdownSettings(text) {
  if (!text.includes("id:`codex.profileDropdown.settingsPage`")) return text;

  const compiledSettings = /let ([\w$]+);[^;]*?\1=\(0,([\w$]+)\.jsx\)\(([\w$]+),\{id:`codex\.profileDropdown\.settingsPage`,defaultMessage:`Settings`,description:`Menu item to open Codex settings page`\}\)[^;]*?;let ([\w$]+);[^;]*?\4=\(0,\2\.jsx\)\(([\w$]+),\{LeftIcon:([\w$]+),keyboardShortcut:([\w$]+),onClick:([\w$]+),children:\1\}\)[^;]*?(?=;let [\w$]+;)/g;
  return text.replace(compiledSettings, (match, label, jsx, message, item, menuItem, icon, shortcut, openSettings) => {
    const replacement = `let ${label}=(0,${jsx}.jsx)(${message},{id:\`codex.profileDropdown.settingsPage\`,defaultMessage:\`Settings\`,description:\`Menu item to open Codex settings page\`}),${item}=[(0,${jsx}.jsx)(${menuItem},{LeftIcon:${icon},keyboardShortcut:${shortcut},onClick:${openSettings},children:${label}}),(0,${jsx}.jsx)(${menuItem},{LeftIcon:${icon},onClick:globalThis.__ANTICODEX_OPEN_MANAGER__,children:\`\\u7ba1\\u7406\`},\`anticodex-manager\`)]`;
    if (replacement.length > match.length) {
      throw new Error(`Profile dropdown replacement grew: ${replacement.length} > ${match.length}`);
    }
    return replacement + " ".repeat(match.length - replacement.length);
  });
}
