import { readImportMetadata } from './provenance.js';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { DomainError } from './errors.js';
import { loadProof, requireParticipant, assertNotFinalized } from './proof-access.js';
import { appendAudit } from './audit.js';

const unsupported = () => new DomainError('PARCEL_SCOPE_UNSUPPORTED', 'Split, partial, replacement and multi-parcel orders are outside this pilot. Do not record them as a single complete shipment.', 409);
/** No inference of completeness from a tracking number or free-text correction. */
export async function assertSupportedParcelCapture(db:Database, transactionId:string) {
  const order = (await db.query<{normalized_order:Record<string,any>}>(`SELECT r.normalized_order FROM commerce_order_records o JOIN commerce_order_revisions r ON r.order_record_id=o.id AND r.fingerprint=o.normalized_fingerprint WHERE o.transaction_id=$1 ORDER BY r.observed_at DESC LIMIT 1`,[transactionId])).rows[0]?.normalized_order;
  const metadata=(await db.query<{transaction_metadata:unknown}>('SELECT transaction_metadata FROM transactions WHERE id=$1',[transactionId])).rows[0]?.transaction_metadata;
  if(readImportMetadata(metadata)?.providerIdentifiers?.pilotCaptureExclusion)throw unsupported();
  if (order) {
    if(order.pilotCaptureExclusion)throw unsupported();
    const packages=Array.isArray(order.packages)?order.packages:[];
    if(order.fulfillmentState==='IN_PROGRESS'||order.cancelled||packages.length>1)throw unsupported();
    const items=Array.isArray(order.items)?order.items:[];
    if(items.some((i:any)=>!Number.isSafeInteger(i.quantity)||i.quantity<1||(i.remainingQuantity!=null&&i.remainingQuantity!==i.quantity)))throw unsupported();
    if(packages.length===1 && packages[0].lineItems?.length) {
      const quantities=new Map(items.map((i:any)=>[i.externalItemId,i.quantity]));
      const seen=new Set();
      for(const line of packages[0].lineItems) {if(!line.id||seen.has(line.id)||quantities.get(line.id)!==line.quantity)throw unsupported();seen.add(line.id);}
      if(seen.size!==items.length)throw unsupported();
    }
  }
  const existing=(await db.query<{order_snapshot_sha256:string}>('SELECT order_snapshot_sha256 FROM proof_parcel_scopes WHERE transaction_id=$1',[transactionId])).rows[0];
  if(existing && existing.order_snapshot_sha256!==sha256Hex(canonicalize(await itemSnapshot(db,transactionId))))throw new DomainError('PARCEL_ORDER_REVISION_REQUIRED','The order changed after parcel allocation. An authorized allocation revision is required before recording.',409);
}
async function itemSnapshot(db:Database,transactionId:string) {
  const items=(await db.query<{id:string;quantity:string|number|null}>('SELECT id,quantity FROM transaction_items WHERE transaction_id=$1 ORDER BY position,id',[transactionId])).rows;
  if(items.length)return items.map(i=>({itemId:i.id,quantity:i.quantity==null?null:Number(i.quantity)}));
  const t=(await db.query<{quantity:string|number|null}>('SELECT quantity FROM transactions WHERE id=$1',[transactionId])).rows[0];
  return [{itemId:'legacy-summary',quantity:t?.quantity==null?null:Number(t.quantity)}];
}
export async function declareSingleParcel(db:Database,clock:Clock,actor:string,proofId:string,input:Record<string,unknown>) {
  await requireParticipant(db,proofId,actor,'SELLER');const proof=await loadProof(db,proofId);
  if(input.parcelCount!==1||input.direction!=='OUTBOUND'||!Array.isArray(input.allocations)||input.allocations.length>200)throw unsupported();
  return db.transaction(async tx=>{
    await tx.query('SELECT id FROM transactions WHERE id=$1 FOR UPDATE',[proof.transaction_id]);
    await assertSupportedParcelCapture(tx,proof.transaction_id);
    const snapshot=await itemSnapshot(tx,proof.transaction_id);
    if(snapshot.some(i=>!Number.isSafeInteger(i.quantity)||Number(i.quantity)<1))throw new DomainError('PARCEL_QUANTITY_REQUIRED','Record a positive authorized order quantity before allocating this parcel.',409);
    const allocations=(input.allocations as any[]).map(i=>({itemId:i?.itemId,quantity:i?.quantity}));
    if(allocations.length!==snapshot.length||new Set(allocations.map(i=>i.itemId)).size!==snapshot.length||snapshot.some(i=>!allocations.some(a=>a.itemId===i.itemId&&a.quantity===i.quantity)))throw unsupported();
    const previous=(await tx.query('SELECT * FROM proof_parcel_scopes WHERE proof_id=$1',[proofId])).rows[0];
    if(previous)return previous;
    assertNotFinalized(await loadProof(tx,proofId));
    const parcelId=newId('parcel'),digest=sha256Hex(canonicalize(snapshot));
    const row=(await tx.query(`INSERT INTO proof_parcel_scopes(proof_id,parcel_id,transaction_id,actor_user_id,order_snapshot_sha256,allocations,assurance,declared_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,'SELLER_DECLARED_SINGLE_PARCEL',$7) RETURNING *`,[proofId,parcelId,proof.transaction_id,actor,digest,canonicalize(snapshot),clock.now().toISOString()])).rows[0];
    await appendAudit(tx,{proofId,actorUserId:actor,eventType:'PARCEL_SCOPE_DECLARED',eventData:{parcelId,orderSnapshotSha256:digest,allocations:snapshot,assurance:'SELLER_DECLARED_SINGLE_PARCEL'},at:clock.now()});return row;
  });
}
export async function getParcelScope(db:Database,actor:string,proofId:string){await requireParticipant(db,proofId,actor);const proof=await loadProof(db,proofId);return {labelObservations:(await db.query(`SELECT o.id,o.session_id AS "sessionId",o.tracking_number AS "trackingNumber",o.carrier_hint AS "carrierHint",o.detected_at_ms AS "detectedAtMs",o.received_at AS "receivedAt",(l.id IS NOT NULL) AS associated FROM capture_label_observations o LEFT JOIN capture_shipping_labels l ON l.session_id=o.session_id AND l.tracking_number=o.tracking_number WHERE o.proof_id=$1 ORDER BY o.received_at`,[proofId])).rows,scope:(await db.query('SELECT * FROM proof_parcel_scopes WHERE proof_id=$1',[proofId])).rows[0]??null,orderItems:await itemSnapshot(db,proof.transaction_id),supportedParcelCount:1,limitations:'Single outbound parcel only. A label observation does not verify item allocation.'};}
