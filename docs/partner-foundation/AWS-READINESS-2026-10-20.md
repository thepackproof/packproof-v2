# AWS readiness evidence - 20 October 2026

AWS authentication was restored and read-only control-plane checks succeeded. This replaces the earlier authentication blocker. No service, database, bucket, key, policy or identity configuration was changed, no secret values were retrieved, and no customer objects or database rows were read.

## Deployment identity and separation

The inventory covered all 17 enabled regions for CloudFormation, RDS instances/clusters and ECS clusters, plus account buckets and CloudFront distributions. Application resources were found in `us-east-1` and `us-east-2`.

| Observed environment | Evidence | Consequence |
| --- | --- | --- |
| V2 service with `staging` in its resource names, us-east-1 | Runtime explicitly sets `PACKPROOF_ENVIRONMENT=production`; website origins include the customer-facing site; release SHA `ccd04aba5b9305ce9bb7b2105323e63f6a95d87a`; one running API task | Treat as production. The candidate is not deployed here. Do not use the legacy staging deployment script for this milestone. |
| Legacy service, us-east-2 | Separate legacy API/worker, old application image and database | Not an approved disposable test target. Leave it untouched. |
| Isolated M1 environment | No separate M1 stack found | Prepare a new synthetic test target before migration and recovery exercises. |

## Observed controls and open gates

| Area | Actual result | What remains unproven |
| --- | --- | --- |
| V2 PostgreSQL | 16.15, encrypted, private, deletion protection enabled, 35-day automated backups, Single-AZ. Restorable-time metadata present. Runtime uses `verify-full` with a CA file; attached default PostgreSQL 16 parameter group reports `rds.force_ssl=1`. | No database connection, restore, migration timing, lock-duration measurement or recovered application test was performed. Restorable-time metadata is not a restore demonstration. |
| V2 evidence storage | Versioning enabled, AES256 default encryption, all four public-access blocks enabled. Object Lock configuration absent. No bucket policy or lifecycle configuration returned. | No immutable-retention assertion. Identity policy inspection is not a complete effective-permission assessment across SCPs and all principals. |
| Legacy evidence storage | Versioning enabled, KMS encryption, public-access blocks and insecure-transport denial present. Object Lock configuration absent. | Legacy storage is not preservation evidence for the V2 candidate. |
| V2 task permissions | Evidence read/write and version reads; deletion limited by the inspected inline policy to temporary upload/object-parts paths. Manifest signing scoped to one key. Runtime database credential read allowed; owner credential read explicitly denied. | The observed deletion paths are staging upload paths, not the committed evidence prefix. Runtime denial probes, conditional creation, key deletion controls and independent recovery permissions still require the new test environment. |
| Manifest KMS key | Enabled customer-managed `SIGN_VERIFY`, `ECC_NIST_P256`, `ECDSA_SHA_256`; configured signing is required. | No new signature, historical trust-registry validation, key rotation or independent offline trust test was performed. |
| Recovery | `PACKPROOF_REQUIRE_DURABLE_RECEIPTS=false`; no separate recovery bucket in the account bucket inventory and no recovery bucket configuration on the current task | Protected core/policy journals, separate recovery signing authority, durable publication and fresh-target writer-fence recovery are not deployed or demonstrated by this audit. |
| Human authentication | Cognito pool MFA configuration is OFF | Recent authentication checks in the candidate do not establish strong live administrative authentication. Test and approve the separate staging identity configuration before live entitlement. |

Inspection sources: ECS service/task/task-definition APIs, RDS describe APIs, S3 configuration APIs, KMS describe/public-key/policy APIs, IAM role/inline-policy APIs, Cognito pool configuration, CloudFormation and CloudFront inventory. ECS Express service discovery used the running task's task definition because the service response did not contain the ordinary top-level task-definition field. No task environment secret values were printed.

## Concrete continuation

The proposed [isolated foundation template](../../infra/partner-foundation/isolated-foundation.json) creates 17 new resources under `packproof-m1-20261020`: private PostgreSQL, isolated network/security groups, separate upload/committed/recovery buckets, separate manifest/recovery signing keys, and a log group. It neither imports production resources nor deploys an application service. See the [execution packet](../../infra/partner-foundation/README.md).

AWS `ValidateTemplate` succeeded. All ten resource type schemas were fetched from the us-east-1 CloudFormation registry; supplied top-level properties and required properties matched. RDS confirmed PostgreSQL 16.15 / db.t4g.micro / encrypted gp3 is orderable in us-east-1. Local cfn-lint was unavailable and package installation could not resolve a distribution in this sandbox; the dedicated infrastructure CI job supplies that additional check. These results are template checks, not a successful change set or deployment.

The proposed committed and recovery buckets use 90-day GOVERNANCE Object Lock, matching the plan's baseline duration. The upload bucket remains versioned without retention so expired staging uploads can be cleaned independently. No object-expiration rule deletes retained evidence automatically. Stateful resources and bucket policies use Retain on deletion and replacement.

**Owner decision required before stack creation:** approve this new isolated synthetic test environment and its 90-day GOVERNANCE retention. Page 39 of the attached plan explicitly reserves irreversible retention settings to Collin. S3 documents that Object Lock cannot be disabled after enablement; governance bypass is a distinct privileged action, not a runtime permission to grant. This approval does not authorize production expansion or retention changes to existing buckets.

AWS references: [Object Lock considerations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html), [configuring Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html).
