import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PackProofV2Client } from '../src/v2-api';
import { readRetention, preservationReason, releasableHold } from '../src/supporting/retention';
import { historyShareFromLink } from '../src/app/deep-links';
import { resolveBackRoute } from '../src/app/navigation';

test('preservation controls retain server blockers and only release the current user’s active hold', () => {
  const state = readRetention({ protectedUntil: '2026-12-01T00:00:00Z', blockers: ['Active retention hold'], holds: [
    { id: 'hold_a', createdBy: 'alice', reason: 'Open review', releasedAt: null },
    { id: 'hold_b', createdBy: 'bob', reason: 'Other review', releasedAt: null },
    { id: 'hold_old', createdBy: 'alice', reason: 'Closed', releasedAt: '2026-09-01T00:00:00Z' },
  ], deletionRequests: [{ id: 'delete_1', state: 'PENDING' }] });
  assert.deepEqual(state.blockers, ['Active retention hold']);
  assert.equal(releasableHold(state, 'hold_a', 'alice'), true);
  assert.equal(releasableHold(state, 'hold_b', 'alice'), false);
  assert.equal(releasableHold(state, 'hold_old', 'alice'), false);
  assert.equal(releasableHold(null, 'hold_a', 'alice'), false);
  assert.equal(preservationReason('  Active review  '), 'Active review');
  for (const value of ['', '  ', 'x'.repeat(1001)]) assert.throws(() => preservationReason(value));
  assert.throws(() => readRetention({ ...state, protectedUntil: 'unverified' }));
  assert.throws(() => readRetention({ ...state, holds: [{ ...state.holds[0], id: '../hold' }] }));
});

test('history handoffs are scoped to a trusted Proof route and a single validated share ID', () => {
  for (const url of ['https://thepackproof.com/proof/proof_a?historyShare=hs_a', 'packproof://proof/proof_a?historyShare=hs_a', 'packproof-v2://proof/proof_a?historyShare=hs_a']) assert.deepEqual(historyShareFromLink(url), { proofId: 'proof_a', shareId: 'hs_a' });
  for (const url of ['https://untrusted.test/proof/proof_a?historyShare=hs_a', 'https://user@thepackproof.com/proof/proof_a?historyShare=hs_a', 'https://thepackproof.com:444/proof/proof_a?historyShare=hs_a', 'https://thepackproof.com/proof/proof_a?historyShare=../other', 'packproof://proof/proof_a?historyShare=one&historyShare=two']) assert.equal(historyShareFromLink(url), null);
  assert.equal(resolveBackRoute('supporting'), 'proof');
});

test('supporting tools preserve authenticated canonical routes and station-token scope', async () => {
  const requests: Array<{ path: string; method: string; body: unknown; auth?: string; station?: string }> = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part.toString();
    requests.push({ path: req.url!, method: req.method!, body: body ? JSON.parse(body) : null, auth: req.headers.authorization, station: req.headers['x-packproof-station-token'] as string | undefined });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new PackProofV2Client({ baseUrl: `http://127.0.0.1:${address.port}`, getToken: () => 'fixture-session' });
  try {
    await client.featureRequest('proof/a', 'supplements', 'POST', { operationId: 'same-intent', kind: 'CORRECTION', facts: { statement: 'Correction' } });
    await client.retentionRequest('proof_a', '/holds', 'POST', { reason: 'Open review' });
    await client.retentionRequest('proof_a', '/holds/hold_a', 'DELETE');
    await client.retentionRequest('proof_a', '/deletion-requests', 'POST', { reason: 'Review request' });
    await client.relayRequest('/stations/station_a', 'GET', undefined, 'fixture-station');
    assert.deepEqual(requests.map(row => [row.path, row.method]), [['/proofs/proof%2Fa/supplements', 'POST'], ['/proofs/proof_a/retention/holds', 'POST'], ['/proofs/proof_a/retention/holds/hold_a', 'DELETE'], ['/proofs/proof_a/retention/deletion-requests', 'POST'], ['/me/packing-relay/stations/station_a', 'GET']]);
    assert.ok(requests.every(row => row.auth === 'Bearer fixture-session'));
    assert.ok(requests.slice(0, 4).every(row => row.station === undefined));
    assert.equal(requests[4].station, 'fixture-station');
    assert.match(client.featureDownloadUrl('proof/a', 'disclosure/redactions/redacted_a/media'), /\/proofs\/proof%2Fa\/disclosure\/redactions\/redacted_a\/media$/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
