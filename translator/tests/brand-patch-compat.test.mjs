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
