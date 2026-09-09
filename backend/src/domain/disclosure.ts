import { disclosedRecord } from './disclosure-record.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import type { ObjectStore } from '../s3/object-store.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { createAccessLink, resolveAccessToken, toAccessLinkView, type ProofAccessLinkRow } from './access-links.js';
import { requireParticipant, loadProof } from './proof-access.js';
import { buildProofTracker } from './proof-tracker.js';
import { DomainError } from './errors.js';
import { appendAudit } from './audit.js';
import { loadCustodyBundle } from './custody.js';
import { isQualifyingFulfillmentCapture } from './evidence-types.js';
import { listSharedProofSources } from './shared-proof-sources.js';
import { SELLER_SHIPPING_STATEMENT } from './attestation-authorization.js';
import type { AttestationRow } from './types.js';
import { assertPolicyAccessSafe } from './policy-recovery.js';

export const DISCLOSURE_POLICY_VERSION = 'packproof.disclosure/v1';
export const DISCLOSURE_FIELDS = ['status', 'order', 'shipping', 'evidence', 'statements'] as const;
export type DisclosureField = typeof DISCLOSURE_FIELDS[number];
export type DisclosurePurpose = 'BUYER_RECEIPT' | 'CLAIMS_REVIEW' | 'PUBLIC_SAMPLE' | 'SHARED_PROOF';
export const SHARED_PROOF_FIELDS: DisclosureField[] = ['status', 'order', 'shipping', 'evidence', 'statements'];
export interface DisclosureMedia { evidenceId: string; representation: 'ORIGINAL' | 'DERIVATIVE'; derivativeId?: string }
export interface DisclosureContext {
  proofId: string; actorUserId?: string; grantId: string; scopeIdentity?:string; policyVersion: string; scopeVersion: number;
  purpose: DisclosurePurpose | 'PARTICIPANT'; fields: DisclosureField[]; media: DisclosureMedia[];
}
export interface DisclosureInput {
  purpose?: unknown; fields?: unknown; media?: unknown; originalsReviewed?: unknown;
  expiresAt?: unknown; recipientHint?: unknown; previewHash?: unknown;
}
interface GrantRow { scope_version: number; policy_version: string; purpose: DisclosurePurpose; fields: DisclosureField[]; media: DisclosureMedia[] }
function invalid(message: string): never { throw new DomainError('INVALID_DISCLOSURE', message, 400); }
function forbidden(): never { throw new DomainError('INSUFFICIENT_SCOPE', 'This view does not include that source', 403); }

export async function resolveDisclosureContext(db: Database, clock: Clock, input: { proofId?: string; actorUserId?: string; token?: string }): Promise<DisclosureContext> {
  await assertPolicyAccessSafe(db);
  if (input.token) {
    const link = await resolveAccessToken(db, clock, input.token);
    if (input.proofId && input.proofId !== link.proof_id) forbidden();
    return disclosureContextForLink(db, link, clock.now());
  }
  if (!input.proofId || !input.actorUserId) forbidden();
  await requireParticipant(db, input.proofId!, input.actorUserId!);
  const rows = await db.query<{id:string}>('SELECT id FROM evidence WHERE proof_id=$1 AND validation_status=\'COMMITTED\'', [input.proofId]);
  return {proofId: input.proofId!, actorUserId: input.actorUserId, grantId: `participant:${input.actorUserId}`, policyVersion: DISCLOSURE_POLICY_VERSION, scopeVersion: 1, purpose:'PARTICIPANT', fields:[...DISCLOSURE_FIELDS], media: rows.rows.map(row=>({evidenceId:row.id,representation:'ORIGINAL'}))};
}
export async function disclosureContextForLink(db: Database, link: ProofAccessLinkRow, now:Date=new Date()): Promise<DisclosureContext> {
  await assertPolicyAccessSafe(db);
  const creator = await db.query('SELECT 1 FROM proof_participants WHERE id=$1 AND proof_id=$2', [link.created_by_participant_id,link.proof_id]);
  if (!creator.rows[0]) forbidden();
  const subscription=(await db.query<{recipient_grant_id:string|null}>('SELECT recipient_grant_id FROM proof_notification_subscriptions WHERE access_link_id=$1',[link.id])).rows[0];
  let effectiveLinkId=link.id;
  const claim=(await db.query<{access_link_id:string}>(`SELECT a.access_link_id FROM claims_viewer_sessions c JOIN claims_authorizations a ON a.id=c.authorization_id
    JOIN api_keys k ON k.id=c.key_id JOIN proof_access_links parent ON parent.id=a.access_link_id
    WHERE c.access_link_id=$1 AND a.revoked_at IS NULL AND k.revoked_at IS NULL AND parent.revoked_at IS NULL AND parent.expires_at>$2`,[link.id,now.toISOString()])).rows[0];
  if(claim)effectiveLinkId=claim.access_link_id;
  if(subscription?.recipient_grant_id) {
    const parent=(await db.query<ProofAccessLinkRow>('SELECT * FROM proof_access_links WHERE id=$1 AND proof_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$3)',[subscription.recipient_grant_id,link.proof_id,now.toISOString()])).rows[0];
    if(!parent) throw new DomainError('ACCESS_LINK_REVOKED','This viewing link is no longer available',404);
    effectiveLinkId=parent.id;
  }
  const latest = (await db.query<GrantRow>('SELECT * FROM proof_disclosure_grants WHERE access_link_id=$1 ORDER BY scope_version DESC LIMIT 1',[effectiveLinkId])).rows[0];
  if (latest && latest.policy_version !== DISCLOSURE_POLICY_VERSION) forbidden();
  if(subscription?.recipient_grant_id && latest?.purpose!=='BUYER_RECEIPT' && latest?.purpose!=='SHARED_PROOF') forbidden();
  if (latest?.purpose === 'SHARED_PROOF') {
    return {
      proofId: link.proof_id, grantId: link.id, scopeIdentity: effectiveLinkId,
      policyVersion: DISCLOSURE_POLICY_VERSION, scopeVersion: Number(latest.scope_version),
      purpose: 'SHARED_PROOF', fields: latest.fields.filter(field => SHARED_PROOF_FIELDS.includes(field)),
      media: (await listSharedProofSources(db, link.proof_id)).map(source => ({ evidenceId: source.id, representation: 'ORIGINAL' })),
    };
  }
  // Historical broad scopes never imply permission to reveal unreviewed media.
  return {proofId:link.proof_id,grantId:link.id,scopeIdentity:effectiveLinkId,policyVersion:DISCLOSURE_POLICY_VERSION,scopeVersion:Number(latest?.scope_version ?? 0),purpose:latest?.purpose ?? 'BUYER_RECEIPT',fields: latest?.fields ?? (link.scope==='STATUS_ONLY'?['status']:['status','order','shipping']), media:latest?.media ?? []};
}
export function assertDisclosureField(ctx: DisclosureContext, field: DisclosureField): void { if(!ctx.fields.includes(field)) forbidden(); }
export function assertDisclosureMedia(ctx: DisclosureContext, evidenceId: string, derivativeId?: string): DisclosureMedia {
  const match=ctx.media.find(m=>m.evidenceId===evidenceId && (derivativeId===undefined || m.derivativeId===derivativeId));
  if(!ctx.fields.includes('evidence') || !match) forbidden();
  return match!;
}
export async function validateDisclosureInput(db: Database, actorUserId:string,proofId:string,input:DisclosureInput): Promise<DisclosureContext> {
  await requireParticipant(db,proofId,actorUserId,'SELLER');
  const purpose = input.purpose ?? 'BUYER_RECEIPT';
  if (purpose === 'SHARED_PROOF') {
    if (input.fields !== undefined || input.media !== undefined)
      invalid('Shared Proof links include the same record and recordings. Individual fields and files cannot be selected.');
    return {
      proofId, grantId: 'preview', policyVersion: DISCLOSURE_POLICY_VERSION, scopeVersion: 1,
      purpose, fields: [...SHARED_PROOF_FIELDS],
      media: (await listSharedProofSources(db, proofId)).map(source => ({ evidenceId: source.id, representation: 'ORIGINAL' })),
    };
  }
  if(typeof purpose!=='string'||!['BUYER_RECEIPT','CLAIMS_REVIEW','PUBLIC_SAMPLE'].includes(purpose)) invalid('Choose a recipient purpose');
  const fields=input.fields ?? ['status','order','shipping'];
  if(!Array.isArray(fields)||fields.length>4||fields.some(x=>!['status','order','shipping','evidence'].includes(x))) invalid('Only status, item title, shipping status and selected media can be shared');
  if(!fields.includes('status')) invalid('Every receipt includes the Proof status');
  const media=input.media ?? [];
  if(!Array.isArray(media)||media.length>30) invalid('Select at most 30 media sources');
  const selected:DisclosureMedia[]=[];
  for(const m of media) {
    if(!m||typeof m.evidenceId!=='string'||!['ORIGINAL','DERIVATIVE'].includes(m.representation)) invalid('Invalid media selection');
    if(selected.some(s=>s.evidenceId===m.evidenceId)) invalid('Select only one representation per source');
    const evidence=(await db.query<{sha256:string}>('SELECT sha256 FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status=\'COMMITTED\'',[m.evidenceId,proofId])).rows[0];
    if(!evidence) forbidden();
    if(m.representation==='ORIGINAL') {
      if(purpose!=='CLAIMS_REVIEW'||input.originalsReviewed!==true) invalid('Original media requires explicit review for a claims recipient');
      selected.push({evidenceId:m.evidenceId,representation:'ORIGINAL'});
    } else {
      if(typeof m.derivativeId!=='string') invalid('Select a reviewed redacted derivative');
      const row=(await db.query('SELECT 1 FROM proof_media_derivatives WHERE id=$1 AND proof_id=$2 AND evidence_id=$3 AND source_sha256=$4 AND status=\'REVIEWED\'',[m.derivativeId,proofId,m.evidenceId,evidence.sha256])).rows[0];
      if(!row) invalid('The redaction is not available and reviewed');
      selected.push({evidenceId:m.evidenceId,representation:'DERIVATIVE',derivativeId:m.derivativeId});
    }
  }
  if(selected.length&&!fields.includes('evidence')) invalid('Enable selected media before sharing a recording');
  return {proofId,grantId:'preview',policyVersion:DISCLOSURE_POLICY_VERSION,scopeVersion:1,purpose:purpose as DisclosurePurpose,fields:[...new Set(fields)] as DisclosureField[],media:selected};
}

export async function getDisclosureProjection(db:Database,ctx:DisclosureContext) {
  const proof=await loadProof(db,ctx.proofId);
  const manifest=(await db.query<{canonical_json:string;sha256:string}>('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1',[ctx.proofId])).rows[0];
  const integrity={result:!manifest?'NOT_FINALIZED':sha256Hex(manifest.canonical_json)===manifest.sha256?'MANIFEST_HASH_MATCH':'MANIFEST_HASH_MISMATCH',scope:'Stored manifest bytes. This check does not establish package contents or decide a claim.'};
  const source=await buildProofTracker(db,ctx.proofId);
  const committed=(await db.query<{evidence_type:string}>('SELECT evidence_type FROM evidence WHERE proof_id=$1 AND validation_status=\'COMMITTED\'',[ctx.proofId])).rows;
  const packingAttested=(await db.query('SELECT 1 FROM attestations WHERE proof_id=$1 AND statement=\'PACKED_DESCRIBED_ITEM\'',[ctx.proofId])).rows.length>0;
  const custody=await loadCustodyBundle(db,proof,null,{committedEvidenceCount:committed.length,packingAttested,fulfillmentCaptureCount:committed.filter(e=>isQualifyingFulfillmentCapture({evidenceType:e.evidence_type,validationStatus:'COMMITTED'})).length});
  const shipping=ctx.fields.includes('shipping');
  const safeMilestones=source.milestones.filter(m=>shipping||['PROOF_CREATED','PACKING_RECORDED','PROOF_FINALIZED'].includes(m.code)).map(m=>({...m, detail:null, label:m.code==='DELIVERED'?'Carrier reported delivery':m.label}));
  const tracker={...source,reference:null,itemTitle:ctx.fields.includes('order')?source.itemTitle:null,
    headline:shipping?(source.headline==='Delivered'?'Carrier reported delivery':source.headline):(proof.status==='FINALIZED'?'Proof finalized':'Proof in progress'),
    shipment:shipping&&source.shipment?{carrier:source.shipment.carrier,service:null,trackingNumber:null}:null,
    milestones:safeMilestones,lastUpdatedAt:safeMilestones.filter(m=>m.occurredAt).map(m=>m.occurredAt!).sort().at(-1)??source.lastUpdatedAt};
  const evidence=[];
  const sharedSources = ctx.purpose === 'SHARED_PROOF' ? await listSharedProofSources(db, ctx.proofId) : null;
  for(const media of ctx.media) {
    const e=sharedSources ? sharedSources.find(source => source.id === media.evidenceId) : (await db.query<{id:string,evidence_type:string,content_type:string,sha256:string}>('SELECT id,evidence_type,content_type,sha256 FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status=\'COMMITTED\'',[media.evidenceId,ctx.proofId])).rows[0];
    if(!e) continue;
    let contentType=e.content_type;
    if(media.representation==='DERIVATIVE') {
      const d=(await db.query<{content_type:string}>('SELECT content_type FROM proof_media_derivatives WHERE id=$1 AND proof_id=$2 AND evidence_id=$3 AND source_sha256=$4 AND status=\'REVIEWED\'',[media.derivativeId,ctx.proofId,e.id,e.sha256])).rows[0];
      if(!d) continue;
      contentType=d.content_type;
    }
    const slot = ({ FULFILLMENT_CAPTURE: 'Packing', RECEIPT: 'Receipt', RETURN_PACKING: 'Return packing', RETURN_RECEIPT: 'Return receipt' } as Record<string, string>)[e.evidence_type] ?? 'Evidence';
    evidence.push({evidenceId:e.id,slot,committed:true as const,contentType,representation:media.representation,derivativeId:media.derivativeId??null,
      ...(sharedSources ? {stageId:sharedSources.find(source => source.id === e.id)?.stage_id ?? null} : {}),
      label:media.representation==='DERIVATIVE'?'Reviewed redacted copy':!sharedSources||slot==='Evidence'?'Original recording':`${slot} recording`});
  }
  const statementRows = ctx.fields.includes('statements') ? (await db.query<AttestationRow & {role:string}>(
    'SELECT a.*,p.role FROM attestations a JOIN proof_participants p ON p.id=a.participant_id WHERE a.proof_id=$1 ORDER BY a.created_at,a.id', [ctx.proofId])).rows : [];
  const statements = statementRows.filter(row => !row.related_evidence_id || ctx.media.some(media => media.evidenceId===row.related_evidence_id)).map(row => ({
    attestationId:row.id, relatedEvidenceId:row.related_evidence_id,
    statement:row.authorization_json ? SELLER_SHIPPING_STATEMENT : row.statement==='PACKED_DESCRIBED_ITEM' ? 'Seller attested to packing the described item' : row.statement,
    attributedTo:row.role==='SELLER'?'Seller account':'Buyer account', createdAt:new Date(row.created_at).toISOString(),
    method:row.authorization_json?.method ?? 'PARTICIPANT_STATEMENT',
    signatureVerification:row.authorization_json?.signatureVerification ?? 'NOT_CRYPTOGRAPHICALLY_VERIFIED',
    biometricPolicy:row.authorization_json ? 'Strong biometric requested by Android; the server verifies the declaration signature.' : null,
    hardwareOriginVerified:false, legalIdentityVerified:false,
  }));
  const recordHead=(await db.query<{sequence:string|number;sha256:string}>('SELECT sequence,sha256 FROM proof_supplements WHERE proof_id=$1 ORDER BY sequence DESC LIMIT 1',[ctx.proofId])).rows[0];
  const received=(await db.query('SELECT 1 FROM commerce_stages WHERE proof_id=$1 AND stage_type=\'RECEIPT\' AND finalized_at IS NOT NULL LIMIT 1',[ctx.proofId])).rows.length>0;
  const record = await disclosedRecord(db,ctx);
  const pendingEvidence = ctx.purpose === 'SHARED_PROOF' && ctx.fields.includes('evidence') && (await db.query(`SELECT 1 FROM evidence WHERE proof_id=$1 AND validation_status='PENDING'
    UNION ALL SELECT 1 FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE s.proof_id=$1 AND e.committed_at IS NULL AND e.discarded_at IS NULL LIMIT 1`,[ctx.proofId])).rows.length > 0;
  const evidenceState = !ctx.fields.includes('evidence') ? {code:'NOT_SHARED',message:'Recordings are not included in this link'}
    : pendingEvidence ? {code:'UPLOADING',message:'Evidence is still uploading'}
    : evidence.length === 0 ? ctx.purpose === 'SHARED_PROOF' ? {code:'NOT_RECORDED',message:'Recording has not been added yet'} : {code:'NOT_SHARED',message:'Recordings are not included in this link'}
    : {code:'AVAILABLE',message:proof.status === 'FINALIZED' ? 'Proof completed' : 'Recording added; confirmation is pending'};
  const value={...record,integrity,evidenceState,schema:'packproof.proof.public/v1' as const,proofId:proof.id,status:proof.status,workflowType:proof.workflow_type,workflowStage:custody.policy.workflowStage,custodyOutcome:custody.policy.custodyOutcome,nextAction:null,scope:ctx.fields.includes('evidence')?'EVIDENCE_VIEW':'SUMMARY',tracker,
    join:{eligible:false,requiresAuthentication:true as const,message:'Sign in with the invited buyer account to document arrival.'},
    evidence:ctx.fields.includes('evidence')?evidence:[],
    statements,
    recordAsOf:{supplementSequence:Number(recordHead?.sequence??0),supplementSha256:recordHead?.sha256??null,scopeStatement:ctx.purpose==='SHARED_PROOF'?'This view includes the recordings and categories approved for this link.':'This view contains selected categories of the same Proof.'},
    observations:ctx.fields.includes('shipping')?custody.observations.map(o=>({label:o.label,occurredAt:o.occurredAt})):[],
    receipt:{mode:ctx.purpose==='PUBLIC_SAMPLE'?'SAMPLE':'LIVE',carrierReportedDelivered:shipping&&source.milestones.some(m=>m.code==='DELIVERED'&&m.state==='COMPLETE'),buyerReportedReceived:received,contributionRequiresVerification:true,contributionUrl:`/proof/${proof.id}/lifecycle`,message:'No buyer report is not acceptance. A receipt report is not a waiver.'},
    disclosure:{policyVersion:ctx.policyVersion,grantId:ctx.grantId,scopeVersion:ctx.scopeVersion,purpose:ctx.purpose,fields:ctx.fields,
      ...(ctx.purpose==='SHARED_PROOF'?{liveProof:true,sharingNotice:'Anyone with this link can view this Proof’s original recordings and future updates until access ends. Review recordings for private information before sharing.'}:{}),
      revocationNotice:'Revoking a link prevents future access. It cannot recall files or screenshots already saved.'}};
  // Hash the exact disclosure content independent of the server-generated link id.
  const viewHash=sha256Hex(canonicalize({...value,disclosure:{...value.disclosure,grantId:null,scopeVersion:null}}));
  return {...value,disclosure:{...value.disclosure,viewHash}};
}
export async function previewDisclosure(db:Database,actorUserId:string,proofId:string,input:DisclosureInput) {
  return getDisclosureProjection(db,await validateDisclosureInput(db,actorUserId,proofId,input));
}
export async function createDisclosureGrant(db:Database,clock:Clock,actorUserId:string,proofId:string,input:DisclosureInput&{publicWebBaseUrl:string,accessLinkId?:string}) {
  return db.transaction(async tx=>{
    await loadProof(tx,proofId,true);
    const ctx=await validateDisclosureInput(tx,actorUserId,proofId,input);
    if (ctx.purpose === 'SHARED_PROOF' && input.originalsReviewed !== true)
      invalid('Review the Proof and approve sharing its original recordings and future updates before creating a link.');
    const preview=await getDisclosureProjection(tx,ctx);
    if(input.previewHash!==preview.disclosure.viewHash) throw new DomainError('DISCLOSURE_PREVIEW_CHANGED','Review the latest recipient preview before creating this link',409);
    let link;
    if(input.accessLinkId) {
      const found=(await tx.query<ProofAccessLinkRow>('SELECT * FROM proof_access_links WHERE id=$1 AND proof_id=$2 AND revoked_at IS NULL FOR UPDATE',[input.accessLinkId,proofId])).rows[0];
      if(!found || (found.expires_at&&new Date(found.expires_at)<=clock.now())) forbidden();
      link={accessLinkId:found.id};
      ctx.scopeVersion=Number((await tx.query<{version:number}>('SELECT COALESCE(MAX(scope_version),0)+1 AS version FROM proof_disclosure_grants WHERE access_link_id=$1',[found.id])).rows[0].version);
    } else link=await createAccessLink(tx,clock,actorUserId,proofId,{scope:ctx.fields.includes('evidence')?'EVIDENCE_VIEW':'SUMMARY',expiresAt:input.expiresAt,recipientHint:input.recipientHint,publicWebBaseUrl:input.publicWebBaseUrl});
    ctx.grantId=link.accessLinkId;
    await tx.query('INSERT INTO proof_disclosure_grants(access_link_id,scope_version,policy_version,purpose,fields,media,preview_hash,created_by_user_id,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)',[ctx.grantId,ctx.scopeVersion,ctx.policyVersion,ctx.purpose,JSON.stringify(ctx.fields),JSON.stringify(ctx.media),preview.disclosure.viewHash,actorUserId,clock.now().toISOString()]);
    await appendAudit(tx,{proofId,actorUserId,eventType:'DISCLOSURE_SCOPE_REVIEWED',eventData:{accessLinkId:ctx.grantId,scopeVersion:ctx.scopeVersion,policyVersion:ctx.policyVersion,previewHash:preview.disclosure.viewHash},at:clock.now()});
    return {...link,preview:await getDisclosureProjection(tx,ctx)};
  });
}
/** Compatibility collector for small internal callers. HTTP archives and playback
 * consume readDisclosedMediaStream directly and never buffer whole recordings. */
export async function readDisclosedMedia(db:Database,clock:Clock,store:ObjectStore,token:string,evidenceId:string) {
  const {readDisclosedMediaStream}=await import('./disclosure-stream.js');
  const result=await readDisclosedMediaStream(db,clock,store,token,evidenceId);
  if(!result.body)throw new DomainError('EVIDENCE_NOT_FOUND','Recording is unavailable',404);
  if(result.byteSize>8*1024*1024){result.body.destroy();throw new DomainError('STREAMING_REQUIRED','Use the streamed recording or package download',413);}
  const chunks:Buffer[]=[];let bytes=0;
  try{for await(const chunk of result.body){bytes+=chunk.length;if(bytes>8*1024*1024)throw new DomainError('STREAMING_REQUIRED','Use the streamed recording or package download',413);chunks.push(Buffer.from(chunk));}}
  finally{result.body.destroy();}
  const body=Buffer.concat(chunks,bytes);
  if(body.length!==result.byteSize||sha256Hex(body)!==result.sha256)throw new DomainError('EVIDENCE_INTEGRITY_FAILURE','Stored source failed verification',409);
  return {body,contentType:result.contentType,evidenceId};
}

/** Reuse an already approved live scope. Tokens remain hash-only in persistence. */
export async function reuseSharedProofLink(db:Database,clock:Clock,actorUserId:string,proofId:string,token:unknown,publicWebBaseUrl:string) {
  return db.transaction(async tx => {
    await requireParticipant(tx,proofId,actorUserId,'SELLER');
    if(typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DomainError('ACCESS_LINK_INVALID','This viewing link is not valid',404);
    const row=(await tx.query<ProofAccessLinkRow>('SELECT * FROM proof_access_links WHERE proof_id=$1 AND token_hash=$2 FOR UPDATE',[proofId,sha256Hex(token)])).rows[0];
    if(!row) throw new DomainError('ACCESS_LINK_INVALID','This viewing link is not valid',404);
    if(row.revoked_at) throw new DomainError('ACCESS_LINK_REVOKED','This viewing link has been revoked',404);
    if(row.expires_at && new Date(row.expires_at) <= clock.now()) throw new DomainError('ACCESS_LINK_EXPIRED','This viewing link has expired',404);
    const ctx=await disclosureContextForLink(tx,row,clock.now());
    if(ctx.purpose!=='SHARED_PROOF' || ctx.fields.length!==SHARED_PROOF_FIELDS.length || SHARED_PROOF_FIELDS.some(field=>!ctx.fields.includes(field))) forbidden();
    return {...toAccessLinkView(row),token,url:`${publicWebBaseUrl.replace(/\/$/,'')}/p/${token}`};
  });
}
