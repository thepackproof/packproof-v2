# Future platform — execution boundary and release gates

Governing request: execute `PackProof_Future_Platform_Comprehensive_Development_Plan_2026-09-10(1).docx`. User authorization starts post-freeze development; the plan's frozen-release boundary and evidence invariants remain requirements. Baseline and exact source checksums: [BASELINE.md](BASELINE.md).

## Selected vertical change

Extend the existing signed supplement/capture/export core with immutable signed lifecycle snapshots, independently checked portable snapshot content and an action-bound signed capture receipt. Reuse the existing order adapters, recovery paths, signing runtime, disclosure rules, recipient compiler and offline verifier. The branch is `future/platform-foundation-2026-09-10`, based on `a504173` / Android build 44.

This is a bounded foundation change spanning portions of WP-02/03/05/06/08. WP-01's source/receipt inventory is recorded. Existing implementations satisfy parts of WP-04/07/09/10, with concrete gaps below. A coded reference path cannot complete WP-11's real partner pilot or authorize WP-12's recipient submission. The remaining future workstreams are not represented as delivered.

Candidate status is source implementation and local validation only. Future writers and endpoints remain disabled by default and require explicit configured activation. Migrations are additive; no migration or production activation is performed as part of this inventory. Use the final change summary/test output for the exact completed implementation and observed checks, rather than promoting pre-existing test counts to new results.

## Architecture decisions for this slice

| Decision | Implementation direction | Compatibility and trust boundary |
|---|---|---|
| ADR-01 Lifecycle | Extend `proof_supplements` and existing frozen commerce stages; persist a separately signed snapshot/index with covered root, ordered entries/head, cutoff and sequence. | No second commerce Proof, new truth store or reopening finalized root. Stored original manifest bytes/hash and existing serializers remain authoritative. Corrections append. |
| ADR-02 Portable format | Version the new envelope/profile, sign its exact bytes, reuse supported signing runtime and independent verifier. Freeze integer/order/UTF-8/field rules in the contract. | Existing `canonicalize` is historical PackProof serialization, not a general RFC 8785 certification. Never recanonicalize old stored roots. Pinned trust arrives independently of package keys. |
| ADR-03 Receipt | Bind server-issued intent, immutable capture/session, actor, Proof and sealed committed evidence context into a signed completion envelope. | Callback or local upload completion cannot assert finalization. Native OS biometric prompt and web user verification must be described by their actual method, not fingerprint/identity guarantees. |
| ADR-04 Recipient | Keep existing preview/approved-digest export path. Defer programmatic submission until a named recipient profile, actual permissions and pilot validate it. | PackProof does not decide liability, refunds, acceptance or fraud. File format success is not recipient acceptance. |
| ADR-05 Rollout | Additive migrations, disabled-by-default future capability, explicit tenant/canary activation, old evidence always readable. | Database schema guard rejects unknown migrations in the old image; rollback after migration requires a new-schema-aware reader image with writers off. Direct rollback to `a504173` is not safe after 061/062. |

The first pilot's commercial owner, recipient, budget, data rights and operating sample remain founder/partner decisions. Implementation choices above are bounded engineering decisions; they are not a claim that external parties approved a protocol or that a privacy/insurance review occurred.

## Threat model and focused acceptance

| Failure / actor | Required invariant and focused evidence |
|---|---|
| Participant or tenant swaps Proof/session/intent | Server independently authorizes every operation and compares all receipt and snapshot contexts. Reject wrong actor, tenant, root, capture and intent; host never selects signer/claimed success. |
| Exporter truncates or substitutes the supplement chain | Signed snapshot authenticates exact ordered head/scope; independent verifier rejects altered count/head, swapped root/Proof, missing covered entry and mismatched digest. |
| Exporter substitutes attachments or derivation references | Verify included bytes against authenticated inventory, disclose missing originals, and preserve original digest plus frame time/tool provenance. |
| Client replays consent/receipt or changes evidence | Challenge bound to actor, Proof, session, purpose, digest and expiry. Exact idempotent recovery differs from a new unauthorized action. Changed approved evidence needs new consent. |
| Signer revoked, compromised or registry stale | Separate mathematical signature validity from trust policy and freshness. A package cannot self-authorize its bundled key; a self-claimed historical signedAt does not defeat compromise. |
| Offline reader sees old history | Validate the historical snapshot, label current/latest status unknown without fresh authenticated material; don't claim no later correction exists. |
| Callback supplies forged carrier status | Durable notification queues only a hint; authenticated provider reconciliation supplies evidence. Keep provider reports source-labeled; don't manufacture carrier signatures. |
| Provider outage or duplicate delivery | Existing lease/dedupe/backoff/DLQ controls preserve work; receipt/export integrity does not depend on provider response. No blind retry of future irreversible submission after unknown acknowledgment. |
| Local process death / storage pressure | Preserve completed original and journal until exact server commit receipt. Explicitly report unavailable/unplayable tails; do not claim Android incremental recording survival without qualifying it. |
| Privacy exposure through export/telemetry | Recheck authorized media/fields; no new permanent public catalog. Credentials, media, addresses and share tokens do not enter logs or product analytics. |

Legacy compatibility acceptance: retain representative frozen fixtures; compare original canonical bytes and SHA-256 before and after a delivery supplement, return stage and correction, then verify both old root and old exported snapshot. New snapshot creation must not mutate existing supplement entries, finalized evidence, attestation or transaction uniqueness.

## Durable delivery findings

Reuse the implemented transactional audit/outbox and webhook worker. It signs timestamped envelopes, bounds retries to dead-letter state, validates public HTTPS/DNS and disallows redirects. Delivery is at least once; consumers must deduplicate event IDs. Dispatcher backfills missing event deliveries, avoiding a global commit-order cursor.

Remaining transport gaps before external API promotion:

- Public `listEvents(after)` orders by allocated database sequence, not transaction commit order. A lower sequence committed late can be missed by a consumer that advances its cursor. Fix or publish a reconciliation/consistent-watermark contract before describing it as a complete durable pull stream.
- Shippo inbox intentionally coalesces untrusted notifications per transaction/five-minute bucket; it does not retain every provider event as evidence. Authenticated refetch and polling recovery are the correctness path.
- Legacy trusted-provider receipt identity is `(adapter_key, provider_event_id)`, not account-scoped; receipt insertion follows normalized import. Normalized observation idempotency limits duplication, but this is not the plan's generic atomic provider/account/event inbox. Reconcile when selecting the next actual provider.
- Key rotation exists; coordinated receiver rollover/retired-key acceptance and real receiver tests remain operational gates.

## Claims compiler findings

Reuse immutable case snapshots and export jobs, versioned recipient profiles, bounded derived stills, source digest/frame time/tool metadata, page/size/type preflight and exact-artifact approval. Stored files are rehashed before approval/download. Existing output explicitly keeps provider acceptance and merchant-controlled submission separate.

Before claiming WP-10/12 complete:

- Bind an actual external dispute identifier and reason to a recipient-profile version. Current request is a generic payment-dispute packet; profile `requiredFacts` alone does not implement reason-specific relevance or validate required evidence.
- Validate the selected destination/account's permitted fields, network, deadline and restrictions. Repository profiles checked September 7 are dated configuration, not a fresh provider access check.
- Revalidate profile freshness at final approval and future submission. Existing code checks it at queue/render; approval checks deadline and file digests. Rendering can still spend work after the recorded deadline, which approval then rejects.
- Preserve scoped omissions and contradictory evidence explicitly. Current concise rendering discloses truncated chronology/declarations but does not prove every reason-relevant conflict is included.
- Have an authorized reviewer inspect actual rendered output offline and measure preparation/review effort plus factual corrections. No reviewer or portal acceptance result is inferred from PDF generation.
- Submission remains a later operation with exact-digest/destination approval, provider dispute dedupe, deadline checks and `SUBMISSION_UNKNOWN` reconciliation. No external claim is sent by this branch.

## Activation and rollback gates

1. Review source/API/schema deltas and run focused snapshot, receipt, authorization, legacy-manifest, export/verifier checks. Run the affected workflow once complete and full regression at shared-contract/merge gate; don't repeat unrelated broad suites.
2. Confirm the migration checksum ledger and backup/restore process against the intended environment without rewriting old migration files or adopting unknown checksums silently.
3. Activate only on an explicitly selected canary tenant using a new-schema-aware image and configured signing/trust material. Keep paid AI, new research and unrelated workflows disabled.
4. Verify actual host launch → same bound recording → durable commit → signed receipt → independently checked snapshot → recipient-ready packet on a real authorized order. Measure additional operator effort, interruptions, usable commits, reviewer corrections and cost, including failures/abandonments.
5. Stop activation for wrong-Proof binding, cross-tenant disclosure, sealed-record mutation, lost evidence concealed as success or unsupported trust claims.
6. Roll back by disabling new writers and using the compatibility reader image. Keep the feature and selected IDs enabled to preserve reads. Preserve sealed records, queued work and readable schemas. Do not delete Proofs, undo manifest bytes, restore an old database over newer evidence or drop the new tables. Qualify database backup/restore for snapshot and receipt rows: these new tables are not included in the legacy recovery-journal export.

## Remaining external and later-phase decisions

| Gate | Required evidence before expansion |
|---|---|
| First external loop / WP-11 | Named merchant cohort, order source, capture surface, reviewer, authorized sample, baseline, budget and support owner. |
| Android recovery qualification | Real S24 Ultra/A16 process-death, reboot, storage pressure, URL expiry and interrupted-video tests; incremental writer capability must be measured. |
| Web/iOS activation | Actual browser origin/user-verification/camera/lifecycle validation; real iPhone/signing/provisioning for iOS. |
| Repeat returns / full graph | Line/package quantity allocations, repeated/partial returns, independent disputes and bounded as-of queries beyond current unique-stage model. |
| Custody/scale/EPCIS | One participating 3PL/receiver, actual hardware, staff workflow/consent and supported event profile. |
| Assurance / agent adapters | Named consumer, scoped agreement, verified need/permissions; no coverage benefit or new agent authority inferred. |
| Fingerprint/advanced vision | Separate capped experiments, permissioned samples, held-out specimens/devices/batches and measured false-match/abstention/operator effort. |
| Data rights / enterprise | Actual retention, holds, participant visibility, approved data use and incident/restore review. No new irreversible object retention or training rights assumed. |

The next phase advances only after an external consumer uses the existing evidence loop with acceptable reliability, effort and cost. Software implementation alone does not satisfy that gate.
