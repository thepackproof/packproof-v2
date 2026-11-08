import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {RUNTIME_PINS as p,validateRuntimeReview} from './zero-touch-runtime-rehearsal.mjs';
const now=new Date('2026-11-08T18:00:00Z');
const review={schema:'packproof.zero-touch-runtime-review/v1',source:p.source,imageDigest:p.image,snapshotArn:p.snapshot,sourceInstance:'packproof-v2-staging-db',instanceArn:`arn:aws:rds:us-east-1:784514617543:db:${p.instance}`,privateRestore:true,inventorySha256:p.inventory,target:{host:`${p.instance}.c8v2esku2zyt.us-east-1.rds.amazonaws.com`,database:'packproof_v2'},expiresAt:'2026-11-08T18:30:00Z'};
const env={PACKPROOF_TEST_PURPOSE:'isolated-production-restore',PACKPROOF_DB_HOST:review.target.host,PACKPROOF_DB_NAME:review.target.database,PACKPROOF_DB_USER:'packproof',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_ENVIRONMENT:'staging',PACKPROOF_RELEASE_SHA:p.source,PACKPROOF_ORGANIZATIONS_ENABLED:'false',PACKPROOF_CLAIM_EXPORTS_ENABLED:'false'};
test('only the pinned candidate on the private restore is admitted',()=>assert.match(validateRuntimeReview(review,env,now),/^[a-f0-9]{64}$/));
test('production, preserved M1 and lookalike hosts reject before any DB access',()=>{
 for(const host of ['packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com','packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',review.target.host+'.attacker.example'])assert.throws(()=>validateRuntimeReview({...review,target:{...review.target,host}},{...env,PACKPROOF_DB_HOST:host},now),/ISOLATED_TARGET/);
});
test('wrong images, snapshots, inventory and source copies cannot qualify',()=>{
 for(const patch of [{source:'a'.repeat(40)},{imageDigest:'sha256:'+'b'.repeat(64)},{snapshotArn:p.snapshot+'-copy'},{inventorySha256:'c'.repeat(64)},{sourceInstance:'packproof-m1-20261020-db'},{privateRestore:false}])assert.throws(()=>validateRuntimeReview({...review,...patch},env,now),/EXACT_REVIEW/);
});
test('stale or excessively long reviews reject',()=>{
 for(const expiresAt of [now.toISOString(),'2026-11-08T19:01:00Z','invalid'])assert.throws(()=>validateRuntimeReview({...review,expiresAt},env,now),/REVIEW_EXPIRED/);
});
test('ambient database selection, role switching and PG options reject',()=>{
 for(const patch of [{DATABASE_URL:'postgresql://other.invalid/db'},{PACKPROOF_DB_SECRET_ARN:'secret'},{PGOPTIONS:'-c role=packproof'},{PGHOST:'other.invalid'}])assert.throws(()=>validateRuntimeReview(review,{...env,...patch},now),/AMBIENT_DATABASE/);
});
test('automatic migrations, feature activation and wrong release environment reject',()=>{
 for(const patch of [{PACKPROOF_MIGRATE_ON_START:'true'},{PACKPROOF_ENVIRONMENT:'production'},{PACKPROOF_ORGANIZATIONS_ENABLED:'true'},{PACKPROOF_CLAIM_EXPORTS_ENABLED:'true'},{PACKPROOF_DB_USER:p.apiRole},{PACKPROOF_RELEASE_SHA:'d'.repeat(40)}])assert.throws(()=>validateRuntimeReview(review,{...env,...patch},now),/ENVIRONMENT_REQUIRED/);
});
test('temporary bootstrap has no public route, original DB ingress or unrelated secrets',async()=>{
 const t=JSON.parse(await readFile(new URL('../partner-foundation/zero-touch-release-bootstrap.json',import.meta.url),'utf8')),r=t.Resources;
 assert.equal(r.SecretsEndpoint.Condition,'OwnerSecretReady');
 assert.equal(r.EndpointSecurityGroup.Properties.SecurityGroupIngress.length,0);
 const outbound=r.RehearsalTaskSecurityGroup.Properties.SecurityGroupEgress;
 assert.deepEqual(outbound.filter(x=>x.ToPort===5432),[{IpProtocol:'tcp',FromPort:5432,ToPort:5432,DestinationSecurityGroupId:{Ref:'RestoredDatabaseSecurityGroup'}}]);
 assert.equal(JSON.stringify(t).includes('0.0.0.0/0'),false);
 const secrets=r.SecretsEndpoint.Properties.PolicyDocument.Statement[0].Resource;
 assert.equal(secrets.length,3);assert.deepEqual(secrets[0],{Ref:'RestoredOwnerSecretArn'});
 assert.ok(secrets.slice(1).every(x=>x.includes('packproof/production/database/records-')));
 assert.ok(!JSON.stringify(t).includes('rds!db-8f5824eb'));
});
