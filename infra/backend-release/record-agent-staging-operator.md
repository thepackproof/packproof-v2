# Isolated Windows Connect108 preparation

This additive operator accepts only the checksum-pinned106-receipt schema through107, then applies108. It does not bootstrap an empty database, upgrade a pre107 database, provision roles, change passwords, activate organizations, or deploy a service. Historical095→107 operators and manifests remain frozen. The production-serving RDS hostname containing `packproof-v2-staging-db` is explicitly denied.

Run the operator from the immutable reviewed candidate image in ECS; actual task metadata must match the candidate image and reviewed cluster. Supply owner credentials only through launch-time secret injection; never put them in source, task command arguments, receipts or this file. The operator needs a distinct approved staging target and distinct restored rehearsal database, both with the exact106-receipt predecessor and existing separate, non-owner API and worker roles. Source and image values below must come from actual reviewed build provenance. Previous-image qualification is an independent task on the restored database after108; an unbridged previous image may reject the additional ledger entry and must not be treated as a rollback image.

Set `PACKPROOF_AGENT_REVIEW_JSON` to the reviewed JSON object with this exact contract:

```json
{
  "schema": "packproof.record-agent-staging-review/v1",
  "environment": "staging",
  "approvedNonproduction": true,
  "source": "<full reviewed candidate commit>",
  "previousSource": "<full reviewed previous-image source commit>",
  "candidateImage": "sha256:<immutable candidate image digest>",
  "previousImage": "sha256:<independently qualified previous image digest>",
  "clusterArn": "arn:aws:ecs:us-east-1:784514617543:cluster/<reviewed isolated cluster>",
  "inventorySha256": "ac0f0b11921f57e6dffeba0561c3e8e0991e63f9b6eaa1870ce5c7246d5a5921",
  "predecessorInventorySha256": "605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1",
  "target": {"host": "<approved distinct RDS endpoint>", "database": "<approved database>"},
  "restored": {"host": "<distinct restored RDS endpoint>", "database": "<restored database>"},
  "ownerRole": "<existing owner login>",
  "apiRole": "<existing API login>",
  "workerRole": "<existing worker login>"
}
```

`PACKPROOF_AGENT_REVIEW_SHA256` is SHA256 of `JSON.stringify(review)` (the parsed object's original key order). Also set `PACKPROOF_RELEASE_SHA`, `PACKPROOF_AGENT_CANDIDATE_IMAGE_DIGEST`, `PACKPROOF_OPERATOR_PURPOSE=record-agent-isolated-staging-preparation`, `PACKPROOF_ENVIRONMENT=staging`, `PACKPROOF_MIGRATE_ON_START=false`, `PACKPROOF_ORGANIZATIONS_ENABLED=false`, `PACKPROOF_CLAIM_EXPORTS_ENABLED=false`, exact `PACKPROOF_DB_HOST/NAME/USER`, `PACKPROOF_DB_PORT=5432`, `PACKPROOF_DB_SSLMODE=verify-full` and the verified RDS public CA bundle. `DATABASE_URL`, `PACKPROOF_DB_SECRET_ARN` and all `PG*` overrides are rejected for the owner task; inject `PACKPROOF_DB_PASSWORD` directly from the reviewed owner secret reference at launch.

Execute in this order:

1. Against the restored endpoint, run `node scripts/record-agent-migrate-cli.mjs --rehearse`. This commits only108 on the restored database and emits a sealed preservation report. Retain actual ECS task ARN and immutable-image metadata.
2. Independently run the reviewed `record-agent-previous-image-probe.mjs` inside the reviewed previous image against that same restored endpoint (API role, matching previous release identity, inactive flags, verified TLS and read-only credentials). Candidate images package it at `/release/record-agent-previous-image-probe.mjs`. For an older image without that file, generate the exact ECS container `command` JSON below from this reviewed checkout and use it in the one-shot task definition with `entryPoint: []`; it executes the same probe without modifying the previous image or downloading runtime code. A failure is a release blocker. Retain its sealed report and actual distinct ECS task ARN. Capture actual `aws ecs describe-tasks` JSON for both stopped tasks. Run `node infra/backend-release/record-agent-rehearsal-receipt.mjs review.json migration-report.json previous-image-report.json described-tasks.json`; it verifies both stopped tasks, exact images, zero exit codes, embedded reports and matching reviewed account/cluster/source/target before sealing the receipt. Pass its JSON as `PACKPROOF_AGENT_REHEARSAL_JSON`. No rehearsal receipt is fabricated by the owner operator.
3. Against the approved target, run `node scripts/record-agent-migrate-cli.mjs --inspect`. Pass the returned inspection as `PACKPROOF_AGENT_INSPECTION_JSON` and its `sha256` as `PACKPROOF_AGENT_INSPECTION_SHA256`. Within15 minutes, run `node scripts/record-agent-migrate-cli.mjs --apply`. Rehearsal evidence expires after24 hours. The migration locks historical tables, rechecks the inspection and108 source bytes, appliesDDL and receipt atomically, removes broad inherited default grants only on the new tables, and verifies historical data/catalog/ACL/runtime authority preservation.
4. Run `node scripts/record-agent-migrate-cli.mjs --plan-roles`. Review the returned statements. Set `PACKPROOF_AGENT_ROLE_PLAN_SHA256` to `statementsSha256`. Run `--rehearse-roles`; it executes and rolls back only the108 delta. Pass its returned report as `PACKPROOF_AGENT_ROLE_REHEARSAL_JSON`; run `--apply-roles` within15 minutes. No roles are created and no historical grants are rewritten.
5. Launch `node /release/record-agent-database-preflight.mjs api` and separately `... worker` under the actual distinct runtime logins, current candidate image, same review JSON/hash and exact approved target. Set `PACKPROOF_PROCESS_ROLE` appropriately, keep migration-on-start false and provide normal runtime secret references. These read-only probes require all existing M2/records grants, current exact108 catalog, non-owner separation, TLS and matching durability fence. A role-delta receipt alone does not qualify the runtime.
6. Deployment and sandbox merchant enrollment are separate reviewed actions. G1 requires an actual Windows service enrollment, portal approval, test upload, durable worker import and visible record; schema preparation alone does not satisfy G1.

All output failures redact raw database errors. No source preparation receipt proves that any hosted migration, role change, old-image probe, deployment or G1 acceptance has occurred.

Generate the previous-image probe command from the reviewed repository root:

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; const script=readFileSync("infra/backend-release/record-agent-previous-image-probe.mjs","utf8"); const command=["node","--input-type=module","-e",script]; if(Buffer.byteLength(JSON.stringify(command))>=7800)throw Error("AGENT_PROBE_COMMAND_TOO_LARGE"); console.log(JSON.stringify(command));' > previous-image-probe-command.json
```

The generated JSON contains public reviewed code only; keep secret references in the task definition's `secrets` bindings. Preserve the reviewed previous image digest, separate API task role, execution role and isolated network; remove application health checks and restart policies from this one-shot probe task. The candidate image packages the actual-login probe at `/release/record-agent-database-preflight.mjs`; the offline receipt combiner runs from the checkout and is not a container entry point.
