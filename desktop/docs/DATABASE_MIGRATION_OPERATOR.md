# Desktop capture migration operator

This is a separately reviewed one-shot operator for migration `074_desktop_capture_registration`. It does not deploy the API, change runtime credentials, grant runtime privileges, or start a server. Applying the migration requires a distinct reviewed operation after read-only inspection.

## Pinned release and inventory

| Check | Required value |
| --- | --- |
| Candidate source | `d45727b8648ade030642a011c280c10bce525591` |
| Candidate migration inventory | 75 files |
| Existing receipts through 073 | 74 receipts, including both historical 027 migrations |
| Existing inventory SHA-256 | `bdf67730e4b82223593005cfbe7c1317e04d5654175193bc9bb49bb622531d53` |
| Migration 074 SHA-256 | `3d598d733ab8aaf375fc793446b2ed732b42c2bcb9c47fc732af57c9eade692a` |
| RDS instance | `packproof-v2-staging-db` |
| Database | `packproof_v2` |
| Database owner | `packproof` |
| Region | `us-east-1` |

The endpoint and port are fixed in `infra/desktop-capture-migration.mjs`. Both the supplied source argument and the candidate container's release metadata must match the source above. Migration-on-start must be disabled. Verified database TLS is required. Unexpected migration files, missing earlier receipts, altered checksums, or a non-execution receipt for 074 fail closed.

## Transport and credentials

`infra/desktop-operator-launch.mjs` exports `buildDesktopOperatorCommand(request)`. Use its returned array as a structured ECS container command; do not interpolate it through a shell.

The request has exactly three fields:

- `url`: a signed HTTPS URL for `packproof-v2-staging-build-784514617543.s3.us-east-1.amazonaws.com/desktop/d45727b8648ade030642a011c280c10bce525591/operator-bundle.json.gz`.
- `bundleSha256`: SHA-256 of the compressed bundle bytes.
- `args`: `['--inspect', 'd45727b8648ade030642a011c280c10bce525591']` or the separately approved `--apply` equivalent.

The gzip payload is UTF-8 JSON `{ "files": [{ "name": "desktop-capture-migration.mjs", "content": "<exact reviewed source>", "sha256": "<SHA-256 of UTF-8 content>" }] }`. No other files are accepted. The transport rejects redirects, oversized content, encoded HTTP responses, invalid UTF-8, and mismatched compressed or per-file hashes. It writes one private temporary file and removes it after success or failure.

Use a dedicated one-shot operator task with explicitly injected owner `PACKPROOF_DB_USER` and `PACKPROOF_DB_PASSWORD` components plus the pinned connection coordinates and existing public CA configuration. Set `PACKPROOF_DESKTOP_MIGRATION_OPERATOR=OWNER_COMPONENTS_INJECTED`. The transport forces `loadConfig` to compose the owner URL from these injected components, suppresses inherited runtime `DATABASE_URL` and secret callbacks, and sets the dedicated `PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL` for the operator. Do not place credentials in task command arguments, JSON bundle content, source, logs, or reports. Do not copy extraneous runtime credentials into this task. No new task-role or runtime-role permission is needed by the operator.

The module can also be run directly inside the pinned candidate container with an explicitly supplied `PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL` and optional explicit `PACKPROOF_DESKTOP_MIGRATION_DB_SECRET_ARN`. It never chooses an ambient runtime credential source.

## Inspect, review, apply, verify

1. Publish only the reviewed operator bundle; retain its compressed hash. Pin the dedicated task definition and candidate image separately. Verify the complete ECS override remains below its size limit.
2. Run `--inspect`. All database work in this mode is read-only. Retain the `desktop_capture_migration_preflight` event: source, missing migration list, baseline inventory hash, catalog definition checksums, privilege-boundary hash, `inspectionSha256`, and `inspectedAt`.
3. Review inspection results before authorizing `--apply`. Provide current RDS recovery evidence for the same database. The operator does not claim to query RDS recovery metadata itself.
4. For an authorized apply, set `PACKPROOF_DESKTOP_MIGRATION_INSPECTION_SHA256` and `PACKPROOF_DESKTOP_MIGRATION_INSPECTED_AT` to the reviewed inspect result. Set `PACKPROOF_DESKTOP_MIGRATION_RECOVERY_DB_ID=packproof-v2-staging-db` and `PACKPROOF_DESKTOP_MIGRATION_RECOVERY_POINT` to the observed latest restorable time. Both observations must be no older than one hour. A changed schema or privilege boundary invalidates the inspection digest.
5. The apply path creates one random `pp_desktop_migrate_<16 hex>` login expiring after 15 minutes. It has no superuser, createdb, createrole, replication, or bypass-RLS attributes and may SET only the existing `packproof` owner role. Unexpected reverse membership fails closed. The normal repository migration CLI runs under this separate login with bounded statement/lock timeouts and checksum adoption disabled. Its output is suppressed to avoid credential leakage.
6. The child process must close before cleanup. The operator drops only its created temporary login and verifies removal. Failed or uncertain role creation, or failed cleanup, is reported for operator investigation; it never uses broad ownership reassignment or cleanup commands.
7. Success requires `desktop_capture_migration_verified`, exact executed-byte receipt 074, valid named constraints, the immutable trigger and exact function definition, `desktop_context jsonb` with no default or column ACL override, and unchanged preexisting capture columns/protections. The function must be owned by `packproof` and must not be SECURITY DEFINER. Existing `packproof_runtime` column SELECT/INSERT/UPDATE access must be inherited without changing grants. Public relation/schema/default privileges, existing function privileges, roles, memberships, RLS policies, and durability policy must match the preflight snapshot.

A migration can commit before a later verification or cleanup fails. A failed run is not evidence of rollback. Inspect the ledger and catalog again, preserve the local evidence queue, and investigate the fixed failure code before any retry. Do not reapply broad runtime-grant SQL to resolve a failed verification.

## Local validation

Run `node --test infra/tests/desktop-capture-migration.test.mjs infra/tests/desktop-operator-launch.test.mjs` with the existing backend dependencies installed. These tests verify pinned file inventories, role/credential boundaries, target/TLS preservation, current recovery and inspection evidence, child-process cleanup, bounded hash-pinned transport, and the actual 074 catalog/immutability behavior using the existing PGlite PostgreSQL engine. They do not claim an RDS migration, deployment, or real operator credential test has occurred.
