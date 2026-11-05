import {generateKeyPairSync} from 'node:crypto';
import {FlattenedSign} from 'jose';
import {expect,it} from 'vitest';
import type {Database} from '../src/db/database.js';
import {jcsBytes,sha256} from '../src/integrity/envelope-profile.js';
import {initializeOperationalSnapshotRuntime,OPERATIONAL_PROFILE_SHA256,type OperationalSnapshotBinding} from '../src/records/operational-snapshot-runtime.js';

const reviewer=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),signer=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const reviewerPem=reviewer.publicKey.export({type:'spki',format:'pem'}).toString(),signerPem=signer.publicKey.export({type:'spki',format:'pem'}).toString();
const clock={now:()=>new Date('2026-11-04T12:00:00.000Z')};
const binding:OperationalSnapshotBinding={sourceSha:'a'.repeat(40),profileSha256:OPERATIONAL_PROFILE_SHA256,organizationIds:['org_fixture'],environment:'sandbox',cutoverAt:'2026-11-01T00:00:00.000Z',artifactBucket:'artifact-fixture',evidenceBucket:'evidence-fixture',sourceArtifactBucket:'source-fixture',journalBucket:'journal-fixture',account:'123456789012',region:'us-east-1',issuer:'https://issuer.example.test',keyId:'snapshot-key',keyArn:'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012',retainUntil:'2027-11-01T00:00:00.000Z',writerGeneration:'current-writer',apiDatabaseRole:'api_fixture',workerDatabaseRole:'worker_fixture',apiRoleArn:'arn:aws:iam::123456789012:role/api',workerRoleArn:'arn:aws:iam::123456789012:role/worker'};
const evidence=Object.fromEntries(['actualRuntimeRoles','storageRetentionAndExactVersions','conditionalCreateAndLostResponse','humanHttpAndRevocation','leaseAndFence','independentTrustAndCompromisedKeys','freshRestoreAndUnchangedSignatures'].map(key=>[key,'b'.repeat(64)]));
async function input(change:{qualificationBinding?:OperationalSnapshotBinding;expiresAt?:string;unsafeApiRole?:boolean}={}){
  const qualification=jcsBytes(await new FlattenedSign(jcsBytes({profile:'packproof.operational-snapshot-qualification.v1',binding:change.qualificationBinding??binding,evidence,reviewedAt:'2026-11-04T00:00:00.000Z',expiresAt:change.expiresAt??'2026-11-05T00:00:00.000Z',reviewer:'Independent deployment review'})).setProtectedHeader({alg:'ES256',kid:'qualification-authority',typ:'application/packproof-operational-qualification+jws'}).sign(reviewer.privateKey));
  const db={query:async(sql:string,args?:unknown[])=>{
    if(sql.startsWith('SELECT current_user'))return {rows:[{role:'api_fixture',login:'api_fixture',superuser:false,bypassrls:false}],rowCount:1};
    if(sql.startsWith('SELECT r.rolname'))return {rows:[],rowCount:0};
    if(sql.startsWith('SELECT has_schema_privilege'))return {rows:[{allowed:false}],rowCount:1};
    if(sql.startsWith('SELECT pg_has_role'))return {rows:[{shared:false}],rowCount:1};
    if(sql.startsWith('SELECT has_function_privilege'))return {rows:[{permitted:true}],rowCount:1};
    if(sql.startsWith('SELECT has_column_privilege')){const [table,column,privilege]=args!;return {rows:[{permitted:privilege==='SELECT'||privilege==='INSERT'&&(table==='operational_snapshot_candidates'||table==='operational_snapshot_delivery'&&['snapshot_id','next_attempt_at'].includes(String(column)))}],rowCount:1};}
    const allowed=change.unsafeApiRole&&args?.[0]==='operational_snapshot_results'?['SELECT','INSERT']:['SELECT'];return {rows:[{permitted:allowed.includes(String(args?.[1]))}],rowCount:1};
  }} as unknown as Database;
  return {enabled:true,processRole:'api' as const,db,clock,binding:{...binding},qualification,qualificationSha256:sha256(qualification),qualificationAuthority:(id:string)=>id==='qualification-authority'?reviewerPem:null,trust:{issuer:binding.issuer,snapshot:()=>({}),activeKey:()=>({publicKeyPem:signerPem}),trustedPublicKey:async()=>signerPem},reader:{},sourceJournal:{}} as unknown as Parameters<typeof initializeOperationalSnapshotRuntime>[0];
}
it('defaults to no capability without explicit activation',async()=>{expect(await initializeOperationalSnapshotRuntime({enabled:false} as any)).toBeUndefined();});
it('accepts an independently authenticated exact current source/profile qualification and creates no API signer',async()=>{const runtime=await initializeOperationalSnapshotRuntime(await input());expect(runtime).toBeDefined();expect(runtime?.worker).toBeUndefined();runtime?.assertReady();});
it('rejects a self-authored proof, stale source binding, expired qualification and widened API authority',async()=>{
  const unsigned=await input();unsigned.qualification=Buffer.from('{}');unsigned.qualificationSha256=sha256(unsigned.qualification);await expect(initializeOperationalSnapshotRuntime(unsigned)).rejects.toThrow('QUALIFICATION_INVALID');
  await expect(initializeOperationalSnapshotRuntime(await input({qualificationBinding:{...binding,sourceSha:'c'.repeat(40)}}))).rejects.toThrow('QUALIFICATION_BINDING_MISMATCH');
  await expect(initializeOperationalSnapshotRuntime(await input({expiresAt:'2026-11-04T01:00:00.000Z'}))).rejects.toThrow('QUALIFICATION_EXPIRED');
  await expect(initializeOperationalSnapshotRuntime(await input({unsafeApiRole:true}))).rejects.toThrow('DATABASE_PRIVILEGE_MISMATCH');
});
it('rechecks the current qualification pin and configured binding during use',async()=>{const config=await input(),runtime=await initializeOperationalSnapshotRuntime(config);config.qualificationAuthority=()=>null;expect(()=>runtime!.assertReady()).toThrow('QUALIFICATION_CHANGED');});
