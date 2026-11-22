import {describe,expect,it,vi} from 'vitest';
import {HostedSession} from '../main/hosted-session';
import {enrollmentReviewPath} from '../main/approval-target';
import type {ConnectStatus} from '../ui/types';
vi.mock('electron',()=>({ipcMain:{handle:vi.fn()}}));
vi.mock('../main/human-dashboard',()=>({openHumanDashboard:vi.fn(),closeHumanDashboard:vi.fn()}));

const prior='a'.repeat(64),next='b'.repeat(64);
const ids={installationId:'computer-1',organizationId:'org-1',environment:'sandbox'};
function fixture(fresh=false) {
  const details={...ids,userId:'admin',state:'setup',locationId:null,pendingFileReview:{
    fileName:'dispatch.csv',proposalSha256:prior,expiresAt:new Date(Date.now()+(fresh?60_000:-60_000)).toISOString()}};
  let user='admin';
  const current={installationId:ids.installationId,environment:'development',state:'needs_approval',
    binding:{organizationId:ids.organizationId,locationId:null},health:{serviceOnline:true}} as ConnectStatus;
  const human={user:()=>user,access:vi.fn(async()=>{throw Object.assign(Error('This workspace is unavailable.'),{status:404});}),setupAccess:vi.fn(async()=>structuredClone(details)),
    dashboardIdentity:vi.fn(),suggest:vi.fn(),review:vi.fn()};
  const session=new HostedSession(human,async()=>current,'https://example.test');
  const renewed={...ids,proposalSha256:next,approvalPath:'https://untrusted.invalid'};
  const renew=vi.fn(async()=>{
    details.pendingFileReview={fileName:'dispatch.csv',proposalSha256:next,expiresAt:new Date(Date.now()+60_000).toISOString()};
    return renewed;
  });
  const open=vi.fn(async(_path:string)=>{});
  const changeUser=()=>{user='other';};
  return {details,session,current,human,renew,renewed,open,changeUser};
}
const input={wholeFileUploadApproved:true,expectedProposalSha256:prior};
describe('saved shipment review in an installation without a named facility',()=>{
  it('reopens a fresh exact admin review after restart without invoking any native file operation',async()=>{
    const f=fixture(true);
    const start=await f.session.guard('refreshPendingFileReview');
    expect(f.session.present('getStatus',f.current,start)).toMatchObject({setupAccess:{pendingFileReview:f.details.pendingFileReview}});
    await expect(f.session.openPendingFileReview(start,{...input,wholeFileUploadApproved:false},f.renew,f.open))
      .resolves.toStrictEqual({proposalSha256:prior});
    expect(f.renew).not.toHaveBeenCalled();
    expect(f.human.setupAccess).toHaveBeenCalledTimes(2);
    expect(f.open).toHaveBeenCalledWith('/app/records/connect/approve?installationId=computer-1&organizationId=org-1&environment=sandbox');
    expect(f.session.installationReviewPath(start)).toContain('&intent=facility');
  });
  it('checks current native and administrator identities before opening the new verified proposal',async()=>{
    const f=fixture(),start=await f.session.guard('refreshPendingFileReview');
    await expect(f.session.openPendingFileReview(start,input,f.renew,f.open))
      .resolves.toStrictEqual({proposalSha256:next});
    expect(f.renew).toHaveBeenCalledExactlyOnceWith({...input,...ids});
    expect(f.human.setupAccess).toHaveBeenCalledTimes(2);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.open.mock.calls[0][0]).not.toContain('untrusted');
  });
  it('refuses an expired or replaced request without consent and unrelated native methods',async()=>{
    const f=fixture(),start=await f.session.guard('refreshPendingFileReview');
    await expect(f.session.openPendingFileReview(start,{...input,wholeFileUploadApproved:false},f.renew,f.open)).rejects.toThrow();
    await expect(f.session.openPendingFileReview(start,{...input,expectedProposalSha256:next},f.renew,f.open)).rejects.toThrow();
    await expect(f.session.guard('previewLocal')).rejects.toThrow();
    expect(f.renew).not.toHaveBeenCalled();expect(f.open).not.toHaveBeenCalled();
  });
  it('returns no receipt when the browser cannot open the verified review',async()=>{
    const f=fixture(true),start=await f.session.guard('refreshPendingFileReview');
    f.open.mockRejectedValueOnce(new Error('Browser unavailable'));
    await expect(f.session.openPendingFileReview(start,{...input,wholeFileUploadApproved:false},f.renew,f.open))
      .rejects.toThrow('Browser unavailable');
    expect(f.renew).not.toHaveBeenCalled();
  });
  it.each(['digest','account','freshness','revocation','scope','filename'])('refuses to open when the new admin read disagrees on %s',async what=>{
    const f=fixture(),start=await f.session.guard('refreshPendingFileReview');
    const mutate=async()=>{
      const res=await f.renew();
      if(what==='digest')f.details.pendingFileReview.proposalSha256=prior;
      if(what==='account')f.changeUser();
      if(what==='freshness')f.details.pendingFileReview.expiresAt=new Date(Date.now()-10_000).toISOString();
      if(what==='revocation')f.details.state='revoked';
      if(what==='scope')res.organizationId='other';
      if(what==='filename')f.details.pendingFileReview.fileName='another.csv';
      return res;
    };
    await expect(f.session.openPendingFileReview(start,input,mutate,f.open)).rejects.toThrow();
    expect(f.open).not.toHaveBeenCalled();
  });
  it('only marks a hosted pending enrollment as facility setup',()=>{
    const pending={state:'needs_approval',environment:'development',enrollment:{id:'enroll-1',state:'pending',expiresAt:new Date(Date.now()+60_000).toISOString()}} as ConnectStatus;
    expect(enrollmentReviewPath(pending,true)).toBe('/app/records/connect/approve?enrollmentId=enroll-1&intent=facility');
    expect(enrollmentReviewPath(pending,false)).toBe('/app/records/connect/approve?enrollmentId=enroll-1');
  });
});
