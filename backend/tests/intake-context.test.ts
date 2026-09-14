import { createIntegrationConnection } from '../src/domain/integration-connections.js';
import { upsertCommerceOrderRecord,bindCommerceOrderTransaction } from '../src/domain/commerce-order-records.js';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { createHarness,createUser,commitFulfillmentAndAttest,type TestHarness } from './helpers.js';
import { submitIntakeObservation,listIntakeOrders,readApprovedIntakeSnapshot,assertIntakeFinalizeContext,prepareExistingIntakeOrder,admitIntakeProofContract,resolveIntakeIssue,normalizeIntakeObservation,type IntakeObservationInput,type IntakeScope } from '../src/intake/context.js';
import { createCaptureSession } from '../src/domain/capture-sessions.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { importNormalizedTransaction } from '../src/domain/transaction-import.js';

describe('immutable shared order intake contract',()=>{
 let h:TestHarness;let actor:string;let other:string;
 const scope:IntakeScope={provider:'ebay',externalAccountReference:'seller-store',namespaceSource:'MARKETPLACE_API',connectionId:'api-connection',store:'Seller store',verified:true};
 const source=(overrides:Partial<IntakeObservationInput>={}):IntakeObservationInput=>({receiptId:'sale-1',sourceKind:'API_OBSERVED',adapterKey:'ebay-orders',adapterVersion:'1',externalOrderId:'order-123',orderReference:'12-34567-89012',items:[{title:'Camera lens',quantity:2,variant:'Black'},{title:'Lens case',quantity:1}],physicalFulfillment:true,paid:true,cancelled:false,fulfillmentScope:'FULL_ORDER',sourceRevision:'1',sourceOccurredAt:'2026-09-08T12:00:00Z',...overrides});
 beforeEach(async()=>{h=await createHarness();actor=await createUser(h);other=await createUser(h);});
 afterEach(async()=>{await h.close();});
 it('serializes three intake sources and retries into one exact transaction and Proof while retaining every observation',async()=>{
  const results=await Promise.all(['API_OBSERVED','BROWSER_CAPTURED','FORWARDED_EMAIL'].map((kind,index)=>submitIntakeObservation(h.db,h.clock,actor,source({sourceKind:kind as IntakeObservationInput['sourceKind'],receiptId:`receipt-${index}`}),{...scope,connectionId:`connection-${index}`})));
  expect(new Set(results.map(result=>result.proofId)).size).toBe(1);expect(new Set(results.map(result=>result.transactionId)).size).toBe(1);expect(results.every(result=>result.readiness==='READY')).toBe(true);
  expect((await h.db.query('SELECT id FROM intake_source_observations')).rows).toHaveLength(3);
  const replay=await submitIntakeObservation(h.db,h.clock,actor,source({receiptId:'receipt-0'}),{...scope,connectionId:'connection-0'});expect(replay.replayed).toBe(true);expect(replay.snapshot?.id).toBe(results[0].snapshot?.id);
  await expect(submitIntakeObservation(h.db,h.clock,actor,source({receiptId:'receipt-0',items:[{title:'Another lens',quantity:1}]}),{...scope,connectionId:'connection-0'})).rejects.toMatchObject({code:'INTAKE_RECEIPT_CONFLICT'});
  expect(await listIntakeOrders(h.db,other)).toEqual([]);
 });
 it('keeps display references separate across stores and refuses missing quantity, unknown identity or unverified scope',async()=>{
  const first=await submitIntakeObservation(h.db,h.clock,actor,source(),scope);
  const second=await submitIntakeObservation(h.db,h.clock,actor,source(),{...scope,externalAccountReference:'another-store',connectionId:'another-connection'});expect(second.proofId).not.toBe(first.proofId);
  const missing=await submitIntakeObservation(h.db,h.clock,actor,source({receiptId:'missing',externalOrderId:null,items:[{title:'Lens',quantity:null}]}),scope);expect(missing.readiness).toBe('NEEDS_INFORMATION');expect(missing.proofId).toBeNull();
  await expect(submitIntakeObservation(h.db,h.clock,actor,source(),{...scope,verified:false as true})).rejects.toMatchObject({code:'INTAKE_SCOPE_UNVERIFIED'});
  const wrongOwner=await submitIntakeObservation(h.db,h.clock,other,source(),scope);expect(wrongOwner.readiness).toBe('QUARANTINED');expect(wrongOwner.transactionId).toBeNull();
  await expect(readApprovedIntakeSnapshot(h.db,other,first.snapshot!.id)).rejects.toMatchObject({code:'INTAKE_ORDER_NOT_FOUND'});
 });
 it('pins recording context once, retains conflicts, ignores older revisions and cannot weaken the durable guard',async()=>{
  const admitted=await submitIntakeObservation(h.db,h.clock,actor,source(),scope);const proofId=admitted.proofId!;
  const capture=await createCaptureSession(h.db,h.clock,actor,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'capture'});expect(capture.orderSnapshotId).toBe(admitted.snapshot?.id);
  await expect(assertIntakeFinalizeContext(h.db,proofId)).rejects.toMatchObject({code:'ORDER_CAPTURE_CONTEXT_REQUIRED'});
  const older=await submitIntakeObservation(h.db,h.clock,actor,source({receiptId:'old',sourceRevision:'0',sourceOccurredAt:'2026-09-07T12:00:00Z',items:[{title:'Old item',quantity:1}]}),scope);expect(older.readiness).toBe('ARCHIVED');
  const changed=await submitIntakeObservation(h.db,h.clock,actor,source({receiptId:'changed',sourceRevision:'2',items:[{title:'Wrong lens',quantity:1}]}),scope);expect(changed.readiness).toBe('NEEDS_INFORMATION');
  await expect(assertIntakeFinalizeContext(h.db,proofId)).rejects.toMatchObject({code:'ORDER_CONTEXT_CONFLICT'});
  await expect(h.db.query('UPDATE proof_order_contexts SET contract_version=0 WHERE proof_id=$1',[proofId])).rejects.toThrow('ORDER_CONTRACT_IMMUTABLE');
  await expect(h.db.query('UPDATE intake_order_snapshots SET digest=$2 WHERE id=$1',[admitted.snapshot!.id,'0'.repeat(64)])).rejects.toThrow('INTAKE_CONTEXT_IMMUTABLE');
  expect((await createCaptureSession(h.db,h.clock,actor,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'capture'})).id).toBe(capture.id);
 });
 it('seals the exact accepted source without raw correspondence and keeps later updates outside the original manifest',async()=>{
  const admitted=await submitIntakeObservation(h.db,h.clock,actor,source({sourceKind:'FORWARDED_EMAIL',rawSourceRef:'private/raw/message.eml'}),scope);
  expect((await h.db.query<{source:string}>('SELECT source FROM transaction_integration_identities WHERE transaction_id=$1',[admitted.transactionId])).rows[0].source).toBe('PARTICIPANT_SUPPLIED');
  await commitFulfillmentAndAttest(h,actor,admitted.proofId!);const final=await finalizeProof(h.db,h.clock,actor,admitted.proofId!);
  expect((final.manifest.manifest as any).orderContext.snapshotSha256).toBe(admitted.snapshot?.digest);expect(final.manifest.canonicalJson).not.toContain('private/raw');
  const update=await submitIntakeObservation(h.db,h.clock,actor,source({receiptId:'after',cancelled:true}),scope);expect(update.readiness).toBe('ARCHIVED');
  expect((await finalizeProof(h.db,h.clock,actor,admitted.proofId!)).manifest.canonicalJson).toBe(final.manifest.canonicalJson);
 });
 it('resolves a pre-capture item conflict visibly and blocks a conflicting existing API refresh',async()=>{
  const first=await submitIntakeObservation(h.db,h.clock,actor,source(),scope);
  const changed=await submitIntakeObservation(h.db,h.clock,actor,source({receiptId:'changed',items:[{title:'Correct lens',quantity:1}]}),scope);
  const resolved=await resolveIntakeIssue(h.db,h.clock,actor,changed.observationId,{receiptId:'resolution-1',reason:'Checked the purchased order against the source'});expect(resolved.readiness).toBe('READY');expect(resolved.snapshot!.version).toBe(2);
  expect((await listIntakeOrders(h.db,actor))[0]).toMatchObject({readiness:'READY',snapshot:{id:resolved.snapshot!.id}});
  const capture=await createCaptureSession(h.db,h.clock,actor,first.proofId!,{client:'NATIVE_CAMERA',idempotencyKey:'after-resolve'});expect(capture.orderSnapshotId).toBe(resolved.snapshot!.id);
  await importNormalizedTransaction(h.db,h.clock,actor,{provider:'ebay',externalAccountReference:'seller-store',externalTransactionId:'order-123',transactionDate:null,itemTitle:'API item changed',itemDescription:null,quantity:3,transactionValue:null,currency:null,items:[{title:'API item changed',quantity:3}],shipping:null,provenance:{source:'MARKETPLACE_API',importedAt:h.clock.now().toISOString()}},{createProof:true});
  await expect(assertIntakeFinalizeContext(h.db,first.proofId!)).rejects.toMatchObject({code:'ORDER_CONTEXT_CONFLICT'});
 });
 it('allows explicit missing facts on an exact scoped observation and admits only one new packing session',async()=>{
  const incomplete=await submitIntakeObservation(h.db,h.clock,actor,source({items:[{title:'Lens',quantity:null}],physicalFulfillment:null,paid:null,fulfillmentScope:'UNKNOWN'}),scope);expect(incomplete.proofId).toBeNull();
  const resolved=await resolveIntakeIssue(h.db,h.clock,actor,incomplete.observationId,{receiptId:'complete-order',items:[{title:'Lens',quantity:1}],physicalFulfillment:true,paid:true,fulfillmentScope:'FULL_ORDER',reason:'Confirmed the purchase details'});expect(resolved.readiness).toBe('READY');
  await createCaptureSession(h.db,h.clock,actor,resolved.proofId!,{client:'NATIVE_CAMERA',idempotencyKey:'one'});
  await expect(createCaptureSession(h.db,h.clock,actor,resolved.proofId!,{client:'WEB_CAMERA',idempotencyKey:'two'})).rejects.toMatchObject({code:'INTAKE_CAPTURE_IN_PROGRESS'});
 });
 it('prepares actual CONFIRMED commerce orders and permits FULFILLED progression only after accepted packing',async()=>{
  const imported=await importNormalizedTransaction(h.db,h.clock,actor,{provider:'ebay',externalAccountReference:'seller-store',externalTransactionId:'provider-order',transactionDate:null,itemTitle:'Lens',itemDescription:null,quantity:1,transactionValue:null,currency:null,items:[{title:'Lens',quantity:1}],shipping:null,provenance:{source:'MARKETPLACE_API',importedAt:h.clock.now().toISOString()}},{createProof:true});
  const connection=await createIntegrationConnection(h.db,h.clock,actor,{adapterKey:'ebay',provider:'ebay',externalAccountReference:'seller-store',credentialReference:'reference:test'});
  const record=await upsertCommerceOrderRecord(h.db,h.clock,{connectionId:connection.connectionId,commerceTenantKey:'marketplace:ebay:seller-store',externalOrderId:'provider-order',externalReference:'provider-order',orderedAt:null,paymentState:'CONFIRMED',fulfillmentState:'AWAITING_FULFILLMENT',requiresPhysicalFulfillment:true,cancelled:false,eligibility:'FULFILLMENT_ELIGIBLE',providerUpdatedAt:null,fingerprint:'fixture'});await bindCommerceOrderTransaction(h.db,record.id,imported.transaction.transactionId);
  await admitIntakeProofContract(h.db,h.clock,actor,imported.proof!.proofId);
  const prepared=await prepareExistingIntakeOrder(h.db,h.clock,actor,imported.transaction.transactionId);expect(prepared.readiness).toBe('READY');
  await commitFulfillmentAndAttest(h,actor,prepared.proofId!);
  await h.db.query("UPDATE commerce_order_records SET fulfillment_state='FULFILLED' WHERE id=$1",[record.id]);
  await expect(readApprovedIntakeSnapshot(h.db,actor,prepared.snapshot!.id)).rejects.toMatchObject({code:'ORDER_FULFILLMENT_CONFLICT'});
  const final=await finalizeProof(h.db,h.clock,actor,prepared.proofId!);expect((final.manifest.manifest as any).orderContext.snapshotId).toBe(prepared.snapshot!.id);
 });
 it('holds partial, completed, cancelled, unknown and unconfirmed provider orders for review',async()=>{
  const transaction=await createTransaction(h.db,h.clock,actor,{itemTitle:'Lens',quantity:1});const proof=await createOrGetProof(h.db,h.clock,actor,transaction.transactionId);await admitIntakeProofContract(h.db,h.clock,actor,proof.proofId);
  const connection=await createIntegrationConnection(h.db,h.clock,actor,{adapterKey:'ebay',provider:'ebay',externalAccountReference:'seller-store',credentialReference:'reference:test'});
  const record=await upsertCommerceOrderRecord(h.db,h.clock,{connectionId:connection.connectionId,commerceTenantKey:'marketplace:ebay:seller-store',externalOrderId:'ineligible-order',externalReference:'ineligible-order',orderedAt:null,paymentState:'CONFIRMED',fulfillmentState:'IN_PROGRESS',requiresPhysicalFulfillment:true,cancelled:false,eligibility:'FULFILLMENT_ELIGIBLE',providerUpdatedAt:null,fingerprint:'fixture'});await bindCommerceOrderTransaction(h.db,record.id,transaction.transactionId);
  for(const state of ['IN_PROGRESS','FULFILLED','CANCELLED','UNKNOWN']){await h.db.query('UPDATE commerce_order_records SET fulfillment_state=$2 WHERE id=$1',[record.id,state]);const prepared=await prepareExistingIntakeOrder(h.db,h.clock,actor,transaction.transactionId);expect(prepared.readiness).toBe('NEEDS_INFORMATION');expect(prepared.proofId).toBe(proof.proofId);}
  await h.db.query("UPDATE commerce_order_records SET fulfillment_state='AWAITING_FULFILLMENT',payment_state='UNKNOWN' WHERE id=$1",[record.id]);const unknown=await prepareExistingIntakeOrder(h.db,h.clock,actor,transaction.transactionId);expect(unknown.reasons).toContain('PAYMENT_STATE_REQUIRED');
 });
 it('persists incomplete manual capture preparation and resolves the original v1 Proof without duplicate orders',async()=>{
  const transaction=await createTransaction(h.db,h.clock,actor,{itemTitle:'Manual lens'});const proof=await createOrGetProof(h.db,h.clock,actor,transaction.transactionId);await admitIntakeProofContract(h.db,h.clock,actor,proof.proofId);
  await expect(createCaptureSession(h.db,h.clock,actor,proof.proofId,{client:'NATIVE_CAMERA',idempotencyKey:'manual-start'})).rejects.toMatchObject({code:'ORDER_CONTEXT_REQUIRED'});
  const prepared=(await listIntakeOrders(h.db,actor))[0];expect(prepared).toMatchObject({readiness:'NEEDS_INFORMATION',transactionId:transaction.transactionId,proofId:proof.proofId});
  expect((await h.db.query('SELECT id FROM capture_sessions WHERE proof_id=$1',[proof.proofId])).rows).toHaveLength(0);
  const resolved=await resolveIntakeIssue(h.db,h.clock,actor,prepared.observationId,{receiptId:'manual-correction',items:[{title:'Manual lens',quantity:1}],physicalFulfillment:true,paid:true,fulfillmentScope:'FULL_ORDER',reason:'Supplied the exact order facts'});expect(resolved.proofId).toBe(proof.proofId);expect(resolved.transactionId).toBe(transaction.transactionId);
  expect((await h.db.query('SELECT id FROM transactions WHERE created_by=$1',[actor])).rows).toHaveLength(1);expect((await createCaptureSession(h.db,h.clock,actor,proof.proofId,{client:'NATIVE_CAMERA',idempotencyKey:'manual-start'})).orderSnapshotId).toBe(resolved.snapshot!.id);
 });
 it('keeps peer Proofs outside the merchant contract even when the owner is enrolled',async()=>{
  await h.db.query('INSERT INTO intake_contract_cohorts(owner_user_id,enabled) VALUES($1,true)',[actor]);
  const peerTransaction=await createTransaction(h.db,h.clock,actor,{itemTitle:'Peer exchange'});const peer=await createOrGetProof(h.db,h.clock,actor,peerTransaction.transactionId,{participationPolicy:'COUNTERPARTY_REQUIRED'});await admitIntakeProofContract(h.db,h.clock,actor,peer.proofId);expect((await h.db.query('SELECT proof_id FROM proof_order_contexts WHERE proof_id=$1',[peer.proofId])).rows).toHaveLength(0);
  const merchantTransaction=await createTransaction(h.db,h.clock,actor,{itemTitle:'Merchant order'});const merchant=await createOrGetProof(h.db,h.clock,actor,merchantTransaction.transactionId);expect((await h.db.query('SELECT contract_version FROM proof_order_contexts WHERE proof_id=$1',[merchant.proofId])).rows[0]).toMatchObject({contract_version:1});
 });
 it('preserves historical Proof manifests and rejects invalid item values without inventing missing facts',async()=>{
  const transaction=await createTransaction(h.db,h.clock,actor,{itemTitle:'Historical order'});const proof=await createOrGetProof(h.db,h.clock,actor,transaction.transactionId);
  await commitFulfillmentAndAttest(h,actor,proof.proofId);const final=await finalizeProof(h.db,h.clock,actor,proof.proofId);expect((final.manifest.manifest as any).orderContext).toBeUndefined();
  expect(()=>normalizeIntakeObservation(source({items:[{title:'Lens',quantity:-1}]}))).toThrow();
  expect(normalizeIntakeObservation(source({items:[{title:'Lens',quantity:null}]})).items[0].quantity).toBeNull();
 });
});
