// Pure offline phase runner. Execute emitted AWS requests through the connected AWS application.
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {assembleLogisticsRuntimeObservation as assembleRecoveryRuntimeObservation} from './logistics-runtime-observe.mjs';
import {createRecoveryRuntimeReview,recoveryProbeRegistrations,recoveryProbeRunRequest,
  collectRecoveryProbeReceipt,createRecoveryRuntimePlan,recoveryWorkerRegistration,
  recoveryWorkerUpdate,recoveryApiUpdate,recoveryRecoveryApiUpdate,recoveryRecoveryWorkerUpdate} from './recovery-runtime-release.mjs';

export async function runRecoveryPhase(phase,input) {
  const envelope=(operation_name,params)=>({service_name:'ecs',operation_name,region_name:'us-east-1',params});
  if(phase==='observe')return assembleRecoveryRuntimeObservation(input);
  if(phase==='review')return createRecoveryRuntimeReview(input);
  if(phase==='register-probes')return Object.fromEntries(Object.entries(recoveryProbeRegistrations(input.snapshot,input.review)).map(([key,params])=>[key,envelope('RegisterTaskDefinition',params)]));
  if(phase==='run-probe')return envelope('RunTask',recoveryProbeRunRequest(input));
  if(phase==='collect-probe')return collectRecoveryProbeReceipt(input);
  if(phase==='plan')return createRecoveryRuntimePlan(input);
  if(phase==='worker-register')return envelope('RegisterTaskDefinition',recoveryWorkerRegistration(input.plan));
  if(phase==='worker-update')return envelope('UpdateService',recoveryWorkerUpdate(input));
  if(phase==='api-update')return envelope('UpdateExpressGatewayService',recoveryApiUpdate(input));
  if(phase==='recovery-api')return envelope('UpdateExpressGatewayService',recoveryRecoveryApiUpdate(input));
  if(phase==='recovery-worker')return envelope('UpdateService',recoveryRecoveryWorkerUpdate(input));
  throw Error('CONNECT_RECOVERY_RUNTIME_UNKNOWN_PHASE');
}
async function main() {
  const [phase,inputPath,outputPath]=process.argv.slice(2);
  if(process.argv.length!==5)throw Error('CONNECT_RECOVERY_RUNTIME_PHASE_INPUT_OUTPUT_REQUIRED');
  const input=JSON.parse(await readFile(inputPath,'utf8'));
  const result=await runRecoveryPhase(phase,input);
  await writeFile(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({phase,privateOutputWritten:true,awsOperationsPerformed:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{
  console.error(/^[A-Z0-9_]+$/.test(e?.message)?e.message:'CONNECT_RECOVERY_RUNTIME_INPUT_FAILED');process.exitCode=1;
});
