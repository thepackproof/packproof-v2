# Reference merchant adapter and durable receiver

This sample connects a merchant's own server to the disabled-by-default organization foundation. It is not an approved external provider connector, live pilot or full browser/native SDK.

`partner-client.mjs` runs only on a trusted server. Configure HTTPS origins, a managed service credential, environment, merchant ID and an explicitly approved delegation ID. Import with a persisted operation key. On a network timeout, reconcile the external order or retry with the same key and bytes; never invent another order identity. A successful import returns the canonical Proof. `capture()` returns a sensitive launch URL for the assigned authenticated operator; do not log it, send the server credential to that operator, or attest on their behalf. The existing capture host owns recorder/recovery behavior. `package()` returns a streaming HTTP response for the existing ZIP/.pkpr exporter.

```js
import {PartnerClient} from './partner-client.mjs';
const client = new PartnerClient({
  apiOrigin: configuration.apiOrigin, siteOrigin: configuration.siteOrigin,
  credential: secrets.partnerCredential, environment: 'sandbox',
  merchantId: configuration.merchantId, delegationId: configuration.grantId,
});
// Persist this operation key before the first attempt. Values below are synthetic.
const result = await client.importOrder({
  integrationAccountId: configuration.integrationAccountId,
  externalId: 'ORDER-1001', operatorMembershipId: configuration.operatorMembershipId,
  transaction: {itemTitle: 'Synthetic parcel', quantity: 1,
    amount: {minorUnits: '100', currency: 'JPY'}},
}, persistedOperationKey);
const launch = await client.capture(result.proofId, persistedCaptureKey);
// Deliver launch.launchUrl only to the authenticated, authorized operator.
```

## Receiver installation

Apply `schema.sql` to the merchant's database. Adapt a PostgreSQL pool to `ReceiverDatabase`: each `transaction` must use one connection, BEGIN, COMMIT on success and ROLLBACK on failure. All queries inside it use that connection. Do not fake a transaction by running each query through `pool.query`.

Configure `Subscription` from trusted server state: exact subscription ID, endpoint path, PackProof tenant/environment, current HMAC secret and optional previous secret with an explicit overlap deadline. Its `authorize` function reloads current subscription/delegation state and fails on revocation. Never construct this binding from request JSON.

Mount an exact endpoint with raw-body parsing and a 64 KiB limit **before** generic JSON parsing. Pass the original raw `Buffer`, `PackProof-Signature` header and configured endpoint path to `receiveEvent`. Only send 2xx after the returned promise resolves. Map `ReceiverError.status` to its safe error response; transient database failures receive 5xx to allow redelivery.

The inbox key is `(provider, subscriptionId, eventId)`. Inbox acceptance and durable job insertion are one transaction. A crash before commit rolls back both. A crash after commit leaves durable work, and redelivery acknowledges the duplicate. Reuse of an event ID with different bytes is rejected. Jobs request reconciliation of current authorized Proof state rather than applying a possibly old webhook status.

`applyLocalJob` demonstrates a local effect ledger and job completion in the same transaction. It does **not** submit to another provider. A real external action needs a separate durable intent, provider idempotency key, current authorization check, timeout/unknown state and reconciliation before retry. Never hold the database transaction open across a provider call.

Signature verification covers timestamp plus exact raw body using constant-time comparison and a five-minute freshness window. Endpoint, tenant and environment are separately checked. Legacy v1 webhook bodies omit environment; bind that value from the configured subscription. Stream events include it. Rotate the sender secret through the established authorized management flow; retain the previous receiver secret only for the reviewed overlap. New timestamps are expected on retries; event IDs remain stable.

Local tests: `backend/tests/partner-receiver.test.ts` uses PGlite commit/rollback and exported database state reopened in a new instance. It is not disk-loss, PostgreSQL, S3 or external-provider certification. The real PostgreSQL stream test and staging restore runbook remain separate gates.
