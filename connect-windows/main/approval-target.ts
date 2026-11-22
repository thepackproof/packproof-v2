import type {ConnectStatus} from '../ui/types';
import {approvalUrl} from './security';
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
const route='/app/records/connect/approve';
export function installationReviewPath(scope:{installationId:string;organizationId:string;environment:string},facility=false):string {
 if(!validId(scope.installationId)||!validId(scope.organizationId)||!['sandbox','live'].includes(scope.environment))
   throw Error('Refresh this computer’s connection before opening its review.');
 const query=new URLSearchParams({installationId:scope.installationId,organizationId:scope.organizationId,environment:scope.environment});
 if(facility)query.set('intent','facility');
 return route+'?'+query;
}
export function enrollmentReviewPath(status:ConnectStatus,facility:boolean):string {
 const path=currentApprovalPath(status);
 return facility && !status.installationId ? path+'&intent=facility' : path;
}
export function workspaceParams(status: ConnectStatus): URLSearchParams {
 const params = new URLSearchParams();
 if (!status.binding?.organizationId) return params;
 if (!validId(status.binding.organizationId)) throw Error('Refresh the current workspace before opening this review.');
 const env = status.environment;
 if (!['development','staging','sandbox','live','production'].includes(env)) throw Error('Refresh the installation environment before opening this review.');
 params.set('organizationId',status.binding.organizationId);
 params.set('environment',env === 'live' || env === 'production' ? 'live' : 'sandbox');
 return params;
}

export function verifiedDetailPath(status: ConnectStatus, sourceId?: string): string {
 if (status.state === 'revoked' || status.state === 'permission_required' || status.transport?.state === 'forbidden' || status.transport?.state === 'unauthenticated')
   throw Error('This installation no longer has access.');
 const source = sourceId === undefined ? undefined : status.sourceSubscriptions?.find(item => item.id === sourceId);
 const id = sourceId === undefined ? status.verification?.recordId : source?.verifiedCaseId;
 const verified = sourceId === undefined ? status.verification?.complete
   : status.capabilities?.typedSourceSubscriptions && source && ['active','approved','paused'].includes(source.state)
     && source.lastErrorCode !== 'SOURCE_AUTHORIZATION_REQUIRED';
 if (!verified || !validId(id)) throw Error('Verify the completed record before opening it.');
 const scope = workspaceParams(status).toString();
 return `/app/${sourceId === undefined ? 'records' : 'cases'}/${id}${scope ? '?' + scope : ''}`;
}

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
 for (const [key,value] of workspaceParams(status)) query.set(key,value);
 const batchReview = status.setup?.running && status.setup.phase === 'batch_review';
 if(batchReview && !status.preview) throw Error('Wait for the current batch receipt before opening its review.');
 if(status.preview && (!status.setup?.running || batchReview)){
  if(!validId(status.preview.id))throw Error('Create a valid secure preview before reviewing the shipment batch.');
  query.set('importId',status.preview.id);
 }else if(!status.pendingProposal&&!status.config){
  throw Error('No configuration is ready for browser review yet. Review the selected shipment, then select Approve and connect.');
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
/** Source review is reconstructed from live protected service state. Renderer
 * callers choose a source ID, never a URL, file path or stale batch locator. */
export function currentSubscriptionApprovalPath(status:ConnectStatus, id:string):string {
 if(status.state==='revoked'||!validId(status.installationId)||!validId(id))throw Error('Refresh this installation before reviewing its source approval.');
 const source=status.sourceSubscriptions?.find(s=>s.id===id);
 if(!source||source.state==='revoked')throw Error('This source is unavailable for approval. Refresh its current state.');
 const query=new URLSearchParams({installationId:status.installationId,subscriptionId:id,configurationRevision:String(source.configurationRevision)});
 for (const [key,value] of workspaceParams(status)) query.set(key,value);
 if(source.verifiedCaseId&&source.receipt&&validId(source.receipt.id))query.set('initialBatchId',source.receipt.id);
 return `${route}?${query}`;
}
/** Reconstruct the exact manifest locator from current service state. */
export function currentBackfillApprovalPath(status:ConnectStatus,id:string,jobId:string):string {
 if(!validId(id)||!validId(jobId))throw Error('Refresh this installation before reviewing its historical import.');
 const source=status.sourceSubscriptions?.find(source=>source.id===id);
 const job=source?.backfillJobs?.find(job=>job.id===jobId);
 if(!source||!job||job.subscriptionId!==id||!validId(job.installationId)||!validId(job.organizationId)||!['sandbox','live'].includes(job.environment)||!Number.isSafeInteger(job.configurationRevision)||job.configurationRevision<1||!/^[a-f0-9]{64}$/.test(job.manifestSha256))throw Error('Refresh the exact retained historical import before opening its review.');
 // A retained job can be inspected after source revision or revocation. This
 // locator identifies its original approval, never authority to collect again.
 const query=new URLSearchParams({installationId:job.installationId,organizationId:job.organizationId,environment:job.environment,subscriptionId:id,configurationRevision:String(job.configurationRevision),backfillJobId:job.id,manifestSha256:job.manifestSha256});
 return `${route}?${query}`;
}
/** Submission failure must never open a stale review. Browser failure must not discard a saved proposal. */
export async function submitConfigurationForReview(submit:()=>Promise<ConnectStatus>,open:(url:string)=>Promise<void>,webOrigin:string):Promise<ConnectStatus>{
 const next=await submit();
 const target=approvalUrl(currentApprovalPath(next),webOrigin);
 try{await open(target);return next;}
 catch{return {...next,authorizationNotice:'Your configuration request was saved, but the browser could not open. Select Review in browser to reopen that saved request. Sign in there if asked; do not create a new enrollment.'};}
}
