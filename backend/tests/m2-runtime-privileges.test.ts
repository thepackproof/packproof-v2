import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {requireRecipientWriter} from '../src/export/recipient-preservation.js';
import {applyM2RuntimePrivileges,verifyM2RuntimePrivileges} from '../scripts/m2-runtime-privileges.mjs';

describe('M2 database API and worker authority',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,proofId:string;
 const suffix=randomBytes(6).toString('hex'),apiRole=`m2_api_${suffix}`,workerRole=`m2_worker_${suffix}`,broad=`m2_broad_${suffix}`;
 const roles={apiRole,workerRole},clock={now:()=>new Date('2026-10-22T12:00:00Z')};
 const asRole=(role:string,sql:string,args:unknown[]=[])=>opened.db.transaction(async tx=>{await tx.query(`SET LOCAL ROLE ${role}`);return tx.query(sql,args);});
 beforeAll(async()=>{
  opened=await openIsolatedTestDatabase();await migrate(opened.db);
  const actor=await insertUser(opened.db,clock);
  proofId=(await createOrGetProof(opened.db,clock,actor,(await createTransaction(opened.db,clock,actor,{itemTitle:'Synthetic database privilege fixture'})).transactionId)).proofId;
  const schema=(await opened.db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name;
  // Only this newly created test schema is granted to these unique test roles.
  for(const role of [apiRole,workerRole,broad]){
   await opened.db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
   await opened.db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  }
  // Unrelated grants must survive; old column grants must be removed explicitly.
  await opened.db.query(`GRANT SELECT ON rnd_sources TO ${apiRole}`);
  await opened.db.query(`GRANT UPDATE(artifact_json) ON recipient_export_jobs TO ${apiRole}`);
  await applyM2RuntimePrivileges(opened.db,roles);
 },30000);
 afterAll(async()=>{
  if(!opened)return;
  for(const role of [apiRole,workerRole,broad]){
   await opened.db.query(`DROP OWNED BY ${role}`);
   await opened.db.query(`DROP ROLE ${role}`);
  }
  await opened.close();
 });
 it('reapplies exactly while preserving unrelated privileges and removing old column writes',async()=>{
  const before=await verifyM2RuntimePrivileges(opened.db,roles);
  expect(await applyM2RuntimePrivileges(opened.db,roles)).toEqual(before);
  expect((await asRole(apiRole,"SELECT has_table_privilege(current_user,'rnd_sources','SELECT') AS allowed")).rows[0]).toEqual({allowed:true});
  await expect(asRole(apiRole,'UPDATE recipient_export_jobs SET artifact_json=artifact_json WHERE false')).rejects.toMatchObject({code:'42501'});
 });
 it('allows API enqueue and worker acceptance, but denies API result writes and worker human approvals',async()=>{
  const operation='privilege-fixture';
  await asRole(apiRole,`INSERT INTO integrity_envelope_jobs(operation_id,proof_id,record_type,record_id,manifest_sha256,request_json,request_sha256,created_at)
   VALUES($1,$2,'CORE',$2,$3,'{}',$3,$4)`,[operation,proofId,'a'.repeat(64),clock.now().toISOString()]);
  await asRole(apiRole,'INSERT INTO integrity_envelope_delivery(operation_id,next_attempt_at) VALUES($1,$2)',[operation,clock.now().toISOString()]);
  await expect(asRole(apiRole,"UPDATE integrity_envelope_delivery SET state='ACCEPTED' WHERE operation_id=$1",[operation])).rejects.toMatchObject({code:'42501'});
  await expect(asRole(apiRole,"INSERT INTO integrity_envelope_delivery(operation_id,next_attempt_at,state) VALUES('forged',now(),'ACCEPTED')")).rejects.toMatchObject({code:'42501'});
  await asRole(workerRole,"UPDATE integrity_envelope_delivery SET state='LEASED',attempts=attempts+1 WHERE operation_id=$1",[operation]);
  for(const table of ['integrity_envelope_results','recipient_export_preservations']){
   await expect(asRole(apiRole,`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`)).rejects.toMatchObject({code:'42501'});
   await asRole(workerRole,`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`);
  }
  for(const table of ['claim_cases','claim_case_revisions','recipient_export_approvals']){
   await asRole(apiRole,`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`);
   await expect(asRole(workerRole,`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`)).rejects.toMatchObject({code:'42501'});
  }
  await asRole(apiRole,'SELECT * FROM claim_cases FOR UPDATE');
  // Worker revalidation takes FOR SHARE while a merchant revision takes UPDATE.
  await asRole(workerRole,'SELECT * FROM claim_cases FOR SHARE');
  for(const role of [apiRole,workerRole])for(const table of ['integrity_envelope_jobs','integrity_envelope_results','claim_cases','claim_case_revisions','recipient_export_preservations','recipient_export_approvals']){
   await expect(asRole(role,`DELETE FROM ${table} WHERE false`)).rejects.toMatchObject({code:'42501'});
   await expect(asRole(role,`TRUNCATE ${table}`)).rejects.toMatchObject({code:'42501'});
  }
 });
 it('permits required row locks but cannot reopen or change the writer fence',async()=>{
  for(const role of [apiRole,workerRole]){
   await opened.db.transaction(async tx=>{await tx.query(`SET LOCAL ROLE ${role}`);await requireRecipientWriter(tx,'initial');});
   await expect(asRole(role,"UPDATE recovery_writer_fence SET generation='forged'")).rejects.toMatchObject({code:'42501'});
   await expect(asRole(role,'UPDATE recovery_writer_fence SET writes_enabled=true')).rejects.toMatchObject({code:'42501'});
   await expect(asRole(role,'UPDATE recovery_writer_fence SET singleton=2')).rejects.toMatchObject({code:'23514'});
   await expect(asRole(role,'ALTER TABLE recipient_export_preservations DISABLE TRIGGER ALL')).rejects.toMatchObject({code:'42501'});
  }
 });
 it('rolls back every grant when inherited authority defeats separation',async()=>{
  await opened.db.query(`GRANT UPDATE ON recipient_export_jobs TO ${broad}`);
  await opened.db.query(`GRANT ${broad} TO ${apiRole}`);
  const before=(await opened.db.query("SELECT relname,relacl FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY relname")).rows;
  await expect(applyM2RuntimePrivileges(opened.db,roles)).rejects.toThrow('M2_EFFECTIVE_TABLE_PRIVILEGES_MISMATCH');
  expect((await opened.db.query("SELECT relname,relacl FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY relname")).rows).toEqual(before);
  await opened.db.query(`REVOKE ${broad} FROM ${apiRole}`);
  await opened.db.query(`REVOKE UPDATE ON recipient_export_jobs FROM ${broad}`);
  await verifyM2RuntimePrivileges(opened.db,roles);
  // The effective write itself is permitted, but authority to delegate it is not.
  await opened.db.query(`GRANT INSERT ON claim_cases TO ${broad} WITH GRANT OPTION`);
  await opened.db.query(`GRANT ${broad} TO ${apiRole}`);
  await expect(applyM2RuntimePrivileges(opened.db,roles)).rejects.toThrow('M2_DELEGABLE_PRIVILEGES_UNSAFE');
  await opened.db.query(`REVOKE ${broad} FROM ${apiRole}`);
  await verifyM2RuntimePrivileges(opened.db,roles);
  await opened.db.query(`GRANT ${workerRole} TO ${apiRole}`);
  await expect(applyM2RuntimePrivileges(opened.db,roles)).rejects.toThrow('M2_SEPARATE_ROLES_REQUIRED');
  await opened.db.query(`REVOKE ${workerRole} FROM ${apiRole}`);
  await opened.db.query('GRANT INSERT ON integrity_envelope_results TO PUBLIC');
  await expect(applyM2RuntimePrivileges(opened.db,roles)).rejects.toThrow('M2_EFFECTIVE_TABLE_PRIVILEGES_MISMATCH');
  await opened.db.query('REVOKE INSERT ON integrity_envelope_results FROM PUBLIC');
  await verifyM2RuntimePrivileges(opened.db,roles);
 });
 it('refuses combined roles, injection, owner authority and drifted migration receipts',async()=>{
  await expect(applyM2RuntimePrivileges(opened.db,{apiRole,workerRole:apiRole})).rejects.toThrow('M2_SEPARATE_ROLES_REQUIRED');
  await expect(applyM2RuntimePrivileges(opened.db,{apiRole:'bad;role',workerRole})).rejects.toThrow('M2_ROLE_IDENTIFIER_INVALID');
  const owner=(await opened.db.query<{name:string}>('SELECT current_user AS name')).rows[0].name;
  await expect(applyM2RuntimePrivileges(opened.db,{apiRole:owner,workerRole})).rejects.toThrow('M2_ROLE_AUTHORITY_UNSAFE');
  await expect(opened.db.transaction(async tx=>{
   await tx.query("UPDATE schema_migrations SET checksum='changed' WHERE id='095_recipient_export_preservation'");
   await applyM2RuntimePrivileges(tx,roles);
  })).rejects.toThrow('M2_MIGRATION_RECEIPTS_MISMATCH');
  await verifyM2RuntimePrivileges(opened.db,roles);
 });
});
