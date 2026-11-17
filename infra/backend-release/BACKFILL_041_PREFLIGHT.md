# Historical backfill with Connect 0.4.1

The `reconstruction-v8` profile admits new historical job proposals from the existing 0.4.0 and 0.4.1 collectors. Migration 122 changes the installation-version predicate in the database trigger that validates historical job creation. An approved manifest, source and credential binding, whole-file decision, receipt restrictions and expiry still apply to collection and replay. A queued job created under migration 121 can complete after upgrade with the same source grant.

| Reviewed item | Value |
| --- | --- |
| Migration | `122_backfill_collector_041` |
| Migration SHA-256 | `11eb66a36bd4378c8df71fc57d5c146eb90c83f1945a19b1e48c9ac10e5eef5f` |
| Complete 121-row migration inventory | `ea1b7bd281d155919935362bd904a7cce80711c267c64090be84023d6dbbc804` |
| Records-privilege migration inventory | `11b3a0e163438a2ea9f8122f76857866154be6b901b4abbcec4cf780d0625f38` |

1. Select `reconstruction-v8` for the exact-commit archive and build request. Create and independently verify the archive with `backend-source-archive.py <source-sha> <zip> reconstruction-v8` and the same command with `--verify`.
2. Use `packproof.connect-runtime-review/v8` and a bound `packproof.reconstruction-release-review/v8` for the reviewed source, image, host, runtime logins and cluster. Retain the shipment policy bundle measured by the image. Set `backfillJobsEnabled`, shipment interpretation and header variants to false for image delivery. Stage the exact schema under the migration role using the independently reviewed migration procedure.
3. Register and run both candidate probes and both predecessor readers with the existing connect runtime release runner. Each candidate uses `PACKPROOF_RECONSTRUCTION_V8_REVIEW_JSON` and its exact SHA-256 binding. Each predecessor runs its own startup schema guard against the complete 122 catalog. Older images require a separately qualified compatible bridge before cutover.
4. To verify the candidate role receipts offline, run `node infra/backend-release/backfill-automation-pair.mjs review.json api.json worker.json`. Deployment planning also requires the two predecessor reader receipts, distinct task identities and a still-current review. Collection enablement and installed Windows acceptance are separate release decisions.

The focused regression starts with a migration-121 database and an approved 0.4.0 job. It applies 122, upgrades the same installation, processes that original, replays new proposals for both exact versions and checks the database rejection for 0.4.2. PostgreSQL role tests exercise API append and worker read authority over historical jobs, decisions and receipts.
