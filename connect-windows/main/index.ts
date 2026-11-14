import {app,BrowserWindow,protocol,net,ipcMain,dialog,shell,session} from 'electron';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ServiceBridge} from './pipe';
import {startUpdates} from './updates';
import {preparedExportPath,canOfferPreparedFolder} from './source-choice';
import {currentApprovalPath,currentSubscriptionApprovalPath,currentBackfillApprovalPath,submitConfigurationForReview} from './approval-target';
import {backfillFileNames} from './backfill-files';
import {APP_ORIGIN,trustedRenderer,argumentsByMethod,approvalUrl,rendererSafe,type Method} from './security';
import type {ConnectStatus} from '../ui/types';
protocol.registerSchemesAsPrivileged([{scheme:'packproof-connect',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);app.enableSandbox();
let win:BrowserWindow|null=null;
const bridge=new ServiceBridge(process.resourcesPath);
let config:{channel:string;webBaseUrl:string;updateUrl:string;publisher:string};
async function status():Promise<ConnectStatus>{return rendererSafe(await bridge.request('status')) as ConnectStatus;}
async function mutate(operation:string,payload?:unknown){await bridge.request(operation,payload);return status();}
function safeError(error:unknown){const message=error instanceof Error?error.message:'';return message&&!/Bearer\s|pp_org_|(?:token|secret|credential)\s*[:=]\s*\S+|[A-Z]:\\|\/workspace\//i.test(message)?message.slice(0,400):'PackProof could not complete this action. Your pending work is preserved. Open diagnostics for the next step.';}
async function open(url:string){const u=new URL(url);if(u.origin!==new URL(config.webBaseUrl).origin||u.protocol!=='https:')throw Error('Only trusted PackProof pages can open.');await shell.openExternal(u.href);}
function bind(name:Method,fn:(...args:any[])=>unknown){ipcMain.handle(`connect:${name}`,async(event,...args)=>{try{if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!trustedRenderer(event.senderFrame.url))throw Error('Untrusted application request.');const parsed=argumentsByMethod[name].parse(args);return {ok:true,value:await fn(...parsed)};}catch(error){return {ok:false,error:safeError(error)};}});}
function setup(){
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
 bind('openSubscriptionCase',async id=>{
  const source=(await status()).sourceSubscriptions?.find(s=>s.id===id);
  if(!source?.verifiedCaseId||!/^[A-Za-z0-9_-]{1,160}$/.test(source.verifiedCaseId))throw Error('Retrieve and verify the first real case before opening it.');
  await open(new URL(`/app/records/cases/${encodeURIComponent(source.verifiedCaseId)}`,config.webBaseUrl).href);
 });
 bind('getStatus',async()=>{try{await bridge.request('refresh');return status();}catch{const cached=await status();return {...cached,state:cached.state==='revoked'?'revoked':'action_needed',verification:{complete:false},authorizationNotice:'Current PackProof approval could not be refreshed. Check service network access, or begin approved recovery when access has expired or been revoked.'};}});bind('recoverEnrollment',consent=>mutate('recoverEnrollment',consent));bind('beginEnrollment',async()=>{const value=await mutate('beginEnrollment');await open(approvalUrl(currentApprovalPath(value),config.webBaseUrl));return value;});bind('checkComputer',async()=>{const result=rendererSafe(await bridge.request('preflight')) as {checks:unknown};return {...await status(),checks:result.checks};});
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
 bind('openRecord',async id=>{const s=await status();if(!id)id=s.verification?.recordId;if(!id||!s.verification?.complete||id!==s.verification.recordId)throw Error('Verify the completed record before opening it.');await open(new URL(`/app/records/${encodeURIComponent(id)}`,config.webBaseUrl).href);});
 bind('openPortal',()=>open(new URL('/app/connections',config.webBaseUrl).href));
 bind('exportDiagnostics',async()=>{const report=rendererSafe(await bridge.request('diagnostics'));const answer=await dialog.showMessageBox(win!,{type:'info',title:'Review diagnostic export',message:'Export a redacted support report?',detail:'Review this redacted report before saving. Shipment rows, service credentials and source paths are excluded. You choose whether to share it.\n\n'+JSON.stringify(report,null,2).slice(0,12000),buttons:['Cancel','Save report'],defaultId:0,cancelId:0});if(answer.response!==1)return {saved:false};const target=await dialog.showSaveDialog(win!,{title:'Save redacted diagnostics',defaultPath:'PackProof-Connect-diagnostics.json',filters:[{name:'JSON report',extensions:['json']}]});if(target.canceled||!target.filePath)return {saved:false};await writeFile(target.filePath,JSON.stringify(report,null,2),{mode:0o600});return {saved:true};});
}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{win?.show();win?.focus();});app.on('window-all-closed',()=>app.quit());
 void app.whenReady().then(async()=>{
  config=JSON.parse(await readFile(join(__dirname,'runtime-config.json'),'utf8'));app.setName(`PackProof Connect ${config.channel}`);app.setPath('userData',join(app.getPath('appData'),`PackProof-Connect-${config.channel}`));
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  const root=resolve(__dirname,'../renderer');
  protocol.handle('packproof-connect',async request=>{const u=new URL(request.url);if(!trustedRenderer(request.url))return new Response('',{status:403});let pathname;try{pathname=decodeURIComponent(u.pathname);}catch{return new Response('',{status:400});}const file=resolve(root,'.'+pathname);if(file!==root&&!file.startsWith(root+sep))return new Response('',{status:403});try{if(!(await stat(file)).isFile())return new Response('',{status:404});const response=await net.fetch(pathToFileURL(file).href);const headers=new Headers(response.headers);headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");headers.set('X-Content-Type-Options','nosniff');return new Response(response.body,{status:response.status,headers});}catch{return new Response('',{status:404});}});
  setup();win=new BrowserWindow({width:1180,height:820,minWidth:560,minHeight:600,title:'PackProof Connect',show:false,backgroundColor:'#f7f9fc',webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,devTools:!app.isPackaged,spellcheck:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());win.webContents.on('will-attach-webview',event=>event.preventDefault());win.once('ready-to-show',()=>win?.show());await win.loadURL(APP_ORIGIN+'/index.html');startUpdates(win,bridge,config);
 }).catch(()=>{dialog.showErrorBox('PackProof Connect requires repair','The trusted application files could not be loaded. Your background service and queued exports are preserved.');app.quit();});
}
