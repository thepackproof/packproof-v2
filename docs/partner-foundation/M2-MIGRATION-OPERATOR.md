# M2 inactive-schema migration operator

Status: implemented operator and focused transaction tests. No production execution,
rollback-image acceptance, runtime-role activation or M2 release is implied.

`backend/scripts/m2-migrate.mjs` is the exact 093-095 migration boundary. The
previous foundation operator still accepts only its historical 088-092 release.
The new operator accepts 91 unchanged baseline receipts or the complete 94-receipt
inventory. It rejects partial application, changed SQL, unknown future migrations,
missing baseline receipts and expired or changed inspection state.

The baseline inventory SHA-256 is
`4c8fdf8c9a1c08b22c1b13ddd54dc34c7e51cdd3a1dc238edb5485a7a970556e`.
All three migration byte digests are pinned in the operator and independently in
the existing M2 runtime privilege policy.

## Required release evidence

Before using the production CLI, establish a compatible immutable rollback image
against the exact migrated schema while organizations and claim exports remain
inactive. Keep its source, image digest, actual runtime/configuration, historical
verification, canary result and rollback limits in a reviewed evidence document.
Set `PACKPROOF_COMPATIBILITY_EVIDENCE_SHA256` to that document's SHA-256.
The operator binds that reference; it does not manufacture or independently
authenticate deployment evidence from a supplied digest.

The old foundation bridge is not an accepted 093-095 rollback image. Migration 094
adds an integration-account immutability guard; 095 strengthens the existing
recipient-job guard. Do not describe these as new tables only. Existing terminal
exports remain readable, but attempts to change their terminal state are rejected.
Backward behavior must be tested on the actual bridge before production apply.

The database must have no organization rows, no queued/rendering recipient jobs,
and no records or runtime grants in the new M2 tables. The production deployment
must keep organizations and claim exports disabled. The CLI requires both flags
explicitly false. It cannot independently prove all deployed task configuration;
that is part of the release evidence.

## Inspect, then apply

Use the pinned operator image and its existing owner-secret injection boundary.
Never fetch an owner secret into the operator's caller or print a connection string.
The CLI accepts only the established production RDS hostname, `packproof_v2`,
verified TLS, owner `packproof`, and historical runtime `packproof_app_runtime_v1`.
An alternate runtime/target needs a separately reviewed operator change.

Required non-secret bindings are:

| Variable | Required value |
| --- | --- |
| `PACKPROOF_OPERATOR_PURPOSE` | `m2-inactive-production-migration` |
| `PACKPROOF_ENVIRONMENT` | `production` |
| `PACKPROOF_MIGRATE_ON_START` | `false` |
| `PACKPROOF_ORGANIZATIONS_ENABLED` | `false` |
| `PACKPROOF_CLAIM_EXPORTS_ENABLED` | `false` |
| `PACKPROOF_RELEASE_SHA` | Exact operator source commit |
| `PACKPROOF_COMPATIBILITY_IMAGE_DIGEST` | Accepted rollback image `sha256:...` |
| `PACKPROOF_COMPATIBILITY_EVIDENCE_SHA256` | Reviewed bridge evidence digest |

Run `node scripts/m2-migrate-cli.mjs --inspect`. The read-only transaction returns
an inspection containing migration digests, frozen-record counts/digests and an
effective runtime-authority digest. It includes existing table and column rights,
grant options, memberships and schema rights, including inherited authority.

Bind the exact result as `PACKPROOF_M2_INSPECTION_JSON` and its digest as
`PACKPROOF_M2_INSPECTION_SHA256`. Run `node scripts/m2-migrate-cli.mjs --apply`
within 15 minutes. Any relevant intervening state change requires a new inspection.
The CLI creates an expiring, connection-limited login with explicit owner-role
assumption, verifies its separate session and TLS, and removes it in `finally`.
A cleanup failure is emitted as a failure, including the temporary login name but
no credential. Inspect and close that login before proceeding if cleanup fails.

## Transaction and preservation boundaries

The owner transaction takes the migration advisory lock and bounded table locks,
then repeats inspection. All three SQL migrations, their execution receipts and
new-table privilege cleanup commit together. A failure rolls back the complete
change, including replacement of the existing recipient-job trigger function.

Default table grants can otherwise grant new tables to an old broad runtime
group. The operator removes non-owner direct grants only on the six newly created
tables and checks that no non-owner table or column grants remain. It does not
modify existing table privileges, role memberships or default privilege policies.
Provisioning the separate API/worker runtime remains a different activation step.

Before and after digests cover all rows of final manifests, original evidence,
commerce stages and stage evidence, supplements, signature snapshots/cases/case
approvals, recipient jobs and recipient approvals. Manifest canonical bytes must
match their recorded hashes. The operator neither reads S3 objects nor verifies
external signing trust; exact object-version and cryptographic verification remain
separate release gates. Historical data is not rewritten or backfilled.

The completed-schema inspection also checks enabled immutability triggers, the
exact replacement recipient-job function body and validated association guards.
Reapplying is an idempotent no-op only while the schema stays inactive and those
guards remain present. Activation or drift causes refusal.

## Focused verification

`tests/m2-migrate.test.ts` exercises strict inventory/receipt binding, disabled
feature requirements, in-flight work rejection, intervening authority drift,
injected DDL failure rollback, exact historical preservation, inherited default
grant removal, existing-grant preservation, terminal-export immutability,
idempotent reapply and damaged guard/activation rejection. The partner foundation
workflow runs it on PostgreSQL 16; the local fallback uses PGlite.

This does not replace the combined actual-role RDS/S3 restore, device acceptance,
consenting merchant pilot, or deployment/rollback measurements.
