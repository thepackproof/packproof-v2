# Admin dashboard deployment

Status on 2026-09-24: **the final API release is deployed and its required gates
passed**. Current source `147ecc73e1ae5663c96337df8afd0c60887e5c79`, image
`sha256:ecbce8061bb86d88b338395c0b32486836f48391494013639ccf306cd316fc24`,
and task-definition revision 35 reached native `SUCCESSFUL` at 11:20:37.372 UTC
with 100% production traffic, one target task running, zero pending, and no alarm
or circuit-breaker failures. All ten configuration-preservation checks passed.

Migrations 069–073, separate runtime credentials, administrator
bootstrap, and the candidate runtime verifier succeeded. The candidate rollout
reached `SUCCESSFUL` at 10:42:41.870 UTC; the old bridge task stopped at
10:48:50 UTC before owner-secret IAM access was denied at 10:49:38 UTC. Public
readiness/health and release identity passed after that change. Website version
33 was published successfully at 10:50:20.306833 UTC. Live Cognito user sessions
and a live customer capture/upload flow were **NOT EXERCISED** because no user
bearer tokens were available. The runtime verifier ran before IAM cutover, during
old-task drain; subsequent IAM/readiness evidence is recorded separately in
[the release receipt](admin-deployment-2026-09-24/RELEASE.md).

The final routing patch (CodeBuild 84) rejects section names inherited from
JavaScript's object prototype. Required API CI and its read-only verifier passed;
the verifier ran before traffic shift and after the owner-secret IAM deny.
Public checks at 11:18:14 UTC, during the 100% traffic bake, confirmed the exact
source/image, readiness, health, unauthenticated denial, and custom-origin CORS.
The final IAM snapshot at 11:22:06 UTC independently reconfirmed runtime-secret
allowance and explicit owner-secret denial. At that observation, the previous
restricted-runtime task was still `DEACTIVATING` in its normal 300-second drain,
and legacy `DescribeServices` still showed `PRIMARY/IN_PROGRESS`; native rollout
was already complete. That task has no owner authority. Website v33 remains live
unchanged.

## Existing deployment and recorded baseline

The following resource names were corroborated by the September 24 read-only
discovery and operator task receipts. Revalidate the current service state before
every subsequent change; the September 15 receipts remain historical context.

| Resource | Recorded value |
| --- | --- |
| Account / region | `784514617543` / `us-east-1` |
| ECS cluster / service | `packproof-v2-staging-cluster` / `packproof-v2-staging-api` |
| CodeBuild project / ECR repository | `packproof-v2-staging-api` |
| Source bucket | `packproof-v2-staging-build-784514617543` |
| RDS instance | `packproof-v2-staging-db` |

The historical staging name does not imply isolation from real customers.
Follow `docs/intake-deployment-2026-09-15/OPERATIONS.md` for the existing image-only
Express canary path. **Do not invoke `infra/deploy.ps1` or its legacy deployment
workflow for this release.** They also modify infrastructure and shared image
tags. Do not assume that pushing a branch deploys this backend.

Read-only operator discovery, using an already authenticated AWS CLI:

```bash
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}'
aws ecs describe-services --region us-east-1 \
  --cluster packproof-v2-staging-cluster --services packproof-v2-staging-api \
  --query 'services[].{serviceArn:serviceArn,taskDefinition:taskDefinition,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount}'
aws codebuild batch-get-projects --region us-east-1 --names packproof-v2-staging-api \
  --query 'projects[].{name:name,sourceType:source.type,sourceLocation:source.location}'
aws rds describe-db-instances --region us-east-1 --db-instance-identifier packproof-v2-staging-db \
  --query 'DBInstances[].{status:DBInstanceStatus,latestRestorableTime:LatestRestorableTime,backupRetentionDays:BackupRetentionPeriod}'
```

Inspect the discovered service's Express active configuration and running task
definition through the authenticated operator path. Retain a protected baseline
of full configuration for comparison; report only nonsecret identity, setting
names, equality results, and image digests. Never print database passwords,
provider credentials, bearer tokens, or presigned upload URLs.

## Release gates and order

1. Freeze the candidate commit and pass its backend, web, authorization, migration,
   and PostgreSQL privilege checks. Preserve current production frontend changes;
   the Sites checkout and GitHub checkout have different release histories.
2. Confirm the live source SHA, image digest, task definition, exact migration
   inventory/checksums, database roles, runtime login, and current recovery point.
   Stop if this baseline differs from the assumptions of the reviewed runner.
3. Build a **compatibility bridge from the observed running backend**. Its sole
   schema change must allow the exact five future ledger IDs/checksums below while
   still validating all existing migrations. It must run before and after those
   migrations without requiring their tables. Test both states and rejection of
   unknown IDs or altered hashes. The current `assertSchemaCurrent` rejects
   future ledger IDs, so deploying the new schema first can break old-runtime
   startup/readiness and leaves an invalid rollback target.
4. Build bridge and candidate with the existing CodeBuild project. Package each
   backend at its committed revision into a unique commit-scoped source object;
   override the build source and buildspec to use a unique image tag and avoid
   updating `latest`. Record source ZIP hash, build ID, commit, and immutable ECR
   digest. The existing default `backend/buildspec.yml` pushes `latest`, so it is
   not the scoped buildspec for this procedure.
5. Deploy the bridge with an image-only Express update. Re-read the service
   immediately before mutation and require the expected predecessor. Clone and
   preserve the complete container settings, environment, secret references,
   roles, network, CPU, memory, scaling, health, canary, and rollback settings;
   change only image and release identity. Require completed rollout, exact
   running digest/source, expected healthy task count, `/meta`, and `/ready`.
6. Use `infra/admin-dashboard-migration.mjs` in a reviewed one-shot task with
   separate owner authority and the pinned candidate image. Its inspect/apply
   discipline allows exactly **069–073**; the earlier
   `infra/mobile-intake-migration.mjs` only allows 067/068. Require current RDS
   recovery evidence, exact executed-byte receipts, bounded execution, cleanup,
   and unchanged TLS/durability settings. Keep `PACKPROOF_MIGRATE_ON_START=false`.
   Do not start the application process in the migration task.
7. Apply and verify the runtime privilege boundary below before admitting the
   new API. If separate runtime credentials are not already in use, prepare,
   test, and review that credential cutover explicitly; do not hide it in an
   image-only deployment or claim it happened by applying a grant script.
8. Verify bridge readiness after migration. Deploy the candidate with the same
   preservation/comparison checks. Preserve existing provider/admission flags;
   the new registration and capture pause flags default to false. Require
   readiness, source/digest identity, CORS, runtime privilege/internal authorization
   guard checks, and worker observations. Record real user-session and customer
   capture/upload coverage separately; without user bearer tokens, mark those
   live flows **NOT EXERCISED**, without claiming a pass or adding a deployment
   blocker after the required internal checks pass.
9. Bootstrap the administrator using the verified identity procedure below.
   Verify source-backed admin reads and internal authorization guards through the
   deployed runtime. Exercise authenticated navigation when an authorized user
   session is available, recording the actual coverage.
   Publishing frontend code alone does not complete this release.

The reviewed operator bundle contains `admin-dashboard-migration.mjs`,
`admin-runtime-credentials.mjs`, and `runtime-roles.sql`. The short command from
`infra/admin-operator-launch.mjs` downloads only the commit-scoped bundle in the
existing build bucket, verifies its compressed SHA-256 and all file hashes,
extracts private temporary files, calls the selected operator entry, and removes
the files. It never starts the API. Preserve the source, bundle, schema, and SQL
pins in the release receipt. Keep signed URLs and injected credential values in
protected operator records, and check the complete ECS override size before use.
On a failure, inspect the phase and transaction-acknowledgement receipt before
considering another operation; do not retry or reset a database password blindly.

### Pinned migration bytes

These hashes were confirmed by the successful September 24 migration task with
`EXECUTED_BYTES` provenance for all five entries. For any future candidate,
regenerate with `sha256sum backend/migrations/069_system_admin.sql
backend/migrations/070_public_analytics.sql backend/migrations/071_admin_error_triage.sql
backend/migrations/072_admin_read_indexes.sql backend/migrations/073_client_version_activity.sql` and review **all five** hashes in the
bridge, runner, candidate, and release receipt. Do not loosen checksum validation.

| Migration ID | SHA-256 |
| --- | --- |
| `069_system_admin` | `95f2eb6a14f703fc1a7d6a69c4c651147c1590424a3978c8256e95bbc9f32cd3` |
| `070_public_analytics` | `56f2d727ae90a9b19163f43e5b43c1f1973deb0fd0ec96262273dd9094a4c5d8` |
| `071_admin_error_triage` | `57f74e7ade72ed5f57239d93ae06f6c0b3e1c33984ee8334843f9e558d96a247` |
| `072_admin_read_indexes` | `43052f95d34060f14bdfd67b9756c6542d3279ac4a5a21f8480b3bd1ed5e01f1` |
| `073_client_version_activity` | `6a1815b36939790632a73e8650e49b2fc9733e798fc75a620406f751bf75573a` |

## Database authority gate

The September 24 baseline still used owner login `packproof` and had no separate
runtime role. The successful credential operator then created
`packproof_app_runtime_v1` and verified a fresh connection with that identity,
TLS 1.3, the expected effective privileges, and ten denied authority probes.
Candidate service cutover and its verification are separate from credential
preparation. Both have release evidence; the verifier's scope and timing are in
the release receipt. A schema owner can bypass table
ACLs and alter guards; revoking privileges from a different group cannot constrain
that owner.

Verify the actual application connection's `current_user` and `session_user`,
table ownership, role attributes, inherited memberships, and ability to assume
owner roles. Use the established operator process to maintain distinct migration
owner and application credentials. The application must not own tables, have
elevated role attributes, inherit owner authority, or be able to assume it.
Preserve existing recovery/publisher role separation.

The reviewed privilege window applies `infra/sql/runtime-roles.sql` through
`infra/admin-runtime-credentials.mjs` as the database owner after all five
migrations. Its successful setup receipt covers a fresh runtime connection,
163 tables, 285 column checks, and six sequences. Also test through the **deployed runtime
login**, including any inherited grants, that:

- `user_system_roles` allows SELECT and denies INSERT/UPDATE/DELETE/TRUNCATE.
- Admin audit, command receipts, and allowance adjustments allow required append
  operations and deny UPDATE/DELETE/TRUNCATE.
- Schema/trigger alteration and role assignment are unavailable to runtime.
- Existing account, capture, billing, worker, and evidence contracts retain their
  recorded source/unit/integration coverage; distinguish that evidence from any
  live customer flow actually exercised.

Keep credentials in existing managed-secret/operator channels. Do not place
operator credentials in the regular API task, frontend, repository, or workflow
logs. Verify the role boundary again after the credential/configuration cutover.

## Initial administrator

After candidate deployment, the designated administrator signs in normally with a
verified Cognito ID token so the backend records its verified contact. Discover
the identity read-only through an operator database connection. Substitute the
verified address from the protected operator record; do not commit identity values:

```sql
BEGIN READ ONLY;
SELECT u.id AS user_id, u.status, a.provider_subject AS cognito_subject,
       a.can_authenticate, c.email_normalized, c.source, c.verified_at
FROM users u
JOIN auth_identities a ON a.user_id = u.id AND a.provider = 'cognito'
JOIN user_verified_contacts c ON c.user_id = u.id
WHERE c.email_normalized = 'VERIFIED_ADMIN_EMAIL_FROM_OPERATOR_RECORD' AND c.source = 'COGNITO';
SELECT user_id, role, granted_at FROM user_system_roles;
ROLLBACK;
```

Require one unambiguous active, authenticating identity; corroborate its subject
and verified email against the configured Cognito user pool. An email lookup is
discovery, not sufficient authority to transfer or create an identity. If missing
or ambiguous, resolve normal sign-in/identity state without editing verification
records, resetting credentials, or bypassing MFA.

In a separate operator environment, supply the verified values via
`PACKPROOF_ADMIN_BOOTSTRAP_USER_ID`, `PACKPROOF_ADMIN_BOOTSTRAP_COGNITO_SUB`,
`PACKPROOF_ADMIN_BOOTSTRAP_REASON`, and
`PACKPROOF_ADMIN_BOOTSTRAP_DATABASE_URL`. Ensure an inherited
`PACKPROOF_DB_SECRET_ARN` cannot replace this separate connection's credentials.
Run the committed `npm --prefix backend run admin:bootstrap:prod` from the
repository root, or `npm run admin:bootstrap:prod` inside `/app` of the pinned
candidate operator task. Retain the bounded bootstrap/audit receipt.

The committed bootstrap implementation grants the role and appends its audit
event in one transaction. A successful task receipt with `alreadyAssigned: false`
therefore records both the new assignment and the committed audit operation; an
extra audit-row query is not a new deployment gate.

With an available authorized Cognito session, check that an admin receives
`isAdmin: true` from `/me/capabilities`, normal users receive `isAdmin: false`,
admin routes reject normal users, and role removal takes effect on the next
request. Without user bearer tokens, record these HTTP-session checks as
**NOT EXERCISED**, separately from the required deployed-runtime internal guards
and existing authorization test evidence. Preserve the recorded test coverage
for recent authentication, confirmation, idempotency, version conflicts, and
audit behavior; do not represent it as a live customer action. Do not change
customer balances or disable customers merely to test deployment.

## Rollback and completion evidence

For the follow-up routing patch, the preferred rollback is the already deployed
API source `8cd278ba457de1961e722dee54d7e84b162c2962`, image
`sha256:e64749d8f5179befc45c4d96371f795a9a753bb9db28c13f592f0e364be10beb`
(recorded task-definition revision 34). Preserve its non-owner runtime
credentials, owner-secret IAM deny, and all other current configuration. Do not
make a credential or privilege change as part of that image rollback.

For a wider backend rollback, use the verified compatibility bridge image, preserving all additive
schema, audit, Proofs, and evidence. After the runtime credential cutover, clone
the current service configuration and change only the image and corresponding
release identity to the bridge. Retain the new runtime login/secret references,
database grants, and credential-access restrictions. Do not restore the old
bridge task definition verbatim: its original configuration used the owner
credentials. Verify the bridge's readiness through the retained runtime identity
before calling rollback complete. Reverting the credential boundary is a
separate security-sensitive change, not an implicit part of image rollback.
The pre-bridge image is not a valid post-migration fallback. Never delete
migration receipts to make an old binary start.

Completion requires candidate/bridge commits and digests, CodeBuild receipts,
pre-migration recovery timestamp, runner/checksum receipt, migration task exit and
cleanup, runtime privilege and internal guard verification, preservation
comparison, completed service rollout, public readiness/source checks, atomic
bootstrap/audit evidence, and frontend publication. Missing required evidence
remains **pending**, not successful. Real Cognito sessions and live customer
capture/upload flows without available user bearer tokens are **NOT EXERCISED**;
that coverage limitation is not an additional deployment blocker after the
required gates pass.
