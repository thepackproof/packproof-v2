import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {importPartnerOrder} from '../src/platform/partner-proofs.js';
import {requireRecordWorkspace,type RecordWorkspace} from '../src/records/access.js';
import {proposeSourceSubscription,actOnSourceSubscription} from '../src/records/source-subscriptions.js';
import {previewTypedImport,commitTypedImport,readTypedImport,resumeTypedImport,processPendingTypedImports,type TypedImportDeps} from '../src/records/typed-imports.js';
import {recordsMigrationInventory,planRecordsRuntimePrivileges,verifyRecordsRuntimePrivileges,type RecordsPrivilegeOptions} from '../scripts/records-runtime-privileges.mjs';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {sha256Hex} from '../src/hash.js';
import type {TypedSourceObservation,TypedSourceReference} from '../src/records/source-contracts.js';
import {synchronizeOperationalCaseProjection} from '../src/records/projection-worker.js';
import {getPagedOperationalCase} from '../src/records/reconstruction-pages.js';
import {actOnSourceRetention,readSourceRetentionReview} from '../src/records/source-retention.js';
import {requestSourceDisposition,approveSourceDisposition,processSourceDispositions,readSourceDisposition,readCollectorCompactionCommands,authorizeCollectorCompactionPermit,ackCollectorCompactionCommand,createQualifiedSourceDispositionStore} from '../src/records/source-retention-disposition.js';

describe('actual typed intake and unlinked replay under116 API and worker roles',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,ownerRole:string,dir:string,deps:TypedImportDeps,actor:PartnerActor,options:RecordsPrivilegeOptions,orderSource:string,loadingSource:string,account:string,w:RecordWorkspace,secondAdmin:RecordWorkspace;
 const suffix=randomBytes(6).toString('hex'),api=`typed_api_${suffix}`,worker=`typed_worker_${suffix}`,org=`org_${suffix}`,site=`site_${suffix}`,member=`member_${suffix}`,source='b'.repeat(40),clock={now:()=>new Date('2026-11-14T12:00:00Z')};
 const reset=()=>opened.db.query(`SET SESSION AUTHORIZATION "${ownerRole.replace(/"/g,'""')}"`);
 async function asRole<T>(role:string,run:(db:typeof opened.db)=>Promise<T>){try{return await opened.db.transaction(async tx=>{await tx.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);return run(tx);});}finally{await reset();}}
 async function sourceConfig(owner:string,profile:string){
  const w=await requireRecordWorkspace(opened.db,owner,org,'sandbox',true);
  const proposed=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:actor.principalId,installationId:null,operatorMembershipId:member,locationId:site,config:{transport:'partner_api',displayName:'Synthetic role-qualified export',sourceProfile:profile,mappingVersion:'fixture/1',sourceNamespace:'role-qualified-site',mapping:{},constants:{},wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:null,expectedHeaders:[],historyFrom:'2026-11-01T00:00:00Z',historyTo:null,unknownTimePolicy:'quarantine',maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:null,completenessPolicy:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false,qualificationReference:null}}},`propose-${profile}`));
  await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,proposed.id,{action:'approve',configurationRevision:1,configurationSha256:proposed.configurationSha256,wholeFileConsent:true},`approve-${profile}`));return proposed.id;
 }
 beforeAll(async()=>{
  for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_SOURCE_IDENTITY_V2_ENABLED','PACKPROOF_CROSS_CASE_ENABLED','PACKPROOF_PAGED_PROJECTIONS_ENABLED','PACKPROOF_SOURCE_HEALTH_ENABLED','PACKPROOF_RECONSTRUCTION_RULES_ENABLED','PACKPROOF_SOURCE_DISPOSITION_ENABLED','PACKPROOF_MULTI_SOURCE_AGENT_ENABLED'])vi.stubEnv(flag,'true');vi.stubEnv('PACKPROOF_RELEASE_SHA',source);vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);ownerRole=(await opened.db.query<{name:string}>('SELECT session_user AS name')).rows[0].name;
  const schema=(await opened.db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name,owner=await insertUser(opened.db,clock),at=clock.now().toISOString();
  await opened.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,'Worker role fixture','sandbox',$3)",['tenant_'+suffix,owner,at]);
  await opened.db.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,enabled,created_at) VALUES($1,'MERCHANT','Worker role fixture',$2,'sandbox',$3,true,$4)",[org,owner,'tenant_'+suffix,at]);
  await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'OWNER',$4)",[member,org,owner,at]);
  await opened.db.query("INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,'Synthetic site',$3)",[site,org,at]);
  w=await requireRecordWorkspace(opened.db,owner,org,'sandbox');const second=await insertUser(opened.db,clock);await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'ADMIN',$4)",['second_'+suffix,org,second,at]);secondAdmin=await requireRecordWorkspace(opened.db,second,org,'sandbox');
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Synthetic export service'},'principal');const token=await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-15T12:00:00Z'},'credential');actor=await authenticatePartner(opened.db,clock,`Bearer ${token.token}`,org,undefined,'role-flow');
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'synthetic-qualified-export',externalAccountId:'role-flow'},'account')).id;
  orderSource=await sourceConfig(owner,'packproof.order-lines/v1');loadingSource=await sourceConfig(owner,'packproof.operational-observations/v1');
  for(const role of [api,worker]){
   await opened.db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);await opened.db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
   // Discarded synthetic fixture only: ordinary platform reads and existing
   // reauthorization locks are separate from the new records policy below.
   await opened.db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);await opened.db.query(`GRANT SELECT(datname,datdba) ON pg_catalog.pg_database TO ${role}`);
   for(const table of ['users','platform_credentials','platform_principals','platform_organizations','platform_memberships','proofs'])await opened.db.query(`GRANT UPDATE(id) ON ${table} TO ${role}`);
   await opened.db.query(`GRANT INSERT ON platform_action_audit TO ${role}`);
  }
  await opened.db.query(`GRANT INSERT ON api_idempotency TO ${api}`);await opened.db.query(`GRANT UPDATE(response) ON api_idempotency TO ${api}`);
  const inventory=await recordsMigrationInventory(116);options={runtimeRole:api,workerRole:worker,schema,reviewedSourceCommit:source,reviewedMigrationSha256:inventory.migrationSha256,throughMigration:116};
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
 it('rejects missing effective platform lock columns before116 runtime admission',async()=>{
  const {inspectReconstructionPlatformLocks}=await import(new URL('../../infra/backend-release/reconstruction-v2-release-review.mjs',import.meta.url).href);
  const inspect=async()=>inspectReconstructionPlatformLocks((await asRole(worker,db=>db.query(`SELECT role,table_name AS table,has_column_privilege(role,format('%I.%I',current_schema(),table_name),'id','UPDATE') AS allowed,has_column_privilege(role,format('%I.%I',current_schema(),table_name),'id','UPDATE WITH GRANT OPTION') AS grantable FROM unnest($1::text[]) roles(role) CROSS JOIN (VALUES ('platform_memberships'),('proofs')) locks(table_name) ORDER BY role,table_name`,[[api,worker]]))).rows,{apiRole:api,workerRole:worker});
  expect((await inspect()).columns).toEqual(['platform_memberships.id','proofs.id']);
  await opened.db.query(`REVOKE UPDATE(id) ON platform_memberships FROM ${api}`);
  try{await expect(inspect()).rejects.toThrow('RECONSTRUCTION_PLATFORM_LOCK_PRIVILEGES_REQUIRED');}finally{await opened.db.query(`GRANT UPDATE(id) ON platform_memberships TO ${api}`);}
  await inspect();
 });
 it('materializes explicit cross-case partitions and bounded projections under the116 worker role',async()=>{
  const references=(id:string):[TypedSourceReference,TypedSourceReference]=>[{namespace:'role-qualified-site',type:'order',externalId:id},{namespace:'role-qualified-site',type:'order_line',externalId:'004',parentExternalId:id}];
  const roots=['PHASE2-A','PHASE2-B'].map((id,index)=>{const [o,l]=references(id);return {...observation(`phase2-order-${index}`,'orderedQuantity'),references:[o,l],assertions:[{...observation('unused','orderedQuantity').assertions[0],subjectReference:l}],relationships:[{from:o,to:l,type:'has_line' as const,quantity:null}]};});
  for(let i=0;i<roots.length;i++)await submit(orderSource,'packproof.order-lines/v1',roots[i],`phase2-order-${i}`);
  expect(await asRole(worker,db=>processPendingTypedImports({...deps,db},10))).toMatchObject({processed:2,blocked:0});
  const identityPolicy={schema:'packproof.source-identity-policy/v1',eventKey:{kind:'column'},revision:{kind:'column'}};
  const crossCasePolicy={schema:'packproof.cross-case-source-policy/v1',version:'role-fixture/1',allowMultiOrderRows:true,partitionRule:'explicit_order_line_allocations',sharedEntityTypes:['handling_unit','load'],sourceOwnerQualified:true,qualificationReference:'Synthetic actual-role fixture'};
  const p=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:actor.principalId,operatorMembershipId:member,locationId:site,config:{batchSchema:'packproof.typed-source-batch/v2',identityPolicy,crossCasePolicy,transport:'partner_api',displayName:'Actual-role shared source',sourceProfile:'packproof.operational-observations/v2',mappingVersion:'phase2/1',sourceNamespace:'role-qualified-site',mapping:{},constants:{},wholeFileConsent:true,historyFrom:'2026-11-01T00:00:00Z',completenessPolicy:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false}}},'phase2-source'));
  const approved=await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,p.id,{action:'approve',configurationRevision:1,configurationSha256:p.configurationSha256,wholeFileConsent:true},'phase2-approve'));
  const [a,la]=references('PHASE2-A'),[b,lb]=references('PHASE2-B'),pallet:TypedSourceReference={namespace:'role-qualified-site',type:'handling_unit',externalId:'SHARED-PALLET'},load:TypedSourceReference={namespace:'role-qualified-site',type:'load',externalId:'SHARED-LOAD'},shipment:TypedSourceReference={namespace:'role-qualified-site',type:'shipment',externalId:'SHARED-SHIPMENT'};
  const shared:TypedSourceObservation={...observation('phase2-shared','reportedLoadedQuantity'),references:[a,b,la,lb,pallet,load,shipment],assertions:[{subjectReference:load,property:'status',value:'loaded',sourceLocator:{row:1,field:'load'},assurance:'source_reported'}],relationships:[{from:a,to:la,type:'has_line',quantity:null},{from:b,to:lb,type:'has_line',quantity:null},{from:shipment,to:la,type:'fulfills',quantity:null},{from:shipment,to:lb,type:'fulfills',quantity:null},{from:la,to:pallet,type:'allocated_to',quantity:{amount:'7',unit:'each'}},{from:lb,to:pallet,type:'allocated_to',quantity:{amount:'3',unit:'each'}},{from:pallet,to:load,type:'loaded_on',quantity:null}]};
  const content=JSON.stringify([shared]);const batch=await asRole(api,async db=>{const preview=await previewTypedImport({...deps,db},actor,{schema:'packproof.typed-source-batch/v2',identityPolicy,subscriptionId:p.id,configurationRevision:1,grantRevision:approved.grantRevision,connectionId:account,locationId:site,sourceNamespace:'role-qualified-site',sourceProfile:'packproof.operational-observations/v2',mappingVersion:'phase2/1',mapping:{},constants:{},wholeFileConsent:true,original:{name:'phase2.json',mediaType:'application/json',content,sha256:sha256Hex(content)},completeness:{kind:'unknown'}},'phase2-preview');await commitTypedImport({...deps,db},actor,preview.value.id,{previewVersion:preview.value.previewVersion,originalSha256:preview.value.original.sha256,importValidRows:false},'phase2-commit');return preview.value.id;});
  expect(await asRole(worker,db=>processPendingTypedImports({...deps,db},10))).toMatchObject({processed:1,blocked:0});
  const received=await asRole(api,db=>readTypedImport({...deps,db},actor,batch));expect(received.caseIds).toHaveLength(2);expect(received.counts.acceptedLinked).toBe(1);
  for(const caseId of received.caseIds){await asRole(worker,db=>synchronizeOperationalCaseProjection(db,clock,w,caseId));const page=await asRole(api,db=>getPagedOperationalCase(db,clock,w,caseId,{limit:1}));expect(page.projectionStatus.state).toBe('ready');expect(page.totals.caseLinks).toBeGreaterThan(0);}
  expect((await opened.db.query('SELECT * FROM record_case_row_projections WHERE observation_id IN (SELECT id FROM record_typed_rows WHERE batch_id=$1)',[batch])).rows).toHaveLength(2);
  expect((await opened.db.query('SELECT * FROM record_typed_source_identities_v2 WHERE subscription_id=$1',[p.id])).rows).toHaveLength(1);
  for(const role of [api,worker])await asRole(role,db=>verifyRecordsRuntimePrivileges(db,options));
 },30000);
 it('executes independently approved exact-version disposition under the116 worker role',async()=>{
  // A separately approved local source exercises receipt-bound compaction.
  const installation='role-installation-'+suffix,at=clock.now().toISOString();
  await opened.db.query(`INSERT INTO record_agent_installations(id,organization_id,environment,principal_id,credential_id,integration_account_id,operator_membership_id,location_id,source_name,device_name,version,status,config_revision,approval_user_id,enrollment_expires_at,enrollment_acknowledged_at,created_at,updated_at) VALUES($1,$2,'sandbox',$3,$4,$5,$6,$7,'Role fixture local','Synthetic PC','0.3.0','ready',1,$8,'2026-11-15T12:00:00Z',$9,$9,$9)`,[installation,org,actor.principalId,actor.credentialId,account,member,site,w.userId,at]);
  const content='Event,Revision,Order,Line,Amount,Unit,AsOf\nrole-disposition-local,1,DISPOSITION-ONLY,004,10,each,2026-11-12T19:00:00Z\n',mapping={sourceEventId:'Event',sourceRevision:'Revision',orderId:'Order',orderLineId:'Line',amount:'Amount',unit:'Unit',sourceAsOf:'AsOf'},constants={observationKind:'snapshot',property:'orderedQuantity',timeQuality:'snapshot_time_only'};
  const config={transport:'local_ntfs',displayName:'Role fixture local CSV',sourceProfile:'packproof.order-lines/v1',mappingVersion:'local-role/1',sourceNamespace:'local-role-fixture',mapping,constants,wholeFileConsent:true,folderDigest:'a'.repeat(64),initialFileName:'local-role.csv',initialOriginalSha256:sha256Hex(content),expectedHeaders:content.split('\n')[0].split(','),historyFrom:'2026-11-01T00:00:00Z',completenessPolicy:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false}};
  const proposed=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:actor.principalId,installationId:installation,operatorMembershipId:member,locationId:site,config},'local-role-propose'));
  const approved=await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,proposed.id,{action:'approve',configurationRevision:1,configurationSha256:proposed.configurationSha256,wholeFileConsent:true},'local-role-approve'));
  const batch=await asRole(api,async db=>{const p=await previewTypedImport({...deps,db},actor,{schema:'packproof.typed-source-batch/v1',connectionId:account,locationId:site,sourceProfile:config.sourceProfile,sourceNamespace:config.sourceNamespace,mappingVersion:config.mappingVersion,subscriptionId:proposed.id,configurationRevision:1,grantRevision:approved.grantRevision,mapping,constants,wholeFileConsent:true,original:{name:config.initialFileName,mediaType:'text/csv',content,sha256:sha256Hex(content)},completeness:{kind:'unknown'}},'local-role-preview');await commitTypedImport({...deps,db},actor,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:false},'local-role-commit');return p.value.id;});
  expect(await asRole(worker,db=>processPendingTypedImports({...deps,db},10))).toMatchObject({processed:1,blocked:0});
  // Pre-existing qualified Proof preservation remains an inherited gate. Its
  // immutable source relationship is created by the owner fixture, not worker.
  const proof=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'role-retained-proof',operatorMembershipId:member,transaction:{itemTitle:'Synthetic old shipment',quantity:10}})).proofId;
  await opened.db.query("INSERT INTO record_state(proof_id,organization_id,environment,reference,location_id,updated_at) VALUES($1,$2,'sandbox','ROLE-SHIPMENT',$3,$4)",[proof,org,site,at]);
  await opened.db.query("UPDATE proofs SET status='FINALIZED',finalized_at='2026-01-01T00:00:00Z' WHERE id=$1",[proof]);
  const proofPolicy={version:1,policyId:'synthetic-proof-retention',minimumProtectionDays:90,startEvent:'FINALIZED',channelWindowDays:90,noticeDays:0,afterHoldReleaseDays:0,approvalReference:'Synthetic fixture only'};
  await opened.db.query("INSERT INTO proof_retention_assignments(id,proof_id,operation_id,policy_id,policy_json,anchors_json,actor_user_id,created_at) VALUES($1,$2,$1,$3,$4::jsonb,'{}',$5,$6)",['proof-policy-'+suffix,proof,proofPolicy.policyId,JSON.stringify(proofPolicy),w.userId,at]);
  await opened.db.query("INSERT INTO proof_disposition_state(proof_id,state,notice_at,updated_at) VALUES($1,'OPEN','2026-01-02T00:00:00Z',$2)",[proof,at]);
  const row=(await opened.db.query<{id:string;case_id:string}>('SELECT id,case_id FROM record_typed_rows WHERE batch_id=$1',[batch])).rows[0];await opened.db.query("INSERT INTO record_case_members(case_id,proof_id,organization_id,environment,source_row_id,created_at) VALUES($1,$2,$3,'sandbox',$4,$5)",[row.case_id,proof,org,row.id,at]);
  const policy={schema:'packproof.source-retention-policy/v1',version:'role-retention/1',cloudOriginal:{retainUntil:'2026-11-13T00:00:00Z'},normalizedHistory:{retainUntil:'2026-11-13T00:00:00Z'},localSpool:{retainUntil:'2026-11-13T00:00:00Z',compactAfterAcknowledgement:true}};
  const before=await asRole(api,db=>readSourceRetentionReview({...deps,db},w,batch));await asRole(api,db=>actOnSourceRetention({...deps,db},w,batch,{action:'policy_assigned',reason:'Synthetic expiry',impactSha256:before.impactSha256,policy},'role-policy'));
  const review=await asRole(api,db=>readSourceRetentionReview({...deps,db},w,batch));const request=(await asRole(api,db=>requestSourceDisposition({...deps,db},w,batch,{impactSha256:review.impactSha256,reason:'Synthetic exact-version review'},'role-dispose-request'))).value;
  await asRole(api,db=>approveSourceDisposition({...deps,db},secondAdmin,request.id,{impactSha256:request.impactSha256,reason:'Synthetic independent review',approve:true},'role-dispose-approve'));
  const deleted=new Set<string>(),calls:unknown[]=[];
  const runtime=createQualifiedSourceDispositionStore({clock,activeSourceSha:source,testFixtures:true,binding:{schema:'packproof.source-disposition-binding/v1',sourceSha:source,organizationIds:[org],environment:'sandbox',bucket:'synthetic-role-bucket',permittedPrefix:`evidence/${org}/`,reviewedPolicyVersions:[policy.version],policyReviewReference:'Synthetic only',qualificationReference:'Synthetic actual-role fixture',reviewedAt:'2026-11-13T00:00:00Z',expiresAt:'2026-11-16T00:00:00Z',mode:'synthetic_test'},transport:{async headExact(t){if(deleted.has(t.key))return null;const value=await deps.objectStore.get(t.key,{versionId:t.versionId});return value?{versionId:t.versionId,sha256:sha256Hex(value.body),byteSize:value.body.length}:null;},async deleteExact(t){calls.push(t);deleted.add(t.key);}}});
  expect(await asRole(worker,db=>processSourceDispositions({...deps,db},runtime))).toMatchObject({processed:1});
  const status=await asRole(api,db=>readSourceDisposition({...deps,db,sourceDisposition:runtime},w,request.id));expect(status).toMatchObject({state:'succeeded',original:{disposition:'deleted_exact_version'},normalizedHistory:{disposition:'preserved_audit_history'},backupErasure:'not_claimed'});expect(calls).toHaveLength(1);expect(status.localSpool.state).toBe('pending');
  expect((await opened.db.query('SELECT * FROM record_source_compaction_commands WHERE request_id=$1',[request.id])).rows).toHaveLength(1);
  const commands=await asRole(api,db=>readCollectorCompactionCommands({...deps,db},actor));expect(commands.commands).toHaveLength(1);const command=commands.commands[0];
  const permit=(await asRole(api,db=>authorizeCollectorCompactionPermit({...deps,db},actor,command.id,{commandSha256:command.commandSha256,batchId:command.batchId,originalSha256:command.originalSha256},'actual-role-final-permit'))).value;
  await asRole(api,db=>ackCollectorCompactionCommand({...deps,db},actor,command.id,{permitId:permit.id,commandSha256:command.commandSha256,batchId:command.batchId,originalSha256:command.originalSha256,serverReceiptReconciled:true,localDisposition:'compacted',compactedAt:clock.now().toISOString()},'actual-role-compaction-ack'));
  expect((await asRole(api,db=>readSourceDisposition({...deps,db,sourceDisposition:runtime},w,request.id))).localSpool.state).toBe('acknowledged');

  expect((await opened.db.query('SELECT * FROM record_typed_rows WHERE batch_id=$1',[batch])).rows).toHaveLength(1);
  for(const role of [api,worker])await asRole(role,db=>verifyRecordsRuntimePrivileges(db,options));
 },30000);
});
