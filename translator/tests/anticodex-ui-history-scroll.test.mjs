import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const uiSmoke = readFileSync(resolve(root, "scripts", "test-anticodex-ui-chat-smoke.mjs"), "utf8");

test("history reopen scans a virtualized sidebar before declaring an older task missing", () => {
  assert.match(uiSmoke, /function historyShowMoreExpression\(/);
  assert.match(uiSmoke, /展开显示\|show more/i);
  assert.match(uiSmoke, /historyExpandAttempt\s*<\s*8/);
  assert.match(uiSmoke, /historyExpandEvidence/);
  assert.match(uiSmoke, /function historySidebarScrollExpression\(/);
  assert.match(uiSmoke, /scrollHeight\s*>\s*[^\n]+clientHeight/);
  assert.match(uiSmoke, /historyScrollAttempt\s*<\s*40/);
  assert.match(uiSmoke, /sameChatClickExpression\(titleNeedle, expectedTaskId\)/);
  assert.match(uiSmoke, /historyScrollEvidence/);
});

test("history sidebar scanning is bounded and restores the original scroll position on failure", () => {
  assert.match(uiSmoke, /originalScrollTop/);
  assert.match(uiSmoke, /restoreOriginal/);
  assert.match(uiSmoke, /maxScrollTop\s*=\s*Math\.max\(0,\s*target\.scrollHeight\s*-\s*target\.clientHeight\)/);
  assert.match(uiSmoke, /Math\.min\(maxScrollTop/);
});
