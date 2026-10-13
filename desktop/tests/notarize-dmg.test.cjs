const test = require('node:test');
const assert = require('node:assert/strict');
const { stapleAndValidate, validateStapledArtifact } = require('../scripts/notarize-dmg.cjs');

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

test('artifact verification retries a lost Apple connection without restapling or changing bytes', async () => {
  const calls = [], waits = [];
  assert.equal(await validateStapledArtifact('/signed/PackProof.app', {
    run: (exe, args) => { calls.push([exe, ...args]); return calls.length === 1 ? {status:68, stderr:'NSURLErrorDomain Code=-1005 The network connection was lost.'} : {status:0}; },
    wait: async ms => waits.push(ms), env:{},
  }), 2);
  assert.deepEqual(calls, Array(2).fill(['xcrun', 'stapler', 'validate', '/signed/PackProof.app']));
  assert.deepEqual(waits, [10000]);
});

test('persistent Apple service failure cannot satisfy artifact verification', async () => {
  let count = 0;
  await assert.rejects(validateStapledArtifact('/signed/PackProof.dmg', {
    run: () => { count++; return {status:68, stderr:'The validate action failed! Error 68.'}; },
    wait: async () => {}, env:{},
  }), /exit 68, attempt 3\/3/);
  assert.equal(count, 3);
});

test('invalid tickets fail immediately and successful validation does not wait', async () => {
  let count = 0;
  await assert.rejects(validateStapledArtifact('/signed/PackProof.pkg', {
    run: () => {count++; return {status:65,stderr:'No stapled ticket found'};},
    wait: async () => {throw new Error('unexpected wait');}, env:{},
  }), /exit 65, attempt 1\/3/);
  assert.equal(count, 1);
  assert.equal(await validateStapledArtifact('/signed/PackProof.app', {
    run: () => ({status:0}), wait: async () => {throw new Error('unexpected wait');}, env:{},
  }), 1);
});
