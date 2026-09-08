import { randomBytes } from "node:crypto";
import type { Database } from "../db/database.js";
import { assertSchemaCurrent } from "../db/migrate.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex, sha256HexFromStream } from "../hash.js";
import type { ObjectStore } from "../s3/object-store.js";
import { DomainError } from "./errors.js";
import { buildRecoveryReplayPlan, verifyRecoveryEnvelope, type RecoveryPublisher, type PreservationReceipt } from "./recovery-journal.js";
import { installPolicyRecoveryReplay, inspectPolicyRecoveryReconciliation, POLICY_RECOVERY_KEYS, verifyPolicyEnvelope, type PolicyParentContext } from "./policy-recovery.js";
import { verifyManifestIntegrity, type ManifestSignature } from "./manifest-signing.js";
import { MEDIA_MAX_BYTES } from "./media-admission.js";

type Row = Record<string, unknown>;
const CORE_KEYS: Record<string, string[]> = {
  users:["id"], transactions:["id"], transaction_shipping:["id"], transaction_items:["id"], transaction_integration_identities:["id"],
  proofs:["id"], proof_participants:["id"], commerce_receivers:["proof_id"], commerce_stages:["id"], capture_sessions:["id"], capture_session_reports:["id"],
  evidence:["id"], commerce_stage_evidence:["id"], audit_events:["id"], attestations:["id"], attestation_challenges:["id"], proof_assets:["id"],
  custody_observations:["id"], custody_transfers:["id"], proof_asset_external_refs:["id"], continuity_evaluations:["id"],
  observation_assets:["observation_id","asset_id"], observation_evidence:["observation_id","evidence_id"], observation_external_refs:["observation_id","tenant_key","external_id"],
  proof_external_references:["id"], shipment_events:["id"], capture_shipping_labels:["id"], capture_label_observations:["id"], proof_parcel_scopes:["proof_id"],
  proof_retention_holds:["id"], proof_retention_assignments:["id"], proof_deletion_requests:["id"], proof_disposition_state:["proof_id"],
  transaction_source_observations:["id"], capture_label_resolutions:["id"],
  final_manifests:["id"], proof_supplements:["id"],
};
const RESTORE_KEYS = {...CORE_KEYS, ...POLICY_RECOVERY_KEYS};
const ORDER = [
  "users","auth_identities","api_tenants","api_keys","transactions","transaction_shipping","transaction_items","transaction_integration_identities","transaction_source_observations",
  "proofs","proof_participants","commerce_receivers","commerce_stages","capture_sessions","capture_session_reports","evidence","commerce_stage_evidence","audit_events","attestations","attestation_challenges",
  "proof_assets","custody_observations","custody_transfers","proof_asset_external_refs","observation_assets","observation_evidence","observation_external_refs","continuity_evaluations",
  "proof_external_references","shipment_events","capture_shipping_labels","capture_label_observations","capture_label_resolutions","proof_parcel_scopes","invitations","api_tenant_proofs",
  "proof_access_links","proof_disclosure_grants","proof_notification_subscriptions","proof_receipt_preferences","user_verified_contacts","proof_media_derivatives","support_access_grants","support_access_revocations",
  "proof_retention_holds","proof_retention_assignments","proof_deletion_requests","proof_disposition_state","final_manifests","proof_supplements",
];
const SEED_TABLES = new Set(["schema_migrations","recovery_writer_fence","retention_operations_gates","item_history_graph_lock","policy_recovery_fence","policy_recovery_tables"]);
const failure = (code: string, message: string) => new DomainError(code, message, 409);
const identity = (table:string,row:Row) => {
  const keys=RESTORE_KEYS[table];
  if(!keys || keys.some(key=>row[key]==null))throw failure("RECOVERY_RESTORE_UNSUPPORTED","Snapshot contains an unsupported entity identity");
  return canonicalize(Object.fromEntries(keys.map(key=>[key,row[key]])));
};

export interface FreshRecoveryRestoreInput {
  expectedDatabase: string;
  /** Dedicated DB login; runtime and migration roles are deliberately disallowed. */
  restoreRole: string;
  /** Operator evidence references are recorded, not treated as proof of infrastructure isolation. */
  isolatedTargetReference: string;
  oldWriterFenceReference: string;
  targetWriterGeneration: string;
  core: {envelopes:Buffer[]; expectedWatermark:Buffer};
  policy: {envelopes:Buffer[]; expectedWatermark:Buffer};
  trustedPublicKey: RecoveryPublisher["trustedPublicKey"];
  sourceStore: Pick<ObjectStore,"get"|"head"|"getStream">;
}

/**
 * Reconstructs a NEW, migrated, isolated database. A stale database is a comparison
 * source only: immutable accepted rows are never rewritten or blindly upserted.
 * Full genesis-to-head journals are required; this is not a suffix/PITR importer.
 * All runtime triggers remain enabled. This function never enables writers or reads.
 */
export async function restoreFreshRecoveryDatabase(db:Database,input:FreshRecoveryRestoreInput) {
  const startedAt=new Date().toISOString();
  await assertSchemaCurrent(db);
  if(!/^packproof_restore(?:_[a-z0-9_]+)?$/.test(input.restoreRole) || !input.expectedDatabase || !input.isolatedTargetReference || !input.oldWriterFenceReference || !input.targetWriterGeneration || input.targetWriterGeneration==='initial')throw failure("RECOVERY_RESTORE_AUTHORITY_REQUIRED","An identified isolated target, dedicated restore role and new writer generation are required");
  await db.transaction(async tx=>{
    await assertAuthority(tx,input);
    await assertFreshTarget(tx);
    await tx.query("UPDATE recovery_writer_fence SET writes_enabled=false,generation=$1 WHERE singleton=1",[input.targetWriterGeneration]);
    await tx.query("UPDATE policy_recovery_fence SET mode='RESTORING',durability_required=true WHERE singleton=1");
  });
  // Verification failures intentionally leave the authorized empty target fenced.
  const plan=await buildRecoveryReplayPlan({envelopes:input.core.envelopes,trustedPublicKey:input.trustedPublicKey,backupBoundaryHead:null});
  const watermark=await verifyRecoveryEnvelope(input.core.expectedWatermark,input);
  if(!plan.acceptedReceipts.length || plan.finalHead!==watermark.eventSha256)throw failure("RECOVERY_RESTORE_HEAD_MISMATCH","Core replay did not reach the independently supplied signed head");
  const core=await Promise.all(input.core.envelopes.map(async bytes=>{
    const envelope=await verifyRecoveryEnvelope(bytes,input);
    const event=JSON.parse(envelope.eventCanonicalJson) as Row;
    if(canonicalize(event)!==envelope.eventCanonicalJson)throw failure("RECOVERY_ENVELOPE_CONFLICT","Accepted event serialization is not canonical");
    return {bytes,envelope,event};
  }));
  core.sort((a,b)=>BigInt(String(a.event.sequence))<BigInt(String(b.event.sequence))?-1:1);
  const policyWatermark=await verifyPolicyEnvelope(input.policy.expectedWatermark,input.trustedPublicKey);
  for(const {event} of core)if(event.policySequence!=null && BigInt(String(event.policySequence))>BigInt(policyWatermark.event.sequence))throw failure("RECOVERY_RESTORE_POLICY_GAP","Policy replay head precedes an accepted core receipt");
  const policy=await Promise.all(input.policy.envelopes.map(bytes=>verifyPolicyEnvelope(bytes,input.trustedPublicKey)));
  policy.sort((a,b)=>BigInt(a.event.sequence)<BigInt(b.event.sequence)?-1:1);
  let policyHead:string|null=null;
  for(const row of policy){if(row.event.previousSha256!==policyHead)throw failure("POLICY_REPLAY_CHAIN_GAP","Full policy genesis-to-head chain is required");policyHead=row.envelope.eventSha256;}
  if(policyHead!==policyWatermark.envelope.eventSha256)throw failure("POLICY_REPLAY_BOUNDARY_MISMATCH","Policy replay does not reach the independently supplied head");

  const rows=new Map<string,Map<string,Row>>();
  const setRow=(table:string,row:Row)=>{let entries=rows.get(table);if(!entries){entries=new Map();rows.set(table,entries);}entries.set(identity(table,row),row);};
  // Latest complete Proof snapshots are applied in their last accepted sequence order.
  const latestSequence=new Map(core.map(row=>[String(row.event.proofId),BigInt(String(row.event.sequence))]));
  for(const proof of [...plan.proofs].sort((a,b)=>latestSequence.get(a.proofId)!<latestSequence.get(b.proofId)!?-1:1)){
    if(proof.rows.proofs?.length!==1 || proof.rows.proofs[0].id!==proof.proofId)throw failure("RECOVERY_RESTORE_SCOPE_CONFLICT","Snapshot Proof identity is inconsistent");
    for(const [table,entries] of Object.entries(proof.rows)){
      if(!CORE_KEYS[table] || !Array.isArray(entries))throw failure("RECOVERY_RESTORE_UNSUPPORTED","Snapshot schema is outside this restore implementation");
      for(const row of entries){if(row.proof_id!=null&&row.proof_id!==proof.proofId)throw failure("RECOVERY_RESTORE_SCOPE_CONFLICT","Snapshot contains another Proof's row");setRow(table,row);}
    }
  }
  // Policy parent contexts retain unfinished workflow relationships, without
  // manufacturing a core accepted event, manifest, evidence row or receipt.
  const contexts = new Map<string, PolicyParentContext>();
  for (const {event} of policy) if (event.change.recoveryContext) contexts.set(event.change.recoveryContext.proofId, event.change.recoveryContext);
  const contextOnlyProofIds: string[] = [];
  for (const context of contexts.values()) {
    if (rows.get('proofs')?.has(identity('proofs', {id: context.proofId}))) continue;
    const proof = context.rows.proofs[0];
    if (!['OPEN', 'AWAITING_PARTICIPANT', 'READY_FOR_EVIDENCE'].includes(String(proof.status)) || proof.finalized_at != null || proof.manifest_id != null) {
      throw failure('RECOVERY_RESTORE_DEPENDENCY_GAP', 'A completed or committed Proof context requires its accepted core journal; policy context cannot replace missing evidence');
    }
    for (const [table, entries] of Object.entries(context.rows)) for (const row of entries) {
      const prior = rows.get(table)?.get(identity(table, row));
      if (prior && canonicalize(prior) !== canonicalize(row)) throw failure('RECOVERY_RESTORE_SCOPE_CONFLICT', 'Policy parent context conflicts with an accepted core parent');
      setRow(table, row);
    }
    contextOnlyProofIds.push(context.proofId);
  }
  const unrecoverableInvitationIds:string[]=[];
  // Access policy wins over an older core snapshot. Deleted grants remain absent.
  for(const {event} of policy){
    const {table,key,after}=event.change, id=identity(table,key);
    if(after===null){rows.get(table)?.delete(id);continue;}
    if(identity(table,after)!==id)throw failure("POLICY_ENVELOPE_CONFLICT","Policy snapshot identity differs from its signed entity key");
    const combined={...rows.get(table)?.get(id),...after};
    if((table==='users'||table==='proof_notification_subscriptions'||table==='proof_receipt_preferences')&&combined.updated_at==null)combined.updated_at=combined.created_at??event.change.recordedAt;
    if(table==='invitations'){
      // Original bearer credentials were intentionally excluded from the journal.
      // A fresh unexposed nonce prevents a stale invite URL from gaining access.
      combined.token=randomBytes(32).toString('base64url');
    }
    setRow(table,combined);
  }
  for(const row of rows.get('invitations')?.values()??[])unrecoverableInvitationIds.push(String(row.id));
  // The global policy chain can refer to an unfinished Proof that never reached
  // a core accepted-event snapshot. A proof_id alone cannot reconstruct that
  // parent or its transaction; report the coverage gap before applying anything.
  const recoveredProofs = new Set([...(rows.get('proofs')?.values() ?? [])].map(row => row.id));
  for (const entries of rows.values()) for (const row of entries.values()) {
    if (row.proof_id != null && !recoveredProofs.has(row.proof_id)) {
      throw failure('RECOVERY_RESTORE_DEPENDENCY_GAP', 'Signed policy references a Proof whose parent context is absent from the accepted core journal');
    }
  }
  const media=await verifyMedia(rows,input.sourceStore);
  await verifyFrozenRecords(rows,input.trustedPublicKey);
  const journalVersions=new Map<string,string>();
  for(const {event,bytes} of core){const key=`recovery/v1/${sha256Hex(String(event.operationId))}.json`;journalVersions.set(key,await verifyJournalObject(input.sourceStore,key,bytes));}
  for(const bytes of input.policy.envelopes){const {event}=await verifyPolicyEnvelope(bytes,input.trustedPublicKey);const key=`recovery/policy/v1/${event.sequence.padStart(20,'0')}.json`;journalVersions.set(key,await verifyJournalObject(input.sourceStore,key,bytes));}

  // Install signed policy events before domain inserts so trigger-generated restore
  // audit events allocate AFTER the source watermark rather than colliding with it.
  await installPolicyRecoveryReplay(db,{envelopes:input.policy.envelopes,expectedWatermark:input.policy.expectedWatermark,backupBoundaryHead:null,trustedPublicKey:input.trustedPublicKey});
  const counts:Record<string,number>={};
  await db.transaction(async tx=>{
    await assertAuthority(tx,input);
    const fence=(await tx.query<{writes_enabled:boolean;generation:string}>("SELECT * FROM recovery_writer_fence WHERE singleton=1 FOR UPDATE")).rows[0];
    await tx.query("SELECT singleton FROM policy_recovery_fence WHERE singleton=1 FOR UPDATE");
    if(fence.writes_enabled || fence.generation!==input.targetWriterGeneration)throw failure("RECOVERY_RESTORE_FENCE_CHANGED","Restore fence changed during verification");
    const tables=(await tx.query<{table_name:string}>("SELECT tablename AS table_name FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    for(const table of tables)await tx.query(`LOCK TABLE ${safeIdentifier(table.table_name)} IN ACCESS EXCLUSIVE MODE`);
    for(const table of tables){if(SEED_TABLES.has(table.table_name)||table.table_name.startsWith('policy_recovery_'))continue;if((await tx.query(`SELECT 1 FROM ${safeIdentifier(table.table_name)} LIMIT 1`)).rows[0])throw failure("RECOVERY_RESTORE_TARGET_NOT_EMPTY","Reconstruction only accepts an empty domain database");}
    const columns=new Map<string,Set<string>>();
    for(const row of (await tx.query<{table_name:string;column_name:string}>("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'")).rows){let value=columns.get(row.table_name);if(!value){value=new Set();columns.set(row.table_name,value);}value.add(row.column_name);}
    const insert=async(table:string,row:Row)=>{
      const names=Object.keys(row);
      if(!names.length||names.some(name=>!columns.get(table)?.has(name)))throw failure("RECOVERY_RESTORE_SCHEMA_MISMATCH","Frozen row columns differ from this release schema");
      const projection=names.map(safeIdentifier).join(',');
      await tx.query(`INSERT INTO ${safeIdentifier(table)} (${projection}) SELECT ${projection} FROM jsonb_populate_record(NULL::${safeIdentifier(table)},$1::jsonb)`,[JSON.stringify(row)]);
      counts[table]=(counts[table]??0)+1;
    };
    for(const table of ORDER){
      let entries=[...(rows.get(table)?.values()??[])];
      if(table==='custody_observations')entries=orderObservationDependencies(entries);
      for(const original of entries){
        const row={...original};
        // The transaction remains inaccessible throughout; normal lifecycle guards
        // permit dependencies before the final immutable status transition.
        if(table==='proofs'&&row.status==='FINALIZED'){row.status='EVIDENCE_COMMITTED';row.finalized_at=null;row.manifest_id=null;}
        if(table==='commerce_stages'&&row.finalized_at!=null){row.finalized_at=null;row.canonical_json=null;row.sha256=null;}
        await insert(table,row);
      }
    }
    for(const row of rows.get('commerce_stages')?.values()??[])if(row.finalized_at!=null)await tx.query("UPDATE commerce_stages SET finalized_at=$2,canonical_json=$3,sha256=$4 WHERE id=$1",[row.id,row.finalized_at,row.canonical_json,row.sha256]);
    for(const row of rows.get('proofs')?.values()??[])if(row.status==='FINALIZED')await tx.query("UPDATE proofs SET status='FINALIZED',manifest_id=$2,finalized_at=$3 WHERE id=$1",[row.id,row.manifest_id,row.finalized_at]);
    const supplementHeads=new Map<string,Row>();
    for(const row of rows.get('proof_supplements')?.values()??[]){const prior=supplementHeads.get(String(row.proof_id));if(!prior||Number(row.sequence)>Number(prior.sequence))supplementHeads.set(String(row.proof_id),row);}
    for(const row of supplementHeads.values())await insert('proof_supplement_heads',{proof_id:row.proof_id,sequence:row.sequence,sha256:row.sha256});
    const seen=new Set<string>();
    for(const {event,envelope,bytes} of core){
      const operationId=String(event.operationId);if(seen.has(operationId))continue;seen.add(operationId);
      const objectKey=`recovery/v1/${sha256Hex(operationId)}.json`;
      const reference=journalVersions.get(objectKey)!;
      const request={operationId:event.operationId,kind:event.kind,proofId:event.proofId,actorUserId:event.actorUserId,payload:event.payload};
      await insert('recovery_events',{operation_id:operationId,sequence:event.sequence,proof_id:event.proofId,kind:event.kind,request_sha256:sha256Hex(canonicalize(request)),canonical_json:envelope.eventCanonicalJson,sha256:envelope.eventSha256,previous_sha256:event.previousSha256,created_at:event.committedAt});
      const receipt:PreservationReceipt={version:1,operationId,eventSha256:envelope.eventSha256,envelopeSha256:sha256Hex(bytes),objectKey,objectVersionId:reference,preservedAt:envelope.publishedAt,signature:envelope.signature};
      await insert('recovery_delivery',{operation_id:operationId,state:'DURABLE',attempts:0,next_attempt_at:envelope.publishedAt,delivered_at:envelope.publishedAt,receipt_json:receipt});
    }
    for(const {event} of policy)await tx.query("UPDATE policy_recovery_delivery SET receipt_json=jsonb_set(receipt_json,'{objectVersionId}',$2::jsonb) WHERE sequence=$1",[event.sequence,JSON.stringify(journalVersions.get(`recovery/policy/v1/${event.sequence.padStart(20,'0')}.json`))]);
    await tx.query("SELECT setval(pg_get_serial_sequence('recovery_events','sequence'),(SELECT MAX(sequence) FROM recovery_events),true)");
    const policyReport=await inspectPolicyRecoveryReconciliation(tx);
    if(!policyReport.matches)throw failure("POLICY_RECONCILIATION_REQUIRED","Freshly restored policy differs from authenticated source facts");
  });
  return {version:1,mode:'FRESH_RECONSTRUCTION',startedAt,completedAt:new Date().toISOString(),coreHead:plan.finalHead,policyHead,counts,media,unrecoverableInvitationIds,contextOnlyProofIds,
    isolatedTargetReference:input.isolatedTargetReference,oldWriterFenceReference:input.oldWriterFenceReference,trafficMayOpen:false,writersEnabled:false,
    remainingGates:['Independent verification of old-writer infrastructure fence','Policy restore audit publication and exact reconciliation','Domain audit after the last core envelope, non-core product/integration/billing metadata restore','Measured deployment restore drill and independently authorized cutover']};
}

function safeIdentifier(value:string){if(!/^[a-z_][a-z0-9_]*$/.test(value))throw failure('RECOVERY_RESTORE_SCHEMA_MISMATCH','Unsupported schema identifier');return `"${value}"`;}
async function assertAuthority(db:Database,input:FreshRecoveryRestoreInput){
  const identity=(await db.query<{role:string;database:string;superuser:boolean;bypassrls:boolean}>("SELECT current_user AS role,current_database() AS database,r.rolsuper AS superuser,r.rolbypassrls AS bypassrls FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
  if(!identity||identity.role!==input.restoreRole||identity.database!==input.expectedDatabase||identity.superuser||identity.bypassrls)throw failure('RECOVERY_RESTORE_AUTHORITY_REQUIRED','Use the dedicated non-superuser restore login for the identified isolated database');
}
async function assertFreshTarget(db:Database){
  const tables=(await db.query<{table_name:string}>("SELECT tablename AS table_name FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for(const {table_name} of tables){await db.query(`LOCK TABLE ${safeIdentifier(table_name)} IN ACCESS EXCLUSIVE MODE`);if(!SEED_TABLES.has(table_name)&&(await db.query(`SELECT 1 FROM ${safeIdentifier(table_name)} LIMIT 1`)).rows[0])throw failure('RECOVERY_RESTORE_TARGET_NOT_EMPTY','Reconstruction requires a new migrated database; an older backup must remain a separate comparison source');}
}
function orderObservationDependencies(rows:Row[]){const result:Row[]=[],pending=new Map(rows.map(row=>[row.id,row])),seen=new Set<unknown>();while(pending.size){let changed=false;for(const [id,row] of pending){if(row.previous_observation_id!=null&&!seen.has(row.previous_observation_id))continue;result.push(row);seen.add(id);pending.delete(id);changed=true;}if(!changed)throw failure('RECOVERY_RESTORE_DEPENDENCY_GAP','Observation ancestry is missing or cyclic');}return result;}
async function verifyJournalObject(store:FreshRecoveryRestoreInput['sourceStore'],key:string,bytes:Buffer){
  const head=await store.head?.(key);
  if(!head?.versionId||head.versionId==='null')throw failure('RECOVERY_RESTORE_VERSION_REQUIRED','Protected journal must expose an exact retained object version');
  if(head.byteSize!==bytes.length)throw failure('RECOVERY_RESTORE_OBJECT_CONFLICT','Protected journal size differs from the admitted signed envelope');
  const source=await store.get(key,{versionId:head.versionId});
  if(!source||sha256Hex(source.body)!==sha256Hex(bytes))throw failure('RECOVERY_RESTORE_OBJECT_CONFLICT','Supplied journal bytes differ from the exact protected source version');
  return head.versionId;
}
async function verifyMedia(rows:Map<string,Map<string,Row>>,store:FreshRecoveryRestoreInput['sourceStore']){
  let objects=0,byteSize=0;
  for(const table of ['evidence','commerce_stage_evidence','proof_media_derivatives'])for(const row of rows.get(table)?.values()??[]){
    const derivative=table==='proof_media_derivatives';
    if(derivative?!['READY','REVIEWED'].includes(String(row.status)):row.committed_at==null)continue;
    const key=String(row.object_key),versionId=row.object_version_id;
    if(typeof versionId!=='string'||!versionId||versionId==='null')throw failure('RECOVERY_MEDIA_VERSION_REQUIRED','Committed recovery media needs an exact preserved version');
    const expected=Number(row.byte_size);
    if(!Number.isSafeInteger(expected)||expected<=0||expected>MEDIA_MAX_BYTES)throw failure('RECOVERY_MEDIA_SIZE_UNSUPPORTED','Media lies outside the bounded restore validator');
    const source=await store.getStream?.(key,{versionId});
    if(!source||source.versionId!==versionId)throw failure('RECOVERY_MEDIA_UNAVAILABLE','An exact preserved media version is unavailable');
    try {
      const limited=(async function*(){let total=0;for await(const chunk of source.body){total+=chunk.length;if(total>expected)throw failure('RECOVERY_MEDIA_INTEGRITY_FAILURE','Preserved media exceeds its accepted size');yield chunk;}})();
      const digest=await sha256HexFromStream(limited);
      if(digest.byteSize!==expected||digest.sha256!==row.sha256)throw failure('RECOVERY_MEDIA_INTEGRITY_FAILURE','Preserved media digest or size differs from accepted facts');
      objects++;byteSize+=expected;
    }finally{source.body.destroy();}
  }
  return {objects,byteSize,exactVersionsVerified:true};
}
async function verifyFrozenRecords(rows:Map<string,Map<string,Row>>,trusted:FreshRecoveryRestoreInput['trustedPublicKey']){
  const manifests=new Map<string,Row>();
  for(const row of rows.get('final_manifests')?.values()??[]){
    manifests.set(String(row.proof_id),row);
    const signature:ManifestSignature|null=row.signing_key_id?{algorithm:row.signature_algorithm as ManifestSignature['algorithm'],keyId:String(row.signing_key_id),signatureBase64:String(row.signature_base64),signedAt:String(row.signed_at)}:null;
    const valid=verifyManifestIntegrity({canonicalJson:String(row.canonical_json),expectedSha256:String(row.sha256),signature,publicKeyPem:signature?await trusted(signature.keyId):null});
    if(!valid.digestValid||(signature&&!valid.signatureValid))throw failure('RECOVERY_MANIFEST_INTEGRITY_FAILURE','Frozen core manifest integrity or signing authority is invalid');
  }
  for(const row of rows.get('proofs')?.values()??[])if(row.status==='FINALIZED'&&manifests.get(String(row.id))?.id!==row.manifest_id)throw failure('RECOVERY_RESTORE_DEPENDENCY_GAP','Finalized Proof has no matching frozen manifest');
  const heads=new Map<string,{sequence:number;sha256:unknown}>();
  for(const row of [...(rows.get('proof_supplements')?.values()??[])].sort((a,b)=>Number(a.sequence)-Number(b.sequence))){
    const proofId=String(row.proof_id),manifest=manifests.get(proofId),head=heads.get(proofId),facts=JSON.parse(String(row.canonical_json)) as Row;
    if(!manifest||Number(row.sequence)!==(head?.sequence??0)+1||row.previous_sha256!==(head?.sha256??manifest.sha256)||row.core_manifest_sha256!==manifest.sha256||facts.proofId!==proofId||facts.sequence!==row.sequence||facts.previousSha256!==row.previous_sha256)throw failure('RECOVERY_SUPPLEMENT_CHAIN_GAP','Supplement history is incomplete or inconsistent with the frozen core');
    const signature=row.signature_json as ManifestSignature,valid=verifyManifestIntegrity({canonicalJson:String(row.canonical_json),expectedSha256:String(row.sha256),signature,publicKeyPem:await trusted(signature.keyId)});
    if(!valid.digestValid||!valid.signatureValid)throw failure('RECOVERY_SUPPLEMENT_INTEGRITY_FAILURE','Supplement integrity or signing authority is invalid');
    heads.set(proofId,{sequence:Number(row.sequence),sha256:row.sha256});
  }
  for(const row of rows.get('commerce_stages')?.values()??[])if(row.finalized_at!=null&&sha256Hex(String(row.canonical_json))!==row.sha256)throw failure('RECOVERY_STAGE_INTEGRITY_FAILURE','Frozen stage digest differs from its recorded bytes');
}
