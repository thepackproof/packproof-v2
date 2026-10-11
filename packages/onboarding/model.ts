export const VERSION=1;
export const FIRST_EXPERIENCE_VERSION=1;
export interface OnboardingState {
 onboarding_completed:boolean; onboarding_version:number; first_proof_coaching_completed:boolean;
 onboarding_last_step:number|null; onboarding_enrolled:boolean; current_version:number;
 first_proof_id:string|null; first_proof_completed:boolean;
 // Optional during a rolling API deployment. Missing fields mean unknown, not new.
 first_experience_version?:number; automatic_tour?:boolean;
 activation_status?:'NOT_ACTIVATED'|'ACTIVATED';
 first_finalized_packing_proof_id?:string|null; first_finalized_packing_at?:string|null;
}
export interface FirstExperience {
 status:'UNKNOWN'|'FIRST_PROOF'|'ACTIVE'; guidanceDismissed:boolean; firstFinalizedProofId:string|null;
}
// This does not establish that Home is empty: callers must also reconcile activity
// and durable local jobs before choosing an empty-account presentation.
export function selectFirstExperience(state:OnboardingState|null|undefined,error=false):FirstExperience {
 const guidanceDismissed=state?.first_proof_coaching_completed===true;
 const unknown:FirstExperience={status:'UNKNOWN',guidanceDismissed,firstFinalizedProofId:null};
 if(error||!state||state.first_experience_version!==FIRST_EXPERIENCE_VERSION)return unknown;
 if(state.activation_status==='ACTIVATED'&&state.first_finalized_packing_proof_id&&state.first_finalized_packing_at)
  return {status:'ACTIVE',guidanceDismissed,firstFinalizedProofId:state.first_finalized_packing_proof_id};
 if(state.activation_status==='NOT_ACTIVATED'&&state.first_finalized_packing_proof_id===null&&state.first_finalized_packing_at===null)
  return {status:'FIRST_PROOF',guidanceDismissed,firstFinalizedProofId:null};
 return unknown;
}
export type Action={action:'start'|'step'|'skip'|'complete'|'dismiss_coaching';version:number;step?:number};
function isAction(value:unknown):value is Action {
 if(!value||typeof value!=='object')return false;
 const action=value as Action;
 return action.version===VERSION&&['start','step','skip','complete','dismiss_coaching'].includes(action.action)
  &&(!['step','skip'].includes(action.action)||(Number.isInteger(action.step)&&action.step!>=0&&action.step!<6));
}
export interface Transport { getOnboarding():Promise<OnboardingState>; updateOnboarding(action:Action):Promise<OnboardingState> }
export const STEPS=[
 {target:'create',title:'Create your first Proof',body:'Record what you are shipping and create a structured evidence record.',position:'below'},
 {target:'proofs',title:'Your Proofs live here',body:'See active shipments, items needing attention, and completed Proofs in one place.',position:'below'},
 {target:'attention',title:'Know what needs action',body:'PackProof surfaces anything that still needs a step from you.',position:'below'},
 {target:'capture',title:'One continuous capture',body:'Record the item, packing process, and shipping label without breaking the evidence sequence.',position:'below'},
 {target:'status',title:'Follow your progress',body:'Check what is still uploading and what the server has saved. Your Proof is finished when its status is Finalized.',position:'above'},
 {target:'create',title:'You are ready',body:'Start your first Proof and PackProof will guide you through the rest.',position:'below'},
] as const;
export interface Snapshot { state:OnboardingState|null; step:number; replay:boolean; open:boolean; error:boolean }
// One account-scoped controller is used by all three clients. The server remains authoritative.
export class OnboardingController {
 snapshot:Snapshot={state:null,step:0,replay:false,open:false,error:false};
 private listeners=new Set<()=>void>(); private stopped=false; private dismissed=false; private queue:Action[]=[]; private flushing=false;
 constructor(private api:Transport,private storage:{read():Promise<string|null>;write(value:string):Promise<void>},private options:{autoTourEnabled?:boolean}={}){}
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 private emit(patch:Partial<Snapshot>){if(this.stopped)return;this.snapshot={...this.snapshot,...patch};this.listeners.forEach(fn=>fn());}
 private preferences(state:OnboardingState):OnboardingState {
  const skipped=this.queue.some(action=>action.action==='skip');
  return {...state,
   ...(skipped||this.queue.some(action=>action.action==='complete')?{onboarding_completed:true,onboarding_last_step:null}:{}),
   ...(skipped||this.queue.some(action=>action.action==='dismiss_coaching')?{first_proof_coaching_completed:true}:{})};
 }
 async load(){
  this.stopped=false;
  try{const raw=await this.storage.read();const parsed=raw?JSON.parse(raw):[];if(Array.isArray(parsed))this.queue=parsed.filter(isAction);}catch{/* Cache is optional. */}
  await this.refresh();
 }
 async refresh(){
  if(this.stopped)return;
  try{await this.flush();const state=this.preferences(await this.api.getOnboarding());if(this.stopped)return;
   this.emit({state,error:false,...(!this.snapshot.replay&&state.onboarding_completed?{open:false}:{}),...(!this.snapshot.state?{step:state.onboarding_last_step??0}:{})});
  }catch{this.emit({error:true});}
 }
 stop(){this.stopped=true;this.listeners.clear();}
 private enqueue(action:Action){this.queue.push(action);void this.persist().then(()=>this.flush());}
 private async persist(){try{await this.storage.write(JSON.stringify(this.queue));}catch{/* Network persistence still attempted. */}}
 private async flush(){
  if(this.flushing||this.stopped)return;this.flushing=true;
  try{while(this.queue.length&&!this.stopped){const state=await this.api.updateOnboarding(this.queue[0]);this.queue.shift();await this.persist();this.emit({state:this.preferences(state),error:false});}}
  catch{this.emit({error:true});}finally{this.flushing=false;}
 }
 start(replay=false){
  const s=this.snapshot.state;
  if(!replay&&!this.options.autoTourEnabled)return;
  if(!replay&&(this.dismissed||!s||s.onboarding_completed||s.current_version!==VERSION||!s.onboarding_enrolled||this.queue.some(a=>a.action==='skip'||a.action==='complete')))return;
  this.emit({open:true,replay,step:replay?0:this.snapshot.step});
  if(!replay)this.enqueue({action:'start',version:VERSION});
 }
 viewed(){if(this.snapshot.open&&!this.snapshot.replay)this.enqueue({action:'step',version:VERSION,step:this.snapshot.step});}
 move(delta:number){this.emit({step:Math.max(0,Math.min(STEPS.length-1,this.snapshot.step+delta))});}
 finish(skip=false){if(!this.snapshot.open)return;this.dismissed=true;const {replay,step}=this.snapshot;this.emit({open:false,replay:false});if(!replay)this.enqueue({action:skip?'skip':'complete',version:VERSION,step});}
 dismissCoaching(){this.emit({state:this.snapshot.state?{...this.snapshot.state,first_proof_coaching_completed:true}:null});this.enqueue({action:'dismiss_coaching',version:VERSION});}
}
