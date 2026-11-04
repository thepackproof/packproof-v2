import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { openIsolatedTestDatabase } from './isolated-test-database.js';
import { migrate } from '../src/db/migrate.js';
import { insertUser } from '../src/domain/users.js';
import { MemoryObjectStore } from './memory-object-store.js';
import { sha256Hex } from '../src/hash.js';
import type { ObjectReference, StoredObject } from '../src/s3/object-store.js';
import { assertCommitExpectations, type CommitExpectations } from '../src/s3/commit-expectations.js';
import { createOrganization, setOrganizationEntitlement, createServicePrincipal, issuePartnerCredential, createIntegrationAccount, authenticatePartner, createDelegation, revokePartnerCredential, addOrganizationMember, PARTNER_SCOPES, type PartnerActor } from '../src/platform/organizations.js';
import { previewPartnerImport, commitPartnerImport, readPartnerImport, processPendingPartnerImports } from '../src/records/partner-imports.js';
import { listCanonicalSnapshotOptions, resolveCanonicalSnapshot, readCanonicalSnapshot, type CanonicalExportOwner } from '../src/records/partner-snapshots.js';
import { createCanonicalExport, readCanonicalExport, listCanonicalExports, processPendingCanonicalExports, openCanonicalExport } from '../src/records/partner-exports.js';
import { commitFulfillmentAndAttest, type TestHarness } from './helpers.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { getManifest } from '../src/domain/finalize.js';
import { requireRecordWorkspace } from '../src/records/access.js';
import { createLifecycleSnapshot } from '../src/domain/lifecycle-snapshots.js';
import { generateKeyPairSync, sign } from 'node:crypto';
import { appendAudit } from '../src/domain/audit.js';
import type { AppDependencies } from '../src/app.js';
import type { ManifestSigner } from '../src/domain/manifest-signing.js';
class ExactStore extends MemoryObjectStore {
    versions = new Map<string, StoredObject>();
    current = new Map<string, string>();
    sequence = 0;
    beforeDigest: (() => Promise<void>) | null = null;
    beforeRead: (() => Promise<void>) | null = null;
    missing = new Set<string>();
    async put(key: string, body: Buffer, type: string) {
        await super.put(key, body, type);
        const version = `v${++this.sequence}`;
        this.current.set(key, version);
        this.versions.set(`${key}:${version}`, { body: Buffer.from(body), contentType: type });
    }
    async putIfAbsent(key: string, body: Buffer, type: string) {
        if (await super.get(key))
            return { created: false };
        await this.put(key, body, type);
        return { created: true };
    }
    async get(key: string, ref?: ObjectReference) {
        if (this.missing.has(key))
            return null;
        const value = ref?.versionId ? this.versions.get(`${key}:${ref.versionId}`) : await super.get(key);
        return value ? { body: Buffer.from(value.body), contentType: value.contentType } : null;
    }
    async digest(key: string, ref?: ObjectReference) {
        await this.beforeDigest?.();
        const x = await this.get(key, ref);
        return x ? { sha256: sha256Hex(x.body), byteSize: x.body.length, contentType: x.contentType, versionId: ref?.versionId ?? this.current.get(key) } : null;
    }
    async head(key: string, ref?: ObjectReference) {
        const x = await this.get(key, ref);
        return x ? { byteSize: x.body.length, contentType: x.contentType, versionId: ref?.versionId ?? this.current.get(key) } : null;
    }
    async getStream(key: string, ref?: ObjectReference) {
        const x = await this.get(key, ref);
        if (!x)
            return null;
        const self = this;
        return { body: Readable.from((async function* () {
                for (let i = 0; i < x.body.length; i += 65536) {
                    await self.beforeRead?.();
                    yield x.body.subarray(i, i + 65536);
                }
            })(), { objectMode: false, highWaterMark: 65536 }), byteSize: x.body.length, contentType: x.contentType, versionId: ref?.versionId ?? this.current.get(key) };
    }
    async putStream(key: string, source: AsyncIterable<Uint8Array>, type: string, size: number) {
        const chunks = [];
        for await (const x of source)
            chunks.push(Buffer.from(x));
        const b = Buffer.concat(chunks);
        expect(b.length).toBe(size);
        await this.put(key, b, type);
        return { versionId: this.current.get(key) };
    }
    async commitUpload(key: string, expected: CommitExpectations = {}) {
        const x = await this.get(key, { versionId: expected.expectedVersionId });
        if (!x)
            return null;
        const digest = sha256Hex(x.body);
        assertCommitExpectations({ sha256: digest, byteSize: x.body.length, contentType: x.contentType, versionId: expected.expectedVersionId ?? this.current.get(key) }, expected);
        const committedKey = `${key.slice(0, key.lastIndexOf('/'))}/committed/sha256-${digest}`;
        await this.putIfAbsent(committedKey, x.body, x.contentType);
        return { key: committedKey, sha256: digest, byteSize: x.body.length, contentType: x.contentType, versionId: this.current.get(committedKey), stagingVersionId: expected.expectedVersionId ?? this.current.get(key) };
    }
}
let opened: Awaited<ReturnType<typeof openIsolatedTestDatabase>>, deps: AppDependencies, store: ExactStore;
let admin: string, owner: string, reviewer: string, operator: string, org: string, otherOrg: string, otherUser: string, account: string, member: string, full: PartnerActor, other: PartnerActor, readOnly: PartnerActor, delegated: PartnerActor, revocable: PartnerActor, revocableId: string;
let proof: string, manifestId: string, evidenceId: string;
let time = Date.now();
const clock = { now: () => new Date(time) }, expires = () => new Date(time + 86400000).toISOString(), csv = (ref: string, quantity = '1') => `Shipment reference,Description,Quantity,Tracking number,Shipment date\r\n${ref},Parcel,${quantity},000007,2026-11-04\r\n`, input = (text: string) => ({ integrationAccountId: account, operatorMembershipId: member, csv: text, timeZone: 'America/New_York', sourceName: 'Warehouse CSV' });
const po = (actor = full): CanonicalExportOwner => ({ kind: 'PARTNER', actor });
async function credential(userId: string, organizationId: string, scopes: readonly string[]) {
    const principal = await createServicePrincipal(opened.db, clock, userId, organizationId, { name: 'Import and export service' }, 'setup');
    return issuePartnerCredential(opened.db, clock, userId, organizationId, principal.id, { scopes: [...scopes], expiresAt: expires() }, 'setup');
}
async function preview(ref: string, key = ref) {
    return (await previewPartnerImport(deps, full, key, input(csv(ref)))).value;
}
async function commit(id: string, version: string, partial = false, actor = full) {
    await commitPartnerImport(deps, actor, id, `commit-${id}-${partial}`, { previewVersion: version, importValidRows: partial });
    await processPendingPartnerImports(deps);
    return readPartnerImport(deps, actor, id);
}
beforeAll(async () => {
    vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED', 'true');
    opened = await openIsolatedTestDatabase();
    await migrate(opened.db);
    store = new ExactStore();
    [admin, owner, otherUser, reviewer, operator] = await Promise.all(Array.from({ length: 5 }, () => insertUser(opened.db, clock)));
    await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')", [admin, clock.now().toISOString()]);
    org = (await createOrganization(opened.db, clock, admin, { kind: 'MERCHANT', name: 'Service CSV', ownerUserId: owner }, 'setup')).id;
    otherOrg = (await createOrganization(opened.db, clock, admin, { kind: 'MERCHANT', name: 'Private tenant', ownerUserId: otherUser }, 'setup')).id;
    const partnerOrg = (await createOrganization(opened.db, clock, admin, { kind: 'PARTNER', name: 'Delegated service' }, 'setup')).id;
    for (const id of [org, otherOrg, partnerOrg])
        await setOrganizationEntitlement(opened.db, clock, admin, id, { enabled: true }, 'setup');
    await addOrganizationMember(opened.db, clock, owner, org, { userId: reviewer, role: 'REVIEWER' }, 'setup');
    await addOrganizationMember(opened.db, clock, owner, org, { userId: operator, role: 'OPERATOR' }, 'setup');
    member = (await opened.db.query<{
        id: string;
    }>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2', [org, owner])).rows[0].id;
    account = (await createIntegrationAccount(opened.db, clock, owner, org, { provider: 'csv', externalAccountId: 'canonical-csv-source' }, 'setup')).id;
    const token = await credential(owner, org, PARTNER_SCOPES);
    full = await authenticatePartner(opened.db, clock, `Bearer ${token.token}`, org, undefined, 'request');
    const otherToken = await credential(otherUser, otherOrg, PARTNER_SCOPES);
    other = await authenticatePartner(opened.db, clock, `Bearer ${otherToken.token}`, otherOrg, undefined, 'request');
    const readToken = await credential(owner, org, ['exports:read', 'proofs:read']);
    readOnly = await authenticatePartner(opened.db, clock, `Bearer ${readToken.token}`, org, undefined, 'request');
    const r = await credential(owner, org, PARTNER_SCOPES);
    revocableId = r.id;
    revocable = await authenticatePartner(opened.db, clock, `Bearer ${r.token}`, org, undefined, 'request');
    const p = await credential(admin, partnerOrg, PARTNER_SCOPES), grant = await createDelegation(opened.db, clock, owner, org, { partnerOrganizationId: partnerOrg, scopes: [...PARTNER_SCOPES], operatorUserIds: [owner], expiresAt: expires() }, 'setup');
    delegated = await authenticatePartner(opened.db, clock, `Bearer ${p.token}`, org, grant.id, 'request');
    deps = { db: opened.db, clock, objectStore: store, devAuth: true, testFixtures: true } as AppDependencies;
}, 90000);
afterAll(async () => {
    await opened?.close();
    vi.unstubAllEnvs();
});
it('preserves exact CSV bytes, mapping timezone and service origin without impersonating the assigned operator', async () => {
    const original = '\uFEFF' + csv('0000123'), first = await previewPartnerImport(deps, full, 'first', input(original));
    expect(first.value).toMatchObject({ state: 'previewed', timeZone: 'America/New_York', original: { sha256: sha256Hex(original), versionBound: true } });
    expect(first.value.rows[0].normalized).toMatchObject({ shipmentReference: '0000123', trackingNumber: '000007' });
    const again = await previewPartnerImport(deps, full, 'first', input(original));
    expect(again.replayed).toBe(true);
    expect(again.value.id).toBe(first.value.id);
    await expect(previewPartnerImport(deps, full, 'first', input(csv('different')))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const done = await commit(first.value.id, first.value.previewVersion);
    expect(done.state).toBe('succeeded');
    proof = done.recordIds[0];
    const ownership = (await opened.db.query<{
        created_by: string;
        origin_principal_id: string;
        origin_user_id: string | null;
        seller: string;
    }>(`SELECT t.created_by,o.origin_principal_id,o.origin_user_id,p.user_id seller FROM proofs f JOIN transactions t ON t.id=f.transaction_id JOIN platform_proof_ownership o ON o.proof_id=f.id JOIN proof_participants p ON p.proof_id=f.id AND p.role='SELLER' WHERE f.id=$1`, [proof])).rows[0];
    expect(ownership).toEqual({ created_by: full.actorUserId, origin_principal_id: full.principalId, origin_user_id: null, seller: owner });
    const row = (await opened.db.query<{
        original_object_key: string;
        original_version_id: string;
    }>('SELECT original_object_key,original_version_id FROM partner_import_jobs WHERE id=$1', [done.id])).rows[0];
    expect((await store.get(row.original_object_key, { versionId: row.original_version_id }))?.body).toEqual(Buffer.from(original));
});
it('keeps source identity stable across file changes and demands explicit partial consent and preview version', async () => {
    const p = await preview('0000123', 'stable-duplicate');
    expect(p.counts.duplicate).toBe(1);
    expect(p.recordIds).toEqual([proof]);
    const conflict = (await previewPartnerImport(deps, full, 'stable-conflict', input(csv('0000123', '2')))).value;
    expect(conflict.counts.ambiguous).toBe(1);
    const mixed = (await previewPartnerImport(deps, full, 'partial', input(csv('PARTIAL') + 'BAD,Parcel,nope,,2026-11-04\r\n'))).value;
    await expect(commitPartnerImport(deps, full, mixed.id, 'wrong-version', { previewVersion: 'wrong', importValidRows: true })).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_CHANGED' });
    await expect(commitPartnerImport(deps, full, mixed.id, 'not-consented', { previewVersion: mixed.previewVersion, importValidRows: false })).rejects.toMatchObject({ code: 'IMPORT_HAS_ROW_ERRORS' });
    const done = await commit(mixed.id, mixed.previewVersion, true);
    expect(done.state).toBe('partially_succeeded');
    expect(done.counts.imported).toBe(1);
    expect(done.counts.invalid).toBe(1);
    expect((await opened.db.query('SELECT proof_id FROM platform_external_bindings WHERE resource_type=\'SHIPMENT\' AND external_id=\'0000123\'')).rows).toHaveLength(1);
});
it('returns the accepted Proof for every identical source row within one file',async()=>{
    const p=(await previewPartnerImport(deps,full,'in-file-duplicate',input(csv('INFILE')+'INFILE,Parcel,1,000007,2026-11-04\r\n'))).value;
    const done=await commit(p.id,p.previewVersion);
    expect(done.counts).toMatchObject({imported:1,duplicate:1});
    expect(done.rows[0].proofId).toBeTruthy();
    expect(done.rows[1].proofId).toBe(done.rows[0].proofId);
});
it('requires dedicated import scopes and current source, tenant, operator and location authority', async () => {
    await expect(previewPartnerImport(deps, readOnly, 'denied', input(csv('DENIED')))).rejects.toMatchObject({ httpStatus: 403 });
    const p = await preview('TENANT');
    await expect(readPartnerImport(deps, other, p.id)).rejects.toMatchObject({ code: 'IMPORT_NOT_FOUND' });
    await expect(previewPartnerImport(deps, full, 'cross-account', { ...input(csv('CROSS')), integrationAccountId: (await createIntegrationAccount(opened.db, clock, otherUser, otherOrg, { provider: 'csv', externalAccountId: 'other' }, 'setup')).id })).rejects.toMatchObject({ code: 'INTEGRATION_NOT_FOUND' });
    await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)', ['location-import', org, 'Warehouse', clock.now().toISOString()]);
    await expect(previewPartnerImport(deps, delegated, 'located', { ...input('Shipment reference,Location\nLOCATED,location-import\n') })).rejects.toMatchObject({ code: 'LOCATION_GRANT_REQUIRED' });
});
it('fences an expired worker after external source verification and resumes the same receipt safely', async () => {
    const p = await preview('LEASE');
    await commitPartnerImport(deps, full, p.id, 'lease-commit', { previewVersion: p.previewVersion, importValidRows: false });
    let once = true;
    store.beforeDigest = async () => {
        if (once) {
            once = false;
            time += 120001;
        }
    };
    expect(await processPendingPartnerImports(deps,1)).toEqual({ processed: 0, failed: 1 });
    expect((await opened.db.query('SELECT proof_id FROM partner_import_rows WHERE import_id=$1', [p.id])).rows[0].proof_id).toBeNull();
    store.beforeDigest = null;
    time++;
    await processPendingPartnerImports(deps);
    expect((await readPartnerImport(deps, full, p.id)).state).toBe('succeeded');
});
it('offers only existing canonical selections and rejects cross-tenant, reviewer and operator export authority', async () => {
    const committed = await commitFulfillmentAndAttest({ db: opened.db, clock, objectStore: store } as TestHarness, owner, proof);
    evidenceId = committed.evidenceId;
    await finalizeProof(opened.db, clock, owner, proof);
    manifestId = (await getManifest(opened.db, owner, proof)).manifestId;
    const opts = await listCanonicalSnapshotOptions(deps, po(), proof);
    expect(opts.snapshots).toEqual([expect.objectContaining({ kind: 'CORE', snapshotId: manifestId, scope: 'FROZEN_CORE_ONLY' })]);
    expect(await readCanonicalSnapshot(deps, po(), proof, 'CORE', manifestId)).toMatchObject({ operationalSnapshot: false, record: { signaturePresent: false } });
    await expect(resolveCanonicalSnapshot(deps, po(other), proof, 'CORE', manifestId)).rejects.toMatchObject({ httpStatus: 404 });
    for (const userId of [reviewer, operator]) {
        const workspace = await requireRecordWorkspace(opened.db, userId, org, 'sandbox');
        await expect(listCanonicalSnapshotOptions(deps, { kind: 'HUMAN', workspace }, proof)).rejects.toMatchObject({ httpStatus: userId===operator?404:403 });
    }
    await expect(resolveCanonicalSnapshot(deps, po(), proof, 'CORE', 'wrong')).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
});
it('accepts a durable fixed CORE job, preserves its exact bytes and excludes later audit and operational projections', async () => {
    await expect(createCanonicalExport(deps, po(readOnly), 'no-create', { proofId: proof, kind: 'CORE', snapshotId: manifestId })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(createCanonicalExport(deps, po(), 'bad-date', { proofId: proof, kind: 'CORE', snapshotId: manifestId, expiresAt: 'invalid' })).rejects.toMatchObject({ code: 'INVALID_EXPORT_EXPIRY' });
    const accepted = await createCanonicalExport(deps, po(), 'canonical-one', { proofId: proof, kind: 'CORE', snapshotId: manifestId });
    expect(accepted.value).toMatchObject({ state: 'queued', downloadAvailable: false, expiryMeaning: 'STORED_DOWNLOAD_AVAILABILITY' });
    await appendAudit(opened.db, { proofId: proof, actorUserId: owner, eventType: 'LATER_PRIVATE_MARKER', eventData: { secret: 'not-in-core' }, at: clock.now() });
    await expect(openCanonicalExport(deps, po(), accepted.value.id)).rejects.toMatchObject({ code: 'EXPORT_NOT_READY' });
    expect(await processPendingCanonicalExports(deps)).toEqual({ processed: 1, failed: 0 });
    const ready = await readCanonicalExport(deps, po(), accepted.value.id);
    expect(ready).toMatchObject({ state: 'ready', downloadAvailable: true, omissionPolicy: 'REQUIRE_COMPLETE_ORIGINALS', operationalSnapshot: false, shareCreated: false });
    const result = await openCanonicalExport(deps, po(), ready.id), chunks = [];
    for await (const c of result.body)
        chunks.push(Buffer.from(c));
    const bytes = Buffer.concat(chunks);
    expect(sha256Hex(bytes)).toBe(ready.artifact?.sha256);
    expect(bytes.toString()).toContain('FROZEN_CORE_ONLY');
    expect(bytes.toString()).not.toContain('LATER_PRIVATE_MARKER');
    expect(bytes.toString()).not.toContain('not-in-core');
    expect(JSON.stringify(ready)).not.toContain('object_key');
    expect((await createCanonicalExport(deps, po(), 'canonical-one', { proofId: proof, kind: 'CORE', snapshotId: manifestId })).value.id).toBe(ready.id);
    await expect(readCanonicalExport(deps, po(other), ready.id)).rejects.toMatchObject({ code: 'EXPORT_NOT_FOUND' });
    expect((await listCanonicalExports(deps, po(other))).exports).toEqual([]);
});
it('fails closed for a missing selected original instead of declaring an omission-complete export', async () => {
    const source = (await opened.db.query<{
        object_key: string;
    }>('SELECT object_key FROM evidence WHERE id=$1', [evidenceId])).rows[0];
    store.missing.add(source.object_key);
    const accepted = await createCanonicalExport(deps, po(), 'missing-original', { proofId: proof, kind: 'CORE', snapshotId: manifestId });
    expect(await processPendingCanonicalExports(deps)).toEqual({ processed: 0, failed: 1 });
    expect(await readCanonicalExport(deps, po(), accepted.value.id)).toMatchObject({ state: 'action_needed', lastErrorCode: 'EXPORT_ORIGINAL_UNAVAILABLE', downloadAvailable: false });
    store.missing.delete(source.object_key);
});
it('reuses an already signed lifecycle inventory for an organization administrator without creating signing or participant rights', async () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), signer: ManifestSigner = { signManifest: async (x) => ({ algorithm: 'ECDSA_SHA_256', keyId: 'lifecycle-fixture', signedAt: clock.now().toISOString(), signatureBase64: sign('sha256', Buffer.from(x.canonicalJson), keys.privateKey).toString('base64') }) };
    const snapshot = await createLifecycleSnapshot(opened.db, clock, signer, owner, proof, { operationId: 'existing-lifecycle-selection' });
    await addOrganizationMember(opened.db, clock, owner, org, { userId: admin, role: 'ADMIN' }, 'setup');
    const workspace = await requireRecordWorkspace(opened.db, admin, org, 'sandbox'), human: CanonicalExportOwner = { kind: 'HUMAN', workspace };
    expect((await readCanonicalSnapshot(deps, human, proof, 'LIFECYCLE', snapshot.snapshotId)).selection).toMatchObject({ kind: 'LIFECYCLE', snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 });
    expect((await opened.db.query('SELECT id FROM proof_participants WHERE proof_id=$1 AND user_id=$2', [proof, admin])).rows).toHaveLength(0);
    const accepted = await createCanonicalExport(deps, human, 'human-lifecycle', { proofId: proof, kind: 'LIFECYCLE', snapshotId: snapshot.snapshotId });
    expect(await processPendingCanonicalExports(deps)).toEqual({ processed: 1, failed: 0 });
    expect(await readCanonicalExport(deps, human, accepted.value.id)).toMatchObject({ state: 'ready', selection: { kind: 'LIFECYCLE', scope: 'SEALED_COMMERCE_LIFECYCLE' } });
});
it('rechecks credential authority after storage I/O and prevents completion or download after revocation', async () => {
    const accepted = await createCanonicalExport(deps, po(revocable), 'revoke-export', { proofId: proof, kind: 'CORE', snapshotId: manifestId });
    let revoked = false;
    store.beforeDigest = async () => {
        if (!revoked) {
            revoked = true;
            await revokePartnerCredential(opened.db, clock, owner, org, revocableId, 'setup');
        }
    };
    expect(await processPendingCanonicalExports(deps)).toEqual({ processed: 0, failed: 1 });
    store.beforeDigest = null;
    expect((await opened.db.query<{
        state: string;
    }>('SELECT state FROM record_canonical_export_jobs WHERE id=$1', [accepted.value.id])).rows[0].state).toBe('action_needed');
    await expect(readCanonicalExport(deps, po(revocable), accepted.value.id)).rejects.toMatchObject({ httpStatus: 403 });
});
it('separates stored download expiry from sharing and keeps immutable job selections', async () => {
    const body = { proofId: proof, kind: 'CORE', snapshotId: manifestId, expiresAt: new Date(time + 1000).toISOString() }, accepted = await createCanonicalExport(deps, po(), 'expiry', body);
    await expect(opened.db.query("UPDATE record_canonical_export_jobs SET selection='{}'::jsonb WHERE id=$1", [accepted.value.id])).rejects.toThrow(/immutable/);
    time += 1001;
    await expect(openCanonicalExport(deps, po(), accepted.value.id)).rejects.toMatchObject({ code: 'EXPORT_EXPIRED' });
    expect(await readCanonicalExport(deps, po(), accepted.value.id)).toMatchObject({ state: 'expired', shareCreated: false, downloadAvailable: false });
    expect(await createCanonicalExport(deps, po(), 'expiry', body)).toMatchObject({ replayed: true, value: { id: accepted.value.id, state: 'expired' } });
    await expect(createCanonicalExport(deps, po(), 'new-expired-key', body)).rejects.toMatchObject({ code: 'INVALID_EXPORT_EXPIRY' });
});
