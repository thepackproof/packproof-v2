import { assertSupportedParcelCapture } from './parcel-scope.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { appendAudit } from './audit.js';
import { loadCaptureSession } from './capture-sessions.js';
import { DomainError } from './errors.js';
import { assertNotFinalized, loadProof, requireParticipant } from './proof-access.js';
import { insertShipping, lockTransactionContext } from './transactions.js';

/** Conservative identity recognition; a pattern is never a carrier verification. */
export function shippingBarcode(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 128) return null;
  let value = raw.replace(/[ \t\r\n-]/g, '').toUpperCase();
  if (/^420\d{5}9[2345]\d{20}$/.test(value)) value = value.slice(8);
  else if (/^420\d{9}9[2345]\d{20}$/.test(value)) value = value.slice(12);
  if (/^1Z[A-Z0-9]{16}$/.test(value)) return { trackingNumber: value, carrierHint: 'UPS', distinctive: true };
  if (/^9[2345]\d{20}$/.test(value)) return { trackingNumber: value, carrierHint: 'USPS', distinctive: true };
  // Other carrier numbers overlap product/order identifiers. Require a tap or an
  // exact match to the transaction's already-associated tracking number.
  if (/^[A-Z0-9]{10,26}$/.test(value) && /\d/.test(value))
    return { trackingNumber: value, carrierHint: null, distinctive: false };
  return null;
}

export interface ShippingScanInput {
  rawValue: string; format: string; detectedAtMs: number;
  idempotencyKey: string; confirmed?: boolean;
  source?: 'LIVE_CAMERA_ANALYSIS'|'ENCODED_VIDEO_FRAME'; decoderVersion?: string;
  coordinateSpace?: string; observedAtUnixMs?: number;
  frameWidth?: number; frameHeight?: number; bounds?: unknown;
}
export async function bindCaptureShipping(db: Database, clock: Clock, actor: string, proofId: string, sessionId: string, input: ShippingScanInput) {
  if (!input || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200 ||
      !Number.isSafeInteger(input.detectedAtMs) || input.detectedAtMs < 0 || input.detectedAtMs > 1800000 ||
      typeof input.format !== 'string' || !/^[A-Z0-9_ -]{1,32}$/i.test(input.format) ||
      (input.confirmed !== undefined && typeof input.confirmed !== 'boolean'))
    throw new DomainError('INVALID_SHIPPING_SCAN', 'A barcode format, video offset and retry key are required', 400);
  await requireParticipant(db, proofId, actor, 'SELLER');
  const proof = await loadProof(db, proofId);
  // Commit observations separately so a rejected association cannot erase them.
  // Taking the ordinary context lock also serializes this append with finalization.
  const observed = shippingBarcode(input.rawValue);
  const observationId = observed ? await db.transaction(async tx => {
    const context = await lockTransactionContext(tx, proof.transaction_id);
    if (context.proofStatus === 'FINALIZED') return null;
    const source = await loadCaptureSession(tx, actor, proofId, sessionId, true);
    if (!['NATIVE_CAMERA','WEB_CAMERA'].includes(source.client) || source.stage_id || source.workflow_step !== 'PACKING' || source.state === 'CANCELLED'
      || clock.now().getTime() > new Date(source.recover_until).getTime()
      || (source.client_reported_context?.recordedDurationMs != null && input.detectedAtMs > source.client_reported_context.recordedDurationMs)) return null;
    const contextInput = scanContext(input);
    await tx.query(`INSERT INTO capture_label_observations(id,proof_id,session_id,actor_user_id,tracking_number,carrier_hint,detected_at_ms,barcode_format,received_at,raw_value,observation_context)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(session_id,tracking_number) DO NOTHING`,
      [newId('scan'),proofId,sessionId,actor,observed.trackingNumber,observed.carrierHint,input.detectedAtMs,input.format,clock.now().toISOString(),input.rawValue,JSON.stringify(contextInput)]);
    return (await tx.query<{id:string}>('SELECT id FROM capture_label_observations WHERE session_id=$1 AND tracking_number=$2',[sessionId,observed.trackingNumber])).rows[0].id;
  }) : null;
  return db.transaction(async tx => {
    // Same lock order as shipping edits/finalization; never hold locks over HTTP.
    const context = await lockTransactionContext(tx, proof.transaction_id);
    const session = await loadCaptureSession(tx, actor, proofId, sessionId, true);
    if (!['NATIVE_CAMERA','WEB_CAMERA'].includes(session.client) || session.stage_id || session.workflow_step !== 'PACKING' || session.state === 'CANCELLED')
      throw new DomainError('SHIPPING_SCAN_SESSION_INVALID', 'Use an active packing capture session', 409);
    const candidate = shippingBarcode(input.rawValue);
    if (!candidate) return { status: 'UNRECOGNIZED' as const };
    const requestHash = sha256Hex(JSON.stringify({ ...candidate, format: input.format, detectedAtMs: input.detectedAtMs, confirmed: input.confirmed === true }));
    const existing = (await tx.query<{id:string;request_sha256:string}>(
      'SELECT id,request_sha256 FROM capture_shipping_labels WHERE session_id=$1 AND idempotency_key=$2', [sessionId,input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.request_sha256 !== requestHash) throw new DomainError('SHIPPING_SCAN_CONFLICT', 'A scan retry cannot change its contents', 409);
      return { status: 'BOUND' as const, ...candidate, observationId: existing.id, proofId, transactionId: proof.transaction_id };
    }
    assertNotFinalized(await loadProof(tx, proofId));
    if (!['READY_FOR_EVIDENCE','EVIDENCE_COMMITTED'].includes(context.proofStatus ?? '') || clock.now().getTime() > new Date(session.recover_until).getTime())
      throw new DomainError('SHIPPING_SCAN_SESSION_EXPIRED', 'This Proof is no longer accepting packing scans', 409);
    if (session.client_reported_context?.recordedDurationMs != null && input.detectedAtMs > session.client_reported_context.recordedDurationMs)
      throw new DomainError('INVALID_SHIPPING_SCAN', 'The scan falls outside the reported recording', 400);
    await assertSupportedParcelCapture(tx,proof.transaction_id);
    const current = context.shipping?.tracking_number;
    const normalizedCurrent = current?.replace(/[ \t\r\n-]/g, '').toUpperCase();
    if (normalizedCurrent && normalizedCurrent !== candidate.trackingNumber)
      return { status: 'CONFLICT' as const, ...candidate, observationId, currentTrackingNumber: current };
    if (normalizedCurrent !== candidate.trackingNumber && !input.confirmed)
      return { status: 'NEEDS_CONFIRMATION' as const, ...candidate, observationId };
    const duplicate = (await tx.query<{id:string}>('SELECT id FROM capture_shipping_labels WHERE session_id=$1 AND tracking_number=$2',[sessionId,candidate.trackingNumber])).rows[0];
    if (duplicate) return { status: 'BOUND' as const, ...candidate, observationId: duplicate.id, proofId, transactionId: proof.transaction_id };
    if (observationId && (await tx.query('SELECT 1 FROM capture_label_resolutions WHERE observation_id=$1', [observationId])).rows.length) {
      throw new DomainError('LABEL_RESOLUTION_CONFLICT', 'This label was recorded as belonging to another package and cannot be reassigned.', 409);
    }
    const now = clock.now();
    if (!current) {
      const confirmedDeclaration = await tx.query("SELECT 1 FROM attestations WHERE proof_id=$1 AND statement='PACKED_DESCRIBED_ITEM' LIMIT 1", [proofId]);
      if (confirmedDeclaration.rows.length) throw new DomainError('ATTESTATION_CONTEXT_LOCKED', 'This recording has already been confirmed. Tracking must be recorded as a later attributed observation.', 409);
      if (context.shipping) await tx.query('UPDATE transaction_shipping SET tracking_number=$2,carrier=COALESCE(carrier,$3),updated_at=$4 WHERE transaction_id=$1', [proof.transaction_id,candidate.trackingNumber,candidate.carrierHint,now.toISOString()]);
      else await insertShipping(tx,proof.transaction_id,{trackingNumber:candidate.trackingNumber,carrier:candidate.carrierHint,service:null,shipmentDate:null},now.toISOString());
    }
    const id = newId('label');
    await tx.query(`INSERT INTO capture_shipping_labels(id,proof_id,transaction_id,session_id,actor_user_id,idempotency_key,request_sha256,tracking_number,carrier_hint,detected_at_ms,barcode_format,participant_confirmed,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,proofId,proof.transaction_id,sessionId,actor,input.idempotencyKey,requestHash,candidate.trackingNumber,candidate.carrierHint,input.detectedAtMs,input.format,input.confirmed===true,now.toISOString()]);
    await tx.query(`INSERT INTO capture_shipment_jobs(transaction_id,actor_user_id,state,next_run_at,updated_at) VALUES($1,$2,'QUEUED',$3,$3) ON CONFLICT(transaction_id) DO NOTHING`,[proof.transaction_id,actor,now.toISOString()]);
    await appendAudit(tx,{proofId,actorUserId:actor,eventType:'SHIPPING_LABEL_CAPTURED',eventData:{observationId:id,sessionId,trackingNumber:candidate.trackingNumber,carrierHint:candidate.carrierHint,detectedAtMs:input.detectedAtMs,participantConfirmed:input.confirmed===true,source:'PACKPROOF_CAPTURE',assurance:'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED'},at:now});
    return {status:'BOUND' as const,...candidate,observationId:id,proofId,transactionId:proof.transaction_id};
  });
}

export async function getCaptureShipping(db: Database, proofId: string) {
  const observations = (await db.query<{id:string;session_id:string;tracking_number:string;carrier_hint:string|null;detected_at_ms:number;participant_confirmed:boolean;evidence_id:string|null}>(
    `SELECT l.id,l.session_id,l.tracking_number,l.carrier_hint,l.detected_at_ms,l.participant_confirmed,s.evidence_id FROM capture_shipping_labels l JOIN capture_sessions s ON s.id=l.session_id WHERE l.proof_id=$1 ORDER BY l.created_at,l.id`,[proofId])).rows;
  if (!observations.length) return null;
  const job = (await db.query<{state:string;carrier:string|null;provider_mode:string|null;last_error_code:string|null;registered_at:string|Date|null}>(
    'SELECT j.state,j.carrier,j.provider_mode,j.last_error_code,j.registered_at FROM capture_shipment_jobs j JOIN proofs p ON p.transaction_id=j.transaction_id WHERE p.id=$1',[proofId])).rows[0];
  return { source:'PACKPROOF_CAPTURE' as const, assurance:'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED' as const,
    observations:observations.map(o=>({observationId:o.id,sessionId:o.session_id,evidenceId:o.evidence_id,trackingNumber:o.tracking_number,carrierHint:o.carrier_hint,detectedAtMs:o.detected_at_ms,participantConfirmed:o.participant_confirmed})),
    registration:{state:job?.state??'QUEUED',carrier:job?.carrier??null,mode:job?.provider_mode??null,errorCode:job?.last_error_code??null,registeredAt:job?.registered_at ? new Date(job.registered_at).toISOString():null} };
}

function scanContext(input: ShippingScanInput): Record<string, unknown> {
  if(input.source!==undefined&&!['LIVE_CAMERA_ANALYSIS','ENCODED_VIDEO_FRAME'].includes(input.source)) throw new DomainError('INVALID_SHIPPING_SCAN','Unsupported barcode observation source.',400);
  if(input.decoderVersion!==undefined&&(typeof input.decoderVersion!=='string'||input.decoderVersion.length>100)) throw new DomainError('INVALID_SHIPPING_SCAN','Invalid decoder version.',400);
  if(input.coordinateSpace!==undefined&&(typeof input.coordinateSpace!=='string'||input.coordinateSpace.length>100)) throw new DomainError('INVALID_SHIPPING_SCAN','Invalid coordinate space.',400);
  for(const key of ['observedAtUnixMs','frameWidth','frameHeight'] as const) if(input[key]!==undefined&&(!Number.isSafeInteger(input[key])||input[key]!<0)) throw new DomainError('INVALID_SHIPPING_SCAN','Invalid observation coordinates or time.',400);
  if(input.bounds!==undefined&&(typeof input.bounds!=='object'||input.bounds===null||JSON.stringify(input.bounds).length>500)) throw new DomainError('INVALID_SHIPPING_SCAN','Invalid barcode bounds.',400);
  return {source:input.source??'LIVE_CAMERA_ANALYSIS',decoderVersion:input.decoderVersion??null,coordinateSpace:input.coordinateSpace??null,
    observedAtUnixMs:input.observedAtUnixMs??null,frameWidth:input.frameWidth??null,frameHeight:input.frameHeight??null,bounds:input.bounds??null,
    videoOffsetAssurance:'CLIENT_REPORTED_APPROXIMATE',assurance:'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED'};
}
