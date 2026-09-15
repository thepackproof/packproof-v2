import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PackProofV2Client } from '../src/v2-api';
import { approveHistorySelection, approveRecipientPreparation, caseScope, digestBytes, digestValue, historyApprovalBody, historyFrom, historyShareId, incomingHistoryFrom, profilesFrom, recipientApprovalBody, recipientJobFrom, recipientRequest, scoped, verifyRecipientBytes, type RecipientJob, type RecipientProfile, type ReviewedHistory, type VerifiedPreview } from '../src/signature/workflows';

const now = Date.parse('2026-09-14T12:00:00.000Z');
const profile: RecipientProfile = { id: 'stripe-general-v1', destination: 'STRIPE_DISPUTE', network: 'GENERAL', region: 'GLOBAL', version: '1', reviewRequired: false };
function selectedHistory(): ReviewedHistory {
  const preview = { schema: 'packproof.selected-item-history.v1', proofId: 'proof-1', recipientUserId: 'buyer', linkIds: ['link-1'], entries: [{ linkId: 'link-1', state: 'ASSERTED', note: 'The serial shown in the earlier recording matches.', events: [] }], limitations: ['History is partial.'] };
  return { preview, previewSha256: digestValue(preview) };
}
function readyJob(type: 'pdf' | 'image' = 'pdf'): { job: RecipientJob; bytes: Uint8Array; previews: VerifiedPreview[] } {
  const bytes = new TextEncoder().encode(type === 'pdf' ? '%PDF-1.7 exact test bytes' : 'exact image fixture');
  const file = { name: type === 'pdf' ? 'submission.pdf' : 'frame-1.jpg', contentType: type === 'pdf' ? 'application/pdf' : 'image/jpeg', byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const artifact = { schema: 'packproof.recipient-export.v1', jobId: 'rex_1', proofId: 'proof-1', caseId: 'case-1', files: [file], approvedNarrative: 'The recording shows the box being sealed.', gaps: ['Carrier receipt is not established.'], destinationDeadline: '2026-09-15T12:00:00.000Z' };
  const job: RecipientJob = { jobId: 'rex_1', proofId: 'proof-1', caseId: 'case-1', state: 'READY', artifactSha256: digestValue(artifact), artifact, failureCode: null, approval: null };
  return { job, bytes, previews: [{ ...file, uri: `file:///owned-cache/${file.name}`, viewed: true }] };
}
function approved(job: RecipientJob, userId = 'seller'): RecipientJob {
  return { ...job, approval: { artifactSha256: job.artifactSha256!, actorUserId: userId, approvedAt: new Date(now).toISOString() } };
}
function requestInput() {
  return { caseId: 'case-1', profile, frames: [{ evidenceId: 'video-1', seconds: '1.234', label: '  Seal visible  ' }], sourceIds: ['video-1'], narrative: 'The seal is visible.', deadline: '2026-09-15T12:00:00.000Z', instructionsReviewed: true, idempotencyKey: 'exact-retry-1' };
}

test('case contents include only the selected fields and sources, with excluded evidence emptied', () => {
  assert.deepEqual(caseScope(['shipping', 'evidence', 'shipping'], ['video-2', 'video-2'], ['video-1', 'video-2']), { fields: ['shipping', 'evidence'], evidenceIds: ['video-2'] });
  assert.deepEqual(caseScope(['status'], ['video-1'], ['video-1']), { fields: ['status'], evidenceIds: [] });
  assert.deepEqual(caseScope([], [], ['video-1']), { fields: [], evidenceIds: [] });
  assert.throws(() => caseScope(['made-up-facts'], [], []));
  assert.throws(() => caseScope(['evidence'], ['private-source'], ['video-1']));
});

test('canonical digest preserves exact Unicode and nested facts independent of object key order', () => {
  const canonical = '{"a":{"first":"é 📦","last":2},"z":[3,1]}';
  assert.equal(digestValue({ z: [3, 1], a: { last: 2, first: 'é 📦' } }), createHash('sha256').update(canonical).digest('hex'));
  assert.equal(digestBytes(new Uint8Array([0, 255, 128])), createHash('sha256').update(new Uint8Array([0, 255, 128])).digest('hex'));
});

test('history approval binds the exact preview to the selected recipient, Proof, and link IDs', () => {
  const reviewed = selectedHistory();
  assert.deepEqual(historyApprovalBody(reviewed, 'proof-1', 'buyer', ['link-1', 'link-1']), { recipientUserId: 'buyer', linkIds: ['link-1'], previewSha256: reviewed.previewSha256 });
  assert.throws(() => historyApprovalBody(reviewed, 'proof-2', 'buyer', ['link-1']));
  assert.throws(() => historyApprovalBody(reviewed, 'proof-1', 'other', ['link-1']));
  assert.throws(() => historyApprovalBody(reviewed, 'proof-1', 'buyer', ['link-2']));
  reviewed.preview.entries[0].note = 'A changed assertion';
  assert.throws(() => historyApprovalBody(reviewed, 'proof-1', 'buyer', ['link-1']));
});

test('withdrawn consent, missing selected entries, or malformed events block history approval', () => {
  for (const mutate of [
    (value: ReviewedHistory) => { value.preview.entries[0].state = 'UNAVAILABLE'; },
    (value: ReviewedHistory) => { value.preview.entries = []; },
    (value: ReviewedHistory) => { (value.preview.entries[0] as any).events = [{ state: 123 }]; },
  ]) {
    const value = selectedHistory(); mutate(value); value.previewSha256 = digestValue(value.preview);
    assert.throws(() => historyApprovalBody(value, 'proof-1', 'buyer', ['link-1']));
  }
  assert.throws(() => historyFrom({ optedIn: true, entries: [{ linkId: 'l', state: 'ASSERTED', events: 'bad' }] }));
  const hidden = { preview: { ...selectedHistory().preview, entries: [{ linkId: 'link-1', state: 'UNAVAILABLE', reason: 'Consent withdrawn.' }] }, changedSinceApproval: true };
  assert.deepEqual(incomingHistoryFrom(hidden, 'proof-1'), hidden);
  assert.throws(() => incomingHistoryFrom(hidden, 'proof-2'));
});

test('incoming handoffs accept only trusted exact Proof links or an explicit handoff token', () => {
  assert.equal(historyShareId('share_1', 'proof-1'), 'share_1');
  assert.equal(historyShareId('https://thepackproof.com/proofs/proof-1?historyShare=share_1', 'proof-1'), 'share_1');
  for (const link of ['https://evil.example/proofs/proof-1?historyShare=share_1', 'https://thepackproof.com/proofs/proof-2?historyShare=share_1', 'http://thepackproof.com/proofs/proof-1?historyShare=share_1', 'https://attacker@thepackproof.com/proofs/proof-1?historyShare=share_1', 'https://thepackproof.com:8443/proofs/proof-1?historyShare=share_1', 'https://thepackproof.com/proofs/proof-1?historyShare=a&historyShare=b']) assert.throws(() => historyShareId(link, 'proof-1'));
});

test('history handoff sends the exact reviewed body and rejects a mismatched returned link', async () => {
  const reviewed = selectedHistory(), requests: unknown[] = [];
  const create = async (body: unknown) => { requests.push(body); return { shareId: 'share_1', path: '/proofs/proof-1?historyShare=share_1' }; };
  const input = { reviewed, proofId: 'proof-1', recipientUserId: 'buyer', linkIds: ['link-1'], current: () => true, create };
  assert.equal((await approveHistorySelection(input)).shareId, 'share_1');
  assert.deepEqual(requests, [{ recipientUserId: 'buyer', linkIds: ['link-1'], previewSha256: reviewed.previewSha256 }]);
  await assert.rejects(approveHistorySelection({ ...input, create: async () => ({ shareId: 'other', path: '/proofs/proof-1?historyShare=share_1' }) }));
});

test('destination requests preserve user facts, selected time, profile, deadline, and retry identity', () => {
  const body = recipientRequest(requestInput(), now);
  assert.deepEqual(body, { caseId: 'case-1', profileId: profile.id, frames: [{ evidenceId: 'video-1', offsetMs: 1234, label: 'Seal visible' }], narrative: 'The seal is visible.', destinationDeadline: '2026-09-15T12:00:00.000Z', destinationInstructionsReviewed: true, idempotencyKey: 'exact-retry-1' });
  assert.deepEqual(recipientRequest(requestInput(), now), body);
  assert.deepEqual(profilesFrom({ profiles: [profile] }), [profile]);
  assert.throws(() => profilesFrom({ profiles: [profile, profile] }));
  assert.throws(() => profilesFrom({ profiles: [{ ...profile, destination: 'PAYPAL_GUARANTEED' }] }));
});

test('preparation rejects excluded sources, stale formats, missing actual deadline, and invented empty frame facts', () => {
  for (const patch of [
    { profile: undefined }, { profile: { ...profile, reviewRequired: true } }, { instructionsReviewed: false },
    { deadline: new Date(now).toISOString() }, { deadline: 'not a deadline' }, { sourceIds: [] },
    { frames: [] }, { frames: [{ evidenceId: 'video-1', seconds: '-1', label: 'Seal' }] },
    { frames: [{ evidenceId: 'video-1', seconds: '21601', label: 'Seal' }] },
    { frames: [{ evidenceId: 'video-1', seconds: '1', label: ' ' }] }, { narrative: 'x'.repeat(2001) },
  ]) assert.throws(() => recipientRequest({ ...requestInput(), ...patch }, now));
});

test('ready preparation rejects wrong Proof/case, altered artifact, unsafe files, and mismatched nested binding', () => {
  const { job } = readyJob();
  assert.deepEqual(recipientJobFrom(job, 'proof-1', 'case-1'), job);
  assert.throws(() => recipientJobFrom(job, 'proof-2', 'case-1'));
  assert.throws(() => recipientJobFrom(job, 'proof-1', 'case-2'));
  assert.throws(() => recipientJobFrom({ ...job, artifact: { ...job.artifact, approvedNarrative: 'Replaced facts' } }, 'proof-1', 'case-1'));
  for (const patch of [{ name: '../submission.pdf' }, { byteSize: 4_500_001 }, { contentType: 'image/png' }, { sha256: 'bad' }]) {
    const artifact = { ...job.artifact!, files: [{ ...job.artifact!.files[0], ...patch }] };
    assert.throws(() => recipientJobFrom({ ...job, artifact, artifactSha256: digestValue(artifact) }, 'proof-1', 'case-1'));
  }
  const artifact = { ...job.artifact!, proofId: 'proof-2' };
  assert.throws(() => recipientJobFrom({ ...job, artifact, artifactSha256: digestValue(artifact) }, 'proof-1', 'case-1'));
});

test('every exact image or PDF must pass byte verification, be displayed, and receive legibility confirmation', () => {
  for (const type of ['pdf', 'image'] as const) {
    const { job, bytes, previews } = readyJob(type);
    verifyRecipientBytes(bytes, job.artifact!.files[0]);
    assert.throws(() => verifyRecipientBytes(bytes.slice(1), job.artifact!.files[0]));
    const changed = bytes.slice(); changed[0] ^= 1;
    assert.throws(() => verifyRecipientBytes(changed, job.artifact!.files[0]));
    assert.throws(() => recipientApprovalBody(job, previews, false));
    assert.throws(() => recipientApprovalBody(job, [{ ...previews[0], viewed: false }], true));
    assert.throws(() => recipientApprovalBody(job, [{ ...previews[0], sha256: '0'.repeat(64) }], true));
    assert.throws(() => recipientApprovalBody(job, [], true));
    assert.deepEqual(recipientApprovalBody(job, previews, true), { artifactSha256: job.artifactSha256, legibilityConfirmed: true });
  }
});

test('recipient approval sends the exact hash and allows a saved same-account approval without posting again', async () => {
  const { job, previews } = readyJob(), calls: unknown[] = [];
  const input = { job, previews, legible: true, userId: 'seller', current: () => true, approve: async (id: string, body: unknown) => { calls.push({ id, body }); return approved(job); } };
  const response = await approveRecipientPreparation(input);
  assert.deepEqual(calls, [{ id: 'rex_1', body: { artifactSha256: job.artifactSha256, legibilityConfirmed: true } }]);
  assert.equal(response.approval!.actorUserId, 'seller');
  await approveRecipientPreparation({ ...input, job: response, previews: [], legible: false });
  assert.equal(calls.length, 1);
});

test('approval cannot authorize download after a foreign actor, swapped job, or changed prepared bytes', async () => {
  const { job, previews } = readyJob();
  const replaced = readyJob('image').job;
  for (const response of [approved(job, 'other-user'), approved({ ...job, jobId: 'rex_other', artifact: { ...job.artifact!, jobId: 'rex_other' }, artifactSha256: digestValue({ ...job.artifact!, jobId: 'rex_other' }) }), approved(replaced), job]) {
    let downloaded = false;
    await assert.rejects((async () => { await approveRecipientPreparation({ job, previews, legible: true, userId: 'seller', current: () => true, approve: async () => response }); downloaded = true; })());
    assert.equal(downloaded, false);
  }
});

test('account, Proof, and foreground fences stop late approvals before download or share', async () => {
  for (const changed of ['account', 'proof', 'foreground'] as const) {
    const { job, previews } = readyJob();
    const state = { account: 'seller', proof: 'proof-1', foreground: true };
    const current = () => state.account === 'seller' && state.proof === 'proof-1' && state.foreground;
    let downloaded = false;
    await assert.rejects((async () => {
      await approveRecipientPreparation({ job, previews, legible: true, userId: 'seller', current, approve: async () => {
        if (changed === 'account') state.account = 'buyer';
        if (changed === 'proof') state.proof = 'proof-2';
        if (changed === 'foreground') state.foreground = false;
        return approved(job);
      } });
      downloaded = true;
    })());
    assert.equal(downloaded, false, changed);
  }
  let posted = false;
  await assert.rejects(scoped(() => false, async () => { posted = true; }));
  assert.equal(posted, false);
});

test('history scope changes after creation never expose the returned link in another scope', async () => {
  let active = true, shared = false;
  await assert.rejects((async () => {
    await approveHistorySelection({ reviewed: selectedHistory(), proofId: 'proof-1', recipientUserId: 'buyer', linkIds: ['link-1'], current: () => active, create: async () => { active = false; return { shareId: 'share_1', path: '/proofs/proof-1?historyShare=share_1' }; } });
    shared = true;
  })());
  assert.equal(shared, false);
});

test('native feature and signature adapters preserve canonical endpoint, exact request body, and fresh account headers', async () => {
  const originalFetch = globalThis.fetch, calls: Array<{ url: string; options?: RequestInit }> = [];
  let account = 'seller', token = 'seller-token';
  const client = new PackProofV2Client({ baseUrl: 'https://api.example.test', getToken: () => token, getActiveAccount: () => ({ userId: account, apiBaseUrl: 'https://api.example.test' }) });
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const reviewed = selectedHistory(), body = historyApprovalBody(reviewed, 'proof-1', 'buyer', ['link-1']);
    await client.signatureRequest('proof-1', '/history/share', 'POST', body);
    assert.equal(calls[0].url, 'https://api.example.test/proofs/proof-1/signature/history/share');
    assert.deepEqual(JSON.parse(String(calls[0].options?.body)), body);
    const request = recipientRequest(requestInput(), now);
    await client.featureRequest('proof-1', 'recipient-exports', 'POST', request);
    assert.equal(calls[1].url, 'https://api.example.test/proofs/proof-1/recipient-exports');
    assert.deepEqual(JSON.parse(String(calls[1].options?.body)), request);
    assert.equal(client.featureDownloadUrl('proof-1', 'recipient-exports/rex_1/files/0?preview=true'), 'https://api.example.test/proofs/proof-1/recipient-exports/rex_1/files/0?preview=true');
    token = 'refreshed-token';
    assert.equal(client.authorizedDownloadHeaders().Authorization, 'Bearer refreshed-token');
    client.assertCaptureAccount('seller', client.apiBaseUrl);
    account = 'buyer';
    assert.throws(() => client.assertCaptureAccount('seller', client.apiBaseUrl), /original/);
  } finally { globalThis.fetch = originalFetch; }
});
