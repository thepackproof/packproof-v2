import {describe,it,expect,vi} from 'vitest';
import {verifiedDetailPath,currentApprovalPath,submitConfigurationForReview} from '../main/approval-target';
import type {ConnectStatus,Configuration} from '../ui/types';
const base:ConnectStatus={state:'source_selected',environment:'development',installationId:'install-123',health:{serviceOnline:true,queueCount:0},approvalPath:'/app/records/connect/approve?enrollmentId=used-up'};
const config={folderDigest:'folder',sourceName:'test',mapping:{shipmentReference:'Reference'},timeZone:'America/New_York',importValidRows:false,offlineWindowHours:24} satisfies Configuration;
const origin='https://approved.example';
describe('stage-correct browser review',()=>{
 it('does not open an old enrollment before a configuration request exists',()=>expect(()=>currentApprovalPath(base)).toThrow('Approve and connect'));
 it('uses the current installation for a pending configuration instead of stale enrollment',()=>expect(currentApprovalPath({...base,pendingProposal:config})).toBe('/app/records/connect/approve?installationId=install-123'));
 it('uses the current import receipt rather than a stale previous receipt',()=>expect(currentApprovalPath({...base,config,preview:{id:'import-new'} as ConnectStatus['preview'],approvalPath:'/app/records/connect/approve?installationId=install-old&importId=import-old'})).toBe('/app/records/connect/approve?installationId=install-123&importId=import-new'));
 it('opens only a live pending enrollment before the computer is enrolled',()=>{const s={...base,installationId:undefined,enrollment:{id:'enroll-new',state:'pending',expiresAt:'2030-01-01T00:00:00Z',comparisonCode:'123456'}};expect(currentApprovalPath(s,Date.parse('2026-11-13'))).toBe('/app/records/connect/approve?enrollmentId=enroll-new');expect(()=>currentApprovalPath(s,Date.parse('2031-01-01'))).toThrow('no longer pending');});
 it('rejects completed or malformed enrollment state',()=>{for(const state of ['credential','denied','expired'])expect(()=>currentApprovalPath({...base,installationId:undefined,enrollment:{id:'e',state,expiresAt:'2030-01-01',comparisonCode:'123'}})).toThrow();});
 it('rejects invalid installation and receipt identifiers',()=>{expect(()=>currentApprovalPath({...base,installationId:'//other.example',config})).toThrow();expect(()=>currentApprovalPath({...base,preview:{id:'x&token=secret'} as ConnectStatus['preview']})).toThrow();});
 it('preserves only a same-installation resume action',()=>{expect(currentApprovalPath({...base,config,approvalPath:'/app/records/connect/approve?installationId=install-123&action=resume&token=private'})).toBe('/app/records/connect/approve?installationId=install-123&action=resume');expect(currentApprovalPath({...base,config,approvalPath:'https://evil.example/app/records/connect/approve?installationId=install-123&action=resume'})).not.toContain('action=resume');});
 it('does not substitute a resume request for a pending configuration',()=>expect(currentApprovalPath({...base,pendingProposal:config,approvalPath:'/app/records/connect/approve?installationId=install-123&action=resume'})).not.toContain('action='));
 it('refuses reviews from revoked installations',()=>expect(()=>currentApprovalPath({...base,config,state:'revoked'})).toThrow('revoked'));
 it('opens the browser only after configuration has been saved',async()=>{const order:string[]=[];const submit=async()=>{order.push('saved');return {...base,pendingProposal:config};};await submitConfigurationForReview(submit,async url=>{order.push('opened');expect(url).toBe(origin+'/app/records/connect/approve?installationId=install-123');},origin);expect(order).toEqual(['saved','opened']);});
 it('never opens a browser when submission fails',async()=>{const open=vi.fn();await expect(submitConfigurationForReview(async()=>{throw Error('CLOCK_UNCERTAIN');},open,origin)).rejects.toThrow('CLOCK_UNCERTAIN');expect(open).not.toHaveBeenCalled();});
 it('keeps the saved proposal when opening the browser fails',async()=>{const next=await submitConfigurationForReview(async()=>({...base,pendingProposal:config}),async()=>{throw Error('browser unavailable');},origin);expect(next.pendingProposal).toEqual(config);expect(next.authorizationNotice).toContain('was saved');});
});

it('retains the exact guided batch and workspace across browser review',()=>{
 const status:ConnectStatus={...base, config, binding:{organizationId:'org-17',sourceName:'Shipping',integrationAccountId:'int',operatorMembershipId:'user',locationId:null}, setup:{running:true,phase:'batch_review'},preview:{id:'batch-8'} as ConnectStatus['preview']};
 const params=new URL(currentApprovalPath(status),origin).searchParams;
 expect(Object.fromEntries(params)).toEqual({installationId:'install-123',organizationId:'org-17',environment:'sandbox',importId:'batch-8'});
 expect(()=>currentApprovalPath({...status,preview:undefined})).toThrow('current batch receipt');
 expect(currentApprovalPath({...status,setup:{running:true,phase:'permission_review'}})).not.toContain('importId=');
});

it('opens a verified source case on the portal case route and refuses a revoked source',()=>{
 const source={id:'source-5',state:'active',verifiedCaseId:'case-7'} as NonNullable<ConnectStatus['sourceSubscriptions']>[number];
 const status={...base,capabilities:{sourceContracts:[],rulesVersion:'v2',typedSourceSubscriptions:true},sourceSubscriptions:[source]};
 expect(verifiedDetailPath(status,source.id)).toBe('/app/cases/case-7');
 expect(()=>verifiedDetailPath({...status,sourceSubscriptions:[{...source,state:'revoked'}]},source.id)).toThrow();
 expect(()=>verifiedDetailPath(status,'another-source')).toThrow();
 expect(()=>verifiedDetailPath({...status,capabilities:undefined},source.id)).toThrow();
 expect(()=>verifiedDetailPath({...status,sourceSubscriptions:[{...source,lastErrorCode:'SOURCE_AUTHORIZATION_REQUIRED'}]},source.id)).toThrow();
 expect(()=>verifiedDetailPath({...status,state:'permission_required'},source.id)).toThrow();
});
