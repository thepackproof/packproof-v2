// Runs only as the Electron entry of the disposable Windows acceptance fixture.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const fixture = JSON.parse(fs.readFileSync(process.env.PACKPROOF_COMMERCE_FIXTURE, 'utf8'));
const pipePrefix = '\\\\.\\pipe\\';
if (!path.isAbsolute(fixture.root) || !fixture.pipe.startsWith(pipePrefix) || !/^packproof-commerce-[a-f0-9-]{36}$/.test(fixture.pipe.slice(pipePrefix.length))) throw Error('Invalid isolated fixture');
const dist = path.resolve(__dirname, '../../connect-windows/dist/commerce/main');
const cfg = JSON.parse(fs.readFileSync(path.join(dist, 'runtime-config.json'), 'utf8'));
if (cfg.channel !== 'development') throw Error('The isolated test requires a development build');
process.env.LOCALAPPDATA = path.join(fixture.root, 'native-profile');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-gpu');
// Never register this temporary build as the user's desktop URL handler.
app.setAsDefaultProtocolClient = () => false;
const pipeName = fixture.pipe;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.host === 'cognito-idp.' + cfg.cognito.region + '.amazonaws.com' && request.method === 'POST' &&
      request.headers.get('x-amz-target') === 'AWSCognitoIdentityProviderService.InitiateAuth') {
    const auth = await request.json();
    assert.equal(auth.ClientId, cfg.cognito.clientId);
    return Response.json({ AuthenticationResult: { AccessToken: fixture.token, ExpiresIn: 3600 } });
  }
  if (url.origin !== cfg.apiBaseUrl) throw Error('An endpoint outside the fixture was requested');
  const bytes = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ socketPath: pipeName, path: url.pathname + url.search,
      method: request.method, headers: Object.fromEntries(request.headers), signal: request.signal }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(
        [204,205,304].includes(response.statusCode) ? null : Buffer.concat(chunks),
        {status: response.statusCode,headers: response.headers}
      )));
    });
    outgoing.on('error', reject);
    outgoing.end(bytes);
  });
};

let win;
let step = 'launch';
const state = {};
app.on('browser-window-created', (_event, window) => {
  if (!win) { win = window; window.webContents.setBackgroundThrottling(false); }
});
require(path.join(dist,'index.cjs'));

async function until(name, fn, seconds = 20) {
  step = name;
  const deadline = Date.now() + seconds*1000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(180);
  }
  throw Error('Timed out waiting for '+name);
}
const js = expression => win.webContents.executeJavaScript(expression, true);
function button(label) {
  return until(label, () => js(`(()=>{const re=new RegExp(${JSON.stringify(label)},'i');
    const b=Array.from(document.querySelectorAll('button')).find(x=>!x.disabled &&
      x.getClientRects().length && re.test((x.getAttribute('aria-label')||x.textContent).trim()));
    if(!b)return false;b.click();return true})()`));
}
const checkbox = () => until('review declaration',()=>js("(()=>{const c=Array.from(document.querySelectorAll('input[type=checkbox]')).find(x=>!x.disabled&&x.getClientRects().length);if(!c)return false;c.click();return c.checked})()"));
function openProof() { app.emit('open-url',{preventDefault(){}},'packproof-dev://proof/'+fixture.proofId); }
async function run() {
  await until('protected renderer',()=>win && win.webContents.getURL().startsWith('packproof-app://') && js('!!window.packproof?.auth'));
  assert.equal(win.webContents.getLastWebPreferences().sandbox,true);
  assert.equal(win.webContents.getLastWebPreferences().contextIsolation,true);
  await js("window.packproof.auth.signIn({email:'commerce-test@example.invalid',password:'isolated-synthetic-login'})");
  // Unified builds intentionally launch the approved Logistics workspace first.
  // Commerce acceptance must explicitly enter Commerce, not depend on an old default.
  await button('^Open Commerce workspace$');
  await until('signed-in Commerce home',()=>js("!!document.querySelector('.app-layout .sidebar nav')"));
  openProof();
  await button('^Record packing$');
  await button('^Start recording|^Record packing$');
  await until('live synthetic camera',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.srcObject?.getVideoTracks().some(t=>t.readyState==='live') && v.videoWidth>0)"));
  await delay(3200);
  await button('^Stop recording$|^Finished packing$');
  await until('playable local recording',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.currentSrc.startsWith('packproof-media:')&&v.readyState>=2&&v.videoWidth>0)"));
  await checkbox();
  await button('^Save to PackProof|^Confirm & upload');
  const proof = await until('finalized recording',async()=>{
    const p=await js('window.packproof.proofs.detail('+JSON.stringify(fixture.proofId)+')');
    return p.status==='FINALIZED' && p.evidence.some(e=>e.validationStatus==='COMMITTED') && p;
  },50);
  const evidence=proof.evidence.find(e=>e.validationStatus==='COMMITTED');
  Object.assign(state,{proofId:proof.proofId,evidenceId:evidence.evidenceId,sha256:evidence.sha256,byteSize:evidence.byteSize});
  assert.ok(state.byteSize>0 && /^[a-f0-9]{64}$/.test(state.sha256));
  openProof();
  await until('recording history',()=>js(`(()=>{
    const summary=Array.from(document.querySelectorAll('details summary')).find(s=>s.textContent.includes('Recording history'));
    if(!summary)return false;
    const history=summary.parentElement;
    if(!history.open)summary.click();
    return Array.from(history.querySelectorAll('article')).some(card=>card.getClientRects().length && card.innerText.includes('Committed'));
  })()`));
  state.renderedHistory=true;
  await button('^Share$|^Share (this )?Proof$');
  await button('^Review original$');
  await until('playback of committed original',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.currentSrc.startsWith('packproof-media:')&&v.readyState>=2&&v.videoWidth>0)"));
  state.previewed=true;
  await checkbox();
  await button('^Copy Proof link$|^Create share link$');
  await until('reviewed share link',()=>js("!!document.querySelector('input[readonly]')?.value"));
  state.shareReviewed=true;
  fs.writeFileSync(path.join(fixture.root,'commerce-result.json'),JSON.stringify(state,null,2));
}
run().then(()=>app.exit(0)).catch(async error=>{
  const labels=win&&!win.isDestroyed()?await js("({buttons:Array.from(document.querySelectorAll('button')).filter(x=>x.getClientRects().length).map(x=>x.textContent.trim().slice(0,80)).slice(0,16),alerts:Array.from(document.querySelectorAll('[role=alert]')).map(e=>e.textContent.slice(0,200)),heading:document.querySelector('h1')?.textContent})").catch(()=>({})): {};
  console.error('Commerce fixture',step,error.message,JSON.stringify(labels));
  app.exit(1);
});
);
  await until('signed-in Commerce home',()=>js("!!document.querySelector('nav[aria-label=\"Main navigation\"]')"));
  openProof();
  await button('^Record packing$');
  await button('^Start recording|^Record packing$');
  await until('live synthetic camera',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.srcObject?.getVideoTracks().some(t=>t.readyState==='live') && v.videoWidth>0)"));
  await delay(3200);
  await button('^Stop recording$|^Finished packing$');
  await until('playable local recording',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.currentSrc.startsWith('packproof-media:')&&v.readyState>=2&&v.videoWidth>0)"));
  await checkbox();
  await button('^Save to PackProof|^Confirm & upload');
  const proof = await until('finalized recording',async()=>{
    const p=await js('window.packproof.proofs.detail('+JSON.stringify(fixture.proofId)+')');
    return p.status==='FINALIZED' && p.evidence.some(e=>e.validationStatus==='COMMITTED') && p;
  },50);
  const evidence=proof.evidence.find(e=>e.validationStatus==='COMMITTED');
  Object.assign(state,{proofId:proof.proofId,evidenceId:evidence.evidenceId,sha256:evidence.sha256,byteSize:evidence.byteSize});
  assert.ok(state.byteSize>0 && /^[a-f0-9]{64}$/.test(state.sha256));
  openProof();
  await until('recording history',()=>js(`(()=>{
    const summary=Array.from(document.querySelectorAll('details summary')).find(s=>s.textContent.includes('Recording history'));
    if(!summary)return false;
    const history=summary.parentElement;
    if(!history.open)summary.click();
    return Array.from(history.querySelectorAll('article')).some(card=>card.getClientRects().length && card.innerText.includes('Committed'));
  })()`));
  state.renderedHistory=true;
  await button('^Share$|^Share (this )?Proof$');
  await button('^Review original$');
  await until('playback of committed original',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.currentSrc.startsWith('packproof-media:')&&v.readyState>=2&&v.videoWidth>0)"));
  state.previewed=true;
  await checkbox();
  await button('^Copy Proof link$|^Create share link$');
  await until('reviewed share link',()=>js("!!document.querySelector('input[readonly]')?.value"));
  state.shareReviewed=true;
  fs.writeFileSync(path.join(fixture.root,'commerce-result.json'),JSON.stringify(state,null,2));
}
run().then(()=>app.exit(0)).catch(async error=>{
  const labels=win&&!win.isDestroyed()?await js("({buttons:Array.from(document.querySelectorAll('button')).filter(x=>x.getClientRects().length).map(x=>x.textContent.trim().slice(0,80)).slice(0,16),alerts:Array.from(document.querySelectorAll('[role=alert]')).map(e=>e.textContent.slice(0,200)),heading:document.querySelector('h1')?.textContent})").catch(()=>({})): {};
  console.error('Commerce fixture',step,error.message,JSON.stringify(labels));
  app.exit(1);
});
);
  await until('signed-in Commerce home',()=>js("!!document.querySelector('nav[aria-label=\"Main navigation\"]')"));
  openProof();
  await button('^Record packing$');
  await button('^Start recording|^Record packing$');
  await until('live synthetic camera',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.srcObject?.getVideoTracks().some(t=>t.readyState==='live') && v.videoWidth>0)"));
  await delay(3200);
  await button('^Stop recording$|^Finished packing$');
  await until('playable local recording',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.currentSrc.startsWith('packproof-media:')&&v.readyState>=2&&v.videoWidth>0)"));
  await checkbox();
  await button('^Save to PackProof|^Confirm & upload');
  const proof = await until('finalized recording',async()=>{
    const p=await js('window.packproof.proofs.detail('+JSON.stringify(fixture.proofId)+')');
    return p.status==='FINALIZED' && p.evidence.some(e=>e.validationStatus==='COMMITTED') && p;
  },50);
  const evidence=proof.evidence.find(e=>e.validationStatus==='COMMITTED');
  Object.assign(state,{proofId:proof.proofId,evidenceId:evidence.evidenceId,sha256:evidence.sha256,byteSize:evidence.byteSize});
  assert.ok(state.byteSize>0 && /^[a-f0-9]{64}$/.test(state.sha256));
  openProof();
  await until('recording history',()=>js(`(()=>{
    const summary=Array.from(document.querySelectorAll('details summary')).find(s=>s.textContent.includes('Recording history'));
    if(!summary)return false;
    const history=summary.parentElement;
    if(!history.open)summary.click();
    return Array.from(history.querySelectorAll('article')).some(card=>card.getClientRects().length && card.innerText.includes('Committed'));
  })()`));
  state.renderedHistory=true;
  await button('^Share$|^Share (this )?Proof$');
  await button('^Review original$');
  await until('playback of committed original',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.currentSrc.startsWith('packproof-media:')&&v.readyState>=2&&v.videoWidth>0)"));
  state.previewed=true;
  await checkbox();
  await button('^Copy Proof link$|^Create share link$');
  await until('reviewed share link',()=>js("!!document.querySelector('input[readonly]')?.value"));
  state.shareReviewed=true;
  fs.writeFileSync(path.join(fixture.root,'commerce-result.json'),JSON.stringify(state,null,2));
}
run().then(()=>app.exit(0)).catch(async error=>{
  const labels=win&&!win.isDestroyed()?await js("({buttons:Array.from(document.querySelectorAll('button')).filter(x=>x.getClientRects().length).map(x=>x.textContent.trim().slice(0,80)).slice(0,16),alerts:Array.from(document.querySelectorAll('[role=alert]')).map(e=>e.textContent.slice(0,200)),heading:document.querySelector('h1')?.textContent})").catch(()=>({})): {};
  console.error('Commerce fixture',step,error.message,JSON.stringify(labels));
  app.exit(1);
});
);
  await until('signed-in Commerce home',()=>js("!!document.querySelector('nav[aria-label=\"Main navigation\"]')"));
  openProof();
  await button('^Record packing$');
  await button('^Start recording|^Record packing$');
  await until('live synthetic camera',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.srcObject?.getVideoTracks().some(t=>t.readyState==='live') && v.videoWidth>0)"));
  await delay(3200);
  await button('^Stop recording$|^Finished packing$');
  await until('playable local recording',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.currentSrc.startsWith('packproof-media:')&&v.readyState>=2&&v.videoWidth>0)"));
  await checkbox();
  await button('^Save to PackProof|^Confirm & upload');
  const proof = await until('finalized recording',async()=>{
    const p=await js('window.packproof.proofs.detail('+JSON.stringify(fixture.proofId)+')');
    return p.status==='FINALIZED' && p.evidence.some(e=>e.validationStatus==='COMMITTED') && p;
  },50);
  const evidence=proof.evidence.find(e=>e.validationStatus==='COMMITTED');
  Object.assign(state,{proofId:proof.proofId,evidenceId:evidence.evidenceId,sha256:evidence.sha256,byteSize:evidence.byteSize});
  assert.ok(state.byteSize>0 && /^[a-f0-9]{64}$/.test(state.sha256));
  openProof();
  await until('recording history',()=>js(`(()=>{
    const summary=Array.from(document.querySelectorAll('details summary')).find(s=>s.textContent.includes('Recording history'));
    if(!summary)return false;
    const history=summary.parentElement;
    if(!history.open)summary.click();
    return Array.from(history.querySelectorAll('article')).some(card=>card.getClientRects().length && card.innerText.includes('Committed'));
  })()`));
  state.renderedHistory=true;
  await button('^Share$|^Share (this )?Proof$');
  await button('^Review original$');
  await until('playback of committed original',()=>js("Array.from(document.querySelectorAll('video')).some(v=>v.currentSrc.startsWith('packproof-media:')&&v.readyState>=2&&v.videoWidth>0)"));
  state.previewed=true;
  await checkbox();
  await button('^Copy Proof link$|^Create share link$');
  await until('reviewed share link',()=>js("!!document.querySelector('input[readonly]')?.value"));
  state.shareReviewed=true;
  fs.writeFileSync(path.join(fixture.root,'commerce-result.json'),JSON.stringify(state,null,2));
}
run().then(()=>app.exit(0)).catch(async error=>{
  const labels=win&&!win.isDestroyed()?await js("({buttons:Array.from(document.querySelectorAll('button')).filter(x=>x.getClientRects().length).map(x=>x.textContent.trim().slice(0,80)).slice(0,16),alerts:Array.from(document.querySelectorAll('[role=alert]')).map(e=>e.textContent.slice(0,200)),heading:document.querySelector('h1')?.textContent})").catch(()=>({})): {};
  console.error('Commerce fixture',step,error.message,JSON.stringify(labels));
  app.exit(1);
});
