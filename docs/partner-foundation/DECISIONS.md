# Foundation architecture decisions (M0-02)

## 1. Explicit merchant ownership, actual machine creator, one human seller

New organizations are separate from legacy tenants. Each merchant owns one environment-specific API tenant. A service principal has a distinct non-login core actor user to satisfy existing user foreign keys; it has no authentication identity and never masquerades as its owner or operator. `transactions.created_by` and creation/capture-request audit events retain that service actor. The existing SELLER participant is the explicitly assigned active operator, who alone performs their personal capture and attestation. One SELLER/BUYER per Proof remains intact. Multiple operators work on separate Proofs; reassignment/multi-operator contributions require a future explicit additive contract.

Ownership, integration bindings and attribution are immutable. A grant intersects service credential scopes, merchant/environment and explicitly named operators. Merchant grants permit merchant-scoped service reads; they do not turn an employee into an organization admin. Revoked membership/grant/credential state is checked at execution, not only login or capability issuance. Relevant rows are share-locked through write transactions so revocation serializes with admitted mutations. Revocation takes effect for subsequent actions; already transmitted bytes cannot be recovered.

## 2. Additive migration; no inferred legacy backfill

Migrations 088–092 add associations and guards. No existing Proof, participant, manifest, key identity or outbox row is rewritten. The read-only preflight inventories ownership and frozen manifests. Every legacy tenant remains explicitly unmapped until its merchant ownership is reviewed. Names, email domains and colliding order IDs are insufficient evidence for a mapping. A new organization tenant cannot use owner-bound legacy API keys. Reassigning existing customer records is outside this candidate and must have a separate reviewed mapping manifest and dry-run counts.

## 3. Commit-order reconciliation

The legacy BIGSERIAL event cursor remains supported with its documented limitation. A new per-tenant row counter and immutable stream entry are committed atomically. Deferred constraint triggers publish all audit outbox inserts and initial binding events at transaction end. No external service call is added inside the stream-lock interval. Rollback rolls back both allocation and publication. Cross-tenant batches must acquire stream-head locks in sorted tenant-ID order before emitting events, or use separate transactions; this candidate's public commands target one merchant only.

The new cursor is HMAC-authenticated, versioned, scoped to tenant/environment/filter and expires after seven days. Its high-water mark comes from the primary database. The stream currently retains all entries; no pruning job is enabled. A future retention change must advance a signed/validated recovery floor and preserve snapshot recovery. Proof-list cursors use the first committed stream position, hold a one-hour membership snapshot and reject cross-merchant reuse. Neither stream order nor `createdAt` establishes physical event time.

## 4. Preserve signature formats and historical bytes

Existing manifest bytes, serializers, DER ECDSA/RSA-PSS signatures, .pkpr/ZIP packages and trust registry stay compatible. Root signing now happens after a preparation transaction closes. A second transaction rechecks authorization and eligibility and rebuilds exactly the candidate being signed. A change returns `FINALIZATION_CONTEXT_CHANGED`; it cannot attach the old signature to new bytes. Concurrent successful finalizers return the stored winner. Missing signing dependencies remain retryable. The existing preservation journal still determines durable status; a prepared or signed response alone is not preservation.

The proposed RFC 8785 / detached ES256 JWS integrity envelope and RFC 3161 timestamp state are deferred to M2-03. Do not relabel the existing signature as that profile or claim trusted capture time. No production signing key or public trust assertion is created here.

## 5. Explicit export capability and restore fencing

Only the package/review adapter constructs a process-local, read-only database capability for an authenticated service actor and one authorized Proof. It never persists a synthetic participant. Role-bound writes reject it and personal attestation rejects all service principals. The wrapper is not accepted from request data; callers cannot request an arbitrary actor. Bounded streams reauthorize during transmission.

Organization authority tables join the existing independently preserved policy journal. Credential last-use telemetry is excluded; raw secrets and encrypted replay caches are not journaled. Core recovery snapshots retain organization capture authorization associations. Missing associations on an organization capture or webhook fail closed. Restored access stays fenced until existing policy reconciliation and a fresh-target restore pass. This is implementation coverage, not proof of AWS retention/IAM, journal completeness or production recovery readiness.

## 6. Small receiver and server adapter before a broad SDK

The receiver authenticates exact raw bytes, timestamp, configured endpoint, tenant and environment. A unique inbox row and local job commit together. Local effects and completion state commit together. External effects need their own idempotency/reconciliation ledger; a timeout is unknown, not permission for a fresh submission. Secret rotation supports an explicitly bounded overlap at the receiver. The server adapter retains operation keys and rejects redirects; it never sends partner keys to browser/native clients. Hosted capture continues using the shared authenticated application.
