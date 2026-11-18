# Connect 0.6.0 hosted rollout

The customer API is the ECS Express service `packproof-v2-staging-api`. The worker is `packproof-records-worker`. Both run in `packproof-v2-staging-cluster` in account `784514617543`, us-east-1. The API, worker and RDS instance serve production. Run the following from the selected Git checkout, using an operator session for that account. The CLI needs Node, Python 3, jq, GitHub CLI and AWS CLI v2 with ECS Express support.

## Release evidence

1. Prepare and verify the exact-source release packet and retain the currently served portal using the [rollout guide](../../docs/windows-connect/LIVE_ROLLOUT.md). Complete its image retention and publication steps. The bridge and candidate must each have a published ECR digest. Save the CodeBuild IDs and logs for the builds that produced those published bytes, including images first staged privately.
2. Create a private working directory outside the checkout. Requests contain private container settings and secret references. Each builder creates a new output file. Keep the registered task definitions, task ARNs, reviews, plans, receipts and RDS recovery-point identifier with the release record.

```sh
umask 077
P=$(mktemp -d)
R=infra/backend-release
SOURCE=$(git rev-parse HEAD)
export AWS_REGION=us-east-1 AWS_PAGER=""
node infra/connect-rollout/prepare.mjs verify "$PACKET_DIR" "$SOURCE"
gh run view "$CI_RUN_ID" --json workflowName,headSha,conclusion > "$P/ci.json"
aws ecr describe-images --repository-name packproof-v2-staging-api --image-ids "imageTag=collector-compat-$SOURCE" --query 'imageDetails[0]' > "$P/bridge-ecr.json"
aws ecr describe-images --repository-name packproof-v2-staging-api --image-ids "imageTag=connect-runtime-$SOURCE" --query 'imageDetails[0]' > "$P/candidate-ecr.json"
```

For each build, inspect `aws codebuild batch-get-builds --ids "$BUILD_ID"`. Match its project, successful status, reviewed source and profile to the packet. Use the build's `logs.groupName` and `logs.streamName` for the following read. Repeat for `bridge` and `candidate`.

```sh
aws logs get-log-events --log-group-name "$BUILD_GROUP" --log-stream-name "$BUILD_STREAM" --start-from-head --output json |
  jq -es '[.[].events[].message | fromjson? | select(.event=="shipment_release_build_policy")] | if length==1 then .[0] else error("expected one built policy") end' > "$P/$PROFILE-policy.json"
jq -n --slurpfile p "$PACKET_DIR/rollout.json" --slurpfile ci "$P/ci.json" \
  --slurpfile be "$P/bridge-ecr.json" --slurpfile ce "$P/candidate-ecr.json" \
  --slurpfile bp "$P/bridge-policy.json" --slurpfile cp "$P/candidate-policy.json" \
  '{packet:$p[0],ci:$ci[0],bridge:{imageDetail:$be[0],policyEvent:$bp[0]},candidate:{imageDetail:$ce[0],policyEvent:$cp[0]}}' > "$P/release.json"
```

For staged image publication, use the actual successful `packproof.connect-registry-publication/v1` output for `release.publication`. For each profile, read its emitted tag with `aws ecr batch-get-image --repository-name packproof-v2-staging-api --image-ids "imageTag=$TAG"`, and use that raw JSON as `release.bridge.manifestResponse` or `release.candidate.manifestResponse` in place of `imageDetail`. Keep the build's `policyEvent` for each. The builder verifies the registry manifest, image configuration and release source against the staged publication receipt.

Use a UTC ISO expiry within two hours for newly constructed reviews. The standalone observers can be run repeatedly with a new directory. A successful full observation includes the actual public API identity, native deployment state, every running task and digest, the private worker task definition, ECS networking, ALB topology and the public health, readiness, CORS and unauthenticated-access checks.

```sh
EXPIRES=$(node -p 'new Date(Date.now()+110*60000).toISOString()')
node "$R/connect-hosted-runtime-observe.mjs" "$P/baseline"
```

## Inspect the current database

The one-shot owner ECS task runs the candidate image with the RDS-managed owner secret injected into its isolated container. The application tasks use the existing independent `packproof_records_api_v1` and `packproof_records_worker_v1` database logins. The owner task opens a TLS-verified connection to `packproof_v2` on `packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com`. Its inspection takes a read-only transaction and reports the hash of the entire current ledger and the last migration number in `through`.

Start with the observed worker network and the existing execution role `arn:aws:iam::784514617543:role/packproof-v2-staging-execution`. The private observer checks ECS trust and simulates that role's access to the exact RDS-managed secret. It reads the active secret version from metadata without retrieving its contents. It verifies every subnet, route and security group, including RDS port access and outbound image/log access. The existing VPC can use public IP assignment with the verified service security group. The standalone task exposes no ports.

```sh
jq '{executionRoleArn:"arn:aws:iam::784514617543:role/packproof-v2-staging-execution", network:.probe.networkConfiguration.awsvpcConfiguration}' "$P/baseline/snapshot.json" > "$P/owner-location.json"
node "$R/connect-hosted-owner-task.mjs" observe "$P/owner-location.json" "$P/owner-observed.json"
jq -n --arg expiresAt "$EXPIRES" --slurpfile s "$P/owner-observed.json" --slurpfile r "$P/release.json" \
  '{snapshot:$s[0],release:$r[0],$expiresAt}' > "$P/owner-review-input.json"
node "$R/connect-hosted-review.mjs" owner "$P/owner-review-input.json" "$P/inspect-review.json"
```

If the existing execution role or security group cannot run the task, the owner CLI can build tightly scoped CloudFormation templates. Run `observe` with `{"databaseOnly":true}`, then supply `{"snapshot": <that output>}` to `execution-role` and/or `network-group`. The role template limits registry, log stream, RDS-managed secret and applicable KMS-key access. The network template creates a group with no ingress and outbound HTTPS and RDS access. For a dedicated group, verify the actual RDS group permits its traffic, and select routed subnets. Execute the applicable infrastructure change through the existing change process, use its role ARN and/or group ID in `owner-location.json`, then repeat observation.

The owner CLI phases `register` and `run` each write an AWS request envelope. For each owner mode use a new directory and the following sequence. Supply `$REVIEW` as the absolute path to the review, and `$MODE` as `inspect`, `rehearse` or `apply`. A fresh owner observation must be within five minutes of generating each request. Save the raw AWS responses privately. Each request's operation, region and exact parameters are explicit. AWS CLI equivalents for owner and probe registration/runs are illustrated below.

```sh
D="$P/$MODE"
mkdir "$D"
node "$R/connect-hosted-owner-task.mjs" observe "$P/owner-location.json" "$D/snapshot.json"
jq -n --arg mode "$MODE" --slurpfile s "$D/snapshot.json" --slurpfile r "$REVIEW" \
  '{snapshot:$s[0],review:$r[0],$mode}' > "$D/input.json"
# For apply, also put the successful rehearse evidence in input.rehearsal.
if [ "$MODE" = apply ]; then
  jq --slurpfile q "$P/rehearse/receipt.json" '. + {rehearsal:$q[0]}' "$D/input.json" > "$D/apply-input.json"
  mv "$D/apply-input.json" "$D/input.json"
fi
node "$R/connect-hosted-owner-task.mjs" register "$D/input.json" "$D/register.json"
jq .params "$D/register.json" > "$D/register-params.json"
aws ecs register-task-definition --cli-input-json "file://$D/register-params.json" > "$D/registered.json"
node "$R/connect-hosted-owner-task.mjs" observe "$P/owner-location.json" "$D/before-run.json"
jq --slurpfile reg "$D/registered.json" --slurpfile s "$D/before-run.json" '. + {registered:$reg[0],snapshot:$s[0]}' "$D/input.json" > "$D/run-input.json"
node "$R/connect-hosted-owner-task.mjs" run "$D/run-input.json" "$D/run.json"
jq .params "$D/run.json" > "$D/run-params.json"
aws ecs run-task --cli-input-json "file://$D/run-params.json" > "$D/started.json"
TASK=$(jq -er 'select((.failures|length)==0 and (.tasks|length)==1) | .tasks[0].taskArn' "$D/started.json")
aws ecs wait tasks-stopped --cluster packproof-v2-staging-cluster --tasks "$TASK"
node "$R/connect-hosted-task-receipt.mjs" "$TASK" "$D/receipt.json"
```

The receipt reader uses the stopped task's actual definition and its own log stream. If the container has exited and CloudWatch delivery is still pending, repeat just the receipt read. RunTask tokens are idempotent for the reviewed input. For a failed owner task, read its actual `DescribeTasks.tasks[0]` into `retryOf`, renew the live observation, and regenerate `run` for a distinct retry. After an interrupted apply, repeat read-only inspection before taking action.

## Qualify and promote a paired image

On the existing 122 ledger, use `PROFILE=bridge`. Once the database is verified at 124 and both services are on the bridge, repeat this entire section in a new directory using `PROFILE=candidate`. The 122 binary rejects the later schema at startup. The bridge preserves its currently deployed application from the pinned base and admits only the exact additional checksums of 123 and 124.

```sh
D="$P/$PROFILE"
mkdir "$D"
node "$R/connect-hosted-runtime-observe.mjs" "$D/before"
EXPIRES=$(node -p 'new Date(Date.now()+110*60000).toISOString()')
jq -n --arg profile "$PROFILE" --arg expiresAt "$EXPIRES" --slurpfile s "$D/before/snapshot.json" --slurpfile r "$P/release.json" \
  '{snapshot:$s[0],release:$r[0],$profile,$expiresAt}' > "$D/review-input.json"
node "$R/connect-hosted-review.mjs" pair "$D/review-input.json" "$D/review.json"
jq -n --slurpfile s "$D/before/snapshot.json" --slurpfile r "$D/review.json" '{snapshot:$s[0],review:$r[0]}' > "$D/probe-input.json"
node "$R/connect-runtime-release-runner.mjs" register-probes "$D/probe-input.json" "$D/probe-requests.json"
```

The runner prepares four separate task definitions named `api`, `worker`, `previous-api` and `previous-worker`. Register each `.[$kind].params`, retain its raw registration response and assemble `{snapshot,review,kind,registered}` by adding those final two fields to `probe-input.json`. The runner's `run-probe` phase emits each standalone ECS RunTask request. Start all four, wait for their stopped tasks, then run `connect-hosted-task-receipt.mjs TASK_ARN "$D/$kind-receipt.json"` for each. Both process roles use their actual database logins. The preceding image must pass its own startup and reader checks under both roles. The deployed shipment interpretation setting is carried forward.

```sh
node "$R/connect-hosted-runtime-observe.mjs" "$D/before-plan"
jq -n --slurpfile s "$D/before-plan/snapshot.json" --slurpfile r "$D/review.json" \
  --slurpfile a "$D/api-receipt.json" --slurpfile w "$D/worker-receipt.json" \
  --slurpfile pa "$D/previous-api-receipt.json" --slurpfile pw "$D/previous-worker-receipt.json" \
  '{snapshot:$s[0],review:$r[0],probes:{api:$a[0],worker:$w[0],"previous-api":$pa[0],"previous-worker":$pw[0]}}' > "$D/plan-input.json"
node "$R/connect-runtime-release-runner.mjs" plan "$D/plan-input.json" "$D/plan.json"
```

For each phase below run `node "$R/connect-runtime-release-runner.mjs" PHASE PRIVATE_INPUT.json PRIVATE_REQUEST.json`. Execute its emitted AWS envelope and retain the response. The input field values are full JSON objects.

| Phase | Private input | AWS operation and next observation |
| --- | --- | --- |
| `worker-register` | `{plan}` | Register the candidate worker revision and retain `registered`. |
| `worker-update` | `{plan,registered,observation}`, from a new `worker-observation.json` | Update the ECS worker service. Wait for all tasks on the digest and successful initializers. |
| `api-update` | `{plan,workerObservation,apiObservation}`, from one fresh full observation | Update the Express primary container. Wait for the native deployment to succeed. |
| Completion | New full observer output | Compare public `/meta`, every API and worker digest, and the checked health/readiness responses. Reconcile worker job health in the existing operational dashboard. |

Keep all four role receipts fresh through plan creation. Re-observe if a read expires. The worker registration and promotion require a current plan. If resuming after an interruption, first inspect both services. Skip completed operations evidenced by their running digests. The recovery section covers safely returning a partially promoted candidate worker to the already-serving bridge.

## Apply migrations 123 and 124

After promoting the bridge, re-observe both services. The owner request builder demands one successful Express revision and verifies the actual source and digest of every running API and worker container against the reviewed bridge before it constructs `rehearse` or `apply`. It checks again when constructing RunTask. AWS and RDS status drive resumption. If both services are already on this bridge and inspection returns 124, proceed to candidate qualification. If the ledger is at 123 on this bridge, apply the remaining migration.

Construct the write review from a fresh owner observation and the actual stopped inspect task. Keeping the review unchanged, execute the owner sequence above first in `rehearse` mode and then in `apply` mode. The rehearsal executes exactly the reviewed DDL and grants, verifies the final ledger inside that transaction, then rolls it back. The apply task binds the rehearsal, review, target and actual ECS task digest.

```sh
node "$R/connect-hosted-owner-task.mjs" observe "$P/owner-location.json" "$P/pre-migration.json"
EXPIRES=$(node -p 'new Date(Date.now()+110*60000).toISOString()')
jq -n --arg expiresAt "$EXPIRES" --slurpfile s "$P/pre-migration.json" --slurpfile r "$P/release.json" \
  --slurpfile i "$P/inspect/receipt.json" --slurpfile ir "$P/inspect-review.json" \
  '{snapshot:$s[0],release:$r[0],$expiresAt,inspection:($i[0]+{review:$ir[0]})}' > "$P/write-input.json"
node "$R/connect-hosted-review.mjs" owner "$P/write-input.json" "$P/write-review.json"
```

If the inspect review was captured before bridge promotion and its result is stale, repeat inspection on the bridge with a newly constructed inspect review and use that receipt. On 122 the owner takes the shared migration lock and applies 123, its scoped new relation grants and 124 in one transaction. On 123 it applies only 124. A previously committed 124 is idempotent. Compare the committed receipt's `finalLedger` with `d0161362a548b61f4cc69195ad8920fbddec36f2b9d183e5b1cd066b6f0eeb60`. Retain the existing RDS recovery point and committed ledger. Continue with the candidate paired promotion above.

## Open and verify the workspace

Promote and verify the exact matching browser bundle using the [portal steps](../../docs/windows-connect/LIVE_ROLLOUT.md). Read the public manifest at `https://dvpmnwc27i8tw.cloudfront.net/release.json`. Capture a new full runtime observation and assemble `{enabled:true,plan,apiObservation,workerObservation,portalManifest}` using the **candidate** plan and published manifest. Run `workspace-switch` with the phase runner, execute its UpdateExpressGatewayService request and check the native rollout and all running digests again. This changes only the API's workspace flag. A newly approved 0.6.0 folder collector can create its integration account under this flag without enabling general typed imports or multi-source grants.

Complete the authenticated Windows-to-Proof journey, including export byte verification, using the [release acceptance procedure](../../docs/windows-connect/LIVE_ROLLOUT.md).

## Recover service

1. To pause workspace requests, capture `node "$R/connect-hosted-runtime-observe.mjs" "$P/pause" --api-only` and run `workspace-switch` with `{enabled:false,plan,apiObservation}`. Execute it, wait for the new Express revision, and retain the customer records and local queues. Reconcile work accepted since activation.
2. For a binary reversal after migration, keep 124. Capture a full observation. Re-describe the two `previous-api` and `previous-worker` reader **probe** task definitions retained in the candidate plan. For each role run phase `recovery-probe` with `{plan,kind,registered,snapshot,attempt}`, where `kind` is `api` or `worker`, `registered` is its current DescribeTaskDefinition result, and `attempt` is a unique operation identifier reused for an identical retry. Execute both generated RunTask requests and collect two new stopped-task receipts using the receipt reader.
3. Assemble `{plan,readers:{api,worker},apiObservation,workerObservation}` with the fresh receipts and observation. Phase `recovery-api` requires the stable candidate API with workspace disabled, reconstructs the proven bridge primary container, and preserves unrelated settings. Execute it and wait until every API task and public identity report the bridge. For a candidate-worker-only rollout that left the API on the bridge, start with the next step.
4. Refresh both service observations and, if the receipts exceed 15 minutes, rerun the two readers. Phase `recovery-worker` accepts the same input only once the stable API is on the bridge and the live worker still matches the candidate. It emits an UpdateService request for the exact prior bridge worker revision. Observe both running services, readiness and pending work. For an already-failed ECS deployment, wait for native rollback and inspect its actual terminal state first. The original pre-bridge binary cannot boot on 124.

For a portal reversal use the captured predecessor portal and its verified origin. Investigate any database restore in a separate instance to preserve post-cutover customer work.
