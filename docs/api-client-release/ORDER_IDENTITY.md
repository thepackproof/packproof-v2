# Order identity, line items, and connection coverage

This candidate extends the existing organization API; it adds no provider credential, payment, billing, or attestation authority. Source validation and the current release gates are tracked in CAPABILITY_LEDGER.md and RELEASE_GATES.md.

## Stable identity and provenance

A partner order is bound by merchant, environment, registered integration-account namespace, resource type `ORDER`, and `externalId`. Reuse the previously registered integration account when a provider reconnects. The namespace records a durable provider/account identity; an OAuth connection, credential, display order number, or tracking number is not a replacement identity.

Two merchants or two registered stores may each have order `1001`. They produce different bindings. Existing immutable bindings, the import advisory lock, and one-Proof-per-transaction uniqueness retain one root when retry keys differ or expire. The same bound order with changed snapshot content returns `409 EXTERNAL_ID_CONFLICT`; it does not overwrite the snapshot. Re-enrolling an already registered provider/account namespace returns `INTEGRATION_ACCOUNT_CONFLICT`, so recover the existing namespace instead of inventing another account identity.

Direct API and official provider imports do not silently merge. Matching order labels or tracking numbers are insufficient authority to rebind evidence. Unsupported split or mixed fulfillment stays in the existing provider review path. Later source observations retain the existing append-only revision/supplement semantics.

A new external binding appends an immutable `EXTERNAL_BINDING_ADDED` audit and a `proof.external_binding_added` outbox event in the same source transaction. The commit-safe feed therefore discovers bindings created after a reconciliation snapshot's publication boundary. Logical retries retain the original binding and emit no new event. The event refers to the canonical Proof. Fetch every page of `GET /v1/partner/proofs/:proofId/external-bindings` from the beginning after each binding-change signal, then continue the feed and deduplicate logical event IDs. Its source is explicitly an integration assertion. A binding added after finalization does not change the frozen manifest.

The integration service remains the machine actor. `operatorMembershipId` assigns an explicitly authorized, active person; it neither signs that person in nor confirms packing. Capture and attestation still require the authenticated operator. The immutable `orderSnapshot` and its hash record integration assertions, not PackProof-established packing facts.

## Current binding pages

`GET /v1/partner/proofs/:proofId/external-bindings` requires current `proofs:read` authority. It returns `schema: packproof.external-bindings/v1`, `proofId`, `bindings`, `hasMore`, `nextCursor`, `cursorExpiresAt`, and `consistency: LIVE_KEYSET_RESTART_ON_CHANGE`. Each binding includes `integrationAccountId`, `resourceType`, `externalId`, and `createdAt`. `limit` defaults to 50 and is bounded at 100; follow `nextCursor` using `after` until `hasMore` is false. Cursors are signed, expire within one hour (15 minutes by default), and bind merchant, environment, tenant, principal, credential, delegation and Proof. Every page rechecks live authorization.

These are current identity pages, distinct from the materialized reconciliation snapshot. Immutable composite binding keys provide deterministic order, but a newly inserted lower-sorting key can appear before the current cursor. Restart the binding listing from the beginning after a binding-change event, then continue the event feed. Expired cursors return an explicit restart requirement. Historical binding counts do not block ordinary Proof reads; pages remain bounded without imposing a new core binding limit.

## Authoritative multi-item request

`POST /v1/partner/proofs` now accepts optional `transaction.items`. When present, it contains 1–100 authoritative lines. These use the existing `TransactionItemWrite` model and are inserted into `transaction_items` in the same database transaction, before canonical Proof creation. Accepted lines are never truncated to one display title.

```json
{
  "integrationAccountId": "integration_assigned_at_enrollment",
  "externalId": "order-1001",
  "operatorMembershipId": "member_assigned_to_operator",
  "transaction": {
    "amount": {"minorUnits": "2825", "currency": "USD"},
    "items": [
      {"externalItemId": "line-a", "title": "Blue widget", "sku": "BLUE", "quantity": 2, "unitValue": 12.5, "currency": "USD"},
      {"externalItemId": "line-b", "title": "Green widget", "sku": "GREEN", "quantity": 1, "unitValue": 3.25, "currency": "USD"}
    ]
  }
}
```

| Item field | Contract |
|---|---|
| `title` | Required non-empty text, at most 200 characters |
| `externalItemId` | Optional non-empty text, at most 200 characters; unique within the request |
| `position` | Optional unique integer 1–100,000; defaults to array index plus one |
| `description` | Optional non-empty text, at most 4,000 characters |
| `sku` | Optional non-empty text, at most 120 characters |
| `quantity` | Optional integer 1–100,000; defaults to one |
| `unitValue` | Optional nonnegative major-currency-unit display amount; at most four decimals and at most `Number.MAX_SAFE_INTEGER / 10000` |
| `currency` | Optional uppercase three-letter code; required with a non-null `unitValue` |

Nullable optional text/value fields remain null in authoritative rows. Unknown line fields, duplicate positions/identifiers, excessive precision, unsafe numeric values, and out-of-range quantities are rejected before intake.

With items supplied, top-level `itemTitle` and `itemDescription` may remain explicit display summaries or derive from the lines. The first title is selected by position. The top-level `quantity`, if supplied, must equal the sum of line quantities. Without items, the existing single-item request and replay fingerprint remain unchanged.

`transaction.amount.minorUnits` is the existing exact integer decimal string, 1–20 digits, with its currency. Do not assume every currency has two minor-unit decimals: for example, JPY `"100"` represents 100 yen and KWD `"1234"` represents 1.234 dinars. `items[].unitValue` is the existing major-unit display representation, so USD `12.5` displays $12.50. These fields are preserved independently; the API neither converts between them nor asserts their totals reconcile to a payment. Amounts are order context and do not generate billing entries.

Every accepted line, including its original source spelling and order, participates in the stored raw snapshot and conflict hash. Whitespace, item ordering, description, SKU, quantity, or amount changes may therefore conflict with an existing binding. Use the documented correction/revision workflow; do not retry contradictory content until it succeeds.

## First-party connection health

`GET /me/commerce-connections/:connectionId/health` is an owner-authenticated read. Organization namespace registration alone does not grant access to a personal provider connection. The projection reuses the registered adapter, sync state, provider capabilities, and review summary. It never reads credential material or returns raw provider cursors.

The projection returns `schema: packproof.connection-health/v1`, observation time, actual connection status, automation opt-in/pause, capability evidence, a concrete `nextAction`, and discovered-source coverage. `NO_ORDER_IMPORT` means this runtime has no order-import adapter. Identity-only providers cannot display implied order import. `RECONNECT`, `ENABLE_AUTOMATION`, and `RETRY_SYNC` are merchant actions; `CONTACT_SUPPORT` represents a platform/rollout exception. `WAIT` and `NONE` require no routine dashboard action.

Freshness uses the last successfully covered source watermark, not the latest page completion or webhook arrival. `sourceAgeSeconds` is null before the first successful window. The diagnostic `staleAfterSeconds` is the larger of five minutes or three registered poll intervals; it is not a provider SLA. Resumable page work and the count/oldest age of pending provider invalidations are reported without leaking their contents. Expired worker leases remain visible.

Coverage concerns records the provider has actually disclosed in its accessible windows. It cannot certify undiscovered orders beyond those windows. `discovered = eligible + excluded`. Eligible records partition into `eligibleWithoutProof`, `awaitingCapture`, `inProgress`, `finalized`, and `otherEligible`. A missing bound Proof remains counted. Review reasons for supported providers describe a subset of excluded work, not extra eligible work. The oldest awaiting-capture time is exposed without inventing an overdue policy.

`finalized` is a canonical lifecycle count. It is deliberately distinct from dashboard Ready, which also requires the candidate's authoritative preservation/readiness contract. Pending uploads, local completion screens, source sync, or notification delivery cannot create Ready evidence. Reading this projection changes no canonical state, capture, consent, billing, or retention policy.
