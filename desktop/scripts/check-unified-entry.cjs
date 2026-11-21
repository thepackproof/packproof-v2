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
const setupRenderer=path.join(packagedAsar,'dist','renderer');
const setupPreload=path.join(packagedAsar,'dist','main','preload.cjs');
const out=path.join(root,'connect-windows','build','unified-ux-screens');
const uri='packproof-app://app/index.html';
protocol.registerSchemesAsPrivileged(['packproof-app','packproof-connect'].map(scheme=>({scheme,privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}})));
app.enableSandbox();
const system={version:'0.7.0',platform:'win32',environment:'development',online:true,settings:{
  cameraId:'',microphoneId:'',audio:false,resolution:'1080p',frameRate:30,retentionHours:24,
  notifications:true,scannerSuffix:'Enter',theme:'light'
},update:{state:'unavailable'},reporting:{configured:false}};
const calls={orders:0,setup:0,choices:0};
const bootstrapCalls={review:0,recover:0,enroll:0,source:0};
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
async function viewport(page,w,h,scale=1){
 await page.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:w,height:h,screenWidth:w,screenHeight:h,deviceScaleFactor:scale,mobile:false});
 const actual=await page.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
 assert.deepEqual(actual,{width:w,height:h,dpr:scale},'Incorrect emulated viewport');
}
async function measure(page,w,h){
 const measured=await page.executeJavaScript(`({
  width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,
  headline:document.querySelector('h1')?.textContent?.trim(),
  primary:[...document.querySelectorAll('.logistics-entry-primary')].map(el=>({text:el.textContent.trim(),disabled:el.disabled})),
  clipped:[...document.querySelectorAll('button')].filter(el=>{const r=el.getBoundingClientRect();return el.checkVisibility()&&(r.left<-1||r.right>innerWidth+1)}).map(el=>el.textContent.trim())
 })`);
 assert.equal(measured.width,w,'Screenshot viewport width is not the requested width');
 assert.equal(measured.height,h,'Screenshot viewport height is not the requested height');
 assert.ok(measured.scroll<=w+1,'Unexpected horizontal scroll: '+JSON.stringify(measured));
 assert.deepEqual(measured.clipped,[],'Clipped buttons: '+JSON.stringify(measured));
 return measured;
}
async function shoot(page,name,w,h,scale=1){
 await page.executeJavaScript('document.fonts.ready.then(()=>true)');
 const shot=await page.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:true,clip:{x:0,y:0,width:w,height:h,scale:1}});
 const png=Buffer.from(shot.data,'base64');
 assert.ok(png.length>24,'Empty screenshot');
 const actual={width:png.readUInt32BE(16),height:png.readUInt32BE(20)};
 fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,name+'.png'),png);
 assert.deepEqual(actual,{width:Math.round(w*scale),height:Math.round(h*scale)},'Mislabelled packaged screenshot '+name);
 return {...actual,cssWidth:w,cssHeight:h,scale};
}
async function checkBootstrap(parent){
 assert.ok(fs.existsSync(setupPreload),'Packaged Connect preload missing');
 assert.ok(fs.existsSync(path.join(setupRenderer,'index.html')),'Packaged Connect setup renderer missing');
 let state={state:'source_selected',installationId:'installation_fixture',environment:'development',
   setupAccess:{reason:'facility_required'},health:{serviceOnline:true,queueCount:null},
   workspace:{phase:'draft',step:'order',sources:[],canReadOrders:false}};
 for(const method of ['getStatus','getWorkspaceStatus','pollEnrollment'])ipcMain.handle('connect:'+method,async()=>({ok:true,value:state}));
 ipcMain.handle('connect:openWorkspaceApproval',async()=>{bootstrapCalls.review++;return{ok:true};});
 ipcMain.handle('connect:recoverEnrollment',async(_event,consent)=>{
   assert.deepEqual(consent,{preservePendingWorkApproved:true});
   assert.equal(state.recoveryAvailable,true,'Recovery must be available before explicit consent');
   bootstrapCalls.recover++;
   state={state:'needs_approval',environment:'development',setupAccess:{reason:'enrollment_required'},
     health:{serviceOnline:true,queueCount:null},workspace:{phase:'draft',step:'order',sources:[]}};
   return{ok:true,value:state};
 });
 ipcMain.handle('connect:beginEnrollment',async()=>{
   assert.equal(state.installationId,undefined,'An existing installation must not be silently replaced');
   bootstrapCalls.enroll++;
   state={...state,enrollment:{id:'enrollment_fixture',state:'pending',comparisonCode:'F1A2B3',expiresAt:'2099-01-01T00:00:00Z'}};
   return{ok:true,value:state};
 });
 for(const method of ['discoverWorkspaceFolders','chooseWorkspaceFolder','getFacilityDraft','workspaceDraftPreview','activateWorkspace'])
   ipcMain.handle('connect:'+method,async()=>{bootstrapCalls.source++;return{ok:false,error:'Source work requires facility authorization.'};});
 const win=new BrowserWindow({parent,modal:true,width:1440,height:900,show:true,backgroundColor:'#f7f9fc',webPreferences:{
   preload:setupPreload,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false
 }}),page=win.webContents,screenshots={};
 const click=label=>page.executeJavaScript(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})?.click()`);
 async function capture(name){
   for(const [w,h,scale,suffix]of[[1440,900,1,'1440x900'],[1024,640,1.25,'1280x800-125pct']]){
     await viewport(page,w,h,scale);await measure(page,w,h);
     screenshots[name+'-'+suffix+'.png']=await shoot(page,name+'-'+suffix,w,h,scale);
   }
   await viewport(page,1440,900,1);
 }
 try{
   await page.loadURL('about:blank');page.debugger.attach('1.3');await viewport(page,1440,900,1);
   await page.loadURL('packproof-connect://app/index.html?facilitySetup=1');
   await until(page,"document.querySelector('[data-setup-screen=installation-recovery] h1')?.textContent.includes('Choose this computer')");
   await until(page,"[...document.images].filter(e=>e.checkVisibility()).every(e=>e.complete&&e.naturalWidth>0)");
   assert.equal(await page.executeJavaScript("[...document.querySelectorAll('button')].some(e=>/Connect my records|Try a sample order/.test(e.textContent))"),false);
   await click('Review this computer in browser');await until(page,"[...document.querySelectorAll('button')].some(e=>e.textContent==='Check connection again'&&!e.disabled)");
   assert.equal(bootstrapCalls.review,1);await capture('logistics-facility-required');
   state={...state,state:'revoked',recoveryAvailable:true,setupAccess:{reason:'reapproval_required'}};
   await click('Check connection again');
   await until(page,"document.querySelector('[data-setup-screen=installation-recovery] h1')?.textContent==='Reconnect this computer.'");
   assert.equal(await page.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent==='Preserve work and reconnect')?.disabled"),true);
   assert.equal(bootstrapCalls.recover,0);await capture('logistics-approved-recovery');
   await page.executeJavaScript("document.querySelector('input[type=checkbox]')?.click()");await click('Preserve work and reconnect');
   await until(page,"document.querySelector('[data-setup-screen=installation-recovery] h1')?.textContent==='Connect this computer to a facility.'");
   assert.equal(bootstrapCalls.recover,1);assert.equal(bootstrapCalls.enroll,0);await capture('logistics-facility-enrollment');
   await click('Connect this computer to a facility');
   await until(page,"document.body.textContent.includes('F1A2B3')");
   assert.equal(bootstrapCalls.enroll,1);await capture('logistics-pending-approval');
   await click('Reopen facility sign-in');await until(page,"[...document.querySelectorAll('button')].some(e=>e.textContent==='Reopen facility sign-in'&&!e.disabled)");
   assert.equal(bootstrapCalls.review,2);assert.equal(bootstrapCalls.enroll,1);assert.equal(bootstrapCalls.source,0);
   return screenshots;
 }finally{if(page.debugger.isAttached())page.debugger.detach();if(!win.isDestroyed())win.destroy();}
}
async function main(){
 assert.ok(fs.existsSync(packagedAsar),'Packaged unified app.asar missing');
 assert.ok(fs.existsSync(preload),'Unified native preload missing');
 assert.ok(fs.existsSync(path.join(renderer,'index.html')),'Unified Commerce renderer missing');
 assert.ok(fs.existsSync(path.join(renderer,'brand','connect','packproof.png')),'Approved PackProof logo missing');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'packproof-unified-ux-'));
 app.setPath('userData',tmp);
 await app.whenReady();
 for(const [scheme,base]of[['packproof-app',renderer],['packproof-connect',setupRenderer]])protocol.handle(scheme,async request=>{
  const url=new URL(request.url);
  if(url.host!=='app')return new Response(null,{status:403});
  let candidate;
  try{candidate=path.resolve(base,'.'+decodeURIComponent(url.pathname));}
  catch{return new Response(null,{status:400});}
  if(!candidate.startsWith(base+path.sep))return new Response(null,{status:403});
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
  await page.loadURL('about:blank');
  page.debugger.attach('1.3');
  await viewport(page,1440,900,1);
  await page.loadURL(uri);
  await until(page,"document.querySelector('.logistics-entry h1')?.textContent?.includes('One clear story.')");
  await until(page,"[...document.querySelectorAll('.logistics-entry-primary')].some(e=>!e.disabled)");
  await measure(page,1440,900);
  const entryImage=await shoot(page,'logistics-entry-1440x900',1440,900,1);
  const active=await page.executeJavaScript("document.querySelector('.logistics-entry-brand img')?.complete && document.querySelector('.logistics-entry-brand img')?.naturalWidth>0");
  assert.equal(active,true,'Official logo failed to render');
  await page.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Open my orders'))?.click()");
  for(let i=0;i<30&&calls.orders<1;i++)await wait(50);
  assert.equal(calls.orders,1,'Logistics orders action was not sent through actual IPC bridge');
  await page.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Facility setup'))?.click()");
  for(let i=0;i<30&&calls.setup<1;i++)await wait(50);
  assert.equal(calls.setup,1,'Facility setup action was not sent through actual IPC bridge');

  await viewport(page,1024,640,1.25);
  await measure(page,1024,640);
  const scaledImage=await shoot(page,'logistics-entry-1280x800-125pct',1024,640,1.25);
  await viewport(page,1440,900,1);

  // A rejected facility response must not collapse into an unexplained Commerce fallback.
  failChoices=true;
  await page.reload();
  await until(page,"document.querySelector('.logistics-entry-error')?.textContent?.includes('Reconnect this computer')");
  const diagnostic=await page.executeJavaScript("document.querySelector('.logistics-entry-error')?.textContent");
  assert.ok(diagnostic.includes('Reconnect this computer'));
  assert.ok(!diagnostic.includes('Logistics is unavailable'));
  await measure(page,1440,900);
  const recoveryImage=await shoot(page,'logistics-access-recovery',1440,900,1);
  failChoices=false;
  await page.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Check access again'))?.click()");
  await until(page,"[...document.querySelectorAll('.logistics-entry-primary')].some(e=>!e.disabled)");
  await page.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Open Commerce workspace'))?.click()");
  await until(page,"!!document.querySelector('.app-layout .sidebar nav')");
  await page.executeJavaScript("[...document.querySelectorAll('.logistics-return')][0]?.click()");
  await until(page,"!!document.querySelector('.logistics-entry h1')");
  const bootstrapScreenshots=await checkBootstrap(win);
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({
   scope:'packaged unified renderer and production preload; synthetic IPC only',
   designFile:'PZ8dfCcXe2D8SMtmF497v3',entryNode:'2:9',setupNode:'69:8866',recoveryNode:'83:9262',
   screenshots:{'logistics-entry-1440x900.png':entryImage,'logistics-entry-1280x800-125pct.png':scaledImage,'logistics-access-recovery.png':recoveryImage,...bootstrapScreenshots},
   verified:['default Logistics route','official logo','Orders IPC','Setup IPC','error recovery','explicit Commerce switch','return to Logistics','exact viewport and PNG dimensions',
     'packaged Connect renderer and preload','missing-facility review','explicit preservation consent','recovery to new enrollment','exact pending approval return','no source action during bootstrap'],
   calls,bootstrapCalls
  },null,2));
  console.log('Unified Windows entry renderer layout and functional IPC routing verified (synthetic state).');
 }finally{if(page.debugger.isAttached()){try{page.debugger.detach();}catch{/* Renderer may already be gone. */}}if(!win.isDestroyed())win.destroy();}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
