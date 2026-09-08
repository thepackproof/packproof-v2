// Shared order intake normalization, identity, immutable snapshots and durable capture guards.
export type IntakeSourceKind = 'API_OBSERVED' | 'BROWSER_CAPTURED' | 'FORWARDED_EMAIL' | 'SELLER_DECLARED';
export type IntakeReadiness = 'RECEIVED' | 'NEEDS_INFORMATION' | 'READY' | 'QUARANTINED' | 'ARCHIVED';
export interface IntakeItem { title: string|null; description?:string|null; quantity:number|null; sku?:string|null; variant?:string|null; externalItemId?:string|null }
export interface IntakeScope { provider:string; externalAccountReference:string; namespaceSource:'MARKETPLACE_API'|'STOREFRONT_API'|'SHIPPING_PROVIDER_API'; connectionId:string; store?:string; verified:true }
export interface IntakeObservationInput { receiptId:string;sourceKind:IntakeSourceKind;adapterKey:string;adapterVersion:string;externalOrderId:string|null;orderReference?:string|null;items:IntakeItem[];physicalFulfillment:boolean|null;paid:boolean|null;cancelled:boolean;fulfillmentScope:'FULL_ORDER'|'PARTIAL'|'MULTI_PARCEL'|'UNKNOWN';sourceRevision?:string|null;sourceOccurredAt?:string|null;rawSourceRef?:string|null;sourceText?:string|null;shipmentReferences?:Array<{carrier?:string|null;trackingNumber?:string|null}> }
export interface IntakeSnapshot {id:string;version:number;digest:string;sha256:string;proofId:string;transactionId:string;tenantKey:string;readiness:'READY';items:IntakeItem[];store:string;orderReference:string;sourceKind:IntakeSourceKind}
export interface IntakeResult {observationId:string;readiness:IntakeReadiness;reasons:string[];transactionId:string|null;proofId:string|null;snapshot:IntakeSnapshot|null;replayed:boolean}
// submitIntakeObservation(db,clock,actor,input,scope):Promise<IntakeResult>
// prepareExistingIntakeOrder(db,clock,actor,transactionId):Promise<IntakeResult>
// listIntakeOrders(db,actor):Promise<IntakeResult[]> (ready or needs info; ready snapshot contains card fields)
// readApprovedIntakeSnapshot(db,actor,snapshotId):Promise<IntakeSnapshot>
// pinIntakeSnapshotForCapture(db,clock,actor,sessionId,snapshotId):Promise<IntakeSnapshot>
// readIntakeProofContext(db,proofId):Promise<{contractVersion:number;snapshot:IntakeSnapshot|null;materialConflict:boolean}|null>
// assertIntakeFinalizeContext(db,proofId):Promise<object|undefined>

import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { DomainError } from '../domain/errors.js';
import { tenantKeyForImport } from '../domain/provenance.js';
import { importNormalizedTransaction } from '../domain/transaction-import.js';
import { loadTransactionView } from '../domain/transactions.js';
import { createOrGetProof } from '../domain/create-proof.js';
import { appendAudit } from '../domain/audit.js';

interface SnapshotRow {id:string;transaction_id:string;proof_id:string;version:number;digest:string;material_digest:string;context:SnapshotContext;observation_id:string}
interface SnapshotContext {tenantKey:string;store:string;orderReference:string;externalOrderId:string|null;items:IntakeItem[];sourceKind:IntakeSourceKind;physicalFulfillment:boolean|null;paid:boolean|null;cancelled:boolean;fulfillmentScope:IntakeObservationInput['fulfillmentScope']}
interface ContractRow {proof_id:string;contract_version:number;approved_snapshot_id:string|null;material_conflict:boolean}
const SOURCE_KINDS = ['API_OBSERVED','BROWSER_CAPTURED','FORWARDED_EMAIL','SELLER_DECLARED'];
const fail = (code:string,message:string,status=409):never => {throw new DomainError(code,message,status);};
function clean(value:unknown,max=2000):string|null {if(value==null||value==='')return null;if(typeof value!=='string'||value.length>max)fail('INVALID_INTAKE_CONTEXT','Order context contains an invalid text field',400);return String(value).trim()||null;}
function required(value:unknown,field:string,max=200):string {const result=clean(value,max);if(!result)fail('INVALID_INTAKE_CONTEXT',`${field} is required`,400);return result!;}
export function normalizeIntakeObservation(input:IntakeObservationInput):IntakeObservationInput {
 if(!input||typeof input!=='object'||!SOURCE_KINDS.includes(input.sourceKind))fail('INVALID_INTAKE_CONTEXT','A recognized intake source is required',400);
 if(!Array.isArray(input.items)||input.items.length>200)fail('INVALID_INTAKE_CONTEXT','An order must contain at most 200 item rows',400);
 const items=input.items.map(item=>{
  if(!item||typeof item!=='object')fail('INVALID_INTAKE_CONTEXT','Each order item must be an object',400);
  if(item.quantity!=null&&(!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>1000000))fail('INVALID_INTAKE_CONTEXT','Item quantities must be positive whole numbers or missing',400);
  return {title:clean(item.title),description:clean(item.description,4000),quantity:item.quantity??null,sku:clean(item.sku,300),variant:clean(item.variant,1000),externalItemId:clean(item.externalItemId,300)};
 });
 for(const key of ['physicalFulfillment','paid'] as const)if(input[key]!=null&&typeof input[key]!=='boolean')fail('INVALID_INTAKE_CONTEXT',`${key} must be true, false, or unknown`,400);
 if(typeof input.cancelled!=='boolean'||!['FULL_ORDER','PARTIAL','MULTI_PARCEL','UNKNOWN'].includes(input.fulfillmentScope))fail('INVALID_INTAKE_CONTEXT','Order lifecycle and fulfillment scope are required',400);
 const occurred=clean(input.sourceOccurredAt,100);if(occurred&&!Number.isFinite(Date.parse(occurred)))fail('INVALID_INTAKE_CONTEXT','Source time must be an ISO timestamp',400);
 const shipmentReferences=input.shipmentReferences??[];if(!Array.isArray(shipmentReferences)||shipmentReferences.length>100)fail('INVALID_INTAKE_CONTEXT','Too many shipment references',400);
 return {receiptId:required(input.receiptId,'Receipt ID'),sourceKind:input.sourceKind,adapterKey:required(input.adapterKey,'Adapter key'),adapterVersion:required(input.adapterVersion,'Adapter version'),externalOrderId:clean(input.externalOrderId,300),orderReference:clean(input.orderReference,300),items,physicalFulfillment:input.physicalFulfillment??null,paid:input.paid??null,cancelled:input.cancelled,fulfillmentScope:input.fulfillmentScope,sourceRevision:clean(input.sourceRevision,300),sourceOccurredAt:occurred?new Date(occurred).toISOString():null,rawSourceRef:clean(input.rawSourceRef,2000),sourceText:clean(input.sourceText,30000),shipmentReferences:shipmentReferences.map(s=>({carrier:clean(s.carrier,100),trackingNumber:clean(s.trackingNumber,200)}))};
}
export function intakeReadiness(input:IntakeObservationInput):{readiness:IntakeReadiness;reasons:string[]} {
 const reasons:string[]=[];
 if(!input.externalOrderId)reasons.push('EXACT_ORDER_ID_REQUIRED');
 if(!input.items.length)reasons.push('PURCHASED_ITEMS_REQUIRED');
 if(input.items.some(item=>!item.title?.trim()||item.quantity==null))reasons.push('ITEM_DESCRIPTION_AND_QUANTITY_REQUIRED');
 if(input.physicalFulfillment!==true)reasons.push(input.physicalFulfillment===false?'PHYSICAL_ORDER_REQUIRED':'FULFILLMENT_TYPE_REQUIRED');
 if(input.paid!==true)reasons.push(input.paid===false?'PAYMENT_PENDING':'PAYMENT_STATE_REQUIRED');
 if(input.cancelled)reasons.push('ORDER_CANCELLED');
 if(input.fulfillmentScope!=='FULL_ORDER')reasons.push('PARCEL_SCOPE_REQUIRES_REVIEW');
 return {readiness:reasons.length?'NEEDS_INFORMATION':'READY',reasons};
}
function scopeNamespace(scope:IntakeScope):string {
 if(!scope||scope.verified!==true||!['MARKETPLACE_API','STOREFRONT_API','SHIPPING_PROVIDER_API'].includes(scope.namespaceSource))fail('INTAKE_SCOPE_UNVERIFIED','Connect and verify the order source before importing',422);
 required(scope.provider,'Provider',100);required(scope.externalAccountReference,'Store account',200);required(scope.connectionId,'Source connection');
 return tenantKeyForImport(scope.provider,scope.namespaceSource,scope.externalAccountReference);
}
function snapshotView(row:SnapshotRow):IntakeSnapshot {return {id:row.id,version:Number(row.version),digest:row.digest,sha256:row.digest,proofId:row.proof_id,transactionId:row.transaction_id,tenantKey:row.context.tenantKey,readiness:'READY',items:row.context.items,store:row.context.store,orderReference:row.context.orderReference,sourceKind:row.context.sourceKind};}
function materialDigest(context:SnapshotContext):string {return sha256Hex(canonicalize({tenantKey:context.tenantKey,externalOrderId:context.externalOrderId,items:context.items,physicalFulfillment:context.physicalFulfillment,paid:context.paid,cancelled:context.cancelled,fulfillmentScope:context.fulfillmentScope}));}
async function ownedProof(db:Database,actor:string,proofId:string,lock=false) {
 const row=(await db.query<{id:string;transaction_id:string;status:string;workflow_type:string;participation_policy:string}>(`SELECT p.id,p.transaction_id,p.status,p.workflow_type,p.participation_policy FROM proofs p JOIN transactions t ON t.id=p.transaction_id WHERE p.id=$1 AND t.created_by=$2${lock?' FOR UPDATE OF p,t':''}`,[proofId,actor])).rows[0];
 if(!row)fail('INTAKE_ORDER_NOT_FOUND','Order does not belong to this account',404);return row!;
}
async function currentContract(db:Database,proofId:string,lock=false) {return (await db.query<ContractRow>(`SELECT * FROM proof_order_contexts WHERE proof_id=$1${lock?' FOR UPDATE':''}`,[proofId])).rows[0]??null;}
async function storedSnapshot(db:Database,id:string) {const row=(await db.query<SnapshotRow>('SELECT * FROM intake_order_snapshots WHERE id=$1',[id])).rows[0];if(!row)fail('INTAKE_SNAPSHOT_NOT_FOUND','The prepared order snapshot is unavailable',404);return row!;}
export async function getIntakeSnapshot(db:Database,actor:string,id:string):Promise<IntakeSnapshot> {const row=await storedSnapshot(db,id);await ownedProof(db,actor,row.proof_id);return snapshotView(row);}
export async function readApprovedIntakeSnapshot(db:Database,actor:string,id:string):Promise<IntakeSnapshot> {
 await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
 const row=await storedSnapshot(db,id);const proof=await ownedProof(db,actor,row.proof_id,true);const contract=await currentContract(db,row.proof_id,true);
 if(proof.status==='FINALIZED')fail('PROOF_ALREADY_FINALIZED','This Proof is already complete');
 if(await commerceLifecycleNeedsReview(db,row.transaction_id,'capture'))fail('ORDER_FULFILLMENT_CONFLICT','The current order payment or fulfillment scope needs review before recording',422);
 if(!contract||contract.material_conflict||contract.approved_snapshot_id!==id)fail('INTAKE_SNAPSHOT_STALE','This order changed. Review the prepared order before recording');
 if(sha256Hex(canonicalize(row.context))!==row.digest)fail('INTAKE_CONTEXT_CORRUPT','The retained order context failed its integrity check',500);
 return snapshotView(row);
}
export async function admitIntakeProofContract(db:Database,clock:Clock,actor:string,proofId:string):Promise<void> {
 const proof=await ownedProof(db,actor,proofId);
 if(proof.workflow_type!=='COMMERCE_SALE'||proof.participation_policy!=='COUNTERPARTY_OPTIONAL'||proof.status==='FINALIZED')return;
 await db.query('INSERT INTO proof_order_contexts(proof_id,contract_version,admitted_at) VALUES($1,1,$2) ON CONFLICT(proof_id) DO NOTHING',[proofId,clock.now().toISOString()]);
}
export async function submitIntakeObservation(db:Database,clock:Clock,actor:string,untrusted:IntakeObservationInput,scope:IntakeScope):Promise<IntakeResult> {
 const input=normalizeIntakeObservation(untrusted);const tenantKey=scopeNamespace(scope);const sourceDigest=sha256Hex(canonicalize({input,tenantKey,connectionId:scope.connectionId}));
 return db.transaction(async tx=>{
  // Serialize intake with the existing importer for this owner; DB identity uniqueness remains authoritative.
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
  const replay=(await tx.query<{source_digest:string;result:IntakeResult}>(`SELECT o.source_digest,r.result FROM intake_source_observations o JOIN intake_delivery_receipts r ON r.observation_id=o.id WHERE o.actor_user_id=$1 AND o.connection_id=$2 AND o.receipt_id=$3`,[actor,scope.connectionId,input.receiptId])).rows[0];
  if(replay){if(replay.source_digest!==sourceDigest)fail('INTAKE_RECEIPT_CONFLICT','This receipt was already used for different order context');return {...replay.result,replayed:true};}
  const observationId=newId('intake_obs');const now=clock.now().toISOString();
  await tx.query(`INSERT INTO intake_source_observations(id,actor_user_id,connection_id,receipt_id,source_kind,adapter_key,adapter_version,tenant_key,external_order_id,source_revision,source_occurred_at,received_at,raw_source_ref,source_digest,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,[observationId,actor,scope.connectionId,input.receiptId,input.sourceKind,input.adapterKey,input.adapterVersion,tenantKey,input.externalOrderId,input.sourceRevision??null,input.sourceOccurredAt??null,now,input.rawSourceRef??null,sourceDigest,JSON.stringify(input)]);
  const readiness=intakeReadiness(input);let transactionId:string|null=null;let proofId:string|null=null;let snapshot:IntakeSnapshot|null=null;
  const identity=input.externalOrderId?(await tx.query<{transaction_id:string;created_by:string}>('SELECT i.transaction_id,t.created_by FROM transaction_integration_identities i JOIN transactions t ON t.id=i.transaction_id WHERE i.tenant_key=$1 AND i.external_transaction_id=$2',[tenantKey,input.externalOrderId])).rows[0]:null;
  if(identity&&identity.created_by!==actor){readiness.readiness='QUARANTINED';readiness.reasons=['ORDER_SCOPE_CONFLICT'];}
  else if(identity||readiness.readiness==='READY') {
   if(identity)transactionId=identity.transaction_id;
   else {
    const imported=await importNormalizedTransaction(tx,clock,actor,{provider:scope.provider,externalAccountReference:scope.externalAccountReference,externalTransactionId:input.externalOrderId,externalReference:input.orderReference,transactionDate:null,itemTitle:input.items[0]?.title??null,itemDescription:input.items[0]?.description??null,quantity:input.items.reduce((n,i)=>n+(i.quantity??0),0),transactionValue:null,currency:null,items:input.items.map((item,index)=>({...item,position:index+1,description:[item.description,item.variant].filter(Boolean).join(' · ')||null})),shipping:null,buyer:null,provenance:{source:scope.namespaceSource,sourceRecordId:observationId,importedAt:now}},{createProof:true,adapterKey:input.adapterKey,identityTenantKey:tenantKey,...(input.sourceKind!=='API_OBSERVED'?{provenanceOverride:'PARTICIPANT_SUPPLIED' as const}:{})});
    transactionId=imported.transaction.transactionId;proofId=imported.proof?.proofId??null;
    if(proofId)await admitIntakeProofContract(tx,clock,actor,proofId);
   }
   if(!proofId){const existing=(await tx.query<{id:string}>('SELECT id FROM proofs WHERE transaction_id=$1',[transactionId])).rows[0];proofId=existing?.id??null;if(!proofId&&readiness.readiness==='READY'){proofId=(await createOrGetProof(tx,clock,actor,transactionId!)).proofId;await admitIntakeProofContract(tx,clock,actor,proofId);}}
   if(proofId){
    const proof=await ownedProof(tx,actor,proofId,true);const contract=await currentContract(tx,proofId,true);const current=contract?.approved_snapshot_id?await storedSnapshot(tx,contract.approved_snapshot_id):null;
    const context:SnapshotContext={tenantKey,store:clean(scope.store,300)??scope.externalAccountReference,orderReference:input.orderReference??input.externalOrderId!,externalOrderId:input.externalOrderId,items:input.items,sourceKind:input.sourceKind,physicalFulfillment:input.physicalFulfillment,paid:input.paid,cancelled:input.cancelled,fulfillmentScope:input.fulfillmentScope};
    const digest=sha256Hex(canonicalize(context));const material=materialDigest(context);
    const previousSameSource=(await tx.query<{source_occurred_at:string|Date|null;source_revision:string|null}>(`SELECT o.source_occurred_at,o.source_revision FROM intake_source_observations o JOIN intake_delivery_receipts r ON r.observation_id=o.id WHERE o.actor_user_id=$1 AND o.connection_id=$2 AND o.tenant_key=$3 AND o.external_order_id=$4 AND r.readiness='READY' ORDER BY o.received_at DESC LIMIT 1`,[actor,scope.connectionId,tenantKey,input.externalOrderId])).rows[0];
    const oldRevision=previousSameSource?.source_revision;const newRevision=input.sourceRevision;const numericallyOlder=oldRevision&&newRevision&&/^\d+$/.test(oldRevision)&&/^\d+$/.test(newRevision)&&BigInt(newRevision)<BigInt(oldRevision);
    // Only compare timestamps within one verified connection; email receive time never outranks an API revision.
    const older=Boolean(numericallyOlder||(previousSameSource?.source_occurred_at&&input.sourceOccurredAt&&new Date(input.sourceOccurredAt).getTime()<new Date(previousSameSource.source_occurred_at).getTime()));
    if(proof.workflow_type!=='COMMERCE_SALE'||proof.participation_policy!=='COUNTERPARTY_OPTIONAL'){readiness.readiness='NEEDS_INFORMATION';readiness.reasons=['INTAKE_WORKFLOW_UNSUPPORTED'];}
    else if(proof.status==='FINALIZED'){readiness.readiness='ARCHIVED';readiness.reasons=['POST_FINALIZATION_OBSERVATION'];}
    else if(older){readiness.readiness='ARCHIVED';readiness.reasons=['OLDER_SOURCE_REVISION'];}
    else if(current&&materialConflict(current.context,context)){readiness.readiness='NEEDS_INFORMATION';readiness.reasons=[...new Set([...readiness.reasons,'ORDER_CONTEXT_CHANGED'])];await tx.query('UPDATE proof_order_contexts SET material_conflict=true WHERE proof_id=$1',[proofId]);}
    else if(contract?.material_conflict){readiness.readiness='NEEDS_INFORMATION';readiness.reasons.push('ORDER_CONTEXT_REVIEW_REQUIRED');}
    else if(readiness.readiness==='READY'){
     if(identity&&!current){const known=await loadTransactionView(tx,transactionId!);if(known.items.length&&itemsConflict(known.items,input.items)){readiness.readiness='NEEDS_INFORMATION';readiness.reasons=['EXISTING_ORDER_CONTEXT_CONFLICT'];}}
     if(readiness.readiness!=='READY'){/* Retain the conflict without changing the existing order. */}
     else if(current)snapshot=snapshotView(current);
     else {
      // Existing orders keep their established Proof contract; only new admissions receive v1.
      const version=Number((await tx.query<{n:string}>('SELECT COALESCE(MAX(version),0)+1 AS n FROM intake_order_snapshots WHERE proof_id=$1',[proofId])).rows[0].n);
      const id=newId('order_snapshot');
      const row=(await tx.query<SnapshotRow>(`INSERT INTO intake_order_snapshots(id,transaction_id,proof_id,version,digest,material_digest,context,observation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,[id,transactionId,proofId,version,digest,material,JSON.stringify(context),observationId,now])).rows[0];
      await tx.query('INSERT INTO proof_order_contexts(proof_id,contract_version,approved_snapshot_id,admitted_at) VALUES($1,0,$2,$3) ON CONFLICT(proof_id) DO UPDATE SET approved_snapshot_id=EXCLUDED.approved_snapshot_id',[proofId,id,now]);snapshot=snapshotView(row);
     }
    }
    await appendAudit(tx,{proofId,actorUserId:actor,eventType:'ORDER_CONTEXT_OBSERVED',eventData:{observationId,sourceKind:input.sourceKind,sourceDigest,readiness:readiness.readiness,reasons:readiness.reasons,snapshotId:snapshot?.id??null},at:clock.now()});
   }
  }
  const result:IntakeResult={observationId,...readiness,transactionId,proofId,snapshot,replayed:false};
  await tx.query('INSERT INTO intake_delivery_receipts(observation_id,actor_user_id,transaction_id,proof_id,readiness,result,processed_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[observationId,actor,transactionId,proofId,readiness.readiness,JSON.stringify(result),now]);return result;
 });
}

export async function prepareExistingIntakeOrder(db:Database,clock:Clock,actor:string,transactionId:string,options:{requireContract?:boolean}={}):Promise<IntakeResult> {
 return db.transaction(async tx=>{
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
  const transaction=await loadTransactionView(tx,transactionId);if(transaction.createdBy!==actor)fail('INTAKE_ORDER_NOT_FOUND','Order does not belong to this account',404);
  if(transaction.proofId){
   const proof=await ownedProof(tx,actor,transaction.proofId,true);if(proof.workflow_type!=='COMMERCE_SALE'||proof.participation_policy!=='COUNTERPARTY_OPTIONAL')fail('INTAKE_WORKFLOW_UNSUPPORTED','This intake workflow is for merchant orders',422);
   if(options.requireContract)await admitIntakeProofContract(tx,clock,actor,proof.id);
   const current=await currentContract(tx,proof.id,true);
   if(current?.approved_snapshot_id){const row=await storedSnapshot(tx,current.approved_snapshot_id);const lifecycleReview=await commerceLifecycleNeedsReview(tx,transactionId,'capture');return {observationId:row.observation_id,readiness:proof.status==='FINALIZED'?'ARCHIVED':current.material_conflict||lifecycleReview?'NEEDS_INFORMATION':'READY',reasons:proof.status==='FINALIZED'?['PROOF_ALREADY_FINALIZED']:current.material_conflict?['ORDER_CONTEXT_REVIEW_REQUIRED']:lifecycleReview?['ORDER_FULFILLMENT_REVIEW_REQUIRED']:[],transactionId,proofId:proof.id,snapshot:snapshotView(row),replayed:true};}
  }
  const identity=(await tx.query<{tenant_key:string;external_transaction_id:string;source:string}>('SELECT tenant_key,external_transaction_id,source FROM transaction_integration_identities WHERE transaction_id=$1 ORDER BY created_at ASC LIMIT 1',[transactionId])).rows[0];
  const order=(await tx.query<{payment_state:string;fulfillment_state:string;requires_physical_fulfillment:boolean;cancelled:boolean;connection_id:string}>('SELECT payment_state,fulfillment_state,requires_physical_fulfillment,cancelled,connection_id FROM commerce_order_records WHERE transaction_id=$1 ORDER BY last_seen_at DESC LIMIT 1',[transactionId])).rows[0];
  const metadata=transaction.metadata as {intakeDeclaration?:{physicalFulfillment?:boolean;paid?:boolean;fulfillmentScope?:IntakeObservationInput['fulfillmentScope']}}|null;const declaration=metadata?.intakeDeclaration;
  // Bind the existing owned manual transaction even while context is incomplete, so correction cannot create a second transaction.
  const namespace=identity?.tenant_key??`marketplace:packproof:${actor.toLowerCase()}`;const parts=namespace.split(':');
  const input:IntakeObservationInput={receiptId:`prepare:${transactionId}:${sha256Hex(canonicalize({items:transaction.items,order:order??null,declaration:declaration??null}))}`,sourceKind:identity&&identity.source!=='PARTICIPANT_SUPPLIED'?'API_OBSERVED':'SELLER_DECLARED',adapterKey:'existing-order-context',adapterVersion:'1',externalOrderId:identity?.external_transaction_id??transactionId,orderReference:transaction.externalReference,items:transaction.items.map(item=>({title:item.title,description:item.description,quantity:item.quantity,sku:item.sku,externalItemId:item.externalItemId,variant:null})),physicalFulfillment:order?.requires_physical_fulfillment??declaration?.physicalFulfillment??null,paid:order?(order.payment_state==='UNKNOWN'?null:order.payment_state==='CONFIRMED'):declaration?.paid??null,cancelled:order?order.cancelled||order.fulfillment_state==='CANCELLED':false,fulfillmentScope:order?(order.fulfillment_state==='AWAITING_FULFILLMENT'?'FULL_ORDER':order.fulfillment_state==='IN_PROGRESS'?'PARTIAL':'UNKNOWN'):declaration?.fulfillmentScope??'UNKNOWN'};
  if(!identity)await tx.query(`INSERT INTO transaction_integration_identities(id,transaction_id,tenant_key,external_transaction_id,adapter_key,source,created_at) VALUES($1,$2,$3,$4,'existing-order-context','PARTICIPANT_SUPPLIED',$5)`,[newId('tii'),transactionId,namespace,transactionId,clock.now().toISOString()]);
  return submitIntakeObservation(tx,clock,actor,input,{provider:parts[1],externalAccountReference:parts.slice(2).join(':'),namespaceSource:parts[0]==='storefront'?'STOREFRONT_API':parts[0]==='shipping'?'SHIPPING_PROVIDER_API':'MARKETPLACE_API',connectionId:order?.connection_id??`existing:${transactionId}`,store:parts.slice(2).join(':'),verified:true});
 });
}
export async function listIntakeOrders(db:Database,actor:string):Promise<IntakeResult[]> {
 const rows=(await db.query<{result:IntakeResult;status:string|null;material_conflict:boolean|null;approved_snapshot_id:string|null}>(`SELECT r.result,p.status,c.material_conflict,c.approved_snapshot_id FROM intake_delivery_receipts r LEFT JOIN proofs p ON p.id=r.proof_id LEFT JOIN proof_order_contexts c ON c.proof_id=r.proof_id WHERE r.actor_user_id=$1 AND r.readiness IN ('READY','NEEDS_INFORMATION','QUARANTINED') ORDER BY r.processed_at DESC,r.observation_id DESC LIMIT 200`,[actor])).rows;
 const seen=new Set<string>();const results:IntakeResult[]=[];
 for(const row of rows){if(row.status==='FINALIZED')continue;const key=row.result.proofId??row.result.transactionId??row.result.observationId;if(seen.has(key))continue;seen.add(key);if(row.approved_snapshot_id&&!row.material_conflict){const snapshot=await storedSnapshot(db,row.approved_snapshot_id);const review=await commerceLifecycleNeedsReview(db,snapshot.transaction_id,'capture');results.push({...row.result,readiness:review?'NEEDS_INFORMATION':'READY',reasons:review?['ORDER_FULFILLMENT_REVIEW_REQUIRED']:[],snapshot:snapshotView(snapshot)});continue;}results.push(row.material_conflict?{...row.result,readiness:'NEEDS_INFORMATION',reasons:[...new Set([...row.result.reasons,'ORDER_CONTEXT_REVIEW_REQUIRED'])]}:row.result);}
 return results;
}
export async function pinIntakeSnapshotForCapture(db:Database,clock:Clock,actor:string,sessionId:string,snapshotId:string):Promise<IntakeSnapshot> {
 const snapshot=await readApprovedIntakeSnapshot(db,actor,snapshotId);
 const session=(await db.query<{proof_id:string;order_snapshot_id:string|null;state:string;workflow_step:string}>('SELECT proof_id,order_snapshot_id,state,workflow_step FROM capture_sessions WHERE id=$1 AND actor_user_id=$2 FOR UPDATE',[sessionId,actor])).rows[0];
 if(!session||session.proof_id!==snapshot.proofId||session.workflow_step!=='PACKING')fail('INTAKE_CAPTURE_MISMATCH','This recording belongs to a different order');
 if(session!.order_snapshot_id){if(session!.order_snapshot_id!==snapshotId)fail('INTAKE_CAPTURE_IMMUTABLE','This recording is already bound to its original order');return snapshot;}
 if(session!.state!=='ISSUED')fail('INTAKE_CAPTURE_ALREADY_STARTED','Order context must be accepted before recording');
 await db.query('UPDATE capture_sessions SET order_snapshot_id=$2,order_snapshot_version=$3,order_snapshot_sha256=$4 WHERE id=$1',[sessionId,snapshotId,snapshot.version,snapshot.digest]);
 await appendAudit(db,{proofId:snapshot.proofId,actorUserId:actor,eventType:'ORDER_CONTEXT_PINNED',eventData:{sessionId,snapshotId,version:snapshot.version,digest:snapshot.digest,transactionId:snapshot.transactionId},at:clock.now()});return snapshot;
}
export async function pinCurrentIntakeCaptureContext(db:Database,clock:Clock,actor:string,proofId:string,sessionId:string):Promise<void> {
 let contract=await currentContract(db,proofId,true);if(!contract)return;
 if(!contract.approved_snapshot_id&&contract.contract_version===1){const proof=await ownedProof(db,actor,proofId);await prepareExistingIntakeOrder(db,clock,actor,proof.transaction_id);contract=await currentContract(db,proofId,true);}
 if(!contract?.approved_snapshot_id)fail('ORDER_CONTEXT_REQUIRED','Complete the purchased items and fulfillment details before recording',422);
 await pinIntakeSnapshotForCapture(db,clock,actor,sessionId,contract.approved_snapshot_id!);
}
export async function readIntakeProofContext(db:Database,proofId:string):Promise<{contractVersion:number;snapshot:IntakeSnapshot|null;materialConflict:boolean}|null> {
 const contract=await currentContract(db,proofId);if(!contract)return null;
 return {contractVersion:Number(contract.contract_version),snapshot:contract.approved_snapshot_id?snapshotView(await storedSnapshot(db,contract.approved_snapshot_id)):null,materialConflict:contract.material_conflict};
}
export async function assertIntakeFinalizeContext(db:Database,proofId:string):Promise<Record<string,unknown>|undefined> {
 const contract=await currentContract(db,proofId,true);if(!contract||contract.contract_version===0)return undefined;
 if(contract.material_conflict)fail('ORDER_CONTEXT_CONFLICT','The order changed after preparation. Resolve the order context before finalizing',422);
 if(!contract.approved_snapshot_id)fail('ORDER_CONTEXT_REQUIRED','A retained order context is required for this Proof',422);
 const snapshot=await storedSnapshot(db,contract.approved_snapshot_id!);
 if(sha256Hex(canonicalize(snapshot.context))!==snapshot.digest)fail('INTAKE_CONTEXT_CORRUPT','The retained order context failed its integrity check',500);
 const source=(await db.query<{source_digest:string;source_kind:IntakeSourceKind;adapter_key:string;adapter_version:string;context:IntakeObservationInput;tenant_key:string;connection_id:string}>('SELECT source_digest,source_kind,adapter_key,adapter_version,context,tenant_key,connection_id FROM intake_source_observations WHERE id=$1',[snapshot.observation_id])).rows[0];
 if(!source||sha256Hex(canonicalize({input:source.context,tenantKey:source.tenant_key,connectionId:source.connection_id}))!==source.source_digest||intakeReadiness(source.context).readiness!=='READY')fail('ORDER_SOURCE_REQUIRED','The complete original order context must remain retained',422);
 if(await commerceLifecycleNeedsReview(db,snapshot.transaction_id,'finalize'))fail('ORDER_FULFILLMENT_CONFLICT','The current order lifecycle needs review before finalization',422);
 const captures=(await db.query<{order_snapshot_id:string|null;order_snapshot_version:number|null;order_snapshot_sha256:string|null}>(`SELECT c.order_snapshot_id,c.order_snapshot_version,c.order_snapshot_sha256 FROM evidence e LEFT JOIN capture_sessions c ON c.id=e.capture_session_id WHERE e.proof_id=$1 AND e.validation_status='COMMITTED' AND e.evidence_type='FULFILLMENT_CAPTURE'`,[proofId])).rows;
 if(!captures.length||captures.some(c=>c.order_snapshot_id!==snapshot.id||Number(c.order_snapshot_version)!==Number(snapshot.version)||c.order_snapshot_sha256!==snapshot.digest))fail('ORDER_CAPTURE_CONTEXT_REQUIRED','The packing recording must retain its accepted order context',422);
 return {contractVersion:1,snapshotId:snapshot.id,snapshotVersion:Number(snapshot.version),snapshotSha256:snapshot.digest,transactionId:snapshot.transaction_id,items:snapshot.context.items,store:snapshot.context.store,orderReference:snapshot.context.orderReference,source:{observationId:snapshot.observation_id,kind:source.source_kind,adapterKey:source.adapter_key,adapterVersion:source.adapter_version,sha256:source.source_digest}};
}

/** Existing API refreshes must also invalidate a new-contract order when material facts disagree. */
export async function recordImportedIntakeConflict(db:Database,proofId:string,parsed:{items:Array<{title:string|null;quantity:number|null;sku:string|null}>}):Promise<void> {
 const contract=await currentContract(db,proofId);if(!contract?.approved_snapshot_id)return;
 const proof=(await db.query<{status:string}>('SELECT status FROM proofs WHERE id=$1',[proofId])).rows[0];if(proof?.status==='FINALIZED')return;
 const current=await storedSnapshot(db,contract.approved_snapshot_id);
 if(parsed.items.length&&itemsConflict(current.context.items,parsed.items))await db.query('UPDATE proof_order_contexts SET material_conflict=true WHERE proof_id=$1',[proofId]);
}
function itemsConflict(a:IntakeItem[],b:IntakeItem[]):boolean {
 if(a.length!==b.length)return true;
 return a.some((item,i)=>{const other=b[i];return item.title!==other.title||item.quantity!==other.quantity||Boolean(item.variant&&other.variant&&item.variant!==other.variant)||Boolean(item.sku&&other.sku&&item.sku!==other.sku);});
}
function materialConflict(a:SnapshotContext,b:SnapshotContext):boolean {return a.tenantKey!==b.tenantKey||a.externalOrderId!==b.externalOrderId||a.physicalFulfillment!==b.physicalFulfillment||a.paid!==b.paid||a.cancelled!==b.cancelled||a.fulfillmentScope!==b.fulfillmentScope||itemsConflict(a.items,b.items);}
export async function resolveIntakeIssue(db:Database,clock:Clock,actor:string,observationId:string,input:{receiptId:string;items?:IntakeItem[];physicalFulfillment?:boolean;paid?:boolean;fulfillmentScope?:IntakeObservationInput['fulfillmentScope'];reason:string}):Promise<IntakeResult> {
 required(input.reason,'Reason for this correction',1000);
 return db.transaction(async tx=>{
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
  const row=(await tx.query<{context:IntakeObservationInput;tenant_key:string;connection_id:string;transaction_id:string|null;proof_id:string|null}>(`SELECT o.context,o.tenant_key,o.connection_id,r.transaction_id,r.proof_id FROM intake_source_observations o JOIN intake_delivery_receipts r ON r.observation_id=o.id WHERE o.id=$1 AND o.actor_user_id=$2`,[observationId,actor])).rows[0];
  if(!row||!row.context.externalOrderId)fail('INTAKE_EXACT_IDENTITY_REQUIRED','Resolve the exact store and order identity before correcting item details',422);
  if(row!.proof_id){const existingProof=await ownedProof(tx,actor,row!.proof_id,true);if(existingProof.status==='FINALIZED')fail('PROOF_ALREADY_FINALIZED','This Proof is already complete');if((await tx.query('SELECT 1 FROM capture_sessions WHERE proof_id=$1 AND order_snapshot_id IS NOT NULL LIMIT 1',[row!.proof_id])).rows.length)fail('ORDER_CAPTURE_CONTEXT_LOCKED','This recording keeps its original order context. Preserve it and record the correct order separately');}
  const corrected=normalizeIntakeObservation({...row!.context,receiptId:required(input.receiptId,'Correction receipt'),sourceKind:'SELLER_DECLARED',adapterKey:'seller-order-resolution',adapterVersion:'1',items:input.items??row!.context.items,physicalFulfillment:input.physicalFulfillment??row!.context.physicalFulfillment,paid:input.paid??row!.context.paid,fulfillmentScope:input.fulfillmentScope??row!.context.fulfillmentScope,rawSourceRef:null,sourceText:null});
  if(intakeReadiness(corrected).readiness!=='READY')fail('ORDER_CONTEXT_INCOMPLETE','The correction must identify every purchased item, quantity, payment and physical fulfillment scope',422);
  const parts=row!.tenant_key.split(':');const namespaceSource=parts[0]==='storefront'?'STOREFRONT_API':parts[0]==='shipping'?'SHIPPING_PROVIDER_API':'MARKETPLACE_API';
  const scope:IntakeScope={provider:parts[1],externalAccountReference:parts.slice(2).join(':'),namespaceSource,connectionId:`seller-resolution:${actor}`,store:parts.slice(2).join(':'),verified:true};
  const result=await submitIntakeObservation(tx,clock,actor,corrected,scope);
  if(!result.proofId)fail('INTAKE_EXACT_IDENTITY_REQUIRED','The corrected context still needs an authorized exact order identity',422);
  const proof=await ownedProof(tx,actor,result.proofId!,true);
  if(result.readiness==='READY'&&result.snapshot){if(!result.replayed)await appendAudit(tx,{proofId:proof.id,actorUserId:actor,eventType:'ORDER_CONTEXT_RESOLVED',eventData:{observationId:result.observationId,snapshotId:result.snapshot.id,reason:input.reason,provenance:'SELLER_DECLARED'},at:clock.now()});return result;}
  const existingResolved=(await tx.query<SnapshotRow>('SELECT * FROM intake_order_snapshots WHERE proof_id=$1 AND observation_id=$2',[proof.id,result.observationId])).rows[0];
  if(existingResolved)return {...result,readiness:'READY',reasons:[],snapshot:snapshotView(existingResolved),replayed:true};
  // Reuse the authorized importer to update still-unrecorded transaction context, preserving seller provenance.
  await importNormalizedTransaction(tx,clock,actor,{provider:scope.provider,externalAccountReference:scope.externalAccountReference,externalTransactionId:corrected.externalOrderId,externalReference:corrected.orderReference,transactionDate:null,itemTitle:corrected.items[0].title,itemDescription:null,quantity:corrected.items.reduce((n,i)=>n+(i.quantity??0),0),transactionValue:null,currency:null,items:corrected.items,shipping:null,buyer:null,provenance:{source:namespaceSource,sourceRecordId:result.observationId,importedAt:clock.now().toISOString()}},{adapterKey:'seller-order-resolution',identityTenantKey:row!.tenant_key,provenanceOverride:'PARTICIPANT_SUPPLIED'});
  const context:SnapshotContext={tenantKey:row!.tenant_key,store:scope.store!,orderReference:corrected.orderReference??corrected.externalOrderId!,externalOrderId:corrected.externalOrderId,items:corrected.items,sourceKind:'SELLER_DECLARED',physicalFulfillment:corrected.physicalFulfillment,paid:corrected.paid,cancelled:corrected.cancelled,fulfillmentScope:corrected.fulfillmentScope};
  const version=Number((await tx.query<{n:string}>('SELECT COALESCE(MAX(version),0)+1 AS n FROM intake_order_snapshots WHERE proof_id=$1',[proof.id])).rows[0].n);const id=newId('order_snapshot');
  const retained=(await tx.query<SnapshotRow>('SELECT * FROM intake_order_snapshots WHERE proof_id=$1 AND digest=$2',[proof.id,sha256Hex(canonicalize(context))])).rows[0];
  const snapshot=retained??(await tx.query<SnapshotRow>('INSERT INTO intake_order_snapshots(id,transaction_id,proof_id,version,digest,material_digest,context,observation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *',[id,proof.transaction_id,proof.id,version,sha256Hex(canonicalize(context)),materialDigest(context),JSON.stringify(context),result.observationId,clock.now().toISOString()])).rows[0];
  await tx.query('INSERT INTO proof_order_contexts(proof_id,contract_version,approved_snapshot_id,admitted_at) VALUES($1,0,$2,$3) ON CONFLICT(proof_id) DO UPDATE SET approved_snapshot_id=EXCLUDED.approved_snapshot_id,material_conflict=false',[proof.id,snapshot.id,clock.now().toISOString()]);
  await appendAudit(tx,{proofId:proof.id,actorUserId:actor,eventType:'ORDER_CONTEXT_RESOLVED',eventData:{observationId:result.observationId,snapshotId:snapshot.id,version:snapshot.version,reason:input.reason,provenance:'SELLER_DECLARED'},at:clock.now()});
  return {...result,readiness:'READY',reasons:[],snapshot:snapshotView(snapshot)};
 });
}

async function commerceLifecycleNeedsReview(db:Database,transactionId:string,phase:'capture'|'finalize'):Promise<boolean> {
 const rows=(await db.query<{cancelled:boolean;payment_state:string;requires_physical_fulfillment:boolean;fulfillment_state:string}>('SELECT cancelled,payment_state,requires_physical_fulfillment,fulfillment_state FROM commerce_order_records WHERE transaction_id=$1',[transactionId])).rows;
 // FULFILLED may be normal provider progression after accepted capture; it never starts a new automatic capture.
 const allowed=phase==='capture'?['AWAITING_FULFILLMENT']:['AWAITING_FULFILLMENT','FULFILLED'];
 return rows.some(order=>order.cancelled||!order.requires_physical_fulfillment||order.payment_state!=='CONFIRMED'||!allowed.includes(order.fulfillment_state));
}
/** Run before the capture transaction so a failed start leaves a durable, owner-linked resolution card. */
export async function prepareIntakeCaptureEntry(db:Database,clock:Clock,actor:string,proofId:string):Promise<void> {
 const contract=await currentContract(db,proofId);if(contract?.contract_version!==1||contract.approved_snapshot_id)return;
 const proof=await ownedProof(db,actor,proofId);const prepared=await prepareExistingIntakeOrder(db,clock,actor,proof.transaction_id);
 if(prepared.readiness!=='READY')fail('ORDER_CONTEXT_REQUIRED','Complete the prepared order card before recording',422);
}
