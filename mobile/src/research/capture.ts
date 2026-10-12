import { productionReceiptEnrollment } from './production-policy';
import { assertClosedReceipt, type ReceiptReview } from './receipt-review';
import { uploadNativeSidecars } from './sidecars';
import { collectPlatformAssurance, collectAndroidKeyAssurance, type PlatformCollectionState, type KeyAttestationCollectionState } from "./platform-assurance";
import { canonicalize } from '../../../packages/evidence-contracts/contracts.mjs';
import { nativeResearch } from './native';
import type { NativeInventory } from './native';
import { assertResearchApiEndpoint, researchEnabled, researchProductionEnabled } from './isolation';
import { newIdempotencyKey, type PackProofV2Client } from '../v2-api';
import type { LocalCapture } from '../capture';

export interface ResearchCaptureState {
  intentId: string; nonce: string; keyScope: string; publicKeySpki: string;
  mode: 'ONLINE'; state: 'BOUND' | 'SIGNED' | 'RECEIVED' | 'UNAVAILABLE';
  platform?: PlatformCollectionState;
  keyAttestation?: KeyAttestationCollectionState;
  sidecars?: {state: 'PENDING' | 'RECEIVED';receipts:Record<string,unknown>};
  signed?: { canonicalJson: string; signature: string };
  receipt?: unknown; unavailableReason?: string; passiveChallengeId?: string;
}
export function publicKeyPem(spki: string): string {
  if (!/^[A-Za-z0-9+/]+=*$/.test(spki)) throw new Error('Unsupported native signing key');
  return `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
}
export interface PreparedResearchSession {
  production: boolean; samplingEnabled: boolean; keyScope: string; key: Awaited<ReturnType<NonNullable<ReturnType<typeof nativeResearch>>['prepareResearchKey']>>;
  issued: { intent: { id: string; nonce: string; subject: unknown }; canonicalJson: string; digest: string; signature: unknown };
}
/** Issue the research intent before the core capture session so the server can reject reused sessions. */
export async function prepareResearchSession(client: PackProofV2Client, input: { proofId: string; userId: string; stageId?: string }): Promise<PreparedResearchSession | undefined> {
  const native = nativeResearch();
  if (!native || !researchEnabled()) return undefined;
  assertResearchApiEndpoint(client.apiBaseUrl);
  client.assertCaptureAccount(input.userId, client.apiBaseUrl);
  const keyScope = `${client.apiBaseUrl}|${input.userId}`;
  try {
    const production = researchProductionEnabled();
    if (production && !await productionReceiptEnrollment(client, input.proofId)) return undefined;
    const policy = await client.researchCapabilities();
    client.assertCaptureAccount(input.userId, client.apiBaseUrl);
    if (!policy.enabled || policy.killSwitch || !policy.features.verifiedcapture?.collection) return undefined;
    const key = await native.prepareResearchKey(keyScope);
    client.assertCaptureAccount(input.userId, client.apiBaseUrl);
    const issued = await client.researchRequest<PreparedResearchSession['issued']>(input.proofId, '/capture-intents', 'POST', {
      legId: input.stageId ?? 'OUTBOUND', acquisitionMode: 'ONLINE', profileId: 'native-final-file-v1',
    }, newIdempotencyKey());
    client.assertCaptureAccount(input.userId, client.apiBaseUrl);
    return { production, keyScope, key, issued, samplingEnabled: !production && policy.features.proofpilot?.collection === true };
  } catch { return undefined; }
}
/** Failed/disabled optional binding never starts another camera or changes the core authorization. */
export async function bindResearchSession(client: PackProofV2Client, input: { proofId: string; captureSessionId: string; userId: string }, prepared?: PreparedResearchSession): Promise<ResearchCaptureState | undefined> {
  const native = nativeResearch();
  if (!native || !prepared) return undefined;
  const { keyScope, key, issued } = prepared;
  try {
    client.assertCaptureAccount(input.userId, client.apiBaseUrl);
    await client.researchRequest(input.proofId, `/capture-intents/${encodeURIComponent(issued.intent.id)}/start`, 'POST', {
      nonce: issued.intent.nonce, captureSessionId: input.captureSessionId, clientPublicKeyPem: publicKeyPem(key.publicKeySpki),
    }, `${input.captureSessionId}:rnd-start`);
    const challengeResponse = prepared.production ? null : await client.researchRequest<{ challenge: Record<string, unknown> }>(input.proofId, '/live-challenges', 'POST', {
      intentId: issued.intent.id, mode: 'PASSIVE_LAB',
    }, `${input.captureSessionId}:rnd-passive`).catch(() => null);
    client.assertCaptureAccount(input.userId, client.apiBaseUrl);
    await native.bindResearchCapture(input.captureSessionId, input.proofId, canonicalize({
      ...(prepared.production ? { collectionMode: 'FINAL_FILE_RECEIPT', keyScope } : {}),
      schemaVersion: 'packproof.native-session.v1', captureSessionId: input.captureSessionId, proofId: input.proofId,
      userId: input.userId, intentId: issued.intent.id, intent: issued.intent, signedIntent: issued,
      passiveChallenge: challengeResponse?.challenge ?? null, samplingEnabled: prepared.samplingEnabled,
      keyProtection: key.keyProtection, appAttestation: 'NOT_CHECKED', acquisitionMode: 'ONLINE',
    }));
    return { intentId: issued.intent.id, nonce: issued.intent.nonce, keyScope, publicKeySpki: key.publicKeySpki, mode: 'ONLINE', state: 'BOUND', ...(typeof challengeResponse?.challenge.challengeId === 'string' ? { passiveChallengeId: challengeResponse.challenge.challengeId } : {}) };
  } catch { return undefined; }
}
export async function signResearchSession(capture: LocalCapture): Promise<void> {
  const research = capture.research, native = nativeResearch();
  if (!research || research.signed || !native || !capture.captureSessionId || !capture.captureProofId) return;
  try {
    const record: NativeInventory = JSON.parse(await native.readResearchCapture(capture.captureSessionId));
    if (record.captureSessionId !== capture.captureSessionId || record.binding.proofId !== capture.captureProofId) throw new Error('Research binding mismatch');
    const canonicalJson = canonicalize({ schemaVersion: 'packproof.native-final-file.v1', intentId: research.intentId,
      captureSessionId: capture.captureSessionId, proofId: capture.captureProofId,
      mediaSha256: record.mediaSha256, mediaByteLength: record.mediaByteLength,
      journalSha256: record.journalSha256, acquisitionSha256: record.acquisitionSha256,
      chainCoverage: 'FINAL_FILE_ONLY' });
    const signed = await native.signResearchCapture(capture.captureSessionId, research.keyScope, canonicalJson);
    if (signed.publicKeySpki !== research.publicKeySpki) throw new Error('Research signing key changed');
    research.signed = { canonicalJson, signature: signed.signature }; research.state = 'SIGNED'; delete research.unavailableReason;
  } catch { research.state = 'UNAVAILABLE'; research.unavailableReason = 'Native final-file signature is unavailable; original remains usable.'; }
}
const closing = new Map<string, Promise<void>>();
export function closeResearchSession(client: PackProofV2Client, capture: LocalCapture, evidenceId: string, persist: () => Promise<void> = async () => {}): Promise<void> {
  const key = `${client.apiBaseUrl}|${capture.captureUserId}|${capture.captureSessionId}`;
  const current = closing.get(key); if (current) return current;
  const task = closeResearchSessionInner(client, capture, evidenceId, persist).finally(() => { closing.delete(key); });
  closing.set(key, task); return task;
}
async function closeResearchSessionInner(client: PackProofV2Client, capture: LocalCapture, evidenceId: string, persist: () => Promise<void>): Promise<void> {
  const research = capture.research;
  if (!researchEnabled() || !research || research.state === 'RECEIVED' || !capture.captureProofId || !capture.captureUserId) return;
  try {
    client.assertCaptureAccount(capture.captureUserId, client.apiBaseUrl);
    await signResearchSession(capture);
    if (!research.signed) { await persist(); return; }
    if (!research.receipt) {
      if (!researchProductionEnabled()) {
        await collectPlatformAssurance(client, capture.captureProofId, capture.captureSessionId!, research, persist);
        await collectAndroidKeyAssurance(client, capture.captureProofId, capture.captureSessionId!, research, persist);
      }
      client.assertCaptureAccount(capture.captureUserId, client.apiBaseUrl);
      const received = await client.researchRequest<ReceiptReview['captureReceipts'][number]>(capture.captureProofId, `/capture-intents/${encodeURIComponent(research.intentId)}/close`, 'POST', {
        evidenceIds: [evidenceId], clientCanonicalJson: research.signed.canonicalJson, clientSignatureBase64: research.signed.signature,
      }, `${capture.captureSessionId}:rnd-close`);
      client.assertCaptureAccount(capture.captureUserId, client.apiBaseUrl);
      if (researchProductionEnabled()) assertClosedReceipt(received, { proofId: capture.captureProofId, intentId: research.intentId,
        captureSessionId: capture.captureSessionId!, evidenceId, clientCanonicalJson: research.signed.canonicalJson });
      research.receipt = received;
      await persist();
    }
    if (!researchProductionEnabled()) await uploadNativeSidecars(client, capture, persist);
    research.state = 'RECEIVED'; delete research.unavailableReason;
    await persist();
  } catch { research.unavailableReason = researchProductionEnabled() ? 'Optional capture receipt has not been received. Retry is available while consent and service policy permit it. Your original is preserved.' : 'Research receipt or optional sidecar upload pending. The original remains preserved.'; await persist().catch(() => undefined); }
}
