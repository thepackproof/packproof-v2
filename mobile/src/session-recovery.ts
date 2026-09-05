import type { CognitoSessionTokens } from "./cognito";
import type { CachedClientState } from "./session";

/** Authentication can expire without deleting the only handle to unsubmitted evidence. */
export function sessionForReauthentication(current: CachedClientState): CachedClientState {
  return {
    ...current,
    token: "",
    refreshToken: null,
    idToken: null,
    accessExpiresAt: null,
    needsReauthentication: true,
  };
}

/** A refresh may finish after capture persistence, sign-out, or a different sign-in. */
export function mergeRefreshedSession(
  current: CachedClientState | null,
  started: CachedClientState,
  refreshed: CognitoSessionTokens,
): CachedClientState | null {
  if (!current || current.needsReauthentication || current.userId !== started.userId ||
    current.apiBaseUrl !== started.apiBaseUrl || current.token !== started.token ||
    current.refreshToken !== started.refreshToken) return null;
  return {
    ...current,
    token: refreshed.accessToken,
    idToken: refreshed.idToken,
    refreshToken: refreshed.refreshToken,
    accessExpiresAt: refreshed.expiresAt,
  };
}
