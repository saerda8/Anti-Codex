import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

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
  assert.match(source, /button\.anticodex-close\[aria-label="\u5173\u95ed"\]/);
  assert.match(source, /CodexPlusPlus \u5408\u5e76\u63d0\u793a\u8bcd\uff08\u4ec5 Antigravity\uff09/);
  assert.match(source, /Codex \u539f\u751f\u81ea\u5b9a\u4e49\u6307\u4ee4 \(AGENTS\.md\)/);
  assert.match(source, /Anti-Codex \u9644\u52a0\u63d0\u793a\u8bcd\uff08\u4ec5 Antigravity\uff09/);
  assert.doesNotMatch(source, /Codex \u7cfb\u7edf\u63d0\u793a\u8bcd/);
  assert.doesNotMatch(source, /Anti-Codex \u7528\u6237\u63d0\u793a\u8bcd/);
  assert.match(source, /--confirm/);
  assert.doesNotMatch(source, /\.click\s*\(|dispatchEvent\s*\(\s*new MouseEvent/);
});
