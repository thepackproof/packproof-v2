import {describe,expect,it} from 'vitest';
import {FacilityDraftLease,isOfflineTransport,type FacilityBinding} from '../main/facility-draft-lease';

const binding:FacilityBinding={user:'owner',installationId:'device',organizationId:'org',environment:'sandbox',locationId:'west',
  operatorMembershipId:'operator',integrationAccountId:'erp'};
const offline=new TypeError('fetch failed',{cause:{code:'ENETUNREACH'}});
describe('signed-in facility draft during a network outage',()=>{
  it('allows local notes only and expires without extending on offline calls',()=>{
    let now=0;const lease=new FacilityDraftLease(()=>now);
    expect(lease.allows(binding,'saveFacilityNotes',offline)).toBe(false);
    lease.observe(binding,true);now=599999;
    expect(lease.allows(binding,'saveFacilityNotes',offline)).toBe(true);
    for(const op of ['saveFacilityDraft','chooseWorkspaceFolder','workspaceDraftPreview','replayFacilityDraft','suggest','openWorkspaceOutput','daily','activateWorkspace'])
      expect(lease.allows(binding,op,offline)).toBe(false);
    now=600000;expect(lease.allows(binding,'getFacilityDraft',offline)).toBe(false);
  });
  it('clears on explicit denial, revocation, session change or facility change',()=>{
    const lease=new FacilityDraftLease();
    for (const error of [{name:'TypeError',status:403,cause:{code:'ENETUNREACH'}},new Error('forbidden'),{status:401}]) {
      lease.observe(binding,true);expect(lease.allows(binding,'getStatus',error)).toBe(false);
      expect(lease.allows(binding,'saveFacilityNotes',offline)).toBe(false);
    }
    for(const key of Object.keys(binding) as (keyof FacilityBinding)[]){
      lease.observe(binding,true);expect(lease.allows({...binding,[key]:'other'},'getFacilityDraft',offline)).toBe(false);
      expect(lease.allows(binding,'getFacilityDraft',offline)).toBe(false);
    }
    lease.observe(binding,true);lease.clear();expect(lease.allows(binding,'getFacilityDraft',offline)).toBe(false);
    lease.observe(binding,false);expect(lease.allows(binding,'getFacilityDraft',offline)).toBe(false);
    expect(isOfflineTransport(new TypeError('invalid response'))).toBe(false);
  });
});
