# Connect API and worker image release

This operator prepares requests for the existing account `784514617543` in `us-east-1`. It performs no AWS calls. The API named `packproof-v2-staging-api` serves production; its name does not qualify an independent staging environment. Current source requires the separate worker to support the same CSV v2 rules before the API advertises them. Existing migration operators and the retired 77-receipt release runner remain unchanged.

Application source and operator source may be different reviewed commits. The application archive must come entirely from its selected Git commit. For the November 16 candidate, that application commit is `debf53231d6f3ce8990afa74fbc47defac4f4ecb`. This document is not a deployment receipt.

## Private inputs

Use absolute private scratch paths. Preserve complete task definitions and Express primary-container configuration privately; do not print their environment values. These are observed inputs, not defaults:

- `snapshot`: `observedAt`, `account`, `region`, `topology`, `api: {service, express, taskDefinition, meta, nativeDeploymentStatus}`, `worker: {service, taskDefinition}`, and `probe: {clusterArn, networkConfiguration, capacityProviderStrategy?, platformVersion?}`. Describe the actual current ECS worker service; CloudFormation outputs may name an obsolete task revision. Keep the initializer container, ephemeral volumes, mounts, commands, dependencies, users and secret references.
- `review`: `schema: packproof.connect-runtime-review/v1`, application `sourceSha`, immutable repository-qualified `image`, `version`, expiry within two hours, `topologySha256`, `configurationLeaseSha256`, `expectedApi: {sourceSha,image,taskDefinition}`, `expectedWorker: {sourceSha,image,taskDefinition,serviceArn,clusterArn}`, actual separate `apiRole` and `workerRole`, `database: {host,name}`, actual `environment`, `probeClusterArn`, `probeNetworkSha256: connectReleaseHash(snapshot.probe)`, `ciPassed`, `sourceArchiveVerified`, `sourceArchiveSha256`, and `inventorySha256`.
- `configurationLeaseSha256` is `connectConfigurationLease(snapshot)`; `topologySha256` is `connectReleaseHash(snapshot.topology)`. Review the exact observed topology before pinning it. Observations and runtime-probe results expire after 15 minutes. Do not refresh their timestamps without repeating their reads.
- `probes.api` and `probes.worker`: `report` from the actual candidate task's `connect_runtime_probe` log, `registered` from its actual RegisterTaskDefinition/DescribeTaskDefinition response, and `task` from actual ECS DescribeTasks. The registered definition must exactly match the generated probe, including its roles, secret references and command; the stopped task must name that exact definition ARN. Each task must stop with exit zero; every owned container must have the candidate digest. Actual database login, TLS, existing records/M2 privileges, durability configuration and all 108 ledger receipts are verified read-only. These probes do not start the application or establish hosted merchant/browser/Windows acceptance.

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

The unsigned personal development installer can be delivered under its existing authorization while this hosted rollout is being qualified. It remains an internal candidate; signing and Windows 11/customer acceptance are separate production-distribution gates.
