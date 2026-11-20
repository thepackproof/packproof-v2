import {app,BrowserWindow,clipboard,protocol,net,ipcMain,dialog,shell,session} from 'electron';
import {readFile,writeFile,stat,lstat} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ServiceBridge} from './pipe';
import {startUpdates} from './updates';
import {preparedExportPath,canOfferPreparedFolder} from './source-choice';
import {discoverWorkspaceFolders} from './workspace-discovery';
import {distinctLocations,WorkspaceFolderOffers,type FolderOption} from './workspace-folder-offers';
import {workspaceParams,currentApprovalPath,currentSubscriptionApprovalPath,currentBackfillApprovalPath,verifiedDetailPath,submitConfigurationForReview} from './approval-target';
import {backfillFileNames} from './backfill-files';
import {APP_ORIGIN,trustedRenderer,argumentsByMethod,approvalUrl,rendererSafe,type Method} from './security';
import type {SourceRole,WorkspaceFolderSuggestion} from '../ui/workspace-types';
import type {ConnectStatus} from '../ui/types';
import { HostedSession } from './hosted-session';
declare const __PACKPROOF_HOSTED__: boolean;
const embedded = typeof __PACKPROOF_HOSTED__ !== 'undefined' && __PACKPROOF_HOSTED__;
let host: HostedSession | null = null;
if (!embedded) protocol.registerSchemesAsPrivileged([{scheme:'packproof-connect',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);app.enableSandbox();
let win:BrowserWindow|null=null;
const bridge=new ServiceBridge(process.resourcesPath);
let config:{channel:string;webBaseUrl:string;updateUrl:string;publisher:string};
async function status():Promise<ConnectStatus>{return rendererSafe(await bridge.request('status')) as ConnectStatus;}
async function mutate(operation:string,payload?:unknown){await bridge.request(operation,payload);return status();}
function safeError(error:unknown){const message=error instanceof Error?error.message:'';return message&&!/Bearer\s|pp_org_|(?:token|secret|credential)\s*[:=]\s*\S+|[A-Z]:\\|\/workspace\//i.test(message)?message.slice(0,400):'PackProof could not complete this action. Your pending work is preserved. Open diagnostics for the next step.';}
async function open(url:string){const u=new URL(url);if(u.origin!==new URL(config.webBaseUrl).origin||u.protocol!=='https:')throw Error('Only trusted PackProof pages can open.');await shell.openExternal(u.href);}
function bind(name:Method,fn:(...args:any[])=>unknown){ipcMain.handle(`connect:${name}`,async(event,...args)=>{try{if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!trustedRenderer(event.senderFrame.url))throw Error('Untrusted application request.');const parsed=argumentsByMethod[name].parse(args);
 const user = host ? await host.guard(name) : null;
 if (host && (name === 'openWorkspaceOrder' || name === 'openWorkspaceReview')) {
   const [proofId, revision, subject] = parsed as unknown[];
   await host.daily(name === 'openWorkspaceOrder' ? { proofId: String(proofId), revision: Number(revision), ...(typeof subject === 'string' ? {subject} : {}) } : undefined);
   return {ok:true};
 }
 if (host && ['workspaceOrderDetail','workspaceSourceRecord','workspaceSearchOrders','workspaceOrderPage','workspaceAttention','openWorkspaceOutput'].includes(name))
   throw Error('Open Orders and exceptions from the Logistics menu to view your authorized records.');
 const value = await fn(...parsed);
 if (host && await host.guard(name) !== user) throw Error('Your account changed.');
 return {ok:true,value:host ? host.present(name,value) : value};}catch(error){return {ok:false,error:safeError(error)};}});}
async function openWorkspaceApproval(current:ConnectStatus) {
 if (!current.installationId && current.enrollment?.state === 'pending') {
  await open(approvalUrl(currentApprovalPath(current),config.webBaseUrl));
  return;
 }
 const path = current.workspace?.approvalPath;
 if (!path || current.workspace?.phase !== 'awaiting_approval')
   throw Error('Review your selected sources and start collecting to request permission.');
 await open(approvalUrl(path, config.webBaseUrl));
}
const folderOffers = new WorkspaceFolderOffers();
async function availableFolderOptions(role: SourceRole, scan: boolean): Promise<FolderOption[]> {
 const current = await status();
 const selected: WorkspaceFolderSuggestion[] = (current.workspace?.sources ?? [])
  .filter(source => source.folder && source.transport !== 'api' && source.roles.includes(role))
  .map(source => ({folder: source.folder, kind: 'selected'}));
 const prepared = preparedExportPath(config.channel, process.env.ProgramData);
 const preparedExists = await lstat(prepared).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false);
 const fallback: WorkspaceFolderSuggestion[] = preparedExists ? [{folder: prepared, kind: 'prepared'}] : [];
 if (!scan) {
  // Existing remote shares remain available to the explicit picker. Do not
  // contact them during automatic local discovery.
  const available: WorkspaceFolderSuggestion[] = [];
  for (const choice of selected) {
   if (await stat(choice.folder).then(info => info.isDirectory(), () => false)) available.push(choice);
  }
  return [...available, ...fallback];
 }
 const exclude = [current.proofOutput?.folder, current.workspace?.outputFolder].filter((path): path is string => !!path);
 const discovered = await discoverWorkspaceFolders(role, {exclude}, bridge);
 return distinctLocations([...discovered, ...selected, ...fallback]);
}
function setup(){
 bind('getFacilityDraft',()=>bridge.request('getFacilityDraft'));
 bind('saveFacilityDraft',(expectedRevision,changes)=>bridge.request('saveFacilityDraft',{expectedRevision,changes}));
 bind('replayFacilityDraft',expectedRevision=>bridge.request('replayFacilityDraft',{expectedRevision}));
 bind('getWorkspaceFolderSuggestion', async role => {
  const choices = await availableFolderOptions(role, false);
  folderOffers.remember(role, choices.slice(0, 1));
  return choices[0] ?? null;
 });
 bind('discoverWorkspaceFolders', async role => folderOffers.remember(role, await availableFolderOptions(role, true)));
 bind('useWorkspaceFolderSuggestion', async (role, expectedFolder) => {
  const choice = await folderOffers.confirm(role, expectedFolder, scan => availableFolderOptions(role, scan));
  return mutate('addWorkspaceSource', {role, folder: choice.folder, sampleFile: choice.sampleFile});
 });
 bind('replaceWorkspaceFolder',async (sourceId,expectedGeneration)=>{
  const current=await status();
  const source=current.workspace?.sources.find(s=>s.id===sourceId && s.generation===expectedGeneration && s.transport!=='api');
  if(!source)throw Error('This connection has changed. Reopen it to choose its folder.');
  const result=await dialog.showOpenDialog(win!,{title:'Choose the folder for this connection',defaultPath:source.folder,properties:['openDirectory','dontAddToRecent']});
  if(result.canceled || result.filePaths.length!==1)return status();
  return mutate('replaceWorkspaceFolder',{sourceId,expectedGeneration,folder:result.filePaths[0]});
 });
 bind('workspaceOrderPage',async before=>rendererSafe(await bridge.request('workspaceOrderPage',{before})));
 bind('workspaceSourceRecord',async (proofId,revision,eventKey)=>bridge.request('workspaceSourceRecord',{proofId,revision,eventKey}));
 bind('chooseWorkspaceRelatedSource',(sourceId,expectedGeneration,role,relatedId)=>mutate('chooseWorkspaceRelatedSource',{sourceId,expectedGeneration,role,relatedId}));
 bind('confirmWorkspaceOrderMap',(sourceId,expectedGeneration,profileVersion)=>mutate('confirmWorkspaceOrderMap',{sourceId,expectedGeneration,profileVersion}));
 bind('openWorkspaceReview',async()=>{
  const current=await status();
  if(!current.installationId || current.state==='revoked') throw Error('Connect this computer before opening online review.');
  const params=workspaceParams(current);
  await open(new URL('/app/needs-attention?'+params,config.webBaseUrl).href);
 });
 bind('openWorkspaceOrder', async (proofId,revision,subject)=>{
  const allowed=await bridge.request('workspaceOrderDetail',{proofId,revision}) as {proofId?:string;revision?:number};
  if(allowed?.proofId!==proofId || allowed.revision!==revision) throw Error('Select this order again to open it online.');
  const params=workspaceParams(await status());
  params.set('revision',String(revision));
  if(typeof subject === 'string') params.set('subject',subject);
  await open(new URL('/app/order-proofs/'+encodeURIComponent(proofId)+'?'+params,config.webBaseUrl).href);
 });
 bind('workspaceSearchOrders',async query=>rendererSafe(await bridge.request('workspaceSearchOrders',{query})));
 bind('workspaceAttention',async before=>rendererSafe(await bridge.request('workspaceAttention',before===undefined?{}:{before})));
 bind('getWorkspaceStatus',status);
 bind('addWorkspaceDirectSource',(sourceNamespace?:string)=>mutate('addWorkspaceDirectSource',{role:'order',sourceNamespace}));
 bind('copyWorkspaceDirectProfile',async sourceId=>{
  const profile=rendererSafe(await bridge.request('workspaceDirectConnection',{sourceId}));
  if(!profile || typeof profile!=='object')throw Error('Approve this source before copying its connection details.');
  const encoded=JSON.stringify(profile,null,2);
  if(encoded.length>8192)throw Error('The connection details are unavailable. Check the source in Settings.');
  clipboard.writeText(encoded);
 });
 bind('workspaceDraftPreview',async()=>rendererSafe(await bridge.request('workspaceDraftPreview')));
 bind('workspaceOrderDetail', async (proofId,revision) => bridge.request('workspaceOrderDetail', {proofId,revision}));
 bind('chooseWorkspaceFolder', async role => {
  const result = await dialog.showOpenDialog(win!, { title:'Choose a records folder', defaultPath:(await availableFolderOptions(role, false))[0]?.folder, properties:['openDirectory','dontAddToRecent'] });
  if (result.canceled || result.filePaths.length !== 1) return status();
  return mutate('addWorkspaceSource', {role, folder:result.filePaths[0]});
 });
 bind('reuseWorkspaceFolder', async (sourceId,role) => {
  const source = (await status()).workspace?.sources.find(item => item.id === sourceId);
  if (!source) throw Error('This location has changed. Choose a records folder again.');
  return mutate('addWorkspaceSource', {role, folder:source.folder});
 });
 bind('saveWorkspaceStep', step => mutate('saveWorkspaceStep', {step}));
 bind('removeWorkspaceRole', (sourceId,role) => mutate('removeWorkspaceRole', {sourceId,role}));
 for (const method of ['inspectWorkspaceSource','pauseWorkspaceSource','resumeWorkspaceSource'] as const)
   bind(method, sourceId => mutate(method, {sourceId}));
 bind('chooseWorkspaceOutput', async () => {
  const result = await dialog.showOpenDialog(win!, { title:'Where should PackProof save your proofs?', properties:['openDirectory','createDirectory','dontAddToRecent'] });
  if (result.canceled || result.filePaths.length !== 1) return status();
  return mutate('setWorkspaceOutput', {folder:result.filePaths[0]});
 });
 bind('activateWorkspace', async (pending?:true) => {
  const current = await mutate('activateWorkspace', pending ? {allowPendingOutput:true} : {});
  if (!current.installationId && current.enrollment?.state === 'pending') {
   try { await open(approvalUrl(currentApprovalPath(current),config.webBaseUrl)); }
   catch { return {...current,authorizationNotice:'Open the browser review to connect this computer.'}; }
  } else if (current.workspace?.phase === 'awaiting_approval' && current.workspace.approvalPath) {
   try { await openWorkspaceApproval(current); }
   catch { return {...current, authorizationNotice:'Your request was saved. Select Open browser review to continue.'}; }
  }
  return current;
 });
 bind('openWorkspaceApproval', async () => openWorkspaceApproval(await status()));
 bind('openWorkspaceOutput', async () => {
  const current = await status();
  const folder = current.proofOutput?.folder || current.workspace?.outputFolder;
  if (!folder || !(await stat(folder)).isDirectory()) throw Error('Your proof folder is unavailable. Reconnect the drive or choose a folder in Settings.');
  if (await shell.openPath(folder)) throw Error('Windows could not open your proof folder. Check the drive or folder permissions.');
 });
 bind('chooseBackfillFiles',async input=>{
  const current=await status(),source=current.sourceSubscriptions?.find(source=>source.id===input.id);
  if(current.capabilities?.sourceBackfillJobs!==true||source?.backfillAvailable!==true||!source.folder||source.state!=='active'||source.localPaused)throw Error('Refresh and resume the current approved source before inspecting historical reports.');
  const selected=await dialog.showOpenDialog(win!,{title:`Choose historical reports for ${source.displayName}`,defaultPath:source.folder,properties:['openFile','multiSelections','dontAddToRecent'],filters:[{name:'Completed CSV reports',extensions:['csv']}]});
  if(selected.canceled)return current;
  return mutate('inspectBackfill',{...input,fileNames:backfillFileNames(source.folder,selected.filePaths)});
 });
 for(const method of ['proposeBackfill','pauseBackfill','resumeBackfill'] as const)bind(method,input=>mutate(method,input));
 bind('openBackfillApproval',async input=>open(approvalUrl(currentBackfillApprovalPath(await status(),input.id,input.jobId),config.webBaseUrl)));
 bind('chooseNewSubscriptionFolder',async()=>{
  const selected=await dialog.showOpenDialog(win!,{title:'Choose a dedicated existing export folder',defaultPath:preparedExportPath(config.channel,process.env.ProgramData),properties:['openDirectory','dontAddToRecent']});
  if(selected.canceled||selected.filePaths.length!==1)return status();
  return mutate('beginSubscriptionSource',{folder:selected.filePaths[0]});
 });
 bind('inspectSubscriptionDraft',fileName=>mutate('inspectSubscriptionDraft',{fileName}));
 bind('proposeSubscription',async input=>{
  const next=await mutate('proposeSubscription',input);
  // A source-specific saved locator, returned only after successful proposal,
  // opens the same trusted browser flow without replacing an enrollment.
  const proposalId=next.subscriptionDraft?.proposal?.id??next.subscriptionDraft?.proposal?.subscriptionId;
  const proposed=next.sourceSubscriptions?.find(s=>s.id===proposalId&&s.state==='proposed');
  if(proposed){try{await open(approvalUrl(currentSubscriptionApprovalPath(next,proposed.id),config.webBaseUrl));}catch{return {...next,authorizationNotice:'The source proposal was saved. Select Review source in browser to reopen the exact approval.'};}}
  return next;
 });
 bind('chooseSubscriptionFolder',async id=>{
  const current=await status(),source=current.sourceSubscriptions?.find(s=>s.id===id);
  if(!source||source.state==='revoked')throw Error('Refresh the current source approval before selecting its folder.');
  const selected=await dialog.showOpenDialog(win!,{title:`Choose the approved folder for ${source.displayName}`,defaultPath:source.folder||preparedExportPath(config.channel,process.env.ProgramData),properties:['openDirectory','dontAddToRecent']});
  if(selected.canceled||selected.filePaths.length!==1)return current;
  return mutate('selectSubscriptionSource',{id,folder:selected.filePaths[0]});
 });
 bind('inspectSubscriptionFile',input=>mutate('inspectSubscriptionFile',input));
 bind('previewSubscription',input=>mutate('previewSubscription',input));
 bind('commitSubscription',input=>mutate('commitSubscription',input));
 for(const method of ['verifySubscription','pauseSubscription','resumeSubscription'] as const)bind(method,id=>mutate(method,{id}));
 bind('openSubscriptionApproval',async id=>open(approvalUrl(currentSubscriptionApprovalPath(await status(),id),config.webBaseUrl)));
 bind('openSubscriptionCase',async id=>open(new URL(verifiedDetailPath(await mutate('refresh'),id),config.webBaseUrl).href));
 // A failed policy refresh does not erase the saved local review or canonical
 // receipt. The service's timestamped observation owns current remote readiness.
 bind('getStatus',async()=>{try{await bridge.request('refresh');}catch{/* Return preserved local state with the service's failed transport observation. */}return status();});bind('recoverEnrollment',consent=>mutate('recoverEnrollment',consent));bind('beginEnrollment',async()=>{const value=await mutate('beginEnrollment');try{await open(approvalUrl(currentApprovalPath(value),config.webBaseUrl));}catch{return {...value,authorizationNotice:'Your sign-in request was saved. Open the browser review to continue.'};}return value;});bind('checkComputer',async()=>{const result=rendererSafe(await bridge.request('preflight')) as {checks:unknown;transport?:unknown;versions?:unknown};return {...await status(),checks:result.checks,transport:result.transport,versions:result.versions};});
 for(const [method,operation] of Object.entries({pollEnrollment:'pollEnrollment',verifyImport:'verify',proposeActivation:'proposeActivation',activate:'activate',pause:'pause',resume:'resume',refresh:'refresh'}))bind(method as Method,()=>mutate(operation));
 bind('chooseFolder',async()=>{
  const prepared=preparedExportPath(config.channel,process.env.ProgramData);
  const value=await dialog.showOpenDialog(win!,{title:'Choose shipment reports — the prepared PackProof folder is ready',defaultPath:prepared,properties:['openDirectory','dontAddToRecent']});
  if(value.canceled||value.filePaths.length!==1)return status();
  try{return await mutate('selectFolder',{folder:value.filePaths[0]});}
  catch(error){
   if(!canOfferPreparedFolder(error))throw error;
   const answer=await dialog.showMessageBox(win!,{type:'info',title:'Choose a folder the background collector can read',message:'This shipment folder is not accessible to the PackProof background helper.',detail:'Use the dedicated folder PackProof prepared during installation, and save your shipping software’s finished CSV exports there. This will not move files, change access to your personal folders, or upload anything.',buttons:['Use prepared PackProof folder','Cancel'],defaultId:0,cancelId:1});
   if(answer.response!==0)throw error;
   return mutate('selectFolder',{folder:prepared});
  }
 });
 bind('analyzeLocal',input=>mutate('analyzeLocal',input));
 bind('startSetup',input=>submitConfigurationForReview(()=>mutate('startSetup',input),open,config.webBaseUrl));
 bind('previewLocal',fileName=>mutate('localPreview',{fileName}));
 bind('proposeConfiguration',value=>submitConfigurationForReview(()=>mutate('proposeConfiguration',value),open,config.webBaseUrl));
 bind('previewCloud',consent=>mutate('preview',consent));bind('commitBatch',consent=>mutate('commit',consent));
 bind('openApproval',async()=>open(approvalUrl(currentApprovalPath(await status()),config.webBaseUrl)));
 bind('openRecord',async id=>{const s=await mutate('refresh');if(!id)id=s.verification?.recordId;if(!id||!s.verification?.complete||id!==s.verification.recordId)throw Error('Verify the completed record before opening it.');await open(new URL(verifiedDetailPath(s),config.webBaseUrl).href);});
 bind('openPortal',()=>open(new URL('/app/connections',config.webBaseUrl).href));
 bind('exportDiagnostics',async()=>{const report=rendererSafe(await bridge.request('diagnostics'));const answer=await dialog.showMessageBox(win!,{type:'info',title:'Review diagnostic export',message:'Export a redacted support report?',detail:'Review this redacted report before saving. Shipment rows, service credentials and source paths are excluded. You choose whether to share it.\n\n'+JSON.stringify(report,null,2).slice(0,12000),buttons:['Cancel','Save report'],defaultId:0,cancelId:0});if(answer.response!==1)return {saved:false};const target=await dialog.showSaveDialog(win!,{title:'Save redacted diagnostics',defaultPath:'PackProof-Connect-diagnostics.json',filters:[{name:'JSON report',extensions:['json']}]});if(target.canceled||!target.filePath)return {saved:false};await writeFile(target.filePath,JSON.stringify(report,null,2),{mode:0o600});return {saved:true};});
}
async function initialize(){

  config=JSON.parse(await readFile(join(__dirname,'runtime-config.json'),'utf8'));if (!embedded) { app.setName(`PackProof Connect ${config.channel}`);app.setPath('userData',join(app.getPath('appData'),`PackProof-Connect-${config.channel}`)); }
  if (!embedded) session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  const root=resolve(__dirname,'../renderer');
  protocol.handle('packproof-connect',async request=>{const u=new URL(request.url);if(!trustedRenderer(request.url))return new Response('',{status:403});let pathname;try{pathname=decodeURIComponent(u.pathname);}catch{return new Response('',{status:400});}const file=resolve(root,'.'+pathname);if(file!==root&&!file.startsWith(root+sep))return new Response('',{status:403});try{if(!(await stat(file)).isFile())return new Response('',{status:404});const response=await net.fetch(pathToFileURL(file).href);const headers=new Headers(response.headers);headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");headers.set('X-Content-Type-Options','nosniff');return new Response(response.body,{status:response.status,headers});}catch{return new Response('',{status:404});}});
  setup();
}
async function showSetup(){
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win=new BrowserWindow({width:1180,height:820,minWidth:560,minHeight:600,title:'PackProof Connect',show:false,backgroundColor:'#f7f9fc',webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,devTools:!app.isPackaged,spellcheck:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());win.webContents.on('will-attach-webview',event=>event.preventDefault());win.once('ready-to-show',()=>win?.show());win.on('closed',()=>{win=null;});
  await win.loadURL(APP_ORIGIN+'/index.html'+(embedded?'?facilitySetup=1':''));
  if (!embedded) startUpdates(win,bridge,config);
}
export async function attachHumanSession(human: ConstructorParameters<typeof HostedSession>[0]) {
  await initialize();
  const current = new HostedSession(human, op => bridge.request(op), config.webBaseUrl);
  host = current;
  current.bindAssistant(() => win);
  return {
    choices: () => current.choices(),
    orders: () => current.daily(),
    setup: async () => { await current.guard('getStatus'); await showSetup(); },
    close: () => { current.close(); if (win && !win.isDestroyed()) win.destroy(); }
  };
}
if(!embedded) {
 if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{win?.show();win?.focus();});app.on('window-all-closed',()=>app.quit());
 void app.whenReady().then(async()=>{ await initialize(); await showSetup();
 }).catch(()=>{dialog.showErrorBox('PackProof Connect requires repair','The trusted application files could not be loaded. Your background service and queued exports are preserved.');app.quit();});
}
}
