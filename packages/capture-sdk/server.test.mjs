import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {CaptureHostClient,verifyCaptureReceipt} from './server.mjs';
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
