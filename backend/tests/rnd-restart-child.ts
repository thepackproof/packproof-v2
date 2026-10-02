// Separate process fixture: the first worker exits with a durable, unfinished lease.
import { generateKeyPairSync,createPrivateKey,createPublicKey,sign } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPgliteDatabase } from '../src/db/pglite.js';
import { LocalObjectStore } from '../src/s3/local-object-store.js';
import { createHarness,createUser,commitFulfillmentAndAttest } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { enabledResearchConfig } from '../src/rnd/config.js';
import { recordConsent } from '../src/rnd/capture.js';
import { leaseAnalysis,requestAnalysis,runRndWorkerOnce } from '../src/rnd/analyses.js';
import type { ManifestSigningRuntime } from '../src/integrity/signing-runtime.js';

const keepAlive=setInterval(()=>{},1000);
const [phase,directory]=process.argv.slice(2);await mkdir(directory,{recursive:true});
const keyFile=path.join(directory,'research.pem');
if(phase==='seed'){const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'});await writeFile(keyFile,key.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});}
const privateKey=createPrivateKey(await readFile(keyFile));
const clock={now:()=>new Date(phase==='seed'?'2026-10-02T10:00:00Z':'2026-10-02T10:02:00Z')};
const signing:ManifestSigningRuntime={publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'research-restart',required:true,trustListSha256:null},trustList:{schema:'packproof.trust-list.v1',generatedAt:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z',keys:[{keyId:'research-restart',algorithm:'ECDSA_SHA_256',status:'ACTIVE',publicKeyPem:createPublicKey(privateKey).export({type:'spki',format:'pem'}).toString()}]},signer:{async signManifest(i){return {algorithm:'ECDSA_SHA_256',keyId:'research-restart',signedAt:clock.now().toISOString(),signatureBase64:sign('sha256',Buffer.from(i.canonicalJson),privateKey).toString('base64')};}}};
const opened=await createPgliteDatabase(path.join(directory,'database'));
const store=new LocalObjectStore(path.join(directory,'objects'),'http://127.0.0.1','restart-only-upload-secret');
const harness=await createHarness(clock,{opened,objectStore:store,manifestSigning:signing});
const deps={...harness,rnd:enabledResearchConfig(),manifestSigning:signing};
if(phase==='seed'){
 const seller=await createUser(harness),txn=await createTransaction(opened.db,clock,seller,{itemTitle:'Process restart fixture'}),proof=await createOrGetProof(opened.db,clock,seller,txn.transactionId);
 await recordConsent(deps,seller,proof.proofId,'consent',{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:true});
 const e=await commitFulfillmentAndAttest(harness,seller,proof.proofId);await finalizeProof(opened.db,clock,seller,proof.proofId,signing.signer);
 const job=await requestAnalysis(deps,seller,proof.proofId,'job',{feature:'verifiedcapture',evidenceIds:[e.evidenceId]});
 const leased=await leaseAnalysis(deps);if(leased?.id!==job.analysisId)throw new Error('Failed to persist initial worker lease');
 await writeFile(path.join(directory,'state.json'),JSON.stringify({proofId:proof.proofId,analysisId:job.analysisId,leaseToken:leased.lease_token}),{mode:0o600});
 await opened.close();await harness.close();process.stdout.write(JSON.stringify({state:'LEASED_PROCESS_EXITED',analysisId:job.analysisId}));
}else{
 const state=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));
 const initial=(await opened.db.query<{operational_state:string;lease_token:string}>('SELECT operational_state,lease_token FROM rnd_analyses WHERE id=$1',[state.analysisId])).rows[0];
 if(initial.operational_state!=='RUNNING'||initial.lease_token!==state.leaseToken)throw new Error('Worker lease was not durable across process exit');
 const result=await runRndWorkerOnce(deps);
 const rows=(await opened.db.query<{attempts:number;operational_state:string}>('SELECT attempts,operational_state FROM rnd_analyses WHERE id=$1',[state.analysisId])).rows;
 const extensions=(await opened.db.query<{n:string}>('SELECT count(*) AS n FROM rnd_extensions WHERE analysis_id=$1',[state.analysisId])).rows;
 await writeFile(path.join(directory,'recovered.json'),JSON.stringify({result,attempts:rows[0].attempts,state:rows[0].operational_state,extensions:Number(extensions[0].n)}),{mode:0o600});
 await opened.close();await harness.close();process.stdout.write(JSON.stringify({result,attempts:rows[0].attempts,state:rows[0].operational_state,extensions:Number(extensions[0].n)}));
}
clearInterval(keepAlive);
