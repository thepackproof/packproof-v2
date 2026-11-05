import { PackProofClient, PackProofError, verifyWebhook, type ShippingRecordDetail } from '@packproof/partner-sdk';

const client = new PackProofClient({ baseUrl: 'https://api.example.test', token: 'fixture' });
async function contract() {
  const read = await client.getRecord('pr_1');
  const detail: ShippingRecordDetail = read.data;
  const mutation = await client.updateRecord(detail.record.id, { title: 'Corrected title', reason: 'Source mapping corrected' }, { revision: detail.record.revision, idempotencyKey: 'correction_1' });
  const revision: number = mutation.data.revision;
  const evidence = await client.getEvidence(detail.record.id);
  const original: true = evidence.data.evidence[0].original;
  const ingestion = await client.createIngestion({ connectionId: 'source_1', events: [{ sourceEventId: 'e_1', proofId: detail.record.id, eventType: 'CARRIER_ACCEPTED', reportedAt: '2026-11-04T12:00:00Z' }] }, { idempotencyKey: 'source_batch_1' });
  const operation = await client.getOperation(ingestion.data.operationId);
  const assurance: 'organization_submitted' = operation.data.sourceAssurance;
  // @ts-expect-error Mutations require a stable command key.
  client.createProof({});
  // @ts-expect-error The operational revision is a number, not a cursor or Proof status.
  client.closeRecord('pr_1', 'Reviewed', { revision: 'sealed', idempotencyKey: 'close_1' });
  return { revision, original, assurance };
}
void contract;
const accepted: boolean = verifyWebhook({ secret: 'fixture', signature: 'bad', rawBody: new Uint8Array() });
const problem = new PackProofError('fixture', { requestId: 'req_1' });
void accepted;
void problem;
