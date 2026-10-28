import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMeasurementConfig,percentile,runMeasurement,measurementExitCode} from './measure.mjs';

const sha='a'.repeat(40);
const environment=()=>({PACKPROOF_API_ORIGIN:'https://api.example.test',PACKPROOF_API_KEY:'measurement_test_secret',
 PACKPROOF_EXPECTED_SHA:sha});
const meta=()=>new Response(JSON.stringify({service:'packproof-api',environment:'isolated-test',version:'0.1.0',commit:sha}),{
 status:200,headers:{'content-type':'application/json'}});
test('configuration enforces HTTPS origin, credential isolation, and globally bounded pacing',()=>{
 const config=parseMeasurementConfig(environment());
 assert.equal(config.requests,30);assert.equal(config.concurrency,1);
 assert.equal(config.intervalMs,600);assert.equal(config.timeoutMs,15000);
 assert.equal(config.path,'/v1/proofs/search?limit=10');
 for(const origin of ['http://api.example.test','https://user:password@api.example.test','https://api.example.test/v1','https://api.example.test?key=hidden','https://api.example.test/#hidden'])
  assert.throws(()=>parseMeasurementConfig({...environment(),PACKPROOF_API_ORIGIN:origin}));
 for(const [name,value] of [['PACKPROOF_MEASURE_REQUESTS','1001'],['PACKPROOF_MEASURE_REQUESTS','0'],
  ['PACKPROOF_MEASURE_CONCURRENCY','9'],['PACKPROOF_MEASURE_INTERVAL_MS','499'],
  ['PACKPROOF_MEASURE_AGREED_RPM','121'],['PACKPROOF_MEASURE_REQUESTS','NaN']])
  assert.throws(()=>parseMeasurementConfig({...environment(),[name]:value}));
 assert.throws(()=>parseMeasurementConfig({...environment(),PACKPROOF_MEASURE_CONCURRENCY:'2'}));
 assert.throws(()=>parseMeasurementConfig({...environment(),PACKPROOF_MEASURE_CONCURRENCY:'2',PACKPROOF_MEASURE_ALLOW_CONCURRENCY:'true'}));
 const concurrent=parseMeasurementConfig({...environment(),PACKPROOF_MEASURE_CONCURRENCY:'8',
  PACKPROOF_MEASURE_ALLOW_CONCURRENCY:'true',PACKPROOF_MEASURE_AGREED_RPM:'60',PACKPROOF_MEASURE_INTERVAL_MS:'500'});
 assert.equal(concurrent.intervalMs,1000);
 assert.throws(()=>parseMeasurementConfig({...environment(),PACKPROOF_API_KEY:'secret\nInjected: header'}));
});
test('partner selectors remain headers and a supplied Proof ID cannot choose another path',()=>{
 const config=parseMeasurementConfig({...environment(),PACKPROOF_API_PROFILE:'partner',PACKPROOF_MERCHANT_ID:'org_merchant',
  PACKPROOF_DELEGATION_ID:'grant_partner',PACKPROOF_MEASURE_PROOF_ID:'proof_selected'});
 assert.equal(config.path,'/v1/partner/proofs/proof_selected');
 assert.equal(config.origin,'https://api.example.test');
 assert.throws(()=>parseMeasurementConfig({...environment(),PACKPROOF_API_PROFILE:'partner'}));
 assert.throws(()=>parseMeasurementConfig({...environment(),PACKPROOF_MEASURE_PROOF_ID:'../other?credential=hidden'}));
 assert.throws(()=>parseMeasurementConfig({...environment(),PACKPROOF_MEASURE_PROOF_ID:environment().PACKPROOF_API_KEY}));
});
test('percentiles use nearest rank without mutating input or claiming empty observations',()=>{
 const values=[500,10,30,20];assert.equal(percentile(values,50),20);
 assert.equal(percentile(values,95),500);assert.equal(percentile(values,99),500);
 assert.equal(percentile([],95),null);assert.deepEqual(values,[500,10,30,20]);
 for(const sample of [[NaN],[Infinity],[-1]])assert.throws(()=>percentile(sample,95));
 assert.throws(()=>percentile([1],NaN));
});
test('measurement is read only, paced, candidate bound, aggregated, and redacts server credentials',async()=>{
 let time=0,index=0;const starts=[],calls=[];
 const config=parseMeasurementConfig({...environment(),PACKPROOF_MEASURE_REQUESTS:'3',PACKPROOF_MEASURE_P95_MS:'20'});
 const report=await runMeasurement(config,{
  now:()=>time,wallNow:()=>Date.UTC(2026,9,28)+time,
  sleep:async ms=>{time+=ms;},
  fetchImpl:async(url,options)=>{
   calls.push({url:String(url),options});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
   if(url.pathname==='/meta'){assert.equal(options.headers.Authorization,undefined);return meta();}
   starts.push(time);time+=[10,20,30][index++];
   assert.equal(options.headers.Authorization,'Bearer '+environment().PACKPROOF_API_KEY);
   return new Response(JSON.stringify({proofs:[]}),{status:200,headers:{'content-type':'application/json'}});
  }
 });
 assert.equal(report.attempted,3);assert.equal(report.successCount,3);assert.equal(report.failureCount,0);
 assert.deepEqual(report.statusCounts,{'200':3});
 assert.equal(report.latency.p50Ms,20);assert.equal(report.latency.p95Ms,30);assert.equal(report.latency.p99Ms,30);
 assert.equal(report.candidate.matchesExpected,true);assert.equal(report.meta.environment,'isolated-test');
 assert.equal(report.target.passed,false);assert.equal(measurementExitCode(report),1);
 assert.equal(report.usageEvidence.metadataGets,3);
 assert.equal(report.usageEvidence.responseBodyBytes,3*new TextEncoder().encode(JSON.stringify({proofs:[]})).length);
 assert.ok(starts[1]-starts[0]>=600);assert.ok(starts[2]-starts[1]>=600);
 assert.equal(calls.length,4);assert.ok(calls.every(call=>!call.url.includes(environment().PACKPROOF_API_KEY)));
 assert.ok(!JSON.stringify(report).includes(environment().PACKPROOF_API_KEY));
});
for(const status of [401,403,429])test('stops immediately on authorization or rate rejection '+status,async()=>{
 let time=0,metadataCalls=0;
 const config=parseMeasurementConfig({...environment(),PACKPROOF_MEASURE_REQUESTS:'5'});
 const report=await runMeasurement(config,{
  now:()=>time,wallNow:()=>Date.UTC(2026,9,28),sleep:async ms=>{time+=ms;},
  fetchImpl:async url=>{
   if(url.pathname==='/meta')return meta();
   metadataCalls++;
   return new Response('Do not print this private payload',{status,headers:{'retry-after':'120'}});
  }
 });
 assert.equal(metadataCalls,1);assert.equal(report.attempted,1);assert.equal(report.failureCount,1);
 assert.equal(report.stopReason,status===429?'RATE_LIMITED':'AUTHORIZATION_DENIED');
 assert.equal(measurementExitCode(report),2);
 assert.equal(report.retryAfterSeconds,status===429?120:null);
 assert.ok(!JSON.stringify(report).includes('private payload'));
});
test('candidate mismatch aborts before any authenticated read',async()=>{
 let calls=0;
 const report=await runMeasurement(parseMeasurementConfig(environment()),{
  fetchImpl:async(_url,options)=>{
   calls++;assert.equal(options.headers.Authorization,undefined);
   return new Response(JSON.stringify({commit:'b'.repeat(40),environment:'isolated-test',version:'0.1.0'}));
  }
 });
 assert.equal(calls,1);assert.equal(report.attempted,0);assert.equal(report.successCount,0);
 assert.equal(report.stopReason,'CANDIDATE_MISMATCH');assert.equal(measurementExitCode(report),2);
});
