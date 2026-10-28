import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { createTransaction } from '../domain/transactions.js';
import { appendAudit } from '../domain/audit.js';
import { insertTransactionItems } from '../domain/transaction-items.js';
import { summarizeItems } from '../domain/normalized-fulfillment-order.js';
import { parsePartnerOrderItems } from './partner-order-items.js';
import { createOrGetProof } from '../domain/create-proof.js';
import { getProofView } from '../domain/proofs.js';
import { issueIntent } from '../capture/service.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { textField } from './tenants.js';
import { strictBody, reauthorizePartner, authorizePartnerProof, auditOrganization, type PartnerActor } from './organizations.js';
import { requireOrganizationProofAccess } from './organization-access.js';

export async function importPartnerOrder(db:Database,clock:Clock,actor:PartnerActor,input:unknown){
 const body=strictBody(input,['integrationAccountId','externalId','operatorMembershipId','transaction']);
 const accountId=textField(body.integrationAccountId,'integrationAccountId'),externalId=textField(body.externalId,'externalId',200),membershipId=textField(body.operatorMembershipId,'operatorMembershipId');
 const order=strictBody(body.transaction,['itemTitle','itemDescription','quantity','shipping','amount','items']);
 const items=parsePartnerOrderItems(order.items);
 const summary=items.length?summarizeItems(items.slice().sort((a,b)=>a.position-b.position)):null;
 const itemTitle=textField(order.itemTitle??summary?.itemTitle,'itemTitle',200);
 if(summary&&order.quantity!==undefined&&order.quantity!==summary.quantity)throw new DomainError('INVALID_TRANSACTION_ITEMS','Summary quantity must equal the sum of authoritative item quantities',400);
 const quantity=order.quantity??summary?.quantity??1;
 const itemDescription=order.itemDescription??summary?.itemDescription;
 if(order.shipping!==undefined&&order.shipping!==null)strictBody(order.shipping,['carrier','service','trackingNumber','shipmentDate']);
 if(order.quantity!==undefined&&(!Number.isSafeInteger(order.quantity)||Number(order.quantity)<1||Number(order.quantity)>100000))throw new DomainError('INVALID_REQUEST','quantity must be a positive bounded integer',400);
 if(order.amount!==undefined){const amount=strictBody(order.amount,['minorUnits','currency']);if(typeof amount.minorUnits!=='string'||!/^\d{1,20}$/.test(amount.minorUnits)||typeof amount.currency!=='string'||!/^[A-Z]{3}$/.test(amount.currency))throw new DomainError('INVALID_AMOUNT','Use integer minorUnits as a decimal string and a three-letter currency',400);}
 const snapshotSha256=sha256Hex(canonicalize(order));
 return db.transaction(async tx=>{
  await reauthorizePartner(tx,clock,actor,'proofs:write');
  // Serialize competing import keys within the merchant, with permanent business
  // uniqueness independent of the replay window.
  await tx.query('SELECT pg_advisory_xact_lock(1347438147,hashtext($1))',[actor.merchantId]);
  const account=await tx.query('SELECT 1 FROM platform_integration_accounts WHERE id=$1 AND merchant_id=$2 AND environment=$3',[accountId,actor.merchantId,actor.environment]);
  if(!account.rows[0])throw new DomainError('INTEGRATION_NOT_FOUND','Integration account not found',404);
  const old=(await tx.query<{proof_id:string;snapshot_sha256:string}>(`SELECT proof_id,snapshot_sha256 FROM platform_external_bindings WHERE merchant_id=$1 AND environment=$2 AND integration_account_id=$3 AND resource_type='ORDER' AND external_id=$4`,[actor.merchantId,actor.environment,accountId,externalId])).rows[0];
  if(old){if(old.snapshot_sha256!==snapshotSha256)throw new DomainError('EXTERNAL_ID_CONFLICT','This order is bound to a different immutable snapshot; append a correction explicitly',409);
    const assignment=await authorizePartnerProof(tx,clock,actor,old.proof_id,'proofs:read');
    if(assignment.operator_membership_id!==membershipId)throw new DomainError('OPERATOR_ASSIGNMENT_CONFLICT','An existing Proof keeps its recorded operator assignment',409);
    return {proofId:old.proof_id,externalId,created:false};}
  const member=(await tx.query<{user_id:string;organization_id:string}>(`SELECT m.user_id,m.organization_id FROM platform_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.id=$1 AND m.organization_id IN ($2,$3) AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN','OPERATOR') AND u.status='ACTIVE' FOR SHARE OF m,u`,[membershipId,actor.merchantId,actor.principalOrganizationId])).rows[0];
  if(!member)throw new DomainError('OPERATOR_NOT_AUTHORIZED','Assign an active operator in the authorized organization',403);
  if(actor.delegationGrantId){const allowed=await tx.query('SELECT 1 FROM platform_delegations WHERE id=$1 AND operator_ids ? $2',[actor.delegationGrantId,member.user_id]);if(!allowed.rows[0])throw new DomainError('OPERATOR_NOT_AUTHORIZED','This grant does not authorize the selected operator',403);}
  const transaction=await createTransaction(tx,clock,actor.actorUserId,{itemTitle,itemDescription,quantity,shipping:order.shipping,
    metadata:{source:'organization_api',merchantId:actor.merchantId,environment:actor.environment,integrationAccountId:accountId,externalId,
      originPrincipalId:actor.principalId,assignedOperatorId:member.user_id,orderSnapshot:order,orderSnapshotSha256:snapshotSha256}});
  // Authoritative rows precede Proof creation in this same transaction. Neither
  // an interrupted import nor a retry can leave a partially populated root.
  if(items.length)await insertTransactionItems(tx,transaction.transactionId,items,clock.now().toISOString());
  const proof=await createOrGetProof(tx,clock,actor.actorUserId,transaction.transactionId,{participationPolicy:'COUNTERPARTY_OPTIONAL',organizationAssignment:{merchantId:actor.merchantId,membershipId}});
  const now=clock.now().toISOString();
  await tx.query('INSERT INTO platform_proof_ownership(proof_id,merchant_id,environment,operator_membership_id,origin_principal_id,origin_delegation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[proof.proofId,actor.merchantId,actor.environment,membershipId,actor.principalId,actor.delegationGrantId,now]);
  await tx.query("INSERT INTO platform_external_bindings(merchant_id,environment,integration_account_id,resource_type,external_id,proof_id,snapshot_sha256,created_at) VALUES($1,$2,$3,'ORDER',$4,$5,$6,$7)",[actor.merchantId,actor.environment,accountId,externalId,proof.proofId,snapshotSha256,now]);
  await tx.query('INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES($1,$2,$3,$4,$5)',[actor.tenantId,`org:${sha256Hex(canonicalize({accountId,externalId}))}`,proof.proofId,snapshotSha256,now]);
  await auditOrganization(tx,clock,{actor,requestId:actor.requestId,operation:'ORDER_IMPORTED',resourceId:proof.proofId});
  return {proofId:proof.proofId,externalId,created:true};
 });
}
export async function resolvePartnerProof(db:Database,clock:Clock,actor:PartnerActor,account:unknown,external:unknown){
 await reauthorizePartner(db,clock,actor,'proofs:read');
 const row=(await db.query<{proof_id:string}>("SELECT proof_id FROM platform_external_bindings WHERE merchant_id=$1 AND environment=$2 AND integration_account_id=$3 AND resource_type='ORDER' AND external_id=$4",[actor.merchantId,actor.environment,textField(account,'integrationAccountId'),textField(external,'externalId')])).rows[0];
 if(!row)throw new DomainError('PROOF_NOT_FOUND','Proof not found',404);return {proofId:row.proof_id};
}
export async function readPartnerProof(db:Database,clock:Clock,actor:PartnerActor,proofId:string){
 await authorizePartnerProof(db,clock,actor,proofId,'proofs:read');
 const proof=await getProofView(db,proofId);
 await auditOrganization(db,clock,{actor,requestId:actor.requestId,operation:'PROOF_READ',resourceId:proofId});
 return {apiVersion:'v1',profile:'packproof.partner/v1',merchantId:actor.merchantId,environment:actor.environment,proof};
}
export async function requestOperatorCapture(db:Database,clock:Clock,actor:PartnerActor,proofId:string,input:unknown){
 const b=strictBody(input,['allowedSurfaces']);
 const allowedSurfaces=b.allowedSurfaces??['WEB','ANDROID'];
 if(!Array.isArray(allowedSurfaces)||!allowedSurfaces.length||allowedSurfaces.some(x=>!['WEB','ANDROID'].includes(x)))throw new DomainError('UNSUPPORTED_CAPTURE_SURFACE','The partner pilot supports WEB and ANDROID surfaces',400);
 return db.transaction(async tx=>{
  const ownership=await authorizePartnerProof(tx,clock,actor,proofId,'capture:request');
  await requireOrganizationProofAccess(tx,proofId,ownership.operator_user_id);
  const intent=await issueIntent(tx,clock,ownership.operator_user_id,proofId,allowedSurfaces as never,{serviceActorUserId:actor.actorUserId});
  await tx.query('INSERT INTO platform_capture_authorizations(intent_id,proof_id,merchant_id,environment,credential_id,delegation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[intent.intentId,proofId,actor.merchantId,actor.environment,actor.credentialId,actor.delegationGrantId,clock.now().toISOString()]);
  await auditOrganization(tx,clock,{actor,requestId:actor.requestId,operation:'CAPTURE_REQUESTED',resourceId:intent.intentId});
  return {...intent,proofId,merchantId:actor.merchantId,environment:actor.environment,requiresAuthenticatedAttestation:true};
 });
}
export async function addPartnerBinding(db:Database,clock:Clock,actor:PartnerActor,proofId:string,input:unknown){
 const b=strictBody(input,['integrationAccountId','resourceType','externalId']);
 const accountId=textField(b.integrationAccountId,'integrationAccountId'),externalId=textField(b.externalId,'externalId');
 if(!['PAYMENT','SHIPMENT','RETURN','CLAIM'].includes(String(b.resourceType)))throw new DomainError('INVALID_BINDING','Use a payment, shipment, return or claim binding; orders are bound during import',400);
 return db.transaction(async tx=>{
  await authorizePartnerProof(tx,clock,actor,proofId,'proofs:write');
  const account=await tx.query('SELECT 1 FROM platform_integration_accounts WHERE id=$1 AND merchant_id=$2 AND environment=$3',[accountId,actor.merchantId,actor.environment]);if(!account.rows[0])throw new DomainError('INTEGRATION_NOT_FOUND','Integration account not found',404);
  await tx.query('SELECT pg_advisory_xact_lock(1347438147,hashtext($1))',[actor.merchantId]);
  const prior=(await tx.query<{proof_id:string}>('SELECT proof_id FROM platform_external_bindings WHERE merchant_id=$1 AND environment=$2 AND integration_account_id=$3 AND resource_type=$4 AND external_id=$5',[actor.merchantId,actor.environment,accountId,b.resourceType,externalId])).rows[0];
  if(prior){if(prior.proof_id!==proofId)throw new DomainError('EXTERNAL_ID_CONFLICT','This identity is already bound to another Proof',409);return {proofId,externalId,created:false};}
  await tx.query('INSERT INTO platform_external_bindings(merchant_id,environment,integration_account_id,resource_type,external_id,proof_id,snapshot_sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[actor.merchantId,actor.environment,accountId,b.resourceType,externalId,proofId,sha256Hex(canonicalize({proofId,accountId,externalId,resourceType:b.resourceType})),clock.now().toISOString()]);
  // A binding changes the reconciliation projection even after root finalization.
  // Commit its neutral event beside the source row so a snapshot boundary cannot
  // advance past an undiscoverable later binding. This is an integration assertion,
  // never a human attestation or a mutation of the frozen manifest.
  const auditId=await appendAudit(tx,{proofId,actorUserId:actor.actorUserId,eventType:'EXTERNAL_BINDING_ADDED',
    eventData:{integrationAccountId:accountId,resourceType:b.resourceType,externalId,merchantId:actor.merchantId,
      environment:actor.environment,principalId:actor.principalId,delegationId:actor.delegationGrantId,
      provenance:'INTEGRATION_ASSERTION'},at:clock.now()});
  await tx.query('INSERT INTO proof_outbox(id,proof_id,audit_id,event_type,created_at) VALUES($1,$2,$3,$4,$5)',
    [`${auditId}:proof.external_binding_added`,proofId,auditId,'proof.external_binding_added',clock.now().toISOString()]);
  await auditOrganization(tx,clock,{actor,requestId:actor.requestId,operation:'EXTERNAL_BINDING_CREATED',resourceId:proofId});return {proofId,externalId,created:true};
 });
}
