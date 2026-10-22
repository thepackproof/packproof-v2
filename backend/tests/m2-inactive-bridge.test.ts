import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrationInventory,migrate,assertSchemaCurrent} from '../src/db/migrate.js';
import {splitSqlStatements} from '../src/db/sql.js';
import {M2_BRIDGE_MIGRATIONS,assertInactiveM2Bridge,isM2BridgeReceipt} from '../src/db/m2-inactive-bridge.js';
import type {Database} from '../src/db/database.js';

describe('released foundation with exact inactive M2 schema',()=>{
  let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>;
  const suffix=randomBytes(8).toString('hex'), runtime=`bridge_runtime_${suffix}`, future=`bridge_future_${suffix}`;
  const asRuntime=<T>(fn:(db:Database)=>Promise<T>)=>opened.db.transaction(async tx=>{await tx.query(`SET LOCAL ROLE ${runtime}`);return fn(tx);});
  const receipts=async(db=opened.db)=>(await db.query<{id:string;checksum:string|null}>('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  beforeAll(async()=>{
    opened=await openIsolatedTestDatabase();await migrate(opened.db);
    expect(await migrationInventory()).toHaveLength(91);
    const db=opened.db,schema=(await db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name;
    for(const role of [runtime,future])await db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
    await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${runtime}`);
  });
  afterAll(async()=>{
    if(opened){for(const role of [runtime,future]){await opened.db.query(`DROP OWNED BY ${role}`);await opened.db.query(`DROP ROLE ${role}`);}await opened.close();}
  });
  it('keeps the exact released 91-receipt path usable before migration',async()=>{
    await expect(asRuntime(db=>assertSchemaCurrent(db))).resolves.toBeUndefined();
    await expect(assertSchemaCurrent(opened.db)).resolves.toBeUndefined();
  });
  it('accepts only the complete pinned 093-095 transaction with no new runtime grants',async()=>{
    await opened.db.transaction(async tx=>{
      for(const pin of M2_BRIDGE_MIGRATIONS){
        const sql=await readFile(new URL(`./fixtures/m2-migrations/${pin.id}.sql`,import.meta.url),'utf8');
        expect(createHash('sha256').update(sql).digest('hex')).toBe(pin.checksum);
        for(const stmt of splitSqlStatements(sql))await tx.query(stmt);
        await tx.query("INSERT INTO schema_migrations(id,checksum,applied_at,checksum_provenance) VALUES($1,$2,NOW(),'EXECUTED_BYTES')",[pin.id,pin.checksum]);
      }
    });
    await expect(asRuntime(db=>assertSchemaCurrent(db))).resolves.toBeUndefined();
    await expect(asRuntime(db=>db.query('SELECT * FROM integrity_envelope_jobs'))).rejects.toMatchObject({code:'42501'});
    await expect(asRuntime(db=>db.query('SELECT * FROM claim_cases'))).rejects.toMatchObject({code:'42501'});
    await expect(assertSchemaCurrent(opened.db)).rejects.toThrow('M2_BRIDGE_OWNER_OR_DDL_AUTHORITY_FORBIDDEN');
  });
  it('rejects changed, partial and unknown migration receipts',async()=>{
    const rows=await receipts();
    await expect(asRuntime(db=>assertInactiveM2Bridge(db,rows.filter(r=>r.id!==M2_BRIDGE_MIGRATIONS[0].id)))).rejects.toThrow('M2_BRIDGE_PARTIAL_OR_UNKNOWN_SCHEMA');
    await expect(asRuntime(db=>assertInactiveM2Bridge(db,rows.map(r=>r.id===M2_BRIDGE_MIGRATIONS[0].id?{...r,checksum:'a'.repeat(64)}:r)))).rejects.toThrow('M2_BRIDGE_RECEIPT_MISMATCH');
    expect(isM2BridgeReceipt({id:'096_unknown',checksum:'a'.repeat(64)})).toBe(false);
    await expect(asRuntime(db=>assertInactiveM2Bridge(db,[...rows,{id:'096_unknown',checksum:'a'.repeat(64)}]))).rejects.toThrow('M2_BRIDGE_PARTIAL_OR_UNKNOWN_SCHEMA');
  });
  it('refuses feature activation and even another role column grant at readiness',async()=>{
    const rows=await receipts();
    for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_CLAIM_EXPORTS_ENABLED'])await expect(asRuntime(db=>assertInactiveM2Bridge(db,rows,{[flag]:'true'}))).rejects.toThrow('M2_BRIDGE_FEATURE_ACTIVATION_FORBIDDEN');
    await expect(opened.db.transaction(async tx=>{
      await tx.query(`GRANT SELECT(id) ON claim_cases TO ${future}`);
      await tx.query(`SET LOCAL ROLE ${runtime}`);
      await assertSchemaCurrent(tx);
    })).rejects.toThrow('M2_BRIDGE_RUNTIME_ACTIVATION_PRESENT');
    await expect(opened.db.transaction(async tx=>{
      await tx.query('GRANT SELECT ON integrity_envelope_results TO PUBLIC');
      await tx.query(`SET LOCAL ROLE ${runtime}`);
      await assertSchemaCurrent(tx);
    })).rejects.toThrow('M2_BRIDGE_RUNTIME_ACTIVATION_PRESENT');
    await expect(asRuntime(db=>assertSchemaCurrent(db))).resolves.toBeUndefined();
  });
  it('fails when the new terminal-state protection or association guard is weakened',async()=>{
    await expect(opened.db.transaction(async tx=>{
      await tx.query('ALTER TABLE recipient_export_jobs DISABLE TRIGGER recipient_export_job_immutable');
      await tx.query(`SET LOCAL ROLE ${runtime}`);await assertSchemaCurrent(tx);
    })).rejects.toThrow('M2_BRIDGE_PROTECTION_GUARDS_MISMATCH');
    await expect(opened.db.transaction(async tx=>{
      await tx.query("CREATE OR REPLACE FUNCTION protect_recipient_export_job() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql");
      await tx.query(`SET LOCAL ROLE ${runtime}`);await assertSchemaCurrent(tx);
    })).rejects.toThrow('M2_BRIDGE_PROTECTION_GUARDS_MISMATCH');
    await expect(opened.db.transaction(async tx=>{
      await tx.query('ALTER TABLE recipient_export_jobs RENAME CONSTRAINT recipient_export_job_proof TO modified_job_proof');
      await tx.query(`SET LOCAL ROLE ${runtime}`);await assertSchemaCurrent(tx);
    })).rejects.toThrow('M2_BRIDGE_PROTECTION_GUARDS_MISMATCH');
  });
  it('rejects an organizational activation rather than treating an empty grant list as sufficient',async()=>{
    await expect(opened.db.transaction(async tx=>{
      await tx.query("INSERT INTO users(id,created_at,updated_at) VALUES('bridge-organization-owner',NOW(),NOW())");
      await tx.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,created_at) VALUES('bridge-organization','PARTNER','Synthetic bridge activation','bridge-organization-owner','sandbox',NOW())");
      await tx.query(`SET LOCAL ROLE ${runtime}`);await assertSchemaCurrent(tx);
    })).rejects.toThrow('M2_BRIDGE_ORGANIZATION_ACTIVATION_PRESENT');
  });
  it('keeps legacy queue-to-terminal SQL valid while preserving accepted terminal bytes',async()=>{
    const db=opened.db,hash=createHash('sha256').update('{}').digest('hex');
    await db.query("INSERT INTO users(id,created_at,updated_at) VALUES('bridge-legacy-user',NOW(),NOW())");
    await db.query("INSERT INTO transactions(id,created_by,created_at,updated_at) VALUES('bridge-legacy-order','bridge-legacy-user',NOW(),NOW())");
    await db.query("INSERT INTO proofs(id,transaction_id,status,created_at,updated_at) VALUES('bridge-legacy-proof','bridge-legacy-order','OPEN',NOW(),NOW())");
    await db.query("INSERT INTO signature_snapshots(id,proof_id,actor_user_id,payload_json,sha256,created_at) VALUES('bridge-snapshot','bridge-legacy-proof','bridge-legacy-user','{}',$1,NOW())",[hash]);
    await db.query("INSERT INTO signature_cases(id,proof_id,snapshot_id,actor_user_id,payload_json,sha256,created_at) VALUES('bridge-case','bridge-legacy-proof','bridge-snapshot','bridge-legacy-user','{}',$1,NOW())",[hash]);
    await db.query("INSERT INTO recipient_export_jobs(id,proof_id,case_id,actor_user_id,idempotency_key,request_json,request_sha256,profile_id,state,created_at) VALUES('bridge-export','bridge-legacy-proof','bridge-case','bridge-legacy-user','legacy','{}',$1,'historical','QUEUED',NOW())",[hash]);
    await db.query(`GRANT UPDATE ON recipient_export_jobs TO ${runtime}`);
    await asRuntime(tx=>tx.query("UPDATE recipient_export_jobs SET state='RENDERING',attempts=attempts+1,lease_token='synthetic-lease',lease_until=NOW()+INTERVAL '10 minutes' WHERE id='bridge-export'"));
    await asRuntime(tx=>tx.query("UPDATE recipient_export_jobs SET state='READY',artifact_json='{}',artifact_sha256=$1,completed_at=NOW(),lease_token=NULL,lease_until=NULL,failure_code=NULL WHERE id='bridge-export' AND lease_token='synthetic-lease'",[hash]));
    const before=(await asRuntime(tx=>tx.query("SELECT * FROM recipient_export_jobs WHERE id='bridge-export'"))).rows;
    expect(before[0]).toMatchObject({state:'READY',artifact_json:'{}',artifact_sha256:hash});
    await expect(asRuntime(tx=>tx.query("UPDATE recipient_export_jobs SET state='FAILED' WHERE id='bridge-export'"))).rejects.toThrow('RECIPIENT_EXPORT_IMMUTABLE');
    await expect(asRuntime(tx=>tx.query("UPDATE recipient_export_jobs SET attempts=attempts+1 WHERE id='bridge-export'"))).rejects.toThrow('RECIPIENT_EXPORT_IMMUTABLE');
    expect((await asRuntime(tx=>tx.query("SELECT * FROM recipient_export_jobs WHERE id='bridge-export'"))).rows).toEqual(before);
    await expect(asRuntime(tx=>assertSchemaCurrent(tx))).resolves.toBeUndefined();
  });
});
