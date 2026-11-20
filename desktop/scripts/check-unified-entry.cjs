// Checks the exact renderer/preload copied into the unified Windows package.
// Uses synthetic IPC state for visual and navigation coverage only; this is NOT
// evidence of live authorization, real source collection, or a signed installer.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {setTimeout:wait}=require('node:timers/promises');
const {app,BrowserWindow,ipcMain,protocol,net}=require('electron');

const root=path.resolve(__dirname,'../..');
// Inspect the bytes inside the actual electron-builder app.asar, not a
// standalone dev renderer that might differ from the installed application.
const packagedAsar=path.join(root,'connect-windows','release',process.env.APP_ENV||'development','win32-x64','win-unpacked','resources','app.asar');
const assets=path.join(packagedAsar,'dist','commerce');
const renderer=path.join(assets,'renderer');
const preload=path.join(assets,'main','preload.cjs');
const out=path.join(root,'connect-windows','build','unified-ux-screens');
const uri='packproof-app://app/index.html';
protocol.registerSchemesAsPrivileged([{scheme:'packproof-app',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
app.enableSandbox();
const system={version:'0.7.0',platform:'win32',environment:'development',online:true,settings:{
  cameraId:'',microphoneId:'',audio:false,resolution:'1080p',frameRate:30,retentionHours:24,
  notifications:true,scannerSuffix:'Enter',theme:'light'
},update:{state:'unavailable'},reporting:{configured:false}};
const calls={orders:0,setup:0,choices:0};
let failChoices=false;
const sample={
  'auth.state':{userId:'fixture-operator',email:'operator@example.invalid',profile:{displayName:'Fixture Operator',username:'operator'}},
  'system.state':system,'proofs.list':[],'orders.list':[],'integrations.list':{accounts:[],providers:[]},
  'uploads.list':[],'onboarding.get':null
};
async function until(page,expression){
  for(let n=0;n<100;n++){
    if(await page.executeJavaScript(expression))return;
    await wait(100);
  }
  throw Error('Unified screen failed to show expected content: '+expression);
}
async function measure(page){
 const value=await page.executeJavaScript(`({
  width:innerWidth,scroll:document.documentElement.scrollWidth,
  headline:document.querySelector('h1')?.textContent?.trim(),
  primary:[...document.querySelectorAll('.logistics-entry-primary')].map(el=>({text:el.textContent.trim(),disabled:el.disabled})),
  bad:[...document.querySelectorAll('button')].filter(el=>{const r=el.getBoundingClientRect();return el.checkVisibility()&&(r.left<-1||r.right>innerWidth+1)}).map(el=>el.textContent.trim())
 })`);
 assert.ok(value.scroll<=value.width+1,'Unexpected horizontal scroll: '+JSON.stringify(value));
 assert.deepEqual(value.bad,[],'Clipped buttons: '+JSON.stringify(value));
 return value;
}
async function shoot(page,name){
 await page.executeJavaScript('document.fonts.ready.then(()=>true)');
 const img=await page.capturePage();
 fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,name+'.png'),img.toPNG());
}
async function main(){
 assert.ok(fs.existsSync(packagedAsar),'Packaged unified app.asar missing');
 assert.ok(fs.existsSync(preload),'Unified native preload missing');
 assert.ok(fs.existsSync(path.join(renderer,'index.html')),'Unified Commerce renderer missing');
 assert.ok(fs.existsSync(path.join(renderer,'brand','connect','packproof.png')),'Approved PackProof logo missing');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'packproof-unified-ux-'));
 app.setPath('userData',tmp);
 await app.whenReady();
 protocol.handle('packproof-app',async request=>{
  const url=new URL(request.url);
  if(url.host!=='app')return new Response(null,{status:403});
  let candidate;
  try{candidate=path.resolve(renderer,'.'+decodeURIComponent(url.pathname));}
  catch{return new Response(null,{status:400});}
  if(!candidate.startsWith(renderer+path.sep))return new Response(null,{status:403});
  if(!fs.existsSync(candidate))return new Response(null,{status:404});
  const result=await net.fetch(pathToFileURL(candidate).href);
  const headers=new Headers(result.headers);
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return new Response(result.body,{status:result.status,headers});
 });
 const win=new BrowserWindow({width:1440,height:900,show:true,backgroundColor:'#f6f8fc',webPreferences:{
  preload,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false
 }});
 const page=win.webContents;
 page.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true}));
 page.on('preload-error',(_event,_file,error)=>console.error('Unified preload failed:',error.message));
 page.on('console-message',details=>{if(details.level==='error')console.error('Unified renderer:',details.message);});
 ipcMain.handle('packproof:workspace.choices',async()=>{calls.choices++;return failChoices?{ok:false,error:'Reconnect this computer to its authorized facility.'}:{ok:true,value:{orders:true,setup:true}};});
 ipcMain.handle('packproof:workspace.orders',async()=>{calls.orders++;return {ok:true,value:null};});
 ipcMain.handle('packproof:workspace.setup',async()=>{calls.setup++;return {ok:true,value:null};});
 for(const [channel,value] of Object.entries(sample))ipcMain.handle('packproof:'+channel,async()=>({ok:true,value}));
 ipcMain.handle('packproof:study.scope',async()=>({ok:false,error:'Fixture does not enable analytics.'}));
 try{
  await page.loadURL(uri);
  await until(page,"document.querySelector('.logistics-entry h1')?.textContent?.includes('One clear story.')");
  await until(page,"[...document.querySelectorAll('.logistics-entry-primary')].some(e=>!e.disabled)");
  await measure(page);
  await shoot(page,'logistics-entry-1440x900');
  const active=await page.executeJavaScript("document.querySelector('.logistics-entry-brand img')?.complete && document.querySelector('.logistics-entry-brand img')?.naturalWidth>0");
  assert.equal(active,true,'Official logo failed to render');
  await page.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Open my orders'))?.click()");
  for(let i=0;i<30&&calls.orders<1;i++)await wait(50);
  assert.equal(calls.orders,1,'Logistics orders action was not sent through actual IPC bridge');
  await page.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Facility setup'))?.click()");
  for(let i=0;i<30&&calls.setup<1;i++)await wait(50);
  assert.equal(calls.setup,1,'Facility setup action was not sent through actual IPC bridge');

  page.debugger.attach('1.3');
  await page.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1024,height:640,deviceScaleFactor:1.25,mobile:false});
  await measure(page);await shoot(page,'logistics-entry-1280x800-125pct');
  await page.debugger.detach();

  // A rejected facility response must not collapse into an unexplained Commerce fallback.
  failChoices=true;
  await page.reload();
  await until(page,"document.querySelector('.logistics-entry-error')?.textContent?.includes('Reconnect this computer')");
  const diagnostic=await page.executeJavaScript("document.querySelector('.logistics-entry-error')?.textContent");
  assert.ok(diagnostic.includes('Reconnect this computer'));
  assert.ok(!diagnostic.includes('Logistics is unavailable'));
  await shoot(page,'logistics-access-recovery');
  failChoices=false;
  await page.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Check access again'))?.click()");
  await until(page,"[...document.querySelectorAll('.logistics-entry-primary')].some(e=>!e.disabled)");
  await page.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Open Commerce workspace'))?.click()");
  await until(page,"!!document.querySelector('.app-layout .sidebar nav')");
  await page.executeJavaScript("[...document.querySelectorAll('.logistics-return')][0]?.click()");
  await until(page,"!!document.querySelector('.logistics-entry h1')");
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({
   scope:'packaged unified renderer and production preload; synthetic IPC only',
   designFile:'PZ8dfCcXe2D8SMtmF497v3',entryNode:'2:9',
   screens:['logistics-entry-1440x900.png','logistics-entry-1280x800-125pct.png','logistics-access-recovery.png'],
   verified:['default Logistics route','official logo','Orders IPC','Setup IPC','error recovery','explicit Commerce switch','return to Logistics'],
   calls
  },null,2));
  console.log('Unified Windows entry renderer layout and functional IPC routing verified (synthetic state).');
 }finally{if(!win.isDestroyed())win.destroy();}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
