import express, { type Request, type Response, type NextFunction } from 'express';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { appendAudit } from '../domain/audit.js';
import { auditOrganization, reauthorizePartner, authorizePartnerProof, strictBody, type PartnerActor } from '../platform/organizations.js';
import { importPartnerOrder } from '../platform/partner-proofs.js';
import { idempotent } from '../platform/idempotency.js';
import { textField } from '../platform/tenants.js';
import { parseShipmentCsv, correctionCsv, type ShipmentCsvRow, type CsvMapping } from './csv.js';
import { authorizeAgentPreview, authorizeAgentImport } from './agent-restrictions.js';
import {shipmentBindingKey} from './source-reference.js';
type Deps = Pick<AppDependencies, 'db' | 'clock' | 'objectStore' | 'devAuth'>;
type State = 'previewed' | 'queued' | 'running' | 'succeeded' | 'partially_succeeded' | 'failed' | 'action_needed';
interface Job {
    id: string;
    agent_installation_id: string | null;
    agent_config_revision: number | null;
    source_control_revision: number | string;
    organization_id: string;
    environment: 'sandbox' | 'live';
    actor: PartnerActor;
    principal_id: string;
    credential_id: string;
    delegation_id: string | null;
    integration_account_id: string;
    operator_membership_id: string;
    source_name: string;
    preview_version: string;
    mapping_version: string;
    mapping: CsvMapping;
    headers: string[];
    delimiter: string;
    time_zone: string;
    original_object_key: string;
    original_version_id: string;
    original_sha256: string;
    original_byte_size: number;
    state: State;
    import_valid_rows: boolean;
    received_at: Date | string;
    updated_at: Date | string;
    lease_token: string | null;
    lease_expires_at: Date | string | null;
    last_error_code: string | null;
}
interface Row {
    row_number: number;
    status: ShipmentCsvRow['status'];
    source_values: Record<string, string>;
    normalized: ShipmentCsvRow['normalized'];
    payload_sha256: string | null;
    errors: string[];
    proof_id: string | null;
    attempts: number;
}
const MAPPING_VERSION = 'packproof.csv-mapping/v1', iso = (x: Date | string) => new Date(x).toISOString();
const rowView = (r: Row): ShipmentCsvRow => ({ rowNumber: r.row_number, status: r.status, values: r.source_values, normalized: r.normalized, payloadSha256: r.payload_sha256, errors: r.errors, ...(r.proof_id ? { proofId: r.proof_id } : {}) });
async function job(db: Database, id: string, lock = false) {
    const r = (await db.query<Job>(`SELECT * FROM partner_import_jobs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!r)
        throw new DomainError('IMPORT_NOT_FOUND', 'Import not found', 404);
    return r;
}
async function rows(db: Database, id: string) {
    return (await db.query<Row>('SELECT * FROM partner_import_rows WHERE import_id=$1 ORDER BY row_number', [id])).rows;
}
function sameActor(a: PartnerActor, j: Job) {
    if (a.merchantId !== j.organization_id || a.environment !== j.environment || a.principalId !== j.principal_id || a.credentialId !== j.credential_id || a.delegationGrantId !== j.delegation_id)
        throw new DomainError('IMPORT_NOT_FOUND', 'Import not found', 404);
}
async function requireOperator(db: Database, a: PartnerActor, membershipId: string, locationId: string | null | undefined) {
    const m = (await db.query<{
        user_id: string;
        organization_id: string;
        location_scoped: boolean;
    }>(`SELECT m.user_id,m.organization_id,m.location_scoped FROM platform_memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1 AND m.organization_id IN ($2,$3) AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN','OPERATOR') AND u.status='ACTIVE' FOR SHARE OF m,u`, [membershipId, a.merchantId, a.principalOrganizationId])).rows[0];
    if (!m)
        throw new DomainError('OPERATOR_NOT_AUTHORIZED', 'Assign an active authorized operator', 403);
    if (a.delegationGrantId) {
        if (locationId)
            throw new DomainError('LOCATION_GRANT_REQUIRED', 'Delegated imports require an accepted explicit location grant for located rows', 403);
        const grant = await db.query('SELECT 1 FROM platform_delegations WHERE id=$1 AND operator_ids ? $2', [a.delegationGrantId, m.user_id]);
        if (!grant.rows[0])
            throw new DomainError('OPERATOR_NOT_AUTHORIZED', 'This grant does not authorize this operator', 403);
    }
    if (locationId === undefined)
        return;
    if (!locationId) {
        if (m.location_scoped)
            throw new DomainError('LOCATION_REQUIRED', 'This operator needs an authorized location', 403);
        return;
    }
    const l = await db.query(`SELECT 1 FROM record_locations l WHERE l.id=$1 AND l.organization_id=$2 AND ($3::boolean=false OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.membership_id=$4 AND g.location_id=l.id AND g.organization_id=l.organization_id))`, [locationId, a.merchantId, m.location_scoped, membershipId]);
    if (!l.rows[0])
        throw new DomainError('LOCATION_NOT_FOUND', 'Location not found', 404);
}
async function authorize(deps: Deps, db: Database, a: PartnerActor, j: Job, write = false, inspectRows = true, processing = false, importValidRows?: boolean) {
    sameActor(a, j);
    await reauthorizePartner(db, deps.clock, a, write ? 'imports:write' : 'imports:read');
    if (write)
        await reauthorizePartner(db, deps.clock, a, 'proofs:write');
    if (write) {
        const state=(await db.query<{paused:boolean;control_revision:string|number}>('SELECT paused,control_revision FROM record_connection_state WHERE connection_id=$1',[j.integration_account_id])).rows[0];
        if(state?.paused)throw new DomainError('CONNECTION_PAUSED','This source connection is paused',409);
        if(String(state?.control_revision??0)!==String(j.source_control_revision))throw new DomainError('CONNECTION_CHANGED','This original was accepted under earlier source settings. Review it and create a new authorized preview.',409);
    }
    await reauthorizePartner(db, deps.clock, a, 'proofs:read');
    await requireOperator(db, a, j.operator_membership_id, undefined);
    const rs = inspectRows ? await rows(db, j.id) : [];
    await authorizeAgentImport(db, deps.clock, a, j, processing ? 'process' : write ? 'commit' : 'read', rs.map(r => ({values:r.source_values,normalized:r.normalized})), importValidRows);
    if (!inspectRows)
        return;
    const locations = new Set(rs.flatMap(r => r.normalized ? [r.normalized.locationId] : [])), proofs = new Set(rs.flatMap(r => r.proof_id ? [r.proof_id] : []));
    for (const location of locations)
        await requireOperator(db, a, j.operator_membership_id, location);
    for (const proofId of proofs)
        await authorizePartnerProof(db, deps.clock, a, proofId, 'proofs:read');
}
function view(j: Job, rs: Row[]) {
    const counts = { valid: 0, invalid: 0, duplicate: 0, ambiguous: 0, imported: 0, failed: 0 };
    for (const r of rs)
        counts[r.status]++;
    return { id: j.id, state: j.state, organizationId: j.organization_id, environment: j.environment, previewVersion: j.preview_version, sourceName: j.source_name, integrationAccountId: j.integration_account_id, operatorMembershipId: j.operator_membership_id, mappingVersion: j.mapping_version, mapping: j.mapping, headers: j.headers, delimiter: j.delimiter, timeZone: j.time_zone, encoding: 'UTF-8', receivedAt: iso(j.received_at), updatedAt: iso(j.updated_at), original: { sha256: j.original_sha256, byteSize: j.original_byte_size, versionBound: j.original_version_id !== 'null' }, counts, rows: rs.map(rowView), correctionsCsv: correctionCsv(j.headers, rs.map(rowView)), recordIds: [...new Set(rs.flatMap(r => r.proof_id ? [r.proof_id] : []))], lastErrorCode: j.last_error_code, syncStatus: 'not_applicable' };
}
export async function readPartnerImport(deps: Deps, a: PartnerActor, id: string) {
    const j = await job(deps.db, id);
    await authorize(deps, deps.db, a, j);
    const result = view(j, await rows(deps.db, id));
    await authorize(deps, deps.db, a, j);
    return result;
}
export async function previewPartnerImport(deps: Deps, a: PartnerActor, key: unknown, input: unknown) {
    const b = strictBody(input, ['integrationAccountId', 'operatorMembershipId', 'sourceName', 'csv', 'mapping', 'timeZone']), account = textField(b.integrationAccountId, 'integrationAccountId'), operator = textField(b.operatorMembershipId, 'operatorMembershipId'), name = b.sourceName === undefined ? 'Spreadsheet' : textField(b.sourceName, 'sourceName', 80), parsed = parseShipmentCsv(b.csv, b.mapping, b.timeZone), bytes = Buffer.from(b.csv as string, 'utf8'), digest = sha256Hex(bytes);
    await reauthorizePartner(deps.db, deps.clock, a, 'imports:write');
    await reauthorizePartner(deps.db, deps.clock, a, 'proofs:write');
    await reauthorizePartner(deps.db, deps.clock, a, 'imports:read');
    await reauthorizePartner(deps.db, deps.clock, a, 'proofs:read');
    const approvedInput = {integrationAccountId:account,operatorMembershipId:operator,sourceName:name,mapping:parsed.mapping,timeZone:parsed.timeZone,headers:parsed.headers};
    await authorizeAgentPreview(deps.db,deps.clock,a,approvedInput,parsed.rows);
    const result = await idempotent(deps.db, deps.clock, a.tenantId, `service-import-preview:${a.principalId}:${a.credentialId}:${a.delegationGrantId ?? ''}`, key, b, async (tx) => {
        await reauthorizePartner(tx, deps.clock, a, 'imports:write');
        await authorizeAgentPreview(tx,deps.clock,a,approvedInput,parsed.rows);
        await tx.query('SELECT pg_advisory_xact_lock(1347438147,hashtext($1))', [a.merchantId]);
        const source = await tx.query('SELECT 1 FROM platform_integration_accounts WHERE id=$1 AND merchant_id=$2 AND environment=$3', [account, a.merchantId, a.environment]);
        if (!source.rows[0])
            throw new DomainError('INTEGRATION_NOT_FOUND', 'Integration account not found', 404);
        await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${a.merchantId}:${account}`]);
        const control=(await tx.query<{paused:boolean;control_revision:string|number}>('SELECT paused,control_revision FROM record_connection_state WHERE connection_id=$1',[account])).rows[0];
        if(control?.paused)throw new DomainError('CONNECTION_PAUSED','This source connection is paused',409);
        const active = (await tx.query<{
            n: string;
        }>("SELECT COUNT(*)::text n FROM partner_import_jobs WHERE organization_id=$1 AND environment=$2 AND (state IN ('queued','running') OR (state='previewed' AND received_at>$3))", [a.merchantId, a.environment,new Date(deps.clock.now().getTime()-86400000).toISOString()])).rows[0];
        if (Number(active.n) >= 50)
            throw new DomainError('IMPORT_LIMIT_REACHED', 'Finish queued imports or wait for the rolling 24-hour preview allowance to recover', 409);
        for (const r of parsed.rows)
            if (r.normalized) {
                await requireOperator(tx, a, operator, r.normalized.locationId);
                const old = (await tx.query<{
                    proof_id: string;
                    snapshot_sha256: string;
                }>("SELECT b.proof_id,b.snapshot_sha256 FROM platform_external_bindings b LEFT JOIN record_state s ON s.proof_id=b.proof_id WHERE b.merchant_id=$1 AND b.environment=$2 AND b.integration_account_id=$3 AND b.resource_type='SHIPMENT' AND b.external_id IN ($4,$5) AND s.location_id IS NOT DISTINCT FROM $6", [a.merchantId, a.environment, account, shipmentBindingKey(r.normalized.shipmentReference,r.normalized.locationId),r.normalized.shipmentReference,r.normalized.locationId])).rows[0];
                if (old) {
                    await authorizePartnerProof(tx, deps.clock, a, old.proof_id, 'proofs:read');
                    const assignment = (await tx.query<{
                        operator_membership_id: string;
                    }>('SELECT operator_membership_id FROM platform_proof_ownership WHERE proof_id=$1', [old.proof_id])).rows[0];
                    if (assignment.operator_membership_id !== operator)
                        throw new DomainError('OPERATOR_ASSIGNMENT_CONFLICT', 'The source reference keeps its recorded operator assignment', 409);
                    r.status = old.snapshot_sha256 === r.payloadSha256 ? 'duplicate' : 'ambiguous';
                    if (r.status === 'duplicate')
                        r.proofId = old.proof_id;
                    r.errors.push(r.status === 'duplicate' ? 'This shipment was already imported from this source.' : 'This source reference has different immutable details. Append a correction to its existing Proof.');
                }
            }
        const id = newId('partner_import'), objectKey = `evidence/${a.merchantId}/${id}/committed/sha256-${digest}`;
        if (!deps.objectStore.putIfAbsent)
            throw new DomainError('IMPORT_STORAGE_UNAVAILABLE', 'Create-only source storage is required', 503);
        await deps.objectStore.putIfAbsent(objectKey, bytes, 'text/csv; charset=utf-8');
        const stored = await deps.objectStore.digest(objectKey);
        if (!stored || stored.sha256 !== digest || stored.byteSize !== bytes.length || !stored.versionId || (!deps.devAuth && stored.versionId === 'null'))
            throw new DomainError('IMPORT_ORIGINAL_UNVERIFIED', 'The original spreadsheet could not be preserved at an exact verified version', 503);
        await reauthorizePartner(tx, deps.clock, a, 'imports:write');
        await reauthorizePartner(tx, deps.clock, a, 'proofs:write');
        for (const r of parsed.rows)
            if (r.normalized)
                await requireOperator(tx, a, operator, r.normalized.locationId);
        const installation = await authorizeAgentPreview(tx,deps.clock,a,approvedInput,parsed.rows);
        const now = deps.clock.now().toISOString(), version = sha256Hex(canonicalize({ schema: MAPPING_VERSION, sha256: digest, mapping: parsed.mapping, timeZone: parsed.timeZone, account, operator, sourceName: name }));
        await tx.query(`INSERT INTO partner_import_jobs(id,organization_id,environment,actor,principal_id,credential_id,delegation_id,integration_account_id,operator_membership_id,source_name,preview_version,mapping_version,mapping,headers,delimiter,time_zone,original_object_key,original_version_id,original_sha256,original_byte_size,state,received_at,updated_at,agent_installation_id,agent_config_revision,source_control_revision) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20,'previewed',$21,$21,$22,$23,$24)`, [id, a.merchantId, a.environment, JSON.stringify(a), a.principalId, a.credentialId, a.delegationGrantId, account, operator, name, version, MAPPING_VERSION, JSON.stringify(parsed.mapping), JSON.stringify(parsed.headers), parsed.delimiter, parsed.timeZone, objectKey, stored.versionId, digest, bytes.length, now, installation?.id ?? null, installation?.config_revision ?? null,control?.control_revision??0]);
        for (const r of parsed.rows)
            await tx.query('INSERT INTO partner_import_rows(import_id,row_number,status,source_values,normalized,payload_sha256,errors,proof_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8)', [id, r.rowNumber, r.status, JSON.stringify(r.values), JSON.stringify(r.normalized), r.payloadSha256, JSON.stringify(r.errors), r.proofId ?? null]);
        await auditOrganization(tx, deps.clock, { actor: a, requestId: a.requestId, operation: 'SERVICE_CSV_PREVIEWED', resourceId: id });
        return { id };
    });
    return { ...result, value: await readPartnerImport(deps, a, result.value.id) };
}
export async function commitPartnerImport(deps: Deps, a: PartnerActor, id: string, key: unknown, input: unknown) {
    const b = strictBody(input, ['previewVersion', 'importValidRows']);
    if (typeof b.previewVersion !== 'string' || typeof b.importValidRows !== 'boolean')
        throw new DomainError('INVALID_REQUEST', 'Confirm the preview version and partial-import choice', 400);
    const importValidRows = b.importValidRows;
    const current = await job(deps.db, id);
    await authorize(deps, deps.db, a, current, true, true, false, importValidRows);
    const result = await idempotent(deps.db, deps.clock, a.tenantId, `service-import-commit:${a.principalId}:${a.credentialId}:${id}`, key, b, async (tx) => {
        const j = await job(tx, id, true);
        await authorize(deps, tx, a, j, true, true, false, importValidRows);
        if (j.preview_version !== b.previewVersion)
            throw new DomainError('IMPORT_PREVIEW_CHANGED', 'Review the current preview before committing', 409);
        if (['queued', 'running', 'succeeded'].includes(j.state))
            return { id };
        const rs = await rows(tx, id);
        if (!b.importValidRows && rs.some(r => ['invalid', 'ambiguous', 'failed'].includes(r.status)))
            throw new DomainError('IMPORT_HAS_ROW_ERRORS', 'Repair the highlighted rows or explicitly accept importing valid rows only', 409);
        if (!rs.some(r => r.status === 'valid' || (r.status === 'failed' && r.normalized && r.attempts < 5)) && rs.some(r => ['invalid', 'ambiguous', 'failed'].includes(r.status)))
            throw new DomainError('IMPORT_NO_VALID_ROWS', 'Create a corrected preview for unresolved rows', 409);
        // API authority accepts the retry; worker outcomes and lease fields stay
        // unchanged until the worker verifies the original and owns a new lease.
        await tx.query("UPDATE partner_import_jobs SET state='queued',import_valid_rows=$2,updated_at=$3 WHERE id=$1", [id, b.importValidRows, deps.clock.now().toISOString()]);
        await auditOrganization(tx, deps.clock, { actor: a, requestId: a.requestId, operation: 'SERVICE_CSV_COMMITTED', resourceId: id });
        return { id };
    });
    return { ...result, value: await readPartnerImport(deps, a, id) };
}
function lease(j: Job, token: string, deps: Deps) {
    if (j.state !== 'running' || j.lease_token !== token || !j.lease_expires_at || new Date(j.lease_expires_at).getTime() <= deps.clock.now().getTime())
        throw new DomainError('IMPORT_LEASE_LOST', 'This worker no longer owns the accepted import lease', 409);
}
export async function processPendingPartnerImports(deps: Deps, limit = 2) {
    let processed = 0, failed = 0;
    for (let i = 0; i < Math.max(1, Math.min(limit, 10)); i++) {
        const token = newId('import_lease'), j = await deps.db.transaction(async (tx) => {
            const r = (await tx.query<Job>("SELECT * FROM partner_import_jobs WHERE state='queued' OR (state='running' AND lease_expires_at<$1) ORDER BY received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED", [deps.clock.now().toISOString()])).rows[0];
            if (!r)
                return null;
            await tx.query("UPDATE partner_import_jobs SET state='running',lease_token=$2,lease_expires_at=$3,updated_at=$4,last_error_code=NULL WHERE id=$1", [r.id, token, new Date(deps.clock.now().getTime() + 120000).toISOString(), deps.clock.now().toISOString()]);
            return r;
        });
        if (!j)
            break;
        try {
            await authorize(deps, deps.db, j.actor, j, true, true, true);
            const stored = await deps.objectStore.digest(j.original_object_key, { versionId: j.original_version_id });
            if (!stored || stored.sha256 !== j.original_sha256 || stored.byteSize !== j.original_byte_size || stored.versionId !== j.original_version_id)
                throw new DomainError('IMPORT_ORIGINAL_INTEGRITY_FAILED', 'The exact preserved spreadsheet is unavailable or changed', 409);
            await deps.db.transaction(async (tx) => {
                lease(await job(tx, j.id, true), token, deps);
                await authorize(deps, tx, j.actor, j, true, true, true);
                await tx.query("UPDATE partner_import_rows SET status='valid',errors='[]'::jsonb WHERE import_id=$1 AND status='failed' AND normalized IS NOT NULL AND attempts<5", [j.id]);
            });
            for (const source of await rows(deps.db, j.id))
                if (source.status === 'valid') {
                    try {
                        await deps.db.transaction(async (tx) => {
                            const active = await job(tx, j.id, true);
                            lease(active, token, deps);
                            await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${j.organization_id}:${j.integration_account_id}`]);
                            await authorize(deps, tx, j.actor, j, true, false, true);
                            const r = (await tx.query<Row>('SELECT * FROM partner_import_rows WHERE import_id=$1 AND row_number=$2 FOR UPDATE', [j.id, source.row_number])).rows[0];
                            if (r.status !== 'valid' || !r.normalized)
                                return;
                            await authorizeAgentImport(tx,deps.clock,j.actor,j,'process',[{values:r.source_values,normalized:r.normalized}]);
                            const n = r.normalized;
                            await requireOperator(tx, j.actor, j.operator_membership_id, n.locationId);
                            await tx.query('SELECT pg_advisory_xact_lock(1347438147,hashtext($1))', [j.organization_id]);
                            const old = (await tx.query<{
                                proof_id: string;
                                snapshot_sha256: string;
                            }>("SELECT b.proof_id,b.snapshot_sha256 FROM platform_external_bindings b LEFT JOIN record_state s ON s.proof_id=b.proof_id WHERE b.merchant_id=$1 AND b.environment=$2 AND b.integration_account_id=$3 AND b.resource_type='SHIPMENT' AND b.external_id IN ($4,$5) AND s.location_id IS NOT DISTINCT FROM $6", [j.organization_id, j.environment, j.integration_account_id, shipmentBindingKey(n.shipmentReference,n.locationId),n.shipmentReference,n.locationId])).rows[0];
                            let proofId: string, duplicate = false;
                            if (old) {
                                await authorizePartnerProof(tx, deps.clock, j.actor, old.proof_id, 'proofs:read');
                                const assigned = (await tx.query<{
                                    operator_membership_id: string;
                                }>('SELECT operator_membership_id FROM platform_proof_ownership WHERE proof_id=$1', [old.proof_id])).rows[0];
                                if (assigned.operator_membership_id !== j.operator_membership_id || old.snapshot_sha256 !== r.payload_sha256)
                                    throw new DomainError('SOURCE_REFERENCE_CONFLICT', 'This source reference is already bound to different immutable details or operator', 409);
                                proofId = old.proof_id;
                                duplicate = true;
                            }
                            else {
                                const created = await importPartnerOrder(tx, deps.clock, j.actor, { integrationAccountId: j.integration_account_id, externalId: `csv:${sha256Hex(canonicalize({ source: j.integration_account_id, reference: shipmentBindingKey(n.shipmentReference,n.locationId) }))}`, operatorMembershipId: j.operator_membership_id, transaction: { itemTitle: n.itemTitle, quantity: n.quantity, shipping: { carrier: n.carrier, trackingNumber: n.trackingNumber, shipmentDate: n.shipmentDate } } });
                                proofId = created.proofId;
                                const at = deps.clock.now().toISOString();
                                await tx.query("INSERT INTO platform_external_bindings(merchant_id,environment,integration_account_id,resource_type,external_id,proof_id,snapshot_sha256,created_at) VALUES($1,$2,$3,'SHIPMENT',$4,$5,$6,$7)", [j.organization_id, j.environment, j.integration_account_id, shipmentBindingKey(n.shipmentReference,n.locationId), proofId, r.payload_sha256, at]);
                                await tx.query('INSERT INTO record_state(proof_id,organization_id,environment,title,reference,location_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [proofId, j.organization_id, j.environment, n.itemTitle, n.shipmentReference, n.locationId, at]);
                                await tx.query("INSERT INTO record_entities(id,proof_id,kind,external_reference,attributes,actor_user_id,created_at) VALUES($1,$2,'shipment',$3,$4::jsonb,$5,$6)", [newId('shipment'), proofId, n.shipmentReference, JSON.stringify({ quantity: n.quantity, trackingNumber: n.trackingNumber, carrier: n.carrier, sourceReportedAt: n.shippedAt, sourceTimeZone: j.time_zone, importId: j.id }), j.actor.actorUserId, at]);
                                await appendAudit(tx, { proofId, actorUserId: j.actor.actorUserId, eventType: 'SERVICE_CSV_SHIPMENT_IMPORTED', eventData: { importId: j.id, rowNumber: r.row_number, sourceName: j.source_name, originalSha256: j.original_sha256, payloadSha256: r.payload_sha256, sourceReportedAt: n.shippedAt, timeZone: j.time_zone, mappingVersion: j.mapping_version }, at: deps.clock.now() });
                            }
                            lease(active, token, deps);
                            await tx.query("UPDATE partner_import_rows SET status=$3,proof_id=$4,errors='[]'::jsonb,attempts=attempts+1 WHERE import_id=$1 AND row_number=$2", [j.id, r.row_number, duplicate ? 'duplicate' : 'imported', proofId]);
                            await tx.query('UPDATE partner_import_jobs SET updated_at=$2,lease_expires_at=$3 WHERE id=$1', [j.id, deps.clock.now().toISOString(), new Date(deps.clock.now().getTime() + 120000).toISOString()]);
                        });
                    }
                    catch (error) {
                        if (error instanceof DomainError && (error.code.startsWith('AGENT_') || ['IMPORT_LEASE_LOST', 'CREDENTIAL_REVOKED', 'DELEGATION_REVOKED', 'INSUFFICIENT_SCOPE'].includes(error.code)))
                            throw error;
                        await deps.db.transaction(async (tx) => {
                            lease(await job(tx, j.id, true), token, deps);
                            await tx.query("UPDATE partner_import_rows SET status='failed',attempts=attempts+1,errors=$3::jsonb WHERE import_id=$1 AND row_number=$2 AND status='valid'", [j.id, source.row_number, JSON.stringify([error instanceof DomainError ? error.message : 'This row could not be processed; retry the same receipt.'])]);
                        });
                    }
                }
            await deps.db.transaction(async (tx) => {
                lease(await job(tx, j.id, true), token, deps);
                await authorize(deps, tx, j.actor, j, true, true, true);
                // A duplicate inside the same CSV points to the accepted first
                // occurrence, rather than claiming success without a Proof ID.
                for(const r of await rows(tx,j.id))if(r.status==='duplicate'&&!r.proof_id&&r.normalized){
                    const binding=(await tx.query<{proof_id:string;snapshot_sha256:string;operator_membership_id:string}>("SELECT b.proof_id,b.snapshot_sha256,o.operator_membership_id FROM platform_external_bindings b JOIN platform_proof_ownership o ON o.proof_id=b.proof_id LEFT JOIN record_state s ON s.proof_id=b.proof_id WHERE b.merchant_id=$1 AND b.environment=$2 AND b.integration_account_id=$3 AND b.resource_type='SHIPMENT' AND b.external_id IN ($4,$5) AND s.location_id IS NOT DISTINCT FROM $6",[j.organization_id,j.environment,j.integration_account_id,shipmentBindingKey(r.normalized.shipmentReference,r.normalized.locationId),r.normalized.shipmentReference,r.normalized.locationId])).rows[0];
                    if(binding&&binding.snapshot_sha256===r.payload_sha256&&binding.operator_membership_id===j.operator_membership_id){
                        await authorizePartnerProof(tx,deps.clock,j.actor,binding.proof_id,'proofs:read');
                        await tx.query("UPDATE partner_import_rows SET proof_id=$3,errors='[]'::jsonb WHERE import_id=$1 AND row_number=$2",[j.id,r.row_number,binding.proof_id]);
                    }else await tx.query("UPDATE partner_import_rows SET status='failed',attempts=attempts+1,errors=$3::jsonb WHERE import_id=$1 AND row_number=$2",[j.id,r.row_number,JSON.stringify(['The first occurrence of this duplicate source row was not accepted. Retry the same receipt or repair its source row.'])]);
                }
                lease(await job(tx,j.id,true),token,deps);
                const rs = await rows(tx, j.id), bad = rs.some(r => ['invalid', 'ambiguous', 'failed'].includes(r.status)), good = rs.some(r => ['imported', 'duplicate'].includes(r.status));
                await tx.query('UPDATE partner_import_jobs SET state=$2,updated_at=$3,lease_token=NULL,lease_expires_at=NULL WHERE id=$1', [j.id, bad ? (good ? 'partially_succeeded' : 'failed') : 'succeeded', deps.clock.now().toISOString()]);
            });
            processed++;
        }
        catch (error) {
            failed++;
            await deps.db.query("UPDATE partner_import_jobs SET state='action_needed',last_error_code=$3,updated_at=$4,lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_expires_at>$4", [j.id, token, error instanceof DomainError ? error.code : 'IMPORT_PROCESSING_FAILED', deps.clock.now().toISOString()]);
        }
    }
    return { processed, failed };
}
export function createPartnerImportsRouter(deps: AppDependencies) {
    const router = express.Router(), run = (fn: (r: Request, s: Response) => Promise<void>) => (r: Request, s: Response, n: NextFunction) => {
        void fn(r, s).catch(n);
    }, actor = (r: Request) => {
        const a = (r as Request & {
            partnerActor: PartnerActor;
        }).partnerActor;
        if (!a)
            throw new DomainError('UNAUTHENTICATED', 'A service credential is required', 401);
        return a;
    };
    router.use((_r, s, n) => {
        s.setHeader('Cache-Control', 'private, no-store');
        n();
    });
    const preview = run(async (r, s) => {
        const result = await previewPartnerImport(deps, actor(r), r.header('Idempotency-Key'), r.body);
        s.setHeader('Idempotency-Replayed', String(result.replayed));
        s.status(201).json(result.value);
    });
    router.post('/imports', preview);
    router.post('/imports/preview', preview);
    router.get('/imports/:importId', run(async (r, s) => {
        s.json(await readPartnerImport(deps, actor(r), r.params.importId));
    }));
    router.post('/imports/:importId/commit', run(async (r, s) => {
        const result = await commitPartnerImport(deps, actor(r), r.params.importId, r.header('Idempotency-Key'), r.body);
        s.setHeader('Idempotency-Replayed', String(result.replayed));
        s.status(202).json(result.value);
    }));
    return router;
}
