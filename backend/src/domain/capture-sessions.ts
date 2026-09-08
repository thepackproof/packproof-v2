import { pinCurrentIntakeCaptureContext, prepareIntakeCaptureEntry } from "../intake/context.js";
import { sha256Hex } from "../hash.js";
import { reserveApprovedCaptureAllowance } from "../billing/capture-allowance.js";
import { assertSupportedParcelCapture } from "./parcel-scope.js";
import { requireCommerceAccess } from "./commerce-lifecycle.js";
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { newId } from '../ids.js';
import { appendAudit } from './audit.js';
import { DomainError } from './errors.js';
import { assertNotFinalized, loadProof, requireParticipant } from './proof-access.js';
import { asRequiredIso } from './types.js';

export const CAPTURE_POLICY_VERSION = 'packproof.direct-capture/v1';
export const CAPTURE_ASSURANCE = 'An authenticated participant used an authorized PackProof capture session. Camera origin is not independently attested; a compromised device may inject media.';
const ACQUISITION_MS = 30 * 60 * 1000;
const RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;
export const CAPTURE_MAX_BYTES = 250_000_000;
export const CAPTURE_MAX_DURATION_MS = 300_000;
export interface ClientCaptureContext {
  interrupted: boolean | null;
  recordedDurationMs: number | null;
  provenance: "CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED";
}
export async function readCaptureClientContext(db:Database,sessionId:string):Promise<ClientCaptureContext|null> {
  const row=(await db.query<{n:string;interrupted:boolean|null;duration:string|number|null}>(
    "SELECT COUNT(*) AS n,BOOL_OR(interrupted) AS interrupted,MAX(recorded_duration_ms) AS duration FROM capture_session_reports WHERE session_id=$1",[sessionId])).rows[0];
  if(!row || Number(row.n)===0) return null;
  return {interrupted:row.interrupted,recordedDurationMs:row.duration==null?null:Number(row.duration),provenance:"CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED"};
}
async function appendCaptureClientReport(db:Database,clock:Clock,actor:string,proofId:string,sessionId:string,input:{interrupted?:boolean;recordedDurationMs?:number}) {
  if(input.interrupted===undefined && input.recordedDurationMs===undefined) return;
  if (input.recordedDurationMs !== undefined) {
    const last = (await db.query<{offset:number|null}>('SELECT MAX(detected_at_ms) AS offset FROM capture_shipping_labels WHERE session_id=$1',[sessionId])).rows[0]?.offset;
    if (last != null && last > input.recordedDurationMs) throw new DomainError('CAPTURE_CONTEXT_CONFLICT','The reported video duration must include its attached label observation',409);
  }
  const previous=await readCaptureClientContext(db,sessionId);
  if(previous?.recordedDurationMs!=null && input.recordedDurationMs!==undefined && previous.recordedDurationMs!==input.recordedDurationMs)
    throw new DomainError("CAPTURE_CONTEXT_CONFLICT","A retry cannot change the previously reported recording duration",409);
  const context={interrupted:input.interrupted??null,recordedDurationMs:input.recordedDurationMs??null};
  const contextHash=sha256Hex(JSON.stringify(context));
  const result=await db.query<{id:string}>("INSERT INTO capture_session_reports(id,session_id,reporter_user_id,context_sha256,interrupted,recorded_duration_ms,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id,context_sha256) DO NOTHING RETURNING id",[newId("capture_report"),sessionId,actor,contextHash,context.interrupted,context.recordedDurationMs,clock.now().toISOString()]);
  if(result.rows[0]) await appendAudit(db,{proofId,actorUserId:actor,eventType:"CAPTURE_CLIENT_CONTEXT_REPORTED",eventData:{sessionId,...context,provenance:"CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED"},at:clock.now()});
}
export interface CaptureSessionRow {
  order_snapshot_id?: string | null;
  order_snapshot_version?: number | null;
  order_snapshot_sha256?: string | null;
  client_reported_context?: ClientCaptureContext | null;
  stage_id: string | null;
  id: string; proof_id: string; actor_user_id: string; idempotency_key: string;
  client: string; policy_version: string; workflow_step: string; state: string;
  created_at: string | Date; expires_at: string | Date; recover_until: string | Date;
  recorded_at: string | Date | null; expected_sha256: string | null;
  expected_byte_size: string | number | null; content_type: string | null; evidence_id: string | null;
  max_duration_ms?: number | null;
  max_recording_bytes?: string | number | null;
}
export function captureSessionView(s: CaptureSessionRow) {
  return { orderSnapshotId:s.order_snapshot_id??null,orderSnapshotVersion:s.order_snapshot_version??null,orderSnapshotSha256:s.order_snapshot_sha256??null,clientReportedCapture:s.client_reported_context??null,id: s.id, proofId: s.proof_id, stageId: s.stage_id, registrationTiming: s.recorded_at ? (new Date(s.recorded_at).getTime() > new Date(s.expires_at).getTime() ? "DELAYED_NOT_INDEPENDENTLY_ATTESTED" : "WITHIN_START_WINDOW") : "NOT_REGISTERED", client: s.client, policyVersion: s.policy_version,
    workflowStep: s.workflow_step, state: s.state, expiresAt: asRequiredIso(s.expires_at),
    recoverUntil: asRequiredIso(s.recover_until), recordedAt: s.recorded_at ? asRequiredIso(s.recorded_at) : null,
    sha256: s.expected_sha256, byteSize: s.expected_byte_size == null ? null : Number(s.expected_byte_size),
    contentType: s.content_type, evidenceId: s.evidence_id, assurance: CAPTURE_ASSURANCE,
    maxRecordingBytes: s.max_recording_bytes == null ? CAPTURE_MAX_BYTES : Number(s.max_recording_bytes),
    maxRecordingSeconds: (s.max_duration_ms ?? CAPTURE_MAX_DURATION_MS) / 1000 };
}
async function captureAccess(db: Database, actor: string, proofId: string, writable = true, stageId?: string | null) {
  if (stageId) {
    const role=await requireCommerceAccess(db,proofId,actor);
    const stage=(await db.query<{stage_type:string;actor_user_id:string;finalized_at:unknown}>(`SELECT stage_type,actor_user_id,finalized_at FROM commerce_stages WHERE id=$1 AND proof_id=$2${writable?' FOR UPDATE':''}`,[stageId,proofId])).rows[0];
    if(!stage || stage.actor_user_id!==actor || role!==(stage.stage_type==='RETURN_RECEIPT'?'SELLER':'BUYER')) throw new DomainError('CAPTURE_STAGE_NOT_AUTHORIZED','This capture stage belongs to another participant or Proof',403);
    if(writable && stage.finalized_at) throw new DomainError('COMMERCE_STAGE_IMMUTABLE','This capture stage is finalized',409);
    return {workflowStep:stage.stage_type};
  }
  const proof = await loadProof(db, proofId, writable);
  const participant = await requireParticipant(db, proofId, actor);
  if (participant.role !== 'SELLER') throw new DomainError('PARTICIPANT_NOT_AUTHORIZED','Only the seller can record packing',403);
  if (writable) {
    assertNotFinalized(proof);
    if (!['READY_FOR_EVIDENCE','EVIDENCE_COMMITTED'].includes(proof.status))
      throw new DomainError('INVALID_PROOF_TRANSITION','This Proof is not ready for packing',422);
  }
  return {workflowStep:"PACKING"};
}
export async function loadCaptureSession(db: Database, actor: string, proofId: string, sessionId: string, lock = false) {
  const result = await db.query<CaptureSessionRow>(`SELECT * FROM capture_sessions WHERE id=$1 AND proof_id=$2 AND actor_user_id=$3${lock ? ' FOR UPDATE' : ''}`, [sessionId,proofId,actor]);
  if (!result.rows[0]) throw new DomainError('CAPTURE_SESSION_NOT_FOUND','Capture session does not belong to this participant and Proof',404);
  return {...result.rows[0],client_reported_context:await readCaptureClientContext(db,sessionId)};
}
export async function createCaptureSession(db: Database, clock: Clock, actor: string, proofId: string, input: {idempotencyKey: string; client: string; stageId?: string}) {
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200)
    throw new DomainError('IDEMPOTENCY_KEY_REQUIRED','A capture idempotency key is required',400);
  if (!['WEB_CAMERA','NATIVE_CAMERA'].includes(input.client))
    throw new DomainError('CAPTURE_CLIENT_REQUIRED','Start recording using the web or native camera workflow',400);
  if (!input.stageId) await prepareIntakeCaptureEntry(db,clock,actor,proofId);
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
    const context=await captureAccess(tx,actor,proofId,true,input.stageId);
    const existing = await tx.query<CaptureSessionRow>('SELECT * FROM capture_sessions WHERE proof_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',[proofId,actor,input.idempotencyKey]);
    if (existing.rows[0]) {
      if (existing.rows[0].client !== input.client || (existing.rows[0].stage_id ?? undefined)!==input.stageId) throw new DomainError('CAPTURE_SESSION_CONFLICT','Capture retry cannot change its client',409);
      return captureSessionView(existing.rows[0]);
    }
    if (!input.stageId) {
      const intakeContract=(await tx.query<{contract_version:number}>('SELECT contract_version FROM proof_order_contexts WHERE proof_id=$1',[proofId])).rows[0];
      if (intakeContract?.contract_version===1 && (await tx.query("SELECT 1 FROM capture_sessions WHERE proof_id=$1 AND stage_id IS NULL AND state<>'CANCELLED' LIMIT 1",[proofId])).rows.length)
        throw new DomainError('INTAKE_CAPTURE_IN_PROGRESS','Resume the current recording or finish its attestation before starting another',409);
      const proof = await loadProof(tx, proofId);
      await assertSupportedParcelCapture(tx, proof.transaction_id);
    }
    const active = await tx.query<{count: string}>("SELECT COUNT(*) AS count FROM capture_sessions WHERE proof_id=$1 AND actor_user_id=$2 AND state IN ('ISSUED','RECORDED','UPLOADING') AND recover_until > $3",[proofId,actor,clock.now().toISOString()]);
    if (Number(active.rows[0].count) >= 20) throw new DomainError('CAPTURE_QUEUE_FULL','Finish or cancel pending recordings before starting another',409);
    const allowance = input.stageId ? {enforced:false as const} : await reserveApprovedCaptureAllowance(tx,clock,{userId:actor,proofId});
    const maxRecordingBytes = Math.min(CAPTURE_MAX_BYTES,allowance.enforced ? allowance.maxRecordingBytes! : CAPTURE_MAX_BYTES);
    const maxDurationMs = Math.min(CAPTURE_MAX_DURATION_MS,allowance.enforced ? allowance.maxRecordingSeconds!*1000 : CAPTURE_MAX_DURATION_MS);
    const now=clock.now(); const id=newId('cap');
    const result=await tx.query<CaptureSessionRow>(`INSERT INTO capture_sessions(id,proof_id,actor_user_id,idempotency_key,client,policy_version,state,created_at,expires_at,recover_until,stage_id,workflow_step,max_duration_ms,max_recording_bytes) VALUES($1,$2,$3,$4,$5,$6,'ISSUED',$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[id,proofId,actor,input.idempotencyKey,input.client,CAPTURE_POLICY_VERSION,now.toISOString(),new Date(now.getTime()+ACQUISITION_MS).toISOString(),new Date(now.getTime()+RECOVERY_MS).toISOString(),input.stageId??null,context.workflowStep,maxDurationMs,maxRecordingBytes]);
    if (!input.stageId) await pinCurrentIntakeCaptureContext(tx,clock,actor,proofId,id);
    await appendAudit(tx,{proofId,actorUserId:actor,eventType:'CAPTURE_SESSION_ISSUED',eventData:{sessionId:id,client:input.client,policyVersion:CAPTURE_POLICY_VERSION,assurance:CAPTURE_ASSURANCE},at:now});
    return captureSessionView(await loadCaptureSession(tx,actor,proofId,id));
  });
}
export async function completeCaptureSession(db: Database, clock: Clock, actor: string, proofId: string, sessionId: string, input: {sha256: string; byteSize: number; contentType: string; interrupted?: boolean; recordedDurationMs?: number}) {
  if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sha256) || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > CAPTURE_MAX_BYTES)
    throw new DomainError('INVALID_CAPTURE_RECORDING','A nonempty recording up to 250 MB and its SHA-256 digest are required',413);
  if(input.interrupted!==undefined && typeof input.interrupted!=="boolean") throw new DomainError("INVALID_CAPTURE_CONTEXT","Interruption status must be a boolean",400);
  if(input.recordedDurationMs!==undefined && (!Number.isSafeInteger(input.recordedDurationMs) || input.recordedDurationMs<0 || input.recordedDurationMs>1800000)) throw new DomainError("INVALID_CAPTURE_CONTEXT","Reported recording duration must be an integer from 0 to 1800000 milliseconds",400);
  const contentType=String(input.contentType).split(';')[0].trim().toLowerCase();
  if (!['video/mp4','video/webm','video/quicktime'].includes(contentType)) throw new DomainError('UNSUPPORTED_CAPTURE_CODEC','Use MP4, WebM, or QuickTime camera recording',400);
  return db.transaction(async tx => {
    const context=await loadCaptureSession(tx,actor,proofId,sessionId);
    await captureAccess(tx,actor,proofId,true,context.stage_id);
    const s=await loadCaptureSession(tx,actor,proofId,sessionId,true);
    if (s.state === 'CANCELLED') throw new DomainError('CAPTURE_SESSION_CANCELLED','This recording was cancelled',409);
    // Duration is independently checked by ffprobe at commitment. Client wall-clock
    // duration is supplementary context and may include delays around recording stop.
    if (input.byteSize > Number(s.max_recording_bytes ?? CAPTURE_MAX_BYTES))
      throw new DomainError('CAPTURE_RECORDING_LIMIT','This recording exceeds the limits authorized when capture started. Preserve the original.',422);
    if (s.expected_sha256) {
      if (s.expected_sha256 !== input.sha256.toLowerCase() || Number(s.expected_byte_size) !== input.byteSize || s.content_type !== contentType)
        throw new DomainError('CAPTURE_RECORDING_CONFLICT','A session cannot be reused for different recorded bytes',409);
      await appendCaptureClientReport(tx,clock,actor,proofId,sessionId,input);
      return captureSessionView(await loadCaptureSession(tx,actor,proofId,sessionId));
    }
    if (clock.now().getTime()>new Date(s.recover_until).getTime()) throw new DomainError('CAPTURE_SESSION_EXPIRED','The preauthorized recording is beyond its recovery window. Preserve this file locally and start a new recording.',409);
    await appendCaptureClientReport(tx,clock,actor,proofId,sessionId,input);
    const updated=await tx.query<CaptureSessionRow>(`UPDATE capture_sessions SET state='RECORDED',recorded_at=$2,expected_sha256=$3,expected_byte_size=$4,content_type=$5 WHERE id=$1 RETURNING *`,[sessionId,clock.now().toISOString(),input.sha256.toLowerCase(),input.byteSize,contentType]);
    await appendAudit(tx,{proofId,actorUserId:actor,eventType:'CAPTURE_RECORDING_REGISTERED',eventData:{sessionId,sha256:input.sha256.toLowerCase(),byteSize:input.byteSize,delayedRegistration:clock.now().getTime()>new Date(s.expires_at).getTime(),offlineTimingIndependentlyAttested:false},at:clock.now()});
    return captureSessionView({...updated.rows[0],client_reported_context:await readCaptureClientContext(tx,sessionId)});
  });
}
export async function recoverCaptureSession(db: Database, clock: Clock, actor: string, proofId: string, sessionId: string) {
  const s=await loadCaptureSession(db,actor,proofId,sessionId);
  await captureAccess(db,actor,proofId,false,s.stage_id);
  if (s.state !== 'COMMITTED') assertCaptureRecoverable(s,clock);
  return captureSessionView(s);
}
export function assertCaptureRecoverable(s: CaptureSessionRow, clock: Clock) {
  if (!['RECORDED','UPLOADING'].includes(s.state)) throw new DomainError('CAPTURE_RECORDING_REQUIRED','Finish an authorized camera recording before uploading',409);
  if (clock.now().getTime()>new Date(s.recover_until).getTime()) throw new DomainError('CAPTURE_RECOVERY_EXPIRED','This recording is beyond its upload recovery window. The original remains on this device.',409);
}
export async function eligibleCaptureSession(db: Database, clock: Clock, actor: string, proofId: string, sessionId: string | undefined, contentType: string, stageId?: string) {
  if (!sessionId) throw new DomainError('CAPTURE_SESSION_REQUIRED','Primary packing evidence requires an authorized camera recording session',422);
  const s=await loadCaptureSession(db,actor,proofId,sessionId,true);
  assertCaptureRecoverable(s,clock);
  if (s.policy_version!==CAPTURE_POLICY_VERSION || (s.stage_id??undefined)!==stageId || (!stageId && s.workflow_step!=='PACKING') || s.content_type !== contentType.split(';')[0].trim().toLowerCase())
    throw new DomainError('CAPTURE_SESSION_CONFLICT','The recording does not match this capture workflow',409);
  return s;
}
export async function cancelCaptureSession(db: Database, clock: Clock, actor: string, proofId: string, sessionId: string) {
  return db.transaction(async tx => {
    const context=await loadCaptureSession(tx,actor,proofId,sessionId);
    await captureAccess(tx,actor,proofId,true,context.stage_id);
    const s=await loadCaptureSession(tx,actor,proofId,sessionId,true);
    if (s.state==='COMMITTED') throw new DomainError('EVIDENCE_ALREADY_COMMITTED','Committed capture cannot be cancelled',409);
    if (s.evidence_id) {
      if(s.stage_id) await tx.query("UPDATE commerce_stage_evidence SET discarded_at=$2 WHERE id=$1 AND committed_at IS NULL AND discarded_at IS NULL",[s.evidence_id,clock.now().toISOString()]);
      else await tx.query("UPDATE evidence SET validation_status='REJECTED' WHERE id=$1 AND validation_status='PENDING'",[s.evidence_id]);
    }
    await tx.query("UPDATE capture_sessions SET state='CANCELLED' WHERE id=$1",[sessionId]);
    await appendAudit(tx,{proofId,actorUserId:actor,eventType:'CAPTURE_SESSION_CANCELLED',eventData:{sessionId},at:clock.now()});
    return {cancelled:true};
  });
}
