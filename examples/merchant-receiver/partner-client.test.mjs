import test from 'node:test';
import assert from 'node:assert/strict';
import {PartnerClient} from './partner-client.mjs';
const config={apiOrigin:'https://api.example.com',siteOrigin:'https://app.example.com',credential:'pp_org_sandbox_test',merchantId:'merchant-a',delegationId:'grant-a'};
test('server adapter binds selectors, preserves operation keys and uses fragment capture delivery',async()=>{
 const calls=[];const client=new PartnerClient({...config,fetch:async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify(url.pathname.endsWith('capture-intents')?{intentId:'intent_demo',proofId:'proof-a',requiresAuthenticatedAttestation:true,launchToken:`intent_demo.${'a'.repeat(43)}`,expiresAt:'2026-10-20T15:00:00Z'}:{proofId:'proof-a'}),{status:201});}});
 await client.importOrder({externalId:'order-1'},'persisted-key');const capture=await client.capture('proof-a','capture-key');
 assert.equal(calls[0].init.headers['PackProof-Merchant-Id'],'merchant-a');assert.equal(calls[0].init.headers['PackProof-Delegation-Id'],'grant-a');assert.equal(calls[0].init.headers['Idempotency-Key'],'persisted-key');assert.equal(calls[0].init.redirect,'error');
 assert.equal(new URL(capture.launchUrl).search,'');assert.ok(new URL(capture.launchUrl).hash.startsWith('#intent='));assert.ok(!capture.launchUrl.includes(config.credential));
});
test('ambiguous transport does not retry with a new key',async()=>{
 let calls=0;const client=new PartnerClient({...config,fetch:async()=>{calls++;throw new Error('timeout');}});
 await assert.rejects(client.importOrder({},'same-key'),e=>e.unknownOutcome===true);assert.equal(calls,1);
 assert.throws(()=>new PartnerClient({...config,environment:'live'}),/environment/);
});
