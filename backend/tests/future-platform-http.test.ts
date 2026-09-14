import { createDeveloper } from "./developer-fixtures.js";
import { generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { auth, createHarness, createUser, commitFulfillmentAndAttest, type TestHarness } from './helpers.js';
import { createServerApp } from '../src/server-app.js';
import { BearerUserAdapter } from '../src/auth/adapter.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { createTenant, issueApiKey } from '../src/platform/tenants.js';
import { futurePlatformFromEnv, type FuturePlatformConfig } from '../src/platform/future-config.js';
import type { ManifestSigner } from '../src/domain/manifest-signing.js';

let h: TestHarness, app: ReturnType<typeof createServerApp>, seller: string, proofId: string;
let tenantId: string, key: string, reader: string, otherTenantKey: string;
const cfg: FuturePlatformConfig = { enabled: false, writesEnabled: false, tenantIds: [], userIds: [] };
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const signer: ManifestSigner = { signManifest: async input => ({ algorithm: 'ECDSA_SHA_256', keyId: 'http-test',
  signatureBase64: sign('sha256', Buffer.from(input.canonicalJson), pair.privateKey).toString('base64'), signedAt: h.clock.now().toISOString() }) };
const path = () => `/proofs/${proofId}/lifecycle-snapshots`;

beforeAll(async () => {
  h = await createHarness(); seller = await createDeveloper(h);
  const t = await createTenant(h.db, h.clock, seller, { name: 'future-pilot', environment: 'sandbox' }) as { id: string };
  tenantId = t.id;
  key = (await issueApiKey(h.db, h.clock, seller, t.id, { name: 'writer', scopes: ['proofs:read', 'proofs:write'] })).token;
  reader = (await issueApiKey(h.db, h.clock, seller, t.id, { name: 'reader', scopes: ['proofs:read'] })).token;
  const other = await createTenant(h.db, h.clock, seller, { name: 'other-pilot', environment: 'sandbox' }) as { id: string };
  otherTenantKey = (await issueApiKey(h.db, h.clock, seller, other.id, { name: 'other', scopes: ['proofs:read', 'proofs:write'] })).token;
  cfg.tenantIds = [tenantId, other.id]; cfg.userIds = [seller];
  app = createServerApp({ ...h, auth: new BearerUserAdapter(h.db), devAuth: true, publicBaseUrl: 'http://localhost',
    futurePlatform: cfg, manifestSigning: { signer, trustList: null,
      publicStatus: { mode: 'SIGNED', algorithm: 'ECDSA_SHA_256', keyId: 'http-test', required: true, trustListSha256: null } } });
  const created = await request(app).post('/v1/proofs').set(auth(key)).set('Idempotency-Key', 'pilot-order')
    .send({ externalId: 'synthetic-pilot-order', transaction: { itemTitle: 'Synthetic test item', quantity: 1 } });
  expect(created.status, JSON.stringify(created.body)).toBe(201); proofId = created.body.proof.proofId;
  await commitFulfillmentAndAttest(h, seller, proofId);
  await finalizeProof(h.db, h.clock, seller, proofId, signer);
});
afterAll(async () => h?.close());

it('keeps extension disabled by default, requires explicit canaries, and rejects invalid config', async () => {
  expect(futurePlatformFromEnv({})).toEqual({ enabled: false, writesEnabled: false, userIds: [], tenantIds: [] });
  expect(() => futurePlatformFromEnv({ PACKPROOF_FUTURE_PLATFORM_USERS: '*' })).toThrow();
  expect((await request(app).post(path()).set(auth(seller)).set('Idempotency-Key', 'disabled-snapshot').send({})).status).toBe(404);
  expect((await request(app).get(`/proofs/${proofId}`).set(auth(seller))).status).toBe(200);
  cfg.enabled = true; cfg.writesEnabled = true;
  const stranger = await createUser(h);
  expect((await request(app).post(path()).set(auth(stranger)).set('Idempotency-Key', 'stranger-snapshot').send({})).status).toBe(404);
});

it('scopes retries, binds the actual tenant, and retains reads while writers are paused', async () => {
  const create = (token: string, purpose = 'REVIEW') => request(app).post(`/v1${path()}`).set(auth(token))
    .set('Idempotency-Key', 'http-snapshot-one').send({ purpose });
  expect((await create(reader)).status).toBe(403);
  expect((await create(otherTenantKey)).status).toBe(404);
  const first = await create(key); expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(JSON.parse(first.body.canonicalJson).tenantId).toBe(tenantId);
  const replay = await create(key); expect(replay.body).toEqual(first.body);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect((await create(key, 'ARCHIVE')).status).toBe(409);
  cfg.writesEnabled = false;
  expect((await create(key)).status).toBe(503);
  const url = `/v1${path()}/${first.body.snapshotId}`;
  expect((await request(app).get(url).set(auth(reader))).body).toEqual(first.body);
  expect((await request(app).get(url).set(auth(otherTenantKey))).status).toBe(404);
  const download = await request(app).get(`${url}/download`).set(auth(reader));
  expect(download.status, JSON.stringify(download.body)).toBe(200);
  expect(download.headers['content-type']).toMatch(/application\/zip/);
  expect(download.headers['cache-control']).toBe('no-store');
  cfg.writesEnabled = true;
});

it('does not accept client completion claims or expose unknown sessions', async () => {
  const r = await request(app).post('/capture-sessions/unknown/completion-receipt').set(auth(seller)).send({ state: 'FINALIZED' });
  expect(r.status).toBe(400);
  expect((await request(app).get('/capture-sessions/unknown/completion-receipt').set(auth(seller))).status).toBe(404);
});

it('rechecks participant access before returning a cached signed result', async () => {
  const create = () => request(app).post(`/v1${path()}`).set(auth(key))
    .set('Idempotency-Key', 'revoked-snapshot').send({ purpose: 'REVIEW' });
  expect((await create()).status).toBe(201);
  await h.db.query("UPDATE users SET status='DISABLED' WHERE id=$1", [seller]);
  const retry = await create();
  expect(retry.status).toBe(401);
  expect(retry.body).not.toHaveProperty('canonicalJson');
});
