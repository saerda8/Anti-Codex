import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyNativeSettingsCrashSnapshot,
  classifyUnsupportedExternalSettingsTarget,
} from "../../scripts/anticodex-native-settings-contract.mjs";

const scriptUrl = new URL("../../scripts/run-anticodex-manager-action-real-mouse.mjs", import.meta.url);

test("Manager update runner uses only real CDP mouse clicks and requires explicit confirmation", () => {
  assert.equal(existsSync(scriptUrl), true, "real-mouse Manager action runner is missing");
  const source = readFileSync(scriptUrl, "utf8");

  assert.match(source, /Input\.dispatchMouseEvent/);
  assert.match(source, /\u6253\u5f00\u4e2a\u4eba\u8d44\u6599\u83dc\u5355/);
  assert.match(source, /\u7ba1\u7406/);
  assert.match(source, /syncHost/);
  assert.match(source, /\u540c\u6b65 Codex \u66f4\u65b0/);
  assert.doesNotMatch(source, /\u4e00\u952e\u66f4\u65b0/);
  assert.match(source, /data-confirming-high-impact/);
  assert.match(source, /function pickPrimaryAppTarget\(targets\)/);
  assert.match(source, /avatar-overlay/);
  assert.match(source, /\^app:\\\/\\\/-\\\/index\\\.html/);
  assert.match(source, /const target = pickPrimaryAppTarget\(targets\)/);
  assert.doesNotMatch(source, /targets\.find\(\(item\).*Anti-Codex\|app:/);
  assert.match(source, /existingManagerClosePoint/);
  assert.match(source, /settledManagerEntryPoint/);
  assert.match(source, /await sleep\(200\)/);
  assert.match(source, /sleep\(200\);\s+const settledManagerEntryPoint[\s\S]*?realMouseClick\(settledManagerEntryPoint, "管理"\)/);
  assert.match(source, /value\?\.overlay === true, 5_000/);
  assert.doesNotMatch(source, /__ANTICODEX_OPEN_MANAGER__\s*\(/);
  assert.match(source, /if \(!promptSettingsSaveRestore\) \{[\s\S]*?realMouseWheel/);
  assert.match(source, /trim\(\) === '保存'\);\s+button\?\.scrollIntoView\(\{ block: 'center' \}\)/);
  assert.match(source, /--prompt-settings-restore-default/);
  assert.match(source, /Refusing to restore unknown native custom instructions during recovery/);
  assert.match(source, /promptSettingsRecoveryFileValue !== promptSettingsAcceptanceValue/);
  assert.match(source, /promptSettingsSaveRestore \|\| promptSettingsRestoreDefault/);
  assert.match(source, /button\.anticodex-close\[aria-label="\u5173\u95ed"\]/);
  assert.match(source, /Codex \u5b8c\u6574\u5408\u5e76\u63d0\u793a\u8bcd\uff08Gemini \/ Claude \/ \u7b2c\u4e09\u65b9\uff09/);
  assert.match(source, /Codex \u539f\u751f\u81ea\u5b9a\u4e49\u6307\u4ee4 \(AGENTS\.md\)/);
  assert.match(source, /Anti-Codex \u9644\u52a0\u63d0\u793a\u8bcd\uff08Gemini \/ Claude \/ \u7b2c\u4e09\u65b9\uff09/);
  assert.match(source, /\u6a21\u578b\u63d0\u4f9b\u65b9\u9690\u85cf\u63d0\u793a\u8bcd/);
  assert.doesNotMatch(source, /\u4ec5 Antigravity|Antigravity \u63d0\u4f9b\u65b9\u5e95\u5c42/);
  assert.doesNotMatch(source, /Codex \u7cfb\u7edf\u63d0\u793a\u8bcd/);
  assert.doesNotMatch(source, /Anti-Codex \u7528\u6237\u63d0\u793a\u8bcd/);
  assert.match(source, /--confirm/);
  assert.doesNotMatch(source, /\.click\s*\(|dispatchEvent\s*\(\s*new MouseEvent/);
});

test("real-mouse runner can audit native Settings without starting clients or leaking custom instructions", () => {
  const source = readFileSync(scriptUrl, "utf8");

  assert.match(source, /nativeSettingsAcceptance/);
  assert.match(source, /--native-settings/);
  assert.match(source, /pickUniquePrimaryAppTarget/);
  assert.match(source, /Expected exactly one visible Anti-Codex page target/);
  assert.match(source, /data-settings-panel-slug/);
  assert.match(source, /getAttribute\('aria-current'\) === 'page'/);
  assert.doesNotMatch(source, /location\.pathname\.includes\('\/settings\//);
  assert.match(source, /async function auditNativeAgentSettings\(\) \{[\s\S]*?await waitFor\(/);
  assert.match(source, /nav\[aria-label="Settings"\], nav\[aria-label="\u8bbe\u7f6e"\]/);
  assert.match(source, /classifyUnsupportedExternalSettingsTarget/);
  assert.match(source, /panel\?\.querySelectorAll\?\.\('a,button'\)/);
  assert.match(source, /externalTargets/);
  assert.match(source, /pages\.flatMap\(\(page\) => page\.externalTargets/);
  assert.doesNotMatch(source, /externalChatGptSettingsHidden:\s*true/);
  const nativeAcceptanceSource = source.slice(
    source.indexOf("async function runNativeSettingsAcceptance"),
    source.indexOf("let result;"),
  );
  const navExternalScanSource = nativeAcceptanceSource.slice(
    nativeAcceptanceSource.indexOf("const externalTargets"),
    nativeAcceptanceSource.indexOf("return { ok:", nativeAcceptanceSource.indexOf("const externalTargets")),
  );
  assert.match(navExternalScanSource, /classifyUnsupportedExternalSettingsTarget/);
  assert.doesNotMatch(navExternalScanSource, /href\.includes\(|Account\$|Security\(\?: Settings\)/);
  const openSettingsSource = source.slice(
    source.indexOf("async function openNativeSettingsSection"),
    source.indexOf("async function replaceNativeInstructions"),
  );
  const externalScanSource = openSettingsSource.slice(
    openSettingsSource.indexOf("const externalTargets"),
    openSettingsSource.indexOf("return {", openSettingsSource.indexOf("const externalTargets")),
  );
  assert.doesNotMatch(externalScanSource, /!entry\.disabled|aria-disabled/);
  assert.match(source, /localSecurityLabels/);
  assert.match(source, /Approval policy|\u6279\u51c6\u7b56\u7565/);
  assert.match(source, /Sandbox settings|\u6c99\u76d2\u8bbe\u7f6e/);
  assert.match(source, /managed by admin policy|\u7ba1\u7406\u5458\u7b56\u7565/);
  assert.match(source, /Allow network access|\u5141\u8bb8\u7f51\u7edc\u8bbf\u95ee/);
  assert.match(source, /Full access|\u5b8c\u5168\u8bbf\u95ee/);
  assert.match(source, /Custom instructions|\u81ea\u5b9a\u4e49\u6307\u4ee4/);
  assert.match(source, /AGENTS\.md/);
  assert.match(source, /randomUUID\(\)/);
  assert.match(source, /Input\.insertText/);
  assert.match(source, /restoreNativeInstructions/);
  assert.match(source, /finally/);
  assert.match(source, /inspectOnly/);
  assert.doesNotMatch(source, /Network\.setBlockedURLs|Fetch\.enable|Fetch\.requestPaused/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFileSync/);
});

test("native Settings external-target policy rejects only account surfaces", () => {
  const injectedClassifier = Function(`return (${classifyUnsupportedExternalSettingsTarget.toString()});`)();
  assert.equal(injectedClassifier({ href: "https://chatgpt.com/#settings", label: "" })?.reason, "known-chatgpt-settings");
  assert.equal(injectedClassifier({ href: "https://chatgpt.com/open-security-settings", label: "Security" })?.reason, "known-chatgpt-settings");
  assert.equal(injectedClassifier({ href: "https://openai.com/account", label: "Manage Account" })?.reason, "provider-account-surface");
  assert.equal(injectedClassifier({ href: "", label: "管理账户" })?.reason, "button-account-surface");
  assert.equal(injectedClassifier({ href: "https://openai.com/docs", label: "API documentation" }), null);
  assert.equal(injectedClassifier({ href: "app://-/settings/security", label: "Security Settings" }), null);
  assert.equal(injectedClassifier({ href: "https://example.com/account", label: "Account" }), null);
});

test("native Settings crash policy requires a visible fatal heading and recovery action", () => {
  const classify = Function(`return (${classifyNativeSettingsCrashSnapshot.toString()});`)();
  assert.equal(classify({ headings: ["Anti-Codex 已意外停止"], buttons: ["打开 Config.toml", "重启"] }), true);
  assert.equal(classify({ headings: ["已意外停止"], buttons: ["重试"] }), true);
  assert.equal(classify({ headings: [], buttons: ["重试"], bodyText: "糟糕，出错了 重试" }), true);
  assert.equal(classify({ headings: ["Settings"], buttons: ["保存"], bodyText: "聊天里说：已意外停止", hasComposer: true }), false);
  assert.equal(classify({ headings: ["讨论已意外停止的原因"], buttons: ["重试"] }), false);
});
