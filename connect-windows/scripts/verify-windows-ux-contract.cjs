#!/usr/bin/env node
'use strict';
// A fail-closed source/package linkage gate. This is NOT a substitute for the
// packaged Windows visual receipt described in docs/WINDOWS_UX_IMPLEMENTATION_CONTRACT.md.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'connect-windows/design/windows-ux-contract.json'), 'utf8'));
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = relative => fs.existsSync(path.join(root, relative));
const compiled = process.argv.includes('--unified');

assert.equal(contract.schemaVersion, 1);
assert.equal(contract.design.fileKey, 'PZ8dfCcXe2D8SMtmF497v3');
assert.equal(contract.acceptance.unifiedStartsIn, 'logistics');
assert.equal(contract.acceptance.commerceMustBeExplicit, true);
assert.equal(contract.acceptance.actualErrorAndRetryRequired, true);
for (const [name, location] of Object.entries(contract.runtime)) {
  if (name === 'unifiedPackageRenderer') continue;
  assert.ok(exists(location), `UX contract references a missing owner: ${name} -> ${location}`);
}
for (const [name, node] of Object.entries(contract.design.nodeReferences)) {
  assert.match(node, /^\d+:\d+$/, `Invalid approved Figma node: ${name}`);
}
const desktop = source(contract.runtime.unifiedShell);
const entry = source(contract.runtime.unifiedEntry);
const menu = source(contract.runtime.commerceMenu);
const host = source(contract.runtime.authorizedService);
const build = source(contract.runtime.unifiedBuild);
const connectShell = source('connect-windows/ui/WorkspaceApp.tsx');
assert.doesNotMatch(connectShell, /legacy\s*\|\|\s*\(status\s*&&\s*!status\.workspace\)/,
  'A missing Logistics workspace must never silently activate classic Connect');
assert.match(connectShell, /Open earlier connection tools/,
  'Classic tools must be an explicit, recoverable user choice');
assert.match(desktop, /workspaceMode==='logistics'/, 'Unified App must open Logistics by default');
assert.match(desktop, /<LogisticsGateway\b/, 'Unified App must render the Logistics entry');
assert.match(desktop, /onCommerce=\{\(\)=>setWorkspaceMode\('commerce'\)\}/, 'Commerce access must be an explicit action');
assert.match(entry, /bridge\.choices\(\)/, 'Entry must query the authorized host');
assert.match(entry, /bridge\[destination\]\(\)/, 'Entry must navigate to real orders/setup actions');
assert.match(entry, /role="alert"/, 'Entry must show recoverable access errors');
assert.doesNotMatch(menu, /Logistics is unavailable for this account or facility/, 'Do not hide access error causes');
assert.match(host, /this\.human\.access\(scope\)/, 'Logistics access must remain facility-scoped');
assert.match(build, /PACKPROOF_UNIFIED_WINDOWS/, 'Unified distribution must be explicit');
assert.match(build, /\.\.\/desktop\/dist\/renderer/, 'Connect must include the actual desktop renderer');
if (compiled) {
  const commerce = path.join(root, contract.runtime.unifiedPackageRenderer);
  const logistics = path.join(root, 'connect-windows/dist/renderer');
  for (const dir of [commerce, logistics])
    assert.ok(fs.existsSync(path.join(dir, 'index.html')), `Missing packaged renderer: ${dir}`);
  const assets = dir => fs.readdirSync(path.join(dir, 'assets')).filter(file => /\.(js|css)$/.test(file)).map(file => fs.readFileSync(path.join(dir, 'assets', file), 'utf8')).join('\n');
  const commerceBundle = assets(commerce);
  const logisticsBundle = assets(logistics);
  for (const phrase of ['Your orders.', 'One clear story.', 'Set up this facility', 'Open my orders']) {
    assert.ok(commerceBundle.includes(phrase), `Unified Commerce renderer does not include Logistics-first entry: ${phrase}`);
  }
  assert.ok(commerceBundle.includes('.logistics-entry'), 'Missing approved entry layout in unified CSS');
  assert.ok(logisticsBundle.includes('GuidedSetup') || logisticsBundle.includes('Start with an order'), 'Missing functional Logistics setup bundle');
}
process.stdout.write(`Windows UX authority verified (${compiled ? 'unified output + source' : 'source'}). Visual approval remains separately required.\n`);
