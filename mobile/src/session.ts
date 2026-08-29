import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "packproof-v2.session";

export interface CachedClientState {
  apiBaseUrl: string;
  authMode: "dev" | "cognito";
  subject: string;
  email: string | null;
  userId: string;
  username: string | null;
  displayName: string | null;
  token: string;
  refreshToken: string | null;
  idToken: string | null;
  accessExpiresAt: number | null;
  cognitoUserPoolId: string | null;
  cognitoClientId: string | null;
  cognitoRegion: string | null;
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
      authMode: parsed.authMode === "cognito" ? "cognito" : "dev",
      subject: parsed.subject ?? parsed.email ?? "",
      email: parsed.email ?? null,
      userId: parsed.userId,
      username: parsed.username ?? null,
      displayName: parsed.displayName ?? null,
      token: parsed.token,
      refreshToken: parsed.refreshToken ?? null,
      idToken: parsed.idToken ?? null,
      accessExpiresAt: parsed.accessExpiresAt ?? null,
      cognitoUserPoolId: parsed.cognitoUserPoolId ?? null,
      cognitoClientId: parsed.cognitoClientId ?? null,
      cognitoRegion: parsed.cognitoRegion ?? null,
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
