import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const repairScript = readFileSync(resolve(root, "scripts", "repair-anticodex-shortcuts.ps1"), "utf8");

function extractPowerShellStringArray(source, variableName) {
  const marker = `$${variableName} = @(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${variableName}`);
  const close = source.indexOf("\n)", start);
  assert.notEqual(close, -1, `missing ${variableName} close`);
  return [...source.slice(start, close).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("shortcut repair searches known Codex and DeepCodex residual shortcut names", () => {
  const names = extractPowerShellStringArray(repairScript, "residualShortcutNames");

  assert.ok(names.includes("Codex.lnk"));
  assert.ok(names.includes("Codex Desktop.lnk"));
  assert.ok(names.includes("DeepCodex.lnk"));
  assert.ok(names.includes("DeepCodex Desktop.lnk"));
  assert.ok(!names.includes("Anti-Codex.lnk"));
  assert.ok(!names.includes("Sync Anti-Codex with Codex.lnk"));
  assert.ok(!names.includes("Rollback Anti-Codex.lnk"));
  assert.ok(!names.includes("Manage Anti-Codex.lnk"));
});

test("shortcut repair protects official Anti-Codex entries before deleting residual shortcuts", () => {
  const requiredEntries = [
    "Anti-Codex.lnk",
    "Sync Anti-Codex with Codex.lnk",
    "Rollback Anti-Codex.lnk",
    "Manage Anti-Codex.lnk",
  ];

  for (const entry of requiredEntries) {
    assert.ok(repairScript.includes(entry), `missing official shortcut entry ${entry}`);
  }
  assert.match(repairScript, /\$protectedShortcutPaths\[/);
  assert.match(repairScript, /\$protectedShortcutPaths\.ContainsKey\(\$pathKey\)/);

  const protectionCheck = repairScript.indexOf("$protectedShortcutPaths.ContainsKey($pathKey)");
  const deletion = repairScript.indexOf("Remove-Item -LiteralPath $path -Force");
  assert.ok(protectionCheck > 0, "missing protected shortcut guard");
  assert.ok(deletion > protectionCheck, "residual deletion must happen after protected shortcut guard");
});

test("shortcut repair reports any residual shortcut that cannot be removed safely", () => {
  assert.match(repairScript, /residualShortcutRoots/);
  assert.match(repairScript, /legacyDeepCodexStartMenuDir/);
  assert.match(repairScript, /Repair-AntiCodexResidualShortcuts/);
  assert.match(repairScript, /Residual shortcut requires manual review/);
  assert.match(repairScript, /Residual shortcut could not be removed/);
  assert.match(repairScript, /residualShortcutCount/);
  assert.match(repairScript, /removedResidualShortcutCount/);
  assert.match(repairScript, /reportedResidualShortcutCount/);
  assert.match(repairScript, /residualShortcuts/);
});

test("shortcut repair does not delete the user's normal desktop Codex shortcut by name alone", () => {
  const shouldRemoveIndex = repairScript.indexOf("$shouldRemove = (");
  assert.notEqual(shouldRemoveIndex, -1, "missing residual removal decision");
  const shouldRemoveBlock = repairScript.slice(shouldRemoveIndex, repairScript.indexOf(")", shouldRemoveIndex) + 1);

  assert.match(shouldRemoveBlock, /ownedByAntiCodexOrDeepCodex/);
  assert.match(shouldRemoveBlock, /removeCodexByName/);
  assert.match(shouldRemoveBlock, /isDeepCodexName/);
  assert.doesNotMatch(shouldRemoveBlock, /isCodexDesktopName/);
  assert.doesNotMatch(repairScript, /\$isCodexDesktopName\s*=/);
});

test("desktop Codex and Codex Desktop entries are not removed by name alone", () => {
  const desktopRoot = repairScript.match(
    /\[pscustomobject\]@\{ path = \$desktop; location = "desktop"; removeCodexByName = \$(true|false) \}/,
  );
  assert.ok(desktopRoot, "missing desktop residual shortcut root");
  assert.equal(desktopRoot[1], "false");

  assert.doesNotMatch(
    repairScript,
    /\$isCodexDesktopName\s*=\s*[\s\S]*?\$shouldRemove\s*=\s*\([\s\S]*?\$isCodexDesktopName[\s\S]*?\)/,
    "Codex Desktop shortcuts must require Anti-Codex or DeepCodex ownership evidence before removal",
  );
});

test("desktop residual ownership is based on shortcut target evidence, not its name or location", () => {
  const ownershipFunction = repairScript.match(
    /function Test-AntiCodexOwnedResidualShortcut \{[\s\S]*?\n\}/,
  );
  assert.ok(ownershipFunction, "missing ownership test helper");

  assert.doesNotMatch(ownershipFunction[0], /\[string\]\$ShortcutInfo\.path/);
  assert.doesNotMatch(ownershipFunction[0], /\[string\]\$ShortcutInfo\.displayName/);
  assert.match(ownershipFunction[0], /\[string\]\$ShortcutInfo\.actualTarget/);
  assert.match(ownershipFunction[0], /\[string\]\$ShortcutInfo\.actualArguments/);
  assert.match(ownershipFunction[0], /\[string\]\$ShortcutInfo\.actualLauncherTarget/);
});
