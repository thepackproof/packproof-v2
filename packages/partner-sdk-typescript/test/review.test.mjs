import assert from 'node:assert/strict';
import test from 'node:test';
import {PackProofClient} from '../index.mjs';
test('keeps an ambiguous exact reference unresolved and encodes source reference bytes',async()=>{
 let requested;const client=new PackProofClient({baseUrl:'https://api.example.test',token:'fixture',fetch:async(url)=>{requested=url;return Response.json({reference:'000 45/#',outcome:'ambiguous',matches:[{id:'a'},{id:'b'}],automaticMatch:null,hasMore:false});}});
 const result=await client.matchEntityReference('proof-a','000 45/#');
 assert.equal(new URL(requested).searchParams.get('reference'),'000 45/#');assert.equal(result.data.automaticMatch,null);
});
test('routes review with explicit revision and stable idempotency without changing evidence',async()=>{
 let request;const client=new PackProofClient({baseUrl:'https://api.example.test',token:'fixture',fetch:async(url,options)=>{request={url,options};return Response.json({id:'assignment',proofId:'proof-a',revision:5});}});
 await client.assignIssue('issue-a',{membershipId:'member-a',reason:'Review source conflict'},{revision:4,idempotencyKey:'assign-one'});
 assert.equal(request.options.headers.get('If-Match'),'"4"');assert.equal(request.options.headers.get('Idempotency-Key'),'assign-one');
 assert.deepEqual(JSON.parse(request.options.body),{membershipId:'member-a',reason:'Review source conflict'});
 assert.match(request.url,/\/issues\/issue-a\/assignment$/);
});
