import {app} from 'electron';
import {autoUpdater} from 'electron-updater';
import type {DesktopConfig} from './config';
export class Updates {
 state:{state:string;version?:string;error?:string}={state:'unavailable'};
 constructor(private config:DesktopConfig|null,private changed:()=>void,private busy:()=>boolean,private prepare:()=>Promise<void>,private report?:()=>void){
  autoUpdater.autoDownload=false;autoUpdater.autoInstallOnAppQuit=false;autoUpdater.allowDowngrade=false;autoUpdater.allowPrerelease=false;
  if(!app.isPackaged||!config?.updateUrl||['development','research'].includes(config.channel))return;
  // The packaged app-update.yml embeds the trusted feed and publisher identity. Runtime cannot override it.
  this.state={state:'idle'};
  for(const [event,state] of [['checking-for-update','checking'],['update-not-available','current'],['download-progress','downloading']] as const)autoUpdater.on(event,()=>this.set({state}));
  autoUpdater.on('update-available',info=>this.set({state:'available',version:info.version}));
  autoUpdater.on('update-downloaded',info=>this.set({state:'ready',version:info.version}));
  autoUpdater.on('error',()=>{this.report?.();this.set({state:'error',error:'The update could not be verified or downloaded. Try again later.'});});
 }
 private set(state:typeof this.state){this.state=state;this.changed();}
 async check(){if(this.state.state==='unavailable')throw new Error('Automatic updates are available in configured signed releases.');await autoUpdater.checkForUpdates();}
 async download(){if(!['available','error'].includes(this.state.state))throw new Error('Check for an update first.');await autoUpdater.downloadUpdate();}
 async install(){if(this.state.state!=='ready')throw new Error('No verified update is ready.');if(this.busy())throw new Error('Finish recording before installing the update.');await this.prepare();autoUpdater.quitAndInstall(false,true);}
}
