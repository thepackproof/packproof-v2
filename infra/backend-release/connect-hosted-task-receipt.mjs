// Read one stopped task and its own awslogs stream. Never fetch an environment secret.
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {hostedCollectorTarget as target} from './reconstruction-v11-release-review.mjs';

const cluster=target.clusterArn,prefix=cluster.replace(':cluster/',':task/')+'/';
const check=(ok,reason)=>{if(!ok)throw Error('HOSTED_RECEIPT_'+reason);};
const validTask=arn=>typeof arn==='string'&&arn.startsWith(prefix)&&/^[0-9a-f]{32}$/.test(arn.slice(prefix.length));
const aws=(service,operation,args)=>JSON.parse(execFileSync('aws',[service,operation,...args,'--output','json','--no-cli-pager','--region','us-east-1'],{
  encoding:'utf8',timeout:25000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']}));
export function collectTaskReceipt(taskArn,read=aws) {
  check(validTask(taskArn),'TASK_REQUIRED');
  const response=read('ecs','describe-tasks',['--cluster',cluster,'--tasks',taskArn]);
  const task=response.tasks?.[0];
  check(response.tasks?.length===1&&!response.failures?.length&&task.taskArn===taskArn&&task.clusterArn===cluster&&
    task.lastStatus==='STOPPED'&&task.containers?.length&&task.containers.every(c=>c.exitCode===0)&&!task.overrides?.taskRoleArn&&
    !task.overrides?.executionRoleArn&&(task.overrides?.containerOverrides??[]).every(c=>Object.keys(c).length===1&&c.name),'SUCCESSFUL_TASK_REQUIRED');
  const registered=read('ecs','describe-task-definition',['--task-definition',task.taskDefinitionArn]).taskDefinition;
  const family=/^packproof-(connect-owner|connect-probe|logistics-owner)-([a-f0-9]{12})-(inspect|rehearse|apply|(?:previous-)?(?:api|worker))$/.exec(registered?.family);
  check(registered?.taskDefinitionArn===task.taskDefinitionArn&&family,'RELEASE_FAMILY_REQUIRED');
  const owner=family[1].endsWith('-owner'),label=family[3],kind=label.replace(/^previous-/,'');
  check(owner?['inspect','rehearse','apply'].includes(label):['api','worker','previous-api','previous-worker'].includes(label),'MODE');
  const receiptSchema=family[1]==='logistics-owner'?'packproof.hosted-logistics-owner-receipt/v1':'packproof.hosted-collector-owner-receipt/v1';
  const mains=registered.containerDefinitions.filter(c=>owner?c.name==='owner':c.environment?.some(e=>e.name==='PACKPROOF_PROCESS_ROLE'&&e.value===kind));
  check(mains.length===1&&registered.containerDefinitions.length===task.containers.length&&task.containers.every(c=>registered.containerDefinitions.some(
    d=>d.name===c.name&&d.image===target.repository+'@'+c.imageDigest)),'DEFINITION_IMAGE');
  const primary=mains[0],config=primary.logConfiguration,options=config?.options;
  check(config?.logDriver==='awslogs'&&options['awslogs-region']==='us-east-1'&&options['awslogs-stream-prefix']&&options['awslogs-group'],'LOG_BINDING');
  const stream=options['awslogs-stream-prefix']+'/'+primary.name+'/'+taskArn.slice(prefix.length);
  const page=read('logs','get-log-events',['--log-group-name',options['awslogs-group'],'--log-stream-name',stream,'--start-from-head','--limit','1000','--no-paginate']);
  const records=(page.events??[]).flatMap(event=>{
    try{return [JSON.parse(event.message)];}catch{return [];}
  }).filter(r=>owner?(r?.schema===receiptSchema&&r.actualTask===taskArn&&r.mode===label):
    label.startsWith('previous-')?(r?.event==='shipment_rollback_reader'&&r.taskArn===taskArn&&r.kind===kind):
    (r?.schema?.startsWith('packproof.reconstruction-runtime-preflight/')&&r.taskIdentity?.taskArn===taskArn&&r.kind===kind));
  check(records.length===1,'ONE_COMPLETED_REPORT_REQUIRED');
  return {registered,task,report:records[0]};
}
async function main() {
  const [arn,file]=process.argv.slice(2);
  check(process.argv.length===4,'TASK_AND_OUTPUT_REQUIRED');
  const result=collectTaskReceipt(arn);
  await writeFile(file,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({readOnly:true,receiptWritten:true}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{
  console.error(/^HOSTED_RECEIPT_[A-Z_]+$/.test(e?.message)?e.message:'HOSTED_RECEIPT_READ_FAILED');process.exitCode=1;
});
