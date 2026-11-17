// Drives the built web portal against the isolated journey's HTTP application.
// Only loopback requests and the test-created Windows pipe are available.
const { app, BrowserWindow, session } = require('electron');
const { createServer, request } = require('node:http');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function run() {
  const fixture = JSON.parse(await readFile(process.env.PACKPROOF_BROWSER_FIXTURE, 'utf8'));
  if (!/^packproof-journey-[a-f0-9-]{36}$/.test(fixture.pipe) ||
      !fixture.approvalPath.startsWith('/app/records/connect/approve?') ||
      (fixture.proof && (!/^proof_[a-zA-Z0-9]+$/.test(fixture.proof.id) || !Number.isSafeInteger(fixture.proof.revision)))) throw Error('Unexpected fixture scope');
  const dist = path.resolve(__dirname, '../../web/dist');
  const socketPath = '\\\\.\\pipe\\' + fixture.pipe;
  const http = createServer(async (incoming, response) => {
    const url = new URL(incoming.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const call = request({ socketPath, path: url.pathname.slice(4) + url.search, method: incoming.method, headers: incoming.headers }, result => {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
      });
      call.once('error', () => { response.writeHead(502); response.end(); });
      incoming.pipe(call);
      return;
    }
    if (url.pathname === '/fixture-session') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Test session</title>'); return; }
    const asset = url.pathname.match(/^\/assets\/([a-zA-Z0-9_.-]+)$/);
    const relative = asset ? path.join('assets', asset[1]) : 'index.html';
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm', '.png': 'image/png', '.woff2': 'font/woff2' };
    try {
      const bytes = await readFile(path.join(dist, relative));
      response.writeHead(200, { 'content-type': types[path.extname(relative)] || 'application/octet-stream' });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  try {
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + http.address().port;
    const isolated = session.fromPartition('order-approval-fixture');
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: new URL(details.url).origin !== origin });
    });
    const win = new BrowserWindow({ width: 1220, height: 940, show: false, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const browser = win.webContents;
    await win.loadURL(origin + '/fixture-session');
    const identity = { apiBaseUrl: origin + '/api', authMode: 'dev', userId: fixture.owner, username: 'fixture-owner',
      displayName: 'Fixture owner', token: fixture.owner, subject: fixture.owner };
    await browser.executeJavaScript('sessionStorage.setItem("packproof-v2-web.session", ' + JSON.stringify(JSON.stringify(identity)) + ')');
    const locator = new URL(fixture.approvalPath, origin);
    const scope = new URLSearchParams({ organizationId: locator.searchParams.get('organizationId'), environment: locator.searchParams.get('environment') });
    await win.loadURL(fixture.proof ? origin + '/app/order-proofs/' + fixture.proof.id + '?' + scope : locator.href);
    async function until(expression, description) {
      for (let i = 0; i < 120; i++) {
        const value = await browser.executeJavaScript(expression);
        if (value) return value;
        await delay(250);
      }
      const headings = await browser.executeJavaScript("Array.from(document.querySelectorAll('h1,h2,[role=alert]'), el=>el.textContent.slice(0,120)).slice(0,6)");
      throw Error(description + ' · ' + headings.join(' / '));
    }
    const shots = path.resolve(__dirname, '../build/workspace-screens');
    await mkdir(shots, { recursive: true });
    if (fixture.proof) {
      const expectation = JSON.stringify('Revision ' + fixture.proof.revision + ' · ' + fixture.proof.id);
      await until(`(() => {
        const heading = Array.from(document.querySelectorAll('h1')).some(el => el.textContent.trim() === 'SO10482');
        const history = Array.from(document.querySelectorAll('details p')).some(el => el.textContent.trim() === ${expectation});
        const line = Array.from(document.querySelectorAll('li')).find(el => el.textContent.includes('Line 20') && el.querySelector('dl'));
        if (!heading || !history || !line) return false;
        const values = Object.fromEntries(Array.from(line.querySelectorAll('dt'), el => [el.textContent, el.nextElementSibling?.textContent]));
        return values.Ordered === '3' && values.Shipped === '2';
      })()`, 'The order page did not show the verified revision and line quantities');
      await writeFile(path.join(shots, 'browser-verified-order.png'), (await browser.capturePage()).toPNG());
      win.destroy();
      return;
    }
    const point = await until(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === 'Approve collection' && !el.disabled);
      if (!button) return null;
      button.scrollIntoView({block:'center'});
      const box=button.getBoundingClientRect(), x=Math.floor(box.x+box.width/2), y=Math.floor(box.y+box.height/2);
      return button.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
    })()`, 'Consent control was unavailable');
    await writeFile(path.join(shots, 'browser-approval-scope.png'), (await browser.capturePage()).toPNG());
    browser.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    browser.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until("Array.from(document.querySelectorAll('[role=status]')).some(el => el.textContent.includes('Access approved'))", 'The browser did not confirm approval');
    await writeFile(path.join(shots, 'browser-approval-confirmed.png'), (await browser.capturePage()).toPNG());
    win.destroy();
  } finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
}
app.whenReady().then(run).then(() => app.exit(0), err => { console.error(err.message); app.exit(1); });
