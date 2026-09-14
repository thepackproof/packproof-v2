import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PackProofV2Client } from '../src/v2-api';
import { DeveloperAccessScope, DeveloperActionLock, StaleDeveloperRequest, developerKeyPath, leastDeveloperScopes, readDeveloperKeys, readDeveloperTenant, readDeveloperWorkspaces, readIssuedToken } from '../src/developer/access';

test('developer commands preserve authenticated workspace/key routes and deliberate scope selection', async () => {
  const requests: Array<{ path: string; method: string; body: unknown; authorization: string | undefined }> = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    requests.push({ path: req.url!, method: req.method!, body: body ? JSON.parse(body) : null, authorization: req.headers.authorization });
    res.writeHead(req.method === 'DELETE' ? 204 : 200, { 'Content-Type': 'application/json' }); res.end(req.method === 'DELETE' ? undefined : '{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new PackProofV2Client({ baseUrl: `http://127.0.0.1:${address.port}`, getToken: () => 'fixture-session' });
  try {
    await client.developerRequest('');
    await client.developerRequest('', 'POST', { name: 'New sandbox', environment: 'sandbox' });
    const keys = developerKeyPath('tenant_fixture');
    await client.developerRequest(keys);
    await client.developerRequest(keys, 'POST', { name: 'Integration key', scopes: ['proofs:read'] });
    await client.developerRequest(developerKeyPath('tenant_fixture', 'key_fixture', true), 'POST', {});
    await client.developerRequest(developerKeyPath('tenant_fixture', 'key_fixture'), 'DELETE');
    assert.deepEqual(requests.map(({ path, method, body }) => ({ path, method, body })), [
      { path: '/me/tenants', method: 'GET', body: null },
      { path: '/me/tenants', method: 'POST', body: { name: 'New sandbox', environment: 'sandbox' } },
      { path: '/me/tenants/tenant_fixture/keys', method: 'GET', body: null },
      { path: '/me/tenants/tenant_fixture/keys', method: 'POST', body: { name: 'Integration key', scopes: ['proofs:read'] } },
      { path: '/me/tenants/tenant_fixture/keys/key_fixture/rotate', method: 'POST', body: {} },
      { path: '/me/tenants/tenant_fixture/keys/key_fixture', method: 'DELETE', body: null },
    ]);
    assert.ok(requests.every(row => row.authorization === 'Bearer fixture-session'));
    assert.equal(developerKeyPath('tenant/other', 'key?query', true), '/tenant%2Fother/keys/key%3Fquery/rotate');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

function scopeFixture() {
  let currentUser = 'owner', calls = 0, deliver: ((value: unknown) => void) | undefined;
  const client = {
    apiBaseUrl: 'https://api.test',
    assertCaptureAccount(userId: string, url: string) { if (currentUser !== userId || url !== client.apiBaseUrl) throw new Error('ACCOUNT_CHANGED'); },
    developerRequest: async <T>() => { calls += 1; return await new Promise(resolve => { deliver = resolve; }) as T; },
  };
  const guard = new DeveloperAccessScope(client, 'owner'); guard.selectTenant('tenant_a');
  return { guard, client, calls: () => calls, switchAccount: () => { currentUser = 'other'; }, deliver: (value: unknown) => deliver!(value) };
}
test('switching tenant while key creation is pending rejects the old one-time secret', async () => {
  const f = scopeFixture(), lease = f.guard.lease(true), pending = lease.request('/tenant_a/keys', 'POST', { scopes: ['proofs:read'] });
  f.guard.selectTenant('tenant_b'); f.deliver({ token: 'pp_sandbox_' + 'a'.repeat(43) });
  await assert.rejects(pending, StaleDeveloperRequest);
  assert.equal(f.guard.lease(true).tenantId, 'tenant_b');
});
test('account, server, background and leave invalidate pending developer responses before display', async () => {
  for (const invalidate of [(f: ReturnType<typeof scopeFixture>) => f.switchAccount(), (f: ReturnType<typeof scopeFixture>) => { f.client.apiBaseUrl = 'https://another.test'; }, (f: ReturnType<typeof scopeFixture>) => f.guard.setForeground(false), (f: ReturnType<typeof scopeFixture>) => f.guard.dispose()]) {
    const f = scopeFixture(), pending = f.guard.lease(true).request('/tenant_a/keys');
    invalidate(f); f.deliver({ keys: [{ id: 'key_old' }] });
    await assert.rejects(pending);
  }
});
test('a backgrounded request remains invalid after foreground resumes, and new foreground requests work', async () => {
  const f = scopeFixture(), lease = f.guard.lease(true), pending = lease.request('/tenant_a/keys', 'POST');
  f.guard.setForeground(false); assert.throws(() => f.guard.lease(true), StaleDeveloperRequest);
  f.guard.setForeground(true); f.deliver({ token: 'pp_sandbox_' + 'a'.repeat(43) });
  await assert.rejects(pending, StaleDeveloperRequest);
  const resumed = f.guard.lease(true).request('/tenant_a/keys'); f.deliver({ keys: [] });
  assert.deepEqual(await resumed, { keys: [] });
});
test('invalid account or workspace state stops developer writes before transport', async () => {
  const f = scopeFixture(); f.switchAccount();
  assert.throws(() => f.guard.lease(true), /ACCOUNT_CHANGED/); assert.equal(f.calls(), 0);
  const blank = scopeFixture(); blank.guard.selectTenant('');
  assert.throws(() => blank.guard.lease(true), StaleDeveloperRequest); assert.equal(blank.calls(), 0);
});
test('developer display keeps only key metadata, verifies token environment, and defaults to read-only permissions', () => {
  const tenant = { id: 'tenant_1', name: 'Sandbox', environment: 'sandbox' };
  assert.deepEqual(readDeveloperTenant(tenant), tenant);
  assert.deepEqual(readDeveloperWorkspaces({ tenants: [tenant], availableScopes: ['proofs:read', 'proofs:write'] }).availableScopes, ['proofs:read', 'proofs:write']);
  assert.deepEqual(leastDeveloperScopes(['proofs:read', 'proofs:write', 'webhooks:manage']), ['proofs:read']);
  assert.deepEqual(leastDeveloperScopes(['proofs:write']), []);
  const token = 'pp_sandbox_' + 'a'.repeat(43), metadata = { id: 'key_1', name: 'Integration key', prefix: token.slice(0, 20), scopes: ['proofs:read'], revokedAt: null };
  assert.deepEqual(readDeveloperKeys({ keys: [{ ...metadata, token }] }), [metadata]);
  assert.equal(readIssuedToken({ token }, 'sandbox'), token);
  assert.throws(() => readIssuedToken({ token }, 'live'));
  assert.throws(() => readDeveloperKeys({ keys: [{ ...metadata, prefix: token }] }));
  assert.throws(() => readDeveloperWorkspaces({ tenants: [tenant], availableScopes: ['*'] }));
});
test('guard replacement invalidates stale responses before effect cleanup and old finally cannot unlock the new scope', async () => {
  const f = scopeFixture(); let current = true;
  const old = new DeveloperAccessScope(f.client, 'owner', () => current); old.selectTenant('tenant_a');
  const pending = old.lease(true).request('/tenant_a/keys', 'POST');
  const lock = new DeveloperActionLock(); assert.equal(lock.enter(old), true); assert.equal(lock.enter(old), false);
  current = false;
  const replacement = new DeveloperAccessScope(f.client, 'owner'); assert.equal(lock.enter(replacement), true);
  f.deliver({ token: 'pp_sandbox_' + 'a'.repeat(43) }); await assert.rejects(pending, StaleDeveloperRequest);
  assert.equal(lock.leave(old), false); assert.equal(lock.busy(replacement), true);
  assert.equal(lock.leave(replacement), true); assert.equal(lock.busy(replacement), false);
});
test('workspace removal invalidates selected-tenant requests and requires a new selection', async () => {
  const f = scopeFixture(), pending = f.guard.lease(true).request('/tenant_a/keys');
  assert.equal(f.guard.reconcileTenants(['tenant_b']), true);
  assert.equal(f.guard.lease().tenantId, '');
  assert.throws(() => f.guard.lease(true), StaleDeveloperRequest);
  f.deliver({ keys: [] }); await assert.rejects(pending, StaleDeveloperRequest);
  assert.equal(f.guard.reconcileTenants(['tenant_b']), false);
});
