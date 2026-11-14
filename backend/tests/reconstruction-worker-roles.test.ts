import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {proposeSourceSubscription,actOnSourceSubscription} from '../src/records/source-subscriptions.js';
import {previewTypedImport,commitTypedImport,readTypedImport,resumeTypedImport,processPendingTypedImports,type TypedImportDeps} from '../src/records/typed-imports.js';
import {recordsMigrationInventory,planRecordsRuntimePrivileges,verifyRecordsRuntimePrivileges,type RecordsPrivilegeOptions} from '../scripts/records-runtime-privileges.mjs';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {sha256Hex} from '../src/hash.js';
import type {TypedSourceObservation} from '../src/records/source-contracts.js';

describe('actual typed intake and unlinked replay under113 API and worker roles',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,ownerRole:string,dir:string,deps:TypedImportDeps,actor:PartnerActor,options:RecordsPrivilegeOptions,orderSource:string,loadingSource:string,account:string;
 const suffix=randomBytes(6).toString('hex'),api=`typed_api_${suffix}`,worker=`typed_worker_${suffix}`,org=`org_${suffix}`,site=`site_${suffix}`,member=`member_${suffix}`,source='b'.repeat(40),clock={now:()=>new Date('2026-11-14T12:00:00Z')};
 const reset=()=>opened.db.query(`SET SESSION AUTHORIZATION "${ownerRole.replace(/"/g,'""')}"`);
 async function asRole<T>(role:string,run:(db:typeof opened.db)=>Promise<T>){try{return await opened.db.transaction(async tx=>{await tx.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);return run(tx);});}finally{await reset();}}
 async function sourceConfig(owner:string,profile:string){
  const w=await requireRecordWorkspace(opened.db,owner,org,'sandbox',true);
  const proposed=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:actor.principalId,installationId:null,operatorMembershipId:member,locationId:site,config:{transport:'partner_api',displayName:'Synthetic role-qualified export',sourceProfile:profile,mappingVersion:'fixture/1',sourceNamespace:'role-qualified-site',mapping:{},constants:{},wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:null,expectedHeaders:[],historyFrom:'2026-11-01T00:00:00Z',historyTo:null,unknownTimePolicy:'quarantine',maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:null,completenessPolicy:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false,qualificationReference:null}}},`propose-${profile}`));
  await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,proposed.id,{action:'approve',configurationRevision:1,configurationSha256:proposed.configurationSha256,wholeFileConsent:true},`approve-${profile}`));return proposed.id;
 }
 beforeAll(async()=>{
  for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED'])vi.stubEnv(flag,'true');vi.stubEnv('PACKPROOF_RELEASE_SHA',source);
  opened=await openIsolatedTestDatabase();await migrate(opened.db);ownerRole=(await opened.db.query<{name:string}>('SELECT session_user AS name')).rows[0].name;
  const schema=(await opened.db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name,owner=await insertUser(opened.db,clock),at=clock.now().toISOString();
  await opened.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,'Worker role fixture','sandbox',$3)",['tenant_'+suffix,owner,at]);
  await opened.db.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,enabled,created_at) VALUES($1,'MERCHANT','Worker role fixture',$2,'sandbox',$3,true,$4)",[org,owner,'tenant_'+suffix,at]);
  await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'OWNER',$4)",[member,org,owner,at]);
  await opened.db.query("INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,'Synthetic site',$3)",[site,org,at]);
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Synthetic export service'},'principal');const token=await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-15T12:00:00Z'},'credential');actor=await authenticatePartner(opened.db,clock,`Bearer ${token.token}`,org,undefined,'role-flow');
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'synthetic-qualified-export',externalAccountId:'role-flow'},'account')).id;
  orderSource=await sourceConfig(owner,'packproof.order-lines/v1');loadingSource=await sourceConfig(owner,'packproof.operational-observations/v1');
  for(const role of [api,worker]){
   await opened.db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);await opened.db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
   // Discarded synthetic fixture only: ordinary platform reads and existing
   // reauthorization locks are separate from the new records policy below.
   await opened.db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);await opened.db.query(`GRANT SELECT(datname,datdba) ON pg_catalog.pg_database TO ${role}`);
   for(const table of ['users','platform_credentials','platform_principals','platform_organizations'])await opened.db.query(`GRANT UPDATE(id) ON ${table} TO ${role}`);
   await opened.db.query(`GRANT INSERT ON platform_action_audit TO ${role}`);
  }
  await opened.db.query(`GRANT INSERT ON api_idempotency TO ${api}`);await opened.db.query(`GRANT UPDATE(response) ON api_idempotency TO ${api}`);
  const inventory=await recordsMigrationInventory(113);options={runtimeRole:api,workerRole:worker,schema,reviewedSourceCommit:source,reviewedMigrationSha256:inventory.migrationSha256,throughMigration:113};
  const plan=await planRecordsRuntimePrivileges(opened.db,options);for(const sql of plan.statements)await opened.db.query(sql);
  dir=await mkdtemp(path.join(tmpdir(),'recon-role-flow-'));deps={db:opened.db,clock,objectStore:new LocalObjectStore(path.join(dir,'objects'),'http://localhost','synthetic-role-flow-secret'),devAuth:true};
 },60000);
 afterAll(async()=>{vi.unstubAllEnvs();if(!opened)return;if(process.env.PACKPROOF_TEST_DATABASE_URL)for(const role of [api,worker]){await opened.db.query(`DROP OWNED BY ${role}`);await opened.db.query(`DROP ROLE ${role}`);}await opened.close();if(dir)await rm(dir,{recursive:true,force:true});});
 const ref=(type:'order'|'order_line',externalId:string)=>({namespace:'role-qualified-site',type,externalId,...(type==='order_line'?{parentExternalId:'0010482'}:{})});
 function observation(id:string,property:'orderedQuantity'|'reportedLoadedQuantity'):TypedSourceObservation {const order=ref('order','0010482'),line=ref('order_line','004');return {sourceEventId:id,sourceRevision:'1',observationKind:'snapshot',occurredAt:null,sourceAsOf:'2026-11-12T19:00:00Z',timeQuality:'snapshot_time_only',references:[order,line],assertions:[{subjectReference:line,property,value:{amount:property==='orderedQuantity'?'10':'8',unit:'each'},sourceLocator:{row:1,field:'ignored'},assurance:'source_reported'}],relationships:[{from:order,to:line,type:'has_line',quantity:null}],supersedes:null,originSystem:'synthetic source',copiedFromSource:null};}
 async function submit(sub:string,profile:string,observation:TypedSourceObservation,key:string){const content=JSON.stringify([observation]);return asRole(api,async db=>{const p=await previewTypedImport({...deps,db},actor,{schema:'packproof.typed-source-batch/v1',connectionId:account,locationId:site,sourceProfile:profile,mappingVersion:'fixture/1',sourceNamespace:'role-qualified-site',subscriptionId:sub,configurationRevision:1,grantRevision:2,wholeFileConsent:true,original:{name:key+'.json',mediaType:'application/json',content,sha256:sha256Hex(content)},mapping:{},constants:{},completeness:{kind:'unknown'}},'preview-'+key);await commitTypedImport({...deps,db},actor,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:false},'commit-'+key);return p.value.id;});}
 it('executes source acceptance, unlinked fairness, API reconciliation request and eventual worker case materialization',async()=>{
  for(const role of [api,worker])await asRole(role,db=>verifyRecordsRuntimePrivileges(db,options));
  const loading=await submit(loadingSource,'packproof.operational-observations/v1',observation('loaded-before-order','reportedLoadedQuantity'),'loading');
  expect(await asRole(worker,db=>processPendingTypedImports({...deps,db},10))).toMatchObject({processed:1,blocked:0});
  expect((await asRole(api,db=>readTypedImport({...deps,db},actor,loading))).counts.acceptedUnlinked).toBe(1);
  expect(Number((await opened.db.query<{resolution_attempts:number}>('SELECT resolution_attempts FROM record_typed_rows WHERE batch_id=$1',[loading])).rows[0].resolution_attempts)).toBeGreaterThan(0);
  await expect(asRole(api,db=>db.query('INSERT INTO record_case_assertions SELECT * FROM record_case_assertions WHERE false'))).rejects.toMatchObject({code:'42501'});
  await asRole(api,db=>resumeTypedImport({...deps,db},actor,loading,'request-reconcile'));
  expect((await opened.db.query('SELECT replay_requested,state FROM record_typed_batches WHERE id=$1',[loading])).rows[0]).toEqual({replay_requested:true,state:'queued'});
  const ordered=await submit(orderSource,'packproof.order-lines/v1',observation('order-after-loading','orderedQuantity'),'order');
  expect(await asRole(worker,db=>processPendingTypedImports({...deps,db},10))).toMatchObject({processed:2,blocked:0});
  const loadedReceipt=await asRole(api,db=>readTypedImport({...deps,db},actor,loading)),orderReceipt=await asRole(api,db=>readTypedImport({...deps,db},actor,ordered));
  expect(loadedReceipt.counts.acceptedLinked).toBe(1);expect(orderReceipt.counts.acceptedLinked).toBe(1);expect(loadedReceipt.caseIds).toEqual(orderReceipt.caseIds);
  expect((await opened.db.query('SELECT replay_requested FROM record_typed_batches WHERE id=$1',[loading])).rows[0]).toEqual({replay_requested:false});
  for(const role of [api,worker])await asRole(role,db=>verifyRecordsRuntimePrivileges(db,options));
 },30000);
});
