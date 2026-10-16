import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PackProofV2Client } from '../src/v2-api';

const source = ts.createSourceFile('PackProofProvider.tsx', readFileSync(new URL('../src/app/PackProofProvider.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const actions = {
  loadConnections: [], loadConnectedAccounts: [],
  setCommerceAutomation: ['connection-a', true], syncCommerceConnection: ['connection-a'],
  connectConnectedAccount: ['shopify', { shop: 'original.myshopify.com', autoSyncEnabled: false }],
  reauthorizeConnectedAccount: ['account-a'], disconnectConnectedAccount: ['account-a'],
} as const;

// Execute production closures with network/storage/UI boundaries replaced. The
// real client account assertion is retained; this is not a native UI test.
function productionClosure(name: string, ports: Record<string, unknown>, declaration = false): (...args: any[]) => Promise<void> {
  let expression = '';
  function visit(node: ts.Node) {
    if (!declaration && ts.isPropertyAssignment(node) && node.name.getText(source) === name) expression = node.initializer.getText(source);
    if (declaration && ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `production closure ${name} exists`);
  const compiled = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(ports), compiled)(...Object.values(ports));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(name: keyof typeof actions, { authWait = false, blockRequest = 1, platform = 'android' } = {}) {
  const sessionRef = { current: { userId: 'seller-a', apiBaseUrl: 'https://api.test' } };
  const auth = deferred(), response = deferred(), started = deferred();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const effects: Array<{ name: string; value: unknown }> = [];
  const result = { connections: ['a-connection'], accounts: ['a-account'], providers: ['a-provider'], authorizationUrl: 'https://provider.test/authorize-a' };
  const client = new PackProofV2Client({ baseUrl: 'https://api.test', getToken: () => 'token', getActiveAccount: () => sessionRef.current });
  for (const method of ['listIntegrationConnections', 'listConnectedAccounts', 'setCommerceAutomation', 'syncCommerceConnection', 'startConnectedAccountConnect', 'reauthorizeConnectedAccount', 'disconnectConnectedAccount']) {
    Object.assign(client, { [method]: async (...args: unknown[]) => {
      calls.push({ method, args });
      if (calls.length === blockRequest) { started.resolve(); await response.promise; }
      return result;
    } });
  }
  const ports = {
    client, sessionRef, Platform: { OS: platform },
    run: async (action: () => Promise<void>) => { if (authWait) await auth.promise; await action(); },
    setConnections: (value: unknown) => effects.push({ name: 'connections', value }),
    setConnectedAccounts: (value: unknown) => effects.push({ name: 'accounts', value }),
    setConnectedProviders: (value: unknown) => effects.push({ name: 'providers', value }),
    refreshProofCollection: async () => { effects.push({ name: 'proofs', value: null }); },
    Linking: { openURL: async (value: string) => { effects.push({ name: 'authorization', value }); } },
  };
  return { calls, effects, sessionRef, auth, response, started, invoke: () => productionClosure(name, ports)(...actions[name]) };
}

for (const name of Object.keys(actions) as Array<keyof typeof actions>) {
  test(`${name} retains the caller account across authentication refresh`, async () => {
    const f = fixture(name, { authWait: true });
    const pending = f.invoke();
    f.sessionRef.current = { userId: 'seller-b', apiBaseUrl: 'https://api.test' };
    f.auth.resolve();
    await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.effects, []);
  });

  test(`${name} rejects a response from the previous account`, async () => {
    const f = fixture(name);
    const pending = f.invoke();
    await f.started.promise;
    f.sessionRef.current = { userId: 'seller-b', apiBaseUrl: 'https://api.test' };
    f.response.resolve();
    await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.effects, []);
  });
}

for (const name of ['setCommerceAutomation', 'syncCommerceConnection', 'disconnectConnectedAccount'] as const) {
  test(`${name} does not apply stale refresh lists after its mutation succeeds`, async () => {
    const f = fixture(name, { blockRequest: 2 });
    const pending = f.invoke();
    await f.started.promise;
    f.sessionRef.current = { userId: 'seller-a', apiBaseUrl: 'https://another-api.test' };
    f.response.resolve();
    await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
    assert.deepEqual(f.effects, []);
  });
}

for (const platform of ['android', 'ios']) {
  test(`authorized ${platform} connect preserves its shop, automation and platform payload`, async () => {
    const f = fixture('connectConnectedAccount', { platform });
    const pending = f.invoke();
    await f.started.promise; f.response.resolve(); await pending;
    assert.deepEqual(f.calls, [{ method: 'startConnectedAccountConnect', args: ['shopify', { shop: 'original.myshopify.com', autoSyncEnabled: false, surface: platform }] }]);
    assert.deepEqual(f.effects, [{ name: 'authorization', value: 'https://provider.test/authorize-a' }]);
  });
}

test('session commit clears previous-account integration results completed during storage restoration', async () => {
  const original = { userId: 'seller-a', apiBaseUrl: 'https://api.test', token: 'token-a' };
  const next = { userId: 'seller-b', apiBaseUrl: 'https://api.test', token: 'token-b' };
  const sessionRef = { current: original }, tokenRef = { current: original.token };
  const lists: Record<string, unknown[]> = { connections: [], accounts: [], providers: [] };
  let visibleSession: unknown;
  const persist = productionClosure('persist', {
    accountReturn: {current:{name:"account"}}, captureReturn:{current:null}, workspaceOrigin:{current:"activity"},
    IS_RELEASE_CLIENT: false, currentRuntime: () => ({}), sessionRef, tokenRef,
    restoreProofsContext: async () => {
      // A's already-started request resolves while session restoration awaits storage.
      lists.connections = ['a-connection']; lists.accounts = ['a-account']; lists.providers = ['a-provider'];
    },
    setConnections: (value: unknown[]) => { lists.connections = value; },
    setConnectedAccounts: (value: unknown[]) => { lists.accounts = value; },
    setConnectedProviders: (value: unknown[]) => { lists.providers = value; },
    orderShare: undefined, stopNativeIntakeSession: async () => {},
    setSession: (value: unknown) => { visibleSession = value; }, saveCachedState: async () => {}, saveCaptureRecovery: async () => {},
  }, true);
  await persist(next);
  assert.deepEqual(lists, { connections: [], accounts: [], providers: [] });
  assert.equal(sessionRef.current, next);
  assert.equal(visibleSession, next);
  assert.equal(tokenRef.current, next.token);
});
