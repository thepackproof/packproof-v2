# PackProof API integration quickstart

This guide uses the existing canonical Proof and supported WEB/ANDROID recorder. A successful order import is order context. An enrolled person records, reviews and deliberately confirms the evidence. The first release remains a controlled pilot until the exact candidate passes the [release gates](RELEASE_GATES.md).

## Prepare the isolated sandbox

Use a separate HTTPS staging deployment and synthetic orders. Obtain a controlled merchant enrollment from PackProof operations. Retain the approved origin and expected candidate commit from the release receipt. Organization support is disabled by default; creating an identity namespace does not connect a commerce provider.

For an organization integration, the merchant grants the application its permitted scopes and explicitly selected operators. Use an active operator membership and the durable integration-account namespace. A direct merchant credential uses its merchant ID without a delegation header. A partner credential additionally selects its exact active delegation. Staff retain personal first-party sign-in; a service credential cannot attest.

Store credentials only in the merchant server's secret manager. Never put them in a browser/native bundle, launch URL, source file or log. Configure `PACKPROOF_API_ORIGIN`, `PACKPROOF_API_KEY`, and `PACKPROOF_API_PROFILE=legacy|partner` from trusted server configuration. Organization calls additionally use `PACKPROOF_MERCHANT_ID` and, for delegated partners, `PACKPROOF_DELEGATION_ID`.

## Create and recover the same order

Node 22+ needs no runtime dependencies for this example. Copy the matching [legacy fixture](../../examples/api-client/fixtures/order-legacy.json) or [partner fixture](../../examples/api-client/fixtures/order-partner.json), retain synthetic labels, and replace the partner fixture's enrolled account/operator IDs. Use a unique external order identity per merchant test.

Persist one operation key and the exact request bytes before the first send. Set `PACKPROOF_ORDER_FILE` and `PACKPROOF_OPERATION_KEY`, then run:

```sh
node examples/api-client/adapter.mjs
```

Save the returned Proof ID against the original merchant order in your database. Legacy intake returns the unchanged `{apiVersion,externalId,proof,links}` envelope. Organization import returns `{proofId,externalId,created}`; read `GET /v1/partner/proofs/{proofId}` for the canonical record. Neither response grants human confirmation authority.

After an unknown outcome, replay the original key and bytes or resolve the stable external binding. Do not generate another external order identity. Same key/different bytes yields `409 IDEMPOTENCY_CONFLICT`; changed bound content with a different key yields `409 EXTERNAL_ID_CONFLICT`. Permanent business uniqueness continues independently of replay records. The current implementation retains committed replay rows; a seven-day externally promised replay minimum requires operational retention approval before it is advertised.

### Monetary units and multi-item orders

| Field | Units and meaning |
| --- | --- |
| Legacy `transactionValue` | Declared numeric major currency units; it is not converted to integer minor units |
| Organization `transaction.amount.minorUnits` | Exact nonnegative integer decimal string in the selected currency's minor units; not a payment assertion |
| `transaction.items[].unitValue` | Optional declared numeric major currency units with at most four decimal places; currency is required when a value is supplied |

Legacy intake keeps `transaction.itemTitle` required for compatibility. Organization intake can derive that display title from authoritative lines. Optional `items` must contain 1–100 lines; each requires a title, and every supplied external line ID and position is unique. Quantity defaults to one per line; an explicitly supplied order quantity must equal the sum. Full line data is preserved before Proof creation and participates in immutable order identity. Unsupported split/mixed fulfillment needs review; a single root recording is not automatically evidence for unrelated parcels.

Common field bounds are 200 characters for identities/titles, 4,000 for item descriptions and 1–100,000 for quantities. The example input and acceptance fixture reader are capped at 65,536 bytes. The deployment's ingress limit remains authoritative.

## Complete capture through the supported host

Legacy `links.capture` opens the authenticated first-party Proof. For a partner bound launch, reuse [PartnerClient.capture](../../examples/merchant-receiver/partner-client.mjs) with a persisted capture request key. Deliver its short-lived fragment launch privately to the assigned operator. Do not log it. The launch locates the workflow; the operator still signs in with current rights.

Record one uninterrupted video, review the recording, and deliberately confirm the statement. The existing host uploads and finalizes as part of that ordinary flow. Keep its recovery journal/original when interrupted. Resume the same session after a supported disconnect/restart or expired authorization; lost responses are resolved from server state and preservation receipts. Retain independently obtained original and final-manifest SHA-256 values for acceptance.

Do not replace the existing admitted/resumable upload protocol with an unrestricted S3 PUT. Current bounds remain 5 MiB parts, at most 48 parts and 250,000,000 total bytes, with deployment admission/concurrency budgets. Metadata SDK retries do not renew expired upload authority.

## Receive, search and retrieve

Use the [durable merchant receiver](../../examples/merchant-receiver/README.md) and its PostgreSQL inbox/job schema. Mount exact raw-body parsing before JSON parsing. Acknowledge only after the event and reconciliation work commit. Verify the current HMAC secret over the exact original body and five-minute timestamp tolerance; retain any approved previous secret only for its explicit overlap. Rotation changes the sender's secret; old receiver material does not grant future sender authority.

Deduplicate logical event IDs, not timestamps or attempt IDs. The sender supplies a stable delivery ID and fresh attempt ID. Replays preserve event identity and re-read current authorized Proof state. Ten automatic attempts do not guarantee a 72-hour window; exercise durable replay/catch-up after a 24-hour outage before expansion.

Use the new search route and durable readiness, rather than assuming `FINALIZED` alone proves required preservation receipts exist:

```ts
import {PackProofClient} from '../../examples/api-client/client.mjs';
const client = new PackProofClient({
  apiOrigin: configuration.apiOrigin, credential: secrets.apiKey,
  merchantId: configuration.merchantId, delegationId: configuration.delegationId,
});
const page = await client.request('partner.searchPartnerProofs', {
  query: {q: merchantOrder.reference, state: 'READY', limit: 20},
});
const download = await client.request('partner.get__v1_partner_proofs_proofId_package', {
  path: {proofId: page.proofs[0].proofId}, stream: true,
});
```

Search supports order/tracking/Proof text, operational state, inclusive UTC creation dates and authorized connection selectors. `serverReceivedAt` is server receipt time, not physical filming time. Preserve the authenticated dashboard URL as the stable client link. Storage URLs and explicit guest grants expire separately. The current 90-day protection policy, holds and active stages remain authoritative; automatic physical deletion stays disabled.

The client is generated from checked-in OpenAPI. It exposes scoped service operations, typed responses, a 15-second metadata deadline, at most three attempts by default, bounded jitter and `Retry-After`. Mutations retry only where the contract declares idempotency and a stable key is supplied. A longer Retry-After is returned for scheduling instead of retrying early. Streaming exports clear the metadata deadline after headers; apply an explicit caller transfer deadline. Snapshot allocation intentionally receives no automatic retry.

Use `GET /v1/partner/proofs/{proofId}/external-bindings` for the current authorized association graph. Follow its signed keyset pages, and restart from the beginning on `proof.external_binding_added` or relevant `proof.updated` events. Its `LIVE_KEYSET_RESTART_ON_CHANGE` result is a current listing, not a frozen snapshot; cursor expiry also requires a restart. The fifteen-minute cursor is bound to the exact Proof and current actor, with a configured maximum of one hour. Binding `createdAt` is server association time. Appended bindings retain integration provenance and cannot change the finalized core.

For complete catch-up, allocate `POST /v1/partner/proof-snapshots`, page its frozen rows with current authorization, reconcile current GETs, then consume `eventCursor` through `/event-stream` and deduplicate event IDs. Release the projection when finished. Expired snapshot/feed cursors require a fresh resync. Snapshots expire after one hour and contain at most 10,000 rows; four active snapshots per credential are permitted. The implemented stream remains commit-safe; no new raw-sequence publisher is introduced.

## Execute the independent HTTPS probe

The runner imports only example/client and Node standard modules, and uses the public HTTPS API. It refuses production environments and never creates a human attestation. A deterministic fixture describes failure expectations; it does not manufacture camera, provider, storage or disaster-recovery receipts.

Set `PACKPROOF_EXPECTED_SHA` to the exact deployed candidate. With the synthetic order fixture, set `PACKPROOF_ACCEPTANCE_SYNTHETIC=1`, `PACKPROOF_ACCEPTANCE_REPORT` to a private output path, and run:

```sh
node examples/api-client/external-acceptance.mjs intake
```

This performs ten concurrent creates, identical replay, changed-payload conflicts and configured denied reads. It returns the one Proof ID. Complete actual operator capture for that same record, then set:

| Variable | Independent input |
| --- | --- |
| `PACKPROOF_INTAKE_REPORT` | Saved intake report from the same candidate and canonical Proof |
| `PACKPROOF_COMPLETED_PROOF_ID` | The same canonical Proof after supported operator capture |
| `PACKPROOF_EXPECTED_MANIFEST_SHA256` | Digest retained separately from the downloaded package |
| `PACKPROOF_EXPECTED_SOURCE_SHA256` | Digest retained from the original recording |
| `PACKPROOF_OTHER_API_KEY`, `PACKPROOF_OTHER_MERCHANT_ID`, `PACKPROOF_OTHER_DELEGATION_ID` | Separately enrolled merchant context for denied access |
| `PACKPROOF_REVOKED_API_KEY`, corresponding `PACKPROOF_REVOKED_MERCHANT_ID` / `PACKPROOF_REVOKED_DELEGATION_ID` | Previously revoked staging credential |
| `PACKPROOF_WEBHOOK_SECRET` | Trusted receiver secret from secure configuration |
| `PACKPROOF_WEBHOOK_BODY_FILE`, `PACKPROOF_WEBHOOK_SIGNATURE` | Exact received raw body and header |
| `PACKPROOF_WEBHOOK_RECEIVED_AT_SECONDS` | Independently recorded receiver time; defaults to current time |
| `PACKPROOF_EVENT_CURSOR` | Optional prior committed feed cursor |

```sh
node examples/api-client/external-acceptance.mjs complete --require-release-gates
```

The complete probe checks finalization, original/manifest pins, durable receipts, searchable readiness, complete package bytes, deliberate tamper rejection, finalization catch-up, actual signed receiver delivery, tenant denial and revocation. Missing inputs remain pending and strict mode fails. This qualifies only those HTTP-boundary checks. Physical interruption, live provider/browser-closed import, 24-hour outage duration, load/cost, isolated restore and independent security review remain distinct exact-candidate release gates.

The bounded stored-ZIP probe checks hashes and independent pins. It does not establish signer trust or physical truth. Obtain [the portable verifier](../../verifier/verify.py) and trusted key material independently for signature and trust-history verification.

## Contract and client checks

```sh
node examples/api-client/generate.mjs --check
node --test examples/api-client/*.test.mjs
node backend/node_modules/typescript/bin/tsc -p examples/api-client/tsconfig.json
```

Use `node examples/api-client/generate.mjs` after intentional schema changes and review both generated files. Import [the Postman collection](../../examples/api-client/packproof.postman_collection.json) for manual HTTPS inspection; credentials have no saved values and capture confirmation is never automated.
