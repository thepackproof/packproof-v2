# Connect API and worker image release

This operator prepares requests for the existing account `784514617543` in `us-east-1`. It performs no AWS calls. The API named `packproof-v2-staging-api` serves production; its name does not qualify an independent staging environment. Current source requires the separate worker to support the same CSV v2 rules before the API advertises them. Existing migration operators and the retired 77-receipt release runner remain unchanged.

Application source and operator source may be different reviewed commits. The application archive must come entirely from its selected Git commit. For the November 16 candidate, that application commit is `debf53231d6f3ce8990afa74fbc47defac4f4ecb`. This document is not a deployment receipt.

## Private inputs

Use absolute private scratch paths. Preserve complete task definitions and Express primary-container configuration privately; do not print their environment values. These are observed inputs, not defaults:

- `snapshot`: `observedAt`, `account`, `region`, `topology`, `api: {service, express, taskDefinition, meta, nativeDeploymentStatus}`, `worker: {service, taskDefinition}`, and `probe: {clusterArn, networkConfiguration, capacityProviderStrategy?, platformVersion?}`. Describe the actual current ECS worker service; CloudFormation outputs may name an obsolete task revision. Keep the initializer container, ephemeral volumes, mounts, commands, dependencies, users and secret references.
- `review`: `schema: packproof.connect-runtime-review/v1`, application `sourceSha`, immutable repository-qualified `image`, `version`, expiry within two hours, `topologySha256`, `configurationLeaseSha256`, `expectedApi: {sourceSha,image,taskDefinition}`, `expectedWorker: {sourceSha,image,taskDefinition,serviceArn,clusterArn}`, actual separate `apiRole` and `workerRole`, `database: {host,name}`, actual `environment`, `probeClusterArn`, `probeNetworkSha256: connectReleaseHash(snapshot.probe)`, `ciPassed`, `sourceArchiveVerified`, `sourceArchiveSha256`, and `inventorySha256`.
- `configurationLeaseSha256` is `connectConfigurationLease(snapshot)`; `topologySha256` is `connectReleaseHash(snapshot.topology)`. Review the exact observed topology before pinning it. Observations and runtime-probe results expire after 15 minutes. Do not refresh their timestamps without repeating their reads.
- `probes.api` and `probes.worker`: `report` from the actual candidate task's `connect_runtime_probe` log, `registered` from its actual RegisterTaskDefinition/DescribeTaskDefinition response, and `task` from actual ECS DescribeTasks. The registered definition must exactly match the generated probe, including its roles, secret references and command; the stopped task must name that exact definition ARN. Each task must stop with exit zero; every owned container must have the candidate digest. Actual database login, TLS, existing records/M2 privileges, durability configuration and all 108 ledger receipts are verified read-only. These probes do not start the application or establish hosted merchant or browser acceptance.

The exact source and applied migration inventory is 108 receipts with SHA-256 `a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d`. No migration, credentials, roles, queue state, originals, feature flags, service endpoint or database binding is changed.

## Source build and qualification

1. Generate and independently verify the selected application's root-layout archive:

   ```sh
   python infra/backend-release/backend-source-archive.py APPLICATION_SHA PRIVATE_ARCHIVE.zip zero-touch-v1
   python infra/backend-release/backend-source-archive.py APPLICATION_SHA PRIVATE_ARCHIVE.zip zero-touch-v1 --verify
   ```

   Upload the verified bytes to the returned content-addressed source key with `IfNoneMatch: *`; confirm the S3 checksum and size, and include its actual version if enabled. The build re-fetches and hashes the bytes even when the existing bucket is unversioned. A source collision is reviewed rather than overwritten. Current API and worker rollback digests must remain retained after one candidate push.

2. Create build input `{sourceSha, archiveSha256, sourceVersion?, predecessorImages:[API_IMAGE,WORKER_IMAGE]}` and run:

   ```sh
   node infra/backend-release/connect-runtime-release-runner.mjs build-request PRIVATE_BUILD_INPUT.json PRIVATE_BUILD_REQUEST.json
   ```

   Execute that request through the connected AWS app, then observe the existing CodeBuild job to terminal success. Verify its logged application source/archive/inventory receipt and ECR immutable digest. The existing CodeBuild project, IAM roles and retention policy are not modified. Failed builds do not promote anything.

3. Obtain a fresh private snapshot and completed review. Input `{snapshot,review}` generates two candidate probe task registrations:

   ```sh
   node infra/backend-release/connect-runtime-release-runner.mjs register-probes PRIVATE_REVIEW.json PRIVATE_PROBE_REGISTRATIONS.json
   ```

   Register the definitions through AWS. For each kind, input `{snapshot,review,kind,registered}` to phase `run-probe`; the returned RunTask request uses the explicit reviewed probe cluster/network and the existing runtime's separate credentials. Observe both actual stopped tasks and their redacted reports. Deregister only these temporary probe task definitions after recording their results.

## Promotion order

1. Input `{snapshot,review,probes}` to phase `plan`. It writes a private source-bound plan. Phase `worker-register` accepts `{plan}` and emits RegisterTaskDefinition for the existing worker family. Only both owned image references and the main container's three release-identity fields change.
2. Read the current worker again. Input `{plan,registered,observation}` to `worker-update`, where observation contains its fresh `observedAt`, `service`, and `taskDefinition`. Execute the generated UpdateService. Observe convergence and every running task's main-container digest; the initializer must have succeeded. Existing desired count, network, deployment policy and roles remain unchanged.
3. Read the API/Express state and topology again. Input `{plan,workerObservation,apiObservation}` to `api-update`. The worker observation additionally includes `tasks` from actual DescribeTasks. API observation includes `observedAt`, `service`, `express`, `nativeDeploymentStatus`, and `topology`. A mixed/old worker fleet, failed initializer, stale observation or API/topology drift blocks the request. Execute the generated UpdateExpressGatewayService only after it passes.
4. Observe terminal successful native API deployment, exact `/meta` source/image/version, `/health`, `/ready`, expected website CORS and unauthorized API denial. Reconcile worker job health and accepted receipts. Then publish the matching browser implementation and qualify the installed client with distinct configuration, batch and recurring approvals, first canonical Proof and a subsequent unattended export. An unauthenticated health check does not prove the authenticated v2 capability or that full journey.

Every runner phase writes a new file with mode 0600 and refuses overwrite. It prints only a phase summary. Request envelopes contain `service_name`, `operation_name`, `region_name`, and `params`, ready for `call_boto3` in the AWS app. The runner neither handles credentials nor silently executes mutations.

## Rollback

Pause affected v2 sources and reconcile/drain accepted imports while preserving originals and receipts. Inspect the current service state before changing anything; AWS may already have rolled back. The private plan retains the exact predecessor API primary container and worker task revision. Restore the API image/release identity first. Phase `rollback-worker` additionally requires a fresh observation of that exact restored primary container and read-only database evidence `{observedAt,readOnly:true,databaseInspected:true,activeV2Sources:0,pendingV2Imports:0}`. It then emits only the previous worker task-definition revision. Never remove semantic guards, reinterpret queued evidence, delete protected work, change grants or roll back schema to make a candidate appear compatible.

## Shipment automation deployment with all new capabilities disabled

Use the v7 path for a reviewed archive from `backend-source-archive.py <commit> <zip> reconstruction-v7`. Verify its Git blobs with the archive tool's `--verify` mode. Pass `"profile": "reconstruction-v7"` to `build-request` along with the existing source, archive checksum, object version when available, and both observed predecessor images. CodeBuild verifies all 120 source receipts through migration 121, loads the actual packaged preflight and measures the compiled policy bundle. Record the source/archive receipt, bundle digest, successful build ID and immutable ECR image digest.

The November 16 deployed `debf53231` binary only admits its 108-receipt schema through migration 109. Its schema readiness check rejects the extra 110–121 receipts. Turning off the product switches does not change database compatibility. Before modifying production, rehearse the exact owner-reviewed schema and role transition on an independently authorized restored copy with retained work. Check the old service's actual startup and readiness during the mixed-version window and verify a compatible recovery image for both roles. A compatible bridge can run first on the current schema, then continue on the upgraded schema. A distinct reviewed maintenance cutover with roll-forward recovery needs its own execution procedure. The image-only release runner performs neither the migration nor the maintenance cutover.

1. Obtain fresh ECS service, actual task, RDS target and configuration observations. Keep existing roles, secret bindings and topology. Use a fresh nested `preflightReview` of schema `packproof.reconstruction-release-review/v7` and outer `review.schema` of `packproof.connect-runtime-review/v7`. Both refer to the same source, immutable candidate image, cluster, API/worker roles and database. The nested review binds a distinct owner role and an expiry at or after the outer expiry within the existing time limits. Full inventory SHA-256 is `3a0d0f641856846529659e12eb7ba166f8542753b663b4d5ab903862ee905de5`. The records-only digest is `276f345802fb758d75028be0e47b6fab3179c20927317cf30a58aa044e7364de`. Record the built `bundleSha256`. Set interpretation and header variants false, shadow scopes to the digest of `[]`, and feature activation and customer qualification false. Existing feature bindings must agree.
2. On the approved migrated target, `register-probes` returns four registrations. Bind their actual registered definitions and calls to `run-probe` using the keys `api`, `worker`, `previous-api`, `previous-worker`. Both candidate tasks execute the v7 read-only preflight. The predecessor tasks retain their actual previous binaries and perform bounded reader checks against this same catalog. All four must exit successfully. Record each actual stopped ECS task, complete registration and redacted log report under its own key in `probes`. Qualification on a restored target must be repeated under the actual production logins and target before a production image update.
3. Generate `plan` with the new review and four observations. Then run the existing `worker-register`, `worker-update` and `api-update` stages as documented above. Verify every worker container and initializer before API promotion. Check public freshness, readiness and accepted-work progress after deployment. Verify browser publication separately.
4. The v7 plan omits executable legacy rollback requests. If recovery is necessary, pause the affected capability, reconcile admissions and pending work, and qualify the intended recovery images and actual roles against the current retained state. A compatible-reader receipt alone does not establish safe writer rollback. Preserve the database, originals, grants and receipts throughout.

## Multi-source release and rollback

The compatibility build and application build share an archive from one reviewed commit. The compatibility image keeps the deployed application on its existing migration inventory and extends its startup check to the exact 123 receipt. The application image contains the source readers, order API, worker and release checks for migration 123.

1. Create and verify the source archive with the `reconstruction-v10` archive profile. Run both commands against the same commit and ZIP.

   ```sh
   python3 infra/backend-release/backend-source-archive.py "$COMMIT" backend.zip reconstruction-v10
   python3 infra/backend-release/backend-source-archive.py "$COMMIT" backend.zip reconstruction-v10 --verify
   ```

2. Generate separate `build-request` files. Set `profile` to `order-workspace-bridge` in the first and `reconstruction-v10` in the second. Include the live API and worker digests in `predecessorImages`. The bridge build verifies the deployed base image digest and source label. Its image tag starts with `order-compat-`. The application image tag starts with `connect-runtime-`.
   For direct builds, set `sourceTransport` to `git-commit`. CodeBuild fetches the exact SHA from the public project repository, reconstructs its Git-blob ZIP, and checks the SHA-256 against the reviewed local archive. Supply `archiveSha256`, `sourceSha`, and the complete repository-qualified digest for each predecessor. Run `node infra/backend-release/connect-runtime-release-runner.mjs build-request input.json request.json` for each image. Include the completed bridge digest in the candidate's retention check.
   When both live roles already use `packproof.shipment-interpretation/v1`, set `preflightReview.preserveShipmentSettings` and `automationPolicy.interpretationEnabled` to `true`. The release verifies the active policy binding on both roles and the API's active configuration. Header variants and shadow sources remain disabled.
3. On the existing schema, use the v9 runtime review and paired probes to qualify the bridge for both process roles. Promote the bridge worker, then API, and verify their deployed digests before changing the schema.
4. Rehearse the pinned 123 migration, runtime grants, restore, and previous-image startup against an isolated database. Apply the reviewed migration through the separate database owner workflow. Preserve the bridge images and their environment settings.
5. Use `packproof.connect-runtime-review/v10` with a `packproof.reconstruction-release-review/v10` preflight review. Bind the 123 catalog, records privilege inventory, hosted lock policy, source, image, target and independent process roles. The image-only qualification keeps `orderWorkspaceEnabled` false. Register and run both candidate probes and both bridge-reader probes. Generate the rollout requests only once the four read-only receipts validate. Verify runtime identity and queue health before cohort activation.
6. For recovery, pause new collection and local output, retain durable jobs and published revisions, and qualify the compatibility image against the actual 123 database before restoring it on both roles. Preserve the additive tables. Resume only workflows supported by the recovered application.

## Qualify Connect 0.6.0 on migration 124

Use `reconstruction-v11` for the 0.6.0 candidate. This profile compares 123 SQL files through `124_connect_collector_version` with the frozen 122-file catalog through migration 123. Only the backfill trigger function changes. The records privilege policy stays at SHA-256 `116375351f3b52951faa169428970ea7fa7573da71509060af2c7b2ccfb5081d`.

1. Build and independently verify the archive with `python3 infra/backend-release/backend-source-archive.py <commit> <archive.zip> reconstruction-v11` and the same command with `--verify`. The existing `build-request` phase accepts `profile: "reconstruction-v11"` with the reviewed archive hash and immutable predecessor images. Record the application image digest after the build succeeds.
2. On a separately approved isolated PostgreSQL 16 target, compare the candidate source inventory and complete existing migration ledger using `inspectCollectorPredecessor` from `reconstruction-v11-release-review.mjs`. The predecessor must end at the exact migration 123. An earlier ledger needs its own approved migration and grant transition first. Rehearse the single migration in an owner-controlled transaction. The PostgreSQL regression in `backend/tests/order-workspace-restored.test.ts` exercises the older transition and checks retained data, trigger bodies and both logins' effective grants after 124.
3. Bind the exact source commit, image, isolated target, distinct database roles, inventory, hosted lock policy and expiry into a `packproof.reconstruction-release-review/v11` review. Pass its JSON and SHA-256 via `PACKPROOF_RECONSTRUCTION_V11_REVIEW_JSON` and `PACKPROOF_RECONSTRUCTION_V11_REVIEW_SHA256`. Both admission tasks run with workspace activation off and automatic migrations disabled. Run `node /release/reconstruction-v11-runtime-preflight.mjs api` and `node /release/reconstruction-v11-runtime-preflight.mjs worker` on distinct tasks using their own database logins.
4. Compare both fresh, read-only observations with `node infra/backend-release/collector-version-pair.mjs review.json api.json worker.json`. This checks the compiled 0.6.0 capabilities, the 124 trigger, prior order immutability, exact migration ledger and role privileges. A customer rollout still requires a compatible recovery image or approved cutover, independent approval of the database and hosted application changes, publication of the matching portal and installed-client verification.

For promotion on the customer-facing system, use the [Connect 0.6.0 hosted rollout](connect-hosted-rollout.md).
