import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {mkdtemp,readdir,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { openIsolatedTestDatabase } from './isolated-test-database.js';
import { migrate } from '../src/db/migrate.js';
import { insertUser } from '../src/domain/users.js';
import {createServicePrincipal,issuePartnerCredential,createIntegrationAccount,PARTNER_SCOPES} from '../src/platform/organizations.js';
import {canonicalize} from '../src/canonical.js';
import {sha256Hex} from '../src/hash.js';
import { recordsMigrationInventory, planRecordsRuntimePrivileges, verifyRecordsRuntimePrivileges, type RecordsPrivilegeOptions } from '../scripts/records-runtime-privileges.mjs';

describe.each([113,116,117,118] as const)('reconstruction%s API and worker database separation',profile=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,ownerRole:string,options:RecordsPrivilegeOptions,user:string,historicalDirectory:string|undefined;
 const suffix=randomBytes(6).toString('hex'),api=`recon_api_${suffix}`,worker=`recon_worker_${suffix}`,broad=`recon_broad_${suffix}`,source='a'.repeat(40),at='2026-11-14T12:00:00Z';
 const reset=()=>opened.db.query(`SET SESSION AUTHORIZATION "${ownerRole.replace(/"/g,'""')}"`);
 const asRole=async<T>(role:string,fn:(db:typeof opened.db)=>Promise<T>)=>{try{return await opened.db.transaction(async tx=>{await tx.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);return fn(tx);});}finally{await reset();}};
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_RELEASE_SHA',source);opened=await openIsolatedTestDatabase();
  if(profile<118){historicalDirectory=await mkdtemp(path.join(tmpdir(),'reconstruction-historical-catalog-'));const directory=fileURLToPath(new URL('../migrations/',import.meta.url));for(const file of (await readdir(directory)).filter(name=>name.endsWith('.sql')&&Number(name.slice(0,3))<=117))await copyFile(path.join(directory,file),path.join(historicalDirectory,file));}
  await migrate(opened.db,historicalDirectory);
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
 afterAll(async()=>{vi.unstubAllEnvs();if(!opened)return;if(process.env.PACKPROOF_TEST_DATABASE_URL)for(const role of [api,worker,broad]){await opened.db.query(`DROP OWNED BY ${role}`);await opened.db.query(`DROP ROLE ${role}`);}await opened.close();if(historicalDirectory)await rm(historicalDirectory,{recursive:true,force:true});});
 it('retains frozen108/109/113 defaults and admits each candidate only through explicit review',async()=>{
  expect((await recordsMigrationInventory(108)).migrationSha256).toBe('e0e45a9b2441f77de06ec4f2396ed36bbfeb9c3265008e2e458ea15a74c8cd12');
  expect((await recordsMigrationInventory()).migrationSha256).toBe('5148b9746d855d2b192dbc5ffa35b3c7802dbc2fa490bc82e9ebd82a85077168');
  expect(Object.keys((await recordsMigrationInventory(113)).migrations)).toHaveLength(18);
  expect((await recordsMigrationInventory(113)).migrationSha256).toBe('91c9f5dec5bb04ccb46d9b461386fee279c92b88081ce66ce287f8b7af5db200');
  expect(Object.keys((await recordsMigrationInventory(116)).migrations)).toHaveLength(21);
  for(const role of [api,worker])expect((await asRole(role,db=>verifyRecordsRuntimePrivileges(db,options))).caller).toBe(role);
  await expect(recordsMigrationInventory(112 as 113)).rejects.toThrow('RECORDS_MIGRATION_PROFILE_REQUIRED');
  const plan=await planRecordsRuntimePrivileges(opened.db,options);expect(plan.statements.some(sql=>/CREATE ROLE|ALTER ROLE|GRANT ALL|DEFAULT PRIVILEGES/.test(sql))).toBe(false);
  if(profile<117)expect(plan.policySha256).toBe(profile===113?'685cd9ec9aef2aab15de3316a37518321b5c692f0461cac8f2154ccaa84875f3':'19c8a2cfe8841666de82b92a1478ff0452b54e5eb2d443c9ecc91054fec0dc0c');
  else if(profile===117){expect(plan.policySha256).toBe('ced17ca1a4fadd3b74959b7f0b0b5a21279f24404eb44e747231751c7c18e9e0');expect(Object.keys((await recordsMigrationInventory(117)).migrations)).toHaveLength(22);}
  else {expect(plan.policySha256).toBe('0b8927e8893dcf7cb1da8e176d3a97765eb97014d3d7d565dcfe3572fb2fb300');expect(Object.keys((await recordsMigrationInventory(118)).migrations)).toHaveLength(23);const prior=(await recordsMigrationInventory(117)).tableColumns.record_typed_batches,current=(await recordsMigrationInventory(118)).tableColumns.record_typed_batches;expect(current).toEqual([...prior,'csv_snapshot_boundary_at']);}
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
    if(profile>=116&&(workerFacts.includes(table)&&role===worker||humanDecisions.includes(table)&&role===api||table==='record_reconstruction_signed_exports'&&role===api))await asRole(role,db=>db.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`));
    else await expect(asRole(role,db=>db.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
    await expect(asRole(role,db=>db.query(`DELETE FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
   }
  }
  if(profile>=116){
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
 it('keeps117 historical manifests, decisions and exact receipt links API-append-only',async()=>{
  for(const table of ['record_source_backfill_jobs','record_source_backfill_decisions','record_source_backfill_receipts']){
   for(const role of [api,worker]){
    if(profile>=117)await asRole(role,db=>db.query(`SELECT * FROM ${table} WHERE false`));
    else await expect(asRole(role,db=>db.query(`SELECT * FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
    if(profile>=117&&role===api)await asRole(role,db=>db.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`));
    else await expect(asRole(role,db=>db.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
    for(const operation of [`UPDATE ${table} SET created_at=created_at WHERE false`,`DELETE FROM ${table} WHERE false`])await expect(asRole(role,db=>db.query(operation))).rejects.toMatchObject({code:'42501'});
   }
  }
 });
 if(profile>=117)it('appends an exact117 job, human approval and original receipt under the API role while the worker remains read-only',async()=>{
  const org='org-'+suffix,member='member-'+suffix,site='site-'+suffix,clock={now:()=>new Date(at)},principal=await createServicePrincipal(opened.db,clock,user,org,{name:'Synthetic backfill role source'},'backfill-principal'),credential=await issuePartnerCredential(opened.db,clock,user,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-15T12:00:00Z'},'backfill-credential'),account=await createIntegrationAccount(opened.db,clock,user,org,{provider:'synthetic-backfill-role-test',externalAccountId:'backfill-'+suffix},'backfill-account');
  const installation='backfill-install-'+suffix,subscription='backfill-source-'+suffix,job='backfill-job-'+suffix,batch='backfill-batch-'+suffix,item='backfill-item-'+suffix,decision='backfill-decision-'+suffix,configurationSha256=sha256Hex('{}'),content='Synthetic bounded original',originalSha256=sha256Hex(content),manifest=[{id:item,name:'synthetic-backfill.csv',mediaType:'text/csv',sha256:originalSha256,byteSize:Buffer.byteLength(content)}],manifestSha256=sha256Hex(canonicalize(manifest)),context={principalId:principal.id,credentialId:credential.id,merchantId:org,environment:'sandbox'};
  await opened.db.query(`INSERT INTO record_agent_installations(id,organization_id,environment,principal_id,credential_id,integration_account_id,operator_membership_id,location_id,source_name,device_name,version,status,approval_user_id,enrollment_expires_at,enrollment_acknowledged_at,created_at,updated_at) VALUES($1,$2,'sandbox',$3,$4,$5,$6,$7,'Synthetic backfill','Synthetic device','0.4.0','active',$8,'2026-11-15T00:00:00Z',$9,$9,$9)`,[installation,org,principal.id,credential.id,account.id,member,site,user,at]);
  await opened.db.query(`INSERT INTO record_source_subscriptions(id,organization_id,environment,connection_id,principal_id,installation_id,operator_membership_id,location_id,state,configuration_revision,grant_revision,approved_by,recurring_approved_by,created_at,updated_at) VALUES($1,$2,'sandbox',$3,$4,$5,$6,$7,'active',1,3,$8,$8,$9,$9)`,[subscription,org,account.id,principal.id,installation,member,site,user,at]);
  await opened.db.query(`INSERT INTO record_source_subscription_revisions(subscription_id,revision,configuration,configuration_sha256,created_by,created_at) VALUES($1,1,'{}',$2,$3,$4)`,[subscription,configurationSha256,user,at]);
  // Baseline platform reads belong to the established API authentication
  // policy, outside the frozen records policy being measured here.
  await opened.db.query(`GRANT SELECT ON platform_credentials,platform_memberships,platform_principals,users TO ${api}`);
  await asRole(api,db=>db.query(`INSERT INTO record_source_backfill_jobs(id,organization_id,environment,connection_id,location_id,operator_membership_id,subscription_id,configuration_revision,configuration_sha256,grant_revision,principal_id,credential_id,installation_id,actor_context,history_from,history_to,semantics,manifest,manifest_sha256,created_at) VALUES($1,$2,'sandbox',$3,$4,$5,$6,1,$7,3,$8,$9,$10,$11::jsonb,'2026-11-01T00:00:00Z','2026-11-13T00:00:00Z','cumulative_snapshot',$12::jsonb,$13,$14)`,[job,org,account.id,site,member,subscription,configurationSha256,principal.id,credential.id,installation,JSON.stringify(context),JSON.stringify(manifest),manifestSha256,at]));
  await asRole(api,db=>db.query(`INSERT INTO record_source_backfill_decisions(id,job_id,action,whole_file_consent,expires_at,reason,actor_user_id,actor_membership_id,manifest_sha256,created_at) VALUES($1,$2,'approve',true,'2026-11-14T13:00:00Z','Synthetic exact manifest approval',$3,$4,$5,$6)`,[decision,job,user,member,manifestSha256,at]));
  await asRole(api,db=>db.query(`INSERT INTO record_typed_batches(id,organization_id,environment,connection_id,location_id,subscription_id,configuration_revision,grant_revision,principal_id,credential_id,actor_context,operator_membership_id,source_profile,source_namespace,mapping_version,preview_version,source_control_revision,original_name,original_media_type,original_object_key,original_version_id,original_sha256,original_byte_size,contract,row_count,state,received_at,updated_at,next_attempt_at) VALUES($1,$2,'sandbox',$3,$4,$5,1,3,$6,$7,$8::jsonb,$9,'packproof.order-lines/v1','synthetic-backfill','fixture/1','fixture-preview',0,'synthetic-backfill.csv','text/csv',$10,'synthetic-exact-version',$11,$12,'{}',1,'previewed',$13,$13,$13)`,[batch,org,account.id,site,subscription,principal.id,credential.id,JSON.stringify(context),member,`evidence/${org}/${batch}/committed/sha256-${originalSha256}`,originalSha256,Buffer.byteLength(content),at]));
  await asRole(api,db=>db.query('INSERT INTO record_source_backfill_receipts(job_id,item_id,batch_id,created_at) VALUES($1,$2,$3,$4)',[job,item,batch,at]));
  for(const table of ['record_source_backfill_jobs','record_source_backfill_decisions','record_source_backfill_receipts'])expect((await asRole(worker,db=>db.query(`SELECT COUNT(*)::text n FROM ${table}`))).rows[0].n).toBe('1');
  await expect(asRole(worker,db=>db.query(`INSERT INTO record_source_backfill_decisions SELECT * FROM record_source_backfill_decisions WHERE false`))).rejects.toMatchObject({code:'42501'});
  await expect(asRole(worker,db=>db.query(`INSERT INTO record_source_backfill_receipts SELECT * FROM record_source_backfill_receipts WHERE false`))).rejects.toMatchObject({code:'42501'});
  await expect(asRole(api,db=>db.query('INSERT INTO record_source_backfill_receipts(job_id,item_id,batch_id,created_at) VALUES($1,$2,$3,$4)',[job,'unapproved-manifest-item',batch,at]))).rejects.toThrow(/manifest and authority/);
  if(profile===118){
   expect((await asRole(api,db=>db.query('SELECT csv_snapshot_boundary_at FROM record_typed_batches WHERE id=$1',[batch]))).rows[0].csv_snapshot_boundary_at).toBeNull();
   const boundary='2026-11-10T00:00:00Z',contract={schema:'packproof.typed-source-batch/v2',completeness:{kind:'snapshot',asOf:boundary,marker:'synthetic-verified-control'}},boundedBatch=batch+'-bounded';
   const insertBoundary=(id:string,value:unknown,bound:string,mediaType='text/csv')=>asRole(api,db=>db.query(`INSERT INTO record_typed_batches SELECT (jsonb_populate_record(NULL::record_typed_batches,to_jsonb(b)||jsonb_build_object('id',$2::text,'contract',$3::jsonb,'csv_snapshot_boundary_at',$4::timestamptz,'original_media_type',$5::text))).* FROM record_typed_batches b WHERE b.id=$1`,[batch,id,JSON.stringify(value),bound,mediaType]));
   await insertBoundary(boundedBatch,contract,boundary);
   for(const role of [api,worker])expect(new Date((await asRole(role,db=>db.query<{csv_snapshot_boundary_at:string|Date}>('SELECT csv_snapshot_boundary_at FROM record_typed_batches WHERE id=$1',[boundedBatch]))).rows[0].csv_snapshot_boundary_at).toISOString()).toBe('2026-11-10T00:00:00.000Z');
   const invalid=[{contract,boundary:'2026-11-11T00:00:00Z'},{contract:{completeness:contract.completeness},boundary},{contract:{...contract,completeness:{asOf:boundary,marker:'synthetic-verified-control'}},boundary},{contract:{...contract,completeness:{...contract.completeness,marker:''}},boundary},{contract:{...contract,schema:'packproof.typed-source-batch/v1'},boundary}];
   for(let i=0;i<invalid.length;i++)await expect(insertBoundary(batch+'-invalid-'+i,invalid[i].contract,invalid[i].boundary)).rejects.toMatchObject({code:'23514'});
   await expect(insertBoundary(batch+'-non-csv',contract,boundary,'application/json')).rejects.toMatchObject({code:'23514'});
   for(const role of [api,worker])await expect(asRole(role,db=>db.query('UPDATE record_typed_batches SET csv_snapshot_boundary_at=csv_snapshot_boundary_at WHERE false'))).rejects.toMatchObject({code:'42501'});
   await expect(asRole(worker,db=>db.query('INSERT INTO record_typed_batches(id,csv_snapshot_boundary_at) SELECT id,csv_snapshot_boundary_at FROM record_typed_batches WHERE false'))).rejects.toMatchObject({code:'42501'});
   await expect(opened.db.query('UPDATE record_typed_batches SET csv_snapshot_boundary_at=csv_snapshot_boundary_at WHERE id=$1',[boundedBatch])).rejects.toThrow(/immutable/i);
  }
  await asRole(worker,db=>verifyRecordsRuntimePrivileges(db,options));await asRole(api,db=>verifyRecordsRuntimePrivileges(db,options));
 });
});
