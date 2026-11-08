# Normalized source observations

Authorized integrations can submit a normalized observation about a known Proof and source connection. The existing `POST /v1/partner/proofs` remains the record creation route. This additive intake records what the organization submitted; it does not authenticate the organization as a carrier, certify the physical scene, complete a capture session or make a personal attestation.

## Contract

`POST /v1/partner/ingestions` requires the existing partner credential, merchant/delegation selectors, current `proofs:write` scope and an `Idempotency-Key`. The selected connection must belong to the same merchant/environment, and every Proof must already be bound to that connection.

```json
{
  "connectionId": "integration_example",
  "events": [
    {
      "sourceEventId": "warehouse-event-000045",
      "proofId": "proof_example",
      "eventType": "IN_TRANSIT",
      "reportedAt": "2026-11-04T09:30:00-05:00",
      "carrier": "Example carrier",
      "location": "North loading dock",
      "data": {"packageCount": 2}
    }
  ]
}
```

One request contains 1–100 observations and at most 256 KiB of canonical logical JSON. Event types use the existing canonical shipment event catalog. `reportedAt` requires an explicit UTC offset. Optional `carrier` and `location` contain at most 200 characters. `data` is a bounded JSON object; its values plus server source metadata must fit within 8 KiB. Credentials, private keys, signed access URLs and reserved PackProof fields are rejected before acceptance.

The response is `202 Accepted` only after the operation, complete per-item receipts, business identity ledger and audit commit together. The response contains `operationId`, `state`, `receivedAt`, `itemCount`, `sourceAssurance: "organization_submitted"`, `replayed` and `links.self`. `Location` points to that operation. Acceptance does not mean that observations have been applied or evidence has been verified.

`GET /v1/partner/operations/{id}` requires the same current principal, credential, delegation, merchant and environment with `proofs:write`. It rechecks each record's current authorization. The response includes queued/running/succeeded/partially_succeeded/failed state and item outcomes: item index, source event ID, Proof ID, reported time, receipt time, status, canonical event ID when present, safe error code and attempt count. It never returns original payload bytes or other credentials' operation diagnostics.

The source event identity is permanent within merchant, environment, connection and source event ID. Repeating an identical request with the same command key returns its original receipt. A new command containing the same source event safely produces one canonical observation. Reusing the source identity with changed canonical logical JSON preserves both receipts, records `SOURCE_EVENT_CONFLICT`, and creates an actionable source conflict. The first accepted observation remains unchanged. Cross-record conflicts do not expose an earlier record's receipt ID or payload hash through the newly submitted record.

## Processing and recovery

The original event's canonical logical JSON is saved before normalization, with its server-computed SHA-256. A separate immutable normalized projection preserves the ingestion contract. This digest describes logical JSON, not the whitespace or HTTP framing of the source transport. Source event identifiers retain their original representation in the preserved payload and use a documented trimmed lookup value. Reported and PackProof receipt times remain distinct.

The existing scheduler runs `processSourceIngestions` in worker/all processes when organization access is enabled. API-only processes accept durable receipts without running this worker. API and worker deployments therefore need the same feature cohort, compatible migrations and the reviewed database/storage policy before activation.

Each job has a bounded database lease. Workers check its token and deadline before and after canonical writes; an expired or replaced holder cannot acknowledge an event. Expired leases are reclaimed. Transient row failures retry with bounded backoff, and terminal outcomes remain visible. The original source receipts and identities are immutable throughout recovery.

Current credential, delegation, merchant, Proof and location access are rechecked before processing. Located records remain unavailable through delegated routes until an explicit location grant contract exists. The worker and connection controls use the same connection lock. Pause stops new submissions; a pause/resume control revision also prevents previously queued work from publishing against changed settings. Review the failed receipt and submit an authorized new command, preserving the source event ID, after resolving the cause.

Successful observations use the existing `recordShipmentEvent` service and append-only shipment event chain. The actual organization service actor remains the audit actor. Source provenance is `PARTICIPANT_SUPPLIED`, with explicit `organization_submitted` metadata and a connection-scoped provider namespace. No human operator is impersonated. Core manifests, original evidence, capture and attestation rules remain unchanged. New events and source conflicts advance the operational record revision and enter the existing audit/outbox path.

Deterministic verification is in `backend/tests/record-ingestions.test.ts`; assembled server routing and CSV journeys are in `backend/tests/records-app-integration.test.ts`. These checks do not qualify a provider connector, establish production throughput or satisfy the customer pilot and general availability gates.


## Exact source references before a Proof ID is known (candidate)

`POST /v1/partner/source-observations` accepts one bounded logical source envelope before a canonical Proof is known. Use a direct merchant credential with current `proofs:write` and a stable `Idempotency-Key`. Enrolled Windows agents retain their CSV-only route restrictions. Supply the exact connection and explicit location (including `null` for an unlocated source); never infer the location from a tracking number.

```json
{
  "connectionId": "integration_example",
  "locationId": null,
  "reference": {"type": "SHIPMENT", "externalId": "000045"},
  "sourceKind": "Approved warehouse exporter",
  "sourceSchemaVersion": "1.0",
  "mappingVersion": "warehouse-mapping/v1",
  "event": {
    "sourceEventId": "delivery-000045-1",
    "eventType": "DELIVERED",
    "reportedAt": "2026-11-07T12:00:00-05:00"
  },
  "facts": [{"kind": "package", "externalReference": "PKG-000045-1", "attributes": {}}]
}
```

The 202 response acknowledges the preserved source envelope, digest and original receipt. `id` is an `association_...` locator; read it through `GET /v1/partner/operations/{id}` or SDK `getSourceObservation` / `get_source_observation`. States are `pending`, `submitted`, `conflict`, `blocked_policy` and `retryable_error`. A pending unresolved observation remains unlinked and retries every five minutes. `submitted` means the association and facts committed; its `operationId` identifies the separate canonical event operation. Read that operation to establish its imported/duplicate/failed outcome. Do not use the ordinary event-operation poller to infer completion of an unresolved association.

The resolver uses immutable bindings first, explicit administrator crosswalks second and unique source-attributed children third. Child identity must appear in the immutable accepted source receipt; copying attribution fields into another entity does not authorize a new relationship. A generated location binding key is not treated as a literal exporter reference without immutable original-reference evidence. Unsupported approximate matches stay unresolved. Surrounding whitespace in source and child IDs is rejected; padded numeric IDs and Unicode remain exact strings. Up to 25 distinct entity facts use the existing entity/quantity rules. Event data and each entity attribute object have separate 8 KiB limits including source metadata, so exact decimal comparisons and handling-unit allocations retain their existing typed contract. Generic source metadata cannot contain URLs, private object keys or credential fields. Corrections append a new fact with a superseded predecessor and preserve the original. Facts cannot create a human review, waiver, attestation or signature.

For authorized source files already handled by an integration, call `POST /v1/partner/source-references/resolve` with only `{connectionId, locationId, reference}`. Proceed to the existing source-artifact upload path only for a unique authorized result, and retain/reconcile its separate exact-original completion receipt. Resolution is a preflight, not a reservation or a credential grant. The existing event/artifact APIs still require current Proof access and the source connection binding. Unmatched original media stays with its authorized source/spool until an explicit relationship exists; no background camera/NVR or arbitrary filesystem collector is included.

Human exception review is at `GET /me/records/source-associations`. Operators cannot see unassigned inbound observations; reviewers and administrators receive only authorized locations. A current administrator can approve an exact source relationship through `POST /me/records/source-crosswalks`, with target Proof, rule version and reason. The target must have exactly the source location. Existing mappings cannot silently move to another Proof. `POST /me/records/source-associations/{id}/replay` records the repair reason and rechecks current source credential/location/control policy. It never changes original receipt ownership or bytes. Conflicting or already submitted source identities cannot be reassigned by replay. Expired or revoked originating credentials require explicit integration recovery; a new credential does not inherit old receipts.

All these routes require migration109 and the reviewed API/worker privilege profile. They are engineering candidates until the named-source, Windows and hosted release gates in `docs/zero-touch-warehouse/IMPLEMENTATION_STATUS.md` pass. API source completion does not establish deployed provider support.
