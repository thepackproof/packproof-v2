import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {CaptureHostClient,verifyCaptureReceipt,verifyCaptureCompletionReceipt} from './server.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
test('host key stays on the server and launch URL has only the opaque token',async()=>{
 let sent;const token='intent_one.'+'A'.repeat(43);const client=new CaptureHostClient({apiBaseUrl:'https://api.example.test',siteOrigin:'https://packproof.example.test',apiKey:'server-secret',fetch:async(url,options)=>{sent={url,options};return {ok:true,json:async()=>({schema:'packproof.capture/1',intentId:'intent_one',launchToken:token,expiresAt:'later'})};}});
 const result=await client.createIntent('proof_one',{idempotencyKey:'order-1'});assert.equal(new URL(result.launchUrl).search,'');assert.equal(sent.options.headers.Authorization,'Bearer server-secret');assert(!result.launchUrl.includes('server-secret'));assert(!result.launchUrl.includes('proof_one'));
});
test('receipt verifier rejects unsigned, changed and cross-Proof completions',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const capture={context:{captureId:'cap_one',proofId:'proof_one'}};const root=hash('packproof:manifest:1\n'+JSON.stringify(capture));
 const canonicalJson=JSON.stringify({proofId:'proof_one',captureManifests:[{captureId:'cap_one',sha256:root,manifest:capture}]});
 const receipt={schema:'packproof.capture-receipt/1',proofId:'proof_one',captureId:'cap_one',state:'FINALIZED',manifestSha256:root,proofManifest:{proofId:'proof_one',canonicalJson,sha256:hash(canonicalJson),signature:{algorithm:'ECDSA_SHA_256',keyId:'trusted',signatureBase64:sign('sha256',Buffer.from(canonicalJson),privateKey).toString('base64')}}};
 const expected={proofId:'proof_one',captureId:'cap_one',trustedKeys:{trusted:publicKey}};
 assert(verifyCaptureReceipt(receipt,expected));assert(!verifyCaptureReceipt({...receipt,manifestSha256:'b'.repeat(64)},expected));assert(!verifyCaptureReceipt({...receipt,state:'COMMITTED'},expected));assert(!verifyCaptureReceipt(receipt,{...expected,proofId:'another'}));assert(!verifyCaptureReceipt(receipt,{...expected,trustedKeys:{}}));
});

function completionFixture(curve='prime256v1'){
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:curve});
 const expected={intentId:'intent_one',captureId:'cap_one',proofId:'proof_one',actorId:'user_one',transactionId:'txn_one',
  transactionDigest:'a'.repeat(64),contextSha256:'b'.repeat(64),captureManifestSha256:'c'.repeat(64),evidenceId:'evd_one',
  sourceSha256:'d'.repeat(64),finalManifestId:'man_one',finalManifestSha256:'e'.repeat(64),
  audience:'packproof:capture-intent:intent_one',returnTarget:'/proofs/proof_one'};
 const payload={...expected,schema:'packproof.capture-completion/1',receiptId:'ccr_one',state:'FINALIZED',issuedAt:'2026-09-10T12:00:00.000Z'};
 const canonicalJson=JSON.stringify(payload,Object.keys(payload).sort());
 const trustedKey={keyId:'pinned',algorithm:'ECDSA_SHA_256',status:'ACTIVE',publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString()};
 const receipt={payload,canonicalJson,sha256:hash(canonicalJson),signature:{algorithm:'ECDSA_SHA_256',keyId:'pinned',signedAt:payload.issuedAt,
  signatureBase64:sign('sha256',Buffer.from(canonicalJson),privateKey).toString('base64')}};
 return {expected,trustedKey,receipt};
}
test('signed host completion rejects context replays, changed digests, revoked keys and unsupported curves',()=>{
 const {expected,trustedKey,receipt}=completionFixture();
 assert(verifyCaptureCompletionReceipt(receipt,expected,trustedKey));
 for(const key of Object.keys(expected))assert(!verifyCaptureCompletionReceipt(receipt,{...expected,[key]:expected[key]+'x'},trustedKey),key);
 assert(!verifyCaptureCompletionReceipt({...receipt,sha256:'f'.repeat(64)},expected,trustedKey));
 assert(!verifyCaptureCompletionReceipt({...receipt,payload:{...receipt.payload,sourceSha256:'f'.repeat(64)}},expected,trustedKey));
 assert(!verifyCaptureCompletionReceipt({...receipt,signature:{...receipt.signature,keyId:'receipt-chosen-key'}},expected,trustedKey));
 assert(!verifyCaptureCompletionReceipt(receipt,expected,{...trustedKey,status:'REVOKED'}));
 assert(!verifyCaptureCompletionReceipt(receipt,expected,{...trustedKey,publicKeyPem:''}));
 const p384=completionFixture('secp384r1');
 assert(!verifyCaptureCompletionReceipt(p384.receipt,p384.expected,p384.trustedKey));
});
test('host completion helpers retain the API key server-side and verify issuance and polling',async()=>{
 const {expected,trustedKey,receipt}=completionFixture();const calls=[];
 const client=new CaptureHostClient({apiBaseUrl:'https://api.example.test',siteOrigin:'https://packproof.example.test',apiKey:'server-secret',
  fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>receipt};}});
 const options={expectedContext:expected,trustedKey,idempotencyKey:'completion-one'};
 assert.deepEqual(await client.issueCompletionReceipt('proof_one','cap_one',options),receipt);
 assert.deepEqual(await client.readCompletionReceipt('proof_one','cap_one',options),receipt);
 assert.equal(calls[0].url.pathname,'/v1/proofs/proof_one/capture-sessions/cap_one/completion-receipt');
 assert.equal(calls[0].url.search,'');assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.body,'{}');
 assert.equal(calls[0].options.headers['Idempotency-Key'],'completion-one');assert.equal(calls[0].options.headers.Authorization,'Bearer server-secret');
 assert.equal(calls[0].options.redirect,'error');assert.equal(calls[1].options.method,'GET');assert.equal(calls[1].options.body,undefined);
 await assert.rejects(client.issueCompletionReceipt('proof_one','cap_one',{expectedContext:expected,trustedKey}),/idempotency/);
 await assert.rejects(client.readCompletionReceipt('proof_two','cap_one',options),/expected capture context/);
 await assert.rejects(client.readCompletionReceipt('proof_one','cap_one',{...options,expectedContext:{...expected,intentId:'intent_other'}}),/did not match/);
});
test('host completion polling treats pending and unsigned responses as incomplete',async()=>{
 const {expected,trustedKey,receipt}=completionFixture();let pending=true;
 const client=new CaptureHostClient({apiBaseUrl:'https://api.example.test',siteOrigin:'https://packproof.example.test',apiKey:'server-secret',
  fetch:async()=>pending?{ok:false,status:409}:{ok:true,json:async()=>({...receipt,signature:null})}});
 const options={expectedContext:expected,trustedKey};
 await assert.rejects(client.readCompletionReceipt('proof_one','cap_one',options),/409/);pending=false;
 await assert.rejects(client.readCompletionReceipt('proof_one','cap_one',options),/did not match/);
});
