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
  const read=vi.fn(async(_operation:string)=>status);
  const host=new HostedSession(human,read,'https://example.test');
  return{host,human,read,get status(){return status;},setStatus:(next:ConnectStatus)=>{status=next;},setUser:(next:string|null)=>{user=next;}};
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

function assignedFacility() {
  const f=fixture();
  f.setStatus({...f.status,configRevision:0,transport:{state:'compatible',expectedRulesVersion:'v1'}});
  const assigned={...f.status,binding:{...f.status.binding!,locationId:'location_test'}};
  f.human.access.mockResolvedValue({canConfigure:true,organizationId:'org_test',environment:'sandbox',locationId:'location_test',userId:'user_test'});
  f.human.setupAccess.mockResolvedValue({installationId:'installation_test',organizationId:'org_test',environment:'sandbox',locationId:'location_test',state:'ready',userId:'user_test'});
  f.read.mockImplementation(async operation=>{if(operation==='refresh')f.setStatus(assigned);return f.status;});
  return {f,assigned};
}
describe('one-time initial facility synchronization',()=>{
  it.each(['choices','getStatus','getWorkspaceStatus','pollEnrollment','refresh'])('refreshes %s through the protected service before granting the exact newly assigned facility',async method=>{
    const {f}=assignedFacility();
    const access=await f.host.guard(method);
    expect(access).toMatchObject({mode:'facility',canConfigure:true,canReadOrders:true,offline:false,
      scope:{installationId:'installation_test',organizationId:'org_test',environment:'sandbox',locationId:'location_test',operatorMembershipId:'member_test',integrationAccountId:'account_test'}});
    expect(f.read.mock.calls.map(([operation])=>operation)).toEqual(['status','refresh','status']);
    expect(f.human.access).toHaveBeenCalledTimes(2);
    expect(f.human.setupAccess).toHaveBeenCalledWith({installationId:'installation_test',organizationId:'org_test',environment:'sandbox'});
    expect(await f.host.workspaceAccess()).toMatchObject({scope:{locationId:'location_test'}});
  });
  it('refreshes a verified administrator assignment without inventing a human order grant when the facility is unavailable',async()=>{
    const {f}=assignedFacility();f.human.access.mockRejectedValue(missing);
    const access=await f.host.guard('getWorkspaceStatus');
    expect(access).toMatchObject({mode:'bootstrap',canReadOrders:false,canConfigure:false});
    expect(f.host.present('getWorkspaceStatus',f.status,access)).toMatchObject({setupAccess:{reason:'facility_unavailable'}});
    expect(f.read.mock.calls.filter(([operation])=>operation==='refresh')).toHaveLength(1);
    await expect(f.host.workspaceAccess()).rejects.toThrow();
    await expect(f.host.guard('chooseWorkspaceFolder')).rejects.toThrow();
  });
  it.each(['chooseWorkspaceFolder','saveFacilityDraft','workspaceOrderDetail','daily','refreshPendingFileReview'])('does not use %s to apply a facility transition',async method=>{
    const {f}=assignedFacility();
    await expect(f.host.guard(method)).rejects.toThrow('workspace changed');
    expect(f.read.mock.calls.map(([operation])=>operation)).toEqual(['status']);
    expect(f.human.setupAccess).not.toHaveBeenCalled();
  });
  it('requires matching current human and administrator observations before refreshing',async()=>{
    for(const change of [{installationId:'other'},{userId:'other'},{organizationId:'other'},{environment:'live'},
      {locationId:null},{locationId:'other'},{state:'revoked'},{state:'active'}]) {
      const {f}=assignedFacility(),setup=await f.human.setupAccess();
      f.human.setupAccess.mockResolvedValue({...setup,...change});
      await expect(f.host.guard('getWorkspaceStatus')).rejects.toThrow('workspace changed');
      expect(f.read.mock.calls.map(([operation])=>operation)).toEqual(['status']);
    }
  });
  it('does not rebind an assigned or configured installation, a reader, or a denied local connection',async()=>{
    for(const scenario of ['assigned','configured','reader','denied','recovery'] as const) {
      const {f}=assignedFacility();
      if(scenario==='assigned')f.setStatus({...f.status,binding:{...f.status.binding!,locationId:'previous_location'}});
      if(scenario==='configured')f.setStatus({...f.status,configRevision:1});
      if(scenario==='reader')f.human.access.mockResolvedValue({canConfigure:false,organizationId:'org_test',environment:'sandbox',locationId:'location_test',userId:'user_test'});
      if(scenario==='denied')f.setStatus({...f.status,transport:{state:'forbidden',expectedRulesVersion:'v1'}});
      if(scenario==='recovery')f.setStatus({...f.status,recoveryAvailable:true});
      await expect(f.host.guard('getWorkspaceStatus')).rejects.toThrow('workspace changed');
      expect(f.read.mock.calls.map(([operation])=>operation)).toEqual(['status']);
    }
  });
  it('rejects a heartbeat that does not preserve the complete approved binding and safe initial state',async()=>{
    const changes: Array<(status:ConnectStatus)=>ConnectStatus>=[
      status=>({...status,binding:{...status.binding!,locationId:null}}),
      status=>({...status,binding:{...status.binding!,locationId:'other_location'}}),
      status=>({...status,binding:{...status.binding!,organizationId:'other_org'}}),
      status=>({...status,binding:{...status.binding!,operatorMembershipId:'other_member'}}),
      status=>({...status,binding:{...status.binding!,integrationAccountId:'other_account'}}),
      status=>({...status,installationId:'other_installation'}),
      status=>({...status,environment:'live'}),
      status=>({...status,enrollment:{id:'other_enrollment',state:'acknowledged',comparisonCode:'CODE',expiresAt:'2099-01-01T00:00:00Z'}}),
      status=>({...status,state:'revoked'}),
      status=>({...status,state:'permission_required'}),
      status=>({...status,transport:{state:'forbidden',expectedRulesVersion:'v1'}}),
      status=>({...status,transport:{state:'unreachable',expectedRulesVersion:'v1'}}),
      status=>({...status,health:{serviceOnline:false,queueCount:null}}),
      status=>({...status,configRevision:1})
    ];
    for(const change of changes) {
      const {f,assigned}=assignedFacility();
      f.read.mockImplementation(async operation=>{if(operation==='refresh')f.setStatus(change(assigned));return f.status;});
      await expect(f.host.guard('getWorkspaceStatus')).rejects.toThrow('workspace changed');
      expect(f.human.access).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects an account or session change during the heartbeat and never creates an offline grant after a failed refresh',async()=>{
    for(const replace of [false,true]) {
      const {f,assigned}=assignedFacility();
      f.read.mockImplementation(async operation=>{
        if(operation==='refresh'){f.setStatus(assigned);if(replace)f.host.close();else f.setUser('other_user');}
        return f.status;
      });
      await expect(f.host.guard('getWorkspaceStatus')).rejects.toThrow('session changed');
      expect(f.human.access).toHaveBeenCalledTimes(1);
    }
    const {f}=assignedFacility(),offline=new TypeError('fetch failed',{cause:{code:'ENETUNREACH'}});
    f.read.mockImplementation(async operation=>{if(operation==='refresh')throw offline;return f.status;});
    await expect(f.host.guard('getWorkspaceStatus')).rejects.toThrow('fetch failed');
    f.human.access.mockRejectedValue(offline);
    await expect(f.host.guard('saveFacilityNotes')).rejects.toThrow('fetch failed');
  });
});
