# Partner SDK contract and validation

The repository contains a Node.js 22 client with TypeScript declarations in `packages/partner-sdk-typescript` and a Python 3.10 client in `packages/partner-sdk-python`. Both are version 0.1.0 candidates with no runtime dependencies. They wrap the existing `packproof.partner/v1` contract and preserve unknown response fields. They are not a claim of general availability or registry publication.

## Supported behaviors

| Behavior | Contract |
| --- | --- |
| Authentication | Server-held bearer credential, optional exact merchant and delegation selectors. No browser service keys. |
| Requests | HTTPS base URL; API-relative paths only; credentials/query/fragment in the base URL rejected; redirects refused. Local HTTP requires an explicit localhost development option. |
| Timeouts | Default 15 seconds per request attempt; configurable upper bound of 300 seconds. |
| Retries | Default three attempts, maximum five. Reads can retry; mutations retry only with an explicit stable idempotency key. Typed mutation helpers require a key. |
| Retry responses | 408, 429, 500, 502, 503, 504 and transport failures. 401, 403, 409, 410, and 412 surface directly. Retry-After is honored up to 30 seconds; other delays use bounded exponential backoff with jitter. |
| Diagnostics | Response status, headers, request ID, replay flag, unmodified parsed response data and the original response body (`rawBody` / `raw_body`); errors preserve safe server problem details and request ID. No automatic logging. |
| Pagination | Opaque signed cursors, explicit maximum page count, and detection of nonadvancing cursors. No integer conversion of stream sequences. |
| Polling | Poll a returned API-relative operation path with a bounded deadline. Failed, partially succeeded, and action needed states remain explicit results; callers inspect per-item outcomes. The client must have the correct credential type for the returned route. |
| Concurrency | `If-Match` can be passed through `request` for revision-protected changes. The SDK does not overwrite a stale revision automatically. |
| Webhooks | Exact original byte HMAC verification, constant-time comparison, and five-minute timestamp tolerance. Durable event deduplication belongs to the receiving application. |

Typed helpers cover Proof create/read/resolve/list, normalized source ingestion/operation polling, operational record/timeline/evidence/requirements reads, revision-protected metadata/lifecycle/amendment/entity/evidence-link commands, scoped issue actions, limits, read-only connection inventory, narrow-scope audit events, assigned capture requests, committed event-stream reads, and webhook create/list/revoke/delivery/replay. The low-level request method supports additive documented routes without hiding raw responses. Human spreadsheet imports are under `/me/records/imports`; a partner service credential cannot poll them as a human. Upload resumption and signed-package verification use their existing dedicated protocols; these SDKs do not claim to implement a new generic upload or replace the [offline verifier](../../verifier/README.md).

`createIngestion` / `create_ingestion` accepts up to 100 normalized observations or 256 KiB, with a stable source event ID, existing source-bound Proof ID and explicit reported time. It returns a durable receipt; `waitForOperation` / `wait_for_operation` polls the normalized-ingestion resource and preserves conflict, failed and partial outcomes. Source assurance remains `organization_submitted`; a source assertion is not promoted to trusted carrier evidence or human attestation. Changed bytes under an existing scoped source event ID retain both receipts and produce a conflict.

For a record correction, read `getRecord` / `get_record`, take `record.revision`, and pass it as `revision` with the stable idempotency key. The SDK sends the quoted `If-Match`. A 412 requires a refreshed record and deliberate reconciliation; it never silently reapplies the change to a newer revision.

Record detail includes the first 50 timeline/evidence items and `timelineNextCursor` / `evidenceNextCursor`. Use `timelinePages` / `timeline_pages` and `evidencePages` / `evidence_pages` for more. Child cursors are bound to the record, organization, environment, caller and page size; keep the same `limit` while resuming. Requirements currently return a bounded complete array rather than a cursor page.

The signed-in workspace exposes current records, attention items, due requirements, traceable human review and waivers, connection health and administrator controls, gated workspace registration, original media, and a finalized core evidence-package download. Its original/package routes recheck current access while streaming. An exported core package covers its frozen inventory; the current operational view explicitly labels later notes, relationships, requirements and review actions as separate. The clients' JSON request helpers are for metadata; they do not reinterpret binary media as JSON or claim a new signed operational export.

## Webhook profile

The current compatible wire format is:

```text
PackProof-Event-Id: evt_...
PackProof-Signature: t=<unix-seconds>,v1=<64 lowercase hexadecimal characters>
```

The expected MAC is `HMAC-SHA256(secret, ASCII(timestamp) || "." || originalBodyBytes)`. The complete `whsec_...` secret string is the HMAC key encoded as UTF-8. The SDK checks the timestamp against its clock before accepting the signature. Synchronize receiver clocks. Verify before JSON parsing; whitespace, Unicode encoding, and every byte are significant. After verification, use the signed payload's `id` for durable deduplication and require any untrusted delivery-ID header to agree if you use it.

```ts
import { verifyWebhook } from '@packproof/partner-sdk';
const valid = verifyWebhook({
  secret: process.env.PACKPROOF_WEBHOOK_SECRET!,
  signature: receivedSignatureHeader,
  rawBody: receivedBuffer,
});
if (!valid) throw new Error('Reject webhook');
const event = JSON.parse(receivedBuffer.toString('utf8'));
// Atomically store event.id and enqueue work before returning 2xx.
```

```python
from packproof import verify_webhook
if not verify_webhook(secret, signature_header, original_request_bytes):
    raise ValueError('Reject webhook')
event = json.loads(original_request_bytes)
# Atomically store event['id'] and enqueue work before returning 2xx.
```

The plan's Standard Webhooks adoption requires a separately versioned compatible rollout. These clients deliberately verify the currently implemented PackProof header profile. Do not send Standard Webhooks headers to a receiver expecting this profile without an explicit migration. Existing server secret rotation replaces the current signing secret; bounded overlap must be validated before it is advertised as a provider capability.

## Running focused checks

From the repository root:

```text
node --test packages/partner-sdk-typescript/test/*.test.mjs
python -m unittest discover -s packages/partner-sdk-python/tests -v
node scripts/check-records-api-readiness.mjs
```

The suites exercise safe retry after a lost creation response, byte/key stability, no unkeyed mutation retry, retry limits, scope headers, request-ID errors, stale/expired cursor handling, child pagination with fixed scope/page size, nonadvancing cursors, URL restrictions, truthful partial operation outcomes, changed webhook bytes, and old/future/malformed timestamps. They use synthetic fixtures and mocked transports. The readiness command checks source route mounts against generated OpenAPI, required path parameters, authentication declarations, reference resolution and generated freshness. It does not establish production activation or runtime correctness. Production credentials, a supported provider account, production network behavior, and usability acceptance remain separate gates.
