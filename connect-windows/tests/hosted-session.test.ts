import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('electron',()=>({ipcMain:{handle:vi.fn()}}));
vi.mock('../main/human-dashboard',()=>({openHumanDashboard:vi.fn(async()=>{}),closeHumanDashboard:vi.fn()}));
import {HostedSession} from '../main/hosted-session';
import {openHumanDashboard} from '../main/human-dashboard';
import type {ConnectStatus} from '../ui/types';

const missing=Object.assign(Error('This workspace is unavailable.'),{status:404});
function fixture(locationId:string|null=null) {
  let user:string|null='user_test';
  let status:ConnectStatus={state:'source_selected',installationId:'installation_test',environment:'development',
    binding:{organizationId:'org_test',integrationAccountId:'account_test',operatorMembershipId:'member_test',locationId,sourceName:'Private source'},
    health:{serviceOnline:true,queueCount:4},source:{folder:'C:\\private',folderDigest:'a'.repeat(64),accessible:true},
    workspace:{phase:'draft',step:'order',sources:[]}};
  const human={user:()=>user,dashboardIdentity:vi.fn(),
    access:vi.fn(async()=>{if(locationId===null)throw missing;return{canConfigure:true,organizationId:'org_test',environment:'sandbox',locationId,userId:'user_test'};}),
    setupAccess:vi.fn(async()=>({installationId:'installation_test',organizationId:'org_test',environment:'sandbox',locationId,state:'setup',userId:'user_test'})),
    suggest:vi.fn(),review:vi.fn()};
  const host=new HostedSession(human,async()=>status,'https://example.test');
  return{host,human,get status(){return status;},setStatus:(next:ConnectStatus)=>{status=next;},setUser:(next:string|null)=>{user=next;}};
}
beforeEach(()=>vi.clearAllMocks());
describe('unified installation bootstrap and preserved-work recovery',()=>{
  it('offers setup for a null facility while withholding orders and source authority',async()=>{
    const f=fixture();
    expect(await f.host.choices()).toEqual({setup:true,orders:false});
    const access=await f.host.guard('getStatus');
    expect(access).toMatchObject({mode:'bootstrap',canConfigure:false,canReadOrders:false,offline:false});
    expect(f.host.present('getStatus',f.status,access)).toEqual({state:'source_selected',installationId:'installation_test',environment:'development',installedVersion:undefined,recoveryAvailable:false,
      setupAccess:{reason:'facility_required'},health:{serviceOnline:true,queueCount:null},workspace:{phase:'draft',step:'order',sources:[],canReadOrders:false}});
    for(const method of ['chooseWorkspaceFolder','getFacilityDraft','saveFacilityNotes','workspaceDraftPreview','replayFacilityDraft','activateWorkspace','suggest','openWorkspaceOutput'])
      await expect(f.host.guard(method)).rejects.toThrow();
    await expect(f.host.daily()).rejects.toThrow();
    await expect(f.host.guard('recoverEnrollment')).rejects.toThrow(/Review this installation/);
    expect(openHumanDashboard).not.toHaveBeenCalled();
    expect(f.human.suggest).not.toHaveBeenCalled();
  });
  it('authorizes only the exact revoked installation despite redacted native binding',async()=>{
    const f=fixture();f.setStatus({...f.status,binding:undefined,state:'revoked',recoveryAvailable:true});
    f.human.setupAccess.mockResolvedValue({...await f.human.setupAccess(),state:'revoked'});
    expect(await f.host.choices()).toEqual({setup:true,orders:false});
    expect(f.human.setupAccess).toHaveBeenLastCalledWith({installationId:'installation_test',environment:'sandbox'});
    const access=await f.host.guard('recoverEnrollment');
    expect(access.canRecover).toBe(true);
    expect(f.host.installationReviewPath(access)).toBe('/app/records/connect/approve?installationId=installation_test&organizationId=org_test&environment=sandbox&intent=facility');
    expect(f.host.present('getStatus',f.status,access)).toMatchObject({setupAccess:{reason:'reapproval_required'},recoveryAvailable:true});
  });
  it('keeps active facility behavior and never turns bootstrap into an offline draft lease',async()=>{
    const f=fixture('location_test');
    expect(await f.host.choices()).toEqual({setup:true,orders:true});
    await f.host.daily();expect(openHumanDashboard).toHaveBeenCalledTimes(1);
    expect(f.human.setupAccess).not.toHaveBeenCalled();
    const offline=new TypeError('fetch failed',{cause:{code:'ENETUNREACH'}});
    f.human.access.mockRejectedValue(offline);
    expect(await f.host.choices()).toEqual({setup:true,orders:false});
    await expect(f.host.daily()).rejects.toThrow();
    const unbound=fixture();await unbound.host.choices();unbound.human.access.mockRejectedValue(offline);
    await expect(unbound.host.guard('saveFacilityNotes')).rejects.toThrow();
    await expect(unbound.host.choices()).rejects.toThrow();
  });
  it.each([401,403,500])('never falls back from an explicit %s full-access failure',async status=>{
    const f=fixture('location_test');f.human.access.mockRejectedValue(Object.assign(Error('denied'),{status}));
    await expect(f.host.choices()).rejects.toThrow('denied');
    expect(f.human.setupAccess).not.toHaveBeenCalled();
  });
  it('rejects another administrator result, facility drift, and unauthenticated entry',async()=>{
    for(const change of [{installationId:'other'},{userId:'other'},{organizationId:'other'},{environment:'live'},{locationId:'other'}]){
      const f=fixture();f.human.setupAccess.mockResolvedValue({...await f.human.setupAccess(),...change});
      await expect(f.host.guard('getStatus')).rejects.toThrow(/workspace changed/);
    }
    const f=fixture();f.setUser(null);await expect(f.host.choices()).rejects.toThrow(/Sign in/);expect(f.human.setupAccess).not.toHaveBeenCalled();
  });
  it('rejects account changes and same-account session replacement during the admin check',async()=>{
    for(const replace of [false,true]){
      const f=fixture(),result=await f.human.setupAccess();
      f.human.setupAccess.mockImplementation(async()=>{if(replace)f.host.close();else f.setUser('user_other');return result;});
      await expect(f.host.guard('getStatus')).rejects.toThrow(/session changed/);
    }
  });
  it('accepts explicit archive recovery only from authorized recoverable state',async()=>{
    const f=fixture();f.setStatus({...f.status,binding:undefined,state:'permission_required',recoveryAvailable:true});
    const started=await f.host.guard('recoverEnrollment');
    f.setStatus({state:'needs_approval',environment:'development',health:{serviceOnline:true,queueCount:0}});
    const ended=await f.host.guard('getStatus');
    expect(()=>f.host.assertTransition('recoverEnrollment',started,ended)).not.toThrow();
    expect(f.host.present('recoverEnrollment',f.status,ended)).toMatchObject({setupAccess:{reason:'enrollment_required'}});
    expect(()=>f.host.assertTransition('getStatus',started,ended)).toThrow();
    await expect(f.host.guard('recoverEnrollment')).rejects.toThrow();
  });
  it.each(['pollEnrollment','getStatus','refresh'])('accepts %s only when the exact pending enrollment becomes the authorized installation',async method=>{
    const f=fixture('location_test'),enrollment={id:'enrollment_test',state:'pending',comparisonCode:'TESTCODE',expiresAt:'2099-01-01T00:00:00Z'};
    const installed={...f.status,enrollment:{...enrollment,state:'acknowledged'}};
    f.setStatus({state:'needs_approval',environment:'development',enrollment,health:{serviceOnline:true,queueCount:0}});
    const started=await f.host.guard(method);
    f.setStatus(installed);const ended=await f.host.guard(method);
    expect(()=>f.host.assertTransition(method,started,ended)).not.toThrow();
    expect(()=>f.host.assertTransition('chooseWorkspaceFolder',started,ended)).toThrow();
    expect(()=>f.host.assertTransition(method,started,{...ended,enrollmentId:'different'})).toThrow();
    f.host.close();expect(()=>f.host.assertTransition(method,started,ended)).toThrow(/account changed/);
  });
  it('rejects unrelated binding changes and mismatched native status after a successful check',async()=>{
    const f=fixture('location_test'),started=await f.host.guard('getStatus');
    const ended={...started,scopeKey:'different'};
    expect(()=>f.host.assertTransition('getStatus',started,ended)).toThrow(/workspace changed/);
    expect(()=>f.host.present('getStatus',{...f.status,installationId:'other'},started)).toThrow(/installation changed/);
  });
});
