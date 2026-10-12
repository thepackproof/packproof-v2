import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync,sign,createHash } from 'node:crypto';
import express,{type NextFunction,type Request,type Response} from 'express';
import request from 'supertest';
import { createPgliteDatabase } from '../src/db/pglite.js';
import { migrate } from '../src/db/migrate.js';
import { insertUser } from '../src/domain/users.js';
import { BearerUserAdapter } from '../src/auth/adapter.js';
import { requireSystemAdmin } from '../src/admin/auth.js';
import { enabledResearchConfig } from '../src/rnd/config.js';
import { importLearningReport,listLearningReports,exportLearningReport,rndLearningRouter,validateLearningCandidate } from '../src/rnd/learning-registry.js';
import type { RndDeps } from '../src/rnd/types.js';

const clock={now:()=>new Date('2026-10-02T15:00:00Z')};
let opened:Awaited<ReturnType<typeof createPgliteDatabase>>,deps:RndDeps,admin:string,user:string,candidate:any,trusted:string;
let app:ReturnType<typeof express>;
beforeAll(async()=>{
 opened=await createPgliteDatabase();await migrate(opened.db);
 admin=await insertUser(opened.db,clock);user=await insertUser(opened.db,clock);
 await opened.db.query("INSERT INTO user_system_roles(user_id,role,granted_at) VALUES($1,'SYSTEM_ADMIN',$2)",[admin,clock.now().toISOString()]);
 const root=new URL('../../research/federated/reports/2026-10-02/',import.meta.url);
 const report=JSON.parse(await readFile(new URL('report.json',root),'utf8'));
 candidate=JSON.parse(await readFile(new URL(report.candidateArtifact,root),'utf8'));
 trusted=(await readFile(new URL('trust-key.hex',root),'utf8')).trim();
 deps={db:opened.db,clock,objectStore:{} as RndDeps['objectStore'],rnd:{...enabledResearchConfig(),learning:{trustedPublicKeysHex:[trusted]}}};
 app=express();app.use(express.json());const auth=new BearerUserAdapter(opened.db);
 app.use((req:Request,_res:Response,next:NextFunction)=>{void auth.authenticate(req.headers).then(context=>{req.packproofUserId=context.userId;next();}).catch(next);});
 app.use('/admin',requireSystemAdmin(deps),rndLearningRouter(deps));
 app.use((err:any,_req:Request,res:Response,_next:NextFunction)=>res.status(err.httpStatus??500).json({error:{code:err.code??'INTERNAL',message:err.message}}));
},30000);
afterAll(async()=>{await opened?.close();});

describe('isolated signed learning registry',()=>{
 it('verifies the actual Python-generated Ed25519 candidate and exact signed bytes',()=>{
  const r=validateLearningCandidate(candidate,[trusted]);
  expect(r.summary.productionReleaseAuthorized).toBe(false);
  expect(r.summary.independentContributors).toBe(0);
  expect((r.summary.privacy as any).epsilonMaxCumulative).toBeCloseTo(1.6606191992577408);
  const changed=structuredClone(candidate);changed.payload.model[0]+=1;
  expect(()=>validateLearningCandidate(changed,[trusted])).toThrow('Signed bytes');
  const wire=structuredClone(candidate);wire.canonicalPayload=wire.canonicalPayload.replace('capture-frame','capture-xrame');
  expect(()=>validateLearningCandidate(wire,[trusted])).toThrow('signature');
  expect(()=>validateLearningCandidate(candidate,[])).toThrow('trust policy');
 });
 it('requires server-side admin identity and independent training trust',async()=>{
  expect((await request(app).get('/admin/rnd/learning-reports')).status).toBe(401);
  expect((await request(app).post('/admin/rnd/learning-reports').set('Authorization',`Bearer ${user}`).send(candidate)).status).toBe(403);
  await expect(importLearningReport({...deps,rnd:{...deps.rnd!,learning:{trustedPublicKeysHex:[]}}},admin,candidate)).rejects.toMatchObject({code:'RND_LEARNING_SIGNER_UNTRUSTED'});
  await expect(importLearningReport({...deps,rnd:{...deps.rnd!,killSwitch:true}},admin,candidate)).rejects.toMatchObject({code:'RND_DISABLED'});
 });
 it('persists an idempotent immutable report, admin audit, safe list and independently verifiable export',async()=>{
  const response=await request(app).post('/admin/rnd/learning-reports').set('Authorization',`Bearer ${admin}`).send(candidate);
  expect(response.status,response.text).toBe(201);
  const first=response.body;
  expect(await importLearningReport(deps,admin,candidate)).toEqual(first);
  const result=await listLearningReports(deps,admin);
  expect(result.reports).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('synthetic-partner-');
  const exported=await exportLearningReport(deps,admin,first.reportId);
  expect(validateLearningCandidate(exported.signedCandidate,[trusted]).id).toBe(first.reportId);
  expect(exported.productionReleaseAuthorized).toBe(false);
  expect((await opened.db.query('SELECT 1 FROM system_admin_audit_events WHERE target_id=$1',[first.reportId])).rows).toHaveLength(1);
  await expect(opened.db.query('UPDATE rnd_learning_reports SET release_authorized=TRUE WHERE id=$1',[first.reportId])).rejects.toThrow('RND_RECORD_IMMUTABLE');
  await expect(opened.db.query('DELETE FROM rnd_learning_reports WHERE id=$1',[first.reportId])).rejects.toThrow('RND_RECORD_IMMUTABLE');
 });
 it('rejects private participant fields, unapproved scope and exhausted privacy even if signed by a trusted research key',()=>{
  const pair=generateKeyPairSync('ed25519'),der=pair.publicKey.export({type:'spki',format:'der'}) as Buffer,hex=der.subarray(der.length-32).toString('hex');
  function signed(payload:any){const canonicalPayload=JSON.stringify(payload);return {payload,canonicalPayload,keyId:createHash('sha256').update(Buffer.from(hex,'hex')).digest('hex'),signature:sign(null,Buffer.concat([Buffer.from('PACKPROOF-F10-V1\0'),Buffer.from(canonicalPayload)]),pair.privateKey).toString('base64')};}
  expect(()=>validateLearningCandidate(signed({...candidate.payload,participants:['private-identity']}),[hex])).toThrow();
  expect(()=>validateLearningCandidate(signed({...candidate.payload,scope:'PARTNER_PILOT'}),[hex])).toThrow();
  expect(()=>validateLearningCandidate(signed({...candidate.payload,privacy:{...candidate.payload.privacy,epsilonMaxCumulative:3.1}}),[hex])).toThrow();
 });
 it('rechecks admin revocation on already stored reports',async()=>{
  await opened.db.query('DELETE FROM user_system_roles WHERE user_id=$1',[admin]);
  await expect(listLearningReports(deps,admin)).rejects.toMatchObject({code:'ADMIN_FORBIDDEN'});
 });
});
