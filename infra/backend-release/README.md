# Exact-source backend release

## Current records upgrade (096-107)

The measurement-only `backend-release-runner.mjs` remains retired for this
candidate. Its 77-receipt guard must not be changed to 106 to force a release.
The current live database has 94 applied receipts through 095; its bridge image
bundles 91 source migrations. The records source has 106 files and exactly twelve
pending additions. `backend/scripts/records-migration-manifest.json` freezes the
full inventory digest and each new SQL checksum.

`records-buildspec.yml` builds a compatibility bridge from the measured immutable
live image and a separate current application image. It fails unless ECR retains
the old rollback image after both pushes. The reviewed bounded retention policy
is `records-release-ecr-retention.json` (ten images). Applying it is an explicit
release operation; the build never changes retention itself. New archives use
the `records-v1` root-layout profile, including shared contracts and research
configuration required by the existing Dockerfile.

`backend/scripts/records-migrate-cli.mjs --rehearse` accepts only a private restored
database whose identifier begins `packproof-records-release-`. A successful
migration and a separate stopped, exit-zero bridge task are required for the
source-bound rehearsal receipt. The production `--inspect` / `--apply` modes
require this receipt, current source/image bindings, TLS, an inactive organization
profile, and a fresh inspection. The operator uses a temporary 15-minute login,
applies all twelve migrations atomically under the existing migration lock, and
removes that login. Existing data, function bodies, triggers, table/column ACLs
and runtime memberships are hashed before and after. Only the two reads needed
by the legacy operator predicate are granted on new tables. Existing ACLs and
default policies are preserved. No organization, provider, signer, deletion
executor or new runtime credential is activated by this operation.

After rehearsal and the compatible bridge deployment, perform the production
migration through the reviewed one-shot owner-secret injection task. Then
provision separately reviewed API/worker credentials and baseline permissions.
Apply the source-bound records grant plan and M2 separation policy, and launch
`records-database-preflight.mjs` separately as each actual runtime login. It
requires all 106 exact receipts and rejects owner, migration-write, system-role
write and shared-role authority. The private authority-lock function is included
in the grant plan; the snapshot verifier accepts the same exact column grants.
Passing the schema migration alone does not qualify that runtime cutover.

Production cutover still requires the source-bound application/worker, restored
database, topology, operational profile and feature acceptance evidence. Never
substitute a fixture rehearsal, an unsigned installer, or a source-only build for
those results. Sites source synchronization is a separate publishing operation.

This dispatch-only route targets the existing customer-facing API named `packproof-v2-staging-api` in account `784514617543`, region `us-east-1`. It does not deploy Sites, change IAM, pricing, integrations, signing, or run migrations. It replaces the image and three release identity values through ECS Express while copying the existing primary-container configuration.

The first-proof implementation reuses the security-release operators prepared in the October 11 security follow-through. Their request-construction and service-revision reconciliation tests pass locally. Actual AWS permission, image, database and deployment gates remain unverified until the workflow executes successfully. Do not describe prepared source as a deployed release.

## Before dispatch

1. Merge/reconcile the security follow-through so `infra/backend-control-plane-readonly.mjs` exists on main. Run `Backend release inspect` and review its bounded output.
2. Verify current task definition, immutable image, rollout health, existing CodeBuild project, rollback ECR retention, current RDS recovery, and network/proxy topology. The runner deliberately rejects absent/unreviewed trusted proxies; do not replace this check with a guess or change proxy trust just to pass it.
3. Pin the topology SHA-256 using `hash` from `backend-deployment-plan.mjs` over the exact topology structure in the runner. Require a new inspection if configuration changes.
4. Freeze the reviewed main commit and require successful source-bound Backend, PostgreSQL release invariants, source secret/release tooling, backend dependency audit, deployment script and CodeQL checks.
5. Dispatch `Backend exact-source release` with that SHA, predecessor image digest URI, predecessor task-definition ARN, topology hash and release version. The workflow verifies the SHA equals the dispatched main head.

## Execution and evidence

Three restricted sessions of the existing `PackProofGitHubDeploy` role perform: unique Git-archive upload and existing CodeBuild image build; a short-lived read-only database verifier using existing runtime roles and credentials; and a configuration-preserving API update with bounded rollout and public health/identity checks. A denied permission stops the release; the workflow does not grant itself access.

Only whitelisted JSON receipts are uploaded. Full task configuration, input requests and rollback request remain private inside the runner. No secret values are read by the operator. The verifier receives the same runtime secret references as the service and never starts application workers.

The measurement candidate contains 77 migration files. Its source inventory must match the predecessor except for the single frozen 076 addition; a 76-file predecessor must contain the reviewed exact-checksum compatibility boundary. An identical 77-file predecessor is also accepted. All 77 migration receipts must exist before deployment. Missing `075_onboarding` stops the release with `ONBOARDING_MIGRATION_REQUIRED` because first-proof activation depends on it. No migration is silently installed by this zero-DDL route.

The primary release also provides a narrowly reviewed rollback compatibility boundary for the later optional study expansion: `076_first_experience_measurement` is accepted only with checksum `3b80452692918bb3589500d100b773deeb8cddf3c57b6882796e8cd1a13c1157`. It adds nullable study metadata and expands the existing event constraint without changing old writes. Every current migration remains required, unknown receipts and changed checksums fail, and the image release route does not install 076 or enable collection. The database verifier discloses any accepted forward-compatible receipt. Deploy and verify this primary image before applying 076; retain it as the compatible rollback target for the later measurement image.

## Rollback

The offline planner produces an image-only rollback request from the immediate pre-release predecessor. Before using it, reread the service and confirm whether AWS has already rolled back. Restore only the pinned previous image and its release metadata while preserving current runtime settings and data. Do not use `deploy-staging.yml`, desired-count overrides, historical owner secrets, schema rollback or the legacy website deployment wrapper.

## Known limits

Local Windows AWS login is currently expired. GitHub OIDC discovery must establish current access. Successful CI and public health do not establish physical camera, biometric, customer provider flow, background delivery or human usability acceptance. Retain these as separate evidence gates.
