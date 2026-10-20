# Isolated M1 staging continuation

Target: **new stack `packproof-m1-20261020`, us-east-1**, synthetic data only. The existing service named `packproof-v2-staging-api` is customer-facing production; neither it nor the us-east-2 legacy stack is a test destination. See [observed AWS readiness](../../docs/partner-foundation/AWS-READINESS-2026-10-20.md).

`isolated-foundation.json` is the reviewable storage/database substrate, not a running API deployment or passed M1 gate. Its approval parameter defaults to `PENDING`, and a CloudFormation rule refuses creation until the owner has approved the new retention setting. No change set has been created or executed.

| New resource | Prepared configuration |
| --- | --- |
| Database | PostgreSQL 16.15, db.t4g.micro, 20 GiB encrypted gp3 with 40 GiB maximum, private Single-AZ, 7-day test backups, deletion protection, managed owner secret and TLS enforcement |
| Network | Dedicated 10.42.0.0/16 VPC and two private subnets; database ingress only from the new runner security group. No peering, public route, public endpoint or existing security group reference |
| Upload bucket | Private, encrypted, versioned; incomplete multipart uploads aborted after 7 days |
| Committed evidence and recovery buckets | Separate private, encrypted, versioned buckets; 90-day GOVERNANCE Object Lock; no automatic evidence expiration |
| Signing keys | Two separate ECC_NIST_P256 signing keys, initially without application grants; production keys are not reused |
| Logs | Separate log group, 30-day retention |

Buckets, keys, database, logs and bucket policies are retained when the stack is deleted or replaced. They can continue to incur AWS charges after stack deletion. Decommissioning must preserve retained versions and explicitly handle the database and keys; deleting a stack is not a cleanup procedure. No shorter retention, governance-bypass permission or production storage modification is authorized by this packet.

## Execution order after the owner decision

1. Record the exact reviewed candidate SHA, successful CI runs and template SHA-256. Validate with `cfn-lint --region us-east-1 --template infra/partner-foundation/isolated-foundation.json`. Create a CREATE change set for the new stack only, with `EnvironmentName=packproof-m1-20261020` and, only after approval, `RetentionDecision=APPROVED_BY_OWNER`. Review that every action is Add and no resource import or existing-resource change appears. Use CloudFormation pre-deployment validation and inspect `DescribeEvents` before execution.
2. Execute that reviewed change set. Record actual outputs, resource identities and configuration reads. Keep owner database credentials inside a separate short-lived migration runner; never inject them into the application API. Provision separate API, recovery-worker and restore-test roles with narrowly scoped grants. Generate the dedicated 32-byte base64 cursor secret through managed secret handling. The template intentionally contains no runtime grants or fake recovery protection evidence.
3. Add a separate test Cognito pool with strong administration authentication, a test-only web origin, network endpoints required by the runner and an exact-source API image. No production identity pool, SMTP, payment-provider credentials, customer notifications or customer data. The current foundation has no internet egress, so runners cannot operate until their reviewed endpoint/network configuration is supplied.
4. Run the existing 86-migration baseline on the isolated database with synthetic two-merchant fixtures. Save the exact manifest/export bytes. Execute `backend/scripts/organization-preflight.sql` read-only, then the five additive migrations 088-092 using the normal migrator and isolated owner connection. Measure lock duration and compare original hashes/bytes. `scripts/rnd-migrate.mjs` remains pinned to the old 079-087 inventory and must refuse this newer candidate; it is not the organization migration tool.
5. Establish protected journals under separate API/worker roles. Verify version-specific preservation, conditional creation, API journal-write/sign denial, worker delete denial, deletion-restricted keys and old-writer fencing using only synthetic objects. Do not set any protection-evidence boolean until that test actually passes. Independently review the file and SHA expected by `operations/recovery-runtime.ts`, then enable durable receipts through the established migration-controlled policy and separate process roles.
6. Run T01-T09/T13, including revoked in-flight capture, queued webhooks, event catch-up and shared human attestation. Restore to a fresh independent target; compare core bytes, policy state and revocation behavior, then prove the old writer cannot publish. A database backup check alone does not satisfy this step. Record actual restore duration and recovery point.
7. Run the web/Android interruption and wrong-Proof scenarios on real builds/devices. Obtain independent M1-06 review before the full M2 SDK or a named live merchant cohort. Production expansion and merchant delegation remain separate explicit decisions.

## Stop and rollback

On failed isolation, preservation, restore or authority checks, leave the test cohort disabled and preserve the exact failed artifacts. Stop only the new test tasks. Do not invoke the legacy staging deployment scripts, drop additive organization tables, bypass Object Lock or reset revoked grants. Test application rollback must respect the migration compatibility guard and use a compatible image.
