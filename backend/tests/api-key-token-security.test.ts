import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabase } from '../src/db/pglite.js';
import { migrate } from '../src/db/migrate.js';
import type { Database } from '../src/db/database.js';
import { DEVELOPER_EMAILS } from '../src/auth/developer-access.js';
import { authenticateApiKey, createTenant, issueApiKey, revokeApiKey } from '../src/platform/tenants.js';

// Observe the requested entropy size while retaining Node's real CSPRNG output.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const clock = { now: () => new Date('2026-10-11T12:00:00Z') };
const owner = 'user_api_token_security';
let db: Database, close: () => Promise<void>;

beforeAll(async () => {
  const opened = await createPgliteDatabase();
  db = opened.db; close = opened.close;
  await migrate(db);
  await db.query('INSERT INTO users(id,created_at,updated_at) VALUES($1,$2,$2)', [owner, clock.now().toISOString()]);
  await db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,$2,$3,'COGNITO')",
    [owner, DEVELOPER_EMAILS[0], clock.now().toISOString()]);
}, 30000);
afterAll(async () => close());

async function tenant(environment: 'sandbox' | 'live') {
  return await createTenant(db, clock, owner, { name: `security-${environment}`, environment }) as { id: string };
}

describe('random API-token lookup contract (not human-password storage)', () => {
  it.each(['sandbox', 'live'] as const)('issues %s tokens from 32 CSPRNG bytes and stores only a digest plus bounded prefix', async environment => {
    const workspace = await tenant(environment);
    vi.mocked(randomBytes).mockClear();
    const chosen = 'caller-cannot-choose-this-secret';
    const a = await issueApiKey(db, clock, owner, workspace.id,
      { name: 'reader', scopes: ['proofs:read'], token: chosen, password: chosen });
    const b = await issueApiKey(db, clock, owner, workspace.id, { name: 'reader', scopes: ['proofs:read'] });
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[32], [32]]);
    expect(a.token).toMatch(new RegExp(`^pp_${environment}_[A-Za-z0-9_-]{43}$`));
    expect(Buffer.from(a.token.slice(`pp_${environment}_`.length), 'base64url')).toHaveLength(32);
    expect(a.token).not.toBe(b.token);
    expect(a.token).not.toContain(chosen);
    const rows = (await db.query('SELECT * FROM api_keys WHERE id=$1', [a.id])).rows;
    expect(rows[0].token_hash).toBe(createHash('sha256').update(a.token).digest('hex'));
    expect(rows[0].prefix).toBe(a.token.slice(0, 20));
    expect(JSON.stringify(rows)).not.toContain(a.token);
    const audit = (await db.query('SELECT * FROM api_request_audit WHERE key_id=$1', [a.id])).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(a.token);
    expect(await authenticateApiKey(db, `Bearer ${a.token}`)).toMatchObject({
      keyId: a.id, tenantId: workspace.id, userId: owner, environment, scopes: ['proofs:read'],
    });
  });

  it('rejects human passwords, a stored diagnostic prefix, an unknown formatted token and changed bytes', async () => {
    const workspace = await tenant('sandbox');
    const key = await issueApiKey(db, clock, owner, workspace.id, { name: 'reader', scopes: ['proofs:read'] });
    const differentLast = key.token.at(-1) === 'A' ? 'Q' : 'A';
    const unknown = `pp_sandbox_${randomBytes(32).toString('base64url')}`;
    for (const authorization of [undefined, 'Bearer human-password', `Bearer ${key.prefix}`, `Bearer ${unknown}`,
      `Bearer ${key.token.slice(0, -1)}${differentLast}`, `Bearer ${key.token} `]) {
      await expect(authenticateApiKey(db, authorization)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', httpStatus: 401 });
    }
    expect((await authenticateApiKey(db, `Bearer ${key.token}`)).keyId).toBe(key.id);
  });

  it('immediately denies a revoked valid token without changing its stored digest', async () => {
    const workspace = await tenant('live');
    const key = await issueApiKey(db, clock, owner, workspace.id, { name: 'revoke', scopes: ['proofs:read'] });
    await revokeApiKey(db, clock, owner, workspace.id, key.id);
    await expect(authenticateApiKey(db, `Bearer ${key.token}`)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', httpStatus: 401 });
    const stored = (await db.query('SELECT token_hash,revoked_at FROM api_keys WHERE id=$1', [key.id])).rows[0];
    expect(stored.token_hash).toBe(createHash('sha256').update(key.token).digest('hex'));
    expect(stored.revoked_at).not.toBeNull();
  });
});
