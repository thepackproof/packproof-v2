// Offline combiner for actual one-shot reports plus AWS describe-tasks results.
// This file never calls AWS, launches a task, executes SQL, or invents success.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {agentDigest,validateAgentReview,validateAgentRehearsal} from '../../backend/scripts/record-agent-migrate.mjs';
const fail=code=>{throw Error(code);};
export function combineAgentRehearsal(review,migrationReport,previousImageReport,described,now=new Date()){
 const reviewSha256=validateAgentReview(review);
 if(described?.failures?.length||!Array.isArray(described?.tasks)||described.tasks.length!==2)fail('AGENT_TWO_COMPLETED_TASK_RESULTS_REQUIRED');
 const result=(report,image)=>{
  const matches=described.tasks.filter(task=>task.taskArn===report?.taskArn),task=matches[0];
  if(matches.length!==1||task.clusterArn!==review.clusterArn||task.lastStatus!=='STOPPED'||task.containers?.length!==1||task.containers[0].imageDigest!==image||task.containers[0].lastStatus!=='STOPPED'||task.containers[0].exitCode!==0)fail('AGENT_REHEARSAL_TASK_RESULT_MISMATCH');
  return {taskArn:task.taskArn,exitCode:task.containers[0].exitCode};
 };
 const migration=result(migrationReport,review.candidateImage),previous=result(previousImageReport,review.previousImage);
 const body={schema:'packproof.record-agent-release-rehearsal/v1',reviewSha256,source:review.source,previousSource:review.previousSource,candidateImage:review.candidateImage,previousImage:review.previousImage,restoredHost:review.restored.host,restoredDatabase:review.restored.database,inventorySha256:review.inventorySha256,completedAt:now.toISOString(),migrationExitCode:migration.exitCode,previousImageExitCode:previous.exitCode,baselinePreserved:migrationReport.baselinePreserved,runtimeAuthorityPreserved:migrationReport.runtimeAuthorityPreserved,migrationTaskArn:migration.taskArn,taskArns:[migration.taskArn,previous.taskArn],migrationReport,migrationReportSha256:migrationReport.sha256,previousImageReport,previousImageReportSha256:previousImageReport.sha256};
 const receipt={...body,sha256:agentDigest(body)};validateAgentRehearsal(receipt,review,now);return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==6)fail('AGENT_REHEARSAL_FOUR_INPUT_FILES_REQUIRED');
  const [review,migration,previous,described]=process.argv.slice(2).map(file=>JSON.parse(readFileSync(file,'utf8')));
  console.log(JSON.stringify(combineAgentRehearsal(review,migration.report??migration,previous.report??previous,described)));
 }catch(error){const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'AGENT_REHEARSAL_EVIDENCE_INVALID';console.error(JSON.stringify({event:'record_agent_rehearsal_receipt_failed',code}));process.exitCode=1;}
}
