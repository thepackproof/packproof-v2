import {randomBytes} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {migrateTestDatabaseThrough,openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrationInventory} from '../src/db/migrate.js';
import {splitSqlStatements} from '../src/db/sql.js';
import {planRecordsRuntimePrivileges,recordsMigrationInventory,verifyRecordsRuntimePrivileges} from '../scripts/records-runtime-privileges.mjs';
import {createPgDatabase} from '../src/db/postgres.js';
import {applyRestoredDelta} from '../../infra/backend-release/order-workspace-restored-rehearsal.mjs';

const connection=process.env.PACKPROOF_TEST_DATABASE_URL;
describe.skipIf(!connection)('PostgreSQL 16 restored workspace migration',()=>{
  it('rolls back the first attempt, preserves old data and grants, then admits independent API and worker logins',async()=>{
    const opened=await openIsolatedTestDatabase();
    const suffix=randomBytes(6).toString('hex');
    const apiRole='workspace_api_'+suffix, workerRole='workspace_worker_'+suffix;
    const roles=[apiRole,workerRole],password=randomBytes(24).toString('hex');
    const source=process.env.GITHUB_SHA || 'a'.repeat(40);
    const oldSource=process.env.PACKPROOF_RELEASE_SHA;
    const logins:ReturnType<typeof createPgDatabase>[]=[];
    const created:string[]=[];
    try{
      process.env.PACKPROOF_RELEASE_SHA=source;
      await migrateTestDatabaseThrough(opened.db,122);
      const identity=(await opened.db.query<{schema:string;ownerRole:string;database:string}>('SELECT current_schema() AS schema,current_user AS "ownerRole",current_database() AS database')).rows[0];
      const {schema}=identity;
      for(const name of roles){
        await opened.db.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        created.push(name);
        await opened.db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${name}`);
        await opened.db.query(`GRANT SELECT(id,checksum) ON schema_migrations TO ${name}`);
        const target=new URL(connection!);target.username=name;target.password=password;target.searchParams.set('options','-c search_path='+schema);
        logins.push(createPgDatabase(target.toString()));
      }
      const options=(throughMigration:122|123,reviewedMigrationSha256:string)=>({runtimeRole:apiRole,workerRole,schema,reviewedSourceCommit:source,reviewedMigrationSha256,throughMigration});
      const policy122=options(122,(await recordsMigrationInventory(122)).migrationSha256);
      const baseline=await planRecordsRuntimePrivileges(opened.db,policy122);
      await opened.db.transaction(async tx=>{for(const sql of baseline.statements)await tx.query(sql);});
      const oldEffective=await Promise.all(logins.map(login=>verifyRecordsRuntimePrivileges(login.db,policy122)));
      await opened.db.query('CREATE TABLE preserved_sample(id integer PRIMARY KEY, original bytea NOT NULL)');
      await opened.db.query('INSERT INTO preserved_sample(id,original) VALUES(1,$1)',[Buffer.from('kept original')]);
      await opened.db.query(`GRANT SELECT ON preserved_sample TO ${apiRole}`);
      const deps={migrationInventory,splitSqlStatements,planRecordsRuntimePrivileges};
      const params={apiRole,workerRole,source,...identity};
      const rollback=Error('EXPECTED_REHEARSAL_ROLLBACK');
      await expect(opened.db.transaction(async tx=>{await applyRestoredDelta(tx,params,deps);throw rollback;})).rejects.toBe(rollback);
      expect((await opened.db.query("SELECT to_regclass('record_order_receipts') IS NULL AS rolled_back")).rows[0].rolled_back).toBe(true);
      const receipt=await opened.db.transaction(tx=>applyRestoredDelta(tx,params,deps));
      expect(receipt).toMatchObject({priorReceiptCount:121,receiptCount:122});
      for(const [index,login] of logins.entries()){
        const historical=await verifyRecordsRuntimePrivileges(login.db,policy122);
        expect(historical.effectivePrivilegesSha256).toBe(oldEffective[index].effectivePrivilegesSha256);
        const active=await verifyRecordsRuntimePrivileges(login.db,options(123,(await recordsMigrationInventory(123)).migrationSha256));
        expect(active.caller).toBe(roles[index]);
      }
      expect((await logins[0].db.query("SELECT convert_from(original,'UTF8') AS original FROM preserved_sample")).rows).toEqual([{original:'kept original'}]);
      await expect(logins[1].db.query('SELECT * FROM record_order_receipts')).rejects.toMatchObject({code:'42501'});
      await expect(opened.db.transaction(tx=>applyRestoredDelta(tx,params,deps))).rejects.toThrow('PREDECESSOR');
    }finally{
      if(oldSource===undefined)delete process.env.PACKPROOF_RELEASE_SHA;else process.env.PACKPROOF_RELEASE_SHA=oldSource;
      for(const login of logins)await login.close();
      for(const name of created){await opened.db.query(`DROP OWNED BY ${name}`);await opened.db.query(`DROP ROLE ${name}`);}
      await opened.close();
    }
  },120000);
});
