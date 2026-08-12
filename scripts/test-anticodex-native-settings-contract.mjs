#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as nativeSettingsContract from "./anticodex-native-settings-contract.mjs";

const { compareNativeSettingsSlugSets } = nativeSettingsContract;

const missingWithoutEvidence = compareNativeSettingsSlugSets(
  ["agent", "personalization"],
  ["agent"],
  [],
);
assert.equal(missingWithoutEvidence.ok, false);
assert.deepEqual(missingWithoutEvidence.gated, []);
assert.deepEqual(missingWithoutEvidence.missingWithoutGateEvidence, ["personalization"]);

const explicitlyGated = compareNativeSettingsSlugSets(
  ["agent", "personalization"],
  ["agent"],
  ["personalization"],
);
assert.equal(explicitlyGated.ok, true);
assert.deepEqual(explicitlyGated.gated, ["personalization"]);
assert.deepEqual(explicitlyGated.missingWithoutGateEvidence, []);

const existingSetChecks = compareNativeSettingsSlugSets(
  ["agent", "personalization"],
  ["agent", "agent", "unexpected"],
  ["personalization"],
);
assert.equal(existingSetChecks.ok, false);
assert.deepEqual(existingSetChecks.duplicates, ["agent"]);
assert.deepEqual(existingSetChecks.unexpected, ["unexpected"]);

assert.equal(typeof nativeSettingsContract.extractNativeSettingsGateSlugs, "function");
assert.equal(typeof nativeSettingsContract.readNativeSettingsContract, "function");
const registrationSource = 'const pages={agent:A,personalization:B,"future-settings":C,"second-future":D,conditional:E};';
const visibilityFunction = (name, gatedSlug, sectionsName = "sections") => [
  `function ${name}(selected=null){`,
  `const visible=${sectionsName}.filter(entry=>{switch(entry.slug){`,
  `case\`${gatedSlug}\`:return!1;`,
  'case`conditional`:return featureFlag;',
  'case`agent`:case`personalization`:return!0;',
  '}});',
  'return{activeSettingsSection:selected,settingsNavigationSections:visible.filter(entry=>entry.slug!==`agent`),',
  'shouldRedirectToVisibleSettingsSection:!1,shouldRenderRouteContent:!0,visibleSettingsSections:visible}',
  '}',
].join("");
const navigationSource = [
  'const nativeSettingsSections=[{slug:`agent`},{slug:`personalization`},{slug:`future-settings`},{slug:`second-future`},{slug:`conditional`}];',
  'export{nativeSettingsSections as fT};',
].join("");
const arbitraryContractSource = [
  'import{fT as sections}from"./app-initial.js";',
  registrationSource,
  visibilityFunction("useVisibleSettingsSections", "future-settings"),
  'export{useVisibleSettingsSections as n,pages as r};',
].join("");
const settingsConsumerSource = [
  'import{n as useVisible,r as pageRegistry}from"./use-visible-settings.js";',
  'function SettingsPage(){const{settingsNavigationSections:visible}=useVisible(null,!0);',
  'return render(SettingsSidebar,{settingsSections:visible})}',
  'function SettingsSidebar(props){const{settingsSections:items}=props;',
  'const groups=[{sections:normalize(items)}];',
  'return groups.map(group=>group.sections.map(entry=>pageRegistry[entry.slug]))}',
].join("");
const moduleEvidence = (definitionSource = arbitraryContractSource, extraSources = {}) => ({
  modulePath: "webview/assets/use-visible-settings.js",
  moduleSources: {
    "webview/assets/app-initial.js": navigationSource,
    "webview/assets/use-visible-settings.js": definitionSource,
    "webview/assets/settings-page.js": settingsConsumerSource,
    ...extraSources,
  },
});
assert.deepEqual(
  nativeSettingsContract.extractNativeSettingsGateSlugs(arbitraryContractSource, moduleEvidence()),
  ["conditional", "future-settings"],
);

const renamedVisibilityWithTailDecoy = [
  'import{fT as sections}from"./app-initial.js";',
  registrationSource,
  'function renamedVisibility(){const visible=sections.filter(entry=>entry.slug!==`agent`);return{availableSections:visible}}',
  'function legalLookingTailDecoy(entry){switch(entry.slug){case`future-settings`:return!1;case`agent`:return!0;}}',
  'export{renamedVisibility as n,pages as r};',
].join("");
assert.deepEqual(
  nativeSettingsContract.extractNativeSettingsGateSlugs(renamedVisibilityWithTailDecoy, moduleEvidence(renamedVisibilityWithTailDecoy)),
  [],
);

const ambiguousVisibilityContracts = registrationSource
  + visibilityFunction("useVisibleSettingsSectionsA", "future-settings")
  + visibilityFunction("useVisibleSettingsSectionsB", "second-future");
assert.deepEqual(
  nativeSettingsContract.extractNativeSettingsGateSlugs(ambiguousVisibilityContracts),
  [],
);

const uncalledDecoyContract = [
  'import{fT as sections}from"./app-initial.js";',
  registrationSource,
  'const decoySections=sections;',
  visibilityFunction("unusedDecoyVisibility", "future-settings", "decoySections"),
  'export{unusedDecoyVisibility as n,pages as r};',
].join("");
assert.deepEqual(
  nativeSettingsContract.extractNativeSettingsGateSlugs(uncalledDecoyContract, moduleEvidence(uncalledDecoyContract, {
    "webview/assets/settings-page.js": 'import{r as pageRegistry}from"./use-visible-settings.js";const icon=pageRegistry[entry.slug];',
  })),
  [],
);

const splitConsumerDecoy = [
  'import{n as useVisible,r as pageRegistry}from"./use-visible-settings.js";',
  'function SettingsPage(){const{settingsNavigationSections:visible}=useVisible(null,!0);return null}',
  'function UnrelatedProp(){return render(Other,{settingsSections:visible})}',
  'function UnrelatedRegistry(other){return pageRegistry[other.slug]}',
].join("");
assert.deepEqual(
  nativeSettingsContract.extractNativeSettingsGateSlugs(arbitraryContractSource, moduleEvidence(arbitraryContractSource, {
    "webview/assets/settings-page.js": splitConsumerDecoy,
  })),
  [],
);

const overriddenForwardingConsumer = [
  'import{n as useVisible,r as pageRegistry}from"./use-visible-settings.js";',
  'function SettingsPage(){const{settingsNavigationSections:visible}=useVisible(null,!0);',
  'return render(Wrapper,{settingsSections:visible})}',
  'function Wrapper(props){return render(Target,{...props,settingsSections:decoy})}',
  'function Target(props){const{settingsSections:items}=props;const groups=[{sections:normalize(items)}];',
  'return groups.map(group=>group.sections.map(entry=>pageRegistry[entry.slug]))}',
].join("");
assert.deepEqual(
  nativeSettingsContract.extractNativeSettingsGateSlugs(arbitraryContractSource, moduleEvidence(arbitraryContractSource, {
    "webview/assets/settings-page.js": overriddenForwardingConsumer,
  })),
  [],
);

const ambiguousForwardingConsumer = [
  'import{n as useVisible,r as pageRegistry}from"./use-visible-settings.js";',
  'function SettingsPage(){const{settingsNavigationSections:visible}=useVisible(null,!0);',
  'return render(Wrapper,{settingsSections:visible})}',
  'function Wrapper(props){return [render(TargetA,{...props}),render(TargetB,{...props})]}',
  'function TargetA(props){const{settingsSections:items}=props;const groups=[{sections:normalize(items)}];',
  'return groups.map(group=>group.sections.map(entry=>pageRegistry[entry.slug]))}',
  'function TargetB(props){const{settingsSections:items}=props;const groups=[{sections:normalize(items)}];',
  'return groups.map(group=>group.sections.map(entry=>pageRegistry[entry.slug]))}',
].join("");
assert.throws(
  () => nativeSettingsContract.extractNativeSettingsGateSlugs(arbitraryContractSource, moduleEvidence(arbitraryContractSource, {
    "webview/assets/settings-page.js": ambiguousForwardingConsumer,
  })),
  /Ambiguous native Settings consumer path/,
);

assert.deepEqual(
  nativeSettingsContract.extractNativeSettingsGateSlugs(arbitraryContractSource, moduleEvidence(arbitraryContractSource, {
    "webview/assets/app-initial.js": 'const wrong=[{slug:`agent`}];export{wrong as other};',
  })),
  [],
);

assert.throws(
  () => nativeSettingsContract.extractNativeSettingsGateSlugs(arbitraryContractSource, moduleEvidence(arbitraryContractSource, {
    "webview/assets/settings-page-copy.js": settingsConsumerSource,
  })),
  /Ambiguous native Settings consumer contract/,
);

const asarPath = process.argv[2] || "";
if (asarPath) {
  const contract = nativeSettingsContract.readNativeSettingsContract(asarPath);
  assert.ok(contract.registrationSlugs.length > 0);
  assert.ok(contract.navigationSlugs.length > 0);
  assert.ok(contract.gatedSlugs.length > 0);
  assert.ok(contract.gatedSlugs.every((slug) => contract.registrationSlugs.includes(slug)));
  const comparison = nativeSettingsContract.compareNativeSettingsRuntimeContract(
    contract,
    contract.navigationSlugs.filter((slug) => !contract.gatedSlugs.includes(slug)),
  );
  assert.equal(comparison.ok, true);
  assert.deepEqual(comparison.missingWithoutGateEvidence, []);
}

const realMouseRunnerSource = readFileSync(new URL("./run-anticodex-manager-action-real-mouse.mjs", import.meta.url), "utf8");
assert.match(realMouseRunnerSource, /readNativeSettingsContract/);
assert.match(realMouseRunnerSource, /missingWithoutGateEvidence/);

console.log("anticodex native settings contract tests passed");
