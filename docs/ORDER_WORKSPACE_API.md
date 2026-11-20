# Connect order workspace API

Connect 0.7.0 uses the organization API and the versioned contract in `backend/partner-openapi.json`. The 0.7.0 backend requires migrations through 129 and the corresponding runtime privileges. The order workspace uses `PACKPROOF_ORDER_WORKSPACE_ENABLED`. Facility eligibility and rollback settings are documented in `docs/windows-connect/LOGISTICS_INTELLIGENCE_PILOT.md`. The existing organization entitlement, credential scopes, enrollment, operator assignment, location permissions and source approvals still apply. Old clients retain their existing routes.

## Connect an order system

1. Enroll the computer in the merchant workspace. Select the installed order-system connection and the operator who owns its records.
2. Add the Partner API order source in Connect. The source has a version, an order namespace, the role `order`, and transport `api`. File sources that reference its orders must use its exact namespace and business ID.
3. Review the exact sources, authorized history, original retention, local destination and online visibility in the browser. Connect polls the matching installation session. An active scope permits one hour of local capture after the last successful approval check. API requests still need a current server grant.
4. Use the existing merchant service credential for the upstream order system. An enrolled desktop credential has narrower permissions. Keep service credentials on the corresponding service.

A direct order import uses `POST /v1/partner/proofs` with a bearer merchant credential carrying `proofs:write` and a fresh `Idempotency-Key`. Submit the usual `integrationAccountId`, `operatorMembershipId`, `externalId` and `transaction`. Add the exact binding returned by setup. The following values are placeholders.

```json
{
  "integrationAccountId": "configured-account-id",
  "operatorMembershipId": "approved-membership-id",
  "externalId": "SO10482",
  "transaction": {"itemTitle": "Order SO10482"},
  "orderLines": [
    {"lineId": "20", "sku": "A100", "orderedQuantity": "2", "unit": "each"},
    {"lineId": "30", "sku": "A100", "orderedQuantity": "1", "unit": "each"}
  ],
  "connectOperation": {
    "installationId": "enrolled-installation-id",
    "scopeDigest": "exact-approved-64-character-sha256",
    "sourceId": "approved-api-source-id",
    "generation": 1
  }
}
```

The response identifies the existing canonical `proofId` and the connected source event using `connectedEventId`. Every local warehouse bridge can enrich that same order. For example, an approved package record in `PACK_A` can reference `{"namespace":"ERP_A","type":"order","id":"SO10482"}` when `ERP_A` is the approved API namespace. The service retains the direct request body at its verified storage version. The resulting order's initial revision is available in the authorized change feed.

A location-bound operation needs the explicit binding. Automatic selection without a binding requires a unique, currently approved location-free API source for the same merchant, integration account and operator. A normal order import with no matching approved operation follows the existing order API behavior.

## Updates and evidence

Use `POST /v1/partner/order-workspace/events` for a direct source event or correction. Supply the organization API credential, an idempotency key, the same two account and operator selectors, the same `connectOperation`, and an `observation` containing the original filename, media type, stable observation ID, Base64 bytes, matching SHA-256, and normalized records. The server hashes and verifies the stored original before accepting its receipt. A single original is limited to 3 MiB and 512 normalized records.

Each event has a source event ID, version, kind, explicit entity and references, bounded source fields, source location, and optional lines, field-level lineage and timestamps. Preserve quantities and business identifiers as strings. Comparable projected lines expose `orderedMinusShippedQuantity` as an exact signed decimal, including zero for equal quantities. Unequal amounts also expose `orderedShippedDiscrepancy` for display. Comparison requires explicit ordered and shipped quantities in the same known unit. A shipped quantity comes from an explicit source claim. A label event alone never increments shipped quantity. Stable numeric versions can arrive out of order. A supplied null or blank remains distinct from an omitted patch field.

An optional normalized `facilityId` names an existing PackProof organization facility. Operation-wide grants with the relevant access can connect an order in one facility with an explicitly related package or handoff in another. Location-bound installations accept records from their enrolled facility only. Source-specific facility labels can stay in the reported fields without granting access. The tracking namespace convention in this profile is `carrier / account / period`. An unqualified tracking value waits for another explicit relationship.

The HTTP receipt has `state: "pending"` when an original is retained before a usable relationship exists. A later bridge re-evaluates the indexed connected component. Distinct files with conflicting claims for a source event/version keep their own original receipts and require review. Resending the same observation key with different bytes returns an idempotency conflict. Shared shipments contribute separately scoped facts to each order. A shared event cannot distribute unpartitioned line quantities.

## Read and export

The human snapshot route is `GET /me/records/order-proofs` with `organizationId` and `environment`. A device uses `GET /v1/partner/agent/order-proofs`. The snapshot returns recent orders and a committed cursor from one database statement. Read the individual revision at `/order-proofs/{proofId}/revisions/{revision}` under the same route prefix.

List results use descending commit sequence. Set `q` to an exact order reference, and pass the previous response’s `nextBefore` as `before` for the next page. A null `nextBefore` ends the list. `totalOrders` and `updatedLast24Hours` cover all currently visible orders. For a local-day count, send local midnight converted to UTC in `dayStart`. The response then includes `updatedToday`. Order cards include `updatedAt` and can include `latestKind`, an explicitly reported `customerName` or `fulfillmentStatus`, and an `issue` from the selected revision.

Poll `GET /me/records/order-changes?after={cursor}` or `POST /v1/partner/agent/order-changes` with `{"after":0,"limit":50}`. Follow `nextCursor`, drain every page while `hasMore` is true, then resume polling. Commit order is serialized across publishers. Sequence numbers can skip when other operations publish revisions. After an organization, location or account change, discard the prior cursor and request a fresh snapshot. The desktop exporter persists its own cursor only after its destination has published the revision.

Revision evidence includes scoped excerpts, original hashes and extraction locations. The artifact route returns bounded eligible original media only when the immutable revision explicitly linked it and the current installation still holds the exact source grant. Historical API backfill can recover the previously retained canonical transaction snapshot. Its profile identifies an unavailable original request body and keeps the existing Proof ID.

Connect opens a revision’s source record with `GET /v1/partner/agent/order-proofs/{proofId}/revisions/{revision}/sources/{eventKey}`. The response identifies the receipt, source, filename, locator, original SHA-256 and profile version. `kind: "original"` includes verified UTF-8 `originalText` for eligible CSV, TSV or JSON records up to 64 KiB when all source fields are accounted for. `kind: "derived_excerpt"` describes the available evidence. Shared or reassigned records and unavailable original grants return limited metadata. Eligible explicitly linked attachments use the revision’s existing artifact route.

### Find a carton and open its history

Both human and device list endpoints accept an exact business reference. For example, `q=CTN-7784&referenceType=package` looks for that carton within the caller's current scope. Choose `order`, `pick`, `package`, `shipment`, `tracking`, or `any`. Each match reports its source, namespace, reference and current Proof revision. When an identifier is reused, use the returned location and source to select an order. A lineaged source order name can serve as its display reference while the stable upstream ID remains searchable.

A revision's `cartons` array reports the last supported event and delivery evidence separately for each explicitly identified carton. `deliveryCoverage` reflects the tested source scopes represented in that revision. `unreported` means the recorded scope cannot establish coverage. An event's `occurredAt` comes from its source. `firstSeenAt`, when present, comes from the collector's first durable observation. `observedAt` records server acceptance. The revision's `changes` records added, updated and unlinked claims with source and locator where available. A field-level correction can point back to its previous event. Existing historical snapshots can predate these fields.

Humans open a pinned source or artifact at `/me/records/order-proofs/{proofId}/revisions/{revision}/sources/{eventKey}` or `/artifacts/{receiptId}` under the same revision. The service checks current Proof, location, installation and original-source access. Owners and admins can view originals by default. An authorized administrator can override a membership's access for one installation using `PUT /me/records/agent-installations/{installationId}/order-original-access` with scope, membership, allowed status and reason. Eligible multi-order sources return only the permitted excerpt. A revision packet is available through `POST /me/records/order-proofs/{proofId}/revisions/{revision}/packet` with the same human scope. Its inclusion manifest records permitted content, exclusions and the export destination.

## Review and recovery

The organization workspace lists unresolved observations at `/me/records/order-attention`. A current human workspace member with write access can submit `link` or `unlink` to `/me/records/order-proofs/{proofId}/associations`. Supply the immutable event key, expected target revision, an auditable reason and an idempotency key. A reviewed reassociation creates updated revisions for affected orders. Prior revisions continue to resolve.

Both `GET /me/records/order-attention?includeOrderIssues=1` and `GET /v1/partner/agent/order-attention?includeOrderIssues=1` return the projected orders that need review. `orderIssueCount` covers the current scope. `orderIssues` contains up to 20 orders, each with a proof ID and revision. Use `nextIssuesBefore` as `before` to continue the order list. The review includes compatible loaded-versus-acknowledged and ordered-versus-shipped quantity discrepancies and conflicting reported values. Pending record associations retain their own review workflow.

Use `GET /me/records/order-source-health` to list overdue carton receipts and source incidents with the facility's affected orders. A current member with write access can assign a discrepancy, request a receipt, clarify mapping, or resolve an evidenced gap through `POST /me/records/order-proofs/{proofId}/case-actions`. Include the case key, expected case version, expected Proof revision, reason and idempotency key. A stale version returns a conflict so the operator can review what changed. The corresponding GET returns the action history.

Pause individual API sources through the installed service. Disabling the new rollout flag stops access through these routes while preserving accepted input and export work. Database restoration must restore canonical proofs, source sessions, original receipts, versioned original objects, order events, explicit references, association decisions, link state, API history cursors and immutable revisions together. A cold-copy restore of the isolated test database can be exercised with `PACKPROOF_ORDER_RECOVERY_PROBE=1` and the multi-source HTTP integration test. Production backup and object-version retention follow the deployment's operating controls.

