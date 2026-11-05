import { pathToFileURL } from 'node:url';
import { PackProofClient, PackProofError } from '../../packages/partner-sdk-typescript/index.mjs';

/** Keep this identity/key alongside your own durable source record. */
export async function firstRecord(client, { integrationAccountId, operatorMembershipId, externalId }) {
  const receipt = await client.createProof({
    integrationAccountId,
    operatorMembershipId,
    externalId,
    transaction: { itemTitle: 'Pump assembly', quantity: 2 },
  }, { idempotencyKey: `source:${externalId}:import:v1` });
  const record = await client.getProof(receipt.data.proofId);
  return { proofId: receipt.data.proofId, created: receipt.data.created, recordRevision: receipt.data.recordRevision, portalPath: receipt.data.portalPath, requestId: record.requestId };
}

async function main() {
  const required = ['PACKPROOF_API_BASE_URL', 'PACKPROOF_SERVICE_TOKEN', 'PACKPROOF_INTEGRATION_ACCOUNT_ID', 'PACKPROOF_OPERATOR_MEMBERSHIP_ID', 'PACKPROOF_SOURCE_REFERENCE'];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} using your authorized sandbox workspace values`);
  const client = new PackProofClient({
    baseUrl: process.env.PACKPROOF_API_BASE_URL,
    token: process.env.PACKPROOF_SERVICE_TOKEN,
    merchantId: process.env.PACKPROOF_MERCHANT_ID,
    delegationId: process.env.PACKPROOF_DELEGATION_ID,
  });
  const result = await firstRecord(client, {
    integrationAccountId: process.env.PACKPROOF_INTEGRATION_ACCOUNT_ID,
    operatorMembershipId: process.env.PACKPROOF_OPERATOR_MEMBERSHIP_ID,
    externalId: process.env.PACKPROOF_SOURCE_REFERENCE,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    if (error instanceof PackProofError) console.error(JSON.stringify({ status: error.status, code: error.code, requestId: error.requestId }));
    else console.error(error.message);
    process.exitCode = 1;
  });
}
