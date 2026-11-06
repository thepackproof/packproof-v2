import {app,BrowserWindow,protocol,net,ipcMain,dialog,shell,session} from 'electron';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ServiceBridge} from './pipe';
import {startUpdates} from './updates';
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
 bind('getStatus',status);bind('beginEnrollment',async()=>{const value=await mutate('beginEnrollment');const path=value.approvalPath||value.enrollment?.approvalPath;if(path)await open(approvalUrl(path,config.webBaseUrl));return value;});bind('checkComputer',async()=>{const result=rendererSafe(await bridge.request('preflight')) as {checks:unknown};return {...await status(),checks:result.checks};});
 for(const [method,operation] of Object.entries({pollEnrollment:'pollEnrollment',verifyImport:'verify',proposeActivation:'proposeActivation',activate:'activate',pause:'pause',resume:'resume',refresh:'refresh'}))bind(method as Method,()=>mutate(operation));
 bind('chooseFolder',async()=>{const value=await dialog.showOpenDialog(win!,{title:'Choose the approved local CSV export folder',properties:['openDirectory','dontAddToRecent']});if(value.canceled||value.filePaths.length!==1)return status();return mutate('selectFolder',{folder:value.filePaths[0]});});
 bind('previewLocal',fileName=>mutate('localPreview',{fileName}));bind('proposeConfiguration',value=>mutate('proposeConfiguration',value));bind('previewCloud',consent=>mutate('preview',consent));bind('commitBatch',consent=>mutate('commit',consent));
 bind('openApproval',async()=>{const s=await status(),path=s.approvalPath||s.enrollment?.approvalPath;if(!path)throw Error('Start or refresh the approval request first.');await open(approvalUrl(path,config.webBaseUrl));});
 bind('openRecord',async id=>{const s=await status();if(!id)id=s.verification?.recordId;if(!id||!s.verification?.complete||id!==s.verification.recordId)throw Error('Verify the completed record before opening it.');await open(new URL(`/app/records/${encodeURIComponent(id)}`,config.webBaseUrl).href);});
 bind('openPortal',()=>open(new URL('/app/connections',config.webBaseUrl).href));
 bind('exportDiagnostics',async()=>{const report=rendererSafe(await bridge.request('diagnostics'));const answer=await dialog.showMessageBox(win!,{type:'info',title:'Review diagnostic export',message:'Export a redacted support report?',detail:'Includes versions, safe identifiers, queue counts, timestamps and error codes. Shipment rows, service credentials and source paths are excluded. You choose whether to share the saved report.',buttons:['Cancel','Save report'],defaultId:0,cancelId:0});if(answer.response!==1)return {saved:false};const target=await dialog.showSaveDialog(win!,{title:'Save redacted diagnostics',defaultPath:'PackProof-Connect-diagnostics.json',filters:[{name:'JSON report',extensions:['json']}]});if(target.canceled||!target.filePath)return {saved:false};await writeFile(target.filePath,JSON.stringify(report,null,2),{mode:0o600});return {saved:true};});
}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{win?.show();win?.focus();});app.on('window-all-closed',()=>app.quit());
 void app.whenReady().then(async()=>{
  config=JSON.parse(await readFile(join(__dirname,'runtime-config.json'),'utf8'));app.setName(`PackProof Connect ${config.channel}`);app.setPath('userData',join(app.getPath('appData'),`PackProof-Connect-${config.channel}`));
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  const root=resolve(__dirname,'../renderer');
  protocol.handle('packproof-connect',async request=>{const u=new URL(request.url);if(!trustedRenderer(request.url))return new Response('',{status:403});let pathname;try{pathname=decodeURIComponent(u.pathname);}catch{return new Response('',{status:400});}const file=resolve(root,'.'+pathname);if(file!==root&&!file.startsWith(root+sep))return new Response('',{status:403});try{if(!(await stat(file)).isFile())return new Response('',{status:404});const response=await net.fetch(pathToFileURL(file).href);const headers=new Headers(response.headers);headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");headers.set('X-Content-Type-Options','nosniff');return new Response(response.body,{status:response.status,headers});}catch{return new Response('',{status:404});}});
  setup();win=new BrowserWindow({width:1180,height:820,minWidth:800,minHeight:600,title:'PackProof Connect',show:false,backgroundColor:'#f7f9fc',webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,devTools:!app.isPackaged,spellcheck:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());win.webContents.on('will-attach-webview',event=>event.preventDefault());win.once('ready-to-show',()=>win?.show());await win.loadURL(APP_ORIGIN+'/index.html');startUpdates(win,bridge,config);
 }).catch(()=>{dialog.showErrorBox('PackProof Connect requires repair','The trusted application files could not be loaded. Your background service and queued exports are preserved.');app.quit();});
}
