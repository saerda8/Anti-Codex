import test from "node:test";
import assert from "node:assert/strict";

import * as brandPatchCompat from "../../scripts/brand-patch-compat.mjs";

const { hasProductNameDrivenSessionTitle } = brandPatchCompat;

test("patches Codex 26.609 system window titles without changing bundle size", () => {
  const source = [
    "let M=new r.BrowserWindow({width:b,height:x,",
    "title:i??r.app.getName(),backgroundColor:A});",
    "let re=async({show:e})=>{",
    "let n=await N.createPrimaryWindow({title:r.app.getName(),show:e});",
    "return n};",
  ].join("");

  assert.equal(hasProductNameDrivenSessionTitle(source), true);
  assert.equal(
    typeof brandPatchCompat.patchProductNameDrivenSessionTitle,
    "function",
  );
  const { patchProductNameDrivenSessionTitle } = brandPatchCompat;
  const patched = patchProductNameDrivenSessionTitle(source);

  assert.equal(patched.length, source.length);
  assert.doesNotMatch(patched, /title:i\?\?r\.app\.getName\(\)/);
  assert.doesNotMatch(patched, /title:r\.app\.getName\(\)/);
  assert.match(patched, /title:i\?\?`Anti-Codex`\s*,backgroundColor/);
  assert.match(
    patched,
    /createPrimaryWindow\(\{title:`Anti-Codex`\s*,show:e\}\)/,
  );
  assert.equal(hasProductNameDrivenSessionTitle(patched), true);
});

test("does not accept a generic app.getName reference as session-title proof", () => {
  assert.equal(
    hasProductNameDrivenSessionTitle("dialog.showMessageBox({title:r.app.getName()})"),
    false,
  );
});

test("routes every Windows tray brand to the Anti-Codex tray resource", () => {
  const source = [
    "function x_(e,t){",
    "if(e===i.a.Agent&&t===n.Vc.ChatGPT)",
    "return{dark:`icon-agent.ico`,light:`icon-agent.ico`};",
    "switch(t){",
    "case n.Vc.Codex:return{dark:`codex-tray.ico`,light:`codex-tray.ico`};",
    "case n.Vc.ChatGPT:return{dark:`chatgpt-tray-dark.ico`,light:`chatgpt-tray-light.ico`}",
    "}}",
  ].join("");

  assert.equal(
    typeof brandPatchCompat.patchWindowsTrayIconSelection,
    "function",
  );
  const patched = brandPatchCompat.patchWindowsTrayIconSelection(source);

  assert.equal(patched.length, source.length);
  assert.doesNotMatch(patched, /icon-agent\.ico|chatgpt-tray-(?:dark|light)\.ico/);
  assert.equal((patched.match(/codex-tray\.ico/g) || []).length, 6);
  assert.equal(
    brandPatchCompat.patchWindowsTrayIconSelection(patched),
    patched,
  );
});

test("preserves an empty notify array as an Anti-Codex legacy-notify opt-out", () => {
  const source = "function Hn(e,t){let n=Wn(e),r=Gn(n),i=[t,zn];return r!=null&&i.push(Rn,JSON.stringify(r)),Xn(n,i)?{content:e,hadNotify:!0}:{content:Jn(e,L({notify:i}).trimEnd()),hadNotify:n!=null}}";

  assert.equal(
    typeof brandPatchCompat.patchComputerUseLegacyNotifyOptOut,
    "function",
  );
  const patched = brandPatchCompat.patchComputerUseLegacyNotifyOptOut(source);
  assert.equal(patched.length, source.length);
  assert.match(patched, /n\?\.length<1\|\|Xn\(n,i\)/);
  assert.doesNotMatch(patched, /r!=null/);

  let notify = [];
  const createEnsureNotify = new Function(
    "Wn", "Gn", "zn", "Rn", "Xn", "Jn", "L",
    `${patched}; return Hn;`,
  );
  const ensureNotify = createEnsureNotify(
    () => notify,
    (value) => value,
    "turn-ended",
    "--previous-notify",
    (left, right) => JSON.stringify(left) === JSON.stringify(right),
    (_content, nextLine) => `rewritten:${nextLine}`,
    ({ notify: nextNotify }) => `notify=${JSON.stringify(nextNotify)}`,
  );

  assert.deepStrictEqual(ensureNotify("notify = []\n", "helper.exe"), {
    content: "notify = []\n",
    hadNotify: true,
  });
  notify = null;
  assert.deepStrictEqual(ensureNotify("", "helper.exe"), {
    content: 'rewritten:notify=["helper.exe","turn-ended"]',
    hadNotify: false,
  });
  assert.equal(brandPatchCompat.patchComputerUseLegacyNotifyOptOut(patched), patched);
});
