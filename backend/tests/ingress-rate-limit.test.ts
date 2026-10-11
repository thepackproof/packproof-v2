import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import type { Database } from '../src/db/database.js';
import { DomainError } from '../src/domain/errors.js';
import { configureTrustedProxy, safeHttpError } from '../src/http/boundary.js';
import { ingressRateLimitOptions, ingressRatePolicies, PostgresIngressRateStore } from '../src/http/ingress-rate-limit.js';
import { createServerApp } from '../src/server-app.js';
import { BearerUserAdapter } from '../src/auth/adapter.js';
import { createIntakeSession } from '../src/intake/sessions.js';
import { FakeEbayClient } from './fixtures/ebay.js';
import { createHarness, createUser, type TestHarness } from './helpers.js';

let harness: TestHarness;
beforeAll(async () => { harness = await createHarness(); }, 30_000);
beforeEach(async () => {
  await harness.db.query('DELETE FROM http_rate_windows');
  // Keep request bursts in one window even when the test starts near a minute boundary.
  vi.spyOn(Date, 'now').mockReturnValue(Math.floor(Date.now() / 60_000) * 60_000 + 10_000);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await harness?.close(); });

function boundaryApp(db: Database, scope: string, limit = 2, trustedProxies = '') {
  const app = express();
  configureTrustedProxy(app, { PACKPROOF_TRUSTED_PROXIES: trustedProxies });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(rateLimit(ingressRateLimitOptions(db, { scope, limit, windowMs: 60_000 })));
  const protectedWork = vi.fn((req: express.Request, res: express.Response) => res.json({ ip: req.ip }));
  app.get('/work', protectedWork);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => safeHttpError(err, res));
  return { app, protectedWork };
}

function expectLimited(response: request.Response) {
  expect(response.status).toBe(429);
  expect(response.body.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60);
  expect(response.headers.ratelimit).toContain('remaining=0');
}

describe('PostgreSQL ingress rate budgets', () => {
  it('shares an atomic budget across replicas, including concurrent requests and denied attempts', async () => {
    const first = boundaryApp(harness.db, 'replicas', 5), second = boundaryApp(harness.db, 'replicas', 5);
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => request(i % 2 ? first.app : second.app).get('/work')));
    expect(responses.filter(response => response.status === 200)).toHaveLength(5);
    responses.filter(response => response.status !== 200).forEach(expectLimited);
    expect(first.protectedWork.mock.calls.length + second.protectedWork.mock.calls.length).toBe(5);
    const rows = (await harness.db.query('SELECT * FROM http_rate_windows')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].request_count).toBe(6);
    expect(rows[0].bucket_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain('127.0.0.1');
  });

  it('ignores spoofed forwarding headers and does not throttle health checks', async () => {
    const { app } = boundaryApp(harness.db, 'untrusted');
    for (const ip of ['192.0.2.1', '192.0.2.2']) expect((await request(app).get('/work').set('X-Forwarded-For', ip)).status).toBe(200);
    expectLimited(await request(app).get('/work').set('X-Forwarded-For', '192.0.2.3').set('Forwarded', 'for=192.0.2.4'));
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('uses only configured proxies, groups IPv6 rotation, and preserves separate IPv4 callers', async () => {
    const { app } = boundaryApp(harness.db, 'trusted', 1, '127.0.0.1/32,::1/128');
    expect((await request(app).get('/work').set('X-Forwarded-For', '2001:db8:abcd:1200::1')).status).toBe(200);
    expectLimited(await request(app).get('/work').set('X-Forwarded-For', '2001:db8:abcd:12ff::2'));
    expect((await request(app).get('/work').set('X-Forwarded-For', '2001:db8:abcd:1300::1')).status).toBe(200);
    expect((await request(app).get('/work').set('X-Forwarded-For', '192.0.2.1')).status).toBe(200);
    expectLimited(await request(app).get('/work').set('X-Forwarded-For', '::ffff:192.0.2.1'));
    expect((await request(app).get('/work').set('X-Forwarded-For', '192.0.2.2')).status).toBe(200);
  });

  it('resets at the fixed window and retains expiry for the existing cleanup job', async () => {
    let now = 120_100;
    const store = new PostgresIngressRateStore(harness.db, { scope: 'window', limit: 1, windowMs: 60_000 }, () => now);
    expect(await store.increment('caller')).toEqual({ totalHits: 1, resetTime: new Date(180_000) });
    expect((await store.increment('caller')).totalHits).toBe(2);
    now = 180_000;
    expect(await store.increment('caller')).toEqual({ totalHits: 1, resetTime: new Date(240_000) });
    const rows = (await harness.db.query('SELECT expires_at FROM http_rate_windows ORDER BY window_start')).rows;
    expect(rows.map(row => new Date(row.expires_at as string).getTime())).toEqual([240_000, 300_000]);
    await harness.db.query('DELETE FROM http_rate_windows WHERE expires_at<$1', [new Date(240_001).toISOString()]);
    expect((await harness.db.query('SELECT * FROM http_rate_windows')).rows).toHaveLength(1);
  });

  it('keeps scopes separate and supports safe decrement and reset without zero-count rows', async () => {
    const first = new PostgresIngressRateStore(harness.db, { scope: 'one', limit: 3, windowMs: 60_000 });
    const second = new PostgresIngressRateStore(harness.db, { scope: 'two', limit: 3, windowMs: 60_000 });
    await first.increment('same-caller'); await first.increment('same-caller'); await second.increment('same-caller');
    await first.decrement('same-caller'); await first.decrement('same-caller'); await first.decrement('same-caller');
    expect((await first.increment('same-caller')).totalHits).toBe(1);
    await first.resetKey('same-caller');
    expect((await second.increment('same-caller')).totalHits).toBe(2);
    expect((await harness.db.query('SELECT * FROM http_rate_windows')).rows).toHaveLength(1);
  });

  it('fails closed before protected work when the database is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unavailable = { ...harness.db, query: vi.fn().mockRejectedValue(new Error('private database connection detail')) } as Database;
    const { app, protectedWork } = boundaryApp(unavailable, 'unavailable');
    const response = await request(app).get('/work');
    expect(response.status).toBe(500);
    expect(protectedWork).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('private database');
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it.each([
    { scope: 'invalid scope', limit: 1, windowMs: 1_000 },
    { scope: 'valid', limit: 0, windowMs: 1_000 },
    { scope: 'valid', limit: 1.5, windowMs: 1_000 },
    { scope: 'valid', limit: 2_147_483_647, windowMs: 1_000 },
    { scope: 'valid', limit: 1, windowMs: 999 },
  ])('rejects invalid configuration %j', policy => {
    expect(() => ingressRateLimitOptions(harness.db, policy)).toThrow('Invalid ingress rate limit configuration');
  });
});

describe('production route admission', () => {
  it('stops bearer, scoped intake and multipart authentication at the shared ingress budget', async () => {
    const user = await createUser(harness);
    const intake = await createIntakeSession(harness.db, harness.clock, user);
    const authenticate = vi.spyOn(BearerUserAdapter.prototype, 'authenticate');
    const query = vi.spyOn(harness.db, 'query');
    const intakePath = '/me/intake/submissions/intake_submission_missing';
    expect((await request(harness.app).get(intakePath).set('Authorization', `Bearer ${intake.token}`)).status).toBe(404);
    for (let i = 1; i < ingressRatePolicies.firstPartyAuth.limit; i++) {
      expect((await request(harness.app).get('/me/account-deletion-request').set('Authorization', `Bearer invalid-${i}`)).status).toBe(401);
    }
    const authenticationCalls = authenticate.mock.calls.length;
    const intakeQueries = () => query.mock.calls.filter(([sql]) => sql.includes('FROM intake_scoped_sessions')).length;
    const beforeIntakeQueries = intakeQueries();
    expect(beforeIntakeQueries).toBeGreaterThan(0);
    expectLimited(await request(harness.app).get('/me/account-deletion-request').set('Authorization', `Bearer ${user}`));
    expectLimited(await request(harness.app).get(intakePath).set('Authorization', `Bearer ${intake.token}`));
    expectLimited(await request(harness.app).get(intakePath).set('Authorization', 'Bearer pp_intake_invalid'));
    expectLimited(await request(harness.app).put('/proofs/missing/evidence/missing/parts/1').set('Authorization', `Bearer ${user}`).send('media'));
    expect(authenticate).toHaveBeenCalledTimes(authenticationCalls);
    expect(intakeQueries()).toBe(beforeIntakeQueries);
    expect((await request(harness.app).get('/health')).status).toBe(200);
    expect((await request(harness.app).get('/meta')).status).toBe(200);
    // These retain their own validation/availability decisions and public budgets.
    const publicLink = await request(harness.app).get('/public/proofs/missing');
    expect(publicLink.status).toBe(404);
    expect(publicLink.body.error.code).toBe('ACCESS_LINK_INVALID');
    const providerChallenge = await request(harness.app).get('/integrations/webhooks/ebay/account-deletion').query({ challenge_code: 'fixture' });
    expect(providerChallenge.status).toBe(503);
    expect(providerChallenge.body.error.code).toBe('INTEGRATION_CREDENTIALS_UNAVAILABLE');
    expect((await request(harness.app).get('/v1/openapi.json')).status).toBe(200);
    expect(authenticate).toHaveBeenCalledTimes(authenticationCalls);
  });

  it('allows concurrent authenticated client requests below the ingress budget', async () => {
    const users = await Promise.all([createUser(harness), createUser(harness)]);
    const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => request(harness.app)
      .get('/me/account-deletion-request').set('Authorization', `Bearer ${users[i % users.length]}`)));
    expect(responses.map(response => response.status)).toEqual(Array(40).fill(200));
  });

  it('bounds subscription authentication across methods and proof ids', async () => {
    const authenticate = vi.fn().mockRejectedValue(new DomainError('UNAUTHENTICATED', 'Sign in', 401));
    const app = createServerApp({ ...harness, auth: { authenticate }, publicBaseUrl: 'http://127.0.0.1', devAuth: true, testFixtures: true });
    for (let i = 0; i < ingressRatePolicies.subscriptions.limit; i++) {
      expect((await request(app).get(`/proofs/proof-${i}/email-subscriptions`).set('X-Forwarded-For', `192.0.2.${i + 1}`)).status).toBe(401);
    }
    expectLimited(await request(app).post('/proofs/another/email-subscriptions').send({ email: 'sample@example.test' }));
    expectLimited(await request(app).delete('/proofs/another/email-subscriptions/another'));
    expect(authenticate).toHaveBeenCalledTimes(ingressRatePolicies.subscriptions.limit);
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('bounds development identity writes while preserving normal login and unrelated routes', async () => {
    const login = await request(harness.app).post('/auth/dev/login').send({ subject: 'rate-limit-normal-login' });
    expect(login.status).toBe(200);
    expect(login.body.token).toBe(login.body.userId);
    for (let i = 1; i < ingressRatePolicies.devLogin.limit; i++) {
      expect((await request(harness.app).post('/auth/dev/login').send({})).status).toBe(400);
    }
    expectLimited(await request(harness.app).post('/auth/dev/login').send({ subject: 'must-not-be-created' }));
    expect((await request(harness.app).get('/health')).status).toBe(200);
    expect((await request(harness.app).get('/v1/openapi.json')).status).toBe(200);
  });

  it('bounds public specification delivery without changing API-key authentication', async () => {
    for (let i = 0; i < ingressRatePolicies.openApi.limit; i++) {
      expect((await request(harness.app).get('/v1/openapi.json')).status).toBe(200);
    }
    expectLimited(await request(harness.app).get('/v1/openapi.json'));
    expect((await request(harness.app).get('/v1/proofs')).status).toBe(401);
  });

  it('bounds signature verification without consuming or breaking the eBay GET challenge', async () => {
    const verify = vi.fn().mockRejectedValue(new DomainError('INVALID_WEBHOOK_SIGNATURE', 'Invalid signature', 412));
    const ebay = { enabled: true, packproofEnvironment: 'test' as const, environment: 'sandbox' as const,
      clientId: 'ebay-app-id', ruName: 'test-runame', marketplaceId: 'EBAY_US', appCredentialReference: 'memory:rate-ebay',
      deletionVerificationToken: 'test-deletion-token', deletionEndpoint: 'https://api.example.test/integrations/webhooks/ebay/account-deletion',
      webReturnUrl: 'http://127.0.0.1/stores', client: new FakeEbayClient() };
    await harness.credentialStore.put({ adapterKey: 'ebay', credentialReference: ebay.appCredentialReference, material: { clientSecret: 'test-secret' } });
    const app = createServerApp({ ...harness, auth: { authenticate: vi.fn() }, publicBaseUrl: 'http://127.0.0.1', devAuth: true, testFixtures: true, ebay, ebayDeletionSignatureVerifier: verify });
    const path = '/integrations/webhooks/ebay/account-deletion';
    for (let i = 0; i < ingressRatePolicies.ebayDeletion.limit; i++) {
      expect((await request(app).post(path).send({ notification: { notificationId: `attempt-${i}` } })).status).toBe(412);
    }
    expectLimited(await request(app).post(path).send({ notification: { notificationId: 'excess' } }));
    expect(verify).toHaveBeenCalledTimes(ingressRatePolicies.ebayDeletion.limit);
    const challenge = await request(app).get(path).query({ challenge_code: 'challenge-fixture' });
    expect(challenge.status).toBe(200);
    expect(challenge.body.challengeResponse).toMatch(/^[a-f0-9]{64}$/);
  });
});
