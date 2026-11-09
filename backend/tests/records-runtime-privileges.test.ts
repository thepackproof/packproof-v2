import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {recordsMigrationInventory,planRecordsRuntimePrivileges,verifyRecordsRuntimePrivileges,type RecordsPrivilegeOptions} from '../scripts/records-runtime-privileges.mjs';
import {verifyOperationalSnapshotPrivileges,type OperationalSnapshotBinding} from '../src/records/operational-snapshot-runtime.js';
import {processRecordConnectionOperations} from '../src/records/connections.js';

describe('records source-bound API and worker privileges',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,options:RecordsPrivilegeOptions,ownerRole:string;
 const suffix=randomBytes(6).toString('hex'),runtimeRole=`records_api_${suffix}`,workerRole=`records_worker_${suffix}`,inherited=`records_broad_${suffix}`;
 const source='e4f69c9a690649c41b846468eb48829fb0542617';
 const fixture={organization:`priv_org_${suffix}`,tenant:`priv_tenant_${suffix}`,membership:`priv_member_${suffix}`,principal:`priv_principal_${suffix}`,credential:`priv_credential_${suffix}`,connection:`priv_connection_${suffix}`,proof:'',at:new Date().toISOString()};
 // PGlite does not restore LOCAL session authorization on rollback/reset. An
 // explicit synthetic-fixture owner reset is required between role probes.
 const reset=()=>opened.db.query(`SET SESSION AUTHORIZATION "${ownerRole.replace(/"/g,'""')}"`);
 const asRole=async<T>(role:string,fn:(db:typeof opened.db)=>Promise<T>)=>{try{return await opened.db.transaction(async tx=>{await tx.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);return fn(tx);});}finally{await reset();}};
 const apply=async()=>{try{return await opened.db.transaction(async tx=>{const plan=await planRecordsRuntimePrivileges(tx,options);for(const sql of plan.statements)await tx.query(sql);await tx.query(`SET LOCAL SESSION AUTHORIZATION ${runtimeRole}`);return verifyRecordsRuntimePrivileges(tx,options);});}finally{await reset();}};
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_RELEASE_SHA',source);
  opened=await openIsolatedTestDatabase();await migrate(opened.db);
  ownerRole=(await opened.db.query<{name:string}>('SELECT session_user AS name')).rows[0].name;
  const clock={now:()=>new Date(fixture.at)},human=await insertUser(opened.db,clock),service=await insertUser(opened.db,clock);
  fixture.proof=(await createOrGetProof(opened.db,clock,human,(await createTransaction(opened.db,clock,human,{itemTitle:'Privilege source receipt fixture'})).transactionId)).proofId;
  await opened.db.query('INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,$3,\'sandbox\',$4)',[fixture.tenant,human,'Privilege fixture',fixture.at]);
  await opened.db.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,enabled,created_at) VALUES($1,'MERCHANT','Privilege fixture',$2,'sandbox',$3,true,$4)",[fixture.organization,human,fixture.tenant,fixture.at]);
  await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'OWNER',$4)",[fixture.membership,fixture.organization,human,fixture.at]);
  await opened.db.query("INSERT INTO platform_principals(id,organization_id,actor_user_id,name,created_at) VALUES($1,$2,$3,'Fixture service',$4)",[fixture.principal,fixture.organization,service,fixture.at]);
  await opened.db.query("INSERT INTO platform_credentials(id,principal_id,token_hash,prefix,scopes,created_at,expires_at) VALUES($1,$2,$3,'fixture','[\"proofs:write\"]',$4,$5)",[fixture.credential,fixture.principal,'a'.repeat(64),fixture.at,new Date(Date.parse(fixture.at)+86400000).toISOString()]);
  await opened.db.query("INSERT INTO platform_integration_accounts(id,merchant_id,environment,provider,external_account_id,created_at) VALUES($1,$2,'sandbox','fixture','bounded-source',$3)",[fixture.connection,fixture.organization,fixture.at]);
  await opened.db.query("INSERT INTO platform_proof_ownership(proof_id,merchant_id,environment,operator_membership_id,origin_principal_id,created_at) VALUES($1,$2,'sandbox',$3,$4,$5)",[fixture.proof,fixture.organization,fixture.membership,fixture.principal,fixture.at]);
  const schema=(await opened.db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name;
  const inventory=await recordsMigrationInventory();options={runtimeRole,workerRole,schema,reviewedSourceCommit:source,reviewedMigrationSha256:inventory.migrationSha256};
  for(const role of [runtimeRole,workerRole,inherited]){
   await opened.db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
   await opened.db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
   // Read-only migration inventory is an existing baseline prerequisite; this
   // new-table policy neither grants it nor any canonical domain authority.
   await opened.db.query(`GRANT SELECT(id,checksum) ON schema_migrations TO ${role}`);
   await opened.db.query(`GRANT SELECT(datname,datdba) ON pg_catalog.pg_database TO ${role}`);
  }
  await opened.db.query(`GRANT SELECT ON rnd_sources TO ${runtimeRole}`);
  // Deliberately preexisting direct column drift must be removed, not ignored.
  await opened.db.query(`GRANT UPDATE(original_sha256) ON record_import_jobs TO ${workerRole}`);
  const plan=await planRecordsRuntimePrivileges(opened.db,options);
  await opened.db.transaction(async tx=>{for(const sql of plan.statements)await tx.query(sql);});
 },30000);
 afterAll(async()=>{
  vi.unstubAllEnvs();if(!opened)return;
  // The in-memory fixture is discarded in full. PGlite's DROP OWNED on catalog
  // column grants can corrupt its synthetic OID bookkeeping; PostgreSQL cleanup
  // below remains required for externally hosted isolated test schemas.
  if(!process.env.PACKPROOF_TEST_DATABASE_URL){await opened.close();return;}
  for(const role of [runtimeRole,workerRole,inherited]){await opened.db.query(`DROP OWNED BY ${role}`);await opened.db.query(`DROP ROLE ${role}`);}
  await opened.close();
 });
 it('pins source SQL receipts, plans only scoped grants, and verifies under both actual callers',async()=>{
  const plan=await planRecordsRuntimePrivileges(opened.db,options);
  expect(Object.keys(plan.migrations)).toHaveLength(14);
  expect(plan.statements.every(sql=>/^(GRANT|REVOKE) /.test(sql)&&!sql.includes('CREATE ROLE')&&!sql.includes('GRANT ALL'))).toBe(true);
  const before=await asRole(runtimeRole,db=>verifyRecordsRuntimePrivileges(db,options));
  expect(before.caller).toBe(runtimeRole);
  expect((await asRole(workerRole,db=>verifyRecordsRuntimePrivileges(db,options))).caller).toBe(workerRole);
  // Production qualification targets public explicitly. The default PGlite
  // fixture exercises its real ACLs; isolated PostgreSQL schemas still check
  // both actual callers through verifyRecordsRuntimePrivileges above.
  if(options.schema==='public')for(const [kind,role] of [['api',runtimeRole],['worker',workerRole]] as const)
   await asRole(role,db=>verifyOperationalSnapshotPrivileges(db,kind,{apiDatabaseRole:runtimeRole,workerDatabaseRole:workerRole} as OperationalSnapshotBinding));
  const receipt=await apply();expect(receipt.policySha256).toBe(before.policySha256);
  expect(await planRecordsRuntimePrivileges(opened.db,options)).toEqual(plan);
  expect((await asRole(runtimeRole,db=>db.query("SELECT has_table_privilege(current_user,'rnd_sources','SELECT') AS ok"))).rows[0]).toEqual({ok:true});
 });
 it('separates source acceptance, immutable originals, worker state and human decisions',async()=>{
  await asRole(runtimeRole,db=>db.query('SELECT * FROM record_requirements'));
  await asRole(workerRole,db=>db.query('SELECT * FROM record_requirements'));
  await expect(asRole(workerRole,db=>db.query('INSERT INTO record_requirements SELECT * FROM record_requirements WHERE false'))).rejects.toMatchObject({code:'42501'});
  await asRole(workerRole,db=>db.query('UPDATE record_import_jobs SET state=state WHERE false'));
  await expect(asRole(workerRole,db=>db.query('UPDATE record_import_jobs SET original_sha256=original_sha256 WHERE false'))).rejects.toMatchObject({code:'42501'});
  await expect(asRole(runtimeRole,db=>db.query('UPDATE record_connection_state SET last_success_at=last_success_at WHERE false'))).rejects.toMatchObject({code:'42501'});
  await expect(asRole(workerRole,db=>db.query('INSERT INTO record_requirement_waivers SELECT * FROM record_requirement_waivers WHERE false'))).rejects.toMatchObject({code:'42501'});
  // Reference assembly admits stored, reauthorized observations in the worker.
  await asRole(workerRole,db=>db.query('INSERT INTO record_source_identities SELECT * FROM record_source_identities WHERE false'));
  await expect(asRole(workerRole,db=>db.query('INSERT INTO record_source_crosswalks SELECT * FROM record_source_crosswalks WHERE false'))).rejects.toMatchObject({code:'42501'});
  await asRole(runtimeRole,db=>db.query('INSERT INTO record_source_identities SELECT * FROM record_source_identities WHERE false'));
  for(const role of [runtimeRole,workerRole])for(const table of ['record_entities','record_import_rows','record_source_receipts','record_workspace_requests']){
   await expect(asRole(role,db=>db.query(`DELETE FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
   await expect(asRole(role,db=>db.query(`TRUNCATE ${table}`))).rejects.toMatchObject({code:'42501'});
  }
 });
 it('polls connection checks with read-only account metadata and preserves the account write denial',async()=>{
  await opened.db.query(`GRANT SELECT ON platform_integration_accounts TO ${workerRole}`);
  expect(await asRole(workerRole,async db=>(await db.query<{allowed:boolean}>("SELECT has_any_column_privilege(current_user,'platform_integration_accounts','UPDATE') AS allowed")).rows[0].allowed)).toBe(false);
  await expect(asRole(workerRole,db=>processRecordConnectionOperations(db,{now:()=>new Date(fixture.at)},new Map(),1))).resolves.toEqual({processed:0});
  await expect(asRole(workerRole,db=>db.query('UPDATE platform_integration_accounts SET provider=provider WHERE false'))).rejects.toMatchObject({code:'42501'});
 });
 it('permits API installation lifecycle decisions but denies all worker decision writes',async()=>{
  for(const table of ['record_agent_enrollments','record_agent_installations']){
   await asRole(runtimeRole,db=>db.query(`SELECT * FROM ${table} WHERE false`));
   if(table==='record_agent_installations')await asRole(workerRole,db=>db.query(`SELECT * FROM ${table} WHERE false`));
   else await expect(asRole(workerRole,db=>db.query(`SELECT * FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
   await asRole(runtimeRole,db=>db.query(`INSERT INTO ${table}(id) SELECT id FROM ${table} WHERE false`));
   const field=table==='record_agent_enrollments'?'state':'status';
   await asRole(runtimeRole,db=>db.query(`UPDATE ${table} SET ${field}=${field} WHERE false`));
   await expect(asRole(workerRole,db=>db.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
   await expect(asRole(workerRole,db=>db.query(`UPDATE ${table} SET ${field}=${field} WHERE false`))).rejects.toMatchObject({code:'42501'});
   await expect(asRole(runtimeRole,db=>db.query(`UPDATE ${table} SET id=id WHERE false`))).rejects.toMatchObject({code:'42501'});
   for(const role of [runtimeRole,workerRole]){
    await expect(asRole(role,db=>db.query(`DELETE FROM ${table} WHERE false`))).rejects.toMatchObject({code:'42501'});
    await expect(asRole(role,db=>db.query(`TRUNCATE ${table}`))).rejects.toMatchObject({code:'42501'});
   }
  }
  for(const field of ['organization_id','environment','principal_id','integration_account_id','operator_membership_id','location_id','source_name'])
   await expect(asRole(runtimeRole,db=>db.query(`UPDATE record_agent_installations SET ${field}=${field} WHERE false`))).rejects.toMatchObject({code:'42501'});
  // Effective inherited/PUBLIC authority counts, even when the direct worker
  // grants are read-only. Admission must fail closed on either drift path.
  await opened.db.query(`GRANT UPDATE ON record_agent_installations TO ${inherited}`);
  await opened.db.query(`GRANT ${inherited} TO ${workerRole}`);
  await expect(asRole(workerRole,db=>verifyRecordsRuntimePrivileges(db,options))).rejects.toThrow('RECORDS_EFFECTIVE_TABLE_PRIVILEGES_MISMATCH');
  await opened.db.query(`REVOKE ${inherited} FROM ${workerRole}`);
  await opened.db.query('GRANT INSERT ON record_agent_enrollments TO PUBLIC');
  await expect(asRole(workerRole,db=>verifyRecordsRuntimePrivileges(db,options))).rejects.toThrow('RECORDS_EFFECTIVE_TABLE_PRIVILEGES_MISMATCH');
  await opened.db.query('REVOKE INSERT ON record_agent_enrollments FROM PUBLIC');
  await asRole(workerRole,db=>verifyRecordsRuntimePrivileges(db,options));
 });
 it('executes source admission INSERTs with normalized payload/fence columns and admits revision UPSERT planning',async()=>{
  const operation=`priv_operation_${suffix}`,receipt=`priv_receipt_${suffix}`,payload=JSON.stringify({sourceEventId:'source-event-1',proofId:fixture.proof,reportedAt:fixture.at});
  await asRole(runtimeRole,async db=>{
   await db.query("INSERT INTO record_ingestion_operations(id,organization_id,environment,connection_id,connection_revision,principal_id,credential_id,delegation_id,actor_context,request_id,received_at,state,next_attempt_at,updated_at) VALUES($1,$2,'sandbox',$3,0,$4,$5,NULL,'{}','priv-request',$6,'queued',$6,$6)",[operation,fixture.organization,fixture.connection,fixture.principal,fixture.credential,fixture.at]);
   await db.query("INSERT INTO record_source_receipts(id,operation_id,item_index,organization_id,environment,connection_id,source_event_id,proof_id,reported_at,received_at,payload_canonical,payload_sha256,normalized,state,duplicate_of,error_code) VALUES($1,$2,0,$3,'sandbox',$4,'source-event-1',$5,$6,$6,$7,$8,$9::jsonb,'queued',NULL,NULL)",[receipt,operation,fixture.organization,fixture.connection,fixture.proof,fixture.at,payload,'b'.repeat(64),payload]);
  });
  for(const role of [runtimeRole,workerRole]){
   // EXPLAIN performs actual INSERT/UPDATE privilege admission without invoking
   // the separate, preexisting policy-recovery journal trigger permissions.
   await asRole(role,db=>db.query("EXPLAIN INSERT INTO record_state(proof_id,organization_id,environment,revision,updated_at) VALUES($1,$2,'sandbox',2,$3) ON CONFLICT(proof_id) DO UPDATE SET revision=record_state.revision+1,updated_at=EXCLUDED.updated_at",[fixture.proof,fixture.organization,fixture.at]));
   await expect(asRole(role,db=>db.query('UPDATE record_source_receipts SET normalized=normalized WHERE id=$1',[receipt]))).rejects.toMatchObject({code:'42501'});
   await expect(asRole(role,db=>db.query('UPDATE record_source_receipts SET payload_canonical=payload_canonical WHERE id=$1',[receipt]))).rejects.toMatchObject({code:'42501'});
   await expect(asRole(role,db=>db.query('UPDATE record_ingestion_operations SET connection_revision=connection_revision WHERE id=$1',[operation]))).rejects.toMatchObject({code:'42501'});
  }
  await asRole(workerRole,db=>db.query("UPDATE record_source_receipts SET state='failed',error_code='FIXTURE_FAILURE',attempts=attempts+1 WHERE id=$1",[receipt]));
  expect((await opened.db.query('SELECT normalized,payload_canonical,payload_sha256,state,attempts FROM record_source_receipts WHERE id=$1',[receipt])).rows[0]).toEqual({normalized:JSON.parse(payload),payload_canonical:payload,payload_sha256:'b'.repeat(64),state:'failed',attempts:1});
 });
 it('detects inherited/PUBLIC/grantable expansion and wrong sequence privileges',async()=>{
  await opened.db.query(`GRANT EXECUTE ON FUNCTION ${options.schema}.lock_operational_snapshot_authority(text,text,text,text,text) TO PUBLIC`);
  await expect(asRole(runtimeRole,db=>verifyRecordsRuntimePrivileges(db,options))).rejects.toThrow('RECORDS_FUNCTION_PUBLIC_ACCESS_UNSAFE');
  await opened.db.query(`REVOKE EXECUTE ON FUNCTION ${options.schema}.lock_operational_snapshot_authority(text,text,text,text,text) FROM PUBLIC`);
  await opened.db.query(`GRANT UPDATE ON record_entities TO ${inherited}`);await opened.db.query(`GRANT ${inherited} TO ${runtimeRole}`);
  await expect(asRole(runtimeRole,db=>verifyRecordsRuntimePrivileges(db,options))).rejects.toThrow('RECORDS_EFFECTIVE_TABLE_PRIVILEGES_MISMATCH');
  await opened.db.query(`REVOKE ${inherited} FROM ${runtimeRole}`);
  await opened.db.query('GRANT INSERT ON record_requirement_waivers TO PUBLIC');
  await expect(asRole(runtimeRole,db=>verifyRecordsRuntimePrivileges(db,options))).rejects.toThrow('RECORDS_EFFECTIVE_TABLE_PRIVILEGES_MISMATCH');
  await opened.db.query('REVOKE INSERT ON record_requirement_waivers FROM PUBLIC');
  await opened.db.query(`GRANT SELECT ON record_entities TO ${runtimeRole} WITH GRANT OPTION`);
  await expect(asRole(runtimeRole,db=>verifyRecordsRuntimePrivileges(db,options))).rejects.toThrow('RECORDS_DELEGABLE_PRIVILEGES_UNSAFE');
  const plan=await planRecordsRuntimePrivileges(opened.db,options);for(const sql of plan.statements)await opened.db.query(sql);
  await opened.db.query(`GRANT USAGE ON SEQUENCE record_issue_actions_sequence_seq TO ${workerRole}`);
  await expect(asRole(runtimeRole,db=>verifyRecordsRuntimePrivileges(db,options))).rejects.toThrow('RECORDS_EFFECTIVE_SEQUENCE_PRIVILEGES_MISMATCH');
  await opened.db.query(`REVOKE USAGE ON SEQUENCE record_issue_actions_sequence_seq FROM ${workerRole}`);
  await asRole(runtimeRole,db=>verifyRecordsRuntimePrivileges(db,options));
 });
 it('rejects owner/shared roles, injection, wrong caller/source/schema and modified receipts',async()=>{
  await expect(planRecordsRuntimePrivileges(opened.db,{...options,runtimeRole:'bad;role'})).rejects.toThrow('RECORDS_IDENTIFIER_INVALID');
  await expect(planRecordsRuntimePrivileges(opened.db,{...options,workerRole:runtimeRole})).rejects.toThrow('RECORDS_SEPARATE_ROLES_REQUIRED');
  await expect(planRecordsRuntimePrivileges(opened.db,{...options,reviewedMigrationSha256:'0'.repeat(64)})).rejects.toThrow('RECORDS_SOURCE_REVIEW_MISMATCH');
  await expect(planRecordsRuntimePrivileges(opened.db,{...options,schema:'other_schema'})).rejects.toThrow('RECORDS_SCHEMA_CONTEXT_MISMATCH');
  await expect(verifyRecordsRuntimePrivileges(opened.db,options)).rejects.toThrow('RECORDS_RUNTIME_CALLER_REQUIRED');
  await expect(opened.db.transaction(async tx=>{await tx.query(`SET LOCAL ROLE ${runtimeRole}`);await verifyRecordsRuntimePrivileges(tx,options);})).rejects.toThrow('RECORDS_RUNTIME_CALLER_REQUIRED');
  await opened.db.query('RESET ROLE');await reset();
  vi.stubEnv('PACKPROOF_RELEASE_SHA','0'.repeat(40));
  await expect(asRole(runtimeRole,db=>verifyRecordsRuntimePrivileges(db,options))).rejects.toThrow('RECORDS_RUNTIME_SOURCE_MISMATCH');
  vi.stubEnv('PACKPROOF_RELEASE_SHA',source);
  const owner=(await opened.db.query<{name:string}>('SELECT current_user AS name')).rows[0].name;
  await expect(planRecordsRuntimePrivileges(opened.db,{...options,runtimeRole:owner})).rejects.toThrow('RECORDS_ROLE_AUTHORITY_UNSAFE');
  await opened.db.query(`GRANT ${workerRole} TO ${runtimeRole}`);
  await expect(planRecordsRuntimePrivileges(opened.db,options)).rejects.toThrow('RECORDS_SEPARATE_ROLES_REQUIRED');
  await opened.db.query(`REVOKE ${workerRole} FROM ${runtimeRole}`);
  await expect(opened.db.transaction(async tx=>{await tx.query("UPDATE schema_migrations SET checksum='changed' WHERE id='096_records_portal'");await planRecordsRuntimePrivileges(tx,options);})).rejects.toThrow('RECORDS_MIGRATION_RECEIPTS_MISMATCH');
  await expect(opened.db.transaction(async tx=>{await tx.query('ALTER TABLE record_entities ADD COLUMN unexpected_column TEXT');await planRecordsRuntimePrivileges(tx,options);})).rejects.toThrow('RECORDS_SCHEMA_COLUMNS_MISMATCH');
 });
});
