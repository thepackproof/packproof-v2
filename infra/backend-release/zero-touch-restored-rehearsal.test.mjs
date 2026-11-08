import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRestoredReview} from './zero-touch-restored-rehearsal.mjs';
const now=new Date('2026-11-08T03:00:00Z');
const review={schema:'packproof.zero-touch-restored-review/v1',source:'3bff0173c9d91fc11ae614d72872b877628c327d',imageDigest:'sha256:edb5051c4dc1dbd09fee6fd69e00bb16f47645486570f4e76861000812c3df96',syntheticOnly:true,originalInventorySha256:'4c8fdf8c9a1c08b22c1b13ddd54dc34c7e51cdd3a1dc238edb5485a7a970556e',inventorySha256:'a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d',snapshotArn:'arn:aws:rds:us-east-1:784514617543:snapshot:packproof-zero-touch-3bff0173',instanceArn:'arn:aws:rds:us-east-1:784514617543:db:packproof-zero-touch-3bff0173',target:{host:'packproof-zero-touch-3bff0173.synthetic.us-east-1.rds.amazonaws.com',database:'m1_service_20261021'},expiresAt:'2026-11-08T03:30:00Z'};
review.originalDataSha256='d'.repeat(64);review.originalDataReceiptSha256='e'.repeat(64);
const env={PACKPROOF_ZERO_TOUCH_REHEARSAL_ENTRYPOINT:'true',PACKPROOF_TEST_PURPOSE:'isolated-m1-synthetic',PACKPROOF_DB_HOST:review.target.host,PACKPROOF_DB_NAME:review.target.database,PACKPROOF_DB_USER:'packproof',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_ENVIRONMENT:'staging',PACKPROOF_RELEASE_SHA:review.source};
test('restored rehearsal requires the exact isolated resource, source, environment and fresh review',()=>assert.match(validateRestoredReview(review,env,now),/^[a-f0-9]{64}$/));
test('production and preserved original hosts cannot be rehearsal targets',()=>{
 for(const host of ['packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com','packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com','packproof-zero-touch-3bff0173.attacker.example'])assert.throws(()=>validateRestoredReview({...review,target:{...review.target,host}},{...env,PACKPROOF_DB_HOST:host},now),/REHEARSAL_ISOLATED_HOST_REQUIRED/);
});
test('wrong image, source, baseline and copied snapshot identities reject before database access',()=>{
 for(const change of [{source:'a'.repeat(40)},{imageDigest:'sha256:'+'b'.repeat(64)},{originalInventorySha256:'c'.repeat(64)},{syntheticOnly:false},{snapshotArn:review.snapshotArn+'-copy'}])assert.throws(()=>validateRestoredReview({...review,...change},env,now),/REHEARSAL_/);
});
test('expired review and ambient automatic migration settings reject before database access',()=>{
 assert.throws(()=>validateRestoredReview({...review,expiresAt:now.toISOString()},env,now),/REHEARSAL_REVIEW_EXPIRED/);
 assert.throws(()=>validateRestoredReview(review,{...env,PACKPROOF_MIGRATE_ON_START:'true'},now),/REHEARSAL_RUNTIME_BINDING_REQUIRED/);
});
