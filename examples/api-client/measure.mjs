#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'packproof.metadata-measurement/v1';
function invalid(field) { throw new Error(`Invalid ${field}; see the bounded measurement configuration.`); }
function integer(env, name, fallback, min, max) {
 const value=env[name];
 if(value===undefined)return fallback;
 if(typeof value!=='string'||!/^\d+$/.test(value))invalid(name);
 const number=Number(value);
 if(!Number.isSafeInteger(number)||number<min||number>max)invalid(name);
 return number;
}
function selector(value, name) {
 if(value===undefined||value==='')return null;
 if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value))invalid(name);
 return value;
}
/** Server environment only. Credentials never enter URLs, CLI arguments, or reports. */
export function parseMeasurementConfig(env={}) {
 let origin;
 try {
  const url=new URL(env.PACKPROOF_API_ORIGIN);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')invalid('PACKPROOF_API_ORIGIN');
  origin=url.origin;
 } catch { invalid('PACKPROOF_API_ORIGIN'); }
 const token=env.PACKPROOF_API_KEY;
 if(typeof token!=='string'||!token||token.length>2048||!/^[!-~]+$/.test(token))invalid('PACKPROOF_API_KEY');
 const profile=env.PACKPROOF_API_PROFILE??'legacy';
 if(!['legacy','partner'].includes(profile))invalid('PACKPROOF_API_PROFILE');
 const merchantId=selector(env.PACKPROOF_MERCHANT_ID,'PACKPROOF_MERCHANT_ID');
 const delegationId=selector(env.PACKPROOF_DELEGATION_ID,'PACKPROOF_DELEGATION_ID');
 if(profile==='partner'&&!merchantId)invalid('PACKPROOF_MERCHANT_ID');
 if(profile==='legacy'&&(merchantId||delegationId))invalid('PACKPROOF_API_PROFILE');
 const requests=integer(env,'PACKPROOF_MEASURE_REQUESTS',30,1,1000);
 const concurrency=integer(env,'PACKPROOF_MEASURE_CONCURRENCY',1,1,8);
 const agreedRpm=integer(env,'PACKPROOF_MEASURE_AGREED_RPM',100,1,120);
 const configuredIntervalMs=integer(env,'PACKPROOF_MEASURE_INTERVAL_MS',600,500,60000);
 if(concurrency>1&&(env.PACKPROOF_MEASURE_ALLOW_CONCURRENCY!=='true'||env.PACKPROOF_MEASURE_AGREED_RPM===undefined))
  invalid('explicit concurrency opt-in and agreed RPM');
 const intervalMs=Math.max(configuredIntervalMs,60000/agreedRpm);
 const proofId=selector(env.PACKPROOF_MEASURE_PROOF_ID,'PACKPROOF_MEASURE_PROOF_ID');
 const expectedSha=env.PACKPROOF_EXPECTED_SHA??null;
 if(expectedSha!==null&&(typeof expectedSha!=='string'||!/^[a-fA-F0-9]{40}$/.test(expectedSha)||expectedSha===token))invalid('PACKPROOF_EXPECTED_SHA');
 const targetP95Ms=env.PACKPROOF_MEASURE_P95_MS===undefined?null:integer(env,'PACKPROOF_MEASURE_P95_MS',500,1,60000);
 if(origin.includes(token)||proofId===token)invalid('public measurement selector');
 const prefix=profile==='partner'?'/v1/partner':'/v1';
 const path=proofId?`${prefix}/proofs/${encodeURIComponent(proofId)}`:`${prefix}/proofs/search?limit=10`;
 return {origin,token,profile,merchantId,delegationId,requests,concurrency,intervalMs,agreedRpm,
  path,expectedSha:expectedSha?.toLowerCase()??null,targetP95Ms,timeoutMs:15000};
}
/** Nearest-rank percentile. Empty samples have no measured percentile. */
export function percentile(values, percent) {
 if(!Array.isArray(values)||values.some(x=>typeof x!=='number'||!Number.isFinite(x)||x<0)||
    typeof percent!=='number'||!Number.isFinite(percent)||percent<0||percent>100)throw new Error('Invalid percentile sample.');
 if(!values.length)return null;
 const sorted=values.slice().sort((a,b)=>a-b);
 return sorted[Math.max(0,Math.ceil(percent/100*sorted.length)-1)];
}
const rounded=value=>value===null?null:Math.round(value*100)/100;
function distribution(values) {
 return {sampleCount:values.length,p50Ms:rounded(percentile(values,50)),
  p95Ms:rounded(percentile(values,95)),p99Ms:rounded(percentile(values,99))};
}
async function limitedJson(response, limit=1048576, onBytes=()=>{}) {
 const length=response.headers.get('content-length');
 if(length!==null&&/^\d+$/.test(length)&&Number(length)>limit)throw new Error('RESPONSE_TOO_LARGE');
 if(!response.body)throw new Error('EMPTY_RESPONSE');
 const reader=response.body.getReader();
 const chunks=[];let bytes=0;
 try {
  while(true) {
   const value=await reader.read();
   if(value.done)break;
   bytes+=value.value.byteLength;
   if(bytes>limit)throw new Error('RESPONSE_TOO_LARGE');
   chunks.push(value.value);
  }
 } catch(error) { await reader.cancel().catch(()=>{});throw error; }
 finally { reader.releaseLock(); }
 const merged=new Uint8Array(bytes);let offset=0;
 for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
 onBytes(bytes);
 const value=JSON.parse(new TextDecoder().decode(merged));
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_RESPONSE');
 return value;
}
function safeMeta(value, config, max=100) {
 if(typeof value!=='string'||!value||value.length>max||!/^[-A-Za-z0-9._+:/@ ]+$/.test(value)||
    value.includes(config.token)||/pp_org_|whsec_/i.test(value))return null;
 return value;
}
function retryAfter(response, wallNow) {
 const value=response.headers.get('retry-after');
 if(!value)return null;
 if(/^\d+$/.test(value))return Math.min(Number(value),86400);
 const date=Date.parse(value);
 return Number.isFinite(date)?Math.min(86400,Math.max(0,Math.ceil((date-wallNow())/1000))):null;
}
/** Read-only HTTPS runner. Inject fetch/clock/sleep for deterministic no-network tests. */
export async function runMeasurement(config, dependencies={}) {
 const fetchImpl=dependencies.fetchImpl??globalThis.fetch;
 const now=dependencies.now??(()=>performance.now());
 const wallNow=dependencies.wallNow??(()=>Date.now());
 const sleep=dependencies.sleep??((ms,signal)=>delay(ms,undefined,{signal}));
 const started=now(),beganAt=new Date(wallNow()).toISOString();
 const controller=new AbortController();
 const all=[],successful=[],statusCounts={};
 let attempted=0,transportErrors=0,timeouts=0,aborted=0,invalidResponses=0,responseBodyBytes=0;
 let stopReason=null,retryAfterSeconds=null,meta=null;
 const headers={Accept:'application/json',Authorization:`Bearer ${config.token}`};
 if(config.merchantId)headers['PackProof-Merchant-Id']=config.merchantId;
 if(config.delegationId)headers['PackProof-Delegation-Id']=config.delegationId;
 // Public identity preflight carries no credential and is outside measured samples.
 try {
  const response=await fetchImpl(new URL('/meta',config.origin),{
   method:'GET',headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(config.timeoutMs)});
  if(!response.ok){await response.body?.cancel().catch(()=>{});stopReason='META_UNAVAILABLE';}
  else {
   const value=await limitedJson(response,65536);
   const sha=typeof value.commit==='string'&&/^[a-fA-F0-9]{40}$/.test(value.commit)&&value.commit!==config.token?value.commit.toLowerCase():null;
   meta={service:safeMeta(value.service,config),environment:safeMeta(value.environment,config,64),
    version:safeMeta(value.version,config),commit:sha};
   if(config.expectedSha&&sha!==config.expectedSha)stopReason='CANDIDATE_MISMATCH';
  }
 } catch { stopReason='META_UNAVAILABLE'; }
 async function one() {
  attempted++;const begin=now();let succeeded=false;
  const deadline=AbortSignal.timeout(config.timeoutMs);
  try {
   const response=await fetchImpl(new URL(config.path,config.origin),{
    method:'GET',headers,redirect:'error',
    signal:AbortSignal.any([controller.signal,deadline])});
   statusCounts[response.status]=(statusCounts[response.status]??0)+1;
   if([401,403,429].includes(response.status)){
    stopReason??=response.status===429?'RATE_LIMITED':'AUTHORIZATION_DENIED';
    if(response.status===429)retryAfterSeconds=retryAfter(response,wallNow);
    controller.abort();
    await response.body?.cancel().catch(()=>{});
    return;
   }
   if(!response.ok){await response.body?.cancel().catch(()=>{});return;}
   await limitedJson(response,1048576,bytes=>{responseBodyBytes+=bytes;});succeeded=true;
  } catch(error) {
   if(controller.signal.aborted)aborted++;
   else if(deadline.aborted||error?.name==='TimeoutError')timeouts++;
   else if(error instanceof SyntaxError||['RESPONSE_TOO_LARGE','EMPTY_RESPONSE','INVALID_RESPONSE'].includes(error?.message))invalidResponses++;
   else transportErrors++;
  } finally {
   const elapsed=Math.max(0,now()-begin);all.push(elapsed);if(succeeded)successful.push(elapsed);
  }
 }
 const active=new Set();let nextStart=now();
 if(!stopReason)for(let i=0;i<config.requests;i++){
  while(active.size>=config.concurrency)await Promise.race(active);
  if(stopReason)break;
  const wait=Math.max(0,nextStart-now());
  if(wait>0){try{await sleep(wait,controller.signal);}catch{break;}}
  if(stopReason)break;
  nextStart=now()+config.intervalMs;
  const pending=one().finally(()=>active.delete(pending));active.add(pending);
 }
 await Promise.all(active);
 const latency=distribution(successful),attemptLatency=distribution(all);
 const target=config.targetP95Ms===null?null:{p95Ms:config.targetP95Ms,
  passed:latency.p95Ms!==null&&latency.p95Ms<=config.targetP95Ms};
 return {schema:SCHEMA,origin:config.origin,profile:config.profile,endpoint:config.path,
  beganAt,endedAt:new Date(wallNow()).toISOString(),elapsedMs:rounded(Math.max(0,now()-started)),
  candidate:{expectedSha:config.expectedSha,observedSha:meta?.commit??null,
   matchesExpected:config.expectedSha===null?null:meta?.commit===config.expectedSha},
  meta,configuration:{requested:config.requests,concurrency:config.concurrency,intervalMs:config.intervalMs,
   tenantRequestBudgetPerMinute:Math.min(config.agreedRpm,60000/config.intervalMs),timeoutMs:config.timeoutMs},
  attempted,successCount:successful.length,failureCount:attempted-successful.length,
  statusCounts,transportErrors,timeouts,aborted,invalidResponses,latency,attemptLatency,
  stopReason,retryAfterSeconds,target,
  usageEvidence:{metadataGets:attempted,responseBodyBytes,
   scope:'Sampled response-body bytes only; excludes transport overhead, media, storage, processing and provider costs.'},
  qualification:'Observed metadata GET sample only; provider, capture, restore, security and contractual availability are not qualified.'};
}
export function measurementExitCode(report) {
 if(report.stopReason||report.attempted<report.configuration.requested||report.failureCount||report.successCount===0)return 2;
 return report.target&&!report.target.passed?1:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try {
  const report=await runMeasurement(parseMeasurementConfig(process.env));
  process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=measurementExitCode(report);
 } catch {
  process.stderr.write(JSON.stringify({schema:SCHEMA,error:'INVALID_CONFIGURATION',
   message:'Use server environment credentials, an exact HTTPS origin, bounded request settings and explicit concurrency approval.'})+'\n');
  process.exitCode=2;
 }
}
