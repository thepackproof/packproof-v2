# PackProof Public API v1

The public contract translates a confirmed merchant order into the same authoritative Proof used by the mobile and web applications. It does not create a separate partner evidence system. Machine-readable contract: [`backend/openapi.json`](../backend/openapi.json), also served without authentication at `GET /v1/openapi.json`.

## Start in the sandbox

Use Node 22 and Python 3 (only for independent package verification). From the repository:

```sh
npm ci --prefix backend
npm ci --prefix mobile
npm ci --prefix web
cp backend/.env.example backend/.env
cd backend
npm start
```

In a second terminal, run `npm run dev --prefix web`. Open `http://127.0.0.1:5173`, use a synthetic development identity, complete the profile, and open **Account → Developer access**. Create a sandbox tenant and issue only the scopes the integration needs. The raw key appears once; store it in your server's secret manager. Key rotation immediately revokes the old key. Browser apps and mobile bundles must never contain partner keys.

Sandbox/live keys have separate tenant bindings, external-ID namespaces, rate budgets, and key prefixes. Both use the same domain validators. An environment label is not a separate database or a simulated carrier; use a separate staging deployment and synthetic data for integration experiments. Do not connect sandbox tests to live provider side effects.

```sh
# Set PACKPROOF_API_KEY using your secret manager or private shell environment.
export PACKPROOF_API_URL=http://127.0.0.1:3000
node examples/merchant-adapter.mjs examples/sandbox-order.json
```

The reference adapter uses only `/v1`; replacing it cannot mutate or corrupt the core. Its order fixture is synthetic. It does not attest, finalize, or send notifications on a person's behalf.

## Identity and request rules

- Send `Authorization: Bearer pp_sandbox_…` or `pp_live_…`. Keys never authenticate private first-party routes; first-party user tokens never authenticate `/v1`.
- Every POST and DELETE requires `Idempotency-Key` (1–200 characters). Reuse the exact method, path, key, and JSON body after transport failures. The result and mutation commit atomically. Changed payloads return `409 IDEMPOTENCY_CONFLICT`; failed domain actions roll back and can be corrected.
- Evidence-part PUTs are naturally idempotent by evidence ID, part number, and exact bytes; no extra idempotency header is required. Replacing a received part with different bytes returns 409.
- Keys act as the tenant owner's recorded identity. They cannot supply another actor's identity or impersonate a receiver. Participant invitations require the recipient's own authenticated acceptance. The first release has one tenant owner, not delegated organization membership.
- Each Proof is bound to exactly one API tenant. Even two tenants with the same owner cannot read each other's Proofs through their keys. Native user authorization remains participant based.
- The tenant-wide limit is 120 requests per minute, shared across its keys. Honor `429` and `Retry-After: 60`. Retry transport/5xx failures with backoff and jitter; inspect other 4xx responses. Do not retry a changed request under the original key.
- Responses include `X-Request-Id`, `PackProof-API-Version: v1`, and `Cache-Control: no-store`. API request audit stores operation templates, actor/key/tenant, time, and status, never bearer values or raw request bodies. Key management has a separate audit trail. Unauthenticated abuse is handled by the deployment edge/access logs.

| Scope | Permission |
|---|---|
| `proofs:read` | Read tenant Proofs, verified evidence bytes, review, manifests and packages |
| `proofs:write` | Create Proofs, create viewing links, manage preservation requests |
| `participants:write` | Invite participants/receivers; identity acceptance rules still apply |
| `evidence:write` | Initialize, resume and commit evidence; create lifecycle stages |
| `attestations:write` | Record the owner's attestation; finalize that actor's lifecycle stage |
| `proofs:finalize` | Finalize the core after all domain requirements are satisfied |
| `events:read` | Read neutral domain events for the tenant |
| `webhooks:manage` | Manage subscriptions, rotate signing secrets, inspect/retry dead deliveries |
| `intake:write` | Normalize pasted/shared/forwarded text into an unconfirmed draft |

## Transaction in, Proof out

```http
POST /v1/proofs
Authorization: Bearer <server-side-api-key>
Idempotency-Key: order-1001
Content-Type: application/json

{
  "externalId": "merchant-order-1001",
  "transaction": {
    "itemTitle": "Collectible card",
    "quantity": 1,
    "transactionValue": 3000,
    "currency": "USD",
    "shipping": {"carrier": "UPS", "trackingNumber": "confirmed-tracking-number"}
  }
}
```

The response is `{apiVersion, externalId, proof, links}`. `proof.proofId`, `proof.transactionId`, and `proof.status` are server assigned. `links.capture` and `links.viewer` open the authenticated first-party application; they are not bearer capture grants. The owner signs in to capture. Create an explicitly scoped, expiring viewing link to give a guest read access. Repeating an external order ID with different transaction content returns `EXTERNAL_ID_CONFLICT`, even under a new idempotency key.

`GET /v1/proofs` returns up to 50 Proof envelopes, `nextCursor`, and `hasMore`. Pass `after` to continue. `GET /v1/proofs/{id}` reads a single tenant Proof. In this contract, the external merchant ID lives in the tenant binding and provenance metadata rather than the older globally unique `externalReference` field.

## Capture and finalization

1. `POST /proofs/{id}/evidence` with `contentType` and `evidenceType: "FULFILLMENT_CAPTURE"` returns `evidenceId` and a short-lived upload target. Preserve the init idempotency key locally before beginning.
2. Upload directly to the returned target, or use resumable uploads: GET `…/evidence/{evidenceId}/parts`; PUT numbered binary parts to `…/parts/{partNumber}`; POST `…/parts/complete` with `{totalBytes}`. Parts are 5 MiB except the final part; maximum 40 parts / 200 MiB. Completion assembles and independently checks all parts.
3. POST `…/evidence/{evidenceId}/commit` with an optional expected `sha256`. PackProof independently verifies bytes and metadata, then preserves content-addressed evidence. An upload target alone never counts as committed evidence.
4. POST `…/attestations` with `statement: "PACKED_DESCRIBED_ITEM"` only after the actual seller has confirmed the statement. Recording a service action as another human is not permitted.
5. POST `…/finalize` seals the canonical core manifest if its evidence, participation, and attestation rules pass. Repeated finalization returns the original manifest. GET `…/manifest` retrieves it.

If the commit response is lost, first GET the Proof. A committed evidence ID is complete; do not reinitialize it or replace its bytes. To abandon a pending upload, POST `…/evidence/discard` with the original `uploadIdempotencyKey` and a new mutation idempotency key. Discard marks the upload rejected and leaves an audit record. Committed evidence cannot be discarded.

Resumable uploads renew private authorization on retry. A cached direct-upload URL can expire; use the resumable route after expiration. Body buffering and package generation are bounded for the pilot, not a high-throughput video service. Capacity/load testing is a release gate.

## Order intake

POST `/order-intake` with `{text, source: "paste" | "share" | "email"}`. The deterministic parser accepts up to 20,000 characters, handles labeled text and simple HTML, flags ambiguous fields and missing currency, and returns `{draft, warnings, requiresConfirmation: true}`. Confirm or correct the draft before creating a Proof. Intake text never executes instructions and is not treated as trusted participant identity. Raw source text is not persisted by the service; provenance retains source type and SHA-256.

The Android share handler accepts text/plain and text/html through the native share sheet, including cold starts. iOS has paste intake; an iOS share extension is not included. `source: "email"` accepts content delivered by an authenticated integration. A public inbound mailbox has not been provisioned; no broad Gmail/mailbox permission is requested or implied.

## Signed events

POST `/webhooks` with `{url, eventTypes}`. The HTTPS hostname must be in the operator's exact allowlist. The response returns the signing secret; store it privately. It is encrypted in the database and in cached creation/rotation responses. API signing and encryption secrets must not appear in client code or logs.

| Event | Meaning |
|---|---|
| `proof.created` | Canonical Proof exists |
| `participant.joined` | Canonical participant accepted/was created |
| `evidence.uploaded` | Server has verified received evidence bytes at commit |
| `evidence.committed` | Evidence is preserved immutably |
| `capture.completed` | Qualifying seller capture and packing attestation exist; emitted once |
| `shipment.updated` | A shipment observation was appended |
| `proof.finalized` | Canonical core manifest is frozen |
| `proof.accessed` | An audited API/review access or first guest-link view occurred |

Events carry `{id, type, apiVersion, tenantId, createdAt, data: {proofId}}`. No media, storage keys, raw source records, or personal data is embedded. Retrieve detail with a scoped key. `evidence.uploaded` and `evidence.committed` represent one verified commit, not two independently timed observations. Receipts/returns have their own immutable lifecycle audit entries; they do not refire `proof.finalized`.

Delivery headers include `PackProof-Event-Id` and `PackProof-Signature: t=<unix-seconds>,v1=<hex-hmac>`. Verify HMAC-SHA256 of `<timestamp>.<exact raw request body>` with the subscription secret, constant-time comparison, and a five-minute clock tolerance. See `verifyEvent` in the reference adapter. Persist event IDs before applying idempotent merchant effects; acknowledge accepted work quickly with 2xx.

The transactional outbox survives application restarts. Workers claim database leases, pin DNS to approved public addresses, use bounded DNS/TLS requests, refuse redirects, and retry with backoff/jitter up to ten attempts. Delivery is **at least once**; duplicates and out-of-order events are possible. Non-2xx responses retry. Revoke a subscription with DELETE `/webhooks/{webhookId}`. POST `…/rotate-secret` returns a replacement secret; coordinate rotation because in-flight attempts may still carry the old signature. GET `/webhook-deliveries` shows the latest 100 deliveries; POST `/webhook-deliveries/{deliveryId}/retry` requeues a dead delivery for an active subscription.

GET `/events` or `/proofs/{id}/events` returns up to 100 events with a sequence cursor. Database sequence allocation precedes commit: under concurrent writers, a late commit can appear below a previously observed cursor. Use the durable webhook channel for reliable notification; periodically reconcile known Proofs or reread overlapping event pages and deduplicate IDs. There is no claim of exactly-once delivery or total commit ordering. New subscriptions receive subsequent events, not a backfill of historical events predating the subscription or this migration.

## Viewer, lifecycle, retention, and export

POST `/proofs/{id}/access-links` defaults to a one-hour summary link; `scope: "EVIDENCE_VIEW"` explicitly grants media access. Links are revocable through the participant account, bearer tokens are hashed, maximum requested lifetime is 90 days, and first-party sharing defaults to seven days. SUMMARY/STATUS_ONLY links cannot fetch evidence bytes. Sharing and participation are separate permissions.

GET `…/review` returns the Proof, access history, manifest digest check, shipment supplement, and retention state. GET `…/package` downloads a `.pkpr` ZIP with frozen core data and finalized lifecycle supplements. It contains original evidence, manifests and SHA-256 indexes. Verify independently:

```sh
python backend/scripts/verify-proof-package.py proof.pkpr --expected-manifest-sha256 <separately-obtained-digest>
```

Without an independently obtained digest, verification establishes self-consistency, not origin. Manifest signatures and trusted timestamp authorities remain explicit future work. A hash proves neither the truth of a participant statement nor continuity outside the recorded observations.

`/proofs/{id}/lifecycle` extends a finalized commerce Proof with RECEIPT → RETURN_PACKING → RETURN_RECEIPT. The original manifest remains unchanged. The targeted receiver accepts through their account; the receiver owns the first two stages, and the original seller owns returned delivery. Each stage commits its media and seals its own attestation/manifest linked to the original and previous stage. An unfinished stage upload can be discarded through `…/stages/{stageId}/evidence/{evidenceId}/discard`, leaving an audit record. It cannot discard committed evidence. Browser receipt uploads retry while the page remains open; after a refresh, discard the unfinished upload and select the original recording again. The API enforces the key owner's role, so a seller's key cannot capture or attest as the receiver.

`/proofs/{id}/retention` exposes the 90-day window from the latest finalized stage, holds, active-stage blockers and deletion-review requests. POST `…/holds` to preserve with a reason; DELETE `…/holds/{holdId}` releases only the issuer's hold. POST `…/deletion-requests` requests review. These actions never bypass immutable evidence. Physical deletion, backup expiry and storage-lock requirements must be assessed by an authorized operator; this release does not automatically destroy records at day 90.

## Deployment configuration

Set `PACKPROOF_WEBHOOK_ENCRYPTION_KEY` to a base64-encoded 32-byte secret, injected from Secrets Manager, and `PACKPROOF_WEBHOOK_HOSTS` to exact permitted DNS hostnames. The in-process worker starts only when both are configured. `PACKPROOF_WEBHOOK_WORKER=false` disables dispatch. Existing pending work remains in PostgreSQL. Use a separate master key in staging/live, preserve it across deployments, and plan decrypt/re-encrypt migration before master-key rotation.

Run migrations before opening the API listener. Migrations are additive and transactional per file. Never roll back by deleting evidence tables. Restore application compatibility while retaining new tables if deployment fails. The durable S3 template uses SSE-S3 managed encryption and a 90-day governance Object Lock floor; existing database encryption policies remain authoritative. See [release and pilot gates](PILOT_RUNBOOK.md) before production expansion.
