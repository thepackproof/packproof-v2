# Enterprise API and mapping contract

Base: `/v1/enterprise`. The enterprise router is mounted before the existing `/v1` API-key router. First-party user authentication remains unchanged elsewhere. All enterprise commands are JSON; committed commands require `Idempotency-Key`.

## Authentication and scope

Humans use their existing PackProof bearer session. An active organization membership and explicit site role are required on every protected request. Membership and source grants are rechecked for command execution and replay.

Machines use existing direct merchant `pp_org_...` service credentials with `enterprise:ingest`, plus an unexpired grant to the exact source. Delegated partners are denied by this pilot profile. Machine credentials cannot list dossiers, view files through reviewer routes, annotate, administer mappings or record measurements. Legacy API keys are not accepted as human or organization credentials.

| Role | Read dossiers/media | Import/preview/replay | Annotate/resolve | Metrics | Source/membership admin |
|---|---|---|---|---|---|
| Site ADMIN | Yes | Yes | Yes | Yes | Yes |
| Site IMPORTER | Yes | Yes | No | No | No |
| Site REVIEWER | Yes | No | Yes | Yes | No |
| Site READ_ONLY | Yes | No | No | No | No |
| Source-granted machine | No | Granted source only | No | No | No |

## Routes

| Method | Route | Purpose |
|---|---|---|
| GET | /capabilities | Human capabilities and canonical mapping starter |
| GET / POST | /sites | List explicit grants / create approved site |
| POST | /sites/:siteId/members | Grant/change/revoke role; organization membership must exist |
| POST | /sites/:siteId/sources | Register a source and freshness window |
| POST | /sites/:siteId/synthetic-examples | Load practice fixtures into a synthetic site only |
| GET | /sites/:siteId/diagnostics | Approved maps, recent imports, quarantine and unassociated assets |
| POST | /sources/:sourceId/mappings | Approve an immutable mapping version and reference |
| POST | /sources/:sourceId/service-grants | Grant/revoke a merchant service principal for at most 90 days |
| POST | /imports/preview | Dry-run an exact original and approved mapping |
| POST | /imports | Commit the reviewed preview digest, original, manifest and source records |
| GET | /imports/:batchId | Manifest and source-record processing status |
| GET | /imports/:batchId/original | Download byte-identical archived source export |
| POST | /imports/:batchId/replay | Retry predecessor/association-dependent records; no rewriting |
| POST | /sites/:siteId/records/:recordId/resolve | Reasoned reviewer association for missing/ambiguous order keys |
| GET | /dossiers?siteId=&externalId=&from=&to=&after= | Exact native order/shipment/secondary PO search; dates are import dates |
| GET | /dossiers/:dossierId | Combined source-backed review model |
| GET | /dossiers/:dossierId/timeline | Current source assertions with original and ingest times |
| GET | /dossiers/:dossierId/reconciliation | Compatible quantities and cited descriptive exceptions |
| GET | /dossiers/:dossierId/records/:recordId | Original fields, normalized assertion and ingest manifest |
| GET | /dossiers/:dossierId/evidence/:assetId | Authorized, digest-verified original attachment |
| POST | /dossiers/:dossierId/annotations | Append note/disposition and reason |
| POST | /reviews/:caseId/annotations | Alias; pilot caseId is a dossier ID |
| GET | /dossiers/:dossierId/export | JSON case summary, sources and export digest |
| POST | /dossiers/:dossierId/measurements | Start BASELINE or PACKPROOF review |
| POST | /measurements/:measurementId/finish | Complete own server-timed review with adjudication and feedback |
| GET | /pilot/metrics?siteId= | Stratified durations, paired comparisons and accuracy counts |
| GET | /sites/:siteId/audit?after= | Administrative audit export, 500 per page |

Errors use the existing safe `{error:{code,message,retryable,operationId,nextAction}}` boundary. Private responses are `no-store`; originals are attachments with content sniffing disabled and restrictive CSP. Original retrieval revalidates SHA-256 and size; storage paths are generated on the server and are never accepted from clients.

## Import envelope

```json
{
  "schemaVersion": "packproof.enterprise.import/v1",
  "sourceId": "SOURCE_ID_FROM_SETUP",
  "mappingVersion": "1",
  "format": "JSON",
  "synthetic": true,
  "contentBase64": "BASE64_OF_EXACT_ORIGINAL_UTF8_FILE",
  "files": [
    {"documentKey": "ticket.pdf", "contentType": "application/pdf", "base64": "BASE64_OF_EXACT_PDF"}
  ]
}
```

Preview returns `previewDigest`, counts, row errors and normalized assertions. Add the exact returned digest to the unchanged envelope to commit. The digest binds source, immutable mapping ID, source bytes, attachment keys/digests and synthetic designation. A preview is a validation aid, not an authorization token; access is independently enforced.

Rows use native keys, explicit string quantities and UOM. The canonical example is generated by `syntheticRecords()`. Required: `record_key`, `revision`, `stage`, and 1–100 `lines` with native `line_id`. `order_id` can be on the row or line. Missing order associations are quarantined. Optional: `fulfillment_id`, `supersedes_revision`, `customer_po`, `occurred_at_local`, `source_timezone`, `document_keys`, `handling_unit_ids`, `candidate_order_ids`.

Supported stages: ORDERED, AMENDED, PICKED, STAGED, LOADED, ACKNOWLEDGED, REJECTED, RETURNED, CANCELLED, DISPATCHED, DELIVERY_ATTEMPT, HANDOFF. Non-quantity handoff events must keep quantity unknown.

Mapping schema is `packproof.enterprise.mapping/v1`. Property paths are declarative and cannot execute code. `quantitySemantics` is `STAGE_SNAPSHOT`. `orderNamespaceSourceId` and `fulfillmentNamespaceSourceId` may reference a verified key-owning source **within the same site**; defaults use the ingesting source. Mapping approval must document exact identifier semantics and correspondence. A customer PO is a search aid, never an automatic join key.

A new source revision must explicitly name its current predecessor using `supersedes_revision`. Arrival time never decides which source assertion is true. Original raw and normalized records remain immutable; active heads are a rebuildable projection. Reusing one native revision with different bytes or different normalization is rejected.

Numeric quantities use decimal strings, at most 18 integer and six fractional digits. Unknown is null/absent, not zero. No floating point summation or assumed UOM conversion. Offset timestamps are explicit; local times need an IANA zone. Unknown zones and DST ambiguity preserve uncertain chronology.

## Safe rerun and replay

Retry a lost command response with the same path, body and idempotency key. A different body under the same key returns 409. A new batch with the same source revisions creates no duplicate logical assertions. Do not change an old mapping or source record to repair an import; approve a new mapping/source correction. Replay only retries unresolved valid records; invalid rows need corrected source revisions.
