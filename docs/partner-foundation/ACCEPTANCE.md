# Candidate acceptance record - 20 October 2026

Base commit: `cb82e6e57d50c51e4c55c3e1525a3adc61ce15d5`. Candidate identity is the commit containing this report and the linked PR. Local execution: Windows, Node 22.23.2, Vitest 4.1.11, PGlite; shared Express routes invoked in process because localhost socket connections are denied. Media uses the existing test object-store adapter. Tests use synthetic identities and a repository media fixture, not customer recordings.

| Gate | Actual candidate evidence | Status / limit |
| --- | --- | --- |
| T01 | Same order number at two merchants with different owners; exact replay, fresh-key business replay and changed-body conflict | Local pass |
| T02 | Cross-merchant read/list/resolve/capture/package denied; forged actor fields rejected; signed cursors scoped; third operator grant checked | Local pass; full staging route/media/job matrix pending |
| T03 | Wrong operator cannot redeem launch token; revoked grant blocks token/replay/queued webhook; revoked operator disappears from legacy/new lists while participant history persists | Local pass; real in-flight device/staging checks pending |
| Shared merchant path | Shared capture bind/seal/upload/commit, actual human attestation, finalize and delegated .pkpr export; replay keeps exact canonical manifest | Local pass with test storage; not preservation certification |
| T04-T05 | Existing recovery/resumable paths retained; issuing authorization rechecked through bound sessions | Real device interruptions and staging ambiguity matrix not executed |
| T06 | External signer can concurrently change a Proof without transaction deadlock; changed candidate rejected; outage leaves no manifest; repeat finalization returns one signed immutable record and recovery event | Local pass; full preservation crash/restore gate pending |
| T07 | Rollback allocation, binding creation events, paging, forged/cross-tenant/filter/expired cursors | Local pass; held-writer PostgreSQL test supplied and skipped without explicit test DB |
| T08 | Inbox crash rollback, durable job, database-state reopen, duplicate/out-of-order IDs, signature/timestamp/endpoint/tenant checks, revoked worker | Local pass; external side-effect reconciliation remains integration-specific |
| T09/T13 | Existing signing, verifier, retention and recovery code retained; organization policy capture/restore allowlists extended | AWS/staging restore and storage-lock gates not executed |
| T10-T16 | Unchanged existing claims/provider/client/capacity paths and gated later milestones | No new passing claim; run the changed/activated scope after prerequisites |

Focused command:

```sh
cd backend
npm test -- --run tests/organization-foundation.test.ts tests/commit-safe-event-stream.test.ts tests/finalize-signing-boundary.test.ts tests/partner-receiver.test.ts tests/partner-postgres-gate.test.ts --pool=threads
node --test ../examples/merchant-receiver/partner-client.test.mjs
```

The real PostgreSQL test requires `PACKPROOF_TEST_DATABASE_URL` and uses an isolated random schema. CI configuration is `.github/workflows/partner-foundation.yml`; passing CI is separate from staging configuration and restore evidence. The plan's release recommendation remains **HOLD** pending those gates.

Full `npm run typecheck` was attempted. It reports ten diagnostics in existing RND modules caused by unavailable `asn1js`, `pkijs` and `cbor` dependencies and consequent implicit-any types. No candidate-source diagnostics were reported. An offline install could not fill the cache, and shell networking is restricted. A clean network-backed install/build must pass before merge; the missing packages were not stubbed out or removed.

Local filesystem-backed media validation hit Windows sandbox restrictions on hard links. The shared authorization/capture test then used the existing `MemoryObjectStore`, explicitly limiting the result to domain/service behavior. PGlite disk initialization also failed in the redirected sandbox temp path; receiver restart uses PGlite's exported persisted database state loaded into a new instance. These changes do not establish real filesystem durability.

## Required next evidence

1. Authenticate the AWS connection and identify the exact approved staging environment. Inventory and review before any mutation.
2. Run a clean dependency install/typecheck and the real PostgreSQL concurrency test. Record commit/build IDs and artifact references.
3. Execute M1-05 staging separation, protected-storage/IAM/key-trust and fresh-target restore using new and revoked organization authorizations; compare baseline manifest bytes and exports.
4. Execute web/Android interruption, upload ambiguity, wrong-Proof and revocation scenarios on actual builds/devices. Preserve SIGNAL presentation.
5. Obtain independent M1-06 review and an explicit cohort decision, then implement M2's stable detached-envelope/SDK path and named merchant pilot. Collin selects the live partner and authorizes production expansion. No synthetic result counts as merchant adoption.

The attached plan itself requires M1 evidence before a full SDK/developer platform. M3/M4 are demand-led and M5 requires a stable signed profile and independent conformance. They are intentionally reported as open, not silently considered fulfilled by pre-existing source.
