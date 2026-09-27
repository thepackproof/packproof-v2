import { describe, it, expect, vi } from 'vitest';
import { AuthService, type ProtectedSessionStore } from '../src/main/auth.js';
import { DesktopApi } from '../src/main/api.js';
import { DesktopEvidenceTransport } from '../src/main/evidence-api.js';
import { loadConfig, validateConfig, type DesktopConfig } from '../src/main/config.js';

const config: DesktopConfig = { channel: 'staging', apiBaseUrl: 'https://api.example.test', webBaseUrl: 'https://thepackproof.com', cognito: { clientId: 'publicClient1', userPoolId: 'us-east-1_pool', region: 'us-east-1' } };
const profile = { userId: 'user_internal_id', username: 'collin', displayName: 'Collin', status: 'ACTIVE', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokenResult = (expiresIn = 3600) => ({ AuthenticationResult: { AccessToken: 'secret-access-token', RefreshToken: 'secret-refresh-token', IdToken: 'unused-identity-token', ExpiresIn: expiresIn } });
function store() {
  let value: string | null = null;
  const adapter: ProtectedSessionStore = { read: async () => value, write: async input => { value = input; }, clear: async () => { value = null; } };
  return { adapter, value: () => value };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe('native authentication isolation', () => {
  it('binds login to backend user ID and never returns credentials to the renderer', async () => {
    const protectedStore = store();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(tokenResult())).mockResolvedValueOnce(json(profile));
    const auth = new AuthService({ config, store: protectedStore.adapter, fetch: fetcher });
    const session = await auth.signIn({ email: ' Person@Example.com ', password: 'Password1' });
    expect(session.userId).toBe('user_internal_id');
    expect(session.profile).toEqual(profile);
    expect(session.email).toBe('person@example.com');
    expect(JSON.stringify(session)).not.toMatch(/token|secret/);
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer secret-access-token' });
    expect(protectedStore.value()).toContain('secret-refresh-token');
    await auth.signOut();
    expect(protectedStore.value()).toBeNull();
    expect(auth.getSession()).toBeNull();
  });
  it('coalesces refresh and prevents a refresh from reviving a signed-out account', async () => {
    const protectedStore = store(); const refresh = deferred<Response>(); const began = deferred<void>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(tokenResult(0))).mockResolvedValueOnce(json(profile)).mockImplementationOnce(async () => { began.resolve(); return refresh.promise; });
    const auth = new AuthService({ config, store: protectedStore.adapter, fetch: fetcher });
    await auth.signIn({ email: 'a@example.test', password: 'Password1' });
    const first = auth.getAccessToken(); const second = auth.getAccessToken();
    const outcomes = Promise.allSettled([first, second]);
    await began.promise; await auth.signOut(); refresh.resolve(json(tokenResult()));
    expect((await outcomes).every(result => result.status === 'rejected')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(auth.getSession()).toBeNull(); expect(protectedStore.value()).toBeNull();
  });
  it('does not restore protected sessions from a different API/channel', async () => {
    const protectedStore = store();
    const first = new AuthService({ config, store: protectedStore.adapter, fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(json(tokenResult())).mockResolvedValueOnce(json(profile)) });
    await first.signIn({ email: 'a@example.test', password: 'Password1' });
    const other = new AuthService({ config: { ...config, channel: 'production' }, store: protectedStore.adapter });
    expect(await other.restore()).toBeNull(); expect(protectedStore.value()).toBeNull();
  });
  it('normalizes signup and sends supported Cognito verification/reset operations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({}));
    const auth = new AuthService({ config, store: store().adapter, fetch: fetcher });
    await auth.signUp({ email: ' A@Example.test ', password: 'Password1' });
    await auth.confirmSignUp({ email: 'A@example.test', code: ' 123456 ' });
    await auth.forgotPassword('A@example.test');
    await auth.confirmForgotPassword({ email: 'A@example.test', code: '123456', password: 'NewPassword1' });
    expect(fetcher.mock.calls.map(call => (call[1]?.headers as Record<string, string>)['X-Amz-Target'].split('.').pop())).toEqual(['SignUp', 'ConfirmSignUp', 'ForgotPassword', 'ConfirmForgotPassword']);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({ Username: 'a@example.test', ConfirmationCode: '123456' });
  });
});

describe('desktop API contract', () => {
  it('fences a request while token refresh switches accounts', async () => {
    let account = 'account-a'; const token = deferred<string>(); const fetcher = vi.fn<typeof fetch>();
    const api = new DesktopApi({ config, getAccountId: () => account, getToken: () => token.promise, fetch: fetcher });
    const promise = api.getProof('proof-one');
    account = 'account-b'; token.resolve('token-for-b');
    await expect(promise).rejects.toMatchObject({ code: 'SESSION_CHANGED' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it('escapes IDs and retains stable upload idempotency and bounded native bytes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ evidenceId: 'e1' }));
    const api = new DesktopApi({ config, getAccountId: () => 'a', getToken: async () => 'token', fetch: fetcher });
    await api.initializeEvidenceUpload('p/one', { contentType: 'video/webm', captureSessionId: 'cap1', byteSize: 7, idempotencyKey: 'durable-job-id' });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.example.test/proofs/p%2Fone/evidence/uploads');
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ 'Idempotency-Key': 'durable-job-id', 'X-PackProof-Intake-Version': '1' });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ contentType: 'video/webm', captureSessionId: 'cap1', byteSize: 7, evidenceType: 'FULFILLMENT_CAPTURE' });
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('coerces PostgreSQL part byte sizes and detects broken pagination', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ partSize: 5, maxParts: 50, parts: [{ partNumber: 1, byteSize: '5', sha256: 'a' }] })).mockResolvedValueOnce(json({ proofs: [], nextOffset: 0 }));
    const api = new DesktopApi({ config, getAccountId: () => 'a', getToken: async () => 'token', fetch: fetcher });
    expect((await api.listUploadParts('p', 'e')).parts[0].byteSize).toBe(5);
    await expect(api.listProofs()).rejects.toMatchObject({ code: 'INVALID_PAGINATION' });
  });
  it('never treats a pending or digest-mismatched server receipt as remotely committed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ proof: { evidence: [{ evidenceId: 'e', validationStatus: 'PENDING', sha256: 'a', byteSize: 8, committedAt: null }] } })).mockResolvedValueOnce(json({ proof: { evidence: [{ evidenceId: 'e', validationStatus: 'COMMITTED', sha256: 'wrong', byteSize: 8, committedAt: '2026-01-01' }] } }));
    const api = new DesktopApi({ config, getAccountId: () => 'a', getToken: async () => 'token', fetch: fetcher });
    const adapter = new DesktopEvidenceTransport(api); const input = { accountId: 'a', jobId: 'j', proofId: 'p', evidenceId: 'e', byteSize: 8, sha256: 'a' };
    await expect(adapter.commitUpload(input, new AbortController().signal)).rejects.toMatchObject({ code: 'COMMIT_UNCONFIRMED' });
    await expect(adapter.commitUpload(input, new AbortController().signal)).rejects.toMatchObject({ code: 'EVIDENCE_DIGEST_MISMATCH' });
  });
  it('allows local offline capture without claiming server authorization', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = new DesktopEvidenceTransport(new DesktopApi({ config, getAccountId: () => 'a', getToken: async () => 'token', fetch: fetcher }));
    const authorization = await adapter.authorizeCapture({ accountId: 'a', jobId: 'j', proofId: 'p' }, new AbortController().signal);
    expect(authorization.id).toBeUndefined(); expect(authorization.maxRecordingBytes).toBe(250_000_000); expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires HTTPS outside local development and does not silently select production', () => {
    expect(() => validateConfig({ ...config, apiBaseUrl: 'http://api.example.test' })).toThrow(/HTTPS/);
    expect(() => validateConfig({ ...config, apiBaseUrl: 'https://user:password@api.example.test' })).toThrow();
    expect(loadConfig({}).apiBaseUrl).toBe('http://127.0.0.1:3000');
    expect(() => loadConfig({ APP_ENV: 'production' })).toThrow();
  });
});
