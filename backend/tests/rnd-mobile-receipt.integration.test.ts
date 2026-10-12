import { afterAll,beforeAll,expect,it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { createHash,generateKeyPairSync,sign,verify } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { canonicalize } from '../../packages/evidence-contracts/contracts.mjs';
import { rndRouter } from '../src/rnd/router.js';
import { rndConfigFromEnv } from '../src/rnd/config.js';
import { createHarness,createUser,commitProofEvidence,type TestHarness } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { createCaptureSession } from '../src/domain/capture-sessions.js';
import { commitAttestation } from '../src/domain/attestations.js';
import { finalizeProof } from '../src/domain/finalize.js';
import type { ManifestSigningRuntime } from '../src/integrity/signing-runtime.js';

// Execute shipped coordinator/policy/review code without importing the native UI
// runtime. Only native I/O, HTTP transport, and the SHA implementation are adapted.
// Real synthetic P-256 signatures and the real backend protocol remain in use.
function loadMobile(file:string,modules:Record<string,unknown>={}) {
 const source=readFileSync(new URL('../../mobile/src/research/'+file,import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const loaded={exports:{} as any};
 new Function('require','module','exports',compiled)((id:string)=>{if(!(id in modules))throw Error('Unexpected mobile dependency: '+id);return modules[id];},loaded,loaded.exports);
 return loaded.exports;
}
const policy=loadMobile('production-policy.ts');
const review=loadMobile('receipt-review.ts',{'../../../packages/evidence-contracts/contracts.mjs':{canonicalize},'@noble/hashes/sha256':{sha256:(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest()},'@noble/hashes/utils':{bytesToHex:(bytes:Uint8Array)=>Buffer.from(bytes).toString('hex')}});
let h:TestHarness,actor:string;
const now=new Date('2026-10-12T12:00:00Z'),server=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),device=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const serverPem=server.publicKey.export({type:'spki',format:'pem'}).toString(),deviceSpki=device.publicKey.export({type:'spki',format:'der'}).toString('base64');
const signing:ManifestSigningRuntime={publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'synthetic-server-key',required:true,trustListSha256:null},signer:{async signManifest(input){return {algorithm:'ECDSA_SHA_256',keyId:'synthetic-server-key',signedAt:now.toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),server.privateKey).toString('base64')};}}};
beforeAll(async()=>{h=await createHarness({now:()=>now},{manifestSigning:signing});actor=await createUser(h);},30_000);
afterAll(async()=>h?.close());

it('accepts the actual mobile final-file payload and returns the exact authorized signed receipt and metadata export',async()=>{
 const transaction=await createTransaction(h.db,h.clock,actor,{itemTitle:'Synthetic mobile/backend protocol fixture'}),{proofId}=await createOrGetProof(h.db,h.clock,actor,transaction.transactionId);
 const deps={...h,manifestSigning:signing,rnd:rndConfigFromEnv({PACKPROOF_RND_PROFILE:'capture-receipts-v1',PACKPROOF_RND_ENABLED:'1',PACKPROOF_RND_KILL_SWITCH:'0'})};
 const app=express();app.use(express.json());app.use((r,_s,n)=>{r.packproofUserId=actor;n();});app.use(rndRouter(deps));app.use((error:any,_r:express.Request,s:express.Response,_n:express.NextFunction)=>s.status(error.httpStatus??500).json({error:{code:error.code,message:error.message}}));
 const calls:string[]=[];let key=0,binding:any,committed:{sha256:string;byte_size:string},active=true;
 async function send(path:string,method='GET',body?:unknown,idempotency?:string) {
  calls.push(method+' '+path);const operation=request(app)[method.toLowerCase() as 'get'](path);
  if(idempotency)operation.set('Idempotency-Key',idempotency);if(body!==undefined)operation.send(body);
  const result=await operation;if(result.status>=400)throw Object.assign(Error(result.body.error.message),{code:result.body.error.code});return result.body;
 }
 const client={apiBaseUrl:'https://synthetic-api.example.test',assertCaptureAccount(userId:string,origin:string){if(!active||userId!==actor||origin!==this.apiBaseUrl)throw Error('ACCOUNT_CHANGED');},researchCapabilities:()=>send('/rnd/capabilities'),researchRequest:(id:string,path:string,method?:string,body?:unknown,idempotency?:string)=>send(`/proofs/${encodeURIComponent(id)}/rnd${path}`,method,body,idempotency)};
 const native={async prepareResearchKey(scope:string){expect(scope).toBe(client.apiBaseUrl+'|'+actor);return {publicKeySpki:deviceSpki,keyProtection:'UNVERIFIED',algorithm:'ES256_DER',appAttestation:'NOT_CHECKED'};},async bindResearchCapture(session:string,proof:string,value:string){binding=JSON.parse(value);expect(binding.captureSessionId).toBe(session);expect(binding.proofId).toBe(proof);},async readResearchCapture(){return JSON.stringify({captureSessionId:binding.captureSessionId,binding,mediaSha256:committed.sha256,mediaByteLength:Number(committed.byte_size),journalSha256:null,acquisitionSha256:null});},async signResearchCapture(session:string,scope:string,value:string){expect(session).toBe(binding.captureSessionId);expect(scope).toBe(binding.keyScope);return {signature:sign('sha256',Buffer.from(value),device.privateKey).toString('base64'),publicKeySpki:deviceSpki,algorithm:'ES256_DER'};}};
 const forbidden=async()=>{throw Error('Advanced research must not run');};
 const coordinator=loadMobile('capture.ts',{'./production-policy':policy,'./receipt-review':review,'./sidecars':{uploadNativeSidecars:forbidden},'./platform-assurance':{collectPlatformAssurance:forbidden,collectAndroidKeyAssurance:forbidden},'../../../packages/evidence-contracts/contracts.mjs':{canonicalize},'./native':{nativeResearch:()=>native},'./isolation':{researchEnabled:()=>true,researchProductionEnabled:()=>true,assertResearchApiEndpoint:(value:string)=>expect(value).toBe(client.apiBaseUrl)},'../v2-api':{newIdempotencyKey:()=>`mobile-${++key}`}});
 expect(await coordinator.prepareResearchSession(client,{proofId,userId:actor})).toBeUndefined();
 await client.researchRequest(proofId,'/consents','POST',{purpose:'EXPERIMENTAL_ANALYSIS',version:policy.RECEIPT_CONSENT_VERSION,granted:true},'consent');
 const prepared=await coordinator.prepareResearchSession(client,{proofId,userId:actor});expect(prepared).toBeDefined();
 const session=await createCaptureSession(h.db,h.clock,actor,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'mobile-fixture'});
 const research=await coordinator.bindResearchSession(client,{proofId,userId:actor,captureSessionId:session.id},prepared);expect(research?.state).toBe('BOUND');
 expect(binding).toMatchObject({collectionMode:'FINAL_FILE_RECEIPT',samplingEnabled:false,passiveChallenge:null});
 const evidence=await commitProofEvidence(h,actor,proofId,{evidenceType:'FULFILLMENT_CAPTURE',idempotencyKey:'mobile-fixture'});
 committed=(await h.db.query<{sha256:string;byte_size:string}>('SELECT sha256,byte_size FROM evidence WHERE id=$1',[evidence.evidenceId])).rows[0];
 const capture={uri:'synthetic-native-original.mp4',captureProofId:proofId,captureUserId:actor,captureSessionId:session.id,research};let saves=0;
 await coordinator.closeResearchSession(client,capture,evidence.evidenceId,async()=>{saves++;});
 expect(research.state).toBe('RECEIVED');expect(saves).toBeGreaterThan(0);expect(capture.uri).toBe('synthetic-native-original.mp4');
 expect(verify('sha256',Buffer.from(research.signed.canonicalJson),device.publicKey,Buffer.from(research.signed.signature,'base64'))).toBe(true);
 const received=review.checkedReceiptReview(await client.researchRequest(proofId,'/capture-receipts'),proofId).captureReceipts[0];
 expect(received.receipt.sources[0]).toMatchObject({evidenceId:evidence.evidenceId,sha256:committed.sha256,byteLength:Number(committed.byte_size)});
 expect(received.receipt.assurance).toMatchObject({signatureVerification:'BOUND_CLIENT_AND_SERVER_SIGNATURES',sensorAttestation:'UNSUPPORTED'});
 expect(verify('sha256',Buffer.from(received.canonicalJson),serverPem,Buffer.from(received.signature.signatureBase64,'base64'))).toBe(true);
 await commitAttestation(h.db,h.clock,actor,proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:evidence.evidenceId});await finalizeProof(h.db,h.clock,actor,proofId,signing.signer);
 const bundle=await client.researchRequest(proofId,'/exports','POST');expect(bundle.mode).toBe('METADATA_ONLY');expect(bundle.captureReceipts[0].digest).toBe(received.digest);expect(bundle.sources[0].evidenceId).toBe(evidence.evidenceId);
 expect(calls.some(value=>/sidecars|platform|analyses|live-challenges/.test(value))).toBe(false);
 active=false;expect(await coordinator.prepareResearchSession(client,{proofId,userId:actor}).catch(()=>undefined)).toBeUndefined();
},30_000);
