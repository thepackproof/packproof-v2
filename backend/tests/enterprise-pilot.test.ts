import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import request from 'supertest';
import { createHarness,createUser,auth,type TestHarness } from './helpers.js';
import { syntheticEnvelope,syntheticRecords,syntheticTicket } from '../src/enterprise/demo.js';
import { canonicalMapping,sourceTime,parseCsv,units,decimalString } from '../src/enterprise/contracts.js';
import { createServicePrincipal,issuePartnerCredential } from '../src/platform/organizations.js';
import { sha256Hex } from '../src/hash.js';
const root='/v1/enterprise';
let h:TestHarness,owner:string,other:string,reviewer:string,siteId:string,otherSite:string,sourceId:string,normalId:string,splitId:string,varianceId:string,firstBatch:string,counter=0;
let now=new Date('2026-10-26T12:00:00Z');const clock={now:()=>new Date(now)},env={...process.env};
function post(path:string,body:unknown,user=owner,id?:string){return request(h.app).post(root+path).set(auth(user)).set('Idempotency-Key',id??'enterprise-'+(++counter)).send(body);}
async function seedOrg(id:string,user:string){
 await h.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,$1,'sandbox',$3)",['tenant-'+id,user,now.toISOString()]);
 await h.db.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,enabled,created_at) VALUES($1,'MERCHANT',$1,$2,'sandbox',$3,true,$4)",[id,user,'tenant-'+id,now.toISOString()]);
 await h.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'OWNER',$4)",['member-'+id,id,user,now.toISOString()]);
}
async function importRows(rows:unknown[],files:unknown[]=[],source=sourceId){
 const envelope={schemaVersion:'packproof.enterprise.import/v1',sourceId:source,mappingVersion:'1',format:'JSON',synthetic:true,contentBase64:Buffer.from(JSON.stringify(rows)).toString('base64'),files};
 const preview=await post('/imports/preview',envelope);expect(preview.status,JSON.stringify(preview.body)).toBe(200);
 const result=await post('/imports',{...envelope,previewDigest:preview.body.previewDigest});expect(result.status,JSON.stringify(result.body)).toBe(201);return result.body;
}
const binary=(res:any,cb:any)=>{const b:Buffer[]=[];res.on('data',(c:any)=>b.push(Buffer.from(c)));res.on('end',()=>cb(null,Buffer.concat(b)));};
describe('enterprise pilot acceptance',()=>{
 beforeAll(async()=>{
  process.env.PACKPROOF_ENTERPRISE_ENABLED='true';process.env.PACKPROOF_ORGANIZATIONS_ENABLED='true';delete process.env.PACKPROOF_ENTERPRISE_HISTORICAL_ENABLED;
  h=await createHarness(clock);owner=await createUser(h);other=await createUser(h);reviewer=await createUser(h);
  await seedOrg('merchant-one',owner);await seedOrg('merchant-two',other);
  await h.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,created_at) VALUES('reviewer-one','merchant-one',$1,'REVIEWER',$2)",[reviewer,now.toISOString()]);
  const a=await post('/sites',{organizationId:'merchant-one',name:'Synthetic A',mode:'SYNTHETIC',fulfillmentMode:'LOCAL_DELIVERY',retentionDays:30});expect(a.status,JSON.stringify(a.body)).toBe(201);siteId=a.body.id;
  const b=await post('/sites',{organizationId:'merchant-two',name:'Synthetic B',mode:'SYNTHETIC',fulfillmentMode:'PICKUP',retentionDays:30},other);expect(b.status,JSON.stringify(b.body)).toBe(201);otherSite=b.body.id;
  const s=await post('/sites/'+siteId+'/sources',{name:'Synthetic export',freshnessHours:8760});expect(s.status).toBe(201);sourceId=s.body.id;
  const map=await post('/sources/'+sourceId+'/mappings',{mapping:canonicalMapping,approvalReference:'SYNTHETIC_ONLY'});expect(map.status,JSON.stringify(map.body)).toBe(201);
 },60000);
 afterAll(async()=>{await h?.close();for(const k of ['PACKPROOF_ENTERPRISE_ENABLED','PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_ENTERPRISE_HISTORICAL_ENABLED']){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}});
 it('imports complete, split and discrepancy cases with explicit preview and exact originals',async()=>{
  const envelope=syntheticEnvelope(sourceId),p=await post('/imports/preview',envelope);expect(p.status,JSON.stringify(p.body)).toBe(200);expect(p.body.counts).toMatchObject({received:15,quarantined:1,files:2});
  expect((await post('/imports',envelope)).status).toBe(409);
  const c=await post('/imports',{...envelope,previewDigest:p.body.previewDigest});expect(c.status,JSON.stringify(c.body)).toBe(201);firstBatch=c.body.id;
  const list=await request(h.app).get(root+'/dossiers').query({siteId}).set(auth(owner));expect(list.status,JSON.stringify(list.body)).toBe(200);expect(list.body.items).toHaveLength(3);
  normalId=list.body.items.find((x:any)=>x.externalId==='SYNTH-NORMAL').id;splitId=list.body.items.find((x:any)=>x.externalId==='SYNTH-SPLIT').id;varianceId=list.body.items.find((x:any)=>x.externalId==='SYNTH-VARIANCE').id;
  const n=await request(h.app).get(root+'/dossiers/'+normalId).set(auth(owner));expect(n.status).toBe(200);expect(n.body.reconciliation.exceptions).toHaveLength(0);expect(n.body.reconciliation.lines[0].stages.ACKNOWLEDGED.quantity).toBe('10');
  const s=await request(h.app).get(root+'/dossiers/'+splitId).set(auth(owner));expect(s.body.fulfillments).toHaveLength(2);expect(s.body.reconciliation.lines).toHaveLength(2);expect(s.body.reconciliation.lines[1].stages.LOADED.quantity).toBe('20');expect(s.body.reconciliation.lines[0].stages.LOADED.quantity).toBe('10');
  const v=await request(h.app).get(root+'/dossiers/'+varianceId).set(auth(owner));expect(v.body.reconciliation.exceptions.map((e:any)=>e.code)).toEqual(expect.arrayContaining(['LOAD_QTY_DIFFERS_FROM_PICK','HANDOFF_RECORD_NOT_FOUND']));expect(v.body.reconciliation.lines[0].stages.ACKNOWLEDGED).toBeUndefined();expect(v.body.confidence.businessClaimSupported).toBe(false);
  const original=await request(h.app).get(root+'/imports/'+firstBatch+'/original').set(auth(owner)).buffer(true).parse(binary);expect(original.status).toBe(200);expect(original.body.equals(Buffer.from(envelope.contentBase64,'base64'))).toBe(true);
 });
 it('deduplicates reruns and retries and rejects changed idempotency payloads',async()=>{
  const before=(await h.db.query<{n:number}>('SELECT count(*)::int AS n FROM enterprise_assertions')).rows[0].n;
  const r=await importRows(syntheticRecords());expect(r.counts.inserted).toBe(0);expect(r.counts.duplicates).toBe(15);const status=await request(h.app).get(root+'/imports/'+r.id).set(auth(owner));expect(status.status,JSON.stringify(status.body)).toBe(200);expect(status.body.records).toHaveLength(15);expect((await h.db.query<{n:number}>('SELECT count(*)::int AS n FROM enterprise_assertions')).rows[0].n).toBe(before);
  const body={name:'Extra source',freshnessHours:24},a=await post('/sites/'+siteId+'/sources',body,owner,'retry-source'),b=await post('/sites/'+siteId+'/sources',body,owner,'retry-source');expect(b.body.id).toBe(a.body.id);expect(b.headers['idempotency-replayed']).toBe('true');expect((await post('/sites/'+siteId+'/sources',{...body,name:'Changed'},owner,'retry-source')).status).toBe(409);
 });
 it('isolates distinct merchants and requires explicit site grants for humans',async()=>{
  for(const path of ['/dossiers?siteId='+siteId,'/dossiers/'+normalId,'/imports/'+firstBatch+'/original','/sites/'+siteId+'/diagnostics'])expect((await request(h.app).get(root+path).set(auth(other))).status,path).toBe(404);
  expect((await request(h.app).get(root+'/dossiers/'+normalId).set(auth(reviewer))).status).toBe(404);
  expect((await post('/sites/'+siteId+'/members',{userId:reviewer,role:'READ_ONLY'})).status).toBe(201);
  expect((await request(h.app).get(root+'/dossiers/'+normalId).set(auth(reviewer))).status).toBe(200);
  expect((await post('/dossiers/'+normalId+'/annotations',{disposition:'NOTE',reason:'Forbidden'},reviewer)).status).toBe(404);
  expect((await request(h.app).get(root+'/dossiers').query({siteId:otherSite}).set(auth(reviewer))).status).toBe(404);
  await post('/sites/'+siteId+'/members',{userId:reviewer,role:'REVIEWER'});
 });
 it('verifies original document custody and appends notes without rewriting assertions',async()=>{
  const d=await request(h.app).get(root+'/dossiers/'+normalId).set(auth(reviewer)),asset=d.body.evidence[0];
  const r=await request(h.app).get(root+'/dossiers/'+normalId+'/evidence/'+asset.id).set(auth(reviewer)).buffer(true).parse(binary);expect(r.status).toBe(200);expect(sha256Hex(r.body)).toBe(sha256Hex(syntheticTicket('SYNTH-NORMAL')));expect(r.headers['content-disposition']).toContain('attachment');
  expect((await post('/dossiers/'+normalId+'/annotations',{disposition:'NOTE',reason:'Synthetic walkthrough; no physical fulfillment claim.'},reviewer)).status).toBe(201);
  await expect(h.db.query("UPDATE enterprise_source_records SET revision='erased' WHERE id=$1",[d.body.timeline[0].id])).rejects.toThrow();
  const raw=await request(h.app).get(root+'/dossiers/'+normalId+'/records/'+d.body.timeline[0].id).set(auth(reviewer));expect(raw.status).toBe(200);expect(raw.body.raw_payload.order_id).toBe('SYNTH-NORMAL');
 });
 it('joins independently sourced records only through an approved same-site key namespace',async()=>{
  const w=await post('/sites/'+siteId+'/sources',{name:'Synthetic WMS',freshnessHours:8760});expect(w.status).toBe(201);
  const mapping={...canonicalMapping,orderNamespaceSourceId:sourceId,fulfillmentNamespaceSourceId:sourceId};
  expect((await post('/sources/'+w.body.id+'/mappings',{mapping,approvalReference:'SYNTHETIC_SME_VERIFIED_KEY_NAMESPACE'})).status).toBe(201);
  await importRows([{record_key:'wms-pick',revision:'1',stage:'PICKED',order_id:'SYNTH-NORMAL',fulfillment_id:'SYN-SHIP-N',source_timezone:'America/New_York',occurred_at_local:'2026-10-14T09:00:00',lines:[{line_id:'1',quantity:'10',uom:'EA'}]}],[],w.body.id);
  const d=await request(h.app).get(root+'/dossiers/'+normalId).set(auth(owner));expect(d.body.timeline.some((x:any)=>x.sourceName==='Synthetic WMS')).toBe(true);expect(d.body.reconciliation.lines[0].stages.PICKED.quantity).toBe('10');
  await importRows([{record_key:'native-whitespace',revision:'1',stage:'ORDERED',order_id:'SYNTH-NORMAL ',lines:[{line_id:'1',quantity:'1',uom:'EA'}]}]);const separate=await request(h.app).get(root+'/dossiers').query({siteId,externalId:'SYNTH-NORMAL '}).set(auth(owner));expect(separate.body.items).toHaveLength(1);expect(separate.body.items[0].id).not.toBe(normalId);
  const alien=await post('/sites/'+otherSite+'/sources',{name:'Different merchant source',freshnessHours:8760},other);
  const denied=await post('/sources/'+w.body.id+'/mappings',{mapping:{...mapping,version:'2',orderNamespaceSourceId:alien.body.id},approvalReference:'INVALID_CROSS_SITE'});expect(denied.status).toBe(400);
 });
 it('withholds mixed UOM and unknown times and uses exact decimal arithmetic',async()=>{
  await importRows([{record_key:'uom-extra',revision:'1',stage:'ACKNOWLEDGED',order_id:'SYNTH-NORMAL',fulfillment_id:'SYN-SHIP-N',lines:[{line_id:'1',quantity:'1',uom:'CASE'}]}]);
  const d=await request(h.app).get(root+'/dossiers/'+normalId).set(auth(owner));expect(d.body.reconciliation.lines[0].stages.ACKNOWLEDGED.quantity).toBeNull();expect(d.body.reconciliation.exceptions.map((e:any)=>e.code)).toContain('UOM_CONVERSION_UNKNOWN');expect(d.body.timeline.find((e:any)=>e.recordKey==='uom-extra').occurredAtUtc).toBeNull();
  expect(sourceTime('2026-11-01T01:30:00','America/New_York').timeConfidence).toBe('AMBIGUOUS');expect(sourceTime('2026-10-14T09:00:00',null).occurredAtUtc).toBeNull();expect(decimalString(units('0.1')+units('0.2'))).toBe('0.3');
 });
 it('applies out-of-order corrections and preserves every original revision',async()=>{
  const b={record_key:'variance-load',stage:'LOADED',order_id:'SYNTH-VARIANCE',fulfillment_id:'SYN-SHIP-X',source_timezone:'America/New_York',occurred_at_local:'2026-10-14T09:00:00'};
  const result=await importRows([{...b,revision:'3',supersedes_revision:'2',lines:[{line_id:'1',quantity:'7',uom:'EA'}]},{...b,revision:'2',supersedes_revision:'1',lines:[{line_id:'1',quantity:'9',uom:'EA'}]}]);expect(result.counts.quarantined).toBe(0);
  const d=await request(h.app).get(root+'/dossiers/'+varianceId).set(auth(owner));expect(d.body.reconciliation.lines[0].stages.LOADED.quantity).toBe('7');expect(d.body.timeline.filter((e:any)=>e.recordKey==='variance-load')).toHaveLength(1);
  const history=await h.db.query('SELECT revision FROM enterprise_source_records WHERE source_id=$1 AND record_key=$2 ORDER BY revision',[sourceId,'variance-load']);expect(history.rows.map(r=>r.revision)).toEqual(['1','2','3']);
  const envelope={schemaVersion:'packproof.enterprise.import/v1',sourceId,mappingVersion:'1',format:'JSON',synthetic:true,contentBase64:Buffer.from(JSON.stringify([{...b,revision:'1',lines:[{line_id:'1',quantity:'999',uom:'EA'}]}])).toString('base64')};expect((await post('/imports/preview',envelope)).status).toBe(409);
 });
 it('requires a reasoned reviewer decision for ambiguous joins',async()=>{
  const diag=await request(h.app).get(root+'/sites/'+siteId+'/diagnostics').set(auth(owner)),row=diag.body.quarantine.find((r:any)=>r.record_key==='ambiguous-load');expect(row).toBeTruthy();
  const result=await post('/sites/'+siteId+'/records/'+row.id+'/resolve',{dossierId:varianceId,reason:'Synthetic walkthrough confirms association only.'},reviewer);expect(result.status,JSON.stringify(result.body)).toBe(201);expect(result.body.businessClaimSupported).toBe(false);
  const d=await request(h.app).get(root+'/dossiers/'+varianceId).set(auth(owner));expect(d.body.timeline.find((e:any)=>e.recordKey==='ambiguous-load').association).toBe('REVIEWER_CONFIRMED');
 });
 it('limits machine ingestion to its granted source and denies machine review or revoked grants',async()=>{
  const principal=await createServicePrincipal(h.db,clock,owner,'merchant-one',{name:'Synthetic ingester'},'seed-principal'),credential=await issuePartnerCredential(h.db,clock,owner,'merchant-one',principal.id,{scopes:['enterprise:ingest'],expiresAt:'2026-11-01T00:00:00Z'},'seed-credential'),envelope=syntheticEnvelope(sourceId);
  expect((await request(h.app).post(root+'/imports/preview').set('Authorization','Bearer '+credential.token).send(envelope)).status).toBe(404);
  expect((await post('/sources/'+sourceId+'/service-grants',{principalId:principal.id,expiresAt:'2026-11-01T00:00:00Z'})).status).toBe(201);
  const r=await request(h.app).post(root+'/imports/preview').set('Authorization','Bearer '+credential.token).send(envelope);expect(r.status,JSON.stringify(r.body)).toBe(200);expect((await request(h.app).get(root+'/imports/'+firstBatch+'/original').set('Authorization','Bearer '+credential.token)).status).toBe(404);
  expect((await request(h.app).get(root+'/dossiers/'+normalId).set('Authorization','Bearer '+credential.token)).status).toBe(404);
  await post('/sources/'+sourceId+'/service-grants',{principalId:principal.id,expiresAt:'2026-11-01T00:00:00Z',revoked:true});expect((await request(h.app).post(root+'/imports/preview').set('Authorization','Bearer '+credential.token).send(envelope)).status).toBe(404);
 });
 it('associates late originals unambiguously and rejects digest failures on retrieval',async()=>{
  const row={record_key:'late-ticket',revision:'1',stage:'HANDOFF',order_id:'SYNTH-VARIANCE',lines:[{line_id:'1'}],document_keys:['late-ticket.pdf']};
  await importRows([row]);const bytes=syntheticTicket('SYNTH-LATE');
  await importRows([row],[{documentKey:'late-ticket.pdf',contentType:'application/pdf',base64:bytes.toString('base64')}]);
  const d=await request(h.app).get(root+'/dossiers/'+varianceId).set(auth(owner)),event=d.body.timeline.find((x:any)=>x.recordKey==='late-ticket');expect(event.evidence).toHaveLength(1);
  const asset=(await h.db.query<{object_key:string}>('SELECT object_key FROM enterprise_assets WHERE id=$1',[event.evidence[0].id])).rows[0];
  const originalGet=h.objectStore.get.bind(h.objectStore);h.objectStore.get=async(k,ref)=>k===asset.object_key?{body:Buffer.from('tampered'),contentType:'application/pdf'}:originalGet(k,ref);
  try{const r=await request(h.app).get(root+'/dossiers/'+varianceId+'/evidence/'+event.evidence[0].id).set(auth(owner));expect(r.status).toBe(409);expect(r.body.error.code).toBe('ENTERPRISE_ORIGINAL_INTEGRITY_FAILURE');}finally{h.objectStore.get=originalGet;}
 });
 it('measures baseline and pilot duration without inventing ROI',async()=>{
  // Advance the clock first so the suite also exercises a new distributed rate window.
  now=new Date(now.getTime()+60000);
  for(const condition of ['BASELINE','PACKPROOF']){
   const m=await post('/dossiers/'+splitId+'/measurements',{studyKey:'synthetic-study',condition,complexity:'split',question:'How many units were acknowledged?'},reviewer);expect(m.status,JSON.stringify(m.body)).toBe(201);now=new Date(now.getTime()+(condition==='BASELINE'?120:40)*1000);
   const r=await post('/measurements/'+m.body.id+'/finish',{outcome:'COMPLETED',correctLinks:2,adjudicatedLinks:2,missingVisible:0,knownMissing:0,feedback:'Synthetic practice only.'},reviewer);expect(r.status,JSON.stringify(r.body)).toBe(201);
  }
  const m=await request(h.app).get(root+'/pilot/metrics').query({siteId}).set(auth(reviewer));expect(m.status,JSON.stringify(m.body)).toBe(200);expect(m.body.pairedComparison.n).toBe(1);expect(m.body.pairedComparison.differenceSeconds.median).toBe(80);expect(m.body.synthetic).toBe(true);expect(m.body.missingRecordVisibility).toBeNull();
 });
 it('parses strict CSV and keeps historical ingestion and feature rollout gated',async()=>{
  expect(parseCsv('id,description\r\n1,"a,b\nnext"\r\n')).toEqual([{id:'1',description:'a,b\nnext'}]);expect(()=>parseCsv('id,id\n1,2')).toThrow();
  expect((await post('/sites',{organizationId:'merchant-one',name:'Unapproved historical',mode:'HISTORICAL',fulfillmentMode:'LOCAL_DELIVERY',retentionDays:30,approvalReference:'not-authorized'})).status).toBe(403);
  process.env.PACKPROOF_ENTERPRISE_ENABLED='false';expect((await request(h.app).get(root+'/sites').set(auth(owner))).status).toBe(503);process.env.PACKPROOF_ENTERPRISE_ENABLED='true';
 });
});
