import {startStationStudy,selectFirstProofStudy,resumeStationStudy,type StudyApi,type StudyInteraction,type StationStudyTimer} from '../../../web/src/analytics/study-capture';
import type {UploadView} from '../shared/contracts';

/** Renderer receives only a bounded study transport; account credentials stay in main. */
export function desktopStudyApi(scope:string,userId:string):StudyApi {
  return {recoveryScope:scope,studyRequest:<T,>(path:string,method='GET',body?:unknown):Promise<T>=>{
    if(!['/consent','/timings/start','/timings'].includes(path)||!['GET','POST'].includes(method))return Promise.reject(new Error('Unsupported study request.'));
    return window.packproof.study.request<T>(userId,path as '/consent'|'/timings/start'|'/timings',method as 'GET'|'POST',body);
  }};
}
export function desktopStudyContext(version?:string){return {flowVersion:1 as const,platform:'desktop' as const,...(version&&/^[0-9][a-zA-Z0-9._-]{0,63}$/.test(version)?{appVersion:version}:{})};}
export function selectDesktopStudy(api:StudyApi,userId:string,version?:string,source:'home'|'manual'|'order'|'deep_link'='manual'){
  return selectFirstProofStudy(api,userId,source,new Date(),desktopStudyContext(version));
}
export function desktopStudyEvent(timer:Promise<StationStudyTimer|null>|null,event:StudyInteraction,once=false){
  const observedAt=new Date();void timer?.then(value=>value?.event(event,{once,observedAt})).catch(()=>{});
}
export function desktopStudyAction(api:StudyApi,userId:string,event:'entry_viewed'|'help_opened'|'recovery_action',version?:string){
  const observedAt=new Date();void startStationStudy(api,userId,'interface_action',{...desktopStudyContext(version),entrySource:event==='help_opened'?'help':event==='recovery_action'?'recovery':'home'},observedAt).then(timer=>{timer?.event(event,{observedAt});timer?.end('succeeded');}).catch(()=>{});
}
const jobKey=(api:StudyApi,userId:string,id:string)=>`packproof-desktop-study-job:${api.recoveryScope}:${userId}:${id}`;
/** Local references associate recovery with the original consented task. Neither
 * the job identifier nor the journal locator enters a telemetry payload. */
export function bindDesktopStudyJob(api:StudyApi,userId:string,id:string,task:Promise<StationStudyTimer|null>|null){
  void task?.then(timer=>{if(timer)try{localStorage.setItem(jobKey(api,userId,id),JSON.stringify({localRef:timer.localRef,state:''}));}catch{}}).catch(()=>{});
}
const observing=new Set<string>();
export async function observeDesktopStudyJobs(api:StudyApi,userId:string,jobs:UploadView[]){
  for(const job of jobs){const key=jobKey(api,userId,job.id);if(observing.has(key))continue;observing.add(key);
    try{
      const row=JSON.parse(localStorage.getItem(key)??'null') as {localRef:string;state:string}|null;
      if(!row||row.state===job.state)continue;
      const timer=await resumeStationStudy(api,userId,row.localRef);if(!timer)continue;
      const uploadState=desktopUploadState(job.state);if(uploadState)timer.event('upload_state_changed',{uploadState});
      // COMPLETE is emitted by the main process only after attestAndFinalize.
      if(job.state==='COMPLETE'){timer.end('succeeded');localStorage.removeItem(key);}
      else if(job.state==='DISCARDED'){timer.end('cancelled');localStorage.removeItem(key);}
      else{if(job.state==='FINALIZING')timer.phase('finalization');else if(uploadState)timer.phase('upload');localStorage.setItem(key,JSON.stringify({...row,state:job.state}));}
    }catch{/* Optional measurement cannot block evidence recovery. */}finally{observing.delete(key);}
  }
}
export function desktopUploadState(state:string):'queued'|'uploading'|'waiting'|'retrying'|'committing'|'finalizing'|'complete'|'needs_attention'|undefined{
  if(['LOCAL','HASHING','READY'].includes(state))return 'queued';
  if(['UPLOADING','VERIFYING'].includes(state))return 'uploading';
  if(['WAITING_FOR_NETWORK','PAUSED','AUTH_REQUIRED','WAITING_FOR_AUTH'].includes(state))return 'waiting';
  if(state==='RETRYING')return 'retrying';if(state==='COMMITTING')return 'committing';if(state==='FINALIZING')return 'finalizing';if(state==='COMPLETE')return 'complete';
  if(['FAILED','INTERRUPTED'].includes(state))return 'needs_attention';return undefined;
}
