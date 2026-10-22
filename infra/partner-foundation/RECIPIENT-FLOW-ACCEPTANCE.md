# Isolated recipient flow acceptance

This harness combines the recipient lifecycle, real protected S3 versions, KMS
signatures and fresh PostgreSQL reconstruction in one synthetic run. It is not a
production rollout or device, HTTP, human review, merchant or provider acceptance.

Scope is account `784514617543`, region `us-east-1`, stack
`packproof-m2r-20261022`, and the existing isolated M1 RDS host. It creates fresh
`m2_recipient_20261022` and `m2_recipient_restore_20261022` databases and refuses
existing databases or role names. Application tasks use separate API, worker and
restore logins. Only the temporary controller receives the isolated owner secret
through CodeBuild injection. No workload image contains that controller.

The template defaults to closed journal/recipient writers and no temporary build
authority. Validate with cfn-lint and recipient-flow.guard, inspect CloudFormation
pre-deployment events and the complete change set, then deploy a digest-pinned
image from the exact reviewed commit. Reopen only the new synthetic worker role.
The old isolated service stays stopped and its writer fence stays closed.

Run the controller with M2_CONTROL=bootstrap, then bind the returned configuration
S3 version and SHA-256 in the task definitions. The workload sequence is:

1. worker seed: verify permissions, protected original and conditional journal
   creation, then drain initial records;
2. API request, worker drain, API queue;
3. worker render: reject undurable requests, inject a lost response after real S3
   publication, reconcile the same artifact without another PUT, publish result;
4. API approve, worker drain, API download: bind the synthetic approval to the
   exact artifact/claim and reject a stale download after a claim revision;
5. owner controller revoke, then worker handoff: drain, verify revoked access,
   save exact-version replay input and remain alive holding its original credentials;
6. controller close: database writer fence false, source logins NOLOGIN and sessions
   terminated; apply reviewed WriterFence=CLOSED; write the task/source-bound fence
   marker; require both protected PUT and signing denial using cached credentials;
7. save a versioned source-closed receipt referencing that completed worker report;
   controller restore-bootstrap, then restore task with exact replay and closure
   versions/digests; compare nine tables including claims, result, approval,
   manifests and original references, verify revoked access and no publication;
8. controller close again, remove temporary build authority, and pause temporary
   compute. Retain protected objects, reports, keys and disabled database logins.

The fixture uses an owner-seeded LEGACY_UNKNOWN synthetic ffmpeg clip followed by
domain finalization. It does not imply capture provenance or real user approval.
The synthetic baseline grants are not a production grant policy. The restore target
keeps writers and traffic closed. The production M2 migration and rollback bridge
remain separate acceptance requirements.

The original cloud reconstruction completed the exact nine-table comparison, then
failed a harness assertion expecting a membership-specific error. A restored
database correctly returns POLICY_RECOVERY_UNAVAILABLE while disclosure is fenced.
Keep that failed report. The verify-restored mode requires its exact version and
digest, uses PostgreSQL default_transaction_read_only=on, verifies all nine tables
again, checks the authenticated revoked-membership projection and policy overlay,
and requires the correct closed-access error. It does not replay or change rows,
complete policy reconciliation, reopen traffic, render output or sign records.
Its original source and newer verification harness are reported separately.
