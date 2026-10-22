# Isolated recipient storage acceptance

This one-shot harness uses new synthetic buckets and API/worker/restore task roles
in account 784514617543, us-east-1. It has no database credentials, services,
merchant identities, provider actions or production resources. It does not prove
the full fresh database restore, HTTP authorization, camera lifecycle or pilot.

Generate `recipient-storage-assets.json` with
`node backend/scripts/generate-recipient-storage-infra.mjs`. The task definition
contains the reviewed probe source. Pin ApplicationCommit to the exact source of
the immutable image and HarnessCommit to the exact probe/template source. These
are separate evidence bindings; never imply that a later harness changed an image.
The ECR repository ARN is deliberately restricted to the existing isolated build
repository. Pass only its reviewed digest. No general image pull is permitted.

Use a new stack named `packproof-m2-recipient-<unique suffix>`. Validate syntax,
security and the CloudFormation change set before creation. Its default writer
fence is CLOSED. Set an explicit synthetic RetainUntil within the next 24 hours;
the two-day COMPLIANCE bucket floor is synthetic test retention only. Preserve
the buckets, objects and logs after the run.

1. Build the pinned application source using the isolated image-only build phase.
   Keep existing services at zero, old database logins disabled and old IAM fences
   CLOSED when resuming temporary build/egress resources. Inspect the image digest
   and scan results. Create this separate stack and inspect its actual policies,
   versioning, Object Lock and task definitions.
2. Seed `scope-canary.txt` in its new Canary bucket with synthetic text. Open only
   this new worker fence and run its worker task on the isolated private network.
   Capture the task ARN and exact version/hash of its ready report. It uses the
   real recipient storage adapter to preserve a synthetic PNG/artifact, lose an
   actual publication response, reconcile the first version, reject a conditional
   contender, and verify exact bytes and actual COMPLIANCE retention.
3. Close the new writer fence through a reviewed CloudFormation change set. After
   completion, write Reports/configuration/fence.json bound to source, harness,
   exact taskArn, writerFence=CLOSED and changeSetArn. The running worker uses its
   cached task credentials to prove that further protected writes are denied.
   It waits at most ten minutes for the marker and one minute for IAM propagation.
4. Inspect the final PASSED worker report. Run separate API and restore tasks with
   M2_WORKER_REPORT_KEY, M2_WORKER_REPORT_VERSION and M2_WORKER_REPORT_SHA256 pinned
   to that final report. Each must read exact protected versions and demonstrate
   denial of protected writes, deletion, retention shortening and canary access.
   The restore task proves storage-reader authority only; databaseRestoreVerified
   remains false in every report.
5. Record actual task/image/configuration bindings and results, including failed
   attempts. Stop any remaining tasks, leave this fence CLOSED, and pause the
   temporary isolated build/egress resources. Do not delete protected objects.

The API and restore roles cannot read latest recipient versions or list that
bucket; they receive GetObjectVersion and retention reads. The worker needs
GetObject/ListBucket for ambiguous-write reconciliation. Only the worker can
conditionally create recipient objects. Every role can write only its report
prefix and is denied retention mutation, deletion, signing and secret reads.
Reports are private/versioned and are not application preservation receipts.

Do not populate the production recipient deployment admission file from this
storage test alone. A measured full database restore, application role/grant
acceptance, reviewed migration/rollback path and cohort-specific retention remain
separate requirements.
