import type { IntakeDevice, IntakeOrder, IntakeSnapshot } from './model';

export type SentHandoff = {
  id: string; targetDeviceId: string; proofId: string; transactionId: string; snapshotId: string;
  snapshotSha256: string; state: string;
};
export function handoffPreferenceKey(apiBaseUrl: string, userId: string): string {
  return `packproof.intake:${encodeURIComponent(apiBaseUrl.replace(/\/+$/, ''))}:${encodeURIComponent(userId)}:sender-device`;
}
export function parseHandoffTarget(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{1,96}$/.test(value) ? value : null;
}
export function approvedRecordingDevices(devices: IntakeDevice[], localDeviceId?: string): IntakeDevice[] {
  return devices.filter(device => device.id !== localDeviceId && device.state === 'APPROVED');
}
export function reviewedHandoffSnapshot(order: IntakeOrder, proofId: string, transactionId: string): IntakeSnapshot {
  const snapshot = order.snapshot;
  if (order.readiness !== 'READY' || !snapshot) throw new Error('This order needs complete purchased-item and fulfillment details before it can be sent to a recording device.');
  if (order.proofId !== proofId || order.transactionId !== transactionId || snapshot.proofId !== proofId || snapshot.transactionId !== transactionId || !snapshot.id || !snapshot.digest)
    throw new Error('The prepared order differs from this Proof. Refresh its details before sending.');
  return snapshot;
}
export async function sendReviewedHandoff(input: { snapshot: IntakeSnapshot; targetDeviceId: string }, deps: {
  assertAccount(): void;
  readKey(sourceId: string): Promise<string>;
  clearKey(sourceId: string): Promise<void>;
  send(value: { snapshotId: string; targetDeviceId: string; idempotencyKey: string }): Promise<{ handoff: SentHandoff }>;
}): Promise<SentHandoff> {
  deps.assertAccount();
  if (!parseHandoffTarget(input.targetDeviceId)) throw new Error('Choose an approved recording device.');
  const sourceId = `send:${input.snapshot.id}:${input.targetDeviceId}`;
  const attempt = async () => {
    const idempotencyKey = await deps.readKey(sourceId); deps.assertAccount();
    const result = await deps.send({ snapshotId: input.snapshot.id, targetDeviceId: input.targetDeviceId, idempotencyKey });
    deps.assertAccount();
    const handoff = result?.handoff;
    if (!handoff || handoff.proofId !== input.snapshot.proofId || handoff.transactionId !== input.snapshot.transactionId || handoff.snapshotId !== input.snapshot.id || handoff.snapshotSha256 !== input.snapshot.digest || handoff.targetDeviceId !== input.targetDeviceId)
      throw new Error('The recording prompt does not match this reviewed order and device. Refresh before trying again.');
    return handoff;
  };
  let handoff = await attempt();
  // Only an authoritative expired prompt permits a new operation. A timeout retains the exact key.
  if (handoff.state === 'EXPIRED') { await deps.clearKey(sourceId); deps.assertAccount(); handoff = await attempt(); }
  if (handoff.state === 'REVOKED') throw new Error('This recording device has been disconnected. Choose another in Connections.');
  if (handoff.state === 'EXPIRED') throw new Error('The recording prompt expired. Refresh and try sending the order again.');
  if (!['PENDING','CLAIMED'].includes(handoff.state)) throw new Error('The recording device did not confirm this prompt. Try again.');
  return handoff;
}
