import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_MASKS, approvalBody, buildMasks, defaultMask, fitMediaFrame, maskFromDrag, mediaKind, readCopies, redactionStatus, type MaskDraft, type RedactionCopy } from '../src/supporting/redactions';

const sourceSha256 = 'a'.repeat(64), renderedSha256 = 'b'.repeat(64);
const ready: RedactionCopy = { derivativeId: 'pmd_private', evidenceId: 'ev_original', sourceSha256, status: 'READY', sha256: renderedSha256, contentType: 'video/mp4', byteSize: 512 };
const percent = (overrides: Partial<MaskDraft> = {}): MaskDraft => ({ x: '0', y: '0', width: '100', height: '100', ...overrides });

test('percentage editing preserves decimal precision and never mutates the draft', () => {
  const draft = percent({ x: '12.345678', y: '9,25', width: '20.125', height: '0.75' });
  const before = { ...draft };
  const [mask] = buildMasks([draft]);
  assert.ok(Math.abs(mask.x - .12345678) < 1e-15);
  assert.deepEqual({ ...mask, x: .12345678 }, { x: .12345678, y: .0925, width: .20125, height: .0075 });
  assert.deepEqual(draft, before);
  assert.deepEqual(buildMasks([defaultMask()]), [{ x: .05, y: .65, width: .9, height: .3 }]);
});

test('masks reject missing, nonnumeric, negative, empty and out-of-frame regions', () => {
  for (const draft of [percent({ x: '' }), percent({ y: 'NaN' }), percent({ width: 'Infinity' }), percent({ width: '-1' }), percent({ x: '1e1' }), percent({ x: '0x10' }), percent({ x: '101' }), percent({ x: '1' }), percent({ width: '0' }), percent({ height: '0' }), percent({ y: '99', height: '2' }), percent({ x: '100', width: '.000000000001' })]) {
    assert.throws(() => buildMasks([draft]), /Mask 1/);
  }
  assert.throws(() => buildMasks([]), /between 1 and 20/);
  assert.throws(() => buildMasks(Array.from({ length: MAX_MASKS + 1 }, defaultMask)), /between 1 and 20/);
  assert.equal(buildMasks(Array.from({ length: MAX_MASKS }, defaultMask)).length, 20);
});

test('portrait and landscape previews retain the original aspect without letterboxing the mask plane', () => {
  assert.deepEqual(fitMediaFrame(360, { width: 1920, height: 1080 }), { width: 360, height: 202.5 });
  assert.deepEqual(fitMediaFrame(360, { width: 1080, height: 1920 }), { width: 270, height: 480 });
  assert.deepEqual(fitMediaFrame(360, { width: 400, height: 400 }), { width: 360, height: 360 });
  for (const dimensions of [null, { width: 0, height: 10 }, { width: 10, height: NaN }, { width: -1, height: 4 }]) assert.equal(fitMediaFrame(360, dimensions), null);
  assert.equal(fitMediaFrame(0, { width: 1920, height: 1080 }), null);
});

test('forward and reverse touch selections produce the same region in original-frame coordinates', () => {
  const frame = { width: 270, height: 480 };
  const start = { x: 27, y: 96 }, end = { x: 189, y: 336 };
  const forward = maskFromDrag(start, end, frame)!;
  assert.deepEqual(forward, { x: '10', y: '20', width: '60', height: '50' });
  assert.deepEqual(maskFromDrag(end, start, frame), forward);
  assert.deepEqual(buildMasks([forward]), [{ x: .1, y: .2, width: .6, height: .5 }]);
  assert.deepEqual(buildMasks([maskFromDrag({ x: -20, y: -30 }, { x: 999, y: 999 }, frame)!]), [{ x: 0, y: 0, width: 1, height: 1 }]);
});

test('edge selections round into valid server mask bounds across screen sizes', () => {
  for (const frame of [{ width: 270, height: 480 }, { width: 393, height: 221.0625 }, { width: 345.3333, height: 194.25 }]) {
    for (let index = 1; index < 99; index++) {
      const draft = maskFromDrag({ x: frame.width * index / 100, y: frame.height / 3 }, { x: frame.width + 20, y: frame.height + 20 }, frame)!;
      const [mask] = buildMasks([draft]);
      assert.ok(mask.x >= 0 && mask.y >= 0 && mask.width > 0 && mask.height > 0);
      assert.ok(mask.x + mask.width <= 1 && mask.y + mask.height <= 1, JSON.stringify(mask));
      assert.ok(Math.abs(mask.x - index / 100) < 1e-8);
    }
  }
});

test('accidental taps, lines, and unmeasured frames never create masks', () => {
  const frame = { width: 300, height: 200 };
  for (const end of [{ x: 1, y: 1 }, { x: 0, y: 100 }, { x: 100, y: 0 }, { x: NaN, y: 100 }]) assert.equal(maskFromDrag({ x: 0, y: 0 }, end, frame), null);
  assert.equal(maskFromDrag({ x: 0, y: 0 }, { x: 100, y: 100 }, { width: 0, height: 200 }), null);
});

test('media eligibility handles MIME parameters and excludes non-media', () => {
  assert.equal(mediaKind('IMAGE/JPEG; charset=binary'), 'image');
  assert.equal(mediaKind('video/mp4'), 'video');
  for (const type of [undefined, null, '', 'application/pdf', 'text/html']) assert.equal(mediaKind(type), null);
});

test('approval requires loaded rendered bytes and explicit review confirmation', () => {
  assert.deepEqual(approvalBody(ready, ready, renderedSha256, true), { sha256: renderedSha256 });
  for (const loaded of [null, sourceSha256, 'wrong']) assert.throws(() => approvalBody(ready, ready, loaded, true), /Open the rendered copy/);
  assert.throws(() => approvalBody(ready, ready, renderedSha256, false), /confirm/);
  assert.throws(() => approvalBody({ ...ready, status: 'PENDING' }, ready, renderedSha256, true), /Open the rendered copy/);
});

test('approval refetch fences removed, replaced, cross-source, and stale rendered copies', () => {
  const changed: (RedactionCopy | undefined)[] = [undefined, { ...ready, derivativeId: 'pmd_other' }, { ...ready, evidenceId: 'ev_other' }, { ...ready, sourceSha256: 'c'.repeat(64) }, { ...ready, sha256: 'c'.repeat(64) }, { ...ready, status: 'FAILED' }, { ...ready, status: 'PENDING' }];
  for (const current of changed) assert.throws(() => approvalBody(ready, current, renderedSha256, true), /changed or is no longer available/);
  assert.deepEqual(approvalBody(ready, { ...ready, status: 'REVIEWED' }, renderedSha256, true), { sha256: renderedSha256 });
});

test('copy listing accepts queued, failed and rendered states only for current committed evidence', () => {
  const queued: RedactionCopy = { ...ready, status: 'PENDING', sha256: null, contentType: null, byteSize: null };
  const failed: RedactionCopy = { ...queued, status: 'FAILED' };
  assert.deepEqual(readCopies({ derivatives: [queued, failed, ready] }, new Set(['ev_original'])), [queued, failed, ready]);
  assert.throws(() => readCopies({ derivatives: [ready] }, new Set(['ev_elsewhere'])), /does not match this Proof/);
  assert.throws(() => readCopies({ derivatives: [ready] }, new Set()), /does not match this Proof/);
});

test('copy listing rejects malformed replies and unverified rendered representations', () => {
  const ids = new Set(['ev_original']);
  for (const payload of [null, [], {}, { derivatives: 'invalid' }]) assert.throws(() => readCopies(payload, ids), /could not be read/);
  for (const item of [null, { ...ready, status: 'UNKNOWN' }, { ...ready, sourceSha256: 'invalid' }, { ...ready, sha256: null }, { ...ready, sha256: 'invalid' }, { ...ready, contentType: 'text/html' }, { ...ready, contentType: 42 }]) assert.throws(() => readCopies({ derivatives: [item] }, ids), /invalid private copy|does not match this Proof/);
});

test('rendering labels report copy state without claiming originals are hidden from shared Proofs', () => {
  assert.match(redactionStatus({ status: 'PENDING' }), /Refresh/);
  assert.match(redactionStatus({ status: 'FAILED' }), /failed/);
  assert.match(redactionStatus({ status: 'READY' }), /ready for review/);
  assert.match(redactionStatus({ status: 'REVIEWED' }), /Reviewed private copy saved/);
  for (const status of ['PENDING', 'FAILED', 'READY', 'REVIEWED'] as const) assert.doesNotMatch(redactionStatus({ status }), /original.*(?:withheld|hidden|never shared)/i);
});
