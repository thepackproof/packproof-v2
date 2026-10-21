// Owner-only one-shot control plane. This file is never included in the task image.
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {createPgDatabase} from '../src/db/postgres.ts';
assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m1-synthetic');
assert.equal(process.env.PACKPROOF_TEST_DB_HOST,'packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com');
const owner=JSON.parse(process.env.ISOLATED_DB_SECRET);delete process.env.ISOLATED_DB_SECRET;assert.equal(owner.username,'packproof');
process.env.PACKPROOF_DB_CA_FILE='/tmp/packproof-rds-ca.pem';
const url=new URL(`postgresql://${process.env.PACKPROOF_TEST_DB_HOST}:5432/m1_service_20261021?sslmode=verify-full`);url.username=owner.username;url.password=owner.password;
const opened=createPgDatabase(url.toString());
try{
 const db=opened.db,mode=process.env.RUNTIME_CONTROL;assert.ok(['protect','inspect','close'].includes(mode));
 if(mode==='protect'){
  await db.transaction(async tx=>{
   await tx.query("UPDATE recovery_writer_fence SET generation='m1-runtime-20261021',writes_enabled=true WHERE singleton=1");
   await tx.query('UPDATE policy_recovery_fence SET durability_required=true WHERE singleton=1');
  });
 }
 if(mode==='close'){
  await db.query('UPDATE recovery_writer_fence SET writes_enabled=false WHERE singleton=1');
  for(const role of ['m1_service_api','m1_service_worker'])await db.query(`ALTER ROLE ${role} NOLOGIN`);
  await db.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='m1_service_20261021' AND usename IN ('m1_service_api','m1_service_worker') AND pid<>pg_backend_pid()");
 }
 const report={schema:'packproof.isolated-runtime-control.v1',mode,source:process.env.CANDIDATE_SHA,buildId:process.env.CODEBUILD_BUILD_ID,
  database:'m1_service_20261021',writerFence:(await db.query('SELECT * FROM recovery_writer_fence')).rows,
  policyFence:(await db.query('SELECT * FROM policy_recovery_fence')).rows,
  roles:(await db.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname IN ('m1_service_api','m1_service_worker') ORDER BY rolname")).rows,
  coreDelivery:(await db.query('SELECT state,COUNT(*) AS count FROM recovery_delivery GROUP BY state')).rows,
  policyDelivery:(await db.query('SELECT state,COUNT(*) AS count FROM policy_recovery_delivery GROUP BY state')).rows,
  heartbeats:(await db.query('SELECT * FROM operational_worker_heartbeats ORDER BY worker_name')).rows};
 await mkdir('runtime-artifacts',{recursive:true});await writeFile('runtime-artifacts/control.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{await opened.close();}
