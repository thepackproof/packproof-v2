import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PackProofClient,PackProofError,retryAfterMs} from './client.mjs';
import {generate} from './generate.mjs';
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
const options=extra=>({apiOrigin:'https://api.example.test',credential:'test-only-credential',sleep:async()=>{},random:()=>0.5,...extra});
test('unknown outcomes replay the exact frozen key and bytes',async()=>{
 const attempts=[];const order={externalId:'synthetic-1001',transaction:{itemTitle:'Synthetic parcel'}};
 const client=new PackProofClient(options({fetch:async(url,init)=>{attempts.push({url:String(url),key:init.headers['Idempotency-Key'],body:init.body});if(attempts.length===1){order.transaction.itemTitle='Changed after send';throw new TypeError('Lost connection');}return json({proofId:'proof_one'});}}));
 assert.deepEqual(await client.request('legacy.post_proofs',{body:order,key:'persistent-operation-1001'}),{proofId:'proof_one'});
 assert.equal(attempts.length,2);assert.deepEqual(attempts[1],attempts[0]);assert.equal(JSON.parse(attempts[1].body).transaction.itemTitle,'Synthetic parcel');
});
test('commands without persistent keys fail before transport',async()=>{
 let calls=0;const c=new PackProofClient(options({fetch:async()=>{calls++;return json({});}}));
 await assert.rejects(c.request('legacy.post_proofs',{body:{}}),/Idempotency-Key/);assert.equal(calls,0);
});
test('Retry-After is honored and long waits return to the caller',async()=>{
 const delays=[];let calls=0;
 const c=new PackProofClient(options({sleep:async ms=>delays.push(ms),fetch:async()=>++calls===1?json({},429,{'Retry-After':'2'}):json({ok:true})}));
 assert.equal((await c.request('legacy.get_proofs')).ok,true);assert.deepEqual(delays,[2000]);
 calls=0;const blocked=new PackProofClient(options({fetch:async()=>{calls++;return json({error:{code:'RATE_LIMITED'}},429,{'Retry-After':'120','X-Request-Id':'req_test'});}}));
 await assert.rejects(blocked.request('legacy.get_proofs'),e=>e instanceof PackProofError&&e.status===429&&e.retryAfterMs===120000&&e.requestId==='req_test');
 assert.equal(calls,1);assert.equal(retryAfterMs('1.5'),null);assert.equal(retryAfterMs('Wed, 28 Oct 2026 12:00:03 GMT',Date.parse('2026-10-28T12:00:00Z')),3000);
});
test('non-idempotent snapshot allocation is never automatically retried',async()=>{
 let calls=0;const c=new PackProofClient(options({fetch:async()=>{calls++;throw new TypeError('Lost response');}}));
 await assert.rejects(c.request('partner.createProofSnapshot',{body:{pageSize:10}}),e=>e.code==='TRANSPORT_FAILURE'&&e.unknownOutcome===true);assert.equal(calls,1);
});
test('conflicts do not retry and both error envelopes retain codes',async()=>{
 for(const payload of [{code:'EXTERNAL_ID_CONFLICT'},{error:{code:'EXTERNAL_ID_CONFLICT'}}]){
  let calls=0;const c=new PackProofClient(options({fetch:async()=>{calls++;return json(payload,409);}}));
  await assert.rejects(c.request('legacy.post_proofs',{body:{},key:'same-key'}),e=>e.code==='EXTERNAL_ID_CONFLICT'&&e.status===409);assert.equal(calls,1);
 }
});
test('HTTPS origin and generated route retain merchant context without redirects',async()=>{
 assert.throws(()=>new PackProofClient(options({apiOrigin:'http://api.example.test'})),/HTTPS/);
 assert.throws(()=>new PackProofClient(options({apiOrigin:'https://api.example.test/other'})),/HTTPS/);
 const requests=[];const c=new PackProofClient(options({merchantId:'merchant_a',delegationId:'grant_a',fetch:async(url,init)=>{requests.push([url,init]);return json({});}}));
 await c.request('legacy.get_proofs_id',{path:{id:'proof/a?token=bad'}});
 assert.equal(requests[0][0].origin,'https://api.example.test');assert.equal(requests[0][0].pathname,'/v1/proofs/proof%2Fa%3Ftoken%3Dbad');
 assert.equal(requests[0][1].redirect,'error');assert.equal(requests[0][1].headers['PackProof-Merchant-Id'],'merchant_a');
 await assert.rejects(c.request('legacy.get_proofs',{query:{merchantId:'merchant_b'}}),/Unknown operation query/);
 await assert.rejects(c.request('legacy.get_proofs_id',{path:{id:'..'}}),/path parameter/);
});
test('caller cancellation stops retries and metadata is bounded',async()=>{
 const abort=new AbortController();abort.abort(new Error('Cancelled'));
 const c=new PackProofClient(options({fetch:async()=>{throw new Error('Must not send');}}));
 await assert.rejects(c.request('legacy.get_proofs',{signal:abort.signal}),/Cancelled/);
 const limited=new PackProofClient(options({maxResponseBytes:5,fetch:async()=>json({payload:'too large'})}));
 await assert.rejects(limited.request('legacy.get_proofs'),e=>e.code==='RESPONSE_TOO_LARGE');
});
test('package stream survives the cleared metadata deadline',async()=>{
 const c=new PackProofClient(options({timeoutMs:1,fetch:async()=>new Response(new Uint8Array([80,75]),{headers:{'Content-Type':'application/zip'}})}));
 const response=await c.request('legacy.get_proofs_id_package',{path:{id:'proof_test'}});
 await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[80,75]);
});
test('generated client stays byte-identical to source contracts',async()=>{
 const root=new URL('../../',import.meta.url);
 const legacy=JSON.parse(await readFile(new URL('backend/openapi.json',root),'utf8')),partner=JSON.parse(await readFile(new URL('backend/partner-openapi.json',root),'utf8'));
 for(const [path,content]of Object.entries(generate({legacy,partner})))assert.equal(await readFile(new URL(path,root),'utf8'),content,path);
 const {operations}=await import('./operations.mjs');
 assert.equal(Object.values(operations).some(x=>x.path.startsWith('/me/')),false);
 assert.equal(legacy.paths['/proofs'].post.parameters.some(x=>x.name==='after'),false);
 assert.equal(Object.values(operations).some(x=>x.method==='PUT'),false);
 function refs(value,spec){if(!value||typeof value!=='object')return;if(value.$ref){const target=value.$ref.split('/').slice(1).reduce((at,key)=>at?.[key],spec);assert.ok(target,'Unresolved '+value.$ref);}for(const child of Object.values(value))refs(child,spec);}
 refs(legacy,legacy);refs(partner,partner);
 for(const spec of [legacy,partner])for(const [path,item]of Object.entries(spec.paths))for(const [method,op]of Object.entries(item)){
  if(!op.operationId)continue;for(const response of Object.values(op.responses??{})){const schema=response.content?.['application/json']?.schema;assert.ok(!(schema?.type==='object'&&!schema.properties&&!schema.$ref),'Untyped success response '+method+' '+path);}
  for(const param of op.parameters??[])if(param.in==='path')assert.ok(path.includes('{'+param.name+'}'),method+' '+path+' stray path parameter');
 }
});
