import test from "node:test";
import assert from "node:assert/strict";

import { patchCompiledProfileDropdownSettings } from "../../scripts/brand-profile-dropdown.mjs";

test("webpack profile keeps Settings and adds a working Manager entry", () => {
  const source = 'function render(S,a,x,E,b,q,Z){let v,k;S[56]===Symbol.for("react.memo_cache_sentinel")?(v=(0,a.jsx)(x.A,{id:"codex.profileDropdown.settingsPage",defaultMessage:"Settings",description:"Menu item to open Codex settings page"}),S[56]=v):v=S[56],S[57]!==Z||S[58]!==q?(k=(0,a.jsx)(E.tJ,{leftIcon:b,keyboardShortcut:q,onClick:Z,children:v}),S[57]=Z,S[58]=q,S[59]=k):k=S[59];return k}';
  const patched = patchCompiledProfileDropdownSettings(source);
  assert.match(patched, /anticodex-manager/);
  assert.equal(Buffer.byteLength(patched), Buffer.byteLength(source));
  assert.equal(patchCompiledProfileDropdownSettings(patched), patched);
  let settingsOpened = 0;
  let managerOpened = 0;
  const render = new Function("globalThis", `${patched};return render;`)({__ANTICODEX_OPEN_MANAGER__: () => managerOpened++});
  const items = render(Array(100).fill(Symbol.for("react.memo_cache_sentinel")), {jsx: (component, props, key) => ({component, props, key})}, {A: "message"}, {tJ: "item"}, "icon", "Ctrl+,", () => settingsOpened++);
  assert.equal(items.length, 2);
  assert.equal(items[0].props.children.props.defaultMessage, "Settings");
  items[0].props.onClick();
  items[1].props.onClick();
  assert.equal(settingsOpened, 1);
  assert.equal(managerOpened, 1);
  assert.equal(items[1].props.children, "管理");
});

const latestProfileDropdownFixture = "function dn(e){let t=(0,K.c)(32),{isPetVisible:s,onOpenSettings:d,onTogglePet:p,settingsShortcut:m}=e;let C;t[13]!==p?(C=(0,q.jsx)(M,{electron:!0,children:(0,q.jsx)(F,{LeftIcon:rn,onClick:p})}),t[13]=p,t[15]=C):C=t[15];let w;t[16]===Symbol.for(`react.memo_cache_sentinel`)?(w=(0,q.jsx)(x,{id:`codex.profileDropdown.settingsPage`,defaultMessage:`Settings`,description:`Menu item to open Codex settings page`}),t[16]=w):w=t[16];let T;t[17]!==d||t[18]!==m?(T=(0,q.jsx)(F,{LeftIcon:it,keyboardShortcut:m,onClick:d,children:w}),t[17]=d,t[18]=m,t[19]=T):T=t[19];let E;return(D=(0,q.jsxs)(`div`,{children:[C,T,E]}),D)}";

const codex2738ProfileDropdownFixture = "function In(e){let t=(0,Rn.c)(44),{onOpenSettings:p,settingsShortcut:y}=e;let re;t[26]===Symbol.for(`react.memo_cache_sentinel`)?(re=(0,q.jsx)(P,{id:`codex.profileDropdown.settingsPage`,defaultMessage:`Settings`,description:`Menu item to open Codex settings page`}),t[26]=re):re=t[26];let ie;t[27]!==p||t[28]!==y?(ie=(0,q.jsx)(A,{leftIcon:ne,keyboardShortcut:y,onClick:p,children:re}),t[27]=p,t[28]=y,t[29]=ie):ie=t[29];let ae;return (0,q.jsxs)(`div`,{children:[ie,null,ae]})}";

const codex2928ProfileDropdownFixture = "function Pi(e){let n=(0,Wi.c)(277),{onOpenSettings:p,settingsShortcut:v}=e;let L;t[43]===Symbol.for(`react.memo_cache_sentinel`)?(L=(0,z.jsx)(z,{id:`codex.profileDropdown.settingsPage`,defaultMessage:`Settings`,description:`Menu item to open Codex settings page`}),t[43]=L):L=t[43];let oe;t[44]!==p||t[45]!==v?(oe=(0,J.jsx)(J,{leftIcon:ae,keyboardShortcut:v,onClick:p,children:L}),t[44]=p,t[45]=v,t[46]=oe):oe=t[46];let ce;return t[51]!==oe?(ce=(0,Q.jsxs)(Q.Fragment,{children:[ie,oe]}),t[51]=oe,t[52]=ce):ce=t[52];let ue;return (0,Q.jsxs)(`div`,{children:[r,ie,oe,ce]})}";

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

test("profile dropdown patch supports Codex 26.924.2738 cached settings item", () => {
  const patched = patchCompiledProfileDropdownSettings(codex2738ProfileDropdownFixture);

  assert.equal(patched.length, codex2738ProfileDropdownFixture.length);
  assert.match(patched, /anticodex-manager/);
  assert.match(patched, /__ANTICODEX_OPEN_MANAGER__/);
  assert.match(patched, /children:`\\u7ba1\\u7406`/);
  assert.equal(patchCompiledProfileDropdownSettings(patched), patched);
});

test("profile dropdown patch supports Codex 26.928.1915 menu items after settings", () => {
  const patched = patchCompiledProfileDropdownSettings(codex2928ProfileDropdownFixture);

  assert.equal(patched.length, codex2928ProfileDropdownFixture.length);
  assert.match(patched, /anticodex-manager/);
  assert.match(patched, /__ANTICODEX_OPEN_MANAGER__/);
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
