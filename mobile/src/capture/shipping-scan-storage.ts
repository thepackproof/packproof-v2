import * as FileSystem from 'expo-file-system';
import type { PackProofV2Client } from '../v2-api';
import { createShippingScanQueue, type ShippingScanJournal } from './shipping-scan-queue';

// Recording callbacks and saved-capture submission share one queue in this process.
// This prevents a late HTTP response from racing a recovery journal write.
const activeQueues = new Map<string, {journal:ShippingScanJournal;queue:ReturnType<typeof createShippingScanQueue>;transport:{client:PackProofV2Client}}>();

export function shippingJournalUri(sessionId: string) {
  if (!FileSystem.documentDirectory || !/^[a-zA-Z0-9_-]{1,96}$/.test(sessionId)) throw new Error('Shipping scan storage is unavailable.');
  return `${FileSystem.documentDirectory}packproof-shipping-${sessionId}.json`;
}
export function shippingQueue(client: PackProofV2Client, journal: ShippingScanJournal) {
  const uri = shippingJournalUri(journal.sessionId);
  const existing=activeQueues.get(uri);
  if (existing) {
    if(existing.journal.proofId!==journal.proofId || existing.journal.userId!==journal.userId) throw new Error('This label queue belongs to another account or Proof.');
    existing.transport.client=client; // Use renewed authentication when replaying.
    return existing.queue;
  }
  const transport={client};
  const queue=createShippingScanQueue({journal,
    persist: async value => {
      await FileSystem.writeAsStringAsync(`${uri}.pending`,JSON.stringify(value));
      await FileSystem.moveAsync({from:`${uri}.pending`,to:uri});
    },
    bind: scan=>transport.client.bindCaptureShipping(journal.proofId,journal.sessionId,scan),
  });
  activeQueues.set(uri,{journal,queue,transport});
  return queue;
}
export async function readShippingJournal(sessionId: string): Promise<ShippingScanJournal|null> {
  const uri = shippingJournalUri(sessionId);
  const active=activeQueues.get(uri);
  if(active) {await active.queue.flush();return active.journal;}
  if (!(await FileSystem.getInfoAsync(uri)).exists) return null;
  const value = JSON.parse(await FileSystem.readAsStringAsync(uri)) as ShippingScanJournal;
  if (value.sessionId!==sessionId || !Array.isArray(value.entries) || value.entries.length>8) throw new Error('Saved label information could not be read. Your video remains on this device.');
  return value;
}

export function releaseShippingQueue(sessionId:string) {
  activeQueues.delete(shippingJournalUri(sessionId));
}
