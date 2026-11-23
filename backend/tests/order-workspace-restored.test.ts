import {randomBytes} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {migrateTestDatabaseThrough,openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrationInventory} from '../src/db/migrate.js';
import {collectorInventory,collectorMigration,inspectCollectorPredecessor,inspectReconstructionInventory,verifyBackfillScopeGuard} from '../../infra/backend-release/reconstruction-v11-release-review.mjs';
import {splitSqlStatements} from '../src/db/sql.js';
import {planRecordsRuntimePrivileges,recordsMigrationInventory,verifyRecordsRuntimePrivileges,verifyPlannedRecordsPrivileges} from '../scripts/records-runtime-privileges.mjs';
import {createPgDatabase} from '../src/db/postgres.js';
import {runOwnerTransaction} from '../../infra/backend-release/connect-hosted-migration.mjs';
import {runLogisticsOwnerTransaction,logisticsInventory} from '../../infra/backend-release/logistics-hosted-migration.mjs';
import {backfillMigrationInventorySha256} from '../../infra/backend-release/reconstruction-v8-release-review.mjs';
import {workspaceInventory} from '../../infra/backend-release/reconstruction-v10-release-review.mjs';
import {applyRestoredDelta} from '../../infra/backend-release/order-workspace-restored-rehearsal.mjs';

const connection=process.env.PACKPROOF_TEST_DATABASE_URL;
describe.skipIf(!connection)('PostgreSQL 16 restored workspace migration',()=>{
  it('restores the workspace, upgrades guided Logistics, and preserves original bytes and runtime access',async()=>{
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
      const options=(throughMigration:122|123|124|129,reviewedMigrationSha256:string)=>({runtimeRole:apiRole,workerRole,schema,reviewedSourceCommit:source,reviewedMigrationSha256,throughMigration});
      const policy122=options(122,(await recordsMigrationInventory(122)).migrationSha256);
      const baseline=await planRecordsRuntimePrivileges(opened.db,policy122);
      await opened.db.transaction(async tx=>{for(const sql of baseline.statements)await tx.query(sql);});
      const oldEffective=await Promise.all(logins.map(login=>verifyRecordsRuntimePrivileges(login.db,policy122)));
      await opened.db.query('CREATE TABLE preserved_sample(id integer PRIMARY KEY, original bytea NOT NULL)');
      await opened.db.query('INSERT INTO preserved_sample(id,original) VALUES(1,$1)',[Buffer.from('kept original')]);
      await opened.db.query(`GRANT SELECT ON preserved_sample TO ${apiRole}`);
      // This test qualifies the frozen 122→129 owner protocol, independently of
      // the newer recovery release and its separately reviewed role additions.
      const inventory=(await migrationInventory()).filter(row=>Number(row.id.slice(0,3))<=129);
      const candidate=inventory.filter(row=>row.id<=collectorMigration.id);
      // Exercise the 122→123 restorer with its original release inventory before the
      // candidate migrator sees the exact 123 predecessor and the single new file.
      const predecessor=candidate.filter(row=>row.id<collectorMigration.id);
      const deps={migrationInventory:async()=>predecessor,splitSqlStatements,planRecordsRuntimePrivileges};
      const params={apiRole,workerRole,source,...identity};
      const rollback=Error('EXPECTED_REHEARSAL_ROLLBACK');
      const hostedDeps={migrationInventory:async()=>candidate,splitSqlStatements,planRecordsRuntimePrivileges};
      const hosted={...params,target:{database:identity.database},inventorySha256:collectorInventory,expectedLedger:backfillMigrationInventorySha256};
      const owner=(mode:string, review=hosted)=>opened.db.transaction(tx=>runOwnerTransaction(tx,review,mode,hostedDeps,schema));
      expect(await owner('inspect')).toMatchObject({initialLedger:backfillMigrationInventorySha256,through:122,applied:[]});
      await expect(opened.db.transaction(async tx=>{
        const result=await runOwnerTransaction(tx,hosted,'rehearse',hostedDeps,schema);
        expect(result).toMatchObject({through:122,finalLedger:collectorInventory,applied:['123_order_workspace',collectorMigration.id]});
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await owner('inspect')).toMatchObject({initialLedger:backfillMigrationInventorySha256,through:122});

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

      const ledger=async()=>(await opened.db.query<{id:string;checksum:string;applied_at:string}>(
        'SELECT id,checksum,applied_at::text,checksum_provenance FROM schema_migrations ORDER BY id'
      )).rows;
      const before=await ledger();
      expect(inspectCollectorPredecessor(candidate,before)).toMatchObject({appliedCount:122,addition:collectorMigration});
      const guard123=predecessor.find(row=>row.id==='123_order_workspace')!;
      const guard124=candidate.find(row=>row.id===collectorMigration.id)!;
      await verifyBackfillScopeGuard(opened.db,guard123.sql);
      await expect(verifyBackfillScopeGuard(opened.db,guard124.sql)).rejects.toThrow('BACKFILL_SCOPE_GUARD_MISMATCH');
      const policy123=options(123,(await recordsMigrationInventory(123)).migrationSha256);
      const granted123=await Promise.all(logins.map(login=>verifyRecordsRuntimePrivileges(login.db,policy123)));

      await expect(owner('apply')).rejects.toThrow('PREDECESSOR_CHANGED');
      expect(await owner('apply',{...hosted,expectedLedger:workspaceInventory})).toMatchObject(
        {through:123,applied:[collectorMigration.id],finalLedger:collectorInventory,grantStatementCount:0});
      const after=await ledger();
      expect(after.filter(row=>row.id!==collectorMigration.id)).toEqual(before);
      expect(after.at(-1)).toMatchObject({...collectorMigration,checksum_provenance:'EXECUTED_BYTES'});
      expect(inspectReconstructionInventory(candidate,after,{inventorySha256:collectorInventory})).toMatchObject({sourceCount:123,appliedCount:123});
      await verifyBackfillScopeGuard(opened.db,guard124.sql);
      await expect(verifyBackfillScopeGuard(opened.db,guard123.sql)).rejects.toThrow('BACKFILL_SCOPE_GUARD_MISMATCH');
      const policy124=options(124,(await recordsMigrationInventory(124)).migrationSha256);
      for(const [index,login] of logins.entries()){
        const active=await verifyRecordsRuntimePrivileges(login.db,policy124);
        expect(active.caller).toBe(roles[index]);
        expect(active.policySha256).toBe(granted123[index].policySha256);
        expect(active.effectivePrivilegesSha256).toBe(granted123[index].effectivePrivilegesSha256);
      }
      expect((await logins[0].db.query("SELECT convert_from(original,'UTF8') AS original FROM preserved_sample")).rows).toEqual([{original:'kept original'}]);
      await expect(logins[1].db.query('SELECT * FROM record_order_receipts')).rejects.toMatchObject({code:'42501'});
      expect(await owner('apply',{...hosted,expectedLedger:workspaceInventory})).toMatchObject(
        {through:124,applied:[],finalLedger:collectorInventory,grantStatementCount:0});
      const additions=inventory.filter(row=>row.id>collectorMigration.id);
      const latest=129;
      expect(additions.at(-1)?.id).toBe("129_unified_collector_version");
      const logisticsPolicy=options(latest,(await recordsMigrationInventory(latest)).migrationSha256);
      const deps129={migrationInventory:async()=>inventory,splitSqlStatements,planRecordsRuntimePrivileges,verifyPlannedRecordsPrivileges};
      const reviewed129={...params,target:{database:identity.database},inventorySha256:logisticsInventory,expectedLedger:collectorInventory};
      const upgrade=(mode:string)=>opened.db.transaction(tx=>runLogisticsOwnerTransaction(tx,reviewed129,mode,deps129,schema));
      expect(await upgrade('inspect')).toMatchObject({through:124,finalLedger:collectorInventory,applied:[],grantStatementCount:0});
      await expect(opened.db.transaction(tx=>runLogisticsOwnerTransaction(tx,{...reviewed129,expectedLedger:workspaceInventory},'apply',deps129,schema))).rejects.toThrow('PREDECESSOR_CHANGED');
      await expect(opened.db.transaction(tx=>runLogisticsOwnerTransaction(tx,reviewed129,'apply',{...deps129,
        migrationInventory:async()=>inventory.map((m,i)=>i===inventory.length-1?{...m,sql:m.sql+' '}:m)},schema))).rejects.toThrow('SOURCE_INVENTORY');
      await expect(opened.db.transaction(async tx=>{
        const result=await runLogisticsOwnerTransaction(tx,reviewed129,'rehearse',deps129,schema);
        expect(result).toMatchObject({through:124,finalLedger:logisticsInventory,applied:additions.map(m=>m.id)});
        expect(result.grantStatementCount).toBeGreaterThan(0);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await ledger()).toEqual(after);
      expect((await opened.db.query("SELECT to_regclass('record_order_packet_exports') IS NULL AS rolled_back")).rows[0]).toEqual({rolled_back:true});
      for(const login of logins)await verifyRecordsRuntimePrivileges(login.db,policy124);

      const applied129=await upgrade('apply');
      expect(applied129).toMatchObject({through:124,finalLedger:logisticsInventory,applied:additions.map(m=>m.id)});
      const upgraded=await ledger();
      expect(upgraded.slice(0,after.length)).toEqual(after);
      expect(upgraded.slice(after.length).map(row=>({id:row.id,checksum:row.checksum}))).toEqual(additions.map(({id,checksum})=>({id,checksum})));
      for(const [index,login] of logins.entries()) {
        expect((await verifyRecordsRuntimePrivileges(login.db,logisticsPolicy)).caller).toBe(roles[index]);
      }
      expect((await logins[0].db.query("SELECT convert_from(original,'UTF8') AS original FROM preserved_sample")).rows).toEqual([{original:'kept original'}]);
      await expect(logins[1].db.query('SELECT * FROM record_order_packet_exports')).rejects.toMatchObject({code:'42501'});
      expect(await upgrade('apply')).toMatchObject({through:129,finalLedger:logisticsInventory,applied:[],grantStatementCount:0});
      expect(await upgrade('inspect')).toMatchObject({policySha256:applied129.policySha256,through:129});
      expect(await ledger()).toEqual(upgraded);
    }finally{
      if(oldSource===undefined)delete process.env.PACKPROOF_RELEASE_SHA;else process.env.PACKPROOF_RELEASE_SHA=oldSource;
      for(const login of logins)await login.close();
      for(const name of created){await opened.db.query(`DROP OWNED BY ${name}`);await opened.db.query(`DROP ROLE ${name}`);}
      await opened.close();
    }
  },120000);
});
