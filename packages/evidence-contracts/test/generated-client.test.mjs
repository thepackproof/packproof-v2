import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { buildRndRequest,createRndClient,RndApiError,RND_OPERATIONS } from '../generated-client.mjs';

const root=new URL('../../../',import.meta.url);
const spec=JSON.parse(readFileSync(new URL('backend/rnd-openapi.json',root)));
test('generated client is reproducible and covers the actual mounted router methods',async()=>{
 process.argv.push('--check');
 try {await import('../../../scripts/generate-rnd-client.mjs');} finally {process.argv.pop();}
 assert.equal(process.exitCode??0,0);
 const expected=[];
 for(const name of readdirSync(new URL('backend/src/rnd/',root)).filter(n=>n.endsWith('.ts'))){
  const text=readFileSync(new URL('backend/src/rnd/'+name,root),'utf8');
  const base=text.match(/(?:const |,)base\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const prefix=['learning-registry.ts','operations.ts'].includes(name)?'/admin':'';
  for(const route of text.matchAll(/router\.(get|post|put|patch|delete)\((['"`])([^'"`]+)\2/g)){
   const pathname=route[3].replace('${base}',base??'MISSING_BASE').replace(/:([A-Za-z]+)/g,'{$1}');
   expected.push(route[1].toUpperCase()+' '+prefix+pathname);
  }
  // Bare base routes are separate from suffix template routes.
  for(const route of text.matchAll(/router\.(get|post|put|patch|delete)\(base,/g))expected.push(route[1].toUpperCase()+' '+prefix+base.replace(/:([A-Za-z]+)/g,'{$1}'));
 }
 const actual=Object.entries(spec.paths).flatMap(([path,methods])=>Object.keys(methods).map(method=>method.toUpperCase()+' '+path));
 assert.deepEqual(actual.sort(),expected.sort());
 assert.equal(RND_OPERATIONS.length,33);
 const app=readFileSync(new URL('backend/src/app.ts',root),'utf8');
 for(const router of ['rndRouter','rndDerivativeGrantRouter','rndDerivativeGrantPublicRouter'])assert.match(app,new RegExp('app\\.use\\('+router+'\\(deps\\)\\)'));
});

test('pure builder encodes exact path, query, body and idempotency without credentials',()=>{
 const body={feature:'proofpilot',evidenceIds:['ev_1'],parameters:{samplingHz:2}};
 const input={path:{id:'proof/a'},body,idempotencyKey:'request-1'};
 const built=buildRndRequest('requestAnalysis',input);
 assert.deepEqual(built,{path:'/proofs/proof%2Fa/rnd/analyses',method:'POST',body,headers:{Accept:'application/json','Idempotency-Key':'request-1','Content-Type':'application/json'}});
 assert.equal(built.body,body);
 assert.equal(buildRndRequest('listExtensions',{path:{id:'p'},query:{after:17}}).path,'/proofs/p/rnd/extensions?after=17');
 assert.equal(buildRndRequest('getAnalysisArtifact',{path:{id:'p',analysisId:'a',index:0}}).method,'GET');
 assert.throws(()=>buildRndRequest('constructor',{}),/Unknown/);
 assert.throws(()=>buildRndRequest('requestAnalysis',{path:{id:'p'},body}),/Idempotency/);
 assert.throws(()=>buildRndRequest('listAnalyses',{path:{id:'..'}}),/Invalid/);
 assert.throws(()=>buildRndRequest('listAnalyses',{path:{id:'p'},query:{token:'no'}}),/Unexpected query/);
 assert.throws(()=>buildRndRequest('listExtensions',{path:{id:'p'},query:{after:-1}}),/Invalid/);
 assert.throws(()=>buildRndRequest('getCapabilities',{body:{}}),/does not accept/);
});

test('fetch adapter preserves provided auth and abort, forbids redirects, and handles binary grants',async()=>{
 const calls=[],signal=new AbortController().signal;
 const fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({enabled:false}),{status:200,headers:{'Content-Type':'application/json'}});};
 const client=createRndClient({baseUrl:'https://api.example.test/',fetch,headers:()=>({'Authorization':'Bearer test-session'})});
 assert.deepEqual(await client.getCapabilities({signal}),{enabled:false});
 assert.equal(calls[0].url,'https://api.example.test/rnd/capabilities');
 assert.equal(calls[0].init.headers.get('Authorization'),'Bearer test-session');
 assert.equal(calls[0].init.signal,signal);
 assert.equal(calls[0].init.redirect,'error');
 assert.equal(calls[0].init.cache,'no-store');
 assert.equal(calls[0].init.credentials,undefined);
 const redeem=createRndClient({fetch:async(url,init)=>{
  assert.equal(url,'/rnd/derivative-grants/redeem');
  assert.equal(init.headers.has('Authorization'),false);
  assert.deepEqual(JSON.parse(init.body),{token:'rndg_'+'a'.repeat(43)});
  return new Response(new Uint8Array([80,75,3,4]));
 }});
 assert.deepEqual(new Uint8Array(await redeem.redeemDerivativeGrant({body:{token:'rndg_'+'a'.repeat(43)}})),new Uint8Array([80,75,3,4]));
});

test('server errors retain stable codes without retrying or logging request material',async()=>{
 let calls=0;
 const client=createRndClient({fetch:async()=>{calls++;return new Response(JSON.stringify({error:{code:'RND_DISABLED',message:'Disabled'}}),{status:404});}});
 await assert.rejects(client.getCapabilities({}),error=>error instanceof RndApiError&&error.status===404&&error.code==='RND_DISABLED');
 assert.equal(calls,1);
});

test('schema request keys track server onlyKeys and exclude server policy inputs',()=>{
 const resolved=s=>s.$ref?resolved(spec.components.schemas[s.$ref.split('/').at(-1)]):s;
 const source=readFileSync(new URL('backend/src/rnd/analyses.ts',root),'utf8');
 const allowed=Object.fromEntries([...source.matchAll(/(proof\w+|verifiedcapture):\[([^\]]*)\]/g)].map(m=>[m[1],[...m[2].matchAll(/'([^']+)'/g)].map(x=>x[1])]));
 for(const request of spec.components.schemas.AnalysisRequest.oneOf){
  const feature=request.properties.feature.const,params=resolved(request.properties.parameters);
  const shapes=params.oneOf??[params];
  const keys=[...new Set(shapes.flatMap(s=>Object.keys(s.properties)))];
  assert.deepEqual(keys.sort(),allowed[feature].sort(),feature);
  for(const shape of shapes)assert.equal(shape.additionalProperties,false);
 }
 const mapping={ConsentInput:['capture.ts','recordConsent'],IssueIntentInput:['capture.ts','issueIntent'],StartIntentInput:['capture.ts','startIntent'],CloseIntentInput:['capture.ts','closeIntent'],LiveChallengeInput:['capture.ts','issueLiveChallenge'],EnrollmentInput:['enrollment.ts','createEnrollment'],AnnotationInput:['annotations.ts','addAnnotation'],DerivativeReviewInput:['exports.ts','reviewDerivative'],DerivativeGrantInput:['derivative-grants.ts','createDerivativeGrant'],RedeemInput:['derivative-grants.ts','redeemDerivativeGrant'],RetryInput:['operations.ts','retryResearchAnalysis'],LearningImportInput:['learning-registry.ts','validateLearningCandidate'],SidecarChunkInput:['capture-sidecars.ts','validateSidecarChunk']};
 for(const [schema,[file,fn]] of Object.entries(mapping)){
  const source=readFileSync(new URL('backend/src/rnd/'+file,root),'utf8').split('function '+fn+'(')[1];
  const keys=[...source.match(/onlyKeys\(input,\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map(x=>x[1]);
  assert.deepEqual(Object.keys(spec.components.schemas[schema].properties).sort(),keys.sort(),schema);
  assert.equal(spec.components.schemas[schema].additionalProperties,false);
 }
});
