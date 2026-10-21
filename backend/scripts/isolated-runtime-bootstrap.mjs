import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import {SecretsManagerClient,PutSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {createPgDatabase} from '../src/db/postgres.ts';
import {migrate} from '../src/db/migrate.ts';
import {splitSqlStatements} from '../src/db/sql.ts';
assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m1-synthetic');
assert.equal(process.env.PACKPROOF_TEST_DB_HOST,'packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com');
const owner=JSON.parse(process.env.ISOLATED_DB_SECRET);delete process.env.ISOLATED_DB_SECRET;assert.equal(owner.username,'packproof');
process.env.PACKPROOF_DB_CA_FILE='/tmp/packproof-rds-ca.pem';
const connect=name=>{const u=new URL(`postgresql://${process.env.PACKPROOF_TEST_DB_HOST}:5432/${name}?sslmode=verify-full`);u.username=owner.username;u.password=owner.password;return createPgDatabase(u.toString());};
const admin=connect('packproof_v2'),name='m1_service_20261021',secrets=new SecretsManagerClient({region:'us-east-1'}),s3=new S3Client({region:'us-east-1'});
let database;
try{
 assert.equal((await admin.db.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rows.length,0,'Bootstrap refuses to overwrite an existing service database');
 await admin.db.query(`CREATE DATABASE ${name}`);await admin.db.query(`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`);
 database=connect(name);await migrate(database.db);
 for(const sql of splitSqlStatements(await readFile(new URL('../../infra/sql/runtime-roles.sql',import.meta.url),'utf8')))await database.db.query(sql);
 for(const kind of ['api','worker']){
  const role=`m1_service_${kind}`,password=randomBytes(32).toString('hex');
  await admin.db.query(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  await database.db.query(`GRANT packproof_runtime${kind==='worker'?',packproof_recovery':''} TO ${role}`);
  await admin.db.query(`GRANT CONNECT ON DATABASE ${name} TO ${role}`);
  await secrets.send(new PutSecretValueCommand({SecretId:process.env[`${kind.toUpperCase()}DATABASE_SECRET_ARN`],SecretString:password}));
 }
 const bucket='packproof-m1-20261020-uploadbucket-8o4ikwomdg8h',key='acceptance/runtime/config/readiness.txt';
 const sentinel=await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:'Synthetic runtime readiness',ContentType:'text/plain'}));assert.ok(sentinel.VersionId);
 const config={PACKPROOF_UPLOAD_SECRET:randomBytes(32).toString('hex'),PACKPROOF_EVENT_CURSOR_KEY:randomBytes(32).toString('base64'),PACKPROOF_WEBHOOK_ENCRYPTION_KEY:randomBytes(32).toString('base64'),PACKPROOF_READINESS_OBJECT_KEY:key,PACKPROOF_READINESS_OBJECT_VERSION:sentinel.VersionId};
 await secrets.send(new PutSecretValueCommand({SecretId:process.env.CONFIGURATION_SECRET_ARN,SecretString:JSON.stringify(config)}));
 const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout','/tmp/m1-runtime.key','-out','/tmp/m1-runtime.crt','-sha256','-days','7','-subj','/CN=packproof-m1.test','-addext','subjectAltName=DNS:packproof-m1.test'],{stdio:'ignore'});assert.equal(generated.status,0);
 const cert=await readFile('/tmp/m1-runtime.crt','utf8'),tls={cert,key:await readFile('/tmp/m1-runtime.key','utf8')};
 await secrets.send(new PutSecretValueCommand({SecretId:process.env.TLS_SECRET_ARN,SecretString:JSON.stringify(tls)}));
 await s3.send(new PutObjectCommand({Bucket:bucket,Key:'acceptance/runtime/config/tls-ca.pem',Body:cert,ContentType:'application/x-pem-file'}));
 await mkdir('runtime-artifacts',{recursive:true});await writeFile('runtime-artifacts/tls-ca.pem',cert);
 await writeFile('runtime-artifacts/bootstrap.json',JSON.stringify({schema:'packproof.isolated-runtime-bootstrap.v1',source:process.env.CANDIDATE_SHA,buildId:process.env.CODEBUILD_BUILD_ID,database:name,roles:['m1_service_api','m1_service_worker'],ownerRuntimeAccess:false,readiness:{key,versionId:sentinel.VersionId},tlsHostname:'packproof-m1.test',status:'PASSED'},null,2)+'\n');
 console.log(JSON.stringify({event:'isolated_runtime_bootstrap',status:'PASSED',database:name}));
}finally{await database?.close();await admin.close();}
