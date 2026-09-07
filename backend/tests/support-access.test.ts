import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { createHarness,createUser,commitProofEvidence,type TestHarness } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { issueSupportGrant,revokeSupportGrant,readSupportMetadata,readSupportEvidence,listSupportGrants,parseSupportAccessPolicy,type SupportAccessPolicy } from '../src/support/access.js';
let h:TestHarness,proofId:string,now:Date;
const policy:SupportAccessPolicy={approverUserIds:['approver'],readerUserIds:['support','approver']};
const grant=(overrides:Record<string,unknown>={})=>({proofId,supportUserId:'support',scope:'METADATA',evidenceIds:[],reason:'Investigate customer-reported playback failure',issueReference:'SUP-1234',operationId:'support-request-1234',expiresAt:new Date(now.getTime()+1800000).toISOString(),...overrides});
beforeEach(async()=>{now=new Date('2026-09-07T00:00:00Z');h=await createHarness({now:()=>now});for(const id of ['seller','support','approver','outsider'])await createUser(h,id);const txn=await createTransaction(h.db,h.clock,'seller',{externalReference:'PRIVATE-ORDER-ADDRESS',metadata:{address:'Never reveal this address'}});proofId=(await createOrGetProof(h.db,h.clock,'seller',txn.transactionId)).proofId;});
afterEach(async()=>{await h.close();});
describe('time-limited internal support access',()=>{
  it('defaults denied, rejects self elevation and requires bounded reviewed approval',async()=>{
    expect(parseSupportAccessPolicy({})).toEqual({approverUserIds:[],readerUserIds:[]});
    await expect(issueSupportGrant(h.db,h.clock,parseSupportAccessPolicy({}),'approver',grant())).rejects.toMatchObject({code:'SUPPORT_ACCESS_UNAVAILABLE'});
    await expect(issueSupportGrant(h.db,h.clock,policy,'outsider',grant())).rejects.toMatchObject({code:'SUPPORT_ACCESS_UNAVAILABLE'});
    await expect(issueSupportGrant(h.db,h.clock,policy,'approver',grant({supportUserId:'approver'}))).rejects.toMatchObject({code:'INVALID_SUPPORT_GRANT'});
    await expect(issueSupportGrant(h.db,h.clock,policy,'approver',grant({expiresAt:new Date(now.getTime()+3600001).toISOString()}))).rejects.toMatchObject({code:'INVALID_SUPPORT_GRANT'});
    await expect(issueSupportGrant(h.db,h.clock,policy,'approver',grant({reason:'short',isAdmin:true}))).rejects.toMatchObject({code:'INVALID_SUPPORT_GRANT'});
    expect((await h.db.query('SELECT id FROM support_access_grants')).rows).toHaveLength(0);
  });
  it('deduplicates approval, audits metadata reads and preserves narrow fields',async()=>{
    const first=await issueSupportGrant(h.db,h.clock,policy,'approver',grant());const retry=await issueSupportGrant(h.db,h.clock,policy,'approver',grant());expect(retry.grantId).toBe(first.grantId);
    await expect(issueSupportGrant(h.db,h.clock,policy,'approver',grant({reason:'Different requested use requires new approval'}))).rejects.toMatchObject({code:'SUPPORT_OPERATION_CONFLICT'});
    const info=await readSupportMetadata(h.db,h.clock,policy,'support',first.grantId,'request-trace-1');expect(info.proofId).toBe(proofId);expect(info.readOnly).toBe(true);expect(JSON.stringify(info)).not.toContain('PRIVATE-ORDER');expect(JSON.stringify(info)).not.toContain('address');
    expect((await h.db.query('SELECT event_type FROM support_access_audit ORDER BY event_type')).rows).toEqual([{event_type:'GRANTED'},{event_type:'METADATA_READ'}]);
    await expect(readSupportMetadata(h.db,h.clock,policy,'outsider',first.grantId,'request-trace-2')).rejects.toMatchObject({code:'SUPPORT_ACCESS_UNAVAILABLE'});
    await expect(listSupportGrants(h.db,h.clock,policy,'seller')).rejects.toMatchObject({code:'SUPPORT_ACCESS_UNAVAILABLE'});
    expect((await h.db.query("SELECT table_name FROM policy_recovery_events WHERE table_name LIKE 'support_%'")).rows).toEqual([{table_name:'support_access_grants'}]);
  });
  it('does not grant evidence through metadata scope and rejects unrelated originals',async()=>{
    const media=await commitProofEvidence(h,'seller',proofId,{bytes:Buffer.from('private-original')});
    const meta=await issueSupportGrant(h.db,h.clock,policy,'approver',grant());
    await expect(readSupportEvidence(h.db,h.clock,h.objectStore,policy,'support',meta.grantId,media.evidenceId,'trace')).rejects.toMatchObject({code:'SUPPORT_ACCESS_UNAVAILABLE'});
    await expect(issueSupportGrant(h.db,h.clock,policy,'approver',grant({operationId:'support-request-other',scope:'EVIDENCE_READ',evidenceIds:['unrelated-evidence']}))).rejects.toMatchObject({code:'SUPPORT_ACCESS_UNAVAILABLE'});
    const scoped=await issueSupportGrant(h.db,h.clock,policy,'approver',grant({operationId:'support-request-media',scope:'EVIDENCE_READ',evidenceIds:[media.evidenceId]}));
    const result=await readSupportEvidence(h.db,h.clock,h.objectStore,policy,'support',scoped.grantId,media.evidenceId,'trace-media','bytes=0-6');let bytes=Buffer.alloc(0);for await(const chunk of result.body!)bytes=Buffer.concat([bytes,Buffer.from(chunk)]);expect(bytes.toString()).toBe('private');expect(result.status).toBe(206);
    expect((await h.db.query("SELECT evidence_id FROM support_access_audit WHERE event_type='EVIDENCE_READ_STARTED'")).rows).toEqual([{evidence_id:media.evidenceId}]);
    expect((await h.db.query('SELECT user_id FROM proof_participants WHERE proof_id=$1',[proofId])).rows).toEqual([{user_id:'seller'}]);
  });
  it('rechecks expiry and revocation during an existing media response',async()=>{
    const media=await commitProofEvidence(h,'seller',proofId,{bytes:Buffer.alloc(1024*1024,7)});
    const scoped=await issueSupportGrant(h.db,h.clock,policy,'approver',grant({scope:'EVIDENCE_READ',evidenceIds:[media.evidenceId]}));
    const result=await readSupportEvidence(h.db,h.clock,h.objectStore,policy,'support',scoped.grantId,media.evidenceId,'open-response');
    await revokeSupportGrant(h.db,h.clock,policy,'approver',scoped.grantId,{reason:'Investigation completed; remove temporary access'});
    await expect((async()=>{for await(const _chunk of result.body!){} })()).rejects.toMatchObject({code:'SUPPORT_ACCESS_UNAVAILABLE'});
    await expect(readSupportMetadata(h.db,h.clock,policy,'support',scoped.grantId,'later')).rejects.toMatchObject({code:'SUPPORT_ACCESS_UNAVAILABLE'});
    const next=await issueSupportGrant(h.db,h.clock,policy,'approver',grant({operationId:'support-request-next',scope:'EVIDENCE_READ',evidenceIds:[media.evidenceId]}));
    const expiring=await readSupportEvidence(h.db,h.clock,h.objectStore,policy,'support',next.grantId,media.evidenceId,'expiring-response');now=new Date(now.getTime()+1800001);
    await expect((async()=>{for await(const _chunk of expiring.body!){} })()).rejects.toMatchObject({code:'ACCESS_RESPONSE_EXPIRED'});
  });
  it('keeps grants, revocations and access audit immutable and blocks restored uncertain policy',async()=>{
    const approved=await issueSupportGrant(h.db,h.clock,policy,'approver',grant());
    await revokeSupportGrant(h.db,h.clock,policy,'support',approved.grantId,{reason:'Support investigation ended; releasing access'});
    await expect(h.db.query('UPDATE support_access_grants SET expires_at=expires_at+INTERVAL \'1 hour\' WHERE id=$1',[approved.grantId])).rejects.toThrow();
    await expect(h.db.query('DELETE FROM support_access_revocations WHERE grant_id=$1',[approved.grantId])).rejects.toThrow();
    await expect(h.db.query('DELETE FROM support_access_audit WHERE grant_id=$1',[approved.grantId])).rejects.toThrow();
    expect((await h.db.query("SELECT table_name FROM policy_recovery_events WHERE table_name='support_access_revocations'")).rows).toHaveLength(1);
    await h.db.query("UPDATE policy_recovery_fence SET mode='RESTORING' WHERE singleton=1");
    await expect(readSupportMetadata(h.db,h.clock,policy,'support',approved.grantId,'restore-read')).rejects.toMatchObject({code:'POLICY_RECOVERY_UNAVAILABLE'});
  });
});
