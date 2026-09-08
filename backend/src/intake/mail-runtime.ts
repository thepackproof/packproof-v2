import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ScheduledJob } from '../operations/scheduler.js';
import { acceptTrustedSesReceipt, dispatchMailJobs } from './mail.js';
import { submitIntakeObservation } from './context.js';
import { MailParseError } from './mail-parser.js';
import { DomainError } from '../domain/errors.js';

/** Dedicated private ingress, independent of canonical evidence storage and HTTP capture. */
export function createIntakeMailJobs(db:Database,clock:Clock,env:NodeJS.ProcessEnv=process.env):ScheduledJob[] {
  const allowedOwnerIds=(env.PACKPROOF_INTAKE_ACTOR_IDS||'').split(',').map(id=>id.trim()).filter(Boolean);
  if(env.PACKPROOF_INTAKE_ENABLED!=='true'||env.PACKPROOF_INTAKE_EMAIL!=='true'||allowedOwnerIds.length===0)return [];
  const region=env.AWS_REGION||env.AWS_DEFAULT_REGION;
  const queueUrl=env.PACKPROOF_INTAKE_QUEUE_URL;
  const bucket=env.PACKPROOF_INTAKE_RAW_BUCKET;
  const topicArn=env.PACKPROOF_INTAKE_TOPIC_ARN;
  const keyPrefix=env.PACKPROOF_INTAKE_RAW_PREFIX||'received/';
  // A misconfigured optional inbox must not prevent the API/camera runtime from booting.
  const blocked=():ScheduledJob[]=>[{name:'order-mail-configuration',intervalMs:60_000,run:async()=>{throw new Error('Order mail configuration is incomplete or outside its dedicated source scope');}}];
  if(!region||!queueUrl||!bucket||!topicArn)return blocked();
  let queue:URL;try{queue=new URL(queueUrl);}catch{return blocked();}
  if(queue.protocol!=='https:'||queue.hostname!==`sqs.${region}.amazonaws.com`||queue.username||queue.password||queue.search||queue.hash||!/^\/[0-9]{12}\/[A-Za-z0-9_-]+$/.test(queue.pathname))return blocked();
  if(!topicArn.startsWith(`arn:aws:sns:${region}:${queue.pathname.split('/')[1]}:`))return blocked();
  if(bucket===(env.PACKPROOF_S3_BUCKET||env.AWS_S3_BUCKET))return blocked();
  const s3=new S3Client({region,maxAttempts:2});
  const sqs=new SQSClient({region,maxAttempts:2});
  return [
    {name:'order-mail-receipts',intervalMs:2000,run:async()=>{
      const response=await sqs.send(new ReceiveMessageCommand({QueueUrl:queueUrl,MaxNumberOfMessages:5,WaitTimeSeconds:2,VisibilityTimeout:60}),{abortSignal:AbortSignal.timeout(10_000)});
      let failed=0;
      for(const message of response.Messages||[]){
        if(!message.Body||!message.ReceiptHandle)continue;
        // A malformed envelope remains in the protected queue and eventually reaches its DLQ.
        try{await acceptTrustedSesReceipt(db,clock,message.Body,{topicArn,bucket,keyPrefix});}
        catch(error){if(error instanceof DomainError&&error.code==='MAIL_INGRESS_INVALID'){failed++;continue;}throw error;}
        await sqs.send(new DeleteMessageCommand({QueueUrl:queueUrl,ReceiptHandle:message.ReceiptHandle}),{abortSignal:AbortSignal.timeout(5000)});
      }
      return {failed};
    }},
    {name:'order-mail-parser',intervalMs:2000,run:()=>dispatchMailJobs(db,clock,{
      submitObservation:submitIntakeObservation,
      allowedOwnerIds,
      readRawObject:async(readBucket,key,maxBytes)=>{
        if(readBucket!==bucket||!key.startsWith(keyPrefix))throw new MailParseError('MAIL_SOURCE_SCOPE');
        const response=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}),{abortSignal:AbortSignal.timeout(10_000)});
        const stream=response.Body;
        if(!stream)throw new DomainError('MAIL_SOURCE_MISSING','The retained source is unavailable.',409);
        const discard=(error?:Error)=>{if('destroy' in stream && typeof stream.destroy==='function')stream.destroy(error);};
        if((response.ContentLength??maxBytes+1)>maxBytes){discard();throw new MailParseError('MESSAGE_TOO_LARGE');}
        // SDK request timeout may end after headers; separately bound consumption of the body.
        const timer=setTimeout(()=>discard(new Error('MAIL_SOURCE_TIMEOUT')),10_000);
        timer.unref();
        try{
          const chunks:Buffer[]=[];let length=0;
          for await(const chunk of stream as AsyncIterable<Uint8Array>){length+=chunk.length;if(length>maxBytes)throw new MailParseError('MESSAGE_TOO_LARGE');chunks.push(Buffer.from(chunk));}
          if(response.ContentLength!==undefined&&length!==response.ContentLength)throw new Error('MAIL_SOURCE_TRUNCATED');
          return Buffer.concat(chunks);
        }finally{clearTimeout(timer);discard();}
      },
    },5)},
  ];
}
