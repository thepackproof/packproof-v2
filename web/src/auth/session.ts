const STORAGE_KEY = "packproof-v2-web.session";

export type AuthMode = "dev" | "cognito";

export interface WebSession {
  apiBaseUrl: string;
  authMode: AuthMode;
  userId: string;
  username: string | null;
  displayName: string | null;
  token: string;
  refreshToken: string | null;
  accessExpiresAt: number | null;
  subject: string;
}

export function defaultApiBaseUrl(): string {
  return import.meta.env.VITE_PACKPROOF_API_BASE_URL?.trim() ?? "";
}

export function defaultAuthMode(): AuthMode {
  return import.meta.env.VITE_PACKPROOF_AUTH_MODE === "cognito" ? "cognito" : "dev";
}

export function loadSession(): WebSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<WebSession>;
    if (!parsed.userId || !parsed.token) {
      return null;
    }
    return {
      apiBaseUrl: parsed.apiBaseUrl ?? "",
      authMode: parsed.authMode === "cognito" ? "cognito" : "dev",
      userId: parsed.userId,
      username: parsed.username ?? null,
      displayName: parsed.displayName ?? null,
      token: parsed.token,
      refreshToken: parsed.refreshToken ?? null,
      accessExpiresAt: parsed.accessExpiresAt ?? null,
      subject: parsed.subject ?? "",
    };
  } catch {
    return null;
  }
}

export function saveSession(session: WebSession): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
