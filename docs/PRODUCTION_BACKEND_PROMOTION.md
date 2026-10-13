# Production promotion of the existing customer backend

The live Android and macOS clients use the ECS Express endpoint recorded in
`ADMIN_DEPLOYMENT_RUNBOOK.md`. Preserve that endpoint, the Cognito pool/client,
customer RDS database, S3 evidence bucket, signing key and existing secret references.
The historical `staging` resource names identify customer resources; they are not
disposable staging data.

For this in-place promotion, set `PACKPROOF_ENVIRONMENT=production` and explicitly
set `PACKPROOF_CREDENTIAL_NAMESPACE=staging`. The namespace remains stable across
future production releases. It controls new OAuth credential references, including
reauthorization and background refresh. Changing only the environment without
preserving the namespace would target secrets outside the existing runtime policy.
No IAM expansion or copying of existing credentials is needed.

`assertProductionRuntime` runs before opening the database or starting workers.
It rejects development authentication/storage, automatic migrations, unverified
database transport, missing KMS signing, missing readiness storage and unpinned
release identities. These checks admit configuration; the release verifier and
`/ready` establish dependency availability separately.

Release using the root-context `backend-production-buildspec.yml`, an exact Git
blob archive from `backend-source-archive.py`, and a unique source-pinned image tag.
Require the full backend suite, PostgreSQL release invariants, deployment tooling,
dependency audit and CodeQL on the exact source. Scan the candidate image and retain
the existing immutable image as the rollback target.

Run `backend-production-preflight.mjs` inside the candidate image under the current
execution/task roles and network, with the proposed production configuration.
It runs only a read-only transaction using `packproof_app_runtime_v1`, checks verified
TLS and all 86 exact migration checksums, rejects elevated database privileges, and
preserves the migration-controlled durability policy. No owner credentials or
migration process are used.

`makeProductionPlan` adds the explicit environment, credential namespace and verified
TLS setting to the ordinary exact-image deployment plan. It changes the Express
health check to `/ready`; all customer resource bindings and secret references are
preserved. Its rollback restores the original image, complete container configuration,
health path and task count. A second always-on API task is optional and requires the
owner's cost approval; the default is the existing one-task capacity.

The existing foundation template now retains database backups for 35 days and enables
deletion protection. Before execution, review a CloudFormation change set: the database
must be modified in place, never replaced. Enabling backups is not a restore drill;
record the actual retention and latest restorable time after deployment.

Complete the managed canary and final bake period, then read back the native ECS
deployment as `SUCCESSFUL` with 100% production traffic. Verify `/meta`, `/ready`,
authenticated-route rejection, disabled developer login and mobile capabilities.
Record exact source/image, actual test counts, runtime database receipt, preserved
client identity and rollback separately. API checks do not establish physical-device
or full signed-in customer acceptance.
