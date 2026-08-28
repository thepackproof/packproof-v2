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
}

export async function loadCachedState(): Promise<CachedClientState | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as CachedClientState;
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
