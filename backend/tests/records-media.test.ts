import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import express from 'express';
import {Readable,Duplex} from 'node:stream';
import {IncomingMessage,ServerResponse} from 'node:http';
import type {Socket} from 'node:net';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {MemoryObjectStore} from './memory-object-store.js';
import type {ObjectReference,ObjectStore} from '../src/s3/object-store.js';
import {insertUser} from '../src/domain/users.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {createOrganization,setOrganizationEntitlement,addOrganizationMember,revokeOrganizationMember} from '../src/platform/organizations.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {createRecordMediaRouter,authorizeRecordMedia,recordMediaPresentation} from '../src/records/media-router.js';
import {withRecordReadGrant} from '../src/records/read-grant.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {getRecord} from '../src/records/service.js';
import {authorizeProofAccess} from '../src/domain/proof-access.js';
import {readCommittedEvidenceStream} from '../src/domain/evidence.js';
import {exportEvidencePackageStream} from '../src/domain/evidence-review.js';
import {finalizeProof} from '../src/domain/finalize.js';
import {commitFulfillmentAndAttest,type TestHarness} from './helpers.js';
import {collectSmallZip} from '../src/export/zip-stream.js';
import {sha256Hex} from '../src/hash.js';
import type {AppDependencies} from '../src/app.js';
import {DomainError} from '../src/domain/errors.js';
import {listMyProofs} from '../src/domain/proof-collection.js';

class VersionedMemoryStore extends MemoryObjectStore {
  refs:Array<ObjectReference|undefined>=[];
  beforeChunk:((index:number,key:string)=>Promise<void>)|null=null;
  closed=false;
  async commitUpload(key:string){const committed=await super.commitUpload(key);return committed?{...committed,versionId:`v-${committed.sha256}`}:null;}
  async head(key:string){const value=await super.get(key);return value?{contentType:value.contentType,byteSize:value.body.length,versionId:`v-${sha256Hex(value.body)}`}:null;}
  async getStream(key:string,input?:ObjectReference&{start?:number;end?:number}) {
    this.refs.push(input);const value=await super.get(key);if(!value)return null;
    const versionId=`v-${sha256Hex(value.body)}`;
    if(input?.versionId&&input.versionId!==versionId)return null;
    const bytes=value.body.subarray(input?.start??0,(input?.end??value.body.length-1)+1),self=this;
    const body=Readable.from((async function*(){try{let index=0;for(let offset=0;offset<bytes.length;offset+=64*1024){await self.beforeChunk?.(++index,key);yield bytes.subarray(offset,offset+64*1024);}}finally{self.closed=true;}})(),{objectMode:false,highWaterMark:64*1024});
    return {body,contentType:value.contentType,byteSize:bytes.length,versionId};
  }
}
/** Real Express streaming boundary without a network listener. */
function download(app:express.Express,path:string,headers:Record<string,string>={}) {
  return new Promise<{status:number;headers:ReturnType<ServerResponse['getHeaders']>;bytes:Buffer;finished:boolean}>((resolve,reject)=>{
    const socket=new Duplex({read(){},write(_chunk,_encoding,done){done();}}),req=new IncomingMessage(socket as Socket);
    req.method='GET';req.url=path;req.headers=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));
    const res=new ServerResponse(req),chunks:Buffer[]=[];res.assignSocket(socket as Socket);
    const write=res.write.bind(res),end=res.end.bind(res);let resolved=false;
    res.write=((chunk:unknown,...args:unknown[])=>{if(chunk)chunks.push(Buffer.from(chunk as any));return (write as Function)(chunk,...args);}) as typeof res.write;
    res.end=((chunk:unknown,...args:unknown[])=>{if(chunk&&typeof chunk!=='function')chunks.push(Buffer.from(chunk as any));return (end as Function)(chunk,...args);}) as typeof res.end;
    const finish=(finished:boolean)=>{if(resolved)return;resolved=true;resolve({status:res.statusCode,headers:res.getHeaders(),bytes:Buffer.concat(chunks),finished});socket.destroy();};
    res.on('finish',()=>finish(true));res.on('close',()=>finish(false));res.on('error',reject);socket.on('close',()=>finish(res.writableFinished));
    app(req,res);req.push(null);
  });
}

let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,store:VersionedMemoryStore,app:express.Express,deps:AppDependencies;
let admin:string,owner:string,other:string,reviewer:string,administrator:string,org:string,otherOrg:string,proof:string,evidence:string,unsealed:string;
const clock={now:()=>new Date()};
const selectors=()=>`organizationId=${encodeURIComponent(org)}&environment=sandbox`;
const auth=(id:string)=>({Authorization:`Bearer ${id}`});
async function createOwnedProof(userId:string,organizationId:string,title:string) {
  const transaction=await createTransaction(opened.db,clock,userId,{itemTitle:title,quantity:1});
  const p=await createOrGetProof(opened.db,clock,userId,transaction.transactionId,{participationPolicy:'COUNTERPARTY_OPTIONAL'});
  const w=await requireRecordWorkspace(opened.db,userId,organizationId,'sandbox');
  await opened.db.query('INSERT INTO platform_proof_ownership(proof_id,merchant_id,environment,operator_membership_id,origin_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[p.proofId,organizationId,'sandbox',w.membershipId,userId,clock.now().toISOString()]);
  await opened.db.query('INSERT INTO record_state(proof_id,organization_id,environment,updated_at) VALUES($1,$2,$3,$4)',[p.proofId,organizationId,'sandbox',clock.now().toISOString()]);
  return p.proofId;
}
beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);store=new VersionedMemoryStore();
  [admin,owner,other,reviewer,administrator]=await Promise.all(Array.from({length:5},()=>insertUser(opened.db,clock)));
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Media A',ownerUserId:owner},'setup')).id;
  otherOrg=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Media B',ownerUserId:other},'setup')).id;
  for(const id of [org,otherOrg])await setOrganizationEntitlement(opened.db,clock,admin,id,{enabled:true},'setup');
  await addOrganizationMember(opened.db,clock,owner,org,{userId:reviewer,role:'REVIEWER'},'setup');
  await addOrganizationMember(opened.db,clock,owner,org,{userId:administrator,role:'ADMIN'},'setup');
  proof=await createOwnedProof(owner,org,'Canonical capture');unsealed=await createOwnedProof(owner,org,'Awaiting capture');
  const committed=await commitFulfillmentAndAttest({db:opened.db,clock,objectStore:store} as TestHarness,owner,proof);
  evidence=committed.evidenceId;await finalizeProof(opened.db,clock,owner,proof);
  deps={db:opened.db,clock,auth:new BearerUserAdapter(opened.db),objectStore:store} as AppDependencies;
  app=express();app.use('/me/records',createRecordMediaRouter(deps));
  app.use((e:unknown,_r:express.Request,s:express.Response,_n:express.NextFunction)=>{if(e instanceof DomainError)s.status(e.httpStatus).json({code:e.code});else s.status(500).json({error:String(e)});});
},90000);
afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});

it('grants organizational viewing without creating a participant or participant action authority',async()=>{
  const w=await requireRecordWorkspace(opened.db,reviewer,org,'sandbox'),granted=await authorizeRecordMedia(deps,w,proof);
  await expect(authorizeProofAccess(opened.db,proof,reviewer)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  await expect(authorizeProofAccess(granted,proof,reviewer)).resolves.toMatchObject({user_id:reviewer});
  await expect(authorizeProofAccess(granted,proof,reviewer,'SELLER')).rejects.toMatchObject({code:'READ_ONLY_AUTHORIZATION'});
  await expect(authorizeProofAccess(granted,unsealed,reviewer)).rejects.toMatchObject({code:'PROOF_NOT_FOUND'});
  expect((await opened.db.query('SELECT id FROM proof_participants WHERE proof_id=$1 AND user_id=$2',[proof,reviewer])).rows).toHaveLength(0);
  expect((await getRecord(opened.db,clock,w,proof)).capabilities.export).toBe(false);
  expect((await getRecord(opened.db,clock,await requireRecordWorkspace(opened.db,administrator,org,'sandbox'),proof)).capabilities.export).toBe(true);
  expect((await getRecord(opened.db,clock,w,unsealed)).capabilities.export).toBe(false);
});
it('serves the exact preserved original and a bounded range to a current reviewer',async()=>{
  store.refs=[];
  const full=await download(app,`/me/records/${proof}/evidence/${evidence}/blob?${selectors()}`,auth(reviewer));
  expect(full.status,full.bytes.toString()).toBe(200);expect(full.finished).toBe(true);expect(full.bytes.length).toBeGreaterThan(100);expect(full.headers['content-type']).toBe('video/mp4');
  expect(full.headers['cache-control']).toBe('private, no-store');expect(full.headers['x-content-type-options']).toBe('nosniff');expect(String(full.headers['content-security-policy'])).toContain('sandbox');
  const range=await download(app,`/me/records/${proof}/evidence/${evidence}/blob?${selectors()}`,{...auth(reviewer),Range:'bytes=0-31'});
  expect(range.status).toBe(206);expect(range.bytes).toEqual(full.bytes.subarray(0,32));expect(store.refs.every(r=>!!r?.versionId)).toBe(true);
  expect(JSON.stringify(full.headers)).not.toContain('sig=');
});
it('isolates active documents and honors explicit original download',()=>{
  for(const type of ['text/html','application/pdf','image/svg+xml','application/javascript'])expect(recordMediaPresentation(type,'evd_test')).toMatchObject({contentType:'application/octet-stream',disposition:'attachment; filename="evd_test.bin"'});
  expect(recordMediaPresentation('image/jpeg','evd_test',true).disposition).toBe('attachment; filename="evd_test.jpg"');
});
it('denies crossed organizations, wrong evidence, pending snapshots and missing session access',async()=>{
  const crossed=await download(app,`/me/records/${proof}/evidence/${evidence}/blob?${selectors()}`,auth(other));expect(crossed.status).toBe(404);
  const wrong=await download(app,`/me/records/${unsealed}/evidence/${evidence}/blob?${selectors()}`,auth(reviewer));expect(wrong.status).toBe(404);
  expect((await download(app,`/me/records/${unsealed}/package?${selectors()}`,auth(administrator))).status).toBe(409);
  expect((await download(app,`/me/records/${proof}/package?${selectors()}`,auth(reviewer))).status).toBe(403);
  expect((await download(app,`/me/records/${proof}/package?${selectors()}`)).status).toBe(401);
});
it('streams the canonical package with unchanged frozen manifest and honest organization disclosure',async()=>{
  const result=await download(app,`/me/records/${proof}/package?${selectors()}`,auth(administrator));
  expect(result.status,result.bytes.toString()).toBe(200);expect(result.finished).toBe(true);expect(result.bytes.subarray(0,2).toString()).toBe('PK');
  expect(result.headers['packproof-package-scope']).toBe('canonical-proof-v1');expect(result.bytes.includes(Buffer.from('ORGANIZATION_CANONICAL_PROOF'))).toBe(true);
  expect(result.bytes.includes(Buffer.from('Later operational revisions, requirements, issues, relationships, amendments and review notes are excluded from the signed canonical manifest inventory'))).toBe(true);
  const frozen=(await opened.db.query<{canonical_json:string}>('SELECT canonical_json FROM final_manifests WHERE proof_id=$1',[proof])).rows[0].canonical_json;
  expect(result.bytes.includes(Buffer.from(frozen))).toBe(true);
  expect((await opened.db.query('SELECT id FROM attestations WHERE proof_id=$1 AND attested_by=$2',[proof,administrator])).rows).toHaveLength(0);
});
it.each(['membership','location'])('aborts an already-open original on %s revocation and closes storage',async kind=>{
  const person=await insertUser(opened.db,clock),membership=`member_stream_${kind}`,location=`site_stream_${kind}`;
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[location,org,location,clock.now().toISOString()]);
  await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,location_scoped,created_at) VALUES($1,$2,$3,'REVIEWER',true,$4)",[membership,org,person,clock.now().toISOString()]);
  await opened.db.query('INSERT INTO record_membership_locations(membership_id,organization_id,location_id) VALUES($1,$2,$3)',[membership,org,location]);
  const id=await createOwnedProof(owner,org,`Revocation ${kind}`),evidenceId=`evd_stream_${kind}`,bytes=Buffer.alloc(3*1024*1024,65),sha=sha256Hex(bytes),key=`evidence/${id}/${evidenceId}/committed/sha256-${sha}`;
  await opened.db.query('UPDATE record_state SET location_id=$2 WHERE proof_id=$1',[id,location]);await store.put(key,bytes,'image/jpeg');
  // This fixture isolates gateway authorization, not media admission or hashing.
  await opened.db.query("INSERT INTO evidence(id,proof_id,submitted_by,object_key,object_version_id,content_type,byte_size,sha256,validation_status,evidence_type,created_at,committed_at) VALUES($1,$2,$3,$4,$5,'image/jpeg',$6,$7,'COMMITTED','SELLER_EVIDENCE',$8,$8)",[evidenceId,id,owner,key,`v-${sha}`,bytes.length,sha,clock.now().toISOString()]);
  const w=await requireRecordWorkspace(opened.db,person,org,'sandbox'),granted=withRecordReadGrant(opened.db,w,id);let revoked=false;store.closed=false;
  store.beforeChunk=async(index,source)=>{if(source===key&&index===3&&!revoked){revoked=true;if(kind==='membership')await revokeOrganizationMember(opened.db,clock,owner,org,membership,'revoke');else await opened.db.query('DELETE FROM record_membership_locations WHERE membership_id=$1 AND location_id=$2',[membership,location]);}};
  const original=await readCommittedEvidenceStream(granted,store,person,id,evidenceId),chunks:Buffer[]=[];
  const consume=async()=>{for await(const chunk of original.body!)chunks.push(Buffer.from(chunk));};
  await expect(consume()).rejects.toMatchObject({code:kind==='membership'?'ORGANIZATION_NOT_FOUND':'PROOF_NOT_FOUND'});
  expect(Buffer.concat(chunks).length).toBeLessThan(bytes.length);await vi.waitFor(()=>expect(store.closed).toBe(true),{timeout:1000,interval:10});
  store.beforeChunk=null;
  expect((await download(app,`/me/records/${id}/evidence/${evidenceId}/blob?${selectors()}`,auth(person))).status).toBe(404);
});
it('reauthorizes an open package after membership revocation before a complete ZIP is emitted',async()=>{
  const person=await insertUser(opened.db,clock),member=String((await addOrganizationMember(opened.db,clock,owner,org,{userId:person,role:'ADMIN'},'setup')).id);
  const w=await requireRecordWorkspace(opened.db,person,org,'sandbox'),granted=withRecordReadGrant(opened.db,w,proof),stream=await exportEvidencePackageStream(granted,clock,store,person,proof);
  await revokeOrganizationMember(opened.db,clock,owner,org,member,'revoke');
  const chunks:Buffer[]=[];await expect((async()=>{for await(const c of stream)chunks.push(Buffer.from(c));})()).rejects.toMatchObject({code:'ORGANIZATION_NOT_FOUND'});
  expect(Buffer.concat(chunks).includes(Buffer.from([0x50,0x4b,0x05,0x06]))).toBe(false);
});
it('stops an in-progress package when membership is revoked after archive delivery begins',async()=>{
  const person=await insertUser(opened.db,clock),member=String((await addOrganizationMember(opened.db,clock,owner,org,{userId:person,role:'ADMIN'},'setup')).id);
  const w=await requireRecordWorkspace(opened.db,person,org,'sandbox'),granted=withRecordReadGrant(opened.db,w,proof);store.closed=false;
  const previousReads=store.refs.length,chunks:Buffer[]=[];
  await expect((async()=>{for await(const c of await exportEvidencePackageStream(granted,clock,store,person,proof)){
    chunks.push(Buffer.from(c));if(chunks.length===1)await revokeOrganizationMember(opened.db,clock,owner,org,member,'stream-revoke');
  }})()).rejects.toMatchObject({code:'ORGANIZATION_NOT_FOUND'});
  expect(Buffer.concat(chunks).length).toBeGreaterThan(0);expect(Buffer.concat(chunks).includes(Buffer.from([0x50,0x4b,0x05,0x06]))).toBe(false);
  if(store.refs.length>previousReads)await vi.waitFor(()=>expect(store.closed).toBe(true),{timeout:1000,interval:10});
});
it('enforces a location revocation on existing participant routes and legacy collection queries',async()=>{
  const person=await insertUser(opened.db,clock),membership='member_legacy_location',location='site_legacy_location';
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[location,org,'Legacy route boundary',clock.now().toISOString()]);
  await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,location_scoped,created_at) VALUES($1,$2,$3,'OPERATOR',true,$4)",[membership,org,person,clock.now().toISOString()]);
  await opened.db.query('INSERT INTO record_membership_locations(membership_id,organization_id,location_id) VALUES($1,$2,$3)',[membership,org,location]);
  const id=await createOwnedProof(person,org,'Assigned location capture');await opened.db.query('UPDATE record_state SET location_id=$2 WHERE proof_id=$1',[id,location]);
  await expect(authorizeProofAccess(opened.db,id,person,'SELLER')).resolves.toMatchObject({user_id:person});
  expect((await listMyProofs(opened.db,person)).some(p=>p.proofId===id)).toBe(true);
  await opened.db.query('DELETE FROM record_membership_locations WHERE membership_id=$1 AND location_id=$2',[membership,location]);
  await expect(authorizeProofAccess(opened.db,id,person)).rejects.toMatchObject({code:'ORGANIZATION_ACCESS_REVOKED'});
  expect((await listMyProofs(opened.db,person)).some(p=>p.proofId===id)).toBe(false);
});
it('requires organization export authority while retaining an assigned participant legacy export',async()=>{
  const person=await insertUser(opened.db,clock);await addOrganizationMember(opened.db,clock,owner,org,{userId:person,role:'OPERATOR'},'setup');
  const id=await createOwnedProof(person,org,'Assigned operator final record');
  await commitFulfillmentAndAttest({db:opened.db,clock,objectStore:store} as TestHarness,person,id);await finalizeProof(opened.db,clock,person,id);
  const w=await requireRecordWorkspace(opened.db,person,org,'sandbox');expect((await getRecord(opened.db,clock,w,id)).capabilities.export).toBe(false);
  const denied=await download(app,`/me/records/${id}/package?${selectors()}`,auth(person));expect(denied.status,denied.bytes.toString()).toBe(403);
  const legacy=await collectSmallZip(await exportEvidencePackageStream(opened.db,clock,store,person,id));expect(legacy.subarray(0,2).toString()).toBe('PK');
});
