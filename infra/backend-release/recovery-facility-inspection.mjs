// Fixed facility metadata inspection on the observed API image and identity.
// Only the trusted subject and exact reviewed ledger are caller-supplied.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {brotliCompressSync} from 'node:zlib';
import {TARGET} from './backend-deployment-plan.mjs';
import {verifierTaskDefinition,runVerifierRequest} from './backend-release-requests.mjs';
import {verifyService} from './connect-hosted-owner-task.mjs';
import {verifyRecoveryTaskRegistration} from './recovery-runtime-release.mjs';
import {facilityEnvelopeHeader,validateFacilityRecipientKey} from './logistics-facility-inspect.mjs';

const check=(ok,code)=>{if(!ok)throw Error('RECOVERY_FACILITY_'+code);};
const inventories=new Set(['8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc',
  '13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e']);
const fresh=(date,now)=>Number.isFinite(Date.parse(date))&&Date.parse(date)<=now&&now-Date.parse(date)<=15*60_000;
const cluster='arn:aws:ecs:'+TARGET.region+':'+TARGET.account+':cluster/'+TARGET.cluster;
const taskPrefix=cluster.replace(':cluster/',':task/')+'/';
export function prepareRecoveryFacilityInspection({snapshot,subjectSha256,recipientPublicKeySpki,inventorySha256,runId},now=Date.now()) {
  check(typeof subjectSha256==='string'&&/^[a-f0-9]{64}$/.test(subjectSha256)&&inventories.has(inventorySha256),'SUBJECT_OR_LEDGER');
  validateFacilityRecipientKey(recipientPublicKeySpki);
  const recipientSha256=createHash('sha256').update(Buffer.from(recipientPublicKeySpki,'base64')).digest('hex');
  check(snapshot?.account===TARGET.account&&snapshot.region===TARGET.region&&fresh(snapshot.observedAt,now),'FRESH_OBSERVATION');
  const api=snapshot.api,source=api.meta?.commit,image=api.meta?.image;
  verifyService(api,'api',{source,image},false);
  const code=readFileSync(new URL('./logistics-facility-inspect.mjs',import.meta.url));
  const inspectorSha256=createHash('sha256').update(code).digest('hex');
  const compressed=brotliCompressSync(code).toString('base64');
  const script=`process.argv.push(${JSON.stringify(subjectSha256)},${JSON.stringify(recipientPublicKeySpki)});
import {brotliDecompressSync} from 'node:zlib';import {createHash} from 'node:crypto';
const code=brotliDecompressSync(Buffer.from('${compressed}','base64'));
if(createHash('sha256').update(code).digest('hex')!=='${inspectorSha256}')throw Error('FACILITY_CODE_BINDING');
const timer=setTimeout(()=>process.exit(2),180000);timer.unref();
try{const inspector=await import('data:text/javascript;base64,'+code.toString('base64'));await inspector.facilityInspectionMain();}
finally{clearTimeout(timer);}`;
  const prepared=verifierTaskDefinition(api.taskDefinition,{sourceSha:source,image,version:api.meta.version,script,inventorySha256,runId});
  return {...prepared,source,image,inventorySha256,runId,inspectorSha256,subjectSha256,recipientSha256};
}
export function runRecoveryFacilityInspection({prepared,registered,snapshot},now=Date.now()) {
  check(fresh(snapshot?.observedAt,now),'FRESH_OBSERVATION');
  verifyService(snapshot.api,'api',{source:prepared.source,image:prepared.image},false);
  const definition=verifyRecoveryTaskRegistration(registered,prepared.request);
  return runVerifierRequest(snapshot.api.service,definition.taskDefinitionArn,{sourceSha:prepared.source,runId:prepared.runId});
}
export function collectRecoveryFacilityInspection({prepared,registered,task,events,logGroup,logStream},now=Date.now()) {
  const definition=verifyRecoveryTaskRegistration(registered,prepared.request);
  check(typeof task?.taskArn==='string'&&task.taskArn.startsWith(taskPrefix)&&/^[a-f0-9]{32}$/.test(task.taskArn.slice(taskPrefix.length))&&
    task.clusterArn===cluster&&task.taskDefinitionArn===definition.taskDefinitionArn&&task.lastStatus==='STOPPED'&&
    task.containers?.length===1&&task.containers[0].name===prepared.containerName&&task.containers[0].exitCode===0&&
    task.containers[0].lastStatus==='STOPPED'&&task.containers[0].imageDigest===prepared.image.split('@')[1]&&
    !task.overrides?.taskRoleArn&&!task.overrides?.executionRoleArn&&
    (task.overrides?.containerOverrides??[]).every(c=>Object.keys(c).length===1&&c.name===prepared.containerName),'TASK_IDENTITY');
  check(logGroup===prepared.logGroup&&logStream===prepared.logPrefix+'/'+prepared.containerName+'/'+task.taskArn.split('/').at(-1),'LOG_BINDING');
  const records=(events??[]).flatMap(event=>{try{return [JSON.parse(event.message)];}catch{return [];}})
    .filter(value=>value?.schema==='packproof.logistics-facility-encrypted/v1');
  check(records.length===1,'ONE_RECEIPT');
  const envelope=records[0],header=facilityEnvelopeHeader(envelope);
  check(header.source===prepared.source&&header.image===prepared.image&&header.inventorySha256===prepared.inventorySha256&&
    header.actualTask===task.taskArn&&header.subjectSha256===prepared.subjectSha256&&header.recipientSha256===prepared.recipientSha256&&
    fresh(header.completedAt,now),'RECEIPT_BINDING');
  // Only the local private-key holder can authenticate and read the inner
  // metadata. The workflow attests the exact executed task and envelope binding.
  return {envelope,header};
}
