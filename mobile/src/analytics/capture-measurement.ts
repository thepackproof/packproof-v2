import type {NativeStudyTimer} from './native-study-core';
import type {TimingCheckpoint} from './timing-bridge';

/** Callbacks are observation boundaries, not optimistic UI state. */
export function captureMeasurement(timer:NativeStudyTimer|null|Promise<NativeStudyTimer|null>){
  const observe=(action:(value:NativeStudyTimer)=>void)=>{if(timer instanceof Promise){void timer.then(value=>{if(value)action(value);}).catch(()=>{});}else if(timer)action(timer);};
  return {
    ready:()=>{const at=new Date();observe(value=>value.event('capture_ready',{at,once:true}));},
    started:(at=new Date())=>observe(value=>{value.phase('recording');value.event('capture_started',{at,once:true});value.event('recording_started',{at});}),
    interrupted:()=>{const at=new Date();observe(value=>value.event('capture_interrupted',{at,once:true}));},
    stopped:()=>{const at=new Date();observe(value=>{value.event('recording_stopped',{at});value.phase('confirmation');});},
    saved:async<T>(persist:()=>Promise<T>)=>{const result=await persist(),at=new Date();observe(value=>value.event('capture_saved',{at,once:true}));return result;},
    authorized:()=>{const at=new Date();observe(value=>value.event('submission_authorized',{at,once:true}));},
    guidance:(visible:boolean)=>{const at=new Date();observe(value=>value.event(visible?'help_opened':'hint_dismissed',{at}));},
    upload:(state:TimingCheckpoint['uploadState'])=>{const at=new Date();if(state)observe(value=>value.event('upload_state_changed',{at,uploadState:state}));},
  };
}

/** Persisted completion phases only; progress percentages are not events. */
export function measuredUploadState(phase:string,retryable=false):TimingCheckpoint['uploadState']|undefined{
  if(phase==='UPLOAD_QUEUED')return retryable?'retrying':'queued';
  if(phase==='UPLOADING')return 'uploading';
  if(phase==='BYTES_RECEIVED')return 'committing';
  if(phase==='PRESERVATION_PENDING')return 'waiting';
  if(phase==='FINALIZATION_PENDING')return 'finalizing';
  if(phase==='SUBMITTED'||phase==='FINALIZED')return 'complete';
  if(phase==='NEEDS_ATTENTION'||phase==='CONFIRMATION_NEEDED'||phase==='NEEDS_SIGN_IN')return 'needs_attention';
  return undefined;
}
