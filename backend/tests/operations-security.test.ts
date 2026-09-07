import { afterEach,describe,expect,it,vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPgliteDatabase } from '../src/db/pglite.js';
import { migrate,assertSchemaCurrent } from '../src/db/migrate.js';
import { postgresPoolConfig,sslConfigFromConnectionString } from '../src/db/postgres.js';
import { configureTrustedProxy,distributedRateLimit,requestCorrelation,safeHttpError } from '../src/http/boundary.js';
import { createReadiness } from '../src/operations/readiness.js';
import { startScheduledJobs } from '../src/operations/scheduler.js';
import { systemClock } from '../src/clock.js';
import { createRecoveryPublisher } from '../src/operations/runtime-jobs.js';
import { loadConfig } from '../src/config.js';

afterEach(()=>vi.restoreAllMocks());
describe('operational security boundaries',()=>{
  it('rejects permissive TLS modes and removes URL TLS overrides',()=>{
    expect(()=>sslConfigFromConnectionString('postgres://u:p@db/x?sslmode=no-verify',{})).toThrow();
    expect(()=>sslConfigFromConnectionString('postgres://u:p@db/x?sslmode=disable',{PACKPROOF_ENVIRONMENT:'production'})).toThrow();
    const config=postgresPoolConfig('postgres://u:p@db/x?sslmode=require&ssl=false',undefined,{});
    expect(config.ssl).toMatchObject({rejectUnauthorized:true,minVersion:'TLSv1.2'});
    expect(config.connectionString).not.toContain('ssl=');
    expect(()=>sslConfigFromConnectionString('postgres://u:p@db/x?sslmode=require',{PACKPROOF_DB_CA_FILE:'/nonexistent/ca.pem'})).toThrow('CA bundle is unavailable');
  });
  it('detects modified applied migrations and requires explicit historical baseline adoption',async()=>{
    const opened=await createPgliteDatabase(),dir=await mkdtemp(path.join(tmpdir(),'pp-checksum-'));
    try{
      await writeFile(path.join(dir,'001_test.sql'),'CREATE TABLE example(id TEXT);');await migrate(opened.db,dir);await assertSchemaCurrent(opened.db,dir);
      await writeFile(path.join(dir,'001_test.sql'),'CREATE TABLE example(id TEXT); -- altered');
      await expect(migrate(opened.db,dir)).rejects.toThrow('checksum mismatch');
      await opened.db.query('UPDATE schema_migrations SET checksum=NULL');
      await expect(migrate(opened.db,dir)).rejects.toThrow('reviewed baseline');
      await migrate(opened.db,dir,{adoptLegacyChecksums:true});await assertSchemaCurrent(opened.db,dir);
      expect((await opened.db.query('SELECT checksum_provenance FROM schema_migrations')).rows[0]).toEqual({checksum_provenance:'REVIEWED_LEGACY_BASELINE_NOT_EXECUTION_PROOF'});
      await opened.db.query("INSERT INTO schema_migrations(id,applied_at,checksum) VALUES('999_future',NOW(),'test')");
      await expect(assertSchemaCurrent(opened.db,dir)).rejects.toThrow('compatibility envelope');
    }finally{await opened.close();await rm(dir,{recursive:true,force:true});}
  });
  it('ignores spoofed forwarded identity while sharing limits across replicas',async()=>{
    const opened=await createPgliteDatabase();try{
      await migrate(opened.db);
      const app=()=>{const server=express();configureTrustedProxy(server,{});server.use(distributedRateLimit(opened.db,{scope:'test',limit:2,windowMs:60000}));server.get('/',(req,res)=>res.json({ip:req.ip}));server.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>safeHttpError(err,res));return server;};
      const first=app(),second=app();
      expect((await request(first).get('/').set('X-Forwarded-For','1.1.1.1')).status).toBe(200);
      expect((await request(second).get('/').set('X-Forwarded-For','2.2.2.2')).status).toBe(200);
      expect((await request(first).get('/').set('X-Forwarded-For','3.3.3.3')).status).toBe(429);
      expect(()=>configureTrustedProxy(express(),{PACKPROOF_TRUSTED_PROXIES:'true'})).toThrow();
      expect(()=>configureTrustedProxy(express(),{PACKPROOF_TRUSTED_PROXIES:'0.0.0.0/0'})).toThrow();
    }finally{await opened.close();}
  });
  it('keeps secrets out of responses and logs while generating a correlation id',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{}),app=express();app.use(requestCorrelation);
    app.get('/',(_req,res)=>safeHttpError(new Error('password=DO_NOT_DISCLOSE'),res));
    const response=await request(app).get('/').set('X-PackProof-Operation-Id','attacker\ttext');
    expect(response.status).toBe(500);expect(response.body.error.operationId).toMatch(/^[a-f0-9-]{36}$/);expect(JSON.stringify(response.body)).not.toContain('DO_NOT_DISCLOSE');expect(JSON.stringify(log.mock.calls)).not.toContain('DO_NOT_DISCLOSE');
  });
  it('times out readiness and shares cached dependency work',async()=>{
    const check=vi.fn(()=>new Promise(()=>{}));const ready=createReadiness([{name:'db',check}],{timeoutMs:10,cacheMs:1000});
    const results=await Promise.all([ready.check(),ready.check()]);expect(results[0].status).toBe('unavailable');expect(check).toHaveBeenCalledTimes(1);await ready.check();expect(check).toHaveBeenCalledTimes(1);
  });
  it('makes scheduled progress with no HTTP requests and records useful completion',async()=>{
    const opened=await createPgliteDatabase();try{await migrate(opened.db);let count=0;
      const stop=startScheduledJobs(opened.db,systemClock,[{name:'idle-test',intervalMs:10,run:async()=>{count++;}}]);
      await vi.waitFor(async()=>{expect(count).toBeGreaterThan(0);expect((await opened.db.query("SELECT state FROM operational_worker_heartbeats WHERE worker_name='idle-test'")).rows[0]).toEqual({state:'IDLE'});});await stop();
    }finally{await opened.close();}
  });
  it('does not enable preservation assurances without explicit protected storage and signing',()=>{
    expect(()=>createRecoveryPublisher({...loadConfig({}),requireDurableReceipts:true},{} as never,{publicStatus:{mode:'UNSIGNED'},trustList:null} as never,systemClock,{})).toThrow('verified immutable journal');
  });
});
