import { createPublicKey } from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {KMSClient,GetPublicKeyCommand,SignCommand} from '@aws-sdk/client-kms';
import { flattenedVerify, importSPKI } from 'jose';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import type {AppConfig} from '../config.js';
import type { EnvelopeStore, EnvelopeWorker } from '../integrity/envelope-jobs.js';
import type { EnvelopeReader } from '../integrity/envelope-access.js';
import {createEnvelopeTrust} from '../integrity/envelope-trust.js';
import {loadSignedTrustRegistryRuntime} from '../integrity/trust-registry-runtime.js';
import {createEnvelopeS3Reader,createEnvelopeS3Store,envelopeS3Transport} from '../integrity/envelope-s3-store.js';
import {trustKeyPermitsSignature} from '../domain/signing-trust.js';
import type { KmsSigningTransport } from '../integrity/kms-signing-runtime.js';
import { jcsBytes, sha256 } from '../integrity/envelope-profile.js';
import { createOperationalSnapshotSigner, OPERATIONAL_MANIFEST_PROFILE, OPERATIONAL_SNAPSHOT_PROFILE, OPERATIONAL_SNAPSHOT_TYPE, SNAPSHOT_SECTION_FIELDS, snapshotCheck, validateOperationalEnvelope } from './operational-snapshot-profile.js';

export const OPERATIONAL_PROFILE_SHA256=sha256(jcsBytes({manifest:OPERATIONAL_MANIFEST_PROFILE,envelope:OPERATIONAL_SNAPSHOT_PROFILE,type:OPERATIONAL_SNAPSHOT_TYPE,sections:SNAPSHOT_SECTION_FIELDS,artifactSourceFields:['kind','reference','reportedAt','receivedAt','acceptedAt','actorId','connectionId','receiptSha256'],transport:'packproof.operational-snapshot-package.v1',source:'OPERATIONAL_SNAPSHOT_REQUESTED',result:'OPERATIONAL_SNAPSHOT_SIGNED'}));
export interface OperationalSnapshotBinding {
  sourceSha:string;profileSha256:string;organizationIds:string[];environment:'live'|'sandbox';cutoverAt:string;
  artifactBucket:string;evidenceBucket:string;sourceArtifactBucket:string;journalBucket:string;account:string;region:string;
  issuer:string;keyId:string;keyArn:string;retainUntil:string;writerGeneration:string;
  apiDatabaseRole:string;workerDatabaseRole:string;apiRoleArn:string;workerRoleArn:string;
}
export interface OperationalSnapshotRuntime {
  assertReady():void;binding:OperationalSnapshotBinding;reader:EnvelopeReader;
  sourceJournal:EnvelopeWorker['sourceJournal'];trustedPublicKey:EnvelopeWorker['trustedPublicKey'];
  sourceProtection:EnvelopeReader['verify'];
  worker?:{store:EnvelopeStore;sign:EnvelopeWorker['sign']};
}
const exactDate=(v:string)=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function validateBinding(b:OperationalSnapshotBinding,clock:Clock){
  snapshotCheck(/^[a-f0-9]{40}$/.test(b.sourceSha)&&b.profileSha256===OPERATIONAL_PROFILE_SHA256,'PROFILE_UNQUALIFIED');
  snapshotCheck(Array.isArray(b.organizationIds)&&b.organizationIds.length>0&&b.organizationIds.length<=100&&new Set(b.organizationIds).size===b.organizationIds.length&&b.organizationIds.every(v=>/^[A-Za-z0-9_-]{1,160}$/.test(v))&&['sandbox','live'].includes(b.environment),'COHORT_UNQUALIFIED');
  snapshotCheck(exactDate(b.cutoverAt)&&Date.parse(b.cutoverAt)<=clock.now().getTime()&&exactDate(b.retainUntil)&&Date.parse(b.retainUntil)>clock.now().getTime()&&/^[A-Za-z0-9_-]{1,160}$/.test(b.writerGeneration),'PROTECTION_EXPIRED');
  snapshotCheck(/^\d{12}$/.test(b.account)&&/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(b.region)&&[b.artifactBucket,b.evidenceBucket,b.sourceArtifactBucket,b.journalBucket].every(v=>/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v))&&b.artifactBucket!==b.journalBucket&&![b.artifactBucket,b.journalBucket].includes(b.evidenceBucket)&&![b.artifactBucket,b.journalBucket].includes(b.sourceArtifactBucket),'BUCKET_BINDING_INVALID');
  snapshotCheck(new RegExp(`^arn:aws(?:-us-gov|-cn)?:kms:${b.region}:${b.account}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$`).test(b.keyArn)&&/^[A-Za-z0-9_-]{1,160}$/.test(b.keyId)&&/^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_./-]*)?$/.test(b.issuer),'KEY_BINDING_INVALID');
  snapshotCheck(b.apiDatabaseRole!==b.workerDatabaseRole&&[b.apiDatabaseRole,b.workerDatabaseRole].every(v=>/^[a-z][a-z0-9_]{0,62}$/.test(v))&&b.apiRoleArn!==b.workerRoleArn&&[b.apiRoleArn,b.workerRoleArn].every(v=>new RegExp(`^arn:aws(?:-us-gov|-cn)?:iam::${b.account}:role/[A-Za-z0-9_+=,.@/-]+$`).test(v)),'WORKLOAD_SEPARATION_REQUIRED');
}
/** Exact observable DB permissions are checked as the actual runtime login. API
 * writers never receive result insertion, lease mutation, or historical updates. */
export async function verifyOperationalSnapshotPrivileges(db:Database,role:'api'|'worker',binding:OperationalSnapshotBinding){
  const actual=(await db.query<{role:string;login:string;superuser:boolean;bypassrls:boolean}>(`SELECT current_user AS role,session_user AS login,r.rolsuper AS superuser,r.rolbypassrls AS bypassrls FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  const expected=role==='api'?binding.apiDatabaseRole:binding.workerDatabaseRole;
  snapshotCheck(actual&&actual.role===expected&&actual.login===expected&&!actual.superuser&&!actual.bypassrls,'DATABASE_IDENTITY_MISMATCH');
  const escalations=(await db.query(`SELECT r.rolname FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
    (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.oid IN
      (SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('operational_snapshot_candidates','operational_snapshot_delivery','operational_snapshot_results')) OR r.oid IN
      (SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='lock_operational_snapshot_authority'))`)).rows;
  const schema=(await db.query<{allowed:boolean}>("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0];
  const shared=(await db.query<{shared:boolean}>("SELECT pg_has_role($1,$2,'MEMBER') OR pg_has_role($2,$1,'MEMBER') AS shared",[binding.apiDatabaseRole,binding.workerDatabaseRole])).rows[0];
  snapshotCheck(escalations.length===0&&schema?.allowed===false&&shared?.shared===false,'DATABASE_ESCALATION_DENIED');
  const lock=(await db.query<{permitted:boolean}>("SELECT has_function_privilege(current_user,'public.lock_operational_snapshot_authority(text,text,text,text,text)','EXECUTE') AS permitted")).rows[0];snapshotCheck(lock?.permitted,'AUTHORITY_LOCK_PRIVILEGE_REQUIRED');
  const expectations:Record<string,string[]>=role==='api'?{operational_snapshot_candidates:['SELECT','INSERT'],operational_snapshot_delivery:['SELECT'],operational_snapshot_results:['SELECT']}:{operational_snapshot_candidates:['SELECT'],operational_snapshot_delivery:['SELECT'],operational_snapshot_results:['SELECT','INSERT']};
  for(const [table,allowed] of Object.entries(expectations))for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']){
    const row=(await db.query<{permitted:boolean}>('SELECT has_table_privilege(current_user,$1,$2) AS permitted',[table,privilege])).rows[0];
    snapshotCheck(row?.permitted===allowed.includes(privilege),'DATABASE_PRIVILEGE_MISMATCH');
  }
  const columns={operational_snapshot_candidates:['snapshot_id','proof_id','organization_id','environment','revision','actor_user_id','membership_id','location_id','manifest_json','manifest_sha256','request_json','request_sha256','idempotency_key_hash','input_sha256','created_at'],operational_snapshot_delivery:['snapshot_id','state','attempts','next_attempt_at','lease_token','lease_until','error_code'],operational_snapshot_results:['snapshot_id','proof_id','bundle_json','bundle_sha256','receipt_json','accepted_at']};
  for(const [table,fields] of Object.entries(columns))for(const field of fields)for(const privilege of ['SELECT','INSERT','UPDATE','REFERENCES']){
    const expected=privilege==='SELECT'||role==='api'&&privilege==='INSERT'&&(table==='operational_snapshot_candidates'||table==='operational_snapshot_delivery'&&['snapshot_id','next_attempt_at'].includes(field))||role==='worker'&&(privilege==='INSERT'&&table==='operational_snapshot_results'||privilege==='UPDATE'&&table==='operational_snapshot_delivery'&&field!=='snapshot_id');
    const observed=(await db.query<{permitted:boolean}>('SELECT has_column_privilege(current_user,$1,$2,$3) AS permitted',[table,field,privilege])).rows[0];snapshotCheck(observed?.permitted===expected,'DATABASE_COLUMN_PRIVILEGE_MISMATCH');
  }
}
/** Disabled unless a separately authenticated qualification names the exact
 * current source/profile, cohort, roles, storage, keys, retention and fence.
 * Evidence references are mandatory signed findings, never caller booleans. */
export async function initializeOperationalSnapshotRuntime(input:{
  enabled:boolean;processRole:'api'|'worker';db:Database;clock:Clock;binding:OperationalSnapshotBinding;
  qualification:Buffer;qualificationSha256:string;
  qualificationAuthority:(keyId:string)=>string|null;
  trust:ReturnType<typeof createEnvelopeTrust>;reader:EnvelopeReader;sourceJournal:EnvelopeWorker['sourceJournal'];sourceProtection:EnvelopeReader['verify'];
  store?:EnvelopeStore;kmsTransport?:KmsSigningTransport;
}):Promise<OperationalSnapshotRuntime|undefined>{
  if(!input.enabled)return undefined;
  const binding=JSON.parse(jcsBytes(input.binding).toString()) as OperationalSnapshotBinding;
  validateBinding(binding,input.clock);
  snapshotCheck(input.qualification.length<=65536&&sha256(input.qualification)===input.qualificationSha256,'QUALIFICATION_DIGEST_MISMATCH');
  const signed=JSON.parse(input.qualification.toString('utf8'));snapshotCheck(Object.keys(signed).sort().join(',')==='payload,protected,signature','QUALIFICATION_INVALID');
  const header=JSON.parse(Buffer.from(signed.protected,'base64url').toString('utf8'));
  snapshotCheck(header.alg==='ES256'&&header.typ==='application/packproof-operational-qualification+jws'&&typeof header.kid==='string'&&Object.keys(header).sort().join(',')==='alg,kid,typ','QUALIFICATION_AUTHORITY_REQUIRED');
  const pin=input.qualificationAuthority(header.kid);snapshotCheck(pin,'QUALIFICATION_AUTHORITY_REQUIRED');
  const verified=await flattenedVerify(signed,await importSPKI(pin,'ES256'),{algorithms:['ES256']});
  const qualification=JSON.parse(Buffer.from(verified.payload).toString());
  snapshotCheck(jcsBytes(qualification).equals(Buffer.from(verified.payload))&&Object.keys(qualification).sort().join(',')==='binding,evidence,expiresAt,profile,reviewedAt,reviewer'&&qualification.profile==='packproof.operational-snapshot-qualification.v1'&&jcsBytes(qualification.binding).equals(jcsBytes(binding)),'QUALIFICATION_BINDING_MISMATCH');
  const required=['actualRuntimeRoles','storageRetentionAndExactVersions','conditionalCreateAndLostResponse','humanHttpAndRevocation','leaseAndFence','independentTrustAndCompromisedKeys','freshRestoreAndUnchangedSignatures'];
  snapshotCheck(qualification.evidence&&Object.keys(qualification.evidence).sort().join(',')===required.sort().join(',')&&required.every(k=>typeof qualification.evidence[k]==='string'&&/^[a-f0-9]{64}$/.test(qualification.evidence[k]))&&typeof qualification.reviewer==='string'&&qualification.reviewer.trim().length>0,'QUALIFICATION_EVIDENCE_REQUIRED');
  const assertReady=()=>{
    validateBinding(binding,input.clock);
    snapshotCheck(jcsBytes(input.binding).equals(jcsBytes(binding))&&input.qualificationAuthority(header.kid)===pin,'QUALIFICATION_CHANGED');
    snapshotCheck(exactDate(qualification.reviewedAt)&&exactDate(qualification.expiresAt)&&Date.parse(qualification.reviewedAt)<=input.clock.now().getTime()&&Date.parse(qualification.expiresAt)>input.clock.now().getTime()&&Date.parse(qualification.expiresAt)<=Date.parse(binding.retainUntil)&&Date.parse(qualification.expiresAt)-Date.parse(qualification.reviewedAt)<=7*86400000,'QUALIFICATION_EXPIRED');
    snapshotCheck(input.trust.issuer===binding.issuer,'ISSUER_MISMATCH');input.trust.snapshot();
    snapshotCheck(!createPublicKey(input.trust.activeKey(binding.keyId).publicKeyPem).export({format:'der',type:'spki'}).equals(createPublicKey(pin).export({format:'der',type:'spki'})),'INDEPENDENT_QUALIFICATION_AUTHORITY_REQUIRED');
  };
  assertReady();await verifyOperationalSnapshotPrivileges(input.db,input.processRole,binding);
  const runtime:OperationalSnapshotRuntime={assertReady,binding,reader:input.reader,sourceJournal:input.sourceJournal,sourceProtection:input.sourceProtection,trustedPublicKey:input.trust.trustedPublicKey};
  if(input.processRole==='worker'){
    snapshotCheck(input.store&&input.kmsTransport,'WORKER_CAPABILITY_REQUIRED');const pinned=input.trust.activeKey(binding.keyId).publicKeyPem;
    snapshotCheck(!createPublicKey(pinned).export({format:'der',type:'spki'}).equals(createPublicKey(pin).export({format:'der',type:'spki'})),'INDEPENDENT_QUALIFICATION_AUTHORITY_REQUIRED');
    const sign=await createOperationalSnapshotSigner({keyArn:binding.keyArn,keyId:binding.keyId,pinnedPublicKeyPem:pinned,transport:input.kmsTransport});
    runtime.worker={store:input.store,sign:async(keyId,bytes)=>{
      assertReady();snapshotCheck(keyId===binding.keyId&&input.trust.activeKey(keyId).publicKeyPem===pinned,'KEY_CHANGED');const envelope=JSON.parse(Buffer.from(bytes).toString());validateOperationalEnvelope(envelope);
      snapshotCheck(envelope.issuer===binding.issuer&&input.clock.now().getTime()-Date.parse(envelope.issuedAt)>=0&&input.clock.now().getTime()-Date.parse(envelope.issuedAt)<=300000,'SIGNING_TIME_INVALID');
      const result=await sign(bytes);assertReady();snapshotCheck(input.trust.activeKey(keyId).publicKeyPem===pinned,'KEY_CHANGED');return result;
    }};
  }
  return runtime;
}

/** Production adapter. All flags default off; the API process never constructs
 * a KMS client or a writable result store. A legacy envelope qualification is
 * intentionally insufficient for this new profile. */
export async function initializeOperationalSnapshotEnvironment(config:AppConfig,clock:Clock,db:Database,env:NodeJS.ProcessEnv=process.env){
  const flag=env.PACKPROOF_OPERATIONAL_SNAPSHOTS_ENABLED??'false';snapshotCheck(['true','false'].includes(flag),'FEATURE_FLAG_INVALID');if(flag==='false')return undefined;
  snapshotCheck(env.PACKPROOF_ORGANIZATIONS_ENABLED==='true'&&env.PACKPROOF_ENVELOPE_TRUST_PUBLICATION_ENABLED==='true'&&['api','worker'].includes(config.processRole??'')&&config.migrateOnStart===false&&config.requireDurableReceipts===true&&config.objectStore==='s3'&&config.release.commit&&/^[a-f0-9]{40}$/.test(config.release.commit),'DEPLOYMENT_UNQUALIFIED');
  function required(name:string){const value=env[name];snapshotCheck(value,'CONFIGURATION_REQUIRED');return value;}
  const binding:OperationalSnapshotBinding={sourceSha:config.release.commit,profileSha256:OPERATIONAL_PROFILE_SHA256,organizationIds:JSON.parse(required('PACKPROOF_OPERATIONAL_SNAPSHOT_ORGANIZATION_IDS')),environment:required('PACKPROOF_OPERATIONAL_SNAPSHOT_ENVIRONMENT') as 'live'|'sandbox',cutoverAt:required('PACKPROOF_OPERATIONAL_SNAPSHOT_CUTOVER_AT'),artifactBucket:required('PACKPROOF_OPERATIONAL_SNAPSHOT_S3_BUCKET'),evidenceBucket:required('PACKPROOF_COMMITTED_S3_BUCKET'),sourceArtifactBucket:env.PACKPROOF_SOURCE_ARTIFACT_S3_BUCKET??required('PACKPROOF_COMMITTED_S3_BUCKET'),journalBucket:required('PACKPROOF_RECOVERY_S3_BUCKET'),account:required('PACKPROOF_OPERATIONAL_SNAPSHOT_BUCKET_OWNER'),region:config.awsRegion??required('AWS_REGION'),issuer:required('PACKPROOF_OPERATIONAL_SNAPSHOT_ISSUER'),keyId:required('PACKPROOF_OPERATIONAL_SNAPSHOT_KEY_ID'),keyArn:required('PACKPROOF_OPERATIONAL_SNAPSHOT_KMS_KEY_ARN'),retainUntil:required('PACKPROOF_OPERATIONAL_SNAPSHOT_RETAIN_UNTIL'),writerGeneration:required('PACKPROOF_RECOVERY_WRITER_GENERATION'),apiDatabaseRole:required('PACKPROOF_M2_API_DATABASE_ROLE'),workerDatabaseRole:required('PACKPROOF_M2_WORKER_DATABASE_ROLE'),apiRoleArn:required('PACKPROOF_API_TASK_ROLE_ARN'),workerRoleArn:required('PACKPROOF_RECOVERY_TASK_ROLE_ARN')};
  snapshotCheck(config.release.environment!=='production'||binding.environment==='live','PRODUCTION_ENVIRONMENT_REQUIRED');
  snapshotCheck(![env.PACKPROOF_MANIFEST_KMS_KEY_ARN,env.PACKPROOF_RECOVERY_KMS_KEY_ARN].includes(binding.keyArn),'KEY_SEPARATION_REQUIRED');
  const file=required('PACKPROOF_OPERATIONAL_SNAPSHOT_QUALIFICATION_FILE'),stat=statSync(file);snapshotCheck(stat.isFile()&&stat.size>0&&stat.size<=65536,'QUALIFICATION_FILE_INVALID');const qualification=readFileSync(file);
  const authorityFile=required('PACKPROOF_OPERATIONAL_SNAPSHOT_QUALIFICATION_PINS_FILE'),authorityStat=statSync(authorityFile);snapshotCheck(authorityStat.isFile()&&authorityStat.size>0&&authorityStat.size<=65536,'QUALIFICATION_AUTHORITY_REQUIRED');
  const qualificationAuthority=(keyId:string)=>{try{const bytes=readFileSync(authorityFile);snapshotCheck(bytes.length<=65536&&sha256(bytes)===required('PACKPROOF_OPERATIONAL_SNAPSHOT_QUALIFICATION_PINS_SHA256'),'QUALIFICATION_AUTHORITY_CHANGED');const pins=JSON.parse(bytes.toString());return typeof pins[keyId]==='string'?pins[keyId]:null;}catch{return null;}};
  const trust=createEnvelopeTrust({issuer:binding.issuer,clock,readRegistry:()=>{const registry=loadSignedTrustRegistryRuntime(clock,env);snapshotCheck(registry,'TRUST_REGISTRY_UNAVAILABLE');return Buffer.from(registry.signedTrustRegistryJson);},readAuthorityPins:()=>{const registry=loadSignedTrustRegistryRuntime(clock,env);snapshotCheck(registry,'TRUST_REGISTRY_UNAVAILABLE');return registry.registryAuthorityKeys;}});
  const transport=envelopeS3Transport(binding.region),storage={artifactBucket:binding.artifactBucket,evidenceBuckets:[...new Set([binding.evidenceBucket,binding.sourceArtifactBucket])],expectedBucketOwner:binding.account,clock,transport},journalReader=createEnvelopeS3Reader({...storage,evidenceBuckets:[binding.journalBucket]});
  const sourceJournal:EnvelopeWorker['sourceJournal']={store:{get:async(key,reference)=>{snapshotCheck(/^recovery\/v1\/[a-f0-9]{64}\.json$/.test(key)&&reference?.versionId&&reference.versionId!=='null','SOURCE_VERSION_REQUIRED');const result=await journalReader.readExact({bucket:binding.journalBucket,key,versionId:reference.versionId},8*1024*1024);return {body:result.body,contentType:'application/json'};}},trustedPublicKey:async(keyId,signedAt)=>{try{if(!signedAt)return null;const registry=loadSignedTrustRegistryRuntime(clock,env),key=registry?.signedTrustRegistry.registry.keys.find(k=>k.keyId===keyId);return key&&trustKeyPermitsSignature(key,{keyId,algorithm:key.algorithm,signedAt,signatureBase64:''},clock.now())?key.publicKeyPem:null;}catch{return null;}}};
  const environmentNames=[...Object.keys(env).filter(name=>name.startsWith('PACKPROOF_OPERATIONAL_SNAPSHOT')||name.startsWith('PACKPROOF_SOURCE_ARTIFACT_')), 'PACKPROOF_OPERATIONAL_SNAPSHOTS_ENABLED','PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_ENVELOPE_TRUST_PUBLICATION_ENABLED','PACKPROOF_COMMITTED_S3_BUCKET','PACKPROOF_RECOVERY_S3_BUCKET','PACKPROOF_RECOVERY_WRITER_GENERATION','PACKPROOF_M2_API_DATABASE_ROLE','PACKPROOF_M2_WORKER_DATABASE_ROLE','PACKPROOF_API_TASK_ROLE_ARN','PACKPROOF_RECOVERY_TASK_ROLE_ARN','PACKPROOF_MANIFEST_KMS_KEY_ARN','PACKPROOF_RECOVERY_KMS_KEY_ARN','AWS_REGION'];
  const environmentSnapshot=()=>Object.fromEntries([...new Set(environmentNames)].sort().map(name=>[name,env[name]??null])),originalEnvironment=jcsBytes(environmentSnapshot());
  const input:Parameters<typeof initializeOperationalSnapshotRuntime>[0]={enabled:true,processRole:config.processRole as 'api'|'worker',db,clock,binding,qualification,qualificationSha256:required('PACKPROOF_OPERATIONAL_SNAPSHOT_QUALIFICATION_SHA256'),qualificationAuthority,trust,reader:createEnvelopeS3Reader(storage),sourceJournal,sourceProtection:journalReader.verify};
  if(config.processRole==='worker'){const kms=new KMSClient({region:binding.region,maxAttempts:3});input.store=createEnvelopeS3Store(storage);input.kmsTransport={getPublicKey:request=>kms.send(new GetPublicKeyCommand(request),{abortSignal:AbortSignal.timeout(10000)}),sign:request=>kms.send(new SignCommand(request),{abortSignal:AbortSignal.timeout(10000)})};}
  const runtime=await initializeOperationalSnapshotRuntime(input);if(!runtime)return undefined;const ready=runtime.assertReady;
  runtime.assertReady=()=>{snapshotCheck(jcsBytes(environmentSnapshot()).equals(originalEnvironment)&&config.release.commit===binding.sourceSha&&config.processRole===input.processRole&&config.objectStore==='s3'&&config.requireDurableReceipts===true&&config.migrateOnStart===false,'CONFIGURATION_CHANGED');const current=readFileSync(file);snapshotCheck(current.length<=65536&&sha256(current)===input.qualificationSha256,'QUALIFICATION_CHANGED');ready();};
  // The worker sign closure must also consult the current hosted activation.
  if(runtime.worker){const sign=runtime.worker.sign;runtime.worker.sign=async(key,bytes)=>{runtime.assertReady();const result=await sign(key,bytes);runtime.assertReady();return result;};}
  return runtime;
}
