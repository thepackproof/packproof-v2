import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateRestoredLaunch} from './order-workspace-restored-rehearsal.mjs';

const prefix='packproof-order-workspace-rehearsal-20261117';
const cluster='arn:aws:ecs:us-east-1:784514617543:cluster/'+prefix;
const image='784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:'+'a'.repeat(64);
const host=prefix+'-pitr.c8v2esku2zyt.us-east-1.rds.amazonaws.com';
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

test('the restored owner operation binds the private clone, exact image, review, task cluster and strict TLS',()=>{
  const review={schema:'packproof.restored-order-workspace/v1',source:'a'.repeat(40),image,targetHost:host,database:'packproof_v2',
    clusterArn:cluster,migrationSha256:'941c88e20122caaaab739ee28f791d5b65157a6bb4acd347c4ff7e2e3801c1bd',
    ownerRole:'packproof',apiRole:'packproof_records_api_v1',workerRole:'packproof_records_worker_v1',expiresAt:new Date(Date.now()+180000).toISOString()};
  const env={PACKPROOF_DB_HOST:host,PACKPROOF_DB_NAME:review.database,PACKPROOF_DB_PORT:'5432',PACKPROOF_DB_USER:review.ownerRole,
    PACKPROOF_DB_PASSWORD:'synthetic',PACKPROOF_DB_SSLMODE:'verify-full',PACKPROOF_DB_CA_FILE:'/app/certs/rds-us-east-1-bundle.pem',
    PACKPROOF_RELEASE_SHA:review.source,PACKPROOF_RELEASE_IMAGE:image,PACKPROOF_RESTORED_REVIEW_SHA256:digest(review),
    PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_ORDER_WORKSPACE_ENABLED:'false'};
  const meta={container:{Image:image,ImageID:image.split('@')[1]},task:{TaskARN:cluster.replace(':cluster/',':task/')+'/'+'a'.repeat(32)}};
  assert.doesNotThrow(()=>validateRestoredLaunch(env,review,meta));
  const live={...review,targetHost:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'};
  assert.throws(()=>validateRestoredLaunch({...env,PACKPROOF_DB_HOST:live.targetHost,PACKPROOF_RESTORED_REVIEW_SHA256:digest(live)},live,meta),/TARGET/);
  for(const patch of [{PACKPROOF_DB_SSLMODE:'disable'},{PGOPTIONS:'-c search_path=wrong'},{DATABASE_URL:'postgres://wrong'},{PACKPROOF_DB_HOST:'127.0.0.1'},{PACKPROOF_MIGRATE_ON_START:'true'}])
    assert.throws(()=>validateRestoredLaunch({...env,...patch},review,meta),/CONNECTION/);
  assert.throws(()=>validateRestoredLaunch(env,review,{...meta,container:{...meta.container,ImageID:'sha256:'+'c'.repeat(64)}}),/IMAGE/);
  assert.throws(()=>validateRestoredLaunch({...env,PACKPROOF_RELEASE_SHA:'d'.repeat(40)},review,meta),/REVIEW/);
});
