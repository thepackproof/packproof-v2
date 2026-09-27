import type { DesktopConfig } from './config.js';
import type { ProfileView } from '../../../web/src/api/types.js';

/** Implement using Electron safeStorage and an atomic 0600 file. No plaintext fallback. */
export interface ProtectedSessionStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}
export interface AuthSession {
  userId: string;
  email: string;
  username: string | null;
  displayName: string | null;
  status: string;
  profile: ProfileView;
}
interface StoredSession {
  version: 1; scope: string; session: AuthSession;
  accessToken: string; refreshToken: string | null; expiresAt: number;
}
interface AuthResult { AuthenticationResult?: { AccessToken?: string; RefreshToken?: string; ExpiresIn?: number }; ChallengeName?: string }
export class AuthError extends Error {
  readonly status = 401;
  constructor(public readonly code: string, message: string) { super(message); this.name = 'AuthError'; }
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Tokens never cross IPC. Generation checks fence asynchronous refresh/login after logout. */
export class AuthService {
  private current: StoredSession | null = null;
  private generation = 0;
  private pendingRefresh: Promise<string> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: { config: DesktopConfig; store: ProtectedSessionStore; fetch?: typeof fetch; onSession?: (session: AuthSession | null) => void }) {
    this.fetcher = options.fetch ?? fetch;
  }
  private get scope() { const c = this.options.config; return `${c.channel}|${c.apiBaseUrl}|${c.cognito.clientId}`; }
  getSession(): AuthSession | null { return this.current ? { ...this.current.session } : null; }
  getAccountId(): string | null { return this.current?.session.userId ?? null; }
  private fence(generation: number) { if (this.generation !== generation) throw new AuthError('SESSION_CHANGED', 'Your account changed. Sign in again.'); }
  private persist(value: StoredSession | null, generation: number) {
    const operation = this.writes.catch(() => {}).then(async () => {
      this.fence(generation);
      if (value) await this.options.store.write(JSON.stringify(value)); else await this.options.store.clear();
    });
    this.writes = operation; return operation;
  }
  async restore(): Promise<AuthSession | null> {
    const generation = this.generation;
    const raw = await this.options.store.read(); this.fence(generation);
    if (!raw) return null;
    try {
      const row = JSON.parse(raw) as StoredSession;
      if (row.version !== 1 || row.scope !== this.scope || !text(row.session?.userId) || row.session.profile?.userId !== row.session.userId || !text(row.accessToken) || !Number.isFinite(row.expiresAt)) throw new Error('Invalid session');
      this.current = row;
      // Offline restore retains the protected account binding; requests still refresh before use.
      this.options.onSession?.(this.getSession());
      return this.getSession();
    } catch { this.current = null; await this.persist(null, generation); return null; }
  }
  private async cognito<T>(action: string, body: Record<string, unknown>): Promise<T> {
    if (!this.options.config.cognito.clientId) throw new AuthError('AUTH_NOT_CONFIGURED', 'This development build does not have a PackProof sign-in configuration.');
    const response = await this.fetcher(`https://cognito-idp.${this.options.config.cognito.region}.amazonaws.com/`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}` }, body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const code = String(result.__type ?? 'AUTH_FAILED').split('#').pop()!;
      throw new AuthError(code, authMessage(code));
    }
    return result as T;
  }
  async signIn(input: { email: string; password: string }): Promise<AuthSession> {
    const generation = ++this.generation;
    this.current = null; this.pendingRefresh = null;
    await this.persist(null, generation);
    this.options.onSession?.(null);
    const email = normalizeEmail(input.email);
    const result = await this.cognito<AuthResult>('InitiateAuth', { ClientId: this.options.config.cognito.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: input.password } });
    this.fence(generation);
    if (result.ChallengeName || !result.AuthenticationResult?.AccessToken) throw new AuthError('CHALLENGE_REQUIRED', 'This account requires an additional sign-in step. Complete sign-in through PackProof support.');
    const tokens = result.AuthenticationResult;
    const response = await this.fetcher(`${this.options.config.apiBaseUrl}/me`, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${tokens.AccessToken}`, Accept: 'application/json' } });
    this.fence(generation);
    if (!response.ok) throw new AuthError('PROFILE_UNAVAILABLE', 'PackProof could not confirm your account. Try signing in again.');
    const profile = await response.json() as ProfileView;
    this.fence(generation);
    if (!text(profile.userId)) throw new AuthError('PROFILE_UNAVAILABLE', 'PackProof did not return a valid account.');
    const session: AuthSession = { userId: profile.userId, email, username: profile.username ?? null, displayName: profile.displayName ?? null, status: profile.status ?? 'ACTIVE', profile };
    const row: StoredSession = { version: 1, scope: this.scope, session, accessToken: tokens.AccessToken!, refreshToken: tokens.RefreshToken ?? null, expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000 };
    await this.persist(row, generation); this.fence(generation);
    this.current = row; this.options.onSession?.(session); return { ...session };
  }
  async getAccessToken(forceRefresh = false): Promise<string> {
    const row = this.current;
    if (!row) throw new AuthError('UNAUTHENTICATED', 'Sign in to PackProof.');
    if (!forceRefresh && row.expiresAt > Date.now() + 60_000) return row.accessToken;
    if (!row.refreshToken) throw new AuthError('UNAUTHENTICATED', 'Your session expired. Sign in again.');
    if (this.pendingRefresh) return this.pendingRefresh;
    const generation = this.generation;
    const task = (async () => {
      let result: AuthResult;
      try { result = await this.cognito<AuthResult>('InitiateAuth', { ClientId: this.options.config.cognito.clientId, AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: row.refreshToken } }); }
      catch (error) {
        this.fence(generation);
        if (error instanceof AuthError && ['NotAuthorizedException', 'UserNotFoundException'].includes(error.code)) await this.signOut();
        throw error;
      }
      this.fence(generation);
      if (!result.AuthenticationResult?.AccessToken) throw new AuthError('UNAUTHENTICATED', 'Your session expired. Sign in again.');
      const tokens = result.AuthenticationResult;
      const next: StoredSession = { ...row, accessToken: tokens.AccessToken!, refreshToken: tokens.RefreshToken ?? row.refreshToken, expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000 };
      await this.persist(next, generation); this.fence(generation); this.current = next; return next.accessToken;
    })();
    this.pendingRefresh = task;
    try { return await task; } finally { if (this.pendingRefresh === task) this.pendingRefresh = null; }
  }
  async signOut(): Promise<void> {
    const generation = ++this.generation; this.current = null; this.pendingRefresh = null; this.options.onSession?.(null);
    await this.persist(null, generation);
  }
  async signUp(input: { email: string; password: string }): Promise<{ email: string; userConfirmed: boolean }> {
    const email = normalizeEmail(input.email);
    const result = await this.cognito<{ UserConfirmed?: boolean }>('SignUp', { ClientId: this.options.config.cognito.clientId, Username: email, Password: input.password, UserAttributes: [{ Name: 'email', Value: email }] });
    return { email, userConfirmed: result.UserConfirmed === true };
  }
  async confirmSignUp(input: { email: string; code: string }): Promise<void> { await this.cognito('ConfirmSignUp', { ClientId: this.options.config.cognito.clientId, Username: normalizeEmail(input.email), ConfirmationCode: input.code.trim() }); }
  async resendConfirmation(email: string): Promise<void> { await this.cognito('ResendConfirmationCode', { ClientId: this.options.config.cognito.clientId, Username: normalizeEmail(email) }); }
  async forgotPassword(email: string): Promise<void> { await this.cognito('ForgotPassword', { ClientId: this.options.config.cognito.clientId, Username: normalizeEmail(email) }); }
  async confirmForgotPassword(input: { email: string; code: string; password: string }): Promise<void> { await this.cognito('ConfirmForgotPassword', { ClientId: this.options.config.cognito.clientId, Username: normalizeEmail(input.email), ConfirmationCode: input.code.trim(), Password: input.password }); }
}

function authMessage(code: string): string {
  return ({ NotAuthorizedException: 'Incorrect credentials or expired session. Sign in again.', UserNotConfirmedException: 'Verify your email using the code we sent before signing in.', UsernameExistsException: 'An account already exists with that email.', InvalidPasswordException: 'Use at least 8 characters including uppercase, lowercase and a number.', CodeMismatchException: 'That verification code is incorrect.', ExpiredCodeException: 'That code expired. Request a new code.', TooManyRequestsException: 'Too many requests. Wait a moment and try again.', UserNotFoundException: 'No PackProof account matches that email.' } as Record<string, string>)[code] ?? 'PackProof could not complete this account request. Try again.';
}
