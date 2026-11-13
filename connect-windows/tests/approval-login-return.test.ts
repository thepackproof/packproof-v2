import {describe,it,expect} from 'vitest';
import {currentApprovalPath} from '../main/approval-target';
import {rememberConnectApprovalReturn,consumeConnectApprovalReturn} from '../../web/src/auth/connect-approval-return';
import type {ConnectStatus,Configuration} from '../ui/types';
describe('desktop review locators survive the web login return contract',()=>{
 for(const stage of ['configuration','batch','resume'] as const)it(`preserves ${stage} review across login without an enrollment locator`,()=>{
  const config={folderDigest:'folder',sourceName:'Test',mapping:{},timeZone:'UTC',importValidRows:false,offlineWindowHours:24} satisfies Configuration;
  const status:ConnectStatus={state:'source_selected',environment:'development',installationId:'installation-current',health:{serviceOnline:true,queueCount:0},approvalPath:'/app/records/connect/approve?enrollmentId=expired',...(stage==='configuration'?{pendingProposal:config}:{config}),...(stage==='batch'?{preview:{id:'import-current'} as ConnectStatus['preview']}:{})};
  if(stage==='resume')status.approvalPath='/app/records/connect/approve?installationId=installation-current&action=resume';
  const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
  const destination=currentApprovalPath(status);rememberConnectApprovalReturn(destination,storage);
  expect(consumeConnectApprovalReturn(storage)).toBe(destination);expect(destination).not.toContain('enrollmentId');expect(values.size).toBe(0);
 });
});
