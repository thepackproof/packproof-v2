/** Offline phase runner. Write private requests, execute them through the connected AWS app, reread results. */
import {readFile,writeFile} from 'node:fs/promises';
import {connectRuntimeBuildRequest,connectProbeRegistrations,connectProbeRunRequest,connectRuntimePlan,connectWorkerRegistration,connectWorkerUpdate,connectApiUpdate,connectRollbackWorker} from './connect-runtime-release.mjs';
const [phase,inputPath,outputPath]=process.argv.slice(2);
async function probeCode(review){
 if(review?.schema==='packproof.connect-runtime-review/v8')return {reader:await readFile(new URL('./backfill-rollback-reader-probe.mjs',import.meta.url),'utf8')};
 if(review?.schema==='packproof.connect-runtime-review/v7')return {reader:await readFile(new URL('./shipment-rollback-reader-probe.mjs',import.meta.url),'utf8')};
 return readFile(new URL('./connect-runtime-probe.mjs',import.meta.url),'utf8');
}
try{
 if(!phase||!inputPath||!outputPath||process.argv.length!==5)throw Error('CONNECT_RELEASE_PHASE_INPUT_OUTPUT_REQUIRED');
 const input=JSON.parse(await readFile(inputPath,'utf8'));
 let result;
 if(phase==='build-request')result={service_name:'codebuild',operation_name:'StartBuild',region_name:'us-east-1',params:connectRuntimeBuildRequest(input)};
 else if(phase==='register-probes'){
  const script=await probeCode(input.review);
  const registrations=connectProbeRegistrations(input.snapshot,input.review,script);
  result=Object.fromEntries(Object.entries(registrations).map(([kind,params])=>[kind,{service_name:'ecs',operation_name:'RegisterTaskDefinition',region_name:'us-east-1',params}]));
 }else if(phase==='run-probe'){
  const script=await probeCode(input.review);
  result={service_name:'ecs',operation_name:'RunTask',region_name:'us-east-1',params:connectProbeRunRequest(input.snapshot,input.review,input.kind,input.registered,script)};
 }else if(phase==='plan'){const script=await probeCode(input.review);result=connectRuntimePlan(input.snapshot,input.review,input.probes,Date.now(),script);}
 else if(phase==='worker-register')result={service_name:'ecs',operation_name:'RegisterTaskDefinition',region_name:'us-east-1',params:connectWorkerRegistration(input.plan)};
 else if(phase==='worker-update')result={service_name:'ecs',operation_name:'UpdateService',region_name:'us-east-1',params:connectWorkerUpdate(input.plan,input.registered,input.observation)};
 else if(phase==='api-update')result={service_name:'ecs',operation_name:'UpdateExpressGatewayService',region_name:'us-east-1',params:connectApiUpdate(input.plan,input.workerObservation,input.apiObservation)};
 else if(phase==='rollback-worker')result={service_name:'ecs',operation_name:'UpdateService',region_name:'us-east-1',params:connectRollbackWorker(input.plan,input.apiObservation,input.quiescence)};
 else throw Error('CONNECT_RELEASE_UNKNOWN_PHASE');
 await writeFile(outputPath,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({phase,privateRequestWritten:true,awsOperationsPerformed:0}));
}catch(error){console.error(/^[A-Z0-9_]{3,90}$/.test(error?.message??'')?error.message:'CONNECT_RELEASE_PHASE_FAILED');process.exitCode=1;}
