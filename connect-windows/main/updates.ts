import {dialog,type BrowserWindow} from 'electron';
import {autoUpdater} from 'electron-updater';
import type {ServiceBridge} from './pipe';
/** Signed, isolated Connect feed; installation always uses the existing elevated NSIS mechanism. */
export function startUpdates(win:BrowserWindow,bridge:ServiceBridge,config:{channel:string;updateUrl:string;publisher:string}){
 if(config.channel==='development')return;
 const expected=`https://downloads.thepackproof.com/connect/${config.channel}/win32/x64/`;
 if(config.updateUrl!==expected||!config.publisher)throw Error('The Connect update identity is invalid.');
 autoUpdater.autoDownload=true;autoUpdater.autoInstallOnAppQuit=false;autoUpdater.allowDowngrade=false;
 autoUpdater.setFeedURL({provider:'generic',url:expected,channel:'latest'});
 autoUpdater.on('error',()=>{/* Update errors leave installed binaries and queue untouched. No token/body logging. */});
 autoUpdater.on('update-downloaded',()=>{void(async()=>{
  const answer=await dialog.showMessageBox(win,{type:'info',title:'PackProof Connect update ready',message:'Install the verified PackProof Connect update?',detail:'Windows will ask for administrator approval. The service checkpoints pending work before its signed installer replaces the application. Queued exports and source files are preserved.',buttons:['Later','Install update'],defaultId:0,cancelId:0});
  if(answer.response!==1)return;
  // The old installer's pre-removal hook gracefully stops/checkpoints the service before replacing files.
  // Do not suspend collection before UAC: a canceled elevation must leave the current service working.
  try{await bridge.request('status');autoUpdater.quitAndInstall(false,true);}catch{await dialog.showMessageBox(win,{type:'warning',message:'The service could not be reached before this update.',detail:'The working installation and pending exports are preserved. Retry after reviewing connection diagnostics.',buttons:['Keep working']});}
 })();});
 void autoUpdater.checkForUpdates().catch(()=>{});
}
