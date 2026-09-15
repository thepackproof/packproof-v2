import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createPgliteDatabase} from '../src/db/pglite.js';
import {assertSchemaCurrent,migrate,migrationInventory} from '../src/db/migrate.js';
import {splitSqlStatements} from '../src/db/sql.js';

const approved=[
 {id:'067_mobile_intake_submissions',checksum:'3f1333e6f4670e9506ab0ad0970fa83373f2c243175fef247fe99dd0616b923c'},
 {id:'068_commerce_sync_checkpoints',checksum:'1a9c3cacf5f146f87dd1fe5ae125aceb9ee5c36ee971cb0e4fad6c9053133a51'},
];
describe('schema-066 rolling bridge',()=>{
 let opened:Awaited<ReturnType<typeof createPgliteDatabase>>;
 beforeAll(async()=>{opened=await createPgliteDatabase();await migrate(opened.db);});
 afterAll(async()=>{await opened.close();});
 it('remains the unchanged066 runtime before migration and accepts each exact additive migration after application',async()=>{
  const inventory=await migrationInventory();
  expect(inventory.at(-1)?.id).toBe('066_ios_capture_surfaces');
  expect(inventory.some(row=>approved.some(allowed=>row.id===allowed.id))).toBe(false);
  await expect(assertSchemaCurrent(opened.db)).resolves.toBeUndefined();
  await opened.db.query("INSERT INTO users(id,created_at,updated_at) VALUES('bridge-preserved-user',NOW(),NOW())");
  for(const item of approved){
   const sql=await readFile(new URL(`./fixtures/schema-bridge/${item.id}.sql`,import.meta.url),'utf8');
   expect(createHash('sha256').update(sql).digest('hex')).toBe(item.checksum);
   await opened.db.transaction(async tx=>{
    for(const statement of splitSqlStatements(sql))await tx.query(statement);
    await tx.query("INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,NOW(),$2,'EXECUTED_BYTES')",[item.id,item.checksum]);
   });
   await expect(assertSchemaCurrent(opened.db)).resolves.toBeUndefined();
  }
  // The bridge migrator must remain a066 migrator; a restart cannot erase or execute future work.
  await migrate(opened.db);await expect(assertSchemaCurrent(opened.db)).resolves.toBeUndefined();
  expect((await opened.db.query("SELECT id FROM users WHERE id='bridge-preserved-user'")).rows).toHaveLength(1);
 });
 it('still rejects missing or modified known066 ledger entries',async()=>{
  const latest=(await migrationInventory()).at(-1)!;
  await opened.db.transaction(async tx=>{
   await tx.query('UPDATE schema_migrations SET checksum=$2 WHERE id=$1',[latest.id,'modified']);
   await expect(assertSchemaCurrent(tx)).rejects.toThrow(`Migration required or checksum mismatch: ${latest.id}`);
   await tx.query('UPDATE schema_migrations SET checksum=$2 WHERE id=$1',[latest.id,latest.checksum]);
   const prior=(await tx.query('SELECT * FROM schema_migrations WHERE id=$1',[latest.id])).rows[0];
   await tx.query('DELETE FROM schema_migrations WHERE id=$1',[latest.id]);
   await expect(assertSchemaCurrent(tx)).rejects.toThrow(`Migration required or checksum mismatch: ${latest.id}`);
   await tx.query('INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,$2,$3,$4)',[prior.id,prior.applied_at,prior.checksum,prior.checksum_provenance]);
  });
 });
 it.each([null,'modified',approved[1].checksum])('rejects an unapproved067 checksum (%#)',async(checksum)=>{
  await opened.db.transaction(async tx=>{
   await tx.query('UPDATE schema_migrations SET checksum=$2 WHERE id=$1',[approved[0].id,checksum]);
   await expect(assertSchemaCurrent(tx)).rejects.toThrow('outside this release compatibility envelope');
   await tx.query('UPDATE schema_migrations SET checksum=$2 WHERE id=$1',[approved[0].id,approved[0].checksum]);
  });
 });
 it('rejects every other future migration even when it copies an approved checksum',async()=>{
  await opened.db.transaction(async tx=>{
   await tx.query('INSERT INTO schema_migrations(id,applied_at,checksum) VALUES($1,NOW(),$2)',['069_unreviewed',approved[0].checksum]);
   await expect(assertSchemaCurrent(tx)).rejects.toThrow('outside this release compatibility envelope');
   await tx.query("DELETE FROM schema_migrations WHERE id='069_unreviewed'");
  });
 });
});
