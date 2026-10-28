import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Database } from '../src/db/database.js';
import { openIsolatedTestDatabase } from './isolated-test-database.js';
import { migrate } from '../src/db/migrate.js';
import { insertUser } from '../src/domain/users.js';
import { appendAudit } from '../src/domain/audit.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { createInvitation } from '../src/domain/invitations.js';
import { createTransaction, updateTransaction, updateShipping } from '../src/domain/transactions.js';
import {
  PARTNER_SCOPES, addOrganizationMember, authenticatePartner, createDelegation, createIntegrationAccount,
  createOrganization, createServicePrincipal, issuePartnerCredential, revokeDelegation, setOrganizationEntitlement,
  type PartnerActor,
} from '../src/platform/organizations.js';
import { addPartnerBinding, importPartnerOrder, readPartnerProof } from '../src/platform/partner-proofs.js';
import { listEventStream } from '../src/platform/event-stream.js';
import {
  createPartnerProofSnapshot, readPartnerProofSnapshot, releasePartnerProofSnapshot,
} from '../src/platform/proof-snapshots.js';

describe('materialized merchant Proof reconciliation snapshots', () => {
  let opened: Awaited<ReturnType<typeof openIsolatedTestDatabase>>;
  const start = Date.now();
  let now = start, external = 0;
  const clock = { now: () => new Date(now) };
  const config = { signingKey: randomBytes(32).toString('base64') };
  let admin: string, operator: string, merchantA: string, merchantB: string, partner: string;
  let memberA: string, accountA: string, token: string;
  let actorA: PartnerActor, actorB: PartnerActor, rotatedActor: PartnerActor;
  const expiresAt = () => new Date(start + 7 * 86400000).toISOString();
  const createProof = (db = opened.db) => importPartnerOrder(db, clock, actorA, {
    integrationAccountId: accountA, externalId: 'snapshot-fixture-' + (++external),
    operatorMembershipId: memberA, transaction: { itemTitle: 'Synthetic snapshot parcel', quantity: 1 },
  });
  beforeAll(async () => {
    opened = await openIsolatedTestDatabase();
    await migrate(opened.db);
    admin = await insertUser(opened.db, clock);
    operator = await insertUser(opened.db, clock);
    await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",
      [admin, clock.now().toISOString()]);
    merchantA = (await createOrganization(opened.db, clock, admin, { kind: 'MERCHANT', name: 'Snapshot A' }, 'setup')).id;
    merchantB = (await createOrganization(opened.db, clock, admin, { kind: 'MERCHANT', name: 'Snapshot B' }, 'setup')).id;
    partner = (await createOrganization(opened.db, clock, admin, { kind: 'PARTNER', name: 'Snapshot partner' }, 'setup')).id;
    for (const id of [merchantA, merchantB, partner]) await setOrganizationEntitlement(opened.db, clock, admin, id, { enabled: true }, 'setup');
    memberA = String((await addOrganizationMember(opened.db, clock, admin, merchantA, { userId: operator, role: 'OPERATOR' }, 'setup')).id);
    accountA = (await createIntegrationAccount(opened.db, clock, admin, merchantA, { provider: 'snapshot-test', externalAccountId: 'snapshot-a' }, 'setup')).id;
    const principal = (await createServicePrincipal(opened.db, clock, admin, partner, { name: 'Synthetic snapshot adapter' }, 'setup')).id;
    token = (await issuePartnerCredential(opened.db, clock, admin, partner, principal, { scopes: [...PARTNER_SCOPES], expiresAt: expiresAt() }, 'setup')).token;
    const secondToken = (await issuePartnerCredential(opened.db, clock, admin, partner, principal, { scopes: [...PARTNER_SCOPES], expiresAt: expiresAt() }, 'setup')).token;
    const grantA = (await createDelegation(opened.db, clock, admin, merchantA, {
      partnerOrganizationId: partner, scopes: [...PARTNER_SCOPES], operatorUserIds: [operator], expiresAt: expiresAt(),
    }, 'setup')).id;
    const grantB = (await createDelegation(opened.db, clock, admin, merchantB, {
      partnerOrganizationId: partner, scopes: [...PARTNER_SCOPES], operatorUserIds: [], expiresAt: expiresAt(),
    }, 'setup')).id;
    actorA = await authenticatePartner(opened.db, clock, 'Bearer ' + token, merchantA, grantA, 'snapshot-test');
    actorB = await authenticatePartner(opened.db, clock, 'Bearer ' + token, merchantB, grantB, 'snapshot-test');
    rotatedActor = await authenticatePartner(opened.db, clock, 'Bearer ' + secondToken, merchantA, grantA, 'snapshot-test');
    await createProof(); await createProof(); await createProof();
  }, 60000);
  beforeEach(async () => {
    now = start;
    // Only these disposable test projections are removed; Proofs and evidence remain.
    await opened.db.query('DELETE FROM api_proof_snapshots');
    await opened.db.query('UPDATE api_event_stream_heads SET floor_position=0');
  });
  afterAll(async () => { await opened?.close(); });

  it('keeps every page stable while source records and newly imported Proofs change', async () => {
    const created = await createPartnerProofSnapshot(opened.db, clock, actorA, config, { pageSize: 1 });
    expect(created.rowCount).toBeGreaterThanOrEqual(3);
    const first = await readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config);
    expect(first.proofs).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const secondBefore = await readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config, { after: first.nextCursor });
    const target = secondBefore.proofs[0];
    const addedBinding = await addPartnerBinding(opened.db, clock, actorA, target.proofId, {
      integrationAccountId: accountA, resourceType: 'SHIPMENT', externalId: 'post-snapshot-shipment',
    });
    expect(addedBinding.created).toBe(true);
    await opened.db.transaction(async tx => {
      // A synthetic source command updates state and emits its outbox record in one transaction.
      await tx.query('UPDATE proofs SET version=version+1 WHERE id=$1', [target.proofId]);
      await appendAudit(tx, { proofId: target.proofId, actorUserId: operator, eventType: 'PROOF_ACCESSED', eventData: { synthetic: 'snapshot-concurrency' }, at: clock.now() });
    });
    const added = await createProof();
    const secondAfter = await readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config, { after: first.nextCursor });
    expect(secondAfter).toEqual(secondBefore);
    const latest = await readPartnerProof(opened.db, clock, actorA, target.proofId);
    expect(latest.proof.version).toBe(target.version + 1);
    const ids = first.proofs.map(p => p.proofId);
    let page = first;
    while (page.hasMore) {
      page = await readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config, { after: page.nextCursor });
      ids.push(...page.proofs.map(p => p.proofId));
    }
    expect(page.nextCursor).toBeNull();
    expect(new Set(ids).size).toBe(created.rowCount);
    expect(ids).not.toContain(added.proofId);
    const changes = await listEventStream(opened.db, clock, actorA, config, { after: created.eventCursor });
    const changedIds = changes.events.map(e => e.data.proofId);
    expect(changedIds).toContain(target.proofId);
    expect(changedIds).toContain(added.proofId);
    expect(changes.events).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'proof.external_binding_added', data: {proofId: target.proofId}}),
    ]));
    expect(secondAfter.proofs[0].externalBindings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({externalId: 'post-snapshot-shipment'}),
    ]));
  });

  it('discovers real invitation and order corrections after C without publishing generic read events', async () => {
    // This fixture uses the supported explicit-counterparty core path and the
    // same internal merchant assignment/binding used by the organization adapter.
    const required = await opened.db.transaction(async tx => {
      const transaction = await createTransaction(tx, clock, actorA.actorUserId, { itemTitle: 'Required counterparty fixture' });
      const proof = await createOrGetProof(tx, clock, actorA.actorUserId, transaction.transactionId, {
        participationPolicy: 'COUNTERPARTY_REQUIRED',
        organizationAssignment: { merchantId: merchantA, membershipId: memberA },
      });
      await tx.query('INSERT INTO platform_proof_ownership(proof_id,merchant_id,environment,operator_membership_id,origin_principal_id,origin_delegation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [proof.proofId, merchantA, actorA.environment, memberA, actorA.principalId, actorA.delegationGrantId, clock.now().toISOString()]);
      await tx.query('INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES($1,$2,$3,$4,$5)',
        [actorA.tenantId, 'required-fixture-' + proof.proofId, proof.proofId, 'synthetic-core-fixture', clock.now().toISOString()]);
      return proof;
    });
    const created = await createPartnerProofSnapshot(opened.db, clock, actorA, config);
    const page = await readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config);
    const before = page.proofs.find(p => p.proofId === required.proofId)!;
    expect(before.status).toBe('OPEN');
    now += 1000;
    await createInvitation(opened.db, clock, operator, required.proofId, { inviteeUserId: admin });
    await updateTransaction(opened.db, clock, actorA.actorUserId, required.transactionId, { itemTitle: 'Audited integration correction' });
    await updateShipping(opened.db, clock, actorA.actorUserId, required.transactionId, { carrier: 'UPS', trackingNumber: 'SNAPSHOT-CORRECTED-1001' });
    const current = await readPartnerProof(opened.db, clock, actorA, required.proofId);
    expect(current.proof.status).toBe('AWAITING_PARTICIPANT');
    expect(current.proof.transaction.itemTitle).toBe('Audited integration correction');
    expect(current.proof.transaction.shipping?.trackingNumber).toBe('SNAPSHOT-CORRECTED-1001');
    const repeated = await readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config);
    expect(repeated.proofs.find(p => p.proofId === required.proofId)).toEqual(before);
    const changes = await listEventStream(opened.db, clock, actorA, config, { after: created.eventCursor });
    expect(changes.events.filter(e => e.type === 'proof.updated' && e.data.proofId === required.proofId)).toHaveLength(3);
    const audit = await appendAudit(opened.db, {
      proofId: required.proofId, actorUserId: operator, eventType: 'PROOF_ACCESSED', eventData: {}, at: clock.now(),
    });
    expect((await opened.db.query("SELECT id FROM proof_outbox WHERE audit_id=$1 AND event_type='proof.updated'", [audit])).rows).toEqual([]);
    // A no-op correction does not invent another change or generic event.
    await updateTransaction(opened.db, clock, actorA.actorUserId, required.transactionId, { itemTitle: 'Audited integration correction' });
    const afterRead = await listEventStream(opened.db, clock, actorA, config, { after: changes.nextCursor });
    expect(afterRead.events.map(e => e.type)).toEqual(['proof.accessed']);
  });

  it('binds pages and metadata to merchant, credential, delegation, environment and both scopes', async () => {
    const created = await createPartnerProofSnapshot(opened.db, clock, actorA, config, { pageSize: 1 });
    const first = await readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config);
    await expect(readPartnerProofSnapshot(opened.db, clock, actorB, created.snapshotId, config)).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
    await expect(readPartnerProofSnapshot(opened.db, clock, rotatedActor, created.snapshotId, config)).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
    await expect(readPartnerProofSnapshot(opened.db, clock, { ...actorA, scopes: ['proofs:read'] }, created.snapshotId, config)).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
    const token = first.nextCursor!;
    await expect(readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config, {
      after: (token[0] === 'a' ? 'b' : 'a') + token.slice(1),
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(listEventStream(opened.db, clock, actorA, config, { after: token })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config, { after: created.eventCursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('does not let frozen rows bypass a revoked merchant delegation', async () => {
    const grant = (await createDelegation(opened.db, clock, admin, merchantA, {
      partnerOrganizationId: partner, scopes: [...PARTNER_SCOPES], operatorUserIds: [operator], expiresAt: expiresAt(),
    }, 'revocation-test')).id;
    const actor = await authenticatePartner(opened.db, clock, 'Bearer ' + token, merchantA, grant, 'revocation-test');
    const created = await createPartnerProofSnapshot(opened.db, clock, actor, config);
    await revokeDelegation(opened.db, clock, admin, merchantA, grant, 'revocation-test');
    await expect(readPartnerProofSnapshot(opened.db, clock, actor, created.snapshotId, config)).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
    await expect(releasePartnerProofSnapshot(opened.db, clock, actor, created.snapshotId)).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  });

  it('requires a new resync after expiry, signing-key rotation or event retention cutover', async () => {
    const created = await createPartnerProofSnapshot(opened.db, clock, actorA, config);
    await expect(readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, {
      signingKey: randomBytes(32).toString('base64'),
    })).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED', httpStatus: 410 });
    now += 3600001;
    await expect(readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config)).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED', httpStatus: 410 });
    now = start;
    await createProof();
    await opened.db.query('UPDATE api_event_stream_heads SET floor_position=position WHERE tenant_id=$1', [actorA.tenantId]);
    await expect(readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config)).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED', httpStatus: 410 });
  });

  it('enforces a hard snapshot quota, frees released slots and cleans only expired projections', async () => {
    const snapshots = [];
    for (let n = 0; n < 4; n++) snapshots.push(await createPartnerProofSnapshot(opened.db, clock, actorA, config));
    await expect(createPartnerProofSnapshot(opened.db, clock, actorA, config)).rejects.toMatchObject({ code: 'SNAPSHOT_LIMIT', httpStatus: 429 });
    await expect(releasePartnerProofSnapshot(opened.db, clock, actorB, snapshots[0].snapshotId)).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
    await releasePartnerProofSnapshot(opened.db, clock, actorA, snapshots[0].snapshotId);
    const replacement = await createPartnerProofSnapshot(opened.db, clock, actorA, config);
    expect(replacement.rowCount).toBe(snapshots[0].rowCount);
    now += 3600001;
    const fresh = await createPartnerProofSnapshot(opened.db, clock, actorA, config);
    expect(fresh.rowCount).toBe(replacement.rowCount);
    expect((await opened.db.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM api_proof_snapshots')).rows[0].count).toBe(1);
  });

  it('rejects invalid or excessive input and refuses partial/corrupt snapshots', async () => {
    for (const pageSize of [0, 101, 1.5, '50'])
      await expect(createPartnerProofSnapshot(opened.db, clock, actorA, config, { pageSize })).rejects.toMatchObject({ code: 'INVALID_LIMIT' });
    await expect(createPartnerProofSnapshot(opened.db, clock, actorA, config, { merchantId: merchantB })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const created = await createPartnerProofSnapshot(opened.db, clock, actorA, config);
    await expect(opened.db.query("UPDATE api_proof_snapshot_rows SET row_data='{}' WHERE snapshot_id=$1", [created.snapshotId])).rejects.toThrow('PLATFORM_RECORD_IMMUTABLE');
    await opened.db.query('DELETE FROM api_proof_snapshot_rows WHERE snapshot_id=$1 AND ordinal=1', [created.snapshotId]);
    await expect(readPartnerProofSnapshot(opened.db, clock, actorA, created.snapshotId, config)).rejects.toMatchObject({ code: 'SNAPSHOT_INCOMPLETE' });
  });

  it.skipIf(!process.env.PACKPROOF_TEST_DATABASE_URL)('uses one real PostgreSQL repeatable-read snapshot across the cutover boundary', async () => {
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(r => { release = r; }), boundaryRead = new Promise<void>(r => { reached = r; });
    let pausedOnce = false;
    const paused: Database = {
      query: opened.db.query.bind(opened.db),
      transaction: fn => opened.db.transaction(async tx => {
        const wrapped: Database = {
          query: async <T>(sql: string, params: unknown[] = []) => {
            const result = await tx.query<T>(sql, params);
            if (!pausedOnce && sql.startsWith('SELECT position::text FROM api_event_stream_heads')) {
              pausedOnce = true; reached(); await held;
            }
            return result;
          },
          transaction: inner => inner(wrapped),
        };
        return fn(wrapped);
      }),
    };
    const pending = createPartnerProofSnapshot(paused, clock, actorA, config);
    let added: Awaited<ReturnType<typeof createProof>> | undefined;
    try {
      await boundaryRead;
      added = await createProof();
    } finally { release(); }
    const snapshot = await pending;
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const page = await readPartnerProofSnapshot(opened.db, clock, actorA, snapshot.snapshotId, config, { after });
      ids.push(...page.proofs.map(p => p.proofId));
      after = page.nextCursor ?? undefined;
    } while (after);
    expect(ids).not.toContain(added!.proofId);
    const changes = await listEventStream(opened.db, clock, actorA, config, { after: snapshot.eventCursor });
    expect(changes.events.map(e => e.data.proofId)).toContain(added!.proofId);
  }, 60000);

  it('rejects oversized binding work before SQL JSON materialization', async () => {
    const proof = await createProof();
    // A bounded bulk fixture models an over-budget source namespace; no media,
    // finalized manifest or human attestation is invented.
    await opened.db.query("INSERT INTO platform_external_bindings(merchant_id,environment,integration_account_id,resource_type,external_id,proof_id,snapshot_sha256,created_at) SELECT $1,$2,$3,'SHIPMENT','budget-fixture-' || n::text,$4,$5,$6 FROM generate_series(1,256) AS n",
      [merchantA, actorA.environment, accountA, proof.proofId, '0'.repeat(64), clock.now().toISOString()]);
    let constructedJson = false;
    const observe = (base: Database): Database => ({
      query: async <T>(sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO api_proof_snapshot_rows')) constructedJson = true;
        return base.query<T>(sql, params);
      },
      transaction: fn => base.transaction(tx => fn(observe(tx))),
    });
    await expect(createPartnerProofSnapshot(observe(opened.db), clock, actorA, config)).rejects.toMatchObject({code: 'SNAPSHOT_TOO_LARGE', httpStatus: 413});
    expect(constructedJson).toBe(false);
    expect((await opened.db.query<{count: number}>('SELECT COUNT(*)::integer AS count FROM api_proof_snapshots')).rows[0].count).toBe(0);
  });
});
