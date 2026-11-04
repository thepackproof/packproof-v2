# Connect a source and create a shipping record

PackProof's signed-in records workspace is at `/app/records`. A business administrator uses its spreadsheet flow to preview rows, confirm identifiers and time zone, and import records. A historical spreadsheet is a one-time import; it does not establish a recurring source connection. Unsupported systems enter the assisted connection process. A provider is supported only after its complete declared authorization, ingestion, reconciliation, and recovery flow has passed validation.

The instructions below are for developers integrating an authorized server. They are not prerequisites for the spreadsheet workflow.

## Prerequisites

Obtain these values from the workspace administrator for the selected environment:

| Value | Purpose |
| --- | --- |
| API base URL | The backend origin or deployed API prefix; do not assume the marketing website is the API. |
| Organization-owned service credential | Scoped to the required actions and environment. Keep it on the server. |
| Integration account ID | Namespaces stable source identities within the merchant. |
| Assigned operator membership ID | Selects the authorized person who may complete capture. |
| Merchant and delegation IDs | Required when a partner is acting through an explicit delegation. |

Organization API activation and the merchant entitlement must already be enabled by the released cohort policy. A pending workspace stays pending until those checks pass. Requesting access does not activate a production integration.

The retained external contract is `packproof.partner/v1`, described by [partner-openapi.json](../../backend/partner-openapi.json). Proof IDs remain the canonical record IDs. Existing human capture, personal attestation, snapshot, and preservation boundaries apply.

## TypeScript / Node.js

Use Node.js 22 or newer. Install the repository package from your local checkout with `npm install ./packages/partner-sdk-typescript`; it has no runtime dependencies. The package is a candidate in this repository and has not been published to a package registry.

```ts
import { PackProofClient, PackProofError } from '@packproof/partner-sdk';

const client = new PackProofClient({
  baseUrl: process.env.PACKPROOF_API_BASE_URL!,
  token: process.env.PACKPROOF_SERVICE_TOKEN!,
  merchantId: process.env.PACKPROOF_MERCHANT_ID,
  delegationId: process.env.PACKPROOF_DELEGATION_ID,
});

try {
  const receipt = await client.createProof({
    integrationAccountId: process.env.PACKPROOF_INTEGRATION_ACCOUNT_ID!,
    externalId: 'SHIP-00001234',
    operatorMembershipId: process.env.PACKPROOF_OPERATOR_MEMBERSHIP_ID!,
    transaction: {
      itemTitle: 'Pump assembly · outbound shipment',
      quantity: 2,
      shipping: { carrier: 'Example carrier', trackingNumber: '0000045123' },
    },
  }, { idempotencyKey: 'warehouse:SHIP-00001234:import:v1' });

  const record = await client.getProof(receipt.data.proofId);
  console.log({ proofId: receipt.data.proofId, portalPath: receipt.data.portalPath, recordRevision: receipt.data.recordRevision, requestId: record.requestId });
} catch (error) {
  if (error instanceof PackProofError) {
    console.error({ code: error.code, status: error.status, requestId: error.requestId });
  }
  throw error;
}
```

Store the source reference, returned Proof ID, `portalPath`, `recordRevision`, and stable command idempotency key in your integration database. The application-relative portal locator opens the useful record after normal login and current workspace authorization. The SDK retries a lost response using exactly the same key and serialized body. A reused source identity cannot silently overwrite an immutable snapshot. A changed input under an existing idempotency key produces a conflict requiring an explicit correction.

## Python

Use Python 3.10 or newer. Install the local repository package with `python -m pip install ./packages/partner-sdk-python`; its runtime uses the standard library.

```python
import os
from packproof import PackProofClient, PackProofError

client = PackProofClient(
    os.environ['PACKPROOF_API_BASE_URL'],
    os.environ['PACKPROOF_SERVICE_TOKEN'],
    merchant_id=os.environ.get('PACKPROOF_MERCHANT_ID'),
    delegation_id=os.environ.get('PACKPROOF_DELEGATION_ID'),
)

receipt = client.create_proof({
    'integrationAccountId': os.environ['PACKPROOF_INTEGRATION_ACCOUNT_ID'],
    'externalId': 'SHIP-00001234',
    'operatorMembershipId': os.environ['PACKPROOF_OPERATOR_MEMBERSHIP_ID'],
    'transaction': {'itemTitle': 'Pump assembly', 'quantity': 2},
}, idempotency_key='warehouse:SHIP-00001234:import:v1')

record = client.get_proof(receipt.data['proofId'])
print({'proofId': receipt.data['proofId'], 'portalPath': receipt.data.get('portalPath'), 'recordRevision': receipt.data.get('recordRevision'), 'requestId': record.request_id})
```

## Add evidence through the supported capture path

Creating a record stores the shipment assertion; it does not establish physical condition or create a personal attestation. To request capture, use `requestCapture(proofId, { allowedSurfaces: ['WEB', 'ANDROID'] }, { idempotencyKey })` or Python `request_capture`. Deliver the returned short-lived launch capability only to the assigned authorized operator. The operator signs in, reviews, and deliberately confirms the evidence through the existing capture application.

Original evidence upload, admission, finalization, and signed snapshot creation follow the existing capture/envelope protocol. The service credential does not receive human admission authority. Do not replace that protocol with a client-calculated digest or a service-generated attestation.

## Receive updates and recover

Create an HTTPS webhook with an operator-approved hostname and selected documented event types. Store its secret in your secret manager; the creation result is sensitive. Verify the original received bytes using the SDK before parsing JSON. Persist a receipt keyed by the authenticated event's `id`, then acknowledge with 2xx. Perform slow work after durable receipt. Delivery can repeat and arrive out of order.

Use the committed event stream for reconciliation. `eventPages` / `event_pages` preserves opaque cursors and exposes each response, including its next cursor and request ID. Save the cursor only after the page's events have been durably applied. `proofIds` / `proof_ids` iterates the scoped snapshot listing. A 410 cursor expiry requires an authorized snapshot resynchronization and restart with event-ID deduplication; it is not safely repaired by inventing a new cursor.

Read [SDK behavior](SDK.md) for retries, polling, exact webhook verification, and compatibility, and [support guidance](SUPPORT.md) for recovery actions.
