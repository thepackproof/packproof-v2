# Full-release continuation — 2026-10-22

The owner authorized completion of the full release. This supersedes earlier authorization limits; it does not turn incomplete acceptance evidence into a pass. The completed production foundation release is recorded below. Earlier checkpoints describe their state at the time.

## Gated envelope HTTP and worker implementation - 22 October 2026

The current development candidate adds first-party human admission, status and
exact-version package downloads, plus scoped partner reads/exports and public
key-history publication. Admission is limited to an explicit merchant cohort and
cutover. Worker leases recheck the accepted caller; downloads recheck current
authority and key trust. Separate process/database identities, protected storage
and source-bound acceptance evidence gate activation. The API has only the
read-only envelope adapter; only the worker can initialize the dedicated signer.
The [profile and configuration](ENVELOPE-PROFILE.md) explain the remaining gates.

Local build and the focused access, runtime, storage and job tests passed: 43
checks, with one independent-PostgreSQL contention case reserved for CI. The
public-key publication slice separately passed nine focused checks. Fixtures use
generated keys, synthetic storage and synthetic bearer authentication. They are
not evidence of hosted HTTP identity, production protection or a merchant pilot.
The full CI backend job for the first publication candidate stalled during media
package installation; the follow-up uses installed tools when present, bounds
fallback installation and still verifies both media binaries. Updated CI and
actual-role acceptance remain required before release of this candidate.

The first HTTP candidate, `312431f4347490df2f87b321971697f6641a0365`, then passed
all 87 envelope conformance checks on PostgreSQL, all 32 legacy Python checks,
foundation and CodeQL gates, web/mobile, dependency audits and deployment tooling.
Its container built successfully and verified all five contract paths, 94 exact
migrations and zero envelope DB calls when disabled. Full CI exposed one secret
scanner false positive in a fabricated test role name; the reviewed exception is
limited to that exact historical line. PostgreSQL CI also stalled at unbounded
media installation, so all matching CI setup steps now use installed binaries or
bounded installation. An additional admission/download byte-budget check rejects
oversize work before artifact I/O; its two boundary checks and seven access checks
passed locally. The updated container from `99e5283be1b117f4cf5a393d1850ccfab5992b58`
passed packaging and disabled-runtime checks. Its immutable digest is
`sha256:7c11381d50533186a077af3ed3d95b21b00e290c0eec52a5fc62635af4e9bc4b`;
the ECR scan completed with no findings at 20:06 UTC. CI found that the publication
transport had replaced the new test fixture's non-ASCII character. The fixture
now uses an explicit Unicode escape; all other changed runtime files matched the
local Git blob hashes. The continuation document's typography is also restored
using ASCII-escaped JSON during publication. The mobile job timed out downloading
an Ubuntu package; no mobile assertion failed. Full CI remains required.

Production remains the accepted inactive task revision 49 below. No organizations,
envelope API, envelope worker or claim export feature has been enabled by this
implementation. RFC 3161, hosted acceptance, separate production baseline roles,
physical-device acceptance, human review and a consenting merchant pilot remain
open. This is engineering progress toward M2, not full-plan completion.
 
## Production compatibility bridge and inactive M2 schema - 22 October 2026, 19:17 UTC

PR #123 released the compatibility bridge on the separate inactive-foundation
release branch. Production now runs task revision 49, source
`399f306a2fdac37511c8659c73d5a059dd759b7a`, image digest
`sha256:434f5cd40bf365a6bdf585fa6302f786ea4571dda892fd761c3dbd85d6b5aa54`.
The existing 5% canary completed at 100% with no triggered rollback alarm.
Its configuration, runtime authority and historical behavior were preserved.
Do not merge that older release branch into main.

The exact owner-injected operator applied migrations 093-095 in one transaction.
Production now has 94 matching receipts. Independent post-inspection matched all
ten frozen-record inventories and the effective runtime-authority digest.
The deployed bridge verified all 21 manifest signatures and all 29 exact original
versions (95,560,373 bytes), matching the pre-migration inventories. Public health,
readiness, source identity, unauthenticated denial and CORS checks passed after
the migration and again after cleanup.

All six one-shot tasks stopped successfully. The temporary database login is
absent, both temporary IAM roles are deleted, both temporary task definitions are
inactive, and the temporary CloudFormation stack reached DELETE_COMPLETE. Audit
logs are retained for 30 days. The [final migration receipt](m2-inactive-production-migration-2026-10-22.json)
binds these results to the [immutable bridge acceptance](m2-bridge-acceptance-2026-10-22.json).
The accepted bridge is the rollback boundary for this inactive 94-receipt schema;
the earlier task revision 48 is incompatible and must not be restored.

Exact runtime CI passed 1,408 backend tests (16 skipped); the main-line operator
and tooling candidate passed full CI, including 1,482 backend tests (17 skipped).
The earlier Node 18 build mismatch, historical build-locator secret-scan false
positives and PowerShell harness timeout remain recorded with their corrections.
The post-inspection script also passed in its actual owner-injected cloud task.

Organizations, claim exports and envelope routes remain disabled. The six new
tables are empty and have no non-owner grants. Separate production API/worker
permissions, protected storage and feature activation remain open, as do envelope
HTTP admission/status/export, public key-history distribution, RFC 3161 timestamps,
physical-device acceptance, human review and the consenting merchant pilot.
This completes the inactive-schema release; it does not complete M2 or the plan.

## Earlier combined recipient lifecycle and fresh restore - 22 October 2026

PRs #120 and #121 added actual separate database logins and the exact inactive
093-095 migration operator. PR #122 adds the combined RDS/S3/KMS acceptance
harness. The [cloud evidence](recipient-flow-cloud-evidence-2026-10-22.json)
records eleven one-shot tasks: ten passed, with 61 check entries including repeated
identity checks. The initial restore reconstructed the fresh database and matched
all nine tables, then failed a test assertion that expected a membership denial
instead of the stronger policy-recovery traffic fence. A version/hash-bound,
read-only follow-up passed, including exact signed revoked-membership comparison
and all 17 restored policy entries. The original failed report is retained.

The executed lifecycle source is 608f09be5e1cdc0b61bd883c1fa2f6e3eab707f7;
follow-up harness 0cfb76ee418af311081f073db61ed6e885f833fd changes no application
source or migration. Both immutable images and every downloaded report hash are
recorded separately. The worker reconciled an injected lost publication response
without rendering or publishing again. Requests, results and approvals waited
for protected durability. Stale claims and revoked membership were denied.
The running worker obeyed the completed external IAM fence using its cached
credentials. Seven core and nineteen policy records were durable before cutover.
Restore used exact protected versions, made no signing or recipient-publication
calls, and left writers and traffic closed. This is combined acceptance with a
read-only follow-up, not a clean first-pass restore or a general recovery-time
measurement.

All three temporary database logins are NOLOGIN, all eleven tasks are stopped,
and the existing isolated services remain at zero. The new temporary build policy,
build role/project, NAT and allocated address are removed. Both writer fences
remain CLOSED, ComputeEnabled=false, only local VPC routes remain, and synthetic
audit logging is stopped. Versioned reports, protected objects, images and logs
are retained. The synthetic fixture and two-day retention floor are explicit.

This closes the combined actual-role recipient database/storage restore gap.
It does not establish HTTP authorization, physical capture, human review or a
consenting merchant pilot. At that checkpoint production remained at foundation task revision 48;
migrations 093-095, a compatible rollback bridge, separated baseline runtime
privileges and production protection/activation are still separate gates. The
envelope API, key-history distribution, trusted timestamp and later conditional
milestones also remain open. The full M2 release and plan are not complete.

## Earlier M2 recipient continuation - 22 October 2026, 10:15 UTC

PRs #114-#117 are merged. They add protected recipient result and approval
recovery, the gated merchant claim-review UI, explicit API/worker database
privilege separation, and a reproducible actual-role storage probe. The final
application head cb74098996147ebe74a149ccb38fec8f86ce3a60 passed 1,475 backend
tests (17 skipped), web/mobile builds and checks, real PostgreSQL gates,
dependency audits and CodeQL. Its merge 20fbdc1680254de44cdbff6f4dced4072762efaf
has the identical tree. Harness head 98c5ec3d69f9aaee4ce95ba3f79ec6a50aa2aa03
also passed full CI; merge 4ca66aede6a3ba4e33762e0cdeb3f22fc4aa1a65 has its
identical tree.

Three one-shot Fargate tasks passed 26 assertions using the real compiled
recipient adapter and separate worker, API and restore-reader roles. The worker
recovered the first exact artifact after an injected lost S3 response, refused
a conditional contender, and obeyed a completed external write fence with its
already-issued credentials. The readers accepted only pinned exact versions.
Actual permissions denied writes, deletion, retention shortening and canary
access as appropriate. Every report was downloaded at its exact version and
SHA-256 verified; every task exited 0. The application and harness are separately
pinned in the [storage evidence](recipient-storage-cloud-evidence-2026-10-22.json).

This is storage-only acceptance: databaseRestoreVerified remains false. It does
not establish a full fresh database restore, production protection, HTTP
authorization, physical-device capture or merchant adoption. The two-day synthetic
bucket floor is not a production retention choice. The new database privilege
helper is not invoked automatically and has not changed production roles.

Cleanup is complete: zero isolated tasks, existing services at zero, both IAM
write fences CLOSED, ComputeEnabled=false, build project absent, NAT deleted,
allocated address released, local VPC routes only, and the synthetic trail
stopped. Protected objects, versioned reports, logs and immutable images remain.
No database was opened or changed by this storage run.

Production still runs foundation task revision 48, image
sha256:bfe92a04ea17de5b44bf3e7c7d34929669b40ef903d14f81d3be33cfef6362a2,
with one running task and no pending task. Migrations 093-095, baseline separated
database roles, a compatible rollback bridge, measured recipient database
restore, deployed authorization and actual browser/Android acceptance remain
release gates. Merchant cohort and pilot evidence are still required. The full
M2 release and the development plan are not declared complete.



## Completed foundation release - 22 October 2026, 04:20 UTC

PR #108 merged candidate `99bb2dfe0eb16d8d513617fdd4b9608d7baac3f9`; main merge `c4f331fb27996e465e880c79f141d9caf3ee0b00` has the identical tree. Exact-candidate CI passed every required job, including 1,401 backend tests (16 skipped), full web/mobile and real PostgreSQL gates. The expanded private HTTPS acceptance passed 19 checks, including active-stream and queued-dispatch revocation. Three package instances verified independently. These are synthetic integration results, not camera-device or merchant-adoption evidence.

The compatibility bridge completed its canary, then the five exact additive migrations applied in one production transaction. All 91 receipts match. All 21 frozen manifest signatures and all 29 exact original evidence versions (95,560,373 bytes) verified under both bridge and candidate against the migrated database. Existing inventory and runtime-authority digests stayed unchanged. The candidate image `sha256:bfe92a04ea17de5b44bf3e7c7d34929669b40ef903d14f81d3be33cfef6362a2` completed the native 5%-then-100% canary at 04:19:05 UTC with no alarm. Task revision 48 is the sole running production task. Health/readiness/meta, unauthenticated denial and CORS passed at 100%; exact deployed configuration matches the reviewed request. Only image and three release bindings changed.

The expiring migration login was removed, the temporary migration stack and both IAM roles are absent, and its task definition is inactive. Audit logs are retained. The bridge image remains the tested fallback only while organization tables are unactivated. Organization APIs remain disabled: production Object Lock/protected recovery, separated authority, shadow comparison and explicit cohort ownership still need their own implementation and evidence. Actual-device M2-02 and consenting-merchant M2-08 remain unverified. M1-05 permits documented production gaps; the scoped M1-06 review is by the implementing agent, not an independent human. See [release evidence](foundation-release-evidence-2026-10-22.json), [runtime evidence](isolated-runtime-evidence-2026-10-22.json) and [technical review](RELEASE-REVIEW.md).

## Earlier candidate-repair checkpoint

Based on PR #108 head `9af5c39c5cc231d5d0fb5df91919783d940aaf63`:

- Restore the remaining-shipment limitation in SIGNAL's compact Proof record and capture screen.
- Restore manual order refresh and give the recommended task its explicit accessible action name.
- Update web expectations to the current SIGNAL navigation, labels and receipt semantics. Supported fallback compositions are selected explicitly in their own tests; SIGNAL remains enabled by default.
- Add simulated-media SIGNAL checks for permission denial, interrupted capture and exact-operation recovery after a lost upload response. These use a real IndexedDB queue with simulated media and transport, and are not device acceptance.
- Repair mobile review-profile assertions to verify that production is unchanged and to check SIGNAL plus both fallback presentations without freezing the current production version number.

The GitHub source files, including fonts and icons, were synchronized to the pinned baseline before testing. Only the reviewed repairs and new evidence are included in the continuation commit.

## Validation

GitHub CI must independently pass on the published candidate; earlier green backend checks do not establish a green full release. Local validation used Windows and Node 22.23.2. Vitest used one thread worker and a writable temporary directory because the default fork pool encountered host temporary-file restrictions.

- Web production build and TypeScript: PASS.
- Web association and Sites routing checks: 11/11 PASS.
- Mobile local-review and startup-profile checks: 8/8 PASS.
- Full web run: 359/360 passed across 62 files. Its sole failure was an account-setup assertion expecting the retired default filter. That assertion was corrected to the current All filter; the complete affected file then passed 9/9. This is a full run plus a focused correction, not a claim of a second clean full run. Clean candidate CI remains required.
- Actual Android device acceptance: not run; `adb devices -l` returned no attached devices.

## Production migration boundary

Source comparison against the previously observed production commit `ccd04aba5b9305ce9bb7b2105323e63f6a95d87a` shows 86 historical SQL migrations unchanged and five additions in the 91-migration candidate:

1. `088_commit_safe_event_stream.sql`
2. `089_partner_organizations.sql`
3. `090_organization_command_results.sql`
4. `091_organization_read_visibility.sql`
5. `092_organization_policy_recovery.sql`

Fresh AWS inspection on 22 October confirmed production still uses `ccd04aba5b9305ce9bb7b2105323e63f6a95d87a`, image digest `sha256:ca3508eb6b8fbec678f28d8f1c4faa28f19802a2ab200d04511358bf17db9c1a`, task revision 46, with one healthy running API task. The private PostgreSQL 16.15 database remains encrypted and deletion-protected. A one-shot task using that same image and runtime identity completed the [read-only inventory](production-readonly-inventory-2026-10-22.json) over TLS 1.3: all 86 migration receipts match the running source, all 21 frozen manifests match their stored hashes, and 29 committed evidence rows have a recorded inventory hash. No owner secret was retrieved, and no schema, application record or service configuration changed.

The existing exact-source release operator is deliberately restricted to the older measurement release. `backend-measurement-inventory.mjs` permits 77 candidate migrations and 76/77 predecessor migrations. `backend-database-preflight.mjs` additionally requires the old staging environment and an exact runtime identity. The workflow does not apply migrations. It cannot deploy this candidate unchanged, and its checks have not been loosened.

The separate `backend/scripts/foundation-migrate.mjs` operator pins the observed 86-migration inventory plus five exact SQL hashes. It requires a fresh source/image/state-bound inspection, uses one transaction for all five migrations, compares frozen record and existing privilege inventories before/after, and grants only SELECT/INSERT plus specific mutable columns on 14 new tables. It does not reapply the broad generic runtime grant script, which would widen the separately restricted research-table permissions. Its owner-only CLI uses an expiring separate login and emits no secret values. It is prepared for PostgreSQL rollback/permission testing; a validated compatible predecessor and reviewed deployment path remain required before production DDL. No production migration has been executed.

## Resume sequence

1. AWS access is restored for account `784514617543`. Fresh production inventory checked the service, immutable image, task/execution roles, network and injected secret references without retrieving secret values. Treat the customer API's historical staging resource names as production resources. The reviewed `resume-acceptance-20261022` change set completed at 03:09 UTC: temporary isolated build/network resources and audit logging resumed; workload desired counts remained zero and the writer fence remained CLOSED.
2. Read the actual migration receipts using a TLS, read-only runtime connection. Compare every checksum to the pinned source. Review the five additive migrations against the current database and application roles. No owner secret is to be returned to the operator or logs.
3. Prepare and test an exact-source migration-aware release operator and a rollback-compatible predecessor before changing the live schema. Preserve existing ECS configuration, use a separate narrowly scoped migration execution path, and pin all artifacts. Do not assume the old strict-schema binary will start after the five new migrations.
4. Refresh expired protection evidence and verify its role, resource and source bindings. Resume the isolated environment through `infra/partner-foundation/RUNTIME.md`; it was deliberately paused, with both workload logins disabled and the writer fence closed. Do not initialize a new database against an existing protected journal.
5. Complete the deployed queued-delivery and active-export-stream revocation cases. Run actual web and Android acceptance for permission denial, interruption, process restart, lost upload/finalization responses, wrong-account/Proof resume and local recording retention.
6. Complete and record the M1-06 technical release review in `RELEASE-REVIEW.md`, bound to candidate source and evidence digests, including unresolved findings and a scoped recommendation. Correction to earlier handoffs: the plan assigns reviewer roles but does not mandate a separate human approver. A review by the implementing agent must be labeled as such, without claiming independence. Actual-device and consenting-merchant evidence cannot be substituted with synthetic tests.
7. After exact-candidate CI and acceptance pass, merge and roll out through the reviewed operator. Verify healthy tasks, source/digest, migration receipts, original package bytes, scoped authority and recovery after deployment. Record the release receipt and retain the tested rollback path.

The prior 16-check HTTPS demonstration and two independently verified evidence packages remain useful isolated evidence. They do not establish a live rollout, current protection freshness, physical-device acceptance or consenting merchant adoption. The plan's later demand-dependent milestones retain their stated entry criteria.

## Revocation acceptance continuation

Candidate `26a138ffed80584204988ae54a22a9f1b774265a` passed backend, mobile, PostgreSQL invariants, source/secrets, deployment tooling, dependency audits, iOS, infrastructure, CodeQL and partner foundation CI. Web passed 359/360: one async assertion retained a detached video element. The assertion now retries the DOM query; its focused test passed locally. The next exact-candidate CI run must confirm the complete web result.

The new deployed harness checks an already-started export with a 32 MiB inert MP4 `free` atom to enforce backpressure. This is synthetic padding, not camera-device evidence. After revocation the stream must abort, the API must stay ready, and a direct merchant export must preserve exact frozen manifest and evidence bytes. The isolated TLS proxy propagates an expected upstream reset safely.

Queued delivery is exercised by one-shot tasks using the actual worker task definition, injected configuration and non-owner login. The normal dispatcher first persists deliveries without sending; after grant revocation it must record failed attempts with zero transport invocations and no delivered receipt. The observation callback fails closed if reached and never contacts an external receiver. The build role gains only the exact isolated worker family, its two task roles and bounded task cleanup. These changes are prepared acceptance work; results are not claimed until the deployed run completes.

## Release-record follow-up

PR #110 records the deployed release and exact-source tooling. Its first secret scan flagged three CodeBuild project/build UUIDs as generic API keys; the exact historical commit/file/rule/line identifiers were reviewed and classified as non-secret audit locators. A subsequent web run exposed a detached-element race in the no-readable-label assertion. The test now queries inside waitFor and accepts the typographic apostrophe; the focused scenario passed locally. No application behavior changed. The refreshed broad CI result must be read at the final PR head.

The isolated runtime is now paused with zero tasks, both logins NOLOGIN, writes disabled, WriterFence=CLOSED and ComputeEnabled=false. The close archive is SHA-256 `947d9f5684f794b9a55beaa00bf0f03c65e8c261cb581df435d4aade1e74fa28`; exact version and observed infrastructure are in the runtime evidence. Customer production remains on the successfully released candidate.
