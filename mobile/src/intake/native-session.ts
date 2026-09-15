import AsyncStorage from '@react-native-async-storage/async-storage';
import { orderShare } from '../../modules/packproof-order-share';
import type { PackProofV2Client } from '../v2-api';
import { withRequestTimeout } from '../request-timeout';
import { IntakeApi } from './api';
const receiptKey = (api: string, account: string) => `packproof.intake-session:v1:${encodeURIComponent(api)}:${encodeURIComponent(account)}`;
type SessionReceipt = { sessionId: string; expiresAt: string };
let sessionGeneration = 0;
let refreshing = false;
let installed: string | null = null;
async function retainRevocation(key: string, receipt: SessionReceipt) {
  const pending: SessionReceipt[] = JSON.parse(await AsyncStorage.getItem(`${key}:revoke`) || '[]');
  await AsyncStorage.setItem(`${key}:revoke`, JSON.stringify([...pending.filter(row => row.sessionId !== receipt.sessionId && Date.parse(row.expiresAt) > Date.now()), receipt]));
}
/** Only the newly minted token can revoke itself after its host actor has changed. */
async function revokeUninstalled(api: string, accepted: SessionReceipt & { token: string }, key: string) {
  try {
    await withRequestTimeout(async signal => {
      const response = await fetch(`${api}/me/intake/sessions/${encodeURIComponent(accepted.sessionId)}/revoke`, {
        method: 'POST', headers: { Authorization: `Bearer ${accepted.token}`, 'Content-Type': 'application/json' }, body: '{}', signal,
      });
      if (!response.ok && ![401, 404, 410].includes(response.status)) throw new Error('Session revocation pending');
    }, 10000);
  } catch { await retainRevocation(key, { sessionId: accepted.sessionId, expiresAt: accepted.expiresAt }); }
}
export async function stopNativeIntakeSession(): Promise<void> {
  sessionGeneration += 1; installed = null;
  await orderShare?.setActiveAccount(null);
  await orderShare?.clearIntakeSession();
}
/** No bearer tokens in AsyncStorage; native transport owns protected credential storage. */
export async function refreshNativeIntakeSession(client: PackProofV2Client, accountId: string, label: string): Promise<void> {
  if (!orderShare || refreshing) return;
  const native = orderShare, generation = sessionGeneration, key = receiptKey(client.apiBaseUrl, accountId);
  refreshing = true;
  let minted: (SessionReceipt & { token: string; actorId: string }) | null = null;
  try {
    client.assertCaptureAccount(accountId, client.apiBaseUrl);
    const pending: SessionReceipt[] = JSON.parse(await AsyncStorage.getItem(`${key}:revoke`) || '[]');
    const remaining: SessionReceipt[] = [];
    for (const receipt of pending) {
      if (Date.parse(receipt.expiresAt) <= Date.now()) continue;
      try { client.assertCaptureAccount(accountId, client.apiBaseUrl); await new IntakeApi(client).revokeIntakeSession(receipt.sessionId); } catch { remaining.push(receipt); }
    }
    await AsyncStorage.setItem(`${key}:revoke`, JSON.stringify(remaining));
    const existing: SessionReceipt | null = JSON.parse(await AsyncStorage.getItem(key) || 'null');
    if (installed === key && existing && Date.parse(existing.expiresAt) > Date.now() + 10 * 60_000) return;
    client.assertCaptureAccount(accountId, client.apiBaseUrl);
    minted = await new IntakeApi(client).createIntakeSession();
    client.assertCaptureAccount(accountId, client.apiBaseUrl);
    if (generation !== sessionGeneration || minted.actorId !== accountId) throw new Error('Account changed');
    await native.setIntakeSession({ token: minted.token, sessionId: minted.sessionId, accountId, accountLabel: label, expiresAt: minted.expiresAt, apiBaseURL: client.apiBaseUrl });
    if (generation !== sessionGeneration) { await native.clearIntakeSession(); throw new Error('Account changed'); }
    await AsyncStorage.setItem(key, JSON.stringify({ sessionId: minted.sessionId, expiresAt: minted.expiresAt }));
    installed = key;
    minted = null;
    if (existing?.sessionId) {
      try { client.assertCaptureAccount(accountId, client.apiBaseUrl); await new IntakeApi(client).revokeIntakeSession(existing.sessionId); }
      catch { await retainRevocation(key, existing); }
    }
  } catch (error) {
    if (minted) await revokeUninstalled(client.apiBaseUrl, minted, key);
    throw error;
  } finally { refreshing = false; }
}
export async function clearNativeIntakeSession(client: PackProofV2Client, accountId: string): Promise<void> {
  await stopNativeIntakeSession();
  const key = receiptKey(client.apiBaseUrl, accountId);
  const existing: SessionReceipt | null = JSON.parse(await AsyncStorage.getItem(key) || 'null');
  // Preserve a nonsecret retry receipt when offline logout cannot reach the server.
  if (existing?.sessionId) {
    try { await new IntakeApi(client).revokeIntakeSession(existing.sessionId); }
    catch { await retainRevocation(key, existing); }
  }
  await AsyncStorage.removeItem(key);
}
