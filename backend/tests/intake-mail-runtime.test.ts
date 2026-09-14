import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient,DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { acceptTrustedSesReceipt } from '../src/intake/mail.js';
import { DomainError } from '../src/domain/errors.js';
import type { Database } from '../src/db/database.js';
import type { MailWorkerDependencies } from '../src/intake/mail.js';
import { createIntakeMailJobs } from '../src/intake/mail-runtime.js';
const captured=vi.hoisted(()=>({deps:null as MailWorkerDependencies|null}));
vi.mock('../src/intake/mail.js',()=>({acceptTrustedSesReceipt:vi.fn(),dispatchMailJobs:vi.fn((_db,_clock,deps)=>{captured.deps=deps;return Promise.resolve({completed:0,failed:0});})}));
const db={} as Database, clock={now:()=>new Date()};
const env={PACKPROOF_INTAKE_ENABLED:'true',PACKPROOF_INTAKE_EMAIL:'true',PACKPROOF_INTAKE_ACTOR_IDS:'seller',AWS_REGION:'us-east-1',PACKPROOF_INTAKE_QUEUE_URL:'https://sqs.us-east-1.amazonaws.com/123456789012/intake',PACKPROOF_INTAKE_RAW_BUCKET:'private-mail',PACKPROOF_INTAKE_TOPIC_ARN:'arn:aws:sns:us-east-1:123456789012:intake',PACKPROOF_S3_BUCKET:'canonical-evidence'};
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();captured.deps=null;});
describe('mail worker runtime isolation',()=>{
  it('pauses with the master flag/cohort and isolates bad mail configuration from API startup',async()=>{
    expect(createIntakeMailJobs(db,clock,{...env,PACKPROOF_INTAKE_ENABLED:'false'})).toEqual([]);
    expect(createIntakeMailJobs(db,clock,{...env,PACKPROOF_INTAKE_ACTOR_IDS:''})).toEqual([]);
    for(const overrides of [{PACKPROOF_INTAKE_RAW_BUCKET:'canonical-evidence'},{PACKPROOF_INTAKE_QUEUE_URL:'https://wrong.example/queue'},{PACKPROOF_INTAKE_TOPIC_ARN:''}]){
      const jobs=createIntakeMailJobs(db,clock,{...env,...overrides});
      expect(jobs.map(j=>j.name)).toEqual(['order-mail-configuration']);
      await expect(jobs[0].run()).rejects.toThrow('Order mail configuration');
    }
  });
  it('leaves malformed envelopes for the DLQ while acknowledging a healthy receipt in the same batch',async()=>{
    const jobs=createIntakeMailJobs(db,clock,env);
    const send=vi.spyOn(SQSClient.prototype,'send');
    send.mockResolvedValueOnce({Messages:[{Body:'malformed',ReceiptHandle:'bad'},{Body:'valid',ReceiptHandle:'good'}]} as never).mockResolvedValueOnce({} as never);
    vi.mocked(acceptTrustedSesReceipt).mockRejectedValueOnce(new DomainError('MAIL_INGRESS_INVALID','Invalid envelope',400)).mockResolvedValueOnce({accepted:1,ignored:0});
    expect(await jobs.find(j=>j.name==='order-mail-receipts')!.run()).toEqual({failed:1});
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteMessageCommand);
    expect((send.mock.calls[1][0] as DeleteMessageCommand).input.ReceiptHandle).toBe('good');
  });
  it('bounds body bytes and independently interrupts a stalled S3 stream',async()=>{
    const jobs=createIntakeMailJobs(db,clock,env);
    await jobs.find(j=>j.name==='order-mail-parser')!.run();
    expect(captured.deps?.allowedOwnerIds).toEqual(['seller']);
    const send=vi.spyOn(S3Client.prototype,'send');
    send.mockResolvedValueOnce({ContentLength:5,Body:Readable.from([Buffer.from('oversized')])} as never);
    await expect(captured.deps!.readRawObject('private-mail','received/test',5)).rejects.toMatchObject({code:'MESSAGE_TOO_LARGE'});
    vi.useFakeTimers();
    send.mockResolvedValueOnce({ContentLength:1,Body:new Readable({read(){}})} as never);
    const pending=captured.deps!.readRawObject('private-mail','received/stalled',5);
    const rejected=expect(pending).rejects.toThrow('MAIL_SOURCE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  });
});
