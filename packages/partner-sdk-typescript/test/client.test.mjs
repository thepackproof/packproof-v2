import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { PackProofClient, PackProofError, verifyWebhook } from '../index.mjs';

const settings = { baseUrl: 'https://api.example.test', token: 'test_secret', merchantId: 'merchant_1', delegationId: 'grant_1', sleep: async () => {} };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
test('resumes accepted byte-identical parts, retries a lost part response and reports durable byte progress',async()=>{
 const bytes=Uint8Array.from([1,2,3]),input={proofId:'proof',connectionId:'source',filename:'source.png',contentType:'image/png',byteSize:3,reportedAt:'2026-11-04T12:00:00Z'},digest=b=>createHash('sha256').update(b).digest('hex'),calls=[],progress=[];let writes=0;
 const client=new PackProofClient({...settings,fetch:async(url,o)=>{calls.push([url,o]);if(url.endsWith('/upload-sessions/session'))return json({...input,sessionId:'session',artifactId:'artifact',state:'open',partSize:2,expectedSha256:digest(bytes),receivedParts:[{partNumber:1,byteSize:2,sha256:digest(bytes.subarray(0,2))}],blockedReason:null});if(url.endsWith('/parts/2')){writes++;assert.deepEqual(o.body,bytes.subarray(2));assert.equal(o.headers.get('Content-Type'),'image/png');assert.equal(o.headers.get('Content-Length'),'1');if(writes===1)throw new TypeError('lost acknowledgement');return json({partNumber:2});}if(url.endsWith('/parts/complete'))return json({state:'received'});return json({operationId:'source_completion_1',state:'queued'},202);}});
 const r=await client.uploadArtifact(input,bytes,{resumeSessionId:'session',idempotencyKey:'one',onProgress:p=>progress.push(p)});assert.equal(r.data.state,'queued');assert.equal(writes,2);assert.equal(calls.filter(([url])=>url.endsWith('/parts/1')).length,0);assert.deepEqual(progress.map(p=>p.acceptedBytes),[2,3]);assert.equal(calls.every(([url,o])=>url.startsWith(settings.baseUrl+'/v1/partner/')&&o.redirect==='error'),true);
});
test('rejects conflicting resume bytes and metadata before writing another part',async()=>{
 const input={proofId:'proof',connectionId:'source',filename:'a.png',contentType:'image/png',byteSize:1,reportedAt:'2026-11-04T12:00:00Z'};let calls=0;
 const client=new PackProofClient({...settings,fetch:async()=>{calls++;return json({...input,sessionId:'session',artifactId:'artifact',state:'open',partSize:2,receivedParts:[{partNumber:1,byteSize:1,sha256:'a'.repeat(64)}]});}});
 await assert.rejects(client.uploadArtifact(input,Uint8Array.of(7),{resumeSessionId:'session',idempotencyKey:'one'}),/accepted part belongs to different bytes/);assert.equal(calls,1);
});
test('returns binary package bytes and stops polling when a canonical export is ready',async()=>{
 const bytes=Uint8Array.of(80,75,3,4,0,255);const client=new PackProofClient({...settings,fetch:async(url)=>url.endsWith('/package')?new Response(bytes,{headers:{'X-Request-Id':'binary'}}):json({state:'ready',id:'canonical_export_one'})});
 const result=await client.downloadExport('canonical_export_one');assert.deepEqual(result.data,bytes);assert.deepEqual(result.rawBody,bytes);assert.equal(result.requestId,'binary');assert.equal((await client.waitForOperation('canonical_export_one')).data.state,'ready');
});

test('a lost create response retries identical bytes and key with current selectors', async () => {
  const calls = [];
  const client = new PackProofClient({ ...settings, fetch: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw new TypeError('network response lost');
    return json({ proofId: 'pr_1', created: true }, 201, { 'X-Request-Id': 'req_2', 'Idempotency-Replayed': 'true' });
  } });
  const result = await client.createProof({ externalId: '00001', integrationAccountId: 'source_1', operatorMembershipId: 'member_1', transaction: { itemTitle: 'Pump' } }, { idempotencyKey: 'source_1:00001:v1' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[1].options.headers.get('Idempotency-Key'), 'source_1:00001:v1');
  assert.equal(calls[1].options.headers.get('PackProof-Merchant-Id'), 'merchant_1');
  assert.equal(calls[1].options.headers.get('PackProof-Delegation-Id'), 'grant_1');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(result.requestId, 'req_2');
  assert.equal(result.replayed, true);
  assert.deepEqual(JSON.parse(result.rawBody), result.data);
});

test('unsafe raw mutations without a key are attempted once and typed commands require one', async () => {
  let calls = 0;
  const client = new PackProofClient({ ...settings, fetch: async () => { calls++; return json({ detail: 'busy' }, 503); } });
  await assert.rejects(client.request('/v1/partner/proofs', { method: 'POST', body: {} }), PackProofError);
  assert.equal(calls, 1);
  assert.throws(() => client.createProof({}, {}), /idempotencyKey/);
  assert.equal(calls, 1);
});

test('throttled reads retry with a bounded Retry-After; authorization and conflicts do not retry', async () => {
  const delays = [];
  let calls = 0;
  const client = new PackProofClient({ ...settings, sleep: async ms => delays.push(ms), fetch: async () => ++calls === 1 ? json({}, 429, { 'Retry-After': '999999' }) : json({ proofIds: [], hasMore: false }) });
  await client.listProofs();
  assert.deepEqual(delays, [30000]);
  for (const status of [401, 403, 409, 412]) {
    calls = 0;
    client.fetcher = async () => { calls++; return json({ code: 'DENIED', detail: 'Refresh current authorization' }, status, { 'X-Request-Id': 'req_denied' }); };
    await assert.rejects(client.getProof('private_1'), error => error.status === status && error.code === 'DENIED' && error.requestId === 'req_denied');
    assert.equal(calls, 1);
  }
  client.fetcher = async () => json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON', operationId: 'op_legacy', retryable: false } }, 400);
  await assert.rejects(client.getProof('pr_1'), error => error.code === 'INVALID_JSON' && error.requestId === 'op_legacy' && error.message === 'Request body must be valid JSON');
});

test('cursor pages stay opaque and cursor expiry is surfaced for resynchronization', async () => {
  const urls = [];
  const client = new PackProofClient({ ...settings, fetch: async url => {
    urls.push(url);
    return urls.length === 1 ? json({ proofIds: ['pr_1'], nextCursor: 'scope.bound+cursor', hasMore: true }) : json({ proofIds: ['pr_2'], nextCursor: 'finished', hasMore: false });
  } });
  const ids = [];
  for await (const id of client.proofIds()) ids.push(id);
  assert.deepEqual(ids, ['pr_1', 'pr_2']);
  assert.equal(new URL(urls[1]).searchParams.get('after'), 'scope.bound+cursor');
  client.fetcher = async () => json({ code: 'EVENT_CURSOR_EXPIRED', detail: 'Resynchronize authorized snapshots' }, 410);
  await assert.rejects(client.listEvents({ after: 'expired' }), error => error.status === 410 && error.code === 'EVENT_CURSOR_EXPIRED');
});

test('bad repeating cursors and credentials in alternate origins are rejected', async () => {
  const client = new PackProofClient({ ...settings, fetch: async () => json({ proofIds: ['pr_1'], nextCursor: 'same', hasMore: true }) });
  await assert.rejects(async () => { for await (const ignored of client.proofIds({ after: 'same' })) void ignored; }, /did not advance/);
  await assert.rejects(client.request('//evil.test/steal'), /API-relative/);
  await assert.rejects(client.request('https://evil.test/steal'), /API-relative/);
  assert.throws(() => new PackProofClient({ ...settings, baseUrl: 'http://api.example.test' }), /HTTPS/);
});

test('operation polling returns partial failure honestly and does not invent completion', async () => {
  let calls = 0;
  const client = new PackProofClient({ ...settings, fetch: async () => json({ state: ++calls === 1 ? 'running' : 'partially_succeeded', rows: [{ state: 'failed' }] }) });
  const result = await client.pollOperation('/v1/partner/operations/op_1');
  assert.equal(result.data.state, 'partially_succeeded');
  assert.equal(result.data.rows[0].state, 'failed');
});

test('record changes preserve the expected operational revision and require deliberate refresh', async () => {
  const calls = [];
  const client = new PackProofClient({ ...settings, fetch: async (url, options) => { calls.push({ url, options }); return json({ proofId: 'pr_1', revision: 8 }); } });
  const result = await client.updateRecord('pr_1', { reference: 'SHIP-0001', reason: 'Correct source mapping' }, { revision: 7, idempotencyKey: 'correction_1' });
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.headers.get('If-Match'), '"7"');
  assert.equal(calls[0].options.headers.get('Idempotency-Key'), 'correction_1');
  assert.equal(result.data.revision, 8);
  assert.throws(() => client.closeRecord('pr_1', 'Review complete', { idempotencyKey: 'close_1' }), /revision/);
  client.fetcher = async () => json({ state: 'action_needed', lastErrorCode: 'IMPORT_ORIGINAL_INTEGRITY_FAILED' });
  assert.equal((await client.pollOperation('/me/records/imports/import_1')).data.state, 'action_needed');
});

test('record child iteration keeps the same page size and opaque scoped cursor', async () => {
  const urls = [];
  const client = new PackProofClient({ ...settings, fetch: async url => { urls.push(url); return json({ evidence: [{ id: `e_${urls.length}` }], nextCursor: urls.length === 1 ? 'scoped+child' : null, hasMore: urls.length === 1 }); } });
  const ids = [];
  for await (const result of client.evidencePages('pr/1', { limit: 1 })) ids.push(...result.data.evidence.map(e => e.id));
  assert.deepEqual(ids, ['e_1', 'e_2']);
  assert.equal(new URL(urls[1]).searchParams.get('cursor'), 'scoped+child');
  assert.equal(new URL(urls[1]).searchParams.get('limit'), '1');
  assert.match(urls[1], /pr%2F1\/evidence/);
});

test('webhook verification uses original bytes and bounds replay; no reserialization', () => {
  const secret = 'whsec_test', timestamp = 1793811600;
  const rawBody = Buffer.from('{ "id":"evt_1", "message":"café" }');
  const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
  const options = { secret, signature, rawBody, nowSeconds: timestamp };
  assert.equal(verifyWebhook(options), true);
  assert.equal(verifyWebhook({ ...options, rawBody: JSON.stringify(JSON.parse(rawBody)) }), false);
  assert.equal(verifyWebhook({ ...options, rawBody: Buffer.concat([rawBody, Buffer.from(' ')]) }), false);
  assert.equal(verifyWebhook({ ...options, nowSeconds: timestamp + 301 }), false);
  assert.equal(verifyWebhook({ ...options, nowSeconds: timestamp - 301 }), false);
  assert.equal(verifyWebhook({ ...options, signature: signature + ',v1=bad' }), false);
  assert.equal(verifyWebhook({ ...options, signature: 't=NaN,v1=00' }), false);
});

test('reference intake preserves exact identifiers and source command identity', async () => {
  const calls=[],client=new PackProofClient({...settings,fetch:async(url,options)=>{calls.push({url,options});return json(url.endsWith('/resolve')?{outcome:'unresolved_no_match',proofId:null,candidates:[]}:{id:'association_1',state:'pending',operationId:null});}});
  const scope={connectionId:'source_1',locationId:null,reference:{type:'SHIPMENT',externalId:'000045'}};
  assert.equal((await client.resolveSourceReference(scope)).data.outcome,'unresolved_no_match');
  const body={...scope,sourceKind:'fixture',sourceSchemaVersion:'1',mappingVersion:'1',event:{sourceEventId:'e1',eventType:'DELIVERED',reportedAt:'2026-11-07T00:00:00Z'}};
  await client.createSourceObservation(body,{idempotencyKey:'stable-source-command'});
  assert.equal(JSON.parse(calls[1].options.body).reference.externalId,'000045');
  assert.equal(calls[1].options.headers.get('Idempotency-Key'),'stable-source-command');
  await client.getSourceObservation('association_1');assert.match(calls[2].url,/operations\/association_1$/);
  assert.throws(()=>client.createSourceObservation(body),/idempotencyKey/);
});
