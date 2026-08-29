import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "packproof-v2.session";

export interface CachedClientState {
  apiBaseUrl: string;
  subject: string;
  userId: string;
  token: string;
  proofId: string | null;
  transactionId: string | null;
  invitationToken: string | null;
  captureUri: string | null;
  evidenceIdempotencyKey: string | null;
  evidenceContentType: string | null;
  captureByteSize: number | null;
  captureDurationMs: number | null;
}

export async function loadCachedState(): Promise<CachedClientState | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CachedClientState>;
    if (!parsed.apiBaseUrl || !parsed.userId || !parsed.token) {
      return null;
    }
    return {
      apiBaseUrl: parsed.apiBaseUrl,
      subject: parsed.subject ?? "",
      userId: parsed.userId,
      token: parsed.token,
      proofId: parsed.proofId ?? null,
      transactionId: parsed.transactionId ?? null,
      invitationToken: parsed.invitationToken ?? null,
      captureUri: parsed.captureUri ?? null,
      evidenceIdempotencyKey: parsed.evidenceIdempotencyKey ?? null,
      evidenceContentType: parsed.evidenceContentType ?? null,
      captureByteSize: parsed.captureByteSize ?? null,
      captureDurationMs: parsed.captureDurationMs ?? null,
    };
  } catch {
    return null;
  }
}

export async function saveCachedState(state: CachedClientState): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export async function clearCachedState(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
