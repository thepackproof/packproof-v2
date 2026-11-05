import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import {buildProofRecoverySnapshot,enqueueRecoveryEvent} from '../domain/recovery-journal.js';
import {strictBody,reauthorizePartner} from '../platform/organizations.js';
import {textField} from '../platform/tenants.js';
import {newId} from '../ids.js';
import {requireRecordAccess,requireRecordWorkspace,type RecordWorkspace} from './access.js';
import {actOnIssue} from './service.js';
async function authority(db:Database,clock:Clock,w:RecordWorkspace,proofId:string){
 const current=await requireRecordAccess(db,w,proofId,true);
 if(current.partner)await reauthorizePartner(db,clock,current.partner,'issues:assign');
 else if(!['OWNER','ADMIN'].includes(current.role))throw new DomainError('RECORD_PERMISSION_DENIED','A current administrator assigns review responsibility.',403);
 return current;
}
async function recipient(db:Database,w:RecordWorkspace,proofId:string,id:string){
 const member=(await db.query<{user_id:string}>('SELECT user_id FROM platform_memberships WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL',[id,w.organizationId])).rows[0];
 if(!member)throw new DomainError('ISSUE_REVIEWER_UNAVAILABLE','Choose a current member who can access this record.',409);
 try{const workspace=await requireRecordWorkspace(db,member.user_id,w.organizationId,w.environment);await requireRecordAccess(db,workspace,proofId);return member.user_id;}
 catch(error){if(error instanceof DomainError&&[403,404,409].includes(error.httpStatus))throw new DomainError('ISSUE_REVIEWER_UNAVAILABLE','Choose a current member who can access this record.',409);throw error;}
}
export async function listRecordReviewers(db:Database,clock:Clock,w:RecordWorkspace,proofId:string){
 await authority(db,clock,w,proofId);
 const rows=(await db.query<{id:string;role:string;display_name:string|null;username:string|null}>('SELECT m.id,m.role,u.display_name,u.username FROM platform_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.revoked_at IS NULL ORDER BY m.id LIMIT 201',[w.organizationId])).rows;
 if(rows.length>200)throw new DomainError('REVIEWER_CATALOG_LIMIT','This workspace requires a reviewed team-directory filter.',409);
 const reviewers=[];for(const row of rows){try{await recipient(db,w,proofId,row.id);reviewers.push({membershipId:row.id,label:row.display_name||row.username||'Member '+row.id.slice(-6),role:row.role});}catch(error){if(error instanceof DomainError&&error.code==='ISSUE_REVIEWER_UNAVAILABLE')continue;throw error;}}
 await authority(db,clock,w,proofId);return {reviewers,limit:200};
}
/** recordCommand holds the current revision lock. Routing is separate from resolution and attestation. */
export async function assignRecordIssue(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,issueId:string,input:unknown){
 const b=strictBody(input,['membershipId','reason']);
 if(!Object.hasOwn(b,'membershipId'))throw new DomainError('INVALID_REQUEST','Choose a current reviewer or explicitly clear the assignment.',400);
 const reason=textField(b.reason,'reason',700),membershipId=b.membershipId==null?null:textField(b.membershipId,'membershipId',100);
 await authority(db,clock,w,proofId);
 if(!(await db.query('SELECT 1 FROM record_issues WHERE id=$1 AND proof_id=$2',[issueId,proofId])).rows[0])throw new DomainError('ISSUE_NOT_FOUND','Issue not found.',404);
 const userId=membershipId?await recipient(db,w,proofId,membershipId):null,sequence=Number((await db.query<{sequence:number}>('SELECT COALESCE(max(sequence),0)+1 AS sequence FROM record_issue_assignments WHERE issue_id=$1',[issueId])).rows[0].sequence);
 if(sequence>500)throw new DomainError('ISSUE_ASSIGNMENT_LIMIT','This issue has reached its reviewed assignment-history limit.',409);
 const id=newId('issue_assignment'),note=membershipId?'Review assigned to membership '+membershipId+' (user '+userId+'): '+reason:'Review assignment cleared: '+reason;
 const result=await actOnIssue(db,clock,w,proofId,issueId,{action:'note',reason:note});
 await db.query('INSERT INTO record_issue_assignments(id,issue_id,sequence,assignee_membership_id,assignee_user_id,actor_user_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,issueId,sequence,membershipId,userId,w.userId,reason,clock.now().toISOString()]);
 await enqueueRecoveryEvent(db,clock,{operationId:'issue-assignment:'+id,kind:'ISSUE_ASSIGNED',proofId,actorUserId:w.userId,payload:await buildProofRecoverySnapshot(db,proofId)});
 return {id,issueId,proofId,revision:result.revision,assigneeMembershipId:membershipId,assigneeUserId:userId};
}
