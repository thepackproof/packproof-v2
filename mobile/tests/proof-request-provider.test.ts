import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createProofRequestGate, loadProofSnapshot, SupersededProofRequest } from '../src/experience/proof-request.ts';

// Execute the actual provider functions with storage and server ports, as in the
// existing capture-navigation suite. This does not simulate camera hardware.
const source = ts.createSourceFile('provider.tsx', readFileSync(new URL('../src/app/PackProofProvider.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
function providerFunction(name: string, ports: Record<string, unknown>) {
  let declaration = '';
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit); };
  visit(source); assert.ok(declaration);
  return new Function(...Object.keys(ports), ts.transpileModule(`${declaration}; return ${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(ports));
}
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function harness(read: (id: string) => Promise<any>, accountDelay?: () => Promise<void>) {
  const sessionRef = { current: { userId: 'seller', apiBaseUrl: 'https://api.example', token: 'test-only', proofId: 'proof_old' } as any };
  const visible: string[] = [], cached: string[] = [];
  let shown = 'proof_old';
  const ports = {
    sessionRef, tokenRef: { current: 'test-only' }, IS_RELEASE_CLIENT: false, currentRuntime: () => ({}), restoreProofsContext: async () => {},
    accountReturn: { current: {} }, captureReturn: { current: null }, workspaceOrigin: { current: 'home' }, setConnections() {}, setConnectedAccounts() {}, setConnectedProviders() {},
    orderShare: { setActiveAccount: accountDelay ?? (async () => {}) }, stopNativeIntakeSession: async () => {},
    setSession(next: any) { assert.equal(shown, next.proofId, 'record and session are published together'); },
    saveCachedState: async (next: any) => { cached.push(next.proofId); }, saveCaptureRecovery: async () => {},
    proofRequests: { current: createProofRequestGate() }, loadProofSnapshot,
    client: { getProof: read, getTransaction: async (id: string) => ({ transactionId: id }), getManifest: async (id: string) => ({ proofId: id }), getShipmentIntegrity: async () => ({}),
      assertCaptureAccount(userId: string) { if (sessionRef.current?.userId !== userId) throw new Error('ACCOUNT_CHANGED'); } },
    setProof(p: any) { shown = p.proofId; visible.push(shown); }, setTransactionDetail() {}, setEditForm() {}, setManifest() {}, setShipmentIntegrity() {}, formFromTransaction: () => ({}), setOffline() {},
    cacheRef: { current: { records: {} } }, proofsScrollOffset: { current: 0 }, saveProofsCache: async () => {},
  };
  const persist = providerFunction('persist', ports);
  const refresh = providerFunction('refreshProof', { ...ports, persist });
  return { ports, refresh, visible, cached };
}
const record = (id: string) => ({ proofId: id, transactionId: `txn_${id}`, status: 'FINALIZED', updatedAt: '2026-10-16' });

test('provider keeps B selected when the earlier A network response arrives last', async () => {
  const a = deferred<any>();
  const h = harness(async id => id === 'proof_A' ? a.promise : record(id));
  const first = h.refresh('proof_A'); const rejected = assert.rejects(first, SupersededProofRequest);
  await h.refresh('proof_B'); a.resolve(record('proof_A')); await rejected;
  assert.deepEqual(h.visible, ['proof_B']); assert.deepEqual(h.cached, ['proof_B']); assert.equal(h.ports.sessionRef.current.proofId, 'proof_B');
});
test('provider cancels an older selection during native account synchronization before publishing it', async () => {
  const waiting = deferred<void>(), entered = deferred<void>(); let calls = 0;
  const h = harness(async id => record(id), async () => { if (++calls === 1) { entered.resolve(); await waiting.promise; } });
  const first = h.refresh('proof_A'); const rejected = assert.rejects(first, SupersededProofRequest);
  await entered.promise; await h.refresh('proof_B'); waiting.resolve(); await rejected;
  assert.deepEqual(h.visible, ['proof_B']); assert.deepEqual(h.cached, ['proof_B']); assert.equal(h.ports.sessionRef.current.proofId, 'proof_B');
});
test('provider cannot publish a prior account response after sign-out', async () => {
  const response = deferred<any>(); const h = harness(() => response.promise);
  const pending = h.refresh('proof_A'); const rejected = assert.rejects(pending, /ACCOUNT_CHANGED/);
  h.ports.sessionRef.current = null; response.resolve(record('proof_A')); await rejected;
  assert.deepEqual(h.visible, []); assert.deepEqual(h.cached, []);
});
