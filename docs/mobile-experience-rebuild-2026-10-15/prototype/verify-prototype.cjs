#!/usr/bin/env node
'use strict';

// Independent design-fixture checks. These are DOM interaction checks, not
// evidence-integrity, native-device, rendering, or accessibility certification.
// Run with Node 24.15+ (or 22.22.2+) and jsdom 30.1.2 installed (or supplied through NODE_PATH).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

const prototypePath = path.join(__dirname, 'index.html');
const source = fs.readFileSync(prototypePath, 'utf8');
const results = [];
let active;

function createFixture() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(source, {
    url: 'https://packproof-prototype.invalid/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      window.HTMLMediaElement.prototype.pause = function () {};
      window.confirm = () => true;
      window.alert = () => {};
      window.fetch = () => { throw new Error('Prototype unexpectedly attempted a network request.'); };
    },
  });
  return { dom, window: dom.window, document: dom.window.document, errors };
}

function normalized(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function accessibleName(element) {
  if (element.getAttribute('aria-label')) return normalized(element.getAttribute('aria-label'));
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) return normalized(labelledBy.split(/\s+/).map(id => element.ownerDocument.getElementById(id)?.textContent).join(' '));
  if (element.labels?.length) return normalized(Array.from(element.labels).map(label => label.textContent).join(' '));
  return normalized(element.textContent || element.getAttribute('title') || element.getAttribute('alt'));
}
function hidden(element) {
  for (let node = element; node?.nodeType === 1; node = node.parentElement) {
    if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return true;
    const style = active.window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
  }
  return false;
}
function visible(selector, root = active.document) {
  return Array.from(root.querySelectorAll(selector)).filter(element => !hidden(element));
}
function control(name, root = active.document) {
  const matches = visible('button, a, input[type="button"], input[type="submit"], [role="button"]', root)
    .filter(element => name instanceof RegExp ? name.test(accessibleName(element)) : accessibleName(element) === name);
  assert.equal(matches.length, 1, `Expected one control ${name}; found ${matches.length}. Available: ${visible('button, a', root).map(accessibleName).join(' | ')}`);
  return matches[0];
}
function click(name, root) {
  const element = control(name, root);
  assert.ok(!element.disabled && element.getAttribute('aria-disabled') !== 'true', `${name} must be enabled`);
  element.focus();
  element.click();
}
function select(selector, value) {
  const element = active.document.querySelector(selector);
  assert.ok(element, `Missing select ${selector}`);
  assert.ok(Array.from(element.options).some(option => option.value === value), `Missing option ${value} for ${selector}`);
  element.value = value;
  element.dispatchEvent(new active.window.Event('change', { bubbles: true }));
}
function input(selector, value) {
  const element = active.document.querySelector(selector);
  assert.ok(element, `Missing input ${selector}`);
  element.value = value;
  element.dispatchEvent(new active.window.Event('input', { bubbles: true }));
  element.dispatchEvent(new active.window.Event('change', { bubbles: true }));
}
function textIncludes(expected, root = active.document.body) {
  const text = normalized(root.textContent);
  assert.ok(expected instanceof RegExp ? expected.test(text) : text.includes(expected), `Expected text ${expected} in: ${text.slice(-2500)}`);
}
function textExcludes(expected, root = active.document.body) {
  const text = normalized(root.textContent);
  assert.ok(expected instanceof RegExp ? !expected.test(text) : !text.includes(expected), `Unexpected text ${expected}`);
}
function test(name, body) {
  active = createFixture();
  try {
    body();
    assert.deepEqual(active.errors, [], 'No uncaught fixture script errors');
    results.push({ name, result: 'PASS' });
  } catch (error) {
    results.push({ name, result: 'FAIL', reason: error.message });
  } finally {
    active.window.close();
  }
}

function phone() { return active.document.querySelector('#phone'); }
function body() { return active.document.querySelector('#app-body'); }
function act(action) {
  const elements = visible('[data-action]', phone()).filter(element => element.dataset.action === action);
  assert.equal(elements.length, 1, `Expected one visible ${action}; found ${elements.length}`);
  assert.ok(!elements[0].disabled, `${action} is disabled`);
  elements[0].focus();
  elements[0].click();
}
function surface(name) { active.document.querySelector(`[data-surface="${name}"]`).click(); }
function scenario(name) { select('#scenario', name); select('#auto', 'off'); }
function observed() { return JSON.parse(active.document.querySelector('#state-inspector').textContent); }
function consent() {
  const checkbox = active.document.querySelector('#attestation');
  assert.ok(checkbox, 'Declaration is visible');
  checkbox.click();
}
function advance() { active.document.querySelector('#advance').click(); }
function firstRecording() {
  scenario('fresh');
  click('Create Proof', phone());
  input('#item-title', 'Console with controller');
  act('prepare');
  textIncludes('Ready to record', body());
  act('start');
  textIncludes('Recording', body());
  assert.equal(observed().localDurable, false, 'Active take is not yet durably saved');
  act('finish');
}
function submitRecording() { consent(); act('submit'); act('authorize'); }
function assertNotFinalized() { assert.equal(observed().serverFinalized, false); }

// These interactions use rendered controls rather than the prototype state API.
test('Manual first Proof: three decisions to recording; consent, authorization and distinct server milestones', () => {
  firstRecording();
  textIncludes('Recording saved on this device. Not uploaded yet.', body());
  assert.equal(active.document.querySelector('#attestation').checked, false);
  assert.equal(control('Confirm and submit', phone()).disabled, true);
  assertNotFinalized();
  consent(); act('submit');
  assert.ok(active.document.querySelector('[role="dialog"]'));
  assert.equal(observed().signed, false);
  act('authorize');
  textIncludes('Uploading your recording', body());
  assert.equal(observed().signed, true);
  const identity = [observed().sourceId, observed().jobId];
  advance();
  assert.equal(active.document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '50');
  assertNotFinalized();
  advance();
  textIncludes('Recording received. Finishing your Proof.', body());
  assertNotFinalized();
  advance();
  textIncludes('Your Proof is finalized.', body());
  assert.equal(observed().serverFinalized, true);
  assert.deepEqual([observed().sourceId, observed().jobId], identity);
  act('nav:evidence');
  textIncludes('Finalization confirmed by the server', body());
  assert.equal(visible('[data-action="open:current"]', phone()).length, 0);
});

test('Editing item metadata invalidates consent and requires fresh authorization', () => {
  firstRecording(); consent();
  act('edit-item'); input('#edit-title', 'Console plus two controllers'); act('save-edit');
  assert.equal(active.document.querySelector('#attestation').checked, false);
  assert.equal(control('Confirm and submit', phone()).disabled, true);
  assert.equal(observed().attestationRevision, null);
  assert.equal(observed().signed, false);
  textIncludes('Console plus two controllers', body());
});

test('Retake requires an explicit repeat-packing choice and resets consent', () => {
  firstRecording(); consent(); act('retake');
  textIncludes('repeat the full packing and sealing process', phone());
  click('Keep saved recording',phone());
  assert.equal(active.document.querySelector('#attestation').checked, true, 'Cancel preserves prior consent');
  act('retake'); act('confirm-retake'); act('start'); act('finish');
  assert.equal(active.document.querySelector('#attestation').checked, false);
  assert.equal(control('Confirm and submit', phone()).disabled, true);
});

test('Back from review preserves the saved original and returns to review from Home', () => {
  firstRecording(); const sourceId = observed().sourceId;
  act('back'); textIncludes('Your recording stays on this device', phone()); act('keep-review');
  textIncludes('Ready for review', body()); act('open:current');
  assert.equal(observed().sourceId, sourceId);
  textIncludes('Review your recording', body());
});

test('Back during recording warns, retains a partial take and prevents complete submission', () => {
  scenario('resume'); act('open:current'); act('start');
  // Recording screen has both toolbar Back and a labeled interruption simulation.
  click('Back', phone());
  textIncludes('Leaving stops this continuous take', phone());
  act('interrupt-recording');
  textIncludes('not a complete continuous packing recording', body());
  assert.equal(visible('[data-action="submit"]', phone()).length, 0);
  assert.equal(observed().stage, 'interrupted_capture');
  assertNotFinalized();
  act('nav:viewer'); textIncludes('Saved partial take', body());
});

for (const name of ['failed', 'interrupted']) test(`${name}: retry retains the same original/job through received and finalized states`, () => {
  scenario(name); const identity = [observed().sourceId, observed().jobId];
  act('open:current'); textIncludes('still saved on this device', body()); act('retry');
  assert.deepEqual([observed().sourceId, observed().jobId], identity);
  advance(); advance(); assertNotFinalized();
  textIncludes('Recording received. Finishing your Proof.', body());
  advance(); assert.equal(observed().serverFinalized, true);
  assert.deepEqual([observed().sourceId, observed().jobId], identity);
});

test('Offline saved original is queued until explicit connectivity recovery', () => {
  scenario('offline'); const identity = [observed().sourceId, observed().jobId];
  act('open:current'); textIncludes('Waiting for connection', body());
  advance(); assert.equal(observed().stage, 'queued'); assertNotFinalized();
  act('reconnect'); textIncludes('Uploading your recording', body());
  assert.deepEqual([observed().sourceId, observed().jobId], identity);
  advance(); advance(); assertNotFinalized(); advance(); assert.equal(observed().serverFinalized, true);
});

test('Unknown acknowledgment checks the existing job and does not request re-recording', () => {
  scenario('unknown-ack'); const identity = [observed().sourceId, observed().jobId];
  act('open:current'); textIncludes('Checking the latest status', body());
  assert.equal(visible('[data-action="retry"], [data-action="start"], [data-action="create"]', phone()).length, 0);
  click('Check status', phone());
  textIncludes('Recording received. Finishing your Proof.', body()); assertNotFinalized();
  assert.deepEqual([observed().sourceId, observed().jobId], identity);
});

test('Home, Proofs, Capture resume and Updates resolve a failed upload to the same next step', () => {
  for (const route of ['home','proofs','capture','updates']) {
    scenario('failed');
    click(route[0].toUpperCase()+route.slice(1), phone());
    if (route === 'capture') click(/^Continue a Proof,/,phone());
    act('open:current');
    textIncludes('Let’s finish your upload', body());
    assert.equal(observed().sourceId, 'demo-original-01');
    assert.equal(observed().jobId, 'demo-job-01');
  }
});

test('Known scan preserves the existing saved upload and resumes that exact task', () => {
  scenario('failed'); const identity = [observed().sourceId, observed().jobId];
  click('Capture', phone()); act('nav:scan'); act('scan-match');
  textIncludes('Shipment found', body()); act('open:current');
  textIncludes('Let’s finish your upload', body());
  assert.deepEqual([observed().sourceId, observed().jobId], identity);
});

test('Starting a new Proof keeps an existing recoverable source discoverable', () => {
  scenario('failed'); const identity = [observed().sourceId, observed().jobId];
  click('Create a new Proof',phone());
  input('#item-title','A different parcel');
  click('Proofs',phone());
  click(/^Vintage game console,/,phone());
  textIncludes('Let’s finish your upload',body());
  assert.deepEqual([observed().sourceId,observed().jobId],identity);
});

test('Offline new creation explains eligibility limitation before recording', () => {
  scenario('offline'); click('Create a new Proof',phone());
  input('#item-title','Offline parcel'); act('prepare');
  assert.equal(visible('[data-action="start"]',phone()).length,0);
  textIncludes(/connect|connection|online/i,body());
  assert.equal(observed().localDurable,false);
});

test('Selecting an imported order preserves any existing recoverable local original', () => {
  scenario('failed'); const identity = [observed().sourceId,observed().jobId];
  act('profile'); click('Integrations',active.document.querySelector('[role="dialog"]'));
  act('connect-shopify'); act('connect-confirm');
  click('Open',phone()); act('order-select');
  click('Back',phone()); click('Proofs',phone());
  click(/^Vintage game console,/,phone());
  textIncludes('Let’s finish your upload',body());
  assert.deepEqual([observed().sourceId,observed().jobId],identity);
});

test('Scan with denied camera presents recovery and a manual fallback', () => {
  scenario('permission-denied'); click('Capture',phone()); act('nav:scan');
  textIncludes(/camera access|camera permission/i,body());
  assert.equal(visible('[data-action="scan-match"]',body()).length,0);
  click('Enter item manually',phone()); textIncludes('What are you packing?',body());
});

test('Unknown scan offers usable manual and existing-Proof fallbacks', () => {
  scenario('fresh'); click('Capture', phone()); act('nav:scan'); act('scan-unknown');
  textIncludes('No shipment match', body());
  assert.ok(control('Find an existing Proof', phone()));
  click('Enter item manually', phone()); textIncludes('What are you packing?', body());
});

test('Waiting buyer sees no seller action task, unrelated seller records, capture or share permission', () => {
  scenario('waiting');
  textIncludes('Waiting for seller', body());
  textExcludes('Also needs your attention', body());
  textExcludes('Film camera', body());
  act('open:current');
  textIncludes('No action is needed from you', body());
  assert.equal(visible('[data-action="share"], [data-action="start"]', phone()).length, 0);
  click('Proofs', phone()); act('filter:Needs action');
  assert.equal(visible('[data-action^="open:"]', body()).length, 0);
  click('Capture', phone()); textIncludes('viewing only', body());
});

for (const [name, description, openAction, fixAction] of [
  ['permission-denied', 'Allow camera access', 'permission-open', 'permission-allow'],
  ['no-storage', 'Make room to record', 'storage-manage', 'storage-free'],
  ['policy-blocked', 'A step before recording', 'allowance-check', 'allowance-eligible'],
]) test(`${name}: preflight blocks recording, explains the reason and permits explicit recovery`, () => {
  scenario(name); act('open:current'); textIncludes(description, body());
  textIncludes('No recording has started.', body());
  assert.equal(visible('[data-action="start"]', phone()).length, 0);
  assert.equal(observed().localDurable, false);
  act(openAction); act(fixAction);
  textIncludes('Ready to record', body());
  assert.equal(observed().localDurable, false);
});

test('Unavailable secure signing blocks recording and exposes signing help', () => {
  scenario('signing-unavailable'); act('open:current');
  textIncludes('Secure signing unavailable',body());
  textIncludes('No recording has started.',body());
  assert.equal(visible('[data-action="start"]',phone()).length,0);
  assert.equal(observed().localDurable,false);
  click('Review signing help',phone()); textIncludes('Signing help',body());
});

test('Empty History does not fabricate activity or technical events', () => {
  scenario('history-empty'); surface('history');
  assert.equal(active.document.querySelectorAll('details.event').length,0);
  textIncludes(/no.*activit|no.*event/i,body());
  textExcludes('Buyer joined',body());
});

test('Tracking form is closed at rest and saving tracking cannot finalize evidence', () => {
  scenario('resume'); surface('evidence'); act('nav:shipment');
  textIncludes('Tracking is optional.', body());
  assert.equal(visible('input,select', body()).length, 0);
  act('tracking-form'); input('#tracking', 'DEMO-TRACKING'); select('#carrier','UPS'); act('tracking-save');
  textIncludes('Manual entry', body()); textIncludes('Carrier connection unavailable', body());
  assertNotFinalized();
  act('nav:evidence'); textIncludes('Not confirmed', body());
});

test('Two ordinary history events have expandable labeled details', () => {
  scenario('resume'); surface('history');
  const events = active.document.querySelectorAll('details.event');
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.ok(accessibleName(event.querySelector('summary')));
    event.querySelector('summary').click();
    assert.equal(event.open, true);
    assert.ok(normalized(event.querySelector('.event-details').textContent));
  }
});

test('Proof search and status filter survive viewer return; waiting is not Needs action', () => {
  scenario('resume'); click('Proofs', phone()); act('filter:Needs action');
  textExcludes('Waiting for buyer', body());
  input('#proof-search', 'Vintage'); act('open:current'); click('Back', phone());
  click('Proofs', phone());
  assert.equal(active.document.querySelector('#proof-search').value, 'Vintage');
  assert.equal(active.document.querySelector('[data-action="filter:Needs action"]').getAttribute('aria-pressed'), 'true');
});

test('Empty Capture keeps manual entry usable without blank search/filter controls', () => {
  scenario('fresh'); click('Capture', phone());
  assert.equal(visible('input', body()).length, 0);
  assert.equal(visible('.filters', body()).length, 0);
  act('create'); textIncludes('What are you packing?', body());
});

test('Profile menu exposes all six groups and supports Escape dismissal', () => {
  scenario('fresh'); act('profile');
  const dialog = active.document.querySelector('[role="dialog"]');
  assert.equal(accessibleName(dialog),'Your profile');
  for (const name of ['Account & billing','Settings','Integrations','Orders','Help & support','Advanced']) {
    assert.ok(control(name,dialog));
  }
  active.document.dispatchEvent(new active.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(active.document.querySelector('[role="dialog"]'),null);
  assert.equal(accessibleName(active.document.activeElement),'Open profile menu');
});

test('Modal keyboard trap wraps and authorization cancel restores invoking control', () => {
  firstRecording(); consent(); control('Confirm and submit',phone()).focus(); act('submit');
  const dialog = active.document.querySelector('[role="dialog"]');
  const buttons = Array.from(dialog.querySelectorAll('button')).filter(button => !button.disabled);
  buttons[buttons.length-1].focus();
  active.document.dispatchEvent(new active.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));
  assert.equal(active.document.activeElement,buttons[0]);
  click('Cancel',dialog);
  assert.equal(accessibleName(active.document.activeElement),'Confirm and submit');
});

test('Integrations are optional and unavailable provider details preserve manual creation', () => {
  scenario('fresh'); act('profile'); click('Integrations',active.document.querySelector('[role="dialog"]'));
  textIncludes('Optional — you can create a Proof without a connection.',body());
  textIncludes('Not enabled in this fixture',body());
  click('Create Proof without connecting',phone()); textIncludes('What are you packing?',body());
});

test('Advanced receipt, account deletion and other capture capabilities are reachable', () => {
  scenario('resume'); act('profile'); click('Advanced',active.document.querySelector('[role="dialog"]'));
  act('nav:technical'); textIncludes('Optional capture receipt',body());
  textIncludes('No real hash generated',body());
  act('receipt-toggle'); textIncludes('Disable demo preference',body());
  act('profile'); click('Account & billing',active.document.querySelector('[role="dialog"]'));
  act('nav:privacy'); act('delete-request'); textIncludes('No account will be deleted',phone()); click('Cancel',phone());
  click('Capture',phone()); act('nav:workflows');
  for (const title of ['Receive a shipment','Document a return','Witness a capture','Grade a collectible']) textIncludes(title,body());
});

test('Loading and error fixtures offer explicit recovery without false success', () => {
  scenario('loading'); textIncludes('Loading your Proofs',body());
  assert.ok(active.document.querySelector('[aria-busy="true"]')); act('refresh');
  textIncludes('Record packing',body());
  scenario('error'); textIncludes('We couldn’t load your Proofs',body());
  click('Try again',phone()); textIncludes('Record packing',body()); assertNotFinalized();
});

test('Opening pending uploads with no durable recording shows an empty state, not a transfer', () => {
  scenario('error'); click('Open pending uploads',phone());
  textIncludes('No saved uploads',body());
  textExcludes('Uploading your recording',body());
  assert.equal(visible('[role="progressbar"]',body()).length,0);
  assertNotFinalized();
});

test('Design viewport controls expose all required review widths without changing the journey', () => {
  scenario('failed'); const identity = [observed().sourceId,observed().jobId];
  for (const width of ['320','360','393','411']) {
    select('#width',width);
    assert.equal(phone().style.width,`${width}px`);
    assert.deepEqual([observed().sourceId,observed().jobId],identity);
  }
});

test('Upload stages expose a polite status announcement and motion has a reduced-motion override', () => {
  firstRecording(); submitRecording();
  const regions = visible('[role="status"],[aria-live="polite"]');
  assert.ok(regions.length,'Upload needs a polite status region');
  assert.ok(regions.some(region => /upload/i.test(normalized(region.textContent))));
  assert.match(source,/prefers-reduced-motion/,'Reduced-motion preference must be handled');
});

const remoteStateScreens = ['home','proofs','capture','camera','review','evidence','shipment','history','updates','integrations'];
for (const screen of remoteStateScreens) test(`${screen}: loading/error states preserve the source and recover without false completion`, () => {
  scenario('failed'); surface(screen);
  const identity = [observed().sourceId, observed().jobId];
  select('#viewstate','loading');
  assert.ok(active.document.querySelector('#app-body [aria-busy="true"]'),`${screen} loading is announced`);
  assert.equal(visible('[data-action="submit"],[data-action="start"]',body()).length,0);
  assert.deepEqual([observed().sourceId,observed().jobId],identity);
  assertNotFinalized();
  act('view-retry');
  assert.equal(observed().viewState,'standard');
  select('#viewstate','error');
  assert.equal(visible('[data-action="submit"],[data-action="start"]',body()).length,0);
  assert.ok(control(/Try again|Try opening again|Try camera again/,phone()));
  assert.deepEqual([observed().sourceId,observed().jobId],identity);
  act('view-retry');
  assert.equal(observed().viewState,'standard');
  assert.deepEqual([observed().sourceId,observed().jobId],identity);
  assertNotFinalized();
});

test('Local Profile/Settings menus remain reachable when remote loading/error is inapplicable', () => {
  for (const screen of ['profile','settings']) for (const mode of ['loading','error','empty']) {
    scenario('resume'); surface(screen); select('#viewstate',mode);
    textIncludes('N/A:',active.document.querySelector('#annotations'));
    if(screen==='profile') {
      const dialog=active.document.querySelector('[role="dialog"]');
      assert.ok(control('Settings',dialog));
      click('Close menu',dialog);
    } else {
      assert.ok(control(/^Privacy and account,/,phone()));
    }
  }
});

test('Explicit empty-state controls reset coherent design fixtures and actions match their labels', () => {
  for (const screen of ['home','proofs','capture','evidence','shipment','history','updates','integrations']) {
    scenario('failed'); surface(screen); select('#viewstate','empty');
    assert.ok(visible('.btn.primary',phone()).length<=1,screen);
    assertNotFinalized();
    if(screen==='history') assert.equal(active.document.querySelectorAll('details.event').length,0);
    if(screen==='shipment') textIncludes('No tracking added',body());
    assert.equal(observed().sourceId,null,'External empty control deliberately selects an empty fixture');
    assert.equal(observed().jobId,null);
    if(screen==='evidence') { click('Record packing',phone()); textIncludes('Ready to record',body()); }
    select('#viewstate','standard');
  }
});

test('Offline review cannot secure-authorize or submit, and reconnect preserves its original', () => {
  firstRecording(); consent(); const sourceId=observed().sourceId;
  select('#viewstate','offline');
  assert.equal(visible('[data-action="submit"],[data-action="authorize"]',phone()).length,0);
  textIncludes(/offline|reconnect/i,body());
  assert.equal(observed().signed,false);
  assert.equal(observed().sourceId,sourceId);
  assertNotFinalized();
  click('Simulate connection restored',phone());
  act('submit'); act('authorize');
  assert.equal(observed().stage,'uploading');
  assert.equal(observed().sourceId,sourceId);
});

test('Offline tracking cannot claim a newly saved tracking association', () => {
  scenario('resume'); surface('shipment'); act('tracking-form');
  input('#tracking','DEMO-OFFLINE'); select('#viewstate','offline');
  click('Save tracking',phone());
  textIncludes('Reconnect to save tracking',body());
  assert.equal(active.document.querySelector('#tracking').value,'DEMO-OFFLINE');
  textExcludes('Tracking saved in this prototype',phone());
  textExcludes('Manual entry',body());
  assertNotFinalized();
  select('#viewstate','standard');
  act('tracking-save');
  textIncludes('Manual entry',body());
  assertNotFinalized();
});

test('Offline recovery/reconciliation cannot invent receipt or advance a failed upload', () => {
  for (const fixture of ['failed','unknown-ack']) {
    scenario(fixture); select('#viewstate','offline'); act('open:current');
    const identity=[observed().sourceId,observed().jobId];
    const before=observed().stage;
    advance();
    assert.equal(observed().stage,before);
    assert.deepEqual([observed().sourceId,observed().jobId],identity);
    assertNotFinalized();
    if(fixture==='failed') { act('retry'); assert.equal(observed().stage,'queued'); }
    textIncludes(/offline|reconnect|connection/i,body());
  }
});

test('OAuth pending cancellation leaves no connected success and manual Proof remains available', () => {
  scenario('integration-authorizing');
  textIncludes('Waiting for Shopify authorization',body());
  textExcludes('Demo account connected',body());
  click('Cancel connection',phone());
  textIncludes('Connection canceled',body());
  textExcludes('Demo account connected',body());
  click('Create Proof without connecting',phone());
  textIncludes('What are you packing?',body());
});

for (const [fixture,action,description] of [
  ['integration-canceled','Connect','Connection canceled'],
  ['integration-error','Try again','We couldn’t connect Shopify'],
  ['integration-expired','Reconnect','Shopify authorization expired'],
]) test(`${fixture}: explicit reauthorization required before connected status`, () => {
  scenario(fixture); textIncludes(description,body());
  textExcludes('Demo account connected',body());
  click(action,phone());
  textIncludes('cannot connect an account',active.document.querySelector('[role="dialog"]'));
  textExcludes('Demo account connected',body());
  click('Cancel',active.document.querySelector('[role="dialog"]'));
  textExcludes('Demo account connected',body());
  click(action,phone()); act('connect-confirm');
  textIncludes('Demo account connected',body());
});

test('Buyer permissions remain restrictive through errors, retry and offline cached views', () => {
  for (const screen of ['evidence','shipment','history','updates']) {
    scenario('waiting'); surface(screen); select('#viewstate','error');
    act('view-retry'); select('#viewstate','offline');
    assert.equal(visible('[data-action="share"],[data-action="start"],[data-action="tracking-form"]',phone()).length,0);
    textExcludes('Film camera',body());
    assert.equal(observed().role,'buyer');
  }
});

const allScreens = ['home','proofs','capture','camera','review','evidence','shipment','history','updates','profile','settings','integrations'];
for (const theme of ['light','dark']) for (const scale of ['1','1.3','2']) test(`All 12 surfaces have named controls and at most one active primary action (${theme}, ${scale}× text)`, () => {
  for (const screen of allScreens) {
    scenario('resume'); select('#theme',theme); select('#scale',scale); select('#width','320'); surface(screen);
    assert.equal(phone().dataset.theme,theme);
    assert.equal(phone().dataset.scale,scale);
    assert.ok(visible('h1,h2,.camera-top',phone()).length,`${screen} must identify its purpose`);
    assert.ok(visible('.btn.primary',phone()).length <= 1, `${screen} has multiple active primary actions`);
    for (const control of visible('button,input,select,summary,[role="switch"]',phone())) {
      assert.ok(accessibleName(control), `${screen}: unnamed ${control.outerHTML.slice(0,150)}`);
    }
  }
});

for (const result of results) {
  process.stdout.write(`${result.result} ${result.name}${result.reason ? `\n  ${result.reason}` : ''}\n`);
}
process.stdout.write(`\n${results.filter(result => result.result === 'PASS').length}/${results.length} DOM checks passed.\n`);
process.exitCode = results.some(result => result.result === 'FAIL') ? 1 : 0;
