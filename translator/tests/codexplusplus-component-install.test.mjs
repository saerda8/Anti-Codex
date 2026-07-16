import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");

test("CodexPlusPlus component installer is hash-pinned and isolated", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-codexplusplus-component.ps1"), "utf8");
  assert.match(installer, /third_party\\codexplusplus\\upstream\.json/);
  assert.match(installer, /verification\.launcherReleaseBuild/);
  assert.match(installer, /Get-FileHash[^\n]+SHA256/);
  assert.match(installer, /Join-Path \$resolvedInstallRoot "components\\codexplusplus"/);
  assert.match(installer, /Join-Path \$componentRoot "codex-plus-plus\.exe"/);
  assert.match(installer, /codexplusplus-component-manifest-v1/);
  assert.match(installer, /AGPL-3\.0-only/);
  assert.match(installer, /patchCommit/);
  assert.match(installer, /-ne \$expectedHash/);
  assert.doesNotMatch(installer, /Invoke-WebRequest|Start-BitsTransfer|git clone/i);
});

test("main installer wires the separately verified component on full installs only", () => {
  const installer = readFileSync(resolve(root, "scripts", "install-anticodex.ps1"), "utf8");
  assert.match(installer, /install-codexplusplus-component\.ps1/);
  assert.match(installer, /if \(-not \$HostOnly\)[\s\S]*?install-codexplusplus-component/i);
});
