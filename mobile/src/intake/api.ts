import { Platform } from "react-native";
import type { IntakeObservationDetail, IntakeResolution } from "./resolution";
import type { PackProofV2Client } from '../v2-api';
import type { IntakeAcceptance, IntakeCapabilities, IntakeDevice, IntakeDeviceCredentials, IntakeOrder, IntakePending } from './model';
import type { IntakeSubmission, SubmissionEnvelope } from './submissions';
import type { SentHandoff } from './handoff-sender';

export interface IntakeAlias { id: string; address: string; connectionId: string; provider: string; store: string; state: 'AWAITING_VERIFICATION' | 'AWAITING_VALID_SAMPLE' | 'READY' | 'REVOKED'; lastReceivedAt: string | null; lastErrorCode: string | null; challenge: { id: string; code: string | null; url: string | null; expiresAt: string } | null; supportedTemplates: string[]; }
export class IntakeApi {
  constructor(private client: PackProofV2Client) {}
  submit(input: SubmissionEnvelope): Promise<IntakeSubmission> { return this.client.intakeRequest('/submissions', 'POST', input); }
  submissions(): Promise<{ submissions: IntakeSubmission[] }> { return this.client.intakeRequest('/submissions'); }
  submission(id: string): Promise<IntakeSubmission> { return this.client.intakeRequest(`/submissions/${encodeURIComponent(id)}`); }
  resolveSubmission(id: string, input: Record<string, never> | { candidateId: string } | { confirmed: true; details: { itemTitle: string; quantity?: number; externalReference?: string; currency?: string; transactionValue?: number; physicalFulfillment?: boolean; paid?: boolean; fulfillmentScope?: 'FULL_ORDER' | 'PARTIAL' | 'MULTI_PARCEL' | 'UNKNOWN' } }): Promise<IntakeSubmission> { return this.client.intakeRequest(`/submissions/${encodeURIComponent(id)}/resolve`, 'POST', input); }
  dismissSubmission(id: string): Promise<IntakeSubmission> { return this.client.intakeRequest(`/submissions/${encodeURIComponent(id)}/dismiss`, 'POST', {}); }
  createIntakeSession(): Promise<{ sessionId: string; token: string; actorId: string; expiresAt: string }> { return this.client.intakeRequest('/sessions', 'POST', {}); }
  revokeIntakeSession(id: string): Promise<void> { return this.client.intakeRequest(`/sessions/${encodeURIComponent(id)}/revoke`, 'POST', {}); }
  capabilities(): Promise<IntakeCapabilities> { return this.client.intakeRequest('/capabilities'); }
  orders(): Promise<{ orders: IntakeOrder[] }> { return this.client.intakeRequest('/orders'); }
  observation(id: string): Promise<IntakeObservationDetail> { return this.client.intakeRequest(`/observations/${encodeURIComponent(id)}`); }
  resolveObservation(id: string, input: IntakeResolution): Promise<IntakeOrder> { return this.client.intakeRequest(`/observations/${encodeURIComponent(id)}/resolve`, 'POST', input); }
  capture(snapshotId: string, idempotencyKey: string): Promise<IntakeAcceptance> { return this.client.intakeRequest(`/orders/${encodeURIComponent(snapshotId)}/capture`, 'POST', { idempotencyKey, client: 'NATIVE_CAMERA', surface: Platform.OS === 'ios' ? 'IOS' : 'ANDROID' }); }
  register(name: string): Promise<{ device: IntakeDevice; deviceToken: string; pairingCode: string }> { return this.client.intakeRequest('/devices', 'POST', { name }); }
  devices(): Promise<{ devices: IntakeDevice[] }> { return this.client.intakeRequest('/devices'); }
  approve(deviceId: string, pairingCode: string): Promise<{ device: IntakeDevice }> { return this.client.intakeRequest(`/devices/${encodeURIComponent(deviceId)}/approve`, 'POST', { pairingCode }); }
  prepare(transactionId: string): Promise<IntakeOrder> { return this.client.intakeRequest('/orders/prepare', 'POST', { transactionId }); }
  send(input: { snapshotId: string; targetDeviceId: string; idempotencyKey: string }): Promise<{ handoff: SentHandoff }> { return this.client.intakeRequest('/handoffs', 'POST', input); }
  pending(device: IntakeDeviceCredentials): Promise<IntakePending> { return this.client.intakeRequest(`/handoffs?deviceId=${encodeURIComponent(device.deviceId)}`, 'GET', undefined, { 'x-intake-device-token': device.deviceToken }); }
  claim(handoffId: string, device: IntakeDeviceCredentials, idempotencyKey: string): Promise<IntakeAcceptance> { return this.client.intakeRequest(`/handoffs/${encodeURIComponent(handoffId)}/claim`, 'POST', { deviceId: device.deviceId, idempotencyKey, client: 'NATIVE_CAMERA', surface: Platform.OS === 'ios' ? 'IOS' : 'ANDROID' }, { 'x-intake-device-token': device.deviceToken }); }
  revoke(deviceId: string): Promise<unknown> { return this.client.intakeRequest(`/devices/${encodeURIComponent(deviceId)}/revoke`, 'POST', {}); }
  release(device: IntakeDeviceCredentials, captureSessionId: string): Promise<unknown> { return this.client.intakeRequest(`/devices/${encodeURIComponent(device.deviceId)}/release`, 'POST', { captureSessionId }, { 'x-intake-device-token': device.deviceToken }); }
  aliases(): Promise<{ aliases: IntakeAlias[] }> { return this.client.intakeRequest('/mail'); }
  createAlias(connectionId: string): Promise<{ alias: IntakeAlias }> { return this.client.intakeRequest('/mail', 'POST', { connectionId }); }
  verifyAlias(id: string, challengeId: string): Promise<unknown> { return this.client.intakeRequest(`/mail/${encodeURIComponent(id)}/verify`, 'POST', { challengeId }); }
  revokeAlias(id: string): Promise<unknown> { return this.client.intakeRequest(`/mail/${encodeURIComponent(id)}/revoke`, 'POST', {}); }
}
