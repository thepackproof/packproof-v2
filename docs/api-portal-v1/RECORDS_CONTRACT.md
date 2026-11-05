# Operational records contract

The records workspace is a permission-scoped presentation of existing canonical Proofs. A record ID is the existing Proof ID. The API never copies evidence to a second canonical store or changes a historical manifest, personal attestation, original file, or core Proof state when an operational action is recorded.

## Identity and permission boundary

Human routes are rooted at `/me/records`. Authenticate with the existing human session token. Every record request selects `organizationId` and `environment=sandbox|live`. An environment selector does not switch a stored organization's environment.

`GET /context` returns only the authenticated person's current merchant memberships. It can describe pending activation or an account with no organization. Record reads and commands require both the released organization feature and the workspace entitlement. Registration does not enable access.

Owners and administrators can review their organization. Operators are limited to Proofs assigned to their membership. Reviewers have read access. A location-scoped membership additionally requires a current grant to the record's location; an unlocated record is withheld from that membership. These predicates apply before search, totals, pagination, direct reads and export-job listings.

The existing shared operator-visibility predicate also includes location grants. Legacy participant Proof reads, capture role authorization and `/me/proofs` collections cannot bypass a revoked site grant. The restriction follows the assigned organization-operator identity and preserves independently granted buyer/receiver access.

Existing partner authentication remains authoritative. New partner record routes run after it and recheck current credential, organization, scope and delegation. Existing delegation grants enumerate operators but do not declare locations. New delegated operational routes therefore refuse location-bound records until an explicit location-grant policy exists; they do not infer broader authority.

## Read routes

| Human route | Result |
| --- | --- |
| `GET /context` | Current organizations, their locations, selected workspace and permitted setup actions |
| `GET /` | Scoped records, same-cohort totals and cursor |
| `GET /{proofId}` | Operational summary, initial timeline/evidence pages, requirements, issues, relationships and explicit assurance scope |
| `GET /{proofId}/timeline` | Independently paginated recorded history, preserving reported and received times |
| `GET /{proofId}/evidence` | Independently paginated original-artifact metadata; private object keys are excluded |
| `GET /{proofId}/requirements` | Applicable template versions, child subjects, due conditions, matches and recorded waivers |
| `GET /{proofId}/evidence/{evidenceId}/blob` | Current-authorized exact-version original stream, including bounded byte ranges |
| `GET /{proofId}/package` | Existing frozen canonical evidence package, available after canonical finalization |
| `GET /issues` | Authorized unresolved discrepancies |
| `GET /exports` | Authorized existing signed-snapshot operation states; this is not a claim that the operational view was signed |

The dedicated connection and CSV routers provide their own source/import contracts. A spreadsheet remains a one-time source.

List filters are `q`, `from`, `to`, `locationId`, `view`, `limit` and `cursor`. Dates use an explicit UTC offset. The date cohort is creation time, inclusive `from` and exclusive `to`. Supported views are `all`, `open`, `closed`, `needs_attention`, `missing`, `ready`, `processing` and `handoffs`. Unsupported views return an explicit error. Rows are ordered by updated time and opaque ID. Totals use the same authorized query/date/location cohort before the selected saved view and page cursor.

`limit` is 1–100. Child timeline/evidence pages default to 50; the detail response includes their independent next cursors. Signed cursors expire after one hour and bind the workspace, current principal, resource, filters and page size. Configure the existing `PACKPROOF_EVENT_CURSOR_KEY` with its required 32-byte base64 value before enabling multi-page records.

## Commands and concurrency

Commands require a stable `Idempotency-Key` and `If-Match: "<record revision>"`. The operational revision is separate from the existing core Proof version. The transaction serializes the current record state, checks the expected revision, appends the action/history, increments the revision and saves the idempotent response. Its audit and `record.updated` or `issue.updated` outbox event commit together. Existing event-stream reconciliation publishes that committed event.

Authorization is rechecked before any cached response is replayed and before returning the result. The same key with changed input conflicts. A stale expected revision returns 412; a missing revision returns 428. A failed, uncommitted command leaves no successful receipt.

| Human command | Required body |
| --- | --- |
| `PATCH /{proofId}` | Optional `title`, `reference`, `locationId`; `reason` |
| `POST /{proofId}/close` | `reason` |
| `POST /{proofId}/reopen` | `reason` |
| `POST /{proofId}/review` | `action=mark_reviewed|reset_review`, `reason` |
| `POST /{proofId}/requirements` | `subjectId` (defaults to record), `stage`, `title`, `templateVersion`, `acceptedEvidenceTypes`, optional `dueAt` and `gracePeriodMs`, `reason` |
| `POST /{proofId}/requirements/{requirementId}/waiver` | Administrator's `reason` |
| `POST /issues/{issueId}/actions` | `action=acknowledge|resolve|reopen|note`, `reason` |
| `POST /{proofId}/amendments` | `supersedesId`, `assertion`, `reason` |
| `POST /{proofId}/entities` | `kind=shipment|stop|package|pallet|item|return`, optional `externalReference`, `parentId`, `attributes`, `supersedesId`; `reason` |
| `POST /{proofId}/evidence-links` | `evidenceId`, `subjectId`, `reason` |

Changing a location and configuring requirements/waivers require owner or administrator authority. Personal review is a human action. A close command requires all applicable requirements to be satisfied or explicitly waived, including future requirements, and all discrepancies to be resolved. Closing a record does not finalize or seal a Proof.

Entity and assertion corrections append new facts referencing the prior fact. The prior value remains visible in history. Related entities and evidence associations must belong to the same Proof. A quantity discrepancy preserves the compared source assertions, values, units, rule version and uncertainty. Review actions preserve that initial comparison.

## Requirement interpretation

A requirement's subject can be the record or one of its child entities. A record-level artifact does not satisfy a package-specific requirement without an explicit association. Only committed evidence of an accepted type can satisfy the requirement. A deadline includes its configured grace period and compares the recorded evidence receipt time; it does not silently substitute an asserted capture clock.

An unmet requirement with no due condition, or one whose due time is in the future, is `not_yet_due`. An overdue unmet requirement is `missing`. A waiver retains the approver and reason separately from satisfaction. No applicable policy produces zero applicable checks, rather than a fabricated 100-percent completion claim.

## Additive partner surface

Under `/v1/partner`, the new detail route is `GET /proofs/{proofId}/record`; existing `GET /proofs/{proofId}` is unchanged. Additive child reads are `/timeline`, `/evidence` and `/requirements`. Metadata `PATCH /proofs/{proofId}` and `/close`, `/reopen`, `/amendments`, `/entities`, `/evidence-links` commands use the same record revision/idempotency rules and the existing `proofs:write` scope. Reads require `proofs:read`.

Service principals do not receive a human attestation, personal review, requirement-waiver, or envelope-admission endpoint. Partner capture requests continue through the established assigned-operator intent service.

## Assurance and release evidence

The detail response separates the operational view from the frozen core manifest. Existing core/envelope packages cover the exact listed inventory in their manifest. New operational notes, relationship assertions, requirement rules and review actions are not retroactively added to an existing signed inventory. A file check does not establish physical condition or truth of a scene.

Original and package downloads use a process-local read capability that is never stored as a participant or accepted from a client. It authorizes only the selected Proof, current workspace, user and location grants; role-bound capture or attestation calls are rejected. Original reads reuse the existing exact-version and integrity pipeline. Streams recheck authority at bounded byte/time checkpoints and close their storage source when access is revoked. Bytes already received cannot be recalled.

Viewing an original does not grant organization-wide export authority. The new organization package route is limited to current owners and administrators until an explicit export-grant contract is available; this role check is repeated during streaming. Assigned participants retain the established participant package route under its existing policy. The organization archive identifies itself as `ORGANIZATION_CANONICAL_PROOF` and carries its operational-snapshot exclusions inside the offline metadata and README.

Raster images, supported video and audio can be viewed inline. PDFs, HTML, SVG, scripts and other active or unknown formats are attachment downloads with `application/octet-stream`, `nosniff`, a restrictive sandbox policy and no caching. The gateway does not issue presigned storage URLs. The full package's disclosure metadata records organization viewing authority and its actual exporter; original participant and attestation identities remain unchanged.

`records-api.test.ts` exercises the full SQL migration chain with the existing PGlite PostgreSQL runtime and actual Express requests: workspace activation/context, tenant/environment/operator isolation, pre-count search scope, signed cursor binding, idempotent atomic event publication, revision conflicts, due/waiver/close semantics, child gaps, source-preserving discrepancy review, append-only corrections, revoked memberships and service credentials, location-limited counts/lookup, sanitized history, and independent child pagination. This is implementation evidence, not a completed customer usability, production load, real-source pilot or disaster-recovery qualification.
