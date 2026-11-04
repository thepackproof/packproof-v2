import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import express from 'express';
import {IncomingMessage,ServerResponse} from 'node:http';
import {Duplex} from 'node:stream';
import type {Socket} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createOrganization,setOrganizationEntitlement,createIntegrationAccount,createServicePrincipal,issuePartnerCredential,authenticatePartner,PARTNER_SCOPES} from '../src/platform/organizations.js';
import {importPartnerOrder} from '../src/platform/partner-proofs.js';
import {createSourceArtifactsRouter} from '../src/records/partner-artifacts-router.js';
import {processSourceArtifactCompletions} from '../src/records/source-artifacts.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {DomainError} from '../src/domain/errors.js';
import type {AppDependencies} from '../src/app.js';
import {createServerApp} from '../src/server-app.js';
import type {RecordWorkspace} from '../src/records/access.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {sha256Hex} from '../src/hash.js';

function http(app:express.Express,method:string,url:string,headers:Record<string,string>={},body:Buffer=Buffer.alloc(0)):Promise<{status:number;body:any;bytes:Buffer;headers:ReturnType<ServerResponse['getHeaders']>}> {
 return new Promise((resolve,reject)=>{
  const socket=new Duplex({read(){},write(_b,_e,done){done();}}) as Duplex&{setTimeout:()=>void};socket.setTimeout=()=>{};
  const req=new IncomingMessage(socket as unknown as Socket);req.method=method;req.url=url;req.headers=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));
  if(body.length)req.headers['content-length']=String(body.length);
  const res=new ServerResponse(req),chunks:Buffer[]=[];res.assignSocket(socket as unknown as Socket);
  const deadline=setTimeout(()=>reject(new Error(`HTTP fixture stalled: ${method} ${url}, status=${res.statusCode}, destroyed=${res.destroyed}`)),5000);
  const write=res.write.bind(res),end=res.end.bind(res);
  res.write=((chunk:any,...args:any[])=>{if(chunk)chunks.push(Buffer.from(chunk));return (write as Function)(chunk,...args);}) as typeof res.write;
  res.end=((chunk:any,...args:any[])=>{clearTimeout(deadline);if(chunk&&typeof chunk!=='function')chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);let body:any;try{body=JSON.parse(bytes.toString());}catch{body=bytes;}resolve({status:res.statusCode,body,bytes,headers:res.getHeaders()});return (end as Function)(chunk,...args);}) as typeof res.end;
  res.on('error',reject);res.on('finish',()=>socket.destroy());app(req,res);if(body.length)req.push(body);req.complete=true;req.push(null);
 });
}

describe('human source artifact authenticated HTTP gateway',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,dir:string,store:LocalObjectStore,app:express.Express,user:string,org:string,proof:string,w:RecordWorkspace;
 const clock={now:()=>new Date()},png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(120,7)]);
 const auth=()=>({Authorization:`Bearer ${user}`}),q=()=>`?organizationId=${org}&environment=sandbox`;
 const json=(v:unknown)=>Buffer.from(JSON.stringify(v));
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');opened=await openIsolatedTestDatabase();await migrate(opened.db);dir=await mkdtemp(path.join(os.tmpdir(),'artifact-http-'));store=new LocalObjectStore(dir,'http://example.test','unused');
  const admin=await insertUser(opened.db,clock);user=await insertUser(opened.db,clock);await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'HTTP source workspace',ownerUserId:user},'test')).id;await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'test');w=await requireRecordWorkspace(opened.db,user,org,'sandbox');
  const p=await createServicePrincipal(opened.db,clock,user,org,{name:'Record bootstrap'},'test'),credential=await issuePartnerCredential(opened.db,clock,user,org,p.id,{scopes:[...PARTNER_SCOPES],expiresAt:new Date(Date.now()+86400000).toISOString()},'test'),actor=await authenticatePartner(opened.db,clock,`Bearer ${credential.token}`,org,undefined,'test'),account=await createIntegrationAccount(opened.db,clock,user,org,{provider:'source-http',externalAccountId:'http-fixture'},'test');
  proof=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account.id,externalId:'HTTP-1',operatorMembershipId:w.membershipId,transaction:{itemTitle:'HTTP source fixture'}})).proofId;
  app=createServerApp({db:opened.db,clock,objectStore:store,auth:new BearerUserAdapter(opened.db),publicBaseUrl:'http://example.test',devAuth:true,testFixtures:true});
 },60000);
 afterAll(async()=>{await opened?.close();if(dir){const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe cleanup');await rm(resolved,{recursive:true,force:true});}vi.unstubAllEnvs();});
 it('executes real JSON, raw multipart, durable operation, range and isolated original responses',async()=>{
  const initialized=await http(app,'POST',`/me/records/source-upload-sessions${q()}`,{...auth(),'Content-Type':'application/json','Idempotency-Key':'http-original'},json({proofId:proof,filename:'unsafe-name<script>.png',contentType:'image/png',byteSize:png.length,reportedAt:'2026-11-03T12:00:00Z'}));expect(initialized.status,JSON.stringify(initialized.body)).toBe(201);
  const id=initialized.body.sessionId,artifact=initialized.body.artifactId,path=`/me/records/source-upload-sessions/${id}`;
  const wrongType=await http(app,'PUT',`${path}/parts/1${q()}`,{...auth(),'Content-Type':'text/html'},png);expect(wrongType.status).toBe(422);
  const uploaded=await http(app,'PUT',`${path}/parts/1${q()}`,{...auth(),'Content-Type':'image/png'},png);expect(uploaded.status,JSON.stringify(uploaded.body)).toBe(200);expect(uploaded.body).toMatchObject({partNumber:1,sha256:sha256Hex(png)});
  const state=await http(app,'GET',`${path}/parts${q()}`,auth());expect(state.body.receivedParts).toMatchObject([{partNumber:1,byteSize:png.length}]);
  const assembled=await http(app,'POST',`${path}/parts/complete${q()}`,{...auth(),'Content-Type':'application/json'},json({}));expect(assembled.body.state).toBe('received');
  const committed=await http(app,'POST',`${path}/complete${q()}`,{...auth(),'Content-Type':'application/json'},json({}));expect(committed.status).toBe(202);expect(committed.headers.location).toBe(committed.body.links.self);
  await processSourceArtifactCompletions(opened.db,clock,store);
  const operation=await http(app,'GET',committed.body.links.self,auth());expect(operation.status).toBe(200);expect(operation.body).toMatchObject({state:'succeeded',result:{sha256:sha256Hex(png)}});
  const original=await http(app,'GET',`/me/records/${proof}/source-artifacts/${artifact}/blob${q()}`,{...auth(),Range:'bytes=0-7'});expect(original.status).toBe(206);expect(original.bytes).toEqual(png.subarray(0,8));expect(original.headers['content-disposition']).toBe(`attachment; filename="${artifact}.png"`);expect(original.headers['content-security-policy']).toContain('sandbox');expect(original.headers['cache-control']).toBe('private, no-store');expect(original.headers['x-artifact-sha256']).toBe(sha256Hex(png));
  const wrongScope=await http(app,'GET',`/me/records/${proof}/source-artifacts/${artifact}/blob?organizationId=other&environment=sandbox`,auth());expect(wrongScope.status).toBe(404);
 });
 it('requires authenticated current workspace selectors and does not make a bearer upload ticket',async()=>{
  const response=await http(app,'POST','/me/records/source-upload-sessions',{...auth(),'Content-Type':'application/json','Idempotency-Key':'missing-workspace'},json({}));expect(response.status).toBe(400);
  const unauthenticated=await http(app,'GET',`/me/records/${proof}/source-artifacts${q()}`);expect(unauthenticated.status).toBe(401);
 });
});
