import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LIVE_PINS as p,validateLiveReview,validateLiveInspection} from './zero-touch-production-operator.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const now=new Date('2026-11-08T23:00:00Z');
const review={schema:'packproof.zero-touch-live-review/v1',source:p.source,image:p.image,bridge:p.bridge,target:{host:p.host,database:p.database},inventorySha256:p.current,qualifiedRuntime:true,qualifiedRollback:true,qualificationSha256:'a'.repeat(64),snapshotArn:'arn:aws:rds:us-east-1:784514617543:snapshot:packproof-zero-touch-live-20261108t2250',snapshotVerified:true,expiresAt:'2026-11-09T00:00:00Z'};
const env={ZERO_TOUCH_LIVE_MODE:'inspect',PACKPROOF_OPERATOR_PURPOSE:'zero-touch-production-release',PACKPROOF_RELEASE_SHA:p.source,PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_DB_HOST:p.host,PACKPROOF_DB_NAME:p.database,PACKPROOF_DB_USER:'packproof',PACKPROOF_ORGANIZATIONS_ENABLED:'false',PACKPROOF_CLAIM_EXPORTS_ENABLED:'false'};
test('explicit live review admits only the qualified candidate, rollback and fixed target',()=>assert.match(validateLiveReview(review,env,now),/^[a-f0-9]{64}$/));
test('unqualified images, changed source, mismatched target and missing restore evidence reject',()=>{
 for(const patch of [{source:'b'.repeat(40)},{image:'sha256:'+'c'.repeat(64)},{qualifiedRuntime:false},{qualifiedRollback:false},{target:{host:'other.rds.amazonaws.com',database:p.database}},{inventorySha256:'d'.repeat(64)}])assert.throws(()=>validateLiveReview({...review,...patch},env,now),/EXACT_REVIEW/);
 for(const patch of [{snapshotVerified:false},{snapshotArn:review.snapshotArn.replace('784514617543','111111111111')}])assert.throws(()=>validateLiveReview({...review,...patch},env,now),/RECOVERY_SNAPSHOT/);
});
test('source services cannot activate customer features, swap database targets or use ambient credentials',()=>{
 for(const patch of [{PACKPROOF_ORGANIZATIONS_ENABLED:'true'},{PACKPROOF_CLAIM_EXPORTS_ENABLED:'true'},{PACKPROOF_DB_USER:p.api},{PACKPROOF_MIGRATE_ON_START:'true'}])assert.throws(()=>validateLiveReview(review,{...env,...patch},now),/OPERATOR_BINDING/);
 for(const patch of [{DATABASE_URL:'postgresql://other.invalid/db'},{PGOPTIONS:'-c role=packproof'},{PACKPROOF_DB_SECRET_ARN:'other'}])assert.throws(()=>validateLiveReview(review,{...env,...patch},now),/AMBIENT_DATABASE/);
});
test('runtime verification requires the correct distinct actual login',()=>{
 assert.match(validateLiveReview(review,{...env,ZERO_TOUCH_LIVE_MODE:'verify-api',PACKPROOF_DB_USER:p.api},now),/^[a-f0-9]{64}$/);
 assert.match(validateLiveReview(review,{...env,ZERO_TOUCH_LIVE_MODE:'verify-worker',PACKPROOF_DB_USER:p.worker},now),/^[a-f0-9]{64}$/);
 assert.throws(()=>validateLiveReview(review,{...env,ZERO_TOUCH_LIVE_MODE:'verify-worker',PACKPROOF_DB_USER:p.api},now),/OPERATOR_BINDING/);
});
test('migration requires a fresh intact inspection bound to the same review and historical receipts',()=>{
 const reviewSha256=validateLiveReview(review,env,now),body={schema:'packproof.zero-touch-live-inspection/v1',source:p.source,targetHost:p.host,reviewSha256,ledgerSha256:p.previous,baseline:{sha256:'a'.repeat(64)},inspectedAt:now.toISOString()},receipt={...body,sha256:hash(body)};
 assert.equal(validateLiveInspection(receipt,reviewSha256,now).ledgerSha256,p.previous);
 assert.throws(()=>validateLiveInspection({...receipt,ledgerSha256:p.current},reviewSha256,now),/INSPECTION_BINDING/);
 assert.throws(()=>validateLiveInspection(receipt,'b'.repeat(64),now),/INSPECTION_BINDING/);
 assert.throws(()=>validateLiveInspection(receipt,reviewSha256,new Date(now.getTime()+901000)),/INSPECTION_EXPIRED/);
});
test('expired release reviews reject before any database call',()=>assert.throws(()=>validateLiveReview({...review,expiresAt:now.toISOString()},env,now),/REVIEW_EXPIRED/));
