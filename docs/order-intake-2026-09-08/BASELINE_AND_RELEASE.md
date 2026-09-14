# Order intake: baseline and controlled release

Recorded September 8, 2026 before intake implementation. This is source and CI evidence, not a claim that new intake works live.

## WP0 baseline and reuse map

| Boundary | Established baseline |
| --- | --- |
| GitHub baseline | `d8dfe247221d0a3c157a60186f3c8dedb4e69d38`, branch `main`; implementation begins on `feat/order-intake-handoff`. |
| Sites baseline | `08ab27901da5ddf389d035992bf0e0b98e5c0864`, clean `main` in the inspected pilot checkout. |
| Source equivalence | Both commits have complete tree `00a484b363cf1f2792306ecdba80f9e7908510a1`. Every tracked file was compared byte for byte and matched. Different commit history does not indicate a runtime-content discrepancy. This compares source trees, not served production bytes. |
| Migration head | `backend/migrations/053_study_ui_instrumentation.sql`; 54 files, including two distinct `027` files. Add a forward migration; do not edit applied SQL. |
| Order identity | `domain/transaction-import.ts`, `integration-identities.ts`, `commerce-order-records.ts`, `transaction-items.ts`; reuse tenant-scoped external identity and existing import commands. Paths in this row are under `backend/src`. |
| Proof creation | `backend/src/domain/create-proof.ts`: `createOrGetProof`; `backend/src/app.ts` owns route registration. One transaction retains one canonical Proof. |
| Capture and handoff | `backend/src/domain/capture-sessions.ts` / `http/capture-router.ts` own authorized, idempotent capture issuance and recovery. Inspect `domain/packing-relay.ts` before adding pairing infrastructure; it already provides station pairing and durable commands. |
| Finalization and reads | `backend/src/domain/finalize.ts`, `finalize-requirements.ts`, `canonical-proof.ts`, `proof-supplements.ts`. Admit new order context durably, pin at acceptance, preserve existing manifests and post-finalization supplements. |
| Independent work | `backend/src/operations/scheduler.ts` records worker heartbeats and prevents overlapping callbacks; existing commerce/capture-shipment workers use database leases. Reuse these patterns, bounded concurrency and identifier-only diagnostics. |
| Existing intake | `backend/src/intake/order-intake.ts` is a bounded paste/share preview requiring confirmation. It is not automatic email ingestion. Existing `integrations/email/delivery.ts` is outbound SMTP, not SES receiving. |

Last committed release evidence reports Android 0.3.10 / version code 39, a completed EAS build, ECS revision 19 and checksummed migrations through 053. Its runtime source predates the two baseline commits; the evidence identifies the relevant unchanged runtime paths. The current environment was not queried for authenticated provider or hardware state. See [prior release evidence](../proof-navigation-2026-09-08/release-evidence.json) and [recorded public backend checks](../proof-navigation-2026-09-08/backend-live-verification.json).

## Existing CI issue and focused checks

[Main CI run 34262188685](https://github.com/thepackproof/packproof-v2/actions/runs/34262188685) passed backend, web, mobile, Android Kotlin/debug build, PostgreSQL, dependency audits and deployment-script jobs. Its only failure was the source-secret scan: `generic-api-key` matched line 5 of `docs/proof-navigation-2026-09-08/release-evidence.json`, a public source commit identifier. This change adds one reviewed allowlist requiring that exact file, exact 40-character value and exact detector. Default rules and history scanning remain enabled; changed values and other files remain scanned. Hosted Gitleaks success remains the acceptance gate for this repair.

While editing, run only affected tests plus typechecking for changed projects. Run existing mandatory CI once on the stable candidate; do not replace its gates with a large collection of repeated local tests.

| Candidate gate | Existing command / facility |
| --- | --- |
| Backend | In `backend`: `npm run typecheck`, `npm test`, `npm run build`. Shared mobile dependencies and `ffmpeg` are required by portions of the suite. |
| Web | In `web`: `npm test`, `npm run build`. Existing CI rebuilds once and compares actual asset inventories for deterministic output. |
| Mobile | In `mobile`: `npm run typecheck`, `test:build-security`, `test:proof-record`, `test:study-timing`, `test:redesign`, `test:recovery`, `test:api`; CI also runs `proof-navigation.test.ts` and `share-cache.test.ts`. The `test:*` entries are npm run scripts. |
| Real PostgreSQL | Existing CI runs `tests/migrations.test.ts` and `tests/release-postgres.integration.test.ts` against PostgreSQL 16 with `PACKPROOF_REQUIRE_POSTGRES_RELEASE_GATES=1`. Add intake race/locking coverage here when its implementation needs real PostgreSQL. |
| Remaining required CI | Native attestation/unified-camera Kotlin compile, debug APK, high/critical dependency audit, pinned Gitleaks history scan, release BOM/publication tests, Python verifier and PowerShell deployment tests. Preserve `.github/workflows/ci.yml`. |
| New acceptance | Execute plan T1–T12 on the shared candidate, emphasizing cross-source races, revoked pairing, hostile/incomplete input, flag-off durability and unchanged historical manifests. Record source/test, staging and hardware results separately. |

## External readiness register

| Gate | Evidence / required closeout |
| --- | --- |
| Browser family | Only synthetic eBay API fixtures exist in this baseline. No representative authorized single-order page HTML was supplied. A synthetic parser fixture is useful for tests but cannot establish real-page or opt-in print-trigger readiness. |
| Email family | No representative raw seller notification MIME was supplied. Record the exact validated family/version and prove required fields before enabling automatic readiness. |
| Selective forwarding | No verified forwarding setup was observed. Owner verification plus one sufficiently detailed supported sample are required; receiving arbitrary mail is not activation. |
| SES ingress | No inbound SES pipeline was found. Prepare narrowly scoped resources and queued object-reference processing; prove DNS/receipt rule, envelope metadata, private raw retention and bounded replay before activation. |
| Shippo merchant access | Existing Shippo code and evidence cover tracking, with a successful historical sandbox tracking read. They do not establish merchant Orders permission or OAuth availability. Keep order ingestion inactive until an authorized merchant account passes read-only validation. Do not reuse the platform tracking key as assumed access to merchants' orders. |
| Signed Android automation | [Latest AAB workflow 34260423489](https://github.com/thepackproof/packproof-v2/actions/runs/34260423489) failed before installation because repository `EXPO_TOKEN` is unset. Use an existing authorized EAS session if available or resolve that single credential dependency; repeating the failed workflow cannot fix it. |
| Hardware | S24 Ultra and A16 5G capture, biometrics, upgrade/back navigation, interrupted upload and queued handoff require actual device checks. None was performed for this intake candidate at baseline. |

## Build and release runbook

1. Keep intermediate checkpoints on the feature branch. Main pushes touching `mobile/**` automatically trigger `.github/workflows/android-aab.yml`; avoid repeated main merges while editing. Do not build or deploy before the shared candidate is stable.
2. Record candidate commit, migration digest inventory and test evidence. Complete the mandatory CI run, resolve candidate failures and preserve the distinction between synthetic fixtures and real provider validation.
3. Deploy compatibility readers and durable guards first with all new intake admissions disabled. Apply only additive, lock-bounded migrations using `node dist/db/migrate-cli.js` and the existing migration authority. Preserve signing, origins, integration references and running captures. Do not enable new writes while any active API instance lacks the contract.
4. Deploy inactive adapters and matching clients. The existing staging workflow is manual and requires successful exact-main push CI; it calls `infra/deploy-staging-current.ps1`, then verifies `/meta`, web release metadata and actual asset hashes. Retain the current runtime inventory and known-good image before rollout. The existing CodeBuild specification builds/pushes the API image; it is not alone a deployment or migration gate.
5. For the current Sites web path, root `npm run build` invokes `web/scripts/build-sites.mjs`, producing `dist/client`, the existing server proxy and hosting configuration. Publish through the established Sites flow, preserving `/api` proxy/auth configuration and reporting the actual served version. Do not confuse this with the separate CloudFront staging publication path.
6. Build one final signed Android AAB with the existing `shipping-integration` EAS profile and remote signing identity, after choosing the next valid version code. Verify source identity, package, version/code, archive integrity, signing identity, SHA-256 and recipient-accessible download. Build creation does not authorize Play publication. At baseline, local commands available were Node/npm/Java; EAS, AWS CLI, PowerShell, Docker, adb and Gitleaks binaries were absent. Remote facilities or authorized sessions may still be usable.
7. Enable one controlled tenant only when its real-source, authorization and compatibility gates pass. Independently control intake admission, browser triggers, handoff delivery, mail processing and Shippo reads. Measure wrong assignments/duplicates (must be zero), latency, ready rate, queue age/retries and incremental cost. Do not describe blocked source families as live.
8. Rehearse rollback before expanding. Stop new source admissions and triggers, retain observations/queues/snapshots, and finish or resume accepted captures. Once any new-contract Proof exists, the compatibility build is the rollback floor. Neither a flag nor rollback may disable its durable finalization requirements; never rewrite manifests or drop populated schema to recover.

Closeout must give exact source/build/migration identities; supported real page/email versions; tested paths; externally blocked gates; flags; rollback evidence; and hardware work remaining. This runbook is a release sequence, not evidence that its steps have already completed.
