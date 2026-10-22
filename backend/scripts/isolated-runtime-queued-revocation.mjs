// One-shot acceptance through the real ECS worker identity and dispatcher.
// It never creates identity/domain rows or reports a simulated delivery.
import assert from 'node:assert/strict';
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import {composeDatabaseUrl} from '../dist/config.js';
import {createPgDatabase} from '../dist/db/postgres.js';
import {systemClock} from '../dist/clock.js';
import {dispatchWebhooks,webhookConfigFromEnv} from '../dist/platform/webhooks.js';

assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m1-synthetic');
assert.equal(process.env.PACKPROOF_DB_NAME,'m1_service_20261021');
assert.equal(process.env.PACKPROOF_DB_USER,'m1_service_worker');
assert.ok(process.env.ECS_CONTAINER_METADATA_URI_V4);
const mode=process.env.REVOCATION_MODE,id=process.env.REVOCATION_WEBHOOK_ID,key=process.env.REVOCATION_REPORT_KEY;
assert.ok(['enqueue','dispatch'].includes(mode));assert.match(id??'',/^wh_[A-Za-z0-9_-]+$/);
assert.match(key??'',/^acceptance\/runtime\/probes\/worker\/queued-[a-f0-9]{32}-(enqueue|dispatch)\.json$/);
const configuration=JSON.parse(process.env.ISOLATED_CONFIGURATION??'{}');delete process.env.ISOLATED_CONFIGURATION;
process.env.PACKPROOF_WEBHOOK_ENCRYPTION_KEY=configuration.PACKPROOF_WEBHOOK_ENCRYPTION_KEY;
const opened=createPgDatabase(composeDatabaseUrl()),s3=new S3Client({region:'us-east-1',maxAttempts:3});
const report={schema:'packproof.queued-revocation.v1',mode,webhookId:id,source:process.env.PACKPROOF_RELEASE_SHA,transportCalls:0};
try {
 const metadata=await fetch(process.env.ECS_CONTAINER_METADATA_URI_V4+'/task',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
 report.taskArn=metadata.TaskARN;
 const db=opened.db;
 const login=(await db.query('SELECT current_user AS login,current_database() AS database')).rows[0];
 assert.equal(login.login,'m1_service_worker');assert.equal(login.database,'m1_service_20261021');report.databaseIdentity=login;
 const authority=(await db.query('SELECT a.delegation_id,d.revoked_at FROM platform_webhook_authorizations a JOIN platform_delegations d ON d.id=a.delegation_id WHERE a.webhook_id=$1',[id])).rows[0];
 assert.ok(authority);assert.equal(Boolean(authority.revoked_at),mode==='dispatch');
 const rows=async()=>(await db.query('SELECT id,state,attempts,last_status,delivered_at FROM api_webhook_deliveries WHERE webhook_id=$1 ORDER BY id',[id])).rows;
 report.before=await rows();
 // A fail-closed observation point: reaching transport is always a failure.
 // No network callback is made and no successful receipt can be fabricated.
 const transport=async()=>{report.transportCalls++;throw new Error('Revoked delivery reached transport');};
 report.dispatch=await dispatchWebhooks(db,systemClock,webhookConfigFromEnv(),transport,mode==='enqueue'?0:100);
 report.after=await rows();assert.ok(report.after.length>0,'No genuine event deliveries were queued');
 assert.equal(report.transportCalls,0);assert.equal(report.dispatch.delivered,0);
 assert.ok(report.after.every(r=>r.state==='pending'&&r.last_status===null&&r.delivered_at===null));
 if(mode==='enqueue')assert.ok(report.after.every(r=>r.attempts===0));
 else {
  assert.ok(report.before.length>0&&report.before.every(r=>r.attempts===0));
  assert.ok(report.after.every(r=>r.attempts===1));assert.ok(report.dispatch.failed>=report.after.length);
 }
 report.status='PASSED';
} catch(error) {report.status='FAILED';report.failure={name:error.name,code:error.code};process.exitCode=1;}
finally {
 await opened.close();
 await s3.send(new PutObjectCommand({Bucket:'packproof-m1-20261020-uploadbucket-8o4ikwomdg8h',Key:key,Body:JSON.stringify(report),ContentType:'application/json',IfNoneMatch:'*'}));
 s3.destroy();console.log(JSON.stringify(report));
}
