# API and records portal implementation status

This is the implementation and release ledger for the November 3, 2026 API and
Portal Development Plan. Update this ledger with observed evidence, not estimates.
A source implementation, local passing test, deployed feature, and accepted
customer workflow are separate facts.

## Baseline established November 4, 2026

| Boundary | Observed source / evidence | Decision |
| --- | --- | --- |
| Source | `thepackproof/packproof-v2`, `e4f69c9a690649c41b846468eb48829fb0542617` before this change | Extend the existing repository; retain canonical Proof IDs. |
| Backend | Node/Express, TypeScript, PostgreSQL, S3, Cognito, KMS; `backend/src/app.ts`, `backend/package.json` | Retain the modular service and existing authority boundaries. |
| Organization policy | `backend/src/platform/organization-access.ts`, `organizations.ts`, `organization-router.ts`, `partner-router.ts` | Reuse current grants, membership, environment scope and activation gates. |
| Durable work | `platform/idempotency.ts`, `event-stream.ts`, `worker.ts`; `domain/recovery-journal.ts`, `policy-recovery.ts`; `operations/runtime-jobs.ts` | Extend durable commands and transactional work; keep protected recovery distinct from ordinary processing. |
| Evidence | Existing capture, resumable upload, finalization, manifest, envelope, recipient export and claim review modules | Preserve original bytes and existing assurance labels. |
| Browser product | React 19 / Vite; existing authenticated app and Proof list/detail components | Add the records workspace using existing authentication and visual foundation. |
| Schema | Baseline source migrations through `095_recipient_export_preservation.sql` | Add migrations; never edit applied historical migration bytes. |
| Production website | Existing Site project `appgprj_6a9c2365007c8191a0958c54e4a67b95`, version 77 remains live unchanged | Its current source checkout could not be obtained because the source helper failed with a network/thread error. Preserve its existing source and audience; no website publication is claimed. |
| Production backend | November 4 read-only AWS observation: account `784514617543`, `us-east-1`, `packproof-v2-staging-api`, running one task at task-definition revision 49, immutable image `sha256:434f5cd40bf365a6bdf585fa6302f786ea4571dda892fd761c3dbd85d6b5aa54` | Image matches the historical accepted inactive bridge receipt. New records code and migrations are not deployed. Current database receipts/readiness still require exact preflight. |
| Production activation | Observed customer API environment is production; automatic migrations false, durable receipts false, organization activation setting absent | Organization routes remain disabled. Do not activate new records/assurance profiles from source availability. |
| Protected synthetic runtime | November 4 read-only observation: separate M1 API/worker task definitions revision 6, both desired/running zero; organization flag true, separate process roles, durable receipts true | Runtime is paused. Existing synthetic evidence is not an active customer rollout or current protection acceptance. |
| Identity / consumers | Existing Cognito identity and published mobile/desktop clients; full current consumer inventory is unavailable locally | Preserve compatibility and existing client identity. Obtain actual customer/source owner acceptance before cutover. |

The observed backend image and active website version do not establish that the
same source is running at both boundaries. Database version/region and exact
migration receipts, bucket policy, secret ownership, live connector accounts,
job health, enabled cohorts and source freshness still require the relevant
authenticated inspection. No cloud configuration or data was changed by that
read-only discovery. No secret values belong in this ledger.

## Work-package acceptance ledger

“Source present” below means an implementation path was observed. It does not
mean the entire work package passes the plan's acceptance criterion. New source
and validation evidence should be added to this table as the change is completed.

| ID | Work package | Source foundation and changes | Acceptance remaining |
| --- | --- | --- | --- |
| WP01 | Baseline and source inventory | This ledger; existing deployment and foundation receipts linked below | Fresh production trace for human, partner and employee; owner-confirmed source artifacts, consumers, storage and runtime inventory. |
| WP02 | Canonical schemas and state rules | Existing canonical Proof, commerce lifecycle and bounded relationships; records projection extends the same Proof | Contract/fixture agreement across API and portal; realistic multi-package, partial and return source fixtures. |
| WP03 | Tenant policy and workspace provisioning | Organization administration, scoped credentials, delegation and policy recovery retained | Actual eligible workspace setup, entitlement/cohort activation, location policy and negative authorization acceptance in the intended environment. |
| WP04 | Record commands and queries | Partner imports, signed pagination and event feed retained; records routes added by this change | Published route conformance, concurrency, source identity and query-scope checks against PostgreSQL and current deployment. |
| WP05 | Durable ingestion and outbox | Existing durable command results/outbox retained; records/import work builds on transactional receipts; bounded partner source-observation ingestion and operations added | Commit/lost-response, dispatcher crash, lease expiry and replay tests in a real PostgreSQL deployment. |
| WP06 | Upload and artifact pipeline | Existing upload recovery, exact media admission and finalization retained; organization-authorized exact-version original/range gateway in `records/media-router.ts` and `records/read-grant.ts` | Generic partner upload-session/complete protocol is absent; actual object-storage ingestion, quarantine/scanning where required, interruption and digest acceptance remain required. |
| WP07 | Record list and detail portal | Existing authenticated Proof views retained; records dashboard and record inspection added by this change | Authenticated desktop/mobile visual acceptance with representative tenant data and evidence. |
| WP08 | CSV preview and row repair | Guided spreadsheet import, original-file retention, mapping, row outcomes and repeat safety added by this change | Novice completion/error-recovery sessions and hosted original-file/receipt checks; no automatic-sync claim for a file import. |
| WP09 | Requirements review and capture tasks | Existing capture intents and scoped human capture route retained; record requirements/exceptions added by this change | Child-level requirement provenance and actual scoped task acceptance on supported capture hosts; human attestation remains deliberate. |
| WP10 | Pilot source adapter | Existing commerce/tracker adapters and server-side partner import capability retained | Select one authorized pilot source, document edition/scopes/limitations, ingest its real bounded dataset and reconcile receipts. No universal WMS connector is claimed. |
| WP11 | Connector setup and operations | Existing account connections plus source-health/assisted-setup presentation | Provider authorization/resume, reauthorization, backfill, cadence and recovery using the chosen production source; named maintainer and support route. |
| WP12 | Webhooks and SDKs | Existing signed delivery/reconciliation retained; TypeScript/Python client packages and examples added by this change | Exact contract tests, actual HTTPS receiver failure/recovery and SDK upload/resume coverage before declaring the complete SDK feature set. |
| WP13 | Snapshots, exports and verifier | Existing signed package/envelope and independent Python verification retained; organization-authorized frozen core-package download and verification tooling/docs extended by this change | A signed operational revision including new relationships, requirements, review actions and omissions is absent. The existing core package does not cover those later operational rows. Independent review, real package/key-rotation checks and protected-profile activation gates remain required. |
| WP14 | Sharing, retention and deletion | Existing limited grants, retention, holds, recipient export and protected policy recovery retained | Current-policy acceptance for disclosure, queued revocation, held deletion and a fresh-target restore that reapplies all deletion/revocation decisions before exposure. |
| WP15 | Search scale and accessibility | Existing scoped query/pagination and responsive themes retained; records filters and accessible UI extended | 100,000-record benchmark, large-record fixture, screen reader/keyboard/zoom, contrast and both themes on real browser/device combinations. |
| WP16 | Migration, recovery and launch | Existing exact-source CI/deployment and restore harnesses retained; operating and release runbooks added | Current-schema bridge rehearsal, source-bound CI, independent security review, measured restore, pilot usability/outcomes, costs and proposed 14-day observation gate. |

## Validation and publication evidence

Record the final candidate commit, exact commands and their outcomes in the release
receipt. Include skipped/failed checks and distinguish local synthetic tests from
real PostgreSQL, S3/KMS, provider, browser/device and customer acceptance. Do not
copy historical test counts into the current result.

| Layer | Current evidence rule |
| --- | --- |
| Local code | Record the command, source revision, test names/result and limitations. |
| CI | Required checks must pass on the exact candidate revision; retain workflow URLs. |
| Website | Record pushed Site source commit, saved version and terminal successful deployment. |
| Backend | Record reviewed source, immutable image, migration/role receipt, preserved configuration and terminal canary outcome. |
| Customer | Record consented task/shipment sample, assistance and failures, not only successful demonstrations. |

Version 1 general availability remains unaccepted while any required gate in
[RELEASE_GATES.md](RELEASE_GATES.md) lacks evidence. Business acceptance cannot be
manufactured by marking unchecked rows complete.

## Precise capability gaps observed in this candidate

This section records missing implementation as well as external acceptance. A
documented operational procedure does not substitute for an API or product flow.
The proposed paths in the plan are capability requirements; a documented
compatible equivalent can satisfy them without renaming existing routes.

### External API coverage

| Plan capability | Actual candidate | Remaining implementation |
| --- | --- | --- |
| Caller context and effective limits | Human records `/context`; partner `/limits` reports current effective scopes, environment, tested caps and explicit unsupported capabilities | Production qualification of limits and the complete source connector capability contract remain open. |
| Create/read/list record | Existing `/v1/partner/proofs` import/read/list; additive `/proofs/{id}/record` detail | Partner list remains the earlier signed `after` list, rather than the human records search/filter/totals contract. A partner portal link/revision response and uniform filters require contract work. |
| Operational changes | Partner PATCH/close/reopen/amendment/entity/evidence-link and issue-action commands; human requirement/review/waiver commands | Elevated requirement waivers retain the human administrator boundary; complete templates, assignments and scoped waiver interoperability remain incomplete. |
| Durable normalized ingestion and batch outcomes | `/v1/partner/ingestions` accepts bounded normalized shipment observations for existing authorized Proofs, with source receipts/identity deduplication/conflict handling | Arbitrary source entities, raw documents/clips and an end-to-end production source adapter are outside this implemented observation profile. |
| Service import preview/commit | `/me/records/imports` is human-session only | No organization-service import job API; a service key must not be treated as a human actor to reuse the route. |
| Generic asynchronous work | Partner source `/operations/{id}` status/per-item outcomes, human import polling and per-connection operation polling | No uniform operation/cancellation contract across imports, uploads, exports and source synchronization. |
| Source-evidence upload session and completion | Existing supported human capture/resumable-upload pipeline | No generic partner upload-session/complete API for authorized documents, camera clips or source payloads. Existing capture does not grant service attestation authority. |
| Evidence enumeration and timeline | Additive bounded partner evidence/timeline/requirements reads | Source/entity filters and full child-level observation model remain limited; timeline entries currently use the Proof as their subject. |
| Single-artifact access | New human organization-authorized original/range gateway | No partner single-artifact short-lived download endpoint; partner core-package reads are an existing different capability. |
| Needs-attention workflow | Human queue and actions; partner signed-cursor issue queue and revision/idempotency-protected actions | Issue assignment, complete cause/remedy workflow and actual operator acceptance remain incomplete. |
| Signed operational snapshot | Existing frozen core manifest and gated additive integrity-envelope reads | No signed snapshot fixing the new record revision, relationships, requirements, review actions and operational omissions. `getRecord` explicitly labels the operational view unsigned. |
| Create exports and limited review shares | Existing core package download, personal disclosure and gated envelope/recipient mechanisms | No new organization-service export creation or snapshot-specific share/revoke flow covering the complete operational record. Existing mechanisms must be qualified before serving as equivalents. |
| Webhook diagnostics/replay | Existing create/list/delete destinations, signed dispatch/feed plus partner delivery diagnostics and idempotent replay tied to credential/delegation and original event identity | Safe secret-rotation overlap and Standard Webhooks migration remain unimplemented; hosted receiver outage/recovery acceptance is unrun. |
| Connection inventory/actions | Human source-health inventory and durable controls; partner paginated read-only capability/health inventory | Partner control actions are not exposed; no production checker is registered with the new records worker. |
| Audit | Human recent organization audit plus partner bounded signed-cursor audit filtering under explicit `audit:read` | Request explorer, full retention/export product and hosted support acceptance remain incomplete. |
| Policy-governed deletion | Existing retention holds and deletion-review mechanism | No complete partner deletion-request/impact/approval/execution job API. `domain/retention.ts` explicitly disables automatic evidence deletion. |

### Product and domain gaps

- **No production automatic connector is complete.** `index.ts` calls
  `processRecordConnectionOperations` without registering a `ConnectionChecker`;
  its default map is empty. The new catalog declares only spreadsheet and
  assisted routes. Existing marketplace/tracker adapters are not evidence that a
  selected warehouse shipping source has passed this plan's connector contract.
  Source-specific editions/scopes/artifacts, resumable consent/admin invitation,
  sample mapping, bounded backfill, watermark/reconciliation and recovery still
  require a real authorized source and implementation.
- **Workspace registration remains approval pending.** The request service stores
  a disabled organization behind both self-service and organization feature flags.
  This preserves existing activation policy, but no automated eligible-customer
  entitlement/released-cohort path has been completed. Stored first-location name
  is a request detail, not a provisioned location grant. Do not describe the whole
  supported setup path as founder-independent.
- **The canonical operational model is partial.** Normalized shipment observations
  now have canonical payload receipts, reported/received times and stable source
  event identity. Generic append-only entities
  support shipment/stop/package/pallet/item/return relationships, but a complete
  source observation, item-allocation/unit/serial/lot, multi-stop/multi-carrier and
  matching-conflict lifecycle is not implemented by those generic attributes.
  New issue detection includes reused-source-event payload conflicts and a basic
  unequal numeric quantity check on entity creation, not the plan's versioned
  unit/tolerance-aware comparison engine.
- **Requirements are primitives, not a maintained template product.** Individual
  requirements, due/grace evaluation and elevated waivers exist. A versioned
  template catalog/assignment workflow, guided human gap capture tasks, issue
  assignment and complete requirement management in the portal remain incomplete.
- **Operational signing is deliberately not claimed.** The new organization media
  grant permits scoped original/package reads without inserting participant rows
  or allowing personal attestations. The frozen core package covers its existing
  signed inventory. Later operational rows need their own consistently frozen,
  version-bound manifest and verifier coverage before they can be called a signed
  shipping-record snapshot.
- **Retention and privacy need execution support.** Customer-selectable retention
  classes, a complete impact preview/approval/deletion worker with derivative and
  backup accounting, and restored deletion-ledger enforcement for the new rows
  have not been demonstrated. Existing holds/review and protected recovery are
  retained; they are not proof of erasure.
- **The developer product is an initial client release.** Node/TypeScript and
  Python clients support bounded retry, pagination, operation polling and current
  webhook verification. Generic upload progress/resume, generated SDK models,
  interactive reference/request collection, safe sandbox reset, request explorer,
  and public status-page implementation remain incomplete.
- **Scale and accessible usability are unmeasured.** Responsive themes, focus
  treatment, a dismissible tour and UI tests do not establish the planned
  100,000-record workload, large-record handling, assistive-technology completion
  or representative novice percentages.

### Deployment blockers, distinct from source work

The candidate adds migrations 096–100. The existing strict migration inventory
rejects unknown future receipts; its forward-compatible allowlist does not include
these new migrations. Before production, build and rehearse an exact compatible
bridge against the actual running source, then apply reviewed migrations through
the existing owner-only operator. New records tables require an explicit scoped
API/worker privilege policy. The candidate's
`backend/scripts/records-runtime-privileges.mjs` provides an owner-operated bounded
SQL plan and a separate actual-caller, read-only effective-privilege preflight;
it does not apply production grants or activate features. Its source inventory,
reviewed commit/digest, exact schema and two separately provisioned nonowner roles
must match the approved deployment. Baseline canonical/platform domain permissions
are outside this new-table policy and still require independent verification.
Do not activate the routes until the
intended runtime can access only the required tables/columns and denied actions
remain denied. The ordinary production runtime cannot apply DDL at startup.

Current database/secret/storage bindings, real provider credentials, a consenting
pilot, independent security review, actual devices, timed restore and the proposed
14-day observation interval remain external inputs or elapsed validation gates.
They cannot be completed by synthetic fixtures or a source-only implementation.

The privilege policy's focused local suite passed five cases against the isolated
PGlite engine. It checks append-only/worker separation, PUBLIC/inherited/delegable
privilege expansion, sequence scope, actual/session-caller mismatch, source and
migration checksums, schema context and unexpected columns. Synthetic session
authorization is used only in the test fixture; it does not establish production
login, PostgreSQL concurrency or live runtime qualification. The same suite can
target an explicit isolated PostgreSQL test connection. See
[PRIVILEGES.md](PRIVILEGES.md) for the bounded policy and operating sequence.
The fifth case performs actual source-operation/receipt INSERTs including the
control revision and normalized payload, checks revision UPSERT admission with
EXPLAIN, and confirms processing updates cannot overwrite preserved source data.

## Existing authoritative operational references

- [Production backend promotion](../PRODUCTION_BACKEND_PROMOTION.md)
- [Exact-source backend release tooling](../../infra/backend-release/README.md)
- [Admin deployment and existing customer resources](../ADMIN_DEPLOYMENT_RUNBOOK.md)
- [Organization foundation and activation boundaries](../partner-foundation/README.md)
- [Latest historical foundation continuation](../partner-foundation/RELEASE-CONTINUATION-2026-10-22.md)
- [Organization operations](../partner-foundation/OPERATIONS.md)
- [Protected envelope profile](../partner-foundation/ENVELOPE-PROFILE.md)
- [Existing retention and recovery](../DURABLE_RECOVERY_AND_RETENTION.md)
- [Records operations](OPERATIONS.md) and [release gates](RELEASE_GATES.md)
