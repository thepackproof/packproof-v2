# Partner webhook operations

These additive routes use the existing `/v1/partner` profile, organization feature flag, service credentials, `PackProof-Merchant-Id` and, for partners, `PackProof-Delegation-Id`. Every operation requires current `webhooks:manage` permission. Merchant selection never grants access to a subscription created by another principal or delegation.

| Method and path relative to /v1/partner | Result |
|---|---|
| GET /webhooks?limit=50&after=... | Origin-principal/delegation scoped subscriptions, including revoked subscriptions |
| DELETE /webhooks/{webhookId} | Revoke this subscription; idempotent |
| GET /webhooks/{webhookId}/deliveries?limit=50&after=... | Paginated logical delivery status |
| GET /webhooks/{webhookId}/deliveries/{deliveryId} | One logical delivery status |
| POST /webhooks/{webhookId}/rotate-secret | New generated signing secret; empty JSON object and Idempotency-Key required |
| POST /webhooks/{webhookId}/deliveries/{deliveryId}/retry | Requeue an exhausted delivery; empty JSON object and Idempotency-Key required |

URL-encode delivery IDs as path segments. A delivery ID can contain colons.

Creation remains POST /webhooks with the existing allowlisted HTTPS URL and eventTypes request. Secret-bearing creation and rotation responses are encrypted in the replay cache. Store the returned secret securely. Repeating a committed rotation with the same idempotency key returns the same secret while current authorization and an active subscription still permit it. Revocation is checked before replay; cached success cannot reopen access.

Subscriptions belong to the original principal and original delegation. Another credential for that same principal and delegation can manage them, but dispatch remains authorized by the credential recorded at creation. Revoking that recorded credential stops queued delivery. Recreate a subscription under its replacement credential rather than silently transferring authority. Direct merchant access is a separate authorization context and does not adopt a delegated subscription.

## Status response

A delivery contains `id`, `eventId`, `eventType`, `proofId`, `eventCreatedAt`, `state`, `attempts`, `lastStatus`, `nextAttemptAt`, `deliveredAt` and `retryable`. Timestamps are ISO 8601 UTC strings or null. `nextAttemptAt` is null for delivered or exhausted work. `retryable` is true only for exhausted work on an active subscription.

States remain `pending`, `sending`, `delivered` and `dead`. This is the operational status of one logical delivery, not canonical Proof lifecycle. The same finalized Proof remains finalized during a receiver failure.

Lists return `nextCursor` (string or null), `hasMore` and the typed payload array. The optional `limit` is an integer from 1 to 100, default 50. Cursors are signed, bound to the current credential/merchant/principal/delegation/resource and valid for 24 hours. Cursor expiry returns `410 WEBHOOK_HISTORY_CURSOR_EXPIRED`; restart the list. Configure `PACKPROOF_EVENT_CURSOR_KEY` with the existing 32-byte base64 signing key before enabling history.

Pagination is an operational, live keyset view. New rows or changing statuses are not a consistent point-in-time export. Rescan or use the commit-safe event stream and reconciliation snapshots for authoritative catch-up.

## Signing, retry and rotation

The body and signing format remain unchanged: `t=<unix-seconds>,v1=<HMAC-SHA256>`, computed over the timestamp, a period and the exact raw body bytes. The existing five-minute timestamp tolerance remains. Verify before parsing, reject altered bytes/stale signatures, acknowledge only after durable inbox receipt and deduplicate by logical event ID.

Every send includes:

- `PackProof-Event-Id`: stable logical event ID, retained on retries and explicit replay.
- `PackProof-Delivery-Id`: stable event/subscription delivery ID.
- `PackProof-Attempt-Id`: fresh identifier for each send attempt.
- `PackProof-Signature`: freshly generated signature using the attempt timestamp.

The existing database row stores current-cycle attempt count and final status. It is not a permanent per-attempt history ledger. Retrying a `dead` delivery resets the cycle count and reuses the same event and delivery row; it does not create another Proof or event.

The existing ten automatic attempts, bounded exponential delay and jitter are preserved. They are not a guaranteed 24-hour or 72-hour retry window. An exhausted delivery remains available for explicit durable replay or event-stream catch-up, subject to the actual retention policy. A simulated outage regression demonstrates replay mechanics; it does not establish a live 24-hour receiver-outage receipt.

Secret rotation is immediate for newly leased attempts. An already leased/in-flight attempt may still carry the prior secret. Coordinate a receiver cutover that temporarily accepts the old and new secret for the bounded in-flight request window, then retire the old secret. There is no server-configured dual-secret overlap period.

Current merchant and recorded credential/delegation authority are checked before queued work is sent. Revocation stops new sends and replay, while previously delivered copies remain at the receiver. HTTPS hostname allowlisting, public DNS/address pinning, redirect refusal, DNS timeout and request timeout remain enforced by the existing transport. No raw order text, response body or secret is added to diagnostics.

## Release evidence

Run `backend/tests/partner-webhook-operations.test.ts` through the standard backend suite and the isolated PostgreSQL gate. It covers crossed merchants/principals, cursor binding/expiry, encrypted rotation replay, revocation, stable event identity, fresh attempt IDs, ten-attempt exhaustion and synthetic 24-hour outage recovery by explicit replay. Physical/live endpoint and operational retention claims require separate exact-candidate staging evidence.
