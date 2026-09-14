import type { IntakeObservationDetail, IntakeResolution } from "./resolution";
import type { PackProofV2Client } from '../v2-api';
import type { IntakeAcceptance, IntakeCapabilities, IntakeDevice, IntakeDeviceCredentials, IntakeOrder, IntakePending } from './model';

export interface IntakeAlias { id: string; address: string; connectionId: string; provider: string; store: string; state: 'AWAITING_VERIFICATION' | 'AWAITING_VALID_SAMPLE' | 'READY' | 'REVOKED'; lastReceivedAt: string | null; lastErrorCode: string | null; challenge: { id: string; code: string | null; url: string | null; expiresAt: string } | null; supportedTemplates: string[]; }
export class IntakeApi {
  constructor(private client: PackProofV2Client) {}
  capabilities(): Promise<IntakeCapabilities> { return this.client.intakeRequest('/capabilities'); }
  orders(): Promise<{ orders: IntakeOrder[] }> { return this.client.intakeRequest('/orders'); }
  observation(id: string): Promise<IntakeObservationDetail> { return this.client.intakeRequest(`/observations/${encodeURIComponent(id)}`); }
  resolveObservation(id: string, input: IntakeResolution): Promise<IntakeOrder> { return this.client.intakeRequest(`/observations/${encodeURIComponent(id)}/resolve`, 'POST', input); }
  capture(snapshotId: string, idempotencyKey: string): Promise<IntakeAcceptance> { return this.client.intakeRequest(`/orders/${encodeURIComponent(snapshotId)}/capture`, 'POST', { idempotencyKey, client: 'NATIVE_CAMERA' }); }
  register(name: string): Promise<{ device: IntakeDevice; deviceToken: string; pairingCode: string }> { return this.client.intakeRequest('/devices', 'POST', { name }); }
  pending(device: IntakeDeviceCredentials): Promise<IntakePending> { return this.client.intakeRequest(`/handoffs?deviceId=${encodeURIComponent(device.deviceId)}`, 'GET', undefined, { 'x-intake-device-token': device.deviceToken }); }
  claim(handoffId: string, device: IntakeDeviceCredentials, idempotencyKey: string): Promise<IntakeAcceptance> { return this.client.intakeRequest(`/handoffs/${encodeURIComponent(handoffId)}/claim`, 'POST', { deviceId: device.deviceId, idempotencyKey, client: 'NATIVE_CAMERA' }, { 'x-intake-device-token': device.deviceToken }); }
  revoke(deviceId: string): Promise<unknown> { return this.client.intakeRequest(`/devices/${encodeURIComponent(deviceId)}/revoke`, 'POST', {}); }
  release(device: IntakeDeviceCredentials, captureSessionId: string): Promise<unknown> { return this.client.intakeRequest(`/devices/${encodeURIComponent(device.deviceId)}/release`, 'POST', { captureSessionId }, { 'x-intake-device-token': device.deviceToken }); }
  aliases(): Promise<{ aliases: IntakeAlias[] }> { return this.client.intakeRequest('/mail'); }
  createAlias(connectionId: string): Promise<{ alias: IntakeAlias }> { return this.client.intakeRequest('/mail', 'POST', { connectionId }); }
  verifyAlias(id: string, challengeId: string): Promise<unknown> { return this.client.intakeRequest(`/mail/${encodeURIComponent(id)}/verify`, 'POST', { challengeId }); }
  revokeAlias(id: string): Promise<unknown> { return this.client.intakeRequest(`/mail/${encodeURIComponent(id)}/revoke`, 'POST', {}); }
}
