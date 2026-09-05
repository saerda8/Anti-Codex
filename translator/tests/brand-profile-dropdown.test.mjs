import test from "node:test";
import assert from "node:assert/strict";

import { patchCompiledProfileDropdownSettings } from "../../scripts/brand-profile-dropdown.mjs";

const latestProfileDropdownFixture = "function dn(e){let t=(0,K.c)(32),{isPetVisible:s,onOpenSettings:d,onTogglePet:p,settingsShortcut:m}=e;let C;t[13]!==p?(C=(0,q.jsx)(M,{electron:!0,children:(0,q.jsx)(F,{LeftIcon:rn,onClick:p})}),t[13]=p,t[15]=C):C=t[15];let w;t[16]===Symbol.for(`react.memo_cache_sentinel`)?(w=(0,q.jsx)(x,{id:`codex.profileDropdown.settingsPage`,defaultMessage:`Settings`,description:`Menu item to open Codex settings page`}),t[16]=w):w=t[16];let T;t[17]!==d||t[18]!==m?(T=(0,q.jsx)(F,{LeftIcon:it,keyboardShortcut:m,onClick:d,children:w}),t[17]=d,t[18]=m,t[19]=T):T=t[19];let E;return(D=(0,q.jsxs)(`div`,{children:[C,T,E]}),D)}";

test("profile dropdown patch supports the latest compiled onOpenSettings menu structure", () => {
  const patched = patchCompiledProfileDropdownSettings(latestProfileDropdownFixture);

  assert.equal(patched.length, latestProfileDropdownFixture.length);
  assert.match(patched, /id:`codex\.profileDropdown\.settingsPage`/);
  assert.match(patched, /anticodex-manager/);
  assert.match(patched, /__ANTICODEX_OPEN_MANAGER__/);
  assert.match(patched, /children:`\\u7ba1\\u7406`/);
  assert.equal(patchCompiledProfileDropdownSettings(patched), patched);
});

test("profile dropdown patch covers both compiled menu variants in one consolidated bundle", () => {
  const source = `${latestProfileDropdownFixture}${latestProfileDropdownFixture.replace("function dn", "function en")}`;
  const patched = patchCompiledProfileDropdownSettings(source);

  assert.equal(patched.length, source.length);
  assert.equal((patched.match(/anticodex-manager/g) ?? []).length, 2);
  assert.equal((patched.match(/__ANTICODEX_OPEN_MANAGER__/g) ?? []).length, 2);
  assert.equal(patchCompiledProfileDropdownSettings(patched), patched);
});

test("profile dropdown patch cannot consume unrelated code in a consolidated bundle", () => {
  const source = "const before=`keep-before`;let w;const decoy=`keep-decoy`;" +
    latestProfileDropdownFixture +
    "const after=`keep-after`;";
  const patched = patchCompiledProfileDropdownSettings(source);

  assert.equal(patched.length, source.length);
  assert.match(patched, /const before=`keep-before`;let w;const decoy=`keep-decoy`;function dn\(e\)/);
  assert.match(patched, /const after=`keep-after`;/);
  assert.ok(patched.indexOf("anticodex-manager") > patched.indexOf("codex.profileDropdown.settingsPage"));
  assert.ok(patched.indexOf("anticodex-manager") - patched.indexOf("codex.profileDropdown.settingsPage") < 1_000);
});

test("profile dropdown patch leaves unrelated bundles unchanged", () => {
  const source = "function unrelated(){return `Settings`}";
  assert.equal(patchCompiledProfileDropdownSettings(source), source);
});
