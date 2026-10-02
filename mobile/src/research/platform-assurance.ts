import { sha256 } from '@noble/hashes/sha256';
import { toByteArray } from 'base64-js';
import { Platform } from 'react-native';
import { nativeResearch } from './native';
import type { PackProofV2Client } from '../v2-api';
import type { ResearchCaptureState } from './capture';

export interface PlatformCollectionState { keyId?: string; registration?: unknown; close?: unknown; state: 'NOT_CHECKED' | 'UNAVAILABLE' | 'SUBMITTED'; pending?: { purpose: 'REGISTER_KEY' | 'CLOSE_INVENTORY'; challengeId: string; body: Record<string, unknown> };  }
function digest(text: string): string { return Array.from(sha256(text), value => value.toString(16).padStart(2, '0')).join(''); }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Optional platform assurance timed out')), 8000); })]); }
  finally { clearTimeout(timer); }
}
/** Real SDK objects only. Server verification is the authority; device callbacks never set VERIFIED. */
export async function collectPlatformAssurance(client: PackProofV2Client, proofId: string, sessionId: string, research: ResearchCaptureState, persist: () => Promise<void>): Promise<void> {
  const native = nativeResearch();
  if (!native || !research.signed || process.env.EXPO_PUBLIC_PACKPROOF_RND_PLATFORM_ASSURANCE !== 'true') return;
  const platform = Platform.OS;
  const project = process.env.EXPO_PUBLIC_PACKPROOF_PLAY_PROJECT_NUMBER;
  if (platform === 'android' && (!project || !native.preparePlayIntegrity || !native.requestPlayIntegrity)) return;
  if (platform === 'ios' && !native.appAttestAvailability?.().supported) return;
  const state = research.platform ??= { state: 'NOT_CHECKED' };
  try {
    if (platform === 'android') await bounded(native.preparePlayIntegrity!(project!));
    for (const purpose of ['REGISTER_KEY', 'CLOSE_INVENTORY'] as const) {
      if (purpose === 'REGISTER_KEY' && state.registration) continue;
      if (purpose === 'CLOSE_INVENTORY' && state.close) continue;
      const issued = await client.researchRequest<{ challenge: { challengeId: string }; expectedClientDataHash: string; requestHash: string }>(proofId, '/platform-challenges', 'POST', {
        intentId: research.intentId, purpose, ...(purpose === 'CLOSE_INVENTORY' ? { inventoryDigest: digest(research.signed.canonicalJson) } : {}),
      }, `${sessionId}:platform:${purpose}`);
      if (toByteArray(issued.expectedClientDataHash).length !== 32) throw new Error('Invalid server request binding');
      let body: Record<string, unknown>;
      if (state.pending?.purpose === purpose && state.pending.challengeId === issued.challenge.challengeId) body = state.pending.body;
      else if (platform === 'android') {
        const token = await bounded(native.requestPlayIntegrity!(issued.requestHash));
        body = { platform: 'android', token: token.token };
      } else {
        if (!state.keyId) { state.keyId = (await bounded(native.generateAppAttestKey!())).keyId; await persist(); }
        const result = await bounded(native.requestAppAttest!(state.keyId, issued.expectedClientDataHash, purpose === 'CLOSE_INVENTORY'));
        body = { platform: 'ios', keyId: state.keyId, [purpose === 'REGISTER_KEY' ? 'attestationObjectBase64' : 'assertionObjectBase64']: result.objectBase64 };
      }
      state.pending = { purpose, challengeId: issued.challenge.challengeId, body };
      await persist();
      const result = await client.researchRequest(proofId, `/platform-challenges/${encodeURIComponent(issued.challenge.challengeId)}/verify`, 'POST', body, `${sessionId}:platform:${purpose}:verify`);
      if (purpose === 'REGISTER_KEY') state.registration = result; else state.close = result;
      delete state.pending; await persist();
    }
    state.state = 'SUBMITTED';
  } catch { state.state = 'UNAVAILABLE'; }
}

export interface KeyAttestationCollectionState {state:'NOT_CHECKED'|'UNAVAILABLE'|'SUBMITTED';result?:unknown;pending?:{challengeId:string;body:Record<string,unknown>}}
/** Dedicated attested request key binds the inventory; it cannot attest the earlier recording key. */
export async function collectAndroidKeyAssurance(client:PackProofV2Client,proofId:string,sessionId:string,research:ResearchCaptureState,persist:()=>Promise<void>) {
 const native=nativeResearch();
 if(Platform.OS!=='android'||process.env.EXPO_PUBLIC_PACKPROOF_RND_KEY_ATTESTATION!=='true'||!native?.requestAndroidKeyAttestation||!research.signed)return;
 const state=research.keyAttestation??={state:'NOT_CHECKED'};if(state.result)return;
 try {
  const issued=await client.researchRequest<{challenge:{challengeId:string};expectedClientDataHash:string}>(proofId,'/platform-challenges','POST',{intentId:research.intentId,purpose:'CLOSE_INVENTORY',inventoryDigest:digest(research.signed.canonicalJson)},`${sessionId}:key-attestation:challenge`);
  if(toByteArray(issued.expectedClientDataHash).length!==32)throw new Error('Invalid server attestation challenge');
  let body:Record<string,unknown>;
  if(state.pending?.challengeId===issued.challenge.challengeId)body=state.pending.body;
  else {
   const sdk=await bounded(native.requestAndroidKeyAttestation(sessionId,research.keyScope,issued.expectedClientDataHash,research.signed.canonicalJson));
   if(!/^[A-Za-z0-9+/]+=*$/.test(sdk.publicKeySpki))throw new Error('Invalid attested public key');
   const publicKeyPem=`-----BEGIN PUBLIC KEY-----\n${sdk.publicKeySpki.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
   body={platform:'android',certificateChainBase64:sdk.certificateChainBase64,publicKeyPem,clientCanonicalJson:research.signed.canonicalJson,inventorySignatureBase64:sdk.inventorySignatureBase64};
  }
  state.pending={challengeId:issued.challenge.challengeId,body};await persist();
  state.result=await client.researchRequest(proofId,`/platform-challenges/${issued.challenge.challengeId}/verify`,'POST',body,`${sessionId}:key-attestation:verify`);
  state.state='SUBMITTED';delete state.pending;await persist();
 } catch {state.state='UNAVAILABLE';}
}
