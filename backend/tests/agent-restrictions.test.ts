import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from './in-process-http.js';
import { openIsolatedTestDatabase } from './isolated-test-database.js';
import { migrate } from '../src/db/migrate.js';
import { sha256Hex } from '../src/hash.js';
import { canonicalize } from '../src/canonical.js';
import { insertUser } from '../src/domain/users.js';
import { MemoryObjectStore } from './memory-object-store.js';
import { createOrganization, setOrganizationEntitlement, createServicePrincipal, issuePartnerCredential, createIntegrationAccount, authenticatePartner, reauthorizePartner, authorizePartnerProof, PARTNER_SCOPES, type PartnerActor } from '../src/platform/organizations.js';
import { previewPartnerImport, commitPartnerImport, readPartnerImport, processPendingPartnerImports } from '../src/records/partner-imports.js';
import { authorizeAgentRoute, type AgentApprovedConfig } from '../src/records/agent-restrictions.js';
import type { AppDependencies } from '../src/app.js';
import type { Database } from '../src/db/database.js';
import { createPartnerRouter } from '../src/platform/partner-router.js';

class OriginalStore extends MemoryObjectStore {
  async putIfAbsent(key: string, body: Buffer, contentType: string) {
    if (await this.get(key)) return { created: false };
    await this.put(key, body, contentType); return { created: true };
  }
  async digest(key: string) { const digest = await super.digest(key); return digest ? { ...digest, versionId: 'immutable-test-version' } : null; }
}
let opened: Awaited<ReturnType<typeof openIsolatedTestDatabase>>, deps: AppDependencies, actor: PartnerActor, unrestricted: PartnerActor;
let owner: string, organization: string, account: string, otherAccount: string, member: string, credentialId: string, principalId: string;
let config: AgentApprovedConfig, sequence = 0;
let authorization: string;
const clock = { now: () => new Date('2026-11-06T13:00:00Z') }, installation = 'agent-restriction-fixture';
const csv = (suffix = '', location = '') => `Shipment reference,Description,Quantity,Location\r\n000-${++sequence}${suffix},Parcel,1,${location}\r\n`;
const input = (text = csv()) => ({ integrationAccountId: account, operatorMembershipId: member, sourceName: 'Approved warehouse', mapping: config.mapping, timeZone: 'UTC', csv: text });
const preview = async () => (await previewPartnerImport(deps, actor, `preview-${sequence}`, input())).value;
beforeAll(async () => {
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED', 'true');
  opened = await openIsolatedTestDatabase(); await migrate(opened.db);
  const developer = await insertUser(opened.db, clock); owner = await insertUser(opened.db, clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')", [developer, clock.now().toISOString()]);
  organization = (await createOrganization(opened.db, clock, developer, { kind: 'MERCHANT', name: 'Restricted warehouse', ownerUserId: owner }, 'setup')).id;
  await setOrganizationEntitlement(opened.db, clock, developer, organization, { enabled: true }, 'setup');
  member = String((await opened.db.query('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2', [organization, owner])).rows[0].id);
  account = (await createIntegrationAccount(opened.db, clock, owner, organization, { provider: 'csv', externalAccountId: 'agent-restricted-source' }, 'setup')).id;
  otherAccount = (await createIntegrationAccount(opened.db, clock, owner, organization, { provider: 'csv', externalAccountId: 'agent-other-source' }, 'setup')).id;
  const principal = await createServicePrincipal(opened.db, clock, owner, organization, { name: 'Restricted fixture' }, 'setup'); principalId = principal.id;
  const credential = await issuePartnerCredential(opened.db, clock, owner, organization, principalId, { scopes: [...PARTNER_SCOPES], expiresAt: '2026-12-01T00:00:00Z' }, 'setup'); credentialId = credential.id;
  authorization = `Bearer ${credential.token}`;
  actor = await authenticatePartner(opened.db, clock, `Bearer ${credential.token}`, organization, undefined, 'restricted-test');
  const genericPrincipal = await createServicePrincipal(opened.db, clock, owner, organization, { name: 'Unrestricted fixture' }, 'setup');
  const generic = await issuePartnerCredential(opened.db, clock, owner, organization, genericPrincipal.id, { scopes: [...PARTNER_SCOPES], expiresAt: '2026-12-01T00:00:00Z' }, 'setup');
  unrestricted = await authenticatePartner(opened.db, clock, `Bearer ${generic.token}`, organization, undefined, 'generic-test');
  config = { folderDigest: 'a'.repeat(64), sourceName: 'Approved warehouse', integrationAccountId: account, operatorMembershipId: member, locationId: null, mapping: { shipmentReference: 'Shipment reference', itemTitle: 'Description', quantity: 'Quantity', locationId: 'Location' }, timeZone: 'UTC', importValidRows: false, offlineWindowHours: 24 };
  const now = clock.now().toISOString();
  await opened.db.query(`INSERT INTO record_agent_installations(id,organization_id,environment,principal_id,credential_id,integration_account_id,operator_membership_id,location_id,source_name,device_name,version,status,config_revision,approved_config,config_sha256,approval_user_id,created_at,updated_at,enrollment_acknowledged_at,enrollment_expires_at)
    VALUES($1,$2,'sandbox',$3,$4,$5,$6,NULL,$7,'Fixture PC','0.1.0','ready',1,$8::jsonb,$11,$9,$10,$10,$10,'2026-11-06T13:10:00Z')`, [installation, organization, principalId, credentialId, account, member, config.sourceName, JSON.stringify(config), owner, now, sha256Hex(canonicalize(config))]);
  deps = { db: opened.db, clock, objectStore: new OriginalStore(), devAuth: true, testFixtures: true } as AppDependencies;
}, 90000);
beforeEach(async () => {
  await opened.db.query("UPDATE record_agent_installations SET status='ready',config_revision=1,approved_config=$2::jsonb,config_sha256=$4,test_import_id=NULL,verified_import_id=NULL,enrollment_acknowledged_at=$3,enrollment_expires_at='2026-11-06T13:10:00Z',renewal_credential_id=NULL,renewal_expires_at=NULL WHERE id=$1", [installation, JSON.stringify(config), clock.now().toISOString(),sha256Hex(canonicalize(config))]);
});
afterAll(async () => { await opened?.close(); vi.unstubAllEnvs(); });

it('denies broad partner operations even when the underlying credential has every scope', async () => {
  for (const [method, path] of [['GET','/proofs'], ['POST','/proofs'], ['GET','/proofs/resolve'], ['POST','/imports'], ['GET','/event-stream'], ['POST','/webhooks'], ['GET','/proofs/guessed/package'], ['POST','/proofs/guessed/capture-intents'], ['GET','/records'], ['POST','/agent/execute']] as const)
    await expect(authorizeAgentRoute(opened.db, clock, actor, method, path)).rejects.toMatchObject({ code: 'AGENT_OPERATION_DENIED' });
  await expect(reauthorizePartner(opened.db, clock, actor, 'exports:read')).rejects.toMatchObject({ code: 'AGENT_OPERATION_DENIED' });
  await expect(authorizeAgentRoute(opened.db, clock, unrestricted, 'GET', '/proofs')).resolves.toBeUndefined();
});
it('enforces the restriction before the existing mounted partner handlers', async () => {
  const app = express(); app.use(express.json()); app.use('/v1/partner', createPartnerRouter(deps));
  for (const path of ['/v1/partner/proofs', '/v1/partner/event-stream', '/v1/partner/proofs/resolve']) {
    const denied = await request(app).get(path).set('Authorization', authorization);
    expect(denied.status, denied.text).toBe(403); expect(denied.body.code).toBe('AGENT_OPERATION_DENIED');
  }
  const missing = await request(app).get('/v1/partner/imports/not-existing').set('Authorization', authorization);
  expect(missing.status, missing.text).toBe(404); expect(missing.body.code).toBe('IMPORT_NOT_FOUND');
});
it('does not refresh the offline source-read policy after operator or location authority changes', async () => {
  const checks = async (tx: Database) => {
    const app = express(); app.use(express.json()); app.use('/v1/partner', createPartnerRouter({...deps,db:tx}));
    await expect(reauthorizePartner(tx, clock, actor, 'imports:read')).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
    const configuration = await request(app).get('/v1/partner/agent/config').set('Authorization', authorization);
    expect(configuration.status, configuration.text).toBe(403); expect(configuration.body.code).toBe('AGENT_AUTHORIZATION_REQUIRED');
    const heartbeat = await request(app).post('/v1/partner/agent/heartbeat').set('Authorization', authorization).send({ version: '0.1.0', queueCount: 0 });
    expect(heartbeat.status, heartbeat.text).toBe(403); expect(heartbeat.body.code).toBe('AGENT_AUTHORIZATION_REQUIRED');
    expect((await tx.query('SELECT last_seen_at FROM record_agent_installations WHERE id=$1', [installation])).rows[0].last_seen_at).toBeNull();
  };
  const rollback = new Error('Rollback authority fixture');
  // Production authority rows are immutable after revocation. Exercise each
  // change in a rolled-back transaction rather than resurrecting a membership.
  await expect(opened.db.transaction(async tx => {
    await tx.query('UPDATE platform_memberships SET revoked_at=$2 WHERE id=$1', [member,clock.now().toISOString()]);
    await checks(tx); throw rollback;
  })).rejects.toBe(rollback);
  await expect(opened.db.transaction(async tx => {
    const scopedUser = await insertUser(tx,clock);
    await tx.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,location_scoped,created_at) VALUES('new-scoped-operator',$1,$2,'OPERATOR',true,$3)",[organization,scopedUser,clock.now().toISOString()]);
    await tx.query("UPDATE record_agent_installations SET operator_membership_id='new-scoped-operator' WHERE id=$1",[installation]);
    await checks(tx); throw rollback;
  })).rejects.toBe(rollback);
  await expect(opened.db.transaction(async tx => {
    await tx.query("UPDATE users SET status='DISABLED' WHERE id=$1", [owner]);
    await checks(tx); throw rollback;
  })).rejects.toBe(rollback);
});
it('keeps initial enrollment setup-only and rejects another token on the same principal', async () => {
  await opened.db.query("UPDATE record_agent_installations SET status='setup',approved_config=NULL,config_sha256=NULL,config_revision=0 WHERE id=$1", [installation]);
  await expect(previewPartnerImport(deps, actor, 'setup-only', input())).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
  const replacement = await issuePartnerCredential(opened.db, clock, owner, organization, principalId, { scopes: [...PARTNER_SCOPES], expiresAt: '2026-12-01T00:00:00Z' }, 'replacement');
  const different = await authenticatePartner(opened.db, clock, `Bearer ${replacement.token}`, organization, undefined, 'different');
  await expect(reauthorizePartner(opened.db, clock, different, 'imports:read')).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
  await expect(reauthorizePartner(opened.db, clock, { ...actor, merchantId: 'another-org' }, 'imports:read')).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
});
it('checks exact approved source, operator, mapping and time zone before preserving a preview', async () => {
  for (const changed of [{integrationAccountId:otherAccount}, {operatorMembershipId:'another-member'}, {sourceName:'Another source'}, {timeZone:'America/New_York'}, {mapping:{shipmentReference:'Shipment reference'}}])
    await expect(previewPartnerImport(deps, actor, `changed-${++sequence}`, { ...input(), ...changed })).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
  await expect(previewPartnerImport(deps, actor, 'location-hidden-in-invalid-row', input('Shipment reference,Description,Quantity,Location\r\nILLEGAL,Parcel,not-a-number,other-location\r\n'))).rejects.toMatchObject({ code: 'AGENT_LOCATION_DENIED' });
});
it('requires human approval of the exact test batch and reconciles the accepted record', async () => {
  const p = await preview(), second = await preview();
  await expect(commitPartnerImport(deps, actor, p.id, 'unapproved-test', { previewVersion: p.previewVersion, importValidRows: false })).rejects.toMatchObject({ code: 'AGENT_TEST_APPROVAL_REQUIRED' });
  await opened.db.query('UPDATE record_agent_installations SET test_import_id=$2 WHERE id=$1', [installation, p.id]);
  await expect(commitPartnerImport(deps, actor, second.id, 'different-test', { previewVersion: second.previewVersion, importValidRows: false })).rejects.toMatchObject({ code: 'AGENT_TEST_APPROVAL_REQUIRED' });
  await expect(commitPartnerImport(deps, actor, p.id, 'changed-partial-policy', { previewVersion: p.previewVersion, importValidRows: true })).rejects.toMatchObject({ code: 'AGENT_IMPORT_POLICY_CHANGED' });
  await commitPartnerImport(deps, actor, p.id, 'approved-test', { previewVersion: p.previewVersion, importValidRows: false });
  expect(await processPendingPartnerImports(deps)).toEqual({ processed: 1, failed: 0 });
  const done = await readPartnerImport(deps, actor, p.id); expect(done.state).toBe('succeeded'); expect(done.recordIds).toHaveLength(1);
  await expect(authorizePartnerProof(opened.db, clock, actor, done.recordIds[0], 'proofs:read')).resolves.toMatchObject({ operator_membership_id: member });
});
it('does not return stale cached preview or commit success after configuration changes', async () => {
  const body = input(), p = await previewPartnerImport(deps, actor, 'cached-preview', body);
  await opened.db.query('UPDATE record_agent_installations SET test_import_id=$2 WHERE id=$1', [installation, p.value.id]);
  await commitPartnerImport(deps, actor, p.value.id, 'cached-commit', { previewVersion: p.value.previewVersion, importValidRows: false });
  expect(await processPendingPartnerImports(deps)).toEqual({ processed: 1, failed: 0 });
  await opened.db.query("UPDATE record_agent_installations SET approved_config=jsonb_set(approved_config,'{timeZone}','\"America/New_York\"'),config_revision=config_revision+1,test_import_id=NULL,verified_import_id=NULL WHERE id=$1", [installation]);
  await expect(previewPartnerImport(deps, actor, 'cached-preview', body)).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
  await expect(commitPartnerImport(deps, actor, p.value.id, 'cached-commit', { previewVersion: p.value.previewVersion, importValidRows: false })).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
  await expect(readPartnerImport(deps, actor, p.value.id)).rejects.toMatchObject({ code: 'IMPORT_NOT_FOUND' });
});
it('binds receipts to the exact approved revision when only the local folder changes', async () => {
  await opened.db.query("UPDATE record_agent_installations SET status='active' WHERE id=$1", [installation]);
  const p = await preview();
  await opened.db.query("UPDATE record_agent_installations SET approved_config=jsonb_set(approved_config,'{folderDigest}',to_jsonb($2::text)),config_revision=config_revision+1 WHERE id=$1", [installation, 'b'.repeat(64)]);
  await expect(readPartnerImport(deps, actor, p.id)).rejects.toMatchObject({ code: 'IMPORT_NOT_FOUND' });
  await expect(commitPartnerImport(deps, actor, p.id, 'stale-folder-receipt', { previewVersion: p.previewVersion, importValidRows: false })).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
});
it('rechecks revocation inside the worker before creating any canonical record', async () => {
  const p = await preview(); await opened.db.query('UPDATE record_agent_installations SET test_import_id=$2 WHERE id=$1', [installation, p.id]);
  await commitPartnerImport(deps, actor, p.id, 'will-revoke', { previewVersion: p.previewVersion, importValidRows: false });
  await opened.db.query("UPDATE record_agent_installations SET status='revoked' WHERE id=$1", [installation]);
  expect(await processPendingPartnerImports(deps)).toEqual({ processed: 0, failed: 1 });
  expect((await opened.db.query('SELECT proof_id FROM partner_import_rows WHERE import_id=$1', [p.id])).rows[0].proof_id).toBeNull();
  expect((await opened.db.query('SELECT state FROM partner_import_jobs WHERE id=$1', [p.id])).rows[0].state).toBe('action_needed');
  await expect(commitPartnerImport(deps, actor, p.id, 'will-revoke', { previewVersion: p.previewVersion, importValidRows: false })).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
});
it('stops new submissions while paused and lets previously accepted active work finish', async () => {
  const verified = await preview();
  await opened.db.query('UPDATE record_agent_installations SET test_import_id=$2 WHERE id=$1', [installation, verified.id]);
  await commitPartnerImport(deps,actor,verified.id,'pause-fixture-test',{previewVersion:verified.previewVersion,importValidRows:false});
  expect(await processPendingPartnerImports(deps)).toEqual({processed:1,failed:0});
  await opened.db.query("UPDATE record_agent_installations SET status='active',verified_import_id=$2 WHERE id=$1", [installation,verified.id]);
  const p = await preview(); await commitPartnerImport(deps, actor, p.id, 'accepted-before-pause', { previewVersion: p.previewVersion, importValidRows: false });
  await opened.db.query("UPDATE record_agent_installations SET status='paused' WHERE id=$1", [installation]);
  await expect(previewPartnerImport(deps, actor, 'paused-preview', input())).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
  await expect(commitPartnerImport(deps, actor, p.id, 'new-command-after-pause', { previewVersion: p.previewVersion, importValidRows: false })).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
  expect(await processPendingPartnerImports(deps)).toEqual({ processed: 1, failed: 0 });
  expect((await readPartnerImport(deps, actor, p.id)).state).toBe('succeeded');
});
it('hides receipts and proofs belonging to another source in the same organization', async () => {
  const foreign = (await previewPartnerImport(deps, unrestricted, 'foreign-source', { ...input(), integrationAccountId: otherAccount })).value;
  await commitPartnerImport(deps, unrestricted, foreign.id, 'foreign-commit', { previewVersion: foreign.previewVersion, importValidRows: false });
  await processPendingPartnerImports(deps); const done = await readPartnerImport(deps, unrestricted, foreign.id);
  await expect(readPartnerImport(deps, actor, foreign.id)).rejects.toMatchObject({ code: 'IMPORT_NOT_FOUND' });
  await expect(authorizePartnerProof(opened.db, clock, actor, done.recordIds[0], 'proofs:read')).rejects.toMatchObject({ code: 'PROOF_NOT_FOUND' });
});
it('limits unacknowledged enrollment and renewal credentials to recovery operations', async () => {
  await opened.db.query('UPDATE record_agent_installations SET enrollment_acknowledged_at=NULL WHERE id=$1', [installation]);
  await expect(authorizeAgentRoute(opened.db, clock, actor, 'POST', '/agent/heartbeat')).resolves.toBeUndefined();
  await expect(authorizeAgentRoute(opened.db, clock, actor, 'GET', '/agent/config')).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
  await opened.db.query("UPDATE record_agent_installations SET enrollment_expires_at='2026-11-06T12:59:59Z' WHERE id=$1", [installation]);
  await expect(authorizeAgentRoute(opened.db, clock, actor, 'POST', '/agent/heartbeat')).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
  const next=await issuePartnerCredential(opened.db,clock,owner,organization,principalId,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-12-01T00:00:00Z'},'renewal-fixture');
  await opened.db.query("UPDATE record_agent_installations SET enrollment_acknowledged_at=$2,renewal_credential_id=$3,renewal_expires_at='2026-11-06T13:05:00Z' WHERE id=$1", [installation, clock.now().toISOString(), next.id]);
  await expect(authorizeAgentRoute(opened.db, clock, actor, 'POST', '/agent/credential-renewals')).resolves.toBeUndefined();
  await expect(authorizeAgentRoute(opened.db, clock, actor, 'GET', '/imports/guessed')).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
  const successor = { ...actor, credentialId: next.id };
  await expect(authorizeAgentRoute(opened.db, clock, successor, 'POST', '/agent/heartbeat')).resolves.toBeUndefined();
  await expect(authorizeAgentRoute(opened.db, clock, successor, 'POST', '/imports/preview')).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_REQUIRED' });
});
