# PackProof Public API v1

The public contract translates a confirmed merchant order into the same authoritative Proof used by the mobile and web applications. Machine-readable legacy contract: [`backend/openapi.json`](../backend/openapi.json), also served without authentication at `GET /v1/openapi.json`.

## Profiles, candidate scope and release evidence

This document's unprefixed route examples are relative to **`/v1`** and describe the compatible owner-key profile unless explicitly labeled otherwise. That profile retains `POST /v1/proofs` and its `{apiVersion, externalId, proof, links}` envelope.

The additive **organization/partner profile** uses `/v1/partner`, its own [contract](../backend/partner-openapi.json), and `/me/organizations` for authenticated human administration. It reuses the canonical transaction, Proof, capture, attestation, recovery and export services. Its merchant organization, service principal, membership and delegation records distinguish software from the recording person; its response meanings are not substitutes for the legacy envelope. Do not create a second grant or capture system from older roadmap descriptions.

Organization source was already present at baseline `e4f69c9a690649c41b846468eb48829fb0542617`. Historical isolated-cloud results and a disabled production rollout are recorded in [the organization foundation](partner-foundation/README.md). They do not certify a new candidate, current production configuration, live provider access or physical-device recovery. Enrollment remains a controlled pilot; a feature flag alone never authorizes a merchant.

The October 28 API/client candidate adds reconciliation, discovery, partner delivery operations and developer tooling. See the [capability ledger](api-client-release/CAPABILITY_LEDGER.md) and [release gates](api-client-release/RELEASE_GATES.md) for exact source/configuration/validation distinctions. New candidate checks are pending until recorded against the integrated commit; no full-plan completion or production expansion is implied.

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

Developer access is restricted to active accounts whose Cognito-verified email is exactly `nericollin@gmail.com`, `nericollin@thepackproof.com`, or `admin@thepackproof.com` (case-insensitive). Synthetic development identities, other domain members, and email aliases do not receive developer access. Configure Cognito for interactive developer work; API tests use explicit privileged fixtures in isolated test databases.

Sign in with an approved verified account and open **Account → Developer access**. Create a sandbox tenant and issue only the scopes the integration needs. The raw key appears once; store it in your server's secret manager. Key rotation immediately revokes the old key. Browser apps and mobile bundles must never contain partner keys.

`GET /me/developer-access` returns the authenticated account's current `{ allowed: boolean }` capability with `Cache-Control: private, no-store`. The apps refresh verified identity claims before requesting it and never persist the capability. All legacy workspace/key management routes, existing owner API keys, and outbound developer webhooks independently enforce the same server-side allowlist. Losing eligibility blocks access without deleting workspaces, keys, or historical Proofs.

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
- Keys act as the tenant owner's recorded identity. They cannot supply another actor's identity or impersonate a receiver. Participant invitations require the recipient's own authenticated acceptance. The owner-key profile has one tenant owner. Delegated organizations use the separately authorized partner profile; a partner service credential has no personal-attestation authority.
- Each Proof is bound to exactly one API tenant. Even two tenants with the same owner cannot read each other's Proofs through their keys. Native user authorization retains participant rules and rechecks current organization authority for assigned organization operators.
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

The response is `{apiVersion, externalId, proof, links}`. `proof.proofId`, `proof.transactionId`, and `proof.status` are server assigned. `links.capture` and `links.viewer` open the authenticated first-party application; they are not bearer capture grants. The owner signs in to capture. Partner imports instead assign an actual authorized operator and issue a bound capture intent through `/v1/partner/proofs/{id}/capture-intents`; the person still signs in and personally confirms. A service principal cannot attest. Create an explicitly scoped, expiring viewing link to give a guest read access. Repeating an external order ID with different transaction content returns `EXTERNAL_ID_CONFLICT`, even under a new idempotency key.

`GET /v1/proofs` retains its compatible envelope listing, `nextCursor`, and `hasMore`; pass `after` to continue. Candidate discovery/filter additions are additive and must use the contract and query-bound pagination documented for their endpoint. `GET /v1/proofs/{id}` reads a single tenant Proof. In this contract, the external merchant ID lives in the tenant binding and provenance metadata rather than the older globally unique `externalReference` field.


## Candidate discovery, items and reconciliation

The additive search endpoints are `GET /v1/proofs/search` for owner keys, `GET /v1/partner/proofs/search` for current partner authority, and `GET /me/proofs/search` for an authenticated first-party user. They preserve existing list routes. Queries accept:

| Query | Meaning |
| --- | --- |
| `q` | Authorized order reference, tracking number or Proof ID search |
| `state` | Presentation filter: `AWAITING_CAPTURE`, `IN_PROGRESS`, `READY` or `NEEDS_ATTENTION` |
| `from`, `through` | Inclusive UTC created dates, `YYYY-MM-DD` |
| `connectionId`, `integrationAccountId` | Authorized connection/source filters; a supplied ID is not an access grant |
| `limit`, `after` | 1–50 rows and opaque signed continuation cursor |

Search cursors expire after one hour and bind actor/credential/delegation and filters. Ordinary search pages show current authorized state; they are **not** the materialized reconciliation snapshot. Start a new search after expiry or a filter change. The opt-in first-party client review UI uses `VITE_PACKPROOF_CLIENT_DASHBOARD=true`; its visible-page refresh pauses while hidden. Server cursor signing requires `PACKPROOF_EVENT_CURSOR_KEY`.

The organization import candidate accepts an optional bounded `transaction.items` array (1–100 authoritative lines), stored through existing `transaction_items` before creating the root. Preserve every line in the immutable source snapshot. Existing single-item requests retain their replay meaning. Order `amount.minorUnits` is an integer decimal **string in currency minor units**. Item `unitValue` uses the existing **major-unit decimal** representation (database `NUMERIC(19,4)`); do not convert it as though it were minor units or silently reinterpret the legacy `transactionValue` contract. Read the exact schema for required fields, bounds and conflicts.

A client with both `proofs:read` and `events:read` can create a fresh snapshot with `POST /v1/partner/proof-snapshots`, page it with `GET /v1/partner/proof-snapshots/{snapshotId}?after=...`, and release it with `DELETE /v1/partner/proof-snapshots/{snapshotId}`. Pages and the stream cutover boundary share one saved database snapshot; this is separate from mutable search. Current authority is checked on every use. The projection expires after one hour, permits at most four active snapshots per credential and at most 10,000 Proofs, and rejects excess rather than truncating. Materialization is additionally bounded to 16 MiB total and 256 KiB per row. Snapshot expiry or retained-feed expiry requires restarting reconciliation.


Owner-authenticated `GET /me/commerce-connections/{connectionId}/health` projects the actual registered order capability, automation consent/pause, last successful source-read watermark, freshness, resumable page work, pending inbox work and a specific next action. Coverage is limited to discovered source records: excluded/unsupported work remains visible, and eligible rows distinguish missing Proof, awaiting capture, in progress, canonical finalized and other states. **Canonical finalized is not a durable Ready count.** This projection cannot count orders the provider has never exposed. See [order identity and coverage](api-client-release/ORDER_IDENTITY.md).

## Capture and finalization

1. `POST /proofs/{id}/evidence` with `contentType` and `evidenceType: "FULFILLMENT_CAPTURE"` returns `evidenceId` and a short-lived upload target. Preserve the init idempotency key locally before beginning.
2. Send a fixed Content-Length to the admitted upload target, or use resumable uploads: GET `…/evidence/{evidenceId}/parts`; PUT numbered binary parts to `…/parts/{partNumber}`; POST `…/parts/complete` with `{totalBytes}`. Parts are 5 MiB except the final part; at most 48 parts and 250,000,000 total bytes. Admission and cumulative retry budgets are charged before reading a body. Completion streams and independently verifies all parts. A renewed contract invalidates its prior token; `upload.received: true` means skip retransmission and continue commitment. Direct presigned storage PUT contracts are not issued. See [media admission and versioned playback](program-2026-09-07/media-admission-and-versioned-playback.md).
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

GET `/events` or `/proofs/{id}/events` retains its legacy sequence cursor and concurrency caveat: a late commit can appear below an observed raw sequence. It is not a dependable high-water mark.

Use the existing signed **`GET /v1/event-stream`** or authorized **`GET /v1/partner/event-stream`** for commit-safe catch-up. Migration 088 assigns publication positions through a per-tenant counter locked in the source transaction; deferred triggers cover outbox writes and initial tenant binding, and the migration backfills under a writer-blocking lock. This is already implemented; an additional broker or competing publisher is unnecessary. Publication order is not physical event chronology. Deduplicate logical event IDs and read current authorized Proof state.

Event-stream cursors are tenant/environment/query bound and currently expire after **at most seven days**. That cursor lifetime is not a measured delivery guarantee or a promise of 30-day retained replay. The plan's 30-day replay/change-history objective remains a separately measured configuration/retention gate. Expired cursors or a history floor return an explicit resync requirement; never silently reset a stored cursor.

The candidate adds `POST /v1/partner/proof-snapshots` and `GET /v1/partner/proof-snapshots/{snapshotId}` for bounded reconciliation. A fresh REPEATABLE READ transaction atomically saves authorized summary rows with committed boundary C. Pages remain stable for their documented one-hour lifetime and recheck current credential/delegation authority. Fetch current authorized details as needed, then consume the existing stream after the returned `eventCursor`, deduplicating events. Restart when the snapshot or retained boundary expires. These are candidate interfaces pending exact-commit validation; consult the machine contract and [release gates](api-client-release/RELEASE_GATES.md).

Delivery remains at least once. New webhook subscriptions receive subsequent events, not an automatic historical backfill. Existing signature bytes, event IDs and five-minute verification tolerance remain unchanged. Partner delivery diagnostics, encrypted secret rotation and dead-delivery retry are documented in [webhook operations](api-client-release/WEBHOOKS.md). Ten attempts are not a promised 24-hour or 72-hour automatic retry horizon. Coordinate immediate secret rotation by temporarily accepting old and new secrets at the receiver for in-flight attempts; this is receiver overlap, not a claim of server-side retired-key history.

## Viewer, lifecycle, retention, and export

POST `/proofs/{id}/access-links` defaults to a one-hour summary link; `scope: "EVIDENCE_VIEW"` explicitly grants media access. Links are revocable through the participant account, bearer tokens are hashed, maximum requested lifetime is 90 days, and first-party sharing defaults to seven days. SUMMARY/STATUS_ONLY links cannot fetch evidence bytes. Sharing and participation are separate permissions.

Partner link creation stores its replay response encrypted with AES-GCM because that response contains a bearer viewing token. Configure `PACKPROOF_WEBHOOK_ENCRYPTION_KEY` (a base64-encoded 32-byte server secret) before using this endpoint, even if outbound webhooks are disabled. Without it, link creation returns `503 ACCESS_LINKS_UNAVAILABLE` and creates no link. Other partner read, capture and finalization endpoints and first-party sharing do not require this key. Keep the key stable across deployments so existing encrypted replay responses remain readable.

Cached viewing-link responses written before this hardening are encrypted on their next authorized replay, preserving the original link. Before production expansion, operators must inventory remaining legacy plaintext cache rows and have the original authorized callers replay them, or expire those caches under an approved retention policy. Replay encryption binds the original `Idempotency-Key`; PostgreSQL stores only its hash, so a bulk rewrite cannot reconstruct that context from the database and server secret alone. Deploying code does not rewrite untouched historical responses.

GET `…/review` returns the Proof, access history, manifest digest check, shipment supplement, and retention state. GET `…/package` downloads a `.pkpr` ZIP with frozen core data and finalized lifecycle supplements. It contains original evidence, manifests and SHA-256 indexes. Verify independently:

```sh
python backend/scripts/verify-proof-package.py proof.pkpr --expected-manifest-sha256 <separately-obtained-digest>
```

Without an independently obtained digest, verification establishes self-consistency, not origin. Manifest-signing and KMS runtime code, plus an additive detached JCS/ES256 integrity-envelope profile, now exist. Inspect the actual configured signer, key history, frozen manifest and verification result; source presence does not mean every deployment signs or that a timestamp authority is configured. See [the envelope profile and activation boundary](partner-foundation/ENVELOPE-PROFILE.md). The legacy verifier invocation above checks the package/digest contract; use the independent envelope verifier for that separate profile. A hash or valid signature proves neither the truth of a participant statement nor continuity outside the recorded observations.

`/proofs/{id}/lifecycle` extends a finalized commerce Proof with RECEIPT → RETURN_PACKING → RETURN_RECEIPT. The original manifest remains unchanged. The targeted receiver accepts through their account; the receiver owns the first two stages, and the original seller owns returned delivery. Each stage commits its media and seals its own attestation/manifest linked to the original and previous stage. An unfinished stage upload can be discarded through `…/stages/{stageId}/evidence/{evidenceId}/discard`, leaving an audit record. It cannot discard committed evidence. Browser receipt uploads retry while the page remains open; after a refresh, discard the unfinished upload and select the original recording again. The API enforces the key owner's role, so a seller's key cannot capture or attest as the receiver.

`/proofs/{id}/retention` exposes the 90-day window from the latest finalized stage, holds, active-stage blockers and deletion-review requests. POST `…/holds` to preserve with a reason; DELETE `…/holds/{holdId}` releases only the issuer's hold. POST `…/deletion-requests` requests review. These actions never bypass immutable evidence. Physical deletion, backup expiry and storage-lock requirements must be assessed by an authorized operator; this release does not automatically destroy records at day 90.

## Deployment configuration

Set `PACKPROOF_WEBHOOK_ENCRYPTION_KEY` to a base64-encoded 32-byte secret, injected from Secrets Manager, and `PACKPROOF_WEBHOOK_HOSTS` to exact permitted DNS hostnames. The in-process worker starts only when both are configured. `PACKPROOF_WEBHOOK_WORKER=false` disables dispatch. Existing pending work remains in PostgreSQL. Use a separate master key in staging/live, preserve it across deployments, and plan decrypt/re-encrypt migration before master-key rotation.

Run migrations before opening the API listener. Migrations are additive and transactional per file. Never roll back by deleting evidence tables. Restore application compatibility while retaining new tables if deployment fails. The durable S3 template uses SSE-S3 managed encryption and a 90-day governance Object Lock floor; existing database encryption policies remain authoritative. See [release and pilot gates](PILOT_RUNBOOK.md) before production expansion.

Use `GET /proofs/{id}/recovery` with `proofs:read` to poll authoritative preservation receipts after pending or lost commit/finalize responses. A cached idempotent finalize response does not itself establish that its recovery envelope has become durable.


## Durable readiness and candidate acceptance

Canonical lifecycle stays `READY_FOR_EVIDENCE → EVIDENCE_COMMITTED → FINALIZED` for the ordinary path. Capture, upload, preservation, export and notification health remain separate projections. A failed notification cannot unfinalize a Proof.

For the controlled API/client workflow, **Ready requires authoritative finalization and the required durable preservation receipts**. An upload target, local success screen, cached finalize replay, missing declaration or `LEGACY_UNCONFIRMED` receipt cannot establish Ready. See [durable recovery](DURABLE_RECOVERY_AND_RETENTION.md). Existing compatibility finalization can expose logical completion without that stronger assurance, which must remain visible as unconfirmed. Media retention/access and signing status are separate disclosures.

The candidate must run its standalone external HTTPS acceptance path without importing domain modules, plus the repository's real isolated PostgreSQL concurrency checks and current web/mobile regressions. Physical camera/device recovery, a real consenting merchant/provider loop, public-boundary load, fresh-target restore and independent security review remain explicit release gates. Read [RELEASE_GATES.md](api-client-release/RELEASE_GATES.md); a source merge or green mocked suite alone does not close those gates.
