import type {ConnectStatus} from '../ui/types';
import {approvalUrl} from './security';
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
const route='/app/records/connect/approve';
/** Resolve from current service state, never reuse an enrollment link after enrollment. */
export function currentApprovalPath(status:ConnectStatus, now=Date.now()):string {
 if(status.state==='revoked')throw Error('This installation was revoked. Use the recovery action before requesting a new approval.');
 if(!status.installationId){
  const enrollment=status.enrollment;
  if(!enrollment||enrollment.state!=='pending'||!validId(enrollment.id)||!Number.isFinite(Date.parse(enrollment.expiresAt))||Date.parse(enrollment.expiresAt)<=now)
   throw Error('Start a new browser approval request before opening its review. The earlier request is no longer pending.');
  return `${route}?${new URLSearchParams({enrollmentId:enrollment.id})}`;
 }
 if(!validId(status.installationId))throw Error('Refresh this installation before opening its approval.');
 const query=new URLSearchParams({installationId:status.installationId});
 if(status.preview){
  if(!validId(status.preview.id))throw Error('Create a valid secure preview before reviewing the shipment batch.');
  query.set('importId',status.preview.id);
 }else if(!status.pendingProposal&&!status.config){
  throw Error('No configuration is ready for browser review yet. Complete the shipping software name, version, time zone and start date, confirm the column matches, then select Request configuration approval.');
 }
 // Only a same-installation resume locator may preserve its action. Stale
 // enrollment/import IDs and arbitrary query parameters are never carried over.
 if(!status.preview&&!status.pendingProposal&&status.approvalPath){
  try{
   const previous=new URL(status.approvalPath,'https://packproof.local');
   if(previous.origin==='https://packproof.local'&&previous.pathname===route&&previous.searchParams.get('installationId')===status.installationId&&previous.searchParams.get('action')==='resume')query.set('action','resume');
  }catch{}
 }
 return `${route}?${query}`;
}
/** Submission failure must never open a stale review. Browser failure must not discard a saved proposal. */
export async function submitConfigurationForReview(submit:()=>Promise<ConnectStatus>,open:(url:string)=>Promise<void>,webOrigin:string):Promise<ConnectStatus>{
 const next=await submit();
 const target=approvalUrl(currentApprovalPath(next),webOrigin);
 try{await open(target);return next;}
 catch{return {...next,authorizationNotice:'Your configuration request was saved, but the browser could not open. Select Review in browser to reopen that saved request. Sign in there if asked; do not create a new enrollment.'};}
}
