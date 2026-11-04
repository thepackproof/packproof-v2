import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from './in-process-http.js';
import { openIsolatedTestDatabase } from './isolated-test-database.js';
import { migrate } from '../src/db/migrate.js';
import { insertUser } from '../src/domain/users.js';
import { createOrganization, setOrganizationEntitlement, addOrganizationMember, revokeOrganizationMember, createServicePrincipal } from '../src/platform/organizations.js';
import { MemoryObjectStore } from './memory-object-store.js';
import { BearerUserAdapter } from '../src/auth/adapter.js';
import { previewRecordImport, commitRecordImport, processPendingRecordImports, readRecordImport } from '../src/records/imports.js';
import { parseShipmentCsv, csvCell, CSV_LIMITS } from '../src/records/csv.js';
import { createRecordImportsRouter } from '../src/records/imports-router.js';
import { DomainError } from '../src/domain/errors.js';
import type { AppDependencies } from '../src/app.js';
import { sha256Hex } from '../src/hash.js';

describe('bounded spreadsheet parsing',()=>{
 it('preserves leading zeros, quoted line breaks, formulas and source date interpretation',()=>{
  const csv='Shipment reference,Description,Quantity,Tracking number,Shipment date\r\n00001,"A ""quoted""\nitem",2,0000456,2026-11-04T01:30:00Z\r\n=SUM(A1),Formula is data,1,,2026-11-04\r\n';
  const parsed=parseShipmentCsv(csv,undefined,'America/New_York');
  expect(parsed.rows[0].normalized).toMatchObject({shipmentReference:'00001',trackingNumber:'0000456',quantity:2,itemTitle:'A "quoted"\nitem',shipmentDate:'2026-11-03'});
  expect(parsed.rows[1].normalized?.shipmentReference).toBe('=SUM(A1)');
  expect(csvCell('=SUM(A1)')).toBe('"\'=SUM(A1)"');expect(csvCell('  @evil')).toBe('"\'  @evil"');
 });
 it('requires explicit mapping when headers are ambiguous and flags local timestamps',()=>{
  expect(parseShipmentCsv('Order ID,Shipment ID\nA,B',undefined,'UTC').rows[0].status).toBe('ambiguous');
  expect(parseShipmentCsv('Reference,Shipment date\nA,11/04/2026',undefined,'UTC').rows[0].status).toBe('ambiguous');
  expect(parseShipmentCsv('Reference,Shipment date\nA,2026-11-01T01:30:00',undefined,'America/New_York').rows[0].status).toBe('ambiguous');
  expect(parseShipmentCsv('Order ID,Shipment ID\n0001,B',{shipmentReference:'Order ID'},'UTC').rows[0].normalized?.shipmentReference).toBe('0001');
 });
 it('classifies conflicting references and ordinary row mistakes before any import',()=>{
  const rows=parseShipmentCsv('Reference;Quantity\nA;1\nA;1\nB;2\nB;3\n;1\nC;1,5',undefined,'UTC').rows;
  expect(rows.map(row=>row.status)).toEqual(['valid','duplicate','ambiguous','ambiguous','invalid','invalid']);
 });
 it('enforces byte, row, date and encoding boundaries',()=>{
  expect(()=>parseShipmentCsv('Reference\nA',undefined,undefined)).toThrowError(/time zone/);
  expect(()=>parseShipmentCsv('Reference\nA',undefined,'Imaginary/City')).toThrowError(/IANA/);
  expect(()=>parseShipmentCsv('a'.repeat(CSV_LIMITS.bytes+1),undefined,'UTC')).toThrowError(/2 MiB/);
  expect(()=>parseShipmentCsv('Reference\n'+Array.from({length:1001},(_,i)=>String(i)).join('\n'),undefined,'UTC')).toThrowError(/1,000 rows/);
  expect(parseShipmentCsv('Reference,Shipment date\nA,2026-02-30',undefined,'UTC').rows[0].status).toBe('ambiguous');
 });
});

describe('durable human CSV import through canonical Proof services',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,store:MemoryObjectStore,deps:AppDependencies;
 let admin:string,owner:string,otherOwner:string,operator:string,member:string,org:string,otherOrg:string;
 const clock={now:()=>new Date()};
 const input=(csv:string,extra:Record<string,unknown>={})=>({organizationId:org,environment:'sandbox',csv,timeZone:'UTC',...extra});
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');
  opened=await openIsolatedTestDatabase();await migrate(opened.db);store=new MemoryObjectStore();
  [admin,owner,otherOwner,operator]=await Promise.all(Array.from({length:4},()=>insertUser(opened.db,clock)));
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'CSV warehouse',ownerUserId:owner},'setup')).id;
  otherOrg=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Another warehouse',ownerUserId:otherOwner},'setup')).id;
  for(const id of [org,otherOrg])await setOrganizationEntitlement(opened.db,clock,admin,id,{enabled:true},'setup');
  member=String((await addOrganizationMember(opened.db,clock,owner,org,{userId:operator,role:'OPERATOR'},'setup')).id);
  deps={db:opened.db,clock,objectStore:store,devAuth:true,testFixtures:true,auth:new BearerUserAdapter(opened.db)} as AppDependencies;
 },60000);
 afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});
 async function commit(id:string,version:string,partial=true,user=owner){await commitRecordImport(opened.db,clock,user,id,{previewVersion:version,importValidRows:partial});return processPendingRecordImports(deps);}
 it('preserves exact original bytes and creates one real human-attributed canonical record',async()=>{
  const csv='\uFEFFShipment reference,Description,Tracking number\r\n000123,Warehouse parcel,00000456\r\n';
  const preview=await previewRecordImport(deps,owner,input(csv));expect(preview.state).toBe('previewed');expect(preview.counts.valid).toBe(1);
  const receipt=(await opened.db.query<{original_object_key:string;original_sha256:string}>('SELECT original_object_key,original_sha256 FROM record_import_jobs WHERE id=$1',[preview.id])).rows[0];
  expect((await store.get(receipt.original_object_key))?.body).toEqual(Buffer.from(csv));expect(receipt.original_sha256).toBe(sha256Hex(csv));
  await commit(preview.id,preview.previewVersion);const done=await readRecordImport(opened.db,owner,preview.id);expect(done.state).toBe('succeeded');expect(done.counts.imported).toBe(1);
  const proofId=done.recordIds[0];
  const human=(await opened.db.query<{created_by:string;origin_user_id:string;origin_principal_id:string|null;user_id:string}>(`SELECT t.created_by,o.origin_user_id,o.origin_principal_id,p.user_id FROM proofs f JOIN transactions t ON t.id=f.transaction_id JOIN platform_proof_ownership o ON o.proof_id=f.id JOIN proof_participants p ON p.proof_id=f.id AND p.role='SELLER' WHERE f.id=$1`,[proofId])).rows[0];
  expect(human).toEqual({created_by:owner,origin_user_id:owner,origin_principal_id:null,user_id:owner});
  expect((await opened.db.query('SELECT 1 FROM attestations WHERE proof_id=$1',[proofId])).rows).toEqual([]);
  expect((await opened.db.query('SELECT reference FROM record_state WHERE proof_id=$1',[proofId])).rows).toEqual([{reference:'000123'}]);
 });
 it('requires explicit partial acceptance and keeps durable successes when corrected rows are uploaded',async()=>{
  const preview=await previewRecordImport(deps,owner,input('Reference,Quantity\nPARTIAL-1,1\n,2'));
  expect(preview.counts).toMatchObject({valid:1,invalid:1});
  await expect(commitRecordImport(opened.db,clock,owner,preview.id,{previewVersion:preview.previewVersion,importValidRows:false})).rejects.toMatchObject({code:'IMPORT_HAS_ROW_ERRORS'});
  await commit(preview.id,preview.previewVersion);const done=await readRecordImport(opened.db,owner,preview.id);expect(done.state).toBe('partially_succeeded');expect(done.counts.imported).toBe(1);expect(done.correctionsCsv).toContain('"","2"');
  const fixed=await previewRecordImport(deps,owner,input('Reference,Quantity\nPARTIAL-1,1\nPARTIAL-2,2'));expect(fixed.counts).toMatchObject({duplicate:1,valid:1});
  await commit(fixed.id,fixed.previewVersion);expect((await readRecordImport(opened.db,owner,fixed.id)).counts).toMatchObject({duplicate:1,imported:1});
 });
 it('deduplicates across new receipts and rejects changed source bytes with a reused identity',async()=>{
  const replay=await previewRecordImport(deps,owner,input('Reference,Description,Tracking number\n000123,Warehouse parcel,00000456'));
  expect(replay.counts.duplicate).toBe(1);await commit(replay.id,replay.previewVersion);expect((await readRecordImport(opened.db,owner,replay.id)).recordIds).toHaveLength(1);
  const conflict=await previewRecordImport(deps,owner,input('Reference,Description,Tracking number\n000123,Changed description,00000456'));expect(conflict.counts.ambiguous).toBe(1);
  await expect(commit(conflict.id,conflict.previewVersion)).rejects.toMatchObject({code:'IMPORT_NO_VALID_ROWS'});
 });
 it('binds commit to the exact preview and current tenant authorization',async()=>{
  const preview=await previewRecordImport(deps,owner,input('Reference\nSCOPED-1'));
  await expect(readRecordImport(opened.db,otherOwner,preview.id)).rejects.toMatchObject({code:'ORGANIZATION_NOT_FOUND'});
  await expect(previewRecordImport(deps,otherOwner,input('Reference\nX'))).rejects.toMatchObject({code:'ORGANIZATION_NOT_FOUND'});
  await expect(commitRecordImport(opened.db,clock,owner,preview.id,{previewVersion:'stale',importValidRows:true})).rejects.toMatchObject({code:'IMPORT_PREVIEW_CHANGED'});
 });
 it('preserves human-only import authority, activation and exact storage version gates',async()=>{
  const reviewer=await insertUser(opened.db,clock);await addOrganizationMember(opened.db,clock,owner,org,{userId:reviewer,role:'REVIEWER'},'setup');
  await expect(previewRecordImport(deps,reviewer,input('Reference\nREVIEWER-1'))).rejects.toMatchObject({code:'RECORD_PERMISSION_DENIED'});
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Synthetic service'},'setup');
  const actor=(await opened.db.query<{actor_user_id:string}>('SELECT actor_user_id FROM platform_principals WHERE id=$1',[principal.id])).rows[0].actor_user_id;
  await expect(previewRecordImport(deps,actor,input('Reference\nSERVICE-1'))).rejects.toMatchObject({code:'HUMAN_AUTHENTICATION_REQUIRED'});
  await expect(previewRecordImport({...deps,devAuth:false},owner,input('Reference\nNO-VERSION-1'))).rejects.toMatchObject({code:'IMPORT_STORAGE_VERSION_UNAVAILABLE'});
  await setOrganizationEntitlement(opened.db,clock,admin,otherOrg,{enabled:false},'pause');
  await expect(previewRecordImport(deps,otherOwner,input('Reference\nPENDING-1',{organizationId:otherOrg}))).rejects.toMatchObject({code:'WORKSPACE_PENDING'});
  await setOrganizationEntitlement(opened.db,clock,admin,otherOrg,{enabled:true},'resume');
 });
 it('blocks unauthorized location rows before committing and rechecks location revocation',async()=>{
  const scoped=await insertUser(opened.db,clock),membership='member-location-import-test';
  await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,location_scoped,created_at) VALUES($1,$2,$3,'OPERATOR',true,$4)",[membership,org,scoped,clock.now().toISOString()]);
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',['loc-import',org,'North',clock.now().toISOString()]);
  await opened.db.query('INSERT INTO record_membership_locations(membership_id,organization_id,location_id) VALUES($1,$2,$3)',[membership,org,'loc-import']);
  const invalid=await previewRecordImport(deps,scoped,input('Reference,Location\nLOCATION-MISSING,\nLOCATION-OTHER,loc-other'));expect(invalid.counts.invalid).toBe(2);
  const preview=await previewRecordImport(deps,scoped,input('Reference,Location\nLOCATION-1,loc-import'));await commitRecordImport(opened.db,clock,scoped,preview.id,{previewVersion:preview.previewVersion,importValidRows:true});
  await opened.db.query('DELETE FROM record_membership_locations WHERE membership_id=$1',[membership]);await processPendingRecordImports(deps);
  expect((await readRecordImport(opened.db,owner,preview.id)).recordIds).toEqual([]);
 });
 it('retains one accepted outcome when commit and processing are repeated',async()=>{
  const preview=await previewRecordImport(deps,owner,input('Reference\nRETRY-1'));await commit(preview.id,preview.previewVersion);
  const first=await readRecordImport(opened.db,owner,preview.id);await commit(preview.id,preview.previewVersion);const second=await readRecordImport(opened.db,owner,preview.id);
  expect(second.recordIds).toEqual(first.recordIds);expect(second.counts.imported).toBe(1);expect(await processPendingRecordImports(deps)).toEqual({processed:0,failed:0});
 });
 it('recovers an expired lease without duplicating already committed row results',async()=>{
  const preview=await previewRecordImport(deps,owner,input('Reference\nCRASH-1'));await commitRecordImport(opened.db,clock,owner,preview.id,{previewVersion:preview.previewVersion,importValidRows:true});
  await opened.db.query("UPDATE record_import_jobs SET state='running',lease_token='dead-worker',lease_expires_at=$2 WHERE id=$1",[preview.id,new Date(Date.now()-1000).toISOString()]);
  await processPendingRecordImports(deps);expect((await readRecordImport(opened.db,owner,preview.id)).counts.imported).toBe(1);
 });
 it('cannot create records after a slow original digest outlives the worker lease',async()=>{
  const preview=await previewRecordImport(deps,owner,input('Reference\nSLOW-DIGEST-LEASE'));
  await commitRecordImport(opened.db,clock,owner,preview.id,{previewVersion:preview.previewVersion,importValidRows:true});
  let simulated=Date.now();const leasedDeps={...deps,clock:{now:()=>new Date(simulated)}};
  const digest=store.digest.bind(store),slow=vi.spyOn(store,'digest').mockImplementationOnce(async(...args)=>{simulated+=120001;return digest(...args);});
  try{
   expect(await processPendingRecordImports(leasedDeps,1)).toEqual({processed:0,failed:0});
   const pending=await readRecordImport(opened.db,owner,preview.id);
   expect(pending.state).toBe('running');expect(pending.recordIds).toEqual([]);expect(pending.rows[0].status).toBe('valid');
   expect((await opened.db.query('SELECT 1 FROM record_state WHERE reference=$1',['SLOW-DIGEST-LEASE'])).rows).toHaveLength(0);
  }finally{slow.mockRestore();}
  expect(await processPendingRecordImports(leasedDeps,1)).toEqual({processed:1,failed:0});
  const done=await readRecordImport(opened.db,owner,preview.id);
  expect(done.state).toBe('succeeded');expect(done.counts.imported).toBe(1);expect(done.recordIds).toHaveLength(1);
 });
 it('fails closed on changed original bytes while preserving the receipt',async()=>{
  const preview=await previewRecordImport(deps,owner,input('Reference\nTAMPER-1'));await commitRecordImport(opened.db,clock,owner,preview.id,{previewVersion:preview.previewVersion,importValidRows:true});
  const key=(await opened.db.query<{original_object_key:string}>('SELECT original_object_key FROM record_import_jobs WHERE id=$1',[preview.id])).rows[0].original_object_key;
  await store.put(key,Buffer.from('changed'),'text/csv');await processPendingRecordImports(deps);const failed=await readRecordImport(opened.db,owner,preview.id);
  expect(failed.state).toBe('action_needed');expect(failed.lastErrorCode).toBe('IMPORT_ORIGINAL_INTEGRITY_FAILED');expect(failed.recordIds).toEqual([]);
 });
 it('does not process revoked membership or reveal another operator import receipt',async()=>{
  const owned=await previewRecordImport(deps,owner,input('Reference\nOWNER-ONLY'));
  await expect(readRecordImport(opened.db,operator,owned.id)).rejects.toMatchObject({code:'IMPORT_NOT_FOUND'});
  const preview=await previewRecordImport(deps,operator,input('Reference\nREVOKED-1'));await commitRecordImport(opened.db,clock,operator,preview.id,{previewVersion:preview.previewVersion,importValidRows:true});
  await revokeOrganizationMember(opened.db,clock,owner,org,member,'revoke');await processPendingRecordImports(deps);
  const failed=await readRecordImport(opened.db,owner,preview.id);expect(failed.recordIds).toEqual([]);expect(failed.rows[0].status).toBe('failed');
 });
 it('rejects mutation of accepted original and normalized source rows',async()=>{
  const preview=await previewRecordImport(deps,owner,input('Reference\nIMMUTABLE-1'));
  await expect(opened.db.query("UPDATE record_import_jobs SET original_sha256=repeat('0',64) WHERE id=$1",[preview.id])).rejects.toThrow(/immutable/);
  await expect(opened.db.query("UPDATE record_import_rows SET normalized='{}'::jsonb WHERE import_id=$1",[preview.id])).rejects.toThrow(/immutable/);
 });
 it('exposes authenticated receipts and safe downloads through the HTTP router',async()=>{
  const app=express();app.use(express.json());app.use('/me/records/imports',createRecordImportsRouter(deps));app.use((e:unknown,_r:express.Request,s:express.Response,_n:express.NextFunction)=>{s.status(e instanceof DomainError?e.httpStatus:500).json({code:e instanceof DomainError?e.code:'UNEXPECTED'});});
  expect((await request(app).get('/me/records/imports/template.csv')).status).toBe(401);
  const preview=await request(app).post('/me/records/imports/preview').set('Authorization',`Bearer ${owner}`).send(input('Reference,Quantity\n=EVIL(),bad'));
  expect(preview.status,preview.text).toBe(201);
  const correction=await request(app).get(`/me/records/imports/${preview.body.id}/corrections.csv`).set('Authorization',`Bearer ${owner}`);expect(correction.status).toBe(200);expect(correction.text).toContain('"\'=EVIL()"');
  const foreign=await request(app).get(`/me/records/imports/${preview.body.id}`).set('Authorization',`Bearer ${otherOwner}`);expect(foreign.status).toBe(404);
 });
});
