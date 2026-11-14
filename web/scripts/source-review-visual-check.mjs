/** CI-only synthetic rendering. No accounts, hosted API, or Windows qualification. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url), web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), out = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(web, '../artifacts/WEB_ACCEPTANCE'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'packproof-source-review-'));
const fixture = path.join(web, 'scripts/fixtures/source-review-visual.tsx');
const config = { configFile: false, root: temporary, plugins: [react()], logLevel: 'warn',
  resolve: { alias: { react: path.dirname(require.resolve('react/package.json')), 'react-dom': path.dirname(require.resolve('react-dom/package.json')),
    '@packproof/station': path.join(web, '../mobile/src/packing-station'), '@packproof/copy': path.join(web, '../mobile/src/copy'), '@packproof/theme': path.join(web, '../mobile/src/theme') } },
  esbuild: { tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', useDefineForClassFields: true } }) },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [temporary, path.resolve(web, '..')] } } };
await writeFile(path.join(temporary, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Synthetic source review QA</title></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`);

class Cdp {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.handlers = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) { const item = this.pending.get(message.id); if (!item) return; this.pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(`${item.method}: ${message.error.message}`)) : item.resolve(message.result); }
      else for (const handler of this.handlers.get(message.method) || []) handler(message.params);
    });
  }
  static async connect(url) { const socket = new WebSocket(url); await new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.close(); reject(Error('Local Chrome WebSocket connection timed out')); }, 10000); socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true }); }); return new Cdp(socket); }
  on(method, handler) { this.handlers.set(method, [...(this.handlers.get(method) || []), handler]); }
  send(method, params = {}) {
    return new Promise((resolve, reject) => { const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000); this.pending.set(id, { resolve, reject, timer, method }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) { const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result.value; }
  close() { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error('Synthetic page closed')); } this.pending.clear(); this.socket.close(); }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(cdp, expression) { for (let count = 0; count < 100; count++) { if (await cdp.evaluate(expression)) return; await delay(100); } throw Error(`Synthetic render timed out: ${expression}`); }
const control = name => `([...document.querySelectorAll('label')].find(label => [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim() === ${JSON.stringify(name)})?.querySelector('input,select,textarea'))`;
const button = name => `([...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(name)}))`;
async function press(cdp, key) { const code = { Tab: 9, Enter: 13, ' ': 32 }[key]; for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: code }); }
async function focus(cdp, expression) { await cdp.evaluate(`(${expression}).focus()`); }
async function fill(cdp, name, value) { await cdp.evaluate(`(() => { const element = ${control(name)}; if (!element) throw Error('Missing labeled control'); const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`); }
async function tabTo(cdp, expression) { for (let count = 0; count < 30; count++) { if (await cdp.evaluate(`document.activeElement === (${expression})`)) return; await press(cdp, 'Tab'); } throw Error(`Control not keyboard reachable: ${expression}`); }
async function disclosure(cdp, text) { await focus(cdp, `([...document.querySelectorAll('summary')].find(summary => summary.textContent.trim() === ${JSON.stringify(text)}))`); await press(cdp, 'Enter'); }
async function screenshot(cdp, destination, fullPage) {
  let params = { format: 'png', captureBeyondViewport: !!fullPage, fromSurface: true };
  if (fullPage) { const { cssContentSize } = await cdp.send('Page.getLayoutMetrics'); params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 }; }
  const { data } = await cdp.send('Page.captureScreenshot', params); await writeFile(destination, Buffer.from(data, 'base64'));
}
async function chromeEndpoint(child, diagnostics) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Chrome did not expose local CDP: ${diagnostics.stderr}`)), 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Chrome exited ${code}: ${diagnostics.stderr}`)); });
    child.stderr.on('data', data => { diagnostics.stderr = (diagnostics.stderr + data).slice(-4000); const found = diagnostics.stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (found) { clearTimeout(timer); resolve(`http://${new URL(found[1]).host}`); } });
  });
}
let server, chrome;
const report = { schema: 'packproof.synthetic-source-review-visual/v1', synthetic: true, candidateSha: process.env.GITHUB_SHA || null,
  acceptance: 'Local component render only; no hosted login, actual source qualification, or installed Windows acceptance.', results: [], error: null };
try {
  if (args.includes('--check-bundle')) { await build({ ...config, build: { outDir: path.join(temporary, 'bundle') } }); console.log('Synthetic source review fixture bundled; browser rendering was not run.'); }
  else {
    await mkdir(out, { recursive: true });
    server = await createServer(config); await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`, diagnostics = { stderr: '' };
    chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'chrome')}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    const debug = await chromeEndpoint(chrome, diagnostics);
    for (const width of [1440, 390]) for (const scenario of ['backfill', 'completeness']) {
      const target = await (await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' })).json(), cdp = await Cdp.connect(target.webSocketDebuggerUrl);
      const runtimeErrors = [], blockedRequests = [];
      cdp.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
      cdp.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') runtimeErrors.push(event.args.map(argument => argument.value ?? argument.description ?? '').join(' ')); });
      cdp.on('Log.entryAdded', event => { if (event.entry.level === 'error') runtimeErrors.push(event.entry.text); });
      cdp.on('Fetch.requestPaused', event => { const allowed = event.request.url.startsWith(`${origin}/`) || event.request.url.startsWith(`${origin.replace(/^http/, 'ws')}/`) || event.request.url.startsWith('data:'); if (!allowed) blockedRequests.push(event.request.url); void cdp.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: event.requestId } : { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(error => runtimeErrors.push(error.message)); });
      try {
        await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable'); await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 1200 : 844, deviceScaleFactor: 1, mobile: width === 390 });
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] });
        await cdp.send('Page.navigate', { url: `${origin}/?scenario=${scenario}` });
        await until(cdp, `document.body.innerText.includes(${JSON.stringify(scenario === 'backfill' ? 'Waiting for historical import approval' : 'Configure snapshot completeness controls')})`);
        let submit;
        if (scenario === 'backfill') {
          await disclosure(cdp, 'Exact historical originals (2)');
          await fill(cdp, 'Reason for this historical import decision', 'Synthetic local render review');
          await fill(cdp, 'Historical import approval expires (your timezone)', new Date(Date.now() + 3600000).toISOString().slice(0, 16));
          await focus(cdp, control('Reason for this historical import decision'));
          await tabTo(cdp, control('I reviewed these exact historical files and authorize their complete-original upload, source interval and update meaning until the chosen expiry.'));
          await press(cdp, ' '); submit = button('Approve exact historical import');
        } else {
          await disclosure(cdp, 'Configure snapshot completeness controls'); await focus(cdp, control('Use existing exporter snapshot control columns')); await press(cdp, ' ');
          await until(cdp, `!!${control('Snapshot marker column')}`);
          await fill(cdp, 'Snapshot marker column', ' Export mArKer '); await fill(cdp, 'Snapshot as-of column', 'Export As Of'); await fill(cdp, 'Snapshot data-row count column', 'Export Data Rows');
          await fill(cdp, 'Snapshot completeness qualification reference', 'synthetic-exporter-controls/1');
          await focus(cdp, control('The source owner confirmed these exporter controls describe the complete snapshot for this inventory scope.')); await press(cdp, ' ');
          await tabTo(cdp, control('Save these exact completeness controls as a new source revision for separate approval.')); await press(cdp, ' '); submit = button('Save completeness policy for review');
        }
        await until(cdp, `!!${submit} && !${submit}.disabled`); await tabTo(cdp, submit);
        const layout = await cdp.evaluate(`({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, focused: document.activeElement === ${submit}, focusOutline: getComputedStyle(${submit}).outlineStyle, focusOutlineWidth: getComputedStyle(${submit}).outlineWidth, offscreenControls: [...document.querySelectorAll('input,select,textarea,button,summary')].filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1); }).map(element => ({ tag: element.tagName, label: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0,100) })) })`);
        await screenshot(cdp, path.join(out, `${scenario}-${width}-full.png`), true); await screenshot(cdp, path.join(out, `${scenario}-${width}-keyboard.png`), false);
        await press(cdp, 'Enter'); await until(cdp, 'window.__writes?.length === 1');
        const writes = await cdp.evaluate('window.__writes');
        report.results.push({ scenario, width, layout, runtimeErrors, blockedRequests, writes });
        assert.equal(runtimeErrors.length, 0, 'Synthetic component runtime exceptions'); assert.equal(blockedRequests.length, 0, 'Fixture attempted a nonlocal request');
        assert.ok(Math.abs(layout.viewport - width) <= 1, `${scenario}/${width}: emulated CSS viewport is incorrect`);
        assert.ok(layout.documentWidth <= width + 1, `${scenario}/${width}: page overflows horizontally`); assert.equal(layout.offscreenControls.length, 0, 'A control is clipped horizontally');
        assert.equal(layout.focused, true); assert.notEqual(layout.focusOutline, 'none'); assert.ok(parseFloat(layout.focusOutlineWidth) > 0);
        const body = writes[0].body; assert.equal(body.organizationId, 'org-a'); assert.equal(body.environment, 'sandbox'); assert.equal(body.configurationRevision, 2);
        if (scenario === 'backfill') { assert.equal(body.action, 'approve'); assert.equal(body.wholeFileConsent, true); assert.equal(body.expectedDecisionId, null); assert.equal(body.manifestSha256, 'd'.repeat(64)); }
        else { assert.equal(body.action, 'revise'); assert.deepEqual(body.config.completenessPolicy.fileBoundary, { schema: 'packproof.csv-snapshot-boundary/v1', markerColumn: ' Export mArKer ', asOfColumn: 'Export As Of', rowCountColumn: 'Export Data Rows' }); }
      } finally { cdp.close(); await fetch(`${debug}/json/close/${target.id}`).catch(() => {}); }
    }
    await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); console.log(`Passed ${report.results.length} synthetic source review renders; PNG and JSON evidence: ${out}`);
  }
} catch (error) { report.error = error.stack || String(error); await mkdir(out, { recursive: true }); await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); throw error; }
finally { chrome?.kill('SIGKILL'); await server?.close(); await rm(temporary, { recursive: true, force: true }); }
