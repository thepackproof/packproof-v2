/** Synthetic PNG protocol fixtures test the real process chain, never physical accuracy. */
import {afterEach,describe,it,expect} from 'vitest';
import request from 'supertest';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {createHarness,login,auth,commitFulfillmentAndAttest,type TestHarness} from './helpers.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {createTransaction} from '../src/domain/transactions.js';
import {finalizeProof} from '../src/domain/finalize.js';
import {createServerApp} from '../src/server-app.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import type {AppDependencies} from '../src/app.js';
import {surfaceConfigFromEnv} from '../src/surface/config.js';
import {digest} from '../src/surface/service.js';
import {dispatchSurfaceJobs} from '../src/surface/worker.js';
import {sha256Hex} from '../src/hash.js';
const run=promisify(execFile);
const repository=fileURLToPath(new URL('../../',import.meta.url));
const workerRoot=path.join(repository,'surface-worker');
const venvPython=path.join(workerRoot,'.venv','bin','python');
const python=process.env.PACKPROOF_SURFACE_PYTHON||(existsSync(venvPython)?venvPython:'python3');
const pythonProbe=spawnSync(python,['--version'],{encoding:'utf8'});
const pythonAbsent=(pythonProbe.error as NodeJS.ErrnoException|undefined)?.code==='ENOENT';
const generatePng=String.raw`
import cv2, numpy as np, sys
from pathlib import Path
root=Path(sys.argv[1]); rng=np.random.default_rng(2189)
image=np.clip(rng.normal(105,12,(700,1000)),20,230).astype(np.uint8)
# Synthetic label boundary and barcode exercise same-frame candidate discovery.
image[150:551,250:751]=np.clip(rng.normal(235,4,(401,501)),200,250).astype(np.uint8)
for x in range(355,646,8):
    cv2.rectangle(image,(x,260),(x+3,390),25,-1)
assert cv2.imwrite(str(root/'synthetic-enrollment.png'),image)
moved=cv2.warpAffine(image,np.float32([[1,0,1],[0,1,1]]),(1000,700),borderMode=cv2.BORDER_REFLECT)
assert cv2.imwrite(str(root/'synthetic-observation.png'),moved)
`;
function regions(sourceId:string){
 // Same explicit context + barcode observations sent by mobile; width/height are pixel counts.
 return [{id:'context_0',sourceId,group:'context',polygon:[[0,0],[999,0],[999,699],[0,699]],process:'unknown',trackId:null},{id:'print_0',sourceId,group:'print',polygon:[[350,250],[650,250],[650,400],[350,400]],process:'unknown',trackId:'expected_barcode_only'}];
}

describe('real surface worker and offline verifier — synthetic protocol fixtures only',()=>{
 let h:TestHarness|undefined,temporary:string|undefined;
 afterEach(async()=>{await h?.close();if(temporary)await rm(temporary,{recursive:true,force:true});});
 it.skipIf(pythonAbsent)('checks actual PNG uploads, Python jobs, cross-language digests and exported originals without changing a finalized root',async()=>{
  expect(pythonProbe.status,pythonProbe.stderr).toBe(0);
  temporary=await mkdtemp(path.join(os.tmpdir(),'packproof-surface-e2e-'));
  await run(python,['-c',generatePng,temporary],{timeout:20000,env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}});
  h=await createHarness();const actor=await login(h.app,'synthetic-surface-e2e');
  const transaction=await createTransaction(h.db,h.clock,actor,{itemTitle:'Synthetic integration fixture — not a physical trial'});
  const proofId=(await createOrGetProof(h.db,h.clock,actor,transaction.transactionId)).proofId;
  await commitFulfillmentAndAttest(h,actor,proofId);await finalizeProof(h.db,h.clock,actor,proofId);
  const captureSessionId=(await h.db.query<{id:string}>("SELECT id FROM capture_sessions WHERE proof_id=$1 AND state='COMMITTED'",[proofId])).rows[0].id;
  const rootBefore=(await h.db.query<{canonical_json:string;sha256:string}>('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1',[proofId])).rows[0];
  const deps:AppDependencies={...h,auth:new BearerUserAdapter(h.db),publicBaseUrl:'http://localhost',devAuth:true,surface:{...surfaceConfigFromEnv({}),collection:true,extraction:true,internalComparison:true,python,workerRoot,timeoutMs:30000}};
  const app=createServerApp({...deps,testFixtures:true}),endpoint=`/proofs/${proofId}/surfaces`,originals=new Map<string,Buffer>();
  async function upload(name:string){
   const sessionId=name==='enrollment'?captureSessionId:null;
   const bytes=await readFile(path.join(temporary!,`synthetic-${name}.png`)),sha256=sha256Hex(bytes);
   const initialized=await request(app).post(`${endpoint}/media`).set(auth(actor)).set('Idempotency-Key',`synthetic-${name}-media`).send({captureSessionId:sessionId,contentType:'image/png',byteSize:bytes.length,sha256});
   expect(initialized.status,JSON.stringify(initialized.body)).toBe(201);const sourceId=initialized.body.sourceId as string;
   const committed=await request(app).put(new URL(initialized.body.upload.url).pathname).set(auth(actor)).set('Content-Type','image/png').send(bytes);
   expect(committed.status,JSON.stringify(committed.body)).toBe(200);expect(committed.body.sha256).toBe(sha256);originals.set(sourceId,bytes);
   return {schemaVersion:'surface-command/1',captureSessionId:sessionId,shipmentLegId:'OUTBOUND',captureMode:'supplemental',contextStage:'unknown',captureProfileId:'synthetic-protocol-only',deviceMetadata:{fixture:'generated-PNG-protocol-only',regionHints:[{sourceId,barcodePolygon:[[350,250],[650,250],[650,400],[350,400]],printProcess:'unknown',association:'same_frame_expected_barcode'}]},continuityEvents:[],sources:[{sourceId,sha256,frameTimeMs:123.25}],regions:regions(sourceId)};
  }
  async function command(kind:'enrollment'|'observation'|'comparison',body:Record<string,unknown>){
   const intent=await request(app).post(`${endpoint}/intents`).set(auth(actor)).send({operation:kind,requestDigest:digest(body)});expect(intent.status,JSON.stringify(intent.body)).toBe(201);
   const result=await request(app).post(`${endpoint}/${kind}s`).set(auth(actor)).set('Idempotency-Key',`synthetic-${kind}`).send({...body,intentId:intent.body.intentId});expect(result.status,JSON.stringify(result.body)).toBe(202);
   expect(await dispatchSurfaceJobs(deps)).toMatchObject({status:'processed'}); // Real default Python subprocess, never a fake runner.
   return result.body.id as string;
  }
  const enrollmentId=await command('enrollment',await upload('enrollment'));
  const observationId=await command('observation',{...await upload('observation'),enrollmentId});
  const comparisonId=await command('comparison',{schemaVersion:'surface-command/1',enrollmentId,observationId,requestedScope:'assembly'});
  const summary=await request(app).get(endpoint).set(auth(actor));expect(summary.status).toBe(200);expect(summary.body.capabilities).toMatchObject({qualified:false,customerFindings:false});
  const comparison=summary.body.comparisons.find((value:{id:string})=>value.id===comparisonId);
  expect(comparison.result).toMatchObject({status:'inconclusive',qualification:'unqualified',privateArtifacts:'WITHHELD'});
  for(const scope of ['label','carton','assembly'])expect(comparison.result.scopeResults[scope].status).toBe('inconclusive');
  expect(JSON.stringify(summary.body)).not.toContain('researchResidualMedian');
  const analyses=(await h.db.query<{canonical_json:string;sha256:string;private_result_json:unknown}>('SELECT canonical_json,sha256,private_result_json FROM surface_analyses WHERE proof_id=$1',[proofId])).rows;expect(analyses).toHaveLength(3);
  const privateArtifacts:string[]=[];
  let computedSyntheticDescriptors=false;
  for(const analysis of analyses){
   const raw=typeof analysis.private_result_json==='string'?JSON.parse(analysis.private_result_json):analysis.private_result_json as any;
   expect(sha256Hex(analysis.canonical_json)).toBe(analysis.sha256);
   // Hash exact Python-emitted canonical bytes; do not reserialize floating point values in JS.
   expect(sha256Hex(raw.artifactCanonicalJson)).toBe(raw.artifactSha256);
   for(const template of Object.values(raw.templates).filter(Boolean) as any[]){expect(sha256Hex(template.canonicalJson)).toBe(template.artifactSha256);if(template.regions.some((region:any)=>region.descriptor))computedSyntheticDescriptors=true;expect(template.discovery).toHaveLength(1);expect(template.discovery[0].status).toBe('candidate_only');expect(template.regions.some((region:any)=>region.group==='carton'&&region.provenance==='label-relative-geometry-v1')).toBe(true);expect(template.regions.find((region:any)=>region.id==='context_0').rectification.nativeDimensions).toEqual([999,699]);}
   const privatePath=path.join(temporary,`private-result-${privateArtifacts.length}.json`);await writeFile(privatePath,JSON.stringify(raw));privateArtifacts.push(privatePath);
   for(const source of raw.sourceDigests)expect(sha256Hex(originals.get(source.sourceId)!)).toBe(source.sha256);
   expect(raw.method.dependencyLockSha256).toBe(sha256Hex(await readFile(path.join(workerRoot,'requirements.lock'))));
  }
  expect(computedSyntheticDescriptors).toBe(true);
  expect((await h.db.query('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1',[proofId])).rows[0]).toEqual(rootBefore);
  const head=(await h.db.query<{sha256:string}>('SELECT sha256 FROM surface_extensions WHERE proof_id=$1 ORDER BY sequence DESC LIMIT 1',[proofId])).rows[0].sha256;
  const exported=await request(app).get(`${endpoint}/export`).set(auth(actor));expect(exported.status,JSON.stringify(exported.body)).toBe(200);const document=exported.body;
  const mediaDir=path.join(temporary,'downloaded-originals');await mkdir(mediaDir);
  for(const source of document.sources){
   const delivered=await request(app).get(`${endpoint}/media/${source.sourceId}`).set(auth(actor)).buffer(true).parse((response,done)=>{
    const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('end',()=>done(null,Buffer.concat(chunks)));response.on('error',done);
   });
   expect(delivered.status).toBe(200);expect(Buffer.compare(delivered.body,originals.get(source.sourceId)!)).toBe(0);source.mediaPath=`${source.sourceId}.png`;await writeFile(path.join(mediaDir,source.mediaPath),delivered.body);
  }
  const exportFile=path.join(temporary,'synthetic-surface-export.json');await writeFile(exportFile,JSON.stringify(document));
  const verifier=path.join(repository,'verifier/surface-verify.py');
  const verification=await run(python,[verifier,exportFile,'--expected-proof-id',proofId,'--expected-root-sha256',rootBefore.sha256,'--expected-extension-head-sha256',head,'--media-dir',mediaDir],{timeout:10000});
  const report=JSON.parse(verification.stdout);
  expect(report).toMatchObject({status:'INTEGRITY_CHECKED',physicalAccuracy:'NOT_EVALUATED',sourceAcquisitionAssurance:'NOT_VERIFIED',recordsChecked:3,analysesChecked:3,sourceCommitmentsChecked:2,originalsChecked:2,completeOriginals:true,rootUnchangedAgainstIndependentDigest:true,extensionHeadMatchedIndependentDigest:true,allExtensionSignaturesVerified:false});
  expect(report.templateCommitmentsChecked).toBeGreaterThan(0);expect(report.templatesChecked).toBe(0);expect(report.omittedTemplateDigests.length).toBeGreaterThan(0);
  const privateVerification=await run(python,[verifier,exportFile,'--expected-root-sha256',rootBefore.sha256,'--expected-extension-head-sha256',head,'--media-dir',mediaDir,...privateArtifacts.flatMap(file=>['--private-artifact',file])],{timeout:10000});
  const privateReport=JSON.parse(privateVerification.stdout);expect(privateReport.status).toBe('INTEGRITY_CHECKED');expect(privateReport.templatesChecked).toBe(report.templateCommitmentsChecked);expect(privateReport.omittedTemplateDigests).toEqual([]);
  if(process.env.PACKPROOF_SURFACE_E2E_EXPORT)await writeFile(process.env.PACKPROOF_SURFACE_E2E_EXPORT,JSON.stringify(document,null,2));
  await writeFile(path.join(mediaDir,document.sources[0].mediaPath),Buffer.from('tampered synthetic original'));
  const tampered=spawnSync(python,[verifier,exportFile,'--expected-root-sha256',rootBefore.sha256,'--expected-extension-head-sha256',head,'--media-dir',mediaDir],{encoding:'utf8',timeout:10000});
  expect(tampered.status).toBe(1);expect(JSON.parse(tampered.stdout).status).toBe('INVALID_EXPORT');
 },90000);
});
