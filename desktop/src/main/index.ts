import {app,BrowserWindow,protocol,net,session,ipcMain,dialog,shell,Tray,Menu,nativeImage,Notification,powerSaveBlocker,powerMonitor} from 'electron';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,extname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWriteStream,readFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomUUID,createHash} from 'node:crypto';
import type {ZodType} from 'zod';
import {SecureStore,secureStorageAvailable} from './secure-store';
import {validateConfig,type DesktopConfig} from './config';
import {AuthService} from './auth';
import {DesktopApi} from './api';
import {EvidenceEngine} from './evidence/engine';
import {DesktopEvidenceTransport} from './evidence-api';
import {APP_ORIGIN,isTrustedRenderer,isAllowedExternal,parseDeepLink,schemas,settingsSchema} from './security';
import {Diagnostics} from './diagnostics';
import {Updates} from './updates';
import {ErrorReporting} from './error-reporting';
import {WorkspaceNotifications} from './workspace-notifications';
import {ShareReviews} from './share-review';
import {ShutdownCoordinator} from './shutdown';
import type {DesktopEvent,DesktopSettings,SessionView,SystemView} from '../shared/contracts';

protocol.registerSchemesAsPrivileged([{scheme:'packproof-app',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}},{scheme:'packproof-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
app.enableSandbox();
let win:BrowserWindow|null=null,tray:Tray|null=null,engine:EvidenceEngine|null=null,auth:AuthService|null=null,api:DesktopApi|null=null;
let config:DesktopConfig|null=null,environment='development',closePrompt=false,blocker:number|null=null,online=true;
let sessionEpoch=0;
let installationId='',vault:SecureStore,logs:Diagnostics,updates:Updates,reporting:ErrorReporting;
let settings:DesktopSettings={cameraId:'',microphoneId:'',audio:false,resolution:'1080p',frameRate:30,retentionHours:24,notifications:true,scannerSuffix:'Enter',theme:'system'};
const pendingLinks:string[]=[];
app.on('open-url',(event,url)=>{event.preventDefault();pendingLinks.push(url);flushLinks();});
app.on('second-instance',(_event,args)=>{win?.show();win?.focus();pendingLinks.push(...args);flushLinks();});
let rendererReady=false;
function flushLinks(){if(!rendererReady)return;const scheme=environment==='production'?'packproof':environment==='staging'?'packproof-staging':environment==='research'?'packproof-rnd':'packproof-dev';while(pendingLinks.length){const path=parseDeepLink(pendingLinks.shift()!,scheme);if(path){win?.show();emit({type:'navigate',path});}}}
const mediaGrants=new Map<string,{accountId:string;proofId:string;evidenceId:string;stageId?:string;surface?:boolean;expires:number}>();
const shareReviews=new ShareReviews();
const mediaControllers=new Set<AbortController>();
const notifiedFailures=new Set<string>();
const workspaceNotifications=new WorkspaceNotifications({listAttention:signal=>requireApi().listProofs({view:'attention',signal,maxPages:10}),listConnections:signal=>requireApi().listCommerceConnections(signal),notify:notice=>notify(notice.title,notice.message)});
const shutdown=new ShutdownCoordinator({stop:()=>{workspaceNotifications.stop();revokeMedia();},drain:async()=>{await engine?.shutdown();},closeReporting:async()=>{await reporting?.close();},quit:()=>app.quit(),record:code=>logs?.record('SYSTEM',code)});
async function cached<T>(key:string,fetcher:()=>Promise<T>):Promise<T>{
 const account=auth?.getAccountId();if(!account)throw new Error('Sign in to PackProof.');
 const name='cache-'+createHash('sha256').update(account+'|'+key).digest('hex').slice(0,32);
 try{const value=await fetcher();if(auth?.getAccountId()!==account)throw new Error('Your account changed.');const reconnected=!online;online=true;if(reconnected)notify('PackProof connection restored','Queued evidence will resume uploading when your account is ready.');await vault.write(name,JSON.stringify({account,value}));if(auth?.getAccountId()!==account)throw new Error('Your account changed.');return value;}catch(error){
  const status=(error as {status?:number}).status;if(status && status<500)throw error;
  if(auth?.getAccountId()!==account)throw error;const previous=await vault.read(name);if(!previous)throw error;const row=JSON.parse(previous);if(row.account!==account||auth?.getAccountId()!==account)throw error;online=false;emit({type:'system'});return row.value as T;
 }
}
const emit=(event:DesktopEvent)=>{if(win&&!win.isDestroyed())win.webContents.send('packproof:event',event);};
const sessionView=():SessionView|null=>{const s=auth?.getSession();return s?{userId:s.userId,email:s.email,profile:s.profile}:null;};
function requireApi(){if(!api)throw new Error('This desktop build needs PackProof service configuration.');if(!auth?.getAccountId())throw new Error('Sign in to PackProof.');return api;}
function requireEngine(){requireApi();if(!engine)throw new Error('Unlock your system credential storage before recording.');return engine;}
function notify(title:string,message:string){emit({type:'notification',title,message});if(settings.notifications&&Notification.isSupported())new Notification({title,body:message}).show();}
function revokeMedia(){shareReviews.clear();mediaGrants.clear();for(const c of mediaControllers)c.abort();mediaControllers.clear();}
function quitSafely(){return shutdown.quit();}
async function external(url:string){if(!isAllowedExternal(url,config?.webBaseUrl??'https://thepackproof.com'))throw new Error('Only PackProof website links can open from the desktop app.');await shell.openExternal(url);}
function errorMessage(error:unknown){const message=error instanceof Error?error.message:'The request could not be completed.';return /token|signature=|credential=|Bearer |BEGIN.*KEY|[A-Z]:\\|\/workspace\//i.test(message)?'PackProof could not complete this operation. Try again or copy diagnostics.':message.slice(0,500);}
function handle(name:string,schema:ZodType,fn:(...args:any[])=>unknown){ipcMain.handle(`packproof:${name}`,async(event,...args)=>{
 try{if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!isTrustedRenderer(event.senderFrame.url))throw new Error('Untrusted application request.');const parsed=schema.parse(args) as unknown[];if(name==='system.state'){logs.record('SYSTEM','RENDERER_READY');rendererReady=true;setImmediate(flushLinks);}const epoch=sessionEpoch;const protectedRequest=!/^(auth|system|updates)\./.test(name);const value=await fn(...parsed);if(protectedRequest&&epoch!==sessionEpoch)throw new Error('Your account changed. Repeat this request.');return {ok:true,value};}catch(error){logs?.record('SYSTEM','IPC_FAILURE');if(name.startsWith('capture.'))logs?.record('CAPTURE','STAGING_FAILED');return {ok:false,error:errorMessage(error)};}
});}
async function state():Promise<SystemView>{return {version:app.getVersion(),platform:process.platform,environment,online,configured:!!config,secureStorage:secureStorageAvailable(),pendingOtherAccounts:await engine?.hasOtherAccountEvidence()??false,settings,research:{surfaceReview:!!config?.surfaceFingerprintReview,localSignIn:config?.channel==='research'},reporting:reporting?.state,update:updates.state};}
function setupIpc(){
 const surfaceApi=()=>{if(!config?.surfaceFingerprintReview||!['research','development'].includes(config.channel))throw new Error('Surface research is disabled in this build.');return requireApi();};
 handle('surfaces.read',schemas.id,id=>surfaceApi().getSurfaceResearch(id));
 handle('surfaces.compare',schemas.surfaceCompare,(id,input)=>surfaceApi().compareSurfaceResearch(id,input));
 handle('surfaces.saveSource',schemas.surfaceSource,async(proofId,sourceId)=>{
  const client=surfaceApi(),account=auth!.getAccountId(),records=await client.getSurfaceResearch(proofId);
  const original=[...records.enrollments,...records.observations].flatMap(record=>record.sourceDigests).find(source=>source.sourceId===sourceId);
  if(!original)throw new Error('Source is not committed to this Proof.');
  const extension=original.contentType==='image/png'?'png':'jpg';
  const selected=await dialog.showSaveDialog(win!,{title:'Save original research image',defaultPath:`surface-${sourceId}.${extension}`,filters:[{name:'Original image',extensions:[extension]}]});
  if(selected.canceled||!selected.filePath)return {saved:false};
  const controller=new AbortController();mediaControllers.add(controller);
  try{if(auth?.getAccountId()!==account)throw new Error('Your account changed. Retry the export.');const response=await client.getSurfaceOriginal(proofId,sourceId,controller.signal);if(auth?.getAccountId()!==account){await response.body?.cancel();throw new Error('Your account changed. Retry the export.');}if(!response.body)throw new Error('No original bytes received.');await pipeline(Readable.fromWeb(response.body as any),createWriteStream(selected.filePath,{mode:0o600}),{signal:controller.signal});return {saved:true};}finally{mediaControllers.delete(controller);}
 });
 handle('surfaces.sourceUrl',schemas.surfaceSource,async(proofId,sourceId)=>{
  const client=surfaceApi(),scope={accountId:auth!.getAccountId()!,epoch:sessionEpoch};
  const records=await client.getSurfaceResearch(proofId);
  if(![...records.enrollments,...records.observations].some(record=>record.sourceDigests.some(source=>source.sourceId===sourceId)))throw new Error('Source is not committed to this Proof.');
  if(scope.epoch!==sessionEpoch||scope.accountId!==auth?.getAccountId())throw new Error('Your account changed. Review this Proof again.');
  for(const [key,value]of mediaGrants)if(value.expires<Date.now())mediaGrants.delete(key);
  const key=randomUUID();mediaGrants.set(key,{accountId:scope.accountId,proofId,evidenceId:sourceId,surface:true,expires:Date.now()+3600_000});return `packproof-media://evidence/${key}`;
 });
 handle('surfaces.export',schemas.id,async id=>{
  const client=surfaceApi(),account=auth!.getAccountId();
  const selected=await dialog.showSaveDialog(win!,{title:'Export experimental surface record',defaultPath:`PackProof-RnD-${id}.json`,filters:[{name:'Research evidence JSON',extensions:['json']}]});
  if(selected.canceled||!selected.filePath)return {saved:false};
  const controller=new AbortController();mediaControllers.add(controller);
  try{if(auth?.getAccountId()!==account)throw new Error('Your account changed. Retry the export.');const response=await client.exportSurfaceResearch(id,controller.signal);if(auth?.getAccountId()!==account){await response.body?.cancel();throw new Error('Your account changed. Retry the export.');}if(!response.body)throw new Error('No export content received.');await pipeline(Readable.fromWeb(response.body as any),createWriteStream(selected.filePath,{mode:0o600}),{signal:controller.signal});return {saved:true};}finally{mediaControllers.delete(controller);}
 });
 handle('onboarding.get',schemas.empty,()=>requireApi().getOnboarding());
 handle('onboarding.update',schemas.onboarding,input=>requireApi().updateOnboarding(input));
 handle('auth.state',schemas.empty,sessionView);
 handle('auth.researchSignIn',schemas.researchIdentity,async subject=>{if(!auth||config?.channel!=='research')throw new Error('Local research sign-in is unavailable.');if(engine?.activeCapture)throw new Error('Finish recording before changing accounts.');await engine?.setAccount(null);revokeMedia();await auth.researchSignIn(subject);await engine?.setAccount(auth.getAccountId());emit({type:'session'});return sessionView();});
 handle('auth.signIn',schemas.login,async input=>{if(!auth)throw new Error('This desktop build needs PackProof service configuration.');if(engine?.activeCapture)throw new Error('Finish recording before changing accounts.');await engine?.setAccount(null);revokeMedia();await auth.signIn(input);await engine?.setAccount(auth.getAccountId());emit({type:'session'});return sessionView();});
 handle('auth.signOut',schemas.empty,async()=>{if(engine?.activeCapture)throw new Error('Finish recording before signing out.');await engine?.setAccount(null);revokeMedia();await auth?.signOut();emit({type:'session'});});
 const account=()=>{if(!auth)throw new Error('This desktop build needs PackProof service configuration.');return auth;};
 handle('auth.signUp',schemas.login,i=>account().signUp(i));handle('auth.confirmSignUp',schemas.code,i=>account().confirmSignUp(i));handle('auth.resendCode',schemas.email,e=>account().resendConfirmation(e));handle('auth.forgotPassword',schemas.email,e=>account().forgotPassword(e));handle('auth.resetPassword',schemas.reset,i=>account().confirmForgotPassword(i));
 handle('proofs.list',schemas.empty,()=>cached('proof-list',()=>requireApi().listProofs()));handle('proofs.detail',schemas.id,id=>cached('proof-'+id,()=>requireApi().getProof(id)));handle('proofs.create',schemas.transaction,i=>requireApi().createProof(i));handle('proofs.finalize',schemas.id,async id=>(await requireApi().finalizeProof(id)).proof);
 handle('proofs.sharePreview',schemas.id,async id=>{
  const client=requireApi(),scope={accountId:auth!.getAccountId()!,epoch:sessionEpoch};
  const preview=await client.previewSharedProof(id);
  if(scope.epoch!==sessionEpoch||scope.accountId!==auth?.getAccountId())throw new Error('Your account changed. Review this Proof again.');
  return shareReviews.issue(scope,id,preview);
 });
 handle('proofs.share',schemas.share,async(id,input)=>{
  const client=requireApi(),scope={accountId:auth!.getAccountId()!,epoch:sessionEpoch};
  shareReviews.consume(scope,id,input.previewHash);
  const link=await client.createSharedProofLink(id,input);
  if(scope.epoch!==sessionEpoch||scope.accountId!==auth?.getAccountId())throw new Error('Your account changed. Repeat this request.');
  if(!link.url||!isAllowedExternal(link.url,config!.webBaseUrl))throw new Error('PackProof did not return a valid share link.');
  return {url:link.url,expiresAt:link.expiresAt};
 });
 handle('proofs.export',schemas.id,async id=>{const client=requireApi(),account=auth!.getAccountId();const selected=await dialog.showSaveDialog(win!,{title:'Export Proof package',defaultPath:`PackProof-${id}.zip`,filters:[{name:'ZIP archive',extensions:['zip']}]});if(selected.canceled||!selected.filePath)return {saved:false};const controller=new AbortController();mediaControllers.add(controller);try{if(auth?.getAccountId()!==account)throw new Error('Your account changed. Retry the export.');const response=await client.exportProofPackage(id,controller.signal);if(auth?.getAccountId()!==account){await response.body?.cancel();throw new Error('Your account changed. Retry the export.');}if(!response.body)throw new Error('No export content received.');await pipeline(Readable.fromWeb(response.body as any),createWriteStream(selected.filePath,{mode:0o600}),{signal:controller.signal});return {saved:true};}finally{mediaControllers.delete(controller);}});
 handle('proofs.evidenceUrl',schemas.evidence,async(proofId,evidenceId,previewHash)=>{
  const client=requireApi(),scope={accountId:auth!.getAccountId()!,epoch:sessionEpoch};let stageId:string|undefined;
  if(previewHash)stageId=shareReviews.media(scope,proofId,previewHash,evidenceId).stageId;
  else{const proof=await client.getProof(proofId);if(!proof.evidence.some(e=>e.evidenceId===evidenceId&&e.committedAt))throw new Error('Evidence is not available.');}
  if(scope.epoch!==sessionEpoch||scope.accountId!==auth?.getAccountId())throw new Error('Your account changed. Review this Proof again.');
  for(const [key,value]of mediaGrants)if(value.expires<Date.now())mediaGrants.delete(key);
  const id=randomUUID();mediaGrants.set(id,{accountId:scope.accountId,proofId,evidenceId,stageId,expires:Date.now()+3600_000});return `packproof-media://evidence/${id}`;
 });
 handle('orders.list',schemas.empty,()=>cached('order-list',()=>requireApi().listOrders()));handle('orders.resolve',schemas.resolve,async reference=>{const result=await requireApi().resolvePackingStation(reference);if(!result.proofId)throw new Error(result.blockReason??'No matching Proof found.');return {proofId:result.proofId};});handle('orders.sync',schemas.id,async id=>{
  const client=requireApi(),owner=auth!.getAccountId()!,epoch=sessionEpoch;
  const current=()=>epoch===sessionEpoch&&owner===auth?.getAccountId();
  let connections;
  try{connections=(await client.listCommerceConnections()).connections;if(current())workspaceNotifications.syncSucceeded(owner,'catalog');}
  catch(error){if(current())workspaceNotifications.syncFailed(owner,'catalog');throw error;}
  if(!current())throw new Error('Your account changed. Repeat this request.');
  const selected=id==='all'?connections:connections.filter(connection=>connection.connectionId===id);
  if(!selected.length)throw new Error('No matching marketplace connection is available. Open Integrations to connect or refresh your account.');
  for(const connection of selected){
   if(!current())throw new Error('Your account changed. Repeat this request.');
   try{await client.syncCommerceConnection(connection.connectionId);if(current())workspaceNotifications.syncSucceeded(owner,connection.connectionId);}
   catch(error){if(current())workspaceNotifications.syncFailed(owner,connection.connectionId);throw error;}
  }
  if(current())notify('Marketplace synchronization complete','Your fulfillment queue is ready to refresh.');
 });
 handle('integrations.list',schemas.empty,()=>requireApi().listConnectedAccounts());handle('integrations.connect',schemas.resolve,async()=>{await external(`${config?.webBaseUrl??'https://thepackproof.com'}/app/integrations`);});
 handle('capture.begin',schemas.capture,async i=>{const captureAccount=auth?.getAccountId();const captureEpoch=sessionEpoch;const proof=await cached('proof-'+i.proofId,()=>requireApi().getProof(i.proofId));if(captureEpoch!==sessionEpoch||captureAccount!==auth?.getAccountId())throw new Error('Your account changed. Select the shipment again.');if(proof.status==='FINALIZED')throw new Error('This Proof is finalized. Its evidence cannot be changed.');const job=await requireEngine().beginCapture({...i,offline:!online,appVersion:app.getVersion(),installationId});if(blocker===null)blocker=powerSaveBlocker.start('prevent-app-suspension');return {id:job.id,maxRecordingBytes:job.maxRecordingBytes,maxRecordingSeconds:job.maxRecordingSeconds};});
 const releaseBlocker=()=>{if(blocker!==null){powerSaveBlocker.stop(blocker);blocker=null;}};
 handle('capture.append',schemas.chunk,async(id,seq,b)=>{await requireEngine().appendChunk(id,seq,new Uint8Array(b));});
 handle('capture.finish',schemas.finish,async(id,i)=>{await requireEngine().finishCapture(id,{attestation:i.attestation,recordedDurationMs:i.durationMs,startedAt:i.startedAt,endedAt:i.endedAt,detections:i.detections.map((d:any)=>({value:d.rawValue,format:d.format,detectedAtMs:d.detectedAtMs,confirmed:d.confirmed,notThisPackage:d.notThisPackage}))});releaseBlocker();});
 handle('capture.interrupt',schemas.interrupt,async(id,reason)=>{await requireEngine().interruptCapture(id,reason);releaseBlocker();});
 handle('uploads.list',schemas.empty,()=>requireEngine().list());handle('uploads.retry',schemas.id,async id=>{await requireEngine().retry(id);});handle('uploads.discard',schemas.id,async id=>{const answer=await dialog.showMessageBox(win!,{type:'warning',title:'Discard local recording?',message:'Discard this local recording?',detail:'This removes the local recording from this computer. Pending evidence cannot be recovered after discarding.',buttons:['Keep recording','Discard recording'],defaultId:0,cancelId:0});if(answer.response===1)await requireEngine().discard(id);});
 handle('uploads.pause',schemas.empty,()=>requireEngine().pause());handle('uploads.resume',schemas.empty,()=>requireEngine().resume());
 handle('system.report',schemas.report,code=>{logs.record('CAPTURE',code);});handle('system.state',schemas.empty,state);handle('system.settings',schemas.empty,()=>settings);handle('system.saveSettings',schemas.settings,async update=>{settings=settingsSchema.parse({...settings,...update});await vault.write('settings',JSON.stringify(settings));engine?.setRetentionHours(settings.retentionHours);return settings;});handle('system.openExternal',schemas.url,external);
 handle('system.exportDiagnostics',schemas.empty,async()=>{const value={application:'PackProof Desktop',version:app.getVersion(),platform:process.platform,architecture:process.arch,environment,serviceConfigured:!!config,secureStorage:secureStorageAvailable(),online,queue:await engine?.storageStats()??{available:false},update:updates.state.state,reporting:reporting?.state};const report=JSON.stringify({...value,recentEvents:await logs.recentEntries()},null,2);const selected=await dialog.showSaveDialog(win!,{title:'Export PackProof diagnostics',defaultPath:'PackProof-diagnostics.json',filters:[{name:'JSON report',extensions:['json']}]});if(selected.canceled||!selected.filePath)return '';await writeFile(selected.filePath,report,{mode:0o600});return report;});
 handle('updates.check',schemas.empty,()=>updates.check());handle('updates.download',schemas.empty,()=>updates.download());handle('updates.install',schemas.empty,()=>updates.install());
}
async function createWindow(){
 win=new BrowserWindow({width:1440,height:960,minWidth:1000,minHeight:700,title:environment==='production'?'PackProof':`PackProof ${environment}`,show:false,backgroundColor:'#E9EEF4',webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,devTools:!app.isPackaged,spellcheck:false}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.on('will-attach-webview',e=>e.preventDefault());
 win.webContents.on('render-process-gone',()=>{logs.record('SYSTEM','RENDERER_CRASH');void engine?.interruptActiveCapture('Application display stopped. The partial recording was retained.');});
 win.on('close',event=>{logs.record('SYSTEM','WINDOW_CLOSE_REQUESTED');if(shutdown.closeAllowed){logs.record('SYSTEM','WINDOW_CLOSE_ALLOWED');return;}event.preventDefault();if(closePrompt||shutdown.inProgress){logs.record('SYSTEM','WINDOW_CLOSE_WAITING_FOR_DRAIN');return;}closePrompt=true;void(async()=>{try{if(engine?.activeCapture){logs.record('SYSTEM','WINDOW_CLOSE_CAPTURE_BLOCKED');await dialog.showMessageBox(win!,{type:'warning',message:'A recording is in progress.',detail:'Finish or stop the recording before closing PackProof.',buttons:['Return to recording']});return;}if(engine?.hasPending){logs.record('SYSTEM','WINDOW_CLOSE_QUEUE_PROMPT');const result=await dialog.showMessageBox(win!,{type:'question',message:'Evidence is still queued on this computer.',detail:'Keep PackProof running to upload, or quit and resume when you next open it.',buttons:['Continue in background','Quit and resume next time','Cancel'],defaultId:0,cancelId:2});if(result.response===0)win?.hide();if(result.response===1)await quitSafely();else logs.record('SYSTEM','WINDOW_CLOSE_CANCELED');}else await quitSafely();}finally{closePrompt=false;}})();});
 win.webContents.on('will-prevent-unload',()=>shutdown.canceled());
 win.once('ready-to-show',()=>win?.show());await win.loadURL(`${APP_ORIGIN}/index.html`);
}
async function ready(){
 const raw=JSON.parse(await readFile(join(__dirname,'runtime-config.json'),'utf8'));environment=raw.channel;
 const suffix=environment==='production'?'':environment==='staging'?' Staging':environment==='research'?' RND':' Dev';app.setName(`PackProof${suffix}`);app.setAppUserModelId(`com.thepackproof.desktop${environment==='production'?'':'.'+environment}`);
 const base=process.platform==='win32'?(process.env.LOCALAPPDATA??app.getPath('appData')):app.getPath('appData');app.setPath('userData',join(base,`PackProof${suffix}`));
 await mkdir(app.getPath('userData'),{recursive:true,mode:0o700});vault=new SecureStore(join(app.getPath('userData'),'Credentials'));logs=new Diagnostics(join(app.getPath('userData'),'Logs'),app.getVersion(),(category,code)=>reporting?.record(category,code));
 try{config=validateConfig(raw);}catch{logs.record('SYSTEM','SERVICE_CONFIG_MISSING');}
 reporting=new ErrorReporting({dsn:config?.sentryDsn,version:app.getVersion(),channel:config?.channel??'development'});
 logs.record('SYSTEM',secureStorageAvailable()?'SECURE_STORAGE_READY':'SECURE_STORAGE_UNAVAILABLE');
 if(secureStorageAvailable()){
  try{const saved=await vault.read('settings');if(saved)settings=settingsSchema.parse(JSON.parse(saved));const install=await vault.installation();installationId=install.id;
   if(config){auth=new AuthService({config,store:{read:()=>vault.read('session'),write:v=>vault.write('session',v),clear:()=>vault.clear('session')},onSession:s=>{sessionEpoch++;shareReviews.clear();workspaceNotifications.setAccount(s?.userId??null);if(!s){revokeMedia();void engine?.setAccount(null);}emit({type:'session'});}});api=new DesktopApi({config,getToken:force=>auth!.getAccessToken(force),getAccountId:()=>auth!.getAccountId()});
    engine=new EvidenceEngine({rootDir:join(app.getPath('userData'),'EvidenceQueue'),encryptionKey:install.key,api:new DesktopEvidenceTransport(api),onChange:jobs=>{emit({type:'queue'});for(const job of jobs)if(['FAILED','WAITING_FOR_AUTH'].includes(job.state)){logs.record('UPLOAD',job.state==='FAILED'?'UPLOAD_FAILED':'UPLOAD_AUTH_REQUIRED');const key=job.id+':'+job.state;if(!notifiedFailures.has(key)){notifiedFailures.add(key);notify('PackProof upload needs attention','Your original recording is retained on this computer. Open Uploads to review it.');}}},onComplete:()=>notify('PackProof','Evidence has been secured by PackProof.')});await engine.initialize();engine.setRetentionHours(settings.retentionHours);await auth.restore();await engine.setAccount(auth.getAccountId());}
  }catch{logs.record('SYSTEM','SECURE_STORAGE_OR_QUEUE_UNAVAILABLE');}
 }
 updates=new Updates(config,()=>{emit({type:'update'});if(updates?.state.state==='ready')notify('PackProof update ready','Open Settings to install the verified update after recording is finished.');},()=>!!engine?.activeCapture,()=>shutdown.prepare(),()=>logs.record('UPDATES','UPDATE_CHECK_FAILED'));
 const rendererRoot=resolve(__dirname,'../renderer');
 protocol.handle('packproof-app',async request=>{try{const u=new URL(request.url);if(!isTrustedRenderer(request.url))return new Response(null,{status:403});const path=resolve(rendererRoot,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));if(!path.startsWith(rendererRoot+sep)||!['.html','.js','.css','.wasm','.svg','.png','.webp','.woff2','.ico'].includes(extname(path)))return new Response(null,{status:404});const response=await net.fetch(pathToFileURL(path).toString());const headers=new Headers(response.headers);headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: packproof-media:; media-src 'self' blob: packproof-media:; connect-src 'self' packproof-media:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'");return new Response(response.body,{status:response.status,headers});}catch{return new Response(null,{status:404});}});
 protocol.handle('packproof-media',async request=>{const u=new URL(request.url),grant=mediaGrants.get(u.pathname.slice(1));if(u.hostname!=='evidence'||!grant||grant.expires<Date.now()||grant.accountId!==auth?.getAccountId()||!api)return new Response(null,{status:403});const controller=new AbortController();mediaControllers.add(controller);try{const response=grant.surface?await api.getSurfaceOriginal(grant.proofId,grant.evidenceId,controller.signal):await api.getEvidence(grant.proofId,grant.evidenceId,controller.signal,request.headers.get('range')??undefined,grant.stageId);if(!response.body){mediaControllers.delete(controller);return new Response(null,{status:404});}const reader=response.body.getReader();const stream=new ReadableStream({async pull(target){try{if(auth?.getAccountId()!==grant.accountId)throw new Error('Account changed');const part=await reader.read();if(controller.signal.aborted||auth?.getAccountId()!==grant.accountId||mediaGrants.get(u.pathname.slice(1))!==grant)throw new Error('Account changed');if(part.done){mediaControllers.delete(controller);target.close();}else target.enqueue(part.value);}catch(error){mediaControllers.delete(controller);controller.abort();target.error(error);}},async cancel(){mediaControllers.delete(controller);controller.abort();await reader.cancel().catch(()=>{});}});return new Response(stream,{status:response.status,headers:{'Content-Type':response.headers.get('content-type')??'application/octet-stream','Cache-Control':'no-store',...(response.headers.get('content-range')?{'Content-Range':response.headers.get('content-range')!}:{}),...(response.headers.get('content-length')?{'Content-Length':response.headers.get('content-length')!}:{}),...(response.headers.get('accept-ranges')?{'Accept-Ranges':response.headers.get('accept-ranges')!}:{})}});}catch{mediaControllers.delete(controller);return new Response(null,{status:502});}});
 session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(!!win&&contents===win.webContents&&permission==='media'&&isTrustedRenderer(details.requestingUrl)));
 session.defaultSession.setPermissionCheckHandler((contents,permission,origin)=>!!win&&contents===win.webContents&&permission==='media'&&isTrustedRenderer(origin));
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
 setupIpc();await createWindow();
 let icon=nativeImage.createFromPath((app.isPackaged?join(process.resourcesPath,'icon.png'):join(__dirname,'../../build/icon.png')));if(icon.isEmpty())icon=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
 tray=new Tray(icon.resize({width:18,height:18}));tray.setToolTip('PackProof');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open PackProof',click:()=>{win?.show();win?.focus();}},{label:'Quit and resume next time',click:()=>{if(engine?.activeCapture)win?.show();else void quitSafely();}}]));tray.on('click',()=>win?.show());
 const scheme=environment==='production'?'packproof':environment==='staging'?'packproof-staging':environment==='research'?'packproof-rnd':'packproof-dev';app.setAsDefaultProtocolClient(scheme);
 pendingLinks.push(...process.argv);flushLinks();
 powerMonitor.on('suspend',()=>{void engine?.interruptActiveCapture('Computer went to sleep. The partial recording was retained.');});
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'PackProof',submenu:[{role:'about'},{type:'separator'},{label:'Quit',accelerator:'CmdOrCtrl+Q',click:()=>win?.close()}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));
 logs.record('SYSTEM','STARTED');if(config?.channel!=='development'&&config?.updateUrl)setTimeout(()=>void updates.check().catch(()=>{}),10_000);
}
try{const boot=JSON.parse(readFileSync(join(__dirname,'runtime-config.json'),'utf8'));environment=boot.channel;const suffix=environment==='production'?'':environment==='staging'?' Staging':environment==='research'?' RND':' Dev';app.setName(`PackProof${suffix}`);const base=process.platform==='win32'?(process.env.LOCALAPPDATA??app.getPath('appData')):app.getPath('appData');app.setPath('userData',join(base,`PackProof${suffix}`));}catch{}
if(!app.requestSingleInstanceLock())app.quit();else{app.whenReady().then(ready).catch(()=>{dialog.showErrorBox('PackProof could not start','Your local evidence has been retained. Reopen PackProof or contact support.');app.quit();});app.on('activate',()=>win?.show());app.on('will-quit',()=>{logs?.record('SYSTEM','APP_WILL_QUIT');workspaceNotifications.stop();});app.on('before-quit',event=>{logs?.record('SYSTEM','APP_BEFORE_QUIT');if(!shutdown.closeAllowed){event.preventDefault();win?.close();}});app.on('window-all-closed',()=>{});}
process.on('uncaughtException',()=>{logs?.record('SYSTEM','UNCAUGHT_EXCEPTION');void engine?.interruptActiveCapture('Application error. Partial evidence retained.');});
process.on('unhandledRejection',()=>logs?.record('SYSTEM','UNHANDLED_REJECTION'));
