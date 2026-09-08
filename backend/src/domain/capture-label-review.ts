import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { loadCaptureSession } from "./capture-sessions.js";
import { DomainError } from "./errors.js";
import { assertNotFinalized, loadProof, requireParticipant } from "./proof-access.js";
import { lockTransactionContext } from "./transactions.js";

type ObservationRow = { id:string;tracking_number:string;carrier_hint:string|null;barcode_format:string;detected_at_ms:number;observation_context:Record<string,unknown>|null;associated:boolean;decision:string|null;reason:string|null;resolved_at:string|Date|null };
async function observations(db: Database, proofId: string, sessionId: string) {
  return (await db.query<ObservationRow>(`SELECT o.*, EXISTS(SELECT 1 FROM capture_shipping_labels l WHERE l.session_id=o.session_id AND l.tracking_number=o.tracking_number) AS associated,
    r.decision,r.reason,r.created_at AS resolved_at FROM capture_label_observations o
    LEFT JOIN capture_label_resolutions r ON r.observation_id=o.id WHERE o.proof_id=$1 AND o.session_id=$2 ORDER BY o.received_at,o.id`,[proofId,sessionId])).rows;
}
export async function getCaptureLabelReview(db:Database, actor:string, proofId:string, sessionId:string) {
  await requireParticipant(db,proofId,actor,'SELLER');
  const session=await loadCaptureSession(db,actor,proofId,sessionId);
  const rows=await observations(db,proofId,sessionId);
  const current=(await db.query<{tracking_number:string|null}>(`SELECT s.tracking_number FROM transaction_shipping s JOIN proofs p ON p.transaction_id=s.transaction_id WHERE p.id=$1`,[proofId])).rows[0];
  return {
    client:session.client,
    currentTrackingNumber:current?.tracking_number??null,
    reviewRequired:rows.some(o=>!o.associated&&!o.decision),
    observations:rows.map(o=>({observationId:o.id,trackingNumber:o.tracking_number,carrierHint:o.carrier_hint,format:o.barcode_format,detectedAtMs:o.detected_at_ms,
      source:o.observation_context?.source??'LIVE_CAMERA_ANALYSIS',coordinateSpace:o.observation_context?.coordinateSpace??null,
      decoderVersion:o.observation_context?.decoderVersion??null,assurance:'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED',associated:o.associated,
      resolution:o.decision?{decision:o.decision,reason:o.reason,resolvedAt:new Date(o.resolved_at!).toISOString()}:null})),
  };
}
export async function assertShippingReviewComplete(db:Database, proofId:string, sessionId:string):Promise<void> {
  if((await observations(db,proofId,sessionId)).some(o=>!o.associated&&!o.decision))
    throw new DomainError('LABEL_REVIEW_REQUIRED','Review the tracking numbers seen in this recording before confirming your Proof.',409);
}
export async function resolveCaptureLabel(db:Database,clock:Clock,actor:string,proofId:string,sessionId:string,observationId:string,input:unknown) {
  const value=input as {decision?:unknown;reason?:unknown}|null;
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!['decision','reason'].includes(k)) || value.decision!=='NOT_THIS_PACKAGE' || typeof value.reason!=='string' || !value.reason.trim() || value.reason.length>500)
    throw new DomainError('INVALID_LABEL_RESOLUTION','Explain which label belongs to another package.',400);
  const reason = value.reason.trim();
  return db.transaction(async tx=>{
    const proof=await loadProof(tx,proofId);
    await lockTransactionContext(tx,proof.transaction_id);
    await requireParticipant(tx,proofId,actor,'SELLER');
    assertNotFinalized(await loadProof(tx,proofId));
    const session=await loadCaptureSession(tx,actor,proofId,sessionId,true);
    if(session.state==='CANCELLED' || session.stage_id || session.workflow_step!=='PACKING') throw new DomainError('SHIPPING_SCAN_SESSION_INVALID','Use this order’s active packing recording.',409);
    const row=(await observations(tx,proofId,sessionId)).find(o=>o.id===observationId);
    if(!row) throw new DomainError('LABEL_OBSERVATION_NOT_FOUND','This label observation does not belong to this recording.',404);
    if(row.associated) throw new DomainError('LABEL_ALREADY_ASSOCIATED','This label is already attached to the Proof and cannot be dismissed.',409);
    if(row.decision && (row.decision!==value.decision || row.reason!==reason)) throw new DomainError('LABEL_RESOLUTION_CONFLICT','A recorded label decision cannot be rewritten.',409);
    if(!row.decision) {
      const id=newId('label_resolution');const now=clock.now();
      await tx.query('INSERT INTO capture_label_resolutions(id,observation_id,proof_id,session_id,actor_user_id,decision,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,observationId,proofId,sessionId,actor,value.decision,reason,now.toISOString()]);
      await appendAudit(tx,{proofId,actorUserId:actor,eventType:'SHIPPING_LABEL_REVIEWED',eventData:{resolutionId:id,observationId,sessionId,decision:value.decision,reason:reason,source:'PARTICIPANT_SUPPLIED'},at:now});
    }
    return getCaptureLabelReview(tx,actor,proofId,sessionId);
  });
}
