import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHarness, createUser, type TestHarness } from './helpers.js';
import { submitIntakeObservation, type IntakeSnapshot, type IntakeObservationInput } from '../src/intake/context.js';
import { registerIntakeDevice, approveIntakeDevice, revokeIntakeDevice, listIntakeDevices, createIntakeHandoff, listIntakeHandoffs, claimIntakeHandoff, releaseIntakeDevice } from '../src/intake/handoffs.js';
import { cancelCaptureSession, completeCaptureSession, recoverCaptureSession } from '../src/domain/capture-sessions.js';
import { initializeEvidenceUpload, commitEvidence } from '../src/domain/evidence.js';
import { commitAttestation } from '../src/domain/attestations.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { sha256Hex } from '../src/hash.js';
import type { Database } from '../src/db/database.js';

describe('durable exact-order handoffs', () => {
  let h: TestHarness;
  let seller: string;
  let other: string;
  let now: Date;
  const clock = { now: () => new Date(now) };
  const scope = { provider: 'ebay', externalAccountReference: 'handoff-store', namespaceSource: 'MARKETPLACE_API' as const, connectionId: 'test-ebay-connection', store: 'Camera store', verified: true as const };
  function observation(id: string): IntakeObservationInput {
    return { receiptId: `receipt-${id}`, sourceKind: 'API_OBSERVED', adapterKey: 'ebay-orders', adapterVersion: '1', externalOrderId: id, orderReference: `Order ${id}`,
      items: [{ title: 'Camera lens', quantity: 2, variant: 'Black / 50 mm' }, { title: 'Lens cover', quantity: 1 }],
      physicalFulfillment: true, paid: true, cancelled: false, fulfillmentScope: 'FULL_ORDER', sourceRevision: '1', sourceOccurredAt: now.toISOString() };
  }
  async function order(id = 'one'): Promise<IntakeSnapshot> {
    const result = await submitIntakeObservation(h.db, clock, seller, observation(id), scope);
    expect(result.readiness).toBe('READY');
    expect(result.snapshot).not.toBeNull();
    return result.snapshot!;
  }
  async function pair(name = 'Recording phone') {
    const enrolled = await registerIntakeDevice(h.db, clock, seller, { name });
    await approveIntakeDevice(h.db, clock, seller, enrolled.device.id, enrolled.pairingCode);
    return { ...enrolled, deviceId: enrolled.device.id };
  }
  async function send(snapshot: IntakeSnapshot, deviceId: string, key = 'handoff') {
    return (await createIntakeHandoff(h.db, clock, seller, { snapshotId: snapshot.id, targetDeviceId: deviceId, idempotencyKey: key })).handoff;
  }
  beforeEach(async () => {
    now = new Date('2026-09-08T12:00:00Z');
    h = await createHarness(clock);
    seller = await createUser(h);
    other = await createUser(h);
  });
  afterEach(async () => { await h?.close(); });

  it('requires owner approval and device possession; expires pairing and durably bounds code attempts', async () => {
    const phone = await registerIntakeDevice(h.db, clock, seller, { name: 'Galaxy A16' });
    const input = { deviceId: phone.device.id, deviceToken: phone.deviceToken };
    expect((await listIntakeHandoffs(h.db, clock, seller, input)).handoffs).toEqual([]);
    await expect(approveIntakeDevice(h.db, clock, other, input.deviceId, phone.pairingCode)).rejects.toMatchObject({ code: 'INTAKE_DEVICE_NOT_FOUND' });
    for (let attempt = 0; attempt < 5; attempt++) await expect(approveIntakeDevice(h.db, clock, seller, input.deviceId, 'wrong-pairing-code')).rejects.toMatchObject({ code: 'INTAKE_PAIRING_CODE_INVALID' });
    await expect(approveIntakeDevice(h.db, clock, seller, input.deviceId, phone.pairingCode)).rejects.toMatchObject({ code: 'INTAKE_PAIRING_EXPIRED' });
    const paired = await pair();
    await expect(listIntakeHandoffs(h.db, clock, seller, { deviceId: paired.deviceId, deviceToken: phone.deviceToken })).rejects.toMatchObject({ code: 'INTAKE_DEVICE_NOT_AUTHORIZED' });
    const safe = JSON.stringify(await listIntakeDevices(h.db, clock, seller));
    expect(safe).not.toContain(paired.deviceToken);
    expect(safe).not.toContain(paired.pairingCode);
    const stored = JSON.stringify((await h.db.query('SELECT * FROM intake_recording_devices')).rows);
    expect(stored).not.toContain(paired.deviceToken);
    expect(stored).not.toContain(paired.pairingCode);
    const expires = await registerIntakeDevice(h.db, clock, seller, { name: 'Expired' });
    now = new Date(now.getTime() + 5 * 60_000);
    await expect(approveIntakeDevice(h.db, clock, seller, expires.device.id, expires.pairingCode)).rejects.toMatchObject({ code: 'INTAKE_PAIRING_EXPIRED' });
  });

  it('serializes duplicate deliveries and claims, pins one capture, and recovers a lost reply after expiry', async () => {
    const snapshot = await order();
    const phone = await pair();
    const create = { snapshotId: snapshot.id, targetDeviceId: phone.deviceId, idempotencyKey: 'same-event' };
    const [a, b] = await Promise.all([createIntakeHandoff(h.db, clock, seller, create), createIntakeHandoff(h.db, clock, seller, create)]);
    expect(a.handoff.id).toBe(b.handoff.id);
    expect(a.handoff.sequence).toBe(1);
    const input = { deviceId: phone.deviceId, deviceToken: phone.deviceToken, idempotencyKey: 'same-accept', client: 'NATIVE_CAMERA' };
    const [first, retry] = await Promise.all([claimIntakeHandoff(h.db, clock, seller, a.handoff.id, input), claimIntakeHandoff(h.db, clock, seller, a.handoff.id, input)]);
    expect(retry).toEqual(first);
    expect((await h.db.query('SELECT order_snapshot_id,order_snapshot_version,order_snapshot_sha256 FROM capture_sessions WHERE id=$1', [first.session.id])).rows[0]).toEqual({ order_snapshot_id: snapshot.id, order_snapshot_version: snapshot.version, order_snapshot_sha256: snapshot.digest });
    expect(Number((await h.db.query<{ n: string }>('SELECT COUNT(*) AS n FROM capture_sessions')).rows[0].n)).toBe(1);
    now = new Date(now.getTime() + 11 * 60_000);
    expect(await claimIntakeHandoff(h.db, clock, seller, a.handoff.id, input)).toEqual(first);
    const restored = await listIntakeHandoffs(h.db, clock, seller, { deviceId: phone.deviceId, deviceToken: phone.deviceToken });
    expect(restored.activeCapture).toMatchObject({ proofId: snapshot.proofId, session: { id: first.session.id }, orderSnapshot: { id: snapshot.id } });
    await expect(claimIntakeHandoff(h.db, clock, seller, a.handoff.id, { ...input, idempotencyKey: 'different-accept' })).rejects.toMatchObject({ code: 'INTAKE_HANDOFF_ALREADY_CLAIMED' });
    await expect(h.db.query("UPDATE intake_handoffs SET snapshot_sha256=$2 WHERE id=$1", [a.handoff.id, '0'.repeat(64)])).rejects.toThrow('INTAKE_HANDOFF_IMMUTABLE');
  });

  it('keeps later orders queued across a lost lease and recording; explicit cancellation unlocks the next order', async () => {
    const phone = await pair();
    const first = await order('first');
    const second = await order('second');
    const initial = await send(first, phone.deviceId, 'first');
    const input = { deviceId: phone.deviceId, deviceToken: phone.deviceToken, client: 'NATIVE_CAMERA', idempotencyKey: 'accept-first' };
    const claim = await claimIntakeHandoff(h.db, clock, seller, initial.id, input);
    const queued = await send(second, phone.deviceId, 'second');
    now = new Date(now.getTime() + 30_000); // Presence lease may expire; capture ownership does not.
    const polled = await listIntakeHandoffs(h.db, clock, seller, input);
    expect(polled.handoffs.map(row => row.id)).toEqual([queued.id]);
    expect(polled.activeCapture?.session.id).toBe(claim.session.id);
    await expect(claimIntakeHandoff(h.db, clock, seller, queued.id, { ...input, idempotencyKey: 'accept-second' })).rejects.toMatchObject({ code: 'INTAKE_DEVICE_BUSY' });
    await expect(releaseIntakeDevice(h.db, clock, seller, phone.deviceId, { deviceToken: phone.deviceToken, captureSessionId: claim.session.id })).rejects.toMatchObject({ code: 'INTAKE_DEVICE_BUSY' });
    await cancelCaptureSession(h.db, clock, seller, first.proofId, claim.session.id);
    expect((await releaseIntakeDevice(h.db, clock, seller, phone.deviceId, { deviceToken: phone.deviceToken, captureSessionId: claim.session.id })).released).toBe(true);
    expect((await claimIntakeHandoff(h.db, clock, seller, queued.id, { ...input, idempotencyKey: 'accept-second' })).proofId).toBe(second.proofId);
    expect((await h.db.query<{ proof_id: string }>('SELECT proof_id FROM capture_sessions WHERE id=$1', [claim.session.id])).rows[0].proof_id).toBe(first.proofId);
  });

  it('rejects two-phone races, foreign orders, revoked devices and expired prompts without losing prepared orders', async () => {
    const snapshot = await order();
    const a = await pair('Phone A');
    const b = await pair('Phone B');
    const one = await send(snapshot, a.deviceId, 'send-a');
    const two = await send(snapshot, b.deviceId, 'send-b');
    const input = { deviceId: a.deviceId, deviceToken: a.deviceToken, client: 'NATIVE_CAMERA', idempotencyKey: 'claim-a' };
    await expect(claimIntakeHandoff(h.db, clock, seller, one.id, { ...input, deviceId: b.deviceId, deviceToken: b.deviceToken })).rejects.toMatchObject({ code: 'INTAKE_HANDOFF_NOT_FOUND' });
    const results = await Promise.allSettled([claimIntakeHandoff(h.db, clock, seller, one.id, input), claimIntakeHandoff(h.db, clock, seller, two.id, { ...input, deviceId: b.deviceId, deviceToken: b.deviceToken, idempotencyKey: 'claim-b' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const otherDevice = await registerIntakeDevice(h.db, clock, other, { name: 'Another seller phone' });
    await approveIntakeDevice(h.db, clock, other, otherDevice.device.id, otherDevice.pairingCode);
    await expect(createIntakeHandoff(h.db, clock, other, { snapshotId: snapshot.id, targetDeviceId: otherDevice.device.id, idempotencyKey: 'foreign-order' })).rejects.toMatchObject({ code: 'INTAKE_ORDER_NOT_FOUND' });
    await revokeIntakeDevice(h.db, clock, seller, a.deviceId);
    await expect(listIntakeHandoffs(h.db, clock, seller, input)).rejects.toMatchObject({ code: 'INTAKE_DEVICE_NOT_AUTHORIZED' });
    const another = await order('unrecorded');
    const expiring = await send(another, b.deviceId, 'expires');
    now = new Date(now.getTime() + 10 * 60_000);
    await expect(claimIntakeHandoff(h.db, clock, seller, expiring.id, { ...input, deviceId: b.deviceId, deviceToken: b.deviceToken })).rejects.toMatchObject({ code: 'INTAKE_HANDOFF_EXPIRED' });
    expect((await h.db.query('SELECT id FROM intake_order_snapshots WHERE id=$1', [another.id])).rows).toHaveLength(1);
  });

  it('fails stale orders and rolls back the capture, pin and claim together on a late write failure', async () => {
    const snapshot = await order();
    const phone = await pair();
    const handoff = await send(snapshot, phone.deviceId);
    const changed = observation('one');
    changed.receiptId = 'changed-items';
    changed.sourceRevision = '2';
    changed.items[0].quantity = 3;
    const observationResult = await submitIntakeObservation(h.db, clock, seller, changed, scope);
    expect(observationResult.readiness).toBe('NEEDS_INFORMATION');
    const input = { deviceId: phone.deviceId, deviceToken: phone.deviceToken, client: 'NATIVE_CAMERA', idempotencyKey: 'accept' };
    await expect(claimIntakeHandoff(h.db, clock, seller, handoff.id, input)).rejects.toMatchObject({ code: 'INTAKE_SNAPSHOT_STALE' });
    expect((await h.db.query('SELECT id FROM capture_sessions')).rows).toHaveLength(0);
    expect((await h.db.query('SELECT state,capture_session_id FROM intake_handoffs WHERE id=$1', [handoff.id])).rows[0]).toEqual({ state: 'PENDING', capture_session_id: null });
    const fresh = await order('fresh');
    const freshHandoff = await send(fresh, phone.deviceId, 'fresh');
    const failing: Database = { ...h.db, query: h.db.query.bind(h.db), transaction: fn => h.db.transaction(tx => {
      const wrapped: Database = { query: (sql, params) => {
        if (sql.startsWith('UPDATE intake_recording_devices SET active_capture_session_id=$2')) throw new Error('simulated device binding failure');
        return tx.query(sql, params);
      }, transaction: nested => nested(wrapped) };
      return fn(wrapped);
    }) };
    await expect(claimIntakeHandoff(failing, clock, seller, freshHandoff.id, input)).rejects.toThrow('simulated device binding failure');
    expect((await h.db.query('SELECT id FROM capture_sessions')).rows).toHaveLength(0);
    expect((await h.db.query('SELECT state,capture_session_id FROM intake_handoffs WHERE id=$1', [freshHandoff.id])).rows[0]).toEqual({ state: 'PENDING', capture_session_id: null });
    expect((await claimIntakeHandoff(h.db, clock, seller, freshHandoff.id, input)).proofId).toBe(fresh.proofId);
  });

  it('uses existing capture, upload, attestation and finalization; committed video keeps the device occupied until completion', async () => {
    const snapshot = await order();
    const phone = await pair();
    const handoff = await send(snapshot, phone.deviceId);
    const claim = await claimIntakeHandoff(h.db, clock, seller, handoff.id, { deviceId: phone.deviceId, deviceToken: phone.deviceToken, client: 'NATIVE_CAMERA', idempotencyKey: 'accept' });
    const media = await readFile(new URL('./fixtures/camera-recording.mp4', import.meta.url));
    await completeCaptureSession(h.db, clock, seller, snapshot.proofId, claim.session.id, { sha256: sha256Hex(media), byteSize: media.length, contentType: 'video/mp4' });
    const upload = await initializeEvidenceUpload(h.db, clock, h.objectStore, seller, snapshot.proofId, { contentType: 'video/mp4', evidenceType: 'FULFILLMENT_CAPTURE', captureSessionId: claim.session.id, idempotencyKey: 'upload' });
    await h.objectStore.put(upload.objectKey, media, 'video/mp4');
    const committed = await commitEvidence(h.db, clock, h.objectStore, seller, snapshot.proofId, upload.evidenceId);
    expect((await listIntakeHandoffs(h.db, clock, seller, { deviceId: phone.deviceId, deviceToken: phone.deviceToken })).activeCapture?.session.state).toBe('COMMITTED');
    await expect(releaseIntakeDevice(h.db, clock, seller, phone.deviceId, { deviceToken: phone.deviceToken, captureSessionId: claim.session.id })).rejects.toMatchObject({ code: 'INTAKE_DEVICE_BUSY' });
    await commitAttestation(h.db, clock, seller, snapshot.proofId, { statement: 'PACKED_DESCRIBED_ITEM', relatedEvidenceId: committed.evidenceId });
    const finalized = await finalizeProof(h.db, clock, seller, snapshot.proofId);
    expect((await finalizeProof(h.db, clock, seller, snapshot.proofId)).manifest.sha256).toBe(finalized.manifest.sha256);
    expect((await recoverCaptureSession(h.db, clock, seller, snapshot.proofId, claim.session.id)).state).toBe('COMMITTED');
    expect((await releaseIntakeDevice(h.db, clock, seller, phone.deviceId, { deviceToken: phone.deviceToken, captureSessionId: claim.session.id })).released).toBe(true);
  });
});
