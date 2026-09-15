import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { canonicalize } from '../canonical.js';
import { DomainError } from '../domain/errors.js';
import { appendAudit } from '../domain/audit.js';
import { createAccessLink, type ProofAccessLinkRow } from '../domain/access-links.js';
import { disclosureContextForLink, getDisclosureProjection } from '../domain/disclosure.js';
import { requireParticipant } from '../domain/proof-access.js';
import { record, textField, requireTenantOwner, type ApiPrincipal } from './tenants.js';

const identifierKeys = ['proofId','externalTransactionId','orderId','trackingNumber','ticketReference'] as const;
type Identifier = typeof identifierKeys[number];
interface ClaimInput { ticketId:string; workerReference:string; identifiers:Partial<Record<Identifier,string>>; }
interface Authorization { id:string; proof_id:string; access_link_id:string; external_id:string; }
const unavailable = () => new DomainError('CLAIMS_PROOF_UNAVAILABLE','No approved Proof is available for this request',404);

export function parseClaimInput(input:unknown, requireIdentifier=true):ClaimInput {
  const body=record(input);
  // Account scope always comes from the API key. Email is deliberately not a search key.
  const allowed=new Set(['ticketId','workerId',...identifierKeys]);
  if(Object.keys(body).some(key=>!allowed.has(key)))throw new DomainError('INVALID_REQUEST','Use only documented ticket and order identifiers',400);
  const identifiers:ClaimInput['identifiers']={};
  for(const key of identifierKeys) if(body[key]!=null && body[key]!=='') {
    const value=textField(body[key],key,200);
    identifiers[key]=key==='trackingNumber'?value.replace(/[\s-]/g,'').toUpperCase():value;
  }
  if(requireIdentifier && !Object.keys(identifiers).length)throw new DomainError('CLAIMS_IDENTIFIER_REQUIRED','Add an order reference, tracking number or Proof ID',400);
  return {ticketId:textField(body.ticketId,'ticketId',100),workerReference:sha256Hex(textField(body.workerId,'workerId',100)),identifiers};
}

export async function authorizeClaimsProof(db:Database,clock:Clock,userId:string,tenantId:string,proofId:string,input:unknown) {
  const body=record(input);
  if(Object.keys(body).some(key=>!['accessLinkId','externalId'].includes(key)))throw new DomainError('INVALID_REQUEST','Provide the reviewed sharing grant and order reference',400);
  const linkId=textField(body.accessLinkId,'accessLinkId');
  const externalId=textField(body.externalId,'externalId');
  return db.transaction(async tx=>{
    await requireTenantOwner(tx,userId,tenantId);
    await requireParticipant(tx,proofId,userId,'SELLER');
    await tx.query('SELECT id FROM proofs WHERE id=$1 FOR UPDATE',[proofId]);
    const link=(await tx.query<ProofAccessLinkRow>('SELECT * FROM proof_access_links WHERE id=$1 AND proof_id=$2 AND revoked_at IS NULL AND expires_at>$3',[linkId,proofId,clock.now().toISOString()])).rows[0];
    if(!link || (await tx.query('SELECT 1 FROM claims_viewer_sessions WHERE access_link_id=$1',[linkId])).rows.length)throw unavailable();
    const ctx=await disclosureContextForLink(tx,link,clock.now());
    if(!['SHARED_PROOF','CLAIMS_REVIEW'].includes(ctx.purpose))throw new DomainError('CLAIMS_REVIEW_REQUIRED','Approve a shared Proof or claims review link first',409);
    const old=(await tx.query<Authorization>('SELECT * FROM claims_authorizations WHERE tenant_id=$1 AND proof_id=$2 AND revoked_at IS NULL',[tenantId,proofId])).rows[0];
    if(old){
      if(old.access_link_id!==linkId || old.external_id!==externalId)throw new DomainError('CLAIMS_AUTHORIZATION_CONFLICT','Revoke the existing claims authorization before replacing it',409);
      return {authorizationId:old.id,proofId,externalId};
    }
    const id=newId('cau');
    await tx.query('INSERT INTO claims_authorizations(id,tenant_id,proof_id,external_id,access_link_id,approved_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,tenantId,proofId,externalId,linkId,userId,clock.now().toISOString()]);
    await appendAudit(tx,{proofId,actorUserId:userId,eventType:'CLAIMS_ACCESS_AUTHORIZED',eventData:{authorizationId:id,tenantId,accessLinkId:linkId},at:clock.now()});
    return {authorizationId:id,proofId,externalId};
  });
}

export async function revokeClaimsAuthorization(db:Database,clock:Clock,userId:string,tenantId:string,id:string) {
  return db.transaction(async tx=>{
    await requireTenantOwner(tx,userId,tenantId);
    const row=(await tx.query<{proof_id:string}>('UPDATE claims_authorizations SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND tenant_id=$2 RETURNING proof_id',[id,tenantId,clock.now().toISOString()])).rows[0];
    if(!row)throw unavailable();
    await appendAudit(tx,{proofId:row.proof_id,actorUserId:userId,eventType:'CLAIMS_ACCESS_REVOKED',eventData:{authorizationId:id,tenantId},at:clock.now()});
  });
}

async function auditLookup(db:Database,clock:Clock,p:ApiPrincipal,input:ClaimInput,requestId:string,operation:string,count:number) {
  await db.query('INSERT INTO claims_access_events(id,tenant_id,key_id,request_id,operation,ticket_id,worker_reference,identifier_types,result_count,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)',
    [newId('cae'),p.tenantId,p.keyId,requestId,operation,input.ticketId,input.workerReference,JSON.stringify(Object.keys(input.identifiers)),count,clock.now().toISOString()]);
}
const activeSql=`FROM claims_authorizations a JOIN proof_access_links l ON l.id=a.access_link_id
 JOIN proofs p ON p.id=a.proof_id JOIN transactions t ON t.id=p.transaction_id
 LEFT JOIN transaction_shipping s ON s.transaction_id=t.id
 WHERE a.tenant_id=$1 AND a.revoked_at IS NULL AND l.revoked_at IS NULL AND l.expires_at>$2`;

export async function lookupClaims(db:Database,clock:Clock,p:ApiPrincipal,body:unknown,requestId:string) {
  const input=parseClaimInput(body);
  const params:unknown[]=[p.tenantId,clock.now().toISOString()];
  const conditions=Object.entries(input.identifiers).map(([key,value])=>{
    params.push(value);const ref=`$${params.length}`;
    if(key==='proofId')return `p.id=${ref}`;
    if(key==='trackingNumber')return `upper(regexp_replace(s.tracking_number,'[[:space:]-]','','g'))=${ref}`;
    return `(a.external_id=${ref} OR t.external_reference=${ref} OR EXISTS(SELECT 1 FROM commerce_order_records c WHERE c.transaction_id=t.id AND c.external_order_id=${ref}))`;
  });
  // All supplied identifiers must agree. A strong ID never overrides a conflicting shipment.
  const rows=(await db.query<Authorization>(`SELECT a.id,a.proof_id,a.access_link_id,a.external_id ${activeSql} AND ${conditions.join(' AND ')} ORDER BY p.created_at DESC,p.id LIMIT 21`,params)).rows;
  const matches:Array<{proofId:string}&Record<string,unknown>>=[];
  for(const a of rows.slice(0,20)) {
    const link=(await db.query<ProofAccessLinkRow>('SELECT * FROM proof_access_links WHERE id=$1',[a.access_link_id])).rows[0];
    const ctx=await disclosureContextForLink(db,link,clock.now());
    const view=await getDisclosureProjection(db,ctx);
    const manifest=(await db.query<{canonical_json:string;sha256:string}>('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1',[a.proof_id])).rows[0];
    const integrity=!manifest?'NOT_FINALIZED':sha256Hex(manifest.canonical_json)===manifest.sha256?'MANIFEST_HASH_MATCH':'MANIFEST_HASH_MISMATCH';
    const shipment=ctx.fields.includes('shipping')?(await db.query<{carrier:string|null;tracking_number:string|null}>('SELECT s.carrier,s.tracking_number FROM transaction_shipping s JOIN proofs p ON p.transaction_id=s.transaction_id WHERE p.id=$1',[a.proof_id])).rows[0]:null;
    matches.push({proofId:a.proof_id,match:{type:'EXACT_IDENTIFIERS',identifiers:Object.keys(input.identifiers)},status:view.status,
      integrity:{result:integrity,scope:'Stored canonical manifest bytes; media and real-world contents are not reverified by lookup'},
      order:ctx.fields.includes('order')?{reference:a.external_id,itemTitle:view.tracker.itemTitle}:null,
      shipment:shipment?{carrier:shipment.carrier,trackingNumber:shipment.tracking_number}:null,
      roles:ctx.fields.includes('statements')?[...new Set(view.statements.map(s=>s.attributedTo))]:[],
      evidenceSummary:{sharedRecordings:view.evidence.length},timeline:view.chronology.slice(-12),tracking:view.recordTracking,
      openUrl:`/v1/claims/proofs/${a.proof_id}/open`});
  }
  await db.transaction(async tx=>{
    await auditLookup(tx,clock,p,input,requestId,'LOOKUP',rows.length);
    for(const match of matches)await appendAudit(tx,{proofId:match.proofId,actorUserId:p.userId,eventType:'CLAIMS_LOOKUP_MATCHED',eventData:{tenantId:p.tenantId,keyId:p.keyId,ticketId:input.ticketId,workerReference:input.workerReference,requestId},at:clock.now()});
  });
  return {requestId,result:matches.length===0?'NOT_FOUND':rows.length===1?'FOUND':'MULTIPLE_MATCHES',matches,hasMore:rows.length>20};
}

export async function openClaimsProof(db:Database,clock:Clock,p:ApiPrincipal,proofId:string,body:unknown,requestId:string,webBase:string) {
  const input=parseClaimInput(body,false);
  if(Object.keys(input.identifiers).length)throw new DomainError('INVALID_REQUEST','Open the selected Proof using ticket and worker context only',400);
  return db.transaction(async tx=>{
    const a=(await tx.query<Authorization>(`SELECT a.id,a.proof_id,a.access_link_id,a.external_id ${activeSql} AND a.proof_id=$3 FOR UPDATE OF a`,[p.tenantId,clock.now().toISOString(),proofId])).rows[0];
    if(!a)throw unavailable();
    const parent=(await tx.query<ProofAccessLinkRow>('SELECT * FROM proof_access_links WHERE id=$1 FOR UPDATE',[a.access_link_id])).rows[0];
    const ctx=await disclosureContextForLink(tx,parent,clock.now());
    const expiresAt=new Date(Math.min(clock.now().getTime()+15*60_000,new Date(parent.expires_at!).getTime())).toISOString();
    const link=await createAccessLink(tx,clock,p.userId,proofId,{scope:parent.scope,expiresAt,publicWebBaseUrl:webBase});
    await tx.query('INSERT INTO proof_disclosure_grants(access_link_id,scope_version,policy_version,purpose,fields,media,preview_hash,created_by_user_id,created_at) VALUES($1,1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)',
      [link.accessLinkId,ctx.policyVersion,ctx.purpose,JSON.stringify(ctx.fields),JSON.stringify(ctx.media),sha256Hex(canonicalize({parent:parent.id,scopeVersion:ctx.scopeVersion})),p.userId,clock.now().toISOString()]);
    await tx.query('INSERT INTO claims_viewer_sessions(access_link_id,authorization_id,key_id,ticket_id,worker_reference,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[link.accessLinkId,a.id,p.keyId,input.ticketId,input.workerReference,requestId,clock.now().toISOString()]);
    await auditLookup(tx,clock,p,input,requestId,'VIEWER_ISSUED',1);
    await appendAudit(tx,{proofId,actorUserId:p.userId,eventType:'CLAIMS_VIEWER_ISSUED',eventData:{tenantId:p.tenantId,keyId:p.keyId,accessLinkId:link.accessLinkId,ticketId:input.ticketId,requestId},at:clock.now()});
    return {proofId,viewerUrl:link.url,expiresAt,requestId};
  });
}
