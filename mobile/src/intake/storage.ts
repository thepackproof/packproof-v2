import AsyncStorage from '@react-native-async-storage/async-storage';
import { newIdempotencyKey, type PackProofV2Client } from '../v2-api';
import { IntakeApi } from './api';
import type { IntakeDeviceCredentials } from './model';
import { handoffPreferenceKey, parseHandoffTarget } from './handoff-sender';

function scope(client: PackProofV2Client, userId: string) { return `packproof.intake:${encodeURIComponent(client.apiBaseUrl)}:${encodeURIComponent(userId)}`; }
export async function readIntakeDevice(client: PackProofV2Client, userId: string): Promise<IntakeDeviceCredentials | null> {
  const raw = await AsyncStorage.getItem(`${scope(client, userId)}:device`);
  if (!raw) return null;
  try { const value = JSON.parse(raw); return typeof value.deviceId === 'string' && typeof value.deviceToken === 'string' ? value : null; } catch { return null; }
}
export async function saveIntakeDevice(client: PackProofV2Client, userId: string, device: IntakeDeviceCredentials): Promise<void> { await AsyncStorage.setItem(`${scope(client, userId)}:device`, JSON.stringify(device)); }
export async function forgetIntakeDevice(client: PackProofV2Client, userId: string): Promise<void> { await AsyncStorage.removeItem(`${scope(client, userId)}:device`); }
export async function revokeIntakeDevice(client: PackProofV2Client, userId: string): Promise<void> {
  const device = await readIntakeDevice(client, userId);
  if (device) await new IntakeApi(client).revoke(device.deviceId);
  await forgetIntakeDevice(client, userId);
}
export async function intakeRequestKey(client: PackProofV2Client, userId: string, sourceId: string): Promise<string> {
  const key = `${scope(client, userId)}:claim:${encodeURIComponent(sourceId)}`;
  const existing = await AsyncStorage.getItem(key);
  if (existing) return existing;
  const created = newIdempotencyKey();
  // The UI claims under a single synchronous lock. Persist before transport so lost replies replay the same session.
  await AsyncStorage.setItem(key, created);
  return created;
}
export async function clearIntakeRequestKey(client: PackProofV2Client, userId: string, sourceId: string): Promise<void> { await AsyncStorage.removeItem(`${scope(client, userId)}:claim:${encodeURIComponent(sourceId)}`); }
export async function readHandoffTarget(client: PackProofV2Client, userId: string): Promise<string | null> {
  client.assertCaptureAccount(userId, client.apiBaseUrl);
  const target = await AsyncStorage.getItem(handoffPreferenceKey(client.apiBaseUrl, userId));
  client.assertCaptureAccount(userId, client.apiBaseUrl);
  return parseHandoffTarget(target);
}
export async function saveHandoffTarget(client: PackProofV2Client, userId: string, deviceId: string | null): Promise<void> {
  client.assertCaptureAccount(userId, client.apiBaseUrl);
  const key = handoffPreferenceKey(client.apiBaseUrl, userId);
  if (deviceId === null) { await AsyncStorage.removeItem(key); return; }
  if (!parseHandoffTarget(deviceId)) throw new Error('Choose a recording device from this account.');
  await AsyncStorage.setItem(key, deviceId);
}
