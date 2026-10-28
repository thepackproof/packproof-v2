import type { ProofSearchState, ProofSearchQuery, ProofSearchItem, ProofSearchResult } from '../../../packages/evidence-contracts/api-dashboard.js';
export type { ProofSearchState, ProofSearchQuery, ProofSearchItem, ProofSearchResult } from '../../../packages/evidence-contracts/api-dashboard.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { requireActiveAccount } from '../domain/account-access.js';
import { assertPolicyAccessSafe } from '../domain/policy-recovery.js';
import { requireDeveloperAccess } from '../auth/developer-access.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { requireScope, type ApiPrincipal } from './tenants.js';
import { reauthorizePartner, authorizePartnerProof, type PartnerActor } from './organizations.js';

export const PROOF_SEARCH_STATES = ['AWAITING_CAPTURE','IN_PROGRESS','READY','NEEDS_ATTENTION'] as const;
interface Parsed {
  q: string; state: ProofSearchState | null; from: string | null; through: string | null;
  connectionId: string | null; integrationAccountId: string | null; limit: number; after: string | null;
}
interface Cursor { v: 1; audience: string; filters: string; lastId: string; expires: number }
interface SearchRow {
  proof_id: string; transaction_id: string; status: string; workflow_type: string;
  created_at: string | Date; updated_at: string | Date; finalized_at: string | Date | null;
  external_id: string | null; item_title: string | null; item_count: string | number;
  tracking_number: string | null; connection_id: string | null; provider: string | null;
  recorded_by: string | null; captured_at: string | Date | null;
  committed_count: string | number; fulfillment_count: string | number; packing_attested: boolean;
  pending_count: string | number; required_count: string | number; preserved_count: string | number;
  failed_count: string | number; missing_count: string | number; has_manifest: boolean;
  active_capture: boolean;
}
const invalid = () => new DomainError('INVALID_PROOF_SEARCH','Use documented search filters and a cursor from this search',400);
function text(value: unknown, max: number): string | null {
  if(value === undefined || value === '') return null;
  if(typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value)) throw invalid();
  return value.trim() || null;
}
function date(value: unknown): string | null {
  const valueText=text(value,10); if(!valueText) return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(valueText) || valueText<'0001-01-01' || !Number.isFinite(Date.parse(valueText)) || new Date(valueText).toISOString().slice(0,10)!==valueText) throw invalid();
  return valueText;
}
export function parseProofSearchQuery(input: Record<string,unknown>): Parsed {
  const allowed=['q','state','from','through','connectionId','integrationAccountId','limit','after'];
  if(Object.keys(input).some(k=>!allowed.includes(k))) throw invalid();
  const state=text(input.state,30);
  if(state && !PROOF_SEARCH_STATES.includes(state as ProofSearchState)) throw invalid();
  const from=date(input.from),through=date(input.through);
  if(from && through && from>through) throw invalid();
  const limit=input.limit===undefined?50:Number(input.limit);
  if((typeof input.limit !== 'string' && typeof input.limit !== 'number' && input.limit !== undefined) || !Number.isSafeInteger(limit) || limit<1 || limit>50) throw invalid();
  return {q:text(input.q,200)??'',state:state as ProofSearchState|null,from,through,
    connectionId:text(input.connectionId,200),integrationAccountId:text(input.integrationAccountId,200),
    limit,after:text(input.after,2048)};
}
function cursorCodec(keyValue:string) {
  const key=Buffer.from(keyValue,'base64');
  if(key.length!==32) throw new DomainError('CURSOR_SIGNING_UNAVAILABLE','Cursor signing is not configured',503);
  const mac=(body:string)=>createHmac('sha256',key).update('proof-search/v1:'+body).digest();
  return {
    encode(cursor:Cursor){const body=Buffer.from(JSON.stringify(cursor)).toString('base64url');return body+'.'+mac(body).toString('base64url');},
    decode(token:string):Cursor {
      const parts=token.split('.');
      if(parts.length!==2 || parts.some(p=>!p || !/^[A-Za-z0-9_-]+$/.test(p))) throw invalid();
      const actual=Buffer.from(parts[1],'base64url'),expected=mac(parts[0]);
      if(actual.length!==expected.length || !timingSafeEqual(actual,expected)) throw invalid();
      let cursor:Cursor; try {cursor=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));} catch {throw invalid();}
      if(!cursor || cursor.v!==1 || typeof cursor.audience!=='string' || typeof cursor.filters!=='string' ||
        typeof cursor.lastId!=='string' || cursor.lastId.length>200 || !Number.isSafeInteger(cursor.expires)) throw invalid();
      return cursor;
    },
  };
}
function iso(value:string|Date|null):string|null{return value===null?null:new Date(value).toISOString();}
/** This projection reports existing authoritative preservation receipts; it does
 * not re-verify storage, introduce a Proof lifecycle, or promise disaster recovery.
 * Root readiness is independent of later commerce stages and webhook delivery. */
export function proofSearchReadiness(row: Pick<SearchRow,'status'|'workflow_type'|'finalized_at'|'committed_count'|'fulfillment_count'|'packing_attested'|'pending_count'|'required_count'|'preserved_count'|'failed_count'|'missing_count'|'has_manifest'|'active_capture'>): ProofSearchItem['readiness'] {
  const finalized=row.status==='FINALIZED' && Boolean(row.finalized_at);
  if(Number(row.failed_count)>0) return {state:'NEEDS_ATTENTION',reason:'PRESERVATION_FAILED',preserved:false};
  const captureAccepted=Number(row.committed_count)>0 &&
    (row.workflow_type!=='COMMERCE_SALE' || Number(row.fulfillment_count)>0 && row.packing_attested);
  const preserved=finalized && row.has_manifest && captureAccepted && Number(row.required_count)>0 &&
    Number(row.required_count)===Number(row.preserved_count) && Number(row.pending_count)===0;
  if(preserved) return {state:'READY',reason:null,preserved:true};
  if(finalized) return {state:Number(row.missing_count)>0 || !row.has_manifest || !captureAccepted?'NEEDS_ATTENTION':'IN_PROGRESS',
    reason:Number(row.missing_count)>0?'LEGACY_UNCONFIRMED':!row.has_manifest || !captureAccepted?'FINALIZATION_INCOMPLETE':'PRESERVATION_PENDING',preserved:false};
  if(Number(row.pending_count)>0 || Number(row.committed_count)>0 || row.active_capture)
    return {state:'IN_PROGRESS',reason:Number(row.fulfillment_count)>0 && !row.packing_attested?'CONFIRMATION_REQUIRED':null,preserved:false};
  return {state:'AWAITING_CAPTURE',reason:'CAPTURE_REQUIRED',preserved:false};
}
type Scope = {kind:'user';userId:string}|{kind:'tenant';principal:ApiPrincipal}|{kind:'partner';actor:PartnerActor};
async function authorize(db:Database,clock:Clock,scope:Scope){
  await assertPolicyAccessSafe(db);
  if(scope.kind==='user'){await requireActiveAccount(db,scope.userId);return;}
  if(scope.kind==='partner'){await reauthorizePartner(db,clock,scope.actor,'proofs:read');return;}
  const p=scope.principal;requireScope(p,'proofs:read');await requireDeveloperAccess(db,p.userId);
  const active=await db.query('SELECT 1 FROM api_keys k JOIN api_tenants t ON t.id=k.tenant_id WHERE k.id=$1 AND k.tenant_id=$2 AND t.owner_user_id=$3 AND k.revoked_at IS NULL',[p.keyId,p.tenantId,p.userId]);
  if(!active.rows[0]) throw new DomainError('UNAUTHENTICATED','Invalid or revoked API key',401);
}
async function searchPage(db:Database,clock:Clock,scope:Scope,input:Record<string,unknown>,key:string):Promise<ProofSearchResult>{
  const query=parseProofSearchQuery(input),codec=cursorCodec(key);await authorize(db,clock,scope);
  const audience=scope.kind==='user'?'user:'+scope.userId:scope.kind==='tenant'?'tenant:'+scope.principal.tenantId+':'+scope.principal.keyId:
    'partner:'+scope.actor.environment+':'+scope.actor.merchantId+':'+scope.actor.principalId+':'+scope.actor.credentialId+':'+(scope.actor.delegationGrantId??'direct');
  const {after,...filters}=query,filterHash=sha256Hex(canonicalize(filters));
  let cursor:Cursor=after?codec.decode(after):{v:1,audience,filters:filterHash,lastId:'',expires:clock.now().getTime()+3600000};
  if(cursor.audience!==audience || cursor.filters!==filterHash) throw invalid();
  if(cursor.expires<=clock.now().getTime()) throw new DomainError('CURSOR_EXPIRED','Restart this search; use a reconciliation snapshot for complete event catch-up',410);
  const params:unknown[]=[];
  const bind=(value:unknown)=>{params.push(value);return '$'+params.length;};
  let permission:string;
  if(scope.kind==='user'){
    const actor=bind(scope.userId);
    permission=`(EXISTS(SELECT 1 FROM proof_participants pp WHERE pp.proof_id=p.id AND pp.user_id=${actor} AND platform_operator_access_active(p.id,${actor}))
      OR EXISTS(SELECT 1 FROM commerce_receivers cr WHERE cr.proof_id=p.id AND cr.user_id=${actor} AND cr.accepted_at IS NOT NULL AND platform_operator_access_active(p.id,${actor})))`;
  } else if(scope.kind==='tenant') {
    permission=`EXISTS(SELECT 1 FROM api_tenant_proofs ap WHERE ap.proof_id=p.id AND ap.tenant_id=${bind(scope.principal.tenantId)})`;
  } else {
    permission=`EXISTS(SELECT 1 FROM platform_proof_ownership po WHERE po.proof_id=p.id AND po.merchant_id=${bind(scope.actor.merchantId)} AND po.environment=${bind(scope.actor.environment)})`;
  }
  const where=[permission];
  if(cursor.lastId)where.push('p.id<'+bind(cursor.lastId));
  if(query.from)where.push('p.created_at>='+bind(query.from+'T00:00:00.000Z')+'::timestamptz');
  if(query.through)where.push("p.created_at<(("+bind(query.through)+"::date+1)::timestamp AT TIME ZONE 'UTC')");
  if(query.connectionId)where.push(`EXISTS(SELECT 1 FROM commerce_order_records co WHERE co.transaction_id=p.transaction_id AND co.connection_id=${bind(query.connectionId)})`);
  if(query.integrationAccountId)where.push(`EXISTS(SELECT 1 FROM platform_external_bindings b WHERE b.proof_id=p.id AND b.integration_account_id=${bind(query.integrationAccountId)} AND b.resource_type='ORDER')`);
  if(query.q){
    // Literal substring search: user '%' and '_' are not SQL wildcards.
    const needle=bind('%'+query.q.replace(/[\\%_]/g,'\\$&')+'%');
    where.push(`(p.id ILIKE ${needle} ESCAPE '\\' OR t.item_title ILIKE ${needle} ESCAPE '\\' OR t.external_reference ILIKE ${needle} ESCAPE '\\'
      OR s.tracking_number ILIKE ${needle} ESCAPE '\\' OR ta.tracking_number ILIKE ${needle} ESCAPE '\\'
      OR EXISTS(SELECT 1 FROM api_tenant_proofs ap WHERE ap.proof_id=p.id AND ap.external_id ILIKE ${needle} ESCAPE '\\')
      OR EXISTS(SELECT 1 FROM platform_external_bindings b WHERE b.proof_id=p.id AND b.resource_type='ORDER' AND b.external_id ILIKE ${needle} ESCAPE '\\'))`);
  }
  // Require the same immutable session/evidence binding as strict finalization.
  // Legacy unlinked declarations retain their core meaning but cannot acquire
  // a stronger readiness label merely because a journal later became durable.
  const qualifyingCapture = `e.proof_id=p.id AND e.validation_status='COMMITTED' AND e.evidence_type='FULFILLMENT_CAPTURE'
    AND e.capture_origin IN ('AUTHORIZED_CAPTURE_SESSION','CLIENT_REPORTED_DESKTOP_CAPTURE')
    AND cs.id=e.capture_session_id AND cs.evidence_id=e.id AND cs.proof_id=p.id AND cs.stage_id IS NULL
    AND cs.state='COMMITTED' AND cs.actor_user_id=e.submitted_by AND cs.expected_sha256=e.sha256 AND cs.expected_byte_size=e.byte_size
    AND EXISTS(SELECT 1 FROM proof_participants seller WHERE seller.proof_id=p.id AND seller.role='SELLER' AND seller.user_id=e.submitted_by)`;
  const now=bind(clock.now().toISOString());
  const state=bind(query.state),limit=bind(query.limit+1);
  const rows=(await db.query<SearchRow>(`
    WITH base AS (
      SELECT p.*,t.item_title,
        COALESCE((SELECT b.external_id FROM platform_external_bindings b WHERE b.proof_id=p.id AND b.resource_type='ORDER' ORDER BY b.external_id LIMIT 1),t.external_reference,
          (SELECT ap.external_id FROM api_tenant_proofs ap WHERE ap.proof_id=p.id ORDER BY ap.external_id LIMIT 1)) AS external_id,
        COALESCE(ta.tracking_number,s.tracking_number) AS tracking_number,
        (SELECT COUNT(*) FROM transaction_items i WHERE i.transaction_id=t.id) AS item_count,
        (SELECT co.connection_id FROM commerce_order_records co WHERE co.transaction_id=t.id ORDER BY co.last_seen_at DESC,co.id DESC LIMIT 1) AS connection_id,
        (SELECT ic.provider FROM commerce_order_records co JOIN integration_connections ic ON ic.id=co.connection_id WHERE co.transaction_id=t.id ORDER BY co.last_seen_at DESC,co.id DESC LIMIT 1) AS provider,
        (SELECT e.submitted_by FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='COMMITTED' ORDER BY e.committed_at,e.id LIMIT 1) AS recorded_by,
        (SELECT MIN(e.committed_at) FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='COMMITTED') AS captured_at,
        (SELECT COUNT(*) FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='COMMITTED') AS committed_count,
        (SELECT COUNT(*) FROM evidence e JOIN capture_sessions cs ON cs.id=e.capture_session_id WHERE ${qualifyingCapture}) AS fulfillment_count,
        (SELECT COUNT(*) FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='PENDING') AS pending_count,
        EXISTS(SELECT 1 FROM attestations a JOIN evidence e ON e.id=a.related_evidence_id JOIN capture_sessions cs ON cs.id=e.capture_session_id WHERE a.proof_id=p.id AND a.statement='PACKED_DESCRIBED_ITEM' AND a.attested_by=e.submitted_by AND ${qualifyingCapture}) AS packing_attested,
        EXISTS(SELECT 1 FROM final_manifests m WHERE m.proof_id=p.id AND m.id=p.manifest_id) AS has_manifest,
        (EXISTS(SELECT 1 FROM capture_intents i WHERE i.proof_id=p.id AND i.consumed_at IS NULL AND i.expires_at>${now}::timestamptz) OR EXISTS(SELECT 1 FROM capture_sessions cs WHERE cs.proof_id=p.id AND cs.stage_id IS NULL AND cs.state IN ('ISSUED','RECORDED','UPLOADING') AND cs.recover_until>${now}::timestamptz)) AS active_capture
      FROM proofs p JOIN transactions t ON t.id=p.transaction_id LEFT JOIN transaction_shipping s ON s.transaction_id=t.id
      LEFT JOIN proof_tracking_associations ta ON ta.transaction_id=t.id WHERE ${where.join(' AND ')}
    ), projected AS (
      SELECT b.*,r.required_count,r.preserved_count,r.failed_count,r.missing_count,
        CASE WHEN r.failed_count>0 THEN 'NEEDS_ATTENTION'
          WHEN b.status='FINALIZED' AND b.finalized_at IS NOT NULL AND b.has_manifest AND b.committed_count>0
            AND (b.workflow_type<>'COMMERCE_SALE' OR b.fulfillment_count>0 AND b.packing_attested)
            AND r.required_count=r.preserved_count AND b.pending_count=0 THEN 'READY'
          WHEN b.status='FINALIZED' AND b.finalized_at IS NOT NULL
            THEN CASE WHEN r.missing_count>0 OR NOT b.has_manifest OR b.committed_count=0 OR (b.workflow_type='COMMERCE_SALE' AND (b.fulfillment_count=0 OR NOT b.packing_attested)) THEN 'NEEDS_ATTENTION' ELSE 'IN_PROGRESS' END
          WHEN b.pending_count>0 OR b.committed_count>0 OR b.active_capture THEN 'IN_PROGRESS'
          ELSE 'AWAITING_CAPTURE' END AS search_state
      FROM base b CROSS JOIN LATERAL (
        SELECT COUNT(*) AS required_count,
          COUNT(*) FILTER(WHERE d.state='DURABLE' AND d.receipt_json IS NOT NULL AND d.receipt_json->>'operationId'=required.operation_id
            AND d.receipt_json->>'eventSha256'=e.sha256 AND d.receipt_json->>'objectVersionId' IS NOT NULL) AS preserved_count,
          COUNT(*) FILTER(WHERE d.state='DEAD_LETTER') AS failed_count,
          COUNT(*) FILTER(WHERE e.operation_id IS NULL) AS missing_count
        FROM (
          SELECT 'finalize:'||b.id AS operation_id
          UNION ALL SELECT 'evidence:'||ev.id FROM evidence ev WHERE ev.proof_id=b.id AND ev.validation_status='COMMITTED'
          UNION ALL SELECT 'declaration:'||a.id FROM attestations a WHERE a.proof_id=b.id
        ) required LEFT JOIN recovery_events e ON e.operation_id=required.operation_id AND e.proof_id=b.id
          LEFT JOIN recovery_delivery d ON d.operation_id=e.operation_id
      ) r
    ) SELECT id AS proof_id,projected.* FROM projected WHERE ${state}::text IS NULL OR search_state=${state}
      ORDER BY id DESC LIMIT ${limit}
  `,params)).rows;
  const page=rows.slice(0,query.limit);
  if(scope.kind==='partner') for(const row of page) await authorizePartnerProof(db,clock,scope.actor,row.proof_id,'proofs:read');
  await authorize(db,clock,scope);
  const hasMore=rows.length>query.limit;
  cursor={...cursor,lastId:page.at(-1)?.proof_id??cursor.lastId};
  return {apiVersion:'v1',schema:'packproof.proof-search/v1',proofs:page.map(row=>({
    proofId:row.proof_id,transactionId:row.transaction_id,status:row.status,createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!,finalizedAt:iso(row.finalized_at),
    externalId:row.external_id,itemTitle:row.item_title,itemCount:Math.max(1,Number(row.item_count)),trackingNumber:row.tracking_number,
    connectionId:row.connection_id,provider:row.provider,recordedBy:row.recorded_by,serverReceivedAt:iso(row.captured_at),readiness:proofSearchReadiness(row),
  })),nextCursor:hasMore?codec.encode(cursor):null,hasMore,refreshedAt:clock.now().toISOString(),cursorExpiresAt:new Date(cursor.expires).toISOString()};
}
async function search(db:Database,clock:Clock,scope:Scope,input:Record<string,unknown>,key:string):Promise<ProofSearchResult>{
  return db.transaction(async tx=>{
    await tx.query("SET LOCAL statement_timeout='5s'");
    return searchPage(tx,clock,scope,input,key);
  });
}
export function searchUserProofs(db:Database,clock:Clock,userId:string,input:Record<string,unknown>,key:string){return search(db,clock,{kind:'user',userId},input,key);}
export function searchTenantProofs(db:Database,clock:Clock,principal:ApiPrincipal,input:Record<string,unknown>,key:string){return search(db,clock,{kind:'tenant',principal},input,key);}
export function searchPartnerProofs(db:Database,clock:Clock,actor:PartnerActor,input:Record<string,unknown>,key:string){return search(db,clock,{kind:'partner',actor},input,key);}
