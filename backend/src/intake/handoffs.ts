import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { appendAudit } from '../domain/audit.js';
import { requireActiveAccount } from '../domain/account-access.js';
import { DomainError } from '../domain/errors.js';
import { createCaptureSession, loadCaptureSession, captureSessionView } from '../domain/capture-sessions.js';
import { loadProof } from '../domain/proof-access.js';
import { asRequiredIso } from '../domain/types.js';
import { readApprovedIntakeSnapshot, pinIntakeSnapshotForCapture, type IntakeSnapshot } from './context.js';

const PAIRING_MS = 5 * 60_000;
const HANDOFF_MS = 10 * 60_000;
const FOREGROUND_LEASE_MS = 15_000;
interface DeviceRow {
  id: string; actor_user_id: string; name: string; token_sha256: string; pairing_code_sha256: string;
  pairing_expires_at: string | Date; pairing_failures: number; approved_at: string | Date | null;
  revoked_at: string | Date | null; created_at: string | Date; last_seen_at: string | Date | null;
  lease_until: string | Date | null; last_sequence: string | number; active_capture_session_id: string | null;
}
interface HandoffRow {
  id: string; actor_user_id: string; target_device_id: string; tenant_key: string; transaction_id: string;
  proof_id: string; snapshot_id: string; snapshot_version: number; snapshot_sha256: string;
  order_card: IntakeSnapshot; idempotency_key: string; event_id: string; sequence: string | number;
  created_at: string | Date; expires_at: string | Date; state: 'PENDING' | 'CLAIMED' | 'EXPIRED' | 'REVOKED';
  claimed_at: string | Date | null; claim_key: string | null; capture_session_id: string | null;
  claim_response: ClaimResult | null;
}
type CaptureView = ReturnType<typeof captureSessionView>;
export interface ClaimResult {
  handoff: ReturnType<typeof handoffView>;
  session: CaptureView;
  proofId: string;
  transactionId: string;
  orderSnapshot: IntakeSnapshot;
}
function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
}
function secretMatches(secret: string, digest: string) {
  return typeof secret === 'string' && secret.length >= 8 && secret.length <= 256 && /^[a-f0-9]{64}$/.test(digest)
    && timingSafeEqual(Buffer.from(sha256Hex(secret)), Buffer.from(digest));
}
function deviceView(row: DeviceRow, clock: Clock) {
  return {
    id: row.id, name: row.name,
    state: row.revoked_at ? 'REVOKED' : row.approved_at ? 'APPROVED' : 'AWAITING_APPROVAL',
    approved: !!row.approved_at && !row.revoked_at,
    pairingExpiresAt: asRequiredIso(row.pairing_expires_at),
    approvedAt: row.approved_at ? asRequiredIso(row.approved_at) : null,
    lastSeenAt: row.last_seen_at ? asRequiredIso(row.last_seen_at) : null,
    leaseUntil: row.lease_until ? asRequiredIso(row.lease_until) : null,
    online: !row.revoked_at && !!row.lease_until && new Date(row.lease_until).getTime() > clock.now().getTime(),
    activeCaptureSessionId: row.active_capture_session_id, lastSequence: Number(row.last_sequence),
  };
}
function handoffView(row: HandoffRow, clock?: Clock) {
  const expired = row.state === 'PENDING' && !!clock && new Date(row.expires_at).getTime() <= clock.now().getTime();
  return { id: row.id, targetDeviceId: row.target_device_id, proofId: row.proof_id, transactionId: row.transaction_id,
    snapshotId: row.snapshot_id, snapshotVersion: row.snapshot_version, snapshotSha256: row.snapshot_sha256,
    orderSnapshot: row.order_card, sequence: Number(row.sequence), eventId: row.event_id,
    state: expired ? 'EXPIRED' as const : row.state, expiresAt: asRequiredIso(row.expires_at),
    captureSessionId: row.capture_session_id, claimedAt: row.claimed_at ? asRequiredIso(row.claimed_at) : null };
}
async function ownerDevice(db: Database, actor: string, id: string, lock = false) {
  await requireActiveAccount(db, actor);
  // Intake admission and capture creation lock the actor before their Proof.
  // Every device mutation follows actor -> device -> handoff -> Proof as well.
  if (lock) await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor]);
  const row = (await db.query<DeviceRow>(`SELECT * FROM intake_recording_devices WHERE id=$1 AND actor_user_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, actor])).rows[0];
  if (!row) throw new DomainError('INTAKE_DEVICE_NOT_FOUND', 'This recording device is not available for your account.', 404);
  return row;
}
async function authenticatedDevice(db: Database, actor: string, id: string, token: string, lock = false, allowPending = false) {
  const row = await ownerDevice(db, actor, id, lock);
  if (!secretMatches(token, row.token_sha256) || row.revoked_at)
    throw new DomainError('INTAKE_DEVICE_NOT_AUTHORIZED', 'This recording device is no longer paired. Pair it again from Settings.', 403);
  if (!allowPending && !row.approved_at)
    throw new DomainError('INTAKE_DEVICE_APPROVAL_REQUIRED', 'Approve this recording device in PackProof on your computer.', 409);
  return row;
}

/** The token is returned only to the enrolling authenticated device. Never put it in a URL. */
export async function registerIntakeDevice(db: Database, clock: Clock, actor: string, input: { name: string }) {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80)
    throw new DomainError('INTAKE_DEVICE_NAME_REQUIRED', 'Name this recording device using 1 to 80 characters.', 400);
  return db.transaction(async tx => {
    await requireActiveAccount(tx, actor);
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor]);
    const count = (await tx.query<{ count: string }>("SELECT COUNT(*) AS count FROM intake_recording_devices WHERE actor_user_id=$1 AND revoked_at IS NULL AND (approved_at IS NOT NULL OR pairing_expires_at>$2)", [actor, clock.now().toISOString()])).rows[0];
    if (Number(count.count) >= 10) throw new DomainError('INTAKE_DEVICE_LIMIT', 'Remove an unused recording device before pairing another.', 409);
    const deviceToken = randomBytes(32).toString('base64url');
    const pairingCode = randomBytes(6).toString('hex').toUpperCase();
    const now = clock.now();
    const row = (await tx.query<DeviceRow>(`INSERT INTO intake_recording_devices(id,actor_user_id,name,token_sha256,pairing_code_sha256,pairing_expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [newId('intake_device'), actor, input.name.trim(), sha256Hex(deviceToken), sha256Hex(pairingCode), new Date(now.getTime() + PAIRING_MS).toISOString(), now.toISOString()])).rows[0];
    return { device: deviceView(row, clock), deviceToken, pairingCode };
  });
}
export async function approveIntakeDevice(db: Database, clock: Clock, actor: string, deviceId: string, pairingCode: string) {
  const result = await db.transaction(async tx => {
    const row = await ownerDevice(tx, actor, deviceId, true);
    if (row.revoked_at || row.pairing_failures >= 5 || (!row.approved_at && new Date(row.pairing_expires_at).getTime() <= clock.now().getTime()))
      throw new DomainError('INTAKE_PAIRING_EXPIRED', 'Pairing expired. Start pairing again on the recording device.', 409);
    const supplied = typeof pairingCode === 'string' ? pairingCode.trim().toUpperCase() : '';
    if (!secretMatches(supplied, row.pairing_code_sha256)) {
      if (!row.approved_at) await tx.query('UPDATE intake_recording_devices SET pairing_failures=pairing_failures+1 WHERE id=$1', [deviceId]);
      return null;
    }
    if (row.approved_at) return deviceView(row, clock);
    const updated = (await tx.query<DeviceRow>('UPDATE intake_recording_devices SET approved_at=$2 WHERE id=$1 RETURNING *', [deviceId, clock.now().toISOString()])).rows[0];
    return deviceView(updated, clock);
  });
  // Commit failed-attempt accounting before raising the public error.
  if (!result) throw new DomainError('INTAKE_PAIRING_CODE_INVALID', 'The pairing code does not match this recording device.', 403);
  return { device: result };
}
export async function listIntakeDevices(db: Database, clock: Clock, actor: string) {
  await requireActiveAccount(db, actor);
  const rows = (await db.query<DeviceRow>('SELECT * FROM intake_recording_devices WHERE actor_user_id=$1 AND revoked_at IS NULL ORDER BY created_at,id', [actor])).rows;
  return { devices: rows.map(row => deviceView(row, clock)) };
}
export async function revokeIntakeDevice(db: Database, clock: Clock, actor: string, deviceId: string) {
  return db.transaction(async tx => {
    await ownerDevice(tx, actor, deviceId, true);
    await tx.query('UPDATE intake_recording_devices SET revoked_at=COALESCE(revoked_at,$2),lease_until=NULL WHERE id=$1', [deviceId, clock.now().toISOString()]);
    await tx.query("UPDATE intake_handoffs SET state='REVOKED' WHERE target_device_id=$1 AND state='PENDING'", [deviceId]);
    // Capture/evidence recovery remains authorized by the original Proof participant.
    return { revoked: true };
  });
}
export async function createIntakeHandoff(db: Database, clock: Clock, actor: string, input: { snapshotId: string; targetDeviceId: string; idempotencyKey: string; eventId?: string }) {
  if (!validKey(input.idempotencyKey) || !validKey(input.snapshotId) || !validKey(input.targetDeviceId) || (input.eventId !== undefined && !validKey(input.eventId)))
    throw new DomainError('INTAKE_HANDOFF_INVALID', 'Choose the prepared order and an approved recording device.', 400);
  return db.transaction(async tx => {
    // Serializes duplicate event IDs even when competing requests name different devices.
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor]);
    const previous = (await tx.query<HandoffRow>('SELECT * FROM intake_handoffs WHERE actor_user_id=$1 AND idempotency_key=$2', [actor, input.idempotencyKey])).rows[0];
    if (previous) {
      if (previous.snapshot_id !== input.snapshotId || previous.target_device_id !== input.targetDeviceId || previous.event_id !== (input.eventId ?? input.idempotencyKey))
        throw new DomainError('INTAKE_HANDOFF_RETRY_CONFLICT', 'A retry cannot change the order or recording device.', 409);
      const device = await ownerDevice(tx, actor, previous.target_device_id);
      return { handoff: handoffView(previous, clock), device: deviceView(device, clock), replayed: true };
    }
    const device = await ownerDevice(tx, actor, input.targetDeviceId, true);
    if (!device.approved_at || device.revoked_at) throw new DomainError('INTAKE_DEVICE_APPROVAL_REQUIRED', 'Choose an approved recording device in Settings.', 409);
    const snapshot = await readApprovedIntakeSnapshot(tx, actor, input.snapshotId);
    const next = (await tx.query<DeviceRow>('UPDATE intake_recording_devices SET last_sequence=last_sequence+1 WHERE id=$1 RETURNING *', [device.id])).rows[0];
    const now = clock.now();
    const row = (await tx.query<HandoffRow>(`INSERT INTO intake_handoffs(id,actor_user_id,target_device_id,tenant_key,transaction_id,proof_id,snapshot_id,snapshot_version,snapshot_sha256,order_card,idempotency_key,event_id,sequence,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15) RETURNING *`, [newId('handoff'), actor, device.id, snapshot.tenantKey, snapshot.transactionId, snapshot.proofId, snapshot.id, snapshot.version, snapshot.digest, JSON.stringify(snapshot), input.idempotencyKey, input.eventId ?? input.idempotencyKey, next.last_sequence, now.toISOString(), new Date(now.getTime() + HANDOFF_MS).toISOString()])).rows[0];
    await appendAudit(tx, { proofId: snapshot.proofId, actorUserId: actor, eventType: 'INTAKE_HANDOFF_CREATED', eventData: { handoffId: row.id, deviceId: device.id, snapshotId: snapshot.id, sequence: Number(row.sequence) }, at: now });
    return { handoff: handoffView(row), device: deviceView(next, clock), replayed: false };
  });
}

/** A lost lease marks the phone offline; it must never release a possibly ongoing recording. */
async function reconcileActiveCapture(db: Database, device: DeviceRow) {
  if (!device.active_capture_session_id) return null;
  const context = (await db.query<{ proof_id: string; state: string; proof_status: string }>(`SELECT c.proof_id,c.state,p.status AS proof_status FROM capture_sessions c JOIN proofs p ON p.id=c.proof_id WHERE c.id=$1 AND c.actor_user_id=$2`, [device.active_capture_session_id, device.actor_user_id])).rows[0];
  if (!context) throw new DomainError('INTAKE_CAPTURE_CONTEXT_MISSING', 'The recording context could not be recovered. Keep the original recording on this device.', 409);
  if (context.state === 'CANCELLED' || context.proof_status === 'FINALIZED') {
    await db.query('UPDATE intake_recording_devices SET active_capture_session_id=NULL WHERE id=$1', [device.id]);
    device.active_capture_session_id = null;
    return null;
  }
  return captureSessionView(await loadCaptureSession(db, device.actor_user_id, context.proof_id, device.active_capture_session_id));
}
export async function listIntakeHandoffs(db: Database, clock: Clock, actor: string, input: { deviceId: string; deviceToken: string; afterSequence?: number }) {
  if (input.afterSequence !== undefined && (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0))
    throw new DomainError('INTAKE_SEQUENCE_INVALID', 'Use the last displayed handoff sequence.', 400);
  return db.transaction(async tx => {
    const device = await authenticatedDevice(tx, actor, input.deviceId, input.deviceToken, true, true);
    if (!device.approved_at) return { device: deviceView(device, clock), handoffs: [], activeCapture: null };
    const activeSession = await reconcileActiveCapture(tx, device);
    let activeCapture: ClaimResult | null = null;
    if (activeSession) {
      const activeHandoff = (await tx.query<HandoffRow>("SELECT * FROM intake_handoffs WHERE capture_session_id=$1 AND actor_user_id=$2 AND target_device_id=$3", [activeSession.id, actor, device.id])).rows[0];
      if (!activeHandoff?.claim_response) throw new DomainError('INTAKE_CAPTURE_CONTEXT_MISSING', 'The recording context could not be recovered. Keep the original recording on this device.', 409);
      activeCapture = { ...activeHandoff.claim_response, session: activeSession };
    }
    const now = clock.now();
    const fresh = (await tx.query<DeviceRow>('UPDATE intake_recording_devices SET last_seen_at=$2,lease_until=$3 WHERE id=$1 RETURNING *', [device.id, now.toISOString(), new Date(now.getTime() + FOREGROUND_LEASE_MS).toISOString()])).rows[0];
    await tx.query("UPDATE intake_handoffs SET state='EXPIRED' WHERE target_device_id=$1 AND state='PENDING' AND expires_at<=$2", [device.id, now.toISOString()]);
    const rows = (await tx.query<HandoffRow>("SELECT * FROM intake_handoffs WHERE target_device_id=$1 AND actor_user_id=$2 AND state='PENDING' AND sequence>$3 ORDER BY sequence LIMIT 50", [device.id, actor, input.afterSequence ?? 0])).rows;
    return { device: deviceView(fresh, clock), handoffs: rows.map(row => handoffView(row)), activeCapture };
  });
}
export async function claimIntakeHandoff(db: Database, clock: Clock, actor: string, handoffId: string, input: { deviceId: string; deviceToken: string; idempotencyKey: string; client: string }): Promise<ClaimResult> {
  if (!validKey(input.idempotencyKey) || !['NATIVE_CAMERA', 'WEB_CAMERA'].includes(input.client))
    throw new DomainError('INTAKE_CLAIM_INVALID', 'Start this order using the existing camera workflow.', 400);
  return db.transaction(async tx => {
    const device = await authenticatedDevice(tx, actor, input.deviceId, input.deviceToken, true);
    const row = (await tx.query<HandoffRow>('SELECT * FROM intake_handoffs WHERE id=$1 AND actor_user_id=$2 AND target_device_id=$3 FOR UPDATE', [handoffId, actor, device.id])).rows[0];
    if (!row) throw new DomainError('INTAKE_HANDOFF_NOT_FOUND', 'This order handoff is not available for this recording device.', 404);
    if (row.state === 'CLAIMED') {
      if (row.claim_key !== input.idempotencyKey || row.claim_response?.session.client !== input.client)
        throw new DomainError('INTAKE_HANDOFF_ALREADY_CLAIMED', 'This order already has a recording session. Resume the original recording.', 409);
      return row.claim_response!;
    }
    if (row.state !== 'PENDING' || new Date(row.expires_at).getTime() <= clock.now().getTime())
      throw new DomainError('INTAKE_HANDOFF_EXPIRED', 'This phone prompt expired. The order is still prepared; send it to your phone again.', 409);
    if (await reconcileActiveCapture(tx, device)) throw new DomainError('INTAKE_DEVICE_BUSY', 'Finish the current recording and attestation first. This order stays queued.', 409);
    const snapshot = await readApprovedIntakeSnapshot(tx, actor, row.snapshot_id);
    if (snapshot.version !== row.snapshot_version || snapshot.digest !== row.snapshot_sha256 || snapshot.proofId !== row.proof_id || snapshot.transactionId !== row.transaction_id || snapshot.tenantKey !== row.tenant_key)
      throw new DomainError('INTAKE_HANDOFF_SNAPSHOT_CHANGED', 'The order context changed. Review the updated order before recording.', 409);
    // Existing command acquires the Proof lock. A second phone cannot open another
    // handoff capture for this Proof while the first capture remains in progress.
    await loadProof(tx, row.proof_id, true);
    const previousCapture = (await tx.query<{ id: string }>(`SELECT c.id FROM intake_handoffs h JOIN capture_sessions c ON c.id=h.capture_session_id WHERE h.proof_id=$1 AND h.state='CLAIMED' AND c.state<>'CANCELLED' LIMIT 1`, [row.proof_id])).rows[0];
    if (previousCapture) throw new DomainError('INTAKE_ORDER_ALREADY_RECORDING', 'This order already has a recording. Resume its original Proof.', 409);
    const session = await createCaptureSession(tx, clock, actor, row.proof_id, { client: input.client, idempotencyKey: `intake:${row.id}` });
    await pinIntakeSnapshotForCapture(tx, clock, actor, session.id, snapshot.id);
    const claimedAt = clock.now().toISOString();
    const response: ClaimResult = { handoff: handoffView({ ...row, state: 'CLAIMED', claimed_at: claimedAt, claim_key: input.idempotencyKey, capture_session_id: session.id }), session, proofId: row.proof_id, transactionId: row.transaction_id, orderSnapshot: snapshot };
    await tx.query("UPDATE intake_handoffs SET state='CLAIMED',claimed_at=$2,claim_key=$3,capture_session_id=$4,claim_response=$5::jsonb WHERE id=$1", [row.id, claimedAt, input.idempotencyKey, session.id, JSON.stringify(response)]);
    await tx.query('UPDATE intake_recording_devices SET active_capture_session_id=$2 WHERE id=$1', [device.id, session.id]);
    await appendAudit(tx, { proofId: row.proof_id, actorUserId: actor, eventType: 'INTAKE_HANDOFF_CLAIMED', eventData: { handoffId: row.id, sessionId: session.id, snapshotId: snapshot.id, snapshotSha256: snapshot.digest, deviceId: device.id }, at: clock.now() });
    return response;
  });
}
export async function releaseIntakeDevice(db: Database, clock: Clock, actor: string, deviceId: string, input: { deviceToken: string; captureSessionId: string }) {
  return db.transaction(async tx => {
    const device = await authenticatedDevice(tx, actor, deviceId, input.deviceToken, true);
    if (device.active_capture_session_id && device.active_capture_session_id !== input.captureSessionId)
      throw new DomainError('INTAKE_CAPTURE_CONTEXT_CONFLICT', 'A different recording is active on this device.', 409);
    const active = await reconcileActiveCapture(tx, device);
    if (active) throw new DomainError('INTAKE_DEVICE_BUSY', 'Finish or cancel the current recording before moving to the next order.', 409);
    return { device: deviceView(device, clock), released: true };
  });
}
