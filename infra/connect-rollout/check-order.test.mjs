import assert from 'node:assert/strict';
import test from 'node:test';
import { checkOrder } from './check-order.mjs';

const input = { source: 'a'.repeat(40), organizationId: 'test-org', environment: 'sandbox',
  proofId: 'sample', token: 'test-session', output: '/sample/exports' };
function dependencies(selectedOrganizationId = input.organizationId) {
  return {
    async fetcher(url, options) {
      assert.equal(url.hostname, 'pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws');
      assert.equal(options.redirect, 'error');
      if (url.pathname === '/meta') {
        assert.equal(options.headers.Authorization, undefined);
        return Response.json({ commit: input.source, environment: 'production' });
      }
      assert.equal(options.headers.Authorization, 'Bearer ' + input.token);
      assert.equal(url.searchParams.get('organizationId'), input.organizationId);
      assert.equal(url.searchParams.get('environment'), input.environment);
      if (url.pathname === '/me/records/context') return Response.json({
        selectedOrganizationId, environment: 'sandbox', capabilities: { orderProofs: true } });
      assert.equal(url.pathname, '/me/records/order-proofs/sample');
      return Response.json({ proofId: input.proofId, revision: 3, lines: [] });
    },
    async checkPortal(web, api, fetcher, options) { assert.equal(options.expectedCommit, input.source); },
    async checkLocal(output, receipt) {
      assert.equal(output, input.output);
      assert.deepEqual(receipt.lines, []);
      return { filesVerified: 7, verifiedAt: '2026-11-18T12:00:00Z' };
    },
  };
}
test('checks one operator-selected order online and locally without returning customer data', async () => {
  assert.deepEqual(await checkOrder(input, dependencies()),
    { source: input.source, revision: 3, filesVerified: 7, verifiedAt: '2026-11-18T12:00:00Z' });
});
test('stops before reading a Proof if the account resolves to a different organization', async () => {
  await assert.rejects(checkOrder(input, dependencies('another-org')), /no active Proof workspace/);
});
