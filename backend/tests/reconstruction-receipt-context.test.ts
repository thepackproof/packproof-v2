import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import type {Database} from '../src/db/database.js';
import {insertUser} from '../src/domain/users.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {proposeSourceSubscription,actOnSourceSubscription} from '../src/records/source-subscriptions.js';
import {previewTypedImport,commitTypedImport,readTypedImport,processPendingTypedImports,type TypedImportDeps} from '../src/records/typed-imports.js';
import {getOperationalCase} from '../src/records/reconstruction.js';
import {exportOperationalCase,exportSignedOperationalCase} from '../src/records/reconstruction-exports.js';
import {createReconstructionSigningRuntime,RECONSTRUCTION_SIGNED_PROFILE_SHA256,type ReconstructionSigningRuntime} from '../src/records/reconstruction-signing.js';
import {reconcileProjectionSourceCounter} from '../src/records/projection-store.js';
import type {TypedSourceObservation} from '../src/records/source-contracts.js';
import {canonicalize} from '../src/canonical.js';
import {sha256Hex} from '../src/hash.js';

describe('authorized accepted-prefix receipt context and frozen packages',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,dir:string,deps:TypedImportDeps,actor:PartnerActor,signing:ReconstructionSigningRuntime;
 let owner:string,org:string,member:string,account:string,subscription:string,sequence=0;
 let currentTime=Date.parse('2026-11-14T12:00:00Z');const clock={now:()=>new Date(currentTime)},site='receipt-context-site',namespace='receipt-context-source';
 const workspace=()=>requireRecordWorkspace(opened.db,owner,org,'sandbox');
 const incomplete=(value:{limitations:string[]})=>value.limitations.filter(text=>text.includes('Visible case rows do not establish receipt completion'));
 beforeAll(async()=>{
  for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_RECONSTRUCTION_EXPORTS_ENABLED','PACKPROOF_PAGED_PROJECTIONS_ENABLED','PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED','PACKPROOF_SOURCE_HEALTH_ENABLED'])vi.stubEnv(flag,'true');
  for(const flag of ['PACKPROOF_RECONSTRUCTION_RULES_ENABLED','PACKPROOF_CROSS_CASE_ENABLED'])vi.stubEnv(flag,'false');
  vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);dir=await mkdtemp(path.join(os.tmpdir(),'receipt-context-'));
  deps={db:opened.db,clock,objectStore:new LocalObjectStore(path.join(dir,'objects'),'http://localhost','receipt-context-test'),devAuth:true};
  const admin=await insertUser(opened.db,clock);owner=await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Synthetic receipt context warehouse',ownerUserId:owner},'receipt-context')).id;await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'receipt-context');
  member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Receipt context source'},'receipt-context'),credential=await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-30T12:00:00Z'},'receipt-context');actor=await authenticatePartner(opened.db,clock,`Bearer ${credential.token}`,org,undefined,'receipt-context');
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'synthetic-receipt-context',externalAccountId:'fixture-only'},'receipt-context')).id;
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[site,org,'Synthetic receipt site',clock.now().toISOString()]);
  const w=await workspace(),source=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:actor.principalId,operatorMembershipId:member,locationId:site,installationId:null,config:{transport:'partner_api',displayName:'Synthetic source',sourceProfile:'packproof.order-lines/v1',mappingVersion:'receipt-context/1',sourceNamespace:namespace,mapping:{},constants:{},wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:null,expectedHeaders:[],historyFrom:'2026-11-01T00:00:00Z',historyTo:null,maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:3600,completenessPolicy:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false,qualificationReference:null}}},'receipt-context-source'));
  subscription=source.id;await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,subscription,{action:'approve',configurationRevision:1,configurationSha256:source.configurationSha256,wholeFileConsent:true},'receipt-context-approve'));
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),keyId='synthetic-receipt-key',trustList={schema:'packproof.trust-list.v1' as const,generatedAt:'2026-11-13T00:00:00Z',expiresAt:'2026-11-30T00:00:00Z',keys:[{keyId,algorithm:'ECDSA_SHA_256' as const,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString(),status:'ACTIVE' as const}]};
  signing=createReconstructionSigningRuntime({clock,activeSourceSha:'a'.repeat(40),testFixtures:true,binding:{schema:'packproof.reconstruction-signing-binding/v1',sourceSha:'a'.repeat(40),profileSha256:RECONSTRUCTION_SIGNED_PROFILE_SHA256,organizationIds:[org],environment:'sandbox',qualificationReference:'Synthetic receipt-context fixture only',reviewedAt:'2026-11-13T00:00:00Z',expiresAt:'2026-11-30T00:00:00Z',keyId,mode:'synthetic_test'},manifestSigning:{trustList,publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId,required:true,trustListSha256:sha256Hex(canonicalize(trustList))},signer:{signManifest:async value=>({algorithm:'ECDSA_SHA_256',keyId,signedAt:clock.now().toISOString(),signatureBase64:sign('sha256',Buffer.from(value.canonicalJson),pair.privateKey).toString('base64')})}}});
 },60000);
 afterAll(async()=>{await opened?.close();if(dir)await rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();});
 async function queue(orderId:string,count:number){
  currentTime+=1000;const key=`receipt-context-${++sequence}`,order={namespace,type:'order' as const,externalId:orderId},line={namespace,type:'order_line' as const,externalId:'004',parentExternalId:orderId};
  const rows:TypedSourceObservation[]=Array.from({length:count},(_,i)=>({sourceEventId:`${key}-${i}`,sourceRevision:'1',observationKind:'snapshot',occurredAt:null,sourceAsOf:'2026-11-12T12:00:00Z',timeQuality:'snapshot_time_only',references:[order,line],assertions:[{subjectReference:line,property:'orderedQuantity',value:{amount:'10',unit:'each'},sourceLocator:{row:i+1,field:'quantity'},assurance:'source_reported'}],relationships:[{from:order,to:line,type:'has_line',quantity:null}],supersedes:null,originSystem:'Synthetic fixture',copiedFromSource:null}));
  const content=JSON.stringify(rows),grant=Number((await opened.db.query<{grant_revision:number}>('SELECT grant_revision FROM record_source_subscriptions WHERE id=$1',[subscription])).rows[0].grant_revision),preview=await previewTypedImport(deps,actor,{schema:'packproof.typed-source-batch/v1',connectionId:account,locationId:site,subscriptionId:subscription,configurationRevision:1,grantRevision:grant,sourceProfile:'packproof.order-lines/v1',mappingVersion:'receipt-context/1',sourceNamespace:namespace,wholeFileConsent:true,original:{name:`${key}.json`,mediaType:'application/json',content,sha256:sha256Hex(content)},mapping:{},constants:{},completeness:{kind:'unknown'}},`preview-${key}`);
  await commitTypedImport(deps,actor,preview.value.id,{previewVersion:preview.value.previewVersion,originalSha256:preview.value.original.sha256,importValidRows:false},`commit-${key}`);return preview.value.id;
 }
 it('marks only the visible case prefix and freezes incomplete context without rewriting earlier unsigned or signed packages',async()=>{
  const seed=await queue('VISIBLE-A',1),seeded=await processPendingTypedImports(deps,1);
  expect(seeded,JSON.stringify((await opened.db.query('SELECT state,error_code FROM record_typed_batches WHERE id=$1',[seed])).rows[0])).toMatchObject({blocked:0});const a=(await readTypedImport(deps,actor,seed)).caseIds[0],w=await workspace();
  await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,subscription,{action:'activate',configurationRevision:1,recurringConsent:true,initialBatchId:seed},'receipt-context-activate'));
  const otherSeed=await queue('UNRELATED-B',1);await processPendingTypedImports(deps,1);const b=(await readTypedImport(deps,actor,otherSeed)).caseIds[0];await reconcileProjectionSourceCounter(opened.db,clock,subscription);
  const unrelated=await queue('UNRELATED-B',6);
  for(const paged of ['true','false']){vi.stubEnv('PACKPROOF_PAGED_PROJECTIONS_ENABLED',paged);expect(incomplete(await getOperationalCase(opened.db,clock,w,a))).toEqual([]);}
  vi.stubEnv('PACKPROOF_SOURCE_HEALTH_ENABLED','false');const before=await exportOperationalCase({...deps,reconstructionSigning:signing},w,a);expect(incomplete(JSON.parse(before.bytes.toString()))).toEqual([]);expect(before.bytes.toString()).not.toContain(unrelated);
  expect((await processPendingTypedImports(deps,1)).blocked).toBe(0);
  const receipt=await queue('VISIBLE-A',6);let signal!:()=>void,release!:()=>void,paused=false;
  const reached=new Promise<void>(resolve=>{signal=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  const observed:Database={query:(sql,params)=>opened.db.query(sql,params),transaction:async fn=>{
   const result=await opened.db.transaction(fn);
   if(!paused){const state=(await opened.db.query<{state:string;accepted:number;processing:number}>(`SELECT b.state,COUNT(*) FILTER(WHERE r.status='accepted_linked')::integer accepted,COUNT(*) FILTER(WHERE r.status='processing')::integer processing FROM record_typed_batches b JOIN record_typed_rows r ON r.batch_id=b.id WHERE b.id=$1 GROUP BY b.state`,[receipt])).rows[0];if(state.state==='running'&&state.accepted>0&&state.processing>0){paused=true;signal();await resume;}}
   return result;
  }};
  const worker=processPendingTypedImports({...deps,db:observed},1);let unsigned!:Awaited<ReturnType<typeof exportOperationalCase>>,signed!:Awaited<ReturnType<typeof exportSignedOperationalCase>>;
  try{
   await Promise.race([reached,worker.then(()=>{throw new Error('Worker finished without a visible committed prefix');})]);
   for(const health of ['true','false'])for(const paged of ['true','false']){
    vi.stubEnv('PACKPROOF_SOURCE_HEALTH_ENABLED',health);vi.stubEnv('PACKPROOF_PAGED_PROJECTIONS_ENABLED',paged);
    const visible=await getOperationalCase(opened.db,clock,w,a);expect(incomplete(visible)).toHaveLength(1);expect(visible.assertions.some(value=>value.source.receiptId===receipt)).toBe(true);
    if(health==='true'){expect(visible.sources[0].accounting.processing).toBeGreaterThan(0);expect(visible.sources[0].caseAccounting?.processing).toBe(0);}
    expect(incomplete(await getOperationalCase(opened.db,clock,w,b))).toEqual([]);
   }
   vi.stubEnv('PACKPROOF_SOURCE_HEALTH_ENABLED','false');
   const rollback=new Error('rollback indirect successor fixture');
   await expect(opened.db.transaction(async tx=>{
    // Retained association repair can leave no direct new receipt row in A,
    // while its accepted successor still makes A's old source row inactive.
    const original=(await tx.query<{id:string}>('SELECT id FROM record_typed_rows WHERE batch_id=$1',[seed])).rows[0].id;
    await tx.query("UPDATE record_typed_rows SET case_id=$2,supersedes_id=CASE WHEN row_number=1 THEN $3 ELSE NULL END WHERE batch_id=$1 AND status='accepted_linked'",[receipt,b,original]);
    for(const paged of ['true','false']){vi.stubEnv('PACKPROOF_PAGED_PROJECTIONS_ENABLED',paged);const indirect=await getOperationalCase(tx,clock,w,a);expect(incomplete(indirect)).toHaveLength(1);expect(indirect.assertions.every(value=>value.source.receiptId===seed)).toBe(true);expect(indirect.assertions.every(value=>value.active===false)).toBe(true);}
    expect(incomplete(JSON.parse((await exportOperationalCase({...deps,db:tx,reconstructionSigning:signing},w,a)).bytes.toString()))).toHaveLength(1);throw rollback;
   })).rejects.toBe(rollback);
   unsigned=await exportOperationalCase({...deps,reconstructionSigning:signing},w,a);signed=await exportSignedOperationalCase({...deps,reconstructionSigning:signing},w,a);
   const frozen=JSON.parse(unsigned.bytes.toString()),signedPackage=JSON.parse(signed.bytes.toString());expect(frozen.schema).toBe('packproof.reconstruction-investigation/v1');expect(incomplete(frozen)).toHaveLength(1);expect(incomplete(frozen.projection)).toHaveLength(1);expect(frozen.sourceHealthMeasuredAt).toBe(clock.now().toISOString());
   expect(signedPackage.profile).toBe('packproof.reconstruction-investigation/v2');expect(incomplete(signedPackage.content)).toHaveLength(1);expect(signedPackage.manifest.content.sha256).toBe(sha256Hex(canonicalize(signedPackage.content)));expect(unsigned.bytes.toString()).not.toContain(unrelated);expect(signed.bytes.toString()).not.toContain(unrelated);
   await expect(getOperationalCase(opened.db,clock,{...w,organizationId:'unrelated-organization'},a)).rejects.toMatchObject({httpStatus:404});
  }finally{release();expect((await worker).blocked).toBe(0);}
  expect((await readTypedImport(deps,actor,receipt)).state).toBe('succeeded');
  const complete=await getOperationalCase(opened.db,clock,w,a),fresh=await exportOperationalCase({...deps,reconstructionSigning:signing},w,a);expect(incomplete(complete)).toEqual([]);expect(incomplete(JSON.parse(fresh.bytes.toString()))).toEqual([]);expect(fresh.sha256).not.toBe(unsigned.sha256);
  const oldUnsigned=(await opened.db.query<{payload_canonical:string;payload_sha256:string}>('SELECT payload_canonical,payload_sha256 FROM record_reconstruction_exports WHERE id=$1',[unsigned.id])).rows[0],oldSigned=(await opened.db.query<{package_canonical:string;package_sha256:string}>('SELECT package_canonical,package_sha256 FROM record_reconstruction_signed_exports WHERE id=$1',[signed.id])).rows[0];
  expect(oldUnsigned.payload_canonical).toBe(unsigned.bytes.toString());expect(oldUnsigned.payload_sha256).toBe(unsigned.sha256);expect(oldSigned.package_canonical).toBe(signed.bytes.toString());expect(oldSigned.package_sha256).toBe(signed.sha256);expect(incomplete(JSON.parse(oldUnsigned.payload_canonical))).toHaveLength(1);expect(incomplete(JSON.parse(oldSigned.package_canonical).content)).toHaveLength(1);
  expect((await opened.db.query<{payload_canonical:string}>('SELECT payload_canonical FROM record_reconstruction_exports WHERE id=$1',[before.id])).rows[0].payload_canonical).toBe(before.bytes.toString());
  const pendingText='Shipment evidence links are still being prepared.',unavailableText='Some source data cannot be represented as a shipment evidence record. Source assertions remain available.',rollback=new Error('rollback optional shipment work fixture');
  await expect(opened.db.transaction(async tx=>{
   // Derived progress can change after primary receipt success without changing
   // source facts, case revision, or any previously frozen package bytes.
   await tx.query("UPDATE record_typed_shipment_work SET work_revision=work_revision+1,state=CASE WHEN case_id=$1 THEN 'complete' ELSE 'pending' END WHERE case_id=ANY($2::text[])",[a,[a,b]]);
   expect((await getOperationalCase(tx,clock,w,a)).limitations).not.toContain(pendingText);
   expect((await tx.query("UPDATE record_typed_shipment_work SET work_revision=work_revision+1,state='pending' WHERE batch_id=$1 AND case_id=$2",[seed,a])).rowCount).toBe(1);
   for(const paged of ['true','false']){vi.stubEnv('PACKPROOF_PAGED_PROJECTIONS_ENABLED',paged);const value=await getOperationalCase(tx,clock,w,a);expect(value.limitations).toContain(pendingText);expect(value.limitations).not.toContain(unavailableText);expect(incomplete(value)).toEqual([]);}
   const pendingExport=await exportOperationalCase({...deps,db:tx,reconstructionSigning:signing},w,a),pendingSigned=await exportSignedOperationalCase({...deps,db:tx,reconstructionSigning:signing},w,a);
   expect(JSON.parse(pendingExport.bytes.toString()).limitations).toContain(pendingText);expect(JSON.parse(pendingSigned.bytes.toString()).content.limitations).toContain(pendingText);
   await tx.query("UPDATE record_typed_shipment_work SET work_revision=work_revision+1,state='unavailable' WHERE batch_id=$1 AND case_id=$2",[seed,a]);
   const unavailable=await getOperationalCase(tx,clock,w,a);expect(unavailable.limitations).toContain(unavailableText);expect(unavailable.limitations).not.toContain(pendingText);expect(unavailable.assertions.length).toBeGreaterThan(0);
   const unavailableExport=await exportOperationalCase({...deps,db:tx,reconstructionSigning:signing},w,a);expect(unavailableExport.sha256).not.toBe(pendingExport.sha256);expect(JSON.parse(unavailableExport.bytes.toString()).limitations).toContain(unavailableText);
   expect((await tx.query<{payload_canonical:string}>('SELECT payload_canonical FROM record_reconstruction_exports WHERE id=$1',[pendingExport.id])).rows[0].payload_canonical).toBe(pendingExport.bytes.toString());expect((await tx.query<{package_canonical:string}>('SELECT package_canonical FROM record_reconstruction_signed_exports WHERE id=$1',[pendingSigned.id])).rows[0].package_canonical).toBe(pendingSigned.bytes.toString());
   const otherSite='receipt-context-current-other-site';await tx.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[otherSite,org,'Other current site',clock.now().toISOString()]);await tx.query('UPDATE record_cases SET location_id=$2,location_key=$2 WHERE id=$1',[a,otherSite]);
   const moved=await getOperationalCase(tx,clock,w,a);expect(moved.limitations).not.toContain(pendingText);expect(moved.limitations).not.toContain(unavailableText);throw rollback;
  })).rejects.toBe(rollback);
 },60000);
});
