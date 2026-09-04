import { ApiError } from "../api/types";
import type { CognitoSessionTokens } from "./cognito";
import type { WebSession } from "./session";

/** Coalesce refreshes and never restore a session after sign-out or account change. */
export function createSessionTokenProvider(options: {
  getSession: () => WebSession | null;
  onSession: (session: WebSession) => void;
  refresh: (refreshToken: string) => Promise<CognitoSessionTokens>;
}) {
  let pending: { token: string; promise: Promise<string | null> } | null = null;
  return async (): Promise<string | null> => {
    const session = options.getSession();
    if (!session) return null;
    if (session.authMode !== "cognito" || !session.refreshToken ||
        (session.accessExpiresAt == null || session.accessExpiresAt > Date.now() + 60_000)) {
      return session.token;
    }
    if (pending?.token === session.token) return pending.promise;
    const promise = (async () => {
      let tokens: CognitoSessionTokens;
      try {
        tokens = await options.refresh(session.refreshToken!);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === "NotAuthorizedException" || code === "UNAUTHENTICATED" || code === "UserNotFoundException") {
          throw new ApiError("UNAUTHENTICATED", "Session expired. Sign in again.", 401);
        }
        throw error;
      }
      const current = options.getSession();
      if (!current || current.userId !== session.userId || current.token !== session.token) {
        throw new ApiError("SESSION_CHANGED", "Your session changed. Please try again.", 409);
      }
      options.onSession({ ...current, token: tokens.accessToken, refreshToken: tokens.refreshToken,
        accessExpiresAt: tokens.expiresAt });
      return tokens.accessToken;
    })();
    pending = { token: session.token, promise };
    try { return await promise; }
    finally { if (pending?.promise === promise) pending = null; }
  };
}
