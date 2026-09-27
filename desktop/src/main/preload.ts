import {contextBridge,ipcRenderer} from 'electron';
import type {PackProofDesktop,DesktopEvent} from '../shared/contracts';
const call=(channel:string,...args:unknown[])=>ipcRenderer.invoke(`packproof:${channel}`,...args).then(result=>{if(!result?.ok)throw new Error(result?.error??'PackProof could not complete the request.');return result.value;});
const api:PackProofDesktop={
 auth:{state:()=>call('auth.state'),signIn:i=>call('auth.signIn',i),signUp:i=>call('auth.signUp',i),confirmSignUp:i=>call('auth.confirmSignUp',i),resendCode:e=>call('auth.resendCode',e),forgotPassword:e=>call('auth.forgotPassword',e),resetPassword:i=>call('auth.resetPassword',i),signOut:()=>call('auth.signOut')},
 proofs:{list:()=>call('proofs.list'),detail:id=>call('proofs.detail',id),create:i=>call('proofs.create',i),finalize:id=>call('proofs.finalize',id),share:id=>call('proofs.share',id),export:id=>call('proofs.export',id),evidenceUrl:(p,e)=>call('proofs.evidenceUrl',p,e)},
 orders:{list:()=>call('orders.list'),resolve:c=>call('orders.resolve',c),sync:id=>call('orders.sync',id)},integrations:{list:()=>call('integrations.list'),connect:p=>call('integrations.connect',p)},
 capture:{begin:i=>call('capture.begin',i),append:(id,n,b)=>call('capture.append',id,n,b),finish:(id,i)=>call('capture.finish',id,i),interrupt:(id,r)=>call('capture.interrupt',id,r)},
 uploads:{list:()=>call('uploads.list'),retry:id=>call('uploads.retry',id),discard:id=>call('uploads.discard',id),pause:()=>call('uploads.pause'),resume:()=>call('uploads.resume')},
 system:{report:code=>call('system.report',code),state:()=>call('system.state'),settings:()=>call('system.settings'),saveSettings:s=>call('system.saveSettings',s),openExternal:u=>call('system.openExternal',u),exportDiagnostics:()=>call('system.exportDiagnostics')},updates:{check:()=>call('updates.check'),download:()=>call('updates.download'),install:()=>call('updates.install')},
 events:{subscribe:callback=>{const listener=(_event:Electron.IpcRendererEvent,data:DesktopEvent)=>callback(data);ipcRenderer.on('packproof:event',listener);return()=>ipcRenderer.removeListener('packproof:event',listener);}}
};
contextBridge.exposeInMainWorld('packproof',api);
