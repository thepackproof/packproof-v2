const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Real packaged renderer, preload, focus traversal and accessibility tree. Only
// the external service, picker and browser consent result are simulated.
module.exports = async function workspaceWalkthrough({
  page, state, setStatus, register, stage, reach, keyboard, waitFor, checkPage, report, appUrl, directory,
}) {
  const order = { proofId: 'proof-walkthrough', revision: 4, orderReference: 'SO10482' };
  const folder = 'C:\\Warehouse\\Sales reports', output = 'C:\\Warehouse\\Verified proofs';
  const source = { id: 'sales', roles: ['order'], folder, generation: 1, state: 'pending',
    recognition: { state: 'recognized', message: 'Found order records.', sample: { orderReference: order.orderReference, sku: 'Valve' } } };
  const line = { lineId: '10', sku: 'Valve', unit: 'EA', orderedQuantity: '8' };
  const event = { eventKey: 'order-event', receiptId: 'receipt-10482', kind: 'order', version: '1',
    fileName: 'order.csv', sourceId: source.id, lines: [line], locator: 'line 2', observedAt: '2026-11-01T09:02:00Z' };
  const detail = { ...order, lines: [line], events: [event], evidence: [{ ...event, eventKind: event.kind,
    kind: 'derived_excerpt', originalStatus: 'retained', fields: { sku: line.sku, quantity: line.orderedQuantity } }] };
  let workspace = { phase: 'draft', step: 'order', sources: [], orders: [], outputState: 'unselected', outputFolder: null };
  const calls = [];
  function publish(update) {
    workspace = { ...workspace, ...update };
    const response = { ...state, workspace, binding: { organizationName: 'Walkthrough warehouse' },
      capabilities: { ...state.capabilities, orderWorkspace: true }, config: undefined, sourceSubscriptions: [],
      proofOutput: { folder: workspace.outputFolder, state: workspace.outputState === 'ready' ? 'ready' : 'not_configured', pending: 0 } };
    setStatus(response);
    return response;
  }
  register('saveWorkspaceStep', step => publish({ step }));
  register('getWorkspaceFolderSuggestion', null);
  register('chooseWorkspaceFolder', role => {
    assert.equal(role, 'order');
    calls.push('choose folder');
    return publish({ sources: [source] });
  });
  register('workspaceDraftPreview', { scannedFiles: 1, unresolved: 0, limited: false, unreadFiles: 0,
    examples: [{ orderReference: order.orderReference, source: 'Sales', packages: [], lines: [{ ...line, quantity: '8' }],
      events: [{ kind: event.kind, source: 'Sales', fileName: event.fileName, occurredAt: event.observedAt, shared: false }] }] });
  register('chooseWorkspaceOutput', () => { calls.push('choose output'); return publish({ outputFolder: output, outputState: 'ready' }); });
  register('activateWorkspace', () => {
    assert.equal(workspace.outputFolder, output);
    assert.equal(workspace.sources[0].id, source.id);
    calls.push('request access');
    return publish({ phase: 'awaiting_approval', approvalPath: '/app/records/connect/approve?installationId=walkthrough' });
  });
  register('openWorkspaceApproval', () => { calls.push('open browser'); return undefined; });
  register('workspaceSearchOrders', query => { assert.equal(query, order.orderReference); calls.push('find order'); return [order]; });
  register('workspaceAttention', { items: [], hasMore: false });
  register('workspaceOrderDetail', (id, revision) => {
    assert.deepEqual([id, revision], [order.proofId, order.revision]);
    calls.push('open committed revision'); return detail;
  });
  register('workspaceSourceRecord', (id, revision, eventKey) => {
    assert.deepEqual([id, revision, eventKey], [order.proofId, order.revision, event.eventKey]);
    calls.push('read exact source'); return { kind: 'original', originalText: 'sku,qty,unit\nValve,8,EA' };
  });

  const target = (name, prefix = false, selector = 'button') =>
    '[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(el=>el.checkVisibility() && ' +
    '(el.getAttribute("aria-label") || el.textContent.trim())' + (prefix ? '.startsWith(' + JSON.stringify(name) + ')' : ' === ' + JSON.stringify(name)) + ')';
  async function press(name, prefix, selector) {
    const match = target(name, prefix, selector);
    await waitFor(page, '!!(' + match + ') && !(' + match + ').disabled');
    await reach(page, match);
    assert.ok(await page.executeJavaScript('document.activeElement.matches(":focus-visible")'), 'Keyboard focus on ' + name);
    await keyboard(page, 'Enter', 13);
  }
  const setup = name => waitFor(page, '!!document.querySelector(' + JSON.stringify('main[data-setup-screen="' + name + '"]') + ')');
  const heading = name => waitFor(page, '[...document.querySelectorAll("h1")].some(el=>el.checkVisibility() && el.textContent.trim() === ' + JSON.stringify(name) + ')');
  const includes = text => waitFor(page, 'document.body.innerText.includes(' + JSON.stringify(text) + ')');
  async function capture(name) {
    await checkPage(page, 640);
    const { cssContentSize } = await page.debugger.sendCommand('Page.getLayoutMetrics');
    const { data } = await page.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height), scale: 1 } });
    fs.writeFileSync(path.join(directory, 'walkthrough-' + name + '.png'), Buffer.from(data, 'base64'));
  }
  await page.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 640, height: 450, deviceScaleFactor: 2, mobile: false });
  await page.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-color-scheme',value:'light'},{name:'prefers-reduced-motion',value:'reduce'}] });
  stage('keyboard: connect sales folder and resume the observed order');
  publish({});
  await page.loadURL(appUrl); await setup('welcome');
  await press('Connect my records'); await setup('start'); await press('In a spreadsheet or folder', true);
  await setup('files'); await press('Choose a folder myself', true); await setup('checked');
  await press('Open order ' + order.orderReference); await setup('first');
  await page.loadURL(appUrl); await setup('first'); await includes(order.orderReference);
  await capture('first-order');

  stage('keyboard: select a writable destination and approve the requested scope');
  await press('Turn on automatic updates'); await setup('output');
  await press('Choose proof folder'); await includes(output); await press('Continue');
  await setup('activate'); await includes('Sales reports'); await includes(output);
  await capture('review-permissions'); await press('Review in browser');
  await waitFor(page, '!!(' + target('Open browser review') + ')');
  // The main process opens the initial external review. Exercise its explicit
  // reopen control through the preload before supplying the external decision.
  await press('Open browser review');
  publish({ phase: 'active', step: 'overview', approvalPath: null, canReadOrders: true, viewKey: 'approved-walkthrough', orders: [order],
    sources: [{ ...source, state: 'active' }] });
  // Resume from the returned service grant through normal renderer polling.
  await setup('done'); await press('Open my workspace'); await heading('Workspace overview');
  stage('keyboard: find an order and trace its quantity to the original');
  await press('Orders', false, 'nav button'); await heading('Orders');
  await reach(page, 'document.querySelector("input[aria-label=\'Order reference\']")');
  await page.debugger.sendCommand('Input.insertText', {text:order.orderReference});
  await press('Find order'); await press(order.orderReference, true);
  await heading('Proof ' + order.proofId);
  await reach(page, target('Overview', false, '[role=tab]'));
  await keyboard(page, 'ArrowRight', 39);
  await waitFor(page, '(' + target('Items', false, '[role=tab]') + ')?.getAttribute("aria-selected") === "true"');
  await press('Valve: Ordered 8 EA'); await includes('Valve,8,EA');
  await press('Source details'); await includes(event.receiptId);
  await capture('quantity-provenance'); await press('Back', false, 'dialog button'); await press('Close', false, 'dialog button');
  await waitFor(page, '(' + target('Items', false, '[role=tab]') + ')?.getAttribute("aria-selected") === "true" && !document.querySelector("dialog[open]")');
  const tree = await page.debugger.sendCommand('Accessibility.getFullAXTree');
  assert.ok(tree.nodes.some(n => n.role?.value === 'heading' && n.name?.value === 'Proof ' + order.proofId));
  // Returning from metadata can reread the same exact source at the same revision.
  const operations = calls.filter((entry, i) => entry !== calls[i - 1]);
  assert.deepEqual(operations, ['choose folder','choose output','request access','open browser','find order','open committed revision','read exact source']);
  report.keyboardWalkthrough = { scope: 'Packaged renderer and preload, real keyboard, isolated service and external approval', cssWidth: 640, scale: 2, checks: calls };
};
