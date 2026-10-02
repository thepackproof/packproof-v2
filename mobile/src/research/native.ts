import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { researchEnabled } from './isolation';

export interface ResearchKey { publicKeySpki: string; algorithm: 'ES256_DER'; keyProtection: string; appAttestation: 'NOT_CHECKED'; }
export interface NativeInventory {
  captureSessionId: string; binding: { proofId: string }; mediaSha256: string; mediaByteLength: number;
  journalSha256: string | null; acquisitionSha256: string | null; acquisition: Record<string, unknown> | null;
  chainCoverage: 'FINAL_FILE_ONLY'; appAttestation: 'NOT_CHECKED';
}
interface NativeResearch {
  bindResearchCapture(session: string, proof: string, canonicalBinding: string): Promise<void>;
  readResearchCapture(session: string): Promise<string>;
  prepareResearchKey(scope: string): Promise<ResearchKey>;
  signResearchCapture(session: string, scope: string, payload: string): Promise<{ signature: string; publicKeySpki: string; algorithm: 'ES256_DER' }>;
  requestAndroidKeyAttestation?(session:string,scope:string,challengeBase64:string,payload:string): Promise<{certificateChainBase64:string[];publicKeySpki:string;inventorySignatureBase64:string;keyRole:'ATTESTATION_REQUEST_KEY';verification:'NOT_CHECKED'}>;
  preparePlayIntegrity?(project: string): Promise<{ prepared: boolean; verification: 'NOT_CHECKED' }>;
  requestPlayIntegrity?(requestHash: string): Promise<{ token: string; verification: 'NOT_CHECKED'; requestHash: string }>;
  appAttestAvailability?(): { supported: boolean; verification: 'NOT_CHECKED'; environment: 'development' };
  generateAppAttestKey?(): Promise<{ keyId: string; verification: 'NOT_CHECKED' }>;
  requestAppAttest?(keyId: string, hashBase64: string, assertion: boolean): Promise<{ keyId: string; assertion: boolean; objectBase64: string; verification: 'NOT_CHECKED' }>;
}
export function nativeResearch(): NativeResearch | null {
  if (!researchEnabled() || !['android', 'ios'].includes(Platform.OS)) return null;
  const module = requireOptionalNativeModule<Partial<NativeResearch>>('PackProofUnifiedCamera');
  return module?.bindResearchCapture && module?.readResearchCapture ? module as NativeResearch : null;
}
