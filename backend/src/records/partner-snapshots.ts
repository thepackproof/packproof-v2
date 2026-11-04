import express, { type Request, type Response, type NextFunction } from 'express';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { getManifest } from '../domain/finalize.js';
import { getLifecycleSnapshot } from '../domain/lifecycle-snapshots.js';
import { getProofEnvelope } from '../integrity/envelope-access.js';
import { authorizePartnerProof, type PartnerActor } from '../platform/organizations.js';
import { withPartnerReadGrant } from '../platform/proof-read-grant.js';
import { requireRecordAccess, requireRecordWorkspace, type RecordWorkspace } from './access.js';
import { withRecordReadGrant } from './read-grant.js';
export type CanonicalSnapshotKind = 'CORE' | 'LIFECYCLE' | 'ENVELOPE';
export interface CanonicalSnapshotSelection {
    proofId: string;
    kind: CanonicalSnapshotKind;
    snapshotId: string;
    sha256: string;
    scope: 'FROZEN_CORE_ONLY' | 'SEALED_COMMERCE_LIFECYCLE' | 'ACCEPTED_PROTECTED_RECORD';
}
export type CanonicalExportOwner = {
    kind: 'PARTNER';
    actor: PartnerActor;
} | {
    kind: 'HUMAN';
    workspace: RecordWorkspace;
};
type Deps = Pick<AppDependencies, 'db' | 'clock' | 'envelopes'>;
export async function authorizeCanonicalExport(deps: Deps, db: Database, owner: CanonicalExportOwner, proofId: string) {
    if (owner.kind === 'PARTNER') {
        await authorizePartnerProof(db, deps.clock, owner.actor, proofId, 'exports:read');
        return withPartnerReadGrant(db, deps.clock, owner.actor, proofId, 'exports:read');
    }
    const w = await requireRecordAccess(db, owner.workspace, proofId);
    if (w.membershipId !== owner.workspace.membershipId || !['OWNER', 'ADMIN'].includes(w.role))
        throw new DomainError('RECORD_EXPORT_PERMISSION_REQUIRED', 'The same current organization owner or administrator grant must authorize this canonical package', 403);
    return withRecordReadGrant(db, w, proofId);
}
const user = (owner: CanonicalExportOwner) => owner.kind === 'PARTNER' ? owner.actor.actorUserId : owner.workspace.userId;
export async function resolveCanonicalSnapshot(deps: Deps, owner: CanonicalExportOwner, proofId: string, kind: unknown, snapshotId: string): Promise<CanonicalSnapshotSelection> {
    const db = await authorizeCanonicalExport(deps, deps.db, owner, proofId);
    let result: CanonicalSnapshotSelection;
    if (kind === 'CORE') {
        const m = await getManifest(db, user(owner), proofId);
        if (m.manifestId !== snapshotId)
            throw new DomainError('SNAPSHOT_NOT_FOUND', 'Snapshot not found', 404);
        if (sha256Hex(m.canonicalJson) !== m.sha256)
            throw new DomainError('SNAPSHOT_INTEGRITY_FAILURE', 'The frozen canonical manifest does not match its digest', 409);
        result = { proofId, kind, snapshotId, sha256: m.sha256, scope: 'FROZEN_CORE_ONLY' };
    }
    else if (kind === 'LIFECYCLE') {
        const m = await getLifecycleSnapshot(db, user(owner), proofId, snapshotId);
        result = { proofId, kind, snapshotId, sha256: m.sha256, scope: 'SEALED_COMMERCE_LIFECYCLE' };
    }
    else if (kind === 'ENVELOPE') {
        const m = await getProofEnvelope(db, user(owner), proofId, snapshotId, deps.envelopes);
        if (m.state !== 'READY')
            throw new DomainError('ENVELOPE_NOT_READY', 'Only an already accepted preserved protected envelope can be selected', 409);
        result = { proofId, kind, snapshotId, sha256: m.manifestSha256, scope: 'ACCEPTED_PROTECTED_RECORD' };
    }
    else
        throw new DomainError('INVALID_SNAPSHOT_KIND', 'Choose CORE, LIFECYCLE or ENVELOPE', 400);
    await authorizeCanonicalExport(deps, deps.db, owner, proofId);
    return result;
}
export async function readCanonicalSnapshot(deps: Deps, owner: CanonicalExportOwner, proofId: string, kind: unknown, snapshotId: string) {
    const selection = await resolveCanonicalSnapshot(deps, owner, proofId, kind, snapshotId), db = await authorizeCanonicalExport(deps, deps.db, owner, proofId);
    let record: unknown;
    if (kind === 'CORE') {
        const m = await getManifest(db, user(owner), proofId);
        record = { manifestId: m.manifestId, manifestSha256: m.sha256, signaturePresent: !!m.signature };
    }
    else if (kind === 'LIFECYCLE') {
        const m = await getLifecycleSnapshot(db, user(owner), proofId, snapshotId);
        record = { snapshotId: m.snapshotId, sha256: m.sha256, rootManifestId: m.root.manifestId, stageCount: m.stages.length, supplementCount: m.supplements.length, signaturePresent: !!m.signature };
    }
    else
        record = await getProofEnvelope(db, user(owner), proofId, snapshotId, deps.envelopes);
    await authorizeCanonicalExport(deps, deps.db, owner, proofId);
    return { schema: 'packproof.canonical-snapshot-selection/v1', selection, selectionSha256: sha256Hex(canonicalize(selection)), record, operationalSnapshot: false, limitations: ['Later operational revisions, requirements, issues, relationships, amendments and review notes are excluded.', 'A digest match or signature presence is not independent signature verification or a physical truth verdict.', 'Offline canonical snapshots do not establish current revocation status or the absence of later records.'] };
}
export async function listCanonicalSnapshotOptions(deps: Deps, owner: CanonicalExportOwner, proofId: string) {
    await authorizeCanonicalExport(deps, deps.db, owner, proofId);
    const found = (await deps.db.query<{
        id: string;
        kind: CanonicalSnapshotKind;
    }>(`SELECT id,'CORE'::text kind FROM final_manifests WHERE proof_id=$1 UNION ALL SELECT id,'LIFECYCLE'::text FROM lifecycle_snapshots WHERE proof_id=$1 UNION ALL SELECT operation_id,'ENVELOPE'::text FROM integrity_envelope_jobs WHERE proof_id=$1 ORDER BY kind,id LIMIT 101`, [proofId])).rows;
    if (found.length > 100)
        throw new DomainError('SNAPSHOT_SELECTION_LIMIT', 'Select a known immutable snapshot ID; this record has more than 100 canonical snapshots', 409);
    const options = [];
    for (const r of found) {
        try {
            options.push(await resolveCanonicalSnapshot(deps, owner, proofId, r.kind, r.id));
        }
        catch (error) {
            if (!(error instanceof DomainError) || !['PRESERVATION_PENDING', 'ENVELOPE_NOT_READY', 'ENVELOPES_DISABLED', 'ENVELOPE_UNAVAILABLE', 'MANIFEST_NOT_FOUND'].includes(error.code))
                throw error;
        }
    }
    await authorizeCanonicalExport(deps, deps.db, owner, proofId);
    return { snapshots: options, operationalSnapshot: false, omissionPolicy: 'REQUIRE_COMPLETE_ORIGINALS', sharing: false };
}
function route(fn: (r: Request, s: Response) => Promise<void>) {
    return (r: Request, s: Response, n: NextFunction) => {
        void fn(r, s).catch(n);
    };
}
export function createPartnerSnapshotsRouter(deps: AppDependencies) {
    const r = express.Router(), owner = (req: Request): CanonicalExportOwner => {
        const a = (req as Request & {
            partnerActor: PartnerActor;
        }).partnerActor;
        if (!a)
            throw new DomainError('UNAUTHENTICATED', 'A service credential is required', 401);
        return { kind: 'PARTNER', actor: a };
    };
    r.get('/proofs/:proofId/snapshots', route(async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(await listCanonicalSnapshotOptions(deps, owner(req), req.params.proofId));
    }));
    r.get('/proofs/:proofId/snapshots/:kind/:snapshotId', route(async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(await readCanonicalSnapshot(deps, owner(req), req.params.proofId, req.params.kind, req.params.snapshotId));
    }));
    return r;
}
export function createRecordSnapshotsRouter(deps: AppDependencies) {
    const r = express.Router(), owner = async (req: Request): Promise<CanonicalExportOwner> => {
        const auth = await deps.auth.authenticate(req.headers), w = await requireRecordWorkspace(deps.db, auth.userId, req.query.organizationId, req.query.environment);
        return { kind: 'HUMAN', workspace: w };
    };
    r.get('/:proofId/canonical-snapshots', route(async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(await listCanonicalSnapshotOptions(deps, await owner(req), req.params.proofId));
    }));
    r.get('/:proofId/canonical-snapshots/:kind/:snapshotId', route(async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(await readCanonicalSnapshot(deps, await owner(req), req.params.proofId, req.params.kind, req.params.snapshotId));
    }));
    return r;
}
