import {describe,expect,it,vi} from 'vitest';
import {HostedSession} from '../main/hosted-session';
import {enrollmentReviewPath} from '../main/approval-target';
import type {ConnectStatus} from '../ui/types';
vi.mock('electron',()=>({ipcMain:{handle:vi.fn()}}));
vi.mock('../main/human-dashboard',()=>({openHumanDashboard:vi.fn(),closeHumanDashboard:vi.fn()}));

const prior='a'.repeat(64);
const ids={installationId:'computer-1',organizationId:'org-1',environment:'sandbox'};
function fixture(fresh=false) {
  const details={...ids,userId:'admin',state:'setup',locationId:null,pendingFileReview:{
    fileName:'dispatch.csv',proposalSha256:prior,expiresAt:new Date(Date.now()+(fresh?60_000:-60_000)).toISOString()}};
  let user='admin';
  const current={installationId:ids.installationId,environment:'development',state:'needs_approval',
    binding:{organizationId:ids.organizationId,locationId:null},health:{serviceOnline:true,queueCount:4}} as ConnectStatus;
  const human={user:()=>user,access:vi.fn(async()=>{throw Object.assign(Error('This workspace is unavailable.'),{status:404});}),setupAccess:vi.fn(async()=>structuredClone(details)),
    dashboardIdentity:vi.fn(),suggest:vi.fn(),review:vi.fn()};
  const read=vi.fn(async()=>current);
  const session=new HostedSession(human,read,'https://example.test');
  const renew=vi.fn(async()=>{throw Error('A report must not be read or renewed before facility binding.');});
  const open=vi.fn(async(_path:string)=>{});
  const changeUser=()=>{user='other';};
  return {details,session,current,human,read,renew,open,changeUser};
}
const input={wholeFileUploadApproved:true,expectedProposalSha256:prior};
describe('saved shipment facts for an installation without a named facility',()=>{
  it.each([false,true])('rejects an older renderer request before file I/O or browser approval (current review: %s)',async fresh=>{
    const f=fixture(fresh),before=structuredClone(f.current);
    const start=await f.session.guard('refreshPendingFileReview');
    expect(f.session.present('getStatus',f.current,start)).toMatchObject({
      setupAccess:{reason:'facility_required',pendingFileReview:f.details.pendingFileReview},health:{queueCount:null},
    });
    for(const consent of [false,true])
      await expect(f.session.openPendingFileReview(start,{...input,wholeFileUploadApproved:consent},f.renew,f.open))
        .rejects.toThrow('Choose this computer’s facility before starting a new source review.');
    expect(f.renew).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledExactlyOnceWith('status');
    expect(f.current).toStrictEqual(before);
    expect(f.session.installationReviewPath(start)).toBe('/app/records/connect/approve?installationId=computer-1&organizationId=org-1&environment=sandbox&intent=facility');
  });
  it('rejects a replaced digest and unrelated source methods without native work',async()=>{
    const f=fixture(),start=await f.session.guard('refreshPendingFileReview');
    await expect(f.session.openPendingFileReview(start,{...input,expectedProposalSha256:'b'.repeat(64)},f.renew,f.open))
      .rejects.toThrow('The saved file review changed.');
    await expect(f.session.guard('previewLocal')).rejects.toThrow();
    expect(f.renew).not.toHaveBeenCalled();expect(f.open).not.toHaveBeenCalled();
  });
  it.each(['account','session'] as const)('rejects a retained request after the %s changes',async change=>{
    const f=fixture(),start=await f.session.guard('refreshPendingFileReview');
    if(change==='account')f.changeUser();else f.session.close();
    await expect(f.session.openPendingFileReview(start,input,f.renew,f.open)).rejects.toThrow('The saved file review changed.');
    expect(f.renew).not.toHaveBeenCalled();expect(f.open).not.toHaveBeenCalled();
    expect(()=>f.session.installationReviewPath(start)).toThrow();
  });
  it.each(['revoked','permission_required'] as const)('withholds retained report metadata after local %s',async state=>{
    const f=fixture();f.current.state=state;
    const start=await f.session.guard('refreshPendingFileReview');
    expect((f.session.present('getStatus',f.current,start) as ConnectStatus).setupAccess?.pendingFileReview).toBeUndefined();
    await expect(f.session.openPendingFileReview(start,input,f.renew,f.open)).rejects.toThrow('The saved file review changed.');
    expect(f.renew).not.toHaveBeenCalled();expect(f.open).not.toHaveBeenCalled();
  });
  it('does not expose an unverified filename as saved report metadata',async()=>{
    const f=fixture();f.details.pendingFileReview.fileName='../another.csv';
    const start=await f.session.guard('refreshPendingFileReview');
    expect((f.session.present('getStatus',f.current,start) as ConnectStatus).setupAccess?.pendingFileReview).toBeUndefined();
    await expect(f.session.openPendingFileReview(start,input,f.renew,f.open)).rejects.toThrow();
    expect(f.renew).not.toHaveBeenCalled();expect(f.open).not.toHaveBeenCalled();
  });
  it('only marks a hosted pending enrollment as facility setup',()=>{
    const pending={state:'needs_approval',environment:'development',enrollment:{id:'enroll-1',state:'pending',expiresAt:new Date(Date.now()+60_000).toISOString()}} as ConnectStatus;
    expect(enrollmentReviewPath(pending,true)).toBe('/app/records/connect/approve?enrollmentId=enroll-1&intent=facility');
    expect(enrollmentReviewPath(pending,false)).toBe('/app/records/connect/approve?enrollmentId=enroll-1');
  });
});
