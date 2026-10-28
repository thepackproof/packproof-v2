import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from './in-process-http.js';
import { createHarness, createUser, auth, type TestHarness } from './helpers.js';
import { createDeveloper } from './developer-fixtures.js';
import { API_SCOPES, createTenant, issueApiKey } from '../src/platform/tenants.js';
import {
  PARTNER_SCOPES, createOrganization, setOrganizationEntitlement,
  addOrganizationMember, createServicePrincipal, issuePartnerCredential,
  createDelegation, revokeDelegation, revokePartnerCredential, createIntegrationAccount,
} from '../src/platform/organizations.js';

/** Exercise the production-facing app/router composition. Domain-specific tests
 * separately establish PostgreSQL concurrency and physical capture guarantees. */
describe('API/client route composition and immutable intake', () => {
  let h: TestHarness;
  let sequence = 0;
  const clock = { now: () => new Date('2026-10-28T12:00:00.000Z') };
  const next = (prefix: string) => prefix + '-' + (++sequence);
  const expiry = () => new Date(clock.now().getTime() + 86400000).toISOString();
  const atomicTitle = 'Atomic multi-item routing fixture';
  const lines = () => [
    { externalItemId: 'line-a', title: 'First authoritative item', quantity: 2, unitValue: 10.125, currency: 'USD' },
    { externalItemId: 'line-b', title: 'Second authoritative item', quantity: 3, unitValue: 4, currency: 'USD' },
  ];

  beforeAll(async () => {
    vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED', 'true');
    vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY', Buffer.alloc(32, 41).toString('base64'));
    vi.stubEnv('PACKPROOF_WEBHOOK_ENCRYPTION_KEY', Buffer.alloc(32, 42).toString('base64'));
    vi.stubEnv('PACKPROOF_WEBHOOK_HOSTS', 'hooks.example.com');
    h = await createHarness(clock);
    // This is a test-only assertion on a tagged transaction, not a new product
    // invariant. It detects insertion after Proof creation even if the final
    // database contents happen to look correct.
    await h.db.query(`
      CREATE FUNCTION test_api_client_items_precede_root() RETURNS trigger LANGUAGE plpgsql AS $api_client_fixture$
      BEGIN
        IF EXISTS(SELECT 1 FROM transactions t WHERE t.id=NEW.transaction_id
          AND t.item_title='Atomic multi-item routing fixture') THEN
          IF (SELECT COUNT(*) FROM transaction_items i WHERE i.transaction_id=NEW.transaction_id)<>2 THEN
            RAISE EXCEPTION 'TEST_ITEMS_MUST_PRECEDE_CANONICAL_ROOT';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $api_client_fixture$;
    `);
    await h.db.query(`
      CREATE TRIGGER test_api_client_items_precede_root
        BEFORE INSERT ON proofs FOR EACH ROW
        EXECUTE FUNCTION test_api_client_items_precede_root();
    `);
  }, 60000);

  afterAll(async () => {
    await h?.close();
    vi.unstubAllEnvs();
  });

  async function tenant(owner?: string) {
    const user = owner ?? await createDeveloper(h);
    const created = await createTenant(h.db, clock, user, { name: next('routing-tenant'), environment: 'sandbox' });
    const tenantId = String(created.id);
    const issued = await issueApiKey(h.db, clock, user, tenantId, { name: 'routing fixture', scopes: API_SCOPES });
    return { owner: user, tenantId, token: issued.token };
  }

  const post = (token: string, key: string, body: unknown) => request(h.app)
    .post('/v1/proofs').set(auth(token)).set('Idempotency-Key', key).send(body);

  it('stores every authoritative line before the legacy route creates its single canonical root', async () => {
    const t = await tenant();
    const body = { externalId: next('atomic-order'), transaction: { itemTitle: atomicTitle, items: lines() } };
    const created = await post(t.token, next('create-atomic'), body);
    expect(created.status, created.text).toBe(201);
    const id = created.body.proof.proofId as string;
    const transactionId = created.body.proof.transactionId as string;
    const rows = await h.db.query<{
      external_item_id: string; title: string; quantity: string | number;
      unit_value: string | number; currency: string; position: number;
    }>('SELECT external_item_id,title,quantity,unit_value,currency,position FROM transaction_items WHERE transaction_id=$1 ORDER BY position', [transactionId]);
    expect(rows.rows.map(row => ({
      id: row.external_item_id, title: row.title, quantity: Number(row.quantity),
      unitValue: Number(row.unit_value), currency: row.currency, position: row.position,
    }))).toEqual([
      { id: 'line-a', title: 'First authoritative item', quantity: 2, unitValue: 10.125, currency: 'USD', position: 1 },
      { id: 'line-b', title: 'Second authoritative item', quantity: 3, unitValue: 4, currency: 'USD', position: 2 },
    ]);
    const stored = await h.db.query<{ quantity: string | number }>('SELECT quantity FROM transactions WHERE id=$1', [transactionId]);
    expect(Number(stored.rows[0].quantity)).toBe(5);
    const roots = await h.db.query<{ id: string }>('SELECT id FROM proofs WHERE transaction_id=$1', [transactionId]);
    expect(roots.rows).toEqual([{ id }]);
    expect(created.body.proof.transaction.items.map((item: { externalItemId: string }) => item.externalItemId)).toEqual(['line-a', 'line-b']);
  });

  it('keeps retry identity and rejects a changed second line under replay or permanent external binding', async () => {
    const t = await tenant();
    const key = next('replay-items');
    const body = { externalId: next('items-replay-order'), transaction: { itemTitle: 'Complete item snapshot', items: lines() } };
    const original = await post(t.token, key, body);
    expect(original.status, original.text).toBe(201);
    const replay = await post(t.token, key, body);
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body).toEqual(original.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const anotherKey = await post(t.token, next('same-items'), body);
    expect(anotherKey.status, anotherKey.text).toBe(201);
    expect(anotherKey.body.proof.proofId).toBe(original.body.proof.proofId);

    const changedLines = lines();
    changedLines[1] = { ...changedLines[1], title: 'Changed second authoritative item' };
    const changed = { ...body, transaction: { ...body.transaction, items: changedLines } };
    const replayConflict = await post(t.token, key, changed);
    expect(replayConflict.status, replayConflict.text).toBe(409);
    expect(replayConflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const bindingConflict = await post(t.token, next('changed-items'), changed);
    expect(bindingConflict.status, bindingConflict.text).toBe(409);
    expect(bindingConflict.body.error.code).toBe('EXTERNAL_ID_CONFLICT');
    const stored = await h.db.query<{ title: string }>('SELECT title FROM transaction_items WHERE transaction_id=$1 ORDER BY position', [original.body.proof.transactionId]);
    expect(stored.rows.map(row => row.title)).toEqual(['First authoritative item', 'Second authoritative item']);
  });

  it('rejects an inconsistent summary quantity without leaving an order binding or partial transaction', async () => {
    const t = await tenant();
    const key = next('quantity-key'), externalId = next('quantity-order'), title = next('quantity-rollback');
    const denied = await post(t.token, key, { externalId, transaction: { itemTitle: title, quantity: 99, items: lines() } });
    expect(denied.status, denied.text).toBe(400);
    expect(denied.body.error.code).toBe('INVALID_TRANSACTION_ITEMS');
    expect((await h.db.query('SELECT proof_id FROM api_tenant_proofs WHERE tenant_id=$1 AND external_id=$2', [t.tenantId, externalId])).rows).toHaveLength(0);
    expect((await h.db.query('SELECT id FROM transactions WHERE item_title=$1', [title])).rows).toHaveLength(0);
    // A rejected mutation does not reserve the key or create a contradictory
    // permanent binding: the corrected command can use the original key.
    const corrected = await post(t.token, key, { externalId, transaction: { itemTitle: title, quantity: 5, items: lines() } });
    expect(corrected.status, corrected.text).toBe(201);
  });

  it('does not let caller-supplied tenant headers authenticate an unknown key or widen a valid key', async () => {
    const a = await tenant(), b = await tenant(a.owner);
    const externalId = next('private-reference'), title = next('private-title');
    const created = await post(a.token, next('private-create'), { externalId, transaction: { itemTitle: title, quantity: 1 } });
    expect(created.status, created.text).toBe(201);
    const id = created.body.proof.proofId as string;
    const unknown = 'pp_sandbox_' + 'x'.repeat(43);
    const spoofed = await request(h.app).get('/v1/proofs/search').query({ q: externalId })
      .set(auth(unknown)).set('PackProof-Tenant-Id', a.tenantId).set('PackProof-Merchant-Id', a.tenantId);
    expect(spoofed.status, spoofed.text).toBe(401);
    expect(spoofed.text).not.toContain(id);
    expect(spoofed.text).not.toContain(title);
    const otherTenant = await request(h.app).get('/v1/proofs/search').query({ q: externalId })
      .set(auth(b.token)).set('PackProof-Tenant-Id', a.tenantId).set('PackProof-Merchant-Id', a.tenantId);
    expect(otherTenant.status, otherTenant.text).toBe(200);
    expect(otherTenant.body.schema).toBe('packproof.proof-search/v1');
    expect(otherTenant.body.proofs).toEqual([]);
    const direct = await request(h.app).get('/v1/proofs/' + id).set(auth(b.token)).set('PackProof-Tenant-Id', a.tenantId);
    expect(direct.status, direct.text).toBe(404);
  });

  it('reaches first-party search through app authentication without accepting a server API key as a person', async () => {
    const t = await tenant(), stranger = await createUser(h);
    const externalId = next('person-search');
    const created = await post(t.token, next('person-create'), { externalId, transaction: { itemTitle: 'First-party routing', quantity: 1 } });
    expect(created.status, created.text).toBe(201);
    expect((await request(h.app).get('/me/proofs/search')).status).toBe(401);
    expect((await request(h.app).get('/me/proofs/search').set(auth(t.token))).status).toBe(401);
    const owner = await request(h.app).get('/me/proofs/search').set(auth(t.owner)).query({ q: externalId });
    expect(owner.status, owner.text).toBe(200);
    expect(owner.body.schema).toBe('packproof.proof-search/v1');
    expect(owner.body.proofs.map((proof: { proofId: string }) => proof.proofId)).toEqual([created.body.proof.proofId]);
    const crossed = await request(h.app).get('/me/proofs/search').set(auth(stranger)).query({ q: externalId });
    expect(crossed.status, crossed.text).toBe(200);
    expect(crossed.body.proofs).toEqual([]);
  });

  it.each([null, { status: 'FINALIZED', finalizedAt: null, readiness: { state: 'READY', preserved: true } }])(
    'does not promote null or caller-declared metadata into canonical completion or Ready (%j)',
    async metadata => {
      const t = await tenant();
      const externalId = next('metadata-only');
      const created = await post(t.token, next('metadata-create'), { externalId, transaction: { itemTitle: 'Metadata is context', metadata } });
      expect(created.status, created.text).toBe(201);
      expect(created.body.proof.status).toBe('READY_FOR_EVIDENCE');
      expect(created.body.proof.finalizedAt).toBeNull();
      const found = await request(h.app).get('/v1/proofs/search').set(auth(t.token)).query({ q: externalId });
      expect(found.status, found.text).toBe(200);
      expect(found.body.proofs).toHaveLength(1);
      expect(found.body.proofs[0].status).toBe('READY_FOR_EVIDENCE');
      expect(found.body.proofs[0].readiness).toMatchObject({ state: 'AWAITING_CAPTURE', preserved: false });
    },
  );

  it('does not replay a legacy rotation secret after its subscription is revoked', async () => {
    const t = await tenant();
    const created = await request(h.app).post('/v1/webhooks').set(auth(t.token))
      .set('Idempotency-Key', next('legacy-hook-create'))
      .send({ url: 'https://hooks.example.com/routing', eventTypes: ['proof.created'] });
    // Keep response bodies out of assertion messages: they contain one-time secrets.
    expect(created.status).toBe(201);
    const path = '/v1/webhooks/' + created.body.id;
    const rotationKey = next('legacy-hook-rotate');
    const rotated = await request(h.app).post(path + '/rotate-secret').set(auth(t.token))
      .set('Idempotency-Key', rotationKey).send({});
    expect(rotated.status).toBe(201);
    expect(typeof rotated.body.secret).toBe('string');
    const revoked = await request(h.app).delete(path).set(auth(t.token))
      .set('Idempotency-Key', next('legacy-hook-revoke')).send({});
    expect(revoked.status).toBe(200);
    const replay = await request(h.app).post(path + '/rotate-secret').set(auth(t.token))
      .set('Idempotency-Key', rotationKey).send({});
    expect(replay.status).toBe(404);
    expect(replay.body.error.code).toBe('WEBHOOK_NOT_FOUND');
    expect(Object.prototype.hasOwnProperty.call(replay.body, 'secret')).toBe(false);
  });

  async function partnerFixture() {
    const admin = await createDeveloper(h), owner = await createUser(h), operator = await createUser(h);
    const merchant = (await createOrganization(h.db, clock, admin, { kind: 'MERCHANT', name: next('merchant'), ownerUserId: owner }, 'routing-setup')).id;
    const partner = (await createOrganization(h.db, clock, admin, { kind: 'PARTNER', name: next('partner') }, 'routing-setup')).id;
    for (const id of [merchant, partner]) await setOrganizationEntitlement(h.db, clock, admin, id, { enabled: true }, 'routing-setup');
    const member = String((await addOrganizationMember(h.db, clock, owner, merchant, { userId: operator, role: 'OPERATOR' }, 'routing-setup')).id);
    const principal = (await createServicePrincipal(h.db, clock, admin, partner, { name: 'routing service' }, 'routing-setup')).id;
    const issue = () => issuePartnerCredential(h.db, clock, admin, partner, principal, { scopes: [...PARTNER_SCOPES], expiresAt: expiry() }, 'routing-setup');
    const credential = await issue();
    const grant = (await createDelegation(h.db, clock, owner, merchant, { partnerOrganizationId: partner, scopes: [...PARTNER_SCOPES], operatorUserIds: [operator], expiresAt: expiry() }, 'routing-setup')).id;
    const account = (await createIntegrationAccount(h.db, clock, owner, merchant, { provider: 'routing-fixture', externalAccountId: next('store') }, 'routing-setup')).id;
    const headers = (token = credential.token) => ({ Authorization: 'Bearer ' + token, 'PackProof-Merchant-Id': merchant, 'PackProof-Delegation-Id': grant });
    const created = await request(h.app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key', next('partner-create'))
      .send({ integrationAccountId: account, externalId: next('partner-order'), operatorMembershipId: member, transaction: { itemTitle: 'Delegated routing Proof', quantity: 1 } });
    expect(created.status, created.text).toBe(201);
    const machine = (await h.db.query<{ actor_user_id: string }>('SELECT actor_user_id FROM platform_principals WHERE id=$1', [principal])).rows[0].actor_user_id;
    return { admin, owner, operator, merchant, partner, principal, grant, credential, issue, headers, machine, proofId: created.body.proofId as string };
  }

  it('wires partner search and disposable reconciliation snapshot routes through the full app', async () => {
    const fixture = await partnerFixture();
    const search = await request(h.app).get('/v1/partner/proofs/search').set(fixture.headers()).query({ q: fixture.proofId });
    expect(search.status, search.text).toBe(200);
    expect(search.body.proofs.map((proof: { proofId: string }) => proof.proofId)).toEqual([fixture.proofId]);
    // No idempotency wrapper/outer transaction: snapshot creation owns the fresh
    // REPEATABLE READ transaction. Its lower-level tests verify concurrent C.
    const created = await request(h.app).post('/v1/partner/proof-snapshots').set(fixture.headers()).send({ pageSize: 1 });
    expect(created.status, created.text).toBe(201);
    expect(created.body.schemaVersion).toBe('packproof.proof-snapshot/v1');
    expect(created.body.rowCount).toBe(1);
    expect(typeof created.body.eventCursor).toBe('string');
    const path = '/v1/partner/proof-snapshots/' + created.body.snapshotId;
    const page = await request(h.app).get(path).set(fixture.headers());
    expect(page.status, page.text).toBe(200);
    expect(page.body.proofs.map((proof: { proofId: string }) => proof.proofId)).toEqual([fixture.proofId]);
    expect(page.body.eventCursor).toBe(created.body.eventCursor);
    expect(page.body.hasMore).toBe(false);
    expect(page.body.nextCursor).toBeNull();
    // Disposable projections have no replay cache or required idempotency key.
    const released = await request(h.app).delete(path).set(fixture.headers()).send({});
    expect(released.status, released.text).toBe(200);
    expect(released.body).toMatchObject({ snapshotId: created.body.snapshotId, released: true });
    const repeated = await request(h.app).delete(path).set(fixture.headers()).set('Idempotency-Key', next('ignored-release-key')).send({});
    expect(repeated.status, repeated.text).toBe(404);
    const unavailable = await request(h.app).get(path).set(fixture.headers());
    expect(unavailable.status, unavailable.text).toBe(404);
  });

  it('permits scoped partner recovery without making the service actor a first-party participant', async () => {
    const fixture = await partnerFixture();
    const path = '/v1/partner/proofs/' + fixture.proofId + '/recovery';
    const delegated = await request(h.app).get(path).set(fixture.headers());
    expect(delegated.status, delegated.text).toBe(200);
    expect(delegated.body.proofId).toBe(fixture.proofId);
    expect(delegated.body.evidence).toEqual([]);
    expect(delegated.body.declarations).toEqual([]);
    expect(delegated.body.finalization).toMatchObject({ status: 'LEGACY_UNCONFIRMED' });
    const directMachine = await request(h.app).get('/proofs/' + fixture.proofId + '/recovery').set(auth(fixture.machine));
    expect(directMachine.status, directMachine.text).toBe(403);
    expect((await h.db.query('SELECT id FROM proof_participants WHERE proof_id=$1 AND user_id=$2', [fixture.proofId, fixture.machine])).rows).toHaveLength(0);
    const missing = await request(h.app).get('/v1/partner/proofs/proof_missing_routing/recovery').set(fixture.headers());
    expect(missing.status, missing.text).toBe(404);

    const replacement = await fixture.issue();
    await revokePartnerCredential(h.db, clock, fixture.admin, fixture.partner, fixture.credential.id, 'routing-revoke');
    const revoked = await request(h.app).get(path).set(fixture.headers());
    expect(revoked.status, revoked.text).toBe(401);
    const permittedReplacement = await request(h.app).get(path).set(fixture.headers(replacement.token));
    expect(permittedReplacement.status, permittedReplacement.text).toBe(200);
    await revokeDelegation(h.db, clock, fixture.owner, fixture.merchant, fixture.grant, 'routing-revoke');
    const revokedGrant = await request(h.app).get(path).set(fixture.headers(replacement.token));
    expect(revokedGrant.status, revokedGrant.text).toBe(404);
    // A revoked partner grant does not erase the merchant operator's independent
    // current participant authority or the already accepted source record.
    const operator = await request(h.app).get('/proofs/' + fixture.proofId + '/recovery').set(auth(fixture.operator));
    expect(operator.status, operator.text).toBe(200);
  });
});
