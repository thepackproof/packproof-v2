# Isolated protected recovery acceptance

`recovery-runner.json` and `backend/scripts/isolated-recovery-acceptance.mjs` exercise the existing recovery services on the approved `packproof-m1-20261020` foundation. They create no production service, change no production policy and admit no customer data. The script checks the exact test hostname, region and purpose before connecting.

## Authority boundaries

| Principal | Permitted work | Explicitly unavailable |
| --- | --- | --- |
| Coordinator | Read the isolated database owner secret, establish temporary databases/logins, assume the three acceptance roles, write acceptance artifacts | Change IAM, change retention, delete protected versions, disable/delete signing keys |
| API role | Upload/commit synthetic evidence and sign manifests with the isolated manifest key | Read/write recovery journals, sign with the recovery key, obtain the owner secret, change retention or keys |
| Recovery worker | Read/create conditional journal objects and sign them with the separate recovery key | Sign manifests, delete journal versions, bypass retention, change key policy or obtain the owner secret |
| Restore reader | Read exact committed/journal versions, inspect retention, list the isolated journal prefix and read public verification keys | Write journals/media, sign, change retention or keys |

The API and recovery worker use separate non-owner PostgreSQL logins. The API inherits `packproof_runtime`; the worker inherits the existing `packproof_runtime` and `packproof_recovery` groups. The latter grants delivery publication while the runtime group supplies the domain/audit work required by finalization. Neither login can reopen writer fences or alter schema. The dedicated restore login receives data reconstruction grants only in its new target database and has no superuser, role-creation or RLS-bypass capability.

The coordinator owns test setup and cleanup. It is an acceptance harness, not the API process. Its ability to assume both test roles is not a claim of a deployed service-process boundary. Key-administration denials are checked with IAM simulation; the drill does not attempt a destructive key-deletion operation. Application roles cannot bypass governance retention; account administration remains separately privileged.

## Execution

1. Pin the source commit, lint the template and validate all role policies. Review the CREATE change set: 21 new temporary resources in the existing isolated VPC. The protected buckets and signing keys are reused by exact identity.
2. Start the private CodeBuild project with that exact candidate SHA. The runner probes API journal/signing denial, worker deletion denial, conditional creation and 90-day retention before publishing any recovery receipt.
3. Create two random, isolated databases and three temporary database logins. Apply normal migrations and the existing runtime grants. Build a synthetic merchant, partner and delegated operator using shared services. Capture real fixture video into private S3, finalize with KMS and publish core/policy receipts with the worker role. Revoke the partner grant and preserve that decision.
4. Fence the source database. The runner writes an `awaiting-fence.json` control record and pauses. Review and execute a CloudFormation UPDATE with `WriterFence=CLOSED`; the only resource modifications should be the API and worker policies. After the update succeeds, write `fence-complete.json` to the exact run control prefix, including its `runId`, `writerFence: CLOSED` and change-set evidence. The coordinator has no IAM mutation permission and cannot manufacture this external policy update.
5. The runner tests its already-issued source credentials for write/sign denial, disables the source database logins, terminates their sessions and verifies reconnection denial. The restore reader obtains exact journal versions and signed heads from S3 independently of the source database query results.
6. Reject tampered/wrong-key envelopes and an incomplete head. Reconstruct the fresh database with the existing restore service. Compare frozen manifest/signature bytes and all nine organization authority/binding tables, including the revoked grant. The existing migration 092 intentionally excludes `platform_credentials.last_used_at` telemetry; compare every other credential field and verify the restored telemetry is null. Verify media versions, policy reconciliation and closed target fences. Do not enable target traffic.
7. Preserve the encrypted S3 artifact and logs. The runner removes only databases and logins it created. Remove the temporary CloudFormation stack after the build ends; retain its encrypted logs/key and all protected evidence versions.

## Evidence and limits

Each run writes `recovery-acceptance.json`, the original `.pkpr`, before/after canonical manifests, public verification keys and the exact signed core/policy heads. The report identifies object versions, retention dates, role denials, database authorities, restore counts and cleanup outcomes. The runner also writes the report to its control prefix after cleanup, and the build phase permits artifact upload after a failed check while retaining the failed build result. A successful run is a synthetic deployment-semantics test. It is not independent review, Cognito/MFA evidence, device acceptance, a production recovery certification or authorization to reopen traffic.

Journals use a run-specific acceptance prefix so retries never overwrite a retained previous exercise. The wrapper changes only the test namespace; serialization, conditional S3 creation, signing, publication and restoration use shared backend implementations. The restore target stays closed and is removed after comparison. The protected source objects remain under the approved 90-day retention.
