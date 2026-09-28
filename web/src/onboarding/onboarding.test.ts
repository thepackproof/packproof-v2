import {expect,it,vi} from 'vitest';
import {OnboardingController,type OnboardingState,type Action} from '../../../packages/onboarding/model';
const fresh:OnboardingState={onboarding_completed:false,onboarding_version:0,first_proof_coaching_completed:false,onboarding_last_step:2,onboarding_enrolled:true,current_version:1,first_proof_id:null,first_proof_completed:false};
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
it('replays without funnel writes or resetting coaching and opens at saved step',async()=>{
 const updateOnboarding=vi.fn(async(_action:Action)=>({...fresh}));
 const c=new OnboardingController({getOnboarding:async()=>({...fresh}),updateOnboarding},{read:async()=>null,write:async()=>{}});await c.load();expect(c.snapshot.step).toBe(2);
 c.start(true);c.viewed();c.move(1);c.finish();await settle();expect(updateOnboarding).not.toHaveBeenCalled();expect(c.snapshot.open).toBe(false);
});
it('persists offline skip for replay on reconnect and prevents immediate reopening',async()=>{
 let disk:string|null=null;let online=false;let state={...fresh};
 const api={getOnboarding:async()=>state,updateOnboarding:async(action:Action)=>{if(!online)throw Error('offline');if(action.action==='skip')state={...state,onboarding_completed:true,first_proof_coaching_completed:true};return state;}};
 const storage={read:async()=>disk,write:async(v:string)=>{disk=v;}};
 const c=new OnboardingController(api,storage);await c.load();c.start();c.finish(true);await settle();c.start();expect(c.snapshot.open).toBe(false);c.stop();
 online=true;const reopened=new OnboardingController(api,storage);await reopened.load();reopened.start();expect(reopened.snapshot.open).toBe(false);expect(state.onboarding_completed).toBe(true);expect(disk).toBe('[]');
});
it('does not enroll existing accounts or replay all steps for a future version',async()=>{
 for(const state of [{...fresh,onboarding_completed:true},{...fresh,current_version:2},{...fresh,onboarding_enrolled:false}]){const c=new OnboardingController({getOnboarding:async()=>state,updateOnboarding:async()=>state},{read:async()=>null,write:async()=>{}});await c.load();c.start();expect(c.snapshot.open).toBe(false);}
});
