# Additive partner operations

`createPartnerOperationsRouter(deps)` is mounted inside the existing `/v1/partner` router, after its feature activation, credential authentication, merchant/delegation selection and request-rate boundary. It does not replace the established Proof, event-stream, capture-intent or webhook routes.

| Route | Permission | Behavior |
| --- | --- | --- |
| `GET /limits` | Current authenticated effective scope | Selected merchant/environment, current effective scopes, implemented bounds and capabilities |
| `GET /issues` | `proofs:read` | Permission-scoped issue facts, comparison sources, review history and cursor |
| `POST /issues/{issueId}/actions` | `proofs:write` | Append acknowledge, resolve, reopen or note; reason, record `If-Match` and `Idempotency-Key` required |
| `GET /connections` | `proofs:read` | Bounded source identity/provider/health inventory; no credentials, raw source-account references or administration authority |
| `GET /audit-events` | `audit:read` | Bounded organization audit metadata with optional operation, resource and UTC date filters |
| `GET /webhook-deliveries` | `webhooks:manage` and current webhook ownership | Attempt status, next retry, terminal result and recorded manual replay history |
| `POST /webhook-deliveries/{deliveryId}/replay` | `webhooks:manage` and current webhook ownership | Idempotent requeue of a failed delivery, retaining its original event identity |

`audit:read` is an additive opt-in scope. Existing credentials and delegation grants do not gain it. Issuing or delegating it uses the existing explicit administrator boundary. Read access to records does not authorize organization audit retrieval, source administration, access sharing or deletion.

Issue, connection, audit and delivery listings accept `limit=1..100` and `cursor`. Their signed cursors bind the resource, merchant, environment, principal, credential, delegation, filters and page size, and expire after one hour. Authorization is checked before querying and before returning the result. Issue review uses the same canonical Proof identity and operational revision as the human portal.

Issue filters are `proofId` and `status=unresolved|open|acknowledged|resolved|all`. Audit filters are `operation`, `resourceId`, `from` and `to`; dates require an explicit offset and use an inclusive start/exclusive end. Webhook diagnostic filters are `state=pending|sending|delivered|dead` and `webhookId`.

For an existing delegated principal, organization audit access is limited further to actions by that principal under the selected current delegation. Delegated inventory/issue routes do not infer new location authority: source inventory requires a binding to an eligible record, and records with a location remain withheld until an explicit location-delegation contract exists. Direct merchant service principals retain the existing organization-wide scope granted by their owner.

Delegated audit resource IDs are resolved through explicit canonical relationships, including shipment events, issues, evidence, capture/envelope jobs, webhook deliveries and source receipts/operations. Every associated Proof must remain in the selected organization/environment and unlocated. A mixed ingestion operation, or its correlated audit entry, is withheld if any member becomes location-bound. Unknown resource kinds are denied by default. Direct merchant audit authority is unchanged.

The existing v1 Proof-list and event-stream cursors contain a signed tenant-wide sequence rather than an encrypted private location projection. Once a merchant has any location-bound records, delegated access to those legacy aggregates fails closed with `LOCATION_SCOPED_AGGREGATE_UNAVAILABLE` until an explicit location-grant/private-projection profile exists. No hidden counts, sequence fields or cursors are returned on that failure. Individually authorized unlocated record reads and direct merchant-owned aggregates continue under their established policies; the frozen cursor format and committed high-water algorithm remain unchanged.

The same unsupported-location boundary applies to delegated capture launches already issued before a record received its location. Their background authority is rechecked before binding or subsequent session work. Assigned partner employees do not inherit merchant-site authority from an unscoped partner membership; independent merchant memberships and buyer/receiver permissions remain separate.

Connection health remains separate from connector availability. A spreadsheet is a one-time import. A source without measured successful work and a current watermark is `freshness_unknown`, even when its account is authorized. This read-only inventory never marks a connector production-supported or grants synchronization administration.

## Webhook replay and ownership

Delivery access requires the original webhook's current credential and the exact selected delegation, in addition to merchant/environment ownership and `webhooks:manage`. A credential with the same merchant but a different webhook authorization cannot inspect or replay that delivery. Revoked webhooks, credentials and grants are rechecked before a cached replay response is returned.

The replay body is `{ "reason": "The destination is available again" }` with a stable `Idempotency-Key`. Only a terminal `dead` delivery for an active authorized webhook can be newly replayed; a pending, leased or successful delivery is not arbitrarily duplicated. A successful replay request returns 202 with `replayId`, original `deliveryId`, `webhookId`, original `eventId`, `proofId`, pending state, `priorAttemptCount`, reason and request time.

The existing worker reuses the original event body and event identity. At the next actual dispatch, it generates a new signature timestamp. The replay response is a durable acceptance receipt, not proof of successful delivery. Inspect `GET /webhook-deliveries` for the current result.

The previous attempt count and operator reason are appended to immutable Proof audit history in the same transaction as requeue and idempotent acceptance. The current delivery row restarts its bounded automatic attempt cycle through the existing retry workflow. Diagnostic `attempts` is that current cycle; prior replay cycles remain separately described by their recorded replay entries. Diagnostics show at most the latest ten replay entries per displayed delivery, bounded by a 500-entry history query, rather than claiming a lifetime attempt total where older history is unavailable.

Endpoint URLs, webhook secrets, lease tokens, raw source payloads and authentication tokens are excluded from delivery diagnostics. The existing HTTPS allowlist, public-address/DNS checks, request timeout, signing and background credential checks remain in the dispatcher.

## Verification

`partner-record-operations.test.ts` exercises the real organization credential/delegation functions and Express middleware in process against the full PostgreSQL-compatible migration chain. It verifies effective scopes, opt-in audit access, merchant/principal cursor binding, record revision/idempotency, source-health truthfulness, webhook credential ownership, unchanged event identity, fresh signature timestamps, one replay audit record per command, and revocation before cached replies. It uses a deterministic transport to validate signed outgoing data without sending messages or making network requests.
