import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { openIsolatedTestDatabase } from './isolated-test-database.js';
import { migrate } from '../src/db/migrate.js';
import { insertUser } from '../src/domain/users.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { createOrganization, setOrganizationEntitlement } from '../src/platform/organizations.js';
import { requireRecordWorkspace, type RecordWorkspace } from '../src/records/access.js';
import { readRecordRequirements, listRecords, addRequirement, addRecordEntity, ensureRecordState } from '../src/records/service.js';
import { initializeSourceArtifact, receiveSourceArtifactBytes, completeSourceArtifact, processSourceArtifactCompletions, type SourceArtifactActor } from '../src/records/source-artifacts.js';
import { LocalObjectStore } from '../src/s3/local-object-store.js';
import { sha256Hex } from '../src/hash.js';
let opened: Awaited<ReturnType<typeof openIsolatedTestDatabase>>, folder: string, store: LocalObjectStore, w: RecordWorkspace, actor: SourceArtifactActor, proof: string, owner: string;
let time = Date.now(), index = 0;
const clock = { now: () => new Date(time) }, bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(120)]);
beforeAll(async () => {
    vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED', 'true');
    vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY', randomBytes(32).toString('base64'));
    opened = await openIsolatedTestDatabase();
    await migrate(opened.db);
    folder = await mkdtemp(join(tmpdir(), 'source-requirements-'));
    store = new LocalObjectStore(folder, 'http://example.test', 'test');
    const admin = await insertUser(opened.db, clock);
    owner = await insertUser(opened.db, clock);
    await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')", [admin, clock.now().toISOString()]);
    const org = (await createOrganization(opened.db, clock, admin, { kind: 'MERCHANT', name: 'Evidence requirements', ownerUserId: owner }, 'test')).id;
    await setOrganizationEntitlement(opened.db, clock, admin, org, { enabled: true }, 'test');
    w = await requireRecordWorkspace(opened.db, owner, org, 'sandbox');
    actor = { kind: 'human', workspace: w };
    const t = await createTransaction(opened.db, clock, owner, { itemTitle: 'Source requirement cohort' });
    proof = (await createOrGetProof(opened.db, clock, owner, t.transactionId, { participationPolicy: 'COUNTERPARTY_OPTIONAL' })).proofId;
    await opened.db.query('INSERT INTO platform_proof_ownership(proof_id,merchant_id,environment,operator_membership_id,origin_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6)', [proof, org, 'sandbox', w.membershipId, owner, clock.now().toISOString()]);
    await ensureRecordState(opened.db, clock, w, proof);
}, 90000);
afterAll(async () => {
    await opened?.close();
    if (folder) {
        const target = resolve(folder), rel = relative(resolve(tmpdir()), target);
        if (!rel || rel.startsWith('..') || rel.includes(':'))
            throw Error('Unsafe fixture cleanup');
        await rm(target, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
});
async function requirement(types: string[], subject = proof, dueAt: string | null = null) {
    return addRequirement(opened.db, clock, w, proof, { title: `Requirement ${++index}`, stage: 'handoff', templateVersion: 'source-optin/v1', acceptedEvidenceTypes: types, subjectId: subject, dueAt, reason: 'Explicitly request this evidence class' });
}
async function upload(subjectId = proof) {
    const s = await initializeSourceArtifact(opened.db, clock, actor, { proofId: proof, sourceArtifactId: `file-${++index}`, subjectId, filename: 'original.png', contentType: 'image/png', byteSize: bytes.length, reportedAt: '2020-01-01T00:00:00Z' }, `source-${index}`);
    await receiveSourceArtifactBytes(opened.db, clock, store, actor, s.sessionId, Readable.from([bytes]), bytes.length);
    return { session: s, operation: await completeSourceArtifact(opened.db, clock, actor, s.sessionId) };
}
it('requires an accepted exact source result and explicit SOURCE_ARTIFACT opt-in; it never replaces capture evidence', async () => {
    const opt = await requirement(['SOURCE_ARTIFACT']), capture = await requirement(['FULFILLMENT_CAPTURE']), pending = await upload();
    let reqs = await readRecordRequirements(opened.db, clock, proof);
    expect(reqs.find(r => r.id === opt.id)).toMatchObject({ status: 'not_yet_due', evidenceIds: [] });
    await processSourceArtifactCompletions(opened.db, clock, store);
    reqs = await readRecordRequirements(opened.db, clock, proof);
    expect(reqs.find(r => r.id === opt.id)).toMatchObject({ status: 'satisfied', evidenceIds: [pending.session.artifactId] });
    expect(reqs.find(r => r.id === capture.id)).toMatchObject({ status: 'not_yet_due', evidenceIds: [] });
    expect((await opened.db.query('SELECT id FROM evidence WHERE proof_id=$1', [proof])).rows).toHaveLength(0);
});
it('matches immutable source subjects and keeps detail, cohort counts and ready filters consistent', async () => {
    const entity = await addRecordEntity(opened.db, clock, w, proof, { kind: 'package', externalReference: 'PKG-1', attributes: {}, reason: 'Track package evidence' }), child = await requirement(['SOURCE_ARTIFACT'], entity.id, new Date(time + 1000).toISOString());
    let reqs = await readRecordRequirements(opened.db, clock, proof);
    expect(reqs.find(r => r.id === child.id)?.evidenceIds).toEqual([]);
    time += 1001;
    const missing = await listRecords(opened.db, clock, w, { view: 'missing' });
    expect(missing.records.find(r => r.id === proof)?.coverage.missing).toBe(1);
    await upload(entity.id);
    await processSourceArtifactCompletions(opened.db, clock, store);
    reqs = await readRecordRequirements(opened.db, clock, proof);
    expect(reqs.find(r => r.id === child.id)).toMatchObject({ status: 'missing', evidenceIds: [] });
    const noDeadline = await requirement(['SOURCE_ARTIFACT'], entity.id);
    expect((await readRecordRequirements(opened.db, clock, proof)).find(r => r.id === noDeadline.id)?.status).toBe('satisfied');
    expect((await listRecords(opened.db, clock, w, { view: 'all' })).records.find(r => r.id === proof)?.coverage).toMatchObject({ satisfied: 2, missing: 1 });
});
it('uses server acceptance deadlines instead of reported dates or old metadata reservation times', async () => {
    const late = await requirement(['SOURCE_ARTIFACT'], proof, new Date(time - 1000).toISOString());
    expect((await readRecordRequirements(opened.db, clock, proof)).find(r => r.id === late.id)?.status).toBe('satisfied');
    const newEntity = await addRecordEntity(opened.db, clock, w, proof, { kind: 'package', externalReference: 'LATE', attributes: {}, reason: 'Track late evidence' }), lateOnly = await requirement(['SOURCE_ARTIFACT'], newEntity.id, new Date(time - 1000).toISOString());
    await upload(newEntity.id);
    await processSourceArtifactCompletions(opened.db, clock, store);
    expect((await readRecordRequirements(opened.db, clock, proof)).find(r => r.id === lateOnly.id)).toMatchObject({ status: 'missing', evidenceIds: [] });
    const core = await requirement(['FULFILLMENT_CAPTURE'], proof, new Date(time - 1000).toISOString());
    await opened.db.query("INSERT INTO evidence(id,proof_id,submitted_by,object_key,content_type,validation_status,evidence_type,created_at,committed_at,byte_size,sha256) VALUES('late-core',$1,$2,'fixture/committed/source','image/png','COMMITTED','FULFILLMENT_CAPTURE',$3,$4,$5,$6)", [proof, owner, new Date(time - 2000).toISOString(), clock.now().toISOString(), bytes.length, sha256Hex(bytes)]);
    expect((await readRecordRequirements(opened.db, clock, proof)).find(r => r.id === core.id)).toMatchObject({ status: 'missing', evidenceIds: [] });
    expect((await listRecords(opened.db, clock, w, { view: 'missing' })).records.find(r => r.id === proof)?.coverage.missing).toBe(3);
});
