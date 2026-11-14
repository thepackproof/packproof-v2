# Existing-data API candidate

This contract preserves approved source originals and reconstructs operational cases from their reported facts. It is an opt-in development candidate. Customer source qualification, independent security/usability acceptance, real PostgreSQL concurrency, load/restore exercises and the Windows service qualification remain release gates. Implementation and synthetic tests do not establish production availability. See [implementation status](EXISTING_DATA_IMPLEMENTATION_2026-11-14.md) and the [machine-readable partner contract](../backend/partner-openapi.json).

## Admission and authority

Start in an isolated sandbox with an approved organization, location, operator membership, service principal and integration connection. An owner or administrator proposes and approves each exact source through `/me/records/source-subscriptions`; direct service credentials cannot approve their own source. A local collector can propose a local source, then an authorized person approves it. The source approval records complete headers, mapping/constants, history bounds, original retention consent, identity policy and immutable configuration revision. Read the returned `configurationRevision`, `configurationSha256` and `grantRevision`; do not assume their values.

The operational flags default to off:

| Capability | Required switches |
|---|---|
| Approved-source preview and processing | `PACKPROOF_TYPED_INTAKE_ENABLED`, `PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED` |
| Operational cases | `PACKPROOF_CASE_RECONSTRUCTION_ENABLED` |
| Version two business identity | `PACKPROOF_SOURCE_IDENTITY_V2_ENABLED` |
| Multiple approved sources on one collector | `PACKPROOF_MULTI_SOURCE_AGENT_ENABLED`; qualified collector `0.3.0` for v2 |
| Explicit shared-order allocations | `PACKPROOF_CROSS_CASE_ENABLED`, v2 batch and separately approved `config.crossCasePolicy` |
| SQL section pages and complete worker projections | `PACKPROOF_PAGED_PROJECTIONS_ENABLED` |
| Qualified source rules | `PACKPROOF_SOURCE_HEALTH_ENABLED`, `PACKPROOF_RECONSTRUCTION_RULES_ENABLED`; `PACKPROOF_SOURCE_RULE_POLICIES_ENABLED` for source rule policies |
| Investigation exports | `PACKPROOF_RECONSTRUCTION_EXPORTS_ENABLED`; signing additionally needs `PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED` and a qualified signing binding |
| Source disposition and collector compaction | `PACKPROOF_SOURCE_DISPOSITION_ENABLED`, reviewed current authority and approved policy |

The organization feature must also be enabled. Enabling flags does not satisfy the external release gates. A typed original is UTF-8 JSON or CSV, at most 2 MiB and 1,000 rows. Preserve the complete original, including unmapped columns and unrelated rows, with `wholeFileConsent:true`. Server-derived rows, locators, association policy and identity derivation cannot be submitted as substitute originals.

Use an organization partner credential with `imports:write` for preview/commit/reconcile and `imports:read` for receipts and record verification. Send `Authorization: Bearer <credential>` and the exact `PackProof-Merchant-Id` selector when required. Source intake requires direct merchant authority; delegated grants do not qualify it. All POSTs use a stable `Idempotency-Key` for the exact payload. Retrying a changed body under the same key returns `409 IDEMPOTENCY_CONFLICT`. Current authority is checked again on retries and worker processing.

## First connection in an empty workspace

A qualified `0.3.0` installation can begin with an order-line export. It does not need an earlier shipment CSV, transaction quantity or Proof. Enable the three typed setup capabilities in the table above only for the qualified candidate environment; v2 identity remains a separate switch.

1. The service starts `POST /connect/enrollments` with its device name/version. The browser reads `/me/records/agent-enrollments/{enrollmentId}` using the current human workspace. Compare the independent code shown on the service.
2. If the integration-account choices are empty and `capabilities.createLocalSource` is true, the owner/admin may choose a new local file connection. Send `createLocalSource:true` and `integrationAccountId:null` in the existing enrollment decision, with the selected current operator/site and source name. Approval creates one scoped `packproof-connect-files` integration account in the same transaction. Older versions and disabled setup capabilities cannot use this option.
3. The service redeems with its private enrollment secret, durably protects the returned credential, then sends `/v1/partner/agent/heartbeat` with `enrollmentAcknowledged:true`, version and queue count. Credential replay bytes are cleared after acknowledgement.
4. The installation is `ready` with `config:null`, no legacy test/import IDs and no source upload grant. Propose the exact first local CSV through `/v1/partner/source-subscriptions/proposals`, have the owner/admin approve that source revision, then preview, commit and verify its order-only case. Approve recurring source collection separately after the first exact receipt succeeds.

For a previously acknowledged `0.3.0` installation still in `setup`, the owner/admin can choose `approve_source_setup` through `/me/records/agent-installations/{installationId}/actions`. Supply the exact current `configRevision` and `configSha256`, including null when no legacy config exists. This explicit action rechecks the current administrator, operator and site; it permits source setup without approving any source bytes. Existing legacy versions retain their original setup/configuration flow.

Neither `ready` nor a proposed source permits upload. Each actual source requires its own current approved configuration and grant. The installation still cannot use general case listing, unrelated Proofs or unrestricted intake.

## Preview, commit and verify

| Operation | Endpoint | Result |
|---|---|---|
| Discover admitted profiles | `GET /v1/partner/source-profiles` | Versioned profiles, schemas and limits |
| Preserve and preview | `POST /v1/partner/typed-imports/preview` | `201` receipt with every row accounted for |
| Commit exact preview | `POST /v1/partner/typed-imports/{importId}/commit` | `202` queued receipt |
| Poll durable outcome | `GET /v1/partner/typed-imports/{importId}` | Current receipt and row outcomes |
| Verify stored source facts | `GET /v1/partner/typed-imports/{importId}/record` | Authorized per-case source subsets |
| Resume or reconcile | `POST /v1/partner/typed-imports/{importId}/reconcile` | `202`; no request body |

A `202` acknowledges durable acceptance. Poll until the receipt becomes `succeeded`, `partially_succeeded`, `blocked_policy` or `failed`. Confirm the preview digest and choose the partial-row policy explicitly:

```json
{
  "previewVersion": "<exact preview.previewVersion>",
  "originalSha256": "<exact preview.original.sha256>",
  "importValidRows": false
}
```

`importValidRows:false` refuses a preview with quarantined rows. With explicit partial consent, valid rows proceed and malformed rows remain recorded outcomes. The mutually exclusive row counts sum to `rowCount`. A row with linked A and still-unresolved B remains one `accepted_unlinked` row; `caseIds` and `projectionOutcomes` separately report its linked subsets. A shared row can have several case IDs and a null legacy `caseId`.

The record verification response contains the original digest and each permitted projection’s `sourceRootReference`, target `rootReference`, `associationBasis`, assertions and relationships. Source corrections or later snapshots can leave verifiable historical values with `active:false`. Removed/reassigned case projections disappear from the former case’s current verification view. Collector verification must compare every returned partition’s exact source values, parent scope and relationships, rather than accepting only the first case.

## JSON with explicit source IDs and revisions

This runnable construction uses source-reported order/line IDs and an explicit source event/revision. Replace the approval identifiers and namespace with the exact approved source configuration. These example business rows are synthetic. `original.content` is the serialized array itself, and its digest covers those exact bytes.

```js
import { createHash } from 'node:crypto';

const observation = {
  sourceEventId: 'ERP-0010482-004-orderedQuantity',
  sourceRevision: '1',
  observationKind: 'snapshot',
  occurredAt: null,
  sourceAsOf: '2026-11-12T19:00:00Z',
  timeQuality: 'snapshot_time_only',
  references: [
    { namespace: 'approved-erp', type: 'order', externalId: '0010482' },
    { namespace: 'approved-erp', type: 'order_line', externalId: '004', parentExternalId: '0010482' }
  ],
  assertions: [{
    subjectReference: { namespace: 'approved-erp', type: 'order_line', externalId: '004', parentExternalId: '0010482' },
    property: 'orderedQuantity',
    value: { amount: '10', unit: 'each' },
    assurance: 'source_reported'
  }],
  relationships: [{
    from: { namespace: 'approved-erp', type: 'order', externalId: '0010482' },
    to: { namespace: 'approved-erp', type: 'order_line', externalId: '004', parentExternalId: '0010482' },
    type: 'has_line',
    quantity: null
  }],
  supersedes: null,
  originSystem: 'Synthetic ERP example',
  copiedFromSource: null
};
const content = JSON.stringify([observation]);
const jsonBatch = {
  schema: 'packproof.typed-source-batch/v1',
  connectionId: 'approved-connection-id',
  locationId: 'approved-location-id',
  sourceProfile: 'packproof.order-lines/v1',
  mappingVersion: 'approved-mapping/1',
  sourceNamespace: 'approved-erp',
  subscriptionId: 'approved-subscription-id',
  configurationRevision: 1, // use the actual approved revision
  grantRevision: 2,         // use the actual current grant
  wholeFileConsent: true,
  original: {
    name: 'order-lines.json', mediaType: 'application/json', content,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex')
  },
  mapping: {}, constants: {},
  completeness: { kind: 'unknown', asOf: null, marker: null }
};
```

For an independently approved **v2 JSON column source**, use the same original observation fields, change `schema` to `packproof.typed-source-batch/v2`, and add:

```json
{
  "identityPolicy": {
    "schema": "packproof.source-identity-policy/v1",
    "eventKey": { "kind": "column" },
    "revision": { "kind": "column" }
  }
}
```

Its approved configuration must declare that exact v2 schema/policy, with empty mappings and headers. JSON supplies the explicit IDs and revisions directly. Composite extraction and `source_as_of` revision policies apply to mapped CSV originals.

## CSV with approved composite identity

This v2 example uses the exact order, parent-scoped line and property as business identity. It preserves leading zeros. Arrival time, content hashes, folder names and the set of already-seen cases never become business identity. The source owner must approve these fields as the actual row grain.

```js
import { createHash } from 'node:crypto';

const csv = 'Order,Line,Property,Amount,Unit,AsOf\n'
  + '0010482,004,orderedQuantity,10,each,2026-11-12T19:00:00Z\n';
const csvBatch = {
  schema: 'packproof.typed-source-batch/v2',
  identityPolicy: {
    schema: 'packproof.source-identity-policy/v1',
    eventKey: { kind: 'composite', fields: ['orderId', 'orderLineId', 'property'] },
    revision: { kind: 'source_as_of' }
  },
  connectionId: 'approved-connection-id',
  locationId: 'approved-location-id',
  sourceProfile: 'packproof.order-lines/v1',
  mappingVersion: 'approved-mapping/2',
  sourceNamespace: 'approved-erp',
  subscriptionId: 'approved-v2-subscription-id',
  configurationRevision: 1, // replace with the actual approved revision
  grantRevision: 2,
  wholeFileConsent: true,
  original: {
    name: 'order-lines.csv', mediaType: 'text/csv', content: csv,
    sha256: createHash('sha256').update(csv, 'utf8').digest('hex')
  },
  mapping: {
    orderId: 'Order', orderLineId: 'Line', property: 'Property',
    amount: 'Amount', unit: 'Unit', sourceAsOf: 'AsOf'
  },
  constants: { observationKind: 'snapshot', timeQuality: 'snapshot_time_only' },
  completeness: { kind: 'unknown', asOf: null, marker: null }
};
```

Approve the complete `expectedHeaders` array `['Order','Line','Property','Amount','Unit','AsOf']`, exact mapping/constants and identity policy before previewing. The server derives an unambiguous composite event key and a revision such as `snapshot:2026-11-12T19:00:00.000Z`; provenance records the actual original components and locators. V2 identity is scoped by organization, environment, connection, site, subscription and namespace. Two approved sources on one connection cannot deduplicate or supersede one another.

With approved `source_as_of` snapshot ordering, arrivals at source times 10:00, 12:00 and 11:00 preserve all originals and select 12:00 as current. This policy decision is recorded separately; it does not invent a source `supersedes` claim. Same identity/revision with changed content is a conflict. Explicit corrections/tombstones require their actual superseded source revision. Immutable events require a stable real event ID or sequence and use `revision.kind:'immutable_event'`; changing an existing event body conflicts.

## Cases and explicit identity approval

General direct merchant credentials can read `/v1/partner/cases` and `/v1/partner/cases/{caseId}` with current `proofs:read` authority. Enrolled collectors are restricted to their own receipt `/record` endpoint. Human case routes use `/me/records` with `organizationId` and `environment` query selectors and a current person session.

Lists filter current organization, environment, operator and site before exact-reference search, totals and paging. Detail accepts `section=assertions|relationships|timeline|comparisons|caseLinks|aliases|identityRules|proofs`, `limit=1..100`, `timelineOrder=operational|received` and the returned opaque cursor. Follow `pagination.nextCursor` with the same selections. A changed case, projection or authorization invalidates a cursor; refresh rather than combining revisions. `projectionStatus` indicates pending/stale/ready worker state. Missing complete projection suppresses current comparisons. Source-reported times remain distinct from received time and unknown times stay unknown.

Proof members are paged too. `proofs` contains `{id,proofId}` entries, and `case.proofIds` contains the same bounded visible page. Use `case.proofCount`, `pages.proofs` and `totals.proofs` for the current visible total. An assertions or timeline response also carries `proofPagination`; its signed cursor is scoped to `section=proofs`, not to the selected assertions/timeline section. Follow that sidecar with the same case, limit, timeline order and authority while switching the request to `section=proofs`:

```http
GET /v1/partner/cases/{caseId}?section=proofs&limit=50&timelineOrder=operational&cursor=<URL-encoded proofPagination.nextCursor>
```

Do not interpret the bounded `case.proofIds` array as the complete membership list, or reuse the Proof cursor for a different section. Changed authorization, case revision or projection requires refreshing the pages.

Each order remains a separate case. Shared cartons, pallets, loads and stops require an approved v2 source allocation policy plus explicit parent order/line/shipment edges. An unknown B does not become A because A was seen first. Unallocated aggregate quantities remain pending rather than being copied into each order. Current authority is checked for every case endpoint. Restricted neighbors expose an opaque indicator without their identifiers or counts.

Human owner/admin identity commands are `/me/records/cases/crosswalks`, `/cases/entity-aliases` and `/cases/identity-rules` under the same `/me/records` prefix. Read permitted source identities from `/cases/{caseId}/identities`, current crosswalks from `/cases/{caseId}/crosswalks`, and mappings from `/cases/identity-mappings?locationId=…`. Approvals use exact namespaces/types/IDs, parent scope for lines, one-to-one cardinality, explicit effective-time bounds, reason and rule version. Corrections specify the current immutable `supersedesId`; stale decisions fail. A case-root crosswalk does not establish that independently named source line IDs are equivalent. Per-entity aliases provide that separately approved relationship, and explicit aliases override conflicting generic namespace rules.

Case assertion source routes return one authorized field extract, never a whole shared original. Investigation packages freeze their projection, association basis, extracts and digest; later association corrections preserve old package bytes. New packages use current eligible case membership. Signed exports require the separate qualified runtime binding and cannot be inferred from an unsigned package.

## A new computer can start with an order feed

With the typed source capabilities enabled, a matching0.3.0 installation is admitted for source setup when a current administrator approves its organization, site and responsible teammate. If there is no existing connection account, the administrator may explicitly choose a new local file connection; this creates an internal `packproof-connect-files` scope, not a vendor API connection. No legacy shipment CSV, invented shipment or placeholder quantity is required.

An older approved installation still in `setup` can use the capability-gated `approve_source_setup` human action with its exact current `configRevision` and `configSha256`. Setup admission does not approve a folder, upload, source mapping or recurring collection. The collector must acknowledge its protected enrollment, and each source still follows its separate exact-original and recurring approvals. Older collector versions and disabled capabilities retain the existing setup contract.
