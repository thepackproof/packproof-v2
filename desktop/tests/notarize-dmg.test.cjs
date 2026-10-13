const test = require('node:test');
const assert = require('node:assert/strict');
const { stapleAndValidate } = require('../scripts/notarize-dmg.cjs');

test('a ticket propagation retry must staple and validate the same disk image successfully', async () => {
  const calls = [], waits = [];
  let validations = 0;
  const attempts = await stapleAndValidate('/candidate/PackProof.dmg', {
    run: (exe, args) => { calls.push([exe,...args]); return { status: args[1] === 'validate' && ++validations === 1 ? 68 : 0, stdout:'ticket response' }; },
    wait: async ms => waits.push(ms), env: {},
  });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [10000]);
  assert.deepEqual(calls.map(row=>row[2]), ['staple','validate','staple','validate']);
  assert.ok(calls.every(row=>row[3] === '/candidate/PackProof.dmg'));
});

test('persistent ticket failure stops packaging after bounded retries and redacts known credentials', async () => {
  let count = 0;
  await assert.rejects(stapleAndValidate('/candidate/PackProof.dmg', {
    run: () => { count++; return {status:65,stderr:'Could not validate ticket. synthetic-secret-value'}; },
    wait: async () => {}, env: {APPLE_APP_SPECIFIC_PASSWORD:'synthetic-secret-value'},
  }), error => /exit 65, attempt 3\/3/.test(error.message) && error.message.includes('[REDACTED]') && !error.message.includes('synthetic-secret-value'));
  assert.equal(count, 3);
});

test('successful first validation is not retried', async () => {
  let count = 0;
  assert.equal(await stapleAndValidate('/candidate/PackProof.dmg', {
    run: () => { count++; return {status:0}; }, wait: async () => {throw new Error('unexpected wait');}, env:{},
  }), 1);
  assert.equal(count, 2);
});
