import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { guardAuthorizedStream } from '../domain/authorized-stream.js';
import { exportEvidencePackageStream } from '../domain/evidence-review.js';
import { exportProofEnvelope } from '../integrity/envelope-access.js';
import { auditOrganization, reauthorizePartner, strictBody, type PartnerActor } from '../platform/organizations.js';
import { idempotent } from '../platform/idempotency.js';
import { textField } from '../platform/tenants.js';
import { requireRecordWorkspace, type RecordWorkspace } from './access.js';
import { authorizeCanonicalExport, resolveCanonicalSnapshot, type CanonicalExportOwner, type CanonicalSnapshotSelection } from './partner-snapshots.js';
type Deps = Pick<AppDependencies, 'db' | 'clock' | 'objectStore' | 'envelopes' | 'devAuth'>;
type State = 'queued' | 'running' | 'ready' | 'action_needed' | 'expired';
interface ExportJob {
    id: string;
    organization_id: string;
    environment: 'sandbox' | 'live';
    owner_kind: 'PARTNER' | 'HUMAN';
    actor: PartnerActor | RecordWorkspace;
    actor_user_id: string;
    principal_id: string | null;
    credential_id: string | null;
    delegation_id: string | null;
    membership_id: string | null;
    proof_id: string;
    selection: CanonicalSnapshotSelection;
    selection_sha256: string;
    state: State;
    received_at: Date | string;
    updated_at: Date | string;
    expires_at: Date | string;
    artifact_time: Date | string;
    ready_at: Date | string | null;
    object_key: string | null;
    object_version_id: string | null;
    artifact_sha256: string | null;
    artifact_byte_size: number | string | null;
    lease_token: string | null;
    lease_expires_at: Date | string | null;
    attempts: number;
    last_error_code: string | null;
}
const MAX_BYTES = 220 * 1024 * 1024, iso = (x: Date | string) => new Date(x).toISOString();
function ownerOf(j: ExportJob): CanonicalExportOwner {
    return j.owner_kind === 'PARTNER' ? { kind: 'PARTNER', actor: j.actor as PartnerActor } : { kind: 'HUMAN', workspace: j.actor as RecordWorkspace };
}
function ownerIdentity(owner: CanonicalExportOwner) {
    return owner.kind === 'PARTNER' ? { organizationId: owner.actor.merchantId, environment: owner.actor.environment, userId: owner.actor.actorUserId, principalId: owner.actor.principalId, credentialId: owner.actor.credentialId, delegationId: owner.actor.delegationGrantId, membershipId: null, tenantId: owner.actor.tenantId } : { organizationId: owner.workspace.organizationId, environment: owner.workspace.environment, userId: owner.workspace.userId, principalId: null, credentialId: null, delegationId: null, membershipId: owner.workspace.membershipId, tenantId: owner.workspace.tenantId };
}
function assertOwner(owner: CanonicalExportOwner, j: ExportJob) {
    const a = ownerIdentity(owner);
    if (j.owner_kind !== owner.kind || a.organizationId !== j.organization_id || a.environment !== j.environment || (owner.kind === 'PARTNER' && (a.principalId !== j.principal_id || a.credentialId !== j.credential_id || a.delegationId !== j.delegation_id)) || (owner.kind === 'HUMAN' && (a.userId !== j.actor_user_id || a.membershipId !== j.membership_id)))
        throw new DomainError('EXPORT_NOT_FOUND', 'Export not found', 404);
}
async function load(db: Database, id: string, lock = false) {
    const j = (await db.query<ExportJob>(`SELECT * FROM record_canonical_export_jobs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!j)
        throw new DomainError('EXPORT_NOT_FOUND', 'Export not found', 404);
    return j;
}
async function authorize(deps: Deps, db: Database, owner: CanonicalExportOwner, j: ExportJob, create = false) {
    assertOwner(owner, j);
    if (owner.kind === 'PARTNER' && create)
        await reauthorizePartner(db, deps.clock, owner.actor, 'exports:create');
    return authorizeCanonicalExport(deps, db, owner, j.proof_id);
}
function view(deps: Deps, j: ExportJob) {
    const expired = new Date(j.expires_at).getTime() <= deps.clock.now().getTime(), state = expired ? 'expired' : j.state;
    return { id: j.id, operationId: j.id, kind: 'canonical_package', organizationId: j.organization_id, environment: j.environment, proofId: j.proof_id, selection: j.selection, selectionSha256: j.selection_sha256, state, receivedAt: iso(j.received_at), updatedAt: iso(j.updated_at), expiresAt: iso(j.expires_at), expiryMeaning: 'STORED_DOWNLOAD_AVAILABILITY', readyAt: j.ready_at ? iso(j.ready_at) : null, downloadAvailable: state === 'ready', artifact: state === 'ready' ? { sha256: j.artifact_sha256, byteSize: Number(j.artifact_byte_size), contentType: 'application/zip', versionBound: true } : null, omissionPolicy: 'REQUIRE_COMPLETE_ORIGINALS', operationalSnapshot: false, shareCreated: false, lastErrorCode: j.last_error_code };
}
export async function readCanonicalExport(deps: Deps, owner: CanonicalExportOwner, id: string) {
    const j = await load(deps.db, id);
    await authorize(deps, deps.db, owner, j);
    const result = view(deps, j);
    await authorize(deps, deps.db, owner, j);
    return result;
}
export async function listCanonicalExports(deps: Deps, owner: CanonicalExportOwner) {
    const a = ownerIdentity(owner);
    if (owner.kind === 'PARTNER')
        await reauthorizePartner(deps.db, deps.clock, owner.actor, 'exports:read');
    else {
        const current = await requireRecordWorkspace(deps.db, a.userId, a.organizationId, a.environment);
        if (!['OWNER', 'ADMIN'].includes(current.role))
            throw new DomainError('RECORD_EXPORT_PERMISSION_REQUIRED', 'An organization owner or administrator must list canonical exports', 403);
    }
    const rs = (await deps.db.query<ExportJob>(`SELECT * FROM record_canonical_export_jobs WHERE organization_id=$1 AND environment=$2 AND owner_kind=$3 AND actor_user_id=$4 AND principal_id IS NOT DISTINCT FROM $5 AND credential_id IS NOT DISTINCT FROM $6 AND delegation_id IS NOT DISTINCT FROM $7 AND membership_id IS NOT DISTINCT FROM $8 ORDER BY received_at DESC,id DESC LIMIT 100`, [a.organizationId, a.environment, owner.kind, a.userId, a.principalId, a.credentialId, a.delegationId, a.membershipId])).rows;
    const selected:ExportJob[]=[];
    for (const j of rs) {
        try {
            await authorize(deps, deps.db, owner, j);
            selected.push(j);
        }
        catch (e) {
            if (!(e instanceof DomainError) || ![403, 404].includes(e.httpStatus))
                throw e;
        }
    }
    const exports=[];
    for(const j of selected){
        try{await authorize(deps,deps.db,owner,j);exports.push(view(deps,j));}
        catch(e){if(!(e instanceof DomainError)||![403,404].includes(e.httpStatus))throw e;}
    }
    if (owner.kind === 'PARTNER')
        await reauthorizePartner(deps.db, deps.clock, owner.actor, 'exports:read');
    else
        await requireRecordWorkspace(deps.db, a.userId, a.organizationId, a.environment);
    return { exports, limit: 100 };
}
export async function createCanonicalExport(deps: Deps, owner: CanonicalExportOwner, key: unknown, input: unknown) {
    const b = strictBody(input, ['proofId', 'kind', 'snapshotId', 'expiresAt']), proofId = textField(b.proofId, 'proofId'), snapshotId = textField(b.snapshotId, 'snapshotId'), a = ownerIdentity(owner), now = deps.clock.now(), expiry = b.expiresAt === undefined ? now.getTime() + 86400000 : typeof b.expiresAt === 'string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(b.expiresAt) ? Date.parse(b.expiresAt) : NaN;
    const expiresAt = Number.isFinite(expiry) ? new Date(expiry).toISOString() : null;
    if (owner.kind === 'PARTNER')
        await reauthorizePartner(deps.db, deps.clock, owner.actor, 'exports:create');
    const selection = await resolveCanonicalSnapshot(deps, owner, proofId, b.kind, snapshotId);
    const result = await idempotent(deps.db, deps.clock, a.tenantId, `canonical-export:${owner.kind}:${a.userId}:${a.credentialId ?? a.membershipId}:${a.delegationId ?? ''}`, key, b, async (tx) => {
        if (!expiresAt || expiry <= deps.clock.now().getTime() || expiry > deps.clock.now().getTime() + 7 * 86400000)
            throw new DomainError('INVALID_EXPORT_EXPIRY', 'Use a future download expiry within seven days', 400);
        if (owner.kind === 'PARTNER')
            await reauthorizePartner(tx, deps.clock, owner.actor, 'exports:create');
        await authorizeCanonicalExport(deps, tx, owner, proofId);
        await tx.query('SELECT pg_advisory_xact_lock(1347438147,hashtext($1))', [a.organizationId]);
        const n = (await tx.query<{
            n: string;
        }>("SELECT COUNT(*)::text n FROM record_canonical_export_jobs WHERE organization_id=$1 AND environment=$2 AND state IN ('queued','running') AND expires_at>$3", [a.organizationId, a.environment, deps.clock.now().toISOString()])).rows[0];
        if (Number(n.n) >= 10)
            throw new DomainError('EXPORT_LIMIT_REACHED', 'Wait for the current canonical exports to finish', 409);
        const id = newId('canonical_export'), at = deps.clock.now().toISOString();
        await tx.query(`INSERT INTO record_canonical_export_jobs(id,organization_id,environment,owner_kind,actor,actor_user_id,principal_id,credential_id,delegation_id,membership_id,proof_id,selection,selection_sha256,state,received_at,updated_at,expires_at,artifact_time) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,'queued',$14,$14,$15,$14)`, [id, a.organizationId, a.environment, owner.kind, JSON.stringify(owner.kind === 'PARTNER' ? owner.actor : owner.workspace), a.userId, a.principalId, a.credentialId, a.delegationId, a.membershipId, proofId, JSON.stringify(selection), sha256Hex(canonicalize(selection)), at, expiresAt]);
        await auditOrganization(tx, deps.clock, { ...(owner.kind === 'PARTNER' ? { actor: owner.actor } : { userId: a.userId, merchantId: a.organizationId }), requestId: id, operation: 'CANONICAL_EXPORT_ACCEPTED', resourceId: proofId });
        return { id };
    });
    return { ...result, value: await readCanonicalExport(deps, owner, result.value.id) };
}
function assertLease(deps: Deps, j: ExportJob, token: string) {
    if (j.state !== 'running' || j.lease_token !== token || !j.lease_expires_at || new Date(j.lease_expires_at).getTime() <= deps.clock.now().getTime())
        throw new DomainError('EXPORT_LEASE_LOST', 'This worker no longer owns the canonical export lease', 409);
    if (new Date(j.expires_at).getTime() <= deps.clock.now().getTime())
        throw new DomainError('EXPORT_EXPIRED', 'The download availability window expired', 410);
}
/** Private temp spool bounds memory. SQL marks ready only after a verified committed version exists. */
export async function processPendingCanonicalExports(deps: Deps, limit = 2) {
    let processed = 0, failed = 0;
    await deps.db.query("UPDATE record_canonical_export_jobs SET state='expired',updated_at=$1,lease_token=NULL,lease_expires_at=NULL WHERE state<>'expired' AND expires_at<=$1", [deps.clock.now().toISOString()]);
    for (let i = 0; i < Math.max(1, Math.min(limit, 10)); i++) {
        const token = newId('export_lease'), j = await deps.db.transaction(async (tx) => {
            const row = (await tx.query<ExportJob>("SELECT * FROM record_canonical_export_jobs WHERE (state='queued' OR (state='running' AND lease_expires_at<$1)) AND expires_at>$1 ORDER BY received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED", [deps.clock.now().toISOString()])).rows[0];
            if (!row)
                return null;
            await tx.query("UPDATE record_canonical_export_jobs SET state='running',attempts=attempts+1,lease_token=$2,lease_expires_at=$3,updated_at=$4 WHERE id=$1", [row.id, token, new Date(deps.clock.now().getTime() + 120000).toISOString(), deps.clock.now().toISOString()]);
            return row;
        });
        if (!j)
            break;
        let folder: string | null = null, source: Readable | null = null;
        try {
            if (!deps.objectStore.putStream)
                throw new DomainError('EXPORT_STORAGE_UNAVAILABLE', 'Streaming exact-version export storage is required', 503);
            const owner = ownerOf(j);
            if (sha256Hex(canonicalize(j.selection)) !== j.selection_sha256)
                throw new DomainError('EXPORT_SELECTION_CORRUPT', 'The accepted canonical selection failed verification', 409);
            let checkAt = 0;
            const check = async (force = false) => {
                if (!force && deps.clock.now().getTime() - checkAt < 1000)
                    return;
                await deps.db.transaction(async (tx) => {
                    const current = await load(tx, j.id, true);
                    assertLease(deps, current, token);
                    await authorize(deps, tx, owner, current, true);
                    await tx.query('UPDATE record_canonical_export_jobs SET lease_expires_at=$3,updated_at=$4 WHERE id=$1 AND lease_token=$2', [j.id, token, new Date(deps.clock.now().getTime() + 120000).toISOString(), deps.clock.now().toISOString()]);
                });
                checkAt = deps.clock.now().getTime();
            };
            await check(true);
            const resolved = await resolveCanonicalSnapshot(deps, owner, j.proof_id, j.selection.kind, j.selection.snapshotId);
            if (canonicalize(resolved) !== canonicalize(j.selection))
                throw new DomainError('EXPORT_SELECTION_CHANGED', 'The accepted immutable snapshot no longer verifies', 409);
            const granted = await authorize(deps, deps.db, owner, j, true);
            source = j.selection.kind === 'ENVELOPE' ? await exportProofEnvelope(granted, j.actor_user_id, j.proof_id, j.selection.snapshotId, deps.envelopes) : await exportEvidencePackageStream(granted, deps.clock, deps.objectStore, j.actor_user_id, j.proof_id, { coreSnapshotOnly: j.selection.kind === 'CORE', requireCompleteOriginals: true, exportedAt: iso(j.artifact_time), ...(j.selection.kind === 'LIFECYCLE' ? { lifecycleSnapshotId: j.selection.snapshotId } : {}), organizationDisclosure: { organizationId: j.organization_id, environment: j.environment, membershipId: j.membership_id ?? `service:${j.principal_id}` } });
            folder = await mkdtemp(join(tmpdir(), 'packproof-canonical-export-'));
            const path = join(folder, 'package.pkpr'), file = await open(path, 'wx', 0o600), hash = createHash('sha256');
            let bytes = 0;
            try {
                for await (const value of guardAuthorizedStream(source, () => check(true))) {
                    const chunk = Buffer.from(value);
                    bytes += chunk.length;
                    if (bytes > MAX_BYTES)
                        throw new DomainError('PACKAGE_TOO_LARGE', 'The canonical package exceeds its bounded size', 413);
                    hash.update(chunk);
                    for (let offset = 0; offset < chunk.length;) {
                        const written = await file.write(chunk, offset, chunk.length - offset);
                        if (written.bytesWritten === 0)
                            throw new Error('Export spool write made no progress');
                        offset += written.bytesWritten;
                    }
                }
                await file.sync();
            }
            finally {
                await file.close();
                source.destroy();
                source = null;
            }
            const digest = hash.digest('hex');
            await check(true);
            const staging = `evidence/${j.organization_id}/${j.id}/staging/package.pkpr`, uploaded = await deps.objectStore.putStream(staging, guardAuthorizedStream(createReadStream(path), () => check(true)), 'application/zip', bytes);
            await check(true);
            if (!uploaded.versionId || (!deps.devAuth && uploaded.versionId === 'null'))
                throw new DomainError('EXPORT_VERSION_UNAVAILABLE', 'An exact preserved storage version is required', 503);
            const committed = await deps.objectStore.commitUpload(staging, { expectedVersionId: uploaded.versionId, sha256: digest, byteSize: bytes, contentType: 'application/zip', maxBytes: MAX_BYTES });
            await check(true);
            if (!committed || committed.sha256 !== digest || committed.byteSize !== bytes || !committed.versionId || (!deps.devAuth && committed.versionId === 'null'))
                throw new DomainError('EXPORT_ARTIFACT_INTEGRITY_FAILED', 'The completed canonical package could not be verified', 409);
            const verified = await deps.objectStore.digest(committed.key, { versionId: committed.versionId });
            await check(true);
            if (!verified || verified.sha256 !== digest || verified.byteSize !== bytes || verified.versionId !== committed.versionId)
                throw new DomainError('EXPORT_ARTIFACT_INTEGRITY_FAILED', 'The exact preserved canonical package failed verification', 409);
            await deps.db.transaction(async (tx) => {
                const current = await load(tx, j.id, true);
                assertLease(deps, current, token);
                await authorize(deps, tx, owner, current, true);
                await tx.query("UPDATE record_canonical_export_jobs SET state='ready',ready_at=$3,updated_at=$3,object_key=$4,object_version_id=$5,artifact_sha256=$6,artifact_byte_size=$7,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE id=$1 AND lease_token=$2", [j.id, token, deps.clock.now().toISOString(), committed.key, committed.versionId, digest, bytes]);
                await auditOrganization(tx, deps.clock, { ...(owner.kind === 'PARTNER' ? { actor: owner.actor } : { userId: j.actor_user_id, merchantId: j.organization_id }), requestId: j.id, operation: 'CANONICAL_EXPORT_PRESERVED', resourceId: j.proof_id });
            });
            processed++;
        }
        catch (e) {
            failed++;
            await deps.db.query("UPDATE record_canonical_export_jobs SET state='action_needed',updated_at=$4,last_error_code=$3,lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_expires_at>$4", [j.id, token, e instanceof DomainError ? e.code : 'CANONICAL_EXPORT_FAILED', deps.clock.now().toISOString()]);
        }
        finally {
            source?.destroy();
            if (folder) {
                const target = resolve(folder), base = resolve(tmpdir()), rel = relative(base, target);
                if (rel && !rel.startsWith('..') && !rel.includes(':'))
                    await rm(target, { recursive: true, force: true });
            }
        }
    }
    return { processed, failed };
}
export async function openCanonicalExport(deps: Deps, owner: CanonicalExportOwner, id: string) {
    const j = await load(deps.db, id);
    await authorize(deps, deps.db, owner, j);
    if (new Date(j.expires_at).getTime() <= deps.clock.now().getTime())
        throw new DomainError('EXPORT_EXPIRED', 'The stored download availability window expired', 410);
    if (j.state !== 'ready' || !j.object_key || !j.object_version_id || !j.artifact_sha256 || !j.artifact_byte_size)
        throw new DomainError('EXPORT_NOT_READY', 'Download is available after the exact package has been preserved', 409);
    if (!deps.objectStore.getStream)
        throw new DomainError('STREAMING_STORAGE_REQUIRED', 'A streaming storage adapter is required', 503);
    const object = await deps.objectStore.getStream(j.object_key, { versionId: j.object_version_id });
    if (!object)
        throw new DomainError('EXPORT_ARTIFACT_UNAVAILABLE', 'The preserved package is currently unavailable', 409);
    try {
        if (object.versionId !== j.object_version_id || object.byteSize !== Number(j.artifact_byte_size))
            throw new DomainError('EXPORT_ARTIFACT_INTEGRITY_FAILED', 'Storage returned a different package version or length', 409);
        const check = async () => {
            const current = await load(deps.db, id);
            await authorize(deps, deps.db, owner, current);
            if (current.state !== 'ready' || new Date(current.expires_at).getTime() <= deps.clock.now().getTime())
                throw new DomainError('EXPORT_EXPIRED', 'The stored download availability window expired', 410);
        };
        await check();
        const guarded = guardAuthorizedStream(object.body, check), hash = createHash('sha256');
        const body = Readable.from((async function* () {
            let bytes = 0;
            try {
                for await (const value of guarded) {
                    const chunk = Buffer.from(value);
                    bytes += chunk.length;
                    if (bytes > Number(j.artifact_byte_size))
                        throw new DomainError('EXPORT_ARTIFACT_INTEGRITY_FAILED', 'The stored package length changed', 409);
                    hash.update(chunk);
                    yield chunk;
                }
                if (bytes !== Number(j.artifact_byte_size) || hash.digest('hex') !== j.artifact_sha256)
                    throw new DomainError('EXPORT_ARTIFACT_INTEGRITY_FAILED', 'The stored package digest failed verification', 409);
                await check();
            }
            finally {
                guarded.destroy();
                object.body.destroy();
            }
        })(), { objectMode: false, highWaterMark: 65536 });
        return { body, sha256: j.artifact_sha256, byteSize: Number(j.artifact_byte_size), selection: j.selection };
    }
    catch (e) {
        object.body.destroy();
        throw e;
    }
}
const route = (fn: (r: Request, s: Response) => Promise<void>) => (r: Request, s: Response, n: NextFunction) => {
    void fn(r, s).catch(e => {
        if (s.headersSent || s.destroyed)
            s.destroy();
        else
            n(e);
    });
};
async function send(deps: Deps, owner: CanonicalExportOwner, id: string, s: Response) {
    const result = await openCanonicalExport(deps, owner, id), a = ownerIdentity(owner), audit = async (operation: string) => auditOrganization(deps.db, deps.clock, { ...(owner.kind === 'PARTNER' ? { actor: owner.actor } : { userId: a.userId, merchantId: a.organizationId }), requestId: id, operation, resourceId: result.selection.proofId });
    try {
        await audit('CANONICAL_EXPORT_DOWNLOAD_REQUESTED');
        s.setHeader('Cache-Control', 'private, no-store');
        s.setHeader('X-Content-Type-Options', 'nosniff');
        s.setHeader('Referrer-Policy', 'no-referrer');
        s.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
        s.type('application/zip');
        s.setHeader('Content-Disposition', `attachment; filename="packproof-${id.replace(/[^A-Za-z0-9_-]/g, '')}.pkpr"`);
        s.setHeader('Content-Length', result.byteSize);
        s.setHeader('X-Artifact-Sha256', result.sha256);
        s.setHeader('PackProof-Package-Scope', result.selection.scope);
        await pipeline(result.body, s);
        await audit('CANONICAL_EXPORT_DOWNLOAD_COMPLETED');
    }
    finally {
        result.body.destroy();
    }
}
export function createPartnerExportsRouter(deps: AppDependencies) {
    const r = express.Router(), owner = (req: Request): CanonicalExportOwner => {
        const a = (req as Request & {
            partnerActor: PartnerActor;
        }).partnerActor;
        if (!a)
            throw new DomainError('UNAUTHENTICATED', 'A service credential is required', 401);
        return { kind: 'PARTNER', actor: a };
    };
    r.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');next();});
    r.get('/exports', route(async (req, res) => {
        res.json(await listCanonicalExports(deps, owner(req)));
    }));
    r.post('/exports', route(async (req, res) => {
        const result = await createCanonicalExport(deps, owner(req), req.header('Idempotency-Key'), req.body);
        res.setHeader('Idempotency-Replayed', String(result.replayed));
        res.status(202).json(result.value);
    }));
    r.get('/exports/:exportId', route(async (req, res) => {
        res.json(await readCanonicalExport(deps, owner(req), req.params.exportId));
    }));
    r.get('/exports/:exportId/package', route(async (req, res) => {
        await send(deps, owner(req), req.params.exportId, res);
    }));
    return r;
}
export function createRecordCanonicalExportsRouter(deps: AppDependencies) {
    const r = express.Router(), owner = async (req: Request): Promise<CanonicalExportOwner> => {
        const auth = await deps.auth.authenticate(req.headers);
        return { kind: 'HUMAN', workspace: await requireRecordWorkspace(deps.db, auth.userId, req.query.organizationId, req.query.environment) };
    };
    r.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');next();});
    r.get('/canonical-exports', route(async (req, res) => {
        res.json(await listCanonicalExports(deps, await owner(req)));
    }));
    r.post('/:proofId/canonical-exports', route(async (req, res) => {
        const input = strictBody(req.body, ['kind', 'snapshotId', 'expiresAt']), result = await createCanonicalExport(deps, await owner(req), req.header('Idempotency-Key'), { ...input, proofId: req.params.proofId });
        res.setHeader('Idempotency-Replayed', String(result.replayed));
        res.status(202).json(result.value);
    }));
    r.get('/canonical-exports/:exportId', route(async (req, res) => {
        res.json(await readCanonicalExport(deps, await owner(req), req.params.exportId));
    }));
    r.get('/canonical-exports/:exportId/package', route(async (req, res) => {
        await send(deps, await owner(req), req.params.exportId, res);
    }));
    return r;
}
