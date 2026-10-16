import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handledActionSucceeded, openProofDestination, participantLinkEntry, proofEntryRecording, type ProofEntry } from '../src/experience/proof-entry.ts';
import { selectRecoveryWorkspace, type RecoveryWorkspaceInput } from '../src/experience/recovery-workspace.ts';
import type { LocalCapture } from '../src/capture.ts';
import { openFreshProofAction } from '../src/experience/action-routing.ts';
import { creationEntryRoute, initialProofsLibrary, DEFAULT_PROOFS_LIBRARY } from '../src/app/navigation.ts';
import { parseTaskIntent, taskIntent } from '../src/experience/task-intent.ts';
import { proofIdFromLink, historyShareFromLink } from '../src/app/deep-links.ts';
import type { ProofView } from '../src/v2-api.ts';

const fixture = (overrides: Partial<ProofView> = {}): ProofView => ({
  proofId: 'proof_current', status: 'READY_FOR_EVIDENCE', workflowType: 'COMMERCE_SALE',
  finalizedAt: null, participants: [{ userId: 'seller', role: 'SELLER', status: 'JOINED' }], evidence: [],
  ...overrides,
} as ProofView);

async function enter(entry: ProofEntry, proof: ProofView, userId = 'seller') {
  const calls: string[] = [];
  const notices: string[] = [];
  await openProofDestination(entry, {
    assertCurrentAccount: () => { calls.push('account'); },
    view: async id => { calls.push(`view:${id}`); },
    historyShare: id => { calls.push(`history:${id}`); },
    resume: async id => { await openFreshProofAction(id, {
      userId,
      refreshProof: async id => { calls.push(`fresh:${id}`); return proof; },
      assertCurrentAccount: () => { calls.push('account'); },
      navigate: route => { calls.push(`route:${route}`); },
      openReceipt: id => { calls.push(`receipt:${id}`); },
      notice: text => { notices.push(text); },
    }); return true; },
  });
  return { calls, notices };
}

test('Android participant links and ordinary resume entries execute the same fresh action owner', async () => {
  const link = 'https://thepackproof.com/app/proofs/proof_current';
  const linked = await enter(participantLinkEntry(proofIdFromLink(link)!, null, true), fixture());
  const row = await enter({ proofId: 'proof_current', intent: 'resume' }, fixture());
  assert.deepEqual(linked, row);
  assert.ok(linked.calls.includes('fresh:proof_current'));
  assert.ok(linked.calls.includes('route:capture'));
  assert.ok(!linked.calls.some(call => call.startsWith('view:')));
});

test('an action chosen from a stale recording-needed card uses the freshly finalized record', async () => {
  const result = await enter(participantLinkEntry('proof_current', null, true), fixture({ status: 'FINALIZED', finalizedAt: '2026-10-15' }));
  assert.ok(result.calls.includes('route:proof'));
  assert.ok(!result.calls.includes('route:capture'));
  assert.match(result.notices[0], /already been finalized/);
});

test('buyer, removed participant and unknown server state cannot route into seller capture', async () => {
  for (const [proof, user] of [
    [fixture({ participants: [{ userId: 'buyer', role: 'BUYER', status: 'JOINED' }] as ProofView['participants'] }), 'buyer'],
    [fixture(), 'removed-user'],
    [fixture({ status: 'UNKNOWN' }), 'seller'],
  ] as const) {
    const result = await enter({ proofId: 'proof_current', intent: 'resume' }, proof, user);
    assert.ok(result.calls.includes('route:proof'));
    assert.ok(!result.calls.includes('route:capture'));
  }
});

test('fresh committed evidence uses the existing confirmation owner', async () => {
  const proof = fixture({ status: 'EVIDENCE_COMMITTED', evidence: [{ validationStatus: 'COMMITTED', evidenceType: 'FULFILLMENT_CAPTURE' }] as ProofView['evidence'] });
  assert.ok((await enter({ proofId: 'proof_current', intent: 'resume' }, proof)).calls.includes('route:finalize'));
});

test('authorized receiving stage remains separate from the finalized root record', async () => {
  const proof = fixture({ status: 'FINALIZED', finalizedAt: '2026-10-15', presentation: {
    proofId: 'proof_current', displayStatus: 'Receipt recording needed', completed: true, canContribute: true,
    diagnostic: null, needsAttention: true, nextAction: { type: 'WORKFLOW_ACTION', label: 'Record receipt' },
    shipmentStatus: null, share: { available: true, reason: null },
  } });
  const result = await enter({ proofId: 'proof_current', intent: 'resume' }, proof);
  assert.ok(result.calls.includes('receipt:proof_current'));
  assert.ok(!result.calls.includes('route:capture'));
});

test('grading work stays with its current workflow owner rather than ordinary shipment capture', async () => {
  const result = await enter({ proofId: 'proof_current', intent: 'resume' }, fixture({ workflowType: 'GRADING_SUBMISSION' }));
  assert.ok(result.calls.includes('route:proof'));
  assert.ok(!result.calls.includes('route:capture'));
});

test('explicit evidence views and legacy participant links remain viewers even when unfinished', async () => {
  for (const entry of [
    { proofId: 'proof_current', intent: 'view' } as const,
    participantLinkEntry('proof_current', null, false),
  ]) {
    const result = await enter(entry, fixture());
    assert.deepEqual(result.calls, ['account', 'view:proof_current', 'account']);
  }
});

test('history-share links authorize the viewer before opening the requested history share', async () => {
  const link = 'packproof://proof/proof_current?historyShare=share_123';
  const id = proofIdFromLink(link)!;
  const share = historyShareFromLink(link)!.shareId;
  const result = await enter(participantLinkEntry(id, share, true), fixture());
  assert.deepEqual(result.calls, ['account', 'view:proof_current', 'account', 'history:share_123']);
});

test('account switch during a history-view fetch prevents applying the share locator', async () => {
  let current = true;
  const history: string[] = [];
  await assert.rejects(openProofDestination({ proofId: 'proof_current', intent: 'historyShare', historyShareId: 'share_123' }, {
    assertCurrentAccount: () => { if (!current) throw new Error('ACCOUNT_CHANGED'); },
    view: async () => { current = false; },
    resume: async () => { throw new Error('unexpected resume'); },
    historyShare: id => { history.push(id); },
  }), /ACCOUNT_CHANGED/);
  assert.deepEqual(history, []);
});

test('account switch and failed refresh cannot navigate using a stale actionable record', async () => {
  for (const failedFetch of [false, true]) {
    let current = true;
    const routes: string[] = [];
    await assert.rejects(openFreshProofAction('proof_current', {
      userId: 'seller',
      refreshProof: async () => { if (failedFetch) throw new Error('OFFLINE'); current = false; return fixture(); },
      assertCurrentAccount: () => { if (!current) throw new Error('ACCOUNT_CHANGED'); },
      navigate: route => { routes.push(route); },
      openReceipt: id => { routes.push(id); },
      notice: text => { routes.push(text); },
    }), failedFetch ? /OFFLINE/ : /ACCOUNT_CHANGED/);
    assert.deepEqual(routes, []);
  }
});

test('handled resume failures are not acknowledgements of an opened deep link', async () => {
  const errors: string[] = [];
  let navigated = false;
  const opened = await openProofDestination(participantLinkEntry('proof_current', null, true), {
    assertCurrentAccount: () => {},
    view: async () => { throw new Error('unexpected viewer'); },
    historyShare: () => { throw new Error('unexpected history'); },
    resume: () => handledActionSucceeded(async action => {
      try { await action(); } catch (error) { errors.push((error as Error).message); }
    }, async () => {
      await Promise.reject(new Error('CONNECTION_LOST'));
      navigated = true;
    }),
  });
  assert.equal(opened, false, 'Root must retain its persisted link when the action owner reports failure');
  assert.equal(navigated, false);
  assert.deepEqual(errors, ['CONNECTION_LOST'], 'existing user-facing error handling is preserved');
});

test('handled action outcome distinguishes successful recovery from a pre-action auth failure', async () => {
  assert.equal(await handledActionSucceeded(async action => { await action(); }, async () => {}), true);
  assert.equal(await handledActionSucceeded(async () => { /* The owner handled refresh-token failure before invoking the action. */ }, async () => { throw new Error('must not run'); }), false);
  assert.equal(await handledActionSucceeded(async action => { await action(); }, async () => false), false);
  assert.equal(await openProofDestination({ proofId: 'proof_current', intent: 'view' }, {
    assertCurrentAccount: () => {}, resume: async () => false, view: async () => {}, historyShare: () => {},
  }), true);
});

test('default Android creation is manual while explicit advanced and legacy routes remain reachable', () => {
  assert.equal(creationEntryRoute('create', true), 'manual');
  assert.equal(creationEntryRoute('create', true, 'options'), 'create');
  assert.equal(creationEntryRoute('create', false), 'create');
  for (const route of ['scan', 'manual', 'intake', 'review', 'orders', 'station'] as const) {
    assert.equal(creationEntryRoute(route, true), route);
  }
});

test('new Android catalog defaults to all without changing the legacy baseline or another account defaults', () => {
  const android = initialProofsLibrary(true);
  assert.equal(android.view, 'all');
  assert.equal(initialProofsLibrary(false).view, 'attention');
  android.view = 'completed';
  assert.equal(initialProofsLibrary(true).view, 'all');
  assert.equal(DEFAULT_PROOFS_LIBRARY.view, 'attention');
});

test('advanced creation survives restart without carrying selected Proof, consent or unknown modes', () => {
  const stored = taskIntent('create', 'proof_unrelated', 1, { creationMode: 'options' });
  const restored = parseTaskIntent(JSON.stringify(stored));
  assert.equal(restored?.creationMode, 'options');
  assert.equal(restored?.proofId, undefined);
  assert.equal(creationEntryRoute(restored!.route, true, restored?.creationMode), 'create');
  assert.equal(taskIntent('manual', null, 1, { creationMode: 'options' })?.creationMode, undefined);
  assert.equal(parseTaskIntent(JSON.stringify({ version: 1, flowVersion: 1, route: 'create', creationMode: 'auto-submit', consent: true }))?.creationMode, undefined);
  assert.deepEqual(parseTaskIntent('{"version":1,"flowVersion":0,"route":"create"}'), { version: 1, flowVersion: 0, route: 'create' });
});

const saved = (id: string, phase = 'LOCAL_ONLY', userId = 'seller'): LocalCapture => ({
  uri: `file:///${id}.mp4`, captureSessionId: id, captureProofId: 'proof_current', captureUserId: userId,
  byteSize: 200, durationMs: 1000, localFileAvailable: true,
  recovery: { apiBaseUrl: 'https://api.example', phase, submitRequested: phase !== 'LOCAL_ONLY' },
} as LocalCapture);
const recoveryInput = (captures: LocalCapture[]): RecoveryWorkspaceInput => ({
  proofs: [{ proofId: 'proof_current', transactionId: 'txn_current', role: 'SELLER', status: 'READY_FOR_EVIDENCE',
    createdAt: '2026-10-15', updatedAt: '2026-10-15', finalizedAt: null,
    transaction: { itemTitle: 'Signed baseball', externalReference: null, transactionDate: null, carrier: null, trackingNumber: null } }],
  invitations: [], captures, orders: [], progress: {}, userId: 'seller', apiBaseUrl: 'https://api.example', online: true, reconciled: true,
});

test('Home, list resume and deep-link resume select the same interrupted original before a completed take', async () => {
  const input = recoveryInput([saved('first-interrupted', 'RECORDING'), saved('chosen-review')]);
  const homeAction = selectRecoveryWorkspace(input).model.recommendation;
  const resumed: string[] = [];
  const owners = {
    assertCurrentAccount: () => {}, view: async () => { throw new Error('unexpected viewer'); }, historyShare: () => {},
    resume: async (id: string) => {
      const selected = proofEntryRecording(input, id);
      assert.equal(selected.action?.kind, 'review_upload');
      resumed.push(selected.capture!.captureSessionId!);
      return true;
    },
  };
  await openProofDestination({ proofId: 'proof_current', intent: 'resume' }, owners);
  await openProofDestination(participantLinkEntry('proof_current', null, true), owners);
  assert.equal(homeAction.sessionId, 'first-interrupted');
  assert.deepEqual(resumed, [homeAction.sessionId, homeAction.sessionId]);
});

test('multiple playable originals use the canonical stable session choice regardless of array order or connectivity', () => {
  for (const captures of [[saved('z-review'), saved('a-review')], [saved('a-review'), saved('z-review')]]) {
    for (const online of [true, false]) {
      const input = { ...recoveryInput(captures), online, reconciled: online };
      const selected = proofEntryRecording(input, 'proof_current');
      assert.equal(selected.capture?.captureSessionId, 'a-review');
      assert.equal(selected.action?.sessionId, selectRecoveryWorkspace(input).model.recommendation.sessionId);
    }
  }
});

test('entry capture selection cannot use foreign originals and points failed work at its precise recovery task', () => {
  const input = recoveryInput([saved('foreign-first', 'LOCAL_ONLY', 'other'), saved('failed-session', 'NEEDS_ATTENTION')]);
  const selected = proofEntryRecording(input, 'proof_current');
  assert.equal(selected.capture?.captureSessionId, 'failed-session');
  assert.equal(selected.action?.kind, 'review_upload');
  assert.equal(selected.action?.sessionId, 'failed-session');
  assert.equal(proofEntryRecording(recoveryInput([saved('foreign-only', 'LOCAL_ONLY', 'other')]), 'proof_current').capture, null);
});
