import {expect,it,vi} from 'vitest';
import {OnboardingController,selectFirstExperience,type OnboardingState,type Action} from '../../packages/onboarding/model.js';
const fresh:OnboardingState={onboarding_completed:false,onboarding_version:0,first_proof_coaching_completed:false,onboarding_last_step:2,onboarding_enrolled:true,current_version:1,first_proof_id:null,first_proof_completed:false,first_experience_version:1,automatic_tour:false,activation_status:'NOT_ACTIVATED',first_finalized_packing_proof_id:null,first_finalized_packing_at:null};
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
it('never starts automatic guidance by default and keeps voluntary replay free of first-run writes',async()=>{
 const updateOnboarding=vi.fn(async()=>({...fresh}));const c=new OnboardingController({getOnboarding:async()=>({...fresh}),updateOnboarding},{read:async()=>null,write:async()=>{}});
 c.start();expect(c.snapshot.open).toBe(false);await c.load();c.start();c.viewed();c.finish(true);await settle();
 expect(c.snapshot.open).toBe(false);expect(updateOnboarding).not.toHaveBeenCalled();
 c.start(true);expect(c.snapshot).toMatchObject({open:true,replay:true,step:0});c.viewed();c.move(1);c.finish();await settle();
 expect(updateOnboarding).not.toHaveBeenCalled();expect(c.snapshot.state?.first_proof_coaching_completed).toBe(false);
});
it('reconciles persisted legacy skip while preserving dismissal across rollback and replay',async()=>{
 let state={...fresh};let disk=JSON.stringify([{action:'skip',version:1,step:2}]);
 const c=new OnboardingController({getOnboarding:async()=>state,updateOnboarding:async(action:Action)=>{if(action.action==='skip')state={...state,onboarding_completed:true,first_proof_coaching_completed:true};return state;}},{read:async()=>disk,write:async(value)=>{disk=value;}},{autoTourEnabled:true});
 await c.load();c.start();expect(c.snapshot.open).toBe(false);expect(disk).toBe('[]');
 expect(selectFirstExperience(c.snapshot.state)).toMatchObject({status:'FIRST_PROOF',guidanceDismissed:true});
 c.start(true);c.finish();expect(c.snapshot.state?.first_proof_coaching_completed).toBe(true);
});
it('allows the compatible rollback tour only for an explicitly enabled eligible account',async()=>{
 const c=new OnboardingController({getOnboarding:async()=>({...fresh}),updateOnboarding:async()=>({...fresh})},{read:async()=>null,write:async()=>{}},{autoTourEnabled:true});await c.load();c.start();expect(c.snapshot).toMatchObject({open:true,replay:false,step:2});
});
it('keeps offline dismissed guidance suppressed after reopen even while account history can refresh',async()=>{
 let disk=JSON.stringify([{action:'dismiss_coaching',version:1}]);
 const c=new OnboardingController({getOnboarding:async()=>({...fresh}),updateOnboarding:async()=>{throw Error('offline write');}},{read:async()=>disk,write:async(value)=>{disk=value;}});
 await c.load();expect(selectFirstExperience(c.snapshot.state)).toMatchObject({status:'FIRST_PROOF',guidanceDismissed:true});
 await c.refresh();expect(c.snapshot.state?.first_proof_coaching_completed).toBe(true);expect(JSON.parse(disk)).toHaveLength(1);
});
it('requires settled compatible authoritative history; tutorial completion and errors never manufacture activation',()=>{
 expect(selectFirstExperience(null).status).toBe('UNKNOWN');
 expect(selectFirstExperience({...fresh,first_experience_version:undefined}).status).toBe('UNKNOWN');
 expect(selectFirstExperience(fresh,true).status).toBe('UNKNOWN');
 expect(selectFirstExperience({...fresh,onboarding_completed:true,first_proof_completed:true}).status).toBe('FIRST_PROOF');
 expect(selectFirstExperience({...fresh,activation_status:'ACTIVATED'}).status).toBe('UNKNOWN');
 expect(selectFirstExperience({...fresh,activation_status:'ACTIVATED',first_finalized_packing_proof_id:'proof_actual',first_finalized_packing_at:'2026-10-11T11:00:00Z'})).toMatchObject({status:'ACTIVE',firstFinalizedProofId:'proof_actual'});
});
