import { expect, it, vi } from 'vitest';
import type { PackProofV2Client } from '../../mobile/src/v2-api';
const files=vi.hoisted(()=>new Map<string,string>());
vi.mock('../../mobile/node_modules/expo-file-system/src/index.ts',()=>({
  documentDirectory:'file:///documents/',
  writeAsStringAsync:async(path:string,value:string)=>{files.set(path,value);},
  readAsStringAsync:async(path:string)=>files.get(path),
  getInfoAsync:async(path:string)=>({exists:files.has(path)}),
  moveAsync:async({from,to}:{from:string;to:string})=>{files.set(to,files.get(from)!);files.delete(from);},
}));
import { shippingQueue,readShippingJournal,releaseShippingQueue } from '../../mobile/src/capture/shipping-scan-storage';

it('shares in-flight recording/submission writes, renews auth on retry, and reloads the persisted identity after restart',async()=>{
  const journal={proofId:'proof_one',sessionId:'cap_one',userId:'seller_one',entries:[]};
  const expired={bindCaptureShipping:vi.fn(async()=>{throw {code:'UNAUTHENTICATED'};})} as unknown as PackProofV2Client;
  const q=shippingQueue(expired,journal);
  await q.detect({rawValue:'1Z999AA10123456784',format:'CODE_128',detectedAtMs:100,idempotencyKey:'first'});
  const live=await readShippingJournal('cap_one');expect(live).toBe(journal);
  const renewed={bindCaptureShipping:vi.fn(async()=>({status:'BOUND',trackingNumber:'1Z999AA10123456784'}))} as unknown as PackProofV2Client;
  const retry=shippingQueue(renewed,live!);expect(retry).toBe(q);
  await retry.retry();expect(renewed.bindCaptureShipping).toHaveBeenCalledTimes(1);expect(expired.bindCaptureShipping).toHaveBeenCalledTimes(1);
  expect(()=>shippingQueue(renewed,{...journal,userId:'other'})).toThrow('another account');
  releaseShippingQueue('cap_one');
  const restored=await readShippingJournal('cap_one');
  expect(restored?.entries[0].result.status).toBe('BOUND');
  expect(restored?.entries[0].scan.idempotencyKey).toBe('first');
});
