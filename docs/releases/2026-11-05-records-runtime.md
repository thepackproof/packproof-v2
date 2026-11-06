# Records production runtime — November 5, 2026

Application source: `65700aac0d8d3d0640b13469a2d508d86efcc318`.
Immutable application image: `sha256:6a396f672e62636a6fb603b7e922afadeed0070183d319e3ef335e9ac4274d6f`.
Operator changes after that application commit do not imply a rebuilt application image.

## Completed qualifications

- Production has all 106 exact migration receipts, including records migrations 096–107. Inventory SHA-256: `605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1`.
- The original runtime's existing effective permissions were preserved while creating separate API and worker logins.
- Both new logins passed independent read-only production PostgreSQL admission, including TLS, identity, schema, records privileges, M2 privileges and durability-policy checks.
- A one-shot startup using the actual new API database and IAM roles passed `/meta`, `/health` and `/ready`, with website CORS. Organizations were configured on in that unrouted probe; workers did not start.
- Credentials are generated in Secrets Manager and injected by ECS. They are never returned to the deployment operator. Cursor signing and webhook-response encryption use separate managed keys.

## Deployment topology

The customer-facing service retains its existing endpoint, image, CPU, memory, network, scaling, health path and provider settings. Its intended process role is `api`; it uses `packproof_records_api_v1`.

The separate Fargate worker uses `packproof_records_worker_v1`, no load balancer, a read-only root filesystem, UID 1000, and a writable temporary volume. Stage it at desired count 0 until the API deployment is successful and the previous combined task is stopped, then use desired count 1. Preserve existing legacy jobs during this transition.

Persistent CloudFormation stacks:

- `packproof-records-runtime-20261105`: managed credentials and API/worker IAM roles.
- `packproof-records-worker-20261105`: worker task and service.

The reviewed concrete templates and private configuration-preservation plan are retained under:

`s3://packproof-v2-staging-build-784514617543/security-release/65700aac0d8d3d0640b13469a2d508d86efcc318/runtime-credentials/`

Only a terminal successful native deployment and post-deployment functional evidence qualify a completed cutover; task registration or a successful update request alone does not.

## Production HTTPS acceptance

`infra/backend-release/records-production-synthetic-acceptance.mjs` is an explicit one-shot operator, not an application entry point.

Run it only in the source-bound application image with the existing temporary owner operator task. The binding requires `PACKPROOF_OPERATOR_PURPOSE=records-production-synthetic-acceptance`, application source 65700aac, the exact production database and the owner login. Runtime service tasks must never receive this owner credential.

The operator creates two clearly labeled sandbox organizations and non-login synthetic actors. It generates service credentials only in process memory, stores their hashes, and uses the actual public HTTPS API to check record creation and reads, idempotency, restricted scopes, tenant isolation, signed pagination, encrypted sensitive-response replay, CSV original preservation, and processing by the dedicated worker. It creates no human login, submits no human attestation and claims no physical evidence.

Its `finally` block revokes all four synthetic credentials, revokes the two service principals, disables both sandbox organizations, and verifies a revoked credential receives HTTP 401. Audit events, source bytes and synthetic records remain preserved and identifiable. The credential expiry is a further bound, not a substitute for checking cleanup.

A passing receipt must have `passed=true`, `cleanupVerified=true`, source/image identity matching this release, actual worker-created record reads, and the expected negative authorization outcomes. Check task STOPPED/exit 0 and persist the safe receipt. Do not log tokens, capture-intent responses, passwords or complete private runtime environments.

## Rollback and incomplete scope

After the M2 runtime grants are installed, the earlier compatibility bridge is not a valid rollback target. Keep the full application image. If reverting to the prior combined runtime, first stop the dedicated worker; preserve the schema and existing permissions. Do not run schema rollback or rotate capture upload signing material.

Claims, durable recovery, integrity envelopes and operational snapshots require their separate production protection profiles and qualification. The organization flag does not qualify those features. Do not invent webhook receiver hosts, hardware evidence or a completed pilot observation period.

The website is a separate Sites repository. Its publication must be verified independently against the existing site and correct source; backend deployment does not publish the portal.
