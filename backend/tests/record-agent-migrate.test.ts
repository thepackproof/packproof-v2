import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {migrationInventory,migrate} from '../src/db/migrate.js';
import {splitSqlStatements} from '../src/db/sql.js';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {agentManifest,agentDigest,validateAgentReview,validateAgentTaskMetadata,agentInspection,validateAgentInspection,validateAgentRehearsal,inspectAgentState,applyAgentInTransaction,planAgentRuntimePrivilegeDelta} from '../scripts/record-agent-migrate.mjs';
import {agentOperatorConfiguration} from '../scripts/record-agent-migrate-cli.mjs';
import {combineAgentRehearsal} from '../../infra/backend-release/record-agent-rehearsal-receipt.mjs';
const suffix=randomBytes(6).toString('hex');
const review={schema:'packproof.record-agent-staging-review/v1',environment:'staging',approvedNonproduction:true,clusterArn:'arn:aws:ecs:us-east-1:784514617543:cluster/isolated',source:'a'.repeat(40),previousSource:'b'.repeat(40),candidateImage:'sha256:'+'c'.repeat(64),previousImage:'sha256:'+'d'.repeat(64),inventorySha256:agentManifest.inventorySha256,predecessorInventorySha256:agentManifest.predecessorInventorySha256,target:{host:'packproof-connect-g1.example.us-east-1.rds.amazonaws.com',database:'packproof_g1'},restored:{host:'packproof-connect-rehearsal.example.us-east-1.rds.amazonaws.com',database:'packproof_g1'},ownerRole:'packproof',apiRole:`agent_api_${suffix}`,workerRole:`agent_worker_${suffix}`};
const now=new Date('2026-11-06T12:00:00Z');
const sealed=(body:Record<string,any>)=>({...body,sha256:agentDigest(body)});
const rehearsal=()=>{
 const migrationTaskArn=`arn:aws:ecs:us-east-1:784514617543:task/isolated/${'1'.repeat(32)}`,taskArn=`arn:aws:ecs:us-east-1:784514617543:task/isolated/${'2'.repeat(32)}`;
 const migrationReport=sealed({schema:'packproof.record-agent-migration-application/v1',reviewSha256:agentDigest(review),source:review.source,candidateImage:review.candidateImage,taskArn:migrationTaskArn,image:review.candidateImage,previousSource:review.previousSource,previousImage:review.previousImage,targetHost:review.restored.host,targetDatabase:review.restored.database,inventorySha256:review.inventorySha256,appliedCount:107,alreadyApplied:false,rehearsal:true,baselinePreserved:true,runtimeAuthorityPreserved:true,rolesChanged:false,featureActivation:false,baselineDataSha256:'e'.repeat(64),baselineCatalogSha256:'f'.repeat(64),baselineAuthoritySha256:'1'.repeat(64),completedAt:now.toISOString()});
 const previousImageReport=sealed({schema:'packproof.record-agent-previous-image-probe/v1',reviewSha256:agentDigest(review),source:review.previousSource,image:review.previousImage,targetHost:review.restored.host,targetDatabase:review.restored.database,clusterArn:review.clusterArn,taskArn,inventorySha256:review.inventorySha256,migrationCount:107,processRole:'api',databaseReadOnly:true,workersStarted:false,featuresActivated:false,schemaCurrent:true,identity:{role:review.apiRole,login:review.apiRole,database:review.restored.database,schema:'public',default_read_only:'on'},tls:{ssl:true,version:'TLSv1.3'},metaCommit:review.previousSource,metaImage:review.previousImage,checks:['/meta','/health','/ready'].map(route=>({route,status:200})),completedAt:now.toISOString()});
 return sealed({schema:'packproof.record-agent-release-rehearsal/v1',reviewSha256:agentDigest(review),source:review.source,previousSource:review.previousSource,candidateImage:review.candidateImage,previousImage:review.previousImage,restoredHost:review.restored.host,restoredDatabase:review.restored.database,inventorySha256:review.inventorySha256,migrationExitCode:0,previousImageExitCode:0,baselinePreserved:true,runtimeAuthorityPreserved:true,migrationTaskArn,migrationReport,migrationReportSha256:migrationReport.sha256,previousImageReport,previousImageReportSha256:previousImageReport.sha256,completedAt:now.toISOString(),taskArns:[migrationTaskArn,taskArn]});
};
describe('additive108 explicit source, isolated target and receipt gates',()=>{
 it('rejects production alias, shared target, missing approval, roles, source or image binding',()=>{
  expect(validateAgentReview(review)).toBe(agentDigest(review));
  for(const changed of [{approvedNonproduction:false},{target:{...review.target,host:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'}},{restored:review.target},{workerRole:review.apiRole},{ownerRole:'bad;role'},{source:review.previousSource},{candidateImage:review.previousImage},{inventorySha256:'0'.repeat(64)}]){
   expect(()=>validateAgentReview({...review,...changed})).toThrow();
  }
 });
 it('binds actual ECS container image and task to the reviewed account and cluster',()=>{
  const taskArn=`arn:aws:ecs:us-east-1:784514617543:task/isolated/${'3'.repeat(32)}`;
  expect(validateAgentTaskMetadata({ImageID:review.candidateImage},{TaskARN:taskArn},review,review.candidateImage)).toEqual({taskArn,image:review.candidateImage});
  for(const [container,task] of [[{ImageID:review.previousImage},{TaskARN:taskArn}],[{ImageID:review.candidateImage},{TaskARN:taskArn.replace(':784514617543:',':111111111111:')}],[{ImageID:review.candidateImage},{TaskARN:taskArn.replace('/isolated/','/other/')}],[{ImageID:review.candidateImage},{TaskARN:taskArn.replace(':us-east-1:',':us-west-2:')}]])expect(()=>validateAgentTaskMetadata(container,task,review,review.candidateImage)).toThrow('AGENT_ACTUAL_TASK_IMAGE_CLUSTER_MISMATCH');
 });
 it('requires fresh preservation inspection and independent previous-image rehearsal evidence',()=>{
  const state={pending:true},receipt=agentInspection(state,review,now);
  expect(()=>validateAgentInspection(receipt,state,review,now)).not.toThrow();
  expect(()=>validateAgentInspection(receipt,{pending:false},review,now)).toThrow('AGENT_INSPECTION_STATE_CHANGED');
  expect(()=>validateAgentInspection(receipt,state,review,new Date(now.getTime()+900001))).toThrow('AGENT_INSPECTION_EXPIRED');
  expect(()=>validateAgentRehearsal(rehearsal(),review,now)).not.toThrow();
  const {sha256,...body}=rehearsal();
  for(const changed of [{previousImageExitCode:1},{baselinePreserved:false},{taskArns:[body.taskArns[0]]},{previousImageReportSha256:''},{migrationReport:undefined},{previousImageReport:undefined},{taskArns:body.taskArns.map(arn=>arn.replace(':784514617543:',':111111111111:'))},{previousImage:'sha256:'+'0'.repeat(64)},{restoredHost:review.target.host}])expect(()=>validateAgentRehearsal(sealed({...body,...changed}),review,now)).toThrow();
  const {sha256:migrationSha,...migrationBody}=body.migrationReport;
  for(const changed of [{image:review.previousImage},{taskArn:body.taskArns[1]},{source:review.previousSource},{alreadyApplied:true}]){
   const migrationReport=sealed({...migrationBody,...changed});
   expect(()=>validateAgentRehearsal(sealed({...body,migrationReport,migrationReportSha256:migrationReport.sha256}),review,now)).toThrow('AGENT_REHEARSAL_MIGRATION_REPORT_MISMATCH');
  }
  // Re-sealing altered nested evidence must not bypass source/image/readiness binding.
  const {sha256:probeSha,...probeBody}=body.previousImageReport;
  for(const changed of [{source:review.source},{image:review.candidateImage},{targetHost:review.target.host},{databaseReadOnly:false},{checks:[{route:'/meta',status:200}]},{taskArn:body.migrationTaskArn}]){
   const previousImageReport=sealed({...probeBody,...changed});
   expect(()=>validateAgentRehearsal(sealed({...body,previousImageReport,previousImageReportSha256:previousImageReport.sha256}),review,now)).toThrow();
  }
  expect(()=>validateAgentRehearsal(rehearsal(),review,new Date(now.getTime()+86400001))).toThrow('AGENT_REHEARSAL_REPORT_EXPIRED');
 });
 it('combines only matching stopped ECS task results with successful embedded reports',()=>{
  const receipt=rehearsal(),described={failures:[],tasks:[receipt.migrationReport,receipt.previousImageReport].map((report:any,index:number)=>({taskArn:report.taskArn,clusterArn:review.clusterArn,lastStatus:'STOPPED',containers:[{imageDigest:index?review.previousImage:review.candidateImage,lastStatus:'STOPPED',exitCode:0}]}))};
  expect(()=>validateAgentRehearsal(combineAgentRehearsal(review,receipt.migrationReport,receipt.previousImageReport,described,now),review,now)).not.toThrow();
  for(const field of ['exitCode','imageDigest']){
   const changed=JSON.parse(JSON.stringify(described));changed.tasks[0].containers[0][field]=field==='exitCode'?1:'sha256:'+'0'.repeat(64);
   expect(()=>combineAgentRehearsal(review,receipt.migrationReport,receipt.previousImageReport,changed,now)).toThrow('AGENT_REHEARSAL_TASK_RESULT_MISMATCH');
  }
 });
 it('requires launch-time owner credentials, exact staging target and rejects PG overrides',()=>{
  const env={PACKPROOF_AGENT_REVIEW_JSON:JSON.stringify(review),PACKPROOF_AGENT_REVIEW_SHA256:agentDigest(review),PACKPROOF_RELEASE_SHA:review.source,PACKPROOF_AGENT_CANDIDATE_IMAGE_DIGEST:review.candidateImage,PACKPROOF_OPERATOR_PURPOSE:'record-agent-isolated-staging-preparation',PACKPROOF_ENVIRONMENT:'staging',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_ORGANIZATIONS_ENABLED:'false',PACKPROOF_CLAIM_EXPORTS_ENABLED:'false',PACKPROOF_DB_HOST:review.target.host,PACKPROOF_DB_NAME:review.target.database,PACKPROOF_DB_USER:review.ownerRole,PACKPROOF_DB_PASSWORD:'synthetic-fixture',PACKPROOF_DB_SSLMODE:'verify-full'};
  expect(agentOperatorConfiguration('--inspect',env).target).toEqual(review.target);
  for(const changed of [{PACKPROOF_DB_HOST:review.restored.host},{PACKPROOF_ENVIRONMENT:'production'},{PACKPROOF_ORGANIZATIONS_ENABLED:'true'},{PACKPROOF_DB_USER:review.apiRole},{PGHOST:review.target.host},{DATABASE_URL:'postgres://unexpected'},{PACKPROOF_DB_SSLMODE:'require'},{PACKPROOF_AGENT_CANDIDATE_IMAGE_DIGEST:'sha256:'+'0'.repeat(64)}])expect(()=>agentOperatorConfiguration('--inspect',{...env,...changed})).toThrow();
  expect(()=>agentOperatorConfiguration('--apply',env)).toThrow('AGENT_REHEARSAL_REQUIRED');
  expect(agentOperatorConfiguration('--rehearse',{...env,PACKPROOF_DB_HOST:review.restored.host}).target).toEqual(review.restored);
 });
});
describe('additive108 atomic preservation and narrow existing-role delta',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,directory:string,inventory:Awaited<ReturnType<typeof migrationInventory>>;
 beforeAll(async()=>{
  opened=await openIsolatedTestDatabase();inventory=await migrationInventory();directory=await mkdtemp(path.join(os.tmpdir(),'agent-migrate-'));
  for(const item of inventory.filter(row=>row.id!=='108_record_agents'))await writeFile(path.join(directory,item.id+'.sql'),item.sql);
  await migrate(opened.db,directory);
  const schema=(await opened.db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name;
  for(const role of [review.apiRole,review.workerRole]){await opened.db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);await opened.db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);}
  await opened.db.query(`GRANT SELECT ON rnd_sources TO ${review.apiRole}`);
  await opened.db.query("INSERT INTO users(id,created_at,updated_at) VALUES('agent_preserved_user',$1,$1)",[now.toISOString()]);
 },60000);
 afterAll(async()=>{if(opened){if(process.env.PACKPROOF_TEST_DATABASE_URL)for(const role of [review.apiRole,review.workerRole]){await opened.db.query(`DROP OWNED BY ${role}`);await opened.db.query(`DROP ROLE ${role}`);}await opened.close();}if(directory)await rm(directory,{recursive:true,force:true});});
 it('rejects partial schema and changed ledger',async()=>{
  await expect(opened.db.transaction(async tx=>{await tx.query('ALTER TABLE partner_import_jobs ADD COLUMN agent_config_revision INTEGER');await inspectAgentState(tx,inventory,review);})).rejects.toThrow('AGENT_PARTIAL_SCHEMA_PRESENT');
  await expect(opened.db.transaction(async tx=>{await tx.query("UPDATE schema_migrations SET checksum='changed' WHERE id='107_record_issue_assignments'");await inspectAgentState(tx,inventory,review);})).rejects.toThrow('AGENT_APPLIED_RECEIPTS_MISMATCH');
 });
 it('rolls back table, columns, trigger and receipt on failure and rejects changed preserved rows',async()=>{
  const before=await inspectAgentState(opened.db,inventory,review),receipt=agentInspection(before,review,now);
  await expect(opened.db.transaction(tx=>applyAgentInTransaction({...tx,query:async(sql:string,args?:unknown[])=>{const result=await tx.query(sql,args);if(sql.includes('CREATE TRIGGER partner_import_agent_revision_immutable'))throw Error('SYNTHETIC_AGENT_FAILURE');return result;}},inventory,receipt,review,{splitSqlStatements,now}))).rejects.toThrow('SYNTHETIC_AGENT_FAILURE');
  expect(await inspectAgentState(opened.db,inventory,review)).toEqual(before);
  await expect(opened.db.transaction(async tx=>{await tx.query("INSERT INTO users(id,created_at,updated_at) VALUES('agent_changed_user',$1,$1)",[now.toISOString()]);await applyAgentInTransaction(tx,inventory,receipt,review,{splitSqlStatements,now});})).rejects.toThrow('AGENT_INSPECTION_STATE_CHANGED');
 });
 it('applies only108, preserving historical row bytes, catalog, ACLs and both roles',async()=>{
  const before=await inspectAgentState(opened.db,inventory,review),receipt=agentInspection(before,review,now);
  const after=await opened.db.transaction(tx=>applyAgentInTransaction(tx,inventory,receipt,review,{splitSqlStatements,now}));
  expect(after).toMatchObject({pending:false,appliedCount:107,alreadyApplied:false});
  for(const key of ['baselineDataSha256','baselineCatalogSha256','baselineAuthoritySha256'])expect(after[key]).toBe(before[key]);
  const next=agentInspection(await inspectAgentState(opened.db,inventory,review),review,now);
  expect((await opened.db.transaction(tx=>applyAgentInTransaction(tx,inventory,next,review,{splitSqlStatements,now}))).alreadyApplied).toBe(true);
  await expect(opened.db.transaction(async tx=>{await tx.query('ALTER TABLE partner_import_jobs DISABLE TRIGGER partner_import_agent_revision_immutable');await inspectAgentState(tx,inventory,review);})).rejects.toThrow('AGENT_IMMUTABILITY_GUARD_MISMATCH');
 },60000);
 it('rejects dropped source uniqueness, weakened receipt checks and changed column shapes',async()=>{
  for(const sql of ['DROP INDEX record_agent_one_active_source','ALTER TABLE partner_import_jobs DROP CONSTRAINT partner_import_agent_revision','ALTER TABLE record_agent_enrollments ALTER COLUMN comparison_code DROP NOT NULL'])
   await expect(opened.db.transaction(async tx=>{await tx.query(sql);await inspectAgentState(tx,inventory,review);})).rejects.toThrow('AGENT_SCHEMA_CATALOG_MISMATCH');
 });
 it('plans only new table grants and two API INSERT columns, preserving old grants and worker denial',async()=>{
  if((await opened.db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name!=='public')return;
  const plan=await planAgentRuntimePrivilegeDelta(opened.db,review);
  expect(plan.statements.every((sql:string)=>/^(GRANT|REVOKE) /.test(sql)&&!sql.includes('CREATE ROLE')&&!sql.includes('GRANT ALL'))).toBe(true);
  expect(plan.statements.filter((sql:string)=>sql.includes('partner_import_jobs'))).toEqual([`GRANT INSERT("agent_installation_id","agent_config_revision") ON TABLE "public"."partner_import_jobs" TO "${review.apiRole}"`]);
  for(const sql of plan.statements)await opened.db.query(sql);
  expect((await opened.db.query("SELECT has_table_privilege($1,'rnd_sources','SELECT') AS preserved,has_table_privilege($2,'record_agent_installations','SELECT') AS worker_read,has_table_privilege($2,'record_agent_enrollments','SELECT') AS worker_enroll,has_column_privilege($2,'record_agent_installations','approved_config','UPDATE') AS worker_approve,has_column_privilege($1,'partner_import_jobs','agent_installation_id','INSERT') AS api_binding,has_column_privilege($2,'partner_import_jobs','agent_installation_id','UPDATE') AS worker_binding",[review.apiRole,review.workerRole])).rows[0]).toEqual({preserved:true,worker_read:true,worker_enroll:false,worker_approve:false,api_binding:true,worker_binding:false});
 });
});
