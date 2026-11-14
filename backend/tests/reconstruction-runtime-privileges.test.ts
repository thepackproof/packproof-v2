import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openIsolatedTestDatabase } from './isolated-test-database.js';
import { migrate } from '../src/db/migrate.js';
import { insertUser } from '../src/domain/users.js';
import { recordsMigrationInventory, planRecordsRuntimePrivileges, verifyRecordsRuntimePrivileges, type RecordsPrivilegeOptions } from '../scripts/records-runtime-privileges.mjs';

describe.each([113,116] as const)('reconstruction%s API and worker database separation',profile=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,ownerRole:string,options:RecordsPrivilegeOptions,user:string;
 const suffix=randomBytes(6).toString('hex'),api=`recon_api_${suffix}`,worker=`recon_worker_${suffix}`,broad=`recon_broad_${suffix}`,source='a'.repeat(40),at='2026-11-14T12:00:00Z';
 const reset=()=>opened.db.query(`SET SESSION AUTHORIZATION "${ownerRole.replace(/"/g,'""')}"`);
 const asRole=async<T>(role:string,fn:(db:typeof opened.db)=>Promise<T>)=>{try{return await opened.db.transaction(async tx=>{await tx.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);return fn(tx);});}finally{await reset();}};
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_RELEASE_SHA',source);opened=await openIsolatedTestDatabase();await migrate(opened.db);
  ownerRole=(await opened.db.query<{name:string}>('SELECT session_user AS name')).rows[0].name;
  const schema=(await opened.db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name;
  for(const role of [api,worker,broad]){await opened.db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);await opened.db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await opened.db.query(`GRANT SELECT(id,checksum) ON schema_migrations TO ${role}`);await opened.db.query(`GRANT SELECT(datname,datdba) ON pg_catalog.pg_database TO ${role}`);}
  const inventory=await recordsMigrationInventory(profile);options={runtimeRole:api,workerRole:worker,schema,reviewedSourceCommit:source,reviewedMigrationSha256:inventory.migrationSha256,throughMigration:profile};
  const plan=await planRecordsRuntimePrivileges(opened.db,options);for(const sql of plan.statements)await opened.db.query(sql);
  user=await insertUser(opened.db,{now:()=>new Date(at)});
  await opened.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,'Reconstruction privilege fixture','sandbox',$3)",['tenant-'+suffix,user,at]);
  await opened.db.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,enabled,created_at) VALUES($1,'MERCHANT','Reconstruction privilege fixture',$2,'sandbox',$3,true,$4)",['org-'+suffix,user,'tenant-'+suffix,at]);
  await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'OWNER',$4)",['member-'+suffix,'org-'+suffix,user,at]);
  await opened.db.query("INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,'Site A',$3)",['site-'+suffix,'org-'+suffix,at]);
  await opened.db.query("INSERT INTO record_cases(id,organization_id,environment,location_id,location_key,operator_membership_id,root_namespace,root_type,root_external_id,created_at,updated_at) VALUES($1,$2,'sandbox',$3,$3,$4,'fixture','order','0010482',$5,$5)",['case-'+suffix,'org-'+suffix,'site-'+suffix,'member-'+suffix,at]);
  await asRole(worker,db=>db.query("INSERT INTO record_case_issues(id,case_id,category,rule_version,subject,created_at) VALUES($1,$2,'quantity_disagreement','fixture/v1','{}',$3)",['issue-'+suffix,'case-'+suffix,at]));
 },60000);
 afterAll(async()=>{vi.unstubAllEnvs();if(!opened)return;if(process.env.PACKPROOF_TEST_DATABASE_URL)for(const role of [api,worker,broad]){await opened.db.query(`DROP OWNED BY ${role}`);await opened.db.query(`DROP ROLE ${role}`);}await opened.close();});
 it('retains frozen108/109/113 defaults and admits each candidate only through explicit review',async()=>{
  expect((await recordsMigrationInventory(108)).migrationSha256).toBe('e0e45a9b2441f77de06ec4f2396ed36bbfeb9c3265008e2e458ea15a74c8cd12');
  expect((await recordsMigrationInventory()).migrationSha256).toBe('5148b9746d855d2b192dbc5ffa35b3c7802dbc2fa490bc82e9ebd82a85077168');
  expect(Object.keys((await recordsMigrationInventory(113)).migrations)).toHaveLength(18);
  expect((await recordsMigrationInventory(113)).migrationSha256).toBe('91c9f5dec5bb04ccb46d9b461386fee279c92b88081ce66ce287f8b7af5db200');
  expect(Object.keys((await recordsMigrationInventory(116)).migrations)).toHaveLength(21);
  for(const role of [api,worker])expect((await asRole(role,db=>verifyRecordsRuntimePrivileges(db,options))).caller).toBe(role);
  await expect(recordsMigrationInventory(112 as 113)).rejects.toThrow('RECORDS_MIGRATION_PROFILE_REQUIRED');
  const plan=await planRecordsRuntimePrivileges(opened.db,options);expect(plan.statements.some(sql=>/CREATE ROLE|ALTER ROLE|GRANT ALL|DEFAULT PRIVILEGES/.test(sql))).toBe(false);
  expect(plan.policySha256).toBe(profile===113?'685cd9ec9aef2aab15de3316a37518321b5c692f0461cac8f2154ccaa84875f3':'19c8a2cfe8841666de82b92a1478ff0452b54e5eb2d443c9ecc91054fec0dc0c');
 });
 it('permits only worker processing columns and preserves immutable original fields',async()=>{
  await asRole(worker,db=>db.query('UPDATE record_typed_batches SET state=state,attempts=attempts,next_attempt_at=next_attempt_at,replay_requested=replay_requested WHERE false'));
  await asRole(worker,db=>db.query('UPDATE record_typed_rows SET status=status,case_id=case_id,supersedes_id=supersedes_id,resolution_attempts=resolution_attempts WHERE false'));
  await asRole(api,db=>db.query('UPDATE record_typed_batches SET state=state,import_valid_rows=import_valid_rows,replay_requested=replay_requested WHERE false'));
  for(const role of [api,worker]){
   for(const column of ['original_sha256','original_object_key','original_version_id','actor_context','subscription_id','configuration_revision','contract','received_at'])await expect(asRole(role,db=>db.query(`UPDATE record_typed_batches SET ${column}=${column} WHERE false`))).rejects.toMatchObject({code:'42501'});
   for(const column of ['source_values','normalized','payload_sha256','errors','source_revision','history_eligibility'])await expect(asRole(role,db=>db.query(`UPDATE record_typed_rows SET ${column}=${column} WHERE false`))).rejects.toMatchObject({code:'42501'});
   for(const table of ['record_typed_batches','record_typed_rows','record_case_assertions','record_case_relations','record_case_association_decisions','record_case_issue_actions'])await expect(asRole(role,db=>db.query(`DELETE FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
  }
 });
 it('keeps worker source grants, crosswalk decisions and retention read-only',async()=>{
  for(const table of ['record_source_subscriptions','record_source_subscription_revisions','record_case_crosswalks','record_typed_retention_events']){
   await asRole(worker,db=>db.query(`SELECT * FROM ${table} WHERE false`));
   await expect(asRole(worker,db=>db.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
  }
  for(const column of ['state','approved_by','grant_revision','configuration_revision','last_check_at'])await expect(asRole(worker,db=>db.query(`UPDATE record_source_subscriptions SET ${column}=${column} WHERE false`))).rejects.toMatchObject({code:'42501'});
  await asRole(api,db=>db.query('UPDATE record_source_subscriptions SET state=state,grant_revision=grant_revision WHERE false'));
  await expect(asRole(worker,db=>db.query('INSERT INTO record_reconstruction_exports SELECT * FROM record_reconstruction_exports WHERE false'))).rejects.toMatchObject({code:'42501'});
  await asRole(api,db=>db.query('INSERT INTO record_reconstruction_exports SELECT * FROM record_reconstruction_exports WHERE false'));
 });
 it('permits system issue actions while denying counterfeit human decisions at both column and constraint boundaries',async()=>{
  await asRole(worker,db=>db.query("INSERT INTO record_case_issue_actions(id,issue_id,case_id,sequence,action,reason,created_at) VALUES($1,$2,$3,1,'system_resolve','Qualified current assertions agree',$4)",['system-'+suffix,'issue-'+suffix,'case-'+suffix,at]));
  await expect(asRole(worker,db=>db.query("INSERT INTO record_case_issue_actions(id,issue_id,case_id,sequence,action,reason,actor_user_id,created_at) VALUES($1,$2,$3,2,'resolve','Forged human',$4,$5)",['forged-'+suffix,'issue-'+suffix,'case-'+suffix,user,at]))).rejects.toMatchObject({code:'42501'});
  await expect(asRole(worker,db=>db.query("INSERT INTO record_case_issue_actions(id,issue_id,case_id,sequence,action,reason,created_at) VALUES($1,$2,$3,2,'resolve','Human action without actor',$4)",['actorless-'+suffix,'issue-'+suffix,'case-'+suffix,at]))).rejects.toMatchObject({code:'23514'});
  await asRole(api,db=>db.query("INSERT INTO record_case_issue_actions(id,issue_id,case_id,sequence,action,reason,actor_user_id,created_at) VALUES($1,$2,$3,2,'note','Reviewed the reported quantities',$4,$5)",['human-'+suffix,'issue-'+suffix,'case-'+suffix,user,at]));
 });
 it('detects inherited approval expansion and PUBLIC crosswalk writes',async()=>{
  await opened.db.query(`GRANT UPDATE(approved_by) ON record_source_subscriptions TO ${broad}`);await opened.db.query(`GRANT ${broad} TO ${worker}`);
  await expect(asRole(worker,db=>verifyRecordsRuntimePrivileges(db,options))).rejects.toThrow('RECORDS_EFFECTIVE_COLUMN_PRIVILEGES_MISMATCH');
  await opened.db.query(`REVOKE ${broad} FROM ${worker}`);
  await opened.db.query('GRANT INSERT ON record_case_crosswalks TO PUBLIC');
  await expect(asRole(worker,db=>verifyRecordsRuntimePrivileges(db,options))).rejects.toThrow('RECORDS_EFFECTIVE_TABLE_PRIVILEGES_MISMATCH');
  await opened.db.query('REVOKE INSERT ON record_case_crosswalks FROM PUBLIC');
  await asRole(worker,db=>verifyRecordsRuntimePrivileges(db,options));
 });
 it('keeps116 interpretation approvals and disposition decisions separate from worker-derived state',async()=>{
  const workerFacts=['record_typed_source_identities_v2','record_case_row_projections','record_case_links','record_typed_snapshot_versions','record_case_projection_comparisons','record_source_disposition_intents','record_source_disposition_results','record_source_compaction_commands'];
  const humanDecisions=['record_case_entity_aliases','record_case_identity_rules','record_source_disposition_requests','record_source_disposition_approvals','record_source_compaction_acknowledgements','record_source_compaction_permits'];
  for(const table of [...workerFacts,...humanDecisions,'record_reconstruction_signed_exports']){
   for(const role of [api,worker]){
    if(profile===116&&(workerFacts.includes(table)&&role===worker||humanDecisions.includes(table)&&role===api||table==='record_reconstruction_signed_exports'&&role===api))await asRole(role,db=>db.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`));
    else await expect(asRole(role,db=>db.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
    await expect(asRole(role,db=>db.query(`DELETE FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
   }
  }
  if(profile===116){
   await expect(asRole(api,db=>db.query('UPDATE record_source_projection_counters SET ready=true WHERE false'))).rejects.toMatchObject({code:'42501'});
   await expect(asRole(api,db=>db.query('INSERT INTO record_source_projection_counters(subscription_id,ready) SELECT subscription_id,true FROM record_source_projection_counters WHERE false'))).rejects.toMatchObject({code:'42501'});
   await asRole(worker,db=>db.query('UPDATE record_source_projection_counters SET ready=ready WHERE false'));
   await asRole(worker,db=>db.query('UPDATE record_case_projection_state SET summary=summary,next_check_at=next_check_at WHERE false'));
   await expect(asRole(api,db=>db.query('UPDATE record_case_projection_state SET summary=summary WHERE false'))).rejects.toMatchObject({code:'42501'});
   await asRole(api,db=>db.query('UPDATE record_source_disposition_work SET state=state,updated_at=updated_at WHERE false'));
   await asRole(worker,db=>db.query('UPDATE record_source_disposition_work SET state=state,attempts=attempts,lease_token=lease_token WHERE false'));
   await expect(asRole(api,db=>db.query('UPDATE record_source_disposition_work SET attempts=attempts WHERE false'))).rejects.toMatchObject({code:'42501'});
   for(const role of [api,worker])await expect(asRole(role,db=>db.query('UPDATE record_source_disposition_work SET request_id=request_id WHERE false'))).rejects.toMatchObject({code:'42501'});
  }
 });
});
