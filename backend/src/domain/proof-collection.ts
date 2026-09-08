import { classifyProofPresentation, type ProofPresentation } from './proof-presentation.js';
import { DomainError } from './errors.js';
import { loadCustodyBundle } from './custody.js';
import { assertPolicyAccessSafe } from './policy-recovery.js';
import { requireActiveAccount } from './account-access.js';
import type { Database } from "../db/database.js";
import { PROOF_SUMMARY_SCHEMA } from "./trust.js";
import { asNullableNumber } from "./transaction-fields.js";
import { asIso, asRequiredIso, type ParticipantRole, type ProofStatus } from "./types.js";

export const PROOF_COLLECTION_LIMIT = 100;

export interface ProofCollectionItem {
  schema: typeof PROOF_SUMMARY_SCHEMA;
  proofId: string;
  transactionId: string;
  role: ParticipantRole;
  status: ProofStatus | string;
  workflowType?: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  transaction: {
    externalReference: string | null;
    itemTitle: string | null;
    transactionDate: string | null;
    carrier: string | null;
    trackingNumber: string | null;
    service: string | null;
    transactionValue: number | null;
    currency: string | null;
  };
}

interface CollectionRow {
  proof_id: string;
  transaction_id: string;
  role: ParticipantRole;
  status: ProofStatus;
  workflow_type?: string;
  created_at: Date | string;
  updated_at: Date | string;
  finalized_at: Date | string | null;
  external_reference: string | null;
  item_title: string | null;
  transaction_date: string | null;
  carrier: string | null;
  tracking_number: string | null;
  service: string | null;
  transaction_value: string | number | null;
  currency: string | null;
}

export async function listMyProofs(
  db: Database,
  actorUserId: string,
): Promise<ProofCollectionItem[]> {
  const found = await db.query<CollectionRow>(
    `SELECT
        p.id AS proof_id,
        p.transaction_id,
        pp.role,
        p.status,
        p.workflow_type,
        p.created_at,
        p.updated_at,
        p.finalized_at,
        t.external_reference,
        t.item_title,
        t.transaction_date,
        s.carrier,
        s.tracking_number,
        s.service,
        t.transaction_value,
        t.currency
       FROM proof_participants pp
       JOIN proofs p ON p.id = pp.proof_id
       JOIN transactions t ON t.id = p.transaction_id
       LEFT JOIN transaction_shipping s ON s.transaction_id = t.id
      WHERE pp.user_id = $1
      ORDER BY
        CASE WHEN p.status = 'FINALIZED' THEN 1 ELSE 0 END ASC,
        CASE WHEN p.status = 'FINALIZED' THEN p.finalized_at ELSE p.updated_at END DESC,
        p.id DESC
      LIMIT $2`,
    [actorUserId, PROOF_COLLECTION_LIMIT],
  );

  return found.rows.map((row) => ({
    schema: PROOF_SUMMARY_SCHEMA,
    proofId: row.proof_id,
    transactionId: row.transaction_id,
    role: row.role,
    status: row.status,
    workflowType: row.workflow_type ?? "COMMERCE_SALE",
    createdAt: asRequiredIso(row.created_at),
    updatedAt: asRequiredIso(row.updated_at),
    finalizedAt: asIso(row.finalized_at),
    transaction: {
      externalReference: row.external_reference,
      itemTitle: row.item_title,
      transactionDate: row.transaction_date,
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      service: row.service,
      transactionValue: asNullableNumber(row.transaction_value),
      currency: row.currency,
    },
  }));
}

export type ProofListView = 'all' | 'attention' | 'completed';
export interface ProofListQuery { view: ProofListView; q: string; limit: number; offset: number }
export function parseProofListQuery(query: Record<string, unknown>): ProofListQuery {
  const view = query.view ?? 'all';
  if (!['all','attention','completed'].includes(String(view))) throw new DomainError('INVALID_PROOF_FILTER','Choose All, Needs attention or Completed',400);
  if (query.q !== undefined && typeof query.q !== 'string') throw new DomainError('INVALID_PROOF_SEARCH','Search must be text',400);
  const q = String(query.q ?? '').trim();
  if (q.length > 200) throw new DomainError('INVALID_PROOF_SEARCH','Search must be at most 200 characters',400);
  const limit = Number(query.limit ?? 100), offset = Number(query.offset ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new DomainError('INVALID_PROOF_PAGE','Choose a page size from 1 to 100 and a nonnegative offset',400);
  return {view:view as ProofListView,q,limit,offset};
}
interface NavigationRow extends CollectionRow {
  invitation_id: string | null;
  access_kind: 'PARTICIPANT' | 'INVITATION' | 'RECEIVER';
  receiver_receipt_needed: boolean;
  participation_policy: string;
  committed_count: string | number;
  fulfillment_count: string | number;
  packing_attested: boolean;
  source: string | null;
  order_cancelled: boolean;
  shipment_status: string | null;
  stage_type: string | null;
  stage_has_evidence: boolean;
}
export interface ProofNavigationItem extends ProofCollectionItem {
  invitationId: string | null;
  accessKind: 'PARTICIPANT' | 'INVITATION' | 'RECEIVER';
  source: string | null;
  presentation: ProofPresentation;
}
/** Opt-in complete collection contract; legacy clients retain the original response and limit.
 * All access, search and presentation filtering happens before page slicing. No page-local totals.
 * A single database snapshot supplies commerce facts; custody retains its existing policy evaluator.
 */
export async function queryMyProofs(db: Database, actorUserId: string, query: ProofListQuery, now: Date) {
  await assertPolicyAccessSafe(db);
  await requireActiveAccount(db, actorUserId);
  const found = await db.query<NavigationRow>(`
    WITH accessible AS (
      SELECT pp.proof_id,pp.role,NULL::TEXT AS invitation_id,'PARTICIPANT'::TEXT AS access_kind FROM proof_participants pp WHERE pp.user_id=$1
      UNION ALL
      SELECT i.proof_id,'BUYER'::TEXT AS role,MIN(i.id) AS invitation_id,'INVITATION'::TEXT AS access_kind FROM invitations i
       WHERE i.invitee_user_id=$1 AND i.status='PENDING' AND (i.expires_at IS NULL OR i.expires_at>$2)
         AND NOT EXISTS(SELECT 1 FROM proof_participants pp WHERE pp.proof_id=i.proof_id AND pp.user_id=$1)
       GROUP BY i.proof_id
      UNION ALL
      SELECT cr.proof_id,'BUYER'::TEXT,CASE WHEN cr.accepted_at IS NULL THEN 'receipt:'||cr.proof_id ELSE NULL END,'RECEIVER'::TEXT FROM commerce_receivers cr
       WHERE cr.user_id=$1
         AND NOT EXISTS(SELECT 1 FROM proof_participants pp WHERE pp.proof_id=cr.proof_id AND pp.user_id=$1)
         AND NOT EXISTS(SELECT 1 FROM invitations i WHERE i.proof_id=cr.proof_id AND i.invitee_user_id=$1 AND i.status='PENDING' AND (i.expires_at IS NULL OR i.expires_at>$2))
    )
    SELECT p.id AS proof_id,p.transaction_id,a.role,a.invitation_id,a.access_kind,p.status,p.workflow_type,p.participation_policy,
      p.created_at,p.updated_at,p.finalized_at,t.external_reference,t.item_title,t.transaction_date,
      s.carrier,s.tracking_number,s.service,t.transaction_value,t.currency,
      (SELECT COUNT(*) FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='COMMITTED') AS committed_count,
      (SELECT COUNT(*) FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='COMMITTED' AND e.evidence_type='FULFILLMENT_CAPTURE') AS fulfillment_count,
      EXISTS(SELECT 1 FROM attestations at WHERE at.proof_id=p.id AND at.statement='PACKED_DESCRIBED_ITEM') AS packing_attested,
      EXISTS(SELECT 1 FROM commerce_order_records co WHERE co.transaction_id=t.id AND co.cancelled=true) AS order_cancelled,
      (SELECT c.provider FROM commerce_order_records co JOIN integration_connections c ON c.id=co.connection_id WHERE co.transaction_id=t.id ORDER BY co.last_seen_at DESC,co.id DESC LIMIT 1) AS source,
      (SELECT se.event_type FROM shipment_events se WHERE se.proof_id=p.id AND se.event_type<>'WEIGHT_RECORDED' ORDER BY se.occurred_at DESC,se.id DESC LIMIT 1) AS shipment_status,
      EXISTS(SELECT 1 FROM commerce_receivers cr WHERE cr.proof_id=p.id AND cr.user_id=$1 AND cr.accepted_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM commerce_stages cs WHERE cs.proof_id=p.id AND cs.stage_type='RECEIPT' AND cs.finalized_at IS NOT NULL)) AS receiver_receipt_needed,
      stage.stage_type,stage.has_evidence AS stage_has_evidence
    FROM accessible a JOIN proofs p ON p.id=a.proof_id JOIN transactions t ON t.id=p.transaction_id
    LEFT JOIN transaction_shipping s ON s.transaction_id=t.id
    LEFT JOIN LATERAL (SELECT cs.stage_type,EXISTS(SELECT 1 FROM commerce_stage_evidence ce WHERE ce.stage_id=cs.id AND ce.committed_at IS NOT NULL AND ce.discarded_at IS NULL) AS has_evidence
      FROM commerce_stages cs WHERE cs.proof_id=p.id AND cs.actor_user_id=$1 AND cs.finalized_at IS NULL ORDER BY cs.created_at,cs.id LIMIT 1) stage ON true
  `, [actorUserId, now.toISOString()]);
  const rows: ProofNavigationItem[] = [];
  for (const row of found.rows) {
    const invitation = Boolean(row.invitation_id);
    const restricted = invitation || row.access_kind === 'RECEIVER';
    const custody = !invitation && row.workflow_type === 'GRADING_SUBMISSION' ? await loadCustodyBundle(db, {
      id:row.proof_id,transaction_id:row.transaction_id,status:row.status,workflow_type:row.workflow_type,
      participation_policy:row.participation_policy,created_at:row.created_at,updated_at:row.updated_at,finalized_at:row.finalized_at,manifest_id:null,version:0,
    },row.role,{committedEvidenceCount:Number(row.committed_count),fulfillmentCaptureCount:Number(row.fulfillment_count),packingAttested:row.packing_attested}) : null;
    rows.push({schema:PROOF_SUMMARY_SCHEMA,proofId:row.proof_id,transactionId:row.transaction_id,role:row.role,status:row.status,
      workflowType:row.workflow_type ?? 'COMMERCE_SALE',createdAt:asRequiredIso(row.created_at),updatedAt:asRequiredIso(row.updated_at),finalizedAt:asIso(row.finalized_at),
      invitationId:row.invitation_id,accessKind:row.access_kind,source:restricted ? null : row.source,
      transaction:{externalReference:row.external_reference,itemTitle:row.item_title,transactionDate:restricted ? null : row.transaction_date,
        carrier:restricted ? null : row.carrier,trackingNumber:restricted ? null : row.tracking_number,service:restricted ? null : row.service,
        transactionValue:restricted ? null : asNullableNumber(row.transaction_value),currency:restricted ? null : row.currency},
      presentation:classifyProofPresentation({proofId:row.proof_id,status:row.status,role:invitation ? null : row.role,workflowType:row.workflow_type,
        participationPolicy:row.participation_policy,finalizedAt:asIso(row.finalized_at),invitationId:row.invitation_id,
        committedEvidenceCount:Number(row.committed_count),fulfillmentCaptureCount:Number(row.fulfillment_count),packingAttested:row.packing_attested,
        shipmentStatus:invitation ? null : row.shipment_status,canShare:!invitation && row.role === 'SELLER',orderCancelled:row.order_cancelled,
        workflowNextAction:custody?.policy.nextAction,pendingStage:!invitation && row.stage_type ? {type:row.stage_type,hasEvidence:row.stage_has_evidence} : !invitation && row.receiver_receipt_needed ? {type:'RECEIPT',hasEvidence:false} : null}),
    });
  }
  const normalized = query.q.toLocaleLowerCase('en-US');
  const matching = rows.filter(row => (!normalized || [row.transaction.itemTitle,row.transaction.externalReference,row.proofId,row.source,row.transaction.trackingNumber].some(value=>value?.toLocaleLowerCase('en-US').includes(normalized))) &&
    (query.view === 'all' || (query.view === 'attention' ? row.presentation.needsAttention : row.presentation.completed)));
  matching.sort((a,b) => (query.view === 'completed' ? 0 : Number(b.presentation.needsAttention)-Number(a.presentation.needsAttention)) ||
    (query.view === 'completed' ? (b.finalizedAt ?? '').localeCompare(a.finalizedAt ?? '') : b.updatedAt.localeCompare(a.updatedAt)) || b.proofId.localeCompare(a.proofId));
  const proofs = matching.slice(query.offset,query.offset+query.limit);
  return {proofs,total:matching.length,nextOffset:query.offset+proofs.length<matching.length ? query.offset+proofs.length : null};
}
