import { describe, expect, it } from 'vitest';
import { createShippingScanQueue, type ShippingScanJournal } from '../../mobile/src/capture/shipping-scan-queue';
const scan={rawValue:'1Z999AA10123456784',format:'CODE_128',detectedAtMs:100,idempotencyKey:'one'};
const journal=():ShippingScanJournal=>({proofId:'p1',sessionId:'c1',userId:'u1',entries:[]});
describe('durable native label queue',()=>{
  it('persists before HTTP and survives restart with the original retry key and offset',async()=>{
    let saved=journal(),calls=0;
    const q=createShippingScanQueue({journal:journal(),persist:async value=>{saved=value;},bind:async()=>{expect(saved.entries).toHaveLength(1);calls++;throw new Error('offline');}});
    expect((await q.detect(scan)).status).toBe('QUEUED');
    expect((await q.detect({...scan,idempotencyKey:'duplicate'})).status).toBe('QUEUED');expect(calls).toBe(1);
    const resumed=createShippingScanQueue({journal:saved,persist:async value=>{saved=value;},bind:async value=>{expect(value).toEqual(scan);return {status:'BOUND',proofId:'p1'};}});
    expect((await resumed.retry())[0].result.status).toBe('BOUND');
  });
  it('never sends a scan when local persistence fails and excludes product/URL payloads',async()=>{
    let calls=0;const q=createShippingScanQueue({journal:journal(),persist:async()=>{throw Error('disk');},bind:async()=>{calls++;return {status:'BOUND'};}});
    expect((await q.detect({...scan,format:'UPC_A'})).status).toBe('UNRECOGNIZED');
    expect((await q.detect({...scan,rawValue:'https://example.com/person'})).status).toBe('UNRECOGNIZED');
    await expect(q.detect(scan)).rejects.toThrow('disk');expect(calls).toBe(0);
  });
  it('requires an explicit tap for ambiguity and retains conflicts without replaying them',async()=>{
    const j=journal();let calls=0;
    const q=createShippingScanQueue({journal:j,persist:async()=>{},bind:async value=>{calls++;if(!value.confirmed)return {status:'NEEDS_CONFIRMATION'};throw {code:'SHIPPING_LABEL_CONFLICT'};}});
    await q.detect(scan);await q.retry();expect(calls).toBe(1);
    expect((await q.confirm(scan.rawValue)).status).toBe('CONFLICT');await q.retry();expect(calls).toBe(2);
    expect(j.entries[0].scan.idempotencyKey).toBe('one:confirmed');
  });
});
