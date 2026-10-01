import { afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createHarness, login, auth, commitFulfillmentAndAttest, type TestHarness } from './helpers.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createCaptureSession } from '../src/domain/capture-sessions.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { createServerApp } from '../src/server-app.js';
import { BearerUserAdapter } from '../src/auth/adapter.js';
import type { AppDependencies } from '../src/app.js';
import { SURFACE_METHOD, surfaceConfigFromEnv } from '../src/surface/config.js';
import { initializeMedia, commitMedia, createIntent, recordCommand, digest, surfaceExport, surfaceSummary } from '../src/surface/service.js';
import { claimSurfaceJob, processSurfaceJob, dispatchSurfaceJobs, type SurfaceRunner } from '../src/surface/worker.js';
import { sha256Hex } from '../src/hash.js';
const flags = {
  ...surfaceConfigFromEnv({}),
  collection: true,
  extraction: true,
  internalComparison: true
};
const fake: SurfaceRunner = async input => ({
  schemaVersion: 'surface-result/1',
  jobId: input.jobId,
  qualification: 'unqualified',
  status: 'inconclusive',
  method: SURFACE_METHOD,
  sourceDigests: ['enrollment', 'observation'].flatMap(role => ((input[role] as any)?.sources ?? []).map((source: any) => ({
    role,
    sourceId: source.sourceId,
    sha256: source.sha256
  }))),
  scopeResults: Object.fromEntries(['label', 'carton', 'assembly'].map(scope => [scope, {
    status: 'inconclusive',
    reasons: ['profile_unqualified']
  }])),
  coverage: {
    carton: {
      required: 2,
      completeForResearch: false,
      state: 'insufficient_coverage'
    }
  },
  limitations: ['Synthetic protocol fixture; no physical validation'],
  researchMetrics: {
    score: 1
  },
  templates: {
    secret: 'PRIVATE'
  }
});
describe('experimental surface integrity', () => {
  let h: TestHarness,
    deps: AppDependencies,
    actor: string,
    proofId: string,
    sessionId: string,
    now = new Date('2026-10-01T17:00:00Z');
  afterEach(async () => {
    await h?.close();
  });
  async function setup() {
    now = new Date('2026-10-01T17:00:00Z');
    h = await createHarness({
      now: () => now
    });
    actor = await login(h.app, 'surface-test');
    const t = await createTransaction(h.db, h.clock, actor, {
      itemTitle: 'Surface test carton'
    });
    proofId = (await createOrGetProof(h.db, h.clock, actor, t.transactionId)).proofId;
    sessionId = (await createCaptureSession(h.db, h.clock, actor, proofId, {
      client: 'NATIVE_CAMERA',
      idempotencyKey: 'surface-test-session'
    })).id;
    deps = {
      ...h,
      auth: new BearerUserAdapter(h.db),
      publicBaseUrl: 'http://localhost',
      devAuth: true,
      surface: {
        ...flags
      }
    };
  }
  async function upload(id = 'selected-frame') {
    const bytes = Buffer.from(`synthetic JPEG protocol fixture ${id}`);
    const media = await initializeMedia(deps, actor, proofId, {
      captureSessionId: sessionId,
      sha256: sha256Hex(bytes),
      byteSize: bytes.length,
      contentType: 'image/jpeg'
    }, id);
    await commitMedia(deps, actor, proofId, media.sourceId, bytes);
    return {
      sourceId: media.sourceId,
      sha256: sha256Hex(bytes),
      frameTimeMs: 50
    };
  }
  async function capture() {
    return {
      schemaVersion: 'surface-command/1',
      captureSessionId: sessionId,
      shipmentLegId: 'OUTBOUND',
      captureMode: 'offline',
      contextStage: 'unknown',
      captureProfileId: 'android-research',
      deviceMetadata: {},
      continuityEvents: [],
      sources: [await upload()],
      regions: []
    };
  }
  async function command(kind: 'enrollment' | 'observation' | 'comparison', v: any, key: string) {
    const intent = await createIntent(deps, actor, proofId, {
      operation: kind,
      requestDigest: digest(v)
    });
    return recordCommand(deps, actor, proofId, kind, {
      ...v,
      intentId: intent.intentId
    }, key);
  }
  it('default-off rejects sampling while preserved reads remain available', async () => {
    await setup();
    deps.surface = surfaceConfigFromEnv({});
    expect((await surfaceSummary(deps, actor, proofId)).capabilities).toMatchObject({
      collection: false,
      extraction: false,
      internalComparison: false,
      customerFindings: false
    });
    await expect(initializeMedia(deps, actor, proofId, {
      captureSessionId: sessionId,
      contentType: 'image/jpeg',
      byteSize: 1,
      sha256: '0'.repeat(64)
    }, 'media-off')).rejects.toMatchObject({
      code: 'SURFACE_DISABLED'
    });
  });
  it('binds intents, hashes and idempotency; refuses scores and cross-Proof reuse', async () => {
    await setup();
    const body = await capture();
    const e = await command('enrollment', body, 'enrollment-one');
    expect(e.state).toBe('analysis_pending');
    const retry = await recordCommand(deps, actor, proofId, 'enrollment', {
      ...body,
      intentId: 'expired'
    }, 'enrollment-one');
    expect(retry.id).toBe(e.id);
    await expect(recordCommand(deps, actor, proofId, 'enrollment', {
      ...body,
      captureMode: 'live',
      intentId: 'expired'
    }, 'enrollment-one')).rejects.toMatchObject({
      code: 'SURFACE_IDEMPOTENCY_CONFLICT'
    });
    const invalid = {
      ...body,
      matchScore: 1
    };
    await expect(command('observation', {
      ...invalid,
      enrollmentId: e.id
    }, 'invalid-score')).rejects.toMatchObject({
      code: 'SURFACE_INVALID_REQUEST'
    });
    await expect(command('observation', {
      ...body,
      enrollmentId: e.id
    }, 'replay-original')).rejects.toMatchObject({
      code: 'SURFACE_SOURCE_REPLAY'
    });
    const outsider = await login(h.app, 'surface-other');
    await expect(surfaceSummary(deps, outsider, proofId)).rejects.toMatchObject({
      httpStatus: 403
    });
    const t = await createTransaction(h.db, h.clock, actor, {
      itemTitle: 'Other parcel'
    });
    const p = (await createOrGetProof(h.db, h.clock, actor, t.transactionId)).proofId;
    const intent = await createIntent(deps, actor, p, {
      operation: 'observation',
      requestDigest: digest({
        ...body,
        captureSessionId: null,
        enrollmentId: e.id
      })
    });
    await expect(recordCommand(deps, actor, p, 'observation', {
      ...body,
      captureSessionId: null,
      enrollmentId: e.id,
      intentId: intent.intentId
    }, 'cross-proof')).rejects.toMatchObject({
      code: 'SURFACE_RECORD_NOT_FOUND'
    });
  });
  it('expiry and changed source commitments fail closed; root bytes survive late media and results', async () => {
    await setup();
    const body = await capture();
    const i = await createIntent(deps, actor, proofId, {
      operation: 'enrollment',
      requestDigest: digest(body)
    });
    now = new Date(now.getTime() + 301000);
    await expect(recordCommand(deps, actor, proofId, 'enrollment', {
      ...body,
      intentId: i.intentId
    }, 'late-intent')).rejects.toMatchObject({
      code: 'SURFACE_INTENT_INVALID'
    });
    const invalid = {
      ...body,
      sources: [{
        ...body.sources[0],
        sha256: '0'.repeat(64)
      }]
    };
    await expect(command('enrollment', invalid, 'bad-source')).rejects.toMatchObject({
      code: 'SURFACE_SOURCE_DIGEST_MISMATCH'
    });
    await commitFulfillmentAndAttest(h, actor, proofId);
    await finalizeProof(h.db, h.clock, actor, proofId);
    const rootBefore = (await h.db.query('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1', [proofId])).rows[0];
    await upload('late-frame');
    const enrolled = await command('enrollment', body, 'late-enrollment');
    const observation = await command('observation', {
      ...body,
      sources: [await upload('observation-frame')],
      enrollmentId: enrolled.id
    }, 'late-observation');
    await command('comparison', {
      schemaVersion: 'surface-command/1',
      enrollmentId: enrolled.id,
      observationId: observation.id,
      requestedScope: 'assembly'
    }, 'comparison-one');
    await dispatchSurfaceJobs(deps, fake);
    await dispatchSurfaceJobs(deps, fake);
    await dispatchSurfaceJobs(deps, fake);
    expect((await h.db.query('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1', [proofId])).rows[0]).toEqual(rootBefore);
    const exported = await surfaceExport(deps, actor, proofId);
    expect(exported.sources.length).toBe(3);
    expect(exported.extensions.every(e => e.rootManifestSha256 === null || e.rootManifestSha256 === rootBefore.sha256)).toBe(true);
    expect(JSON.stringify(exported)).not.toContain('PRIVATE');
    const summary = await surfaceSummary(deps, actor, proofId);
    expect(summary.comparisons[0].result.coverage.carton.completeForResearch).toBe(false);
    await expect(h.db.query("UPDATE surface_records SET sha256='bad' WHERE id=$1", [enrolled.id])).rejects.toThrow();
    deps.surface!.killSwitch = true;
    expect((await surfaceSummary(deps, actor, proofId)).comparisons).toHaveLength(1);
  });
  it('leases recover crashes, fence stale workers and deduplicate completion; failures stay operational', async () => {
    await setup();
    const e = await command('enrollment', await capture(), 'lease-test');
    const first = (await claimSurfaceJob(deps))!;
    expect(await claimSurfaceJob(deps)).toBeNull();
    now = new Date(now.getTime() + 121000);
    const replacement = (await claimSurfaceJob(deps))!;
    expect(replacement.id).toBe(first.id);
    expect(replacement.lease_token).not.toBe(first.lease_token);
    await processSurfaceJob(deps, first, fake);
    expect((await h.db.query('SELECT * FROM surface_analyses')).rows).toHaveLength(0);
    await processSurfaceJob(deps, replacement, fake);
    await processSurfaceJob(deps, replacement, fake);
    expect((await h.db.query('SELECT * FROM surface_analyses')).rows).toHaveLength(1);
    const observation = await command('observation', {
      ...(await capture()),
      sources: [await upload('later-observation')],
      enrollmentId: e.id
    }, 'timeout-test');
    const job = (await claimSurfaceJob(deps))!;
    await processSurfaceJob(deps, job, async () => {
      throw new Error('SURFACE_WORKER_TIMEOUT');
    });
    const record = (await surfaceSummary(deps, actor, proofId)).observations.find(v => v.id === observation.id)!;
    expect(record.result).toBeNull();
    expect(record.errorCode).toBe('SURFACE_WORKER_TIMEOUT');
    expect(record.status).toBe('requested');
  });
  it('authenticated HTTP media delivery is scoped and byte-bound', async () => {
    await setup();
    const app = createServerApp({
      ...deps,
      testFixtures: true
    });
    const bytes = Buffer.from('HTTP protocol bytes');
    const init = await request(app).post(`/proofs/${proofId}/surfaces/media`).set(auth(actor)).set('Idempotency-Key', 'http-media').send({
      captureSessionId: sessionId,
      contentType: 'image/jpeg',
      byteSize: bytes.length,
      sha256: sha256Hex(bytes)
    });
    expect(init.status, JSON.stringify(init.body)).toBe(201);
    const mediaPath = new URL(init.body.upload.url).pathname;
    expect((await request(app).put(mediaPath).set(auth(actor)).set('Content-Type', 'image/jpeg').send(bytes)).status).toBe(200);
    expect((await request(app).get(mediaPath)).status).toBe(401);
    expect((await request(app).get(mediaPath).set(auth(actor))).status).toBe(200);
    expect((await request(app).put(mediaPath).set(auth(actor)).set('Content-Type', 'image/jpeg').send(Buffer.alloc(bytes.length))).status).toBe(422);
  });
  it('a worker cannot produce a qualified physical finding', async () => {
    await setup();
    await command('enrollment', await capture(), 'qualified-test');
    await dispatchSurfaceJobs(deps, async (...args) => ({
      ...(await fake(...args)),
      status: 'consistent',
      qualification: 'qualified'
    }));
    expect((await h.db.query('SELECT * FROM surface_analyses')).rows).toHaveLength(0);
  });
});
