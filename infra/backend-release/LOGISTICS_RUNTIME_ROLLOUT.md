# Logistics129 hosted runtime rollout

This route completes the image-only runtime gap around the existing Logistics owner migration. It targets the live API `packproof-v2-staging-api` and worker `packproof-records-worker` in account784514617543, us-east-1. Facility grants, database migrations and AI setup are separate operations.

The reviewed backend image source and reviewed deployment-tooling source are separate pins. Keep the backend source, source archive hash/version, successful CodeBuild result, publication log, registry digests and CI result unchanged when publishing these tooling files. Each runtime review binds the exact probe program hash; registration and receipt verification reconstruct its exact command. Editing the probe after constructing a review invalidates that review.

## Inputs and evidence

Keep full observations, requests, role references and receipts private. The offline runner writes new files with mode0600 and refuses to overwrite them:

```sh
node infra/backend-release/logistics-runtime-runner.mjs PHASE INPUT.json OUTPUT.json
```

Execute the emitted AWS envelopes through the connected AWS application. The runner performs no AWS operations. Do not replace a rejected request with an alternate execution route.

The release object contains:

- `images`: actual `prepareLogisticsImages` receipt.
- `archiveSha256` and `sourceVersion`: exact reviewed source archive pins.
- `ci`: full successful main-branch `CI` workflow-run response for `images.source`.
- `build`: successful actual CodeBuild build from `BatchGetBuilds`.
- `buildLog`: `{group,stream,events}` from that build's own CloudWatch log stream, including its final two-image `DescribeImages` JSON and image receipt.
- `candidate` and `fallback`: live ECR `DescribeImages` responses for the two source-bound tags.

The constructor verifies the exact buildspec, S3 object version, environment pins, log-stream binding, source CI and distinct immutable digests. Registry tag results must equal the digests qualified and published in the successful build's own log.

Obtain a fresh complete snapshot using the existing runtime observer contract or equivalent connector reads. For ECS CANARY, resolve the task definition from the service revision referenced by the sole active Express configuration. Preserve that `revision` and actual `nativeDeployment` alongside the service, task definition, every running task, public meta/health/readiness/CORS results, probe network and canonical network topology. Do not select an arbitrary deployment-array item.

`logistics-runtime-observe.mjs` can assemble already collected `{services,discovery,publicChecks,observedAt}` using the existing observer's topology checks. Assembly preserves the original observation timestamp; it does not renew stale evidence. Existing equivalent snapshots can be supplied directly to every phase.

## Qualify and promote fallback on124

1. Build both immutable images with the existing `prepareLogisticsImages` route. Inspect the current database with the existing Logistics owner inspection. The current exact ledger must be124.
2. Run phase `review` with `{snapshot,release,profile:"fallback",expiresAt,version}`. Expiry must be within two hours. The snapshot must be no older than15 minutes, both runtime services must be stable on the build's actual predecessor, and facility/AI allowlists must be empty. Existing workspace settings are preserved, including API `PACKPROOF_ORDER_WORKSPACE_ENABLED=true` and an absent worker flag.
3. Run `register-probes` with `{snapshot,review}`. This emits four definitions: `target-api`, `target-worker`, `peer-api`, `peer-worker`. Target is the compatible fallback; peer is the actual predecessor. Register all four through ECS and retain the full responses.
4. For each label run `run-probe` with `{snapshot,review,label,registered}`. Refresh the snapshot if necessary. This preserves the observed runtime DB secret reference, task roles, temporary volume and initializer. Each primary executes only the embedded read-only probe. No command, environment or role overrides are passed to RunTask.
5. Read each actual stopped task, its exact registered task definition and its own log stream. Run `collect-probe` with `{taskDefinition,task,logGroup,logStream,events}`. The collector requires one completed report for that task. A failed start may be retried only by supplying its actual failed `DescribeTasks` object as `retryOf`; otherwise the request token is idempotent.
6. Run `plan` with `{snapshot,review,probes}`, mapping all four labels to their collected receipts. Each receipt must be no older than15 minutes. The planner independently revalidates registered commands, credentials, overrides, container names, all exit codes/digests, log provenance, actual DB role/TLS, ledger and guard results. It rejects reused task identities.
7. Run `worker-register` with `{plan}`, register the emitted revision, then `worker-update` with `{plan,registered,observation}` using a fresh worker observation. The request changes only the task-definition reference.
8. Wait for the observed worker rollout to complete, including its initializer. Run `api-update` with `{plan,workerObservation,apiObservation}`. It requires every worker task on the exact registered target and freshly unchanged API/topology. The Express update preserves all primary-container settings except image and the three release identity values. Managed scaling, rollout strategy, alarms, network and roles remain untouched.
9. Independently observe the stable fallback API and worker, their actual digests and public release identity.

Complete the forward worker-to-API promotion within the prepared plan's 15-minute validity window. The forward review constructor requires both services on the same reviewed starting image; it cannot create a replacement forward plan once only the worker has advanced. If the plan expires in that mixed state, stop and reassess the observed service revisions through a separately reviewed recovery decision. Do not extend timestamps, reuse expired evidence, or assume a generic re-plan can continue the cutover.

The standalone124 probes execute each image's actual compiled startup schema guard and full records privilege verification under both established database logins. They also check M2 separation, membership locks, immutable order history, scope triggers, durability configuration and compiled collector policy. API probes read order history. Worker probes verify that table and column SELECT on API-owned order history remain denied, then exercise the worker's permitted typed/import receipt readers. The fallback's compiled application manifest must equal the predecessor's manifest.

The probe's compressed source and review are carried in probe-only environment bindings. Its short command checks the exact source SHA before importing it. Registration/receipt verification compares the complete generated task definition, including both bindings; RunTask supplies no overrides. Failures report only a closed stage identifier, a whitelisted helper code, and SQLSTATE when available. Driver messages, SQL, credentials, connection strings and stacks are never included in diagnostic output. A failed gate requires investigation and a new reviewed probe; do not grant the worker access to API-owned history to make a probe pass.

## Migrate then qualify candidate on129

Use `logistics-hosted-owner-requests.mjs` for the existing sequence: fresh owner inspection, review, rolled-back rehearsal, apply, a distinct post-apply inspection, and `verify-apply`. Both services must remain on the qualified fallback for rehearsal and apply. Preserve the exact historical ledger and independent receipts. Do not reuse runtime receipts as migration receipts.

After successful committed129 verification, repeat the complete qualification and promotion sequence with `profile:"candidate"` in a new private directory. Both initial services must be on the reviewed fallback. Target is the candidate; peer is that fallback. Candidate API and worker probes verify the full129 privilege catalogue under their actual logins. Fallback readers independently invoke their own compiled startup guard against the real129 ledger and verify TLS/login, restricted authority, immutable history, the exact129 backfill trigger, membership locks, M2 separation and legacy reads. Their old124 privilege catalogue is not misrepresented as a129 verifier: the planner requires simultaneous full129 candidate verification for both database logins.

Promote worker first, then API. Verify the final immutable digests, native deployment status, public identity and readiness independently. Then verify the actual signed-in installation's `workspace-access` path, approved facility scope, order reconstruction and Proof. Runtime qualification alone is not customer acceptance.

## Recovery after129

The original pre-fallback image cannot boot on129 and is never selected by this route. Preserve the129 database and accumulated evidence.

1. Use existing authorized application controls to pause affected0.7 sources and reconcile already admitted batches/projections. These tools do not mutate customer queues or fabricate an empty-work report. Nonempty guided/AI allowlists must be handled through their separately reviewed activation controls before this runtime-only recovery path.
2. Create a fresh `profile:"recovery"` review. Target is the immutable compatible fallback, peer is the candidate. Services may be on the candidate or partially reverted fallback. Obtain four new actual-login probes against129. They must observe zero active0.7 sources, queued/running/replay batches and pending shipment projections. Existing data and completed records remain intact.
3. Create the recovery plan and use `recovery-api` with fresh API and worker observations. It reverses API first. Wait for the fallback API's actual native rollout, all task digests and public identity.
4. Re-observe and create a **new recovery review and four new receipts after API recovery**. The partial state with API on fallback and worker on candidate is explicitly supported. This rechecks current workload reconciliation before reversing the worker. Register the reviewed fallback worker definition, then run `recovery-worker` with `{plan,registered,apiObservation,workerObservation}`. It rejects a pre-API plan.
5. Observe both services and retained work independently. Do not restore a database snapshot or delete pending customer evidence to satisfy recovery checks.

If a deployment or process is interrupted, reread the actual service revisions and tasks before choosing the next phase. Fresh observations and receipts can replace an expired plan only when the selected review profile accepts the actual current service state. Forward mixed-state resumption is not implemented; the 15-minute forward cutover limit above still applies. Changing timestamps in old evidence is not a refresh.
