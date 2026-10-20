# Candidate acceptance record — 20 October 2026

Base commit: `cb82e6e57d50c51e4c55c3e1525a3adc61ce15d5`. Candidate identity is the commit containing this report and the linked PR. Local execution: Windows, Node 22.23.2, Vitest 4.1.11, PGlite; shared Express routes invoked in process because localhost socket connections are denied. Media uses the existing test object-store adapter. Tests use synthetic identities and a repository media fixture, not customer recordings.

| Gate | Actual candidate evidence | Status / limit |
| --- | --- | --- |
| T01 | Same order number at two merchants with different owners; exact replay, fresh-key business replay and changed-body conflict | Local pass |
| T02 | Cross-merchant read/list/resolve/capture/package denied; forged actor fields rejected; signed cursors scoped; third operator grant checked | Local pass; full staging route/media/job matrix pending |
| T03 | Wrong operator cannot redeem launch token; revoked grant blocks token/replay/queued webhook; revoked operator disappears from legacy/new lists while participant history persists | Local pass; real in-flight device/staging checks pending |
| Shared merchant path | Shared capture bind/seal/upload/commit, actual human attestation, finalize and delegated .pkpr export; replay keeps exact canonical manifest | Local pass with test storage; not preservation certification |
| T04–T05 | Existing recovery/resumable paths retained; issuing authorization rechecked through bound sessions | Real device interruptions and staging ambiguity matrix not executed |
| T06 | External signer can concurrently change a Proof without transaction deadlock; changed candidate rejected; outage leaves no manifest; repeat finalization returns one signed immutable record and recovery event | Local pass; full preservation crash/restore gate pending |
| T07 | Rollback allocation, binding creation events, paging, forged/cross-tenant/filter/expired cursors; held writer, blocked second writer, reader reconnect and complete committed stream | Local pass plus real PostgreSQL 16 CI pass in run 39484542895; deployed staging still pending |
| T08 | Inbox crash rollback, durable job, database-state reopen, duplicate/out-of-order IDs, signature/timestamp/endpoint/tenant checks, revoked worker | Local pass; external side-effect reconciliation remains integration-specific |
| T09/T13 | Existing signing, verifier, retention and recovery code retained; organization policy capture/restore allowlists extended | AWS/staging restore and storage-lock gates not executed |
| T10–T16 | Unchanged existing claims/provider/client/capacity paths and gated later milestones | No new passing claim; run the changed/activated scope after prerequisites |

Focused command:

```sh
cd backend
npm test -- --run tests/organization-foundation.test.ts tests/commit-safe-event-stream.test.ts tests/finalize-signing-boundary.test.ts tests/partner-receiver.test.ts tests/partner-postgres-gate.test.ts --pool=threads
node --test ../examples/merchant-receiver/partner-client.test.mjs
```

The real PostgreSQL test requires `PACKPROOF_TEST_DATABASE_URL` and uses an isolated random schema. CI configuration is `.github/workflows/partner-foundation.yml`; passing CI is separate from staging configuration and restore evidence. The plan's release recommendation remains **HOLD** pending those gates.

The final local run passed 12 foundation checks and two reference-adapter checks; the PostgreSQL check was skipped locally. Local `npm run typecheck` reports ten diagnostics in existing RND modules caused by unavailable `asn1js`, `pkijs` and `cbor` dependencies and consequent implicit-any types. An offline install could not fill the cache. A clean CI `npm ci` and full typecheck passed on candidate `2c10772facd3351ab414d00106b6c731cc490b34` in [foundation run 39481565300](https://github.com/thepackproof/packproof-v2/actions/runs/39481565300). The earlier candidate had a capture-message quoting error caught by CI and corrected in that commit.

The pinned baseline's [CI run 39432492149](https://github.com/thepackproof/packproof-v2/actions/runs/39432492149) already failed 84 web tests and two mobile review-build assertions (version 70/71 and startup-bar color). The initial candidate reproduced those failures without changing web/mobile source. These remain release blockers; they are not a green full-suite result. Baseline backend and PostgreSQL release-invariant jobs passed, so candidate regressions in those jobs must be resolved independently.

Local filesystem-backed media validation hit Windows sandbox restrictions on hard links. The shared authorization/capture test then used the existing `MemoryObjectStore`, explicitly limiting the result to domain/service behavior. PGlite disk initialization also failed in the redirected sandbox temp path; receiver restart uses PGlite's exported persisted database state loaded into a new instance. These changes do not establish real filesystem durability.

## Required next evidence

1. Approve the proposed new isolated synthetic staging foundation and its 90-day GOVERNANCE retention, as required by plan page 39. AWS reconnection and read-only inventory are complete; the existing V2 staging-named service is production. Review [AWS evidence](AWS-READINESS-2026-10-20.md) and the [concrete continuation](../../infra/partner-foundation/README.md).
2. Record the final full backend build result and resolve the existing web/mobile CI failures before release. Clean dependency installation, typecheck and 37 focused checks passed on `c5d57b8bf6ec9664f9e6186f400cfa06cadf568e` in [run 39484542895](https://github.com/thepackproof/packproof-v2/actions/runs/39484542895).
3. Execute M1-05 staging separation, protected-storage/IAM/key-trust and fresh-target restore using new and revoked organization authorizations; compare baseline manifest bytes and exports.
4. Execute web/Android interruption, upload ambiguity, wrong-Proof and revocation scenarios on actual builds/devices. Preserve SIGNAL presentation.
5. Obtain independent M1-06 review and an explicit cohort decision, then implement M2's stable detached-envelope/SDK path and named merchant pilot. Collin selects the live partner and authorizes production expansion. No synthetic result counts as merchant adoption.

The attached plan itself requires M1 evidence before a full SDK/developer platform. M3/M4 are demand-led and M5 requires a stable signed profile and independent conformance. They are intentionally reported as open, not silently considered fulfilled by pre-existing source.

## Reconnected continuation and compatibility correction

The full backend run for `285ec3fa81cec5260c7dc4358bc31a873d7b5c8b` completed with 1,387 passed, seven failed and 15 skipped checks. The failures were one missing legacy OpenAPI scope and six assertions tied to the old 86-file research migration package. Commit `c5d57b8bf6ec9664f9e6186f400cfa06cadf568e` adds the scope, packages the new partner contract in the image, and updates compatibility tests to exercise the historical inventory separately while explicitly asserting that the retired research operator refuses the new inventory. Its production operator code and old migration bytes remain unchanged.

The corrected targeted CI passed 13 foundation checks (including real PostgreSQL), two reference-adapter checks and 22 contract/migration-packaging checks, plus full typecheck. The broad CI run is [39484542967](https://github.com/thepackproof/packproof-v2/actions/runs/39484542967); its final backend result must be recorded separately. Existing baseline web/mobile failures remain release blockers. The isolated infrastructure template has passed AWS ValidateTemplate and top-level resource-schema checks; its dedicated cfn-lint CI is separate from both application CI and actual deployment evidence.
