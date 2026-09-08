import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import { verifyManifestIntegrity, type ManifestSignature } from "./manifest-signing.js";
import type { RecoveryPublisher } from "./recovery-journal.js";
import { verifyPreservedJournalVersion } from "./recovery-journal-object.js";

interface PolicyRow {
  sequence: string | number; table_name: string; entity_key: Record<string, unknown>;
  operation: "BASELINE" | "INSERT" | "UPDATE" | "DELETE"; before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null; database_principal: string; transaction_id: string; recorded_at: Date | string;
  recovery_context: PolicyParentContext | null;
}
export interface PolicyParentContext {
  version: 1; domain: "PACKPROOF_POLICY_PARENT_CONTEXT"; coreAcceptance: false; proofId: string;
  rows: Record<string, Array<Record<string, unknown>>>;
}
interface PolicyEvent {
  version: 1; domain: "PACKPROOF_POLICY_RECOVERY_EVENT"; acceptance: "COMMITTED"; sequence: string;
  previousSha256: string | null; change: { table: string; key: Record<string, unknown>; operation: PolicyRow["operation"];
    before: Record<string, unknown> | null; after: Record<string, unknown> | null;
    databasePrincipal: string; transactionId: string; recordedAt: string; attribution: "DATABASE_CHANGE_WITH_SEPARATE_DOMAIN_AUDIT";
    recoveryContext?: PolicyParentContext };
}
interface PolicyEnvelope {
  version: 1; domain: "PACKPROOF_SIGNED_POLICY_RECOVERY_ENVELOPE";
  eventCanonicalJson: string; eventSha256: string; publishedAt: string; signature: ManifestSignature;
}
export const POLICY_RECOVERY_KEYS: Record<string, string[]> = {
  users: ["id"], auth_identities: ["id"], proof_participants: ["id"], invitations: ["id"], commerce_receivers: ["proof_id"],
  api_tenants: ["id"], api_keys: ["id"], api_tenant_proofs: ["tenant_id", "external_id"], proof_access_links: ["id"],
  proof_disclosure_grants: ["access_link_id", "scope_version"], proof_notification_subscriptions: ["id"],
  proof_receipt_preferences: ["proof_id", "user_id"], user_verified_contacts: ["user_id", "email_normalized"],
  proof_retention_holds: ["id"], proof_retention_assignments: ["id"], proof_disposition_state: ["proof_id"], proof_media_derivatives: ["id"],
  support_access_grants: ["id"], support_access_revocations: ["grant_id"],
};

export async function configurePolicyDurability(db: Database, input: {required: boolean}) {
  // A routine process restart/rollback cannot weaken a previously enabled boundary.
  await db.query("UPDATE policy_recovery_fence SET durability_required=durability_required OR $1 WHERE singleton=1", [input.required]);
}

/** Apply at disclosure/token/key authorization and before each streamed response checkpoint. */
export async function assertPolicyAccessSafe(db: Database) {
  const fence = (await db.query<{mode:string;durability_required:boolean;baseline_completed:boolean;expected_sequence:string|null;expected_head_sha256:string|null;reconciled_sequence:string|null;reconciled_head_sha256:string|null}>("SELECT * FROM policy_recovery_fence WHERE singleton=1")).rows[0];
  if (!fence?.baseline_completed || fence.mode !== "NORMAL") throw new DomainError("POLICY_RECOVERY_UNAVAILABLE", "Access is temporarily unavailable while recovery permissions are reconciled", 503);
  if (fence.expected_sequence && (!fence.reconciled_sequence || BigInt(fence.reconciled_sequence) < BigInt(fence.expected_sequence) || (fence.reconciled_sequence === fence.expected_sequence && fence.reconciled_head_sha256 !== fence.expected_head_sha256))) throw new DomainError("POLICY_RECOVERY_UNAVAILABLE", "Recovered access permissions have not reached the signed policy boundary", 503);
  // A domain transaction can use the current policy rows it has just written.
  // Those writes have not been acknowledged yet, and blocking their own return
  // would roll back creation/acceptance forever. All previously committed policy
  // changes still require publication; restore fencing is never bypassed.
  if (fence.durability_required && (await db.query("SELECT 1 FROM policy_recovery_delivery d JOIN policy_recovery_events e USING(sequence) WHERE d.state <> 'DURABLE' AND e.transaction_id <> txid_current()::text LIMIT 1")).rows[0]) throw new DomainError("POLICY_DURABILITY_PENDING", "Access policy preservation is in progress; retry shortly", 503);
}

export async function currentPolicySequence(db: Database): Promise<string | null> {
  const row=(await db.query<{sequence:string|number}>("SELECT sequence FROM policy_recovery_events ORDER BY sequence DESC LIMIT 1")).rows[0];
  return row ? String(row.sequence) : null;
}
export async function requireDurablePolicySequence(db: Database, sequence: string | null | undefined) {
  if (!sequence) return;
  const delivered=(await db.query<{state:string;receipt_json:unknown}>("SELECT state,receipt_json FROM policy_recovery_delivery WHERE sequence=$1",[sequence])).rows[0];
  if(delivered?.state !== "DURABLE" || !delivered.receipt_json) throw new DomainError("POLICY_DURABILITY_PENDING", "Access policy preservation must complete before the recording receipt is issued", 503);
}

export async function verifyPolicyEnvelope(bytes: Buffer, trustedPublicKey: RecoveryPublisher["trustedPublicKey"]): Promise<{envelope:PolicyEnvelope;event:PolicyEvent}> {
  let envelope:PolicyEnvelope,event:PolicyEvent;
  try { envelope=JSON.parse(bytes.toString("utf8"));event=JSON.parse(envelope.eventCanonicalJson); } catch { throw policyConflict(); }
  if(envelope.version!==1 || envelope.domain!=="PACKPROOF_SIGNED_POLICY_RECOVERY_ENVELOPE" || !envelope.signature || event.version!==1 || event.domain!=="PACKPROOF_POLICY_RECOVERY_EVENT" || event.acceptance!=="COMMITTED" || !/^[1-9][0-9]*$/.test(event.sequence) || !POLICY_RECOVERY_KEYS[event.change?.table]) throw policyConflict();
  const keys=POLICY_RECOVERY_KEYS[event.change.table];
  if(canonicalize(Object.keys(event.change.key).sort())!==canonicalize([...keys].sort()) || keys.some(key=>event.change.key[key]==null)) throw policyConflict();
  if (event.change.recoveryContext) {
    const context = event.change.recoveryContext;
    const tables = ["proofs", "transactions", "transaction_shipping", "transaction_items", "transaction_integration_identities"];
    if (context.version !== 1 || context.domain !== "PACKPROOF_POLICY_PARENT_CONTEXT" || context.coreAcceptance !== false
      || context.proofId !== (event.change.after?.proof_id ?? event.change.before?.proof_id)
      || !context.rows || canonicalize(Object.keys(context.rows).sort()) !== canonicalize(tables.sort())
      || Object.values(context.rows).some(rows => !Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row)))) throw policyConflict();
    const proof = context.rows.proofs[0], transaction = context.rows.transactions[0];
    if (context.rows.proofs.length !== 1 || context.rows.transactions.length !== 1 || proof.id !== context.proofId || proof.transaction_id !== transaction.id
      || tables.filter(table => !["proofs", "transactions"].includes(table)).some(table => context.rows[table].some(row => row.transaction_id !== transaction.id))) throw policyConflict();
  }
  const canonical=canonicalize({version:envelope.version,domain:envelope.domain,eventCanonicalJson:envelope.eventCanonicalJson,eventSha256:envelope.eventSha256,publishedAt:envelope.publishedAt});
  const validity=verifyManifestIntegrity({canonicalJson:canonical,expectedSha256:sha256Hex(canonical),signature:envelope.signature,publicKeyPem:await trustedPublicKey(envelope.signature.keyId)});
  if(!validity.signatureValid || sha256Hex(envelope.eventCanonicalJson)!==envelope.eventSha256 || canonicalize(event)!==envelope.eventCanonicalJson) throw policyConflict();
  return {envelope,event};
}
function policyConflict(){return new DomainError("POLICY_ENVELOPE_CONFLICT","Signed policy recovery facts are invalid or conflicting; disclosure remains unavailable",503);}

/** Dedicated policy worker; independent of user requests and of the core evidence queue. */
export async function processPolicyRecoveryOutbox(db: Database, clock: Clock, publisher: RecoveryPublisher): Promise<{processed:number;state?:string}> {
  if(!publisher.protectedStoreVerified) throw new DomainError("RECOVERY_STORE_NOT_VERIFIED","Protected policy journal storage has not been verified",503);
  const token=newId("policy_lease");
  const candidate=await db.transaction(async tx=>{
    const row=(await tx.query<PolicyRow&{state:string;attempts:number;next_attempt_at:Date|string;lease_until:Date|string|null}>("SELECT e.*,d.state,d.attempts,d.next_attempt_at,d.lease_until FROM policy_recovery_events e JOIN policy_recovery_delivery d USING(sequence) WHERE d.state <> 'DURABLE' ORDER BY e.sequence LIMIT 1 FOR UPDATE OF d")).rows[0];
    if(!row || row.state==='DEAD_LETTER' || new Date(row.next_attempt_at)>clock.now() || (row.state==='LEASED' && row.lease_until && new Date(row.lease_until)>clock.now()))return null;
    await tx.query("UPDATE policy_recovery_delivery SET state='LEASED',attempts=attempts+1,lease_token=$2,lease_until=$3 WHERE sequence=$1",[row.sequence,token,new Date(clock.now().getTime()+60000).toISOString()]);return row;
  });
  if(!candidate)return {processed:0};
  try {
    return await db.transaction(async tx=>{
      const fence=(await tx.query<{generation:string;writes_enabled:boolean}>("SELECT generation,writes_enabled FROM recovery_writer_fence WHERE singleton=1 FOR UPDATE")).rows[0];
      const restore=(await tx.query<{mode:string}>("SELECT mode FROM policy_recovery_fence WHERE singleton=1 FOR UPDATE")).rows[0];
      if(!fence?.writes_enabled || fence.generation!==publisher.writerGeneration || restore?.mode!=="NORMAL")throw new DomainError("RECOVERY_WRITER_FENCED","This policy writer is not current",503);
      const lease=(await tx.query<{lease_token:string;state:string}>("SELECT lease_token,state FROM policy_recovery_delivery WHERE sequence=$1 FOR UPDATE",[candidate.sequence])).rows[0];
      if(lease?.lease_token!==token||lease.state!=="LEASED")return {processed:0};
      const previous=(await tx.query<{event_sha256:string}>("SELECT event_sha256 FROM policy_recovery_delivery WHERE sequence<$1 AND state='DURABLE' ORDER BY sequence DESC LIMIT 1",[candidate.sequence])).rows[0];
      const event:PolicyEvent={version:1,domain:"PACKPROOF_POLICY_RECOVERY_EVENT",acceptance:"COMMITTED",sequence:String(candidate.sequence),previousSha256:previous?.event_sha256??null,change:{table:candidate.table_name,key:candidate.entity_key,operation:candidate.operation,before:candidate.before_json,after:candidate.after_json,databasePrincipal:candidate.database_principal,transactionId:candidate.transaction_id,recordedAt:new Date(candidate.recorded_at).toISOString(),attribution:"DATABASE_CHANGE_WITH_SEPARATE_DOMAIN_AUDIT",...(candidate.recovery_context?{recoveryContext:candidate.recovery_context}:{})}};
      const eventCanonicalJson=canonicalize(event),eventSha256=sha256Hex(eventCanonicalJson),objectKey=`recovery/policy/v1/${String(candidate.sequence).padStart(20,"0")}.json`;
      let stored=await publisher.store.get(objectKey);
      if(!stored){
        const facts={version:1 as const,domain:"PACKPROOF_SIGNED_POLICY_RECOVERY_ENVELOPE",eventCanonicalJson,eventSha256,publishedAt:clock.now().toISOString()};
        const canonical=canonicalize(facts),signature=await publisher.signer.signManifest({proofId:"policy",manifestId:`policy:${candidate.sequence}`,canonicalJson:canonical,sha256:sha256Hex(canonical)});
        await publisher.store.putIfAbsent(objectKey,Buffer.from(canonicalize({...facts,signature})),"application/json");stored=await publisher.store.get(objectKey);
      }
      if(!stored)throw new DomainError("POLICY_OBJECT_UNAVAILABLE","Published policy envelope is unavailable",503);
      const verified=await verifyPolicyEnvelope(stored.body,publisher.trustedPublicKey);
      if(verified.envelope.eventSha256!==eventSha256)throw policyConflict();
      const objectVersionId=await verifyPreservedJournalVersion(publisher.store,objectKey,stored.body,"POLICY_ENVELOPE_CONFLICT");
      const receipt={version:1,sequence:String(candidate.sequence),eventSha256,envelopeSha256:sha256Hex(stored.body),objectKey,objectVersionId,preservedAt:verified.envelope.publishedAt,signature:verified.envelope.signature};
      await tx.query("UPDATE policy_recovery_delivery SET state='DURABLE',event_sha256=$2,receipt_json=$3,error_code=NULL,lease_token=NULL,lease_until=NULL WHERE sequence=$1",[candidate.sequence,eventSha256,JSON.stringify(receipt)]);
      await tx.query("UPDATE policy_recovery_fence SET reconciled_sequence=$1,reconciled_head_sha256=$2 WHERE singleton=1",[candidate.sequence,eventSha256]);
      return {processed:1,state:"DURABLE"};
    });
  }catch(error){
    const code=error instanceof DomainError?error.code:"POLICY_DEPENDENCY_UNAVAILABLE",dead=code==="POLICY_ENVELOPE_CONFLICT"||candidate.attempts+1>=8;
    await db.query("UPDATE policy_recovery_delivery SET state=$3,error_code=$4,next_attempt_at=$5,lease_token=NULL,lease_until=NULL WHERE sequence=$1 AND lease_token=$2",[candidate.sequence,token,dead?"DEAD_LETTER":"PENDING",code,new Date(clock.now().getTime()+Math.min(300000,1000*2**candidate.attempts)+Math.floor(Math.random()*1000)).toISOString()]);
    return {processed:1,state:dead?"DEAD_LETTER":"PENDING"};
  }
}

/** The expected watermark is a signed envelope obtained independently of the database being restored. */
export async function installPolicyRecoveryReplay(db:Database, input:{envelopes:Buffer[];backupBoundaryHead:string|null;expectedWatermark:Buffer;trustedPublicKey:RecoveryPublisher["trustedPublicKey"]}) {
  await db.query("UPDATE policy_recovery_fence SET mode='RESTORING',durability_required=true WHERE singleton=1");
  const expected=await verifyPolicyEnvelope(input.expectedWatermark,input.trustedPublicKey);
  // Close access before validating the remainder. A gap must not leave a restored grant usable.
  await db.query("UPDATE policy_recovery_fence SET mode='RESTORING',durability_required=true,expected_sequence=$1,expected_head_sha256=$2 WHERE singleton=1",[expected.event.sequence,expected.envelope.eventSha256]);
  const verified=await Promise.all(input.envelopes.map(async bytes=>({...await verifyPolicyEnvelope(bytes,input.trustedPublicKey),bytes})));
  verified.sort((a,b)=>BigInt(a.event.sequence)<BigInt(b.event.sequence)?-1:BigInt(a.event.sequence)>BigInt(b.event.sequence)?1:0);
  let head=input.backupBoundaryHead,sequence=0n;
  const changes=new Map<string,PolicyEvent>();
  for(const row of verified){
    if(row.event.previousSha256!==head||BigInt(row.event.sequence)<=sequence)throw new DomainError("POLICY_REPLAY_CHAIN_GAP","Policy journal has a gap; recovered disclosure remains closed",409);
    head=row.envelope.eventSha256;sequence=BigInt(row.event.sequence);changes.set(`${row.event.change.table}:${canonicalize(row.event.change.key)}`,row.event);
  }
  if(head!==expected.envelope.eventSha256||sequence!==BigInt(expected.event.sequence))throw new DomainError("POLICY_REPLAY_BOUNDARY_MISMATCH","Policy replay did not reach the independently signed watermark",409);
  await db.transaction(async tx=>{
    await tx.query("SELECT singleton FROM policy_recovery_fence WHERE singleton=1 FOR UPDATE");
    for(const row of verified){
      const change=row.event.change;
      const prior=(await tx.query<PolicyRow>("SELECT * FROM policy_recovery_events WHERE sequence=$1",[row.event.sequence])).rows[0];
      if(prior && canonicalize({table:prior.table_name,key:prior.entity_key,operation:prior.operation,before:prior.before_json,after:prior.after_json,databasePrincipal:prior.database_principal,transactionId:prior.transaction_id,recordedAt:new Date(prior.recorded_at).toISOString(),attribution:"DATABASE_CHANGE_WITH_SEPARATE_DOMAIN_AUDIT",...(prior.recovery_context?{recoveryContext:prior.recovery_context}:{})})!==canonicalize(change))throw policyConflict();
      if(!prior)await tx.query("INSERT INTO policy_recovery_events(sequence,table_name,entity_key,operation,before_json,after_json,database_principal,transaction_id,recorded_at,recovery_context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[row.event.sequence,change.table,JSON.stringify(change.key),change.operation,change.before===null?null:JSON.stringify(change.before),change.after===null?null:JSON.stringify(change.after),change.databasePrincipal,change.transactionId,change.recordedAt,change.recoveryContext?JSON.stringify(change.recoveryContext):null]);
      const priorDelivery=(await tx.query<{state:string;event_sha256:string|null}>("SELECT state,event_sha256 FROM policy_recovery_delivery WHERE sequence=$1",[row.event.sequence])).rows[0];
      if(priorDelivery?.state==='DURABLE' && priorDelivery.event_sha256!==row.envelope.eventSha256)throw policyConflict();
      const receipt={version:1,sequence:row.event.sequence,eventSha256:row.envelope.eventSha256,envelopeSha256:sha256Hex(row.bytes),objectKey:`recovery/policy/v1/${row.event.sequence.padStart(20,'0')}.json`,objectVersionId:null,preservedAt:row.envelope.publishedAt,signature:row.envelope.signature};
      await tx.query("INSERT INTO policy_recovery_delivery(sequence,state,next_attempt_at,event_sha256,receipt_json) VALUES($1,'DURABLE',$2,$3,$4) ON CONFLICT(sequence) DO UPDATE SET state='DURABLE',event_sha256=$3,receipt_json=COALESCE(policy_recovery_delivery.receipt_json,$4::jsonb),lease_token=NULL,lease_until=NULL,error_code=NULL",[row.event.sequence,row.envelope.publishedAt,row.envelope.eventSha256,JSON.stringify(receipt)]);
    }
    await tx.query("SELECT setval(pg_get_serial_sequence('policy_recovery_events','sequence'),(SELECT MAX(sequence) FROM policy_recovery_events),true)");
    for(const event of changes.values())await tx.query("INSERT INTO policy_recovery_overlay(table_name,entity_key,desired_json,source_sequence) VALUES($1,$2,$3,$4) ON CONFLICT(table_name,entity_key) DO UPDATE SET desired_json=$3,source_sequence=$4",[event.change.table,JSON.stringify(event.change.key),event.change.after===null?null:JSON.stringify(event.change.after),event.sequence]);
    await tx.query("UPDATE policy_recovery_fence SET mode='RECONCILING',reconciled_sequence=$1,reconciled_head_sha256=$2 WHERE singleton=1",[String(sequence),head]);
  });
  return {state:"RECONCILING",signedWatermark:{sequence:String(sequence),sha256:head},entities:changes.size,trafficMayOpen:false};
}

/** Does not grant missing rights or rewrite immutable rows. Every restored policy projection must match its authenticated journal facts. */
export async function inspectPolicyRecoveryReconciliation(db:Database) {
  const rows=(await db.query<{table_name:string;entity_key:Record<string,unknown>;desired_json:Record<string,unknown>|null}>("SELECT * FROM policy_recovery_overlay ORDER BY table_name,source_sequence")).rows;
  const mismatches:Array<{table:string;key:Record<string,unknown>;expectedDisposition:string}>=[];
  for(const row of rows){
    const keys=POLICY_RECOVERY_KEYS[row.table_name];
    if(!keys)throw policyConflict();
    const where=keys.map((key,index)=>`to_jsonb(t)->$${index*2+1}::text=$${index*2+2}::jsonb`).join(" AND ");
    const params=keys.flatMap(key=>[key,JSON.stringify(row.entity_key[key])]);
    const current=(await db.query<{body:Record<string,unknown>}>(`SELECT policy_recovery_projection('${row.table_name}',to_jsonb(t)) AS body FROM ${row.table_name} t WHERE ${where}`,params)).rows[0]?.body??null;
    if(canonicalize(current)!==canonicalize(row.desired_json))mismatches.push({table:row.table_name,key:row.entity_key,expectedDisposition:row.desired_json===null?"ABSENT":"EXACT_AUTHENTICATED_STATE"});
  }
  return {matches:mismatches.length===0,checked:rows.length,mismatches,trafficMayOpen:false};
}

/** Called by the restore operator after restoring the original policy tables with dedicated maintenance authority. */
export async function completePolicyRecoveryReconciliation(db:Database) {
  return db.transaction(async tx=>{
    const fence=(await tx.query<{mode:string;expected_sequence:string|null;reconciled_sequence:string|null;expected_head_sha256:string|null;reconciled_head_sha256:string|null}>("SELECT * FROM policy_recovery_fence WHERE singleton=1 FOR UPDATE")).rows[0];
    if(fence?.mode!=="RECONCILING"||!fence.expected_sequence||fence.expected_sequence!==fence.reconciled_sequence||fence.expected_head_sha256!==fence.reconciled_head_sha256)throw new DomainError("POLICY_REPLAY_BOUNDARY_MISMATCH","Policy reconciliation has not reached its signed boundary",409);
    const report=await inspectPolicyRecoveryReconciliation(tx);
    if(!report.matches)throw new DomainError("POLICY_RECONCILIATION_REQUIRED","Restored policy rows do not match signed facts; disclosure remains closed",409);
    await tx.query("UPDATE policy_recovery_fence SET mode='NORMAL' WHERE singleton=1");
    return {...report,policyBoundaryReconciled:true,trafficMayOpen:false};
  });
}
