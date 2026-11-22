// Checks the exact renderer/preload copied into the unified Windows package.
// Uses synthetic IPC state for visual and navigation coverage only; this is NOT
// evidence of live authorization, real source collection, or a signed installer.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createHash}=require('node:crypto');
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
const fixtureProofs=Array.from({length:4},(_,index)=>({proofId:'proof_fixture_'+index,status:'READY_FOR_EVIDENCE',role:'SELLER',
 createdAt:'2026-11-20T12:00:00Z',updatedAt:'2026-11-20T12:00:00Z',finalizedAt:null,evidenceCount:0,
 transaction:{itemTitle:'Example shipment '+(index+1),externalReference:'EXAMPLE-'+(10482+index),trackingNumber:null,carrier:null}}));
let failChoices=false;
const sample={
  'auth.state':{userId:'fixture-operator',email:'operator@example.invalid',profile:{displayName:'Fixture Operator',username:'operator'}},
  'system.state':system,'proofs.list':fixtureProofs,'orders.list':[],'integrations.list':{accounts:[],providers:[]},
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
async function shoot(page,name,w,h,scale=1,atScroll=false){
 await page.executeJavaScript('document.fonts.ready.then(()=>true)');
 const origin=atScroll?await page.executeJavaScript('({x:scrollX,y:scrollY})'):{x:0,y:0};
 const shot=await page.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:true,clip:{...origin,width:w,height:h,scale:1}});
 const png=Buffer.from(shot.data,'base64');
 assert.ok(png.length>24,'Empty screenshot');
 const actual={width:png.readUInt32BE(16),height:png.readUInt32BE(20)};
 fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,name+'.png'),png);
 assert.deepEqual(actual,{width:Math.round(w*scale),height:Math.round(h*scale)},'Mislabelled packaged screenshot '+name);
 return {...actual,cssWidth:w,cssHeight:h,scale,...(atScroll?{scrollY:origin.y}:{})};
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
async function verifyCommerceControls(page,route){
 await page.executeJavaScript('document.fonts.ready.then(()=>true)');
 const facts=await page.executeJavaScript(`(()=>{
  const box=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const brand=document.querySelector('.sidebar .packproof-brand img');
  const result={brand:brand?{source:brand.getAttribute('src'),loaded:brand.complete&&brand.naturalWidth>0,...box(brand)}:null,
   currentNavigation:[...document.querySelectorAll('.sidebar button[aria-current="page"]')].map(e=>({label:e.textContent.trim(),active:e.classList.contains('active')}))};
  const action=document.querySelector('.signal-home-primary>.eim-next-action');
  if(action)result.home={label:box(action.querySelector('span')),icon:box(action.querySelector('svg')),display:getComputedStyle(action).display,direction:getComputedStyle(action).flexDirection};
  const active=document.querySelector('.sidebar nav button[aria-current="page"]');
  if(active){const marker=getComputedStyle(active,'::before');result.activeMarker={position:getComputedStyle(active).position,top:parseFloat(marker.top),height:parseFloat(marker.height),containerHeight:active.clientHeight};}
  const dates=document.querySelector('.order-date-range');
  if(dates)result.dates={from:box(dates.querySelector('[aria-label="Orders from date"]')),through:box(dates.querySelector('[aria-label="Orders through date"]')),toolbar:box(dates.parentElement.previousElementSibling),search:box(dates.parentElement.querySelector('.search-field'))};
  const start=document.querySelector('.station-start-actions');
  if(start)result.start=[...start.querySelectorAll('button')].map(box);
  if(start)result.stationTools=[...document.querySelectorAll('.is-unselected .station-tool-fields select,.is-unselected aside form input,.is-unselected aside form button')].map(el=>({visible:el.checkVisibility(),viewportHeight:innerHeight,...box(el)}));
  const study=document.querySelector('.desktop-study-settings');
  const supportHeading=document.querySelector('.settings-grid .panel>button+h3');
  if(supportHeading)result.support={heading:box(supportHeading),previousAction:box(supportHeading.previousElementSibling)};
  if(study){
   const label=study.querySelector('label'),checkbox=label.querySelector('input[type=checkbox]');
   const text=[...label.childNodes].find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim());
   const range=document.createRange();range.selectNodeContents(text);const r=range.getBoundingClientRect();
   result.study={preferences:box(document.querySelector('.settings-grid')),panel:box(study),checkbox:box(checkbox),labelText:{x:r.x,y:r.y},checked:checkbox.checked,
    joinDisabled:[...study.querySelectorAll('button')].find(e=>e.textContent==='Join this timing study')?.disabled};
  }
  return result;
 })()`);
 assert.equal(facts.brand?.source,'/brand/connect/packproof.png','Commerce must use the current approved logo');
 assert.equal(facts.brand.loaded,true,'Commerce logo did not load');
 assert.ok(Math.abs(facts.brand.width-facts.brand.height)<1,'The official square logo must retain its aspect ratio');
 assert.deepEqual(facts.currentNavigation,[{label:({'home':'Home','packing-station':'Packing Station','orders':'Orders','settings':'Settings'})[route],active:true}],'The actual Commerce page must remain indicated in navigation');
 if(route==='home'){
  assert.equal(facts.home.display,'flex');assert.equal(facts.home.direction,'row');
  assert.equal(facts.activeMarker.position,'relative','Active navigation must contain its own marker');
  assert.ok(Math.abs(facts.activeMarker.top+facts.activeMarker.height/2-facts.activeMarker.containerHeight/2)<1,'Active navigation marker is detached from its button');
  const {label,icon}=facts.home;
  assert.ok(Math.abs(label.y+label.height/2-icon.y-icon.height/2)<4,'Home action text and icon are not aligned');
  assert.ok(icon.x>=label.right+8,'Home action icon overlaps its label');
 }
 if(route==='orders'){
  assert.ok(Math.abs(facts.dates.from.y-facts.dates.through.y)<2,'From and Through must remain a cohesive date pair');
  assert.ok(facts.dates.search.y-facts.dates.toolbar.bottom>=12,'Orders search must be separated from marketplace controls');
 }
 if(route==='packing-station'){
  assert.ok(facts.start.length===2&&facts.start[1].x>=facts.start[0].right+8,'Packing start actions need a visible gap');
  assert.equal(facts.stationTools.length,5,'Initial camera, resolution, audio and shipment lookup controls are required');
  assert.ok(facts.stationTools.every(el=>el.visible&&el.y>=0&&el.bottom<=el.viewportHeight+1),'Initial station tools extend below the requested viewport: '+JSON.stringify(facts.stationTools));
 }
 if(route==='settings'){
  assert.ok(facts.support.heading.y-facts.support.previousAction.bottom>=12,'Diagnostics must be separated from the preceding tutorial action');
  assert.ok(facts.study.panel.y>=facts.study.preferences.bottom+16,'Everyday preferences must precede the separated optional study');
  assert.ok(facts.study.labelText.x>=facts.study.checkbox.right+6,'Study checkbox and label must share an inline row');
  assert.ok(Math.abs(facts.study.labelText.y-facts.study.checkbox.y)<5,'Study consent label is separated from its checkbox');
  assert.equal(facts.study.checked,false);assert.equal(facts.study.joinDisabled,true);
 }
}
async function verifyProfileAccess(page){
 const profileFacts=()=>page.executeJavaScript(`(()=>{
  const button=document.querySelector('.sidebar .profile-button'),name=button.querySelector('strong'),r=button.getBoundingClientRect();
  const rgba=value=>(value.match(/[0-9.]+/g)||[]).map(Number);
  const ancestors=[];for(let el=name;el;el=el.parentElement)ancestors.unshift(el);
  let background=[255,255,255];
  for(const el of ancestors){const c=rgba(getComputedStyle(el).backgroundColor),a=c[3]??1;background=background.map((v,i)=>(c[i]??v)*a+v*(1-a));}
  const luminance=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const foreground=luminance(rgba(getComputedStyle(name).color)),back=luminance(background);
  return{focused:document.activeElement===button,top:r.top,bottom:r.bottom,height:innerHeight,contrast:(Math.max(foreground,back)+.05)/(Math.min(foreground,back)+.05)};
 })()`);
 await page.executeJavaScript('document.activeElement?.blur()');
 const normal=await profileFacts();
 assert.ok(normal.contrast>=4.5,'Default account name contrast is insufficient: '+normal.contrast);
 await page.executeJavaScript("document.querySelector('.sidebar .logistics-return')?.focus()");
 for(let i=0;i<24;i++){
  if(await page.executeJavaScript("document.activeElement===document.querySelector('.sidebar .profile-button')"))break;
  for(const type of ['keyDown','keyUp'])await page.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});
 }
 const facts=await profileFacts();
 assert.equal(facts.focused,true,'Account controls must be reachable with Tab');
 assert.ok(facts.top>=0&&facts.bottom<=facts.height+1,'Account controls are trapped below the sidebar viewport');
 assert.ok(facts.contrast>=4.5,'Account name contrast is insufficient: '+facts.contrast);
 await page.executeJavaScript("document.activeElement.blur();document.querySelector('.sidebar').scrollTop=0");
}
async function checkCommerce(page){
 const screenshots={};
 await page.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 for(const theme of ['light','dark']){
  system.settings.theme=theme;
  await page.reload();
  await until(page,"[...document.querySelectorAll('.logistics-entry-primary')].some(e=>!e.disabled)");
  await page.executeJavaScript("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Open Commerce workspace')?.click()");
  await until(page,"!!document.querySelector('.app-layout .sidebar nav') && document.documentElement.dataset.theme==="+JSON.stringify(theme));
  await until(page,"[...document.querySelectorAll('.sidebar .brand img')].every(e=>e.complete&&e.naturalWidth>0)");
  for(const [route,label] of [['home','Home'],['packing-station','Packing Station'],['orders','Orders'],['settings','Settings']]){
   await page.executeJavaScript(`(()=>{
     const details=document.querySelector('.sidebar details');if(details&&!details.open)details.querySelector('summary').click();
     const button=[...document.querySelectorAll('.sidebar button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});
     if(!button)throw Error('Missing Commerce navigation');button.click();
   })()`);
   await until(page,"document.querySelector('.breadcrumb')?.textContent.trim()==="+JSON.stringify('/ '+label));
   if(route==='home')await until(page,"document.body.innerText.includes('Example shipment 1') && ![...document.querySelectorAll('button')].find(e=>e.textContent==='Refresh records')?.disabled");
   if(route==='settings')await until(page,`(()=>{
    const panel=document.querySelector('[aria-label="Optional capture timing study"]');
    return !!panel && panel.textContent.includes('Collection starts only after I agree.') &&
      panel.querySelector('input[type=checkbox]')?.checked===false &&
      [...panel.querySelectorAll('button')].some(e=>e.textContent==='Join this timing study'&&e.disabled);
   })()`);
   if(route==='settings')assert.equal(await page.executeJavaScript("[...document.querySelectorAll('button')].some(e=>e.textContent==='Download update')"),false,'Unavailable updates must not offer a download');
   for(const [w,h,scale,suffix]of[[1440,900,1,'1440x900'],[1024,640,1.25,'1280x800-125pct']]){
    await viewport(page,w,h,scale);
    await page.executeJavaScript("window.scrollTo(0,0);document.querySelector('.workspace')?.scrollTo(0,0);document.querySelector('.sidebar').scrollTop=0");
    if(route==='home')await verifyProfileAccess(page);
    await verifyCommerceControls(page,route);
    const name=`commerce-${route}-${theme}-${suffix}`;
    screenshots[name+'.png']=await shoot(page,name,w,h,scale);
    await measure(page,w,h);
    if(route==='settings'){
     await page.executeJavaScript("document.querySelector('.settings-grid')?.scrollIntoView({block:'start'})");
     screenshots[name+'-preferences.png']=await shoot(page,name+'-preferences',w,h,scale,true);
     await page.executeJavaScript("document.querySelector('.desktop-study-settings').scrollIntoView({block:'start'})");
     await until(page,"document.querySelector('.desktop-study-settings button').getBoundingClientRect().bottom<=innerHeight+1");
     screenshots[name+'-study.png']=await shoot(page,name+'-study',w,h,scale,true);
    }
   }
   await viewport(page,1440,900,1);
  }
 }
 // Exercise genuine updater states through the real Settings renderer. No
 // check, download or install operation is invoked by this visual fixture.
 for(const [state,action]of[['available','Download update'],['ready','Install & restart'],['unavailable',null]]){
  system.update={state,...(action?{version:'0.7.1'}:{})};
  await page.executeJavaScript("document.querySelector('button[aria-label=\"Refresh workspace\"]').click()");
  await until(page,`(()=>{const buttons=[...document.querySelectorAll('button')];return ${action?`buttons.some(e=>e.textContent===${JSON.stringify(action)}&&!e.disabled)`:`!buttons.some(e=>['Download update','Install & restart'].includes(e.textContent))`};})()`);
 }
 return screenshots;
}
async function main(){
 assert.ok(fs.existsSync(packagedAsar),'Packaged unified app.asar missing');
 assert.ok(fs.existsSync(preload),'Unified native preload missing');
 assert.ok(fs.existsSync(path.join(renderer,'index.html')),'Unified Commerce renderer missing');
 assert.ok(fs.existsSync(path.join(renderer,'brand','connect','packproof.png')),'Approved PackProof logo missing');
  const logo=fs.readFileSync(path.join(renderer,'brand','connect','packproof.png'));
  const logoBlob=createHash('sha1').update('blob '+logo.length+'\0').update(logo).digest('hex');
  assert.equal(logoBlob,'5224892f4b09263e486751ae3848a92aba7ca560','The packaged official logo bytes changed');
  assert.deepEqual(logo,fs.readFileSync(path.join(setupRenderer,'brand','connect','packproof.png')),'Commerce and Logistics must use the same approved logo asset');
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
 ipcMain.handle('packproof:study.scope',async()=>({ok:true,value:'https://fixture.example.invalid'}));
 ipcMain.handle('packproof:study.request',async(_event,input)=>{
  assert.equal(input.userId,'fixture-operator');assert.equal(input.path,'/consent');assert.equal(input.method,'GET','Visual fixture must not submit study consent or timings');assert.equal(input.body,undefined);
  return{ok:true,value:{enabled:true,datasetRef:'visual-fixture',granted:false,statementVersion:'capture-timing-study-v1',
   statement:'I agree to contribute capture task timings and operational outcomes from this account to this study dataset. Collection starts only after I agree. No recording content, label text, barcodes, names, email, or access tokens are collected. References are pseudonymous. I can stop future collection by withdrawing; observations already contributed remain in this dataset.'}};
 });
 try{
  await page.loadURL('about:blank');
  page.debugger.attach('1.3');
   await page.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
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
  const commerceScreenshots=await checkCommerce(page);
  await page.executeJavaScript("[...document.querySelectorAll('.logistics-return')][0]?.click()");
  await until(page,"!!document.querySelector('.logistics-entry h1')");
  const bootstrapScreenshots=await checkBootstrap(win);
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({
   scope:'packaged unified renderer and production preload; synthetic IPC only',sourceCommit:process.env.GITHUB_SHA||null,
   designFile:'PZ8dfCcXe2D8SMtmF497v3',entryNode:'2:9',setupNode:'69:8866',recoveryNode:'83:9262',
   screenshots:{'logistics-entry-1440x900.png':entryImage,'logistics-entry-1280x800-125pct.png':scaledImage,'logistics-access-recovery.png':recoveryImage,...bootstrapScreenshots,...commerceScreenshots},
    commerceCoverage:{scope:'Explicitly selected Commerce with scoped defect repairs; no approved Logistics design parity claim',themes:['light','dark'],routes:['Home','Packing Station','Orders','Settings'],studyConsent:'full statement; synthetic ungranted GET only',logoBlob,updaterStates:['unavailable','available','ready']},
   verified:['default Logistics route','official logo','Orders IPC','Setup IPC','error recovery','explicit Commerce switch','return to Logistics','exact viewport and PNG dimensions',
     'packaged Connect renderer and preload','missing-facility review','explicit preservation consent','recovery to new enrollment','exact pending approval return','no source action during bootstrap',
     'explicit Commerce Home, Packing Station, Orders and Settings at both scales and themes'],
   calls,bootstrapCalls
  },null,2));
  console.log('Unified Windows entry renderer layout and functional IPC routing verified (synthetic state).');
 }finally{if(page.debugger.isAttached()){try{page.debugger.detach();}catch{/* Renderer may already be gone. */}}if(!win.isDestroyed())win.destroy();}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
