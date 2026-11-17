# Hosted membership preflight

The `reconstruction-v9` image adds four release modules to the immutable migration-122 application image at source `93274b085113dee70ee4fe7516b384cacfcd385e`, digest `sha256:cbccc2bca3c0efabd6fa957e48a95e4ee66009267914d342a073871e21dbf56b`. The archive verifier compares all inherited application, migration and probe files against that commit. The build checks the base image’s revision label, the complete 121-row migration inventory and the compiled policy bundle.

1. Run `backend-source-archive.py <source-sha> <zip> reconstruction-v9` and repeat with `--verify` from a checkout containing the base commit. Pass the same profile and source to `connect-runtime-release-runner.mjs build-request`.
2. Use `packproof.connect-runtime-review/v9` with a bound `packproof.reconstruction-release-review/v9`. Set `platformLockPolicySha256` to `cc1ff79558beac7c7178ccaecdb9c2138e7271077c8df15ff7950a73e6baf743`. Pin the candidate’s new image digest, each serving predecessor, the actual endpoint, role names and cluster, and the image’s compiled automation policy. All release feature flags remain off during admission.
3. After the separately controlled schema transition, use the existing release runner to obtain the API and worker’s individual v9 receipts and both predecessor reader receipts. Each candidate logs in using its own existing credentials over TLS. It checks the complete schema and Records/M2 privileges, membership identity protection from migration 092, and the effective role privileges below. Each predecessor independently tests its startup guard against the migrated database.
4. Validate the candidate pair using `node infra/backend-release/hosted-backfill-automation-pair.mjs review.json api.json worker.json`. The deployment planner additionally requires both historical-reader receipts, four distinct task identities, current ECS topology and default-off flags.

| Object | Required hosted evidence per caller |
| --- | --- |
| Membership | Table SELECT and nondelegable UPDATE confined to `revoked_at`. The effective role has no table UPDATE. The enabled immediate invoker trigger rejects membership ID changes. |
| Membership row lock | PostgreSQL authorizes a real `EXPLAIN (ANALYZE FALSE) SELECT … WHERE false FOR SHARE` using the current login in a read-only transaction. The plan contains only LockRows over a constant-false Result. It scans and locks zero customer rows. |
| Proof | The role has the previously required nondelegable UPDATE on `proofs.id`. |

The published v8 profile still requires UPDATE on both ID columns. Hosted v9 uses the observed legacy membership authorization. This preflight applies zero role grants. Source-owner approval and installed/pilot acceptance remain separate release decisions.
