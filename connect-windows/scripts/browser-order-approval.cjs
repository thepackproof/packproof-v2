// Drives the built web portal against the isolated journey's HTTP application.
// Only loopback requests and the test-created Windows pipe are available.
const { app, BrowserWindow, session, nativeImage } = require('electron');
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
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm', '.png': 'image/png', '.svg':'image/svg+xml', '.woff2': 'font/woff2', '.woff':'font/woff', '.ico':'image/x-icon' };
    const relative = url.pathname === '/' || url.pathname.startsWith('/app/') ? 'index.html' : url.pathname.slice(1);
    if (!/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(relative) || !types[path.extname(relative)]) {
      response.writeHead(404); response.end(); return;
    }
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
    const win = new BrowserWindow({ width: 1280, height: 1024, useContentSize:true, show: false, webPreferences: {
      session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false
    } });
    const browser = win.webContents;
    browser.setFrameRate(30);
    browser.debugger.attach('1.3');
    await browser.debugger.sendCommand('Page.enable');
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
    async function photograph(name, landmarks, maximumHeight=2000) {
      await browser.executeJavaScript('window.scrollTo(0,0)');
      await browser.executeJavaScript('Promise.all([document.fonts.ready,...Array.from(document.images,img=>img.decode())])');
      // Read text boxes from the current page, then verify their real compositor
      // pixels in the PNG. A matching DOM alone can precede a completed paint.
      const boxesExpression = '(' + function(labels) {
        const nodes=Array.from(document.querySelectorAll('h1,h2,p,dt,button'));
        return labels.map(label=>{
          const el=nodes.find(node=>node.textContent.trim()===label);
          if(!el) return null;
          const range=document.createRange();range.selectNodeContents(el);
          const box=range.getBoundingClientRect();
          return {x:box.x+scrollX,y:box.y+scrollY,w:box.width,h:box.height};
        });
      }.toString()+')('+JSON.stringify(landmarks)+')';
      for(let attempt=0;attempt<25;attempt++){
        await browser.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
        const boxes=await browser.executeJavaScript(boxesExpression);
        const {cssContentSize:content}=await browser.debugger.sendCommand('Page.getLayoutMetrics');
        const width=Math.ceil(content.width), height=Math.min(maximumHeight,Math.ceil(content.height));
        const result=await browser.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true,
          captureBeyondViewport:true,clip:{x:0,y:0,width,height,scale:1}});
        const bytes=Buffer.from(result.data,'base64'), frame=nativeImage.createFromBuffer(bytes);
        const size=frame.getSize(), pixels=frame.toBitmap();
        function hasPaint(box){
          if(!box || box.w<8 || box.h<5 || box.y+box.h>height) return false;
          const left=Math.max(0,Math.floor(box.x*size.width/width));
          const top=Math.max(0,Math.floor(box.y*size.height/height));
          const right=Math.min(size.width,Math.ceil((box.x+box.w)*size.width/width));
          const bottom=Math.min(size.height,Math.ceil((box.y+box.h)*size.height/height));
          const light=new Uint32Array(256);
          for(let y=top;y<bottom;y++) for(let x=left;x<right;x++){
            const i=(y*size.width+x)*4;
            light[Math.round((pixels[i]+pixels[i+1]*2+pixels[i+2])/4)]++;
          }
          const area=(bottom-top)*(right-left), minimum=Math.max(8,area*.025);
          let lower=0, upper=255, total=0;
          while(lower<255 && (total+=light[lower])<minimum) lower++;
          total=0;while(upper>0 && (total+=light[upper])<minimum) upper--;
          return upper-lower>55;
        }
        if(boxes.every(hasPaint) && (await browser.executeJavaScript(boxesExpression)).every(Boolean)){
          await writeFile(path.join(shots,name),bytes);
          return;
        }
        await delay(180);
      }
      throw Error('The Chromium screenshot did not paint all expected text: '+landmarks.join(', '));
    }
    if (fixture.proof) {
      const expectation = JSON.stringify('Revision ' + fixture.proof.revision + ' · ' + fixture.proof.id);
      await until(`(() => {
        const heading = Array.from(document.querySelectorAll('h1')).some(el => el.textContent.trim() === 'SO10482');
        const history = Array.from(document.querySelectorAll('details p')).some(el => el.textContent.trim() === ${expectation});
        const line = Array.from(document.querySelectorAll('li')).find(el => el.textContent.includes('Line 20') && el.querySelector('dl'));
        if (!heading || !history || !line) return false;
        const values = Object.fromEntries(Array.from(line.querySelectorAll('dt'), el => [el.textContent, el.nextElementSibling?.textContent]));
        return values.Ordered === '3' && values.Shipped === '2' &&
          Array.from(line.querySelectorAll('p')).some(el => el.textContent === '1 EA more ordered than shipped');
      })()`, 'The order page did not show the verified revision, line quantities and discrepancy');
      await photograph('browser-verified-order.png',['SO10482','Items','1 EA more ordered than shipped'],1400);
      win.destroy();
      return;
    }
    const locateApproval = `(() => {
      const button = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === 'Approve collection' && !el.disabled);
      if (!button) return null;
      button.scrollIntoView({block:'center'});
      const box=button.getBoundingClientRect(), x=Math.floor(box.x+box.width/2), y=Math.floor(box.y+box.height/2);
      return button.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
    })()`;
    await until(locateApproval,'Consent control was unavailable');
    await photograph('browser-approval-scope.png',['Allow collection on this computer?','Controlled Windows collector','Collection period','Approve collection'],3600);
    const point=await until(locateApproval,'Consent control was unavailable after capture');
    browser.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    browser.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until("Array.from(document.querySelectorAll('[role=status]')).some(el => el.textContent.includes('Access approved'))", 'The browser did not confirm approval');
    await photograph('browser-approval-confirmed.png',['Controlled Windows collector','Access approved. PackProof Connect will continue automatically.'],3600);
    win.destroy();
  } finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
}
app.whenReady().then(run).then(() => app.exit(0), err => { console.error(err.message); app.exit(1); });
