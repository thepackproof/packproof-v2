const test = require('node:test');
const assert = require('node:assert/strict');
const { stapleAndValidate, validateStapledArtifact } = require('../scripts/notarize-dmg.cjs');
const { notarizeApplication } = require('../scripts/notarize-app.cjs');

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

test('accepted application with a lost ticket connection retries the same app and requires validation', async () => {
  const calls = [];
  await notarizeApplication({ appPath:'/signed/PackProof.app' }, {
    notarize: async () => { calls.push('notarize'); throw new Error('Failed to staple your application with code: 68\nNSURLErrorDomain Code=-1005'); },
    staple: async app => calls.push(['staple',app]), validate: async app => calls.push(['validate',app]), env:{},
  });
  assert.deepEqual(calls,['notarize',['staple','/signed/PackProof.app'],['validate','/signed/PackProof.app']]);
});

test('rejected notarization or invalid ticket cannot be replaced with a staple retry', async () => {
  for (const message of ['Failed to notarize via notarytool: Invalid', 'Failed to staple your application with code: 65', 'Unrelated network connection was lost']) {
    await assert.rejects(notarizeApplication({appPath:'/signed/PackProof.app'}, {
      notarize: async () => {throw new Error(message);},
      staple: async () => {throw new Error('must not staple');}, validate: async () => {throw new Error('must not validate');}, env:{},
    }), /Application notarization failed/);
  }
});

test('a final application ticket validation failure still stops packaging', async () => {
  await assert.rejects(notarizeApplication({appPath:'/signed/PackProof.app'}, {
    notarize: async () => {}, staple: async () => {throw new Error('unexpected staple');},
    validate: async () => {throw new Error('ticket invalid');}, env:{},
  }), /ticket invalid/);
});
