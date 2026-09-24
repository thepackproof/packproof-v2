# Admin dashboard deployment

Status on 2026-09-24: implementation is prepared; **live AWS state, migrations,
runtime privileges, and administrator assignment have not been verified**. The
read-only AWS inventory did not return. This document is a release procedure,
not evidence that a deployment or bootstrap succeeded.

## Existing deployment and recorded baseline

The following names come from infrastructure code and the **September 15**
receipts in `docs/intake-deployment-2026-09-15/`. Revalidate them before use.

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
6. Use a reviewed one-shot migration task with separate owner authority and the
   pinned candidate image. Adapt and test the existing controlled runner's
   inspect/apply discipline for **069–073**; `infra/mobile-intake-migration.mjs`
   only allows 067/068 and cannot be reused unchanged. Require current RDS
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
   readiness, source/digest identity, CORS, normal authentication, existing
   capture/upload recovery, worker health, and ordinary-user denial of `/admin`.
9. Bootstrap the administrator using the verified identity procedure below.
   Then verify capability-based navigation and live, source-backed admin data.
   Publishing frontend code alone does not complete this release.

### Pinned migration bytes

These hashes describe the candidate files when this runbook was written. After
final code changes, regenerate with `sha256sum backend/migrations/069_system_admin.sql
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

September 15 observations recorded the application using owner login `packproof`,
with CREATEROLE and membership in `rds_superuser`, and no separate runtime login.
Those observations are not current-state proof. A schema owner can bypass table
ACLs and alter guards; revoking privileges from a different group cannot constrain
that owner.

Verify the actual application connection's `current_user` and `session_user`,
table ownership, role attributes, inherited memberships, and ability to assume
owner roles. Use the established operator process to maintain distinct migration
owner and application credentials. The application must not own tables, have
elevated role attributes, inherit owner authority, or be able to assume it.
Preserve existing recovery/publisher role separation.

In the reviewed privilege window, apply `infra/sql/runtime-roles.sql` as the
database owner after all five migrations. Then test through the **actual runtime
login**, including any inherited grants, that:

- `user_system_roles` allows SELECT and denies INSERT/UPDATE/DELETE/TRUNCATE.
- Admin audit, command receipts, and allowance adjustments allow required append
  operations and deny UPDATE/DELETE/TRUNCATE.
- Schema/trigger alteration and role assignment are unavailable to runtime.
- Existing account, capture, billing, worker, and evidence operations still work.

Keep credentials in existing managed-secret/operator channels. Do not place
operator credentials in the regular API task, frontend, repository, or workflow
logs. Verify the role boundary again after the credential/configuration cutover.

## Initial administrator

After candidate deployment, `admin@thepackproof.com` signs in normally with a
verified Cognito ID token so the backend records its verified contact. Discover
the identity read-only through an operator database connection:

```sql
BEGIN READ ONLY;
SELECT u.id AS user_id, u.status, a.provider_subject AS cognito_subject,
       a.can_authenticate, c.email_normalized, c.source, c.verified_at
FROM users u
JOIN auth_identities a ON a.user_id = u.id AND a.provider = 'cognito'
JOIN user_verified_contacts c ON c.user_id = u.id
WHERE c.email_normalized = 'admin@thepackproof.com' AND c.source = 'COGNITO';
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

Verify an authenticated admin receives `isAdmin: true` from `/me/capabilities`,
normal users receive `isAdmin: false`, all admin routes reject normal users, and
role removal takes effect on the next request. Check recent-authentication,
confirmation, idempotency, version conflicts, and audit behavior using the
release tests and an approved reversible production smoke action. Do not change
customer balances or disable customers merely to test deployment.

## Rollback and completion evidence

Rollback uses the verified compatibility bridge, preserving all additive schema,
audit, Proofs, evidence, credentials, and configuration. The pre-bridge image is
not a valid post-migration fallback. Preserve or deliberately reverse any
separately reviewed credential cutover; never delete migration receipts to make
an old binary start.

Completion requires candidate/bridge commits and digests, CodeBuild receipts,
pre-migration recovery timestamp, runner/checksum receipt, migration task exit and
cleanup, runtime privilege verification, preservation comparison, completed
service rollout, public readiness/source checks, bootstrap audit, and authenticated
admin/ordinary-user checks. Missing evidence remains **pending**, not successful.
