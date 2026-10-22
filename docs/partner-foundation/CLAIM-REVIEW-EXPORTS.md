# Claim-bound merchant review exports

This additive M2-04 slice connects the existing recipient exporter to a dispute business identity. It does not activate a provider integration or complete M2. Both `PACKPROOF_ORGANIZATIONS_ENABLED` and `PACKPROOF_CLAIM_EXPORTS_ENABLED` default to disabled. Migration `094_claim_cases.sql` has not been applied in production.

## Identity and attribution

A case belongs to a registered merchant integration namespace and individual dispute ID. The namespace already binds provider, external provider account, merchant and environment. The same payment may have multiple cases; matching order IDs never collapse them. The payment must already be bound to the same Proof/account. Explicit affected item IDs must belong to that Proof. An empty item list means payment-only scope, with an explicit allocation gap.

The first cohort supports a current human contributor on a finalized organization Proof who also has a current direct merchant membership. It does not infer merchant authority from partner membership, buyer participation or a machine principal. HTTP case and claim-bound export access requires authentication within five minutes. Actor identity comes from authentication, never request JSON. Revocation, disabled organizations and feature flags are rechecked on reads, retries, worker execution, approval and download.

This source supports manual direct-Stripe portal observations for explicitly reported US card disputes. Other regions and payment methods are rejected. A namespace does not prove OAuth connection or provider account ownership. Every snapshot says `MERCHANT_REPORTED`, `UNVERIFIED` and `MANUAL_PORTAL`; it records reason, network, region, payment method, reported status/deadline/actions, retrieval time, recorder and recording time. These fields must not be described as API-verified. Provider retrieval, provider opening time and pre-dispute existence remain unverified.

Case identity is immutable. Changes append a digest-linked revision under a case row lock and require the expected current digest and a later observation. Exact retries replay; conflicting inputs fail. Limits are 100 cases per Proof, 100 revisions per case and 100 selected item IDs. Original manifests, IDs, signatures and attribution remain unchanged.

## Export and approval

The existing SignatureCase remains a scoped evidence preview. Its `caseId` is distinct from the new `claimCaseId`. New export input binds both, the exact `claimSnapshotSha256`, recipient profile, narrative, selected frame IDs/offsets and actual reported deadline. Only reviewed `product_not_received` and `product_unacceptable` profiles are supported initially. The reason/network profile is versioned `2026-10-22.1`; `MANUAL_PORTAL` explicitly means no provider API version has been exercised. Unknown networks and unsupported reasons fail closed.

A portal observation must be no more than 24 hours old, report a response-eligible status/action and have a future deadline. This is a conservative product freshness rule, not a provider guarantee. The packet deadline must exactly match the selected case. The case revision must have a durable recovery receipt before the export request is admitted, the worker accepts output, or approval/download proceeds.

The exporter reuses bounded original streaming, full-file digest verification, the isolated FFmpeg renderer, exact presentation timestamps, derivative hashes and byte/page limits. Structured selection references point to the frozen transaction snapshot, included shipping observations, selected originals and included comparison observations. Human text remains labelled user-supplied. Missing communications, policies, delivery/address support, unselected comparisons and item allocation remain explicit gaps. Source references do not establish truth of a scene or automatically substantiate a claim.

Approval requires the exact artifact digest, case revision digest, readable-file confirmation and action `EXPORT_FOR_MERCHANT_REVIEW`. The short approval transaction locks/rechecks the current case after object reads. A new revision, closed response action, expired deadline, stale observation or revoked authority prevents reuse. Historical artifacts and approval records remain inspectable; the read model reports `REVIEW_REQUIRED` when new approval is needed. There is no provider acknowledgment state or submission dispatch. The submission endpoint explicitly returns `CLAIM_PROVIDER_SUBMISSION_UNAVAILABLE`.

## Contract and recovery

The machine contract is `backend/claim-export-openapi.json`, served at `/v1/claim-export-openapi.json`. Human case routes are `/proofs/:id/claim-cases`, its individual-case read and `/revisions`. Claim-bound preparation, preview, approval and download extend the existing `/proofs/:id/recipient-exports` routes. Existing exports without a claim binding retain their contract.

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| C07-01 identity and history | `domain/claim-cases.ts`; migration 094 | Same payment/multiple disputes, colliding account IDs, wrong payment/line/merchant denial, concurrent revisions |
| C07-02 source selection | `export/claim-profiles.ts`; existing scoped snapshot | Deterministic references and explicit gaps; no generated factual assertions |
| C07-03 files | Existing recipient renderer and streaming paths | Linux integration renders real synthetic media and checks exact approval/download |
| C07-04 exact binding | Request/artifact snapshot, versioned reason/network profile | Changed deadline/profile/revision and submission action denied |
| C07-05 export states | Existing job plus `claimReview` projection | PREPARING, REVIEW_REQUIRED, APPROVAL_PRESERVING, APPROVED or FAILED; provider submission unavailable |
| Recovery | Existing accepted-event outbox and fresh-target restore allowlist | Claim identities/revisions replay byte-for-byte; target writes remain closed |

Case revision, audit and recovery event commit together. Case history is included in the existing core snapshot and restored after its organization/account dependencies. Synthetic tests use real signing/verification with in-memory storage doubles; they are not cloud Object Lock evidence. The PostgreSQL foundation gate additionally runs the claim suite to exercise concurrent revision serialization against PostgreSQL 16.

## Release boundary

Before activation: run the current migration preservation/operator and rollback-bridge review for 093/094/095; validate deployed claims, policy revocation and replay with the actual runtime roles; validate the protected recipient artifact and request/result/approval recovery protocol under actual deployed roles; validate the human review interface and actual web/Android lifecycle; identify a consenting merchant and its account. The additive protected export protocol is described in RECIPIENT-PRESERVATION.md. Local and CI fixtures do not establish actual cloud protection or production restoration. The feature flag remains off until those activation gates close. No production migration, IAM change, provider call or merchant submission is implied by merging this slice.

The remaining provider adapter requires eligible account authorization, exact API-version validation, provider-retrieved case state and permitted actions, exact-package submission approval and timeout reconciliation before retry. Shopify Payments is not inferred to be a direct Stripe account. Provider acceptance and claim outcomes are separate from packet generation.

Primary references reviewed on 22 October 2026: [Stripe dispute object](https://docs.stripe.com/api/disputes/object), [reason categories](https://docs.stripe.com/disputes/categories), [responding](https://docs.stripe.com/disputes/responding). The separate recipient profile review documents current file constraints and their limits. Local/CI results and exact source commits are recorded in the implementation pull request; cloud acceptance is not claimed for this change.
