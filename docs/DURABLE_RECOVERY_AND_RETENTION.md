# Durable recovery, supplements and retention

Implementation scope: W02, W09, W11 and W12 from the September 7, 2026 comprehensive plan. This document distinguishes implemented boundaries from operational evidence still required before stronger preservation promises or disposal.

## Accepted-record protocol

1. The media adapter verifies and preserves the accepted exact object version.
2. The same database transaction commits the attributed evidence and an immutable `recovery_events` record plus a mutable `recovery_delivery` outbox row. The event contains canonical reconstructable Proof, transaction, participant, evidence/version, capture, declaration, manifest, shipment, custody, stage, hold and disposition facts. Credentials are excluded.
3. A scheduled worker leases the oldest undelivered event. It signs a domain-separated envelope and conditionally creates `recovery/v1/<SHA-256 operation ID>.json`. Existing objects are read and verified against the event digest and an independently configured trusted public key. The worker never overwrites a conflicting envelope.
4. Only a verified, readable immutable envelope produces `PRESERVED` and its stable receipt. A lost response after object publication is recovered from that same object, including its original signature and publication time. Prepared or orphan media alone never establishes an accepted record.
5. In strict mode, finalization requires durable evidence and declaration receipts, including a declaration linked to the seller's committed fulfillment recording. It freezes a signed manifest, returns `COMMITTED_PENDING_DURABILITY`, and leaves the Proof's status at `EVIDENCE_COMMITTED`. SQL guards reject changes to the prepared core. The outbox worker advances the projection to `FINALIZED` only after the final envelope is durable. Repeated finalization returns the same frozen manifest and receipt.

`finalizeProof(..., signer, {requireDurableReceipts: true})` enables strict behavior. Compatibility callers can still finalize under the previous logical-state contract, but receipt reads remain explicitly pending or unconfirmed; compatibility mode is not a stronger durability assurance. It must not be used as the controlled-pilot completion contract.

Receipt fields: `operationId`, `eventSha256`, `envelopeSha256`, `objectKey`, `objectVersionId`, `preservedAt`, and the signing context. A receipt's timestamp is envelope publication time, not independently verified camera capture time. Signatures and matching hashes do not establish physical truth.

## Client read contract

`getProofRecoveryStatus(db, userId, proofId)` authorizes the participant or accepted commerce recipient. The API route is `GET /proofs/:id/recovery`.

| Property | Meaning |
| --- | --- |
| `evidence[]` | Root and stage evidence, each with `evidenceId`, `captureSessionId`, optional `stageId`, and recovery status |
| `declarations[]` | Root declaration receipt, keyed by `attestationId` |
| `finalization` | Core finalization operation `finalize:<proof ID>` |
| `stages[]` | Later receipt/return finalization operations, keyed by `stageId` |
| `status` | `COMMITTED_PENDING_DURABILITY`, `PRESERVED`, `FAILED`, or `LEGACY_UNCONFIRMED` |

Retain a local original until its evidence receipt and the relevant core or stage finalization receipt are durable. A root finalization receipt does not cover a later return. Legacy rows with no recovery event remain `LEGACY_UNCONFIRMED`; they are not silently promoted by observing a database status. Stage finalization returns a separate recovery status; its existing logical manifest state must not be presented as a durable preservation receipt.

## Operations and replay

`processRecoveryOutbox(db, clock, publisher)` performs one ordered leased job. Schedule it independently of incoming HTTP requests. It requires a signer, trusted public-key resolver, a conditional-create store, an expected writer generation, and explicit verification that the journal's storage policy is protected. Local storage and S3 versioning alone do not establish independently protected journal durability.

The worker reclaims expired leases, applies bounded exponential retry with jitter, and stops at a dead-letter event. A conflicting envelope immediately dead-letters; other failures do so after eight attempts. This intentionally prevents later events from appearing fully preserved across a known journal gap. Operators must alert on dead letters, oldest pending work, absent worker heartbeats, and confirmed digest mismatches.

The database fence prevents a stale worker generation from publishing or marking receipts through the current database, including during publication. It does **not** independently fence a process still connected to an old restored database. Before disaster replay, isolate old writers at the infrastructure/IAM boundary and establish a durable external replay boundary. Keep affected reads and writes closed when that boundary is uncertain.

`buildRecoveryReplayPlan` verifies signed COMMITTED envelopes, checks global sequence and prior digest continuity against the supplied backup boundary, rejects missing or conflicting events, and returns reconstructable latest snapshots and accepted receipt identities. It reconstructs the final Proof projection from a durably accepted finalization envelope even if the lost database never recorded the worker's final status. It is an inspection/replay preparation tool; it does not execute an unreviewed database restore or open traffic.

Each Proof snapshot explicitly identifies its separate policy-journal dependency. The Proof snapshot alone does not contain complete account/authorization recovery facts. Migration 043 seeds an existing-data baseline and transactionally journals subsequent supported account, identity, membership, tenant/API-key, share/revocation, disclosure scope, recipient subscription, hold/disposition and derivative-policy changes. A core preservation receipt waits for its captured policy watermark to become durable. Do not backfill a historical accepted-at assertion from a merely prepared object. A protected journal must also preserve exact media versions and access to their decryption keys.

The independent policy worker publishes signed, conditional-create envelopes in global sequence with a previous-digest chain. Routine view counters do not generate policy events. Raw pending invitation tokens are deliberately excluded: missing pending invitations must be reissued after recovery. API credential identity and link identity cannot be rewritten or physically removed; revocation cannot be undone.

Migration 047 includes signed parent context for policy rows that refer to unfinished Proofs before their first core receipt. This freezes the related Proof, transaction, shipping, item and external-identity rows transactionally, explicitly without core acceptance. The fresh importer uses it only when an accepted core snapshot is absent and the context is still an unfinished state. It reports context-only Proof IDs, creates no synthetic accepted media or finalization receipt, and remains fenced. Older missing-context journals and committed/finalized contexts missing their core journal produce an explicit dependency gap.

`installPolicyRecoveryReplay` requires a signed expected watermark obtained independently of the restored database. It closes disclosure before verification, rejects signature/chain/boundary conflicts, reconstructs immutable policy events and durable delivery projections, advances the sequence allocator, and installs an authenticated desired-state overlay. It does not silently grant rights. `inspectPolicyRecoveryReconciliation` reports any difference between restored rows and signed facts. `completePolicyRecoveryReconciliation` clears the policy fence only after exact reconciliation; other media/infrastructure restore gates still remain. Participant, guest-token, disclosure and API-key authorization checks honor the fence. Strict mode also temporarily blocks authorization while accepted policy changes await publication. A tested disk-backup fixture demonstrates that a revocation accepted after the backup cannot be revived by restoring the older link row.

Operator sequence:

1. Stop affected writes and fence old application/worker credentials. Preserve diagnostics, immutable journal objects and object versions.
2. Restore into an isolated database with ordinary traffic disabled. Select the independently established backup journal head.
3. Run authenticated replay preparation and resolve every sequence, signature or dependency gap. Inventory accepted receipts, including responses that might have been lost.
4. Restore account/organization policy, invitations, revocations, holds and deletion dispositions through the separately validated policy journal. Never reopen private evidence using incomplete reconstructed permissions.
5. Reconcile exact-version media SHA-256, decryption access, original manifest bytes/signatures, supplemental heads and retention. Compare all acknowledged test receipts around the backup boundary.
6. Record measured restore duration and metadata recovery point. A second operator must reproduce the procedure. Open traffic only after the full coverage gate passes.

Retries: `retryRecoveryDelivery` requeues an existing dead-letter projection without changing its immutable accepted event. It is an internal administrative command, not a participant endpoint. A conflict requires investigation of storage/signing integrity; do not replace the signed object or edit its accepted event to make a retry pass.

## Supplements and offline trust

Supplements use a Proof lock and database uniqueness to allocate sequence numbers. Each has canonical bytes, its own digest/signature, the frozen core manifest digest, and the preceding supplement head. Participant idempotency is scoped to the actor and Proof. A correction can supersede only the same actor's earlier attributed assertion, preserving both assertions. An accepted recipient may append a response. Provider, parcel and return workflows use an internal authorized seam; an ordinary participant cannot label their input as a verified carrier update.

Configured carrier synchronization appends signed `CARRIER_UPDATE` supplements. Configured receipt/return finalization appends the stage's signed supplement and recovery event. The read projection is rebuildable from immutable supplements. Old exports remain valid dated snapshots; offline verification cannot prove that no later events exist.

`verifyWithTrustRegistry` verifies an independently signed, dated trust registry using pinned registry-authority keys. It distinguishes digest/signature validity from trusted key status, effective periods, retirement, revocation, compromise, unknown keys and stale revocation knowledge. A public key included by an untrusted package cannot authenticate itself. Known compromise requires review even when a signature has an apparently old signing date.

PEM and KMS runtime signing support `PACKPROOF_MANIFEST_SIGNED_TRUST_REGISTRY_FILE` together with `PACKPROOF_MANIFEST_REGISTRY_AUTHORITY_KEYS_FILE`. The authority file is an independently delivered JSON object mapping authority IDs to public PEM keys; it must not be derived from a submitted Proof archive. Both files are bounded, public-only configuration. Signed-registry mode excludes legacy trust-list/history configuration. Startup requires a current authority signature and an ACTIVE signing key matching the actual PEM/KMS public key and its algorithm/validity window. Before each signature, runtime reloads the approved registry; it cannot manufacture a fresh review expiry. A changed, revoked, compromised, retired or expired key halts new signing.

`ManifestSigningRuntime.readSignedTrustRegistry()` reloads and returns the exact reviewed JSON bytes for `/.well-known/packproof-trust-registry.json`, independently of signing traffic. Public refresh can distribute a COMPROMISED registry even while signing is halted. The legacy trust endpoint remains available but conservatively labels RETIRED or out-of-period keys REVOKED because its old schema cannot express their historical windows. The independently obtained Python verifier's `--trust-registry`, `--trust-authority-key` and `--trust-authority-key-id` options support the dated registry directly. RETIRED signatures must be within the key validity interval and no later than retirement. Future claimed signing dates fail; REVOKED and COMPROMISED keys always require review. Dates in a signature are not independent timestamp evidence, and offline verification cannot establish current revocation knowledge or physical truth. External authority distribution, custody, review and rotation drills remain operational acceptance gates.

## Retention boundaries

The default remains a 90-day minimum-protection concept with no automatic deletion. Draft versioned policies are configuration proposals. The PayPal-oriented draft starts its 180-day window at payment; missing payment/delivery anchors block disposition for review. These drafts do not constitute approved commercial terms or legal advice.

Applicable protection is the latest minimum, channel, contractual, notice and released-hold date across stored assignments. A later shorter assignment cannot silently reduce an earlier promise. Active stages and active holds block disposition. Holds record their actor, reason, scope and review date; release retains at least 30 further days, or the longer assigned policy interval. Review dates prompt review; they do not auto-release holds.

Hold admission and `lockProofDisposition` both take the Proof lock. Once a hold is accepted, disposition is blocked. After disposition is locked, a new hold request fails explicitly rather than promising to restore deleted originals. `listDispositionCandidates` is a bounded dry run only.

The `retention_operations_gates` row defaults to disposal disabled, with no approved policy or restore-drill references. This change performs no object deletion. A production disposal implementation, notices, independent authorization, immutable tombstones, backup reconciliation and a verified restore drill must pass before enabling that gate. Historic policies requiring review are not implicitly cleared by a shorter new policy.

## Verification evidence and remaining gates

Automated tests cover stable request digests, SQL immutability, publication-response loss, identical receipt recovery, conflicting envelopes, ordered queue halt, stale-writer rejection, unknown signer rejection, strict finalization boundaries, frozen core protection, replay gap detection, supplemental continuity, retained historical manifests, day-90/day-180/missing-anchor/active-hold behavior, hold/disposition exclusion, and dated trust status.

Still required before claiming the plan's operational acceptance: verified deployed storage and key protection; current signing authority distribution and rotation/compromise drill; independent scheduled worker deployment and alarms; production inventory confirming policy-journal coverage; isolated measured restore with all acknowledged receipts reconciled; real PostgreSQL concurrent hold/disposition and worker-fence drills; approved retention/offer/legal policy; actual notice/disposition/tombstone and former-subscriber access exercises. These gates cannot be replaced with a local unit-test pass.
