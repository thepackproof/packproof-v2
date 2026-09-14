import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedIdentifierShipping, identifierCaptureEnabled, identifierObservation, identifierStatus, identifierTime, mayRetainIdentifier, shippingReadFeedback } from '../src/capture/identifier-observation';
import { createShippingScanQueue } from '../src/capture/shipping-scan-queue';
import { PackProofV2Client } from '../src/v2-api';
import type { IdentifierObservation, IdentifierResolution, IdentifierReview } from '../../backend/src/identifiers/types';

const policy = { version: 1 as const, captureEnabled: true, autofillEnabled: true, reviewEnabled: true, surface: 'ANDROID' as const };
const decoded = { rawValue: '1Z999AA10123456784', format: 'code128', detectedAtMs: 3210.9, detectedAtUnixMs: 123,
  latencyMs: 9, source: 'LIVE_CAMERA_ANALYSIS' as const, decoderVersion: 'mlkit-barcode-17.2.0', frameWidth: 1280, frameHeight: 720,
  bounds: { left: 10, top: 20, right: 110, bottom: 220 } };
function resolution(route: IdentifierResolution['route'], rawText = decoded.rawValue): IdentifierResolution {
  const observation: IdentifierObservation = { ...identifierObservation(decoded, 'cap_original'), rawText, schemaVersion: 1, clientEventId: 'event-original', captureSessionId: 'cap_original', sequence: 1, firstSeenMs: 3210, lastSeenMs: 3210, sightings: 1 };
  return { observationId: 'obs_original', clientEventId: 'event-original', sequence: 1, route, state: 'MATCH', identifiers: [], reasonCodes: [], product: null, expected: [], reviewRequired: false, decision: null, receivedAt: '2026-09-09T00:00:00Z', observation, supplemental: false };
}

test('only the pinned compatible Android session policy enables the adapter; old journals remain disabled', () => {
  assert.equal(identifierCaptureEnabled(undefined), false);
  assert.equal(identifierCaptureEnabled(policy), true);
  assert.equal(identifierCaptureEnabled({ ...policy, captureEnabled: false }), false);
  assert.equal(identifierCaptureEnabled({ ...policy, surface: 'WEB' }), false);
});

test('native adapter retains exact SKU/raw-byte values, geometry and honest source timing without media paths', () => {
  const observed = identifierObservation({ ...decoded, rawValue: 'aB-001.x', rawBytes: 'YUItMDAxLng=' }, 'cap_original');
  assert.equal(observed.rawText, 'aB-001.x');
  assert.equal(observed.rawBytes, 'YUItMDAxLng=');
  assert.equal(observed.symbology, 'CODE_128');
  assert.equal(observed.recordingRef, 'cap_original');
  assert.equal(observed.mediaTimeMs, 3210);
  assert.equal(observed.timestampUncertaintyMs, null);
  assert.deepEqual(observed.bounds, { x: 10, y: 20, width: 100, height: 200 });
  const encoded = identifierObservation({ ...decoded, source: 'ENCODED_VIDEO_FRAME' }, 'cap_original');
  assert.equal(encoded.timestampOrigin, 'ENCODED_MEDIA');
  assert.equal(encoded.timestampUncertaintyMs, null);
  assert.match(identifierTime({ ...resolution('PRODUCT'), observation: { ...resolution('PRODUCT').observation, ...encoded } }), /exact frame time unavailable/);
});

test('mixed reads and opaque SKU overlap cannot contaminate the shipping queue', async () => {
  let requests = 0;
  const queue = createShippingScanQueue({ journal: { proofId: 'proof_original', sessionId: 'cap_original', userId: 'seller', entries: [] }, persist: async () => {}, bind: async () => { requests++; return { status: 'BOUND' }; } });
  for (const row of [resolution('PRODUCT', '036000291452'), resolution('AMBIGUOUS'), resolution('UNKNOWN'), resolution('SHIPPING')]) {
    const scan = approvedIdentifierShipping(row);
    if (scan) await queue.detect(scan);
  }
  assert.equal(requests, 1);
  assert.equal(approvedIdentifierShipping({ ...resolution('SHIPPING'), decision: { decision: 'NOT_THIS_SHIPMENT', reason: 'Another package', actorId: 'seller', createdAt: 'now' } }), null);
  assert.equal(approvedIdentifierShipping(resolution('SHIPPING'))?.idempotencyKey, 'identifier:event-original');
});

test('unrelated QR secrets never enter saved encoded inspection metadata', () => {
  for (const rawValue of ['https://untrusted.example/secret-token', 'WIFI:T:WPA;S:private;P:password;;', 'BEGIN:VCARD\nTEL:123\nEND:VCARD', 'a'.repeat(4097)])
    assert.equal(mayRetainIdentifier({ ...decoded, rawValue, format: 'qr' }), false);
  assert.equal(mayRetainIdentifier({ ...decoded, rawValue: '036000291452', format: 'upc_a' }), true);
});

test('shipping resolution is never advertised as an item match and known conflicts override successful reads', () => {
  const review = { observations: [resolution('SHIPPING')], reviewRequired: false } as IdentifierReview;
  assert.equal(identifierStatus(review), 'Shipping code read · check at review');
  assert.match(identifierStatus({ ...review, reviewRequired: true }), /Check it at review/);
});

test('account and API switches lock pending capture requests to their original scope', () => {
  let account: { userId: string; apiBaseUrl: string } | null = { userId: 'seller', apiBaseUrl: 'https://api.example' };
  const client = new PackProofV2Client({ baseUrl: 'https://api.example/', getToken: () => 'bearer', getActiveAccount: () => account });
  client.assertCaptureAccount('seller', 'https://api.example');
  account = { userId: 'buyer', apiBaseUrl: 'https://api.example' };
  assert.throws(() => client.assertCaptureAccount('seller', 'https://api.example'), { code: 'ACCOUNT_CHANGED' });
  account = { userId: 'seller', apiBaseUrl: 'https://other.example' };
  assert.throws(() => client.assertCaptureAccount('seller', 'https://api.example'), { code: 'ACCOUNT_CHANGED' });
  account = null;
  assert.throws(() => client.assertCaptureAccount('seller', 'https://api.example'), { code: 'ACCOUNT_CHANGED' });
});

test('mobile optional observation and checkpoint methods preserve scope, IDs and bodies across retries', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ schemaVersion: 1 }), { status: 200 });
  };
  try {
    const client = new PackProofV2Client({ baseUrl: 'https://api.example', getToken: () => 'bearer' });
    const events = [resolution('PRODUCT').observation];
    await client.recordCaptureIdentifiers('proof original', 'cap_original', events);
    const checkpoint = { clientEventId: 'checkpoint-stable', revision: 3, lastSequence: 2, coverage: 'PARTIAL' as const, omittedEvents: 0 };
    await client.checkpointCaptureIdentifiers('proof original', 'cap_original', checkpoint);
    await client.checkpointCaptureIdentifiers('proof original', 'cap_original', checkpoint);
    assert.match(calls[0].url, /proofs\/proof%20original\/capture-sessions\/cap_original\/identifier-observations$/);
    assert.deepEqual(calls[0].body, { events });
    assert.deepEqual(calls[1], calls[2]);
  } finally { globalThis.fetch = original; }
});


test('shipping reads give immediate feedback and preserve server ambiguity instead of claiming a match', () => {
  const event = {...decoded,rawValue:']C142043054\u001d9400111899223847182989'};
  assert.equal(mayRetainIdentifier(event),true);
  assert.equal(shippingReadFeedback(null,event)?.label,'Shipping barcode read · checking details');
  const shipping = resolution('SHIPPING',event.rawValue);
  const review = {observations:[shipping],reviewRequired:false} as IdentifierReview;
  assert.equal(shippingReadFeedback(review,event)?.label,'Shipping barcode read');
  assert.equal(shippingReadFeedback({...review,observations:[{...shipping,route:'AMBIGUOUS'}]},event),null);
  assert.equal(shippingReadFeedback({...review,observations:[{...shipping,reviewRequired:true}]},event)?.conflict,true);
});

test('postal framing survives the legacy shipping queue without duplicate tracking observations', async () => {
  const journal = {entries:[]} as Parameters<typeof createShippingScanQueue>[0]['journal'];
  let sends=0;
  const queue=createShippingScanQueue({journal,persist:async()=>{},bind:async()=>{sends++;return {status:'NEEDS_CONFIRMATION',trackingNumber:'9400111899223847182989'};}});
  await queue.detect({rawValue:']C142043054\u001d9400111899223847182989',format:'code128',detectedAtMs:10,idempotencyKey:'one'});
  await queue.detect({rawValue:'9400111899223847182989',format:'code128',detectedAtMs:20,idempotencyKey:'two'});
  assert.equal(sends,1);assert.equal(journal.entries.length,1);
});
